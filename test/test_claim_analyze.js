// #307 — claim-analyze retrieval fixes, measured against US 8,752,101 x
// .AndroidX_Media_ExoPlayer3 (asus-CC, 2026-08-10).
//
// Acceptance test (Andrew): the chart references
// `AdaptiveTrackSelection::updateSelectedTrack`. Concluding claim 1 is NOT met is
// fine; charting it onto `BoxParser::parseStbl` — an MP4 sample-table parser — is
// pointed at the wrong subsystem.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { livePositiveTerms, mergeSearchResults, claimAnalyzeTopN } from '../src/commands/analyze.js';

// Gemma's own TIGHT extraction for claim 1. Four of these nine match zero files
// in the index, which is what made the search unwinnable.
const GEMMA_TIGHT = ['transmission', 'content data', 'code rate', 'plurality',
  'remaining time', 'storage device', 'change', 'determined', 'present'];
const DEAD = new Set(['content data', 'code rate', 'plurality', 'storage device']);

// Stub index: answers the term-file-count probe from the measured dead set.
const idx = { multisectTermFileCount: (t) => (DEAD.has(String(t)) ? 0 : 3) };

describe('#307 live-term quorum', () => {
  it('counts only terms that can match — the measured Gemma case', () => {
    assert.equal(livePositiveTerms(idx, GEMMA_TIGHT), 5, '9 terms, 4 dead');
  });

  it('turns an impossible search into a possible one', () => {
    // Old: floor(9 x 0.80) = 7 required, 5 live -> could never succeed.
    // New: floor(5 x 0.80) = 4 required, 5 live -> reachable.
    const oldQuorum = Math.max(Math.floor(GEMMA_TIGHT.length * 0.80), 2);
    const live = livePositiveTerms(idx, GEMMA_TIGHT);
    const newQuorum = Math.max(Math.floor(live * 0.80), 2);
    assert.equal(oldQuorum, 7);
    assert.ok(oldQuorum > live, 'the old quorum exceeded the live term count');
    assert.ok(newQuorum <= live, 'the new quorum is reachable');
  });

  it('is a no-op when every term is live — must not loosen a healthy search', () => {
    const allLive = { multisectTermFileCount: () => 5 };
    assert.equal(livePositiveTerms(allLive, GEMMA_TIGHT), 9);
  });

  // FAIL OPEN. A missing probe must restore the old behaviour, never tighten it:
  // returning 0 would make the quorum 2 and match nearly everything.
  it('fails open when the index cannot answer', () => {
    assert.equal(livePositiveTerms({}, GEMMA_TIGHT), 9, 'no probe -> all live');
    assert.equal(livePositiveTerms({ multisectTermFileCount: () => { throw new Error('x'); } }, GEMMA_TIGHT), 9);
    assert.equal(livePositiveTerms({ multisectTermFileCount: () => 0 }, GEMMA_TIGHT), 9,
      'all-dead must not return 0 — a 0 quorum matches everything');
  });

  it('handles regex and object term forms without throwing', () => {
    const terms = [{ term: 'alpha' }, { pattern: 'be+ta', isRegex: true }, 'gamma'];
    assert.equal(typeof livePositiveTerms(idx, terms), 'number');
    assert.equal(livePositiveTerms(idx, []), 0);
  });
});

describe('#307 BROAD merge, not fallback', () => {
  const fn = (file, name) => ({ filepath: file, function: name, lines: 10 });
  const tight = { function_matches: [fn('a.java', 'one'), fn('b.java', 'two')], terms: ['t'] };
  const broad = { function_matches: [fn('b.java', 'two'), fn('c.java', 'three')] };

  it('unions both searches and keeps TIGHT first', () => {
    const m = mergeSearchResults(tight, broad);
    assert.deepEqual(m.function_matches.map((x) => x.function), ['one', 'two', 'three']);
    assert.equal(m._broad_merged, true);
  });

  it('tags provenance so a chart can say which search found a cite', () => {
    const m = mergeSearchResults(tight, broad);
    assert.deepEqual(m.function_matches.map((x) => x._via), ['tight', 'tight', 'broad']);
  });

  it('does not duplicate a match both searches found', () => {
    const m = mergeSearchResults(tight, broad);
    assert.equal(m.function_matches.filter((x) => x.function === 'two').length, 1);
  });

  it('preserves the non-match fields of the TIGHT result', () => {
    assert.deepEqual(mergeSearchResults(tight, broad).terms, ['t']);
  });

  it('tolerates either side missing', () => {
    assert.equal(mergeSearchResults(null, broad), broad);
    assert.equal(mergeSearchResults(tight, null), tight);
  });
});

describe('#307 top-N', () => {
  // At 2, the measured run analyzed BoxParser::parseStbl [10/13] and lost
  // AdaptiveTrackSelection [9/13] — a difference inside the noise of a
  // term-count heuristic deciding the entire chart.
  it('defaults to 6, which is where both populations arrive', () => {
    assert.equal(claimAnalyzeTopN({}), 6);
    assert.equal(claimAnalyzeTopN(undefined), 6);
  });

  it('honours --top-n', () => {
    assert.equal(claimAnalyzeTopN({ top_n: '12' }), 12);
    assert.equal(claimAnalyzeTopN({ top_n: 3 }), 3);
  });

  it('ignores junk rather than collapsing to 0 — a 0 slice analyzes nothing', () => {
    for (const v of ['0', '-1', 'abc', '']) assert.equal(claimAnalyzeTopN({ top_n: v }), 6);
  });
});
