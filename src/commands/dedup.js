/**
 * dedup.js - Deduplication display commands.
 *
 * Commands: dupefiles, func-dupes, near-dupes, struct-dupes, show-funcstring.
 */

import { displayName } from '../utils.js';
import {
  computeAllFingerprints,
  loadFingerprintsList,
  sourceOfPath,
  jaccard,
} from './fingerprint.js';


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

  // An all-hex argument of 8+ chars is treated as a struct_hash / body_hash
  // (full or prefix), not a function name — this resolves a hash from
  // --funcstr-hashes or --notable-funcstr-matches back to its funcstring.
  // Anything else is matched as a name substring, exactly as before.
  const isHash = /^[0-9a-f]{8,}$/i.test(funcName);
  let matches;

  if (isHash) {
    const h = funcName.toLowerCase();
    const hashMap = index.ensureFuncHashes(3, false);
    const matchedKeys = new Set();
    for (const [key, info] of hashMap) {
      if (info.struct_hash.startsWith(h) || info.body_hash.startsWith(h)) {
        matchedKeys.add(key);
      }
    }
    // Resolve to full function records (with reliable start/end) via
    // listFunctions — the same source the name path trusts — rather than
    // the sparser functionIndex map, whose start/end can be absent.
    matches = index.listFunctions().filter(f =>
      matchedKeys.has(`${f.filepath}|||${f.name}`));
  } else {
    const funcs = index.listFunctions();
    const nameLower = funcName.toLowerCase();
    matches = funcs.filter(f =>
      f.name.toLowerCase().includes(nameLower) ||
      (f.displayName && f.displayName.toLowerCase().includes(nameLower)));
  }

  if (!matches.length) {
    console.log(isHash
      ? `No function with a struct/body hash matching '${funcName}' found.`
      : `No function matching '${funcName}' found.`);
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
    console.log(isHash
      ? `\n  ... and ${matches.length - 5} more functions sharing that hash.`
      : `\n  ... and ${matches.length - 5} more matches. Use a more specific name.`);
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

// _sourceOfPath is now imported from ./fingerprint.js as sourceOfPath — both
// the struct-dupe family and the string-call-dupe family share it so their
// --cross-source-only filters use the same "source" definition.
const _sourceOfPath = sourceOfPath;

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
      // Dedupe by (body-hash, source) rather than body-hash alone. Dedupe-by-
      // body-hash alone can HIDE copies from other sources when those copies
      // share an identical body — which is exactly when cross-source matches
      // are the strongest evidence. Keep one row per distinct (body, source)
      // pair so provenance stays honest.
      const seen = new Set();
      for (const inst of g.instances) {
        const bh = inst.body_hash || '?';
        const src = _sourceOfPath(inst.filepath);
        const key = bh + '|' + src;
        if (seen.has(key)) continue;
        seen.add(key);
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


// ========================================================================
// --string-call-dupes: exact fingerprint-hash grouping
// ========================================================================
//
// Parallel to --struct-dupes, but groups functions by their "string-call
// fingerprint" — the set of distinctive string literals they contain plus the
// names of functions/methods they call — rather than by structural shape.
// Two functions with the same fingerprint have the same semantic signature
// (same rare strings, same call targets) even if one was bundled/minified
// and the other wasn't.

/**
 * Shared helper: compute fingerprints once, bucket by hash into groups.
 * Returns array of { hash, count, unique_names, unique_bodies (always 1 per
 * hash here), bare_name (representative), lines, instances[] }, sorted by
 * group size descending. Shape matches getStructDupes() output so the same
 * display/filter code paths can drive it.
 */
function _getStringCallDupeGroups(index, opts = {}) {
  const { fns } = computeAllFingerprints(index, opts);
  const byHash = new Map();
  for (const f of fns) {
    if (!byHash.has(f.hash)) byHash.set(f.hash, []);
    byHash.get(f.hash).push(f);
  }
  const groups = [];
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue;  // a dupe group needs ≥2 members
    const names = new Set(members.map(m => m.name));
    const bareName = members[0].name.includes('::')
      ? members[0].name.split('::').pop()
      : members[0].name;
    groups.push({
      hash,
      count: members.length,
      unique_bodies: members.length,  // by definition each member is distinct body
      unique_names: names.size,
      bare_name: bareName,
      lines: members[0].lines,
      instances: members.map(m => ({
        filepath: m.filepath,
        name: m.name,
        displayName: m.name,
        start: m.start,
        end: m.end,
        lines: m.lines,
        body_hash: m.hash,  // used by the dedupe-by-(body,source) in --show-sources
      })),
    });
  }
  // Sort by group size (descending), then by lines (descending)
  groups.sort((a, b) => b.count - a.count || b.lines - a.lines);
  return groups;
}

export function doStringCallDupes(index, args) {
  const n = args.string_call_dupes;
  if (args.verbose) args.show_dupes = true;

  let groups = _getStringCallDupeGroups(index);
  if (!groups.length) {
    console.log('No string-call duplicates found.');
    console.log('(Functions sharing the SAME set of distinctive string literals');
    console.log(' and called-name tokens. If none found, try a Franken-index');
    console.log(' mixing your codebase with a reference library.)');
    return;
  }

  if (args.filter) {
    const flt = args.filter.toLowerCase();
    groups = groups.filter(g =>
      g.bare_name.toLowerCase().includes(flt) ||
      g.instances.some(i => i.filepath.toLowerCase().includes(flt)));
  }

  console.log(`\nTop ${Math.min(n, groups.length)} string-call dupe groups (same semantic fingerprint — rare strings + called names):`);
  console.log(`  ${'Copies'.padStart(6)}  ${'Names'.padStart(5)}  ${'Lines'.padStart(6)}  ${'Hash'.padStart(10)}  ${'Function'.padEnd(30)}  Location`);
  console.log(`  ${'-'.repeat(100)}`);

  for (const g of groups.slice(0, n)) {
    const first = g.instances[0];
    let fp = first.filepath;
    if (!args.full_path && fp.length > 35) fp = '...' + fp.slice(-32);
    const dn = first.displayName || displayName(first.name, first.filepath);
    console.log(`  ${String(g.count).padStart(6)}  ${String(g.unique_names).padStart(5)}  ${String(g.lines).padStart(6)}  ${g.hash}  ${dn.padEnd(30)}  ${fp}`);

    if (args.show_dupes) {
      for (const inst of g.instances.slice(0, 5)) {
        const ifp = args.full_path ? inst.filepath
          : (inst.filepath.length > 50 ? '...' + inst.filepath.slice(-47) : inst.filepath);
        console.log(`           [${sourceOfPath(inst.filepath)}]  ${inst.name}  @  ${ifp}:L${inst.start}`);
      }
      if (g.instances.length > 5) console.log(`           … and ${g.instances.length - 5} more`);
    }
  }

  if (groups.length > n) {
    console.log(`\n  Showing ${n} of ${groups.length}. Use --string-call-dupes ${n * 2} for more.`);
  }
}


// ========================================================================
// --notable-funcstr-matches: surprise-scored structural funcstring groups
// ========================================================================
//
// CLI form of the GUI's "Notable Funcstring Matches". Calls the same
// index.findSurprisingStructGroups engine method that the
// /api/surprising-funcstrings route uses, so CLI and GUI produce
// identical groups for the same index + thresholds.

export function doNotableFuncstrMatches(index, args) {
  const limit = args.notable_funcstr_matches;
  const opts = {
    limit,
    minLines: args.nf_min_lines ? Math.max(3, args.nf_min_lines) : 3,
    minPeakSurprise: args.nf_min_surprise != null ? parseFloat(args.nf_min_surprise) : 0.5,
    sortBy: ['peak', 'mean', 'lines'].includes(args.nf_sort) ? args.nf_sort : 'peak',
    tight: !!args.nf_tight,
  };

  const result = index.findSurprisingStructGroups(opts);
  let groups = result.groups;

  // Optional filter on instance name / filepath (mirrors the dupe routes).
  if (args.filter) {
    const pat = args.filter.toLowerCase();
    groups = groups.filter(g =>
      g.instances.some(i =>
        (i.name || '').toLowerCase().includes(pat) ||
        (i.filepath || '').toLowerCase().includes(pat)));
  }

  if (!groups.length) {
    console.log('No notable funcstring matches at these thresholds.');
    console.log('(Groups of functions sharing a structural funcstring whose members');
    console.log(' are "surprising" — different names and/or distant file paths.');
    console.log(' Try a lower --nf-min-surprise, or a Franken-index mixing your');
    console.log(' codebase with a reference library.)');
    return;
  }

  console.log(`\nTop ${Math.min(limit, groups.length)} notable funcstring matches ` +
    `(sort: ${opts.sortBy}, min peak-surprise ${opts.minPeakSurprise}):`);
  console.log(`  ${'Peak'.padStart(5)}  ${'Mean'.padStart(5)}  ${'Count'.padStart(5)}  ` +
    `${'Lines'.padStart(6)}  ${'Hash'.padStart(10)}  Peak pair`);
  console.log(`  ${'-'.repeat(100)}`);

  for (const g of groups.slice(0, limit)) {
    const pp = g.peakPair;
    const pairStr = pp
      ? `${pp.a_display || pp.a}  vs  ${pp.b_display || pp.b}`
      : '(all bodies exact)';
    console.log(`  ${g.peakSurprise.toFixed(2).padStart(5)}  ${g.meanSurprise.toFixed(2).padStart(5)}  ` +
      `${String(g.count).padStart(5)}  ${String(g.lines).padStart(6)}  ` +
      `${g.struct_hash.slice(0, 10)}  ${pairStr}`);

    if (args.verbose) {
      for (const inst of g.instances.slice(0, 8)) {
        let fp = inst.filepath;
        if (!args.full_path && fp.length > 50) fp = '...' + fp.slice(-47);
        console.log(`           ${inst.displayName || inst.name}  @  ${fp}:L${inst.start || '?'}`);
      }
      if (g.instances.length > 8) {
        console.log(`           … and ${g.instances.length - 8} more`);
      }
    }
  }

  if (result.total > limit) {
    console.log(`\n  Showing ${limit} of ${result.total}. ` +
      `Use --notable-funcstr-matches ${limit * 2} for more.`);
  }
}


// ========================================================================
// --funcstr-hashes: dump every function's structural hash
// ========================================================================
//
// Quiet, header-less, tab-separated — one row per function at or above the
// required min-lines. Built for piping into awk/sort/join to intersect
// funcstring-hash sets across indexes (issue #16, unblocks #15). The
// min-lines value is the flag's required argument, not an option, so a
// cross-index run can never silently include tiny generic functions.

export function doFuncstrHashes(index, args) {
  const minLines = args.funcstr_hashes;
  const tight = !!args.fh_tight;
  const hashes = tight
    ? index.ensureFuncHashesTight(minLines)
    : index.ensureFuncHashes(minLines, false);

  // This command is built to be piped (| head, | awk). Exit quietly when
  // the downstream consumer closes the pipe, instead of crashing on EPIPE.
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  // A function "name" can carry embedded tabs/newlines (parser mis-captures
  // — see issue #348); collapse whitespace so every row stays one clean,
  // 5-field tab-separated record and never corrupts a downstream awk pipe.
  const clean = (s) => String(s).replace(/[\t\r\n]+/g, ' ');

  let n = 0;
  for (const [key, info] of hashes) {
    if (info.lines < minLines) continue;
    const sep = key.indexOf('|||');
    const filepath = sep >= 0 ? key.slice(0, sep) : key;
    const name = sep >= 0 ? key.slice(sep + 3) : key;
    process.stdout.write(
      `${info.struct_hash}\t${info.body_hash}\t${info.lines}\t` +
      `${clean(name)}\t${clean(filepath)}\n`);
    n++;
  }

  // Summary on stderr so stdout stays a clean, header-less data pipe.
  process.stderr.write(
    `[funcstr-hashes] ${n} function(s) at >= ${minLines} lines` +
    `${tight ? ' (tight)' : ''}\n`);
}


// ========================================================================
// --string-call-diff-all: detailed output with --show-sources / --cross-source-only
// ========================================================================
//
// Parallel to --struct-diff-all. For each multi-member fingerprint group,
// shows the common fingerprint (intersection), plus tokens that are missing
// from any individual member (never happens at exact-match tier — all members
// share the SAME fingerprint by construction — but we show the fingerprint
// itself so the user can see WHY the group formed).

export function doStringCallDiffAll(index, args) {
  const n = args.string_call_diff_all || 25;
  const filter = args.filter || null;
  const showSources = !!args.show_sources;
  const crossSourceOnly = !!args.cross_source_only;

  let groups = _getStringCallDupeGroups(index);
  if (!groups.length) {
    console.log('No string-call duplicates found.');
    return;
  }

  if (filter) {
    const pat = filter.toLowerCase();
    groups = groups.filter(g =>
      g.bare_name.toLowerCase().includes(pat) ||
      g.instances.some(i =>
        (i.name || '').toLowerCase().includes(pat) ||
        (i.filepath || '').toLowerCase().includes(pat)));
  }
  if (crossSourceOnly) {
    groups = groups.filter(g => {
      const sources = new Set(g.instances.map(i => sourceOfPath(i.filepath)));
      return sources.size >= 2;
    });
  }

  if (!groups.length) {
    console.log('No string-call dupe groups matched the filters.');
    return;
  }

  const showing = Math.min(n, groups.length);
  console.log(`\nString-call fingerprint groups (top ${showing})` +
    (filter ? ` matching '${filter}'` : '') +
    (crossSourceOnly ? ' [cross-source only]' : '') + ':\n');

  let idx = 0;
  for (const g of groups.slice(0, n)) {
    idx++;
    console.log(`  [${idx}] ${g.bare_name} (${g.count} copies): fingerprint hash ${g.hash}`);
    if (showSources) {
      // Dedupe by (hash, source) — since all members share the same hash by
      // construction, this effectively dedupes by source only, keeping one
      // row per source. That's exactly the cross-source provenance view.
      const seen = new Set();
      for (const inst of g.instances) {
        const src = sourceOfPath(inst.filepath);
        const key = g.hash + '|' + src + '|' + inst.name;
        if (seen.has(key)) continue;
        seen.add(key);
        const pathShort = inst.filepath.length > 70
          ? '…' + inst.filepath.slice(-69)
          : inst.filepath;
        console.log(`      [${src}] ${inst.name}  @  ${pathShort}:L${inst.start}`);
      }
    }
    console.log();
  }

  if (groups.length > n) {
    console.log(`  Showing ${n} of ${groups.length}. Use --string-call-diff-all ${n * 2} for more.`);
  }
}


// ========================================================================
// --cmp-string-call-dupes: JACCARD similarity comparison (fuzzy)
// ========================================================================
//
// Unlike --string-call-dupes (which requires EXACT fingerprint-hash match),
// this finds function PAIRS whose fingerprints overlap above a similarity
// threshold. This is the "find the SDK function that resembles this minified
// cli.js function" tool — bundling often shaves a few tokens off the original
// fingerprint, so exact-match misses, but Jaccard similarity recovers the
// match.

export function doCmpStringCallDupes(index, args) {
  const minScore = parseFloat(args.cmp_string_call_dupes) || 0.5;
  const minTokens = args.fingerprint_min_tokens != null
    ? parseInt(args.fingerprint_min_tokens) : 6;
  const workSource = args.fingerprint_work || null;
  const refSource = args.fingerprint_ref || null;
  const nameFilter = args.filter || null;
  const maxResults = args.max_results || 50;
  const showTokens = !!args.show_tokens;

  console.log('Computing fingerprints for all functions...');
  const { fns: indexFns } = computeAllFingerprints(index, { minTokens });
  console.log(`  ${indexFns.length} index functions have fingerprints with ≥${minTokens} tokens`);

  // Merge in any --load-fingerprints files (portable reference libraries)
  const { fns: loadedFns } = loadFingerprintsList(args.load_fingerprints);
  const fns = indexFns.concat(loadedFns);
  if (loadedFns.length > 0) {
    console.log(`  +${loadedFns.length} loaded from fingerprints file(s); total pool: ${fns.length}`);
  }

  const workFns = workSource
    ? fns.filter(f => f.source.toLowerCase().includes(workSource.toLowerCase()))
    : fns;
  const refFns = refSource
    ? fns.filter(f => f.source.toLowerCase().includes(refSource.toLowerCase()))
    : fns;
  console.log(`  work side: ${workFns.length}${workSource ? ` (source~${workSource})` : ''}`);
  console.log(`  ref  side: ${refFns.length}${refSource ? ` (source~${refSource})` : ''}`);

  if (!workFns.length || !refFns.length) {
    console.log('No functions to compare after filtering.');
    return;
  }

  // Inverted index token → ref function indexes — lets us find candidate
  // ref functions for each work function in O(tokens × token-frequency)
  // instead of O(work × ref).
  const tokenToRef = new Map();
  for (let i = 0; i < refFns.length; i++) {
    for (const t of refFns[i].fingerprint) {
      if (!tokenToRef.has(t)) tokenToRef.set(t, []);
      tokenToRef.get(t).push(i);
    }
  }

  // Canonical-order key so pair (A,B) and pair (B,A) produce the same key.
  // Needed for symmetric dedup: when the work and ref sets overlap (e.g.
  // both are the full function list), we'd otherwise emit each pair twice.
  const canonKey = (a, b) => {
    const ka = a.filepath + '|||' + a.name;
    const kb = b.filepath + '|||' + b.name;
    return ka < kb ? ka + '<=>' + kb : kb + '<=>' + ka;
  };
  const seenPair = new Set();

  const matches = [];
  for (const w of workFns) {
    const sharedCount = new Map();
    for (const t of w.fingerprint) {
      const refList = tokenToRef.get(t);
      if (!refList) continue;
      for (const ri of refList) sharedCount.set(ri, (sharedCount.get(ri) || 0) + 1);
    }
    for (const [ri, inter] of sharedCount) {
      const r = refFns[ri];
      if (r === w) continue;
      if (r.source === w.source) continue;  // cross-source only
      if (nameFilter) {
        const p = nameFilter.toLowerCase();
        if (!w.name.toLowerCase().includes(p) && !r.name.toLowerCase().includes(p)) continue;
      }
      const score = jaccard(w.fingerprint, r.fingerprint);
      if (score < minScore) continue;
      const key = canonKey(w, r);
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      matches.push({ w, r, score, inter });
    }
  }
  matches.sort((a, b) => b.score - a.score);

  // Collapse matches where the SAME work fn matches multiple source-variants
  // of the SAME ref fn (bare-name + same fingerprint). E.g. cli.js::yS
  // matching zod's ZodString across v3/types.cjs + v3/types.js + src/types.ts
  // — three "different" matches but one logical identification. Keep only the
  // best-scoring match per (work-fn, ref-bare-name) pair.
  const bareOf = (name) => (name.includes('::') ? name.split('::').pop() : name);
  const bestByPair = new Map();
  for (const m of matches) {
    const key = m.w.filepath + '|||' + m.w.name + '>>>' + bareOf(m.r.name);
    const prev = bestByPair.get(key);
    if (!prev || m.score > prev.score) bestByPair.set(key, m);
  }
  const dedupedMatches = [...bestByPair.values()].sort((a, b) => b.score - a.score);

  // Cap matches per work-function so one high-match work doesn't swamp output.
  // With ref-name collapsing above, this cap now controls how many DIFFERENT
  // ref functions a single work fn can show (not redundant source variants).
  const perWorkCap = 3;
  const capCount = new Map();
  const final = [];
  for (const m of dedupedMatches) {
    const key = m.w.filepath + '|||' + m.w.name;
    const c = capCount.get(key) || 0;
    if (c >= perWorkCap) continue;
    capCount.set(key, c + 1);
    final.push(m);
    if (final.length >= maxResults) break;
  }

  console.log(`\nFingerprint-similarity matches (top ${final.length}, min-score=${minScore}):\n`);
  for (const m of final) {
    const wShort = m.w.filepath.length > 60 ? '…' + m.w.filepath.slice(-59) : m.w.filepath;
    const rShort = m.r.filepath.length > 60 ? '…' + m.r.filepath.slice(-59) : m.r.filepath;
    // Show each side with its extract-ready spec (file@name) so the user can
    // copy-paste it directly into `--extract`. No quotes — Windows cmd.exe
    // doesn't strip single quotes, so 'foo@bar' would reach --extract with
    // the quotes still attached. Function names and the paths we emit here
    // don't contain shell-special chars; if they ever do, the user can
    // double-quote at call site.
    console.log(`  ${m.score.toFixed(3)}  [${m.w.source}] ${m.w.name}  (${m.w.lines}L @ ${wShort}:L${m.w.start})`);
    console.log(`              --extract ${m.w.filepath}@${m.w.name}`);
    console.log(`         <->  [${m.r.source}] ${m.r.name}  (${m.r.lines}L @ ${rShort}:L${m.r.start})`);
    console.log(`              --extract ${m.r.filepath}@${m.r.name}`);
    console.log(`              ${m.inter} shared tokens (of ${m.w.size} + ${m.r.size})`);
    if (showTokens) {
      const shared = [];
      for (const t of m.w.fingerprint) if (m.r.fingerprint.has(t)) shared.push(t);
      console.log(`              shared: ${shared.slice(0, 12).join(', ')}${shared.length > 12 ? ', …' : ''}`);
    }
    console.log();
  }
}
