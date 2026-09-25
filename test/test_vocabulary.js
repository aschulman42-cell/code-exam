// test_vocabulary.js — vocabulary corpus: noise-doc exclusion, cross-corpus weights, claim-filter guards
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Coverage for #172: the vocabulary corpus excludes vendored / binary-decompiled
// (.op) / minified files so their lexically-dense, domain-meaningless tokens
// don't swamp TF-IDF and bury real domain terms. Unit-tests the _isNoiseDoc
// gate (the files stay indexed and searchable — only vocabulary skips them).
import { test } from 'node:test';
import assert from 'node:assert';
import { _isNoiseDoc } from '../src/core/vocabulary.js';

const NORMAL = 'def handle(req):\n    return deploy(req)\n';

test('excludes vendored / dependency / generated trees', () => {
  for (const p of [
    'node_modules/aws-sdk/dist/s3.js',
    'project/site-packages/numpy/core/_methods.py',
    'app/vendor/foo/bar.rb',
    'x/bower_components/jquery/jquery.js',
    'svc/.venv/lib/python3.11/site-packages/x.py',
    'web/dist/bundle.js',
    'pkg/build/output.js',
  ]) {
    assert.equal(_isNoiseDoc(p, NORMAL), true, `should skip ${p}`);
  }
});

test('handles Windows backslash separators', () => {
  assert.equal(_isNoiseDoc('app\\node_modules\\pkg\\index.js', NORMAL), true);
});

test('excludes .op binstring / decompile dumps (case-insensitive)', () => {
  assert.equal(_isNoiseDoc('src/EntityFramework.dll.op', 'AssemblyInformationalVersionAttribute'), true);
  assert.equal(_isNoiseDoc('src/Thing.DLL.OP', 'x'), true);
});

test('excludes .NET build output (bin/Debug, bin/Release, obj) and NuGet archives', () => {
  assert.equal(_isNoiseDoc('App.Models/bin/Debug/EntityFramework.xml', 'x'), true);
  assert.equal(_isNoiseDoc('App/bin/Release/Foo.dll', 'x'), true);
  assert.equal(_isNoiseDoc('App/obj/Debug/App.csproj.nuget.g.props', 'x'), true);
  assert.equal(_isNoiseDoc('EntityFramework.6.4.4.nupkg!lib/net45/EntityFramework.xml', 'x'), true);
  // a normal "bin/" that is not Debug/Release build output is kept
  assert.equal(_isNoiseDoc('project/bin/run.sh', '#!/bin/sh\n'), false);
});

test('excludes dependency lockfiles (integrity-hash soup)', () => {
  assert.equal(_isNoiseDoc('chapter11/src/package-lock.json', '{"x":1}'), true);
  assert.equal(_isNoiseDoc('app/yarn.lock', 'x'), true);
  assert.equal(_isNoiseDoc('svc/Cargo.lock', 'x'), true);
  // package.json itself is real, not a lockfile
  assert.equal(_isNoiseDoc('app/package.json', '{"name":"x"}'), false);
});

test('excludes minified bundles via isMinified (content-based)', () => {
  // One very long line → average line length far above the minified threshold.
  const minified = 'var a=' + 'x'.repeat(3000) + ';';
  assert.equal(_isNoiseDoc('public/swagger-ui.js', minified), true);
});

test('#172 residual (a): excludes test / example / fixture trees', () => {
  for (const p of [
    'test/k6/har-session.js',          // the reported test-hash source
    'project/tests/fixtures/cert.pem',
    'src/__tests__/foo.test.js',
    'app/spec/models/user_spec.rb',
    'web/specs/e2e/login.js',
    'pkg/examples/demo.py',
    'lib/example/sample.js',
    'svc/fixtures/data.json',
    'app\\tests\\windows\\sep.js',     // Windows separators
  ]) {
    assert.equal(_isNoiseDoc(p, NORMAL), true, `should skip ${p}`);
  }
  // segment-anchored: "test"/"example"/"spec" inside a longer segment is kept
  assert.equal(_isNoiseDoc('src/mytest_helper.py', NORMAL), false);
  assert.equal(_isNoiseDoc('src/latest/config.js', NORMAL), false);
  assert.equal(_isNoiseDoc('app/specimen/data.py', NORMAL), false);
});

