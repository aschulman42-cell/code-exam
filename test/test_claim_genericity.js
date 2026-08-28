/**
 * test_claim_genericity.js -- claim-chart-element-classes (2026-08-28).
 *
 * The calibration set is the six bookends that scored PRESENT on the 2026-08-27 charts (#310) and
 * the mechanism elements the same charts called PARTIAL/ABSENT, taken verbatim from the attorney
 * element files under litig_claims_gp/charts/<patent>/elements/. If a threshold in
 * src/core/claim-genericity.js moves, these are the rows that must still come out right.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isPreambleRow } from '../src/commands/claim-locate.js';
import {
  claimGenericity, elementClass, elementClasses, headVerb, tallyByClass, classHeadline,
  genericityProfiles, IO_VERBS, MECHANISM_CUE,
} from '../src/core/claim-genericity.js';
import { contentWords, stem, buildDf, claimTerms } from '../src/core/claim-terms.js';
import * as ballpark from '../scripts/claim-ballpark.mjs';

describe('claim-terms: one definition shared with the ballpark script', () => {
  it('the script re-exports the core functions, not copies', () => {
    assert.equal(ballpark.stem, stem);
    assert.equal(ballpark.buildDf, buildDf);
    assert.equal(ballpark.claimTerms, claimTerms);
    assert.equal(ballpark.contentWords, contentWords);
  });
  it('contentWords drops claim boilerplate and keeps 3-letter acronyms', () => {
    assert.deepEqual(contentWords('receiving an input comprising an input text portion'), []);
    assert.deepEqual(contentWords('a DMA controller validating a parse tree'), ['dma', 'controller', 'validating', 'parse', 'tree']);
  });
});

describe('claim genericity: the shipped table', () => {
  it('ships the ai-ml and litigated profiles', () => {
    const p = genericityProfiles();
    assert.ok(p.includes('ai-ml') && p.includes('litigated'), p.join(','));
  });
  it('an unknown profile is unscored, never silently generic', () => {
    assert.equal(claimGenericity('validating a parse tree', { profile: 'nope' }).kind, 'unscored');
  });
});

describe('claim genericity: the 2026-08-27 bookends classify GENERIC', () => {
  const bookends = [
    'a) receiving an input comprising an input text portion;',                          // 8,666,994 row 2 -> `query: str`
    'f) outputting a representation of the identified relevant reference documents;',   // 8,666,994 row 7 -> returns Documents
    'providing one or more of the ordered search results.',                             // 8,782,029 row 8 -> `return ret`
    'receiving a generic command from the user;',                                       // 7,047,526 row 2 -> wmain(argc, argv)
    'storing the encoded frame in the buffer;',
    'processing the data;',                                                             // nothing left after the STOP list
  ];
  for (const b of bookends) {
    it(`generic: ${b.slice(0, 60)}`, () => {
      const r = claimGenericity(b);
      assert.equal(r.kind, 'generic', JSON.stringify(r));
    });
  }
  it('names why: an I/O verb with no mechanism cue, or no content words', () => {
    assert.match(claimGenericity('receiving a generic command from the user;').reason, /input\/output\/storage step \(receiving\)/);
    assert.match(claimGenericity('processing the data;').reason, /no content words/);
  });
});

describe('claim genericity: mechanism elements classify MECHANISM', () => {
  const mech = [
    ['validating the generic command based on a command parse tree that specifies valid generic commands relative to a prescribed generic command format, the command parse tree having elements each specifying at least one corresponding generic command component and a corresponding at least one command action value, the validating step including identifying one of the elements as a best match relative to the generic command; and', ['receiving a generic command from the user;']],  // 7,047,526 row 3, PARTIAL
    ['transforming the SPARQL query results into a format corresponding to the first query language format, wherein the format is not an XML format.', []],  // 8,949,225 row 6, the false PRESENT
    ['defining a mathematical relationship between said reference coordinate system and said image coordinate system;', []],  // 6,659,611 row 4
    ['c) using the processor, assigning at least one weight associated with the at least one text term;', []],  // 8,666,994 row 4
    ['converting, using one or more processors, a portion of a multimedia stream to text;', []],  // 9,152,713 row 2 (a real mechanism PRESENT)
    ['transmitting the packet to the standby router when the active router fails;', []],           // an I/O verb, but a condition
  ];
  for (const [m, ctx] of mech) {
    it(`mechanism: ${m.slice(0, 60)}`, () => {
      const r = claimGenericity(m, { context: ctx });
      assert.equal(r.kind, 'mechanism', JSON.stringify(r));
    });
  }
  it('an I/O verb with a mechanism cue is not a bookend', () => {
    assert.ok(IO_VERBS.has('transmitting'));
    assert.ok(MECHANISM_CUE.test('transmitting the packet when the active router fails'));
    assert.equal(claimGenericity('transmitting the packet when the active router fails').kind, 'mechanism');
  });
});

describe('claim genericity: context and structure', () => {
  it('words introduced by earlier elements are back-references, not new mechanism (definitional clauses)', () => {
    // A clause with no action verb of its own is scored by frequency; the nouns it
    // repeats from earlier elements are back-references there.
    const el = 'wherein the reference documents are those having the assigned weight;';
    const alone = claimGenericity(el);
    const withCtx = claimGenericity(el, { context: ['assigning a weight to each text term', 'retrieving reference documents'] });
    assert.ok(withCtx.backReferenced.length > alone.backReferenced.length, JSON.stringify(withCtx));
    assert.ok(withCtx.score >= alone.score);
  });
  it('an action verb that is not I/O is a mechanism step whatever its nouns', () => {
    // '101 row 8 carries only nouns introduced earlier; the ACTION is the mechanism.
    const r = claimGenericity('ranking the reference documents by the assigned weight;', { context: ['assigning a weight to each text term', 'retrieving reference documents'] });
    assert.equal(r.kind, 'mechanism');
    assert.match(r.reason, /action step \(ranking\)/);
  });
  it('headVerb finds the -ing verb past a list marker, skipping copulas and "using"', () => {
    assert.equal(headVerb('a) receiving an input comprising an input text portion;'), 'receiving');
    assert.equal(headVerb('using the processor, assigning at least one weight'), 'assigning');
    assert.equal(headVerb('using a processor to identify at least one text term'), 'identify');
    assert.equal(headVerb('a database query'), 'a');
  });
  it('headVerb takes the verb after "configured to" / "unit for", not the -ing in the noun phrase', () => {
    // '101 row 8 (2026-08-28): filed generic because "transmitting" was read as the verb.
    const row8 = 'the content transmitting unit is configured to change the code rate of the content data to be transmitted to the reception device to the determined code rate';
    assert.equal(headVerb(row8), 'change');
    assert.equal(claimGenericity(row8).kind, 'mechanism', JSON.stringify(claimGenericity(row8)));
    assert.equal(headVerb('a code rate determining unit for determining the code rate based on a remaining time'), 'determining');
    assert.equal(headVerb('the reception device being equipped with a content reproducing unit for, while receiving the content data'), 'receiving');
  });
  it('elementClass and elementClasses mark the preamble and thread context', () => {
    const els = ['A method comprising:', 'receiving an input text;', 'validating the input based on a parse tree having best-match elements;', 'outputting the result.'];
    assert.equal(elementClass(els[0], { isPreamble: true }), 'preamble');
    assert.deepEqual(elementClasses(els, { isPreambleRow: (e, i) => i === 0 }), ['preamble', 'generic', 'mechanism', 'generic']);
  });
});

// Population calibration (Andrew, 2026-08-28: do not tune the rule so that one example claim comes
// out right). The 380 litigated attorney element sets are the yardstick's yardstick: a rule change
// that moves these bands must justify itself on the population, not on '101.
describe('claim genericity: population calibration on the 380 litigated attorney element sets', () => {
  const recs = fs.readFileSync(path.resolve('test/fixtures/litigated-claim1-structure.jsonl'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const per = recs.map((r) => elementClasses(r.lines || [], { isPreambleRow }));
  const flat = per.flat();
  const n = flat.length, generic = flat.filter((c) => c === 'generic').length, mech = flat.filter((c) => c === 'mechanism').length;
  it('scores every attorney element (no unscored rows)', () => {
    assert.ok(n > 2000, `elements: ${n}`);
    assert.equal(flat.filter((c) => c === 'unscored').length, 0);
  });
  it('generic elements are a minority band, not a majority and not nothing (2026-08-28: 623 of 2,294 = 27%)', () => {
    const share = generic / n;
    assert.ok(share >= 0.15 && share <= 0.40, `generic share ${share.toFixed(3)} (${generic}/${n}), mechanism ${mech}`);
  });
  it('almost every litigated claim 1 has at least two mechanism elements (2026-08-28: 13 of 380 do not)', () => {
    const under2 = per.filter((c) => c.filter((k) => k === 'mechanism').length < 2).length;
    assert.ok(under2 <= 20, `${under2} of ${per.length} claims with < 2 mechanism elements (band: 5%)`);
  });
});

describe('claim genericity: tally and headline', () => {
  it('tallies verdicts by class and prints mechanism first', () => {
    const rows = [
      { elementClass: 'preamble', verdict: 'ABSENT' },
      { elementClass: 'generic', verdict: 'PRESENT' }, { elementClass: 'generic', verdict: 'PRESENT' }, { elementClass: 'generic', verdict: 'ABSENT' },
      { elementClass: 'mechanism', verdict: 'PARTIAL' }, { elementClass: 'mechanism', verdict: 'ABSENT' }, { elementClass: 'mechanism', verdict: null },
    ];
    const t = tallyByClass(rows);
    assert.deepEqual(t.generic, { PRESENT: 2, PARTIAL: 0, ASSUMED: 0, ABSENT: 1, none: 0 });
    assert.deepEqual(t.mechanism, { PRESENT: 0, PARTIAL: 1, ASSUMED: 0, ABSENT: 1, none: 1 });
    assert.equal(classHeadline(t), 'mechanism 3: 1 PARTIAL · 1 ABSENT · 1 no finding; generic 3: 2 PRESENT · 1 ABSENT; preamble 1');
  });
});
