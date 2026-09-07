// test_hunt_repeat.js — hunt-repeat harness: the run-report parser behind every reported distribution
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// test_hunt_repeat.js — the repeat-run harness's report parser.
//
// The parser is load-bearing: every distribution the harness reports is derived
// from it, so a silent parsing regression would produce confident, wrong
// numbers about model reliability — worse than no measurement.
//
// The fixture below is a synthetic report in the exact shape the command emits.
// It deliberately encodes NO expected answer about any real codebase: names are
// neutral, and the "target reach" feature is operator-supplied at runtime.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRun, parseOwnArgs, namesTarget } from '../scripts/hunt-repeat.mjs';

const REPORT = `Claim: 900 chars, 4 element(s)
Index: 1234 symbols
Mode: scavenger hunt (model searches the symbol table itself) — BLIND

Hunt: 17 tool call(s) over 6 round(s); ended: done
  1 selection(s) named no symbol from any search result — rejected.

========================================================================
 LOCATED SYMBOLS — model-proposed, index-verified
========================================================================

  [exact, function-scale] Ledger::computeBalance  (L42-70)
      src/Ledger.java
      claim element 2
      proposed as: Ledger::computeBalance
      calls: flushJournal

  [exact, function-scale] Ledger::flushJournal  (L72-95)
      src/Ledger.java
      claim element 2
      reached by navigation from Ledger::computeBalance (not model-proposed)

  [exact, class-scale 200 lines] Router  (L5-205)
      src/Router.java
      claim element 3
      proposed as: Router (refine round)

  REJECTED — named by the model but absent from every search result (1):
    Imaginary::fabricated  [element 4]
    These were not verified. A name the hunt never saw is a guess, and
    substring matching can resolve a guess to an unrelated real symbol.

  Verified 3 of 3 proposals.
  Specificity: 1/2 model-proposed symbols are function-scale (50%);
  0 ambiguous name(s); 0 not found.
`;

describe('hunt-repeat report parsing', () => {
  const r = parseRun(REPORT);

  it('reads the hunt line', () => {
    assert.equal(r.toolCalls, 17);
    assert.equal(r.rounds, 6);
    assert.equal(r.ended, 'done');
  });

  it('separates model-proposed rows from navigation-derived ones', () => {
    // Conflating them would let navigation noise inflate the apparent
    // performance of the model, which is the thing being measured.
    assert.deepEqual(r.proposed.map((p) => p.name), ['Ledger::computeBalance', 'Router']);
    assert.equal(r.navigated.length, 1);
  });

  it('strips the refine-round annotation from a proposed name', () => {
    assert.ok(r.proposed.some((p) => p.name === 'Router'), 'no "(refine round)" suffix');
  });

  it('counts distinct claim elements that drew a model-proposed citation', () => {
    assert.deepEqual([...r.elements].sort(), [2, 3]);
  });

  it('captures rejected selections with their element', () => {
    assert.equal(r.rejected.length, 1);
    assert.equal(r.rejected[0].name, 'Imaginary::fabricated');
    assert.equal(r.rejected[0].element, 4);
  });

  it('does not swallow the explanatory prose into the rejected list', () => {
    assert.ok(!r.rejected.some((x) => /These|substring/.test(x.name)));
  });

  it('reads the summary counters', () => {
    assert.equal(r.verified, 3);
    assert.equal(r.ofProposals, 3);
    assert.equal(r.ambiguous, 0);
    assert.equal(r.notFound, 0);
    assert.equal(r.fnScale, 1);
    assert.equal(r.fnScaleOf, 2);
  });

  it('detects the ungrounded flag only when present', () => {
    assert.equal(r.ungrounded, false);
    assert.equal(parseRun(`${REPORT}\n  ⚠ UNGROUNDED: the model issued NO searches`).ungrounded, true);
  });

  it('degrades safely on empty or unrecognized output', () => {
    for (const junk of ['', null, 'command not found']) {
      const p = parseRun(junk);
      assert.equal(p.toolCalls, null);
      assert.deepEqual(p.proposed, []);
      assert.equal(p.elements.size, 0);
    }
  });
});

