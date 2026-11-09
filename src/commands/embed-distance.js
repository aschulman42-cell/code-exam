// embed-distance.js — --embed-distance: the cosine distance between a text and another text, a list of candidates, or every mechanism entry of an index, under a local embedding model
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// embed-distance-cli (2026-11-07). The instrument every register experiment of
// docs/describe-reach.md was run with by hand, as a command: embed the query,
// embed the candidates, rank by cosine, print the ranks, the distances and the
// median (what an unrelated candidate scores). Against an index, the candidates
// are its mechanism entries scored exactly as scripts/describe-reach.mjs scores
// them: label and member names in chunks of 8, the entry by its best chunk, the
// vectors cached beside mechanisms.json so a second query on a 16,000-entry index
// costs the query alone. No network, no key; --air-gapped changes nothing.
//
//   ce --embed-distance "<text>" --against "<text>"               one pair
//   ce --embed-distance "<text>" --against @candidates.txt         a list, one per line
//   ce --ndx <index> --embed-distance "<text>"                     the index's mechanism entries
//   ce --ndx <index> --embed-distance @claim.txt                   every element of a claim, one process
//        [--elements @list.txt]   the elements verbatim, one per line, instead of CodeExam's split
//        [--embed-model nomic|jina|coderank|qwen06|qwen4|<path.gguf>] [--max-results N]
//        [--filter <s>] [--no-prefix] [--cpu] [--verbose]
//
// embed-distance-per-element (2026-11-09): `@<file>` reads a claim, splits it as
// --claim-locate and --claim-chart do (--elements @list overrides the split, the
// --claim-chart contract), loads the model and the cached vectors once, prints each
// element's listing, and closes with a table: the nearest entry per element, its
// margin over the median, the band's word, and under --filter the rank of the first
// entry the filter matched. Andrew's two .bat files of eight and ten calls, 137 s on
// ExoPlayer 3 with the model and 17,607 vectors loaded per call, were this by hand.
//
// A high cosine on a shared label word is not relatedness ("Receiver" for
// "reception device"), which is why --verbose shows the chunk that scored, under
// the entry's block as --mechanisms -v prints it (id, description, label, every
// member as file@name with its line range): the listing as an ad-hoc claim-chart
// tester, an element typed in, the functions to open under each nearest entry.
import fs from 'node:fs';
import path from 'node:path';
import { resolveEmbedModel, openEmbedder, embedAll, entryChunks, entryText, cosine, median, cut, TEXT_MAX_CHARS, EMBED_MODELS, DEFAULT_EMBED_MODEL } from '../core/embed.js';
import { loadMechanismsIndex, foldRecords, recordBlock } from '../core/mechanisms-index.js';
import { effectiveCount } from '../argparse.js';
import { splitClaimElements, parseElementsFile } from './claim-locate.js';

export const CHUNK = 8;
const nf = (n) => Number(n).toLocaleString('en-US');

/**
 * The models a run uses (embed-distance-model-column, 2026-11-09): one name or
 * path, a comma list, or `installed`, every registry model whose file is under
 * models/, in registry order. Each is resolved up front, so a missing file fails
 * with its download source before any model loads; a model named twice runs once.
 */
export function resolveEmbedModels(spec = DEFAULT_EMBED_MODEL, opts = {}) {
  const parts = String(spec || DEFAULT_EMBED_MODEL).split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (p === 'installed') {
      const before = out.length;
      for (const name of Object.keys(EMBED_MODELS)) { try { out.push(resolveEmbedModel(name, opts)); } catch { /* not installed */ } }
      if (out.length === before) throw new Error(`--embed-model installed: no embedding model is under ${opts.modelsDir || 'models/'}; the files looked for are ${Object.values(EMBED_MODELS).map((m) => m.file).join(', ')}`);
      continue;
    }
    out.push(resolveEmbedModel(p, opts));
  }
  const seen = new Set();
  return out.filter((m) => (seen.has(m.path) ? false : (seen.add(m.path), true)));
}

