/**
 * dedup.js - Deduplication display commands.
 *
 * Commands: dupefiles, func-dupes, near-dupes, struct-dupes, show-funcstring.
 */

import { displayName } from '../utils.js';


// ========================================================================
// --dupefiles: file-level SHA1 duplicates
// ========================================================================

export function doDupefiles(index, args) {
  const n = args.dupefiles;
  const fileHashes = index.fileHashes || {};

  if (!fileHashes || Object.keys(fileHashes).length === 0) {
    console.log('No file hash data available. Rebuild index to generate SHA1 hashes.');
    return;
  }

  // Find groups with duplicates
  let groupInfo = [];
  let totalWaste = 0;

  for (const [hashVal, paths] of Object.entries(fileHashes)) {
    if (paths.length < 2) continue;
    const firstFile = paths[0];
    const lines = index.fileLines.has(firstFile)
      ? index.fileLines.get(firstFile).length
      : 0;
    const waste = lines * (paths.length - 1);
    totalWaste += waste;
    groupInfo.push({ hashVal, paths, lines, waste });
  }

  if (!groupInfo.length) {
    console.log('No duplicate files found.');
    return;
  }

  // Sort by waste descending
  groupInfo.sort((a, b) => b.waste - a.waste);

  // Apply filter
  if (args.filter) {
    const fl = args.filter.toLowerCase();
    groupInfo = groupInfo.filter(g =>
      g.paths.some(p => p.toLowerCase().includes(fl)));
  }
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    groupInfo = groupInfo.filter(g =>
      g.paths.some(p => p.toLowerCase().includes(pat)));
  }

  console.log(`\n${groupInfo.length} duplicate file groups by SHA1 hash (${totalWaste.toLocaleString()} redundant lines):\n`);
  console.log(`  ${'Copies'.padStart(6)}  ${'Lines'.padStart(6)}  ${'Waste'.padStart(8)}  ${'Hash'.padEnd(12)}  Canonical Path`);
  console.log(`  ${'-'.repeat(100)}`);

  let shown = 0;
  for (const g of groupInfo) {
    if (shown >= n) break;
    const canonical = g.paths.slice().sort((a, b) => a.length - b.length)[0];
    const copies = g.paths.length - 1;

    console.log(`  ${String(copies).padStart(6)}  ${String(g.lines).padStart(6)}  ${String(g.waste).padStart(8)}  ${g.hashVal.slice(0, 10)}..  ${canonical}`);

    for (const p of g.paths.slice().sort()) {
      if (p !== canonical) {
        console.log(`  ${''.padStart(6)}  ${''.padStart(6)}  ${''.padStart(8)}  ${''.padEnd(12)}    <- ${p}`);
      }
    }
    shown++;
  }

  if (groupInfo.length > n) {
    console.log(`\n  Showing ${n} of ${groupInfo.length} groups. Use --dupefiles ${n * 2} for more.`);
  }
}


// ========================================================================
// --func-dupes: exact duplicate functions
// ========================================================================

