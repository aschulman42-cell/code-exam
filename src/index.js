#!/usr/bin/env node
/**
 * code-exam - Air-Gapped Source Code Examination Tool (Node.js)
 *
 * CLI entry point. Zero external dependencies.
 * Compatible with Python version's JSON index format.
 */

import fs from 'fs';
import { spawnSync } from 'child_process';
import { parseArgs } from './argparse.js';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';
import { buildOverview, formatOverview } from './core/overview.js';
import { extractReferencedResources } from './core/referenced-resources.js';
import { MEDIA_BINARY_EXTENSIONS, ARCHIVE_EXTENSIONS, EXECUTABLE_EXTENSIONS } from './utils.js';
import { BINSTRING_EXTENSIONS } from './binstrings.js';
import {
  doSearch, doLiteral, doFast, doRegex,
  doFilesSearch, doFoldersSearch,
} from './commands/search.js';
import {
  doStats, doScanExtensions, doIndexExtensions, doListIndexes,
  doExtract, doListFiles, doShowFile, doFileBookends, doBundleSeams,
  doListFunctions, doListFunctionsAlpha, doListFunctionsSize,
} from './commands/browse.js';
import { doDigest, doCommentsOnly } from './commands/digest.js';
import { doExtractJsFromBinary } from './commands/extract_js_from_binary.js';
import { doInspectBinary } from './commands/inspect_binary.js';
import {
  doCallers, doCallees, doMostCalled, doCallInventory,
} from './commands/callers.js';
import {
  doCallTree, doClassTree, doFileMap, doFileTree,
} from './commands/graph.js';
import {
  doHotspots, doHotFolders, doEntryPoints, doGaps,
  doDomainFns, doListClasses, doDataStructs, doClientServer, doListModels, doListArtifacts, doListKernels, doListMultimodal, doListPostTraining, doListReasoning, doListDatasets, doListTraining, doListInference, doListLlmCalls, doListTools, doListChains, doListEmbeddings, doListStructuredOutput, doListModelsUsed, doListPipelines, doListExplainability, doClassHotspots, doVocabulary,
} from './commands/metrics.js';
import {
  doDupefiles, doFuncDupes, doNearDupes,
  doStructDupes, doShowFuncstring, doStructDiff, doStructDiffAll,
  doStringCallDupes, doStringCallDiffAll, doCmpStringCallDupes,
  doNotableFuncstrMatches, doFuncstrHashes, doFuncstrCorpus,
} from './commands/dedup.js';
import { doBuildFpRenames } from './commands/build_fp_renames.js';
import { doEmitHarness, doListHarnessable } from './commands/harness.js';
import { doCensusImports, doCensusImportsMulti } from './commands/census.js';
import { doExports, doEmitCatalog, doEmitCatalogMulti } from './commands/exports.js';
import { doImportsFrom } from './commands/imports-from.js';
import { doImports } from './commands/imports.js';
import { doInfrastructure } from './commands/infrastructure.js';
import { doSaveFingerprints } from './commands/fingerprint.js';
import { doInteractive } from './commands/interactive.js';
import { doMultisect } from './commands/multisect.js';
import { doClaimSearch } from './commands/claim.js';
import {
  doAnalyze, doClaimAnalyze, doMultisectAnalyze, doFileAnalyze,
} from './commands/analyze.js';


// ========================================================================
// --gui: launch the GUI server + open the user's browser.
// Detected from raw argv before parseArgs so server.js's own arg parser
// can re-consume process.argv with only the flags it understands.
// Designed to work both under `node` (dev) and `bun --compile`'d
// standalone exe (Clive's path). See #78.
// ========================================================================

