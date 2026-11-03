// test_ceiling_to_loop.js — the ceiling-to-loop adapter: selection, merge, control pairing, files.
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// No model, no network: a tiny work directory is built in a temp folder (two filings, three
// drafted groups, one control filing in the same repository) and the adapter is run over it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  selectRecords, pickClaim, mergeGroups, controlIndexFor, loopCommand, formatCommand, buildPlan, writeInputs, indexDirOf,
} from '../scripts/ceiling-to-loop.mjs';

function sidecar(label, methodClaim, systemClaim) {
  const mk = (n, cls, claim) => ({
    n, groupN: 1, label: `${label} [${cls}]`, claim, class: cls,
    elements: claim.split(':')[1].split(';').map((s) => s.trim()),
    dependents: [{ n: 2, text: `The ${cls} of claim 1, wherein the limb count is ten.`, facets: 1 }],
    grounded: [{ file: 'src/field.h', func: `fe_${cls}_normalize`, start: 1, end: 9, kind: 'func', element: 'normalizing', elementIndex: 1 }],
  });
  return { format: 'ce-pseudo-claim-anchors', version: 1, claims: [mk(1, 'method', methodClaim), mk(2, 'system', systemClaim)] };
}

function buildWork() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-c2l-'));
  const repoA = { org: 'bitcoin-core', repo: 'secp256k1', resolvedRef: 'abcdef0123456789' };
  const repoB = { org: 'solana-labs', repo: 'solana', resolvedRef: '1234567deadbeef' };
  const repoA2 = { org: 'bitcoin-core', repo: 'secp256k1', resolvedRef: 'fedcba9876543210' };
  const manifest = {
    candidates: [
      { id: 'f-1', patent: '1', claims: [1], repos: [repoA] },
      { id: 'f-2', patent: '2', claims: [1], repos: [repoA2] },
      { id: 'v-1', patent: '3', claims: [1], repos: [repoB] },
    ],
  };
  for (const r of [repoA, repoB, repoA2]) fs.mkdirSync(indexDirOf(work, r), { recursive: true });
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest));
  const rec = (id, repo, rank, label, read, readStrict, controlId, pseudoClass, tag = 't') => ({
    id, repo, seed: 'codeexam', tag, claim: 1, group: { rank, label, priority: 3 }, read, readStrict,
    compare: { controlId, pseudoClass },
  });
  const records = [
    rec('f-1', 'bitcoin-core/secp256k1', 1, 'scalar', 'finding', 'indistinguishable from the control', 'f-2', 'method'),
    rec('f-1', 'bitcoin-core/secp256k1', 2, 'field', 'indistinguishable from the control', 'indistinguishable from the control', 'f-2', 'method'),
    rec('f-1', 'bitcoin-core/secp256k1', 3, 'gej', 'finding', 'finding', 'f-2', 'method'),
    rec('v-1', 'solana-labs/solana', 1, 'shred', 'finding', 'indistinguishable from the control', 'f-1', 'system'),
    { ...rec('v-1', 'solana-labs/solana', 2, 'vote', 'finding', 'finding', 'f-1', 'system'), tag: undefined }, // the untagged 10/25 twin
    { id: 'd-1', repo: 'apache/spark', seed: 'codeexam', tag: 't', group: null, reason: 'ranking refused' },
  ];
  fs.writeFileSync(path.join(work, 'ceiling.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const put = (id, repo, rank, label) => {
    const dir = path.join(work, 'ceiling', id, repo.replace('/', '__'), 'ce-seeded-t');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `group-${rank}-pseudo.txt.anchors.json`), JSON.stringify(sidecar(label,
      `A method for ${label} comprising: receiving a value; normalizing the value; and storing the value.`,
      `A system for ${label} comprising: a memory storing a value; and a processor configured to normalize the value.`)));
  };
  put('f-1', 'bitcoin-core/secp256k1', 1, 'scalar'); put('f-1', 'bitcoin-core/secp256k1', 2, 'field'); put('f-1', 'bitcoin-core/secp256k1', 3, 'gej');
  put('v-1', 'solana-labs/solana', 1, 'shred');
  return { work, records, manifest, repoA, repoB, repoA2 };
}