export function doFuncDupes(index, args) {
  const n = args.func_dupes;
  // --verbose implies --show-dupes for dupe commands
  if (args.verbose) args.show_dupes = true;
  let groups = index.getFuncDupes(n, 3, true);

  if (!groups.length) {
    console.log('No exact duplicate functions found.');
    return;
  }

  // Apply filter
  if (args.filter) {
    const flt = args.filter.toLowerCase();
    groups = groups.filter(g =>
      flt.includes(g.bare_name.toLowerCase()) ||
      g.bare_name.toLowerCase().includes(flt) ||
      g.instances.some(i => i.filepath.toLowerCase().includes(flt)));
  }
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    groups = groups.filter(g =>
      g.instances.some(i => i.filepath.toLowerCase().includes(pat)));
  }

  // Detect opstring index
  const hasOpstrings = groups.slice(0, n).some(g => (g.asm_ops || 0) > 0);
  const hasCrossFile = groups.slice(0, n).some(g => (g.n_files || 1) > 1);

  if (hasOpstrings) {
    console.log(`\nTop ${Math.min(n, groups.length)} exact duplicate function groups (opstring MD5-verified identical structure):`);
    console.log(`  ${'Waste'.padStart(6)}  ${'Copies'.padStart(6)}  ${'Lines'.padStart(6)}  ${'Ops'.padStart(5)}  ${'Files'.padStart(5)}  ${'Hash'.padStart(10)}  ${'Function'.padEnd(30)}  Location`);
    console.log(`  ${'-'.repeat(120)}`);
  } else {
    console.log(`\nTop ${Math.min(n, groups.length)} exact duplicate function groups (SHA1-verified identical bodies):`);
    console.log(`  ${'Waste'.padStart(6)}  ${'Copies'.padStart(6)}  ${'Lines'.padStart(6)}  ${'Hash'.padStart(10)}  ${'Function'.padEnd(35)}  Location`);
    console.log(`  ${'-'.repeat(115)}`);
  }

  for (const g of groups.slice(0, n)) {
    const first = g.instances[0];
    let fp = first.filepath;
    if (!args.full_path && fp.length > 38) fp = '...' + fp.slice(-35);

    const names = new Set(g.instances.map(i => i.displayName || i.name || '?'));
    const nameNote = names.size > 1 ? ` (${names.size} names)` : '';
    const filesNote = g.n_files > 1 ? ` in ${g.n_files} files` : '';
    const dn = first.displayName || displayName(first.name, first.filepath);

    if (hasOpstrings) {
      const opsStr = g.asm_ops > 0 ? String(g.asm_ops) : '-';
      console.log(`  ${String(g.waste).padStart(6)}  ${String(g.count).padStart(6)}  ${String(g.lines).padStart(6)}  ${opsStr.padStart(5)}  ${String(g.n_files).padStart(5)}  ${g.hash.slice(0, 10)}  ${dn.padEnd(30)}  ${fp}${nameNote}${filesNote}`);
    } else {
      console.log(`  ${String(g.waste).padStart(6)}  ${String(g.count).padStart(6)}  ${String(g.lines).padStart(6)}  ${g.hash.slice(0, 10)}  ${dn.padEnd(35)}  ${fp}${nameNote}${filesNote}`);
    }

    if (args.show_dupes) {
      let shown = g.instances.slice(1);
      if (g.n_files > 1) {
        shown = shown.slice().sort((a, b) =>
          (a.filepath === first.filepath ? 1 : 0) - (b.filepath === first.filepath ? 1 : 0) ||
          a.filepath.localeCompare(b.filepath));
      }
      for (const inst of shown.slice(0, 5)) {
        let ifp = inst.filepath;
        if (!args.full_path && ifp.length > 38) ifp = '...' + ifp.slice(-35);
        const idn = (inst.displayName || inst.name) !== (first.displayName || first.name)
          ? (inst.displayName || displayName(inst.name, inst.filepath)) : '';
        if (hasOpstrings) {
          console.log(`  ${''.padStart(6)}  ${''.padStart(6)}  ${''.padStart(6)}  ${''.padStart(5)}  ${''.padStart(5)}  ${''.padStart(10)}  ${idn.padEnd(30)}  ${ifp}`);
        } else {
          console.log(`  ${''.padStart(6)}  ${''.padStart(6)}  ${''.padStart(6)}  ${''.padStart(10)}  ${idn.padEnd(35)}  ${ifp}`);
        }
      }
      if (g.count > 6) {
        const pad = hasOpstrings ? `${''.padStart(6)}  ${''.padStart(5)}  ${''.padStart(5)}  ` : '';
        console.log(`  ${''.padStart(6)}  ${''.padStart(6)}  ${pad}${''.padStart(10)}  ${''.padEnd(hasOpstrings ? 30 : 35)}  ... +${g.count - 6} more`);
      }
    }
  }

  const totalWaste = groups.slice(0, n).reduce((s, g) => s + g.waste, 0);
  console.log(`\n  Total redundant lines in shown groups: ${totalWaste}`);

  // Mention other dupe types
  const struct = index.getStructDupes(1);
  if (struct.length) {
    console.log(`  Also found ${(index._structDupes || []).length} structural duplicate groups (same structure, different names/values)`);
    console.log('  Tip: Use --struct-dupes to find template/copy-paste code');
  }
  const near = index.getNearDupes(1);
  if (near.length) {
    console.log(`  Also found ${(index._nearDupes || []).length} near-duplicate groups (same name+size, different content)`);
  }
}


