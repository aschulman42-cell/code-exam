// test_ranker_eval.js — ranker scoring: midranks, tie-corrected Spearman, recall@k, purity, .lst parsers
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// test_ranker_eval.js — #284 ranker-scoring-harness (src/core/ranker-eval.js).
//
// Pins the metric math on hand-computable cases — INCLUDING tied inputs, the
// case naive Spearman gets wrong — and the .lst parsers on synthetic text.
// Deterministic: no index, no LLM, no fixture files (same discipline as
// test_mechanism_ranker.js's mock drafter). The Class-A tier ground truth is
// gitignored and is NEVER referenced here; all text below is fabricated.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  midranks, spearman, recallAtK, scorePurity,
  parseAnnotatedLst, parseGtTiers, matchToGt,
} from '../src/core/ranker-eval.js';

describe('ranker-eval midranks', () => {
  it('averages tied ranks', () => {
    assert.deepEqual(midranks([10, 20, 20, 30]), [1, 2.5, 2.5, 4]);
  });
  it('handles an all-tied array', () => {
    assert.deepEqual(midranks([5, 5, 5]), [2, 2, 2]);
  });
  it('ranks a strict ordering 1..n regardless of input order', () => {
    assert.deepEqual(midranks([30, 10, 20]), [3, 1, 2]);
  });
});

describe('ranker-eval spearman (midrank / tie-corrected)', () => {
  it('is 1 for a perfectly concordant strict ordering', () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  });
  it('is -1 for a perfectly discordant ordering', () => {
    assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  });
  it('is 1 when both sides tie in the same places (tier-shaped data)', () => {
    assert.equal(spearman([3, 3, 1], [10, 10, 2]), 1);
  });
  it('is 0 when ties make the orderings uninformative about each other', () => {
    // midranks: xs -> [1.5, 1.5, 3.5, 3.5], ys -> [1.5, 3.5, 1.5, 3.5]; cov = 0.
    assert.equal(spearman([1, 1, 2, 2], [1, 2, 1, 2]), 0);
  });
  it('returns null on degenerate input (constant side, short, mismatched)', () => {
    assert.equal(spearman([2, 2, 2], [1, 2, 3]), null); // flat ordering: undefined, not 0
    assert.equal(spearman([1], [1]), null);
    assert.equal(spearman([1, 2], [1, 2, 3]), null);
  });
});

describe('ranker-eval recallAtK', () => {
  it('counts worthy keys in the top k', () => {
    const r = recallAtK(['a', 'b', 'c', 'd'], new Set(['a', 'd']), 2);
    assert.deepEqual(r, { k: 2, hits: 1, recall: 0.5 });
  });
  it('clamps k to the list length', () => {
    const r = recallAtK(['a', 'b'], new Set(['a', 'b']), 10);
    assert.equal(r.recall, 1);
  });
  it('returns null recall for an empty worthy set (no denominator)', () => {
    assert.equal(recallAtK(['a', 'b'], new Set(), 2).recall, null);
  });
});

describe('ranker-eval scorePurity', () => {
  const labelOf = (id) => (id.startsWith('x:') ? 'X' : id.startsWith('y:') ? 'Y' : null);
  it('discriminates 19+1 from 10+10 (majority-share, not span-count)', () => {
    const g19 = { label: 'g19', ids: [...Array(19)].map((_, i) => `x:${i}`).concat(['y:0']) };
    const g10 = { label: 'g10', ids: [...Array(10)].map((_, i) => `x:${i}`).concat([...Array(10)].map((_, i) => `y:${i}`)) };
    const s = scorePurity([g19, g10], labelOf);
    assert.equal(s.rows[0].purity, 0.95);
    assert.equal(s.rows[1].purity, 0.5);
    assert.equal(s.rows[0].mechanisms, 2); // both "span 2" — span alone can't tell them apart
    assert.equal(s.rows[1].mechanisms, 2);
  });
  it('excludes unlabeled members from purity and reports them as coverage', () => {
    const g = { label: 'g', ids: ['x:1', 'x:2', 'u:1', 'u:2', 'u:3'] };
    const s = scorePurity([g], labelOf);
    assert.equal(s.rows[0].purity, 1);      // both labeled members agree
    assert.equal(s.rows[0].labeled, 2);
    assert.equal(s.rows[0].total, 5);       // coverage 2/5, reported not hidden
  });
  it('gives null purity to a group with no labeled members', () => {
    const s = scorePurity([{ label: 'g', ids: ['u:1', 'u:2'] }], labelOf);
    assert.equal(s.rows[0].purity, null);
    assert.equal(s.weightedMean, null);
  });
  it('weights the corpus mean by labeled count, not per-group average', () => {
    const big = { label: 'big', ids: [...Array(9)].map((_, i) => `x:${i}`).concat(['y:0']) }; // 0.9 over 10
    const tiny = { label: 'tiny', ids: ['x:9', 'y:1'] };                                     // 0.5 over 2
    const s = scorePurity([big, tiny], labelOf);
    assert.equal(s.weightedMean, (9 + 1) / 12); // majorities 9+1 over 12 labeled — not (0.9+0.5)/2
  });
});

