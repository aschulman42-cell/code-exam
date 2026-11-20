// test_test_paths.js — the one rule for "this file is test code", the two options that leave such files out, and the note for a command that reads neither
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// multisect-test-options-do-nothing (2026-11-19). Andrew ran --multisect with
// --exclude-tests and then with --no-tests; both were accepted and test/ was still in
// the results. The red fixture is that shape: a small index with a file under test/.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testPathClass, isTestPath, leavesTestsOut, testOptionGiven, withoutTests, testsLeftOutLine, unreadTestOptionNote, TEST_OPTION_READERS, AIML_LISTING_KEYS } from '../src/core/test-paths.js';
import { isTestSymbol } from '../src/commands/claim-locate.js';
import { filterResultsByPath } from '../src/commands/search.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = path.join(ROOT, 'src', 'index.js');

describe('test-paths: one rule for a test file', () => {
  it('reads a test, benchmark, mock or example directory or file name, and leaves look-alikes in', () => {
    assert.equal(testPathClass('test/test_multisect_scoring.js'), 'test');
    assert.equal(testPathClass('src/__tests__/a.js'), 'test');
    assert.equal(testPathClass('lib/foo.test.js'), 'test');
    assert.equal(testPathClass('pkg/FooTest.java'), 'test');
    assert.equal(testPathClass('media.zip!media/test/a.java'), 'test', 'a member of a zipped tree');
    assert.equal(testPathClass('benches/sign.rs'), 'bench');
    assert.equal(testPathClass('src/mocks/net.js'), 'mock');
    assert.equal(testPathClass('examples/demo.c'), 'example');
    for (const p of ['src/latest.js', 'src/contest/a.js', 'src/attest.c', 'lib/testimony.py', 'src/core/multisect.js', '']) assert.equal(testPathClass(p), null, p);
    assert.equal(isTestPath('src/latest.js'), false, 'the old rule, "the path contains test", dropped this');
    assert.equal(isTestPath('examples/demo.c'), true, 'and kept this');
  });
  it('is the rule the claim tools use for a symbol\'s file', () => {
    for (const p of ['test/a.js', 'src/latest.js', 'examples/x.c', 'src/core/embed.js', 'pkg/FooTest.java']) assert.equal(isTestSymbol({ name: 'run', filepath: p }), isTestPath(p), p);
  });
});

describe('test-paths: --exclude-tests and --no-tests mean the same thing', () => {
  const files = ['src/a.js', 'test/test_a.js', 'examples/b.js', 'src/latest.js'];
  it('either option leaves the test files out and counts them; neither leaves the list alone', () => {
    assert.equal(leavesTestsOut({}), false);
    assert.equal(leavesTestsOut({ exclude_tests: true }), true);
    assert.equal(leavesTestsOut({ no_tests: true }), true);
    assert.equal(withoutTests(files, {}).kept, files);
    assert.equal(withoutTests(files, {}).left, 0);
    for (const a of [{ exclude_tests: true }, { no_tests: true }]) assert.deepEqual(withoutTests(files, a), { kept: ['src/a.js', 'src/latest.js'], left: 2 });
    assert.deepEqual(withoutTests([{ filepath: 'test/x.js' }, { filepath: 'src/y.js' }], { no_tests: true }, (f) => f.filepath).kept, [{ filepath: 'src/y.js' }]);
  });
  it('says what was left out, naming the option typed, and nothing when nothing was', () => {
    assert.equal(testOptionGiven({ no_tests: true }), '--no-tests');
    assert.equal(testOptionGiven({ exclude_tests: true, no_tests: true }), '--exclude-tests / --no-tests');
    assert.equal(testsLeftOutLine({ exclude_tests: true }, 1118), '--exclude-tests: 1,118 files of test, benchmark, mock and example code left out');
    assert.equal(testsLeftOutLine({ exclude_tests: true }, 0), '');
    assert.equal(testsLeftOutLine({}, 5), '');
  });
  it('the text searches drop a hit in a test file under either option', () => {
    const hits = [{ filePath: 'src/a.js' }, { filePath: 'test/test_a.js' }];
    assert.equal(filterResultsByPath(hits, {}), hits);
    assert.deepEqual(filterResultsByPath(hits, { exclude_tests: true }), [hits[0]]);
    assert.deepEqual(filterResultsByPath(hits, { no_tests: true }), [hits[0]]);
  });
});

