#!/usr/bin/env node
/**
 * mcp-server.js — MCP (Model Context Protocol) server for Code Exam.
 *
 * Exposes CodeExam index queries as MCP tools over stdio, enabling
 * Claude Code, Claude Desktop, or any MCP client to directly query
 * an indexed codebase.
 *
 * Usage:
 *   node src/mcp-server.js --index-path .my_index
 *
 * Register in Claude Code:
 *   claude mcp add --transport stdio code-exam -- node src/mcp-server.js --index-path .my_index
 */

import fs from 'fs';
import path from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';
import { buildOverview, formatOverview } from './core/overview.js';
import { extractConcepts, conceptLabel } from './core/vocabulary.js';
import { extractDataStructures } from './core/data-structs.js';
import { extractClientServer } from './core/client-server.js';
import { parseMultisectTerms } from './commands/multisect.js';
import { displayName } from './utils.js';
import { doCallTree } from './commands/graph.js';
import { formatFunctionDigest, formatClassDigest, formatFileDigest } from './commands/digest.js';
import { pathToFileURL } from 'url';

// ========================================================================
// Parse args
// ========================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { indexPath: '.code_search_index' };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--index-path' || args[i] === '--index') && args[i + 1]) {
      result.indexPath = args[++i];
    }
  }
  return result;
}

const serverArgs = parseArgs();

// The index, console-redirect, and stdio connect are initialized in main()
// (run only when this file is the entry point), so the module can be imported
// by tests — which call setIndex() + handleTool() — without loading a default
// index, exiting on a missing one, or starting the stdio server.
let index = null;

/** Test seam: inject a loaded CodeSearchIndex, bypassing argv/stdio. */
export function setIndex(idx) { index = idx; }


// ========================================================================
// Tool definitions
// ========================================================================