describe('argument splitting', () => {
  const CE = ['--index-path', '.Foo', '--claim-locate', '@c.txt', '--hunt', '--blind', '--llm', 'gemini'];

  it('honors an explicit -- separator', () => {
    const o = parseOwnArgs(['--runs', '3', '--out-dir', 'runs/x', '--', ...CE]);
    assert.equal(o.runs, 3);
    assert.equal(o.out, 'runs/x');
    assert.deepEqual(o.passthrough, CE);
    assert.equal(o.inferred, false);
  });

  it('infers the split when -- is missing, in any order', () => {
    // The real failure: a dropped separator made the harness reject
    // --index-path as an unknown option, which named the wrong problem.
    const o = parseOwnArgs(['--index-path', '.Foo', '--runs', '5', '--expect', 'A::b', '--hunt']);
    assert.equal(o.inferred, true);
    assert.equal(o.runs, 5);
    assert.deepEqual(o.expect, ['A::b']);
    assert.deepEqual(o.passthrough, ['--index-path', '.Foo', '--hunt']);
  });

  it('leaves CE flags the harness does not own alone', () => {
    const o = parseOwnArgs(['--runs', '2', '--hunt-rounds', '12', '--hunt-calls', '40']);
    assert.deepEqual(o.passthrough, ['--hunt-rounds', '12', '--hunt-calls', '40']);
  });

  it('gives CE its own --out when the split is inferred', () => {
    // CE has a --out of its own. That is why the harness option is --out-dir:
    // with a shared name the inferred split could not tell whose it was, so
    // --out is deliberately CE's here and the echoed split shows it.
    const o = parseOwnArgs(['--runs', '2', '--out', 'f.txt', '--index-path', '.Foo']);
    assert.equal(o.out, null, 'harness did not claim it');
    assert.ok(o.passthrough.includes('--out'));
    assert.ok(o.passthrough.includes('f.txt'));
  });

  it('accepts --out as an alias after an explicit --, where there is no ambiguity', () => {
    const o = parseOwnArgs(['--out', 'runs/y', '--', '--index-path', '.Foo']);
    assert.equal(o.out, 'runs/y');
  });
});

describe('target matching (measurement integrity)', () => {
  const T = 'AdaptiveTrackSelection::determineIdealSelectedIndex';

  it('matches a bare citation of a qualified target', () => {
    // The live miss: a run cited `determineIdealSelectedIndex` unqualified and
    // was scored a MISS, understating the model.
    assert.equal(namesTarget('determineIdealSelectedIndex', T), true);
  });

  it('matches a qualified citation of a bare target', () => {
    assert.equal(namesTarget(T, 'determineIdealSelectedIndex'), true);
  });

  it('matches exactly and matches a differently-qualified same method', () => {
    assert.equal(namesTarget(T, T), true);
    assert.equal(namesTarget('Other::determineIdealSelectedIndex', T), true);
  });

  it('does not match a different function', () => {
    assert.equal(namesTarget('AdaptiveTrackSelection::getSelectedIndex', T), false);
    assert.equal(namesTarget('Renderer::start', T), false);
  });

  it('handles empty input without matching', () => {
    assert.equal(namesTarget('', T), false);
    assert.equal(namesTarget(T, ''), false);
  });
});

describe('ungrounded detection', () => {
  it('flags a zero-call run even when no report was printed', () => {
    // A run that selects nothing exits before the report, so it carries no
    // UNGROUNDED text. Counting it as "not ungrounded" inverts the finding.
    const r = parseRun(['Claim: 10 chars, 2 element(s)',
      'Hunt: 0 tool call(s) over 2 round(s); ended: no-commands', ''].join('\n'));
    assert.equal(r.toolCalls, 0);
    assert.equal(r.ungrounded, true);
  });

  it('still flags on the report warning', () => {
    assert.equal(parseRun(['Hunt: 5 tool call(s) over 3 round(s); ended: done',
      '  UNGROUNDED: nope'].join('\n')).ungrounded, true);
  });

  it('does not flag a normal run', () => {
    assert.equal(parseRun('Hunt: 5 tool call(s) over 3 round(s); ended: done').ungrounded, false);
  });

  it('does not flag when the hunt line is absent entirely', () => {
    assert.equal(parseRun('garbage').ungrounded, false, 'unknown is not the same as zero');
  });
});
