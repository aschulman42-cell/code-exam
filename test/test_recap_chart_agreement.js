// test_recap_chart_agreement.js — the matching, scoring, parsing and rendering of scripts/recap-chart-agreement.mjs; no network, no model, no index
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  lastSegment, nameKey, matchFunctions, matchFiles, agreement, parseTargets, parseVerdicts, claimWords, symbolWords, tier0Rank,
  validatePicks, buildManifest, renderAgreement, replaceSection, parseArgs, rollup, indexArgs, AGREEMENT_START, AGREEMENT_END,
} from '../scripts/recap-chart-agreement.mjs';

describe('names: what a chart points at, and whether the index has it', () => {
  it('the last segment of a scoped or dotted name, the whole of an underscore name', () => {
    assert.equal(lastSegment('CKey::MakeNewKey'), 'MakeNewKey');
    assert.equal(lastSegment('web3.eth.signTransaction'), 'signTransaction');
    assert.equal(lastSegment('secp256k1_ecdsa_sign_inner'), 'secp256k1_ecdsa_sign_inner');
    assert.equal(lastSegment('left.execute().zipPartitionsWithEvaluator'), 'execute', 'a call chain stops at the first parenthesis');
    assert.equal(nameKey('CKey::Check'), 'check');
  });
  it('matchFunctions: exact on the segment, then case-insensitive; the rest are absent, never scored', () => {
    const m = matchFunctions(['CKey::MakeNewKey', 'secp256k1_ecdsa_sign_inner', 'getstrongrandbytes', 'NotHere', 'smjScanner.findNextInnerJoinRows'],
      ['MakeNewKey', 'secp256k1_ecdsa_sign_inner', 'GetStrongRandBytes', 'SortMergeJoinExec::findNextInnerJoinRows']);
    assert.deepEqual(m.present.map((p) => p.symbol), ['MakeNewKey', 'secp256k1_ecdsa_sign_inner', 'GetStrongRandBytes', 'SortMergeJoinExec::findNextInnerJoinRows'], 'a Scala method is indexed as Class::method');
    assert.deepEqual(m.absent, ['NotHere']);
  });
  it('matchFiles: a basename or a path suffix against the indexed paths', () => {
    const m = matchFiles(['key.cpp', 'src/secp256k1.c', 'router/src/server.rs', 'missing.go'], ['src\\key.cpp', 'src/secp256k1/src/secp256k1.c', 'router/src/server.rs']);
    assert.deepEqual(m.present.map((p) => p.file), ['src/key.cpp', 'src/secp256k1/src/secp256k1.c', 'router/src/server.rs']);
    assert.deepEqual(m.absent, ['missing.go']);
  });
  it('agreement runs both ways and tolerates empty sets', () => {
    const a = agreement(['MakeNewKey', 'Check', 'Other'], ['makenewkey', 'GetStrongRandBytes']);
    assert.deepEqual([a.ce, a.key, a.hit, a.agreement, a.precision, a.matched], [3, 2, 1, 0.5, 0.33, ['makenewkey']]);
    assert.deepEqual([agreement([], ['x']).agreement, agreement(['x'], []).agreement, agreement(['x'], []).precision], [0, null, 0]);
  });
});

describe('CodeExam\'s outputs', () => {
  it('parseTargets reads file@symbol lines past the provenance block and annotations', () => {
    const t = parseTargets('# engine: claude\n# index: .x\n\nsrc/key.cpp@CKey::MakeNewKey  Runs-found: 3/3\nsrc/random.cpp@GetStrongRandBytes\n\nnot a target\n');
    assert.deepEqual(t.map((x) => [x.file, x.symbol]), [['src/key.cpp', 'CKey::MakeNewKey'], ['src/random.cpp', 'GetStrongRandBytes']]);
  });
  it('parseVerdicts collects every file@symbol citation wherever the JSON puts it, with the element it sits under', () => {
    const v = parseVerdicts({ elements: [{ element: 1, text: 'generating a key', evidence: 'see src/key.cpp@MakeNewKey lines 10-20' }], targetGroups: [{ file: 'src/random.cpp', symbol: 'GetStrongRandBytes', verdicts: [{ element: 2, verdict: 'PRESENT' }] }], note: 'nothing@here' });
    assert.deepEqual(v.map((x) => [x.file, x.symbol, x.elements]), [['src/key.cpp', 'MakeNewKey', ['1']], ['src/random.cpp', 'GetStrongRandBytes', ['2']]]);
  });
});

