/**
 * vocabulary.js — TF-IDF-style vocabulary discovery for indexed source code.
 * Pulled out of `CodeSearchIndex.js` in Issue #18 Phase 2 (theme #24).
 *
 * Producer/consumer flow:
 *   ensureVocabulary(idx)             — build + cache the vocab Map (or load from cache).
 *   getTopVocabulary(idx)             — top-N tokens, optionally filter-narrowed.
 *   getVocabularyForPrompt(idx)       — structured sub-tokens + function names for LLM prompts.
 *   formatVocabularyForPrompt(idx)    — render the above as compact/rich text.
 *
 * Cache lives at `<indexPath>/vocabulary.json`; per-idx memoization on
 * `idx._vocabulary` so subsequent calls in the same process skip the rebuild.
 *
 * Cross-module deps: pulls `STRUCTURE_KEYWORDS` from `./structural-fingerprint.js`
 * and `_computeTokenRelevance` from `./CSI-helpers.js`. `splitCompoundToken`,
 * `LOW_DISCRIMINATION_STOPWORDS`, and `TEXT_EXTENSIONS` come from the same
 * places CSI.js imports them from.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TEXT_EXTENSIONS, splitCompoundToken } from '../utils.js';
import { LOW_DISCRIMINATION_STOPWORDS } from '../commands/claim.js';
import { STRUCTURE_KEYWORDS } from './structural-fingerprint.js';
import { _computeTokenRelevance, isMinified } from './CSI-helpers.js';
import { makeFilterMatcher } from './filter-match.js';


/**
 * #172: corpus-shape noise that swamps TF-IDF and buries domain terms —
 * excluded from the vocabulary corpus (the files stay indexed and searchable).
 * Mirrors the Infrastructure detector's skip (#168): vendored/dependency
 * trees, `.op` binstring decompile dumps, and minified bundles. Path-based
 * where possible; minified needs the content.
 */
const _VENDOR_RE = /(^|\/)(node_modules|site-packages|vendor|bower_components|\.venv|dist|build)\//i;
const _BUILD_OUT_RE = /(^|\/)(bin\/(debug|release)|obj)\//i;  // .NET build output: dlls + generated XML docs
const _LOCKFILE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|gemfile\.lock|poetry\.lock|cargo\.lock)$/i;
// #172 residual (a): test/example/fixture trees — their hashes, certs, and
// sample data are corpus-shape noise, not domain vocabulary. Segment-anchored
// so `mytest/` / `latest/` are NOT matched.
const _TEST_RE = /(^|\/)(tests?|__tests__|specs?|examples?|fixtures?|k6)\//i;
export function _isNoiseDoc(fp, content) {
  const norm = String(fp).replace(/\\/g, '/');
  if (_VENDOR_RE.test(norm)) return true;        // vendored / generated trees
  if (_BUILD_OUT_RE.test(norm)) return true;     // bin/Debug, bin/Release, obj — build output
  if (_LOCKFILE_RE.test(norm)) return true;      // dependency lockfiles (integrity-hash soup)
  if (_TEST_RE.test(norm)) return true;          // test/example/fixture trees (corpus-shape, not domain)
  if (/\.op$/i.test(norm)) return true;          // binstring / decompile dumps
  if (/\.nupkg!/i.test(norm)) return true;        // NuGet package-archive contents (vendored)
  if (content != null && isMinified(fp, content)) return true;  // minified bundles
  return false;
}


/**
 * Universal programming stopwords - tokens too generic to be "vocabulary".
 * Combined with STRUCTURE_KEYWORDS and dynamic >60% frequency cutoff.
 *
 * Module-private — only consumed by `_buildVocabularyFromDocs` below. Not
 * re-exported because no callsite outside this module references it
 * (the original `CodeSearchIndex.PROGRAMMING_STOPWORDS` access pattern was
 * itself a same-class read).
 */
