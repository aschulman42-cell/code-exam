// carve.js — --carve clusters|calls: an index's mechanisms under numbered sections and sub-sections, by the likeness of their text or by the calls between them
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// carve-command-clusters-and-calls (2026-11-23). The listing a reader can run an eye down:
//
//   ce --index-path <index> --carve clusters [--sections N] [--sub N] [--embed-model <name>]
//   ce --index-path <index> --carve calls    [--resolution X] [--seed N]
//        [--description] [--purpose] [--brief] [--include-tests]
//
// The computing is in src/core/carve.js; this file reads the index, the mechanisms file and,
// for clusters, the vectors --build-embeddings saved. It loads no model and makes no network
// call. `calls` reads no embedding at all. `clusters` saves its tree beside the embedding
// files (<index>/embeddings/<model>_carve-tree.json), because a first run took 260 seconds on
// ExoPlayer 3's 7,495 mechanisms and a later one, reading the tree back, 44; the file is
// keyed to the vectors it was built from, so a rebuild of the index or the embeddings
// replaces it. The technique is experimental and the header of every listing says so
// (docs/CODEEXAM_CLUSTERING.md).
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readCache, embedAll, sha } from '../core/embed.js';
import { FUSE_ARM } from '../core/function-text.js';
import { loadMechanismsIndex, foldRecords } from '../core/mechanisms-index.js';
import { embedCacheFile, entryEmbedPlan, loadFunctionPlan } from './embed-distance.js';
import { chooseSearchModel, isTestEntry } from './semantic-search.js';
import { CARVE_HOWS, CALLS_RESOLUTION, CALLS_SUB_RESOLUTION, CALLS_SEED, CALLS_MIN_SUB, CLUSTERS_MAX, PURPOSE_MAX, mechanismVectors, carveClusters, carveCalls, callEdges, carveListing, carveUsage } from '../core/carve.js';

const nf = (n) => Number(n).toLocaleString('en-US');
export const CARVE_TREE_FORMAT = 'ce-carve-tree';
/** Where `clusters` keeps its tree for a model. */
export const carveTreeFile = (indexPath, modelBase) => embedCacheFile(indexPath, modelBase, 'carve-tree');

/** The vectors of `texts` ({ key, text }) the cache at `file` already holds under `prefix`; nothing is embedded and nothing written. */
export async function cachedVectors(file, texts, prefix = '') {
  const cache = readCache(file);
  const have = texts.filter(({ key, text }) => { const hit = cache.items[key]; return hit && hit.h === sha(prefix + text); });
  const none = { getEmbeddingFor: async () => { throw new Error('a vector expected in the cache was not there'); } };
  return embedAll(none, have, file, { prefix, quiet: true });
}

/** A key for a set of mechanism vectors: the tree saved under it is theirs and no others'. */
export function vectorsKey(vectors) {
  const h = crypto.createHash('sha256');
  let n = 0;
  for (const v of vectors) if (v) { h.update(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); n++; }
  return `${n}:${h.digest('hex').slice(0, 24)}`;
}

/** The numbers --carve takes, checked: { sections, sub, resolution, seed } or { problem }. */
export function carveNumbers(args) {
  const out = {};
  const whole = (name, opt, min) => { if (args[name] == null) return null; const n = Number(args[name]); if (!Number.isInteger(n) || n < min) return `${opt} takes a whole number, ${min} or more (got ${args[name]})`; out[name] = n; return null; };
  const problem = whole('sections', '--sections', 1) || whole('sub', '--sub', 1) || whole('seed', '--seed', 0);
  if (problem) return { problem };
  if (args.resolution != null) { const x = Number(args.resolution); if (!(x > 0) || !Number.isFinite(x)) return { problem: `--resolution takes a number above 0 (got ${args.resolution})` }; out.resolution = x; }
  return out;
}

