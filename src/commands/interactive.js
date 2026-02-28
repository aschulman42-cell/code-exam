/**
 * interactive.js - Interactive REPL mode for code-exam.
 *
 * Keeps the index in memory and dispatches slash-commands to existing
 * do*() handlers, so there is zero code duplication between CLI and REPL.
 *
 * Uses only Node built-in readline (zero deps).
 */

import readline from 'readline';
import fs from 'fs';
import { execSync } from 'child_process';
import { displayName } from '../utils.js';

// Command handlers - same ones used by CLI dispatch
import {
  doSearch, doLiteral, doFast, doRegex,
  doFilesSearch, doFoldersSearch,
} from './search.js';
import {
  doStats, doIndexExtensions,
  doExtract, doListFiles, doShowFile,
  doListFunctions, doListFunctionsAlpha, doListFunctionsSize,
} from './browse.js';
import { doCallers, doCallees, doMostCalled, doCallInventory } from './callers.js';
import { doCallTree, doFileMap, doFileTree } from './graph.js';
import {
  doHotspots, doHotFolders, doEntryPoints, doGaps,
  doDomainFns, doListClasses, doClassHotspots, doVocabulary,
} from './metrics.js';
import {
  doDupefiles, doFuncDupes, doNearDupes,
  doStructDupes, doShowFuncstring, doStructDiff, doStructDiffAll,
} from './dedup.js';
import { doMultisect } from './multisect.js';
import { doClaimSearch } from './claim.js';
import { doAnalyze, doClaimAnalyze, doMultisectAnalyze, doFileAnalyze } from './analyze.js';


// ========================================================================
// makeIArgs - builds a fake args object for do*() dispatch
// ========================================================================

function makeIArgs(maxResults = 10, overrides = {}) {
  return {
    max_results: maxResults,
    verbose: false,
    full_path: false,
    show_dupes: false,
    filter: null,
    include_path: null,
    exclude_path: null,
    exclude_tests: false,
    context: 3,
    dedup: 'none',
    min_terms: '0',
    mermaid: false,
    depth: null,
    min_name_length: 1,
    include_macros: false,
    defined_only: false,
    max_calls: 0,
    show_funcstring: false,
    _explicit: new Set(),
    ...overrides,
  };
}

/**
 * Extract --in <pattern> from a query string.
 * Returns { rest, inPattern } where rest has the --in clause removed.
 */
function extractInFilter(str) {
  const m = str.match(/\s*--in\s+(\S+)/);
  if (m) {
    return {
      rest: str.replace(/\s*--in\s+\S+/, '').trim(),
      inPattern: m[1],
    };
  }
  return { rest: str, inPattern: null };
}

/**
 * Strip surrounding quotes from a string.
 * Interactive mode doesn't strip quotes the way the shell does for argv,
 * so "http;servlet" arrives with literal quote characters.
 */
