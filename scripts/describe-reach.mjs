#!/usr/bin/env node
// describe-reach.mjs — does a claim element reach the mechanism entry that holds its anchor when the entries' model-written descriptions are what is embedded? A measurement (issue #322 on #359's unit), no CLI change
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * scripts/describe-reach.mjs — issue-322-describe-reach (2026-11-05).
 *
 * Every embedding test before this one put claim text against function
 * bodies or names (docs/embedding-reach.md; the ladder on ExoPlayer in #322),
 * the widest register gap there is. The mechanisms index carries, per entry,
 * a sentence a model wrote after reading the code (--describe). This script
 * asks the prose-to-prose question: embed those sentences and a claim's
 * elements, rank the entries per element by cosine, and see whether the entry
 * holding the claim's anchor function is within reach.
 *
 * Usage:
 *   node scripts/describe-reach.mjs (--hof <dir>[,<dir>...] | --all [--hof-root <root>])
 *        [--index <path>] [--embed-model <gguf>] [--text description|description+purpose|purpose|label+members]
 *        [--chunk N] [--fuse] [--k 1,5,10,25] [--top N] [--cpu] [--no-prefix] [--dry] [--render <file.md>]
 *   node scripts/describe-reach.mjs --compare <a.json>,<b.json> [--render <file.md>]
 *
 *   --hof <dir>        HOF run directories (scripts/hof.mjs output: claims.txt.anchors.json
 *                      and hof_report.json), comma-separated; the report names the index
 *   --all              every run under --hof-root (default %LOCALAPPDATA%\CodeExam\hof)
 *                      whose index is described (nine records in ten carry a sentence),
 *                      the latest run per index
 *   --index <path>     the index whose mechanisms.json to read (one --hof dir only;
 *                      default: the report's indexPath, resolved against the repo root)
 *   --embed-model      a GGUF embedding model (default models/nomic-embed-text-v1.5.Q8_0.gguf);
 *                      run through node-llama-cpp, no network, CPU is enough
 *   --text             what is embedded per entry (default description; an entry with none
 *                      falls back to its purpose, then its label, and the count is reported)
 *   --chunk N          the label-and-members text is embedded in chunks of N member names,
 *                      each with the label, and an entry scores as its best chunk (default 8;
 *                      0 embeds the whole text, cut at TEXT_MAX_CHARS). One vector per entry
 *                      sank the big entries (2026-11-05: a 58-function piece of x264 at rank
 *                      365 of 367 for every element, a 450-function WinAPI entry cut after
 *                      150 names); chunks never cost on the small indexes
 *   --fuse             a third method row: the lexical and embedding rankings fused by
 *                      reciprocal rank (1/(60 + rank), summed), ties broken by the embedding
 *                      rank; plus its shuffled control. Index-dependent (2026-11-06: +5 points
 *                      at rank 1 on the Python/JS indexes, a loss on x264 and ffmpeg where
 *                      BM25's rank is noise on abbreviated C names), so a flag, not the default
 *   --compare a,b      no model: two --render records of the same runs side by side, per run
 *                      and pooled, each method's reach@1, reach@25 and strict under each and
 *                      the difference; the describer's name comes from each record's
 *                      describedEngine (the index's described.engine at run time)
 *   --k                the reach depths (default 1,5,10,25)
 *   --top N            entries shown per element in the detail (default 3)
 *   --cpu              force the CPU engine
 *   --no-prefix        do not add nomic's search_query: / search_document: prefixes
 *   --dry              no model: the anchor-to-entry mapping and the lexical control only
 *   --render <file.md> write the Markdown report there and a JSON record beside it
 *
 * Scoring. An anchor (the drafter's grounded file@func) maps to the entries whose
 * members hold it (several: the cover overlaps). Its best rank is the lowest rank of
 * any holding entry under any element of its claim (the ladder's union rule); reach@k
 * counts anchors with best rank <= k, pooled over a run's claims, with the median.
 * Ranks are conservative: an entry tied with others takes the last place of the tie.
 * "strict" is the element whose top entry holds an anchor of its claim, the first
 * thing a reader would open. Three comparators on the same unit: the lexical control
 * (BM25 over the same entry texts, no model), the shuffled control (the next run's
 * elements against this run's index and anchors, the chance level), and the locator's
 * own result on the same claims from hof_report.json (anchors it located at the
 * function rung, and at the file rung or better).
 *
 * THE CAVEAT. The HOF claims were drafted by a model from the anchor functions and
 * the descriptions were written by a model from the same functions: two paraphrases
 * of one reading. A high number here says the unit works, not that it finds code the
 * drafter did not paraphrase; the litigants' charts are the honest test (phase 2).
 *
 * Vectors are cached under <hof>/describe-reach/ keyed by the text's hash, so a
 * re-described file re-embeds only what changed; the cache is written every
 * CACHE_CHECKPOINT embeddings as well as at the end, so a stopped run keeps what it
 * paid for (Spinellis's 16,526 entries were a night's work on the CPU, 2026-11-05). A
 * cache is an artifact of the index (#361's inventory). A VALIDATION HARNESS, beside
 * hof.mjs and hof-stage1.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMechanismsIndex, foldRecords } from '../src/core/mechanisms-index.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { contentWords, stem } from '../src/core/claim-terms.js';
import { parseSidecar, baseName } from '../src/core/hof.js';
// The embedding substrate moved to src/core/embed.js (embed-distance-cli, 2026-11-07) so
// --embed-distance scores an entry the way this script does; re-exported for the test.
import { TEXT_MAX_CHARS, splitName, entryText, entryChunks, sha, cosine, embedAll, CACHE_CHECKPOINT, openEmbedder } from '../src/core/embed.js';
export { TEXT_MAX_CHARS, splitName, entryText, entryChunks, cosine, embedAll, CACHE_CHECKPOINT };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODEL = path.join(ROOT, 'models', 'nomic-embed-text-v1.5.Q8_0.gguf');
const TEXTS = ['description', 'description+purpose', 'purpose', 'label+members'];
const nf = (x) => Number(x || 0).toLocaleString('en-US');
const pct = (n, d) => (d ? `${Math.round(100 * n / d)}%` : '');

export function parseOwnArgs(argv) {
  const o = { hof: [], all: false, hofRoot: null, index: null, model: DEFAULT_MODEL, text: 'description', chunk: 8, fuse: false, compare: null, k: [1, 5, 10, 25], top: 3, cpu: false, prefix: true, dry: false, render: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--hof') o.hof.push(...String(v()).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--all') o.all = true;
    else if (a === '--hof-root') o.hofRoot = v();
    else if (a === '--index') o.index = v();
    else if (a === '--embed-model') o.model = v();
    else if (a === '--text') { o.text = v(); if (!TEXTS.includes(o.text)) throw new Error(`--text takes ${TEXTS.join(' | ')}`); }
    else if (a === '--chunk') { o.chunk = parseInt(v(), 10); if (!Number.isInteger(o.chunk) || o.chunk < 0) throw new Error('--chunk takes a whole number of member names (0 for the whole text)'); }
    else if (a === '--fuse') o.fuse = true;
    else if (a === '--compare') { o.compare = String(v()).split(',').map((s) => s.trim()).filter(Boolean); if (o.compare.length !== 2) throw new Error('--compare takes two record files, a.json,b.json'); }
    else if (a === '--k') o.k = String(v()).split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
    else if (a === '--top') o.top = parseInt(v(), 10) || 3;
    else if (a === '--cpu') o.cpu = true;
    else if (a === '--no-prefix') o.prefix = false;
    else if (a === '--dry') o.dry = true;
    else if (a === '--render') o.render = v();
    else if (a === '--help' || a === '-h') { o.help = true; }
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

// ---- the unit -------------------------------------------------------------
// The text per entry, its chunks and the identifier split live in
// src/core/embed.js (TEXT_MAX_CHARS, entryText, entryChunks, splitName).

/** The indices of the entries whose members hold the anchor (base name of the file, function name with or without its class). */
export function entriesHolding(entries, anchor) {
  const base = String(anchor.base || baseName(anchor.file) || '').toLowerCase();
  const func = String(anchor.func || '');
  const out = [];
  entries.forEach((e, i) => {
    if ((e.members || []).some((m) => baseName(m.file).toLowerCase() === base && (m.name === func || m.name.split('::').pop() === func))) out.push(i);
  });
  return out;
}

/** The elements of a claim as texts (the locator's own split). */
export function claimElements(claimText) {
  const els = splitClaimElements(claimText) || [];
  return els.map((e) => (typeof e === 'string' ? e : String(e.text || e.element || e.limitation || ''))).map((s) => s.trim()).filter((s) => s.length > 15);
}

// ---- scoring --------------------------------------------------------------

/** Conservative ranks: 1 + the entries scoring higher, plus the rest of the tie. */
export function ranksOf(scores) {
  const n = scores.length;
  const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a] || a - b);
  const rank = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[order[j + 1]] === scores[order[i]]) j++;
    for (let t = i; t <= j; t++) rank[order[t]] = j + 1;
    i = j + 1;
  }
  return rank;
}

export function medianOf(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Reciprocal-rank fusion of score lists over the same entries: each list is
 * ranked conservatively and an entry's fused score is the sum of 1/(k + rank).
 * Two rankings that swap places 1 and 2 tie exactly (1/61 + 1/62 both ways),
 * and under the conservative rule a tie takes the last place, which charged
 * the hand-run fusions for agreement they nearly had (2026-11-06); so the
 * last list's rank breaks ties, at a weight below the smallest fused
 * difference two distinct rank pairs can produce on any index of this size.
 */
export const RRF_K = 60;
export function rrfFuse(scoreLists, { k = RRF_K } = {}) {
  const ranks = scoreLists.map((s) => ranksOf(s));
  const n = ranks[0] ? ranks[0].length : 0;
  const last = ranks[ranks.length - 1];
  const out = new Array(n).fill(0);
  for (const r of ranks) for (let i = 0; i < n; i++) out[i] += 1 / (k + r[i]);
  for (let i = 0; i < n; i++) out[i] += 1e-12 / (k + last[i]);
  return out;
}

/**
 * Score a run: `scoreOf(elementText) -> number[]` over the entries. Returns
 * { anchors: [{ claim, anchor, entries, best, hitElement }], ks, reach: {k: n}, median,
 *   strict: { elements, hit }, claims: [{ n, label, elements, anchorsReached: {k: n}, top }] }.
 */
export function scoreRun(claims, entries, scoreOf, { ks = [1, 5, 10, 25], top = 3, elementsOf = null } = {}) {
  const out = { anchors: [], ks, reach: Object.fromEntries(ks.map((k) => [k, 0])), median: null, strict: { elements: 0, hit: 0 }, claims: [], unmapped: 0 };
  for (const c of claims) {
    const els = elementsOf ? elementsOf(c) : claimElements(c.claim);
    const holding = c.anchors.map((a) => entriesHolding(entries, a));
    const ranksPerEl = els.map((t) => ranksOf(scoreOf(t)));
    const anchorSet = new Set(holding.flat());
    const claimRow = { n: c.n, label: c.label, elements: els.length, anchors: c.anchors.length, anchorsReached: Object.fromEntries(ks.map((k) => [k, 0])), top: [] };
    ranksPerEl.forEach((ranks, ei) => {
      const order = [...ranks.keys()].sort((a, b) => ranks[a] - ranks[b]);
      const first = order[0];
      out.strict.elements++;
      if (first != null && anchorSet.has(first)) out.strict.hit++;
      claimRow.top.push({ element: els[ei].slice(0, 80), entries: order.slice(0, top).map((i) => ({ label: entries[i].label, rank: ranks[i], anchor: anchorSet.has(i) })) });
    });
    c.anchors.forEach((a, ai) => {
      const idx = holding[ai];
      if (!idx.length) { out.unmapped++; out.anchors.push({ claim: c.n, anchor: `${a.base}@${a.func}`, entries: 0, best: null }); return; }
      let best = Infinity, hitElement = -1;
      ranksPerEl.forEach((ranks, ei) => { for (const i of idx) if (ranks[i] < best) { best = ranks[i]; hitElement = ei; } });
      if (!ranksPerEl.length) best = Infinity;
      out.anchors.push({ claim: c.n, anchor: `${a.base}@${a.func}`, entries: idx.length, best: Number.isFinite(best) ? best : null, hitElement });
      for (const k of ks) if (best <= k) { out.reach[k]++; claimRow.anchorsReached[k]++; }
    });
    out.claims.push(claimRow);
  }
  out.median = medianOf(out.anchors.map((a) => a.best ?? Infinity));
  return out;
}

// ---- the lexical control: BM25 over the same texts, no model ----------------

const stemsOf = (text) => contentWords(text).map(stem).filter(Boolean);

export function bm25Index(texts, { k1 = 1.2, b = 0.75 } = {}) {
  const docs = texts.map((t) => stemsOf(t));
  const df = new Map();
  for (const d of docs) for (const s of new Set(d)) df.set(s, (df.get(s) || 0) + 1);
  const N = docs.length;
  const avg = docs.reduce((s, d) => s + d.length, 0) / (N || 1);
  const tfs = docs.map((d) => { const m = new Map(); for (const s of d) m.set(s, (m.get(s) || 0) + 1); return m; });
  return {
    score(query) {
      const q = [...new Set(stemsOf(query))];
      return docs.map((d, i) => {
        let s = 0;
        for (const t of q) {
          const tf = tfs[i].get(t) || 0;
          if (!tf) continue;
          const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
          s += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * d.length / (avg || 1)));
        }
        return s;
      });
    },
  };
}

// ---- embedding through node-llama-cpp, cached ------------------------------
// sha, cosine, embedAll (the checkpointed cache) and openEmbedder come from
// src/core/embed.js; the cache files keep their format and keys.

// ---- runs -----------------------------------------------------------------

function readRun(dir) {
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'claims.txt.anchors.json'), 'utf8'));
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'hof_report.json'), 'utf8'));
  const claims = parseSidecar(sidecar).filter((c) => c.anchors.length);
  const indexPath = report.indexPath || report.index || null;
  return { dir, name: path.basename(dir), claims, report, indexPath };
}

