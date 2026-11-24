// test_show_function_text.js — --show-function-text: the listing of the per-function text the embedding commands embed, its mechanism ids, id:mNNN, tests left out, the cap
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// show-function-text-option (2026-11-22). The parts are tested on a corpus built in memory
// (buildCorpus takes a function index and a way to get a file's lines); doShowFunctionText
// on an object shaped like a loaded index, with console.log captured. No model, no disk
// beyond one temporary mechanisms.json.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs as parseProcessArgs } from '../src/argparse.js';
import { cut } from '../src/core/embed.js';
import { buildCorpus, functionText, functionTextParts, memberResolver, FUSE_ARM } from '../src/core/function-text.js';
import { MECHANISMS_FORMAT, mechanismsPath } from '../src/core/mechanisms-index.js';
import { TESTS_OUT_BY_DEFAULT_KEYS, unreadTestOptionNote } from '../src/core/test-paths.js';
import { isTestFunction, mechanismsOfFunctions, standingOf, selectFunctionTexts, lengthStats, formatFunctionTexts, doShowFunctionText } from '../src/commands/function-text.js';

// parseArgs reads process.argv: set it for one call.
const parseArgs = (argv) => { const saved = process.argv; process.argv = ['node', 'ce', ...argv]; try { return parseProcessArgs(); } finally { process.argv = saved; } };

const FILES = {
  'src/gate.js': [
    '// Refuse a cloud call when the run is air-gapped.',
    'function assertLocalOnly(feature) {',
    '  if (airGapped) throw new Error("air-gapped: " + feature + " needs a cloud call");',
    '  return true;',
    '}',
    'function tiny() { return 1; }',
  ],
  'src/catalog.js': [
    'function loadCatalog(file) {',
    '  const prior = JSON.parse(readFileSync(file, "utf8"));',
    '  return prior.libraries;',
    '}',
  ],
  'test/test_gate.js': [
    'function checksGate() {',
    '  assertLocalOnly("x");',
    '}',
  ],
};
const FUNCTION_INDEX = {
  'src/gate.js': { assertLocalOnly: { start: 2, end: 5 }, tiny: { start: 6, end: 6 } },
  'src/catalog.js': { loadCatalog: { start: 1, end: 4 } },
  'test/test_gate.js': { checksGate: { start: 1, end: 3 } },
};
const corpus = buildCorpus(FUNCTION_INDEX, (f) => FILES[f]);
const ENTRIES = [
  { id: 'm1', label: '[file] gate.js', members: [{ file: 'src/gate.js', name: 'assertLocalOnly' }] },
  { id: 'm12', label: 'catalog (loadCatalog)', members: [{ file: 'src/catalog.js', name: 'loadCatalog' }, { file: 'src/gate.js', name: 'assertLocalOnly' }], aliases: [{ id: 'm40' }] },
  { id: 'm3', label: '[file] test_gate.js', tags: ['test'], members: [{ file: 'test/test_gate.js', name: 'checksGate' }] },
];

