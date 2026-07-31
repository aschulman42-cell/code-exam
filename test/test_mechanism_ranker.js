// test_mechanism_ranker.js — #284 ranker Phase 0. Tests the DETERMINISTIC pieces
// (tolerant verdict parser, priors) and drives rankCandidates with a MOCK drafter
// — no live LLM in CI. The real-model behavior is validated by the pcrun soak.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, rankPriors, rankCandidates, parseBatchVerdicts, buildBatchPrompt } from '../src/core/mechanism-ranker.js';
import { ggufContextLadder } from '../src/core/llm-runner.js';

// gguf-context-ladder: largest-first ladder, explicit --context-size at the head.
describe('gguf context ladder', () => {
  it('defaults to 16k-first with the legacy sizes behind it', () => {
    assert.deepEqual(ggufContextLadder(), [16384, 8192, 4096, 2048]);
  });
  it('puts an explicit context size first without duplicating it', () => {
    assert.deepEqual(ggufContextLadder(24576), [24576, 16384, 8192, 4096, 2048]);
    assert.deepEqual(ggufContextLadder(8192), [8192, 16384, 4096, 2048]);
  });
  it('ignores invalid explicit values', () => {
    assert.deepEqual(ggufContextLadder('x'), [16384, 8192, 4096, 2048]);
    assert.deepEqual(ggufContextLadder(0), [16384, 8192, 4096, 2048]);
  });
});

// #291 Part D: the comparative rubric demotes test clusters by rule — the
// Bram field test showed the ranker's NOTE detecting "Mixed test cluster"
// while its SCORE said P2, sailing through --min-rank.
describe('mechanism-ranker batch rubric (#291 D)', () => {
  it('carries the test-cluster demotion rule', () => {
    const { user } = buildBatchPrompt([{ label: 'x', members: [] }], { getFunctionSource: () => '' });
    assert.match(user, /TEST functions[\s\S]*go to 0 or 1 by rule/);
  });
});

describe('mechanism-ranker parseVerdict', () => {
  it('parses a bare JSON verdict', () => {
    const v = parseVerdict('{"priority": 3, "signal": "codebase-specific", "fold": "keep", "note": "purpose-built TLS state machine"}');
    assert.deepEqual(v, { priority: 3, signal: 'codebase-specific', fold: 'keep', note: 'purpose-built TLS state machine' });
  });
  it('parses JSON embedded in prose', () => {
    const v = parseVerdict('Sure — here it is:\n{"priority":1,"signal":"standard-pattern","fold":"merge","note":"resembles a textbook pool"}\nHope that helps.');
    assert.equal(v.priority, 1);
    assert.equal(v.signal, 'standard-pattern');
    assert.equal(v.fold, 'merge');
  });
  it('falls back to key:value lines', () => {
    const v = parseVerdict('priority: 2\nsignal: library-wrapper\nfold: keep\nnote: wraps OpenSSL');
    assert.equal(v.priority, 2);
    assert.equal(v.signal, 'library-wrapper');
  });
  it('tolerates the legacy worthiness/rationale field names', () => {
    const v = parseVerdict('{"worthiness": 2, "signal": "third-party", "rationale": "vendored dep"}');
    assert.equal(v.priority, 2);
    assert.equal(v.note, 'vendored dep');
  });
  it('clamps priority to 0-3 and rejects an unknown signal', () => {
    const v = parseVerdict('{"priority": 9, "signal": "banana", "fold": "keep"}');
    assert.equal(v.priority, 3);
    assert.equal(v.signal, 'unclassified');
  });
  it('defaults an invalid fold to keep', () => {
    const v = parseVerdict('{"priority":2,"signal":"codebase-specific","fold":"frobnicate"}');
    assert.equal(v.fold, 'keep');
  });
  it('returns null on unparseable / empty text', () => {
    assert.equal(parseVerdict('I could not decide.'), null);
    assert.equal(parseVerdict(''), null);
    assert.equal(parseVerdict(null), null);
  });
});

