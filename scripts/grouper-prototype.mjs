#!/usr/bin/env node
// grouper-prototype.mjs - #284 phase 1: OBSERVE-ONLY deterministic mechanism
// clusterer, measured against a hand-authored ground-truth anchor set.
//
// It does NOT drive --pseudo-claims and does NOT rank worthiness (later #284
// items). It answers one falsifiable question: how far does clustering CE's
// *available* deterministic edges (co-location, call, shared-vocabulary,
// name-prefix, import) get toward reproducing the ground-truth mechanism groups
// in ce_anchors.lst / bram_anchors.lst - and, per the #280 rationale, where the
// absence of shared-resource edges makes it fail (Bram's cross-language groups).
//
// Usage:
//   node scripts/grouper-prototype.mjs --index-path <idx> --ground-truth <anchors.lst>
//
// Everything here is deterministic. No LLM. The worthiness scorer (the one
// bounded LLM seam) is a later item; this measures the clustering substrate.

import fs from 'node:fs';
import path from 'node:path';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { findCallees } from '../src/core/calls.js';
import { isIntrinsicName, extractConcepts, _isNoiseDoc } from '../src/core/vocabulary.js';

// --- tunables (printed with the results so a run is self-documenting) --------
const MIN_LINES = 4;                 // skip one-liner getters/wrappers
const RARE_DF_MIN = 2, RARE_DF_MAX = 25; // a "rare" token: shared by few functions
// co-location is a WEAK prior (a monolithic file must not merge all its
// mechanisms); the discriminating work is call / prefix / vocab.
const W = { file: 0.15, dir: 0.05, call: 2.0, vocabPerTok: 0.6, vocabCap: 2.0, prefix: 2.0, importEdge: 0.3 };
const LP_ITERS = 25;                 // weighted label-propagation passes
const COLOC_MAX_FILE = 300;          // skip all-pairs co-location for files bigger than this: O(n^2) blows up (27k-fn bundled JS) AND a huge file needs finer signal than "same file" anyway
// intra-file split (lessons 1+3 from the 7-corpus study): co-location lumps a
// monolith's many mechanisms (Bram lib.rs = 7 GT groups in one file). Split a
// file into sub-communities using SAME-FILE-ONLY edges, with a guardrail so a
// cohesive single-mechanism file (WinAPI/Codex/Android) is NOT shattered.
// SPLIT is SIZE-GATED: below this a file is assumed one mechanism, because a
// cohesive class (39-fn WinAPI CIM, 40-fn Codex module) ALSO modularly separates
// into sub-communities (get/set families), so "has substructure" can't tell a
// single mechanism from a monolith of distinct ones - only outlier SIZE can. Set
// above real single-mechanism files (~<=40 fns) so only true monoliths (lib.rs =
// 843) split. Overfit risk acknowledged: a genuine 50-fn multi-mechanism file
// won't split; that is the honest cost of the size gate.
const SPLIT_MIN = Number((process.argv.indexOf('--split-min') >= 0 ? process.argv[process.argv.indexOf('--split-min') + 1] : '')) || 50;
const SPLIT_RESOLUTION = Number((process.argv.indexOf('--split-res') >= 0 ? process.argv[process.argv.indexOf('--split-res') + 1] : '')) || 1.0; // Louvain gamma: <1 -> fewer/larger communities (less fragmentation)
const MIN_COMM = 3;                   // a real sub-mechanism community has >= this many funcs
const RARE_INFILE_MAX = 8;            // within a file, a token shared by 2..this many funcs is a mechanism signal; MORE than this is a language idiom / file-wide glue that collapses the split (an 843-fn lib.rs at a fractional cap fused into one blob)
const Wsplit = { vocab: 0.6, vocabCap: 2.0 }; // within-file vocab weight (call/prefix reuse global W)
const EDGE_SETS = [
  ['coloc'],
  ['coloc', 'call'],
  ['coloc', 'call', 'prefix'],
  ['coloc', 'call', 'prefix', 'vocab'],
  ['coloc', 'call', 'prefix', 'vocab', 'import'],
];

