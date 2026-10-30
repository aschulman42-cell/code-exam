#!/usr/bin/env node
// pseudo-claim-rubric-score.mjs — scores --pseudo-claims runs against a hand rubric page: MET / PARTIAL / ABSENT per row, surplus binned
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// issue-353-rubric-score-script (#353 part (e), 2026-10-30): the rubric loop as
// a regression gate. A change to the prompt or the packing is measured on the
// same rubric rows and the same corpus, run over run.
//
//   node scripts/pseudo-claim-rubric-score.mjs --rubric docs/pseudo-claim-rubrics/vocabulary.md \
//     --run CE_pseudo_vocab_103026.txt [--run other.txt …] [--sidecar run.anchors.json] \
//     [--claims 3,7] [--met 0.5] [--all] [--json]
//
//   --rubric   a rubric page (docs/pseudo-claim-rubrics/*.md): claim 1 with lettered
//              elements, numbered dependents, a "Citations and provenance" table
//   --run      a --pseudo-claims artifact; repeat for a side-by-side
//   --sidecar  a <claims-only>.anchors.json read instead of an artifact (one run)
//   --claims   score only these run claims (by number); otherwise every claim whose
//              anchors touch a file the rubric cites, the best first
//   --met      the overlap floor for MET (default 0.5)
//   --all      print every considered claim's rows, not only the best's
//   --json     the raw result instead of Markdown
//
// The agreement rule is a keyword proxy for a reading (overlap of the row's
// content stems with the claim's elements, dependents and anchor notes); the
// overlap is printed beside every verdict so the reading, which stays the
// human's, can check it. Pure scoring lives in src/core/rubric-score.js; this
// script injects claim-locate's element splitter and claim-genericity's
// element kind so the rows split and class the way the chart does.

import fs from 'node:fs';
import path from 'node:path';
import { parseRubricPage, parseRunArtifact, fromSidecar, scoreRubric, formatRubricScorecard, summaryLine, SUMMARY_HEADER, RUBRIC_MET_OVERLAP, RUBRIC_PARTIAL_OVERLAP } from '../src/core/rubric-score.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { claimGenericity } from '../src/core/claim-genericity.js';

function parseArgs(argv) {
  const a = { run: [], met: RUBRIC_MET_OVERLAP };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    if (name === 'run') a.run.push(argv[++i]);
    else if (name === 'all' || name === 'json' || name === 'help') a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.rubric || (!args.run.length && !args.sidecar)) {
  console.error('usage: node scripts/pseudo-claim-rubric-score.mjs --rubric <page.md> --run <artifact.txt> [--run …] [--sidecar run.anchors.json] [--claims n,n] [--met 0.5] [--all] [--json]');
  process.exit(args.help ? 0 : 2);
}

const rubric = parseRubricPage(fs.readFileSync(args.rubric, 'utf8'));
if (!rubric.rows.length) { console.error(`--rubric ${args.rubric}: no claim rows parsed (needs a "## Set X:" heading and **1.** / (a) markers)`); process.exit(2); }
const claims = args.claims ? String(args.claims).split(',').map((s) => Number(s.trim())).filter((n) => n > 0) : null;
const opts = {
  claims, metOverlap: Number(args.met) || RUBRIC_MET_OVERLAP,
  splitElements: (prose) => splitClaimElements(prose),
  classify: (text) => (claimGenericity(text).kind === 'generic' ? 'generic' : 'mechanism'),
};

const inputs = [];
for (const r of args.run) inputs.push({ name: path.basename(r), run: parseRunArtifact(fs.readFileSync(r, 'utf8')) });
if (args.sidecar) inputs.push({ name: path.basename(args.sidecar), run: fromSidecar(fs.readFileSync(args.sidecar, 'utf8')) });

const results = inputs.map((inp) => ({ name: inp.name, claims: inp.run.claims.length, result: scoreRubric(rubric, inp.run, opts) }));

if (args.json) {
  console.log(JSON.stringify({ rubric: { set: rubric.set, title: rubric.title, rows: rubric.rows.length, warnings: rubric.warnings }, met: opts.metOverlap, runs: results }, null, 2));
} else {
  const out = [];
  out.push(`# Rubric score — ${rubric.title || `Set ${rubric.set}`}`, '');
  out.push(`_${rubric.rows.length} rows (${rubric.rows.filter((r) => r.kind !== 'dependent').length} of claim 1, ${rubric.rows.filter((r) => r.kind === 'dependent').length} dependents); MET at overlap ${opts.metOverlap} with a cite, PARTIAL at ${RUBRIC_PARTIAL_OVERLAP} with a cite or ${opts.metOverlap} without; ${new Date().toISOString().slice(0, 10)}._`, '');
  if (results.length > 1) { out.push(SUMMARY_HEADER); for (const r of results) out.push(summaryLine(r.name, r.result)); out.push(''); }
  for (const r of results) out.push(formatRubricScorecard(rubric, `${r.name} (${r.claims} claims)`, r.result, { all: !!args.all }));
  if (results.length === 1) { out.push(SUMMARY_HEADER, summaryLine(results[0].name, results[0].result), ''); }
  console.log(out.join('\n'));
}