/**
 * The band's numbers were calibrated under nomic (2026-11-07 and 2026-11-08) and
 * are read only there (embed-distance-band-small-index, 2026-11-09: the demo
 * claim's eleven elements scored 0.21 to 0.49 above the median under jina and
 * coderank against 0.11 to 0.21 under nomic, and jina's nothing-there queries
 * reached 0.27, so the two numbers mean nothing on another scale). Under another
 * model the margin prints and the note does not.
 */
export function bandCalibrated(model) {
  return /nomic-embed-text/i.test((model && model.base) || '');
}

/**
 * The texts to measure from. A plain text is one query. `@<file>` reads the file as
 * a claim and splits it with the pipeline's splitter, the elements --claim-chart
 * would chart; with `elementsArg` (`--elements @list`, one element per line, `#`
 * comments, the --claim-chart contract) the list is the queries, verbatim, and the
 * claim file is not read. Returns { queries, source }, `source` the header line
 * saying where they came from, null for a typed text. Throws on an unreadable file.
 */
export function resolveQueries(raw, elementsArg = null) {
  const spec = String(raw || '').trim();
  if (!spec.startsWith('@')) return { queries: spec ? [spec] : [], source: null };
  const file = spec.slice(1);
  const plural = (n) => `${nf(n)} element${n === 1 ? '' : 's'}`;
  if (elementsArg) {
    const list = String(elementsArg).trim().replace(/^@/, '');
    const { elements } = parseElementsFile(fs.readFileSync(list, 'utf8'));
    return { queries: elements, source: `${plural(elements.length)} from ${list}, supplied verbatim` };
  }
  const elements = splitClaimElements(fs.readFileSync(file, 'utf8')).map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
  return { queries: elements, source: `${plural(elements.length)} from ${file}, split by CodeExam (--elements @list supplies them verbatim)` };
}

/** A candidate list: one per line, blank lines and `#` comments skipped, lines cut at TEXT_MAX_CHARS. */
export function readCandidateList(file) {
  const raw = fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  let cutCount = 0;
  const lines = raw.map((s) => (s.length > TEXT_MAX_CHARS ? (cutCount++, cut(s)) : s));
  return { lines, cutCount };
}

/** Where an index's entry vectors live: beside its mechanisms.json, one file per model and text. */
export function embedCacheFile(indexPath, modelBase, suffix) {
  return path.join(indexPath, 'embeddings', `${modelBase}_${suffix}.json`);
}

/**
 * Rank candidates by their best vector's cosine to the query. Each candidate is
 * { text, vectors: [v, ...], chunks: [text, ...], label?, members? }; returns them
 * sorted, with cos, chunk (the scoring one) and rank (1-based, ties in order).
 */
export function rankCandidates(qv, cands) {
  const scored = cands.map((c) => {
    let best = -2, bi = 0;
    c.vectors.forEach((v, i) => { const x = cosine(qv, v); if (x > best) { best = x; bi = i; } });
    return { ...c, cos: best, chunk: c.chunks ? c.chunks[bi] : c.text };
  });
  scored.sort((a, b) => b.cos - a.cos);
  scored.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}

/** One listing row, the shape of the 2026-11-07 script: rank, cosine, distance, the candidate; under `verbose`, a mechanism entry's block (recordBlock) and then the chunk that scored. */
export function formatRow(x, width, { verbose = false } = {}) {
  const name = x.label != null ? `${x.label}  (${x.members ? x.members.length : 0} fn)` : (x.text.length > 200 ? x.text.slice(0, 200) + '…' : x.text);
  const holds = x.holds && x.holds.length ? `  holds ${x.holds.slice(0, 3).join(', ')}${x.holds.length > 3 ? ` +${x.holds.length - 3}` : ''}` : '';
  const row = `${String(x.rank).padStart(width)}. cosine ${x.cos.toFixed(4)}  distance ${(1 - x.cos).toFixed(4)}  ${name}${holds}`;
  if (!verbose || x.label == null) return row;
  const pad = ' '.repeat(width + 2);
  const block = x.entry ? recordBlock(x.entry, { verbose: true }).map((l) => `${pad}${l}`) : [];
  const chunk = x.chunk.length > 200 ? x.chunk.slice(0, 200) + '…' : x.chunk;
  return [row, ...block, `${pad}chunk: ${chunk}`].join('\n');
}

