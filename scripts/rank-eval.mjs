// rank-eval.mjs — scores a candidate ordering against tiered ground truth (Spearman, recall@k, purity)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// rank-eval.mjs — #284 ranker-scoring-harness runner: score a candidate-group
// ORDERING against tier-annotated ground truth (tie-aware Spearman + recall@k)
// and measure group PURITY, using the pure metrics in src/core/ranker-eval.js.
//
// Dev-side only — not wired into the ce CLI (kept out of the shipping command
// until the metric stabilizes; see worklist-drafts/ranker-scoring-harness.md).
//
// Usage:
//   node scripts/rank-eval.mjs --index-path <idx> --lst <candidates.lst> --gt <gt.lst>
//        [--score tags|position|calls|hotspot] [--k <n>]
//
// Ordering sources (--score):
//   tags      [P<n>] header tags in the .lst (the --rank emit) — DEFAULT when
//             the .lst carries tags. Scores existing ranked artifacts with no
//             model call.
//   position  file order of the .lst — the unranked grouper baseline every
//             ranker must beat.
//   calls     max member call-count (index.getCallCounts) — mechanical prior.
//   hotspot   max member calls×log2(lines) (the getHotspots formula,
//             hotspots.js) — mechanical prior.
//
// The GT file is the Class-A hand-curated anchors .lst, optionally tier-tagged
// `# Label [P3]` (see parseGtTiers). It stays gitignored; this script takes it
// as an ARGUMENT and never hardcodes a path to it.

import fs from 'node:fs';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { parseFuncSpec } from '../src/utils.js';
import {
  spearman, scorePurity, parseAnnotatedLst, parseGtTiers, matchToGt,
} from '../src/core/ranker-eval.js';

