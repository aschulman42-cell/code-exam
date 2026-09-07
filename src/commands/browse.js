// browse.js — index browsing: stats, list/show files, list functions, extract, bundle seams, extension census
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * browse.js - Index browsing commands: stats, list-files, show-file,
 * list-functions, list-functions-alpha, list-functions-size,
 * scan-extensions, index-extensions, list-indexes, extract.
 *
 * Port of ce_browse.py
 */

import fs from 'fs';
import path from 'path';
import { displayName, eprint, pasteToken, quotePathIfNeeded } from '../utils.js';
import { CodeSearchIndex } from '../core/CodeSearchIndex.js';
import { skippedExtensionCensus } from '../core/extension-census.js';
import { makeFilterMatcher } from '../core/filter-match.js';


// ========================================================================
// Stats
// ========================================================================

export function doStats(index, args) {
  console.log(`Literal index: ${index.files.size} files`);
  if (index.indexSource) console.log(`Source: ${index.indexSource}`);
  if (index.basePath)    console.log(`Base path: ${index.basePath}`);
  console.log(`Embedding model: ${index.embeddingModel}`);

  let totalLines = 0;
  for (const lines of index.fileLines.values()) totalLines += lines.length;
  console.log(`Total lines: ${totalLines}`);

  // File dedup stats
  const fileHashes = index.fileHashes || {};
  const hashValues = Object.values(fileHashes);
  const dupeGroups = hashValues.filter(p => p.length > 1).length;
  const totalDupes = hashValues.filter(p => p.length > 1)
    .reduce((sum, p) => sum + p.length - 1, 0);
  if (dupeGroups > 0) {
    const totalScanned = index.files.size + totalDupes;
    console.log(`SHA1 dedup: ${totalDupes} duplicates registered from ${totalScanned} files scanned (${dupeGroups} groups)`);
  }

  // Inverted index stats
  if (index.invertedIndex) {
    console.log(`Inverted index: ${Object.keys(index.invertedIndex).length} unique lines`);
  } else if (index._invertedOnDisk) {
    // Large index on disk - count entries by streaming without loading
    const entryCount = index.getInvertedIndexCount();
    console.log(`Inverted index: ${entryCount} unique lines (on-disk, streamed on demand)`);
  } else if (index._loadInvertedIndex()) {
    if (index.invertedIndex) {
      console.log(`Inverted index: ${Object.keys(index.invertedIndex).length} unique lines`);
    } else {
      // Loaded as on-disk
      const entryCount = index.getInvertedIndexCount();
      console.log(`Inverted index: ${entryCount} unique lines (on-disk, streamed on demand)`);
    }
  } else {
    console.log('Inverted index: Not built (run --build-index to create)');
  }

  // Function index stats
  if (index._loadFunctionIndex()) {
    let totalFuncs = 0;
    for (const funcs of Object.values(index.functionIndex)) {
      totalFuncs += Object.keys(funcs).length;
    }
    console.log(`Function index: ${totalFuncs} functions in ${Object.keys(index.functionIndex).length} files`);
  } else {
    console.log('Function index: Not built (run --build-index to create)');
  }

  if (index.parseMethod) console.log(`Parse method: ${index.parseMethod}`);
  console.log('ChromaDB: Not available (semantic search disabled)');
}


// ========================================================================
// Scan / Index Extensions
// ========================================================================

export function doScanExtensions(args) {
  const extCounts = CodeSearchIndex.scanExtensions(args.scan_extensions);
  if (Object.keys(extCounts).length === 0) return;

  console.log(`\nFile extensions in: ${args.scan_extensions}\n`);
  console.log(`${'Extension'.padEnd(20)} ${'Count'.padStart(10)}`);
  console.log('-'.repeat(32));
  let total = 0;
  for (const [ext, count] of Object.entries(extCounts)) {
    console.log(`${ext.padEnd(20)} ${String(count).padStart(10)}`);
    total += count;
  }
  console.log('-'.repeat(32));
  console.log(`${'Total files'.padEnd(20)} ${String(total).padStart(10)}`);
}

export function doIndexExtensions(index, args) {
  const extCounts = new Map();
  for (const filepath of index.files.keys()) {
    const ext = path.extname(filepath).toLowerCase() || '(no extension)';
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
  }

  if (extCounts.size === 0) {
    console.log('No files in index.');
    return;
  }

  const sorted = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);

  let totalLines = 0;
  for (const lines of index.fileLines.values()) totalLines += lines.length;

  console.log(`\nFile extensions in index: ${index.indexPath}\n`);
  console.log(`${'Extension'.padEnd(20)} ${'Files'.padStart(10)} ${'Lines'.padStart(12)}`);
  console.log('-'.repeat(44));

  let totalFiles = 0;
  for (const [ext, count] of sorted) {
    // Count lines for this extension
    let extLines = 0;
    for (const [fp, lines] of index.fileLines) {
      const fpExt = path.extname(fp).toLowerCase();
      if (fpExt === ext || (ext === '(no extension)' && !path.extname(fp))) {
        extLines += lines.length;
      }
    }
    console.log(`${ext.padEnd(20)} ${String(count).padStart(10)} ${String(extLines).padStart(12)}`);
    totalFiles += count;
  }
  console.log('-'.repeat(44));
  console.log(`${'Total'.padEnd(20)} ${String(totalFiles).padStart(10)} ${String(totalLines).padStart(12)}`);

  // Skipped census: extensions present in the source but NOT indexed (#191).
  // Same shared helper + union logic the GUI Extensions accordion uses, so a
  // directory-of-archives surfaces its zip-internal skips (e.g. .jinja2) instead
  // of staying silent.
  const skipped = skippedExtensionCensus(index);
  if (skipped && skipped.text.length) {
    console.log(`\nNot indexed (present in source):`);
    console.log(`${'Extension'.padEnd(20)} ${'Files'.padStart(10)}`);
    console.log('-'.repeat(31));
    for (const { ext, count } of skipped.text) {
      console.log(`${ext.padEnd(20)} ${String(count).padStart(10)}`);
    }
    console.log('-'.repeat(31));
    console.log(`To include them, rebuild with: --add-extensions ${skipped.addList}`);
  }
  if (skipped && skipped.media.length) {
    const mlist = skipped.media.map(({ ext, count }) => `${ext} (${count})`).join(', ');
    console.log(`(Also present, skipped as binary/media — not indexed as text: ${mlist})`);
  }
}