describe('tier 0: a rule over symbol names', () => {
  it('claim words drop the claim\'s own vocabulary; symbol words split camelCase and underscores', () => {
    assert.deepEqual([...claimWords('A method of generating a digital signature of a message, the method comprising: by operation of a cryptographic module')].sort(), ['cryptograph', 'digit', 'messag', 'modul', 'signatur']);
    assert.deepEqual([...symbolWords('secp256k1_ecdsa_sign_recoverable')].sort(), ['ecdsa', 'recoverabl', 'secp256k1', 'sign']);
    assert.deepEqual([...symbolWords('GetStrongRandBytes')].sort(), ['byt', 'get', 'rand', 'strong']);
  });
  it('ranks the symbols sharing the claim\'s rarer words first; "sign" is not "signature" to a name rule', () => {
    const by = { 'src/sign.c': ['secp256k1_ecdsa_sign', 'secp256k1_ecdsa_signature_serialize', 'secp256k1_ecdsa_signature_parse', 'strlen'], 'src/hash.c': ['sha256_message_digest', 'memcpy'] };
    const r = tier0Rank('A method of serializing a digital signature of a message using a cryptographic hash', by, { top: 3 });
    assert.equal(r[0].symbol, 'secp256k1_ecdsa_signature_serialize', JSON.stringify(r));
    assert.deepEqual(r[0].words.sort(), ['serializ', 'signatur']);
    assert.ok(r.every((x) => x.symbol !== 'strlen' && x.symbol !== 'memcpy' && x.symbol !== 'secp256k1_ecdsa_sign'));
    assert.deepEqual(tier0Rank('the and of', by), []);
  });
});

