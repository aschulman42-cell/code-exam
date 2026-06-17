/**
 * digest.js — CLI handlers for `--digest` and `--comments-only`.
 *
 * Originally landed for #329 Phase 1 (function digest). Extended for
 * #51 (target-aware --digest across function / class / file) and #61
 * (standalone --comments-only across the same three target types,
 * plus gating the COMMENTS section in --digest behind --verbose).
 *
 * Exports:
 *   - `formatFunctionDigest(digest, opts)` / `formatClassDigest` /
 *     `formatFileDigest` — render a structured digest object as text;
 *     opts.verbose controls whether the COMMENTS section is inlined
 *     or stubbed with a hint.
 *   - `formatCommentsOnly(digest)` — banner + organized comments
 *     (flat for function targets; grouped by method for classes;
 *     grouped by top-level declaration for files).
 *   - `doDigest(index, args)` — CLI entry for `--digest <target>`.
 *   - `doCommentsOnly(index, args)` — CLI entry for the standalone
 *     `--comments-only <target>` form (legacy --extract X
 *     --comments-only modifier lives in browse.js).
 *
 * Strict rule for all formatters: only display what the digest
 * object contains — no derived interpretations, no AI-style
 * summaries. Every line is traceable to a mechanical extraction in
 * CSI's buildDigest / buildFunctionDigest / buildClassDigest /
 * buildFileDigest.
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
 * Render the COMMENTS IN BODY section into the formatter's output, gating
 * by the `verbose` opt. When verbose is false (default), emits a stub
 * section with a hint pointing the user at `--comments-only` for the
 * standalone command or `--digest -v` to include comments inline.
 * Skipped entirely when the digest has no comments.
 */
function _renderCommentsSection(push, digest, opts, sectionLabel) {
  if (!digest.comments || digest.comments.length === 0) return;
  push(sectionLabel);
  if (opts && opts.verbose) {
    for (const c of digest.comments) {
      // Tag distinguishes line ('//'), JSDoc ('/**'), and regular block ('/* ').
      let tag;
      if (c.kind === 'line') tag = '// ';
      else if (c.kind === 'jsdoc') tag = '/**';
      else tag = '/* ';
      push(`    L${c.line} ${tag}  ${_truncate(c.text, 110)}`);
    }
  } else {
    push('    (not shown by default — run --comments-only <target> for just');
    push('     comments, or --digest <target> -v to include them inline here)');
  }
  push('');
}

/**
 * digest-aiml-tip: conditional footer naming the AI/ML cells that hit the
 * digest's file/range (digest.aiml from CSI._aimlSignalFor). No signal →
 * no lines at all — never a blind footer. Range-aware wording: in-range hits
 * say "this class/function carries…"; file-only hits say "…'s file
 * (elsewhere) carries…". Cell keys double as CLI flag names.
 */
function aimlTipLines(digest, kind) {
  const sig = digest && digest.aiml || [];
  if (!sig.length) return [];
  const inRange = sig.filter(c => c.inRange > 0);
  const cells = inRange.length ? inRange : sig;
  const where = (kind === 'file' || inRange.length) ? `this ${kind} carries` : `this ${kind}'s file (elsewhere) carries`;
  const counts = cells.map(c => `${c.cell} (${inRange.length ? c.inRange : c.count})`).join(', ');
  const flags = cells.slice(0, 3).map(c => '--' + c.cell).join(' / ');
  return ['', `Tip: ${where} AI/ML signal — ${counts}.`, `     See ${flags} or the AI/ML accordions in the GUI.`];
}

/**
 * Format a digest object (from buildFunctionDigest) as plain text.
 * Sections with no content are omitted entirely (unless specifically
 * always-shown, like Identity/Callers/Callees).
 */
