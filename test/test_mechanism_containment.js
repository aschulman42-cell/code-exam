// test_mechanism_containment.js — the containment script with no index and no git: the citations-table parser, carrying a line across diff hunks, a cited range to its function, the best record's recall and purity, the cover; a filing's cited names matched, narrowed and scored
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// mechanism-containment-test (2026-11-14). Everything the script computes is
// pure given a page's text, a function index, the records and the diff hunks;
// git and the two JSON files are read only in its main(). The filings mode
// (a litigant's cited names as the ground truth) is tested the same way.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseKey, splitRow, parseCites, parsePage, parseHunks, mapLine, mapRange,
  functionsByFile, functionsAt, recordsByMember, scorePage, summaryRow, SUMMARY_HEAD,
  renderMarkdown, renderText, parseOwnArgs,
  scoreCited, scoreFiling, harnessCounts, filingsOf, filingRow, FILING_HEAD, renderFilings,
  callComponents, oneFunctionIds, rowLines, renderRows, ROW_HEAD, callerReading, isTestPath,
} from '../scripts/mechanism-containment.mjs';

const PAGE = [
  '# A feature',
  '',
  '| claim | where | provenance |',
  '|---|---|---|',
  '| X1 | `aa:1` | not the citations table |',
  '',
  '## Citations and provenance',
  '',
  '`aa` = `src/a.js`, `bb` =',
  '`src/b.js`. Tags: [A] notes.',
  '',
  '| claim | where | provenance |',
  '|---|---|---|',
  '| F1 preamble | `docs/GUIDE.md:3-9`; a transcript | A |',
  '| F1(a) | `aa:10-20` (`alpha`; called at 15), `aa:40` (`LIMIT`) | A→C |',
  '| F1(b) | `aa:30-52`: first part 31-35, second `44-52`; `src/c.js:7`, `9-12` | C |',
  '| F2 | `bb:~5-8`, `bb:90+`; `aa`; `--some-flag`; `test/test_a.js:1-4` | C |',
  '| F3 | `aa:60` (a `x \\| y` pipe in code), `aa:25` (a table between functions) | C |',
  '',
  'Tests that pin rows: `aa:70-80` is prose after the table.',
  '',
  '## Next section',
  '',
  '| claim | where | provenance |',
  '|---|---|---|',
  '| Z1 | `aa:99` | no |',
].join('\n');

describe('the citations table', () => {
  it('reads the abbreviation key, across a line break', () => {
    const key = parseKey('`aa` = `src/a.js`, `bb` =\n`src/b.js`.');
    assert.equal(key.get('aa'), 'src/a.js');
    assert.equal(key.get('bb'), 'src/b.js');
  });

  it('splits a row on pipes outside code spans only', () => {
    assert.deepEqual(splitRow('| F3 | `aa:60` (a `x | y` pipe) | C |'), ['F3', '`aa:60` (a `x | y` pipe)', 'C']);
  });

  it('takes the table under the heading, not one above it or after the next heading', () => {
    const { rows } = parsePage(PAGE);
    assert.deepEqual(rows.map((r) => r.claim), ['F1 preamble', 'F1(a)', 'F1(b)', 'F2', 'F3']);
  });

  it('reads key and path cites, ranges, single lines, and the name beside a cite', () => {
    const { rows } = parsePage(PAGE);
    const a = rows[1].cites;
    assert.deepEqual(a.map((c) => [c.file, c.start, c.end, c.named]), [
      ['src/a.js', 10, 20, 'alpha'],
      ['src/a.js', 40, 40, 'LIMIT'],
    ]);
  });

  it('gives a bare range to the file before it, and leaves numbers in prose alone', () => {
    const { rows } = parsePage(PAGE);
    assert.deepEqual(rows[2].cites.map((c) => `${c.file}:${c.start}-${c.end}`), [
      'src/a.js:30-52', 'src/a.js:44-52', 'src/c.js:7-7', 'src/c.js:9-12',
    ]);
  });

  it('marks approximate and open cites, keeps a file with no line apart, and skips flags', () => {
    const { rows } = parsePage(PAGE);
    const c = rows[3].cites;
    assert.deepEqual(c.map((x) => x.raw), ['bb:~5-8', 'bb:90+', 'aa', 'test/test_a.js:1-4']);
    assert.equal(c[0].approx, true);
    assert.equal(c[1].open, true);
    assert.equal(c[2].fileOnly, true);
  });

  it('a doc named without a folder is a docs/ cite; an unknown key is no cite', () => {
    assert.equal(parseCites('`GUIDE.md:19-25`')[0].file, 'docs/GUIDE.md');
    assert.deepEqual(parseCites('`zz:12`, `15,000`, `getTop(200)`'), []);
  });

  it('a page with no citations section has no rows', () => {
    assert.deepEqual(parsePage('# Nothing\n\n| claim | where | provenance |\n|---|---|---|\n| A | `x:1` | y |\n').rows, []);
  });
});

