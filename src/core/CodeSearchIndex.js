/**
 * CodeSearchIndex.js - Core data structure for Code Exam.
 *
 * Holds indexed source code and provides methods for:
 * - Building/saving/loading indices (JSON-based, compatible with Python version)
 * - Literal, inverted-index, and regex search
 * - Function/class parsing (regex-based)
 * - Function extraction and listing
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
// Simple glob implementation using built-in modules (no external deps)
import { _globSync } from '../glob.js';
import { forEachEntry, openJSONFile, closeSource, parseValue, countLocations, valueSize } from '../json-stream.js';
import {
  SearchResult, DEFAULT_EXTENSIONS, TEXT_EXTENSIONS,
  ARCHIVE_EXTENSIONS, MEDIA_BINARY_EXTENSIONS, EXECUTABLE_EXTENSIONS,
  EXT_TO_LANG, displayName, eprint, eprogress, splitCompoundToken,
} from '../utils.js';
import { expandArchive, isSupportedArchive, createArchiveStats } from '../archive.js';
import { processBinary, BINSTRING_EXTENSIONS } from '../binstrings.js';
import { LOW_DISCRIMINATION_STOPWORDS } from '../commands/claim.js';
import {
  _detectBundleHelpers, _findWrapperEnd, _parseEsbuildWrappers,
  _extractModulePreview, _detectNameHelper, _extractNameRecoveryPairs,
  _scanModuleHints,
} from './bundle-seam-detection.js';
import {
  getJsBeautify, getWebcrack, isMinified, deobfuscateSimple, tryWebcrack,
  isOpaqueName, camelToScreamingSnake, extractReadableIdents, inferAllNames,
  _IMPORT_LOCAL_BLOCKLIST,
  _scanLineState, _isInsideString, _addString,
  _classifyCommandGate,
  escapeRegex, _computeTokenRelevance,
} from './CSI-helpers.js';
import {
  _funcNameTokens, _jaccardDistance, _pathDistance, _fileExt,
} from './distance-helpers.js';
import {
  STRUCTURE_KEYWORDS, _countCodeLines,
  getStructuralNormalized as _getStructuralNormalized,
  getStructuralHash as _getStructuralHash,
  getStructuralNormalizedTight as _getStructuralNormalizedTight,
  getStructuralHashTight as _getStructuralHashTight,
  extractWordHoles as _extractWordHoles,
  structDiff as _structDiff,
} from './structural-fingerprint.js';
import {
  getHotspots as _getHotspots,
  getEntryPoints as _getEntryPoints,
  getDomainHotspots as _getDomainHotspots,
  getClassHotspots as _getClassHotspots,
} from './hotspots.js';
import {
  getCanonicalFuncs as _getCanonicalFuncs,
  getCopyCount as _getCopyCount,
  isCanonical as _isCanonical,
} from './canonical-funcs.js';
import {
  ensureVocabulary as _ensureVocabulary,
  getTopVocabulary as _getTopVocabulary,
  formatVocabularyForPrompt as _formatVocabularyForPrompt,
} from './vocabulary.js';
import {
  computeTermFileCounts as _computeTermFileCounts,
  multisectSearch as _multisectSearch,
} from './multisect.js';
import {
  extractBreadcrumbs as _extractBreadcrumbs,
  extractCommandCatalog as _extractCommandCatalog,
} from './breadcrumbs-commands.js';
import {
  findCallers as _findCallers,
  findCallees as _findCallees,
  getCallInventory as _getCallInventory,
  getCallCounts as _getCallCounts,
  findDefinitions as _findDefinitions,
  getCallCountsWithDefinitions as _getCallCountsWithDefinitions,
  getAllFileDeps as _getAllFileDeps,
} from './calls.js';
import {
  applyRenames as _applyRenames,
  _renderLinesWithRenames as __renderLinesWithRenames,
  getDisplayName as _getDisplayName,
  getOriginalName as _getOriginalName,
  reverseRenames as _reverseRenames,
  findOriginalsByDisplayPattern as _findOriginalsByDisplayPattern,
  inferAndSaveRenameMap as _inferAndSaveRenameMap,
} from './rename.js';

// Free-function helpers and module-state moved to ./CSI-helpers.js
// (Issue #18, Phase 1 peel 2). Imported at the top of this file.

/**
 * Directories to always skip during directory walks.
 * These contain third-party, build, or infrastructure files
 * that are never project source code.
 */
const _SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.svn', '.hg',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'dist', 'build', '.next', '.nuxt',
  'vendor', 'venv', '.venv', 'env',
  'coverage', '.nyc_output',
  '.idea', '.vscode',
]);


export class CodeSearchIndex {

  static DEFAULT_EXTENSIONS = DEFAULT_EXTENSIONS;
  static TEXT_EXTENSIONS = TEXT_EXTENSIONS;

  /**
   * @param {object} opts
   * @param {string} [opts.indexPath='.code_search_index']
   * @param {Set<string>|null} [opts.extensions]
   * @param {string} [opts.embeddingModel='default']
   */
  constructor({ indexPath = '.code_search_index', extensions = null,
                embeddingModel = 'default', excludeCompound = null } = {}) {
    this.indexPath = indexPath;
    this.extensions = extensions || new Set(DEFAULT_EXTENSIONS);
    this.embeddingModel = embeddingModel;

    /** @type {Set<string>} Compound extensions to exclude (e.g., '.d.ts') */
    this._excludeCompound = excludeCompound || new Set();

    /** @type {Map<string, string>} path -> content */
    this.files = new Map();
    /** @type {Map<string, string[]>} path -> lines */
    this.fileLines = new Map();
    /** @type {Object<string, Object>} normalized_line -> [[filepath, [lineNums]], ...] */
    this.invertedIndex = null;
    /** @type {Object<string, Object>} filepath -> {funcName -> {start,end,type,base_name}} */
    this.functionIndex = null;
    /** @type {Object<string, string[]>} sha1 -> [relPaths] */
    this.fileHashes = null;
    /** @type {string|null} */
    this.basePath = null;
    /** @type {string|null} */
    this.indexSource = null;

    // Inverted index: loaded in memory or streamed on demand
    /** @type {boolean} */
    this._invertedOnDisk = false;
    /** @type {string|null} */
    this._invertedDiskPath = null;
    /** @type {number} */
    this._invertedDiskSize = 0;

    /** @type {string|null} 'regex' | 'tree-sitter' | 'tree-sitter+regex' */
    this.parseMethod = null;

    // Cache: call counts survive across commands in interactive mode
    /** @type {Object<string,number>|null} */
    this._callCountsCache = null;

    // Try to load existing index
    if (this._loadLiteralIndex()) {
      eprint(`Loaded existing index: ${this.files.size} files`);
    }
  }


  // ========================================================================
  // Persistence paths
  // ========================================================================

  _literalIndexPath()  { return path.join(this.indexPath, 'literal_index.json'); }
  _invertedIndexPath() { return path.join(this.indexPath, 'inverted_index.json'); }
  _functionIndexPath() { return path.join(this.indexPath, 'function_index.json'); }
  _funcHashesPath()    { return path.join(this.indexPath, 'func_hashes.json'); }
  _renameMapPath()     { return path.join(this.indexPath, 'rename_map.json'); }
  _stringTablePath()   { return path.join(this.indexPath, 'string_table.json'); }


  // ========================================================================
  // Rename map: apply / render (delegated to ./rename.js — Issue #18 peel 6)
  // ========================================================================
  // Persistence (_saveRenameMap / _loadRenameMap) lives in ./rename.js as
  // free functions; only the public surface needs wrappers here so existing
  // `idx.applyRenames(...)` / `idx._renderLinesWithRenames(...)` callers
  // keep working unchanged.

  applyRenames(sourceText, initialState = 'code') {
    return _applyRenames(this, sourceText, initialState);
  }

  _renderLinesWithRenames(rawLines) {
    return __renderLinesWithRenames(this, rawLines);
  }

  /**
   * Detect bundle-seam module boundaries in a JS file produced by esbuild
   * (or a similar lazy-factory bundler). See the long comment block above
   * _detectBundleHelpers for the pattern family and shape-based detection
   * rationale.
   *
   * @param {string} filepath — must be in this.fileLines
   * @param {object} [opts]
   * @param {boolean} [opts.scanHints=false] — also scan each module body for
   *   source-path and license hints (more expensive)
   * @returns {object} — { filepath, pattern, helpers, modules, error? }
   *   pattern: 'esbuild-flat' | 'esbuild-iife' | null
   *   modules: array of { name, kind: 'ESM'|'CJS', startLine, endLine,
   *                       lineCount, preview, hints? }
   */
  detectBundleSeams(filepath, { scanHints = false } = {}) {
    const lines = this.fileLines.get(filepath);
    if (!lines) return { filepath, error: 'File not in index: ' + filepath };

    const helpers = _detectBundleHelpers(lines);
    if (!helpers.esm && !helpers.cjs) {
      return { filepath, pattern: null, helpers, modules: [] };
    }

    // Build wrapper regex. Allow any arrow-arg shape: (), (x), (x, y)
    const names = [helpers.esm, helpers.cjs].filter(Boolean);
    const altNames = names
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    // Capture: (1) leading indent, (2) module var name, (3) helper name
    const wrapperRe = new RegExp(
      '^(\\s*)var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(' + altNames + ')\\s*\\(\\s*\\('
    );

    // First pass: find all wrapper start lines
    const wrappers = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const m = line.match(wrapperRe);
      if (!m) continue;
      wrappers.push({
        startLine: i + 1,
        wrapperLine: i + 1, // 1-indexed opening line of the wrapper itself
        name: m[2],
        helperName: m[3],
        indent: m[1].length,
        kind: m[3] === helpers.esm ? 'ESM' : 'CJS',
      });
    }

    // Second pass: compute TIGHT end lines via brace counting from the
    // wrapper opening `{`. State-machine-aware so string/template/comment
    // content is skipped. The sibling rule (end = next.start - 1) was wrong
    // because esbuild interleaves module-scope var decls and unrelated
    // top-level code between wrappers.
    for (const w of wrappers) {
      w.endLine = _findWrapperEnd(lines, w.startLine - 1);
    }

    // Third pass: absorb preceding top-level `var X, Y, Z;` decls into each
    // wrapper's start line. esbuild emits module-scope vars immediately
    // before the wrapper that populates them; semantically they belong to
    // that wrapper. Rule: scan backwards from wrapperLine-1 absorbing any
    // consecutive `var name(, name)*;` lines (and blank lines between) up
    // to the previous wrapper's end or a non-matching line.
    const absorbRe = /^\s*var\s+[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*;?\s*$/;
    for (let i = 0; i < wrappers.length; i++) {
      const w = wrappers[i];
      const prevEnd = i > 0 ? wrappers[i - 1].endLine : 0;
      let absorbStart = w.wrapperLine; // 1-indexed
      for (let j = w.wrapperLine - 2; j >= prevEnd; j--) {
        const line = lines[j] || '';
        if (!line.trim()) continue; // skip blank lines while looking backwards
        if (absorbRe.test(line)) {
          absorbStart = j + 1; // 1-indexed
        } else {
          break;
        }
      }
      w.startLine = absorbStart;
    }

    // Fourth pass: compute lineCount and extract previews + hints
    for (const w of wrappers) {
      w.lineCount = w.endLine - w.startLine + 1;
      w.preview = _extractModulePreview(lines, w.wrapperLine - 1, w.endLine - 1);
      if (scanHints) {
        w.hints = _scanModuleHints(lines, w.startLine - 1, w.endLine - 1);
      }
    }

    const pattern = helpers.iifeStartLine > 0 ? 'esbuild-iife' : 'esbuild-flat';

    // Compute function-position lookup once. Needed for:
    //   - per-wrapper function inventory (scanHints only)
    //   - gap-module detection for IIFE bundles (always)
    let sortedFuncs = null;
    if (scanHints || pattern === 'esbuild-iife') {
      this._ensureFunctionIndex();
      const fileFuncs = this.functionIndex && this.functionIndex[filepath];
      if (fileFuncs) {
        sortedFuncs = Object.entries(fileFuncs)
          .map(([name, info]) => ({ name, start: info.start, end: info.end, type: info.type }))
          .sort((a, b) => a.start - b.start);
      }
    }

    // Fifth pass (scanHints): per-wrapper function inventory
    if (scanHints && sortedFuncs) {
      let idx = 0;
      for (const w of wrappers) {
        while (idx < sortedFuncs.length && sortedFuncs[idx].start < w.startLine) idx++;
        const inModule = [];
        let k = idx;
        while (k < sortedFuncs.length && sortedFuncs[k].start <= w.endLine) {
          inModule.push(sortedFuncs[k]);
          k++;
        }
        w.functions = inModule;
      }
    }

    // Sixth pass (IIFE only): insert "gap modules" between wrappers.
    //
    // In esbuild's --format=iife output (e.g. mermaid.min.js), most real
    // source code lives at top-level INSIDE the outer IIFE, between the
    // wrapper scaffolds. Wrappers themselves are tiny (4-10 lines) and
    // just call `o(func, "originalName")` to assign .name properties to
    // functions declared elsewhere. The "original source file" groupings
    // correspond much more closely to the inter-wrapper gaps than to the
    // wrappers themselves.
    //
    // A gap module is created for any region between two wrappers (or
    // before-first / after-last within the outer IIFE) that contains at
    // least one function definition. Gaps without functions are skipped.
    // Gap modules are given synthetic names like `[gap@L1432]` and a
    // kind of 'GAP' (distinguishable from ESM/CJS in display).
    let modules = wrappers;
    if (pattern === 'esbuild-iife' && sortedFuncs && wrappers.length > 0) {
      const gaps = [];
      const iifeStart = helpers.iifeStartLine;
      const iifeEndApprox = lines.length; // outer IIFE closes near EOF
      let fnIdx = 0;

      // Helper: collect functions in [gapStart, gapEnd] from sortedFuncs
      const funcsInRange = (gapStart, gapEnd) => {
        // advance fnIdx past functions ending before gapStart (monotonic
        // across successive gap queries since gaps are processed in order)
        while (fnIdx < sortedFuncs.length && sortedFuncs[fnIdx].start < gapStart) fnIdx++;
        const out = [];
        let k = fnIdx;
        while (k < sortedFuncs.length && sortedFuncs[k].start <= gapEnd) {
          out.push(sortedFuncs[k]);
          k++;
        }
        return out;
      };

      const makeGap = (gapStart, gapEnd) => {
        if (gapStart > gapEnd) return null;
        const fns = funcsInRange(gapStart, gapEnd);
        if (fns.length === 0) return null;
        const gap = {
          startLine: gapStart,
          endLine: gapEnd,
          wrapperLine: gapStart,
          name: `[gap@L${gapStart}]`,
          helperName: null,
          kind: 'GAP',
          indent: 0,
          lineCount: gapEnd - gapStart + 1,
          preview: _extractModulePreview(lines, gapStart - 1, gapEnd - 1),
          functions: fns,
        };
        if (scanHints) {
          gap.hints = _scanModuleHints(lines, gapStart - 1, gapEnd - 1);
        }
        return gap;
      };

      // Gap before the first wrapper (from inside the IIFE)
      const g0 = makeGap(iifeStart + 1, wrappers[0].startLine - 1);
      if (g0) gaps.push(g0);

      // Gaps between consecutive wrappers
      for (let i = 0; i < wrappers.length - 1; i++) {
        const g = makeGap(wrappers[i].endLine + 1, wrappers[i + 1].startLine - 1);
        if (g) gaps.push(g);
      }

      // Gap after the last wrapper (to end of IIFE)
      const last = wrappers[wrappers.length - 1];
      const gN = makeGap(last.endLine + 1, iifeEndApprox);
      if (gN) gaps.push(gN);

      // Merge wrappers + gaps, sort by start line
      modules = [...wrappers, ...gaps].sort((a, b) => a.startLine - b.startLine);
    }

    return {
      filepath,
      pattern,
      helpers,
      modules,
    };
  }

