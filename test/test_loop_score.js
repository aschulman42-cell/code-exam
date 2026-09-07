// test_loop_score.js — loop-score: target keys, answer-key anchors, chart/control scoring, dependent grades
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// loop-score: the pseudo-claim loop's scorer (pseudo-claim-loop-test, #311).
//
// The merge is injected so these fixtures never drift from claim-chart.js's
// real rule -- the same mergeBestPerElement the chart runs is passed in here,
// and a two-line stub would do for shape tests. Each fixture isolates one
// number the scorecard reports.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetKey, anchorKeys, perturbDependent, scoreChart, scoreControl, gradeDependents, formatScorecard,
} from '../src/core/loop-score.js';
import { mergeBestPerElement } from '../src/commands/claim-chart.js';

const merge = mergeBestPerElement;
const v = (element, label) => ({ element, text: `e${element}`, label, note: '' });

describe('keys and the answer key', () => {
  it('targetKey normalizes archive prefixes, paths, class prefixes and @line suffixes', () => {
    assert.equal(targetKey('media.zip!a/b/AdaptiveTrackSelection.java@AdaptiveTrackSelection::determineIdealSelectedIndex'), 'AdaptiveTrackSelection.java@determineIdealSelectedIndex');
    assert.equal(targetKey('src/multisect.js@computeTermFileCounts@88'), 'multisect.js@computeTermFileCounts');
  });
  it('anchorKeys reads the sidecar claim and dedupes', () => {
    const keys = anchorKeys({ grounded: [
      { file: 'z.zip!x/multisect.js', func: 'computeTermFileCounts' },
      { file: 'x/multisect.js', func: 'Multi::computeTermFileCounts' },
    ] });
    assert.deepEqual([...keys], ['multisect.js@computeTermFileCounts']);
  });
});

describe('perturbDependent: one recorded edit, deterministic, honest null', () => {
  it('prefers a number, then a directional swap, then negation; records the edit', () => {
    assert.deepEqual(perturbDependent('wherein the threshold is 5 seconds'), { text: 'wherein the threshold is 6 seconds', edit: 'number 5 -> 6' });
    assert.deepEqual(perturbDependent('wherein rows are sorted in descending order'), { text: 'wherein rows are sorted in ascending order', edit: '"descending" -> "ascending"' });
    assert.deepEqual(perturbDependent('wherein the flag is set'), { text: 'wherein the flag is not set', edit: '"is" -> "is not"' });
    assert.equal(perturbDependent('further comprising logging'), null, 'no site: null, never invented');
    assert.deepEqual(perturbDependent('wherein the threshold is 5 seconds'), perturbDependent('wherein the threshold is 5 seconds'), 'deterministic');
  });
  it('never perturbs the claim reference', () => {
    assert.deepEqual(perturbDependent('The method of claim 1, wherein the threshold is 5 seconds'),
      { text: 'The method of claim 1, wherein the threshold is 6 seconds', edit: 'number 5 -> 6' },
      'the body number moves; "claim 1" does not (the run-B self-reference bug)');
    assert.deepEqual(perturbDependent('The method of claim 2, wherein rows are sorted in descending order'),
      { text: 'The method of claim 2, wherein rows are sorted in ascending order', edit: '"descending" -> "ascending"' },
      'swap path leaves the reference intact too');
    assert.equal(perturbDependent('The method of claim 1, further comprising logging'), null,
      'the reference digit is not a perturbation site: honest null');
  });
});

