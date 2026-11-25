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

/**
 * The leaves of the tree in an order to read down: the items of a cluster are together,
 * and at each merge the two clusters are laid end to end with the closer pair of ends
 * meeting (each may be turned round), so that neighbours in the list are alike. `P` holds
 * the n unit vectors the tree was built from. Returns the n row indexes in that order.
 * `--sort-by similarity` lists mechanisms in it.
 */
export function leafOrder(n, merges, P, dim) {
  const cos = (i, j) => { let s = 0; const a = i * dim, b = j * dim; for (let d = 0; d < dim; d++) s += P[a + d] * P[b + d]; return s; };
  const root = Array.from({ length: n }, (_, i) => i), seq = Array.from({ length: n }, (_, i) => [i]);
  const find = (x) => { while (root[x] !== x) { root[x] = root[root[x]]; x = root[x]; } return x; };
  for (const [x, y] of merges) {
    const a = find(x), b = find(y);
    if (a === b) continue;
    const A = seq[a], B = seq[b], a0 = A[0], a1 = A[A.length - 1], b0 = B[0], b1 = B[B.length - 1];
    // the four ways to lay A and B end to end, by which ends meet
    const ways = [[cos(a1, b0), 0], [cos(a1, b1), 1], [cos(a0, b0), 2], [cos(a0, b1), 3]];
    let best = ways[0]; for (const w of ways) if (w[0] > best[0]) best = w;
    const rev = (s) => [...s].reverse();
    seq[a] = best[1] === 0 ? A.concat(B) : best[1] === 1 ? A.concat(rev(B)) : best[1] === 2 ? rev(A).concat(B) : B.concat(A);
    seq[b] = null; root[b] = a;
  }
  return n ? seq[find(0)] : [];
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
  if (!n) return { placed, sections: [], subsOf: () => null, merges: [], top: 0, sub: 0, order: [] };
  const dim = vectors[placed[0]].length;
  const P = new Float32Array(n * dim); placed.forEach((i, r) => P.set(vectors[i], r * dim));
  if (!merges) merges = wardMerges(P, n, dim, onProgress);
  const order = leafOrder(n, merges, P, dim).map((r) => placed[r]);
  const top = Math.min(n, Math.max(1, sections ?? defaultSections(n)));
  const subN = Math.min(n, Math.max(top, sub ?? defaultSubs(n)));
  const topOf = cutTree(n, merges, top), subOf = cutTree(n, merges, subN);
  const rows = placed.map((_, r) => r);
  const out = groupBy(rows, (r) => topOf[r]).map((g) => g.map((r) => placed[r]));
  const at = new Map(placed.map((i, r) => [i, r]));
  return { placed, sections: out, subsOf: (g) => groupBy(g, (i) => subOf[at.get(i)]), merges, top, sub: subN, order };
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
  const { numbered, lone } = numberSections(sections, subsOf);
  for (const s of numbered) {
    lines.push(`${s.tag}. ${heading(s.group)}   (${s.group.length} mechanisms)`);
    if (!s.subs) { if (!brief) for (const i of sorted(s.group)) row(i, s.tag); lines.push(''); continue; }
    for (const p of s.subs) { lines.push(p.others ? `   ${p.tag} (others in this section)   (${p.group.length})` : `   ${p.tag} ${heading(p.group, 3)}   (${p.group.length})`); if (!brief) for (const i of sorted(p.group)) row(i, p.tag); }
    lines.push('');
  }
  if (lone.length) { lines.push(`${loneTitle} (${lone.length}):`); for (const i of sorted(lone)) row(i, 'alone'); lines.push(''); }
  if (unplaced.length) { lines.push(`${unplacedTitle} (${unplaced.length}):`); for (const i of sorted(unplaced)) row(i, 'unplaced'); lines.push(''); }
  return { lines, sections: numbered.length, largest: numbered.length ? numbered[0].group.length : 0, alone: lone.length };
}

/**
 * The numbers a listing gives its sections: the one place they are decided, for the listing
 * and for anything that says where a row sits (issue-364-concepts-where). Sections of two or
 * more, largest first, are `1`, `2`, ...; inside one that has sub-sections, those of two or
 * more, largest first, are `1.1`, `1.2`, ..., and the rows left single share a last one
 * (`others: true`). Returns { numbered: [{ tag, group, subs: null | [{ tag, group, others }] }],
 * lone: [row indexes in a section of their own] }.
 */