describe('carrying a line from the keyed commit to the index tree', () => {
  // old lines 1..30. Ten lines inserted after old 4; old 12-13 rewritten as three lines; old 20-21 deleted.
  const hunks = parseHunks([
    'diff --git a/src/a.js b/src/a.js',
    '@@ -4,0 +5,10 @@ context',
    '@@ -12,2 +22,3 @@',
    '@@ -20,2 +30,0 @@',
    '@@ -28 +37 @@',
  ].join('\n'));

  it('parses counts, with 1 as the default', () => {
    assert.deepEqual(hunks[0], { oldStart: 4, oldCount: 0, newStart: 5, newCount: 10 });
    assert.deepEqual(hunks[3], { oldStart: 28, oldCount: 1, newStart: 37, newCount: 1 });
  });

  it('leaves lines above the first change, shifts lines below an insertion', () => {
    assert.deepEqual(mapLine(hunks, 4), { line: 4, edited: false });
    assert.deepEqual(mapLine(hunks, 5), { line: 15, edited: false });
    assert.deepEqual(mapLine(hunks, 11), { line: 21, edited: false });
  });

  it('a rewritten line maps into its replacement and says it was edited', () => {
    assert.deepEqual(mapLine(hunks, 12), { line: 22, edited: true });
    assert.deepEqual(mapLine(hunks, 13), { line: 23, edited: true });
    assert.deepEqual(mapLine(hunks, 14), { line: 25, edited: false });
  });

  it('a deleted line maps to where it was and says so; lines below close up', () => {
    assert.equal(mapLine(hunks, 20).edited, true);
    assert.deepEqual(mapLine(hunks, 22), { line: 31, edited: false });
  });

  it('a range is moved when it shifts and edited when anything in it changed', () => {
    assert.deepEqual(mapRange(hunks, 1, 3), { start: 1, end: 3, edited: false, moved: false });
    assert.deepEqual(mapRange(hunks, 5, 8), { start: 15, end: 18, edited: false, moved: true });
    assert.equal(mapRange(hunks, 10, 16).edited, true);
    assert.equal(mapRange(hunks, 2, 6).edited, true, 'an insertion inside the range');
    assert.deepEqual(mapRange([], 7, 9), { start: 7, end: 9, edited: false, moved: false });
  });
});

