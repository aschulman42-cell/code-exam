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
import { readCandidateList, embedCacheFile, rankCandidates, filterRanked, formatRow, renderListing, CHUNK, resolveQueries, bandWord, listingStats, renderSummary, resolveEmbedModels, bandCalibrated, renderComparison, SMALL_INDEX } from '../src/commands/embed-distance.js';
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
    assert.throws(() => resolveEmbedModel('bogus', { modelsDir: dir }), /takes one of nomic, jina, coderank, qwen06, qwen4 or a path/);
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

  it('ranks by the best chunk, keeps ranks under --filter and names the member that matched, and formats the row as rank, cosine, distance, candidate', () => {
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
    assert.match(row, /^ 2\. cosine 0\.5000  distance 0\.5000  \[file\] Builder \/ rate  \(1 fn\)$/);
    assert.match(formatRow(ranked[0], 2, { verbose: true }), /\n    chunk: chunk two$/);
    const kept = filterRanked(ranked, 'determineideal');
    assert.equal(kept.length, 1);
    assert.equal(kept[0].rank, 1, 'the overall rank is kept');
    assert.deepEqual(kept[0].holds, ['AdaptiveTrackSelection::determineIdealSelectedIndex']);
    assert.match(formatRow(kept[0], 2), /\(2 fn\)  holds AdaptiveTrackSelection::determineIdealSelectedIndex$/);
    const lines = renderListing({ query: 'q', what: '3 candidates', ranked, top: 2, filter: null, verbose: false });
    assert.equal(lines[0], 'query: q');
    assert.match(lines[1], /^3 candidates; median cosine 0\.5000$/);
    assert.equal(lines.length, 5, 'header, median, blank, two rows');
    const filtered = renderListing({ query: 'q', what: '3 candidates', ranked, top: Infinity, filter: 'rate', verbose: false });
    assert.match(filtered[2], /^--filter "rate": 1 of 3 match$/);
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
    assert.match(lines[0], /^ 1\. cosine 1\.0000  distance 0\.0000  \[class\] AdaptiveTrackSelection \/ other  \(2 fn\)$/);
    assert.equal(lines[1], '    m9    Picks the track.');
    assert.equal(lines[2], '          [class] AdaptiveTrackSelection / other  (2 fns, 1 file)  [giant]');
    assert.equal(lines[3], '          a/Adaptive.java@AdaptiveTrackSelection::determineIdealSelectedIndex  (L10–48)', 'a member with a range');
    assert.equal(lines[4], '          a/Adaptive.java@AdaptiveTrackSelection::updateSelectedTrack', 'a member without one prints as before');
    assert.equal(lines[5], '    chunk: chunk two', 'the chunk line closes the block');
    assert.equal(lines.length, 6);
    assert.equal(formatRow(ranked[1], 2, { verbose: true }), ' 2. cosine 0.0000  distance 1.0000  a plain candidate', 'no block for a text candidate');
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
    assert.match(other[3], /^\s*1\. cosine/, 'the rows follow the blank line directly');
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
