// test_hof.js — the HOF self-test: the parsers of CodeExam's public files, the ladder, the report, the run layout and the --hof command's preflight, plan and refusals
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// test_hof.js — hof-one-command (2026-11-03); hof-cli-command (2026-11-09).
//
// The model calls are the user's. What is tested is everything around them:
// the parsers that read CodeExam's public files (the candidates list, the
// --claims-only sidecar, the --targets-out file), the ladder that scores an
// anchor against the located targets, the command lines each step is the
// equivalent of (--min-rank 0 always, --rank only when asked, --form-rules
// passed through), the rank join with and without the sidecar's own
// `priority`, and, since the command, the run directory rule, the whole-run
// preflight's arithmetic and plan, the synonymize step through a stub engine,
// the report's footer, and two end-to-end runs that call no model: the plan
// on the demo index and the refusal on a .zip index. No fixture here encodes
// an expected answer about any real index.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildCommands, outPaths, modelArgs, echoLine, runStamp, runDirFor,
  readClaims, readTargets, parseTargetSpec, baseName,
  parseCandidateGroups, limitCandidates, parseSidecar, joinRank, candFromSidecarCommand,
  normName, enclosingClass, sameFunction, scoreClaim, totalsOf,
  renderTable, renderMarkdown, preflightCalls, planLines, CALL_SIZES, HOW_TO_READ, howToReadText, LADDER, WHERE,
  rowTag, LOCATE_PARSE_FAILURE, isLocateParseFailure, resultLine, lastLine,
} from '../src/core/hof.js';
import { parseOwnArgs, dryRunLines } from '../scripts/hof.mjs';
import { hofOptions, synonymizerArgs, synonymizeClaim, doHof } from '../src/commands/hof.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { synonymizeElements } from '../src/commands/synonymize.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CAND = [
  '# mechanism-grouper  index=demo  group-by=class  2 groups — RANKED by claude (observe-only)',
  '# handshake (2 fns)  [P3 mechanism/none — codebase-specific]',
  'src/tls/handshake.c@perform_handshake',
  'src/tls/cipher.py@CipherNegotiator::negotiate',
  '',
  '# cert chain (1 fns)  [P1 plumbing/none]',
  'src/tls/cert.py@CertificateValidator::verify_chain',
  '',
  '# coverage: 2 groups, 3 anchors',
  '',
].join('\n');

const SIDECAR = {
  format: 'ce-pseudo-claim-anchors', version: 1, ce: '1.2.3',
  command: 'ce --index-path .demo --pseudo-claims @cand.lst --llm claude --claims-only claims.txt --min-rank 0',
  claims: [
    {
      n: 1, groupN: 1, label: 'handshake', priority: 3,
      claim: 'A method of establishing a session, comprising: performing a handshake; and negotiating a cipher.',
      grounded: [
        { file: 'src/tls/handshake.c', func: 'perform_handshake', start: 1, end: 10, kind: 'func', element: 'a' },
        { file: 'src/tls/handshake.c', func: 'perform_handshake', start: 1, end: 10, kind: 'func', element: 'b' },
        { file: 'src/tls/cipher.py', func: 'CipherNegotiator::negotiate', start: 1, end: 5, kind: 'func', element: 'c' },
        { file: 'docs/README.md', func: '', start: 3, end: 9, kind: 'lines', element: 'd' },
      ],
    },
    {
      n: 2, groupN: 2, label: 'cert chain',
      claim: 'A system for verifying a certificate chain, comprising: a validator; and a channel.',
      grounded: [
        { file: 'src/tls/cert.py', func: 'CertificateValidator::verify_chain', start: 1, end: 5, kind: 'func', element: 'a' },
        { file: 'src/tls/channel.c', func: 'tls_send_encrypted', start: 1, end: 5, kind: 'func', element: 'b' },
      ],
    },
  ],
};

const TARGETS_1 = [
  '# Claim-locate: discovery mode, 1 run',
  '# Targets-checksum: 0123abcd',
  'handshake.c@perform_handshake',
  'cipher.py@CipherNegotiator',
  'other.c@unrelated_fn; handshake.c@helper_fn',
  '',
].join('\n');

const TARGETS_2 = [
  'cert.py@CertificateValidator::verify_chain',
  'cert.py@CertificateValidator::load',
  'channel.c@SecureChannel::send',
].join('\n');

