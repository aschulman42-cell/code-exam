// semantic-search.js — --semantic-search: search an index for text by meaning, under a local embedding model; --build-embeddings: build what it searches
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// semantic-search-cli (2026-11-17). The ranking of --embed-distance --function-text, worded
// and defaulted as a search: one argument, the model chosen from what the index already has,
// results as places in the code, hits and near hits, and for a text of several elements a
// list per element and a view across them. --embed-distance stays the instrument (cosines,
// --against, the calibrated band); nothing here changes its numbers.
//
//   ce --ndx <index> --build-embeddings [--embed-model <name>]     once per index and model
//   ce --ndx <index> --semantic-search "<text>"                    one text
//   ce --ndx <index> --semantic-search @claim.txt                  every element of a claim
//        [--elements @list.txt] [--embed-model <name>] [--filter <s>] [--max-results N]
//        [--include-tests] [--cpu] [--verbose]
//        [--toward-code restate|label|@saved [--spec <file>]]   a model rewords each text toward the
//                            index's names first, and the search is by the rewording (toward-code.js)
//
// What is ranked, and why it is shown the way it is (scratch runs of 2026-11-17, in the item's
// draft): the index's mechanism entries, each by its label and member names and by its best
// member function's text together, the form docs/CODEEXAM_MECHANISMS_TESTS.md measured. A row
// that is a 30-function command group hides which function matched, so a row here is the
// FUNCTION that scored, with its file and lines; entries whose best function is the same one
// are one row that names the groups holding it. Ranking single functions on their own was
// tried and is not used: it was the best form on CodeExam's index and the worst on ExoPlayer 3,
// where getters and setters matched single words of a claim.
//
// A search builds nothing. No embeddings, or embeddings that have fallen behind the index by
// more than TOP_UP_MAX texts, is a message naming --build-embeddings.
import fs from 'node:fs';
import path from 'node:path';
import { resolveEmbedModel, openEmbedder, embedAll, missingInCache, median, cosine, EMBED_MODELS, DEFAULT_EMBED_MODEL } from '../core/embed.js';
import { loadMechanismsIndex, foldRecords } from '../core/mechanisms-index.js';
import { FUSE_ARM, FUSE_LABEL_WEIGHT } from '../core/function-text.js';
import { effectiveCount } from '../argparse.js';
import { resolveQueries, embedCacheFile, entryEmbedPlan, entryCandidates, loadFunctionPlan, rankFused, CHUNK, mechanismQueryId, entryIndexById, meanVector, mechanismQueryBlock } from './embed-distance.js';
import { isTestSymbol } from './claim-locate.js';

const nf = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many = `${one}s`) => `${nf(n)} ${n === 1 ? one : many}`;

/** The model --build-embeddings uses when none is named, and the one a search prefers, when its file is installed. */
export const PREFERRED_EMBED_MODEL = 'gemma';
/** A search embeds up to this many texts the cache lacks (an index touched since the build); more is a message to rebuild. */
export const TOP_UP_MAX = 200;
/** A hit scores within this share of the way down from the best score to the typical one; a near hit within NEAR_SHARE. */
export const HIT_SHARE = 0.15;
export const NEAR_SHARE = 0.35;
/** Rows shown per tier unless --max-results says otherwise. */
export const TIER_ROWS = 10;
/** The first this-many rows of a text's results carry the next-best functions of their group. */
export const NEXT_FOR_ROWS = 100;
/** The view across elements counts a place found within this many rows of an element's list. */
export const ACROSS_DEPTH = 25;

const KINDS = () => ['label+members', `label+members_chunks${CHUNK}`, `function-text-${FUSE_ARM}`];

/** The model file names (without .gguf) an index has a complete set of embedding files for. */
export function builtModelBases(indexPath) {
  const dir = path.join(indexPath, 'embeddings');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const need = ['label+members', `function-text-${FUSE_ARM}`];
  const bases = new Set();
  for (const n of names) { const m = n.match(/^(.*)_label\+members\.json$/); if (m) bases.add(m[1]); }
  return [...bases].filter((b) => need.every((k) => names.includes(`${b}_${k}.json`)));
}

/**
 * Which model a search uses. `wanted` (--embed-model) wins. Otherwise the index's own:
 * gemma when the index has gemma embeddings and the model file is installed, else the first
 * registry model, nomic first, of which both are true. Returns { model, note } or
 * { problem } (a message for the user, naming the command that fixes it).
 */
