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
import { parseMultisectTerms } from './commands/multisect.js';
import { displayName } from './utils.js';

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

// Redirect all console output to stderr so stdout stays clean for MCP protocol
const _origLog = console.log;
const _origWarn = console.warn;
const _origError = console.error;
console.log = (...args) => process.stderr.write(args.join(' ') + '\n');
console.warn = (...args) => process.stderr.write(args.join(' ') + '\n');
console.error = (...args) => process.stderr.write(args.join(' ') + '\n');

// Load index
console.log(`Loading index: ${serverArgs.indexPath}`);
let index = new CodeSearchIndex({ indexPath: serverArgs.indexPath });
if (index.files.size === 0) {
  console.error(`No files in index at ${serverArgs.indexPath}`);
  process.exit(1);
}
console.log(`Loaded: ${index.files.size} files`);


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
    description: 'Extract the full source code of a function by name. Use file@funcname for disambiguation.',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Function name, optionally qualified: "funcname" or "file@funcname" or "Class::method"' },
      },
      required: ['function_name'],
    },
  },
  {
    name: 'show_file',
    description: 'Show the full source of an indexed file, or a range of lines.',
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
        max: { type: 'number', description: 'Max results (default 50)' },
      },
      required: ['function_name'],
    },
  },
  {
    name: 'callees',
    description: 'Find all functions called by a given function — what does it call.',
    inputSchema: {
      type: 'object',
      properties: {
        function_name: { type: 'string', description: 'Function name, optionally with file hint: "file@funcname"' },
      },
      required: ['function_name'],
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
];


// ========================================================================
// Tool implementations
// ========================================================================

function handleTool(name, args) {
  switch (name) {

    case 'search': {
      const query = args.query;
      const max = args.max || 25;
      const results = index.searchLiteral(query, { maxResults: max, contextLines: 0 });
      if (results.length === 0) return `No results for "${query}"`;
      return results.map(r =>
        `${r.filePath}:${r.lineNumber}  ${r.lineText}` +
        (r.functionName ? `  (in ${r.functionName})` : '')
      ).join('\n');
    }

    case 'regex_search': {
      const max = args.max || 25;
      const results = index.searchLiteral(args.pattern, { useRegex: true, maxResults: max, contextLines: 0 });
      if (results.length === 0) return `No results for /${args.pattern}/`;
      return results.map(r =>
        `${r.filePath}:${r.lineNumber}  ${r.lineText}` +
        (r.functionName ? `  (in ${r.functionName})` : '')
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
        lines.push(`  ${f.name}  ${f.filepath}  (${f.terms_matched}/${positiveCount} terms, ${f.lines}L)`);
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
      const spec = args.function_name;
      let fileHint = null, funcName = spec;
      if (spec.includes('@')) {
        const atPos = spec.indexOf('@');
        fileHint = spec.slice(0, atPos);
        funcName = spec.slice(atPos + 1);
      }
      const matches = index.findFunctionMatches(funcName, fileHint);
      if (matches.length === 0) return `Function not found: ${spec}`;
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
      // Find matching file (partial match)
      let matchedPath = null;
      for (const p of index.files.keys()) {
        if (p === fp || p.endsWith(fp) || p.includes(fp)) {
          matchedPath = p;
          break;
        }
      }
      if (!matchedPath) return `File not found: ${fp}`;
      const lines = index.fileLines.get(matchedPath);
      if (!lines) return `No content for: ${matchedPath}`;
      const start = (args.start_line || 1) - 1;
      const end = args.end_line || lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`).join('\n');
      return `${matchedPath} (${lines.length} lines total, showing ${start + 1}-${end}):\n${numbered}`;
    }

    case 'callers': {
      const max = args.max || 50;
      const callers = index.findCallers(args.function_name, max);
      if (callers.length === 0) return `No callers found for: ${args.function_name}`;
      const lines = [`${callers.length} callers of ${args.function_name}:`];
      for (const c of callers) {
        lines.push(`  ${c.filepath}:${c.line_number}  ${c.line_text.trim()}` +
          (c.caller_function ? `  (in ${c.caller_function})` : ''));
      }
      return lines.join('\n');
    }

    case 'callees': {
      const spec = args.function_name;
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
        lines.push(`  ${c.display_name || c.name}  (${c.call_type})${defInfo}`);
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
      const vocab = index.getTopVocabulary(n, args.filter || null, null);
      if (!vocab || vocab.length === 0) return 'No vocabulary available (run --discover-vocabulary first or rebuild index)';
      const lines = [`Top ${vocab.length} domain vocabulary tokens:`];
      for (const v of vocab) {
        const files = v.top_files ? v.top_files.slice(0, 2).map(f => f.path).join(', ') : '';
        lines.push(`  ${v.score.toFixed(0)}\t${v.token}\t(${v.doc_freq} files, ${v.total_count} hits)${files ? '  e.g. ' + files : ''}`);
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
      const lines = [`${filtered.length} functions${args.filter ? ` matching "${args.filter}"` : ''} (showing ${Math.min(max, filtered.length)}):`];
      for (const fn of filtered.slice(0, max)) {
        lines.push(`  ${fn.name}\t${fn.filepath}\t${fn.lines}L`);
      }
      return lines.join('\n');
    }

    case 'list_files': {
      const max = args.max || 100;
      let files = [...index.files.keys()];
      if (args.filter) {
        const f = args.filter.toLowerCase();
        files = files.filter(p => p.toLowerCase().includes(f));
      }
      if (files.length === 0) return 'No files found';
      return `${files.length} files${args.filter ? ` matching "${args.filter}"` : ''} (showing ${Math.min(max, files.length)}):\n` +
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

    case 'struct_dupes': {
      const n = args.n || 20;
      const minLines = args.min_lines || 5;
      const dupes = index.getStructuralDupes(n, minLines);
      if (!dupes || dupes.length === 0) return 'No structural duplicates found';
      const lines = [`${dupes.length} structural duplicate groups:`];
      for (const group of dupes.slice(0, n)) {
        lines.push(`\n  Hash: ${group.hash} (${group.functions.length} functions, ${group.lines}L):`);
        for (const f of group.functions) {
          lines.push(`    ${f.name}  ${f.filepath}`);
        }
      }
      return lines.join('\n');
    }

    case 'list_indexes': {
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
        return `No CodeExam indexes found in: ${searchPath}\n(Looking for directories containing literal_index.json)`;
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
      return lines.join('\n');
    }

    case 'load_index': {
      const idxPath = args.index_path;
      if (!idxPath) return 'Error: index_path is required';
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

// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
console.log('MCP server running on stdio');
