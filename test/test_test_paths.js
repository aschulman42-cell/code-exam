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
import { testPathClass, isTestPath, leavesTestsOut, testOptionGiven, withoutTests, testsTip, optionTestsTip, isTestEntry, unreadTestOptionNote, TEST_OPTION_READERS, AIML_LISTING_KEYS } from '../src/core/test-paths.js';
import { isTestSymbol } from '../src/commands/claim-locate.js';
import { filterResultsByPath } from '../src/commands/search.js';

const lastLine = (s) => String(s).split(/\r?\n/).filter((l) => l.trim() !== '').pop();   // the last non-blank line of a command's output
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
    // part E4: the one closing line (it replaced testsLeftOutLine, the header line of 2026-11-19)
    assert.equal(optionTestsTip({ exclude_tests: true }, 1118, 'files'), 'Tip: 1,118 files of test, benchmark, mock and example code left out (--exclude-tests); run without it to list them.');
    assert.equal(optionTestsTip({ exclude_tests: true }, 0, 'files'), '');
    assert.equal(optionTestsTip({}, 5, 'files'), '');
  });
  it('the closing Tip: both forms, singular, a lower bound, the MCP words, and nothing when nothing was left out', () => {
    assert.equal(testsTip(63, 'mechanisms'), 'Tip: 63 mechanisms of test, benchmark, mock and example code left out; --include-tests lists them.');
    assert.equal(testsTip(19, 'call sites', { option: '--exclude-tests' }), 'Tip: 19 call sites of test, benchmark, mock and example code left out (--exclude-tests); run without it to list them.');
    assert.equal(testsTip(1, 'mechanisms'), 'Tip: 1 mechanism of test, benchmark, mock and example code left out; --include-tests lists it.');
    assert.equal(testsTip(1, 'classes', { option: '--no-tests' }), 'Tip: 1 class of test, benchmark, mock and example code left out (--no-tests); run without it to list it.');
    assert.equal(testsTip(1, 'matches', { option: '--exclude-tests' }).split(' ')[2], 'match');
    assert.equal(testsTip(500, 'call sites', { option: '--exclude-tests', atLeast: true }), 'Tip: at least 500 call sites of test, benchmark, mock and example code left out (--exclude-tests); run without it to list them.');
    assert.equal(testsTip(1, 'matches', { option: '--exclude-tests', atLeast: true }).includes('at least 1 matches'), true, 'a lower bound of 1 is still plural');
    assert.equal(testsTip(4, 'groups', { include: 'include_tests: true', also: [[2, 'functions']] }), 'Tip: 4 groups and 2 functions of test, benchmark, mock and example code left out; include_tests: true lists them.');
    assert.equal(testsTip(3, 'matches', { option: 'exclude_tests' }), 'Tip: 3 matches of test, benchmark, mock and example code left out (exclude_tests); run without it to list them.');
    assert.equal(testOptionGiven({ exclude_tests: true, no_tests: true }), '--exclude-tests / --no-tests');
    assert.equal(optionTestsTip({ no_tests: true }, 2, 'files').includes('(--no-tests)'), true, 'names the option the user typed');
    assert.equal(testsTip(0, 'files'), '');
  });
  it('a mechanism is test code when every member is, by path, name or attribute', () => {
    const m = (name, file, extra = {}) => ({ name, file, ...extra });
    assert.equal(isTestEntry({ members: [m('run', 'test/a.js'), m('helper', 'tests/b.js')] }), true);
    assert.equal(isTestEntry({ members: [m('run', 'test/a.js'), m('helper', 'src/b.js')] }), false, 'a mix is not test code');
    assert.equal(isTestEntry({ members: [m('test_sign', 'src/a.py'), m('FakeGroup::size', 'src/b.py')] }), true, 'by name');
    assert.equal(isTestEntry({ members: [m('posting_does_not_settle', 'src/ledger.rs', { test: true })] }), true, 'by attribute mark');
    assert.equal(isTestEntry({ members: [] }), false, 'no members is not test code');
    assert.equal(isTestEntry({ tags: ['test'], members: [m('run', 'src/a.js')] }), false, 'the build-time tag no longer decides');
  });
  it('the text searches drop a hit in a test file under either option', () => {
    const hits = [{ filePath: 'src/a.js' }, { filePath: 'test/test_a.js' }];
    assert.equal(filterResultsByPath(hits, {}), hits);
    // [...x]: the result carries `testsLeft` (the count for the closing Tip) as a property beside its elements
    assert.deepEqual([...filterResultsByPath(hits, { exclude_tests: true })], [hits[0]]);
    assert.deepEqual([...filterResultsByPath(hits, { no_tests: true })], [hits[0]]);
    assert.equal(filterResultsByPath(hits, { no_tests: true }).testsLeft, 1);
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
      assert.equal(lastLine(r.stdout), `Tip: 1 file of test, benchmark, mock and example code left out (${opt}); run without it to list it.`, 'the closing line, and the header no longer says it');
      assert.doesNotMatch(r.stdout.split('Tip:')[0], /left out/);
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
    // was --callees; since test-options-remaining-commands --callees reads the options, --call-tree is the command that does not
    const r = run('--ndx', ndx, '--call-tree', 'loadGguf', '--exclude-tests');
    assert.match(r.stderr, /# --exclude-tests does nothing here: no command in this run reads it/);
    assert.equal(r.status, 0);
  });
});

