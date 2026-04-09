#!/usr/bin/env node
/**
 * code-exam - Air-Gapped Source Code Examination Tool (Node.js)
 *
 * CLI entry point. Zero external dependencies.
 * Compatible with Python version's JSON index format.
 */

import { parseArgs } from './argparse.js';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';
import {
  doSearch, doLiteral, doFast, doRegex,
  doFilesSearch, doFoldersSearch,
} from './commands/search.js';
import {
  doStats, doScanExtensions, doIndexExtensions, doListIndexes,
  doExtract, doListFiles, doShowFile,
  doListFunctions, doListFunctionsAlpha, doListFunctionsSize,
} from './commands/browse.js';
import {
  doCallers, doCallees, doMostCalled, doCallInventory,
} from './commands/callers.js';
import {
  doCallTree, doClassTree, doFileMap, doFileTree,
} from './commands/graph.js';
import {
  doHotspots, doHotFolders, doEntryPoints, doGaps,
  doDomainFns, doListClasses, doClassHotspots, doVocabulary,
} from './commands/metrics.js';
import {
  doDupefiles, doFuncDupes, doNearDupes,
  doStructDupes, doShowFuncstring, doStructDiff, doStructDiffAll,
} from './commands/dedup.js';
import { doInteractive } from './commands/interactive.js';
import { doMultisect } from './commands/multisect.js';
import { doClaimSearch } from './commands/claim.js';
import {
  doAnalyze, doClaimAnalyze, doMultisectAnalyze, doFileAnalyze,
} from './commands/analyze.js';


// ========================================================================
// Parse arguments
// ========================================================================

const args = parseArgs();


// ========================================================================
// Commands that don't need an index
// ========================================================================

if (args.scan_extensions) {
  doScanExtensions(args);
  process.exit(0);
}

if (args._explicit.has('list_indexes')) {
  doListIndexes(args);
  process.exit(0);
}


// ========================================================================
// Create or load index
// ========================================================================

let customExtensions = null;
if (args.extensions) {
  customExtensions = new Set(
    args.extensions.split(',').map(e => e.trim().startsWith('.') ? e.trim() : '.' + e.trim())
  );
}

// --exclude-extensions: start from the current set (custom or default) and remove
let excludeCompound = null;
if (args.exclude_extensions) {
  if (!customExtensions) {
    customExtensions = new Set(CodeSearchIndex.DEFAULT_EXTENSIONS);
  }
  for (let ext of args.exclude_extensions.split(',')) {
    ext = ext.trim().toLowerCase();
    if (!ext.startsWith('.')) ext = '.' + ext;
    customExtensions.delete(ext);
    // Compound extensions (e.g., .d.ts) — path.extname only returns the
    // last part (.ts), so these need special filename-suffix matching
    const dotCount = (ext.match(/\./g) || []).length;
    if (dotCount > 1) {
      if (!excludeCompound) excludeCompound = new Set();
      excludeCompound.add(ext);
    }
  }
}

const index = new CodeSearchIndex({
  indexPath: args.index_path,
  extensions: customExtensions,
  excludeCompound,
});


// ========================================================================
// Build index if requested
// ========================================================================

if (args.build_index) {
  // Report excluded extensions
  if (args.exclude_extensions) {
    const excluded = args.exclude_extensions.split(',').map(e => {
      e = e.trim();
      return e.startsWith('.') ? e : '.' + e;
    });
    process.stderr.write(`Excluding extensions: ${excluded.join(', ')}\n`);
  }

  const buildStats = await index.buildIndex(args.build_index, {
    showProgress: true,
    skipSemantic: args.skip_semantic,
    demanglerPath: args.demangler,
    useTreeSitter: args.use_tree_sitter,
  });

  if (buildStats.errors.length > 0) {
    console.log(`\nErrors (${buildStats.errors.length}):`);
    for (const err of buildStats.errors.slice(0, 10)) {
      console.log(`  ${err}`);
    }
    if (buildStats.errors.length > 10) {
      console.log(`  ... and ${buildStats.errors.length - 10} more`);
    }
  }

  // If only building (no other command), exit
  const queryCommands = [
    'search', 'literal', 'fast', 'regex', 'files_search', 'folders_search',
    'stats', 'list_functions', 'list_functions_alpha', 'list_functions_size',
    'extract', 'list_files', 'show_file', 'index_extensions', 'interactive',
    'callers', 'callees', 'most_called', 'call_tree', 'call_inventory', 'file_map', 'file_tree',
    'hotspots', 'hot_folders', 'entry_points', 'gaps', 'domain_fns',
    'list_classes', 'class_hotspots', 'discover_vocabulary',
    'analyze', 'claim_analyze', 'multisect_analyze', 'file_analyze',
    'dupefiles', 'func_dupes', 'near_dupes', 'struct_dupes', 'show_funcstring', 'struct_diff', 'struct_diff_all',
  ];
  if (!queryCommands.some(c => args._explicit.has(c) || args[c])) {
    process.exit(0);
  }
}


