// test_claim_frame_tables.js — the frame tables of litigated claims: class rule, openers, skeletons, element and dependent frames, the shipped JSON
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_claim_frame_tables.js -- scripts/build-claim-frame-tables.mjs (#322, 2026-10-19).
 *
 * The claim-1 half of the tables rebuilds from the in-repo structure fixture, so those tests run the
 * real functions over the real 380 rows and pin the 2026-09-01 class split the `litigated-system`
 * shape profile cites. The dependent half needs the litigated corpus, which is not in the repo; its
 * readers are tested on inline rows (including the malformed forms dep-claim-rules.js catalogues)
 * and the shipped JSON is checked for provenance and for the counts the docs quote.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  CLAIM_CLASSES, preambleClass, preambleOf, openerOf, headNoun, preambleTemplate, preambleSkeleton,
  elementOpeners, dependentFrame, tally, claim1Tables,
} from '../scripts/build-claim-frame-tables.mjs';

const FIXTURE = 'test/fixtures/litigated-claim1-structure.jsonl';
const SHIPPED = 'src/core/claim-frame-tables.json';
const rows = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const count = (xs) => xs.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});

describe('preamble class: the 2026-09-01 rule, verbatim', () => {
  it('reproduces the litigated-system profile split on the 380-row fixture', () => {
    assert.deepEqual(count(rows.map((r) => preambleClass(r.text))), { method: 187, system: 70, crm: 15, jepson: 35, other: 73 });
    assert.deepEqual(CLAIM_CLASSES, ['method', 'system', 'crm', 'jepson', 'other']);
  });
  it('differs between the bare text and the attorney’s first row on exactly two claims (a medium named in the body within 120 characters)', () => {
    const diff = rows.filter((r) => preambleClass(r.text) !== preambleClass(r.lines[0])).map((r) => `${r.patent}:${preambleClass(r.text)}/${preambleClass(r.lines[0])}`).sort();
    assert.deepEqual(diff, ['10779033:crm/system', '6629202:crm/system']);
  });
  it('strips a claim-number prefix before classifying', () => {
    assert.equal(preambleClass('1. In a computer system having a display, a method comprising:'), 'jepson');
    assert.equal(preambleClass('12) A non-transitory computer-readable medium storing instructions'), 'crm');
    assert.equal(preambleClass('A computer-implemented method for routing, comprising:'), 'method');
    assert.equal(preambleClass('A computing device comprising:'), 'system');
    // The rule's narrowness, kept on purpose: more than two modifiers before the head noun, or a head
    // noun outside its short list, is `other`; the head-noun table is where those claims show.
    assert.equal(preambleClass('A role-based access control system, comprising:'), 'other');
    assert.equal(preambleClass('A capacitive touch sensor panel comprising:'), 'other');
  });
});

describe('preamble: the last transition word, the opener, the head noun', () => {
  it('splits at the LAST transition and keeps the tail', () => {
    assert.deepEqual(preambleOf('1. In a computer system having a display, a method for drawing comprising:'),
      { preamble: 'In a computer system having a display, a method for drawing', transition: 'comprising', tail: '' });
    assert.deepEqual(preambleOf('1. A method for processing data including metadata, comprising the steps of:'),
      { preamble: 'A method for processing data including metadata', transition: 'comprising', tail: 'the steps of' });
    assert.deepEqual(preambleOf('1. A method comprsing:'), { preamble: 'A method comprsing', transition: null, tail: '' });
  });
  it('the opener stops at the first purpose or body word; the head noun is its last word', () => {
    assert.equal(openerOf('A non-transitory computer-readable medium storing instructions that, when executed').opener, 'a non-transitory computer-readable medium');
    assert.equal(openerOf('In a computer system having a display, a method for drawing').opener, 'in a computer system');
    assert.equal(openerOf('A method for distributing programs').opener, 'a method');
    assert.equal(headNoun('A capacitive touch sensor panel'), 'panel');
    assert.equal(headNoun('A computer readable medium having stored thereon'), 'medium');
    assert.equal(openerOf('An extensible and replaceable layered component control architecture for a dynamically reconfigurable system').opener, 'a' === 'b' ? null : openerOf('An extensible and replaceable layered component control architecture for a dynamically reconfigurable system').opener);
    assert.equal(openerOf('one two three four five six seven eight nine').opener, null);
  });
  it('skeleton: opener, connector, purpose, re-mention, transition, tail', () => {
    assert.equal(preambleSkeleton('A method for distributing programs to a server on a network, the method', 'comprising', 'the steps of'),
      'a method for ..., the method comprising the steps of');
    assert.equal(preambleSkeleton('A system', 'comprising', ''), 'a system comprising');
    assert.equal(preambleSkeleton('A method of routing packets', 'comprising', 'a processor configured to'), 'a method of ... comprising');
  });
  it('template: frame tokens kept in order (head words wherever they fall), an article only before a head word', () => {
    assert.equal(preambleTemplate('A method for distributing programs to a server on a network, the method', 'comprising'),
      'a method for ... programs to a server on a network, the method comprising');
    assert.equal(preambleTemplate('A method for routing packets quickly', 'comprising'), 'a method for ... comprising');
  });
  it('method skeletons on the fixture collapse to a few dozen forms, led by the forms the docs name', () => {
    const t = claim1Tables(rows, 2);
    const method = t.preambles.skeletons.method;
    assert.ok(method.distinct < 50, `method skeletons distinct=${method.distinct}`);
    const top = Object.fromEntries(method.rows.map((r) => [r.value, r.count]));
    assert.equal(top['a method comprising'], 20);
    assert.equal(top['a method for ... comprising'], 24);
    assert.equal(top['a method for ... comprising the steps of'], 20);
    assert.equal(t.transitions.all.rows[0].value, 'comprising');
    assert.ok(t.transitions.all.rows[0].share > 0.95);
    assert.deepEqual(t.preambles.withoutTransition.map((w) => w.patent), ['7702352', '6453182']);
  });
});

