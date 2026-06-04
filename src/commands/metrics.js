/**
 * metrics.js - Discovery/metrics commands: hotspots, hot-folders,
 * entry-points, domain-fns, gaps, list-classes, class-hotspots.
 * Port of ce_metrics.py
 */

import path from 'path';
import { eprint } from '../utils.js';


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

  let filtered = [];
  for (const h of hotspots) {
    const bare = bareName(h.name);
    if (bare.length < 2) continue;
    if (SKIP_KEYWORDS.has(bare)) continue;
    if (/^[A-Z][A-Z0-9_]+$/.test(bare) && bare.length >= 2) continue; // ALL_CAPS macros
    if (args.filter && !h.display_name.toLowerCase().includes(args.filter.toLowerCase()) &&
        !h.filepath.toLowerCase().includes(args.filter.toLowerCase())) continue;
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
    filtered = filtered.filter(([f]) => f.toLowerCase().includes(args.filter.toLowerCase()));
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

  let filtered = [];
  for (const e of entries) {
    const bare = bareName(e.name);
    if (bare.length < 2 || SKIP_KEYWORDS.has(bare)) continue;
    if (args.filter && !e.name.toLowerCase().includes(args.filter.toLowerCase())) continue;
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

  let filtered = [];
  for (const d of domain) {
    const bare = bareName(d.name);
    if (bare.length < 2 || skipKw.has(bare)) continue;
    if (args.filter && !d.name.toLowerCase().includes(args.filter.toLowerCase())) continue;
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
  const training = index.listTraining(args.filter);
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
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}  ${t.snippet}`);
    }
    return;
  }

  console.log(`${'Family'.padEnd(13)}  ${'Kind'.padEnd(17)}  ${'Marker'.padEnd(16)}  ${'Name'.padEnd(22)}  File:line`);
  console.log('='.repeat(112));
  for (const t of shown) {
    const fam = (t.tier === 'B' ? '~' : '') + t.family;
    let fp = (t.filepath || '').replace(/\\/g, '/');
    if (fp.length > 34) fp = '...' + fp.slice(-31);
    console.log(`${fam.slice(0, 13).padEnd(13)}  ${t.kind.padEnd(17)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${(t.name || '').slice(0, 22).padEnd(22)}  ${fp}:${t.line}`);
  }
  if (tierB) console.log(`\n  (~ = heuristic .fit() call — gated on ML imports, def-fit excluded)`);
}

// Scope caption (#106) — shown on every Chains/Agents view so a 0 isn't misread.
const CHAINS_SCOPE = 'Scope: framework primitives (LangChain/LangGraph/DSPy/CrewAI/AutoGen/LlamaIndex) '
  + 'PLUS a heuristic hand-rolled-agent flag (a module that loops over an LLM call while dispatching '
  + 'tools). The hand-rolled flag needs real module boundaries — on a single minified bundle it is '
  + 'degenerate; use a bundle-seam-split (--split-bundle) index. LCEL `|` pipelines are still not '
  + 'detected; Detection keys on JS/TS + Python idioms (Rust/Go not yet — #108), so a low/zero count is not proof there is no agent.';

export function doListEmbeddings(index, args) {
  const items = index.listEmbeddings(args.filter);
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
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}  ${t.snippet}`);
    }
    return;
  }

  console.log(`${'Kind'.padEnd(13)}  ${'Framework'.padEnd(20)}  ${'Marker'.padEnd(24)}  ${'Model / id'.padEnd(34)}  File:line`);
  console.log('='.repeat(144));
  for (const t of shown) {
    const kind = (t.tag === 'heuristic' ? '~' : '') + t.kind;
    let fp = (t.filepath || '').replace(/\\/g, '/');
    if (fp.length > 32) fp = '...' + fp.slice(-29);
    console.log(`${kind.slice(0, 13).padEnd(13)}  ${(t.framework || '').slice(0, 20).padEnd(20)}  ${(t.marker || '').slice(0, 24).padEnd(24)}  ${(basenameIfPath(t.id) || '').slice(0, 34).padEnd(34)}  ${fp}:${t.line}`);
  }
  const unres = items.filter(t => t.id && t.resolved === false).length;
  if (heur) console.log(`\n  (~ = heuristic/gated; distance is co-occurrence-gated on an embedding/vector marker. RAG = this + an LLM call, #103.)`);
  console.log(`  (Model / id = embedding model or vector index/collection; <var>${unres ? ` (${unres})` : ''} = unresolved in-file.)`);
}

export function doListModelsUsed(index, args) {
  const models = index.listModelsUsed(args.filter);
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
      console.log(`${m.access.padEnd(6)} ${basenameIfPath(m.model)}  (${m.cells.join(', ')}, ${m.count} site${m.count > 1 ? 's' : ''})`);
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
}