// --- args --------------------------------------------------------------------
function arg(name, def = null) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const indexPath = arg('--index-path');
const gtPath = arg('--ground-truth');
const MAX_FUNCS = Number(arg('--max-funcs', '')) || Infinity; // cap candidates on huge indexes for a tractable eyeball
const emitPath = arg('--emit-anchors'); // #284: write [file]-mode clusters as a draft anchors.lst, then exit
// Mechanical noise pre-filter for --emit-anchors (#284): drop whole noise files
// (test / vendor / minified / build / lockfile via the shared _isNoiseDoc, plus
// dist/ compiled output and OLD/dead files) from the candidate set BEFORE the
// --max-funcs cap, so junk doesn't eat the budget or the reviewer's firehose.
// JUNK REMOVAL ONLY — the surviving groups are still per-file. Emit-mode only.
//
// CAVEAT for a future worthiness/claim stage (noted per Andrew, 2026-07-25):
// this is a BLUNT cut, and some categories dropped here can be legitimately
// patentable subject matter — TESTING frameworks/methods especially are the
// subject of many patents. Anything filtered at this stage is invisible to the
// later worthiness scorer FOREVER, and there is no cheap false-positive check
// here (a file dropped for containing "test" is simply never seen). If that
// matters, revisit as a RECOVERABLE filter — tag-and-demote so the worthiness
// stage can still reach it — rather than a hard drop.
const isNoiseFile = (file) => {
  if (_isNoiseDoc(file, null)) return true;                   // vendor/build/lockfile/test-DIR/.op/.nupkg (path-based)
  const n = String(file).replace(/\\/g, '/');
  const base = n.slice(n.lastIndexOf('/') + 1);
  // _isNoiseDoc's test detection is DIRECTORY-based (test/ trees); add the
  // filename-suffix conventions it misses — Google-style foo_test.cc /
  // foo_unittest.cc next to foo.cc (chromium), UnitTests.cs, jest/pytest/rspec.
  // Boundary-guarded so class files like TestActivity.java are NOT swept.
  if (/(?:^|[._-])(?:(?:unit)?tests?|specs?)(?:[._-]|$)/i.test(base)) return true;
  return /\/dist\//i.test(n) || /_old\d*[._-]|\.old$|_bak[._-]|~$/i.test(n); // dist output + dead/backup files
};
let emitNoiseFiles = 0, emitNoiseFns = 0;
if (!indexPath) { console.error('need --index-path (--ground-truth optional: omit for an unscored cluster dump to eyeball)'); process.exit(1); }

// --- load index --------------------------------------------------------------
const index = new CodeSearchIndex({ indexPath });
index._ensureFunctionIndex();
if (!emitPath && (!index.fileLines || index.fileLines.size === 0)) {
  // --emit-anchors ([file] mode) needs only the function index, not file
  // content (no vocab/source edges), so skip the potentially-huge literal-index
  // load for it (spinellis: 437MB).
  if (typeof index._loadLiteralIndex === 'function') index._loadLiteralIndex();
}

