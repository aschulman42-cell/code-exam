// test_recap_chart_drafter_ceiling.js — the drafter-ceiling script's deterministic parts.
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// No model, no network, no index beyond the fixtures built here. The model steps (draft and
// compare) are exercised by running the script; what they produced is recorded on the page.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAnchors, formatAnchorsList, pickFloorGroup, controlPairs, buildComparePrompt,
  parseCompareResponse, scoreComparison, readMeasure, renderCeiling, replaceCeilingSection,
  CEILING_START, CEILING_END,
} from '../scripts/recap-chart-drafter-ceiling.mjs';

describe('anchors: the litigant\'s cited functions as file@symbol', () => {
  const fi = {
    'src/key.cpp': { 'CKey::MakeNewKey': { start: 1, end: 9 }, 'CKey::Check': { start: 10, end: 12 } },
    'src/other.cpp': { 'Other::Check': { start: 1, end: 3 }, 'GetStrongRandBytes': { start: 5, end: 9 } },
    'src/random.cpp': { 'GetStrongRandBytes': { start: 1, end: 4 } },
    'src/tests.cpp': { 'GetStrongRandBytes': { start: 1, end: 4 } },
    'src/more.cpp': { 'GetStrongRandBytes': { start: 1, end: 4 } },
  };
  it('resolves exact symbols, prefers the cited files on ambiguity, caps per name, keeps chart order', () => {
    const present = [
      { name: 'CKey::MakeNewKey', symbol: 'CKey::MakeNewKey' },
      { name: 'GetStrongRandBytes', symbol: 'GetStrongRandBytes' },
      { name: 'Check', symbol: 'Check' },
      { name: 'secp256k1_ec_seckey_verify', symbol: 'secp256k1_ec_seckey_verify' },
    ];
    const r = resolveAnchors(present, fi, ['src/random.cpp'], { maxPerName: 2 });
    assert.equal(r.anchors[0], 'src/key.cpp@CKey::MakeNewKey', 'chart order');
    assert.equal(r.anchors[1], 'src/random.cpp@GetStrongRandBytes', 'the cited file first');
    assert.equal(r.anchors.filter((a) => a.endsWith('@GetStrongRandBytes')).length, 2, 'at most maxPerName per name');
    assert.ok(r.anchors.includes('src/key.cpp@CKey::Check') && r.anchors.includes('src/other.cpp@Other::Check'), 'a bare name resolves by last segment to every definition, up to the cap');
    assert.deepEqual(r.unresolved, ['secp256k1_ec_seckey_verify'], 'what the index lacks is reported');
    assert.equal(r.capped, false);
  });
  it('skips a chart\'s bare generic names, keeps a qualified one, and reports the skip', () => {
    const idx = {
      'src/a.cpp': { 'interfaces::FoundBlock::data': { start: 1, end: 2 }, 'CBanDB::Write': { start: 3, end: 4 }, 'CKey::Check': { start: 5, end: 6 }, 'Writer::Write': { start: 7, end: 8 } },
    };
    const present = [
      { name: 'bytes.data', symbol: 'data' },           // a local's member, resolved by last segment
      { name: 'hasher.Write', symbol: 'Write' },         // same
      { name: 'CKey::Check', symbol: 'CKey::Check' },    // qualified, exact
      { name: 'Writer::Write', symbol: 'Writer::Write' }, // generic last segment, but qualified and exact
    ];
    const r = resolveAnchors(present, idx);
    assert.deepEqual(r.anchors, ['src/a.cpp@CKey::Check', 'src/a.cpp@Writer::Write']);
    assert.deepEqual(r.skippedGeneric, ['bytes.data', 'hasher.Write']);
  });
  it('caps the group and says so', () => {
    const present = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, symbol: `f${i}` }));
    const big = { 'a.c': Object.fromEntries(present.map((p) => [p.symbol, { start: 1, end: 2 }])) };
    const r = resolveAnchors(present, big, [], { maxAnchors: 24 });
    assert.equal(r.anchors.length, 24);
    assert.equal(r.total, 30);
    assert.equal(r.capped, true);
  });
  it('writes the anchors list the drafter reads: a # label, then file@func lines', () => {
    const text = formatAnchorsList([{ label: 'Case — repo', anchors: ['a.c@f', 'b.c@g'] }]);
    assert.equal(text, '# Case — repo\na.c@f\nb.c@g\n');
  });
});

