// test_mechanism_ranker.js — #284 ranker Phase 0. Tests the DETERMINISTIC pieces
// (tolerant verdict parser, priors) and drives rankCandidates with a MOCK drafter
// — no live LLM in CI. The real-model behavior is validated by the pcrun soak.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, rankPriors, rankCandidates } from '../src/core/mechanism-ranker.js';

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

describe('mechanism-ranker rankCandidates (mock drafter)', () => {
  const groups = [
    { label: 'tls (x)', members: [{ file: 'c/tls.c', bare: 'tls_send', name: 'tls_send', lines: 30 }] },
    { label: '[class] Foo', members: [{ file: 'F.java', bare: 'a', name: 'Foo::a', lines: 5 }] },
  ];
  const fakeIndex = { getFunctionSource: () => 'int x() { return 1; }' };

  it('scores every candidate and retries once on a malformed first response', async () => {
    let calls = 0;
    const drafter = async () => {
      calls++;
      if (calls === 1) return 'no idea'; // first attempt of group 1 is junk -> forces a retry
      return '{"priority":2,"signal":"library-wrapper","fold":"keep","note":"ok"}';
    };
    const scored = await rankCandidates(groups, fakeIndex, drafter, {});
    assert.equal(scored.length, 2);
    assert.ok(scored.every((s) => s.verdict && s.verdict.priority === 2), 'all verdicts scored');
    assert.equal(calls, 3); // group1: junk + good = 2 calls; group2: good = 1 call
  });

  it('records a null verdict + error when the drafter throws', async () => {
    const drafter = async () => { throw new Error('boom'); };
    const scored = await rankCandidates([groups[0]], fakeIndex, drafter, {});
    assert.equal(scored[0].verdict, null);
    assert.equal(scored[0].error, 'boom');
  });
});
