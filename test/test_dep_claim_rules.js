// test_dep_claim_rules.js — dependent-claim malformation rules over real USPTO specimens: parents, taxonomy
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Dependent-claim malformation rules (#311).
//
// The fixture is REAL published USPTO claim text, each specimen traceable to
// its patent and claim number, because a rule set whose tests are invented
// specimens proves only that it handles what its author imagined. Every count
// cited here was measured against dep_claims.csv (615 rows, all containing the
// literal `of claim`) on 2026-08-25.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyClaim, detectDependency, resolveParents, stripOwnNumber,
  RULES, LENGTH_CATCH_ALL,
} from '../src/core/dep-claim-rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'dep-claim-malformations.txt');

function loadSpecimens() {
  const out = [];
  let cur = {};
  for (const line of fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(CLASS|SOURCE|RULE|PARENT|TEXT)\s+(.*)$/);
    if (m) { cur[m[1].toLowerCase()] = m[2].trim(); continue; }
    if (!line.trim() && cur.text) { out.push(cur); cur = {}; }
  }
  if (cur.text) out.push(cur);
  return out;
}

describe('dependent-claim rules, against real corpus specimens', () => {
  const specimens = loadSpecimens();

  it('the fixture actually loaded, so a parse bug cannot pass as zero failures', () => {
    // A silently-empty fixture makes every per-specimen test below vacuous.
    assert.ok(specimens.length >= 20, `expected the full fixture, got ${specimens.length}`);
    for (const s of specimens) {
      for (const f of ['class', 'source', 'rule', 'parent', 'text']) {
        assert.ok(s[f], `specimen ${s.source || '(unknown)'} is missing ${f}`);
      }
    }
  });

  for (const s of specimens) {
    it(`${s.class}: ${s.source}`, () => {
      const v = classifyClaim(s.text);
      assert.equal(v.dependent, true, `${s.source} must be detected as dependent`);
      assert.equal(v.rule, s.rule,
        `${s.source} must report rule "${s.rule}" -- the taxonomy is the deliverable`);
      if (s.parent === '-') {
        assert.equal(v.parents, null, `${s.source} has no recoverable parent in the text`);
        assert.ok(v.ambiguous, 'and must say so rather than returning silently');
      } else {
        assert.deepEqual(v.parents, s.parent.split(',').map(Number));
      }
    });
  }
});

describe('the two over-specified rules, corrected', () => {
  // Both encoded the punctuation that happened to follow in whatever specimen
  // prompted them. The malformation is the letter standing in for 1; what comes
  // after it is not part of the malformation.
  it('lower-L is caught with AND without the trailing comma', () => {
    // The awk required /(in|of) claim l\,/ -- a comma. 12 corpus rows have it,
    // 6 do not, so the rule missed a third of its own class while looking fine.
    assert.equal(detectDependency('The method of claim l, wherein N is at least 2.').name, 'lower-L-for-1');
    assert.equal(detectDependency('The process of claim l wherein the ratio is 2:1.').name, 'lower-L-for-1');
  });

  it('upper-I is caught with AND without the trailing space', () => {
    // The awk required /(in|of|to) claim I / -- a space -- so the comma form was
    // invisible. 8 rows match as written, 15 without the requirement.
    assert.equal(detectDependency('The structure of claim I wherein said substrate is flat.').name, 'upper-I-for-1');
    assert.equal(detectDependency('The method of claim I, including the step of generating.').name, 'upper-I-for-1');
  });

  it('both resolve to claim 1, which is the only thing the letter can mean', () => {
    assert.deepEqual(classifyClaim('The method of claim l, wherein N is 2.').parents, [1]);
    assert.deepEqual(classifyClaim('The method of claim I, including a step.').parents, [1]);
  });
});

describe('the canonical rule tolerates punctuation before the number', () => {
  it('recovers "claim, 1" and "claim. 12" -- 41 corpus rows, one character of tolerance', () => {
    // The original demanded a space then a digit.
    assert.deepEqual(classifyClaim('2. The method of claim, 1 wherein the surface is heated.').parents, [1]);
    assert.deepEqual(classifyClaim('13. The apparatus of claim. 12, wherein the data is packed.').parents, [12]);
  });
});

describe('three outcomes, never two', () => {
  it('an independent claim is not dependent', () => {
    const v = classifyClaim('1. A method of forming a seal, comprising: heating a surface.');
    assert.equal(v.dependent, false);
    assert.equal(v.parents, null);
  });

  it('a resolved dependent carries its parent and its rule', () => {
    const v = classifyClaim('7. The method of claim 6, wherein c is equal to 1.');
    assert.equal(v.dependent, true);
    assert.deepEqual(v.parents, [6]);
    assert.equal(v.rule, 'canonical');
  });

  it('DEPENDENT with an unknowable parent is its own verdict, not an error', () => {
    // 95 of 615 rows (15.4%). Folding this into `dependent: false` would
    // misreport one row in six or seven as an independent claim, and a residue
    // count built on that is wrong.
    const v = classifyClaim('The device of claim wherein the second unit is a filter.');
    assert.equal(v.dependent, true);
    assert.equal(v.parents, null);
    assert.match(v.ambiguous, /no parent claim number is recoverable/);
  });
});

