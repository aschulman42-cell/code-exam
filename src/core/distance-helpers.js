// distance-helpers.js — name-token, Jaccard, directory-prefix and file-extension distance functions for dupe/peer scoring
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * distance-helpers.js — Small string/path/set distance functions used by
 * the funcstring-peer-surprise and structural-dupe-group scorers in
 * CodeSearchIndex. Pulled out of CSI in Issue #18 Phase 2 (theme #22).
 *
 * All four functions are pure — no `this`, no state, no I/O. Internal-only
 * by convention (leading underscores preserved from the original `static`
 * class fields), but exported so the rest of `src/core/` can import them.
 */

/**
 * Split a function name into lowercase tokens, handling camelCase,
 * snake_case, `::` qualifiers, and `@` suffixes. Used by funcstring-peer
 * surprise scoring.
 */
export function _funcNameTokens(name) {
  let bare = name.includes('::') ? name.split('::').pop() : name;
  if (bare.includes('@')) bare = bare.split('@')[0];
  const split = bare
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .split(/[_\W]+/)
    .filter(Boolean)
    .map(s => s.toLowerCase());
  return new Set(split);
}

/**
 * Jaccard distance between two Sets: 1 - |A ∩ B| / |A ∪ B|.
 * Returns 0 when both sets are empty (identical-empty case).
 */
export function _jaccardDistance(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

/**
 * Directory-prefix distance between two paths: 1 - LCP/maxDirDepth.
 * Identical paths return 0; paths with no common directory return 1.
 * Path separators are normalized (`\` → `/`) and lowercased before LCP.
 */
export function _pathDistance(p1, p2) {
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase().split('/').slice(0, -1);
  const d1 = norm(p1);
  const d2 = norm(p2);
  const maxLen = Math.max(d1.length, d2.length);
  if (maxLen === 0) return p1 === p2 ? 0 : 1;
  let lcp = 0;
  while (lcp < d1.length && lcp < d2.length && d1[lcp] === d2[lcp]) lcp++;
  return 1 - lcp / maxLen;
}

/**
 * Extract the lowercase file extension from a path (without the dot).
 * Returns empty string when there's no extension.
 */
export function _fileExt(p) {
  const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}