  /**
   * #329 Phase 1: assemble a structured, non-AI digest of a single function
   * by pulling together signals from every CodeExam facility that can
   * mechanically describe the function's shape and content. No interpretation
   * — every field is a fact extracted from the index.
   *
   * Sections produced (empty ones are omitted at format time):
   *   - identity         — name, rename chain, location, line count, type
   *   - callers          — count + names (from findCallers)
   *   - callees          — count + names (from findCallees)
   *   - strings          — top distinctive + frequency outliers within body
   *   - breadcrumbs      — markers (q/Bq-style) emitted from body
   *   - comments         — `//` and block comments in body
   *   - commands         — extractCommandCatalog cross-reference
   *   - dupes            — exact/near/structural dupes via func_hashes
   *
   * Deferred (section stub only, pending separate TODOs):
   *   - asserts          — pending extractAsserts (TODO #337)
   *
   * @param {string} funcSpec — bare name, Class::method, or file@name
   * @param {object} [opts]
   * @param {number} [opts.maxCallers=10]     cap for caller/callee display
   * @param {number} [opts.maxCallees=10]
   * @param {number} [opts.maxStrings=15]     cap for distinctive strings section
   * @param {number} [opts.minRepeatCount=3]  threshold for "repeated string"
   * @returns {object|null} digest object, or null if function not found
   *
   * Note on "times"/counts throughout: all counts in this digest are STATIC
   * call-site counts (number of distinct source-code locations), never
   * dynamic runtime counts.
   */
  buildFunctionDigest(funcSpec, opts = {}) {
    const {
      maxCallers = 10,
      maxCallees = 10,
      maxStrings = 15,
      minRepeatCount = 3,
    } = opts;

    // --- Resolve function ---
    let pathHint = null, funcName;
    if (funcSpec.includes('@')) {
      const at = funcSpec.indexOf('@');
      pathHint = funcSpec.slice(0, at);
      funcName = funcSpec.slice(at + 1);
    } else {
      // Try reverse-rename (user typed display name)
      funcName = this.getOriginalName ? this.getOriginalName(funcSpec) : funcSpec;
    }

    const matches = this.findFunctionMatches(funcName, pathHint);
    if (matches.length === 0) return null;
    const fn = matches[0];
    const filepath = fn.filepath;
    const lines = this.fileLines.get(filepath);
    if (!lines) return null;
    const bodyLines = lines.slice(fn.start - 1, fn.end);
    const bodyText = bodyLines.join('\n');

    // --- Identity ---
    const dn = this.getDisplayName(fn.name);
    // Detect rename tier from the display name
    let renameTier = null;
    if (dn !== fn.name) {
      if (dn.includes('_CMD_')) renameTier = 'CMD';
      else if (/(?:^|::)[^_]*_NAME_[a-zA-Z]/.test(dn)) renameTier = 'NAME';
      else if (dn.includes('_IMPORT_')) renameTier = 'IMPORT';
      else if (dn.includes('_KW_')) renameTier = 'KW';
    }
    // Bare-name uniqueness check via the function index
    this._ensureFunctionIndex();
    const bareOf = (n) => {
      let b = n.includes('::') ? n.split('::').pop() : n;
      if (b.includes('@')) b = b.split('@')[0];
      return b;
    };
    const myBare = bareOf(fn.name);
    let bareCount = 0;
    if (this.functionIndex) {
      for (const funcs of Object.values(this.functionIndex)) {
        for (const fname of Object.keys(funcs)) {
          if (bareOf(fname) === myBare) bareCount++;
        }
      }
    }

    const identity = {
      name: fn.name,
      displayName: dn,
      renameTier,
      filepath,
      startLine: fn.start,
      endLine: fn.end,
      lineCount: fn.end - fn.start + 1,
      type: fn.type,
      bareUnique: bareCount === 1,
      bareDuplicateCount: bareCount,
      parseMethod: this.parseMethod || 'unknown',
    };

    // --- Callers ---
    // Short-name bail-out is expected here for 1-2 char bundled-JS names;
    // the digest still produces useful output (identity, callees, strings,
    // breadcrumbs, dupes), so we note the skipped scan rather than failing.
    let rawCallers;
    let callersSkipped = null;
    try {
      rawCallers = this.findCallers(fn.name, 500);
    } catch (e) {
      if (e.code === 'SHORT_NAME_BAILOUT') {
        // Inverted-index path bailed out (short names match too many lines).
        // Fall back to a case-SENSITIVE regex scan over file contents — this
        // avoids the inverted-index blowup for `xf` matching every word
        // containing `xf`, and avoids the case-folding that would surface
        // `Xf` and `XF` as false positives.
        rawCallers = this._findCallersByExactRegex(fn.name, 500);
        callersSkipped = null;
      } else {
        throw e;
      }
    }
    const byCaller = new Map();
    for (const c of rawCallers) {
      // tree-sitter's _findContainingFunction returns null when a call is
      // genuinely at top-level / file scope (not inside any function).
      // Surface that as "(file scope)" rather than the less-informative
      // "(unknown)". If future parser work introduces a distinct "truly
      // unresolved" case, we can differentiate then.
      const name = c.caller_function || '(file scope)';
      if (!byCaller.has(name)) byCaller.set(name, []);
      byCaller.get(name).push({
        filepath: c.filepath,
        line: c.line_number,
        text: c.line_text || '',
      });
    }
    const callersSection = {
      totalSites: rawCallers.length,
      distinctCallers: byCaller.size,
      skipped: callersSkipped, // non-null means the caller scan was bailed out
      byCaller: [...byCaller.entries()]
        .sort((a, b) => b[1].length - a[1].length) // most-frequent callers first
        .slice(0, maxCallers)
        .map(([name, sites]) => ({
          callerName: name,
          callerDisplayName: this.getDisplayName(name),
          siteCount: sites.length,
          sites: sites.slice(0, 3), // first few for detail
        })),
    };

    // --- Callees ---
    const rawCallees = this.findCallees(fn.name, pathHint);
    // Tally (name -> count) using the call_sites array if provided, else 1 each
    const calleeTally = new Map();
    for (const ce of rawCallees) {
      const nm = ce.name || ce.display_name || '(unknown)';
      const siteCount = Array.isArray(ce.call_sites) ? ce.call_sites.length : 1;
      calleeTally.set(nm, (calleeTally.get(nm) || 0) + siteCount);
    }
    const calleesSection = {
      totalSites: [...calleeTally.values()].reduce((s, n) => s + n, 0),
      distinctCallees: calleeTally.size,
      topByFrequency: [...calleeTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxCallees)
        .map(([name, count]) => ({
          calleeName: name,
          calleeDisplayName: this.getDisplayName(name),
          siteCount: count,
        })),
      recursive: calleeTally.has(fn.name) || calleeTally.has(myBare),
    };

    // --- Strings in body ---
    // Scan body lines for quoted strings, count per-function occurrences,
    // cross-ref with the global string table for rarity (lower total count
    // = more distinctive).
    const perFuncStringCounts = new Map(); // value -> count within this function
    const strRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
    for (const line of bodyLines) {
      if (!line) continue;
      strRe.lastIndex = 0;
      let m;
      while ((m = strRe.exec(line)) !== null) {
        const val = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
        if (!val || val.length < 2) continue;
        // Skip string fragments that look like identifier-only (property
        // names inside object literals etc. are caught but harmless)
        perFuncStringCounts.set(val, (perFuncStringCounts.get(val) || 0) + 1);
      }
    }
    // Look up global frequency in string table (if available).
    // Build a value→count Map once for O(1) lookup instead of per-string linear scan.
    let strTableMap = null;
    try {
      const strTable = this.ensureStringTable ? this.ensureStringTable(2, false) : null;
      if (Array.isArray(strTable)) {
        strTableMap = new Map();
        for (const entry of strTable) {
          if (entry && entry.value) strTableMap.set(entry.value, entry.count);
        }
      }
    } catch { /* ignore */ }
    const getGlobalCount = (val) => strTableMap ? strTableMap.get(val) ?? null : null;
    const distinctiveStrings = [...perFuncStringCounts.entries()]
      .map(([val, localCount]) => ({ val, localCount, globalCount: getGlobalCount(val) }))
      // Sort by global count ascending (rarer first); nulls treated as rare
      .sort((a, b) => {
        const ag = a.globalCount == null ? 1 : a.globalCount;
        const bg = b.globalCount == null ? 1 : b.globalCount;
        return ag - bg;
      })
      .slice(0, maxStrings);
    const repeatedStrings = [...perFuncStringCounts.entries()]
      .filter(([, c]) => c >= minRepeatCount)
      .map(([val, count]) => ({ val, count }))
      .sort((a, b) => b.count - a.count);
    const stringsSection = {
      totalStrings: [...perFuncStringCounts.values()].reduce((s, n) => s + n, 0),
      distinctStrings: perFuncStringCounts.size,
      distinctive: distinctiveStrings,
      repeated: repeatedStrings,
    };

    // --- Breadcrumbs in body ---
    // Three sources, unioned and deduped by line number:
    //
    //   (1) global extractBreadcrumbs().markers   — timing/trace markers
    //       (Bq, L3, etc.), emits only from index-wide top-3 trace helpers
    //   (2) global extractBreadcrumbs().events    — telemetry events
    //       (n("tengu_*"), etc.), emits only from hardcoded emitter names
    //   (3) per-function local scan               — catches locally-aliased
    //       helpers the global extractor misses (e.g. `q` in VCz, `jA` in
    //       Mf7; also handles multi-arg calls like jA("event", false))
    //
    // Source (3) uses the same label-shape filter as the global extractor
    // (≥2 underscores, length ≥8, starts with lowercase letter) so false
    // positives are minimized. Multi-arg calls match via `[,)]` terminator
    // rather than just `)`.
    const markersByLine = new Map();
    try {
      const bc = this.extractBreadcrumbs ? this.extractBreadcrumbs(false) : null;
      if (bc && bc.markers) {
        for (const m of bc.markers) {
          if (m.filepath !== filepath || m.line < fn.start || m.line > fn.end) continue;
          markersByLine.set(m.line, { label: m.label, line: m.line });
        }
      }
      if (bc && bc.events) {
        for (const e of bc.events) {
          if (e.filepath !== filepath || e.line < fn.start || e.line > fn.end) continue;
          if (!markersByLine.has(e.line)) {
            markersByLine.set(e.line, { label: e.name, line: e.line });
          }
        }
      }
    } catch { /* ignore */ }

    const localMarkerRe = /\b([a-zA-Z_$][\w$]{0,4})\(\s*["']([a-z][a-z0-9_]+)["']\s*[,)]/g;
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i] || '';
      localMarkerRe.lastIndex = 0;
      let m;
      while ((m = localMarkerRe.exec(line)) !== null) {
        const label = m[2];
        if ((label.match(/_/g) || []).length < 2) continue;
        if (label.length < 8) continue;
        const lineNum = fn.start + i;
        if (!markersByLine.has(lineNum)) {
          markersByLine.set(lineNum, { label, line: lineNum });
        }
      }
    }

    const breadcrumbsSection = {
      markers: [...markersByLine.values()].sort((a, b) => a.line - b.line),
    };

    // --- Comments in body ---
    // Use _isInsideString (the state-machine helper also used by applyRenames
    // and searchLiteral) to distinguish genuine `//` comments from the `//`
    // that appears inside string literals like "https://example.com/...".
    // The naive "count quote chars before this position" heuristic is fooled
    // by templates-containing-strings, which is common in minified JS.
    //
    // Cross-line state: track block-comment open/close across lines using the
    // same carryState approach as applyRenames.
    const comments = [];
    let carryState = 'code';
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i] || '';
      // If the line begins inside an open block comment carried from the
      // previous line, scan for `*/` and capture the text before it.
      if (carryState === 'bc') {
        const endIdx = line.indexOf('*/');
        const content = (endIdx >= 0 ? line.slice(0, endIdx) : line)
          .replace(/^\s*\*\s?/, '').trim();
        if (content) comments.push({ line: fn.start + i, kind: 'block', text: content });
        carryState = endIdx >= 0 ? 'code' : 'bc';
        continue;
      }
      // Walk the line looking for `//` or `/*` at code-state positions (not
      // inside strings/templates/existing comments). _isInsideString gives us
      // the state AT a given offset given the line and a starting state.
      let j = 0;
      let emitted = false;
      while (j < line.length - 1) {
        const two = line[j] + line[j + 1];
        if ((two === '//' || two === '/*') && !_isInsideString(line, j, carryState)) {
          if (two === '//') {
            const content = line.slice(j + 2).trim();
            if (content) comments.push({ line: fn.start + i, kind: 'line', text: content });
            emitted = true;
            break;
          } else {
            // Block comment — look for matching */ on this line
            const blockEnd = line.indexOf('*/', j + 2);
            if (blockEnd >= 0) {
              const content = line.slice(j + 2, blockEnd).trim();
              if (content) comments.push({ line: fn.start + i, kind: 'block-inline', text: content });
              j = blockEnd + 2;
              continue;
            } else {
              const content = line.slice(j + 2).trim();
              if (content) comments.push({ line: fn.start + i, kind: 'block', text: content });
              carryState = 'bc';
              emitted = true;
              break;
            }
          }
        }
        j++;
      }
      // Update cross-line state: if we're not in a block comment at line end,
      // check whether the line leaves us in template-literal state (which can
      // also carry across lines per _scanLineState).
      if (!emitted && carryState !== 'bc') {
        const endState = _scanLineState(line, carryState);
        carryState = (endState === 'bc' || endState === 't') ? endState : 'code';
      }
    }

    // --- Command-catalog cross-reference ---
    let commandsSection = { cliOptions: [], commands: [], routes: [], guiActions: [] };
    try {
      const cat = this.extractCommandCatalog ? this.extractCommandCatalog(false) : null;
      if (cat) {
        const matchesFunc = (item) => {
          const f = item.func || item.handler?.func;
          return f && (f === fn.name || f === dn || bareOf(f) === myBare);
        };
        for (const key of ['cliOptions', 'commands', 'routes', 'guiActions']) {
          if (cat[key]) commandsSection[key] = cat[key].filter(matchesFunc);
        }
      }
    } catch { /* ignore */ }

    // --- Dupes ---
    let dupesSection = { exactSiblings: [], nearSiblings: [], structSiblings: [] };
    try {
      const hashes = this.ensureFuncHashes ? this.ensureFuncHashes(3, false) : null;
      if (hashes) {
        const myKey = `${filepath}|||${fn.name}`;
        const myHash = hashes.get(myKey);
        if (myHash) {
          for (const [key, h] of hashes) {
            if (key === myKey) continue;
            const [otherFile, otherName] = key.split('|||');
            const sib = {
              name: otherName,
              displayName: this.getDisplayName(otherName),
              filepath: otherFile,
              lines: h.lines,
            };
            if (h.body_hash === myHash.body_hash) dupesSection.exactSiblings.push(sib);
            else if (h.struct_hash === myHash.struct_hash) dupesSection.structSiblings.push(sib);
            else if (bareOf(otherName) === myBare && h.lines === myHash.lines) {
              dupesSection.nearSiblings.push(sib);
            }
          }
          // Rank sibling names by "usefulness" tier, highlight most-useful
          const tierRank = (n, disp) => {
            const d = disp || n;
            if (/(?:^|::)[^_]*_NAME_[a-zA-Z]/.test(d)) return 1; // ground truth
            if (d.includes('_CMD_')) return 2;
            if (d === n && !/_[A-Z]+_/.test(n)) return 3; // hand-written, no rename
            if (d.includes('_IMPORT_')) return 4;
            if (d.includes('_KW_')) return 5;
            return 6;
          };
          const myRank = tierRank(fn.name, dn);
          const allSiblings = [
            ...dupesSection.exactSiblings,
            ...dupesSection.nearSiblings,
            ...dupesSection.structSiblings,
          ];
          for (const sib of allSiblings) {
            sib.rank = tierRank(sib.name, sib.displayName);
          }
          // Find the best sibling (lowest rank number)
          const best = allSiblings
            .filter((s) => s.rank < myRank)
            .sort((a, b) => a.rank - b.rank)[0];
          if (best) dupesSection.moreUsefullyNamedSibling = best;
        }
      }
    } catch { /* ignore */ }

    // --- Asserts (deferred, section stub only) ---
    const assertsSection = { asserts: [], _note: 'pending TODO #337 — extractAsserts not yet implemented' };

    return {
      identity,
      callers: callersSection,
      callees: calleesSection,
      strings: stringsSection,
      breadcrumbs: breadcrumbsSection,
      comments,
      commands: commandsSection,
      dupes: dupesSection,
      asserts: assertsSection,
    };
  }

  /**
   * Scan `lines` from index 0 up to (but not including) `endLineIdx`, running
   * the state machine to determine whether that line position is inside an
   * open block comment or template literal carried from earlier in the file.
   *
   * Much cheaper than applyRenames (no regex alternation, just char iteration)
   * so can be used on huge files to compute the starting state for a tail
   * chunk. Returns one of: 'code' | 'bc' | 't' (string/line-comment states
   * don't carry across lines).
   */
  scanFileToLine(lines, endLineIdx) {
    let state = 'code';
    const limit = Math.min(endLineIdx, lines.length);
    for (let i = 0; i < limit; i++) {
      state = _scanLineState(lines[i], state);
      // String and line-comment states never persist across a line boundary
      if (state !== 'bc' && state !== 't') state = 'code';
    }
    return state;
  }

  // Rename map lookups (display ↔ original) — delegated to ./rename.js
  getDisplayName(funcName) { return _getDisplayName(this, funcName); }
  getOriginalName(displayName) { return _getOriginalName(this, displayName); }
  reverseRenames(text) { return _reverseRenames(this, text); }
  findOriginalsByDisplayPattern(pattern) { return _findOriginalsByDisplayPattern(this, pattern); }

  // Rename inference orchestration — delegated to ./rename.js
  inferAndSaveRenameMap(opts = {}) { return _inferAndSaveRenameMap(this, opts); }


  // ========================================================================
  // String table: extract, save, load, query
  // ========================================================================

  /**
   * Build a string table from all indexed files.
   * Extracts string literals (single/double/backtick), deduplicates,
   * and records where each unique string appears (file, line, function).
   *
   * @param {number} [minLength=8] - Minimum string length to include
   * @param {boolean} [showProgress=true]
   * @returns {number} count of unique strings found
   */
  buildStringTable(minLength = 8, showProgress = true) {
    this._ensureFunctionIndex();
    const strings = Object.create(null); // value -> { count, locations: [{filepath, line, func}] }
    let totalFound = 0;

    // Regex to match string literals: "...", '...', `...`
    // Handles escaped quotes. Backticks matched per-line (multi-line tracked separately).
    const strRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

    for (const [filepath, lines] of this.fileLines) {
      if (showProgress && totalFound % 10000 === 0 && totalFound > 0) {
        process.stderr.write(`  String table: ${totalFound} strings found, ${Object.keys(strings).length} unique...\r`);
      }

      // Pre-compute function boundaries for this file
      const funcBounds = this._getFuncBoundaries(filepath);

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineNum = lineIdx + 1;

        // Extract single/double quoted strings from this line
        let m;
        strRe.lastIndex = 0;
        while ((m = strRe.exec(line)) !== null) {
          const raw = m[0].slice(1, -1);
          if (raw.length < minLength) continue;

          // Unescape basic escapes
          const val = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
            .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');

          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          _addString(strings, val, filepath, lineNum, func);
          totalFound++;
        }

        // Extract backtick template literals that start and end on the same line
        // (Multi-line template literal tracking is deferred — fragile across 500K+ lines)
        const btRe = /`([^`]{8,})`/g;
        while ((m = btRe.exec(line)) !== null) {
          const val = m[1].length > 4000 ? m[1].slice(0, 4000) + '...' : m[1];
          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          _addString(strings, val, filepath, lineNum, func);
          totalFound++;
        }
      }
    }

    if (showProgress) {
      process.stderr.write(`\r  String table: ${totalFound} strings found, ${Object.keys(strings).length} unique    \n`);
    }

    // Sort by count descending, then by length descending
    const sorted = Object.entries(strings)
      .map(([value, info]) => ({
        value,
        count: info.count,
        files: info.files,
        locations: info.locations.slice(0, 20), // cap locations per string
      }))
      .sort((a, b) => b.count - a.count || b.value.length - a.value.length);

    this._stringTable = sorted;

    // Save to disk
    try {
      fs.writeFileSync(this._stringTablePath(), JSON.stringify(sorted));
      if (showProgress) console.log(`Saved ${sorted.length} unique strings to string_table.json`);
    } catch (e) {
      if (showProgress) console.log(`Warning: could not save string table: ${e.message}`);
    }

    return sorted.length;
  }

  /**
   * Load string table from cache, or build if not available.
   */
  ensureStringTable(minLength = 8, showProgress = false) {
    if (this._stringTable) return this._stringTable;
    try {
      const raw = fs.readFileSync(this._stringTablePath(), 'utf-8');
      this._stringTable = JSON.parse(raw);
      return this._stringTable;
    } catch {
      // Not cached — build it
      this.buildStringTable(minLength, showProgress);
      return this._stringTable || [];
    }
  }

  /**
   * Query the string table with optional filter (substring or regex).
   * @param {object} opts
   * @param {string} [opts.filter] - Substring match or /regex/
   * @param {number} [opts.max=50] - Max results
   * @param {number} [opts.minLength=8] - Min string length
   * @returns {Array} Matching string entries
   */
  queryStringTable({ filter, max = 50, minLength = 8 } = {}) {
    const table = this.ensureStringTable(minLength);
    if (!table || table.length === 0) return { total: 0, results: [] };

    let results = table;

    if (filter) {
      // Support /regex/ syntax
      const regexMatch = filter.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexMatch) {
        try {
          const re = new RegExp(regexMatch[1], regexMatch[2]);
          results = table.filter(s => re.test(s.value));
        } catch {
          results = table.filter(s => s.value.includes(filter));
        }
      } else {
        const pat = filter.toLowerCase();
        results = table.filter(s => s.value.toLowerCase().includes(pat));
      }
    }

    // Return BOTH the pre-slice total (so callers can show "showing N of M+"
    // and the user isn't silently given a clipped view) AND the sliced
    // results. Returning just the sliced array — as before — meant that
    // `server.js` reported `total: results.length` which equalled `max`,
    // hiding the fact that more matches existed.
    return { total: results.length, results: results.slice(0, max) };
  }

  /**
   * Find containing function from pre-computed boundaries (array format [start, end, name]).
   * Uses the same boundary format as the existing _getFuncBoundaries.
   */
  _findContainingFunctionFromBounds(bounds, lineNum) {
    // bounds is [[start, end, name], ...] sorted by start
    for (let i = bounds.length - 1; i >= 0; i--) {
      if (lineNum >= bounds[i][0] && lineNum <= bounds[i][1]) {
        return bounds[i][2];
      }
    }
    return null;
  }


  // ============================================================================
  // Breadcrumbs + Command Catalog — moved to ./breadcrumbs-commands.js (Issue #18 Phase 2)
  // ============================================================================
  extractBreadcrumbs(...args) { return _extractBreadcrumbs(this, ...args); }
  extractCommandCatalog(...args) { return _extractCommandCatalog(this, ...args); }


  // Save / Load literal index
  // ========================================================================

  _saveLiteralIndex() {
    fs.mkdirSync(this.indexPath, { recursive: true });
    const outPath = this._literalIndexPath();
    const fd = fs.openSync(outPath, 'w');

    try {
      // Write opening and metadata fields
      fs.writeSync(fd, '{\n');

      // base_path
      fs.writeSync(fd, `"base_path":${JSON.stringify(this.basePath)},\n`);

      // index_source
      fs.writeSync(fd, `"index_source":${JSON.stringify(this.indexSource)},\n`);

      // parse_method
      fs.writeSync(fd, `"parse_method":${JSON.stringify(this.parseMethod || 'regex')},\n`);

      // file_hashes
      fs.writeSync(fd, `"file_hashes":${JSON.stringify(this.fileHashes)},\n`);

      // files — write entry by entry to avoid giant string
      fs.writeSync(fd, '"files":{');
      let first = true;
      for (const [filePath, content] of this.files) {
        if (!first) fs.writeSync(fd, ',');
        first = false;
        // JSON.stringify each key and value separately — each is bounded
        // by single-file size, well under the string limit
        fs.writeSync(fd, `${JSON.stringify(filePath)}:${JSON.stringify(content)}`);
      }
      fs.writeSync(fd, '},\n');

      // file_lines — write entry by entry
      fs.writeSync(fd, '"file_lines":{');
      first = true;
      for (const [filePath, lines] of this.fileLines) {
        if (!first) fs.writeSync(fd, ',');
        first = false;
        fs.writeSync(fd, `${JSON.stringify(filePath)}:${JSON.stringify(lines)}`);
      }
      fs.writeSync(fd, '}\n');

      fs.writeSync(fd, '}\n');
    } finally {
      fs.closeSync(fd);
    }
  }

  _loadLiteralIndex() {
    const indexPath = this._literalIndexPath();
    if (!fs.existsSync(indexPath)) return false;
    try {
      const stat = fs.statSync(indexPath);
      // Use streaming parser for files > 400MB to avoid Node string limit
      if (stat.size > 400 * 1024 * 1024) {
        return this._loadLiteralIndexStreaming(indexPath);
      }
      const raw = fs.readFileSync(indexPath, 'utf-8');
      const data = JSON.parse(raw);
      this.files = new Map(Object.entries(data.files || {}));
      this.fileLines = new Map(Object.entries(data.file_lines || {}).map(
        ([k, v]) => [k, Array.isArray(v) ? v : []]
      ));
      this.basePath = data.base_path || null;
      this.indexSource = data.index_source || null;
      this.parseMethod = data.parse_method || null;
      this.fileHashes = data.file_hashes || {};
      return this.files.size > 0;
    } catch (e) {
      if (e.message && (e.message.includes('string longer than') ||
                        e.message.includes('greater than 2 GiB') ||
                        e.message.includes('File size'))) {
        // Fall back to streaming for size-related errors
        try {
          return this._loadLiteralIndexStreaming(indexPath);
        } catch (e2) {
          console.log(`Warning: Streaming load also failed: ${e2.message}`);
          return false;
        }
      }
      console.log(`Warning: Could not load literal index: ${e.message}`);
      return false;
    }
  }

  /**
   * Stream-parse a large literal_index.json (handles files of any size,
   * including >2GB). Uses chunked file reading for files that exceed
   * Node.js Buffer limit.
   */
  _loadLiteralIndexStreaming(indexPath) {
    eprint('  Loading large literal index (streaming)...');
    this.files = new Map();
    this.fileLines = new Map();
    this.basePath = null;
    this.indexSource = null;
    this.fileHashes = {};

    const { src, size } = openJSONFile(indexPath);
    let filesStart = -1, filesEnd = -1;
    let fileLinesStart = -1, fileLinesEnd = -1;

    try {
      // First pass: find byte ranges of each top-level key
      forEachEntry(src, 0, size, (key, vs, ve) => {
        switch (key) {
          case 'files':       filesStart = vs; filesEnd = ve; break;
          case 'file_lines':  fileLinesStart = vs; fileLinesEnd = ve; break;
          case 'base_path':   this.basePath = parseValue(src, vs, ve); break;
          case 'index_source': this.indexSource = parseValue(src, vs, ve); break;
          case 'parse_method': this.parseMethod = parseValue(src, vs, ve); break;
          case 'file_hashes':
            if (valueSize(vs, ve) < 100 * 1024 * 1024) {
              this.fileHashes = parseValue(src, vs, ve);
            }
            break;
        }
      });

      // Parse "files" - each entry is filepath -> metadata (small)
      if (filesStart >= 0) {
        forEachEntry(src, filesStart, filesEnd, (fp, vs, ve) => {
          this.files.set(fp, parseValue(src, vs, ve));
        });
      }

      // Parse "file_lines" - each entry is filepath -> [lines array]
      if (fileLinesStart >= 0) {
        let count = 0;
        forEachEntry(src, fileLinesStart, fileLinesEnd, (fp, vs, ve) => {
          const lines = parseValue(src, vs, ve);
          this.fileLines.set(fp, Array.isArray(lines) ? lines : []);
          count++;
          if (count % 200 === 0) eprogress(`  ... ${count} files loaded`);
        });
        eprint(`\r  Loaded ${count} files (streaming)                `);
      }
    } finally {
      closeSource(src);
    }

    return this.files.size > 0;
  }


  // ========================================================================
  // Inverted Index
  // ========================================================================

  _normalizeLine(line) {
    return line.split(/\s+/).join(' ').trim();
  }

  buildInvertedIndex(maxFileFrequency = 50, showProgress = true) {
    if (this.fileLines.size === 0) {
      console.log('No files loaded. Run buildIndex() first.');
      return;
    }
    const totalFiles = this.fileLines.size;
    if (showProgress) console.log(`Building inverted index (${totalFiles} files)...`);

    // line -> { filepath -> [lineNumbers] }
    const lineToFiles = new Map();
    let filesProcessed = 0;

    for (const [filepath, lines] of this.fileLines) {
      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const normalized = this._normalizeLine(lines[lineNum]);
        if (normalized.length < 4) continue;

        if (!lineToFiles.has(normalized)) {
          lineToFiles.set(normalized, new Map());
        }
        const fileMap = lineToFiles.get(normalized);
        if (!fileMap.has(filepath)) {
          fileMap.set(filepath, []);
        }
        fileMap.get(filepath).push(lineNum + 1); // 1-indexed
      }
      filesProcessed++;
      if (showProgress && filesProcessed % 500 === 0) {
        console.log(`  Inverted index: processed ${filesProcessed}/${totalFiles} files (${lineToFiles.size} unique lines so far)`);
      }
    }

    // Stream directly to disk, filtering common lines, without building
    // a second copy of the data in an intermediate object.
    fs.mkdirSync(this.indexPath, { recursive: true });
    const fd = fs.openSync(this._invertedIndexPath(), 'w');
    let uniqueCount = 0;
    let skippedCommon = 0;

    const totalEntries = lineToFiles.size;
    if (showProgress) console.log(`  Writing inverted index to disk (${totalEntries} entries)...`);
    let entriesProcessed = 0;

    try {
      fs.writeSync(fd, '{');
      let first = true;

      for (const [line, fileMap] of lineToFiles) {
        if (fileMap.size > maxFileFrequency) {
          skippedCommon++;
        } else {
          if (!first) fs.writeSync(fd, ',');
          first = false;

          // Build the value array for this entry
          const locations = [];
          for (const [fp, lns] of fileMap) {
            locations.push([fp, lns]);
          }
          fs.writeSync(fd, `${JSON.stringify(line)}:${JSON.stringify(locations)}`);
          uniqueCount++;
        }
        entriesProcessed++;
        if (showProgress && entriesProcessed % 50000 === 0) {
          console.log(`  Writing: ${entriesProcessed}/${totalEntries} entries (${uniqueCount} kept, ${skippedCommon} skipped)`);
        }
      }

      fs.writeSync(fd, '}\n');
    } finally {
      fs.closeSync(fd);
    }

    // Don't hold the inverted index in memory during build — it will be
    // loaded on demand from disk when searches are run.
    this.invertedIndex = null;

    if (showProgress) {
      console.log(`Inverted index: ${uniqueCount} unique lines` +
                  ` (skipped ${skippedCommon} common lines)`);
    }
  }

  _loadInvertedIndex() {
    const indexPath = this._invertedIndexPath();
    if (!fs.existsSync(indexPath)) return false;
    try {
      const stat = fs.statSync(indexPath);
      // For large files: don't load into memory, stream on demand
      if (stat.size > 400 * 1024 * 1024) {
        return this._markInvertedOnDisk(indexPath, stat.size);
      }
      const raw = fs.readFileSync(indexPath, 'utf-8');
      this.invertedIndex = JSON.parse(raw);
      this._invertedOnDisk = false;
      return true;
    } catch (e) {
      if (e.message && (e.message.includes('string longer than') ||
                        e.message.includes('greater than 2 GiB') ||
                        e.message.includes('File size') ||
                        e.message.includes('heap'))) {
        return this._markInvertedOnDisk(indexPath);
      }
      console.log(`Warning: Could not load inverted index: ${e.message}`);
      this.invertedIndex = {};
      return false;
    }
  }

  /**
   * Mark the inverted index as too large for memory; will stream from disk.
   */
  _markInvertedOnDisk(indexPath, fileSize) {
    eprint('  Inverted index too large for memory - will stream from disk on demand.');
    this._invertedOnDisk = true;
    this._invertedDiskPath = indexPath;
    this._invertedDiskSize = fileSize || fs.statSync(indexPath).size;
    this.invertedIndex = null; // Don't hold in memory
    return true;
  }

  /**
   * Iterate every entry in the inverted index, either from memory or disk.
   * 
   * Normal mode: callback(line, locations) => false to stop early.
   * Lazy mode (lazy=true): callback(line, valueAccessor) where valueAccessor has:
   *   .parse()  - full JSON parse (returns locations array)
   *   .count()  - fast count total occurrences without full parse (~10x faster)
   * Lazy mode skips expensive JSON parsing until the callback actually needs the value.
   *
   * @param {function} callback
   * @param {boolean} [showProgress=false]
   * @param {boolean} [lazy=false] - lazy parse mode for on-disk streaming
   */
  forEachInvertedEntry(callback, showProgress = false, lazy = false) {
    // In-memory path (small indexes) - always eager, data already parsed
    if (this.invertedIndex && !this._invertedOnDisk) {
      if (lazy) {
        for (const [line, locations] of Object.entries(this.invertedIndex)) {
          const accessor = {
            parse: () => locations,
            count: () => locations.reduce((sum, [, lns]) => sum + lns.length, 0),
          };
          if (callback(line, accessor) === false) return;
        }
      } else {
        for (const [line, locations] of Object.entries(this.invertedIndex)) {
          if (callback(line, locations) === false) return;
        }
      }
      return;
    }

    // On-disk streaming path (large indexes)
    if (!this._invertedOnDisk || !this._invertedDiskPath) {
      console.log('No inverted index available.');
      return;
    }

    const { src, size } = openJSONFile(this._invertedDiskPath);
    let count = 0;
    let stopped = false;
    try {
      forEachEntry(src, 0, size, (key, vs, ve) => {
        if (stopped) return;
        count++;
        if (showProgress && count % 200000 === 0) eprogress(`  ... ${count} entries scanned`);

        if (lazy) {
          // Lazy mode: pass accessor that parses on demand
          const accessor = {
            parse: () => parseValue(src, vs, ve),
            count: () => countLocations(src, vs, ve),
          };
          if (callback(key, accessor) === false) {
            stopped = true;
          }
        } else {
          // Eager mode: parse immediately
          const locations = parseValue(src, vs, ve);
          if (callback(key, locations) === false) {
            stopped = true;
          }
        }
      });
    } finally {
      closeSource(src);
    }
    if (showProgress) eprint(`\r  Scanned ${count} inverted index entries        `);
  }

  /**
   * Ensure inverted index is available (in memory or on disk).
   * @returns {boolean}
   */
  _ensureInvertedAvailable() {
    if (this.invertedIndex) return true;
    if (this._invertedOnDisk) return true;
    return this._loadInvertedIndex();
  }

  /**
   * Count inverted index entries without loading into memory.
   * Streams through the file counting top-level keys.
   */
  getInvertedIndexCount() {
    if (this.invertedIndex) return Object.keys(this.invertedIndex).length;
    if (!this._invertedOnDisk || !this._invertedDiskPath) return 0;
    let count = 0;
    const { src, size } = openJSONFile(this._invertedDiskPath);
    try {
      forEachEntry(src, 0, size, () => { count++; });
    } finally {
      closeSource(src);
    }
    return count;
  }


  // ========================================================================
  // Function Index (regex-based parsing)
  // ========================================================================

  /**
   * Get regex patterns for detecting functions/classes by file extension.
   * Returns array of [regex, funcType, nameGroupIndex] tuples.
   */
  static _getPatternsForExt(ext) {
    // Pattern format: [regex_string, type, name_capture_group_index]
    // We use named groups (?<name>...) for clarity, but track the group name.

    const pythonPatterns = [
      [/^\s*(?:async\s+)?def\s+(\w+)\s*\(/, 'function', 1],
      [/^\s*class\s+(\w+)/, 'class', 1],
    ];

    const cLikePatterns = [
      // Google Test macros: TEST_P(Suite, Name), TEST_F(Suite, Name), TEST(Suite, Name), etc.
      // Treated as functions named Suite::Name (like class methods)
      [/^\s*(?:TEST_F|TEST_P|TEST|TYPED_TEST|TYPED_TEST_P|TYPED_TEST_SUITE|TEST_CASE)\s*\(\s*(\w+)\s*,\s*(\w+)/, 'function', -1],
      // C++ constructor: ClassName::ClassName(args) {
      [/^\s*([\w]+::[\w]+)\s*\([^;]*\)\s*(?::\s*[\w()\s,]+)?\s*\{?\s*$/, 'function', 1],
      // C++ destructor: ClassName::~ClassName() {
      [/^\s*([\w]+::~[\w]+)\s*\([^;]*\)\s*\{?\s*$/, 'function', 1],
      // C++ class method: return type + Class::Method(args) on SAME line
      [/^[\w\s*&<>:]+\s+([\w:]+::[\w~]+)\s*\([^;]*\)\s*(?:const)?\s*(?:override)?\s*\{?\s*$/, 'function', 1],
      // C++ class method: return type + Class::Method( with args on NEXT line(s)
      // e.g. "Region OcclusionTracker::ComputeVisibleRegionInScreen("
      [/^[\w\s*&<>:]+\s+([\w:]+::[\w~]+)\s*\([^);]*$/, 'function', 1],
      // C++ class method with return type on PREVIOUS line (Chromium/Google style):
      //   ReturnType\n
      //   ClassName::MethodName(args) const {\n
      // Matches: Qualified::Name( at start of line (not preceded by = or return etc.)
      [/^([\w]+(?:::[\w~]+)+)\s*\(/, 'function', 1],
      // Plain C function / inline class method: ReturnType funcname(args) {
      // Allow :: in return type for qualified types like cc::Layer*
      [/^\s*[a-zA-Z_][\w\s*&:<>,]*\s+(\w+)\s*\([^;]*\)\s*\{?\s*$/, 'function', 1],
      // Plain C function: ReturnType funcname( with args on next line(s)
      [/^\s*[a-zA-Z_][\w\s*&:<>,]*\s+(\w+)\s*\([^);]*$/, 'function', 1],
      // C++ class/struct - skip export macros like CC_EXPORT, BLINK_EXPORT, COMPONENT_EXPORT(viz)
      // Export macros are ALL_CAPS words containing underscore, optionally with (args)
      [/^\s*(?:template\s*<[^>]*>\s*)?class\s+(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:\([^)]*\))?\s+)*(\w+)/, 'class', 1],
      [/^\s*(?:template\s*<[^>]*>\s*)?struct\s+(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:\([^)]*\))?\s+)*(\w+)/, 'class', 1],
    ];

    const javaPatterns = [
      [/^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|native|strictfp)\s+)*(?:[\w<>\[\],.\s]+\s+)?(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{?\s*$/, 'function', 1],
      [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|static)\s+)*interface\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|static)\s+)*enum\s+(\w+)/, 'class', 1],
    ];

    const jsPatterns = [
      [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, 'function', 1],
      [/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/, 'function', 1],
      [/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\b/, 'function', 1],
      // Class method shorthand
      [/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*\{\s*$/, 'function', 1],
      [/^\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/, 'class', 1],
    ];

    const goPatterns = [
      [/^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/, 'function', 1],
      [/^\s*type\s+(\w+)\s+struct/, 'class', 1],
    ];

    const rustPatterns = [
      [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, 'function', 1],
      [/^\s*(?:pub\s+)?struct\s+(\w+)/, 'class', 1],
      [/^\s*(?:pub\s+)?impl\s+(\w+)/, 'class', 1],
    ];

    const perlPatterns = [
      [/^\s*sub\s+(\w+)/, 'function', 1],
      [/^\s*package\s+([\w:]+)/, 'class', 1],
    ];

    const phpPatterns = [
      [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+(\w+)/, 'function', 1],
      [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 'class', 1],
      [/^\s*interface\s+(\w+)/, 'class', 1],
      [/^\s*trait\s+(\w+)/, 'class', 1],
    ];

    const rubyPatterns = [
      [/^\s*def\s+(\w+)/, 'function', 1],
      [/^\s*class\s+(\w+)/, 'class', 1],
      [/^\s*module\s+(\w+)/, 'class', 1],
    ];

    const coffeePatterns = [
      [/^\s*(\w+)\s*[:=]\s*\([^)]*\)\s*[-=]>/, 'function', 1],
      [/^\s*(\w+)\s*[:=]\s*[-=]>/, 'function', 1],
      [/^\s*class\s+(\w+)/, 'class', 1],
    ];

    const vbsPatterns = [
      [/^\s*(?:Public\s+|Private\s+)?(?:Sub|Function)\s+(\w+)/i, 'function', 1],
      [/^\s*Class\s+(\w+)/i, 'class', 1],
    ];

    const awkPatterns = [
      [/^\s*function\s+(\w+)/, 'function', 1],
    ];

    const csPatterns = [
      // C# methods (similar to Java)
      [/^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|partial)\s+)*(?:[\w<>\[\],.\s]+\s+)?(\w+)\s*\([^)]*\)\s*\{?\s*$/, 'function', 1],
      [/^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+(\w+)/, 'class', 1],
    ];

    const swiftPatterns = [
      // Swift functions: func name(args) { or func name(args) -> Type {
      [/^\s*(?:(?:public|private|internal|fileprivate|open|static|class|override|final|mutating)\s+)*func\s+(\w+)/, 'function', 1],
      // init / deinit
      [/^\s*(?:(?:public|private|internal|fileprivate|open|required|convenience|override)\s+)*(init)\s*\(/, 'function', 1],
      // struct / class / enum / protocol
      [/^\s*(?:(?:public|private|internal|fileprivate|open|final)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|internal|fileprivate|open)\s+)*struct\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|internal|fileprivate|open)\s+)*enum\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|internal|fileprivate|open)\s+)*protocol\s+(\w+)/, 'class', 1],
    ];

    const kotlinPatterns = [
      // Kotlin: fun name(args) or fun name(args): Type
      [/^\s*(?:(?:public|private|protected|internal|open|override|abstract|final|inline|suspend)\s+)*fun\s+(?:<[^>]+>\s+)?(\w+)/, 'function', 1],
      // Kotlin: class / object / interface / enum / data class / sealed class
      [/^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|inner|value)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal)\s+)*(?:companion\s+)?object\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal|sealed)\s+)*interface\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+class\s+(\w+)/, 'class', 1],
    ];

    const scalaPatterns = [
      // Scala: def name(args) or def name: Type
      [/^\s*(?:(?:private|protected|override|final|implicit|lazy)\s+)*def\s+(\w+)/, 'function', 1],
      // Scala: class / object / trait / case class
      [/^\s*(?:(?:private|protected|abstract|sealed|final|case|implicit)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:private|protected)\s+)?(?:case\s+)?object\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:private|protected|sealed)\s+)*trait\s+(\w+)/, 'class', 1],
    ];

    const luaPatterns = [
      // Lua: function name(args) or local function name(args)
      [/^\s*(?:local\s+)?function\s+(\w[\w.]*)/, 'function', 1],
      // Lua: name = function(args) (common module pattern)
      [/^\s*(?:local\s+)?(\w+)\s*=\s*function\s*\(/, 'function', 1],
    ];

    const objcPatterns = [
      // Objective-C instance method: - (ReturnType)methodName  or  - (ReturnType)methodName:(Type)param
      [/^\s*[-+]\s*\([^)]*\)\s*(\w+)/, 'function', 1],
      // C function (also common in .m files)
      [/^[a-zA-Z_][\w\s*&]*\s+(\w+)\s*\([^;]*\)\s*\{?\s*$/, 'function', 1],
      // @interface ClassName or @implementation ClassName
      [/^\s*@interface\s+(\w+)/, 'class', 1],
      [/^\s*@implementation\s+(\w+)/, 'class', 1],
      // @protocol ClassName
      [/^\s*@protocol\s+(\w+)/, 'class', 1],
    ];

    switch (ext) {
      case '.py': case '.pyw':
        return pythonPatterns;
      case '.c': case '.cpp': case '.h': case '.hpp':
      case '.cc': case '.cxx': case '.c++': case '.h++': case '.hxx':
        return cLikePatterns;
      case '.java':
        return javaPatterns;
      case '.js': case '.ts': case '.jsx': case '.tsx':
      case '.mjs': case '.cjs': case '.hbs':
        return jsPatterns;
      case '.coffee':
        return [...coffeePatterns, ...jsPatterns];
      case '.go':
        return goPatterns;
      case '.rs':
        return rustPatterns;
      case '.pl': case '.pm':
        return perlPatterns;
      case '.php':
        return phpPatterns;
      case '.rb':
        return rubyPatterns;
      case '.vbs': case '.bas':
        return vbsPatterns;
      case '.awk':
        return awkPatterns;
      case '.cs':
        return csPatterns;
      case '.swift':
        return swiftPatterns;
      case '.kt': case '.kts':
        return kotlinPatterns;
      case '.scala': case '.sc':
        return scalaPatterns;
      case '.lua':
        return luaPatterns;
      case '.m': case '.mm':
        return objcPatterns;
      default:
        if (TEXT_EXTENSIONS.has(ext)) return [];
        return [...pythonPatterns, ...cLikePatterns]; // Best guess
    }
  }

  static SKIP_KEYWORDS = new Set([
    'if', 'else', 'while', 'for', 'switch', 'catch', 'return',
    'sizeof', 'typeof', 'elif', 'except', 'finally', 'with'
  ]);

  /**
   * Parse functions from a single file using regex patterns.
   * @param {string} filepath
   * @returns {Object} { funcName -> {start, end, type, base_name} }
   */
  _parseFunctionsRegex(filepath) {
    const lines = this.fileLines.get(filepath);
    if (!lines) return {};

    const ext = path.extname(filepath).toLowerCase();
    const patterns = CodeSearchIndex._getPatternsForExt(ext);
    if (patterns.length === 0) return {};

    const fileFunctions = {};
    let currentFunc = null;
    let currentStart = null;
    let currentClass = null;
    let classIndent = -1;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      const line = lines[lineIdx];

      // Track indentation for class scope
      const stripped = line.trimStart();
      const indent = stripped ? (line.length - stripped.length) : 999;

      for (const [regex, funcType, nameGroup] of patterns) {
        const match = line.match(regex);
        if (!match) continue;

        // nameGroup -1: composite name from groups 1+2 (e.g. TEST_P(Suite, Name) → Suite::Name)
        let name = nameGroup === -1 ? (match[1] + '::' + match[2]) : match[nameGroup];
        if (!name || CodeSearchIndex.SKIP_KEYWORDS.has(name)) continue;

        // Close previous function at line before this one
        if (currentFunc && currentStart) {
          fileFunctions[currentFunc].end = lineNum - 1;
        }

        if (funcType === 'class') {
          currentClass = name;
          classIndent = indent;
        } else if (funcType === 'function') {
          // Check if inside a class
          if (currentClass && indent > classIndent && !name.includes('::')) {
            name = currentClass + '::' + name;
          }
        }

        // Close class scope if at same or less indent
        if (funcType !== 'class' && currentClass && indent <= classIndent) {
          currentClass = null;
          classIndent = -1;
        }

        // Handle duplicate function names
        let storedName = name;
        if (name in fileFunctions) {
          storedName = `${name}@${lineNum}`;
        }

        currentFunc = storedName;
        currentStart = lineNum;
        const bare = name.includes('::') ? name.split('::').pop() : name;

        fileFunctions[storedName] = {
          start: lineNum,
          end: null,
          // If name contains ::, it's a method - even without a class declaration
          // in this file (the class may be declared in a .h we didn't index)
          type: (funcType !== 'class' && name.includes('::')) ? 'method' : funcType,
          base_name: bare,
        };
        break; // First matching pattern wins
      }
    }

    // Close last function at end of file
    if (currentFunc && fileFunctions[currentFunc] && fileFunctions[currentFunc].end === null) {
      fileFunctions[currentFunc].end = lines.length;
    }

    // Post-process: fix truncated functions using brace counting.
    // When inner constructs (object literal methods, nested functions) match
    // patterns, the outer function gets prematurely terminated. Detect this
    // by checking if the extracted body has unbalanced braces - more '{' than '}'.
    for (const [fname, info] of Object.entries(fileFunctions)) {
      // Only applies to functions whose start line contains '{'
      const startLine = lines[info.start - 1] || '';
      if (!startLine.includes('{')) continue;

      // Count braces in current span
      let depth = 0;
      for (let i = info.start - 1; i < info.end && i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
      }

      // If balanced (depth === 0), function boundaries are correct
      if (depth <= 0) continue;

      // Unbalanced: scan forward from end to find matching '}'
      let remaining = depth;
      let foundEnd = null;
      for (let i = info.end; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') remaining++;
          else if (ch === '}') {
            remaining--;
            if (remaining === 0) {
              foundEnd = i + 1; // 1-indexed
              break;
            }
          }
        }
        if (foundEnd !== null) break;
      }

      if (foundEnd !== null && foundEnd > info.end) {
        info.end = foundEnd;
      }
    }

    // Re-sort overlapping: if a brace-expanded function now encloses others,
    // those inner functions should be kept (they're real inner functions).
    // No action needed - the function index supports overlapping ranges.

    // Shrink over-extended nested arrow functions. The initial end-setting
    // heuristic ("close previous function at next function start - 1") gets
    // the end wrong for `const foo = () => {...}` nested inside another
    // function: the next detected function-start is often hundreds of lines
    // past the arrow's real close. The naive brace-count post-process above
    // can't detect this because the over-extended range happens to be
    // brace-balanced overall.
    //
    // Fix: for entries whose start line is an arrow-assignment (=> {), use
    // the state-aware _findWrapperEnd to find the earliest balanced close.
    // That counts strings, template literals, line/block comments correctly
    // (but NOT regex literals — rare in practice; a function whose body has
    // `/}/` could false-close early, accepted limitation, same as #340).
    //
    // Scoped to arrow-assignment shapes only: regular `function foo() {`
    // declarations keep the existing post-process behavior unchanged. This
    // limits the blast radius of the state-machine swap.
    const arrowDeclRe = /(?:=>\s*\{|=\s*(?:async\s+)?(?:function\s*)?\([^)]*\)\s*(?:=>\s*)?\{)/;
    for (const [fname, info] of Object.entries(fileFunctions)) {
      if (info.start < 1 || info.start > lines.length) continue;
      const startLine = lines[info.start - 1] || '';
      if (!arrowDeclRe.test(startLine)) continue;
      const tightEnd = _findWrapperEnd(lines, info.start - 1);
      // Only shrink — never extend past whatever the prior pass produced.
      // Don't accept a degenerate result (same line or beyond file end).
      if (tightEnd > info.start && tightEnd < info.end) {
        info.end = tightEnd;
      }
    }

    return fileFunctions;
  }

  buildFunctionIndex(showProgress = true) {
    if (this.fileLines.size === 0) {
      console.log('No files loaded. Run buildIndex() first.');
      return;
    }
    if (showProgress) console.log('Building function index...');

    this.functionIndex = {};
    let totalFunctions = 0;

    for (const [filepath, fileLines] of this.fileLines) {
      const fileFuncs = this._parseFunctionsRegex(filepath);
      // Overlay esbuild-wrapper module functions (#340). These are the
      // `var NAME = HELPER(() => {...})` entries the regex scanner misses.
      // Harmless on non-esbuild files: _parseEsbuildWrappers returns {}
      // when no esbuild helper is detected at the file's head.
      if (/\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(filepath)) {
        const wrapped = _parseEsbuildWrappers(fileLines);
        for (const [name, info] of Object.entries(wrapped)) {
          if (!(name in fileFuncs)) fileFuncs[name] = info;
        }
      }
      if (Object.keys(fileFuncs).length > 0) {
        this.functionIndex[filepath] = fileFuncs;
        totalFunctions += Object.keys(fileFuncs).length;
      }
    }

    // Save
    fs.mkdirSync(this.indexPath, { recursive: true });
    fs.writeFileSync(this._functionIndexPath(),
                     JSON.stringify(this.functionIndex, null, 2), 'utf-8');

    this.parseMethod = 'regex';
    if (showProgress) {
      console.log(`Function index: ${totalFunctions} functions in ` +
                  `${Object.keys(this.functionIndex).length} files`);
    }
  }

  async buildFunctionIndexTreeSitter(showProgress = true) {
    if (this.fileLines.size === 0) {
      console.log('No files loaded. Run buildIndex() first.');
      return;
    }

    const { TreeSitterParser } = await import('./TreeSitterParser.js');
    const tsParser = new TreeSitterParser();
    const initOk = await tsParser.init();
    if (!initOk) {
      console.log('Warning: tree-sitter init failed, falling back to regex.');
      this.buildFunctionIndex(showProgress);
      return;
    }

    const available = tsParser.getAvailableGrammars();
    const missing = tsParser.getMissingGrammars();
    if (showProgress) {
      console.log(`Building function index with tree-sitter (${available.length} grammars available)...`);
      if (missing.length > 0) {
        console.log(`  Missing grammars (will use regex): ${missing.join(', ')}`);
      }
    }

    this.functionIndex = {};
    let totalFunctions = 0;
    let tsCount = 0;
    let regexCount = 0;
    let tsFailedCount = 0;

    for (const [filepath, lines] of this.fileLines) {
      let tsFuncs;
      try {
        tsFuncs = await tsParser.parseFunctions(filepath, lines);
      } catch (e) {
        // Tree-sitter parse error — fall back to regex for this file.
        // Previously tsFailedCount was declared but never incremented
        // (flagged by Codex code review 2026-04-17).
        tsFuncs = null;
        tsFailedCount++;
        if (showProgress) eprint(`  warn: tree-sitter failed on ${filepath}: ${e.message}`);
      }
      const regexFuncs = this._parseFunctionsRegex(filepath);
      let fileFuncs;

      if (tsFuncs && Object.keys(tsFuncs).length > 0) {
        // Hybrid merge: tree-sitter boundaries + regex-only entries (nested fns)
        fileFuncs = { ...tsFuncs };
        for (const [name, info] of Object.entries(regexFuncs)) {
          if (!(name in fileFuncs)) fileFuncs[name] = info;
        }
        tsCount++;
      } else if (tsFuncs === null) {
        // No grammar or parse failed — regex only
        fileFuncs = regexFuncs;
        regexCount++;
      } else {
        // tsFuncs was {} (parsed but found nothing) — use regex
        fileFuncs = regexFuncs;
        if (Object.keys(fileFuncs).length > 0) {
          regexCount++;
        } else {
          tsCount++;
        }
      }

      // Overlay esbuild-wrapper module functions (#340). Prefer tree-sitter
      // for finding wrapper bodies because the regex-based brace counter
      // doesn't track regex-literal state, and regex literals containing
      // `{`/`}` (common in syntax-highlighter rule sets like the one inside
      // cli.js's OZ4 module) cause wrapper end-lines to overshoot by
      // thousands of lines. Tree-sitter's parser handles regex literals
      // correctly. Fall back to the regex walker only when tree-sitter
      // can't help.
      if (/\.(?:js|mjs|cjs|ts|tsx|jsx)$/i.test(filepath)) {
        const helpers = _detectBundleHelpers(lines);
        let wrapped = null;
        if (helpers.esm || helpers.cjs) {
          wrapped = await tsParser.parseEsbuildWrappers(filepath, lines, helpers);
        }
        if (wrapped == null) {
          wrapped = _parseEsbuildWrappers(lines);
        }
        for (const [name, info] of Object.entries(wrapped)) {
          if (!(name in fileFuncs)) fileFuncs[name] = info;
        }
      }
      if (Object.keys(fileFuncs).length > 0) {
        this.functionIndex[filepath] = fileFuncs;
        totalFunctions += Object.keys(fileFuncs).length;
      }
    }

    // Save
    fs.mkdirSync(this.indexPath, { recursive: true });
    fs.writeFileSync(this._functionIndexPath(),
                     JSON.stringify(this.functionIndex, null, 2), 'utf-8');

    this.parseMethod = tsCount > 0 && regexCount > 0 ? 'tree-sitter+regex'
                     : tsCount > 0 ? 'tree-sitter' : 'regex';

    if (showProgress) {
      console.log(`Function index: ${totalFunctions} functions in ` +
                  `${Object.keys(this.functionIndex).length} files`);
      console.log(`  tree-sitter: ${tsCount} files, regex fallback: ${regexCount} files` +
                  (tsFailedCount > 0 ? `, tree-sitter failures: ${tsFailedCount}` : ''));
    }
  }

  _loadFunctionIndex() {
    const indexPath = this._functionIndexPath();
    if (!fs.existsSync(indexPath)) {
      this.functionIndex = {};
      return false;
    }
    try {
      const raw = fs.readFileSync(indexPath, 'utf-8');
      this.functionIndex = JSON.parse(raw);
      return true;
    } catch (e) {
      console.log(`Warning: Could not load function index: ${e.message}`);
      this.functionIndex = {};
      return false;
    }
  }

  _ensureFunctionIndex() {
    if (!this.functionIndex) {
      this._loadFunctionIndex();
    }
  }

  /**
   * Validate index integrity: check which required files exist and are parseable.
   * Returns { valid: boolean, files: { name: status }, warnings: string[] }
   */
  validateIndex() {
    const warnings = [];
    const files = {};
    const checks = [
      { name: 'literal_index.json',   path: this._literalIndexPath(),  required: true },
      { name: 'inverted_index.json',  path: this._invertedIndexPath(), required: true },
      { name: 'function_index.json',  path: this._functionIndexPath(), required: true },
    ];
    for (const c of checks) {
      if (!fs.existsSync(c.path)) {
        files[c.name] = 'missing';
        warnings.push(`${c.name} is missing` + (c.required ? ' (required)' : ''));
      } else {
        try {
          const stat = fs.statSync(c.path);
          if (stat.size === 0) {
            files[c.name] = 'empty';
            warnings.push(`${c.name} exists but is empty (0 bytes)`);
          } else {
            files[c.name] = 'ok';
          }
        } catch (e) {
          files[c.name] = 'unreadable';
          warnings.push(`${c.name} exists but cannot be read: ${e.message}`);
        }
      }
    }
    const valid = files['literal_index.json'] === 'ok' &&
                  files['function_index.json'] === 'ok' &&
                  files['inverted_index.json'] === 'ok';
    return { valid, files, warnings };
  }


  // ========================================================================
  // Build Index
  // ========================================================================

  /**
   * Build search index from a code directory, file, glob pattern, or @filelist.
   * @param {string} codePath
   * @param {object} [opts]
   * @param {number} [opts.chunkSize=50]
   * @param {boolean} [opts.showProgress=true]
   * @param {boolean} [opts.skipSemantic=true]
   * @returns {object} stats
   */
  async buildIndex(codePath, { chunkSize = 50, showProgress = true, skipSemantic = true, demanglerPath = null, useTreeSitter = false, renameMinLines = 0 } = {}) {
    const stats = { files_indexed: 0, total_lines: 0, chunks_created: 0, errors: [], prettified: 0 };
    const codePathStr = codePath.trim();

    let files = [];
    let basePath;

    if (codePathStr.startsWith('@')) {
      // @file.txt - list of files
      const listFile = codePathStr.slice(1);
      if (!fs.existsSync(listFile)) {
        console.log(`File list not found: ${listFile}`);
        return stats;
      }
      const isWSL = process.platform === 'linux' && fs.existsSync('/mnt/c');
      const fileList = fs.readFileSync(listFile, 'utf-8')
        .split('\n')
        .map(l => l.trim().replace(/\r$/, ''))
        .filter(l => l && !l.startsWith('#'))
        .map(l => {
          // Convert Windows paths to WSL /mnt/ paths when running under WSL
          if (isWSL && /^[A-Za-z]:\\/.test(l)) {
            return '/mnt/' + l[0].toLowerCase() + l.slice(2).replace(/\\/g, '/');
          }
          return l;
        });

      if (fileList.length === 0) {
        console.log(`No files listed in: ${listFile}`);
        return stats;
      }

      const existing = [];
      const missing = [];
      const expanded = [];
      for (const p of fileList) {
        if (!fs.existsSync(p)) { missing.push(p); continue; }
        // Allow directory entries in @filelist: walk them and include every
        // indexable file. Previously such entries errored later with
        // EISDIR when the indexer tried to readFileSync(dir). Also expand
        // glob patterns (`*`, `?`, `**`) from the list since those are a
        // natural way to specify "these specific subtrees."
        if (fs.statSync(p).isDirectory()) {
          const walked = this._walkDir(path.resolve(p));
          for (const f of walked) expanded.push(f);
          continue;
        }
        if (p.includes('*') || p.includes('?')) {
          const matched = _globSync(p.replace(/\\/g, '/'));
          for (const f of matched) expanded.push(path.resolve(f));
          continue;
        }
        existing.push(path.resolve(p));
      }
      for (const f of expanded) existing.push(f);
      if (missing.length > 0 && showProgress) {
        console.log(`Warning: ${missing.length} files not found (first 5: ${missing.slice(0, 5).join(', ')})`);
      }
      files = existing;
      basePath = files.length > 0 ? this._commonPath(files) : process.cwd();
      if (showProgress) {
        console.log(`Read ${files.length} files from: ${listFile}`);
      }

    } else if (codePathStr.includes('*') || codePathStr.includes('?')) {
      // Glob/wildcard pattern
      const globPattern = codePathStr.replace(/\\/g, '/');
      if (!globPattern.includes('**') && showProgress) {
        console.log(`Note: For recursive search, use **/*.ext`);
      }
      const matched = _globSync(globPattern);
      files = matched.map(p => path.resolve(p));
      basePath = files.length > 0 ? this._commonPath(files) : process.cwd();
      if (showProgress) {
        console.log(`Glob pattern '${codePathStr}' matched ${files.length} files`);
      }

    } else {
      // Single file or directory
      const resolved = path.resolve(codePathStr);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        files = [resolved];
        basePath = path.dirname(resolved);
      } else if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        files = this._walkDir(resolved);
        basePath = resolved;
      } else {
        console.log(`Path not found: ${resolved}`);
        return stats;
      }
    }

    this.basePath = basePath;
    if (codePathStr.startsWith('@')) {
      this.indexSource = `file list: ${codePathStr}`;
    } else if (codePathStr.includes('*') || codePathStr.includes('?')) {
      this.indexSource = `glob: ${codePathStr}`;
    } else {
      this.indexSource = basePath;
    }

    if (showProgress && !codePathStr.startsWith('@') && !codePathStr.includes('*')) {
      console.log(`Indexing ${files.length} files from: ${basePath}`);
    }

    // Separate files into categories: source, archive, executable, and skip
    const sourceFiles = [];
    const archiveFiles = [];
    const executableFiles = [];
    let mediaSkipped = 0;
    let unsupportedArchives = 0;

    for (const fp of files) {
      const ext = path.extname(fp).toLowerCase();
      const lower = fp.toLowerCase();
      // Check compound .tar.gz first
      if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
        if (isSupportedArchive(fp)) {
          archiveFiles.push(fp);
        } else {
          unsupportedArchives++;
        }
      } else if (ARCHIVE_EXTENSIONS.has(ext)) {
        if (isSupportedArchive(fp)) {
          archiveFiles.push(fp);
        } else {
          unsupportedArchives++;
        }
      } else if (MEDIA_BINARY_EXTENSIONS.has(ext)) {
        mediaSkipped++;
      } else if (EXECUTABLE_EXTENSIONS.has(ext) || BINSTRING_EXTENSIONS.has(ext)) {
        executableFiles.push(fp);
      } else {
        sourceFiles.push(fp);
      }
    }

    if (showProgress) {
      if (mediaSkipped > 0) {
        console.log(`  Skipped ${mediaSkipped} media/binary files (images, audio, video, fonts, docs)`);
      }
      if (unsupportedArchives > 0) {
        console.log(`  Skipped ${unsupportedArchives} unsupported archives (.7z, .rar, .bz2, .xz)`);
      }
      if (archiveFiles.length > 0) {
        console.log(`  Found ${archiveFiles.length} archive(s) to expand`);
      }
      if (executableFiles.length > 0) {
        console.log(`  Found ${executableFiles.length} executable(s) to process (binstrings)`);
      }
    }

    // SHA1 file-level dedup
    const seenHashes = new Map(); // sha1 -> firstRelPath
    const fileHashes = {};        // sha1 -> [allRelPaths]
    let dupesSkipped = 0;

    // Helper to add a file (by content + relPath) into the index
    const _addFileToIndex = (relPath, content, rawBytes) => {
      const fileHash = rawBytes
        ? crypto.createHash('sha1').update(rawBytes).digest('hex')
        : crypto.createHash('sha1').update(content, 'utf-8').digest('hex');

      if (!fileHashes[fileHash]) fileHashes[fileHash] = [];
      fileHashes[fileHash].push(relPath);

      if (seenHashes.has(fileHash)) {
        dupesSkipped++;
        return false;
      }
      seenHashes.set(fileHash, relPath);

      this.files.set(relPath, content);
      const lines = content.split('\n');
      this.fileLines.set(relPath, lines);
      stats.total_lines += lines.length;
      stats.files_indexed++;

      if (showProgress && stats.files_indexed % 100 === 0) {
        process.stdout.write(`  Indexed ${stats.files_indexed} files...\n`);
      }
      return true;
    };

    // --- Phase 1: Index regular source files ---
    for (const filePath of sourceFiles) {
      try {
        const rawBytes = fs.readFileSync(filePath);
        let content = rawBytes.toString('utf-8');

        let relPath;
        try {
          relPath = path.relative(basePath, filePath);
        } catch {
          relPath = path.basename(filePath);
        }
        relPath = relPath.replace(/\\/g, '/');

        // Deobfuscate/prettify minified JS/TS so functions are parseable
        if (isMinified(relPath, content)) {
          // Step 1: Simple regex deobfuscation (!0→true, !1→false, void 0→undefined)
          content = deobfuscateSimple(content);

          // Step 2: Try webcrack for small files (deobfuscation + prettification)
          const deobfuscated = await tryWebcrack(content);
          if (deobfuscated) {
            content = deobfuscated;
            stats.deobfuscated = (stats.deobfuscated || 0) + 1;
          } else {
            const jsBeautify = getJsBeautify();
            if (jsBeautify) {
              // Step 3: Fall back to js-beautify (formatting only)
              try {
                // break_chained_methods=true puts each `.foo()` in a chain on
                // its own line — critical for Commander.js-style `.option().option()`
                // chains (cli.js GCz) which otherwise stay as one 10K-char line.
                content = jsBeautify(content, {
                  indent_size: 2,
                  max_preserve_newlines: 2,
                  break_chained_methods: true,
                });
                stats.prettified++;
              } catch { /* beautify failed — use original */ }
            }
          }
        }


        _addFileToIndex(relPath, content, rawBytes);
      } catch (e) {
        stats.errors.push(`${filePath}: ${e.message}`);
      }
    }

    // --- Phase 2: Expand and index archives ---
    let totalArchiveFiles = 0;
    let totalBinstringsFromArchives = 0;
    for (const archivePath of archiveFiles) {
      try {
        let relArchive;
        try {
          relArchive = path.relative(basePath, archivePath);
        } catch {
          relArchive = path.basename(archivePath);
        }
        relArchive = relArchive.replace(/\\/g, '/');

        const archiveStats = createArchiveStats();
        const entries = expandArchive(archivePath, {
          archiveName: relArchive,
          extensions: this.extensions,
          showProgress,
          demanglerPath,
          stats: archiveStats,
        });

        for (const entry of entries) {
          try {
            _addFileToIndex(entry.virtualPath, entry.content, null);
          } catch (e) {
            stats.errors.push(`${entry.virtualPath}: ${e.message}`);
          }
        }

        totalArchiveFiles += archiveStats.files;
        totalBinstringsFromArchives += archiveStats.binstringsProcessed;
      } catch (e) {
        stats.errors.push(`Archive ${archivePath}: ${e.message}`);
      }
    }

    if (showProgress && totalArchiveFiles > 0) {
      console.log(`  Indexed ${totalArchiveFiles} files from ${archiveFiles.length} archive(s)`);
    }

    // --- Phase 3: Process executables via binstrings ---
    let binstringsProcessed = 0;
    for (const exePath of executableFiles) {
      try {
        const rawBytes = fs.readFileSync(exePath);

        let relPath;
        try {
          relPath = path.relative(basePath, exePath);
        } catch {
          relPath = path.basename(exePath);
        }
        relPath = relPath.replace(/\\/g, '/');

        const opResult = processBinary(rawBytes, relPath, { demanglerPath });
        if (opResult) {
          const opPath = relPath + '.op';
          _addFileToIndex(opPath, opResult.content, null);
          binstringsProcessed++;
        }
      } catch (e) {
        stats.errors.push(`Binstrings ${exePath}: ${e.message}`);
      }
    }

    if (showProgress && binstringsProcessed > 0) {
      console.log(`  Processed ${binstringsProcessed} executables (binstrings)`);
    }

    this.fileHashes = fileHashes;
    stats.dupes_skipped = dupesSkipped;
    stats.unique_files = seenHashes.size;
    stats.total_files_scanned = sourceFiles.length + totalArchiveFiles + binstringsProcessed;
    stats.archives_expanded = archiveFiles.length;
    stats.archive_files = totalArchiveFiles;
    stats.binstrings_processed = binstringsProcessed + totalBinstringsFromArchives;

    if (showProgress && dupesSkipped > 0) {
      const dupeGroups = Object.values(fileHashes).filter(p => p.length > 1).length;
      console.log(`  SHA1 dedup: ${dupesSkipped} duplicate files detected ` +
                  `(${dupeGroups} groups); originals indexed, copies tracked`);
    }

    // Save literal index
    this._saveLiteralIndex();

    // Free raw file contents — fileLines is sufficient for inverted + function indexing.
    // this.files will be reloaded from disk if the index is used after building.
    const fileCount = this.files.size;
    this.files = new Map();

    // Build inverted index
    this.buildInvertedIndex(50, showProgress);

    // Build function index
    if (useTreeSitter) {
      await this.buildFunctionIndexTreeSitter(showProgress);
    } else {
      this.buildFunctionIndex(showProgress);
    }

    // Infer descriptive names for ALL opaque-named functions.
    // Extracts top keywords from each function's body. Works on any codebase.
    // Saved as rename_map.json — applied at DISPLAY time, not to stored content.
    const { namesInferred, cmdRenames, importRenames } = this.inferAndSaveRenameMap({ showProgress, minFuncLines: renameMinLines });
    if (namesInferred > 0 || cmdRenames > 0 || importRenames > 0) {
      stats.namesInferred = namesInferred;
      stats.cmdRenames = cmdRenames;
      stats.importRenames = importRenames;
    }

    // Build string table
    if (showProgress) console.log('Building string table...');
    const stringCount = this.buildStringTable(8, showProgress);
    stats.strings = stringCount;

    // Reconstruct this.files from fileLines now that memory-heavy build is done.
    for (const [fp, lines] of this.fileLines) {
      this.files.set(fp, lines.join('\n'));
    }

    // Save literal index
    this._saveLiteralIndex();

    // Reload inverted index from disk (was streamed to disk, not kept in memory)
    this._loadInvertedIndex();

    if (showProgress) {
      let dedupNote = '';
      if (dupesSkipped > 0) {
        dedupNote = ` (${stats.total_files_scanned} scanned, ${dupesSkipped} duplicates registered)`;
      }
      let archiveNote = '';
      if (archiveFiles.length > 0) {
        archiveNote = `, ${totalArchiveFiles} from ${archiveFiles.length} archive(s)`;
      }
      let binNote = '';
      const totalBin = binstringsProcessed + totalBinstringsFromArchives;
      if (totalBin > 0) {
        binNote = `, ${totalBin} binaries processed`;
      }
      let prettyNote = '';
      const deob = stats.deobfuscated || 0;
      const pretty = stats.prettified || 0;
      const namesInferred = stats.namesInferred || 0;
      if (deob > 0 || pretty > 0 || namesInferred > 0) {
        const parts = [];
        if (deob > 0) parts.push(`${deob} deobfuscated`);
        if (pretty > 0) parts.push(`${pretty} prettified`);
        if (namesInferred > 0) parts.push(`${namesInferred} names inferred`);
        prettyNote = `, ${parts.join(', ')}`;
      }
      console.log(`Indexing complete: ${stats.files_indexed} files${dedupNote}${archiveNote}${binNote}${prettyNote}, ` +
                  `${stats.total_lines} lines, ${stats.chunks_created} chunks`);
    }

    return stats;
  }

  /**
   * Recursively walk a directory, returning files with matching extensions.
   * Skips common infrastructure directories that never contain project source.
   * @param {string} dirPath
   * @returns {string[]}
   */
  _walkDir(dirPath) {
    const results = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip common infrastructure directories
          const dirName = entry.name.toLowerCase();
          if (_SKIP_DIRS.has(dirName)) continue;
          // Skip CodeExam's own index directories (detected by the
          // presence of our index marker file, not by naming convention)
          if (fs.existsSync(path.join(fullPath, 'literal_index.json'))) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const lower = entry.name.toLowerCase();
          // Include source files (by extension, excluding compound like .d.ts)
          if (this.extensions.has(ext) &&
              !this._isCompoundExcluded(entry.name)) {
            results.push(fullPath);
          }
          // Also include supported archive files for expansion
          else if (isSupportedArchive(lower)) {
            results.push(fullPath);
          }
          // Also include executable files for binstrings processing
          else if (EXECUTABLE_EXTENSIONS.has(ext) || BINSTRING_EXTENSIONS.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    };
    walk(dirPath);
    return results;
  }

  /**
   * Check if a filename should be excluded due to a compound extension.
   * E.g., 'index.d.ts' is excluded when '.d.ts' is in _excludeCompound,
   * even though path.extname() would return '.ts'.
   * @param {string} filename - Just the filename (not full path)
   * @returns {boolean}
   */
  _isCompoundExcluded(filename) {
    if (this._excludeCompound.size === 0) return false;
    const lower = filename.toLowerCase();
    for (const ext of this._excludeCompound) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

  /**
   * Find common path prefix for an array of absolute paths.
   */
  _commonPath(paths) {
    if (paths.length === 0) return process.cwd();
    if (paths.length === 1) return path.dirname(paths[0]);
    const parts = paths.map(p => p.replace(/\\/g, '/').split('/'));
    const common = [];
    for (let i = 0; i < parts[0].length; i++) {
      const segment = parts[0][i];
      if (parts.every(p => p[i] === segment)) {
        common.push(segment);
      } else {
        break;
      }
    }
    const result = common.join(path.sep);
    // If result is a file, return its directory
    try {
      if (fs.existsSync(result) && fs.statSync(result).isFile()) {
        return path.dirname(result);
      }
    } catch { /* ignore */ }
    return result || process.cwd();
  }


  // ========================================================================
  // Search: Literal
  // ========================================================================

  /**
   * Literal text search across all indexed files.
   * @param {string} pattern - text or regex pattern
   * @param {object} [opts]
   * @param {boolean} [opts.caseSensitive=false]
   * @param {boolean} [opts.useRegex=false]
   * @param {number} [opts.maxResults=100]
   * @param {number} [opts.contextLines=3]
   * @returns {SearchResult[]}
   */
  searchLiteral(pattern, { caseSensitive = false, useRegex = false,
                           maxResults = 100, contextLines = 3,
                           filterStringContext = false } = {}) {
    if (this.files.size === 0) {
      console.log('No files indexed. Run buildIndex() first.');
      return [];
    }

    let regex;
    const flags = caseSensitive ? '' : 'i';
    try {
      regex = useRegex
        ? new RegExp(pattern, flags)
        : new RegExp(escapeRegex(pattern), flags);
    } catch (e) {
      console.log(`Invalid regex: ${e.message}`);
      return [];
    }

    // For string-context filtering we need match positions, not just boolean.
    // Build a global-flag version once and reuse via lastIndex.
    const reG = filterStringContext
      ? new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
      : null;

    const results = [];

    for (const [filePath, lines] of this.fileLines) {
      // #10: cross-line state for block-comment and template-literal tracking,
      // reset per file. Used only when filterStringContext is on.
      let carryState = 'code';

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const lineNum = lineIdx + 1;
        const line = lines[lineIdx];

        let matched;
        if (filterStringContext) {
          // Compute end state for next line BEFORE filtering this one
          const endState = _scanLineState(line, carryState);

          // If the line is wholly inside a block comment / template that
          // never exits, no match can possibly be valid — skip cleanly.
          const wholeLineSkipped =
            (carryState === 'bc' && endState === 'bc') ||
            (carryState === 't'  && endState === 't');

          if (wholeLineSkipped) {
            matched = false;
          } else {
            // Walk all matches; accept the line if any match falls outside a
            // string literal or comment context.
            reG.lastIndex = 0;
            matched = false;
            let m;
            while ((m = reG.exec(line)) !== null) {
              if (!_isInsideString(line, m.index, carryState)) {
                matched = true;
                break;
              }
              if (m[0].length === 0) reG.lastIndex++;
            }
          }

          // Carry over block-comment / template state to next line
          carryState = (endState === 'bc' || endState === 't') ? endState : 'code';
        } else {
          matched = regex.test(line);
        }

        if (!matched) continue;

        // Get context
        const start = Math.max(0, lineNum - contextLines - 1);
        const end = Math.min(lines.length, lineNum + contextLines);
        const ctxLines = lines.slice(start, end);
        const context = ctxLines
          .map((l, i) => `${String(start + i + 1).padStart(4)}: ${l}`)
          .join('\n');

        // Find containing function
        const funcName = this._findContainingFunction(filePath, lineNum);

        results.push(new SearchResult({
          filePath, lineNumber: lineNum,
          lineText: line.trim(),
          context, matchType: 'literal',
          score: 0.0, functionName: funcName,
        }));

        if (results.length >= maxResults) return results;
      }
    }
    return results;
  }


  // ========================================================================
  // Search: Inverted Index (fast)
  // ========================================================================

  /**
   * Fast search using inverted index.
   * @param {string} pattern
   * @param {object} [opts]
   * @param {boolean} [opts.useRegex=false]
   * @param {boolean} [opts.caseSensitive=false]
   * @param {number} [opts.maxResults=100]
   * @returns {SearchResult[]}
   */
  searchInverted(pattern, { useRegex = false, caseSensitive = false,
                            maxResults = 100 } = {}) {
    if (!this._ensureInvertedAvailable()) {
      console.log('No inverted index. Run with --build-index first.');
      return [];
    }

    let regex;
    const flags = caseSensitive ? '' : 'i';
    try {
      regex = useRegex
        ? new RegExp(pattern, flags)
        : new RegExp(escapeRegex(pattern), flags);
    } catch (e) {
      console.log(`Invalid regex: ${e.message}`);
      return [];
    }

    const results = [];

    this.forEachInvertedEntry((line, locations) => {
      if (!regex.test(line)) return;

      for (const [filepath, lineNumbers] of locations) {
        for (const lineNum of lineNumbers) {
          const funcName = this._findContainingFunction(filepath, lineNum);

          let ctx = line;
          const lines = this.fileLines.get(filepath);
          if (lines) {
            const start = Math.max(0, lineNum - 4);
            const end = Math.min(lines.length, lineNum + 3);
            ctx = lines.slice(start, end)
              .map((l, i) => `${String(start + i + 1).padStart(4)}: ${l}`)
              .join('\n');
          }

          results.push(new SearchResult({
            filePath: filepath, lineNumber: lineNum,
            lineText: line, context: ctx,
            matchType: 'inverted', score: 0.0,
            functionName: funcName,
          }));

          if (results.length >= maxResults) return false; // early stop
        }
      }
    });
    return results;
  }


  // ========================================================================
  // Search: Hybrid (literal + semantic)
  // ========================================================================

  searchHybrid(query, { maxResults = 10, contextLines = 3 } = {}) {
    const results = [];
    const seenLocations = new Set();

    // Literal search first
    const literalResults = this.searchLiteral(query, { maxResults, contextLines });
    for (const r of literalResults) {
      const loc = `${r.filePath}:${r.lineNumber}`;
      if (!seenLocations.has(loc)) {
        seenLocations.add(loc);
        results.push(r);
      }
    }

    // Semantic search would go here (Phase 8)

    return results;
  }


  // ========================================================================
  // Containing function lookup
  // ========================================================================

  /**
   * Get sorted function boundaries for fast bisect-based lookup.
   * Returns sorted array of [startLine, endLine, funcName].
   */
  _getFuncBoundaries(filepath) {
    this._ensureFunctionIndex();
    if (!this.functionIndex || !this.functionIndex[filepath]) return [];

    const funcs = this.functionIndex[filepath];
    const boundaries = [];
    for (const [name, info] of Object.entries(funcs)) {
      const start = info.start || 0;
      const end = info.end || 999999999;
      // Use full qualified name (e.g. "SecureChannel.encrypt_data")
      // so that callers can extract class context.
      boundaries.push([start, end, name]);
    }
    boundaries.sort((a, b) => a[0] - b[0]);
    return boundaries;
  }

  /**
   * Find containing function for a line number using bisect.
   */
  _bisectFuncLookup(boundaries, lineNum) {
    if (boundaries.length === 0) return null;
    // Binary search: find rightmost boundary whose start <= lineNum
    let lo = 0, hi = boundaries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (boundaries[mid][0] <= lineNum) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const idx = lo - 1;
    if (idx >= 0) {
      const [start, end, name] = boundaries[idx];
      if (start <= lineNum && lineNum <= end) {
        return name;
      }
    }
    return null;
  }

  /**
   * Find containing function/method for a given line.
   * Uses function index if available (fast), else backward regex scan (slow).
   */
  _findContainingFunction(filePath, lineNumber) {
    // Try fast bisect path first
    const boundaries = this._getFuncBoundaries(filePath);
    if (boundaries.length > 0) {
      return this._bisectFuncLookup(boundaries, lineNumber);
    }

    // Fallback: backward regex scan
    const lines = this.fileLines.get(filePath);
    if (!lines || lineNumber < 1 || lineNumber > lines.length) return null;

    const patterns = [
      [/^\s*(?:async\s+)?def\s+(\w+)\s*\(/, 1],
      [/^\s*class\s+(\w+)/, 1],
      [/^([\w]+(?:::[\w~]+)+)\s*\(/, 1],  // C++ multi-line: Class::Method( at column 0
      [/^\s*(?:[\w*&\s]+\s+)?(\w+)\s*\([^;]*$/, 1],
      [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, 1],
      [/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, 1],
      [/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/, 1],
      [/^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/, 1],
      [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, 1],
    ];

    const skipKw = CodeSearchIndex.SKIP_KEYWORDS;

    for (let i = lineNumber - 1; i >= 0; i--) {
      const line = lines[i];
      for (const [regex, groupIdx] of patterns) {
        const match = line.match(regex);
        if (match) {
          const name = match[groupIdx];
          if (name && !skipKw.has(name)) return name;
        }
      }
    }
    return null;
  }


  // ========================================================================
  // Function source extraction
  // ========================================================================

  /**
   * Extract complete source code for a function.
   */
  getFunctionSource(filepath, functionName) {
    this._ensureFunctionIndex();

    // Case-insensitive filepath matching
    const fpLower = filepath.toLowerCase();
    if (!this.functionIndex[filepath]) {
      const matches = Object.keys(this.functionIndex)
        .filter(f => fpLower === f.toLowerCase() || f.toLowerCase().includes(fpLower));
      if (matches.length === 1) {
        filepath = matches[0];
      } else if (matches.length > 1) {
        console.log(`Ambiguous filepath '${filepath}'. Matches: ${matches.slice(0, 5).join(', ')}`);
        return null;
      } else {
        console.log(`File not found in index: ${filepath}`);
        return null;
      }
    }

    const fileFuncs = this.functionIndex[filepath];

    let funcInfo;
    if (fileFuncs[functionName]) {
      funcInfo = fileFuncs[functionName];
    } else {
      // Try matching by base_name
      const matches = Object.entries(fileFuncs)
        .filter(([, info]) => (info.base_name || functionName) === functionName);

      if (matches.length === 0) {
        const available = Object.keys(fileFuncs).slice(0, 10).join(', ');
        console.log(`Function '${functionName}' not found. Available: ${available}`);
        return null;
      } else if (matches.length === 1) {
        funcInfo = matches[0][1];
      } else {
        console.log(`Multiple versions of '${functionName}' found:`);
        for (const [name, info] of matches) {
          console.log(`  ${name}: L${info.start}-${info.end}`);
        }
        return null;
      }
    }

    const lines = this.fileLines.get(filepath);
    if (!lines) {
      console.log(`File content not loaded: ${filepath}`);
      return null;
    }

    const start = funcInfo.start;
    let end = funcInfo.end;

    // Brace-balance check at extraction time.
    // Handles pre-built indexes where inner functions truncated the outer.
    // If the stored range has unbalanced braces, extend to the matching '}'.
    const startLine = lines[start - 1] || '';
    if (startLine.includes('{')) {
      let depth = 0;
      for (let li = start - 1; li < end && li < lines.length; li++) {
        for (const ch of lines[li]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
      }
      if (depth > 0) {
        // Unbalanced - scan forward to find matching '}'
        let remaining = depth;
        for (let li = end; li < lines.length; li++) {
          for (const ch of lines[li]) {
            if (ch === '{') remaining++;
            else if (ch === '}') {
              remaining--;
              if (remaining === 0) {
                end = li + 1; // 1-indexed
                break;
              }
            }
          }
          if (remaining === 0) break;
        }
      }
    }

    let rawLines = lines.slice(start - 1, end);

    // Trim trailing comments belonging to next function
    let trimEnd = rawLines.length;
    while (trimEnd > 1) {
      const line = rawLines[trimEnd - 1].trim();
      if (!line) { trimEnd--; continue; }
      if (line.startsWith('//') || line.startsWith('#') ||
          line.startsWith('*') || line.startsWith('/*') ||
          line.startsWith('/**') || line.endsWith('*/') ||
          line.startsWith('"""') || line.startsWith("'''") ||
          line.startsWith('@')) {
        trimEnd--;
      } else {
        break;
      }
    }
    rawLines = rawLines.slice(0, trimEnd);

    // Prepend preceding doc comment above function
    const commentLines = [];
    let i = start - 2; // 0-indexed: line above function def
    let consecutiveBlanks = 0;
    while (i >= 0) {
      const line = lines[i].trim();
      if (!line) {
        consecutiveBlanks++;
        if (consecutiveBlanks > 1) break;
        commentLines.unshift(lines[i]);
        i--;
      } else if (line.startsWith('//') || line.startsWith('#') ||
                 line.startsWith('*') || line.startsWith('/*') ||
                 line.startsWith('/**') || line.endsWith('*/') ||
                 line.startsWith('"""') || line.startsWith("'''") ||
                 line.startsWith('@')) {
        consecutiveBlanks = 0;
        commentLines.unshift(lines[i]);
        i--;
      } else {
        break;
      }
    }
    // Strip leading blank lines from collected comments
    while (commentLines.length > 0 && !commentLines[0].trim()) {
      commentLines.shift();
    }

    return [...commentLines, ...rawLines].join('\n');
  }


  // ========================================================================
  // Function listing & matching
  // ========================================================================

  /**
   * List all indexed functions, optionally filtered by file.
   * @param {string|null} filepath - optional substring filter
   * @returns {Array<{filepath,name,displayName,start,end,type,lines}>}
   */
  listFunctions(filepath = null) {
    this._ensureFunctionIndex();
    const results = [];
    const filterPath = filepath ? filepath.toLowerCase().replace(/\\/g, '/') : null;

    for (const [fpath, functions] of Object.entries(this.functionIndex || {})) {
      if (filterPath) {
        const fpathNorm = fpath.toLowerCase().replace(/\\/g, '/');
        if (!fpathNorm.includes(filterPath)) continue;
      }
      for (const [name, info] of Object.entries(functions)) {
        const lineCount = info.end - info.start + 1;
        results.push({
          filepath: fpath,
          name,
          displayName: displayName(name, fpath),
          start: info.start,
          end: info.end,
          type: info.type,
          lines: lineCount,
        });
      }
    }
    return results;
  }

  /**
   * Find all functions matching a name, optionally filtered by file path.
   */
  findFunctionMatches(funcName, fileHint = null) {
    this._ensureFunctionIndex();
    const fileHintNorm = fileHint ? fileHint.toLowerCase().replace(/\\/g, '/') : null;
    // If the caller supplied a display name (renamed form), reverse-resolve to
    // the indexed (bare/original) name so callers from the GUI — which get
    // display names in list responses — can round-trip back.
    if (this.getOriginalName) {
      const orig = this.getOriginalName(funcName);
      if (orig && orig !== funcName) funcName = orig;
    }
    const wasQualified = funcName.includes('.') || funcName.includes('::');
    const funcNameNorm = (funcName.includes('.') && !funcName.includes('::'))
      ? funcName.replace(/\./g, '::')
      : funcName;
    const bareName = funcNameNorm.includes('::')
      ? funcNameNorm.split('::').pop()
      : funcNameNorm;

    const matches = [];

    for (const [filepath, functions] of Object.entries(this.functionIndex || {})) {
      if (fileHintNorm) {
        const fpNorm = filepath.toLowerCase().replace(/\\/g, '/');
        if (!fpNorm.includes(fileHintNorm)) continue;
      }

      for (const [fullName, info] of Object.entries(functions)) {
        let indexedBare = info.base_name || fullName.split('::').pop();
        if (indexedBare.includes('@')) indexedBare = indexedBare.split('@')[0];
        const fullNameBase = fullName.includes('@') ? fullName.split('@')[0] : fullName;

        let isMatch = false;
        if (wasQualified) {
          if (fullNameBase === funcNameNorm || fullName === funcNameNorm) {
            isMatch = true;
          }
        } else {
          if (fullName === funcNameNorm || indexedBare === bareName ||
              fullName.endsWith('::' + bareName)) {
            isMatch = true;
          }
        }

        if (isMatch) {
          matches.push({
            filepath, name: fullName,
            start: info.start, end: info.end,
            type: info.type || 'function',
          });
        }
      }
    }
    return matches;
  }

  /**
   * Extract function source by name, with optional file hint.
   */
  extractFunctionByName(funcName, fileHint = null) {
    const matches = this.findFunctionMatches(funcName, fileHint);

    if (matches.length === 0) {
      if (fileHint) {
        console.log(`Function '${funcName}' not found in files matching '${fileHint}'.`);
        console.log(`  Tip: Use --list-functions "${funcName}" --full-path to find exact paths`);
      } else {
        console.log(`Function '${funcName}' not found in index.`);
        console.log(`  Tip: Use --list-functions "PATTERN" --full-path to search`);
      }
      return null;
    }

    if (matches.length === 1) {
      const m = matches[0];
      const source = this.getFunctionSource(m.filepath, m.name);
      if (source) {
        console.log(`# ${m.filepath}@${displayName(m.name, m.filepath)}`);
        return source;
      }
      return null;
    }

    // Multiple matches
    this._lastExtractMatches = matches;
    console.log(`Multiple functions match '${funcName}':`);
    for (let i = 0; i < Math.min(matches.length, 20); i++) {
      const m = matches[i];
      const lines = m.end - m.start + 1;
      console.log(`  [${i + 1}] ${m.filepath}@${displayName(m.name, m.filepath)} (${lines} lines)`);
    }
    if (matches.length > 20) {
      console.log(`  ... and ${matches.length - 20} more`);
    }
    console.log(`\nSelect by number: /extract [N]  or narrow with: /extract FILE@FUNCTION`);
    return null;
  }


  // ========================================================================
  // Path matching and file listing
  // ========================================================================

  listFiles() {
    return [...this.files.keys()].sort();
  }

  findPathMatches(pattern) {
    if (!pattern || pattern.length < 2) return [];
    const patLower = pattern.toLowerCase();
    const fileMatches = [];

    for (const filepath of this.files.keys()) {
      if (filepath.toLowerCase().includes(patLower)) {
        fileMatches.push(filepath);
      }
    }

    const dirsSeen = new Set();
    for (const filepath of fileMatches) {
      const parts = filepath.replace(/\\/g, '/').split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].toLowerCase().includes(patLower)) {
          const dirPath = parts.slice(0, i + 1).join('/');
          dirsSeen.add(dirPath);
        }
      }
    }

    return [...dirsSeen].sort().concat(fileMatches.filter(f => !dirsSeen.has(f)));
  }

  /**
   * Scan a directory and count all file extensions.
   * @param {string} dirPath
   * @returns {Object<string, number>}
   */
  static scanExtensions(dirPath) {
    if (!fs.existsSync(dirPath)) {
      console.log(`Path not found: ${dirPath}`);
      return {};
    }
    const counts = {};
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();
          if (_SKIP_DIRS.has(dirName)) continue;
          if (fs.existsSync(path.join(full, 'literal_index.json'))) continue;
          walk(full);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase() || '(no extension)';
          counts[ext] = (counts[ext] || 0) + 1;
        }
      }
    };
    walk(dirPath);
    // Sort by count descending
    return Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1])
    );
  }


  // ========================================================================
  // Stats
  // ========================================================================

  getStats() {
    let totalLines = 0;
    for (const lines of this.fileLines.values()) {
      totalLines += lines.length;
    }
    const stats = {
      files_indexed: this.files.size,
      total_lines: totalLines,
      semantic_available: false,
      parse_method: this.parseMethod || 'regex',
    };

    const fileHashes = this.fileHashes || {};
    const hashEntries = Object.values(fileHashes);
    if (hashEntries.length > 0) {
      const dupeGroups = hashEntries.filter(p => p.length > 1).length;
      const totalDupes = hashEntries.filter(p => p.length > 1)
        .reduce((sum, p) => sum + p.length - 1, 0);
      stats.unique_hashes = hashEntries.length;
      stats.dupe_groups = dupeGroups;
      stats.dupes_removed = totalDupes;
    }
    return stats;
  }

  // ========================================================================
  // Dupe helpers (used by browse commands)
  // ========================================================================

  _buildFileDupeLookup() {
    if (this._fileDupeLookup) return this._fileDupeLookup;
    const lookup = {};
    for (const paths of Object.values(this.fileHashes || {})) {
      if (paths.length > 1) {
        for (const p of paths) {
          lookup[p] = paths.filter(x => x !== p);
        }
      }
    }
    this._fileDupeLookup = lookup;
    return lookup;
  }

  getFileDupeCount(filepath) {
    const lookup = this._buildFileDupeLookup();
    return (lookup[filepath] || []).length;
  }

  getFileDupes(filepath) {
    const lookup = this._buildFileDupeLookup();
    return lookup[filepath] || [];
  }


  // ========================================================================
  // Containing function lookup (from index - more accurate)
  // ========================================================================

  /**
   * Find the function containing a given line using the function index.
   * More accurate than regex-based _findContainingFunction - handles nesting.
   */
  _findContainingFunctionFromIndex(filepath, lineNumber) {
    this._ensureFunctionIndex();
    if (!this.functionIndex || !this.functionIndex[filepath]) {
      // Try partial match
      const matches = Object.keys(this.functionIndex || {})
        .filter(f => filepath.toLowerCase() === f.toLowerCase() || f.toLowerCase().includes(filepath.toLowerCase()));
      if (matches.length === 1) {
        filepath = matches[0];
      } else {
        return null;
      }
    }

    const fileFuncs = this.functionIndex[filepath] || {};
    let containing = null;
    let containingSize = Infinity;

    for (const [funcName, info] of Object.entries(fileFuncs)) {
      if (info.start <= lineNumber && lineNumber <= info.end) {
        const size = info.end - info.start;
        if (size < containingSize) {
          containing = funcName;
          containingSize = size;
        }
      }
    }
    return containing;
  }


  // ========================================================================
  // Known functions cache
  // ========================================================================

  /**
   * Build and cache a lookup of all known function bare names -> definitions.
   * Also builds a qualified index (Class::method -> definitions) for disambiguation.
   * @returns {Object<string, Array>} bare_name -> [{filepath, full_name, start, end, type, class_name}]
   */
  _getKnownFunctions() {
    if (this._knownFunctionsCache) return this._knownFunctionsCache;

    this._ensureFunctionIndex();
    const known = Object.create(null);
    const qualified = Object.create(null);  // "Class::method" -> [defs]

    for (const [fpath, functions] of Object.entries(this.functionIndex || {})) {
      for (const [fname, info] of Object.entries(functions)) {
        let bare = fname.includes('::') ? fname.split('::').pop() : fname;
        bare = bare.includes('.') ? bare.split('.').pop() : bare;

        // Extract class name from qualified "Class::method"
        let className = null;
        if (fname.includes('::')) {
          const parts = fname.split('::');
          if (parts.length >= 2) {
            className = parts.slice(0, -1).join('::');
          }
        }

        const def = {
          filepath: fpath,
          full_name: fname,
          start: info.start,
          end: info.end,
          type: info.type || 'function',
          class_name: className,
        };

        if (!known[bare]) known[bare] = [];
        known[bare].push(def);

        // Qualified index
        if (className) {
          const qKey = `${className}::${bare}`;
          if (!qualified[qKey]) qualified[qKey] = [];
          qualified[qKey].push(def);
        }
      }
    }

    this._knownFunctionsCache = known;
    this._qualifiedFunctionsCache = qualified;
    return known;
  }

  /**
   * Get the qualified functions cache (Class::method -> defs).
   * Must call _getKnownFunctions() first.
   */
  _getQualifiedFunctions() {
    if (!this._qualifiedFunctionsCache) this._getKnownFunctions();
    return this._qualifiedFunctionsCache;
  }

  /**
   * Build and cache a map of class -> [parent classes] from source code.
   * Parses inheritance patterns for Python, C++, Java, JS/TS, C#, Ruby.
   *
   * @returns {Map<string, string[]>} className -> [parentClassNames]
   */
  _getInheritanceMap() {
    if (this._inheritanceMapCache) return this._inheritanceMapCache;

    const imap = new Map();

    // Patterns: each yields [childName, ...parentNames]
    const patterns = [
      // Python: class Child(Parent):  or  class Child(Base, Mixin):
      /^\s*class\s+(\w+)\s*\(\s*([^)]+)\s*\)\s*:/,
      // C++: class Derived : public Base {  or  class D : public B, public C {
      // Also handles private/protected inheritance
      /^\s*(?:template\s*<[^>]*>\s*)?class\s+(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:\([^)]*\))?\s+)*(\w+)\s*:\s*(.+?)\s*\{/,
      // C++ struct: struct Derived : Base {
      /^\s*(?:template\s*<[^>]*>\s*)?struct\s+(\w+)\s*:\s*(.+?)\s*\{/,
      // Java/C#: class Sub extends Super {  or  class Sub extends Super implements I, J {
      /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*class\s+(\w+)\s+extends\s+(\w+)/,
      // Java/C# implements (secondary parents)
      /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*class\s+(\w+)\s+(?:extends\s+\w+\s+)?implements\s+(.+?)(?:\s*\{|$)/,
      // JS/TS: class Child extends Parent {
      /^\s*(?:export\s+)?class\s+(\w+)\s+extends\s+(\w+)/,
      // Ruby: class Child < Parent
      /^\s*class\s+(\w+)\s*<\s*(\w+)/,
      // Objective-C: @interface Child : Parent
      /^\s*@interface\s+(\w+)\s*:\s*(\w+)/,
    ];

    // Pre-filter: only scan files that contain class declarations (from function index).
    // This avoids scanning all fileLines on large indexes (20K+ files → OOM).
    let filesToScan;
    this._ensureFunctionIndex();
    if (this.functionIndex && Object.keys(this.functionIndex).length > 0) {
      const classFiles = new Set();
      for (const [fpath, functions] of Object.entries(this.functionIndex)) {
        for (const info of Object.values(functions)) {
          if (info.type === 'class') { classFiles.add(fpath); break; }
        }
      }
      // Also include files whose names suggest class definitions but weren't indexed as classes
      // (e.g., files with 'extends' or inheritance that the function parser missed)
      filesToScan = classFiles.size > 0 ? classFiles : null;
    } else {
      filesToScan = null;  // no function index → scan all
    }

    for (const [filepath, lines] of this.fileLines) {
      if (filesToScan && !filesToScan.has(filepath)) continue;
      for (const line of lines) {
        for (const pat of patterns) {
          const m = pat.exec(line);
          if (!m) continue;

          const childName = m[1];
          const parentStr = m[2];

          // Parse parent names from the match
          const parents = [];
          // Split by comma, strip qualifiers like "public", "protected", "private", generic params
          for (let p of parentStr.split(',')) {
            p = p.trim()
              .replace(/^\s*(?:public|private|protected|virtual)\s+/g, '')
              .replace(/<[^>]*>/g, '')  // strip generics
              .trim();
            // Extract just the class name (last word)
            const nameMatch = p.match(/(\w+)\s*$/);
            if (nameMatch) {
              const parentName = nameMatch[1];
              // Skip common non-class tokens
              if (!['object', 'Object', 'type', 'class', 'struct', 'enum'].includes(parentName)) {
                parents.push(parentName);
              }
            }
          }

          if (parents.length > 0) {
            // Merge with any existing parents (could be declared in multiple files)
            const existing = imap.get(childName) || [];
            for (const p of parents) {
              if (!existing.includes(p)) existing.push(p);
            }
            imap.set(childName, existing);
          }
          break; // Only first matching pattern per line
        }
      }
    }

    this._inheritanceMapCache = imap;
    return imap;
  }

  /**
   * Get all ancestor classes for a given class, walking up the inheritance chain.
   * Returns ancestors in order: immediate parents first, then grandparents, etc.
   * Handles diamond inheritance and cycles safely.
   *
   * @param {string} className
   * @returns {string[]} ancestor class names
   */
  _getAncestorClasses(className) {
    const imap = this._getInheritanceMap();
    const ancestors = [];
    const visited = new Set();
    const queue = [className];
    visited.add(className);

    while (queue.length > 0) {
      const current = queue.shift();
      const parents = imap.get(current);
      if (!parents) continue;
      for (const p of parents) {
        if (!visited.has(p)) {
          visited.add(p);
          ancestors.push(p);
          queue.push(p);
        }
      }
    }
    return ancestors;
  }

  // ============================================================================
  // Call analysis — implementations moved to ./calls.js (Issue #18 Phase 2)
  // ============================================================================
  findCallers(...args) { return _findCallers(this, ...args); }
  findCallees(...args) { return _findCallees(this, ...args); }
  getCallInventory(...args) { return _getCallInventory(this, ...args); }
  getCallCounts(...args) { return _getCallCounts(this, ...args); }
  findDefinitions(...args) { return _findDefinitions(this, ...args); }
  getCallCountsWithDefinitions(...args) { return _getCallCountsWithDefinitions(this, ...args); }
  getAllFileDeps(...args) { return _getAllFileDeps(this, ...args); }


  // ========================================================================
  // Phase 3: Metrics / discovery methods
  // ========================================================================

  /**
   * Build class inheritance hierarchy tree.
   * Returns { roots, externalRoots, standalone, totalClasses, totalRelationships }
   *   roots: tree nodes for classes whose parents aren't in the index (true roots)
   *   externalRoots: tree nodes grouped under an external parent name
   *   standalone: classes with no inheritance relationships
   * Each node: { name, filepath, start, end, lines, methodCount, children }
   */
  getClassHierarchy(filter = null) {
    this._ensureFunctionIndex();
    const imap = this._getInheritanceMap();  // Map<child, parents[]>

    // Single-pass class scan: collect classes, then count methods in same loop.
    // Avoids the expensive listClasses() which builds full method arrays.
    const classInfo = {};
    const pendingMethods = [];  // [{name, fpath}] — resolved after classes known
    for (const [fpath, functions] of Object.entries(this.functionIndex)) {
      for (const [name, info] of Object.entries(functions)) {
        if (info.type === 'class') {
          const bare = name.includes('::') ? name.split('::').pop() : name;
          if (!classInfo[bare]) {
            classInfo[bare] = {
              name: bare, filepath: fpath,
              start: info.start || 0, end: info.end || 0,
              lines: (info.end || 0) - (info.start || 0) + 1,
              methodCount: 0,
            };
          }
        } else if (info.type === 'method' || info.type === 'function') {
          if (name.includes('::') || name.includes('.')) {
            pendingMethods.push(name);
          }
        }
      }
    }
    // Resolve method counts (lightweight — just string prefix checks)
    const classNameSet = new Set(Object.keys(classInfo));
    for (const name of pendingMethods) {
      const sep = name.includes('::') ? '::' : '.';
      const prefix = name.slice(0, name.indexOf(sep));
      if (classNameSet.has(prefix) && classInfo[prefix]) classInfo[prefix].methodCount++;
    }

    // Build parent->children map (reverse of imap)
    const childrenOf = {};   // parentName -> [childName]
    const allInvolved = new Set();  // all class names that appear in any relationship
    let totalRelationships = 0;

    for (const [child, parents] of imap) {
      allInvolved.add(child);
      for (const p of parents) {
        allInvolved.add(p);
        if (!childrenOf[p]) childrenOf[p] = [];
        childrenOf[p].push(child);
        totalRelationships++;
      }
    }

    // Apply filter
    const pat = filter ? filter.toLowerCase() : null;
    const matchesFilter = (name) => {
      if (!pat) return true;
      if (name.toLowerCase().includes(pat)) return true;
      const info = classInfo[name];
      if (info && info.filepath && info.filepath.toLowerCase().includes(pat)) return true;
      return false;
    };

    // When filtering, expand to include ancestors and descendants of matches
    let relevantNames = null;
    if (pat) {
      relevantNames = new Set();
      const addAncestors = (name, visited) => {
        if (visited.has(name)) return;
        visited.add(name);
        relevantNames.add(name);
        const parents = imap.get(name);
        if (parents) for (const p of parents) addAncestors(p, visited);
      };
      const addDescendants = (name, visited) => {
        if (visited.has(name)) return;
        visited.add(name);
        relevantNames.add(name);
        const kids = childrenOf[name];
        if (kids) for (const k of kids) addDescendants(k, visited);
      };
      for (const name of allInvolved) {
        if (matchesFilter(name)) {
          addAncestors(name, new Set());
          addDescendants(name, new Set());
        }
      }
      // Also check standalone classes
      for (const name of Object.keys(classInfo)) {
        if (matchesFilter(name)) relevantNames.add(name);
      }
    }

    const isRelevant = (name) => !relevantNames || relevantNames.has(name);

    // Build tree nodes recursively
    const buildNode = (name, visited) => {
      if (visited.has(name)) return null;  // cycle protection
      visited.add(name);
      const info = classInfo[name];
      const node = {
        name,
        filepath: info ? info.filepath : null,
        start: info ? info.start : 0,
        end: info ? info.end : 0,
        lines: info ? info.lines : 0,
        methodCount: info ? info.methodCount : 0,
        external: !info,  // not in function index
        children: [],
      };
      const kids = childrenOf[name] || [];
      for (const kid of kids.sort()) {
        if (!isRelevant(kid)) continue;
        const childNode = buildNode(kid, new Set(visited));
        if (childNode) node.children.push(childNode);
      }
      return node;
    };

    // Identify roots: classes that have children but no parents in the index
    // or whose parents are all external
    const roots = [];
    const externalRoots = [];  // grouped by external parent name
    const externalGroups = {};  // externalParentName -> [childNodes]

    // Find classes that are parents (have children) but have no parents themselves
    const hasParent = new Set(imap.keys());

    for (const name of allInvolved) {
      if (!isRelevant(name)) continue;
      const parents = imap.get(name);
      const isChild = parents && parents.length > 0;

      if (!isChild && childrenOf[name]) {
        // This is a root: has children, no parents
        const node = buildNode(name, new Set());
        if (node && (node.children.length > 0 || !node.external)) {
          if (node.external) {
            externalGroups[name] = node;
          } else {
            roots.push(node);
          }
        }
      }
    }

    // Also find classes whose parents are ALL external (they appear as roots too)
    for (const [child, parents] of imap) {
      if (!isRelevant(child)) continue;
      const allParentsExternal = parents.every(p => !classInfo[p]);
      const noParentIsRoot = !parents.some(p => allInvolved.has(p) && !imap.has(p));
      // If all parents are external, group under each external parent
      if (allParentsExternal) {
        for (const p of parents) {
          if (!externalGroups[p]) {
            externalGroups[p] = buildNode(p, new Set());
          }
        }
      }
    }

    // Collect external root nodes
    for (const [name, node] of Object.entries(externalGroups).sort(([a], [b]) => a.localeCompare(b))) {
      if (node && node.children.length > 0) externalRoots.push(node);
    }

    // Sort roots by name
    roots.sort((a, b) => a.name.localeCompare(b.name));

    // Standalone: classes in the index but not involved in any inheritance
    const standalone = [];
    for (const name of Object.keys(classInfo)) {
      if (!allInvolved.has(name) && isRelevant(name)) {
        standalone.push(classInfo[name]);
      }
    }
    standalone.sort((a, b) => a.name.localeCompare(b.name));

    return {
      roots,
      externalRoots,
      standalone,
      totalClasses: Object.keys(classInfo).length,
      totalRelationships,
    };
  }

  /**
   * List all indexed classes with aggregated method stats.
   * Handles cross-file method association (e.g., methods in .cpp, class in .h).
   */
  listClasses(filepath = null) {
    this._ensureFunctionIndex();
    const filterPath = filepath ? filepath.toLowerCase().replace(/\\/g, '/') : null;

    // First pass: collect all classes
    const allClasses = {};
    for (const [fpath, functions] of Object.entries(this.functionIndex)) {
      for (const [name, info] of Object.entries(functions)) {
        if (info.type === 'class') {
          const bare = name.includes('::') ? name.split('::').pop() : name;
          if (!(bare in allClasses)) {
            allClasses[bare] = {
              filepath: fpath,
              name,
              start: info.start,
              end: info.end,
              lines: info.end - info.start + 1,
              method_count: 0,
              total_method_lines: 0,
              methods: [],
            };
          }
        }
      }
    }

    // Second pass: associate methods with classes (cross-file).
    // Build a Set for O(1) class-name lookup instead of O(classes) per function.
    const classNameSet = new Set(Object.keys(allClasses));

    // Also collect unresolved :: prefixes for class inference (sub-task b)
    const unresolvedMethods = [];  // { className, name, filepath, info }

    for (const [fpath, functions] of Object.entries(this.functionIndex)) {
      for (const [name, info] of Object.entries(functions)) {
        if (info.type !== 'method' && info.type !== 'function') continue;

        // Extract potential class name from function name
        // Patterns: ClassName::method, ClassName.method, Outer::ClassName::method
        let className = null;
        if (name.includes('::')) {
          const parts = name.split('::');
          // Try each prefix segment as a class name
          for (let i = 0; i < parts.length - 1; i++) {
            if (classNameSet.has(parts[i])) {
              className = parts[i];
              break;
            }
          }
          // If no class found, track for inference pass
          if (!className && parts.length >= 2) {
            unresolvedMethods.push({
              className: parts[parts.length - 2],  // immediate parent
              name, filepath: fpath, info,
            });
          }
        } else if (name.includes('.')) {
          const dotPrefix = name.split('.')[0];
          if (classNameSet.has(dotPrefix)) {
            className = dotPrefix;
          }
        }

        if (className && allClasses[className]) {
          const methodLines = info.end - info.start + 1;
          allClasses[className].method_count++;
          allClasses[className].total_method_lines += methodLines;
          allClasses[className].methods.push({
            name, filepath: fpath,
            start: info.start, end: info.end, lines: methodLines,
          });
        }
      }
    }

    // Third pass: infer classes from :: prefixes that weren't found in pass 1.
    // If we see OcclusionTracker::Method but no "class OcclusionTracker" was indexed,
    // create a synthetic (inferred) class entry and associate its methods.
    if (unresolvedMethods.length > 0) {
      // Group unresolved methods by inferred class name
      const inferredGroups = {};
      for (const m of unresolvedMethods) {
        const cn = m.className;
        // Skip obvious non-class names: all-lowercase, single char, keywords
        if (/^[a-z]/.test(cn) || cn.length <= 1) continue;
        if (CodeSearchIndex.SKIP_KEYWORDS.has(cn)) continue;
        // Skip names that are already known classes
        if (classNameSet.has(cn)) continue;

        if (!inferredGroups[cn]) inferredGroups[cn] = [];
        inferredGroups[cn].push(m);
      }

      for (const [cn, methods] of Object.entries(inferredGroups)) {
        // Only infer a class if it has at least 1 method (always true here)
        // Use the first method's file as the class "location"
        const firstMethod = methods[0];
        const methodLines = methods.reduce((sum, m) =>
          sum + (m.info.end - m.info.start + 1), 0);

        allClasses[cn] = {
          filepath: firstMethod.filepath,
          name: cn,
          start: firstMethod.info.start,
          end: firstMethod.info.end,
          lines: 0,  // no class body - inferred from methods
          method_count: methods.length,
          total_method_lines: methodLines,
          inferred: true,  // flag so display can note this
          methods: methods.map(m => ({
            name: m.name,
            filepath: m.filepath,
            start: m.info.start,
            end: m.info.end,
            lines: m.info.end - m.info.start + 1,
          })),
        };
      }
    }

    let results = Object.values(allClasses);
    if (filterPath) {
      results = results.filter(c => c.filepath.toLowerCase().replace(/\\/g, '/').includes(filterPath));
    }
    return results;
  }

  /**
   * Count how many definitions exist for each bare function name.
   */
  _getBareNameCounts() {
    const counts = Object.create(null);
    const allFuncs = this.listFunctions();
    for (const f of allFuncs) {
      let bare = f.name.includes('::') ? f.name.split('::').pop() : f.name;
      if (bare.includes('@')) bare = bare.split('@')[0];
      counts[bare] = (counts[bare] || 0) + 1;
    }
    return counts;
  }

  // ============================================================================
  // Hotspots — implementations moved to ./hotspots.js (Issue #18 Phase 2)
  // ============================================================================
  getHotspots(...args) { return _getHotspots(this, ...args); }
  getEntryPoints(...args) { return _getEntryPoints(this, ...args); }
  getDomainHotspots(...args) { return _getDomainHotspots(this, ...args); }
  getClassHotspots(...args) { return _getClassHotspots(this, ...args); }

  // ============================================================================
  // Structural fingerprinting — implementations moved to ./structural-fingerprint.js
  // (Issue #18 Phase 2). STRUCTURE_KEYWORDS is also exported from that module
  // and imported back at the top of this file for the Vocabulary code path.
  // ============================================================================
  getStructuralNormalized(bodyText) { return _getStructuralNormalized(bodyText); }
  getStructuralHash(bodyText) { return _getStructuralHash(bodyText); }
  getStructuralNormalizedTight(bodyText) { return _getStructuralNormalizedTight(bodyText); }
  getStructuralHashTight(bodyText) { return _getStructuralHashTight(bodyText); }
  extractWordHoles(bodyText) { return _extractWordHoles(bodyText); }
  structDiff(bodies) { return _structDiff(bodies); }

  /**
   * Path to func_hashes.json cache file.
   */
  _funcHashesPath() {
    return path.join(this.indexPath, 'func_hashes.json');
  }

  /**
   * Ensure function hashes are computed, using cache if available.
   *
   * Returns Map: (filepath, funcName) -> { body_hash, struct_hash, lines, asm_ops }
   *
   * Caches to func_hashes.json for fast subsequent loads.
   */
  ensureFuncHashes(minLines = 3, showProgress = true) {
    // Already computed this session?
    if (this._funcHashes) return this._funcHashes;

    const cachePath = this._funcHashesPath();

    // Try to load from cache
    if (fs.existsSync(cachePath)) {
      try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const cached = JSON.parse(raw);
        // Check if cache has asm_ops field (added later)
        const sampleKey = Object.keys(cached)[0];
        if (sampleKey && cached[sampleKey] && !('asm_ops' in cached[sampleKey])) {
          if (showProgress) console.log('Cache missing asm_ops field, rebuilding...');
          // fall through
        } else {
          this._funcHashes = new Map();
          for (const [keyStr, val] of Object.entries(cached)) {
            const sep = keyStr.indexOf('|||');
            if (sep >= 0) {
              this._funcHashes.set(keyStr, val);
            }
          }
          if (showProgress) console.log(`Loaded ${this._funcHashes.size} cached function hashes`);
          return this._funcHashes;
        }
      } catch (e) {
        if (showProgress) console.log(`Cache load failed, recomputing: ${e.message}`);
      }
    }

    // Compute hashes
    const allFuncs = this.listFunctions();
    if (showProgress) console.log(`Hashing ${allFuncs.length} function bodies...`);

    // Regex to detect opstring MD5 in .op files
    const opstringMd5Re = /\/\/\s*\[(\d+)\s+asm\]\s+([0-9A-Fa-f]{8,})/;
    let opstringCount = 0;

    this._funcHashes = new Map();
    for (const f of allFuncs) {
      if (f.lines < minLines) continue;

      const fp = f.filepath;
      const lines = this.fileLines.get(fp);
      if (!lines) continue;

      const bodyLines = lines.slice(f.start - 1, f.end);
      const bodyText = bodyLines.join('\n');

      // Check for opstring MD5
      const opMatch = bodyText.match(opstringMd5Re);
      let bodyHash, structHash, asmOps;

      if (opMatch) {
        asmOps = parseInt(opMatch[1]);
        const opMd5 = opMatch[2].toLowerCase();
        bodyHash = opMd5;
        structHash = opMd5;
        opstringCount++;
      } else {
        asmOps = 0;
        bodyHash = crypto.createHash('sha1').update(bodyText, 'utf-8').digest('hex');
        structHash = this.getStructuralHash(bodyText);
      }

      const key = `${fp}|||${f.name}`;
      this._funcHashes.set(key, {
        body_hash: bodyHash,
        struct_hash: structHash,
        lines: f.lines,
        asm_ops: asmOps,
      });
    }

    if (showProgress && opstringCount > 0) {
      console.log(`  (${opstringCount} functions hashed via opstring MD5 for cross-binary matching)`);
    }

    // Save to cache
    try {
      const cacheData = {};
      for (const [key, val] of this._funcHashes) {
        cacheData[key] = val;
      }
      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf-8');
      if (showProgress) console.log(`Saved ${this._funcHashes.size} function hashes to cache`);
    } catch (e) {
      if (showProgress) console.log(`Warning: could not save hash cache: ${e.message}`);
    }

    return this._funcHashes;
  }

  /**
   * Tight-mode hash cache. In-memory only (no disk persistence yet);
   * rebuilds on first access per server lifetime. Shape-poor functions
   * (no control-flow keyword post-normalization) are excluded outright,
   * so the returned Map is sparser than ensureFuncHashes().
   */
  ensureFuncHashesTight(minLines = 3) {
    // Cache key on minLines because tight cache filtering is line-count-
    // sensitive (unlike the disk-cached non-tight version which always
    // hashes minLines=3 and filters at use-time).
    const cacheKey = `_funcHashesTight_${minLines}`;
    if (this[cacheKey]) return this[cacheKey];
    const allFuncs = this.listFunctions();
    const out = new Map();
    for (const f of allFuncs) {
      // Cheap pre-filter: skip functions whose raw span is already below
      // minLines (code-line count is always ≤ raw line count).
      if (f.lines < minLines) continue;
      const lines = this.fileLines.get(f.filepath);
      if (!lines) continue;
      const bodyText = lines.slice(f.start - 1, f.end).join('\n');
      // Strict filter: code lines (comments + blanks stripped) must clear
      // the threshold. This is what makes `min lines` mean "min lines of
      // actual code" in tight mode rather than "min source-line span".
      const codeLines = _countCodeLines(bodyText);
      if (codeLines < minLines) continue;
      const tightHash = this.getStructuralHashTight(bodyText);
      if (tightHash === null) continue;
      const bodyHash = crypto.createHash('sha1').update(bodyText, 'utf-8').digest('hex');
      const key = `${f.filepath}|||${f.name}`;
      out.set(key, {
        body_hash: bodyHash,
        struct_hash: tightHash,
        lines: codeLines,
        raw_lines: f.lines,
      });
    }
    this[cacheKey] = out;
    return out;
  }

  /**
   * Find exact duplicate functions by SHA1 hash of body text.
   * Also computes structural and near-dupe groups.
   *
   * Returns top N exact dupe groups sorted by waste (descending).
   */
  getFuncDupes(n = 25, minLines = 3, showProgress = true) {
    const funcHashes = this.ensureFuncHashes(minLines, showProgress);
    const allFuncs = this.listFunctions();

    // Build groups
    const hashGroups = {};    // body_hash -> [func]
    const structGroups = {};  // struct_hash -> [func]
    const nameSizeGroups = {}; // "bare|lines" -> [func]

    for (const f of allFuncs) {
      if (f.lines < minLines) continue;

      const key = `${f.filepath}|||${f.name}`;
      const info = funcHashes.get(key);
      if (info) {
        f.body_hash = info.body_hash;
        f.struct_hash = info.struct_hash;
        f.asm_ops = info.asm_ops || 0;
        if (!hashGroups[info.body_hash]) hashGroups[info.body_hash] = [];
        hashGroups[info.body_hash].push(f);
        if (!structGroups[info.struct_hash]) structGroups[info.struct_hash] = [];
        structGroups[info.struct_hash].push(f);
      }

      // Track by name+size for near-dupe report
      let bare = f.name;
      if (bare.includes('::')) bare = bare.split('::').pop();
      if (bare.includes('@')) bare = bare.split('@')[0];
      f.bare_name = bare;
      const nsKey = `${bare}|${f.lines}`;
      if (!nameSizeGroups[nsKey]) nameSizeGroups[nsKey] = [];
      nameSizeGroups[nsKey].push(f);
    }

    // Exact dupe groups
    const dupeGroups = [];
    for (const [h, instances] of Object.entries(hashGroups)) {
      if (instances.length < 2) continue;
      const lines = instances[0].lines;
      const distinctFiles = new Set(instances.map(i => i.filepath)).size;
      dupeGroups.push({
        hash: h,
        bare_name: instances[0].bare_name || '?',
        lines,
        asm_ops: instances[0].asm_ops || 0,
        count: instances.length,
        n_files: distinctFiles,
        waste: (instances.length - 1) * lines,
        exact: true,
        instances,
      });
    }

    // Structural dupe groups
    const structDupeGroups = [];
    for (const [sh, instances] of Object.entries(structGroups)) {
      if (instances.length < 2) continue;
      const exactHashes = new Set(instances.map(i => i.body_hash || ''));
      if (exactHashes.size <= 1) continue; // all identical - covered by exact dupes
      const lines = instances[0].lines;
      const names = new Set(instances.map(i => i.displayName || i.name || '?'));
      structDupeGroups.push({
        hash: sh,
        bare_name: instances[0].bare_name || '?',
        lines,
        count: instances.length,
        unique_bodies: exactHashes.size,
        unique_names: names.size,
        waste: Math.floor((instances.length - 1) * lines * Math.log2(Math.max(lines, 2))),
        instances,
      });
    }

    // Near dupes: same name+size, different hash
    const nearDupes = [];
    for (const [, instances] of Object.entries(nameSizeGroups)) {
      if (instances.length < 2) continue;
      const hashes = new Set(instances.map(i => i.body_hash || '').filter(Boolean));
      if (hashes.size > 1) {
        nearDupes.push({
          hash: 'mixed',
          bare_name: instances[0].bare_name,
          lines: instances[0].lines,
          count: instances.length,
          waste: 0,
          exact: false,
          unique_variants: hashes.size,
          instances,
        });
      }
    }

    // Sort
    dupeGroups.sort((a, b) => b.waste - a.waste);
    structDupeGroups.sort((a, b) => b.waste - a.waste);

    if (showProgress) {
      const totalWaste = dupeGroups.reduce((s, g) => s + g.waste, 0);
      console.log(`Found ${dupeGroups.length} exact duplicate groups (${totalWaste} redundant lines)`);
      if (structDupeGroups.length > 0)
        console.log(`Found ${structDupeGroups.length} structural duplicate groups (same structure, different names/values)`);
      if (nearDupes.length > 0)
        console.log(`Found ${nearDupes.length} near-duplicate groups (same name+size, different content)`);
    }

    // Store for separate access
    this._nearDupes = nearDupes;
    this._structDupes = structDupeGroups;

    return dupeGroups.slice(0, n);
  }

  /**
   * Return near-duplicate groups. Must call getFuncDupes first.
   */
  getNearDupes(n = 25) {
    const near = this._nearDupes || [];
    near.sort((a, b) => (b.count * b.lines) - (a.count * a.lines));
    return near.slice(0, n);
  }

  /**
   * Return structural duplicate groups. Must call getFuncDupes first.
   */
  getStructDupes(n = 25) {
    const struct = this._structDupes || [];
    struct.sort((a, b) => b.waste - a.waste);
    return struct.slice(0, n);
  }

  /**
   * Find functions whose body shares the structural hash of a given query
   * function — i.e., funcstring peers. Unlike getStructDupes (which only
   * surfaces groups where bodies differ), this returns every peer of the
   * specific function passed in, tagged exact-body vs structural-variant.
   *
   * Each peer carries a "surprise" score in [0,1] composed of:
   *   nameDist:  1 - Jaccard overlap of bare-name tokens (camel/snake split)
   *   pathDist:  1 - LCP-fraction of directory segments
   *   crossLang: 1 if file extensions differ, 0 otherwise
   *   score    = 0.50*nameDist + 0.35*pathDist + 0.15*crossLang
   *
   * The breakdown is exposed so callers can sort/filter on individual
   * components.
   */
  findFuncstringPeers(funcName, fileHint = null, opts = {}) {
    const { includeExact = false, minSurprise = 0, limit = 200, tight = false } = opts;
    const matches = this.findFunctionMatches(funcName, fileHint);
    if (matches.length === 0) {
      return { error: `Function '${funcName}' not found`, matches: 0 };
    }
    const q = matches[0];
    const hashes = tight ? this.ensureFuncHashesTight(3) : this.ensureFuncHashes(3, false);
    const qKey = `${q.filepath}|||${q.name}`;
    const qInfo = hashes.get(qKey);
    if (!qInfo) {
      return {
        error: tight
          ? `Function '${q.name}' is shape-poor under tight mode (no control-flow keyword) or under 3 lines`
          : `Function '${q.name}' has no struct hash (likely under 3 lines)`,
        query: { filepath: q.filepath, name: q.name },
        matches: matches.length,
      };
    }

    const structHash = qInfo.struct_hash;
    const qBodyHash = qInfo.body_hash;
    const qDisplay = this.getDisplayName ? this.getDisplayName(q.name) : q.name;
    const qTokens = _funcNameTokens(qDisplay);
    const qExt = _fileExt(q.filepath);

    const peers = [];
    for (const [key, info] of hashes) {
      if (info.struct_hash !== structHash) continue;
      if (key === qKey) continue;
      const sep = key.indexOf('|||');
      if (sep < 0) continue;
      const fp = key.slice(0, sep);
      const fn = key.slice(sep + 3);
      const isExact = info.body_hash === qBodyHash;
      if (isExact && !includeExact) continue;

      const peerDisplay = this.getDisplayName ? this.getDisplayName(fn) : fn;
      const tokens = _funcNameTokens(peerDisplay);
      const nameDist = _jaccardDistance(qTokens, tokens);
      const pathDist = _pathDistance(q.filepath, fp);
      const ext = _fileExt(fp);
      const crossLang = (ext && qExt && ext !== qExt) ? 1 : 0;
      const score = nameDist * 0.5 + pathDist * 0.35 + crossLang * 0.15;
      if (score < minSurprise) continue;

      const idx = this.functionIndex && this.functionIndex[fp];
      const finfo = idx ? idx[fn] : null;
      peers.push({
        filepath: fp,
        name: fn,
        displayName: this.getDisplayName ? this.getDisplayName(fn) : fn,
        start: finfo ? finfo.start : null,
        end: finfo ? finfo.end : null,
        lines: info.lines,
        kind: isExact ? 'exact-body' : 'structural-variant',
        surprise: {
          nameDist: +nameDist.toFixed(3),
          pathDist: +pathDist.toFixed(3),
          crossLang,
          score: +score.toFixed(3),
        },
      });
    }

    peers.sort((a, b) => b.surprise.score - a.surprise.score);
    const truncated = peers.length > limit;
    return {
      query: {
        filepath: q.filepath,
        name: q.name,
        displayName: this.getDisplayName ? this.getDisplayName(q.name) : q.name,
        lines: qInfo.lines,
        struct_hash: structHash,
        body_hash: qBodyHash,
      },
      matches: matches.length,
      totalPeers: peers.length,
      truncated,
      peers: peers.slice(0, limit),
    };
  }

  /**
   * Codebase-wide scan: find all struct-hash groups that contain a "surprising"
   * pair (peak pairwise surprise >= minPeakSurprise). Output is the
   * counterpart to the Opstrings hash listing — each group is one row of
   * "different names sharing the same structural shape", ranked by how
   * far apart the most-distant pair in the group is.
   *
   * Pair sampling: for groups bigger than would yield more than
   * `pairSampleCap` pairs (default 50), we take a deterministic sliding-step
   * sample (j = i+1, i+2, … until cap). This keeps cost bounded on
   * pathological groups (e.g., a 200-instance group of getter stubs) while
   * still surfacing the peak pair in practice.
   */
  findSurprisingStructGroups(opts = {}) {
    const {
      minLines = 3,
      minPeakSurprise = 0.5,
      includeAllExactGroups = false,
      limit = 100,
      sortBy = 'peak',
      pairSampleCap = 50,
      tight = false,
    } = opts;

    const hashes = tight
      ? this.ensureFuncHashesTight(minLines)
      : this.ensureFuncHashes(minLines, false);
    const groups = new Map();
    for (const [key, info] of hashes) {
      if (info.lines < minLines) continue;
      let arr = groups.get(info.struct_hash);
      if (!arr) { arr = []; groups.set(info.struct_hash, arr); }
      arr.push({ key, info });
    }

    const scored = [];
    for (const [hash, members] of groups) {
      if (members.length < 2) continue;
      const bodyHashes = new Set(members.map(m => m.info.body_hash));
      const allExact = bodyHashes.size === 1;
      if (allExact && !includeAllExactGroups) continue;

      const parsed = members.map(m => {
        const sep = m.key.indexOf('|||');
        const fp = m.key.slice(0, sep);
        const fn = m.key.slice(sep + 3);
        // Tokenize on the display name when one exists — otherwise an
        // obfuscated bare prefix (`oaA`, `QD3`, …) reads as a single junk
        // token and produces a misleading 1.0 name-distance for functions
        // whose inferred semantic names actually share most of their
        // tokens (the `KW_RETRY_STRATEGY_…` portion added by
        // inferFunctionNames).
        const dn = this.getDisplayName ? this.getDisplayName(fn) : fn;
        return {
          filepath: fp, name: fn,
          body_hash: m.info.body_hash,
          lines: m.info.lines,
          raw_lines: m.info.raw_lines || m.info.lines,
          tokens: _funcNameTokens(dn),
          ext: _fileExt(fp),
        };
      });

      const N = parsed.length;
      const pairs = [];
      if (N * (N - 1) / 2 <= pairSampleCap) {
        for (let i = 0; i < N; i++)
          for (let j = i + 1; j < N; j++) pairs.push([i, j]);
      } else {
        for (let step = 1; step < N && pairs.length < pairSampleCap; step++) {
          for (let i = 0; i + step < N && pairs.length < pairSampleCap; i++) {
            pairs.push([i, i + step]);
          }
        }
      }

      let peak = 0, peakPair = null, sum = 0;
      for (const [i, j] of pairs) {
        const a = parsed[i], b = parsed[j];
        const nd = _jaccardDistance(a.tokens, b.tokens);
        const pd = _pathDistance(a.filepath, b.filepath);
        const cl = (a.ext && b.ext && a.ext !== b.ext) ? 1 : 0;
        const s = nd * 0.5 + pd * 0.35 + cl * 0.15;
        sum += s;
        if (s > peak) {
          peak = s;
          peakPair = { i, j, nameDist: nd, pathDist: pd, crossLang: cl, score: s };
        }
      }
      const mean = pairs.length > 0 ? sum / pairs.length : 0;
      if (peak < minPeakSurprise) continue;

      const bodyCounts = {};
      for (const p of parsed) bodyCounts[p.body_hash] = (bodyCounts[p.body_hash] || 0) + 1;

      const instances = parsed.map(p => {
        const finfo = this.functionIndex?.[p.filepath]?.[p.name] || null;
        return {
          filepath: p.filepath,
          name: p.name,
          displayName: this.getDisplayName ? this.getDisplayName(p.name) : p.name,
          lines: p.lines,
          raw_lines: p.raw_lines,
          body_hash: p.body_hash,
          start: finfo?.start || null,
          end: finfo?.end || null,
          exact_copies: bodyCounts[p.body_hash],
        };
      });

      const dn = (n) => this.getDisplayName ? this.getDisplayName(n) : n;
      scored.push({
        struct_hash: hash,
        count: N,
        lines: parsed[0].lines,
        raw_lines: parsed[0].raw_lines,
        uniqueBodies: bodyHashes.size,
        allExact,
        peakSurprise: +peak.toFixed(3),
        meanSurprise: +mean.toFixed(3),
        peakPair: peakPair ? {
          a: parsed[peakPair.i].name,
          a_filepath: parsed[peakPair.i].filepath,
          a_display: dn(parsed[peakPair.i].name),
          b: parsed[peakPair.j].name,
          b_filepath: parsed[peakPair.j].filepath,
          b_display: dn(parsed[peakPair.j].name),
          nameDist: +peakPair.nameDist.toFixed(3),
          pathDist: +peakPair.pathDist.toFixed(3),
          crossLang: peakPair.crossLang,
          score: +peakPair.score.toFixed(3),
        } : null,
        pairsSampled: pairs.length,
        instances,
      });
    }

    if (sortBy === 'mean') scored.sort((a, b) => b.meanSurprise - a.meanSurprise);
    else if (sortBy === 'lines') scored.sort((a, b) => b.lines - a.lines);
    else scored.sort((a, b) => b.peakSurprise - a.peakSurprise);

    return {
      total: scored.length,
      truncated: scored.length > limit,
      groups: scored.slice(0, limit),
    };
  }

  // ============================================================================
  // Distance helpers — implementations moved to ./distance-helpers.js
  // (Issue #18 Phase 2). No wrappers: they were static internals and the
  // callsites in this file now use bare-name imports.
  // ============================================================================

  // ============================================================================
  // Canonical funcs — implementations moved to ./canonical-funcs.js (Issue #18 Phase 2)
  // ============================================================================
  getCanonicalFuncs(...args) { return _getCanonicalFuncs(this, ...args); }
  getCopyCount(...args) { return _getCopyCount(this, ...args); }
  isCanonical(...args) { return _isCanonical(this, ...args); }

  // ============================================================================
  // Vocabulary — implementations moved to ./vocabulary.js (Issue #18 Phase 2)
  // ============================================================================
  ensureVocabulary(...args) { return _ensureVocabulary(this, ...args); }
  getTopVocabulary(...args) { return _getTopVocabulary(this, ...args); }
  formatVocabularyForPrompt(...args) { return _formatVocabularyForPrompt(this, ...args); }

  // ============================================================================
  // Multisect — implementations moved to ./multisect.js (Issue #18 Phase 2)
  // ============================================================================
  computeTermFileCounts(...args) { return _computeTermFileCounts(this, ...args); }
  multisectSearch(...args) { return _multisectSearch(this, ...args); }
}