function resolveIndex(run, override) {
  const p = override || run.indexPath;
  if (!p) throw new Error(`${run.name}: the report names no index; pass --index`);
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

export function locatorBaseline(report) {
  const t = (report && report.totals) || {};
  return { anchors: t.anchors || 0, fn: t.function || 0, fileOrBetter: (t.function || 0) + (t.class || 0) + (t.file || 0) };
}

function listRuns(root) {
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    if (fs.existsSync(path.join(dir, 'claims.txt.anchors.json')) && fs.existsSync(path.join(dir, 'hof_report.json'))) out.push(dir);
  }
  return out.sort();
}

/**
 * The latest run per index name whose index is described: nine records in
 * ten carrying a sentence (WinAPI's 735 of 13,078 under a filter would have
 * put 11,000 purposes into a "descriptions" table, 2026-11-05).
 */
function describedRuns(root, minShare = 0.9) {
  const byIndex = new Map();
  for (const dir of listRuns(root)) {
    let run;
    try { run = readRun(dir); } catch { continue; }
    let data = null;
    try { data = loadMechanismsIndex({ indexPath: resolveIndex(run, null) }, { cache: false }); } catch { data = null; }
    if (!data || !data.records.length || data.records.filter((r) => r.description).length < minShare * data.records.length) continue;
    const key = String(run.report.index || run.name.replace(/_\d{6}-\d{4}$/, ''));
    byIndex.set(key, dir);   // sorted ascending, so the last wins
  }
  return [...byIndex.values()];
}