describe('scoreChart: recall, mechanism on-anchor vs elsewhere, generic reported not scored', () => {
  const claim = { grounded: [
    { file: 'x/m.js', func: 'a1' }, { file: 'x/m.js', func: 'a2' }, { file: 'x/m.js', func: 'a3' },
  ] };
  const verdicts = {
    elementClasses: ['preamble', 'mechanism', 'mechanism', 'generic'],
    analysed: [
      { target: 'x/m.js@a1', nominatedBy: [{ element: 2, rank: 0 }], elements: [v(1, 'ABSENT'), v(2, 'PRESENT'), v(3, 'ABSENT'), v(4, 'ABSENT')] },
      { target: 'x/m.js@a2', nominatedBy: [{ element: 3, rank: 1 }], elements: [v(1, 'ABSENT'), v(2, 'ABSENT'), v(3, 'ABSENT'), v(4, 'ABSENT')] },
      { target: 'x/other.js@o1', nominatedBy: [{ element: 3, rank: 0 }], elements: [v(1, 'PRESENT'), v(2, 'ABSENT'), v(3, 'PRESENT'), v(4, 'PRESENT')] },
    ],
  };
  const s = scoreChart({ claim, verdicts, merge });

  it('recall counts retrieved anchors: 2 of 3 analysed = 0.67', () => {
    assert.equal(s.recall, 0.67);
    assert.deepEqual(s.retrieved.map((r) => r.key).sort(), ['m.js@a1', 'm.js@a2']);
  });
  it('mechanism rows scored apart: one PRESENT on an anchor, one elsewhere; anchor support counted per row', () => {
    assert.equal(s.mechanismRows, 2);
    assert.equal(s.mechanismPresent, 2);
    assert.equal(s.mechanismPresentOnAnchor, 1, 'element 2 cites a1');
    assert.equal(s.mechanismPresentElsewhere, 1, 'element 3 cites o1 -- may be right, not the drafted truth');
    assert.equal(s.mechanismRowsAnchorSupported, 1, 'no anchor said PRESENT on element 3');
  });
  it('generic rows are reported, never in the mechanism numbers; preamble in neither', () => {
    assert.equal(s.genericRows, 1);
    assert.equal(s.genericPresent, 1);
    const el1 = s.rows.find((r) => r.element === 1);
    assert.equal(el1.class, 'preamble');
  });
  it('lone PRESENT counts single-target findings', () => {
    assert.equal(s.lonePresent, s.rows.filter((r) => r.label === 'PRESENT').length, 'every PRESENT here is 1-of-3');
  });
});

describe('scoreControl: mechanism PRESENT against an index without the mechanism is a false positive', () => {
  it('counts PRESENT and PARTIAL on mechanism rows only', () => {
    const verdicts = {
      elementClasses: ['preamble', 'mechanism', 'generic'],
      analysed: [
        { target: 'y/c.js@x', nominatedBy: [], elements: [v(1, 'PRESENT'), v(2, 'PRESENT'), v(3, 'PRESENT')] },
      ],
    };
    const c = scoreControl({ verdicts, merge });
    assert.deepEqual(c, { mechanismRows: 1, falsePresent: 1, falsePartial: 0 });
  });
});

describe('gradeDependents: real PRESENT + perturbed ABSENT discriminates; PRESENT on both is vacuous', () => {
  const fam = (labels) => ({ members: [{ n: 2, rows: [
    { designation: '[2a]', origin: 'narrowed', label: labels[0], target: 'x/m.js@a1' },
    { designation: '[1a]', origin: 'inherited', label: 'PRESENT', target: 'x/m.js@a1' },
  ] }, { n: 3, rows: [
    { designation: '[3a]', origin: 'new', label: labels[1], target: 'x/m.js@a2' },
  ] }] });
  it('pairs by designation, counts discrimination and vacuity, ignores inherited rows', () => {
    const g = gradeDependents(fam(['PRESENT', 'PRESENT']), fam(['ABSENT', 'PRESENT']));
    assert.equal(g.judged, 2);
    assert.equal(g.realPresent, 2);
    assert.equal(g.discriminating, 1, '[2a] flipped, [3a] did not');
    assert.equal(g.vacuous, 1, '[3a] PRESENT on real AND perturbed measures nothing');
  });
  it('without a perturbed run the grades carry null, not a guess', () => {
    const g = gradeDependents(fam(['PRESENT', 'ABSENT']));
    assert.equal(g.discriminating, 0);
    assert.ok(g.grades.every((x) => x.perturbed === null && x.discriminates === null));
  });
});

describe('the scorecard', () => {
  it('stamps the meta and renders one row per arm plus a dependents line', () => {
    const claim = { grounded: [{ file: 'x/m.js', func: 'a1' }] };
    const verdicts = { elementClasses: ['mechanism'], analysed: [{ target: 'x/m.js@a1', nominatedBy: [], elements: [v(1, 'PRESENT')] }] };
    const s = scoreChart({ claim, verdicts, merge });
    const md = formatScorecard([
      { n: 69, label: 'multisect', arms: { orig: s }, dependents: { judged: 2, realPresent: 2, discriminating: 1, vacuous: 1 } },
    ], { index: '.X', engine: 'stub', ce: 'vT', generatedAt: 'now' });
    assert.match(md, /index `\.X`.*engine stub.*CE vT/);
    assert.match(md, /\| 69 \(multisect\) \| orig \| 1 \| 1 \| 1 \/ 0 \|/);
    assert.match(md, /dependents \| \| 2 judged \| 2 PRESENT real \| 1 discriminate \| 1 vacuous/);
    assert.match(md, /never scored/);
  });
});