describe('element openers', () => {
  it('strips enumerators and "the steps of", classifies the opener, reads apparatus forms', () => {
    const e = elementOpeners([
      '1. A method comprising:',
      '(a) receiving a request;',
      '(b) determining, by the processor, a route; and',
      'wherein the route is shortest',
      'a processor configured to parse the request',
      'means for storing the route',
      'the step of transmitting the route',
    ]);
    assert.deepEqual(e.map((x) => [x.first, x.kind]), [
      ['receiving', 'gerund'], ['determining', 'gerund'], ['wherein', 'wherein'], ['a', 'noun-phrase'], ['means', 'means'], ['transmitting', 'gerund'],
    ]);
    assert.deepEqual(e[3].forms, ['configured to']);
    assert.deepEqual(e[4].forms, ['means for']);
    assert.equal(e[1].two, 'determining by');
  });
  it('on the fixture, method rows open with a gerund four times in five and system rows with a noun phrase', () => {
    const t = claim1Tables(rows, 2);
    const kinds = (c) => Object.fromEntries(t.elements.openerKinds[c].rows.map((r) => [r.value, r.share]));
    assert.ok(kinds('method').gerund > 0.75, JSON.stringify(kinds('method')));
    assert.ok(kinds('system')['noun-phrase'] > 0.65, JSON.stringify(kinds('system')));
    assert.equal(t.elements.firstWord.method.rows[0].value, 'receiving');
    assert.deepEqual(t.elements.rowsPerClaim, { n: 380, median: 4, p10: 3, p90: 8, max: 31 });
  });
});

describe('dependent frames (inline rows; the corpus is not in the repo)', () => {
  it('reads subject, reference phrase, opener, contribution and parent', () => {
    assert.deepEqual(dependentFrame('The method of claim 1, wherein the request is an HTTP request.'),
      { subject: 'the method', reference: 'of claim', opener: 'wherein', contribution: 'MODIFICATION', parents: [1] });
    assert.deepEqual(dependentFrame('A system as recited in claim 3 further comprising a cache.'),
      { subject: 'a system', reference: 'as recited in claim', opener: 'further comprising', contribution: 'ADDITION', parents: [3] });
    assert.equal(dependentFrame('The method for monitoring fitness activity from an exercise machine of claim 2, wherein').subject, 'the method');
  });
  it('survives the malformed forms dep-claim-rules.js catalogues', () => {
    const l = dependentFrame('The method of claim l, wherein the cache is cleared.');
    assert.deepEqual([l.reference, l.opener, l.parents], ['of claim', 'wherein', [1]]);
    const claimed = dependentFrame('The apparatus of claimed 4, wherein the housing is metal.'); // rule `claimed-for-claim`
    assert.deepEqual([claimed.reference, claimed.parents], [null, [4]]);
    const omitted = dependentFrame('The method of 5, wherein the housing is metal.'); // rule `method-of-n`
    assert.deepEqual([omitted.reference, omitted.parents], [null, [5]]);
  });
  it('tally: share of all values, min-count filters the rows kept', () => {
    assert.deepEqual(tally(['a', 'b', 'a', null, 'c', ''], 2), { total: 4, distinct: 3, rows: [{ value: 'a', count: 2, share: 0.5 }] });
  });
});

describe('the shipped claim-frame-tables.json', () => {
  const json = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
  it('records its inputs, build date and rules', () => {
    assert.match(json.builtAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(json.inputs.fixture.rows, 380);
    assert.equal(json.inputs.litigated.families, 385);
    assert.equal(json.inputs.litigated.dependentsOfClaim1, 3293);
    for (const k of ['preambleClass', 'transition', 'opener', 'skeleton', 'template']) assert.ok(json.rules[k], k);
    assert.ok(Array.isArray(json.rules.frameTokens) && json.rules.frameTokens.includes('comprising'));
  });
  it('the claim-1 half matches a rebuild from the fixture', () => {
    const t = claim1Tables(rows, json.minCount);
    assert.deepEqual(json.claim1.classes, t.classes);
    assert.deepEqual(json.claim1.preambles.skeletons.method, t.preambles.skeletons.method);
    assert.deepEqual(json.claim1.transitions, t.transitions);
    assert.deepEqual(json.claim1.elements.openerKinds, t.elements.openerKinds);
    for (const c of ['method', 'system', 'crm', 'jepson', 'other']) assert.ok(json.claim1.preambles.templates[c], `templates.${c}`);
  });
  it('the dependent half carries the counts the docs quote', () => {
    const d = json.dependents;
    assert.equal(d.dependents, 3293);
    assert.equal(d.referencePhrases.all.rows[0].value, 'of claim');
    assert.equal(d.openers.all.rows[0].value, 'wherein');
    assert.equal(d.openers.all.rows[1].value, 'further comprising');
    assert.deepEqual(d.parentAgreement.disagree, 0);
    assert.deepEqual([d.perFamily.dependents.median, d.perFamily.dependents.p10, d.perFamily.dependents.p90], [7, 2, 17]);
    assert.deepEqual([d.perFamily.maxDepth.median, d.perFamily.maxDepth.p10, d.perFamily.maxDepth.p90], [2, 1, 4]);
  });
});