export function doListStructuredOutput(index, args) {
  const items = index.listStructuredOutput(args.filter);
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
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}  ${t.snippet}`);
    }
    return;
  }
  console.log(`${'Kind'.padEnd(12)}  ${'Framework'.padEnd(16)}  ${'Marker'.padEnd(24)}  ${'Schema'.padEnd(28)}  File:line`);
  console.log('='.repeat(122));
  for (const t of shown) {
    const kind = (t.tag === 'heuristic' ? '~' : '') + t.kind;
    let fp = (t.filepath || '').replace(/\\/g, '/');
    if (fp.length > 32) fp = '...' + fp.slice(-29);
    console.log(`${kind.slice(0, 12).padEnd(12)}  ${(t.framework || '').slice(0, 16).padEnd(16)}  ${(t.marker || '').slice(0, 24).padEnd(24)}  ${(t.id || '').slice(0, 28).padEnd(28)}  ${fp}:${t.line}`);
  }
  if (heur) console.log(`\n  (~ = heuristic/gated; bare BaseModel/Zod NOT counted — only schemas bound to an LLM call. Schema = the bound output type.)`);
}

export function doListPipelines(index, args) {
  const flows = index.listPipelines(args.filter);
  if (!flows.length) {
    console.log('No AI/ML pipelines found (no file or leaf-folder where 2+ cells co-occur to form a '
      + 'RAG / low-level / training / inference / agent / LLM-app shape). Single-cell usage is not a pipeline.');
    return;
  }
  const byShape = {}, byScope = {};
  for (const w of flows) { byShape[w.shape] = (byShape[w.shape] || 0) + 1; byScope[w.scope] = (byScope[w.scope] || 0) + 1; }
  const shapeSummary = ['RAG', 'low-level', 'training', 'agent', 'inference', 'LLM-app'].filter(s => byShape[s]).map(s => `${byShape[s]} ${s}`).join(', ');
  const scopeSummary = ['file', 'folder', 'module'].filter(s => byScope[s]).map(s => `${byScope[s]} ${s}`).join(', ');
  const max = (args._explicit && args._explicit.has('max_results')) ? (Number(args.max_results) || 0) : 0;
  const shown = max > 0 ? flows.slice(0, max) : flows;
  console.log(`\n${flows.length} pipelines — ${shapeSummary} (${scopeSummary})${max > 0 && flows.length > max ? `; showing ${shown.length}` : ''}:\n`);
  const stagesStr = (w) => w.stages.map(s => s.cell + (s.ids.length ? `(${basenameIfPath(s.ids[0])}${s.ids.length > 1 ? ',…' : ''})` : '')).join(' → ');
  if (args.verbose) {
    for (const w of shown) {
      console.log(`${w.scope.padEnd(6)} ${w.shape.padEnd(9)} ${w.location.replace(/\\/g, '/')}${w.shapes.length > 1 ? `  [also: ${w.shapes.slice(1).join(', ')}]` : ''}`);
      console.log(`        ${stagesStr(w)}`);
    }
    return;
  }
  console.log(`${'Shape'.padEnd(9)}  ${'Scope'.padEnd(6)}  ${'Location'.padEnd(34)}  Stages`);
  console.log('='.repeat(140));
  for (const w of shown) {
    let loc = w.location.replace(/\\/g, '/'); if (loc.length > 34) loc = '...' + loc.slice(-31);
    console.log(`${w.shape.padEnd(9)}  ${w.scope.padEnd(6)}  ${loc.padEnd(34)}  ${stagesStr(w).slice(0, 80)}`);
  }
  console.log(`\n  (Pipelines = AI/ML pipelines inferred from cell CO-OCCURRENCE (file, or leaf folder), NOT traced dataflow.`
    + ` scope:folder = same leaf folder; scope:module = climbed to a common ancestor (looser, capped at the repo root). Import-graph assembly + a graph view are deferred. Shapes by specificity: RAG>low-level>training>agent>inference>LLM-app.)`);
}

export function doListChains(index, args) {
  const chains = index.listChains(args.filter);
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
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}  ${t.snippet}`);
    }
    console.log(`\n  (${CHAINS_SCOPE})`);
    return;
  }

  console.log(`${'Framework'.padEnd(12)}  ${'Kind'.padEnd(7)}  ${'Marker'.padEnd(22)}  ${'Name'.padEnd(20)}  File:line`);
  console.log('='.repeat(108));
  for (const t of shown) {
    const fw = (t.tag === 'heuristic' ? '~' : '') + (t.framework || '');
    let fp = (t.filepath || '').replace(/\\/g, '/');
    if (fp.length > 30) fp = '...' + fp.slice(-27);
    console.log(`${fw.slice(0, 12).padEnd(12)}  ${t.kind.padEnd(7)}  ${(t.marker || '').slice(0, 22).padEnd(22)}  ${(t.name || '').slice(0, 20).padEnd(20)}  ${fp}:${t.line}`);
  }
  console.log(`\n  (${CHAINS_SCOPE})`);
}