/**
 * Apply --filter after ranking: the candidates whose text, label or member names
 * contain `s` (case-insensitive), ranks kept, each entry told which members matched.
 */
export function filterRanked(ranked, s) {
  const f = String(s).toLowerCase();
  const out = [];
  for (const x of ranked) {
    const inText = String(x.label != null ? x.label : x.text).toLowerCase().includes(f);
    const holds = (x.members || []).map((m) => m.name || '').filter((n) => n.toLowerCase().includes(f));
    if (inText || holds.length) out.push({ ...x, holds });
  }
  return out;
}

/**
 * The top row's margin over the median, read against a band. Under NO_MATCH_MARGIN
 * the listing says "no clear match"; from there to BORDERLINE_MARGIN it says
 * "borderline"; above, nothing. Calibrated 2026-11-07 (nomic, labels in chunks of 8)
 * on CodeExam's own index, the demo and ExoPlayer 3: five queries with a known
 * mechanism put their top row 0.15 to 0.30 above the median; six queries the
 * codebase has nothing for ("generate prime numbers", "verifying a certificate
 * chain" on CodeExam) put theirs 0.08 to 0.14 above it, except one at 0.20 that was
 * a shared-word hit ("chain" in a GL shader test's name). No statistic separated the
 * two groups cleanly (z-scores overlapped from 1.7 to 5.7 in both). The first rule
 * was a single line at 0.14; on 2026-11-08 four rewordings of one query about
 * multisect on CodeExam's index landed at 0.137, 0.141, 0.148 and 0.180 with the
 * multisect mechanisms in every top row, and the first of them fired the note. So
 * the line is a band: under 0.12 nothing known has matched; 0.12 to 0.16 is where
 * both groups land; above 0.16 no unrelated query reached but the shared-word one.
 * Neither note says "found": a label-word hit sits above the band.
 */
export const NO_MATCH_MARGIN = 0.12;
/** The top of the band where known matches and unrelated queries overlap; a margin from NO_MATCH_MARGIN to here is reported as borderline. */
export const BORDERLINE_MARGIN = 0.16;
/** A listing shorter than this has no median worth reading. */
export const MEDIAN_MIN = 10;
/**
 * Under this many candidates the band under-calls, and its note says so
 * (embed-distance-band-small-index, measured 2026-11-09). A nothing-there query's
 * top row is the best of N near-random draws, so its margin over the median grows
 * with N: on the 34-entry demo six nothing-there queries topped out at 0.110 and
 * three of the demo claim's eleven true matches scored 0.107 to 0.119 with the
 * right mechanism on top; on CodeExam's 383 entries nothing-there queries reached
 * 0.168 and on ExoPlayer 3's 10,828 they reached 0.172, where the known matches
 * start at 0.183. No scale-free unit did better: the margin in units of the
 * field's median absolute deviation (2.5 to 5.4 for the demo's nothing-there
 * queries against 2.9 to 9.9 for its matches) or of its median-to-90th-percentile
 * distance overlapped between the classes on every set, by more than the raw
 * margin. So the numbers stay, and a small index is told the floor is high for it.
 */
export const SMALL_INDEX = 100;

/** The band's word for a top row's margin over the median: `no clear match` under NO_MATCH_MARGIN, `borderline` under BORDERLINE_MARGIN, empty above it, for a list too short for a median, and under a model the band was not calibrated on. One rule for the listing's note and the per-element table. */
export function bandWord(margin, n, { calibrated = true } = {}) {
  if (!calibrated || n < MEDIAN_MIN) return '';
  if (margin < NO_MATCH_MARGIN) return 'no clear match';
  if (margin < BORDERLINE_MARGIN) return 'borderline';
  return '';
}

/** A ranking's median cosine, the top row's margin over it, and the band's word for that margin. */
export function listingStats(ranked, { calibrated = true } = {}) {
  const med = ranked.length ? median(ranked.map((x) => x.cos)) : 0;
  const margin = ranked.length ? ranked[0].cos - med : 0;
  return { med, margin, word: bandWord(margin, ranked.length, { calibrated }) };
}

