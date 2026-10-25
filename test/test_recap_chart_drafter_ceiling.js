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
  pickCeSeededGroups, recordKey, renderCeSeeded, replaceBetweenMarkers, rankedListIsForIndex,
  CEILING_START, CEILING_END, CE_SEEDED_START, CE_SEEDED_END, DEFAULTS,
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

// The ce-seeded half: CodeExam's own ranked candidate groups as the seed. The list below is in
// the shape `--pseudo-claims --candidates <file> --rank` writes: the caveat block, the ranker
// header, the echo lines, then groups whose headers carry `(N fns)` and a `[P<n> signal/fold —
// note]` tag (or `[unscored]`), highest priority first.
describe('ce-seeded selection', () => {
  const ranked = [
    '# ILLUSTRATIVE claim-candidate ranking — a FAST, SURFACE heuristic to suggest where to',
    '# look FIRST, NOT legal analysis and NOT a judgment of novelty, importance, or worth.',
    '#',
    '# mechanism-ranker  index=x__y__abc1234  group-by=multi  5 groups — RANKED by claude-sonnet-4-6 (observe-only; anchors unchanged)',
    '# echo pairs (1): groups sharing a dominant file -- the smaller is likely the same',
    '#   a ~ b (src/a.c)',
    '',
    '# ecdsa (secp256k1_ecdsa_sig_sign)  (4 fns)  [P3 codebase-specific/keep — nonce and recovery id]  — ECDSA signing',
    'src/ecdsa_impl.h@secp256k1_ecdsa_sig_sign',
    'src/ecdsa_impl.h@secp256k1_ecdsa_sig_verify',
    'src/ecdsa_impl.h@secp256k1_ecdsa_sig_parse',
    'src/ecdsa_impl.h@secp256k1_ecdsa_sig_serialize',
    '',
    '# tiny  (2 fns)  [P3 codebase-specific/keep]',
    'src/t.c@one',
    'src/t.c@two',
    '',
    '# scalar (secp256k1_scalar_get_b32)  (4 fns)  [P1 standard-pattern/keep — field arithmetic]',
    'src/scalar.h@secp256k1_scalar_set_b32',
    'src/scalar_low.h@secp256k1_scalar_set_b32',
    'src/scalar.h@secp256k1_scalar_add',
    'src/scalar.h@secp256k1_scalar_mul',
    '',
    '# [file] util.h  (3 fns)  [unscored]',
    'src/util.h@a', 'src/util.h@b', 'src/util.h@c',
    '',
    '# bench  (3 fns)  [P2 standard-pattern/keep]',
    'src/bench.c@bench_a', 'src/bench.c@bench_b', 'src/bench.c@bench_c',
    '',
  ].join('\n');
  const litigant = ['src/ecdsa_impl.h@secp256k1_ecdsa_sig_sign', 'src/scalar_4x64_impl.h@secp256k1_scalar_set_b32', 'src/x.c@other'];
  it('takes the top N by the ranker\'s priority, skips groups under the size floor and the meta headers, and records the overlap with the cited functions by name', () => {
    const sel = pickCeSeededGroups(ranked, litigant, { topN: 3 });
    assert.equal(sel.ranked, true);
    assert.equal(sel.considered, 4, 'the two-function group is not a candidate; the caveat, ranker and echo headers are not groups');
    assert.deepEqual(sel.groups.map((g) => [g.rank, g.label, g.priority]), [
      [1, 'ecdsa (secp256k1_ecdsa_sig_sign)', 3], [2, 'bench', 2], [3, 'scalar (secp256k1_scalar_get_b32)', 1],
    ], 'priority order; the unscored group sorts last and is not picked at N=3');
    assert.deepEqual(sel.groups[0].overlap, { count: 1, of: 4, names: ['secp256k1_ecdsa_sig_sign'] });
    assert.deepEqual(sel.groups[1].overlap, { count: 0, of: 3, names: [] });
    assert.deepEqual(sel.groups[2].overlap, { count: 2, of: 4, names: ['secp256k1_scalar_set_b32'] }, 'overlap is by symbol name, whichever file defines it: two definitions, one distinct name');
    assert.equal(sel.groups[0].purpose, 'ECDSA signing', 'the header\'s purpose survives; the count and the tag are stripped from the label');
    assert.equal(sel.groups[0].anchors.length, 4);
  });
  it('an unranked list (the grouper\'s draft, no tag anywhere) is taken in list order and says so', () => {
    const plain = ranked.split('\n').map((l) => l.replace(/\s+\[P\d[^\]]*\]/, '').replace(/\s+\[unscored\]/, '')).join('\n');
    const sel = pickCeSeededGroups(plain, litigant, { topN: 2 });
    assert.equal(sel.ranked, false);
    assert.deepEqual(sel.groups.map((g) => [g.rank, g.label, g.priority]), [[1, 'ecdsa (secp256k1_ecdsa_sig_sign)', null], [2, 'scalar (secp256k1_scalar_get_b32)', null]]);
  });
  it('caps a group\'s anchors as the litigant\'s are capped, and says so', () => {
    const big = ['# big  (30 fns)  [P3 codebase-specific/keep]', ...Array.from({ length: 30 }, (_, i) => `a.c@f${i}`)].join('\n');
    const sel = pickCeSeededGroups(big, [], { topN: 1 });
    assert.equal(sel.groups[0].size, DEFAULTS.maxAnchors);
    assert.equal(sel.groups[0].total, 30);
    assert.equal(sel.groups[0].capped, true);
    assert.equal(sel.groups[0].anchors.length, DEFAULTS.maxAnchors);
  });
  it('an empty or group-less list selects nothing', () => {
    assert.deepEqual(pickCeSeededGroups('# mechanism-grouper  index=x  0 groups\n', litigant).groups, []);
    assert.deepEqual(pickCeSeededGroups('', litigant).groups, []);
  });
  it('a ranked list is reused across pairs only for the index its header names', () => {
    assert.equal(rankedListIsForIndex(ranked, 'x__y__abc1234'), true);
    assert.equal(rankedListIsForIndex(ranked, 'x__y__abc1235'), false, 'another ref of the same repository is another index');
    assert.equal(rankedListIsForIndex('# mechanism-grouper  index=x__y__abc1234  57 groups\n', 'x__y__abc1234'), false, 'the unranked draft is not a ranked list');
    assert.equal(rankedListIsForIndex('', 'x__y__abc1234'), false);
  });
});

