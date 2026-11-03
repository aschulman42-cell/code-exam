#!/usr/bin/env node
// ceiling-to-loop.mjs — the drafter ceiling's ce-seeded drafts as pseudo-claim-loop inputs
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// hof-loop-on-ceiling-drafts (2026-11-02). The ceiling (recap-chart-drafter-ceiling.mjs,
// --steps ce-seeded) leaves, per filing and repository, one pseudo-claims file per candidate
// group with its .anchors.json sidecar: real-code drafts at the filing commit, grounded. The
// loop (pseudo-claim-loop.mjs) takes ONE source file per run: a numbered claims file and a
// claims-only file whose sidecar is the answer key. This adapter merges the chosen groups of a
// repository into that shape, renumbered, and prints the loop command for each repository with
// the ceiling's control pairing carried over as the loop's --control index.
//
//   node scripts/ceiling-to-loop.mjs --work <dir> --tag <tag> --out <dir outside the repo> \
//     [--only id,id] [--read finding|strict|all] [--class asserted|method|system] \
//     [--control-fallback org/repo] [--syn-llm chatgpt] [--llm claude | --model <gguf>] \
//     [--dry-run]
//
//   --work     the agreement work directory (ceiling.jsonl, manifest.json, indexes/, ceiling/)
//   --tag      the ceiling run's tag (its drafts sit under ce-seeded-<tag>/)
//   --out      where the merged inputs go; the loop writes its charts and scorecards beside them
//   --only     filing ids to take; default every filing with tagged records
//   --read     which groups: `finding` (default) the groups the ceiling's judge read as a finding
//              on the plain read, `strict` the strict read, `all` every drafted group
//   --class    which of the two drafted claims: `asserted` (default) the class the ceiling judged,
//              the asserted claim's own; or `method` / `system`
//   --control-fallback  when the ceiling's control filing lives in the SAME repository as the
//              drafted one (the four secp256k1 filings pair with each other, ViaBTC with MARA),
//              a control index is not a control; use this org/repo's index instead. Without it
//              the loop command for such a repository carries no --control, and the note says so.
//   --dry-run  plan and print, write nothing
//
// Cost is the loop's: every chart is one `ce --claim-chart` run with --force (25 to 35 analyses,
// about $0.30 to $0.40 each on Claude Sonnet 4.6 at the 2026-08-30 rate), and each claim is
// charted two or three times (original, synonymized, control). The summary line counts them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOP = path.join(ROOT, 'scripts', 'pseudo-claim-loop.mjs');

export const READS = ['finding', 'strict', 'all'];
export const CLASSES = ['asserted', 'method', 'system'];

/** `<work>/indexes/<org>__<repo>__<sha7>`, as the ceiling names them. */
export function indexDirOf(work, r) {
  const sha = String(r.resolvedRef || r.ref || '').slice(0, 7);
  return path.join(work, 'indexes', `${r.org}__${r.repo}__${sha}`);
}

/** The tagged ce-seeded records with a drafted group, by `--only` and `--read`. */
export function selectRecords(records, { tag, only = null, read = 'finding' } = {}) {
  if (!READS.includes(read)) throw new Error(`--read must be one of ${READS.join(', ')}`);
  const ids = only ? new Set(only) : null;
  return records.filter((r) => r.seed === 'codeexam' && r.tag === tag && r.group
    && (!ids || ids.has(r.id))
    && (read === 'all' || (read === 'finding' ? r.read === 'finding' : r.readStrict === 'finding')));
}

/** The sidecar claim of the wanted class; `asserted` is the class the ceiling judged. */
export function pickClaim(sidecar, cls, record) {
  const want = cls === 'asserted' ? ((record.compare && record.compare.pseudoClass) || 'method') : cls;
  const claims = (sidecar && sidecar.claims) || [];
  return claims.find((c) => (c.class || c.cls) === want) || claims[0] || null;
}

/**
 * One repository's chosen groups as one loop source: claims renumbered 1..K, each carrying its
 * group's rank and label and the ceiling's read in the label, the dependents and grounded
 * anchors carried as they are (the answer key).
 */
export function mergeGroups(entries) {
  const claims = [];
  const numbered = [];
  const sorted = [...entries].sort((a, b) => a.record.group.rank - b.record.group.rank);
  sorted.forEach((e, i) => {
    const n = i + 1;
    const g = e.record.group;
    const c = e.claim;
    claims.push({
      n,
      label: `codeexam ${g.rank}: ${g.label} [${c.class || c.cls || '?'}] — ceiling ${e.record.read || '?'}`,
      claim: c.claim,
      class: c.class || c.cls || null,
      elements: c.elements || [],
      dependents: c.dependents || [],
      grounded: c.grounded || [],
      source: { id: e.record.id, repo: e.record.repo, rank: g.rank, sidecar: e.sidecarPath || null, ceilingRead: e.record.read || null, ceilingReadStrict: e.record.readStrict || null },
    });
    numbered.push(`${n}. ${String(c.claim).replace(/\s+/g, ' ').trim()}`);
  });
  return { claims, numbered };
}