const PROGRAMMING_STOPWORDS = new Set([
  // C standard library
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'sscanf',
  'malloc', 'calloc', 'realloc', 'free',
  'memcpy', 'memset', 'memmove', 'memcmp',
  'strlen', 'strcpy', 'strncpy', 'strcat', 'strcmp', 'strncmp', 'strstr',
  'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs', 'fflush', 'fseek',
  'atoi', 'atof', 'atol', 'strtol', 'strtoul', 'strtod',
  'exit', 'abort', 'atexit',
  'stdin', 'stdout', 'stderr', 'errno', 'NULL',
  'argc', 'argv', 'envp',
  'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
  'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'bool', 'char', 'short', 'long', 'float', 'double',
  'unsigned', 'signed', 'void', 'auto', 'register',
  // C++ common
  'std', 'string', 'vector', 'map', 'set', 'list', 'pair', 'tuple',
  'begin', 'end', 'size', 'empty', 'push_back', 'emplace_back',
  'iterator', 'const_iterator', 'reverse_iterator',
  'make_shared', 'make_unique', 'shared_ptr', 'unique_ptr', 'weak_ptr',
  'move', 'forward', 'swap',
  'cout', 'cin', 'cerr', 'endl',
  'dynamic_cast', 'static_cast', 'reinterpret_cast', 'const_cast',
  'nullptr', 'noexcept', 'constexpr', 'decltype',
  'ASSERT', 'DCHECK', 'CHECK', 'DCHECK_EQ', 'DCHECK_NE',
  'DCHECK_LT', 'DCHECK_GT', 'DCHECK_LE', 'DCHECK_GE',
  'NOTREACHED', 'DISALLOW_COPY_AND_ASSIGN',
  // Java/C# common
  'String', 'Integer', 'Boolean', 'Object', 'Class',
  'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'TreeMap',
  'toString', 'equals', 'hashCode', 'compareTo', 'clone',
  'Exception', 'RuntimeException', 'IOException', 'NullPointerException',
  'Override', 'Deprecated', 'SuppressWarnings',
  'System', 'println', 'print',
  'main', 'args', 'self', 'this', 'super', 'cls',
  // Python common
  'None', 'True', 'False',
  'print', 'len', 'range', 'enumerate', 'zip', 'sorted', 'reversed',
  'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr', 'delattr',
  'dict', 'list', 'tuple', 'set', 'frozenset', 'str', 'int', 'float',
  'open', 'close', 'read', 'write', 'readline', 'readlines',
  'append', 'extend', 'insert', 'remove', 'pop', 'clear',
  'keys', 'values', 'items', 'get', 'update',
  'join', 'split', 'strip', 'replace', 'find', 'startswith', 'endswith',
  'format', 'encode', 'decode',
  '__init__', '__str__', '__repr__', '__len__', '__getitem__', '__setitem__',
  '__enter__', '__exit__', '__call__', '__iter__', '__next__',
  // JavaScript/TypeScript common
  'undefined', 'NaN', 'Infinity',
  'console', 'log', 'warn', 'error', 'info', 'debug',
  'require', 'module', 'exports', 'default',
  'document', 'window', 'global', 'process',
  'prototype', 'constructor', 'apply', 'call', 'bind',
  'then', 'catch', 'finally', 'resolve', 'reject',
  'Promise', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'JSON', 'parse', 'stringify',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'addEventListener', 'removeEventListener',
  'createElement', 'getElementById', 'querySelector', 'querySelectorAll',
  'forEach', 'filter', 'reduce', 'some', 'every', 'includes',
  'push', 'shift', 'unshift', 'slice', 'splice', 'concat',
  'length', 'indexOf', 'lastIndexOf',
  // General programming
  'init', 'setup', 'cleanup', 'destroy', 'dispose', 'reset',
  'create', 'delete', 'add', 'remove', 'insert', 'update',
  'start', 'stop', 'run', 'execute', 'invoke',
  'name', 'value', 'key', 'index', 'count', 'result', 'data',
  'type', 'kind', 'mode', 'state', 'status', 'flag', 'level',
  'buf', 'buffer', 'tmp', 'temp', 'ret', 'err', 'msg',
  'param', 'params', 'config', 'options', 'opts', 'settings',
  'input', 'output', 'src', 'dst', 'source', 'dest', 'target',
  'path', 'file', 'dir', 'filename', 'filepath',
  'test', 'spec', 'mock', 'stub', 'fixture', 'expect', 'assert',
  'TODO', 'FIXME', 'HACK', 'XXX', 'NOTE',
  // ----------------------------------------------------------------
  // Cross-corpus generic noise (#172 follow-on stopgap). Each below was
  // observed as TOP-RANKED noise across >=2 *different-domain* corpora
  // (cli.js / sr_gh / langchain / transformers / notepad++), so it is generic
  // rather than domain vocabulary. This is deliberately a whack-a-mole
  // band-aid; #180 (cross-corpus IDF down-weighting) is the principled fix and
  // can peel any of these back if a corpus uses one as genuine terminology.
  // JS runtime internals
  'function', 'defineProperty', 'defineProperties', 'hasOwnProperty',
  'getOwnPropertyDescriptor', 'getPrototypeOf', 'setPrototypeOf', '__esModule',
  'Symbol', 'Reflect', 'Proxy',
  // Python builtins / exceptions / typing
  'ValueError', 'TypeError', 'KeyError', 'AttributeError', 'RuntimeError',
  'NotImplementedError', 'ImportError', 'StopIteration', 'IndexError', 'OSError',
  'classmethod', 'staticmethod', 'property', 'kwargs',
  'annotations', '__future__', '__name__', '__main__', 'Optional', 'typing',
  // License-header boilerplate (Apache / GPL / MIT)
  'license', 'licenses', 'limitations', 'warranty', 'conditions',
  'redistribute', 'copyright', 'applicable', 'compliance', 'affiliates',
  'governing', 'sublicense', 'merchantability', 'noninfringement',
  // BSD / X11 / MIT header boilerplate — surfaced by the #180 spinellis test
  // (old-Unix C is ~all license headers). Never domain vocabulary in any corpus,
  // so an exact stoplist is the right tool; cross-corpus IDF (#180) can't reach
  // them because license text is license-correlated, not cross-corpus-shared.
  // Matching is exact-case (see `stopwords.has(token)` below), so both the
  // capitalized (header / sentence start) and lowercase (mid-clause) forms are
  // listed. Generic English license words (permission, provided, following,
  // modification, reserved, …) and ambiguous place / project names (Berkeley,
  // California, NetBSD, XFree86) are deliberately left to #180's demote rather
  // than hard-deleted in every corpus.
  'redistribution', 'Redistribution', 'redistributions', 'Redistributions',
  'Redistribute', 'redistributed', 'disclaimer', 'Disclaimer', 'disclaimers',
  'endorse', 'endorsed', 'endorsement', 'acknowledgement', 'Acknowledgement',
  'acknowledgment', 'acknowledgments', 'acknowledgements', 'pertaining',
  'publicity', 'dealings', 'suitability', 'uninterrupted', 'mentioning',
  'advertising', 'consortium', 'Consortium', 'XConsortium', 'Regents',
  'Copyright', 'copyrights', 'copyrighted', 'contributors', 'Contributors',
  // Docstring structure / prose
  'Returns', 'Args', 'Raises', 'Example', 'description', 'parameters', 'arguments',
  'true', 'false', 'null', 'nil',
  // Very short identifiers (covered by minLength=3 filter mostly)
  'fn', 'cb', 'el', 'ev', 'ex', 'id', 'it', 'ok', 'op',
]);

