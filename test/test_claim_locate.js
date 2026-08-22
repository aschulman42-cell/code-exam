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
import fs from 'node:fs';
import {
  splitClaimElements, subdivideElement, parseElementsFile, retrievePerElement,
  repairStrayAndComma, isPreambleRow,
  SPLIT_DEFAULTS,
  buildProposePrompt, buildIndexProfile, formatLocateReport,
  doClaimLocate, buildDiscoverPrompt, parseElementWords, searchSymbolsByWords,
  buildSelectPrompt, isTestSymbol,
  buildHuntPrompt, parseHuntActions, makeHuntTools, runSymbolHunt, HUNT_DEFAULTS,
  transcriptSymbols, selectionSeen, partitionSelections,
  buildTargetsProvenance, targetsChecksum, targetSpecs,
  normalizeTargetSpec, dedupeTargets, classifyNavCallee,
} from '../src/commands/claim-locate.js';
import { fileURLToPath } from 'node:url';
// Fixtures resolve from THIS FILE, never from the working directory. A bare
// readFileSync('name.txt') resolves against cwd, which is what made these
// files' absence invisible to anyone running npm test from the repo root
// with them already sitting there (#314).
const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

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
    // NONE is an abstention the prompts explicitly invite, so it must not
    // become a proposal. It previously did — shaped like an identifier, it was
    // verified, failed, and surfaced as a NOT-FOUND row, i.e. the model's
    // correct "no implementer here" was reported as a bad guess.
    assert.equal(p.length, 2);
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
    // Selection POOLS all elements into one call: 1 vocabulary + 1 selection.
    // Splitting it per element was measured on 2026-08-08 and LOST on recall
    // (shouldStartPlayback 5/5 pooled vs 3/6 per-element, same build, n=5/6);
    // it survives behind --per-element-select, covered below.
    assert.equal(calls.length, 2, 'one words call, then one pooled selection call');
    assert.doesNotMatch(calls[0], /Rate\.java/, 'step 1 shows the model nothing about the codebase');
    assert.match(calls[1], /RateChooser::chooseBitrate/, 'step 2 offers real symbols');
    assert.doesNotMatch(calls[1], /RateChooserTest/, 'test symbols not offered');
    // Both elements in ONE prompt. Best current explanation for why pooling
    // wins: it supplies cross-element CONTEXT, not just competition — a claim is
    // one system. Count real candidate blocks, not the prompt's own
    // "ELEMENT 1: ExactName" output examples.
    assert.equal((calls[1].match(/Candidates found in the codebase:/g) || []).length, 2,
      'both elements offered in one prompt');
    const v = res.rows.filter((r) => r.verified).map((r) => r.match.name);
    assert.deepEqual(v, ['RateChooser::chooseBitrate']);
  });

  it('--per-element-select splits selection into one call per element', async () => {
    const fnIndex = {
      'src/main/Rate.java': { 'RateChooser::chooseBitrate': { start: 10, end: 40 } },
    };
    const index = { functionIndex: fnIndex, _ensureFunctionIndex() {}, findCallers: () => [], findCallees: () => [] };
    const calls = [];
    const draft = async (sys) => {
      calls.push(sys);
      if (/WORDS that would appear/.test(sys)) return 'ELEMENT 1: bitrate; choose\nELEMENT 2: bitrate';
      return 'ELEMENT 1: RateChooser::chooseBitrate';
    };
    await doClaimLocate(index,
      { claim_locate: 'A system, comprising: choosing a rate; sending it.', model: 'f.gguf',
        no_refine: true, per_element_select: true },
      { draft });
    assert.equal(calls.length, 3, 'words + one selection call per element');
    for (const c of calls.slice(1)) {
      assert.equal((c.match(/Candidates found in the codebase:/g) || []).length, 1,
        'one element per selection call');
    }
  });

  it('per-element: attributes each selection to the element ASKED about, not the one named', async () => {
    // Asked about one element in isolation, models routinely answer "ELEMENT 1:"
    // whatever the real number is. Trusting that would mis-attribute every
    // selection after the first. Only reachable under --per-element-select.
    const fnIndex = {
      'src/main/Rate.java': { 'RateChooser::chooseBitrate': { start: 10, end: 40 } },
      'src/main/Send.java': { 'Sender::sendBitrate': { start: 10, end: 40 } },
    };
    const index = { functionIndex: fnIndex, _ensureFunctionIndex() {}, findCallers: () => [], findCallees: () => [] };
    let n = 0;
    const draft = async (sys) => {
      if (/WORDS that would appear/.test(sys)) return 'ELEMENT 1: bitrate\nELEMENT 2: bitrate';
      // Both answers claim to be ELEMENT 1.
      return `ELEMENT 1: ${++n === 1 ? 'RateChooser::chooseBitrate' : 'Sender::sendBitrate'}`;
    };
    const res = await doClaimLocate(index,
      { claim_locate: 'A system, comprising: choosing a rate; sending it.', model: 'f.gguf',
        no_refine: true, per_element_select: true },
      { draft });
    const byName = Object.fromEntries(res.rows.filter((r) => r.verified).map((r) => [r.match.name, r.element]));
    assert.equal(byName['RateChooser::chooseBitrate'], 1);
    assert.equal(byName['Sender::sendBitrate'], 2, 'second answer belongs to element 2 despite saying ELEMENT 1');
  });
});