const TOOLS = [
  {
    name: 'search',
    description: 'Search the indexed codebase for a literal string. Returns matching lines with file paths, line numbers, and function context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search string' },
        max: { type: 'number', description: 'Max results (default 25)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'regex_search',
    description: 'Search the indexed codebase with a regular expression. Returns matching lines with context.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern' },
        max: { type: 'number', description: 'Max results (default 25)' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'multisect_search',
    description: 'Find functions containing ALL specified terms (intersection search). Best for finding code that implements a specific concept described by multiple keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        terms: { type: 'string', description: 'Semicolon-separated search terms, e.g. "encrypt;certificate;validate". Prefix with NOT to exclude, e.g. "encrypt;NOT test". Use /regex/ for patterns.' },
        min_terms: { type: 'number', description: 'Minimum percentage of terms that must match (0-100, default 80)' },
        max: { type: 'number', description: 'Max results (default 25)' },
      },
      required: ['terms'],
    },
  },
  {
    name: 'extract',
    description: 'Extract the COMPLETE SOURCE CODE of a function from the index. The source IS available to you here — read it with this tool instead of guessing. Use file@funcname for disambiguation.',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Function name, optionally qualified: "funcname" or "file@funcname" or "Class::method"' },
        target: { type: 'string', description: 'Alias for "function_name" (accepted for consistency with digest).' },
      },
    },
  },
  {
    name: 'show_file',
    description: 'Return the COMPLETE SOURCE TEXT of an indexed file (or a line range). The file IS available to you in the index — call this to read a file instead of guessing or inferring its contents.',
    inputSchema: {
      type: 'object',
      properties: {
        filepath: { type: 'string', description: 'File path (partial match OK)' },
        start_line: { type: 'number', description: 'Start line (optional)' },
        end_line: { type: 'number', description: 'End line (optional)' },
      },
      required: ['filepath'],
    },
  },
  {
    name: 'callers',
    description: 'Find all call sites of a function — who calls it and from where.',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Function name to find callers of' },
        target: { type: 'string', description: 'Alias for "function_name".' },
        max: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'callees',
    description: 'Find all functions called by a given function — what does it call.',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Function name, optionally with file hint: "file@funcname"' },
        target: { type: 'string', description: 'Alias for "function_name".' },
      },
    },
  },
  {
    name: 'most_called',
    description: 'List the most frequently called functions in the codebase. Use defined_only=true to show only functions with source definitions (not external/library calls).',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many to show (default 25)' },
        defined_only: { type: 'boolean', description: 'Only show functions with definitions in the index' },
        filter: { type: 'string', description: 'Filter by name substring' },
      },
    },
  },
  {
    name: 'hotspots',
    description: 'Find the most important functions: large and frequently called. Hotspot score = calls x sqrt(lines).',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many to show (default 25)' },
        filter: { type: 'string', description: 'Filter by name or path substring' },
      },
    },
  },
  {
    name: 'entry_points',
    description: 'Find functions that are defined but rarely/never called — likely entry points, event handlers, or dead code.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many to show (default 25)' },
        max_calls: { type: 'number', description: 'Maximum call count to qualify (default 1)' },
      },
    },
  },
  {
    name: 'vocabulary',
    description: 'Show the domain-specific vocabulary of the codebase — unique identifiers, sorted by importance. Useful for understanding what concepts exist in the code.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many tokens (default 50)' },
        with_sites: { type: 'boolean', description: 'Include 1-2 example file paths per term (default false — omit for a compact terms-only list; use search to locate a term)' },
        filter: { type: 'string', description: 'Filter vocabulary to files matching this path substring' },
      },
    },
  },
  {
    name: 'list_functions',
    description: 'List all functions in the index, optionally filtered by name or path. Shows function name, file, and line count.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by function name or file path substring' },
        max: { type: 'number', description: 'Max results (default 100)' },
      },
    },
  },
  {
    name: 'list_files',
    description: 'List all files in the index, optionally filtered by path substring.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by path substring' },
        max: { type: 'number', description: 'Max results (default 100)' },
      },
    },
  },
  {
    name: 'overview',
    description: 'START HERE for an unfamiliar index. One-shot orientation: size, languages, top-level structure (flags multi-project collections like a books/repos dump), top domain vocabulary, key files by vocabulary density, entry points, and "watch" notes (e.g. nothing indexed, looks like a collection). Built from cached signals — fast. Run this FIRST, then follow its "Next:" line: vocabulary for more terms, digest <file@function> to drill into a key file or entry point.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'stats',
    description: 'Show index statistics: file count, function count, line count, etc.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_classes',
    description: 'List all classes/structs in the index with method counts.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by class name substring' },
      },
    },
  },
  {
    name: 'data_structures',
    description: 'List data structures (struct/enum/union/typedef/trait/interface/record) ranked by reference count, so the central types surface first. Complements list_classes for systems code (C/C++/Rust/Go).',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many to show (default 50)' },
        filter: { type: 'string', description: 'Filter by type-name substring' },
      },
    },
  },
  {
    name: 'client_server',
    description: 'Map the HTTP surface: server routes declared (Express/Flask/FastAPI/Rails/Go), client calls made (fetch/axios/XHR/requests/URL literals), and the reconciliation — internal client calls with NO matching server route (the "missing server code" signal). Heuristic, path-based matching.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many of each list to show (default 50)' },
        filter: { type: 'string', description: 'Filter by path/url substring' },
      },
    },
  },
  {
    name: 'struct_dupes',
    description: 'Find structurally similar functions (same control flow, different names). Useful for finding copy-pasted or templated code.',
    inputSchema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many groups to show (default 20)' },
        min_lines: { type: 'number', description: 'Minimum function size in lines (default 5)' },
      },
    },
  },
  {
    name: 'list_indexes',
    description: 'List all available CodeExam index directories found in a given path. Shows index name, size, modification date, and components (functions, inverted index, hashes).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to scan for indexes (default: current working directory)' },
      },
    },
  },
  {
    name: 'load_index',
    description: 'Load a different CodeExam index at runtime, replacing the currently loaded index. All subsequent queries will use the new index.',
    inputSchema: {
      type: 'object',
      properties: {
        index_path: { type: 'string', description: 'Path to the index directory to load' },
      },
      required: ['index_path'],
    },
  },
  {
    name: 'digest',
    description: 'Concise digest of a function, class, or file: identity, callers, callees, distinctive strings, and structure (inheritance for classes; imports/exports for files). The "tell me about X" summary — prefer this over chaining callers+callees+extract. The code IS available from the index — base the summary on this tool\'s output, never on guesses.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Function, class, or file name; optionally file-qualified as "file@name"' },
        function_name: { type: 'string', description: 'Alias for "target" (accepted for consistency with extract/callers/callees).' },
        max_results: { type: 'number', description: 'Max callers/callees/strings to include (default 10)' },
        verbose: { type: 'boolean', description: 'Include more detail' },
      },
    },
  },
  {
    name: 'call_tree',
    description: 'Transitive call tree for a function (multi-hop): what it calls downward, plus the caller chains that reach it. Use for tracing how code flows, not just the one-hop callers/callees tools.',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Function name, optionally file-qualified as "file@name"' },
        depth: { type: 'number', description: 'Max downward depth (default 3)' },
      },
      required: ['function_name'],
    },
  },
  {
    name: 'command_catalog',
    description: 'The target codebase\'s own user-facing commands: CLI options/flags, slash-commands, API routes, and GUI actions, each linked to its handler. Answers "what can this program do / what commands does it expose". Heuristic — verify in source.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter entries by name/flag substring' },
        max: { type: 'number', description: 'Max entries per section (default 40)' },
      },
    },
  },
  {
    name: 'models_used',
    description: 'AI/ML models the codebase actually loads or calls, deduped and tagged api=hosted / local=loaded. Distinct from models DEFINED (class inheritance). Answers "what models does this use". Heuristic, recall-favoring.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by model id substring or /regex/' },
        max: { type: 'number', description: 'Max models to list (default 50)' },
      },
    },
  },
];


// ========================================================================
// Tool implementations
// ========================================================================

