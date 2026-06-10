/**
 * metrics.js - Discovery/metrics commands: hotspots, hot-folders,
 * entry-points, domain-fns, gaps, list-classes, class-hotspots.
 * Port of ce_metrics.py
 */

import path from 'path';
import { eprint } from '../utils.js';
import { makeFilterMatcher } from '../core/filter-match.js';
import { groupSites, groupPipelines, KERNELS_DRILLDOWN, MULTIMODAL_DRILLDOWN, POSTTRAINING_DRILLDOWN, REASONING_DRILLDOWN, MODELS_DRILLDOWN, ARTIFACTS_DRILLDOWN, DATASETS_DRILLDOWN, TOOLS_DRILLDOWN, TRAINING_DRILLDOWN, INFERENCE_DRILLDOWN, LLMCALLS_DRILLDOWN, CHAINS_DRILLDOWN, EMBEDDINGS_DRILLDOWN, STRUCTURED_OUTPUT_DRILLDOWN } from '../core/ai-ml-detectors.js';


// ========================================================================
// Shared helpers
// ========================================================================

const SKIP_KEYWORDS = new Set([
  'if', 'while', 'for', 'switch', 'catch', 'return', 'sizeof',
  'typeof', 'defined', 'else', 'elif', 'except', 'finally',
  'void', 'int', 'char', 'short', 'long', 'float', 'double',
  'unsigned', 'signed', 'bool', 'auto', 'register', 'extern',
  'static', 'const', 'volatile', 'inline', 'virtual',
  'byte', 'boolean', 'String',
  'Copyright', 'copyright', 'param', 'author',
]);

function bareName(name) {
  let b = name.includes('::') ? name.split('::').pop() : name;
  if (b.includes('@')) b = b.split('@')[0];
  return b;
}

function shortPath(fp, maxLen = 42) {
  return fp.length <= maxLen ? fp : '...' + fp.slice(-(maxLen - 3));
}

// #132: --no-tests drops AI/ML records tagged `isTest` (test/example code).
// Without the flag, verbose renderers append testTag(r) so the tag stays
// visible in text output (and multi-index diffs can see it).
function dropTests(rows, args) {
  if (!args.no_tests) return rows;
  const kept = rows.filter(r => !r.isTest);
  if (rows.unresolved !== undefined) kept.unresolved = rows.unresolved;  // listModelsUsed tail note
  return kept;
}

const testTag = (r) => (r.isTest ? ' [test]' : '');

// #132 discoverability: the default (grouped) views don't tag individual rows,
// so when test/example records are present, say so and point at --no-tests / -v.
function noTestsTip(rows, args, what = 'sites') {
  if (args.no_tests) return;
  const n = (rows || []).filter(r => r.isTest).length;
  if (n) console.log(`\n  Tip: ${n} of ${rows.length} ${what} are in test/example code — add --no-tests to hide them.`);
}

function applyPathFilters(items, args, fpKey = 'filepath') {
  let result = items;
  // --in universal path filter
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    result = result.filter(h => h[fpKey].toLowerCase().includes(pat));
  }
  if (args.include_path) {
    result = result.filter(h =>
      args.include_path.some(p => h[fpKey].toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_path) {
    result = result.filter(h =>
      !args.exclude_path.some(p => h[fpKey].toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_tests) {
    result = result.filter(h => !h[fpKey].toLowerCase().includes('test'));
  }
  return result;
}


// ========================================================================
// Hotspots
// ========================================================================

export function doHotspots(index, args) {
  const n = args.hotspots;
  const hotspots = index.getHotspots(n * 3, true);

  if (!hotspots.length) {
    console.log('No hotspots found (need both function index and inverted index).');
    return;
  }

  const matchHot = args.filter ? makeFilterMatcher(args.filter) : null;
  let filtered = [];
  for (const h of hotspots) {
    const bare = bareName(h.name);
    if (bare.length < 2) continue;
    if (SKIP_KEYWORDS.has(bare)) continue;
    if (/^[A-Z][A-Z0-9_]+$/.test(bare) && bare.length >= 2) continue; // ALL_CAPS macros
    if (matchHot && !matchHot(h.display_name, h.filepath)) continue;
    filtered.push(h);
  }

  filtered = applyPathFilters(filtered, args);

  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} hotspots (big functions x high call frequency):`);
  console.log(`  Score = calls x log2(lines)`);
  console.log(`  ${'Score'.padStart(8)}  ${'Calls'.padStart(6)}  ${'Lines'.padStart(6)}  ${'Function'.padEnd(40)}  File`);
  console.log(`  ${'-'.repeat(110)}`);

  for (const h of filtered.slice(0, n)) {
    let fp = args.full_path ? h.filepath : shortPath(h.filepath);
    let dn = index.getDisplayName ? index.getDisplayName(h.name) : h.display_name;
    if (h.copies > 0) dn = `${dn} (+${h.copies})`;
    console.log(`  ${h.score.toFixed(0).padStart(8)}  ${String(h.calls).padStart(6)}  ${String(h.lines).padStart(6)}  ${dn.padEnd(40)}  ${fp}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} hotspots. Use --hotspots ${n * 2} for more.`);
  }
}


// ========================================================================
// Hot Folders
// ========================================================================

export function doHotFolders(index, args) {
  const n = args.hot_folders;
  const hotspots = index.getHotspots(50000, true);

  if (!hotspots.length) {
    console.log('No hotspots found.');
    return;
  }

  // Aggregate by directory at multiple levels
  const maxDepth = args.depth || null;  // --depth N limits folder nesting
  const folderStats = {};
  for (const h of hotspots) {
    const fp = h.filepath.replace(/\\/g, '/');
    const parts = fp.split('/');
    const limit = maxDepth ? Math.min(parts.length, maxDepth + 1) : parts.length;
    for (let i = 1; i < limit; i++) {
      const folder = parts.slice(0, i).join('/');
      if (!folderStats[folder]) {
        folderStats[folder] = { score: 0, funcs: 0, files: new Set(), top_func: null, top_score: 0 };
      }
      const s = folderStats[folder];
      s.score += h.score;
      s.funcs++;
      s.files.add(fp);
      if (h.score > s.top_score) {
        s.top_score = h.score;
        s.top_func = h.display_name || h.name;
      }
    }
  }

  // Sort and filter redundant subsets
  const sorted = Object.entries(folderStats).sort((a, b) => b[1].score - a[1].score);
  const shownFolders = new Set();
  let filtered = [];

  for (const [folder, stats] of sorted) {
    const parts = folder.split('/');
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
    if (parent && shownFolders.has(parent)) {
      const ps = folderStats[parent];
      if (ps && Math.abs(ps.score - stats.score) < 1) continue;
    }
    filtered.push([folder, stats]);
    shownFolders.add(folder);
  }

  if (args.filter) {
    const match = makeFilterMatcher(args.filter);
    filtered = filtered.filter(([f]) => match(f));
  }

  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} hot folders (by aggregated hotspot score):`);
  console.log(`  ${'Score'.padStart(10)}  ${'Funcs'.padStart(6)}  ${'Files'.padStart(6)}  ${'Top Function'.padEnd(35)}  Folder`);
  console.log(`  ${'-'.repeat(120)}`);

  for (let i = 0; i < shown; i++) {
    const [folder, stats] = filtered[i];
    let top = stats.top_func || '';
    if (top.length > 34) top = top.slice(0, 31) + '...';
    console.log(`  ${stats.score.toFixed(0).padStart(10)}  ${String(stats.funcs).padStart(6)}  ${String(stats.files.size).padStart(6)}  ${top.padEnd(35)}  ${folder}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} folders. Use --hot-folders ${n * 2} for more.`);
  }
}


// ========================================================================
// Entry Points
// ========================================================================

const ENTRY_POINT_PATTERNS = new Set([
  'handle', 'render', 'componentdid', 'componentwill', 'useeffect',
  'oncreate', 'ondestroy', 'onmount', 'onsubmit', 'onchange', 'onclick',
  'onkeydown', 'onkeyup', 'onscroll', 'onresize', 'onfocus', 'onblur',
  'describe', 'test', 'it', 'before', 'after', 'setup', 'teardown',
  'beforeeach', 'aftereach', 'beforeall', 'afterall',
  'main', 'init', 'initialize', 'configure', 'startup', 'shutdown',
  'bootstrap', 'register', 'mount', 'unmount',
  'middleware', 'authenticate', 'authorize', 'validate',
  'exports', 'default', 'module', 'constructor',
]);

const ENTRY_POINT_PREFIXES = [
  'handle', 'on', 'get', 'set', 'is', 'has', 'can', 'should',
  'use', 'test', 'spec',
];

