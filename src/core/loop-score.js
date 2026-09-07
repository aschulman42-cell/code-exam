// loop-score.js — scores a blind claim chart against drafted anchors: recall, mechanism PRESENT, control FPs, dependent grades
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// loop-score: the pseudo-claim loop's scorer (pseudo-claim-loop-test, #311).
//
// The loop manufactures ground truth (HOF): a pseudo-claim drafted FROM known
// anchors is charted BLIND, and the sidecar's grounded anchors are the answer
// key. This module turns one claim's chart verdicts (and optionally a control
// index's, a synonymized wording's, and a perturbed-dependent family's) into
// numbers a soak can track:
//
//   - retrieval recall     -- which anchors the chart retrieved at all;
//   - mechanism PRESENT    -- over MECHANISM-class rows only (the classes ride
//     in the verdicts sidecar since d4ef852), PRESENT on an ANCHOR counted
//     apart from PRESENT elsewhere. "Elsewhere" may be right -- a parallel
//     implementation, a caller -- but it is not the drafted truth, and the
//     '101 work showed it inflating exactly when recall falls;
//   - generic rows         -- reported, never scored (they read on anything);
//   - false PRESENT on Y   -- mechanism rows PRESENT against a control index
//     that does not contain the mechanism;
//   - dependent grades     -- a real dependent's judged row expected PRESENT
//     where its parent's code is, a PERTURBED dependent's expected ABSENT on
//     the same code. A chart that says PRESENT to both measures nothing.
//
// PURE on purpose: no model, no filesystem, no imports from commands/. The
// merge is INJECTED (claim-chart.js's mergeBestPerElement) so this module can
// be tested with a two-line stub and never drifts from the chart's real rule.
//
// Reference numbers (2026-08-29/30, claude-sonnet-4-6, artifacts in the repo
// root): ATSEL positive control 9/9 PRESENT, recall 0.75, crux at element 5
// rank 0. CE_3 baseline (claims 69/105/90 of CE082826_SEED): recall 1.0 /
// 0.75 / 0.25 original wording, 1.0 / 0.5 / 0.13 synonymized, with PRESENT
// drifting off-anchor as recall falls. A GGUF run should reproduce these
// before its own numbers are read (asus-CC).

const short = (p) => String(p || '').split('/').pop().split('!').pop();

/** `file@fn` normalized to basename + bare function name. */
export function targetKey(target) {
  const s = String(target || '');
  const at = s.indexOf('@');
  const file = short(at >= 0 ? s.slice(0, at) : '');
  const fn = s.slice(at + 1).split('@')[0].split('::').pop();
  return `${file}@${fn}`;
}

/** The answer key: the sidecar claim's grounded anchors as target keys. */
export function anchorKeys(claim) {
  const out = new Set();
  for (const g of (claim && claim.grounded) || []) {
    out.add(`${short(g.file)}@${String(g.func || '').split('::').pop()}`);
  }
  return out;
}

/**
 * Deterministically perturb ONE specific in a dependent's text, recording the
 * edit. The perturbed dependent still reads like a claim but no longer matches
 * the code, so its chart row is EXPECTED ABSENT -- the negative half of the
 * graded test. Returns { text, edit } or null when no perturbation site exists
 * (report it; do not invent one).
 */
