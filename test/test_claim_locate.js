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
  classifyLimitation, limitationTag, directionOf, directionalMismatch,
  buildTargetsFileBody, attributeTargets, samplingLine, VOCAB_MAX_OUTPUT_TOKENS,
  LOCATE_DEFAULTS,
  repairStrayAndComma, isPreambleRow,
  SPLIT_DEFAULTS,
  buildProposePrompt, buildIndexProfile, formatLocateReport,
  doClaimLocate, buildDiscoverPrompt, parseElementWords, searchSymbolsByWords,
  contentCandidatesForWords,
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
// op-pseudo-source-kind-gate: a binstrings `.op` dump indexes as one
// `bin_<name>` pseudo-function holding every string in the binary, so the name
// arm matches it on almost any word list. Held back by default, counted,
// admitted by --include-op.
describe('pseudo-source (.op) symbols are held back from retrieval', () => {
  const syms = [
    { filepath: 'pkg/__pycache__/rate.cpython-310.pyc.op', name: 'bin_pycache_rate_cpython_310_pyc', bare: 'bin_pycache_rate_cpython_310_pyc', start: 1, end: 400, tokens: [], kind: 'pseudo-source' },
    { filepath: 'src/main/Rate.java', name: 'RateChooser::chooseBitrate', bare: 'chooseBitrate', start: 1, end: 20, tokens: [], kind: 'source' },
  ];
  const draft = async () => 'ELEMENT 1: rate; bitrate';
  it('excludes them by default and reports how many it held back', async () => {
    const r = await retrievePerElement({ draft, elements: ['choosing a bitrate'], symbols: syms });
    assert.deepEqual(r.perElement[0].hits.map((h) => h.sym.name), ['RateChooser::chooseBitrate']);
    assert.deepEqual(r.heldBack, { symbols: 1, content: 0, contentTests: 0 });
  });
  it('admits them under includeOp, with nothing held back', async () => {
    const r = await retrievePerElement({ draft, elements: ['choosing a bitrate'], symbols: syms, opts: { includeOp: true } });
    assert.ok(r.perElement[0].hits.some((h) => h.sym.name === 'bin_pycache_rate_cpython_310_pyc'));
    assert.deepEqual(r.heldBack, { symbols: 0, content: 0, contentTests: 0 });
  });
  it('the content arm applies the same gate and counts its own drops', () => {
    const index = { multisectSearch: () => ({ function_matches: [
      { function: 'bin_pycache_rate_cpython_310_pyc', filepath: 'pkg/__pycache__/rate.cpython-310.pyc.op', matched_indices: new Set([0, 1]) },
      { function: 'RateChooser::chooseBitrate', filepath: 'src/main/Rate.java', matched_indices: new Set([0]) },
    ] }) };
    let held = 0;
    const got = contentCandidatesForWords(index, ['rate', 'bitrate'], { onPseudoSource: (n) => { held += n; } });
    assert.deepEqual(got.map((c) => c.name), ['RateChooser::chooseBitrate']);
    assert.equal(held, 1);
    const all = contentCandidatesForWords(index, ['rate', 'bitrate'], { includeOp: true });
    assert.equal(all.length, 2);
  });

  // chart-retrieval-content-arm-and-budget: the content arm gets the SAME test
  // gate the name arm has always had. On the bridged '101, 36 of 60 content
  // candidates were tests and a unit test of the mechanism was promoted over
  // the mechanism itself.
  it('the content arm holds back test files by default, counts them, and admits them under includeTests', () => {
    const index = { multisectSearch: () => ({ function_matches: [
      { function: 'RateChooserTest::choosesBitrate', filepath: 'src/test/RateChooserTest.java' },
      { function: 'RateChooser::chooseBitrate', filepath: 'src/main/Rate.java' },
    ] }) };
    let tests = 0;
    const got = contentCandidatesForWords(index, ['rate', 'bitrate'], { onTestSymbol: (n) => { tests += n; } });
    assert.deepEqual(got.map((c) => c.name), ['RateChooser::chooseBitrate']);
    assert.equal(tests, 1);
    const all = contentCandidatesForWords(index, ['rate', 'bitrate'], { includeTests: true });
    assert.equal(all.length, 2);
  });
});

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
    // 10 -> 9 with claim-granularity-tiers: the retired `for <verb>ing` boundary had cut one
    // '101 element at a purpose phrase (a fragment, per the 380-claim calibration), not a limitation.
    assert.equal(splitClaimElements(P101).length, 9);
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

  // preamble-row-on-supplied-elements (2026-08-28): a SUPPLIED row keeps its
  // claim-number prefix ("1. A method ... comprising:"), which CE's own splitter
  // strips and --elements never does. 0 of 380 fixture sets had a preamble row
  // before the prefix was tolerated; 326 after. The text is never rewritten.
  it('sees through a leading claim-number prefix on a supplied row', () => {
    assert.equal(isPreambleRow('1. A method comprising:', 0), true);
    assert.equal(isPreambleRow('1) A method comprising:', 0), true);
    assert.equal(isPreambleRow('1. A method in a processor-based system configured for executing a plurality of management programs according to respective command formats, the method comprising:', 0), true);
    assert.equal(isPreambleRow('1. the method further comprising', 0), true, 'article + transition, as today');
    assert.equal(isPreambleRow('1. A method comprising:', 1), false, 'position still does the work');
    assert.equal(isPreambleRow('1. receiving a packet;', 0), false, 'no article, no transition');
    assert.equal(isPreambleRow('In a computer system having a processor, a method comprising:', 0), false,
      'Jepson-style openers are not covered here (54 of 380 fixture sets) — a separate rule');
  });
});

// WHAT A ROW MEANS ONCE IT IS CUT (#310, Andrew's Part III).
//
// The splitter's rules say where to cut. These say what the cut row MEANS, and
// that changes what a verdict is worth. Andrew's ruling, 2026-08-22: the verdict
// answers "is this limitation MET", never "does this feature appear". On a
// negative limitation those invert.
describe('limitation construction is detected, not inferred', () => {
  it('CHOICE: at least one of — met by ANY ONE alternative', () => {
    const c = classifyLimitation('at least one of a single-ended encoding circuit or a differential encoding circuit');
    assert.deepEqual(c.kinds, ['choice']);
    assert.match(limitationTag('at least one of A or B'), /ANY ONE alternative/);
  });

  it('CHOICE: "group consisting of" is a choice, NOT closed claiming', () => {
    // The two share the word `consisting` and mean opposite things. Closed
    // claiming means extra elements DEFEAT infringement; a Markush group means
    // any one member satisfies. Getting these backwards inverts the verdict.
    assert.deepEqual(
      classifyLimitation('a dopant selected from the group consisting of boron, phosphorus and arsenic').kinds,
      ['choice']);
  });

  it('NEGATIVE: the verdict-inverting construction', () => {
    for (const s of ['in the absence of information about any account',
      'without user intervention', 'substantially free of chlorine', 'devoid of a binder']) {
      assert.ok(classifyLimitation(s).kinds.includes('negative'), s);
    }
    assert.match(limitationTag('without user intervention'), /met when the recited feature is ABSENT/);
  });

  it('the CONTROLS must not trigger either annotation', () => {
    // comprising is in 94.3% of real claims and wherein in 68.7%. A detector
    // that fired on those would annotate almost every row and mean nothing.
    for (const s of ['A method comprising: receiving a signal; and decoding it',
      'wherein the controller is configured to select a mode',
      'whereby the signal is decoded']) {
      assert.deepEqual(classifyLimitation(s).kinds, [], s);
    }
  });

  it('an element can be BOTH, and says so', () => {
    const c = classifyLimitation('at least one of A or B, selected without user intervention');
    assert.deepEqual(c.kinds.sort(), ['choice', 'negative']);
    const tag = limitationTag('at least one of A or B, selected without user intervention');
    assert.match(tag, /CHOICE/); assert.match(tag, /NEGATIVE/);
  });

  it('carries the cue that fired, so a reader can check the call', () => {
    assert.equal(classifyLimitation('performed without a network').cues.negative, 'without');
    assert.match(classifyLimitation('at least one of X or Y').cues.choice, /at least one of/i);
  });
});

