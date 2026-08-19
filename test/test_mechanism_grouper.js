// test_mechanism_grouper.js — #284 B1 candidate-emitter (src/core/mechanism-grouper.js).
//
// class-seed fixes on a FABRICATED index — deterministic, no indexer; asserts the
// exact behaviors the dozen-wide validation fixed (leaf-merge /
// parent-disambiguation, namespace-record merge, gtest/junit class reject,
// noise-file exclusion). Recall scoring against a real corpus stays a DEV path
// (`--pseudo-claims --ground-truth <gt.lst>` on a local index) — no large vendored
// corpus is committed for it.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { groupMechanisms, isOverBroadNamespace, parseAnchorHeader, enumerateFuncs, splitDocSections, docAnchorsForGroup, formatAnchors, dominantFile, echoPairs, GROUPER_DEFAULTS, subTokens, subTokenPartition, splitOversizedGroup, detectVendoredSubtrees, copyrightHolder, isUnderVendored } from '../src/core/mechanism-grouper.js';
import { collectAnchorGroups, parseMinRank, filterGroupsByMinRank, packDisclosure, parseLineAnchor, groundAnchors, formatClaimChart, claimPreambleSnippet, formatChartToc } from '../src/commands/pseudo-claims.js';

// grouper-echo-flag-fold Phase 1: dominant-file detection + echo pairing +
// TOC annotation. Observe-only — nothing here drops or folds a group.
describe('echo flag (dominant file + pairs)', () => {
  const g = (label, files) => ({ label, members: files.map((f) => ({ file: f, name: 'x' })) });

  it('finds the dominant file at the 0.6 boundary inclusive', () => {
    assert.equal(dominantFile(g('a', ['a.js', 'a.js', 'a.js', 'b.js', 'c.js'])), 'a.js'); // 3/5 = 0.6
    assert.equal(dominantFile(g('a', ['a.js', 'a.js', 'b.js', 'c.js', 'd.js'])), null);   // 2/5 spread
    assert.equal(dominantFile({ label: 'e', members: [] }), null);
  });
  it('accepts chart-side anchors (filepath) and never counts doc anchors', () => {
    const chartGroup = { label: 'c', members: [
      { filepath: 'x.js', name: 'f1' }, { filepath: 'x.js', name: 'f2' },
      { filepath: 'README.md', kind: 'lines', start: 1, end: 10 },
    ] };
    assert.equal(dominantFile(chartGroup), 'x.js'); // 2/2 code members; doc excluded
  });
  it('pairs same-dominant-file groups, smaller flagged toward larger', () => {
    const host = g('big (main)', ['j.js', 'j.js', 'j.js', 'j.js']);
    const echo = g('[file] j.js', ['j.js', 'j.js']);
    const spread = g('catalog', ['a.js', 'b.js', 'c.js', 'd.js', 'e.js']);
    const pairs = echoPairs([echo, host, spread]);
    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].host.label, 'big (main)');
    assert.equal(pairs[0].echo.label, '[file] j.js');
    assert.equal(pairs[0].file, 'j.js');
  });
  it('a 3+ cluster yields one pair per non-host; hosts never re-echo', () => {
    const a = g('a', ['f.c', 'f.c', 'f.c']);
    const b = g('b', ['f.c', 'f.c']);
    const c = g('c', ['f.c']);
    const pairs = echoPairs([c, b, a]);
    assert.equal(pairs.length, 2);
    assert.ok(pairs.every((p) => p.host.label === 'a'));
  });
  it('renders the TOC echo suffix on flagged rows only', () => {
    const toc = formatChartToc([
      { n: 1, label: 'big (main)', priority: 3, preamble: 'A method' },
      { n: 2, label: '[file] j.js', priority: 2, preamble: 'A method', echoOf: { hostN: 1, hostLabel: 'big (main)' } },
    ]).join('\n');
    assert.match(toc, /2\. \[P2\] \[file\] j\.js — "A method" — likely echo of #1 big \(main\)/);
    assert.doesNotMatch(toc, /1\. \[P3\] big \(main\).*likely echo/);
  });
});

// chart-toc-rank-display: preamble snippets as claim names + the contents table.
describe('chart TOC and rank display', () => {
  it('extracts the preamble clause up to the first colon, collapsed and truncated', () => {
    assert.equal(claimPreambleSnippet('A method for streaming parsing,\n  comprising: steps.'), 'A method for streaming parsing, comprising');
    assert.equal(claimPreambleSnippet(''), '');
    const long = claimPreambleSnippet('A method ' + 'very '.repeat(40) + 'long: x.');
    assert.ok(long.length <= 90 && long.endsWith('…'));
  });
  it('formats TOC rows with rank, label, and quoted preamble; label-only rows degrade cleanly', () => {
    const lines = formatChartToc([
      { n: 1, label: '[cmd] --candidates', priority: 3, preamble: 'A method for drafting pseudo-claims, comprising' },
      { n: 2, label: '[file] air-gapped.js', priority: null, preamble: '' },
    ]);
    assert.equal(lines[0], '## Contents');
    assert.equal(lines[2], '1. [P3] [cmd] --candidates — "A method for drafting pseudo-claims, comprising"');
    assert.equal(lines[3], '2. [file] air-gapped.js');
  });
});

