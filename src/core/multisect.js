// multisect.js — two-phase multi-term intersection search, with per-term file counts and comment-vs-code match weighting
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * multisect.js — Multi-term intersection search ("scavenger hunt" / #146).
 * Pulled out of CodeSearchIndex.js in Issue #18 Phase 2 (theme #25).
 *
 * Two exports, both taking idx as first arg:
 *
 *   computeTermFileCounts(idx, terms, opts)  — cheap per-term file-coverage scan,
 *     used by the LLM claim-search selectivity filter to drop low-discrimination
 *     terms before running the real multisect.
 *
 *   multisectSearch(idx, terms, opts)        — full two-phase intersection search.
 *     Phase 1: file-level scan for file-sets per term (fast).
 *     Phase 2: detail retrieval for survivor files only (line numbers, line text,
 *              containing function via bisect, scope hierarchy function -> file -> folder).
 *
 * Internal references that became idx.X: _ensureFunctionIndex, fileLines,
 * functionIndex, _getFuncBoundaries, getDisplayName, applyRenames,
 * _renderLinesWithRenames.
 */

import { isPseudoSource } from '../binstrings.js';

// ========================================================================
// Match-line hygiene (chart-term-hygiene-and-rarity-scoring)
// ========================================================================

// A term "matched" on a comment or annotation line is weaker evidence than
// one matched in code: javadoc prose and @annotations let big functions
// harvest [n/k] counts by surface area (the '101 forensics: AmrExtractor's
// doc-text matches outranked AdaptiveTrackSelection's in-code ones). A
// comment-only match counts at this weight in weighted_terms and in the
// command layer's IDF score; a term matched on BOTH kinds of line counts as
// code. Chosen once, stated here; NOT a per-case tunable, no CLI option.
export const COMMENT_MATCH_WEIGHT = 0.25;

/**
 * Classify one matched line as 'code' or 'comment', deterministically, from
 * the line text multisect already records. Comment shapes observed in the
 * '101 forensics: javadoc continuation (`* ...`), `//`, `/*`, `#`, and
 * annotation-only lines (`@Target(TYPE_USE)`). C preprocessor directives
 * are code, not comments. Synthetic details (`[name match: ...]`,
 * `[path match: ...]`) are name evidence, not prose: code.
 */
export function classifyMatchLine(text) {
  const t = String(text || '').trim();
  if (!t) return 'code';
  if (t.startsWith('[name match:') || t.startsWith('[path match:')) return 'code';
  if (/^#\s*(include|define|ifn?def|if\b|endif|pragma|undef|else|elif)/.test(t)) return 'code';
  if (/^(\/\/|\/\*|\*|#)/.test(t)) return 'comment';
  if (/^@\w+(\([^)]*\))?[;,]?$/.test(t)) return 'comment';
  return 'code';
}

/** Weighted matched-term count: code matches count 1, comment-only 0.25. */
function weightedTermCount(details, posMatched) {
  let w = 0;
  for (const ti of posMatched) {
    const d = details[ti];
    w += d && d.is_code === false ? COMMENT_MATCH_WEIGHT : 1;
  }
  return w;
}

/** Matched positive indices whose recorded hit is a code line. */
function codeMatchedIndices(details, posMatched) {
  return [...posMatched].filter(ti => details[ti] && details[ti].is_code !== false).sort((a, b) => a - b);
}

// ========================================================================
// Multi-term intersection search (#146 "scavenger hunt")
// ========================================================================

/**
 * Multi-term intersection search.
 *
 * Two-phase approach:
 *   Phase 1: Scan file lines to collect file sets per term (fast).
 *   Phase 2: Detail retrieval for survivor files only - line numbers,
 *            line text, containing function via bisect.
 *
 * Finds the smallest scope (function -> file -> folder) containing
 * multiple terms simultaneously.
 *
 * @param {Array<{display, regex, negated}>} terms
 * @param {Object} opts
 * @param {number|null} opts.minTerms - minimum positive terms required
 * @param {string[]|null} opts.includePath
 * @param {string[]|null} opts.excludePath
 * @param {boolean} opts.showProgress
 * @returns {Object|null} results with function_matches, file_matches, folder_matches
 */
/**
 * Cheap per-term file-coverage scan. Returns the same `term_file_counts`
 * shape that `multisectSearch` produces in Phase 1, but skips Phase 1b
 * (class candidates), Phase 2 (function-level detail), and NOT scanning.
 * Used by the LLM claim-search selectivity filter to identify and drop
 * low-discrimination terms before running the real multisect.
 *
 * @param {Array<{regex, negated}>} terms
 * @param {Object} opts
 * @returns {{term_file_counts: number[], total_files: number}}
 */
export function computeTermFileCounts(idx, terms, opts = {}) {
  const { includePath, excludePath } = opts;
  idx._ensureFunctionIndex();
  const nTerms = terms.length;
  const termFileSets = new Array(nTerms).fill(null).map(() => new Set());

  const pathOk = (fp) => {
    const fpL = fp.toLowerCase();
    if (includePath && !includePath.some(p => fpL.includes(p.toLowerCase()))) return false;
    if (excludePath && excludePath.some(p => fpL.includes(p.toLowerCase()))) return false;
    return true;
  };

  for (const [filepath, lines] of idx.fileLines) {
    if (!pathOk(filepath)) continue;
    for (let ti = 0; ti < nTerms; ti++) {
      if (termFileSets[ti].has(filepath)) continue;
      const regex = terms[ti].regex;
      let found = false;
      for (const line of lines) {
        if (regex.test(line)) { found = true; break; }
      }
      if (found) {
        termFileSets[ti].add(filepath);
      } else {
        regex.lastIndex = 0;
        if (regex.test(filepath)) termFileSets[ti].add(filepath);
      }
    }
  }

  const counts = new Array(nTerms);
  for (let ti = 0; ti < nTerms; ti++) counts[ti] = termFileSets[ti].size;
  return { term_file_counts: counts, total_files: idx.fileLines.size };
}

export function multisectSearch(idx, terms, opts = {}) {
  const {
    minTerms: minTermsArg, includePath, excludePath,
    showProgress = true, matchRenames = false,
  } = opts;

  // Four-way bucketing of term indices by (hard, negated). `hard` defaults
  // to true when the flag is absent (terms from older callers / parser).
  // `positiveIndices` / `notIndices` keep their old all-inclusive meaning
  // for the return shape and existing consumers.
  const positiveIndices = [];
  const notIndices = [];
  const hardPosIndices = [];
  const softPosIndices = [];
  const hardNotIndices = [];
  const softNotIndices = [];
  for (let i = 0; i < terms.length; i++) {
    const isHard = terms[i].hard !== false;
    if (terms[i].negated) {
      notIndices.push(i);
      (isHard ? hardNotIndices : softNotIndices).push(i);
    } else {
      positiveIndices.push(i);
      (isHard ? hardPosIndices : softPosIndices).push(i);
    }
  }
  const nPositive = positiveIndices.length;
  const nTerms = terms.length;
  const hardPosSet = new Set(hardPosIndices);

  // Min Terms gates on hard-required matches only — soft-required terms
  // never disqualify a scope. An all-soft query (no hard positives) gates
  // at 0 so soft-only results still surface, ranked by IDF.
  const nHardPos = hardPosIndices.length;
  let minTerms = minTermsArg ? Math.min(minTermsArg, nHardPos) : nHardPos;
  minTerms = nHardPos > 0 ? Math.max(1, minTerms) : 0;

  idx._ensureFunctionIndex();

  // When matchRenames is set (Option B / Issue #25), pre-render each
  // scanned file via _renderLinesWithRenames so the per-line term regex
  // tests see renamed display names -- e.g. xf's body, raw `ip9()`,
  // becomes `ip9_KW_ENGINEERING_VULNERABILITIES()` and a search for
  // `vulnerabilities` hits xf. The helper chunks the file so it clears
  // applyRenames's 200K-char performance guard, and carries
  // block-comment / template-literal state across chunk boundaries so
  // multi-line strings/comments are not mis-renamed. Line count is
  // preserved so function-boundary line numbers still map. Done once
  // per search call, never persisted -- opt-in cost goes with the
  // opt-in feature.
  const linesByFile = (matchRenames && typeof idx.applyRenames === 'function')
    ? new Map([...idx.fileLines.entries()].map(
        ([fp, raw]) => [fp, idx._renderLinesWithRenames(raw)]))
    : idx.fileLines;
  if (matchRenames && showProgress) {
    process.stderr.write(`  --match-renames: rendered ${linesByFile.size} file(s) via applyRenames\n`);
  }

  // ----------------------------------------------------------------
  // Phase 1: File-set scan
  // ----------------------------------------------------------------
  const phase1Start = Date.now();
  const termFileSets = new Array(nTerms).fill(null).map(() => new Set());
  const termPathOnlySets = new Array(nTerms).fill(null).map(() => new Set());
  const termFileCounts = new Array(nTerms).fill(0);

  // Path filter helper
  const pathOk = (fp) => {
    const fpL = fp.toLowerCase();
    if (includePath && !includePath.some(p => fpL.includes(p.toLowerCase()))) return false;
    if (excludePath && excludePath.some(p => fpL.includes(p.toLowerCase()))) return false;
    return true;
  };

  let fileNum = 0;
  const totalFiles = idx.fileLines.size;

  for (const [filepath, lines] of linesByFile) {
    fileNum++;
    if (showProgress && fileNum % 5000 === 0) {
      process.stderr.write(`  Phase 1: ${fileNum} / ${totalFiles} files...\r`);
    }
    if (!pathOk(filepath)) continue;

    for (let ti = 0; ti < nTerms; ti++) {
      const regex = terms[ti].regex;
      let foundInContent = false;
      for (const line of lines) {
        if (regex.test(line)) {
          termFileSets[ti].add(filepath);
          foundInContent = true;
          break;
        }
      }
      // Also check if term matches in the filepath itself (path/filename)
      if (!foundInContent) {
        regex.lastIndex = 0;  // reset stateful regex
        if (regex.test(filepath)) {
          termFileSets[ti].add(filepath);
          // Mark as path-only match for Phase 2
          termPathOnlySets[ti].add(filepath);
        }
      }
    }
  }

  for (let ti = 0; ti < nTerms; ti++) {
    termFileCounts[ti] = termFileSets[ti].size;
  }

  // Compute file-level survivors
  const filePosTerms = new Map();  // filepath -> Set of positive term indices
  for (const ti of positiveIndices) {
    for (const fp of termFileSets[ti]) {
      if (!filePosTerms.has(fp)) filePosTerms.set(fp, new Set());
      filePosTerms.get(fp).add(ti);
    }
  }

  const notIdxSet = new Set(notIndices);
  const fileSurvivors = new Set();
  for (const [fp, matchedPos] of filePosTerms) {
    // Count only hard-required matches toward the gate; soft-required
    // absence never disqualifies. Only hard-NOT terms exclude the file.
    let hardMatched = 0;
    for (const ti of matchedPos) if (hardPosSet.has(ti)) hardMatched++;
    if (hardMatched >= minTerms) {
      if (!hardNotIndices.some(ni => termFileSets[ni].has(fp))) {
        fileSurvivors.add(fp);
      }
    }
  }

  const phase1Time = Date.now() - phase1Start;
  if (showProgress) {
    process.stderr.write(`  Phase 1: ${fileSurvivors.size} survivor files ` +
      `(from ${filePosTerms.size} candidates) in ${(phase1Time / 1000).toFixed(1)}s\n`);
  }

  // Build folder-level data
  const folderMap = {};  // folder -> { termIdx -> Set of filepaths }
  for (let ti = 0; ti < nTerms; ti++) {
    for (const fp of termFileSets[ti]) {
      const norm = fp.replace(/\\/g, '/');
      const parts = norm.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const folder = parts.slice(0, depth).join('/');
        if (!folderMap[folder]) folderMap[folder] = {};
        if (!folderMap[folder][ti]) folderMap[folder][ti] = new Set();
        folderMap[folder][ti].add(fp);
      }
    }
  }

  // ----------------------------------------------------------------
  // Phase 1b: Identify class-candidate files
  // A class spans multiple functions possibly in multiple files.
  // Compute which classes meet minTerms across their methods' files,
  // then add those files to Phase 2 scanning.
  // ----------------------------------------------------------------
  const classTermSets = new Map();  // className -> { termIdx -> Set of files }
  const classFilesP1 = new Map();   // className -> Set of files

  for (const [fpath, functions] of Object.entries(idx.functionIndex || {})) {
    for (const [fname] of Object.entries(functions)) {
      let className = null;
      if (fname.includes('::')) {
        className = fname.split('::').slice(0, -1).join('::');
      } else if (fname.includes('.')) {
        className = fname.split('.').slice(0, -1).join('.');
      }
      if (!className) continue;

      if (!classFilesP1.has(className)) classFilesP1.set(className, new Set());
      classFilesP1.get(className).add(fpath);

      // Check which terms this file contributes
      for (let ti = 0; ti < nTerms; ti++) {
        if (terms[ti].negated) continue;
        if (termFileSets[ti].has(fpath)) {
          if (!classTermSets.has(className)) classTermSets.set(className, new Map());
          const cts = classTermSets.get(className);
          if (!cts.has(ti)) cts.set(ti, new Set());
          cts.get(ti).add(fpath);
        }
      }
    }
  }

  // Find classes whose combined term coverage meets minTerms
  const classCandidateFiles = new Set();
  for (const [className, cts] of classTermSets) {
    const hardCovered = [...cts.keys()].filter(ti => hardPosSet.has(ti));
    if (hardCovered.length >= minTerms) {
      // Add all files for this class to the Phase 2 scan
      const cf = classFilesP1.get(className);
      if (cf) {
        for (const fp of cf) {
          if (pathOk(fp)) classCandidateFiles.add(fp);
        }
      }
    }
  }

  if (showProgress && classCandidateFiles.size > 0) {
    const extra = [...classCandidateFiles].filter(fp => !fileSurvivors.has(fp)).length;
    if (extra > 0) {
      process.stderr.write(`  Phase 1b: ${extra} additional files from class candidates\n`);
    }
  }

  // ----------------------------------------------------------------
  // Phase 2: Detail retrieval for survivors + class candidate files
  // ----------------------------------------------------------------
  const phase2Start = Date.now();

  // Combine file survivors and class candidate files
  const phase2Files = new Set([...fileSurvivors, ...classCandidateFiles]);

  // Pre-build function boundaries
  const funcBoundariesCache = {};
  for (const fp of phase2Files) {
    funcBoundariesCache[fp] = idx._getFuncBoundaries(fp);
  }

  // funcMap[(filepath, funcName)] -> { termIdx: { line_num, line_text } }
  const funcMap = new Map();
  // fileDetailMap[filepath] -> { termIdx: { line_num, line_text, func_name } }
  const fileDetailMap = new Map();
  // Function-scope NOT semantics: a function is excluded only if a NOT-term
  // appears within its own body (signature line included, since that's inside
  // the boundary range). Necessary because Phase 1b's class-candidate pass
  // can re-inject files containing NOT-terms past the file-level survivor
  // filter — without this, the file-level NOT-filter at file/class/folder
  // levels has no function-level counterpart.
  //   funcHardNotHits: Set of fnKey whose body contains a hard-NOT term
  //                    (these functions are dropped).
  //   funcSoftNotHits: Map fnKey -> Set of soft-NOT term indices found in
  //                    the body (these functions are kept but tagged).
  const funcHardNotHits = new Set();
  const funcSoftNotHits = new Map();

  const sortedSurvivors = [...phase2Files].sort();
  for (let fpIdx = 0; fpIdx < sortedSurvivors.length; fpIdx++) {
    const fp = sortedSurvivors[fpIdx];
    const lines = linesByFile.get(fp);
    if (!lines || lines.length === 0) continue;
    const boundaries = funcBoundariesCache[fp];

    if (showProgress && phase2Files.size > 50 && (fpIdx + 1) % 100 === 0) {
      process.stderr.write(`  Phase 2: ${fpIdx + 1}/${phase2Files.size} files...\r`);
    }

    for (let ti = 0; ti < nTerms; ti++) {
      if (terms[ti].negated) continue;
      if (!termFileSets[ti].has(fp)) continue;

      // Check if this was a path-only match (term not in file content)
      if (termPathOnlySets[ti].has(fp)) {
        // Record as file-level hit with synthetic "path match" detail
        // Do NOT add to function-level (path is not inside any function)
        if (!fileDetailMap.has(fp)) fileDetailMap.set(fp, {});
        const fDetails = fileDetailMap.get(fp);
        if (fDetails[ti] === undefined) {
          fDetails[ti] = { line_num: 0, line_text: `[path match: ${fp}]`, func_name: null, is_code: true };
        }
        continue;
      }

      const regex = terms[ti].regex;
      const seenFuncs = new Set();

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const lineNum = lineIdx + 1;
        const lineText = lines[lineIdx];
        if (!regex.test(lineText)) continue;

        const funcName = idx._bisectFuncLookup(boundaries, lineNum) || '(global)';
        const isCode = classifyMatchLine(lineText) === 'code';

        // File-level: first hit per term, upgraded when a code-line hit
        // follows a comment-only one (matched-in-both counts as code).
        if (!fileDetailMap.has(fp)) fileDetailMap.set(fp, {});
        const fDetails = fileDetailMap.get(fp);
        if (fDetails[ti] === undefined || (fDetails[ti].is_code === false && isCode)) {
          fDetails[ti] = { line_num: lineNum, line_text: lineText.trim(), func_name: funcName, is_code: isCode };
        }

        // Function-level: one hit per function per term, with the same
        // comment->code upgrade. A (term, function) pair closes only once a
        // code-line hit is recorded, so a comment-first match stays open for
        // upgrade without re-recording on every subsequent comment line.
        const fnKey = `${fp}\x00${funcName}`;
        if (!seenFuncs.has(funcName)) {
          if (!funcMap.has(fnKey)) funcMap.set(fnKey, { filepath: fp, function: funcName, details: {} });
          const fm = funcMap.get(fnKey);
          if (fm.details[ti] === undefined || (fm.details[ti].is_code === false && isCode)) {
            fm.details[ti] = { line_num: lineNum, line_text: lineText.trim(), is_code: isCode };
          }
          if (isCode) seenFuncs.add(funcName);
        }
      }

      // Display-name attribution (Issue #24 / Option A from #22): also
      // test this term against each function's inferred display name --
      // not just raw content. Lets a function be attributed by its
      // renamed name (e.g. searching `vulnerabilities` matches
      // `ip9_KW_ENGINEERING_VULNERABILITIES`) without a per-line
      // applyRenames() pass. Scope is deliberately narrow: only the
      // function whose OWN inferred name advertises the term -- renamed
      // callees inside callers' bodies are not covered (Option B would,
      // at higher cost). Files reach this code only if they already
      // survived Phase 1 via a content/path match on some term; a
      // companion Phase-1 pass would be a separate follow-up.
      if (idx.getDisplayName) {
        for (const [s, , fname] of boundaries) {
          if (seenFuncs.has(fname)) continue;
          const dn = idx.getDisplayName(fname);
          if (!dn || dn === fname) continue;
          if (!regex.test(dn)) continue;
          seenFuncs.add(fname);
          const fnKey = `${fp}\x00${fname}`;
          if (!funcMap.has(fnKey)) {
            funcMap.set(fnKey, { filepath: fp, function: fname, details: {} });
          }
          const fmName = funcMap.get(fnKey);
          if (fmName.details[ti] === undefined) {
            fmName.details[ti] = { line_num: s, line_text: `[name match: ${dn}]`, is_code: true };
          }
        }
      }
    }

    // Function-level NOT-term scan within this file's function bodies.
    // (File/class/folder NOT-filters live in their builders below; this
    // is the missing function-level counterpart.) Hard-NOT hits drop the
    // function; soft-NOT hits only tag it.
    for (const ni of notIndices) {
      if (!termFileSets[ni].has(fp)) continue;
      if (termPathOnlySets[ni].has(fp)) continue;
      const isSoft = !hardNotIndices.includes(ni);
      const regex = terms[ni].regex;
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        if (!regex.test(lines[lineIdx])) continue;
        const lineNum = lineIdx + 1;
        const funcName = idx._bisectFuncLookup(boundaries, lineNum) || '(global)';
        const fnKey = `${fp}\x00${funcName}`;
        if (isSoft) {
          if (!funcSoftNotHits.has(fnKey)) funcSoftNotHits.set(fnKey, new Set());
          funcSoftNotHits.get(fnKey).add(ni);
        } else {
          funcHardNotHits.add(fnKey);
        }
      }
    }
  }

  const phase2Time = Date.now() - phase2Start;
  if (showProgress) {
    process.stderr.write(`  Phase 2: details for ${phase2Files.size} files in ` +
      `${(phase2Time / 1000).toFixed(1)}s\n`);
  }

  // Build function matches
  const funcMatches = [];
  for (const [fnKey, fm] of funcMap) {
    const posMatched = new Set(
      Object.keys(fm.details).map(Number).filter(ti => !notIdxSet.has(ti))
    );
    // Gate on hard-required matches only; soft-required ones ride along
    // in matched_indices for ranking but never affect inclusion.
    let hardMatched = 0;
    for (const ti of posMatched) if (hardPosSet.has(ti)) hardMatched++;
    if (hardMatched < minTerms) continue;
    // Function-scope NOT-filter: skip if any hard-NOT term appears inside
    // the function's body (function-name match falls out for free since
    // the signature line lives inside the boundary range). Soft-NOT hits
    // do not exclude — they are surfaced via soft_not_violated.
    if (funcHardNotHits.has(fnKey)) continue;

    // Get function line count
    const boundaries = funcBoundariesCache[fm.filepath] || [];
    let funcLines = 0;
    for (const [s, e, name] of boundaries) {
      if (name === fm.function) { funcLines = e - s + 1; break; }
    }

    funcMatches.push({
      filepath: fm.filepath,
      function: fm.function,
      kind: isPseudoSource(fm.filepath) ? 'pseudo-source' : 'source',
      terms_matched: posMatched.size,
      weighted_terms: weightedTermCount(fm.details, posMatched),
      code_matched_indices: codeMatchedIndices(fm.details, posMatched),
      lines: funcLines || 0,
      matched_indices: posMatched,
      soft_not_violated: funcSoftNotHits.has(fnKey)
        ? [...funcSoftNotHits.get(fnKey)].sort((a, b) => a - b)
        : [],
      details: fm.details,
    });
  }
  funcMatches.sort((a, b) =>
    b.weighted_terms - a.weighted_terms ||
    b.terms_matched - a.terms_matched ||
    a.lines - b.lines ||
    a.function.localeCompare(b.function) ||
    a.filepath.localeCompare(b.filepath));

  // Build class matches — group functions by class name.
  // A class match means all (or minTerms) terms appear across the class's
  // methods, even if no single method contains them all.
  // Handles C++ classes split across .h/.cpp files.
  const classMap = new Map();  // className -> { details: {ti -> {line_num, line_text, func_name, filepath}}, files: Set, functions: Set, totalLines: number }

  for (const [fnKey, fm] of funcMap) {
    const funcName = fm.function;
    if (!funcName || funcName === '(global)') continue;

    // Extract class name from qualified function name
    let className = null;
    if (funcName.includes('::')) {
      className = funcName.split('::').slice(0, -1).join('::');
    } else if (funcName.includes('.')) {
      className = funcName.split('.').slice(0, -1).join('.');
    }
    if (!className) continue;

    if (!classMap.has(className)) {
      classMap.set(className, { details: {}, files: new Set(), functions: new Set(), totalLines: 0 });
    }
    const cm = classMap.get(className);
    cm.files.add(fm.filepath);
    cm.functions.add(funcName);

    // Get function line count for total
    const boundaries = funcBoundariesCache[fm.filepath] || [];
    for (const [s, e, name] of boundaries) {
      if (name === funcName) { cm.totalLines += (e - s + 1); break; }
    }

    // Merge term details — keep first hit per term for the class
    for (const [tiStr, detail] of Object.entries(fm.details)) {
      const ti = Number(tiStr);
      if (cm.details[ti] === undefined || (cm.details[ti].is_code === false && detail.is_code !== false)) {
        cm.details[ti] = {
          line_num: detail.line_num,
          line_text: detail.line_text,
          func_name: funcName,
          filepath: fm.filepath,
          is_code: detail.is_code !== false,
        };
      }
    }
  }

  const classMatches = [];
  for (const [className, cm] of classMap) {
    const posMatched = new Set(
      Object.keys(cm.details).map(Number).filter(ti => !notIdxSet.has(ti))
    );
    let hardMatched = 0;
    for (const ti of posMatched) if (hardPosSet.has(ti)) hardMatched++;
    if (hardMatched < minTerms) continue;
    const classFiles = cm.files;
    // Skip only if a hard-NOT term appears in any of the class's files.
    if (hardNotIndices.some(ni => [...classFiles].some(fp => termFileSets[ni].has(fp)))) continue;
    // Soft-NOT terms present in the class's files tag it but do not skip it.
    const softNotViolated = softNotIndices.filter(
      ni => [...classFiles].some(fp => termFileSets[ni].has(fp)));

    classMatches.push({
      class_name: className,
      terms_matched: posMatched.size,
      weighted_terms: weightedTermCount(cm.details, posMatched),
      code_matched_indices: codeMatchedIndices(cm.details, posMatched),
      matched_indices: posMatched,
      soft_not_violated: softNotViolated,
      files: [...classFiles].sort(),
      functions: [...cm.functions].sort(),
      total_lines: cm.totalLines,
      details: cm.details,
    });
  }
  classMatches.sort((a, b) =>
    b.weighted_terms - a.weighted_terms ||
    b.terms_matched - a.terms_matched ||
    a.total_lines - b.total_lines ||
    a.class_name.localeCompare(b.class_name));

  // Build file matches
  const fileMatches = [];
  for (const [fp, details] of fileDetailMap) {
    const posMatched = new Set(
      Object.keys(details).map(Number).filter(ti => !notIdxSet.has(ti))
    );
    let hardMatched = 0;
    for (const ti of posMatched) if (hardPosSet.has(ti)) hardMatched++;
    if (hardMatched < minTerms) continue;
    // Only hard-NOT terms exclude the file; soft-NOT terms tag it.
    if (hardNotIndices.some(ni => termFileSets[ni].has(fp))) continue;
    const softNotViolated = softNotIndices.filter(ni => termFileSets[ni].has(fp));

    const fileLineCount = (idx.fileLines.get(fp) || []).length;
    fileMatches.push({
      filepath: fp,
      kind: isPseudoSource(fp) ? 'pseudo-source' : 'source',
      terms_matched: posMatched.size,
      weighted_terms: weightedTermCount(details, posMatched),
      code_matched_indices: codeMatchedIndices(details, posMatched),
      lines: fileLineCount,
      matched_indices: posMatched,
      soft_not_violated: softNotViolated,
      details,
    });
  }
  fileMatches.sort((a, b) =>
    b.weighted_terms - a.weighted_terms ||
    b.terms_matched - a.terms_matched ||
    a.lines - b.lines ||
    a.filepath.localeCompare(b.filepath));

  // Build folder matches
  const folderMatches = [];
  for (const [folder, matched] of Object.entries(folderMap)) {
    const posMatched = new Set(
      Object.keys(matched).map(Number).filter(ti => !notIdxSet.has(ti))
    );
    let hardMatched = 0;
    for (const ti of posMatched) if (hardPosSet.has(ti)) hardMatched++;
    if (hardMatched < minTerms) continue;
    // Only hard-NOT terms exclude the folder; soft-NOT terms tag it.
    const hardNotHits = hardNotIndices.filter(ni => matched[ni] && matched[ni].size > 0);
    if (hardNotHits.length > 0) continue;
    const softNotViolated = softNotIndices.filter(ni => matched[ni] && matched[ni].size > 0);

    const allFiles = new Set();
    for (const ti of posMatched) {
      for (const fp of (matched[ti] || [])) allFiles.add(fp);
    }

    folderMatches.push({
      folder,
      terms_matched: posMatched.size,
      matched_indices: posMatched,
      soft_not_violated: softNotViolated,
      files_involved: allFiles.size,
      file_sets: Object.fromEntries(
        [...posMatched].map(ti => [ti, matched[ti] || new Set()])
      ),
    });
  }
  folderMatches.sort((a, b) =>
    b.terms_matched - a.terms_matched ||
    a.files_involved - b.files_involved ||
    b.folder.split('/').length - a.folder.split('/').length ||
    a.folder.localeCompare(b.folder));

  return {
    terms,
    num_terms: nTerms,
    num_positive: nPositive,
    not_indices: notIndices,
    hard_positive_indices: hardPosIndices,
    soft_positive_indices: softPosIndices,
    hard_not_indices: hardNotIndices,
    soft_not_indices: softNotIndices,
    min_terms: minTerms,
    term_file_counts: termFileCounts,
    function_matches: funcMatches,
    class_matches: classMatches,
    file_matches: fileMatches,
    folder_matches: folderMatches,
  };
}