// ========================================================================
// List Indexes
// ========================================================================

export function doListIndexes(args) {
  const searchPath = args.list_indexes === '.' ? process.cwd() : args.list_indexes;

  if (!fs.existsSync(searchPath) || !fs.statSync(searchPath).isDirectory()) {
    console.log(`Not a directory: ${searchPath}`);
    return;
  }

  console.log(`\nScanning for indexes in: ${searchPath}`);

  const indexesFound = [];
  let entries;
  try { entries = fs.readdirSync(searchPath).sort(); }
  catch { return; }

  for (const entry of entries) {
    const idxDir = path.join(searchPath, entry);
    try {
      if (!fs.statSync(idxDir).isDirectory()) continue;
    } catch { continue; }

    const literalPath = path.join(idxDir, 'literal_index.json');
    if (!fs.existsSync(literalPath)) continue;

    const info = { name: entry, path: idxDir };
    try {
      const literalSize = fs.statSync(literalPath).size;
      info.literal_mb = literalSize / (1024 * 1024);

      const funcPath = path.join(idxDir, 'function_index.json');
      const invPath  = path.join(idxDir, 'inverted_index.json');
      const hashPath = path.join(idxDir, 'func_hashes.json');

      info.has_functions = fs.existsSync(funcPath);
      info.has_inverted  = fs.existsSync(invPath);
      info.has_hashes    = fs.existsSync(hashPath);

      if (info.has_functions) info.func_mb = fs.statSync(funcPath).size / (1024 * 1024);
      if (info.has_inverted)  info.inv_mb  = fs.statSync(invPath).size / (1024 * 1024);

      const mtime = fs.statSync(literalPath).mtime;
      info.modified = mtime.toISOString().replace('T', ' ').slice(0, 16);
    } catch (e) {
      info.error = e.message;
    }

    indexesFound.push(info);
  }

  if (indexesFound.length === 0) {
    console.log(`\nNo code_search indexes found in: ${searchPath}`);
    console.log('(Looking for directories containing literal_index.json)');
    return;
  }

  console.log(`\n  ${'Index Name'.padEnd(30)} ${'Index MB'.padStart(10)} ${'Modified'.padEnd(18)} Components`);
  console.log(`  ${'-'.repeat(85)}`);

  for (const info of indexesFound) {
    const litMb = (info.literal_mb || 0).toFixed(1);
    const modified = info.modified || '?';
    const components = [];
    if (info.has_functions) components.push(`funcs(${Math.round(info.func_mb || 0)}MB)`);
    if (info.has_inverted)  components.push(`inv(${Math.round(info.inv_mb || 0)}MB)`);
    if (info.has_hashes)    components.push('hashes');
    const compStr = components.length > 0 ? components.join(', ') : '-';
    console.log(`  ${info.name.padEnd(30)} ${litMb.padStart(10)} ${modified.padEnd(18)} ${compStr}`);
  }

  console.log(`\n  ${indexesFound.length} index(es) found`);
  console.log(`  Tip: use --stats --index-path <n> for detailed counts (loads the index)`);
}


// ========================================================================
// Extract
// ========================================================================

function _printExtractUsage() {
  console.log('Usage: --extract <spec> where spec is one of:');
  console.log('  FUNCTION               bare function name');
  console.log('  FILE@FUNCTION          file-qualified name (canonical form)');
  console.log('  FILE:FUNCTION          colon variant (matches "foo.ts:Try" output)');
  console.log('  FILE:LNNN / FILE:NNN   find the function at that line');
  console.log('  NAME@LINE              disambiguate a duplicate-named entry by line');
  console.log('Examples:');
  console.log('  --extract backward_pass');
  console.log('  --extract nn_sine.cpp@backward_pass');
  console.log('  --extract index.ts:Try');
  console.log('  --extract index.ts:L372');
  console.log('  --extract _parse@21138');
}

/**
 * Given a file substring and a line number, find the function whose range
 * contains that line. Returns the stored name (including any @line
 * disambiguator) or null if no function covers that line. If multiple files
 * match the substring, prefers files where a function contains the line;
 * among those, picks the innermost (smallest range) containing function.
 */
function _findFunctionAtLine(index, fileSubstr, lineNum) {
  index._ensureFunctionIndex?.();
  if (!index.functionIndex) return null;
  const subNorm = fileSubstr.toLowerCase().replace(/\\/g, '/');
  const candidates = [];
  for (const [fp, funcs] of Object.entries(index.functionIndex)) {
    const fpNorm = fp.toLowerCase().replace(/\\/g, '/');
    if (!fpNorm.includes(subNorm)) continue;
    for (const [name, info] of Object.entries(funcs)) {
      if (lineNum >= info.start && lineNum <= info.end) {
        candidates.push({ fp, name, info, span: info.end - info.start });
      }
    }
  }
  if (candidates.length === 0) return null;
  // Prefer the innermost (smallest containing range) — e.g., if both an outer
  // class and an inner method span the line, the inner method wins.
  candidates.sort((a, b) => a.span - b.span);
  return candidates[0].name;
}

