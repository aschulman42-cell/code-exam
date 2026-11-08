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
//        [--embed-model nomic|jina|coderank|qwen06|qwen4|<path.gguf>] [--max-results N]
//        [--filter <s>] [--no-prefix] [--cpu] [--verbose]
//
// A high cosine on a shared label word is not relatedness ("Receiver" for
// "reception device"), which is why --verbose shows the chunk that scored, under
// the entry's block as --mechanisms -v prints it (id, description, label, every
// member as file@name with its line range): the listing as an ad-hoc claim-chart
// tester, an element typed in, the functions to open under each nearest entry.
import fs from 'node:fs';
import path from 'node:path';
import { resolveEmbedModel, openEmbedder, embedAll, entryChunks, entryText, cosine, median, cut, TEXT_MAX_CHARS, EMBED_MODELS } from '../core/embed.js';
import { loadMechanismsIndex, foldRecords, recordBlock } from '../core/mechanisms-index.js';
import { effectiveCount } from '../argparse.js';

export const CHUNK = 8;
const nf = (n) => Number(n).toLocaleString('en-US');

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

/** The listing as lines: the query, what was ranked, the median and the top row's margin over it, a note (set apart by a blank line, so a reader sees it) when that margin says no match, then the rows. */
export function renderListing({ query, what, ranked, top, filter, verbose }) {
  const med = median(ranked.map((x) => x.cos));
  const margin = ranked.length ? ranked[0].cos - med : 0;
  const L = [`query: ${query}`, `${what}; median cosine ${med.toFixed(4)}${ranked.length >= MEDIAN_MIN ? ` (the nearest is ${margin.toFixed(4)} above it)` : ''}`];
  if (ranked.length >= MEDIAN_MIN && margin < NO_MATCH_MARGIN) L.push('', `no clear match: the nearest candidate is only ${margin.toFixed(4)} above the median, about what an unrelated candidate scores; the rows below are the least far, not a find`);
  else if (ranked.length >= MEDIAN_MIN && margin < BORDERLINE_MARGIN) L.push('', `borderline: the nearest candidate is ${margin.toFixed(4)} above the median, in the band (${NO_MATCH_MARGIN} to ${BORDERLINE_MARGIN}) where queries with a known mechanism and queries the codebase has nothing for both land; read the rows before calling it a find`);
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

export async function doEmbedDistance(args) {
  const query = String(args.embed_distance || '').trim();
  if (!query) { console.error('--embed-distance takes the text to measure from'); process.exitCode = 2; return; }
  let model;
  try { model = resolveEmbedModel(args.embed_model || undefined); } catch (e) { console.error(e.message); process.exitCode = 2; return; }
  const against = args.against != null ? String(args.against) : null;
  const indexPath = against == null ? args.index_path : null;
  if (against == null && !indexPath) { console.error('--embed-distance needs --against <text|@file> or an index (--ndx <path>) whose mechanism entries to rank'); process.exitCode = 2; return; }
  const noPrefix = !!args.no_prefix;
  const qp = noPrefix ? '' : model.query, dp = noPrefix ? '' : model.doc;
  const top = effectiveCount(args, args.max_results, 20);
  const filter = args.filter ? String(args.filter) : null;

  let entries = null, data = null;
  if (indexPath) {
    data = loadMechanismsIndex({ indexPath }, { cache: false });
    if (!data || !data.records.length) { console.error(`${indexPath} has no mechanisms.json; build it with --build-mechanisms (no model needed)`); process.exitCode = 2; return; }
    entries = foldRecords(data.records);
  }

  process.stderr.write(`# loading ${model.base}${args.cpu ? ' (cpu)' : ''}…\n`);
  const embedder = await openEmbedder(model.path, { cpu: !!args.cpu });
  try {
    console.log(`model ${path.basename(model.path)}${noPrefix ? ', no prefixes' : (qp || dp) ? `, prefixes: query ${JSON.stringify(qp)}, document ${JSON.stringify(dp)}` : ''}`);
    const qv = (await embedAll(embedder.ctx, [{ key: 'q', text: query }], null, { prefix: qp, quiet: true })).get('q');

    if (against != null && !against.startsWith('@')) {
      const bv = (await embedAll(embedder.ctx, [{ key: 'b', text: cut(against) }], null, { prefix: dp, quiet: true })).get('b');
      const c = cosine(qv, bv);
      console.log(`cosine ${c.toFixed(4)}   distance ${(1 - c).toFixed(4)}\n  A: ${query}\n  B: ${against}`);
      return;
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
    const ranked = rankCandidates(qv, cands);
    for (const line of renderListing({ query, what, ranked, top, filter, verbose: !!args.verbose })) console.log(line);
  } finally {
    await embedder.dispose();
  }
}

export const EMBED_MODEL_NAMES = Object.keys(EMBED_MODELS);
