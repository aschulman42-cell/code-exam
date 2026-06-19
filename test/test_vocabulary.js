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
  assert.ok(concepts.includes('multisect'), `got: ${concepts.join(',')}`); // df 1 -> kept
  assert.ok(concepts.includes('worklist'));                                 // df 0 -> kept
  assert.ok(!concepts.includes('build'));   // df 9 >= 6 -> dropped
  assert.ok(!concepts.includes('index'));   // df 10 -> dropped
  assert.ok(!concepts.includes('prompt'));  // df 8 -> dropped
});
