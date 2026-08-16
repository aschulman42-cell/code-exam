#!/usr/bin/env node
/**
 * code-exam - Air-Gapped Source Code Examination Tool (Node.js)
 *
 * CLI entry point. Zero external dependencies.
 * Compatible with Python version's JSON index format.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { parseArgs, printBanner } from './argparse.js';
import { setAirGapped, scrubApiKey, airGappedStartupCheck, AIR_GAPPED_DISCLAIMER } from './core/air-gapped.js';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';
import { buildOverview, formatOverview } from './core/overview.js';
import { TOURS } from '../public/tours.js';
import { extractReferencedResources } from './core/referenced-resources.js';
import { MEDIA_BINARY_EXTENSIONS, ARCHIVE_EXTENSIONS, EXECUTABLE_EXTENSIONS } from './utils.js';
import { BINSTRING_EXTENSIONS } from './binstrings.js';
import { skippedExtensionCensus } from './core/extension-census.js';
import { buildProvenanceHeader, sanitizedCommandLine } from './core/provenance.js';
import { CE_VERSION } from './version.js';
import { resolveProvider } from './core/providers.js';
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
import { doPseudoClaims } from './commands/pseudo-claims.js';
import {
  doAnalyze, doClaimAnalyze, doMultisectAnalyze, doFileAnalyze,
} from './commands/analyze.js';


// How the user invoked CE, for help/example lines: the standalone exe basename,
// else `node src/index.js`. (Run via the `ce` / `CodeExam` launchers, execPath
// is still `node`, so examples show `node src/index.js` — same as before.)
function exeBase() {
  try {
    // The ce / CodeExam launchers export this as how the user actually invoked
    // CodeExam, so help/welcome text reads `ce` rather than `node src/index.js`.
    if (process.env.CODEEXAM_INVOKED_AS) return process.env.CODEEXAM_INVOKED_AS;
    const b = process.execPath.split(/[\\/]/).pop() || 'node';
    const lower = b.toLowerCase().replace(/\.exe$/, '');
    if (lower === 'node' || lower === 'bun' || lower === 'tsx') return 'node src/index.js';
    return b;
  } catch { return 'node src/index.js'; }
}


// #230 Part B: absolute path to the bundled first-run demo index — a `.zip` CE
// loads via resolveIndexDir, sitting at the repo root next to src/.
function firstRunIndexZip() {
  return path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'FIRST_RUN_INDEX.zip');
}

// #249: point a no-index query run at the bundled demo, with a notice on BOTH
// stderr AND stdout — so a query from the wrong directory (e.g. output piped to
// a file with stderr discarded) can't be mistaken for a real result about the
// user's own code. Returns true if the demo was substituted. A user-supplied
// index (explicit path or a `.code_search_index` in cwd) always wins.
function useDemoIndexIfNeeded(args) {
  if (args._explicit.has('index_path') || args.build_index) return false;
  if (fs.existsSync(args.index_path)) return false;
  if (!fs.existsSync(firstRunIndexZip())) return false;
  args.index_path = firstRunIndexZip();
  const notice = "NOTE: No index found in this directory — using CodeExam's bundled DEMO "
    + "index (Hunch + sample harnesses), NOT your code. Pass --index-path <dir>, or build "
    + "one with --build-index.";
  process.stderr.write(notice + '\n\n');
  return true;
}

// Command keys that count as "the user asked CodeExam to do something" — used
// both to dispatch (the `anyCommand` check) and to decide whether a no-index
// invocation should run against the bundled demo (#230 Part B). Keep in sync.
const _QUERY_COMMAND_KEYS = [
  'stats', 'index_extensions',
  'overview', 'search', 'literal', 'fast', 'regex', 'files_search', 'folders_search',
  'extract', 'list_files', 'show_file', 'list_functions',
  'list_functions_alpha', 'list_functions_size',
  'callers', 'callees', 'most_called',
  'call_tree', 'class_tree', 'call_inventory', 'file_map', 'file_tree',
  'hotspots', 'hot_folders', 'entry_points', 'gaps', 'domain_fns',
  'list_classes', 'data_structs', 'client_server', 'referenced_resources', 'list_models', 'list_artifacts', 'list_kernels', 'list_multimodal', 'list_post_training', 'list_reasoning', 'list_datasets', 'list_training', 'list_inference', 'list_llm_calls', 'list_tools', 'list_chains', 'list_embeddings', 'list_structured_output', 'list_models_used', 'list_pipelines', 'list_explainability', 'class_hotspots', 'discover_vocabulary', 'multisect_search',
  'claim_search', 'claim_file', 'pseudo_claims', 'candidates', 'ground_truth', 'rank',
  'analyze', 'claim_analyze', 'claim_chart', 'claim_locate', 'claims_loop', 'multisect_analyze', 'file_analyze',
  'dupefiles', 'func_dupes', 'near_dupes', 'struct_dupes', 'show_funcstring', 'struct_diff', 'struct_diff_all',
  'string_call_dupes', 'string_call_diff_all', 'cmp_string_call_dupes', 'notable_funcstr_matches', 'funcstr_hashes', 'funcstr_corpus', 'build_fp_renames',
  'save_fingerprints',
  'command_catalog', 'string_table', 'breadcrumbs', 'prompt_catalog', 'file_bookends', 'bundle_seams', 'digest',
  'comments_only', 'emit_harness', 'list_harnessable', 'census_imports', 'exports', 'imports_from', 'imports', 'infrastructure',
];

// #249: index-MUTATING commands. They ARE real commands (so a no-index run must
// not show the first-run welcome and exit 0 as a silent no-op), but they must
// NOT auto-run against the bundled demo — they fall through to their handler,
// which errors on a missing index. Kept separate from _QUERY_COMMAND_KEYS,
// which drives the demo autoload.
const _MUTATING_COMMAND_KEYS = ['rebuild_functions', 'build_rename_map'];

// #252: the "did the user ALSO ask for something?" gates after --build-index
// and --build-rename-map used to carry two hand-copied snapshots of
// _QUERY_COMMAND_KEYS that had drifted (missing claim_search, digest, exports,
// command_catalog, multisect_search, …) — those combos built the index, then
// exited 0 WITHOUT running the requested command. Derive from the canonical
// lists so new commands can't fall out of sync again. (--gui/--tour dispatch
// before the build and don't need to be here.)
const _POST_BUILD_CONTINUE_KEYS =
  [..._QUERY_COMMAND_KEYS, ..._MUTATING_COMMAND_KEYS, 'interactive'];


// ========================================================================
// --gui: launch the GUI server + open the user's browser.
// Detected from raw argv before parseArgs so server.js's own arg parser
// can re-consume process.argv with only the flags it understands.
// Designed to work both under `node` (dev) and `bun --compile`'d
// standalone exe (Clive's path). See #78.
// ========================================================================

// Parsed here (before the GUI launch path) so `--gui`/`--tour` are recognized
// flags and so this path gets the same unknown-flag validation the CLI path has.
// `--tour` as a real flag (args.tour) is distinct from `--tour` appearing as
// another flag's VALUE, e.g. `--literal "--tour"` (#249).
const args = parseArgs();
const _rawArgvForGui = process.argv.slice(2);
const _wantsTour = !!args.tour;
if (args.gui || _wantsTour) {
  // Boolean flags the GUI both ACCEPTS (the validation block below) and FORWARDS
  // to server.js (the argv munge further down). Declared here, in the scope both
  // need, because acceptance without forwarding is a SILENT failure: the flag is
  // taken, dropped, and the run looks like it worked. That is exactly what
  // shipped in 1b57947 — `--flash-attention` went into the accept set and not the
  // forward loop, so `--gui` took it and still allocated at 8192 (asus-CC, F67
  // test B). One list makes forwarding the default; `--gui` and `--tour` are the
  // explicit non-forwarded exceptions, added to the accept set only.
  const _GUI_BOOL_FORWARD = ['--air-gapped', '--allow-connected', '--reproducible', '--provenance', '--flash-attention'];

  // #247: validate every --flag against the set this GUI launch path understands
  // and fail closed on an unknown one. Previously unrecognized flags were silently
  // dropped, so a typo like `--air-gaped` launched a CONNECTED GUI with the
  // air-gap flag quietly ignored. parseArgs's own unknown-flag check can't stand
  // in here: --gui legitimately accepts server-only flags (e.g. --context-size)
  // that the CLI parser rejects.
  {
    const _GUI_BOOL = new Set(['--gui', '--tour', ..._GUI_BOOL_FORWARD]);
    const _GUI_VALUE = new Set(['--port', '--index-path', '--index', '--load-index', '--model-path', '--model', '--local-model', '--api-key', '--key', '--claude-model', '--temperature', '--context-size', '--openai-key', '--openai-model', '--llm']);
    const _unknown = [];
    for (let i = 0; i < _rawArgvForGui.length; i++) {
      let tok = _rawArgvForGui[i];
      if (!tok.startsWith('--')) continue;
      if (tok.includes('=')) tok = tok.slice(0, tok.indexOf('='));
      const norm = tok.replace(/_/g, '-');
      if (_GUI_VALUE.has(norm)) {
        const v = _rawArgvForGui[i + 1];
        if (v && !v.startsWith('-')) i++;      // consume its value
        continue;
      }
      if (_GUI_BOOL.has(norm)) {
        if (norm === '--tour') { const v = _rawArgvForGui[i + 1]; if (v && !v.startsWith('-')) i++; } // optional name
        continue;
      }
      _unknown.push(tok);
    }
    if (_unknown.length) {
      printBanner(process.stderr);
      for (const tok of _unknown) {
        const n = tok.replace(/_/g, '-').toLowerCase();
        const hint = /air|gap/.test(n) ? " Did you mean '--air-gapped'?"
          : /allow|connect/.test(n) ? " Did you mean '--allow-connected'?" : '';
        process.stderr.write(`\nUnknown option '${tok}' with --gui.${hint}\n`);
      }
      process.stderr.write(`Run '${exeBase()} --help' for usage.\n`);
      process.exit(2);
    }
  }
  // #239: this raw-argv scan bypasses parseArgs's normalization, so match flags
  // in either spelling (`_`/`-` interchangeable) — `--index_path` resolves the
  // same as `--index-path` here too.
  const _argAfter = (flag, fallback) => {
    const i = _rawArgvForGui.findIndex(t => t.replace(/_/g, '-') === flag);
    if (i < 0) return fallback;
    const v = _rawArgvForGui[i + 1];
    if (!v || v.startsWith('-')) return fallback;
    return v;
  };
  const port = _argAfter('--port', '8080');
  // --tour [name]: launch the GUI and start the named guided tour once the page
  // loads (default 'first-run'). The name rides in the URL as ?tour=<name>,
  // which the GUI reads in initMenuBar; `ce --tour` alone works (no --gui).
  const _tourName = _wantsTour ? _argAfter('--tour', 'first-run') : null;
  // Validate the tour name against the shared registry before launching, so a
  // typo (`ce --tour bogus`) fails fast with the valid names instead of opening
  // the browser on a tour that doesn't exist.
  if (_tourName && !Object.keys(TOURS).includes(_tourName)) {
    process.stderr.write(`\nNo such tour "${_tourName}". Available: ${Object.keys(TOURS).join(', ')}\n\n`);
    process.exit(1);
  }

  // Munge argv: server.js's parseServerArgs reads process.argv directly and
  // doesn't know about CLI flags like --build-index. Pass it only what it
  // understands.
  const _serverArgv = ['--port', port, '--host', '127.0.0.1'];
  // --index-path / --index are REPEATABLE (server.js loads every occurrence
  // into its index manager); forward all of them, not just the first.
  for (const flag of ['--index-path', '--index', '--load-index']) {
    for (let i = 0; i < _rawArgvForGui.length; i++) {
      if (_rawArgvForGui[i].replace(/_/g, '-') === flag) {
        const v = _rawArgvForGui[i + 1];
        // #249: --load-index is a documented --index-path alias, but the GUI
        // server's parseServerArgs only knows --index-path/--index — forward it
        // as --index-path so the named index actually reaches the server.
        if (v && !v.startsWith('-')) _serverArgv.push(flag === '--load-index' ? '--index-path' : flag, v);
      }
    }
  }
  for (const flag of ['--model-path', '--model', '--local-model', '--api-key', '--key', '--claude-model', '--temperature', '--context-size', '--openai-key', '--openai-model', '--llm']) {
    const v = _argAfter(flag, null);
    if (v !== null) _serverArgv.push(flag, v);
  }
  // #230 Part B: first-run GUI — if no index path was given and the default
  // index isn't present, point the server at the bundled demo index so `--gui`
  // on a fresh download lands on a populated UI (its Overview auto-pops).
  const _gaveIndexForGui = ['--index-path', '--index', '--load-index'].some(f => _argAfter(f, null) !== null);
  if (!_gaveIndexForGui && !fs.existsSync('.code_search_index')) {
    const _frzGui = firstRunIndexZip();
    if (fs.existsSync(_frzGui)) _serverArgv.push('--index-path', _frzGui);
  }
  // #223: forward the boolean flags to the GUI server.
  // #239: accept either spelling (`--air_gapped` == `--air-gapped`).
  for (const _f of _GUI_BOOL_FORWARD) {
    if (_rawArgvForGui.some(t => t.replace(/_/g, '-') === _f)) _serverArgv.push(_f);
  }
  process.argv = [process.argv[0], process.argv[1], ..._serverArgv];

  // Open the user's default browser after a short delay so the server has
  // time to bind. Best-effort: if the open fails (no DE, locked-down VM),
  // the URL is logged by server.js and the user can paste it.
  const { spawn } = await import('child_process');
  const _guiUrl = `http://127.0.0.1:${port}/${_tourName ? `?tour=${encodeURIComponent(_tourName)}` : ''}`;
  printBanner();
  console.log(`\nStarting the CodeExam GUI → ${_guiUrl}  (opening your browser)…`);
  if (_tourName) console.log(`  Will start the "${_tourName}" guided tour once the page loads.`);
  console.log(`  Load or build an index in the GUI (Index menu / Indexes accordion). Use --port to change the port.\n`);
  setTimeout(() => {
    try {
      // A missing binary surfaces as an async 'error' event on the child,
      // not a throw — without a handler it crashes the whole process
      // (hit on headless Linux, where xdg-open doesn't exist).
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', _guiUrl], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [_guiUrl], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      } else {
        spawn('xdg-open', [_guiUrl], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
      }
    } catch { /* user can read the URL from the server's startup banner */ }
  }, 1500);

  // server.js's top-level code starts the HTTP server on import. The GUI/MCP
  // server needs npm dependencies (@modelcontextprotocol/sdk, etc.) that the
  // bare CLI doesn't — a fresh download has no node_modules, so this import
  // rejects at ESM link time. Catch that and print an actionable message
  // instead of a raw ERR_MODULE_NOT_FOUND stack trace. #230.
  try {
    await import('./server.js');
  } catch (e) {
    const missingDep = e && (e.code === 'ERR_MODULE_NOT_FOUND'
      || /Cannot find (?:package|module)/.test(e.message || ''));
    if (missingDep) {
      const pkg = (/Cannot find (?:package|module) '([^']+)'/.exec(e.message || '') || [])[1];
      process.stderr.write(
        `\nThe CodeExam GUI needs dependencies that aren't installed yet` +
        (pkg ? ` (missing: ${pkg}).` : `.`) + `\n\n` +
        `  Run:  npm install\n\n` +
        `npm install reads package.json (shipped with CodeExam) and fetches the\n` +
        `packages listed there, so run it from the CodeExam folder.\n\n` +
        `Then re-run:  ${exeBase()} --gui\n\n` +
        `The command-line tools (search, --build-index, --overview, …) work\n` +
        `without this; the GUI and MCP server need the npm packages.\n`);
      process.exit(1);
    }
    throw e;
  }
  // Hold the process: the listening socket keeps the event loop alive, but
  // we still need to prevent fall-through to parseArgs() below (which would
  // see the munged argv and try to interpret --port as a CLI command).
  await new Promise(() => {});
}


