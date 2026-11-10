// hof.js — the HOF self-test's pure parts: the parsers of CodeExam's public files, the ladder, the report, the run layout
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * "Huffing our own fumes" (HOF): draft a pseudo-claim from a group of the index's
 * own functions, locate the draft with --claim-locate, and score the drafter's
 * anchors (what it was shown) against the located targets (what the locator
 * named and CodeExam verified). Everything here is model-free and in one place
 * so `ce --hof` (src/commands/hof.js) and scripts/hof.mjs, the subprocess form
 * of 2026-11-03 kept until the parity run retires it, read the same files the
 * same way and print the same report (hof-cli-command, 2026-11-09).
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
 * ladder is read from names alone.
 */
import path from 'node:path';

export const FORM_RULES = ['current', '2026-10'];
export const LADDER = ['function', 'class', 'file', 'miss'];
export const WHERE = ['exact', 'near', 'elsewhere'];

// ------------------------------------------------------------- the run layout

/** The files of one run under `out`, the layout scripts/hof.mjs established. */
export function outPaths(out) {
  return {
    dir: out,
    cand: path.join(out, 'cand.lst'),
    draftFrom: null,
    claims: path.join(out, 'claims.txt'),
    sidecar: path.join(out, 'claims.txt.anchors.json'),
    artifact: path.join(out, 'pseudo_claims.md'),
    claim: (n) => path.join(out, `claim_${n}.txt`),
    claimOrig: (n) => path.join(out, `claim_${n}.orig.txt`),
    locate: (n) => path.join(out, `locate_${n}.txt`),
    logs: path.join(out, 'logs'),
    reportMd: path.join(out, 'hof_report.md'),
    reportJson: path.join(out, 'hof_report.json'),
  };
}

