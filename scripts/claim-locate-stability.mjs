#!/usr/bin/env node
// claim-locate-stability.mjs — measures run-to-run repeatability of --claim-locate targets
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * claim-locate-stability.mjs — is `--claim-locate` repeatable?
 *
 * Identical invocations produce different target lists, and under
 * `--per-element-select` they produce different CLAIM COVERAGE: a chart built
 * from a losing run reports element (e) ABSENT, from a winning run PRESENT.
 * The verdict on a limitation flips between identical commands, and nothing on
 * the artifact discloses it — both runs emit a clean provenance header, a
 * plausible target count, and a valid `Targets-checksum`, which guards against
 * the list being EDITED rather than against its GENERATION being unstable.
 *
 * This turns that into a number that can be tracked per engine and per release.
 * Without it every future claim about stability is anecdote.
 *
 * Dev-side, not wired into the CLI — same precedent as claim-selftest.mjs.
 *
 *   SCORE existing targets files (no model, no cost):
 *     node scripts/claim-locate-stability.mjs --score repro_pes_*.txt
 *
 *   RUN the production path N times and score that:
 *     node scripts/claim-locate-stability.mjs --runs 5 \
 *       --index .demo --claim @sample_patent_claim.txt --llm claude --per-element-select
 *
 * A note on what is being measured. `makeDrafter(model, 0)` is temperature 0
 * and greedy decoding uses no RNG, so a seed is irrelevant to it: local variance,
 * if any, comes from floating-point non-associativity in GPU kernels, which no
 * flag fixes. The question is not "does the seed work" but "is this engine's
 * greedy decoding stable on this hardware".
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

// The demo tree's own answer key (samples/tls_demo/README.md, "Sample Patent
// Claim"). Five element GROUPS, not eleven elements: the claim splits finer
// than the key, and scoring against the key is what makes "lost (e)" a fact
// rather than a judgement about which row matters.
const DEMO_KEY = [
  { id: 'a', label: 'initializing a cryptographic context', any: ['initialize_crypto_context'] },
  { id: 'b', label: 'negotiating cipher parameters', any: ['negotiate_cipher_params', 'CipherNegotiator'] },
  { id: 'c', label: 'performing a handshake protocol', any: ['perform_handshake'] },
  { id: 'd', label: 'verifying a certificate chain', any: ['verify_certificate_chain', 'CertificateValidator'] },
  { id: 'e', label: 'transmitting over encrypted channel', any: ['tls_send_encrypted', 'SecureChannel'] },
];

function readTargets(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const targets = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    for (const part of t.split(';')) { const p = part.trim(); if (p) targets.push(p); }
  }
  return targets;
}

// A group is covered when ANY of its code locations appears in the list.
export function scoreCoverage(targets, key = DEMO_KEY) {
  const joined = targets.join('\n');
  const covered = key.filter((g) => g.any.some((n) => joined.includes(n))).map((g) => g.id);
  return { covered, lost: key.filter((g) => !covered.includes(g.id)).map((g) => g.id) };
}

// Symmetric difference: how many targets are in one list and not the other.
export function pairwiseDiff(a, b) {
  const A = new Set(a); const B = new Set(b);
  let d = 0;
  for (const x of A) if (!B.has(x)) d++;
  for (const x of B) if (!A.has(x)) d++;
  return d;
}

export function stability(runs) {
  const lists = runs.map((r) => r.targets);
  const diffs = [];
  for (let i = 0; i < lists.length; i++) {
    for (let j = i + 1; j < lists.length; j++) diffs.push(pairwiseDiff(lists[i], lists[j]));
  }
  const union = new Set(lists.flat());
  const core = [...union].filter((t) => lists.every((l) => l.includes(t)));
  const unstable = [...union].filter((t) => !core.includes(t));
  const mean = diffs.length ? diffs.reduce((x, y) => x + y, 0) / diffs.length : 0;
  return {
    runs: lists.length,
    meanDiff: Number(mean.toFixed(1)),
    worstDiff: diffs.length ? Math.max(...diffs) : 0,
    unionSize: union.size,
    coreSize: core.length,
    // Share of the union present in EVERY run. The complement is the part of
    // the list a reader cannot count on.
    corePct: union.size ? Math.round((100 * core.length) / union.size) : 100,
    unstable,
  };
}

