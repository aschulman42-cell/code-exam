// test_claim_locate.js — claim-locate-verify-navigate.
//
// The VERIFY half is fully mechanical, so it is tested for real. The PROPOSE
// half is an LLM call, mocked here; its quality is measured by the
// pre-registered live gate (run by Andrew on the unmodified '101 claim), not
// asserted here — this file must never encode the expected answer, which is
// exactly the contamination that invalidated an earlier prototype.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  symbolTokens, buildSymbolTable, verifySymbol, isFound, nearbySymbols,
  parseProposedSymbols,
} from '../src/core/symbol-verify.js';
import {
  splitClaimElements, buildProposePrompt, buildIndexProfile, formatLocateReport,
  doClaimLocate, buildDiscoverPrompt, parseElementWords, searchSymbolsByWords,
  buildSelectPrompt, isTestSymbol,
} from '../src/commands/claim-locate.js';

const TABLE = [
  { filepath: 'a.zip!x/AdaptiveTrackSelection.java', name: 'AdaptiveTrackSelection::updateSelectedTrack', bare: 'updateSelectedTrack', start: 436, end: 485, tokens: symbolTokens('AdaptiveTrackSelection::updateSelectedTrack') },
  { filepath: 'a.zip!x/AdaptiveTrackSelection.java', name: 'AdaptiveTrackSelection::determineIdealSelectedIndex', bare: 'determineIdealSelectedIndex', start: 599, end: 613, tokens: symbolTokens('AdaptiveTrackSelection::determineIdealSelectedIndex') },
  { filepath: 'a.zip!x/DefaultLoadControl.java', name: 'DefaultLoadControl::shouldStartPlayback', bare: 'shouldStartPlayback', start: 797, end: 815, tokens: symbolTokens('DefaultLoadControl::shouldStartPlayback') },
];

describe('symbol tokenization', () => {
  it('splits camelCase, ::, and underscores', () => {
    assert.deepEqual(symbolTokens('AdaptiveTrackSelection::updateSelectedTrack'),
      ['adaptive', 'track', 'selection', 'update', 'selected', 'track']);
    assert.deepEqual(symbolTokens('should_start_playback'), ['should', 'start', 'playback']);
  });
  it('handles acronym runs', () => {
    assert.deepEqual(symbolTokens('HTTPDataSource'), ['http', 'data', 'source']);
  });
});

describe('verifySymbol tiers', () => {
  it('matches an exact bare name', () => {
    const v = verifySymbol(TABLE, 'updateSelectedTrack');
    assert.equal(v.status, 'exact');
    assert.equal(v.matches[0].start, 436);
  });
  it('accepts dotted Class.method as :: (the shape models emit)', () => {
    const v = verifySymbol(TABLE, 'AdaptiveTrackSelection.determineIdealSelectedIndex');
    assert.ok(isFound(v));
    assert.equal(v.matches[0].bare, 'determineIdealSelectedIndex');
  });
  it('strips trailing () from a proposal', () => {
    assert.ok(isFound(verifySymbol(TABLE, 'shouldStartPlayback()')));
  });
  it('falls back to case-insensitive then token-subset', () => {
    assert.equal(verifySymbol(TABLE, 'updateselectedtrack').status, 'case-insensitive');
    const v = verifySymbol(TABLE, 'AdaptiveTrackSelection');
    assert.ok(isFound(v), 'class-name proposal resolves via token subset');
  });
  it('honors the CLASS on a qualified proposal (the wrong-citation bug)', () => {
    // Two symbols share the bare name; the qualifier must decide. In the live
    // ExoPlayer index eight symbols are named updateSelectedTrack, and bare
    // matching cited the wrong class with full confidence.
    const table = [
      { filepath: 'x/DownloadHelper.java', name: 'DownloadHelper::DownloadTrackSelection::updateSelectedTrack', bare: 'updateSelectedTrack', start: 1487, end: 1495, tokens: symbolTokens('DownloadHelper::DownloadTrackSelection::updateSelectedTrack') },
      { filepath: 'x/AdaptiveTrackSelection.java', name: 'AdaptiveTrackSelection::updateSelectedTrack', bare: 'updateSelectedTrack', start: 436, end: 485, tokens: symbolTokens('AdaptiveTrackSelection::updateSelectedTrack') },
    ];
    const v = verifySymbol(table, 'AdaptiveTrackSelection::updateSelectedTrack');
    assert.ok(isFound(v));
    assert.equal(v.matches[0].start, 436, 'resolved to the proposed class, not the first bare match');
  });
  it('flags ambiguity when an unqualified name matches many symbols', () => {
    const table = [
      { filepath: 'a.java', name: 'A::run', bare: 'run', start: 1, end: 2, tokens: symbolTokens('A::run') },
      { filepath: 'b.java', name: 'B::run', bare: 'run', start: 3, end: 4, tokens: symbolTokens('B::run') },
    ];
    const v = verifySymbol(table, 'run');
    assert.ok(isFound(v));
    assert.equal(v.ambiguous, 2);
  });
  it('reports NOT FOUND rather than guessing', () => {
    const v = verifySymbol(TABLE, 'CodeRateDeterminingUnit');
    assert.equal(v.status, 'not-found');
    assert.deepEqual(v.matches, []);
    assert.equal(isFound(v), false);
  });
});