// --- enumerate candidate functions ------------------------------------------
const funcs = [];               // {id, file, name, bare, start, end, lines}
const byId = new Map();
for (const [file, fns] of Object.entries(index.functionIndex || {})) {
  if (emitPath && isNoiseFile(file)) { emitNoiseFiles++; emitNoiseFns += Object.keys(fns).length; continue; }
  for (const [full, info] of Object.entries(fns)) {
    if ((info.type || 'function') === 'class') continue;
    const bare = (info.base_name || full.split('::').pop() || '').split('@')[0];
    if (!bare || isIntrinsicName(bare)) continue;
    const lines = (info.end || 0) - (info.start || 0) + 1;
    if (lines < MIN_LINES) continue;
    const id = `${file}@${full}`;
    const f = { id, file, name: full, bare, start: info.start, end: info.end, lines };
    funcs.push(f); byId.set(id, f);
  }
}
if (funcs.length > MAX_FUNCS) {
  // Cap for perf, but keep ground-truth files fully in the candidate set — else
  // scored recall is capped by truncation, not by clustering.
  let keep;
  if (gtPath) {
    const gtFiles = new Set();
    for (const raw of fs.readFileSync(gtPath, 'utf8').split(/\r?\n/)) { const l = raw.trim(); if (!l || l.startsWith('#')) continue; const at = l.lastIndexOf('@'); if (at > 0) gtFiles.add(l.slice(0, at)); }
    const inGt = funcs.filter((f) => gtFiles.has(f.file));
    const rest = funcs.filter((f) => !gtFiles.has(f.file)).slice(0, Math.max(0, MAX_FUNCS - inGt.length));
    keep = [...inGt, ...rest];
  } else keep = funcs.slice(0, MAX_FUNCS);
  funcs.length = 0; funcs.push(...keep);
}
const byBare = new Map();
for (const f of funcs) (byBare.get(f.bare) || byBare.set(f.bare, []).get(f.bare)).push(f);

// --- edge builders (each returns Map "idA idB" -> weight, A<B) ----------
const SEP = String.fromCharCode(0); // ids can contain spaces (bundled-JS anon fns)
const pairKey = (a, b) => (a < b ? a + SEP + b : b + SEP + a);
function addWeight(map, a, b, w) { if (a === b) return; const k = pairKey(a, b); map.set(k, (map.get(k) || 0) + w); }

const _tokCache = new Map();          // id -> Set(token), shared by vocab edges and the split
const _tokRe = /[A-Za-z_][A-Za-z0-9_]{2,}/g;
function tokenSetOf(f) {
  let s = _tokCache.get(f.id); if (s) return s;
  s = new Set();
  const src = index.getFunctionSource(f.file, f.name) || '';
  for (const mm of src.matchAll(_tokRe)) { const t = mm[0]; if (isIntrinsicName(t)) continue; s.add(t); }
  _tokCache.set(f.id, s); return s;
}

function edgesColoc() {
  const m = new Map();
  const byFile = new Map(), byDir = new Map();
  for (const f of funcs) {
    (byFile.get(f.file) || byFile.set(f.file, []).get(f.file)).push(f);
    const d = path.posix.dirname(f.file.replace(/\\/g, '/'));
    (byDir.get(d) || byDir.set(d, []).get(d)).push(f);
  }
  // Degree-normalize by file size: a same-file edge weight is W.file / sqrt(N-1)
  // so a monolithic file's clique can't dominate by sheer edge mass (the Bram
  // lib.rs collapse). Small mechanism-aligned files keep a meaningful prior.
  for (const arr of byFile.values()) { if (arr.length < 2 || arr.length > COLOC_MAX_FILE) continue; const w = W.file / Math.sqrt(arr.length - 1); for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) addWeight(m, arr[i].id, arr[j].id, w); }
  for (const arr of byDir.values()) { if (arr.length < 2 || arr.length > 200) continue; const w = W.dir / Math.sqrt(arr.length - 1); for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) addWeight(m, arr[i].id, arr[j].id, w); }
  return m;
}

function edgesCall() {
  const m = new Map();
  for (const f of funcs) {
    let callees = [];
    try { callees = findCallees(index, f.name, f.file) || []; } catch { callees = []; }
    for (const c of callees) {
      const cb = (c.name || c.display_name || '').split('::').pop();
      if (!cb) continue;
      // Only UNAMBIGUOUS callees: a bare name resolving to exactly one in-index
      // function. Ambiguous common names (a shared helper) otherwise connect
      // everything into one blob (the connected-components failure).
      const cands = (byBare.get(cb) || []).filter((g) => g.id !== f.id);
      if (cands.length === 1) addWeight(m, f.id, cands[0].id, W.call);
    }
  }
  return m;
}

