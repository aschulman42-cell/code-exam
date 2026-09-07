#!/usr/bin/env node
// engine-qualify.mjs — pass/fails an engine on pinned negative+positive chart sidecars; no model calls
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// engine-qualify: score an engine's pinned qualification pair from sidecars.
// (engine-qualification-check; spec = asus-CC's two-claim rubric, #311.)
//
//   node scripts/engine-qualify.mjs --negative <'101-family>.verdicts.json --positive <tls>.verdicts.json [--engine <label>]
//
// NEGATIVE (the '101 x ExoPlayer3 family, a true negative on a client-only
// corpus): FAIL if the merged claim-1 rows contain zero ABSENT (the
// trivial-baseline shape, RUN22), or any PRESENT rests on lone support in a
// wide field (1 of >= LONE_FLOOR targets). PASS otherwise.
// POSITIVE (the TLS demo, a true positive): FAIL if fewer than
// POSITIVE_MIN_PRESENT of the merged rows are PRESENT.
// Scoring is mechanical -- sidecars only, no model calls.

import fs from 'node:fs';

export const LONE_FLOOR = 20;
export const POSITIVE_MIN_PRESENT = 6;
const RANK = { PRESENT: 3, PARTIAL: 2, ASSUMED: 1, ABSENT: 0 };

export function mergedRows(sidecar) {
  const best = new Map();
  const tally = new Map();
  for (const a of sidecar.analysed || []) {
    for (const e of a.elements || []) {
      const t = tally.get(e.element) || { total: 0, byLabel: {} };
      t.total++; t.byLabel[e.label] = (t.byLabel[e.label] || 0) + 1;
      tally.set(e.element, t);
      const cur = best.get(e.element);
      if (!cur || (RANK[e.label] || 0) > (RANK[cur.label] || 0)) best.set(e.element, { label: e.label, target: a.target });
    }
  }
  return [...best.entries()].sort((a, b) => a[0] - b[0])
    .map(([element, v]) => ({ element, ...v, agreement: tally.get(element) }));
}

export function scoreNegative(sidecar) {
  const rows = mergedRows(sidecar);
  const reasons = [];
  const absent = rows.filter((r) => r.label === 'ABSENT').length;
  if (rows.length && absent === 0) reasons.push(`zero ABSENT across ${rows.length} rows on a true negative (trivial-baseline shape)`);
  for (const r of rows) {
    if (r.label !== 'PRESENT') continue;
    const a = r.agreement;
    if (a && a.total >= LONE_FLOOR && (a.byLabel.PRESENT || 0) === 1) {
      reasons.push(`row ${r.element}: lone PRESENT at 1 of ${a.total} (floor ${LONE_FLOOR})`);
    }
  }
  return { pass: reasons.length === 0, reasons, rows: rows.length, absent };
}

export function scorePositive(sidecar) {
  const rows = mergedRows(sidecar);
  const present = rows.filter((r) => r.label === 'PRESENT').length;
  const pass = present >= POSITIVE_MIN_PRESENT;
  return { pass, reasons: pass ? [] : [`only ${present} PRESENT of ${rows.length} rows on a true positive (floor ${POSITIVE_MIN_PRESENT})`], rows: rows.length, present };
}

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[++i];
}
if (args.negative || args.positive) {
  const label = args.engine || '(engine)';
  let ok = true;
  if (args.negative) {
    const s = scoreNegative(JSON.parse(fs.readFileSync(args.negative, 'utf8')));
    ok = ok && s.pass;
    console.log(`| ${label} | negative | ${s.pass ? 'PASS' : 'FAIL'} | ${s.absent}/${s.rows} ABSENT${s.reasons.length ? ' — ' + s.reasons.join('; ') : ''} |`);
  }
  if (args.positive) {
    const s = scorePositive(JSON.parse(fs.readFileSync(args.positive, 'utf8')));
    ok = ok && s.pass;
    console.log(`| ${label} | positive | ${s.pass ? 'PASS' : 'FAIL'} | ${s.present}/${s.rows} PRESENT${s.reasons.length ? ' — ' + s.reasons.join('; ') : ''} |`);
  }
  process.exitCode = ok ? 0 : 1;
}
