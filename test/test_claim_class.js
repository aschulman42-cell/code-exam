// test_claim_class.js — pickClaimClass: the deterministic statutory-class rule, four branches with reasons
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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

// pseudo-claim-class-apparatus (2026-10-25): an apparatus is a thing by its
// parts; the rule says so for several classes with roles or for hardware and
// I/O vocabulary, and still says system for one class whose methods are what it
// is configured to do.
import { APPARATUS_WORDS } from '../src/core/claim-class.js';
describe('pickClaimClass: apparatus', () => {
  const m = (names) => ({ label: 'rig (Sensor::read)', members: names.map((name) => ({ name })) });
  it('two or more classes each with roles, most of the group -> apparatus, with the parts named', () => {
    const r = pickClaimClass(m(['Sensor::read', 'Sensor::calibrate', 'Controller::drive', 'Controller::stop', 'helper']));
    assert.equal(r.class, 'apparatus');
    assert.match(r.reason, /components: 2 classes with roles/);
    assert.match(r.reason, /Sensor 2, Controller 2/);
  });
  it('one dominant class stays system', () => {
    const r = pickClaimClass({ label: 'index (Index::build)', members: ['Index::build', 'Index::save', 'Index::load', 'free'].map((name) => ({ name })) });
    assert.equal(r.class, 'system');
  });
  it('hardware and I/O vocabulary over process vocabulary -> apparatus', () => {
    const r = pickClaimClass({ label: 'serial (openPort)', purpose: 'talks to the device over a serial port through a driver', members: ['openPort', 'readSensor', 'closePort'].map((name) => ({ name })) });
    assert.equal(r.class, 'apparatus');
    assert.match(r.reason, /hardware\/IO vocabulary/);
  });
  it('the vocabulary is stated and exported', () => {
    assert.ok(Array.isArray(APPARATUS_WORDS) && APPARATUS_WORDS.includes('sensor') && APPARATUS_WORDS.includes('driver'));
  });
});
