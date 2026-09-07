// pseudo-claim-triage.js — deterministic KEEP/REVIEW/DROP first cut over a run's pseudo-claims, each verdict carrying its reasons
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// pseudo-claim-triage: a deterministic FIRST CUT over a run's pseudo-claims,
// with every verdict carrying its reasons, so a 150-claim run does not need
// human eyeballs on all 150 before anyone knows where to look.
//
// Andrew, 2026-08-28: "Need some way for huge volume of pseudo-claims to be
// triaged; still hoping a first cut of that can be done by CE, not requiring
// human eyeballs." The file seed (7be38e6) makes 100-160 claims per run the
// normal volume.
//
// WHAT THE CUT IS, AND IS NOT. It is a ranking of a run's claims against EACH
// OTHER and against the population of claims CE has drafted, on signals that
// need no model call: is the claim a duplicate of a sibling, an echo of a
// bigger group over the same file, a split residue, a bookend-only shape, an
// ungrounded draft, or vocabulary every other claim in the run shares. It is
// NOT a judgment of novelty, importance, or patentability -- a claim can be
// DROP here because its sibling says the same thing better, and KEEP here
// while being worthless in the world. The LLM second cut (--rank over the
// survivors) and the user's judgment sit above it; this exists so they see
// the top half first.
//
// THRESHOLDS ARE PINNED FROM THE POPULATION, NOT FROM ANYONE'S PICKS. The
// numbers in TRIAGE_THRESHOLDS come from 341 claims across three 2026-08-28
// runs (CE082826_SEED 116, sr_gh_SEED 161, CE082826 64; the calibration is
// re-runnable -- see the item draft) and, where they concern shape, from the
// litigated-claim profile (0fffcdd). Andrew's eyeball picks are deliberately
// held back until after the cut exists and are then read off BLIND
// (test/fixtures/pseudo-claim-picks.json): a cut that reaches the picks
// because it was shown them says nothing about the next index. A threshold
// is not moved to reach a pick unless the move is population-justified and
// the commit says it was pick-motivated -- the same rule the genericity
// calibration follows for '101.
//
// What the population said (p10 / p50 / p90 unless noted):
//   nearest-sibling similarity (Jaccard on content stems)  .13 / .18 / .28,
//     max .64; the >= .40 tail (12 of 341) is the sr_gh variant-file pairs
//     (convert_codecontests_variant_v3 ~ _hacking_variant, compute_sae_responses
//     ~ compute_logit_lens_responses) -- the same claim drafted twice.
//   rare-stem share ("distinct within the run")             .08 / .17 / .30;
//     the bottom is `/ other` split residues and class sub-cuts, the top is
//     module files with a vocabulary of their own.
//   echoes (smaller group over a bigger group's dominant file) 76 of 341, but
//     echo->host similarity is .06 / .13 / .22 -- an echo is a DIFFERENT cut
//     of the same file, not a duplicate, so it is a REVIEW signal, not DROP,
//     unless it also reads like its host.
//   mechanism elements (claim-genericity.js)               3 / 6 / 9; fewer
//     than 2 in only 3 of 502 -- "shape without mechanism" is rare in
//     drafted output and decisive when it happens.
//   generic share of fine rows                             .10 / .21 / .36.
//   grounded anchors 4 / 7 / 11; nothing ungrounded in the modern runs (the
//     grounding pass already drops what does not resolve), 19 of 1,345 in the
//     older ones.
//   dependents: fresh stems per dependent (words not in claim 1) 3 / 8 / 15;
//     fully back-referential dependents are 13 of 4,330, so "weak" is
//     <= 2 fresh stems, not zero. UNDETERMINED kind: 16% of dependents.
//
// A weak dependent set does NOT sink claim 1: the dependents are graded tests
// beneath the independent claim, and a claim whose mechanism is sound with
// lazy dependents wants redrafting below, not dropping. It costs a point and
// a named reason, no more.

import { contentWords, stem } from './claim-terms.js';
import { echoPairs } from './mechanism-grouper.js';
import { classifyContribution } from './dep-claims.js';