export function doListTools(index, args) {
  const tools = index.listTools(args.filter);
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
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}  ${t.snippet}`);
    }
    return;
  }

  console.log(`${'Framework'.padEnd(18)}  ${'Kind'.padEnd(13)}  ${'Marker'.padEnd(16)}  ${'Tool name(s)'.padEnd(26)}  File:line`);
  console.log('='.repeat(118));
  for (const t of shown) {
    const fw = (t.tag === 'heuristic' ? '~' : '') + (t.framework || '');
    let fp = (t.filepath || '').replace(/\\/g, '/');
    if (fp.length > 30) fp = '...' + fp.slice(-27);
    const nm = (t.name || '') + (t.lvc ? ' [lib?]' : '');
    console.log(`${fw.slice(0, 18).padEnd(18)}  ${t.kind.padEnd(13)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${nm.slice(0, 26).padEnd(26)}  ${fp}:${t.line}`);
  }
  if (heur) console.log(`\n  (~ = heuristic, gated on LLM/MCP context; [lib?] = library-vs-consumer over-fire; blank name = not statically extractable)`);
}

export function doListLlmCalls(index, args) {
  const calls = index.listLlmCalls(args.filter);
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
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}  ${t.snippet}`);
    }
    return;
  }

  console.log(`${'Provider'.padEnd(11)}  ${'Kind'.padEnd(9)}  ${'T'.padEnd(2)}  ${'Marker'.padEnd(26)}  ${'Model'.padEnd(28)}  File:line`);
  console.log('='.repeat(138));
  for (const t of shown) {
    const prov = (t.tag === 'heuristic' ? '~' : '') + t.provider;
    let fp = (t.filepath || '').replace(/\\/g, '/');
    if (fp.length > 38) fp = '...' + fp.slice(-35);
    console.log(`${prov.slice(0, 11).padEnd(11)}  ${t.kind.padEnd(9)}  ${('T' + t.tier).padEnd(2)}  ${((t.marker || '') + (t.lvc ? ' [lib?]' : '')).slice(0, 26).padEnd(26)}  ${basenameIfPath(t.model || '').slice(0, 28).padEnd(28)}  ${fp}:${t.line}`);
  }
  const unresolved = calls.filter(t => t.model && !t.modelResolved).length;
  if (heur) console.log(`\n  (~ = heuristic; T = A SDK marker / B gated verb / C endpoint URL; [lib?] = library-vs-consumer over-fires)`);
  console.log(`  (Model from model=/model_path= arg, resolved via same-file assignment / argparse default where possible; <var>${unresolved ? ` (${unresolved} here)` : ''} = couldn't resolve to a literal in-file)`);
}

export function doListInference(index, args) {
  const inf = index.listInference(args.filter);
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
      console.log(`        ${(t.filepath || '').replace(/\\/g, '/')}:${t.line}  ${t.snippet}`);
    }
    return;
  }

  console.log(`${'Family'.padEnd(13)}  ${'Kind'.padEnd(11)}  ${'T'.padEnd(2)}  ${'Marker'.padEnd(16)}  ${'Name (→ model)'.padEnd(30)}  File:line`);
  console.log('='.repeat(120));
  for (const t of shown) {
    const fam = (t.tag === 'heuristic' ? '~' : '') + t.family;
    let fp = (t.filepath || '').replace(/\\/g, '/');
    if (fp.length > 32) fp = '...' + fp.slice(-29);
    const nm = (t.name || '') + (t.id ? ' → ' + basenameIfPath(t.id) : '');
    console.log(`${fam.slice(0, 13).padEnd(13)}  ${t.kind.padEnd(11)}  ${('T' + t.tier).padEnd(2)}  ${(t.marker || '').slice(0, 16).padEnd(16)}  ${nm.slice(0, 30).padEnd(30)}  ${fp}:${t.line}`);
  }
  if (heur) console.log(`\n  (~ = heuristic/gated; T = tier A clean / B gated calls / C co-occurrence-gated params; → model = pipeline(model=…))`);
}

