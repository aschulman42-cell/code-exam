// callers.js — --callers/--callees/--most-called/--call-inventory over the index's call graph, with depth and filters
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * callers.js - Caller/callee commands: callers, callees, most-called,
 * call-inventory.
 * Origin: an earlier Python implementation (not in this repo).
 */

import { displayName, parseFuncSpec, quotePathIfNeeded } from '../utils.js';
import { makeFilterMatcher } from '../core/filter-match.js';
import { isIntrinsicName } from '../core/vocabulary.js';


// ========================================================================
// Callers
// ========================================================================

export function doCallers(index, args) {
  const callersArg = args.callers;
  const depth = args.depth || 1;

  // Reverse-lookup: if user provides a renamed display name, map to original
  const resolved = index.getOriginalName ? index.getOriginalName(callersArg) : callersArg;
  let pathHint = null, functionName;
  if (resolved.includes('@')) {
    const atPos = resolved.indexOf('@');
    pathHint = resolved.slice(0, atPos);
    functionName = resolved.slice(atPos + 1);
  } else {
    functionName = resolved;
  }

  // Show which definition we're referring to
  if (pathHint) {
    const matches = index.findFunctionMatches(functionName, pathHint);
    if (matches.length === 0) {
      console.log(`No function '${functionName}' found in paths matching '${pathHint}'`);
      return;
    }
    console.log(`\nDefinition(s) of '${functionName}' in '${pathHint}':`);
    for (const m of matches.slice(0, 5)) {
      const linesCount = m.end - m.start + 1;
      console.log(`  ${quotePathIfNeeded(m.filepath)}  (${linesCount} lines)`);
    }
    if (matches.length > 5) console.log(`  ... and ${matches.length - 5} more`);
  }

  if (depth === 1) {
    // Simple single-level callers
    let callers;
    try {
      callers = index.findCallers(functionName, args.max_results);
    } catch (e) {
      if (e.code === 'SHORT_NAME_BAILOUT') {
        console.log(`\n${e.message}`);
        console.log(`\nWorkaround: use grep to find callers of short-named functions:`);
        console.log(`  node src/index.js --index-path ${quotePathIfNeeded(index.indexPath)} --regex "\\b${functionName}\\b\\s*\\("`);
        return;
      }
      throw e;
    }

    if (callers.length === 0) {
      console.log(`No callers found for '${functionName}'`);
      console.log("Note: Search is case-insensitive and matches the function name followed by '('");
      return;
    }

    // Group by caller function
    const byCaller = new Map();
    for (const c of callers) {
      const caller = c.caller_function || '(unknown)';
      if (!byCaller.has(caller)) byCaller.set(caller, []);
      byCaller.get(caller).push(c);
    }

    // Count by type
    const typeCounts = {};
    for (const c of callers) {
      const ct = c.call_type || 'direct';
      typeCounts[ct] = (typeCounts[ct] || 0) + 1;
    }

    let typeInfo = '';
    if (typeCounts.indirect || typeCounts.reference) {
      const parts = [];
      for (const ct of ['direct', 'method_ptr', 'method_dot', 'qualified', 'indirect', 'reference']) {
        if (typeCounts[ct]) parts.push(`${typeCounts[ct]} ${ct}`);
      }
      typeInfo = `  Types: ${parts.join(', ')}\n`;
    }

    const dnFunc = index.getDisplayName ? index.getDisplayName(functionName) : functionName;
    console.log(`\nCallers of '${dnFunc}' (${callers.length} call sites in ${byCaller.size} functions):\n${typeInfo}`);

    for (const [caller, calls] of [...byCaller.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const callerDn = index.getDisplayName ? index.getDisplayName(caller) : caller;
      const ncalls = calls.length;
      if (ncalls > 1) {
        console.log(`  ${callerDn}: (${ncalls} call sites)`);
      } else {
        console.log(`  ${callerDn}:`);
      }

      const sorted = calls.sort((a, b) => a.filepath.localeCompare(b.filepath) || a.line_number - b.line_number);
      const showCalls = args.verbose ? sorted : sorted.slice(0, 3);

      for (const c of showCalls) {
        let lineText = index.applyRenames ? index.applyRenames(c.line_text) : c.line_text;
        if (lineText.length > 80) lineText = lineText.slice(0, 77) + '...';
        const ct = c.call_type || 'direct';
        const tag = (ct === 'indirect' || ct === 'reference') ? ` [${ct}]` : '';
        console.log(`    ${quotePathIfNeeded(`${c.filepath}:${c.line_number}`)}${tag}`);
        console.log(`      ${lineText}`);
      }
      if (!args.verbose && ncalls > 3) {
        console.log(`    ... and ${ncalls - 3} more (use --verbose to see all)`);
      }
      console.log();
    }

  } else {
    // Transitive callers
    console.log(`\nTransitive callers of '${functionName}' (depth ${depth}):\n`);

    const visited = new Set();
    let currentLevel = new Set([functionName]);

    for (let d = 0; d < depth; d++) {
      if (currentLevel.size === 0) break;
      const nextLevel = new Set();

      for (const target of [...currentLevel].sort()) {
        const callers = index.findCallers(target, 200);
        const callerNames = {};
        for (const c of callers) {
          const caller = c.caller_function || '(unknown)';
          callerNames[caller] = (callerNames[caller] || 0) + 1;
        }

        const indent = '  '.repeat(d + 1);
        if (d === 0) console.log(`  ${target}`);

        for (const [caller, count] of Object.entries(callerNames).sort()) {
          const suffix = count > 1 ? ` (${count} calls)` : '';
          console.log(`${indent}<- ${caller}${suffix}`);
          if (!visited.has(caller) && caller !== '(unknown)') {
            nextLevel.add(caller);
          }
        }

        if (Object.keys(callerNames).length === 0) {
          console.log(`${indent}(no callers found)`);
        }
      }

      // #252: Set.add takes ONE argument — the spread form added only the
      // first node per level, duplicating subtrees and inflating the count.
      for (const t of currentLevel) visited.add(t);
      for (const v of visited) nextLevel.delete(v);
      currentLevel = nextLevel;
    }

    const total = visited.size - 1;
    console.log(`\n  ${total} unique callers found across ${depth} level(s)`);
  }
}


// ========================================================================
// Callees
// ========================================================================

export function doCallees(index, args) {
  const calleesArg = args.callees;
  // #252: same first-`@` split bug as the MCP extract/callees sites — a scoped
  // package path (`node_modules/@scope/pkg/index.js@foo`) split at the wrong @.
  const { fileHint: pathHint, funcName: functionName } = parseFuncSpec(calleesArg);

  const callees = index.findCallees(functionName, pathHint);

  if (callees.length === 0) {
    console.log(`No callees found for '${functionName}' (or function not in index)`);
    return;
  }

  // Show which definition we analyzed
  const matches = index.findFunctionMatches(functionName, pathHint);
  if (matches.length > 0) {
    const m = matches[0];
    const linesCount = m.end - m.start + 1;
    const dn = displayName(m.name, m.filepath);
    console.log(`\n${dn} (${quotePathIfNeeded(m.filepath)}, ${linesCount} lines) calls ${callees.length} functions:\n`);
  } else {
    console.log(`\n'${functionName}' calls ${callees.length} functions:\n`);
  }

  for (const ce of callees) {
    const ndefs = ce.definitions.length;
    const ct = ce.call_type || 'direct';
    const tag = (ct === 'indirect' || ct === 'reference' || ct === 'recursive') ? ` [${ct}]` : '';
    const ambigTag = ce.ambiguous ? ' [ambiguous]' : '';

    const demoted = ce.ambiguous && !ce.resolved_def;
    const bestDef = ce.resolved_def || (demoted ? null : ce.definitions[0]);
    const defLoc = bestDef ? bestDef.filepath : '';
    const defLines = bestDef ? (bestDef.end - bestDef.start + 1) : 0;

    if (demoted) {
      console.log(`  ${ce.display_name}${tag} [unresolved] (${ndefs} definition${ndefs > 1 ? 's' : ''})`);
    } else if (ndefs === 1) {
      console.log(`  ${ce.display_name}${tag}`);
      console.log(`    ${quotePathIfNeeded(defLoc)} (${defLines} lines)`);
    } else {
      console.log(`  ${ce.display_name}${tag}${ambigTag} (${ndefs} definitions)`);
      if (args.verbose) {
        for (const d of ce.definitions.slice(0, 3)) {
          const dl = d.end - d.start + 1;
          const marker = (d === bestDef) ? ' ← resolved' : '';
          console.log(`    ${quotePathIfNeeded(d.filepath)} (${dl} lines)${marker}`);
        }
        if (ndefs > 3) console.log(`    ... and ${ndefs - 3} more`);
      }
    }
  }
  console.log();
}


// ========================================================================
// Most Called
// ========================================================================

export function doMostCalled(index, args) {
  const n = args.most_called;
  const callData = index.getCallCountsWithDefinitions(true);

  if (callData.length === 0) {
    console.log('No function calls found.');
    return;
  }

  const minNameLength = args.min_name_length || 1;
  const includeMacros = args.include_macros || false;
  const definedOnly = args.defined_only || false;
  const filtersApplied = [];

  const matchCaller = args.filter ? makeFilterMatcher(args.filter) : null;
  const filteredData = [];
  for (let item of callData) {
    const funcName = item.name;

    // Apply --filter (substring, or /regex/)
    if (matchCaller && !matchCaller(funcName)) continue;

    // Min name length
    if (funcName.length < minNameLength) continue;

    // Filter ALL_CAPS macros and language intrinsics/built-ins (#276 U1)
    if (!includeMacros) {
      const bare = funcName.includes('::') ? funcName.split('::').pop() : funcName;
      if (bare.length >= 2 && /^[A-Z][A-Z0-9_]+$/.test(bare)) continue;
      if (isIntrinsicName(bare)) continue;
    }

    // Defined only
    if (definedOnly && item.definitions.length === 0) continue;

    // Apply path filters to definitions
    if (item.definitions.length > 0) {
      let defs = item.definitions;
      if (args.include_path) {
        defs = defs.filter(d => args.include_path.some(p => d.filepath.toLowerCase().includes(p.toLowerCase())));
      }
      if (args.exclude_path) {
        defs = defs.filter(d => !args.exclude_path.some(p => d.filepath.toLowerCase().includes(p.toLowerCase())));
      }
      if (args.exclude_tests) {
        defs = defs.filter(d => !d.filepath.toLowerCase().includes('test'));
      }
      item = { ...item, definitions: defs };
      // #252: this used to read item.definitions AFTER the reassignment above
      // — comparing the filtered list to itself, so the drop never fired. The
      // enclosing block already guarantees the original list was non-empty.
      if (args.exclude_tests && defs.length === 0) continue;
    }

    filteredData.push(item);
  }

  // Build filter description
  if (args.filter) filtersApplied.push(`matching '${args.filter}'`);
  if (minNameLength > 1) filtersApplied.push(`name length >= ${minNameLength}`);
  if (!includeMacros) filtersApplied.push('excluding ALL_CAPS macros & built-ins');
  if (definedOnly) filtersApplied.push('defined in index only');
  if (args.exclude_tests) filtersApplied.push('excluding tests');
  if (args.include_path) filtersApplied.push(`include paths: ${args.include_path.join(', ')}`);
  if (args.exclude_path) filtersApplied.push(`exclude paths: ${args.exclude_path.join(', ')}`);

  if (filteredData.length === 0) {
    console.log('No matching function calls found after filtering.');
    return;
  }

  const filterMsg = filtersApplied.length > 0 ? ` (${filtersApplied.join('; ')})` : '';
  console.log(`\nTop ${n} most called functions/identifiers${filterMsg}:\n`);
  console.log(`${'Count'.padStart(8)}  ${'Defs'.padStart(4)}  ${'Function'.padEnd(30)}  Definition Location(s)`);
  console.log('='.repeat(100));

  for (const item of filteredData.slice(0, n)) {
    const funcName = item.name;
    const count = item.count;
    const defs = item.definitions;
    const numDefs = defs.length;
    const dn = funcName.length <= 30 ? funcName : funcName.slice(0, 27) + '...';

    if (numDefs === 0) {
      console.log(`${String(count).padStart(8)}  ${String(numDefs).padStart(4)}  ${dn.padEnd(30)}  (not in index)`);
    } else if (numDefs === 1) {
      const d = defs[0];
      let loc = `${d.filepath}@${displayName(d.full_name, d.filepath)} (${d.lines}L)`;
      if (loc.length > 50) loc = '...' + loc.slice(-47);
      console.log(`${String(count).padStart(8)}  ${String(numDefs).padStart(4)}  ${dn.padEnd(30)}  ${loc}`);
    } else {
      console.log(`${String(count).padStart(8)}  ${String(numDefs).padStart(4)}  ${dn.padEnd(30)}  (${numDefs} definitions)`);
      if (args.verbose) {
        for (const d of defs.slice(0, 5)) {
          const loc = `${d.filepath}@${displayName(d.full_name, d.filepath)} (${d.lines}L)`;
          console.log(`${''.padStart(8)}  ${''.padStart(4)}  ${''.padStart(30)}    ${loc}`);
        }
        if (numDefs > 5) {
          console.log(`${''.padStart(8)}  ${''.padStart(4)}  ${''.padStart(30)}    ... and ${numDefs - 5} more`);
        }
      }
    }
  }

  console.log();
  const totalCount = filteredData.reduce((sum, item) => sum + item.count, 0);
  console.log(`Showing: ${Math.min(n, filteredData.length)} of ${filteredData.length} identifiers (after filtering)`);
  console.log(`Total call sites in filtered set: ${totalCount}`);
  console.log();
  console.log('Tip: Use -v/--verbose to see definition locations for multi-definition functions');
  console.log('     Use --filter PATTERN to filter by name, --exclude-path to skip folders');
  console.log('     Use --min-name-length N to filter short names, --exclude-tests to skip test files');
  console.log('     ALL_CAPS names (macros) are excluded by default; use --include-macros to show them');
}


// ========================================================================
// Call inventory
// ========================================================================

/**
 * Helper: shorten a filepath for display.
 */
function _shortPath(fp, maxLen = 50) {
  if (!fp) return '';
  const norm = fp.replace(/\\/g, '/');
  if (norm.length <= maxLen) return norm;
  return '...' + norm.slice(-(maxLen - 3));
}

export function doCallInventory(index, args) {
  const target = args.call_inventory;
  const verbose = args.verbose || false;
  const fullPath = args.full_path || false;
  const maxResults = args.max_results || 50;
  const includePath = args.include_path ? args.include_path[0] : null;
  const excludePath = args.exclude_path ? args.exclude_path[0] : null;
  const filter = args.filter || null;

  // Determine mode: single function, or all
  const isAll = (!target || target === 'all' || target === '--all' || target === true || target === '.');

  let result;
  if (isAll) {
    console.log('\nCall inventory: scanning ALL functions...\n');
    result = index.getCallInventory(null, { includePath, excludePath });
  } else {
    result = index.getCallInventory(target, {});
    if (result.summary.functions_scanned === 0) {
      console.log(`Function not found: "${target}"`);
      return;
    }
  }

  const { in_index, external, summary } = result;

  // Apply filter if provided
  let filteredExternal = external;
  if (filter) {
    const re = new RegExp(filter, 'i');
    filteredExternal = external.filter(e => re.test(e.name) || (e.provenance && re.test(e.provenance)));
  }

  // ---- Summary ----
  console.log(`Call inventory: ${summary.functions_scanned} function${summary.functions_scanned !== 1 ? 's' : ''} scanned`);
  console.log(`  ${summary.total_targets} unique call targets: ${summary.in_index_count} in index, ${summary.external_count} external`);
  console.log();

  // ---- In-index section ----
  if (!isAll || verbose) {
    // For single-function, always show in-index. For --all, only with --verbose.
    const shownIn = in_index.slice(0, isAll ? maxResults : 200);
    if (shownIn.length > 0) {
      console.log(`=== IN INDEX (${in_index.length} targets) ===`);
      for (const item of shownIn) {
        const fp = fullPath ? item.filepath : _shortPath(item.filepath, 40);
        const callerCount = item.callers.length;
        const callerNote = isAll && callerCount > 1 ? `  (called by ${callerCount} functions)` : '';
        console.log(`  ${item.qualified_name.padEnd(40)}  ${quotePathIfNeeded(fp)}  (${item.lines}L)${callerNote}`);
      }
      if (in_index.length > shownIn.length) {
        console.log(`  ... +${in_index.length - shownIn.length} more`);
      }
      console.log();
    }
  }

  // ---- External section ----
  if (filteredExternal.length > 0) {
    const filterNote = filter ? ` (filtered by "${filter}")` : '';
    console.log(`=== EXTERNAL — not in index (${filteredExternal.length} targets${filterNote}) ===`);

    // Group by provenance for --all mode
    if (isAll && !filter) {
      // Group by provenance
      const groups = new Map();
      const ungrouped = [];
      for (const item of filteredExternal) {
        if (item.provenance) {
          if (!groups.has(item.provenance)) groups.set(item.provenance, []);
          groups.get(item.provenance).push(item);
        } else {
          ungrouped.push(item);
        }
      }

      // Show grouped (sorted by group size)
      const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [provenance, items] of sortedGroups) {
        const names = items.map(i => i.name).sort();
        const callCount = items.reduce((s, i) => s + i.call_sites.length, 0);
        if (verbose || items.length <= 8) {
          console.log(`\n  [${provenance}] (${items.length} functions, ${callCount} call sites)`);
          for (const name of names) {
            const item = items.find(i => i.name === name);
            const sites = item.call_sites.length;
            console.log(`    ${name}${sites > 1 ? ` (${sites} sites)` : ''}`);
          }
        } else {
          // Compact: show first few + count
          const preview = names.slice(0, 5).join(', ');
          const more = names.length > 5 ? `, +${names.length - 5} more` : '';
          console.log(`\n  [${provenance}] (${items.length} functions, ${callCount} call sites)`);
          console.log(`    ${preview}${more}`);
        }
      }

      // Show ungrouped
      if (ungrouped.length > 0) {
        console.log(`\n  [Unknown] (${ungrouped.length} functions)`);
        const shown = ungrouped.slice(0, maxResults);
        for (const item of shown) {
          const sites = item.call_sites.length;
          const sitesNote = sites > 1 ? ` (${sites} call sites)` : '';
          if (verbose && isAll) {
            // Show sample callers
            const sampleCallers = [...new Set(item.call_sites.map(s => s.caller))].slice(0, 3);
            console.log(`    ${item.name}${sitesNote}  — called by: ${sampleCallers.join(', ')}${sampleCallers.length < sites ? ', ...' : ''}`);
          } else {
            console.log(`    ${item.name}${sitesNote}`);
          }
        }
        if (ungrouped.length > maxResults) {
          console.log(`    ... +${ungrouped.length - maxResults} more`);
        }
      }
    } else {
      // Single function or filtered: flat list
      const shown = filteredExternal.slice(0, maxResults * 2);
      for (const item of shown) {
        const prov = item.provenance ? `  (${item.provenance})` : '';
        const sites = item.call_sites.length;
        const sitesNote = isAll && sites > 1 ? `  [${sites} call sites]` : '';
        console.log(`  ${item.name}${prov}${sitesNote}`);
      }
      if (filteredExternal.length > shown.length) {
        console.log(`  ... +${filteredExternal.length - shown.length} more`);
      }
    }
    console.log();
  }

  // ---- Tips ----
  if (isAll) {
    console.log('Tip: Use --filter PATTERN to search external calls (e.g., --filter "SSL")');
    console.log('     Use -v/--verbose for detailed in-index listing');
    console.log('     Use --call-inventory FUNCNAME for a single function');
    console.log('     See also: --entry-points (uncalled functions), --gaps (suspicious dead code)');
  } else {
    console.log('Tip: Use --call-inventory (no argument) for codebase-wide inventory');
    console.log('     Use --filter PATTERN to search (e.g., --filter "malloc")');
    console.log('     See also: --entry-points (uncalled functions), --gaps (suspicious dead code)');
  }
}