// ========================================================================
// --near-dupes: same name+size, different content
// ========================================================================

export function doNearDupes(index, args) {
  const n = args.near_dupes;
  if (args.verbose) args.show_dupes = true;
  // Must run func-dupes first to populate near-dupes
  index.getFuncDupes(1, 3, true);
  let near = index.getNearDupes(n);

  if (!near.length) {
    console.log('No near-duplicate functions found.');
    return;
  }

  if (args.filter) {
    const flt = args.filter.toLowerCase();
    near = near.filter(g =>
      g.bare_name.toLowerCase().includes(flt) ||
      g.instances.some(i => i.filepath.toLowerCase().includes(flt)));
  }
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    near = near.filter(g =>
      g.instances.some(i => i.filepath.toLowerCase().includes(pat)));
  }

  console.log(`\nTop ${Math.min(n, near.length)} near-duplicate groups (same name+size, different content):`);
  console.log(`  ${'Variants'.padStart(8)}  ${'Copies'.padStart(6)}  ${'Lines'.padStart(6)}  ${'Function'.padEnd(35)}  Location`);
  console.log(`  ${'-'.repeat(105)}`);

  for (const g of near.slice(0, n)) {
    const first = g.instances[0];
    let fp = first.filepath;
    if (!args.full_path && fp.length > 38) fp = '...' + fp.slice(-35);
    const dn = first.displayName || displayName(first.name, first.filepath);
    console.log(`  ${String(g.unique_variants).padStart(8)}  ${String(g.count).padStart(6)}  ${String(g.lines).padStart(6)}  ${dn.padEnd(35)}  ${fp}`);

    if (args.show_dupes) {
      // Group instances by hash to show variants
      const byHash = {};
      for (const inst of g.instances) {
        const h = inst.body_hash || '?';
        if (!byHash[h]) byHash[h] = [];
        byHash[h].push(inst);
      }
      const sorted = Object.entries(byHash).sort((a, b) => b[1].length - a[1].length);
      for (let i = 0; i < sorted.length && i < 4; i++) {
        const [h, insts] = sorted[i];
        let vfp = insts[0].filepath;
        if (!args.full_path && vfp.length > 35) vfp = '...' + vfp.slice(-32);
        console.log(`  ${''.padStart(8)}  ${String(insts.length).padStart(6)}  ${''.padStart(6)}  [variant ${h.slice(0, 8)}]${''.padEnd(19)}  ${vfp}`);
      }
      if (sorted.length > 4) {
        console.log(`  ${''.padStart(8)}  ${''.padStart(6)}  ${''.padStart(6)}  ${''.padEnd(35)}  ... +${sorted.length - 4} more variants`);
      }
    }
  }
}


// ========================================================================
// --struct-dupes: structural duplicates (same structure, different names)
// ========================================================================

