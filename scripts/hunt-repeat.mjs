#!/usr/bin/env node
// hunt-repeat.mjs — run the same `--claim-locate --hunt` invocation N times and
// report a DISTRIBUTION instead of an anecdote.
//
// WHY. Two blind Gemini runs of the same command on the same claim produced
// opposite outcomes: run 1 quit after 3 of 24 allowed tool calls and invented
// three symbol names; run 2 issued 32 calls, concluded on its own, reached the
// claimed mechanism, and fabricated nothing. The budget flags were NOT the
// difference — run 1 never approached its ceiling. Whether the model keeps
// hunting after early searches come back empty is the variable, and it is
// stochastic.
//
// So a single run cannot support a claim about a model's capability. That
// matters most for the local-GGUF path, where one bad run would be read as
// "the small model can't do this" and one good run would be over-trusted.
//
// DESIGN. This invokes the CLI as a subprocess exactly as a user would and
// parses only the PUBLIC report. Nothing in src/ changes, so the thing being
// measured is unmodified by the measurement.
//
// NO EXPECTED ANSWER IS BUILT IN. Target symbols come from --expect, and are
// optional: on a corpus with no known answer (the real use case) the harness
// reports distributions only. A harness that hard-coded ExoPlayer symbols would
// be measuring its author's memory, which is the contamination this project has
// already been bitten by three times.
//
// USAGE
//   node scripts/hunt-repeat.mjs --runs 5 --out runs/gemini \
//     -- --index-path .Foo --claim-locate @claim.txt --hunt --blind --llm gemini
//
//   Everything after `--` is passed through to the CLI verbatim.
//   --expect "Sym::a,Sym::b"   count how often any of these was located
//   --node <path>              node binary (default: this one)
//   --cli <path>               entry point (default: src/index.js beside this)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = path.join(HERE, '..', 'src', 'index.js');

// Harness-owned options, each taking one value. `--out-dir` rather than `--out`
// because CE HAS its own `--out`: with a shared name, the auto-split below
// could not tell whose it was.
const OWN = new Set(['--runs', '--out-dir', '--expect', '--node', '--cli']);