// ---- report ---------------------------------------------------------------

export function renderRun(r) {
  const L = [];
  const { name, entries, textKinds, claims, anchors, methods, locator, ks } = r;
  L.push(`### ${name}`, '', `${nf(entries)} entries (${Object.entries(textKinds).map(([k, v]) => `${nf(v)} ${k}`).join(', ')} as the text); ${claims.length} claims, ${anchors} anchors${r.unmapped ? `, ${r.unmapped} in no entry` : ''}.`, '');
  L.push(`| method | ${ks.map((k) => `reach@${k}`).join(' | ')} | median rank | strict (element's top entry holds an anchor) |`);
  L.push(`|---|${ks.map(() => '---:').join('|')}|---:|---:|`);
  for (const [label, s] of Object.entries(methods)) {
    L.push(`| ${label} | ${ks.map((k) => `${s.reach[k]} (${pct(s.reach[k], anchors)})`).join(' | ')} | ${s.median == null ? '' : s.median} | ${s.strict.hit} of ${s.strict.elements} (${pct(s.strict.hit, s.strict.elements)}) |`);
  }
  L.push(`| locator (hof_report): anchors at the function rung | ${locator.fn} (${pct(locator.fn, locator.anchors)}) | | | | | |`.replace(/\| \| \| \| \| \|$/, ks.length === 4 ? '| | | | |' : '|'));
  L.push(`| locator: at the file rung or better | ${locator.fileOrBetter} (${pct(locator.fileOrBetter, locator.anchors)}) | | | | | |`.replace(/\| \| \| \| \| \|$/, ks.length === 4 ? '| | | | |' : '|'));
  L.push('');
  return L;
}

