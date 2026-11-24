// carve.js — an index's mechanisms carved into sections and sub-sections, two ways: clusters of their text embeddings (Ward's method), or communities of the calls between them (Louvain); headings from label words; no language model
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * src/core/carve.js — carve-command-clusters-and-calls (2026-11-23).
 *
 * `--toc` and `--mechanisms` list an index's mechanisms; on a large index the list is too
 * long to read down. This module groups the mechanisms under numbered sections and
 * sub-sections so a reader can run an eye down the headings. The word is "carve" because
 * that is the job: take an indexed codebase and cut it along its joints into pieces, to
 * show its major pieces and the names it uses for them. Two techniques, two ideas of where
 * the joints are, compared on docs/CODEEXAM_CLUSTERING.md:
 *
 *   clusters  each mechanism gets one vector, its functions' text embeddings weighted by
 *             lines and by how few mechanisms hold the function (mechanismVectors); Ward's
 *             method builds one tree (wardMerges); cut high for sections and lower for
 *             sub-sections (cutTree). Needs the vectors --build-embeddings saved.
 *   calls     a graph whose nodes are mechanisms and whose edge weights count calls between
 *             their functions, matched by name (callEdges); Louvain community detection
 *             gives sections, and Louvain again on the calls inside a section gives
 *             sub-sections (louvain). Reads no embedding.
 *
 * Both started as scratch scripts and are ported here unchanged in what they compute, so the
 * listings a user sees are the ones the page's figures were measured on. Neither is a
 * finding: the groups move when the index changes, and for `calls` when the seed changes
 * (clusters rebuilt from 80% of the mechanisms agreed with the full run only 0.50 to 0.67,
 * scratch runs of 2026-11-19). The header of every listing says so.
 *
 * Everything here is pure: arrays in, arrays or lines out. src/commands/carve.js reads the
 * index and the saved vectors.
 */
import { leafOf } from './function-text.js';

export const CARVE_HOWS = ['clusters', 'calls'];
/** Louvain's resolution for sections and for sub-sections, the seed, and the smallest section that is carved again. */
export const CALLS_RESOLUTION = 2;
export const CALLS_SUB_RESOLUTION = 1;
export const CALLS_SEED = 5;
export const CALLS_MIN_SUB = 8;
/** `--purpose` cuts the harvested text at this many characters; a wrapped line is at most this wide. */
export const PURPOSE_MAX = 240;
export const WRAP_WIDTH = 110;
/** Ward's method keeps a square table of distances: above this many mechanisms it is refused (a gigabyte at 16,000). */
export const CLUSTERS_MAX = 16000;

/** How many sections and sub-sections `clusters` makes when not told: 12 and 45 on 363 mechanisms. */
export const defaultSections = (n) => Math.max(6, Math.round(Math.sqrt(n) * 0.65));
export const defaultSubs = (n) => Math.round(n / 8);

/** A seeded generator of numbers in [0, 1), so that one seed gives one listing. */
export function makeRng(seed = CALLS_SEED) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const shuffled = (a, rnd) => { const o = [...a]; for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; };

/**
 * One unit vector per mechanism from its functions' vectors, or null when it has none.
 * `fnIds[i]` are mechanism i's function ids; `fnVecs` maps a function id to its vector;
 * `weightOf(id)` is the function's weight (the command passes lines / mechanisms holding
 * it, so a long function counts for more and a helper shared by twenty mechanisms for
 * less); `labelVecs[i]` is the vector of the mechanism's label and member names, used only
 * when no function of it has a vector.
 */
export function mechanismVectors({ fnIds, fnVecs, weightOf, labelVecs = [], dim }) {
  const unit = (v) => { let n = 0; for (let d = 0; d < dim; d++) n += v[d] * v[d]; n = Math.sqrt(n) || 1; const o = new Float32Array(dim); for (let d = 0; d < dim; d++) o[d] = v[d] / n; return o; };
  return fnIds.map((ids, i) => {
    const have = ids.filter((id) => fnVecs.get(id));
    if (have.length) { const m = new Float32Array(dim); for (const id of have) { const u = unit(fnVecs.get(id)), w = weightOf(id); for (let d = 0; d < dim; d++) m[d] += w * u[d]; } return unit(m); }
    return labelVecs[i] ? unit(labelVecs[i]) : null;
  });
}

