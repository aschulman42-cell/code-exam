#!/usr/bin/env node
// hof.mjs — runs the HOF test from one index name as ce subprocesses: the form of 2026-11-03, superseded by `ce --hof` and kept until the parity run retires it
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * hof.mjs — "huffing our own fumes" in one command, as `ce` subprocesses.
 *
 * SUPERSEDED (hof-cli-command, 2026-11-09): `ce --ndx <index> --hof` runs the
 * same test in-process, with a whole-run cost preflight, its files beside the
 * index, an optional --synonymize-with step and a "How to read this" footer.
 * Everything model-free that this script and the command share lives in
 * src/core/hof.js and is imported here, so the two forms read the same files
 * the same way and print the same report. This script stays until a parity
 * run (the same drafts located by both, --claims, ladder totals equal) retires
 * it; the item's draft records that run as not done, since this session had
 * no API key.
 *
 * Andrew, 2026-11-03: "a simple HOF script that, for a single index named on
 * the command line, will generate pseudo-claims (and its underlying
 * path/file@funcs), then do claim-locate on those pseudo-claims, and compare
 * the before and after path/file@funcs." Rank is information in the report,
 * never a floor; the drafting rules can be run as they stood before
 * 2026-11-01; the model is a choice.
 *
 * Every step is a `ce` subprocess exactly as a user would type it, echoed
 * before it runs, so nothing in src/ is measured through a side door:
 *
 *   1. --pseudo-claims --candidates <out>/cand.lst        (the grouper, no model;
 *      --rank --llm X adds the [P..] tags, one model call)
 *   2. --pseudo-claims @<out>/cand.lst --llm X --claims-only <out>/claims.txt
 *      --min-rank 0 --form-rules <mode> [--claim-class <c>]
 *   3. per claim n: --claim-locate @<out>/claim_N.txt --llm X
 *      --targets-out <out>/locate_N.txt [--blind] [--runs n] [--include-tests]
 *   4. the comparison, no model (src/core/hof.js).
 *
 * USAGE
 *   node scripts/hof.mjs --index-path <dir> (--llm claude|chatgpt|gemini | --model <gguf>)
 *        [--out <dir>] [--rank] [--form-rules current|2026-10]
 *        [--claim-class method|system|both|apparatus|crm|auto|all]
 *        [--limit N] [--filter <text>] [--blind] [--runs n] [--include-tests]
 *        [--claims <claims.txt>] [--dry-run] [--force]
 *
 *   --include-tests        passed to the locate step only: admit test, mock, bench
 *                          and example symbols as candidates.
 *   --claims <claims.txt>  skip steps 1 and 2: locate an existing claims file
 *                          (its .anchors.json sidecar beside it), so the same
 *                          drafts can be located with a second model and the
 *                          two reports compared.
 *   --limit N              draft and locate the first N groups of the list.
 *   --dry-run              run the grouper (no model, no cost) for the group
 *                          count, print every other command and the cost
 *                          figures the docs carry, and send nothing to a model.
 *   --force                passed through to each ce command; CodeExam's own
 *                          $2 cost guard applies per command otherwise.
 *   --out <dir>            default %LOCALAPPDATA%\CodeExam\hof\<index>_<yymmdd-HHMM>
 *                          (the command's default is <index>/hof/<yymmdd-HHMM>)
 *
 * Output: the table on stdout, the same in <out>/hof_report.md, the raw
 * records in <out>/hof_report.json, every ce command's output in <out>/logs/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FORM_RULES, LADDER, WHERE, outPaths, runStamp, quoteArg, echoLine, modelArgs, buildCommands,
  readClaims, readTargets, baseName, parseTargetSpec, parseCandidateGroups, limitCandidates,
  parseSidecar, joinRank, candFromSidecarCommand, normName, enclosingClass, sameFunction,
  scoreClaim, totalsOf, renderTable, renderMarkdown,
} from '../src/core/hof.js';

