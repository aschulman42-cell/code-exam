/**
 * overview.js — one-shot orientation summary built from already-cached signals
 * (#181). The front door of the orient → vocabulary → digest surface: answers
 * "what is this index, and where do I start?" in one call.
 *
 * FAST by contract: counts, cached vocabulary, top-level structure, a small
 * entry-point list. No corpus rescan and no detector scans (AI/ML, infra,
 * prompts, command-catalog, exports are *next-hops*, not computed here) — those
 * are O(corpus) and would break the "popup-fast" requirement for the future GUI
 * popup-on-load. `buildOverview` is the producer; the MCP `overview` tool, and
 * the future CLI `--overview` / GUI popup, all render from it.
 */
import path from 'path';
import { splitCompoundToken } from '../utils.js';

const _ext = (fp) => path.extname(fp).toLowerCase() || '(none)';

// Generic identifier parts that are glue, not domain concepts. Kept small and
// lowercase; the real domain roots (worklist, multisect, vocabulary, …) survive.
const _GENERIC_PARTS = new Set([
  'build', 'get', 'set', 'make', 'run', 'add', 'init', 'new', 'load', 'parse',
  'find', 'show', 'render', 'handle', 'create', 'update', 'fetch', 'to', 'from',
  'with', 'the', 'for', 'and', 'of', 'is', 'on', 'by', 'do', 'as', 'at', 'in',
  'out', 'val', 'obj', 'str', 'num', 'arr', 'len', 'idx', 'tmp', 'data', 'name',
]);

// First path segment, for the collection detector. Archive virtual paths look
// like `archive.zip!inner/path` — key off the inner path's first segment.
function _topSeg(fp) {
  const norm = String(fp).replace(/\\/g, '/');
  const inner = norm.includes('!') ? norm.slice(norm.indexOf('!') + 1) : norm;
  const segs = inner.split('/').filter(Boolean);
  return segs.length > 1 ? segs[0] : '(root)';
}

// Longest common DIRECTORY prefix across paths (segment-wise). A shared root
// like a zip wrapper (`foo.zip!foo-1.0/`) is stripped before structural analysis
// (so the collection detector sees the real sub-folders, not the single wrapper)
// and omitted from path displays. Returns '' when there's no shared directory.
function _commonRoot(paths) {
  if (paths.length < 2) return '';
  const dirSegs = (p) => String(p).replace(/\\/g, '/').split('/').slice(0, -1);
  let common = dirSegs(paths[0]);
  for (let i = 1; i < paths.length && common.length; i++) {
    const s = dirSegs(paths[i]);
    let k = 0;
    while (k < common.length && k < s.length && common[k] === s[k]) k++;
    common = common.slice(0, k);
  }
  return common.length ? common.join('/') + '/' : '';
}

/**
 * Build the orientation summary. Every optional signal is guarded so a partial
 * index (no vocab cache, no function index) still yields a useful overview.
 * @param {import('./CodeSearchIndex.js').CodeSearchIndex} index
 */
