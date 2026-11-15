#!/usr/bin/env node
// function-text-reach.mjs — does text CodeExam builds mechanically for a function, class or file (no model) sit near a claim limitation under a local embedding model, against the mechanism labels as baseline; scored on litigants' chart rows and on the self-test's claims
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * scripts/function-text-reach.mjs — function-text-reach-test (2026-11-14).
 *
 * The containment test (scripts/mechanism-containment.mjs) found that the
 * functions a litigant cites for one claim limitation sit in no one mechanism,
 * file or call group. This script asks the retrieval question instead: rank
 * every unit of an index by cosine to the limitation's text and see where the
 * cited functions land, as a set. The text per function is built by
 * src/core/function-text.js from the index alone (name words; plus ranked body
 * vocabulary; plus comments and string literals; plus the names around it).
 *
 * Usage:
 *   node scripts/function-text-reach.mjs --filings <work dir> [--only id,id]
 *   node scripts/function-text-reach.mjs --hof <run dir>[,<run dir>...] [--index <path>] [--claims-file <file>]
 *        [--arms name,vocab,comments,context] [--k 1,5,25,100] [--pool N] [--limit N]
 *        [--embed-model nomic] [--cpu] [--cache <dir>] [--dry] [--json <file>] [--md]
 *
 *   --filings <dir>   the work directory of scripts/recap-chart-agreement.mjs: each chart
 *                     row is one query (the limitation's text) with the functions cited
 *                     for it as the answer, matched the way mechanism-containment matches
 *   --hof <dir>       self-test run directories (claims.txt.anchors.json, hof_report.json):
 *                     each claim is one query of several texts (its elements) with the
 *                     drafter's grounded anchors as the answer; a function's rank is its
 *                     best under any element, the earlier pages' rule
 *   --claims-file     with one --hof run: other wording for its claims, one per line in the
 *                     run's order (# lines skipped), e.g. the synonymized claims
 *   --arms            the function texts to embed (default all four)
 *   --pool N          an index with more functions than N is sampled: the answers, every
 *                     function of the answers' files, then functions by a fixed hash order
 *                     up to N (default 3500). Ranks on a sampled index are ranks in the
 *                     sample, flagged in the output, and the mechanism, class and file
 *                     units are cut to those holding a sampled function
 *   --limit N         the first N queries per index (a smoke run)
 *   --dry             no model: counts and three sample texts per arm
 *   --cache <dir>     where vectors are kept (default %LOCALAPPDATA%\CodeExam\function-text)
 *
 * Methods, one line of the result each. Unit function: the four arms. Units
 * mechanism, class and file: their own text (the mechanism's label and member
 * names in chunks of 8, the baseline of docs/describe-reach.md, and its purpose
 * line; a class's or file's ranked vocabulary), and each function arm rolled up,
 * the unit scoring as its best function.
 *
 * Reading a query's answer, a set, at depth k: the functions within k, any
 * within k, all within k (counted over queries with two or more). A function
 * no unit of a kind holds (a free function has no class, one under four lines
 * no mechanism) is left out of that kind's count and reported.
 *
 * Ranks are conservative (a tie takes its last place). Two controls stand beside
 * every depth. The first is the next query's text against this query's answer:
 * on a chart that is another limitation of the same patent, whose cited code
 * sits nearby, so it says whether a text tells one limitation from another. The
 * second is chance: as many functions as the answer has, drawn from the pool by
 * a fixed seed, under the query's own text. Unit counts differ by kind, so a
 * rank of 25 among 170 mechanisms is not a rank of 25 among 900 functions: the
 * roll-up lines are the like-for-like comparison, and the unit count is printed.
 *
 * The charts are parties' advocacy: a hit is agreement with a party, not
 * correctness. The self-test's claims were drafted from a mechanism, which
 * favours the mechanism lines. A VALIDATION HARNESS, no CLI change.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARMS, buildCorpus, functionText, unitChunks, unitsOf, rollUp, setReading, leafOf } from '../src/core/function-text.js';
import { resolveEmbedModel, entryChunks, entryText, embedAll, openEmbedder, median } from '../src/core/embed.js';
import { foldRecords } from '../src/core/mechanisms-index.js';
import { parseSidecar, baseName } from '../src/core/hof.js';
import { functionsByFile, recordsByMember, scoreFiling, filingsOf, oneFunctionIds } from './mechanism-containment.mjs';
import { claimElements, ranksOf } from './describe-reach.mjs';

