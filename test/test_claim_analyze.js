// #307 — claim-analyze retrieval fixes, measured against US 8,752,101 x
// .AndroidX_Media_ExoPlayer3 (asus-CC, 2026-08-10).
//
// Acceptance test (Andrew): the chart references
// `AdaptiveTrackSelection::updateSelectedTrack`. Concluding claim 1 is NOT met is
// fine; charting it onto `BoxParser::parseStbl` — an MP4 sample-table parser — is
// pointed at the wrong subsystem.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { livePositiveTerms, mergeSearchResults, claimAnalyzeTopN, claimNeighbourhoodN, termProbeSource } from '../src/commands/analyze.js';
import { parseMultisectTerms } from '../src/commands/multisect.js';

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

// #307 SCOPE LADDER. multisect computes four rungs — function, class, file,
// folder — and claim-analyze read only the bottom one. Andrew's own multisect
// pseudo-claim describes the ladder; it was implemented in the search and
// discarded at the consumer.
//
// MEASURED, US 8,752,101 x .AndroidX_Media_ExoPlayer3, Claude's BROAD terms:
//   BEFORE  38 functions, AdaptiveTrackSelection::updateSelectedTrack ABSENT
//   AFTER    7 functions (min=6),  target at RANK 4 — inside the analyzed top-6
//
// CE self-test (Andrew's multisect pseudo-claim vs .CE_080426, GT = ce_anchors
// claim 1's five anchors):
//   BEFORE  multisectSearch=20, four anchors absent
//   AFTER   multisectSearch=12, matchIdfScore=14, computeIdfScores=16
// — a real move, and still short of the analyzed set. Recorded as a partial.
describe('#307 neighbourhood size', () => {
  it('defaults to 10 — the measured point, where the target sat at file rank 9', () => {
    assert.equal(claimNeighbourhoodN({}), 10);
    assert.equal(claimNeighbourhoodN(undefined), 10);
    assert.equal(claimNeighbourhoodN({ neighbourhood: '' }), 10);
  });

  it('honours --neighbourhood, both spellings', () => {
    assert.equal(claimNeighbourhoodN({ neighbourhood: '25' }), 25);
    assert.equal(claimNeighbourhoodN({ neighborhood: 4 }), 4);
  });

  // 0 must be a real value, not "falsy so use the default" — it is the escape
  // hatch back to pre-ladder behaviour if the narrowing hurts a given corpus.
  it('0 disables the ladder and is not treated as unset', () => {
    assert.equal(claimNeighbourhoodN({ neighbourhood: '0' }), 0);
    assert.equal(claimNeighbourhoodN({ neighbourhood: 0 }), 0);
  });

  it('ignores junk rather than narrowing to something arbitrary', () => {
    for (const v of ['-3', 'abc', '1.5.2']) {
      const n = claimNeighbourhoodN({ neighbourhood: v });
      assert.ok(n === 10 || n === 1, `junk produced ${n}`);
    }
  });
});

// #307 — the probe reads the shape production actually passes.
//
// THE BUG THIS EXISTS FOR: between c169ca7 and this change, livePositiveTerms
// read `t.term ?? t.pattern`. A parsed multisect term is
// { display, regex, negated, hard } — neither field exists — so every term took
// the empty branch and counted LIVE without being probed. The live-term quorum
// was INERT IN PRODUCTION for all terms, not just regexes.
//
// It looked verified because the check ran on an array of STRINGS, reproducing
// 5-of-9 against the real index, while the call site supplies OBJECTS. So these
// tests build their input with parseMultisectTerms — the same parser production
// uses — rather than with literals chosen by the author.
describe('#307 term probe reads the production term shape', () => {
  it('reads a parsed literal term, which the old code could not', () => {
    const [t] = parseMultisectTerms('storage');
    assert.deepEqual(termProbeSource(t), { text: 'storage', isRegex: false });
  });

  it('unwraps a parsed regex term and flags it as one', () => {
    const [t] = parseMultisectTerms('/bitrate|bit.rate/');
    assert.deepEqual(termProbeSource(t), { text: 'bitrate|bit.rate', isRegex: true });
  });

  it('still accepts a bare string, so the older callers keep working', () => {
    assert.deepEqual(termProbeSource('storage device'), { text: 'storage device', isRegex: false });
  });

  it('returns null for unreadable input rather than a blank probe', () => {
    for (const v of [null, undefined, {}, { display: '   ' }]) assert.equal(termProbeSource(v), null);
  });

  // The regression proper: parsed terms must be PROBED, not waved through.
  it('probes parsed terms instead of counting them all live', () => {
    const parsed = parseMultisectTerms('alpha;bravo;charlie');
    const pos = parsed.filter((t) => !t.negated);
    // Index answers: only 'alpha' exists.
    const idx2 = { searchLiteral: (text) => (text === 'alpha' ? [{}] : []) };
    assert.equal(livePositiveTerms(idx2, pos), 1,
      'parsed terms were counted live without probing — the c169ca7 defect');
  });

  it('passes maxResults, not max — the option name is silently ignored otherwise', () => {
    let seen = null;
    const idx2 = { searchLiteral: (_t, opts) => { seen = opts; return [{}]; } };
    livePositiveTerms(idx2, parseMultisectTerms('alpha').filter((t) => !t.negated));
    assert.equal(seen.maxResults, 1, 'a liveness question needs exactly one hit');
    assert.equal(seen.max, undefined, 'the wrong name must not linger alongside it');
  });

  it('probes a regex term as a regex', () => {
    let seen = null;
    const idx2 = { searchLiteral: (t, opts) => { seen = { t, opts }; return [{}]; } };
    livePositiveTerms(idx2, parseMultisectTerms('/bitrate|coderate/').filter((x) => !x.negated));
    assert.equal(seen.opts.useRegex, true);
    assert.equal(seen.t, 'bitrate|coderate', 'the slashes must be stripped before probing');
  });

  // NOT invalid patterns: parseMultisectTerms rejects `/[unclosed/` and returns
  // null for the whole set, so a bad regex never reaches the probe. What this
  // guards is an index that throws for its own reasons.
  it('an index that throws fails open rather than counting terms dead', () => {
    const idx2 = { searchLiteral: () => { throw new Error('index exploded'); } };
    const pos = parseMultisectTerms('/bitrate|coderate/;alpha').filter((t) => !t.negated);
    assert.equal(livePositiveTerms(idx2, pos), pos.length, 'a throw must not tighten the quorum');
  });

  it('the parser, not the probe, is what rejects an unparseable regex', () => {
    assert.equal(parseMultisectTerms('/[unclosed/;alpha'), null,
      'if this ever returns terms instead, the probe needs its own guard');
  });
});
