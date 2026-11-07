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
import { parseArgs } from '../src/argparse.js';
import { EMBED_MODELS, DEFAULT_EMBED_MODEL, resolveEmbedModel, entryChunks, embedAll, COMPACT_ABOVE_DIMS, readCache } from '../src/core/embed.js';
import { readCandidateList, embedCacheFile, rankCandidates, filterRanked, formatRow, renderListing, CHUNK } from '../src/commands/embed-distance.js';

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
});