describe('mechanism-grouper class-seed fixes', () => {
  const mk = (base, s) => ({ type: 'method', base_name: base, start: s, end: s + 9 }); // 10 lines >= minLines
  const cls = (base) => ({ type: 'class', base_name: base, start: 1, end: 2 });
  // No vocabulary on this stub, so extractConcepts yields no token seeds (caught
  // in multiSeedGroups) and every method flows to the class seed — exactly what we
  // want to exercise in isolation.
  const index = {
    _ensureFunctionIndex() {},
    functionIndex: {
      // Two DIFFERENT nested Builder classes — must NOT merge into one "Builder".
      'src/dialog.cpp': { 'AlertDialog::Builder': cls('Builder'), 'AlertDialog::Builder::setTitle': mk('setTitle', 10), 'AlertDialog::Builder::setMessage': mk('setMessage', 20), 'AlertDialog::Builder::setIcon': mk('setIcon', 30) },
      'src/uri.cpp': { 'Uri::Builder': cls('Builder'), 'Uri::Builder::appendPath': mk('appendPath', 10), 'Uri::Builder::appendQuery': mk('appendQuery', 20), 'Uri::Builder::build': mk('build', 30) },
      // ONE class recorded inconsistently (namespaced + bare) — must MERGE.
      'src/paint.cpp': { 'blink::Painter': cls('Painter'), 'blink::Painter::paintBackground': mk('paintBackground', 10), 'blink::Painter::paintBorder': mk('paintBorder', 20), 'Painter::paintText': mk('paintText', 30) },
      // A gtest-style class whose NAME ends in Test — must be rejected (file is not noise).
      'src/harness.cpp': { 'RenderTest': cls('RenderTest'), 'RenderTest::runA': mk('runA', 10), 'RenderTest::runB': mk('runB', 20), 'RenderTest::runC': mk('runC', 30) },
      // A test-suffixed FILE — must be excluded wholesale by the noise pre-filter.
      'src/widget_test.cpp': { 'WidgetTest::a': mk('a', 10), 'WidgetTest::b': mk('b', 20), 'WidgetTest::c': mk('c', 30) },
    },
  };
  const result = groupMechanisms(index, { indexName: 'synthetic', mode: 'multi' });
  const labels = result.groups.map((g) => g.label);

  it('does NOT merge different nested Builders into one bogus [class] Builder', () => {
    assert.ok(!labels.includes('[class] Builder'), `unexpected merged Builder group; labels=${labels.join(' | ')}`);
  });
  it('disambiguates nested classes by parent (AlertDialog::Builder vs Uri::Builder)', () => {
    assert.ok(labels.includes('[class] AlertDialog::Builder'), `missing AlertDialog::Builder; labels=${labels.join(' | ')}`);
    assert.ok(labels.includes('[class] Uri::Builder'), `missing Uri::Builder; labels=${labels.join(' | ')}`);
  });
  it('merges namespace-inconsistent records of one class (blink::Painter + bare Painter)', () => {
    const g = result.groups.find((x) => x.label === '[class] Painter');
    assert.ok(g, `missing merged Painter group; labels=${labels.join(' | ')}`);
    assert.equal(g.members.length, 3);
  });
  it('rejects gtest/junit harness classes (name ends in Test)', () => {
    assert.ok(!labels.includes('[class] RenderTest'), `RenderTest not rejected; labels=${labels.join(' | ')}`);
  });
  it('excludes noise (test-suffixed) files entirely', () => {
    const files = result.groups.flatMap((g) => g.members.map((m) => m.file));
    assert.ok(!files.some((f) => f.includes('widget_test')), 'widget_test.cpp leaked into a group');
    assert.ok(result.noiseFns >= 3, `expected the test file counted as noise; noiseFns=${result.noiseFns}`);
  });
});

// Over-broad namespace rejection (#284 small-corpus fix): an over-cap token is a
// namespace to reject ONLY if it ALSO cross-cuts many files. A concentrated
// mechanism token is kept even when it owns a big fraction of a SMALL corpus —
// which is what stops the grouper returning 0 groups on a small repo. (End-to-end
// validated on a real 3-file zlib corpus: 0 -> 1 group. Not committed as an e2e
// test — a tiny synthetic corpus doesn't surface concepts, and vendoring real
// source is the bloat we removed — so the decision helper is the regression guard.)
describe('over-broad namespace rejection', () => {
  it('keeps a concentrated over-cap token, rejects a spread-out one', () => {
    assert.equal(isOverBroadNamespace(23, 14, 1, 3), false);    // deflate-like: >cap but 1 file -> keep (the fixed misfire)
    assert.equal(isOverBroadNamespace(6, 3, 1, 3), false);      // small-corpus dominant token, concentrated -> keep
    assert.equal(isOverBroadNamespace(185, 160, 30, 26), true); // namespace: >cap AND many files -> reject
    assert.equal(isOverBroadNamespace(10, 14, 20, 3), false);   // under cap -> keep regardless of spread
    assert.equal(isOverBroadNamespace(50, 20, 3, 3), false);    // over cap but fileCount == spreadCap (not >) -> keep
  });
});

// #284 signal-rich gather knobs (--use-docs / --catalog-seed): both are
// OPT-IN, default off, and FAIL OPEN — on a stub index with no files/fileLines
// the doc-vocabulary and command-catalog paths throw internally, are caught,
// and the class seed still produces the same groups as with the flags off.
// (Live-corpus behavior is validated by the measurement runs against the
// scoring harness, not by fixtures — same discipline as the recall dev path.)
describe('signal-rich gather knobs fail open on stub indexes', () => {
  const mk = (base, s) => ({ type: 'method', base_name: base, start: s, end: s + 9 });
  const cls = (base) => ({ type: 'class', base_name: base, start: 1, end: 2 });
  const stub = {
    _ensureFunctionIndex() {},
    functionIndex: {
      'src/uri.cpp': { 'Uri::Builder': cls('Builder'), 'Uri::Builder::appendPath': mk('appendPath', 10), 'Uri::Builder::appendQuery': mk('appendQuery', 20), 'Uri::Builder::build': mk('build', 30) },
    },
  };
  it('the EXPERIMENTAL gather knobs stay off; the catalog seed is now ON', () => {
    // catalogSeed flipped to default-ON (see the command-catalog suite below):
    // it takes CE file coverage 43% -> 60% and is an exact no-op on a codebase
    // with no command surface (.sr_gh, .dspy both produce 0 [cmd] groups).
    // useDocs and literalSeed remain opt-in — both were measured to dilute as
    // well as promote, and neither has a comparable no-op guarantee.
    assert.equal(GROUPER_DEFAULTS.useDocs, false);
    assert.equal(GROUPER_DEFAULTS.catalogSeed, true);
    assert.equal(GROUPER_DEFAULTS.literalSeed, false);
  });
  it('produces identical groups with the flags on (paths fail open)', () => {
    const base = groupMechanisms(stub, { indexName: 's', mode: 'multi' });
    const flagged = groupMechanisms(stub, { indexName: 's', mode: 'multi', useDocs: true, catalogSeed: true, literalSeed: true });
    assert.deepEqual(flagged.groups.map((g) => g.label), base.groups.map((g) => g.label));
    assert.equal(flagged.groups.length, 1); // the Builder class group survives either way
  });
});

