// --pseudo-claims --claims-only: the MACHINE-READABLE sibling of the human
// artifact, plus the anchors sidecar that later becomes a scoreable answer key.
//
// WHY THIS FILE EXISTS. The artifact `--pseudo-claims` writes is for a reader —
// caveat block, contents list, anchor tables, evidence-pack notes. Feeding it to
// the next stage does not work, and fails expensively: on a real run
// (Andrew, iOS 8.1 headers) `--synonymize @<artifact>` split it into 171
// "elements" and started rewriting the legal disclaimer one model call at a
// time. The producer emitting a machine format is the fix; these tests hold it
// to that.
//
// TEST SHAPE. Draft objects are shaped exactly as the drafting loop builds them
// (`prose` / `grounded` / `dropped` / `error`), because the recurring defect on
// this project is a helper whose test passed a shape production never sends.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildAnchorSidecar, writeClaimsOnly, claimToLine, parseGeneratedClaim, groundAnchors,
  normalizeAnchorRef,
} from '../src/commands/pseudo-claims.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { draftCloud, wasLastDraftTruncated, truncationCount, truncationLine, resetCloudUsage } from '../src/core/llm-runner.js';
import { PSEUDO_CLAIM_MAX_OUTPUT_TOKENS } from '../src/commands/pseudo-claims.js';
import { openaiCompletionBudget, OPENAI_REASONING_FLOOR } from '../src/core/openai-util.js';

// Swap global fetch for one canned JSON body, restore unconditionally.
async function withStubbedFetch(json, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => json, text: async () => '' });
  try { return await fn(); } finally { globalThis.fetch = real; }
}
import { detectClaims } from '../src/commands/synonymize.js';
import { fileURLToPath } from 'node:url';
// Fixtures resolve from THIS FILE, never from the working directory (#314).
const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

const GROUPS = [
  { label: 'address book view controllers' },
  { label: 'media playback' },
  { label: 'failed one' },
];

// Hard-wrapped on purpose: the drafter wraps its prose, and the wrapping carries
// no meaning — element boundaries live in the punctuation.
const PROSE_A = `A method for presenting contact records on a mobile device,\n`
  + `comprising: instantiating a view controller bound to a record store;\n`
  + `populating the view controller with records read from the store; and\n`
  + `dismissing the view controller upon receipt of a completion signal.`;
const PROSE_B = `A system for decoding a media stream, comprising: a demultiplexer\n`
  + `configured to separate elementary streams; and a decoder configured to\n`
  + `render the separated streams in presentation order.`;

const DRAFTS = [
  {
    prose: PROSE_A,
    grounded: [
      { file: 'Frameworks\\AddressBookUI\\ABAbstractViewController.h', func: 'ABAbstractViewController', start: 11, end: 34, element: 'instantiating a view controller' },
      { file: 'Frameworks\\AddressBookUI\\ABPeoplePicker.h', func: 'showRecords', start: 40, end: 66, element: 'populating the view controller', ambiguous: true },
    ],
    dropped: [{ file: 'Frameworks\\AddressBookUI\\Missing.h', func: 'nope', reason: 'cited function not found in index' }],
  },
  {
    prose: PROSE_B,
    grounded: [
      { file: 'Frameworks\\MediaPlayer\\MPDemux.h', func: '', start: 5, end: 90, element: 'a demultiplexer', kind: 'lines' },
    ],
    dropped: [],
  },
  { error: 'model returned no claim text', grounded: [], dropped: [] },
];

const TMP = 'test/.tmp-claims-only.txt';
const SIDE = `${TMP}.anchors.json`;
const cleanup = () => { for (const f of [TMP, SIDE]) if (fs.existsSync(f)) fs.unlinkSync(f); };
const META = { argv: 'ce --pseudo-claims --claims-only x', ceVersion: '1.2.3', generatedAt: '2026-08-17T00:00:00Z' };