const slash = (s) => String(s || '').replace(/\\/g, '/');
const nf = (x) => Number(x || 0).toLocaleString('en-US');

export function parseOwnArgs(argv) {
  const o = { filings: null, only: null, hof: [], index: null, claimsFile: null, arms: [...ARMS], k: [1, 5, 25, 100], pool: 3500, limit: 0, model: 'nomic', cpu: false, cache: null, dry: false, json: null, md: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${a} takes a value`); return argv[++i]; };
    const list = () => String(v()).split(',').map((s) => s.trim()).filter(Boolean);
    if (a === '--filings') o.filings = v();
    else if (a === '--only') o.only = list();
    else if (a === '--hof') o.hof.push(...list());
    else if (a === '--index') o.index = v();
    else if (a === '--claims-file') o.claimsFile = v();
    else if (a === '--arms') { o.arms = list(); for (const x of o.arms) if (!ARMS.includes(x)) throw new Error(`--arms takes ${ARMS.join(', ')}; got "${x}"`); }
    else if (a === '--k') o.k = list().map((s) => parseInt(s, 10)).filter((n) => n > 0);
    else if (a === '--pool') { o.pool = parseInt(v(), 10); if (!(o.pool > 0)) throw new Error('--pool takes a number of functions'); }
    else if (a === '--limit') o.limit = parseInt(v(), 10) || 0;
    else if (a === '--embed-model') o.model = v();
    else if (a === '--cpu') o.cpu = true;
    else if (a === '--cache') o.cache = v();
    else if (a === '--dry') o.dry = true;
    else if (a === '--json') o.json = v();
    else if (a === '--md') o.md = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help && !o.filings && !o.hof.length) throw new Error('give --filings <work dir> or --hof <run dir>');
  if (o.claimsFile && o.hof.length !== 1) throw new Error('--claims-file goes with one --hof run');
  return o;
}

// ---- the pool ---------------------------------------------------------------

const hashOrder = (id) => crypto.createHash('sha1').update(id).digest('hex');

/**
 * The functions scored: all of them when the index has at most `pool`;
 * otherwise the answers, every function of the answers' files, and functions in
 * a fixed hash order up to `pool`. Returns { fns, sampled }.
 */
export function pickPool(fns, answerIds, pool) {
  if (fns.length <= pool) return { fns, sampled: false };
  const files = new Set(fns.filter((f) => answerIds.has(f.id)).map((f) => f.file));
  const keep = fns.filter((f) => answerIds.has(f.id) || files.has(f.file));
  const kept = new Set(keep.map((f) => f.id));
  const rest = fns.filter((f) => !kept.has(f.id)).map((f) => [hashOrder(f.id), f]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  for (const [, f] of rest) { if (keep.length >= pool) break; keep.push(f); }
  return { fns: keep, sampled: true };
}

/** The function ids an anchor of the self-test names: same file base name, the name or its last segment. */
export function anchorIds(fns, anchor) {
  const base = String(anchor.base || baseName(anchor.file) || '').toLowerCase();
  const func = String(anchor.func || '');
  return fns.filter((f) => baseName(f.file).toLowerCase() === base && (f.name === func || leafOf(f.name) === func)).map((f) => f.id);
}

// ---- scoring ----------------------------------------------------------------

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/**
 * One query read under one method. `rankLists` are the unit ranks under each of
 * the query's texts; `holders` maps a function id to the unit positions holding
 * it. Returns { ranks (the held answers' best ranks), notHeld }.
 */
export function answerRanks(rankLists, holders, answers) {
  const ranks = [];
  let notHeld = 0;
  for (const id of answers) {
    const pos = holders.get(id);
    if (!pos || !pos.length) { notHeld++; continue; }
    let best = Infinity;
    for (const r of rankLists) for (const p of pos) if (r[p] < best) best = r[p];
    ranks.push(best);
  }
  return { ranks, notHeld };
}

export const emptyTally = (ks) => ({ queries: 0, multi: 0, answers: 0, notHeld: 0, hit: Object.fromEntries(ks.map((k) => [k, 0])), any: Object.fromEntries(ks.map((k) => [k, 0])), all: Object.fromEntries(ks.map((k) => [k, 0])), ranks: [] });

/** Add one query's held ranks to a tally. A query with no held answer adds only to notHeld. */
export function addToTally(t, ranks, notHeld, ks) {
  t.notHeld += notHeld;
  if (!ranks.length) return t;
  t.queries++;
  if (ranks.length >= 2) t.multi++;
  t.answers += ranks.length;
  t.ranks.push(...ranks);
  for (const k of ks) {
    const r = setReading(ranks, k);
    t.hit[k] += r.hit;
    if (r.any) t.any[k]++;
    if (r.all && ranks.length >= 2) t.all[k]++;
  }
  return t;
}

export function mergeTally(a, b, ks) {
  const o = emptyTally(ks);
  for (const t of [a, b]) {
    if (!t) continue;
    o.queries += t.queries; o.multi += t.multi; o.answers += t.answers; o.notHeld += t.notHeld; o.ranks.push(...t.ranks);
    for (const k of ks) { o.hit[k] += t.hit[k]; o.any[k] += t.any[k]; o.all[k] += t.all[k]; }
  }
  return o;
}

/**
 * Score an index. `methods`: [{ name, unit, units (count), holders, scoreOf(queryVec, shared) -> number[] }]
 * where `shared` is a per-text scratch object methods may leave function scores
 * in for the roll-ups after them. `queries`: [{ id, vecs, answers }].
 * Returns { [method name]: { real, control, chance } } tallies.
 */
function seeded(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function scoreIndex(methods, queries, ks) {
  const out = Object.fromEntries(methods.map((m) => [m.name, { real: emptyTally(ks), control: emptyTally(ks), chance: emptyTally(ks) }]));
  const heldIds = new Map(methods.map((m) => [m.name, [...m.holders.keys()].filter((id) => (m.holders.get(id) || []).length).sort()]));
  const rankOf = (q) => {
    const per = Object.fromEntries(methods.map((m) => [m.name, []]));
    for (const v of q.vecs) { const shared = {}; for (const m of methods) per[m.name].push(ranksOf(Array.from(m.scoreOf(v, shared)))); }
    return per;
  };
  let first = null;
  let prev = null;
  queries.forEach((q, i) => {
    const per = rankOf(q);
    if (i === 0) first = per;
    for (const m of methods) {
      const a = answerRanks(per[m.name], m.holders, q.answers);
      addToTally(out[m.name].real, a.ranks, a.notHeld, ks);
      // Chance: as many held functions as the answer has, by a fixed seed.
      const pool = heldIds.get(m.name);
      if (a.ranks.length && pool.length) { const rnd = seeded(i + 1); const draw = Array.from({ length: a.ranks.length }, () => pool[Math.floor(rnd() * pool.length)]); addToTally(out[m.name].chance, answerRanks(per[m.name], m.holders, draw).ranks, 0, ks); }
      // The control: the query before this one, read under this one's text.
      if (prev) { const c = answerRanks(per[m.name], m.holders, prev.answers); addToTally(out[m.name].control, c.ranks, 0, ks); }
    }
    prev = q;
  });
  if (queries.length > 1 && first) for (const m of methods) { const c = answerRanks(first[m.name], m.holders, prev.answers); addToTally(out[m.name].control, c.ranks, 0, ks); }
  return out;
}

// ---- one index ----------------------------------------------------------------

async function loadIndex(dir) {
  const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
  const log = console.log;
  console.log = () => {};   // the index loader reports progress on stdout
  try { const idx = new CodeSearchIndex({ indexPath: dir }); if (idx._ensureFunctionIndex) idx._ensureFunctionIndex(); return idx; } finally { console.log = log; }
}

/** Chunk texts -> a scorer giving each unit its best chunk's cosine. `chunkUnit[i]` is the unit of chunk i. */
function bestChunkScorer(vecs, chunkUnit, units) {
  return (q) => { const s = new Array(units).fill(-Infinity); for (let i = 0; i < vecs.length; i++) { const c = dot(q, vecs[i]); if (c > s[chunkUnit[i]]) s[chunkUnit[i]] = c; } return s; };
}

/**
 * Build the methods for an index and embed what they need. `answerIds` is every
 * answer of the index's queries (the pool keeps them). Returns
 * { methods, info } or, with o.dry, { info } and prints samples.
 */
async function prepare(dir, name, answerIds, o, embedder) {
  const idx = await loadIndex(dir);
  const corpus = buildCorpus(idx.functionIndex || {}, (f) => idx.fileLines.get(f));
  const { fns, sampled } = pickPool(corpus.fns, answerIds, o.pool);
  const pos = new Map(fns.map((f, i) => [f.id, i]));
  const info = { index: name, functions: corpus.n, pool: fns.length, sampled };
  const cacheDir = path.join(o.cache || path.join(process.env.LOCALAPPDATA || '.', 'CodeExam', 'function-text'), name);

  // Units and the functions they hold, as pool positions.
  let records = [];
  try { records = foldRecords(JSON.parse(fs.readFileSync(path.join(dir, 'mechanisms.json'), 'utf8')).records); } catch { /* no mechanisms index: no mechanism lines */ }
  const mech = records.map((e) => ({ e, members: (e.members || []).map((m) => pos.get(`${slash(m.file)}@${m.name}`)).filter((p) => p != null) })).filter((u) => !sampled || u.members.length);
  const group = (kind) => unitsOf(fns, kind).map((u) => ({ ...u, positions: u.members.map((f) => pos.get(f.id)) }));
  const files = group('file');
  const classes = group('class');
  const holdersOf = (lists) => { const h = new Map(); lists.forEach((l, u) => { for (const p of l) { const id = fns[p].id; if (!h.has(id)) h.set(id, []); h.get(id).push(u); } }); return h; };
  const kinds = {
    function: { n: fns.length, holders: new Map(fns.map((f, i) => [f.id, [i]])), groups: null },
    mechanism: { n: mech.length, holders: holdersOf(mech.map((u) => u.members)), groups: mech.map((u) => u.members) },
    class: { n: classes.length, holders: holdersOf(classes.map((u) => u.positions)), groups: classes.map((u) => u.positions) },
    file: { n: files.length, holders: holdersOf(files.map((u) => u.positions)), groups: files.map((u) => u.positions) },
  };
  Object.assign(info, { mechanisms: mech.length, classes: classes.length, files: files.length });

  // The texts.
  const fnTexts = Object.fromEntries(o.arms.map((arm) => [arm, fns.map((f) => ({ key: f.id, text: functionText(f, arm, corpus).slice(0, 1500) }))]));
  const chunked = (units, chunksOf) => { const texts = []; const unit = []; units.forEach((u, i) => chunksOf(u).forEach((t, c) => { texts.push({ key: `${i}#${c}`, text: t.slice(0, 1500) }); unit.push(i); })); return { texts, unit }; };
  const own = {
    mechanism: chunked(mech, (u) => entryChunks(u.e, 'label+members', 8)),
    purpose: chunked(mech, (u) => [entryText(u.e, 'purpose').text]),
    class: chunked(classes, (u) => unitChunks(u.label, u.members, corpus)),
    file: chunked(files, (u) => unitChunks(u.label, u.members, corpus)),
  };
  info.texts = Object.values(fnTexts).reduce((a, t) => a + t.length, 0) + Object.values(own).reduce((a, t) => a + t.texts.length, 0);
  info.purposeLines = mech.filter((u) => String(u.e.purpose || '').trim()).length;
  if (o.dry) {
    console.log(`\n${name}: ${nf(corpus.n)} functions${sampled ? `, ${nf(fns.length)} sampled` : ''}; ${nf(mech.length)} mechanisms (${nf(info.purposeLines)} with a purpose line), ${nf(classes.length)} classes, ${nf(files.length)} files; ${nf(info.texts)} texts to embed`);
    const shown = fns.filter((f) => answerIds.has(f.id)).slice(0, 3);
    for (const arm of o.arms) for (const f of shown) console.log(`  [${arm}] ${functionText(f, arm, corpus).slice(0, 600)}`);
    if (files.length) console.log(`  [file] ${unitChunks(files[0].label, files[0].members, corpus)[0].slice(0, 400)}`);
    return { info };
  }

  const t0 = Date.now();
  const emb = async (texts, file) => { const m = await embedAll(embedder.ctx, texts, path.join(cacheDir, file), { prefix: embedder.doc, label: `${name} ${file.replace(/\.json$/, '')}` }); return texts.map((t) => m.get(t.key)); };
  const fnVecs = {};
  for (const arm of o.arms) fnVecs[arm] = await emb(fnTexts[arm], `fn-${arm}.json`);
  const ownVecs = {};
  for (const k of Object.keys(own)) ownVecs[k] = own[k].texts.length ? await emb(own[k].texts, `unit-${k}.json`) : [];
  info.embedSeconds = Math.round((Date.now() - t0) / 1000);

  const methods = [];
  for (const arm of o.arms) methods.push({ name: `function: ${arm}`, unit: 'function', units: kinds.function.n, holders: kinds.function.holders, scoreOf: (q, shared) => (shared[arm] = fnVecs[arm].map((v) => dot(q, v))) });
  const ownName = { mechanism: 'label and members (baseline)', purpose: 'purpose line', class: 'own vocabulary', file: 'own vocabulary' };
  for (const kind of ['mechanism', 'class', 'file']) {
    const K = kinds[kind];
    if (!K.n) continue;
    for (const k of (kind === 'mechanism' ? ['mechanism', 'purpose'] : [kind])) methods.push({ name: `${kind}: ${ownName[k]}`, unit: kind, units: K.n, holders: K.holders, scoreOf: bestChunkScorer(ownVecs[k], own[k].unit, K.n) });
    for (const arm of o.arms) methods.push({ name: `${kind}: best function, ${arm}`, unit: kind, units: K.n, holders: K.holders, scoreOf: (q, shared) => rollUp(shared[arm], K.groups) });
  }
  return { methods, info, fns };
}

// ---- the two test sets -------------------------------------------------------

function filingJobs(o) {
  const work = path.resolve(o.filings);
  const manifest = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
  const jobs = [];
  for (const f of filingsOf(manifest)) {
    if (o.only && !o.only.includes(f.id)) continue;
    const dir = path.join(work, 'indexes', f.dir);
    if (!fs.existsSync(path.join(dir, 'function_index.json')) || !fs.existsSync(path.join(dir, 'mechanisms.json'))) { process.stderr.write(`# ${f.id} ${f.repo}: no index or no mechanisms.json under ${dir}; skipped\n`); continue; }
    const fnsByFile = functionsByFile(JSON.parse(fs.readFileSync(path.join(dir, 'function_index.json'), 'utf8')));
    const byMember = recordsByMember(JSON.parse(fs.readFileSync(path.join(dir, 'mechanisms.json'), 'utf8')).records);
    const queries = [];
    for (const w of f.chartRows) {
      const text = String(w.limitation || '').trim();
      const answers = oneFunctionIds(scoreFiling(w.names, w.files.length ? w.files : f.files, fnsByFile, byMember));
      if (text.length > 15 && answers.length) queries.push({ id: `${f.id} ${w.label}`, texts: [text], answers });
    }
    if (queries.length) jobs.push({ name: f.dir, label: `${f.id} ${f.repo}`, dir, queries });
    else process.stderr.write(`# ${f.id} ${f.repo}: no chart row with limitation text and a cited function the index holds; left out
`);
  }
  return jobs;
}

function hofJobs(o) {
  const jobs = [];
  for (const d of o.hof) {
    const run = path.resolve(d);
    const report = JSON.parse(fs.readFileSync(path.join(run, 'hof_report.json'), 'utf8'));
    const claims = parseSidecar(JSON.parse(fs.readFileSync(path.join(run, 'claims.txt.anchors.json'), 'utf8')));
    const dir = path.resolve(o.index || report.indexPath);
    if (!fs.existsSync(path.join(dir, 'function_index.json'))) { process.stderr.write(`# ${d}: index ${dir} not found; skipped\n`); continue; }
    let other = null;
    if (o.claimsFile) {
      other = fs.readFileSync(path.resolve(o.claimsFile), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
      if (other.length !== claims.length) throw new Error(`--claims-file has ${other.length} claims, the run has ${claims.length}`);
    }
    jobs.push({ name: path.basename(dir).replace(/^\./, ''), label: `${path.basename(run)}${other ? ' (other wording)' : ''}`, dir, queries: null, claims: claims.map((c, i) => ({ ...c, claim: other ? other[i] : c.claim })) });
  }
  return jobs;
}

// ---- output -------------------------------------------------------------------

export function tallyLine(name, units, t, ks) {
  const pct = (n, d) => (d ? `${Math.round(100 * n / d)}%` : '-');
  const c = t.control;
  const z = t.chance;
  const r = t.real;
  return [name, nf(units), `${r.queries}`, `${r.answers}`, ...ks.map((k) => `${pct(r.hit[k], r.answers)} (${pct(c.hit[k], c.answers)}${z ? ` / ${pct(z.hit[k], z.answers)}` : ''})`), ...ks.map((k) => `${r.any[k]}`), ...ks.map((k) => `${r.all[k]}/${r.multi}`), r.ranks.length ? String(median(r.ranks)) : '-', `${r.notHeld}`];
}

export const headOf = (ks) => ['method', 'units', 'queries', 'functions', ...ks.map((k) => `within ${k} (other query / chance)`), ...ks.map((k) => `any @${k}`), ...ks.map((k) => `all @${k}`), 'median rank', 'in no unit'];

export function renderTable(title, rows, ks, md) {
  const head = headOf(ks);
  if (md) return [`**${title}**`, '', `| ${head.join(' | ')} |`, `|${head.map((_, i) => (i ? '---:' : '---')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join('  ');
  return [title, fmt(head), ...rows.map(fmt)].join('\n');
}

// ---- main -----------------------------------------------------------------------

async function main() {
  const o = parseOwnArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => /^ \*( |$)/.test(l)).map((l) => l.slice(3)).join('\n')); return; }
  const jobs = o.filings ? filingJobs(o) : hofJobs(o);
  if (!jobs.length) { console.error('function-text-reach: nothing to score'); process.exit(1); }
  let embedder = null;
  if (!o.dry) {
    const model = resolveEmbedModel(o.model);
    const e = await openEmbedder(model.path, { cpu: o.cpu });
    embedder = { ctx: e.ctx, dispose: e.dispose, query: model.query, doc: model.doc, name: model.name };
  }
  const pooled = {};
  const results = [];
  try {
    for (const job of jobs) {
      // The self-test's anchors need the corpus to resolve; a first, cheap pass gets the ids.
      if (job.claims) {
        const idx = await loadIndex(job.dir);
        const all = buildCorpus(idx.functionIndex || {}, () => null).fns;
        job.queries = job.claims.map((c) => ({ id: `claim ${c.n}`, texts: claimElements(c.claim), answers: [...new Set(c.anchors.flatMap((a) => anchorIds(all, a)))], unmapped: c.anchors.filter((a) => !anchorIds(all, a).length).length })).filter((q) => q.texts.length && q.answers.length);
      }
      const queries = o.limit ? job.queries.slice(0, o.limit) : job.queries;
      const answerIds = new Set(queries.flatMap((q) => q.answers));
      const prep = await prepare(job.dir, job.name, answerIds, o, embedder);
      if (o.dry) { console.log(`  ${job.label}: ${queries.length} queries, ${answerIds.size} answer functions`); continue; }
      const qTexts = queries.flatMap((q, i) => q.texts.map((t, j) => ({ key: `${i}#${j}`, text: t.slice(0, 1500) })));
      const qv = await embedAll(embedder.ctx, qTexts, null, { prefix: embedder.query, label: `${job.name} queries`, quiet: true });
      const scored = scoreIndex(prep.methods, queries.map((q, i) => ({ id: q.id, answers: q.answers, vecs: q.texts.map((_, j) => qv.get(`${i}#${j}`)) })), o.k);
      const rows = prep.methods.map((m) => tallyLine(m.name, m.units, scored[m.name], o.k));
      const note = `${nf(prep.info.functions)} functions${prep.info.sampled ? `, SAMPLED to ${nf(prep.info.pool)}` : ''}; ${queries.length} queries; embedded in ${prep.info.embedSeconds} s`;
      console.log(`\n${renderTable(`${job.label} (${note})`, rows, o.k, o.md)}`);
      for (const m of prep.methods) { pooled[m.name] = pooled[m.name] || { units: 0, real: null, control: null, chance: null }; pooled[m.name].units += m.units; pooled[m.name].real = mergeTally(pooled[m.name].real, scored[m.name].real, o.k); pooled[m.name].control = mergeTally(pooled[m.name].control, scored[m.name].control, o.k); pooled[m.name].chance = mergeTally(pooled[m.name].chance, scored[m.name].chance, o.k); }
      results.push({ job: job.label, index: job.name, info: prep.info, queries: queries.length, unmapped: queries.reduce((a, q) => a + (q.unmapped || 0), 0), methods: Object.fromEntries(prep.methods.map((m) => [m.name, { units: m.units, ...scored[m.name] }])) });
    }
  } finally { if (embedder) await embedder.dispose(); }
  if (o.dry) return;
  if (results.length > 1) console.log(`\n${renderTable(`pooled over ${results.length} indexes (units summed)`, Object.entries(pooled).map(([name, p]) => tallyLine(name, p.units, p, o.k)), o.k, o.md)}`);
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ generated: new Date().toISOString(), model: embedder.name, options: { ...o }, results, pooled }, null, 1));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(`function-text-reach: ${e.message}`); process.exit(1); });
}