/**
 * Ward's method on `n` unit vectors (rows of `P`, `dim` wide), by nearest-neighbour chain:
 * the same tree as merging the closest pair each time, in quadratic time and not cubic.
 * Returns the n-1 merges as [a, b, distance], lowest first; a and b are members of the two
 * clusters joined. `onProgress(done, total)` is called now and then while distances are made.
 */
export function wardMerges(P, n, dim, onProgress = null) {
  const D = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const a = i * dim;
    for (let j = i + 1; j < n; j++) { let s = 0; const b = j * dim; for (let d = 0; d < dim; d++) s += P[a + d] * P[b + d]; D[i * n + j] = D[j * n + i] = 2 - 2 * s; }
    if (onProgress && i % 500 === 499) onProgress(i + 1, n);
  }
  const size = new Int32Array(n).fill(1), alive = new Uint8Array(n).fill(1), chain = [], merges = [];
  for (let left = n; left > 1;) {
    if (!chain.length) { let s = 0; while (!alive[s]) s++; chain.push(s); }
    for (;;) {
      const a = chain[chain.length - 1], prev = chain.length > 1 ? chain[chain.length - 2] : -1;
      let b = -1, best = Infinity; const ra = a * n;
      for (let k = 0; k < n; k++) if (alive[k] && k !== a) { const d = D[ra + k]; if (d < best || (d === best && k === prev)) { best = d; b = k; } }
      if (b === prev) {
        chain.length -= 2;
        const na = size[a], nb = size[b];
        for (let k = 0; k < n; k++) if (alive[k] && k !== a && k !== b) { const nk = size[k]; const v = ((na + nk) * D[ra + k] + (nb + nk) * D[b * n + k] - nk * best) / (na + nb + nk); D[ra + k] = D[k * n + a] = v; }
        alive[b] = 0; size[a] = na + nb; merges.push([a, b, best]); left--;
        break;
      }
      chain.push(b);
    }
  }
  return merges.sort((x, y) => x[2] - y[2]);
}

/** The tree of `merges` cut into `k` clusters: a cluster label per item (equal labels, same cluster). */
export function cutTree(n, merges, k) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; };
  for (let s = 0; s < n - k; s++) p[find(merges[s][1])] = find(merges[s][0]);
  return p.map((_, i) => find(i));
}

/**
 * Louvain community detection on an undirected weighted graph of `n` nodes: `edges` are
 * [a, b, weight]. `gamma` is the resolution (higher, more and smaller communities). Nodes
 * are visited in an order drawn from `rnd`, so the result depends on the generator's state.
 * Returns a community label per node; a node with no edge is alone in its own.
 */
export function louvain(n, edges, gamma, rnd) {
  let adj = Array.from({ length: n }, () => new Map());
  for (const [a, b, w] of edges) { if (a === b) continue; adj[a].set(b, (adj[a].get(b) || 0) + w); adj[b].set(a, (adj[b].get(a) || 0) + w); }
  let owner = Array.from({ length: n }, (_, i) => i);
  for (;;) {
    const m = adj.length, k = new Float64Array(m); let m2 = 0;
    for (let i = 0; i < m; i++) { for (const [j, w] of adj[i]) k[i] += j === i ? 2 * w : w; m2 += k[i]; }
    if (!m2) break;
    const com = Array.from({ length: m }, (_, i) => i), tot = Float64Array.from(k); let movedAny = false;
    for (let pass = 0; pass < 50; pass++) {
      let moved = 0;
      for (const i of shuffled(Array.from({ length: m }, (_, x) => x), rnd)) {
        if (!k[i]) continue;
        const to = new Map(); for (const [j, w] of adj[i]) if (j !== i) to.set(com[j], (to.get(com[j]) || 0) + w);
        const old = com[i]; tot[old] -= k[i];
        let best = old, bestGain = (to.get(old) || 0) - gamma * tot[old] * k[i] / m2;
        for (const [c, w] of to) { const g = w - gamma * tot[c] * k[i] / m2; if (g > bestGain + 1e-12) { bestGain = g; best = c; } }
        tot[best] += k[i]; if (best !== old) { com[i] = best; moved++; }
      }
      if (!moved) break; movedAny = true;
    }
    if (!movedAny) break;
    const name = new Map(); for (let i = 0; i < m; i++) if (!name.has(com[i])) name.set(com[i], name.size);
    const next = Array.from({ length: name.size }, () => new Map());
    for (let i = 0; i < m; i++) { const a = name.get(com[i]); for (const [j, w] of adj[i]) { const b = name.get(com[j]); if (i === j) next[a].set(a, (next[a].get(a) || 0) + w); else if (a === b) next[a].set(a, (next[a].get(a) || 0) + w / 2); else next[a].set(b, (next[a].get(b) || 0) + w); } }
    owner = owner.map((s) => name.get(com[s])); adj = next;
  }
  return owner;
}

