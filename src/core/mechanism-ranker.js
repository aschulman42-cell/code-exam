// mechanism-ranker.js — one comparative LLM pass assigning each candidate group a bounded exploration-priority verdict
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// mechanism-ranker.js — #284 ranker Phase 0 (OBSERVE-ONLY).
//
// Assigns each B1 candidate mechanism group a bounded exploration-PRIORITY
// verdict {priority, signal, fold, note} — a fast SURFACE heuristic for where to
// look FIRST, NOT a judgment of novelty, importance, or worth.
//
// PRIORITY IS RELATIVE. The first cut of this ranker scored each candidate in
// isolation (one call per group, absolute 0-3). With nothing forcing a spread,
// every model — including frontier ones — clustered almost everything at the top
// (Gemini 23/24 at P3; a local 12B piled 20/23 at P2; one lone demotion across
// four rankers). "Where to look first" is meaningless if everything is first. So
// the primary path is now a SINGLE COMPARATIVE PASS: all candidates in one
// prompt, ranked against each other, with a demotion-biased rubric and a forced
// spread. The worth caveat that (correctly) protects against dismissing a
// cluster's value lives in the emitted chart, NOT in the scoring prompt — those
// are different axes, and conflating them is what flattened the signal.
//
// OBSERVE-ONLY: it ANNOTATES candidates (the emit reorders + tags); it does NOT
// yet DROP or fold the bottom tier into an appendix (that is Phase 1 / --auto,
// gated on the graduation criteria in worklist-drafts/ranker-force-discrimination.md
// holding across >=2 corpora). Full design: pcrun_save_072526/_RANKER_SPEC.md.
//
// The LLM call reuses makeDrafter from llm-runner.js (the drafter's plumbing +
// fail-closed air-gap gate) — the ranker is a second consumer, not new infra.

// Observational SIGNALS (what a cluster RESEMBLES at the surface), NOT verdicts on
// the code. They order where to look first; they do not characterize novelty/worth.
export const PRIORITY_SIGNALS = ['codebase-specific', 'standard-pattern', 'library-wrapper', 'third-party', 'generated'];

// Mechanical priors — FEATURES for the seam, not verdicts: group size + how many
// files it spans (a concentrated cluster reads differently from a scattered one).
export function rankPriors(group) {
  const files = new Set((group.members || []).map((m) => m.file));
  return { members: (group.members || []).length, files: files.size };
}

// Normalize one raw verdict object into {priority, signal, fold, note}. Shared by
// the batch parser and the single-verdict parser so both apply identical clamping
// (priority 0-3, known signal else 'unclassified', valid fold else 'keep', and the
// legacy worthiness/rationale field aliases). Returns null if no usable priority.
function normalizeVerdict(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const priority = Math.max(0, Math.min(3, parseInt(obj.priority ?? obj.worthiness, 10)));
  if (!Number.isFinite(priority)) return null;
  const signal = PRIORITY_SIGNALS.includes(String(obj.signal)) ? String(obj.signal) : 'unclassified';
  const fold = ['keep', 'merge', 'split'].includes(String(obj.fold)) ? String(obj.fold) : 'keep';
  const note = String(obj.note ?? obj.rationale ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { priority, signal, fold, note };
}

// A compact one-line descriptor of a candidate for the comparative prompt: label
// + priors + member base-names + a short trimmed peek of the largest member.
// Base-names alone already separate a renderList from a fingerprint kernel; the
// peek disambiguates the rest. Kept small so all N fit one prompt (the whole
// air-gapped thesis is bounded context).
function candidateLine(group, index, i, peekLines) {
  const priors = rankPriors(group);
  const names = (group.members || []).map((m) => m.bare).join(', ');
  let peek = '';
  const largest = [...(group.members || [])].sort((a, b) => (b.lines || 0) - (a.lines || 0))[0];
  if (largest) {
    try {
      const src = index.getFunctionSource?.(largest.file, largest.name) || '';
      peek = src.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, peekLines).join(' / ').slice(0, 300);
    } catch { /* names-only is fine */ }
  }
  return `[${i + 1}] ${group.label} — ${priors.members} fns / ${priors.files} file(s) — members: ${names}` + (peek ? `\n     peek(${largest.bare}): ${peek}` : '');
}