describe('the floor group', () => {
  const cands = '# group one\nsrc/key.cpp@CKey::MakeNewKey\nsrc/x.cpp@other\nsrc/x.cpp@third\n\n# group two\nsrc/y.cpp@alpha\nsrc/y.cpp@beta\nsrc/y.cpp@gamma\nsrc/y.cpp@delta\n';
  it('takes the first candidate group sharing no function with the litigant\'s set, trimmed to size', () => {
    const g = pickFloorGroup(cands, ['src/key.cpp@CKey::MakeNewKey', 'src/key.cpp@CKey::Check', 'src/random.cpp@GetStrongRandBytes'], 3);
    assert.equal(g.label, 'floor: group two');
    assert.deepEqual(g.anchors, ['src/y.cpp@alpha', 'src/y.cpp@beta', 'src/y.cpp@gamma']);
  });
  it('is null when every group overlaps', () => {
    assert.equal(pickFloorGroup('# only\nsrc/y.cpp@alpha\nsrc/y.cpp@beta\nsrc/y.cpp@gamma\n', ['z.c@alpha'], 3), null);
  });
});

describe('control pairing', () => {
  it('pairs within an art, rotates, never self, and pairs the singles among themselves', () => {
    const cands = [
      { id: 'f11', repos: [{ org: 'bitcoin-core', repo: 'secp256k1' }] },
      { id: 'f14', repos: [{ org: 'bitcoin-core', repo: 'secp256k1' }] },
      { id: 'cs8', repos: [{ org: 'bitcoin-core', repo: 'secp256k1' }] },
      { id: 'mara', repos: [{ org: 'bitcoin', repo: 'bitcoin' }] },
      { id: 'viabtc', repos: [{ org: 'bitcoin', repo: 'bitcoin' }] },
      { id: 'spark', repos: [{ org: 'apache', repo: 'spark' }] },
      { id: 'dss', repos: [{ org: 'makerdao', repo: 'dss' }] },
    ];
    const p = controlPairs(cands);
    for (const c of cands) assert.ok(p.has(c.id) && p.get(c.id) !== c.id, `${c.id} is paired and not with itself`);
    assert.ok(['f14', 'cs8'].includes(p.get('f11')), 'same art');
    assert.equal(p.get('mara'), 'viabtc');
    assert.equal(p.get('viabtc'), 'mara');
    assert.ok(['dss'].includes(p.get('spark')) && p.get('dss') === 'spark', 'the singles pair with each other');
  });
  it('a lone single has no control', () => {
    assert.equal(controlPairs([{ id: 'a', repos: [{ org: 'x', repo: 'y' }] }]).get('a'), null);
  });
});

describe('the compare judge', () => {
  it('prompt carries the numbered A elements and the B text, and asks for the format', () => {
    const { sys, user } = buildComparePrompt(['a method', 'hashing a seed'], 'A method comprising hashing.');
    assert.match(user, /1\. a method\n2\. hashing a seed/);
    assert.match(user, /CLAIM B \(drafted\):\nA method comprising hashing\./);
    assert.match(sys, /A1: MET \| "<quoted B phrase>"/);
    assert.match(sys, /B-ONLY/);
  });
  it('parses labels, quotes and the reverse list strictly, and reports incompleteness', () => {
    const ok = parseCompareResponse('A1: MET | "hashing the seed"\nA2: ABSENT | none\nA3: PARTIAL | "a check"\nB-ONLY: encrypts the key; logs it', 3);
    assert.equal(ok.complete, true);
    assert.deepEqual(ok.verdicts.map((v) => v.label), ['MET', 'ABSENT', 'PARTIAL']);
    assert.equal(ok.verdicts[0].quote, 'hashing the seed');
    assert.equal(ok.verdicts[1].quote, '');
    assert.deepEqual(ok.bOnly, ['encrypts the key', 'logs it']);
    const none = parseCompareResponse('A1: MET | "x"\nB-ONLY: none', 1);
    assert.deepEqual(none.bOnly, []);
    const partial = parseCompareResponse('A1: MET | "x"\nsome chatter\nA3: ABSENT | none', 3);
    assert.equal(partial.complete, false, 'a missing element or a missing B-ONLY line is incomplete');
    const dup = parseCompareResponse('A1: MET | "x"\nA1: ABSENT | none\nB-ONLY: none', 1);
    assert.equal(dup.verdicts.length, 1, 'the first verdict for an element stands');
  });
});

