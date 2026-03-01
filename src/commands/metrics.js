/**
 * metrics.js - Discovery/metrics commands: hotspots, hot-folders,
 * entry-points, domain-fns, gaps, list-classes, class-hotspots.
 * Port of ce_metrics.py
 */

import path from 'path';
import { eprint } from '../utils.js';


// ========================================================================
// Shared helpers
// ========================================================================

const SKIP_KEYWORDS = new Set([
  'if', 'while', 'for', 'switch', 'catch', 'return', 'sizeof',
  'typeof', 'defined', 'else', 'elif', 'except', 'finally',
  'void', 'int', 'char', 'short', 'long', 'float', 'double',
  'unsigned', 'signed', 'bool', 'auto', 'register', 'extern',
  'static', 'const', 'volatile', 'inline', 'virtual',
  'byte', 'boolean', 'String',
  'Copyright', 'copyright', 'param', 'author',
]);

function bareName(name) {
  let b = name.includes('::') ? name.split('::').pop() : name;
  if (b.includes('@')) b = b.split('@')[0];
  return b;
}

function shortPath(fp, maxLen = 42) {
  return fp.length <= maxLen ? fp : '...' + fp.slice(-(maxLen - 3));
}

function applyPathFilters(items, args, fpKey = 'filepath') {
  let result = items;
  // --in universal path filter
  if (args.vocab_in) {
    const pat = args.vocab_in.toLowerCase();
    result = result.filter(h => h[fpKey].toLowerCase().includes(pat));
  }
  if (args.include_path) {
    result = result.filter(h =>
      args.include_path.some(p => h[fpKey].toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_path) {
    result = result.filter(h =>
      !args.exclude_path.some(p => h[fpKey].toLowerCase().includes(p.toLowerCase())));
  }
  if (args.exclude_tests) {
    result = result.filter(h => !h[fpKey].toLowerCase().includes('test'));
  }
  return result;
}


// ========================================================================
// Hotspots
// ========================================================================

export function doHotspots(index, args) {
  const n = args.hotspots;
  const hotspots = index.getHotspots(n * 3, true);

  if (!hotspots.length) {
    console.log('No hotspots found (need both function index and inverted index).');
    return;
  }

  let filtered = [];
  for (const h of hotspots) {
    const bare = bareName(h.name);
    if (bare.length < 2) continue;
    if (SKIP_KEYWORDS.has(bare)) continue;
    if (/^[A-Z][A-Z0-9_]+$/.test(bare) && bare.length >= 2) continue; // ALL_CAPS macros
    if (args.filter && !h.display_name.toLowerCase().includes(args.filter.toLowerCase()) &&
        !h.filepath.toLowerCase().includes(args.filter.toLowerCase())) continue;
    filtered.push(h);
  }

  filtered = applyPathFilters(filtered, args);

  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} hotspots (big functions x high call frequency):`);
  console.log(`  Score = calls x log2(lines)`);
  console.log(`  ${'Score'.padStart(8)}  ${'Calls'.padStart(6)}  ${'Lines'.padStart(6)}  ${'Function'.padEnd(40)}  File`);
  console.log(`  ${'-'.repeat(110)}`);

  for (const h of filtered.slice(0, n)) {
    let fp = args.full_path ? h.filepath : shortPath(h.filepath);
    let dn = h.display_name;
    if (h.copies > 0) dn = `${dn} (+${h.copies})`;
    console.log(`  ${h.score.toFixed(0).padStart(8)}  ${String(h.calls).padStart(6)}  ${String(h.lines).padStart(6)}  ${dn.padEnd(40)}  ${fp}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} hotspots. Use --hotspots ${n * 2} for more.`);
  }
}


// ========================================================================
// Hot Folders
// ========================================================================

export function doHotFolders(index, args) {
  const n = args.hot_folders;
  const hotspots = index.getHotspots(50000, true);

  if (!hotspots.length) {
    console.log('No hotspots found.');
    return;
  }

  // Aggregate by directory at multiple levels
  const maxDepth = args.depth || null;  // --depth N limits folder nesting
  const folderStats = {};
  for (const h of hotspots) {
    const fp = h.filepath.replace(/\\/g, '/');
    const parts = fp.split('/');
    const limit = maxDepth ? Math.min(parts.length, maxDepth + 1) : parts.length;
    for (let i = 1; i < limit; i++) {
      const folder = parts.slice(0, i).join('/');
      if (!folderStats[folder]) {
        folderStats[folder] = { score: 0, funcs: 0, files: new Set(), top_func: null, top_score: 0 };
      }
      const s = folderStats[folder];
      s.score += h.score;
      s.funcs++;
      s.files.add(fp);
      if (h.score > s.top_score) {
        s.top_score = h.score;
        s.top_func = h.display_name || h.name;
      }
    }
  }

  // Sort and filter redundant subsets
  const sorted = Object.entries(folderStats).sort((a, b) => b[1].score - a[1].score);
  const shownFolders = new Set();
  let filtered = [];

  for (const [folder, stats] of sorted) {
    const parts = folder.split('/');
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
    if (parent && shownFolders.has(parent)) {
      const ps = folderStats[parent];
      if (ps && Math.abs(ps.score - stats.score) < 1) continue;
    }
    filtered.push([folder, stats]);
    shownFolders.add(folder);
  }

  if (args.filter) {
    filtered = filtered.filter(([f]) => f.toLowerCase().includes(args.filter.toLowerCase()));
  }

  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} hot folders (by aggregated hotspot score):`);
  console.log(`  ${'Score'.padStart(10)}  ${'Funcs'.padStart(6)}  ${'Files'.padStart(6)}  ${'Top Function'.padEnd(35)}  Folder`);
  console.log(`  ${'-'.repeat(120)}`);

  for (let i = 0; i < shown; i++) {
    const [folder, stats] = filtered[i];
    let top = stats.top_func || '';
    if (top.length > 34) top = top.slice(0, 31) + '...';
    console.log(`  ${stats.score.toFixed(0).padStart(10)}  ${String(stats.funcs).padStart(6)}  ${String(stats.files.size).padStart(6)}  ${top.padEnd(35)}  ${folder}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} folders. Use --hot-folders ${n * 2} for more.`);
  }
}