describe('selectRecords: tagged, drafted, by read and by filing', () => {
  const { records } = buildWork();
  it('finding takes the plain-read findings; strict the strict ones; all every drafted group', () => {
    assert.deepEqual(selectRecords(records, { tag: 't', read: 'finding' }).map((r) => `${r.id}#${r.group.rank}`), ['f-1#1', 'f-1#3', 'v-1#1']);
    assert.deepEqual(selectRecords(records, { tag: 't', read: 'strict' }).map((r) => `${r.id}#${r.group.rank}`), ['f-1#3']);
    assert.deepEqual(selectRecords(records, { tag: 't', read: 'all' }).map((r) => `${r.id}#${r.group.rank}`), ['f-1#1', 'f-1#2', 'f-1#3', 'v-1#1']);
  });
  it('--only narrows to the named filings; an untagged twin and a not-run row never qualify', () => {
    assert.deepEqual(selectRecords(records, { tag: 't', read: 'all', only: ['v-1'] }).map((r) => r.id), ['v-1']);
    assert.throws(() => selectRecords(records, { tag: 't', read: 'loose' }), /--read must be one of/);
  });
});

describe('pickClaim and mergeGroups: the judged class, renumbered with the answer key carried', () => {
  const { records, work } = buildWork();
  const load = (id, repo, rank) => JSON.parse(fs.readFileSync(path.join(work, 'ceiling', id, repo.replace('/', '__'), 'ce-seeded-t', `group-${rank}-pseudo.txt.anchors.json`), 'utf8'));
  it('asserted picks the class the ceiling judged; method and system pick by name', () => {
    const sc = load('v-1', 'solana-labs/solana', 1);
    const rec = records.find((r) => r.id === 'v-1' && r.group && r.group.rank === 1);
    assert.equal(pickClaim(sc, 'asserted', rec).class, 'system');
    assert.equal(pickClaim(sc, 'method', rec).class, 'method');
    assert.equal(pickClaim(sc, 'system', rec).class, 'system');
  });
  it('merges in rank order, renumbers 1..K, keeps rank, read, dependents and grounded anchors', () => {
    const r1 = records.find((r) => r.id === 'f-1' && r.group && r.group.rank === 1);
    const r3 = records.find((r) => r.id === 'f-1' && r.group && r.group.rank === 3);
    const entries = [
      { record: r3, claim: pickClaim(load('f-1', 'bitcoin-core/secp256k1', 3), 'asserted', r3), sidecarPath: 'g3' },
      { record: r1, claim: pickClaim(load('f-1', 'bitcoin-core/secp256k1', 1), 'asserted', r1), sidecarPath: 'g1' },
    ];
    const m = mergeGroups(entries);
    assert.deepEqual(m.claims.map((c) => c.n), [1, 2]);
    assert.deepEqual(m.claims.map((c) => c.source.rank), [1, 3]);
    assert.match(m.claims[0].label, /^codeexam 1: scalar \[method\] — ceiling finding$/);
    assert.equal(m.claims[1].source.sidecar, 'g3');
    assert.equal(m.claims[0].grounded[0].func, 'fe_method_normalize');
    assert.equal(m.claims[0].dependents.length, 1);
    assert.deepEqual(m.numbered, [
      '1. A method for scalar comprising: receiving a value; normalizing the value; and storing the value.',
      '2. A method for gej comprising: receiving a value; normalizing the value; and storing the value.',
    ]);
  });
});

describe('controlIndexFor: the ceiling pairing carried over, the same-repository case named', () => {
  const { records, manifest, work, repoA, repoA2 } = buildWork();
  it('a control filing in another repository gives its index', () => {
    const rec = records.find((r) => r.id === 'v-1' && r.group && r.group.rank === 1);
    const c = controlIndexFor({ record: rec, manifest, work });
    assert.equal(c.index, indexDirOf(work, repoA));
    assert.equal(c.via, 'f-1');
    assert.equal(c.note, null);
  });
  it('a control filing in the same repository is no control: omitted with a note, or the fallback', () => {
    const rec = records.find((r) => r.id === 'f-1' && r.group && r.group.rank === 1);
    const none = controlIndexFor({ record: rec, manifest, work });
    assert.equal(none.index, null);
    assert.match(none.note, /same repository as bitcoin-core\/secp256k1/);
    const fb = controlIndexFor({ record: rec, manifest, work, fallback: 'solana-labs/solana' });
    assert.match(fb.index, /solana-labs__solana__1234567$/);
    assert.match(fb.via, /fallback solana-labs\/solana \(v-1\)/);
    const bad = controlIndexFor({ record: rec, manifest, work, fallback: 'nobody/nothing' });
    assert.equal(bad.index, null);
    assert.match(bad.note, /no index for the fallback/);
    assert.notEqual(indexDirOf(work, repoA), indexDirOf(work, repoA2));
  });
});