export function chooseSearchModel(indexPath, wanted = null, { modelsDir, ndx = indexPath } = {}) {
  const opts = modelsDir ? { modelsDir } : {};
  const built = builtModelBases(indexPath);
  const build = (name) => `ce --ndx ${ndx} --build-embeddings${name ? ` --embed-model ${name}` : ''}`;
  if (wanted) {
    let model;
    try { model = resolveEmbedModel(wanted, opts); } catch (e) { return { problem: e.message }; }
    if (!built.includes(model.base)) return { problem: `${ndx} has no ${model.name} embeddings yet. Build them, then run the search again:\n  ${build(wanted)}` };
    return { model, note: `using the ${model.name} embeddings built for this index` };
  }
  // one name per model file: gemma and gemma-search are one file with two query prompts
  const order = [PREFERRED_EMBED_MODEL, DEFAULT_EMBED_MODEL, ...Object.keys(EMBED_MODELS)].filter((n) => !EMBED_MODELS[n].unsupported).filter((n, i, a) => a.findIndex((m) => EMBED_MODELS[m].file === EMBED_MODELS[n].file) === i);
  const missingFile = [];
  for (const name of order) {
    const base = EMBED_MODELS[name].file.replace(/\.gguf$/i, '');
    if (!built.includes(base)) continue;
    let model;
    try { model = resolveEmbedModel(name, opts); } catch { missingFile.push(name); continue; }
    const note = name === PREFERRED_EMBED_MODEL
      ? `using the ${name} embeddings already built for this index`
      : `using the ${name} embeddings built for this index (it has none for ${PREFERRED_EMBED_MODEL}; ${build(PREFERRED_EMBED_MODEL)} builds them)`;
    return { model, note: `${note}; --embed-model <name> chooses another` };
  }
  if (missingFile.length) return { problem: `${ndx} has embeddings for ${missingFile.join(', ')}, and that model's file is not installed here (--embed-model list shows what is). Install it, or build embeddings for a model that is:\n  ${build(null)}` };
  return { problem: `${ndx} has no embeddings yet. Build them (once per index), then run the search again:\n  ${build(null)}` };
}

/** The model a build uses: the one named, else gemma when installed, else the shipped default. */
export function chooseBuildModel(wanted = null, { modelsDir } = {}) {
  const opts = modelsDir ? { modelsDir } : {};
  if (wanted) return resolveEmbedModel(wanted, opts);
  try { return resolveEmbedModel(PREFERRED_EMBED_MODEL, opts); } catch { return resolveEmbedModel(DEFAULT_EMBED_MODEL, opts); }
}

const leafOf = (name) => String(name || '').split(/::|[.]/).pop();
/** A path as a reader wants it: no archive prefix, forward slashes. */
export function sourcePath(file) { return String(file || '').split('!').pop().split('\\').join('/'); }
/** The path cut to its last `keep` segments, led by an ellipsis when cut. */
export function shortPath(file, keep = 3) { const parts = sourcePath(file).split('/'); return parts.length > keep ? `…/${parts.slice(-keep).join('/')}` : parts.join('/'); }

/**
 * The header's words on test code: groups made only of tests, and test functions inside the
 * groups that were kept. Empty when there is nothing to say.
 */
export function testLeftOutNote(testGroups, testFnsInKept, includeTests) {
  if (includeTests) return '; test code included';
  const parts = [];
  if (testGroups) parts.push(`${plural(testGroups, 'group')} of test code`);
  if (testFnsInKept) parts.push(`${plural(testFnsInKept, 'test function')} inside the groups ranked`);
  return parts.length ? `; ${parts.join(' and ')} left out (--include-tests brings them in)` : '';
}

/** True when every member of the entry is test, mock, benchmark or example code (the --claim-locate gate's rule). */
export function isTestEntry(e) {
  const ms = e.members || [];
  return ms.length > 0 && ms.every((m) => isTestSymbol({ name: m.name, filepath: m.file, test: m.test === true }));
}

/**
 * Ranked entries (rankFused's rows) as search rows. An entry's row is the function that
 * scored; entries with the same scoring function (the same file and leaf name, so a method
 * the index holds both as Class::method and as method is one) are one row, ranked where the
 * first of them ranked, listing every group that holds it, smallest first. An entry with no
 * function text is its own row. `fnOf(id)` gives { file, name, start, end } for a function id.
 */
