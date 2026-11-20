// search.js — --search/--literal/--fast/--regex/--files-search/--folders-search plus rename-marker query expansion
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * search.js - Search commands: search, literal, fast, regex,
 * files-search, folders-search.
 *
 * Origin: an earlier Python implementation (not in this repo).
 */

import path from 'path';
import { SearchResult, displayName, quotePathIfNeeded } from '../utils.js';
import { effectiveMaxResults } from '../argparse.js';
import { isTestPath, leavesTestsOut } from '../core/test-paths.js';


// ========================================================================
// Display helpers
// ========================================================================

/**
 * If the query contains a rename marker (_KW_, _CMD_, _IMPORT_), look up
 * matching originals in the rename map and return a regex alternation pattern
 * over those originals. Returns { query, expanded, originals } — when expanded,
 * `query` is a regex with \b boundaries, and the caller should pass useRegex.
 *
 * Caps expansion at 500 originals to keep the alternation regex manageable.
 */
const _RENAME_MARKER_RE = /_KW_|_CMD_|_IMPORT_/;
const _ALT_CAP = 500;

export function expandRenameQuery(index, query) {
  if (!index || typeof index.findOriginalsByDisplayPattern !== 'function') {
    return { query, expanded: false };
  }
  if (!_RENAME_MARKER_RE.test(query)) return { query, expanded: false };
  const originals = index.findOriginalsByDisplayPattern(query);
  if (originals.length === 0) return { query, expanded: false };

  let truncated = false;
  let used = originals;
  if (originals.length > _ALT_CAP) {
    used = originals.slice(0, _ALT_CAP);
    truncated = true;
  }
  const escaped = used.map(o => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = '\\b(?:' + escaped.join('|') + ')\\b';
  return { query: pattern, expanded: true, originals, truncated, totalOriginals: originals.length };
}

function _printExpansionNotice(orig, expansion) {
  if (!expansion.expanded) return;
  const note = expansion.truncated
    ? `[rename-aware: '${orig}' → ${expansion.totalOriginals} originals (capped at ${_ALT_CAP}); searching their call sites]`
    : `[rename-aware: '${orig}' → ${expansion.totalOriginals} original name${expansion.totalOriginals === 1 ? '' : 's'}; searching their call sites]`;
  console.log(note);
}

// search-huge-line-from-minified-bundle (2026-11-19). A hit on a line of a minified bundle
// was printed whole: `--search rust` on a snapshot of Bram printed nine lines of 9,837 to
// 327,144 characters, the match up to 285,944 characters in. A line longer than LONG_LINE
// is shown as a window around its first match, with the line's length said, so the reader
// sees what matched and knows what was left out. --full-lines prints lines whole.
/** A matched line longer than this is shown as a window around its first match. */
export const LONG_LINE = 300;
/** Characters shown on each side of the match in such a window. */
export const LINE_WINDOW_PAD = 100;
const _nf = (n) => Number(n).toLocaleString('en-US');

/**
 * A finder for where a query matched in a line: a case-insensitive RegExp of the query's
 * words (any of them), or the pattern itself under `regex`. Null when the pattern does not
 * compile; the caller then cuts from the line's start.
 */
export function queryFinder(query, { regex = false, caseSensitive = false } = {}) {
  const q = String(query == null ? '' : query);
  if (!q.trim()) return null;
  try {
    if (regex) return new RegExp(q, caseSensitive ? 'g' : 'gi');
    const words = q.split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(words.join('|'), caseSensitive ? 'g' : 'gi');
  } catch { return null; }
}

/** The line as it is printed: trimmed, and when it is long, a window around the first match with a note of its length. */
export function windowLine(line, find, { limit = LONG_LINE, pad = LINE_WINDOW_PAD } = {}) {
  const s = String(line == null ? '' : line).trim();
  if (s.length <= limit) return s;
  let first = null, count = 0;
  if (find) {
    const re = new RegExp(find.source, find.flags.includes('g') ? find.flags : `${find.flags}g`);
    for (let m = re.exec(s); m && count < 100000; m = re.exec(s)) {
      if (!first) first = m;
      count++;
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  const at = first ? first.index : 0;
  const len = first ? Math.min(first[0].length, limit) : 0;
  const from = Math.max(0, at - pad);
  const to = Math.min(s.length, at + len + (first ? pad : 2 * pad));
  const note = `[line of ${_nf(s.length)} chars${count > 1 ? `; ${_nf(count)} matches, the first shown` : ''}; --full-lines shows it whole]`;
  return `${from > 0 ? '…' : ''}${s.slice(from, to)}${to < s.length ? '…' : ''}  ${note}`;
}

/**
 * Pretty-print search results, grouped by file.
 * @param {SearchResult[]} results
 * @param {object} opts
 * @param {boolean} [opts.verbose=false]
 * @param {number|null} [opts.maxResults]
 * @param {string[]|null} [opts.pathMatches]
 * @param {number|null} [opts.totalFound]
 * @param {object} [opts.index]  If provided, applies rename map to displayed
 *   line text and function names so search hits show their renamed form.
 */
export function printResults(results, { verbose = false, maxResults = null,
                                        pathMatches = null, totalFound = null,
                                        pathFilter = null, index = null,
                                        find = null, fullLines = false } = {}) {
  const shownLine = (t) => (fullLines ? String(t).trim() : windowLine(t, find));
  // Show active path filter
  if (pathFilter) {
    console.log(`  [path filter: --in ${pathFilter}]`);
  }

  // Show path matches first
  if (pathMatches && pathMatches.length > 0) {
    console.log(`\n[Path matches] (${pathMatches.length} paths contain search term):`);
    for (const p of pathMatches.slice(0, 10)) {
      console.log(`    ${p}`);
    }
    if (pathMatches.length > 10) {
      console.log(`    ... and ${pathMatches.length - 10} more`);
    }
    console.log();
  }

  if (results.length === 0) {
    if (!pathMatches || pathMatches.length === 0) {
      console.log('No results found.');
    }
    return;
  }

  const actualTotal = totalFound != null ? totalFound : results.length;
  const truncated = actualTotal > results.length ||
                    (maxResults != null && results.length >= maxResults);

  if (truncated) {
    console.log(`Showing ${results.length} of ${actualTotal}+ results:\n`);
  } else {
    console.log(`Found ${results.length} results:\n`);
  }

  // Group results by file, preserving order of first appearance
  const grouped = new Map();
  for (const r of results) {
    if (!grouped.has(r.filePath)) {
      grouped.set(r.filePath, []);
    }
    grouped.get(r.filePath).push(r);
  }

  for (const [filepath, fileResults] of grouped) {
    const nHits = fileResults.length;

    // Determine if function names vary within this file's results
    const funcNames = new Set(fileResults.filter(r => r.functionName).map(r => r.functionName));
    const allSameFunc = funcNames.size <= 1;
    const matchTypes = new Set(fileResults.map(r => r.matchType));
    const allLiteral = matchTypes.size === 1 && matchTypes.has('literal');

    // Build file header (apply rename to function name if index is provided)
    const headerFunc = (index && funcNames.size > 0)
      ? index.getDisplayName([...funcNames][0])
      : (funcNames.size > 0 ? [...funcNames][0] : null);
    let hitLabel = '';
    if (nHits > 1) {
      if (headerFunc && allSameFunc) {
        hitLabel = `(${nHits} hits, all in ${headerFunc}):`;
      } else {
        hitLabel = `(${nHits} hits):`;
      }
    } else {
      if (headerFunc && allSameFunc) {
        hitLabel = `(in ${headerFunc}):`;
      }
    }

    console.log('\u2500'.repeat(60));
    console.log(`  ${quotePathIfNeeded(filepath)}  ${hitLabel}`);   // #241: paste-safe copy-target

    let prevFunc = null;
    for (const r of fileResults) {
      // Show function name only when it changes (apply rename if available)
      const dnFunc = (index && r.functionName) ? index.getDisplayName(r.functionName) : r.functionName;
      let funcTag = '';
      if (!allSameFunc && dnFunc && dnFunc !== prevFunc) {
        funcTag = `  [${dnFunc}]`;
        prevFunc = dnFunc;
      }

      // Show match type only when it's not literal
      let typeTag = '';
      if (!allLiteral && r.matchType !== 'literal') typeTag = `  (${r.matchType})`;

      const displayLine = index ? index.applyRenames(r.lineText) : r.lineText;
      console.log(`    L${r.lineNumber}  ${shownLine(displayLine)}${funcTag}${typeTag}`);

      if (verbose) {
        console.log(`\n    Context:`);
        for (const ctxLine of r.context.split('\n')) {
          // A context line is cut the same way; an ordinary one keeps its indentation.
          console.log(`      ${fullLines || ctxLine.length <= LONG_LINE ? ctxLine : windowLine(ctxLine, find)}`);
        }
        console.log();
      }
    }
  }

  // Bottom-of-output truncation warning
  if (truncated) {
    const suggestN = Math.max(actualTotal, (maxResults || 20) * 5);
    console.log(`\n  *** Showing ${results.length} of ${actualTotal}+ results. ` +
                `Use --max-results ${suggestN} for more. ***`);
    console.log(`  *** Do NOT draw conclusions about absence from partial results. ***`);
  }
}


/**
 * Apply --include-path and --exclude-path filters to search results.
 */
export function filterResultsByPath(results, args) {
  const noTests = leavesTestsOut(args);
  if (!args.include_path && !args.exclude_path && !args.vocab_in && !noTests) return results;

  return results.filter(r => {
    const pathLower = r.filePath.toLowerCase();
    // --exclude-tests / --no-tests: test, benchmark, mock and example files (test-paths.js)
    if (noTests && isTestPath(r.filePath)) return false;

    // --in filter (universal path filter)
    if (args.vocab_in) {
      if (!pathLower.includes(args.vocab_in.toLowerCase())) {
        return false;
      }
    }

    if (args.include_path) {
      if (!args.include_path.some(p => pathLower.includes(p.toLowerCase()))) {
        return false;
      }
    }
    if (args.exclude_path) {
      if (args.exclude_path.some(p => pathLower.includes(p.toLowerCase()))) {
        return false;
      }
    }
    return true;
  });
}


// ========================================================================
// Command handlers
// ========================================================================

export function doSearch(index, args) {
  let pathMatches = index.findPathMatches(args.search);
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    pathMatches = pathMatches.filter(p => p.toLowerCase().includes(pat));
  }
  // Rename-aware: if query contains _KW_/_CMD_/_IMPORT_, expand to underlying originals
  const expansion = expandRenameQuery(index, args.search);
  _printExpansionNotice(args.search, expansion);
  let results;
  if (expansion.expanded) {
    // caseSensitive: true — obfuscated identifiers like Ga6 vs gA6 are distinct
    // functions; case-insensitive matching causes false positives.
    // filterStringContext: true — skip matches whose offset falls inside a
    // single-line string literal (e.g. `format: "base64"`).
    results = index.searchLiteral(expansion.query, {
      useRegex: true,
      caseSensitive: true,
      filterStringContext: true,
      maxResults: args.max_results * 5,
      contextLines: args.context,
    });
  } else {
    results = index.searchHybrid(args.search, {
      maxResults: args.max_results * 5,
      contextLines: args.context,
    });
  }
  results = filterResultsByPath(results, args);
  const totalFound = results.length;
  results = results.slice(0, args.max_results);
  printResults(results, {
    verbose: args.verbose,
    maxResults: args.max_results,
    pathMatches,
    totalFound,
    pathFilter: args.vocab_in || null,
    index,
    find: expansion.expanded ? queryFinder(expansion.query, { regex: true, caseSensitive: true }) : queryFinder(args.search),
    fullLines: !!args.full_lines,
  });
}

export function doLiteral(index, args) {
  let pathMatches = index.findPathMatches(args.literal);
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    pathMatches = pathMatches.filter(p => p.toLowerCase().includes(pat));
  }
  const expansion = expandRenameQuery(index, args.literal);
  _printExpansionNotice(args.literal, expansion);
  let results = index.searchLiteral(expansion.query, {
    useRegex: expansion.expanded || false,
    // Identifier matching for rename-expanded queries must be case-sensitive
    // (obfuscated names like Ga6/gA6 are distinct functions).
    caseSensitive: expansion.expanded || false,
    // Skip hits whose offset falls inside a single-line string literal.
    filterStringContext: expansion.expanded || false,
    maxResults: args.max_results * 5,
    contextLines: args.context,
  });
  results = filterResultsByPath(results, args);
  const totalFound = results.length;
  results = results.slice(0, args.max_results);
  printResults(results, {
    verbose: args.verbose,
    maxResults: args.max_results,
    pathMatches,
    totalFound,
    pathFilter: args.vocab_in || null,
    index,
    find: queryFinder(expansion.query, { regex: !!expansion.expanded, caseSensitive: !!expansion.expanded }),
    fullLines: !!args.full_lines,
  });
}

export function doFast(index, args) {
  let pathMatches = index.findPathMatches(args.fast);
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    pathMatches = pathMatches.filter(p => p.toLowerCase().includes(pat));
  }
  // Rename-aware: --fast normally uses the inverted index (literal token lookup),
  // which can't match a regex alternation. When the query expands to multiple
  // originals, fall back to regex literal search instead.
  const expansion = expandRenameQuery(index, args.fast);
  _printExpansionNotice(args.fast, expansion);
  let results;
  if (expansion.expanded) {
    results = index.searchLiteral(expansion.query, {
      useRegex: true,
      caseSensitive: true,
      filterStringContext: true,
      maxResults: args.max_results * 5,
      contextLines: args.context,
    });
  } else {
    results = index.searchInverted(args.fast, {
      maxResults: args.max_results * 5,
    });
  }
  results = filterResultsByPath(results, args);
  const totalFound = results.length;
  results = results.slice(0, args.max_results);
  printResults(results, {
    verbose: args.verbose,
    maxResults: args.max_results,
    pathMatches,
    totalFound,
    pathFilter: args.vocab_in || null,
    index,
    find: queryFinder(args.fast),
    fullLines: !!args.full_lines,
  });
}