// LITERAL seed (issue-289-literal-seed): rare shared literals cluster the
// unassigned residue — membership by CONTAINING the literal (line-range
// bucketing), union across shared literals, rarity/word/spread bounds.
describe('literal seed clustering', () => {
  const fn = (base, s, e) => ({ type: 'function', base_name: base, start: s, end: e });
  // Three cross-file functions joined by two rare literals (a->b, a->c) plus
  // one function sharing only an over-spread literal. No vocabulary and no
  // classes on this stub, so token/class seeds produce nothing.
  const mkIndex = (table) => ({
    _ensureFunctionIndex() {},
    functionIndex: {
      'src/gate.js': { assertLocalOnly: fn('assertLocalOnly', 10, 20), unrelated: fn('unrelated', 30, 40) },
      'src/check.js': { startupCheck: fn('startupCheck', 5, 15) },
      'src/prov.js': { buildHeader: fn('buildHeader', 8, 18) },
    },
    ensureStringTable() { return table; },
  });
  const TABLE = [
    { value: 'air-gapped mode: no egress permitted', count: 2, locations: [
      { filepath: 'src/gate.js', line: 12 }, { filepath: 'src/check.js', line: 7 }] },
    { value: 'air-gapped provenance banner', count: 2, locations: [
      { filepath: 'src/gate.js', line: 15 }, { filepath: 'src/prov.js', line: 10 }] },
    // Over-spread: 11 containing functions would exceed maxLitSpread=10 — but
    // easier to exercise via count guard: huge count is skipped outright.
    { value: 'a common shared message everywhere', count: 99, locations: [
      { filepath: 'src/gate.js', line: 33 }, { filepath: 'src/check.js', line: 9 }] },
    // Too short / no word — never seeds.
    { value: '%s: %d\n', count: 5, locations: [
      { filepath: 'src/gate.js', line: 34 }, { filepath: 'src/check.js', line: 10 }] },
  ];

  it('unions functions sharing rare literals into one [lit] group', () => {
    const result = groupMechanisms(mkIndex(TABLE), { indexName: 's', mode: 'multi', literalSeed: true });
    const lit = result.groups.find((g) => g.label.startsWith('[lit]'));
    assert.ok(lit, `no [lit] group; labels=${result.groups.map((g) => g.label).join(' | ')}`);
    assert.equal(lit.members.length, 3); // assertLocalOnly + startupCheck + buildHeader
    assert.ok(!lit.members.some((m) => m.bare === 'unrelated'), 'over-spread/format literals must not recruit');
  });
  it('labels the group with a quoted, rarest shared literal', () => {
    const result = groupMechanisms(mkIndex(TABLE), { indexName: 's', mode: 'multi', literalSeed: true });
    const lit = result.groups.find((g) => g.label.startsWith('[lit]'));
    assert.match(lit.label, /^\[lit\] "air-gapped/);
  });
  it('stays inert when the flag is off', () => {
    const result = groupMechanisms(mkIndex(TABLE), { indexName: 's', mode: 'multi' });
    assert.ok(!result.groups.some((g) => g.label.startsWith('[lit]')));
  });
  it('does not form a group below minComm (single shared literal, 2 fns)', () => {
    const result = groupMechanisms(mkIndex([TABLE[0]]), { indexName: 's', mode: 'multi', literalSeed: true });
    assert.ok(!result.groups.some((g) => g.label.startsWith('[lit]')), 'a 2-member component must not pass minComm=3');
  });
});

// BODY-MATCH rescue (issue-289-body-match-token-seed): cutoff tokens whose
// NAME-match failed retry membership by body containment. Uses the
// conceptsList test-injectable (the extractConcepts `entries`/`catalog`
// precedent) so the stub controls the cutoff.
describe('body-match token rescue', () => {
  const fn = (base, s, e) => ({ type: 'function', base_name: base, start: s, end: e });
  // 'gapped' name-matches only 2 candidates (sub-minComm orphans); bodies
  // mention it in 2 more functions across files (a string + a call site).
  // 'deflate' name-matches 3 candidates (a real group — never rescued, so
  // its body mention inside checkStuff must NOT recruit checkStuff).
  const mkIndex = () => ({
    _ensureFunctionIndex() {},
    functionIndex: {
      'src/gate.js': { setAirGapped: fn('setAirGapped', 1, 5), assertLocal: fn('assertLocal', 10, 16) },
      'src/check.js': { airGappedStartupCheck: fn('airGappedStartupCheck', 1, 8), checkStuff: fn('checkStuff', 20, 26) },
      'src/zip.js': { deflateInit: fn('deflateInit', 1, 6), deflateRun: fn('deflateRun', 10, 15), deflateEnd: fn('deflateEnd', 20, 25) },
    },
    fileLines: new Map([
      ['src/gate.js', [
        'function setAirGapped(v) {', ' state = v;', ' return state;', ' // gate', '}',
        '', '', '', '',
        'function assertLocal(url) {', " throw new Error('air-gapped mode: no egress');", ' // guard', ' return;', ' //', ' //', '}',
      ]],
      ['src/check.js', [
        'function airGappedStartupCheck() {', ' probe();', ' //', ' //', ' //', ' //', ' //', '}',
        '', '', '', '', '', '', '', '', '', '', '',
        'function checkStuff() {', ' if (isAirGapped()) skip();', ' deflate(buf);', ' //', ' //', ' //', '}',
      ]],
      ['src/zip.js', [
        'function deflateInit() {', ' a();', ' b();', ' c();', ' d();', '}',
        '', '', '',
        'function deflateRun() {', ' a();', ' b();', ' c();', ' d();', '}',
        '', '', '', '',
        'function deflateEnd() {', ' a();', ' b();', ' c();', ' d();', '}',
      ]],
    ]),
  });
  const CONCEPTS = [{ concept: 'gapped', example: 'setAirGapped' }, { concept: 'deflate', example: 'deflateInit' }];

  it('rescues a sub-minComm token via body containment, reclaiming its name orphans', () => {
    const result = groupMechanisms(mkIndex(), { indexName: 's', mode: 'multi', bodyMatchSeed: true, conceptsList: CONCEPTS });
    const body = result.groups.find((g) => g.label.startsWith('[body] gapped'));
    assert.ok(body, `no [body] gapped group; labels=${result.groups.map((g) => g.label).join(' | ')}`);
    const bares = body.members.map((m) => m.bare).sort();
    // 2 name-orphans reclaimed + assertLocal (string) + checkStuff (call site)
    assert.deepEqual(bares, ['airGappedStartupCheck', 'assertLocal', 'checkStuff', 'setAirGapped']);
  });
  it('never rescues a token that formed a real name group', () => {
    const result = groupMechanisms(mkIndex(), { indexName: 's', mode: 'multi', bodyMatchSeed: true, conceptsList: CONCEPTS });
    const deflate = result.groups.find((g) => g.label === 'deflate (deflateInit)');
    assert.ok(deflate, 'deflate name group must survive');
    assert.equal(deflate.members.length, 3); // checkStuff's body mention of deflate must NOT recruit it there
  });
  it('rejects a rescue exceeding maxBodySpread outright', () => {
    const result = groupMechanisms(mkIndex(), { indexName: 's', mode: 'multi', bodyMatchSeed: true, conceptsList: CONCEPTS, maxBodySpread: 3 });
    assert.ok(!result.groups.some((g) => g.label.startsWith('[body]')), 'a 4-hit rescue must be rejected at cap 3');
  });
  it('stays inert when the flag is off, and fails open without fileLines', () => {
    const off = groupMechanisms(mkIndex(), { indexName: 's', mode: 'multi', conceptsList: CONCEPTS });
    assert.ok(!off.groups.some((g) => g.label.startsWith('[body]')));
    const bare = mkIndex(); delete bare.fileLines;
    const on = groupMechanisms(bare, { indexName: 's', mode: 'multi', bodyMatchSeed: true, conceptsList: CONCEPTS });
    assert.ok(!on.groups.some((g) => g.label.startsWith('[body]')));
  });
});

// #291 Part A: inline test functions (Rust #[test] family) are dropped at
// candidate enumeration — the file-level noise filter can't see test modules
// inside lib.rs, which is how a scope-leaked test "class" became a drafted
// claim on writing tests in the Bram field test.
describe('test-attributed candidate filter (#291 A)', () => {
  const stub = {
    _ensureFunctionIndex() {},
    functionIndex: {
      'src/lib.rs': {
        real_mechanism: { type: 'function', base_name: 'real_mechanism', start: 1, end: 8 },
        'IfEmpty::leaked_test_fn': { type: 'method', base_name: 'leaked_test_fn', start: 12, end: 20 },
        'IfEmpty::tokio_test_fn': { type: 'method', base_name: 'tokio_test_fn', start: 24, end: 30 },
      },
    },
    fileLines: new Map([['src/lib.rs', [
      'fn real_mechanism() {', ' a();', ' b();', ' c();', ' d();', ' e();', ' f();', '}',
      '', '',
      '#[test]',
      'fn leaked_test_fn() {', ' assert!(x);', ' //', ' //', ' //', ' //', ' //', ' //', '}',
      '', '',
      '#[tokio::test]',
      'fn tokio_test_fn() {', ' assert!(y);', ' //', ' //', ' //', ' //', '}',
    ]]]),
  };
  it('drops #[test]/#[tokio::test] functions and counts them', () => {
    const { funcs, testFns } = enumerateFuncs(stub, {});
    assert.deepEqual(funcs.map((f) => f.bare), ['real_mechanism']);
    assert.equal(testFns, 2);
  });
  it('fails open without fileLines', () => {
    const bare = { _ensureFunctionIndex() {}, functionIndex: stub.functionIndex };
    const { funcs } = enumerateFuncs(bare, {});
    assert.equal(funcs.length, 3);
  });
});

// issue-289-doc-anchor-enrichment: heading-bounded doc sections attach to
// groups as path@L anchors, concept-gated and score-thresholded.
describe('doc-anchor enrichment (issue-289)', () => {
  const DOC = [
    '# Detecting AI/ML',                       // L1
    '',
    'CE detects AI/ML constructs mechanically.',
    'The AI/ML detectors include listModels and listKernels.',
    'AI/ML hits roll up into the Hunch score.',
    '',
    '## Unrelated appendix',                   // L7
    'Nothing about the topic here.',
    'Filler line.',
    'More filler.',
  ];
  const idx = {
    fileLines: new Map([
      ['DETECTING_AI_ML.md', DOC],
      ['README.md', ['# Readme', 'General text.', 'More general text.', 'Even more.']],
      ['src/code.js', ['function x() {}']],
    ]),
  };
  const members = [{ bare: 'listModels' }, { bare: 'listKernels' }];

  it('splits heading-bounded sections with the tiny-section skip', () => {
    const secs = splitDocSections(DOC);
    assert.deepEqual(secs.map((s) => [s.start, s.end]), [[1, 10], [7, 10]]);
  });
  it('attaches the matching doc section to a class-shaped concept ("AI/ML" via normalization)', () => {
    const anchors = docAnchorsForGroup(idx, '[class] _AIMLMethods', members);
    assert.equal(anchors.length, 1, `anchors=${anchors.join(' | ')}`);
    assert.match(anchors[0], /^DETECTING_AI_ML\.md@L1-10$/);
  });
  it('never double-attaches a parent section and its overlapping child', () => {
    const anchors = docAnchorsForGroup(idx, '[class] _AIMLMethods', members, { docMinScore: 3 });
    // With a low threshold both DETECTING sections (L1-10 parent, L7-10 child
    // would not qualify — but any same-file second pick must not overlap the
    // first. At most one anchor per overlapping range.
    const perFile = {};
    for (const a of anchors) { const f = a.split('@')[0]; perFile[f] = (perFile[f] || 0) + 1; }
    for (const [f, n] of Object.entries(perFile)) assert.ok(n <= 1 || f !== 'DETECTING_AI_ML.md', `overlapping picks in ${f}`);
  });
  it('attaches nothing without a concept hit (member names alone cannot attach)', () => {
    const anchors = docAnchorsForGroup(idx, '[class] Unrelated', members);
    assert.deepEqual(anchors, []);
  });
  it('fails open without fileLines', () => {
    assert.deepEqual(docAnchorsForGroup({}, '[class] _AIMLMethods', members), []);
  });
  it('emits doc anchors FIRST in formatAnchors when docAnchorsFor is supplied', () => {
    const result = { groups: [{ label: '[class] _AIMLMethods', ids: new Set(), members: [{ file: 'src/a.js', name: 'listModels', bare: 'listModels' }] }], noiseFiles: 0, noiseFns: 0, mode: 'multi' };
    const text = formatAnchors(result, { indexName: 't', docAnchorsFor: () => ['DETECTING_AI_ML.md@L1-10'] });
    const lines = text.split('\n').filter(Boolean);
    const hdr = lines.findIndex((l) => l.startsWith('# [class] _AIMLMethods'));
    assert.equal(lines[hdr + 1], 'DETECTING_AI_ML.md@L1-10');
    assert.equal(lines[hdr + 2], 'src/a.js@listModels');
  });
});

// issue-286-doc-line-anchors: `path@L<start>[-<end>]` anchors on any indexed
// file — the docs-as-evidence channel. Grammar, grounding contract, and chart
// rendering; end-to-end resolution is verified live via a dry run.
describe('doc line anchors (issue-286)', () => {
  const docIndex = {
    fileLines: new Map([
      ['bram-main/docs/apis.md', ['# APIs', '', 'worklist routes:', '- resolve', '- mutate', '- commit', 'notes', 'more notes', 'end']],
      ['other/apis.md', ['dupe']],
    ]),
  };

  it('parses both range and single-line forms, rejecting garbage', () => {
    assert.deepEqual(parseLineAnchor('docs/apis.md@L3-6'), { file: 'docs/apis.md', start: 3, end: 6 });
    assert.deepEqual(parseLineAnchor('docs/apis.md@L7'), { file: 'docs/apis.md', start: 7, end: 7 });
    assert.equal(parseLineAnchor('a.js@func'), null);
    assert.equal(parseLineAnchor('a.md@L0'), null);
    assert.equal(parseLineAnchor('a.md@L9-3'), null);
  });
  it('grounds an in-bounds doc cite via exact or unique-suffix path', () => {
    const { grounded, dropped } = groundAnchors(docIndex, [{ file: 'bram-main/docs/apis.md', func: 'L3-6', line: 0, element: 'worklist routes' }]);
    assert.equal(dropped.length, 0);
    assert.deepEqual(grounded[0], { file: 'bram-main/docs/apis.md', func: '', start: 3, end: 6, element: 'worklist routes', kind: 'lines' });
  });
  it('drops out-of-bounds ranges and unindexed or ambiguous doc paths', () => {
    const { grounded, dropped } = groundAnchors(docIndex, [
      { file: 'bram-main/docs/apis.md', func: 'L50-60', line: 0, element: 'x' },
      { file: 'missing.md', func: 'L1-2', line: 0, element: 'y' },
      { file: 'apis.md', func: 'L1-2', line: 0, element: 'z' }, // suffix matches two files
    ]);
    assert.equal(grounded.length, 0);
    assert.equal(dropped.length, 3);
    assert.match(dropped[0].reason, /out of bounds/);
    assert.match(dropped[1].reason, /not in index/);
    assert.match(dropped[2].reason, /ambiguous/);
  });
  it('renders doc cites as path@L range with a (doc) marker in the chart', () => {
    const lines = formatClaimChart('A method, comprising: storing worklist routes in a manifest.', [
      { file: 'bram-main/docs/apis.md', func: '', start: 3, end: 6, element: 'worklist routes manifest', kind: 'lines' },
    ]);
    const body = lines.join('\n');
    assert.match(body, /`bram-main\/docs\/apis\.md@L3-6` \(doc\)/);
  });
});

// #291 Part B: pack-budget omissions disclose in the lean artifact.
describe('packDisclosure (#291 B)', () => {
  it('is empty when nothing was dropped or truncated', () => {
    assert.equal(packDisclosure({ resolved: [1, 2], truncatedAnchors: [], droppedForBudget: 0 }), '');
  });
  it('reports omitted and truncated counts against the resolved total', () => {
    const d = packDisclosure({ resolved: new Array(121), truncatedAnchors: ['a', 'b'], droppedForBudget: 113 });
    assert.match(d, /packed 8 of 121 resolved anchor/);
    assert.match(d, /113 omitted for the pack budget/);
    assert.match(d, /2 truncated/);
  });
});

// parseAnchorHeader: the inverse of the formatAnchors / --rank emit grammar.
// The MECHANISM hint keeps label + purpose; the `(N fns)` count, `[P…]` tag
// (with its ranker note), and bare trailing tier tags are the annotations
// stripped so triage metadata never reaches the drafter as mechanism identity.
describe('parseAnchorHeader', () => {
  it('parses a ranked header — em-dash inside the note, purpose after', () => {
    const h = parseAnchorHeader('# [class] CodeSearchIndex  (79 fns)  [P3 codebase-specific/keep — Core index building — and graphs.]  — * Core data structure for Code Exam');
    assert.deepEqual(h, { label: '[class] CodeSearchIndex', priority: 3, fold: 'keep', purpose: '* Core data structure for Code Exam' });
  });
  it('keeps parens that belong to the label (token namesake), carrying fold', () => {
    const h = parseAnchorHeader('# catalog (exportCatalogJson)  (12 fns)  [P1 standard-pattern/split — six catalogs]  — exporters and reporting');
    assert.equal(h.label, 'catalog (exportCatalogJson)');
    assert.equal(h.priority, 1);
    assert.equal(h.fold, 'split'); // #291 Part C
  });
  it('parses an unranked header (no tag) with purpose', () => {
    const h = parseAnchorHeader('# dupes (structDupes)  (5 fns)  — struct-dupes detection');
    assert.deepEqual(h, { label: 'dupes (structDupes)', priority: null, fold: null, purpose: 'struct-dupes detection' });
  });
  it('strips a bare trailing tier tag from a hand-tagged header', () => {
    const h = parseAnchorHeader('# Claim 1 — multisect search [P3]');
    assert.deepEqual(h, { label: 'Claim 1 — multisect search', priority: 3, fold: null, purpose: '' });
  });
  it('treats [unscored] as no priority and keeps the purpose', () => {
    const h = parseAnchorHeader('# census (censusImports)  (4 fns)  [unscored]  — import census');
    assert.deepEqual(h, { label: 'census (censusImports)', priority: null, fold: null, purpose: 'import census' });
  });
  it('passes a plain header through whole', () => {
    const h = parseAnchorHeader('# Claim 2 — census');
    assert.deepEqual(h, { label: 'Claim 2 — census', priority: null, fold: null, purpose: '' });
  });
});

// collectAnchorGroups consumes parseAnchorHeader: groups carry the CLEAN label
// + purpose (annotation-free), banner lines with no anchors are dropped.
describe('collectAnchorGroups header hygiene', () => {
  const tmp = path.join(os.tmpdir(), `ce_test_anchors_${process.pid}.lst`);
  fs.writeFileSync(tmp, [
    '# mechanism-ranker  index=.X  group-by=multi  2 groups — RANKED by m (observe-only)',
    '',
    '# [class] CodeSearchIndex  (79 fns)  [P3 codebase-specific/keep — Core — index.]  — * Core data structure',
    'a.js@f',
    '# Claim 1 — multisect [P3]',
    'b.js@g',
  ].join('\n'), 'utf8');
  after(() => { try { fs.unlinkSync(tmp); } catch { /* */ } });

  it('yields clean labels/purposes and drops the banner', () => {
    const groups = collectAnchorGroups(`@${tmp}`);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].label, '[class] CodeSearchIndex');
    assert.equal(groups[0].purpose, '* Core data structure');
    assert.deepEqual(groups[0].specs, ['a.js@f']);
    assert.equal(groups[1].label, 'Claim 1 — multisect');
    assert.equal(groups[1].purpose, '');
  });
  it('inline specs form one label-less group', () => {
    assert.deepEqual(collectAnchorGroups('a.js@f;b.js@g'), [{ label: null, priority: null, fold: null, purpose: '', specs: ['a.js@f', 'b.js@g'] }]);
  });
  it('carries the parsed priority for the --min-rank consumer', () => {
    const tmp2 = path.join(os.tmpdir(), `ce_test_rank_${process.pid}.lst`);
    fs.writeFileSync(tmp2, '# top (x)  (3 fns)  [P3 codebase-specific/keep — kernel]  — core\na.js@f\n# low (y)  (3 fns)  [P0 standard-pattern/merge — ui]  — chrome\nb.js@g\n', 'utf8');
    try {
      const groups = collectAnchorGroups(`@${tmp2}`);
      assert.deepEqual(groups.map((g) => g.priority), [3, 0]);
    } finally { try { fs.unlinkSync(tmp2); } catch { /* */ } }
  });
});