// The shared parts, re-exported so the test and hof-stage1.mjs keep their imports.
export {
  FORM_RULES, LADDER, WHERE, outPaths, quoteArg, echoLine, modelArgs, buildCommands,
  readClaims, readTargets, baseName, parseTargetSpec, parseCandidateGroups, limitCandidates,
  parseSidecar, joinRank, normName, enclosingClass, sameFunction, scoreClaim, totalsOf,
  renderTable, renderMarkdown,
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = path.join(HERE, '..', 'src', 'index.js');

export const USAGE = [
  'usage: node scripts/hof.mjs --index-path <dir> (--llm claude|chatgpt|gemini | --model <gguf>)',
  '            [--out <dir>] [--rank] [--form-rules current|2026-10]',
  '            [--claim-class method|system|both|apparatus|crm|auto|all]',
  '            [--limit N] [--filter <text>] [--blind] [--runs n] [--include-tests]',
  '            [--claims <claims.txt>] [--dry-run] [--force]',
  '',
  '  Superseded by `ce --ndx <index> --hof` (2026-11-09), the same test in one process.',
  '  Draft pseudo-claims from the index, locate each with --claim-locate, and score the',
  '  drafter\'s anchors against the located targets: function / class / file / miss per',
  '  anchor, exact / near / elsewhere per target. Rank ([P..]) is reported, never a floor.',
  '  --claims <file> locates an existing claims file (sidecar beside it) and skips drafting.',
  '  --dry-run runs the grouper only (no model) and prints the rest with cost figures.',
].join('\n');

// ---------------------------------------------------------------- arguments

export function parseOwnArgs(argv) {
  const o = {
    indexPath: null, llm: null, model: null, out: null, rank: false, formRules: 'current',
    claimClass: null, limit: null, filter: null, blind: false, runs: null, claims: null,
    includeTests: false,
    dryRun: false, force: false, node: process.execPath, cli: DEFAULT_CLI, help: false,
  };
  const need = (i, flag) => {
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--index-path') o.indexPath = need(i++, a);
    else if (a === '--llm') o.llm = need(i++, a);
    else if (a === '--model') o.model = need(i++, a);
    else if (a === '--out') o.out = need(i++, a);
    else if (a === '--rank') o.rank = true;
    else if (a === '--form-rules') o.formRules = need(i++, a);
    else if (a === '--claim-class') o.claimClass = need(i++, a);
    else if (a === '--limit') o.limit = Number(need(i++, a));
    else if (a === '--filter') o.filter = need(i++, a);
    else if (a === '--blind') o.blind = true;
    else if (a === '--runs') o.runs = Number(need(i++, a));
    else if (a === '--claims') o.claims = need(i++, a);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--include-tests') o.includeTests = true;
    else if (a === '--node') o.node = need(i++, a);
    else if (a === '--cli') o.cli = need(i++, a);
    else throw new Error(`unknown option: ${a}`);
  }
  if (o.help) return o;
  if (!o.indexPath) throw new Error('--index-path <dir> is required');
  if (!o.llm && !o.model) throw new Error('one of --llm <name> or --model <gguf> is required');
  if (o.llm && o.model) throw new Error('--llm and --model are alternatives; give one');
  if (!FORM_RULES.includes(o.formRules)) throw new Error(`--form-rules must be ${FORM_RULES.join(' or ')}, got "${o.formRules}"`);
  if (o.limit != null && !(Number.isInteger(o.limit) && o.limit > 0)) throw new Error('--limit needs a positive integer');
  if (o.runs != null && !(Number.isInteger(o.runs) && o.runs > 0)) throw new Error('--runs needs a positive integer');
  if (o.claims && (o.rank || o.limit != null || o.filter)) throw new Error('--claims skips drafting; --rank, --limit and --filter do not apply');
  return o;
}

export function defaultOutDir(indexPath, now = new Date()) {
  const base = path.basename(path.resolve(indexPath)).replace(/^\.+/, '') || 'index';
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(root, 'CodeExam', 'hof', `${base}_${runStamp(now)}`);
}

// ---------------------------------------------------------------- the run

function runCe(o, args, logPath) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = fs.createWriteStream(logPath);
    log.write(`${echoLine(args)}\n\n`);
    const child = spawn(o.node, [o.cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); log.write(d); });
    child.stderr.on('data', (d) => { err += d; process.stderr.write(d); log.write(d); });
    child.on('close', (code) => {
      log.end(`\n[exit ${code}]\n`);
      resolve({ args, code, ms: Date.now() - started, stdout: out, stderr: err });
    });
    child.on('error', (e) => {
      log.end(`\n[spawn error: ${e.message}]\n`);
      resolve({ args, code: -1, ms: Date.now() - started, stdout: out, stderr: `${err}${e.message}` });
    });
  });
}