function looksLikeEntryPoint(name, filepath) {
  const bare = bareName(name);
  const bl = bare.toLowerCase();
  const fpl = filepath.toLowerCase();

  if (fpl.includes('test') || fpl.includes('spec') || fpl.includes('__test')) return true;
  if (ENTRY_POINT_PATTERNS.has(bl)) return true;
  for (const prefix of ENTRY_POINT_PREFIXES) {
    if (bl.startsWith(prefix) && bl.length > prefix.length) return true;
  }
  const ext = path.extname(filepath).toLowerCase();
  if ((ext === '.tsx' || ext === '.jsx') && /^[A-Z]/.test(bare) && !/^[A-Z]+$/.test(bare)) return true;

  return false;
}


export function doEntryPoints(index, args) {
  const n = args.entry_points;
  const maxCalls = args.max_calls != null ? args.max_calls : 0;
  const entries = index.getEntryPoints(n * 3, maxCalls, true);

  if (!entries.length) {
    console.log('No entry points found.');
    return;
  }

  const matchEntry = args.filter ? makeFilterMatcher(args.filter) : null;
  let filtered = [];
  for (const e of entries) {
    const bare = bareName(e.name);
    if (bare.length < 2 || SKIP_KEYWORDS.has(bare)) continue;
    if (matchEntry && !matchEntry(e.name)) continue;
    filtered.push(e);
  }
  filtered = applyPathFilters(filtered, args);

  const callDesc = maxCalls === 0 ? 'never called' : `called <=${maxCalls} times`;
  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} entry points (${callDesc}, sorted by size):`);
  console.log(`  ${'Lines'.padStart(6)}  ${'Calls'.padStart(6)}  ${'Function'.padEnd(45)}  File`);
  console.log(`  ${'-'.repeat(115)}`);

  for (const e of filtered.slice(0, n)) {
    let dn = e.display_name;
    if (e.copies > 0) dn = `${dn} (+${e.copies})`;
    if (dn.length > 44) dn = dn.slice(0, 41) + '...';
    const fp = shortPath(e.filepath, 45);
    console.log(`  ${String(e.lines).padStart(6)}  ${String(e.calls).padStart(6)}  ${dn.padEnd(45)}  ${fp}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} entry points. Use --entry-points ${n * 2} for more.`);
  }

  console.log('\n  See also: --gaps (suspicious dead code), --call-inventory (external dependencies)');
}


// ========================================================================
// Gaps (dead code candidates)
// ========================================================================

export function doGaps(index, args) {
  const n = args.gaps || 25;
  const entries = index.getEntryPoints(999, 0, true);

  if (!entries.length) {
    console.log('No gaps found - all functions have callers.');
    return;
  }

  const skipKw = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'return', 'sizeof',
    'typeof', 'void', 'int', 'char', 'Copyright', 'copyright',
  ]);

  let suspicious = [];
  for (const e of entries) {
    const bare = bareName(e.name);
    if (bare.length < 2 || skipKw.has(bare)) continue;
    if (e.type === 'class') continue;
    if (looksLikeEntryPoint(e.name, e.filepath)) continue;
    suspicious.push(e);
  }
  suspicious = applyPathFilters(suspicious, args);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`  CODE GAPS: ${suspicious.length} suspicious unreachable functions`);
  console.log(`  (defined but never called, and not a recognized entry-point pattern)`);
  console.log(`${'='.repeat(80)}`);

  console.log(`\n  ${'Lines'.padStart(6)}  ${'Function'.padEnd(50)}  File`);
  console.log(`  ${'-'.repeat(110)}`);

  let shown = 0;
  for (const s of suspicious) {
    if (shown >= n) break;
    let dn = s.display_name || s.name;
    if (dn.length > 49) dn = dn.slice(0, 46) + '...';
    let fp = shortPath(s.filepath, 50);

    const servicePatterns = ['service', 'controller', 'handler', 'manager'];
    const flag = servicePatterns.some(p => s.filepath.toLowerCase().includes(p))
      ? '  [SERVICE - no caller?]' : '';

    console.log(`  ${String(s.lines).padStart(6)}  ${dn.padEnd(50)}  ${fp}${flag}`);
    shown++;
  }

  if (suspicious.length > n) {
    console.log(`\n  Showing ${n} of ${suspicious.length} gaps. Use --gaps ${n * 2} for more.`);
  }

  const serviceGaps = suspicious.filter(s =>
    ['service', 'controller'].some(p => s.filepath.toLowerCase().includes(p)));
  if (serviceGaps.length > 0) {
    console.log(`\n  WARNING: ${serviceGaps.length} gap(s) in Service/Controller files - may indicate missing route handlers:`);
    for (const sg of serviceGaps.slice(0, 10)) {
      console.log(`      ${sg.name}  (${sg.filepath})`);
    }
  }

  console.log('\n  See also: --call-inventory (external dependencies not in the index)');
  console.log('           --entry-points (largest uncalled functions)');
}


// ========================================================================
// Domain Functions
// ========================================================================

export function doDomainFns(index, args) {
  const n = args.domain_fns;
  const domain = index.getDomainHotspots(n * 3, true);

  if (!domain.length) {
    console.log('No domain functions found.');
    return;
  }

  const skipKw = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'return', 'sizeof',
    'typeof', 'void', 'int', 'char', 'Copyright', 'copyright',
  ]);

  const matchDomain = args.filter ? makeFilterMatcher(args.filter) : null;
  let filtered = [];
  for (const d of domain) {
    const bare = bareName(d.name);
    if (bare.length < 2 || skipKw.has(bare)) continue;
    if (matchDomain && !matchDomain(d.name)) continue;
    filtered.push(d);
  }
  filtered = applyPathFilters(filtered, args);

  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} domain-specific functions (score = calls x log2(lines) / sqrt(name_defs)):`);
  console.log(`  ${'Score'.padStart(8)}  ${'Calls'.padStart(6)}  ${'Lines'.padStart(6)}  ${'Defs'.padStart(5)}  ${'Function'.padEnd(40)}  File`);
  console.log(`  ${'-'.repeat(120)}`);

  for (const d of filtered.slice(0, n)) {
    let dn = d.display_name || d.name;
    if (d.copies > 0) dn = `${dn} (+${d.copies})`;
    if (dn.length > 39) dn = dn.slice(0, 36) + '...';
    const fp = shortPath(d.filepath, 45);
    console.log(`  ${d.score.toFixed(0).padStart(8)}  ${String(d.calls).padStart(6)}  ${String(d.lines).padStart(6)}  ${String(d.name_count).padStart(5)}  ${dn.padEnd(40)}  ${fp}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} domain functions. Use --domain-fns ${n * 2} for more.`);
  }
}


// ========================================================================
// List Classes
// ========================================================================