export function doStructDupes(index, args) {
  const n = args.struct_dupes;
  if (args.verbose) args.show_dupes = true;
  // Must run func-dupes first to populate structural dupes
  index.getFuncDupes(1, 3, true);
  let struct = index.getStructDupes(n);

  if (!struct.length) {
    console.log('No structural duplicates found.');
    return;
  }

  if (args.filter) {
    const flt = args.filter.toLowerCase();
    struct = struct.filter(g =>
      g.bare_name.toLowerCase().includes(flt) ||
      g.instances.some(i => i.filepath.toLowerCase().includes(flt)));
  }
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    struct = struct.filter(g =>
      g.instances.some(i => i.filepath.toLowerCase().includes(pat)));
  }

  console.log(`\nTop ${Math.min(n, struct.length)} structural dupe groups (same code structure, different names/values):`);
  console.log(`  ${'Copies'.padStart(6)}  ${'Bodies'.padStart(6)}  ${'Names'.padStart(5)}  ${'Lines'.padStart(6)}  ${'Hash'.padStart(10)}  ${'Function'.padEnd(30)}  Location`);
  console.log(`  ${'-'.repeat(115)}`);

  for (const g of struct.slice(0, n)) {
    const first = g.instances[0];
    let fp = first.filepath;
    if (!args.full_path && fp.length > 35) fp = '...' + fp.slice(-32);
    const dn = first.displayName || displayName(first.name, first.filepath);
    console.log(`  ${String(g.count).padStart(6)}  ${String(g.unique_bodies).padStart(6)}  ${String(g.unique_names).padStart(5)}  ${String(g.lines).padStart(6)}  ${g.hash.slice(0, 10)}  ${dn.padEnd(30)}  ${fp}`);

    if (args.show_dupes) {
      const byBody = {};
      for (const inst of g.instances) {
        const bh = (inst.body_hash || '?').slice(0, 8);
        if (!byBody[bh]) byBody[bh] = [];
        byBody[bh].push(inst);
      }
      const sorted = Object.entries(byBody).sort((a, b) => b[1].length - a[1].length);
      let shown = 0;
      for (const [bh, insts] of sorted) {
        if (shown >= 4) {
          const remaining = sorted.length - shown;
          if (remaining > 0) {
            console.log(`  ${''.padStart(6)}  ${''.padStart(6)}  ${''.padStart(5)}  ${''.padStart(6)}  ${''.padStart(10)}  ${''.padEnd(30)}  ... +${remaining} more variants`);
          }
          break;
        }
        const rep = insts[0];
        let rfp = rep.filepath;
        if (!args.full_path && rfp.length > 32) rfp = '...' + rfp.slice(-29);
        const rdn = rep.displayName || displayName(rep.name, rep.filepath);
        console.log(`  ${''.padStart(6)}  ${String(insts.length).padStart(6)}  ${''.padStart(5)}  ${''.padStart(6)}  ${bh.padStart(10)}  ${rdn.padEnd(30)}  ${rfp}`);
        shown++;
      }
    }
  }

  // Show funcstrings if requested
  if (args.show_funcstring && struct.length) {
    console.log('\n  Funcstrings (what gets hashed):');
    for (let idx = 0; idx < Math.min(n, struct.length); idx++) {
      const g = struct[idx];
      const first = g.instances[0];
      const lines = index.fileLines.get(first.filepath);
      if (!lines) continue;
      const bodyLines = lines.slice(first.start - 1, first.end);
      const bodyText = bodyLines.join('\n');
      const funcstring = index.getStructuralNormalized(bodyText);
      const dn = first.displayName || displayName(first.name, first.filepath);
      console.log(`\n  [${idx + 1}] ${dn} (${g.hash.slice(0, 10)}):`);
      // Word-wrap for readability
      for (let j = 0; j < funcstring.length && j < 600; j += 100) {
        console.log(`      ${funcstring.slice(j, j + 100)}`);
      }
    }
  }
}


// ========================================================================
// --show-funcstring: show normalized funcstring for a function
// ========================================================================

export function doShowFuncstring(index, args) {
  const funcName = args.show_funcstring;

  if (typeof funcName === 'boolean' || !funcName) {
    // Used as bare flag - auto-imply struct-dupes
    args.struct_dupes = args.struct_dupes || 25;
    args.show_funcstring = true;
    doStructDupes(index, args);
    return;
  }

  // Find the function
  const funcs = index.listFunctions();
  const nameLower = funcName.toLowerCase();
  const matches = funcs.filter(f =>
    f.name.toLowerCase().includes(nameLower) ||
    (f.displayName && f.displayName.toLowerCase().includes(nameLower)));

  if (!matches.length) {
    console.log(`No function matching '${funcName}' found.`);
    return;
  }

  // Show funcstring for each match (up to 5)
  for (const m of matches.slice(0, 5)) {
    const lines = index.fileLines.get(m.filepath);
    if (!lines) continue;
    const bodyLines = lines.slice(m.start - 1, m.end);
    const bodyText = bodyLines.join('\n');
    const funcstring = index.getStructuralNormalized(bodyText);
    const dn = m.displayName || displayName(m.name, m.filepath);

    console.log(`\n${dn}  (${m.filepath} L${m.start}-${m.end}, ${m.lines} lines):`);
    console.log('  Funcstring:');
    for (let j = 0; j < funcstring.length; j += 100) {
      console.log(`    ${funcstring.slice(j, j + 100)}`);
    }
  }

  if (matches.length > 5) {
    console.log(`\n  ... and ${matches.length - 5} more matches. Use a more specific name.`);
  }
}