export function dryRunLines(o, cmds, groupCount) {
  const n = groupCount == null ? '?' : groupCount;
  const drafted = o.limit && groupCount != null ? Math.min(o.limit, groupCount) : (o.limit || groupCount);
  const calls = (drafted == null ? null : drafted * (o.runs || 1));
  const out = [];
  out.push('', `dry run: ${n} candidate group(s)${o.limit ? `, the first ${o.limit} drafted` : ''}; nothing is sent to a model.`, '');
  out.push('Would run:', `  ${echoLine(cmds.draft)}`, `  ${echoLine(cmds.locate('N'))}   (N = 1..${drafted ?? '?'})`, '');
  out.push('Cost, from the docs (one model, one sample each; your run is its own number):');
  if (o.rank) out.push('  --rank: $0.12 for 57 groups, $1.62 for 959 (Claude Sonnet 4.6, 2026-10-24; docs/CODEEXAM_PSEUDO_CLAIMS.md).');
  out.push('  drafting: CodeExam projects its own cost per run and prints it before the first call;');
  out.push('    its $2 guard stops a run above that unless --force (or CE_CLAIMS_COST_GUARD=<usd>).');
  out.push(`  locating: a few cents a call (docs/claim-chart-agreement.md, 2026-10-21; 33 calls projected at $0.66,`);
  out.push(`    docs/CODEEXAM_CLAIM_CHARTS.md): ${calls == null ? '?' : calls} call(s)${o.runs ? ` (${drafted} claim(s) × --runs ${o.runs})` : ''} ≈ $${calls == null ? '?' : (0.02 * calls).toFixed(2)}.`);
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  let o;
  try { o = parseOwnArgs(argv); } catch (e) { console.error(`hof: ${e.message}\n\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  if (!fs.existsSync(o.indexPath)) { console.error(`hof: --index-path ${o.indexPath}: no such directory`); return 2; }
  if (!fs.existsSync(o.cli)) { console.error(`hof: CodeExam entry point not found at ${o.cli} (--cli <path>)`); return 2; }

  const out = o.out || defaultOutDir(o.indexPath);
  const P = outPaths(out);
  fs.mkdirSync(P.logs, { recursive: true });
  const steps = [];
  const step = async (name, args) => {
    console.log(`\n${echoLine(args)}`);
    const r = await runCe(o, args, path.join(P.logs, `${name}.txt`));
    steps.push({ name, args, code: r.code, ms: r.ms });
    return r;
  };
  console.log(`hof: output under ${out}`);

  let claimsPath = P.claims, sidecarPath = P.sidecar, candPath = P.cand;
  if (o.claims) {
    claimsPath = path.resolve(o.claims);
    sidecarPath = `${claimsPath}.anchors.json`;
    if (!fs.existsSync(claimsPath) || !fs.existsSync(sidecarPath)) {
      console.error(`hof: --claims needs ${claimsPath} and its sidecar ${sidecarPath}`);
      return 2;
    }
    candPath = null;
  }
  const cmds = buildCommands(o, P);

  if (!o.claims) {
    // Step 1: the grouper (no model) — with --rank, one model call for the tags.
    // In a dry run the tags are skipped too, so the count costs nothing.
    const candArgs = o.dryRun ? buildCommands({ ...o, rank: false }, P).candidates : cmds.candidates;
    const r1 = await step('1-candidates', candArgs);
    if (r1.code !== 0 || !fs.existsSync(P.cand)) { console.error(`\nhof: step 1 failed (exit ${r1.code}); see ${path.join(P.logs, '1-candidates.txt')}`); return 1; }
    const groups = parseCandidateGroups(fs.readFileSync(P.cand, 'utf8'));
    console.log(`\nhof: ${groups.length} candidate group(s) in ${P.cand}${groups.some((g) => g.priority != null) ? ' (ranked)' : ''}`);
    if (o.limit && groups.length > o.limit) {
      P.draftFrom = path.join(out, `cand_first${o.limit}.lst`);
      fs.writeFileSync(P.draftFrom, limitCandidates(fs.readFileSync(P.cand, 'utf8'), o.limit), 'utf8');
      console.log(`hof: --limit ${o.limit}: drafting from ${P.draftFrom}`);
    }
    const cmds2 = buildCommands(o, P);
    if (o.dryRun) { for (const l of dryRunLines(o, cmds2, groups.length)) console.log(l); return 0; }
    // Step 2: the drafter.
    const r2 = await step('2-draft', cmds2.draft);
    if (r2.code !== 0 || !fs.existsSync(P.sidecar)) { console.error(`\nhof: step 2 failed (exit ${r2.code}); see ${path.join(P.logs, '2-draft.txt')}`); return 1; }
  } else if (o.dryRun) {
    const sc = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    for (const l of dryRunLines(o, cmds, (sc.claims || []).length)) console.log(l);
    return 0;
  }

  // The answer key: the sidecar (claim text and anchors), rank joined.
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  let claims = parseSidecar(sidecar);
  const fileClaims = readClaims(fs.readFileSync(claimsPath, 'utf8'));
  if (fileClaims.length !== claims.length) {
    console.error(`hof: ${claimsPath} has ${fileClaims.length} claim line(s), its sidecar ${claims.length}; locating the sidecar's claims`);
  }
  if (!candPath) candPath = candFromSidecarCommand(sidecar, path.dirname(claimsPath), (p) => fs.existsSync(p));
  const candGroups = candPath && fs.existsSync(candPath) ? parseCandidateGroups(fs.readFileSync(candPath, 'utf8')) : null;
  claims = joinRank(claims, candGroups);
  if (!claims.length) { console.error('hof: the sidecar carries no claims; nothing to locate'); return 1; }

  // Step 3: locate each claim.
  const rows = [];
  for (const c of claims) {
    fs.writeFileSync(P.claim(c.n), `${c.claim}\n`, 'utf8');
    if (fs.existsSync(P.locate(c.n))) fs.unlinkSync(P.locate(c.n));
    const r = await step(`3-locate-${c.n}`, cmds.locate(c.n));
    let error = null;
    if (r.code !== 0) error = `claim-locate exit ${r.code}`;
    const targets = fs.existsSync(P.locate(c.n)) ? readTargets(fs.readFileSync(P.locate(c.n), 'utf8')).map(parseTargetSpec) : [];
    if (!error && !targets.length) error = 'no targets written';
    const s = scoreClaim(c.anchors, targets);
    rows.push({ ...c, ...s, located: targets.length, anchorsN: c.anchors.length, error });
  }

  // Step 4: the comparison, no model.
  const tableRows = rows.map((r) => ({ n: r.n, priority: r.priority, label: r.label, anchors: r.anchorsN, located: r.located, rungs: r.rungs, where: r.where, error: r.error }));
  const report = {
    format: 'ce-hof-report', version: 1, generated: new Date().toISOString(), tool: 'scripts/hof.mjs',
    ce: sidecar.ce || '', index: path.basename(path.resolve(o.indexPath)), indexPath: path.resolve(o.indexPath),
    options: { llm: o.llm, model: o.model, formRules: o.formRules, claimClass: o.claimClass, rank: o.rank, limit: o.limit, filter: o.filter, blind: o.blind, runs: o.runs, includeTests: o.includeTests, claims: o.claims, force: o.force },
    steps,
    claims: rows.map((r) => ({ n: r.n, groupN: r.groupN, label: r.label, priority: r.priority, rankFrom: r.rankFrom, claim: r.claim, truncated: r.truncated, error: r.error, anchors: r.anchors, targets: r.targets, rungs: r.rungs, where: r.where })),
    totals: totalsOf(tableRows),
  };
  fs.writeFileSync(P.reportJson, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(P.reportMd, renderMarkdown(report), 'utf8');
  console.log(`\n${renderTable(tableRows)}`);
  console.log(`\nhof: report in ${P.reportMd} (records in ${P.reportJson}; ce output in ${P.logs})`);
  return steps.some((s) => s.code !== 0) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code; });
}