/**
 * The calls between mechanisms, as [a, b, weight] with a < b. `fnIds[i]` are mechanism i's
 * function ids; `fnById` maps an id to { name, file, calls: [called names] } (the
 * function-text corpus). A call is matched to every function bearing the called leaf name.
 * Left out: a function's call to its own name; a name called from more than 2% of the
 * functions (at least 3), which is plumbing; a name defined in more than three files, which
 * is too ambiguous to match. A call's weight is shared out over the functions bearing the
 * name and over the mechanisms holding the caller and the callee.
 */
export function callEdges(fnIds, fnById) {
  const N = fnIds.length;
  const groupsOf = new Map();
  fnIds.forEach((ids, gi) => { for (const id of ids) { if (!fnById.get(id)) continue; if (!groupsOf.has(id)) groupsOf.set(id, []); groupsOf.get(id).push(gi); } });
  const byLeaf = new Map(), leafFiles = new Map(), callDf = new Map();
  for (const id of groupsOf.keys()) {
    const f = fnById.get(id), l = leafOf(f.name);
    if (!byLeaf.has(l)) { byLeaf.set(l, []); leafFiles.set(l, new Set()); }
    byLeaf.get(l).push(id); leafFiles.get(l).add(f.file);
    for (const c of new Set((f.calls || []).map(leafOf))) callDf.set(c, (callDf.get(c) || 0) + 1);
  }
  const plumbing = Math.max(3, groupsOf.size * 0.02);
  const key = (a, b) => (a < b ? a * N + b : b * N + a);
  const calls = new Map();
  for (const id of groupsOf.keys()) {
    const f = fnById.get(id), from = groupsOf.get(id);
    for (const c of new Set((f.calls || []).map(leafOf))) {
      if (c === leafOf(f.name) || callDf.get(c) > plumbing || !byLeaf.has(c) || leafFiles.get(c).size > 3) continue;
      for (const tid of byLeaf.get(c)) { const to = groupsOf.get(tid); const w = 1 / (from.length * to.length * byLeaf.get(c).length); for (const a of from) for (const b of to) if (a !== b) calls.set(key(a, b), (calls.get(key(a, b)) || 0) + w); }
    }
  }
  return [...calls].map(([k, w]) => [Math.floor(k / N), k % N, w]);
}

const groupBy = (items, labelOf) => { const m = new Map(); for (const x of items) { const l = labelOf(x); (m.get(l) || m.set(l, []).get(l)).push(x); } return [...m.values()]; };

/**
 * `clusters`: sections and sub-sections of the mechanisms that have a vector. `vectors[i]`
 * is a unit Float32Array or null. `merges` (a saved tree) is used when given, else built.
 * Returns { placed: [index...], sections: [[index...]], subsOf(section) -> [[index...]],
 * merges, top, sub } with indexes into `vectors`.
 */
