// canonical-funcs.js — groups identical function hashes and picks a canonical representative (shortest path) per group
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * canonical-funcs.js — Duplicate-detection: for each function-hash group,
 * pick a canonical representative (shortest filepath wins) and record the
 * copies. Pulled out of `CodeSearchIndex.js` in Issue #18 Phase 2 (theme #23).
 *
 * All three exports take the CSI instance (`idx`) as their first argument.
 * `getCanonicalFuncs` memoizes its result on `idx._canonicalFuncs_${mode}`
 * and `idx._canonicalCopies_${mode}` — the same per-instance cache the
 * original class methods used. Caching still works after extraction because
 * `idx` is passed by reference; the free function writes the cache fields
 * on it directly.
 *
 * Class methods in CSI keep their names and become thin wrappers.
 */

/**
 * Get mapping: each function -> its canonical representative.
 * For functions with identical hash, picks shortest filepath as canonical.
 *
 * Note: production code does not currently call this. Retained because
 * `test/test_phase4.js` exercises it as a class method; deletion would
 * lose test coverage of the canonical-funcs grouping logic.
 */
export function getCanonicalFuncs(idx, mode = 'exact') {
  const cacheKey = `_canonicalFuncs_${mode}`;
  const copiesKey = `_canonicalCopies_${mode}`;
  if (idx[cacheKey]) return idx[cacheKey];

  const hashes = idx.ensureFuncHashes(3, false);
  const hashKey = mode === 'exact' ? 'body_hash' : 'struct_hash';

  // Group by hash
  const groups = {};
  for (const [key, info] of hashes) {
    const h = info[hashKey];
    if (!groups[h]) groups[h] = [];
    groups[h].push(key);
  }

  const canonicalFuncs = {};
  const canonicalCopies = {};

  for (const funcs of Object.values(groups)) {
    if (funcs.length === 1) {
      canonicalFuncs[funcs[0]] = funcs[0];
      continue;
    }
    // Pick shortest filepath as canonical
    const canonical = funcs.slice().sort((a, b) => a.length - b.length)[0];
    canonicalFuncs[canonical] = canonical;
    canonicalCopies[canonical] = funcs.filter(f => f !== canonical);
    for (const f of funcs) {
      if (f !== canonical) canonicalFuncs[f] = canonical;
    }
  }

  idx[cacheKey] = canonicalFuncs;
  idx[copiesKey] = canonicalCopies;
  return canonicalFuncs;
}

/**
 * Get number of duplicate copies for a function (0 if no dupes).
 *
 * Note: production code does not currently call this. Retained because
 * `test/test_phase4.js` exercises it as a class method.
 */
export function getCopyCount(idx, filepath, funcName, mode = 'exact') {
  getCanonicalFuncs(idx, mode);
  const copies = idx[`_canonicalCopies_${mode}`] || {};
  const key = `${filepath}|||${funcName}`;
  return (copies[key] || []).length;
}
