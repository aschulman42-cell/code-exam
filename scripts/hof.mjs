#!/usr/bin/env node
// hof.mjs — runs the HOF test from one index name: draft pseudo-claims, locate each with --claim-locate, score the drafter's anchors against the located targets on the ladder
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * hof.mjs — "huffing our own fumes" in one command.
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
 *      --targets-out <out>/locate_N.txt [--blind] [--runs n]
 *   4. the comparison, no model: the sidecar's grounded anchors (file@func,
 *      what the drafter was shown) against the targets file's file@symbol
 *      lines (what the locator named and CodeExam verified in the index).
 *
 * Each anchor scores on the ladder scripts/anchor-recall.mjs established in
 * August: FUNCTION (same file, same function, class-qualified names
 * normalized), CLASS (the target is the class of an anchor method, or another
 * method of that class), FILE (same file, nothing closer) or MISS. Each
 * located target is EXACT (an anchor), NEAR (in an anchor's file) or
 * ELSEWHERE (in no anchor's file). The two partitions answer two questions:
 * how far down the ladder the locator fell per anchor, and how much of what
 * it named was outside the drafter's material at all.
 *
 * What a match is NOT: the locator's targets file carries the file's basename
 * (claim-locate's targetSpecs), the sidecar the indexed path, so files are
 * matched by basename and two same-named files in different folders tie. A
 * documentation or constant anchor (no function) can reach FILE at most. The
 * ladder is read from names alone; the one-hop call-graph distance measured
 * by hand on 2026-11-02 needs the index in-process and is not a rung here.
 *
 * Dev-side, not wired into `ce --help`, the precedent of hunt-repeat.mjs and
 * claim-locate-stability.mjs.
 *
 * USAGE
 *   node scripts/hof.mjs --index-path <dir> (--llm claude|chatgpt|gemini | --model <gguf>)
 *        [--out <dir>] [--rank] [--form-rules current|2026-10]
 *        [--claim-class method|system|both|apparatus|crm|auto|all]
 *        [--limit N] [--filter <text>] [--blind] [--runs n]
 *        [--claims <claims.txt>] [--dry-run] [--force]
 *
 *   --claims <claims.txt>  skip steps 1 and 2: locate an existing claims file
 *                          (its .anchors.json sidecar beside it), so the same
 *                          drafts can be located with a second model and the
 *                          two reports compared.
 *   --limit N              draft and locate the first N groups of the list (a
 *                          cost control; off by default).
 *   --dry-run              run the grouper (no model, no cost) for the group
 *                          count, print every other command and the cost
 *                          figures the docs carry, and send nothing to a model.
 *   --force                passed through to each ce command; CodeExam's own
 *                          $2 cost guard applies per command otherwise.
 *   --out <dir>            default %LOCALAPPDATA%\CodeExam\hof\<index>_<yymmdd-HHMM>
 *
 * Output: the table on stdout, the same in <out>/hof_report.md, the raw
 * records in <out>/hof_report.json, every ce command's output in <out>/logs/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLI = path.join(HERE, '..', 'src', 'index.js');

export const USAGE = [
  'usage: node scripts/hof.mjs --index-path <dir> (--llm claude|chatgpt|gemini | --model <gguf>)',
  '            [--out <dir>] [--rank] [--form-rules current|2026-10]',
  '            [--claim-class method|system|both|apparatus|crm|auto|all]',
  '            [--limit N] [--filter <text>] [--blind] [--runs n]',
  '            [--claims <claims.txt>] [--dry-run] [--force]',
  '',
  '  Draft pseudo-claims from the index, locate each with --claim-locate, and score the',
  '  drafter\'s anchors against the located targets: function / class / file / miss per',
  '  anchor, exact / near / elsewhere per target. Rank ([P..]) is reported, never a floor.',
  '  --claims <file> locates an existing claims file (sidecar beside it) and skips drafting.',
  '  --dry-run runs the grouper only (no model) and prints the rest with cost figures.',
].join('\n');

export const FORM_RULES = ['current', '2026-10'];
export const LADDER = ['function', 'class', 'file', 'miss'];
export const WHERE = ['exact', 'near', 'elsewhere'];

// ---------------------------------------------------------------- arguments

export function parseOwnArgs(argv) {
  const o = {
    indexPath: null, llm: null, model: null, out: null, rank: false, formRules: 'current',
    claimClass: null, limit: null, filter: null, blind: false, runs: null, claims: null,
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

export function modelArgs(o) {
  return o.llm ? ['--llm', o.llm] : ['--model', o.model];
}

/** The ce argument lists for each step; `paths` are the files under <out>. */
export function buildCommands(o, paths) {
  const idx = ['--index-path', o.indexPath];
  const force = o.force ? ['--force'] : [];
  const candidates = [
    ...idx, '--pseudo-claims', '--candidates', paths.cand,
    ...(o.filter ? ['--filter', o.filter] : []),
    ...(o.rank ? ['--rank', ...modelArgs(o), ...force] : []),
  ];
  const draft = [
    ...idx, '--pseudo-claims', `@${paths.draftFrom || paths.cand}`, ...modelArgs(o),
    '--claims-only', paths.claims, '--pseudo-out', paths.artifact,
    '--min-rank', '0', // rank is information in the report, never a floor
    '--form-rules', o.formRules,
    ...(o.claimClass ? ['--claim-class', o.claimClass] : []),
    ...force,
  ];
  const locate = (n) => [
    ...idx, '--claim-locate', `@${paths.claim(n)}`, ...modelArgs(o),
    '--targets-out', paths.locate(n),
    ...(o.blind ? ['--blind'] : []),
    ...(o.runs ? ['--runs', String(o.runs)] : []),
    ...force,
  ];
  return { candidates, draft, locate };
}

export function outPaths(out) {
  return {
    dir: out,
    cand: path.join(out, 'cand.lst'),
    draftFrom: null,
    claims: path.join(out, 'claims.txt'),
    sidecar: path.join(out, 'claims.txt.anchors.json'),
    artifact: path.join(out, 'pseudo_claims.md'),
    claim: (n) => path.join(out, `claim_${n}.txt`),
    locate: (n) => path.join(out, `locate_${n}.txt`),
    logs: path.join(out, 'logs'),
    reportMd: path.join(out, 'hof_report.md'),
    reportJson: path.join(out, 'hof_report.json'),
  };
}

export function defaultOutDir(indexPath, now = new Date()) {
  const base = path.basename(path.resolve(indexPath)).replace(/^\.+/, '') || 'index';
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(root, 'CodeExam', 'hof', `${base}_${stamp}`);
}

export function quoteArg(a) {
  return /[\s"']/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a);
}
export const echoLine = (args) => `$ ce ${args.map(quoteArg).join(' ')}`;

// ------------------------------------------------------------------ parsers

/** The claims file: one claim per non-# line. */
export function readClaims(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** The targets file: non-# lines, split on ';' (claim-chart's parseTargets rule). */
export function readTargets(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    for (const part of t.split(';')) { const p = part.trim(); if (p) out.push(p); }
  }
  return out;
}

export function baseName(file) {
  return String(file || '').split('!').pop().split(/[\\/]/).pop();
}

export function parseTargetSpec(spec) {
  const s = String(spec).trim();
  const i = s.indexOf('@');
  if (i < 0) return { spec: s, base: baseName(s), name: '' };
  return { spec: s, base: baseName(s.slice(0, i)), name: s.slice(i + 1).trim() };
}

/**
 * The candidates list: a `#` line starts a block; a block that owns at least
 * one anchor line is a GROUP (parseAnchorGroupsText's rule, so the count here
 * is the count the drafter sees). The [P..] tag is read from the header.
 */
export function parseCandidateGroups(text) {
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  let cur = null;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      const m = line.match(/\[P([0-3])\b/);
      cur = { header: line, at: i, priority: m ? Number(m[1]) : null, lines: [] };
      return;
    }
    if (!cur) cur = { header: null, at: i, priority: null, lines: [] };
    cur.lines.push(line);
    if (cur.lines.length === 1) groups.push(cur);
  });
  return groups;
}

/** The text of the first n groups (everything before the (n+1)th group's header). */
export function limitCandidates(text, n) {
  const groups = parseCandidateGroups(text);
  if (groups.length <= n) return String(text);
  const cut = groups[n].at;
  return String(text).split(/\r?\n/).slice(0, cut).join('\n') + '\n';
}

/** The sidecar's claims with their anchors deduplicated to file@func. */
export function parseSidecar(sidecar) {
  const claims = [];
  for (const c of (sidecar && sidecar.claims) || []) {
    const seen = new Set();
    const anchors = [];
    for (const a of c.grounded || []) {
      const func = a.func || '';
      const base = baseName(a.file);
      const key = `${base.toLowerCase()}@${func}`;
      if (seen.has(key)) continue;
      seen.add(key);
      anchors.push({ file: a.file, base, func, kind: a.kind || 'func' });
    }
    claims.push({
      n: c.n, groupN: c.groupN, label: c.label || '', priority: c.priority ?? null,
      claim: c.claim || '', truncated: !!c.truncated, anchors,
    });
  }
  return claims;
}

/**
 * Rank per claim: the sidecar's own `priority` (sidecars since 2026-11-03),
 * else the candidates list's group by groupN (sidecars written before, or
 * runs where --min-rank 0 kept every group so the numbering aligns).
 */
export function joinRank(claims, candGroups) {
  return claims.map((c) => {
    if (c.priority != null) return { ...c, rankFrom: 'sidecar' };
    const g = candGroups && candGroups[c.groupN - 1];
    if (g && g.priority != null) return { ...c, priority: g.priority, rankFrom: 'cand.lst' };
    return { ...c, priority: null, rankFrom: null };
  });
}

// ------------------------------------------------------------------ scoring

export function normName(n) {
  return String(n || '').trim().replace(/\./g, '::').replace(/^::/, '');
}
export function enclosingClass(fn) {
  const n = normName(fn);
  const i = n.lastIndexOf('::');
  return i > 0 ? n.slice(0, i) : null;
}
/** Same function: equal, or one is the unqualified form of the other. */
export function sameFunction(a, b) {
  const A = normName(a), B = normName(b);
  if (!A || !B) return false;
  if (A === B) return true;
  if (!A.includes('::') && B.endsWith(`::${A}`)) return true;
  if (!B.includes('::') && A.endsWith(`::${B}`)) return true;
  return false;
}
const sameFile = (a, b) => a.toLowerCase() === b.toLowerCase();

/** One claim: anchors [{base, func}] against targets [{base, name}]. */
export function scoreClaim(anchors, targets) {
  const perAnchor = anchors.map((a) => {
    const inFile = targets.filter((t) => sameFile(t.base, a.base));
    let rung = 'miss', hit = null;
    const fn = a.func ? inFile.find((t) => sameFunction(a.func, t.name)) : null;
    if (fn) { rung = 'function'; hit = fn; }
    else {
      const cls = a.func ? enclosingClass(a.func) : null;
      const c = inFile.find((t) => {
        const tn = normName(t.name);
        if (cls) return tn === cls || tn.startsWith(`${cls}::`);
        return !!a.func && tn.startsWith(`${normName(a.func)}::`);
      });
      if (c) { rung = 'class'; hit = c; }
      else if (inFile.length) { rung = 'file'; hit = inFile[0]; }
    }
    return { ...a, rung, hit: hit ? hit.spec : null };
  });
  const perTarget = targets.map((t) => {
    const exact = anchors.some((a) => sameFile(a.base, t.base) && a.func && sameFunction(a.func, t.name));
    const near = !exact && anchors.some((a) => sameFile(a.base, t.base));
    return { ...t, where: exact ? 'exact' : near ? 'near' : 'elsewhere' };
  });
  const tally = (arr, key, names) => Object.fromEntries(names.map((k) => [k, arr.filter((x) => x[key] === k).length]));
  return {
    anchors: perAnchor, targets: perTarget,
    rungs: tally(perAnchor, 'rung', LADDER),
    where: tally(perTarget, 'where', WHERE),
  };
}

export function totalsOf(rows) {
  const t = { anchors: 0, located: 0, function: 0, class: 0, file: 0, miss: 0, exact: 0, near: 0, elsewhere: 0, claims: rows.length, errors: 0 };
  for (const r of rows) {
    if (r.error) t.errors++;
    t.anchors += r.anchors; t.located += r.located;
    for (const k of LADDER) t[k] += r.rungs[k];
    for (const k of WHERE) t[k] += r.where[k];
  }
  return t;
}

// ---------------------------------------------------------------- rendering

const pct = (n, d) => (d ? `${Math.round(100 * n / d)}%` : '-');

export function renderTable(rows) {
  const t = totalsOf(rows);
  const R = (s, w) => String(s).padStart(w);
  const L = (s, w) => String(s).padEnd(w);
  const head = `${R('n', 3)} ${L('rank', 4)} ${R('anch', 4)} ${R('loc', 4)}  ${R('fn', 3)} ${R('cls', 3)} ${R('file', 4)} ${R('miss', 4)}  ${R('exact', 5)} ${R('near', 4)} ${R('else', 4)}  label`;
  const out = [head, '-'.repeat(head.length)];
  for (const r of rows) {
    const rank = r.priority != null ? `P${r.priority}` : '-';
    const tag = r.error ? `  [${r.error}]` : '';
    out.push(`${R(r.n, 3)} ${L(rank, 4)} ${R(r.anchors, 4)} ${R(r.located, 4)}  ${R(r.rungs.function, 3)} ${R(r.rungs.class, 3)} ${R(r.rungs.file, 4)} ${R(r.rungs.miss, 4)}  ${R(r.where.exact, 5)} ${R(r.where.near, 4)} ${R(r.where.elsewhere, 4)}  ${r.label}${tag}`);
  }
  out.push('-'.repeat(head.length));
  out.push(`${R('all', 3)} ${L('', 4)} ${R(t.anchors, 4)} ${R(t.located, 4)}  ${R(t.function, 3)} ${R(t.class, 3)} ${R(t.file, 4)} ${R(t.miss, 4)}  ${R(t.exact, 5)} ${R(t.near, 4)} ${R(t.elsewhere, 4)}  ${t.claims} claim(s)${t.errors ? `, ${t.errors} not located` : ''}`);
  out.push(`per anchor (best rung): function ${pct(t.function, t.anchors)}, class ${pct(t.class, t.anchors)}, file ${pct(t.file, t.anchors)}, miss ${pct(t.miss, t.anchors)}`
    + `   per target: exact ${pct(t.exact, t.located)}, near ${pct(t.near, t.located)}, elsewhere ${pct(t.elsewhere, t.located)}`);
  return out.join('\n');
}

export function renderMarkdown(report) {
  const t = report.totals;
  const o = report.options;
  const out = [];
  out.push(`# HOF: ${report.index} — drafted anchors against located targets`, '');
  out.push(`Generated ${report.generated} by scripts/hof.mjs; CodeExam ${report.ce || '(unknown)'}.`, '');
  out.push(`- index: \`${report.indexPath}\``);
  out.push(`- model: ${o.llm ? `--llm ${o.llm}` : `--model ${o.model}`}`);
  out.push(`- drafting: --form-rules ${o.formRules}${o.claimClass ? `, --claim-class ${o.claimClass}` : ''}, --min-rank 0${o.rank ? ', --rank (reported, not a floor)' : ''}${o.limit ? `, --limit ${o.limit}` : ''}${o.filter ? `, --filter ${JSON.stringify(o.filter)}` : ''}`);
  out.push(`- locating: --claim-locate${o.blind ? ' --blind' : ''}${o.runs ? ` --runs ${o.runs}` : ''}`);
  if (o.claims) out.push(`- claims: \`${o.claims}\` (drafting skipped)`);
  out.push('');
  out.push('## Commands', '');
  out.push('```');
  for (const s of report.steps) out.push(echoLine(s.args), `  → exit ${s.code}, ${(s.ms / 1000).toFixed(1)}s`);
  out.push('```', '');
  out.push('## Per claim', '');
  out.push('Per anchor, the best rung the locator reached: **fn** same file and function, **cls** the class of an anchor method or another method of it, **file** the same file, **miss** none. Per located target: **exact** an anchor, **near** in an anchor\'s file, **else** in no anchor\'s file. Files match by basename.', '');
  out.push('| n | rank | label | anchors | located | fn | cls | file | miss | exact | near | else |');
  out.push('|--:|:--|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of report.claims) {
    const rank = r.priority != null ? `P${r.priority}` : '';
    out.push(`| ${r.n} | ${rank} | ${r.label.replace(/\|/g, '\\|')}${r.error ? ` *(${r.error})*` : ''} | ${r.anchors.length} | ${r.targets.length} | ${r.rungs.function} | ${r.rungs.class} | ${r.rungs.file} | ${r.rungs.miss} | ${r.where.exact} | ${r.where.near} | ${r.where.elsewhere} |`);
  }
  out.push(`| **all** | | ${t.claims} claim(s)${t.errors ? `, ${t.errors} not located` : ''} | ${t.anchors} | ${t.located} | ${t.function} | ${t.class} | ${t.file} | ${t.miss} | ${t.exact} | ${t.near} | ${t.elsewhere} |`, '');
  out.push(`Per anchor: function ${pct(t.function, t.anchors)}, class ${pct(t.class, t.anchors)}, file ${pct(t.file, t.anchors)}, miss ${pct(t.miss, t.anchors)}. Per target: exact ${pct(t.exact, t.located)}, near ${pct(t.near, t.located)}, elsewhere ${pct(t.elsewhere, t.located)}.`, '');
  out.push('## Detail', '');
  for (const r of report.claims) {
    const rank = r.priority != null ? ` [P${r.priority}]` : '';
    out.push(`### ${r.n}.${rank} ${r.label}`, '');
    out.push(`> ${r.claim.length > 400 ? `${r.claim.slice(0, 400)}…` : r.claim}`, '');
    if (r.error) out.push(`Not located: ${r.error}.`, '');
    out.push('Anchors (what the drafter was shown):', '');
    for (const a of r.anchors) out.push(`- \`${a.base}@${a.func || `(${a.kind})`}\` — **${a.rung}**${a.hit ? ` via \`${a.hit}\`` : ''}`);
    if (!r.anchors.length) out.push('- (none grounded)');
    out.push('', 'Located (what --claim-locate named):', '');
    for (const tg of r.targets) out.push(`- \`${tg.spec}\` — ${tg.where}`);
    if (!r.targets.length) out.push('- (none)');
    out.push('');
  }
  return out.join('\n');
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

function candFromSidecarCommand(sidecar, nearDir) {
  const m = String((sidecar && sidecar.command) || '').match(/--pseudo-claims\s+@(\S+)/);
  if (!m) return null;
  const p = m[1].replace(/^["']|["']$/g, '');
  for (const cand of [p, path.join(nearDir, p), path.join(nearDir, path.basename(p))]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
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
  if (!candPath) candPath = candFromSidecarCommand(sidecar, path.dirname(claimsPath));
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
    format: 'ce-hof-report', version: 1, generated: new Date().toISOString(),
    ce: sidecar.ce || '', index: path.basename(path.resolve(o.indexPath)), indexPath: path.resolve(o.indexPath),
    options: { llm: o.llm, model: o.model, formRules: o.formRules, claimClass: o.claimClass, rank: o.rank, limit: o.limit, filter: o.filter, blind: o.blind, runs: o.runs, claims: o.claims, force: o.force },
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