describe('--show-function-text: the parts', () => {
  it('parses as an option with an optional value', () => {
    assert.equal(parseArgs(['--ndx', '.x', '--show-function-text']).show_function_text, true);
    assert.equal(parseArgs(['--ndx', '.x', '--show-function-text', 'id:m33']).show_function_text, 'id:m33');
    assert.ok(parseArgs(['--ndx', '.x', '--show-function-text'])._explicit.has('show_function_text'));
  });

  it('the pieces join to the text that is embedded', () => {
    for (const f of corpus.fns) {
      const p = functionTextParts(f, corpus);
      let t = p.name;
      if (p.identifiers.length) t += `: ${p.identifiers.join(', ')}`;
      if (p.comment) t += `. ${p.comment}`;
      if (p.strings.length) t += `. Text: ${p.strings.join(' ')}`;
      assert.equal(t, functionText(f, FUSE_ARM, corpus), f.id);
    }
  });

  it('a row carries the text as embedded: functionText in the embedding form, cut to the model\'s length', () => {
    const sel = selectFunctionTexts(corpus);
    const r = sel.rows.find((x) => x.f.name === 'assertLocalOnly');
    assert.equal(r.text, cut(functionText(r.f, FUSE_ARM, corpus)));
    assert.match(r.text, /^assert local only: /);
    assert.match(r.text, /Refuse a cloud call when the run is air-gapped/);
    assert.equal(r.wasCut, false);
  });

  it('leaves test functions out unless asked, and counts them', () => {
    assert.equal(isTestFunction({ file: 'test/test_gate.js' }), true);
    assert.equal(isTestFunction({ file: 'src/gate.js', test: true }), true, 'a test inside a source file');
    assert.equal(isTestFunction({ file: 'src/gate.js' }), false);
    const out = selectFunctionTexts(corpus);
    assert.deepEqual(out.rows.map((r) => r.f.name), ['loadCatalog', 'assertLocalOnly', 'tiny'], 'file order, then line order');
    assert.equal(out.total, 3);
    assert.equal(out.testsLeft, 1);
    const all = selectFunctionTexts(corpus, { includeTests: true });
    assert.equal(all.rows.length, 4);
    assert.equal(all.testsLeft, 0);
  });

  it('a filter matches file@function, as a substring or a /regex/', () => {
    assert.deepEqual(selectFunctionTexts(corpus, { filter: 'gate.js@assert' }).rows.map((r) => r.f.name), ['assertLocalOnly']);
    assert.deepEqual(selectFunctionTexts(corpus, { filter: '/catalog\\.js@load/' }).rows.map((r) => r.f.name), ['loadCatalog']);
    const none = selectFunctionTexts(corpus, { filter: 'checksGate' });
    assert.equal(none.rows.length, 0);
    assert.equal(none.testsLeft, 1, 'the filter matched only a test function: the count says so');
  });

  it('--text-has keeps the functions whose embedded text matches, and combines with the name filter and a mechanism', () => {
    // "air-gapped" is in assertLocalOnly's comment and nowhere in its name or file.
    assert.deepEqual(selectFunctionTexts(corpus, { textFilter: 'air-gapped' }).rows.map((r) => r.f.name), ['assertLocalOnly']);
    assert.deepEqual(selectFunctionTexts(corpus, { textFilter: 'AIR-GAPPED' }).rows.map((r) => r.f.name), ['assertLocalOnly'], 'any case');
    assert.deepEqual(selectFunctionTexts(corpus, { textFilter: '/libr.ries|cloud call/' }).rows.map((r) => r.f.name), ['loadCatalog', 'assertLocalOnly'], 'a /regex/');
    assert.equal(selectFunctionTexts(corpus, { textFilter: 'air-gapped', filter: 'catalog.js' }).rows.length, 0, 'both filters must hold');
    assert.deepEqual(selectFunctionTexts(corpus, { textFilter: 'libraries', want: new Set(['src/catalog.js@loadCatalog', 'src/gate.js@assertLocalOnly']) }).rows.map((r) => r.f.name), ['loadCatalog']);
    assert.equal(selectFunctionTexts(corpus, { textFilter: 'airGapped' }).rows.length, 0, 'the text holds identifiers as words ("air gapped"), not as written in the source');
    const lines = formatFunctionTexts(selectFunctionTexts(corpus, { textFilter: 'air-gapped' }), { indexPath: '.x', textFilter: 'air-gapped', mechs: mechanismsOfFunctions(ENTRIES) });
    assert.match(lines[0], /^1 function text whose text holds "air-gapped", of 3 in \.x: /);
    assert.match(lines.join('\n'), /^src\/gate\.js@assertLocalOnly {2}\(L2-5; in m1 m12\)\n {4}assert local only: /m, 'the match comes under its file@function line');
  });

  it('names the mechanisms holding each function, lowest id first, a folded entry by its own id', () => {
    const of = mechanismsOfFunctions(ENTRIES);
    assert.deepEqual(of.byId.get('src/gate.js@assertLocalOnly'), ['m1', 'm12']);
    assert.deepEqual(of.byId.get('src/catalog.js@loadCatalog'), ['m12']);
    assert.equal(of.byId.get('src/gate.js@tiny'), undefined);
  });

  it('tells a function no mechanism holds from a second definition that a mechanism holds but the embedding join misses', () => {
    // The index names a second definition of a name in one file `name@<line>`; a mechanism lists
    // both under the bare name, and the join by file@name (what the embedding commands use)
    // reaches only the first. Seen on CodeExam's own index, 2026-11-22: 32 such functions.
    const files = { 'src/twice.js': ['function poll(a) {', '  return a;', '}', 'function poll(a, b) {', '  return b;', '}', 'function lone() { return 0; }'] };
    const c2 = buildCorpus({ 'src/twice.js': { poll: { start: 1, end: 3 }, 'poll@4': { start: 4, end: 6 }, lone: { start: 7, end: 7 } } }, (f) => files[f]);
    const entries = [{ id: 'm7', label: '[file] twice.js', members: [{ file: 'src/twice.js', name: 'poll', start: 1, end: 3 }, { file: 'src/twice.js', name: 'poll', start: 4, end: 6 }] }];
    const of = mechanismsOfFunctions(entries);
    const fn = (name) => c2.fns.find((f) => f.name === name);
    assert.deepEqual(standingOf(fn('poll'), of), { ids: ['m7'], embedded: true });
    assert.deepEqual(standingOf(fn('poll@4'), of), { ids: ['m7'], embedded: false }, 'held by line, not reached by name');
    assert.deepEqual(standingOf(fn('lone'), of), { ids: [], embedded: false });
    const text = formatFunctionTexts(selectFunctionTexts(c2), { indexPath: '.x', mechs: of }).join('\n');
    assert.match(text, /For 2 of these the two commands embed no text \(1 in no mechanism, 1 a second definition of a name in its file\); they are marked\./);
    // function-text-embedding-gaps-and-gui, part A: the join the commands now make reaches the
    // second definition by its start line, so it is embedded and only `lone` is left marked.
    const idOf = memberResolver(c2.fns);
    assert.equal(idOf(entries[0].members[0]), 'src/twice.js@poll');
    assert.equal(idOf(entries[0].members[1]), 'src/twice.js@poll@4', 'the second definition is its own function');
    assert.equal(idOf({ file: 'src\\twice.js', name: 'poll' }), 'src/twice.js@poll', 'a member with no start line resolves by name, as before');
    assert.equal(idOf({ file: 'src/twice.js', name: 'poll', start: 99 }), 'src/twice.js@poll', 'a start line the index has no definition at falls back to the name');
    assert.equal(idOf({ file: 'src/twice.js', name: 'gone', start: 4 }), 'src/twice.js@gone');
    const reached = mechanismsOfFunctions(entries, idOf);
    assert.deepEqual(standingOf(fn('poll@4'), reached), { ids: ['m7'], embedded: true });
    const after = formatFunctionTexts(selectFunctionTexts(c2), { indexPath: '.x', mechs: reached }).join('\n');
    assert.match(after, /For 1 of these the two commands embed no text \(1 in no mechanism\); they are marked\./);
    assert.match(after, /^src\/twice\.js@poll@4 {2}\(L4-6; in m7\)$/m);
    assert.match(text, /^src\/twice\.js@poll {2}\(L1-3; in m7\)$/m);
    assert.match(text, /^src\/twice\.js@poll@4 {2}\(L4-6; in m7, not embedded: a second definition of this name in the file\)$/m);
    assert.match(text, /^src\/twice\.js@lone {2}\(L7-7; in no mechanism, not embedded\)$/m);
  });

  it('length figures: shortest, median, longest, and how many are short', () => {
    const s = lengthStats([{ text: 'a'.repeat(10) }, { text: 'a'.repeat(50) }, { text: 'a'.repeat(300) }]);
    assert.deepEqual(s, { shortest: 10, median: 50, longest: 300, under: 1, short: 40 });
  });
});

