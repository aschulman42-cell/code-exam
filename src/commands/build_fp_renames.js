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
import { computeAllFingerprints, jaccard } from './fingerprint.js';

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

export function doBuildFpRenames(index, args) {
  const minScore = parseFloat(args.build_fp_renames) || 0.8;
  const minTokens = args.fingerprint_min_tokens != null
    ? parseInt(args.fingerprint_min_tokens) : 6;
  const dryRun = !!args.dry_run;

  console.log(`Building _FP_ rename entries from fingerprint matches (min-score=${minScore}, min-tokens=${minTokens})${dryRun ? ' [DRY RUN]' : ''}`);

  const { fns } = computeAllFingerprints(index, { minTokens });
  console.log(`  ${fns.length} functions have fingerprints with ≥${minTokens} tokens`);

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

  // Track, per work fullName, the best ref match we've seen (same canonical-
  // pair dedup as --cmp-string-call). Each work function gets at most one
  // _FP_ entry, picked at the highest cross-source score.
  const bestMatchFor = new Map();  // workFullName → { workFn, refFn, score }
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
      const ka = w.filepath + '|||' + w.name;
      const kb = r.filepath + '|||' + r.name;
      const pairKey = ka < kb ? ka + '<=>' + kb : kb + '<=>' + ka;
      if (seenPair.has(pairKey)) continue;
      seenPair.add(pairKey);
      const score = jaccard(w.fingerprint, r.fingerprint);
      if (score < minScore) continue;
      // Both sides are candidates — update bestMatchFor for both. A work
      // function in a reference library may also be a work function from
      // the other side's perspective.
      const existingW = bestMatchFor.get(w.name);
      if (!existingW || score > existingW.score) bestMatchFor.set(w.name, { workFn: w, refFn: r, score });
      const existingR = bestMatchFor.get(r.name);
      if (!existingR || score > existingR.score) bestMatchFor.set(r.name, { workFn: r, refFn: w, score });
    }
  }
  console.log(`  ${bestMatchFor.size} function-name candidates pass min-score`);

  // Load existing rename map — we accumulate, not overwrite.
  const renameMapPath = path.join(index.indexPath, 'rename_map.json');
  let existingMap = {};
  if (fs.existsSync(renameMapPath)) {
    try { existingMap = JSON.parse(fs.readFileSync(renameMapPath, 'utf-8')); }
    catch (e) { console.log(`  warn: couldn't parse existing rename_map.json (${e.message}); starting fresh.`); }
  }

  let emitted = 0;
  let skippedAmbiguous = 0;
  let skippedSourceSide = 0;
  let skippedRealName = 0;
  for (const [workFullName, { workFn, refFn, score }] of bestMatchFor) {
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
  console.log(`  ${emitted} _FP_ entries added to rename map`);
  if (skippedSourceSide > 0) console.log(`  ${skippedSourceSide} matches skipped — work side is in node_modules/.zip (library source, not a deobfuscation candidate)`);
  if (skippedRealName > 0) console.log(`  ${skippedRealName} matches skipped — work side has a real/descriptive name (not bundler-mangled)`);
  if (skippedAmbiguous > 0) console.log(`  ${skippedAmbiguous} bare-name renames skipped (bare name collides with another function)`);

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

  // Invalidate in-memory rename cache on the index so a subsequent query
  // in the same process picks up the new entries.
  index._renameMap = null;
  index._reverseRenameMap = null;
  index._renameRegex = null;
}