// PRIMARY PATH. Build ONE prompt that lists ALL candidates so the model ranks
// them RELATIVE to each other. Default is ROUTINE (elevation must be justified);
// renderers/wrappers are demoted by rule; at most ~1/3 may be top tier. Worth is
// explicitly OFF the table here — that caveat rides the emitted chart.
export function buildBatchPrompt(groups, index, opts = {}) {
  const peekLines = opts.peekLines ?? 6;
  const rows = groups.map((g, i) => candidateLine(g, index, i, peekLines)).join('\n');
  const sys = "You TRIAGE candidate code clusters by how much a reviewer should examine each FIRST as the subject of an illustrative pseudo-claim. This is a RELATIVE ordering of where limited attention is best spent — NOT a judgment of any cluster's novelty, importance, or worth (routine-looking code can be the crux; the reviewer's judgment governs). BECAUSE it is relative you MUST spread the candidates across the range; they cannot all be high. Reply with ONE compact JSON array and nothing else.";
  const user = [
    `Rank these ${groups.length} candidates against each other:`,
    rows,
    '',
    'priority scale (attention-first ordering, NOT worth):',
    '- 3 = a specific, non-obvious algorithm or data transform distinctive to this codebase — look here first.',
    '- 2 = a substantive mechanism, but recognizable in kind.',
    '- 1 = routine application / control logic (this is the DEFAULT).',
    '- 0 = pure UI or list rendering, a thin API/library wrapper, a getter/setter, or straightforward I/O / serialization — lowest for a first pass (NOT a claim it is unimportant).',
    '',
    'Rules: the default is 1. Elevate to 3 ONLY with a specific reason. Send UI renderers, display helpers, and thin wrappers to 0 by rule. Clusters that are predominantly TEST functions (test attributes, assertion-heavy bodies, names like *_test or tests::) go to 0 or 1 by rule — a test cluster is never a mechanism to explore first. At MOST about one third of the candidates may be priority 3.',
    '',
    `Return a JSON array, one object per candidate IN THE SAME ORDER, each: {"i": <candidate number>, "priority": 0-3, "signal": one of ${JSON.stringify(PRIORITY_SIGNALS)}, "fold": "keep"|"merge"|"split", "note": "<=15 words; OBSERVATIONAL — what it RESEMBLES, not a verdict"}.`,
  ].join('\n');
  return { sys, user };
}

// Parse a JSON array of verdicts back onto `groups` — by each element's 1-based
// "i" field when valid, else positionally. Returns an array aligned to `groups`
// ([{label, priors, verdict|null}]), or null if no usable array is present or
// fewer than half the groups got a verdict (caller then falls back to
// per-candidate scoring).
export function parseBatchVerdicts(text, groups) {
  if (!text) return null;
  const m = String(text).match(/\[[\s\S]*\]/); // first [...] block, even inside prose
  if (!m) return null;
  let arr = null;
  try { arr = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(arr) || !arr.length) return null;
  const byI = new Map();
  const positional = [];
  for (const el of arr) {
    const v = normalizeVerdict(el);
    if (!v) continue;
    const i = parseInt(el && el.i, 10);
    if (Number.isFinite(i) && i >= 1 && i <= groups.length && !byI.has(i)) byI.set(i, v);
    else positional.push(v);
  }
  let pos = 0;
  const out = groups.map((g, idx) => {
    let verdict = byI.get(idx + 1);
    if (!verdict && pos < positional.length) verdict = positional[pos++];
    return { label: g.label, priors: rankPriors(g), verdict: verdict || null };
  });
  if (out.filter((o) => o.verdict).length < Math.ceil(groups.length / 2)) return null;
  return out;
}