describe('nearbySymbols (refine input)', () => {
  it('returns real symbols sharing the failed proposal\'s words', () => {
    const near = nearbySymbols(TABLE, 'TrackSelector', 5).map((s) => s.bare);
    assert.ok(near.length > 0);
    assert.ok(near.includes('updateSelectedTrack') || near.includes('determineIdealSelectedIndex'));
  });
  it('returns nothing for a proposal sharing no words', () => {
    assert.deepEqual(nearbySymbols(TABLE, 'zzzz', 5), []);
  });
});

describe('proposal parsing', () => {
  it('parses ELEMENT lines with multiple symbols', () => {
    const p = parseProposedSymbols('ELEMENT 1: AdaptiveTrackSelection; DefaultLoadControl.shouldStartPlayback\nELEMENT 2: NONE');
    assert.equal(p.length, 3); // NONE parses as a bare token, filtered by verification
    assert.equal(p[0].candidate, 'AdaptiveTrackSelection');
    assert.equal(p[0].element, 1);
    assert.equal(p[1].candidate, 'DefaultLoadControl.shouldStartPlayback');
  });
  it('tolerates bullets, bold, and backticks', () => {
    const p = parseProposedSymbols('- **ELEMENT 3:** `Foo::bar`');
    assert.equal(p[0].candidate, 'Foo::bar');
    assert.equal(p[0].element, 3);
  });
  it('rejects prose and de-dupes', () => {
    const p = parseProposedSymbols('Here is my analysis of the claim.\nELEMENT 1: Foo\nELEMENT 2: Foo');
    assert.equal(p.length, 1);
  });
});