export const TRIAGE_THRESHOLDS = {
  rareDf: 2,               // a stem in <= this many of the run's claims is rare
  dupSim: 0.40,            // nearest-sibling Jaccard at/above: near-duplicate (12 of 341)
  overlapSim: 0.28,        // p90: overlaps a sibling
  echoHostSim: 0.30,       // an echo this close to its host is the host again (1 of 76)
  distinctLow: 0.08,       // p10 of rare-stem share
  distinctLowish: 0.12,    // p25
  distinctHigh: 0.24,      // p75
  genericShareHigh: 0.36,  // p90 of generic / fine rows
  genericShareVeryHigh: 0.50,
  mechanismDrop: 2,        // fewer than this: shape without mechanism
  mechanismLow: 3,         // p10
  mechanismHigh: 8,        // p75
  droppedShareSome: 0.25,  // share of cited anchors that failed to ground
  droppedShareHigh: 0.50,
  depWeakFresh: 2,         // a dependent adding <= this many fresh stems is weak
  depWeakShare: 0.5,
  depUndetShare: 0.5,
  reviewAt: 2,             // score >= this: REVIEW
  dropAt: 4,               // score >= this: DROP (hard conditions drop regardless)
};

export const TIERS = ['KEEP', 'REVIEW', 'DROP'];

/** Content stems of a claim's text, the unit every similarity here is measured in. */
export function claimStems(text) {
  return new Set(contentWords(text).map(stem));
}

export function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? +(inter / union).toFixed(2) : 0;
}

// The body of a dependent after its "... of claim N" reference -- what it
// contributes -- without a regex the heredoc-backslash trap could eat.
export function dependentBody(text) {
  const s = String(text || '');
  const i = s.toLowerCase().indexOf('claim ');
  if (i < 0) return s;
  let j = i + 6;
  while (j < s.length && s[j] >= '0' && s[j] <= '9') j++;
  return s.slice(j);
}

/**
 * Clause-level facet count of a dependent's contribution
 * (pseudo-dep-tightening). Conservative by design: counts `;` boundaries
 * and "and wherein" joins; an enumeration inside one clause still counts as
 * one facet, so this UNDERCOUNTS width -- a facets>1 reading is certain
 * bundling, never a false positive from a list of species.
 */
export function dependentFacetCount(text) {
  const body = dependentBody(text);
  return 1 + (body.match(/;/g) || []).length + (body.match(/\band\s+wherein\b/gi) || []).length;
}

/** What a dependent adds beyond claim 1: fresh stems, and its contribution kind. */
export function dependentSignal(claimOneStems, dep) {
  const text = dep && typeof dep === 'object' ? dep.text : dep;
  const words = contentWords(dependentBody(text)).map(stem);
  const fresh = [...new Set(words.filter((w) => !claimOneStems.has(w)))];
  return { n: dep && dep.n, kind: classifyContribution(text).kind, words: words.length, fresh: fresh.length, freshWords: fresh.slice(0, 5), facets: dependentFacetCount(text) };
}

const keyOf = (c) => c.label || `#${c.n}`;
const isSplitResidue = (key) => /\/\s*other\s*$/i.test(String(key));

/**
 * Triage a claims sidecar (`<claims>.txt.anchors.json`, buildAnchorSidecar's
 * shape). Returns `{ claims: [{ n, label, tier, score, reasons, signals }],
 * tiers: { KEEP, REVIEW, DROP }, thresholds }` in the sidecar's order.
 *
 * `shapeReport(claim, dependents)` is passed in (pseudo-claims.js owns it) for
 * claims whose sidecar predates the shape field; without it, and without a
 * stored shape, the mechanism rules simply do not fire for that claim.
 */
