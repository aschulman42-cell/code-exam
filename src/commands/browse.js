/**
 * browse.js - Index browsing commands: stats, list-files, show-file,
 * list-functions, list-functions-alpha, list-functions-size,
 * scan-extensions, index-extensions, list-indexes, extract.
 *
 * Port of ce_browse.py
 */

import fs from 'fs';
import path from 'path';
import { displayName, eprint } from '../utils.js';
import { CodeSearchIndex } from '../core/CodeSearchIndex.js';


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

  // Parse FILE@FUNCTION or just FUNCTION
  let fileHint = null;
  let funcname = extractArg;
  if (extractArg.includes('@')) {
    const firstAt = extractArg.indexOf('@');
    fileHint = extractArg.slice(0, firstAt);
    funcname = extractArg.slice(firstAt + 1);
    if (!fileHint || !funcname) {
      console.log('Usage: --extract FUNCTION or --extract FILE@FUNCTION');
      console.log('Example: --extract backward_pass');
      console.log('Example: --extract nn_sine.cpp@backward_pass');
      return;
    }
  }

  // Extract the root function
  const source = index.extractFunctionByName(funcname, fileHint);
  if (!source) return;

  if (commentsOnly) {
    _printComments(source, funcname);
  } else {
    console.log(source);
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
    console.log(`\nNarrow your search, use full path, or use /file [N] to select.`);
    // Store for [N] selection in interactive mode
    index._lastFileMatches = matches.slice(0, 20);
    return;
  }

  const filepath = matches[0];
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
// List Functions
// ========================================================================

export function doListFunctions(index, args) {
  const pattern = args.list_functions;
  let functions = index.listFunctions();

  if (pattern) {
    const patLower = pattern.toLowerCase().replace(/\\/g, '/');
    functions = functions.filter(f =>
      f.name.toLowerCase().includes(patLower) ||
      f.filepath.toLowerCase().replace(/\\/g, '/').includes(patLower)
    );
  }

  // Apply --filter to function names
  if (args.filter) {
    const filterLower = args.filter.toLowerCase();
    functions = functions.filter(f => f.name.toLowerCase().includes(filterLower));
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
      const dn = f.displayName || f.name;
      if (args.full_path) {
        console.log(`  ${filepath}@${dn.padEnd(40)} L${String(f.start).padStart(5)}-${String(f.end).padEnd(5)} ${String(f.lines).padStart(4)} lines (${f.type})`);
      } else {
        console.log(`  ${dn.padEnd(40)} L${String(f.start).padStart(5)}-${String(f.end).padEnd(5)} ${String(f.lines).padStart(4)} lines (${f.type})`);
      }
    }
  }
}


export function doListFunctionsAlpha(index, args) {
  let functions = index.listFunctions();

  if (args.filter) {
    const filterLower = args.filter.toLowerCase();
    functions = functions.filter(f => f.name.toLowerCase().includes(filterLower));
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
      const fullRef = `${f.filepath}@${dn}`;
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
    const filterLower = args.filter.toLowerCase();
    functions = functions.filter(f =>
      f.name.toLowerCase().includes(filterLower) ||
      f.filepath.toLowerCase().includes(filterLower));
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
      const fullRef = `${f.filepath}@${dn}`;
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