export function buildOverview(index) {
  const files = [...index.files.keys()];
  const totalFiles = files.length || 1;

  // Languages (extension histogram).
  const extCounts = new Map();
  for (const fp of files) { const e = _ext(fp); extCounts.set(e, (extCounts.get(e) || 0) + 1); }
  const languages = [...extCounts.entries()]
    .map(([ext, count]) => ({ ext, count, pct: Math.round(count / totalFiles * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);

  // Strip any shared root (e.g. a zip wrapper) BEFORE structural analysis, so the
  // collection detector sees the real sub-folders and displays can omit it.
  const root = _commonRoot(files);
  const stripRoot = (fp) => (root && fp.startsWith(root)) ? fp.slice(root.length) : fp;

  // Top-level folders → the collection detector (.spinellis / .sr_gh are really
  // N projects, not one). "Collection" = ≥3 top-level folders each ≥10% of files.
  const folderCounts = new Map();
  for (const fp of files) { const s = _topSeg(stripRoot(fp)); folderCounts.set(s, (folderCounts.get(s) || 0) + 1); }
  const topFolders = [...folderCounts.entries()]
    .map(([folder, count]) => ({ folder, count, pct: Math.round(count / totalFiles * 1000) / 10 }))
    .sort((a, b) => b.count - a.count);
  const substantial = topFolders.filter(f => f.folder !== '(root)' && f.pct >= 10);
  const isCollection = substantial.length >= 3;

  let stats = {};
  try { stats = index.getStats() || {}; } catch { /* partial index */ }

  // Entry points (noise-excluded, #187) — also forces the function index build.
  let entryPoints = [];
  try {
    const seen = new Set();
    entryPoints = (index.getEntryPoints(8, 0, true) || [])
      .map(e => ({
        name: (index.getDisplayName ? index.getDisplayName(e.name) : e.name) || e.name,
        filepath: e.filepath,
      }))
      .filter(e => { if (seen.has(e.name)) return false; seen.add(e.name); return true; }) // dedup same-name
      .slice(0, 8);
  } catch { /* no call graph */ }

  // Function count from the (now-ensured) function index.
  let functions = 0;
  try { for (const f of Object.values(index.functionIndex || {})) functions += Object.keys(f).length; } catch {}

  // Top identifiers, concept sub-terms, and key files — all from the cached vocab.
  let topVocab = [];
  let concepts = [];
  let keyFiles = [];
  try {
    const vocab = index.getTopVocabulary(40) || [];
    topVocab = vocab.slice(0, 15).map(v => v.token);

    // Concepts: salient sub-terms within CamelCase / snake_case identifiers, so
    // roots like "worklist"/"multisect" surface even when only ever seen inside
    // buildMultisectAnalyzePrompt etc. Scored by summed parent-token score.
    // (Same idea applies to user-facing Vocabulary — see the follow-up issue;
    // ideally this extraction unifies with vocabulary's sub-token logic.)
    const subScore = new Map();
    for (const v of vocab) {
      for (const part of splitCompoundToken(v.token)) {
        const p = part.toLowerCase();
        if (p.length < 3 || _GENERIC_PARTS.has(p)) continue;
        subScore.set(p, (subScore.get(p) || 0) + (v.score || 0));
      }
    }
    concepts = [...subScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p]) => p);

    // Key files: rank by BREADTH (distinct top terms that concentrate here),
    // tie-broken by summed score × concentration. Breadth surfaces files central
    // to many concepts; the old score×concentration sort over-rewarded small,
    // narrowly-concentrated files (e.g. ranked a 4-term file above a 17-term one).
    // KNOWN GAP (for #181 follow-up): very large central files can be absent
    // because vocab `top_files` is concentration-capped — surfacing them needs a
    // call-centrality blend; and for collections, key files should be per-project.
    const fileScore = new Map();
    const fileTerms = new Map();
    for (const v of vocab) {
      for (const tf of (v.top_files || [])) {
        const file = String(tf.path).split('|||')[0]; // fold per-function doc-ids
        fileScore.set(file, (fileScore.get(file) || 0) + (v.score || 0) * (tf.concentration || 0));
        if (!fileTerms.has(file)) fileTerms.set(file, new Set());
        fileTerms.get(file).add(v.token);
      }
    }
    keyFiles = [...fileTerms.entries()]
      .map(([file, terms]) => ({ file, terms: terms.size, score: fileScore.get(file) || 0 }))
      .sort((a, b) => b.terms - a.terms || b.score - a.score)
      .slice(0, 8)
      .map(({ file, terms }) => ({ file, terms }));
  } catch { /* no vocab cache */ }

  // Absence — a few high-signal "looks missing / off" checks.
  const absence = [];
  if (functions === 0) {
    absence.push('No functions indexed — likely an extension/indexing gap (check the --build-index skip-tip for non-indexed source extensions).');
  } else if (entryPoints.length === 0) {
    absence.push('No entry points found — unusual for application code (a library, or call-graph gaps).');
  }
  if (isCollection) {
    absence.push(`Looks like a COLLECTION of ${substantial.length} distinct top-level projects, not one codebase (${substantial.slice(0, 4).map(f => f.folder).join(', ')}${substantial.length > 4 ? ', …' : ''}). Orient per-folder, not whole-tree.`);
  }

  return {
    source: index.indexSource || null,
    root,
    size: { files: files.length, functions, lines: stats.total_lines || 0, parse_method: stats.parse_method || 'regex' },
    languages,
    topFolders,
    isCollection,
    topVocab,
    concepts,
    keyFiles,
    entryPoints,
    absence,
  };
}

/** Render a buildOverview() result as a compact (~1 page) text summary. */
export function formatOverview(ov) {
  const L = [];
  const strip = (p) => (ov.root && p && p.startsWith(ov.root)) ? p.slice(ov.root.length) : p;
  L.push(`# Overview${ov.source ? ` — ${ov.source}` : ''}`);
  L.push('');
  L.push(`**Size:** ${ov.size.files} files, ${ov.size.functions} functions, `
    + `${(ov.size.lines || 0).toLocaleString()} lines (${ov.size.parse_method}).`);
  L.push(`**Languages:** ${ov.languages.slice(0, 8).map(l => `${l.ext} ${l.pct}%`).join(', ')}.`);
  if (ov.root) L.push(`**Paths under:** \`${ov.root}\` — omitted from the lists below.`);

  if (ov.isCollection) {
    L.push('');
    L.push('**⚠ Looks like a collection, not one project** — top-level folders:');
    for (const f of ov.topFolders.slice(0, 8)) {
      if (f.folder !== '(root)') L.push(`  - ${f.folder}/  (${f.count} files, ${f.pct}%)`);
    }
  } else {
    const folders = ov.topFolders.filter(f => f.folder !== '(root)').slice(0, 6)
      .map(f => `${f.folder}/ (${f.count})`).join(', ');
    if (folders) L.push(`**Top-level:** ${folders}.`);
  }

  if (ov.concepts && ov.concepts.length) { L.push(''); L.push(`**Key concepts:** ${ov.concepts.join(', ')}.`); }
  if (ov.topVocab.length) { L.push(''); L.push(`**Top identifiers:** ${ov.topVocab.join(', ')}.`); }

  if (ov.keyFiles.length) {
    L.push('');
    L.push('**Key files (by vocabulary density):**');
    for (const kf of ov.keyFiles) L.push(`  - ${strip(kf.file)}  (${kf.terms} top terms)`);
  }

  if (ov.entryPoints.length) {
    L.push('');
    L.push('**Entry points:**');
    for (const e of ov.entryPoints) L.push(`  - ${e.name}  (${strip(e.filepath)})`);
  }

  if (ov.absence.length) {
    L.push('');
    L.push('**Watch:**');
    for (const a of ov.absence) L.push(`  - ⚠ ${a}`);
  }

  L.push('');
  L.push('**Next:** run `vocabulary` for the full ranked terms (CLI: `--vocabulary 50`, or '
    + '`--vocabulary 50 --bare` for a plain copy-paste list) · `digest <file@function>` on a '
    + 'key file or entry point above · `list_files <dir>` to explore a folder · '
    + '`command_catalog` / `list_models` / `prompts` / `exports` to probe what kinds of '
    + 'content this index holds.');
  return L.join('\n');
}