export function triageClaims(sidecar, { shapeReport = null, thresholds = {} } = {}) {
  const T = { ...TRIAGE_THRESHOLDS, ...thresholds };
  const claims = (sidecar && Array.isArray(sidecar.claims)) ? sidecar.claims : [];
  // Stems are the unit of comparison; the WORDS are what a reader is shown
  // (`enforcing, outbound, scrubbing`, not `enforc, outbou, scrubb` -- Andrew,
  // 2026-08-29, on the first table). First occurrence wins.
  const rows = claims.map((c) => {
    const words = contentWords(c.claim);
    const wordFor = new Map();
    for (const w of words) { const s = stem(w); if (!wordFor.has(s)) wordFor.set(s, w); }
    return { c, key: keyOf(c), stems: new Set(words.map(stem)), wordFor };
  });

  // Run-level document frequency of stems: what "rare within this run" means.
  const df = new Map();
  for (const r of rows) for (const s of r.stems) df.set(s, (df.get(s) || 0) + 1);

  // Echoes, computed from the grounded anchors' files exactly as the grouper
  // computes them for candidate groups (dominant file shared, smaller loses).
  const groups = rows.map((r) => ({ label: r.key, members: (r.c.grounded || []).map((a) => ({ file: a.file })) }));
  const hostOf = new Map();
  for (const p of echoPairs(groups)) hostOf.set(p.echo.label, p.host.label);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  for (const r of rows) {
    const c = r.c;
    const sh = c.shape || (shapeReport ? shapeReport(c.claim, c.dependents == null ? null : c.dependents) : null);
    let maxSim = 0, simKey = null;
    for (const o of rows) {
      if (o === r) continue;
      // pseudo-claims-statutory-class: near-duplicate compares WITHIN a class
      // only -- a method and its system counterpart under `both` are the same
      // mechanism on purpose.
      if ((o.c.class || 'method') !== (r.c.class || 'method')) continue;
      const j = jaccard(r.stems, o.stems);
      if (j > maxSim) { maxSim = j; simKey = o.key; }
    }
    const rare = [...r.stems].filter((s) => (df.get(s) || 0) <= T.rareDf);
    const grounded = (c.grounded || []).length;
    const dropped = (c.dropped || []).length;
    const deps = c.dependents == null ? null : c.dependents.map((d) => dependentSignal(r.stems, d));
    const fine = sh && sh.axes && sh.axes.fine ? sh.axes.fine.value : null;
    const host = hostOf.get(r.key) || null;
    r.signals = {
      mechanism: sh ? sh.mechanism : null,
      generic: sh ? sh.generic : null,
      genericShare: sh && fine ? +(sh.generic / fine).toFixed(2) : null,
      maxSim, simKey,
      distinct: +(rare.length / Math.max(1, r.stems.size)).toFixed(2),
      rare: rare.slice(0, 6).map((s) => r.wordFor.get(s) || s),
      grounded, dropped,
      droppedShare: grounded + dropped ? +(dropped / (grounded + dropped)).toFixed(2) : null,
      files: new Set((c.grounded || []).map((a) => a.file)).size,
      truncated: !!c.truncated,
      echoOf: host,
      hostSim: host && byKey.get(host) ? jaccard(r.stems, byKey.get(host).stems) : null,
      splitResidue: isSplitResidue(r.key),
      dependents: deps ? deps.length : null,
      depWeak: deps ? deps.filter((d) => d.fresh <= T.depWeakFresh).length : null,
      depUndetermined: deps ? deps.filter((d) => d.kind === 'UNDETERMINED').length : null,
      depBundled: deps ? deps.filter((d) => d.facets > 1).length : null,
    };
  }

  for (const r of rows) {
    const s = r.signals;
    const reasons = [];
    let score = 0;
    let hard = false;
    const pct = (x) => `${Math.round(x * 100)}%`;

    if (s.mechanism != null) {
      if (s.mechanism < T.mechanismDrop) { hard = true; reasons.push(`only ${s.mechanism} mechanism element(s): shape without mechanism`); }
      else if (s.mechanism <= T.mechanismLow) { score += 1; reasons.push(`${s.mechanism} mechanism elements (population p10 is ${T.mechanismLow})`); }
      else if (s.mechanism >= T.mechanismHigh) { score -= 1; reasons.push(`${s.mechanism} mechanism elements`); }
    }
    if (s.grounded === 0) { hard = true; reasons.push('no grounded anchor: cannot be charted back to the code'); }
    else if (s.droppedShare != null && s.droppedShare >= T.droppedShareHigh) { score += 2; reasons.push(`${s.dropped} of ${s.grounded + s.dropped} cited anchors failed to ground`); }
    else if (s.droppedShare != null && s.droppedShare >= T.droppedShareSome) { score += 1; reasons.push(`${s.dropped} of ${s.grounded + s.dropped} cited anchors failed to ground`); }
    if (s.truncated) { score += 2; reasons.push('draft truncated at the output budget'); }
    // pseudo-dep-tightening: informational only -- names the bundle, moves no
    // score. The fix belongs to the drafter, not the triage.
    if (s.depBundled) reasons.push(`${s.depBundled} bundled dependent(s) (multi-facet wherein)`);

    if (s.maxSim >= T.dupSim && s.simKey) {
      const o = byKey.get(s.simKey);
      const loses = o ? (s.distinct < o.signals.distinct || (s.distinct === o.signals.distinct && r.c.n > o.c.n)) : false;
      if (loses) { hard = true; reasons.push(`near-duplicate of ${s.simKey} (similarity ${s.maxSim}); that one kept as the more distinctive`); }
      else reasons.push(`near-duplicate pair with ${s.simKey} (similarity ${s.maxSim}); kept as the more distinctive`);
    } else if (s.maxSim >= T.overlapSim && s.simKey) {
      score += 2; reasons.push(`overlaps ${s.simKey} (similarity ${s.maxSim})`);
    }
    if (s.echoOf) {
      if (s.hostSim != null && s.hostSim >= T.echoHostSim) { score += 3; reasons.push(`echo of ${s.echoOf}, and reads like it (similarity ${s.hostSim})`); }
      else { score += 2; reasons.push(`echo of ${s.echoOf}: a smaller cut of the same dominant file`); }
    }
    if (s.splitResidue) { score += 2; reasons.push('split residue ("/ other"): the members no sub-group claimed'); }
    if (s.distinct <= T.distinctLow) { score += 2; reasons.push(`vocabulary generic within this run (${pct(s.distinct)} rare stems; population p10 is ${pct(T.distinctLow)})`); }
    else if (s.distinct <= T.distinctLowish) { score += 1; reasons.push(`vocabulary mostly shared with the run (${pct(s.distinct)} rare stems)`); }
    else if (s.distinct >= T.distinctHigh) { score -= 1; reasons.push(`distinctive vocabulary: ${s.rare.join(', ')}`); }
    if (s.genericShare != null) {
      if (s.genericShare >= T.genericShareVeryHigh) { score += 2; reasons.push(`${pct(s.genericShare)} of rows generic (I/O bookends)`); }
      else if (s.genericShare >= T.genericShareHigh) { score += 1; reasons.push(`${pct(s.genericShare)} of rows generic (population p90 is ${pct(T.genericShareHigh)})`); }
    }
    if (s.dependents) {
      if (s.depWeak / s.dependents >= T.depWeakShare) { score += 1; reasons.push(`${s.depWeak} of ${s.dependents} dependents add <= ${T.depWeakFresh} new words to claim 1`); }
      if (s.depUndetermined / s.dependents >= T.depUndetShare) { score += 1; reasons.push(`${s.depUndetermined} of ${s.dependents} dependents UNDETERMINED (neither narrowing nor adding)`); }
    }

    r.score = score;
    r.hard = hard;
    r.reasons = reasons;
    r.tier = hard || score >= T.dropAt ? 'DROP' : score >= T.reviewAt ? 'REVIEW' : 'KEEP';
  }

  const out = rows.map((r) => ({ n: r.c.n, label: r.c.label || '', tier: r.tier, score: r.score, hard: r.hard, reasons: r.reasons, signals: r.signals }));
  const tiers = { KEEP: 0, REVIEW: 0, DROP: 0 };
  for (const r of out) tiers[r.tier]++;
  return { claims: out, tiers, thresholds: T };
}

