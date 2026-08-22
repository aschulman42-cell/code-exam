// #307 — claim-analyze retrieval fixes, measured against US 8,752,101 x
// .AndroidX_Media_ExoPlayer3 (asus-CC, 2026-08-10).
//
// Acceptance test (Andrew): the chart references
// `AdaptiveTrackSelection::updateSelectedTrack`. Concluding claim 1 is NOT met is
// fine; charting it onto `BoxParser::parseStbl` — an MP4 sample-table parser — is
// pointed at the wrong subsystem.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { livePositiveTerms, mergeSearchResults, claimAnalyzeTopN, claimNeighbourhoodN, termProbeSource, readClaimFile } from '../src/commands/analyze.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import fs from 'node:fs';
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

// ===========================================================================
// PER-ELEMENT ARM — the third search beside TIGHT and BROAD.
//
// MEASURED failure this exists to fix (.demo x sample_patent_claim.txt,
// 2026-08-11): both cloud engines returned element (e) ABSENT on a corpus that
// implements it, because `SecureChannel::sendMessage` matches 2 of 12 TIGHT
// terms against a quorum of 6. Adding the one term it lacks takes it to 3 — the
// exclusion is arithmetic, not vocabulary, so no term-set fix reaches it.
//
// TEST SHAPE, deliberately. Inputs are built by running the REAL
// buildSymbolTable + searchSymbolsByWords, not by hand-shaping objects. The
// #307 live-term quorum shipped INERT for months because its test passed an
// array of strings while production passed parsed-term objects, and the helper
// took an entirely different branch. A per-element hit is
// `{sym: {filepath, name, bare, start, end, tokens}, matched, score}`; writing
// that literal by hand is the same bet that lost last time.
// ===========================================================================
import {
  matchKey, perElementMatches, perElementBudget, perElementModel, PER_ELEMENT_MAX,
} from '../src/commands/analyze.js';
import { buildSymbolTable } from '../src/core/symbol-verify.js';
import { searchSymbolsByWords } from '../src/commands/claim-locate.js';
import { fileURLToPath } from 'node:url';
// Fixtures resolve from THIS FILE, never from the working directory. A bare
// readFileSync('name.txt') resolves against cwd, which is what made these
// files' absence invisible to anyone running npm test from the repo root
// with them already sitting there (#314).
const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

// A .demo-shaped index: the two long orchestrators whole-claim search selects,
// and the single-limitation implementers it structurally cannot reach.
const DEMO_INDEX = {
  functionIndex: {
    'demo/handshake.c': {
      'establishConnection': { start: 10, end: 96 },   // 87 lines — what TIGHT picks
      'perform_handshake': { start: 100, end: 202 },   // 103 lines
      'verify_certificate_chain': { start: 210, end: 240 },
    },
    'demo/channel.c': {
      'SecureChannel::sendMessage': { start: 5, end: 40 },
      'tls_send_encrypted': { start: 44, end: 70 },
      'sendSecureData': { start: 74, end: 110 },
    },
    'demo/cipher.c': {
      'selectCipherSuites': { start: 3, end: 30 },
      'validateHostname': { start: 34, end: 60 },
    },
  },
};

const DEMO_SYMBOLS = buildSymbolTable(DEMO_INDEX);

// Build a per-element block the way retrievePerElement does: model-predicted
// words in, CE's own symbol-table search out.
const element = (n, words) => ({
  element: n,
  text: `element ${n}`,
  words,
  hits: searchSymbolsByWords(DEMO_SYMBOLS, words, { limit: 25 }),
});

describe('per-element arm: match identity is shared with the whole-claim merge', () => {
  it('keys a per-element hit exactly as the TIGHT/BROAD merge keys its own', () => {
    // The drift this guards is silent in both directions: a key shaped
    // differently would either analyze one function twice at double cost, or
    // suppress a per-element hit that duplicates nothing.
    const tightShaped = { filepath: 'demo/channel.c', function: 'sendSecureData', lines: 37 };
    const [perEl] = perElementMatches([element(1, ['send', 'secure'])], { max: 1 });
    assert.equal(matchKey(perEl), matchKey({ filepath: perEl.filepath, function: perEl.function }));
    assert.equal(
      matchKey({ filepath: 'demo/channel.c', function: 'sendSecureData' }),
      matchKey(tightShaped),
      'the two arms must agree on what "the same function" means');
  });

  it('tolerates the file/name field aliases the merge already accepts', () => {
    assert.equal(matchKey({ file: 'a.c', name: 'f' }), matchKey({ filepath: 'a.c', function: 'f' }));
    assert.equal(matchKey({}), '@');
  });
});

