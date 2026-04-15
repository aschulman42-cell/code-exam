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
  doExtract, doListFiles, doShowFile, doFileBookends, doBundleSeams,
  doListFunctions, doListFunctionsAlpha, doListFunctionsSize,
} from './commands/browse.js';
import { doDigest } from './commands/digest.js';
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
  doStringCallDupes, doStringCallDiffAll, doCmpStringCallDupes,
} from './commands/dedup.js';
import { doBuildFpRenames } from './commands/build_fp_renames.js';
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
    renameMinLines: args.rename_min_lines || 0,
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
    'extract', 'list_files', 'show_file', 'file_bookends', 'bundle_seams', 'index_extensions', 'interactive',
    'callers', 'callees', 'most_called', 'call_tree', 'call_inventory', 'file_map', 'file_tree',
    'hotspots', 'hot_folders', 'entry_points', 'gaps', 'domain_fns',
    'list_classes', 'class_hotspots', 'discover_vocabulary',
    'analyze', 'claim_analyze', 'multisect_analyze', 'file_analyze',
    'dupefiles', 'func_dupes', 'near_dupes', 'struct_dupes', 'show_funcstring', 'struct_diff', 'struct_diff_all',
    'string_call_dupes', 'string_call_diff_all', 'cmp_string_call_dupes', 'build_fp_renames',
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
// Build/refresh rename map for an existing index (no full rebuild)
// ========================================================================

if (args.build_rename_map) {
  const minFuncLines = args.rename_min_lines || 0;
  console.log(`Building rename map from ${index.files.size} loaded files` +
              (minFuncLines > 0 ? ` (skipping functions with <= ${minFuncLines} lines)` : '') + '...');
  const r = index.inferAndSaveRenameMap({ showProgress: true, minFuncLines });
  console.log(`Done: ${r.namesInferred + r.cmdRenames + r.importRenames} total renames written to ${index.indexPath}/rename_map.json`);
  // If only --build-rename-map (no other command), exit
  const queryCommands = [
    'search', 'literal', 'fast', 'regex', 'files_search', 'folders_search',
    'stats', 'list_functions', 'list_functions_alpha', 'list_functions_size',
    'extract', 'list_files', 'show_file', 'index_extensions', 'interactive',
    'callers', 'callees', 'most_called', 'call_tree', 'call_inventory', 'file_map', 'file_tree',
    'hotspots', 'hot_folders', 'entry_points', 'gaps', 'domain_fns',
    'list_classes', 'class_hotspots', 'discover_vocabulary',
    'analyze', 'claim_analyze', 'multisect_analyze', 'file_analyze',
    'dupefiles', 'func_dupes', 'near_dupes', 'struct_dupes', 'show_funcstring', 'struct_diff', 'struct_diff_all',
    'string_call_dupes', 'string_call_diff_all', 'cmp_string_call_dupes', 'build_fp_renames',
    'command_catalog', 'string_table', 'breadcrumbs', 'file_bookends', 'bundle_seams', 'digest',
  ];
  if (!queryCommands.some(c => args._explicit.has(c) || args[c])) {
    process.exit(0);
  }
}


// ========================================================================
// Dispatch commands
// ========================================================================

