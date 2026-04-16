/**
 * --build-fp-renames / --build-fingerprint-renames
 *
 * Generate rename-map entries for functions whose string-call fingerprint
 * matches a function in another "source" (archive / npm package / project)
 * with high confidence. The minified `Cz` class that fingerprint-matches
 * `@anthropic-ai/sdk::BaseAnthropic` at score 0.818 becomes a display-time
 * rename `Cz → Cz_FP_BASEANTHROPIC`, making the identification visible
 * everywhere `Cz` appears in the source view.
 *
 * Design choices (per user 2026-04-15):
 *   - Threshold default: 0.8. Includes exact-hash matches (score 1.0) and
 *     near-matches like Cz=BaseAnthropic (0.818) that were validated by
 *     hand-inspection during Franken_AI_SDK testing.
 *   - Cross-source ONLY: we only generate renames when work.source !=
 *     ref.source. Within-source matches are duplication, not identification.
 *   - Bare-name uniqueness guard: only emit a bare-name rename when the
 *     bare name appears in exactly ONE function-index entry across the
 *     whole index — same safeguard as the existing _KW_ inference. Prevents
 *     a `yS → yS_FP_ZODSTRING` rewrite from accidentally relabeling some
 *     unrelated local `yS`.
 *   - Accumulate across tiers: if an entry already has `_KW_` or `_CMD_`
 *     renames, the _FP_ suffix is APPENDED, not substituted. Produces
 *     names like `Cz_KW_FOO_FP_BASEANTHROPIC`. Lets the user grep `_FP_`
 *     to audit which renames came from fingerprint matching.
 *   - Writes directly to rename_map.json — no separate proposal file.
 *     Auditable via `grep _FP_ rename_map.json` or git diff if the file
 *     is tracked.
 */

import fs from 'fs';
import path from 'path';
import { computeAllFingerprints, loadFingerprintsList, jaccard } from './fingerprint.js';

/**
 * camelCase → CAMEL_CASE snake (utility).
 */
function _screaming(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .toUpperCase();
}

/**
 * Compute the suffix for a rename based on the reference function. Includes
 * class context when available; when the ref name is too generic (3-char
 * common word like "code", "get", "set"), also append the file stem so the
 * reader can tell WHICH `code` function was matched.
 */
function _toSuffix(refName, refFilepath) {
  let bare = refName;
  if (bare.includes('@')) bare = bare.split('@')[0];

  // Qualified name: include class prefix (innermost enclosing scope)
  if (bare.includes('::')) {
    const parts = bare.split('::');
    const leaf = parts.pop();
    const cls = parts.pop();
    return _screaming(cls) + '_' + _screaming(leaf);
  }

  const screaming = _screaming(bare);
  // Generic 4-char-or-less name (code, get, set, run, doX) — append file
  // stem for discrimination. E.g. ajv's applicator/not.ts::code vs
  // applicator/allOf.ts::code shouldn't both produce _FP_CODE.
  if (bare.length <= 4 && refFilepath) {
    const norm = refFilepath.replace(/\\/g, '/');
    const file = norm.split('/').pop() || '';
    const stem = file.replace(/\.[a-zA-Z0-9]+$/, '');
    if (stem && stem.toLowerCase() !== bare.toLowerCase()) {
      return _screaming(stem) + '_' + screaming;
    }
  }
  return screaming;
}

/**
 * Parse --fingerprint-work / --fingerprint-ref pattern: comma-separated list
 * of substrings (case-insensitive). Returns a predicate; null if no pattern.
 */
function _makeSourceFilter(pattern) {
  if (!pattern) return null;
  const pats = pattern.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (pats.length === 0) return null;
  return (source) => {
    const src = (source || '').toLowerCase();
    return pats.some(p => src.includes(p));
  };
}

/**
 * Strip trailing `_FP_SUFFIX` segments from a rename VALUE, splitting by `::`
 * so the class prefix and method leaf are cleaned independently. Used by
 * --clean-fp to back out prior _FP_ passes without losing _KW_/_CMD_/_NAME_/
 * _IMPORT_ tier renames.
 */
function _stripFpSuffixes(value) {
  return value
    .split('::')
    .map(seg => seg.replace(/_FP_[A-Z0-9_]+$/, ''))
    .join('::');
}

