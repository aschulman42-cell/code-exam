// hof.js — --hof: the HOF self-test in one command, in-process: draft every candidate group, locate each draft, score the round trip
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * hof-cli-command (2026-11-09). Andrew: "I realize HOF is mostly a self-test,
 * but users may need it to increase their understanding of features they're
 * relying on ... It would be convenient to me to have as CE --cli options,
 * apart from the .mjs scripts."
 *
 *   ce --ndx <index> --hof (--llm <provider> | --model <gguf>)
 *        [--limit N] [--filter <text>] [--rank] [--form-rules current|2026-10]
 *        [--claim-class <c>] [--blind] [--runs n] [--include-tests]
 *        [--synonymize-with <provider|gguf>] [--claims <claims.txt>]
 *        [--hof-out <dir>] [--dry-run] [--force]
 *
 * The four questions the item settled, each a section of its draft:
 *
 *  1. Scope and cost: a whole-run preflight. The grouper runs (no model), the
 *     command prints the group count, the model calls to come and their
 *     projected cost through the $2 claims guard, and stops unless under it or
 *     --force; --limit and --filter narrow; --dry-run prints the plan only.
 *  2. Where results go: <index>/hof/<yymmdd-HHMM>/, beside the index, since the
 *     run's files are PO material where the index is; --hof-out overrides; a
 *     .zip index is refused without it.
 *  3. What the number means: without --synonymize-with the claims are located
 *     in the drafter's own words (the easier case) and the report says so; with
 *     it, a second engine rewrites every draft, anchors withheld, before the
 *     locator sees it. A fixed "How to read this" footer closes every report.
 *  4. Registration: argparse, index.js, this module and src/core/hof.js; the
 *     subprocess script stays until a parity run retires it.
 *
 * Every step is the equivalent of a ce command, echoed before it runs and
 * logged under logs/, so a user can reproduce any step by hand; the index
 * loads once instead of once per step.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CE_VERSION } from '../version.js';
import { resolveModel, makeDrafter, claimsCostGate, projectCloudCost, describeEngine, resetCloudUsage, actualCostLine } from '../core/llm-runner.js';
import {
  FORM_RULES, outPaths, runDirFor, buildCommands, echoLine, readClaims, readTargets, parseTargetSpec,
  parseCandidateGroups, limitCandidates, parseSidecar, joinRank, candFromSidecarCommand,
  scoreClaim, totalsOf, preflightCalls, planLines, renderTable, renderMarkdown, howToReadText,
} from '../core/hof.js';

/** The option object from the parsed flags; throws on what cannot run. */
export function hofOptions(args) {
  const o = {
    indexPath: args.index_path, llm: args.llm || null, model: args.model || null,
    formRules: args.form_rules || 'current', claimClass: args._explicit && args._explicit.has('claim_class') ? args.claim_class : null,
    rank: !!args.rank, limit: args.limit == null ? null : Number(args.limit), filter: args.filter ? String(args.filter) : null,
    blind: !!args.blind, runs: args.runs == null ? null : Number(args.runs), includeTests: !!args.include_tests,
    claims: args.hof_claims ? String(args.hof_claims) : null, dryRun: !!args.dry_run, force: !!args.force,
    synonymizeWith: args.synonymize_with ? String(args.synonymize_with) : null, hofOut: args.hof_out ? String(args.hof_out) : null,
  };
  if (!o.indexPath) throw new Error('--hof needs an index: --ndx <path>');
  if (!o.llm && !o.model) throw new Error('--hof needs a model: --llm <provider> or --model <gguf>');
  if (o.llm && o.model) throw new Error('--llm and --model are alternatives; give one');
  if (!FORM_RULES.includes(o.formRules)) throw new Error(`--form-rules must be ${FORM_RULES.join(' or ')}, got "${o.formRules}"`);
  if (o.limit != null && !(Number.isInteger(o.limit) && o.limit > 0)) throw new Error('--limit needs a positive integer');
  if (o.runs != null && !(Number.isInteger(o.runs) && o.runs > 0)) throw new Error('--runs needs a positive integer');
  if (o.claims && (o.rank || o.limit != null || o.filter)) throw new Error('--claims skips drafting; --rank, --limit and --filter do not apply');
  if (o.synonymizeWith && !/\.gguf$/i.test(o.synonymizeWith) && !/^[a-z0-9_-]+$/i.test(o.synonymizeWith)) throw new Error('--synonymize-with takes a provider name (claude, chatgpt, gemini) or a path to a .gguf');
  return o;
}