function prefixKey(bare) {
  // snake_case -> first two segments; camelCase -> first two words; strip leading _
  const s = bare.replace(/^_+/, '');
  if (s.includes('_')) { const p = s.split('_').filter(Boolean); return p.slice(0, 2).join('_'); }
  const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join('').toLowerCase();
}
function edgesPrefix() {
  const m = new Map(), byPfx = new Map();
  for (const f of funcs) { const k = prefixKey(f.bare); if (k.length < 5) continue; (byPfx.get(k) || byPfx.set(k, []).get(k)).push(f); }
  for (const arr of byPfx.values()) { if (arr.length < 2 || arr.length > 40) continue; for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) addWeight(m, arr[i].id, arr[j].id, W.prefix); }
  return m;
}

function edgesVocab() {
  const m = new Map();
  const df = new Map();          // token -> #functions
  for (const f of funcs) for (const t of tokenSetOf(f)) df.set(t, (df.get(t) || 0) + 1);
  const inv = new Map();         // rare token -> [ids]
  for (const f of funcs) for (const t of tokenSetOf(f)) { const d = df.get(t); if (d >= RARE_DF_MIN && d <= RARE_DF_MAX) (inv.get(t) || inv.set(t, []).get(t)).push(f.id); }
  for (const ids of inv.values()) { if (ids.length < 2 || ids.length > RARE_DF_MAX) continue; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const cur = m.get(pairKey(ids[i], ids[j])) || 0; if (cur < W.vocabCap) addWeight(m, ids[i], ids[j], W.vocabPerTok); } }
  return m;
}