const _rawArgvForGui = process.argv.slice(2);
if (_rawArgvForGui.includes('--gui')) {
  const _argAfter = (flag, fallback) => {
    const i = _rawArgvForGui.indexOf(flag);
    if (i < 0) return fallback;
    const v = _rawArgvForGui[i + 1];
    if (!v || v.startsWith('-')) return fallback;
    return v;
  };
  const port = _argAfter('--port', '8080');

  // Munge argv: server.js's parseServerArgs reads process.argv directly and
  // doesn't know about CLI flags like --build-index. Pass it only what it
  // understands.
  const _serverArgv = ['--port', port, '--host', '127.0.0.1'];
  for (const flag of ['--index-path', '--index', '--model-path', '--model', '--local-model', '--api-key', '--key', '--temperature']) {
    const v = _argAfter(flag, null);
    if (v !== null) _serverArgv.push(flag, v);
  }
  process.argv = [process.argv[0], process.argv[1], ..._serverArgv];

  // Open the user's default browser after a short delay so the server has
  // time to bind. Best-effort: if the open fails (no DE, locked-down VM),
  // the URL is logged by server.js and the user can paste it.
  const { spawn } = await import('child_process');
  const _guiUrl = `http://127.0.0.1:${port}/`;
  setTimeout(() => {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', _guiUrl], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [_guiUrl], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [_guiUrl], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch { /* user can read the URL from the server's startup banner */ }
  }, 1500);

  // server.js's top-level code starts the HTTP server on import.
  await import('./server.js');
  // Hold the process: the listening socket keeps the event loop alive, but
  // we still need to prevent fall-through to parseArgs() below (which would
  // see the munged argv and try to interpret --port as a CLI command).
  await new Promise(() => {});
}


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

if (args.extract_js_from_binary) {
  doExtractJsFromBinary(args);
  process.exit(0);
}

if (args.inspect_binary) {
  doInspectBinary(args);
  process.exit(0);
}


// ========================================================================
// --multi-index: fan the rest of the command across many indexes
// ========================================================================
//
// Issue #17 — #15's fan-out layer (layer 2). Runs before the single-index
// CodeSearchIndex construction below: when --multi-index is set we never
// build that index, we spawn one subprocess per index instead. Subprocess
// isolation (not in-process multi-load) keeps memory bounded for very large
// indexes (cf. #280) and stops one index's crash from aborting the run.

if (args.multi_index) {
  // --index-path and --multi-index are mutually exclusive in one run.
  if (args._explicit.has('index_path')) {
    process.stderr.write('Error: --multi-index and --index-path are mutually exclusive; use one or the other.\n');
    process.exit(1);
  }

  // @filelist: one index directory path per line (same convention as
  // --build-index). The leading @ is optional/tolerated.
  const listPath = args.multi_index.startsWith('@') ? args.multi_index.slice(1) : args.multi_index;
  let indexPaths;
  try {
    indexPaths = fs.readFileSync(listPath, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  } catch (err) {
    process.stderr.write(`Error: cannot read --multi-index file list '${listPath}': ${err.message}\n`);
    process.exit(1);
  }
  if (indexPaths.length === 0) {
    process.stderr.write(`Error: --multi-index file list '${listPath}' is empty.\n`);
    process.exit(1);
  }

  // --census-imports is a REDUCTION (one ranked table aggregated across
  // indexes), which the subprocess-concat fan-out below can't express.
  // Divert to an in-process sequential load → extract → aggregate loop
  // (#156). Census extraction is a cheap line scan, and per-index try/catch
  // inside keeps one bad index from aborting the run.
  if (args.census_imports) {
    const failures = doCensusImportsMulti(indexPaths, args);
    process.exit(failures ? 1 : 0);
  }

  // --exports --emit-catalog: reduce all indexes into ONE library-keyed
  // catalog file (#162). Same in-process divert as the census reduction.
  if (args._explicit.has('exports') && args.emit_catalog) {
    const failures = doEmitCatalogMulti(indexPaths, args);
    process.exit(failures ? 1 : 0);
  }

  // Pass through the remaining CLI args, dropping --multi-index and its value.
  const passthrough = [];
  const rawArgv = process.argv.slice(2);
  for (let i = 0; i < rawArgv.length; i++) {
    const a = rawArgv[i];
    if (a === '--multi-index') { i++; continue; }       // skip flag + its value
    if (a.startsWith('--multi-index=')) continue;        // skip --multi-index=val form
    passthrough.push(a);
  }

  let failures = 0;
  for (let idx = 0; idx < indexPaths.length; idx++) {
    const p = indexPaths[idx];
    // Live human progress on stderr (kept off stdout so capture/diff stays clean).
    process.stderr.write(`[multi-index] (${idx + 1}/${indexPaths.length}) ${p}\n`);
    process.stdout.write(`=== ${p} ===\n`);
    // CE_MULTI_INDEX signals the child to index-qualify its AI/ML command
    // headers (`----- <index> : <cmd> -----`) so a human scrolling stdout keeps
    // the index context. Env var (not argv) → invisible to passthrough +
    // multi_index_diff. See src/index.js AI/ML header block.
    const res = spawnSync(process.execPath, [process.argv[1], '--index-path', p, ...passthrough], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, CE_MULTI_INDEX: '1' },
    });
    if (res.status !== 0 || res.error) {
      failures++;
      process.stderr.write(`[multi-index] '${p}' exited with ${res.error ? res.error.message : 'status ' + res.status}\n`);
    }
  }
  process.stderr.write(`[multi-index] ran across ${indexPaths.length} index(es)${failures ? `, ${failures} failed` : ''}\n`);
  process.exit(failures ? 1 : 0);
}


