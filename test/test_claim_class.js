// test_claim_class.js -- pseudo-claims-statutory-class: the deterministic
// class rule. The rule's whole vocabulary is stated in the module; these
// fixtures exercise the four branches, never tune them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickClaimClass } from '../src/core/claim-class.js';

describe('pickClaimClass: four branches, first match wins, reasons named', () => {
  it('[class] seed is a component -> system', () => {
    const got = pickClaimClass({ label: '[class] CodeSearchIndex / build', members: [{ name: 'CodeSearchIndex::build' }] });
    assert.equal(got.class, 'system');
    assert.match(got.reason, /component/);
  });
  it('60% shared-class membership is a component -> system', () => {
    const got = pickClaimClass({ label: 'internals', members: [
      { name: 'Idx::a' }, { name: 'Idx::b' }, { name: 'Idx::c' }, { name: 'free' },
    ] });
    assert.equal(got.class, 'system');
  });
  it('structure vocabulary over process -> system, counts in the reason', () => {
    const got = pickClaimClass({ label: 'sidecar schema and record layout', members: [{ name: 'writeRecord' }] });
    assert.equal(got.class, 'system');
    assert.match(got.reason, /structure vocabulary \d+ vs process \d+/);
  });
  it('[cmd] seed and free functions -> method; default -> method', () => {
    assert.equal(pickClaimClass({ label: '[cmd] --digest', members: [{ name: 'doDigest' }] }).class, 'method');
    assert.equal(pickClaimClass({ label: 'a helper that computes widths', members: [{ name: 'computeWidths' }, { name: 'renderChart' }] }).class, 'method');
    assert.equal(pickClaimClass({}).class, 'method');
  });
  it('deterministic: same input, same class', () => {
    const g = { label: '[class] X / y', members: [{ name: 'X::y' }] };
    assert.equal(pickClaimClass(g).class, pickClaimClass(g).class);
  });
});