function edgesImport() {
  // Lightweight file->file import edges parsed from file heads (no CE digest
  // internals), lifted to all function pairs across the two files (weak).
  const m = new Map();
  const fnsByFile = new Map();
  for (const f of funcs) (fnsByFile.get(f.file) || fnsByFile.set(f.file, []).get(f.file)).push(f);
  const files = [...fnsByFile.keys()];
  const impRe = /(?:from\s+|require\(\s*|import\s+)['"]([^'"]+)['"]/g;
  for (const file of files) {
    const lines = index.fileLines.get(file); if (!lines) continue;
    const head = lines.slice(0, 60).join('\n');
    const targets = new Set();
    for (const mm of head.matchAll(impRe)) {
      const spec = mm[1]; if (!spec.startsWith('.')) continue; // local imports only
      const baseNoExt = path.posix.basename(spec).replace(/\.(m?js|ts|jsx|tsx)$/, '');
      for (const other of files) { if (other === file) continue; if (path.posix.basename(other.replace(/\\/g, '/')).replace(/\.[^.]+$/, '') === baseNoExt) targets.add(other); }
    }
    for (const t of targets) for (const a of fnsByFile.get(file)) for (const b of (fnsByFile.get(t) || [])) addWeight(m, a.id, b.id, W.importEdge);
  }
  return m;
}

const BUILDERS = { coloc: edgesColoc, call: edgesCall, prefix: edgesPrefix, vocab: edgesVocab, import: edgesImport };
const edgeCache = {};
function getEdges(kind) { return (edgeCache[kind] ||= BUILDERS[kind]()); }

// --- clustering: weighted label propagation (community detection) ------------
// Connected-components collapses a densely-connected call/vocab graph into one
// blob; label propagation finds DENSE communities instead. Deterministic: fixed
// node order, switch a node's label only on a STRICTLY greater neighbor-weight
// sum (ties keep current) so it converges without oscillation.
function cluster(edgeKinds) {
  const adj = new Map(); funcs.forEach((f) => adj.set(f.id, new Map()));
  const summed = new Map();
  for (const kind of edgeKinds) for (const [k, w] of getEdges(kind)) summed.set(k, (summed.get(k) || 0) + w);
  for (const [k, w] of summed) { const [a, b] = k.split(SEP); adj.get(a).set(b, w); adj.get(b).set(a, w); }
  const label = new Map(); funcs.forEach((f, i) => label.set(f.id, i));
  for (let iter = 0; iter < LP_ITERS; iter++) {
    let changed = 0;
    for (const f of funcs) {
      const nbrs = adj.get(f.id); if (nbrs.size === 0) continue;
      const score = new Map();
      for (const [nb, w] of nbrs) { const l = label.get(nb); score.set(l, (score.get(l) || 0) + w); }
      let bestL = label.get(f.id), bestW = score.get(bestL) || 0;
      for (const [l, w] of score) if (w > bestW) { bestW = w; bestL = l; }
      if (bestL !== label.get(f.id)) { label.set(f.id, bestL); changed++; }
    }
    if (changed === 0) break;
  }
  const clusters = new Map();
  for (const f of funcs) { const l = label.get(f.id); (clusters.get(l) || clusters.set(l, new Set()).get(l)).add(f.id); }
  return [...clusters.values()];
}

// --- intra-file split --------------------------------------------------------
// Same-file-only edges used to split a monolith into its mechanisms. Crucially
// NOT the global call graph (that over-merged Chromium): call/prefix are filtered
// to same-file pairs, and vocab is computed PER FILE (skipping file-wide
// boilerplate) so mechanism-specific tokens glue mechanism-mates while a class's
// universal field names don't fuse everything.
let _splitEdges = null;
function splitEdges() {
  if (_splitEdges) return _splitEdges;
  const m = new Map();
  const byFile = new Map();
  for (const f of funcs) (byFile.get(f.file) || byFile.set(f.file, []).get(f.file)).push(f);
  for (const arr of byFile.values()) {
    if (arr.length < 2) continue;
    const tokFns = new Map();               // token -> [ids in THIS file]
    for (const f of arr) for (const t of tokenSetOf(f)) (tokFns.get(t) || tokFns.set(t, []).get(t)).push(f.id);
    for (const ids of tokFns.values()) {
      if (ids.length < 2 || ids.length > RARE_INFILE_MAX) continue; // unshared, or language idiom / file-wide glue
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const k = pairKey(ids[i], ids[j]); if ((m.get(k) || 0) < Wsplit.vocabCap) addWeight(m, ids[i], ids[j], Wsplit.vocab); }
    }
  }
  for (const [k, w] of getEdges('call')) { const [a, b] = k.split(SEP); if (byId.get(a) && byId.get(b) && byId.get(a).file === byId.get(b).file) addWeight(m, a, b, w); }
  for (const [k, w] of getEdges('prefix')) { const [a, b] = k.split(SEP); if (byId.get(a) && byId.get(b) && byId.get(a).file === byId.get(b).file) addWeight(m, a, b, w); }
  _splitEdges = m; return m;
}

function withinFileLP(ids, W) {
  const idSet = new Set(ids);
  const adj = new Map(); ids.forEach((id) => adj.set(id, new Map()));
  for (const [k, w] of W) { const [a, b] = k.split(SEP); if (idSet.has(a) && idSet.has(b)) { adj.get(a).set(b, w); adj.get(b).set(a, w); } }
  const label = new Map(); ids.forEach((id, i) => label.set(id, i));
  for (let it = 0; it < LP_ITERS; it++) {
    let ch = 0;
    for (const id of ids) { const nb = adj.get(id); if (nb.size === 0) continue; const sc = new Map(); for (const [n, w] of nb) { const l = label.get(n); sc.set(l, (sc.get(l) || 0) + w); } let bl = label.get(id), bw = sc.get(bl) || 0; for (const [l, w] of sc) if (w > bw) { bw = w; bl = l; } if (bl !== label.get(id)) { label.set(id, bl); ch++; } }
    if (ch === 0) break;
  }
  const comms = new Map(); for (const id of ids) { const l = label.get(id); (comms.get(l) || comms.set(l, []).get(l)).push(id); } return [...comms.values()];
}