export function carveClusters(vectors, { sections = null, sub = null, merges = null, onProgress = null } = {}) {
  const placed = []; vectors.forEach((v, i) => { if (v) placed.push(i); });
  const n = placed.length;
  if (!n) return { placed, sections: [], subsOf: () => null, merges: [], top: 0, sub: 0 };
  const dim = vectors[placed[0]].length;
  if (!merges) { const P = new Float32Array(n * dim); placed.forEach((i, r) => P.set(vectors[i], r * dim)); merges = wardMerges(P, n, dim, onProgress); }
  const top = Math.min(n, Math.max(1, sections ?? defaultSections(n)));
  const subN = Math.min(n, Math.max(top, sub ?? defaultSubs(n)));
  const topOf = cutTree(n, merges, top), subOf = cutTree(n, merges, subN);
  const rows = placed.map((_, r) => r);
  const out = groupBy(rows, (r) => topOf[r]).map((g) => g.map((r) => placed[r]));
  const at = new Map(placed.map((i, r) => [i, r]));
  return { placed, sections: out, subsOf: (g) => groupBy(g, (i) => subOf[at.get(i)]), merges, top, sub: subN };
}

/**
 * `calls`: sections and sub-sections of `n` mechanisms from the `edges` between them. The
 * sub-sections of every section of CALLS_MIN_SUB or more are made here, largest section
 * first, from the one generator, so a seed fixes the whole listing.
 * Returns { sections: [[index...]], subsOf(section) -> [[index...]] | null, touched: Set }.
 */
export function carveCalls(n, edges, { resolution = CALLS_RESOLUTION, subResolution = CALLS_SUB_RESOLUTION, seed = CALLS_SEED, minSub = CALLS_MIN_SUB } = {}) {
  const rnd = makeRng(seed);
  const owner = louvain(n, edges, resolution, rnd);
  const sections = groupBy(Array.from({ length: n }, (_, i) => i), (i) => owner[i]);
  const subs = new Map();
  for (const g of sections.filter((s) => s.length > 1).sort((a, b) => b.length - a.length)) {
    if (g.length < minSub) continue;
    const pos = new Map(g.map((x, k) => [x, k]));
    const inner = edges.filter(([a, b]) => pos.has(a) && pos.has(b)).map(([a, b, w]) => [pos.get(a), pos.get(b), w]);
    const lab = louvain(g.length, inner, subResolution, rnd);
    subs.set(g, groupBy(g, (i) => lab[pos.get(i)]));
  }
  return { sections, subsOf: (g) => subs.get(g) || null, touched: new Set(edges.flatMap(([a, b]) => [a, b])) };
}

/** The words of a mechanism's label: no kind tag, no file extension, camel case split, lower case. */
export function labelWords(label) {
  return String(label).replace(/^\[\w+\]\s*/, '').replace(/\.[a-z]+\b/g, ' ').split(/[^A-Za-z]+|(?<=[a-z])(?=[A-Z])/).map((w) => w.toLowerCase()).filter((w) => w.length > 2 && !['other', 'the', 'and'].includes(w));
}

/** A heading maker over `labels`: up to `k` words in at least two of a group's labels, most telling first (common in the group, rare in the listing). */
export function headingMaker(labels) {
  const n = labels.length, df = new Map();
  for (const l of labels) for (const w of new Set(labelWords(l))) df.set(w, (df.get(w) || 0) + 1);
  return (group, k = 4) => {
    const wc = new Map(); for (const i of group) for (const w of new Set(labelWords(labels[i]))) wc.set(w, (wc.get(w) || 0) + 1);
    const h = [...wc].filter(([, c]) => c >= 2).map(([w, c]) => [w, c * Math.log(n / df.get(w))]).sort((a, b) => b[1] - a[1]).slice(0, k).map(([w]) => w);
    return h.length ? h.join(', ') : '(no shared word)';
  };
}

/** `text` wrapped to `width` columns, every line starting with `pad`. */
export function wrapText(text, pad, width = WRAP_WIDTH) {
  const out = []; let cur = '';
  for (const w of String(text).split(' ')) { if (cur && pad.length + cur.length + 1 + w.length > width) { out.push(pad + cur); cur = w; } else cur = cur ? `${cur} ${w}` : w; }
  if (cur) out.push(pad + cur);
  return out;
}
const oneLine = (t) => String(t).replace(/\s+/g, ' ').trim();
/** A harvested purpose as `--purpose` prints it: one line, cut at PURPOSE_MAX. */
export const purposeText = (t) => { const p = oneLine(t); return p.length > PURPOSE_MAX ? `${p.slice(0, PURPOSE_MAX)} …` : p; };

const kindRank = (l) => (/^\[cmd\]/.test(l) ? 0 : /^\[class\]/.test(l) ? 2 : /^\[file\]/.test(l) ? 3 : 1);