// --no-rename: disable display-time renames for all CLI output
if (args.no_rename) {
  index.applyRenames = (text) => text;
  index.getDisplayName = (name) => name || '';
  index.getOriginalName = (name) => name || '';
}

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
if (args._explicit.has('file_bookends'))    doFileBookends(index, args);
if (args._explicit.has('bundle_seams'))     doBundleSeams(index, args);
if (args.digest)                            doDigest(index, args);
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
if (args.string_call_dupes)                 doStringCallDupes(index, args);
if (args.string_call_diff_all)              doStringCallDiffAll(index, args);
if (args.cmp_string_call_dupes)             doCmpStringCallDupes(index, args);
if (args._explicit.has('build_fp_renames')) doBuildFpRenames(index, args);

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
  const filterPat = args.filter ? args.filter.toLowerCase() : null;
  const dnOf = (name) => (name && index.getDisplayName ? index.getDisplayName(name) : name) || name || '(file scope)';

  // --- Markers (execution flow) ---
  const markers = filterPat
    ? data.markers.filter(m => m.label.toLowerCase().includes(filterPat))
    : data.markers;
  if (markers.length > 0) {
    const filterNote = filterPat ? ` (filtered by "${args.filter}")` : '';
    console.log(`\nExecution Flow (${markers.length} trace markers${filterNote}):`);
    let lastPhase = '';
    for (const m of markers) {
      const phase = m.label.split('_')[0];
      if (phase !== lastPhase) {
        lastPhase = phase;
        console.log(`\n  --- ${phase.toUpperCase()} ---`);
      }
      const fn = m.func ? '  [' + dnOf(m.func) + ']' : '';
      console.log(`  ${String(m.line).padStart(6)}  ${m.label}${fn}`);
    }
  }

  if (data.traceFunctions?.length > 0) {
    console.log(`\nDetected trace functions: ${data.traceFunctions.map(([n, c]) => n + '(' + c + ')').join(', ')}`);
  }

  // --- Telemetry events ---
  const catKeys = Object.keys(data.eventCategories || {}).sort();
  if (catKeys.length > 0) {
    const allEvents = Object.values(data.eventCategories).flat();
    const filtered = filterPat
      ? allEvents.filter(e => e.name.toLowerCase().includes(filterPat))
      : allEvents;
    const filterNote = filterPat ? ` (${filtered.length} match "${args.filter}")` : '';
    console.log(`\nTelemetry Events: ${allEvents.length} total in ${catKeys.length} categor${catKeys.length === 1 ? 'y' : 'ies'}${filterNote}`);

    if (!args.verbose) {
      // Compact: category counts only (hint how to drill in)
      for (const prefix of catKeys) {
        const catFiltered = filterPat
          ? data.eventCategories[prefix].filter(e => e.name.toLowerCase().includes(filterPat))
          : data.eventCategories[prefix];
        if (catFiltered.length > 0) {
          console.log(`  ${prefix}_ (${catFiltered.length})`);
        }
      }
      if (allEvents.length > 0) {
        console.log(`\n  (Use --verbose to list events, or --filter PATTERN to narrow.`);
        console.log(`   --verbose adds both a per-category event list AND a per-function rollup.)`);
      }
    } else {
      // Verbose: per-category event list
      for (const prefix of catKeys) {
        const catEvents = filterPat
          ? data.eventCategories[prefix].filter(e => e.name.toLowerCase().includes(filterPat))
          : data.eventCategories[prefix];
        if (catEvents.length === 0) continue;
        console.log(`\n  ${prefix}_ (${catEvents.length} event${catEvents.length === 1 ? '' : 's'}):`);
        // Sort by filepath then line for deterministic output
        const sorted = [...catEvents].sort((a, b) =>
          a.filepath.localeCompare(b.filepath) || a.line - b.line);
        for (const ev of sorted) {
          const funcPart = ev.func ? `  [${dnOf(ev.func)}]` : '';
          console.log(`    ${ev.name.padEnd(42)}  ${ev.filepath}:${ev.line}${funcPart}`);
        }
      }

      // Per-function rollup — answers "which functions emit which events"
      const byFunc = new Map();
      for (const ev of filtered) {
        const fn = ev.func || '(file scope)';
        if (!byFunc.has(fn)) byFunc.set(fn, []);
        byFunc.get(fn).push(ev.name);
      }
      if (byFunc.size > 0) {
        console.log(`\nEvents by function (${byFunc.size} distinct functions):`);
        const sortedFns = [...byFunc.entries()]
          .sort((a, b) => b[1].length - a[1].length);
        for (const [fn, evs] of sortedFns) {
          const unique = [...new Set(evs)];
          const countLabel = unique.length === evs.length
            ? `${evs.length} event${evs.length === 1 ? '' : 's'}`
            : `${evs.length} event${evs.length === 1 ? '' : 's'}, ${unique.length} distinct`;
          const displayFn = fn === '(file scope)' ? fn : dnOf(fn);
          // Truncate very long event lists — full data is above in the per-category section
          const eventList = unique.length > 10
            ? unique.slice(0, 10).join(', ') + `, …+${unique.length - 10} more`
            : unique.join(', ');
          console.log(`  ${displayFn}  (${countLabel})`);
          console.log(`    ${eventList}`);
        }
      }
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
    'string_call_dupes', 'string_call_diff_all', 'cmp_string_call_dupes', 'build_fp_renames',
    'command_catalog', 'string_table', 'breadcrumbs', 'file_bookends', 'bundle_seams', 'digest',
  ].some(c => args._explicit.has(c) || args[c]);

  if (!anyCommand && !args.build_index) {
    // No command given, index is loaded — auto-enter interactive mode
    doInteractive(index, args);
  }
}
