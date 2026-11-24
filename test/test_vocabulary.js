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

// ===========================================================================
// base64 / image-blob guard. `--overview` on a 65-notebook corpus listed
// NOTHING but matplotlib PNG data under "Potentially important concepts"
// (Andrew, 2026-09-30): base64 PNG blobs are LOW-entropy (repetitive AAAA...
// runs) so looksLikeRandomToken let them through, then they split into
// word-like fragments and the raw blob was reprinted as the example (#309
// shape). looksLikeBase64Blob now drops them in both filter sites.
// ===========================================================================
import { getTopVocabulary, looksLikeBase64Blob } from '../src/core/vocabulary.js';

const PNG_BLOB = 'iVBORw0KGgoAAAANSUhEUgAABdEAAATNCAYAAAC' + 'A'.repeat(220);

test('base64 guard: recognizes image/base64 blobs, spares real identifiers', () => {
  assert.ok(looksLikeBase64Blob(PNG_BLOB), 'a PNG-signature base64 blob must be recognized');
  assert.ok(looksLikeBase64Blob('QWxhZGRpbjpvcGVuc2VzYW1l' + 'Zm9vYmFy'.repeat(8)),
    'a long pure-base64 run must be recognized by shape');
  assert.ok(!looksLikeBase64Blob('AdaptiveTrackSelection'), 'a normal identifier must not be flagged');
  assert.ok(!looksLikeBase64Blob('this_is_a_very_long_snake_case_identifier_with_many_parts'),
    'a long snake_case name has a separator — not a blob');
  assert.ok(!looksLikeBase64Blob('iVBORw0KGgo'), 'too short to judge (< 64) — not flagged');
});

// vocab-filters-short-image-blob-and-separator-ids (2026-11-01). On Bram's
// `docs/agent-specimens/` fixtures, indexed with `.raw` and `.jsonl` added, the
// Overview listed `aaaeaaaabacaiaaa (iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC)`,
// `hdx (ses_e7a249155ffevCKHdxMhUNecCx)` and `nec (…)` as concepts. The PNG blob
// is 41 characters because the tokenizer cut it at its first `+` or `/`, and
// the 64-character gate ran BEFORE the signature test; the session id passed
// looksLikeRandomToken on its separator alone. Now the image signature is
// tested first (from 24 characters, the random test's own floor), and a token
// with a separator is judged on its longest separator-free part.
import { looksLikeRandomToken } from '../src/core/vocabulary.js';

test('base64 guard: a cut image blob under 64 characters is recognized by its signature', () => {
  assert.ok(looksLikeBase64Blob('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC'),
    'the 41-char PNG prefix from the Bram specimens must be recognized');
  assert.ok(looksLikeBase64Blob('R0lGODlhAQABAIAAAAAAAPAAAAAAAA'),
    'a 30-char GIF prefix must be recognized');
  assert.ok(!looksLikeBase64Blob('iVBORw0KGgo'), 'the bare 11-char signature stays unjudged');
  assert.ok(!looksLikeBase64Blob('QWxhZGRpbjpvcGVuc2VzYW1lZm9v'),
    'a short pure-base64 run without a signature keeps the 64-char gate');
});

test('random guard: a prefix_<base62> machine id is judged on its longest separator-free part', () => {
  assert.ok(looksLikeRandomToken('toolu_014MQqQJTFLMxLqCH8H6sGBR'),
    'a tool-use id from the Bram specimens must be withheld');
  assert.ok(!looksLikeRandomToken('uqDZmUu9Dvqcve5Zc_NZdJSmhxu2oSPdJ'),
    'parts under 24 characters are never examined');
  assert.ok(!looksLikeRandomToken('df_claim_train_1M_pre_duplicates_removed_663'),
    'a long snake_case identifier is untouched');
  assert.ok(!looksLikeRandomToken('debug_combined_output_with_allcites_icl_pdpass'),
    'a long snake_case identifier is untouched');
});