export function renderPooled(runs, ks) {
  const names = [...new Set(runs.flatMap((r) => Object.keys(r.methods)))];
  const anchors = runs.reduce((s, r) => s + r.anchors, 0);
  const L = [`### Pooled over ${runs.length} runs, ${nf(anchors)} anchors`, '', `| method | ${ks.map((k) => `reach@${k}`).join(' | ')} | strict |`, `|---|${ks.map(() => '---:').join('|')}|---:|`];
  for (const m of names) {
    const rs = runs.filter((r) => r.methods[m]);
    const reach = ks.map((k) => rs.reduce((s, r) => s + r.methods[m].reach[k], 0));
    const hit = rs.reduce((s, r) => s + r.methods[m].strict.hit, 0), els = rs.reduce((s, r) => s + r.methods[m].strict.elements, 0);
    L.push(`| ${m} | ${reach.map((n) => `${n} (${pct(n, anchors)})`).join(' | ')} | ${hit} of ${els} (${pct(hit, els)}) |`);
  }
  const fn = runs.reduce((s, r) => s + r.locator.fn, 0), fb = runs.reduce((s, r) => s + r.locator.fileOrBetter, 0);
  L.push(`| locator: function rung | ${fn} (${pct(fn, anchors)}) | ${ks.slice(1).map(() => '').join(' | ')} | |`);
  L.push(`| locator: file rung or better | ${fb} (${pct(fb, anchors)}) | ${ks.slice(1).map(() => '').join(' | ')} | |`);
  L.push('');
  return L;
}