describe('a cited range to its function', () => {
  const fns = functionsByFile({
    'src\\a.js': {
      alpha: { start: 10, end: 20, type: 'function' },
      outer: { start: 30, end: 60, type: 'function' },
      inner: { start: 40, end: 45, type: 'function' },
      Thing: { start: 1, end: 200, type: 'class' },
      tiny: { start: 70, end: 71, type: 'function' },
    },
  }).get('src/a.js');

  it('normalizes the path and leaves type definitions out', () => {
    assert.deepEqual(fns.map((f) => f.name), ['alpha', 'outer', 'inner', 'tiny']);
  });

  it('inside nested functions: the innermost that holds the whole range', () => {
    assert.deepEqual(functionsAt(fns, 41, 43).map((f) => f.name), ['inner']);
    assert.deepEqual(functionsAt(fns, 35, 50).map((f) => f.name), ['outer']);
  });

  it('a range wider than a function (the comment above it) cites the function, not its helpers', () => {
    assert.deepEqual(functionsAt(fns, 27, 60).map((f) => f.name), ['outer']);
  });

  it('a range across functions cites each; a range in none cites none', () => {
    assert.deepEqual(functionsAt(fns, 15, 35).map((f) => f.name), ['alpha', 'outer']);
    assert.deepEqual(functionsAt(fns, 22, 28), []);
  });
});