// ========================================================================
// Entry Points
// ========================================================================

const ENTRY_POINT_PATTERNS = new Set([
  'handle', 'render', 'componentdid', 'componentwill', 'useeffect',
  'oncreate', 'ondestroy', 'onmount', 'onsubmit', 'onchange', 'onclick',
  'onkeydown', 'onkeyup', 'onscroll', 'onresize', 'onfocus', 'onblur',
  'describe', 'test', 'it', 'before', 'after', 'setup', 'teardown',
  'beforeeach', 'aftereach', 'beforeall', 'afterall',
  'main', 'init', 'initialize', 'configure', 'startup', 'shutdown',
  'bootstrap', 'register', 'mount', 'unmount',
  'middleware', 'authenticate', 'authorize', 'validate',
  'exports', 'default', 'module', 'constructor',
]);

const ENTRY_POINT_PREFIXES = [
  'handle', 'on', 'get', 'set', 'is', 'has', 'can', 'should',
  'use', 'test', 'spec',
];

function looksLikeEntryPoint(name, filepath) {
  const bare = bareName(name);
  const bl = bare.toLowerCase();
  const fpl = filepath.toLowerCase();

  if (fpl.includes('test') || fpl.includes('spec') || fpl.includes('__test')) return true;
  if (ENTRY_POINT_PATTERNS.has(bl)) return true;
  for (const prefix of ENTRY_POINT_PREFIXES) {
    if (bl.startsWith(prefix) && bl.length > prefix.length) return true;
  }
  const ext = path.extname(filepath).toLowerCase();
  if ((ext === '.tsx' || ext === '.jsx') && /^[A-Z]/.test(bare) && !/^[A-Z]+$/.test(bare)) return true;

  return false;
}


