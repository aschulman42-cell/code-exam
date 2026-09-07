// structural-fingerprint.js — normalizes function bodies to funcstrings, hashes them exact/tight, and diffs near-dupes by word holes
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * structural-fingerprint.js — Structural normalization ("funcstrings"),
 * structural hashing (exact + tight modes), word-hole token extraction, and
 * structural-diff alignment between near-dupe function bodies. Pulled out of
 * `CodeSearchIndex.js` in Issue #18 Phase 2 (theme #19).
 *
 * All exports are pure: each takes a `bodyText` string (or array of bodies)
 * and returns computed values. No `idx` parameter needed — the cluster is
 * self-contained, except that `STRUCTURE_KEYWORDS` is also consumed by
 * the Vocabulary theme (src/core/vocabulary.js) and imported there.
 *
 * Cross-references inside this module use bare-name calls (`getStructuralNormalized`,
 * `_countControlFlowTokens`, `extractWordHoles`); they used to be `this.foo()`
 * and `CodeSearchIndex._foo()` from inside the class.
 */

import crypto from 'crypto';

// ========================================================================
// Structural normalization ("funcstrings") - Phase 4 dedup
// ========================================================================

/**
 * Structure-only keywords - these define the "tune".
 * Types, identifiers, and literals are all "words" that get normalized.
 */
export const STRUCTURE_KEYWORDS = new Set([
  // Control flow
  'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'return', 'goto', 'throw', 'try', 'catch',
  'finally', 'yield', 'await', 'async',
  // Declaration structure (but NOT type names)
  'class', 'struct', 'enum', 'interface', 'extends', 'implements',
  'import', 'package', 'namespace', 'using', 'typedef', 'typename',
  // Access/storage modifiers (structural)
  'public', 'private', 'protected', 'static', 'final', 'const',
  'volatile', 'abstract', 'virtual', 'override', 'inline', 'extern',
  'synchronized', 'transient', 'native',
  // Operators/structural
  'new', 'delete', 'this', 'self', 'super', 'null', 'nil', 'None',
  'true', 'false', 'True', 'False',
  'sizeof', 'typeof', 'instanceof', 'is', 'as', 'in', 'not',
  'and', 'or', 'xor',
]);

const _CONTROL_FLOW_RE = /\b(if|else|while|for|do|switch|case|return|break|continue|goto|throw|try|catch|finally|yield)\b/g;

/**
 * Normalize function body text to its structural form ("funcstring").
 *
 * 1. Strip comments (// and multi-line)
 * 2. Replace string/char literals with placeholder
 * 3. Replace numeric literals with placeholder
 * 4. Replace ALL identifiers and type names with placeholder
 * 5. Keep only control-flow/structural keywords
 * 6. Normalize whitespace
 */
export function getStructuralNormalized(bodyText) {
  let text = bodyText;

  // Step 1: Replace string literals FIRST (#251). Stripping comments first let a
  // `//` inside a string (e.g. a URL "http://x") be mistaken for a line comment,
  // corrupting the funcstring and producing false structural-dupe matches. Masking
  // quoted strings up front neutralizes any `//` or `/*` living inside them.
  text = text.replace(/"(?:[^"\\]|\\.)*"/g, '"S"');
  text = text.replace(/'(?:[^'\\]|\\.)*'/g, "'C'");

  // Step 2: Strip comments
  text = text.replace(/\/\/[^\n]*/g, '');
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');

  // Step 3: Replace numeric literals
  text = text.replace(/0[xX][0-9a-fA-F]+[lLuU]*/g, '0');
  text = text.replace(/\b\d+\.\d*(?:[eE][+-]?\d+)?[fFdD]?\b/g, '0');
  text = text.replace(/\b\.\d+(?:[eE][+-]?\d+)?[fFdD]?\b/g, '0');
  text = text.replace(/\b\d+[lLuU]*\b/g, '0');

  // Step 4: Replace identifiers and type names - only structural keywords survive
  text = text.replace(/[A-Za-z_]\w*/g, (word) => STRUCTURE_KEYWORDS.has(word) ? word : '_');

  // Step 5: Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

/**
 * Compute structural hash (SHA1 of funcstring).
 */
export function getStructuralHash(bodyText) {
  const normalized = getStructuralNormalized(bodyText);
  return crypto.createHash('sha1').update(normalized, 'utf-8').digest('hex');
}

