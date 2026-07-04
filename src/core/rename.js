/**
 * rename.js - Rename-map subsystem extracted from CodeSearchIndex.js
 * (Issue #18 Phase 2 peel 6, theme #2 Rename).
 *
 * Three responsibilities:
 *
 * 1. **Persistence** (`_saveRenameMap` / `_loadRenameMap`) — JSON round-trip
 *    against `<indexPath>/rename_map.json`. The path helper itself
 *    (`_renameMapPath`) lives on the CSI class with sibling `_*Path` helpers.
 * 2. **Display-time application** (`applyRenames`, `_renderLinesWithRenames`,
 *    `getDisplayName`, `getOriginalName`,
 *    `findOriginalsByDisplayPattern`) — substitute display names into source
 *    text or look up the mapping in either direction.
 * 3. **Build-time inference** (`inferAndSaveRenameMap`) — orchestrates KW /
 *    CMD / IMPORT / __name overlays and persists the resulting map.
 *
 * Inference primitives (`inferAllNames`, `isOpaqueName`,
 * `camelToScreamingSnake`, `_IMPORT_LOCAL_BLOCKLIST`) live in
 * `./CSI-helpers.js`; bundle-aware name recovery
 * (`_detectNameHelper`, `_extractNameRecoveryPairs`) lives in
 * `./bundle-seam-detection.js`. This module is the orchestration layer.
 *
 * Per-instance caches (`idx._renameMap`, `idx._renameRegex`,
 * `idx._reverseRenameMap`) remain on the CSI instance so every consumer
 * shares the same compiled regex and reverse-lookup table.
 */

import fs from 'fs';
import path from 'path';
import {
  escapeRegex, _scanLineState, _isInsideString,
  inferAllNames, isOpaqueName, camelToScreamingSnake, _IMPORT_LOCAL_BLOCKLIST,
} from './CSI-helpers.js';
import { _detectNameHelper, _extractNameRecoveryPairs } from './bundle-seam-detection.js';


// ============================================================================
// Persistence (intra-cluster — no class wrapper)
// ============================================================================

export function _saveRenameMap(idx, map) {
  try {
    fs.writeFileSync(idx._renameMapPath(), JSON.stringify(map, null, 2));
  } catch (e) {
    console.log(`Warning: could not save rename map: ${e.message}`);
  }
}

export function _loadRenameMap(idx) {
  if (idx._renameMap) return idx._renameMap;
  try {
    const raw = fs.readFileSync(idx._renameMapPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    // Use null-prototype object to avoid collisions with Object.prototype keys
    // (e.g. 'constructor', 'toString' are valid function names in minified code)
    idx._renameMap = Object.create(null);
    for (const [k, v] of Object.entries(parsed)) {
      idx._renameMap[k] = v;
    }
    return idx._renameMap;
  } catch {
    idx._renameMap = Object.create(null);
    return idx._renameMap;
  }
}


// ============================================================================
// Display-time application
// ============================================================================

/**
 * Apply rename map to a block of source code for display.
 * Replaces obfuscated identifiers with their inferred names.
 * Returns the renamed source text.
 */
export function applyRenames(idx, sourceText, initialState = 'code') {
  if (!sourceText) return sourceText || '';
  const map = _loadRenameMap(idx);
  if (!map || Object.keys(map).length === 0) return sourceText;
  // Skip rename application for very large blocks to avoid performance issues
  // (11K renames × 16MB file = too slow). Limit allows single functions up to
  // ~200K chars but skips whole-file display of huge files.
  if (sourceText.length > 200000) return sourceText;

  // Build a combined regex that matches any rename target as a whole word
  if (!idx._renameRegex) {
    const keys = Object.keys(map).sort((a, b) => b.length - a.length);
    if (keys.length === 0) return sourceText;
    // Escape and join with | for alternation
    const pattern = keys.map(k => escapeRegex(k)).join('|');
    // #251: use identifier-aware boundaries instead of `\b`. `\b` treats `$` as a
    // non-word char, so `$`-prefixed bundler names (e.g. `$abc`) both failed to
    // match after a non-word char AND spuriously matched `abc` inside `$abc`.
    // `(?<![$\w]) … (?![$\w])` treats `$` and word chars as identifier chars.
    idx._renameRegex = new RegExp('(?<![$\\w])(' + pattern + ')(?![$\\w])', 'g');
  }

  // Apply line by line, tracking cross-line state for block comments and
  // template literals (#10). The state machine in _scanLineState handles:
  //   - 'bc' (block comment)        — can span multiple lines via /* ... */
  //   - 't'  (template literal)     — can span multiple lines via `...`
  // Other states ('s', 'd', 'lc') don't span lines. Callers (e.g.
  // doFileBookends extracting a tail chunk from deep in a file) may pass
  // `initialState='bc'` or `'t'` if they know the chunk begins mid-block.
  const lines = sourceText.split('\n');
  let carryState = initialState || 'code';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // If the line starts inside a block comment or template, AND the state
    // never exits before line end, skip rename for the whole line.
    const endState = _scanLineState(line, carryState);
    if (
      (carryState === 'bc' && endState === 'bc') ||
      (carryState === 't'  && endState === 't')
    ) {
      carryState = endState;
      continue;
    }

    idx._renameRegex.lastIndex = 0;
    const startStateForLine = carryState;
    lines[i] = line.replace(idx._renameRegex, (match, name, offset) => {
      // Skip matches inside any string-like or comment context
      if (_isInsideString(line, offset, startStateForLine)) return match;
      return (map && Object.prototype.hasOwnProperty.call(map, name)) ? map[name] : match;
    });

    // Carry block-comment / template state to next line; reset for everything else
    carryState = (endState === 'bc' || endState === 't') ? endState : 'code';
  }
  return lines.join('\n');
}