describe('loopCommand and buildPlan: the loop invocation per repository, and the files', () => {
  it('the command names the numbered file, the source, the index, the control and the engines', () => {
    const argv = loopCommand({ numbered: '/o/x_numbered.txt', claimsOnly: '/o/x_claims.txt', index: '/w/indexes/a', control: '/w/indexes/b' });
    assert.match(argv[0], /pseudo-claim-loop\.mjs$/);
    assert.deepEqual(argv.slice(1), ['--claims', '/o/x_numbered.txt', '--source', '/o/x_claims.txt', '--index', '/w/indexes/a', '--control', '/w/indexes/b', '--llm', 'claude', '--syn-llm', 'chatgpt']);
    const local = loopCommand({ numbered: 'n', claimsOnly: 'c', index: 'i', control: null, model: 'm.gguf' });
    assert.ok(local.includes('--model') && !local.includes('--control') && !local.includes('--llm'));
    assert.match(formatCommand(['a b', 'c']), /^node "a b" c$/);
  });
  it('buildPlan groups the chosen records per filing and repository and counts the charts', () => {
    const { work } = buildWork();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-c2l-out-'));
    const { plan, skipped } = buildPlan({ work, tag: 't', out, read: 'finding', controlFallback: 'solana-labs/solana' });
    assert.deepEqual(plan.map((e) => `${e.id}|${e.repo}|${e.merged.claims.length}|${e.charts}`), ['f-1|bitcoin-core/secp256k1|2|6', 'v-1|solana-labs/solana|1|3']);
    assert.equal(skipped.length, 0);
    assert.match(plan[0].files.numbered, /f-1__bitcoin-core__secp256k1_numbered\.txt$/);
    assert.match(plan[0].control.index, /solana-labs__solana__1234567$/);
    assert.match(plan[1].control.index, /bitcoin-core__secp256k1__abcdef0$/);
    assert.throws(() => buildPlan({ work, tag: 't', out, cls: 'apparatus' }), /--class must be one of/);
    const noFallback = buildPlan({ work, tag: 't', out, read: 'finding' });
    assert.equal(noFallback.plan[0].control.index, null);
    assert.equal(noFallback.plan[0].charts, 4);
  });
  it('writeInputs writes the claims-only file with a header, the sidecar the loop reads, and the numbered file', () => {
    const { work } = buildWork();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-c2l-out-'));
    const { plan } = buildPlan({ work, tag: 't', out, read: 'all', only: ['f-1'] });
    const files = writeInputs(plan[0], { tag: 't', read: 'all', cls: 'asserted' });
    const claimsOnly = fs.readFileSync(files.claimsOnly, 'utf8').split('\n');
    assert.match(claimsOnly[0], /NOT legal analysis/);
    assert.equal(claimsOnly.filter((l) => l && !l.startsWith('#')).length, 3);
    const sc = JSON.parse(fs.readFileSync(files.sidecar, 'utf8'));
    assert.equal(sc.format, 'ce-pseudo-claim-anchors');
    assert.deepEqual(sc.claims.map((c) => c.n), [1, 2, 3]);
    assert.equal(sc.claims[1].source.rank, 2);
    assert.equal(sc.claims[2].grounded.length, 1);
    const numbered = fs.readFileSync(files.numbered, 'utf8').trim().split('\n');
    assert.equal(numbered.length, 3);
    assert.match(numbered[2], /^3\. A method for gej comprising/);
    // the loop maps *_pseudo.txt to *_claims.txt and reads <source>.anchors.json: the names line up
    assert.equal(files.sidecar, `${files.claimsOnly}.anchors.json`);
    assert.match(files.claimsOnly, /_claims\.txt$/);
  });
});
