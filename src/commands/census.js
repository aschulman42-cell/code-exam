/**
 * census.js — --census-imports (#156): ranked de facto API map for a corpus.
 *
 * Aggregates Python imports into one ranked table — rank / indexes / count /
 * import target — ranked by distinct-index count (tiebreak: raw occurrences).
 * A library's most-imported names are its real public surface as the corpus
 * actually uses it: corpus orientation on its own, and the empirical
 * counterpart to the declared `--exports` view (#153) and the pairwise
 * import<->export join (#154).
 *
 * Two modes:
 *   --multi-index list.lst --census-imports   corpus-wide. This is a
 *     REDUCTION, which the subprocess-concat fan-out can't express, so
 *     index.js diverts here for an in-process sequential loop (load ->
 *     extract -> drop reference -> next; per-index try/catch keeps one bad
 *     index from aborting the run).
 *   --index-path .foo --census-imports        single index. The indexes
 *     column is omitted; -v shows example sites instead of per-index counts.
 */

import { CodeSearchIndex } from '../core/CodeSearchIndex.js';
import { extractImports } from '../core/imports.js';
import { makeFilterMatcher } from '../core/filter-match.js';

const CAP = 50;          // ranked-table rows shown (disclosed when exceeded)
const ROLLUP_CAP = 15;   // top-level-module rollup rows
const SITES_PER_TARGET = 3;  // -v example sites in single-index mode

/**
 * Reduce per-index rows to ranked entries:
 * { target, occ, byIndex: Map(indexName -> count), sites: [file:line, ...] }
 */
function aggregate(perIndex) {
  const agg = new Map();
  for (const [idxName, rows] of perIndex) {
    for (const r of rows) {
      let e = agg.get(r.target);
      if (!e) {
        e = { target: r.target, occ: 0, byIndex: new Map(), sites: [] };
        agg.set(r.target, e);
      }
      e.occ++;
      e.byIndex.set(idxName, (e.byIndex.get(idxName) || 0) + 1);
      if (e.sites.length < SITES_PER_TARGET) e.sites.push(`${r.file}:${r.line}`);
    }
  }
  return [...agg.values()].sort((a, b) =>
    b.byIndex.size - a.byIndex.size || b.occ - a.occ || a.target.localeCompare(b.target));
}

/** Top-level-module rollup: everything under `torch.*` aggregated to `torch`. */
function rollup(entries) {
  const roots = new Map();
  for (const e of entries) {
    const root = e.target.split('.')[0];
    let t = roots.get(root);
    if (!t) { t = { root, occ: 0, idxs: new Set() }; roots.set(root, t); }
    t.occ += e.occ;
    for (const n of e.byIndex.keys()) t.idxs.add(n);
  }
  return [...roots.values()].sort((a, b) =>
    b.idxs.size - a.idxs.size || b.occ - a.occ || a.root.localeCompare(b.root));
}