function report(label, runs, key) {
  const scored = runs.map((r) => ({ ...r, ...scoreCoverage(r.targets, key) }));
  const s = stability(scored);
  const lostRuns = scored.filter((r) => r.lost.length);
  console.log(`\n=== ${label} — ${scored.length} run(s) ===`);
  for (const r of scored) {
    console.log(`  ${String(r.name).padEnd(46)} ${String(r.targets.length).padStart(3)} targets`
      + `  covered ${r.covered.join('')}${r.lost.length ? `   LOST ${r.lost.join(',')}` : ''}`);
  }
  // Coverage loss is the headline: it is the one that changes a verdict.
  const lostTally = {};
  for (const r of scored) for (const g of r.lost) lostTally[g] = (lostTally[g] || 0) + 1;
  const lossLine = Object.keys(lostTally).length
    ? Object.entries(lostTally).map(([g, n]) => `(${g}) lost in ${n}/${scored.length}`).join(', ')
    : `no element group lost in any of ${scored.length}`;
  console.log(`  COVERAGE : ${lossLine}`);
  console.log(`  STABILITY: mean pairwise diff ${s.meanDiff} (worst ${s.worstDiff}),`
    + ` stable core ${s.coreSize}/${s.unionSize} = ${s.corePct}%`);
  // One pasteable line, so two agents compare NUMBERS not code.
  console.log(`  SUMMARY  : ${label} n=${scored.length} lost=${lostRuns.length}/${scored.length}`
    + ` diff=${s.meanDiff}/${s.worstDiff} core=${s.corePct}%`);
  return { label, scored, ...s, lostRuns: lostRuns.length };
}

function liveRuns(n, args) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const tmp = `.stability-run-${i}.txt`;
    const argv = ['src/index.js', '--index-path', args.index, '--claim-locate', args.claim,
      ...(args.llm ? ['--llm', args.llm] : []), ...(args.model ? ['--model', args.model] : []),
      ...(args.perElementSelect ? ['--per-element-select'] : []), '--targets-out', tmp];
    process.stderr.write(`run ${i}/${n}...\n`);
    const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
    if (r.status !== 0) { console.error(`run ${i} failed:\n${r.stderr}`); process.exit(1); }
    out.push({ name: tmp, targets: readTargets(tmp) });
  }
  return out;
}

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const has = (n) => argv.includes(n);

if (has('--score')) {
  const files = argv.slice(argv.indexOf('--score') + 1).filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('--score needs one or more targets files'); process.exit(2); }
  // Every file given is ONE family. Filename-based auto-grouping was tried and
  // removed: it split a 7-run family into three reports because two of the runs
  // were named differently, which is exactly the kind of silent regrouping that
  // makes a stability number wrong without looking wrong.
  const runs = files.map((f) => ({ name: f, targets: readTargets(f) }));
  report(flag('--label') || `${files.length} run(s)`, runs, DEMO_KEY);
  console.log('');
} else if (has('--runs')) {
  const n = Number(flag('--runs') || 3);
  const runs = liveRuns(n, {
    index: flag('--index') || '.demo', claim: flag('--claim') || '@sample_patent_claim.txt',
    llm: flag('--llm'), model: flag('--model'), perElementSelect: has('--per-element-select'),
  });
  report(has('--per-element-select') ? 'per-element-select' : 'pooled', runs, DEMO_KEY);
} else {
  console.error('usage: --score <files...>   |   --runs N --index <idx> --claim @file --llm <p> [--per-element-select]');
  process.exit(2);
}