/** Path to vocabulary cache file. */
export function _vocabularyPath(idx) {
  return path.join(idx.indexPath, 'vocabulary.json');
}

// ----------------------------------------------------------------
// #180: cross-corpus down-weighting. A token in MANY indexes (function, the,
// get, main, error, …) is corpus-universal noise, not domain vocabulary — but a
// static stopword list can't tell "universal" from "this corpus's real domain
// term." The catalog records, per token, how many indexes contain it; scoring
// multiplies each token's per-index TF-IDF by a cross-corpus weight that
// *demotes* (never deletes) universal terms — so a term still surfaces if it
// genuinely dominates one corpus, which lets us peel back the hand-added #172
// stopwords over time. Ships as CE_cross_corpus_vocab_catalog.json at the CE
// root; absent → no-op (scoring is identical to before).
// ----------------------------------------------------------------
const _CE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const _XCORPUS_CATALOG_PATH = path.join(_CE_ROOT, 'CE_cross_corpus_vocab_catalog.json');
let _xcorpusCatalogCache; // undefined = unloaded; null = absent/invalid

function _loadCrossCorpusCatalog() {
  if (_xcorpusCatalogCache !== undefined) return _xcorpusCatalogCache;
  _xcorpusCatalogCache = null;
  try {
    if (fs.existsSync(_XCORPUS_CATALOG_PATH)) {
      const j = JSON.parse(fs.readFileSync(_XCORPUS_CATALOG_PATH, 'utf-8'));
      if (j && j.tokens && j.index_count > 1) _xcorpusCatalogCache = j;
    }
  } catch { /* absent / unreadable → no-op */ }
  return _xcorpusCatalogCache;
}

/**
 * Cross-corpus weight in [0.1, 1]: ~1 for distinctive tokens, approaching 0.1
 * for a token present in (nearly) every index. Tokens in <2 indexes are never
 * penalized. The 0.1 floor keeps this a demote, never a delete.
 * @param {string} token
 * @param {{index_count:number, tokens:Object}|null} catalog
 */
export function _crossCorpusWeight(token, catalog) {
  if (!catalog) return 1;
  const df = catalog.tokens[token] || 0;
  if (df < 2) return 1;
  const w = Math.log2(catalog.index_count / df) / Math.log2(catalog.index_count);
  return Math.max(0.1, Math.min(1, w));
}

