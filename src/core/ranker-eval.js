// ranker-eval.js — dev harness scoring candidate orderings and group purity: tie-aware Spearman, recall@k, GT matching
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// ranker-eval.js — #284 ranker-scoring-harness: ground-truth-backed scoring of
// candidate-group ORDERINGS (tie-aware priority rank-correlation + recall@k)
// and of candidate-group PURITY, so ranking/candidate quality is a number
// instead of an eyeball (the `ranker-purpose-signal` lesson: judgment-tuning
// without a metric thrashes).
//
// DEV HARNESS, pure functions only — no index access, no LLM, no pipeline
// coupling; `--pseudo-claims` never imports this. The runner
// (scripts/rank-eval.mjs) wires these to a real index; test/test_ranker_eval.js
// pins the math on hand-computable cases.
//
// Ground truth is CALLER-SUPPLIED text (same legal gate as the grouper's GT
// scoring in mechanism-grouper.js): the Class-A hand-curated tier file stays
// gitignored (root /*.lst) and is never referenced from shipped code or
// committed tests — committed tests use synthetic text only.
//
// GRAMMAR SYNC: parseAnnotatedLst() parses the candidate-.lst header grammar
// EMITTED by formatAnchors (mechanism-grouper.js) and the --rank emit
// (pseudo-claims.js): `# label  (N fns)  [P<n> signal/fold — note]  — purpose`.
// If either emit changes shape, this parser must track it.