export function perturbDependent(text) {
  const full = String(text || '');
  // Split off the "... of claim N" reference first: it is never a
  // perturbation site. Bumping it (the run-B failure, 2026-08-31) turns
  // "claim 1" into a self-reference the family cycle detection then
  // correctly drops -- the negative arm silently never exists. Same
  // regex-free scan shape as pseudo-claim-triage's dependentBody.
  const lower = full.toLowerCase();
  const at = lower.indexOf('claim ');
  let head = '';
  let s = full;
  if (at >= 0) {
    let j = at + 6;
    while (j < full.length && full[j] >= '0' && full[j] <= '9') j++;
    head = full.slice(0, j);
    s = full.slice(j);
  }
  const num = s.match(/\b(\d+)\b/);
  if (num) {
    const v = String(Number(num[1]) + 1);
    return { text: head + s.slice(0, num.index) + v + s.slice(num.index + num[1].length), edit: `number ${num[1]} -> ${v}` };
  }
  const swaps = [
    [/\bgreater\b/, 'less'], [/\bless\b/, 'greater'],
    [/\bascending\b/, 'descending'], [/\bdescending\b/, 'ascending'],
    [/\bincludes\b/, 'excludes'], [/\bexcludes\b/, 'includes'],
    [/\bbefore\b/, 'after'], [/\bafter\b/, 'before'],
  ];
  for (const [re, to] of swaps) {
    const m = s.match(re);
    if (m) return { text: head + s.replace(re, to), edit: `"${m[0]}" -> "${to}"` };
  }
  const is = s.match(/\b is \b/);
  if (is) return { text: head + s.replace(/\b is \b/, ' is not '), edit: '"is" -> "is not"' };
  return null;
}

const nominatorsOf = (verdicts) => new Map((verdicts.analysed || []).map((a) => [a.target, a.nominatedBy || []]));

/**
 * Score one chart run of one claim against its sidecar entry.
 * `verdicts` is the --verdicts-out JSON; `merge` is claim-chart.js's
 * mergeBestPerElement, injected. Returns the flat numbers plus per-row detail.
 */
export function scoreChart({ claim, verdicts, merge }) {
  const anchors = anchorKeys(claim);
  const analysed = verdicts.analysed || [];
  const retrieved = [];
  for (const a of analysed) {
    const k = targetKey(a.target);
    if (anchors.has(k)) retrieved.push({ key: k, target: a.target, nominatedBy: a.nominatedBy || [] });
  }
  const fills = merge(analysed.map((a) => ({ target: a.target, elements: a.elements })), { nominators: nominatorsOf(verdicts) });
  const classes = verdicts.elementClasses || [];
  const rowClass = (el) => classes[(el || 0) - 1] || 'unknown';
  const rows = fills
    .filter((f) => f.element != null)
    .sort((a, b) => a.element - b.element)
    .map((f) => ({
      element: f.element,
      class: rowClass(f.element),
      label: f.label,
      target: f.target || null,
      onAnchor: f.target ? anchors.has(targetKey(f.target)) : false,
      agreement: f.agreement || null,
    }));
  const mech = rows.filter((r) => r.class === 'mechanism');
  const mechPresent = mech.filter((r) => r.label === 'PRESENT');
  // "Some anchor said PRESENT on this row" -- the merge may have cited another
  // target; this is what the row's answer key actually supports.
  const anchorPresentRows = new Set();
  for (const a of analysed) {
    if (!anchors.has(targetKey(a.target))) continue;
    for (const e of a.elements || []) if (e.label === 'PRESENT') anchorPresentRows.add(e.element);
  }
  return {
    anchors: [...anchors],
    retrieved: retrieved.map((r) => ({ key: r.key, nominatedBy: r.nominatedBy })),
    recall: anchors.size ? +(retrieved.length / anchors.size).toFixed(2) : null,
    elements: rows.length,
    mechanismRows: mech.length,
    mechanismPresent: mechPresent.length,
    mechanismPresentOnAnchor: mechPresent.filter((r) => r.onAnchor).length,
    mechanismPresentElsewhere: mechPresent.filter((r) => !r.onAnchor).length,
    mechanismRowsAnchorSupported: mech.filter((r) => anchorPresentRows.has(r.element)).length,
    genericRows: rows.filter((r) => r.class === 'generic').length,
    genericPresent: rows.filter((r) => r.class === 'generic' && r.label === 'PRESENT').length,
    lonePresent: rows.filter((r) => r.label === 'PRESENT' && r.agreement && (r.agreement.PRESENT || 0) <= 1).length,
    rows,
  };
}