describe('per-element arm: round-robin spends the budget on DISTINCT elements', () => {
  const perElement = [
    element(1, ['handshake', 'connection']),
    element(2, ['certificate', 'verify']),
    element(3, ['cipher', 'select']),
    element(4, ['hostname', 'validate']),
    element(5, ['send', 'secure']),      // the measured ABSENT element
  ];

  it('covers every element before taking any element twice', () => {
    const out = perElementMatches(perElement, { max: 5 });
    assert.deepEqual(out.map((m) => m._element), [1, 2, 3, 4, 5],
      'breadth-first is the mechanism: an uncovered element is an ABSENT verdict');
    assert.equal(new Set(out.map((m) => m._element)).size, 5);
  });

  it('reaches element 5 even when the budget is smaller than the element count', () => {
    // The failure being fixed is per-element, so a short budget must still
    // spread. Depth-first on element 1 would reproduce the bug exactly.
    const out = perElementMatches(perElement, { max: 3 });
    assert.equal(out.length, 3);
    assert.equal(new Set(out.map((m) => m._element)).size, 3, 'three elements, not three hits for one');
  });

  // Neighbouring limitations predict overlapping vocabulary. Indexing every
  // element at the same rank let the first element take the shared top symbol
  // and deduped the second out of its own slot, leaving it uncovered while its
  // second-choice candidate sat unused — the exact failure the arm exists to
  // prevent, reintroduced by the selection rule.
  it('gives an element its best UNTAKEN candidate when two elements overlap', () => {
    const overlapping = [
      element(1, ['send', 'channel']),
      element(2, ['send', 'channel']),   // identical prediction
      element(3, ['send', 'channel']),
    ];
    const out = perElementMatches(overlapping, { max: 3 });
    assert.deepEqual(out.map((m) => m._element), [1, 2, 3],
      'every element must be covered even when their candidate lists collide');
    assert.equal(new Set(out.map((m) => m.function)).size, 3, 'and by distinct functions');
  });

  it('goes to rank 1 only after rank 0 of every element, and only if asked', () => {
    const one = perElementMatches(perElement, { max: 20, ranksPerElement: 1 });
    assert.ok(one.length <= perElement.length, 'default is one candidate per element');
    const two = perElementMatches(perElement, { max: 20, ranksPerElement: 2 });
    assert.ok(two.length > one.length, 'a second rank adds candidates');
    assert.deepEqual(two.slice(0, one.length).map((m) => m._element), one.map((m) => m._element),
      'the rank-0 sweep must come first and be unchanged');
  });
});

describe('per-element arm: the measured .demo failure', () => {
  // THE ACCEPTANCE TEST, expressed at unit level. The live form is a real
  // --claim-analyze run on .demo where element (e) stops being ABSENT.
  const WHOLE_CLAIM_TOP = [
    { filepath: 'demo/handshake.c', function: 'establishConnection', lines: 87, _via: 'tight' },
    { filepath: 'demo/handshake.c', function: 'perform_handshake', lines: 103, _via: 'tight' },
  ];

  it('schedules a transmission implementer the whole-claim quorum cannot reach', () => {
    const out = perElementMatches([element(5, ['send', 'secure', 'message'])], {
      max: 3, skip: WHOLE_CLAIM_TOP.map(matchKey),
    });
    const names = out.map((m) => m.function);
    assert.ok(
      names.some((n) => /sendSecureData|sendMessage|tls_send_encrypted/.test(n)),
      `expected a transmission implementer, got: ${names.join(', ') || '(none)'}`);
  });

  it('does not re-analyze a function the whole-claim search already selected', () => {
    const out = perElementMatches([element(1, ['establish', 'connection', 'handshake'])], {
      max: 5, skip: WHOLE_CLAIM_TOP.map(matchKey),
    });
    assert.equal(out.filter((m) => m.function === 'establishConnection').length, 0,
      'the whole-claim arm ranked it on term evidence and keeps it');
    assert.equal(out.filter((m) => m.function === 'perform_handshake').length, 0);
  });

  it('carries provenance so the artifact can say which search found the cite', () => {
    const [m] = perElementMatches([element(5, ['send', 'secure'])], { max: 1 });
    assert.equal(m._via, 'per-element');
    assert.equal(m._element, 5);
    assert.ok(Array.isArray(m._element_words) && m._element_words.length);
  });

  it('reports NO term count rather than a fabricated one', () => {
    // Per-element retrieval has no quorum and counts no terms. A number here
    // would sit beside real [n/N] counts in the same list and read as one.
    const [m] = perElementMatches([element(5, ['send', 'secure'])], { max: 1 });
    assert.equal(m.terms_matched, null);
  });

  it('emits the line count the analyze pipeline filters and prints on', () => {
    const [m] = perElementMatches([element(5, ['send', 'secure'])], { max: 1 });
    assert.ok(m.lines > 0, 'a 0 would be filtered out as non-extractable');
  });
});

