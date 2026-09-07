// bundle-seam-detection.js — detects esbuild module-wrapper seams in minified bundles and recovers per-module names and previews
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * bundle-seam-detection.js — Free functions for detecting esbuild-bundled
 * JS module wrappers. Pulled out of CodeSearchIndex.js (Issue #18, Phase 1
 * peel 1).
 *
 * All functions here are pure (no `this`, no idx, no shared state). They
 * operate on a `lines` array (the file's split-by-newline content) plus
 * optional positional arguments. The cluster is self-contained: the only
 * cross-function calls are intra-cluster (e.g. _parseEsbuildWrappers calls
 * _detectBundleHelpers and _findWrapperEnd).
 *
 * Leading underscores stay on the export names — they originally marked
 * these as module-private inside CodeSearchIndex.js and are kept for
 * call-site stability (renaming would touch 6+ sites for no behavioral
 * win).
 */

// ============================================================================
// Bundle-seam detection (#330)
//
// Minified JS bundles from esbuild/webpack/etc. wrap each original source
// module in a compact helper pattern. For esbuild this is the "lazy factory"
// idiom, e.g.:
//
//   var E = (A, q) => () => (A && (q = A(A = 0)), q);             // ESM helper
//   var C = (A, q) => () => (q || A((q = {exports: {}}).exports,  // CJS helper
//                                     q), q.exports);
//   var Dh1 = E(() => { ... });               // one module
//   var JL  = E(() => { ... });               // another module
//   var fA6 = E(() => { ... });               // ...
//
// Two pattern families supported:
//   - esbuild-flat: helpers and modules at column 0 (claude-code's cli.js)
//   - esbuild-iife: everything wrapped in a top-level IIFE so helpers and
//                   modules are indented inside (mermaid.min.js)
//
// Shape-based helper detection (not name-based) makes this robust across
// different bundle outputs where helpers are named E/C, I/Jt, etc.
// ============================================================================

/**
 * Detect ESM and CJS module-wrapper helper names by scanning the top of the
 * file for their distinctive memoization signatures:
 *   ESM: (X && (Y = X(X = 0)), Y)       — memoizes factory result into Y
 *   CJS: (Y = {exports: {}}).exports    — initializes CJS exports object
 *
 * The helper NAMES vary per bundle but the SHAPES are consistent. Returns
 * { esm, cjs, iifeStartLine } where iifeStartLine > 0 indicates the bundle
 * wraps everything in a top-level IIFE.
 *
 * Scans the first 200 lines as a joined string (whitespace-normalized) so
 * helper declarations that span multiple lines in the minified output are
 * still caught.
 */
export function _detectBundleHelpers(lines) {
  const helpers = { esm: null, cjs: null, iifeStartLine: -1 };
  const N = Math.min(200, lines.length);
  // Keep whitespace so `\b` word boundaries work — the normalized-string
  // approach caused `var E =` to capture as `varE` when the regex engine
  // started matching at position 0.
  const head = lines.slice(0, N).join('\n');

  // ESM shape: NAME = (X, Y) => () => (X && (Y = X(X = 0)), Y)
  // Distinctive substring: the `Y = X(X = 0)` memoization kernel.
  const esmRe = /\b(\w+)\s*=\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\(\s*\)\s*=>\s*\(\s*\w+\s*&&\s*\(\s*\w+\s*=\s*\w+\s*\(\s*\w+\s*=\s*0\s*\)/;
  const esmMatch = head.match(esmRe);
  if (esmMatch && esmMatch[1] !== 'var' && esmMatch[1] !== 'let' && esmMatch[1] !== 'const') {
    helpers.esm = esmMatch[1];
  }

  // CJS shape: NAME = (X, Y) => () => (Y || X((Y = {exports: {}}).exports, Y), Y.exports)
  // The `Y || X((Y = {exports:{}}` kernel is distinctive and specific enough
  // to not accidentally bridge across two adjacent helper declarations (the
  // ESM kernel uses `&&` and has no `{exports:{}}`, so the alternation/
  // initialization pair only appears in CJS helpers).
  const cjsRe = /\b(\w+)\s*=\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\(\s*\)\s*=>\s*\(\s*\w+\s*\|\|\s*\w+\s*\(\s*\(?\s*\w+\s*=\s*\{\s*exports\s*:\s*\{\s*\}\s*\}/;
  const cjsMatch = head.match(cjsRe);
  if (cjsMatch && cjsMatch[1] !== 'var' && cjsMatch[1] !== 'let' && cjsMatch[1] !== 'const') {
    helpers.cjs = cjsMatch[1];
  }

  // Outer IIFE detection — mermaid.min.js's raw single-line form starts with
  //   (__esbuild_esm_mermaid_nm ||= {}).mermaid = (() => {
  // After js-beautify the same opener splits across lines, with the IIFE's
  // arrow now anchored on a later line by an `LHS = (() => {` shape:
  //   (__esbuild_esm_mermaid_nm ||= {})
  //   .mermaid = (() => {
  // Scan a wider window (50 lines) to survive that split.
  for (let i = 0; i < Math.min(50, lines.length); i++) {
    const norm = (lines[i] || '').replace(/\s+/g, '');
    if (
      // Single-line minified form: `(name ||= {}).x = (() => {`
      /\|\|=\{\}\)\.\w+=\(\(\)=>\{/.test(norm) ||
      // Bare IIFE: `(() => {`
      /^\(\(\)=>\{/.test(norm) ||
      // Bare IIFE with params: `((a, b) => {`
      /^\(\([^)]*\)=>\{/.test(norm) ||
      // Assigned bare IIFE (post-beautify mermaid form): `.x = (() => {`
      /=\(\(\)=>\{/.test(norm) ||
      // Assigned IIFE with params: `.x = ((a, b) => {`
      /=\(\([^)]*\)=>\{/.test(norm)
    ) {
      helpers.iifeStartLine = i + 1;
      break;
    }
  }

  return helpers;
}

/**
 * Walk forward from a wrapper's opening line, tracking JS state (strings,
 * templates, comments) via the same machine used in _scanLineState but doing
 * brace counting in the 'code' state. Returns the 1-indexed line where the
 * matching `}` of the arrow-function body appears.
 *
 * Used by detectBundleSeams to find the real end of each `var X = E(()=>{…})`
 * module wrapper. The sibling rule (end = nextSibling.start - 1) was wrong
 * because esbuild interleaves module-scope `var` decls between wrappers and
 * sometimes emits unrelated top-level code between them; we need the actual
 * closing `}` to bound each wrapper tightly.
 *
 * Doesn't handle regex literals (a `/.../` containing `{` or `}` could
 * miscount). In practice rare inside esbuild wrappers since wrappers are
 * structured as var/function/class declarations. Accepted limitation.
 */
export function _findWrapperEnd(lines, startLineIdx) {
  let state = 'code';
  let braceDepth = 0;
  let foundOpenBrace = false;

  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i] || '';
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = j + 1 < line.length ? line[j + 1] : '';
      // Escape handling lives inside each string state below (the `ch === '\\'`
      // skips). A lone look-back at `prev === '\\'` can't distinguish an escaped
      // backslash `\\` from an escaping one, so a `"C:\\"`-style literal wedged
      // the scanner in string-state and desynced the brace count. #251
      if (state === 'code') {
        if (ch === '/' && next === '/') { state = 'lc'; j++; continue; }
        if (ch === '/' && next === '*') { state = 'bc'; j++; continue; }
        if (ch === "'") { state = 's'; continue; }
        if (ch === '"') { state = 'd'; continue; }
        if (ch === '`') { state = 't'; continue; }
        if (ch === '{') {
          braceDepth++;
          foundOpenBrace = true;
        } else if (ch === '}') {
          braceDepth--;
          if (foundOpenBrace && braceDepth === 0) {
            return i + 1; // 1-indexed end line
          }
        }
      } else if (state === 's') {
        if (ch === '\\') j++;                // escape: consume the next char
        else if (ch === "'") state = 'code';
      } else if (state === 'd') {
        if (ch === '\\') j++;
        else if (ch === '"') state = 'code';
      } else if (state === 't') {
        if (ch === '\\') j++;
        else if (ch === '`') state = 'code';
        // Template-literal ${} interpolation is NOT tracked for brace counting.
        // This could theoretically miscount but is rare in module wrappers.
      } else if (state === 'bc') {
        if (ch === '*' && next === '/') { state = 'code'; j++; continue; }
      }
    }
    // Line comments end at line boundary
    if (state === 'lc') state = 'code';
  }
  // Unmatched — fall back to end of file
  return lines.length;
}

/**
 * Scan an esbuild-bundled file's lines for module-level `var NAME = H((...) => {…})`
 * declarations where H is the detected ESM or CJS lazy-factory helper. These
 * compile to genuine module functions but the regex parser in _parseFunctionsRegex
 * doesn't catch them (it looks for `function NAME(...)` / `class NAME` / etc.
 * shapes, not arrow-assigned-to-var declarations wrapped inside a helper call).
 *
 * Missing these costs us a lot — claude-code's cli.js has ~4,300 such entries
 * that never make it into the function index, so click-through on identifiers
 * like `fwq()` or `bHq()` reports "function not found" even though the call
 * target is right there in the file. See TODO #340.
 *
 * This is an ESBUILD-ONLY pattern. Webpack, Parcel, Rollup, Vite use entirely
 * different module-wrapper shapes (see TODO #333). This function deliberately
 * returns {} for any file whose top-of-file doesn't contain an esbuild helper
 * declaration — no risk of false-positive captures on non-esbuild bundles.
 *
 * @param {string[]} lines — the file's line array
 * @returns {object} — { name: { start, end, type, base_name } } ready to merge
 *                     into a fileFuncs map. Empty object if no esbuild helper
 *                     is detected or no wrappers are found.
 */
export function _parseEsbuildWrappers(lines) {
  const helpers = _detectBundleHelpers(lines);
  if (!helpers.esm && !helpers.cjs) return {};

  // Build a character-class of the one-letter helper names we're willing to
  // match as wrapper invocations. Both ESM and CJS helpers use the same
  // "var X = H(<arrow>)" shape at the call site — the difference is just
  // whether the inner arrow takes arguments (CJS passes exports/module).
  // Escape in case a helper letter happens to be a regex metachar (very
  // unlikely since _detectBundleHelpers returns \w+ but defensive here).
  const helperLetters = [helpers.esm, helpers.cjs]
    .filter(Boolean)
    .map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (helperLetters.length === 0) return {};

  // `var NAME = HELPER(` — matches either ESM or CJS wrappers, then we
  // separately confirm the next non-whitespace token is `(` starting an
  // arrow-function parameter list. We do this in two steps (not one regex)
  // because arrow-param lists vary in shape (`()`, `(x)`, `(x, y)`, with or
  // without types) and folding that into one regex gets brittle fast.
  const declRe = new RegExp(
    '^\\s*var\\s+([a-zA-Z_$][\\w$]*)\\s*=\\s*(' + helperLetters.join('|') + ')\\s*\\('
  );
  // After the wrapping `(` we expect the inner arrow's parameter list,
  // which begins with `(`. Whitespace between them is tolerated because
  // prettifiers vary.
  const innerArrowRe = /^\s*\([^)]*\)\s*=>/;

  const found = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(declRe);
    if (!m) continue;
    const name = m[1];
    // Slice the tail after the match to confirm it opens an arrow.
    const tail = line.slice(m[0].length);
    if (!innerArrowRe.test(tail)) continue;

    // Find the closing `}` of the arrow body using the shared brace-counter
    // (which tracks string/template/comment state correctly).
    const endLine = _findWrapperEnd(lines, i);
    const startLine = i + 1;  // 1-indexed
    if (endLine <= startLine) continue;  // pathological — skip

    // Don't overwrite later duplicates (the caller merges and keeps the
    // existing entry); if this collides with a same-named entry we just
    // append an @line disambiguator.
    const key = (name in found) ? `${name}@${startLine}` : name;
    found[key] = {
      start: startLine,
      end: endLine,
      type: 'function',
      base_name: name,
    };
  }
  return found;
}

/**
 * Extract a "preview" line from inside a module body — the first line that's
 * likely to tell you what the module is about. Skips trivial stuff (var
 * declarations at top, "use strict", closing braces, pure punctuation).
 */
export function _extractModulePreview(lines, startIdx, endIdx) {
  const maxScan = Math.min(startIdx + 25, endIdx + 1, lines.length);
  let fallback = null;
  for (let i = startIdx + 1; i < maxScan; i++) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Trivial lines to skip
    if (/^["']use strict["'];?$/.test(trimmed)) continue;
    if (/^[{}(),;]+\s*$/.test(trimmed)) continue;
    if (/^var\s+\w+(\s*,\s*\w+)*\s*;?\s*$/.test(trimmed)) continue; // `var x, y, z;`
    if (fallback === null) fallback = trimmed;
    // Prefer lines with function definitions or distinctive content
    if (
      /\bfunction\s+\w+/.test(trimmed) ||
      /^\w+\s*=\s*function/.test(trimmed) ||
      /["'][\w.\-/@]{4,}["']/.test(trimmed) ||
      /\w+\.prototype\./.test(trimmed) ||
      /module\.exports/.test(trimmed) ||
      /\bclass\s+\w+/.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return fallback || '(no preview)';
}

/**
 * #332: Detect esbuild's `__name` helper variable name.
 *
 * When esbuild is configured with `--keep-names` (on by default in many
 * configs), it injects a helper that preserves each function's original
 * name by calling Object.defineProperty(fn, "name", { value: "origName" }).
 * The helper is typically declared at the top of the bundle as a 2-arg
 * arrow function whose body calls Object.defineProperty — directly or via
 * a short local alias (mermaid uses `Zv` for `Object.defineProperty`).
 *
 * Sample (mermaid.min.js L10-13):
 *   var o = (t, e) => Zv(t, "name", {
 *     value: e,
 *     configurable: true
 *   });
 *
 * Returns the helper variable name (e.g. "o"), or null if not detected.
 *
 * Scans the first 200 lines as a joined string so helpers whose body
 * object-literal wraps onto multiple lines are still caught.
 *
 * -------------------------------------------------------------------------
 * Coverage note — when this feature yields results vs doesn't:
 *
 * `--keep-names` is default in many esbuild configs, but is often stripped
 * in production bundles of commercial / obfuscated software because:
 *   (a) each o(X, "origName") call adds ~30-50 bytes of overhead per
 *       function — on a 513k-line bundle with 10k+ functions this is
 *       meaningful,
 *   (b) it leaks original function names, undoing most of the effect of
 *       aggressive minification,
 *   (c) runtime uses of `fn.name` (error stack traces, React devtools,
 *       debug logging) aren't needed in release builds.
 *
 * So the empirical pattern is:
 *   - Library distributions intended for general use (mermaid, chart libs,
 *     UI frameworks): usually HAVE the helper, yield hundreds-to-thousands
 *     of ground-truth (obfuscated → original) rename pairs.
 *   - Aggressively minified commercial bundles (e.g. claude-code's cli.js):
 *     typically DO NOT have the helper, yield zero _NAME_ recoveries.
 *
 * A zero result is itself a signal about the vendor's obfuscation posture
 * — worth surfacing to the user, not just silently skipped.
 * -------------------------------------------------------------------------
 */
export function _detectNameHelper(lines) {
  const N = Math.min(200, lines.length);
  const head = lines.slice(0, N).join('\n');
  // Match: NAME = (arg1, arg2) => INNER(arg1, "name", ...
  // Capture:
  //   [1] NAME (helper variable name)
  //   [2] arg1 (must appear as first arg to INNER, enforced via \2 backref)
  // Loose on whitespace so the body can wrap. The `,` after "name" is the
  // distinguishing feature — a typical Object.defineProperty(target, "name",
  // descriptor) call has exactly that trailing comma.
  const re = /\b(\w+)\s*=\s*\(\s*(\w+)\s*,\s*\w+\s*\)\s*=>\s*\w+(?:\s*\.\s*\w+)?\s*\(\s*\2\s*,\s*["']name["']\s*,/;
  const m = head.match(re);
  if (!m) return null;
  const name = m[1];
  // Exclude accidental capture of storage-class keywords
  if (name === 'var' || name === 'let' || name === 'const') return null;
  return name;
}

/**
 * #332: Scan for `helperName(IDENT, "originalName")` patterns and harvest
 * every (IDENT → originalName) pair. Returns a Map of
 *   IDENT (string) → Set<string> of observed original-name strings.
 *
 * The caller uses Set size to detect ambiguity (same IDENT tagged with
 * different names across the bundle) and skip those pairs — only
 * unambiguous pairs get added to the rename map.
 */
export function _extractNameRecoveryPairs(lines, helperName) {
  const result = new Map();
  const escHelper = helperName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match helperName(IDENT, "string"...  — the trailing comma or close-paren
  // is deliberately permissive so helpers with signatures like
  //   __nameX(target, "origName", extra)
  // are handled too.
  const re = new RegExp(
    '\\b' + escHelper + '\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*"([^"\\\\]+)"\\s*[,)]',
    'g'
  );
  for (const line of lines) {
    if (!line) continue;
    // Fast filter: skip lines that don't even contain the helper name
    if (!line.includes(helperName)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const ident = m[1];
      const origName = m[2];
      // Sanity filters on the harvested name
      if (origName.length < 2) continue;
      if (!/[a-zA-Z]/.test(origName)) continue;
      // Don't self-pair (e.g., o(o, "o"))
      if (ident === origName) continue;
      if (!result.has(ident)) result.set(ident, new Set());
      result.get(ident).add(origName);
    }
  }
  return result;
}

/**
 * Classify a bundle's pattern based on detected helpers.
 *   'esbuild-flat'  — helpers + wrappers at column 0 (claude-code's cli.js)
 *   'esbuild-iife'  — everything wrapped in a top-level IIFE (mermaid.min.js)
 *   null            — no esbuild helpers detected; not an esbuild bundle
 *
 * Factored out of CodeSearchIndex.detectBundleSeams so the splitter's
 * Phase 1b can branch on pattern without pulling in the function-index
 * dependency that detectBundleSeams uses for its gap-module pass.
 */
export function _detectBundlePattern(lines, helpers) {
  if (!helpers.esm && !helpers.cjs) return null;
  return helpers.iifeStartLine > 0 ? 'esbuild-iife' : 'esbuild-flat';
}

/**
 * Derive a content-based hint for naming a bundle-seam virtual file (#20).
 * Pass 0 (#20 followup): if a name-helper invocation `helper(IDENT, "STRING")`
 * exists inside the wrapper body, capture STRING and trust it as the hint
 * regardless of CamelCase. This is the gold-standard module-identity signal
 * — esbuild's `__name(fn, "originalName")` helper preserves the original
 * function name, and any wrapper that registers a named function with it is
 * effectively telling us what to call it.
 * Pass 1: a path-shaped string with multiple slashes (esbuild wrappers
 * around AWS-SDK clients leak `./dist-cjs/index.js`-style paths).
 * Pass 2: a distinctive string literal (>=6 chars, contains `-`/`_`/CamelCase
 * hint, looks identifier-like — e.g. `claude-code-marketplace`).
 * Returns a sanitized, filesystem-safe slug (<=60 chars) or null.
 *
 * @param {string[]} lines
 * @param {{start: number, end: number}} w
 * @param {string|null} [nameHelper] — output of _detectNameHelper, or null
 */
export function _deriveWrapperHint(lines, w, nameHelper = null) {
  const N = Math.min(w.start - 1 + 20, w.end, lines.length);
  // Pass 0: name-helper invocation — `helper(IDENT, "STRING")`.
  if (nameHelper) {
    const escHelper = nameHelper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const helperRe = new RegExp(
      '\\b' + escHelper + '\\s*\\(\\s*[A-Za-z_$][\\w$]*\\s*,\\s*["\']([\\w.-]{2,60})["\']\\s*[,)]',
      'g'
    );
    for (let i = w.start - 1; i < N; i++) {
      const line = lines[i] || '';
      if (!line.includes(nameHelper)) continue;
      helperRe.lastIndex = 0;
      let m;
      while ((m = helperRe.exec(line)) !== null) {
        const s = m[1];
        if (!/[a-zA-Z]/.test(s)) continue;
        let slug = s.replace(/[^\w-]/g, '-');
        if (slug.length > 60) slug = slug.slice(0, 60);
        if (slug.length >= 3) return slug;
      }
    }
  }
  // Pass 1: path-shaped strings (multiple-slash paths inside string quotes).
  const pathRe = /["'`]((?:[@\w.-]+\/){1,}[@\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx))["'`]/;
  for (let i = w.start - 1; i < N; i++) {
    const m = (lines[i] || '').match(pathRe);
    if (m) {
      let slug = m[1].replace(/^\.\//, '').replace(/[^\w./-]/g, '-');
      slug = slug.replace(/\.(?:js|mjs|cjs|ts|tsx|jsx|d\.ts)$/, '');
      slug = slug.replace(/\//g, '-');
      if (slug.length > 60) slug = slug.slice(0, 60);
      if (slug.length >= 4) return slug;
    }
  }
  // Pass 2: distinctive string literals.
  const distRe = /["'`]([\w-]{6,80})["'`]/g;
  for (let i = w.start - 1; i < N; i++) {
    const line = lines[i] || '';
    distRe.lastIndex = 0;
    let m;
    while ((m = distRe.exec(line)) !== null) {
      const s = m[1];
      if (!/[-_]|[a-z][A-Z]/.test(s)) continue;
      if (/^[0-9_-]+$/.test(s)) continue;
      if (/^(use|true|false|null|undefined)$/i.test(s)) continue;
      let slug = s.replace(/[^\w-]/g, '-');
      if (slug.length > 60) slug = slug.slice(0, 60);
      if (slug.length >= 4) return slug;
    }
  }
  return null;
}

/**
 * #20 followup: For an esbuild-IIFE bundle, walk the gaps between
 * top-level wrapper scaffolds inside the outer IIFE and identify which
 * gaps hold substantive code (the real function bodies) vs which are
 * tiny and should fold into an adjacent wrapper's slice.
 *
 * IIFE-bundle wrappers (e.g. mermaid.min.js's `var $ie = I(() => { ... })`)
 * are tiny name-registry scaffolds — a few lines that call
 * `o(F, "originalName")` to register function names. The real function
 * bodies (`function Fie(...) { ... }`) live in the gaps between these
 * scaffolds at top-level inside the IIFE. Splitting on wrappers alone
 * and discarding the original file loses the gap content entirely.
 *
 * Two outputs:
 *   - adjustedWrappers: copy of topLevel with start lines possibly
 *     extended backward to absorb tiny gaps. Keeps "no lost lines, no
 *     overlaps" within the IIFE.
 *   - substantiveGaps: substantive gap regions to materialize as their
 *     own virtual files. Each entry: { start, end, hint } where hint is
 *     a sanitized slug or null.
 *
 * Substantive-gap test: span >= 20 lines AND at least one `function NAME(`
 * declaration. Anything smaller folds into the next wrapper's slice (or
 * is dropped if it's the trailing gap after the last wrapper).
 *
 * Gap naming: if an adjacent wrapper contains `nameHelper(F, "STRING")`
 * where F is declared in the gap, use STRING as the gap's hint — the
 * name-registry wrapper's promised name applies to the function defined
 * in the preceding (or following) gap. Otherwise fall back to the first
 * function declaration's identifier.
 *
 * @param {string[]} lines
 * @param {object} helpers — output of _detectBundleHelpers (iifeStartLine > 0)
 * @param {Array<{start: number, end: number, base_name: string}>} topLevel
 * @param {string|null} nameHelper — output of _detectNameHelper, or null
 * @returns {{adjustedWrappers: object[], substantiveGaps: object[]}}
 */
export function _findGapModules(lines, helpers, topLevel, nameHelper) {
  if (helpers.iifeStartLine <= 0 || topLevel.length === 0) {
    return { adjustedWrappers: topLevel.slice(), substantiveGaps: [] };
  }
  const SUBSTANTIVE_MIN_LINES = 20;
  // Match `function NAME(`, `async function NAME(`, and generator
  // `function* NAME(` forms. esbuild keeps `async` in front of the
  // function keyword post-prettification (mermaid's `async function Fie(...)`
  // at L33411 is the canonical example).
  const FN_DECL_RE = /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/;

  const iifeStart = helpers.iifeStartLine;
  const sorted = topLevel.slice().sort((a, b) => a.start - b.start);
  // _findWrapperEnd's brace counter doesn't track regex literals or
  // template-literal `${}` interpolation, so the outer IIFE end can be
  // miscounted when there's an embedded shader/regex literal containing
  // `{`/`}` (mermaid.min.js has a GLSL template at ~L64500). The wrappers
  // themselves are short and unaffected; their `_findWrapperEnd` calls are
  // correct. So if the outer-IIFE end falls inside the wrapper span,
  // it was clipped short — extend it to just past the last wrapper so
  // gap-detection can reach the rest of the bundle.
  let iifeEnd = _findWrapperEnd(lines, iifeStart - 1);
  const lastWrapperEnd = sorted[sorted.length - 1].end;
  if (iifeEnd < lastWrapperEnd) iifeEnd = lastWrapperEnd + 1;
  const adjustedWrappers = sorted.map(w => ({ ...w }));

  // Tag each gap with adjacent wrapper indices for hint-attribution.
  const gaps = [];
  if (iifeStart + 1 <= sorted[0].start - 1) {
    gaps.push({ start: iifeStart + 1, end: sorted[0].start - 1, prevIdx: -1, nextIdx: 0 });
  }
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].end + 1 <= sorted[i + 1].start - 1) {
      gaps.push({ start: sorted[i].end + 1, end: sorted[i + 1].start - 1, prevIdx: i, nextIdx: i + 1 });
    }
  }
  const last = sorted.length - 1;
  if (sorted[last].end + 1 <= iifeEnd - 1) {
    gaps.push({ start: sorted[last].end + 1, end: iifeEnd - 1, prevIdx: last, nextIdx: -1 });
  }

  const substantiveGaps = [];
  const escHelper = nameHelper
    ? nameHelper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : null;

  for (const gap of gaps) {
    const span = gap.end - gap.start + 1;
    const limit = Math.min(gap.end, lines.length);
    const funcDecls = [];
    for (let i = gap.start - 1; i < limit; i++) {
      const m = (lines[i] || '').match(FN_DECL_RE);
      if (m) funcDecls.push({ name: m[1], line: i + 1 });
    }
    const isSubstantive = span >= SUBSTANTIVE_MIN_LINES && funcDecls.length > 0;

    if (!isSubstantive) {
      // Fold into next wrapper if there is one; drop otherwise.
      if (gap.nextIdx >= 0) {
        const tgt = adjustedWrappers[gap.nextIdx];
        if (gap.start < tgt.start) tgt.start = gap.start;
      }
      continue;
    }

    // Hint attribution. Look at adjacent wrappers for `helper(F, "STRING")`
    // where F is declared in this gap.
    let hint = null;
    if (escHelper) {
      const fnNames = new Set(funcDecls.map(f => f.name));
      const adjIdxs = [];
      if (gap.prevIdx >= 0) adjIdxs.push(gap.prevIdx);
      if (gap.nextIdx >= 0) adjIdxs.push(gap.nextIdx);
      const helperRe = new RegExp(
        '\\b' + escHelper + '\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*["\']([^"\'\\\\]{2,60})["\']',
        'g'
      );
      outer:
      for (const ai of adjIdxs) {
        const w = sorted[ai];
        const wLimit = Math.min(w.end, lines.length);
        for (let i = w.start - 1; i < wLimit; i++) {
          const line = lines[i] || '';
          if (!line.includes(nameHelper)) continue;
          helperRe.lastIndex = 0;
          let m;
          while ((m = helperRe.exec(line)) !== null) {
            if (fnNames.has(m[1])) {
              hint = m[2];
              break outer;
            }
          }
        }
      }
    }
    if (!hint) hint = funcDecls[0].name;

    let slug = hint.replace(/[^\w-]/g, '-');
    if (slug.length > 60) slug = slug.slice(0, 60);
    substantiveGaps.push({ start: gap.start, end: gap.end, hint: slug });
  }

  return { adjustedWrappers, substantiveGaps };
}

/**
 * Scan strings inside a module body for likely source-path hints and license
 * headers. Returns { paths, licenses } — both arrays, empty if nothing found.
 * Conservative: only includes strings that look unambiguously like file paths
 * or SPDX/license declarations.
 */
export function _scanModuleHints(lines, startIdx, endIdx) {
  const paths = new Set();
  const licenses = [];
  const limit = Math.min(endIdx + 1, lines.length);
  for (let i = startIdx; i < limit; i++) {
    const line = lines[i];
    if (!line) continue;
    // File path-ish strings inside quotes — must look like node_modules/...,
    // @scope/pkg/..., or a relative path ending in .js/.mjs/.cjs/.ts/.tsx
    const pathRe = /["'`]((?:[.@\w/-]+\/)+[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx))["'`]/g;
    let m;
    while ((m = pathRe.exec(line)) !== null) {
      const p = m[1];
      // Skip URLs
      if (/^https?:/.test(p) || /\/\//.test(p)) continue;
      paths.add(p);
      if (paths.size >= 5) break; // cap
    }
    // License / copyright headers
    if (/Copyright\s*\(c\)/i.test(line) || /SPDX-License-Identifier/i.test(line) || /MIT License/i.test(line)) {
      const trimmed = line.trim().replace(/^[\/\*\s]+/, '').slice(0, 100);
      if (trimmed && licenses.length < 3) licenses.push(trimmed);
    }
  }
  return { paths: [...paths], licenses };
}