/**
 * #180: build a cross-corpus catalog by tallying, across the given index
 * directories' existing `vocabulary.json` caches, how many indexes each token
 * appears in. Tokens in <2 indexes are dropped (no down-weight value, pure
 * bloat). Dirs without a readable `vocabulary.json` are skipped.
 * @param {string[]} indexDirs
 * @returns {{index_count:number, generated_from:number, skipped:number, tokens:Object}}
 */
export function buildCrossCorpusCatalog(indexDirs) {
  const counts = Object.create(null);
  let used = 0;
  let skipped = 0;
  for (const dir of indexDirs) {
    const vp = path.join(dir, 'vocabulary.json');
    if (!fs.existsSync(vp)) { skipped++; continue; }
    let toks;
    try { toks = Object.keys(JSON.parse(fs.readFileSync(vp, 'utf-8')).tokens || {}); }
    catch { skipped++; continue; }
    used++;
    for (const t of toks) counts[t] = (counts[t] || 0) + 1;
  }
  const tokens = Object.create(null);
  for (const t of Object.keys(counts)) if (counts[t] >= 2) tokens[t] = counts[t];
  return { index_count: used, generated_from: indexDirs.length, skipped, tokens };
}

/**
 * Build vocabulary index: per-token document frequency, total count,
 * and top representative files.
 *
 * Caches to vocabulary.json (global only; filtered queries are not cached).
 *
 * @param {boolean} showProgress
 * @param {string|null} pathFilter - if provided, only scan files whose path contains this string
 * @returns Map: token -> { doc_freq, total_count, score, top_files: [{path, count, concentration}] }
 */
export function ensureVocabulary(idx, showProgress = true, pathFilter = null) {
  // Global (unfiltered) vocabulary uses cache
  if (!pathFilter) {
    if (idx._vocabulary) return idx._vocabulary;

    const cachePath = _vocabularyPath(idx);

    // Try cache
    if (fs.existsSync(cachePath)) {
      try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const cached = JSON.parse(raw);
        const cachedTokenCount = Object.keys(cached.tokens || {}).length;
        if (cached._version === 7 && cached._file_count === idx.files.size && cachedTokenCount > 0) {
          idx._vocabulary = new Map();
          for (const [token, entry] of Object.entries(cached.tokens || {})) {
            idx._vocabulary.set(token, entry);
          }
          if (showProgress) console.log(`Loaded ${idx._vocabulary.size} cached vocabulary tokens`);
          return idx._vocabulary;
        }
        // An empty cached vocabulary is worth nothing -- e.g. a single-file
        // index cached before the per-function fallback existed. Treat it as
        // a miss so the rebuild (and the fallback) can run.
        if (showProgress) {
          console.log(cachedTokenCount === 0
            ? 'Vocabulary cache is empty, recomputing...'
            : 'Vocabulary cache stale, rebuilding...');
        }
      } catch (e) {
        if (showProgress) console.log(`Vocabulary cache load failed, recomputing: ${e.message}`);
      }
    }
  }

  // Determine which files to scan
  let fileEntries = [...idx.files.entries()];
  if (pathFilter) {
    const pat = pathFilter.toLowerCase();
    fileEntries = fileEntries.filter(([fp]) => fp.toLowerCase().includes(pat));
    if (fileEntries.length === 0) {
      if (showProgress) console.log(`No files matching '${pathFilter}' found.`);
      return new Map();
    }
  }

  const totalFiles = fileEntries.length;
  if (totalFiles === 0) {
    if (!pathFilter) idx._vocabulary = new Map();
    return new Map();
  }

  const label = pathFilter ? `${totalFiles} files matching '${pathFilter}'` : `${totalFiles} files`;
  if (showProgress) console.log(`Building vocabulary index for ${label}...`);

  let vocabulary = _buildVocabularyFromDocs(idx, fileEntries, totalFiles, showProgress, {
    skipDoc: (fp, content) => {
      const ext = path.extname(fp).toLowerCase();
      // .xml is markup (and the source of generated .NET API-doc noise, #172) —
      // skip it like the other prose/markup doc types in TEXT_EXTENSIONS.
      return TEXT_EXTENSIONS.has(ext) || ext === '.xml' || _isNoiseDoc(fp, content);
    },
    tokenCountOf: (fp) => {
      const fl = idx.fileLines.get(fp);
      return fl ? fl.length : 100;
    },
  });

  // Automatic fallback: a single-file (or otherwise tiny) corpus collapses
  // cross-document TF-IDF -- every token has doc_freq 1 and IDF log2(1/1) = 0
  // -- so file mode yields an empty vocabulary. Recompute treating each
  // indexed function body as its own document, restoring a meaningful
  // doc_freq. File mode stays the default; this only fires when it failed.
  if (vocabulary.size === 0) {
    const { entries: funcEntries, lineCounts } = _functionVocabDocs(idx, pathFilter);
    if (funcEntries.length > 0) {
      if (showProgress) {
        console.log(`  File-mode vocabulary is empty (corpus is ${totalFiles} ` +
          `file${totalFiles === 1 ? '' : 's'}); rebuilding from ${funcEntries.length} ` +
          `function bodies as documents...`);
      }
      vocabulary = _buildVocabularyFromDocs(idx, funcEntries, funcEntries.length, showProgress, {
        skipDoc: () => false,
        tokenCountOf: (id) => lineCounts.get(id) || 100,
      });
    }
  }

  // Cache global vocabulary only
  if (!pathFilter) {
    idx._vocabulary = vocabulary;
    const cachePath = _vocabularyPath(idx);
    try {
      const cacheObj = {
        _version: 7,
        _file_count: idx.files.size,
        _generated: new Date().toISOString(),
        tokens: {},
      };
      const sorted = [...vocabulary.entries()].sort((a, b) => b[1].score - a[1].score);
      for (const [token, entry] of sorted.slice(0, 15000)) {
        cacheObj.tokens[token] = entry;
      }
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify(cacheObj, null, 1));
      if (showProgress) console.log(`  Saved vocabulary cache to ${path.basename(cachePath)}`);
    } catch (e) {
      if (showProgress) console.log(`  Warning: could not save vocabulary cache: ${e.message}`);
    }
  }

  return vocabulary;
}

