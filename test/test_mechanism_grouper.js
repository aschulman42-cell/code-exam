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
import { groupMechanisms, isOverBroadNamespace, parseAnchorHeader, GROUPER_DEFAULTS } from '../src/core/mechanism-grouper.js';
import { collectAnchorGroups } from '../src/commands/pseudo-claims.js';

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
  it('defaults carry the new knobs, off', () => {
    assert.equal(GROUPER_DEFAULTS.useDocs, false);
    assert.equal(GROUPER_DEFAULTS.catalogSeed, false);
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

// parseAnchorHeader: the inverse of the formatAnchors / --rank emit grammar.
// The MECHANISM hint keeps label + purpose; the `(N fns)` count, `[P…]` tag
// (with its ranker note), and bare trailing tier tags are the annotations
// stripped so triage metadata never reaches the drafter as mechanism identity.
describe('parseAnchorHeader', () => {
  it('parses a ranked header — em-dash inside the note, purpose after', () => {
    const h = parseAnchorHeader('# [class] CodeSearchIndex  (79 fns)  [P3 codebase-specific/keep — Core index building — and graphs.]  — * Core data structure for Code Exam');
    assert.deepEqual(h, { label: '[class] CodeSearchIndex', priority: 3, purpose: '* Core data structure for Code Exam' });
  });
  it('keeps parens that belong to the label (token namesake)', () => {
    const h = parseAnchorHeader('# catalog (exportCatalogJson)  (12 fns)  [P1 standard-pattern/split — six catalogs]  — exporters and reporting');
    assert.equal(h.label, 'catalog (exportCatalogJson)');
    assert.equal(h.priority, 1);
  });
  it('parses an unranked header (no tag) with purpose', () => {
    const h = parseAnchorHeader('# dupes (structDupes)  (5 fns)  — struct-dupes detection');
    assert.deepEqual(h, { label: 'dupes (structDupes)', priority: null, purpose: 'struct-dupes detection' });
  });
  it('strips a bare trailing tier tag from a hand-tagged header', () => {
    const h = parseAnchorHeader('# Claim 1 — multisect search [P3]');
    assert.deepEqual(h, { label: 'Claim 1 — multisect search', priority: 3, purpose: '' });
  });
  it('treats [unscored] as no priority and keeps the purpose', () => {
    const h = parseAnchorHeader('# census (censusImports)  (4 fns)  [unscored]  — import census');
    assert.deepEqual(h, { label: 'census (censusImports)', priority: null, purpose: 'import census' });
  });
  it('passes a plain header through whole', () => {
    const h = parseAnchorHeader('# Claim 2 — census');
    assert.deepEqual(h, { label: 'Claim 2 — census', priority: null, purpose: '' });
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
    assert.deepEqual(collectAnchorGroups('a.js@f;b.js@g'), [{ label: null, purpose: '', specs: ['a.js@f', 'b.js@g'] }]);
  });
});