// test-options-remaining-commands (2026-11-23). --callers and --callees read the two options;
// --call-tree does not, and says so; the multisect calls of --multisect-analyze and the claim
// commands pass the option to the multisect core; the MCP search tools take exclude_tests.
describe('test-options-remaining-commands: --callers, --callees, --call-tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-test-callers-'));
  const src = path.join(dir, 'proj');
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.mkdirSync(path.join(src, 'test'), { recursive: true });
  fs.writeFileSync(path.join(src, 'src', 'engine.js'), 'function loadGguf(path) {\n  return probe(path);\n}\nfunction startup() {\n  return loadGguf("a");\n}\nfunction probe(p) {\n  return p;\n}\n');
  fs.writeFileSync(path.join(src, 'test', 'test_engine.js'), 'function checksGguf() {\n  const x = loadGguf("m");\n  return helperMock(x);\n}\nfunction helperMock(v) {\n  return v;\n}\n');
  const ndx = path.join(dir, '.ndx');
  const run = (...a) => spawnSync(process.execPath, [CE, ...a], { encoding: 'utf8', cwd: dir });
  const built = run('--build-index', src, '--index-path', ndx);

  it('builds the fixture index', () => { assert.equal(built.status, 0, built.stderr + built.stdout); });

  it('--callers lists a call site in a test file by default, and leaves it out with either option, counting it', () => {
    const plain = run('--ndx', ndx, '--callers', 'loadGguf');
    assert.match(plain.stdout, /checksGguf/);
    assert.match(plain.stdout, /test\/test_engine\.js:2/);
    assert.match(plain.stdout, /2 call sites in 2 functions/);
    assert.doesNotMatch(plain.stdout, /left out/);
    assert.doesNotMatch(plain.stderr, /does nothing here/);
    for (const opt of ['--exclude-tests', '--no-tests']) {
      const r = run('--ndx', ndx, '--callers', 'loadGguf', opt);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /startup/, opt);
      assert.doesNotMatch(r.stdout, /checksGguf|test_engine/, `${opt} leaves the test caller out`);
      assert.match(r.stdout, /1 call sites in 1 functions/);
      assert.equal(lastLine(r.stdout), `Tip: 1 call site of test, benchmark, mock and example code left out (${opt}); run without it to list it.`, r.stdout);
      assert.doesNotMatch(r.stderr, /does nothing here|was not read/, 'a command that reads the option gets no note');
    }
  });

  it('--callers with every caller in test code says none are left, and how many were left out', () => {
    const r = run('--ndx', ndx, '--callers', 'helperMock', '--exclude-tests');
    assert.match(r.stdout, /No callers found for 'helperMock' outside test code; 1 call site in test code left out \(--exclude-tests\)\./);
    assert.doesNotMatch(r.stdout, /Tip: 1 call site/, 'the sentence already says it, so no closing Tip after it');
  });

  it('--callers --depth 2 leaves test callers out of every level', () => {
    assert.match(run('--ndx', ndx, '--callers', 'loadGguf', '--depth', '2').stdout, /checksGguf/);
    const r = run('--ndx', ndx, '--callers', 'loadGguf', '--depth', '2', '--no-tests');
    assert.doesNotMatch(r.stdout, /checksGguf/);
    assert.match(r.stdout, /startup/);
    assert.equal(lastLine(r.stdout), 'Tip: 1 call site of test, benchmark, mock and example code left out (--no-tests); run without it to list it.');
  });

  it('--callees leaves out a callee defined only in test files, and counts it', () => {
    const plain = run('--ndx', ndx, '--callees', 'checksGguf');
    assert.match(plain.stdout, /calls 2 functions/);
    assert.match(plain.stdout, /helperMock/);
    assert.doesNotMatch(plain.stdout, /left out/);
    for (const opt of ['--exclude-tests', '--no-tests']) {
      const r = run('--ndx', ndx, '--callees', 'checksGguf', opt);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /calls 1 functions/, opt);
      assert.match(r.stdout, /loadGguf/);
      assert.doesNotMatch(r.stdout, /helperMock/, `${opt} leaves the test callee out`);
      assert.equal(lastLine(r.stdout), `Tip: 1 callee of test, benchmark, mock and example code left out (${opt}); run without it to list it.`, r.stdout);
      assert.doesNotMatch(r.stderr, /does nothing here|was not read/);
    }
  });

  it('--call-tree does not read the options, runs in full, and the note names it and why', () => {
    const plain = run('--ndx', ndx, '--call-tree', 'checksGguf');
    const r = run('--ndx', ndx, '--call-tree', 'checksGguf', '--exclude-tests');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, plain.stdout, 'the tree is the same with and without the option');
    assert.match(r.stdout, /helperMock/);
    assert.match(r.stderr, /# --exclude-tests does nothing here/);
    assert.match(r.stderr, /--call-tree does not read it: .*branches/);
  });
});