describe('--show-function-text: the listing', () => {
  const mechs = mechanismsOfFunctions(ENTRIES);

  it('header says what the text is and how it is made; each entry is file@function, lines, ids, then the text', () => {
    const lines = formatFunctionTexts(selectFunctionTexts(corpus), { indexPath: '.x', mechs });
    assert.match(lines[0], /^3 function texts in \.x: what --semantic-search and --embed-distance --function-text embed for each function\.$/);
    assert.match(lines[1], /no model \(the "comments" form\): the name as words/);
    assert.match(lines[2], /Characters: shortest \d+, median \d+, longest \d+; under 40: \d+\.$/);   // the count of test functions left out is the closing line, printed by doShowFunctionText
    assert.match(lines[3], /ids of the mechanisms that hold it \(as --mechanisms shows them\)\. For 1 of these the two commands embed no text \(1 in no mechanism\); they are marked\./);
    const text = lines.join('\n');
    assert.match(text, /^src\/gate\.js@assertLocalOnly {2}\(L2-5; in m1 m12\)\n {4}assert local only: /m);
    assert.match(text, /^src\/catalog\.js@loadCatalog {2}\(L1-4; in m12\)$/m);
    assert.match(text, /^src\/gate\.js@tiny {2}\(L6-6; in no mechanism, not embedded\)$/m);
  });

  it('an index with no mechanisms file: texts without ids, and a line that says why', () => {
    const lines = formatFunctionTexts(selectFunctionTexts(corpus), { indexPath: '.x', mechs: null, exe: 'ce' });
    assert.match(lines[3], /No mechanism ids, and nothing is embedded yet: this index has no mechanisms file \(ce --index-path \.x --build-mechanisms writes one\)\./);
    assert.match(lines.join('\n'), /^src\/gate\.js@assertLocalOnly {2}\(L2-5\)$/m);
  });

  it('the cap: entries past it are counted, with how to see them', () => {
    const lines = formatFunctionTexts(selectFunctionTexts(corpus), { indexPath: '.x', mechs, max: 1 });
    assert.equal(lines.filter((l) => /^\S+@\S+ {2}\(L/.test(l)).length, 1);
    assert.match(lines[lines.length - 1], /\+2 more function texts \(use --max-results <N> or --all-results to see all\)/);
    const all = formatFunctionTexts(selectFunctionTexts(corpus), { indexPath: '.x', mechs, max: Infinity });
    assert.doesNotMatch(all.join('\n'), /more function texts/);
  });

  it('-v shows the pieces apart with their lengths', () => {
    const sel = selectFunctionTexts(corpus, { filter: 'assertLocalOnly' });
    for (const r of sel.rows) r.parts = functionTextParts(r.f, corpus);
    const text = formatFunctionTexts(sel, { indexPath: '.x', mechs, verbose: true, filter: 'assertLocalOnly' }).join('\n');
    assert.match(text, /^1 function text matching "assertLocalOnly", of 3 in \.x/);
    assert.match(text, /^ {6}\d+ characters:$/m);
    assert.match(text, /^ {6}name +17 chars {2}assert local only$/m);
    assert.match(text, /^ {6}identifiers +\d+ chars {2}\S/m);
    assert.match(text, /^ {6}comment +\d+ chars {2}Refuse a cloud call/m);
    assert.match(text, /^ {6}strings +\d+ chars/m);
  });
});

describe('--show-function-text: the command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-show-fn-text-'));
  const fakeIndex = (withMechanisms) => {
    const indexPath = path.join(dir, withMechanisms ? 'with' : 'without');
    fs.mkdirSync(indexPath, { recursive: true });
    const index = { indexPath, functionIndex: FUNCTION_INDEX, fileLines: new Map(Object.entries(FILES)) };
    if (withMechanisms) fs.writeFileSync(mechanismsPath(index), JSON.stringify({ format: MECHANISMS_FORMAT, version: 1, generated: '2026-11-10T00:00:00.000Z', records: ENTRIES.map(({ aliases, ...r }) => r) }));
    return index;
  };
  const run = (index, argv) => {
    const out = [], err = [], log = console.log, error = console.error, code = process.exitCode;
    console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => err.push(a.join(' '));
    process.exitCode = 0;
    try { doShowFunctionText(index, parseArgs(['--index-path', index.indexPath, ...argv]), { exe: 'ce' }); } finally { console.log = log; console.error = error; }
    const got = { out: out.join('\n'), err: err.join('\n'), code: process.exitCode || 0 };
    process.exitCode = code;
    return got;
  };

  it('lists every function outside tests, with ids from the mechanisms file', () => {
    const r = run(fakeIndex(true), ['--show-function-text']);
    assert.equal(r.code, 0);
    assert.match(r.out, /^3 function texts in /);
    assert.match(r.out, /^src\/gate\.js@assertLocalOnly {2}\(L2-5; in m1 m12\)$/m);
    assert.doesNotMatch(r.out, /checksGate/);
  });

  it('id:mNNN lists one mechanism\'s functions and is never read as a filter', () => {
    const r = run(fakeIndex(true), ['--show-function-text', 'id:m12']);
    assert.match(r.out, /^2 function texts of mechanism m12 \(catalog \(loadCatalog\)\) in /);
    assert.match(r.out, /loadCatalog/);
    assert.match(r.out, /assertLocalOnly/);
    assert.doesNotMatch(r.out, /@tiny/);
  });

  it('an id the index lacks stops with exit code 2 and says how to list the ids', () => {
    const r = run(fakeIndex(true), ['--show-function-text', 'id:m999']);
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.match(r.err, /has no mechanism m999\. Its mechanisms file, built 2026-11-10, has 3 mechanisms; ce --index-path \S+ --mechanisms lists them with their ids\./);
  });

  it('a mechanism that is all test code says so, and --include-tests lists it', () => {
    const idx = fakeIndex(true);
    assert.match(run(idx, ['--show-function-text', 'id:m3']).out, /Mechanism m3 \(\[file\] test_gate\.js\) has no function the listing shows: its 1 function is test code \(--include-tests lists it\)\./);
    assert.match(run(idx, ['--show-function-text', 'id:m3', '--include-tests']).out, /^test\/test_gate\.js@checksGate {2}\(L1-3; in m3\)$/m);
  });

  it('without a mechanisms file: the texts are listed, id:mNNN is refused with exit code 2', () => {
    const idx = fakeIndex(false);
    const r = run(idx, ['--show-function-text']);
    assert.equal(r.code, 0);
    assert.match(r.out, /No mechanism ids, and nothing is embedded yet/);
    const bad = run(idx, ['--show-function-text', 'id:m1']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /has no mechanisms file, so it has no mechanism m1\./);
  });

  it('a filter that matches nothing says the filter did it', () => {
    assert.match(run(fakeIndex(true), ['--show-function-text', 'zzz']).out, /^No functions match filter "zzz" \(3 exist/);
    assert.match(run(fakeIndex(true), ['--show-function-text', 'checksGate']).out, /^No function outside test code matches filter "checksGate": 1 test function left out \(--include-tests lists it\)\.$/);
  });

  it('--text-has on the command: with id:mNNN, and the line when nothing holds the text', () => {
    const idx = fakeIndex(true);
    const r = run(idx, ['--show-function-text', 'id:m12', '--text-has', 'libraries']);
    assert.match(r.out, /^1 function text of mechanism m12 \(catalog \(loadCatalog\)\) whose text holds "libraries", of its 2 in /);
    assert.match(r.out, /^src\/catalog\.js@loadCatalog {2}\(L1-4; in m12\)$/m);
    assert.doesNotMatch(r.out, /assertLocalOnly/);
    assert.match(run(idx, ['--show-function-text', '--text-has', 'zzz']).out, /^No function has text holding "zzz"\. The text is the function's name as words, its identifiers, comments and string words, not its source: --regex searches the source\.$/);
    assert.match(run(idx, ['--show-function-text', 'id:m12', '--text-has', 'zzz']).out, /^No function of mechanism m12 has text holding "zzz"\./);
  });

  it('is one of the listings that leave tests out, so --exclude-tests is not reported as doing nothing', () => {
    assert.ok(TESTS_OUT_BY_DEFAULT_KEYS.includes('show_function_text'));
    const args = parseArgs(['--ndx', '.x', '--show-function-text', '--exclude-tests']);
    assert.equal(unreadTestOptionNote(args, (k) => args._explicit.has(k)), '');
  });
});