export function doExtract(index, args) {
  const extractArg = args.extract;
  const commentsOnly = args.comments_only || false;

  // --deep [N] implies --follow-calls, optionally with a depth value
  // optional_value returns '.' for flag-only, 'N' for --deep N, null if not specified
  const deepVal = args.deep;
  const followCalls = args.follow_calls || (deepVal != null);
  let depth;
  if (deepVal && deepVal !== '.' && deepVal !== true && /^\d+$/.test(String(deepVal))) {
    depth = parseInt(deepVal);
  } else {
    depth = args.depth || 1;
  }

  // Parse the extract spec. Accept several interchangeable forms so the user
  // can copy-paste from any output — listings, digests, cmp-string-call
  // output, breadcrumbs — and have --extract work without re-formatting.
  //
  //   FUNCTION                   bare name
  //   FILE@FUNC                  canonical file-qualified form
  //   NAME@LINE                  line-number disambiguator for dup-named entries
  //   FILE:FUNC                  colon variant (matches `foo.ts:Try` output)
  //   FILE:LNNN / FILE:NNN       find function CONTAINING that line in the file
  //                              (matches the `... @ foo.ts:L372` output format)
  //
  // Colon is only treated as a file separator when the part before it "looks
  // like a path" (contains `/` or `\` or has a file extension like `.ts`) —
  // this avoids false-matching things like `ClassName:method` or Windows
  // drive letters like `C:\…`.
  let fileHint = null;
  let funcname = index.getOriginalName ? index.getOriginalName(extractArg) : extractArg;

  // --- 1. FILE@FUNC / NAME@LINE form ---
  if (funcname.includes('@')) {
    // Find the CORRECT `@` separator. Paths can contain `@` legitimately:
    //   - scoped npm packages: `node_modules/@anthropic-ai/sdk/client.js`
    // Our separator is the `@` that comes AFTER the filename, not inside it.
    // Heuristic: pick the last `@` that's preceded by a file-extension-like
    // suffix (`.js`, `.ts`, `.py`, etc.) OR just preceded by something that
    // can't be inside a scoped-package path. Fallback to first `@` for the
    // NAME@LINE form (no slashes, no file extensions).
    const extBeforeAt = /\.[a-zA-Z0-9]{1,6}@/g;
    let sepIdx = -1;
    let m;
    while ((m = extBeforeAt.exec(funcname)) !== null) {
      sepIdx = m.index + m[0].length - 1;  // position of the `@` itself
    }
    // If no file-extension-preceded @ found, fall back to the first @ — but only
    // when it's a plausible FILE@FUNC / NAME@LINE separator. A real separator is
    // followed by a function name or a line number, neither of which contains a
    // path separator. If what follows the '@' still contains '/' or '\', the '@'
    // is INSIDE the path (e.g. a scoped-npm `pkgs/@scope/pkg.js:1` file:line ref),
    // NOT a separator — leave the token intact so the FILE:LNNN / bare-name
    // branches below resolve it. (#241 parse-safety round-trip)
    if (sepIdx < 0) {
      const firstAt = funcname.indexOf('@');
      const after = funcname.slice(firstAt + 1);
      if (!after.includes('/') && !after.includes('\\')) sepIdx = firstAt;
    }

    if (sepIdx >= 0) {
      const beforeAt = funcname.slice(0, sepIdx);
      const afterAt = funcname.slice(sepIdx + 1);
      if (/^\d+$/.test(afterAt)) {
        // NAME@LINE — keep funcname intact as the disambiguator
      } else {
        fileHint = beforeAt;
        funcname = afterAt;
        if (!fileHint || !funcname) {
          _printExtractUsage();
          return;
        }
      }
    }
  }

  // --- 2. FILE:FUNC / FILE:LNNN form (only if we don't already have a file hint) ---
  if (!fileHint && funcname.includes(':')) {
    const firstColon = funcname.indexOf(':');
    const beforeColon = funcname.slice(0, firstColon);
    const afterColon = funcname.slice(firstColon + 1);
    // Heuristic: the LHS looks like a path if it contains a slash or a file
    // extension (e.g. `foo.ts`, `bar.js`, `baz.py`, `qux.cpp`). Reject Windows
    // drive letters (single letter + colon at start).
    const looksLikePath =
      beforeColon.length > 1 &&
      (beforeColon.includes('/') || beforeColon.includes('\\') ||
       /\.[a-zA-Z0-9]{1,6}$/.test(beforeColon));
    if (looksLikePath && afterColon) {
      // LINE-based: FILE:LNNN or FILE:NNN — find the function at that line
      const lineMatch = afterColon.match(/^L?(\d+)$/);
      if (lineMatch) {
        const lineNum = parseInt(lineMatch[1]);
        const resolvedName = _findFunctionAtLine(index, beforeColon, lineNum);
        if (!resolvedName) {
          console.log(`No function found at ${beforeColon}:L${lineNum} in the index.`);
          _printExtractUsage();
          return;
        }
        fileHint = beforeColon;
        funcname = resolvedName;
      } else {
        // NAME-based: FILE:FUNC (equivalent to FILE@FUNC)
        fileHint = beforeColon;
        funcname = afterColon;
      }
    }
  }

  // Extract the root function
  const source = index.extractFunctionByName(funcname, fileHint);
  if (!source) return;

  if (commentsOnly) {
    _printComments(source, funcname);
  } else {
    // Apply display-time renames if available
    const displayed = index.applyRenames ? index.applyRenames(source) : source;
    console.log(displayed);
  }

  // --follow-calls: recursively extract callees
  if (followCalls) {
    console.log();
    _followCalls(index, funcname, fileHint, commentsOnly, depth, 0, new Set());
  }
}


