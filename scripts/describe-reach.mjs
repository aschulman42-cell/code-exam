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
 *        [--k 1,5,10,25] [--top N] [--cpu] [--no-prefix] [--dry] [--render <file.md>]
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
 * re-described file re-embeds only what changed. A cache is an artifact of the index
 * (#361's inventory). A VALIDATION HARNESS, beside hof.mjs and hof-stage1.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMechanismsIndex, foldRecords } from '../src/core/mechanisms-index.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { contentWords, stem } from '../src/core/claim-terms.js';
import { parseSidecar, baseName } from './hof.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MODEL = path.join(ROOT, 'models', 'nomic-embed-text-v1.5.Q8_0.gguf');
const TEXTS = ['description', 'description+purpose', 'purpose', 'label+members'];
const nf = (x) => Number(x || 0).toLocaleString('en-US');
const pct = (n, d) => (d ? `${Math.round(100 * n / d)}%` : '');

export function parseOwnArgs(argv) {
  const o = { hof: [], all: false, hofRoot: null, index: null, model: DEFAULT_MODEL, text: 'description', k: [1, 5, 10, 25], top: 3, cpu: false, prefix: true, dry: false, render: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--hof') o.hof.push(...String(v()).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--all') o.all = true;
    else if (a === '--hof-root') o.hofRoot = v();
    else if (a === '--index') o.index = v();
    else if (a === '--embed-model') o.model = v();
    else if (a === '--text') { o.text = v(); if (!TEXTS.includes(o.text)) throw new Error(`--text takes ${TEXTS.join(' | ')}`); }
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

// A text longer than the embedding context fails the call (a giant entry's
// member list on WinAPI did, 2026-11-05); every text is cut here, well under
// the context the embedder opens below. The cut is reported per entry's kind,
// not hidden: a description never reaches it, a purpose or a member list can.
export const TEXT_MAX_CHARS = 1500;
const cut = (s) => (s.length > TEXT_MAX_CHARS ? s.slice(0, TEXT_MAX_CHARS) : s);

/** The text embedded per entry under `mode`, with `kind` saying which text answered (the description, else the purpose, else the label and members). */
export function entryText(e, mode) {
  const d = String(e.description || '').trim();
  const p = String(e.purpose || '').trim();
  const lm = `${e.label}: ${(e.members || []).map((m) => splitName(m.name)).join(', ')}`;
  const r = (text, kind) => ({ text: cut(text), kind });
  if (mode === 'description') return d ? r(d, 'description') : p ? r(p, 'purpose') : r(lm, 'label');
  if (mode === 'description+purpose') return r([d, p].filter(Boolean).join(' ') || lm, d ? 'description' : p ? 'purpose' : 'label');
  if (mode === 'purpose') return p ? r(p, 'purpose') : r(lm, 'label');
  return r(lm, 'label');
}

/** An identifier as words: camel, snake, ::, . split, the way the symbol searches split it. */
export function splitName(name) {
  return String(name || '').replace(/[:.]+/g, ' ').replace(/[_\-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

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

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
const normalize = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function readCache(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.items ? j : { items: {} }; } catch { return { items: {} }; }
}

/** Embed `texts` (array of { key, text }) with the cache at `file`; returns a Map key -> unit vector. */
async function embedAll(ctx, texts, file, { prefix = '', label = '' } = {}) {
  const cache = readCache(file);
  const out = new Map();
  let fresh = 0;
  const t0 = Date.now();
  for (const { key, text } of texts) {
    const h = sha(prefix + text);
    const hit = cache.items[key];
    if (hit && hit.h === h && Array.isArray(hit.v)) { out.set(key, hit.v); continue; }
    const e = await ctx.getEmbeddingFor(prefix + text);
    const v = normalize([...e.vector]);
    cache.items[key] = { h, v };
    out.set(key, v);
    fresh++;
    if (fresh % 100 === 0) process.stderr.write(`  ${label}: ${nf(fresh)} embedded…\n`);
  }
  if (fresh) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ format: 'ce-describe-reach-vectors', generated: new Date().toISOString(), items: cache.items }));
  }
  process.stderr.write(`  ${label}: ${nf(texts.length)} texts, ${nf(fresh)} embedded, ${nf(texts.length - fresh)} from cache, ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  return out;
}

async function openEmbedder(modelPath, { cpu = false } = {}) {
  const { getLlamaShared } = await import('../src/core/llm-runner.js');
  const llama = await getLlamaShared({ cpu });
  const model = await llama.loadModel({ modelPath });
  // 2048 tokens holds any text TEXT_MAX_CHARS allows, identifiers included.
  const ctx = await model.createEmbeddingContext({ contextSize: 2048 });
  return { ctx, dispose: async () => { await ctx.dispose(); await model.dispose(); } };
}

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
    if (embedder) {
      const prefixDoc = o.prefix && /nomic/i.test(modelBase) ? 'search_document: ' : '';
      const prefixQ = o.prefix && /nomic/i.test(modelBase) ? 'search_query: ' : '';
      const cacheDir = path.join(run.dir, 'describe-reach');
      const indexName = path.basename(indexPath).replace(/^\./, '');
      const entryVecs = await embedAll(embedder.ctx, entries.map((e, i) => ({ key: `${e.id}:${i}`, text: texts[i].text })), path.join(cacheDir, `${indexName}_${modelBase}_${o.text}.json`), { prefix: prefixDoc, label: `${run.name} entries` });
      const vecs = entries.map((e, i) => entryVecs.get(`${e.id}:${i}`));
      const elTexts = [];
      for (const c of [...run.claims, ...(useControl ? control.claims : [])]) for (const t of elsOf(c)) elTexts.push({ key: sha(t), text: t });
      const elVecs = await embedAll(embedder.ctx, elTexts, path.join(cacheDir, `elements_${modelBase}.json`), { prefix: prefixQ, label: `${run.name} elements` });
      const scoreEmbed = (t) => { const q = elVecs.get(sha(t)); return vecs.map((v) => cosine(q, v)); };
      const label = `embedding (${modelBase}, ${o.text})`;
      methods[label] = scoreRun(run.claims, entries, scoreEmbed, { ks: o.k, top: o.top, elementsOf: elsOf });
      if (useControl) methods[`embedding, shuffled control`] = scoreRun(run.claims, entries, scoreEmbed, { ks: o.k, top: o.top, elementsOf: controlElsOf });
      primary = label;
    }
    results.push({ name: run.name, index: indexPath, entries: entries.length, textKinds, claims: run.claims, anchors, unmapped: methods[primary].unmapped, methods, locator: locatorBaseline(run.report), ks: o.k, primary });
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
    fs.writeFileSync(rec, JSON.stringify({ format: 'ce-describe-reach', generated: new Date().toISOString(), model: o.dry ? null : modelBase, text: o.text, ks: o.k, runs: results.map((r) => ({ ...r, claims: r.claims.map((c) => ({ n: c.n, label: c.label, anchors: c.anchors.length })) })) }, null, 1));
    console.error(`# written ${o.render} and ${rec}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e && e.stack || String(e)); process.exit(1); });
}