// --min-rank (pseudo-claims-min-rank): draft-time floor over parsed [P..]
// tags. Default P2 only when tags are present; untagged groups always draft.
describe('min-rank draft filter', () => {
  const g = (priority) => ({ priority });
  const ranked = [g(3), g(2), g(1), g(0), g(null)];
  const unranked = [g(null), g(null), g(null)];

  it('parses both spellings and rejects garbage', () => {
    assert.equal(parseMinRank('P2'), 2);
    assert.equal(parseMinRank('p0'), 0);
    assert.equal(parseMinRank('3'), 3);
    assert.equal(parseMinRank(null), null);
    assert.ok(Number.isNaN(parseMinRank('4')));
    assert.ok(Number.isNaN(parseMinRank('high')));
  });
  it('defaults to P2 on a tagged list, keeping untagged groups', () => {
    const r = filterGroupsByMinRank(ranked, null);
    assert.equal(r.floor, 2);
    assert.deepEqual(r.groups.map((x) => x.priority), [3, 2, null]);
    assert.equal(r.dropped, 2);
  });
  it('does not filter an unranked list by default', () => {
    const r = filterGroupsByMinRank(unranked, null);
    assert.equal(r.dropped, 0);
    assert.equal(r.groups.length, 3);
  });
  it('honors an explicit floor, untagged still drafting', () => {
    const r = filterGroupsByMinRank(ranked, 'P3');
    assert.deepEqual(r.groups.map((x) => x.priority), [3, null]);
  });
  it('explicit 0 drafts everything', () => {
    const r = filterGroupsByMinRank(ranked, '0');
    assert.equal(r.groups.length, 5);
    assert.equal(r.dropped, 0);
  });
});