export function doEntryPoints(index, args) {
  const n = args.entry_points;
  const maxCalls = args.max_calls != null ? args.max_calls : 0;
  const entries = index.getEntryPoints(n * 3, maxCalls, true);

  if (!entries.length) {
    console.log('No entry points found.');
    return;
  }

  let filtered = [];
  for (const e of entries) {
    const bare = bareName(e.name);
    if (bare.length < 2 || SKIP_KEYWORDS.has(bare)) continue;
    if (args.filter && !e.name.toLowerCase().includes(args.filter.toLowerCase())) continue;
    filtered.push(e);
  }
  filtered = applyPathFilters(filtered, args);

  const callDesc = maxCalls === 0 ? 'never called' : `called <=${maxCalls} times`;
  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} entry points (${callDesc}, sorted by size):`);
  console.log(`  ${'Lines'.padStart(6)}  ${'Calls'.padStart(6)}  ${'Function'.padEnd(45)}  File`);
  console.log(`  ${'-'.repeat(115)}`);

  for (const e of filtered.slice(0, n)) {
    let dn = e.display_name;
    if (e.copies > 0) dn = `${dn} (+${e.copies})`;
    if (dn.length > 44) dn = dn.slice(0, 41) + '...';
    const fp = shortPath(e.filepath, 45);
    console.log(`  ${String(e.lines).padStart(6)}  ${String(e.calls).padStart(6)}  ${dn.padEnd(45)}  ${fp}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} entry points. Use --entry-points ${n * 2} for more.`);
  }

  console.log('\n  See also: --gaps (suspicious dead code), --call-inventory (external dependencies)');
}


// ========================================================================
// Gaps (dead code candidates)
// ========================================================================

export function doGaps(index, args) {
  const n = args.gaps || 25;
  const entries = index.getEntryPoints(999, 0, true);

  if (!entries.length) {
    console.log('No gaps found - all functions have callers.');
    return;
  }

  const skipKw = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'return', 'sizeof',
    'typeof', 'void', 'int', 'char', 'Copyright', 'copyright',
  ]);

  let suspicious = [];
  for (const e of entries) {
    const bare = bareName(e.name);
    if (bare.length < 2 || skipKw.has(bare)) continue;
    if (e.type === 'class') continue;
    if (looksLikeEntryPoint(e.name, e.filepath)) continue;
    suspicious.push(e);
  }
  suspicious = applyPathFilters(suspicious, args);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`  CODE GAPS: ${suspicious.length} suspicious unreachable functions`);
  console.log(`  (defined but never called, and not a recognized entry-point pattern)`);
  console.log(`${'='.repeat(80)}`);

  console.log(`\n  ${'Lines'.padStart(6)}  ${'Function'.padEnd(50)}  File`);
  console.log(`  ${'-'.repeat(110)}`);

  let shown = 0;
  for (const s of suspicious) {
    if (shown >= n) break;
    let dn = s.display_name || s.name;
    if (dn.length > 49) dn = dn.slice(0, 46) + '...';
    let fp = shortPath(s.filepath, 50);

    const servicePatterns = ['service', 'controller', 'handler', 'manager'];
    const flag = servicePatterns.some(p => s.filepath.toLowerCase().includes(p))
      ? '  [SERVICE - no caller?]' : '';

    console.log(`  ${String(s.lines).padStart(6)}  ${dn.padEnd(50)}  ${fp}${flag}`);
    shown++;
  }

  if (suspicious.length > n) {
    console.log(`\n  Showing ${n} of ${suspicious.length} gaps. Use --gaps ${n * 2} for more.`);
  }

  const serviceGaps = suspicious.filter(s =>
    ['service', 'controller'].some(p => s.filepath.toLowerCase().includes(p)));
  if (serviceGaps.length > 0) {
    console.log(`\n  WARNING: ${serviceGaps.length} gap(s) in Service/Controller files - may indicate missing route handlers:`);
    for (const sg of serviceGaps.slice(0, 10)) {
      console.log(`      ${sg.name}  (${sg.filepath})`);
    }
  }

  console.log('\n  See also: --call-inventory (external dependencies not in the index)');
  console.log('           --entry-points (largest uncalled functions)');
}


// ========================================================================
// Domain Functions
// ========================================================================

export function doDomainFns(index, args) {
  const n = args.domain_fns;
  const domain = index.getDomainHotspots(n * 3, true);

  if (!domain.length) {
    console.log('No domain functions found.');
    return;
  }

  const skipKw = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'return', 'sizeof',
    'typeof', 'void', 'int', 'char', 'Copyright', 'copyright',
  ]);

  let filtered = [];
  for (const d of domain) {
    const bare = bareName(d.name);
    if (bare.length < 2 || skipKw.has(bare)) continue;
    if (args.filter && !d.name.toLowerCase().includes(args.filter.toLowerCase())) continue;
    filtered.push(d);
  }
  filtered = applyPathFilters(filtered, args);

  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} domain-specific functions (score = calls x log2(lines) / sqrt(name_defs)):`);
  console.log(`  ${'Score'.padStart(8)}  ${'Calls'.padStart(6)}  ${'Lines'.padStart(6)}  ${'Defs'.padStart(5)}  ${'Function'.padEnd(40)}  File`);
  console.log(`  ${'-'.repeat(120)}`);

  for (const d of filtered.slice(0, n)) {
    let dn = d.display_name || d.name;
    if (d.copies > 0) dn = `${dn} (+${d.copies})`;
    if (dn.length > 39) dn = dn.slice(0, 36) + '...';
    const fp = shortPath(d.filepath, 45);
    console.log(`  ${d.score.toFixed(0).padStart(8)}  ${String(d.calls).padStart(6)}  ${String(d.lines).padStart(6)}  ${String(d.name_count).padStart(5)}  ${dn.padEnd(40)}  ${fp}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} domain functions. Use --domain-fns ${n * 2} for more.`);
  }
}