function render(entries, { multi, nIndexes, pyFiles, args }) {
  const totalSites = entries.reduce((s, e) => s + e.occ, 0);
  const filterNote = args.filter ? ` — filter: '${args.filter}'` : '';
  if (multi) {
    console.log(`Import census — ${nIndexes} indexes, ${totalSites} import sites, ` +
                `${entries.length} distinct targets (Python)${filterNote}\n`);
  } else {
    console.log(`Import census — ${totalSites} import sites, ${entries.length} distinct ` +
                `targets across ${pyFiles} Python files${filterNote}\n`);
  }
  if (entries.length === 0) {
    if (args.filter) {
      console.log(`  No import targets match --filter '${args.filter}'.`);
    } else {
      console.log('  No Python imports found. Python is the only language the census');
      console.log('  extracts today — JS/TS and other languages are #154.');
    }
    return;
  }

  // Fixed default cap; an explicit --max-results overrides it (the parsed
  // default of 20 is for search hits — too low for a census, so only an
  // explicit flag counts).
  const cap = args._explicit && args._explicit.has('max_results') ? args.max_results : CAP;
  const shown = entries.slice(0, cap);
  if (multi) {
    console.log('rank  indexes  count  import');
    shown.forEach((e, i) => {
      console.log(`${String(i + 1).padStart(4)}  ${String(e.byIndex.size).padStart(7)}  ` +
                  `${String(e.occ).padStart(5)}  ${e.target}`);
      if (args.verbose) {
        const parts = [...e.byIndex.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${n}(${c})`);
        // Wrap the per-index breakdown: at corpus scale (50+ indexes) a
        // single joined line runs hundreds of characters and is unreadable.
        const indent = ' '.repeat(21);
        let line = indent;
        for (const part of parts) {
          if (line.length > indent.length && line.length + 1 + part.length > 100) {
            console.log(line);
            line = indent;
          }
          line += (line.length > indent.length ? ' ' : '') + part;
        }
        if (line.length > indent.length) console.log(line);
      }
    });
  } else {
    console.log('rank  count  import');
    shown.forEach((e, i) => {
      console.log(`${String(i + 1).padStart(4)}  ${String(e.occ).padStart(5)}  ${e.target}`);
      if (args.verbose && e.sites.length) {
        console.log(`${' '.repeat(12)}e.g. ${e.sites.join(', ')}`);
      }
    });
  }
  if (entries.length > cap) {
    console.log(`\n  (showing ${cap} of ${entries.length} targets — raise with --max-results N, ` +
                `or narrow with --filter <module>)`);
  }

  // Corpus-orientation rollup. Skipped under --filter: a rollup of a
  // filtered subtree just restates the table.
  if (!args.filter) {
    const roots = rollup(entries);
    if (roots.length > 1) {
      console.log('\nTop-level modules (everything under each root, aggregated):');
      for (const t of roots.slice(0, ROLLUP_CAP)) {
        const idxCol = multi ? `${String(t.idxs.size).padStart(4)} index(es)  ` : '';
        console.log(`  ${t.root.padEnd(24)} ${idxCol}${String(t.occ).padStart(6)} sites`);
      }
      if (roots.length > ROLLUP_CAP) {
        console.log(`  ... and ${roots.length - ROLLUP_CAP} more top-level modules`);
      }
    }
  }

  console.log(`\n  Tip: --census-imports --filter <module> -v drills into one subtree` +
              (multi ? ' with per-index counts.' : ' with example sites.'));
}

/** Single-index mode (normal dispatch path: --index-path .foo --census-imports). */
export function doCensusImports(index, args) {
  const { rows, pyFiles } = extractImports(index);
  const match = makeFilterMatcher(args.filter);
  const entries = aggregate(new Map([[index.indexPath, rows]]))
    .filter(e => match(e.target));
  render(entries, { multi: false, nIndexes: 1, pyFiles, args });
}

/**
 * Corpus-wide mode, called from index.js's --multi-index divert.
 * Returns the failure count (index.js turns it into the exit code).
 */
export function doCensusImportsMulti(indexPaths, args) {
  const perIndex = new Map();
  let failures = 0;
  let pyFilesTotal = 0;
  for (let i = 0; i < indexPaths.length; i++) {
    const p = indexPaths[i];
    process.stderr.write(`[multi-index] (${i + 1}/${indexPaths.length}) ${p}\n`);
    try {
      const idx = new CodeSearchIndex({ indexPath: p });
      if (idx.files.size === 0) {
        failures++;
        process.stderr.write(`[multi-index] '${p}' has no loadable index — skipped\n`);
        continue;
      }
      const { rows, pyFiles } = extractImports(idx);
      pyFilesTotal += pyFiles;
      if (rows.length === 0) {
        process.stderr.write(`[multi-index] note: no Python imports in '${p}' — ` +
                             `other-language extraction is #154\n`);
      }
      perIndex.set(p, rows);
    } catch (err) {
      failures++;
      process.stderr.write(`[multi-index] '${p}' failed: ${err.message}\n`);
    }
    // The loaded index goes out of scope here; sequential loading keeps
    // peak memory at one index, the concern that motivated subprocess
    // isolation for the fan-out path.
  }

  const match = makeFilterMatcher(args.filter);
  const entries = aggregate(perIndex).filter(e => match(e.target));
  render(entries, { multi: true, nIndexes: perIndex.size, pyFiles: pyFilesTotal, args });
  process.stderr.write(`[multi-index] census across ${perIndex.size} index(es)` +
                       `${failures ? `, ${failures} failed/skipped` : ''}\n`);
  return failures;
}