export function numberSections(sections, subsOf) {
  const big = sections.filter((g) => g.length > 1).sort((a, b) => b.length - a.length), lone = sections.filter((g) => g.length === 1).flat();
  const numbered = big.map((g, si) => {
    const parts = subsOf(g);
    if (!parts || parts.length < 2) return { tag: `${si + 1}`, group: g, subs: null };
    const multi = parts.filter((p) => p.length > 1).sort((a, b) => b.length - a.length), single = parts.filter((p) => p.length === 1).flat();
    const subs = multi.map((p, pi) => ({ tag: `${si + 1}.${pi + 1}`, group: p, others: false }));
    if (single.length) subs.push({ tag: `${si + 1}.${multi.length + 1}`, group: single, others: true });
    return { tag: `${si + 1}`, group: g, subs };
  });
  return { numbered, lone };
}

/**
 * Where every row of a listing sits, and the listing's units: { tagOf: Map(row index -> the
 * tag its row ends with: `11.5`, `7`, `alone`, `unplaced`), units: Map(tag -> row indexes) }.
 * A unit is a numbered section (all of it, sub-sections included) or a sub-section.
 */
export function sectionUnits(sections, subsOf, unplaced = []) {
  const { numbered, lone } = numberSections(sections, subsOf);
  const tagOf = new Map(), units = new Map();
  for (const s of numbered) {
    units.set(s.tag, s.group);
    if (!s.subs) { for (const i of s.group) tagOf.set(i, s.tag); continue; }
    for (const p of s.subs) { units.set(p.tag, p.group); for (const i of p.group) tagOf.set(i, p.tag); }
  }
  for (const i of lone) tagOf.set(i, 'alone');
  for (const i of unplaced) tagOf.set(i, 'unplaced');
  return { tagOf, units };
}

/**
 * The test a placement must pass to be called a home: of PLACE_DRAWS random picks of as many
 * rows, no more than PLACE_LEVEL may do as well. The experiment of 2026-11-19 (part A of #364)
 * asked that the best unit beat each of 20 random picks, which is the same bar on average
 * (one pick in twenty). Twenty picks proved too few to give a steady answer: on CodeExam's own
 * index under clusters, two ways of drawing them gave 84 and 58 homes of 148 concepts
 * (2026-11-24). Two hundred picks at the same level move far less with the seed.
 */
export const PLACE_DRAWS = 200;
export const PLACE_LEVEL = 0.05;

/**
 * The unit that holds `members` best: the highest F of held (share of the members in the
 * unit) and pure (share of the unit that is members); the smaller unit on a tie. Counted
 * from each member's own tag and its section, so the cost is the members, not the units.
 */
function bestUnit(members, tagOf, sizeOf) {
  const count = new Map();
  for (const i of members) {
    const t = tagOf.get(i);
    if (t == null || !sizeOf.has(t)) continue;                       // alone, unplaced: in no unit
    count.set(t, (count.get(t) || 0) + 1);
    const dot = String(t).indexOf('.');
    if (dot > 0) { const s = String(t).slice(0, dot); count.set(s, (count.get(s) || 0) + 1); }
  }
  let b = { f: 0, unit: null, inUnit: 0, size: 0, held: 0, pure: 0 };
  for (const [tag, k] of count) {
    const size = sizeOf.get(tag), held = k / members.length, pure = k / size, f = (2 * held * pure) / (held + pure);
    if (f > b.f || (f === b.f && size < b.size)) b = { f, unit: tag, inUnit: k, size, held, pure };
  }
  return b;
}

/** `n` different rows of `population`, by the generator. */
function randomPick(population, n, rnd) {
  const N = population.length;
  if (n >= N) return population;
  if (n * 3 < N) { const seen = new Set(); while (seen.size < n) seen.add(Math.floor(rnd() * N)); return [...seen].map((k) => population[k]); }
  const pool = [...population];
  for (let j = 0; j < n; j++) { const k = j + Math.floor(rnd() * (N - j)); const x = pool[j]; pool[j] = pool[k]; pool[k] = x; }
  return pool.slice(0, n);
}

/**
 * Where a set of rows sits in a listing (issue-364-concepts-where): the unit that holds them
 * best, whether that is better than chance, and where the rest are. `members` are row indexes
 * that are in the listing; `population` every row index of it; `units` and `tagOf` from
 * sectionUnits; `rnd` a seeded generator (makeRng), so the same listing gives the same answer.
 *   { n, unit, inUnit, size, held, pure, home, elsewhere: [[tag, count]...] }
 * `home` is true when no more than PLACE_LEVEL of PLACE_DRAWS random picks of as many rows
 * have a best unit as good (see PLACE_DRAWS). With one member there is nothing to test: its
 * unit is where it is, and `home` is true. `section`, when the unit is a sub-section, counts
 * the members in its whole section. `elsewhere` counts the members outside the unit by
 * their own tags, most first. Null when `members` is empty.
 */