// A REACH NUMBER, not an impression. Re-measured here so a later tuning change
// shows up as a delta rather than as a vibe.
describe('detector reach over 5,397 real independent claims', () => {
  const CORPUS = 'randpat_2020_indep_claims.out.txt';
  const have = fs.existsSync(CORPUS);

  it('annotates the measured share, and leaves the controls alone', { skip: !have }, () => {
    const claims = fs.readFileSync(CORPUS, 'utf-8').split(/\r?\n/).filter((l) => l.trim());
    let choice = 0, negative = 0, comprising = 0;
    for (const c of claims) {
      const k = classifyLimitation(c).kinds;
      if (k.includes('choice')) choice++;
      if (k.includes('negative')) negative++;
      if (/\bcomprising\b/i.test(c)) comprising++;
    }
    assert.equal(claims.length, 5397, 'corpus size — a change here invalidates the rest');
    // MEASURED with this detector, not carried over from the proposal. The
    // draft claimed 725 CHOICE / 276 NEGATIVE over 5,382 claims; none of the
    // three reproduced. Controls did (comprising 94.3% exactly), so the corpus
    // is the same one — the proposal's target numbers were simply wrong, and
    // implementing to them would have meant fitting the detector to a figure
    // nobody could re-derive.
    assert.equal(choice, 799, 'CHOICE reach (14.8%)');
    assert.equal(negative, 236, 'NEGATIVE reach (4.4%)');
    // The control is the point: comprising appears in nearly every claim, so a
    // detector drifting toward it would be annotating everything.
    assert.equal(comprising, 5089, 'control: comprising, 94.3%');
    assert.ok(choice + negative < claims.length * 0.2,
      'annotations must stay a minority — a tag on every row carries no information');
  });
});

// B6 FROM THE RULES, NOW CHECKED. "Don't use a DoSend() function to meet a
// limitation which reads a message." Recorded as mechanically checkable and not
// yet checked; it fired 2026-08-16 on element 10 of a real run.
describe('directional mismatch is reported, never filtered', () => {
  const CONVEY = 'conveying application-layer information through a cryptographically protected communication path';

  it('the observed case warns, naming both sides', () => {
    const mm = directionalMismatch(CONVEY, 'NetworkManager::receiveSecureData');
    assert.deepEqual(mm, { limitation: 'outbound', symbol: 'inbound' });
  });

  it('the CORRECT candidate for the same element does not warn', () => {
    // The corpus held these and none was retrieved for element 10. If they
    // warned too, the signal would be worthless.
    for (const s of ['NetworkManager::sendSecureData', 'tls_send_encrypted', 'SecureChannel::sendMessage']) {
      assert.equal(directionalMismatch(CONVEY, s), null, s);
    }
  });

  it('silence means NO SIGNAL, not "checked and fine"', () => {
    // Both directions present -> no verdict. A duplex limitation is exactly the
    // case where a warning would be wrong.
    assert.equal(directionOf('receiving a request and transmitting a response'), null);
    assert.equal(directionalMismatch('receiving a request and transmitting a response', 'sendData'), null);
    // Neither direction present -> no verdict.
    assert.equal(directionOf('determining a code rate based on a remaining time'), null);
    assert.equal(directionalMismatch('determining a code rate', 'receiveData'), null);
  });

  it('an ambiguous SYMBOL is not convicted either', () => {
    // `sendOrReceive` reads both ways; a warning there would be noise.
    assert.equal(directionalMismatch(CONVEY, 'Channel::sendOrReceive'), null);
  });

  it('inbound limitations are checked in the same direction', () => {
    assert.deepEqual(directionalMismatch('receiving a certificate chain from the server', 'transmitChain'),
      { limitation: 'inbound', symbol: 'outbound' });
    assert.equal(directionalMismatch('receiving a certificate chain from the server', 'readChain'), null);
  });

  it('THE SET IS UNCHANGED — this warns and must never filter or re-rank', () => {
    // The property that makes it safe to ship before it is measured. n=1 on the
    // false-positive rate, so the change must not be able to alter a result.
    const syms = [
      { name: 'NetworkManager::receiveSecureData', filepath: 'a.java' },
      { name: 'NetworkManager::sendSecureData', filepath: 'a.java' },
    ];
    const before = searchSymbolsByWords(syms, ['secure', 'data'], { limit: 10 }).map((h) => h.sym.name);
    const after = searchSymbolsByWords(syms, ['secure', 'data'], { limit: 10 }).map((h) => h.sym.name);
    assert.deepEqual(after, before, 'retrieval is untouched by this item');
    assert.ok(before.includes('NetworkManager::receiveSecureData'),
      'the mismatched candidate is still RETURNED — warning only');
  });
});

// THE FIRING RATE AS A NUMBER, because "n=1 on the false-positive rate" is the
// draft's own caveat and an unmeasured warning becomes noise nobody reads.
describe('directional check stays a minority signal', () => {
  const IDX = '.demo_code_only';
  const have = fs.existsSync(IDX) && fs.existsSync('test/fixtures/sample_patent_claim.txt');

  it('gates on directional limitations only, and fires on ~2% of pairs', { skip: !have }, async () => {
    const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
    const { buildSymbolTable } = await import('../src/core/symbol-verify.js');
    const idx = new CodeSearchIndex({ indexPath: IDX });
    idx._ensureFunctionIndex();
    const syms = buildSymbolTable(idx);
    const els = splitClaimElements(fs.readFileSync('test/fixtures/sample_patent_claim.txt', 'utf-8'));

    const directional = els.filter((e) => directionOf(e)).length;
    assert.equal(directional, 2, 'only 2 of 11 limitations are unambiguously directional');

    let pairs = 0, warn = 0;
    for (const e of els) for (const s of syms) { pairs += 1; if (directionalMismatch(e, s.name)) warn += 1; }
    assert.equal(pairs, els.length * syms.length);
    assert.equal(warn, 38, 'firing rate over every element x symbol pair');
    assert.ok(warn / pairs < 0.05,
      `a warning on more than a few percent of pairs is noise, not signal (${warn}/${pairs})`);
  });
});