/** `yymmdd-HHMM`, local time, the run directory's name. */
export function runStamp(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${String(now.getFullYear()).slice(2)}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * Where a `ce --hof` run's files go: `<index>/hof/<yymmdd-HHMM>/`, beside the
 * index as mechanisms.json and embeddings/ are, since the drafts paraphrase the
 * code and the anchors name its functions, so a run on code under a protective
 * order is itself PO material and belongs where the index is. `hofOut` is the
 * override. An index loaded from a .zip unpacks to a temporary cache that is
 * deleted, so the default is refused there and --hof-out is required.
 */
export function runDirFor(indexPath, hofOut = null, now = new Date()) {
  if (hofOut) return path.resolve(String(hofOut));
  const ip = String(indexPath || '');
  if (/\.zip$/i.test(ip)) {
    throw new Error(`--hof on a .zip index needs --hof-out <dir>: ${path.basename(ip)} unpacks to a temporary cache that is deleted, and the run's files (the drafted claims paraphrase the code, the anchors name its functions) would go with it`);
  }
  return path.join(path.resolve(ip), 'hof', runStamp(now));
}

export function quoteArg(a) {
  return /[\s"']/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : String(a);
}
export const echoLine = (args) => `$ ce ${args.map(quoteArg).join(' ')}`;

export function modelArgs(o) {
  return o.llm ? ['--llm', o.llm] : ['--model', o.model];
}

/**
 * The ce argument lists for each step, from the option object both forms
 * share ({ indexPath, llm | model, rank, filter, formRules, claimClass, blind,
 * runs, includeTests, force, synonymizeWith }); `paths` are the files under
 * the run directory. `ce --hof` echoes these before each in-process step so a
 * user can reproduce any step by hand; scripts/hof.mjs spawns them.
 */
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
  const synonymizeWith = o.synonymizeWith ? (/\.gguf$/i.test(o.synonymizeWith) ? ['--model', o.synonymizeWith] : ['--llm', o.synonymizeWith]) : null;
  const synonymize = (n) => (synonymizeWith ? [
    '--synonymize', `@${paths.claimOrig(n)}`, ...synonymizeWith, '--synonymize-out', paths.claim(n), ...force,
  ] : null);
  const locate = (n) => [
    ...idx, '--claim-locate', `@${paths.claim(n)}`, ...modelArgs(o),
    '--targets-out', paths.locate(n),
    ...(o.blind ? ['--blind'] : []),
    ...(o.runs ? ['--runs', String(o.runs)] : []),
    ...(o.includeTests ? ['--include-tests'] : []),
    ...force,
  ];
  return { candidates, draft, synonymize, locate };
}

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

/** The candidates list a sidecar's recorded command drafted from, if it can be found near the claims file. */
export function candFromSidecarCommand(sidecar, nearDir, exists) {
  const m = String((sidecar && sidecar.command) || '').match(/--pseudo-claims\s+@(\S+)/);
  if (!m) return null;
  const p = m[1].replace(/^["']|["']$/g, '');
  for (const cand of [p, path.join(nearDir, p), path.join(nearDir, path.basename(p))]) {
    if (exists(cand)) return cand;
  }
  return null;
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

// ---------------------------------------------------------------- preflight

/** Per-call sizes the whole-run projection uses, labelled an estimate: the drafter projects its own exact figure from the packs before its first call (buildPseudoClaimSys + a PACK_TOTAL_CHARS pack in, 900 tokens out); a locate run is a discovery and a selection call; a rewrite is one short limitation per call. */
export const CALL_SIZES = {
  draft: { inChars: 27000, outTokens: 900 },
  locate: { inChars: 8000, outTokens: 500, perRun: 2 },
  rewrite: { inChars: 1200, outTokens: 300 },
};

/**
 * The model calls a run will make, from the group count: one draft per group
 * (the first --limit of them), one locate per claim (times --runs, two calls
 * each), and under --synonymize-with one rewrite per limitation, at
 * `elementsPerClaim` when the drafts do not exist yet. `calls` is the list
 * claimsCostGate prices; the counts are what the plan prints.
 */
export function preflightCalls(o, groupCount, { elementsPerClaim = 6 } = {}) {
  const drafted = o.claims ? groupCount : (o.limit ? Math.min(o.limit, groupCount) : groupCount);
  const drafts = o.claims ? 0 : drafted;
  const locates = drafted * (o.runs || 1);
  const rewrites = o.synonymizeWith ? drafted * elementsPerClaim : 0;
  const calls = [];
  for (let i = 0; i < drafts; i++) calls.push({ inChars: CALL_SIZES.draft.inChars, outTokens: CALL_SIZES.draft.outTokens });
  for (let i = 0; i < rewrites; i++) calls.push({ inChars: CALL_SIZES.rewrite.inChars, outTokens: CALL_SIZES.rewrite.outTokens });
  for (let i = 0; i < locates * CALL_SIZES.locate.perRun; i++) calls.push({ inChars: CALL_SIZES.locate.inChars, outTokens: CALL_SIZES.locate.outTokens });
  return { drafted, drafts, locates, rewrites, calls };
}

/** The plan `--hof --dry-run` prints after the grouper: the counts, the commands each step is the equivalent of, and the projection (`usd` null for a local model, which costs time, not dollars). */
export function planLines(o, cmds, groupCount, counts, { usd = null, modelLabel = '' } = {}) {
  const out = [];
  out.push('', `dry run: ${groupCount} candidate group(s)${o.limit && groupCount > o.limit ? `, the first ${o.limit} drafted` : ''}; nothing is sent to a model.`, '');
  out.push('Each step is the equivalent of:');
  if (!o.claims) out.push(`  ${echoLine(cmds.draft)}`);
  if (o.synonymizeWith) out.push(`  ${echoLine(cmds.synonymize('N'))}   (N = 1..${counts.drafted})`);
  out.push(`  ${echoLine(cmds.locate('N'))}   (N = 1..${counts.drafted})`, '');
  const parts = [];
  if (counts.drafts) parts.push(`${counts.drafts} draft(s)`);
  if (counts.rewrites) parts.push(`about ${counts.rewrites} rewrite(s) (${counts.drafted} claim(s), six limitations each until drafted)`);
  parts.push(`${counts.locates} locate run(s)${o.runs ? ` (${counts.drafted} claim(s) × --runs ${o.runs})` : ''}, two calls each`);
  out.push(`Model calls: ${parts.join('; ')}.`);
  out.push('A locate run whose selections do not parse is run once more, outside the projection (two more calls for such a claim).');
  if (usd == null) out.push(`Cost: a local model${modelLabel ? ` (${modelLabel})` : ''}; time, not dollars.`);
  else out.push(`Projected: ~$${usd.toFixed(2)}${modelLabel ? ` on ${modelLabel}` : ''}, an estimate from per-call sizes (a draft ${CALL_SIZES.draft.inChars.toLocaleString('en-US')} characters in and ${CALL_SIZES.draft.outTokens} tokens out, a locate call ${CALL_SIZES.locate.inChars.toLocaleString('en-US')} in and ${CALL_SIZES.locate.outTokens} out, a rewrite ${CALL_SIZES.rewrite.inChars.toLocaleString('en-US')} in and ${CALL_SIZES.rewrite.outTokens} out); the drafter projects its own exact figure before its first call. The $2 claims guard stops a run above it unless --force (CE_CLAIMS_COST_GUARD=<usd> raises it); --limit N and --filter <text> narrow the run.`);
  return out;
}

// ---------------------------------------------------------------- rendering

const pct = (n, d) => (d ? `${Math.round(100 * n / d)}%` : '-');

// The locator's parse-failure exit, as its stderr line reads
// (src/commands/claim-locate.js): the model's selection text did not parse, so
// no targets were written. --hof runs that step once more before the row reads
// failed (hof-locate-retry-once, 2026-11-09); a model error, a missing key or
// an unreadable claim would repeat, and are not run again.
export const LOCATE_PARSE_FAILURE = 'No symbol selections were parseable';
export const isLocateParseFailure = (logText) => String(logText || '').includes(LOCATE_PARSE_FAILURE);

// One line under each step's echo on the console (hof-console-progress-lines,
// 2026-11-09): how the step ended, the step's own `# actual cost` line when it
// printed one, and on a failure the step's last line, the reason, so a
// failure is read without opening the log. The first full run echoed every
// step's whole output, 69,035 lines for 212 claims; the logs hold that.
export function lastLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const l = lines.length ? lines[lines.length - 1] : '';
  return l.length > 160 ? `${l.slice(0, 157)}…` : l;
}
export function resultLine(s, reason = null, logText = '') {
  const secs = `${(s.ms / 1000).toFixed(1)}s`;
  if (s.code !== 0) {
    const last = reason || lastLine(logText);
    return `  → exit ${s.code}, ${secs}${last ? `: ${last}` : ''}`;
  }
  const cost = [...String(logText || '').matchAll(/^# actual cost: .*$/gm)].pop();
  return `  → exit 0, ${secs}${cost ? `; ${cost[0].trim()}` : ''}`;
}

// What a row's bracketed tag says, in the table and the report: the error if
// any, and whether the locate step ran twice.
export function rowTag(r) {
  if (r.error) return r.retried ? `${r.error}, retried` : r.error;
  return r.retried ? 'retried' : null;
}

export function renderTable(rows) {
  const t = totalsOf(rows);
  const R = (s, w) => String(s).padStart(w);
  const L = (s, w) => String(s).padEnd(w);
  const head = `${R('n', 3)} ${L('rank', 4)} ${R('anch', 4)} ${R('loc', 4)}  ${R('fn', 3)} ${R('cls', 3)} ${R('file', 4)} ${R('miss', 4)}  ${R('exact', 5)} ${R('near', 4)} ${R('else', 4)}  label`;
  const out = [head, '-'.repeat(head.length)];
  for (const r of rows) {
    const rank = r.priority != null ? `P${r.priority}` : '-';
    const tagText = rowTag(r);
    const tag = tagText ? `  [${tagText}]` : '';
    out.push(`${R(r.n, 3)} ${L(rank, 4)} ${R(r.anchors, 4)} ${R(r.located, 4)}  ${R(r.rungs.function, 3)} ${R(r.rungs.class, 3)} ${R(r.rungs.file, 4)} ${R(r.rungs.miss, 4)}  ${R(r.where.exact, 5)} ${R(r.where.near, 4)} ${R(r.where.elsewhere, 4)}  ${r.label}${tag}`);
  }
  out.push('-'.repeat(head.length));
  out.push(`${R('all', 3)} ${L('', 4)} ${R(t.anchors, 4)} ${R(t.located, 4)}  ${R(t.function, 3)} ${R(t.class, 3)} ${R(t.file, 4)} ${R(t.miss, 4)}  ${R(t.exact, 5)} ${R(t.near, 4)} ${R(t.elsewhere, 4)}  ${t.claims} claim(s)${t.errors ? `, ${t.errors} not located` : ''}`);
  out.push(`per anchor (best rung): function ${pct(t.function, t.anchors)}, class ${pct(t.class, t.anchors)}, file ${pct(t.file, t.anchors)}, miss ${pct(t.miss, t.anchors)}`
    + `   per target: exact ${pct(t.exact, t.located)}, near ${pct(t.near, t.located)}, elsewhere ${pct(t.elsewhere, t.located)}`);
  return out.join('\n');
}

/**
 * The fixed footer every report ends with, on the terminal and in
 * hof_report.md: what the rungs and classes mean, what the rank tag is, what a
 * match is not, and what HOF is not (hof-cli-command §3).
 */
export const HOW_TO_READ = [
  'How to read this',
  '- Per anchor, the best rung the locator reached: function (same file and function), class (the class of an anchor method, or another method of it), file (the same file), miss (none).',
  '- Per located target: exact (an anchor), near (in an anchor\'s file), elsewhere (in no anchor\'s file).',
  '- The rank tag ([P0] to [P3]) is information about the group; it is never a floor on what was drafted.',
  '- Files match by basename, so two same-named files in different folders tie; a documentation or constant anchor (no function) reaches file at most.',
  '- Without a synonymizer the claims were located in the drafter\'s own words, the easier case: the result is a floor, and the ladder, not one number, is what to read.',
  '- A round trip from a claim written from the code is no expectation for a real patent claim, whose gap on this codebase is register (docs/describe-reach.md).',
];

// The footer as the console prints it: the heading with a colon, then one
// rule per line. (The first full run printed it as one line: console.log
// joins its arguments with spaces, so the lines must be joined here.)
export const howToReadText = () => HOW_TO_READ.map((l, i) => (i ? l : `${l}:`)).join('\n');

export function renderMarkdown(report) {
  const t = report.totals;
  const o = report.options;
  const out = [];
  out.push(`# HOF: ${report.index} — drafted anchors against located targets`, '');
  out.push(`Generated ${report.generated} by ${report.tool || 'ce --hof'}; CodeExam ${report.ce || '(unknown)'}.`, '');
  out.push(`- index: \`${report.indexPath}\``);
  out.push(`- model: ${o.llm ? `--llm ${o.llm}` : `--model ${o.model}`}`);
  if (report.engines) out.push(`- engines: drafter ${report.engines.drafter}; synonymizer ${report.engines.synonymizer || 'none, the claims were located in the drafter\'s own words'}; locator ${report.engines.locator}`);
  out.push(`- drafting: --form-rules ${o.formRules}${o.claimClass ? `, --claim-class ${o.claimClass}` : ''}, --min-rank 0${o.rank ? ', --rank (reported, not a floor)' : ''}${o.limit ? `, --limit ${o.limit}` : ''}${o.filter ? `, --filter ${JSON.stringify(o.filter)}` : ''}`);
  if (o.synonymizeWith) out.push(`- synonymizing: --synonymize-with ${o.synonymizeWith}, anchors withheld, one call per limitation`);
  out.push(`- locating: --claim-locate${o.blind ? ' --blind' : ''}${o.runs ? ` --runs ${o.runs}` : ''}${o.includeTests ? ' --include-tests' : ''}`);
  if (o.claims) out.push(`- claims: \`${o.claims}\` (drafting skipped)`);
  if (!o.synonymizeWith) out.push('', 'The claims were located in the drafter\'s own words, which is the easier case; the ladder below is what to read, not one number.');
  out.push('');
  out.push('## Commands', '');
  out.push('```');
  for (const s of report.steps) out.push(echoLine(s.args), `  → exit ${s.code}, ${(s.ms / 1000).toFixed(1)}s${s.retried ? ' (the selections did not parse; run once more)' : ''}`);
  out.push('```', '');
  out.push('## Per claim', '');
  out.push('Per anchor, the best rung the locator reached: **fn** same file and function, **cls** the class of an anchor method or another method of it, **file** the same file, **miss** none. Per located target: **exact** an anchor, **near** in an anchor\'s file, **else** in no anchor\'s file. Files match by basename.', '');
  out.push('| n | rank | label | anchors | located | fn | cls | file | miss | exact | near | else |');
  out.push('|--:|:--|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of report.claims) {
    const rank = r.priority != null ? `P${r.priority}` : '';
    out.push(`| ${r.n} | ${rank} | ${r.label.replace(/\|/g, '\\|')}${rowTag(r) ? ` *(${rowTag(r)})*` : ''} | ${r.anchors.length} | ${r.targets.length} | ${r.rungs.function} | ${r.rungs.class} | ${r.rungs.file} | ${r.rungs.miss} | ${r.where.exact} | ${r.where.near} | ${r.where.elsewhere} |`);
  }
  out.push(`| **all** | | ${t.claims} claim(s)${t.errors ? `, ${t.errors} not located` : ''} | ${t.anchors} | ${t.located} | ${t.function} | ${t.class} | ${t.file} | ${t.miss} | ${t.exact} | ${t.near} | ${t.elsewhere} |`, '');
  out.push(`Per anchor: function ${pct(t.function, t.anchors)}, class ${pct(t.class, t.anchors)}, file ${pct(t.file, t.anchors)}, miss ${pct(t.miss, t.anchors)}. Per target: exact ${pct(t.exact, t.located)}, near ${pct(t.near, t.located)}, elsewhere ${pct(t.elsewhere, t.located)}.`, '');
  out.push('## Detail', '');
  for (const r of report.claims) {
    const rank = r.priority != null ? ` [P${r.priority}]` : '';
    out.push(`### ${r.n}.${rank} ${r.label}`, '');
    out.push(`> ${r.claim.length > 400 ? `${r.claim.slice(0, 400)}…` : r.claim}`, '');
    if (r.rewritten) out.push(`Located as rewritten by the synonymizer${r.overlap != null ? ` (${r.overlap}% of the original vocabulary kept)` : ''}:`, '', `> ${r.rewritten.length > 400 ? `${r.rewritten.slice(0, 400)}…` : r.rewritten}`, '');
    if (r.error) out.push(`Not located: ${r.error}${r.retried ? ' (run twice: the selections did not parse either time)' : ''}.`, '');
    else if (r.retried) out.push('Located on the second run: the first run\'s selections did not parse.', '');
    out.push('Anchors (what the drafter was shown):', '');
    for (const a of r.anchors) out.push(`- \`${a.base}@${a.func || `(${a.kind})`}\` — **${a.rung}**${a.hit ? ` via \`${a.hit}\`` : ''}`);
    if (!r.anchors.length) out.push('- (none grounded)');
    out.push('', 'Located (what --claim-locate named):', '');
    for (const tg of r.targets) out.push(`- \`${tg.spec}\` — ${tg.where}`);
    if (!r.targets.length) out.push('- (none)');
    out.push('');
  }
  out.push(`## ${HOW_TO_READ[0]}`, '', ...HOW_TO_READ.slice(1), '');
  return out.join('\n');
}