/** The args the synonymizer resolves its engine from: the named provider or GGUF, everything else as given. */
export function synonymizerArgs(args, synonymizeWith) {
  const gguf = /\.gguf$/i.test(synonymizeWith);
  return { ...args, llm: gguf ? null : synonymizeWith, model: gguf ? synonymizeWith : null, claim_model: null, analyze_model: null };
}

/**
 * One claim rewritten away from the code's vocabulary: the drafter's elements
 * through synonymizeElements with the second engine, anchors withheld (the
 * function sees text only), re-joined one limitation per line so --claim-locate
 * splits it as drafted. Returns the text, the mean vocabulary kept and the
 * failed limitations (kept in the original wording).
 */
export async function synonymizeClaim(claimText, draft, { splitClaimElements, synonymizeElements }) {
  const elements = splitClaimElements(claimText);
  const rows = await synonymizeElements({ draft, elements });
  const text = rows.map((r) => r.rewritten).join('\n');
  const overlaps = rows.filter((r) => !r.error).map((r) => r.overlap.pct);
  const overlap = overlaps.length ? Math.round(overlaps.reduce((a, b) => a + b, 0) / overlaps.length) : null;
  return { text, overlap, failed: rows.filter((r) => r.error).length, elements: rows.length };
}

/** Run `fn` with stdout and stderr also written to `logPath`, the subprocess log the script kept. */
async function withLog(logPath, fn) {
  const outW = process.stdout.write.bind(process.stdout);
  const errW = process.stderr.write.bind(process.stderr);
  const fd = fs.openSync(logPath, 'w');
  const tap = (orig) => (chunk, ...rest) => {
    try { fs.writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk)); } catch { /* the log is a copy */ }
    return orig(chunk, ...rest);
  };
  process.stdout.write = tap(outW);
  process.stderr.write = tap(errW);
  try { return await fn(); } finally {
    process.stdout.write = outW;
    process.stderr.write = errW;
    fs.closeSync(fd);
  }
}

