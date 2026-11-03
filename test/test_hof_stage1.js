// test_hof_stage1.js — hof-stage1 script: group records from cand.lst, BM25 and overlap ranking, the control, the report, unreadable runs reported not thrown
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// issue-359-hof-stage1-feasibility-check (2026-11-03). No fixture here encodes
// an expected answer about any real index: the three-group fixture is shaped
// so the right group ranks first when the claim's words are the group's names,
// which is the one property the harness must have to be trusted on real runs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseOwnArgs, listRunDirs, purposeText, textStems, identStems, parseMemberLine,
  groupRecord, commentsAndStrings, buildBm25, buildOverlap, rankOf, topOf,
  readSidecarClaims, findDrafted, scoreRun, scoreClaims, summarize, poolRuns, renderMarkdown, renderRecords,
} from '../scripts/hof-stage1.mjs';
import { parseCandidateGroups } from '../scripts/hof.mjs';

const CAND = [
  '# mechanism-grouper  index=.fixture  group-by=multi  3 groups (>= 3 fns)',
  '# split: tls (something) (9 fns) → 2 sub-group(s)',
  '# handshake (perform_handshake)  (3 fns)  — negotiates the TLS session: hello, key exchange, finished',
  'src/tls/handshake.c@perform_handshake',
  'src/tls/handshake.c@send_client_hello',
  'src/tls/keys.c@derive_session_keys',
  '# [class] WndProc  (3 fns)  — THIS CODE AND INFORMATION IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. Copyright (c) Microsoft Corporation. All rights reserved.',
  'samples/win/app.cpp@CALLBACK App::WndProc',
  'samples/win/app.cpp@App::OnPaint',
  'samples/win/app.cpp@App::OnResize',
  '# [file] parser.js / rest  (3 fns)  — the remainder of parser.js after other seeds took 2 of its 5 functions (draft what these functions do; the module\'s purpose belongs to its other groups): tokenizeExpression, parseStatement, buildSyntaxTree',
  'src/parser.js@tokenizeExpression',
  'src/parser.js@parseStatement',
  'src/parser.js@buildSyntaxTree',
].join('\n');

const SIDECAR = {
  format: 'ce-pseudo-claims-anchors', claims: [
    { n: 1, groupN: 1, label: 'handshake (perform_handshake)', claim: 'A method of negotiating a session, comprising: sending a client hello; deriving session keys from the key exchange; and completing the handshake with a finished message.', elements: ['sending a client hello', 'deriving session keys from the key exchange', 'completing the handshake with a finished message'], grounded: [] },
    { n: 2, groupN: 3, label: '[file] parser.js / rest', claim: 'A method of parsing source text, comprising: tokenizing an expression; parsing a statement from the tokens; and building a syntax tree from the parsed statements.', elements: ['tokenizing an expression', 'parsing a statement from the tokens', 'building a syntax tree'], grounded: [] },
  ],
};

function fixtureRecords() {
  return parseCandidateGroups(CAND).map((g) => groupRecord(g));
}

describe('hof-stage1: arguments', () => {
  it('needs --hof or --hof-root, rejects unknown options and a bad scorer', () => {
    assert.throws(() => parseOwnArgs([]), /--hof <dir> or --hof-root/);
    assert.throws(() => parseOwnArgs(['--hof', 'x', '--bogus']), /unknown option: --bogus/);
    assert.throws(() => parseOwnArgs(['--hof', 'x', '--scorer', 'cosine']), /--scorer must be bm25 or overlap/);
    assert.throws(() => parseOwnArgs(['--hof', 'a,b', '--index-path', 'idx']), /exactly one --hof/);
    assert.throws(() => parseOwnArgs(['--hof', 'x', '--b', '2']), /--b needs a number from 0 to 1/);
    const o = parseOwnArgs(['--hof', 'a, b', '--top', '3', '--b', '0.3']);
    assert.deepEqual(o.hof, ['a', 'b']);
    assert.equal(o.top, 3);
    assert.equal(o.scorer, 'bm25');
    assert.equal(o.b, 0.3);
    assert.equal(parseOwnArgs(['--hof', 'x']).b, 0.75);
  });
  it('--hof-root takes an optional value and defaults to the CodeExam hof folder', () => {
    assert.equal(parseOwnArgs(['--hof-root', 'C:/runs']).hofRoot, 'C:/runs');
    const o = parseOwnArgs(['--hof-root', '--top', '2']);
    assert.match(o.hofRoot, /CodeExam[\\/]hof$/);
  });
});