test('random guard: digits interleaved among letters at three or more points mark an encoded payload', () => {
  // Payloads whose letters are vowel-rich or lowercase-rich enough to pass the
  // density test: a session id, a git sha, a base64 chunk (all from the sweep
  // of 2026-11-01).
  assert.ok(looksLikeRandomToken('ses_e7a263769ffeAoFr5frD0w3TaC'), 'a vowel-rich session id');
  assert.ok(looksLikeRandomToken('afb212976052ab038df25d5e871f6c049e094d3b'), 'a git sha');
  assert.ok(looksLikeRandomToken('msg_185a3fc2b001OrPn0qSBchQYm3'), 'a message id');
  assert.ok(looksLikeRandomToken('AAAMSExpbm8CEAAAbW50clJHQiBYWVogB84AAgAJAAYAMQAAYWNz'), 'a base64 chunk');
  // Names attach digits to a word as a unit: two interior runs or fewer.
  assert.ok(!looksLikeRandomToken('kCVPixelFormatType_420YpCbCr10BiPlanarFullRangeExtended'),
    'a constant with a leading number and one interior run (vowel-rich enough for the density test)');
  assert.ok(!looksLikeRandomToken('validateCertificateChainWithRevocationCheck2024'),
    'a trailing year is not an interior run');
  assert.ok(!looksLikeRandomToken('OpenSSL_add_all_algorithms'));
  assert.ok(!looksLikeRandomToken('determineIdealSelectedIndexForTrackSelection'));
});

test('base64 guard: a matplotlib PNG blob never becomes a concept or example', () => {
  const entries = [
    { token: PNG_BLOB, score: 100000, top_files: [] },    // would dominate if not dropped
    { token: 'AdaptiveTrackSelection', score: 900, top_files: [] },
    { token: 'DecoderInputBuffer', score: 880, top_files: [] },
  ];
  const concepts = extractConcepts(null, { catalog: null, entries, maxConcepts: 20 });
  const label = concepts.map((c) => `${c.concept} ${c.example || ''}`).join(' ').toLowerCase();
  assert.ok(!/ivborw0|aaaa/.test(label), `no base64 fragment may surface as a concept/example: ${label}`);
  const names = new Set(concepts.map((c) => c.concept));
  assert.ok(names.has('track') || names.has('buffer') || names.has('decoder'),
    `real domain concepts must still surface alongside the dropped blob: ${[...names].join(',')}`);
});

test('base64 guard: getTopVocabulary withholds the blob, keeps the real token', () => {
  const idx = fakeIdx({ [PNG_BLOB]: 100000, AdaptiveTrackSelection: 900 });
  const top = getTopVocabulary(idx, 50).map((e) => e.token);
  assert.ok(!top.includes(PNG_BLOB), 'the base64 blob must be withheld from top vocabulary');
  assert.ok(top.includes('AdaptiveTrackSelection'), 'the real token must survive the filter');
});

// vocab-rewrite-to-embed-distance (2026-11-16): the prompt vocabulary from the cached
// vocabulary.json alone, for --embed-distance --toward-code, which runs before an index
// is constructed.
import { cachedVocabularyWords, VOCAB_CACHE_VERSION } from '../src/core/vocabulary.js';

test('cachedVocabularyWords: the same words a loaded index gives, read from vocabulary.json by path', () => {
  const tokens = { AdaptiveTrackSelection: 1000, DecoderInputBuffer: 900, checkNotNull: 800, bitrateEstimate: 700 };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-cache-'));
  const cache = { _version: VOCAB_CACHE_VERSION, _file_count: 12, _generated: '2026-11-01T00:00:00.000Z', tokens: Object.fromEntries(Object.entries(tokens).map(([t, score]) => [t, { score, top_files: [] }])) };
  fs.writeFileSync(path.join(dir, 'vocabulary.json'), JSON.stringify(cache));
  const opts = { topN: 15000, maxSubTokens: 150, maxFuncNames: 0 };
  const viaIndex = getVocabularyForPrompt(fakeIdx(tokens), opts).subTokens.map((s) => s.token);
  const r = cachedVocabularyWords(dir, opts);
  assert.deepEqual(r.words, viaIndex);
  assert.ok(r.words.includes('bitrate') && r.words.includes('track'), r.words.join(' '));
  assert.equal(r.fileCount, 12);
  assert.equal(r.generated, '2026-11-01T00:00:00.000Z');
});

