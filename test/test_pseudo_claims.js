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
  buildAnchorSidecar, writeClaimsOnly, claimToLine,
} from '../src/commands/pseudo-claims.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { detectClaims } from '../src/commands/synonymize.js';

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