/**
 * Two --render records of the same runs side by side: per run and pooled, each
 * method present in both, reach at the first and last common depth and strict,
 * under A, under B, and B minus A. A method one record lacks shows a dash on
 * that side and no difference. Runs are matched by name.
 */
export function renderCompare(a, b, { nameA = null, nameB = null } = {}) {
  const describer = (rec) => { const es = [...new Set((rec.runs || []).map((r) => r.describedEngine).filter(Boolean))]; return es.length ? es.join(' / ') : null; };
  const A = nameA || describer(a) || 'A', B = nameB || describer(b) || 'B';
  const ks = (a.ks || [1]).filter((k) => (b.ks || []).includes(k));
  const kLo = ks[0] ?? 1, kHi = ks[ks.length - 1] ?? kLo;
  const pairs = (a.runs || []).map((ra) => [ra, (b.runs || []).find((rb) => rb.name === ra.name)]).filter(([, rb]) => rb);
  const L = [`## ${A} against ${B}: ${pairs.length} run${pairs.length === 1 ? '' : 's'} in common${(a.text || b.text) ? ` (text ${a.text || '?'} / ${b.text || '?'})` : ''}`, ''];
  const cell = (m, anchors, k) => (m ? `${pct(m.reach[k] || 0, anchors)}` : '—');
  const strictCell = (m) => (m ? pct(m.strict.hit, m.strict.elements) : '—');
  const delta = (ma, mb, anchorsA, anchorsB, k) => (ma && mb ? `${Math.round(100 * (mb.reach[k] || 0) / anchorsB) - Math.round(100 * (ma.reach[k] || 0) / anchorsA)}` : '');
  const sdelta = (ma, mb) => (ma && mb ? `${Math.round(100 * mb.strict.hit / (mb.strict.elements || 1)) - Math.round(100 * ma.strict.hit / (ma.strict.elements || 1))}` : '');
  const header = () => { L.push(`| method | reach@${kLo} ${A} | ${B} | Δ | reach@${kHi} ${A} | ${B} | Δ | strict ${A} | ${B} | Δ |`, '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'); };
  const methodNames = (ra, rb) => [...new Set([...Object.keys(ra.methods || {}), ...Object.keys(rb.methods || {})])].filter((m) => !/shuffled/.test(m));
  for (const [ra, rb] of pairs) {
    L.push(`### ${ra.name} (${ra.anchors} anchors${ra.describedEngine || rb.describedEngine ? `; described by ${ra.describedEngine || '?'} / ${rb.describedEngine || '?'}` : ''})`, '');
    header();
    for (const m of methodNames(ra, rb)) {
      const ma = ra.methods[m], mb = rb.methods[m];
      L.push(`| ${m} | ${cell(ma, ra.anchors, kLo)} | ${cell(mb, rb.anchors, kLo)} | ${delta(ma, mb, ra.anchors, rb.anchors, kLo)} | ${cell(ma, ra.anchors, kHi)} | ${cell(mb, rb.anchors, kHi)} | ${delta(ma, mb, ra.anchors, rb.anchors, kHi)} | ${strictCell(ma)} | ${strictCell(mb)} | ${sdelta(ma, mb)} |`);
    }
    L.push(`| locator: function rung | ${pct(ra.locator.fn, ra.locator.anchors)} | ${pct(rb.locator.fn, rb.locator.anchors)} | | | | | | | |`, '');
  }
  if (pairs.length > 1) {
    const anchorsA = pairs.reduce((s, [ra]) => s + ra.anchors, 0), anchorsB = pairs.reduce((s, [, rb]) => s + rb.anchors, 0);
    const names = [...new Set(pairs.flatMap(([ra, rb]) => methodNames(ra, rb)))];
    L.push(`### Pooled over ${pairs.length} runs, ${nf(anchorsA)} anchors`, '');
    header();
    for (const m of names) {
      const sum = (side) => { const rs = pairs.map(([ra, rb]) => (side === 0 ? ra : rb)).filter((r) => r.methods[m]); if (rs.length !== pairs.length) return null; return { reach: Object.fromEntries(ks.map((k) => [k, rs.reduce((s, r) => s + (r.methods[m].reach[k] || 0), 0)])), strict: { hit: rs.reduce((s, r) => s + r.methods[m].strict.hit, 0), elements: rs.reduce((s, r) => s + r.methods[m].strict.elements, 0) } }; };
      const ma = sum(0), mb = sum(1);
      L.push(`| ${m} | ${cell(ma, anchorsA, kLo)} | ${cell(mb, anchorsB, kLo)} | ${delta(ma, mb, anchorsA, anchorsB, kLo)} | ${cell(ma, anchorsA, kHi)} | ${cell(mb, anchorsB, kHi)} | ${delta(ma, mb, anchorsA, anchorsB, kHi)} | ${strictCell(ma)} | ${strictCell(mb)} | ${sdelta(ma, mb)} |`);
    }
    L.push('');
  }
  return L;
}