/**
 * Render an array of raw source lines via applyRenames, in chunks small
 * enough to clear applyRenames's 200K-char performance guard, while
 * carrying block-comment / template-literal state across chunk boundaries
 * so the result matches what whole-file rendering would produce.
 *
 * Needed by multisectSearch's --match-renames path (Issue #25): a bundled
 * file (16MB cli.js) cannot be passed to applyRenames as one string —
 * applyRenames returns it unchanged. Per-line rendering with fresh state
 * gives wrong results inside multi-line strings and template literals;
 * chunking with carryState avoids both pitfalls.
 *
 * Line count is preserved (renames are substring substitutions, never add
 * newlines), so callers can keep using the original line numbers.
 *
 * @param {string[]} rawLines
 * @returns {string[]}
 */
export function _renderLinesWithRenames(idx, rawLines) {
  if (!rawLines || rawLines.length === 0) return [];
  const CHUNK_MAX = 180000;  // stay clear of applyRenames's 200000 guard
  const out = [];
  let carryState = 'code';
  let chunkStart = 0;
  let chunkBytes = 0;

  const flush = (endIdx) => {
    if (endIdx <= chunkStart) return;
    const chunk = rawLines.slice(chunkStart, endIdx).join('\n');
    const rendered = applyRenames(idx, chunk, carryState);
    const renderedLines = rendered.split('\n');
    // If the substitution accidentally changed line count, fall back to
    // raw to avoid corrupting boundary lookups downstream.
    if (renderedLines.length === endIdx - chunkStart) {
      for (let k = 0; k < renderedLines.length; k++) out.push(renderedLines[k]);
    } else {
      for (let k = chunkStart; k < endIdx; k++) out.push(rawLines[k]);
    }
    // Advance carryState by scanning the raw chunk line-by-line.
    for (let j = chunkStart; j < endIdx; j++) {
      const next = _scanLineState(rawLines[j], carryState);
      carryState = (next === 'bc' || next === 't') ? next : 'code';
    }
    chunkStart = endIdx;
    chunkBytes = 0;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const lineLen = (rawLines[i] || '').length + 1;
    if (chunkBytes + lineLen >= CHUNK_MAX && chunkStart < i) flush(i);
    chunkBytes += lineLen;
  }
  flush(rawLines.length);
  return out;
}

/**
 * Get the display name for a function, applying rename map if available.
 * For qualified names (Class::method), if the full key isn't in the map,
 * tries substituting the class prefix alone. This way `le6::constructor`
 * displays as `le6_KW_REMOVE_ALL_SCHEMAS::constructor` even when only
 * the bare `le6` has a rename entry — without needing explicit qualified
 * entries for every method.
 */
export function getDisplayName(idx, funcName) {
  if (!funcName) return funcName || '';
  const map = _loadRenameMap(idx);
  if (!map) return funcName;
  // Direct lookup (exact key match)
  if (Object.prototype.hasOwnProperty.call(map, funcName)) return map[funcName];
  // Qualified-name fallback: split on ::, rename the class prefix if it
  // has an entry, reassemble with the original method leaf.
  if (funcName.includes('::')) {
    const sepIdx = funcName.lastIndexOf('::');
    const clsPart = funcName.slice(0, sepIdx);
    const methPart = funcName.slice(sepIdx + 2);
    if (Object.prototype.hasOwnProperty.call(map, clsPart)) {
      const renamedCls = map[clsPart];
      // If the method leaf itself has a rename, apply that too
      const renamedMeth = Object.prototype.hasOwnProperty.call(map, funcName)
        ? map[funcName].split('::').pop()  // won't reach here (caught above) but defensive
        : methPart;
      return renamedCls + '::' + renamedMeth;
    }
  }
  return funcName;
}