const TIER_ORDER = { KEEP: 0, REVIEW: 1, DROP: 2 };

/** The ranked Markdown table: KEEP first, best score first within a tier. */
export function formatTriage(result, { source = '' } = {}) {
  const rows = [...result.claims].sort((a, b) => (TIER_ORDER[a.tier] - TIER_ORDER[b.tier]) || (a.score - b.score) || (a.n - b.n));
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const t = result.tiers;
  const out = [
    '# Pseudo-claim triage -- illustrative first cut, NOT legal analysis',
    '',
    '_A deterministic ranking of this run\'s pseudo-claims against each other and against the population',
    'of claims CE has drafted: duplicates, echoes, split residues, shape without mechanism, ungrounded',
    'drafts, run-generic vocabulary. NOT a judgment of novelty, importance, or patentability, and not an',
    'admission about any code or claim. DROP means "look at the others first", never "worthless"._',
    '',
    `**Source:** \`${esc(source)}\`  `,
    `**Claims:** ${result.claims.length} -- **KEEP ${t.KEEP}**, REVIEW ${t.REVIEW}, DROP ${t.DROP}  `,
    `**Cut:** score >= ${result.thresholds.reviewAt} REVIEW, >= ${result.thresholds.dropAt} DROP; shape without mechanism, no grounded anchor, and the loser of a near-duplicate pair DROP outright.`,
    '',
    '| # | tier | score | claim | class | mech | grounded | distinct | reasons |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const s = r.signals;
    out.push(`| ${r.n} | ${r.tier} | ${r.score}${r.hard ? '*' : ''} | ${esc(r.label)} | ${esc((r.c && r.c.class) || 'method')} | ${s.mechanism == null ? '?' : s.mechanism} | ${s.grounded}${s.dropped ? `+${s.dropped}` : ''} | ${s.distinct} | ${r.reasons.length ? esc(r.reasons.join('; ')) : '--'} |`);
  }
  out.push('', '_`*` = a hard condition decided the tier. `mech` = mechanism-class elements in claim 1; `grounded` = anchors that resolved (+ cited but unresolved); `distinct` = share of the claim\'s content stems rare within this run._');
  return out.join('\n') + '\n';
}