// --- tiny arg parse ----------------------------------------------------------
function parseArgs(argv) {
  const out = { score: null, k: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--index-path' || a === '--index_path') out.indexPath = argv[++i];
    else if (a === '--lst') out.lst = argv[++i];
    else if (a === '--gt') out.gt = argv[++i];
    else if (a === '--score') out.score = argv[++i];
    else if (a === '--k') out.k = parseInt(argv[++i], 10);
    else { console.error(`rank-eval: unknown argument '${a}'`); process.exit(2); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.indexPath || !args.lst || !args.gt) {
  console.error('usage: node scripts/rank-eval.mjs --index-path <idx> --lst <candidates.lst> --gt <gt.lst> [--score tags|position|calls|hotspot] [--k <n>]');
  process.exit(2);
}
if (args.score && !['tags', 'position', 'calls', 'hotspot'].includes(args.score)) {
  console.error(`rank-eval: --score must be tags|position|calls|hotspot (got '${args.score}')`);
  process.exit(2);
}

// --- load --------------------------------------------------------------------
const index = new CodeSearchIndex({ indexPath: args.indexPath });
index._ensureFunctionIndex?.();
const lstText = fs.readFileSync(args.lst, 'utf8');
const gtText = fs.readFileSync(args.gt, 'utf8');

// Resolve `file@func` specs to unique indexed functions — the same per-line
// contract as loadGroundTruth (mechanism-grouper.js), but keeping the match
// metadata (bare name, lines) the mechanical priors need.
function resolveSpecs(specs) {
  const members = [], unresolved = [];
  for (const spec of specs) {
    const { fileHint, funcName } = parseFuncSpec(spec);
    const ms = index.findFunctionMatches(funcName, fileHint);
    if (ms && ms.length === 1) {
      const m = ms[0];
      const bare = (m.name.includes('::') ? m.name.split('::').pop() : m.name).split('@')[0];
      members.push({ id: `${m.filepath}@${m.name}`, bare, lines: (m.end || 0) - (m.start || 0) + 1 });
    } else unresolved.push(`${spec} (${ms && ms.length > 1 ? 'ambig' : 'miss'})`);
  }
  return { members, unresolved };
}

const candidates = parseAnnotatedLst(lstText).map((g) => {
  const { members, unresolved } = resolveSpecs(g.specs);
  return { ...g, members, unresolved, ids: new Set(members.map((m) => m.id)) };
});
const gtGroups = parseGtTiers(gtText).map((g) => {
  const { members, unresolved } = resolveSpecs(g.specs);
  return { ...g, members, unresolved, ids: new Set(members.map((m) => m.id)) };
});

const candUnresolved = candidates.flatMap((c) => c.unresolved);
const gtUnresolved = gtGroups.flatMap((g) => g.unresolved);
for (const u of gtUnresolved) console.error(`  gt unresolved: ${u}`);

// --- ordering score ----------------------------------------------------------
const hasTags = candidates.some((c) => c.priority != null);
const mode = args.score || (hasTags ? 'tags' : 'position');

let callCounts = null;
if (mode === 'calls' || mode === 'hotspot') callCounts = index.getCallCounts(false) || {};
const callsOf = (m) => callCounts[m.bare] || 0;

for (const [i, c] of candidates.entries()) {
  c.score =
    mode === 'tags' ? (c.priority != null ? c.priority : null)
    : mode === 'position' ? -i
    : mode === 'calls' ? Math.max(0, ...c.members.map(callsOf))
    : Math.max(0, ...c.members.map((m) => callsOf(m) * Math.log2(Math.max(m.lines, 2))));
}

// Best-first ordering: stable sort by score desc; null scores (untagged groups
// in tags mode) sink to the bottom. In tags mode the .lst is already emitted in
// rank order, so the sort is a no-op there by construction.
const ordering = [...candidates].sort((a, b) => ((b.score ?? -Infinity) - (a.score ?? -Infinity)));
const posOf = new Map(ordering.map((c, i) => [c, i]));

// --- report ------------------------------------------------------------------
const base = (p) => String(p).replace(/\\/g, '/').split('/').pop();
console.log(`# rank-eval  index=${base(args.indexPath)}  lst=${base(args.lst)}  score=${mode}  gt=${base(args.gt)}`);
const memberTotal = candidates.reduce((n, c) => n + c.specs.length, 0);
console.log(`# candidates: ${candidates.length} groups, ${memberTotal - candUnresolved.length}/${memberTotal} members resolved${candUnresolved.length ? ` (${candUnresolved.length} unresolved)` : ''}`);
const gtAnchorTotal = gtGroups.reduce((n, g) => n + g.specs.length, 0);
const tiered = gtGroups.filter((g) => g.tier != null);
console.log(`# gt: ${gtGroups.length} groups (${tiered.length} tiered), ${gtAnchorTotal - gtUnresolved.length}/${gtAnchorTotal} anchors resolved${gtUnresolved.length ? ` (${gtUnresolved.length} unresolved)` : ''}`);
console.log('');

const matched = matchToGt(candidates, gtGroups);
const unmatched = matched.filter((r) => !r.cand);

// Ranking metrics — need tiered GT.
if (!tiered.length) {
  console.log('# ordering: GT has no [P<n>] tier tags — correlation/recall skipped (purity only).');
} else {
  const pairs = matched.filter((r) => r.cand && r.gt.tier != null && r.cand.score != null);
  const rho = spearman(pairs.map((r) => r.gt.tier), pairs.map((r) => r.cand.score));
  console.log(`# ordering (${mode}):`);
  console.log(`#   spearman(midrank) rho=${rho == null ? 'n/a (degenerate)' : rho.toFixed(3)}  over ${pairs.length} GT-matched pairs`);
  const topTier = Math.max(...tiered.map((g) => g.tier));
  const worthy = matched.filter((r) => r.gt.tier === topTier);
  for (const k of [...new Set([args.k || worthy.length, (args.k || worthy.length) + 3])]) {
    if (k <= 0) continue;
    const hits = worthy.filter((r) => r.cand && posOf.get(r.cand) < k).length;
    console.log(`#   recall@${k} = ${worthy.length ? (hits / worthy.length).toFixed(2) : 'n/a'}  (${hits}/${worthy.length} top-tier [P${topTier}] GT groups in the top ${k})`);
  }
}
console.log('');

// Purity — mechanism identity only; works on untiered GT.
const labelById = new Map();
for (const g of gtGroups) for (const id of g.ids) if (!labelById.has(id)) labelById.set(id, g.label);
const purity = scorePurity(candidates, (id) => labelById.get(id) ?? null);
console.log(`# purity: weighted-mean=${purity.weightedMean == null ? 'n/a' : purity.weightedMean.toFixed(2)}  (${purity.labeledTotal} GT-labeled members of ${purity.memberTotal})`);
for (const r of purity.rows) {
  if (r.purity == null) continue;
  const flag = r.purity < 1 && r.labeled >= 2 ? '  <-- impure' : '';
  console.log(`#   ${r.purity.toFixed(2)}P  ${r.labeled}L/${r.total} across ${r.mechanisms} mech  ${r.label.slice(0, 48)}  (majority: ${String(r.majorityLabel).slice(0, 40)})${flag}`);
}
if (unmatched.length) {
  console.log('');
  console.log(`# unmatched GT groups (no candidate overlap): ${unmatched.length}`);
  for (const r of unmatched) console.log(`#   ${r.gt.label.slice(0, 70)}`);
}
