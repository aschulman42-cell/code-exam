// filter-match.js — one predicate for GUI/CLI filters: substring by default, /pattern/flags for opt-in regex
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * filter-match.js — one shared predicate for the left-pane GUI Filter box and
 * the CLI `--filter`, so `/pattern/flags` works uniformly across every listing
 * (functions, files, classes, hotspots, and all the AI/ML detector cells), not
 * just `--prompt-catalog` (the only place a `/regex/` form first landed in
 * `8d233e3`).
 *
 * Two forms, regex strictly opt-in:
 *
 *   bare string        → case-insensitive substring (legacy behavior, unchanged)
 *   /pattern/flags     → regex over the same fields (leading AND trailing slash)
 *
 * The regex defaults to case-insensitive (`i`) because the fields are mostly
 * prose and identifiers; pass explicit flags to override. An unparseable body
 * (e.g. a stray lone slash that happens to bookend the string) falls back to
 * literal substring matching of the whole `/.../`, so the filter never throws.
 *
 * Returns a predicate `(...fields) => boolean`, true when ANY non-empty field
 * matches — mirroring the per-cell `field.includes(pat) || …` shape callers
 * had inline, so each call site passes the same field list it tested before.
 * An empty/null filter yields a pass-through predicate.
 *
 * Stateful regex flags (`g`, `y`) are stripped: `RegExp.test()` advances
 * `lastIndex` when they are set, which would make per-field `.some()` skip
 * fields nondeterministically. Dropping them keeps each field tested from the
 * start, matching the independent-field semantics of the substring form.
 */
/**
 * filteredEmptyNotice(noun, total, filter) — the line a listing prints when a
 * filter matched NOTHING but the unfiltered list is not empty. Distinct from the
 * absence message on purpose (overview-verification-basis-unfiltered, asus-CC on
 * #330): `models_used({filter:"/"})` on a 36-model index printed "No model ids
 * found - do not infer absence", a model reasoned from it, and CE's footnote
 * repeated the emptiness as a fact about the index. An absence message is for
 * an unfiltered empty result; this is for a filter that did the emptying.
 *
 *   No models match filter "/" (36 exist — omit the filter to see them all).
 */
export function filteredEmptyNotice(noun, total, filter) {
  const n = Number(total) || 0;
  const tail = n === 1 ? '1 exists — omit the filter to see it' : `${n} exist — omit the filter to see them all`;
  return `No ${noun} match filter ${JSON.stringify(String(filter))} (${tail}).`;
}

export function makeFilterMatcher(filter) {
  if (!filter) return () => true;
  const m = /^\/(.*)\/([a-z]*)$/.exec(filter);
  if (m) {
    try {
      const flags = (m[2] || 'i').replace(/[gy]/g, '');
      const re = new RegExp(m[1], flags);
      return (...fields) => fields.some(f => f && re.test(f));
    } catch { /* not a valid regex body — fall through to substring */ }
  }
  const pat = filter.toLowerCase();
  return (...fields) => fields.some(f => f && f.toLowerCase().includes(pat));
}