describe('test-paths: a command that reads neither option says so', () => {
  it('a note when no command in the run reads the option; none when one does, or when neither option was given', () => {
    const none = () => false;
    assert.equal(unreadTestOptionNote({}, none), '');
    const n = unreadTestOptionNote({ exclude_tests: true }, none);
    assert.match(n, /^# --exclude-tests does nothing here: no command in this run reads it/);
    assert.match(n, /--multisect-search/);
    assert.match(n, /--exclude-path <text> leaves out any path/);
    assert.match(unreadTestOptionNote({ no_tests: true }, none), /^# --no-tests does nothing here/);
    assert.equal(unreadTestOptionNote({ exclude_tests: true }, (k) => k === 'multisect_search'), '');
    assert.equal(unreadTestOptionNote({ no_tests: true }, (k) => k === 'list_training'), '', 'an AI/ML listing reads it');
    assert.ok(TEST_OPTION_READERS.multisect_search && TEST_OPTION_READERS.search && TEST_OPTION_READERS.hotspots);
    assert.ok(AIML_LISTING_KEYS.includes('list_models_used'));
  });
});

describe('the command line: Andrew\'s run of 2026-11-19', () => {
  // a small index: one source file and one test file that both hold the two terms
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-test-paths-'));
  const src = path.join(dir, 'proj');
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.mkdirSync(path.join(src, 'test'), { recursive: true });
  fs.writeFileSync(path.join(src, 'src', 'engine.js'), 'function loadGguf(path) {\n  const cuda = probeCuda();\n  return openGguf(path, cuda);\n}\n');
  fs.writeFileSync(path.join(src, 'test', 'test_engine.js'), 'function checksGguf() {\n  const cuda = fakeCuda();\n  return loadGguf("m.gguf", cuda);\n}\n');
  const ndx = path.join(dir, '.ndx');
  const run = (...a) => spawnSync(process.execPath, [CE, ...a], { encoding: 'utf8', cwd: dir });
  const built = run('--build-index', src, '--index-path', ndx);

  it('builds the fixture index', () => { assert.equal(built.status, 0, built.stderr + built.stdout); });

  it('--multisect lists the test file by default and says so; --exclude-tests and --no-tests leave it out and say so', () => {
    const plain = run('--ndx', ndx, '--multisect', 'gguf;cuda');
    assert.match(plain.stdout, /test_engine\.js/, 'the test file is in the results by default');
    assert.match(plain.stdout, /Test code is searched too: 1 of the index's 2 files .* --exclude-tests leaves them out/);
    for (const opt of ['--exclude-tests', '--no-tests']) {
      const r = run('--ndx', ndx, '--multisect', 'gguf;cuda', opt);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /engine\.js/, opt);
      assert.doesNotMatch(r.stdout, /test_engine\.js/, `${opt} leaves the test file out`);
      assert.ok(r.stdout.includes(`${opt}: 1 file of test, benchmark, mock and example code left out (of 2 in the index)`), r.stdout.slice(0, 600));
      assert.doesNotMatch(r.stderr, /does nothing here/);
    }
  });

  it('--search and --list-files read the two options too', () => {
    assert.match(run('--ndx', ndx, '--search', 'gguf').stdout, /test_engine\.js/);
    assert.doesNotMatch(run('--ndx', ndx, '--search', 'gguf', '--no-tests').stdout, /test_engine\.js/);
    assert.match(run('--ndx', ndx, '--list-files').stdout, /test_engine\.js/);
    const lf = run('--ndx', ndx, '--list-files', '--exclude-tests').stdout;
    assert.match(lf, /engine\.js/);
    assert.doesNotMatch(lf, /test_engine\.js/);
  });

  it('a command that reads neither option says so on stderr and runs', () => {
    const r = run('--ndx', ndx, '--callees', 'loadGguf', '--exclude-tests');
    assert.match(r.stderr, /# --exclude-tests does nothing here: no command in this run reads it/);
    assert.equal(r.status, 0);
  });
});