export function doListTraining(index, args) {
  const training = dropTests(index.listTraining(args.filter), args);
  if (!training.length) {
    console.log('No training found (no PyTorch loop: .backward()/optimizer.step()/'
      + 'zero_grad(); HF Trainer; GradientTape; Lightning training_step; or a gated '
      + '.fit() call). Note: a bare def fit(...) definition is intentionally not counted.');
    return;
  }

  const loops = training.filter(t => t.kind === 'training-loop');
  const harnesses = training.filter(t => t.kind === 'training-harness');
  const tierB = training.filter(t => t.tier === 'B').length;
  const byFam = {};
  for (const t of training) byFam[t.family] = (byFam[t.family] || 0) + 1;
  const famSummary = Object.entries(byFam).sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results'))
    ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? training.slice(0, max) : training;

  console.log(`\n${loops.length} training-loop sites, ${harnesses.length} harness defs (${famSummary}; ${tierB} heuristic .fit)`
    + `${max > 0 && training.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  if (args.verbose) {
    for (const t of shown) {
      const b = t.tier === 'B' ? '~' : ' ';
      console.log(`${b}${t.family.padEnd(13)} ${t.kind.padEnd(17)} ${(t.marker || '').padEnd(16)} ${t.name}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    return;
  }

  // #134 de-clutter: collapse same (family,kind,marker,name) repeats into one row
  // + count; -v lists every site + snippet.
  const groups = groupSites(training, TRAINING_DRILLDOWN.keyFn, TRAINING_DRILLDOWN.pick);
  console.log(`${'Family'.padEnd(13)}  ${'Kind'.padEnd(17)}  ${'Marker'.padEnd(16)}  ${'Name'.padEnd(22)}  Count`);
  console.log('='.repeat(82));
  for (const g of groups) {
    const t = g.rep;
    const fam = (t.tier === 'B' ? '~' : '') + t.family;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${fam.slice(0, 13).padEnd(13)}  ${t.kind.padEnd(17)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${(t.name || '').slice(0, 22).padEnd(22)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique training site${groups.length === 1 ? '' : 's'} (${training.length} instance${training.length === 1 ? '' : 's'}); use -v for every site + snippet.`);
  if (tierB) console.log(`  (~ = heuristic .fit() call — gated on ML imports, def-fit excluded)`);
  noTestsTip(training, args);
}

// Scope caption (#106) — shown on every Chains/Agents view so a 0 isn't misread.
const CHAINS_SCOPE = 'Scope: framework primitives (LangChain/LangGraph/DSPy/CrewAI/AutoGen/LlamaIndex) '
  + 'PLUS a heuristic hand-rolled-agent flag (a module that loops over an LLM call while dispatching '
  + 'tools). The hand-rolled flag needs real module boundaries — on a single minified bundle it is '
  + 'degenerate; use a bundle-seam-split (--split-bundle) index. LCEL `|` pipelines are still not '
  + 'detected; Detection keys on JS/TS + Python idioms (Rust/Go not yet — #108), so a low/zero count is not proof there is no agent.';

export function doListEmbeddings(index, args) {
  const items = dropTests(index.listEmbeddings(args.filter), args);
  if (!items.length) {
    console.log('No embeddings/vector search found (no OpenAIEmbeddings/SentenceTransformer/'
      + 'embed_query, FAISS/Chroma/Pinecone/VectorStore, similarity_search, text-splitters, or '
      + 'co-occurrence-gated distance). Embeddings/vectors here are RAG-agnostic; distance alone '
      + '(clustering/attention math) is intentionally excluded.');
    return;
  }
  const byKind = {}; const byFw = {}; let heur = 0;
  for (const t of items) { byKind[t.kind] = (byKind[t.kind] || 0) + 1; byFw[t.framework] = (byFw[t.framework] || 0) + 1; if (t.tag === 'heuristic') heur++; }
  const kindSummary = ['embedding', 'vector-store', 'search', 'chunking', 'distance'].filter(k => byKind[k]).map(k => `${byKind[k]} ${k}`).join(', ');
  const fwSummary = Object.entries(byFw).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? items.slice(0, max) : items;

  console.log(`\n${items.length} embedding/vector sites — ${kindSummary} (${fwSummary}; ${heur} heuristic):\n`);

  if (args.verbose) {
    for (const t of shown) {
      const b = t.tag === 'heuristic' ? '~' : ' ';
      console.log(`${b}${t.kind.padEnd(13)} ${(t.framework || '').padEnd(20)} ${(t.marker || '').padEnd(20)}${t.id ? '  → ' + basenameIfPath(t.id) : ''}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    return;
  }

  // #134 de-clutter: collapse same (framework,kind,marker) repeats; -v full.
  const groups = groupSites(items, EMBEDDINGS_DRILLDOWN.keyFn, EMBEDDINGS_DRILLDOWN.pick);
  console.log(`${'Kind'.padEnd(13)}  ${'Framework'.padEnd(20)}  ${'Marker'.padEnd(24)}  ${'Model / id'.padEnd(34)}  Count`);
  console.log('='.repeat(102));
  for (const g of groups) {
    const t = g.rep;
    const kind = (t.tag === 'heuristic' ? '~' : '') + t.kind;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${kind.slice(0, 13).padEnd(13)}  ${(t.framework || '').slice(0, 20).padEnd(20)}  ${(t.marker || '').slice(0, 24).padEnd(24)}  ${(basenameIfPath(t.id) || '').slice(0, 34).padEnd(34)}  ${cnt}`);
  }
  const unres = items.filter(t => t.id && t.resolved === false).length;
  console.log(`\n${groups.length} unique embedding/vector${groups.length === 1 ? '' : 's'} (${items.length} site${items.length === 1 ? '' : 's'}); use -v for every site + snippet.`);
  if (heur) console.log(`  (~ = heuristic/gated; distance co-occurrence-gated. RAG = this + an LLM call, #103.)`);
  console.log(`  (Model / id = embedding model or vector index/collection; <var>${unres ? ` (${unres})` : ''} = unresolved in-file.)`);
  noTestsTip(items, args);
}

export function doListModelsUsed(index, args) {
  const models = dropTests(index.listModelsUsed(args.filter), args);
  if (!models.length) {
    console.log('No models used found (no resolved model id from LLM calls, artifacts, '
      + 'embeddings, or inference). Models USED (named models the code loads/calls) is '
      + 'distinct from models DEFINED (--models, class inheritance).'
      + (models.unresolved ? ` (${models.unresolved} model refs were unresolved <var>.)` : ''));
    return;
  }
  const api = models.filter(m => m.access === 'api').length;
  const local = models.filter(m => m.access === 'local').length;
  const mixed = models.filter(m => m.access === 'mixed').length;

  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? models.slice(0, max) : models;

  console.log(`\n${models.length} models used — ${api} api, ${local} local${mixed ? `, ${mixed} mixed` : ''}`
    + `${models.unresolved ? ` (+${models.unresolved} unresolved refs)` : ''}`
    + `${max > 0 && models.length > max ? `; showing ${shown.length}` : ''}:\n`);

  if (args.verbose) {
    for (const m of shown) {
      console.log(`${m.access.padEnd(6)} ${basenameIfPath(m.model)}  (${m.cells.join(', ')}, ${m.count} site${m.count > 1 ? 's' : ''})${testTag(m)}`);
      for (const s of m.sites.slice(0, 12)) console.log(`        ${(s.filepath || '').replace(/\\/g, '/')}:${s.line}  [${s.cell}]`);
    }
    return;
  }

  console.log(`${'Access'.padEnd(6)}  ${'Model'.padEnd(52)}  ${'Cells'.padEnd(26)}  Sites`);
  console.log('='.repeat(98));
  for (const m of shown) {
    console.log(`${m.access.padEnd(6)}  ${(basenameIfPath(m.model) || '').slice(0, 52).padEnd(52)}  ${m.cells.join(',').slice(0, 26).padEnd(26)}  ${m.count}`);
  }
  console.log(`\n  (Models USED — named models the code loads/calls, deduped & tagged api=hosted / local=loaded.`
    + ` Distinct from models DEFINED (--models, class inheritance).`
    + ` Non-model artifacts (optimizer/vocab/config, device strings) are filtered out.`
    + (models.unresolved ? ` ${models.unresolved} refs were unresolved <var> and excluded.` : '') + `)`);
  noTestsTip(models, args, 'models (every site in test/example code)');
}

export function doListStructuredOutput(index, args) {
  const items = dropTests(index.listStructuredOutput(args.filter), args);
  if (!items.length) {
    console.log('No structured output found (no with_structured_output / response_model / '
      + 'response_format / JSON mode, output parsers, or outlines/guidance). Bare Pydantic '
      + 'BaseModel / Zod schemas are intentionally not counted — only schemas bound to an LLM call.');
    return;
  }
  const byKind = {}; const byFw = {}; let heur = 0;
  for (const t of items) { byKind[t.kind] = (byKind[t.kind] || 0) + 1; byFw[t.framework] = (byFw[t.framework] || 0) + 1; if (t.tag === 'heuristic') heur++; }
  const kindSummary = ['schema', 'format', 'parser', 'constrained'].filter(k => byKind[k]).map(k => `${byKind[k]} ${k}`).join(', ');
  const fwSummary = Object.entries(byFw).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ');
  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? items.slice(0, max) : items;
  console.log(`\n${items.length} structured-output sites — ${kindSummary} (${fwSummary}; ${heur} heuristic):\n`);
  if (args.verbose) {
    for (const t of shown) {
      const b = t.tag === 'heuristic' ? '~' : ' ';
      console.log(`${b}${t.kind.padEnd(12)} ${(t.framework || '').padEnd(16)} ${(t.marker || '').padEnd(24)}${t.id ? '  → ' + t.id : ''}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    return;
  }
  // #134 de-clutter: collapse same (framework,kind,marker,name) repeats; -v full.
  const groups = groupSites(items, STRUCTURED_OUTPUT_DRILLDOWN.keyFn, STRUCTURED_OUTPUT_DRILLDOWN.pick);
  console.log(`${'Kind'.padEnd(12)}  ${'Framework'.padEnd(16)}  ${'Marker'.padEnd(24)}  ${'Schema'.padEnd(28)}  Count`);
  console.log('='.repeat(94));
  for (const g of groups) {
    const t = g.rep;
    const kind = (t.tag === 'heuristic' ? '~' : '') + t.kind;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${kind.slice(0, 12).padEnd(12)}  ${(t.framework || '').slice(0, 16).padEnd(16)}  ${(t.marker || '').slice(0, 24).padEnd(24)}  ${(t.id || '').slice(0, 28).padEnd(28)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique schema${groups.length === 1 ? '' : 's'} (${items.length} site${items.length === 1 ? '' : 's'}); use -v for every site + snippet.`);
  if (heur) console.log(`  (~ = heuristic/gated; bare BaseModel/Zod NOT counted — only schemas bound to an LLM call.)`);
  noTestsTip(items, args);
}

export function doListPipelines(index, args) {
  const flows = dropTests(index.listPipelines(args.filter), args);
  if (!flows.length) {
    console.log('No AI/ML pipelines found (no file or leaf-folder where 2+ cells co-occur to form a '
      + 'RAG / low-level / training / inference / agent / reasoning / LLM-app shape). Single-cell usage is not a pipeline.');
    return;
  }
  const byShape = {}, byScope = {};
  for (const w of flows) { byShape[w.shape] = (byShape[w.shape] || 0) + 1; byScope[w.scope] = (byScope[w.scope] || 0) + 1; }
  const shapeSummary = ['RAG', 'low-level', 'training', 'agent', 'inference', 'reasoning', 'LLM-app'].filter(s => byShape[s]).map(s => `${byShape[s]} ${s}`).join(', ');
  const scopeSummary = ['file', 'folder', 'module'].filter(s => byScope[s]).map(s => `${byScope[s]} ${s}`).join(', ');
  // Confidence by scope: file/folder = cells co-occur in one file or leaf folder
  // (trustworthy); module = the assembler CLIMBED to a broader common ancestor, so
  // the cells merely co-exist somewhere in that subtree, NOT a coherent flow. Demote
  // module to a separate, clearly-labelled "loose" section so it can't masquerade as
  // a real pipeline (#142).
  const main = flows.filter(w => w.scope !== 'module');
  const loose = flows.filter(w => w.scope === 'module');
  // #142 drill-down dedupe: the SAME pipeline (e.g. `RAG · vector-store(LangChain)
  // → search(LangChain)`) repeats once per file (~186 rows for .langchain),
  // differing only by location. Collapse identical-signature flows to ONE row +
  // ×count within each section; -v lists every member location beneath its rep.
  // Grouping is per-section so the main/loose split (and its confidence caveat) is
  // preserved.
  const mainGroups = groupPipelines(main);
  const looseGroups = groupPipelines(loose);
  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const cap = (arr) => (max > 0 ? arr.slice(0, max) : arr);
  const groupCount = mainGroups.length + looseGroups.length;
  console.log(`\n${flows.length} pipelines in ${groupCount} group${groupCount === 1 ? '' : 's'} — ${shapeSummary} (${scopeSummary})${loose.length ? `; ${loose.length} loose (module-scope) shown separately` : ''}:\n`);
  const stagesStr = (w) => w.stages.map(s => s.cell + (s.ids.length ? `(${basenameIfPath(s.ids[0])}${s.ids.length > 1 ? ',…' : ''})` : '')).join(' → ');
  const LOOSE_HDR = '── loose: module-scope (climbed to a common ancestor — cells co-occur somewhere in the subtree, NOT a traced flow); lower confidence ──';
  if (args.verbose) {
    const vgroup = (g) => {
      const w = g.rep;
      const cnt = g.count > 1 ? `  ×${g.count}` : '';
      // #132: a GROUP is test/example only when every member location is —
      // the rep alone can misrepresent a mixed group.
      const gTest = (g.members && g.members.length) ? g.members.every(x => x.isTest) : !!w.isTest;
      console.log(`${w.scope.padEnd(6)} ${w.shape.padEnd(9)} ${w.location.replace(/\\/g, '/')}${w.shapes.length > 1 ? `  [also: ${w.shapes.slice(1).join(', ')}]` : ''}${cnt}${gTest ? ' [test]' : ''}`);
      console.log(`        ${stagesStr(w)}`);
      for (const m of g.members) console.log(`          - ${m.scope.padEnd(6)} ${m.location.replace(/\\/g, '/')}`);
    };
    for (const g of cap(mainGroups)) vgroup(g);
    if (looseGroups.length) { console.log(`\n  ${LOOSE_HDR}`); for (const g of cap(looseGroups)) vgroup(g); }
    return;
  }
  const head = () => { console.log(`${'Shape'.padEnd(9)}  ${'Scope'.padEnd(6)}  ${'Location'.padEnd(34)}  ${'Stages'.padEnd(80)}  Count`); console.log('='.repeat(140)); };
  const row = (g) => { const w = g.rep; let loc = w.location.replace(/\\/g, '/'); if (loc.length > 34) loc = '...' + loc.slice(-31); const cnt = g.count > 1 ? `×${g.count}` : ''; const gTest = (g.members && g.members.length) ? g.members.every(x => x.isTest) : !!w.isTest; console.log(`${w.shape.padEnd(9)}  ${w.scope.padEnd(6)}  ${loc.padEnd(34)}  ${stagesStr(w).slice(0, 80).padEnd(80)}  ${cnt}${gTest ? ' [test]' : ''}`); };
  head();
  for (const g of cap(mainGroups)) row(g);
  if (looseGroups.length) { console.log(`\n${LOOSE_HDR}`); head(); for (const g of cap(looseGroups)) row(g); }
  console.log(`\n${groupCount} group${groupCount === 1 ? '' : 's'} (${flows.length} pipeline${flows.length === 1 ? '' : 's'}); use -v for every member location.`);
  console.log(`  (Pipelines = AI/ML constructs inferred from cell CO-OCCURRENCE, NOT traced dataflow. Confidence by scope:`
    + ` file > folder (leaf folder) > module (climbed to a common ancestor — "loose", shown separately above). Import-graph assembly + a graph view are deferred. Shapes by specificity: RAG>low-level>fine-tuning>training>agent>inference>reasoning>LLM-app.)`);
  noTestsTip(flows, args, 'pipelines');
}

export function doListChains(index, args) {
  const chains = dropTests(index.listChains(args.filter), args);
  if (!chains.length) {
    console.log('No framework chains/agents found (no LangChain LLMChain/Runnable*/AgentExecutor, '
      + 'LangGraph StateGraph, DSPy ChainOfThought/dspy.Module, or CrewAI/AutoGen primitives).');
    console.log(`\n  (${CHAINS_SCOPE})`);
    return;
  }

  const byKind = {}; const byFw = {}; let heur = 0;
  for (const t of chains) { byKind[t.kind] = (byKind[t.kind] || 0) + 1; byFw[t.framework] = (byFw[t.framework] || 0) + 1; if (t.tag === 'heuristic') heur++; }
  const kindSummary = ['chain', 'graph', 'agent'].filter(k => byKind[k]).map(k => `${byKind[k]} ${k}`).join(', ');
  const fwSummary = Object.entries(byFw).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? chains.slice(0, max) : chains;

  console.log(`\n${chains.length} chain/agent sites — ${kindSummary} (${fwSummary}; ${heur} heuristic):\n`);

  if (args.verbose) {
    for (const t of shown) {
      const b = t.tag === 'heuristic' ? '~' : ' ';
      console.log(`${b}${(t.framework || '').padEnd(12)} ${t.kind.padEnd(7)} ${(t.marker || '').padEnd(22)} ${t.name !== t.marker ? '→ ' + t.name : ''}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    console.log(`\n  (${CHAINS_SCOPE})`);
    return;
  }

  // #134 de-clutter: collapse same (framework,kind,marker,name) repeats; -v full.
  const groups = groupSites(chains, CHAINS_DRILLDOWN.keyFn, CHAINS_DRILLDOWN.pick);
  console.log(`${'Framework'.padEnd(12)}  ${'Kind'.padEnd(7)}  ${'Marker'.padEnd(22)}  ${'Name'.padEnd(20)}  Count`);
  console.log('='.repeat(74));
  for (const g of groups) {
    const t = g.rep;
    const fw = (t.tag === 'heuristic' ? '~' : '') + (t.framework || '');
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${fw.slice(0, 12).padEnd(12)}  ${t.kind.padEnd(7)}  ${(t.marker || '').slice(0, 22).padEnd(22)}  ${(t.name || '').slice(0, 20).padEnd(20)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique chain/agent${groups.length === 1 ? '' : 's'} (${chains.length} site${chains.length === 1 ? '' : 's'}); use -v for every site + snippet.`);
  console.log(`  (${CHAINS_SCOPE})`);
  noTestsTip(chains, args);
}

export function doListTools(index, args) {
  const tools = dropTests(index.listTools(args.filter), args);
  if (!tools.length) {
    console.log('No tools found (no @tool/FunctionTool/StructuredTool, input_schema/'
      + 'inputSchema, MCP setRequestHandler/server.tool/defineChatSessionFunction, or '
      + 'tool_use/tool_calls dispatch). Note: @tool alone is LangChain-specific.');
    return;
  }

  const byKind = {}; const byFw = {}; let heur = 0;
  for (const t of tools) { byKind[t.kind] = (byKind[t.kind] || 0) + 1; byFw[t.framework] = (byFw[t.framework] || 0) + 1; if (t.tag === 'heuristic') heur++; }
  const kindSummary = ['tool-def', 'mcp', 'tool-dispatch'].filter(k => byKind[k]).map(k => `${byKind[k]} ${k}`).join(', ');
  const fwSummary = Object.entries(byFw).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? tools.slice(0, max) : tools;

  console.log(`\n${tools.length} tool sites — ${kindSummary} (${fwSummary}; ${heur} heuristic)`
    + `${max > 0 && tools.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  if (args.verbose) {
    for (const t of shown) {
      const b = t.tag === 'heuristic' ? '~' : ' ';
      console.log(`${b}${(t.framework || '').padEnd(18)} ${t.kind.padEnd(14)} ${(t.marker || '').padEnd(18)} ${t.name ? '→ ' + t.name : ''}${t.lvc ? ' [lib?]' : ''}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    return;
  }

  // #134 de-clutter: collapse repeats of the same tool name into one row + count;
  // -v lists every site + snippet.
  const groups = groupSites(tools, TOOLS_DRILLDOWN.keyFn, TOOLS_DRILLDOWN.pick);
  console.log(`${'Framework'.padEnd(18)}  ${'Kind'.padEnd(13)}  ${'Marker'.padEnd(16)}  ${'Tool name'.padEnd(26)}  Count`);
  console.log('='.repeat(90));
  for (const g of groups) {
    const t = g.rep;
    const fw = (t.tag === 'heuristic' ? '~' : '') + (t.framework || '');
    const nm = (t.name || '(unnamed)') + (t.lvc ? ' [lib?]' : '');
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${fw.slice(0, 18).padEnd(18)}  ${t.kind.padEnd(13)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${nm.slice(0, 26).padEnd(26)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique tool${groups.length === 1 ? '' : 's'} (${tools.length} site${tools.length === 1 ? '' : 's'}); use -v for every site + snippet.`);
  if (heur) console.log(`  (~ = heuristic, gated on LLM/MCP context; [lib?] = library-vs-consumer over-fire; blank name = not statically extractable)`);
  noTestsTip(tools, args);
}

export function doListLlmCalls(index, args) {
  const calls = dropTests(index.listLlmCalls(args.filter), args);
  if (!calls.length) {
    console.log('No LLM API calls found (no messages.create / chat.completions.create / '
      + 'ChatOpenAI / LlamaChatSession / .invoke, or api.anthropic.com·/v1/messages endpoints). '
      + 'A pure harness that spawns an agent CLI (e.g. Bram) correctly shows none.');
    return;
  }

  const byKind = {}; const byProv = {}; let heur = 0;
  for (const t of calls) { byKind[t.kind] = (byKind[t.kind] || 0) + 1; byProv[t.provider] = (byProv[t.provider] || 0) + 1; if (t.tag === 'heuristic') heur++; }
  const provSummary = Object.entries(byProv).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ');
  const kindSummary = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? calls.slice(0, max) : calls;

  console.log(`\n${calls.length} LLM-call sites — ${kindSummary} (${provSummary}; ${heur} heuristic)`
    + `${max > 0 && calls.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  if (args.verbose) {
    for (const t of shown) {
      const b = t.tag === 'heuristic' ? '~' : ' ';
      console.log(`${b}${t.provider.padEnd(11)} ${t.kind.padEnd(9)} ${('T' + t.tier).padEnd(3)} ${(t.marker || '').padEnd(24)}${t.lvc ? ' [lib?]' : ''}${t.model ? '  → ' + basenameIfPath(t.model) : ''}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    return;
  }

  // #134 de-clutter: collapse same (provider,kind,marker,model) repeats — same
  // model to the same provider becomes one row + count; -v lists every call.
  const groups = groupSites(calls, LLMCALLS_DRILLDOWN.keyFn, LLMCALLS_DRILLDOWN.pick);
  console.log(`${'Provider'.padEnd(11)}  ${'Kind'.padEnd(9)}  ${'Marker'.padEnd(26)}  ${'Model'.padEnd(28)}  Count`);
  console.log('='.repeat(88));
  for (const g of groups) {
    const t = g.rep;
    const prov = (t.tag === 'heuristic' ? '~' : '') + t.provider;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${prov.slice(0, 11).padEnd(11)}  ${t.kind.padEnd(9)}  ${((t.marker || '') + (t.lvc ? ' [lib?]' : '')).slice(0, 26).padEnd(26)}  ${basenameIfPath(t.model || '').slice(0, 28).padEnd(28)}  ${cnt}`);
  }
  const unresolved = calls.filter(t => t.model && !t.modelResolved).length;
  console.log(`\n${groups.length} unique LLM-call${groups.length === 1 ? '' : 's'} (${calls.length} site${calls.length === 1 ? '' : 's'}); use -v for every call + snippet.`);
  if (heur) console.log(`  (~ = heuristic; [lib?] = library-vs-consumer over-fires)`);
  console.log(`  (Model resolved via same-file assignment / argparse default where possible; <var>${unresolved ? ` (${unresolved})` : ''} = unresolved in-file)`);
  noTestsTip(calls, args);
}

export function doListInference(index, args) {
  const inf = dropTests(index.listInference(args.filter), args);
  if (!inf.length) {
    console.log('No inference/generation found (no generate()/max_new_tokens/do_sample/'
      + 'GenerationConfig, no_grad/inference_mode/InferenceSession, or gated .predict()). '
      + 'API-client LLM usage (remote calls) is a separate unit, not counted here.');
    return;
  }

  const gen = inf.filter(t => t.kind === 'generation');
  const infr = inf.filter(t => t.kind === 'inference');
  const heur = inf.filter(t => t.tag === 'heuristic').length;
  const byFam = {};
  for (const t of inf) byFam[t.family] = (byFam[t.family] || 0) + 1;
  const famSummary = Object.entries(byFam).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? inf.slice(0, max) : inf;

  console.log(`\n${gen.length} generation, ${infr.length} inference (${famSummary}; ${heur} heuristic)`
    + `${max > 0 && inf.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  if (args.verbose) {
    for (const t of shown) {
      const b = t.tag === 'heuristic' ? '~' : ' ';
      console.log(`${b}${t.family.padEnd(13)} ${t.kind.padEnd(11)} ${('T' + t.tier).padEnd(3)} ${(t.marker || '').padEnd(16)} ${t.name}${t.id ? '  → ' + basenameIfPath(t.id) : ''}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    return;
  }

  // #134 de-clutter: collapse same (family,kind,marker,name) repeats; -v full.
  const groups = groupSites(inf, INFERENCE_DRILLDOWN.keyFn, INFERENCE_DRILLDOWN.pick);
  console.log(`${'Family'.padEnd(13)}  ${'Kind'.padEnd(11)}  ${'Marker'.padEnd(16)}  ${'Name (→ model)'.padEnd(30)}  Count`);
  console.log('='.repeat(86));
  for (const g of groups) {
    const t = g.rep;
    const fam = (t.tag === 'heuristic' ? '~' : '') + t.family;
    const nm = (t.name || '') + (t.id ? ' → ' + basenameIfPath(t.id) : '');
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${fam.slice(0, 13).padEnd(13)}  ${t.kind.padEnd(11)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${nm.slice(0, 30).padEnd(30)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique inference site${groups.length === 1 ? '' : 's'} (${inf.length} instance${inf.length === 1 ? '' : 's'}); use -v for every site + snippet.`);
  if (heur) console.log(`  (~ = heuristic/gated; → model = pipeline(model=…))`);
  noTestsTip(inf, args);
}

export function doListDatasets(index, args) {
  const datasets = dropTests(index.listDatasets(args.filter), args);
  if (!datasets.length) {
    console.log('No datasets found (no Dataset/IterableDataset subclass, tf.data '
      + 'pipeline, or ML loader: DataLoader / load_dataset / sklearn.datasets / '
      + 'keras.datasets / torchvision.datasets / tfds.load). Generic pd.read_csv/'
      + 'np.load I/O is intentionally not counted.');
    return;
  }

  const defs = datasets.filter(d => d.kind === 'definition');
  const loaders = datasets.filter(d => d.kind === 'loader');
  const builtins = datasets.filter(d => d.builtin).length;
  const byFam = {};
  for (const d of datasets) byFam[d.family] = (byFam[d.family] || 0) + 1;
  const famSummary = Object.entries(byFam).sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results'))
    ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? datasets.slice(0, max) : datasets;

  console.log(`\n${defs.length} dataset defs, ${loaders.length} loaders (${famSummary}; ${builtins} built-in)`
    + `${max > 0 && datasets.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  if (args.verbose) {
    for (const d of shown) {
      const b = d.builtin ? '*' : ' ';
      console.log(`${b}${d.family.padEnd(13)} ${d.kind.padEnd(11)} ${(d.marker || '').padEnd(20)} ${basenameIfPath(d.name)}`);
      console.log(`        ${(d.filepath || '').replace(/\\/g, '/')}:${d.line}${testTag(d)}  ${d.snippet}`);
    }
    return;
  }

  // #134 de-clutter: collapse repeats of the same dataset name into one row +
  // count; -v lists every site + snippet.
  const groups = groupSites(datasets, DATASETS_DRILLDOWN.keyFn, DATASETS_DRILLDOWN.pick);
  console.log(`${'Family'.padEnd(13)}  ${'Kind'.padEnd(11)}  ${'Marker'.padEnd(20)}  ${'Name'.padEnd(34)}  Count`);
  console.log('='.repeat(96));
  for (const g of groups) {
    const d = g.rep;
    const fam = (d.builtin ? '*' : '') + d.family;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${fam.slice(0, 13).padEnd(13)}  ${d.kind.padEnd(11)}  ${(d.marker || '').slice(0, 20).padEnd(20)}  ${(basenameIfPath(d.name) || '').slice(0, 34).padEnd(34)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique dataset${groups.length === 1 ? '' : 's'} (${datasets.length} site${datasets.length === 1 ? '' : 's'}); use -v for every site + snippet.`);
  if (builtins) console.log(`  (* = built-in dataset — framework-provided standard/benchmark data, e.g. MNIST/CIFAR/Iris)`);
  noTestsTip(datasets, args);
}

export function doListKernels(index, args) {
  const kernels = dropTests(index.listKernels(args.filter), args);
  if (!kernels.length) {
    console.log('No GPU kernels found (no CUDA __global__/<<<>>>, Triton @triton.jit, '
      + 'or numba @cuda.jit).');
    return;
  }

  // Summary: defs / launches / device-fns, per family.
  const defs = kernels.filter(k => k.kind === 'kernel-def');
  const launches = kernels.filter(k => k.kind === 'launch');
  const devfns = kernels.filter(k => k.kind === 'device-fn');
  const byFamDef = {};
  for (const d of defs) byFamDef[d.family] = (byFamDef[d.family] || 0) + 1;
  const defSummary = Object.entries(byFamDef).sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results'))
    ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? kernels.slice(0, max) : kernels;

  console.log(`\n${defs.length} kernel defs (${defSummary}), ${launches.length} launches, `
    + `${devfns.length} device fns`
    + `${max > 0 && kernels.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  if (args.verbose) {
    for (const k of shown) {
      const tag = k.tag === 'heuristic' ? '~' : ' ';
      console.log(`${tag}${k.family.padEnd(13)} ${k.kind.padEnd(10)} ${(k.marker || '').padEnd(16)} ${k.name}`);
      console.log(`        ${(k.filepath || '').replace(/\\/g, '/')}:${k.line}${testTag(k)}  ${k.snippet}`);
    }
    return;
  }

  // #134 de-clutter: non-verbose collapses same-named repeats (family, kind, marker,
  // name) into one row + a count; distinct names keep their own row. -v (above) still
  // lists every instance. Grouping keeps the row count low, so no primary is capped.
  const groups = groupSites(kernels, KERNELS_DRILLDOWN.keyFn, KERNELS_DRILLDOWN.pick);
  console.log(`${'Family'.padEnd(13)}  ${'Kind'.padEnd(10)}  ${'Marker'.padEnd(16)}  ${'Name'.padEnd(28)}  Count`);
  console.log('='.repeat(80));
  for (const g of groups) {
    const k = g.rep;
    const fam = (k.tag === 'heuristic' ? '~' : '') + k.family;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${fam.slice(0, 13).padEnd(13)}  ${k.kind.padEnd(10)}  ${(k.marker || '').slice(0, 16).padEnd(16)}  ${(k.name || '(unnamed)').slice(0, 28).padEnd(28)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique kernel${groups.length === 1 ? '' : 's'} (${kernels.length} instance${kernels.length === 1 ? '' : 's'}); use -v to list every instance.`);
  noTestsTip(kernels, args);
}

export function doListMultimodal(index, args) {
  const items = dropTests(index.listMultimodal(args.filter), args);
  if (!items.length) {
    console.log('No multimodal/vision constructs found (no CLIP/ViT/ResNet/YOLO/'
      + 'diffusion/VLM markers).');
    return;
  }

  // Summary: count per kind (encoder/cnn-arch/detection-seg/generative/marker).
  const byKind = {};
  for (const t of items) byKind[t.kind] = (byKind[t.kind] || 0) + 1;
  const kindSummary = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results'))
    ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? items.slice(0, max) : items;

  console.log(`\n${items.length} multimodal/vision site${items.length === 1 ? '' : 's'} (${kindSummary})`
    + `${max > 0 && items.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  if (args.verbose) {
    for (const t of shown) {
      console.log(`~${(t.family || '?').padEnd(13)} ${t.kind.padEnd(14)} ${(t.marker || '').padEnd(16)} ${t.name}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    return;
  }

  // Non-verbose collapses same (family,kind,marker,name) repeats into one row +
  // a count; -v (above) still lists every instance.
  const groups = groupSites(items, MULTIMODAL_DRILLDOWN.keyFn, MULTIMODAL_DRILLDOWN.pick);
  console.log(`${'Family'.padEnd(14)}  ${'Kind'.padEnd(14)}  ${'Marker'.padEnd(16)}  ${'Name'.padEnd(20)}  Count`);
  console.log('='.repeat(80));
  for (const g of groups) {
    const t = g.rep;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`~${(t.family || '?').slice(0, 13).padEnd(13)}  ${t.kind.padEnd(14)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${(t.name || '(unnamed)').slice(0, 20).padEnd(20)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique multimodal marker${groups.length === 1 ? '' : 's'} (${items.length} instance${items.length === 1 ? '' : 's'}); use -v to list every instance.`);
  noTestsTip(items, args);
}

export function doListPostTraining(index, args) {
  const items = dropTests(index.listPostTraining(args.filter), args);
  if (!items.length) {
    console.log('No post-training/fine-tuning constructs found (no LoRA/PEFT, '
      + 'SFT/DPO/PPO/GRPO, or distillation markers).');
    return;
  }

  // Summary: count per kind (peft/alignment/distill).
  const byKind = {};
  for (const t of items) byKind[t.kind] = (byKind[t.kind] || 0) + 1;
  const kindSummary = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results'))
    ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? items.slice(0, max) : items;

  console.log(`\n${items.length} post-training/fine-tuning site${items.length === 1 ? '' : 's'} (${kindSummary})`
    + `${max > 0 && items.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  if (args.verbose) {
    for (const t of shown) {
      console.log(`~${(t.family || '?').padEnd(13)} ${t.kind.padEnd(14)} ${(t.marker || '').padEnd(16)} ${t.name}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    return;
  }

  // Non-verbose collapses same (family,kind,marker,name) repeats into one row +
  // a count; -v (above) still lists every instance.
  const groups = groupSites(items, POSTTRAINING_DRILLDOWN.keyFn, POSTTRAINING_DRILLDOWN.pick);
  console.log(`${'Family'.padEnd(14)}  ${'Kind'.padEnd(14)}  ${'Marker'.padEnd(16)}  ${'Name'.padEnd(20)}  Count`);
  console.log('='.repeat(80));
  for (const g of groups) {
    const t = g.rep;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`~${(t.family || '?').slice(0, 13).padEnd(13)}  ${t.kind.padEnd(14)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${(t.name || '(unnamed)').slice(0, 20).padEnd(20)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique post-training marker${groups.length === 1 ? '' : 's'} (${items.length} instance${items.length === 1 ? '' : 's'}); use -v to list every instance.`);
  noTestsTip(items, args);
}

// #146 reasoning-prompt language (CoT/reflection/scratchpad). Mirrors
// doListPostTraining (grouped table + -v full list), but with a PROMINENT
// labeled caveat after the table because the signal is prose-inferred.
export function doListReasoning(index, args) {
  const items = dropTests(index.listReasoning(args.filter), args);
  if (!items.length) {
    console.log('No reasoning-prompt language found (no chain-of-thought / '
      + '"step by step" / reflection / scratchpad phrasing).');
    return;
  }

  // Summary: count per kind (cot/reflection/scratchpad).
  const byKind = {};
  for (const t of items) byKind[t.kind] = (byKind[t.kind] || 0) + 1;
  const kindSummary = Object.entries(byKind).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results'))
    ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? items.slice(0, max) : items;

  console.log(`\n${items.length} reasoning-prompt site${items.length === 1 ? '' : 's'} (${kindSummary})`
    + `${max > 0 && items.length > max ? `; showing ${shown.length} rows` : ''}:\n`);

  const printCaveat = () => {
    console.log('');
    console.log('  Caveat: reasoning is inferred from prompt LANGUAGE ("think step by step",');
    console.log('  "reflect on…"), not code constructs — heuristic, and it does NOT detect');
    console.log('  structural reasoning like Tree-of-Thoughts.');
    console.log('');
  };

  if (args.verbose) {
    for (const t of shown) {
      console.log(`~${(t.family || '?').padEnd(16)} ${t.kind.padEnd(11)} ${(t.marker || '').padEnd(16)} ${t.name}`);
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}${testTag(t)}  ${t.snippet}`);
    }
    printCaveat();
    return;
  }

  // Non-verbose collapses same (family,kind,marker,name) repeats into one row +
  // a count; -v (above) still lists every instance.
  const groups = groupSites(items, REASONING_DRILLDOWN.keyFn, REASONING_DRILLDOWN.pick);
  console.log(`${'Family'.padEnd(16)}  ${'Kind'.padEnd(11)}  ${'Marker'.padEnd(16)}  ${'Name'.padEnd(20)}  Count`);
  console.log('='.repeat(80));
  for (const g of groups) {
    const t = g.rep;
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`~${(t.family || '?').slice(0, 15).padEnd(15)}  ${t.kind.padEnd(11)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${(t.name || '(unnamed)').slice(0, 20).padEnd(20)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique reasoning marker${groups.length === 1 ? '' : 's'} (${items.length} instance${items.length === 1 ? '' : 's'}); use -v to list every instance.`);
  noTestsTip(items, args);
  printCaveat();
}

// Show a filesystem path by basename (./models/foo.gguf -> foo.gguf) so long
// paths don't truncate; leave HF hub ids (org/model) and bare ids whole.
function basenameIfPath(v) {
  if (!v) return v;
  const looksPath = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(v)
    || /[\\/][^\\/]*\.(?:gguf|safetensors|onnx|ckpt|pth|pt|bin|h5)$/i.test(v);
  return looksPath ? (v.split(/[\\/]/).pop() || v) : v;
}

export function doListArtifacts(index, args) {
  const artifacts = dropTests(index.listArtifacts(args.filter), args);
  if (!artifacts.length) {
    console.log('No model artifacts found (no load/save sites for HF from_pretrained/'
      + 'state_dict, torch.save/load, safetensors, node-llama-cpp GGUF, or .gguf/'
      + '.safetensors/.onnx/.ckpt paths).');
    return;
  }

  // Summary by family, and a mechanical/heuristic split (honesty: heuristic
  // format-refs are hints, not confirmed load sites).
  const byFam = {};
  let mech = 0, heur = 0;
  for (const a of artifacts) {
    byFam[a.family] = (byFam[a.family] || 0) + 1;
    if (a.tag === 'heuristic') heur++; else mech++;
  }
  const summary = Object.entries(byFam).sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f} ${n}`).join(', ');

  const max = (args._explicit && args._explicit.has('max_results'))
    ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? artifacts.slice(0, max) : artifacts;

  console.log(`\n${artifacts.length} artifact sites (${summary}; ${mech} mechanical, ${heur} heuristic)`
    + `${max > 0 && artifacts.length > max ? `; showing ${shown.length}` : ''}:\n`);

  if (args.verbose) {
    // -v: full per-site line with the source snippet.
    for (const a of shown) {
      const dir = a.direction.padEnd(4);
      const tag = a.tag === 'heuristic' ? '~' : ' ';
      console.log(`${tag}${a.family.padEnd(14)} ${dir} ${a.format.padEnd(12)} ${(a.filepath || '').replace(/\\/g, '/')}:${a.line}${testTag(a)}`);
      console.log(`        ${a.snippet}`);
    }
    return;
  }

  // #134 de-clutter: collapse the same artifact id/path (e.g. one .gguf referenced
  // across N version-dirs) into one row + count; -v lists every site + snippet.
  const groups = groupSites(artifacts, ARTIFACTS_DRILLDOWN.keyFn, ARTIFACTS_DRILLDOWN.pick);
  console.log(`${'Family'.padEnd(14)}  ${'Format'.padEnd(12)}  ${'Path / name'.padEnd(44)}  Count`);
  console.log('='.repeat(82));
  for (const g of groups) {
    const a = g.rep;
    const fam = (a.tag === 'heuristic' ? '~' : '') + a.family;
    const name = (basenameIfPath(a.name) || a.format || '').slice(0, 43);
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${fam.slice(0, 14).padEnd(14)}  ${(a.format || '').slice(0, 12).padEnd(12)}  ${name.padEnd(44)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique artifact${groups.length === 1 ? '' : 's'} (${artifacts.length} site${artifacts.length === 1 ? '' : 's'}); use -v for every site + snippet.`);
  // #141 quantization caveat: the bare GPTQ/AWQ markers also match doc/comment
  // prose, so the count is a presence signal, not a precise code-site count.
  // Blank line before AND after so the note doesn't blend into adjacent sections.
  if (byFam['quantization']) {
    console.log(`\n  Caveat: quantization is a presence signal ("this code uses quantization"), not a`);
    console.log(`  precise site count — bare GPTQ/AWQ markers also match doc/comment mentions.`);
  }
  noTestsTip(artifacts, args);
}

export function doListModels(index, args) {
  let models = dropTests(index.listModels(args.filter), args);
  if (!models.length) {
    console.log('No model classes found (no class inheritance reaches a known ML '
      + 'model base: nn.Module, tf.Module, keras Layer/Model, sklearn BaseEstimator, ...).');
    return;
  }
  // Group/sort by framework, then by method count (desc).
  models.sort((a, b) =>
    (a.framework || '').localeCompare(b.framework || '')
    || (b.method_count - a.method_count));

  const byFw = {};
  for (const m of models) byFw[m.framework] = (byFw[m.framework] || 0) + 1;
  const summary = Object.entries(byFw).sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `${f} ${n}`).join(', ');

  // Show all by default (greppable, like --list-classes); cap only when the
  // user explicitly passes --max / --max-results / -n.
  const max = (args._explicit && args._explicit.has('max_results'))
    ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? models.slice(0, max) : models;

  console.log(`\n${models.length} model classes (${summary})`
    + `${max > 0 && models.length > max ? `; showing ${shown.length}` : ''}:\n`);

  if (args.verbose) {
    // -v: full inheritance chain per model (Class -> parent -> ... -> base),
    // plus method names and instantiation sites (#148).
    // Wrap a comma-joined name list at `width`, never splitting a name.
    const wrapList = (items, width = 88) => {
      const lines = []; let cur = '';
      for (const it of items) {
        if (cur && cur.length + it.length + 2 > width) { lines.push(cur + ','); cur = it; }
        else cur = cur ? `${cur}, ${it}` : it;
      }
      if (cur) lines.push(cur);
      return lines;
    };
    // Instantiation counts, single pass (#148): per-model findCallers (the
    // class digest's mechanism) costs ~0.3s per model — 474 sklearn models
    // took 130s. One combined-alternation regex over fileLines gives the same
    // bare-name "references that look like calls" semantics in seconds.
    // Bare-name caveat stands (#85): when a name has multiple class defs the
    // count may mix them, so it prints as ~N.
    const instByName = new Map();   // bare name -> { count, first }
    const instNames = [...new Set(shown.map(m => m.name))].filter(n => n.length >= 3);
    if (instNames.length) {
      const reInst = new RegExp(`\\b(${instNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*\\(`, 'g');
      for (const [fp, lines] of index.fileLines) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const t = line.trimStart();
          if (/^(?:class|def)\s/.test(t) || t.startsWith('#') || t.startsWith('//') || t.startsWith('*') || t.startsWith('>>>') || t.startsWith('...')) continue;  // decls/comments/doctest examples aren't instantiation
          reInst.lastIndex = 0;
          let mm;
          while ((mm = reInst.exec(line))) {
            const e = instByName.get(mm[1]) || { count: 0, first: null };
            e.count++;
            if (!e.first) e.first = { filepath: fp, line: i + 1 };
            instByName.set(mm[1], e);
          }
        }
      }
    }
    const defsByBare = new Map();
    for (const m of models) defsByBare.set(m.name, (defsByBare.get(m.name) || 0) + 1);
    let usedAmb = false;
    for (const m of shown) {
      const fw = (m.framework || '?') + (m.ambiguous ? '?' : '');
      const chain = (m.chain && m.chain.length) ? m.chain : [m.base];
      console.log(`${fw}  [${m.method_count}m]  ${m.name} → ${chain.join(' → ')}${testTag(m)}`);
      console.log(`        ${(m.filepath || '').replace(/\\/g, '/')}`);
      for (const line of wrapList(m.methods || [])) console.log(`          ${line}`);
      const inst = instByName.get(m.name);
      if (inst && inst.count) {
        const amb = (defsByBare.get(m.name) || 0) > 1 ? '~' : '';
        if (amb) usedAmb = true;
        console.log(`          inst: ${amb}${inst.count} site${inst.count > 1 ? 's' : ''} (first: ${(inst.first.filepath || '').replace(/\\/g, '/')}:${inst.first.line})`);
      }
    }
    if (usedAmb) console.log(`\n  (inst: ~N = bare-name count — same-named classes exist, sites may mix them; #85)`);
    console.log(`\n  Tip: --class-tree renders the full class hierarchy as a tree.`);
    console.log(`  Tip: --digest <Class> lists every instantiation with callers + source. Its`);
    console.log(`       "Instantiation sites" section counts ALL references (imports, isinstance,`);
    console.log(`       doc mentions), so it reads higher than inst:, which counts Class( call sites.`);
    return;
  }

  // #134 de-clutter: collapse same-named classes (repeats across files/versions)
  // into one row + count; -v lists each with its inheritance chain + filepath.
  const groups = groupSites(models, MODELS_DRILLDOWN.keyFn, MODELS_DRILLDOWN.pick);
  console.log(`${'Framework'.padEnd(14)}  ${'Meth'.padStart(5)}  ${'Class'.padEnd(34)}  ${'Extends'.padEnd(22)}  Count`);
  console.log('='.repeat(90));
  for (const g of groups) {
    const m = g.rep;
    const fw = ((m.framework || '?') + (m.ambiguous ? '?' : '')).slice(0, 14);
    const name = (m.name || '').slice(0, 33);
    const base = (m.base || '').slice(0, 21);
    const cnt = g.count > 1 ? `×${g.count}` : '';
    console.log(`${fw.padEnd(14)}  ${String(m.method_count).padStart(5)}  ${name.padEnd(34)}  ${base.padEnd(22)}  ${cnt}`);
  }
  console.log(`\n${groups.length} unique model${groups.length === 1 ? '' : 's'} (${models.length} instance${models.length === 1 ? '' : 's'}); use -v for inheritance chains, methods, and instantiation sites.`);
  console.log(`  Tip: --class-tree renders the full class hierarchy as a tree.`);
  noTestsTip(models, args, 'model classes');
}

export function doListClasses(index, args) {
  let classes = index.listClasses();

  classes = applyPathFilters(classes, args);

  if (args.filter) {
    const match = makeFilterMatcher(args.filter);
    classes = classes.filter(c => match(c.name));
  }

  if (!classes.length) {
    console.log('No classes found.');
    return;
  }

  classes.sort((a, b) => (b.total_method_lines || b.lines) - (a.total_method_lines || a.lines));

  // Hide classes with 0 methods and 0 lines unless verbose
  let hiddenCount = 0;
  if (!args.verbose) {
    const before = classes.length;
    classes = classes.filter(c => c.method_count > 0 || (c.total_method_lines || 0) > 0);
    hiddenCount = before - classes.length;
  }

  // Check for inferred and cross-file classes
  let hasCrossFile = false;
  let hasInferred = false;
  for (const c of classes) {
    if (c.inferred) hasInferred = true;
    const implFiles = new Set();
    for (const m of c.methods) {
      if (m.filepath && m.filepath !== c.filepath) implFiles.add(m.filepath);
    }
    c.impl_files = [...implFiles].sort();
    if (implFiles.size > 0) hasCrossFile = true;
  }

  console.log(`\n${classes.length} classes${hiddenCount ? ` (${hiddenCount} with 0 methods hidden; use -v to show all)` : ''}:\n`);

  if (args.verbose && hasCrossFile) {
    console.log(`${'Methods'.padStart(8)}  ${'MethLines'.padStart(10)}  ${'Class'.padEnd(35)}  ${'Declaration'.padEnd(40)}  Implementation`);
    console.log('='.repeat(140));

    for (const c of classes) {
      const inferMark = c.inferred ? '*' : ' ';
      const name = c.name.slice(0, 33);
      let decl = c.inferred ? '(inferred from ::)' : c.filepath;
      if (decl.length > 39) decl = '...' + decl.slice(-36);

      if (c.impl_files.length > 0) {
        let impl = c.impl_files[0];
        if (impl.length > 45) impl = '...' + impl.slice(-42);
        console.log(`${String(c.method_count).padStart(8)}  ${String(c.total_method_lines).padStart(10)} ${inferMark}${name.padEnd(35)}  ${decl.padEnd(40)}  ${impl}`);
        for (const implF of c.impl_files.slice(1)) {
          let imp = implF.length > 45 ? '...' + implF.slice(-42) : implF;
          console.log(`${''.padStart(8)}  ${''.padStart(10)}  ${''.padEnd(35)}  ${''.padEnd(40)}  ${imp}`);
        }
      } else {
        console.log(`${String(c.method_count).padStart(8)}  ${String(c.total_method_lines).padStart(10)} ${inferMark}${name.padEnd(35)}  ${decl.padEnd(40)}  (same file)`);
      }
    }

    if (hasInferred) {
      console.log(`\n  * = class inferred from ClassName:: in method names (no class declaration found)`);
    }
    if (hasCrossFile) {
      console.log(`\nTip: Use --verbose to see .h/.cpp cross-file method associations`);
    }
  } else {
    console.log(`${'Methods'.padStart(8)}  ${'MethLines'.padStart(10)}  ${'Class'.padEnd(40)}  ${'File'.padEnd(50)}`);
    console.log('='.repeat(115));

    for (const c of classes) {
      const inferMark = c.inferred ? '*' : ' ';
      const name = c.name.slice(0, 38);
      const fp = c.inferred ? '(inferred from ::)' : c.filepath.slice(0, 49);
      console.log(`${String(c.method_count).padStart(8)}  ${String(c.total_method_lines).padStart(10)} ${inferMark}${name.padEnd(40)}  ${fp.padEnd(50)}`);
    }

    if (hasInferred) {
      console.log(`\n  * = class inferred from ClassName:: in method names (no class declaration found)`);
    }
    if (hasCrossFile) {
      console.log(`\nTip: Use --verbose to see .h/.cpp cross-file method associations`);
    }
  }
}


// ========================================================================
// Class Hotspots
// ========================================================================

export function doClassHotspots(index, args) {
  const n = args.class_hotspots;
  const classes = index.getClassHotspots(n * 3, true);

  if (!classes.length) {
    console.log('No classes found.');
    return;
  }

  const matchClass = args.filter ? makeFilterMatcher(args.filter) : null;
  let filtered = [];
  for (const c of classes) {
    if (matchClass && !matchClass(c.name)) continue;
    filtered.push(c);
  }
  filtered = applyPathFilters(filtered, args);

  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} class hotspots (aggregated method calls x log2(method lines) / sqrt(defs)):`);
  console.log(`  ${'Score'.padStart(8)}  ${'Calls'.padStart(7)}  ${'Methods'.padStart(8)}  ${'MethLns'.padStart(8)}  ${'Defs'.padStart(5)}  ${'Class'.padEnd(35)}  File`);
  console.log(`  ${'-'.repeat(120)}`);

  for (const c of filtered.slice(0, n)) {
    let name = c.name;
    if (name.length > 34) name = name.slice(0, 31) + '...';
    let fp = args.full_path ? c.filepath : shortPath(c.filepath, 45);
    console.log(`  ${c.score.toFixed(0).padStart(8)}  ${String(c.total_calls).padStart(7)}  ${String(c.method_count).padStart(8)}  ${String(c.total_method_lines).padStart(8)}  ${String(c.name_count).padStart(5)}  ${name.padEnd(35)}  ${fp}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} classes. Use --class-hotspots ${n * 2} for more.`);
  }
}


// ========================================================================
// --discover-vocabulary / /vocabulary
// ========================================================================

export function doVocabulary(index, args) {
  const n = args.discover_vocabulary || 50;
  const filter = args.filter || null;
  const pathFilter = args.vocab_in || null;

  const topTokens = index.getTopVocabulary(n, filter, pathFilter);

  if (!topTokens.length) {
    console.log(pathFilter
      ? `No vocabulary tokens found in files matching '${pathFilter}'.`
      : 'No vocabulary tokens found.');
    return;
  }

  // For header stats, use the filtered or global vocab
  const vocab = pathFilter
    ? index.ensureVocabulary(false, pathFilter)
    : index.ensureVocabulary(false);
  const totalTokens = vocab.size;

  // Count matching files for header
  let fileCount;
  if (pathFilter) {
    const pat = pathFilter.toLowerCase();
    fileCount = [...index.files.keys()].filter(fp => fp.toLowerCase().includes(pat)).length;
  } else {
    fileCount = index.files.size;
  }

  const inLabel = pathFilter ? ` in '${pathFilter}' (${fileCount} files)` : '';
  console.log(`\nTop ${Math.min(n, topTokens.length)} domain vocabulary` +
    (filter ? ` matching '${filter}'` : '') +
    inLabel +
    ` (${totalTokens.toLocaleString()} unique tokens` +
    (!pathFilter ? `, ${fileCount.toLocaleString()} files` : '') + `):\n`);

  // Header
  console.log(`  ${'Score'.padStart(7)}  ${'Files'.padStart(5)}  ${'Hits'.padStart(6)}  ${'Token'.padEnd(35)}  Representative files`);
  console.log(`  ${'-'.repeat(110)}`);

  for (const entry of topTokens) {
    const scoreStr = entry.score.toFixed(0).padStart(7);
    const dfStr = String(entry.doc_freq).padStart(5);
    const tcStr = String(entry.total_count).padStart(6);
    const tokenStr = entry.token.padEnd(35);

    // Show top 2-3 representative files, abbreviated
    const repFiles = (entry.top_files || []).slice(0, 3)
      .map(f => {
        const p = args.full_path ? f.path : shortPath(f.path, 40);
        return `${p} (${f.count})`;
      })
      .join(', ');

    console.log(`  ${scoreStr}  ${dfStr}  ${tcStr}  ${tokenStr}  ${repFiles}`);
    console.log();
  }

  if (topTokens.length >= n) {
    console.log(`  Showing ${n}. Use --discover-vocabulary ${n * 2} for more.`);
  }
}