describe('the self-reference trap', () => {
  // A naive first-digit scan over raw text returns the claim's OWN number on
  // 112 of 615 rows (18.2%). A self-referential parent is worse than an
  // unresolved one: the unresolved parent announces itself, this one does not.
  it("strips the claim's own leading number before looking for a parent", () => {
    assert.deepEqual(stripOwnNumber('2. The process of claim wherein said material is a metal.'),
      { body: 'The process of claim wherein said material is a metal.', own: 2 });
    assert.deepEqual(stripOwnNumber('The process of claim 4, wherein x.'),
      { body: 'The process of claim 4, wherein x.', own: null });
  });

  it('does NOT resolve a numberless claim to its own number', () => {
    // The live shape: US4943320 claim 2. A naive scan grabs the leading "2".
    const v = classifyClaim('2. The process of claim wherein said first material is a metal.');
    assert.equal(v.dependent, true);
    assert.equal(v.parents, null, 'must not resolve to claim 2, which is itself');
    assert.equal(v.own, 2);
  });

  it('refuses a self-reference even when one is genuinely written in the text', () => {
    // Distinct from the case above: here a number IS present and it happens to
    // be the claim's own. Reporting it would build a cyclic chain.
    const v = classifyClaim('5. The method of claim 5, wherein said fluid is a gas.');
    assert.equal(v.dependent, true);
    assert.equal(v.parents, null);
    assert.match(v.ambiguous, /own number/);
  });
});

describe('resolution details', () => {
  it('resolves a word-number to an integer', () => {
    assert.deepEqual(resolveParents('The apparatus of claim one, wherein said casing is magnetic.'), [1]);
    assert.deepEqual(resolveParents('The apparatus of claim four, wherein said casing is magnetic.'), [4]);
  });

  it('resolves a list or range to every claim named', () => {
    assert.deepEqual(resolveParents('The body of claim of 1, 2, 3 or 4 in the form of a felt.'), [1, 2, 3, 4]);
    assert.deepEqual(resolveParents('The body of claims 1 to 3, in the form of a felt.'), [1, 3]);
  });

  it('reads a misspelled "clam" the catch-all detects', () => {
    // Detection and resolution must tolerate the same malformations, or a row
    // the rules DETECT reports an unrecoverable parent sitting in plain sight.
    assert.deepEqual(resolveParents('A system according to clam 11, comprising a device.'), [11]);
  });
});

describe('rule order is part of the contract', () => {
  it('keeps the length catch-all LAST, so named rules claim their own hits', () => {
    const names = RULES.map((r) => r.name);
    assert.ok(!names.includes(LENGTH_CATCH_ALL.name), 'the catch-all is not among the named rules');
    // Promote it and every hit reports "length-catch-all", destroying the
    // taxonomy the names exist to build.
    assert.equal(detectDependency('7. The method of claim 6, wherein c is 1.').name, 'canonical');
  });

  it('keeps no-number AFTER the five named classes it would otherwise mask', () => {
    // REGRESSION GUARD, and it caught a live defect. /(method|system) of claim /
    // never required a digit, so in its original fourth position it swallowed
    // six fixture specimens -- lower-L, upper-I, doubled-preposition,
    // word-number, article-inserted -- resolving their parents correctly while
    // reporting "no-number". Parents right, taxonomy destroyed.
    const masked = [
      ['The method of claim l, wherein N is 2.', 'lower-L-for-1'],
      ['The method of claim I, including a step.', 'upper-I-for-1'],
      ['The method of claim of 1 wherein said mixture is a gas.', 'doubled-preposition'],
      ['The method of claim one, wherein said fluid is a gas.', 'word-number'],
      ['The method of claim a 1, wherein the updating is responsive.', 'article-inserted'],
    ];
    for (const [text, want] of masked) {
      assert.equal(detectDependency(text).name, want,
        `"${text}" must report ${want}, not the broader rule that also matches it`);
    }
  });

  it('still lets no-number catch what genuinely belongs to it', () => {
    // Demoting it must not delete it: a method/system preamble with the number
    // omitted and no other class matching is still its hit.
    assert.equal(detectDependency('The method of claim as set forth above.').name, 'no-number');
  });

  it('every rule carries a name and a note, so a hit can explain itself', () => {
    for (const r of [...RULES, LENGTH_CATCH_ALL]) {
      assert.ok(r.name && typeof r.name === 'string', 'rule needs a name');
      assert.ok(r.note && typeof r.note === 'string', `rule ${r.name} needs a note`);
    }
    assert.equal(new Set(RULES.map((r) => r.name)).size, RULES.length, 'rule names are unique');
  });
});

describe('input handling', () => {
  it('survives empty, null and non-string input rather than throwing', () => {
    for (const bad of [null, undefined, '', '   ']) {
      const v = classifyClaim(bad);
      assert.equal(v.dependent, false);
    }
  });
});
