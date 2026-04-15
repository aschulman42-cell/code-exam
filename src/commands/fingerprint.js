/**
 * Helpers for the string-call-dupe family (functions fingerprinted by their
 * distinctive string literals and called-name sets, rather than by structural
 * shape).
 *
 * Motivation: structural hashing (--struct-dupes / --struct-diff-all) produces
 * zero matches between minified/bundled code and its un-bundled source library
 * because bundlers (esbuild, webpack, etc.) transform the AST shape even when
 * the function's logical behavior is preserved. String literals and the names
 * of called functions/methods survive bundling largely intact, so a set of
 * those tokens forms a semantic fingerprint robust to structural transforms.
 *
 * Inspired by "opstrings / function digests" for binary-clone detection
 * (Schulman, Dr. Dobb's Journal, 2005): treat each function as a multiset of
 * semantic tokens; compare via exact hash (--string-call-dupes) or via
 * similarity (--cmp-string-call-dupes).
 *
 * Token classes (prefixed so they don't collide across classes):
 *   S:<string>   — string literal, only if globally rare (appears in ≤N functions)
 *   C:<ident>    — direct function call: IDENT(...)
 *   M:<ident>    — method call: .IDENT(...)
 */

import crypto from 'crypto';

// JS keywords and ubiquitous stdlib names that match the call-site regex but
// carry no discriminating signal. Kept tight — over-aggressive filtering
// destroys information.
const CALL_NOISE = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'throw', 'typeof',
  'delete', 'void', 'new', 'in', 'of', 'instanceof', 'await', 'async',
  'function', 'yield', 'try', 'else', 'do', 'break', 'continue', 'case',
  'const', 'let', 'var', 'class', 'extends', 'super', 'this', 'default',
  // Ubiquitous globals
  'console', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'Boolean', 'Number', 'String', 'Array', 'Object', 'JSON', 'Math',
  'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Buffer',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
  // Ubiquitous methods
  'log', 'warn', 'error', 'info', 'debug', 'trace', 'assert',
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'split',
  'forEach', 'map', 'filter', 'reduce', 'find', 'findIndex', 'some', 'every',
  'includes', 'indexOf', 'lastIndexOf', 'sort', 'reverse',
  'keys', 'values', 'entries', 'toString', 'valueOf', 'hasOwnProperty',
  'call', 'apply', 'bind',
  'then', 'catch', 'finally', 'resolve', 'reject', 'all', 'race',
  'parse', 'stringify', 'trim', 'toLowerCase', 'toUpperCase',
  'replace', 'match', 'test', 'exec', 'startsWith', 'endsWith',
  'require', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'add', 'has', 'get', 'set', 'delete', 'clear',
]);

/**
 * Derive a "source" label from a filepath — the logical project/archive the
 * file belongs to. Used by --cross-source-only filters to distinguish
 * same-project duplication from cross-codebase matches.
 *
 *   foo/bar.zip!dir/file.py             → "bar.zip"          (archive)
 *   node_modules/zod/v4/something.ts    → "zod"              (npm package)
 *   node_modules/@scope/pkg/sub/file.js → "@scope/pkg"       (scoped npm package)
 *   transformers/models/llama/x.py      → "llama"            (parent dir)
 *
 * The npm-package coalescing is what keeps zod's v3/v4/src/helpers variants,
 * or @anthropic-ai/sdk's src/client.js/client.mjs variants, all mapped to one
 * source — otherwise the cross-source filter admits them as "different
 * sources" and the output is swamped by within-package duplication.
 */
export function sourceOfPath(fp) {
  if (!fp) return '';
  const norm = fp.replace(/\\/g, '/');
  const bangIdx = norm.indexOf('.zip!');
  if (bangIdx >= 0) {
    const zipPath = norm.slice(0, bangIdx + 4);
    const slashIdx = zipPath.lastIndexOf('/');
    return slashIdx >= 0 ? zipPath.slice(slashIdx + 1) : zipPath;
  }
  // Coalesce all files inside one npm package to a single source label. We
  // look for `node_modules/` as a substring so the rule works whether the
  // path is relative (`node_modules/zod/...`) or absolute
  // (`/mnt/.../node_modules/zod/...`).
  const nm = norm.indexOf('node_modules/');
  if (nm >= 0) {
    const after = norm.slice(nm + 'node_modules/'.length);
    const parts = after.split('/');
    // Scoped package: @scope/pkg — two segments
    if (parts[0] && parts[0].startsWith('@') && parts[1]) {
      return parts[0] + '/' + parts[1];
    }
    if (parts[0]) return parts[0];
  }
  const parts = norm.split('/').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return parts[parts.length - 2];
}

