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