describe('ce-seeded records and the page block', () => {
  const s = (met, of, strict) => ({ mechanism: { met, of }, mechanismStrict: { met: strict, of } });
  it('keys litigant-seeded and ce-seeded records of one pair apart, and the groups apart', () => {
    assert.equal(recordKey({ id: 'a', repo: 'o/r' }), 'a|o/r|litigant|0');
    assert.equal(recordKey({ id: 'a', repo: 'o/r', seed: 'codeexam', group: { rank: 2 } }), 'a|o/r|codeexam|2');
    assert.equal(recordKey({ id: 'a', repo: 'o/r', seed: 'codeexam', group: null }), 'a|o/r|codeexam|0', 'a not-run record has one slot');
    assert.notEqual(recordKey({ id: 'a', repo: 'o/r' }), recordKey({ id: 'a', repo: 'o/r', seed: 'codeexam', group: { rank: 1 } }));
  });
  it('renders one row per group with the litigant measure and floor beside it, a not-run row that says why, and keeps ce-seeded records out of the litigant table', () => {
    const records = [
      { id: 'f11', repo: 'o/secp', engine: 'e', measure: s(2, 2, 1), floor: s(0, 2, 0), control: s(2, 2, 0), read: 'indistinguishable from the control', readStrict: 'finding', bOnly: 13 },
      { id: 'f11', repo: 'o/secp', seed: 'codeexam', group: { rank: 1, label: 'ecdsa (sig_sign)', priority: 3, size: 24, total: 30, capped: true, overlap: { count: 1, of: 30, names: ['x'] } }, measure: s(1, 2, 0), control: s(0, 2, 0), read: 'finding', readStrict: 'indistinguishable from the control', bOnly: 4 },
      { id: 'f11', repo: 'o/secp', seed: 'codeexam', group: { rank: 2, label: 'bench', priority: null, size: 3, total: 3, capped: false, overlap: { count: 0, of: 3, names: [] } }, measure: s(0, 2, 0), control: s(0, 2, 0), read: 'indistinguishable from the control', readStrict: 'indistinguishable from the control', bOnly: 2 },
      { id: 'spark', repo: 'apache/spark', seed: 'codeexam', group: null, reason: 'ranking refused or failed (exit 1); see ce-seeded/rank.log', projected: 'projected cost: ~$9.80 (rank 4000 candidates)' },
    ];
    const rendered = renderCeSeeded(records, { generatedAt: '2026-10-24' });
    assert.ok(rendered.startsWith(CE_SEEDED_START) && rendered.endsWith(CE_SEEDED_END));
    assert.match(rendered, /from 3 record\(s\)/);
    assert.match(rendered, /\| f11 \| o\/secp \| 1: ecdsa \(sig_sign\) \[P3\] \(24 of 30 fns\) \| 1 \/ 30 \| 1 \/ 2; 0 \| 0 \/ 2; 0 \| 2 \/ 2; 1 \| 0 \/ 2; 0 \| finding \| indistinguishable from the control \| 4 \|/);
    assert.match(rendered, /\| f11 \| o\/secp \| 2: bench \[unscored\] \(3 fns\) \| 0 \/ 3 \|/);
    assert.match(rendered, /\| spark \| apache\/spark \| not run: ranking refused or failed \(exit 1\); see ce-seeded\/rank\.log \(projected cost: ~\$9\.80 \(rank 4000 candidates\)\) \| — \| — \| — \| — \| — \| not run \| not run \| — \|/);
    const lit = renderCeiling(records, { generatedAt: '2026-10-24' });
    assert.match(lit, /from 1 record\(s\)/, 'the litigant table has the litigant record only');
    assert.ok(!lit.includes('codeexam') && !lit.includes('bench'));
    const page = `intro\n${CEILING_START}\nold\n${CEILING_END}\nmid\n${CE_SEEDED_START}\nold2\n${CE_SEEDED_END}\nafter\n`;
    const out = replaceBetweenMarkers(page, CE_SEEDED_START, CE_SEEDED_END, rendered);
    assert.ok(out.includes('\nold\n') && !out.includes('old2') && out.includes('mid') && out.includes('after'), 'only the ce-seeded block is replaced');
  });
});
