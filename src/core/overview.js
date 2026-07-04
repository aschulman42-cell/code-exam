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
import { extractConcepts, conceptLabel } from './vocabulary.js';

const _ext = (fp) => path.extname(fp).toLowerCase() || '(none)';

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
 * Build the FAST half of the orientation summary — only signals that are
 * already in memory (file list, line counts, extension histogram, top-level
 * structure). No function-index build, no vocabulary, no call-graph: on a huge
 * index (.spinellis: 6.8M lines) these are the parts that return in well under
 * a second, so the GUI can orient the user immediately and stream the rest.
 * @param {import('./CodeSearchIndex.js').CodeSearchIndex} index
 */
export function buildOverviewFast(index) {
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

  const absence = [];
  if (isCollection) {
    const topN = topFolders.filter(f => f.folder !== '(root)').length;
    absence.push(`Looks like a COLLECTION — ${substantial.length} of ${topN} top-level folders are substantial (≥10% of files), not one codebase: ${substantial.slice(0, 4).map(f => f.folder).join(', ')}${substantial.length > 4 ? ', …' : ''}. Orient per-folder, not whole-tree.`);
  }

  return {
    source: index.indexSource || null,
    root,
    size: { files: files.length, functions: null, lines: stats.total_lines || 0, parse_method: stats.parse_method || 'regex' },
    languages,
    topFolders,
    isCollection,
    absence,
    partial: true, // deep signals (concepts/key files/entry points) not yet loaded
  };
}

/**
 * Build the DEEP half — the O(corpus) signals: function count, entry points
 * (forces the function-index + call-graph build), top vocabulary, organic
 * concepts, and vocabulary-density key files. Minutes on a very large index; the
 * GUI requests this separately so the fast half isn't held hostage to it.
 * @param {import('./CodeSearchIndex.js').CodeSearchIndex} index
 */
