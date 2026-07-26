// test_mechanism_grouper.js — #284 B1 candidate-emitter (src/core/mechanism-grouper.js).
//
// class-seed fixes on a FABRICATED index — deterministic, no indexer; asserts the
// exact behaviors the dozen-wide validation fixed (leaf-merge /
// parent-disambiguation, namespace-record merge, gtest/junit class reject,
// noise-file exclusion). Recall scoring against a real corpus stays a DEV path
// (`--pseudo-claims --ground-truth <gt.lst>` on a local index) — no large vendored
// corpus is committed for it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { groupMechanisms } from '../src/core/mechanism-grouper.js';

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