export function doListDatasets(index, args) {
  const datasets = index.listDatasets(args.filter);
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
      console.log(`        ${(d.filepath || '').replace(/\\/g, '/')}:${d.line}  ${d.snippet}`);
    }
    return;
  }

  console.log(`${'Family'.padEnd(13)}  ${'Kind'.padEnd(11)}  ${'Marker'.padEnd(20)}  ${'Name'.padEnd(40)}  File:line`);
  console.log('='.repeat(128));
  for (const d of shown) {
    const fam = (d.builtin ? '*' : '') + d.family;
    let fp = (d.filepath || '').replace(/\\/g, '/');
    if (fp.length > 36) fp = '...' + fp.slice(-33);
    console.log(`${fam.slice(0, 13).padEnd(13)}  ${d.kind.padEnd(11)}  ${(d.marker || '').slice(0, 20).padEnd(20)}  ${(basenameIfPath(d.name) || '').slice(0, 40).padEnd(40)}  ${fp}:${d.line}`);
  }
  if (builtins) console.log(`\n  (* = built-in dataset — framework-provided standard/benchmark data, e.g. MNIST/CIFAR/Iris)`);
}

export function doListKernels(index, args) {
  const kernels = index.listKernels(args.filter);
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
      console.log(`        ${(k.filepath || '').replace(/\\/g, '/')}:${k.line}  ${k.snippet}`);
    }
    return;
  }

  console.log(`${'Family'.padEnd(13)}  ${'Kind'.padEnd(10)}  ${'Marker'.padEnd(16)}  ${'Name'.padEnd(28)}  File:line`);
  console.log('='.repeat(110));
  for (const k of shown) {
    const fam = (k.tag === 'heuristic' ? '~' : '') + k.family;
    let fp = (k.filepath || '').replace(/\\/g, '/');
    if (fp.length > 38) fp = '...' + fp.slice(-35);
    console.log(`${fam.slice(0, 13).padEnd(13)}  ${k.kind.padEnd(10)}  ${(k.marker || '').slice(0, 16).padEnd(16)}  ${(k.name || '').slice(0, 28).padEnd(28)}  ${fp}:${k.line}`);
  }
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
  const artifacts = index.listArtifacts(args.filter);
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
      console.log(`${tag}${a.family.padEnd(14)} ${dir} ${a.format.padEnd(12)} ${(a.filepath || '').replace(/\\/g, '/')}:${a.line}`);
      console.log(`        ${a.snippet}`);
    }
    return;
  }

  console.log(`${'Family'.padEnd(14)}  ${'Dir'.padEnd(4)}  ${'Format'.padEnd(12)}  ${'Path / name'.padEnd(40)}  File:line`);
  console.log('='.repeat(120));
  for (const a of shown) {
    const fam = (a.tag === 'heuristic' ? '~' : '') + a.family;
    const name = (basenameIfPath(a.path) || a.format || '').slice(0, 39);
    let fp = (a.filepath || '').replace(/\\/g, '/');
    if (fp.length > 40) fp = '...' + fp.slice(-37);
    console.log(`${fam.slice(0, 14).padEnd(14)}  ${a.direction.padEnd(4)}  ${a.format.slice(0, 12).padEnd(12)}  ${name.padEnd(40)}  ${fp}:${a.line}`);
  }
}

export function doListModels(index, args) {
  let models = index.listModels(args.filter);
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
    // -v: full inheritance chain per model (Class -> parent -> ... -> base).
    for (const m of shown) {
      const fw = (m.framework || '?') + (m.ambiguous ? '?' : '');
      const chain = (m.chain && m.chain.length) ? m.chain : [m.base];
      console.log(`${fw}  [${m.method_count}m]  ${m.name} → ${chain.join(' → ')}`);
      console.log(`        ${(m.filepath || '').replace(/\\/g, '/')}`);
    }
    return;
  }

  console.log(`${'Framework'.padEnd(14)}  ${'Meth'.padStart(5)}  ${'Class'.padEnd(34)}  ${'Extends'.padEnd(22)}  Filepath`);
  console.log('='.repeat(118));
  for (const m of shown) {
    const fw = ((m.framework || '?') + (m.ambiguous ? '?' : '')).slice(0, 14);
    const name = m.name.slice(0, 33);
    const base = (m.base || '').slice(0, 21);
    let fp = (m.filepath || '').replace(/\\/g, '/');
    if (fp.length > 48) fp = '...' + fp.slice(-45);
    console.log(`${fw.padEnd(14)}  ${String(m.method_count).padStart(5)}  ${name.padEnd(34)}  ${base.padEnd(22)}  ${fp}`);
  }
}

export function doListClasses(index, args) {
  let classes = index.listClasses();

  classes = applyPathFilters(classes, args);

  if (args.filter) {
    const fl = args.filter.toLowerCase();
    classes = classes.filter(c => c.name.toLowerCase().includes(fl));
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

  let filtered = [];
  for (const c of classes) {
    if (args.filter && !c.name.toLowerCase().includes(args.filter.toLowerCase())) continue;
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