export function buildOverviewDeep(index) {
  // Resolve a line for an identifier in a file: the function-definition start
  // (via the function index), else the first whole-word textual occurrence in
  // the file. So GUI rows jump to where the identifier actually lives — consts /
  // schemas / module-level names (not in the function index) now land on their
  // first mention instead of the file top (#181 fix). Both lookups are cheap:
  // a name lookup and a single in-memory file scan; no corpus rescan.
  const lineOf = (name, fileHint) => {
    if (!name) return null;
    if (index.findFunctionMatches) {
      try { const s = index.findFunctionMatches(name, fileHint)[0]?.start; if (s) return s; } catch { /* fall through */ }
    }
    if (fileHint && index.fileLines && index.fileLines.has(fileHint)) {
      const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      const lines = index.fileLines.get(fileHint);
      for (let i = 0; i < lines.length; i++) { if (re.test(lines[i])) return i + 1; }
    }
    return null;
  };

  let entryPoints = [];
  try {
    const isJunkEP = (name) => !name || name.startsWith('"')
      || name.includes('node_modules') || name.includes('/') || name.includes('_KW_');
    const isTestEP = (name) => /^Test[A-Z_]/.test(name) || /^test_/.test(name);
    const seen = new Set();
    const eps = (index.getEntryPoints(40, 0, true) || [])
      .map(e => ({
        name: (index.getDisplayName ? index.getDisplayName(e.name) : e.name) || e.name,
        filepath: e.filepath,
        line: lineOf(e.name, e.filepath),
      }))
      .filter(e => !isJunkEP(e.name))
      .filter(e => { if (seen.has(e.name)) return false; seen.add(e.name); return true; }); // dedup same-name
    entryPoints = [...eps.filter(e => !isTestEP(e.name)), ...eps.filter(e => isTestEP(e.name))].slice(0, 8);
  } catch { /* no call graph */ }

  // Function count from the (now-ensured) function index.
  let functions = 0;
  try { for (const f of Object.values(index.functionIndex || {})) functions += Object.keys(f).length; } catch {}

  // Top identifiers, concept sub-terms, and key files — all from the cached vocab.
  let topVocab = [];
  let concepts = [];
  let keyFiles = [];
  try {
    const vocab = index.getTopVocabulary(200) || [];
    topVocab = vocab.slice(0, 15).map(v => v.token);

    // Concepts: salient CamelCase/snake sub-terms (worklist, multisect, …),
    // via the shared #193 extractor — sub-token cross-corpus IDF surfaces
    // corpus-distinctive roots and drops generics (function/index/build).
    // Reuse the vocab we just fetched (no second pass).
    concepts = extractConcepts(index, { entries: vocab, maxConcepts: 12 });
    // Resolve a line for each example identifier so GUI concept rows jump to the
    // definition (function examples); const/schema examples fall back to top.
    for (const c of concepts) { if (c.example && c.exampleFile) c.exampleLine = lineOf(c.example, c.exampleFile); }

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

  // Absence — deep "looks missing / off" checks (the collection check lives in
  // the fast half). buildOverview concatenates the two absence lists.
  const absence = [];
  if (functions === 0) {
    absence.push('No functions indexed — likely an extension/indexing gap (check the --build-index skip-tip for non-indexed source extensions).');
  } else if (entryPoints.length === 0) {
    absence.push('No entry points found — unusual for application code (a library, or call-graph gaps).');
  }

  // Peel prefix for the DISPLAYED lists (key files + entry points). Often tighter
  // than the whole-index root: a near-single-project collection whose top results
  // all live in one sub-zip still shares a prefix worth omitting once, even though
  // the whole index (with its minority sibling zips) shares no common root.
  const displayRoot = _commonRoot([...keyFiles.map(k => k.file), ...entryPoints.map(e => e.filepath)]);

  return {
    functions,
    displayRoot,
    topVocab,
    concepts,
    keyFiles,
    entryPoints,
    absence,
  };
}

/**
 * Full orientation summary (fast + deep merged). Used by the CLI `--overview`
 * and the MCP `overview` tool, which are one-shot and can afford the deep cost;
 * the GUI fetches the two halves separately for progressive rendering.
 * @param {import('./CodeSearchIndex.js').CodeSearchIndex} index
 */
export function buildOverview(index) {
  const fast = buildOverviewFast(index);
  const deep = buildOverviewDeep(index);
  return {
    ...fast,
    size: { ...fast.size, functions: deep.functions },
    displayRoot: deep.displayRoot,
    topVocab: deep.topVocab,
    concepts: deep.concepts,
    keyFiles: deep.keyFiles,
    entryPoints: deep.entryPoints,
    absence: [...deep.absence, ...fast.absence],
    partial: false,
  };
}

/** Render a buildOverview() result as a compact (~1 page) text summary. */
export function formatOverview(ov, { surface = 'cli' } = {}) {
  const L = [];
  const peelRoot = ov.displayRoot || ov.root;
  const strip = (p) => (peelRoot && p && p.startsWith(peelRoot)) ? p.slice(peelRoot.length) : p;
  L.push(`# Overview${ov.source ? ` — ${ov.source}` : ''}`);
  L.push('');
  L.push(`**Size:** ${ov.size.files} files, ${ov.size.functions} functions, `
    + `${(ov.size.lines || 0).toLocaleString()} lines (${ov.size.parse_method}).`);
  L.push(`**Languages:** ${ov.languages.slice(0, 8).map(l => `${l.ext} ${l.pct}%`).join(', ')}.`);
  if (peelRoot) L.push(`**Paths under:** \`${peelRoot}\` — omitted from the lists below.`);

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

  // Key concepts, each grounded in an example identifier. The raw "Top
  // identifiers" line is intentionally not shown (#181 polish): on SDK/generated
  // indexes it filled with boilerplate that mis-described the codebase; ov.topVocab
  // is still in the structured object for any consumer that wants the raw slice.
  if (ov.concepts && ov.concepts.length) {
    L.push('');
    L.push('**Key concepts (with examples):**');
    for (const c of ov.concepts) L.push(`  - ${conceptLabel(c)}`);
  }

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
  L.push('**Next:**');
  // #255: this text feeds two surfaces — the CLI (--overview) and the MCP
  // overview tool. Speak each consumer's own vocabulary: an MCP client has no
  // --flags, only tool names, so CLI hints there are dead ends (mirror image
  // of the b4cd8fd fix).
  if (surface === 'mcp') {
    L.push('  - `extract <name>` — print the source of a function by name. (The names in parentheses above, and under Entry points, are functions — pass one to extract or digest.)');
    L.push('  - `digest <file@function>` — a summary of a function or file');
    L.push('  - `vocabulary` (n: 50) — the full ranked terms');
    L.push('  - `list_files` (filter: <dir>) — explore a folder');
    L.push('  - `command_catalog` / `models_used` — probe what kinds of content this index holds');
  } else {
    L.push('  - `--extract <name>` — print the source of a function by name. (The names in parentheses above, and under Entry points, are functions — pass one to `--extract` or `--digest`.)');
    L.push('  - `--digest <file@function>` — a summary of a function or file');
    L.push('  - `--vocabulary 50` — the full ranked terms (add `--bare` for a plain copy-paste list)');
    L.push('  - `--files <dir>` — explore a folder');
    L.push('  - `--command-catalog` / `--models` / `--prompts` / `--exports` — probe what kinds of content this index holds');
  }
  return L.join('\n');
}