/**
 * The listing's lines below the header. `rows[i]` is { id, label, description, purpose };
 * `sections` are arrays of row indexes; `subsOf(section)` its sub-sections or null. Sections
 * of two or more are numbered, largest first, each under a heading with its count;
 * sub-sections likewise, with a last "(others in this section)" for those left single. Each
 * row is `id label [section.sub]`, commands first, so a search of the output for a
 * mechanism shows where it sits. Rows in a section of their own come last under `loneTitle`,
 * tagged [alone]; `unplaced` (row indexes outside every section) after them under
 * `unplacedTitle`, tagged [unplaced].
 * Returns { lines, sections: how many of two or more, largest, alone }.
 */
export function carveListing(rows, sections, subsOf, { brief = false, description = false, purpose = false, loneTitle = 'In a section of their own', unplaced = [], unplacedTitle = 'Not placed' } = {}) {
  const labels = rows.map((r) => r.label), heading = headingMaker(labels);
  const sorted = (g) => [...g].sort((a, b) => kindRank(labels[a]) - kindRank(labels[b]) || labels[a].localeCompare(labels[b]));
  const lines = [];
  const pad = ' '.repeat(14);
  const row = (i, tag) => {
    const r = rows[i];
    lines.push(`       ${String(r.id).padEnd(6)} ${r.label} [${tag}]`);
    if (description && r.description) lines.push(...wrapText(oneLine(r.description), pad));
    if (purpose && r.purpose) lines.push(...wrapText(`purpose: ${purposeText(r.purpose)}`, pad));
  };
  const big = sections.filter((g) => g.length > 1).sort((a, b) => b.length - a.length), lone = sections.filter((g) => g.length === 1).flat();
  big.forEach((g, si) => {
    lines.push(`${si + 1}. ${heading(g)}   (${g.length} mechanisms)`);
    const parts = subsOf(g);
    if (!parts || parts.length < 2) { if (!brief) for (const i of sorted(g)) row(i, `${si + 1}`); lines.push(''); return; }
    const multi = parts.filter((p) => p.length > 1).sort((a, b) => b.length - a.length), single = parts.filter((p) => p.length === 1).flat();
    multi.forEach((p, pi) => { lines.push(`   ${si + 1}.${pi + 1} ${heading(p, 3)}   (${p.length})`); if (!brief) for (const i of sorted(p)) row(i, `${si + 1}.${pi + 1}`); });
    if (single.length) { lines.push(`   ${si + 1}.${multi.length + 1} (others in this section)   (${single.length})`); if (!brief) for (const i of sorted(single)) row(i, `${si + 1}.${multi.length + 1}`); }
    lines.push('');
  });
  if (lone.length) { lines.push(`${loneTitle} (${lone.length}):`); for (const i of sorted(lone)) row(i, 'alone'); lines.push(''); }
  if (unplaced.length) { lines.push(`${unplacedTitle} (${unplaced.length}):`); for (const i of sorted(unplaced)) row(i, 'unplaced'); lines.push(''); }
  return { lines, sections: big.length, largest: big.length ? big[0].length : 0, alone: lone.length };
}

/** What bare `--carve` prints: the two techniques, a line on each, and that it picks neither. */
export function carveUsage(exe = 'ce', ndx = '<index>') {
  return [
    '--carve carves an indexed codebase along its joints: it divides the codebase\'s mechanisms (the rows --toc and --mechanisms list) into numbered sections and sub-sections, a list to run an eye down for the major pieces, or for what the codebase calls a piece you are looking for. It takes the technique, clusters or calls:',
    `  ${exe} --index-path ${ndx} --carve clusters   mechanisms whose text is alike go together (the vectors --build-embeddings saved; Ward's method)`,
    `  ${exe} --index-path ${ndx} --carve calls      mechanisms that call each other go together (no embeddings needed; Louvain community detection)`,
    'Options: --description, --purpose, --brief, --include-tests; with clusters --sections N, --sub N, --embed-model <name>; with calls --resolution X, --seed N.',
    'The two give different groups. Neither is a finding; docs/CODEEXAM_CLUSTERING.md compares them.',
  ];
}