// ---------------------------------------------------------------------------
// grouper-split-oversized: partition a too-large group on the LOCAL vocabulary
// of its own member names.
//
// WHY NOT RECURSION. The first implementation re-ran groupMechanisms over the
// group's members and split NOTHING: 15 of 15 oversized sr_gh groups came back
// `indivisible`, and disabling the class seed did not help. Re-running a
// clustering algorithm over one of its own output clusters reproduces that
// cluster -- the features that made those functions group together are still
// their dominant shared features. Local sub-tokens are a different feature
// space, one the parent grouping did not use.
//
// MEASURED on .sr_gh: 23 groups -> 67, only 2 still oversized (both correctly
// declined as `no-reduction`), and `--group-max 0` reproduces the pre-split
// candidates file byte-for-byte.

describe('sub-token splitting of oversized groups', () => {
  const mk = (label, names) => ({
    label,
    ids: new Set(names.map((n, i) => `${label}#${i}`)),
    members: names.map((n, i) => ({ id: `${label}#${i}`, bare: n, file: 'x.py', name: n })),
  });
  const O = { ...GROUPER_DEFAULTS, groupMax: 5 };

  it('splits snake_case and camelCase, strips leading underscores', () => {
    assert.deepEqual(subTokens('_build_lr_scheduler'), ['build', 'scheduler']);
    assert.deepEqual(subTokens('forwardBackwardBatch'), ['forward', 'backward', 'batch']);
    assert.deepEqual(subTokens('__init__'), ['init']);
  });

  it('drops tokens too short or too generic to carry a mechanism', () => {
    // The stop list is deliberately short -- frequency bounds do most of the
    // filtering, and an over-eager list would suppress real mechanisms.
    assert.deepEqual(subTokens('get_x'), []);
    assert.ok(subTokens('load_checkpoint').includes('checkpoint'));
    assert.ok(subTokens('run_training').includes('run'), 'run can be the substance of a limitation');
  });

  it('partitions on shared sub-tokens', () => {
    const g = mk('C', ['build_optimizer', 'build_scheduler', 'build_module',
      'save_checkpoint', 'load_checkpoint', 'delete_checkpoint']);
    const parts = subTokenPartition(g, { ...O, minComm: 3 });
    const labels = parts.map((p) => p.label).sort();
    assert.deepEqual(labels, ['build', 'checkpoint']);
    assert.equal(parts.reduce((n, p) => n + p.members.length, 0), 6, 'every member placed');
  });

  it('a token in nearly every member does not discriminate, so it is not a seed', () => {
    // It is what makes this ONE group; seeding on it would reproduce the parent.
    const g = mk('C', ['do_thing_a', 'do_thing_b', 'do_thing_c', 'do_thing_d']);
    assert.deepEqual(subTokenPartition(g, { ...O, minComm: 3 }), []);
  });

  it('ORPHANS go to a residual sub-group, they are not discarded', () => {
    // The first cut rejected any split leaving >40% unassigned, which was only
    // sound if orphans were dropped. Keeping them turned four rejected splits
    // into accepted ones on the sr_gh run.
    const g = mk('C', ['build_a', 'build_b', 'build_c', 'zeta', 'omega', 'kappa']);
    const parts = subTokenPartition(g, { ...O, minComm: 3 });
    const other = parts.find((p) => p.label === 'other');
    assert.ok(other, 'leftovers must survive');
    assert.equal(other.members.length, 3);
  });

  it('is DETERMINISTIC — two runs of --candidates must produce the same file', () => {
    const g = mk('C', ['alpha_run', 'beta_run', 'gamma_run', 'alpha_load', 'beta_load', 'gamma_load']);
    const a = subTokenPartition(g, { ...O, minComm: 3 }).map((p) => `${p.label}:${p.members.length}`);
    const b = subTokenPartition(g, { ...O, minComm: 3 }).map((p) => `${p.label}:${p.members.length}`);
    assert.deepEqual(a, b);
  });

  it('leaves a group at or under groupMax completely alone', () => {
    const g = mk('C', ['build_a', 'build_b', 'build_c']);
    const r = splitOversizedGroup(null, g, new Map(), { ...O, groupMax: 5 });
    assert.equal(r.groups.length, 1);
    assert.equal(r.split, null, 'no report line for a group that was never a candidate');
  });

  it('groupMax 0 disables splitting entirely — prior artifacts stay reproducible', () => {
    const g = mk('C', ['build_a', 'build_b', 'build_c', 'save_x', 'save_y', 'save_z']);
    for (const groupMax of [0, Infinity]) {
      const r = splitOversizedGroup(null, g, new Map(), { ...O, groupMax });
      assert.equal(r.groups.length, 1, `groupMax ${groupMax} must not split`);
    }
  });

  it('DECLINES rather than chunking when the group will not divide', () => {
    // Methods 1-11 of a class are not a mechanism. One oversized coherent group
    // beats three incoherent ones, so the fallback is "emit intact", never
    // "chunk by declaration order".
    const g = mk('C', ['aaa_x', 'bbb_y', 'ccc_z', 'ddd_w', 'eee_v', 'fff_u']);
    const r = splitOversizedGroup(null, g, new Map(), { ...O, groupMax: 5 });
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].members.length, 6, 'emitted intact, nothing dropped');
    assert.equal(r.split.reason, 'indivisible');
  });

  it('declines a "split" whose largest part is nearly the whole parent', () => {
    // Peeling off one small group and relabelling the rest is not a division.
    const g = mk('C', ['build_a', 'build_b', 'build_c', 'build_d', 'build_e',
      'build_f', 'build_g', 'zzz_1', 'zzz_2', 'zzz_3']);
    const r = splitOversizedGroup(null, g, new Map(), { ...O, groupMax: 5, splitMaxShare: 0.8 });
    if (r.groups.length === 1) assert.equal(r.split.reason, 'no-reduction');
    else assert.ok(r.groups.every((x) => x.members.length < 10));
  });

  it('sub-group labels name their parent, so [class] inflation stays visible', () => {
    const g = mk('[class] Trainer', ['build_a', 'build_b', 'build_c',
      'save_x', 'save_y', 'save_z']);
    const r = splitOversizedGroup(null, g, new Map(), { ...O, groupMax: 5 });
    assert.ok(r.groups.length > 1, 'this fixture should split');
    for (const s of r.groups) {
      assert.ok(s.label.startsWith('[class] Trainer / '),
        `sub-group lost its parent: ${s.label}`);
    }
  });

  it('reports the split so two runs are comparable', () => {
    const g = mk('C', ['build_a', 'build_b', 'build_c', 'save_x', 'save_y', 'save_z']);
    const r = splitOversizedGroup(null, g, new Map(), { ...O, groupMax: 5 });
    assert.ok(r.split && r.split.into, 'a split must be reported');
    assert.equal(r.split.n, 6);
    assert.ok(r.split.into.length >= 2);
  });

  it('recursion is bounded — nothing loops on an unsplittable remainder', () => {
    const names = [];
    for (let i = 0; i < 40; i += 1) names.push(`build_thing${i}`);
    const g = mk('C', names);
    const r = splitOversizedGroup(null, g, new Map(), { ...O, groupMax: 5, splitMaxDepth: 2 });
    assert.ok(Array.isArray(r.groups) && r.groups.length >= 1);
  });

  it('every member of a split parent survives somewhere', () => {
    // The item exists to raise coverage; a split that loses members would be
    // working against its own purpose.
    const g = mk('C', ['build_a', 'build_b', 'build_c', 'save_x', 'save_y', 'save_z', 'lone_wolf']);
    const r = splitOversizedGroup(null, g, new Map(), { ...O, groupMax: 5 });
    const seen = new Set(r.groups.flatMap((x) => x.members.map((m) => m.id)));
    assert.equal(seen.size, 7, 'no member may vanish in a split');
  });
});