export function doBuildFpRenames(index, args) {
  const minScore = parseFloat(args.build_fp_renames) || 0.8;
  const minTokens = args.fingerprint_min_tokens != null
    ? parseInt(args.fingerprint_min_tokens) : 6;
  const dryRun = !!args.dry_run;
  const workFilter = _makeSourceFilter(args.fingerprint_work);
  const refFilter  = _makeSourceFilter(args.fingerprint_ref);
  const cleanFp    = !!args.clean_fp;

  console.log(`Building _FP_ rename entries from fingerprint matches (min-score=${minScore}, min-tokens=${minTokens})${dryRun ? ' [DRY RUN]' : ''}`);
  if (workFilter) console.log(`  work source filter: ${args.fingerprint_work}`);
  if (refFilter)  console.log(`  ref  source filter: ${args.fingerprint_ref}`);

  const { fns: indexFns } = computeAllFingerprints(index, { minTokens });
  console.log(`  ${indexFns.length} index functions have fingerprints with ≥${minTokens} tokens`);

  // Merge in any --load-fingerprints files (portable reference libraries).
  // Each loaded function contributes to the candidate pool with its saved
  // source label intact, so --cross-source logic works naturally.
  const { fns: loadedFns, provenance } = loadFingerprintsList(args.load_fingerprints);
  const fns = indexFns.concat(loadedFns);
  if (loadedFns.length > 0) {
    console.log(`  +${loadedFns.length} loaded from fingerprints file(s); total pool: ${fns.length}`);
  }

  // Bare-name uniqueness across the entire function index. Mirror the guard
  // used by the existing _KW_ inference — only propose bare-name renames for
  // names that appear in exactly ONE function-index entry.
  index._ensureFunctionIndex();
  const bareCount = new Map();
  for (const [, funcs] of Object.entries(index.functionIndex || {})) {
    for (const fname of Object.keys(funcs)) {
      let bare = fname.includes('::') ? fname.split('::').pop() : fname;
      if (bare.includes('@')) bare = bare.split('@')[0];
      bareCount.set(bare, (bareCount.get(bare) || 0) + 1);
    }
  }

  // Inverted index token → ref function indexes (same as --cmp-string-call)
  const tokenToRef = new Map();
  for (let i = 0; i < fns.length; i++) {
    for (const t of fns[i].fingerprint) {
      if (!tokenToRef.has(t)) tokenToRef.set(t, []);
      tokenToRef.get(t).push(i);
    }
  }

  // For each work fn, find its best cross-source ref match above threshold.
  const bareOf = (n) => {
    let b = n.includes('::') ? n.split('::').pop() : n;
    if (b.includes('@')) b = b.split('@')[0];
    return b;
  };

  // Full list of canonicalized cross-source matches above threshold. The
  // per-work "best" map is derived from this; --fp-classes also needs the
  // full list because a class-level identification requires aggregating
  // MULTIPLE method-level matches for the same (workClass, refClass) pair.
  const allMatches = [];  // [{ workFn, refFn, score }, ...]
  const seenPair = new Set();
  for (const w of fns) {
    const sharedCount = new Map();
    for (const t of w.fingerprint) {
      const refList = tokenToRef.get(t);
      if (!refList) continue;
      for (const ri of refList) sharedCount.set(ri, (sharedCount.get(ri) || 0) + 1);
    }
    for (const ri of sharedCount.keys()) {
      const r = fns[ri];
      if (r === w) continue;
      if (r.source === w.source) continue;  // cross-source only
      // Optional --fingerprint-work / --fingerprint-ref scoping. Note that
      // since `bestMatchFor` later records BOTH sides of each pair as
      // candidates, we need EITHER direction to pass the filter — check
      // (w, r) as one direction and (r, w) as the other.
      if (workFilter || refFilter) {
        const fwd = (!workFilter || workFilter(w.source)) && (!refFilter || refFilter(r.source));
        const rev = (!workFilter || workFilter(r.source)) && (!refFilter || refFilter(w.source));
        if (!fwd && !rev) continue;
      }
      // Compute score FIRST, dedup AFTER — otherwise the seenPair Set grows
      // to millions of below-threshold entries and exceeds V8's Set size
      // limit (~16.7M). Jaccard is symmetric so both directions give the
      // same score; we only store passing pairs in the dedup Set.
      const score = jaccard(w.fingerprint, r.fingerprint);
      if (score < minScore) continue;
      const ka = w.filepath + '|||' + w.name;
      const kb = r.filepath + '|||' + r.name;
      const pairKey = ka < kb ? ka + '<=>' + kb : kb + '<=>' + ka;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      allMatches.push({ workFn: w, refFn: r, score });
    }
  }

  // Build bestMatchFor for method-level rename emission: per candidate
  // fullName, keep the single best cross-source match. Each candidate can
  // be either side of a pair (hence we update for both w and r). This is
  // the SAME collapsing the original single-pass loop did; just factored
  // out so allMatches is also retained.
  const bestMatchFor = new Map();  // workFullName → { workFn, refFn, score }
  for (const m of allMatches) {
    const eW = bestMatchFor.get(m.workFn.name);
    if (!eW || m.score > eW.score) bestMatchFor.set(m.workFn.name, { workFn: m.workFn, refFn: m.refFn, score: m.score });
    const eR = bestMatchFor.get(m.refFn.name);
    if (!eR || m.score > eR.score) bestMatchFor.set(m.refFn.name, { workFn: m.refFn, refFn: m.workFn, score: m.score });
  }
  console.log(`  ${allMatches.length} cross-source matches pass min-score (${bestMatchFor.size} distinct functions)`);

  // Load existing rename map — we accumulate, not overwrite.
  const renameMapPath = path.join(index.indexPath, 'rename_map.json');
  let existingMap = {};
  if (fs.existsSync(renameMapPath)) {
    try { existingMap = JSON.parse(fs.readFileSync(renameMapPath, 'utf-8')); }
    catch (e) { console.log(`  warn: couldn't parse existing rename_map.json (${e.message}); starting fresh.`); }
  }

  // --clean-fp: strip existing _FP_ suffixes from rename_map.json before
  // emitting new ones. Lets the user back out a noisy _FP_ pass without
  // hand-editing. Preserves _KW_/_CMD_/_NAME_/_IMPORT_ tiers — only strips
  // trailing _FP_ segments (which, due to our accumulation append-only
  // behavior, are always at the end of each segment). Entries whose value
  // becomes identical to the key after stripping are deleted outright.
  if (cleanFp) {
    let cleanedValues = 0;
    let deletedEntries = 0;
    for (const key of Object.keys(existingMap)) {
      const orig = existingMap[key];
      if (!orig || typeof orig !== 'string') continue;
      if (!orig.includes('_FP_')) continue;
      const stripped = _stripFpSuffixes(orig);
      if (stripped === key) {
        delete existingMap[key];
        deletedEntries++;
      } else if (stripped !== orig) {
        existingMap[key] = stripped;
        cleanedValues++;
      }
    }
    console.log(`  --clean-fp: stripped _FP_ from ${cleanedValues} entries, deleted ${deletedEntries} entries with no remaining tier suffixes`);
  }

  let emitted = 0;
  let skippedAmbiguous = 0;
  let skippedSourceSide = 0;
  let skippedRealName = 0;
  let skippedPathological = 0;

  // Reject pathological "function names" that are really captured JS
  // expressions (TypeScript private-field compilation produces class bodies
  // like `class X { [(_A = new WeakMap(), _B = function() { ... }, ...)] }`
  // — the regex parser mistakes the computed-key `[...]` for a method name
  // and swallows kilobytes of init code — TODO #348). Without this filter,
  // the rename_map ends up with comically long entries whose key and value
  // are both full JavaScript programs. Recognize them by: name contains
  // `\n`, contains `[(` or `new WeakMap` (telltale patterns), or exceeds
  // ~200 chars.
  function _isPathologicalName(name) {
    if (!name) return false;
    if (name.length > 200) return true;
    if (name.includes('\n')) return true;
    if (name.includes('[(')) return true;
    if (/new (Weak)?(Map|Set)/.test(name)) return true;
    return false;
  }

  for (const [workFullName, { workFn, refFn, score }] of bestMatchFor) {
    if (_isPathologicalName(workFullName) || _isPathologicalName(refFn.name)) {
      skippedPathological++;
      continue;
    }
    const workBare = bareOf(workFullName);
    const refBare = bareOf(refFn.name);

    // DIRECTION filter: only rename bundled/minified code using library
    // source names — not the other way around. If the "work" side is
    // inside node_modules or a zip archive, it's almost certainly a source
    // library with real names; skip rename.
    //
    // Without this check, every match (A,B) produces TWO rename candidates
    // (A→B-name and B→A-name). For (cli.js::cL6, ajv::Ajv) we'd correctly
    // add `cL6 → cL6_FP_AJV`, but we'd ALSO add `Ajv → Ajv_FP_C_L6` —
    // rewriting the actual ajv::Ajv class with a bundler-derived name.
    // Nonsensical and backwards.
    const workPath = workFn.filepath.replace(/\\/g, '/');
    if (workPath.includes('node_modules/') || workPath.includes('.zip!')) {
      skippedSourceSide++;
      continue;
    }

    // Nothing to do if work and ref have the same bare name — the bundler
    // preserved the original name (or the codebase re-exports / re-uses it
    // directly). Rename would be noise.
    if (workBare === refBare) { skippedRealName++; continue; }

    // HEURISTIC: require work name to look bundler-mangled. Covers:
    //   - ≤3 char names (Qdq, Jr, Dr, hS, cL6, v0)
    //   - names with digits anywhere (longer mangled names like Cz8, bHq)
    //   - names starting with $ or _ (esbuild's internal locals)
    // 4+ char all-letter names like "Llama", "Config", "Token" look
    // descriptive; skip unless combined with the source-path filter. The
    // source-path filter above already protects node_modules/.zip
    // reference-side names from being renamed.
    const workLooksMangled =
      workBare.length <= 3 ||
      /[0-9]/.test(workBare) ||
      /^[_$]/.test(workBare);
    if (!workLooksMangled) { skippedRealName++; continue; }

    const suffix = '_FP_' + _toSuffix(refFn.name, refFn.filepath);

    // Qualified entry: always safe to add because it only matches the
    // specific qualified form (ClassName::method) in applyRenames text.
    const existing = existingMap[workFullName];
    const newValue = existing
      ? (existing.includes(suffix) ? existing : existing + suffix)
      : (workFullName + suffix);
    if (newValue !== existing) {
      existingMap[workFullName] = newValue;
      emitted++;
    }

    // Bare-name rename (only if bare name is unique across the function index)
    if (bareCount.get(workBare) === 1) {
      const bareExisting = existingMap[workBare];
      const bareNew = bareExisting
        ? (bareExisting.includes(suffix) ? bareExisting : bareExisting + suffix)
        : (workBare + suffix);
      if (bareNew !== bareExisting) {
        existingMap[workBare] = bareNew;
        emitted++;
      }
    } else {
      skippedAmbiguous++;
    }
  }
  console.log(`  ${emitted} method-level _FP_ entries added`);
  if (skippedSourceSide > 0) console.log(`  ${skippedSourceSide} matches skipped — work side is in node_modules/.zip (library source, not a deobfuscation candidate)`);
  if (skippedRealName > 0) console.log(`  ${skippedRealName} matches skipped — work side has a real/descriptive name (not bundler-mangled)`);
  if (skippedAmbiguous > 0) console.log(`  ${skippedAmbiguous} bare-name renames skipped (bare name collides with another function)`);
  if (skippedPathological > 0) console.log(`  ${skippedPathological} matches skipped — pathological "function name" (parser captured a JS expression as a name — TODO #348)`);

  // ─── Class-level aggregation pass (opt-in via --fp-classes) ──────────
  // Propose `workClass → workClass_FP_RefClass` when multiple methods of
  // workClass fingerprint-match methods of RefClass. Opt-in because this
  // can mis-label subclasses (which inherit parent methods) as the parent.
  // Three safeguards:
  //   • n_matches ≥ 2 — rules out single generic-method coincidences
  //     (_parse, toString, get length, etc.)
  //   • avg_score ≥ minScore — same quality bar as method-level renames
  //   • coverage ≥ 0.5 — matched methods must cover at least half the
  //     smaller class's method set, so "3 generic methods in common" out
  //     of 50 doesn't count.
  // Additional filters mirror the method-level pass: work side must not
  // be in node_modules/.zip (library source), workBare must look mangled,
  // workClass != refClass by bare name.
  if (args.fp_classes) {
    // Count methods-per-class from the function index. Class name is the
    // prefix before the LAST `::` in a qualified entry. A class with no
    // `::` entries has zero counted methods and is skipped.
    const methodCountByClass = new Map();
    for (const [fp, funcs] of Object.entries(index.functionIndex || {})) {
      for (const fname of Object.keys(funcs)) {
        if (!fname.includes('::')) continue;
        const parts = fname.split('::');
        const clsName = parts.slice(0, -1).join('::');
        const key = fp + '|||' + clsName;
        methodCountByClass.set(key, (methodCountByClass.get(key) || 0) + 1);
      }
    }

    // Aggregate allMatches by (workClass, refClass). Only consider matches
    // whose BOTH sides are qualified (i.e., `::` in the name).
    const byClassPair = new Map();  // "wkey>>>rkey" → { workClass, refClass, workFn, refFn, matches: [...] }
    for (const m of allMatches) {
      if (!m.workFn.name.includes('::')) continue;
      if (!m.refFn.name.includes('::')) continue;
      const wParts = m.workFn.name.split('::');
      const rParts = m.refFn.name.split('::');
      const workCls = wParts.slice(0, -1).join('::');
      const refCls  = rParts.slice(0, -1).join('::');
      // Canonicalize the pair so we see each class-pair once even if the
      // method-level matches came from both directions.
      const wKey = m.workFn.filepath + '|||' + workCls;
      const rKey = m.refFn.filepath  + '|||' + refCls;
      const [aKey, bKey, aFp, bFp, aCls, bCls] = wKey < rKey
        ? [wKey, rKey, m.workFn.filepath, m.refFn.filepath, workCls, refCls]
        : [rKey, wKey, m.refFn.filepath, m.workFn.filepath, refCls, workCls];
      const pairKey = aKey + '>>>' + bKey;
      if (!byClassPair.has(pairKey)) {
        byClassPair.set(pairKey, {
          aFp, bFp, aCls, bCls,
          matches: [],
        });
      }
      byClassPair.get(pairKey).matches.push(m);
    }

    // Bare-name uniqueness for classes — same safeguard as for methods.
    const classBareCount = new Map();
    for (const k of methodCountByClass.keys()) {
      const clsName = k.split('|||')[1];
      const bare = clsName.includes('::') ? clsName.split('::').pop() : clsName;
      classBareCount.set(bare, (classBareCount.get(bare) || 0) + 1);
    }

    let classEmitted = 0;
    let classSkippedCoverage = 0;
    let classSkippedSourceSide = 0;
    let classSkippedRealName = 0;
    const classSkippedDiag = [];  // keep a few near-misses for user diagnostic

    for (const { aFp, bFp, aCls, bCls, matches } of byClassPair.values()) {
      if (matches.length < 2) {
        // Single-method match — insufficient evidence for class identity.
        // Don't count as "skipped" if only 1 match because that's almost
        // every class pair. Just silently ignore.
        continue;
      }
      // Skip pathological "class names" from the TS private-field bug
      // (#348) — same filter as the method-level loop.
      if (_isPathologicalName(aCls) || _isPathologicalName(bCls)) continue;
      const avgScore = matches.reduce((s, m) => s + m.score, 0) / matches.length;
      if (avgScore < minScore) {
        classSkippedCoverage++;
        if (classSkippedDiag.length < 5) classSkippedDiag.push({ aCls, bCls, reason: `avg_score=${avgScore.toFixed(2)} < ${minScore}`, n: matches.length });
        continue;
      }

      // Determine direction (work vs ref). Work side = not in node_modules/.zip.
      // If both or neither are node_modules-side, skip as ambiguous.
      const aSource = (aFp.replace(/\\/g, '/').includes('node_modules/') || aFp.includes('.zip!'));
      const bSource = (bFp.replace(/\\/g, '/').includes('node_modules/') || bFp.includes('.zip!'));
      let workFp, refFp, workCls, refCls;
      if (aSource && !bSource)      { workFp = bFp; workCls = bCls; refFp = aFp; refCls = aCls; }
      else if (!aSource && bSource) { workFp = aFp; workCls = aCls; refFp = bFp; refCls = bCls; }
      else { classSkippedSourceSide++; continue; }

      const workBare = workCls.includes('::') ? workCls.split('::').pop() : workCls;
      const refBare  = refCls.includes('::')  ? refCls.split('::').pop()  : refCls;
      if (workBare === refBare) { classSkippedRealName++; continue; }

      // Bundler-mangled check on the class name.
      const mangled =
        workBare.length <= 3 ||
        /[0-9]/.test(workBare) ||
        /^[_$]/.test(workBare);
      if (!mangled) { classSkippedRealName++; continue; }

      // Coverage computed for diagnostic only — don't gate on it. In
      // bundled code, bundlers aggressively rewrite method bodies (esbuild
      // inlining, minification, operator simplification), so even a clear
      // class identity often has only a few methods fingerprint-match at
      // the current threshold. Requiring coverage ≥ 0.3 rejected real
      // identities like vx6↔MessageStream (3 matches / 28 methods = 0.11).
      //
      // Rely on matches.length ≥ 2 AND avg_score ≥ minScore as the
      // filters — single-method coincidence is blocked, and the
      // per-method score bar is the same as individual renames.
      const wCount = methodCountByClass.get(workFp + '|||' + workCls) || 0;
      const rCount = methodCountByClass.get(refFp  + '|||' + refCls)  || 0;
      const smaller = Math.min(wCount, rCount) || 1;
      const coverage = matches.length / smaller;

      const suffix = '_FP_' + _toSuffix(refBare, refFp);

      // Bare class rename (full workCls → workCls + suffix).
      const existing = existingMap[workCls];
      const newValue = existing
        ? (existing.includes(suffix) ? existing : existing + suffix)
        : (workCls + suffix);
      if (newValue !== existing) {
        existingMap[workCls] = newValue;
        classEmitted++;
        if (classSkippedDiag.length < 10) classSkippedDiag.push({
          aCls: workCls, bCls: refCls,
          reason: `→ EMITTED (${matches.length} method matches, avg_score=${avgScore.toFixed(2)}, coverage=${coverage.toFixed(2)})`,
          n: matches.length,
        });
      }

      // Propagate the class rename down to every qualified-method entry of
      // this class, so listings show `NewClass::method` rather than
      // `OldClass::method`. Bare name `Cz → Cz_FP_X` handles usages in
      // source text (class declarations, `instanceof`, static calls) but
      // not the qualified-form strings used in --list-functions /
      // --list-classes / digest output. Preserves any pre-existing
      // method-level suffix (_KW_, _FP_) by substituting only the class
      // prefix of each qualified entry.
      //
      // Runs every time we visit this class pair — not just on first
      // emission — so that re-runs after the bare class rename is
      // already in the map will still propagate the prefix to method
      // entries. Idempotent: same input → same output.
      const fileFuncs = index.functionIndex?.[workFp] || {};
      for (const fname of Object.keys(fileFuncs)) {
        if (!fname.startsWith(workCls + '::')) continue;
        // Skip pathological method keys (the TS-private-field parser bug
        // #348 captures entire JS expressions as method names). Propagating
        // the class prefix onto those would produce rename_map entries
        // whose key and value are both kilobytes of JavaScript — pollutes
        // the map and makes grep output unreadable.
        if (_isPathologicalName(fname)) continue;
        const methodLeaf = fname.slice(workCls.length + 2);
        const existingQ = existingMap[fname];
        // Preserve any existing method-level suffix (e.g. _KW_, method
        // _FP_) when re-prefixing. If a previous pass already renamed
        // this entry to start with newValue (the renamed class), keep
        // the leaf intact. If the existing value uses a DIFFERENT class
        // prefix, leave it alone — don't trample another tier's work.
        let leafForValue = methodLeaf;
        if (existingQ && existingQ.startsWith(newValue + '::')) {
          // Already renamed to the target class prefix; leaf may carry
          // method-level suffix(es). Preserve it.
          leafForValue = existingQ.slice(newValue.length + 2);
        } else if (existingQ && existingQ.startsWith(workCls + '::')) {
          // Renamed only at method level (or unchanged) — keep its leaf.
          leafForValue = existingQ.slice(workCls.length + 2);
        } else if (existingQ && existingQ.includes('::')) {
          // Existing value has some unrelated class prefix; don't fight it.
          continue;
        }
        const newQualified = newValue + '::' + leafForValue;
        if (newQualified !== existingQ) {
          existingMap[fname] = newQualified;
          classEmitted++;
        }
      }

      // Bare-name rename (only if bare is unique across all classes).
      if (classBareCount.get(workBare) === 1) {
        const bareExisting = existingMap[workBare];
        const bareNew = bareExisting
          ? (bareExisting.includes(suffix) ? bareExisting : bareExisting + suffix)
          : (workBare + suffix);
        if (bareNew !== bareExisting) {
          existingMap[workBare] = bareNew;
          classEmitted++;
        }
      }
    }
    console.log(`  ${classEmitted} class-level _FP_ entries added (--fp-classes)`);
    if (classSkippedCoverage > 0) console.log(`  ${classSkippedCoverage} class pairs skipped — insufficient avg_score or coverage`);
    if (classSkippedSourceSide > 0) console.log(`  ${classSkippedSourceSide} class pairs skipped — both sides are in library source (can't pick a direction)`);
    if (classSkippedRealName > 0) console.log(`  ${classSkippedRealName} class pairs skipped — work-side class name looks descriptive`);
    if (classSkippedDiag.length > 0) {
      console.log('  Class-pair diagnostic (emitted entries + near-misses):');
      for (const d of classSkippedDiag) {
        console.log(`    ${d.aCls} ↔ ${d.bCls}  ${d.reason}`);
      }
    }
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No file written. Re-run without --dry-run to save.');
    console.log('\nSample entries that would be added:');
    let n = 0;
    for (const [k, v] of Object.entries(existingMap)) {
      if (!v.includes('_FP_')) continue;
      console.log(`  ${k.padEnd(40)} → ${v}`);
      if (++n >= 20) break;
    }
    return;
  }

  fs.writeFileSync(renameMapPath, JSON.stringify(existingMap, null, 2));
  console.log(`\nUpdated ${renameMapPath}`);
  console.log(`Total rename entries: ${Object.keys(existingMap).length}`);
  console.log('Grep "_FP_" to audit the additions:');
  console.log(`  grep _FP_ ${renameMapPath}`);

  // Provenance: COPY each loaded fingerprint file into the index, so the
  // index is self-contained — a reader can examine the fingerprints that
  // informed its renames without needing the original .fp.json on the
  // filesystem. Stored under <indexPath>/fingerprints/ with a manifest.json
  // recording the applied_at timestamp and the min_score used.
  if (provenance && provenance.length > 0) {
    const fpDir = path.join(index.indexPath, 'fingerprints');
    fs.mkdirSync(fpDir, { recursive: true });
    const manifestPath = path.join(fpDir, 'manifest.json');
    let manifest = { version: 1, applications: [] };
    if (fs.existsSync(manifestPath)) {
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')); }
      catch { manifest = { version: 1, applications: [] }; }
      if (!manifest.applications) manifest.applications = [];
    }
    const applied_at = new Date().toISOString();
    for (const p of provenance) {
      const baseName = path.basename(p.path);
      const destPath = path.join(fpDir, baseName);
      try {
        fs.copyFileSync(p.path, destPath);
      } catch (e) {
        console.log(`  warn: couldn't copy ${p.path} into index: ${e.message}`);
        continue;
      }
      manifest.applications.push({
        applied_at,
        min_score: minScore,
        original_path: p.path,
        embedded_as: baseName,
        loaded_functions: p.loaded_functions,
        saved_at: p.saved_at,
        sources: p.sources,
      });
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`Embedded fingerprint files in ${fpDir} (${manifest.applications.length} application records)`);
  }

  // Invalidate in-memory rename cache on the index so a subsequent query
  // in the same process picks up the new entries.
  index._renameMap = null;
  index._reverseRenameMap = null;
  index._renameRegex = null;
}