/**
 * Build per-function "documents" for vocabulary discovery: each indexed
 * function body is one document. Used as the fallback corpus when the
 * file-level corpus is too small for cross-file TF-IDF to mean anything
 * (a lone bundled file, etc. -- see ensureVocabulary).
 *
 * @param {string|null} [pathFilter] - when set, only functions whose
 *        filepath contains this substring (case-insensitive) are included.
 * @returns {{ entries: Array<[string, string]>, lineCounts: Map<string, number> }}
 */
export function _functionVocabDocs(idx, pathFilter = null) {
  idx._ensureFunctionIndex();
  const entries = [];
  const lineCounts = new Map();
  const pat = pathFilter ? pathFilter.toLowerCase() : null;

  for (const [filepath, funcs] of Object.entries(idx.functionIndex || {})) {
    if (pat && !filepath.toLowerCase().includes(pat)) continue;
    const fileLines = idx.fileLines.get(filepath);
    if (!fileLines) continue;
    for (const [funcName, info] of Object.entries(funcs)) {
      if (!info || info.start == null || info.end == null) continue;
      const body = fileLines.slice(info.start - 1, info.end);
      if (body.length === 0) continue;
      const id = `${filepath}|||${funcName}`;
      entries.push([id, body.join('\n')]);
      lineCounts.set(id, body.length);
    }
  }
  return { entries, lineCounts };
}

/**
 * Core two-pass vocabulary builder. Document-agnostic: a "document" is a
 * `(docId, content)` pair -- normally a file, but a single function body
 * when ensureVocabulary falls back to per-function mode for a corpus too
 * small for cross-file TF-IDF to mean anything.
 *
 * @param {Array<[string, string]>} docEntries - [docId, content] pairs
 * @param {number} totalDocs - document count; the IDF denominator
 * @param {boolean} showProgress
 * @param {object} [opts]
 * @param {(docId: string) => boolean} [opts.skipDoc] - skip a document entirely
 * @param {(docId: string) => number} [opts.tokenCountOf] - document size, used
 *        for the top-document concentration metric
 * @returns {Map}
 */
