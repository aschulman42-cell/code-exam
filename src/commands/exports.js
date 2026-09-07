// exports.js — --exports: tier-marked, definition-resolved export catalog per package; --emit-catalog writes it as JSON
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * exports.js (command) — --exports [pkg-or-path] (#153): tier-marked,
 * definition-resolved export catalog. Rendering over the language-neutral
 * records assembled by src/core/exports.js.
 *
 * Unscoped: per-package summary (tier counts + A/B delta + notes).
 * Scoped (`--exports decomposition`) or -v: the actual name rows, each
 * resolved to its definition site. Scope matching is SEGMENT-aware:
 * `decomposition` must not match `cross_decomposition` — that substring
 * spillover is the #153 motivating failure of the old --classes workaround.
 */

import fs from 'fs';
import { extractExports } from '../core/exports.js';
import { extractImports } from '../core/imports.js';
import { makeFilterMatcher } from '../core/filter-match.js';
import { CodeSearchIndex } from '../core/CodeSearchIndex.js';
import { buildCatalogEntry, mergeCatalog, annotateUsedBy, buildJoinContext, CATALOG_VERSION } from '../core/import-join.js';

const CAP = 50;  // same default + explicit --max-results override as census

// ---------------------------------------------------------------------------
// --emit-catalog (#162): write the library-keyed, de-duped export catalog to
// a JSON file instead of the console. Appendable — merges into an existing
// file by index identity unless --catalog-replace.
// ---------------------------------------------------------------------------

function loadCatalog(file, replace) {
  if (replace || !fs.existsSync(file)) return { version: CATALOG_VERSION, libraries: {} };
  let prior;
  try { prior = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    process.stderr.write(`Error: ${file} exists but is not valid catalog JSON (${e.message}). ` +
      `Use --catalog-replace to overwrite.\n`);
    process.exit(1);
  }
  if (prior.version !== CATALOG_VERSION) {
    process.stderr.write(`Error: ${file} is catalog version ${prior.version}, this build emits ` +
      `version ${CATALOG_VERSION}. Refusing to mix schemas — rebuild with --catalog-replace.\n`);
    process.exit(1);
  }
  prior.libraries ||= {};
  return prior;
}

// ---------------------------------------------------------------------------
// --used-by (#162b) reuse surface. The CLI block below and the GUI server
// (/api/exports) both need to (a) load + version-check a who-uses catalog and
// (b) look up, for a given (package, name), the corpus codebases that import
// that export. Extracted here so the server reuses the exact resolution the
// CLI uses instead of recomputing. Unlike loadCatalog (emit path, process.exit
// on bad input, "start fresh" on missing), the read path THROWS — a server
// must surface the error and keep running, not exit.
// ---------------------------------------------------------------------------

/** Load + version-check a who-uses catalog for reading. Throws on bad input. */
export function loadUsedByCatalog(file) {
  let cat;
  try { cat = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`--used-by catalog ${file} unreadable (${e.message}).`); }
  if (cat.version !== CATALOG_VERSION) {
    throw new Error(`--used-by catalog is version ${cat.version}; this build needs ` +
      `version ${CATALOG_VERSION} (who-uses provenance). Re-emit with ` +
      `--multi-index ... --exports --emit-catalog --catalog-replace.`);
  }
  cat.libraries ||= {};
  return cat;
}

/**
 * Build the per-(package, name) used-by lookup for one index against a loaded
 * catalog. Returns (pkgLabel, name) => Array<{index, count}> | null, sorted by
 * descending count. The current index's library is matched by its derived root
 * alias (same logic the CLI --used-by path uses).
 */
export function makeUsedByFor(catalog, index) {
  const roots = buildJoinContext(index).roots;
  const libOf = (pkgLabel) => roots.insidePackage
    ? ([...roots.aliases][0] || null)
    : (pkgLabel === '(root)' ? '(root)' : pkgLabel.split('.')[0]);
  return (pkgLabel, name) => {
    const lib = libOf(pkgLabel);
    const m = lib && catalog.libraries[lib] && catalog.libraries[lib].usedBy && catalog.libraries[lib].usedBy[name];
    if (!m) return null;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([idx, n]) => ({ index: idx, count: n }));
  };
}