// ========================================================================
// --overview-by-ai (#196): prose orientation written by Claude over CE's MCP
// ========================================================================
//
// Runs BEFORE the in-process index load below: the spawned mcp-server loads its
// own copy of the index, so loading it here too would double the cost on huge
// indexes (the whole point of pointing the MCP server at the dir). Non-air-
// gapped — shells out to the `claude` CLI. With --multi-index @list this runs
// per-index (each subprocess hits this branch), for overnight batch.
if (args.overview_by_ai) {
  const { runAiOverview } = await import('./core/ai-overview.js');
  const timeoutMs = (args.timeout && args.timeout > 0)
    ? args.timeout * 60000
    : (parseInt(process.env.CE_AI_OVERVIEW_TIMEOUT_MS, 10) || 1200000); // default 20 min (overnight-friendly)
  process.stderr.write(`[overview-by-ai] running claude over ${args.index_path} (timeout ${Math.round(timeoutMs / 60000)} min)…\n`);
  try {
    const prose = await runAiOverview({
      indexPath: args.index_path,
      model: args.claude_model || process.env.CE_AI_OVERVIEW_MODEL,
      timeoutMs,
      onStderr: (s) => { if (args.verbose) process.stderr.write(s); },
    });
    process.stdout.write(prose + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[overview-by-ai] ${e.message}\n`);
    process.exit(1);
  }
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

// --add-extensions: union onto the current set (custom or default) — additive,
// unlike --extensions which replaces. Lets you index .xmlui/.xs/.md on top of
// the defaults without re-listing every default extension.
if (args.add_extensions) {
  if (!customExtensions) {
    customExtensions = new Set(CodeSearchIndex.DEFAULT_EXTENSIONS);
  }
  for (let ext of args.add_extensions.split(',')) {
    ext = ext.trim().toLowerCase();
    if (!ext) continue;
    if (!ext.startsWith('.')) ext = '.' + ext;
    customExtensions.add(ext);
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
    splitBundle: args.split_bundle,
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

  // (skipped-files tip) Warn when the source has substantial files in extensions
  // we did NOT index, so silent omissions (e.g. .xmlui) are visible instead of
  // quietly dropped. Works for directory sources (scan the tree) AND archive/zip
  // sources (the builder tracks skipped extensions during expansion ->
  // buildStats.skippedExtensions). Best-effort; never fails the build.
  try {
    let census = null; // { ext: count } of files SKIPPED due to extension
    if (fs.existsSync(args.build_index) && fs.statSync(args.build_index).isDirectory()) {
      const counts = CodeSearchIndex.scanExtensions(args.build_index);
      const eff = index.extensions;
      census = {};
      for (const [ext, n] of Object.entries(counts)) {
        if (ext && ext !== '(no extension)' && !eff.has(ext)) census[ext] = n;
      }
    } else if (buildStats.skippedExtensions) {
      census = buildStats.skippedExtensions; // archive / zip source
    }
    if (census) {
      // Only suggest --add-extensions for plausibly-TEXT extensions. Media /
      // binary / archive / executable are skipped by design (indexing them as
      // text yields garbage; archives/exes are handled separately), so they're
      // mentioned for awareness but never recommended for --add-extensions.
      const isNonText = (ext) => MEDIA_BINARY_EXTENSIONS.has(ext)
        || ARCHIVE_EXTENSIONS.has(ext) || EXECUTABLE_EXTENSIONS.has(ext)
        || BINSTRING_EXTENSIONS.has(ext);
      const entries = Object.entries(census)
        .filter(([ext, n]) => ext && n >= 3)
        .sort((a, b) => b[1] - a[1]);
      const textSkipped = entries.filter(([ext]) => !isNonText(ext)).slice(0, 8);
      const mediaSkipped = entries.filter(([ext]) => MEDIA_BINARY_EXTENSIONS.has(ext)).slice(0, 8);
      if (textSkipped.length) {
        const list = textSkipped.map(([ext, n]) => `${ext} (${n})`).join(', ');
        const addList = textSkipped.map(([ext]) => ext).join(',');
        process.stderr.write(`\nNote: source files in these text extensions were NOT indexed:\n`);
        process.stderr.write(`      ${list}\n`);
        process.stderr.write(`      To include them, rebuild with: --add-extensions ${addList}\n`);
      }
      if (mediaSkipped.length) {
        const mlist = mediaSkipped.map(([ext, n]) => `${ext} (${n})`).join(', ');
        process.stderr.write(`      (Also present, skipped as binary/media — not indexed as text: ${mlist})\n`);
      }
    }
  } catch { /* best-effort tip; never break the build */ }

  // If only building (no other command), exit
  const queryCommands = [
    'overview', 'search', 'literal', 'fast', 'regex', 'files_search', 'folders_search',
    'stats', 'list_functions', 'list_functions_alpha', 'list_functions_size',
    'extract', 'list_files', 'show_file', 'file_bookends', 'bundle_seams', 'index_extensions', 'interactive',
    'callers', 'callees', 'most_called', 'call_tree', 'call_inventory', 'file_map', 'file_tree',
    'hotspots', 'hot_folders', 'entry_points', 'gaps', 'domain_fns',
    'list_classes', 'data_structs', 'client_server', 'list_models', 'list_artifacts', 'list_kernels', 'list_multimodal', 'list_post_training', 'list_reasoning', 'list_datasets', 'list_training', 'list_inference', 'list_llm_calls', 'list_tools', 'list_chains', 'list_embeddings', 'list_structured_output', 'list_models_used', 'list_pipelines', 'list_explainability', 'class_hotspots', 'discover_vocabulary',
    'analyze', 'claim_analyze', 'multisect_analyze', 'file_analyze',
    'dupefiles', 'func_dupes', 'near_dupes', 'struct_dupes', 'show_funcstring', 'struct_diff', 'struct_diff_all',
    'string_call_dupes', 'string_call_diff_all', 'cmp_string_call_dupes', 'notable_funcstr_matches', 'funcstr_hashes', 'funcstr_corpus', 'build_fp_renames',
    'save_fingerprints',
  ];
  if (!queryCommands.some(c => args._explicit.has(c) || args[c])) {
    process.exit(0);
  }
}


// ========================================================================
// Check we have an index for queries
// ========================================================================

if (index.files.size === 0 && !args.build_index) {
  // Detect invocation shape so the help text shows the right command.
  // - `node src/index.js ...` → execPath basename is `node`
  // - Bun --compile standalone (codeexam.exe) → execPath basename is the exe
  const _exeBase = (() => {
    try {
      const b = process.execPath.split(/[\\/]/).pop() || 'node';
      const lower = b.toLowerCase().replace(/\.exe$/, '');
      if (lower === 'node' || lower === 'bun' || lower === 'tsx') return 'node src/index.js';
      return b;
    } catch { return 'node src/index.js'; }
  })();
  console.log(`No index found at: ${args.index_path}`);
  console.log('Build one first (name the index with --index-path so you can reload it later):');
  console.log(`  ${_exeBase} --build-index ./your/source/directory --index-path .my_index`);
  console.log(`  ${_exeBase} --build-index "C:\\path\\to\\code" --index-path .my_index`);
  console.log(`  ${_exeBase} --build-index @filelist.txt --index-path .my_index`);
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
    'overview', 'search', 'literal', 'fast', 'regex', 'files_search', 'folders_search',
    'stats', 'list_functions', 'list_functions_alpha', 'list_functions_size',
    'extract', 'list_files', 'show_file', 'index_extensions', 'interactive',
    'callers', 'callees', 'most_called', 'call_tree', 'call_inventory', 'file_map', 'file_tree',
    'hotspots', 'hot_folders', 'entry_points', 'gaps', 'domain_fns',
    'list_classes', 'data_structs', 'client_server', 'list_models', 'list_artifacts', 'list_kernels', 'list_multimodal', 'list_post_training', 'list_reasoning', 'list_datasets', 'list_training', 'list_inference', 'list_llm_calls', 'list_tools', 'list_chains', 'list_embeddings', 'list_structured_output', 'list_models_used', 'list_pipelines', 'list_explainability', 'class_hotspots', 'discover_vocabulary',
    'analyze', 'claim_analyze', 'multisect_analyze', 'file_analyze',
    'dupefiles', 'func_dupes', 'near_dupes', 'struct_dupes', 'show_funcstring', 'struct_diff', 'struct_diff_all',
    'string_call_dupes', 'string_call_diff_all', 'cmp_string_call_dupes', 'notable_funcstr_matches', 'funcstr_hashes', 'funcstr_corpus', 'build_fp_renames',
    'save_fingerprints',
    'command_catalog', 'string_table', 'breadcrumbs', 'prompt_catalog', 'file_bookends', 'bundle_seams', 'digest',
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

// Run rename-map MUTATORS before any query that reads display names, so
// `--build-fp-renames --list-functions` in one command reflects the newly
// added _FP_ entries. The build-fp-renames code invalidates the index's
// in-memory rename cache so subsequent getDisplayName calls reload from
// the just-written rename_map.json.
if (args._explicit.has('build_fp_renames')) doBuildFpRenames(index, args);

if (args.overview)                          console.log(formatOverview(buildOverview(index)));
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
if (args.emit_harness)                      doEmitHarness(index, args);
if (args.list_harnessable)                  doListHarnessable(index, args);
if (args.census_imports)                    doCensusImports(index, args);
if (args._explicit.has('exports')) {
  if (args.emit_catalog) doEmitCatalog(index, args);   // --emit-catalog diverts to file
  else doExports(index, args);
}
if (args.imports_from)                      doImportsFrom(index, args);
if (args.imports)                           doImports(index, args);
if (args.infrastructure)                    doInfrastructure(index, args);
// Standalone --comments-only <target> (#61). The modifier form
// (--extract X --comments-only) is handled in browse.js — both forms
// coexist; only the standalone form has a string value, the modifier
// has the '.' sentinel from optional_value's flag-only branch.
if (typeof args.comments_only === 'string' && args.comments_only !== '.' && !args.extract) {
  doCommentsOnly(index, args);
}
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
if (args.data_structs)                      doDataStructs(index, args);
if (args.client_server)                     doClientServer(index, args);
if (args.referenced_resources) {
  // #203: the codebase's external surface (URLs/env/fs/sql/commands/cloud/models).
  const rr = extractReferencedResources(index);
  const max = args.max_results || 20;
  const filt = args.filter ? args.filter.toLowerCase() : null;
  // Optional subsection selection: --referenced-resources sql,env → only those.
  const RR_ALIASES = {
    network: 'network', urls: 'network', url: 'network',
    env: 'env', envvars: 'env', envvar: 'env', environment: 'env',
    files: 'files', 'fs-files': 'files',
    paths: 'paths', 'fs-paths': 'paths', routes: 'paths', dirs: 'paths',
    sql: 'sql', 'embed-sql': 'sql', 'embedded-sql': 'sql',
    commands: 'commands', cmds: 'commands', cmd: 'commands', cmdlines: 'commands', exec: 'commands', subprocess: 'commands',
    cloud: 'cloud', infra: 'cloud', infrastructure: 'cloud',
    models: 'models', model: 'models',
  };
  let want = null;
  const raw = typeof args.referenced_resources === 'string' ? args.referenced_resources : '';
  if (raw && raw !== '.') {
    want = new Set();
    const unknown = [];
    for (const tok of raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)) {
      if (RR_ALIASES[tok]) want.add(RR_ALIASES[tok]); else unknown.push(tok);
    }
    if (unknown.length) process.stderr.write(`[referenced-resources] unknown subsection(s): ${unknown.join(', ')}. Valid: network, env, files, paths, sql, commands, cloud, models\n`);
  }
  const pick = (arr, key) => (filt ? arr.filter(e => key(e).toLowerCase().includes(filt)) : arr).slice(0, max);
  const verbose = !!args.verbose;
  // First-site info: the source-line snippet (the actual usage, e.g. the full
  // `exec("git", […])`) when it adds info beyond the value, plus the location.
  const site = (e) => {
    const s = e.sites && e.sites[0];
    if (!s) return '';
    const snip = (s.snippet && s.snippet !== e.value) ? `  — ${s.snippet}` : '';
    return `${snip}  (${s.filepath}:${s.line})`;
  };
  const out = ["Referenced resources — the codebase's external surface:", ''];
  const section = (subKey, title, arr, fmt) => {
    if (want && !want.has(subKey)) return;     // subsection filter
    out.push(`${title} (${arr.length}):`);
    if (!arr.length) out.push('  (none)');
    else for (const e of arr) {
      out.push('  ' + fmt(e));
      // -v: list every captured site with its source line (the per-call specifics).
      if (verbose && e.sites && e.sites.length > 1) {
        for (const s of e.sites) out.push(`      ${s.filepath}:${s.line}${s.snippet ? '  ' + s.snippet : ''}`);
      }
    }
    out.push('');
  };
  const fsFiles = (rr.filesystem || []).filter(e => e.kind === 'file');
  const fsPaths = (rr.filesystem || []).filter(e => e.kind === 'path');
  section('network', 'Network (URLs)',         pick(rr.network, e => e.value),    e => `${e.count}×  ${e.value}${e.host ? '  [' + e.host + ']' : ''}${site(e)}`);
  section('env', 'Environment variables',      pick(rr.env, e => e.value),        e => `${e.count}×  ${e.value}${site(e)}`);
  section('files', 'Filesystem — files',       pick(fsFiles, e => e.value),       e => `${e.count}×  ${e.value}${site(e)}`);
  section('paths', 'Filesystem — paths/dirs',  pick(fsPaths, e => e.value),       e => `${e.count}×  ${e.value}${site(e)}`);
  section('sql', 'Embedded SQL',               pick(rr.sql, e => e.value),        e => `${e.count}×  ${e.value}${site(e)}`);
  section('commands', 'External commands',     pick(rr.subprocess, e => e.value), e => `${e.count}×  ${e.value}${site(e)}`);
  section('cloud', 'Cloud / infra',            pick(rr.cloud, e => e.cell + e.kind), e => `${e.count}×  ${e.cell}: ${e.kind}${e.tag === 'heuristic' ? ' ~' : ''}${site(e)}`);
  section('models', 'Models',                  pick(rr.models, e => e.model),     e => `${e.count}×  ${e.model}  [${e.access}]`);
  if ((!want || want.has('network')) && rr.hosts.length) out.push(`Distinct hosts (${rr.hosts.length}): ${rr.hosts.slice(0, 40).join(', ')}`);
  console.log(out.join('\n'));
}
// AI/ML detectors. When 2+ run together (e.g. `--multi-index` with several
// --cmds), print a blank line + a one-line `----- name -----` header before
// each so the outputs don't run together. A single-command run stays
// header-free (no behavior change). The marker is distinct from the
// `=== .index ===` multi-index banner, so multi_index_diff.py is unaffected.
const aiMlCmds = [
  ['list_models',     'models',     doListModels],
  ['list_artifacts',  'artifacts',  doListArtifacts],
  ['list_kernels',    'kernels',    doListKernels],
  ['list_multimodal', 'multimodal', doListMultimodal],
  ['list_post_training', 'post-training', doListPostTraining],
  ['list_reasoning',  'reasoning',  doListReasoning],
  ['list_datasets',   'datasets',   doListDatasets],
  ['list_training',   'training',   doListTraining],
  ['list_inference',  'inference',  doListInference],
  ['list_llm_calls',  'llm-calls',  doListLlmCalls],
  ['list_tools',      'tools',      doListTools],
  ['list_chains',     'chains',     doListChains],
  ['list_embeddings', 'embeddings', doListEmbeddings],
  ['list_structured_output', 'structured-output', doListStructuredOutput],
  ['list_models_used', 'models-used', doListModelsUsed],
  ['list_pipelines', 'pipelines', doListPipelines],
  ['list_explainability', 'explainability', doListExplainability],
];
const activeAiMl = aiMlCmds.filter(([flag]) => args[flag]);
// Under --multi-index (CE_MULTI_INDEX set by the parent), prefix the per-command
// header with the index name so a human scrolling stdout keeps the context:
// `----- .mistral_from_gh : models -----`. Standalone runs stay `----- models -----`.
const idxTag = process.env.CE_MULTI_INDEX
  ? `${(args.index_path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()} : `
  : '';
for (const [, label, fn] of activeAiMl) {
  if (activeAiMl.length > 1) console.log(`\n----- ${idxTag}${label} -----`);
  fn(index, args);
}
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
if (args.notable_funcstr_matches)           doNotableFuncstrMatches(index, args);
if (args.funcstr_hashes)                    doFuncstrHashes(index, args);
if (args.funcstr_corpus)                    doFuncstrCorpus(index, args);
// (build_fp_renames moved earlier — runs before query commands so its
// rename-map updates are visible to --list-functions etc.)
if (args.save_fingerprints)                 doSaveFingerprints(index, args);

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

if (args.prompt_catalog) {
  const { doPromptCatalog } = await import('./commands/prompts.js');
  await doPromptCatalog(index, args);
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
    'overview', 'search', 'literal', 'fast', 'regex', 'files_search', 'folders_search',
    'extract', 'list_files', 'show_file', 'list_functions',
    'list_functions_alpha', 'list_functions_size',
    'callers', 'callees', 'most_called',
    'call_tree', 'class_tree', 'call_inventory', 'file_map', 'file_tree',
    'hotspots', 'hot_folders', 'entry_points', 'gaps', 'domain_fns',
    'list_classes', 'data_structs', 'client_server', 'referenced_resources', 'list_models', 'list_artifacts', 'list_kernels', 'list_multimodal', 'list_post_training', 'list_reasoning', 'list_datasets', 'list_training', 'list_inference', 'list_llm_calls', 'list_tools', 'list_chains', 'list_embeddings', 'list_structured_output', 'list_models_used', 'list_pipelines', 'list_explainability', 'class_hotspots', 'discover_vocabulary', 'multisect_search',
    'claim_search', 'claim_file',
    'analyze', 'claim_analyze', 'multisect_analyze', 'file_analyze',
    'dupefiles', 'func_dupes', 'near_dupes', 'struct_dupes', 'show_funcstring', 'struct_diff', 'struct_diff_all',
    'string_call_dupes', 'string_call_diff_all', 'cmp_string_call_dupes', 'notable_funcstr_matches', 'funcstr_hashes', 'funcstr_corpus', 'build_fp_renames',
    'save_fingerprints',
    'command_catalog', 'string_table', 'breadcrumbs', 'prompt_catalog', 'file_bookends', 'bundle_seams', 'digest',
    'comments_only', 'emit_harness', 'list_harnessable', 'census_imports', 'exports', 'imports_from', 'imports', 'infrastructure',
  ].some(c => args._explicit.has(c) || args[c]);

  if (!anyCommand && !args.build_index) {
    // No command fired. Two reasons this can happen:
    //   (a) user gave only --index-path to explore → auto-enter the REPL
    //   (b) user mistyped a flag, so no command matched → DON'T silently
    //       open the REPL (script-/agent-hostile: hangs on stdin). Report
    //       the unknown flag(s), suggest the closest match, exit non-zero.
    // #69.
    if (args._unknownFlags && args._unknownFlags.length > 0) {
      for (const { token, suggestion } of args._unknownFlags) {
        process.stderr.write(
          suggestion
            ? `Unknown option '${token}'. Did you mean '${suggestion}'?\n`
            : `Unknown option '${token}'.\n`
        );
      }
      process.stderr.write('No command run. Use --help to see available options, or -i to explore interactively.\n');
      process.exit(2);
    }
    // No command given, index is loaded — auto-enter interactive mode
    doInteractive(index, args);
  }
}