// Average (mid) ranks, 1-based, ascending — tied values share the mean of the
// ranks they span. The tie handling is the point: P0–P3 tiers over ~23 groups
// tie heavily, and naive Spearman degrades silently on ties.
export function midranks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j + 2) / 2; // mean of 1-based positions i+1 .. j+1
    for (let k = i; k <= j; k++) ranks[order[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

// Tie-corrected Spearman: Pearson correlation of the midranks. Returns a rho in
// [-1, 1], or null when it is undefined (fewer than 2 pairs, length mismatch,
// or a constant side — a flat ordering has no ranking to correlate, which is
// itself a finding the caller should report, not a 0).
export function spearman(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length || xs.length < 2) return null;
  const rx = midranks(xs), ry = midranks(ys);
  const n = rx.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = rx[i] - mx, dy = ry[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

// Of the `worthy` keys, how many appear in the first k of `orderedKeys`
// (best-first)? recall is null when the worthy set is empty (no denominator).
export function recallAtK(orderedKeys, worthy, k) {
  const w = worthy instanceof Set ? worthy : new Set(worthy);
  if (!w.size) return { k, hits: 0, recall: null };
  const kk = Math.max(0, Math.min(k, orderedKeys.length));
  let hits = 0;
  for (let i = 0; i < kk; i++) if (w.has(orderedKeys[i])) hits++;
  return { k, hits, recall: hits / w.size };
}

// Group purity as MAJORITY-SHARE over GT-labeled members — not span-count: a
// 19+1 group and a 10+10 group both "span 2" mechanisms but are utterly
// different defects (0.95 vs 0.50 here). Members `labelOf` cannot label
// (unlabeled — the GT is a partial hand-curated set) are EXCLUDED from purity
// and reported as coverage instead, so unlabeled noise can't silently count
// for or against a group.
//
// `groups`: [{label, ids: iterable of member ids}]; `labelOf(id)`: the GT
// mechanism label for a member, or null/undefined when the GT doesn't cover it.
// weightedMean weights each group by its labeled-member count (sum of
// majorities / sum of labeled), so a 2-member sliver can't swing the corpus
// number the way a flat mean of per-group purities would.
export function scorePurity(groups, labelOf) {
  const rows = [];
  let labeledTotal = 0, memberTotal = 0, majoritySum = 0;
  for (const g of groups) {
    const counts = new Map();
    let labeled = 0, total = 0;
    for (const id of g.ids) {
      total++;
      const lbl = labelOf(id);
      if (lbl == null) continue;
      labeled++;
      counts.set(lbl, (counts.get(lbl) || 0) + 1);
    }
    let majority = 0, majorityLabel = null;
    for (const [lbl, n] of counts) if (n > majority) { majority = n; majorityLabel = lbl; }
    rows.push({ label: g.label, total, labeled, mechanisms: counts.size, majorityLabel, purity: labeled ? majority / labeled : null });
    memberTotal += total; labeledTotal += labeled; majoritySum += majority;
  }
  return { rows, weightedMean: labeledTotal ? majoritySum / labeledTotal : null, labeledTotal, memberTotal };
}

// Parse one emitted candidate-.lst header line into {label, priority, purpose}.
// Handles both emits: ranked `# label  (N fns)  [P2 signal/fold — note]  — purpose`
// and unranked `# label  (N fns)  — purpose`, plus `[unscored]`. The label may
// itself contain parens (`catalog (exportCatalogJson)`), so the split point is
// the FIRST `(N fns)`-shaped marker. The [P…] tag closes at the first `]` —
// ranker notes are bounded (≤120 chars, whitespace-collapsed) and `]`-free in
// practice; a `]` inside a note would truncate the tag strip, not the priority.
function parseCandidateHeader(line) {
  const h = line.replace(/^#+/, '').trim();
  const m = h.match(/^(.*?)\s*\(\d+\s*fns?\)\s*(.*)$/);
  let label = m ? m[1].trim() : h;
  let rest = m ? m[2] : '';
  let priority = null;
  const tag = rest.match(/^\[P([0-3])\b[^\]]*\]\s*(.*)$/);
  if (tag) { priority = Number(tag[1]); rest = tag[2]; }
  else { const un = rest.match(/^\[unscored\]\s*(.*)$/); if (un) rest = un[1]; }
  const purpose = rest.replace(/^[—–-]+\s*/, '').trim();
  return { label, priority, purpose };
}

// Parse a candidate anchors.lst (ranked or unranked emit) into ordered groups
// [{label, priority|null, purpose, specs:[…]}]. Banner and caveat `#` lines
// carry no member lines, so the zero-spec filter drops them — group order is
// the FILE order (which for a ranked emit IS the ranker's ordering, and for an
// unranked emit is the grouper's size-desc baseline).
export function parseAnnotatedLst(text) {
  const groups = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      cur = { ...parseCandidateHeader(line), specs: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) { cur = { label: '(implicit)', priority: null, purpose: '', specs: [] }; groups.push(cur); }
    cur.specs.push(line);
  }
  return groups.filter((g) => g.specs.length);
}

// Parse a ground-truth anchors.lst whose headers may carry a bare trailing tier
// tag — `# Label [P3]` — into [{label, tier|null, specs:[…]}]. The tag grammar
// is deliberately EXACT (`[P<0-3>]`, no note body, trailing) so it can never
// collide with the ranked-emit tag or with brackets inside a label. Untagged
// headers get tier null: ties and partial tiering are legitimate GT (which is
// why the correlation is tie-aware). Anchor RESOLUTION is not done here — the
// runner delegates that to the index (cf. loadGroundTruth in
// mechanism-grouper.js), keeping these parsers pure.
export function parseGtTiers(text) {
  const groups = [];
  let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const h = line.replace(/^#+/, '').trim();
      const tag = h.match(/\s*\[P([0-3])\]\s*$/);
      cur = { label: tag ? h.slice(0, tag.index).trim() : h, tier: tag ? Number(tag[1]) : null, specs: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) { cur = { label: '(implicit)', tier: null, specs: [] }; groups.push(cur); }
    cur.specs.push(line);
  }
  return groups.filter((g) => g.specs.length);
}

// Pair each GT group with the candidate group sharing the most resolved member
// ids (the `evaluate()` pattern from mechanism-grouper.js, reused for the
// ranking view). Zero overlap -> cand null (reported unmatched, excluded from
// correlation). Overlap ties keep the FIRST candidate in list order —
// deterministic, since candidate order comes from the .lst file. Several GT
// groups matching ONE candidate is expected (that candidate is impure — the
// purity metric counts it); each GT group still scores against that
// candidate's position.
export function matchToGt(candidates, gtGroups) {
  return gtGroups.map((g) => {
    let best = null, bestOv = 0;
    for (const c of candidates) {
      let ov = 0;
      for (const id of g.ids) if (c.ids.has(id)) ov++;
      if (ov > bestOv) { bestOv = ov; best = c; }
    }
    return { gt: g, cand: best, overlap: bestOv };
  });
}