/**
 * "Tight" structural normalization — adapts ideas from the Opstrings
 * program (Schulman). Two extra rules on top of getStructuralNormalized:
 *
 *  1. Control-flow gate. A function whose normalized form contains zero
 *     control-flow keywords (if/else/while/for/do/switch/case/return/
 *     break/continue/goto/throw/try/catch/finally/yield) is treated as
 *     shape-poor and excluded — null is returned. Catches the
 *     "class-of-string-constants" and "chain of defineProperty calls"
 *     idioms that produce structurally-trivial collisions.
 *
 *  2. Run-length suppression of repeated statements. After splitting the
 *     normalized form on `;`, any contiguous run of ≥3 identical statements
 *     collapses to `<stmt>*N`. Shrinks bag-of-declarations bodies to a
 *     form whose size reflects distinct shapes rather than text length.
 *
 * Returns null for shape-poor inputs; otherwise the tightened string.
 */
export function getStructuralNormalizedTight(bodyText) {
  const normalized = getStructuralNormalized(bodyText);
  // Control-flow gate: require ≥3 control-flow tokens. ≥1 is too lax
  // because virtually every function has a `return`; that lets pure
  // `return null;` stubs and one-line getters slip through. ≥3 is the
  // smallest threshold that reliably distinguishes substantive logic
  // from stub-shaped code in practice.
  if (_countControlFlowTokens(normalized) < 3) return null;

  const parts = normalized.split(';').map(p => p.trim());
  const out = [];
  let i = 0;
  while (i < parts.length) {
    let j = i + 1;
    while (j < parts.length && parts[j] === parts[i]) j++;
    const runLen = j - i;
    if (runLen >= 3) {
      out.push(parts[i] === '' ? `*${runLen}` : `${parts[i]}*${runLen}`);
    } else {
      for (let k = i; k < j; k++) out.push(parts[k]);
    }
    i = j;
  }
  return out.join(' ; ');
}

/**
 * SHA1 of the tight funcstring. Returns null when the function is
 * shape-poor (per the control-flow gate in getStructuralNormalizedTight).
 */
export function getStructuralHashTight(bodyText) {
  const tight = getStructuralNormalizedTight(bodyText);
  if (tight === null) return null;
  return crypto.createHash('sha1').update(tight, 'utf-8').digest('hex');
}

export function _countControlFlowTokens(funcstring) {
  const m = funcstring.match(_CONTROL_FLOW_RE);
  return m ? m.length : 0;
}

/**
 * Count of non-blank, non-comment-only lines in a function body.
 * Used by tight mode so `minLines` filters on actual code volume rather
 * than raw source-line span (which is inflated by Javadoc/block-comment
 * headers — a one-line `return null;` stub with an 18-line Javadoc
 * preamble would otherwise pass a minLines=10 filter).
 */
export function _countCodeLines(bodyText) {
  const stripped = bodyText
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  let n = 0;
  for (const line of stripped.split('\n')) {
    if (line.trim().length > 0) n++;
  }
  return n;
}

/**
 * Extract word-holes from function body text.
 *
 * Strips comments, then walks the text extracting tokens in order.
 * Each token is classified as 'structure' (keyword/punctuation, part of the "tune")
 * or 'word' (identifier/literal, a replaceable "word hole").
 *
 * Returns: [{ type: 'word'|'structure', value: string }, ...]
 *
 * Note: production code reaches this only indirectly via the in-module
 * `structDiff` caller. The CSI class wrapper exists so
 * `test/test_phase4.js` can call `idx.extractWordHoles(...)`; nothing
 * in production calls the wrapper directly.
 */
export function extractWordHoles(bodyText) {
  // Step 1: Strip comments (same as normalizer)
  let text = bodyText;
  text = text.replace(/\/\/[^\n]*/g, '');
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');

  const tokens = [];
  // Master regex: match tokens in priority order
  // Group 1: string literal   Group 2: char literal
  // Group 3: hex number       Group 4: float (leading digit)
  // Group 5: float (.N)       Group 6: integer
  // Group 7: identifier       Group 0 fallback: punctuation/operators
  const tokenRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|0[xX][0-9a-fA-F]+[lLuU]*|\b\d+\.\d*(?:[eE][+-]?\d+)?[fFdD]?\b|\.\d+(?:[eE][+-]?\d+)?[fFdD]?\b|\b\d+[lLuU]*\b|[A-Za-z_]\w*|[^\s]/g;

  let m;
  while ((m = tokenRe.exec(text)) !== null) {
    const val = m[0];
    if (val.startsWith('"') || val.startsWith("'")) {
      // String/char literal - word hole
      tokens.push({ type: 'word', value: val });
    } else if (/^[0-9]/.test(val) || (val.startsWith('.') && /^\.\d/.test(val))
               || /^0[xX]/.test(val)) {
      // Numeric literal - word hole
      tokens.push({ type: 'word', value: val });
    } else if (/^[A-Za-z_]/.test(val)) {
      // Identifier or keyword
      if (STRUCTURE_KEYWORDS.has(val)) {
        tokens.push({ type: 'structure', value: val });
      } else {
        tokens.push({ type: 'word', value: val });
      }
    } else {
      // Punctuation/operator - structure
      tokens.push({ type: 'structure', value: val });
    }
  }
  return tokens;
}