// ========================================================================
// /struct-diff: show word-hole differences between structural dupes
// ========================================================================

export function doStructDiff(index, args) {
  const query = args.struct_diff;
  if (!query) {
    console.log('Usage: /struct-diff <function-name>');
    return;
  }

  // Ensure dupes are computed
  index.getFuncDupes(1, 3, false);
  const structGroups = index.getStructDupes(9999);

  if (!structGroups.length) {
    console.log('No structural duplicates found. Run /struct-dupes first.');
    return;
  }

  const queryLower = query.toLowerCase();

  // Find matching group(s) by function name or hash prefix
  let matchedGroups = structGroups.filter(g =>
    g.bare_name.toLowerCase().includes(queryLower) ||
    g.instances.some(i =>
      (i.name || '').toLowerCase().includes(queryLower) ||
      (i.displayName || '').toLowerCase().includes(queryLower)) ||
    g.hash.startsWith(queryLower));

  if (!matchedGroups.length) {
    // Also try in exact dupe groups - user might want to diff exact dupes across files
    const exactGroups = index.getFuncDupes(9999, 3, false);
    matchedGroups = exactGroups.filter(g =>
      g.bare_name.toLowerCase().includes(queryLower) ||
      g.instances.some(i =>
        (i.name || '').toLowerCase().includes(queryLower) ||
        (i.displayName || '').toLowerCase().includes(queryLower)));

    if (matchedGroups.length) {
      console.log(`'${query}' found in exact duplicate groups (bodies are byte-identical, no structural diff to show).`);
      return;
    }

    console.log(`No structural dupe group matching '${query}'.`);
    return;
  }

  // Process each matching group
  for (const g of matchedGroups.slice(0, 3)) {
    const dn0 = g.instances[0].displayName || displayName(g.instances[0].name, g.instances[0].filepath);
    console.log(`\n=== Structural dupe group: ${dn0} (${g.count} copies, ${g.unique_bodies} variants, struct hash ${g.hash.slice(0, 10)}) ===`);

    // Get one representative per unique body hash
    const byBody = {};
    for (const inst of g.instances) {
      const bh = inst.body_hash || '?';
      if (!byBody[bh]) byBody[bh] = inst;
    }
    const variants = Object.values(byBody);

    if (variants.length < 2) {
      console.log('  Only one unique body variant - all copies are identical.');
      continue;
    }

    // Limit to first 6 variants for readability
    const toCompare = variants.slice(0, 6);

    // Extract bodies
    const bodies = [];
    for (const inst of toCompare) {
      const lines = index.fileLines.get(inst.filepath);
      if (!lines) continue;
      const bodyLines = lines.slice(inst.start - 1, inst.end);
      const bodyText = bodyLines.join('\n');
      const label = `${inst.displayName || displayName(inst.name, inst.filepath)}  (${inst.filepath})`;
      bodies.push({ body: bodyText, label, inst });
    }

    if (bodies.length < 2) {
      console.log('  Could not extract enough bodies for comparison.');
      continue;
    }

    // Show which variants we're comparing
    console.log(`  Comparing ${bodies.length} variants:`);
    for (let i = 0; i < bodies.length; i++) {
      const bh = bodies[i].inst.body_hash || '?';
      console.log(`    [${i + 1}] ${bodies[i].label}  (body ${bh.slice(0, 8)})`);
    }

    // Run struct-diff
    const result = index.structDiff(bodies);

    if (!result) {
      console.log('  Could not perform diff.');
      continue;
    }

    if (!result.aligned) {
      console.log(`  ${result.summary}`);
      continue;
    }

    if (result.diffs.length === 0) {
      console.log(`  ${result.summary}`);
      continue;
    }

    // Show summary line
    console.log(`\n  ${result.summary}`);

    // Show individual diffs, grouped for readability
    // For pairwise comparison, show [1] vs [2] vs [3] etc.
    if (result.diffs.length <= 20) {
      console.log(`\n  Word-hole differences (${result.diffs.length} positions):`);
      console.log(`  ${'Pos'.padStart(5)}  ${bodies.map((_, i) => `[${i + 1}]`.padEnd(30)).join('  ')}`);
      console.log(`  ${'-'.repeat(5 + bodies.length * 32)}`);

      for (const d of result.diffs) {
        const vals = d.values.map(v => {
          const s = v.length > 28 ? v.slice(0, 25) + '...' : v;
          return s.padEnd(30);
        });
        console.log(`  ${String(d.position).padStart(5)}  ${vals.join('  ')}`);
      }
    } else {
      // Too many diffs - show top substitution patterns
      console.log(`\n  ${result.diffs.length} word-hole positions differ (showing substitution patterns):`);
    }

    // Show substitution patterns
    if (result.substitutions.length > 0) {
      console.log('\n  Substitution patterns:');
      for (const s of result.substitutions.slice(0, 10)) {
        const countStr = s.count > 1 ? ` (x${s.count})` : '';
        console.log(`    ${s.from}  ->  ${s.to}${countStr}`);
      }
      if (result.substitutions.length > 10) {
        console.log(`    ... +${result.substitutions.length - 10} more patterns`);
      }
    }

    if (variants.length > 6) {
      console.log(`\n  (Showing 6 of ${variants.length} variants)`);
    }
  }

  if (matchedGroups.length > 3) {
    console.log(`\n  ... ${matchedGroups.length - 3} more matching groups. Use a more specific name.`);
  }
}