export function parseOwnArgs(argv) {
  const o = {
    runs: 5, out: null, expect: [], node: process.execPath, cli: DEFAULT_CLI,
    passthrough: [], inferred: false,
  };
  const sep = argv.indexOf('--');
  let mine;
  if (sep >= 0) {
    mine = argv.slice(0, sep);
    o.passthrough = argv.slice(sep + 1);
  } else {
    // No separator. Rather than reject the whole command with "unknown option:
    // --index-path" — which says nothing about the real problem — split by NAME:
    // the harness's options are a small fixed set, everything else is CE's.
    // Losing the `--` is easy and the resulting error was actively misleading.
    o.inferred = true;
    mine = [];
    for (let i = 0; i < argv.length; i++) {
      if (OWN.has(argv[i])) { mine.push(argv[i], argv[i + 1]); i++; }
      else o.passthrough.push(argv[i]);
    }
  }
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i];
    if (a === '--runs') o.runs = Number(mine[++i]);
    else if (a === '--out-dir' || a === '--out') o.out = mine[++i];
    else if (a === '--expect') o.expect = String(mine[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--node') o.node = mine[++i];
    else if (a === '--cli') o.cli = mine[++i];
    else {
      console.error(`unknown option: ${a}\n`
        + `harness options are ${[...OWN].join(', ')}; everything for the CE command goes after --`);
      process.exit(2);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Report parsing. Reads only what the command already prints.
// ---------------------------------------------------------------------------

export function parseRun(stdout) {
  const text = String(stdout || '');
  const r = {
    toolCalls: null, rounds: null, ended: null,
    proposed: [], navigated: [], rejected: [],
    verified: null, ofProposals: null, notFound: null, ambiguous: null,
    fnScale: null, fnScaleOf: null,
    ungrounded: false,
    elements: new Set(),
  };
  const hunt = text.match(/^Hunt: (\d+) tool call\(s\) over (\d+) round\(s\); ended: (\S+)/m);
  if (hunt) { r.toolCalls = +hunt[1]; r.rounds = +hunt[2]; r.ended = hunt[3]; }
  // Derive "searched nothing" from the CALL COUNT, not only from the report's
  // warning text. A run that selects nothing never reaches the report at all,
  // so it carries no warning — the first live sweep had a 0-call run counted
  // as "not ungrounded", which is precisely backwards.
  r.ungrounded = /UNGROUNDED/.test(text) || r.toolCalls === 0;

  // Rows carry "proposed as: X" or "reached by navigation from Y"; the claim
  // element appears on its own line just above.
  const lines = text.split(/\r?\n/);
  let element = null;
  for (const line of lines) {
    const el = line.match(/^\s+claim element (\d+)\s*$/);
    if (el) { element = +el[1]; continue; }
    const p = line.match(/^\s+proposed as: (.+?)(?:\s+\(refine round\))?\s*$/);
    if (p) { r.proposed.push({ name: p[1].trim(), element }); if (element) r.elements.add(element); continue; }
    if (/^\s+reached by navigation from /.test(line)) r.navigated.push({ element });
  }

  // Rejected block: indented names following the REJECTED heading.
  const rej = text.split(/^\s+REJECTED — .*$/m)[1];
  if (rej) {
    for (const line of rej.split(/\r?\n/)) {
      const m = line.match(/^\s{4}([A-Za-z_][\w:.$]*)(?:\s+\[element (\d+)\])?\s*$/);
      if (m) r.rejected.push({ name: m[1], element: m[2] ? +m[2] : null });
      else if (/^\s*$/.test(line) || /^\s{4}These were not/.test(line) || /^\s{4}substring/.test(line)) continue;
      else break;
    }
  }

  const ver = text.match(/^\s+Verified (\d+) of (\d+) proposals/m);
  if (ver) { r.verified = +ver[1]; r.ofProposals = +ver[2]; }
  const spec = text.match(/^\s+Specificity: (\d+)\/(\d+) model-proposed/m);
  if (spec) { r.fnScale = +spec[1]; r.fnScaleOf = +spec[2]; }
  const tail = text.match(/^\s+(\d+) ambiguous name\(s\); (\d+) not found/m);
  if (tail) { r.ambiguous = +tail[1]; r.notFound = +tail[2]; }
  return r;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');

// Did a run name this target? Models cite the same function qualified or bare —
// the first live sweep proposed `determineIdealSelectedIndex` where the target
// was `AdaptiveTrackSelection::determineIdealSelectedIndex`, and one-directional
// containment scored that run a MISS. Undercounting a hit is the worse error
// here: it would make a model look less capable than it is, which is exactly
// the misread the local-model test must not make.
const bareName = (s) => String(s || '').replace(/^.*::/, '');
export function namesTarget(proposed, target) {
  if (!proposed || !target) return false;
  if (proposed === target) return true;
  if (proposed.includes(target) || target.includes(proposed)) return true;
  return bareName(proposed) === bareName(target);
}

function summarize(runs, expect) {
  const ok = runs.filter((r) => !r.error);
  const out = [];
  out.push('');
  out.push('='.repeat(72));
  out.push(` REPEAT-RUN SUMMARY — ${ok.length} of ${runs.length} runs completed`);
  out.push('='.repeat(72));
  if (!ok.length) {
    const reasons = [...new Set(runs.map((r) => r.error).filter(Boolean))];
    out.push(`  every run failed. ${reasons.length === 1 ? 'Reason:' : 'Reasons:'}`);
    for (const r of reasons) out.push(`    ${r}`);
    return out;
  }

  const calls = ok.map((r) => r.toolCalls ?? 0);
  out.push(`  tool calls: min ${Math.min(...calls)}, median ${median(calls)}, max ${Math.max(...calls)}`);
  const endings = {};
  for (const r of ok) endings[r.ended || 'unknown'] = (endings[r.ended || 'unknown'] || 0) + 1;
  out.push(`  ended: ${Object.entries(endings).map(([k, v]) => `${k} ${v}`).join(', ')}`);

  const elCounts = ok.map((r) => r.elements.size);
  out.push(`  claim elements cited: min ${Math.min(...elCounts)}, median ${median(elCounts)}, max ${Math.max(...elCounts)}`);

  const fabRuns = ok.filter((r) => r.rejected.length).length;
  const ungrounded = ok.filter((r) => r.ungrounded).length;
  out.push(`  runs with rejected (unseen) selections: ${fabRuns}/${ok.length} (${pct(fabRuns, ok.length)})`);
  out.push(`  runs flagged UNGROUNDED (zero searches): ${ungrounded}/${ok.length}`);
  const notFound = ok.map((r) => r.notFound ?? 0).reduce((a, b) => a + b, 0);
  out.push(`  total NOT FOUND across runs: ${notFound}`);

  if (expect.length) {
    out.push('');
    out.push('  target reach rate (targets supplied by the operator, not by this script;');
    out.push('  a qualified and a bare citation of the same function both count):');
    for (const t of expect) {
      const hits = ok.filter((r) => r.proposed.some((p) => namesTarget(p.name, t))).length;
      out.push(`    ${t}: ${hits}/${ok.length} (${pct(hits, ok.length)})`);
    }
    const any = ok.filter((r) => expect.some((t) => r.proposed.some((p) => namesTarget(p.name, t)))).length;
    out.push(`    ANY target: ${any}/${ok.length} (${pct(any, ok.length)})`);
  }

  out.push('');
  out.push('  per run:');
  out.push('    #  calls  rounds  ended        elems  proposed  rejected  notFound');
  runs.forEach((r, i) => {
    if (r.error) { out.push(`    ${i + 1}  ERROR: ${r.error}`); return; }
    out.push(`    ${String(i + 1).padEnd(2)} ${String(r.toolCalls ?? '-').padStart(5)} ${String(r.rounds ?? '-').padStart(7)}  ${String(r.ended ?? '-').padEnd(12)} ${String(r.elements.size).padStart(5)} ${String(r.proposed.length).padStart(9)} ${String(r.rejected.length).padStart(9)} ${String(r.notFound ?? '-').padStart(9)}`);
  });
  out.push('');
  out.push('  Distributions, not verdicts. A target reached in some runs and not');
  out.push('  others is a reliability finding about this model on this corpus.');
  return out;
}

// ---------------------------------------------------------------------------

// Importable for tests: only run when invoked directly, so test files can
// exercise parseRun/summarize without spawning anything.
export function main() {
  const o = parseOwnArgs(process.argv.slice(2));
  if (!o.passthrough.length) {
    console.error('hunt-repeat: no CE arguments given.\n'
      + 'usage: node scripts/hunt-repeat.mjs --runs 5 [--out-dir DIR] [--expect "A,B"] -- <ce args...>');
    process.exit(2);
  }
  if (o.inferred) {
    // An inferred boundary must never be silent: the user has to see exactly
    // which flags reached CE, or a misplaced option fails somewhere confusing.
    process.stderr.write('no -- separator; inferred split\n'
      + `  harness: --runs ${o.runs}${o.out ? ` --out-dir ${o.out}` : ''}`
      + `${o.expect.length ? ` --expect ${o.expect.length} target(s)` : ''}\n`
      + `  ce:      ${o.passthrough.join(' ')}\n`);
  }
  if (!(o.runs > 0)) { console.error('--runs must be a positive integer'); process.exit(2); }
  if (o.out) fs.mkdirSync(o.out, { recursive: true });

  const results = [];
  for (let i = 1; i <= o.runs; i++) {
    process.stderr.write(`run ${i}/${o.runs} … `);
    const t0 = Date.now();
    // Sequential by design: concurrent cloud calls distort latency and risk rate
    // limits, and the pod serves one model at a time.
    const res = spawnSync(o.node, [o.cli, ...o.passthrough], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const ms = Date.now() - t0;
    const stdout = res.stdout || '';
    if (o.out) {
      // Retain raw output so a surprising aggregate can be traced to the
      // transcript that produced it.
      fs.writeFileSync(path.join(o.out, `run-${String(i).padStart(2, '0')}.txt`), stdout + (res.stderr || ''));
    }
    if (res.error) { results.push({ error: res.error.message }); process.stderr.write(`FAILED (${res.error.message})\n`); continue; }
    const parsed = parseRun(stdout);
    parsed.ms = ms;
    parsed.exit = res.status;
    if (!stdout.trim()) {
      // Surface the CLI's own message. Swallowing it turns a one-line fix
      // ("no Gemini API key — set GEMINI_API_KEY") into an opaque exit code,
      // which is the worst possible ergonomics on a remote pod.
      const why = String(res.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop();
      parsed.error = why || `no output (exit ${res.status})`;
    }
    results.push(parsed);
    process.stderr.write(parsed.error
      ? `FAILED (${parsed.error})\n`
      : `${parsed.toolCalls ?? '?'} calls, ${parsed.elements.size} elements, ${parsed.rejected.length} rejected, ${(ms / 1000).toFixed(1)}s\n`);
  }

  for (const ln of summarize(results, o.expect)) console.log(ln);
  if (o.out) {
    fs.writeFileSync(path.join(o.out, 'summary.json'),
      JSON.stringify(results.map((r) => ({ ...r, elements: r.elements ? [...r.elements] : [] })), null, 2));
    console.log(`\n  raw output and summary.json in ${o.out}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