test('keeps ordinary source files (the signal we want to surface)', () => {
  assert.equal(_isNoiseDoc('src/deploy/kubernetes.py', NORMAL), false);
  assert.equal(_isNoiseDoc('terraform/main.tf', 'resource "aws_s3_bucket" "b" {}'), false);
  // a path that merely contains "build" as a non-segment substring is not vendored
  assert.equal(_isNoiseDoc('src/buildPipeline.js', NORMAL), false);
  // null content (no minified check possible) still passes a clean path
  assert.equal(_isNoiseDoc('src/app.js', null), false);
});

// ---------------------------------------------------------------------------
// #180: cross-corpus down-weighting. _crossCorpusWeight demotes (never deletes)
// corpus-universal tokens; buildCrossCorpusCatalog tallies token document-
// frequency across distinct indexes.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _crossCorpusWeight, _subtokenCrossCorpusWeight, buildCrossCorpusCatalog, extractConcepts } from '../src/core/vocabulary.js';

test('#180 _crossCorpusWeight: no catalog / rare tokens are never penalized', () => {
  assert.equal(_crossCorpusWeight('anything', null), 1);
  const cat = { index_count: 33, tokens: { foo: 1, bar: 0 } };
  assert.equal(_crossCorpusWeight('foo', cat), 1);     // df < 2
  assert.equal(_crossCorpusWeight('missing', cat), 1); // df 0 (not in catalog)
});

test('#180 _crossCorpusWeight: universal tokens floored at 0.1, monotonic in df', () => {
  const cat = { index_count: 33, tokens: { univ: 33, common: 17, niche: 3, pair: 2 } };
  const wUniv = _crossCorpusWeight('univ', cat);
  const wCommon = _crossCorpusWeight('common', cat);
  const wNiche = _crossCorpusWeight('niche', cat);
  const wPair = _crossCorpusWeight('pair', cat);
  assert.equal(wUniv, 0.1);                                          // every index -> floor
  assert.ok(wUniv < wCommon && wCommon < wNiche && wNiche < wPair);  // more universal -> lower
  assert.ok(wPair <= 1 && wPair > wNiche);                           // demote, never boost
});

test('#180 buildCrossCorpusCatalog: tallies df, drops singletons, counts skips', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xcorpus-'));
  const mk = (name, tokens) => {
    const d = path.join(root, name);
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'vocabulary.json'),
      JSON.stringify({ tokens: Object.fromEntries(tokens.map(t => [t, {}])) }));
    return d;
  };
  const a = mk('a', ['shared', 'common', 'onlyA']);
  const b = mk('b', ['shared', 'common']);
  const c = mk('c', ['shared']);
  const missing = path.join(root, 'no-such-dir');
  const cat = buildCrossCorpusCatalog([a, b, c, missing]);
  assert.equal(cat.index_count, 3);
  assert.equal(cat.skipped, 1);                 // missing dir skipped, not counted
  assert.equal(cat.tokens.shared, 3);
  assert.equal(cat.tokens.common, 2);
  assert.equal('onlyA' in cat.tokens, false);   // df < 2 dropped (pure bloat)
  assert.equal(cat.subtokens.shared, 3);        // #193: sub-tokens tallied too
  fs.rmSync(root, { recursive: true, force: true });
});

test('#193 _subtokenCrossCorpusWeight: universal sub-tokens demote, distinctive keep ~1', () => {
  const cat = { index_count: 28, subtokens: { function: 26, build: 24, multisect: 1, worklist: 0 } };
  assert.equal(_subtokenCrossCorpusWeight('function', cat), 0.1);   // ~all corpora -> floor
  assert.ok(_subtokenCrossCorpusWeight('build', cat) < 0.3);
  assert.equal(_subtokenCrossCorpusWeight('multisect', cat), 1);     // df < 2 -> no penalty
  assert.equal(_subtokenCrossCorpusWeight('worklist', cat), 1);
  assert.equal(_subtokenCrossCorpusWeight('x', null), 1);            // no catalog -> 1
});