function stripOuterQuotes(s) {
  if (s.length >= 2 &&
      ((s[0] === '"' && s[s.length - 1] === '"') ||
       (s[0] === "'" && s[s.length - 1] === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}


// ========================================================================
// Command parsers - extract [N] [pattern] [key=val] from argument string
// ========================================================================

/**
 * Parse "rest of command" into { n, pattern, opts }.
 * Handles: /hotspots 30 render   -> { n:30, pattern:'render', opts:{} }
 *          /entry-points max=2   -> { n:25, pattern:null, opts:{max:'2'} }
 *          /call-tree main 4 mermaid -> { func:'main', n:4, flags:['mermaid'] }
 */
function parseNPat(rest, defaultN = 25) {
  const parts = rest.split(/\s+/).filter(Boolean);
  let n = defaultN;
  let pattern = null;
  const opts = {};
  const flags = [];

  for (const p of parts) {
    if (/^\d+$/.test(p)) {
      n = parseInt(p);
    } else if (p.includes('=')) {
      const [k, v] = p.split('=', 2);
      opts[k] = v;
    } else if (p.startsWith('-')) {
      flags.push(p);
    } else {
      // Last non-numeric, non-option token is pattern
      pattern = p;
    }
  }
  return { n, pattern, opts, flags };
}


// ========================================================================
// Output redirection: /command > file.txt  or  /command >> file.txt
// ========================================================================

/**
 * Parse "> file" or ">> file" from the end of a command string.
 * Returns { command, filePath, append } or null if no redirect found.
 *
 * Avoids false positives from regex patterns like /foo>bar/ by only
 * matching > that is preceded by whitespace (or start of unquoted context)
 * and followed by a filename.
 */
function parseRedirect(query) {
  // Match >> or > at end of command, with a filename after it
  // Look for:  [space]>>[space]filename  or  [space]>[space]filename
  // But NOT inside /regex/ patterns
  const m = query.match(/^(.*?)\s+(>>?)\s*(\S+)\s*$/);
  if (!m) return null;

  const command = m[1].trim();
  const append = m[2] === '>>';
  const filePath = m[3];

  // Safety: if the "command" part looks like it ends mid-regex, skip
  // e.g., "/regex /foo" > bar  is legit, but "/regex /foo>" is suspicious
  // Simple heuristic: don't redirect if there's an unclosed /regex/ pattern
  const slashCount = (command.match(/(?:^|\s)\//g) || []).length;
  if (slashCount % 2 !== 0) {
    // Odd number of leading slashes suggests we're inside a regex
    // But /command is always a leading slash, so check more carefully
    // If the redirect target looks like a path, it's probably legit
    if (!filePath.includes('.') && !filePath.includes('/') && !filePath.includes('\\')) {
      return null;  // Probably inside a regex, not a redirect
    }
  }

  return { command, filePath, append };
}

/**
 * Run a function with console.log redirected to a file.
 * Returns the number of lines written.
 */
function withFileRedirect(filePath, append, fn) {
  const flag = append ? 'a' : 'w';
  const fd = fs.openSync(filePath, flag);
  let lineCount = 0;

  // Save and replace console.log
  const origLog = console.log;
  const origWrite = process.stdout.write;

  const installRedirect = () => {
    console.log = (...args) => {
      // Format the same way console.log does: space-separated, newline at end
      const text = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
      // Replace non-ASCII for Windows compatibility
      const safe = text.replace(/[^\x00-\x7E]/g, '?');
      fs.writeSync(fd, safe + '\n');
      lineCount++;
    };

    // Also capture raw process.stdout.write (used by some commands)
    process.stdout.write = (chunk, encoding, callback) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString();
      const safe = text.replace(/[^\x00-\x7E]/g, '?');
      fs.writeSync(fd, safe);
      if (!text.endsWith('\n')) lineCount++;  // approximate
      if (typeof callback === 'function') callback();
      return true;
    };
  };

  const restoreRedirect = () => {
    console.log = origLog;
    process.stdout.write = origWrite;
    fs.closeSync(fd);
  };

  installRedirect();
  let result;
  try {
    result = fn();
  } catch (e) {
    restoreRedirect();
    throw e;
  }

  // If fn() returned a Promise, keep redirect active until it resolves
  if (result && typeof result.then === 'function') {
    return result.then(() => {
      restoreRedirect();
      return lineCount;
    }, (err) => {
      restoreRedirect();
      throw err;
    });
  }

  restoreRedirect();
  return lineCount;
}


// ========================================================================
// Help text
// ========================================================================

const HELP_TEXT = `
Code Exam Interactive Mode - Commands:
-------------------------------------------------------------
SEARCH:
  <query>                 Hybrid search (literal + semantic if available)
  /literal <pattern>      Literal text search
  /fast <pattern>         Fast inverted-index search
  /regex <pattern>        Regex pattern search
  /files-search <term>    Files containing term, sorted by hit count  [alias: /fsearch]
  /folders-search <term>  Folders containing term, sorted by hit count [alias: /dsearch]
  /max <N>                Set max results for subsequent searches (default: 10)

FUNCTIONS:
  /functions [filter]     List functions (matches name AND path) [alias: /funcs]
  /funcs PATH@NAME        Filter by file path and/or function name
  /funcs-size [N] [P]     Top N largest functions (optional filter P)
  /funcs-alpha [P]        Alphabetical function list (optional filter P)
  /extract <name>         Extract function source (Class.method or Class::method)
  /extract [N]            Select from last multiple-match list
  /extract <name> --follow-calls  Also dump source of called functions
  /extract <name> --comments-only Show only comments (combine with --follow-calls)
  /extract <name> --deep=N       Follow calls N levels deep
  /file <path>            Show entire file contents [aliases: /show-file, /cat]
  /file [N]               Select from previous multi-match list

CALLERS / CALL GRAPH:
  /callers <name>         Find callers of a function
  /callees <name>         Find callees (what does it call?)
  /call-inventory [name] [filter=PAT] [-v]  In-index vs external targets
  /most-called [N] [defined] [macros] [filter=PAT]
  /call-tree <name> [depth=N] [mermaid]  Call tree (default depth 3)
  /file-map [PATH] [mermaid]             File-level dependency map
  /file-tree FILE [depth=N] [mermaid]    File dependency tree

METRICS / DISCOVERY:
  /hotspots [N] [P]       Most important: big + frequently called
  /hot-folders [N] [P]    Most important directories by hotspot score
  /entry-points [N] [P] [max=N]  Largest functions never/rarely called
  /gaps [N]               Find suspicious dead code
  /domain-fns [N] [P]     Domain-specific hotspots (rare names weighted higher)
  /classes [P] [-v]        List all classes with method counts
  /class-hotspots [N] [P] Classes ranked by method hotspot score
  /vocabulary [N] [P]    Top domain-specific tokens by TF-IDF score (alias: /vocab)

MULTI-TERM INTERSECTION SEARCH:
  /multisect t1;t2;t3    Find smallest scope containing all terms (aliases: /ms, /multi)
                         Supports --in <path>, min=N, NOT terms (!term or NOT term)
                         Terms in /.../ are regex. Prefix with NOT or ! to negate.
                         Options: min=N (partial matching)

CLAIM SEARCH (LLM-based patent claim analysis):
  /claim <text>          Extract search terms from claim text via Claude API
  /claim @file.txt       Read claim from file. Requires ANTHROPIC_API_KEY env var.
                         Options: min=N, --show-prompt

LLM ANALYSIS (requires --use-claude or --analyze-model):
  /analyze <function>    Analyze a function with LLM ("what does this do?")
  /claim-analyze <claim> End-to-end: extract terms -> search -> analyze against claim
  /multisect-analyze <terms>  Search for terms, analyze top function hits
  /file-analyze <path>   Analyze an entire source file with LLM
                         Options: --mask-all, --line-numbers, --show-prompt

DEDUP / DUPLICATES:
  /file-dupes [N] [P]     Duplicate file groups by SHA1 hash (alias: /dupefiles)
  /func-dupes [N] [P]     Exact duplicate function groups (SHA1 body hash)
  /near-dupes [N] [P]     Near-duplicate groups (same name+size, different body)
  /struct-dupes [N] [P]   Structural dupes (same structure, different names/values)
  /funcstring <name>      Show structural funcstring for a function
  /struct-diff <name>     Show word-hole differences between structural dupe variants
  /struct-diff-all [N] [P] One-line diff summaries for top N structural dupe groups

INDEX INFO:
  /stats                  Show index statistics
  /index-extensions       Show file extensions in current index
  /files [filter]         List indexed files (optional path filter)
  /paths <pattern>        Search file/folder paths only

OTHER:
  /help                   Show this help
  /set                    Show current settings
  /set <key> <value>      Change a setting (max, verbose, full-path, show-dupes)
  /clear-cache            Clear cached call counts (forces re-scan on next metrics command)
  /rebuild-functions      Rebuild function index with improved C++ parsing
  !command                Run an OS command (e.g., !dir, !grep pattern file)
  /quit or Ctrl+C         Exit interactive mode

OUTPUT REDIRECTION:
  Any command can be followed by > or >> to redirect output to a file:
  /hotspots 50 > hotspots.txt          Write to file (overwrite)
  /classes >> results.txt               Append to file

PATH FILTER (--in):
  Most commands accept --in <pattern> to restrict results to files whose path
  contains <pattern>. Works with search, /hotspots, /vocab, /func-dupes, etc.
  Examples:
    recalc --in excel                  Search for 'recalc' only in files with 'excel' in path
    /vocab --in torch                  Vocabulary specific to PyTorch files
    /hotspots --in net                 Hotspot functions in networking-related files
    /struct-diff-all --in office       Structural diffs only in Office-related files
  /file-map mermaid > map.mmd          Save Mermaid diagram
-------------------------------------------------------------
`;


// ========================================================================
// Main REPL
// ========================================================================

export function doInteractive(index, _cliArgs) {
  // Derive index name for prompt (e.g. ".spinellis" from "/work/ai_code_exam/.spinellis")
  const idxName = (index.indexPath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop()
    || 'code-exam';
  const promptStr = `${idxName} code-exam> `;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: promptStr,
    // Basic history support comes free with readline
  });

  // Persistent REPL state — shared via ctx object so dispatch can mutate
  const ctx = {
    index,
    cliArgs: _cliArgs,
    state: {
      maxResults: 10,
      showDupes: false,
      showFuncstring: false,
      verbose: false,
      fullPath: false,
    },
  };

  console.log('\nCode Exam Interactive Mode');
  console.log(`Index: ${idxName} (${index.files.size} files)`);
  console.log('Type /help for commands, or just type a search query.\n');
  rl.prompt();

  rl.on('line', (line) => {
    const query = line.trim();
    if (!query) { rl.prompt(); return; }

    try {
      // Check for output redirection: /command > file.txt  or  >> file.txt
      const redir = parseRedirect(query);
      let result;
      if (redir) {
        const redirResult = withFileRedirect(redir.filePath, redir.append, () => {
          return dispatchCommand(redir.command, ctx);
        });

        // If redirect returned a Promise (async command like /claim),
        // wait for it before prompting
        if (redirResult && typeof redirResult.then === 'function') {
          redirResult.then(() => {
            console.log(`  Output ${redir.append ? 'appended' : 'written'} to: ${redir.filePath}`);
            rl.prompt();
          }).catch((err) => {
            console.log(`  Error: ${err.message}`);
            if (ctx.state.verbose) console.log(err.stack);
            rl.prompt();
          });
          return;
        }

        console.log(`  Output ${redir.append ? 'appended' : 'written'} to: ${redir.filePath}`);
      } else {
        result = dispatchCommand(query, ctx);
      }

      // Special return value from /quit
      if (result === '__exit__') { rl.close(); return; }

      // If dispatch returned a Promise (async command like /claim), wait for it
      if (result && typeof result.then === 'function') {
        result.then(() => rl.prompt()).catch((err) => {
          console.log(`  Error: ${err.message}`);
          if (ctx.state.verbose) console.log(err.stack);
          rl.prompt();
        });
        return; // Don't prompt yet - the .then() will
      }
    } catch (err) {
      console.log(`  Error: ${err.message}`);
      if (ctx.state.verbose) console.log(err.stack);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\nGoodbye!');
    process.exit(0);
  });
}


// ========================================================================
// Standalone dispatch — called by both doInteractive and execCommand
// ========================================================================

function ctxIargs(ctx, overrides = {}) {
  return makeIArgs(ctx.state.maxResults, {
    verbose: ctx.state.verbose,
    full_path: ctx.state.fullPath,
    show_dupes: ctx.state.showDupes,
    ...overrides,
  });
}

function dispatchCommand(query, ctx) {
  const { index } = ctx;
  function iargs(overrides) { return ctxIargs(ctx, overrides); }

    // Shell escape
    if (query.startsWith('!')) {
      const cmd = query.slice(1).trim();
      if (!cmd) {
        console.log('  Usage: !command  (e.g., !dir, !ls, !grep pattern file)');
        return;
      }
      try {
        const out = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        process.stdout.write(out);
      } catch (e) {
        if (e.stdout) process.stdout.write(e.stdout);
        if (e.stderr) process.stderr.write(e.stderr);
      }
      return;
    }

    // Exit
    if (/^\/(quit|exit|q)$/i.test(query)) {
      return '__exit__';
    }

    // Help
    if (query === '/help') {
      console.log(HELP_TEXT);
      return;
    }

    // Settings
    if (query === '/set') {
      console.log(`  max-results : ${ctx.state.maxResults}`);
      console.log(`  verbose     : ${ctx.state.verbose}`);
      console.log(`  full-path   : ${ctx.state.fullPath}`);
      console.log(`  show-dupes  : ${ctx.state.showDupes}`);
      return;
    }
    if (query.startsWith('/set ')) {
      const parts = query.slice(5).trim().split(/\s+/);
      const key = parts[0];
      const val = parts[1];
      switch (key) {
        case 'max': case 'max-results':
          ctx.state.maxResults = parseInt(val) || 10;
          console.log(`  max-results = ${ctx.state.maxResults}`);
          break;
        case 'verbose':
          ctx.state.verbose = val === 'on' || val === 'true' || val === '1';
          console.log(`  verbose = ${ctx.state.verbose}`);
          break;
        case 'full-path': case 'fullpath':
          ctx.state.fullPath = val === 'on' || val === 'true' || val === '1';
          console.log(`  full-path = ${ctx.state.fullPath}`);
          break;
        case 'show-dupes': case 'showdupes':
          ctx.state.showDupes = val === 'on' || val === 'true' || val === '1';
          console.log(`  show-dupes = ${ctx.state.showDupes}`);
          break;
        default:
          console.log(`  Unknown setting: ${key}`);
          console.log('  Available: max, verbose, full-path, show-dupes');
      }
      return;
    }

    // /max N shortcut
    if (query.startsWith('/max ')) {
      const n = parseInt(query.slice(5).trim());
      if (n > 0) { ctx.state.maxResults = n; console.log(`  max-results = ${ctx.state.maxResults}`); }
      else console.log('  Usage: /max <number>');
      return;
    }

    // /show-dupes toggle
    if (/^\/(show-?dupes|showdupes)$/i.test(query)) {
      ctx.state.showDupes = !ctx.state.showDupes;
      console.log(`  show-dupes: ${ctx.state.showDupes ? 'ON' : 'OFF'}`);
      return;
    }

    // /clear-cache
    if (/^\/(clear-?cache|clearcache)$/i.test(query)) {
      index._callCountsCache = null;
      index._knownFunctionsCache = null;
      console.log('  Caches cleared. Next metrics command will re-scan.');
      return;
    }

    // /rebuild-functions
    if (/^\/(rebuild-?functions|rebuild-?funcs)$/i.test(query)) {
      console.log(`Rebuilding function index from ${index.files.size} loaded files...`);
      index.buildFunctionIndex(true);
      // Clear caches that depend on function index
      index._callCountsCache = null;
      index._knownFunctionsCache = null;
      console.log('Function index rebuilt and saved. Caches cleared.');
      return;
    }

    // ----- Strip surrounding quotes from arguments -----
    // Interactive mode doesn't strip quotes the way the shell does for argv,
    // so "http;servlet" arrives with literal quote characters.
    // Handle both: "whole arg" and "quoted part" --in apache
    if (!query.startsWith('/')) {
      query = stripOuterQuotes(query);
    } else {
      // For /commands, strip quotes from quoted segments in the argument
      const spaceIdx = query.indexOf(' ');
      if (spaceIdx > 0) {
        const cmd = query.slice(0, spaceIdx);
        let arg = query.slice(spaceIdx + 1).trim();
        arg = arg.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1');
        query = cmd + ' ' + arg;
      }
    }

    // ----- Stats/info -----
    if (query === '/stats') {
      doStats(index, iargs({ stats: true }));
      return;
    }
    if (/^\/(index-extensions|idx-ext|extensions)$/i.test(query)) {
      doIndexExtensions(index, iargs({ index_extensions: true }));
      return;
    }

    // /files [filter]
    if (query === '/files' || query.startsWith('/files ')) {
      const pattern = query.length > 6 ? query.slice(7).trim() : null;
      const files = index.listFiles();
      const filtered = pattern
        ? files.filter(f => f.toLowerCase().includes(pattern.toLowerCase()))
        : files;
      console.log(`  ${filtered.length} files` + (pattern ? ` matching '${pattern}'` : ''));
      for (const f of filtered.slice(0, 50)) console.log(`    ${f}`);
      if (filtered.length > 50) console.log(`    ... and ${filtered.length - 50} more`);
      return;
    }

    // /paths <pattern>
    if (query.startsWith('/paths ')) {
      const pattern = query.slice(7).trim();
      if (pattern) {
        const matches = index.findPathMatches(pattern);
        console.log(`  ${matches.length} paths matching '${pattern}':`);
        for (const f of matches.slice(0, 50)) console.log(`    ${f}`);
        if (matches.length > 50) console.log(`    ... and ${matches.length - 50} more`);
      }
      return;
    }

    // ----- Search -----
    if (query.startsWith('/literal ')) {
      const { rest: lRest, inPattern: lIn } = extractInFilter(query.slice(9).trim());
      doLiteral(index, iargs({ literal: lRest, vocab_in: lIn }));
      return;
    }
    if (query.startsWith('/fast ')) {
      const { rest: fRest, inPattern: fIn } = extractInFilter(query.slice(6).trim());
      doFast(index, iargs({ fast: fRest, vocab_in: fIn }));
      return;
    }
    if (query.startsWith('/regex ')) {
      const { rest: rRest, inPattern: rIn } = extractInFilter(query.slice(7).trim());
      doRegex(index, iargs({ regex: rRest, vocab_in: rIn }));
      return;
    }
    if (query.startsWith('/files-search ') || query.startsWith('/fsearch ')) {
      const pat = query.startsWith('/f') && query[1] === 's'
        ? query.slice(9).trim()
        : query.slice(14).trim();
      doFilesSearch(index, iargs({ files_search: pat }));
      return;
    }
    if (query.startsWith('/folders-search ') || query.startsWith('/dsearch ')) {
      const pat = query.startsWith('/d')
        ? query.slice(9).trim()
        : query.slice(16).trim();
      doFoldersSearch(index, iargs({ folders_search: pat }));
      return;
    }

    // ----- Functions/browse -----
    if (query === '/functions' || query.startsWith('/functions ') ||
        query === '/funcs' || query.startsWith('/funcs ')) {
      dispatchFunctionsCmd(query, ctx);
      return;
    }
    if (query.startsWith('/funcs-size') || query.startsWith('/list-functions-size')) {
      const rest = query.replace(/^\/(funcs-size|list-functions-size)\s*/, '');
      const { n, pattern } = parseNPat(rest, 25);
      // Trailing @ means "path only"
      let incPath = null;
      let filterPat = pattern;
      if (pattern && pattern.endsWith('@')) {
        incPath = [pattern.slice(0, -1)];
        filterPat = null;
      }
      doListFunctionsSize(index, iargs({
        list_functions_size: true, filter: filterPat,
        include_path: incPath,
      }));
      return;
    }
    if (query.startsWith('/funcs-alpha') || query.startsWith('/list-functions-alpha')) {
      const rest = query.replace(/^\/(funcs-alpha|list-functions-alpha)\s*/, '');
      const pat = rest.trim() || null;
      doListFunctionsAlpha(index, iargs({
        list_functions_alpha: true, filter: pat,
      }));
      return;
    }

    // /extract
    if (query.startsWith('/extract ')) {
      const arg = query.slice(9).trim();
      // [N] selects from last match list
      const numMatch = arg.match(/^\[?(\d+)\]?$/);
      if (numMatch) {
        const n = parseInt(numMatch[1]);
        const last = index._lastExtractMatches;
        if (!last || last.length === 0) {
          console.log('  No previous match list. Search for a function first.');
        } else if (n < 1 || n > last.length) {
          console.log(`  Invalid selection. Choose 1-${last.length}`);
        } else {
          const m = last[n - 1];
          const source = index.getFunctionSource(m.filepath, m.name);
          if (source) {
            console.log(`# ${m.filepath}@${displayName(m.name, m.filepath)}`);
            console.log(source);
          }
        }
        return;
      }

      // Parse flags from the argument string
      const parts = arg.split(/\s+/);
      let funcSpec = '';
      let followCalls = false;
      let commentsOnly = false;
      let deep = null;
      let depth = 1;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p === '--follow-calls') {
          followCalls = true;
        } else if (p === '--deep') {
          deep = true;
        } else if (p === '--comments-only') {
          commentsOnly = true;
        } else if (p === '--depth' && i + 1 < parts.length) {
          depth = parseInt(parts[++i]) || 1;
        } else if (p.startsWith('--deep=')) {
          deep = p.slice(7);  // pass as string; browse.js parses it
        } else if (!p.startsWith('--')) {
          funcSpec += (funcSpec ? ' ' : '') + p;
        }
      }

      doExtract(index, iargs({
        extract: funcSpec,
        follow_calls: followCalls,
        deep,
        comments_only: commentsOnly,
        depth,
      }));
      return;
    }

    // /file, /show-file, /cat
    if (query.startsWith('/show-file ') || query.startsWith('/file ') || query.startsWith('/cat ')) {
      let arg;
      if (query.startsWith('/show-file ')) arg = query.slice(11).trim();
      else if (query.startsWith('/file ')) arg = query.slice(6).trim();
      else arg = query.slice(5).trim();

      // [N] selects from last file match list
      const numMatch = arg.match(/^\[?(\d+)\]?$/);
      if (numMatch) {
        const n = parseInt(numMatch[1]);
        const last = index._lastFileMatches;
        if (!last || last.length === 0) {
          console.log('  No previous match list. Search for a file first with /file <pattern>.');
        } else if (n < 1 || n > last.length) {
          console.log(`  Invalid selection. Choose 1-${last.length}`);
        } else {
          doShowFile(index, iargs({ show_file: last[n - 1] }));
        }
        return;
      }

      doShowFile(index, iargs({ show_file: arg }));
      return;
    }

    // ----- Callers / call graph -----
    if (query.startsWith('/callers ')) {
      doCallers(index, iargs({ callers: query.slice(9).trim(), max_results: 500 }));
      return;
    }
    if (query.startsWith('/callees ')) {
      doCallees(index, iargs({ callees: query.slice(9).trim() }));
      return;
    }
    if (query.startsWith('/call-inventory') || query.startsWith('/callinventory')) {
      const rest = query.replace(/^\/(call-?inventory)\s*/, '');
      const parts = rest.split(/\s+/).filter(Boolean);
      let funcArg = null, filterPat = null, verbose = false;
      for (const p of parts) {
        if (p.startsWith('filter=')) filterPat = p.split('=').slice(1).join('=');
        else if (p === '-v' || p === 'verbose') verbose = true;
        else funcArg = p;
      }
      doCallInventory(index, iargs({
        call_inventory: funcArg || '.',
        filter: filterPat,
        verbose,
      }));
      return;
    }
    if (query.startsWith('/most-called') || query.startsWith('/mostcalled')) {
      const rest = query.replace(/^\/(most-?called)\s*/, '');
      const { n, pattern, flags } = parseNPat(rest, 20);
      const definedOnly = flags.includes('defined') || rest.includes('defined');
      const includeMacros = flags.includes('macros') || rest.includes('macros');
      doMostCalled(index, iargs({
        most_called: n, filter: pattern, min_name_length: 2,
        defined_only: definedOnly, include_macros: includeMacros,
      }));
      return;
    }
    if (query.startsWith('/call-tree ') || query.startsWith('/calltree ')) {
      const rest = query.startsWith('/call-tree ') ? query.slice(11).trim() : query.slice(10).trim();
      const parts = rest.split(/\s+/).filter(Boolean);
      let funcArg = '', treeDepth = 3, mermaidOut = false;
      for (const p of parts) {
        if (p.startsWith('depth=')) treeDepth = parseInt(p.split('=')[1]) || 3;
        else if (p === 'mermaid') mermaidOut = true;
        else if (/^\d+$/.test(p)) treeDepth = parseInt(p);
        else funcArg = p;
      }
      if (!funcArg) { console.log('  Usage: /call-tree FUNCTION [depth=N] [mermaid]'); return; }
      doCallTree(index, iargs({ call_tree: funcArg, depth: treeDepth, mermaid: mermaidOut }));
      return;
    }
    if (query.startsWith('/file-map') || query.startsWith('/filemap')) {
      const rest = query.replace(/^\/(file-?map)\s*/, '');
      const parts = rest.split(/\s+/).filter(Boolean);
      let pathArg = '', mermaidOut = false;
      for (const p of parts) {
        if (p === 'mermaid') mermaidOut = true;
        else pathArg = p;
      }
      const args = iargs({ file_map: pathArg, mermaid: mermaidOut });
      args._explicit.add('file_map');
      doFileMap(index, args);
      return;
    }
    if (query.startsWith('/file-tree ') || query.startsWith('/filetree ')) {
      const rest = query.startsWith('/file-tree ') ? query.slice(11).trim() : query.slice(10).trim();
      const parts = rest.split(/\s+/).filter(Boolean);
      let fileArg = '', treeDepth = 2, mermaidOut = false;
      for (const p of parts) {
        if (p.startsWith('depth=')) treeDepth = parseInt(p.split('=')[1]) || 2;
        else if (p === 'mermaid') mermaidOut = true;
        else if (/^\d+$/.test(p)) treeDepth = parseInt(p);
        else fileArg = p;
      }
      if (!fileArg) { console.log('  Usage: /file-tree FILE [depth=N] [mermaid]'); return; }
      doFileTree(index, iargs({ file_tree: fileArg, depth: treeDepth, mermaid: mermaidOut }));
      return;
    }

    // ----- Metrics / discovery -----
    if (query.startsWith('/hotspots') && !query.startsWith('/hotfolders')) {
      const rest = query.replace(/^\/hotspots\s*/, '');
      const { rest: hRest, inPattern: hIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(hRest, 25);
      doHotspots(index, iargs({ hotspots: n, filter: pattern, vocab_in: hIn }));
      return;
    }
    if (query.startsWith('/hot-folders') || query.startsWith('/hotfolders')) {
      const rest = query.replace(/^\/(hot-?folders)\s*/, '');
      const { rest: hRest, inPattern: hIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(hRest, 20);
      doHotFolders(index, iargs({ hot_folders: n, filter: pattern, vocab_in: hIn }));
      return;
    }
    if (query.startsWith('/entry-points') || query.startsWith('/entry')) {
      const rest = query.replace(/^\/(entry-?points|entry)\s*/, '');
      const { rest: eRest, inPattern: eIn } = extractInFilter(rest);
      const { n, pattern, opts } = parseNPat(eRest, 25);
      const mc = parseInt(opts['max-calls'] || opts['max'] || '0');
      doEntryPoints(index, iargs({ entry_points: n, filter: pattern, max_calls: mc, vocab_in: eIn }));
      return;
    }
    if (query.startsWith('/gaps')) {
      const rest = query.replace(/^\/gaps\s*/, '');
      const { rest: gRest, inPattern: gIn } = extractInFilter(rest);
      const { n } = parseNPat(gRest, 25);
      const args = iargs({ gaps: n, vocab_in: gIn });
      args._explicit.add('gaps');
      doGaps(index, args);
      return;
    }
    if (query.startsWith('/domain-fns') || query.startsWith('/domain')) {
      const rest = query.replace(/^\/(domain-?fns|domain)\s*/, '');
      const { rest: dRest, inPattern: dIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(dRest, 25);
      doDomainFns(index, iargs({ domain_fns: n, filter: pattern, vocab_in: dIn }));
      return;
    }
    if (query.startsWith('/classes') || query.startsWith('/list-classes')) {
      const rest = query.replace(/^\/(classes|list-classes)\s*/, '');
      const { rest: cRest, inPattern: cIn } = extractInFilter(rest);
      const parts = cRest.split(/\s+/).filter(Boolean);
      let pattern = null;
      let isVerbose = ctx.state.verbose; // inherit from global /set verbose
      for (const p of parts) {
        if (p === '-v' || p === '--verbose') isVerbose = true;
        else pattern = p;
      }
      doListClasses(index, iargs({
        list_classes: true, filter: pattern, verbose: isVerbose, vocab_in: cIn,
      }));
      return;
    }
    if (query.startsWith('/class-hotspots') || query.startsWith('/class-hot')) {
      const rest = query.replace(/^\/(class-hotspots|class-hot)\s*/, '');
      const { rest: chRest, inPattern: chIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(chRest, 25);
      doClassHotspots(index, iargs({ class_hotspots: n, filter: pattern, vocab_in: chIn }));
      return;
    }

    if (query.startsWith('/vocabulary') || query.startsWith('/vocab')) {
      const rest = query.replace(/^\/(vocabulary|vocab)\s*/, '');
      const { rest: vRest, inPattern: vIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(vRest, 50);
      doVocabulary(index, iargs({ discover_vocabulary: n, filter: pattern, vocab_in: vIn }));
      return;
    }

    // ----- Phase 5: Multi-term intersection search -----
    if (/^\/(multisect|multi|ms)(\s|$)/i.test(query)) {
      let rest = query.replace(/^\/(multisect|multi|ms)\s*/i, '');

      if (!rest) {
        console.log('Usage: /multisect term1;term2;term3 [min=N]');
        console.log('  Terms separated by semicolons. /.../ for regex. NOT or ! prefix to negate.');
        return;
      }

      const { rest: mRest, inPattern: mIn } = extractInFilter(rest);

      // Extract min=N option
      let minTerms = '0';
      const minMatch = mRest.match(/\bmin=(\d+)/);
      if (minMatch) {
        minTerms = minMatch[1];
        rest = mRest.replace(/\bmin=\d+/, '').trim();
      } else {
        rest = mRest;
      }

      doMultisect(index, iargs({
        multisect_search: rest,
        min_terms: minTerms,
        vocab_in: mIn,
      }));
      return;
    }

    // ----- Phase 8a: Claim search (LLM-based) -----
    if (/^\/(claim)(\s|$)/i.test(query)) {
      let rest = query.replace(/^\/claim\s*/i, '');

      if (!rest) {
        console.log('Usage: /claim <patent claim text>');
        console.log('       /claim @file.txt');
        console.log('  Extracts search terms from patent claim via Claude API.');
        console.log('  Requires ANTHROPIC_API_KEY environment variable.');
        console.log('  Options: min=N, temp=N, --show-prompt');
        return;
      }

      const { rest: cRest, inPattern: cIn } = extractInFilter(rest);

      // Extract min=N option
      let minTerms = '0';
      const minMatch = cRest.match(/\bmin=(\d+)/);
      let claimText = cRest;
      if (minMatch) {
        minTerms = minMatch[1];
        claimText = cRest.replace(/\bmin=\d+/, '').trim();
      }

      // Extract temp=N option
      let temperature = ctx.cliArgs.temperature ?? 0.0;
      const tempMatch = claimText.match(/\btemp=([\d.]+)/);
      if (tempMatch) {
        temperature = parseFloat(tempMatch[1]);
        claimText = claimText.replace(/\btemp=[\d.]+/, '').trim();
      }

      // Check for --show-prompt flag
      let showPrompt = false;
      if (/--show-prompt/.test(claimText)) {
        showPrompt = true;
        claimText = claimText.replace(/--show-prompt/, '').trim();
      }

      // Determine if it's @file or inline text
      const localModel = ctx.cliArgs.claim_model || ctx.cliArgs.analyze_model || null;
      const claimArgs = {
        claim_search: claimText.startsWith('@') ? claimText : claimText,
        claim_file: null,
        use_claude: !localModel,  // use Claude unless local model available
        claim_model: ctx.cliArgs.claim_model || null,
        analyze_model: ctx.cliArgs.analyze_model || null,
        api_key: ctx.cliArgs.api_key || null,
        min_terms: minTerms,
        show_prompt: showPrompt,
        temperature,
        include_path: cIn ? [cIn] : null,
      };

      // Async - return promise so readline handler can await it
      return doClaimSearch(index, iargs(claimArgs));
    }

    // ----- Phase 8b: LLM Analysis commands -----

    if (/^\/(analyze)(\s|$)/i.test(query)) {
      let rest = query.replace(/^\/analyze\s*/i, '').trim();

      if (!rest) {
        console.log('Usage: /analyze <function>');
        console.log('       /analyze FILE@FUNCTION');
        console.log('  Analyzes a function with LLM. Requires --use-claude or --analyze-model.');
        console.log('  Options: --mask-all, --line-numbers, --show-prompt');
        return;
      }

      let showPrompt = false;
      if (/--show-prompt/.test(rest)) { showPrompt = true; rest = rest.replace(/--show-prompt/, '').trim(); }
      let maskAll = !!ctx.cliArgs.mask_all;
      if (/--mask-all/.test(rest)) { maskAll = true; rest = rest.replace(/--mask-all/, '').trim(); }
      let lineNumbers = !!ctx.cliArgs.line_numbers;
      if (/--line-numbers/.test(rest)) { lineNumbers = true; rest = rest.replace(/--line-numbers/, '').trim(); }

      return doAnalyze(index, iargs({
        analyze: rest,
        use_claude: ctx.cliArgs.use_claude || false,
        analyze_model: ctx.cliArgs.analyze_model || null,
        api_key: ctx.cliArgs.api_key || null,
        temperature: ctx.cliArgs.temperature ?? 0.0,
        mask_all: maskAll,
        line_numbers: lineNumbers,
        show_prompt: showPrompt,
      }));
    }

    if (/^\/(claim-analyze)(\s|$)/i.test(query)) {
      let rest = query.replace(/^\/claim-analyze\s*/i, '').trim();

      if (!rest) {
        console.log('Usage: /claim-analyze @patent_claim.txt');
        console.log('       /claim-analyze "A method comprising..."');
        console.log('  End-to-end: extract terms -> search -> analyze against claim.');
        console.log('  Requires --use-claude or --analyze-model and ANTHROPIC_API_KEY.');
        console.log('  Options: --mask-all, --line-numbers, --show-prompt, min=N');
        return;
      }

      let showPrompt = false;
      if (/--show-prompt/.test(rest)) { showPrompt = true; rest = rest.replace(/--show-prompt/, '').trim(); }
      let maskAll = !!ctx.cliArgs.mask_all;
      if (/--mask-all/.test(rest)) { maskAll = true; rest = rest.replace(/--mask-all/, '').trim(); }
      let lineNumbers = !!ctx.cliArgs.line_numbers;
      if (/--line-numbers/.test(rest)) { lineNumbers = true; rest = rest.replace(/--line-numbers/, '').trim(); }
      let minTerms = '0';
      const minMatch = rest.match(/\bmin=(\d+)/);
      if (minMatch) { minTerms = minMatch[1]; rest = rest.replace(/\bmin=\d+/, '').trim(); }

      return doClaimAnalyze(index, iargs({
        claim_analyze: rest,
        use_claude: !!ctx.cliArgs.use_claude,
        analyze_model: ctx.cliArgs.analyze_model || null,
        claim_model: ctx.cliArgs.claim_model || null,
        api_key: ctx.cliArgs.api_key || null,
        temperature: ctx.cliArgs.temperature ?? 0.0,
        mask_all: maskAll,
        line_numbers: lineNumbers,
        show_prompt: showPrompt,
        min_terms: minTerms,
        include_path: null,
        exclude_path: null,
      }));
    }

    if (/^\/(multisect-analyze)(\s|$)/i.test(query)) {
      let rest = query.replace(/^\/multisect-analyze\s*/i, '').trim();

      if (!rest) {
        console.log('Usage: /multisect-analyze "term1;term2;term3"');
        console.log('  Searches for functions matching terms, analyzes top hits.');
        console.log('  Requires --use-claude or --analyze-model.');
        console.log('  Options: --mask-all, --line-numbers, --show-prompt, min=N');
        return;
      }

      rest = stripOuterQuotes(rest);

      let showPrompt = false;
      if (/--show-prompt/.test(rest)) { showPrompt = true; rest = rest.replace(/--show-prompt/, '').trim(); }
      let maskAll = !!ctx.cliArgs.mask_all;
      if (/--mask-all/.test(rest)) { maskAll = true; rest = rest.replace(/--mask-all/, '').trim(); }
      let lineNumbers = !!ctx.cliArgs.line_numbers;
      if (/--line-numbers/.test(rest)) { lineNumbers = true; rest = rest.replace(/--line-numbers/, '').trim(); }
      let minTerms = '0';
      const minMatch = rest.match(/\bmin=(\d+)/);
      if (minMatch) { minTerms = minMatch[1]; rest = rest.replace(/\bmin=\d+/, '').trim(); }

      const { rest: mRest, inPattern: mIn } = extractInFilter(rest);

      return doMultisectAnalyze(index, iargs({
        multisect_analyze: mRest,
        use_claude: ctx.cliArgs.use_claude || false,
        analyze_model: ctx.cliArgs.analyze_model || null,
        api_key: ctx.cliArgs.api_key || null,
        temperature: ctx.cliArgs.temperature ?? 0.0,
        mask_all: maskAll,
        line_numbers: lineNumbers,
        show_prompt: showPrompt,
        min_terms: minTerms,
        include_path: mIn ? [mIn] : null,
        exclude_path: null,
      }));
    }

    if (/^\/(file-analyze)(\s|$)/i.test(query)) {
      let rest = query.replace(/^\/file-analyze\s*/i, '').trim();

      if (!rest) {
        console.log('Usage: /file-analyze <filepath>');
        console.log('  Analyzes an entire source file with LLM.');
        console.log('  Requires --use-claude or --analyze-model.');
        console.log('  Options: --mask-all, --line-numbers, --show-prompt');
        return;
      }

      let showPrompt = false;
      if (/--show-prompt/.test(rest)) { showPrompt = true; rest = rest.replace(/--show-prompt/, '').trim(); }
      let maskAll = !!ctx.cliArgs.mask_all;
      if (/--mask-all/.test(rest)) { maskAll = true; rest = rest.replace(/--mask-all/, '').trim(); }
      let lineNumbers = !!ctx.cliArgs.line_numbers;
      if (/--line-numbers/.test(rest)) { lineNumbers = true; rest = rest.replace(/--line-numbers/, '').trim(); }

      return doFileAnalyze(index, iargs({
        file_analyze: rest,
        use_claude: ctx.cliArgs.use_claude || false,
        analyze_model: ctx.cliArgs.analyze_model || null,
        api_key: ctx.cliArgs.api_key || null,
        temperature: ctx.cliArgs.temperature ?? 0.0,
        mask_all: maskAll,
        line_numbers: lineNumbers,
        show_prompt: showPrompt,
      }));
    }

    // ----- Phase 4: Dedup commands -----
    if (query.startsWith('/dupefiles') || query.startsWith('/file-dupes') || query.startsWith('/filedupes')) {
      const rest = query.replace(/^\/(dupefiles|file-?dupes)\s*/, '');
      const { rest: dfRest, inPattern: dfIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(dfRest, 25);
      doDupefiles(index, iargs({ dupefiles: n, filter: pattern, vocab_in: dfIn }));
      return;
    }

    if (query.startsWith('/func-dupes') || query.startsWith('/funcdupes')) {
      const rest = query.replace(/^\/(func-?dupes)\s*/, '');
      const { rest: fdRest, inPattern: fdIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(fdRest, 25);
      doFuncDupes(index, iargs({ func_dupes: n, filter: pattern, vocab_in: fdIn }));
      return;
    }

    if (query.startsWith('/near-dupes') || query.startsWith('/neardupes')) {
      const rest = query.replace(/^\/(near-?dupes)\s*/, '');
      const { rest: ndRest, inPattern: ndIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(ndRest, 25);
      doNearDupes(index, iargs({ near_dupes: n, filter: pattern, vocab_in: ndIn }));
      return;
    }

    if (query.startsWith('/struct-dupes') || query.startsWith('/structdupes')) {
      const rest = query.replace(/^\/(struct-?dupes)\s*/, '');
      const { rest: sdRest, inPattern: sdIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(sdRest, 25);
      doStructDupes(index, iargs({ struct_dupes: n, filter: pattern, show_funcstring: ctx.state.showFuncstring, vocab_in: sdIn }));
      return;
    }

    if (query.startsWith('/show-funcstring') || query.startsWith('/funcstring')) {
      const rest = query.replace(/^\/(show-funcstring|funcstring)\s*/, '');
      const funcName = rest.trim() || null;
      if (funcName) {
        doShowFuncstring(index, iargs({ show_funcstring: funcName }));
      } else {
        // No name - show funcstrings for struct-dupes
        doShowFuncstring(index, iargs({ show_funcstring: true, struct_dupes: 25 }));
      }
      return;
    }

    if (query.startsWith('/struct-diff-all') || query.startsWith('/structdiffall')) {
      const rest = query.replace(/^\/(struct-?diff-?all)\s*/, '');
      const { rest: sdaRest, inPattern: sdaIn } = extractInFilter(rest);
      const { n, pattern } = parseNPat(sdaRest, 25);
      doStructDiffAll(index, iargs({ struct_diff_all: n, filter: pattern, vocab_in: sdaIn }));
      return;
    }

    if (query.startsWith('/struct-diff') || query.startsWith('/structdiff')) {
      const rest = query.replace(/^\/(struct-?diff)\s*/, '').trim();
      const { rest: sdfRest, inPattern: sdfIn } = extractInFilter(rest);
      if (!sdfRest) {
        console.log('  Usage: /struct-diff <function-name>');
        console.log('  Shows word-hole differences between structural dupe variants.');
        return;
      }
      doStructDiff(index, iargs({ struct_diff: sdfRest, vocab_in: sdfIn }));
      return;
    }

    // ----- Default: hybrid search -----
    if (query.startsWith('/')) {
      console.log(`  Unknown command: ${query.split(/\s/)[0]}`);
      console.log('  Type /help for available commands.');
      return;
    }
    const { rest: searchQuery, inPattern: searchIn } = extractInFilter(query);
    doSearch(index, iargs({ search: searchQuery, vocab_in: searchIn }));
  }


// ------------------------------------------------------------------
// /functions dispatch - standalone helper
// ------------------------------------------------------------------
function dispatchFunctionsCmd(query, ctx) {
    const { index } = ctx;
    let pattern;
    if (query.startsWith('/functions')) {
      pattern = query.length > 10 ? query.slice(11).trim() : null;
    } else {
      pattern = query.length > 5 ? query.slice(6).trim() : null;
    }

    // Special pattern "" from just "/funcs " -> null
    if (pattern === '') pattern = null;

    let functions;
    let desc = '';

    if (pattern && pattern.includes('@')) {
      // path@name syntax
      const atPos = pattern.indexOf('@');
      const pathFilter = pattern.slice(0, atPos).toLowerCase().replace(/\\/g, '/');
      const nameFilter = pattern.slice(atPos + 1).toLowerCase();
      functions = index.listFunctions();
      functions = functions.filter(f =>
        (!pathFilter || f.filepath.toLowerCase().replace(/\\/g, '/').includes(pathFilter)) &&
        (!nameFilter || f.name.toLowerCase().includes(nameFilter))
      );
      desc = `matching path='${pattern.slice(0, atPos)}'` +
        (nameFilter ? ` name='${pattern.slice(atPos + 1)}'` : '');
    } else if (pattern) {
      const pat = pattern.toLowerCase().replace(/\\/g, '/');
      functions = index.listFunctions();
      functions = functions.filter(f =>
        pat.length >= 2 && (
          f.name.toLowerCase().includes(pat) ||
          f.filepath.toLowerCase().replace(/\\/g, '/').includes(pat)
        )
      );
      desc = `matching '${pattern}'`;
    } else {
      functions = index.listFunctions();
    }

    console.log(`  ${functions.length} functions` + (desc ? ` ${desc}` : ''));
    const sorted = functions.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    const limit = ctx.state.maxResults || 50;
    for (const f of sorted.slice(0, limit)) {
      console.log(`    ${(f.displayName || f.name).padEnd(40)} ${String(f.lines).padStart(5)} lines  ${f.filepath}`);
    }
    if (sorted.length > limit) {
      console.log(`    ... and ${sorted.length - limit} more (use /set max N to see more)`);
    }
}


// ========================================================================
// execCommand — server-callable: captures stdout, runs any interactive command
// ========================================================================

export async function execCommand(index, query, opts = {}) {
  const lines = [];
  const origLog = console.log;
  const origWrite = process.stdout.write.bind(process.stdout);

  console.log = (...args) => {
    lines.push(args.map(a => typeof a === 'string' ? a : String(a)).join(' '));
  };
  process.stdout.write = (s) => {
    if (typeof s === 'string') lines.push(s.replace(/\n$/, ''));
    return true;
  };

  const ctx = {
    index,
    cliArgs: opts,
    state: {
      maxResults: parseInt(opts.max) || 25,
      verbose: opts.verbose || false,
      fullPath: opts.fullPath || false,
      showDupes: opts.showDupes || false,
      showFuncstring: false,
    },
  };

  try {
    const result = dispatchCommand(query, ctx);
    if (result && typeof result.then === 'function') await result;
  } catch (err) {
    lines.push(`Error: ${err.message}`);
  } finally {
    console.log = origLog;
    process.stdout.write = origWrite;
  }

  return lines.join('\n');
}