// ========================================================================
// Check we have an index for queries
// ========================================================================

if (index.files.size === 0 && !args.build_index) {
  console.log(`No index found at: ${args.index_path}`);
  console.log('Build one first:');
  console.log('  node src/index.js --build-index ./your/source/directory');
  console.log('  node src/index.js --build-index "C:\\path\\to\\code"');
  console.log('  node src/index.js --build-index @filelist.txt');
  process.exit(1);
}


// ========================================================================
// Rebuild function index (from already-loaded file_lines)
// ========================================================================

if (args.rebuild_functions) {
  console.log(`Rebuilding function index from ${index.files.size} loaded files...`);
  if (args.use_tree_sitter) {
    await index.buildFunctionIndexTreeSitter(true);
  } else {
    index.buildFunctionIndex(true);
  }
  console.log('Function index rebuilt and saved.');
}


// ========================================================================
// Dispatch commands
// ========================================================================

if (args.stats)                             doStats(index, args);
if (args.index_extensions)                  doIndexExtensions(index, args);

if (args.search)                            doSearch(index, args);
if (args.literal)                           doLiteral(index, args);
if (args.fast)                              doFast(index, args);
if (args.regex)                             doRegex(index, args);
if (args.files_search)                      doFilesSearch(index, args);
if (args.folders_search)                    doFoldersSearch(index, args);

if (args.extract)                           doExtract(index, args);
if (args._explicit.has('list_files'))       doListFiles(index, args);
if (args.show_file)                         doShowFile(index, args);
if (args._explicit.has('list_functions'))   doListFunctions(index, args);
if (args.list_functions_alpha)              doListFunctionsAlpha(index, args);
if (args.list_functions_size)               doListFunctionsSize(index, args);

if (args.callers)                           doCallers(index, args);
if (args.callees)                           doCallees(index, args);
if (args.most_called)                       doMostCalled(index, args);
if (args._explicit.has('call_inventory'))   doCallInventory(index, args);

if (args.call_tree)                         doCallTree(index, args);
if (args._explicit.has('class_tree'))       doClassTree(index, args);
if (args._explicit.has('file_map'))         doFileMap(index, args);
if (args.file_tree)                         doFileTree(index, args);

if (args.hotspots)                          doHotspots(index, args);
if (args.hot_folders)                       doHotFolders(index, args);
if (args.entry_points)                      doEntryPoints(index, args);
if (args._explicit.has('gaps'))             doGaps(index, args);
if (args.domain_fns)                        doDomainFns(index, args);
if (args.list_classes)                      doListClasses(index, args);
if (args.class_hotspots)                    doClassHotspots(index, args);
if (args.discover_vocabulary)               doVocabulary(index, args);
if (args.multisect_search)                  doMultisect(index, args);

// Claim search is async (API call) — use top-level await
if (args.claim_search || args.claim_file) {
  await doClaimSearch(index, args);
}

// Phase 8b: Analysis commands (async — LLM calls)
if (args.analyze) {
  await doAnalyze(index, args);
}
if (args.claim_analyze) {
  await doClaimAnalyze(index, args);
}
if (args.multisect_analyze) {
  await doMultisectAnalyze(index, args);
}
if (args.file_analyze) {
  await doFileAnalyze(index, args);
}

if (args.dupefiles)                         doDupefiles(index, args);
if (args.func_dupes)                        doFuncDupes(index, args);
if (args.near_dupes)                        doNearDupes(index, args);
if (args.struct_dupes)                      doStructDupes(index, args);
if (args._explicit.has('show_funcstring'))  doShowFuncstring(index, args);
if (args.struct_diff)                       doStructDiff(index, args);
if (args.struct_diff_all)                   doStructDiffAll(index, args);