test('#193 extractConcepts: cross-corpus IDF drops universal parts, keeps distinctive roots', () => {
  // Injected catalog (no disk read). df >= 0.6*N (=6) is hard-dropped.
  const catalog = { index_count: 10, subtokens: { build: 9, index: 10, prompt: 8, multisect: 1, worklist: 0 } };
  const entries = [
    { token: 'buildMultisectIndex', score: 100 },
    { token: 'worklistPrompt', score: 80 },
  ];
  const concepts = extractConcepts(null, { catalog, entries });
  const names = concepts.map(c => c.concept);
  assert.ok(names.includes('multisect'), `got: ${names.join(',')}`); // df 1 -> kept
  assert.ok(names.includes('worklist'));                             // df 0 -> kept
  assert.ok(!names.includes('build'));   // df 9 >= 6 -> dropped
  assert.ok(!names.includes('index'));   // df 10 -> dropped
  assert.ok(!names.includes('prompt'));  // df 8 -> dropped
  // #181 polish: each concept is grounded in the larger identifier it was split from
  assert.equal(concepts.find(c => c.concept === 'multisect').example, 'buildMultisectIndex');
  assert.equal(concepts.find(c => c.concept === 'worklist').example, 'worklistPrompt');
});

// ===========================================================================
// Concordance weighting (#193 port, negotiated across two sessions —
// CONVERSATION_4.md). getVocabularyForPrompt emits sub-tokens split out of the
// top-N compounds; it applied the stopword list ALONE, so a morpheme recurring
// across boilerplate compounds outscored a rare domain noun and the emitted
// bridge vocabulary was almost pure boilerplate.
// ===========================================================================

import { getVocabularyForPrompt, MAX_TOKENS_PER_CLAIM_KEYWORD } from '../src/core/vocabulary.js';

// Minimal fake index: getTopVocabulary reads idx._vocabulary (token -> {score}).
function fakeIdx(tokens) {
  const v = new Map(Object.entries(tokens).map(([t, score]) => [t, { score, top_files: [] }]));
  return { _vocabulary: v, _ensureVocabulary() {}, vocabulary: v };
}

test('concordance: cross-corpus weighting demotes universal morphemes', () => {
  // `check` is in ~96% of catalogued corpora, `bitrate` in 0%. Given parents of
  // equal score, the rare domain noun must now outrank the universal morpheme.
  const cat = JSON.parse(fs.readFileSync('src/CE_cross_corpus_vocab_catalog.json', 'utf-8'));
  const w = (t) => _subtokenCrossCorpusWeight(t, cat);
  assert.ok(w('bitrate') > w('check'),
    'a corpus-rare domain noun must weigh more than a near-universal morpheme');
});

test('concordance: a high-df domain term is NOT hard-dropped', () => {
  // THE REGRESSION GUARD. extractConcepts hard-drops sub-tokens present in
  // >=60% of catalogued corpora — correct there, lethal here: it removes
  // `track` (75%), `selection` (79%), `stream` (89%), `buffer` (79%), which are
  // the bridge vocabulary this concordance exists to supply. Measured, adding
  // that drop took domain-term coverage from 5/9 to 1/9.
  const idx = fakeIdx({
    AdaptiveTrackSelection: 1000,
    DecoderInputBuffer: 900,
    checkNotNull: 800,
  });
  const { subTokens } = getVocabularyForPrompt(idx, { topN: 100, maxSubTokens: 50, maxFuncNames: 0 });
  const emitted = new Set(subTokens.map((s) => String(s.token).toLowerCase()));
  assert.ok(emitted.has('track'), '`track` (df 75%) must survive — no hard-drop here');
  assert.ok(emitted.has('buffer'), '`buffer` (df 79%) must survive');
});