// ---------------------------------------------------------------------------
// candidates-claim-worthiness: exclude third-party subtrees from CANDIDATE
// DISCOVERY (not from the index).
//
// MEASURED on .sr_gh: 98 of 156 grounded anchors (63%) landed in a vendored
// copy of ByteDance's verl RL framework, so 23 claims about a chain-of-thought
// faithfulness repo were about PPO batching and FSDP sharding. After exclusion
// the groups are FaithfulnessEvaluator / AgentTranscript / BaseAgent / Prompt.
//
// EVERY SIMPLER SIGNAL WAS REFUTED FIRST, which is why the rule is a
// conjunction and the tests below pin each half:
//   - path names miss `train/verl/` (not a conventional vendor directory)
//   - "differs from the project's dominant holder" is BACKWARDS on .sr_gh
//     (381/449 headered files ARE ByteDance)
//   - copyright alone is absent on .CE_081726 (0 headers in 159 files)
//   - a nested manifest alone over-triggers on the project's own sub-app

describe('third-party subtree detection', () => {
  const idx = (files) => ({ fileLines: new Map(Object.entries(files)) });
  const CR = (who) => [`# Copyright 2024 ${who}`, '#', '# Licensed under Apache 2.0', 'code'];

  it('flags a NESTED package root whose files have their own dominant holder', () => {
    const v = detectVendoredSubtrees(idx({
      'proj/src/main.py': ['def main(): pass'],
      'proj/train/setup.py': CR('Bytedance Ltd'),
      'proj/train/verl/a.py': CR('Bytedance Ltd'),
      'proj/train/verl/b.py': CR('Bytedance Ltd'),
      'proj/train/verl/c.py': CR('Bytedance Ltd'),
    }));
    assert.equal(v.length, 1);
    assert.equal(v[0].root, 'proj/train');
    assert.match(v[0].holder, /Bytedance/);
  });

  it('does NOT flag a nested manifest with no copyright headers', () => {
    // Absence of the signal is not evidence of third-party origin. This is the
    // project's own sub-app (.sr_gh's w2s_research/web_ui/frontend).
    const v = detectVendoredSubtrees(idx({
      'proj/web/package.json': ['{"name":"ui"}'],
      'proj/web/a.js': ['export const a = 1;'],
      'proj/web/b.js': ['export const b = 2;'],
      'proj/web/c.js': ['export const c = 3;'],
    }));
    assert.deepEqual(v, []);
  });

  it('does NOT flag copyright headers without a nested manifest', () => {
    const v = detectVendoredSubtrees(idx({
      'proj/a.py': CR('Acme Inc'), 'proj/b.py': CR('Acme Inc'), 'proj/c.py': CR('Acme Inc'),
    }));
    assert.deepEqual(v, []);
  });

  it('does NOT flag a manifest at the index root — that IS the project', () => {
    const v = detectVendoredSubtrees(idx({
      'setup.py': CR('Acme Inc'), 'a.py': CR('Acme Inc'), 'b.py': CR('Acme Inc'), 'c.py': CR('Acme Inc'),
    }));
    assert.deepEqual(v, []);
  });

  it('does NOT flag a subtree with no dominant holder', () => {
    const v = detectVendoredSubtrees(idx({
      'proj/x/setup.py': CR('One Corp'), 'proj/x/a.py': CR('Two Corp'),
      'proj/x/b.py': CR('Three Corp'), 'proj/x/c.py': CR('Four Corp'),
    }));
    assert.deepEqual(v, []);
  });

  it('computes the share over HEADERED files, not all files', () => {
    // .sr_gh: 866 files under train/, only 449 headered. Dividing by 866 puts a
    // genuine 85% detection at 44% and misses it entirely.
    const files = { 'p/t/setup.py': CR('Vendor Co') };
    for (let i = 0; i < 3; i += 1) files[`p/t/h${i}.py`] = CR('Vendor Co');
    for (let i = 0; i < 40; i += 1) files[`p/t/plain${i}.py`] = ['x = 1'];
    const v = detectVendoredSubtrees(idx(files));
    assert.equal(v.length, 1, '4 headered of 44 files must still flag');
    assert.equal(v[0].headered, 4);
    assert.equal(v[0].files, 44);
  });

  it('copyrightHolder normalizes affiliate boilerplate to one holder', () => {
    assert.match(copyrightHolder(['# Copyright 2024 Bytedance Ltd. and/or its affiliates']), /^Bytedance Ltd$/);
    assert.match(copyrightHolder(['/* Copyright (c) 2019-2023 Acme, Inc. All rights reserved. */']), /Acme/);
    assert.equal(copyrightHolder(['function f() {}']), null);
    assert.equal(copyrightHolder(null), null);
  });

  it('only looks at the first 25 lines — a mid-file mention is not a header', () => {
    const lines = new Array(40).fill('code');
    lines[35] = '// Copyright 2024 Somebody Else';
    assert.equal(copyrightHolder(lines), null);
  });

  it('isUnderVendored matches a subtree and tolerates backslash paths', () => {
    const v = [{ root: 'proj/train' }];
    assert.ok(isUnderVendored('proj/train/verl/a.py', v));
    assert.ok(isUnderVendored(['proj', 'train', 'verl', 'b.py'].join(String.fromCharCode(92)), v));
    assert.equal(isUnderVendored('proj/src/main.py', v), null);
    assert.equal(isUnderVendored('proj/trainer/x.py', v), null, 'prefix must be a path boundary');
  });

  it('a malformed index does not throw — detection fails open', () => {
    assert.deepEqual(detectVendoredSubtrees({}), []);
    assert.deepEqual(detectVendoredSubtrees({ fileLines: null }), []);
  });
});