test('cachedVocabularyWords: no cache, an unreadable one or another version names the command that writes it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-cache-none-'));
  assert.throws(() => cachedVocabularyWords(dir), /has no cached vocabulary \(vocabulary\.json\); write it with: ce --ndx .* --vocabulary/);
  fs.writeFileSync(path.join(dir, 'vocabulary.json'), '{ not json');
  assert.throws(() => cachedVocabularyWords(dir), /could not be read .*write it with: ce --ndx/);
  fs.writeFileSync(path.join(dir, 'vocabulary.json'), JSON.stringify({ _version: VOCAB_CACHE_VERSION - 1, tokens: { a: { score: 1 } } }));
  assert.throws(() => cachedVocabularyWords(dir), /empty or from another version of the vocabulary cache/);
  fs.writeFileSync(path.join(dir, 'vocabulary.json'), JSON.stringify({ _version: VOCAB_CACHE_VERSION, tokens: {} }));
  assert.throws(() => cachedVocabularyWords(dir), /empty or from another version/);
});

// issue-351-header-words-out-of-vocabulary (#351 part a, 2026-11-23). The words of a copyright or
// licence header are not vocabulary: the holder's name and the handle in the project URL were the
// 14th and 35th vocabulary tokens of CodeExam's own index and its 6th and 11th concepts, with no
// function named for either. The header is in 16 of the 40 files of this fixture, a share the
// document-frequency cutoff (three-fifths) does not hide, as on CodeExam's index (147 of 265).
import { ensureVocabulary, buildDocInclusiveVocabulary } from '../src/core/vocabulary.js';
import { GROUPER_DEFAULTS } from '../src/core/mechanism-grouper.js';

const HOLDERS = ['Wilhelmina Quixotry', 'Zaphod Beeblebrox', 'Ottoline Marmaduke'];
function headerFixture() {
  const files = {};
  const body = (i, extra = '') => {
    const w = ['Ledger', 'Gasket', 'Hopper', 'Sprocket', 'Tumbler'][i % 5];
    return `export function compute${w}Total${i % 3}(x) {\n  return x + ${i};\n}\n${extra}`;
  };
  for (let i = 0; i < 40; i++) {
    // an ordinary comment, set apart from any header by a blank line, in ten files
    const plain = i % 4 === 1 ? '\n// plumbago keeps the running balance of the ledger\n' : '';
    // headered files: eight with `//`, four Python with `#`, four JavaScript with a block comment
    if (i < 8) {
      files[`src/a${i}.js`] = `// Copyright (c) 2026 ${HOLDERS[0]}\n// https://github.com/quixotry99-labs/frobnicator\n${plain}${i < 3 ? '\nconst frobnicator = { Wilhelmina: ' + i + ' };\nconst wilhelminaPad = frobnicator;\n' : ''}${body(i)}`;
    } else if (i < 12) {
      files[`src/b${i}.py`] = `# Copyright 2026 ${HOLDERS[1]}\n# https://example.org/beeblebrox\n${plain.replace(/\/\//g, '#')}\ndef ${'compute_total_' + (i % 3)}(x):\n    return x + ${i}\n${i < 10 ? 'Zaphod = 1\nZaphod2 = Zaphod\n' : ''}`;
    } else if (i < 16) {
      files[`src/c${i}.js`] = `/*\n * Copyright (c) 2026 ${HOLDERS[2]}\n * Licensed under the Apache License, Version 2.0\n * see https://example.org/marmaduke-licence\n */\n${plain}${i < 14 ? '\nconst Ottoline = 1;\nconst ottolineTwice = Ottoline * 2;\n' : ''}${body(i)}`;
    } else {
      files[`src/d${i}.js`] = `${plain}${i === 17 ? '// the file of Quixotry-free text, Zaphod and Wilhelmina in an ordinary comment\n' : ''}${body(i)}`;
    }
  }
  return files;
}
function stubIdx(files, indexPath) {
  const idx = { indexPath, files: new Map(), fileLines: new Map(), _ensureFunctionIndex() {}, functionIndex: {} };
  for (const [fp, text] of Object.entries(files)) { idx.files.set(fp, text); idx.fileLines.set(fp, text.split('\n')); }
  return idx;
}
const tmpIndexDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vocab-header-'));
const vocabOf = (idx) => ensureVocabulary(idx, false);