describe('test-options-remaining-commands: the note is per command', () => {
  it('names a command that does not read the option even when another command in the run does', () => {
    const only = unreadTestOptionNote({ exclude_tests: true }, (k) => k === 'call_tree');
    assert.match(only, /^# --exclude-tests does nothing here: no command in this run reads it/);
    assert.match(only, /--call-tree does not read it: /);
    const mixed = unreadTestOptionNote({ no_tests: true }, (k) => k === 'call_tree' || k === 'callers');
    assert.match(mixed, /^# --no-tests was not read by --call-tree: /);
    assert.doesNotMatch(mixed, /does nothing here/);
    assert.match(mixed, /--callers/, 'and says which command did read it');
    assert.equal(unreadTestOptionNote({ no_tests: true }, (k) => k === 'callers'), '');
    assert.equal(unreadTestOptionNote({}, (k) => k === 'call_tree'), '', 'no option given, no note');
  });
  it('the commands made readers are in the table', () => {
    for (const k of ['callers', 'callees', 'multisect_analyze', 'claim_search', 'claim_analyze', 'claims_loop']) assert.ok(TEST_OPTION_READERS[k], k);
    assert.equal(TEST_OPTION_READERS.call_tree, undefined, '--call-tree stays a non-reader');
  });
  it('the command line: --call-tree with --callers names --call-tree only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-test-note-'));
    const src = path.join(dir, 'proj');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.js'), 'function a() {\n  return b();\n}\nfunction b() {\n  return 1;\n}\n');
    const run = (...a) => spawnSync(process.execPath, [CE, ...a], { encoding: 'utf8', cwd: dir });
    assert.equal(run('--build-index', src, '--index-path', path.join(dir, '.ndx')).status, 0);
    const r = run('--ndx', path.join(dir, '.ndx'), '--callers', 'b', '--call-tree', 'a', '--exclude-tests');
    assert.match(r.stderr, /# --exclude-tests was not read by --call-tree: /);
    assert.doesNotMatch(r.stderr, /does nothing here/);
  });
});

describe('test-options-remaining-commands: multisect calls pass the option to the core', () => {
  it('--multisect-analyze and --claim-search hand excludeTests to multisectSearch', async () => {
    const { doMultisectAnalyze } = await import('../src/commands/analyze.js');
    const { runClaimTier } = await import('../src/commands/claim.js');
    const seen = [];
    const spy = { computeTermFileCounts: () => ({ term_file_counts: [1, 1], total_files: 10 }), files: new Map([['src/a.js', 1], ['test/t.js', 1]]),
      multisectSearch: (t, o) => { seen.push(o); throw new Error('stop'); } };
    const log = console.log; console.log = () => {};
    try {
      await doMultisectAnalyze(spy, { multisect_analyze: 'alpha;beta', exclude_tests: true });
      await doMultisectAnalyze(spy, { multisect_analyze: 'alpha;beta' });
      try { runClaimTier(spy, 'TIGHT', 'alpha;beta', 0, { excludeTests: true }); } catch { /* the spy throws */ }
      try { runClaimTier(spy, 'TIGHT', 'alpha;beta', 0, {}); } catch { /* the spy throws */ }
    } finally { console.log = log; }
    assert.deepEqual(seen.map((o) => !!o.excludeTests), [true, false, true, false]);
  });
});