describe('claim element splitting + prompt shape', () => {
  it('splits preamble from semicolon-separated limitations, KEEPING the preamble', () => {
    // UPDATED 2026-08-16. This test previously asserted
    //   ['doing a thing', 'doing another thing']
    // i.e. that the preamble was DISCARDED -- it had locked in the defect.
    // Measured across 5,382 real independent claims, that path dropped the
    // preamble on 98.7% of them, against Andrew's explicit ruling (#310) that
    // "preamble must always be shown as first row".
    const e = splitClaimElements('A system, comprising: doing a thing; doing another thing.');
    assert.deepEqual(e, ['A system, comprising:', 'doing a thing', 'doing another thing']);
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

// ===========================================================================
// SCAVENGER HUNT
//
// Fixtures here are deliberately NEUTRAL (Ledger/Journal/Router), not drawn
// from any corpus CE has been measured against. The hunt's QUALITY is decided
// by the pre-registered live gate, never in this file; what is asserted here is
// only the mechanism — that commands parse, that tools read the index and not
// the model's imagination, that the budget actually stops the loop, and that a
// hunt which searched nothing is reported as ungrounded.
// ===========================================================================

const HUNT_INDEX = {
  functionIndex: {
    'src/Ledger.java': {
      'Ledger::recordEntry': { start: 10, end: 40 },
      'Ledger::computeBalance': { start: 42, end: 70 },
      'Ledger::flushJournal': { start: 72, end: 95 },
    },
    'src/Router.java': {
      'Router::dispatch': { start: 5, end: 30 },
    },
    'src/LedgerTest.java': {
      'LedgerTest::recordEntry_writesJournal': { start: 1, end: 9 },
    },
  },
  _ensureFunctionIndex() {},
  findCallers: () => [{ caller_function: 'Router::dispatch' }],
  findCallees: () => [{ callee_function: 'flushJournal' }],
  getFunctionSource: (fp, name) => (name.includes('computeBalance')
    ? 'int computeBalance() {\n  return debits - credits;\n}' : null),
};
const HUNT_SYMBOLS = buildSymbolTable(HUNT_INDEX);

describe('hunt: command parsing', () => {
  it('parses one command per line and tolerates decoration', () => {
    const { actions, done } = parseHuntActions(
      '- SEARCH: balance compute\n**MEMBERS: Ledger**\n> `EXTRACT: Ledger::computeBalance`');
    assert.equal(done, false);
    assert.deepEqual(actions.map((a) => a.tool), ['SEARCH', 'MEMBERS', 'EXTRACT']);
    assert.equal(actions[0].arg, 'balance compute');
    assert.equal(actions[2].arg, 'Ledger::computeBalance');
  });

  it('ignores prose that is not a command', () => {
    const { actions } = parseHuntActions('Let me think about this claim.\nI will look for a ledger.');
    assert.equal(actions.length, 0);
  });

  it('detects DONE and parses the selections after it', () => {
    const { done, selections, actions } = parseHuntActions(
      'DONE\nELEMENT 1: Ledger::computeBalance\nELEMENT 2: NONE');
    assert.equal(done, true);
    assert.equal(actions.length, 0);
    assert.deepEqual(selections.map((s) => s.candidate), ['Ledger::computeBalance']);
  });

  it('stops collecting commands once DONE appears', () => {
    const { actions, done } = parseHuntActions('SEARCH: one\nDONE\nSEARCH: two\nELEMENT 1: Router::dispatch');
    assert.equal(done, true);
    assert.deepEqual(actions.map((a) => a.arg), ['one']);
  });
});

describe('hunt: tools read the index', () => {
  const run = makeHuntTools(HUNT_INDEX, HUNT_SYMBOLS, {});

  it('SEARCH returns real symbol names', () => {
    const out = run('SEARCH', 'balance');
    assert.match(out, /Ledger::computeBalance/);
  });

  it('SEARCH excludes test symbols by default', () => {
    assert.doesNotMatch(run('SEARCH', 'record entry'), /LedgerTest/);
  });

  it('SEARCH reports an honest miss instead of guessing', () => {
    assert.match(run('SEARCH', 'nonexistentword'), /^No symbol name contains/);
  });

  it('MEMBERS lists the rest of a class', () => {
    const out = run('MEMBERS', 'Ledger');
    assert.match(out, /Ledger::recordEntry/);
    assert.match(out, /Ledger::flushJournal/);
    assert.doesNotMatch(out, /Router::dispatch/);
  });

  it('CALLERS and CALLEES navigate from a resolved symbol', () => {
    assert.match(run('CALLERS', 'Ledger::computeBalance'), /Router::dispatch/);
    assert.match(run('CALLEES', 'Ledger::computeBalance'), /flushJournal/);
  });

  it('EXTRACT returns source for a real symbol', () => {
    const out = run('EXTRACT', 'Ledger::computeBalance');
    assert.match(out, /debits - credits/);
    assert.match(out, /L42-70/);
  });

  it('every tool refuses a symbol that does not exist', () => {
    for (const t of ['CALLERS', 'CALLEES', 'EXTRACT']) {
      assert.match(run(t, 'Imaginary::method'), /No symbol named/, `${t} should refuse`);
    }
  });

  it('blind mode withholds file paths', () => {
    const blind = makeHuntTools(HUNT_INDEX, HUNT_SYMBOLS, { blind: true });
    assert.doesNotMatch(blind('SEARCH', 'balance'), /src\//);
    assert.doesNotMatch(blind('MEMBERS', 'Ledger'), /src\//);
    assert.match(run('SEARCH', 'balance'), /src\//, 'non-blind still shows paths');
  });
});

describe('hunt: the loop', () => {
  const CLAIM = { claimText: 'A method, comprising: totalling the entries.', elements: ['totalling the entries'], index: HUNT_INDEX, symbols: HUNT_SYMBOLS };

  // A scripted drafter: one reply per turn, so the loop's control flow is
  // exercised without a live model.
  const scripted = (replies) => {
    let i = 0;
    const seen = [];
    const fn = async (sys, user) => { seen.push(user); return replies[Math.min(i++, replies.length - 1)]; };
    fn.seen = seen;
    return fn;
  };

  it('runs commands, feeds results back, and finishes on DONE', async () => {
    const draft = scripted([
      'SEARCH: balance',
      'EXTRACT: Ledger::computeBalance',
      'DONE\nELEMENT 1: Ledger::computeBalance',
    ]);
    const r = await runSymbolHunt(draft, CLAIM);
    assert.equal(r.stopped, 'done');
    assert.equal(r.toolCalls, 2);
    assert.equal(r.rounds, 3);
    assert.deepEqual(r.selections.map((s) => s.candidate), ['Ledger::computeBalance']);
    // Turn 2 must actually contain turn 1's result — otherwise the model is
    // hunting blind and the loop is theatre.
    assert.match(draft.seen[1], /Ledger::computeBalance/);
    assert.match(draft.seen[2], /debits - credits/);
  });

  it('stops at the tool-call budget and tells the model to conclude', async () => {
    const draft = scripted(['SEARCH: balance\nSEARCH: entry\nSEARCH: journal', 'DONE\nELEMENT 1: Ledger::flushJournal']);
    const r = await runSymbolHunt(draft, { ...CLAIM, opts: { maxCalls: 2 } });
    assert.equal(r.toolCalls, 2, 'third call refused');
    assert.match(draft.seen[1], /TOOL BUDGET EXHAUSTED/);
  });

  it('stops at the round ceiling even if the model never says DONE', async () => {
    const draft = scripted(['SEARCH: balance']);
    const r = await runSymbolHunt(draft, { ...CLAIM, opts: { maxRounds: 3 } });
    assert.equal(r.stopped, 'max-rounds');
    assert.equal(r.rounds, 3);
    assert.equal(r.selections.length, 0);
    assert.match(draft.seen[2], /LAST turn/);
  });

  it('records zero tool calls when the model answers without searching', async () => {
    const draft = scripted(['DONE\nELEMENT 1: Ledger::computeBalance']);
    const r = await runSymbolHunt(draft, CLAIM);
    assert.equal(r.toolCalls, 0, 'the fabrication signal');
    assert.equal(r.stopped, 'done');
  });

  it('nudges once when the model writes prose, then gives up', async () => {
    const draft = scripted(['I think this is about accounting.']);
    const r = await runSymbolHunt(draft, { ...CLAIM, opts: { maxRounds: 6 } });
    assert.equal(r.stopped, 'no-commands');
    assert.ok(r.rounds <= 3, `gave up quickly, took ${r.rounds}`);
  });

  it('survives a drafter that throws', async () => {
    const r = await runSymbolHunt(async () => { throw new Error('provider down'); }, CLAIM);
    assert.match(r.stopped, /provider down/);
    assert.equal(r.selections.length, 0);
  });
});

describe('hunt: end-to-end through doClaimLocate', () => {
  it('verifies hunt selections and reports the tool-call count', async () => {
    const replies = ['SEARCH: balance', 'DONE\nELEMENT 1: Ledger::computeBalance'];
    let i = 0;
    const res = await doClaimLocate(HUNT_INDEX,
      { claim_locate: 'A method, comprising: totalling the entries; routing them.', model: 'f.gguf', hunt: true, no_refine: true, no_navigate: true },
      { draft: async () => replies[Math.min(i++, replies.length - 1)] });
    assert.equal(res.hunt.toolCalls, 1);
    const row = res.rows.find((r) => r.candidate === 'Ledger::computeBalance');
    assert.ok(row && row.verified, 'selection verified against the index');
  });

  it('flags an ungrounded hunt in the report', () => {
    const rows = [{
      candidate: 'Ledger::computeBalance', element: 1, verified: true, status: 'exact', ambiguous: 0,
      match: { name: 'Ledger::computeBalance', filepath: 'src/Ledger.java', start: 42, end: 70 }, nav: null,
    }];
    const text = formatLocateReport(rows, { hunt: { toolCalls: 0, stopped: 'done' } }).join('\n');
    assert.match(text, /UNGROUNDED/);
    assert.match(text, /Treat as a failed hunt/);
  });

  it('notes when the hunt was cut off rather than concluded', () => {
    const rows = [{
      candidate: 'Ledger::computeBalance', element: 1, verified: true, status: 'exact', ambiguous: 0,
      match: { name: 'Ledger::computeBalance', filepath: 'src/Ledger.java', start: 42, end: 70 }, nav: null,
    }];
    const text = formatLocateReport(rows, { hunt: { toolCalls: 9, stopped: 'max-rounds' } }).join('\n');
    assert.match(text, /ended on 'max-rounds'/);
    assert.doesNotMatch(text, /UNGROUNDED/);
  });

  it('a clean hunt gets neither warning', () => {
    const rows = [{
      candidate: 'Ledger::computeBalance', element: 1, verified: true, status: 'exact', ambiguous: 0,
      match: { name: 'Ledger::computeBalance', filepath: 'src/Ledger.java', start: 42, end: 70 }, nav: null,
    }];
    const text = formatLocateReport(rows, { hunt: { toolCalls: 6, stopped: 'done' } }).join('\n');
    assert.doesNotMatch(text, /UNGROUNDED|ended on/);
  });
});

describe('NONE is an answer, not a symbol', () => {
  it('parseProposedSymbols drops abstentions', () => {
    const out = parseProposedSymbols('ELEMENT 1: Ledger::computeBalance\nELEMENT 2: NONE\nELEMENT 3: n/a');
    assert.deepEqual(out.map((r) => r.candidate), ['Ledger::computeBalance']);
  });

  it('an all-NONE hunt reports a substantive answer, not an error', async () => {
    const replies = ['SEARCH: balance', 'DONE\nELEMENT 1: NONE'];
    let i = 0;
    const prevExit = process.exitCode;
    const res = await doClaimLocate(HUNT_INDEX,
      { claim_locate: 'A method, comprising: doing something absent.', model: 'f.gguf', hunt: true },
      { draft: async () => replies[Math.min(i++, replies.length - 1)] });
    assert.equal(res.rows.length, 0);
    assert.equal(process.exitCode, prevExit, 'not treated as a failure');
  });
});

// ===========================================================================
// TRANSCRIPT-MEMBERSHIP GATE
//
// Two-sided by construction. The fixtures below are the REAL shapes from the
// two blind Gemini runs on the '101 claim: run 1's inventions must be rejected,
// and run 2's composed name must survive. A guard that only does the first is
// too strict and breaks legitimate inference from observed parts.
// ===========================================================================

describe('transcript membership', () => {
  // Result shapes exactly as the tools emit them: bare names (blind), names
  // with a trailing [path], and an EXTRACT header with a line range.
  const LOG = [
    '> SEARCH: message channel\nRtspMessageChannel\nRtspMessageChannel::Sender\nRtspMessageChannel::Receiver',
    '> EXTRACT: Sender::send\nSender::send  (L231-245)\n  private void send(List<String> message) {\n    return;\n  }',
    '> MEMBERS: Ledger\nLedger::computeBalance   [src/Ledger.java]\nLedger::flushJournal   [src/Ledger.java]',
  ];

  it('collects symbols from results but never from the command echo', () => {
    const seen = transcriptSymbols(LOG);
    assert.ok(seen.full.has('RtspMessageChannel::Sender'));
    assert.ok(seen.full.has('Ledger::computeBalance'), 'strips the trailing [path]');
    assert.ok(seen.bare.has('send'), 'bare name from an EXTRACT header');
    // `MEMBERS: Ledger` and `SEARCH: message channel` are model INPUT; if the
    // echo counted, a model could authorize its own invention by asking for it.
    assert.ok(!seen.full.has('MEMBERS'));
    assert.ok(!seen.full.has('SEARCH'));
  });

  it('does not harvest identifiers out of extracted source', () => {
    const seen = transcriptSymbols(LOG);
    for (const t of ['private', 'return', 'List']) {
      assert.ok(!seen.full.has(t), `source token '${t}' must not become evidence`);
    }
  });

  it('accepts a name seen verbatim', () => {
    assert.equal(selectionSeen('RtspMessageChannel::Receiver', transcriptSymbols(LOG)), true);
  });

  it('accepts composition from an observed class and an observed member', () => {
    // Run 2's real selection: class from a search result, member from an
    // extract header. It verified exact against the index.
    assert.equal(selectionSeen('RtspMessageChannel::Sender::send', transcriptSymbols(LOG)), true);
  });

  it('rejects an invented class even when the member word was seen', () => {
    // Run 1's real failure: `append`/`getSample` are ordinary words, but no
    // PlaybackBuffer was ever shown. This is the case substring matching
    // laundered into a 125-way-ambiguous "verified" citation.
    const seen = transcriptSymbols(LOG);
    assert.equal(selectionSeen('PlaybackBuffer::send', seen), false);
    assert.equal(selectionSeen('PlaybackBuffer::append', seen), false);
  });

  it('rejects a wholly invented bare name', () => {
    assert.equal(selectionSeen('totallyMadeUpThing', transcriptSymbols(LOG)), false);
  });

  it('partitions selections and keeps element attribution', () => {
    const { kept, unseen } = partitionSelections([
      { element: 1, candidate: 'RtspMessageChannel::Sender::send' },
      { element: 2, candidate: 'PlaybackBuffer::append' },
      { element: 3, candidate: 'Ledger::computeBalance' },
    ], LOG);
    assert.deepEqual(kept.map((k) => k.candidate), ['RtspMessageChannel::Sender::send', 'Ledger::computeBalance']);
    assert.deepEqual(unseen.map((u) => u.candidate), ['PlaybackBuffer::append']);
    assert.equal(unseen[0].element, 2);
  });
});

describe('rejected selections reach the report and not --targets', () => {
  it('an unseen selection is never verified and never charted', async () => {
    // The model searches once, then names something the search never returned.
    const replies = ['SEARCH: balance', 'DONE\nELEMENT 1: Ledger::computeBalance; Imaginary::fabricated'];
    let i = 0;
    const res = await doClaimLocate(HUNT_INDEX,
      { claim_locate: 'A method, comprising: totalling the entries; routing them.', model: 'f.gguf', hunt: true, no_refine: true, no_navigate: true },
      { draft: async () => replies[Math.min(i++, replies.length - 1)] });
    assert.ok(!res.rows.some((r) => r.candidate === 'Imaginary::fabricated'),
      'an unseen name must not become a verified row');
    assert.ok(res.rows.some((r) => r.candidate === 'Ledger::computeBalance'),
      'the seen selection still verifies');
  });

  it('the report names what it rejected and why', () => {
    const text = formatLocateReport([], {
      hunt: { toolCalls: 4, stopped: 'done' },
      unseen: [{ candidate: 'PlaybackBuffer::append', element: 3 }],
    }).join('\n');
    assert.match(text, /REJECTED/);
    assert.match(text, /PlaybackBuffer::append/);
    assert.match(text, /element 3/);
    assert.match(text, /substring matching can resolve a guess/);
  });
});

// ---------------------------------------------------------------------------
// Targets-file provenance. This exists because the first '101 chart's
// provenance block was typed by hand: the command recorded nothing about how
// it was invoked, so "was this run with --llm gemini?" could not be answered
// from the artifact. These tests pin the parts that must be MACHINE-recorded.
// ---------------------------------------------------------------------------
describe('targets provenance', () => {
  const base = {
    ceVersion: 'v0.5.0',
    engine: 'Gemini API — gemini-2.5-flash (cloud LLM)',
    mode: 'scavenger hunt (model searches the symbol table itself) — BLIND',
    indexPath: '.Idx', indexFiles: 3578, indexSymbols: 65370,
    claimSource: 'claim.txt', claimChars: 1369, elements: 6,
    argv: 'src/index.js --claim-locate @claim.txt --hunt --blind --llm gemini',
    generatedAt: '2026-08-06T12:00:00.000Z',
    targets: ['A.java@f', 'B.java@g'],
  };

  it('records the engine AND the exact model, not just the provider', () => {
    // "Claude API" alone makes two runs a year apart indistinguishable.
    const p = buildTargetsProvenance({ ...base, blind: true,
      hunt: { toolCalls: 32, rounds: 10, maxCalls: 40, maxRounds: 12, stopped: 'done' } });
    assert.ok(p.some((l) => l.includes('gemini-2.5-flash')), 'model id is recorded');
    assert.ok(p.some((l) => /^Command:/.test(l)), 'command line is recorded');
  });

  it('reports hunt caps, not just how close the run got to them', () => {
    // A run that finished under a raised cap and one that hit a default cap
    // are different runs; "32 calls" alone cannot tell them apart.
    const p = buildTargetsProvenance({ ...base, blind: true,
      hunt: { toolCalls: 32, rounds: 10, maxCalls: 40, maxRounds: 12, stopped: 'done' } });
    assert.ok(p.some((l) => l.includes('caps 40/12')), 'caps recorded');
  });

  it('prints mode flags from parsed args, not from a re-rendered argv', () => {
    // A truncated or reconstructed command line must not be able to misreport
    // the mode that actually ran, so --blind/--hunt come from the booleans.
    const p = buildTargetsProvenance({ ...base, blind: false, hunt: null,
      argv: 'src/index.js --claim-locate @c.txt --hunt --blind' });
    assert.ok(!/--claim-locate --hunt --blind/.test(p[0]),
      'header line must not claim modes the args did not set');
    assert.ok(!p.some((l) => /^Hunt:/.test(l)), 'no hunt line for a non-hunt run');
  });

  it('checksums the target list so a later edit is detectable', () => {
    const p = buildTargetsProvenance({ ...base, blind: true, hunt: null });
    const line = p.find((l) => /^Targets-checksum:/.test(l));
    assert.ok(line, 'checksum is emitted');
    assert.equal(line.split(/\s+/)[1], targetsChecksum(base.targets));
    assert.notEqual(targetsChecksum(base.targets), targetsChecksum(['A.java@f', 'B.java@CHANGED']));
  });

  it('checksums the normalized list, so reformatting is not an edit', () => {
    // `;`-joined on one line and one-per-line are the same list.
    assert.equal(targetsChecksum(['A.java@f', 'B.java@g']),
      targetsChecksum([' A.java@f ', 'B.java@g', '']));
  });

  it('--targets-out writes a file the chart can consume unedited', async () => {
    // The end-to-end point of this item: no hand-copying step between the
    // command that produced the targets and the chart that vouches for them.
    const fs = (await import('node:fs')).default;
    const path = `${process.env.TEMP || '/tmp'}/ce_targets_out.txt`;
    try { fs.unlinkSync(path); } catch { /* fresh */ }
    const fnIndex = {};
    for (const s2 of TABLE) {
      fnIndex[s2.filepath] = fnIndex[s2.filepath] || {};
      fnIndex[s2.filepath][s2.name] = { start: s2.start, end: s2.end };
    }
    const index = { functionIndex: fnIndex, _ensureFunctionIndex() {},
      findCallers: () => [], findCallees: () => [] };
    const draft = async () => 'ELEMENT 1: updateSelectedTrack';
    const log = console.log; console.log = () => {};
    try {
      await doClaimLocate(index, {
        claim_locate: 'A system, comprising: picking a rate.',
        model: 'fake.gguf', temperature: 0, propose_from_priors: true,
        no_refine: true, targets_out: path,
      }, { draft });
    } finally { console.log = log; }
    const body = fs.readFileSync(path, 'utf8');
    assert.match(body, /^# Produced by CodeExam/m, 'provenance block written');
    assert.match(body, /^# Targets-checksum: [0-9a-f]+$/m, 'checksum written');
    assert.match(body, /^AdaptiveTrackSelection\.java@AdaptiveTrackSelection::updateSelectedTrack$/m,
      'targets written one per line');
    assert.match(body, /local GGUF — fake\.gguf/, 'engine names the actual model');
  });

  it('derives target specs as basename@symbol', () => {
    assert.deepEqual(
      targetSpecs([{ match: { filepath: 'jar!/a/b/Foo.java', name: 'Foo::bar' } }]),
      ['Foo.java@Foo::bar']);
  });
});

// ---------------------------------------------------------------------------
// Target-list hygiene. Every case below is from the first live --targets-out
// runs against .AndroidX_Media_ExoPlayer3.
// ---------------------------------------------------------------------------
describe('target dedup', () => {
  it('treats qualified and unqualified specs as the same function', () => {
    // Models mix conventions within one list, and two engines disagree on
    // which they emit. A string compare would leave both, so the chart would
    // analyse one function twice and count it twice in the agreement tally.
    assert.equal(
      normalizeTargetSpec('AdaptiveTrackSelection.java@determineIdealSelectedIndex'),
      normalizeTargetSpec('AdaptiveTrackSelection.java@AdaptiveTrackSelection::determineIdealSelectedIndex'));
  });

  it('does not merge same-named symbols from different files', () => {
    assert.notEqual(normalizeTargetSpec('A.java@run'), normalizeTargetSpec('B.java@run'));
  });

  it('collapses the duplicates the live gemini run emitted', () => {
    const r = dedupeTargets([
      'AdaptiveTrackSelection.java@AdaptiveTrackSelection::determineIdealSelectedIndex',
      'NetworkTypeObserver.java@NetworkTypeObserver::Receiver::onReceive',
      'AdaptiveTrackSelection.java@AdaptiveTrackSelection::determineIdealSelectedIndex',
      'NetworkTypeObserver.java@NetworkTypeObserver::Receiver::onReceive',
    ]);
    assert.equal(r.targets.length, 2);
    assert.equal(r.duplicates, 2);
  });

  it('keeps first-seen order and the original spec text', () => {
    const r = dedupeTargets(['B.java@z', 'A.java@Cls::m', 'B.java@z']);
    assert.deepEqual(r.targets, ['B.java@z', 'A.java@Cls::m']);
  });

  it('drops a class target when its own methods are also targeted', () => {
    // The live Claude run charted the 815-line AdaptiveTrackSelection class
    // alongside four of its methods: the same source five times, and four
    // verdicts resting on evidence the fifth subsumed.
    const r = dedupeTargets([
      'AdaptiveTrackSelection.java@AdaptiveTrackSelection',
      'AdaptiveTrackSelection.java@AdaptiveTrackSelection::getAllocatedBandwidth',
      'AdaptiveTrackSelection.java@AdaptiveTrackSelection::canSelectFormat',
    ]);
    assert.deepEqual(r.containers, ['AdaptiveTrackSelection.java@AdaptiveTrackSelection']);
    assert.equal(r.targets.length, 2);
  });

  it('drops a NESTED class whose own method is also targeted', () => {
    // The live gemini run produced exactly this shape three times. An
    // outermost-only split registered `AdTagLoader` as the owner and left the
    // nested class standing beside its own method.
    const r = dedupeTargets([
      'AdTagLoader.java@ContentPlaybackAdapter',
      'AdTagLoader.java@AdTagLoader::ContentPlaybackAdapter::getContentProgress',
      'NetworkTypeObserver.java@Receiver',
      'NetworkTypeObserver.java@NetworkTypeObserver::Receiver::onReceive',
    ]);
    assert.deepEqual(r.containers.sort(),
      ['AdTagLoader.java@ContentPlaybackAdapter', 'NetworkTypeObserver.java@Receiver']);
    assert.equal(r.targets.length, 2);
  });

  it('KEEPS a class target when none of its methods are targeted', () => {
    // A class as the sole citation for an element is coarse but legitimate;
    // dropping it would leave the element with no evidence at all.
    const r = dedupeTargets(['Foo.java@Foo', 'Bar.java@Bar::baz']);
    assert.equal(r.containers.length, 0);
    assert.equal(r.targets.length, 2);
  });

  it('does not drop a class because a DIFFERENT file has that class name', () => {
    const r = dedupeTargets(['A.java@Widget', 'B.java@Widget::draw']);
    assert.equal(r.containers.length, 0, 'file scoping is respected');
  });
});

describe('navigation does not assert unresolved call edges', () => {
  // Live defect, 2026-08-07, present in BOTH engines' target lists.
  // `CachedContentIndex::store` calls `.size()` on a map; the index reports
  // `size [unresolved] (27 definitions)`. Promotion took matches[0] and emitted
  // "reached by navigation from store" pointing at `FlagSet.java@size` — a call
  // relationship the index knows it cannot resolve, stated as fact in the
  // deliverable.
  it('refuses to promote a callee with several candidate definitions', () => {
    assert.equal(classifyNavCallee({ status: 'exact', matches: [{ name: 'FlagSet::size' }], ambiguous: 27 }),
      'ambiguous');
    assert.equal(classifyNavCallee({ status: 'exact', matches: [{ name: 'ListenerSet::clear' }], ambiguous: 59 }),
      'ambiguous');
  });

  it('still promotes an unambiguous callee — the case navigation exists for', () => {
    // updateSelectedTrack -> determineIdealSelectedIndex is precisely the
    // cross-file edge this mechanism is worth having, and it resolves to one.
    assert.equal(classifyNavCallee({
      status: 'exact', matches: [{ name: 'AdaptiveTrackSelection::determineIdealSelectedIndex' }], ambiguous: 0,
    }), 'promote');
  });

  it('treats an unfound callee as nothing to say, not as a skip worth reporting', () => {
    assert.equal(classifyNavCallee({ status: 'not-found', matches: [] }), 'not-found');
    assert.equal(classifyNavCallee(null), 'not-found');
  });
});

describe('navigation honours --include-tests', () => {
  const TESTY = { name: 'elapsedRealtime', filepath: 'x!/libraries/test_utils/src/main/java/androidx/media3/test/utils/FakeClock.java' };

  it('recognises the live FakeClock path as test code', () => {
    assert.equal(isTestSymbol(TESTY), true);
  });

  it('does not treat a name merely containing "test" as test code', () => {
    assert.equal(isTestSymbol({ name: 'latestBitrate', filepath: 'src/main/Foo.java' }), false);
  });
});

// ===========================================================================
// claim-chart-limitation-granularity — finer element splitting.
//
// WHY: CE charted '101 claim 1 at 6 rows; RMS's ChatGPT chart used 12, which is
// the granularity practitioners work at. One verdict spanning four
// separately-arguable limitations says nothing about which part is met.
//
// These assert PROPERTIES (no connective fragments, markers respected, nothing
// dropped), never a row count for a specific real claim — encoding an expected
// answer here is the contamination this file exists to avoid.
// ===========================================================================
describe('finer claim splitting', () => {
  const CLAIM_101 = [
    '1. A distribution system, including a transmission device and a reception device,',
    'the transmission device being equipped with a content transmitting unit for transmitting content data, which is one content coded with any one code rate of a plurality of code rates, and',
    'the distribution system, comprising a code rate determining unit for determining the code rate based on a remaining time before reproduction start time set as the time at which reproduction starts, wherein:',
    'the content reproducing unit is configured to start reproduction at the set reproduction start time.',
  ].join('\n');

  it('subdivides past the coarse line split', () => {
    const coarse = splitClaimElements(CLAIM_101, { fine: false });
    const fine = splitClaimElements(CLAIM_101);
    assert.ok(fine.length > coarse.length, `expected finer than ${coarse.length}, got ${fine.length}`);
  });

  it('never emits a connective as a row', () => {
    for (const e of splitClaimElements(CLAIM_101)) {
      assert.ok(e.length >= SPLIT_DEFAULTS.minElementChars,
        `fragment under the floor became a row: ${JSON.stringify(e)}`);
      assert.doesNotMatch(e, /^(?:and|wherein|whereby|which is)[\s:.]*$/i);
    }
  });

  // The point of finer rows is finer VERDICTS, so no claim text may vanish.
  it('loses no claim words — a dropped limitation is a defective chart', () => {
    const words = (s) => String(s).toLowerCase().match(/[a-z]+/g) || [];
    const after = new Set(splitClaimElements(CLAIM_101).flatMap(words));
    for (const w of new Set(words(CLAIM_101))) {
      if (w === 'and') continue;             // trailing connectives are trimmed
      assert.ok(after.has(w), `word lost from the chart: ${w}`);
    }
  });

  // Sub-element markers are the claim declaring its OWN structure.
  it('groups wrapped continuation lines under their (a)/(i) marker', () => {
    const wrapped = [
      '1. A method comprising:',
      '',
      '  (a) initializing a cryptographic context by creating a security',
      '      protocol object configured with a minimum protocol version;',
      '',
      '  (b) negotiating cipher parameters between a client device and',
      '      a server device to agree a suite;',
    ].join('\n');
    const e = splitClaimElements(wrapped);
    // The bug this fixes: line-based splitting cut these mid-sentence, so a row
    // read "protocol object configured with a minimum protocol version".
    assert.ok(e.some((x) => /\(a\)/.test(x) && /minimum protocol version/.test(x)),
      '(a) must carry its continuation line');
    assert.ok(e.some((x) => /\(b\)/.test(x) && /agree a suite/.test(x)),
      '(b) must carry its continuation line');
    assert.ok(!e.some((x) => /^protocol object/.test(x)), 'no mid-sentence fragment');
  });

  it('honours the cap by returning the COARSE split, never a truncated one', () => {
    const many = Array.from({ length: 30 },
      (_, i) => `the unit number ${i} is configured to do a thing, and also to do another thing`).join('\n');
    const capped = splitClaimElements(many, { maxElements: 5 });
    assert.deepEqual(capped, splitClaimElements(many, { fine: false }),
      'overflow must not drop limitations');
  });

  it('leaves a short element alone rather than destroying it', () => {
    assert.deepEqual(subdivideElement('doing a thing'), ['doing a thing']);
    assert.deepEqual(subdivideElement(''), []);
  });
});

describe('--elements file', () => {
  it('takes lines verbatim and separates # comments', () => {
    const { elements, comments } = parseElementsFile(
      '# split by RMS 2026-08-11\n\nfirst limitation\nsecond limitation\n# trailing note\n');
    assert.deepEqual(elements, ['first limitation', 'second limitation']);
    assert.deepEqual(comments, ['split by RMS 2026-08-11', 'trailing note']);
  });

  it('returns nothing for a comments-only file, so the caller can refuse it', () => {
    assert.deepEqual(parseElementsFile('# only a comment\n').elements, []);
    assert.deepEqual(parseElementsFile('').elements, []);
  });
});

// PER-ELEMENT RETRIEVAL. The measured failure it answers (claim-selftest.mjs):
// a whole-claim search scores each function against the WHOLE claim's terms
// under a quorum, so 4 of 5 ground-truth anchors were never candidates. Here
// each element carries its own vocabulary and there is NO quorum.
describe('retrievePerElement', () => {
  const SYMS = [
    { name: 'BufferMgr::storeChunk', filepath: 'a!src/BufferMgr.java' },
    { name: 'RateChooser::chooseBitrate', filepath: 'a!src/RateChooser.java' },
    { name: 'Unrelated::paint', filepath: 'a!src/Ui.java' },
  ];

  it('searches each element with ITS OWN words, not the pooled claim', async () => {
    const draft = async () => '1: store, chunk\n2: bitrate';
    const { perElement, error } = await retrievePerElement({
      draft, elements: ['storing data', 'choosing a rate'], symbols: SYMS,
    });
    assert.equal(error, null);
    assert.equal(perElement.length, 2);
    assert.deepEqual(perElement[0].words, ['store', 'chunk']);
    assert.equal(perElement[0].hits[0].sym.name, 'BufferMgr::storeChunk');
    assert.equal(perElement[1].hits[0].sym.name, 'RateChooser::chooseBitrate');
  });

  // The property the whole design turns on: a symbol matching ONE element's
  // vocabulary is retrievable even though it holds almost none of the claim.
  it('retrieves on a single element word — there is no quorum to clear', async () => {
    const { perElement } = await retrievePerElement({
      draft: async () => '1: bitrate', elements: ['a rate'], symbols: SYMS,
    });
    assert.equal(perElement[0].hits.length, 1);
  });

  it('reports an element with no candidates instead of dropping it', async () => {
    const { perElement } = await retrievePerElement({
      draft: async () => '1: store\n2: nothingmatchesthisatall', elements: ['a', 'b'], symbols: SYMS,
    });
    assert.equal(perElement.length, 2);
    assert.equal(perElement[1].hits.length, 0, 'the empty element must survive');
  });

  it('returns an error rather than throwing when the model fails', async () => {
    const boom = await retrievePerElement({
      draft: async () => { throw new Error('no key'); }, elements: ['a'], symbols: SYMS,
    });
    assert.match(boom.error, /vocabulary step failed/);
    assert.deepEqual(boom.perElement, []);
  });

  it('keeps the raw reply for --verbose when nothing parses', async () => {
    const junk = await retrievePerElement({
      draft: async () => 'I cannot help with that', elements: ['a'], symbols: SYMS,
    });
    assert.match(junk.error, /no parseable code-word predictions/);
    assert.equal(junk.raw, 'I cannot help with that');
  });

  // Step 1 must stay blind: the air-gap argument rests on the model being
  // unable to answer from memory of a specific repository.
  it('shows the model the claim only — no paths, no codebase identity', async () => {
    let seen = null;
    await retrievePerElement({
      draft: async (sys, user) => { seen = `${sys}\n${user}`; return '1: store'; },
      elements: ['storing data'], symbols: SYMS,
    });
    assert.doesNotMatch(seen, /BufferMgr|RateChooser|src\//);
    assert.match(seen, /storing data/);
  });
});

// Preamble restoration, whereby, and the stray-comma repair.
describe('splitter: the preamble is a row (Part A)', () => {
  const ONE = (s) => s.replace(/\s*\n\s*/g, ' ');
  const P101 = fs.readFileSync(fixture('8752101_claim_1.txt'), 'utf-8');
  const TLS = fs.readFileSync(fixture('sample_patent_claim.txt'), 'utf-8');

  it('keeps the preamble on the SINGLE-LINE path — the 98.7% defect', () => {
    // The colon path did `t.slice(ci + 1)`, discarding everything before the
    // first colon. Measured over 5,382 real independent claims: the preamble was
    // dropped on 5,297 of 5,369 and retained in element 1 on ZERO. Invisible
    // because both test claims are hand-wrapped and take other paths; real
    // corpora deliver claims as one line and land here.
    const els = splitClaimElements(ONE(P101));
    assert.match(els[0], /^A distribution system/,
      'row 1 must be the preamble, not the first limitation');
  });

  it('a one-line claim with a colon yields the preamble first', () => {
    const one = 'A widget system, comprising: a first thing that does something useful; '
      + 'a second thing that does something else useful; and a third thing entirely.';
    const els = splitClaimElements(one);
    assert.match(els[0], /^A widget system, comprising:$/);
    assert.ok(els.length >= 3, 'and the body still splits on semicolons');
  });

  it('does not disturb the paths that already worked', () => {
    assert.equal(splitClaimElements(P101).length, 10);
    assert.match(splitClaimElements(P101)[0], /^A distribution system/);
    assert.equal(splitClaimElements(TLS).length, 11);
    assert.match(splitClaimElements(TLS)[0], /^A method of establishing/);
  });

  it('a claim with no colon is unchanged — nothing to recover', () => {
    const noColon = 'A method comprising doing one thing and then doing another thing entirely here';
    assert.ok(splitClaimElements(noColon).length >= 1);
  });
});

describe('splitter: whereby is not a boundary (Part D)', () => {
  // Andrew (#310): whereby is "generally treated as non-limiting", so splitting
  // on it manufactures a row that should not exist. Measured: 30 of 5,382 real
  // claims (0.56%), against wherein at 67.7% as a control.
  it('does not split on whereby', () => {
    const s = 'transmitting the data to the receiver whereby the receiver displays it to a user';
    assert.equal(subdivideElement(s).length, 1);
  });

  it('still splits on wherein — the control', () => {
    const s = 'transmitting the data to the receiver wherein the receiver displays it to a user';
    assert.ok(subdivideElement(s).length >= 2);
  });

  it('the whereby TEXT is not lost, only un-split', () => {
    const s = 'transmitting the data to the receiver whereby the receiver displays it to a user';
    assert.match(subdivideElement(s)[0], /whereby the receiver displays/);
  });
});

describe('splitter: stray-comma repair needs the PAIR (Part E)', () => {
  // The first version took only the element, on the theory that "subdivides on
  // `, and` alone" was narrow enough. Testing killed that immediately: a genuine
  // boundary is indistinguishable from a stray one BY TEXT ALONE, so repairing
  // unconditionally would merge limitations a claim deliberately separated.
  const GENUINE = 'initializing a first module configured to do one thing, and loading '
    + 'a second module configured to do another thing entirely here';
  const STRAY = '(a) Establishing an operational configuration for a secure domain, and '
    + 'incorporating thereto one or more validation data units originating from a credential authority';
  const SOURCE = '(a) initializing a cryptographic context by creating a security protocol '
    + 'object configured with a minimum protocol version and loading one or more certificate authority credentials';

  it('leaves a GENUINE boundary alone — the regression that matters', () => {
    assert.equal(repairStrayAndComma(GENUINE, GENUINE), GENUINE);
    assert.ok(subdivideElement(GENUINE).length >= 2, 'and it still splits there');
  });

  it('repairs a comma the rewrite introduced', () => {
    assert.equal(subdivideElement(SOURCE).length, 1, 'source does not split');
    assert.equal(subdivideElement(STRAY).length, 2, 'rewrite does');
    const fixed = repairStrayAndComma(STRAY, SOURCE);
    assert.notEqual(fixed, STRAY);
    assert.equal(subdivideElement(fixed).length, 1);
    assert.match(fixed, /domain and incorporating/, 'the WORD survives; only the comma goes');
  });

  it('is a no-op without an original — there is no signal', () => {
    assert.equal(repairStrayAndComma(STRAY, null), STRAY);
    assert.equal(repairStrayAndComma(STRAY, undefined), STRAY);
  });

  it('leaves an element that splits for OTHER reasons alone', () => {
    const multi = 'doing a thing, and doing another wherein the doing comprises something else here';
    assert.equal(repairStrayAndComma(multi, 'doing a thing and doing another'), multi,
      'the comma was not the sole cause, so the repair must not claim it was');
  });

  it('splitClaimElements does NOT apply it — it has no original', () => {
    const src = fs.readFileSync('src/commands/claim-locate.js', 'utf-8');
    // Scan splitClaimElements ONLY — the slice must stop before
    // repairStrayAndComma's own definition, or it matches its signature.
    const body = src.slice(src.indexOf('export function splitClaimElements'),
                           src.indexOf('export function isPreambleRow'));
    assert.ok(!/repairStrayAndComma\s*\(/.test(body),
      'applying it blind would merge limitations a claim deliberately separated');
  });
});

describe('splitter: preamble identification is POSITIONAL (Part B)', () => {
  const TLS = fs.readFileSync(fixture('sample_patent_claim.txt'), 'utf-8');
  const els = splitClaimElements(TLS);

  it('labels row 1', () => {
    assert.equal(isPreambleRow(els[0], 0), true);
  });

  it('never labels a later row, however preamble-shaped', () => {
    // The guard alone is NOT a discriminator: on '101 it also matches element 6,
    // "the distribution system, comprising a code rate determining unit", a
    // genuine limitation. Across the corpus it matches more than one element in
    // 15.5% of claims. Position is what does the work.
    for (let i = 1; i < els.length; i++) {
      assert.equal(isPreambleRow(els[i], i), false, `row ${i + 1} must not be labelled`);
    }
    assert.equal(isPreambleRow('the distribution system, comprising a code rate determining unit', 3), false);
  });

  it('fails safe when row 1 is not preamble-shaped', () => {
    assert.equal(isPreambleRow('initializing a cryptographic context by creating an object', 0), false);
    assert.equal(isPreambleRow('', 0), false);
  });
});