export function doRegex(index, args) {
  let pattern = args.regex;
  // JS-regex-literal syntax: /pattern/flags. When present, honor flags as
  // a JS regex would — `/foo/` is case-sensitive, `/foo/i` is insensitive.
  // Bare patterns without delimiters keep the historical case-insensitive
  // default for backward compat.
  let caseSensitive = false;
  const litMatch = pattern.match(/^\/(.+?)\/([gimsuy]*)$/);
  if (litMatch) {
    pattern = litMatch[1];
    caseSensitive = !litMatch[2].includes('i');
  }
  const effectiveMax = effectiveMaxResults(args, 200);
  let results = index.searchLiteral(pattern, {
    useRegex: true,
    caseSensitive,
    maxResults: Number.isFinite(effectiveMax) ? Math.max(effectiveMax * 5, 1000) : 1000000,
    contextLines: args.context,
  });
  results = filterResultsByPath(results, args);
  const totalFound = results.length;
  results = results.slice(0, effectiveMax);
  printResults(results, {
    verbose: args.verbose,
    maxResults: effectiveMax,
    totalFound,
    pathFilter: args.vocab_in || null,
    index,
    find: queryFinder(pattern, { regex: true, caseSensitive }),
    fullLines: !!args.full_lines,
  });
}

export function doFilesSearch(index, args) {
  let pattern = args.files_search;
  const useRegex = pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2;
  if (useRegex) pattern = pattern.slice(1, -1);

  let results = index.searchLiteral(pattern, {
    useRegex,
    maxResults: 50000,
    contextLines: 0,
  });
  results = filterResultsByPath(results, args);

  if (results.length === 0) {
    console.log(`No hits for '${args.files_search}'`);
    return;
  }

  // Count hits per file
  const fileCounts = new Map();
  for (const r of results) {
    fileCounts.set(r.filePath, (fileCounts.get(r.filePath) || 0) + 1);
  }
  const totalHits = results.length;

  console.log(`\nFiles containing '${args.files_search}' (${totalHits} hits in ${fileCounts.size} files):\n`);
  console.log(`  ${'Hits'.padStart(6)}  File`);
  console.log(`  ${'----'.padStart(6)}  ----`);

  const n = effectiveMaxResults(args, 30);
  const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);

  for (const [filepath, count] of sorted.slice(0, n)) {
    let fpDisplay = filepath;
    if (!args.full_path && fpDisplay.length > 70) {
      fpDisplay = '...' + fpDisplay.slice(-67);
    }
    console.log(`  ${String(count).padStart(6)}  ${quotePathIfNeeded(fpDisplay)}`);   // #241: paste-safe
  }

  if (sorted.length > n) {
    console.log(`\n  ... ${sorted.length - n} more files (use --max-results or --all-results to see more)`);
  }
}