function catalogSummary(catalog) {
  const libs = Object.keys(catalog.libraries).sort();
  const overlapped = libs.filter(l => (catalog.libraries[l].alsoProvidedBy || []).length);
  process.stderr.write(`[emit-catalog] ${libs.length} librar${libs.length === 1 ? 'y' : 'ies'}` +
    `${overlapped.length ? `, ${overlapped.length} de-duped across overlapping indexes` : ''}\n`);
}

/** Single-index emit: --index-path .foo --exports --emit-catalog file. */
export function doEmitCatalog(index, args) {
  const catalog = loadCatalog(args.emit_catalog, args.catalog_replace);
  const libMap = buildCatalogEntry(index, { indexName: index.indexPath });
  mergeCatalog(catalog, libMap);
  fs.writeFileSync(args.emit_catalog, JSON.stringify(catalog, null, 1));
  catalogSummary(catalog);
  process.stderr.write(`[emit-catalog] wrote ${args.emit_catalog}\n`);
}

/** Multi-index emit, called from index.js's --multi-index divert: reduce all
 *  indexes into ONE catalog file. Returns failure count. */
export function doEmitCatalogMulti(indexPaths, args) {
  const catalog = loadCatalog(args.emit_catalog, args.catalog_replace);
  let failures = 0;
  const perIndexImports = [];   // {indexName, rows} stashed for the who-uses pass
  // Pass 1: build the library catalog (de-duped) + stash each index's imports.
  for (let i = 0; i < indexPaths.length; i++) {
    const p = indexPaths[i];
    process.stderr.write(`[multi-index] (${i + 1}/${indexPaths.length}) ${p}\n`);
    try {
      const idx = new CodeSearchIndex({ indexPath: p });
      if (idx.files.size === 0) { failures++; process.stderr.write(`[multi-index] '${p}' has no loadable index — skipped\n`); continue; }
      mergeCatalog(catalog, buildCatalogEntry(idx, { indexName: p }));
      perIndexImports.push({ indexName: p, rows: extractImports(idx).rows });
    } catch (err) {
      failures++;
      process.stderr.write(`[multi-index] '${p}' failed: ${err.message}\n`);
    }
  }
  // Pass 2: who-uses provenance — credit each index's named imports of a
  // catalogued library to that library's exports (#162b). Done after the
  // catalog is complete so every provider is known.
  catalog.libraries ||= {};
  for (const lib of Object.values(catalog.libraries)) delete lib.usedBy;   // recompute fresh
  for (const { indexName, rows } of perIndexImports) annotateUsedBy(catalog, indexName, rows);

  fs.writeFileSync(args.emit_catalog, JSON.stringify(catalog, null, 1));
  catalogSummary(catalog);
  const withUsers = Object.values(catalog.libraries).filter(l => l.usedBy && Object.keys(l.usedBy).length).length;
  process.stderr.write(`[multi-index] who-uses provenance on ${withUsers} librar${withUsers === 1 ? 'y' : 'ies'}; catalog written to ${args.emit_catalog}\n`);
  return failures;
}

const TIER_GLYPH = { declared: 'A', promoted: 'B', heuristic: 'C' };
const LEGEND = 'tiers: A declared (__all__ / @*_export)   B promoted (__init__ re-export)   C heuristic floor';

/** Segment-aware package match: scope segments must appear as a contiguous
 *  run of the package's segments. 'decomposition' matches 'decomposition'
 *  and 'sklearn.decomposition', never 'cross_decomposition'. */
function pkgMatches(scope, pkgLabel) {
  const segs = (s) => String(s).toLowerCase().split(/[./\\]/).filter(Boolean);
  const a = segs(pkgLabel), b = segs(scope);
  if (b.length === 0 || b.length > a.length) return false;
  for (let i = 0; i + b.length <= a.length; i++) {
    if (b.every((seg, j) => a[i + j] === seg)) return true;
  }
  return false;
}