test('issue-351 header words: a holder and a project handle that occur only on header lines are not vocabulary', () => {
  const v = vocabOf(stubIdx(headerFixture(), tmpIndexDir()));
  for (const t of ['Quixotry', 'quixotry99', 'Beeblebrox', 'beeblebrox', 'Marmaduke', 'marmaduke']) assert.ok(!v.has(t), `${t} is a header word and not vocabulary`);
  assert.ok(![...v.keys()].some((t) => /quixotry|beeblebrox|marmaduke/i.test(t)), [...v.keys()].filter((t) => /quixotry|beeblebrox|marmaduke/i.test(t)).join(' '));
  // the licence sentence of the block header goes too: its words are in no code
  assert.ok(!v.has('Apache') && !v.has('Licensed'));
  // and the words the code is about stay
  assert.ok(v.has('plumbago'));
});

test('issue-351 header words: a word on header lines and in code stays, its header occurrences not counted', () => {
  const v = vocabOf(stubIdx(headerFixture(), tmpIndexDir()));
  // `//` header and code: frobnicator is in the URL of 8 files and declared in 3 (twice each in those)
  const f = v.get('frobnicator');
  assert.ok(f, 'frobnicator is also code');
  assert.equal(f.doc_freq, 3);
  assert.equal(f.total_count, 6);
  // `#` header (Python): Zaphod is in the holder of 4 files and in code in 2 of them (twice), and in one ordinary comment
  const z = v.get('Zaphod');
  assert.ok(z, 'Zaphod is also code');
  assert.equal(z.doc_freq, 3);
  assert.equal(z.total_count, 2 * 2 + 1);
  // `/* */` block header: Ottoline is in the holder of 4 files and in code in 2 (twice each)
  const o = v.get('Ottoline');
  assert.ok(o, 'Ottoline is also code');
  assert.equal(o.doc_freq, 2);
  assert.equal(o.total_count, 4);
  // top_files carry the same counts: no header file is named for a word it only has in its header
  for (const e of o.top_files) assert.ok(/c1[23]\.js$/.test(e.path), e.path);
});

test('issue-351 header words: a word in an ordinary comment, with or without a header in the file, is counted as before', () => {
  const v = vocabOf(stubIdx(headerFixture(), tmpIndexDir()));
  const p = v.get('plumbago');
  assert.equal(p.doc_freq, 10);
  assert.equal(p.total_count, 10);
  // a holder's name written in an ordinary comment of a file that has no header counts
  assert.equal(v.get('Wilhelmina').doc_freq, 4);   // 1 ordinary comment + 3 code declarations; the 8 holder lines are not counted
  assert.equal(v.get('Wilhelmina').total_count, 4);
});