// The DEFAULT path. Its premise: the model must never need to have seen this
// codebase, because the real use case is confidential code with no training
// presence. So step 1 shows the model NO codebase information at all.
describe('discovery path (default)', () => {
  it('step-1 prompt asks for code words and reveals no codebase identity', () => {
    const p = buildDiscoverPrompt();
    assert.match(p, /WORDS that would appear in the NAMES/);
    assert.match(p, /NOT told which codebase this is/);
    assert.doesNotMatch(p, /Symbols indexed|packages\/directories/);
  });
  it('parses per-element word lists, dropping punctuation and phrases', () => {
    const w = parseElementWords('ELEMENT 1: bitrate; quality, switch\nELEMENT 2: buffer; a');
    assert.deepEqual(w[0], { element: 1, words: ['bitrate', 'quality', 'switch'] });
    assert.deepEqual(w[1].words, ['buffer']); // "a" too short
  });
  it('searches the symbol table by words, excluding test symbols', () => {
    const syms = [
      { filepath: 'src/main/A.java', name: 'RateChooser::chooseBitrate', bare: 'chooseBitrate', start: 1, end: 20, tokens: [] },
      { filepath: 'src/test/A.java', name: 'RateChooserTest::chooseBitrateWhenBufferLowAndQualityHigh', bare: 'x', start: 1, end: 90, tokens: [] },
    ];
    const hits = searchSymbolsByWords(syms, ['bitrate', 'choose', 'quality']);
    assert.equal(hits.length, 1, 'test symbol excluded');
    assert.equal(hits[0].sym.name, 'RateChooser::chooseBitrate');
    const withTests = searchSymbolsByWords(syms, ['bitrate', 'choose', 'quality'], { includeTests: true });
    assert.equal(withTests.length, 2);
  });
  it('de-duplicates candidates by name', () => {
    const syms = [
      { filepath: 'a.java', name: 'getBufferedDuration', bare: 'getBufferedDuration', start: 1, end: 5, tokens: [] },
      { filepath: 'b.java', name: 'getBufferedDuration', bare: 'getBufferedDuration', start: 1, end: 5, tokens: [] },
    ];
    assert.equal(searchSymbolsByWords(syms, ['buffer', 'duration']).length, 1);
  });
  it('identifies test symbols by segment-END name too', () => {
    assert.equal(isTestSymbol({ name: 'DrmPlaybackTest::clearkeyPlayback_x', filepath: 'a.java' }), true);
    assert.equal(isTestSymbol({ name: 'Foo::bar', filepath: 'src/test/java/Foo.java' }), true);
    assert.equal(isTestSymbol({ name: 'DefaultLoadControl::shouldStartPlayback', filepath: 'src/main/java/X.java' }), false);
  });
  it('blind mode hides file paths from the select prompt', () => {
    const per = [{ element: 1, text: 'an element', hits: [{ sym: { name: 'Foo::bar', filepath: 'zip!secret/pkg/Foo.java' }, matched: ['bar'] }] }];
    assert.doesNotMatch(buildSelectPrompt(per, { blind: true }), /secret\/pkg/);
    assert.match(buildSelectPrompt(per, { blind: false }), /secret\/pkg/);
    assert.match(buildSelectPrompt(per, { blind: true }), /Foo::bar/, 'names always shown');
  });

  it('end-to-end: words -> index search -> selection -> verified rows', async () => {
    const fnIndex = {
      'src/main/Rate.java': { 'RateChooser::chooseBitrate': { start: 10, end: 40 } },
      'src/test/Rate.java': { 'RateChooserTest::chooseBitrateHigh': { start: 1, end: 99 } },
    };
    const index = { functionIndex: fnIndex, _ensureFunctionIndex() {}, findCallers: () => [], findCallees: () => [] };
    const calls = [];
    const draft = async (sys) => {
      calls.push(sys);
      if (/WORDS that would appear/.test(sys)) return 'ELEMENT 1: bitrate; choose\nELEMENT 2: bitrate';
      return 'ELEMENT 1: RateChooser::chooseBitrate';
    };
    const res = await doClaimLocate(index,
      { claim_locate: 'A system, comprising: choosing a rate; sending it.', model: 'f.gguf', no_refine: true },
      { draft });
    assert.equal(calls.length, 2, 'two calls: words then selection');
    assert.doesNotMatch(calls[0], /Rate\.java/, 'step 1 shows the model nothing about the codebase');
    assert.match(calls[1], /RateChooser::chooseBitrate/, 'step 2 offers real symbols');
    assert.doesNotMatch(calls[1], /RateChooserTest/, 'test symbols not offered');
    const v = res.rows.filter((r) => r.verified).map((r) => r.match.name);
    assert.deepEqual(v, ['RateChooser::chooseBitrate']);
  });
});

