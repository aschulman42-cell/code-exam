/**
 * search.js - Search commands: search, literal, fast, regex,
 * files-search, folders-search.
 *
 * Port of ce_search.py
 */

import path from 'path';
import { SearchResult, displayName } from '../utils.js';


// ========================================================================
// Display helpers
// ========================================================================

/**
 * Pretty-print search results, grouped by file.
 * @param {SearchResult[]} results
 * @param {object} opts
 * @param {boolean} [opts.verbose=false]
 * @param {number|null} [opts.maxResults]
 * @param {string[]|null} [opts.pathMatches]
 * @param {number|null} [opts.totalFound]
 */
export function printResults(results, { verbose = false, maxResults = null,
                                        pathMatches = null, totalFound = null,
                                        pathFilter = null } = {}) {
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

    // Build file header
    let hitLabel = '';
    if (nHits > 1) {
      if (funcNames.size > 0 && allSameFunc) {
        hitLabel = `(${nHits} hits, all in ${[...funcNames][0]}):`;
      } else {
        hitLabel = `(${nHits} hits):`;
      }
    } else {
      if (funcNames.size > 0 && allSameFunc) {
        hitLabel = `(in ${[...funcNames][0]}):`;
      }
    }

    console.log('\u2500'.repeat(60));
    console.log(`  ${filepath}  ${hitLabel}`);

    let prevFunc = null;
    for (const r of fileResults) {
      // Show function name only when it changes
      let funcTag = '';
      if (!allSameFunc && r.functionName && r.functionName !== prevFunc) {
        funcTag = `  [${r.functionName}]`;
        prevFunc = r.functionName;
      }

      // Show match type only when it's not literal
      let typeTag = '';
      if (!allLiteral) {
        if (r.matchType === 'semantic' && r.score > 0) {
          typeTag = `  (semantic, score=${r.score.toFixed(3)})`;
        } else if (r.matchType !== 'literal') {
          typeTag = `  (${r.matchType})`;
        }
      }

      console.log(`    L${r.lineNumber}  ${r.lineText.trim()}${funcTag}${typeTag}`);

      if (verbose) {
        console.log(`\n    Context:`);
        for (const ctxLine of r.context.split('\n')) {
          console.log(`      ${ctxLine}`);
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
  if (!args.include_path && !args.exclude_path && !args.vocab_in) return results;

  return results.filter(r => {
    const pathLower = r.filePath.toLowerCase();

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
  let results = index.searchHybrid(args.search, {
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
  });
}

export function doLiteral(index, args) {
  let pathMatches = index.findPathMatches(args.literal);
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    pathMatches = pathMatches.filter(p => p.toLowerCase().includes(pat));
  }
  let results = index.searchLiteral(args.literal, {
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
  });
}

export function doFast(index, args) {
  let pathMatches = index.findPathMatches(args.fast);
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    pathMatches = pathMatches.filter(p => p.toLowerCase().includes(pat));
  }
  let results = index.searchInverted(args.fast, {
    maxResults: args.max_results * 5,
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
  });
}

export function doRegex(index, args) {
  let pattern = args.regex;
  // Strip /.../ delimiters if present
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
    pattern = pattern.slice(1, -1);
  }
  const effectiveMax = args.max_results !== 20 ? args.max_results : 200;
  let results = index.searchLiteral(pattern, {
    useRegex: true,
    maxResults: Math.max(effectiveMax * 5, 1000),
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

  const n = args.max_results || 30;
  const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]);

  for (const [filepath, count] of sorted.slice(0, n)) {
    let fpDisplay = filepath;
    if (!args.full_path && fpDisplay.length > 70) {
      fpDisplay = '...' + fpDisplay.slice(-67);
    }
    console.log(`  ${String(count).padStart(6)}  ${fpDisplay}`);
  }

  if (sorted.length > n) {
    console.log(`\n  ... ${sorted.length - n} more files (use --max-results to see more)`);
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

  const n = args.max_results || 30;
  const sorted = [...folderCounts.entries()].sort((a, b) => b[1] - a[1]);

  for (const [folder, count] of sorted.slice(0, n)) {
    const nfiles = folderFiles.get(folder).size;
    let fpDisplay = folder;
    if (!args.full_path && fpDisplay.length > 60) {
      fpDisplay = '...' + fpDisplay.slice(-57);
    }
    console.log(`  ${String(count).padStart(6)}  ${String(nfiles).padStart(6)}  ${fpDisplay}`);
  }

  if (sorted.length > n) {
    console.log(`\n  ... ${sorted.length - n} more folders (use --max-results to see more)`);
  }
}