describe('hof: reading CodeExam\'s public files', () => {
  it('readTargets skips provenance lines and splits on ";" as claim-chart does', () => {
    assert.deepEqual(readTargets(TARGETS_1), [
      'handshake.c@perform_handshake', 'cipher.py@CipherNegotiator', 'other.c@unrelated_fn', 'handshake.c@helper_fn',
    ]);
  });
  it('parseTargetSpec splits at the first "@" and keeps the basename', () => {
    assert.deepEqual(parseTargetSpec('handshake.c@perform_handshake'), { spec: 'handshake.c@perform_handshake', base: 'handshake.c', name: 'perform_handshake' });
    assert.deepEqual(parseTargetSpec('a/b/c.py@K::m'), { spec: 'a/b/c.py@K::m', base: 'c.py', name: 'K::m' });
    assert.equal(baseName('src\\tls\\handshake.c'), 'handshake.c');
    assert.equal(baseName('x.zip!src/tls/handshake.c'), 'handshake.c');
  });
  it('readClaims returns one claim per non-# line', () => {
    assert.deepEqual(readClaims('# ce-claims v1\nA method.\n\nA system.\n'), ['A method.', 'A system.']);
  });
  it('parseCandidateGroups counts only blocks that own anchors and reads the [P..] tag', () => {
    const g = parseCandidateGroups(CAND);
    assert.equal(g.length, 2, 'the provenance header and the coverage footer own no anchors');
    assert.equal(g[0].priority, 3);
    assert.equal(g[1].priority, 1);
    assert.deepEqual(g[0].lines, ['src/tls/handshake.c@perform_handshake', 'src/tls/cipher.py@CipherNegotiator::negotiate']);
    assert.equal(parseCandidateGroups('a.c@f\nb.c@g\n')[0].priority, null, 'an implicit first group is untagged');
    assert.equal(parseCandidateGroups('# plain label\na.c@f\n')[0].priority, null);
  });
  it('limitCandidates keeps the first n groups with their headers and leaves a shorter list alone', () => {
    const first = limitCandidates(CAND, 1);
    assert.match(first, /perform_handshake/);
    assert.match(first, /\[P3/);
    assert.doesNotMatch(first, /verify_chain/);
    assert.equal(parseCandidateGroups(first).length, 1);
    assert.equal(limitCandidates(CAND, 2), CAND);
    assert.equal(limitCandidates(CAND, 9), CAND);
  });
  it('parseSidecar deduplicates anchors to file@func and keeps the kind', () => {
    const c = parseSidecar(SIDECAR);
    assert.equal(c.length, 2);
    assert.equal(c[0].anchors.length, 3, 'the anchor cited by two elements is one anchor');
    assert.deepEqual(c[0].anchors.map((a) => `${a.base}@${a.func}`), ['handshake.c@perform_handshake', 'cipher.py@CipherNegotiator::negotiate', 'README.md@']);
    assert.equal(c[0].anchors[2].kind, 'lines');
    assert.equal(c[0].priority, 3);
    assert.equal(c[1].priority, null);
  });
  it('candFromSidecarCommand finds the candidates list the recorded command drafted from, near the claims file', () => {
    assert.equal(candFromSidecarCommand(SIDECAR, '/runs/x', (p) => p === path.join('/runs/x', 'cand.lst')), path.join('/runs/x', 'cand.lst'));
    assert.equal(candFromSidecarCommand(SIDECAR, '/runs/x', () => false), null);
    assert.equal(candFromSidecarCommand({ command: 'ce --pseudo-claims a.c@f' }, '/runs/x', () => true), null, 'no @list in the command');
  });
});

describe('hof: the rank join', () => {
  it('prefers the sidecar\'s own priority, falls back to the candidates list by groupN, else none', () => {
    const cand = parseCandidateGroups(CAND);
    const j = joinRank(parseSidecar(SIDECAR), cand);
    assert.equal(j[0].priority, 3); assert.equal(j[0].rankFrom, 'sidecar');
    assert.equal(j[1].priority, 1); assert.equal(j[1].rankFrom, 'cand.lst');
    const none = joinRank(parseSidecar(SIDECAR), null);
    assert.equal(none[1].priority, null); assert.equal(none[1].rankFrom, null);
  });
});

describe('hof: the ladder', () => {
  it('normalizes class qualifiers and matches the unqualified form of a method', () => {
    assert.equal(normName('A.b'), 'A::b');
    assert.equal(enclosingClass('CipherNegotiator::negotiate'), 'CipherNegotiator');
    assert.equal(enclosingClass('perform_handshake'), null);
    assert.ok(sameFunction('negotiate', 'CipherNegotiator::negotiate'));
    assert.ok(sameFunction('CipherNegotiator::negotiate', 'negotiate'));
    assert.ok(sameFunction('CipherNegotiator.negotiate', 'CipherNegotiator::negotiate'));
    assert.ok(!sameFunction('Other::negotiate', 'CipherNegotiator::negotiate'), 'two classes, same method name, are two functions');
    assert.ok(!sameFunction('', 'x'));
  });
  it('scores each anchor on its best rung and each target on where it landed', () => {
    const claims = parseSidecar(SIDECAR);
    const s1 = scoreClaim(claims[0].anchors, readTargets(TARGETS_1).map(parseTargetSpec));
    assert.deepEqual(s1.anchors.map((a) => a.rung), ['function', 'class', 'miss']);
    assert.equal(s1.anchors[1].hit, 'cipher.py@CipherNegotiator', 'the target is the class of the anchor method');
    assert.deepEqual(s1.rungs, { function: 1, class: 1, file: 0, miss: 1 });
    assert.deepEqual(s1.targets.map((t) => t.where), ['exact', 'near', 'elsewhere', 'near']);
    assert.deepEqual(s1.where, { exact: 1, near: 2, elsewhere: 1 });
    const s2 = scoreClaim(claims[1].anchors, readTargets(TARGETS_2).map(parseTargetSpec));
    assert.deepEqual(s2.anchors.map((a) => a.rung), ['function', 'file'], 'a bare function beside a class method in its file is a file hit, not a class hit');
    assert.deepEqual(s2.where, { exact: 1, near: 2, elsewhere: 0 });
  });
  it('the class rung runs both ways: a class anchor reached by one of its methods, a method anchor by a sibling method', () => {
    const t = (s) => [parseTargetSpec(s)];
    assert.equal(scoreClaim([{ base: 'a.py', func: 'Foo' }], t('a.py@Foo::bar')).anchors[0].rung, 'class');
    assert.equal(scoreClaim([{ base: 'a.py', func: 'Foo::bar' }], t('a.py@Foo::baz')).anchors[0].rung, 'class');
    assert.equal(scoreClaim([{ base: 'a.py', func: 'Foo::bar' }], t('a.py@Foo')).anchors[0].rung, 'class');
    assert.equal(scoreClaim([{ base: 'a.py', func: 'Foo::bar' }], t('a.py@Other::bar')).anchors[0].rung, 'file');
    assert.equal(scoreClaim([{ base: 'a.py', func: 'Foo::bar' }], t('b.py@Foo::bar')).anchors[0].rung, 'miss');
  });
  it('a documentation or constant anchor (no function) reaches file at most; files match by basename, case-folded', () => {
    assert.equal(scoreClaim([{ base: 'README.md', func: '', kind: 'lines' }], [parseTargetSpec('readme.md@Section')]).anchors[0].rung, 'file');
    assert.equal(scoreClaim([{ base: 'README.md', func: '', kind: 'lines' }], []).anchors[0].rung, 'miss');
  });
  it('the partitions are complete: rungs sum to the anchors, where sums to the targets', () => {
    const claims = parseSidecar(SIDECAR);
    const s = scoreClaim(claims[0].anchors, readTargets(TARGETS_1).map(parseTargetSpec));
    assert.equal(LADDER.reduce((n, k) => n + s.rungs[k], 0), s.anchors.length);
    assert.equal(WHERE.reduce((n, k) => n + s.where[k], 0), s.targets.length);
    const rows = [{ n: 1, anchors: 3, located: 4, rungs: s.rungs, where: s.where }, { n: 2, anchors: 0, located: 0, rungs: { function: 0, class: 0, file: 0, miss: 0 }, where: { exact: 0, near: 0, elsewhere: 0 }, error: 'no targets written' }];
    const t = totalsOf(rows);
    assert.equal(t.anchors, 3); assert.equal(t.located, 4); assert.equal(t.claims, 2); assert.equal(t.errors, 1);
  });
});

describe('hof: the commands each step is the equivalent of', () => {
  const P = outPaths('OUT');
  it('draft always carries --min-rank 0 and --form-rules; --rank only with the flag; no --force unless given', () => {
    const o = parseOwnArgs(['--index-path', '.demo', '--llm', 'claude']);
    const c = buildCommands(o, P);
    assert.ok(c.draft.includes('--min-rank') && c.draft[c.draft.indexOf('--min-rank') + 1] === '0');
    assert.ok(c.draft.includes('--form-rules') && c.draft[c.draft.indexOf('--form-rules') + 1] === 'current');
    assert.ok(c.draft.includes('--claims-only') && c.draft.includes('--pseudo-out'));
    assert.ok(!c.draft.includes('--claim-class'));
    assert.ok(!c.candidates.includes('--rank') && !c.candidates.includes('--llm'), 'the grouper runs with no model unless --rank');
    for (const a of [c.candidates, c.draft, c.locate(1)]) assert.ok(!a.includes('--force'));
    assert.deepEqual(c.locate(2).slice(0, 4), ['--index-path', '.demo', '--claim-locate', `@${P.claim(2)}`]);
    assert.ok(c.locate(2).includes('--targets-out') && c.locate(2).includes(P.locate(2)));
    assert.ok(!c.locate(2).includes('--blind') && !c.locate(2).includes('--runs'));
    assert.equal(c.synonymize(1), null, 'no synonymize step unless --synonymize-with');
  });
  it('passes --rank, --form-rules, --claim-class, --filter, --blind, --runs, --include-tests and --force to the step each belongs to', () => {
    const o = parseOwnArgs(['--index-path', '.demo', '--llm', 'chatgpt', '--rank', '--form-rules', '2026-10', '--claim-class', 'both', '--filter', 'tls', '--blind', '--runs', '3', '--force', '--include-tests']);
    const c = buildCommands(o, P);
    assert.ok(c.candidates.includes('--rank') && c.candidates.includes('--llm') && c.candidates.includes('--force'));
    assert.ok(c.candidates.includes('--filter') && c.candidates[c.candidates.indexOf('--filter') + 1] === 'tls');
    assert.ok(!c.draft.includes('--filter') && !c.draft.includes('--rank'));
    assert.equal(c.draft[c.draft.indexOf('--form-rules') + 1], '2026-10');
    assert.equal(c.draft[c.draft.indexOf('--claim-class') + 1], 'both');
    assert.ok(c.draft.includes('--force'));
    const l = c.locate(1);
    assert.ok(l.includes('--blind') && l[l.indexOf('--runs') + 1] === '3' && l.includes('--force'));
    assert.ok(!l.includes('--form-rules') && !l.includes('--claim-class'));
    // --include-tests is locate-only (claim-locate-test-gate-off-on-all-samples-corpus).
    assert.ok(l.includes('--include-tests'));
    assert.ok(!c.draft.includes('--include-tests') && !c.candidates.includes('--include-tests'));
    assert.equal(parseOwnArgs(['--index-path', '.demo', '--llm', 'claude']).includeTests, false);
  });
  it('--model <gguf> replaces --llm on every model-bearing step; --limit drafts from the trimmed list', () => {
    const o = parseOwnArgs(['--index-path', '.demo', '--model', 'q.gguf', '--limit', '2']);
    assert.deepEqual(modelArgs(o), ['--model', 'q.gguf']);
    const c = buildCommands(o, { ...P, draftFrom: 'OUT/cand_first2.lst' });
    assert.ok(c.draft.includes('@OUT/cand_first2.lst') && !c.draft.includes('--llm'));
    assert.ok(c.locate(1).includes('--model'));
  });
  it('--synonymize-with adds the rewrite step, the equivalent of --synonymize @claim_N.orig.txt with the second engine', () => {
    const c = buildCommands({ indexPath: '.demo', llm: 'claude', formRules: 'current', synonymizeWith: 'gemini' }, P);
    assert.deepEqual(c.synonymize(3), ['--synonymize', `@${P.claimOrig(3)}`, '--llm', 'gemini', '--synonymize-out', P.claim(3)]);
    const g = buildCommands({ indexPath: '.demo', llm: 'claude', formRules: 'current', synonymizeWith: 'q.gguf', force: true }, P);
    assert.deepEqual(g.synonymize(1).slice(2, 4), ['--model', 'q.gguf']);
    assert.ok(g.synonymize(1).includes('--force'));
  });
  it('echoLine quotes an argument with spaces, so the echoed line can be pasted back', () => {
    assert.equal(echoLine(['--filter', 'two words']), '$ ce --filter "two words"');
  });
  it('the script refuses what it cannot run', () => {
    assert.throws(() => parseOwnArgs(['--llm', 'claude']), /--index-path/);
    assert.throws(() => parseOwnArgs(['--index-path', '.demo']), /--llm <name> or --model/);
    assert.throws(() => parseOwnArgs(['--index-path', '.demo', '--llm', 'a', '--model', 'b']), /alternatives/);
    assert.throws(() => parseOwnArgs(['--index-path', '.demo', '--llm', 'a', '--form-rules', '2025']), /--form-rules must be/);
    assert.throws(() => parseOwnArgs(['--index-path', '.demo', '--llm', 'a', '--limit', '0']), /--limit/);
    assert.throws(() => parseOwnArgs(['--index-path', '.demo', '--llm', 'a', '--claims', 'c.txt', '--rank']), /--claims skips drafting/);
    assert.throws(() => parseOwnArgs(['--index-path', '.demo', '--llm', 'a', '--bogus']), /unknown option: --bogus/);
    assert.throws(() => parseOwnArgs(['--index-path', '--llm', 'a']), /--index-path needs a value/);
    assert.equal(parseOwnArgs(['--help']).help, true);
  });
});

describe('hof: the report', () => {
  const rows = () => {
    const claims = joinRank(parseSidecar(SIDECAR), parseCandidateGroups(CAND));
    const s1 = scoreClaim(claims[0].anchors, readTargets(TARGETS_1).map(parseTargetSpec));
    const s2 = scoreClaim(claims[1].anchors, []);
    return [
      { ...claims[0], ...s1, located: 4, anchorsN: 3, error: null },
      { ...claims[1], ...s2, located: 0, anchorsN: 2, error: 'no targets written' },
    ];
  };
  it('the table carries rank, the two partitions, a totals row and the percentages', () => {
    const r = rows();
    const t = renderTable(r.map((x) => ({ n: x.n, priority: x.priority, label: x.label, anchors: x.anchorsN, located: x.located, rungs: x.rungs, where: x.where, error: x.error })));
    assert.match(t, /^\s+n rank anch\s+loc\s+fn cls file miss\s+exact near else\s+label/m);
    assert.match(t, /^\s+1 P3\s+3\s+4\s+1\s+1\s+0\s+1\s+1\s+2\s+1\s+handshake$/m);
    assert.match(t, /^\s+2 P1\s+2\s+0\s+0\s+0\s+0\s+2\s+0\s+0\s+0\s+cert chain\s+\[no targets written\]$/m);
    assert.match(t, /^all\s+5\s+4\s+1\s+1\s+0\s+3\s+1\s+2\s+1\s+2 claim\(s\), 1 not located$/m);
    assert.match(t, /function 20%, class 20%, file 0%, miss 60%/);
    assert.match(t, /exact 25%, near 50%, elsewhere 25%/);
  });
  it('a row\'s tag says the error and whether the locate step ran twice, in the table and the report', () => {
    assert.equal(rowTag({ error: null, retried: false }), null);
    assert.equal(rowTag({ error: null, retried: true }), 'retried');
    assert.equal(rowTag({ error: 'claim-locate failed', retried: false }), 'claim-locate failed');
    assert.equal(rowTag({ error: 'claim-locate failed', retried: true }), 'claim-locate failed, retried');
    const r = rows();
    const t = renderTable([{ ...r[0], anchors: r[0].anchorsN, retried: true }, { ...r[1], anchors: r[1].anchorsN, error: 'claim-locate failed', retried: true }]);
    assert.match(t, /handshake  \[retried\]$/m);
    assert.match(t, /cert chain  \[claim-locate failed, retried\]$/m);
    assert.ok(isLocateParseFailure(`Step 3: selecting implementers from real candidates...\n\n${LOCATE_PARSE_FAILURE}.\n`));
    assert.ok(!isLocateParseFailure('--claim-locate: propose failed: 401 unauthorized\n'), 'a model error is not the parse failure');
  });
  it('the console footer is one rule per line under the heading, never one line (the first full run printed it so)', () => {
    const lines = howToReadText().split('\n');
    assert.equal(lines.length, HOW_TO_READ.length);
    assert.equal(lines[0], 'How to read this:');
    assert.ok(lines.slice(1).every((l) => l.startsWith('- ')), 'each rule on its own line');
  });
  it('the Markdown report names the commands, the table, each anchor\'s rung, the own-words sentence, and ends with the footer', () => {
    const r = rows();
    const report = {
      generated: '2026-11-03T00:00:00Z', ce: '1.2.3', index: 'demo', indexPath: '/x/.demo',
      options: { llm: 'claude', formRules: '2026-10', claimClass: null, rank: true, limit: null, filter: null, blind: true, runs: null, claims: null },
      steps: [{ name: '1-candidates', args: ['--index-path', '.demo', '--pseudo-claims', '--candidates', 'cand.lst'], code: 0, ms: 1500 }],
      claims: r, totals: totalsOf(r.map((x) => ({ anchors: x.anchorsN, located: x.located, rungs: x.rungs, where: x.where, error: x.error }))),
    };
    const md = renderMarkdown(report);
    assert.match(md, /^# HOF: demo/m);
    assert.match(md, /by ce --hof; CodeExam 1\.2\.3/, 'the command is the default tool');
    assert.match(md, /--form-rules 2026-10/);
    assert.match(md, /--rank \(reported, not a floor\)/);
    assert.match(md, /\$ ce --index-path \.demo --pseudo-claims --candidates cand\.lst/);
    assert.match(md, /\| 1 \| P3 \| handshake \| 3 \| 4 \| 1 \| 1 \| 0 \| 1 \| 1 \| 2 \| 1 \|/);
    assert.match(md, /`handshake\.c@perform_handshake` — \*\*function\*\* via `handshake\.c@perform_handshake`/);
    assert.match(md, /`README\.md@\(lines\)` — \*\*miss\*\*/);
    assert.match(md, /`other\.c@unrelated_fn` — elsewhere/);
    assert.match(md, /Not located: no targets written/);
    assert.match(md, /^The claims were located in the drafter's own words, which is the easier case/m);
    assert.match(md, /\n## How to read this\n\n- Per anchor, the best rung/);
    assert.ok(md.trimEnd().endsWith(HOW_TO_READ[HOW_TO_READ.length - 1]), 'the footer closes the report');
    assert.ok(HOW_TO_READ.length <= 10, 'under ten lines');
    const syn = renderMarkdown({ ...report, tool: 'ce --hof', engines: { drafter: 'Claude API — x (cloud LLM)', synonymizer: 'Gemini API — y (cloud LLM)', locator: 'Claude API — x (cloud LLM)' }, options: { ...report.options, synonymizeWith: 'gemini' }, claims: r.map((x) => ({ ...x, rewritten: 'A method of making a session', overlap: 40 })) });
    assert.match(syn, /- engines: drafter Claude API — x \(cloud LLM\); synonymizer Gemini API — y \(cloud LLM\); locator Claude API/);
    assert.match(syn, /- synonymizing: --synonymize-with gemini, anchors withheld/);
    assert.doesNotMatch(syn, /located in the drafter's own words, which is the easier case/, 'the own-words sentence goes when a synonymizer ran');
    assert.match(syn, /Located as rewritten by the synonymizer \(40% of the original vocabulary kept\):/);
  });
  it('the script\'s dry run names the group count, the commands it would run, and the cost figures with their sources', () => {
    const o = parseOwnArgs(['--index-path', '.demo', '--llm', 'claude', '--rank', '--limit', '2', '--runs', '2']);
    const lines = dryRunLines(o, buildCommands(o, outPaths('OUT')), 5).join('\n');
    assert.match(lines, /5 candidate group\(s\), the first 2 drafted; nothing is sent to a model/);
    assert.match(lines, /--rank: \$0\.12 for 57 groups/);
    assert.match(lines, /\$2 guard/);
    assert.match(lines, /4 call\(s\) \(2 claim\(s\) × --runs 2\) ≈ \$0\.08/);
    assert.match(lines, /claim-locate @OUT[\\/]claim_N\.txt/);
  });
});

// hof-cli-command (2026-11-09): the command
describe('hof: the command', () => {
  const base = { index_path: '.demo', llm: 'claude', form_rules: 'current', claim_class: 'method', _explicit: new Set() };
  it('hofOptions reads the flags, keeps --claim-class only when given, and refuses what cannot run', () => {
    const o = hofOptions(base);
    assert.deepEqual([o.indexPath, o.llm, o.model, o.formRules, o.claimClass, o.limit, o.synonymizeWith, o.hofOut, o.claims], ['.demo', 'claude', null, 'current', null, null, null, null, null]);
    assert.equal(hofOptions({ ...base, _explicit: new Set(['claim_class']), claim_class: 'both' }).claimClass, 'both');
    assert.equal(hofOptions({ ...base, limit: 3, runs: 2, synonymize_with: 'gemini', hof_out: 'R', hof_claims: 'c.txt', limit: null, filter: null }).claims, 'c.txt');
    assert.throws(() => hofOptions({ ...base, llm: null }), /needs a model/);
    assert.throws(() => hofOptions({ ...base, model: 'q.gguf' }), /alternatives/);
    assert.throws(() => hofOptions({ ...base, index_path: null }), /needs an index/);
    assert.throws(() => hofOptions({ ...base, form_rules: '2025' }), /--form-rules must be/);
    assert.throws(() => hofOptions({ ...base, limit: 0 }), /--limit needs a positive integer/);
    assert.throws(() => hofOptions({ ...base, runs: 1.5 }), /--runs needs a positive integer/);
    assert.throws(() => hofOptions({ ...base, hof_claims: 'c.txt', rank: true }), /--claims skips drafting/);
    assert.throws(() => hofOptions({ ...base, synonymize_with: 'not a provider' }), /--synonymize-with takes/);
  });
  it('synonymizerArgs names the second engine as --llm or --model and drops the first', () => {
    assert.deepEqual([synonymizerArgs(base, 'gemini').llm, synonymizerArgs(base, 'gemini').model], ['gemini', null]);
    assert.deepEqual([synonymizerArgs(base, 'q.gguf').llm, synonymizerArgs(base, 'q.gguf').model], [null, 'q.gguf']);
  });
  it('the run directory: beside the index as hof/<yymmdd-HHMM>, --hof-out elsewhere, refused on a .zip index', () => {
    const when = new Date(2026, 10, 9, 14, 5);
    assert.equal(runStamp(when), '261109-1405');
    assert.equal(runDirFor('.demo', null, when), path.join(path.resolve('.demo'), 'hof', '261109-1405'));
    assert.equal(runDirFor('.demo', 'elsewhere/run', when), path.resolve('elsewhere/run'));
    assert.throws(() => runDirFor('samples/FIRST_RUN_INDEX.zip', null, when), /--hof on a \.zip index needs --hof-out <dir>: FIRST_RUN_INDEX\.zip unpacks to a temporary cache/);
    assert.equal(runDirFor('samples/FIRST_RUN_INDEX.zip', 'R', when), path.resolve('R'), '--hof-out lifts the refusal');
    assert.equal(outPaths('OUT').claimOrig(2), path.join('OUT', 'claim_2.orig.txt'));
  });
  it('the preflight counts one draft per group (the first --limit), one locate run per claim times --runs at two calls each, and six rewrites per claim under --synonymize-with', () => {
    const c = preflightCalls({ limit: 2, runs: 2, synonymizeWith: 'gemini' }, 5);
    assert.deepEqual([c.drafted, c.drafts, c.locates, c.rewrites, c.calls.length], [2, 2, 4, 12, 2 + 12 + 8]);
    assert.deepEqual(c.calls[0], { inChars: CALL_SIZES.draft.inChars, outTokens: CALL_SIZES.draft.outTokens });
    const plain = preflightCalls({}, 5);
    assert.deepEqual([plain.drafted, plain.drafts, plain.locates, plain.rewrites, plain.calls.length], [5, 5, 5, 0, 15]);
    const relocate = preflightCalls({ claims: 'c.txt' }, 7);
    assert.deepEqual([relocate.drafts, relocate.locates, relocate.calls.length], [0, 7, 14], '--claims drafts nothing');
  });
  it('the plan names the counts, each step\'s equivalent command, and the projection or that a local model costs time', () => {
    const o = { indexPath: '.demo', llm: 'claude', formRules: 'current', limit: 2, runs: 2, synonymizeWith: 'gemini' };
    const P = outPaths('OUT');
    const lines = planLines(o, buildCommands(o, P), 5, preflightCalls(o, 5), { usd: 0.41, modelLabel: 'Claude API — m (cloud LLM)' }).join('\n');
    assert.match(lines, /^dry run: 5 candidate group\(s\), the first 2 drafted; nothing is sent to a model\.$/m);
    assert.match(lines, /^Each step is the equivalent of:$/m);
    assert.match(lines, /\$ ce --index-path \.demo --pseudo-claims @OUT[\\/]cand\.lst --llm claude --claims-only/);
    assert.match(lines, /\$ ce --synonymize @OUT[\\/]claim_N\.orig\.txt --llm gemini --synonymize-out OUT[\\/]claim_N\.txt   \(N = 1\.\.2\)/);
    assert.match(lines, /\$ ce --index-path \.demo --claim-locate @OUT[\\/]claim_N\.txt --llm claude --targets-out OUT[\\/]locate_N\.txt --runs 2   \(N = 1\.\.2\)/);
    assert.match(lines, /^Model calls: 2 draft\(s\); about 12 rewrite\(s\) \(2 claim\(s\), six limitations each until drafted\); 4 locate run\(s\) \(2 claim\(s\) × --runs 2\), two calls each\.$/m);
    assert.match(lines, /^Projected: ~\$0\.41 on Claude API — m \(cloud LLM\), an estimate from per-call sizes/m);
    assert.match(lines, /\$2 claims guard stops a run above it unless --force/);
    assert.match(lines, /^A locate run whose selections do not parse is run once more, outside the projection \(two more calls for such a claim\)\.$/m);
    const local = planLines({ indexPath: '.demo', model: 'q.gguf', formRules: 'current' }, buildCommands({ indexPath: '.demo', model: 'q.gguf', formRules: 'current' }, P), 3, preflightCalls({}, 3), { usd: null, modelLabel: 'local GGUF — q.gguf' }).join('\n');
    assert.match(local, /^Cost: a local model \(local GGUF — q\.gguf\); time, not dollars\.$/m);
    assert.doesNotMatch(local, /--synonymize/);
  });
  it('synonymizeClaim rewrites every limitation through the second engine, anchors withheld, one per line, and reports the vocabulary kept', async () => {
    const seen = [];
    const draft = async (sys, user) => { seen.push(user); return `Rewritten ${user.replace(/^LIMITATION:\n/, '').replace(/handshake|cipher/g, 'greeting')}`; };
    const r = await synonymizeClaim('A method of establishing a session, comprising: performing a handshake; and negotiating a cipher.', draft, { splitClaimElements, synonymizeElements });
    assert.equal(r.elements, 3);
    assert.equal(r.failed, 0);
    assert.equal(r.text.split('\n').length, 3, 'one limitation per line, so --claim-locate splits it as drafted');
    assert.ok(seen.every((u) => u.startsWith('LIMITATION:\n') && !/handshake\.c|@/.test(u)), 'the engine sees text only');
    assert.ok(Number.isInteger(r.overlap) && r.overlap >= 0 && r.overlap <= 100, `overlap ${r.overlap}`);
    const bad = await synonymizeClaim('A method, comprising: a step.', async () => 'x', { splitClaimElements, synonymizeElements });
    assert.ok(bad.failed >= 1, 'a trivially short rewrite is a failure, kept as drafted');
  });

  const demoPlan = fs.existsSync(path.join(ROOT, '.demo', 'literal_index.json'));
  it('end to end, --dry-run on the demo index: the grouper runs, the plan prints with the projection, nothing else is written, and the run directory sits under .demo/hof/', { skip: demoPlan ? false : 'needs the .demo index' }, () => {
    const r = spawnSync(process.execPath, ['src/index.js', '--ndx', '.demo', '--hof', '--llm', 'claude', '--dry-run', '--limit', '2'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const m = r.stdout.match(/^hof: output under (.*)$/m);
    try {
      assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-1200));
      assert.ok(m, r.stdout.slice(0, 400));
      assert.match(m[1], /[\\/]\.demo[\\/]hof[\\/]\d{6}-\d{4}$/, 'beside the index');
      assert.match(r.stdout, /^\$ ce --index-path \.demo --pseudo-claims --candidates /m, 'the grouper step is echoed');
      assert.match(r.stdout, /^hof: \d+ candidate group\(s\) in /m);
      assert.match(r.stdout, /^dry run: \d+ candidate group\(s\)(, the first 2 drafted)?; nothing is sent to a model\.$/m);
      assert.match(r.stdout, /^Projected: ~\$\d+\.\d\d on Claude API/m);
      assert.ok(fs.existsSync(path.join(m[1], 'cand.lst')) && fs.existsSync(path.join(m[1], 'logs', '1-candidates.txt')));
      assert.ok(!fs.existsSync(path.join(m[1], 'claims.txt')) && !fs.existsSync(path.join(m[1], 'hof_report.md')), 'a dry run drafts nothing');
    } finally {
      if (m) fs.rmSync(m[1], { recursive: true, force: true });
    }
  });

  const zip = path.join(ROOT, 'samples', 'FIRST_RUN_INDEX.zip');
  it('end to end, a .zip index is refused without --hof-out, before any model call', { skip: fs.existsSync(zip) ? false : 'needs samples/FIRST_RUN_INDEX.zip' }, () => {
    const r = spawnSync(process.execPath, ['src/index.js', '--ndx', 'samples/FIRST_RUN_INDEX.zip', '--hof', '--llm', 'claude'], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    assert.equal(r.status, 2, (r.stdout + r.stderr).slice(-800));
    assert.match(r.stderr, /--hof on a \.zip index needs --hof-out <dir>: FIRST_RUN_INDEX\.zip unpacks to a temporary cache/);
    assert.doesNotMatch(r.stdout, /candidate group/, 'refused before the grouper ran');
  });
});

// hof-locate-retry-once (2026-11-09): a whole run through stubs for the three
// model-calling steps, so the step runner, the retry, the console and the
// records are exercised with no model. `failLocate` names a claim whose locate
// step prints the locator's parse-failure exit the first `times` times.
async function runStubbed({ failLocate = null, verbose = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-hof-run-'));
  const indexDir = path.join(tmp, '.demo');
  fs.mkdirSync(indexDir);
  const out = path.join(tmp, 'run');
  const locateCalls = new Map();
  const seams = {
    pseudoClaims: {
      doEmitCandidates: async (index, a) => { console.log('grouper body line'); fs.writeFileSync(a.candidates, CAND); },
      doPseudoClaims: async (index, a) => {
        console.log('drafter body line');
        process.stderr.write('# actual cost: ~$0.03 (2 calls, 9k tok in / 400 out)\n');
        fs.writeFileSync(a.claims_only, `${SIDECAR.claims.map((c) => c.claim).join('\n')}\n`);
        fs.writeFileSync(`${a.claims_only}.anchors.json`, JSON.stringify(SIDECAR));
        fs.writeFileSync(a.pseudo_out, '# artifact\n');
      },
    },
    claimLocate: {
      splitClaimElements,
      doClaimLocate: async (index, a) => {
        const n = Number(a.claim_locate.match(/claim_(\d+)\.txt$/)[1]);
        const k = (locateCalls.get(n) || 0) + 1;
        locateCalls.set(n, k);
        console.log(`locator body line ${n}`);
        if (failLocate && n === failLocate.n && k <= failLocate.times) { console.error(`${LOCATE_PARSE_FAILURE}.`); process.exitCode = 1; return; }
        fs.writeFileSync(a.targets_out, n === 1 ? TARGETS_1 : TARGETS_2);
        return { rows: [] };
      },
    },
  };
  const args = { index_path: indexDir, llm: 'claude', hof: true, hof_out: out, form_rules: 'current', claim_class: 'method', _explicit: new Set(), force: true, verbose };
  const outChunks = [];
  const errChunks = [];
  const ow = process.stdout.write;
  const ew = process.stderr.write;
  process.stdout.write = (c) => { outChunks.push(String(c)); return true; };
  process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  let exit;
  try { await doHof({}, args, seams); exit = process.exitCode; } finally { process.stdout.write = ow; process.stderr.write = ew; process.exitCode = prevExit; }
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  return {
    out, exit, locateCalls, stdout: outChunks.join(''), stderr: errChunks.join(''),
    report: JSON.parse(read(path.join(out, 'hof_report.json'))), md: read(path.join(out, 'hof_report.md')),
    log: (name) => read(path.join(out, 'logs', `${name}.txt`)),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

describe('hof: a whole run through stubs, no model', () => {
  it('a locate whose selections do not parse is run once more; located on the second run, the row reads retried and the run exits 0', async () => {
    const r = await runStubbed({ failLocate: { n: 2, times: 1 } });
    try {
      assert.deepEqual([r.locateCalls.get(1), r.locateCalls.get(2)], [1, 2]);
      const names = r.report.steps.map((s) => `${s.name}:${s.code}${s.retried ? ':retried' : ''}`);
      assert.deepEqual(names, ['1-candidates:0', '2-draft:0', '3-locate-1:0', '3-locate-2:1:retried', '3-locate-2.retry:0']);
      assert.deepEqual(r.report.claims.map((c) => [c.error, c.retried]), [[null, false], [null, true]]);
      assert.equal(r.report.totals.errors, 0);
      assert.match(r.stdout, /cert chain  \[retried\]$/m, 'the table says so');
      assert.match(r.md, /\| 2 \| P1 \| cert chain \*\(retried\)\* \|/);
      assert.match(r.md, /Located on the second run: the first run's selections did not parse\./);
      assert.match(r.md, /→ exit 1, \d+\.\ds \(the selections did not parse; run once more\)/);
      assert.ok(isLocateParseFailure(r.log('3-locate-2')), 'the first run\'s log holds the exit');
      assert.ok(r.log('3-locate-2.retry') != null && !isLocateParseFailure(r.log('3-locate-2.retry')), 'the second run has its own log');
      assert.equal(r.exit, undefined, 'a retried-then-located run is a complete run');
    } finally { r.cleanup(); }
  });
  it('a locate that does not parse twice is failed, retried, and the run exits 1; a model error would not be retried', async () => {
    const r = await runStubbed({ failLocate: { n: 1, times: 2 } });
    try {
      assert.equal(r.locateCalls.get(1), 2, 'one retry, not more');
      assert.deepEqual(r.report.claims.map((c) => [c.error, c.retried]), [['claim-locate failed', true], [null, false]]);
      assert.match(r.stdout, /handshake  \[claim-locate failed, retried\]$/m);
      assert.match(r.md, /Not located: claim-locate failed \(run twice: the selections did not parse either time\)\./);
      assert.equal(r.report.totals.errors, 1);
      assert.equal(r.exit, 1);
    } finally { r.cleanup(); }
  });

  // hof-console-progress-lines (2026-11-09)
  it('a step\'s result line: exit and seconds, the step\'s own cost line, and on a failure the reason or the log\'s last line', () => {
    assert.equal(resultLine({ code: 0, ms: 21140 }, null, 'Claim: 20 chars\n# actual cost: ~$0.01 (2 calls, 7k tok in / 319 out)\n'), '  → exit 0, 21.1s; # actual cost: ~$0.01 (2 calls, 7k tok in / 319 out)');
    assert.equal(resultLine({ code: 0, ms: 2600 }, null, 'Wrote 212 candidate group(s)\n'), '  → exit 0, 2.6s');
    assert.equal(resultLine({ code: 1, ms: 9100 }, null, 'Step 3: selecting...\n\nNo symbol selections were parseable.\n\n'), '  → exit 1, 9.1s: No symbol selections were parseable.');
    assert.equal(resultLine({ code: 1, ms: 100 }, 'ENOENT: claim_3.txt', 'whatever\n'), '  → exit 1, 0.1s: ENOENT: claim_3.txt', 'a thrown error is the reason');
    assert.equal(lastLine('x'.repeat(200)), `${'x'.repeat(157)}…`);
    assert.equal(lastLine(''), '');
  });
  it('the console carries the run\'s story only: the echo and one result line per step, the table and the footer; the bodies are in logs/; --verbose echoes them', async () => {
    const r = await runStubbed({ failLocate: { n: 2, times: 1 } });
    try {
      for (const body of ['grouper body line', 'drafter body line', 'locator body line']) assert.doesNotMatch(r.stdout, new RegExp(body), `${body} stays in the log`);
      assert.match(r.log('2-draft'), /drafter body line/);
      assert.match(r.log('3-locate-1'), /locator body line 1/);
      const results = r.stdout.match(/^  → exit \d, \d+\.\ds.*$/gm) || [];
      assert.equal(results.length, r.report.steps.length, 'one result line per step');
      assert.match(r.stdout, /--claims-only [^\n]*\n  → exit 0, \d+\.\ds; # actual cost: ~\$0\.03 \(2 calls, 9k tok in \/ 400 out\)$/m, 'the draft step\'s cost line rides on its result line');
      assert.match(r.stdout, /^  → exit 1, \d+\.\ds: No symbol selections were parseable\.$/m, 'a failure says why');
      assert.match(r.stdout, /^hof: 2 candidate group\(s\) in /m);
      assert.match(r.stdout, /\nHow to read this:\n- Per anchor, the best rung/);
      assert.match(r.stdout, /^hof: report in /m);
      assert.match(r.stderr, /^# projected cost: /m, 'the preflight stays on stderr, as every claims command prints it');
    } finally { r.cleanup(); }
    const v = await runStubbed({ verbose: true });
    try {
      assert.match(v.stdout, /grouper body line/);
      assert.match(v.stdout, /locator body line 2/);
      assert.match(v.stdout, /^  → exit 0, /m, 'the result line stays under --verbose');
    } finally { v.cleanup(); }
  });
});