export function _buildVocabularyFromDocs(idx, docEntries, totalDocs, showProgress, opts = {}) {
  const skipDoc = opts.skipDoc || (() => false);
  const tokenCountOf = opts.tokenCountOf || (() => 100);
  const kw = STRUCTURE_KEYWORDS;
  const stopwords = PROGRAMMING_STOPWORDS;
  const minTokenLen = 3;
  const maxTokenLen = 200;  // skip absurdly long tokens (concatenated strings, etc.)

  const identRe = /[A-Za-z_]\w*/g;

  // NOTE: We intentionally tokenize comments and string literals.
  // Domain-specific vocabulary frequently appears in JSDoc, docstrings,
  // SQL strings, error messages, etc.  The stopword filter and frequency
  // cutoffs handle generic words like "the", "return", etc.

  // ----------------------------------------------------------------
  // Pass 1: Count doc_freq and total_count ONLY
  // ----------------------------------------------------------------
  const tokenStats = Object.create(null);
  let docNum = 0;

  for (const [docId, content] of docEntries) {
    docNum++;
    if (showProgress && docNum % 2000 === 0) {
      process.stdout.write(`  Pass 1: scanning ${docNum} / ${totalDocs} documents...\r`);
    }

    if (skipDoc(docId, content)) continue;

    const text = content;
    const seenInDoc = new Set();
    let m;
    identRe.lastIndex = 0;

    while ((m = identRe.exec(text)) !== null) {
      const token = m[0];
      if (token.length < minTokenLen) continue;
      if (token.length > maxTokenLen) continue;
      if (kw.has(token)) continue;
      if (stopwords.has(token)) continue;
      if (token.length >= 4 && /^[A-Z][A-Z_0-9]+$/.test(token)) continue;

      if (!tokenStats[token]) {
        tokenStats[token] = { doc_freq: 0, total_count: 0 };
      }
      tokenStats[token].total_count++;

      if (!seenInDoc.has(token)) {
        seenInDoc.add(token);
        tokenStats[token].doc_freq++;
      }
    }
  }

  if (showProgress) {
    process.stdout.write(`  Pass 1: scanned ${totalDocs} documents.                    \n`);
  }

  // Score and filter
  const freqCutoff = Math.max(5, Math.floor(totalDocs * 0.6));
  const minDocFreq = 2;

  const scored = [];
  const allTokenCount = Object.keys(tokenStats).length;
  const _xcorpus = _loadCrossCorpusCatalog(); // #180: null → no penalty

  for (const token of Object.keys(tokenStats)) {
    const stats = tokenStats[token];
    if (stats.doc_freq < minDocFreq) continue;
    if (stats.doc_freq > freqCutoff) continue;

    const idf = Math.log2(totalDocs / stats.doc_freq);
    const lengthBoost = Math.pow(token.length, 0.75);

    const parts = token
      .split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|_/)
      .filter(p => p.length > 0).length;
    const compoundBonus = Math.min(1 + 0.3 * (parts - 1), 2.5);

    const score = stats.doc_freq * idf * lengthBoost * compoundBonus
      * _crossCorpusWeight(token, _xcorpus); // #180: demote corpus-universal terms

    scored.push({
      token,
      doc_freq: stats.doc_freq,
      total_count: stats.total_count,
      score: Math.round(score * 100) / 100,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const topN = 5000;
  const topTokenSet = new Set(scored.slice(0, topN).map(e => e.token));

  if (showProgress) {
    console.log(`  ${scored.length} vocabulary tokens (${allTokenCount} unique, ` +
      `${allTokenCount - scored.length} filtered by frequency/length)`);
  }

  // Free Pass 1 data
  for (const key of Object.keys(tokenStats)) {
    delete tokenStats[key];
  }

  // ----------------------------------------------------------------
  // Pass 2: Representative documents for top tokens only
  // ----------------------------------------------------------------
  if (showProgress && topTokenSet.size > 0) {
    process.stdout.write(`  Pass 2: finding representative documents for top ${topTokenSet.size} tokens...\r`);
  }

  const docCountsForTop = Object.create(null);
  for (const t of topTokenSet) {
    docCountsForTop[t] = Object.create(null);
  }

  docNum = 0;
  for (const [docId, content] of docEntries) {
    docNum++;
    if (showProgress && docNum % 5000 === 0) {
      process.stdout.write(`  Pass 2: scanning ${docNum} / ${totalDocs} documents...\r`);
    }

    if (skipDoc(docId, content)) continue;

    const text = content;
    let m;
    identRe.lastIndex = 0;

    while ((m = identRe.exec(text)) !== null) {
      const token = m[0];
      if (!topTokenSet.has(token)) continue;

      if (!docCountsForTop[token][docId]) {
        docCountsForTop[token][docId] = 0;
      }
      docCountsForTop[token][docId]++;
    }
  }

  if (showProgress) {
    process.stdout.write(`  Pass 2: scanned ${totalDocs} documents.                    \n`);
  }

  // Build final vocabulary map. The `top_files` field keeps its name for
  // cache / consumer compatibility; in per-function mode each entry's
  // `path` holds a `filepath|||funcName` document id rather than a filepath.
  const vocabulary = new Map();

  for (const entry of scored.slice(0, topN)) {
    const dc = docCountsForTop[entry.token] || {};
    const docPairs = Object.entries(dc)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const topDocs = docPairs.map(([docId, count]) => ({
      path: docId,
      count,
      concentration: count / (tokenCountOf(docId) || 100),
    }));

    vocabulary.set(entry.token, {
      doc_freq: entry.doc_freq,
      total_count: entry.total_count,
      score: entry.score,
      top_files: topDocs,
    });
  }

  // Remaining scored tokens without top_files
  for (const entry of scored.slice(topN)) {
    vocabulary.set(entry.token, {
      doc_freq: entry.doc_freq,
      total_count: entry.total_count,
      score: entry.score,
      top_files: [],
    });
  }

  return vocabulary;
}

/**
 * Get top vocabulary tokens sorted by score, optionally filtered.
 *
 * @param {number} n - max results
 * @param {string|null} filter - substring filter on token name
 * @param {string|null} pathFilter - only scan files whose path contains this string
 * @returns {Array<{ token, doc_freq, total_count, score, top_files }>}
 */
export function getTopVocabulary(idx, n = 50, filter = null, pathFilter = null) {
  const vocab = pathFilter
    ? ensureVocabulary(idx, true, pathFilter)
    : ensureVocabulary(idx);
  let entries = [...vocab.entries()].map(([token, data]) => ({ token, ...data }));

  if (filter) {
    const match = makeFilterMatcher(filter);
    entries = entries.filter(e => match(e.token));
  }

  entries.sort((a, b) => b.score - a.score);
  return entries.slice(0, n);
}


/**
 * Build a vocabulary concordance for LLM prompts.
 *
 * Takes top vocabulary tokens, splits compound names into sub-tokens,
 * deduplicates and scores them, then formats for inclusion in an LLM
 * prompt as a domain concordance.
 *
 * When claimKeywords are provided, vocabulary is filtered to only include
 * terms with surface-level relevance to the claim - exact matches,
 * substring containment, or shared stems. This prevents sending the LLM
 * 150 irrelevant terms about 'multisect' when the claim is about
 * 'facade servers'.
 *
 * Two tiers:
 *   Tier 1 (subTokens): Unique domain sub-tokens extracted from compound
 *     names (e.g., 'multisect', 'hotspot', 'callee', 'sanitize').
 *     For BROAD term generation - these are actual searchable words.
 *   Tier 2 (functionNames): Key function/method names showing what the
 *     codebase implements (e.g., 'doClaimAnalyze', 'findCallees').
 *     For understanding code capabilities.
 *
 * @param {object} opts
 * @param {number} [opts.topN=300]            - How many top vocab entries to process
 * @param {number} [opts.maxSubTokens=150]    - Max unique sub-tokens to return
 * @param {number} [opts.maxFuncNames=40]     - Max function names to return
 * @param {string|null} [opts.pathFilter]     - Only scan files matching this path
 * @param {Set<string>|null} [opts.claimKeywords] - Claim keywords for relevance filtering
 * @returns {{ subTokens: Array<{token, score, relevance, parentCount, exampleParents}>,
 *             functionNames: Array<{name, file, score, relevance}>,
 *             stats: {totalVocab, processedEntries, uniqueSubTokens, claimFiltered} }}
 */
export function getVocabularyForPrompt(idx, opts = {}) {
  const {
    topN = 300,
    maxSubTokens = 150,
    maxFuncNames = 40,
    pathFilter = null,
    claimKeywords = null,
  } = opts;

  const topEntries = getTopVocabulary(idx, topN, null, pathFilter);

  // --- Tier 1: Split compound tokens into sub-tokens ---
  // Track each sub-token's aggregate score and which parents it came from
  const subTokenMap = new Map();  // subtoken -> { score, parentCount, exampleParents }

  for (const entry of topEntries) {
    const parts = splitCompoundToken(entry.token);
    for (const part of parts) {
      // Skip low-discrimination bare nouns the extraction prompt already
      // tells the LLM to ignore (issue #2 item 5). Lowercased compare so
      // 'Name' and 'name' both filter.
      if (LOW_DISCRIMINATION_STOPWORDS.has(part.toLowerCase())) continue;
      if (!subTokenMap.has(part)) {
        subTokenMap.set(part, {
          score: 0,
          parentCount: 0,
          exampleParents: [],
        });
      }
      const st = subTokenMap.get(part);
      st.score += entry.score;
      st.parentCount++;
      if (st.exampleParents.length < 3) {
        st.exampleParents.push(entry.token);
      }
    }
  }

  // --- Claim-aware relevance scoring ---
  // When claim keywords are provided, score each sub-token by how well
  // it matches claim concepts. Unrelated terms get relevance 0.
  let subTokensSorted;
  const claimFiltered = !!(claimKeywords && claimKeywords.size > 0);

  if (claimFiltered) {
    const kwArray = [...claimKeywords];  // for iteration

    const scored = [...subTokenMap.entries()].map(([token, data]) => {
      const relevance = _computeTokenRelevance(token, kwArray);
      return { token, ...data, relevance };
    });

    // Keep only tokens with some relevance to the claim
    const relevant = scored.filter(st => st.relevance > 0);

    // Sort by relevance first, then by vocab score as tiebreaker
    relevant.sort((a, b) => {
      const rDiff = b.relevance - a.relevance;
      if (Math.abs(rDiff) > 0.01) return rDiff;
      return b.score - a.score;
    });

    subTokensSorted = relevant.slice(0, maxSubTokens);
  } else {
    // No claim keywords - return all sub-tokens by vocab score (original behavior)
    subTokensSorted = [...subTokenMap.entries()]
      .map(([token, data]) => ({ token, ...data, relevance: 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSubTokens);
  }

  // --- Tier 2: Function names ---
  // Filter to entries that look like function/method names
  const funcNameEntries = topEntries.filter(e => {
    const t = e.token;
    if (/^[a-z]+[A-Z]/.test(t)) return true;   // camelCase
    if (/^do[A-Z]/.test(t)) return true;         // doSomething
    if (/^(build|parse|find|extract|resolve|sanitize|display|print|ensure|load|run|search|handle)[A-Z_]/.test(t)) return true;
    return false;
  });

  let functionNames;
  if (claimFiltered) {
    // Score function names by whether their sub-tokens overlap with claim
    const kwArray = [...claimKeywords];
    const scoredFuncs = funcNameEntries.map(e => {
      const parts = splitCompoundToken(e.token);
      let maxRel = 0;
      for (const part of parts) {
        const rel = _computeTokenRelevance(part, kwArray);
        if (rel > maxRel) maxRel = rel;
      }
      return {
        name: e.token,
        file: (e.top_files && e.top_files[0]) ? e.top_files[0].path : '',
        score: e.score,
        relevance: maxRel,
      };
    });

    functionNames = scoredFuncs
      .filter(fn => fn.relevance > 0)
      .sort((a, b) => b.relevance - a.relevance || b.score - a.score)
      .slice(0, maxFuncNames);
  } else {
    functionNames = funcNameEntries
      .slice(0, maxFuncNames)
      .map(e => ({
        name: e.token,
        file: (e.top_files && e.top_files[0]) ? e.top_files[0].path : '',
        score: e.score,
        relevance: 0,
      }));
  }

  // Stats for diagnostics
  const vocab = pathFilter
    ? ensureVocabulary(idx, false, pathFilter)
    : ensureVocabulary(idx, false);

  return {
    subTokens: subTokensSorted,
    functionNames,
    stats: {
      totalVocab: vocab.size,
      processedEntries: topEntries.length,
      uniqueSubTokens: subTokenMap.size,
      claimFiltered,
    },
  };
}


/**
 * Format vocabulary concordance as a compact string for LLM prompts.
 *
 * Two formats:
 *   'compact' - sub-tokens only, one per line. ~200-400 tokens.
 *               For local 7B models with tight context budgets.
 *   'rich'    - sub-tokens + function names with files. ~500-1000 tokens.
 *               For Claude or larger models.
 *
 * @param {string} [format='compact'] - 'compact' or 'rich'
 * @param {object} [opts] - Passed to getVocabularyForPrompt
 * @returns {string} Formatted concordance text
 */
export function formatVocabularyForPrompt(idx, format = 'compact', opts = {}) {
  const { subTokens, functionNames, stats } = getVocabularyForPrompt(idx, opts);

  if (subTokens.length === 0) {
    return '';  // No vocabulary available (or no claim-relevant terms found)
  }

  const filterNote = stats.claimFiltered
    ? ` - filtered to claim-relevant terms`
    : '';

  if (format === 'compact') {
    // Tier 1 only: plain token list, ~1 token per word
    const lines = subTokens.map(st => st.token);
    return `CODEBASE VOCABULARY (${lines.length} domain terms from ${stats.totalVocab} indexed${filterNote}):\n` +
      lines.join(', ');
  }

  // 'rich' format: sub-tokens with example parents + function names
  let text = `CODEBASE VOCABULARY (${subTokens.length} domain terms from ${stats.totalVocab} indexed${filterNote}):\n`;

  // Sub-tokens with example compound parents
  for (const st of subTokens.slice(0, 100)) {
    const parents = st.exampleParents.slice(0, 2).join(', ');
    text += `  ${st.token} (in: ${parents})\n`;
  }

  // Function names
  if (functionNames.length > 0) {
    text += `\nKEY FUNCTIONS (${functionNames.length} relevant functions in this codebase):\n`;
    for (const fn of functionNames) {
      const file = fn.file ? fn.file.replace(/.*[\\/]/, '') : '';
      text += `  ${fn.name}${file ? '  [' + file + ']' : ''}\n`;
    }
  }

  return text;
}