/** The listing as lines: the query (under `heading`, as `heading: query`, the per-element form), what was ranked (omitted when null: the caller printed it once), the median and the top row's margin over it (with a word that the band is not read under `modelName` when `calibrated` is false), a note (set apart by a blank line, so a reader sees it) when that margin says no match, with the small-index clause under SMALL_INDEX candidates, then the rows. */
export function renderListing({ query, what, ranked, top, filter, verbose, heading = null, calibrated = true, modelName = null }) {
  const { med, margin, word } = listingStats(ranked, { calibrated });
  const unread = calibrated ? '' : `; the band is calibrated on nomic and not read under ${modelName || 'this model'}`;
  const L = [`${heading ? `${heading}: ` : 'query: '}${query}`, `${what ? `${what}; ` : ''}median cosine ${med.toFixed(4)}${ranked.length >= MEDIAN_MIN ? ` (the nearest is ${margin.toFixed(4)} above it${unread})` : ''}`];
  const small = ranked.length < SMALL_INDEX ? `; on an index of only ${nf(ranked.length)} entries the band under-calls, since an unrelated query's top row is the best of few draws and sits lower above the median (on the 34-entry demo three true matches scored 0.107 to 0.119): read the rows` : '';
  if (word === 'no clear match') L.push('', `no clear match: the nearest candidate is only ${margin.toFixed(4)} above the median, about what an unrelated candidate scores; the rows below are the least far, not a find${small}`);
  else if (word === 'borderline') L.push('', `borderline: the nearest candidate is ${margin.toFixed(4)} above the median, in the band (${NO_MATCH_MARGIN} to ${BORDERLINE_MARGIN}) where queries with a known mechanism and queries the codebase has nothing for both land; read the rows before calling it a find${small}`);
  let shown = ranked;
  if (filter) {
    shown = filterRanked(ranked, filter);
    L.push(`--filter "${filter}": ${shown.length} of ${ranked.length} match${Number.isFinite(top) && shown.length > top ? `; showing the first ${top}` : ''}`);
  }
  L.push('');
  const width = String(ranked.length).length;
  for (const x of (Number.isFinite(top) ? shown.slice(0, top) : shown)) L.push(formatRow(x, width, { verbose }));
  return L;
}

/**
 * The closing table of a per-element run, one row per element: its number, the
 * element cut at 60 characters, the nearest candidate (an entry's label or a text
 * cut at 48), its margin over the median (blank when the list was too short for
 * one), the band's word, and under --filter the rank of the first candidate the
 * filter matched (`none` when nothing did): the believed implementer's rank per
 * element, the self-test's reading. Columns are padded to align.
 */