describe('mechanism-ranker rankPriors', () => {
  it('counts members and distinct files', () => {
    const g = { members: [{ file: 'a.c' }, { file: 'a.c' }, { file: 'b.c' }] };
    assert.deepEqual(rankPriors(g), { members: 3, files: 2 });
  });
});

describe('mechanism-ranker parseBatchVerdicts', () => {
  const groups = [{ label: 'a' }, { label: 'b' }, { label: 'c' }];
  it('maps an array back onto groups by the 1-based "i" field', () => {
    const arr = JSON.stringify([
      { i: 2, priority: 0, signal: 'library-wrapper', fold: 'keep', note: 'wrapper' },
      { i: 1, priority: 3, signal: 'codebase-specific', fold: 'keep', note: 'kernel' },
      { i: 3, priority: 1, signal: 'standard-pattern', fold: 'keep', note: 'routine' },
    ]);
    const out = parseBatchVerdicts(arr, groups);
    assert.equal(out[0].verdict.priority, 3); // group 1 (i:1)
    assert.equal(out[1].verdict.priority, 0); // group 2 (i:2)
    assert.equal(out[2].verdict.priority, 1); // group 3 (i:3)
  });
  it('falls back to positional order when "i" is absent', () => {
    const arr = JSON.stringify([
      { priority: 3, signal: 'codebase-specific' },
      { priority: 1, signal: 'standard-pattern' },
      { priority: 0, signal: 'generated' },
    ]);
    const out = parseBatchVerdicts(arr, groups);
    assert.deepEqual(out.map((o) => o.verdict.priority), [3, 1, 0]);
  });
  it('returns null when not an array, or too few usable verdicts', () => {
    assert.equal(parseBatchVerdicts('{"priority":2}', groups), null); // object, not array
    assert.equal(parseBatchVerdicts('nope', groups), null);
    assert.equal(parseBatchVerdicts(JSON.stringify([{ priority: 3 }]), groups), null); // 1 of 3 < half
  });
});

describe('mechanism-ranker rankCandidates (mock drafter)', () => {
  const groups = [
    { label: 'tls (x)', members: [{ file: 'c/tls.c', bare: 'tls_send', name: 'tls_send', lines: 30 }] },
    { label: '[class] Foo', members: [{ file: 'F.java', bare: 'a', name: 'Foo::a', lines: 5 }] },
  ];
  const fakeIndex = { getFunctionSource: () => 'int x() { return 1; }' };

  it('scores all candidates in ONE comparative pass', async () => {
    let calls = 0;
    const drafter = async () => {
      calls++;
      return JSON.stringify([
        { i: 1, priority: 3, signal: 'codebase-specific', fold: 'keep', note: 'tls state machine' },
        { i: 2, priority: 0, signal: 'library-wrapper', fold: 'keep', note: 'thin wrapper' },
      ]);
    };
    const scored = await rankCandidates(groups, fakeIndex, drafter, {});
    assert.equal(calls, 1); // ONE batch call for both candidates
    assert.equal(scored.length, 2);
    assert.equal(scored[0].verdict.priority, 3);
    assert.equal(scored[1].verdict.priority, 0);
  });

  it('retries the batch once, then falls back to per-candidate when it will not parse', async () => {
    let calls = 0;
    const drafter = async () => {
      calls++;
      // batch attempts 1 & 2 return a non-array -> both fail parseBatchVerdicts;
      // then per-candidate (one call per group) succeeds.
      return '{"priority":2,"signal":"library-wrapper","fold":"keep","note":"ok"}';
    };
    const scored = await rankCandidates(groups, fakeIndex, drafter, {});
    assert.equal(scored.length, 2);
    assert.ok(scored.every((s) => s.verdict && s.verdict.priority === 2), 'all scored via fallback');
    assert.equal(calls, 4); // 2 batch attempts + 1 per-candidate call each
  });

  it('records a null verdict + error when the drafter throws (batch and fallback)', async () => {
    const drafter = async () => { throw new Error('boom'); };
    const scored = await rankCandidates([groups[0]], fakeIndex, drafter, {});
    assert.equal(scored[0].verdict, null);
    assert.equal(scored[0].error, 'boom');
  });
});