function site(s) {
  return s ? `${s.file}:${s.line}` : 'unresolved';
}

/** Merge declared+promoted duplicates of the same (package, name) into one
 *  row showing both tiers; keeps the best defSite. */
function mergeRows(records) {
  const byKey = new Map();
  for (const r of records) {
    const key = `${r.package} ${r.name}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...r, tiers: new Set([r.tier]), idioms: new Set([r.idiom]) });
    } else {
      prev.tiers.add(r.tier);
      prev.idioms.add(r.idiom);
      if (!prev.defSite && r.defSite) prev.defSite = r.defSite;
      if (!prev.dottedPath && r.dottedPath) prev.dottedPath = r.dottedPath;
    }
  }
  return [...byKey.values()];
}

function tierCol(tiers) {
  return ['declared', 'promoted', 'heuristic']
    .map(t => (tiers.has(t) ? TIER_GLYPH[t] : ' ')).join('').trimEnd().padEnd(3);
}

export function doExports(index, args) {
  const scope = (args.exports && args.exports !== '.') ? args.exports : null;
  const { records, packages, pyFiles } = extractExports(index);

  if (pyFiles === 0) {
    console.log('No Python files in this index. Python is the only language the');
    console.log('exports catalog reads today — other languages are #153 follow-ups.');
    return;
  }

  // --used-by <catalog> (#162b): annotate each export with the OTHER corpus
  // codebases that import it (the de facto API). Per-library `usedBy` keyed by
  // bare name; we match the current index's library by its derived root alias.
  let usedByFor = null;
  if (args.used_by) {
    let cat;
    try { cat = loadUsedByCatalog(args.used_by); }
    catch (e) { console.log(`Error: ${e.message}`); return; }
    const lookup = makeUsedByFor(cat, index);
    usedByFor = (pkgLabel, name) => {
      const users = lookup(pkgLabel, name);
      return users && users.map(u => `${u.index}(${u.count})`);
    };
  }

  const match = makeFilterMatcher(args.filter);
  let rows = mergeRows(records).filter(r =>
    match(r.name, r.dottedPath || '', r.package));
  if (scope) rows = rows.filter(r => pkgMatches(scope, r.package));

  const cap = args._explicit && args._explicit.has('max_results') ? args.max_results : CAP;
  const filterNote = args.filter ? ` — filter: '${args.filter}'` : '';
  const scopeNote = scope ? ` — package: '${scope}'` : '';

  // Group by package.
  const byPkg = new Map();
  for (const r of rows) {
    if (!byPkg.has(r.package)) byPkg.set(r.package, []);
    byPkg.get(r.package).push(r);
  }
  const pkgLabels = [...byPkg.keys()].sort();
  const pkgByLabel = new Map();
  for (const p of packages.values()) pkgByLabel.set(p.dotted || '(root)', p);
  const notesFor = (label) => pkgByLabel.get(label)?.notes || [];
  const isImplicit = (label) => Boolean(pkgByLabel.get(label)?.implicit);
  const IMPLICIT_NOTE = 'no __init__.py in the index (empty file skipped at ' +
    'build, or a PEP 420 namespace package) — declared/promoted tiers ' +
    'unavailable; heuristic floor only.';

  console.log(`Exports catalog — ${pkgLabels.length} package(s), ${rows.length} exported name(s) (Python)${scopeNote}${filterNote}\n`);

  if (rows.length === 0) {
    if (scope) {
      const all = [...new Set(mergeRows(records).map(r => r.package))].sort();
      console.log(`  No package matches '${scope}'.`);
      if (all.length) {
        console.log(`  Packages with exports: ${all.slice(0, 12).join(', ')}${all.length > 12 ? `, ... (${all.length} total)` : ''}`);
      }
    } else if (args.filter) {
      console.log(`  No exported names match --filter '${args.filter}'.`);
    } else {
      console.log('  No export declarations found (no __all__, __init__ re-exports,');
      console.log('  or @*_export decorators). Tier-C fallback found nothing public.');
    }
    return;
  }

  console.log(LEGEND);
  const anyImplicit = pkgLabels.some(isImplicit);
  if (anyImplicit && !(scope || args.verbose || args.filter)) {
    console.log('[no-init] = ' + IMPLICIT_NOTE);
  }
  console.log('');

  // Unscoped + non-verbose: per-package summary, names on demand.
  // --used-by always lists names (the annotation is per-name).
  const listNames = Boolean(scope || args.verbose || args.filter || usedByFor);
  let usedCount = 0, unusedCount = 0;   // declared-but-unused tally for --used-by
  let printed = 0;
  let truncated = false;

  for (const label of pkgLabels) {
    if (printed >= cap) { truncated = true; break; }
    const pkgRows = byPkg.get(label).sort((x, y) => x.name.localeCompare(y.name));
    const decl = pkgRows.filter(r => r.tiers.has('declared'));
    const promo = pkgRows.filter(r => r.tiers.has('promoted'));
    const heur = pkgRows.filter(r => r.tiers.has('heuristic'));
    const declOnly = decl.filter(r => !r.tiers.has('promoted'));
    const promoOnly = promo.filter(r => !r.tiers.has('declared'));

    if (!listNames) {
      const parts = [];
      if (decl.length) parts.push(`A:${decl.length}`);
      if (promo.length) parts.push(`B:${promo.length}`);
      if (heur.length) parts.push(`C:${heur.length}`);
      if (decl.length && promo.length) parts.push(`delta ${declOnly.length}/${promoOnly.length}`);
      if (isImplicit(label)) parts.push('[no-init]');
      console.log(`  ${label.padEnd(40)} ${parts.join('  ')}`);
      for (const n of notesFor(label)) console.log(`      note: ${n}`);
      printed++;
      continue;
    }

    console.log(`package ${label}`);
    if (isImplicit(label)) console.log(`  note: ${IMPLICIT_NOTE}`);
    for (const n of notesFor(label)) console.log(`  note: ${n}`);
    for (const r of pkgRows) {
      if (printed >= cap) { truncated = true; break; }
      const dotted = r.dottedPath && r.dottedPath !== r.name ? `  (${r.dottedPath})` : '';
      console.log(`  ${tierCol(r.tiers)} ${r.name.padEnd(32)} ->  ${site(r.defSite)}${dotted}`);
      if (usedByFor) {
        const users = usedByFor(label, r.name);
        if (users && users.length) { usedCount++; console.log(`        ← used by ${users.join(', ')}`); }
        else { unusedCount++; console.log('        ← used by (none in corpus)'); }
      }
      if (args.verbose) {
        console.log(`        ${[...r.idioms].join(', ')} @ ${site(r.declSite)}`);
      }
      printed++;
    }
    if (decl.length && promo.length && (declOnly.length || promoOnly.length)) {
      console.log(`  delta: ${declOnly.length} declared-only` +
                  `${declOnly.length ? ` (${declOnly.slice(0, 8).map(r => r.name).join(', ')}${declOnly.length > 8 ? ', ...' : ''})` : ''}` +
                  `, ${promoOnly.length} promoted-only` +
                  `${promoOnly.length ? ` (${promoOnly.slice(0, 8).map(r => r.name).join(', ')}${promoOnly.length > 8 ? ', ...' : ''})` : ''}`);
    }
    console.log('');
  }

  if (truncated) {
    const unit = listNames ? 'name rows' : 'packages';
    const total = listNames ? rows.length : pkgLabels.length;
    console.log(`  (showing ${printed} of ${total} ${unit} — raise with --max-results N, or narrow with --exports <package> / --filter)`);
  }
  if (usedByFor) {
    console.log(`\n  De facto API: ${usedCount} export(s) imported elsewhere in the corpus, ` +
      `${unusedCount} declared-but-unused (no corpus importer). 'used by' counts NAMED imports ` +
      `(qualified attribute access is a #162b refinement).`);
  }
  if (!listNames) {
    console.log(`\n  Tip: --exports <package> lists that package's names resolved to definitions; -v adds idiom + declaration sites.`);
  }
}
