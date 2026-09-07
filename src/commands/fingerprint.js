// fingerprint.js — builds string+call-name fingerprints per function (hash and Jaccard) for bundling-resistant matching
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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
import fs from 'fs';

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
 * Serialize an array of computed fingerprint entries to a portable JSON file.
 * Grouped by filepath so the reader can see what was sampled without having
 * to read every entry. Function bodies are NOT included — only fingerprints.
 *
 * File shape (stable schema, version 1):
 *   {
 *     "version": 1,
 *     "saved_at": "2026-04-16T…",
 *     "source_index": "/path/to/index",
 *     "min_tokens": 6,
 *     "total_files": 28,
 *     "total_functions": 182,
 *     "sources": ["@anthropic-ai/sdk"],
 *     "files": {
 *       "node_modules/@anthropic-ai/sdk/client.js": {
 *         "source": "@anthropic-ai/sdk",
 *         "functions": [
 *           { "name": "…", "start": N, "end": N, "lines": N,
 *             "hash": "…", "fp": ["S:x", "C:y", "M:z"] }
 *         ]
 *       }
 *     }
 *   }
 *
 * Preserving filepath + line numbers is informational only: you can see
 * WHERE each fingerprint came from, even though you can't `--extract` its
 * body from the saved file alone.
 */
export function saveFingerprints(fns, outPath, sourceIndexPath, minTokens) {
  const byFile = {};
  const sources = new Set();
  for (const f of fns) {
    if (!byFile[f.filepath]) byFile[f.filepath] = { source: f.source, functions: [] };
    byFile[f.filepath].functions.push({
      name: f.name,
      start: f.start,
      end: f.end,
      lines: f.lines,
      hash: f.hash,
      fp: [...f.fingerprint].sort(),
    });
    sources.add(f.source);
  }
  const payload = {
    version: 1,
    saved_at: new Date().toISOString(),
    source_index: sourceIndexPath,
    min_tokens: minTokens,
    total_files: Object.keys(byFile).length,
    total_functions: fns.length,
    sources: [...sources].sort(),
    files: byFile,
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
}

/**
 * Load a previously-saved fingerprints file into the in-memory descriptor
 * shape used by computeAllFingerprints. Each entry gets marked with
 * `__fromFile: outPath` so downstream code (e.g. --extract) can give a
 * precise error when a user tries to extract a body that isn't in the
 * working index.
 */
export function loadFingerprints(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (!raw || raw.version !== 1 || !raw.files) {
    throw new Error(`${filePath}: not a fingerprints file (expected version:1 schema)`);
  }
  const fns = [];
  for (const [fp, entry] of Object.entries(raw.files)) {
    const source = entry.source || 'loaded';
    for (const fn of entry.functions || []) {
      fns.push({
        filepath: fp,
        name: fn.name,
        source,
        fingerprint: new Set(fn.fp || []),
        size: (fn.fp || []).length,
        hash: fn.hash,
        start: fn.start,
        end: fn.end,
        lines: fn.lines,
        __fromFile: filePath,
      });
    }
  }
  return { fns, meta: {
    saved_at: raw.saved_at,
    source_index: raw.source_index,
    total_functions: raw.total_functions,
    sources: raw.sources || [],
  }};
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

/**
 * --save-fingerprints: compute fingerprints on the current index and write
 * them to a portable JSON file. No source code is saved; only fingerprints
 * + metadata. Usable later with --load-fingerprints against any other
 * index.
 */
export function doSaveFingerprints(index, args) {
  const outPath = args.save_fingerprints;
  const minTokens = args.fingerprint_min_tokens != null
    ? parseInt(args.fingerprint_min_tokens) : 6;

  const MAX_TOKENS = 5000; // strip oversized entries (CUDA blobs, binary data)

  console.log(`Computing fingerprints (min-tokens=${minTokens})...`);
  const { fns: rawFns } = computeAllFingerprints(index, { minTokens });
  console.log(`  ${rawFns.length} functions have fingerprints with ≥${minTokens} tokens`);

  // Strip oversized entries — these are typically binary/GPU blobs that
  // leaked through the indexer (CUDA .so/.dll files, shader code, etc.)
  // and produce multi-MB fingerprints that bloat the file and slow matching.
  const oversized = rawFns.filter(f => f.fingerprint.size > MAX_TOKENS);
  const fns = rawFns.filter(f => f.fingerprint.size <= MAX_TOKENS);
  if (oversized.length > 0) {
    console.log(`  stripped ${oversized.length} oversized entries (>${MAX_TOKENS} tokens):`);
    for (const f of oversized.slice(0, 5)) {
      console.log(`    ${f.name} (${f.fingerprint.size} tokens)`);
    }
    if (oversized.length > 5) console.log(`    ... and ${oversized.length - 5} more`);
  }

  if (fns.length === 0) {
    console.log('No fingerprints to save.');
    return;
  }

  saveFingerprints(fns, outPath, index.indexPath, minTokens);
  const sz = fs.statSync(outPath).size;
  console.log(`Saved ${fns.length} fingerprints to ${outPath} (${(sz / 1024 / 1024).toFixed(1)} MB)`);
  const distinctFiles = new Set(fns.map(f => f.filepath)).size;
  const distinctSources = new Set(fns.map(f => f.source)).size;
  console.log(`  spanning ${distinctFiles} files across ${distinctSources} sources`);
}

/**
 * Load multiple fingerprint files (accepts a single path string or an array)
 * and return the combined array of function descriptors plus provenance
 * metadata. Callers of --cmp-string-call-dupes / --build-fp-renames
 * concatenate these with their index-computed fingerprints.
 */
export function loadFingerprintsList(paths) {
  if (!paths) return { fns: [], provenance: [] };
  const pathList = Array.isArray(paths) ? paths : [paths];
  const allFns = [];
  const provenance = [];
  for (const p of pathList) {
    if (!fs.existsSync(p)) {
      console.log(`  warn: fingerprints file not found: ${p}`);
      continue;
    }
    const { fns, meta } = loadFingerprints(p);
    allFns.push(...fns);
    provenance.push({ path: p, ...meta, loaded_functions: fns.length });
    console.log(`  loaded ${fns.length} fingerprints from ${p} (saved ${meta.saved_at}, sources: ${meta.sources.join(', ')})`);
  }
  return { fns: allFns, provenance };
}
