// test_embed_distance.js — --embed-distance with no model: the flags, the model registry and its prefixes, the candidate list, the ranking and the listing, the cache file beside mechanisms.json, the compact vector store
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// embed-distance-cli (2026-11-07). The embedding itself needs a model and is not
// exercised here; everything around it is pure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/argparse.js';
import { EMBED_MODELS, DEFAULT_EMBED_MODEL, resolveEmbedModel, entryChunks, embedAll, COMPACT_ABOVE_DIMS, readCache } from '../src/core/embed.js';
import { readCandidateList, embedCacheFile, rankCandidates, filterRanked, formatRow, rowHeader, rowId, idWidthOf, nameWithId, renderListing, CHUNK, resolveQueries, bandWord, listingStats, renderSummary, resolveEmbedModels, bandCalibrated, renderComparison, SMALL_INDEX } from '../src/commands/embed-distance.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** parseArgs reads process.argv; run it under the given argv and put the real one back. */
function withArgv(argv, fn) {
  const saved = process.argv;
  process.argv = [saved[0], saved[1], ...argv];
  try { return fn(); } finally { process.argv = saved; }
}

describe('embed-distance', () => {
  it('parses --embed-distance, --against, --embed-model and --no-prefix', () => {
    const a = withArgv(['--embed-distance', 'code rate', '--against', '@cands.txt', '--embed-model', 'jina', '--no-prefix', '--max-results', '0', '--filter', 'track'], () => parseArgs());
    assert.equal(a.embed_distance, 'code rate');
    assert.equal(a.against, '@cands.txt');
    assert.equal(a.embed_model, 'jina');
    assert.equal(a.no_prefix, true);
    assert.equal(a.filter, 'track');
    const b = withArgv(['--embed-distance', 'x'], () => parseArgs());
    assert.equal(b.against, null);
    assert.equal(b.embed_model, null);
    assert.equal(b.no_prefix, false);
  });

  it('the registry: nomic by default with its search_ prefixes, CodeRankEmbed and Qwen3 with query instructions and bare documents, jina with none; a missing file or a bad name says so', () => {
    assert.equal(DEFAULT_EMBED_MODEL, 'nomic');
    assert.deepEqual([EMBED_MODELS.nomic.query, EMBED_MODELS.nomic.doc], ['search_query: ', 'search_document: ']);
    assert.match(EMBED_MODELS.coderank.query, /^Represent this query/);
    assert.equal(EMBED_MODELS.coderank.doc, '');
    assert.match(EMBED_MODELS.qwen06.query, /^Instruct: .*\nQuery:$/s);
    assert.deepEqual([EMBED_MODELS.jina.query, EMBED_MODELS.jina.doc], ['', '']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-models-'));
    assert.throws(() => resolveEmbedModel('qwen4', { modelsDir: dir }), /not installed: expected .*Qwen3-Embedding-4B-Q8_0\.gguf; download it from https:/);
    assert.throws(() => resolveEmbedModel('bogus', { modelsDir: dir }), /takes one of nomic, jina, coderank, qwen06, qwen4, gemma, gemma-search, gemma2, gemma2-search or a path/);
    fs.writeFileSync(path.join(dir, 'nomic-embed-text-v1.5.Q8_0.gguf'), '');
    const m = resolveEmbedModel('nomic', { modelsDir: dir });
    assert.deepEqual([m.name, m.base, m.query], ['nomic', 'nomic-embed-text-v1.5.Q8_0', 'search_query: ']);
    const p = resolveEmbedModel(path.join(dir, 'nomic-embed-text-v1.5.Q8_0.gguf'));
    assert.equal(p.doc, 'search_document: ', 'a path whose name says nomic gets nomic\'s prefixes');
    fs.writeFileSync(path.join(dir, 'other.gguf'), '');
    assert.deepEqual([resolveEmbedModel(path.join(dir, 'other.gguf')).query, resolveEmbedModel(path.join(dir, 'other.gguf')).doc], ['', ''], 'any other path, no prefixes');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the candidate list skips blank lines and comments and cuts a long line, saying how many', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-list-'));
    const f = path.join(dir, 'cands.txt');
    fs.writeFileSync(f, '# a comment\n\nselecting the bitrate\n  buffered duration  \n' + 'x'.repeat(2000) + '\n');
    const { lines, cutCount } = readCandidateList(f);
    assert.deepEqual(lines.slice(0, 2), ['selecting the bitrate', 'buffered duration']);
    assert.equal(lines.length, 3);
    assert.equal(lines[2].length, 1500);
    assert.equal(cutCount, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ranks by the best chunk, keeps ranks under --filter and names the member that matched, and formats the row as rank, cosine, candidate under one header line', () => {
    const q = [1, 0, 0];
    const cands = [
      { text: 'far', label: '[class] Receiver', members: [{ name: 'Receiver::onReceive' }], chunks: ['[class] Receiver: Receiver on Receive'], vectors: [[0, 1, 0]] },
      { text: 'near', label: '[class] AdaptiveTrackSelection / other', members: [{ name: 'AdaptiveTrackSelection::determineIdealSelectedIndex' }, { name: 'AdaptiveTrackSelection::updateSelectedTrack' }], chunks: ['chunk one', 'chunk two'], vectors: [[0.2, 0.9, 0], [0.9, 0.1, 0]] },
      { text: 'middle', label: '[file] Builder / rate', members: [{ name: 'setRate' }], chunks: ['[file] Builder / rate: set Rate'], vectors: [[0.5, 0.5, 0]] },
    ];
    const ranked = rankCandidates(q, cands);
    assert.deepEqual(ranked.map((x) => x.label), ['[class] AdaptiveTrackSelection / other', '[file] Builder / rate', '[class] Receiver']);
    assert.equal(ranked[0].chunk, 'chunk two', 'the scoring chunk is the second');
    assert.deepEqual(ranked.map((x) => x.rank), [1, 2, 3]);
    const row = formatRow(ranked[1], 2);
    assert.equal(row, '  2.  0.5000  [file] Builder / rate  (1 fn)');
    assert.doesNotMatch(row, /cosine|distance/, 'the words are in the header line, once (Andrew, 2026-11-15)');
    assert.match(formatRow(ranked[0], 2, { verbose: true }), /\n      chunk: chunk two$/);
    const kept = filterRanked(ranked, 'determineideal');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].rank, 1, 'the overall rank is kept');
    assert.deepEqual(kept[0].holds, ['AdaptiveTrackSelection::determineIdealSelectedIndex']);
    assert.match(formatRow(kept[0], 2), /\(2 fn\)  holds AdaptiveTrackSelection::determineIdealSelectedIndex$/);
    const lines = renderListing({ query: 'q', what: '3 candidates', ranked, top: 2, filter: null, verbose: false });
    assert.equal(lines[0], 'query: q');
    assert.match(lines[1], /^3 candidates; median cosine 0\.5000$/);
    assert.equal(lines.length, 6, 'query, median, blank, the column header, two rows');
    assert.equal(lines[3], 'rank  cosine  entry');
    assert.equal(lines[4], '  1.  0.9000  [class] AdaptiveTrackSelection / other  (2 fn)', 'the cosine sits under its header word');
    assert.equal(rowHeader(5), '  rank  cosine  entry', 'a 10,000-entry index: the header widens with the rank column');
    assert.equal(formatRow({ ...ranked[1], rank: 10828 }, 5), '10828.  0.5000  [file] Builder / rate  (1 fn)');
    assert.equal(rowHeader(2, { entries: false }), 'rank  cosine  candidate', 'a list given with --against has candidates, not entries');
    assert.equal(rowHeader(2, { fused: true }), 'rank   score   label  function  entry');
    const none = renderListing({ query: 'q', what: '3 candidates', ranked, top: Infinity, filter: 'no such thing', verbose: false });
    assert.ok(!none.some((l) => l.startsWith('rank')), 'no header over no rows');
    const filtered = renderListing({ query: 'q', what: '3 candidates', ranked, top: Infinity, filter: 'rate', verbose: false });
    assert.match(filtered[2], /^--filter "rate": 1 of 3 match$/);
  });

  it('a mechanism row carries its record id in a column between the cosine and the label, padded to the widest id and named in the header; candidates given with --against have no id column', () => {
    // embed-distance-rows-show-mechanism-id (2026-11-21). Red before it: the rows named an entry by
    // its label alone, which repeats, and by a rank, which is a place in this one listing.
    const mk = (id, label, v) => ({ text: label, label, members: [{ name: 'f' }], entry: { id, label, members: [{ file: 'a.js', name: 'f' }], files: ['a.js'] }, chunks: [label], vectors: [v] });
    const ranked = rankCandidates([1, 0, 0], [mk('m7', '[file] a.js', [1, 0, 0]), mk('m1234', '[file] b.js', [0.5, 0.5, 0]), mk('m70', 'multisect (parse)', [0, 1, 0])]);
    assert.deepEqual(ranked.map(rowId), ['m7', 'm1234', 'm70']);
    assert.equal(idWidthOf(ranked), 5, 'the widest id');
    const L = renderListing({ query: 'q', what: '3 entries', ranked, top: Infinity, filter: null, verbose: false });
    assert.deepEqual(L.slice(3), [
      'rank  cosine  id     entry',
      '  1.  1.0000  m7     [file] a.js  (1 fn)',
      '  2.  0.5000  m1234  [file] b.js  (1 fn)',
      '  3.  0.0000  m70    multisect (parse)  (1 fn)',
    ]);
    assert.equal(formatRow(ranked[0], 2), '  1.  1.0000  m7  [file] a.js  (1 fn)', 'a row on its own pads to its own id');
    assert.equal(rowHeader(2, { fused: true, idWidth: 5 }), 'rank   score   label  function  id     entry', 'under --function-text the id column sits before the entry too');
    assert.equal(nameWithId(ranked[1]), 'm1234 [file] b.js', 'the closing tables name an entry by id, then label');
    const texts = rankCandidates([1, 0, 0], [{ text: 'a plain candidate', vectors: [[1, 0, 0]] }, { text: 'another', vectors: [[0, 1, 0]] }]);
    assert.equal(idWidthOf(texts), 0);
    assert.equal(rowId(texts[0]), '');
    assert.equal(nameWithId(texts[0]), 'a plain candidate');
    const T = renderListing({ query: 'q', what: '2 candidates', ranked: texts, top: Infinity, filter: null, verbose: false });
    assert.deepEqual(T.slice(3), ['rank  cosine  candidate', '  1.  1.0000  a plain candidate', '  2.  0.0000  another'], 'a list given with --against: no id column, no id header');
  });

  it('-v prints the entry block under a mechanism row, members as file@name with their line range, then the chunk; a text candidate stays one row', () => {
    const entry = {
      id: 'm9', label: '[class] AdaptiveTrackSelection / other', description: 'Picks the track.', files: ['a/Adaptive.java'], tags: ['giant'],
      members: [{ file: 'a/Adaptive.java', name: 'AdaptiveTrackSelection::determineIdealSelectedIndex', start: 10, end: 48 }, { file: 'a/Adaptive.java', name: 'AdaptiveTrackSelection::updateSelectedTrack' }],
    };
    const ranked = rankCandidates([1, 0, 0], [
      { text: 'near', label: entry.label, members: entry.members, entry, chunks: ['chunk one', 'chunk two'], vectors: [[0, 1, 0], [1, 0, 0]] },
      { text: 'a plain candidate', vectors: [[0, 1, 0]] },
    ]);
    const lines = formatRow(ranked[0], 2, { verbose: true }).split('\n');
    assert.equal(lines[0], '  1.  1.0000  m9  [class] AdaptiveTrackSelection / other  (2 fn)', 'the entry\'s record id sits between the cosine and the label');
    assert.equal(lines[1], '      m9    Picks the track.');
    assert.equal(lines[2], '            [class] AdaptiveTrackSelection / other  (2 fns, 1 file)  [giant]');
    assert.equal(lines[3], '            a/Adaptive.java@AdaptiveTrackSelection::determineIdealSelectedIndex  (L10–48)', 'a member with a range');
    assert.equal(lines[4], '            a/Adaptive.java@AdaptiveTrackSelection::updateSelectedTrack', 'a member without one prints as before');
    assert.equal(lines[5], '      chunk: chunk two', 'the chunk line closes the block');
    assert.equal(lines.length, 6);
    assert.equal(formatRow(ranked[1], 2, { verbose: true }), '  2.  0.0000  a plain candidate', 'no block for a text candidate');
  });

  it('says "no clear match" under the band, "borderline" inside it, and only the margin above it', () => {
    const q = [1, 0];
    // twelve candidates: a flat field around cosine 0.5; a top at 0.53 is no match, at 0.6455 borderline, at 0.8 clear
    const flat = Array.from({ length: 11 }, (_, i) => ({ text: `c${i}`, vectors: [[0.5 + i * 0.001, Math.sqrt(1 - (0.5 + i * 0.001) ** 2)]] }));
    const near = renderListing({ query: 'q', what: '12 candidates', ranked: rankCandidates(q, [...flat, { text: 'top', vectors: [[0.53, Math.sqrt(1 - 0.53 ** 2)]] }]), top: 3, filter: null, verbose: false });
    assert.match(near[1], /median cosine 0\.50\d\d \(the nearest is 0\.02\d\d above it\)$/);
    assert.equal(near[2], '', 'a blank line sets the note apart from the header (Andrew, 2026-11-08: it was easy to miss)');
    assert.match(near[3], /^no clear match: the nearest candidate is only 0\.02\d\d above the median/);
    const border = renderListing({ query: 'q', what: '12 candidates', ranked: rankCandidates(q, [...flat, { text: 'top', vectors: [[0.6455, Math.sqrt(1 - 0.6455 ** 2)]] }]), top: 3, filter: null, verbose: false });
    assert.match(border[1], /\(the nearest is 0\.1[34]\d\d above it\)$/);
    assert.equal(border[2], '');
    assert.match(border[3], /^borderline: the nearest candidate is 0\.1[34]\d\d above the median, in the band \(0\.12 to 0\.16\)/, 'the band where the 2026-11-08 multisect rewordings landed (0.137 to 0.180, all true matches)');
    assert.doesNotMatch(border.join('\n'), /no clear match/);
    const clear = renderListing({ query: 'q', what: '12 candidates', ranked: rankCandidates(q, [...flat, { text: 'top', vectors: [[0.8, 0.6]] }]), top: 3, filter: null, verbose: false });
    assert.match(clear[1], /\(the nearest is 0\.29\d\d above it\)$/);
    assert.equal(clear[2], '', 'no note when the top is clear of the median');
    const few = renderListing({ query: 'q', what: '3 candidates', ranked: rankCandidates(q, flat.slice(0, 3)), top: 3, filter: null, verbose: false });
    assert.doesNotMatch(few[1], /above it/, 'a short list has no median worth reading');
  });

  it('the cache lives beside mechanisms.json, one file per model and text, and a wide vector is stored compactly and read back', async () => {
    assert.equal(embedCacheFile('C:/idx', 'nomic-embed-text-v1.5.Q8_0', 'label+members_chunks8'), path.join('C:/idx', 'embeddings', 'nomic-embed-text-v1.5.Q8_0_label+members_chunks8.json'));
    assert.equal(CHUNK, 8);
    assert.deepEqual(entryChunks({ label: 'L', members: Array.from({ length: 9 }, (_, i) => ({ name: `f${i}` })) }, 'label+members', CHUNK).length, 2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-cache-'));
    const file = path.join(dir, 'v.json');
    const wide = Array.from({ length: COMPACT_ABOVE_DIMS + 1 }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0));
    const ctx = { getEmbeddingFor: async () => ({ vector: wide }) };
    const out = await embedAll(ctx, [{ key: 'k', text: 't' }], file, { quiet: true });
    const v = out.get('k');
    assert.ok(Math.abs(v[0] - 0.6) < 1e-6 && Math.abs(v[1] - 0.8) < 1e-6, 'unit vector');
    const stored = readCache(file).items.k;
    assert.equal(typeof stored.b, 'string', 'stored as base64 floats above the width');
    assert.equal(stored.v, undefined);
    let calls = 0;
    const again = await embedAll({ getEmbeddingFor: async () => { calls++; return { vector: wide }; } }, [{ key: 'k', text: 't' }], file, { quiet: true });
    assert.equal(calls, 0, 'read back from the compact store');
    assert.ok(Math.abs(again.get('k')[1] - 0.8) < 1e-6);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // embed-distance-per-element (2026-11-09)
  it('@file reads a claim and splits it as the pipeline does; --elements @list supplies the elements verbatim; a plain text is one query', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embed-elements-'));
    const claim = path.join(dir, 'claim.txt');
    const text = '1. A widget, comprising:\n  a first part;\n  a second part coupled to\n  the first part; and\n  a third part that holds the others.\n';
    fs.writeFileSync(claim, text);
    const split = resolveQueries(`@${claim}`);
    assert.equal(split.queries.length, splitClaimElements(text).length, 'the pipeline\'s split');
    assert.ok(split.queries.length >= 3, split.queries.join(' | '));
    assert.equal(split.queries[0], 'A widget, comprising:');
    assert.ok(split.queries.every((q) => !/\s\s|\n/.test(q)), 'whitespace collapsed');
    assert.match(split.source, /^\d+ elements from .*claim\.txt, split by CodeExam \(--elements @list supplies them verbatim\)$/);
    const list = path.join(dir, 'elements.txt');
    fs.writeFileSync(list, '# by hand\nthe first and second parts\n\nthe third part\n');
    const given = resolveQueries(`@${claim}`, `@${list}`);
    assert.deepEqual(given.queries, ['the first and second parts', 'the third part']);
    assert.match(given.source, /^2 elements from .*elements\.txt, supplied verbatim$/);
    assert.deepEqual(resolveQueries('code rate'), { queries: ['code rate'], source: null });
    assert.deepEqual(resolveQueries('  ').queries, []);
    assert.throws(() => resolveQueries(`@${path.join(dir, 'missing.txt')}`), /ENOENT/);
    assert.equal(withArgv(['--embed-distance', '@claim.txt', '--elements', '@list.txt'], () => parseArgs()).embed_distance, '@claim.txt');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bandWord and listingStats read the band once for the note and the table; renderSummary is one row per element with the nearest, the margin, the word and, under --filter, the rank of the first match; the per-element heading replaces "query:"', () => {
    assert.equal(bandWord(0.05, 12), 'no clear match');
    assert.equal(bandWord(0.13, 12), 'borderline');
    assert.equal(bandWord(0.3, 12), '');
    assert.equal(bandWord(0.05, 3), '', 'a short list has no band');
    const q = [1, 0];
    const flat = Array.from({ length: 11 }, (_, i) => ({ text: `c${i}`, vectors: [[0.5 + i * 0.001, Math.sqrt(1 - (0.5 + i * 0.001) ** 2)]] }));
    const ranked = rankCandidates(q, [...flat, { text: 'top', label: '[class] Top', members: [{ name: 'Top::go' }], vectors: [[0.8, 0.6]] }]);
    const s = listingStats(ranked);
    assert.ok(Math.abs(s.margin - (0.8 - s.med)) < 1e-9 && s.word === '', JSON.stringify(s));
    const rows = [
      { n: 1, element: 'a first part', nearest: '[class] Top', margin: 0.295, word: '', filterRank: 1 },
      { n: 2, element: 'a second part coupled to the first part, which is a very long element text indeed', nearest: 'c3', margin: 0.02, word: 'no clear match', filterRank: null },
    ];
    const t = renderSummary(rows, { filter: 'go' });
    assert.equal(t.length, 3);
    assert.match(t[0], /^#  element\s+nearest\s+margin  note\s+--filter "go" rank$/, t[0]);
    assert.match(t[1], /^1  a first part\s+\[class\] Top\s+0\.295\s+1$/, t[1]);
    assert.match(t[2], /^2  a second part coupled to the first part, which is a very \S*…\s+c3\s+0\.020  no clear match\s+none$/, t[2]);
    assert.ok(t[2].indexOf('…') < 70, 'the element is cut at 60');
    assert.doesNotMatch(renderSummary(rows)[0], /filter/, 'no filter column without --filter');
    assert.match(renderSummary([{ n: 1, element: 'x', nearest: 'y', margin: null, word: '', filterRank: null }])[1], /^1  x\s+y\s*$/, 'a blank margin for a list too short for a median');
    const heading = renderListing({ query: 'a first part', what: null, ranked, top: 1, filter: null, verbose: false, heading: 'element 1 of 2' });
    assert.equal(heading[0], 'element 1 of 2: a first part');
    assert.match(heading[1], /^median cosine 0\.50\d\d \(the nearest is 0\.29\d\d above it\)$/, 'no "what" when the caller printed it once');
  });

  // embed-distance-band-small-index (2026-11-09)
  it('the band reads only under nomic and tells a small index that it under-calls; above SMALL_INDEX candidates the note is as before', () => {
    assert.equal(bandWord(0.05, 12, { calibrated: false }), '', 'no word under a model the band was not calibrated on');
    assert.equal(bandWord(0.05, 12, { calibrated: true }), 'no clear match');
    assert.equal(bandCalibrated({ base: 'nomic-embed-text-v1.5.Q8_0' }), true);
    assert.equal(bandCalibrated({ base: 'jina-embeddings-v2-base-code-q8_0' }), false);
    assert.equal(bandCalibrated(null), false);
    const q = [1, 0];
    const field = (n) => Array.from({ length: n }, (_, i) => ({ text: `c${i}`, vectors: [[0.5 + (i % 11) * 0.001, Math.sqrt(1 - (0.5 + (i % 11) * 0.001) ** 2)]] }));
    const top = { text: 'top', vectors: [[0.53, Math.sqrt(1 - 0.53 ** 2)]] };
    const small = renderListing({ query: 'q', what: '12 candidates', ranked: rankCandidates(q, [...field(11), top]), top: 3, filter: null, verbose: false });
    assert.match(small[3], /^no clear match: .*; on an index of only 12 entries the band under-calls, since an unrelated query's top row is the best of few draws .*: read the rows$/, small[3]);
    assert.ok(SMALL_INDEX > 12 && SMALL_INDEX <= 120, `SMALL_INDEX ${SMALL_INDEX}`);
    const large = renderListing({ query: 'q', what: '120 candidates', ranked: rankCandidates(q, [...field(119), top]), top: 3, filter: null, verbose: false });
    assert.match(large[3], /^no clear match: /);
    assert.doesNotMatch(large[3], /under-calls/, 'no small-index clause above SMALL_INDEX');
    const other = renderListing({ query: 'q', what: '12 candidates', ranked: rankCandidates(q, [...field(11), top]), top: 3, filter: null, verbose: false, calibrated: false, modelName: 'jina' });
    assert.match(other[1], /\(the nearest is 0\.02\d\d above it; the band is calibrated on nomic and not read under jina\)$/, other[1]);
    assert.equal(other[2], '', 'no note under another model');
    assert.equal(other[3], 'rank  cosine  candidate', 'the column header follows the blank line directly');
    assert.match(other[4], /^\s*1\.  0\.5300  top$/, 'then the rows');
    assert.equal(listingStats(rankCandidates(q, [...field(11), top]), { calibrated: false }).word, '');
  });

  // embed-distance-model-column (2026-11-09)
  it('--embed-model takes a list or "installed", resolving each up front and running a model once; renderComparison is a margin column per model, a rank column under --filter, and one line per model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embed-models-'));
    for (const f of ['nomic-embed-text-v1.5.Q8_0.gguf', 'jina-embeddings-v2-base-code-q8_0.gguf']) fs.writeFileSync(path.join(dir, f), '');
    const opts = { modelsDir: dir };
    assert.deepEqual(resolveEmbedModels('installed', opts).map((m) => m.name), ['nomic', 'jina'], 'the registry order, the installed ones');
    assert.deepEqual(resolveEmbedModels('jina,nomic', opts).map((m) => m.name), ['jina', 'nomic']);
    assert.deepEqual(resolveEmbedModels('nomic, nomic', opts).map((m) => m.name), ['nomic'], 'a model named twice runs once');
    assert.deepEqual(resolveEmbedModels(undefined, opts).map((m) => m.name), ['nomic'], 'the default');
    assert.throws(() => resolveEmbedModels('nomic,qwen06', opts), /embedding model "qwen06" is not installed/, 'a missing file fails before any model loads');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embed-none-'));
    assert.throws(() => resolveEmbedModels('installed', { modelsDir: empty }), /no embedding model is under/);
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true });
    const perModel = [
      { model: { name: 'nomic' }, rows: [{ n: 1, element: 'a first part', nearest: '[class] Top', margin: 0.295, word: '', filterRank: 1 }, { n: 2, element: 'a second part', nearest: 'c3', margin: 0.02, word: 'no clear match', filterRank: 30 }] },
      { model: { name: 'jina' }, rows: [{ n: 1, element: 'a first part', nearest: '[class] Top', margin: 0.41, word: '', filterRank: 1 }, { n: 2, element: 'a second part', nearest: 'c7', margin: 0.33, word: '', filterRank: null }] },
    ];
    const t = renderComparison(perModel);
    assert.equal(t[0], '#  element        nomic margin  jina margin');
    assert.equal(t[1], '1  a first part          0.295        0.410');
    assert.equal(t[2], '2  a second part         0.020        0.330');
    assert.equal(t[3], '');
    assert.equal(t[4], "jina: nearest agrees with nomic's on 1 of 2 elements");
    assert.equal(t.length, 5, 'no line for the first model without a filter');
    const f = renderComparison(perModel, { filter: 'go' });
    assert.equal(f[0], '#  element        nomic margin  nomic rank  jina margin  jina rank');
    assert.equal(f[2], '2  a second part         0.020          30        0.330       none');
    assert.equal(f[4], 'nomic: --filter "go" first for 1 of 2 elements, within 25 for 1');
    assert.equal(f[5], 'jina: --filter "go" first for 1 of 2 elements, within 25 for 1');
    assert.equal(withArgv(['--embed-distance', 'x', '--embed-model', 'nomic,jina'], () => parseArgs()).embed_model, 'nomic,jina');
  });

  const MODEL = path.join(ROOT, 'models', 'nomic-embed-text-v1.5.Q8_0.gguf');
  const canRun = fs.existsSync(MODEL) && fs.existsSync(path.join(ROOT, '.demo', 'mechanisms.json')) && fs.existsSync(path.join(ROOT, 'sample_patent_claim.txt'));
  it('end to end on the sample claim against .demo: the model loads once, one listing per element, what was ranked printed once, the table last', { skip: canRun ? false : 'needs models/nomic-embed-text-v1.5.Q8_0.gguf, .demo/mechanisms.json and sample_patent_claim.txt' }, () => {
    const r = spawnSync(process.execPath, ['src/index.js', '--ndx', '.demo', '--embed-distance', '@sample_patent_claim.txt', '--max-results', '3'], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
    assert.equal(r.status, 0, (r.stderr || '').slice(-800));
    assert.equal((r.stderr.match(/^# loading /gm) || []).length, 1, 'the model loads once');
    const n = (r.stdout.match(/^element \d+ of \d+: /gm) || []).length;
    assert.ok(n >= 10, `elements: ${n}\n${r.stdout.slice(0, 600)}`);
    assert.match(r.stdout, /^\d+ elements from sample_patent_claim\.txt, split by CodeExam/m);
    assert.equal((r.stdout.match(/^\d+ mechanism entries of \.demo/gm) || []).length, 1, 'what was ranked prints once');
    const lines = r.stdout.trimEnd().split('\n');
    assert.match(lines[lines.length - n - 1], /^\s?#  element\s+nearest\s+margin  note$/, 'the table header above n rows (the # column right-aligns under two-digit numbers)');
    assert.match(lines[lines.length - 1], new RegExp(`^${n}  `), 'the last row is the last element');
    assert.match(r.stdout, /on an index of only 34 entries the band under-calls/, 'the demo is a small index');
  });

  const JINA = path.join(ROOT, 'models', 'jina-embeddings-v2-base-code-q8_0.gguf');
  it('end to end under two models: each loads once, the listings per model, one comparison table with a margin column per model and the agreement line', { skip: canRun && fs.existsSync(JINA) ? false : 'needs the nomic and jina GGUFs, .demo/mechanisms.json and sample_patent_claim.txt' }, () => {
    const r = spawnSync(process.execPath, ['src/index.js', '--ndx', '.demo', '--embed-distance', '@sample_patent_claim.txt', '--embed-model', 'nomic,jina', '--max-results', '1'], { cwd: ROOT, encoding: 'utf8', timeout: 300000 });
    assert.equal(r.status, 0, (r.stderr || '').slice(-800));
    assert.equal((r.stderr.match(/^# loading /gm) || []).length, 2, 'two model loads');
    assert.match(r.stdout, /^2 models in turn: nomic, jina$/m);
    assert.equal((r.stdout.match(/^model /gm) || []).length, 2);
    assert.equal((r.stdout.match(/^element 1 of \d+: /gm) || []).length, 2, 'the first element listed under each model');
    assert.match(r.stdout, /the band is calibrated on nomic and not read under jina\)$/m);
    assert.match(r.stdout, /^\s?#  element\s+nomic margin\s+jina margin$/m, 'the comparison header');
    assert.match(r.stdout, /^jina: nearest agrees with nomic's on \d+ of \d+ elements$/m);
    assert.doesNotMatch(r.stdout, /^\s?#  element\s+nearest/m, 'no single-model table');
  });
});

describe('embedModelRows: the registry as a listing', () => {
  it('gives one row per known model, with its file, prefixes and source, and whether the file is there', async () => {
    const { embedModelRows, EMBED_MODELS, DEFAULT_EMBED_MODEL } = await import('../src/core/embed.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embed-list-'));
    fs.writeFileSync(path.join(dir, EMBED_MODELS.jina.file), '');
    const rows = embedModelRows({ modelsDir: dir });
    assert.deepEqual(rows.map((r) => r.name), Object.keys(EMBED_MODELS));
    assert.equal(rows.find((r) => r.name === 'jina').installed, true);
    assert.equal(rows.find((r) => r.name === 'nomic').installed, false);
    assert.equal(rows.find((r) => r.name === DEFAULT_EMBED_MODEL).isDefault, true);
    assert.equal(rows.find((r) => r.name === 'nomic').query, 'search_query: ');
    assert.ok(rows.every((r) => r.file && r.source));
  });
});

describe('EmbeddingGemma in the registry', () => {
  it('gemma and gemma-search are one file with the two query tasks of the model card, and the document prompt', async () => {
    const { EMBED_MODELS } = await import('../src/core/embed.js');
    assert.equal(EMBED_MODELS.gemma.file, EMBED_MODELS['gemma-search'].file);
    assert.equal(EMBED_MODELS.gemma.query, 'task: code retrieval | query: ');
    assert.equal(EMBED_MODELS['gemma-search'].query, 'task: search result | query: ');
    assert.equal(EMBED_MODELS.gemma.doc, 'title: none | text: ');
  });
  it('installed skips a model the bundled runtime cannot load, and runs a shared file once', async () => {
    const { EMBED_MODELS } = await import('../src/core/embed.js');
    const { resolveEmbedModels } = await import('../src/commands/embed-distance.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embed-gemma-'));
    for (const n of ['nomic', 'gemma', 'gemma2']) fs.writeFileSync(path.join(dir, EMBED_MODELS[n].file), '');
    assert.ok(EMBED_MODELS.gemma2.unsupported, 'gemma2 is marked as not loading');
    assert.deepEqual(resolveEmbedModels('installed', { modelsDir: dir }).map((m) => m.name), ['nomic', 'gemma']);
    assert.deepEqual(resolveEmbedModels('gemma2', { modelsDir: dir }).map((m) => m.name), ['gemma2'], 'named outright, it is still tried');
  });
});

describe('--function-text: an entry scored by its label and its best member function together', () => {
  const fnIdx = { 'src/a.js': { parseTerms: { start: 1, end: 2 }, other: { start: 3, end: 4 } }, 'src\\b.js': { 'B::run': { start: 1, end: 2 } } };
  const lines = { 'src/a.js': ['// split the list', 'function parseTerms() { return splitList(); }', 'function other() {', '}'], 'src\\b.js': ['run() {', '}'] };

  it('parses --function-text as a flag, off by default', () => {
    assert.equal(withArgv(['--embed-distance', 'x', '--function-text'], () => parseArgs()).function_text, true);
    assert.equal(withArgv(['--embed-distance', 'x'], () => parseArgs()).function_text, false);
  });

  it('functionTexts gives each entry its members the index has as functions, one text per function', async () => {
    const { functionTexts } = await import('../src/commands/embed-distance.js');
    const { buildCorpus } = await import('../src/core/function-text.js');
    const corpus = buildCorpus(fnIdx, (f) => lines[f]);
    const entries = [
      { label: 'one', members: [{ file: 'src/a.js', name: 'parseTerms' }, { file: 'src/a.js', name: 'gone' }] },
      { label: 'two', members: [{ file: 'src\\b.js', name: 'B::run' }, { file: 'src/a.js', name: 'parseTerms' }] },
      { label: 'none', members: [] },
    ];
    const plan = functionTexts(entries, corpus);
    assert.deepEqual(plan.ids, [['src/a.js@parseTerms'], ['src/b.js@B::run', 'src/a.js@parseTerms'], []]);
    assert.deepEqual(plan.texts.map((t) => t.key), ['src/a.js@parseTerms', 'src/b.js@B::run'], 'a function in two entries is one text');
    assert.equal(plan.short.get('src/b.js@B::run'), 'b.js@B::run', 'what a row prints after via');
    assert.ok(plan.texts[0].text.startsWith('parse terms'), plan.texts[0].text);
    assert.ok(plan.texts[0].text.includes('split the list'), 'the comments form carries the comment');
  });

  it('rankFused weighs 0.3 on the label and 0.7 on the best function, and names the function that scored', async () => {
    const { rankFused } = await import('../src/commands/embed-distance.js');
    const { FUSE_LABEL_WEIGHT } = await import('../src/core/function-text.js');
    assert.equal(FUSE_LABEL_WEIGHT, 0.3);
    const q = [1, 0];
    const cands = [
      { label: 'label wins alone', members: [], vectors: [[0.8, 0.6]], chunks: ['c'], fnIds: ['f1'] },
      { label: 'function wins', members: [], vectors: [[0.6, 0.8]], chunks: ['c'], fnIds: ['f1', 'f2'] },
      { label: 'no function text', members: [], vectors: [[0.7, 0.714]], chunks: ['c'], fnIds: [] },
      { label: 'function not embedded', members: [], vectors: [[0.5, 0.866]], chunks: ['c'], fnIds: ['missing'] },
    ];
    const fnVecs = new Map([['f1', [0.2, 0.98]], ['f2', [1, 0]]]);
    const r = rankFused(q, cands, fnVecs);
    assert.deepEqual(r.map((x) => x.label), ['function wins', 'no function text', 'function not embedded', 'label wins alone']);
    assert.ok(Math.abs(r[0].cos - (0.3 * 0.6 + 0.7 * 1)) < 1e-9);
    assert.equal(r[0].fn, 'f2');
    assert.equal(r[1].cos, 0.7, 'an entry with no function text keeps its label cosine');
    assert.equal(r[1].fn, null);
    assert.equal(r[2].cos, 0.5, 'so does one whose functions have no vector');
    assert.ok(Math.abs(r[3].cos - (0.3 * 0.8 + 0.7 * 0.2)) < 1e-9);
    assert.deepEqual(r.map((x) => x.rank), [1, 2, 3, 4]);
  });

  it('a fused row says score, both cosines and via file@function; the listing says the band is not read', async () => {
    const { rankFused } = await import('../src/commands/embed-distance.js');
    const cands = [
      { label: 'alpha', members: [{ name: 'run' }], vectors: [[0.6, 0.8]], chunks: ['c'], fnIds: ['src/a.js@run'] },
      { label: 'beta', members: [], vectors: [[0.5, 0.866]], chunks: ['c'], fnIds: [] },
    ];
    const r = rankFused([1, 0], cands, new Map([['src/a.js@run', [1, 0]]]));
    assert.equal(rowHeader(1, { fused: true }), 'rank   score   label  function  entry');
    assert.equal(formatRow(r[0], 1),            '  1.  0.8800  0.6000    1.0000  alpha  (1 fn)  via src/a.js@run');
    assert.equal(formatRow(r[1], 1),            '  2.  0.5000  0.5000      none  beta  (0 fn)', 'an entry with no function text says none under function');
    const long = 'media.zip!media/libraries/exoplayer/src/main/java/androidx/AdaptiveTrackSelection.java@AdaptiveTrackSelection::enable';
    const s = rankFused([1, 0], [{ label: 'gamma', members: [], vectors: [[0.6, 0.8]], chunks: ['c'], fnIds: [long] }], new Map([[long, [1, 0]]]), 0.3, new Map([[long, 'AdaptiveTrackSelection.java@AdaptiveTrackSelection::enable']]));
    assert.equal(s[0].fn, long, 'the full id is kept on the row');
    assert.ok(formatRow(s[0], 1).endsWith('via AdaptiveTrackSelection.java@AdaptiveTrackSelection::enable'), 'the row prints the base name and the function');
    const many = Array.from({ length: 12 }, (_, i) => ({ label: 'e' + i, members: [], vectors: [[0.4, 0.9165]], chunks: ['c'], fnIds: [] }));
    const L = renderListing({ query: 'q', what: 'w', ranked: rankFused([1, 0], [...cands, ...many], new Map()), top: 3, filter: null, verbose: false, fused: true });
    assert.ok(L[1].includes('median score'), L[1]);
    assert.ok(L[1].includes('not read under --function-text'), L[1]);
    assert.ok(!L.some((l) => l.startsWith('no clear match') || l.startsWith('borderline')), 'no band note under the fused score');
    assert.equal(L[3], 'rank   score   label  function  entry', 'the fused listing names its four columns once');
    const plain = renderListing({ query: 'q', what: 'w', ranked: rankCandidates([1, 0], cands), top: 3, filter: null, verbose: false });
    assert.ok(plain[1].includes('median cosine'));
    assert.equal(plain[3], 'rank  cosine  entry');
  });

  // embed-distance-output-notes (2026-11-19)
  it('--summary-top: the closing table shows the runners-up on their own lines under the element, each with its margin, and the filter column only on the first', () => {
    const rows = [
      { n: 1, element: 'a first part', nearest: '[class] Top', margin: 0.295, word: '', filterRank: 2, next: [{ nearest: '[file] second.js', margin: 0.21 }, { nearest: '[cmd] --third', margin: 0.1834 }] },
      { n: 2, element: 'a second part', nearest: 'c3', margin: 0.02, word: 'no clear match', filterRank: null, next: [{ nearest: 'c4', margin: null }] },
    ];
    const t = renderSummary(rows, { filter: 'go' });
    assert.equal(t.length, 6, 'header, element 1 and two more, element 2 and one more');
    assert.match(t[1], /^1  a first part\s+\[class\] Top\s+0\.295\s+2$/, t[1]);
    assert.match(t[2], /^\s+\[file\] second\.js\s+0\.210$/, t[2]);
    assert.match(t[3], /^\s+\[cmd\] --third\s+0\.183$/, t[3]);
    assert.equal(t[2].indexOf('[file] second.js'), t[1].indexOf('[class] Top'), 'a runner-up sits in the nearest column');
    assert.match(t[4], /^2  a second part\s+c3\s+0\.020  no clear match\s+none$/, t[4]);
    assert.match(t[5], /^\s+c4$/, 'a blank margin for a list too short for a median');
    assert.equal(renderSummary(rows.map(({ next, ...r }) => r), { filter: 'go' }).length, 3, 'without next, one row per element as before');
  });

  it('parses --summary-top as a number, absent by default, and refuses 0 in one line, exit 2, before any model loads', () => {
    assert.equal(withArgv(['--embed-distance', '@claim.txt', '--summary-top', '3'], () => parseArgs()).summary_top, 3);
    assert.equal(withArgv(['--embed-distance', 'x'], () => parseArgs()).summary_top, null);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--embed-distance', 'x', '--against', 'y', '--summary-top', '0'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--summary-top takes a whole number of 1 or more/);
    assert.equal(r.stdout.trim(), '');
  });

  it('refuses --function-text with --against, in one line, exit 2', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--embed-distance', 'x', '--against', 'y', '--function-text'], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('--function-text') && r.stderr.includes('--against'), r.stderr);
    assert.equal(r.stdout.trim(), '');
  });

  it('embedAll with a notice says what will be embedded and where, nothing when all is cached, and can store compactly', async () => {
    const { embedEta } = await import('../src/core/embed.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-embed-notice-'));
    const file = path.join(dir, 'v.json');
    const ctx = { getEmbeddingFor: async (t) => ({ vector: [t.length, 1] }) };
    const texts = [{ key: 'a', text: 'one' }, { key: 'b', text: 'three' }];
    const said = [];
    const w = process.stderr.write;
    process.stderr.write = (s) => { said.push(String(s)); return true; };
    try {
      const m = await embedAll(ctx, texts, file, { quiet: true, notice: 'function texts', compact: true });
      assert.equal(m.size, 2);
      assert.equal(said.length, 1);
      assert.ok(said[0].startsWith('# embedding 2 function texts, saved to ' + file), said[0]);
      said.length = 0;
      const again = await embedAll(ctx, texts, file, { quiet: true, notice: 'function texts', compact: true });
      assert.deepEqual(said, [], 'silent when every vector is cached');
      assert.ok(Math.abs(again.get('a')[0] - m.get('a')[0]) < 1e-6, 'the compact store reads back');
    } finally { process.stderr.write = w; }
    assert.equal(typeof readCache(file).items.a.b, 'string', 'base64, not an array');
    assert.equal(embedEta(40), '40 s');
    assert.equal(embedEta(200), '3 min');
    assert.equal(embedEta(4800), '80 min');
    assert.equal(embedEta(8400), '2 h 20 min');
  });
});

describe('--toward-code: the elements reworded toward the index\'s names, ranked by the rewording', () => {
  const cands = [
    { label: 'alpha', members: [{ name: 'run' }], vectors: [[0.6, 0.8]], chunks: ['c'] },
    ...Array.from({ length: 12 }, (_, i) => ({ label: 'e' + i, members: [], vectors: [[0.4, 0.9165]], chunks: ['c'] })),
  ];

  it('parses --toward-code and --spec as values, absent by default', () => {
    const a = withArgv(['--embed-distance', '@claim.txt', '--toward-code', 'label', '--spec', 'spec.txt'], () => parseArgs());
    assert.equal(a.toward_code, 'label');
    assert.equal(a.spec, 'spec.txt');
    const b = withArgv(['--embed-distance', 'x'], () => parseArgs());
    assert.equal(b.toward_code, null);
    assert.equal(b.spec, null);
  });

  it('a listing prints the element as written, then "searched as:" and the rewording, and says the band is not read', () => {
    const L = renderListing({ query: 'a unit for doing a thing', what: 'w', ranked: rankCandidates([1, 0], cands), top: 3, filter: null, verbose: false, heading: 'element 1 of 2', searchedAs: 'compute the widget' });
    assert.equal(L[0], 'element 1 of 2: a unit for doing a thing');
    assert.equal(L[1], 'searched as: compute the widget');
    assert.ok(L[2].includes('median cosine') && L[2].includes('not read under --toward-code'), L[2]);
    assert.ok(!L.some((l) => l.startsWith('no clear match') || l.startsWith('borderline')), 'no band note under a rewording');
  });

  it('an element the model did not reword says so in place of the rewording; a run without the option has no such line', () => {
    const L = renderListing({ query: 'a unit', what: 'w', ranked: rankCandidates([1, 0], cands), top: 3, filter: null, verbose: false, searchedAs: 'a unit', notReworded: 'HTTP 529' });
    assert.equal(L[1], 'searched as written: not reworded (HTTP 529)');
    const plain = renderListing({ query: 'a unit', what: 'w', ranked: rankCandidates([1, 0], cands), top: 3, filter: null, verbose: false });
    assert.ok(plain[1].startsWith('w; median cosine'), plain[1]);
    assert.ok(!plain.some((l) => l.startsWith('searched as')));
  });

  it('refuses --toward-code with --against, and --spec without --toward-code, in one line, exit 2', () => {
    const a = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--embed-distance', 'x', '--against', 'y', '--toward-code', 'restate'], { encoding: 'utf8' });
    assert.equal(a.status, 2);
    assert.ok(a.stderr.includes('--toward-code') && a.stderr.includes('--against'), a.stderr);
    assert.equal(a.stdout.trim(), '');
    const b = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--embed-distance', 'x', '--against', 'y', '--spec', 'spec.txt'], { encoding: 'utf8' });
    assert.equal(b.status, 2);
    assert.ok(b.stderr.includes('--spec') && b.stderr.includes('--toward-code'), b.stderr);
    assert.equal(b.stdout.trim(), '');
  });

  it('id:m70 in place of the text measures from that mechanism: the id is read, found through a fold, its functions averaged, its block printed first, and the band not read', async () => {
    // embed-distance-rows-show-mechanism-id (2026-11-21). Red before it: `id:m70` was embedded as a text.
    const { mechanismQueryId, entryIndexById, meanVector, mechanismQueryBlock, rankFused } = await import('../src/commands/embed-distance.js');
    assert.equal(mechanismQueryId('id:m70'), 'm70');
    assert.equal(mechanismQueryId(' ID:M70 '), 'm70');
    for (const t of ['m70', 'id:70', 'id:m70 and more', 'the id:m70', '', null]) assert.equal(mechanismQueryId(t), null, `${t} is a text`);
    const entries = [{ id: 'm1', label: 'a', members: [] }, { id: 'm5', label: 'b', members: [], aliases: [{ id: 'm9', label: 'c' }] }];
    assert.equal(entryIndexById(entries, 'm5'), 1);
    assert.equal(entryIndexById(entries, 'm9'), 1, 'a record folded into another is found through it');
    assert.equal(entryIndexById(entries, 'm2'), -1);
    const vecs = new Map([['f', [2, 0]], ['g', [0, 5]]]);
    const mv = meanVector(['f', 'g', 'absent'], vecs);
    assert.ok(Math.abs(mv[0] - Math.SQRT1_2) < 1e-9 && Math.abs(mv[1] - Math.SQRT1_2) < 1e-9, 'each function counts once whatever its vector\'s length, and the mean is a unit vector');
    assert.equal(meanVector(['absent'], vecs), null);
    const entry = { id: 'm5', label: '[file] a.js', description: 'Does a thing.', files: ['src/a.js'], tags: [], members: [{ file: 'src/a.js', name: 'run', start: 3, end: 9 }] };
    const B = mechanismQueryBlock(entry, '[file] a.js: run', { generated: '2026-11-10T08:00:00Z' }, 'm9');
    assert.match(B[0], /^Measured from mechanism m9 \(folded into m5: the same functions under another label\), as recorded in the mechanisms file built 2026-11-10\./);
    assert.ok(B.includes('  m5    Does a thing.'), B.join('\n'));
    assert.ok(B.includes('        src/a.js@run  (L3–9)'), 'every member, as --mechanisms -v prints it');
    assert.equal(B[B.length - 1], '  its label and member names, the text it is compared by: [file] a.js: run');
    assert.doesNotMatch(mechanismQueryBlock(entry, 't', {}, 'm5')[0], /folded/);
    // the function part of the score is ranked by the second query vector
    const cands = [
      { label: 'x', members: [], entry: { id: 'm2' }, vectors: [[1, 0]], chunks: ['x'], fnIds: ['f'] },
      { label: 'y', members: [], entry: { id: 'm3' }, vectors: [[1, 0]], chunks: ['y'], fnIds: ['g'] },
    ];
    assert.equal(rankFused([1, 0], cands, vecs, 0.3, null, [0, 1])[0].label, 'y', 'the label vector ties the two; the function vector [0, 1] picks g');
    assert.equal(rankFused([1, 0], cands, vecs, 0.3)[0].label, 'x', 'without it one vector serves both parts, as before');
    const L = renderListing({ query: 'm5 [file] a.js', what: 'w', ranked: rankCandidates([1, 0], cands), top: 5, filter: null, verbose: false, fromMechanism: true });
    assert.equal(L[0], 'from mechanism: m5 [file] a.js');
    assert.ok(!L.some((l) => /^no clear match|^borderline/.test(l)), 'the band is not read for a mechanism as the query');
  });

  const hasDemo = fs.existsSync(path.join(ROOT, '.demo', 'mechanisms.json'));
  it('id:<mechanism> stops in one line, before a model loads, for an id the index does not have, and when given with --against', { skip: hasDemo ? false : 'needs the .demo index with its mechanisms.json' }, () => {
    const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), ...a], { encoding: 'utf8' });
    const a = cli('--ndx', path.join(ROOT, '.demo'), '--embed-distance', 'id:m99999');
    assert.equal(a.status, 2, a.stderr);
    assert.match(a.stderr, /has no mechanism m99999\. Its mechanisms file, built \S+, holds \d+ records; --mechanisms <filter> and --toc <filter> show each row's id\./);
    assert.doesNotMatch(a.stderr, /# loading/, 'no model was loaded');
    assert.equal(a.stdout.trim(), '');
    const b = cli('--ndx', path.join(ROOT, '.demo'), '--embed-distance', 'id:m1', '--against', 'y');
    assert.equal(b.status, 2, b.stderr);
    assert.match(b.stderr, /id:m1 measures from one mechanism of an index to the index's other mechanisms, and --against gives texts/);
    const c = cli('--ndx', path.join(ROOT, '.demo'), '--semantic-search', 'id:m99999');
    assert.equal(c.status, 2, c.stderr);
    assert.match(c.stderr, /--semantic-search: .* has no mechanism m99999\./);
    assert.doesNotMatch(c.stderr, /# loading/, 'no model was loaded');
  });
});