/**
 * Reverse lookup: given a display name (possibly renamed), return the original name.
 * Used when the GUI sends a renamed name back for lookup/extract.
 */
export function getOriginalName(idx, displayName) {
  if (!idx._reverseRenameMap) {
    const map = _loadRenameMap(idx);
    idx._reverseRenameMap = Object.create(null);
    for (const [orig, renamed] of Object.entries(map)) {
      idx._reverseRenameMap[renamed] = orig;
    }
  }
  return idx._reverseRenameMap[displayName] || displayName;
}

export function findOriginalsByDisplayPattern(idx, pattern) {
  const map = _loadRenameMap(idx);
  if (!map || Object.keys(map).length === 0) return [];
  const pat = pattern.toLowerCase();
  const originals = [];
  for (const [orig, display] of Object.entries(map)) {
    if (display.toLowerCase().includes(pat)) {
      originals.push(orig);
    }
  }
  return originals;
}


// ============================================================================
// Build-time inference orchestration
// ============================================================================

/**
 * Run all rename inference passes (KW from body keywords, CMD from command
 * catalog, IMPORT from destructuring imports) and persist rename_map.json
 * + import_map.json to the index directory. Used by buildIndex() and by the
 * --build-rename-map CLI flag (to retro-fit renames onto an existing index).
 *
 * Requires fileLines and functionIndex to be loaded (which happens
 * automatically when an existing index is loaded from disk).
 *
 * @param {object|boolean} [opts]  May be passed as a plain boolean for
 *   backwards compat (interpreted as showProgress), or as an options object.
 * @param {boolean} [opts.showProgress=true]
 * @param {number}  [opts.minFuncLines=0]  skip rename for functions with
 *   lineCount <= this (0 = no threshold, 4 was the old default).
 * @returns {{namesInferred: number, cmdRenames: number, importRenames: number}}
 */
