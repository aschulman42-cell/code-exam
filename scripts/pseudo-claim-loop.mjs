#!/usr/bin/env node
// pseudo-claim-loop: the productized loop recipe (pseudo-claim-loop-test, #311).
//
// Hand-picked pseudo-claims -> synonymize -> chart each claim BLIND (original
// and synonymized wording; optionally its dependent family, a perturbed-
// dependent family, and a control index) -> score everything against the
// source run's sidecar with src/core/loop-score.js. Every chart is a real
// `ce --claim-chart` invocation (spawned), so what the loop measures is
// exactly what a user runs; nothing here talks to a model directly.
//
//   node scripts/pseudo-claim-loop.mjs --claims CE_3_pseudo_claims.txt \
//     --source CE082826_SEED_claims.txt --index .CE_082826 \
//     [--control .someOtherIndex] [--llm claude] [--syn-llm chatgpt] \
//     [--families] [--perturb] [--no-syn] [--limit N] [--dry-run]
//
//   --claims   numbered pseudo-claims, each paragraph starting "N. " with the
//              claim's number in the source run
//   --source   the run's claims-only file; its <source>.anchors.json sidecar is
//              the answer key (a *_pseudo.txt name is mapped to *_claims.txt)
//   --families chart claim N + its drafted dependents with --claim-family
//   --perturb  with --families: also chart a family with ONE dependent
//              deterministically perturbed (loop-score.perturbDependent); the
//              perturbed row is EXPECTED ABSENT -- the graded-test negative
//   --control  also chart each claim against this index (false-PRESENT rate)
//   --dry-run  print every command that would run, run none (also the
//              orientation mode for a new machine, e.g. asus-CC on GGUF:
//              swap --llm for --model <gguf> and the recipe is unchanged)
//
// Cost: every chart is ~25-35 analyses on the chosen engine; --force is passed
// so the $2 guard does not stop a batch mid-run. Watch the `# actual cost`
// lines; --limit and --dry-run are the throttles.
//
// Reference numbers a new engine should reproduce first (2026-08-29/30,
// claude-sonnet-4-6): ATSEL positive control 9/9 PRESENT, recall 0.75; CE_3
// baseline recall 1.0/0.75/0.25 orig, 1.0/0.5/0.13 synonymized.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { anchorKeys, perturbDependent, scoreChart, scoreControl, gradeDependents, formatScorecard } from '../src/core/loop-score.js';
import { mergeBestPerElement } from '../src/commands/claim-chart.js';
import { readCeVersion } from '../src/utils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = path.join(ROOT, 'src', 'index.js');

function parseArgs(argv) {
  const a = { llm: 'claude', 'syn-llm': 'chatgpt' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    if (['families', 'perturb', 'no-syn', 'dry-run'].includes(name)) a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (!args.claims || !args.source || !args.index) {
  console.error('usage: pseudo-claim-loop.mjs --claims <numbered.txt> --source <claims.txt> --index <X> [--control <Y>] [--llm claude|--model <gguf>] [--syn-llm chatgpt] [--families] [--perturb] [--no-syn] [--limit N] [--dry-run]');
  process.exit(2);
}
const srcClaims = args.source.replace(/_pseudo\.txt$/i, '_claims.txt');
const sidecarPath = `${srcClaims}.anchors.json`;
if (!fs.existsSync(sidecarPath)) { console.error(`sidecar not found: ${sidecarPath}`); process.exit(2); }
const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
const base = args.claims.replace(/\.txt$/i, '');
const engineArgs = args.model ? ['--model', args.model] : ['--llm', args.llm];

function numberedClaims(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.trim().match(/^(\d+)\s*[.)]\s+(.*\S)/);
    if (m) out.push({ n: Number(m[1]), text: m[2] });
  }
  return out;
}
const picked = numberedClaims(args.claims).slice(0, args.limit ? Number(args.limit) : Infinity);
if (!picked.length) { console.error(`no "N. claim" lines in ${args.claims}`); process.exit(2); }
console.error(`# loop: ${picked.length} claim(s) [${picked.map((c) => c.n).join(', ')}] on ${args.index}${args.control ? ` + control ${args.control}` : ''}`);

function run(argv, outFile) {
  console.error(`> node ${argv.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}${outFile ? ' > ' + outFile : ''}`);
  if (args['dry-run']) return true;
  const r = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (outFile) fs.writeFileSync(outFile, r.stdout || '');
  if (r.stderr) process.stderr.write(r.stderr.split('\n').filter((l) => /actual cost|projected cost|scope:|whole claim|concentration|CONTENT search|element\(s\), .* target/.test(l)).map((l) => '  ' + l + '\n').join(''));
  if (r.status !== 0) { console.error(`  exit ${r.status} -- continuing (the scorecard will show the gap)`); return false; }
  return true;
}
const chart = (claimFile, n, tag, index, extra = []) => {
  const vf = `${base}_chart_${n}_${tag}.verdicts.json`;
  run([CE, '--index-path', index, '--claim-chart', `@${claimFile}`, '--claim-number', String(n), ...engineArgs, '--force', '--verdicts-out', vf, ...extra], `${base}_chart_${n}_${tag}.md`);
  return vf;
};