// Content analysis
if (args.command_catalog) {
  const catalog = index.extractCommandCatalog(true);
  const primaryCmds = catalog.commands.filter(c => c.tier === 'primary');
  const secondaryCmds = catalog.commands.filter(c => c.tier !== 'primary');
  const cmdFmt = c => `  ${c.name}${c.description ? '  — ' + c.description.slice(0, 60) : ''}${c.handler ? '  → ' + (c.handler.func || c.handler.filepath.split('/').pop()) + ':' + c.handler.line : ''}  [${c.filepath}:${c.line}]`;
  const sections = [
    ['CLI Options', catalog.cliOptions, o => `  ${o.flags.join(', ')}  [${o.type}]${o.help ? '  ' + o.help : ''}${o.handler?.handlerFunc ? '  → ' + o.handler.handlerFunc : ''}`],
    ['Commands', primaryCmds, cmdFmt],
    ['Other switch/case values', secondaryCmds, cmdFmt],
    ['API Routes', catalog.routes, r => `  ${r.path}  [${r.filepath}:${r.line}]`],
    ['GUI Actions', catalog.guiActions, a => `  ${a.name} (${a.type})${a.handler ? '  → ' + a.handler.filepath + ':' + a.handler.line : ''}  [${a.filepath}:${a.line}]`],
  ];
  for (const [title, items, fmt] of sections) {
    if (items.length === 0) continue;
    console.log(`\n${title} (${items.length}):`);
    for (const item of items) console.log(fmt(item));
  }
}

if (args._explicit.has('string_table') || args.string_table) {
  const filter = typeof args.string_table === 'string' ? args.string_table : null;
  const table = index.ensureStringTable(8, true);
  let results = table;
  if (filter) {
    const regexMatch = filter.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      try { const re = new RegExp(regexMatch[1], regexMatch[2]); results = table.filter(s => re.test(s.value)); }
      catch { results = table.filter(s => s.value.toLowerCase().includes(filter.toLowerCase())); }
    } else {
      results = table.filter(s => s.value.toLowerCase().includes(filter.toLowerCase()));
    }
  }
  const max = args.max_results || 50;
  console.log(`\nStrings${filter ? ' matching "' + filter + '"' : ''}: ${results.length} unique (showing ${Math.min(max, results.length)})`);
  for (const s of results.slice(0, max)) {
    const preview = s.value.length > 70 ? s.value.slice(0, 70).replace(/\n/g, '\\n') + '...' : s.value.replace(/\n/g, '\\n');
    const locs = s.locations.slice(0, 3).map(l => (l.func || '(scope)') + '@' + l.line).join(', ');
    console.log(`  ${s.count}x ${s.files}f  "${preview}"  [${locs}]`);
  }
}

if (args.breadcrumbs) {
  const data = index.extractBreadcrumbs(true);
  if (data.markers.length > 0) {
    console.log(`\nExecution Flow (${data.markers.length} trace markers):`);
    let lastPhase = '';
    for (const m of data.markers) {
      const phase = m.label.split('_')[0];
      if (phase !== lastPhase) {
        lastPhase = phase;
        console.log(`\n  --- ${phase.toUpperCase()} ---`);
      }
      console.log(`  ${String(m.line).padStart(6)}  ${m.label}${m.func ? '  [' + m.func + ']' : ''}`);
    }
  }
  if (data.traceFunctions?.length > 0) {
    console.log(`\nDetected trace functions: ${data.traceFunctions.map(([n, c]) => n + '(' + c + ')').join(', ')}`);
  }
  const catKeys = Object.keys(data.eventCategories || {}).sort();
  if (catKeys.length > 0) {
    const total = Object.values(data.eventCategories).reduce((s, a) => s + a.length, 0);
    console.log(`\nTelemetry Events: ${total} events in ${catKeys.length} categories`);
    for (const prefix of catKeys) {
      console.log(`  ${prefix}_ (${data.eventCategories[prefix].length})`);
    }
  }
}

// Interactive mode: explicit --interactive OR auto when no command given
if (args.interactive) {
  doInteractive(index, args);
} else {
  // Check if any command was dispatched
  const anyCommand = [
    'stats', 'index_extensions',
    'search', 'literal', 'fast', 'regex', 'files_search', 'folders_search',
    'extract', 'list_files', 'show_file', 'list_functions',
    'list_functions_alpha', 'list_functions_size',
    'callers', 'callees', 'most_called',
    'call_tree', 'class_tree', 'call_inventory', 'file_map', 'file_tree',
    'hotspots', 'hot_folders', 'entry_points', 'gaps', 'domain_fns',
    'list_classes', 'class_hotspots', 'discover_vocabulary', 'multisect_search',
    'claim_search', 'claim_file',
    'analyze', 'claim_analyze', 'multisect_analyze', 'file_analyze',
    'dupefiles', 'func_dupes', 'near_dupes', 'struct_dupes', 'show_funcstring', 'struct_diff', 'struct_diff_all',
    'command_catalog', 'string_table', 'breadcrumbs',
  ].some(c => args._explicit.has(c) || args[c]);

  if (!anyCommand && !args.build_index) {
    // No command given, index is loaded — auto-enter interactive mode
    doInteractive(index, args);
  }
}