// ========================================================================
// /struct-diff-all: one-line summaries for top N struct-dupe groups
// ========================================================================

/**
 * Derive a "source" label from a filepath — the logical project/archive the
 * file belongs to. Used by --cross-source-only to distinguish same-project
 * duplication from cross-codebase structural matches.
 *
 *   foo/bar.zip!dir/file.py            → "bar.zip"           (archive)
 *   transformers/models/llama/x.py     → "llama"             (parent dir)
 *   /some/loose/file.ts                → "loose"             (parent dir)
 *
 * The parent-dir heuristic works well for Franken-indexes that mix multiple
 * transformers model files (each model gets its own "source" via its dir
 * name) and multiple zip archives. Not perfect for deeply-nested source
 * trees where one project spans many dirs; acceptable first cut.
 */
function _sourceOfPath(fp) {
  if (!fp) return '';
  const norm = fp.replace(/\\/g, '/');
  const bangIdx = norm.indexOf('.zip!');
  if (bangIdx >= 0) {
    const zipPath = norm.slice(0, bangIdx + 4); // include the ".zip"
    const slashIdx = zipPath.lastIndexOf('/');
    return slashIdx >= 0 ? zipPath.slice(slashIdx + 1) : zipPath;
  }
  const parts = norm.split('/').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return parts[parts.length - 2];
}