export function doFoldersSearch(index, args) {
  let pattern = args.folders_search;
  const useRegex = pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2;
  if (useRegex) pattern = pattern.slice(1, -1);

  let results = index.searchLiteral(pattern, {
    useRegex,
    maxResults: 50000,
    contextLines: 0,
  });
  results = filterResultsByPath(results, args);

  if (results.length === 0) {
    console.log(`No hits for '${args.folders_search}'`);
    return;
  }

  const folderCounts = new Map();
  const folderFiles = new Map();
  for (const r of results) {
    const folder = path.dirname(r.filePath) || '.';
    folderCounts.set(folder, (folderCounts.get(folder) || 0) + 1);
    if (!folderFiles.has(folder)) folderFiles.set(folder, new Set());
    folderFiles.get(folder).add(r.filePath);
  }

  const totalHits = results.length;
  console.log(`\nFolders containing '${args.folders_search}' (${totalHits} hits in ${folderCounts.size} folders):\n`);
  console.log(`  ${'Hits'.padStart(6)}  ${'Files'.padStart(6)}  Folder`);
  console.log(`  ${'----'.padStart(6)}  ${'-----'.padStart(6)}  ------`);

  const n = effectiveMaxResults(args, 30);
  const sorted = [...folderCounts.entries()].sort((a, b) => b[1] - a[1]);

  for (const [folder, count] of sorted.slice(0, n)) {
    const nfiles = folderFiles.get(folder).size;
    let fpDisplay = folder;
    if (!args.full_path && fpDisplay.length > 60) {
      fpDisplay = '...' + fpDisplay.slice(-57);
    }
    console.log(`  ${String(count).padStart(6)}  ${String(nfiles).padStart(6)}  ${quotePathIfNeeded(fpDisplay)}`);   // #241: paste-safe
  }

  if (sorted.length > n) {
    console.log(`\n  ... ${sorted.length - n} more folders (use --max-results or --all-results to see more)`);
  }
}