describe('hof-stage1: group records', () => {
  it('strips the residue template and license sentences from a purpose', () => {
    assert.equal(purposeText('the remainder of parser.js after other seeds took 2 of its 5 functions (draft what these functions do; the module\'s purpose belongs to its other groups): tokenizeExpression, parseStatement'), 'tokenizeExpression, parseStatement');
    assert.equal(purposeText('THIS CODE IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND. Copyright (c) Microsoft. Draws the window.'), 'Draws the window.');
    assert.equal(purposeText('claim-chart.js — builds claim charts; see LICENSE. ======================== Merges rows across targets.'), 'claim-chart.js — builds claim charts; Merges rows across targets.');
  });
  it('splits identifiers the way CodeExam does and stems both sides alike', () => {
    assert.deepEqual(identStems('CControl::ThreadFunction'), ['contro', 'thread', 'functi']);
    assert.deepEqual(identStems('perform_handshake'), ['perfor', 'handsh']);
    assert.ok(textStems('performing the handshake').includes('handsh'));
    assert.deepEqual(parseMemberLine('samples/win/app.cpp@CALLBACK App::WndProc'), { file: 'samples/win/app.cpp', name: 'CALLBACK App::WndProc' });
    assert.deepEqual(parseMemberLine('src/a.py@L10-20'), { file: 'src/a.py', name: '' });
  });
  it('builds one record per group with label, purpose, member and file stems', () => {
    const recs = fixtureRecords();
    assert.equal(recs.length, 3);
    assert.equal(recs[0].label, 'handshake (perform_handshake)');
    assert.equal(recs[0].members, 3);
    assert.equal(recs[0].files, 2);
    assert.ok(recs[0].tokens.includes('handsh'));
    assert.ok(recs[0].tokens.includes('sessio'));     // from the purpose
    assert.ok(recs[0].tokens.includes('key'));        // from keys.c and derive_session_keys
    assert.equal(recs[1].purpose, '');                // license-only purpose dropped
    assert.ok(recs[1].tokens.includes('wnd'));
    assert.ok(recs[1].tokens.includes('paint'));
    assert.ok(!recs[2].tokens.includes('remain'));    // residue template gone
    assert.ok(recs[2].tokens.includes('syntax'));
  });
  it('the body variant adds comments and string literals from the index', () => {
    const bodyOf = (file, name) => (name === 'perform_handshake' ? 'int perform_handshake(void) {\n  // negotiate the cipher suite with the peer\n  log("renegotiation requested");\n  return 0;\n}' : null);
    const recs = parseCandidateGroups(CAND).map((g) => groupRecord(g, { bodyOf }));
    assert.ok(recs[0].bodyTokens > 0);
    assert.ok(recs[0].tokens.includes('cipher'));
    assert.ok(recs[0].tokens.includes('renego'));
    assert.equal(recs[2].bodyTokens, 0);
    assert.equal(commentsAndStrings('x = 1; # count\ns = "a b"'), '# count "a b"');
  });
});

describe('hof-stage1: scoring', () => {
  it('BM25 ranks the drafted group first when the claim speaks its names', () => {
    const recs = fixtureRecords();
    const claims = readSidecarClaims(SIDECAR);
    const run = scoreClaims({ records: recs, claims, scorer: 'bm25' });
    assert.equal(run.groups, 3);
    assert.equal(run.claims[0].drafted, 0);
    assert.equal(run.claims[0].rank, 1);
    assert.equal(run.claims[0].members, 3);
    assert.equal(run.b, 0.75);
    assert.equal(scoreClaims({ records: recs, claims, scorer: 'bm25', b: 0 }).claims[0].rank, 1);
    assert.equal(run.claims[1].drafted, 2);
    assert.equal(run.claims[1].rank, 1);
    assert.ok(run.claims[0].elementBest === 1);
    assert.equal(run.claims[0].top[0].i, 0);
  });
  it('the control scores the group under another claim\'s text and ranks it lower or not at all', () => {
    const run = scoreClaims({ records: fixtureRecords(), claims: readSidecarClaims(SIDECAR) });
    assert.equal(run.claims[0].control.from, 2);
    assert.ok(run.claims[0].control.rank == null || run.claims[0].control.rank > 1);
    assert.equal(run.claims[1].control.from, 1);
  });
  it('overlap agrees on the fixture, and a zero score is "not reached", not rank 1', () => {
    const run = scoreClaims({ records: fixtureRecords(), claims: readSidecarClaims(SIDECAR), scorer: 'overlap' });
    assert.equal(run.claims[0].rank, 1);
    assert.equal(run.claims[1].rank, 1);
    assert.deepEqual(rankOf(new Float64Array([0, 0, 0]), 1), { rank: null, ties: 0, score: 0 });
    assert.deepEqual(rankOf(new Float64Array([2, 1, 2]), 1), { rank: 3, ties: 0, score: 1 });
    assert.deepEqual(rankOf(new Float64Array([2, 2, 1]), 1), { rank: 1, ties: 1, score: 2 });
    assert.deepEqual(topOf(new Float64Array([0, 3, 1]), fixtureRecords(), 5).map((t) => t.i), [1, 2]);
  });
  it('finds the drafted group by label, then by groupN, else reports it', () => {
    const recs = fixtureRecords();
    assert.equal(findDrafted({ label: 'handshake (perform_handshake)' }, recs), 0);
    assert.equal(findDrafted({ label: '[FILE] parser.js / rest' }, recs), 2);
    assert.equal(findDrafted({ label: 'no such group', groupN: 2 }, recs), 1);
    assert.equal(findDrafted({ label: 'no such group' }, recs), -1);
    const run = scoreClaims({ records: recs, claims: [{ n: 9, label: 'no such group', claim: 'x', elements: [] }] });
    assert.equal(run.claims[0].error, 'drafted group not found in cand.lst');
  });
  it('pools hits@k, MRR and median, leaving unreached ranks out of the median', () => {
    const s = summarize([1, 3, null, 25]);
    assert.equal(s.claims, 4);
    assert.equal(s.reached, 3);
    assert.equal(s['hits@1'], 1);
    assert.equal(s['hits@5'], 2);
    assert.equal(s['hits@20'], 2);
    assert.equal(s.median, 3);
    assert.ok(Math.abs(s.mrr - (1 + 1 / 3 + 0 + 1 / 25) / 4) < 1e-9);
    const pooled = poolRuns([{ error: 'x' }, scoreClaims({ records: fixtureRecords(), claims: readSidecarClaims(SIDECAR) })]);
    assert.equal(pooled.runs, 1);
    assert.equal(pooled.errors, 1);
    assert.equal(pooled.whole.claims, 2);
  });
});