describe('scoring a page against the records', () => {
  const fnsByFile = functionsByFile({
    'src/a.js': {
      alpha: { start: 10, end: 20, type: 'function' },
      beta: { start: 30, end: 52, type: 'function' },
      tiny: { start: 60, end: 61, type: 'function' },
    },
    'src/b.js': { gamma: { start: 1, end: 9, type: 'function' }, delta: { start: 85, end: 99, type: 'function' } },
    'test/test_a.js': { t: { start: 1, end: 9, type: 'function' } },
  });
  const records = [
    { id: 'm1', label: '[file] a.js', kind: 'file', members: [{ file: 'src/a.js', name: 'alpha' }, { file: 'src/a.js', name: 'beta' }, { file: 'src/a.js', name: 'other' }, { file: 'src/a.js', name: 'more' }] },
    { id: 'm2', label: '[cmd] --feature', kind: 'cmd', members: [{ file: 'src/a.js', name: 'alpha' }, { file: 'src/b.js', name: 'gamma' }, { file: 'src/b.js', name: 'delta' }] },
    { id: 'm3', label: '[file] b.js', kind: 'file', members: [{ file: 'src/b.js', name: 'gamma' }, { file: 'src/b.js', name: 'delta' }] },
  ];
  const byMember = recordsByMember(records);
  const { rows } = parsePage(PAGE);
  const s = scorePage(rows, fnsByFile, byMember);

  it('sets docs, tests and file-only cites aside, and counts a missing file apart', () => {
    assert.equal(s.setAside, 3, 'docs/GUIDE.md, the bare `aa`, test/test_a.js');
    assert.equal(s.notIndexed, 2, 'the two cites into src/c.js');
    assert.equal(s.cites, 10);
  });

  it('counts a cite in no function apart from recall', () => {
    assert.equal(s.noFunction, 1, 'aa:25 sits between alpha and beta');
    assert.equal(s.detail.find((d) => d.kind === 'no-function').cite.start, 25);
  });

  it('a function under the floor is a cited function in no record', () => {
    assert.equal(s.functions, 5);
    assert.equal(s.inRecord, 4);
    assert.deepEqual(s.belowFloor, ['src/a.js@tiny']);
  });

  it('the best record holds the most cited functions; recall and purity are its two shares', () => {
    assert.equal(s.best.id, 'm2');
    assert.equal(s.best.held, 3);
    assert.equal(s.best.recall, 3 / 5);
    assert.equal(s.best.purity, 1);
  });

  it('lists the records by cited functions held, the smaller first on a tie', () => {
    assert.deepEqual(s.top.map((t) => [t.id, t.held, t.size]), [['m2', 3, 3], ['m3', 2, 2], ['m1', 2, 4]]);
  });

  it('the cover is greedy and says what each record added', () => {
    assert.deepEqual(s.cover.map((c) => [c.id, c.gain]), [['m2', 3], ['m1', 1]]);
  });

  it('a row filter keeps only matching claims', () => {
    const one = scorePage(rows, fnsByFile, byMember, { rowFilter: /^F1[ (]/ });
    assert.equal(one.functions, 2);
    assert.equal(one.best.id, 'm1');
    assert.equal(one.best.purity, 2 / 4);
  });

  it('a named cite lands on the function it names, and the lines are checked against it', () => {
    // Every line of src/a.js moved down 100: by line the cite is lost, by name it is found.
    const moved = () => [{ oldStart: 1, oldCount: 0, newStart: 2, newCount: 100 }];
    const m = scorePage(rows, fnsByFile, byMember, { hunksFor: moved, rowFilter: /^F1\(a\)/ });
    assert.equal(m.named, 1, 'alpha is a function of the file; LIMIT is not and is not counted');
    assert.equal(m.namedAgree, 0);
    assert.equal(m.moved, 2);
    assert.deepEqual(m.detail.find((d) => d.kind === 'function').landed.map((l) => l.id), ['src/a.js@alpha']);
    assert.equal(s.named, 1);
    assert.equal(s.namedAgree, 1);
  });

  it('a range that grew lands on the functions at its two ends, not on what was inserted between', () => {
    const f = functionsByFile({ 'src/a.js': {
      first: { start: 10, end: 14, type: 'function' },
      added: { start: 16, end: 40, type: 'function' },
      last: { start: 42, end: 50, type: 'function' },
    } });
    const page = [{ claim: 'G1', cites: [{ file: 'src/a.js', start: 12, end: 20, fileOnly: false, raw: 'aa:12-20', named: null }] }];
    // 26 lines inserted after old line 14: old 12-20 is now 12-46, with `added` in the middle.
    const g = scorePage(page, f, new Map(), { hunksFor: () => [{ oldStart: 14, oldCount: 0, newStart: 15, newCount: 26 }] });
    assert.deepEqual(g.detail[0].landed.map((l) => l.id), ['src/a.js@first', 'src/a.js@last']);
    assert.equal(g.edited, 1);
  });

  it('a page with nothing in a record has no best record and an empty cover', () => {
    const none = scorePage(rows, fnsByFile, new Map());
    assert.equal(none.best, null);
    assert.deepEqual(none.cover, []);
    assert.equal(none.inRecord, 0);
  });

  it('renders one summary row per page, as text and as a table', () => {
    const results = [{ name: 'feature', keyedAt: 'abc1234', score: s }];
    assert.equal(summaryRow('feature', s).length, SUMMARY_HEAD.length);
    const md = renderMarkdown(results);
    assert.match(md, /\| feature \| 10 \| 3 \| 2 \| 1 \| 5 \| 4 \| m2 \[cmd\] --feature \| 3 of 5 \(60%\) \| 3 of 3 \(100%\) \| 2 \|/);
    const txt = renderText(results, { verbose: true });
    assert.match(txt, /best record m2 \[cmd\] --feature: recall 3 of 5 \(60%\), purity 3 of 3 \(100%\)/);
    assert.match(txt, /under the four-line floor 1: src\/a\.js@tiny/);
    assert.match(txt, /F1\(a\)\s+src\/a\.js:10-20\s+alpha \[m1 m2\]/);
  });
});

describe('the script arguments', () => {
  it('reads the options and takes the rest as pages', () => {
    const o = parseOwnArgs(['--index', '.X', 'a.md', '--keyed-at', 'none', '--tree', 'abc', '--rows', '^F1', '-v', '--md', '--json', 'out.json', 'b.md']);
    assert.deepEqual(o, { index: '.X', pages: ['a.md', 'b.md'], keyedAt: 'none', tree: 'abc', rows: '^F1', verbose: true, md: true, json: 'out.json', help: false, filings: null, only: null, calls: false });
  });

  it('defaults to the scan for the keyed commit and to HEAD, and refuses an unknown option', () => {
    const o = parseOwnArgs(['--ndx', '.X']);
    assert.equal(o.keyedAt, 'auto');
    assert.equal(o.tree, 'HEAD');
    assert.throws(() => parseOwnArgs(['--nope']), /unknown option --nope/);
  });
});

describe("a litigant's filing as the ground truth", () => {
  // Two files with a same-named function each, a class with two methods, a
  // two-line accessor no mechanism carries, and a type definition.
  const functionIndex = {
    'src/key.cpp': {
      'CKey::Sign': { start: 10, end: 40, type: 'method' },
      'CKey::Check': { start: 50, end: 51, type: 'method' },
      'Verify': { start: 60, end: 90, type: 'function' },
    },
    'src/other.cpp': {
      'Other::Sign': { start: 5, end: 30, type: 'method' },
      'Helper::run': { start: 40, end: 60, type: 'method' },
      'Helper::stop': { start: 70, end: 90, type: 'method' },
      'Widget': { start: 100, end: 120, type: 'class' },
    },
  };
  const records = [
    { id: 'm1', label: '[file] key.cpp', kind: 'file', members: [{ file: 'src/key.cpp', name: 'CKey::Sign' }, { file: 'src/key.cpp', name: 'Verify' }] },
    { id: 'm2', label: '[file] other.cpp', kind: 'file', members: [{ file: 'src/other.cpp', name: 'Other::Sign' }, { file: 'src/other.cpp', name: 'Helper::run' }, { file: 'src/other.cpp', name: 'Helper::stop' }] },
  ];
  const fns = functionsByFile(functionIndex);
  const byMember = recordsByMember(records);

  it('counts each last segment once and narrows a name by its qualifier', () => {
    const s = scoreFiling(['CKey::Sign', 'key.Sign', 'Verify', 'Missing'], [], fns, byMember);
    assert.equal(s.names, 3);                 // Sign, Verify, Missing
    assert.equal(s.notIndexed, 1);
    assert.equal(s.narrowed, 1);              // Sign: two functions, the CKey one kept
    assert.equal(s.ambiguous, 0);
    assert.equal(s.strict.functions, 2);
    assert.equal(s.strict.best.id, 'm1');
    assert.equal(s.strict.best.held, 2);
    assert.equal(s.strict.cover.length, 1);
    assert.equal(s.strict.files, 1);          // both in src/key.cpp
  });

  it('narrows by a cited file when the name has no qualifier', () => {
    const s = scoreFiling(['Sign'], ['other.cpp'], fns, byMember);
    assert.equal(s.narrowed, 1);
    assert.deepEqual(s.detail[0].at, ['src/other.cpp@Other::Sign']);
    assert.equal(s.strict.best.id, 'm2');
  });

  it('leaves a name with several functions out of the strict reading and in the loose one', () => {
    const s = scoreFiling(['Sign', 'Verify'], [], fns, byMember);
    assert.equal(s.ambiguous, 1);
    assert.equal(s.strict.functions, 1);      // Verify alone
    assert.equal(s.functions, 2);
    assert.equal(s.inRecord, 2);
    assert.equal(s.best.id, 'm1');            // holds Sign (one of the two) and Verify
    assert.equal(s.cover.length, 1);
  });

  it('reads a class name as its methods, and a function under the floor as in no mechanism', () => {
    const s = scoreFiling(['Helper', 'bytes.Check'], [], fns, byMember);
    assert.equal(s.classNames, 1);
    assert.equal(s.strict.functions, 2);
    assert.equal(s.strict.inRecord, 1);
    assert.deepEqual(s.strict.belowFloor, ['Check']);
    assert.equal(s.detail.find((d) => d.name === 'Helper').kind, 'class');
  });

  it('counts a record once for a name it holds twice', () => {
    const rec = { id: 'm9', label: 'x', members: [{}, {}] };
    const s = scoreCited(new Map([['a', [rec, rec]], ['b', []]]));
    assert.equal(s.best.held, 1);
    assert.equal(s.inRecord, 1);
    assert.deepEqual(s.belowFloor, ['b']);
  });

  it("reproduces the earlier reach run's counting rule: any symbol, no narrowing, case-blind for the index", () => {
    const h = harnessCounts(['x.Sign', 'y.Sign', 'widget', 'Check', 'Helper', 'Missing'], functionIndex, records);
    assert.deepEqual(h, { names: 5, inIndex: 3, inRecord: 2 });   // Sign, widget, Check in the index; Sign and Helper in a mechanism
  });

  it('lists a manifest as filing-repository pairs with the index directory of each', () => {
    const pairs = filingsOf({ candidates: [{ id: 'f-1', claims: [1], repos: [{ org: 'o', repo: 'r', resolvedRef: 'abcdef0123' }, { org: 'o', repo: 'q', ref: '1234567' }], key: { functions: ['a'], files: ['a.c'] } }] });
    assert.deepEqual(pairs.map((p) => p.dir), ['o__r__abcdef0', 'o__q__1234567']);
    assert.deepEqual(pairs[0].names, ['a']);
    assert.deepEqual(filingsOf({}), []);
  });

  it('renders a row per pair and a total, as text and as a table', () => {
    const f = { id: 'f-1', repo: 'o/r', claims: [1], records: 2, generated: null, score: scoreFiling(['Sign', 'Verify', 'Missing'], [], fns, byMember) };
    assert.equal(filingRow(f).length, FILING_HEAD.length);
    const md = renderFilings([f], { md: true });
    assert.ok(md.includes('| f-1 | o/r | 3 | 2 | 2 | 1 | 1 | 1 | m1 [file] key.cpp | 1 of 1 | 1 | 2 of 2 | 1 |'), md);
    assert.ok(md.includes('| all | 1 filing-repository pairs | 3 | 2 | 2 | 1 | 1 | 1 |'), md);
    const txt = renderFilings([f], { verbose: true });
    assert.ok(txt.includes('matching exactly one function (or naming a class): 1, of which in a mechanism 1; matching several functions: 1'), txt);
    assert.match(txt, /Missing +not in the index/);
  });

  it('takes --filings, --only and --calls', () => {
    const o = parseOwnArgs(['--filings', 'W', '--only', 'a, b', '--calls']);
    assert.equal(o.filings, 'W');
    assert.deepEqual(o.only, ['a', 'b']);
    assert.equal(o.calls, true);
    assert.equal(parseOwnArgs(['--filings', 'W']).calls, false);
  });

  it('keeps the chart rows that cite a function, one claim limitation each', () => {
    const [pair] = filingsOf({ candidates: [{ id: 'f-1', repos: [{ org: 'o', repo: 'r', resolvedRef: 'abcdef0' }], key: { functions: ['a', 'b'] },
      rows: [{ label: '1[a]', claim: '1', limitation: 'doing a thing;', functions: ['a'], files: ['a.c'] }, { label: '1[b]', limitation: 'no code cited', functions: [] }] }] });
    assert.deepEqual(pair.chartRows, [{ label: '1[a]', claim: '1', limitation: 'doing a thing;', names: ['a'], files: ['a.c'] }]);
  });

  it('counts the groups cited functions fall into by calls: direct, one step between, a common caller', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'];
    const out = new Map([
      ['a', new Set(['b'])],            // a calls b: direct
      ['c', new Set(['x', 'lib'])],     // c calls x, x calls d: one step between
      ['x', new Set(['d'])],
      ['e', new Set(['lib'])],          // c and e share a callee only: not a link
    ]);
    const callers = new Map([['a', new Set(['main'])], ['c', new Set(['main'])]]);   // main calls a and c
    assert.deepEqual(callComponents(nodes, out), { functions: 5, direct: 4, chain: 3, commonCaller: 3 });
    assert.deepEqual(callComponents(nodes, out, callers), { functions: 5, direct: 4, chain: 3, commonCaller: 2 });
    assert.deepEqual(callComponents([], out), { functions: 0, direct: 0, chain: 0, commonCaller: 0 });
  });

  it('tells test, benchmark and example files from the rest by path', () => {
    for (const f of ['src/tests.c', 'src/tests_exhaustive.c', 'src/bench_internal.c', 'src/modules/recovery/tests_impl.h', 'sql/core/src/test/scala/X.scala', 'a/FooTest.java', 'a/FooSuite.scala', 'web/app.test.js', 'examples/demo.c']) assert.equal(isTestPath(f), true, f);
    for (const f of ['src/key.cpp', 'src/ecdsa_impl.h', 'src/attestation.c', 'src/contest/main.go', 'src/latest.js']) assert.equal(isTestPath(f), false, f);
  });

  it('reads which callers join: test callers apart, the best caller outside test code', () => {
    const nodes = ['src/a.c@a', 'src/a.c@b', 'src/b.c@c', 'src/b.c@d'];
    const out = new Map([
      ['src/tests.c@run_all', new Set(nodes)],                              // a test calls all four
      ['src/x.c@helper', new Set(['src/a.c@a', 'src/a.c@b', 'src/z.c@z'])], // a helper calls a and b
      ['src/b.c@c', new Set(['src/b.c@d'])],                                // c calls d directly
    ]);
    const callers = new Map([
      ['src/a.c@a', new Set(['src/tests.c@run_all', 'src/x.c@helper'])],
      ['src/a.c@b', new Set(['src/tests.c@run_all', 'src/x.c@helper', 'src/y.c@lone'])],
      ['src/b.c@c', new Set(['src/tests.c@run_all'])],
      ['src/b.c@d', new Set(['src/tests.c@run_all', 'src/b.c@c'])],
    ]);
    const k = callerReading(nodes, out, callers);
    assert.equal(k.joiners, 2);            // run_all and helper; lone calls one and joins nothing
    assert.equal(k.testJoiners, 1);
    assert.equal(k.groups, 1);             // the test joins everything
    assert.equal(k.groupsNoTest, 2);       // {a, b} by the helper, {c, d} by the direct call
    assert.deepEqual({ caller: k.best.caller, calls: k.best.calls, callees: k.best.callees, cited: k.best.cited }, { caller: 'src/x.c@helper', calls: 2, callees: 3, cited: false });
    assert.equal(k.list[0].caller, 'src/tests.c@run_all');
    const none = callerReading(['src/a.c@a'], out, callers);
    assert.equal(none.best, null);
    assert.equal(none.groups, 1);
  });

  it('shows the callers reading in a chart row line when it is there', () => {
    const score = scoreFiling(['CKey::Sign', 'Verify'], [], fns, byMember);
    const results = [{ id: 'f-1', repo: 'o/r', rows: [{ label: '1[a]', score, calls: { functions: 2, direct: 2, chain: 2, commonCaller: 1 }, callers: { groupsNoTest: 2, best: { calls: 1, cited: true } } }] }];
    assert.deepEqual(rowLines(results)[0].slice(-2), [2, 2]);   // a cited caller counts itself
    assert.ok(renderRows(results).includes('2 with test callers left out; best non-test caller holds 2'));
  });

  it('lists the one-function names of a score and renders a line per chart row', () => {
    const score = scoreFiling(['CKey::Sign', 'Verify', 'Helper'], [], fns, byMember);
    assert.deepEqual(oneFunctionIds(score).sort(), ['src/key.cpp@CKey::Sign', 'src/key.cpp@Verify']);   // the class name is not one function
    const results = [{ id: 'f-1', repo: 'o/r', rows: [{ label: '1[a]', score, calls: { functions: 2, direct: 2, chain: 1, commonCaller: 1 } }] }];
    const [line] = rowLines(results);
    assert.equal(line.length, ROW_HEAD.length);
    assert.deepEqual(line, ['f-1', 'o/r', '1[a]', 3, 3, 3, 2, 2, 2, 2, 1, 1, '', '']);
    assert.ok(renderRows(results, { md: true }).includes('| f-1 | o/r | 1[a] | 3 | 3 | 3 | 2 | 2 | 2 | 2 | 1 | 1 |  |  |'));
    assert.equal(renderRows([{ id: 'f-2', repo: 'o/q', rows: [] }]), '');
  });
});