function _canonString(s) {
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/**
 * Scan every function once to build a global per-function frequency map for
 * string literals. Used to filter out ubiquitous strings (they contribute zero
 * discrimination to the fingerprint).
 *
 * @param {CodeSearchIndex} index
 * @returns {Map<string,number>}  string value → # of distinct functions it appears in
 */
export function buildGlobalStringFreq(index) {
  index._ensureFunctionIndex();
  const freq = new Map();
  if (!index.functionIndex) return freq;
  const strRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const [fp, funcs] of Object.entries(index.functionIndex)) {
    const lines = index.fileLines.get(fp);
    if (!lines) continue;
    for (const [, info] of Object.entries(funcs)) {
      const body = lines.slice(info.start - 1, info.end).join('\n');
      strRe.lastIndex = 0;
      const seen = new Set();
      let m;
      while ((m = strRe.exec(body)) !== null) {
        const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
        if (!raw || raw.length < 3 || raw.length > 200) continue;
        seen.add(raw);
      }
      for (const s of seen) freq.set(s, (freq.get(s) || 0) + 1);
    }
  }
  return freq;
}

/**
 * Extract the fingerprint token set for a function body.
 *
 * @param {string} body
 * @param {Map<string,number>} globalStrFreq
 * @param {number} maxStrFreq  Strings appearing in ≤ this many functions are
 *                             kept as "distinctive"; more common strings are
 *                             dropped as noise.
 * @returns {Set<string>}
 */
export function extractFingerprint(body, globalStrFreq, maxStrFreq) {
  const tokens = new Set();

  // --- String literals (only globally rare ones) ---
  const strRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  let m;
  while ((m = strRe.exec(body)) !== null) {
    const raw = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    if (!raw || raw.length < 3 || raw.length > 200) continue;
    if (/^\s*$/.test(raw)) continue;
    const freq = globalStrFreq.get(raw);
    if (freq === undefined || freq > maxStrFreq) continue;
    tokens.add('S:' + _canonString(raw));
  }

  // --- Direct calls: IDENT( (not preceded by . or word-char) ---
  const directRe = /(?<![a-zA-Z_$.\w])([a-zA-Z_$][\w$]{1,})\s*\(/g;
  while ((m = directRe.exec(body)) !== null) {
    const name = m[1];
    if (CALL_NOISE.has(name)) continue;
    if (name.length < 2) continue;
    tokens.add('C:' + name);
  }

  // --- Method calls: .IDENT( ---
  const methodRe = /\.\s*([a-zA-Z_$][\w$]{1,})\s*\(/g;
  while ((m = methodRe.exec(body)) !== null) {
    const name = m[1];
    if (CALL_NOISE.has(name)) continue;
    if (name.length < 2) continue;
    tokens.add('M:' + name);
  }

  return tokens;
}

/**
 * Deterministic hash of a fingerprint token set, used for exact-match grouping
 * (the --string-call-dupes family). Sort tokens, null-join, SHA1, truncate.
 *
 * @param {Set<string>|string[]} tokens
 * @returns {string}  10-char hex prefix of SHA1
 */
export function fingerprintHash(tokens) {
  const sorted = [...tokens].sort();
  return crypto.createHash('sha1').update(sorted.join('\0')).digest('hex').slice(0, 10);
}

/**
 * Jaccard similarity between two fingerprint token sets.
 * |A ∩ B| / |A ∪ B|, clamped to 0 when either side is empty.
 */
export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Run extractFingerprint over every indexed function and return the array of
 * function descriptors with their fingerprints and hashes. Shared setup for
 * both the exact-match dupe commands and the Jaccard-compare command.
 *
 * @param {CodeSearchIndex} index
 * @param {object} [opts]
 * @param {number} [opts.minTokens=6]
 * @param {number} [opts.maxStrFreq=20]
 * @returns {{ fns: Array, globalStrFreq: Map }}
 */
export function computeAllFingerprints(index, { minTokens = 6, maxStrFreq = 20 } = {}) {
  index._ensureFunctionIndex();
  const globalStrFreq = buildGlobalStringFreq(index);
  const fns = [];
  if (!index.functionIndex) return { fns, globalStrFreq };
  for (const [fp, funcs] of Object.entries(index.functionIndex)) {
    const lines = index.fileLines.get(fp);
    if (!lines) continue;
    const source = sourceOfPath(fp);
    for (const [name, info] of Object.entries(funcs)) {
      const body = lines.slice(info.start - 1, info.end).join('\n');
      const tokens = extractFingerprint(body, globalStrFreq, maxStrFreq);
      if (tokens.size < minTokens) continue;
      fns.push({
        filepath: fp, name, source,
        fingerprint: tokens,
        size: tokens.size,
        hash: fingerprintHash(tokens),
        start: info.start,
        end: info.end,
        lines: info.end - info.start + 1,
      });
    }
  }
  return { fns, globalStrFreq };
}