/**
 * The loop's --control index for a drafted repository: the ceiling's control filing's index
 * when that filing lives in another repository; otherwise the fallback's index, or none.
 */
export function controlIndexFor({ record, manifest, work, fallback = null }) {
  const ctrlId = record.compare && record.compare.controlId;
  const ctrl = ctrlId ? (manifest.candidates || []).find((c) => c.id === ctrlId) : null;
  const drafted = record.repo;
  const exists = (p) => fs.existsSync(p);
  if (ctrl) {
    const other = (ctrl.repos || []).find((r) => `${r.org}/${r.repo}` !== drafted && exists(indexDirOf(work, r)));
    if (other) return { index: indexDirOf(work, other), via: ctrlId, note: null };
    if ((ctrl.repos || []).some((r) => `${r.org}/${r.repo}` === drafted)) {
      if (fallback) {
        for (const c of manifest.candidates || []) {
          for (const r of c.repos || []) {
            if (`${r.org}/${r.repo}` === fallback && exists(indexDirOf(work, r))) {
              return { index: indexDirOf(work, r), via: `${ctrlId} is the same repository; fallback ${fallback} (${c.id})`, note: null };
            }
          }
        }
        return { index: null, via: null, note: `control filing ${ctrlId} is the same repository as ${drafted} and no index for the fallback ${fallback} exists; no --control` };
      }
      return { index: null, via: null, note: `control filing ${ctrlId} is the same repository as ${drafted}; pass --control-fallback org/repo or run without a control` };
    }
    return { index: null, via: null, note: `control filing ${ctrlId} has no index under ${path.join(work, 'indexes')}; no --control` };
  }
  return { index: null, via: null, note: 'the ceiling record carries no control filing; no --control' };
}

/** The loop invocation for one merged source, as argv (printed, and testable). */
export function loopCommand({ numbered, claimsOnly, index, control, synLlm = 'chatgpt', llm = 'claude', model = null, extra = [] }) {
  const argv = [LOOP, '--claims', numbered, '--source', claimsOnly, '--index', index];
  if (control) argv.push('--control', control);
  if (model) argv.push('--model', model); else argv.push('--llm', llm);
  argv.push('--syn-llm', synLlm, ...extra);
  return argv;
}

const quote = (x) => (/\s/.test(x) ? JSON.stringify(x) : x);
export const formatCommand = (argv) => `node ${argv.map(quote).join(' ')}`;

/**
 * The whole plan from the work directory: one entry per (filing, repository) with its merged
 * claims, the index, the control, the file names under `out`, and the loop command. Reads the
 * ceiling's records, the manifest and the chosen groups' sidecars; writes nothing.
 */
export function buildPlan({ work, tag, out, only = null, read = 'finding', cls = 'asserted', controlFallback = null, synLlm = 'chatgpt', llm = 'claude', model = null }) {
  if (!CLASSES.includes(cls)) throw new Error(`--class must be one of ${CLASSES.join(', ')}`);
  const records = fs.readFileSync(path.join(work, 'ceiling.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const manifest = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8'));
  const chosen = selectRecords(records, { tag, only, read });
  const byRepo = new Map();
  for (const r of chosen) {
    const key = `${r.id}|${r.repo}`;
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(r);
  }
  const plan = [];
  const skipped = [];
  for (const [key, recs] of byRepo) {
    const [id, repo] = key.split('|');
    const [org, name] = repo.split('/');
    const cand = (manifest.candidates || []).find((c) => c.id === id);
    const repoEntry = cand && (cand.repos || []).find((x) => `${x.org}/${x.repo}` === repo);
    if (!repoEntry) { skipped.push({ id, repo, reason: 'not in the manifest' }); continue; }
    const index = indexDirOf(work, repoEntry);
    const dir = path.join(work, 'ceiling', id, `${org}__${name}`, `ce-seeded-${tag}`);
    const entries = [];
    for (const r of recs) {
      const sidecarPath = path.join(dir, `group-${r.group.rank}-pseudo.txt.anchors.json`);
      if (!fs.existsSync(sidecarPath)) { skipped.push({ id, repo, rank: r.group.rank, reason: `no sidecar at ${sidecarPath}` }); continue; }
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      const claim = pickClaim(sidecar, cls, r);
      if (!claim) { skipped.push({ id, repo, rank: r.group.rank, reason: 'sidecar has no claims' }); continue; }
      entries.push({ record: r, claim, sidecarPath });
    }
    if (!entries.length) continue;
    const merged = mergeGroups(entries);
    const control = controlIndexFor({ record: recs[0], manifest, work, fallback: controlFallback });
    const stem = `${id}__${org}__${name}`;
    const files = {
      claimsOnly: path.join(out, `${stem}_claims.txt`),
      sidecar: path.join(out, `${stem}_claims.txt.anchors.json`),
      numbered: path.join(out, `${stem}_numbered.txt`),
    };
    const command = loopCommand({ numbered: files.numbered, claimsOnly: files.claimsOnly, index, control: control.index, synLlm, llm, model });
    plan.push({ id, repo, index, control, files, merged, command, charts: merged.claims.length * (control.index ? 3 : 2) });
  }
  return { plan, skipped, read, cls, tag };
}