describe('hof-stage1: runs and report', () => {
  it('scores a run directory, and reports a missing sidecar or list instead of throwing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hof-stage1-'));
    try {
      assert.match(scoreRun(dir).error, /no cand.lst/);
      fs.writeFileSync(path.join(dir, 'cand.lst'), CAND);
      assert.match(scoreRun(dir).error, /no claims.txt.anchors.json/);
      fs.writeFileSync(path.join(dir, 'claims.txt.anchors.json'), '{not json');
      assert.match(scoreRun(dir).error, /sidecar unreadable/);
      fs.writeFileSync(path.join(dir, 'claims.txt.anchors.json'), JSON.stringify(SIDECAR));
      const run = scoreRun(dir);
      assert.equal(run.error, undefined);
      assert.equal(run.index, '.fixture');
      assert.equal(run.variant, 'tier0');
      assert.equal(run.claims[0].rank, 1);
      assert.equal(run.recordsFile, undefined);
      assert.deepEqual(listRunDirs(path.dirname(dir)).includes(dir), true);
      const recDir = path.join(dir, 'records');
      const withRecords = scoreRun(dir, { recordsOut: recDir });
      assert.equal(withRecords.recordsFile, path.join(recDir, 'fixture_records.md'));
      const listed = fs.readFileSync(withRecords.recordsFile, 'utf8');
      assert.match(listed, /^# \.fixture: the 3 mechanism records scored by hof-stage1 \(tier0\)/);
      assert.match(listed, /\| 1 \| handshake \(perform_handshake\) \| 3 \| 2 \| \d+ \| negotiates the TLS session: hello, key exchange, finished \|/);
      assert.match(listed, /\| 2 \| \[class\] WndProc \| 3 \| 1 \| \d+ \|  \|/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it('renders the mechanism list in the grouper\'s order with the cleaned purpose', () => {
    const md = renderRecords('.fixture', fixtureRecords());
    const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    assert.equal(rows.length, 3);
    assert.match(rows[2], /^\| 3 \| \[file\] parser\.js \/ rest \| 3 \| 1 \| \d+ \| tokenizeExpression, parseStatement, buildSyntaxTree \|$/);
    assert.match(md, /\| # \| mechanism \| members \| files \| stems \| purpose \|/);
  });
  it('renders the per-claim table, the pooled rows and the detail', () => {
    const runs = [scoreClaims({ dir: 'd', index: '.fixture', records: fixtureRecords(), claims: readSidecarClaims(SIDECAR) }), { dir: 'broken', error: 'no cand.lst in broken' }];
    const md = renderMarkdown({ format: 'ce-hof-stage1', generated: 'now', scorer: 'bm25', b: 0.75, variant: 'tier0', runs, pooled: poolRuns(runs) });
    assert.match(md, /\| run \| n \| drafted group \| members \| groups \| rank \| ties \| best element \| control \|/);
    assert.match(md, /\| \.fixture \| 1 \| handshake \(perform_handshake\) \| 3 \| 3 \| 1 \|/);
    assert.match(md, /scorer bm25 \(b 0\.75\)/);
    assert.match(md, /\*\(no cand.lst in broken\)\*/);
    assert.match(md, /\| whole claim \| 2 \| 2 \(100%\)/);
    assert.match(md, /\| control \(another claim\) \| 2 \|/);
    assert.match(md, /necessary for a mechanisms index and not sufficient/);
    assert.match(md, /← drafted/);
  });
});
