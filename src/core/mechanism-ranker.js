// mechanism-ranker.js — #284 ranker Phase 0 (OBSERVE-ONLY).
//
// Assigns each B1 candidate mechanism group a bounded per-candidate exploration-
// PRIORITY verdict {priority, signal, fold, note} — a fast SURFACE heuristic for
// where to look FIRST, NOT a judgment of novelty, importance, or worth — over
// deterministic
// scaffolding (priors as features; tolerant parse + one retry). OBSERVE-ONLY: it
// ANNOTATES candidates, it does NOT reorder or drop the emitted anchor set. The
// pcrun soak against the by-hand claims sets the graduation criterion for Phase 1
// (wiring into --auto). Full design: pcrun_save_072526/_RANKER_SPEC.md.
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

// A bounded evidence pack + instruction for ONE candidate. Kept small (the
// air-gapped thesis): label + member base-names + a short peek at the largest
// member's body + the priors. The model must reply with ONE compact JSON verdict.
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
  const sys = "You help PRIORITIZE which clusters of functions to look at FIRST as candidate subjects for an illustrative pseudo-claim. This is a fast SURFACE heuristic to order where to start — NOT a judgment of novelty, importance, or worth. A cluster that looks routine at a glance can still turn out to be the crux, and the user's considered judgment governs. Reply with ONE compact JSON object and nothing else.";
  const user = [
    `Candidate: ${group.label}`,
    `Members (${priors.members} fns across ${priors.files} file(s)): ${names}`,
    peek ? `Representative body (${largest.bare}):\n${peek}` : '',
    '',
    `Return JSON: {"priority": 0-3, "signal": one of ${JSON.stringify(PRIORITY_SIGNALS)}, "fold": "keep"|"merge"|"split", "note": "<=15 words; OBSERVATIONAL — what it RESEMBLES, not a verdict"}.`,
    'priority 3 = looks distinctive / purpose-built for this codebase, explore first; 0 = resembles a common/standard pattern, a wrapper over a library, or third-party/generated code, lower priority for a first pass (NOT a claim it is unimportant).',
  ].filter(Boolean).join('\n');
  return { sys, user };
}

// Tolerant parse of the model's verdict — accepts a bare JSON object, JSON
// embedded in prose, or "key: value" lines. Returns a normalized verdict, or null
// if nothing usable is present (the caller retries once, then records null).
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
  if (!obj) return null;
  const priority = Math.max(0, Math.min(3, parseInt(obj.priority ?? obj.worthiness, 10)));
  if (!Number.isFinite(priority)) return null;
  const signal = PRIORITY_SIGNALS.includes(String(obj.signal)) ? String(obj.signal) : 'unclassified';
  const fold = ['keep', 'merge', 'split'].includes(String(obj.fold)) ? String(obj.fold) : 'keep';
  const note = String(obj.note ?? obj.rationale ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { priority, signal, fold, note };
}

// Score each candidate group with a bounded LLM verdict (per-candidate; retry
// once on a malformed response). Returns [{label, priors, verdict|null, error?}].
// Observe-only: the caller annotates; it does NOT reorder/drop the anchor set.
export async function rankCandidates(groups, index, drafter, opts = {}) {
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
