/**
 * multisect.js - Multi-term intersection search ("scavenger hunt").
 * Port of ce_multisect.py.
 *
 * Users provide semicolon-separated search terms; tool finds the smallest
 * code location (function -> file -> folder) containing all terms.
 *
 * Features:
 *   - Three scope levels: function, file, folder
 *   - Regex terms: /pattern/ syntax
 *   - NOT terms: "NOT term" or "!term" - scope must NOT contain them
 *   - Dot-wildcard: "real.time" matches real-time, real_time, realtime
 *   - min_terms for partial matching
 *   - IDF scoring for ranking within same term-count tier
 *   - Selectivity report
 *   - Scope dedup (file suppressed when function already covers it)
 */

import path from 'path';

// ========================================================================
// Term parser
// ========================================================================

/**
 * Parse semicolon-separated search terms.
 *
 * Terms in /.../ are regex; others are literal (case-insensitive).
 * Use ;; for a literal semicolon.
 * Prefix with NOT or ! to negate.
 * Dots in plain terms become .? (match any char or nothing).
 *
 * @param {string} termsStr
 * @returns {Array<{display: string, regex: RegExp, negated: boolean}>|null}
 */
export function parseMultisectTerms(termsStr) {
  const PLACEHOLDER = '\x00SEMI\x00';
  const protected_ = termsStr.replace(/;;/g, PLACEHOLDER);

  const terms = [];
  for (let raw of protected_.split(';')) {
    raw = raw.replace(new RegExp(PLACEHOLDER.replace(/\x00/g, '\\x00'), 'g'), ';').trim();
    if (!raw) continue;

    let negated = false;
    if (raw.startsWith('NOT ')) {
      negated = true;
      raw = raw.slice(4).trim();
    } else if (raw.startsWith('!')) {
      negated = true;
      raw = raw.slice(1).trim();
    }
    if (!raw) continue;

    if (raw.startsWith('/') && raw.endsWith('/') && raw.length > 2) {
      // Regex term
      const pattern = raw.slice(1, -1);
      try {
        const regex = new RegExp(pattern, 'i');
        const display = negated ? `NOT ${raw}` : raw;
        terms.push({ display, regex, negated });
      } catch (e) {
        console.log(`Invalid regex in term '${raw}': ${e.message}`);
        return null;
      }
    } else if (raw.includes('.')) {
      // Dot-wildcard: dots become .? (optional any-char)
      try {
        const pattern = raw.replace(/\./g, '.?');
        const regex = new RegExp(pattern, 'i');
        const displayRaw = `/${pattern}/`;
        const display = negated ? `NOT ${displayRaw}` : displayRaw;
        terms.push({ display, regex, negated });
      } catch (e) {
        // Fallback to literal
        const regex = new RegExp(escapeRegex(raw), 'i');
        const display = negated ? `NOT ${raw}` : raw;
        terms.push({ display, regex, negated });
      }
    } else {
      // Plain literal (case-insensitive)
      const regex = new RegExp(escapeRegex(raw), 'i');
      const display = negated ? `NOT ${raw}` : raw;
      terms.push({ display, regex, negated });
    }
  }
  return terms;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shortPath(fp, maxLen = 50, highlight = null) {
  if (fp.length <= maxLen) return fp;
  const defaultTrunc = '...' + fp.slice(-(maxLen - 3));
  if (highlight) {
    const hl = highlight.toLowerCase();
    // If the default truncation already contains the highlight term, use it
    if (defaultTrunc.toLowerCase().includes(hl)) return defaultTrunc;
    // Otherwise, build a truncation that shows the highlight term
    const fpL = fp.toLowerCase();
    const idx = fpL.indexOf(hl);
    if (idx >= 0) {
      const lastSep = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
      const filename = lastSep >= 0 ? fp.slice(lastSep) : '/' + fp;
      const hlEnd = idx + highlight.length;
      // Show some context around the highlight, then skip to filename
      const ctxStart = Math.max(0, idx - 5);
      const ctxEnd = Math.min(fp.length, hlEnd + 8);
      const prefix = fp.slice(ctxStart, ctxEnd);
      const result = '...' + prefix + '...' + filename;
      return result;
    }
  }
  return defaultTrunc;
}


// ========================================================================
// IDF scoring
// ========================================================================

function computeIdfScores(results, totalFiles) {
  const idfs = [];
  const notSet = new Set(results.not_indices);
  for (let i = 0; i < results.num_terms; i++) {
    if (notSet.has(i) || results.term_file_counts[i] === 0 || totalFiles === 0) {
      idfs.push(0);
    } else {
      idfs.push(Math.log(totalFiles / results.term_file_counts[i]));
    }
  }
  return idfs;
}

function matchIdfScore(match, idfs) {
  let s = 0;
  for (const i of match.matched_indices) s += idfs[i] || 0;
  return s;
}


// ========================================================================
// Per-scope view preparation (shared by CLI display and JSON API)
// ========================================================================

/**
 * Prepare per-scope match arrays from a multisectSearch result, applying
 * IDF reranking, scope dedup ("class covered by function", "file covered
 * by function/class", "folder covered by single-file"), and per-scope caps.
 *
 * @param {Object} results - return value of CodeSearchIndex.multisectSearch
 * @param {Object} opts
 * @param {number} opts.totalFiles - for IDF; pass index.files.size
 * @param {number} opts.maxPerScope - cap per scope (default 25)
 * @param {boolean} opts.verbose - if true, skip dedup
 * @returns {Object} per-scope arrays (JSON-serializable) + counts
 */
export function prepareMultisectViews(results, opts = {}) {
  const { totalFiles = 0, maxPerScope = 25, verbose = false } = opts;
  const idfs = totalFiles > 0 ? computeIdfScores(results, totalFiles) : null;
  const scoreOf = (m) => idfs ? matchIdfScore(m, idfs) : 0;

  const realFunc = (results.function_matches || []).filter(m => m.function !== '(global)');
  const classes = results.class_matches || [];
  const files = results.file_matches || [];
  const folders = results.folder_matches || [];

  // Build a per-file list of function-coverage sets for fast lookup
  const funcCoverage = {};
  for (const m of realFunc) {
    if (!funcCoverage[m.filepath]) funcCoverage[m.filepath] = [];
    funcCoverage[m.filepath].push(m.matched_indices);
  }

  const classCoveredByFunction = (cm) => {
    for (const m of realFunc) {
      if (m.function.startsWith(cm.class_name + '::') || m.function.startsWith(cm.class_name + '.')) {
        if ([...cm.matched_indices].every(i => m.matched_indices.has(i))) return true;
      }
    }
    return false;
  };
  const fileCoveredByFunction = (fm) => {
    const sets = funcCoverage[fm.filepath] || [];
    for (const fs of sets) {
      if ([...fm.matched_indices].every(i => fs.has(i))) return true;
    }
    return false;
  };
  const fileCoveredByClass = (fm) => {
    for (const cm of classes) {
      if (!cm.files.includes(fm.filepath)) continue;
      if ([...fm.matched_indices].every(i => cm.matched_indices.has(i))) return true;
    }
    return false;
  };
  const folderCoveredBySingleFile = (fm) => {
    const posIndices = [...fm.matched_indices];
    const fileSets = fm.file_sets || {};
    const allFiles = new Set();
    for (const ti of posIndices) {
      for (const f of (fileSets[ti] || [])) allFiles.add(f);
    }
    for (const f of allFiles) {
      const termsInFile = posIndices.filter(ti => (fileSets[ti] || new Set()).has(f));
      if (termsInFile.length === posIndices.length) return true;
    }
    return false;
  };

  const classDedup = verbose ? classes : classes.filter(m => !classCoveredByFunction(m));
  const fileDedup = verbose ? files : files.filter(m => !fileCoveredByFunction(m) && !fileCoveredByClass(m));
  const folderDedup = verbose ? folders : folders.filter(m => !folderCoveredBySingleFile(m));

  const sortByScore = (arr, nameKey) => [...arr].sort((a, b) =>
    b.terms_matched - a.terms_matched ||
    scoreOf(b) - scoreOf(a) ||
    (a[nameKey] || '').localeCompare(b[nameKey] || ''));

  const funcSorted = sortByScore(realFunc, 'function');
  const classSorted = sortByScore(classDedup, 'class_name');
  const fileSorted = sortByScore(fileDedup, 'filepath');
  const folderSorted = sortByScore(folderDedup, 'folder');

  // Convert each entry to a JSON-safe shape with idf_score attached
  const toFunc = (m) => ({
    filepath: m.filepath,
    function: m.function,
    terms_matched: m.terms_matched,
    lines: m.lines || 0,
    matched_indices: [...m.matched_indices].sort((a, b) => a - b),
    idf_score: scoreOf(m),
    details: m.details,
  });
  const toClass = (m) => ({
    class_name: m.class_name,
    files: m.files,
    functions: m.functions,
    terms_matched: m.terms_matched,
    total_lines: m.total_lines || 0,
    matched_indices: [...m.matched_indices].sort((a, b) => a - b),
    idf_score: scoreOf(m),
    details: m.details,
  });
  const toFile = (m) => ({
    filepath: m.filepath,
    terms_matched: m.terms_matched,
    lines: m.lines || 0,
    matched_indices: [...m.matched_indices].sort((a, b) => a - b),
    idf_score: scoreOf(m),
    details: m.details,
  });
  const toFolder = (m) => ({
    folder: m.folder,
    terms_matched: m.terms_matched,
    files_involved: m.files_involved,
    matched_indices: [...m.matched_indices].sort((a, b) => a - b),
    idf_score: scoreOf(m),
    file_sets: Object.fromEntries(
      Object.entries(m.file_sets || {}).map(([ti, set]) => [ti, [...set].sort()])
    ),
  });

  return {
    function_matches: funcSorted.slice(0, maxPerScope).map(toFunc),
    class_matches: classSorted.slice(0, maxPerScope).map(toClass),
    file_matches: fileSorted.slice(0, maxPerScope).map(toFile),
    folder_matches: folderSorted.slice(0, maxPerScope).map(toFolder),
    function_total: realFunc.length,
    class_total: classes.length,
    file_total: files.length,
    folder_total: folders.length,
    class_suppressed: classes.length - classDedup.length,
    file_suppressed: files.length - fileDedup.length,
    folder_suppressed: folders.length - folderDedup.length,
  };
}


// ========================================================================
// Display
// ========================================================================

export function printSelectivityReport(results, totalFiles) {
  const terms = results.terms;
  const notSet = new Set(results.not_indices);
  const counts = results.term_file_counts;
  const maxLen = Math.max(...terms.map(t => t.display.length));

  console.log('Term selectivity:');
  for (let i = 0; i < terms.length; i++) {
    const d = terms[i].display.padEnd(maxLen);
    const fc = counts[i];
    if (notSet.has(i)) {
      console.log(`  [${i + 1}] ${d}  ${String(fc).padStart(5)} files  (NOT term)`);
    } else if (totalFiles > 0) {
      const pct = 100 * fc / totalFiles;
      let rating;
      if (fc === 0) rating = 'ZERO HITS -- term absent from index';
      else if (pct < 10) rating = 'HIGH discrimination';
      else if (pct < 30) rating = 'moderate';
      else if (pct < 60) rating = 'low';
      else rating = 'VERY LOW -- consider dropping';
      console.log(`  [${i + 1}] ${d}  ${String(fc).padStart(5)} files (${pct.toFixed(0).padStart(3)}%) -- ${rating}`);
    } else {
      console.log(`  [${i + 1}] ${d}  ${String(fc).padStart(5)} files`);
    }
  }
  console.log();
}


export function displayMultisectResults(results, args, totalFiles) {
  const terms = results.terms;
  const n = results.num_terms;
  const nPos = results.num_positive;
  const notSet = new Set(results.not_indices);
  const minT = results.min_terms;
  const maxPerScope = args.max_results || 10;
  const fullPath = args.full_path || false;
  const verbose = args.verbose || false;
  const pathHighlight = args.vocab_in || (args.include_path && args.include_path[0]) || null;

  // IDF scoring
  let idfs = null;
  if (totalFiles > 0) {
    idfs = computeIdfScores(results, totalFiles);
  }

  // Header
  const posLabel = `${nPos} positive term${nPos !== 1 ? 's' : ''}`;
  const notLabel = results.not_indices.length
    ? `, ${results.not_indices.length} NOT term${results.not_indices.length !== 1 ? 's' : ''}`
    : '';
  let label = `Multi-term intersection search: ${posLabel}${notLabel}`;
  if (minT < nPos) label += ` (minimum ${minT} required)`;
  console.log(`\n${label}`);

  const maxDispLen = Math.max(...terms.map(t => t.display.length));
  for (let i = 0; i < terms.length; i++) {
    const fc = results.term_file_counts[i];
    let note;
    if (notSet.has(i)) {
      note = fc ? `${fc} files (NOT -- must be absent)` : '0 files (NOT -- already absent)';
    } else {
      note = fc ? `${fc} files` : '** 0 files -- no matches **';
    }
    console.log(`  [${i + 1}] ${terms[i].display.padEnd(maxDispLen)}  (${note})`);
  }
  console.log();

  let funcMatches = results.function_matches;
  let classMatches = results.class_matches || [];
  let fileMatches = results.file_matches;
  let folderMatches = results.folder_matches;

  // IDF re-sort
  if (idfs) {
    funcMatches = [...funcMatches].sort((a, b) =>
      b.terms_matched - a.terms_matched ||
      matchIdfScore(b, idfs) - matchIdfScore(a, idfs) ||
      a.function.localeCompare(b.function));
    classMatches = [...classMatches].sort((a, b) =>
      b.terms_matched - a.terms_matched ||
      matchIdfScore(b, idfs) - matchIdfScore(a, idfs) ||
      a.class_name.localeCompare(b.class_name));
    fileMatches = [...fileMatches].sort((a, b) =>
      b.terms_matched - a.terms_matched ||
      matchIdfScore(b, idfs) - matchIdfScore(a, idfs) ||
      a.filepath.localeCompare(b.filepath));
    folderMatches = [...folderMatches].sort((a, b) =>
      b.terms_matched - a.terms_matched ||
      matchIdfScore(b, idfs) - matchIdfScore(a, idfs) ||
      a.files_involved - b.files_involved);
  }

  // Scope dedup: track which file+term combos are covered by function-level
  // Exclude (global) - it's not a real scope and shouldn't suppress file-level
  const funcCoverage = {};
  for (const m of funcMatches) {
    if (m.function === '(global)') continue;
    if (!funcCoverage[m.filepath]) funcCoverage[m.filepath] = [];
    funcCoverage[m.filepath].push(m.matched_indices);
  }

  function fileCoveredByFunction(fm) {
    const sets = funcCoverage[fm.filepath] || [];
    for (const funcSet of sets) {
      if ([...fm.matched_indices].every(i => funcSet.has(i))) return true;
    }
    return false;
  }

  // Class dedup: suppress class if a single function already covers all terms
  function classCoveredByFunction(cm) {
    // A class match is "covered" if some function-level match in the same class
    // already matches all the same terms the class matched
    for (const m of funcMatches) {
      if (m.function === '(global)') continue;
      // Check if this function belongs to this class
      if (m.function.startsWith(cm.class_name + '::') || m.function.startsWith(cm.class_name + '.')) {
        if ([...cm.matched_indices].every(i => m.matched_indices.has(i))) return true;
      }
    }
    return false;
  }

  // Filter out (global) from function-level display - those are really file-level hits
  const realFuncMatches = funcMatches.filter(m => m.function !== '(global)');

  let anyResults = false;

  // --- Function matches ---
  if (realFuncMatches.length > 0) {
    anyResults = true;
    console.log(`=== FUNCTION-level matches (${realFuncMatches.length} functions) ===`);
    const shown = realFuncMatches.slice(0, maxPerScope);
    for (let idx = 0; idx < shown.length; idx++) {
      const m = shown[idx];
      const fp = fullPath ? m.filepath : shortPath(m.filepath, 50, pathHighlight);
      const score = idfs ? ` IDF:${matchIdfScore(m, idfs).toFixed(1)}` : '';
      console.log(`\n  [${idx + 1}] ${m.function}  (${fp}, ${m.lines} lines)  [${m.terms_matched}/${nPos}]${score}`);

      // Show per-term detail, collapsing terms that hit the same line
      const lineGroups = new Map(); // lineNum -> { indices: [], text: '' }
      const missingIndices = [];
      for (let ti = 0; ti < terms.length; ti++) {
        if (notSet.has(ti)) continue;
        const detail = m.details[ti];
        if (detail) {
          const key = detail.line_num;
          if (!lineGroups.has(key)) {
            lineGroups.set(key, { indices: [], text: detail.line_text });
          }
          lineGroups.get(key).indices.push(ti + 1);
        } else {
          missingIndices.push(ti + 1);
        }
      }
      // Sort by line number and display
      const sortedLines = [...lineGroups.entries()].sort((a, b) => a[0] - b[0]);
      for (const [lineNum, { indices, text }] of sortedLines) {
        const lineText = text.length > 80 ? text.slice(0, 77) + '...' : text;
        const tag = indices.length > 1 ? `[${indices.join(',')}]` : `[${indices[0]}]`;
        console.log(`      ${tag} L${lineNum}  ${lineText}`);
      }
      for (const ti of missingIndices) {
        console.log(`      [${ti}] -- not found --`);
      }
    }
    if (realFuncMatches.length > maxPerScope) {
      console.log(`  ... +${realFuncMatches.length - maxPerScope} more`);
    }
    console.log();
  }

  // --- Class matches ---
  const filteredClasses = verbose ? classMatches : classMatches.filter(m => !classCoveredByFunction(m));
  if (filteredClasses.length > 0) {
    anyResults = true;
    const dedupNote = !verbose && filteredClasses.length < classMatches.length
      ? ` (${classMatches.length - filteredClasses.length} suppressed - covered by function matches)`
      : '';
    console.log(`=== CLASS-level matches (${filteredClasses.length} classes${dedupNote}) ===`);
    const shown = filteredClasses.slice(0, maxPerScope);
    for (let idx = 0; idx < shown.length; idx++) {
      const m = shown[idx];
      const filesStr = m.files.length === 1
        ? (fullPath ? m.files[0] : shortPath(m.files[0], 50, pathHighlight))
        : `${m.files.length} files`;
      const score = idfs ? ` IDF:${matchIdfScore(m, idfs).toFixed(1)}` : '';
      console.log(`\n  [${idx + 1}] ${m.class_name}  (${filesStr}, ${m.functions.length} methods, ${m.total_lines} lines)  [${m.terms_matched}/${nPos}]${score}`);

      // Show per-term detail with function name and file
      const lineGroups = new Map();
      const missingIndices = [];
      for (let ti = 0; ti < terms.length; ti++) {
        if (notSet.has(ti)) continue;
        const detail = m.details[ti];
        if (detail) {
          const key = `${detail.filepath}:${detail.line_num}`;
          if (!lineGroups.has(key)) {
            lineGroups.set(key, { indices: [], text: detail.line_text, func_name: detail.func_name, filepath: detail.filepath, line_num: detail.line_num });
          }
          lineGroups.get(key).indices.push(ti + 1);
        } else {
          missingIndices.push(ti + 1);
        }
      }
      const sortedLines = [...lineGroups.values()].sort((a, b) => a.line_num - b.line_num);
      for (const { indices, text, func_name, filepath, line_num } of sortedLines) {
        const lineText = text.length > 70 ? text.slice(0, 67) + '...' : text;
        const tag = indices.length > 1 ? `[${indices.join(',')}]` : `[${indices[0]}]`;
        // Show the method name (strip class prefix for brevity)
        const methodName = func_name ? (func_name.includes('::') ? func_name.split('::').pop() : func_name.split('.').pop()) : '';
        const loc = m.files.length > 1 ? ` (${shortPath(filepath, 30, pathHighlight)})` : '';
        console.log(`      ${tag} L${line_num} ${methodName}()${loc}  ${lineText}`);
      }
      for (const ti of missingIndices) {
        console.log(`      [${ti}] -- not found --`);
      }

      // In verbose mode, list all methods
      if (verbose && m.functions.length > 0) {
        console.log(`      Methods: ${m.functions.map(f => f.includes('::') ? f.split('::').pop() : f.split('.').pop()).join(', ')}`);
        if (m.files.length > 1) {
          console.log(`      Files: ${m.files.join(', ')}`);
        }
      }
    }
    if (filteredClasses.length > maxPerScope) {
      console.log(`  ... +${filteredClasses.length - maxPerScope} more`);
    }
    console.log();
  }

  // --- File matches ---
  // Suppress files covered by function or class matches
  function fileCoveredByClassOrFunction(fm) {
    if (fileCoveredByFunction(fm)) return true;
    // Check if any class match covers all the file's matched terms
    for (const cm of classMatches) {
      if (!cm.files.includes(fm.filepath)) continue;
      if ([...fm.matched_indices].every(i => cm.matched_indices.has(i))) return true;
    }
    return false;
  }
  const filteredFiles = verbose ? fileMatches : fileMatches.filter(m => !fileCoveredByClassOrFunction(m));
  if (filteredFiles.length > 0) {
    anyResults = true;
    const dedupNote = !verbose && filteredFiles.length < fileMatches.length
      ? ` (${fileMatches.length - filteredFiles.length} suppressed - covered by function or class matches)`
      : '';
    console.log(`=== FILE-level matches (${filteredFiles.length} files${dedupNote}) ===`);
    const shown = filteredFiles.slice(0, maxPerScope);
    for (let idx = 0; idx < shown.length; idx++) {
      const m = shown[idx];
      const fp = fullPath ? m.filepath : shortPath(m.filepath, 60, pathHighlight);
      const score = idfs ? ` IDF:${matchIdfScore(m, idfs).toFixed(1)}` : '';
      console.log(`\n  [${idx + 1}] ${fp}  (${m.lines} lines)  [${m.terms_matched}/${nPos}]${score}`);

      const lineGroups = new Map();
      const missingIndices = [];
      for (let ti = 0; ti < terms.length; ti++) {
        if (notSet.has(ti)) continue;
        const detail = m.details[ti];
        if (detail) {
          const key = detail.line_num;
          if (!lineGroups.has(key)) {
            lineGroups.set(key, { indices: [], text: detail.line_text, func_name: detail.func_name });
          }
          lineGroups.get(key).indices.push(ti + 1);
        } else {
          missingIndices.push(ti + 1);
        }
      }
      const sortedLines = [...lineGroups.entries()].sort((a, b) => a[0] - b[0]);
      for (const [lineNum, { indices, text, func_name }] of sortedLines) {
        const tag = indices.length > 1 ? `[${indices.join(',')}]` : `[${indices[0]}]`;
        if (lineNum === 0) {
          // Path-only match
          console.log(`      ${tag} (path)  matched in filepath`);
        } else {
          const lineText = text.length > 80 ? text.slice(0, 77) + '...' : text;
          const fn = func_name ? ` in ${func_name}` : '';
          console.log(`      ${tag} L${lineNum}${fn}  ${lineText}`);
        }
      }
      for (const ti of missingIndices) {
        console.log(`      [${ti}] -- not found --`);
      }
    }
    if (filteredFiles.length > maxPerScope) {
      console.log(`  ... +${filteredFiles.length - maxPerScope} more`);
    }
    console.log();
  }

  // --- Folder matches ---
  // Scope dedup: suppress folders where a single file already covers all matched terms
  function folderCoveredBySingleFile(fm) {
    const posIndices = [...fm.matched_indices];
    const fileSets = fm.file_sets || {};
    // Collect all files involved
    const allFiles = new Set();
    for (const ti of posIndices) {
      for (const f of (fileSets[ti] || [])) allFiles.add(f);
    }
    // Check if any single file has all terms
    for (const f of allFiles) {
      const termsInFile = posIndices.filter(ti => (fileSets[ti] || new Set()).has(f));
      if (termsInFile.length === posIndices.length) return true;
    }
    return false;
  }

  const displayFolders = verbose
    ? folderMatches
    : folderMatches.filter(m => !folderCoveredBySingleFile(m));
  const folderSuppressed = folderMatches.length - displayFolders.length;

  if (displayFolders.length > 0) {
    anyResults = true;
    const suppressNote = folderSuppressed > 0
      ? ` (${folderSuppressed} suppressed - covered by single-file matches)`
      : '';
    console.log(`=== FOLDER-level matches (${displayFolders.length} folders${suppressNote}) ===`);
    const shown = displayFolders.slice(0, maxPerScope);
    for (let idx = 0; idx < shown.length; idx++) {
      const m = shown[idx];
      const score = idfs ? ` IDF:${matchIdfScore(m, idfs).toFixed(1)}` : '';
      const missing = [];
      for (let ti = 0; ti < terms.length; ti++) {
        if (notSet.has(ti)) continue;
        if (!m.matched_indices.has(ti)) missing.push(terms[ti].display);
      }
      const missStr = missing.length > 0 ? `  missing: ${missing.join(', ')}` : '';
      console.log(`\n  [${idx + 1}] ${m.folder}/  [${m.terms_matched}/${nPos} terms, ` +
        `${m.files_involved} file${m.files_involved !== 1 ? 's' : ''}]${score}${missStr}`);

      // Per-term file detail
      const fileSets = m.file_sets || {};
      for (let ti = 0; ti < terms.length; ti++) {
        const d = terms[ti].display;
        if (notSet.has(ti)) {
          console.log(`      [${ti + 1}] ${d}  OK absent (NOT term)`);
        } else if (fileSets[ti] && fileSets[ti].size > 0) {
          const files = [...fileSets[ti]].sort();
          const basenames = files.slice(0, 5).map(f => {
            const sep = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\'));
            return sep >= 0 ? f.slice(sep + 1) : f;
          });
          const more = files.length > 5 ? ` +${files.length - 5} more` : '';
          console.log(`      [${ti + 1}] ${d}  in ${basenames.join(', ')}${more}`);
        } else {
          console.log(`      [${ti + 1}] ${d}  *** NOT FOUND ***`);
        }
      }
    }
    if (displayFolders.length > maxPerScope) {
      console.log(`  ... +${displayFolders.length - maxPerScope} more`);
    }
    console.log();
  } else if (folderSuppressed > 0 && !verbose) {
    anyResults = true;
    console.log(`=== FOLDER-level: all ${folderSuppressed} folder match${folderSuppressed !== 1 ? 'es' : ''} ` +
      `already covered by single-file results (use verbose to show) ===`);
    console.log();
  }

  if (!anyResults) {
    console.log('  No matches found at any scope level.');
    if (results.term_file_counts.some((c, i) => c === 0 && !notSet.has(i))) {
      console.log('  Some terms had zero hits - try broader terms or use min= for partial matching.');
    }
    console.log();
  }
}


// ========================================================================
// Entry point
// ========================================================================

export function doMultisect(index, args) {
  const termsStr = args.multisect_search;
  if (!termsStr) {
    console.log('Usage: /multisect term1;term2;term3 [min=N]');
    return;
  }

  const terms = parseMultisectTerms(termsStr);
  if (!terms || terms.length === 0) {
    console.log('No valid terms parsed. Separate terms with semicolons.');
    return;
  }

  const minTerms = args.min_terms ? parseInt(args.min_terms) : 0;
  const includePath = args.vocab_in ? [args.vocab_in] :
    args.include_path ? args.include_path : null;
  const excludePath = args.exclude_path || null;

  const results = index.multisectSearch(terms, {
    minTerms: minTerms || null,
    includePath,
    excludePath,
    showProgress: true,
  });

  if (!results) return;

  const totalFiles = index.files.size;

  // Show path filter if active
  if (includePath && includePath.length > 0) {
    console.log(`  Path filter: --in ${includePath.join(', ')}`);
  }

  // Show selectivity report
  printSelectivityReport(results, totalFiles);

  // Show results
  displayMultisectResults(results, args, totalFiles);
}