export function renderSummary(rows, { filter = null } = {}) {
  const cutAt = (s, n) => { const t = String(s || '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const head = ['#', 'element', 'nearest', 'margin', 'note', ...(filter ? [`--filter "${filter}" rank`] : [])];
  const body = rows.map((r) => [String(r.n), cutAt(r.element, 60), cutAt(r.nearest, 48), r.margin == null ? '' : r.margin.toFixed(3), r.word || '', ...(filter ? [r.filterRank == null ? 'none' : String(r.filterRank)] : [])]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const right = new Set([0, 3, 5]);
  const line = (cells) => cells.map((c, i) => (right.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), ...body.map(line)];
}

/**
 * The comparison table of a run under several models (embed-distance-model-column):
 * one row per element, the margin under each model and, under --filter, the rank
 * of the first entry the filter matched under each; the nearest entries are in the
 * listings above (a nearest column per model would not fit a terminal). Then one
 * line per model: with the filter, how many elements put the filtered entry first
 * and within 25, the describe-reach reading for one claim; without it, for each
 * model after the first, how many elements' nearest entry agrees with the first
 * model's. `perModel` is [{ model, rows }] with rows as renderSummary takes them.
 */
export function renderComparison(perModel, { filter = null } = {}) {
  const cutAt = (s, n) => { const t = String(s || '').replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
  const names = perModel.map((p) => p.model.name);
  const head = ['#', 'element', ...names.flatMap((n) => [`${n} margin`, ...(filter ? [`${n} rank`] : [])])];
  const rows = perModel[0].rows;
  const body = rows.map((r, i) => [String(r.n), cutAt(r.element, 60), ...perModel.flatMap((p) => { const x = p.rows[i] || {}; return [x.margin == null ? '' : x.margin.toFixed(3), ...(filter ? [x.filterRank == null ? 'none' : String(x.filterRank)] : [])]; })]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i === 1 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd();
  const out = [line(head), ...body.map(line), ''];
  const m = rows.length;
  const el = `element${m === 1 ? '' : 's'}`;
  for (const [k, p] of perModel.entries()) {
    if (filter) {
      const first = p.rows.filter((r) => r.filterRank === 1).length;
      const within = p.rows.filter((r) => r.filterRank != null && r.filterRank <= 25).length;
      out.push(`${p.model.name}: --filter "${filter}" first for ${first} of ${m} ${el}, within 25 for ${within}`);
    } else if (k > 0) {
      const agree = p.rows.filter((r, i) => r.nearest === perModel[0].rows[i].nearest).length;
      out.push(`${p.model.name}: nearest agrees with ${perModel[0].model.name}'s on ${agree} of ${m} ${el}`);
    }
  }
  return out;
}

export async function doEmbedDistance(args) {
  let queries, source;
  try { ({ queries, source } = resolveQueries(args.embed_distance, args.elements)); } catch (e) { console.error(`--embed-distance: ${e.message}`); process.exitCode = 2; return; }
  if (!queries.length) { console.error(source ? `--embed-distance: ${source}` : '--embed-distance takes the text to measure from, or @<file> for every element of a claim'); process.exitCode = 2; return; }
  const multi = source != null;
  let models;
  try { models = resolveEmbedModels(args.embed_model || undefined); } catch (e) { console.error(e.message); process.exitCode = 2; return; }
  const against = args.against != null ? String(args.against) : null;
  const indexPath = against == null ? args.index_path : null;
  if (against == null && !indexPath) { console.error('--embed-distance needs --against <text|@file> or an index (--ndx <path>) whose mechanism entries to rank'); process.exitCode = 2; return; }
  const noPrefix = !!args.no_prefix;
  const top = effectiveCount(args, args.max_results, 20);
  const filter = args.filter ? String(args.filter) : null;

  let entries = null, data = null;
  if (indexPath) {
    data = loadMechanismsIndex({ indexPath }, { cache: false });
    if (!data || !data.records.length) { console.error(`${indexPath} has no mechanisms.json; build it with --build-mechanisms (no model needed)`); process.exitCode = 2; return; }
    entries = foldRecords(data.records);
  }
  if (multi) console.log(source);
  if (models.length > 1) console.log(`${models.length} models in turn: ${models.map((m) => m.name).join(', ')}`);

  // embed-distance-model-column: the models run one at a time, each loaded, used
  // and disposed, each with its own cache; perModel collects each model's table
  // rows for the comparison at the end.
  const perModel = [];
  for (const model of models) {
    const qp = noPrefix ? '' : model.query, dp = noPrefix ? '' : model.doc;
    const calibrated = bandCalibrated(model);
    process.stderr.write(`# loading ${model.base}${args.cpu ? ' (cpu)' : ''}…\n`);
    const embedder = await openEmbedder(model.path, { cpu: !!args.cpu });
    try {
      if (models.length > 1) console.log('');
      console.log(`model ${path.basename(model.path)}${noPrefix ? ', no prefixes' : (qp || dp) ? `, prefixes: query ${JSON.stringify(qp)}, document ${JSON.stringify(dp)}` : ''}`);
      const qvs = await embedAll(embedder.ctx, queries.map((t, i) => ({ key: `q${i}`, text: t })), null, { prefix: qp, quiet: true });

      if (against != null && !against.startsWith('@')) {
        const bv = (await embedAll(embedder.ctx, [{ key: 'b', text: cut(against) }], null, { prefix: dp, quiet: true })).get('b');
        if (!multi) {
          const c = cosine(qvs.get('q0'), bv);
          console.log(`cosine ${c.toFixed(4)}   distance ${(1 - c).toFixed(4)}\n  A: ${queries[0]}\n  B: ${against}`);
          continue;
        }
        // one line per element against the one text; no table, the lines are it
        console.log(`  B: ${against}`);
        queries.forEach((q, i) => { const c = cosine(qvs.get(`q${i}`), bv); console.log(`element ${i + 1}: cosine ${c.toFixed(4)}  distance ${(1 - c).toFixed(4)}  ${q.length > 100 ? q.slice(0, 99) + '…' : q}`); });
        continue;
      }

      let cands, what;
      if (against != null) {
        const file = against.slice(1);
        const { lines, cutCount } = readCandidateList(file);
        const vecs = await embedAll(embedder.ctx, lines.map((t, i) => ({ key: `${i}`, text: t })), null, { prefix: dp, quiet: true });
        cands = lines.map((t, i) => ({ text: t, vectors: [vecs.get(`${i}`)] }));
        what = `${nf(lines.length)} candidates from ${file}${cutCount ? ` (${cutCount} line(s) cut at ${nf(TEXT_MAX_CHARS)} characters)` : ''}`;
      } else {
        // the index's entries, as describe-reach scores them; whole texts and the chunks beyond them cached beside mechanisms.json
        const texts = entries.map((e) => entryText(e, 'label+members').text);
        const chunks = entries.map((e) => entryChunks(e, 'label+members', CHUNK));
        const stats = { whole: {}, chunks: {} };
        const whole = await embedAll(embedder.ctx, entries.map((e, i) => ({ key: `${e.id}:${i}`, text: texts[i] })), embedCacheFile(indexPath, model.base, 'label+members'), { prefix: dp, label: 'entries', stats: stats.whole, quiet: !args.verbose });
        const extra = [];
        chunks.forEach((cs, i) => cs.forEach((t, c) => { if (t !== texts[i]) extra.push({ key: `${entries[i].id}:${i}:${c}`, text: t }); }));
        const more = extra.length ? await embedAll(embedder.ctx, extra, embedCacheFile(indexPath, model.base, `label+members_chunks${CHUNK}`), { prefix: dp, label: 'chunks', stats: stats.chunks, quiet: !args.verbose }) : new Map();
        cands = entries.map((e, i) => ({ text: texts[i], label: e.label, members: e.members || [], entry: e, chunks: chunks[i], vectors: chunks[i].map((t, c) => (t === texts[i] ? whole.get(`${e.id}:${i}`) : more.get(`${e.id}:${i}:${c}`))) }));
        const fresh = (stats.whole.fresh || 0) + (stats.chunks.fresh || 0), cached = (stats.whole.cached || 0) + (stats.chunks.cached || 0);
        what = `${nf(entries.length)} mechanism entries of ${indexPath} (label + member names, best chunk of ${CHUNK}; ${nf(cached)} vectors from cache, ${nf(fresh)} embedded)`;
      }
      if (multi) console.log(what);
      const rows = [];
      queries.forEach((query, i) => {
        const ranked = rankCandidates(qvs.get(`q${i}`), cands);
        if (multi) console.log('');
        for (const line of renderListing({ query, what: multi ? null : what, ranked, top, filter, verbose: !!args.verbose, heading: multi ? `element ${i + 1} of ${queries.length}` : null, calibrated, modelName: model.name })) console.log(line);
        const { margin, word } = listingStats(ranked, { calibrated });
        const first = ranked[0];
        const hit = filter ? filterRanked(ranked, filter)[0] : null;
        rows.push({ n: i + 1, element: query, nearest: first ? (first.label != null ? first.label : first.text) : '', margin: ranked.length >= MEDIAN_MIN ? margin : null, word, filterRank: hit ? hit.rank : null });
      });
      perModel.push({ model, rows });
    } finally {
      await embedder.dispose();
    }
  }
  if (!perModel.length) return;   // the one-text --against form printed its lines
  if (models.length === 1) {
    if (multi) { console.log(''); for (const line of renderSummary(perModel[0].rows, { filter })) console.log(line); }
    return;
  }
  console.log('');
  for (const line of renderComparison(perModel, { filter })) console.log(line);
}

export const EMBED_MODEL_NAMES = Object.keys(EMBED_MODELS);