describe('per-element arm: degenerate inputs must not throw', () => {
  it('survives empty, missing and malformed blocks', () => {
    assert.deepEqual(perElementMatches([], { max: 5 }), []);
    assert.deepEqual(perElementMatches(null, { max: 5 }), []);
    assert.deepEqual(perElementMatches(undefined), []);
    assert.deepEqual(perElementMatches([{ element: 1 }], { max: 5 }), [], 'no hits key');
    assert.deepEqual(perElementMatches([{ element: 1, hits: [null, {}] }], { max: 5 }), [],
      'a hit with no sym is skipped, not dereferenced');
  });

  it('honours a zero budget as OFF, not as unlimited', () => {
    assert.deepEqual(perElementMatches([element(1, ['handshake'])], { max: 0 }), []);
  });
});

describe('per-element arm: budget', () => {
  it('defaults to one per element so coverage is counted in elements', () => {
    assert.equal(perElementBudget({}, 5), 5);
    assert.equal(perElementBudget({}, 1), 1);
  });

  it('caps a long claim rather than silently scheduling 40 analysis calls', () => {
    assert.equal(perElementBudget({}, 40), PER_ELEMENT_MAX);
    assert.equal(PER_ELEMENT_MAX, 12, 'same budget as claim-chart maxRetrievedTargets');
  });

  // MEASURED against the real .demo index (2026-08-13): CE splits
  // sample_patent_claim.txt into ELEVEN elements and the transmitting
  // limitation (e) is the TENTH. Round-robin reaches element 10 on the tenth
  // slot, so a tidier default of 6 — matching top-N — would cover elements 1-9
  // and miss exactly the one whose ABSENT verdict prompted this work.
  it('covers the .demo transmitting element, which is the 10th of 11', () => {
    const DEMO_ELEMENTS = 11, TRANSMITTING = 10;
    const budget = perElementBudget({}, DEMO_ELEMENTS);
    assert.ok(budget >= TRANSMITTING,
      `budget ${budget} would not reach element ${TRANSMITTING} — element (e) stays ABSENT`);

    // A fixture sized to the question: 12 distinct symbols the same word set
    // reaches, so an uncovered element means the SELECTION missed it rather
    // than the corpus running out. Built through the real buildSymbolTable +
    // searchSymbolsByWords, like every other input in this file.
    const wide = buildSymbolTable({
      functionIndex: {
        'demo/net.c': Object.fromEntries(
          Array.from({ length: 12 }, (_, i) => [`send_channel_${i}`, { start: i * 10, end: i * 10 + 5 }])),
      },
    });
    const blocks = Array.from({ length: DEMO_ELEMENTS }, (_, i) => ({
      element: i + 1, text: `element ${i + 1}`, words: ['send', 'channel'],
      hits: searchSymbolsByWords(wide, ['send', 'channel'], { limit: 25 }),
    }));
    const covered = perElementMatches(blocks, { max: budget }).map((m) => m._element);
    assert.ok(covered.includes(TRANSMITTING), `element ${TRANSMITTING} uncovered: [${covered}]`);
  });

  it('honours --per-element-n, including 0 as an off switch', () => {
    assert.equal(perElementBudget({ per_element_n: '3' }, 11), 3);
    assert.equal(perElementBudget({ per_element_n: 0 }, 11), 0);
    assert.equal(perElementBudget({ per_element_n: '0' }, 11), 0);
    assert.equal(perElementBudget({ per_element_n: '20' }, 11), 20, 'an explicit ask is not capped');
  });

  it('falls back to the default on junk rather than to 0', () => {
    // 0 would disable the arm silently, which is the failure mode being fixed.
    for (const v of ['abc', '', null, undefined, '-1']) {
      assert.equal(perElementBudget({ per_element_n: v }, 4), 4, `junk: ${JSON.stringify(v)}`);
    }
  });
});