/** The KEEP tier as a sidecar of its own (renumbered), a drop-in for whatever consumed the full one. */
export function keepSidecar(sidecar, result, { source = '', triagePath = '' } = {}) {
  const keep = new Set(result.claims.filter((r) => r.tier === 'KEEP').map((r) => r.n));
  const verdict = new Map(result.claims.map((r) => [r.n, r]));
  const claims = (sidecar.claims || []).filter((c) => keep.has(c.n)).map((c, i) => {
    const v = verdict.get(c.n);
    return { ...c, n: i + 1, sourceN: c.n, triage: { tier: v.tier, score: v.score, reasons: v.reasons } };
  });
  return {
    ...sidecar,
    note: `${sidecar.note || ''} TRIAGE: the KEEP tier of ${source} (${claims.length} of ${(sidecar.claims || []).length}); the ranked table with reasons is ${triagePath}. \`sourceN\` is each claim's number in the full run.`.trim(),
    triage: { source, table: triagePath, tiers: result.tiers, thresholds: result.thresholds },
    claims,
  };
}

/** The KEEP tier as a claims-only file, in the form --synonymize / --claim-chart read (one claim per line). */
export function formatKeepFile(keep, { source = '', triagePath = '', keepPath = '', ceVersion = '', generatedAt = '' } = {}) {
  const deps = keep.claims.reduce((n, c) => n + (c.dependents || []).length, 0);
  const header = [
    '# Pseudo-claims -- illustrative drafting exercise, NOT legal analysis.',
    '# NOT patent claims. Generated for retrieval testing; do not file, quote, or rely on.',
    '# Format:     one claim per line',
    `# Claims:     ${keep.claims.length} (the KEEP tier of ${keep.triage.tiers.KEEP + keep.triage.tiers.REVIEW + keep.triage.tiers.DROP} triaged; ${keep.triage.tiers.REVIEW} REVIEW and ${keep.triage.tiers.DROP} DROP left out)`,
    `# Triage:     ${triagePath}`,
    `# Source:     ${source}`,
    `# Anchors:    ${keep.claims.reduce((n, c) => n + (c.grounded || []).length, 0)} grounded, in ${keepPath}.anchors.json`,
    ...(deps ? [`# Dependents: ${deps} drafted, NOT in this file (independent claims only); see ${keepPath}.anchors.json`] : []),
    `# CE:         ${ceVersion}`,
    `# Generated:  ${generatedAt}`,
  ];
  return `${header.join('\n')}\n${keep.claims.map((c) => c.claim).join('\n')}\n`;
}