// ATTRIBUTION IS THE ONE THING PER-ELEMENT RETRIEVAL KNOWS AND THE FILE DROPPED.
// Stdout carried it during the run; --targets-out did not, so a chart fed a
// locate file could not render the table that distinguishes "examined and found
// nothing" from "had nothing to examine".
describe('--targets-out carries which limitation each target answers', () => {
  const mk = (n, f, el) => ({ match: { name: n, filepath: `idx!src/${f}` }, verified: true, element: el });
  const hit = (n, f) => ({ sym: { name: n, filepath: `idx!src/${f}` } });
  const FOUND = [mk('CipherNegotiator::selectCipherSuites', 'CipherNegotiator.java'),
    mk('ConnectionConfig::getMinKeyBits', 'ConnectionConfig.java'),
    mk('tls_send_encrypted', 'tls.c')];
  const DISC = [
    { element: 4, text: 'selecting a cipher suite from a set of supported cipher suites',
      words: ['select', 'suite', 'supported'],
      hits: [hit('CipherNegotiator::selectCipherSuites', 'CipherNegotiator.java'),
        hit('ConnectionConfig::getMinKeyBits', 'ConnectionConfig.java')] },
    { element: 10, text: 'transmitting application data over an encrypted channel',
      words: ['transmit', 'send', 'encrypt'], hits: [hit('tls_send_encrypted', 'tls.c')] },
  ];

  it('groups targets under their element, with words and candidate count', () => {
    const body = buildTargetsFileBody({ provenance: ['Produced by CodeExam'], found: FOUND, discovery: DISC });
    assert.match(body, /# Element 4: selecting a cipher suite/);
    assert.match(body, /# Element-words: select, suite, supported/);
    assert.match(body, /# Element-candidates: 2/);
    // The targets under a block are that element's, not a flat dump.
    const block = body.slice(body.indexOf('# Element 4:'), body.indexOf('# Element 10:'));
    assert.ok(block.includes('CipherNegotiator.java@CipherNegotiator::selectCipherSuites'));
    assert.ok(!block.includes('tls.c@tls_send_encrypted'), 'element 10 target must not sit under element 4');
  });

  it('every target appears EXACTLY ONCE — the checksum is over targets', () => {
    const body = buildTargetsFileBody({ provenance: [], found: FOUND, discovery: DISC });
    const lines = body.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    assert.equal(lines.length, 3);
    assert.equal(new Set(lines).size, 3, 'a target duplicated across blocks would change the list');
  });

  it('attribution survives POOLED selection, because RETRIEVAL is per-element', () => {
    // The distinction the item turns on: rows carry no element when selection
    // was pooled, so attribution has to come from which element's retrieval
    // surfaced the symbol.
    const pooled = FOUND.map((r) => ({ ...r, element: undefined }));
    const { groups } = attributeTargets(pooled, DISC);
    assert.deepEqual(groups.map((g) => g.targets.length), [2, 1]);
  });

  it('a target NO element claims still ships, and says so', () => {
    // Silently dropping one would make the file disagree with the run.
    const extra = [...FOUND, mk('Orphan::method', 'Orphan.java')];
    const body = buildTargetsFileBody({ provenance: [], found: extra, discovery: DISC });
    assert.match(body, /# Element: unattributed — 1 target\(s\)/);
    assert.ok(body.includes('Orphan.java@Orphan::method'));
    assert.equal(body.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length, 4);
  });

  it('HUNT mode keeps today format — no empty markers', () => {
    // Empty element markers would read as "examined, nothing found", which is
    // the exact distinction this item exists to preserve.
    const body = buildTargetsFileBody({ provenance: ['p'], found: FOUND, discovery: DISC, mode: 'hunt' });
    assert.ok(!body.includes('# Element '));
    assert.match(body, /# Attribution: none — produced by hunt mode/);
    assert.equal(body.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length, 3);
  });
});

// A LIST THAT CANNOT SAY WHETHER IT REPEATS. Measured 2026-08-12, .demo x
// sample_patent_claim: identical --per-element-select invocations lost element
// group (e) in 3 of 7 runs. A chart built from a losing run reports (e) ABSENT;
// from a winning run, PRESENT. Both runs emit a clean header and a valid
// Targets-checksum — which guards against the list being EDITED, not against
// its GENERATION being unstable.
describe('the targets file says what kind of sample it is', () => {
  it('a cloud list says it is ONE SAMPLE', () => {
    const s = samplingLine({ kind: 'cloud', provider: { label: 'Anthropic' } });
    assert.match(s, /cloud engine, no seed control/);
    assert.match(s, /ONE SAMPLE/);
    assert.match(s, /Runs: 1\./);
  });

  it('a local list states the DECODE MODE, and SCOPES any repeatability claim', () => {
    // The original form of this test banned the words outright, because
    // repeatability was UNMEASURED: greedy decoding uses no RNG, but GPU-kernel
    // float non-associativity is not something a flag fixes.
    //
    // asus-CC measured it on 2026-08-25 (#315) — 3 separate processes, identical
    // target lists — so silence is no longer the honest answer. The PRINCIPLE the
    // ban protected is unchanged and is what is asserted now: **the claim made
    // must be exactly the claim measured.** A repeatability claim is allowed only
    // if it carries its corpus, its count, and the limit of what was measured.
    const s = samplingLine({ kind: 'gguf', modelPath: '/m/gemma.gguf' });
    assert.match(s, /temperature 0 \(greedy decoding, no RNG\)/);
    if (/identical|reproducib|deterministic/i.test(s)) {
      assert.match(s, /3 separate processes/, 'names how many observations');
      assert.match(s, /\.demo_code_only/, 'names the corpus it was measured on');
      assert.match(s, /not a guarantee/i, 'says plainly that it is not a general property');
      assert.match(s, /unmeasured/i, 'names what remains unmeasured');
    }
  });

  it('never names a seed — --reproducible reaches no CLI command', () => {
    // An earlier draft of this proposed a `seed 42 (--reproducible)` line.
    // `grep -rn "args.reproducible" src/commands/` returns nothing: the flag is
    // parsed by the GUI server and forwarded to it, and ggufDescriptor takes no
    // seed. The line would have vouched for a pin that never happened.
    for (const m of [{ kind: 'gguf' }, { kind: 'cloud', provider: {} }, null]) {
      const s = samplingLine(m);
      // Saying "no seed control" is the honest cloud disclosure; what must
      // never appear is a line asserting a seed WAS pinned.
      assert.ok(!/seed\s+\d|seed[:=]|--reproducible/i.test(s),
        `must not vouch for a seed that was never set: ${s}`);
    }
    assert.match(samplingLine({ kind: 'cloud', provider: {} }), /no seed control/,
      'the cloud line still says the absence out loud');
  });

  it('reaches the provenance block a targets file carries', () => {
    const lines = buildTargetsProvenance({
      ceVersion: '0.5.0', engine: 'Anthropic — claude (cloud LLM)', mode: 'symbol-table discovery',
      targets: ['a@b'], generatedAt: 'now', sampling: samplingLine({ kind: 'cloud', provider: {} }),
    });
    assert.ok(lines.some((l) => /^Sampling: cloud engine/.test(l)));
    // And it is absent when nothing was passed, rather than rendering blank.
    const none = buildTargetsProvenance({ mode: 'm', targets: ['a@b'], generatedAt: 'now' });
    assert.ok(!none.some((l) => /^Sampling:/.test(l)));
  });
});

describe('the discover prompt no longer asserts a falsehood', () => {
  const P = buildDiscoverPrompt();

  it('drops "never share vocabulary"', () => {
    // False on the '101 claim, and it forbade the one strategy that works:
    // the claim says "code rate DETERMINING unit", the code says
    // determineIdealSelectedIndex, and `determine` ranks it #1 of 65,370.
    assert.ok(!/never share/i.test(P));
    assert.match(P, /USUALLY differ/);
  });

  it('resolves the contradiction with its own example', () => {
    // The example always kept `persist` and `transaction` from the claim while
    // the prose forbade claim words. A model obeying the prose was correct.
    assert.match(P, /come straight from the claim and are kept/);
  });

  it('states the base-form rule, since it is measured', () => {
    assert.match(P, /BASE FORMS, not -ing forms/);
  });

  it('KEEPS the developer-vocabulary pressure', () => {
    // The translation instinct is right on most claims; only "never" was wrong.
    assert.match(P, /what programmers call/);
    assert.match(P, /NO patent boilerplate/);
  });
});

// 3580dc5 corrected the DISCOVER prompt and left this one carrying the same
// falsehood in a stronger form: it did not merely assert that patent and code
// do not share vocabulary, it INSTRUCTED the model to avoid "words taken from
// the claim" — a direct prohibition on the move that produced RUN 3, since
// `determine` is a word taken from the claim.
describe('the hunt prompt no longer asserts a falsehood either', () => {
  const P = buildHuntPrompt();

  it('drops the "do not share vocabulary" assertion', () => {
    assert.ok(!/do not share vocabulary/i.test(P));
    assert.ok(!/never share/i.test(P));
    assert.match(P, /USUALLY differ/);
  });

  it('drops the PROHIBITION on claim words, which discover never had', () => {
    // The worse half: an assertion a model can weigh, versus an instruction it
    // is obliged to obey. Gemma obeyed the discover version and produced
    // selector/estimator/scheduler/policy.
    assert.ok(!/not words taken from the claim/i.test(P));
    assert.match(P, /do NOT discard a claim word/);
  });

  it('carries a concrete worked example, from an INVENTED domain', () => {
    // The example IS the evidence -- 3580dc5's measured gain came from showing
    // the move rather than stating it -- so an example must stay present.
    //
    // But this assertion used to name `determineIdealSelectedIndex` directly,
    // which made a real symbol from the corpus CE is benchmarked on
    // LOAD-BEARING ON A TEST: the leak could not be removed without a red
    // suite, and #317 found it shipped in two prompts to every user. Assert the
    // PROPERTY instead, and let test_prompt_purity.js police which symbols may
    // appear at all.
    assert.match(P, /is implemented by a function called/,
      'a concrete symbol still demonstrates the rule');
    assert.match(P, /do NOT discard a claim word/);
    assert.ok(!/determineIdealSelectedIndex/.test(P),
      'and it is not a real symbol from the corpus CE is measured against (#317)');
  });

  it('KEEPS the developer-vocabulary pressure', () => {
    // Same as discover: the translation instinct is right, the absolute was not.
    assert.match(P, /words a programmer would put in an identifier/);
  });
});

// THE VOCABULARY STEP IS THE NARROWEST POINT IN THE PIPELINE.
//
// It fails CLOSED: everything downstream then reports "no candidates" for a
// reason that has nothing to do with the codebase. MEASURED (asus-CC, #306
// "Edit 7"): Qwen produced 0 bytes at 600, twice, byte-identical, and a
// complete 11-element chart at 3000.
describe('the vocabulary budget, and a step that was cut off says so', () => {
  const ELS = ['transmitting content data', 'reproducing the content', 'determining the code rate'];
  const SYMS = [{ name: 'Tx::sendData', filepath: 'a.java' }, { name: 'Player::reproduce', filepath: 'b.java' }];

  it('the budget is a named constant, not a bare number at a call site', () => {
    // It sat as `600` beside an `800` and an `1100` with no stated relationship
    // between them, and was never measured against a real response.
    assert.equal(VOCAB_MAX_OUTPUT_TOKENS, 3000);
  });

  it('passes the budget to the drafter', async () => {
    let sawMax = null;
    await retrievePerElement({
      draft: async (_s, _u, maxTokens) => { sawMax = maxTokens; return 'ELEMENT 1: send; data'; },
      elements: ELS, symbols: SYMS,
    });
    assert.equal(sawMax, VOCAB_MAX_OUTPUT_TOKENS, 'the constant must actually reach the call');
  });

  it('a CUT OFF response is reported as such, not as "produced nothing useful"', async () => {
    // The detector has existed since 58a596d and this path never consulted it,
    // which is exactly why the failure presented as a model quality problem.
    const { draftCloud, wasLastDraftTruncated } = await import('../src/core/llm-runner.js');
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({
      // stop_reason max_tokens is what the detector keys on.
      stop_reason: 'max_tokens', content: [{ text: '' }], usage: {},
    }), text: async () => '' });
    try {
      await draftCloud({ wire: 'anthropic', apiUrl: 'x', key: 'k', model: 'm', label: 'L' }, 's', 'u', 10, 0);
      assert.equal(wasLastDraftTruncated(), true, 'precondition: the detector fired');
      const r = await retrievePerElement({
        draft: async () => '', elements: ELS, symbols: SYMS,
      });
      assert.equal(r.truncated, true, 'the result carries the fact');
      assert.match(r.error, /cut off at the 3000-token output budget/,
        'and the error names the ceiling rather than blaming the model');
    } finally { globalThis.fetch = real; }
  });

  it('a normal response reports nothing extra', async () => {
    const r = await retrievePerElement({
      draft: async () => 'ELEMENT 1: send; data\nELEMENT 2: reproduce; play',
      elements: ELS, symbols: SYMS,
    });
    assert.equal(r.error, null);
    assert.ok(!r.truncated, 'no truncation claim on a clean run');
    assert.equal(r.perElement.length, 2);
  });
});

// NAME SEARCH MATCHES SYMBOL NAMES; CONTENT SEARCH MATCHES THE CODE.
//
// MEASURED (asus-CC, #315 lever 2): Gemma's own already-predicted `estimator`
// reaches AdaptiveTrackSelection@330 at rank 1 of 104 through content search
// and NOWHERE through name search. The model had produced a word that finds the
// right file and CE looked in the one place it does not appear.
describe('the content arm is an ARM, never a blend', () => {
  const SYMS = [{ name: 'Tx::sendData', filepath: 'a.java' }];
  // The stub ENFORCES the contract it stands in for. The previous version was
  // `multisectSearch: () => ({ function_matches: fns })` — it ignored its
  // arguments entirely, so every merge property below was tested while the one
  // thing that mattered, the SHAPE of the argument, was the only thing the mock
  // could not check. The arm shipped with `{ term, negated, hard }`, threw on
  // `regex.test(line)`, and returned [] on every call for two days.
  const fakeIndex = (fns) => ({
    multisectSearch: (terms) => {
      if (!Array.isArray(terms) || !terms.length) throw new Error('no terms supplied');
      for (const t of terms) {
        if (!t || !(t.regex instanceof RegExp)) {
          throw new TypeError('multisect term is missing `regex` — see multisect.js:44');
        }
      }
      return { function_matches: fns };
    },
  });

  it('is OFF without an index — the compatibility contract', async () => {
    // Omitting the index must leave this path byte-identical. A regression here
    // is invisible until a chart is wrong.
    const r = await retrievePerElement({
      draft: async () => 'ELEMENT 1: send; data', elements: ['transmitting'], symbols: SYMS,
    });
    assert.ok(!r.perElement[0].contentAdded, 'nothing was added');
    assert.equal(r.perElement[0].hits.length, 1, 'the candidate set is what it always was');
    assert.equal(r.perElement[0].hits[0].sym.name, 'Tx::sendData');
    assert.ok(!r.perElement[0].hits[0].arm, 'no arm labelling when the arm is off');
  });

  it('adds a symbol the NAME arm cannot reach at any depth', async () => {
    // The whole point: a name that says nothing about the limitation.
    const r = await retrievePerElement({
      draft: async () => 'ELEMENT 1: send; data', elements: ['transmitting'], symbols: SYMS,
      opts: { index: fakeIndex([{ name: 'AdaptiveTrackSelection::updateSelectedTrack', filepath: 'x!b.java' }]) },
    });
    const names = r.perElement[0].hits.map((h) => h.sym.name);
    assert.ok(names.includes('AdaptiveTrackSelection::updateSelectedTrack'));
    assert.equal(r.perElement[0].contentAdded, 1);
  });

  it('labels which arm found each candidate', async () => {
    const r = await retrievePerElement({
      draft: async () => 'ELEMENT 1: send; data', elements: ['transmitting'], symbols: SYMS,
      opts: { index: fakeIndex([{ name: 'Other::fn', filepath: 'x!b.java' }]) },
    });
    const byName = Object.fromEntries(r.perElement[0].hits.map((h) => [h.sym.name, h.arm]));
    assert.equal(byName['Tx::sendData'], 'name');
    assert.equal(byName['Other::fn'], 'content');
  });

  it('a symbol found by BOTH appears ONCE, and records the corroboration', async () => {
    // Two searches agreeing is stronger evidence than either alone, and a
    // duplicate row would waste a candidate slot the model needs.
    const r = await retrievePerElement({
      draft: async () => 'ELEMENT 1: send; data', elements: ['transmitting'], symbols: SYMS,
      opts: { index: fakeIndex([{ name: 'Tx::sendData', filepath: 'x!a.java' }]) },
    });
    assert.equal(r.perElement[0].hits.length, 1, 'de-duplicated by symbol');
    assert.equal(r.perElement[0].hits[0].arm, 'both');
    assert.equal(r.perElement[0].contentAdded, 0);
  });

  it('the NAME arm keeps precedence — content is appended, never interleaved', async () => {
    // Same rule as TIGHT over BROAD in analyze.js: the narrower search is the
    // higher-confidence read, so it is not displaced by the wider one.
    const many = [{ name: 'Z::one', filepath: 'x!z.java' }, { name: 'Z::two', filepath: 'x!z.java' }];
    const r = await retrievePerElement({
      draft: async () => 'ELEMENT 1: send; data', elements: ['transmitting'], symbols: SYMS,
      opts: { index: fakeIndex(many) },
    });
    assert.equal(r.perElement[0].hits[0].sym.name, 'Tx::sendData', 'name-arm hit stays first');
  });

  it('is BOUNDED, and the bound is a minority of the candidate list', async () => {
    const flood = Array.from({ length: 40 }, (_, i) => ({ name: `F::f${i}`, filepath: 'x!f.java' }));
    const r = await retrievePerElement({
      draft: async () => 'ELEMENT 1: send; data', elements: ['transmitting'], symbols: SYMS,
      opts: { index: fakeIndex(flood) },
    });
    assert.equal(r.perElement[0].contentAdded, LOCATE_DEFAULTS.contentPerElement);
    assert.ok(LOCATE_DEFAULTS.contentPerElement < LOCATE_DEFAULTS.candidatesPerElement,
      'the arm must not be able to dominate the name arm');
  });

  it('a failing content search cannot take the run down', async () => {
    const r = await retrievePerElement({
      draft: async () => 'ELEMENT 1: send; data', elements: ['transmitting'], symbols: SYMS,
      opts: { index: { multisectSearch: () => { throw new Error('boom'); } } },
    });
    assert.equal(r.error, null);
    assert.equal(r.perElement[0].hits.length, 1, 'the name arm survives');
  });
});

// ===========================================================================
// --runs N: UNION ACROSS RUNS
//
// Identical --per-element-select invocations lost one element group in 3 of 7
// runs (scripts/claim-locate-stability.mjs), and the Targets-checksum cannot
// catch it: it guards against the list being EDITED, not against its
// GENERATION being unstable, so both runs pass their own integrity check while
// disagreeing with each other. Union, never intersection -- an intersection
// discards exactly the unstable targets that carry the marginal coverage.
// ===========================================================================
describe('--runs N unions the discovery cycle instead of sampling it once', () => {
  const RUNS_INDEX = () => ({
    functionIndex: {
      'src/main/Rate.java': { 'RateChooser::chooseBitrate': { start: 10, end: 40 } },
      'src/main/Send.java': { 'Sender::sendBitrate': { start: 10, end: 40 } },
    },
    _ensureFunctionIndex() {},
    findCallers: () => [],
    findCallees: () => [],
  });
  const CLAIM = 'A system, comprising: choosing a rate.';

  // chooseBitrate is proposed by every run; sendBitrate by run 2 alone. That
  // asymmetry is the whole point: run 1 alone would never cite it.
  const unstableDrafter = () => {
    let vocab = 0;
    return async (sys) => {
      if (/WORDS that would appear/.test(sys)) { vocab++; return 'ELEMENT 1: bitrate'; }
      return vocab === 2
        ? 'ELEMENT 1: RateChooser::chooseBitrate; Sender::sendBitrate'
        : 'ELEMENT 1: RateChooser::chooseBitrate';
    };
  };

  const quiet = async (fn) => {
    const log = console.log; console.log = () => {};
    try { return await fn(); } finally { console.log = log; }
  };

  it('runs the cycle N times and keeps a target only ONE run proposed', async () => {
    const res = await quiet(() => doClaimLocate(RUNS_INDEX(),
      { claim_locate: CLAIM, model: 'f.gguf', no_refine: true, runs: 3 },
      { draft: unstableDrafter() }));
    const byName = Object.fromEntries(
      res.rows.filter((r) => r.verified).map((r) => [r.match.name, r.runsFound]));
    assert.equal(byName['RateChooser::chooseBitrate'], 3, 'found by every run');
    assert.equal(byName['Sender::sendBitrate'], 1,
      'found by ONE run and KEPT -- an intersection would have dropped it');
  });

  it('--runs 1 changes nothing: no frequency lines, no union suffix', async () => {
    const fs = (await import('node:fs')).default;
    const p = `${process.env.TEMP || '/tmp'}/ce_runs_one.txt`;
    try { fs.unlinkSync(p); } catch { /* fresh */ }
    await quiet(() => doClaimLocate(RUNS_INDEX(),
      { claim_locate: CLAIM, model: 'f.gguf', no_refine: true, runs: 1, targets_out: p },
      { draft: unstableDrafter() }));
    const body = fs.readFileSync(p, 'utf8');
    assert.ok(!/# Runs-found:/.test(body), 'no per-target frequency at runs=1');
    assert.match(body, /Runs: 1\./);
    assert.ok(!/each run votes|WITHIN-PROCESS/.test(body), 'no runs suffix at all at runs=1');
    assert.match(body, /^Rate\.java@RateChooser::chooseBitrate$/m, 'spec line unchanged');
  });

  it('writes the frequency ABOVE the target, and the chart still parses clean specs', async () => {
    // The trailing-comment form (`spec  # 3/3`) would be read as part of the
    // symbol name: parseTargets treats only lines STARTING with # as
    // provenance. That would corrupt every spec AND change the checksum.
    const fs = (await import('node:fs')).default;
    const { parseTargets } = await import('../src/commands/claim-chart.js');
    const p = `${process.env.TEMP || '/tmp'}/ce_runs_three.txt`;
    try { fs.unlinkSync(p); } catch { /* fresh */ }
    await quiet(() => doClaimLocate(RUNS_INDEX(),
      { claim_locate: CLAIM, model: 'f.gguf', no_refine: true, runs: 3, targets_out: p },
      { draft: unstableDrafter() }));
    const body = fs.readFileSync(p, 'utf8');
    assert.match(body, /^# Runs-found: 3\/3$/m);
    assert.match(body, /^# Runs-found: 1\/3$/m);
    // The gguf path no longer says "each run votes" -- on a local engine the
    // count measures within-process warmup, not sampling (#315).
    assert.match(body, /WITHIN-PROCESS stability/,
      'a local sampling line says what the count actually measured');
    assert.ok(!/each run votes/.test(body),
      'and does NOT use the cloud meaning, which would invert the reading');

    const parsed = parseTargets(`@${p}`);
    assert.ok(parsed.targets.includes('Rate.java@RateChooser::chooseBitrate'),
      'spec survives the frequency line above it');
    assert.ok(parsed.targets.includes('Send.java@Sender::sendBitrate'));
    for (const t of parsed.targets) {
      assert.ok(!/#/.test(t), `frequency leaked into the target spec: ${t}`);
    }
  });

  it('REFUSES --runs > 1 on the paths that cannot honour it', async () => {
    // An accepted-but-inert flag is the defect the parent item found in
    // --reproducible, which the GUI server parses and no CLI command reads.
    const err = console.error; const seen = [];
    console.error = (m) => seen.push(String(m));
    const prevExit = process.exitCode;
    try {
      await quiet(() => doClaimLocate(RUNS_INDEX(),
        { claim_locate: CLAIM, model: 'f.gguf', propose_from_priors: true, runs: 2 },
        { draft: async () => 'ELEMENT 1: RateChooser::chooseBitrate' }));
      assert.ok(seen.some((m) => /--runs 2 applies to the discovery path only/.test(m)),
        'propose-from-priors refuses rather than ignoring');
      seen.length = 0;
      await quiet(() => doClaimLocate(RUNS_INDEX(),
        { claim_locate: CLAIM, model: 'f.gguf', hunt: true, runs: 2 },
        { draft: async () => 'DONE\nELEMENT 1: NONE' }));
      assert.ok(seen.some((m) => /--runs 2 applies to the discovery path only/.test(m)),
        'hunt refuses rather than ignoring');
    } finally { console.error = err; process.exitCode = prevExit; }
  });

  it('rejects a nonsense --runs rather than silently treating it as 1', async () => {
    const err = console.error; const seen = [];
    console.error = (m) => seen.push(String(m));
    const prevExit = process.exitCode;
    try {
      await quiet(() => doClaimLocate(RUNS_INDEX(),
        { claim_locate: CLAIM, model: 'f.gguf', runs: 0 },
        { draft: unstableDrafter() }));
      assert.ok(seen.some((m) => /--runs takes a whole number/.test(m)));
    } finally { console.error = err; process.exitCode = prevExit; }
  });

  it('a LATER run failing shrinks the denominator instead of faking it', async () => {
    // Silence must not mean "3 runs agreed" when only 2 ran.
    let vocab = 0;
    const draft = async (sys) => {
      if (/WORDS that would appear/.test(sys)) {
        vocab++;
        if (vocab === 3) throw new Error('engine died');
        return 'ELEMENT 1: bitrate';
      }
      return 'ELEMENT 1: RateChooser::chooseBitrate';
    };
    const res = await quiet(() => doClaimLocate(RUNS_INDEX(),
      { claim_locate: CLAIM, model: 'f.gguf', no_refine: true, runs: 3 }, { draft }));
    const row = res.rows.find((r) => r.verified && r.match.name === 'RateChooser::chooseBitrate');
    assert.equal(row.runsFound, 2, 'counted against the runs that actually completed');
  });
});

// ===========================================================================
// THE PROPOSAL CAP UNDER VOTING
//
// maxProposals is 24 and a single pooled run already yields ~22.6 targets on
// the '101 claim, so with more than one run the cap BINDS -- it is the
// expected case, not an overflow. Two things follow: the cut must fall on the
// least-corroborated targets rather than on whatever arrived last, and it must
// SAY SO. A bare "24 proposals" cannot be told apart from "41 proposed, 17
// discarded".
// ===========================================================================
describe('the proposal cap cuts by fewest votes, and says what it cut', () => {
  const CLAIM = 'A system, comprising: choosing a rate.';
  // 30 symbols, all matching the same predicted word, so the union overflows
  // the 24-target cap and the cut is forced.
  const MANY = () => {
    const fnIndex = { 'src/main/Rate.java': {} };
    for (let i = 0; i < 30; i++) {
      fnIndex['src/main/Rate.java'][`Rate::bitrateFn${String(i).padStart(2, '0')}`] = { start: i * 10, end: i * 10 + 5 };
    }
    return { functionIndex: fnIndex, _ensureFunctionIndex() {}, findCallers: () => [], findCallees: () => [] };
  };
  const names = (n, from = 0) => Array.from({ length: n },
    (_, i) => `Rate::bitrateFn${String(i + from).padStart(2, '0')}`).join('; ');

  const quiet = async (fn) => {
    const log = console.log; console.log = () => {};
    try { return await fn(); } finally { console.log = log; }
  };

  // Run 1 proposes 00-19. Runs 2 and 3 propose 00-09 again plus 20-29.
  // So 00-09 have 3 votes, 10-19 have 1, 20-29 have 2. Thirty candidates, cap
  // 24, so six must go -- and the six that go must be one-vote ones.
  const votingDrafter = () => {
    let vocab = 0;
    return async (sys) => {
      if (/WORDS that would appear/.test(sys)) { vocab++; return 'ELEMENT 1: bitrate'; }
      return vocab === 1 ? `ELEMENT 1: ${names(20, 0)}` : `ELEMENT 1: ${names(10, 0)}; ${names(10, 20)}`;
    };
  };

  it('keeps the most-voted targets and drops the least-voted', async () => {
    const res = await quiet(() => doClaimLocate(MANY(),
      { claim_locate: CLAIM, model: 'f.gguf', no_refine: true, no_navigate: true, runs: 3 },
      { draft: votingDrafter() }));
    const kept = new Map(res.rows.filter((r) => r.verified).map((r) => [r.match.name, r.runsFound]));
    // Every 3-vote and 2-vote target survives; the cut lands entirely on 1-vote.
    for (let i = 0; i < 10; i++) {
      assert.equal(kept.get(`Rate::bitrateFn${String(i).padStart(2, '0')}`), 3,
        'a target every run proposed must never be cut');
    }
    for (let i = 20; i < 30; i++) {
      assert.equal(kept.get(`Rate::bitrateFn${String(i).padStart(2, '0')}`), 2,
        'a 2-vote target outranks a 1-vote one');
    }
    const oneVote = [...kept.values()].filter((v) => v === 1).length;
    assert.equal(oneVote, 4, '24 kept = 10 unanimous + 10 two-vote + 4 of the ten one-vote');
  });

  it('REPORTS the cut rather than presenting the ceiling as a finding', async () => {
    const lines = [];
    const log = console.log; console.log = (m) => lines.push(String(m ?? ''));
    const err = process.stderr.write.bind(process.stderr);
    const errs = [];
    process.stderr.write = (m) => { errs.push(String(m)); return true; };
    try {
      await doClaimLocate(MANY(),
        { claim_locate: CLAIM, model: 'f.gguf', no_refine: true, no_navigate: true, runs: 3 },
        { draft: votingDrafter() });
    } finally { console.log = log; process.stderr.write = err; }
    const summary = lines.find((l) => /target\(s\) proposed/.test(l));
    assert.ok(summary, 'a summary line is printed');
    assert.match(summary, /30 target\(s\) proposed/, 'says how many were proposed, not just how many survived');
    assert.match(summary, /24 kept/);
    assert.match(summary, /6 CUT by the 24-target cap/, 'names the cap as the cause');
    assert.match(summary, /10 proposed by every run/);
    assert.ok(errs.some((m) => /FEWEST votes first/.test(m)),
      'says WHICH targets the cut fell on, not merely that there was one');
  });

  it('says nothing about a cap that did not bind', async () => {
    // Silence must mean "nothing was dropped", never "something was dropped
    // quietly" -- otherwise the disclosure trains the reader to ignore it.
    const lines = [];
    const log = console.log; console.log = (m) => lines.push(String(m ?? ''));
    try {
      await doClaimLocate(MANY(),
        { claim_locate: CLAIM, model: 'f.gguf', no_refine: true, no_navigate: true, runs: 2 },
        { draft: async (sys) => (/WORDS that would appear/.test(sys)
          ? 'ELEMENT 1: bitrate' : `ELEMENT 1: ${names(5, 0)}`) });
    } finally { console.log = log; }
    const summary = lines.find((l) => /target\(s\) proposed/.test(l));
    assert.match(summary, /5 target\(s\) proposed, 5 kept,/);
    assert.ok(!/CUT/.test(summary), 'no cut language when nothing was cut');
  });

  it('--runs 1 is byte-identical: equal votes keep their order, no new output', async () => {
    // The compatibility contract. Sorting by votes must be a NO-OP when every
    // target has exactly one vote, or the single-run path silently reorders.
    const lines = [];
    const log = console.log; console.log = (m) => lines.push(String(m ?? ''));
    let res;
    try {
      res = await doClaimLocate(MANY(),
        { claim_locate: CLAIM, model: 'f.gguf', no_refine: true, no_navigate: true, runs: 1 },
        { draft: async (sys) => (/WORDS that would appear/.test(sys)
          ? 'ELEMENT 1: bitrate' : `ELEMENT 1: ${names(6, 0)}`) });
    } finally { console.log = log; }
    assert.ok(!lines.some((l) => /target\(s\) proposed/.test(l)), 'no summary line at runs=1');
    assert.deepEqual(
      res.rows.filter((r) => r.verified).map((r) => r.match.name),
      Array.from({ length: 6 }, (_, i) => `Rate::bitrateFn${String(i).padStart(2, '0')}`),
      'proposal order preserved exactly');
  });
});

// ===========================================================================
// THE CONTENT ARM ACTUALLY RUNS
//
// It did not, from 2e867ec until asus-CC found it (#315). Three things each
// independently guaranteed the silence: the term shape was hand-rolled and
// wrong, a bare `catch { return []; }` swallowed the resulting TypeError, and
// the stub above ignored its arguments so the suite could not see the shape.
// The reporting made it worse -- contentAdded was emitted only when non-zero,
// so total failure and "found nothing new" rendered identically.
// ===========================================================================
describe('the content arm runs, and says so when it cannot', () => {
  const INDEX = '.demo_code_only';
  const have = fs.existsSync(INDEX);

  it('returns real candidates against a REAL index', { skip: !have }, async () => {
    // The assertion that could not be made against the old stub, and the one
    // that would have caught this on day one.
    const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
    const idx = new CodeSearchIndex({ indexPath: INDEX });
    idx._ensureFunctionIndex();
    let err = null;
    const out = contentCandidatesForWords(idx, ['cipher', 'handshake', 'certificate'],
      { limit: 8, onError: (e) => { err = e; } });
    assert.equal(err, null, 'the arm must not error against a real index');
    assert.ok(out.length > 0, 'the arm returns candidates -- it returned 0 for two days');
    for (const c of out) assert.ok(c.name, 'every candidate carries a name');
  });

  it('a THROW is reported, not swallowed', () => {
    // The policy stays: retrieval must not take the run down. The silence does
    // not. Before this, a hard TypeError and an empty result were the same event.
    let err = null;
    const out = contentCandidatesForWords(
      { multisectSearch: () => { throw new Error('boom'); } },
      ['alpha'], { onError: (e) => { err = e; } });
    assert.deepEqual(out, [], 'the run still survives');
    assert.ok(err && /boom/.test(err.message), 'and the failure is REPORTED');
  });

  it('file-scope matches are dropped AND counted', () => {
    // multisect reports matter outside any function as `(global)`. On the arm's
    // first real output those were 20-50% of the result set -- uncitable as a
    // function, and invisible while the arm returned nothing at all.
    let note = null;
    const idx = { multisectSearch: (terms) => {
      for (const t of terms) if (!(t.regex instanceof RegExp)) throw new TypeError('bad term');
      return { function_matches: [
        { name: '(global)', filepath: 'a.c' },
        { name: 'realFunction', filepath: 'a.c' },
        { name: '(global)', filepath: 'b.c' },
      ] };
    } };
    const out = contentCandidatesForWords(idx, ['alpha'], { limit: 10, onNote: (n) => { note = n; } });
    assert.deepEqual(out.map((c) => c.name), ['realFunction'], 'only citable functions survive');
    assert.ok(note && /2 file-scope/.test(note), 'and the drop is counted, not silent');
  });

  it('filters BEFORE the limit, so the caller gets what it asked for', () => {
    // The old order sliced first, so a result set half full of file-scope
    // matches quietly yielded fewer real candidates than requested.
    const fns = [];
    for (let i = 0; i < 6; i++) { fns.push({ name: '(global)', filepath: 'x.c' }); }
    for (let i = 0; i < 4; i++) { fns.push({ name: `fn${i}`, filepath: 'x.c' }); }
    const idx = { multisectSearch: () => ({ function_matches: fns }) };
    const out = contentCandidatesForWords(idx, ['alpha'], { limit: 3 });
    assert.equal(out.length, 3, 'three REAL candidates, not three-minus-the-pseudo-ones');
  });

  it('a word that cannot round-trip the term syntax is dropped and reported', () => {
    // parseElementWords already reduces words to [a-z0-9]{3,24}, but this
    // function is exported and `;` `?` `!` all carry meaning in the term string.
    let err = null;
    const idx = { multisectSearch: (terms) => ({
      function_matches: terms.map((t, i) => ({ name: `hit${i}`, filepath: 'a.c' })) }) };
    const out = contentCandidatesForWords(idx, ['good', 'ba;d', '?sneaky'],
      { limit: 10, onError: (e) => { err = e; } });
    assert.ok(err && /2 term\(s\) dropped/.test(err.message), 'the drop is reported');
    assert.equal(out.length, 1, 'only the safe term was searched for');
  });

  it('terms reach multisect in the DOCUMENTED shape', () => {
    // The contract, asserted directly rather than via a permissive mock.
    let seen = null;
    const idx = { multisectSearch: (terms) => { seen = terms; return { function_matches: [] }; } };
    contentCandidatesForWords(idx, ['cipher', 'handshake'], { limit: 5 });
    assert.equal(seen.length, 2);
    for (const t of seen) {
      assert.ok(t.regex instanceof RegExp, 'regex is what multisectSearch calls .test() on');
      assert.equal(typeof t.display, 'string');
      assert.equal(t.negated, false);
      assert.equal(t.hard, false, 'the arm gates on minTerms:1, so terms are SOFT');
    }
    assert.ok(seen[0].regex.test('makeCipherSuite'), 'and the regex actually matches');
  });
});

// ===========================================================================
// A PROMPT'S OWN EXAMPLE MUST SATISFY THE PARSER THAT READS ITS OUTPUT
//
// The discover prompt shipped an example ending in a prefix-less comma list --
//   code words: commit, flush, journal, write, persist, transaction, log
// -- immediately above an OUTPUT section requiring `ELEMENT N: word; word`.
// Gemma copied the shape it was SHOWN over the shape it was TOLD, returned one
// flat list, and parseElementWords returned 0. CE's own demo claim died on
// BOTH --claim-locate and --claim-chart while '101 kept parsing 10/10, so a
// one-claim baseline reported "held, did not move" over a dead artifact
// (asus-CC, #315).
//
// Second instance of the same defect. 3580dc5 fixed the version where the
// example contradicted the prose on CONTENT; this is where it contradicted the
// prose on FORMAT. The rule that generalises: whatever the example
// demonstrates wins, so make the example correct rather than out-arguing it.
//
// These assertions pin no wording -- the prompts stay freely editable -- but
// an example that drifts out of its own output contract fails the suite.
// ===========================================================================
describe('prompt examples parse as the output they demonstrate (#315)', () => {
  it('every ELEMENT-shaped line in the discover prompt parses', () => {
    const P = buildDiscoverPrompt();
    const shaped = P.split('\n').filter((l) => /ELEMENT\s*\d+\s*:/i.test(l));
    assert.ok(shaped.length >= 2, 'the prompt shows output-shaped lines at all');
    // Load-bearing: the check above only inspects lines that ALREADY look like
    // output, so an example that falls OUT of output shape entirely -- exactly
    // the regression -- would be skipped rather than caught. Require the worked
    // example block itself to demonstrate the contract.
    const exStart = P.indexOf('Example of the');
    assert.ok(exStart > 0, 'the prompt still carries a worked example');
    const exBlock = P.slice(exStart, P.indexOf('Rules:', exStart));
    assert.ok(parseElementWords(exBlock).length >= 1,
      'the worked example block demonstrates the output contract, not some other shape');
    for (const line of shaped) {
      assert.equal(parseElementWords(line).length, 1,
        `prompt line does not parse as the output it demonstrates: ${line.trim()}`);
    }
  });

  it('the WORKED EXAMPLE specifically is in output form, not a flat list', () => {
    // The regression itself. A comma list here parses to zero and takes the
    // demo claim down, while '101 survives -- so this cannot be left to a
    // model-dependent baseline to catch.
    const P = buildDiscoverPrompt();
    const example = P.split('\n').find((l) => /commit/.test(l) && /journal/.test(l));
    assert.ok(example, 'the worked example is still present');
    assert.equal(parseElementWords(example).length, 1,
      'the worked example must parse through the parser that reads real answers');
    assert.doesNotMatch(example, /code words:/,
      'the prefix-less "code words:" form is what the model copied');
  });

  it('the select prompt example parses through parseProposedSymbols', () => {
    const S = buildSelectPrompt(
      [{ element: 1, text: 'a thing', words: ['alpha'],
         hits: [{ sym: { name: 'A::b', filepath: 'x.c' }, matched: ['alpha'] }] }], {});
    const example = S.split('\n').find((l) => /ELEMENT\s*1\s*:\s*ExactName/i.test(l));
    assert.ok(example, 'the select prompt still shows an output example');
    assert.ok(parseProposedSymbols(example).length > 0,
      'the select example must parse as a proposal');
  });

  it('the hunt prompt DONE block parses through parseHuntActions', () => {
    const H = buildHuntPrompt();
    const start = H.indexOf('DONE');
    assert.ok(start > 0, 'the hunt prompt still shows its DONE block');
    const block = H.slice(start).split('\n').slice(0, 3).join('\n');
    const parsed = parseHuntActions(block);
    assert.equal(parsed.done, true, 'the demonstrated DONE block reads as done');
    assert.ok(parsed.selections.length > 0,
      'and its element lines parse as selections');
  });
});

// ===========================================================================
// TWO THINGS CLAIM-LOCATE SAYS THAT WERE NOT TRUE OF WHAT IT MEASURED (#315)
//
// 1. `Runs-found: N/3` was presented as firmness. On a LOCAL engine all N runs
//    share one process, so run 1 is cold and the rest are warm — asus-CC
//    measured run 1 matching a fresh process EXACTLY while runs 2 and 3 matched
//    each other exactly. Two answers, not three: carried state, not sampling.
//    A target the engine reproduces byte-for-byte got stamped 2/3, so a reader
//    following the documented meaning DISCOUNTED it. Worse than uninformative.
//
// 2. `+44 candidates from CONTENT search` read as contribution. Content
//    candidates carry score -Infinity and the sort is descending, so they sit
//    below every name-arm candidate. Target lists with the arm on and off are
//    BYTE-IDENTICAL on both corpora — the arm cannot reach a target at all.
// ===========================================================================
describe('claim-locate says what it measured, per engine (#315)', () => {
  it('a LOCAL sampling line calls the count within-process, not a vote', () => {
    const s = samplingLine({ kind: 'gguf', modelPath: '/m/gemma.gguf' }, 3);
    assert.match(s, /WITHIN-PROCESS stability/);
    assert.match(s, /run 1 is cold/, 'names the mechanism, not just the caveat');
    assert.ok(!/each run votes/.test(s),
      'the cloud meaning would tell a reader to discount a stable target');
  });

  it('a CLOUD sampling line is unchanged — the vote meaning is correct there', () => {
    const s = samplingLine({ kind: 'cloud', model: 'claude' }, 3);
    assert.match(s, /each run votes/);
    assert.ok(!/WITHIN-PROCESS/.test(s));
  });

  it('runs=1 says nothing about runs on either engine', () => {
    for (const m of [{ kind: 'gguf', modelPath: '/m/g.gguf' }, { kind: 'cloud' }]) {
      const s = samplingLine(m, 1);
      assert.match(s, /Runs: 1\./);
      assert.ok(!/WITHIN-PROCESS|each run votes/.test(s));
    }
  });

  it('content candidates sort BELOW every name candidate — the structural fact', () => {
    // Pins why the arm cannot reach a target. If a remedy ever lands, THIS is
    // the test that has to be changed deliberately, so nobody rediscovers
    // -Infinity by archaeology.
    const hits = [
      { sym: { name: 'nameA' }, score: 0.1, arm: 'name' },
      { sym: { name: 'contentA' }, score: -Infinity, arm: 'content' },
      { sym: { name: 'nameB' }, score: 12.5, arm: 'name' },
      { sym: { name: 'contentB' }, score: -Infinity, arm: 'content' },
    ];
    hits.sort((a, b) => b.score - a.score);
    const arms = hits.map((h) => h.arm);
    assert.deepEqual(arms, ['name', 'name', 'content', 'content'],
      'every content candidate ranks below every name candidate, whatever its quality');
    // Even the LOWEST-scoring name candidate outranks the best content one.
    assert.ok(hits.findIndex((h) => h.arm === 'content')
      > hits.findLastIndex((h) => h.arm === 'name'),
      'so a selection reading from the top cannot reach one');
  });
});

// ===========================================================================
// THE RESERVED SLOT (#315)
//
// Content hits carry -Infinity, so every one sat behind every name candidate
// and selection -- which reads from the top -- could never reach one. Target
// lists with the arm on and off were BYTE-IDENTICAL on both corpora.
//
// asus-CC judged the candidates directly: rank 1 is good, the tail is noise.
// Demo content rank 1 for element 2 is initialize_crypto_context, the
// implementer of the element reciting "initializing a cryptographic context",
// absent from the 26 targets. ExoPlayer content rank 1 for element 7 is
// AdaptiveTrackSelection::updateSelectedTrack at name-arm rank >2000 --
// unreachable at any depth, because its BODY does the work and its NAME says
// nothing. So: reserve ONE, not ten.
// ===========================================================================
describe('the content arm gets exactly one reserved slot', () => {
  const SYMS = [
    { name: 'CipherNegotiator::selectCipherSuites', filepath: 'a.c' },
    { name: 'CipherNegotiator::negotiate', filepath: 'a.c' },
    { name: 'cipherHelper', filepath: 'a.c' },
  ];
  const contentIndex = (names) => ({
    multisectSearch: (terms) => {
      for (const t of terms) if (!(t.regex instanceof RegExp)) throw new TypeError('bad term');
      return { function_matches: names.map((n) => ({ name: n, filepath: 'z.c' })) };
    },
  });

  const run = async (index) => retrievePerElement({
    draft: async () => 'ELEMENT 1: cipher',
    elements: ['negotiating a cipher'], symbols: SYMS, opts: { index },
  });

  it('promotes exactly ONE content candidate, and it is the arm rank 1', async () => {
    const r = await run(contentIndex(['bodyDoesTheWork', 'secondBest', 'thirdBest']));
    const hits = r.perElement[0].hits;
    const promotedIdx = hits.findIndex((h) => h.arm === 'content');
    assert.equal(hits[promotedIdx].sym.name, 'bodyDoesTheWork',
      'the arm own rank 1 is the one promoted');
    assert.equal(promotedIdx, 1, 'and it lands immediately after the top name candidate');
    // The rest stay where they were -- one slot, not ten.
    const laterContent = hits.slice(2).filter((h) => h.arm === 'content');
    assert.equal(laterContent.length, 2, 'the tail is not promoted');
    assert.ok(hits.slice(2).findIndex((h) => h.arm === 'content')
      > hits.slice(2).findLastIndex((h) => h.arm === 'name'),
      'the unpromoted tail still ranks below every name candidate');
  });

  it('the top NAME candidate keeps rank 1', async () => {
    const r = await run(contentIndex(['bodyDoesTheWork']));
    const hits = r.perElement[0].hits;
    assert.equal(hits[0].arm, 'name', 'rank 1 is never taken by the content arm');
    assert.ok(hits[0].score > -Infinity, 'and it is a real scored candidate');
  });

  it('an ERRORING arm promotes nothing and leaves the list untouched', async () => {
    const withArm = await run({ multisectSearch: () => { throw new Error('boom'); } });
    const noArm = await run(null);
    assert.deepEqual(
      withArm.perElement[0].hits.map((h) => h.sym.name),
      noArm.perElement[0].hits.map((h) => h.sym.name),
      'a failed arm cannot reorder anything');
  });

  it('a content candidate the NAME arm already found is corroborated, not promoted', async () => {
    // It is already in reach on its own merits; promoting it would waste the slot.
    // NOTE the filepath must match: dedup keys on file@name, so `cipherHelper`
    // in a DIFFERENT file is a different symbol and is correctly treated as new.
    const r = await run({
      multisectSearch: () => ({ function_matches: [
        { name: 'cipherHelper', filepath: 'a.c' },      // same file as SYMS
        { name: 'bodyDoesTheWork', filepath: 'z.c' },
      ] }),
    });
    const hits = r.perElement[0].hits;
    const helper = hits.find((h) => h.sym.name === 'cipherHelper');
    assert.equal(helper.arm, 'both', 'found by both arms');
    assert.equal(hits[1].sym.name, 'bodyDoesTheWork',
      'so the slot goes to the best genuinely-new candidate');
  });
});

// ---------------------------------------------------------------------------
// Stage-B calibration against the ATTORNEY'S OWN element structure.
//
// test/fixtures/litigated-claim1-structure.jsonl holds 380 litigated,
// big-tech-drafted software claim 1s with the nested `claim-text` divs
// patents.google.com serves for each -- the drafting attorney's element
// structure, preamble first (#310). It is the first answer key the splitter
// has had that was not one hand-wrapped claim. Stage B was calibrated on ONE
// ('101: "practitioners chart it at ~12 where stage A yields 6"); measured
// here (2026-08-27) the fine mode agrees with the attorney on 30% of claims
// and over-splits 62%, cutting inside elements at mid-element `wherein`
// (378 occurrences the attorney did not split on), `for <verb>ing` (315)
// and `, and` (183) -- US 7,703,036 becomes "receiving an indication of a
// selection of an object" / "for editing via the software application".
//
// The pinned triple is the current behaviour, so a boundary change must move
// it ON PURPOSE. The candidate table is a diagnostic: it measures the
// starting hypotheses in the worklist draft and prints them; which one
// becomes the default is Andrew's call (#310's "fine is the accused
// infringer's chart" posture stands), and landing it means re-pinning here.
describe('splitter: stage-B boundaries vs the attorneys\' structure (380 litigated claim 1s)', () => {
  const FIX = fixture('litigated-claim1-structure.jsonl');
  const have = fs.existsSync(FIX);
  const records = have ? fs.readFileSync(FIX, 'utf-8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];

  // agree / over / under against the attorney's div count, for one splitter configuration
  const triple = (opts) => {
    let agree = 0, over = 0, under = 0;
    for (const r of records) {
      const n = splitClaimElements(r.text, opts).length, truth = r.lines.length;
      if (n === truth) agree++; else if (n > truth) over++; else under++;
    }
    const pct = (x) => Math.round(100 * x / records.length);
    return { agree: pct(agree), over: pct(over), under: pct(under), n: records.length };
  };

  it('has the full fixture', { skip: !have && 'fixture missing' }, () => {
    assert.equal(records.length, 380);
    for (const r of records.slice(0, 5)) assert.ok(r.patent && r.text && r.lines.length >= 2);
  });

  // Re-pinned by claim-granularity-tiers: dropping `for <verb>ing` from stage B moved fine from
  // 30 / 62 / 8 to 42 / 48 / 10. Coarse is untouched.
  it('pins the current agreement: fine 42% / over 48%, coarse 72% / over 3%', { skip: !have && 'fixture missing' }, () => {
    const fine = triple({}), coarse = triple({ fine: false });
    assert.deepEqual([fine.agree, fine.over], [42, 48], `fine ${JSON.stringify(fine)}`);
    assert.deepEqual([coarse.agree, coarse.over], [72, 3], `coarse ${JSON.stringify(coarse)}`);
    assert.ok(coarse.under >= 20 && coarse.under <= 30, `coarse under-splits nested sub-elements: ${coarse.under}%`);
  });

  // Andrew (2026-08-27, on splitter_compare 7703036): for a source-code examiner and attorneys
  // drafting infringement or invalidity charts, the FINE rows are the units of argument -- each
  // embedded `wherein` is a separately-arguable narrowing -- even though the drafting attorney kept
  // them inside one element. So the count-agreement above is the COARSE tier's test (drafter's
  // structure), and the fine tier's test is a property instead: a fine row must subdivide an
  // attorney element, never straddle two. A leading connective is stripped first because the page
  // puts "; and" at the END of the previous div. The 5% that fail are the same colon-intro merge
  // coarse has ("responsive to the detecting:" glued to its first sub-step), not fine cuts.
  it('fine rows subdivide attorney elements and do not straddle them (>= 94%)', { skip: !have && 'fixture missing' }, () => {
    const norm = (s) => String(typeof s === 'string' ? s : (s && (s.text || s.raw)) || s).toLowerCase()
      .replace(/^\d+\.\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(and|or|wherein|whereby) /, '');
    const contained = (opts) => {
      let rows = 0, inside = 0;
      for (const r of records) {
        const divs = r.lines.map(norm);
        for (const e of splitClaimElements(r.text, opts)) { const t = norm(e); if (t.length < 12) continue; rows++; if (divs.some((d) => d.includes(t))) inside++; }
      }
      return Math.round(1000 * inside / rows) / 10;
    };
    const fine = contained({}), coarse = contained({ fine: false });
    assert.ok(fine >= 94, `fine rows inside one attorney element: ${fine}%`);
    assert.ok(coarse >= 92, `coarse rows inside one attorney element: ${coarse}%`);
    assert.ok(fine >= coarse, `fine (${fine}%) should not straddle more than coarse (${coarse}%) -- its extra cuts are subdivisions`);
  });

  it('measures the candidate boundary sets (diagnostic; the default is unchanged)', { skip: !have && 'fixture missing' }, () => {
    // The default since claim-granularity-tiers: wherein, "and also", "which is", ", and" -- no "for <verb>ing".
    const CURRENT = /\bwherein\b|,?\s+and\s+also\s+|,\s*which\s+is\b|,\s*and\s+(?=\w)/;
    const CANDIDATES = {
      'current (fine default)': CURRENT,
      'with "for <verb>ing" (the pre-f2179ab default)': /\bwherein\b|,?\s+and\s+also\s+|,\s*which\s+is\b|,\s*and\s+(?=\w)|\bfor\s+\w+ing\b/,
      'wherein only after , or ;': /[,;]\s*wherein\b|,?\s+and\s+also\s+|,\s*which\s+is\b|,\s*and\s+(?=\w)/,
      'drop wherein entirely': /,?\s+and\s+also\s+|,\s*which\s+is\b|,\s*and\s+(?=\w)/,
      '", and" only before a gerund': /\bwherein\b|,?\s+and\s+also\s+|,\s*which\s+is\b|,\s*and\s+(?=\w+ing\b)/,
      'no wherein, and+gerund': /,?\s+and\s+also\s+|,\s*which\s+is\b|,\s*and\s+(?=\w+ing\b)/,
    };
    const rows = Object.entries(CANDIDATES).map(([name, re]) => ({ name, ...triple({ boundaryRe: re }) }));
    rows.push({ name: 'coarse (stage A only)', ...triple({ fine: false }) });
    console.log('\n  stage-B candidates vs 380 attorney-structured claim 1s (agree / over / under, %):');
    for (const r of rows) console.log(`    ${r.name.padEnd(48)} ${String(r.agree).padStart(3)} / ${String(r.over).padStart(3)} / ${String(r.under).padStart(3)}`);
    // The knob works: the current set through opts reproduces the default exactly.
    const viaOpts = rows[0], dflt = triple({});
    assert.deepEqual([viaOpts.agree, viaOpts.over, viaOpts.under], [dflt.agree, dflt.over, dflt.under]);
    // The retired boundary over-splits MORE than the default (that is why it was retired)...
    assert.ok(rows[1].over > viaOpts.over, `"for <verb>ing" back in: over ${rows[1].over}% should exceed ${viaOpts.over}%`);
    // ...and every candidate that removes a further boundary over-splits no more than the default.
    for (const r of rows.slice(2, -1)) assert.ok(r.over <= viaOpts.over, `${r.name}: over ${r.over}% > default ${viaOpts.over}%`);
  });
});