// ---------------------------------------------------------------------------
// catalog-seed-default-on: group by COMMAND, not by substring.
//
// asus-CC traced why CE's own pseudo-claims never see pseudo-claims.js (#314):
// token seeding groups on a SUBSTRING of the bare function name, and `claim`
// sweeps 35 functions into one blob -- including `_printDisclaimer`
// ("dis-CLAIM-er"), `claimUp` (a different sense), and `claimsCostGate`. The
// sub-token splitter cannot divide it, because the token that UNITES the group
// is a feature noun while the tokens that would DISTINGUISH members are verbs
// that cross-cut every feature.
//
// Their conclusion was that grouping by command is "a seed CE does not have".
// CE has it -- it was opt-in and off.
//
// MEASURED, .CE_081726:  41 -> 62 groups, files 40/92 (43%) -> 55/92 (60%),
// top-file share of grouped functions 28% -> 20%.
// MEASURED, .sr_gh and .dspy: 0 [cmd] groups, byte-identical output.

describe('command-catalog seed defaults', () => {
  it('is ON by default, and CAPPED so a big command surface cannot flood', () => {
    // The cap is what makes default-on safe without sampling every corpus: the
    // seed previously iterated EVERY cli option, so a codebase with 200
    // commands could emit 200 groups. Mirrors `classes`.
    assert.equal(GROUPER_DEFAULTS.catalogSeed, true);
    assert.ok(Number.isInteger(GROUPER_DEFAULTS.catalogMax) && GROUPER_DEFAULTS.catalogMax > 0,
      'an uncapped seed is the over-proliferation risk that blocks defaulting it on');
  });

  it('fails open on a stub index — no catalog, no groups, no throw', () => {
    // Same contract as the token seed. A stub index without fileLines must not
    // break grouping; it just contributes nothing.
    const idx = { functionIndex: {}, fileLines: new Map() };
    const r = groupMechanisms(idx, { indexName: 'stub' });
    assert.ok(Array.isArray(r.groups));
  });

  it('opting out reproduces the pre-default grouping exactly', () => {
    // --no-catalog-seed must reproduce every candidates file generated before
    // the default flipped, or prior artifacts stop being comparable.
    const idx = { functionIndex: {}, fileLines: new Map() };
    const on = groupMechanisms(idx, { indexName: 'stub' });
    const off = groupMechanisms(idx, { indexName: 'stub', catalogSeed: false });
    assert.deepEqual(on.groups.map((g) => g.label), off.groups.map((g) => g.label));
  });
});