// FALLBACK PATH. A bounded evidence pack + instruction for ONE candidate, used
// only when the comparative batch fails to parse. Same shape as the batch's
// per-row rubric, minus the relative framing (a lone candidate can't be ranked
// against peers).
export function buildVerdictPrompt(group, index, priors, opts = {}) {
  const peekLines = opts.peekLines ?? 18;
  const names = (group.members || []).map((m) => m.bare).join(', ');
  let peek = '';
  const largest = [...(group.members || [])].sort((a, b) => (b.lines || 0) - (a.lines || 0))[0];
  if (largest) {
    try {
      const src = index.getFunctionSource?.(largest.file, largest.name) || '';
      peek = src.split('\n').slice(0, peekLines).join('\n');
    } catch { /* names-only is fine */ }
  }
  const sys = "You help PRIORITIZE which clusters of functions to look at FIRST as candidate subjects for an illustrative pseudo-claim. This is a fast SURFACE heuristic to order where to start — NOT a judgment of novelty, importance, or worth. A cluster that looks routine at a glance can still turn out to be the crux, and the user's considered judgment governs. Default is routine; elevate only with a specific reason; UI renderers and thin wrappers are low. Reply with ONE compact JSON object and nothing else.";
  const user = [
    `Candidate: ${group.label}`,
    `Members (${priors.members} fns across ${priors.files} file(s)): ${names}`,
    peek ? `Representative body (${largest.bare}):\n${peek}` : '',
    '',
    `Return JSON: {"priority": 0-3, "signal": one of ${JSON.stringify(PRIORITY_SIGNALS)}, "fold": "keep"|"merge"|"split", "note": "<=15 words; OBSERVATIONAL — what it RESEMBLES, not a verdict"}.`,
    'priority 3 = a specific, non-obvious algorithm distinctive to this codebase, explore first; 0 = pure UI/list rendering, a wrapper over a library, or third-party/generated code, lower priority for a first pass (NOT a claim it is unimportant).',
  ].filter(Boolean).join('\n');
  return { sys, user };
}

// Tolerant parse of a single verdict — accepts a bare JSON object, JSON embedded
// in prose, or "key: value" lines. Returns a normalized verdict, or null if
// nothing usable is present (the caller retries once, then records null).
export function parseVerdict(text) {
  if (!text) return null;
  let obj = null;
  const m = String(text).match(/\{[\s\S]*\}/); // first {...} block, even inside prose
  if (m) { try { obj = JSON.parse(m[0]); } catch { /* fall through */ } }
  if (!obj) {
    const kv = {};
    for (const line of String(text).split(/\r?\n/)) {
      const mm = line.match(/^\s*"?(\w+)"?\s*[:=]\s*"?([^"]+?)"?\s*,?\s*$/);
      if (mm) kv[mm[1].toLowerCase()] = mm[2].trim();
    }
    if ('priority' in kv || 'signal' in kv || 'worthiness' in kv) obj = kv;
  }
  return normalizeVerdict(obj);
}

// One comparative pass over <= chunkSize groups (+ per-candidate fallback).
async function rankCandidatesSinglePass(groups, index, drafter, opts = {}) {
  if (opts.comparative !== false) {
    const { sys, user } = buildBatchPrompt(groups, index, opts);
    const maxTokens = opts.batchMaxTokens ?? Math.min(2000, 120 + groups.length * 60);
    for (let attempt = 0; attempt < 2; attempt++) {
      let text = null;
      try {
        text = await drafter(sys, user, maxTokens);
      } catch { break; } // hard drafter error on the batch -> per-candidate below
      const parsed = parseBatchVerdicts(text, groups);
      if (parsed) return parsed.map((p) => ({ ...p, error: null }));
    }
  }
  return rankCandidatesPerCandidate(groups, index, drafter, opts);
}