/** Options given that do nothing under `how`, each as a line for the header (named, not dropped silently). */
export function carveUnusedNotes(args, how) {
  const given = (k) => !!(args._explicit && args._explicit.has(k));
  const notes = [];
  const say = (opts, one, many, why) => { if (opts.length) notes.push(`Not used: ${opts.join(', ')} ${opts.length === 1 ? one : many} ${why}`); };
  if (how === 'clusters') say([given('resolution') && '--resolution', given('seed') && '--seed'].filter(Boolean), 'belongs', 'belong', 'to --carve calls; clusters has no seed, the same index gives the same listing.');
  if (how === 'calls') say([given('sections') && '--sections', given('sub') && '--sub', given('embed_model') && '--embed-model'].filter(Boolean), 'belongs', 'belong', 'to --carve clusters; calls reads no embeddings, and --resolution sets how many sections it makes.');
  say([given('filter') && '--filter', given('sort_by') && '--sort-by', given('max_results') && '--max-results'].filter(Boolean), 'does not apply', 'do not apply', 'to --carve: every mechanism is listed, in sections; search the output for a name.');
  return notes;
}

const testsLine = (tests, includeTests) => (includeTests ? 'Test mechanisms are included (--include-tests).' : `Left out: ${nf(tests)} mechanism${tests === 1 ? '' : 's'} that ${tests === 1 ? 'is' : 'are'} wholly test code (--include-tests keeps them).`);
const textLines = (rows, { description, purpose }) => {
  const out = [];
  if (description) { const have = rows.filter((r) => r.description).length; out.push(have ? `Descriptions: shown under ${nf(have)} of the ${nf(rows.length)} mechanisms; a language model wrote them (--describe) and they are not checked.` : 'Descriptions: none in this index. A language model writes them when asked (--mechanisms --describe; see --help describe). --purpose shows the text harvested with no model.'); }
  if (purpose) out.push(`Purpose: shown under ${nf(rows.filter((r) => r.purpose).length)} of the ${nf(rows.length)} mechanisms, on lines starting "purpose:". It was harvested from comments, strings and call names with no model, is often noisy, and is cut at ${PURPOSE_MAX} characters.`);
  return out;
};

/**
 * The `calls` listing as text, from the kept mechanisms and the function corpus: no index
 * and no file is read here, so a test can call it. `entries` are mechanism entries (id,
 * label, description, purpose); `fnIds[i]` the function ids of entry i; `fnById` the corpus.
 */
export function renderCalls({ ndx, entries, fnIds, fnById, tests = 0, includeTests = false, numbers = {}, notes = [], brief = false, description = false, purpose = false }) {
  const resolution = numbers.resolution ?? CALLS_RESOLUTION, seed = numbers.seed ?? CALLS_SEED;
  const edges = callEdges(fnIds, fnById);
  const { sections, subsOf, touched } = carveCalls(entries.length, edges, { resolution, seed });
  const body = carveListing(entries, sections, subsOf, { brief, description, purpose, loneTitle: 'Standing alone (no call that could be matched, or in no community)' });
  const n = entries.length;
  return [
    `${ndx}: ${nf(n)} mechanisms carved by CALLS (experimental: the groups are a suggestion and not a finding; they move when the index or the seed changes)`,
    'How: mechanisms that call each other go together. Louvain community detection on the calls between their functions, matched by name. No embedding is read and no model is used.',
    `Settings: resolution ${resolution} (--resolution X; higher gives more, smaller sections); sub-sections at resolution ${CALLS_SUB_RESOLUTION} inside sections of ${CALLS_MIN_SUB} or more; seed ${seed} (--seed N gives another run; the same seed gives the same listing).`,
    `${testsLine(tests, includeTests)} ${nf(n - touched.size)} of the ${nf(n)} make or receive no call that could be matched; they are listed at the end.`,
    `Result: ${nf(body.sections)} sections of 2 or more, the largest ${nf(body.largest)}; ${nf(body.alone)} mechanisms standing alone. Each row ends with its section number.`,
    ...textLines(entries, { description, purpose }), ...notes, '', ...body.lines,
  ].join('\n');
}

