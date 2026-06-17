/**
 * hotspots.js — Read-only ranked-listings of "important" functions and
 * classes in an index. Pulled out of `CodeSearchIndex.js` in Issue #18
 * Phase 2 (theme #18).
 *
 * All four exports take the CSI instance (`idx`) as their first argument
 * and reach back into it for `listFunctions`, `getCallCounts`, `listClasses`,
 * and `_getBareNameCounts`. They don't mutate `idx` — pure read paths.
 *
 * Class methods in CSI keep the original names and become thin wrappers
 * that forward `this` plus their arguments, preserving the external API
 * for `server.js`, `service.js`, `mcp-server.js`, and `metrics.js`.
 */

import { _isNoiseDoc } from './vocabulary.js';

/**
 * #187: filepaths excluded from ranked listings because they are vendored /
 * minified / generated noise (reuses the #172 `_isNoiseDoc` gate). Without it,
 * hotspots/entry_points get swamped by vendored bundles (e.g. XMLUI) and
 * minified files (e.g. a bundled cli.js), burying the real source. Memoized on
 * the index; content is materialized only for code files (where `isMinified`
 * applies), so the path-only noise classes (vendor/dist/.op/…) stay cheap.
 */
function _noiseFiles(idx) {
  if (idx._hotspotNoiseFiles) return idx._hotspotNoiseFiles;
  const noise = new Set();
  const fileMap = idx.fileLines;
  if (fileMap && typeof fileMap[Symbol.iterator] === 'function') {
    for (const [fp, lines] of fileMap) {
      const isCode = /\.(js|css|jsx|ts|tsx)$/i.test(fp);
      const content = (isCode && Array.isArray(lines)) ? lines.join('\n') : null;
      if (_isNoiseDoc(fp, content)) noise.add(fp);
    }
  }
  idx._hotspotNoiseFiles = noise;
  return noise;
}

/**
 * Find structurally important functions: score = calls x log₂(lines).
 * Large frequently-called functions rank highest.
 */
export function getHotspots(idx, n = 25, showProgress = true) {
  const allFuncs = idx.listFunctions();
  if (!allFuncs.length) return [];

  const counts = idx.getCallCounts(showProgress);

  // bare_name -> [func records]
  const byBare = Object.create(null);
  for (const f of allFuncs) {
    let bare = f.name.includes('::') ? f.name.split('::').pop() : f.name;
    if (bare.includes('@')) bare = bare.split('@')[0];
    if (!byBare[bare]) byBare[bare] = [];
    byBare[bare].push(f);
  }

  const scored = [];
  const seen = new Set();

  for (const [bname, callCount] of Object.entries(counts)) {
    if (!byBare[bname]) continue;
    for (const f of byBare[bname]) {
      const key = `${f.filepath}|${f.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (_noiseFiles(idx).has(f.filepath)) continue;  // #187: skip vendored/minified
      if (f.lines < 2) continue;

      const score = callCount * Math.log2(Math.max(f.lines, 2));
      scored.push({
        name: f.name,
        filepath: f.filepath,
        display_name: f.displayName,
        lines: f.lines,
        calls: callCount,
        score,
        type: f.type,
        copies: 0,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, n);
}

/**
 * Find functions that are defined but rarely/never called - entry points.
 * Sorted by size descending (biggest uncalled functions are most important).
 */
export function getEntryPoints(idx, n = 25, maxCalls = 0, showProgress = true) {
  const allFuncs = idx.listFunctions();
  if (!allFuncs.length) return [];

  const counts = idx.getCallCounts(showProgress);
  const results = [];

  for (const f of allFuncs) {
    if (f.lines < 3) continue;
    if (_noiseFiles(idx).has(f.filepath)) continue;  // #187: skip vendored/minified
    let bare = f.name.includes('::') ? f.name.split('::').pop() : f.name;
    if (bare.includes('@')) bare = bare.split('@')[0];

    const callCount = counts[bare] || 0;
    if (callCount <= maxCalls) {
      results.push({
        name: f.name,
        filepath: f.filepath,
        display_name: f.displayName,
        lines: f.lines,
        calls: callCount,
        type: f.type,
        copies: 0,
      });
    }
  }

  results.sort((a, b) => b.lines - a.lines);
  return results;
}

/**
 * Find domain-specific important functions.
 * Score = calls x log₂(lines) / √(name_definitions_count)
 * Functions with rare names score higher, surfacing domain code.
 */
export function getDomainHotspots(idx, n = 25, showProgress = true) {
  const allFuncs = idx.listFunctions();
  if (!allFuncs.length) return [];

  const counts = idx.getCallCounts(showProgress);
  const bareNameCounts = idx._getBareNameCounts();

  const scored = [];
  const seen = new Set();

  for (const f of allFuncs) {
    const key = `${f.filepath}|${f.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (_noiseFiles(idx).has(f.filepath)) continue;  // #187: skip vendored/minified
    // Ad hoc: skip very small functions (trivial accessors/getters) to reduce
    // noise in Domain Functions. Threshold and scoring formula should be revisited
    // — see TODO #254b for deeper approaches (fan-out, PageRank, UI-structure).
    if (f.lines < 5) continue;

    let bare = f.name.includes('::') ? f.name.split('::').pop() : f.name;
    if (bare.includes('@')) bare = bare.split('@')[0];

    const callCount = counts[bare] || 0;
    if (callCount < 1) continue;

    const nameCount = bareNameCounts[bare] || 1;
    // Weight size more heavily: sqrt(lines) instead of log2(lines) so that
    // 200-line functions score ~7x higher than 10-line functions (vs ~4x with log2)
    const score = callCount * Math.sqrt(Math.max(f.lines, 5)) / Math.sqrt(Math.max(nameCount, 1));

    scored.push({
      name: f.name,
      filepath: f.filepath,
      display_name: f.displayName,
      lines: f.lines,
      calls: callCount,
      score,
      name_count: nameCount,
      type: f.type,
      copies: 0,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Classes ranked by aggregated method hotspot score.
 * Score = sum(calls to methods) x log₂(total method lines) / √(name_count)
 */
export function getClassHotspots(idx, n = 25, showProgress = true) {
  const callCounts = idx.getCallCounts(showProgress);
  const classes = idx.listClasses().filter(c => !_noiseFiles(idx).has(c.filepath));  // #187: skip vendored/minified
  if (!classes.length) return [];

  const classNameCounts = {};
  for (const c of classes) {
    classNameCounts[c.name] = (classNameCounts[c.name] || 0) + 1;
  }

  for (const c of classes) {
    let totalCalls = 0;
    for (const method of c.methods) {
      let bare = method.name.split('.').pop().split('::').pop();
      if (bare.includes('@')) bare = bare.split('@')[0];
      totalCalls += callCounts[bare] || 0;
    }
    c.total_calls = totalCalls;

    const totalLines = c.total_method_lines > 0 ? c.total_method_lines : c.lines;
    const nameCount = classNameCounts[c.name] || 1;

    c.score = (totalCalls > 0 && totalLines > 0)
      ? (totalCalls * Math.log2(totalLines)) / Math.sqrt(nameCount)
      : 0;
    c.name_count = nameCount;
  }

  classes.sort((a, b) => b.score - a.score);
  return classes.slice(0, n * 3);
}