describe('the manifest and the page', () => {
  const picks = JSON.parse(fs.readFileSync(new URL('./fixtures/recap-chart-agreement-candidates.json', import.meta.url), 'utf8'));
  it('the committed picks validate; a bad pick is named; a Solidity repository asks for .sol at build', () => {
    assert.deepEqual(validatePicks(picks), []);
    assert.equal(picks.candidates.length, 14);
    assert.deepEqual(picks.candidates.flatMap((c) => c.repos).filter((r) => r.addExtensions).map((r) => r.repo).sort(), ['dss', 'dstoken', 'evm-cctp-contracts']);
    assert.deepEqual(indexArgs({ tree: 't', addExtensions: '.sol' }, 'i'), ['--build-index', 't', '--index-path', 'i', '--add-extensions', '.sol']);
    assert.deepEqual(indexArgs({ tree: 't' }, 'i'), ['--build-index', 't', '--index-path', 'i']);
    assert.deepEqual(validatePicks({ candidates: [{ id: 'x', docId: 'no', patent: '8,190,610', claims: [], repos: [], dateFiled: '2023' }] }).length, 5);
    assert.deepEqual(validatePicks({}), ['no candidates']);
  });
  it('buildManifest unions every name the catalog lists for the document and keeps the fine links and the chart rows', () => {
    const catalog = [{ docId: 1, pdfUrl: 'https://s/a.pdf', citations: [{ granularity: 'file', org: 'o', repo: 'r', path: 'src/a.c', ref: 'main' }, { granularity: 'repo', org: 'o', repo: 'r' }],
      code: { functions: [{ name: 'top_fn' }], files: [{ name: 'a.c' }], rows: [{ label: '1[a]', claim: '1', limitation: 'lim', source: 'patent', functions: ['row_fn', 'top_fn'], files: [] }, { label: '1[b]', claim: '1', functions: [], files: [] }], paragraphs: [{ n: 5, functions: ['para_fn'], files: ['b.h'] }] } }];
    const m = buildManifest({ candidates: [{ id: 'x', docId: 1, patent: '1234567', claims: [1], repos: [{ org: 'o', repo: 'r', ref: null }], dateFiled: '2020-01-01' }, { id: 'y', docId: 2, patent: '1234568', claims: [1], repos: [{ org: 'o', repo: 'r' }], dateFiled: '2020-01-01' }] }, catalog);
    assert.deepEqual(m.candidates[0].key.functions, ['top_fn', 'row_fn', 'para_fn']);
    assert.deepEqual(m.candidates[0].key.files, ['a.c', 'b.h']);
    assert.deepEqual(m.candidates[0].key.links.map((l) => l.path), ['src/a.c']);
    assert.deepEqual(m.candidates[0].rows.map((r) => r.label), ['1[a]'], 'a row with no names is not a scoring row');
    assert.equal(m.candidates[1].key, null); assert.equal(m.candidates[1].missing, 'not in the catalog');
  });
  it('renderAgreement writes the reach table and the tier table, and replaceSection swaps the page block', () => {
    const md = renderAgreement([
      { id: 'mara-1-11', repo: 'bitcoin/bitcoin', ref: 'abcdef0123', tier: 'reach', symbols: 50000, functionsCited: 13, functionsPresent: 11, filesCited: 1, filesPresent: 1, absent: ['nope', 'nada'] },
      { id: 'mara-1-11', repo: 'bitcoin/bitcoin', claim: 1, tier: 'tier1', mode: 'blind', ce: 12, key: 11, hit: 4, agreement: 0.36, precision: 0.33, matched: ['makenewkey'] },
      { id: 'mara-1-11', repo: 'bitcoin/bitcoin', claim: 1, tier: 'tier2', mode: 'per-element', skipped: 'no model or key (see log)', ce: 0, key: 11, hit: 0, agreement: 0, precision: null, matched: [] },
    ], { generatedAt: '2026-10-21' });
    assert.match(md, /\| mara-1-11 \| bitcoin\/bitcoin @ abcdef0 \| 50000 \| 11 \/ 13 \| 1 \/ 1 \| nope, nada \|/);
    assert.match(md, /\| mara-1-11 \| 1 \| tier1 \| blind \| 12 \| 11 \| 4 \| 0\.36 \| 0\.33 \| makenewkey \|/);
    assert.match(md, /\| tier2 \| per-element \| no model or key \(see log\) \| 11 \| 0 \| 0\.00 \| — \|/);
    const page = `# T\n\n${AGREEMENT_START}\nold\n${AGREEMENT_END}\n\nafter\n`;
    assert.ok(replaceSection(page, 'NEW').includes(`${AGREEMENT_START}\nNEW\n${AGREEMENT_END}`));
    assert.throws(() => replaceSection('none', 'x'), /markers/);
  });
  it('rollup scores a multi-repository candidate on the union: a name reachable in any repository, every pick across them', () => {
    const recs = [
      { id: 'vm', repo: 'a/sdk', tier: 'reach', symbols: 10, functionsCited: 6, functionsPresent: 3, filesCited: 5, filesPresent: 2, present: ['bridgeUSDC', 'wait'], presentNames: ['bridgeUSDC', 'depositTx.wait', 'approveTx.wait'], absent: ['fetchSeed', 'x', 'y'] },
      { id: 'vm', repo: 'b/cctp', tier: 'reach', symbols: 3, functionsCited: 6, functionsPresent: 1, filesCited: 5, filesPresent: 0, present: ['fetchSeed'], presentNames: ['fetchSeed'], absent: ['bridgeUSDC', 'depositTx.wait', 'approveTx.wait', 'x', 'y'] },
      { id: 'vm', repo: 'a/sdk', claim: 1, tier: 'tier0', mode: 'rule', ce: 2, key: 2, hit: 1, agreement: 0.5, precision: 0.5, matched: ['wait'], chosen: ['x.js@wait', 'x.js@other'], keyNames: ['bridgeusdc', 'wait'] },
      { id: 'vm', repo: 'b/cctp', claim: 1, tier: 'tier0', mode: 'rule', ce: 1, key: 0, hit: 0, agreement: null, precision: 0, matched: [], chosen: ['c.sol@bridgeUSDC'], keyNames: [] },
      { id: 'solo', repo: 'o/r', claim: 1, tier: 'tier0', mode: 'rule', ce: 1, key: 1, hit: 0, agreement: 0, precision: 0, matched: [], chosen: [], keyNames: ['z'] },
    ];
    const u = rollup(recs);
    assert.deepEqual(u.map((r) => [r.id, r.repo, r.tier]), [['vm', 'all', 'reach'], ['vm', 'all', 'tier0']]);
    assert.deepEqual([u[0].functionsPresent, u[0].functionsCited, u[0].absent], [4, 6, ['x', 'y']], 'counted by the litigant\'s names, reachable in any repository');
    assert.deepEqual([u[1].ce, u[1].key, u[1].hit, u[1].agreement, u[1].precision], [3, 2, 2, 1, 0.67]);
    assert.match(renderAgreement(u), /\| vm \| all repositories \| 13 \| 4 \/ 6 \|/);
  });
  it('parseArgs: steps are checked, --only splits, --blind is one of three', () => {
    const o = parseArgs(['--picks', 'p', '--work', 'w', '--steps', 'reach,tier0', '--only', 'a,b', '--blind', 'on', '--runs', '3']);
    assert.deepEqual([o.steps, o.only, o.blind, o.runs], [['reach', 'tier0'], ['a', 'b'], 'on', 3]);
    assert.throws(() => parseArgs(['--steps', 'fly']), /unknown step/);
    assert.throws(() => parseArgs(['--blind', 'maybe']), /--blind/);
  });
});