export async function doHof(index, args, seams = {}) {
  let o;
  try { o = hofOptions(args); } catch (e) { console.error(`--hof: ${e.message}`); process.exitCode = 2; return; }
  const model = resolveModel(args);
  if (!model) { console.error('--hof needs a model: --llm <provider> or --model <gguf>.'); process.exitCode = 1; return; }
  if (model.kind === 'error') { console.error(`Error: ${model.error}`); process.exitCode = 1; return; }
  let synModel = null;
  if (o.synonymizeWith) {
    synModel = resolveModel(synonymizerArgs(args, o.synonymizeWith));
    if (!synModel || synModel.kind === 'error') { console.error(`--synonymize-with: ${synModel ? synModel.error : `cannot resolve "${o.synonymizeWith}"`}`); process.exitCode = 1; return; }
  }
  let out;
  try { out = runDirFor(o.indexPath, o.hofOut); } catch (e) { console.error(`--hof: ${e.message}`); process.exitCode = 2; return; }
  const P = outPaths(out);
  fs.mkdirSync(P.logs, { recursive: true });
  console.log(`hof: output under ${out}`);

  const { doEmitCandidates, doPseudoClaims } = seams.pseudoClaims || await import('./pseudo-claims.js');
  const { doClaimLocate, splitClaimElements } = seams.claimLocate || await import('./claim-locate.js');
  const { synonymizeElements } = seams.synonymize || await import('./synonymize.js');

  const steps = [];
  // Each step: the equivalent ce command echoed, run in-process with its output
  // also in logs/<name>.txt, its outcome read from process.exitCode and the file
  // it was to write.
  const step = async (name, argv, fn, expectFile = null) => {
    console.log(`\n${echoLine(argv)}`);
    const before = process.exitCode;
    const started = Date.now();
    let threw = null;
    await withLog(path.join(P.logs, `${name}.txt`), async () => { try { await fn(); } catch (e) { threw = e; console.error(`hof: ${name}: ${e.message}`); } });
    const failed = threw != null || (process.exitCode && process.exitCode !== before) || (expectFile && !fs.existsSync(expectFile));
    process.exitCode = before;
    const s = { name, args: argv, code: failed ? 1 : 0, ms: Date.now() - started };
    steps.push(s);
    return s;
  };

  let claimsPath = P.claims, sidecarPath = P.sidecar, candPath = P.cand;
  if (o.claims) {
    claimsPath = path.resolve(o.claims);
    sidecarPath = `${claimsPath}.anchors.json`;
    if (!fs.existsSync(claimsPath) || !fs.existsSync(sidecarPath)) {
      console.error(`--hof --claims needs ${claimsPath} and its sidecar ${sidecarPath}`);
      process.exitCode = 2; return;
    }
    candPath = null;
  }
  let cmds = buildCommands(o, P);
  let groupCount = null;

  if (!o.claims) {
    // Step 1: the grouper (no model); with --rank, one model call for the tags,
    // skipped in a dry run so the count costs nothing.
    const rankNow = o.rank && !o.dryRun;
    const candArgv = buildCommands({ ...o, rank: rankNow }, P).candidates;
    const s1 = await step('1-candidates', candArgv, () => doEmitCandidates(index, {
      ...args, candidates: P.cand, filter: o.filter, rank: rankNow, pseudo_claims: null, claims_only: null, ground_truth: null, hof: false, dry_run: false,
    }), P.cand);
    if (s1.code !== 0) { console.error(`\nhof: step 1 failed; see ${path.join(P.logs, '1-candidates.txt')}`); process.exitCode = 1; return; }
    const groups = parseCandidateGroups(fs.readFileSync(P.cand, 'utf8'));
    groupCount = groups.length;
    console.log(`\nhof: ${groups.length} candidate group(s) in ${P.cand}${groups.some((g) => g.priority != null) ? ' (ranked)' : ''}`);
    if (!groups.length) { console.error('hof: no candidate groups; nothing to draft'); process.exitCode = 1; return; }
    if (o.limit && groups.length > o.limit) {
      P.draftFrom = path.join(out, `cand_first${o.limit}.lst`);
      fs.writeFileSync(P.draftFrom, limitCandidates(fs.readFileSync(P.cand, 'utf8'), o.limit), 'utf8');
      console.log(`hof: --limit ${o.limit}: drafting from ${P.draftFrom}`);
    }
    cmds = buildCommands(o, P);
  } else {
    const sc = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    groupCount = (sc.claims || []).length;
  }

  // The preflight: the whole run's calls priced once, through the same guard
  // every claims command uses, before the first call; the plan under --dry-run.
  const counts = preflightCalls(o, groupCount);
  const cloud = model.kind === 'cloud';
  const projection = cloud ? projectCloudCost(model, counts.calls) : null;
  if (o.dryRun) {
    for (const l of planLines(o, cmds, groupCount, counts, { usd: projection ? projection.usd : null, modelLabel: describeEngine(model) })) console.log(l);
    return;
  }
  const label = `hof: ${counts.drafts} draft(s)${counts.rewrites ? `, about ${counts.rewrites} rewrite(s)` : ''}, ${counts.locates} locate run(s), an estimate`;
  if (!claimsCostGate(model, counts.calls, label, args)) {
    console.error('#   --limit N and --filter <text> narrow a --hof run; --dry-run prints the plan.');
    process.exitCode = 1; return;
  }

  if (!o.claims) {
    // Step 2: the drafter, through its own exact projection and gate.
    const s2 = await step('2-draft', cmds.draft, () => doPseudoClaims(index, {
      ...args, pseudo_claims: `@${P.draftFrom || P.cand}`, candidates: null, rank: false, ground_truth: null,
      claims_only: P.claims, pseudo_out: P.artifact, min_rank: '0', form_rules: o.formRules,
      ...(o.claimClass ? { claim_class: o.claimClass } : {}), filter: null, hof: false, dry_run: false,
    }), P.sidecar);
    if (s2.code !== 0) { console.error(`\nhof: step 2 failed; see ${path.join(P.logs, '2-draft.txt')}`); process.exitCode = 1; return; }
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
  if (!claims.length) { console.error('hof: the sidecar carries no claims; nothing to locate'); process.exitCode = 1; return; }

  // Step 2b: the synonymizer, when named: every draft rewritten away from the
  // code's vocabulary by the second engine, anchors withheld, before the
  // locator sees it; the original kept beside it.
  const rewrites = new Map();
  if (synModel) {
    let synDraft;
    try { synDraft = seams.synDraft || makeDrafter(synModel, 0); } catch (e) { console.error(`--synonymize-with: ${e.message}`); process.exitCode = 1; return; }
    resetCloudUsage();
    for (const c of claims) {
      fs.writeFileSync(P.claimOrig(c.n), `${c.claim}\n`, 'utf8');
      const s = await step(`2b-synonymize-${c.n}`, cmds.synonymize(c.n), async () => {
        const r = await synonymizeClaim(c.claim, synDraft, { splitClaimElements, synonymizeElements });
        fs.writeFileSync(P.claim(c.n), `${r.text}\n`, 'utf8');
        rewrites.set(c.n, r);
        console.log(`hof: claim ${c.n}: ${r.elements} limitation(s) rewritten${r.failed ? `, ${r.failed} kept as drafted` : ''}${r.overlap != null ? `; ${r.overlap}% of the vocabulary kept` : ''}`);
      }, P.claim(c.n));
      if (s.code !== 0) rewrites.set(c.n, { text: c.claim, overlap: null, failed: -1, elements: 0, error: 'synonymize failed' });
    }
    const synCost = actualCostLine(synModel);
    if (synCost) process.stderr.write(`${synCost} (synonymizer)\n`);
  }

  // Step 3: locate each claim, in the drafter's words or the synonymizer's.
  const rows = [];
  for (const c of claims) {
    if (!synModel) fs.writeFileSync(P.claim(c.n), `${c.claim}\n`, 'utf8');
    if (fs.existsSync(P.locate(c.n))) fs.unlinkSync(P.locate(c.n));
    const s = await step(`3-locate-${c.n}`, cmds.locate(c.n), () => doClaimLocate(index, {
      ...args, claim_locate: `@${P.claim(c.n)}`, targets_out: P.locate(c.n), blind: o.blind, runs: o.runs, include_tests: o.includeTests,
      pseudo_claims: null, candidates: null, rank: false, ground_truth: null, filter: null, hof: false, dry_run: false,
    }));
    let error = null;
    if (s.code !== 0) error = 'claim-locate failed';
    const targets = fs.existsSync(P.locate(c.n)) ? readTargets(fs.readFileSync(P.locate(c.n), 'utf8')).map(parseTargetSpec) : [];
    if (!error && !targets.length) error = 'no targets written';
    const sc = scoreClaim(c.anchors, targets);
    const rw = rewrites.get(c.n);
    rows.push({ ...c, ...sc, located: targets.length, anchorsN: c.anchors.length, error, rewritten: rw && rw.failed >= 0 ? rw.text : null, overlap: rw ? rw.overlap : null });
  }

  // Step 4: the comparison, no model.
  const tableRows = rows.map((r) => ({ n: r.n, priority: r.priority, label: r.label, anchors: r.anchorsN, located: r.located, rungs: r.rungs, where: r.where, error: r.error }));
  const report = {
    format: 'ce-hof-report', version: 2, generated: new Date().toISOString(), tool: 'ce --hof',
    ce: CE_VERSION, index: path.basename(path.resolve(o.indexPath)), indexPath: path.resolve(o.indexPath), runDir: out,
    options: { llm: o.llm, model: o.model, formRules: o.formRules, claimClass: o.claimClass, rank: o.rank, limit: o.limit, filter: o.filter, blind: o.blind, runs: o.runs, includeTests: o.includeTests, claims: o.claims, force: o.force, synonymizeWith: o.synonymizeWith, hofOut: o.hofOut },
    engines: { drafter: o.claims ? (sidecar.engine || 'the claims file\'s') : describeEngine(model), synonymizer: synModel ? describeEngine(synModel) : null, locator: describeEngine(model) },
    preflight: { drafts: counts.drafts, rewrites: counts.rewrites, locates: counts.locates, projectedUsd: projection ? projection.usd : null },
    steps,
    claims: rows.map((r) => ({ n: r.n, groupN: r.groupN, label: r.label, priority: r.priority, rankFrom: r.rankFrom, claim: r.claim, rewritten: r.rewritten, overlap: r.overlap, truncated: r.truncated, error: r.error, anchors: r.anchors, targets: r.targets, rungs: r.rungs, where: r.where })),
    totals: totalsOf(tableRows),
  };
  fs.writeFileSync(P.reportJson, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(P.reportMd, renderMarkdown(report), 'utf8');
  console.log(`\n${renderTable(tableRows)}`);
  console.log(`\n${howToReadText()}`);
  console.log(`\nhof: report in ${P.reportMd} (records in ${P.reportJson}; each step's output in ${P.logs})`);
  if (steps.some((s) => s.code !== 0)) process.exitCode = 1;
}