export function inferAndSaveRenameMap(idx, opts = {}) {
  // Backwards-compat shim: allow passing a bare boolean as the old showProgress arg
  if (typeof opts === 'boolean') opts = { showProgress: opts };
  const { showProgress = true, minFuncLines = 0 } = opts;
  if (showProgress) console.log('Inferring descriptive names for opaque functions...');
  const { renameMap, count: namesInferred } = inferAllNames(idx, { minFuncLines });

  // Overlay _CMD_ renames from command catalog (higher quality than _KW_ for these)
  const catalog = idx.extractCommandCatalog(false);
  let cmdRenames = 0;
  for (const cmd of catalog.commands) {
    if (cmd.tier !== 'primary') continue;
    if (!cmd.func || cmd.func === '(file scope)') continue;
    const funcName = cmd.func;
    if (!isOpaqueName(funcName)) continue;
    const cmdName = (cmd.name || '').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
    if (cmdName.length < 2) continue;
    let displayName = funcName + '_CMD_' + cmdName;
    if (displayName.length > 60) displayName = displayName.slice(0, 60);
    renameMap[funcName] = displayName;
    cmdRenames++;
  }
  for (const opt of catalog.cliOptions) {
    if (!opt.handler?.func || opt.handler.func === '(file scope)') continue;
    const funcName = opt.handler.func;
    if (!isOpaqueName(funcName)) continue;
    const optName = (opt.flags?.[0] || opt.name || '').replace(/^-+/, '').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
    if (optName.length < 2) continue;
    let displayName = funcName + '_CMD_' + optName;
    if (displayName.length > 60) displayName = displayName.slice(0, 60);
    renameMap[funcName] = displayName;
    cmdRenames++;
  }

  // Overlay destructuring import renames: { exportName: localVar } → localVar_IMPORT_EXPORT_NAME
  // Two-pass: first collect ALL import mappings, then only apply renames for
  // variables that have a single unambiguous mapping (avoids clobbering short
  // names like _q or z that are reused across scopes).
  let importRenames = 0;
  const importCandidates = Object.create(null); // localVar → Set of export names

  for (const [, flines] of idx.fileLines) {
    for (let i = 0; i < flines.length; i++) {
      const line = flines[i].trim();
      if (!/^(?:let|const|var)\s+\{/.test(line) && line !== '{') continue;

      let block = line;
      for (let j = i + 1; j < Math.min(i + 15, flines.length); j++) {
        block += ' ' + flines[j].trim();
        if (flines[j].includes('}')) break;
      }
      if (!/\}\s*=/.test(block)) continue;

      const pairRe = /(\w+)\s*:\s*([a-zA-Z_$][\w$]*)/g;
      let dm;
      while ((dm = pairRe.exec(block)) !== null) {
        const exportName = dm[1];
        const localVar = dm[2];
        if (exportName.length < 3) continue;
        if (localVar.length > 8 && !isOpaqueName(localVar)) continue;
        if (/^(true|false|null|undefined|this|super|class|function|return|if|else|for|while|var|let|const|new|delete|typeof|void|in|of)$/.test(localVar)) continue;
        if (isOpaqueName(exportName)) continue;

        if (!importCandidates[localVar]) importCandidates[localVar] = new Set();
        importCandidates[localVar].add(exportName);
      }
    }
  }

  // Only apply renames for variables with a single unambiguous import mapping
  // AND with 3+ char names (1-2 char names are too common as local vars for safe global replace)
  // AND not in the built-in identifier blocklist (#7).
  for (const [localVar, exportNames] of Object.entries(importCandidates)) {
    if (exportNames.size !== 1) continue;
    if (localVar.length < 3) continue;
    if (_IMPORT_LOCAL_BLOCKLIST.has(localVar)) continue;
    const exportName = [...exportNames][0];
    const importName = 'IMPORT_' + camelToScreamingSnake(exportName);
    let displayName = localVar + '_' + importName;
    if (displayName.length > 60) displayName = displayName.slice(0, 60);
    // Override _KW_ renames but not _CMD_ renames
    if (!renameMap[localVar] || renameMap[localVar].includes('_KW_')) {
      renameMap[localVar] = displayName;
      importRenames++;
    }
  }

  // Save all import mappings (including ambiguous) for future display in rename table
  if (Object.keys(importCandidates).length > 0) {
    const importMapPath = path.join(idx.indexPath, 'import_map.json');
    const importMap = {};
    for (const [localVar, exportNames] of Object.entries(importCandidates)) {
      importMap[localVar] = [...exportNames];
    }
    try {
      fs.writeFileSync(importMapPath, JSON.stringify(importMap, null, 2));
    } catch { /* ignore */ }
  }

  // #332: Overlay __name-helper recoveries. For each indexed file, detect
  // esbuild's __name helper (preserves original names via
  // Object.defineProperty(fn, "name", {...})), then scan for helper(IDENT,
  // "originalName") calls and add IDENT → IDENT_NAME_originalName entries.
  //
  // Priority tier: _CMD_ > _NAME_ > _IMPORT_ > _KW_.
  // This pass OVERRIDES existing _KW_ and _IMPORT_ renames (because the
  // original name is ground truth from the bundler) but leaves _CMD_
  // untouched (command-catalog renames express the function's ROLE, which
  // is more specific than its original source-code name).
  //
  // Ambiguity: if the same IDENT is __name-tagged with two different
  // strings across the bundle (rare but possible in name-shadowing
  // situations), we skip it entirely — safer than picking arbitrarily.
  let nameRenames = 0;
  const nameCandidates = new Map(); // ident -> Set of observed names
  for (const [, flines] of idx.fileLines) {
    const helperName = _detectNameHelper(flines);
    if (!helperName) continue;
    const filePairs = _extractNameRecoveryPairs(flines, helperName);
    for (const [ident, names] of filePairs) {
      if (!nameCandidates.has(ident)) nameCandidates.set(ident, new Set());
      for (const n of names) nameCandidates.get(ident).add(n);
    }
  }
  for (const [ident, names] of nameCandidates) {
    if (names.size !== 1) continue; // ambiguous — skip
    const origName = [...names][0];
    const existing = renameMap[ident];
    // Preserve higher-tier CMD renames
    if (existing && existing.includes('_CMD_')) continue;
    // Override KW, IMPORT, or add new
    let displayName = ident + '_NAME_' + origName;
    if (displayName.length > 60) displayName = displayName.slice(0, 60);
    renameMap[ident] = displayName;
    nameRenames++;
  }

  // Persist and refresh in-memory cache (and reset the compiled regex / reverse map)
  idx._renameMap = renameMap;
  idx._renameRegex = null;
  idx._reverseRenameMap = null;
  _saveRenameMap(idx, renameMap);

  if (showProgress) {
    const parts = [
      `${namesInferred} descriptive names`,
      `${cmdRenames} command names`,
      `${importRenames} import renames`,
    ];
    if (nameRenames > 0) parts.splice(2, 0, `${nameRenames} __name recoveries`);
    console.log(`Inferred ${parts.join(' + ')} → rename_map.json`);
  }

  return { namesInferred, cmdRenames, importRenames, nameRenames };
}