// ========================================================================
// List Classes
// ========================================================================

export function doListClasses(index, args) {
  let classes = index.listClasses();

  classes = applyPathFilters(classes, args);

  if (args.filter) {
    const fl = args.filter.toLowerCase();
    classes = classes.filter(c => c.name.toLowerCase().includes(fl));
  }

  if (!classes.length) {
    console.log('No classes found.');
    return;
  }

  classes.sort((a, b) => (b.total_method_lines || b.lines) - (a.total_method_lines || a.lines));

  // Hide classes with 0 methods and 0 lines unless verbose
  let hiddenCount = 0;
  if (!args.verbose) {
    const before = classes.length;
    classes = classes.filter(c => c.method_count > 0 || (c.total_method_lines || 0) > 0);
    hiddenCount = before - classes.length;
  }

  // Check for inferred and cross-file classes
  let hasCrossFile = false;
  let hasInferred = false;
  for (const c of classes) {
    if (c.inferred) hasInferred = true;
    const implFiles = new Set();
    for (const m of c.methods) {
      if (m.filepath && m.filepath !== c.filepath) implFiles.add(m.filepath);
    }
    c.impl_files = [...implFiles].sort();
    if (implFiles.size > 0) hasCrossFile = true;
  }

  console.log(`\n${classes.length} classes${hiddenCount ? ` (${hiddenCount} with 0 methods hidden; use -v to show all)` : ''}:\n`);

  if (args.verbose && hasCrossFile) {
    console.log(`${'Methods'.padStart(8)}  ${'MethLines'.padStart(10)}  ${'Class'.padEnd(35)}  ${'Declaration'.padEnd(40)}  Implementation`);
    console.log('='.repeat(140));

    for (const c of classes) {
      const inferMark = c.inferred ? '*' : ' ';
      const name = c.name.slice(0, 33);
      let decl = c.inferred ? '(inferred from ::)' : c.filepath;
      if (decl.length > 39) decl = '...' + decl.slice(-36);

      if (c.impl_files.length > 0) {
        let impl = c.impl_files[0];
        if (impl.length > 45) impl = '...' + impl.slice(-42);
        console.log(`${String(c.method_count).padStart(8)}  ${String(c.total_method_lines).padStart(10)} ${inferMark}${name.padEnd(35)}  ${decl.padEnd(40)}  ${impl}`);
        for (const implF of c.impl_files.slice(1)) {
          let imp = implF.length > 45 ? '...' + implF.slice(-42) : implF;
          console.log(`${''.padStart(8)}  ${''.padStart(10)}  ${''.padEnd(35)}  ${''.padEnd(40)}  ${imp}`);
        }
      } else {
        console.log(`${String(c.method_count).padStart(8)}  ${String(c.total_method_lines).padStart(10)} ${inferMark}${name.padEnd(35)}  ${decl.padEnd(40)}  (same file)`);
      }
    }

    if (hasInferred) {
      console.log(`\n  * = class inferred from ClassName:: in method names (no class declaration found)`);
    }
    if (hasCrossFile) {
      console.log(`\nTip: Use --verbose to see .h/.cpp cross-file method associations`);
    }
  } else {
    console.log(`${'Methods'.padStart(8)}  ${'MethLines'.padStart(10)}  ${'Class'.padEnd(40)}  ${'File'.padEnd(50)}`);
    console.log('='.repeat(115));

    for (const c of classes) {
      const inferMark = c.inferred ? '*' : ' ';
      const name = c.name.slice(0, 38);
      const fp = c.inferred ? '(inferred from ::)' : c.filepath.slice(0, 49);
      console.log(`${String(c.method_count).padStart(8)}  ${String(c.total_method_lines).padStart(10)} ${inferMark}${name.padEnd(40)}  ${fp.padEnd(50)}`);
    }

    if (hasInferred) {
      console.log(`\n  * = class inferred from ClassName:: in method names (no class declaration found)`);
    }
    if (hasCrossFile) {
      console.log(`\nTip: Use --verbose to see .h/.cpp cross-file method associations`);
    }
  }
}


