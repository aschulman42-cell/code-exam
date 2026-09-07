// test_engine_qualify.js — engine-qualify scorer: negative/positive pass rules, strongest-per-element rows
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// test_engine_qualify.js — the qualification scorer's PASS/FAIL rules.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreNegative, scorePositive, mergedRows, LONE_FLOOR } from '../scripts/engine-qualify.mjs';

const sidecar = (rows) => ({ analysed: rows.map(([target, labels]) => ({ target, elements: labels.map((l, i) => ({ element: i + 1, label: l })) })) });

describe('engine-qualify scorer', () => {
  it('zero-ABSENT on the negative fails (RUN22 shape)', () => {
    const s = scoreNegative(sidecar([['a@f', ['PRESENT', 'PARTIAL', 'PARTIAL']]]));
    assert.equal(s.pass, false);
    assert.match(s.reasons[0], /zero ABSENT/);
  });
  it('a discriminating negative passes; a lone PRESENT in a wide field fails', () => {
    assert.equal(scoreNegative(sidecar([['a@f', ['ABSENT', 'PARTIAL', 'ABSENT']]])).pass, true);
    const wide = [];
    for (let i = 0; i < LONE_FLOOR; i++) wide.push([`t${i}@f`, ['ABSENT', 'ABSENT']]);
    wide[0] = ['t0@f', ['PRESENT', 'ABSENT']];
    const s = scoreNegative(sidecar(wide));
    assert.equal(s.pass, false);
    assert.match(s.reasons[0], /lone PRESENT/);
  });
  it('the positive needs PRESENT rows; merged rows take strongest-per-element', () => {
    const many = [['a@f', ['PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PRESENT', 'PARTIAL']]];
    assert.equal(scorePositive(sidecar(many)).pass, true);
    assert.equal(scorePositive(sidecar([['a@f', ['ABSENT', 'PARTIAL']]])).pass, false);
    const m = mergedRows(sidecar([['a@f', ['ABSENT', 'PARTIAL']], ['b@g', ['PRESENT', 'ABSENT']]]));
    assert.equal(m[0].label, 'PRESENT');
    assert.equal(m[0].target, 'b@g');
  });
});
