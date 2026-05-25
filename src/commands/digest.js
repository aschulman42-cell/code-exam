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
  if (c.skipped) {
    push(`  (${c.skipped})`);
  } else if (c.totalSites === 0) {
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
        if (site.text) {
          // Trim leading indentation but preserve the rest. Cap at 120 chars
          // so a minified single-line file doesn't blow up the digest.
          const t = site.text.trimStart();
          push(`        ${t.length > 120 ? t.slice(0, 120) + '…' : t}`);
        }
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
    push('─── BREADCRUMB/TRACE LABELS EMITTED BY THE CODE ─────────────────────');
    push('    (string-literal labels passed to trace/telemetry helpers — not filepaths)');
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
 * Format a class digest object (from buildClassDigest) as plain text.
 *
 * Section layout mirrors the function digest's prose flow but with
 * class-shaped sections: identity (with extends/implements), methods
 * (one line per method), instantiation sites (formerly CALLERS),
 * external calls (whole-class aggregate, formerly CALLEES), then the
 * flat strings/breadcrumbs/comments/commands sections shared with
 * the function digest. No dupes section (dupe detection is
 * function-scope only).
 *
 * Per #51 design decisions: sections stay flat, no per-method nesting.
 */
export function formatClassDigest(digest) {
  if (!digest) return 'Class not found.\n';
  const out = [];
  const push = (s) => out.push(s);

  // --- Identity ---
  const id = digest.identity;
  push('═'.repeat(72));
  push(`  class ${id.displayName}`);
  if (id.displayName !== id.name) push(`  (raw: ${id.name})`);
  push('═'.repeat(72));
  push(`  File:         ${id.filepath}`);
  if (id.additionalFiles && id.additionalFiles.length > 0) {
    push(`  Also in:      ${id.additionalFiles.join(', ')}`);
  }
  push(`  Lines:        L${id.startLine}-L${id.endLine}  (${id.lineCount} lines, ${id.methodCount} methods)`);
  push(`  Type:         ${id.type}`);
  push(`  Parse method: ${id.parseMethod}`);
  if (id.extends && id.extends.length > 0) {
    push(`  Extends:      ${id.extends.join(', ')}`);
  } else {
    push(`  Extends:      (none detected)`);
  }
  if (id.implements && id.implements.length > 0) {
    push(`  Implements:   ${id.implements.join(', ')}`);
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

  // --- Methods ---
  push('─── METHODS ─────────────────────────────────────────────────────────');
  if (digest.methods.length === 0) {
    push('  (no methods detected for this class)');
  } else {
    for (const m of digest.methods) {
      const fp = m.filepath === id.filepath ? '' : `  [${_shortPath(m.filepath, 40)}]`;
      const mod = m.modifier ? `  ${m.modifier}` : '';
      const leafName = m.name.includes('::') ? m.name.split('::').pop() : m.name;
      push(`    ${leafName}  L${m.startLine}-L${m.endLine}  (${m.lineCount}L)${mod}${fp}`);
    }
  }
  push('');

  // --- Instantiation Sites ---
  const inst = digest.instantiationSites;
  push('─── INSTANTIATION SITES ─────────────────────────────────────────────');
  push('    (matches `new ClassName(...)` and other call-shaped references)');
  if (inst.totalSites === 0) {
    push('  (no instantiation sites found in index — possibly internal or unused)');
  } else {
    push(`  ${inst.totalSites} site${inst.totalSites === 1 ? '' : 's'} across ${inst.distinctCallers} distinct caller${inst.distinctCallers === 1 ? '' : 's'}`);
    for (const caller of inst.byCaller) {
      const nm = caller.callerDisplayName || caller.callerName;
      const label = caller.siteCount === 1 ? nm : `${nm}  (${caller.siteCount} sites)`;
      push(`    ${label}`);
      for (const site of caller.sites) {
        push(`      ${_shortPath(site.filepath, 50)}:${site.line}`);
        if (site.text) {
          const t = site.text.trimStart();
          push(`        ${t.length > 120 ? t.slice(0, 120) + '…' : t}`);
        }
      }
    }
  }
  push('');

  // --- External Calls ---
  const ec = digest.externalCalls;
  push('─── EXTERNAL CALLS (aggregated across all methods) ──────────────────');
  if (ec.distinctCallees === 0) {
    push('  (no callees found across class methods)');
  } else {
    push(`  ${ec.totalSites} calls to ${ec.distinctCallees} distinct callee${ec.distinctCallees === 1 ? '' : 's'}`);
    for (const callee of ec.topByFrequency) {
      const nm = callee.calleeDisplayName || callee.calleeName;
      const label = callee.siteCount === 1 ? nm : `${nm}  (${callee.siteCount} sites)`;
      push(`    ${label}`);
    }
  }
  push('');

  // --- Strings (flat) ---
  const s = digest.strings;
  if (s.distinctStrings > 0) {
    push('─── STRINGS IN BODY (flat across class) ─────────────────────────────');
    push(`  ${s.totalStrings} occurrences of ${s.distinctStrings} distinct strings`);
    if (s.distinctive.length > 0) {
      push('  Most distinctive (by global rarity across the index):');
      for (const str of s.distinctive) {
        let rarity;
        if (str.globalCount == null) {
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
      push('  Repeated within the class:');
      for (const r of s.repeated) {
        push(`    ${JSON.stringify(_truncate(r.val, 80))}  —  ${r.count} occurrences`);
      }
    }
    push('');
  }

  // --- Breadcrumbs (flat) ---
  const bc = digest.breadcrumbs;
  if (bc.markers && bc.markers.length > 0) {
    push('─── BREADCRUMB/TRACE LABELS (flat across class) ─────────────────────');
    for (const m of bc.markers) {
      push(`    L${m.line}:  ${m.label}`);
    }
    push('');
  }

  // --- Comments (flat) ---
  if (digest.comments && digest.comments.length > 0) {
    push('─── COMMENTS IN BODY (flat across class) ────────────────────────────');
    for (const c of digest.comments) {
      const tag = c.kind === 'line' ? '//' : '/*';
      push(`    L${c.line} ${tag}  ${_truncate(c.text, 110)}`);
    }
    push('');
  }

  // --- Command-catalog cross-reference (any method handling commands) ---
  const cmd = digest.commands;
  const anyCmd =
    (cmd.cliOptions && cmd.cliOptions.length) ||
    (cmd.commands && cmd.commands.length) ||
    (cmd.routes && cmd.routes.length) ||
    (cmd.guiActions && cmd.guiActions.length);
  if (anyCmd) {
    push('─── COMMAND-CATALOG CROSS-REFERENCE (any method) ────────────────────');
    if (cmd.cliOptions?.length) {
      push(`  CLI options handled by methods of this class (${cmd.cliOptions.length}):`);
      for (const o of cmd.cliOptions.slice(0, 10)) {
        push(`    ${(o.flags || []).join(', ') || o.name}  ${o.help ? '— ' + _truncate(o.help, 60) : ''}`);
      }
      if (cmd.cliOptions.length > 10) push(`    … and ${cmd.cliOptions.length - 10} more`);
    }
    if (cmd.commands?.length) {
      push(`  Commands handled by methods of this class (${cmd.commands.length}):`);
      for (const co of cmd.commands.slice(0, 10)) {
        push(`    ${co.name}${co.description ? '  — ' + _truncate(co.description, 60) : ''}`);
      }
    }
    if (cmd.routes?.length) {
      push(`  API routes handled by methods of this class (${cmd.routes.length}):`);
      for (const r of cmd.routes.slice(0, 10)) {
        push(`    ${r.path || r.name}`);
      }
    }
    if (cmd.guiActions?.length) {
      push(`  GUI actions handled by methods of this class (${cmd.guiActions.length}):`);
      for (const g of cmd.guiActions.slice(0, 10)) {
        push(`    ${g.name} (${g.type || 'action'})`);
      }
    }
    push('');
  }

  return out.join('\n') + '\n';
}

/**
 * CLI handler for `--digest <target>`. Dispatches by target_type.
 * Function targets keep today's behavior (byte-identical output).
 * Class targets produce the class-shape output added in Commit A.
 * File targets are TODO (Commit B will add).
 */
export function doDigest(index, args) {
  const spec = args.digest;
  if (!spec) {
    console.log('Error: --digest requires a function, class, or file target.');
    return;
  }
  const opts = {
    maxCallers: args.max_results || 10,
    maxCallees: args.max_results || 10,
    maxStrings: Math.max(15, args.max_results || 15),
  };
  const digest = index.buildDigest(spec, opts);
  if (!digest) {
    console.log(`Target not found: '${spec}'`);
    console.log(`Try with file hint: --digest FILE@FUNCNAME`);
    return;
  }
  switch (digest.target_type) {
    case 'class':
      process.stdout.write(formatClassDigest(digest));
      break;
    case 'file':
      // Commit B will land formatFileDigest; for now, advise
      console.log(`File digest not yet implemented in this build. (Will land in CLI batch B for #51.)`);
      break;
    case 'function':
    default:
      process.stdout.write(formatFunctionDigest(digest));
      break;
  }
}