// Modularity (single-level Louvain local-moving). Unlike label propagation, the
// -sum_tot*k_i/2m term penalizes joining a high-degree community, so a shared
// helper hub called across mechanisms does NOT fuse them into one blob (the
// lib.rs 703-node LP collapse). Deterministic: fixed node order, strictly-greater
// gain to move.
function withinFileModularity(ids, W) {
  const idSet = new Set(ids);
  const adj = new Map(); ids.forEach((id) => adj.set(id, new Map()));
  const k = new Map(); ids.forEach((id) => k.set(id, 0));
  let m2 = 0;
  for (const [key, w] of W) { const [a, b] = key.split(SEP); if (a !== b && idSet.has(a) && idSet.has(b)) { adj.get(a).set(b, (adj.get(a).get(b) || 0) + w); adj.get(b).set(a, (adj.get(b).get(a) || 0) + w); k.set(a, k.get(a) + w); k.set(b, k.get(b) + w); m2 += 2 * w; } }
  if (m2 === 0) return ids.map((id) => [id]);
  const comm = new Map(); ids.forEach((id) => comm.set(id, id));
  const sumTot = new Map(); ids.forEach((id) => sumTot.set(id, k.get(id)));
  for (let it = 0; it < LP_ITERS; it++) {
    let moved = 0;
    for (const i of ids) {
      const ci = comm.get(i), ki = k.get(i);
      const wTo = new Map();
      for (const [nb, w] of adj.get(i)) { if (nb === i) continue; const c = comm.get(nb); wTo.set(c, (wTo.get(c) || 0) + w); }
      sumTot.set(ci, sumTot.get(ci) - ki);
      let bestC = ci, bestGain = (wTo.get(ci) || 0) - (SPLIT_RESOLUTION * sumTot.get(ci) * ki) / m2;
      for (const [c, wic] of wTo) { const gain = wic - (SPLIT_RESOLUTION * sumTot.get(c) * ki) / m2; if (gain > bestGain + 1e-12) { bestGain = gain; bestC = c; } }
      sumTot.set(bestC, sumTot.get(bestC) + ki);
      if (bestC !== ci) { comm.set(i, bestC); moved++; }
    }
    if (moved === 0) break;
  }
  const out = new Map(); for (const id of ids) { const c = comm.get(id); (out.get(c) || out.set(c, []).get(c)).push(id); } return [...out.values()];
}

// One cluster per file (split=false), or a file split into sub-mechanisms when it
// cleanly separates into >=2 substantial communities (split=true). The guardrail
// (>=2 communities of >=MIN_COMM) keeps a cohesive file whole: a file that only
// fragments into singletons is left as one cluster, since "same file" is then the
// best available signal.
function clusterByFile(split) {
  const byFile = new Map();
  for (const f of funcs) (byFile.get(f.file) || byFile.set(f.file, []).get(f.file)).push(f);
  const W = split ? splitEdges() : null;
  const out = [];
  for (const arr of byFile.values()) {
    const ids = arr.map((f) => f.id);
    if (!split || ids.length < SPLIT_MIN) { out.push(new Set(ids)); continue; }
    const comms = withinFileModularity(ids, W);
    const big = comms.filter((c) => c.length >= MIN_COMM);
    if (big.length >= 2) { for (const c of comms) out.push(new Set(c)); }
    else out.push(new Set(ids));
  }
  return out;
}