// Capture a command function's stdout (some command modules print rather than
// return). Swapping console.log / process.stdout.write also protects the MCP
// stdio JSON-RPC channel from stray writes by the captured function.
function captureStdout(fn) {
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);
  const chunks = [];
  console.log = (...a) => { chunks.push(a.map(String).join(' ') + '\n'); };
  process.stdout.write = (s) => { chunks.push(typeof s === 'string' ? s : String(s)); return true; };
  try { fn(); } finally { console.log = origLog; process.stdout.write = origWrite; }
  return chunks.join('');
}

// Truncate a long single line so a big match (minified bundle / embedded
// prompt text) doesn't blow the caller's context window (#160 A6).
function clipLine(s, n = 200) {
  s = String(s);
  return s.length > n ? s.slice(0, n) + ` ...[+${s.length - n} chars]` : s;
}

function handleTool(name, args) {
  switch (name) {

    case 'overview':
      return formatOverview(buildOverview(index));

    case 'search': {
      const query = args.query;
      const max = args.max || 25;
      const results = index.searchLiteral(query, { maxResults: max, contextLines: 0 });
      if (results.length === 0) return `No results for "${query}"`;
      return results.map(r =>
        `${r.filePath}:${r.lineNumber}  ${clipLine(r.lineText)}` +
        (r.functionName ? `  (in ${clipLine(r.functionName, 80)})` : '')
      ).join('\n');
    }

    case 'regex_search': {
      const max = args.max || 25;
      const results = index.searchLiteral(args.pattern, { useRegex: true, maxResults: max, contextLines: 0 });
      if (results.length === 0) return `No results for /${args.pattern}/`;
      return results.map(r =>
        `${r.filePath}:${r.lineNumber}  ${clipLine(r.lineText)}` +
        (r.functionName ? `  (in ${clipLine(r.functionName, 80)})` : '')
      ).join('\n');
    }

    case 'multisect_search': {
      const terms = parseMultisectTerms(args.terms);
      if (!terms || terms.length === 0) return `No valid terms parsed from: ${args.terms}`;
      const positiveCount = terms.filter(t => !t.negated).length;
      const minPct = (args.min_terms || 80) / 100;
      const max = args.max || 25;
      const minTerms = Math.max(1, Math.ceil(positiveCount * minPct));
      const results = index.multisectSearch(terms, { minTerms });
      if (!results || !results.function_matches || results.function_matches.length === 0) {
        return `No functions match terms: ${args.terms}`;
      }
      const lines = [`Found ${results.function_matches.length} function matches:`];
      for (const f of results.function_matches.slice(0, max)) {
        lines.push(`  ${clipLine(f.function, 80)}  ${f.filepath}  (${f.terms_matched}/${positiveCount} terms, ${f.lines}L)`);
      }
      if (results.file_matches && results.file_matches.length > 0) {
        lines.push(`\nTop file matches:`);
        for (const f of results.file_matches.slice(0, 10)) {
          lines.push(`  ${f.filepath}  (${f.terms_matched}/${positiveCount} terms)`);
        }
      }
      return lines.join('\n');
    }

    case 'extract': {
      const spec = args.function_name ?? args.target;
      if (!spec) return 'extract requires "function_name" (alias: "target").';
      let fileHint = null, funcName = spec;
      if (spec.includes('@')) {
        const atPos = spec.indexOf('@');
        fileHint = spec.slice(0, atPos);
        funcName = spec.slice(atPos + 1);
      }
      const matches = index.findFunctionMatches(funcName, fileHint);
      if (matches.length === 0) {
        // Fuzzy fallback: a wrong file hint shouldn't be a dead end (#184 item 5).
        if (fileHint) {
          const elsewhere = index.findFunctionMatches(funcName, null);
          if (elsewhere.length > 0) {
            return `Not found in "${fileHint}". "${funcName}" is defined in:\n` +
              elsewhere.slice(0, 10).map(m => `  ${m.filepath}@${m.name}`).join('\n') +
              `\nRetry extract with one of these file@name forms.`;
          }
        }
        // Interim for symbols not indexed as functions, e.g. `var X = factory(...)`
        // (#184 item 4): point at the DEFINITION so show_file lands on it. Prefer
        // assignment/declaration sites (var/let/const X, or `X =`) over incidental
        // mentions; fall back to a bare literal search if none are found.
        const esc = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let hits = index.searchLiteral(
          `(?:var|let|const)\\s+${esc}\\b|${esc}\\s*=(?!=)`,
          { useRegex: true, maxResults: 3, contextLines: 0 });
        if (hits.length === 0) {
          hits = index.searchLiteral(funcName, { maxResults: 3, contextLines: 0 });
        }
        if (hits.length > 0) {
          return `Function not found: ${spec}\n` +
            `("${funcName}" is not indexed as a function — it may be a var/const ` +
            `assignment like \`${funcName} = factory(...)\`. It appears at:\n` +
            hits.map(h => `  ${h.filePath}:${h.lineNumber}`).join('\n') +
            `\nUse show_file there to read it.)`;
        }
        return `Function not found: ${spec}`;
      }
      if (matches.length > 5) {
        return `Ambiguous: ${matches.length} matches for "${funcName}". Use file@funcname to disambiguate:\n` +
          matches.slice(0, 10).map(m => `  ${m.filepath}@${m.name} (${m.start}-${m.end})`).join('\n');
      }
      const results = [];
      for (const m of matches.slice(0, 3)) {
        const lines = index.fileLines.get(m.filepath);
        if (!lines) continue;
        const source = lines.slice(m.start - 1, m.end).join('\n');
        results.push(`=== ${m.name} === ${m.filepath}:${m.start}-${m.end} (${m.end - m.start + 1} lines)\n${source}`);
      }
      return results.join('\n\n');
    }

    case 'show_file': {
      const fp = args.filepath;
      // Match by exact path first, then suffix, then substring. (#160 A5)
      const keys = [...index.files.keys()];
      let matches = keys.filter(p => p === fp);
      if (!matches.length) matches = keys.filter(p => p.endsWith(fp));
      if (!matches.length) matches = keys.filter(p => p.includes(fp));
      if (!matches.length) return `File not found: ${fp}`;
      // #160 A5: don't silently pick the first of several — list candidates so
      // the caller can disambiguate (e.g. several "rollout.py" across repos).
      if (matches.length > 1) {
        return `Ambiguous: ${matches.length} files match "${fp}". Pass a more specific path:\n` +
          matches.slice(0, 20).map(p => `  ${p}`).join('\n') +
          (matches.length > 20 ? `\n  ... and ${matches.length - 20} more` : '');
      }
      const matchedPath = matches[0];
      const lines = index.fileLines.get(matchedPath);
      if (!lines) return `No content for: ${matchedPath}`;
      const start = (args.start_line || 1) - 1;
      // #160 A4: cap an unbounded request so a big file doesn't blow the
      // caller's context — first 200 lines unless an explicit end_line is given.
      const DEFAULT_CAP = 200;
      const end = args.end_line || Math.min(lines.length, start + DEFAULT_CAP);
      const slice = lines.slice(start, end);
      const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
      const more = (!args.end_line && end < lines.length)
        ? `\n... ${lines.length - end} more lines — pass end_line (or a start_line/end_line range) to see them.`
        : '';
      return `${matchedPath} (${lines.length} lines total, showing ${start + 1}-${end}):\n${numbered}${more}`;
    }

    case 'callers': {
      const fn = args.function_name ?? args.target;
      if (!fn) return 'callers requires "function_name" (alias: "target").';
      const max = args.max || 50;
      const callers = index.findCallers(fn, max);
      if (callers.length === 0) return `No callers found for: ${fn}`;
      const lines = [`${callers.length} callers of ${fn}:`];
      for (const c of callers) {
        lines.push(`  ${c.filepath}:${c.line_number}  ${clipLine(c.line_text.trim())}` +
          (c.caller_function ? `  (in ${clipLine(c.caller_function, 80)})` : ''));
      }
      return lines.join('\n');
    }

    case 'callees': {
      const spec = args.function_name ?? args.target;
      if (!spec) return 'callees requires "function_name" (alias: "target").';
      let fileHint = null, funcName = spec;
      if (spec.includes('@')) {
        const atPos = spec.indexOf('@');
        fileHint = spec.slice(0, atPos);
        funcName = spec.slice(atPos + 1);
      }
      const callees = index.findCallees(funcName, fileHint);
      if (callees.length === 0) return `No callees found for: ${spec}`;
      const lines = [`${callees.length} callees of ${funcName}:`];
      for (const c of callees) {
        const defInfo = c.resolved_def
          ? `  [${c.resolved_def.filepath}]`
          : (c.definitions?.length ? `  [${c.definitions.length} defs]` : '  [external]');
        lines.push(`  ${clipLine(c.display_name || c.name, 80)}  (${c.call_type})${defInfo}`);
      }
      return lines.join('\n');
    }

    case 'most_called': {
      const n = args.n || 25;
      const callData = index.getCallCountsWithDefinitions(false);
      let filtered = callData.filter(item => {
        if (item.name.length < 2) return false;
        const bare = item.name.includes('::') ? item.name.split('::').pop() : item.name;
        if (bare.length >= 2 && /^[A-Z][A-Z0-9_]+$/.test(bare)) return false;
        if (args.defined_only && item.definitions.length === 0) return false;
        if (args.filter && !item.name.toLowerCase().includes(args.filter.toLowerCase())) return false;
        return true;
      });
      if (filtered.length === 0) return 'No results';
      const lines = [`Top ${Math.min(n, filtered.length)} most called functions:`];
      for (const item of filtered.slice(0, n)) {
        const defNote = item.definitions.length > 0
          ? `  ${item.definitions.length} def` + (item.definitions.length > 1 ? 's' : '')
          : '  external';
        lines.push(`  ${item.count}\t${item.name}${defNote}`);
      }
      return lines.join('\n');
    }

    case 'hotspots': {
      const n = args.n || 25;
      const hotspots = index.getHotspots(n, false);
      let results = hotspots;
      if (args.filter) {
        const f = args.filter.toLowerCase();
        results = hotspots.filter(h => h.name.toLowerCase().includes(f) || h.filepath.toLowerCase().includes(f));
      }
      if (results.length === 0) return 'No hotspots found';
      const lines = [`Top ${Math.min(n, results.length)} hotspots (score = calls x sqrt(lines)):`];
      for (const h of results.slice(0, n)) {
        lines.push(`  ${h.score.toFixed(1)}\t${h.name}  ${h.filepath}  (${h.lines}L, ${h.calls} calls)`);
      }
      return lines.join('\n');
    }

    case 'entry_points': {
      const n = args.n || 25;
      const maxCalls = args.max_calls ?? 1;
      const entries = index.getEntryPoints(n, maxCalls, false);
      if (entries.length === 0) return 'No entry points found';
      const lines = [`${entries.length} functions with <= ${maxCalls} calls (likely entry points):`];
      for (const e of entries.slice(0, n)) {
        lines.push(`  ${e.name}  ${e.filepath}  (${e.lines}L, ${e.calls} calls)`);
      }
      return lines.join('\n');
    }

    case 'vocabulary': {
      const n = args.n || 50;
      // #160 A7: default to terms only — the example paths bloat a small
      // model's context (and stalled prefill). Opt in with with_sites; use
      // `search <term>` to locate a term's sites.
      const withSites = !!args.with_sites;
      const vocab = index.getTopVocabulary(n, args.filter || null, null);
      if (!vocab || vocab.length === 0) return 'No vocabulary available (run --discover-vocabulary first or rebuild index)';
      const lines = [`Top ${vocab.length} domain vocabulary tokens` +
        (withSites ? ':' : ' (terms only; pass with_sites:true for example paths):')];
      const concepts = extractConcepts(index);
      if (concepts.length) lines.push(`Key concepts (with examples): ${concepts.map(conceptLabel).join(', ')}`, '');
      for (const v of vocab) {
        let line = `  ${v.score.toFixed(0)}\t${v.token}\t(${v.doc_freq} files, ${v.total_count} hits)`;
        if (withSites && v.top_files && v.top_files.length) {
          // Include per-file count so a caller sees *where* (and how much) a
          // term concentrates, not just which files contain it.
          line += '  e.g. ' + v.top_files.slice(0, 2).map(f => `${f.path} (${f.count}×)`).join(', ');
        }
        lines.push(line);
      }
      return lines.join('\n');
    }

    case 'list_functions': {
      const max = args.max || 100;
      const allFuncs = index.listFunctions();
      let filtered = allFuncs;
      if (args.filter) {
        const f = args.filter.toLowerCase();
        filtered = allFuncs.filter(fn =>
          fn.name.toLowerCase().includes(f) || fn.filepath.toLowerCase().includes(f)
        );
      }
      if (filtered.length === 0) return 'No functions found';
      // #160 A8: same non-selective-filter warning as list_files.
      const unselective = (args.filter && allFuncs.length && filtered.length >= allFuncs.length * 0.9)
        ? ` (note: filter "${args.filter}" matched ${filtered.length}/${allFuncs.length} — not selective; omit it for the whole picture)`
        : '';
      const lines = [`${filtered.length} functions${args.filter ? ` matching "${args.filter}"` : ''} (showing ${Math.min(max, filtered.length)}):${unselective}`];
      for (const fn of filtered.slice(0, max)) {
        lines.push(`  ${fn.name}\t${fn.filepath}\t${fn.lines}L`);
      }
      return lines.join('\n');
    }

    case 'list_files': {
      const max = args.max || 100;
      const all = [...index.files.keys()];
      let files = all;
      if (args.filter) {
        const f = args.filter.toLowerCase();
        files = files.filter(p => p.toLowerCase().includes(f));
      }
      if (files.length === 0) return 'No files found';
      // #160 A8: warn on a non-selective filter — "main" matches every
      // `repo-main.zip!...` path, so a caller mistakes it for structure.
      const unselective = (args.filter && all.length && files.length >= all.length * 0.9)
        ? `\n(note: filter "${args.filter}" matched ${files.length}/${all.length} files — not selective; omit the filter to see the whole structure.)`
        : '';
      return `${files.length} files${args.filter ? ` matching "${args.filter}"` : ''} (showing ${Math.min(max, files.length)}):${unselective}\n` +
        files.slice(0, max).join('\n');
    }

    case 'stats': {
      index._ensureFunctionIndex();
      const funcCount = index.functionIndex
        ? Object.values(index.functionIndex).reduce((s, f) => s + Object.keys(f).length, 0) : 0;
      const fileCount = index.files.size;
      const totalLines = [...index.fileLines.values()].reduce((s, l) => s + l.length, 0);
      return [
        `Index: ${serverArgs.indexPath}`,
        `Files: ${fileCount}`,
        `Functions: ${funcCount}`,
        `Total lines: ${totalLines}`,
        `Source: ${index.indexSource || 'unknown'}`,
        `Parse method: ${index.parseMethod || 'regex'}`,
      ].join('\n');
    }

    case 'list_classes': {
      const classes = index.listClasses();
      let filtered = classes;
      if (args.filter) {
        const f = args.filter.toLowerCase();
        filtered = classes.filter(c => c.name.toLowerCase().includes(f));
      }
      if (filtered.length === 0) return 'No classes found';
      const lines = [`${filtered.length} classes${args.filter ? ` matching "${args.filter}"` : ''}:`];
      for (const c of filtered.slice(0, 50)) {
        lines.push(`  ${c.name}  (${c.methods.length} methods, ${c.filepath})`);
      }
      return lines.join('\n');
    }

    case 'data_structures': {
      let structs = extractDataStructures(index);
      if (args.filter) {
        const f = args.filter.toLowerCase();
        structs = structs.filter(s => s.name.toLowerCase().includes(f));
      }
      if (!structs.length) return 'No data structures found';
      const n = args.n || 50;
      const lines = [`${structs.length} data structures (ranked by reference count):`];
      for (const s of structs.slice(0, n)) {
        lines.push(`  ${s.refs} refs  ${s.kind}  ${s.name}  (${s.filepath}:${s.line})`);
      }
      return lines.join('\n');
    }

    case 'client_server': {
      let { server, client, unmatched, sockets, rpc, ipc, stats } = extractClientServer(index);
      if (args.filter) {
        const f = args.filter.toLowerCase();
        const apiMatch = (e) => e.api.toLowerCase().includes(f) || e.filepath.toLowerCase().includes(f);
        server = server.filter(s => s.path.toLowerCase().includes(f));
        client = client.filter(c => c.url.toLowerCase().includes(f));
        unmatched = unmatched.filter(u => (u.pathOnly || '').toLowerCase().includes(f));
        sockets = sockets.filter(apiMatch); rpc = rpc.filter(apiMatch); ipc = ipc.filter(apiMatch);
      }
      if (!server.length && !client.length && !sockets.length && !rpc.length && !ipc.length) return 'No client/server surface found';
      const n = args.n || 50;
      const out = [`Server routes (${stats.serverCount}):`];
      for (const s of server.slice(0, n)) out.push(`  ${s.method} ${s.path}  [${s.framework}]  (${s.filepath}:${s.line})`);
      out.push(`\nClient calls (${stats.clientCount}):`);
      for (const c of client.slice(0, n)) {
        const tag = c.external ? ' [external]' : (c.matched === false ? ' [no server]' : '');
        const named = c.name ? ` (via ${c.name})` : '';
        out.push(`  ${c.method} ${c.url}${named}  (${c.kind})${tag}  (${c.filepath}:${c.line})`);
      }
      out.push(`\nClient calls with NO matching server route (${stats.unmatchedCount}):`);
      if (!unmatched.length) out.push('  (none)');
      for (const u of unmatched.slice(0, n)) out.push(`  ${u.method} ${u.pathOnly}  (first seen ${u.filepath}:${u.line})`);
      const transportOut = (label, entries) => {
        if (!entries.length) return;
        const cl = entries.filter(e => e.role === 'client'), sv = entries.filter(e => e.role === 'server');
        out.push(`\n${label} (${entries.length}): client ${cl.length}, server ${sv.length}`);
        for (const [role, list] of [['client', cl], ['server', sv]]) {
          if (!list.length) continue;
          out.push(`  ${role}:`);
          for (const e of list.slice(0, n)) out.push(`    ${e.api}  ${e.detail ? e.detail + ' ' : (e.tls ? '[TLS] ' : '')}${e.lang}  (${e.filepath}:${e.line})`);
        }
        if (cl.length && !sv.length) out.push(`  (${label}: client side only — no ${label} server side in this index)`);
        else if (sv.length && !cl.length) out.push(`  (${label}: server side only — no ${label} client side in this index)`);
      };
      transportOut('Socket / TLS', sockets);
      transportOut('RPC', rpc);
      transportOut('IPC', ipc);
      return out.join('\n');
    }

    case 'struct_dupes': {
      const n = args.n || 20;
      const minLines = args.min_lines || 5;
      // Mirror /api/struct-dupes: getStructDupes() only returns this._structDupes,
      // which getFuncDupes() populates as a side effect — so it must run first
      // (quiet: stdout is the MCP protocol channel). minLines honors the tool's
      // declared min_lines param (the server route hardcodes 3).
      index.getFuncDupes(n, minLines, false);
      const dupes = index.getStructDupes(n);
      if (!dupes || dupes.length === 0) return 'No structural duplicates found';
      const lines = [`${dupes.length} structural duplicate groups:`];
      for (const group of dupes.slice(0, n)) {
        lines.push(`\n  ${group.bare_name} (${group.count} functions, ${group.lines}L, ${group.unique_bodies || 0} distinct bodies):`);
        for (const inst of group.instances) {
          lines.push(`    ${index.getDisplayName(inst.name)}  ${inst.filepath}`);
        }
      }
      return lines.join('\n');
    }

    case 'list_indexes': {
      // #160 A2: report the *currently loaded* index first. list_indexes
      // scans a directory for index dirs; without this a caller mistakes an
      // empty scan for "no index loaded" even when one is active.
      const active = (index && index.files && index.files.size)
        ? `Currently loaded index: ${index.indexPath || '(unknown path)'} (${index.files.size} files). `
          + `Query it directly with stats / search / digest — you do NOT need load_index unless switching indexes.\n\n`
        : `No index is currently loaded.\n\n`;
      const searchPath = args.path || process.cwd();
      if (!fs.existsSync(searchPath) || !fs.statSync(searchPath).isDirectory()) {
        return `Not a directory: ${searchPath}`;
      }
      let entries;
      try { entries = fs.readdirSync(searchPath).sort(); } catch { return `Cannot read: ${searchPath}`; }

      const indexesFound = [];
      for (const entry of entries) {
        const idxDir = path.join(searchPath, entry);
        try { if (!fs.statSync(idxDir).isDirectory()) continue; } catch { continue; }
        const literalPath = path.join(idxDir, 'literal_index.json');
        if (!fs.existsSync(literalPath)) continue;

        const info = { name: entry };
        try {
          info.literal_mb = (fs.statSync(literalPath).size / (1024 * 1024)).toFixed(1);
          const funcPath = path.join(idxDir, 'function_index.json');
          const invPath  = path.join(idxDir, 'inverted_index.json');
          const hashPath = path.join(idxDir, 'func_hashes.json');
          info.has_functions = fs.existsSync(funcPath);
          info.has_inverted  = fs.existsSync(invPath);
          info.has_hashes    = fs.existsSync(hashPath);
          if (info.has_functions) info.func_mb = (fs.statSync(funcPath).size / (1024 * 1024)).toFixed(1);
          if (info.has_inverted)  info.inv_mb  = (fs.statSync(invPath).size / (1024 * 1024)).toFixed(1);
          info.modified = fs.statSync(literalPath).mtime.toISOString().replace('T', ' ').slice(0, 16);
        } catch (e) {
          info.error = e.message;
        }
        indexesFound.push(info);
      }

      if (indexesFound.length === 0) {
        return active + `No CodeExam indexes found in: ${searchPath}\n(Looking for directories containing literal_index.json)`;
      }

      const lines = [`Indexes in ${searchPath}:\n`];
      lines.push(`  ${'Index Name'.padEnd(30)} ${'Index MB'.padStart(10)} ${'Modified'.padEnd(18)} Components`);
      lines.push(`  ${'-'.repeat(85)}`);
      for (const info of indexesFound) {
        const components = [];
        if (info.has_functions) components.push(`funcs(${info.func_mb}MB)`);
        if (info.has_inverted)  components.push(`inv(${info.inv_mb}MB)`);
        if (info.has_hashes)    components.push('hashes');
        const compStr = components.length > 0 ? components.join(', ') : '-';
        lines.push(`  ${info.name.padEnd(30)} ${(info.literal_mb || '?').toString().padStart(10)} ${(info.modified || '?').padEnd(18)} ${compStr}`);
      }
      lines.push(`\n  ${indexesFound.length} index(es) found`);
      return active + lines.join('\n');
    }

    case 'load_index': {
      const idxPath = args.index_path;
      // #160 A3: guide a weak caller instead of a bare failure.
      if (!idxPath) {
        const loaded = (index && index.files && index.files.size)
          ? ` An index is already loaded (${index.indexPath || 'active'}, ${index.files.size} files) — you can just call stats/search/digest without loading.`
          : '';
        return `index_path is required to load an index.${loaded} To see available index directories, call list_indexes first, then pass one of their paths as index_path.`;
      }
      if (!fs.existsSync(idxPath) || !fs.statSync(idxPath).isDirectory()) {
        return `Not a valid index directory: ${idxPath}`;
      }
      const literalPath = path.join(idxPath, 'literal_index.json');
      if (!fs.existsSync(literalPath)) {
        return `No literal_index.json found in: ${idxPath}`;
      }
      try {
        const newIndex = new CodeSearchIndex({ indexPath: idxPath });
        if (newIndex.files.size === 0) {
          return `Index at ${idxPath} contains no files`;
        }
        index = newIndex;
        serverArgs.indexPath = idxPath;
        console.log(`Switched to index: ${idxPath} (${index.files.size} files)`);
        return `Loaded index: ${idxPath}\nFiles: ${index.files.size}\nSource: ${index.indexSource || 'unknown'}\nParse method: ${index.parseMethod || 'regex'}`;
      } catch (e) {
        return `Failed to load index: ${e.message}`;
      }
    }

    case 'digest': {
      const target = args.target ?? args.function_name;
      if (!target) return `digest requires "target" (alias: "function_name").`;
      const opts = {
        maxCallers: args.max_results || 10,
        maxCallees: args.max_results || 10,
        maxStrings: Math.max(15, args.max_results || 15),
      };
      const digest = index.buildDigest(target, opts);
      if (!digest) return `Target not found: '${target}' (try a file hint: file@name, e.g. src/foo.js@bar)`;
      const fopts = { verbose: !!args.verbose };
      switch (digest.target_type) {
        case 'class': return formatClassDigest(digest, fopts);
        case 'file': return formatFileDigest(digest, fopts);
        default: return formatFunctionDigest(digest, fopts);
      }
    }

    case 'call_tree': {
      const out = captureStdout(() => doCallTree(index, {
        call_tree: args.function_name,
        depth: args.depth != null ? args.depth : 3,
      }));
      return out.trim() || `No call tree for: ${args.function_name}`;
    }

    case 'command_catalog': {
      const catalog = index.extractCommandCatalog(false);
      const filter = args.filter ? args.filter.toLowerCase() : null;
      const max = args.max || 40;
      const ff = (s) => !filter || (s || '').toLowerCase().includes(filter);
      const primary = catalog.commands.filter(c => c.tier === 'primary');
      const secondary = catalog.commands.filter(c => c.tier !== 'primary');
      const cmdFmt = c => `  ${c.name}` +
        (c.description ? '  — ' + c.description.slice(0, 60) : '') +
        (c.handler ? '  -> ' + (c.handler.func || (c.handler.filepath || '').split(/[\\/]/).pop()) + ':' + c.handler.line : '');
      const sections = [
        ['CLI Options', catalog.cliOptions.filter(o => ff(o.flags && o.flags.join(','))),
          o => `  ${o.flags.join(', ')}  [${o.type}]` + (o.help ? '  ' + o.help.slice(0, 60) : '')],
        ['Commands', primary.filter(c => ff(c.name)), cmdFmt],
        ['Other switch/case values', secondary.filter(c => ff(c.name)), cmdFmt],
        ['API Routes', catalog.routes.filter(r => ff(r.path)), r => `  ${r.path}  [${r.filepath}:${r.line}]`],
        ['GUI Actions', catalog.guiActions.filter(a => ff(a.name)), a => `  ${a.name} (${a.type})`],
      ];
      const lines = [];
      for (const [title, items, fmt] of sections) {
        if (!items.length) continue;
        lines.push(`${title} (${items.length}${items.length > max ? `, showing ${max}` : ''}):`);
        for (const it of items.slice(0, max)) lines.push(fmt(it));
        lines.push('');
      }
      return lines.length ? lines.join('\n').trim()
        : `No commands/options/routes/GUI actions detected${filter ? ` matching "${args.filter}"` : ''}.`;
    }

    case 'models_used': {
      const models = index.listModelsUsed(args.filter);
      if (!models.length) {
        return `No models used found${models.unresolved ? ` (${models.unresolved} unresolved <var> refs)` : ''}. `
          + `(Models USED = ids the code loads/calls; distinct from models DEFINED via class inheritance.)`;
      }
      const api = models.filter(m => m.access === 'api').length;
      const local = models.filter(m => m.access === 'local').length;
      const mixed = models.filter(m => m.access === 'mixed').length;
      const max = args.max || 50;
      const shown = models.slice(0, max);
      const lines = [`${models.length} models used — ${api} api, ${local} local`
        + (mixed ? `, ${mixed} mixed` : '')
        + (models.unresolved ? ` (+${models.unresolved} unresolved)` : '')
        + (models.length > max ? `; showing ${max}` : '') + ':'];
      for (const m of shown) {
        const name = (m.model || '').split(/[\\/]/).pop();
        lines.push(`  ${(m.access || '').padEnd(6)} ${name}  (${(m.cells || []).join(',')}, ${m.count} site${m.count > 1 ? 's' : ''})`);
      }
      return lines.join('\n');
    }

    default:
      return `Unknown tool: ${name}`;
  }
}


// ========================================================================
// MCP server setup
// ========================================================================

const server = new Server(
  { name: 'code-exam', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = handleTool(name, args || {});
    return {
      content: [{ type: 'text', text: result }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// Test seam: handleTool/TOOLS are importable so the tool layer can be exercised
// without spawning the stdio server.
export { handleTool, TOOLS };

async function main() {
  // Redirect console output to stderr so stdout stays clean for MCP protocol.
  console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
  console.warn = (...args) => process.stderr.write(args.join(' ') + '\n');
  console.error = (...args) => process.stderr.write(args.join(' ') + '\n');

  console.log(`Loading index: ${serverArgs.indexPath}`);
  index = new CodeSearchIndex({ indexPath: serverArgs.indexPath });
  if (index.files.size === 0) {
    process.stderr.write(`No files in index at ${serverArgs.indexPath}\n`);
    process.exit(1);
  }
  console.log(`Loaded: ${index.files.size} files`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('MCP server running on stdio');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