export function searchRows(ranked, fnOf) {
  const rows = [];
  const byKey = new Map();
  for (const x of ranked) {
    const f = x.fn ? fnOf(x.fn) : null;
    const key = f ? `${f.file}@${leafOf(f.name)}` : `entry:${x.entry.id}`;
    let row = byKey.get(key);
    if (!row) {
      row = { key, score: x.cos, labelCos: x.labelCos, fnCos: x.fnCos, fn: f, fnId: x.fn || null, fnIds: [], groups: [], entryRank: x.rank, next: [] };
      byKey.set(key, row);
      rows.push(row);
    }
    row.groups.push(x.entry);
    for (const id of x.fnIds || []) if (!row.fnIds.includes(id)) row.fnIds.push(id);
  }
  rows.forEach((r, i) => { r.rank = i + 1; r.groups.sort((a, b) => (a.members || []).length - (b.members || []).length); });
  return rows;
}

/**
 * The next-best functions of a row's groups, for the line under it. A group was ranked by
 * its best function, and the function a reader is after may be its second: on ExoPlayer 3 the
 * group holding shouldStartPlayback showed another start function. `scoreOf(id)` is a
 * function's cosine to the text; a method the index holds twice counts once; at most `n` are
 * returned, as { fn, cos }, best first.
 */
