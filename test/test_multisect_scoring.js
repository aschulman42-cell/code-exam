// test_multisect_scoring.js — chart-term-hygiene-and-rarity-scoring.
//
// Comment/annotation matches are weaker evidence than in-code matches, and
// surface area is not a score. Classification is deterministic on the line
// text multisect already records; the weight and density constants are fixed
// in the modules (no CLI option), so these tests pin the semantics.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMatchLine, COMMENT_MATCH_WEIGHT, multisectSearch } from '../src/core/multisect.js';
import { parseMultisectTerms, matchIdfScore, matchDensityFactor } from '../src/commands/multisect.js';

describe('classifyMatchLine: the observed comment shapes', () => {
  it('classifies javadoc, line comments, hash comments, and annotation-only lines as comment', () => {
    assert.equal(classifyMatchLine(' * Flags to enable CONSTANT_BITRATE_SEEKING for streams.'), 'comment');
    assert.equal(classifyMatchLine('// pick the target bitrate'), 'comment');
    assert.equal(classifyMatchLine('/* time-to-byte mapping */'), 'comment');
    assert.equal(classifyMatchLine('# python comment about reward'), 'comment');
    assert.equal(classifyMatchLine('@Target(TYPE_USE)'), 'comment');
    assert.equal(classifyMatchLine('@Deprecated'), 'comment');
  });
  it('classifies code as code, including C preprocessor lines and synthetic details', () => {
    assert.equal(classifyMatchLine('int bitrate = format.bitrate;'), 'code');
    assert.equal(classifyMatchLine('def compute_reward(x):'), 'code');
    assert.equal(classifyMatchLine('#include "bitrate.h"'), 'code');
    assert.equal(classifyMatchLine('#define MAX_RATE 5'), 'code');
    assert.equal(classifyMatchLine('[name match: updateSelectedTrack]'), 'code');
    assert.equal(classifyMatchLine('[path match: a/b.js]'), 'code');
  });
});

describe('matchIdfScore: comment weight and density factor', () => {
  const idfs = [2, 2, 2, 2];
  it('a comment-only match contributes COMMENT_MATCH_WEIGHT of its IDF', () => {
    const allCode = { matched_indices: new Set([0, 1]), code_matched_indices: [0, 1], lines: 50 };
    const oneComment = { matched_indices: new Set([0, 1]), code_matched_indices: [0], lines: 50 };
    assert.equal(matchIdfScore(allCode, idfs), 4);
    assert.equal(matchIdfScore(oneComment, idfs), 2 + 2 * COMMENT_MATCH_WEIGHT);
  });
  it('legacy shapes without code_matched_indices score at full weight, as before', () => {
    const legacy = { matched_indices: new Set([0, 1]), lines: 50 };
    assert.equal(matchIdfScore(legacy, idfs), 4);
  });
  it('density is 1.0 up to 50 lines, then decreasing and bounded (0, 1]', () => {
    assert.equal(matchDensityFactor({ lines: 10 }), 1);
    assert.equal(matchDensityFactor({ lines: 50 }), 1);
    const d500 = matchDensityFactor({ lines: 500 });
    const d5000 = matchDensityFactor({ lines: 5000 });
    assert.ok(d500 < 1 && d5000 < d500 && d5000 > 0);
    assert.ok(Math.abs(d500 - 0.5) < 1e-9);
  });
});

describe('multisectSearch: a small code-dense function outranks a large comment harvest', () => {
  // big.js: ~300-line function matching rate+target+time only in javadoc and
  // an annotation. small.js: 5-line function matching rate+target in code.
  const bigLines = ['/**',
    ' * Enables constant rate seeking. The target of this flag is',
    ' * the time-to-byte mapping.',
    ' */',
    '@Target(TYPE_USE)',
    'function bigHarvest() {'];
  for (let i = 0; i < 293; i++) bigLines.push('  doWork();');
  bigLines.push('}');
  const smallLines = [
    'function smallDense() {',
    '  const rate = pickRate();',
    '  const target = chooseTarget(rate);',
    '  return target;',
    '}',
  ];
  const boundaries = {
    'big.js': [[1, bigLines.length, 'bigHarvest']],
    'small.js': [[1, smallLines.length, 'smallDense']],
  };
  const idx = {
    fileLines: new Map([['big.js', bigLines], ['small.js', smallLines]]),
    functionIndex: {},
    _ensureFunctionIndex() {},
    _getFuncBoundaries(fp) { return boundaries[fp] || []; },
    _bisectFuncLookup(bounds, lineNum) {
      for (const [s, e, name] of bounds) if (lineNum >= s && lineNum <= e) return name;
      return null;
    },
  };
  it('weighted_terms puts the in-code match first despite fewer raw terms', () => {
    const terms = parseMultisectTerms('rate;target;time');
    const res = multisectSearch(idx, terms, { minTerms: 1, showProgress: false });
    const fns = res.function_matches.filter((m) => m.function !== '(global)');
    const big = fns.find((m) => m.function === 'bigHarvest');
    const small = fns.find((m) => m.function === 'smallDense');
    assert.ok(big && small, 'both functions matched');
    assert.equal(big.terms_matched, 3, 'big harvests all three terms');
    assert.equal(small.terms_matched, 2);
    assert.equal(big.code_matched_indices.length, 0, 'all of big\u0027s hits are comment/annotation');
    assert.equal(small.code_matched_indices.length, 2);
    assert.ok(big.weighted_terms < small.weighted_terms, 'comment-only matches weigh less');
    assert.ok(fns.indexOf(small) < fns.indexOf(big), 'code-dense function ranks first');
  });
  it('a term matched in both a comment and code counts as code', () => {
    const both = new Map([['both.js', [
      '// the rate limiter',
      'function f() {',
      '  const rate = 1;',
      '}',
    ]]]);
    const idx2 = {
      ...idx,
      fileLines: both,
      _getFuncBoundaries: () => [[1, 4, 'f']],
    };
    const terms = parseMultisectTerms('rate');
    const res = multisectSearch(idx2, terms, { minTerms: 1, showProgress: false });
    const f = res.function_matches.find((m) => m.function === 'f');
    assert.ok(f, 'function matched');
    assert.deepEqual(f.code_matched_indices, [0], 'comment-first hit upgraded to code');
    assert.equal(f.weighted_terms, 1);
  });
});