/**
 * Recursively extract and display source for callees of a function.
 *
 * @param {CodeSearchIndex} index
 * @param {string} funcName
 * @param {string|null} fileHint
 * @param {boolean} commentsOnly - Show only comments
 * @param {number} maxDepth - Maximum recursion depth
 * @param {number} currentDepth
 * @param {Set<string>} visited - Functions already extracted (avoid loops)
 */
function _followCalls(index, funcName, fileHint, commentsOnly, maxDepth, currentDepth, visited) {
  const indent = '  '.repeat(currentDepth);
  const callees = index.findCallees(funcName, fileHint);

  if (callees.length === 0) {
    console.log(`${indent}(no callees found for ${funcName})`);
    return;
  }

  const header = currentDepth === 0
    ? `${'='.repeat(64)}`
    : `${'-'.repeat(60)}`;
  console.log(`${indent}${header}`);
  console.log(`${indent}Callees of ${funcName} (${callees.length} functions, depth ${currentDepth + 1}/${maxDepth}):`);
  console.log(`${indent}${header}`);

  for (const callee of callees) {
    const name = callee.name;
    const dispName = callee.display_name || name;

    // Skip recursive calls
    if (callee.call_type === 'recursive') {
      console.log(`${indent}  ${dispName} [recursive - skipped]`);
      continue;
    }

    // Skip unresolved dot-calls (e.g. variable.includes() falsely attributed to a class)
    if (callee.ambiguous && !callee.resolved_def) {
      console.log(`${indent}  ${dispName} [unresolved - skipped]`);
      continue;
    }

    // Use resolved definition (disambiguated) or fall back to first
    const def = callee.resolved_def || callee.definitions?.[0];

    // Skip already visited (avoids cycles across call chains)
    const key = `${def?.full_name || name}@${def?.filepath || ''}`;
    if (visited.has(key)) {
      console.log(`${indent}  ${dispName} [already shown above - skipped]`);
      continue;
    }
    visited.add(key);

    if (!def) {
      console.log(`${indent}  ${dispName} [no source in index]`);
      continue;
    }

    const calleeSource = index.getFunctionSource(def.filepath, def.full_name || name);
    if (!calleeSource) {
      console.log(`${indent}  ${dispName} [source not available]`);
      continue;
    }

    const nLines = def.end - def.start + 1;
    const ambigNote = callee.ambiguous ? ' [ambiguous target]' : '';
    console.log();
    console.log(`${indent}# ${def.filepath}@${dispName} (${nLines} lines) [called by ${funcName}]${ambigNote}`);

    if (commentsOnly) {
      _printComments(calleeSource, dispName, indent);
    } else {
      // Indent callee source for visual nesting
      for (const line of calleeSource.split('\n')) {
        console.log(`${indent}${line}`);
      }
    }

    // Recurse deeper if requested — use resolved filepath as file hint
    if (currentDepth + 1 < maxDepth) {
      _followCalls(index, def.full_name || name, def.filepath, commentsOnly, maxDepth, currentDepth + 1, visited);
    }
  }

  if (commentsOnly) {
    console.log();
    console.log(`${indent}Tip: Comments can lie! Verify against actual code logic.`);
  }
}


/**
 * Extract and print only full-line comments from source code.
 * Supports: // ... , # ... , /* ... , * ... (doc-comment continuation)
 *
 * @param {string} source - Function source code
 * @param {string} funcName - For header display
 * @param {string} [indent=''] - Prefix for each line
 */
function _printComments(source, funcName, indent = '') {
  const lines = source.split('\n');
  let inBlockComment = false;
  let commentLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Track block comments
    if (inBlockComment) {
      console.log(`${indent}${lines[i]}`);
      commentLines++;
      if (trimmed.includes('*/')) {
        inBlockComment = false;
      }
      continue;
    }

    // Full-line comment patterns
    if (trimmed.startsWith('//') ||
        trimmed.startsWith('#') ||
        trimmed.startsWith('* ') ||
        trimmed === '*' ||
        trimmed === '*/') {
      console.log(`${indent}${lines[i]}`);
      commentLines++;
      continue;
    }

    // Block comment start on its own line
    if (trimmed.startsWith('/*')) {
      console.log(`${indent}${lines[i]}`);
      commentLines++;
      if (!trimmed.includes('*/')) {
        inBlockComment = true;
      }
      continue;
    }

    // Python/shell doc-level comments: """  or '''
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      console.log(`${indent}${lines[i]}`);
      commentLines++;
      // Check if it's a multi-line docstring
      const quote = trimmed.slice(0, 3);
      if (trimmed.length > 3 && trimmed.endsWith(quote)) {
        continue;  // Single-line docstring
      }
      // Multi-line: print until closing
      for (let j = i + 1; j < lines.length; j++) {
        console.log(`${indent}${lines[j]}`);
        commentLines++;
        if (lines[j].trim().endsWith(quote) || lines[j].trim() === quote) {
          i = j;
          break;
        }
      }
      continue;
    }
  }

  if (commentLines === 0) {
    console.log(`${indent}  (no full-line comments found in ${funcName})`);
  }
}


// ========================================================================
// List Files
// ========================================================================