// ranker-chunked-playoff: the comparative pass collapses at 12B beyond ~25
// candidates per prompt (measured 2026-07-31 on identical group sets: x265
// 24 -> real gradient; Bram 39 -> P2x39 flat; CE 98 -> P3=4/P2=94), while
// ~20-24 sits inside the regime where the forced spread demonstrably works
// (7fc678a validated at 23). So: rank in BATCHES of <= chunkSize, then a
// PLAYOFF — each batch's P3 winners re-ranked together so the top tier is
// globally contested. Finalists take their playoff scores (a batch-P3 can be
// demoted); non-finalists keep their batch scores (<= P2 by construction).
// An oversized playoff chunks recursively. Verdict contract and fallbacks
// unchanged; transparent to callers.
async function rankCandidatesChunked(groups, index, drafter, opts, chunkSize) {
  const results = new Array(groups.length).fill(null);
  const nBatches = Math.ceil(groups.length / chunkSize);
  for (let start = 0; start < groups.length; start += chunkSize) {
    const batch = groups.slice(start, start + chunkSize);
    process.stderr.write(`#   ranker batch ${Math.floor(start / chunkSize) + 1}/${nBatches} (${batch.length} candidates)…\n`);
    const r = await rankCandidatesSinglePass(batch, index, drafter, opts);
    r.forEach((v, j) => { results[start + j] = v; });
  }
  const finalistIdx = [];
  results.forEach((r, i) => { if (r && r.verdict && r.verdict.priority === 3) finalistIdx.push(i); });
  if (finalistIdx.length > 1) {
    process.stderr.write(`#   ranker playoff: ${finalistIdx.length} batch-P3 finalist(s)…\n`);
    const finalists = finalistIdx.map((i) => groups[i]);
    const fr = finalists.length > chunkSize
      ? await rankCandidatesChunked(finalists, index, drafter, opts, chunkSize)
      : await rankCandidatesSinglePass(finalists, index, drafter, opts);
    fr.forEach((v, j) => {
      if (v && v.verdict) results[finalistIdx[j]] = { ...results[finalistIdx[j]], verdict: { ...v.verdict } };
    });
  }
  return results;
}

// Score candidate groups with a bounded LLM verdict. PRIMARY: one comparative
// pass (buildBatchPrompt) so priorities are forced to spread — CHUNKED with a
// playoff when the list exceeds chunkSize (see rankCandidatesChunked); retry
// once, then fall back to per-candidate scoring if a batch won't parse or the
// drafter errors on it. Returns [{label, priors, verdict|null, error?}]
// aligned to `groups`. Observe-only: the caller annotates; it does NOT
// drop/fold groups.
export async function rankCandidates(groups, index, drafter, opts = {}) {
  if (!groups || !groups.length) return [];
  const chunkSize = opts.chunkSize ?? 20;
  if (opts.comparative !== false && groups.length > chunkSize) {
    return rankCandidatesChunked(groups, index, drafter, opts, chunkSize);
  }
  return rankCandidatesSinglePass(groups, index, drafter, opts);
}

// Per-candidate scoring — the fallback for a failed comparative pass, and the
// observe-only baseline the comparative distribution is compared against.
export async function rankCandidatesPerCandidate(groups, index, drafter, opts = {}) {
  const out = [];
  for (const group of groups) {
    const priors = rankPriors(group);
    const { sys, user } = buildVerdictPrompt(group, index, priors, opts);
    let verdict = null, error = null;
    for (let attempt = 0; attempt < 2 && !verdict && !error; attempt++) {
      try {
        const text = await drafter(sys, user, opts.maxTokens ?? 160);
        verdict = parseVerdict(text);
      } catch (e) { error = e.message; }
    }
    out.push({ label: group.label, priors, verdict, error });
  }
  return out;
}