// ========================================================================
// Parse arguments — parsed above (before the --gui/--tour launch path so that
// path gets the same unknown-flag validation as the CLI path). (#247)
// ========================================================================


// ========================================================================
// Reject bad CLI input BEFORE loading an index, so a typo isn't masked by
// "No index found". Banner (stderr) + error(s) + run-help hint, exit 2.
// ========================================================================

if (args._unknownFlags.length || args._unknownPositionals.length) {
  printBanner(process.stderr);
  for (const { token, suggestion } of args._unknownFlags) {
    process.stderr.write(suggestion
      ? `\nUnknown option '${token}'. Did you mean '${suggestion}'?\n`
      : `\nUnknown option '${token}'.\n`);
  }
  for (const token of args._unknownPositionals) {
    process.stderr.write(`\nUnexpected argument '${token}'.\n`);
  }
  process.stderr.write(`Run 'ce --help' for usage.\n`);
  process.exit(2);
}


// ========================================================================
// #223: --air-gapped — block all cloud AI this run. Set the process flag,
// scrub the key, print the CYA disclaimer, and (unless --allow-connected)
// refuse if the internet is actually reachable.
// ========================================================================

if (args.air_gapped) {
  setAirGapped(true, { allowConnected: args.allow_connected });
  scrubApiKey();
  process.stderr.write(AIR_GAPPED_DISCLAIMER + '\n');
  const _refusal = await airGappedStartupCheck();
  if (_refusal) { process.stderr.write(`[air-gapped] ${_refusal}\n`); process.exit(2); }
}


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