test('issue-351 header words: the concepts and the grouper\'s seeds do not include the header words', () => {
  const idx = stubIdx(headerFixture(), tmpIndexDir());
  const entries = getTopVocabulary(idx, 200);
  const concepts = extractConcepts(idx, { entries, maxConcepts: Infinity, catalog: null }).map((c) => c.concept);
  // the grouper's token seeds are extractConcepts' first GROUPER_DEFAULTS.concepts concepts of the same vocabulary
  const seeds = extractConcepts(idx, { maxConcepts: GROUPER_DEFAULTS.concepts, catalog: null }).map((c) => c.concept);
  for (const list of [concepts, seeds]) {
    for (const w of ['quixotry', 'quixotry99', 'beeblebrox', 'marmaduke', 'licensed', 'apache']) assert.ok(!list.includes(w), `${w} in ${list.join(',')}`);
  }
  assert.ok(concepts.includes('plumbago') || concepts.includes('frobnicator'), concepts.join(','));
});

test('issue-351 header words: the doc-inclusive vocabulary the grouper builds with --use-docs leaves the header out of code files too', () => {
  const v = buildDocInclusiveVocabulary(stubIdx(headerFixture(), tmpIndexDir()), false);
  assert.ok(!v.has('Quixotry') && !v.has('quixotry99') && !v.has('Beeblebrox'));
  assert.ok(v.has('plumbago'));
});

test('issue-351 header words: a vocabulary.json written before the header rule (version 7) is rebuilt, one of the current version is read', () => {
  const dir = tmpIndexDir();
  const idx = stubIdx(headerFixture(), dir);
  const stale = { _version: 7, _file_count: idx.files.size, _generated: '2026-11-09T00:00:00.000Z', tokens: { quixotry99: { doc_freq: 8, total_count: 8, score: 99, top_files: [] }, Quixotry: { doc_freq: 8, total_count: 8, score: 98, top_files: [] } } };
  fs.writeFileSync(path.join(dir, 'vocabulary.json'), JSON.stringify(stale));
  assert.ok(VOCAB_CACHE_VERSION > 7, 'the mark moved with the header rule');
  const v = vocabOf(idx);
  assert.ok(!v.has('quixotry99') && !v.has('Quixotry'), 'the stale cache was not used');
  const rewritten = JSON.parse(fs.readFileSync(path.join(dir, 'vocabulary.json'), 'utf8'));
  assert.equal(rewritten._version, VOCAB_CACHE_VERSION);
  assert.ok(!('quixotry99' in rewritten.tokens));
  // a cache that carries the mark is read as it is
  const dir2 = tmpIndexDir();
  const idx2 = stubIdx(headerFixture(), dir2);
  fs.writeFileSync(path.join(dir2, 'vocabulary.json'), JSON.stringify({ _version: VOCAB_CACHE_VERSION, _file_count: idx2.files.size, _generated: '2026-11-23T00:00:00.000Z', tokens: { cachedonly: { doc_freq: 5, total_count: 5, score: 50, top_files: [] } } }));
  const v2 = vocabOf(idx2);
  assert.ok(v2.has('cachedonly') && v2.size === 1);
});

test('issue-351 header words: a copyright line in a docstring header, and a bare URL line in the header window, are header lines', () => {
  const files = {};
  for (let i = 0; i < 12; i++) {
    files[`src/p${i}.py`] = `"""Copyright 2026 Rumpelstiltskin Holdings\nAll rights reserved.\n"""\n# https://example.org/rumpelstiltskin-docs\ndef compute_${i % 4}(x):\n    return x\n`;
    files[`src/q${i}.js`] = `// see https://example.org/needle for the reason this is here\nexport function f${i}(x) { return x; }\n`;
  }
  const v = vocabOf(stubIdx(files, tmpIndexDir()));
  assert.ok(!v.has('Rumpelstiltskin') && !v.has('rumpelstiltskin') && !v.has('Holdings'), [...v.keys()].filter((t) => /rumpel|holdings/i.test(t)).join(' '));
  // a line with a sentence and a URL is not a bare URL line: its words count
  assert.ok(v.has('reason'));
});