describe('per-element arm: the vocabulary call rides the TERM-EXTRACTION engine', () => {
  it('uses the local model when term extraction is local', () => {
    const m = perElementModel({ llm: 'claude', cpu: false }, '/models/gemma-3-12b-it-Q4_K_M.gguf');
    assert.equal(m.kind, 'gguf');
    assert.equal(m.modelPath, '/models/gemma-3-12b-it-Q4_K_M.gguf');
  });

  it('does NOT let --analyze-model capture the step from the cloud term engine', () => {
    // `--llm claude --analyze-model x.gguf` extracts terms on Claude and
    // analyzes locally. resolveModel's own precedence prefers the GGUF and
    // would move this step to the other engine without saying so — which is
    // exactly the class of silent bypass this whole batch is about.
    const m = perElementModel({ llm: 'claude', analyze_model: '/models/x.gguf' }, null);
    assert.equal(m.kind, 'cloud', 'term extraction was cloud, so this call is cloud');
  });

  it('mirrors claim-analyze default of Claude when no engine is named', () => {
    const m = perElementModel({}, null);
    assert.ok(m === null || m.kind === 'cloud');
  });
});

// Provenance blocks reaching the model as claim text. Found by Andrew running a
// synonymized claim, 2026-08-16, and it corrupted the run before it was caught.
describe('claim files: # provenance is not claim text', () => {
  const SYN = fixture('sample_patent_claim_synon_chatgpt.txt');   // real file, has a 9-line # header
  const PLAIN = fixture('sample_patent_claim.txt');               // real file, no comments

  it('drops # lines and reports how many', () => {
    const seen = [];
    readClaimFile(SYN, { onComments: (n, f) => seen.push([n, f]) });
    assert.equal(seen.length, 1, 'must report exactly once');
    assert.equal(seen[0][0], 9);
    assert.equal(seen[0][1], SYN);
  });

  it('restores the correct element count — the measured corruption', () => {
    // Read raw, this file split to TWELVE: row 1 was the provenance block and
    // row 2 a TRUNCATED first limitation ("for creating a protected exchange
    // link...", with "A method" sheared off), so every row was offset against
    // the chart being compared to.
    const text = readClaimFile(SYN);
    assert.equal(splitClaimElements(text).length, 11);
    assert.match(splitClaimElements(text)[0], /^A method for creating/,
      'the first limitation must be whole, not truncated');
  });

  it('keeps the experiment out of the prompt, which is the point', () => {
    // HOF-b withholds from the model that this is a restatement of another
    // document. The header announced exactly that, plus the engine and the
    // displacement figure.
    const text = readClaimFile(SYN);
    for (const leak of [/Synonymized claim/, /ChatGPT API/, /content-word survival/,
                        /content words survive/, /Source:\s+sample_patent_claim/]) {
      assert.ok(!leak.test(text), `provenance leaked into claim text: ${leak}`);
    }
  });

  it('leaves a comment-free file byte-identical', () => {
    // The regression this could easily introduce: rejoining normalises CRLF to
    // LF, altering every claim file on a Windows checkout for no reason.
    const raw = fs.readFileSync(PLAIN, 'utf-8');
    assert.equal(readClaimFile(PLAIN), raw.trim());
  });

  it('does not report anything when there is nothing to report', () => {
    let called = false;
    readClaimFile(PLAIN, { onComments: () => { called = true; } });
    assert.equal(called, false, 'silence must mean "no comments", not "not checked"');
  });

  it('only strips # at line START, so a mid-line # stays claim text', () => {
    const tmp = 'test_tmp_hash_claim.txt';
    fs.writeFileSync(tmp, 'A method comprising: assigning a #tag to each record;\n', 'utf-8');
    try {
      assert.match(readClaimFile(tmp), /#tag/, 'a # inside a limitation is content');
    } finally { fs.unlinkSync(tmp); }
  });
});
