// test_hof.js — hof script: candidates and targets parsing, the ladder scoring, the command builder, the rank join
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// test_hof.js — hof-one-command (2026-11-03).
//
// The script drives `ce` as a subprocess; the model calls are the user's.
// What is tested is everything around them: the parsers that read CodeExam's
// public files (the candidates list, the --claims-only sidecar, the
// --targets-out file), the ladder that scores an anchor against the located
// targets, the command lines the script builds (--min-rank 0 always, --rank
// only when asked, --form-rules passed through), and the rank join with and
// without the sidecar's own `priority`. No fixture here encodes an expected
// answer about any real index.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOwnArgs, buildCommands, outPaths, modelArgs, echoLine,
  readClaims, readTargets, parseTargetSpec, baseName,
  parseCandidateGroups, limitCandidates, parseSidecar, joinRank,
  normName, enclosingClass, sameFunction, scoreClaim, totalsOf,
  renderTable, renderMarkdown, dryRunLines, LADDER, WHERE,
} from '../scripts/hof.mjs';

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

describe('hof: the commands it builds', () => {
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
  it('echoLine quotes an argument with spaces, so the echoed line can be pasted back', () => {
    assert.equal(echoLine(['--filter', 'two words']), '$ ce --filter "two words"');
  });
  it('refuses what it cannot run', () => {
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
  it('the Markdown report names the commands, the table and each anchor\'s rung', () => {
    const r = rows();
    const report = {
      generated: '2026-11-03T00:00:00Z', ce: '1.2.3', index: 'demo', indexPath: '/x/.demo',
      options: { llm: 'claude', formRules: '2026-10', claimClass: null, rank: true, limit: null, filter: null, blind: true, runs: null, claims: null },
      steps: [{ name: '1-candidates', args: ['--index-path', '.demo', '--pseudo-claims', '--candidates', 'cand.lst'], code: 0, ms: 1500 }],
      claims: r, totals: totalsOf(r.map((x) => ({ anchors: x.anchorsN, located: x.located, rungs: x.rungs, where: x.where, error: x.error }))),
    };
    const md = renderMarkdown(report);
    assert.match(md, /^# HOF: demo/m);
    assert.match(md, /--form-rules 2026-10/);
    assert.match(md, /--rank \(reported, not a floor\)/);
    assert.match(md, /\$ ce --index-path \.demo --pseudo-claims --candidates cand\.lst/);
    assert.match(md, /\| 1 \| P3 \| handshake \| 3 \| 4 \| 1 \| 1 \| 0 \| 1 \| 1 \| 2 \| 1 \|/);
    assert.match(md, /`handshake\.c@perform_handshake` — \*\*function\*\* via `handshake\.c@perform_handshake`/);
    assert.match(md, /`README\.md@\(lines\)` — \*\*miss\*\*/);
    assert.match(md, /`other\.c@unrelated_fn` — elsewhere/);
    assert.match(md, /Not located: no targets written/);
  });
  it('the dry run names the group count, the commands it would run, and the cost figures with their sources', () => {
    const o = parseOwnArgs(['--index-path', '.demo', '--llm', 'claude', '--rank', '--limit', '2', '--runs', '2']);
    const lines = dryRunLines(o, buildCommands(o, outPaths('OUT')), 5).join('\n');
    assert.match(lines, /5 candidate group\(s\), the first 2 drafted; nothing is sent to a model/);
    assert.match(lines, /--rank: \$0\.12 for 57 groups/);
    assert.match(lines, /\$2 guard/);
    assert.match(lines, /4 call\(s\) \(2 claim\(s\) × --runs 2\) ≈ \$0\.08/);
    assert.match(lines, /claim-locate @OUT[\\/]claim_N\.txt/);
  });
});