/** Mechanism rows PRESENT against a control index that lacks the mechanism. */
export function scoreControl({ verdicts, merge }) {
  const fills = merge((verdicts.analysed || []).map((a) => ({ target: a.target, elements: a.elements })), { nominators: nominatorsOf(verdicts) });
  const classes = verdicts.elementClasses || [];
  const mech = fills.filter((f) => f.element != null && classes[f.element - 1] === 'mechanism');
  return {
    mechanismRows: mech.length,
    falsePresent: mech.filter((f) => f.label === 'PRESENT').length,
    falsePartial: mech.filter((f) => f.label === 'PARTIAL').length,
  };
}

/**
 * Grade the dependents: pair the real family's judged rows with the perturbed
 * family's by designation. A discriminating pair is real=PRESENT and
 * perturbed!=PRESENT; a pair PRESENT on both measures nothing and says so.
 */
export function gradeDependents(realFamily, perturbedFamily = null, perturbEdits = null) {
  const judged = (fam) => {
    const out = new Map();
    for (const m of (fam && fam.members) || []) {
      for (const r of m.rows || []) if (r.origin !== 'inherited') out.set(r.designation, { ...r, claim: m.n });
    }
    return out;
  };
  const real = judged(realFamily);
  const pert = judged(perturbedFamily);
  const grades = [];
  for (const [d, r] of real) {
    const p = pert.get(d) || null;
    const edit = perturbEdits && perturbEdits.get ? perturbEdits.get(d) || null : null;
    grades.push({
      designation: d, claim: r.claim, origin: r.origin,
      real: r.label, realTarget: r.target || null,
      perturbed: p ? p.label : null, edit,
      discriminates: p ? (r.label === 'PRESENT' && p.label !== 'PRESENT') : null,
      vacuous: p ? (r.label === 'PRESENT' && p.label === 'PRESENT') : null,
    });
  }
  return {
    grades,
    judged: grades.length,
    realPresent: grades.filter((g) => g.real === 'PRESENT').length,
    discriminating: grades.filter((g) => g.discriminates).length,
    vacuous: grades.filter((g) => g.vacuous).length,
  };
}

/** One Markdown scorecard for a run of claims. Engine/model/CE stamped by the caller's meta. */
export function formatScorecard(perClaim, meta = {}) {
  const out = [];
  out.push('# pseudo-claim loop scorecard');
  out.push('');
  out.push(`_${perClaim.length} claim(s); index \`${meta.index || '?'}\`${meta.control ? `, control \`${meta.control}\`` : ''}; engine ${meta.engine || '?'}; CE ${meta.ce || '?'}; ${meta.generatedAt || ''}._`);
  out.push('_Recall = drafted anchors the blind chart retrieved. Mechanism rows only are scored; PRESENT **on an anchor** is the drafted truth, PRESENT elsewhere may be right and is counted apart. Generic rows read on anything and are reported, never scored. Temp-0 runs are not reproducible across days; compare within a run._');
  out.push('');
  out.push('| claim | arm | recall | mech rows | PRESENT on-anchor / elsewhere | anchor-supported | generic PRESENT | lone PRESENT |' + (meta.control ? ' control false PRESENT |' : ''));
  out.push('|---|---|---|---|---|---|---|---|' + (meta.control ? '---|' : ''));
  for (const c of perClaim) {
    for (const [arm, s] of Object.entries(c.arms || {})) {
      if (!s) continue;
      out.push(`| ${c.n} ${c.label ? `(${c.label})` : ''} | ${arm} | ${s.recall} | ${s.mechanismRows} | ${s.mechanismPresentOnAnchor} / ${s.mechanismPresentElsewhere} | ${s.mechanismRowsAnchorSupported} | ${s.genericPresent}/${s.genericRows} | ${s.lonePresent} |`
        + (meta.control ? ` ${c.control ? c.control.falsePresent + '/' + c.control.mechanismRows : '—'} |` : ''));
    }
    if (c.dependents) {
      out.push(`| | dependents | | ${c.dependents.judged} judged | ${c.dependents.realPresent} PRESENT real | ${c.dependents.discriminating} discriminate | ${c.dependents.vacuous} vacuous (PRESENT on real AND perturbed) | |` + (meta.control ? ' |' : ''));
    }
  }
  return out.join('\n') + '\n';
}
