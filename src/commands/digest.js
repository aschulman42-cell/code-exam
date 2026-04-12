/**
 * digest.js — #329 Phase 1.
 *
 * CLI handler for `--digest FUNCNAME`. Calls index.buildFunctionDigest()
 * (the pure data-assembly method on CodeSearchIndex) then formats the
 * structured object as readable text for stdout.
 *
 * Strict rule: this formatter only displays what the digest object
 * contains — no derived interpretations, no AI-style summaries. Every
 * line is traceable to a mechanical extraction in buildFunctionDigest.
 */

function _shortPath(fp, maxLen = 60) {
  if (!fp || fp.length <= maxLen) return fp || '';
  return '…' + fp.slice(-(maxLen - 1));
}

function _truncate(s, maxLen) {
  if (s == null) return '';
  s = String(s);
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s;
}

/**
 * Format a digest object (from buildFunctionDigest) as plain text.
 * Sections with no content are omitted entirely (unless specifically
 * always-shown, like Identity/Callers/Callees).
 */
export function formatFunctionDigest(digest) {
  if (!digest) return 'Function not found.\n';
  const out = [];
  const push = (s) => out.push(s);

  // --- Identity ---
  const id = digest.identity;
  push('═'.repeat(72));
  push(`  ${id.displayName}`);
  if (id.displayName !== id.name) push(`  (raw: ${id.name})`);
  push('═'.repeat(72));
  push(`  File:         ${id.filepath}`);
  push(`  Lines:        L${id.startLine}-L${id.endLine}  (${id.lineCount} lines)`);
  push(`  Type:         ${id.type}`);
  push(`  Parse method: ${id.parseMethod}`);
  if (id.renameTier) {
    push(`  Rename tier:  _${id.renameTier}_`);
  } else {
    push(`  Rename tier:  (none — function kept its original name)`);
  }
  if (id.bareUnique) {
    push(`  Bare name:    unique across the index`);
  } else {
    push(`  Bare name:    NOT unique — ${id.bareDuplicateCount} entries share this bare name`);
  }
  push('');
  push('  (Counts throughout this digest are STATIC call-site counts,');
  push('   i.e. distinct source-code locations — NEVER dynamic runtime counts.)');
  push('');

  // --- Callers ---
  const c = digest.callers;
  push('─── CALLERS ─────────────────────────────────────────────────────────');
  if (c.totalSites === 0) {
    push('  (no callers found in index — possibly an entry point or unused)');
  } else {
    push(`  ${c.totalSites} call site${c.totalSites === 1 ? '' : 's'} across ${c.distinctCallers} distinct caller${c.distinctCallers === 1 ? '' : 's'}`);
    for (const caller of c.byCaller) {
      const nm = caller.callerDisplayName || caller.callerName;
      const label = caller.siteCount === 1
        ? `${nm}`
        : `${nm}  (${caller.siteCount} sites)`;
      push(`    ${label}`);
      for (const site of caller.sites) {
        push(`      ${_shortPath(site.filepath, 50)}:${site.line}`);
      }
    }
  }
  push('');

  // --- Callees ---
  const ce = digest.callees;
  push('─── CALLEES ─────────────────────────────────────────────────────────');
  if (ce.distinctCallees === 0) {
    push('  (no callees — leaf function, or all calls resolved as builtins only)');
  } else {
    const recFlag = ce.recursive ? '  [self-recursive]' : '';
    push(`  calls ${ce.totalSites} targets across ${ce.distinctCallees} distinct callee${ce.distinctCallees === 1 ? '' : 's'}${recFlag}`);
    for (const callee of ce.topByFrequency) {
      const nm = callee.calleeDisplayName || callee.calleeName;
      const label = callee.siteCount === 1
        ? `${nm}`
        : `${nm}  (${callee.siteCount} sites)`;
      push(`    ${label}`);
    }
  }
  push('');

  // --- Strings in body ---
  const s = digest.strings;
  if (s.distinctStrings > 0) {
    push('─── STRINGS IN BODY ─────────────────────────────────────────────────');
    push(`  ${s.totalStrings} occurrences of ${s.distinctStrings} distinct strings`);
    if (s.distinctive.length > 0) {
      push('  Most distinctive (by global rarity across the index):');
      for (const str of s.distinctive) {
        let rarity;
        if (str.globalCount == null) {
          // Most commonly: string is shorter than the string-table's minLength
          // threshold (default 8). No global rarity signal available — omit
          // the rarity annotation rather than displaying confusing noise.
          rarity = '';
        } else if (str.globalCount === 1) {
          rarity = '  —  unique globally';
        } else {
          rarity = `  —  ${str.globalCount} global occurrences`;
        }
        const lc = str.localCount > 1 ? `  ×${str.localCount} here` : '';
        push(`    ${JSON.stringify(_truncate(str.val, 80))}${lc}${rarity}`);
      }
    }
    if (s.repeated.length > 0) {
      push('  Repeated within this function:');
      for (const r of s.repeated) {
        push(`    ${JSON.stringify(_truncate(r.val, 80))}  —  ${r.count} occurrences`);
      }
    }
    push('');
  }

  // --- Breadcrumbs ---
  const bc = digest.breadcrumbs;
  if (bc.markers && bc.markers.length > 0) {
    push('─── BREADCRUMB MARKERS EMITTED ──────────────────────────────────────');
    for (const m of bc.markers) {
      push(`    L${m.line}:  ${m.label}`);
    }
    push('');
  }

  // --- Comments ---
  if (digest.comments && digest.comments.length > 0) {
    push('─── COMMENTS IN BODY ────────────────────────────────────────────────');
    for (const c of digest.comments) {
      const tag = c.kind === 'line' ? '//' : '/*';
      push(`    L${c.line} ${tag}  ${_truncate(c.text, 110)}`);
    }
    push('');
  }

  // --- Command-catalog cross-reference ---
  const cmd = digest.commands;
  const anyCmd =
    (cmd.cliOptions && cmd.cliOptions.length) ||
    (cmd.commands && cmd.commands.length) ||
    (cmd.routes && cmd.routes.length) ||
    (cmd.guiActions && cmd.guiActions.length);
  if (anyCmd) {
    push('─── COMMAND-CATALOG CROSS-REFERENCE ─────────────────────────────────');
    if (cmd.cliOptions?.length) {
      push(`  CLI options handled by this function (${cmd.cliOptions.length}):`);
      for (const o of cmd.cliOptions.slice(0, 10)) {
        push(`    ${(o.flags || []).join(', ') || o.name}  ${o.help ? '— ' + _truncate(o.help, 60) : ''}`);
      }
      if (cmd.cliOptions.length > 10) push(`    … and ${cmd.cliOptions.length - 10} more`);
    }
    if (cmd.commands?.length) {
      push(`  Commands handled by this function (${cmd.commands.length}):`);
      for (const co of cmd.commands.slice(0, 10)) {
        push(`    ${co.name}${co.description ? '  — ' + _truncate(co.description, 60) : ''}`);
      }
    }
    if (cmd.routes?.length) {
      push(`  API routes handled by this function (${cmd.routes.length}):`);
      for (const r of cmd.routes.slice(0, 10)) {
        push(`    ${r.path || r.name}`);
      }
    }
    if (cmd.guiActions?.length) {
      push(`  GUI actions handled by this function (${cmd.guiActions.length}):`);
      for (const g of cmd.guiActions.slice(0, 10)) {
        push(`    ${g.name} (${g.type || 'action'})`);
      }
    }
    push('');
  }

  // --- Dupes ---
  const d = digest.dupes;
  const anyDupe = (d.exactSiblings?.length || 0) + (d.nearSiblings?.length || 0) + (d.structSiblings?.length || 0) > 0;
  if (anyDupe) {
    push('─── DUPES ───────────────────────────────────────────────────────────');
    if (d.exactSiblings?.length) {
      push(`  Exact dupes (same body SHA1): ${d.exactSiblings.length}`);
      for (const sib of d.exactSiblings.slice(0, 5)) {
        push(`    ${sib.displayName}  @  ${_shortPath(sib.filepath, 50)}  (${sib.lines}L)`);
      }
    }
    if (d.nearSiblings?.length) {
      push(`  Near dupes (same name + size, different body): ${d.nearSiblings.length}`);
      for (const sib of d.nearSiblings.slice(0, 5)) {
        push(`    ${sib.displayName}  @  ${_shortPath(sib.filepath, 50)}  (${sib.lines}L)`);
      }
    }
    if (d.structSiblings?.length) {
      push(`  Structural dupes (same shape, different names/values): ${d.structSiblings.length}`);
      for (const sib of d.structSiblings.slice(0, 5)) {
        push(`    ${sib.displayName}  @  ${_shortPath(sib.filepath, 50)}  (${sib.lines}L)`);
      }
    }
    if (d.moreUsefullyNamedSibling) {
      const best = d.moreUsefullyNamedSibling;
      push(`  HINT: a duplicate at ${_shortPath(best.filepath, 50)} is named`);
      push(`        "${best.displayName}" — likely more descriptive than this copy.`);
    }
    push('');
  }

  // --- Asserts (deferred) ---
  if (digest.asserts && digest.asserts._note) {
    // Section intentionally omitted until #337 lands; note only in verbose mode
    // (we don't clutter the default output with placeholder text)
  }

  return out.join('\n') + '\n';
}

/**
 * CLI handler for `--digest FUNCNAME`.
 */
export function doDigest(index, args) {
  const spec = args.digest;
  if (!spec) {
    console.log('Error: --digest requires a function name (optionally FILE@NAME).');
    return;
  }
  const digest = index.buildFunctionDigest(spec, {
    maxCallers: args.max_results || 10,
    maxCallees: args.max_results || 10,
    maxStrings: Math.max(15, args.max_results || 15),
  });
  if (!digest) {
    console.log(`Function not found: '${spec}'`);
    console.log(`Try with file hint: --digest FILE@FUNCNAME`);
    return;
  }
  process.stdout.write(formatFunctionDigest(digest));
}