// --- ground truth ------------------------------------------------------------
function loadGroundTruth() {
  const text = fs.readFileSync(gtPath, 'utf8');
  const groups = []; let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('#')) { cur = { label: line.replace(/^#+/, '').trim(), ids: new Set(), specs: [], unresolved: [] }; groups.push(cur); continue; }
    if (!cur) { cur = { label: '(implicit)', ids: new Set(), specs: [], unresolved: [] }; groups.push(cur); }
    cur.specs.push(line);
    let fileHint = null, funcName = line;
    if (line.includes('@')) { const at = line.lastIndexOf('@'); const before = line.slice(0, at), after = line.slice(at + 1); if (!/^\d+$/.test(after)) { fileHint = before; funcName = after; } }
    const ms = index.findFunctionMatches(funcName, fileHint);
    if (ms && ms.length === 1) cur.ids.add(`${ms[0].filepath}@${ms[0].name}`);
    else cur.unresolved.push(line + (ms && ms.length > 1 ? ' (ambig)' : ' (miss)'));
  }
  return groups.filter((g) => g.ids.size + g.unresolved.length > 0);
}

// --- evaluation: for each ground-truth group, best-matching cluster ----------
function evaluate(clusters, groups) {
  const rows = []; let sumR = 0, sumP = 0, n = 0;
  for (const g of groups) {
    if (g.ids.size === 0) { rows.push({ label: g.label, note: 'no anchors resolved' }); continue; }
    let best = null, bestOv = -1;
    for (const c of clusters) { let ov = 0; for (const id of g.ids) if (c.has(id)) ov++; if (ov > bestOv) { bestOv = ov; best = c; } }
    const recall = bestOv / g.ids.size;               // fraction of the mechanism kept together
    const precision = best ? bestOv / best.size : 0;  // how pure that cluster is
    sumR += recall; sumP += precision; n++;
    rows.push({ label: g.label, resolved: g.ids.size, together: bestOv, clusterSize: best ? best.size : 0, recall, precision });
  }
  return { rows, avgRecall: n ? sumR / n : 0, avgPrecision: n ? sumP / n : 0 };
}

// --- --emit-anchors: write [file]-mode clusters as a draft anchors.lst -------
// The connector to --pseudo-claims (#284): turn [file]-mode clusters (the
// co-location workhorse — richer edge sets over-merge, per the corpus study)
// into the exact `# Label` + file@func format collectAnchorGroups parses. NO
// worthiness ranking here — the point of the curated-dozen loop is to see the
// unranked firehose and hand-select. Each group is concept-labeled via the
// shared extractConcepts so it reads as a subject, not "group N".
if (emitPath) {
  const shortFile = (fp) => { const s = String(fp).replace(/\\/g, '/'); const t = s.includes('!') ? s.slice(s.indexOf('!') + 1) : s; return t.length > 64 ? '…' + t.slice(-63) : t; };
  const clusters = clusterByFile(false)                       // [file] mode is the clean default
    .filter((c) => c.size >= MIN_COMM)
    .sort((a, b) => b.size - a.size);
  const out = [`# grouper --emit-anchors  index=${path.basename(indexPath)}  mode=[file]  ${clusters.length} groups (>= ${MIN_COMM} fns), ${emitNoiseFiles} noise files (${emitNoiseFns} fns) pre-filtered — UNRANKED draft; hand-select the claim-worthy`];
  for (const c of clusters) {
    const members = [...c].map((id) => byId.get(id)).filter(Boolean);
    const fc = new Map();
    for (const f of members) fc.set(f.file, (fc.get(f.file) || 0) + 1);
    const domFile = [...fc.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let concept = '';
    try {
      const entries = members.map((f) => ({ token: f.bare, score: 1, top_files: [{ path: f.file }] }));
      concept = extractConcepts(index, { entries, maxConcepts: 2 }).filter((x) => x && x.concept).map((x) => x.concept).join('/');
    } catch { /* fall back to the file name */ }
    out.push('', `# ${concept ? concept + ' — ' : ''}${shortFile(domFile)}  (${members.length} fns)`);
    for (const f of members) { const spec = f.name.includes('@') ? f.bare : f.name; out.push(`${f.file}@${spec}`); }
  }
  fs.writeFileSync(emitPath, out.join('\n') + '\n');
  console.error(`# wrote ${clusters.length} draft anchor group(s) to ${emitPath}  (${path.basename(indexPath)}, [file] mode, unranked; pre-filtered ${emitNoiseFiles} noise files / ${emitNoiseFns} fns)`);
  process.exit(0);
}

// --- run ---------------------------------------------------------------------
const groups = gtPath ? loadGroundTruth() : null;
console.log(`# grouper-prototype  index=${path.basename(indexPath)}  gt=${gtPath ? path.basename(gtPath) : '(none - unscored)'}`);
console.log(`# candidates: ${funcs.length} functions (>= ${MIN_LINES} lines, non-intrinsic)`);
if (groups) console.log(`# ground-truth: ${groups.length} groups, ${groups.reduce((s, g) => s + g.ids.size, 0)} anchors resolved, ${groups.reduce((s, g) => s + g.unresolved.length, 0)} unresolved`);
console.log(`# weights ${JSON.stringify(W)} label-prop-iters=${LP_ITERS}\n`);

function sizeHist(clusters) { const b = { 1: 0, '2-9': 0, '10-49': 0, '50+': 0 }; for (const c of clusters) { const n = c.size; if (n === 1) b[1]++; else if (n < 10) b['2-9']++; else if (n < 50) b['10-49']++; else b['50+']++; } return b; }
const bareOf = (id) => (byId.get(id) ? byId.get(id).bare : id);

for (const set of EDGE_SETS) {
  const clusters = cluster(set);
  const nonTrivial = clusters.filter((c) => c.size >= 2).length;
  if (groups) {
    const ev = evaluate(clusters, groups);
    console.log(`=== edges: [${set.join('+')}] ===  clusters=${clusters.length} (>=2: ${nonTrivial})  avgRecall=${ev.avgRecall.toFixed(2)} avgPrecision=${ev.avgPrecision.toFixed(2)}`);
    for (const r of ev.rows) {
      if (r.note) { console.log(`   ${r.label}: ${r.note}`); continue; }
      console.log(`   ${r.recall.toFixed(2)}R ${r.precision.toFixed(2)}P  ${r.together}/${r.resolved} together, in a cluster of ${r.clusterSize}  - ${r.label.slice(0, 58)}`);
    }
  } else {
    console.log(`=== edges: [${set.join('+')}] ===  clusters=${clusters.length} (>=2: ${nonTrivial})  sizes=${JSON.stringify(sizeHist(clusters))}`);
  }
  console.log('');
}

// --- intra-file split modes: co-location per file, then conditional split -----
// The delta between [file] and [file+intrasplit] IS the split's effect: it should
// raise precision on monolith corpora (Bram lib.rs) while leaving the single-file
// corpora untouched (the guardrail).
const MODES = [['file', false], ['file+intrasplit', true]];
for (const [name, split] of MODES) {
  const clusters = clusterByFile(split);
  const nonTrivial = clusters.filter((c) => c.size >= 2).length;
  if (groups) {
    const ev = evaluate(clusters, groups);
    console.log(`=== mode: [${name}] ===  clusters=${clusters.length} (>=2: ${nonTrivial})  avgRecall=${ev.avgRecall.toFixed(2)} avgPrecision=${ev.avgPrecision.toFixed(2)}`);
    for (const r of ev.rows) {
      if (r.note) { console.log(`   ${r.label}: ${r.note}`); continue; }
      console.log(`   ${r.recall.toFixed(2)}R ${r.precision.toFixed(2)}P  ${r.together}/${r.resolved} together, in a cluster of ${r.clusterSize}  - ${r.label.slice(0, 58)}`);
    }
  } else {
    console.log(`=== mode: [${name}] ===  clusters=${clusters.length} (>=2: ${nonTrivial})  sizes=${JSON.stringify(sizeHist(clusters))}`);
  }
  console.log('');
}

// Unscored: sample the largest non-trivial clusters from the fullest edge set so
// a human can eyeball whether they look like coherent mechanisms.
if (!groups) {
  const clusters = cluster(EDGE_SETS[EDGE_SETS.length - 1]).filter((c) => c.size >= 2).sort((a, b) => b.size - a.size);
  console.log(`# sample of the ${Math.min(15, clusters.length)} largest clusters (fullest edge set) - eyeball for mechanism coherence:`);
  for (const c of clusters.slice(0, 15)) {
    const names = [...c].map(bareOf).slice(0, 12);
    console.log(`  [${c.size}] ${names.join(', ')}${c.size > 12 ? ', …' : ''}`);
  }
}