// 1. Synonymize (HOF-b: away from the code's vocabulary) and restore numbers.
let synFile = null;
if (!args['no-syn']) {
  const rawSyn = `${base}_SYN.txt`;
  synFile = `${base}_SYN_numbered.txt`;
  run([CE, '--synonymize', `@${args.claims}`, '--claims-per-line', '--llm', args['syn-llm'], '--synonymize-out', rawSyn]);
  if (!args['dry-run']) {
    if (!fs.existsSync(rawSyn)) {
      // e.g. the synonymize spawn failed (missing key, network): a missing
      // arm degrades to a skipped arm, like the count-mismatch case below.
      console.error('synonymize produced no output; skipping the syn arm');
      synFile = null;
    } else {
    const lines = fs.readFileSync(rawSyn, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (lines.length !== picked.length) { console.error(`synonymize returned ${lines.length} claim(s) for ${picked.length}; skipping the syn arm`); synFile = null; }
    else fs.writeFileSync(synFile, lines.map((l, i) => `${picked[i].n}. ${l.replace(/^\d+\s*[.)]\s+/, '')}`).join('\n') + '\n');
    }
  }
}

// 2. Charts per claim; 3. families and the perturbed negative when asked.
const perClaim = [];
for (const { n } of picked) {
  const entry = (sidecar.claims || []).find((c) => c.n === n);
  if (!entry) { console.error(`claim ${n}: not in ${sidecarPath}; skipped`); continue; }
  const rec = { n, label: entry.label || '', arms: {}, control: null, dependents: null };
  const arms = { orig: chart(args.claims, n, 'orig', args.index) };
  if (synFile) arms.syn = chart(synFile, n, 'syn', args.index);
  if (args.control) rec.controlFile = chart(args.claims, n, 'control', args.control);
  if (args.families && (entry.dependents || []).length) {
    const famFile = `${base}_family_${n}.txt`;
    const famLines = [`1. ${entry.claim}`, ...entry.dependents.map((d) => `${d.n}. ${d.text}`)];
    if (!args['dry-run']) fs.writeFileSync(famFile, famLines.join('\n') + '\n');
    rec.familyFile = chartFamily(famFile, n, 'family');
    if (args.perturb) {
      const edits = new Map();
      const pLines = [`1. ${entry.claim}`];
      let perturbedOne = false;
      for (const d of entry.dependents) {
        const p = !perturbedOne ? perturbDependent(d.text) : null;
        if (p) { perturbedOne = true; edits.set(`[${d.n}a]`, p.edit); pLines.push(`${d.n}. ${p.text}`); }
        else pLines.push(`${d.n}. ${d.text}`);
      }
      if (perturbedOne) {
        const pFile = `${base}_family_${n}_perturbed.txt`;
        if (!args['dry-run']) fs.writeFileSync(pFile, pLines.join('\n') + '\n');
        rec.perturbedFile = chartFamily(pFile, n, 'perturbed');
        rec.perturbEdits = edits;
      } else console.error(`claim ${n}: no perturbation site in any dependent; negative arm skipped (reported, not invented)`);
    }
  }
  rec.armFiles = arms;
  perClaim.push(rec);
}
function chartFamily(famFile, n, tag) {
  const vf = `${base}_chart_${n}_${tag}.verdicts.json`;
  run([CE, '--index-path', args.index, '--claim-chart', `@${famFile}`, '--claim-family', ...engineArgs, '--force', '--verdicts-out', vf], `${base}_chart_${n}_${tag}.md`);
  return vf;
}
if (args['dry-run']) { console.error('# dry run: no charts executed, nothing scored.'); process.exit(0); }

// 4. Score.
const readJson = (f) => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
for (const rec of perClaim) {
  const entry = (sidecar.claims || []).find((c) => c.n === rec.n);
  for (const [arm, vf] of Object.entries(rec.armFiles || {})) {
    const v = readJson(vf);
    rec.arms[arm] = v ? scoreChart({ claim: entry, verdicts: v, merge: mergeBestPerElement }) : null;
  }
  const cv = readJson(rec.controlFile);
  if (cv) rec.control = scoreControl({ verdicts: cv, merge: mergeBestPerElement });
  const fam = readJson(rec.familyFile);
  const pert = readJson(rec.perturbedFile);
  if (fam && fam.family) rec.dependents = gradeDependents(fam.family, pert ? pert.family : null, rec.perturbEdits || null);
}
const meta = {
  index: args.index, control: args.control || null,
  engine: args.model ? `local GGUF ${args.model}` : args.llm,
  ce: readCeVersion(), generatedAt: new Date().toISOString(),
};
const md = formatScorecard(perClaim, meta);
fs.writeFileSync(`${base}_loop_scorecard.md`, md);
fs.writeFileSync(`${base}_loop_scorecard.json`, JSON.stringify({ meta, perClaim }, null, 1));
console.log(md);
console.error(`# scorecard: ${base}_loop_scorecard.md / .json`);