// ===========================================================================
// #301 claim-filter guards. The filter scored a CODE token by its lexical
// similarity to the CLAIM's words — selecting for the one property the bridge
// exists to cross. Measured on US 8,752,101 vs ExoPlayer: `code` bought 26 of
// 80 slots in morphological debris while `track`/`buffer`/`stream` scored 0.0
// and were dropped, and `track` is load-bearing.
// ===========================================================================

test('claim filter: one keyword cannot buy more than the cap', () => {
  // `code` earned 26 slots via av1codec/vp9codec/aomediacodec/utf8encoded/…
  const idx = fakeIdx({
    Av1CodecConfig: 900, Vp9CodecWrapper: 880, AoMediaCodecTool: 860,
    Utf8EncodedReader: 840, HashCodeBuilder: 820, DecodesFrames: 800,
    AdaptiveTrackSelection: 500, DecoderInputBuffer: 480, SampleStreamReader: 460,
  });
  // Measure the CAP'S OWN SCOPE: the relevance half. The reserved half is
  // relevance-blind by design, so `codec`/`decoder` legitimately arrive there
  // on vocabulary score — counting those against the cap measures the wrong
  // thing. The additions a claim keyword BUYS are exactly the terms present
  // when filtering and absent when not.
  const opts = { topN: 100, maxSubTokens: 40, maxFuncNames: 0 };
  const unfiltered = new Set(getVocabularyForPrompt(idx, opts)
    .subTokens.map((s) => String(s.token).toLowerCase()));
  const filtered = getVocabularyForPrompt(idx, { ...opts, claimKeywords: new Set(['code']) })
    .subTokens.map((s) => String(s.token).toLowerCase());
  const bought = filtered.filter((t) => !unfiltered.has(t));
  assert.ok(bought.length <= MAX_TOKENS_PER_CLAIM_KEYWORD,
    `one keyword bought ${bought.length} slots (cap ${MAX_TOKENS_PER_CLAIM_KEYWORD}): ${bought.join(',')}`);
});

test('claim filter: domain terms with ZERO claim relevance still ship', () => {
  // THE REGRESSION GUARD. `track`/`buffer`/`stream` share no stem with
  // patent-ese, so relevance-ranking can never reach them — no threshold makes
  // `track` resemble `transmission`. The reserved share is what restores them.
  const idx = fakeIdx({
    AdaptiveTrackSelection: 1000, DecoderInputBuffer: 950, SampleStreamReader: 900,
    TransmissionDeviceConfig: 800, ReceptionDeviceHandler: 780,
  });
  const { subTokens } = getVocabularyForPrompt(idx, {
    topN: 100, maxSubTokens: 40, maxFuncNames: 0,
    claimKeywords: new Set(['transmission', 'reception', 'device']),
  });
  const emitted = new Set(subTokens.map((s) => String(s.token).toLowerCase()));
  for (const t of ['track', 'buffer', 'stream']) {
    assert.ok(emitted.has(t), `${t} has 0 claim relevance and must still ship`);
  }
});

test('claim filter: a claim word that IS a good code term is NOT banned', () => {
  // A third guard ("never echo a claim keyword") was tried and REMOVED: on the
  // TLS demo corpus, where claim and code vocabulary genuinely overlap, it
  // deleted cipher/certificate/handshake/hostname/chain/suite and took domain
  // coverage 7/9 -> 2/9. Whether a claim word is also a code term is a property
  // of the corpus, not the claim.
  const idx = fakeIdx({
    CipherSuiteNegotiator: 1000, CertificateChainVerifier: 950, HandshakeProtocol: 900,
  });
  const { subTokens } = getVocabularyForPrompt(idx, {
    topN: 100, maxSubTokens: 40, maxFuncNames: 0,
    claimKeywords: new Set(['cipher', 'certificate', 'handshake']),
  });
  const emitted = new Set(subTokens.map((s) => String(s.token).toLowerCase()));
  for (const t of ['cipher', 'certificate', 'handshake']) {
    assert.ok(emitted.has(t), `${t} is both a claim word and a real code term — must ship`);
  }
});