// HOF-b. Dispatched HERE, before any index is constructed, and that placement is
// the point rather than an optimisation: --synonymize must rewrite a claim
// without ever seeing the code it will later be searched against. Withholding
// the code is the mechanism by which the vocabulary gap is manufactured, so the
// command is made structurally incapable of reaching an index instead of merely
// being trusted not to.
if (args.synonymize) {
  const { doSynonymize } = await import('./commands/synonymize.js');
  await doSynonymize(args);
  process.exit(process.exitCode || 0);
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
    // #239: match either spelling (`_`/`-` interchangeable) so `--multi_index`
    // is dropped too — otherwise each child gets both --index-path and the
    // leftover flag and dies on the mutual-exclusivity check. (Compare a
    // normalized copy; push the original token so values stay byte-for-byte.)
    const aFlag = a.replace(/_/g, '-');
    if (aFlag === '--multi-index') { i++; continue; }   // skip flag + its value
    if (aFlag.startsWith('--multi-index=')) continue;    // skip --multi-index=val form
    passthrough.push(a);
  }

  let failures = 0;
  for (let idx = 0; idx < indexPaths.length; idx++) {
    const p = indexPaths[idx];
    // Live human progress on stderr (kept off stdout so capture/diff stays clean).
    process.stderr.write(`[multi-index] (${idx + 1}/${indexPaths.length}) ${p}\n`);
    process.stdout.write(`\n=== ${p} ===\n\n`);
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
  // CLI-only, short-lived process: silence the DEP0190 warning from the
  // shell:true `claude` spawn so it doesn't pollute saved/--multi-index output.
  process.noDeprecation = true;
  // #249: first-run parity — with no index in cwd, fall back to the bundled demo
  // (like --overview) instead of erroring and naming the internal default path.
  useDemoIndexIfNeeded(args);
  // Validate --grounding so a typo (e.g. `--grounding foobly`) fails loudly
  // instead of silently falling back to grounded — otherwise you can't tell the
  // modes are wired up (#196).
  const GROUNDING_MODES = ['grounded', 'augmented', 'attributed'];
  if (args.grounding && !GROUNDING_MODES.includes(args.grounding)) {
    process.stderr.write(`[overview-by-ai] invalid --grounding "${args.grounding}" — use one of: ${GROUNDING_MODES.join(', ')}\n`);
    process.exit(1);
  }
  const grounding = args.grounding || 'grounded';
  // Pre-flight: never spawn the LLM against a missing/empty index — a path typo
  // otherwise spends real $ for a "this index is empty" non-answer (e.g. a wrong
  // cwd cost $0.29). Cheap marker check (literal_index.json — the same signal
  // --indexes uses); NO full load (a big index takes ~98s to load). Zip-path
  // sources are left to the engine. (#overview-preflight-index-check)
  const _idxArg = args.index_path;
  if (!/\.zip$/i.test(_idxArg) && !fs.existsSync(`${_idxArg.replace(/[\\/]+$/, '')}/literal_index.json`)) {
    process.stderr.write(`[overview-by-ai] No CodeExam index at "${_idxArg}" (no literal_index.json — check the path / cwd). Not calling the LLM.\n`);
    process.exit(1);
  }
  const timeoutMs = (args.timeout && args.timeout > 0)
    ? args.timeout * 60000
    : (parseInt(process.env.CE_AI_OVERVIEW_TIMEOUT_MS, 10) || 1200000); // default 20 min (overnight-friendly)
  const startedAt = Date.now();
  const mins = Math.round(timeoutMs / 60000);
  // Engine: --model <gguf> selects the local node-llama-cpp engine (air-gapped,
  // #196 spike); --llm openai|chatgpt the OpenAI API (#243 Part B, with
  // --openai-model / --openai-key); otherwise the Anthropic API
  // (--claude-model picks the API model).
  const localGguf = args.model || null;
  // #246: resolve the cloud engine through the provider registry instead of
  // the old `=== 'openai' ? openai : claude` binary, which silently routed
  // anything non-openai (including gemini) to Claude. --llm is already
  // validated by argparse; an empty value returns the deliberate Claude
  // default. claude / openai / gemini are all wired via runAiOverview.
  let cloudEngine = 'claude';
  if (!localGguf) cloudEngine = resolveProvider(args.llm).provider.id;
  const engineLabel = localGguf ? `local ${localGguf.split(/[\\/]/).pop()}${args.cpu ? ' (CPU)' : ''}` : cloudEngine;
  process.stderr.write(`[overview-by-ai] running ${engineLabel}, grounding=${grounding}, over ${args.index_path} (timeout ${mins} min)…\n`);
  // Heartbeat: the run can take minutes with no output (prose prints only at the
  // end), so emit a sign of life every 20s. stderr-only — stdout stays pure
  // prose so --multi-index capture isn't polluted.
  const heartbeat = setInterval(() => {
    process.stderr.write(`[overview-by-ai] still working… ${Math.round((Date.now() - startedAt) / 1000)}s elapsed (timeout ${mins} min)\n`);
  }, 20000);
  if (heartbeat.unref) heartbeat.unref();
  // --cost / --no-cost (#llm-cost-display): cost/usage shows by default for the
  // paid claude engine; --no-cost suppresses it (e.g. clean captured output).
  // Always stderr — stdout stays pure prose for --multi-index capture.
  const showCost = !args.no_cost;
  const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  try {
    let prose, costSuffix = '';
    if (localGguf) {
      const { runAiOverviewLocal } = await import('./core/ai-overview-local.js');
      let outTokens, achievedContext;
      ({ prose, outTokens, contextSize: achievedContext } = await runAiOverviewLocal({
        indexPath: args.index_path,
        modelPath: localGguf,
        timeoutMs,
        grounding, // grounded (default) | augmented | attributed (#196)
        contextSize: args.context_size || undefined, // #276: --context-size (default 16384; investigator-class models want 24576)
        flashAttention: !!args.flash_attention, // --flash-attention: frees 0.5-2.3 GB for the KV cache; off by default (experimental upstream)
        liveTodayDate: !!args.live_today_date, // F58: pin `Today Date:` by default — a code index has no today
        gpu: args.cpu ? false : 'auto', // --cpu forces CPU; else GPU with CPU fallback on OOM
        // model-load / CPU-fallback notes always show; per-tool chatter is verbose-only.
        onStatus: (s) => { if (args.verbose || !s.startsWith('tool ')) process.stderr.write(`[overview-by-ai] ${s}\n`); },
        // -v also streams the live model output (incl. <think>) to stderr for testing.
        onStream: args.verbose ? (c) => process.stderr.write(c) : undefined,
      }));
      // Air-gapped: no $ — just the output token count.
      if (showCost && outTokens) costSuffix = ` (${kTok(outTokens)} tokens out · local, no API cost)`;
      // runAiOverviewLocal walks a context ladder (--context-size at its head,
      // then 16384 → 8192 → 4096 → 2048) and swallows every allocation failure.
      // The achieved size drives the MCP tool budget (8192 → 11480 chars,
      // 24576 → 48200), so a run that quietly landed lower can spend its whole
      // budget investigating and have nothing left to write the overview with.
      // The GUI has always reported this; the CLI discarded it, which made that
      // failure undiagnosable from the command line. stderr only — stdout stays
      // pure prose for --multi-index capture.
      if (achievedContext) costSuffix += ` [context: ${achievedContext}]`;
    } else {
      const { runAiOverview } = await import('./core/ai-overview.js');
      // Cloud key resolution: --api-key applies to the SELECTED provider, then
      // the provider-specific flag / env / key file (mirrors the server). The
      // Claude branch previously forwarded nothing and hard-required the env var,
      // so a --api-key / claude.txt-only setup failed Overview while Chat/Analyze
      // worked (#243B parity fix).
      let cloudKey = '';
      if (cloudEngine === 'openai') {
        cloudKey = args.openai_key || args.api_key || process.env.OPENAI_API_KEY || '';
        if (!cloudKey) {
          for (const fname of ['openai.txt', 'openai_key.txt']) {
            try { const k = fs.readFileSync(fname, 'utf-8').trim(); if (k) { cloudKey = k; break; } } catch { /* ignore */ }
          }
        }
      } else if (cloudEngine === 'gemini') {   // #246
        cloudKey = args.gemini_key || args.api_key || process.env.GEMINI_API_KEY || '';
        if (!cloudKey) {
          for (const fname of ['gemini.txt', 'gemini_key.txt']) {
            try { const k = fs.readFileSync(fname, 'utf-8').trim(); if (k) { cloudKey = k; break; } } catch { /* ignore */ }
          }
        }
      } else {
        cloudKey = args.api_key || process.env.ANTHROPIC_API_KEY || '';
        if (!cloudKey) {
          for (const fname of ['claude.txt', 'claude_key.txt']) {
            try { const k = fs.readFileSync(fname, 'utf-8').trim(); if (k) { cloudKey = k; break; } } catch { /* ignore */ }
          }
        }
      }
      let costUsd, usage;
      ({ prose, costUsd, usage } = await runAiOverview({
        indexPath: args.index_path,
        engine: cloudEngine,
        apiKey: cloudKey,
        model: cloudEngine === 'openai'
          ? (args.openai_model || process.env.CE_OPENAI_MODEL)
          : cloudEngine === 'gemini'
          ? (args.gemini_model || null)
          : (args.claude_model || process.env.CE_AI_OVERVIEW_MODEL),
        timeoutMs,
        grounding, // grounded (default) | augmented | attributed (#196)
        maxBudgetUsd: args.max_budget_usd != null ? parseFloat(args.max_budget_usd) : undefined,
        onStderr: (s) => {
          // Echo MCP tool calls by default so the agentic run is visible; the
          // noisy mcp-server stderr only under -v. stderr-only — stdout stays
          // pure prose for --multi-index capture.
          if (args.verbose) process.stderr.write(s);
          else if (s.startsWith('[overview] tool:')) process.stderr.write(s);
        },
      }));
      // costUsd is summed per turn via core/pricing.js estimateCost; annotate
      // with token counts from usage.
      if (showCost && costUsd != null) {
        const u = usage || {};
        const inT = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const outT = u.output_tokens || 0;
        const toks = (inT || outT) ? `, ${kTok(inT)} in / ${kTok(outT)} out` : '';
        costSuffix = ` (est. $${costUsd.toFixed(4)}${toks})`;
      }
    }
    clearInterval(heartbeat);
    process.stderr.write(`[overview-by-ai] done in ${Math.round((Date.now() - startedAt) / 1000)}s${costSuffix}\n`);
    process.stdout.write(prose + '\n');
    process.exit(0);
  } catch (e) {
    clearInterval(heartbeat);
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

// #230 Part B: first-run with no --index-path/--load-index, no --build-index, and
// no default index in cwd. If the user gave a COMMAND, run it against the bundled
// demo index. If they ran a BARE `ce` (nothing to do), show a short welcome
// (handled at the no-index block below) — don't load or dump anything. The
// user's own index (explicit path, or a `.code_search_index` in cwd) always wins.
let _firstRunWelcome = false;
if (!args._explicit.has('index_path') && !args.build_index && !fs.existsSync(args.index_path)
    && fs.existsSync(firstRunIndexZip())) {
  const _userGaveQuery = args.interactive
    || _QUERY_COMMAND_KEYS.some(c => args._explicit.has(c) || args[c]);
  const _userGaveMutating = _MUTATING_COMMAND_KEYS.some(c => args._explicit.has(c) || args[c]);
  if (_userGaveQuery) {
    useDemoIndexIfNeeded(args);   // query/discovery command → run against the demo, notice on both streams
  } else if (_userGaveMutating) {
    // #249: --rebuild-functions / --build-rename-map are real commands but mutate
    // an index — don't silently run them against the demo, and don't show the
    // welcome (which exits 0 as a no-op). Fall through so the command reaches its
    // handler and errors on the missing index.
  } else {
    _firstRunWelcome = true;   // bare `ce` → short welcome, not a load + Overview dump
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
  // we did NOT index, so silent omissions (e.g. .jinja2 inside zips) are visible
  // instead of quietly dropped. The shared census helper UNIONS the persisted
  // archive-internal skips with a live directory scan, so a directory-of-archives
  // surfaces its zip-internal skips too (the old dir-only branch missed them).
  // See src/core/extension-census.js (#191). Best-effort; never fails the build.
  try {
    const census = skippedExtensionCensus(index, { limit: 8 });
    if (census && census.text.length) {
      const list = census.text.map(({ ext, count }) => `${ext} (${count})`).join(', ');
      process.stderr.write(`\nNote: source files in these text extensions were NOT indexed:\n`);
      process.stderr.write(`      ${list}\n`);
      process.stderr.write(`      To include them, rebuild with: --add-extensions ${census.addList}\n`);
    }
    if (census && census.media.length) {
      const mlist = census.media.map(({ ext, count }) => `${ext} (${count})`).join(', ');
      process.stderr.write(`      (Also present, skipped as binary/media — not indexed as text: ${mlist})\n`);
    }
  } catch { /* best-effort tip; never break the build */ }

  // If only building (no other command), exit
  if (!_POST_BUILD_CONTINUE_KEYS.some(c => args._explicit.has(c) || args[c])) {
    process.exit(0);
  }
}


// ========================================================================
// Check we have an index for queries
// ========================================================================

if (index.files.size === 0 && !args.build_index) {
  const _exeBase = exeBase();
  if (_firstRunWelcome) {
    // First run: a demo index is bundled but the user ran a bare `ce`. Keep it
    // SHORT and lead with --gui (they don't know it exists yet) — no index load,
    // no Overview dump. Commands (--overview, --search, -i) auto-load the demo.
    printBanner();
    console.log(`\nWelcome. A small demo index is bundled, so you can try CodeExam right now.\n`);
    console.log('Start here:');
    console.log(`  ${_exeBase} --gui          open the browser UI on the demo  (best for a first look)`);
    console.log(`  ${_exeBase} --overview     a high-level orientation of the demo, here in the terminal`);
    console.log(`\nExamine your own code:`);
    console.log(`  ${_exeBase} --build-index <dir> --index-path .my_code   index a source tree, then  ${_exeBase} --index-path .my_code --overview`);
    console.log(`  ${_exeBase} --help                 all commands · doc: https://github.com/aschulman42-cell/code-exam`);
    process.exit(0);
  }
  // First-run / no-index. Don't fixate on the internal default ".code_search_index":
  // show a path only when the user explicitly gave one. (The bundled demo only
  // auto-loads when a command is given; a bare `ce` is handled above.)
  printBanner();
  if (args._explicit.has('index_path')) {
    console.log(`\nNo index found at "${args.index_path}".\n`);
  } else {
    console.log('\nNo index loaded yet.\n');
  }
  console.log('Getting started:');
  console.log(`  ${_exeBase} --indexes      list indexes you've already built (or the Indexes accordion in --gui)`);
  console.log(`  ${_exeBase} --build-index <dir> --index-path .my_index    build one from a source tree`);
  console.log(`  ${_exeBase} --index-path <dir>       load an existing index, then run a command (--overview, --search, …)`);
  console.log(`  ${_exeBase} -i --index-path <dir>    load an index and explore it interactively (REPL)`);
  console.log(`  ${_exeBase} --gui          open the browser UI (load or build an index there)`);
  console.log(`  ${_exeBase} --help         all commands   (docs / source: https://github.com/aschulman42-cell/code-exam)`);
  process.exit(1);
}


// ========================================================================
// #215: opt-in provenance header — the very top of this run's stdout.
// Placed after the index checks (so the file count is real) and before any
// command output. See src/core/provenance.js for the litigation print-out
// roadmap (confidentiality banners, Bates, print limits) this seeds.
// ========================================================================

if (args.provenance) {
  const _provEngine = args.llm || (args.model ? 'local' : null);
  const _provModel = _provEngine === 'openai' ? (args.openai_model || null)
    : _provEngine === 'local' ? (args.model || null)
    : (args.claude_model || null);
  console.log(buildProvenanceHeader({
    version: CE_VERSION,
    indexPath: args.index_path,
    fileCount: index.files.size,
    command: sanitizedCommandLine(),
    engine: _provEngine,
    model: _provModel,
  }));
  console.log('');
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
  if (!_POST_BUILD_CONTINUE_KEYS.some(c => args._explicit.has(c) || args[c])) {
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

// #281 pseudo-claims (v1: explicit anchors). Scaffold is deterministic, but keep
// it in the async block so the generate item can await an LLM draft.
// #290: NOT when --claims-loop is driving — there --candidates names the
// loop's INPUT .lst; without this guard the gather emitter would overwrite
// that file with a fresh unranked gather before the loop reads it.
if (!args.claims_loop && (args.pseudo_claims || args.candidates || args.ground_truth || args.rank)) {
  await doPseudoClaims(index, args);
}

// Phase 8b: Analysis commands (async — LLM calls)
if (args.analyze) {
  await doAnalyze(index, args);
}
if (args.claim_analyze) {
  await doClaimAnalyze(index, args);
}
if (args.claim_chart) {
  const { doClaimChart } = await import('./commands/claim-chart.js');
  await doClaimChart(index, args);
}

if (args.claim_locate) {
  const { doClaimLocate } = await import('./commands/claim-locate.js');
  await doClaimLocate(index, args);
}
if (args.claims_loop) {
  const { doClaimsLoop } = await import('./commands/claims-loop.js');
  await doClaimsLoop(index, args);
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
  const anyCommand = _QUERY_COMMAND_KEYS.some(c => args._explicit.has(c) || args[c])
    || _MUTATING_COMMAND_KEYS.some(c => args._explicit.has(c) || args[c]);

  if (!anyCommand && !args.build_index) {
    const _exe = exeBase();
    // No command given, but an index is loaded. Don't auto-enter the REPL
    // (script-/agent-hostile: hangs on stdin) — show the banner + what you can
    // do, and exit. Use -i to open the REPL explicitly. (Unknown-flag/positional
    // errors were already handled before the index load.)
    printBanner();
    console.log(`\nIndex "${args.index_path}" loaded — ${index.files.size} file${index.files.size === 1 ? '' : 's'}. No command given.\n`);
    console.log('Try:');
    console.log(`  ${_exe} --overview     high-level orientation`);
    console.log(`  ${_exe} --gui          explore in the browser`);
    console.log(`  ${_exe} --tour         guided walkthrough in the browser`);
    console.log(`  ${_exe} -i             interactive REPL`);
    console.log(`  ${_exe} --help         all commands`);
    process.exit(0);
  }
}
