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
 *   --reword <arms>   with --filings (claim-rewording-blind-test, 2026-11-16): reword each
 *                     chart row's limitation with a model before embedding it, by the
 *                     prompts of src/commands/toward-code.js, and score each wording beside
 *                     the limitation as written. Arms: blind (the restate prompt, no
 *                     vocabulary), restate (the index's vocabulary), label (vocabulary and
 *                     sample entries), spec (restate with the patent's specification)
 *   --llm <provider>  the rewriting model for --reword (claude, chatgpt, ...)
 *   --reword-dir <d>  where rewrites are kept, one file per model, arm and job; a file
 *                     that is there is used and no model is called
 *                     (default %LOCALAPPDATA%\CodeExam\toward-code)
 *   --spec-dir <d>    the specifications for the spec arm, US<patent>.txt
 *   --wrong-map <f>   JSON { "<job index dir>": "<another job's index dir>" }: also reword
 *                     and rank each job's limitations on an index its chart does not
 *                     accuse (the restate and label arms; blind and as-written are ranked
 *                     there unchanged)
 *   --rollup          (rollup-by-directory-measurement, 2026-11-19) also roll the groups'
 *                     ranking (label and best function's text, the --semantic-search
 *                     ranking) up into units a reader could open: the directory and the
 *                     file each group mostly sits in. Per unit kind, four rules: how many
 *                     of the first 100 groups fall in the unit; that count over what the
 *                     unit's share of all groups would give; the mean of its three best
 *                     groups; its best group. And two "read by" lines per kind: the groups
 *                     in the order a reader meets them when units are opened in rank
 *                     order, ten groups each, to set beside the flat list at the same k.
 *                     Needs the comments arm. Not read with --reword
 *   --units <dir>     with --rollup: also the sections and sub-sections of a clustering,
 *                     from <dir>/<index dir name>.<variant>.units.json,
 *                     { variant, groups: [{ id, section, sub }] }, ids as mechanisms.json's.
 *                     A group a file does not name goes in one unit of its own
 *   --force           send past the cloud cost guard
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
import { ARMS, buildCorpus, functionText, unitChunks, unitsOf, rollUp, setReading, leafOf, FUSE_ARM, fuseSum, FUSE_LABEL_WEIGHT } from '../src/core/function-text.js';
import { resolveEmbedModel, entryChunks, entryText, embedAll, openEmbedder, median } from '../src/core/embed.js';
import { foldRecords } from '../src/core/mechanisms-index.js';
import { parseSidecar, baseName } from '../src/core/hof.js';
import { functionsByFile, recordsByMember, scoreFiling, filingsOf, oneFunctionIds } from './mechanism-containment.mjs';
import { claimElements, ranksOf, rrfFuse, RRF_K } from './describe-reach.mjs';
import { extractCommandCatalog } from '../src/core/breadcrumbs-commands.js';

const slash = (s) => String(s || '').replace(/\\/g, '/');
const nf = (x) => Number(x || 0).toLocaleString('en-US');

export const REWORD_ARMS = ['blind', 'restate', 'label', 'spec'];

export function parseOwnArgs(argv) {
  const o = { filings: null, only: null, hof: [], index: null, claimsFile: null, arms: [...ARMS], k: [1, 5, 25, 100], pool: 3500, limit: 0, model: 'nomic', cpu: false, cache: null, dry: false, json: null, md: false, reword: null, llm: null, rewordDir: null, specDir: null, wrongMap: null, force: false, rollup: false, units: null };
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
    else if (a === '--reword') { o.reword = list(); for (const x of o.reword) if (!REWORD_ARMS.includes(x)) throw new Error(`--reword takes ${REWORD_ARMS.join(', ')}; got "${x}"`); }
    else if (a === '--llm') o.llm = v();
    else if (a === '--reword-dir') o.rewordDir = v();
    else if (a === '--spec-dir') o.specDir = v();
    else if (a === '--wrong-map') o.wrongMap = v();
    else if (a === '--force') o.force = true;
    else if (a === '--rollup') o.rollup = true;
    else if (a === '--units') o.units = v();
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help && !o.filings && !o.hof.length) throw new Error('give --filings <work dir> or --hof <run dir>');
  if (o.claimsFile && o.hof.length !== 1) throw new Error('--claims-file goes with one --hof run');
  if (o.reword && !o.filings) throw new Error('--reword goes with --filings');
  if (o.reword && !o.llm) throw new Error('--reword needs --llm <provider>: the model that writes the rewordings, or whose saved ones are read');
  if (o.reword && o.reword.includes('spec') && !o.specDir) throw new Error('the spec arm needs --spec-dir <dir> holding US<patent>.txt');
  if (o.units && !o.rollup) throw new Error('--units gives the sections for --rollup to roll groups up into; without --rollup nothing reads it');
  if (o.rollup && o.reword) throw new Error('--rollup is not read with --reword: the roll-up lines are scored on the limitation as written');
  if (o.rollup && !o.arms.includes(FUSE_ARM)) throw new Error(`--rollup rolls up the ranking --semantic-search uses, which needs the ${FUSE_ARM} arm: add it to --arms`);
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

// ---- fusing two texts of one unit (mechanism-fused-text-reach, 2026-11-15) --------
// A mechanism has a label and its functions' texts; a file has its vocabulary and its
// functions' texts. Each alone was scored above. These read both for one unit. The arm of
// the function text and the weights were fixed before any run, and every one is reported:
// nothing here is searched for the best figure.
// FUSE_ARM and fuseSum live in src/core/function-text.js since --embed-distance --function-text uses them too.
export { FUSE_ARM, fuseSum };
export const FUSE_WEIGHTS = [0.3, 0.5, 0.7];   // the weight on the unit's own text
const fin = (x, other) => (Number.isFinite(x) ? x : other);
/** The higher of the two cosines per unit; a unit with only one text keeps that one. */
export function fuseMax(a, b) { return a.map((x, i) => Math.max(fin(x, -Infinity), fin(b[i], -Infinity))); }
/** Reciprocal-rank fusion of the two lists (the form scripts/describe-reach.mjs uses, k = RRF_K). */
export function fuseRanks(a, b) { return rrfFuse([a, b]); }
/** The fused methods for one kind of unit, given how to get its two score lists from the per-query scratch. */
export function fusedMethods(kind, K, ownKey, arm) {
  const two = (shared) => [shared[ownKey], rollUp(shared[arm], K.groups)];
  const mk = (name, f) => ({ name: `${kind}: fused, ${name}`, unit: kind, units: K.n, holders: K.holders, scoreOf: (q, shared) => { const [a, b] = two(shared); return f(a, b); } });
  return [
    mk(`reciprocal rank (k=${RRF_K})`, fuseRanks),
    mk('higher cosine', fuseMax),
    ...FUSE_WEIGHTS.map((w) => mk(`weighted sum, ${w} own text`, (a, b) => fuseSum(a, b, w))),
  ];
}

// ---- rolling a ranking of groups up into units (rollup-by-directory-measurement, 2026-11-19) ----
// A search lists groups; a reader could be shown where the closest ones are instead: a
// directory, a file, or a section of a clustering made with no directory names. Does the
// unit holding a cited function come within the first few? Four rules, fixed before any run
// and all reported. The ranking rolled up is the one --semantic-search uses: a group's label
// and its best function's text, FUSE_LABEL_WEIGHT on the label.
export const ROLLUP_RULES = ['count', 'count, size-corrected', 'best three', 'best one'];
/** `count` reads this many of the first groups: what a listing saying "9 of the first 100 are in …" would print. */
export const ROLLUP_TOP = 100;
/** The reading-order lines open this many groups of each unit before moving to the next. */
export const ROLLUP_OPEN = 10;
const ROLLUP_TIE = 1e-4;

/**
 * One score per unit from one score per group. `unitOf[g]` is group g's unit.
 *   count                  how many of the first `top` groups are in the unit
 *   count, size-corrected  that count over what the unit's share of all groups would give
 *   best three             the mean of the unit's three best groups (of what it has)
 *   best one               the unit's best group
 * The two counts break ties by the unit's best group, as a listing would; a unit with no
 * group ranks last under every rule.
 */
export function rollupScores(scores, unitOf, nUnits, rule, { top = ROLLUP_TOP } = {}) {
  if (!ROLLUP_RULES.includes(rule)) throw new Error(`roll-up rule is one of ${ROLLUP_RULES.join('; ')}; got "${rule}"`);
  const M = scores.length;
  const per = Array.from({ length: nUnits }, () => []);
  for (let g = 0; g < M; g++) per[unitOf[g]].push(fin(scores[g], -Infinity));
  for (const l of per) l.sort((a, b) => b - a);
  const best = per.map((l) => (l.length ? l[0] : -Infinity));
  if (rule === 'best one') return best;
  if (rule === 'best three') return per.map((l) => { const t = l.slice(0, 3).filter(Number.isFinite); return t.length ? t.reduce((s, x) => s + x, 0) / t.length : -Infinity; });
  const n = Math.min(top, M);
  const first = scores.map((s, g) => [fin(s, -Infinity), g]).sort((a, b) => b[0] - a[0] || a[1] - b[1]).slice(0, n);
  const count = new Array(nUnits).fill(0);
  for (const [, g] of first) count[unitOf[g]]++;
  const tie = (u) => (Number.isFinite(best[u]) ? ROLLUP_TIE * (1 + Math.max(-1, Math.min(1, best[u]))) / 2 : 0);
  return per.map((l, u) => {
    if (!l.length) return -1;
    return (rule === 'count' ? count[u] : count[u] / (n * l.length / M)) + tie(u);
  });
}

/**
 * The order a reader meets the groups in when the listing is by unit: the units by
 * `unitScores`, the first `open` groups of each by their own score, then every group not
 * yet met, by score. Returns one number per group, higher for earlier, so the usual rank
 * reading gives "the cited function's group within k lines read", the figure to set beside
 * the flat list's.
 */
export function readingOrder(scores, unitOf, unitScores, open = ROLLUP_OPEN) {
  const M = scores.length;
  const s = (g) => fin(scores[g], -Infinity);
  const byUnit = new Map();
  for (let g = 0; g < M; g++) { if (!byUnit.has(unitOf[g])) byUnit.set(unitOf[g], []); byUnit.get(unitOf[g]).push(g); }
  const units = [...byUnit.keys()].sort((a, b) => fin(unitScores[b], -Infinity) - fin(unitScores[a], -Infinity) || a - b);
  const order = [];
  const met = new Uint8Array(M);
  for (const u of units) for (const g of byUnit.get(u).sort((a, b) => s(b) - s(a) || a - b).slice(0, open)) { order.push(g); met[g] = 1; }
  const rest = [];
  for (let g = 0; g < M; g++) if (!met[g]) rest.push(g);
  rest.sort((a, b) => s(b) - s(a) || a - b);
  const pos = new Array(M);
  [...order, ...rest].forEach((g, i) => { pos[g] = M - i; });
  return pos;
}

/** The commonest value of a list, the first seen on a tie; null for an empty list. */
export function majorityOf(list) {
  const c = new Map();
  for (const x of list) c.set(x, (c.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [x, k] of c) if (k > n) { best = x; n = k; }
  return best;
}

/**
 * Units read from a file a clustering wrote: { variant, groups: [{ id, section, sub }] }.
 * `ids` are the index's group ids in the harness's order; `level` is `section` or `sub`.
 * A group the file does not name (the clustering leaves test groups out) goes in one unit
 * of its own kind, counted in `unnamed`. Returns { unitOf, n, unnamed }. Throws when the
 * file names none of the index's groups: it was made for another index.
 */
export function unitsFromFile(file, ids, level) {
  const by = new Map((file.groups || []).map((g) => [g.id, g[level]]));
  const index = new Map();
  let unnamed = 0;
  const raw = ids.map((id) => { if (!by.has(id)) { unnamed++; return null; } const v = by.get(id); if (!index.has(v)) index.set(v, index.size); return index.get(v); });
  if (unnamed === ids.length) throw new Error(`the units file names none of the index's ${ids.length} groups; it was made for another index or another mechanisms.json`);
  const n = index.size + (unnamed ? 1 : 0);
  return { unitOf: raw.map((u) => (u == null ? index.size : u)), n, unnamed };
}

/**
 * The command catalog's labels as texts: a CLI option's flags and help line, a GUI
 * control's label, each credited to the one function its handler resolves to in the pool.
 * Returns [{ text, fnId, kind }], empty when the index has no catalog row with a handler.
 */
export function catalogEntries(catalog, fns) {
  const byName = new Map();
  for (const f of fns) for (const n of new Set([f.name, leafOf(f.name)])) { if (!byName.has(n)) byName.set(n, []); byName.get(n).push(f); }
  const one = (name) => { const m = byName.get(name) || []; return m.length === 1 ? m[0] : null; };
  const out = [];
  for (const o of (catalog && catalog.cliOptions) || []) {
    const h = o.handler && o.handler.handlerFunc ? one(o.handler.handlerFunc) : null;
    if (!h) continue;
    out.push({ text: `${(o.flags || []).join(', ') || o.name}${o.help ? '  ' + o.help : ''}`.slice(0, 400), fnId: h.id, kind: 'cli' });
  }
  for (const a of (catalog && catalog.guiActions) || []) {
    const h = a.handler && a.handler.handlerFunc && a.label ? one(a.handler.handlerFunc) : null;
    if (!h) continue;
    out.push({ text: String(a.label).slice(0, 400), fnId: h.id, kind: 'gui' });
  }
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
  // The command catalog's labels, where the index has any with a resolved handler.
  let cat = [];
  try { const log = console.log; console.log = () => {}; try { cat = catalogEntries(extractCommandCatalog(idx, false), fns); } finally { console.log = log; } } catch { /* an index with no source lines has no catalog */ }
  info.catalog = { entries: cat.length, cli: cat.filter((e) => e.kind === 'cli').length, gui: cat.filter((e) => e.kind === 'gui').length };
  const catVecs = cat.length ? await emb(cat.map((e, i) => ({ key: String(i), text: e.text })), 'unit-catalog.json') : [];
  info.embedSeconds = Math.round((Date.now() - t0) / 1000);

  const methods = [];
  for (const arm of o.arms) methods.push({ name: `function: ${arm}`, unit: 'function', units: kinds.function.n, holders: kinds.function.holders, scoreOf: (q, shared) => (shared[arm] = fnVecs[arm].map((v) => dot(q, v))) });
  const ownName = { mechanism: 'label and members (baseline)', purpose: 'purpose line', class: 'own vocabulary', file: 'own vocabulary' };
  for (const kind of ['mechanism', 'class', 'file']) {
    const K = kinds[kind];
    if (!K.n) continue;
    for (const k of (kind === 'mechanism' ? ['mechanism', 'purpose'] : [kind])) { const score = bestChunkScorer(ownVecs[k], own[k].unit, K.n); methods.push({ name: `${kind}: ${ownName[k]}`, unit: kind, units: K.n, holders: K.holders, scoreOf: (q, shared) => (shared[`own:${k}`] = score(q)) }); }
    for (const arm of o.arms) methods.push({ name: `${kind}: best function, ${arm}`, unit: kind, units: K.n, holders: K.holders, scoreOf: (q, shared) => rollUp(shared[arm], K.groups) });
    // The unit's own text fused with its best function's text (mechanisms and files; a class has too few rows to read).
    if (kind !== 'class' && o.arms.includes(FUSE_ARM)) methods.push(...fusedMethods(kind, K, `own:${kind}`, FUSE_ARM));
  }
  // The catalog's labels: scored alone, each entry credited to its handler function; and as a
  // third text for the mechanism that holds that handler (the higher of the three cosines).
  if (cat.length) {
    const holders = new Map();
    cat.forEach((e, i) => { if (!holders.has(e.fnId)) holders.set(e.fnId, []); holders.get(e.fnId).push(i); });
    methods.push({ name: 'catalog: flag and help, or control label', unit: 'catalog', units: cat.length, holders, scoreOf: (q, shared) => (shared.catalog = catVecs.map((v) => dot(q, v))) });
    const M = kinds.mechanism;
    if (M.n && o.arms.includes(FUSE_ARM)) {
      const entryMechs = cat.map((e) => M.holders.get(e.fnId) || []);
      methods.push({ name: 'mechanism: fused, higher cosine, with catalog label', unit: 'mechanism', units: M.n, holders: M.holders, scoreOf: (q, shared) => {
        const s = fuseMax(shared['own:mechanism'], rollUp(shared[FUSE_ARM], M.groups));
        shared.catalog.forEach((c, i) => { for (const u of entryMechs[i]) if (c > s[u]) s[u] = c; });
        return s;
      } });
    }
  }
  // --rollup: the groups' ranking rolled up into units (see rollupScores). Directory and file
  // are each group's commonest among its members' files; a section and a sub-section come from
  // the files under --units, one per clustering variant.
  if (o.rollup && kinds.mechanism.n && o.arms.includes(FUSE_ARM)) {
    const M = kinds.mechanism;
    const fused = (shared) => (shared.rollupBase = shared.rollupBase || fuseSum(shared['own:mechanism'], rollUp(shared[FUSE_ARM], M.groups), FUSE_LABEL_WEIGHT));
    const dirOf = (f) => { const p = slash(f).split('/'); p.pop(); return p.join('/') || '.'; };
    const byValue = (values) => { const ix = new Map(); const unitOf = values.map((v) => { if (!ix.has(v)) ix.set(v, ix.size); return ix.get(v); }); return { unitOf, n: ix.size, unnamed: 0 }; };
    const unitKinds = [
      ['directory', byValue(mech.map((u) => majorityOf((u.e.members || []).map((m) => dirOf(m.file)))))],
      ['file of groups', byValue(mech.map((u) => majorityOf((u.e.members || []).map((m) => slash(m.file)))))],
    ];
    if (o.units) {
      const files = fs.existsSync(o.units) ? fs.readdirSync(o.units).filter((f) => f.startsWith(`${name}.`) && f.endsWith('.units.json')).sort() : [];
      for (const f of files) {
        const j = JSON.parse(fs.readFileSync(path.join(o.units, f), 'utf8'));
        const ids = mech.map((u) => u.e.id);
        unitKinds.push([`section ${j.variant}`, unitsFromFile(j, ids, 'section')], [`sub-section ${j.variant}`, unitsFromFile(j, ids, 'sub')]);
      }
      if (!files.length) process.stderr.write(`# ${name}: no <index>.<variant>.units.json under ${o.units}; directory and file only\n`);
    }
    info.rollup = {};
    for (const [kind, U] of unitKinds) {
      const sizes = new Array(U.n).fill(0); for (const u of U.unitOf) sizes[u]++;
      info.rollup[kind] = { units: U.n, largest: Math.max(...sizes), unnamed: U.unnamed };
      const holders = new Map();
      for (const [id, ms] of M.holders) holders.set(id, [...new Set(ms.map((m) => U.unitOf[m]))]);
      for (const rule of ROLLUP_RULES) methods.push({ name: `${kind}: groups rolled up, ${rule}`, unit: kind, units: U.n, holders, scoreOf: (q, shared) => (shared[`ru:${kind}:${rule}`] = rollupScores(fused(shared), U.unitOf, U.n, rule)) });
      for (const rule of ['count', 'best three']) methods.push({ name: `mechanism: read by ${kind} (${rule}), first ${ROLLUP_OPEN} of each`, unit: 'mechanism', units: M.n, holders: M.holders, scoreOf: (q, shared) => readingOrder(fused(shared), U.unitOf, shared[`ru:${kind}:${rule}`], ROLLUP_OPEN) });
    }
  }
  return { methods, info, fns, mechLabels: mech.map((u) => u.e.label) };
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
    // The whole claim as the chart gives it: every row's limitation text, in order.
    const claim = f.chartRows.map((w) => String(w.limitation || '').trim()).filter(Boolean).join('\n');
    const patent = ((manifest.candidates || []).find((c) => c.id === f.id) || {}).patent || null;
    for (const w of f.chartRows) {
      const text = String(w.limitation || '').trim();
      const answers = oneFunctionIds(scoreFiling(w.names, w.files.length ? w.files : f.files, fnsByFile, byMember));
      if (text.length > 15 && answers.length) queries.push({ id: `${f.id} ${w.label}`, texts: [text], answers });
    }
    if (queries.length) jobs.push({ name: f.dir, label: `${f.id} ${f.repo}`, dir, queries, claim, patent, filing: f.id });
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

// ---- rewording the limitations (claim-rewording-blind-test, 2026-11-16) -----------
// --embed-distance --toward-code rewords a claim element toward a codebase's names before
// embedding it. On the two claims it was first run on it moved a suspected class from the
// hundreds to the tens and showed three ways of failing: every element of a claim made to
// sound alike, the first rows filled by entries sharing a common word, and every element
// looking matched. This scores the rewording on the chart rows, where a party's cited
// functions are the answers, with the prompts as committed and four arms fixed before any
// run. Beside reach it reports what needs no answer key: how alike a chart's limitations
// are once reworded (sameness), and how much of the first five rows the same few entries
// take (crowding); and it ranks each claim on an index its chart does not accuse.

const safeName = (s) => String(s).replace(/[^A-Za-z0-9._@-]+/g, '_');

/** Where one job's rewordings under one model and arm are kept. */
export function rewordFile(dir, modelId, arm, jobKey) {
  return path.join(dir, safeName(modelId), arm, `${safeName(jobKey)}.json`);
}

/** The sum of cosines over every pair of (unit) vectors and the number of pairs: a chart's limitations against each other. */
export function sameness(vecs) {
  let sum = 0, pairs = 0;
  for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) { sum += dot(vecs[i], vecs[j]); pairs++; }
  return { sum, pairs };
}

/** The `n` highest-scoring units of one query, its best score and the median score. */
export function topUnits(scores, n = 5) {
  const idx = [];
  for (let i = 0; i < scores.length; i++) if (Number.isFinite(scores[i])) idx.push(i);
  idx.sort((a, b) => scores[b] - scores[a]);
  return { top: idx.slice(0, n), best: idx.length ? scores[idx[0]] : null, median: idx.length ? median(idx.map((i) => scores[i])) : null };
}

/**
 * Crowding over one index's queries: of the slots in their first-n lists, how many are taken
 * by a unit that is in the list of half or more of the queries (and of at least two).
 * One query has nothing to crowd. Returns { slots, crowded, units }.
 */
export function crowding(topLists) {
  const n = topLists.length;
  if (n < 2) return { slots: 0, crowded: 0, units: [] };
  const need = Math.max(2, Math.ceil(n / 2));
  const count = new Map();
  for (const l of topLists) for (const u of new Set(l)) count.set(u, (count.get(u) || 0) + 1);
  const hubs = new Set([...count].filter(([, c]) => c >= need).map(([u]) => u));
  let slots = 0, crowded = 0;
  for (const l of topLists) for (const u of l) { slots++; if (hubs.has(u)) crowded++; }
  return { slots, crowded, units: [...hubs] };
}

/** What an arm gives the rewriting model: the form of src/commands/toward-code.js, and whether the vocabulary and the specification go in. */
export const REWORD_ARM_SPEC = {
  blind: { form: 'restate', vocabulary: false, spec: false },
  restate: { form: 'restate', vocabulary: true, spec: false },
  label: { form: 'label', vocabulary: true, spec: false },
  spec: { form: 'restate', vocabulary: true, spec: true },
};

const LABEL_METHOD = 'mechanism: label and members (baseline)';
const FUSED_METHOD = 'mechanism: fused, weighted sum, 0.3 own text';

/**
 * Make, or read back, every rewording a run needs. Returns get(arm, job, wrongName|null) ->
 * rows of rewriteElements. One file per model, arm and job under o.rewordDir; a file whose
 * elements are the job's limitations is used as it is and no model is called for it.
 */
async function makeRewordings(o, jobs, wrong, allJobs) {
  const tc = await import('../src/commands/toward-code.js');
  const { cachedVocabularyWords } = await import('../src/core/vocabulary.js');
  const { vocabConcordanceOptions } = await import('../src/commands/claim.js');
  const runner = await import('../src/core/llm-runner.js');
  const model = runner.resolveModel({ llm: o.llm });
  if (!model) throw new Error(`--llm ${o.llm}: no such provider`);
  if (model.kind === 'error') throw new Error(model.error);
  const dir = path.resolve(o.rewordDir || path.join(process.env.LOCALAPPDATA || '.', 'CodeExam', 'toward-code'));
  const vopt = { ...vocabConcordanceOptions({ args: { no_claim_filter: true }, localModelPath: null }).options, maxFuncNames: 0 };
  const ctx = new Map();
  const ctxOf = (indexDir) => {
    if (!ctx.has(indexDir)) {
      const words = cachedVocabularyWords(indexDir, vopt).words;
      const samples = tc.sampleEntryTexts(foldRecords(JSON.parse(fs.readFileSync(path.join(indexDir, 'mechanisms.json'), 'utf8')).records));
      ctx.set(indexDir, { words, samples });
    }
    return ctx.get(indexDir);
  };
  const byName = new Map(allJobs.map((j) => [j.name, j]));
  const store = new Map();
  const pending = [];
  for (const arm of o.reword) {
    const A = REWORD_ARM_SPEC[arm];
    for (const job of jobs) {
      const elements = job.queries.map((q) => q.texts[0]);
      const targets = [{ indexDir: job.dir, tag: null }];
      // The wrong-codebase control: the arms that are told an index's words, told another index's.
      if (wrong && wrong[job.name] && A.vocabulary && !A.spec) {
        const w = byName.get(wrong[job.name]);
        if (!w) throw new Error(`--wrong-map names ${wrong[job.name]} for ${job.name}, which is not one of the jobs`);
        targets.push({ indexDir: w.dir, tag: w.name });
      }
      for (const t of targets) {
        const key = `${arm}|${job.filing}|${job.name}|${t.tag || ''}`;
        const file = rewordFile(dir, model.model, arm, `${job.filing}__${job.name}${t.tag ? `@${t.tag}` : ''}`);
        if (fs.existsSync(file)) {
          const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (JSON.stringify(saved.elements) === JSON.stringify(elements)) { store.set(key, saved.rows); continue; }
        }
        const c = A.vocabulary || A.form === 'label' ? ctxOf(t.indexDir) : { words: [], samples: [] };
        let spec = null, specFile = null;
        if (A.spec) {
          specFile = path.join(path.resolve(o.specDir), `US${job.patent}.txt`);
          if (!fs.existsSync(specFile)) throw new Error(`the spec arm needs ${specFile} (job ${job.label})`);
          spec = fs.readFileSync(specFile, 'utf8').trim();
        }
        pending.push({ key, file, arm, job, elements, form: A.form, vocabulary: A.vocabulary ? c.words : [], samples: A.form === 'label' ? c.samples : [], spec, specFile, index: t.indexDir });
      }
    }
  }
  if (pending.length) {
    const calls = pending.flatMap((p) => p.elements.map((e) => ({ inChars: tc.buildTowardCodePrompt(p.form).length + tc.buildTowardCodeUser({ element: e, claim: p.job.claim, vocabulary: p.vocabulary, samples: p.samples, spec: p.spec, form: p.form }).length, outTokens: 80 })));
    process.stderr.write(`# rewording: ${calls.length} model calls over ${pending.length} job-arms (${runner.describeEngine(model)}); ${store.size} job-arms read from ${dir}\n`);
    if (!runner.claimsCostGate(model, calls, `reword (${calls.length} calls)`, { force: o.force })) throw new Error('stopped at the cost guard; --force sends anyway');
    runner.resetCloudUsage();
    const draft = runner.makeDrafter(model, 0);
    for (const p of pending) {
      const rows = await tc.rewriteElements({ draft, elements: p.elements, claim: p.job.claim, vocabulary: p.vocabulary, samples: p.samples, spec: p.spec, form: p.form });
      const failed = rows.filter((r) => r.error).length;
      process.stderr.write(`# reworded ${p.arm} ${p.job.label}${p.index !== p.job.dir ? ` with the words of ${path.basename(p.index)}` : ''}: ${rows.length} limitation(s)${failed ? `, ${failed} NOT reworded (${rows.find((r) => r.error).error})` : ''}\n`);
      fs.mkdirSync(path.dirname(p.file), { recursive: true });
      fs.writeFileSync(p.file, JSON.stringify({ generated: new Date().toISOString(), engine: runner.describeEngine(model), arm: p.arm, form: p.form, job: p.job.label, index: path.basename(p.index), vocabularyCount: p.vocabulary.length, sampleCount: p.samples.length, specFile: p.specFile, elements: p.elements, rows }, null, 1));
      store.set(p.key, rows);
    }
    const cost = runner.actualCostLine(model);
    if (cost) process.stderr.write(`${cost}\n`);
  } else process.stderr.write(`# rewording: every job-arm read from ${dir}; no model call\n`);
  return { get: (arm, job, tag = null) => store.get(`${arm}|${job.filing}|${job.name}|${tag || ''}`), engine: runner.describeEngine(model), modelId: model.model, dir };
}

const emptyExtra = () => ({ same: { sum: 0, pairs: 0 }, crowd: { slots: 0, crowded: 0 }, margins: [], wrongMargins: [], wrongCrowd: { slots: 0, crowded: 0 }, notReworded: 0 });

/** The --reword run: every wording of every job's limitations, scored on the mechanism entries by label and by label with function text. */
async function rewordMain(o, jobs, allJobs = jobs) {
  const wrong = o.wrongMap ? JSON.parse(fs.readFileSync(path.resolve(o.wrongMap), 'utf8')) : null;
  const rw = await makeRewordings(o, jobs, wrong, allJobs);
  const model = resolveEmbedModel(o.model);
  const e = await openEmbedder(model.path, { cpu: o.cpu });
  const embedder = { ctx: e.ctx, dispose: e.dispose, query: model.query, doc: model.doc, name: model.name };
  const wordings = ['written', ...o.reword];
  const pooled = Object.fromEntries(wordings.map((w) => [w, { [LABEL_METHOD]: null, [FUSED_METHOD]: null, units: 0, ...emptyExtra() }]));
  const perJob = [];
  const want = new Set([`function: ${FUSE_ARM}`, LABEL_METHOD, FUSED_METHOD]);
  const preps = new Map();
  const prepFor = async (job, answerIds) => {
    if (!preps.has(job.name)) { const p = await prepare(job.dir, job.name, answerIds, { ...o, arms: [FUSE_ARM] }, embedder); p.methods = p.methods.filter((m) => want.has(m.name)); preps.set(job.name, p); }
    return preps.get(job.name);
  };
  const embedTexts = async (texts) => { const m = await embedAll(embedder.ctx, texts.map((t, i) => ({ key: String(i), text: String(t).slice(0, 1500) })), null, { prefix: embedder.query, quiet: true }); return texts.map((_, i) => m.get(String(i))); };
  const byName = new Map(allJobs.map((j) => [j.name, j]));
  try {
    // Every accused index first, so an index sampled for its own answers is the one reused as another job's wrong index.
    for (const job of jobs) await prepFor(job, new Set(job.queries.flatMap((q) => q.answers)));
    for (const job of jobs) {
      const prep = preps.get(job.name);
      const labelMethod = prep.methods.find((m) => m.name === LABEL_METHOD);
      const wjob = wrong && wrong[job.name] ? byName.get(wrong[job.name]) : null;
      const wprep = wjob ? await prepFor(wjob, new Set(wjob.queries.flatMap((q) => q.answers))) : null;
      const wlabel = wprep ? wprep.methods.find((m) => m.name === LABEL_METHOD) : null;
      const rec = { job: job.label, index: job.name, queries: job.queries.length, entries: labelMethod ? labelMethod.units : 0, wrongIndex: wjob ? wjob.name : null, wrongEntries: wlabel ? wlabel.units : 0, wordings: {} };
      for (const w of wordings) {
        const rows = w === 'written' ? null : rw.get(w, job);
        const texts = rows ? rows.map((r) => r.rewritten) : job.queries.map((q) => q.texts[0]);
        const vecs = await embedTexts(texts);
        const scored = scoreIndex(prep.methods, job.queries.map((q, i) => ({ id: q.id, answers: q.answers, vecs: [vecs[i]] })), o.k);
        const P = pooled[w];
        for (const name of [LABEL_METHOD, FUSED_METHOD]) {
          if (!scored[name]) continue;
          P[name] = P[name] || { real: null, control: null, chance: null };
          for (const part of ['real', 'control', 'chance']) P[name][part] = mergeTally(P[name][part], scored[name][part], o.k);
        }
        const out = { notReworded: rows ? rows.filter((r) => r.error).length : 0 };
        P.notReworded += out.notReworded;
        const same = sameness(vecs);
        P.same.sum += same.sum; P.same.pairs += same.pairs;
        out.sameness = same.pairs ? same.sum / same.pairs : null;
        if (labelMethod) {
          const tops = vecs.map((v) => topUnits(labelMethod.scoreOf(v, {})));
          const c = crowding(tops.map((t) => t.top));
          P.crowd.slots += c.slots; P.crowd.crowded += c.crowded;
          const margins = tops.filter((t) => t.best != null).map((t) => t.best - t.median);
          P.margins.push(...margins);
          Object.assign(out, { crowding: c.slots ? c.crowded / c.slots : null, crowdedBy: c.units.map((u) => prep.mechLabels[u]), margins, first: tops.map((t) => (t.top.length ? prep.mechLabels[t.top[0]] : null)) });
        }
        // The wrong codebase: the same limitations, worded for it where the arm is told an index's words, ranked on it.
        if (wlabel && w !== 'spec') {
          const wrows = w === 'restate' || w === 'label' ? rw.get(w, job, wjob.name) : rows;
          const wtexts = wrows ? wrows.map((r) => r.rewritten) : job.queries.map((q) => q.texts[0]);
          const wvecs = wrows === rows ? vecs : await embedTexts(wtexts);
          const tops = wvecs.map((v) => topUnits(wlabel.scoreOf(v, {})));
          const c = crowding(tops.map((t) => t.top));
          P.wrongCrowd.slots += c.slots; P.wrongCrowd.crowded += c.crowded;
          const margins = tops.filter((t) => t.best != null).map((t) => t.best - t.median);
          P.wrongMargins.push(...margins);
          Object.assign(out, { wrongMargins: margins, wrongCrowding: c.slots ? c.crowded / c.slots : null, wrongFirst: tops.map((t) => (t.top.length ? wprep.mechLabels[t.top[0]] : null)) });
        }
        out.label = scored[LABEL_METHOD] || null;
        out.fused = scored[FUSED_METHOD] || null;
        rec.wordings[w] = out;
      }
      perJob.push(rec);
      process.stderr.write(`# scored ${job.label}\n`);
    }
  } finally { await embedder.dispose(); }

  const pct = (n, d) => (d ? `${Math.round(100 * n / d)}%` : '-');
  const reach = (t) => o.k.map((k) => (t ? `${pct(t.real.hit[k], t.real.answers)} (${pct(t.control.hit[k], t.control.answers)})` : '-'));
  const med = (a) => (a.length ? median(a).toFixed(3) : '-');
  const head = ['wording', ...o.k.map((k) => `label ≤${k} (other limitation)`), ...o.k.map((k) => `with function text ≤${k} (other)`), 'sameness', 'crowding', 'margin', 'wrong index: margin', 'wrong index: crowding', 'not reworded'];
  const rows = wordings.map((w) => { const P = pooled[w]; return [w, ...reach(P[LABEL_METHOD]), ...reach(P[FUSED_METHOD]), P.same.pairs ? (P.same.sum / P.same.pairs).toFixed(3) : '-', pct(P.crowd.crowded, P.crowd.slots), med(P.margins), med(P.wrongMargins), pct(P.wrongCrowd.crowded, P.wrongCrowd.slots), String(P.notReworded)]; });
  const functions = pooled.written[LABEL_METHOD] ? pooled.written[LABEL_METHOD].real.answers : 0;
  const title = `${jobs.length} jobs, ${jobs.reduce((a, j) => a + j.queries.length, 0)} chart rows, ${functions} cited functions in a mechanism entry; embedding ${embedder.name}; reworded by ${rw.engine}`;
  if (o.md) console.log([`**${title}**`, '', `| ${head.join(' | ')} |`, `|${head.map((_, i) => (i ? '---:' : '---')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n'));
  else { const wd = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length))); const fmt = (r) => r.map((c, i) => (i ? String(c).padStart(wd[i]) : String(c).padEnd(wd[i]))).join('  '); console.log([title, fmt(head), ...rows.map(fmt)].join('\n')); }
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ generated: new Date().toISOString(), embedModel: embedder.name, rewriter: rw.engine, rewordDir: rw.dir, options: { ...o }, pooled, perJob }, null, 1));
}

// ---- main -----------------------------------------------------------------------

async function main() {
  const o = parseOwnArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => /^ \*( |$)/.test(l)).map((l) => l.slice(3)).join('\n')); return; }
  const jobs = o.filings ? filingJobs(o) : hofJobs(o);
  if (!jobs.length) { console.error('function-text-reach: nothing to score'); process.exit(1); }
  if (o.reword) return rewordMain(o, jobs, o.only ? filingJobs({ ...o, only: null }) : jobs);
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