// ========================================================================
// Class Hotspots
// ========================================================================

export function doClassHotspots(index, args) {
  const n = args.class_hotspots;
  const classes = index.getClassHotspots(n * 3, true);

  if (!classes.length) {
    console.log('No classes found.');
    return;
  }

  let filtered = [];
  for (const c of classes) {
    if (args.filter && !c.name.toLowerCase().includes(args.filter.toLowerCase())) continue;
    filtered.push(c);
  }
  filtered = applyPathFilters(filtered, args);

  const shown = Math.min(n, filtered.length);
  console.log(`\nTop ${shown} class hotspots (aggregated method calls x log2(method lines) / sqrt(defs)):`);
  console.log(`  ${'Score'.padStart(8)}  ${'Calls'.padStart(7)}  ${'Methods'.padStart(8)}  ${'MethLns'.padStart(8)}  ${'Defs'.padStart(5)}  ${'Class'.padEnd(35)}  File`);
  console.log(`  ${'-'.repeat(120)}`);

  for (const c of filtered.slice(0, n)) {
    let name = c.name;
    if (name.length > 34) name = name.slice(0, 31) + '...';
    let fp = args.full_path ? c.filepath : shortPath(c.filepath, 45);
    console.log(`  ${c.score.toFixed(0).padStart(8)}  ${String(c.total_calls).padStart(7)}  ${String(c.method_count).padStart(8)}  ${String(c.total_method_lines).padStart(8)}  ${String(c.name_count).padStart(5)}  ${name.padEnd(35)}  ${fp}`);
  }

  if (filtered.length > n) {
    console.log(`\n  Showing ${n} of ${filtered.length} classes. Use --class-hotspots ${n * 2} for more.`);
  }
}


// ========================================================================
// --discover-vocabulary / /vocabulary
// ========================================================================

export function doVocabulary(index, args) {
  const n = args.discover_vocabulary || 50;
  const filter = args.filter || null;
  const pathFilter = args.vocab_in || null;

  const topTokens = index.getTopVocabulary(n, filter, pathFilter);

  if (!topTokens.length) {
    console.log(pathFilter
      ? `No vocabulary tokens found in files matching '${pathFilter}'.`
      : 'No vocabulary tokens found.');
    return;
  }

  // For header stats, use the filtered or global vocab
  const vocab = pathFilter
    ? index.ensureVocabulary(false, pathFilter)
    : index.ensureVocabulary(false);
  const totalTokens = vocab.size;

  // Count matching files for header
  let fileCount;
  if (pathFilter) {
    const pat = pathFilter.toLowerCase();
    fileCount = [...index.files.keys()].filter(fp => fp.toLowerCase().includes(pat)).length;
  } else {
    fileCount = index.files.size;
  }

  const inLabel = pathFilter ? ` in '${pathFilter}' (${fileCount} files)` : '';
  console.log(`\nTop ${Math.min(n, topTokens.length)} domain vocabulary` +
    (filter ? ` matching '${filter}'` : '') +
    inLabel +
    ` (${totalTokens.toLocaleString()} unique tokens` +
    (!pathFilter ? `, ${fileCount.toLocaleString()} files` : '') + `):\n`);

  // Header
  console.log(`  ${'Score'.padStart(7)}  ${'Files'.padStart(5)}  ${'Hits'.padStart(6)}  ${'Token'.padEnd(35)}  Representative files`);
  console.log(`  ${'-'.repeat(110)}`);

  for (const entry of topTokens) {
    const scoreStr = entry.score.toFixed(0).padStart(7);
    const dfStr = String(entry.doc_freq).padStart(5);
    const tcStr = String(entry.total_count).padStart(6);
    const tokenStr = entry.token.padEnd(35);

    // Show top 2-3 representative files, abbreviated
    const repFiles = (entry.top_files || []).slice(0, 3)
      .map(f => {
        const p = args.full_path ? f.path : shortPath(f.path, 40);
        return `${p} (${f.count})`;
      })
      .join(', ');

    console.log(`  ${scoreStr}  ${dfStr}  ${tcStr}  ${tokenStr}  ${repFiles}`);
    console.log();
  }

  if (topTokens.length >= n) {
    console.log(`  Showing ${n}. Use --discover-vocabulary ${n * 2} for more.`);
  }
}