function renderDetail(r, top) {
  const L = [`<details><summary>${r.name}: per element, the top ${top} entries (embedding)</summary>`, ''];
  const m = r.methods[r.primary];
  for (const c of m.claims) {
    L.push(`**Claim ${c.n}** ${c.label} (${c.anchors} anchors; reached ${Object.entries(c.anchorsReached).map(([k, n]) => `@${k} ${n}`).join(', ')})`, '');
    for (const t of c.top) L.push(`- "${t.element}…" → ${t.entries.map((e) => `${e.anchor ? '**' : ''}${e.label}${e.anchor ? '**' : ''}`).join('; ')}`);
    L.push('');
  }
  L.push('</details>', '');
  return L;
}

// ---- main -----------------------------------------------------------------

async function main() {
  let o;
  try { o = parseOwnArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => /^ \*( |$)/.test(l)).map((l) => l.slice(3)).join('\n')); return; }
  if (o.compare) {
    const [a, b] = o.compare.map((f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')));
    const [nameA, nameB] = o.compare.map((f) => path.basename(f).replace(/\.json$/i, ''));
    const text = renderCompare(a, b, { nameA: a.runs && a.runs.some((r) => r.describedEngine) ? null : nameA, nameB: b.runs && b.runs.some((r) => r.describedEngine) ? null : nameB }).join('\n');
    console.log(text);
    if (o.render) { fs.mkdirSync(path.dirname(path.resolve(o.render)), { recursive: true }); fs.writeFileSync(o.render, text + '\n'); console.error(`# written ${o.render}`); }
    return;
  }
  const root = o.hofRoot || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share'), 'CodeExam', 'hof');
  const dirs = o.all ? describedRuns(root) : o.hof.map((d) => path.resolve(d));
  if (!dirs.length) { console.error('no HOF runs: pass --hof <dir> or --all'); process.exit(2); }
  if (o.index && dirs.length > 1) { console.error('--index goes with one --hof dir'); process.exit(2); }
  if (!o.dry && !fs.existsSync(o.model)) { console.error(`embedding model not found: ${o.model} (pass --embed-model <gguf>, or --dry for the lexical control only)`); process.exit(2); }

  const runs = dirs.map((d) => readRun(d));
  const modelBase = path.basename(o.model).replace(/\.gguf$/i, '');
  let embedder = null;
  if (!o.dry) {
    process.stderr.write(`# loading ${modelBase}${o.cpu ? ' (cpu)' : ''}…\n`);
    embedder = await openEmbedder(o.model, { cpu: o.cpu });
  }
  const results = [];
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri];
    const indexPath = resolveIndex(run, o.index);
    const data = loadMechanismsIndex({ indexPath }, { cache: false });
    if (!data) { console.error(`${run.name}: ${indexPath} has no mechanisms.json; skipped`); continue; }
    const entries = foldRecords(data.records);
    const texts = entries.map((e) => entryText(e, o.text));
    const textKinds = {};
    for (const t of texts) textKinds[t.kind] = (textKinds[t.kind] || 0) + 1;
    const anchors = run.claims.reduce((s, c) => s + c.anchors.length, 0);
    process.stderr.write(`# ${run.name}: ${nf(entries.length)} entries, ${run.claims.length} claims, ${anchors} anchors; index ${indexPath}\n`);
    const control = runs[(ri + 1) % runs.length];
    const useControl = runs.length > 1 && control !== run;
    const methods = {};
    const elementsCache = new Map();
    const elsOf = (c) => { if (!elementsCache.has(c)) elementsCache.set(c, claimElements(c.claim)); return elementsCache.get(c); };
    // the shuffled control pairs this run's claims (and anchors) with the next run's elements, claim by claim
    const controlElsOf = (c) => { const i = run.claims.indexOf(c); const cc = control.claims[i % control.claims.length]; return elsOf(cc); };

    const lex = bm25Index(texts.map((t) => t.text));
    methods['lexical (BM25 on the same texts, no model)'] = scoreRun(run.claims, entries, (t) => lex.score(t), { ks: o.k, top: o.top, elementsOf: elsOf });
    if (useControl) methods['lexical, shuffled control (another run\'s elements)'] = scoreRun(run.claims, entries, (t) => lex.score(t), { ks: o.k, top: o.top, elementsOf: controlElsOf });

    let primary = Object.keys(methods)[0];
    let chunked = 0;
    if (embedder) {
      const prefixDoc = o.prefix && /nomic/i.test(modelBase) ? 'search_document: ' : '';
      const prefixQ = o.prefix && /nomic/i.test(modelBase) ? 'search_query: ' : '';
      const cacheDir = path.join(run.dir, 'describe-reach');
      const indexName = path.basename(indexPath).replace(/^\./, '');
      const entryVecs = await embedAll(embedder.ctx, entries.map((e, i) => ({ key: `${e.id}:${i}`, text: texts[i].text })), path.join(cacheDir, `${indexName}_${modelBase}_${o.text}.json`), { prefix: prefixDoc, label: `${run.name} entries` });
      // chunks: the label-and-members text as runs of --chunk names; a chunk equal to the whole text reuses its vector
      const chunkTexts = entries.map((e) => entryChunks(e, o.text, o.chunk));
      const extra = [];
      chunkTexts.forEach((cs, i) => { if (cs.length > 1) chunked++; cs.forEach((t, c) => { if (t !== texts[i].text) extra.push({ key: `${entries[i].id}:${i}:${c}`, text: t }); }); });
      const chunkVecs = extra.length ? await embedAll(embedder.ctx, extra, path.join(cacheDir, `${indexName}_${modelBase}_chunks${o.chunk}.json`), { prefix: prefixDoc, label: `${run.name} chunks` }) : new Map();
      const vecsOf = entries.map((e, i) => chunkTexts[i].map((t, c) => (t === texts[i].text ? entryVecs.get(`${e.id}:${i}`) : chunkVecs.get(`${e.id}:${i}:${c}`))));
      const elTexts = [];
      for (const c of [...run.claims, ...(useControl ? control.claims : [])]) for (const t of elsOf(c)) elTexts.push({ key: sha(t), text: t });
      const elVecs = await embedAll(embedder.ctx, elTexts, path.join(cacheDir, `elements_${modelBase}.json`), { prefix: prefixQ, label: `${run.name} elements` });
      const scoreEmbed = (t) => { const q = elVecs.get(sha(t)); return vecsOf.map((vs) => { let b = -2; for (const v of vs) { const c = cosine(q, v); if (c > b) b = c; } return b; }); };
      const label = `embedding (${modelBase}, ${o.text}${chunked ? `, best chunk of ${o.chunk}` : ''})`;
      methods[label] = scoreRun(run.claims, entries, scoreEmbed, { ks: o.k, top: o.top, elementsOf: elsOf });
      if (useControl) methods[`embedding, shuffled control`] = scoreRun(run.claims, entries, scoreEmbed, { ks: o.k, top: o.top, elementsOf: controlElsOf });
      if (o.fuse) {
        const fused = (t) => rrfFuse([lex.score(t), scoreEmbed(t)]);
        methods[`lexical + embedding, fused (reciprocal rank, k=${RRF_K}; ties to the embedding)`] = scoreRun(run.claims, entries, fused, { ks: o.k, top: o.top, elementsOf: elsOf });
        if (useControl) methods['fused, shuffled control'] = scoreRun(run.claims, entries, fused, { ks: o.k, top: o.top, elementsOf: controlElsOf });
      }
      primary = label;
    }
    const describedEngine = (data.described && data.described.engine) || null;
    results.push({ name: run.name, index: indexPath, entries: entries.length, textKinds, chunk: o.chunk, chunked, describedEngine, claims: run.claims, anchors, unmapped: methods[primary].unmapped, methods, locator: locatorBaseline(run.report), ks: o.k, primary });
  }
  if (embedder) await embedder.dispose();

  const L = [];
  for (const r of results) { L.push(...renderRun(r)); if (!o.dry) L.push(...renderDetail(r, o.top)); }
  if (results.length > 1) L.push(...renderPooled(results, o.k));
  const text = L.join('\n');
  console.log(text);
  if (o.render) {
    fs.mkdirSync(path.dirname(path.resolve(o.render)), { recursive: true });
    fs.writeFileSync(o.render, text + '\n');
    const rec = path.resolve(o.render).replace(/\.md$/i, '') + '.json';
    fs.writeFileSync(rec, JSON.stringify({ format: 'ce-describe-reach', generated: new Date().toISOString(), model: o.dry ? null : modelBase, text: o.text, chunk: o.dry ? null : o.chunk, fuse: o.fuse, ks: o.k, runs: results.map((r) => ({ ...r, claims: r.claims.map((c) => ({ n: c.n, label: c.label, anchors: c.anchors.length })) })) }, null, 1));
    console.error(`# written ${o.render} and ${rec}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });
}