describe('ranker-eval parseAnnotatedLst', () => {
  const RANKED = [
    '# ILLUSTRATIVE claim-candidate ranking — a FAST, SURFACE heuristic to suggest where to',
    '# look FIRST, NOT legal analysis.',
    '#',
    '# mechanism-ranker  index=.X  group-by=multi  3 groups — RANKED by m (observe-only)',
    '',
    '# [class] CodeSearchIndex  (79 fns)  [P3 codebase-specific/keep — Core index building — and graph generation.]  — * CodeSearchIndex.js - Core data structure',
    'src/core/CodeSearchIndex.js@CodeSearchIndex::buildDigest',
    '',
    '# catalog (exportCatalogJson)  (12 fns)  [P1 standard-pattern/split — six unrelated catalogs]  — exporters and models-used reporting',
    'src/commands/catalog.js@exportCatalogJson',
    'src/core/models-used.js@modelsUsed',
    '',
    '# census (censusImports)  (4 fns)  [unscored]  — import census',
    'src/commands/census.js@censusImports',
  ].join('\n');
  const groups = parseAnnotatedLst(RANKED);

  it('drops banner/caveat # lines (no member lines) and keeps file order', () => {
    assert.deepEqual(groups.map((g) => g.label), ['[class] CodeSearchIndex', 'catalog (exportCatalogJson)', 'census (censusImports)']);
  });
  it('extracts priorities, with [unscored] as null', () => {
    assert.deepEqual(groups.map((g) => g.priority), [3, 1, null]);
  });
  it('survives an em-dash inside the [P…] note and strips (N fns)', () => {
    assert.equal(groups[0].purpose, '* CodeSearchIndex.js - Core data structure');
  });
  it('keeps parens that belong to the label (token namesake), not the (N fns) marker', () => {
    assert.equal(groups[1].label, 'catalog (exportCatalogJson)');
    assert.equal(groups[1].specs.length, 2);
  });
  it('parses the unranked emit (no tag) the same way', () => {
    const g = parseAnnotatedLst('# dupes (structDupes)  (5 fns)  — struct-dupes detection\na.js@f\n')[0];
    assert.equal(g.priority, null);
    assert.equal(g.purpose, 'struct-dupes detection');
  });
});

describe('ranker-eval parseGtTiers', () => {
  const GT = [
    '# NOTE: provenance comment with no anchors under it',
    '# Claim 1 — multisect search [P3]',
    'a.js@f',
    'a.js@g',
    '# Claim 2 — census',
    'b.js@h',
  ].join('\n');
  const groups = parseGtTiers(GT);

  it('drops comment headers with no anchors', () => {
    assert.equal(groups.length, 2);
  });
  it('reads a trailing bare [P<n>] tag and strips it from the label', () => {
    assert.equal(groups[0].tier, 3);
    assert.equal(groups[0].label, 'Claim 1 — multisect search');
    assert.deepEqual(groups[0].specs, ['a.js@f', 'a.js@g']);
  });
  it('leaves untagged headers at tier null (partial tiering is legitimate GT)', () => {
    assert.equal(groups[1].tier, null);
  });
  it('does not confuse a ranked-emit tag (with note body) for a tier tag', () => {
    const g = parseGtTiers('# Label [P2 standard-pattern/keep — note]\na.js@f\n')[0];
    assert.equal(g.tier, null); // exact-grammar tag only
  });
});

describe('ranker-eval matchToGt', () => {
  const cands = [
    { label: 'c1', ids: new Set(['a', 'b', 'c']) },
    { label: 'c2', ids: new Set(['d', 'e']) },
  ];
  it('pairs each GT group with the max-overlap candidate', () => {
    const rows = matchToGt(cands, [{ label: 'g', ids: new Set(['b', 'c', 'd']) }]);
    assert.equal(rows[0].cand.label, 'c1');
    assert.equal(rows[0].overlap, 2);
  });
  it('returns null cand on zero overlap', () => {
    const rows = matchToGt(cands, [{ label: 'g', ids: new Set(['z']) }]);
    assert.equal(rows[0].cand, null);
    assert.equal(rows[0].overlap, 0);
  });
});