/** Write one plan entry's three files under `out`. */
export function writeInputs(entry, { tag, read, cls }) {
  fs.mkdirSync(path.dirname(entry.files.claimsOnly), { recursive: true });
  const head = [
    '# Pseudo-claims — illustrative drafting exercise, NOT legal analysis.',
    '# NOT patent claims. Generated for retrieval testing; do not file, quote, or rely on.',
    `# Source:     the drafter ceiling's ce-seeded-${tag} drafts for ${entry.id} on ${entry.repo}`,
    `# Selection:  --read ${read} --class ${cls}; ${entry.merged.claims.length} claim(s), renumbered`,
    `# Index:      ${entry.index}`,
    `# Control:    ${entry.control.index || `(none: ${entry.control.note})`}`,
    `# Generated:  ${new Date().toISOString()} by scripts/ceiling-to-loop.mjs`,
    '',
  ];
  fs.writeFileSync(entry.files.claimsOnly, head.join('\n') + entry.merged.claims.map((c) => c.claim).join('\n') + '\n');
  fs.writeFileSync(entry.files.sidecar, JSON.stringify({
    format: 'ce-pseudo-claim-anchors',
    version: 1,
    note: `Merged by scripts/ceiling-to-loop.mjs from the ceiling's ce-seeded-${tag} sidecars; each claim's \`source\` names the filing, repository and group rank it came from. The grounded anchors are the loop's answer key.`,
    generated: new Date().toISOString(),
    claims: entry.merged.claims,
  }, null, 2) + '\n');
  fs.writeFileSync(entry.files.numbered, entry.merged.numbered.join('\n') + '\n');
  return entry.files;
}

function parseArgs(argv) {
  const a = { read: 'finding', class: 'asserted', 'syn-llm': 'chatgpt', llm: 'claude' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    if (name === 'dry-run') a[name] = true;
    else a[name] = argv[++i];
  }
  return a;
}

export function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (!a.work || !a.tag || !a.out) {
    console.error('usage: ceiling-to-loop.mjs --work <dir> --tag <tag> --out <dir> [--only id,id] [--read finding|strict|all] [--class asserted|method|system] [--control-fallback org/repo] [--syn-llm chatgpt] [--llm claude | --model <gguf>] [--dry-run]');
    process.exit(2);
  }
  const { plan, skipped, read, cls, tag } = buildPlan({
    work: path.resolve(a.work), tag: a.tag, out: path.resolve(a.out),
    only: a.only ? a.only.split(',').map((s) => s.trim()).filter(Boolean) : null,
    read: a.read, cls: a.class, controlFallback: a['control-fallback'] || null,
    synLlm: a['syn-llm'], llm: a.llm, model: a.model || null,
  });
  let charts = 0;
  for (const e of plan) {
    if (!a['dry-run']) writeInputs(e, { tag, read, cls });
    charts += e.charts;
    console.log(`# ${e.id} on ${e.repo}: ${e.merged.claims.length} claim(s) [${e.merged.claims.map((c) => `rank ${c.source.rank}`).join(', ')}] -> ${e.charts} chart(s)`);
    console.log(`#   index   ${e.index}`);
    console.log(`#   control ${e.control.index ? `${e.control.index} (via ${e.control.via})` : `none: ${e.control.note}`}`);
    console.log(formatCommand(e.command));
    console.log('');
  }
  for (const s of skipped) console.log(`# skipped ${s.id} ${s.repo}${s.rank ? ` group ${s.rank}` : ''}: ${s.reason}`);
  const low = (charts * 0.30).toFixed(2); const high = (charts * 0.40).toFixed(2);
  console.log(`# ${plan.length} loop run(s), ${plan.reduce((n, e) => n + e.merged.claims.length, 0)} claim(s), ${charts} chart(s): about $${low} to $${high} at the 2026-08-30 rate on Claude Sonnet 4.6, before the synonymize calls${a['dry-run'] ? '; dry run, nothing written' : ''}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