describe('scoring and the read', () => {
  const classes = ['preamble', 'mechanism', 'mechanism', 'generic'];
  it('scores mechanism elements met or partial over mechanism elements, and all, and unparsed', () => {
    const s = scoreComparison([
      { element: 1, label: 'MET' }, { element: 2, label: 'PARTIAL' }, { element: 3, label: 'ABSENT' },
    ], classes);
    assert.deepEqual(s.mechanism, { met: 1, of: 2 });
    assert.deepEqual(s.mechanismStrict, { met: 0, of: 2 }, 'strict counts MET alone');
    assert.deepEqual(s.all, { met: 2, of: 4 });
    assert.equal(s.metOnly, 1);
    assert.equal(s.unparsed, 1, 'element 4 had no verdict');
  });
  it('the strict read uses the MET-only counts', () => {
    const m = { mechanism: { met: 2, of: 2 }, mechanismStrict: { met: 1, of: 2 } };
    const c = { mechanism: { met: 2, of: 2 }, mechanismStrict: { met: 0, of: 2 } };
    assert.equal(readMeasure(m, null, c), 'indistinguishable from the control');
    assert.equal(readMeasure(m, null, c, 'mechanismStrict'), 'finding');
  });
  it('a measure is a finding only above both controls', () => {
    const m = { mechanism: { met: 2, of: 2 } };
    assert.equal(readMeasure(m, { mechanism: { met: 1, of: 2 } }, { mechanism: { met: 0, of: 3 } }), 'finding');
    assert.equal(readMeasure(m, { mechanism: { met: 2, of: 2 } }, { mechanism: { met: 0, of: 3 } }), 'indistinguishable from the floor');
    assert.equal(readMeasure(m, { mechanism: { met: 1, of: 2 } }, { mechanism: { met: 3, of: 3 } }), 'indistinguishable from the control');
    assert.equal(readMeasure(m, null, null), 'uncontrolled');
    assert.equal(readMeasure(null, null, null), 'unscored');
  });
});

describe('the page block', () => {
  it('renders one row per record between the markers and splices into a page', () => {
    const s = (met, of, strict) => ({ mechanism: { met, of }, mechanismStrict: { met: strict, of } });
    const rendered = renderCeiling([{ id: 'mara-1-11', repo: 'bitcoin/bitcoin', engine: 'e', measure: s(3, 6, 2), floor: s(1, 6, 0), control: s(0, 5, 0), read: 'finding', readStrict: 'finding', bOnly: 2 }], { generatedAt: '2026-10-23' });
    assert.ok(rendered.startsWith(CEILING_START) && rendered.endsWith(CEILING_END));
    assert.match(rendered, /\| mara-1-11 \| bitcoin\/bitcoin \| e \| 3 \/ 6; 2 \| 1 \/ 6; 0 \| 0 \/ 5; 0 \| finding \| finding \| 2 \|/);
    const page = `# Page\n\nintro\n\n${CEILING_START}\nold\n${CEILING_END}\n\nafter\n`;
    const out = replaceCeilingSection(page, rendered);
    assert.ok(out.includes('intro') && out.includes('after') && !out.includes('\nold\n'));
    assert.throws(() => replaceCeilingSection('no markers', rendered), /markers/);
  });
});