/**
 * Compare structural dupe bodies by word-hole alignment.
 *
 * Takes an array of { body: string, label: string } objects - all must share
 * the same structural hash.
 *
 * Returns: {
 *   totalWordHoles: number,
 *   diffs: [{ position: number, values: string[] }],  // positions that differ
 *   substitutions: [{ from: string, to: string, count: number }], // detected rename patterns
 *   summary: string,  // one-line summary
 * }
 */
export function structDiff(bodies) {
  if (bodies.length < 2) return null;

  // Extract word holes for each body
  const tokenSets = bodies.map(b => extractWordHoles(b.body));

  // Get word-hole-only tokens for each body
  const wordSets = tokenSets.map(tokens =>
    tokens.filter(t => t.type === 'word').map(t => t.value)
  );

  // Check alignment: all should have same number of word holes
  const lengths = wordSets.map(w => w.length);
  if (new Set(lengths).size > 1) {
    // Misaligned - shouldn't happen for true structural dupes
    return {
      totalWordHoles: lengths[0],
      diffs: [],
      substitutions: [],
      summary: `Word-hole count mismatch: ${lengths.join(' vs ')} - bodies may not be true structural dupes`,
      aligned: false,
    };
  }

  const nHoles = lengths[0];
  if (nHoles === 0) {
    return { totalWordHoles: 0, diffs: [], substitutions: [], summary: 'No word holes (pure structure)', aligned: true };
  }

  // Find positions where values differ
  const diffs = [];
  for (let i = 0; i < nHoles; i++) {
    const vals = wordSets.map(w => w[i]);
    if (new Set(vals).size > 1) {
      diffs.push({ position: i, values: vals });
    }
  }

  if (diffs.length === 0) {
    return { totalWordHoles: nHoles, diffs: [], substitutions: [], summary: 'All word-holes identical (bodies should be exact dupes)', aligned: true };
  }

  // Detect substitution patterns: pairs of values that always co-substitute
  // e.g. (log_error, LOG_ERROR) always appears together
  // Build mapping: for each pair of bodies (0 vs i), collect substitution pairs
  const subPatterns = {};
  for (const d of diffs) {
    const base = d.values[0];
    for (let i = 1; i < d.values.length; i++) {
      const other = d.values[i];
      if (base !== other) {
        const key = `${i}:${base}->${other}`;
        if (!subPatterns[key]) subPatterns[key] = 0;
        subPatterns[key]++;
      }
    }
  }

  // Collapse into substitution groups: "Order->Invoice x15"
  // Group by (bodyIndex, fromVal, toVal)
  const subGroups = {};
  for (const [key, count] of Object.entries(subPatterns)) {
    const bodyIdx = key.split(':')[0];
    const arrow = key.slice(bodyIdx.length + 1);
    if (!subGroups[arrow]) subGroups[arrow] = 0;
    subGroups[arrow] += count;
  }

  const substitutions = Object.entries(subGroups)
    .map(([arrow, count]) => {
      const [from, to] = arrow.split('->');
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count);

  // Build summary
  let summary;
  if (substitutions.length <= 3) {
    const parts = substitutions.map(s =>
      s.count > 1 ? `${s.from} -> ${s.to} (x${s.count})` : `${s.from} -> ${s.to}`
    );
    summary = `${diffs.length} of ${nHoles} word-holes differ: ${parts.join(', ')}`;
  } else {
    const topN = substitutions.slice(0, 3).map(s =>
      s.count > 1 ? `${s.from} -> ${s.to} (x${s.count})` : `${s.from} -> ${s.to}`
    );
    summary = `${diffs.length} of ${nHoles} word-holes differ: ${topN.join(', ')}, +${substitutions.length - 3} more`;
  }

  return {
    totalWordHoles: nHoles,
    diffs,
    substitutions,
    summary,
    aligned: true,
  };
}
