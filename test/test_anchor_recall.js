// test_anchor_recall.js — HOF-c scorer (scripts/anchor-recall.mjs).
//
// Scores CE's retrieval against the anchors a --pseudo-claims run already
// grounded, on CE'S OWN granularity ladder (FUNCTION / CLASS / FILE / FOLDER),
// because claim-search already emits those four ranked lists and "how close did
// retrieval get" is expressed by which list an anchor lands in.
//
// TEST SHAPE: fixtures are the REAL recorded search outputs where possible. The
// defect this file exists to prevent is a parser that returns zero and is read
// as a score of zero — it has now happened three times: an invented tier scheme
// that skipped CLASS entirely (scored sr_gh at 5% while the answer sat at CLASS
// rank #1), an empty-character-class regex, and folder rows dropped because four
// section formats were collapsed into one pattern.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseSearchOutput, parseGaps, reach, tierOf, independence, unscoreable,
  enclosingClass, LADDER,
} from '../scripts/anchor-recall.mjs';

const REAL = 'sr_gh_claim_pairs/pairs/orig_07.out';
const haveReal = fs.existsSync(REAL);

describe('parsing claim-search output', () => {
  it('parses all four section shapes, not just the three that look alike', () => {
    // FUNCTION / CLASS / FILE carry a parenthesized meta ("(736 lines)");
    // FOLDER does NOT — "[1] path/  [11/12 terms, 85 files] IDF:38.7".
    // One collapsed regex silently dropped every folder row, and the SCORE was
    // unaffected because folder is the last rung and nothing reached it — so
    // only the parse-gap assertion surfaced it.
    const txt = [
      '=== FUNCTION-level matches (1 functions) ===',
      '  [1] Cls::meth  (src/a.js, 40 lines)  [9/12] IDF:25.7',
      '=== CLASS-level matches (1 classes) ===',
      '  [1] Cls  (src/a.js, 5 methods, 90 lines)  [12/12] IDF:36.9',
      '=== FILE-level matches (1 files) ===',
      '  [1] src/a.js  (736 lines)  [15/19] IDF:36.1',
      '=== FOLDER-level matches (1 folders) ===',
      '  [1] src/  [11/12 terms, 85 files] IDF:38.7  missing: /x/',
    ].join('\n');
    const p = parseSearchOutput(txt);
    for (const k of LADDER) assert.equal(p.lists[k].length, 1, `${k} row not parsed`);
    assert.equal(p.lists.folder[0].name, 'src/');
    assert.equal(p.lists.folder[0].idf, 38.7);
  });

  it('a header with NO parsed entries is a PARSE GAP, not a score of zero', () => {
    const txt = '=== CLASS-level matches (5 classes) ===\n  [1] Cls  totally unparseable\n';
    assert.deepEqual(parseGaps(parseSearchOutput(txt)), ['class']);
  });

  it('a section that was never emitted is NOT a gap', () => {
    const txt = '=== FUNCTION-level matches (1 functions) ===\n  [1] f  (src/a.js, 4 lines)  [1/2] IDF:3.0\n';
    assert.deepEqual(parseGaps(parseSearchOutput(txt)), []);
  });

  it('tracks the TIGHT and BROAD passes separately', () => {
    // Both restart ranks at [1]; a FUNCTION header opens a pass. A rank is only
    // comparable within its own pass.
    const row = '  [1] f  (src/a.js, 4 lines)  [1/2] IDF:3.0';
    const p = parseSearchOutput([
      '=== FUNCTION-level matches (1 functions) ===', row,
      '=== FUNCTION-level matches (1 functions) ===', row,
    ].join('\n'));
    assert.deepEqual(p.lists.fn.map((e) => e.pass), [1, 2]);
  });

  it('parses the REAL recorded output with zero gaps', { skip: !haveReal }, () => {
    const p = parseSearchOutput(fs.readFileSync(REAL, 'utf8'));
    assert.deepEqual(parseGaps(p), [], 'a recorded artifact must parse cleanly');
    assert.ok(p.lists.fn.length + p.lists.class.length > 0);
  });
});

describe('the granularity ladder', () => {
  const lists = {
    fn: [{ rank: 3, name: 'Cls::meth', meta: '', pass: 1 }],
    class: [{ rank: 1, name: 'Cls', meta: '', pass: 1 }],
    file: [{ rank: 2, name: 'src/a.js', meta: '', pass: 1 }],
    folder: [{ rank: 5, name: 'src/', meta: '', pass: 1 }],
  };

  it('best rung wins, and the rungs PARTITION — fn is not also counted as class', () => {
    const r = reach(lists, { file: 'src/a.js', func: 'Cls::meth' });
    assert.ok(r.class, 'the class hit exists...');
    assert.equal(tierOf(r), 'fn', '...but the anchor counts once, at its best rung');
  });

  it('falls to class, then file, then folder', () => {
    const a = { file: 'src/a.js', func: 'Cls::meth' };
    assert.equal(tierOf(reach({ ...lists, fn: [] }, a)), 'class');
    assert.equal(tierOf(reach({ ...lists, fn: [], class: [] }, a)), 'file');
    assert.equal(tierOf(reach({ ...lists, fn: [], class: [], file: [] }, a)), 'folder');
  });

  it('reports nothing reached rather than inventing a rung', () => {
    const r = reach({ fn: [], class: [], file: [], folder: [] }, { file: 'src/z.js', func: 'Q::r' });
    assert.equal(tierOf(r), null);
  });

  it('matches a bare function name against a qualified entry', () => {
    const r = reach({ ...lists, class: [], file: [], folder: [] }, { file: 'src/a.js', func: 'meth' });
    assert.equal(tierOf(r), 'fn');
  });

  it('enclosingClass reads Class::method and tolerates a bare name', () => {
    assert.equal(enclosingClass('Cls::meth'), 'Cls');
    assert.equal(enclosingClass('plainFn'), null);
  });
});

describe('anchor independence', () => {
  it('counts distinct classes beside distinct anchors', () => {
    // `[class] X` candidate groups correlate anchors by construction: sr_gh
    // claim 10 is 14 anchors that are 14 methods of ONE class, so a single
    // class-level hit scores 14. asus-CC measured the same shape on Gemma3 —
    // 196 grounded anchors resolving to 70 distinct functions.
    const ind = independence([
      { file: 'a.js', func: 'C::x' }, { file: 'a.js', func: 'C::y' },
      { file: 'a.js', func: 'C::z' }, { file: 'b.js', func: 'D::w' },
    ]);
    assert.equal(ind.anchors, 4);
    assert.equal(ind.classes, 2, 'four anchors, two independent classes');
  });

  it('does not count a class for a bare function', () => {
    assert.equal(independence([{ file: 'a.js', func: 'plain' }]).classes, 0);
  });
});

describe('claims that must NOT be scored', () => {
  it('refuses a TRUNCATED claim and names why', () => {
    // 58a596d: a draft cut off by the output budget loses its ANCHORS block,
    // because that block follows the prose. Scoring it measures CE's output
    // budget, not retrieval. The Gemini run produced 16 such claims, and they
    // read as ordinary output until the field existed.
    assert.match(unscoreable({ truncated: true, grounded: [{ file: 'a', func: 'b' }] }), /truncated/);
  });

  it('refuses a claim with no grounded anchors', () => {
    assert.match(unscoreable({ grounded: [] }), /no grounded anchors/);
  });

  it('scores a healthy claim', () => {
    assert.equal(unscoreable({ grounded: [{ file: 'a', func: 'b' }] }), null);
  });
});