/**
 * The `clusters` listing as text, from the kept mechanisms and one vector each (null where
 * the mechanism has no embedded text). `merges` is a saved tree for exactly these vectors,
 * or null to build one. Returns { text, merges }.
 */
export function renderClusters({ ndx, entries, vectors, modelBase, tests = 0, includeTests = false, numbers = {}, notes = [], behind = 0, merges = null, onProgress = null, brief = false, description = false, purpose = false }) {
  const c = carveClusters(vectors, { sections: numbers.sections ?? null, sub: numbers.sub ?? null, merges, onProgress });
  const placedSet = new Set(c.placed), unplaced = entries.map((_, i) => i).filter((i) => !placedSet.has(i));
  const body = carveListing(entries, c.sections, c.subsOf, { brief, description, purpose, unplaced, unplacedTitle: 'Not placed: no embedded text' });
  const n = entries.length;
  const text = [
    `${ndx}: ${nf(n)} mechanisms carved by CLUSTERS (experimental: the groups are a suggestion and not a finding; they move when the index or its embeddings change)`,
    `How: mechanisms whose text is alike go together. Ward's method on one vector per mechanism, made from its functions' saved text embeddings (model ${modelBase}), a function weighted by its lines and by how few mechanisms hold it. No model is run.`,
    `Settings: ${nf(c.top)} sections, ${nf(c.sub)} sub-sections (--sections N, --sub N). The same index and embeddings always give the same listing.`,
    `${testsLine(tests, includeTests)} ${nf(unplaced.length)} of the ${nf(n)} have no embedded text and are listed at the end, not placed.${behind ? ` ${nf(behind)} function texts are not embedded (the index changed since --build-embeddings); their mechanisms are placed by the rest.` : ''}`,
    `Result: ${nf(body.sections)} sections of 2 or more, the largest ${nf(body.largest)}; ${nf(body.alone)} mechanisms in a section of their own. Each row ends with its section number.`,
    ...textLines(entries, { description, purpose }), ...notes, '', ...body.lines,
  ].join('\n');
  return { text, merges: c.merges };
}