describe('claim element splitting + prompt shape', () => {
  it('splits preamble from semicolon-separated limitations', () => {
    const e = splitClaimElements('A system, comprising: doing a thing; doing another thing.');
    assert.deepEqual(e, ['doing a thing', 'doing another thing']);
  });
  it('prefers LINE structure — the shape real claims are typeset in', () => {
    // The '101 claim has 6 lines but only 1 semicolon, and its first ':' is a
    // trailing "wherein:" — colon-then-semicolon splitting yielded 2 elements
    // for a 6-element claim.
    const claim = [
      '1. A distribution system, including a transmission device and a reception device,',
      'the transmission device being equipped with a content transmitting unit for transmitting content data,',
      'the reception device being equipped with a content reproducing unit for storing received data, wherein:',
      'the content transmitting unit is configured to change the code rate; and',
      'the content reproducing unit is configured to start reproduction at the set time.',
    ].join('\n');
    const e = splitClaimElements(claim);
    assert.equal(e.length, 5);
    assert.match(e[0], /^A distribution system/, 'leading claim number stripped');
    assert.doesNotMatch(e[3], /;\s*and$/, 'trailing "; and" trimmed');
  });
  it('prompt demands symbol names and explicitly does NOT constrain to the profile', () => {
    const p = buildProposePrompt('Symbols indexed: 10');
    assert.match(p, /SYMBOL NAMES/);
    assert.match(p, /NOT restricted to names appearing in the profile/);
    assert.match(p, /not search terms/);
    assert.match(p, /checked against the real index/);
  });
  it('profile advertises itself as a style reference, not a whitelist', () => {
    const prof = buildIndexProfile({}, TABLE, { sample: 3 });
    assert.match(prof, /NOT limited to these/);
  });
});