// issue-351-header-words-out-of-vocabulary, revised: a header is the notice paragraphs of the head
// comment, not the rest of its run.
import { headerLineIndexes } from '../src/core/copyrights.js';

const APACHE = ['Copyright 2021 Google LLC', '', 'Licensed under the Apache License, Version 2.0 (the "License");', 'you may not use this file except in compliance with the License.', 'You may obtain a copy of the License at', '', '     http://www.apache.org/licenses/LICENSE-2.0', '', 'Unless required by applicable law or agreed to in writing, software', 'distributed under the License is distributed on an "AS IS" BASIS,', 'WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.', 'See the License for the specific language governing permissions and', 'limitations under the License.'];
const MIT = ['Copyright (c) 2020 Some Body', '', 'Permission is hereby granted, free of charge, to any person obtaining a copy', 'of this software and associated documentation files (the "Software"), to deal', 'in the Software without restriction.', '', 'The above copyright notice and this permission notice shall be included in', 'all copies or substantial portions of the Software.', '', 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR', 'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY.', 'IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,', 'DAMAGES OR OTHER LIABILITY.'];
const BSD = ['Copyright (c) 2019, Some Body', 'All rights reserved.', '', 'Redistribution and use in source and binary forms, with or without', 'modification, are permitted provided that the following conditions are met:', '', '1. Redistributions of source code must retain the above notice, this list of', '   conditions and the following disclaimer.', '', '2. Redistributions in binary form must reproduce the above notice in the', '   documentation.', '', '3. Neither the name of the organization nor the names of its', '   contributors may be used to endorse products derived from this software.', '', 'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"', 'AND ANY EXPRESS OR IMPLIED WARRANTIES ARE DISCLAIMED.'];
const asRun = (kind, paras) => {
  if (kind === 'line') return paras.map((l) => (l === '' ? '//' : '// ' + l));
  if (kind === 'hash') return paras.map((l) => (l === '' ? '#' : '# ' + l));
  return ['/*', ...paras.map((l) => (l === '' ? ' *' : ' * ' + l)), ' */'];
};

test('issue-351 header words: the Apache, MIT and BSD headers are header lines to the last paragraph, in every comment style', () => {
  for (const [name, text] of [['Apache', APACHE], ['MIT', MIT], ['BSD', BSD]]) {
    for (const kind of ['line', 'hash', 'block']) {
      const run = asRun(kind, text);
      const h = headerLineIndexes([...run, '', 'export const x = 1;']);
      const missed = run.filter((l, i) => !h.has(i) && /[A-Za-z]/.test(l.replace(/^\s*(\/\/|#|\/\*|\*)/, '')));
      assert.deepEqual(missed, [], `${name} ${kind}`);
      assert.ok(!h.has(run.length + 1), 'the code after it is not header');
    }
  }
});

test('issue-351 header words: a description paragraph after the notice paragraph of one comment run is counted; a line above the notice in its paragraph is not header', () => {
  const lines = ['// semantic-search.js: one-line description', '// Copyright (c) 2026 Some Body', '// https://example.org/some-body/project', '// Licensed under the Apache License, Version 2.0; see LICENSE.', '//', '// The command compares a sentence with one short text per function.', '// Plumbago lists the functions.', 'export function f() {}'];
  assert.deepEqual([...headerLineIndexes(lines)].sort((a, b) => a - b), [1, 2, 3]);
  const files = Object.fromEntries([...Array(8).keys()].map((i) => [`src/s${i}.js`, [...lines, `export function g${i}() { return ${i}; }`].join('\n')]));
  for (let i = 0; i < 8; i++) files[`src/t${i}.js`] = `export function h${i}() { return ${i}; }`;   // keeps the words under the frequency cutoff
  const v = vocabOf(stubIdx(files, tmpIndexDir()));
  assert.ok(v.has('Plumbago') && v.has('compares'), [...v.keys()].slice(0, 20).join(' '));
  assert.ok(!v.has('Licensed'));
});

// issue-351-base64-fragments-as-concepts (2026-11-24). The tokenizer cuts a base64 run at every `+`,
// `/` and `=`, so the tokens it yields are middle pieces: under looksLikeBase64Blob's 64-character
// gate, with no image signature, and vowel-rich enough to pass looksLikeRandomToken. On
// .AI_Manning_recent (notebooks with embedded images) they were 142 of 299 concepts and more than
// half the vocabulary. The run still shows what it is, so the run is left out of the text.
import { withoutBase64Runs, BASE64_RUN_MIN } from '../src/core/vocabulary.js';

// pieces as the tokenizer cut them from notebook images in that index; each passes both token tests
const B64_PIECES = ['MUvAAATJkxAZGQkysvLsWPHDqxevfpOuKqrq8PMmTNRVlaGiIgI3HfffVAUBZ9', 'AgCA0o2gGwCACHrm0eejXQQAABBBNC8HAAAAAMAnBN0AAAAAAPiEoBsAAAAAAJ', 'CggIUKZMmdSsWTOdPXv2MUUMAAAAPB3SVWKxevVqvf', 'NKuxoOCguzeFgAAAED6wXSzAAAAABzmcGIRGxurgQMHqmDBgvL29la', 'KyuKVFFXqgoiIhCNlqdYiJUu53Wb'];
const B64_RUN = B64_PIECES.join('+').replace(/\+(?=Cgg|Kyu)/g, '/') + '==';
const LONG_PATH = 'com/huggingface/transformers/blob/main/src/transformers/models/qwen3/modeling';
function notebookFixture() {
  const files = {};
  for (let i = 0; i < 8; i++) {
    files[`nb/chapter${i}.ipynb`] = [`{ "cells": [ { "outputs": [ { "data": {`, `   "image/png": "${B64_RUN}",`, `   "text/plain": [ "computeQuibbleMargin(frobnicateWidget) # see https://github.${LONG_PATH}" ]`, `} } ] } ] }`].join('\n');
    files[`src/plain${i}.py`] = `def helper_${i}(x):\n    return x + ${i}\n`;   // keeps the notebook's words under the frequency cutoff
  }
  return files;
}

test('issue-351 base64 fragments: the fixture is the defect (each piece passes both token tests)', () => {
  assert.ok(B64_RUN.length >= BASE64_RUN_MIN, `the run is ${B64_RUN.length} characters`);
  for (const p of B64_PIECES) assert.ok(!looksLikeBase64Blob(p) && !looksLikeRandomToken(p), `${p.slice(0, 12)}… passes the token tests, which is why the run has to be judged`);
});

test('issue-351 base64 fragments: withoutBase64Runs leaves out a long run and nothing else', () => {
  const text = `a = 1\n"image/png": "${B64_RUN}",\nb = computeQuibbleMargin()\n`;
  const out = withoutBase64Runs(text);
  assert.ok(!out.includes('MUvAAATJ') && !out.includes('KyuKVFF'));
  assert.ok(out.includes('"image/png"') && out.includes('computeQuibbleMargin'), 'the rest of the line and the other lines stay');
  assert.equal(out.split('\n').length, text.split('\n').length, 'line numbers are kept');
  // shorter than the minimum: a URL path, a package integrity hash, a row of slashes, a long name
  const keep = [`https://github.${LONG_PATH}`, 'sha512-SFy8S9plRPbIcxlJ8A6mT/CxFdJx/c04JEctz4jf8YZaVS2px34j7NXRrlGlHkN/M2gnpL37ZpGRGVFLd3l8Ng==', '/'.repeat(120), 'kCVPixelFormatType_420YpCbCr10BiPlanarFullRange'];
  for (const k of keep) assert.equal(withoutBase64Runs(k), k, k.slice(0, 30));
  assert.equal(withoutBase64Runs('no payload here'), 'no payload here');
});

test('issue-351 base64 fragments: pieces of an embedded image are not vocabulary; the words beside it are', () => {
  const v = vocabOf(stubIdx(notebookFixture(), tmpIndexDir()));
  const got = B64_PIECES.filter((p) => v.has(p));
  assert.deepEqual(got, [], 'pieces of the base64 run in the vocabulary');
  assert.ok(v.has('computeQuibbleMargin') && v.has('frobnicateWidget'), [...v.keys()].slice(0, 12).join(' '));
  assert.ok(v.has('huggingface'), 'a long URL path is not a base64 run');
});

test('issue-351 base64 fragments: no concept is a fragment of an embedded image', () => {
  const idx = stubIdx(notebookFixture(), tmpIndexDir());
  const concepts = extractConcepts(idx, { maxConcepts: Infinity, catalog: null });
  const bad = concepts.filter((c) => B64_PIECES.includes(c.example));
  assert.deepEqual(bad.map((c) => c.concept), [], 'concepts whose example is a piece of the run');
  for (const frag of ['dqxevfp', 'kqrq8p', 'xqqaabbbnc8haaaaam']) assert.ok(!concepts.some((c) => c.concept === frag), frag);
  assert.ok(concepts.some((c) => c.concept === 'quibble'), concepts.map((c) => c.concept).join(' '));
});

// issue-364-concepts-doc-and-accuracy (2026-11-24): concepts are pieces of the top CONCEPT_NAMES
// vocabulary names, 500 and no longer 200. A word spread over several names, none of them among the
// 200 best, was no concept at all (`faithful` on .sr_gh: 13 names, the best ranked 238th).
import { CONCEPT_NAMES, KEY_FILE_NAMES } from '../src/core/vocabulary.js';
import { allConcepts } from '../src/commands/concepts.js';

function spreadWordIdx() {
  const idx = stubIdx({}, tmpIndexDir());
  const vocab = new Map();
  // 230 names that outrank the rest, each about something of its own
  for (let i = 0; i < 230; i++) vocab.set(`render${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}Widget`, { doc_freq: 3, total_count: 9, score: 5000 - i, top_files: [] });
  // the spread word: eight names, ranked 231st to 238th
  ['computeZorblaxScore', 'ZorblaxMetrics', 'zorblax_from_generations', 'evalZorblax', 'zorblaxPreassert', 'ZorblaxEvaluator', 'loadZorblaxConfig', 'zorblax_report'].forEach((t, i) => vocab.set(t, { doc_freq: 2, total_count: 4, score: 900 - i, top_files: [] }));
  idx._vocabulary = vocab;
  idx.getTopVocabulary = (n) => getTopVocabulary(idx, n);
  return idx;
}

test('issue-364 concept names: one number, 500, and the file lists keep 200', () => {
  assert.equal(CONCEPT_NAMES, 500);
  assert.equal(KEY_FILE_NAMES, 200);
});

test('issue-364 concept names: a word spread over names ranked below the 200th is a concept, by default and for --concepts', () => {
  const idx = spreadWordIdx();
  const at200 = extractConcepts(idx, { topN: 200, maxConcepts: Infinity, catalog: null }).map((c) => c.concept);
  assert.ok(!at200.includes('zorblax'), 'the fixture is the defect: at 200 names the word is not a concept');
  const byDefault = extractConcepts(idx, { maxConcepts: Infinity, catalog: null });
  const z = byDefault.find((c) => c.concept === 'zorblax');
  assert.ok(z, 'a concept by default');
  assert.ok(/zorblax/i.test(z.example), `its example is one of its names: ${z.example}`);
  const { vocab, all } = allConcepts(idx);
  assert.ok(all.some((c) => c.concept === 'zorblax'), '--concepts lists it');
  assert.equal(vocab.length, KEY_FILE_NAMES, 'the file lists are still made from the top 200');
});