export function placeInSections(members, { units, tagOf, population, rnd, draws = PLACE_DRAWS, level = PLACE_LEVEL }) {
  if (!members.length) return null;
  const sets = new Map([...units].map(([tag, g]) => [tag, g instanceof Set ? g : new Set(g)]));
  const sizeOf = new Map([...sets].map(([tag, s]) => [tag, s.size]));
  const inside = (tag, unit) => unit != null && (tag === unit || String(tag).startsWith(`${unit}.`));
  const rest = (unit) => {
    const c = new Map();
    for (const i of members) { const t = tagOf.get(i); if (t == null || inside(t, unit)) continue; c.set(t, (c.get(t) || 0) + 1); }
    return [...c].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
  };
  if (members.length === 1) {
    const t = tagOf.get(members[0]);
    const numbered = t != null && sets.has(t);
    return { n: 1, unit: numbered ? t : null, inUnit: numbered ? 1 : 0, size: numbered ? sets.get(t).size : 0, held: numbered ? 1 : 0, pure: numbered ? 1 / sets.get(t).size : 0, home: numbered, elsewhere: numbered ? [] : rest(null) };
  }
  const b = bestUnit(members, tagOf, sizeOf);
  let asGood = 0;   // random picks whose best unit is at least as good
  if (b.unit != null) for (let d = 0; d < draws; d++) if (bestUnit(randomPick(population, members.length, rnd), tagOf, sizeOf).f >= b.f) asGood++;
  // when the best unit is a sub-section, how many of the members its whole section holds: a
  // concept can be split over neighbouring sub-sections and still be all in one section
  let section = null;
  if (b.unit != null && String(b.unit).includes('.')) {
    const tag = String(b.unit).split('.')[0], set = sets.get(tag);
    if (set) { let k = 0; for (const i of members) if (set.has(i)) k++; section = { tag, inUnit: k, size: set.size }; }
  }
  return { n: members.length, unit: b.unit, inUnit: b.inUnit, size: b.size, held: b.held, pure: b.pure, home: b.unit != null && asGood <= level * draws, section, elsewhere: rest(b.unit) };
}

export const CARVE_TREE_FORMAT = 'ce-carve-tree';
/**
 * The similarity order `--carve clusters` saved for an index, or null: { ids (mechanism
 * ids, neighbours alike), model, generated, stale }. Read from
 * <index>/embeddings/<model>_carve-tree.json, the newest when several models have one.
 * `stale` is true when the tree was built for a mechanisms file other than the one built
 * at `mechanismsGenerated`. Nothing is computed here: a listing reads the order, it never
 * clusters. `fsApi` and `pathApi` are node's fs and path, passed in so this module stays pure.
 */
export function readCarveOrder(indexPath, mechanismsGenerated, fsApi, pathApi) {
  const dir = pathApi.join(indexPath, 'embeddings');
  let names;
  try { names = fsApi.readdirSync(dir).filter((f) => /_carve-tree\.json$/.test(f)); } catch { return null; }
  let best = null;
  for (const name of names) {
    let t;
    try { t = JSON.parse(fsApi.readFileSync(pathApi.join(dir, name), 'utf8')); } catch { continue; }
    if (!t || t.format !== CARVE_TREE_FORMAT || !Array.isArray(t.order) || !t.order.length) continue;
    if (!best || String(t.generated) > String(best.generated)) best = t;
  }
  if (!best) return null;
  return { ids: best.order, model: best.model || '', generated: best.generated || '', stale: !!(mechanismsGenerated && best.mechanisms && best.mechanisms !== mechanismsGenerated) };
}

/**
 * What a listing needs to print `rows` (mechanism entries) by similarity: null when the
 * index has no saved order, else { similarIds, similar: { model, stale, unplaced } }, the
 * arguments of orderEntries and listingNote. `unplaced` counts the rows the order does not
 * hold (by their own id or a folded alias's).
 */
export function similarityOrderFor(indexPath, mechanismsGenerated, rows, fsApi, pathApi) {
  const saved = readCarveOrder(indexPath, mechanismsGenerated, fsApi, pathApi);
  if (!saved) return null;
  const held = new Set(saved.ids);
  const unplaced = (rows || []).filter((r) => !held.has(r.id) && !(r.aliases || []).some((a) => held.has(a.id))).length;
  return { similarIds: saved.ids, similar: { model: saved.model, stale: saved.stale, unplaced } };
}
/** The refusal when a listing is asked for the similarity order and the index has none saved. `run` is the command that saves one. */
export const noSimilarityOrder = (run) => `No similarity order is saved for this index. --carve clusters builds one from the embeddings and saves it (it needs --build-embeddings first); run it once, then this again:\n  ${run}`;

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