/** `--carve`: read the index and print the listing. Sets process.exitCode on a refusal. */
export async function doCarve(args, { exe = process.env.CODEEXAM_INVOKED_AS || 'ce' } = {}) {
  const ndx = args.index_path;
  const how = typeof args.carve === 'string' ? args.carve.trim().toLowerCase() : null;
  if (!how) { console.log(carveUsage(exe, ndx || '<index>').join('\n')); return; }
  if (!CARVE_HOWS.includes(how)) { console.error(`--carve takes clusters or calls, not "${args.carve}".\n${carveUsage(exe, ndx || '<index>').slice(1).join('\n')}`); process.exitCode = 2; return; }
  const numbers = carveNumbers(args);
  if (numbers.problem) { console.error(`--carve: ${numbers.problem}`); process.exitCode = 2; return; }
  let data = null;
  try { data = loadMechanismsIndex({ indexPath: ndx }, { cache: false }); } catch { data = null; }
  if (!data || !data.records || !data.records.length) { console.error(`${ndx} has no mechanisms.json, the groups of functions --carve arranges. Build it (no model needed), then run this again:\n  ${exe} --index-path ${ndx} --build-mechanisms`); process.exitCode = 2; return; }
  const all = foldRecords(data.records);
  const includeTests = !!args.include_tests;
  const keptAt = []; let tests = 0;
  all.forEach((e, i) => { if (!includeTests && isTestEntry(e)) tests++; else keptAt.push(i); });
  const entries = keptAt.map((i) => all[i]);
  const notes = carveUnusedNotes(args, how);
  const shown = { brief: !!args.brief, description: !!args.description, purpose: !!args.purpose };
  const t0 = Date.now();

  let model = null;
  if (how === 'clusters') {
    const chosen = chooseSearchModel(ndx, args.embed_model || null);
    if (chosen.problem) { console.error(`--carve clusters: ${chosen.problem.replace(/run the search again/g, 'run this again').replace(/ce --ndx /g, `${exe} --index-path `)}\n--carve calls needs no embeddings.`); process.exitCode = 2; return; }
    model = chosen.model;
    if (entries.length > CLUSTERS_MAX) { console.error(`--carve clusters: ${ndx} has ${nf(entries.length)} mechanisms, and Ward's method keeps a table of every pair: above ${nf(CLUSTERS_MAX)} that is more memory than this command will take. --carve calls has no such limit.`); process.exitCode = 2; return; }
  }

  process.stderr.write('# reading the index…\n');
  const { plan: fnPlan, corpus } = await loadFunctionPlan(ndx, all);
  const fnById = new Map(corpus.fns.map((f) => [f.id, f]));
  const fnIds = keptAt.map((i) => fnPlan.ids[i]);

  if (how === 'calls') {
    console.log(renderCalls({ ndx, entries, fnIds, fnById, tests, includeTests, numbers, notes, ...shown }));
    process.stderr.write(`# ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
    return;
  }

  const plan = entryEmbedPlan(all);
  const labelVecsAll = await cachedVectors(embedCacheFile(ndx, model.base, 'label+members'), plan.whole, model.doc);
  const fnVecs = await cachedVectors(embedCacheFile(ndx, model.base, `function-text-${FUSE_ARM}`), fnPlan.texts, model.doc);
  const any = fnVecs.values().next().value || labelVecsAll.values().next().value;
  if (!any) { console.error(`--carve clusters: the ${model.name} embeddings of ${ndx} hold none of this index's texts (the index or its mechanisms changed since they were built). Build them, then run this again:\n  ${exe} --index-path ${ndx} --build-embeddings\n--carve calls needs no embeddings.`); process.exitCode = 2; return; }
  // a function's weight: its lines over the number of mechanisms (of all, tests too) holding it
  const holders = new Map(); fnPlan.ids.forEach((l) => { for (const id of new Set(l)) holders.set(id, (holders.get(id) || 0) + 1); });
  const weightOf = (id) => { const f = fnById.get(id) || {}; return Math.max(1, (f.end || f.start || 1) - (f.start || 1) + 1) / (holders.get(id) || 1); };
  const vectors = mechanismVectors({ fnIds, fnVecs, weightOf, labelVecs: keptAt.map((i) => labelVecsAll.get(`${all[i].id}:${i}`) || null), dim: any.length });
  const behind = fnPlan.texts.length - fnVecs.size;

  const treeFile = carveTreeFile(ndx, model.base), key = vectorsKey(vectors);
  let merges = null;
  try { const t = JSON.parse(fs.readFileSync(treeFile, 'utf8')); if (t && t.format === CARVE_TREE_FORMAT && t.key === key) merges = t.merges; } catch { merges = null; }
  const fresh = !merges;
  if (fresh && entries.length > 1500) process.stderr.write(`# building the tree for ${nf(entries.length)} mechanisms (minutes on a large index; saved to ${treeFile} so the next run reads it)…\n`);
  const r = renderClusters({ ndx, entries, vectors, modelBase: model.base, tests, includeTests, numbers, notes, behind, merges, ...shown,
    onProgress: (done, total) => process.stderr.write(`#   distances: ${nf(done)} of ${nf(total)} mechanisms\n`) });
  if (fresh && r.merges.length) {
    try { fs.mkdirSync(path.dirname(treeFile), { recursive: true }); fs.writeFileSync(treeFile, JSON.stringify({ format: CARVE_TREE_FORMAT, version: 1, generated: new Date().toISOString(), model: model.base, key, merges: r.merges })); }
    catch (e) { process.stderr.write(`# the tree could not be saved (${e.message}); the next run builds it again\n`); }
  }
  console.log(r.text);
  process.stderr.write(`# ${((Date.now() - t0) / 1000).toFixed(1)} s${fresh ? '' : ' (tree read from the index)'}\n`);
}