export function doStructDiffAll(index, args) {
  const n = args.struct_diff_all || 25;
  const filter = args.filter || null;
  const showSources = !!args.show_sources;
  const crossSourceOnly = !!args.cross_source_only;

  // Ensure dupes computed
  index.getFuncDupes(1, 3, false);
  let groups = index.getStructDupes(9999);

  if (!groups.length) {
    console.log('No structural duplicates found.');
    return;
  }

  // Filter to groups with >1 unique body (otherwise there's no diff to show)
  groups = groups.filter(g => g.unique_bodies >= 2);

  if (filter) {
    const pat = filter.toLowerCase();
    groups = groups.filter(g =>
      g.bare_name.toLowerCase().includes(pat) ||
      g.instances.some(i =>
        (i.name || '').toLowerCase().includes(pat) ||
        (i.filepath || '').toLowerCase().includes(pat)));
  }
  if (args.vocab_in) {
    const vpat = args.vocab_in.toLowerCase();
    groups = groups.filter(g =>
      g.instances.some(i => (i.filepath || '').toLowerCase().includes(vpat)));
  }
  // Cross-source filter: keep only groups whose members come from 2+ distinct
  // sources. This is the "show me cross-codebase patterns" mode — removes
  // clusters that are just within-project duplication (e.g. 12 copies of the
  // same helper inside a single zip).
  if (crossSourceOnly) {
    groups = groups.filter(g => {
      const sources = new Set(g.instances.map(i => _sourceOfPath(i.filepath)));
      return sources.size >= 2;
    });
  }

  if (!groups.length) {
    console.log('No multi-variant structural dupe groups found' +
      (filter ? ` matching '${filter}'.` : '.'));
    return;
  }

  const showing = Math.min(n, groups.length);
  console.log(`\nStructural diff summaries for top ${showing}` +
    (filter ? ` groups matching '${filter}'` : ' multi-variant groups') +
    (args.vocab_in ? ` [--in ${args.vocab_in}]` : '') + ':\n');

  let idx = 0;
  for (const g of groups.slice(0, n)) {
    idx++;

    // Get one representative per unique body hash
    const byBody = {};
    for (const inst of g.instances) {
      const bh = inst.body_hash || '?';
      if (!byBody[bh]) byBody[bh] = inst;
    }
    const variants = Object.values(byBody).slice(0, 6);

    // Extract bodies
    const bodies = [];
    for (const inst of variants) {
      const lines = index.fileLines.get(inst.filepath);
      if (!lines) continue;
      const bodyLines = lines.slice(inst.start - 1, inst.end);
      const bodyText = bodyLines.join('\n');
      const label = inst.displayName || displayName(inst.name, inst.filepath);
      bodies.push({ body: bodyText, label, inst });
    }

    if (bodies.length < 2) {
      console.log(`  [${idx}] ${g.bare_name} (${g.count} copies): could not extract bodies`);
      console.log();
      continue;
    }

    const result = index.structDiff(bodies);

    if (!result || !result.aligned) {
      console.log(`  [${idx}] ${g.bare_name} (${g.count} copies, ${g.unique_bodies} variants): alignment failed`);
      console.log();
      continue;
    }

    if (result.diffs.length === 0) {
      console.log(`  [${idx}] ${g.bare_name} (${g.count} copies): all word-holes identical (comment/whitespace diff only)`);
      console.log();
      continue;
    }

    // Build compact substitution summary
    let subSummary;
    if (result.substitutions.length <= 3) {
      const parts = result.substitutions.map(s =>
        s.count > 1 ? `${s.from} -> ${s.to} (x${s.count})` : `${s.from} -> ${s.to}`);
      subSummary = parts.join(', ');
    } else {
      const topParts = result.substitutions.slice(0, 2).map(s =>
        s.count > 1 ? `${s.from} -> ${s.to} (x${s.count})` : `${s.from} -> ${s.to}`);
      subSummary = `${topParts.join(', ')}, +${result.substitutions.length - 2} more`;
    }

    console.log(`  [${idx}] ${g.bare_name} (${g.count} copies, ${g.unique_bodies} variants): ` +
      `${result.diffs.length} of ${result.totalWordHoles} differ: ${subSummary}`);
    if (showSources) {
      // Dedupe by body-hash so we show one row per VARIANT (not per copy).
      // Variants carry the interesting name/source differences; copies of
      // identical bodies across the same project are redundant for provenance.
      const seen = new Set();
      for (const inst of g.instances) {
        const bh = inst.body_hash || '?';
        if (seen.has(bh)) continue;
        seen.add(bh);
        const src = _sourceOfPath(inst.filepath);
        const label = inst.displayName || inst.name;
        const pathShort = inst.filepath.length > 70
          ? '…' + inst.filepath.slice(-69)
          : inst.filepath;
        console.log(`      [${src}] ${label}  @  ${pathShort}:L${inst.start}`);
      }
    }
    console.log();  // blank line between entries
  }

  if (groups.length > n) {
    console.log(`\n  Showing ${n} of ${groups.length}. Use --struct-diff-all ${n * 2} for more.`);
  }
  console.log('\n  Use /struct-diff <name> for full word-hole comparison of a specific group.');
}