export function formatFunctionDigest(digest, opts = {}) {
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
  if (id.indexPath) push(`  Index:        ${id.indexPath}`);
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
    if (id.bareCandidates && id.bareCandidates.length) {
      push(`                this digest is for ${id.filepath}; disambiguate by passing one of these as file@name:`);
      for (const cand of id.bareCandidates) push(`                  - ${cand}`);
      if (id.bareDuplicateCount > id.bareCandidates.length) {
        push(`                  … and ${id.bareDuplicateCount - id.bareCandidates.length} more`);
      }
    }
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

  // --- Comments (gated by verbose; stub-with-hint by default) ---
  _renderCommentsSection(push, digest, opts, '─── COMMENTS IN BODY ────────────────────────────────────────────────');

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

  for (const l of aimlTipLines(digest, 'function')) push(l);
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
export function formatClassDigest(digest, opts = {}) {
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
  if (id.indexPath) push(`  Index:        ${id.indexPath}`);
  if (id.additionalFiles && id.additionalFiles.length > 0) {
    push(`  Also in:      ${id.additionalFiles.join(', ')}`);
  }
  if (id.inferred) {
    push(`  Lines:        (class declaration not in index; inferred from ${id.methodCount} method${id.methodCount === 1 ? '' : 's'})`);
  } else {
    push(`  Lines:        L${id.startLine}-L${id.endLine}  (${id.lineCount} lines, ${id.methodCount} methods)`);
  }
  push(`  Type:         ${id.type}`);
  push(`  Parse method: ${id.parseMethod}`);
  if (id.extends && id.extends.length > 0) {
    // Render each immediate parent followed by its ancestor chain (#62):
    //   Foo, Bar  →  "Foo ← FooP ← FooPP, Bar ← BarP"
    // The Unicode `←` reads as "X extends Y" — direction is child → parent.
    const parts = id.extends.map((p, i) => {
      const chain = id.ancestorChain && id.ancestorChain[i];
      const isExternal = id.extendsInIndex && id.extendsInIndex[i] === false;
      const head = isExternal ? `${p} [external]` : p;
      if (chain && chain.length > 0) return [head, ...chain].join(' ← ');
      return head;
    });
    push(`  Extends:      ${parts.join(', ')}`);
  } else {
    push(`  Extends:      (none detected)`);
  }
  if (id.implements && id.implements.length > 0) {
    push(`  Implements:   ${id.implements.join(', ')}`);
  }
  if (id.model) {
    // AI/ML model classification (#84) — framework + the base that qualified it.
    push(`  Model:        ${id.model.framework}${id.model.ambiguous ? '?' : ''} (via ${id.model.base})`);
  }
  if (id.bareUnique) {
    push(`  Bare name:    unique across the index`);
  } else {
    push(`  Bare name:    NOT unique — ${id.bareDuplicateCount} entries share this bare name`);
    if (id.bareCandidates && id.bareCandidates.length) {
      push(`                this digest is for ${id.filepath}; disambiguate by passing one of these as file@name:`);
      for (const cand of id.bareCandidates) push(`                  - ${cand}`);
      if (id.bareDuplicateCount > id.bareCandidates.length) {
        push(`                  … and ${id.bareDuplicateCount - id.bareCandidates.length} more`);
      }
    }
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

  // --- Known Subclasses (#62) ---
  if (digest.knownSubclasses && digest.knownSubclasses.length > 0) {
    push('─── KNOWN SUBCLASSES ────────────────────────────────────────────────');
    push('    (classes in the index whose declaration extends this one)');
    const nameW = Math.min(
      40,
      Math.max(...digest.knownSubclasses.map(s => s.bareName.length))
    );
    for (const sub of digest.knownSubclasses) {
      const fp = _shortPath(sub.filepath, 50);
      const ov = sub.overrideCount > 0
        ? `  (${sub.overrideCount} method${sub.overrideCount === 1 ? '' : 's'} overriding)`
        : '';
      push(`    ${sub.bareName.padEnd(nameW)}  ${fp}${ov}`);
    }
    if (digest.knownSubclassesOverflow > 0) {
      push(`    … and ${digest.knownSubclassesOverflow} more`);
    }
    push('');
  }

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

  // --- Inferred-class footer note (#63) ---
  // For classes synthesized from ClassName::method patterns (no real
  // `class { ... }` declaration in the index), the body-scope sections
  // below — STRINGS, BREADCRUMBS, COMMENTS — would otherwise be scoped
  // to just the first method's body. CodeSearchIndex.buildClassDigest
  // stubs them out for inferred classes; we emit a single explanatory
  // section in their place.
  if (id.inferred) {
    push('─── BODY-SCOPED SECTIONS ────────────────────────────────────────────');
    push('  (strings / breadcrumbs / comments not shown: class synthesized from');
    push('   method names; no class-declaration body to scope against. If the');
    push('   source includes the class declaration, rebuild the index with');
    push('   --use-tree-sitter or check the parser to pick it up — see #63, #65.)');
    push('');
  }

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

  // --- Comments (gated by verbose; stub-with-hint by default) ---
  _renderCommentsSection(push, digest, opts, '─── COMMENTS IN BODY (flat across class) ────────────────────────────');

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

  for (const l of aimlTipLines(digest, 'class')) push(l);
  return out.join('\n') + '\n';
}

/**
 * Format a file digest object (from buildFileDigest) as plain text.
 *
 * Sections per #51 design: identity (with header excerpt), exports,
 * imports, top-level declarations, dependency edges (importedBy +
 * importsFrom), then the shared flat strings/breadcrumbs/comments/
 * commands sections.
 *
 * File-shape output is meant to answer "what is this file, and how
 * does it fit in the codebase?" — different question from the
 * function and class digests' "what does this unit do?"
 */
export function formatFileDigest(digest, opts = {}) {
  if (!digest) return 'File not found.\n';
  if (digest._error === 'ambiguous') {
    const out = ['Ambiguous file target. Multiple files match:'];
    for (const m of digest._ambiguousMatches) out.push('  ' + m);
    out.push('Pass a more specific path (e.g. src/core/...).');
    return out.join('\n') + '\n';
  }
  const out = [];
  const push = (s) => out.push(s);

  const id = digest.identity;
  push('═'.repeat(72));
  push(`  file ${id.filepath}`);
  push('═'.repeat(72));
  if (id.indexPath) push(`  Index:        ${id.indexPath}`);
  push(`  Lines:        ${id.lineCount}`);
  push(`  Type:         ${id.type}`);
  push(`  Parse method: ${id.parseMethod}`);
  if (id.headerExcerpt) {
    push(`  Header:       ${_truncate(id.headerExcerpt, 500)}`);
  }
  push('');
  push('  (Counts throughout this digest are STATIC call-site counts,');
  push('   i.e. distinct source-code locations — NEVER dynamic runtime counts.)');
  push('');

  push('─── EXPORTS ─────────────────────────────────────────────────────────');
  if (digest.exports.length === 0) {
    push('  (no exports detected)');
  } else {
    for (const ex of digest.exports) {
      const range = ex.startLine != null
        ? (ex.endLine && ex.endLine !== ex.startLine
            ? `  L${ex.startLine}-L${ex.endLine}  (${ex.lineCount}L)`
            : `  L${ex.startLine}`)
        : '';
      const src = ex.source ? `  (re-exported from ${ex.source})` : '';
      push(`    ${ex.name}  [${ex.type}]${range}${src}`);
    }
  }
  push('');

  push('─── IMPORTS ─────────────────────────────────────────────────────────');
  if (digest.imports.length === 0) {
    push('  (no imports detected)');
  } else {
    const builtins = digest.imports.filter(i => i.isBuiltin);
    const project = digest.imports.filter(i => !i.isBuiltin);
    if (project.length > 0) {
      push(`  From project (${project.length}):`);
      for (const imp of project) {
        const names = imp.names.length > 0 ? `  { ${imp.names.join(', ')} }` : '';
        push(`    ${imp.source}${names}`);
      }
    }
    if (builtins.length > 0) {
      push(`  From node builtins / packages (${builtins.length}):`);
      for (const imp of builtins) {
        const names = imp.names.length > 0 ? `  { ${imp.names.join(', ')} }` : '';
        push(`    ${imp.source}${names}`);
      }
    }
  }
  push('');

  push('─── TOP-LEVEL DECLARATIONS ──────────────────────────────────────────');
  if (digest.topLevelDeclarations.length === 0) {
    push('  (no top-level declarations indexed)');
  } else {
    for (const d of digest.topLevelDeclarations) {
      const tag = d.exported ? '[exported]' : '';
      push(`    ${d.name}  [${d.type}]  L${d.startLine}-L${d.endLine}  (${d.lineCount}L)  ${tag}`);
    }
  }
  push('');

  const de = digest.dependencyEdges;
  push('─── DEPENDENCY EDGES ────────────────────────────────────────────────');
  push('  Imported by (other files in the index that depend on this one):');
  if (de.importedBy.length === 0) {
    push('    (no other indexed file imports from this one)');
  } else {
    for (const ib of de.importedBy) {
      const names = ib.names.length > 0 ? `  { ${ib.names.join(', ')} }` : '';
      push(`    ${_shortPath(ib.filepath, 55)}${names}`);
    }
  }
  push('  Imports from (sources this file pulls from):');
  if (de.importsFrom.length === 0) {
    push('    (no imports)');
  } else {
    for (const imf of de.importsFrom) {
      const tag = imf.isBuiltin ? '[builtin]' :
                  imf.resolvedFilepath ? `→ ${_shortPath(imf.resolvedFilepath, 50)}` :
                  '[external / unresolved]';
      push(`    ${imf.source}  ${tag}`);
    }
  }
  push('');

  const s = digest.strings;
  if (s.distinctStrings > 0) {
    push('─── STRINGS IN BODY (flat across file) ──────────────────────────────');
    push(`  ${s.totalStrings} occurrences of ${s.distinctStrings} distinct strings`);
    if (s.distinctive.length > 0) {
      push('  Most distinctive (by global rarity across the index):');
      for (const str of s.distinctive) {
        let rarity;
        if (str.globalCount == null) rarity = '';
        else if (str.globalCount === 1) rarity = '  —  unique globally';
        else rarity = `  —  ${str.globalCount} global occurrences`;
        const lc = str.localCount > 1 ? `  ×${str.localCount} here` : '';
        push(`    ${JSON.stringify(_truncate(str.val, 80))}${lc}${rarity}`);
      }
    }
    if (s.repeated.length > 0) {
      push('  Repeated within this file:');
      for (const r of s.repeated) {
        push(`    ${JSON.stringify(_truncate(r.val, 80))}  —  ${r.count} occurrences`);
      }
    }
    push('');
  }

  const bc = digest.breadcrumbs;
  if (bc.markers && bc.markers.length > 0) {
    push('─── BREADCRUMB/TRACE LABELS (flat across file) ──────────────────────');
    for (const m of bc.markers) {
      push(`    L${m.line}:  ${m.label}`);
    }
    push('');
  }

  // --- Comments (gated by verbose; stub-with-hint by default) ---
  _renderCommentsSection(push, digest, opts, '─── COMMENTS IN BODY (flat across file) ─────────────────────────────');

  const cmd = digest.commands;
  const anyCmd =
    (cmd.cliOptions && cmd.cliOptions.length) ||
    (cmd.commands && cmd.commands.length) ||
    (cmd.routes && cmd.routes.length) ||
    (cmd.guiActions && cmd.guiActions.length);
  if (anyCmd) {
    push('─── COMMAND-CATALOG CROSS-REFERENCE (any function in file) ──────────');
    if (cmd.cliOptions?.length) {
      push(`  CLI options handled by code in this file (${cmd.cliOptions.length}):`);
      for (const o of cmd.cliOptions.slice(0, 10)) {
        push(`    ${(o.flags || []).join(', ') || o.name}  ${o.help ? '— ' + _truncate(o.help, 60) : ''}`);
      }
      if (cmd.cliOptions.length > 10) push(`    … and ${cmd.cliOptions.length - 10} more`);
    }
    if (cmd.commands?.length) {
      push(`  Commands handled by code in this file (${cmd.commands.length}):`);
      for (const co of cmd.commands.slice(0, 10)) {
        push(`    ${co.name}${co.description ? '  — ' + _truncate(co.description, 60) : ''}`);
      }
    }
    if (cmd.routes?.length) {
      push(`  API routes handled by code in this file (${cmd.routes.length}):`);
      for (const r of cmd.routes.slice(0, 10)) {
        push(`    ${r.path || r.name}`);
      }
    }
    if (cmd.guiActions?.length) {
      push(`  GUI actions handled by code in this file (${cmd.guiActions.length}):`);
      for (const g of cmd.guiActions.slice(0, 10)) {
        push(`    ${g.name} (${g.type || 'action'})`);
      }
    }
    push('');
  }

  for (const l of aimlTipLines(digest, 'file')) push(l);
  return out.join('\n') + '\n';
}

/**
 * Format a comments-only output (banner + organized comments) for any
 * target type returned by `buildDigest`. Function targets render flat;
 * class targets group comments by method with subtitles; file targets
 * group by top-level declaration with a `(file scope)` bucket for
 * comments outside any top-level unit.
 *
 * Note on parser variance: which lines fall inside a function depends
 * on whether tree-sitter or the regex parser ran. JSDoc comments
 * immediately *before* a function declaration are typically included
 * in the function's range by tree-sitter but may be excluded by the
 * regex parser. Comments-only output is faithful to whatever the
 * parser recorded; no special handling.
 */
export function formatCommentsOnly(digest) {
  if (!digest) return 'Target not found.\n';
  if (digest._error === 'ambiguous') {
    const out = ['Ambiguous target. Multiple files match:'];
    for (const m of digest._ambiguousMatches) out.push('  ' + m);
    out.push('Pass a more specific path.');
    return out.join('\n') + '\n';
  }
  const out = [];
  const push = (s) => out.push(s);

  // --- Banner (identity-only, matching digest banner style) ---
  push('═'.repeat(72));
  if (digest.target_type === 'class') {
    push(`  Comments in class ${digest.identity.displayName || digest.identity.name}`);
  } else if (digest.target_type === 'file') {
    push(`  Comments in file ${digest.identity.filepath}`);
  } else {
    push(`  Comments in ${digest.identity.displayName || digest.identity.name}`);
  }
  push('═'.repeat(72));
  if (digest.identity.filepath && digest.target_type !== 'file') {
    push(`  File:    ${digest.identity.filepath}`);
  }
  if (digest.identity.indexPath) push(`  Index:   ${digest.identity.indexPath}`);
  if (digest.identity.startLine != null && digest.identity.endLine != null) {
    const meta = digest.target_type === 'class' && digest.identity.methodCount != null
      ? `  (${digest.identity.lineCount} lines, ${digest.identity.methodCount} methods)`
      : `  (${digest.identity.lineCount} lines)`;
    push(`  Lines:   L${digest.identity.startLine}-L${digest.identity.endLine}${meta}`);
  } else if (digest.identity.lineCount != null) {
    push(`  Lines:   ${digest.identity.lineCount}`);
  }
  push('');

  const comments = digest.comments || [];
  if (comments.length === 0) {
    push('  (no comments found in target)');
    return out.join('\n') + '\n';
  }

  // Helper to render one comment line. Tags distinguish the comment kind:
  //   //    line comment        (`// foo`)
  //   /**   JSDoc block         (`/** foo */`)
  //   /*    regular block       (`/* foo */`)
  // 'block-inline' is a single-line block comment; rendered with `/*` tag.
  const emitComment = (c, indent) => {
    let tag;
    if (c.kind === 'line') tag = '// ';
    else if (c.kind === 'jsdoc') tag = '/**';
    else tag = '/* ';
    push(`${indent}L${c.line} ${tag}  ${_truncate(c.text, 110)}`);
  };

  // Build a Set of every line that's part of any comment block — used by the
  // walk-backward heuristic to extend each method/decl's range backward to
  // include an immediately-preceding JSDoc block. The extractor stashes a
  // full per-block line list on `digest.commentLines` (covers opener `/**`,
  // closer `*/`, and content-less continuation lines, so walk-backward
  // doesn't stop short on the closer). Fall back to the lines of emitted
  // comments when the extractor didn't provide commentLines (older indexes).
  const commentLineSet = new Set(
    Array.isArray(digest.commentLines) ? digest.commentLines : comments.map(c => c.line)
  );
  const extendBackward = (startLine) => {
    let ext = startLine;
    for (let ln = startLine - 1; ln >= 1; ln--) {
      if (commentLineSet.has(ln)) ext = ln;
      else break;
    }
    return ext;
  };

  // --- Organize comments by target type ---
  if (digest.target_type === 'function') {
    // Flat, comments in line-order. Reads like a pseudo-spec of the function.
    for (const c of comments) emitComment(c, '    ');
  } else if (digest.target_type === 'class') {
    // Group by method. Comments outside any method go under (class scope).
    // Each method's effective range is extended backward to include any
    // contiguous block of comments immediately preceding it — typically a
    // JSDoc block describing the method.
    const methods = (digest.methods || []).slice().sort((a, b) => a.startLine - b.startLine);
    // Compute extended start for each method, capped by the previous method's endLine + 1
    let prevEnd = 0;
    for (const m of methods) {
      m.attributedStart = Math.max(extendBackward(m.startLine), prevEnd + 1);
      prevEnd = m.endLine;
    }
    const classScopeComments = [];
    const byMethod = new Map();
    for (const c of comments) {
      let found = null;
      for (const m of methods) {
        if (c.line >= m.attributedStart && c.line <= m.endLine) {
          found = m;
          break;
        }
      }
      if (found) {
        if (!byMethod.has(found.name)) byMethod.set(found.name, []);
        byMethod.get(found.name).push(c);
      } else {
        classScopeComments.push(c);
      }
    }
    if (classScopeComments.length > 0) {
      push(`▾ (class scope)`);
      for (const c of classScopeComments) emitComment(c, '      ');
      push('');
    }
    for (const m of methods) {
      const ms = byMethod.get(m.name);
      if (!ms || ms.length === 0) continue;
      const leafName = m.name.includes('::') ? m.name.split('::').pop() : m.name;
      push(`▾ ${leafName}  L${m.startLine}-L${m.endLine}  (${m.lineCount}L)`);
      for (const c of ms) emitComment(c, '      ');
      push('');
    }
  } else if (digest.target_type === 'file') {
    // Group by top-level decl. Same walk-backward attribution as classes:
    // a top-level function's JSDoc above its declaration gets attributed
    // to that function instead of falling into (file scope).
    const decls = (digest.topLevelDeclarations || []).slice().sort((a, b) => a.startLine - b.startLine);
    let prevEnd = 0;
    for (const d of decls) {
      d.attributedStart = Math.max(extendBackward(d.startLine), prevEnd + 1);
      prevEnd = d.endLine;
    }
    const fileScopeComments = [];
    const byDecl = new Map();
    for (const c of comments) {
      let found = null;
      for (const d of decls) {
        if (c.line >= d.attributedStart && c.line <= d.endLine) {
          found = d;
          break;
        }
      }
      if (found) {
        if (!byDecl.has(found.name)) byDecl.set(found.name, []);
        byDecl.get(found.name).push(c);
      } else {
        fileScopeComments.push(c);
      }
    }
    if (fileScopeComments.length > 0) {
      push(`▾ (file scope)`);
      for (const c of fileScopeComments) emitComment(c, '      ');
      push('');
    }
    for (const d of decls) {
      const ds = byDecl.get(d.name);
      if (!ds || ds.length === 0) continue;
      const exportedTag = d.exported ? '  [exported]' : '';
      push(`▾ ${d.name}  [${d.type}]  L${d.startLine}-L${d.endLine}  (${d.lineCount}L)${exportedTag}`);
      for (const c of ds) emitComment(c, '      ');
      push('');
    }
  }

  return out.join('\n') + '\n';
}

/**
 * CLI handler for `--digest <target>`. Dispatches by target_type.
 * Function targets keep today's behavior (byte-identical output).
 * Class targets produce class-shape output (Commit A, #51).
 * File targets produce file-shape output (Commit B, #51).
 *
 * COMMENTS section is gated behind `-v` / `--verbose` per #61: by
 * default the section renders as a stub with a hint pointing to
 * `--comments-only` and `--digest -v`. Pass `-v` to inline the full
 * COMMENTS section as before.
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
    console.log(`Target not found: '${spec}' (try a file hint: file@name, e.g. --digest src/foo.js@bar)`);
    return;
  }
  const formatterOpts = { verbose: !!args.verbose };
  switch (digest.target_type) {
    case 'class':
      process.stdout.write(formatClassDigest(digest, formatterOpts));
      break;
    case 'file':
      process.stdout.write(formatFileDigest(digest, formatterOpts));
      break;
    case 'function':
    default:
      process.stdout.write(formatFunctionDigest(digest, formatterOpts));
      break;
  }
}

/**
 * CLI handler for the standalone form of `--comments-only <target>`
 * (#61). Reuses `buildDigest` for target classification (function /
 * class / file) and renders only the comments via `formatCommentsOnly`.
 * Legacy modifier form (`--extract X --comments-only`) is dispatched
 * elsewhere (src/commands/browse.js) and unaffected.
 */
export function doCommentsOnly(index, args) {
  const spec = args.comments_only;
  if (!spec || spec === '.' || spec === true) {
    console.log('Error: --comments-only requires a function, class, or file target.');
    console.log('(For the legacy modifier form, pair with --extract: --extract X --comments-only)');
    return;
  }
  const opts = {
    maxCallers: 0,  // we don't need callers/callees for comments-only
    maxCallees: 0,
    maxStrings: 0,
  };
  const digest = index.buildDigest(spec, opts);
  if (!digest) {
    console.log(`Target not found: '${spec}'`);
    console.log(`Try with a more specific path or full function name.`);
    return;
  }
  process.stdout.write(formatCommentsOnly(digest));
}