export function doListFiles(index, args) {
  const pattern = (args.list_files && args.list_files !== '.') ? args.list_files : null;
  const verbose = args.verbose || false;
  const fullPath = args.full_path || false;

  let files = index.listFiles();
  if (pattern) {
    const patLower = pattern.toLowerCase();
    files = files.filter(f => f.toLowerCase().includes(patLower));
  }

  // Apply path filters
  if (args.include_path) {
    files = files.filter(f => args.include_path.some(p => f.toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_path) {
    files = files.filter(f => !args.exclude_path.some(p => f.toLowerCase().includes(p.toLowerCase())));
  }

  if (files.length === 0) {
    console.log('No files' + (pattern ? ` matching '${pattern}'` : '') + '.');
    return;
  }

  // Ensure function index loaded
  index._ensureFunctionIndex();

  let totalLines = 0;
  let totalFuncs = 0;
  const fileStats = [];

  for (const fp of files) {
    const lines = index.fileLines.get(fp) || [];
    const nLines = lines.length;
    const funcs = (index.functionIndex || {})[fp] || {};
    const nFuncs = Object.keys(funcs).length;
    totalLines += nLines;
    totalFuncs += nFuncs;
    fileStats.push([fp, nLines, nFuncs]);
  }

  // Build basename lookup for display
  const basenames = new Map();
  for (const [fp] of fileStats) {
    const bn = path.basename(fp);
    if (!basenames.has(bn)) basenames.set(bn, []);
    basenames.get(bn).push(fp);
  }

  const _displayPath = (fp) => {
    if (fullPath) return fp;
    const bn = path.basename(fp);
    if ((basenames.get(bn) || []).length === 1) return bn;
    return fp;
  };

  const label = pattern ? ` matching '${pattern}'` : '';
  console.log(`\n${files.length} indexed files${label}  (${totalLines.toLocaleString()} lines, ${totalFuncs.toLocaleString()} functions)`);

  if (verbose) {
    console.log(`\n  ${'Lines'.padStart(7)}  ${'Funcs'.padStart(5)}  File`);
    console.log(`  ${'\u2500'.repeat(7)}  ${'\u2500'.repeat(5)}  ${'\u2500'.repeat(50)}`);
    for (const [fp, nLines, nFuncs] of fileStats) {
      console.log(`  ${nLines.toLocaleString().padStart(7)}  ${String(nFuncs).padStart(5)}  ${_displayPath(fp)}`);
    }
  } else {
    for (const [fp] of fileStats) {
      console.log(`  ${_displayPath(fp)}`);
    }
    console.log(`\n  Use --verbose for line/function counts per file`);
  }
}


// ========================================================================
// Show File
// ========================================================================

export function doShowFile(index, args) {
  // #238: an exact full-path match wins outright, and a leading '/' anchors to
  // the repo root — both decided before the fuzzy substring match below, so
  // `--show-file README.md` finds the root file (not "ambiguous") and
  // `--show-file /README.md` never resolves to a nested one.
  const exact = index.resolveExactFileTarget(args.show_file);
  let filepath = exact && !exact.anchored ? exact.filepath : null;

  if (!filepath && exact && exact.anchored) {
    console.log(`No file at root path '${args.show_file}' found in index.`);
    return;
  }

  if (!filepath) {
    const filePattern = args.show_file.replace(/\\/g, '/').toLowerCase();

    const matches = [];
    for (const fp of index.files.keys()) {
      if (fp.replace(/\\/g, '/').toLowerCase().includes(filePattern)) {
        matches.push(fp);
      }
    }

    if (matches.length === 0) {
      console.log(`No files matching '${args.show_file}' found in index.`);
      console.log(`  Tip: Use /files PATTERN in interactive mode to search`);
      return;
    }

    if (matches.length > 1) {
      matches.sort();
      console.log(`Multiple files match '${args.show_file}':`);
      for (let i = 0; i < Math.min(matches.length, 20); i++) {
        console.log(`  [${i + 1}] ${matches[i]}`);
      }
      if (matches.length > 20) console.log(`  ... and ${matches.length - 20} more`);
      console.log(`\nNarrow your search, or re-run with one of the full paths above (an exact path resolves directly). In interactive mode, /file [N] selects by number.`);
      // Store for [N] selection in interactive mode
      index._lastFileMatches = matches.slice(0, 20);
      return;
    }

    filepath = matches[0];
  }

  const lines = index.fileLines.get(filepath);
  if (lines) {
    console.log(`# ${filepath}`);
    console.log(`# ${lines.length} lines`);
    console.log();
    for (let i = 0; i < lines.length; i++) {
      console.log(`${String(i + 1).padStart(5)}: ${lines[i]}`);
    }
  } else {
    console.log(`File '${filepath}' not in literal index (may have been excluded).`);
  }
}


// ========================================================================
// File Bookends — show first N and last N lines of each file
// ========================================================================
//
// Entry points in minified/bundled code are almost always at the top (module
// wrappers, global setup) or at the bottom (the actual invocation that kicks
// things off). For a 500k-line cli.js, scanning for uncalled functions with
// --entry-points misses the top-level IIFE that kicks everything off; reading
// the last 20 lines of the file finds it immediately.
//
// Applies display-time renames so obfuscated entry-point names render
// readably (e.g. VCz() → VCz_KW_…()). Honors --filter, --include-path,
// --exclude-path for narrowing to specific files.

export function doFileBookends(index, args) {
  // Parse N: default 20, or from optional value
  let n = 20;
  const argVal = args.file_bookends;
  if (argVal && argVal !== '.') {
    const parsed = parseInt(argVal, 10);
    if (!isNaN(parsed) && parsed > 0) n = parsed;
  }

  // Collect + filter files
  let files = [...index.fileLines.entries()];
  if (args.filter) {
    // Normalize the path's backslashes to forward slashes so a forward-slash
    // pattern matches Windows paths. Only the field is normalized, never the
    // pattern — rewriting `\` in a /regex/ would corrupt escapes like `\.`.
    const match = makeFilterMatcher(args.filter);
    files = files.filter(([fp]) => match(fp.replace(/\\/g, '/')));
  }
  if (args.include_path) {
    files = files.filter(([fp]) =>
      args.include_path.some(p => fp.toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_path) {
    files = files.filter(([fp]) =>
      !args.exclude_path.some(p => fp.toLowerCase().includes(p.toLowerCase())));
  }

  if (files.length === 0) {
    console.log('No files matched filters for --file-bookends.');
    return;
  }

  // Sort for stable output
  files.sort(([a], [b]) => a.localeCompare(b));

  // Per-chunk rename: join the chunk lines, run applyRenames ONCE so its
  // state machine tracks cross-line block-comment and template-literal state
  // correctly, then split back. Per-line rename calls would reset the state
  // machine every line and clobber identifiers inside multi-line /* */ blocks
  // and backtick templates.
  //
  // For tail chunks, pre-scan from the start of the file to determine whether
  // the chunk begins mid-block-comment or mid-template-literal, and seed
  // applyRenames with that initial state. Pre-scan is cheap (state machine
  // only, no regex) so it's fine even on files with hundreds of thousands
  // of lines.
  const renameChunk = (chunkLines, initialState = 'code') => {
    if (!index.applyRenames) return chunkLines;
    const joined = chunkLines.join('\n');
    const renamed = index.applyRenames(joined, initialState);
    return renamed.split('\n');
  };

  console.log(`\nFile bookends (first ${n} + last ${n} lines, renames applied):`);

  for (const [filepath, lines] of files) {
    const lineCount = lines.length;
    console.log('\n' + '─'.repeat(72));
    console.log(`  ${filepath}  (${lineCount} lines)`);
    console.log('─'.repeat(72));

    if (lineCount === 0) {
      console.log('  (empty file)');
      continue;
    }

    if (lineCount <= 2 * n) {
      // Short file — show whole thing, rename the whole thing at once
      const renamed = renameChunk(lines);
      for (let i = 0; i < lineCount; i++) {
        console.log(`  ${String(i + 1).padStart(7)}: ${renamed[i]}`);
      }
    } else {
      // Head — always starts at 'code' state (files begin in code)
      const headRenamed = renameChunk(lines.slice(0, n));
      for (let i = 0; i < n; i++) {
        console.log(`  ${String(i + 1).padStart(7)}: ${headRenamed[i]}`);
      }
      const omitted = lineCount - 2 * n;
      console.log(`  ${'...'.padStart(7)}   [${omitted.toLocaleString()} lines omitted]`);
      // Tail — pre-scan from start of file to determine whether we're
      // entering the chunk mid-block-comment or mid-template-literal, so
      // applyRenames doesn't clobber identifiers inside those contexts.
      const tailStart = lineCount - n;
      const tailInitialState = index.scanFileToLine
        ? index.scanFileToLine(lines, tailStart)
        : 'code';
      const tailRenamed = renameChunk(lines.slice(tailStart), tailInitialState);
      for (let i = 0; i < n; i++) {
        console.log(`  ${String(tailStart + i + 1).padStart(7)}: ${tailRenamed[i]}`);
      }
    }
  }

  console.log(`\n${files.length} file${files.length === 1 ? '' : 's'} shown.` +
              (files.length > 1 ? '  Use --filter PATTERN to narrow to one file.' : ''));
}


// ========================================================================
// Bundle Seams — detect module wrapper boundaries in bundled JS
// ========================================================================
//
// For minified bundles (claude-code cli.js, mermaid.min.js, ...), detect
// the esbuild-style module wrapper pattern and list each original-source
// module with its line range, kind (ESM/CJS), and a content preview.
//
// Pairs with --file-bookends: bookends shows the top/tail of the whole
// file; bundle-seams carves the file into its original module chunks.
// Together they give you an architectural map of a minified bundle.
//
// Honors --filter / --include-path / --exclude-path for narrowing to
// specific files. --seam-verbose enables per-module source-path and
// license-header scanning (more expensive but surfaces path hints like
// `node_modules/zod/dist/...`).

export function doBundleSeams(index, args) {
  // Collect + filter files. Default: auto-select large JS-like files.
  const pat = (typeof args.bundle_seams === 'string' && args.bundle_seams !== '.')
    ? args.bundle_seams : null;

  let files = [...index.fileLines.keys()];
  if (pat) {
    const p = pat.toLowerCase().replace(/\\/g, '/');
    files = files.filter(fp => fp.toLowerCase().replace(/\\/g, '/').includes(p));
  } else {
    // Auto: only consider .js / .mjs / .cjs files with > 1000 lines —
    // small JS files are rarely bundled output.
    files = files.filter(fp => {
      const ext = fp.toLowerCase();
      if (!(ext.endsWith('.js') || ext.endsWith('.mjs') || ext.endsWith('.cjs'))) return false;
      const lines = index.fileLines.get(fp);
      return lines && lines.length > 1000;
    });
  }
  if (args.filter) {
    const f = args.filter.toLowerCase();
    files = files.filter(fp => fp.toLowerCase().includes(f));
  }
  if (args.include_path) {
    files = files.filter(fp =>
      args.include_path.some(p => fp.toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_path) {
    files = files.filter(fp =>
      !args.exclude_path.some(p => fp.toLowerCase().includes(p.toLowerCase())));
  }

  if (files.length === 0) {
    console.log('No files matched for --bundle-seams. Try a filter pattern or --include-path.');
    return;
  }
  files.sort();

  const verbose = args.seam_verbose || args.verbose;
  const max = args.max_results || 20;

  for (const filepath of files) {
    const lines = index.fileLines.get(filepath);
    const result = index.detectBundleSeams(filepath, { scanHints: verbose });
    console.log('\n' + '─'.repeat(72));
    console.log(`  ${filepath}  (${lines.length} lines)`);
    console.log('─'.repeat(72));

    if (result.error) {
      console.log(`  Error: ${result.error}`);
      continue;
    }
    if (!result.pattern) {
      console.log('  No bundle-seam pattern detected.');
      const h = result.helpers;
      if (h.esm || h.cjs) {
        console.log(`  (partial helper detection: esm=${h.esm || 'none'}, cjs=${h.cjs || 'none'})`);
      }
      continue;
    }

    const esmCount = result.modules.filter(m => m.kind === 'ESM').length;
    const cjsCount = result.modules.filter(m => m.kind === 'CJS').length;
    const gapCount = result.modules.filter(m => m.kind === 'GAP').length;
    console.log(`  Pattern: ${result.pattern}  ESM helper: ${result.helpers.esm || '-'}  CJS helper: ${result.helpers.cjs || '-'}`);
    let modSummary = `  Modules: ${result.modules.length}  (${esmCount} ESM, ${cjsCount} CJS`;
    if (gapCount > 0) modSummary += `, ${gapCount} gap`;
    modSummary += ')';
    console.log(modSummary);
    if (result.pattern === 'esbuild-iife') {
      console.log(`  Outer IIFE starts at L${result.helpers.iifeStartLine}`);
      if (gapCount > 0) {
        console.log(`  (gap modules are inter-wrapper code regions containing function defs;`);
        console.log(`   for IIFE-style bundles where wrappers are tiny name-assignment scaffolds,`);
        console.log(`   the gaps are where the original source files actually live.)`);
      }
    }
    console.log();

    const toShow = result.modules.slice(0, max);
    for (const m of toShow) {
      // Apply rename to module name if available (wrappers are in func index)
      const dn = index.getDisplayName ? index.getDisplayName(m.name) : m.name;
      const kind = m.kind.padEnd(3);
      const nameCol = dn.length > 36 ? dn.slice(0, 33) + '...' : dn.padEnd(36);
      console.log(`  ${nameCol} [${kind}]  L${String(m.startLine).padStart(7)}-${String(m.endLine).padStart(7)}  ${String(m.lineCount).padStart(5)}L`);
      if (m.preview && m.preview !== '(no preview)') {
        const p = m.preview.length > 100 ? m.preview.slice(0, 97) + '...' : m.preview;
        console.log(`      preview: ${p}`);
      }
      if (m.hints) {
        if (m.hints.paths.length > 0) {
          console.log(`      paths:   ${m.hints.paths.slice(0, 3).join(', ')}${m.hints.paths.length > 3 ? ', ...' : ''}`);
        }
        if (m.hints.licenses.length > 0) {
          console.log(`      license: ${m.hints.licenses[0]}`);
        }
      }
      // Per-module function inventory.
      //   - Wrappers: only populated when --seam-verbose
      //   - Gap modules: always populated (they exist BECAUSE of contained funcs)
      // For non-verbose runs we still want to show function counts on gap
      // modules, since the count IS the value of the gap module entry.
      if (m.functions && m.functions.length > 0) {
        // For non-verbose wrapper modules we'd skip the per-function detail,
        // but verbose for either, OR any gap module, gets the listing.
        const showDetail = verbose || m.kind === 'GAP';
        if (showDetail) {
          const shownFns = m.functions.slice(0, 8);
          console.log(`      functions: ${m.functions.length} in this seam`);
          for (const fn of shownFns) {
            const dn = index.getDisplayName ? index.getDisplayName(fn.name) : fn.name;
            const size = fn.end - fn.start + 1;
            console.log(`        L${String(fn.start).padStart(6)}-${String(fn.end).padStart(6)}  ${size}L  ${dn}`);
          }
          if (m.functions.length > shownFns.length) {
            console.log(`        ... and ${m.functions.length - shownFns.length} more functions`);
          }
        }
      }
    }
    if (result.modules.length > toShow.length) {
      console.log(`\n  ... and ${result.modules.length - toShow.length} more. Use --max-results N (or --max N) for more.`);
    }
  }
}


// ========================================================================
// List Functions
// ========================================================================

export function doListFunctions(index, args) {
  const pattern = args.list_functions;
  let functions = index.listFunctions();

  if (pattern) {
    const patLower = pattern.toLowerCase().replace(/\\/g, '/');
    functions = functions.filter(f => {
      const dn = index.getDisplayName ? index.getDisplayName(f.name) : f.name;
      return f.name.toLowerCase().includes(patLower) ||
        dn.toLowerCase().includes(patLower) ||
        f.filepath.toLowerCase().replace(/\\/g, '/').includes(patLower);
    });
  }

  // Apply --filter to function names (checks both original and display name)
  if (args.filter) {
    const match = makeFilterMatcher(args.filter);
    functions = functions.filter(f =>
      match(f.name, index.getDisplayName ? index.getDisplayName(f.name) : f.name));
  }

  // Apply path filters
  if (args.include_path) {
    functions = functions.filter(f =>
      args.include_path.some(p => f.filepath.toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_path) {
    functions = functions.filter(f =>
      !args.exclude_path.some(p => f.filepath.toLowerCase().includes(p.toLowerCase())));
  }

  if (functions.length === 0) {
    console.log('No functions found.');
    return;
  }

  // Group by file
  const byFile = new Map();
  for (const f of functions) {
    if (!byFile.has(f.filepath)) byFile.set(f.filepath, []);
    byFile.get(f.filepath).push(f);
  }

  const filterNote = args.filter ? ` matching '${args.filter}'` : '';
  console.log(`\n${functions.length} functions${filterNote}:\n`);

  for (const [filepath, funcs] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`\n${filepath}:`);
    const sorted = funcs.sort((a, b) => a.start - b.start);
    for (const f of sorted) {
      let dn = index.getDisplayName ? index.getDisplayName(f.name) : (f.displayName || f.name);
      // Truncate pathological "function names" that are really captured JS
      // expressions. TypeScript private-field compilation produces class
      // bodies like `class X { [(_A=new WeakMap(),_B=new WeakMap(),...)] }`
      // where the regex parser can mistake the computed-key `[...]` for a
      // method name and swallow kilobytes of initialization code. Clamp for
      // display so a single bad entry doesn't dump hundreds of lines of
      // source into the listing output. Underlying function-index entry is
      // untouched — --extract by the raw name still works if needed.
      if (dn.length > 80 || dn.includes('\n')) {
        dn = dn.replace(/\s+/g, ' ').slice(0, 77) + '...';
      }
      if (args.full_path) {
        // #241: emit a paste-ready file@function token. Keep the padded (aligned)
        // form when the token has no space — byte-identical to before; only quote
        // (and drop the padding) in the rare path/name-with-space case.
        const core = `${filepath}@${dn}`;
        const tok = core.includes(' ') ? quotePathIfNeeded(core) : `${filepath}@${dn.padEnd(40)}`;
        console.log(`  ${tok} L${String(f.start).padStart(5)}-${String(f.end).padEnd(5)} ${String(f.lines).padStart(4)} lines (${f.type})`);
      } else {
        console.log(`  ${dn.padEnd(40)} L${String(f.start).padStart(5)}-${String(f.end).padEnd(5)} ${String(f.lines).padStart(4)} lines (${f.type})`);
      }
    }
  }

  // #241/#238: when the same displayed name spans more than one file, the bare
  // name is ambiguous to --extract — point the user at --full-path, which prints
  // paste-ready file@function tokens. Only on the default (grouped) view.
  if (!args.full_path) {
    const nameFiles = new Map();
    for (const f of functions) {
      const dn = index.getDisplayName ? index.getDisplayName(f.name) : (f.displayName || f.name);
      if (!nameFiles.has(dn)) nameFiles.set(dn, new Set());
      nameFiles.get(dn).add(f.filepath);
    }
    const collisions = [...nameFiles.values()].filter(s => s.size > 1).length;
    if (collisions > 0) {
      console.log(`\nTip: ${collisions} name${collisions === 1 ? '' : 's'} appear in more than one file. Add --full-path to print file@function tokens you can paste into --extract.`);
    }
  }
}


export function doListFunctionsAlpha(index, args) {
  let functions = index.listFunctions();

  if (args.filter) {
    const match = makeFilterMatcher(args.filter);
    functions = functions.filter(f => match(f.name));
  }
  if (args.include_path) {
    functions = functions.filter(f =>
      args.include_path.some(p => f.filepath.toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_path) {
    functions = functions.filter(f =>
      !args.exclude_path.some(p => f.filepath.toLowerCase().includes(p.toLowerCase())));
  }

  if (functions.length === 0) {
    console.log('No functions found.');
    return;
  }

  functions.sort((a, b) => (a.displayName || a.name).toLowerCase().localeCompare(
                            (b.displayName || b.name).toLowerCase()));

  const filterNote = args.filter ? ` matching '${args.filter}'` : '';
  console.log(`\n${functions.length} functions${filterNote} (alphabetical):\n`);

  if (args.full_path) {
    console.log(`${'file@function'.padEnd(70)} ${'Lines'.padStart(6)}`);
    console.log('='.repeat(80));
    for (const f of functions) {
      const dn = f.displayName || f.name;
      const fullRef = quotePathIfNeeded(`${f.filepath}@${dn}`);  // #241: paste-safe
      console.log(`${fullRef.padEnd(70)} ${String(f.lines).padStart(6)}`);
    }
  } else {
    console.log(`${'Function'.padEnd(45)} ${'Lines'.padStart(6)}  ${'File'.padEnd(50)}`);
    console.log('='.repeat(105));
    for (const f of functions) {
      const dn = (f.displayName || f.name).slice(0, 44);
      const filepath = f.filepath.slice(0, 49);
      console.log(`${dn.padEnd(45)} ${String(f.lines).padStart(6)}  ${filepath.padEnd(50)}`);
    }
  }
}


export function doListFunctionsSize(index, args) {
  let functions = index.listFunctions();

  // Apply --filter
  if (args.filter) {
    const match = makeFilterMatcher(args.filter);
    functions = functions.filter(f => match(f.name, f.filepath));
  }

  // Apply path filters
  if (args.include_path) {
    functions = functions.filter(f =>
      args.include_path.some(p => f.filepath.toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_path) {
    functions = functions.filter(f =>
      !args.exclude_path.some(p => f.filepath.toLowerCase().includes(p.toLowerCase())));
  }

  if (functions.length === 0) {
    console.log('No functions found.');
    return;
  }

  // Sort by size descending
  functions.sort((a, b) => b.lines - a.lines);

  const filterNote = args.filter ? ` matching '${args.filter}'` : '';
  console.log(`\n${functions.length} largest functions${filterNote}:\n`);

  if (args.full_path) {
    console.log(`${'Lines'.padStart(6)}  file@function`);
    console.log('='.repeat(90));
    for (const f of functions) {
      const dn = f.displayName || f.name;
      const fullRef = quotePathIfNeeded(`${f.filepath}@${dn}`);  // #241: paste-safe
      console.log(`${String(f.lines).padStart(6)}  ${fullRef}`);
    }
  } else {
    console.log(`${'Lines'.padStart(6)}  ${'Function'.padEnd(45)} ${'File'.padEnd(50)}`);
    console.log('='.repeat(105));
    for (const f of functions) {
      const dn = (f.displayName || f.name).slice(0, 44);
      const filepath = f.filepath.slice(0, 49);
      console.log(`${String(f.lines).padStart(6)}  ${dn.padEnd(45)} ${filepath.padEnd(50)}`);
    }
  }
}