describe('the catalog cap reports what it skipped', () => {
  it('threads the counters out of BOTH seed paths', () => {
    // catalogCapped was a dead store: multiSeedGroups returned a bare array, so
    // the count could not reach groupMechanisms or formatAnchors and nothing
    // printed it. The cap was the one bound in the candidates header that was
    // silent -- and the one most likely working unobserved, since it exists
    // BECAUSE the large-command-surface corpora went unsampled.
    const idx = { functionIndex: {}, fileLines: new Map() };
    for (const mode of ['multi', 'concept']) {
      const r = groupMechanisms(idx, { indexName: 'stub', mode });
      assert.equal(typeof r.catalogMade, 'number', `${mode}: catalogMade missing`);
      assert.equal(typeof r.catalogCapped, 'number', `${mode}: catalogCapped missing`);
    }
  });

  it('says NOTHING when the cap did not fire', () => {
    // A line reading "0 skipped" on every run trains the reader to skip it, and
    // this one has to be noticed the first time it appears. Same rule as
    // `# Repaired:` in the synonymize provenance.
    const out = formatAnchors({ groups: [], noiseFiles: 0, noiseFns: 0, mode: 'multi',
      catalogMade: 3, catalogCapped: 0 }, { indexName: 'x' });
    assert.ok(!/catalog seed:/.test(out));
  });

  it('names the count when it DID fire, and says what the count is not', () => {
    // The first wording said "197 command(s) DROPPED" at --catalog-max 5. CE has
    // ~202 CLI options and only 21 ever form a group; the rest fail handler
    // resolution or minComm regardless. The counter tallies options NOT
    // EVALUATED, and claiming they were groups foregone overstated it ~10x.
    const out = formatAnchors({ groups: [], noiseFiles: 0, noiseFns: 0, mode: 'multi',
      catalogMade: 5, catalogCapped: 197 }, { indexName: 'x' });
    assert.match(out, /5 command group\(s\) formed/);
    assert.match(out, /197 further command\(s\) NOT EVALUATED/);
    assert.match(out, /not the number of groups foregone/,
      'the caveat is the point: without it the number reads ~10x its real weight');
    assert.ok(!/DROPPED/.test(out), 'the overstated wording must not come back');
  });
});