describe('--claims-only: one claim per line, and nothing else', () => {
  it('writes exactly the claims — no caveat, no headings, no anchor tables', (t) => {
    t.after(cleanup);
    const res = writeClaimsOnly(TMP, GROUPS, DRAFTS, META);
    assert.equal(res.ok, true);
    const body = fs.readFileSync(TMP, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(body.length, 2, 'two drafted claims, one line each');
    for (const l of body) {
      assert.ok(!/^#|^##|Cited anchors|pseudo patent claims/.test(l),
        `artifact prose leaked into the machine file: ${l}`);
    }
  });

  it('collapses the drafter\'s hard wrapping — a claim is one sentence', (t) => {
    t.after(cleanup);
    writeClaimsOnly(TMP, GROUPS, DRAFTS, META);
    const body = fs.readFileSync(TMP, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    assert.ok(!/\n/.test(body[0]));
    assert.match(body[0], /comprising: instantiating a view controller/,
      'the wrap must not survive as a double space or a broken word');
    assert.ok(!/  /.test(body[0]), 'no doubled whitespace from the join');
  });

  it('carries the format marker, so --synonymize reads it without a flag', (t) => {
    t.after(cleanup);
    writeClaimsOnly(TMP, GROUPS, DRAFTS, META);
    const back = detectClaims(fs.readFileSync(TMP, 'utf8'));
    assert.equal(back.mode, 'marker', 'the producer declares its format; no heuristic needed');
    assert.equal(back.claims.length, 2);
  });

  it('names the model-run provenance the artifact carries', (t) => {
    t.after(cleanup);
    writeClaimsOnly(TMP, GROUPS, DRAFTS, META);
    const head = fs.readFileSync(TMP, 'utf8');
    assert.match(head, /# CE:\s+1\.2\.3/);
    assert.match(head, /# Command:\s+ce --pseudo-claims/);
    assert.match(head, /NOT patent claims/, 'the caveat is dropped from the body, not from the file');
  });

  it('a FAILED draft is skipped and COUNTED, never emitted as a blank line', (t) => {
    t.after(cleanup);
    const res = writeClaimsOnly(TMP, GROUPS, DRAFTS, META);
    assert.equal(res.claims, 2);
    assert.equal(res.skipped, 1);
    const lines = fs.readFileSync(TMP, 'utf8').split('\n').filter((l) => !l.startsWith('#'));
    assert.ok(!lines.some((l) => l === '' && lines.indexOf(l) < lines.length - 1),
      'a blank line would silently shift every later claim against its key');
  });
});

describe('--claims-only: the anchors sidecar is the answer key', () => {
  it('keeps every GROUNDED anchor, with the fields a scorer needs', () => {
    const side = buildAnchorSidecar(GROUPS, DRAFTS, META);
    assert.equal(side.claims.length, 2);
    const a = side.claims[0].grounded[0];
    assert.equal(a.file, 'Frameworks\\AddressBookUI\\ABAbstractViewController.h');
    assert.equal(a.func, 'ABAbstractViewController');
    assert.equal(a.start, 11);
    assert.equal(a.end, 34);
    // Line numbers travel because "right file, wrong lines" is a real observed
    // failure (asus-CC, Gemma arm, #306) and a key without them cannot score it.
    assert.ok(Number.isInteger(a.start) && Number.isInteger(a.end));
  });

  it('flags an AMBIGUOUS anchor rather than presenting it as certain', () => {
    const side = buildAnchorSidecar(GROUPS, DRAFTS, META);
    assert.equal(side.claims[0].grounded[1].ambiguous, true);
    assert.ok(!('ambiguous' in side.claims[0].grounded[0]),
      'and does not label the unambiguous ones');
  });

  it('carries doc anchors with their kind, not silently as functions', () => {
    const side = buildAnchorSidecar(GROUPS, DRAFTS, META);
    assert.equal(side.claims[1].grounded[0].kind, 'lines');
    assert.equal(side.claims[1].grounded[0].func, '');
  });

  it('carries DROPPED citations with their reason', () => {
    // A key that silently omits what the drafter cited but CE could not find
    // would overstate how complete it is.
    const side = buildAnchorSidecar(GROUPS, DRAFTS, META);
    assert.equal(side.claims[0].dropped.length, 1);
    assert.match(side.claims[0].dropped[0].reason, /not found in index/);
  });

  it('records each claim\'s ELEMENTS, so a scorer can refuse a mismatched pair', () => {
    // Pairing rewritten element i against key element i is only sound while the
    // counts agree; recording the count is what lets a later comparison refuse
    // instead of reporting a plausible wrong number.
    const side = buildAnchorSidecar(GROUPS, DRAFTS, META);
    for (const c of side.claims) {
      assert.deepEqual(c.elements, splitClaimElements(c.claim));
      assert.ok(c.elements.length >= 2, 'a claim with a preamble and steps');
    }
  });

  it('keeps the claims file and the key POSITIONALLY aligned', (t) => {
    t.after(cleanup);
    writeClaimsOnly(TMP, GROUPS, DRAFTS, META);
    const lines = fs.readFileSync(TMP, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    const side = JSON.parse(fs.readFileSync(SIDE, 'utf8'));
    assert.equal(lines.length, side.claims.length);
    lines.forEach((l, i) => assert.equal(l, side.claims[i].claim,
      `line ${i + 1} of the claims file must be claim ${i + 1} of the key`));
  });

  it('traces each claim back to the group it came from, past the skipped one', () => {
    // The failed draft is claim 3 of the artifact; renumbering to 1..2 keeps the
    // key aligned with the claims file, and groupN keeps the trail back.
    const side = buildAnchorSidecar(GROUPS, DRAFTS, META);
    assert.deepEqual(side.claims.map((c) => c.n), [1, 2]);
    assert.deepEqual(side.claims.map((c) => c.groupN), [1, 2]);
    assert.equal(side.claims[0].label, 'address book view controllers');
  });

  it('states in the file what GROUNDED does and does not mean', () => {
    // The honesty statement is a deliberate property of the artifact: this key
    // records what the DRAFTING MODEL cited, verified to resolve — not what a
    // practitioner would cite. Any number scored against it inherits that.
    const side = buildAnchorSidecar(GROUPS, DRAFTS, META);
    assert.match(side.note, /DRAFTING MODEL/);
    assert.match(side.note, /not what a practitioner would cite/);
  });

  it('is versioned, so a later scorer can refuse a shape it does not know', () => {
    const side = buildAnchorSidecar(GROUPS, DRAFTS, META);
    assert.equal(side.format, 'ce-pseudo-claim-anchors');
    assert.equal(side.version, 1);
  });
});

describe('--claims-only: claimToLine', () => {
  it('collapses all whitespace and trims', () => {
    assert.equal(claimToLine('  A method,\n  comprising:\tdoing   a thing.  '),
      'A method, comprising: doing a thing.');
  });

  it('tolerates an empty or missing prose without throwing', () => {
    assert.equal(claimToLine(''), '');
    assert.equal(claimToLine(null), '');
  });
});

// ---------------------------------------------------------------------------
// draft-truncation-detection: a cut-off draft must not read as a finished one.
//
// MEASURED on the Gemini drafter-swap run (same CodeExam_candidates_v4.txt as
// the Claude and ChatGPT runs): 15 of 41 claims ended mid-sentence, and because
// the ANCHORS: block FOLLOWS the claim prose, 16 claims arrived with zero
// anchors. CE said nothing -- they sat in a file for a day looking like ordinary
// output, and were first read as an 18% FABRICATION rate. The distinguishing
// evidence was the mid-sentence prose; a half-written citation
// ("MECHANISM: @ L1-L10", "src/core/Code @") looks exactly like an invented one.
//
// openaiFinishReason already existed and was already used at analyze.js:243 and
// server.js:539. This draft path simply never asked.

describe('draft truncation is detected and reported', () => {
  const body = (over) => ({
    id: 'x', usage: { input_tokens: 10, output_tokens: 20 },
    ...over,
  });

  it('flags the OPENAI wire on finish_reason=length', async () => {
    const res = await withStubbedFetch(body({
      choices: [{ message: { content: 'partial text' }, finish_reason: 'length' }],
    }), () => draftCloud({ wire: 'openai-compat', model: 'gpt-5.1', apiUrl: 'x', label: 'l' },
      'sys', 'user', 100, 0));
    assert.equal(res, 'partial text');
    assert.equal(wasLastDraftTruncated(), true);
  });

  it('flags the ANTHROPIC wire on stop_reason=max_tokens', async () => {
    // The anthropic branch was equally blind. Claude has not visibly truncated
    // only because its drafts run shorter -- the same silence was waiting.
    const res = await withStubbedFetch(body({
      content: [{ type: 'text', text: 'partial text' }], stop_reason: 'max_tokens',
    }), () => draftCloud({ wire: 'anthropic', model: 'claude-x', apiUrl: 'x', key: 'k', label: 'l' },
      'sys', 'user', 100, 0));
    assert.equal(res, 'partial text');
    assert.equal(wasLastDraftTruncated(), true);
  });

  it('does NOT flag a complete draft on either wire', async () => {
    // The check must not fire on the runs that are already complete -- Claude and
    // ChatGPT both produced 41 whole claims with 0 dropped anchors.
    await withStubbedFetch(body({
      choices: [{ message: { content: 'whole' }, finish_reason: 'stop' }],
    }), () => draftCloud({ wire: 'openai-compat', model: 'gpt-5.1', apiUrl: 'x', label: 'l' }, 's', 'u', 100, 0));
    assert.equal(wasLastDraftTruncated(), false);
    await withStubbedFetch(body({
      content: [{ type: 'text', text: 'whole' }], stop_reason: 'end_turn',
    }), () => draftCloud({ wire: 'anthropic', model: 'c', apiUrl: 'x', key: 'k', label: 'l' }, 's', 'u', 100, 0));
    assert.equal(wasLastDraftTruncated(), false);
  });

  it("the flag is THIS call's verdict, not the previous call's", async () => {
    // Callers read it immediately after `await draft(...)`. draftCloud clears on
    // entry so a stale true cannot leak into the next claim.
    await withStubbedFetch(body({
      choices: [{ message: { content: 'cut' }, finish_reason: 'length' }],
    }), () => draftCloud({ wire: 'openai-compat', model: 'm', apiUrl: 'x', label: 'l' }, 's', 'u', 100, 0));
    assert.equal(wasLastDraftTruncated(), true);
    await withStubbedFetch(body({
      choices: [{ message: { content: 'whole' }, finish_reason: 'stop' }],
    }), () => draftCloud({ wire: 'openai-compat', model: 'm', apiUrl: 'x', label: 'l' }, 's', 'u', 100, 0));
    assert.equal(wasLastDraftTruncated(), false, 'a stale true would mark the wrong claim');
  });

  it('counts truncations across a run and resets with the usage counters', async () => {
    resetCloudUsage();
    assert.equal(truncationCount(), 0);
    assert.equal(truncationLine(), null, 'silence when there is nothing to report');
    for (let i = 0; i < 3; i += 1) {
      await withStubbedFetch(body({
        choices: [{ message: { content: 'cut' }, finish_reason: 'length' }],
      }), () => draftCloud({ wire: 'openai-compat', model: 'm', apiUrl: 'x', label: 'l' }, 's', 'u', 100, 0));
    }
    assert.equal(truncationCount(), 3);
    assert.match(truncationLine(), /3 draft\(s\) hit the output budget/);
    resetCloudUsage();
    assert.equal(truncationCount(), 0);
  });

  it('the output budget EXCEEDS the provider floor, or it does not bind at all', () => {
    // The trap this fold fixes. A first attempt set the constant to 4000, which
    // changed nothing: openaiCompletionBudget floors /^gemini-/ and reasoning
    // models to OPENAI_REASONING_FLOOR (4096), so max(4000, 4096) is the same
    // 4096 that max(900, 4096) already gave. Gemini truncated at exactly the
    // same rate and the re-run re-measured a budget that had never moved.
    assert.ok(PSEUDO_CLAIM_MAX_OUTPUT_TOKENS > OPENAI_REASONING_FLOOR,
      `constant ${PSEUDO_CLAIM_MAX_OUTPUT_TOKENS} must exceed the ${OPENAI_REASONING_FLOOR} floor to have any effect`);
    for (const m of ['gemini-2.5-flash', 'gpt-5.1', 'claude-sonnet-4-6']) {
      assert.equal(openaiCompletionBudget(m, PSEUDO_CLAIM_MAX_OUTPUT_TOKENS),
        PSEUDO_CLAIM_MAX_OUTPUT_TOKENS, `the floor still overrides the constant for ${m}`);
    }
  });

  it('the output budget is a NAMED constant, not a literal at the call site', () => {
    // It was a bare 900, never measured against a real draft, sitting where it
    // could not be seen from the prompt it serves.
    assert.ok(PSEUDO_CLAIM_MAX_OUTPUT_TOKENS >= 2000,
      'must leave room for a claim plus its ANCHORS block');
    const src = fs.readFileSync('src/commands/pseudo-claims.js', 'utf8');
    assert.ok(!/drafter\(PSEUDO_CLAIM_GENERATE_SYS[^)]*, 900\)/.test(src),
      'the bare 900 must be gone');
  });
});

// ---------------------------------------------------------------------------
// issue-313: the anchor parser discarded the most precise form it could be given.
//
// `ref.split('@')` required exactly two parts, so a ref carrying BOTH a symbol
// and a line range -- src/core/ai-ml-detectors.js@_AIMLMethods::classify@L2150-2174
// -- fell through to a colon fallback that did not match, left func empty, and
// was dropped as "no function name to verify".
//
// MEASURED on the Gemini run over .CE_081726: 63 dropped anchors, and ALL 63
// re-parse to a function name under the new rule. I had predicted 54 (the ones
// with a visible second @) and classified the other 9 as genuine index misses;
// they were parse casualties too.

describe('anchor refs: function name AND line range', () => {
  const parse = (ref) => parseGeneratedClaim(`CLAIM: x\nANCHORS:\n- ${ref} — el`).anchors[0];

  it('parses file@Class::method@Lstart-end into all three fields', () => {
    const a = parse('src/core/ai-ml-detectors.js@_AIMLMethods::classify@L2150-2174');
    assert.equal(a.file, 'src/core/ai-ml-detectors.js');
    assert.equal(a.func, '_AIMLMethods::classify');
    assert.equal(a.citedStart, 2150);
    assert.equal(a.citedEnd, 2174);
  });

  it('accepts a single-line range', () => {
    const a = parse('src/a.js@fn@L42');
    assert.equal(a.func, 'fn');
    assert.equal(a.citedStart, 42);
    assert.equal(a.citedEnd, 42);
  });

  it('leaves the plain file@func form exactly as before', () => {
    const a = parse('src/b.js@fn');
    assert.equal(a.file, 'src/b.js');
    assert.equal(a.func, 'fn');
    assert.equal(a.citedStart, 0, 'no range cited, none invented');
  });

  it('leaves the DOC form file@Lstart-end alone — the regression that nearly shipped', () => {
    // groundAnchors identifies a doc citation by matching /^L(\d+)/ against
    // `func`. Stripping the @L suffix unconditionally emptied func and would
    // have silently broken every documentation citation in every existing
    // artifact. The suffix is only stripped when another '@' precedes it.
    const a = parse('src/c.js@L1-20');
    assert.equal(a.func, 'L1-20', 'the doc path keys off this');
    assert.equal(a.citedStart, 0);
  });

  it('tolerates an @ inside the PATH by splitting on the last one', () => {
    // Counting parts breaks here; issue-241-paste-safe-path-output round-trips
    // @-in-path, so this is a real shape rather than a hypothetical.
    const a = parse('weird@path@d.js@fn2@L5');
    assert.equal(a.file, 'weird@path@d.js');
    assert.equal(a.func, 'fn2');
    assert.equal(a.citedStart, 5);
  });

  it('still strips a trailing () from a function name', () => {
    assert.equal(parse('src/e.js@fn()').func, 'fn');
  });

  // The skip guard is gone deliberately. It existed because the recorded run
  // sat untracked in the working directory, so a fresh clone skipped this test
  // and reported green while testing less (#314) — the worse of the two
  // failures. The fixture is committed now, so its absence is a real failure.
  it('EVERY dropped anchor from the recorded Gemini run now parses', () => {
    const d = JSON.parse(fs.readFileSync(fixture('gemini_v2_dropped_anchors.json'), 'utf8'));
    const dropped = d.claims.flatMap((c) => c.dropped);
    assert.ok(dropped.length > 0, 'fixture must actually contain drops');
    for (const a of dropped) {
      const ref = a.func ? `${a.file}@${a.func}` : a.file;
      assert.ok(parse(ref).func, `still unparseable: ${ref}`);
    }
  });
});

describe('cited ranges are a CHECK, not the answer', () => {
  const idx = (start, end) => ({
    findFunctionMatches: () => [{ filepath: 'src/a.js', name: 'fn', start, end }],
  });

  it('grounds on the INDEX bounds and carries the cited range alongside', () => {
    const { grounded } = groundAnchors(idx(100, 200),
      [{ file: 'src/a.js', func: 'fn', citedStart: 120, citedEnd: 150, element: 'e' }]);
    assert.equal(grounded[0].start, 100, 'index is authoritative about where a symbol lives');
    assert.equal(grounded[0].end, 200);
    assert.equal(grounded[0].citedStart, 120);
    assert.ok(!grounded[0].rangeMismatch, 'inside the function: no flag');
  });

  it('flags a range OUTSIDE the resolved function rather than dropping it', () => {
    // "Right file, right symbol, wrong lines" -- the failure asus-CC found by
    // eye on the Gemma arm (#306). The symbol is real and verified, so erasing
    // the citation would lose information; the mismatch is the finding.
    const { grounded, dropped } = groundAnchors(idx(100, 200),
      [{ file: 'src/a.js', func: 'fn', citedStart: 900, citedEnd: 950, element: 'e' }]);
    assert.equal(dropped.length, 0, 'a real symbol is not erased over a bad range');
    assert.equal(grounded[0].rangeMismatch, true);
    assert.equal(grounded[0].start, 100, 'still grounded on index bounds');
  });

  it('adds no range fields when the model cited none', () => {
    const { grounded } = groundAnchors(idx(1, 9),
      [{ file: 'src/a.js', func: 'fn', element: 'e' }]);
    assert.ok(!('citedStart' in grounded[0]));
    assert.ok(!('rangeMismatch' in grounded[0]));
  });

  it('an unparseable ref drops with a SPECIFIC reason, not the catch-all', () => {
    // The catch-all is how 54 parser failures were read as 54 model failures.
    const { dropped } = groundAnchors(idx(1, 9),
      [{ file: 'a@b@c', func: '', element: 'e' }]);
    assert.match(dropped[0].reason, /could not be parsed/);
  });
});

// ONE NORMALIZER, NOT A BRANCH PER SHAPE.
//
// 56df6c5 taught this parser Gemini's `@L2150-2174`. asus-CC hit Gemma3's
// ` (L183-276)` within an hour of that commit (#314): 7 of 10 dropped anchors
// were the parenthetical form, and BOTH zero-anchor claims were 100% this
// defect. Corrected: grounded 196 -> 203, dropped 10 -> 3, zero-anchor 2 -> 0,
// with zero invented identifiers across 37 claims.
describe('anchor refs normalize across every notation engines emit', () => {
  const n = (r) => normalizeAnchorRef(r);

  it('the two-part baseline is unchanged', () => {
    const r = n('src/a.js@Cls::meth');
    assert.deepEqual([r.file, r.func, r.shape], ['src/a.js', 'Cls::meth', 'two-part']);
    assert.equal(r.citedStart, 0);
  });

  it("Gemini's @L form — the one 56df6c5 fixed — still parses", () => {
    const r = n('src/core/ai-ml-detectors.js@_AIMLMethods::classify@L2150-2174');
    assert.equal(r.func, '_AIMLMethods::classify');
    assert.deepEqual([r.citedStart, r.citedEnd], [2150, 2174]);
  });

  it("Gemma3's parenthetical form — the one that cost 7 of 10 drops", () => {
    const r = n('src/core/TreeSitterParser.js@TreeSitterParser::parseFunctions (L183-276)');
    assert.equal(r.func, 'TreeSitterParser::parseFunctions', 'parenthetical no longer attached');
    assert.deepEqual([r.citedStart, r.citedEnd], [183, 276]);
    assert.equal(r.shape, 'paren-range');
  });

  // The BARE form is not speculative: re-parsing 14 recorded runs (3,669 refs)
  // found `bare-range: 7` in the Gemini v1 sidecar. It was being mis-parsed the
  // whole time and nobody had a name for it. The bracket form remains unseen.
  it('bracket and bare forms — bare is already in the wild', () => {
    assert.equal(n('src/a.js@fn [L10-20]').func, 'fn');
    assert.equal(n('src/a.js@fn L10-20').func, 'fn');
    assert.equal(n('src/a.js@fn L10-20').citedEnd, 20);
  });

  // THE TRAP. groundAnchors identifies a documentation cite by matching
  // /^L(\d+)/ against `func`, so stripping the range there empties func and
  // silently breaks every doc citation in every existing artifact. This broke
  // once already during 56df6c5, caught by hand before the suite ran.
  it('a DOC cite keeps its range as func — the regression 56df6c5 nearly shipped', () => {
    const r = n('docs/guide.md@L1-20');
    assert.equal(r.file, 'docs/guide.md');
    assert.equal(r.func, 'L1-20', 'groundAnchors routes on this, so it must survive');
    assert.match(r.func, /^L(\d+)/, 'the exact predicate groundAnchors uses');
    assert.equal(r.citedStart, 0, 'a doc cite carries its range in func, not as a check');
  });

  it('and a doc cite in the NEW notation routes the same way', () => {
    // Falls out of the uniform rule rather than needing its own branch: strip
    // the range, and if no `@` remains it WAS the function slot.
    const r = n('docs/guide.md (L1-20)');
    assert.equal(r.func, 'L1-20');
    assert.equal(r.shape, 'doc-range');
  });

  it('splits on the LAST @, so a path containing @ survives', () => {
    // Counting parts breaks here, which is a real case — issue-241 round-trips
    // an @ in a path.
    const r = n('src/@scope/pkg.js@Cls::meth@L5-9');
    assert.equal(r.file, 'src/@scope/pkg.js');
    assert.equal(r.func, 'Cls::meth');
  });

  it('labels the wrong-FIELD case rather than acting on it', () => {
    // One occurrence in 37 claims. It gets a name so its frequency becomes
    // measurable before anything is built for it.
    assert.equal(n('qmapFile').shape, 'func-in-file-slot');
    assert.equal(n('src/a.js').shape, 'file-only');
    assert.equal(n('src/a.js:123').line, 123);
  });

  it('every shape is NAMED, so an unrecognised one is a count and not a silence', () => {
    for (const r of ['a.js@f', 'a.js@f@L1-2', 'a.js@f (L1-2)', 'a.js@f [L1-2]',
      'a.js@f L1-2', 'd.md@L1-2', 'a.js:1', 'qmap']) {
      assert.ok(normalizeAnchorRef(r).shape, `${r} produced no shape label`);
    }
  });
});