describe('test-options-remaining-commands: a test marked only by an attribute (part C)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-test-attr-'));
  const src = path.join(dir, 'proj');
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'src', 'ledger.rs'), 'pub fn settle(a: i32) -> i32 {\n    a + 1\n}\n\npub fn mock_clock() -> i32 {\n    3\n}\n\n#[test]\nfn posting_does_not_settle_when_ledger_is_empty() {\n    assert_eq!(settle(1), 2);\n}\n');
  const ndx = path.join(dir, '.ndx');
  const run = (...a) => spawnSync(process.execPath, [CE, ...a], { encoding: 'utf8', cwd: dir });
  it('builds the fixture index', () => { assert.equal(run('--build-index', src, '--index-path', ndx).status, 0); });
  it('the three function listings leave the attribute-marked function out under either option, and keep it without', () => {
    for (const cmd of ['--list-functions', '--list-functions-alpha', '--list-functions-size']) {
      assert.match(run('--ndx', ndx, cmd).stdout, /posting_does_not_settle/, `${cmd} lists it by default`);
      assert.match(run('--ndx', ndx, cmd).stdout, /mock_clock/, `${cmd} lists a mock-named function by default`);
      for (const opt of ['--exclude-tests', '--no-tests']) {
        const r = run('--ndx', ndx, cmd, opt);
        assert.doesNotMatch(r.stdout, /posting_does_not_settle/, `${cmd} ${opt}`);
        assert.match(r.stdout, /settle/, `${cmd} ${opt} keeps the source function`);
        assert.doesNotMatch(r.stdout, /mock_clock/, `${cmd} ${opt}: a function named like a mock is test code by the one rule for a function`);
        assert.equal(lastLine(r.stdout), `Tip: 2 functions of test, benchmark, mock and example code left out (${opt}); run without it to list them.`, `${cmd} ${opt}: ${r.stdout}`);
      }
    }
  });
});

describe('test-options-remaining-commands: the MCP search tools take exclude_tests', () => {
  it('search, regex_search and multisect_search list the argument, default off, and leave test files out when it is true', async () => {
    const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
    const { handleTool, TOOLS, setIndex } = await import('../src/mcp-server.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-test-mcp-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'engine.js'), 'function loadGguf(path) {\n  const cuda = probeCuda();\n  return openGguf(path, cuda);\n}\n');
    fs.writeFileSync(path.join(dir, 'test', 'test_engine.js'), 'function checksGguf() {\n  const cuda = fakeCuda();\n  return loadGguf("m.gguf", cuda);\n}\n');
    const index = new CodeSearchIndex({ indexPath: path.join(dir, '.ndx') });
    await index.buildIndex(dir, { showProgress: false });
    setIndex(index);
    for (const n of ['search', 'regex_search', 'multisect_search']) {
      const t = TOOLS.find((x) => x.name === n);
      assert.equal(t.inputSchema.properties.exclude_tests.type, 'boolean', n);
      assert.match(t.inputSchema.properties.exclude_tests.description, /test, benchmark, mock and example/, n);
      assert.ok(!(t.inputSchema.required || []).includes('exclude_tests'));
    }
    const call = { search: { query: 'cuda' }, regex_search: { pattern: 'cuda' }, multisect_search: { terms: 'gguf;cuda' } };
    for (const [n, a] of Object.entries(call)) {
      assert.match(handleTool(n, a), /test_engine\.js/, `${n} lists the test file by default`);
      assert.match(handleTool(n, { ...a, exclude_tests: false }), /test_engine\.js/, n);
      const out = handleTool(n, { ...a, exclude_tests: true });
      assert.doesNotMatch(out, /test_engine\.js/, `${n} leaves the test file out`);
      assert.match(out, /engine\.js/, n);
      assert.match(lastLine(out), /^Tip: \d+ (files?|matches|match) of test, benchmark, mock and example code left out \(exclude_tests\); run without it to list (it|them)\.$/, `${n} ends with the closing line: ${out}`);
    }
  });
});