describe('report formatting', () => {
  it('shows verified rows with provenance and lists NOT FOUND separately', () => {
    const rows = [
      { candidate: 'updateSelectedTrack', element: 1, round: 1, verified: true, status: 'exact', match: TABLE[0], nav: { callers: ['x'], callees: ['determineIdealSelectedIndex'] } },
      { candidate: 'CodeRateDeterminingUnit', element: 2, round: 1, verified: false, status: 'not-found', match: null, nav: null },
    ];
    const out = formatLocateReport(rows, { targetsLine: true }).join('\n');
    assert.match(out, /\[exact, function-scale\] AdaptiveTrackSelection::updateSelectedTrack {2}\(L436-485\)/);
    assert.match(out, /calls: determineIdealSelectedIndex/);
    assert.match(out, /NOT FOUND in this index \(1\)/);
    assert.match(out, /CodeRateDeterminingUnit/);
    assert.match(out, /Verified 1 of 2 proposals/);
    assert.match(out, /--targets "/);
  });

  it('reports specificity and flags the safe-but-empty pattern', () => {
    // The failure mode measured live: a provider verified 48/48 by naming
    // large container classes and missed the claimed mechanism. Verification
    // rate must not read as quality.
    const big = (n, span) => ({
      candidate: n, element: 1, round: 1, verified: true, status: 'exact', ambiguous: 0,
      match: { name: n, filepath: 'x/A.java', start: 1, end: 1 + span }, nav: null,
    });
    const out = formatLocateReport([big('BigA', 2000), big('BigB', 1500), big('BigC', 900),
      big('BigD', 800), big('BigE', 700)]).join('\n');
    assert.match(out, /Specificity: 0\/5 model-proposed symbols are function-scale \(0%\)/);
    assert.match(out, /proposed safe container classes/);
    assert.match(out, /class-scale 2000 lines/);
  });

  it('does not flag when proposals are specific', () => {
    const small = (n) => ({
      candidate: n, element: 1, round: 1, verified: true, status: 'exact', ambiguous: 0,
      match: { name: n, filepath: 'x/A.java', start: 1, end: 40 }, nav: null,
    });
    const out = formatLocateReport([small('a'), small('b'), small('c'), small('d'), small('e')]).join('\n');
    assert.match(out, /Specificity: 5\/5 model-proposed symbols are function-scale \(100%\)/);
    assert.doesNotMatch(out, /safe container classes/);
  });
});

describe('doClaimLocate end-to-end (mock drafter, stub index)', () => {
  it('verifies proposals, navigates, and refines once', async () => {
    const fnIndex = {};
    for (const s of TABLE) {
      fnIndex[s.filepath] = fnIndex[s.filepath] || {};
      fnIndex[s.filepath][s.name] = { start: s.start, end: s.end };
    }
    const index = {
      functionIndex: fnIndex,
      _ensureFunctionIndex() {},
      findCallers: () => [{ function: 'evaluateQueueSize' }],
      findCallees: () => [{ function: 'determineIdealSelectedIndex' }],
    };
    let round = 0;
    const draft = async (sys) => {
      round++;
      if (/Real symbols sharing its words/.test(sys)) return 'ELEMENT 2: shouldStartPlayback';
      return 'ELEMENT 1: updateSelectedTrack; NoSuchThingHere\nELEMENT 2: AlsoMissing';
    };
    const res = await doClaimLocate(index,
      { claim_locate: 'A system, comprising: picking a rate; starting playback.', model: 'fake.gguf', temperature: 0, propose_from_priors: true },
      { draft });
    assert.ok(res, 'returns a result');
    assert.equal(round, 2, 'one propose + one refine round');
    const verified = res.rows.filter((r) => r.verified).map((r) => r.candidate);
    assert.ok(verified.includes('updateSelectedTrack'));
    assert.ok(verified.includes('shouldStartPlayback'), 'refine round recovered a real symbol');
    const missing = res.rows.filter((r) => !r.verified).map((r) => r.candidate);
    assert.ok(missing.includes('NoSuchThingHere'), 'hallucinated proposal reported, not dropped');
    const nav = res.rows.find((r) => r.candidate === 'updateSelectedTrack').nav;
    assert.ok(nav.callees.includes('determineIdealSelectedIndex'), 'one-hop navigation ran');
  });

  it('promotes navigated callees to verified rows with navigation provenance', async () => {
    // The decision function is a CALLEE of the entry point models name; it is
    // unreachable by proposal alone, so the index must contribute it.
    const fnIndex = {
      'x/AdaptiveTrackSelection.java': {
        'AdaptiveTrackSelection::updateSelectedTrack': { start: 436, end: 485 },
        'AdaptiveTrackSelection::determineIdealSelectedIndex': { start: 599, end: 613 },
      },
    };
    const index = {
      functionIndex: fnIndex,
      _ensureFunctionIndex() {},
      findCallers: () => [],
      findCallees: () => [{ callee_function: 'determineIdealSelectedIndex' }],
    };
    const draft = async () => 'ELEMENT 1: AdaptiveTrackSelection::updateSelectedTrack';
    const res = await doClaimLocate(index,
      { claim_locate: 'A system, comprising: picking a rate; starting playback.', model: 'fake.gguf', temperature: 0, no_refine: true, propose_from_priors: true },
      { draft });
    const navRow = res.rows.find((r) => r.candidate === 'determineIdealSelectedIndex');
    assert.ok(navRow, 'callee promoted to a row');
    assert.ok(navRow.verified);
    assert.equal(navRow.viaNavigation, 'AdaptiveTrackSelection::updateSelectedTrack');
    assert.equal(navRow.match.start, 599);
  });

  it('--no-navigate suppresses promotion', async () => {
    const index = {
      functionIndex: { 'x/A.java': { 'A::seed': { start: 1, end: 2 }, 'A::other': { start: 3, end: 4 } } },
      _ensureFunctionIndex() {},
      findCallers: () => [],
      findCallees: () => [{ callee_function: 'other' }],
    };
    const res = await doClaimLocate(index,
      { claim_locate: 'A system, comprising: a thing; another thing.', model: 'f.gguf', no_refine: true, no_navigate: true, propose_from_priors: true },
      { draft: async () => 'ELEMENT 1: A::seed' });
    assert.equal(res.rows.filter((r) => r.viaNavigation).length, 0);
  });
});