export function nextFunctions(row, scoreOf, fnOf, n = 2) {
  if (!row.fn) return [];
  const seen = new Set([leafOf(row.fn.name)]);
  const scored = row.fnIds.filter((id) => id !== row.fnId).map((id) => ({ id, cos: scoreOf(id) })).filter((x) => x.cos != null).sort((a, b) => b.cos - a.cos);
  const out = [];
  for (const { id, cos } of scored) {
    const f = fnOf(id);
    if (!f) continue;
    const leaf = leafOf(f.name);
    if (seen.has(leaf)) continue;
    seen.add(leaf);
    out.push({ fn: f, cos });
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Hits and near hits. `typical` is the median entry score, what an unrelated piece of code
 * scores for this text. A hit is within HIT_SHARE of the way from the best row down to
 * typical; a near hit within NEAR_SHARE. The tiers are relative to this index and this
 * text: they say which code is closest, not that the code does what the text says. No
 * absolute line is drawn, because none separated found from not-found when it was looked
 * for (the band's history in embed-distance.js; the wrong-codebase runs of 2026-11-16).
 */
export function searchTiers(rows, typical) {
  if (!rows.length) return { hits: [], near: [], best: 0, spread: 0 };
  const best = rows[0].score;
  const spread = Math.max(0, best - typical);
  const hitLine = best - HIT_SHARE * spread, nearLine = best - NEAR_SHARE * spread;
  return { hits: rows.filter((r) => r.score >= hitLine), near: rows.filter((r) => r.score < hitLine && r.score >= nearLine), best, spread };
}

/** Keep the rows whose function, path or groups contain `s` (case-insensitive); ranks stay. */
export function filterRows(rows, s) {
  const f = String(s).toLowerCase();
  return rows.filter((r) => (r.fn && (`${r.fn.name} ${sourcePath(r.fn.file)}`).toLowerCase().includes(f)) || r.groups.some((g) => String(g.label).toLowerCase().includes(f)));
}

/** One result, two or three lines: the place, the groups holding it, the smallest group's description. */
/** A group as a result names it: its mechanism record id (`m70`), then its label (embed-distance-rows-show-mechanism-id, 2026-11-21: labels repeat, the id does not, and it is what --mechanisms and --toc print). */
export const groupName = (g) => `${g && g.id ? `${g.id} ` : ''}${g.label}`;

export function formatSearchRow(r, { verbose = false, width = 3 } = {}) {
  const home = r.groups[0];
  const fnCount = (g) => `${nf((g.members || []).length)} fn`;
  const head = r.fn
    ? `${r.fn.name}   ${verbose ? sourcePath(r.fn.file) : shortPath(r.fn.file)}:${r.fn.start}-${r.fn.end}`
    : `${groupName(home)}   (a group of ${plural((home.members || []).length, 'function')}; no single function scored)`;
  const L = [`${String(r.rank).padStart(width)}. ${r.score.toFixed(3)}  ${head}`];
  const pad = ' '.repeat(width + 9);
  if (r.fn) {
    const others = r.groups.slice(1);
    const shown = verbose ? others : others.slice(0, 3);
    L.push(`${pad}in ${groupName(home)} (${fnCount(home)})${others.length ? `; also in ${shown.map(groupName).join(', ')}${others.length > shown.length ? `, +${others.length - shown.length} more` : ''}` : ''}`);
  }
  if (r.fn && r.next && r.next.length) L.push(`${pad}next best in ${r.groups.length > 1 ? "these groups" : "this group"}: ${r.next.map((x) => `${leafOf(x.fn.name)} (lines ${x.fn.start}-${x.fn.end}${x.fn.file !== r.fn.file ? ` of ${sourcePath(x.fn.file).split('/').pop()}` : ''})`).join(', ')}`);
  const d = String(home.description || '').replace(/\s+/g, ' ').trim();
  if (d) L.push(`${pad}${!verbose && d.length > 170 ? d.slice(0, 169) + '…' : d}`);
  if (verbose && r.labelCos != null) L.push(`${pad}score parts: group name ${r.labelCos.toFixed(4)}, function text ${r.fnCos == null ? 'none' : r.fnCos.toFixed(4)}; the group ranked ${nf(r.entryRank)} among groups`);
  return L.join('\n');
}

/** One text's results as lines: the text, typical and best, then HITS and NEAR HITS. */
export function renderSearch({ query, heading = null, rows, typical, top = TIER_ROWS, filter = null, verbose = false, searchedAs = null, notReworded = null }) {
  // --toward-code: the heading says the text is as written, and the line under it, in capitals,
  // is what was searched for and that the results are for it (2026-11-17: "searched as:" in
  // lower case under a long element was easy to read past).
  const reworded = searchedAs != null;
  const L = [`${heading ? `${heading}${reworded ? ', as written' : ''}: ` : reworded ? 'AS WRITTEN: ' : ''}${query}`];
  if (reworded) L.push(notReworded
    ? `  SEARCHED AS WRITTEN: the model did not reword this text (${notReworded}); the results below are for the text above`
    : `  SEARCHED AS (a model's rewording; the results below are for this, not for the text above): ${searchedAs}`);
  const { hits, near, best } = searchTiers(rows, typical);
  if (!rows.length) { L.push('  nothing to rank'); return L; }
  L.push(`  typical score ${typical.toFixed(3)}, best ${best.toFixed(3)}; ${plural(hits.length, 'hit')}, ${plural(near.length, 'near hit')}`);
  const width = Math.max(3, String(rows.length).length);
  const cap = Number.isFinite(top) ? top : Infinity;
  const tier = (title, list) => {
    const shown = filter ? filterRows(list, filter) : list;
    if (!list.length) return;
    L.push('', `  ${title}${filter ? ` matching --filter "${filter}": ${shown.length} of ${list.length}` : ''}`);
    for (const r of shown.slice(0, cap)) L.push(formatSearchRow(r, { verbose, width }));
    if (shown.length > cap) L.push(`${' '.repeat(width + 9)}… ${nf(shown.length - cap)} more (--max-results N, or 0 for all)`);
  };
  tier('HITS', hits);
  tier('NEAR HITS', near);
  if (hits.length > Math.max(cap, TIER_ROWS)) L.push('', `  ${nf(hits.length)} places score about as high as the best one: nothing stands out for this text.`);
  if (filter) {
    const rest = filterRows(rows, filter).filter((r) => !hits.includes(r) && !near.includes(r));
    if (rest.length) { L.push('', `  BELOW THE NEAR HITS, matching --filter "${filter}": ${rest.length}`); for (const r of rest.slice(0, cap)) L.push(formatSearchRow(r, { verbose, width })); }
    else if (!filterRows(rows, filter).length) L.push('', `  nothing matches --filter "${filter}"`);
  }
  return L;
}

/**
 * The view across a text's elements: the places within ACROSS_DEPTH rows for the most
 * elements, best first, each with a mark per element it was found for. `perElement` is the
 * rows of each element in order.
 */
export function acrossElements(perElement, depth = ACROSS_DEPTH) {
  const m = new Map();
  perElement.forEach((rows, qi) => rows.slice(0, depth).forEach((r) => {
    const a = m.get(r.key) || { row: r, els: [], sum: 0 };
    a.els.push(qi + 1); a.sum += r.score; m.set(r.key, a);
  }));
  return [...m.values()].sort((a, b) => b.els.length - a.els.length || b.sum / b.els.length - a.sum / a.els.length);
}

/**
 * How deep the view across elements looks, for an index of `rows` results: ACROSS_DEPTH, but
 * never more than a fifth of what there is, and at least 3. On the 29-group demo the first
 * 25 results were nearly all of them, and seven places were "found" for 11 of 11 elements.
 */
export function acrossDepth(rows) {
  return Math.max(3, Math.min(ACROSS_DEPTH, Math.floor(rows / 5)));
}

export function renderAcross(perElement, { top = 15, verbose = false, depth = ACROSS_DEPTH } = {}) {
  const n = perElement.length;
  const all = acrossElements(perElement, depth);
  const several = all.filter((a) => a.els.length > 1);
  const L = [`ACROSS THE ${n} ELEMENTS: the places within the first ${depth} results for the most elements`];
  if (!several.length) { L.push('  no place is within the first results for more than one element'); return L; }
  const w = String(n).length;
  L.push(`       elements ${Array.from({ length: n }, (_, i) => String(i + 1).padStart(w)).join(' ')}`);
  several.slice(0, top).forEach((a, i) => {
    const r = a.row;
    const place = r.fn ? `${r.fn.name}   ${verbose ? sourcePath(r.fn.file) : shortPath(r.fn.file)}:${r.fn.start}-${r.fn.end}` : groupName(r.groups[0]);
    L.push(`${String(i + 1).padStart(3)}. ${String(a.els.length).padStart(2)} of ${n}  ${Array.from({ length: n }, (_, qi) => (a.els.includes(qi + 1) ? '#' : '.').padStart(w)).join(' ')}   ${place}`);
  });
  if (several.length > top) L.push(`     … ${nf(several.length - top)} more places found for two or more elements`);
  return L;
}

/**
 * Notes for options given with a search that do nothing there, so none is dropped silently
 * (2026-11-17: a run with --function-text and one with an unknown --toward-code form printed
 * the same listing as a run without, and said nothing).
 */
export function unusedOptionNotes(args) {
  const L = [];
  if (args.function_text) L.push('note: --function-text changes nothing here: a search already ranks each group by its best function\'s text.');
  if (args.against != null) L.push('note: --against was ignored: it gives --embed-distance a text or a list to measure to, and a search ranks the index.');
  if (args.no_prefix) L.push('note: --no-prefix was ignored: the embeddings a search reads were built with the model\'s prefixes (--embed-distance takes it).');
  return L;
}

/** True when the text reads like a patent claim: several elements, or a claim's turns of phrase. */
export function readsLikeClaim(queries, multi) {
  return multi || /\b(comprising|wherein|configured to|being equipped with|a method for|a system (?:for|including)|the method of claim)\b/i.test(queries.join(' '));
}

/** The closing lines: the model-based steps that might help, each with its command; under --air-gapped, the local-model form only. */
export function closingTips({ ndx, raw, described, entriesN, claimLike, airGapped = false, plateau = 0, elementsN = 1, reworded = false }) {
  const engine = airGapped ? '--model <gguf>' : '--llm <provider>  (or --model <gguf> for a local model)';
  const L = [];
  if (!described) L.push(`This index has no descriptions. A model can write one sentence per group, shown under each result here (${nf(entriesN)} groups, one call each):`, `  ce --ndx ${ndx} --describe ${engine}`);
  else if (described < entriesN) L.push(`${nf(entriesN - described)} of this index's ${nf(entriesN)} groups have no description; --describe ${engine} writes them.`);
  // The rewording is offered when the text reads like a claim or when nothing stood out for it,
  // and not when this run already searched by a rewording.
  if ((claimLike || plateau) && !reworded) {
    const arg = String(raw).trim().startsWith('@') ? String(raw).trim() : '"<text>"';
    const why = plateau
      ? (elementsN > 1 ? `Nothing stood out for ${plateau} of the ${elementsN} elements.` : 'Nothing stood out for this text.')
      : 'This text reads like a patent claim, and a claim\'s wording is often far from the code\'s.';
    L.push(`${why} A model can reword ${elementsN > 1 ? 'each element' : 'the text'} toward this codebase's names before the search (--toward-code label, or restate). That has brought the right code nearer on public codebases and is untested on code a model has not seen:`, `  ce --ndx ${ndx} --semantic-search ${arg} --toward-code label ${engine}`);
  }
  return L.length ? ['Steps that use a language model and might help:', ...L.map((l) => (l.startsWith('  ') ? `  ${l}` : `- ${l}`))] : [];
}

const loadEntries = (indexPath) => {
  const data = loadMechanismsIndex({ indexPath }, { cache: false });
  return data && data.records.length ? foldRecords(data.records) : null;
};

export async function doSemanticSearch(args) {
  const raw = args.semantic_search;
  const ndx = args.index_path;
  let queries, source;
  try { ({ queries, source } = resolveQueries(raw, args.elements)); } catch (e) { console.error(`--semantic-search: ${e.message}`); process.exitCode = 2; return; }
  if (!queries.length) { console.error(source ? `--semantic-search: ${source}` : '--semantic-search takes the text to search for, or @<file> to search for every element of a claim'); process.exitCode = 2; return; }
  const multi = source != null;
  const all = loadEntries(ndx);
  if (!all) { console.error(`${ndx} has no mechanisms.json, the groups of functions a semantic search ranks. Build it (no model needed), then the embeddings, then search:\n  ce --ndx ${ndx} --build-mechanisms\n  ce --ndx ${ndx} --build-embeddings`); process.exitCode = 2; return; }
  // id:m70 (embed-distance-rows-show-mechanism-id, 2026-11-21): search from a mechanism of
  // the index, by its saved vectors, and not from a text. The same ranking with the query's
  // two vectors replaced: the mechanism's label vector, and the mean of its functions'.
  const fromId = mechanismQueryId(raw);
  const fromAt = fromId ? entryIndexById(all, fromId) : -1;
  let fromData = null;
  if (fromId) {
    try { fromData = loadMechanismsIndex({ indexPath: ndx }, { cache: false }); } catch { fromData = null; }
    if (fromAt < 0) { console.error(`--semantic-search: ${ndx} has no mechanism ${fromId}. Its mechanisms file, built ${String((fromData && fromData.generated) || '').slice(0, 10) || 'at an unknown date'}, holds ${nf(all.length)} entries; --mechanisms <filter> and --toc <filter> show each row's id.`); process.exitCode = 2; return; }
    if (args.toward_code != null) { console.error(`--toward-code has a model reword a text toward the index's names, and id:${fromId} is a mechanism of the index, not a text: give one or the other`); process.exitCode = 2; return; }
  }
  const chosen = chooseSearchModel(ndx, args.embed_model || null);
  if (chosen.problem) { console.error(`--semantic-search: ${chosen.problem}`); process.exitCode = 2; return; }
  const { model } = chosen;

  process.stderr.write('# reading the index…\n');
  const plan = entryEmbedPlan(all);
  const { plan: fnPlan, corpus } = await loadFunctionPlan(ndx, all);
  const files = KINDS().map((k) => embedCacheFile(ndx, model.base, k));
  const missing = missingInCache(files[0], plan.whole, model.doc) + (plan.extra.length ? missingInCache(files[1], plan.extra, model.doc) : 0) + missingInCache(files[2], fnPlan.texts, model.doc);
  const total = plan.whole.length + plan.extra.length + fnPlan.texts.length;
  if (missing > TOP_UP_MAX) {
    console.error(`--semantic-search: the ${model.name} embeddings of ${ndx} are behind the index: ${nf(missing)} of ${nf(total)} texts are not embedded (the index or its mechanisms changed since they were built). Bring them up to date, then run the search again:\n  ce --ndx ${ndx} --build-embeddings${args.embed_model ? ` --embed-model ${args.embed_model}` : model.name === PREFERRED_EMBED_MODEL ? '' : ` --embed-model ${model.name}`}`);
    process.exitCode = 2; return;
  }

  // --toward-code (2026-11-17, Andrew's request the day the command was built): the texts are
  // reworded toward the index's names by a model, exactly as --embed-distance --toward-code does
  // it, and searched by the rewording. Done after the embeddings check, so a search that is
  // going to stop for a missing build spends nothing first, and before the embedding model loads.
  const toward = args.toward_code != null;
  if (args.spec != null && !toward) { console.error('--spec gives the patent\'s specification to the model that --toward-code restate|label asks for rewrites; without --toward-code nothing reads it'); process.exitCode = 2; return; }
  let reworded = null;
  if (toward) {
    const { towardCode } = await import('./toward-code.js');
    const spec0 = String(raw || '').trim();
    const r = await towardCode(args, { queries, claimFile: spec0.startsWith('@') ? spec0.slice(1) : null, entries: all, indexPath: ndx });
    if (!r || r.shown) return;
    reworded = r;
  }
  const searched = reworded ? reworded.rows.map((r) => r.rewritten) : queries;

  const includeTests = !!args.include_tests;
  const fnById = new Map(corpus.fns.map((f) => [f.id, f]));
  // A function is a test by its name or path, by the attribute above it (the corpus marks
  // that from the source), or because the mechanisms index marked the member.
  const markedTest = new Set();
  for (const e of all) for (const m of e.members || []) if (m.test === true) markedTest.add(`${String(m.file).replace(/\\/g, '/')}@${m.name}`);
  const isTestFn = (id) => { const f = fnById.get(id); return !!f && isTestSymbol({ name: f.name, filepath: f.file, test: f.test === true || markedTest.has(id) }); };
  const top = effectiveCount(args, args.max_results, TIER_ROWS);
  const filter = args.filter ? String(args.filter) : null;

  process.stderr.write(`# loading ${model.base}${args.cpu ? ' (cpu)' : ''}…\n`);
  let embedder;
  try { embedder = await openEmbedder(model.path, { cpu: !!args.cpu }); } catch (e) { console.error(`\n--semantic-search: ${e.message}`); process.exitCode = 1; return; }
  const perElement = [];
  try {
    // A few texts new since the build (at most TOP_UP_MAX) are embedded here. `notice` says so on
    // stderr before the wait, not only on the header line after it; nothing when none is missing.
    const whole = await embedAll(embedder.ctx, plan.whole, files[0], { prefix: model.doc, quiet: true, notice: 'group names new since the build' });
    const more = plan.extra.length ? await embedAll(embedder.ctx, plan.extra, files[1], { prefix: model.doc, quiet: true, notice: 'group name chunks new since the build' }) : new Map();
    const fnVecs = await embedAll(embedder.ctx, fnPlan.texts, files[2], { prefix: model.doc, quiet: true, compact: true, notice: 'function texts new since the build' });
    let cands = entryCandidates(all, plan, whole, more);
    const fromEntry = fromId ? all[fromAt] : null;
    const fromLabel = fromId ? whole.get(`${fromEntry.id}:${fromAt}`) : null;
    const fromFn = fromId ? meanVector(fnPlan.ids[fromAt], fnVecs) : null;
    // Test functions inside groups that are otherwise the project's own code (a Rust source
    // file with its tests under #[test]): left out function by function, and counted, so the
    // header does not report five groups while a quarter of a codebase's functions went.
    const testFnsInKept = new Set();
    cands.forEach((c, i) => {
      if (!isTestEntry(c.entry)) for (const id of fnPlan.ids[i]) if (isTestFn(id)) testFnsInKept.add(id);
      c.fnIds = includeTests ? fnPlan.ids[i] : fnPlan.ids[i].filter((id) => !isTestFn(id));
    });
    if (fromId) cands = cands.filter((c) => c.entry !== fromEntry);   // the mechanism is not a result of a search from itself
    const testN = cands.filter((c) => isTestEntry(c.entry)).length;
    if (!includeTests) cands = cands.filter((c) => !isTestEntry(c.entry));
    const qvs = fromId ? new Map() : await embedAll(embedder.ctx, searched.map((t, i) => ({ key: `q${i}`, text: t })), null, { prefix: model.query, quiet: true });

    console.log(`Semantic search of ${ndx}${fromId ? ` from mechanism ${fromId}` : multi ? '' : ` for: ${queries[0]}`}`);
    if (fromId) {
      for (const line of mechanismQueryBlock(fromEntry, plan.texts[fromAt], fromData, fromId)) console.log(line);
      console.log(`\n${fromEntry.id} itself is left out of the results. Groups that hold some of its functions come first, since a function is closest to itself. Each group is scored by its name against this mechanism's name, and by its best function against the mean of this mechanism's ${fromFn ? `${nf(fnPlan.ids[fromAt].length)} functions' vectors` : 'functions (it has none the index holds, so its name stands for both)'}.`);
      console.log('HITS and NEAR HITS were set on written queries; for one mechanism compared with the others they are untested, so read the scores, not the tier.');
    }
    if (multi) console.log(source);
    console.log(`${chosen.note}${missing ? ` (${plural(missing, 'text')} new since the build embedded now)` : ''}`);
    console.log(`${plural(cands.length, 'group')} of functions ranked, each by its name and its best function's text${testLeftOutNote(testN, testFnsInKept.size, includeTests)}`);
    console.log('A hit is the closest code found for the text, a place to read. It is not a finding that the code does what the text says.');
    if (reworded) console.log(reworded.header);
    for (const line of unusedOptionNotes(args)) console.log(line);
    let plateau = 0;
    queries.forEach((query, i) => {
      const ranked = fromId ? rankFused(fromLabel, cands, fnVecs, FUSE_LABEL_WEIGHT, null, fromFn) : rankFused(qvs.get(`q${i}`), cands, fnVecs, FUSE_LABEL_WEIGHT);
      if (fromId) query = `mechanism ${fromEntry.id} ${fromEntry.label}`;
      const rows = searchRows(ranked, (id) => fnById.get(id));
      const qv = fromId ? (fromFn || fromLabel) : qvs.get(`q${i}`);
      const scoreOf = (id) => { const v = fnVecs.get(id); return v ? cosine(qv, v) : null; };
      for (const r of rows.slice(0, NEXT_FOR_ROWS)) r.next = nextFunctions(r, scoreOf, (id) => fnById.get(id));
      perElement.push(rows);
      console.log('');
      const typical = ranked.length ? median(ranked.map((x) => x.cos)) : 0;
      if (searchTiers(rows, typical).hits.length > TIER_ROWS) plateau++;
      const rw = reworded ? reworded.rows[i] : null;
      for (const line of renderSearch({ query, heading: multi ? `ELEMENT ${i + 1} of ${queries.length}` : null, rows, typical, top, filter, verbose: !!args.verbose, searchedAs: rw ? rw.rewritten : null, notReworded: rw ? rw.error : null })) console.log(line);
    });
    if (multi && queries.length > 1) { console.log(''); for (const line of renderAcross(perElement, { verbose: !!args.verbose, depth: acrossDepth(Math.min(...perElement.map((r) => r.length))) })) console.log(line); }
    const tips = closingTips({ ndx, raw, described: all.filter((e) => String(e.description || '').trim()).length, entriesN: all.length, claimLike: readsLikeClaim(queries, multi), airGapped: !!args.air_gapped, plateau, elementsN: queries.length, reworded: !!reworded });
    console.log('');
    for (const line of tips) console.log(line);
    console.log(`${tips.length ? '\n' : ''}--verbose shows full paths, every group and the score's parts; --embed-distance prints the same ranking as raw cosines.`);
  } finally {
    await embedder.dispose();
  }
}

export async function doBuildEmbeddings(args) {
  const ndx = args.index_path;
  const entries = loadEntries(ndx);
  if (!entries) { console.error(`${ndx} has no mechanisms.json, the groups of functions that are embedded. Build it first (no model needed):\n  ce --ndx ${ndx} --build-mechanisms`); process.exitCode = 2; return; }
  let model;
  try { model = chooseBuildModel(args.embed_model || null); } catch (e) { console.error(`--build-embeddings: ${e.message}`); process.exitCode = 2; return; }
  process.stderr.write('# reading the index…\n');
  const plan = entryEmbedPlan(entries);
  const { plan: fnPlan } = await loadFunctionPlan(ndx, entries);
  const files = KINDS().map((k) => embedCacheFile(ndx, model.base, k));
  const parts = [
    ['group names', plan.whole, files[0], false],
    ['group name chunks', plan.extra, files[1], false],
    ['function texts', fnPlan.texts, files[2], true],
  ].filter((p) => p[1].length);
  const missing = parts.map((p) => missingInCache(p[2], p[1], model.doc));
  const total = parts.reduce((s, p) => s + p[1].length, 0), todo = missing.reduce((s, n) => s + n, 0);
  const why = args.embed_model ? '' : model.name === PREFERRED_EMBED_MODEL ? ' (the default when its file is installed)' : ` (${PREFERRED_EMBED_MODEL} is not installed; --embed-model list shows what is)`;
  console.log(`Building ${model.name} embeddings for ${ndx}${why}: ${nf(total)} texts (${plural(entries.length, 'group')} and their ${plural(fnPlan.texts.length, 'function')}), ${nf(todo)} to embed, ${nf(total - todo)} already built.`);
  if (!todo) { console.log(`Nothing to do. Search with:\n  ce --ndx ${ndx} --semantic-search "<text>"`); return; }
  console.log('Runs on this machine with no network call. Progress is reported about once a minute; stopping keeps what was embedded, and running this again continues.');
  let embedder;
  try { embedder = await openEmbedder(model.path, { cpu: !!args.cpu }); } catch (e) { console.error(`\n--build-embeddings: ${e.message}`); process.exitCode = 1; return; }
  const t0 = Date.now();
  try {
    for (const [name, texts, file, compact] of parts) await embedAll(embedder.ctx, texts, file, { prefix: model.doc, quiet: true, notice: name, compact });
  } finally {
    await embedder.dispose();
  }
  console.log(`Built in ${((Date.now() - t0) / 1000).toFixed(0)} s, saved under ${path.join(ndx, 'embeddings')}. Search with:\n  ce --ndx ${ndx} --semantic-search "<text>"${model.name === PREFERRED_EMBED_MODEL || !args.embed_model ? '' : ` --embed-model ${args.embed_model}`}`);
}
