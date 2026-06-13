/**
 * import-join.js — shared cross-index import<->export join core (#162).
 *
 * Extracted from src/commands/imports-from.js (#154) with NO behavior change,
 * so the live `--imports-from` join, the `--imports <catalog>` consumer
 * (issue-162-imports-consumer), and `--exports --emit-catalog` all share ONE
 * root-alias derivation + verdict classifier.
 *
 * Two halves:
 *   buildJoinContext(B)        — derive B's export catalog + root aliases +
 *                                lazy-registry map from a live library index.
 *   classifyOne(ctx, sub, name) — the per-import verdict (resolved /
 *                                private-or-internal / not-found), incl.
 *                                ancestor re-export, submodule, module-__all__,
 *                                and lazy-registry rescue. Pure w.r.t. ctx.
 *
 * Plus buildCatalogEntry(index) — the serializable, library-keyed export
 * catalog for one index, partitioned by root alias, for `--emit-catalog`.
 */

import { extractImports, extractPythonImports } from './imports.js';
import { extractExports, resolveModuleFile, findDefLine, extractDunderAll } from './exports.js';

export const norm = (fp) => fp.replace(/\\/g, '/');

export function buildFileMap(index) {
  const map = new Map();
  for (const fp of index.fileLines.keys()) map.set(norm(fp).toLowerCase(), fp);
  return map;
}

/**
 * B's root aliases — the first segments under which OTHER codebases import B.
 * Structural signal: a root-level __init__.py means B was built INSIDE its
 * package (.scikit-learn: `sklearn.base` resolves only after dropping the
 * first segment); no root __init__ means a collection of packages
 * (site-packages), whose top-level labels are genuine roots.
 */
export function deriveRootAliases(bFileMap, bPkgLabels, bImportRows, rootIsPackage) {
  if (!rootIsPackage) {
    const aliases = new Set();
    for (const label of bPkgLabels) {
      if (label !== '(root)') aliases.add(label.split('.')[0]);
    }
    return { aliases, insidePackage: false };
  }
  const SUFFIXES = ['.py', '.pyi', '/__init__.py', '/__init__.pyi'];
  const counts = new Map();
  for (const r of bImportRows) {
    if (r.relative) continue;
    const segs = r.module.split('.');
    if (segs.length < 2) continue;
    const full = segs.join('/');
    if (SUFFIXES.some(s => bFileMap.has((full + s).toLowerCase()))) continue;
    const rest = segs.slice(1).join('/');
    if (SUFFIXES.some(s => bFileMap.has((rest + s).toLowerCase()))) {
      counts.set(segs[0], (counts.get(segs[0]) || 0) + 1);
    }
  }
  // Dominance filter: coincidental collisions (scipy.cluster matching
  // sklearn's cluster/) score a handful of hits; the real package scores
  // hundreds. Without it, scipy imports joined to a .scikit-learn B.
  const top = Math.max(0, ...counts.values());
  const selfAliases = new Set(
    [...counts.entries()].filter(([, c]) => c >= 3 && c >= top * 0.5).map(([seg]) => seg));
  return { aliases: selfAliases, insidePackage: true };
}

/** Does an import module target B? Returns the module path INSIDE B
 *  ('' = B's root) or null. */
export function subPathInB(module, bPkgLabels, roots) {
  if (!roots.insidePackage && bPkgLabels.has(module)) return module;
  const segs = module.split('.');
  if (roots.aliases.has(segs[0])) {
    if (roots.insidePackage) return segs.slice(1).join('.');
    return module;   // site-packages-style: B paths keep the root segment
  }
  return null;
}

const TIER_RANK = { declared: 0, promoted: 1, heuristic: 2 };

/**
 * Build the join context from a live library index B: its tiered export
 * catalog (exportsByPkg), package labels, root aliases, file map, and the
 * lazy-registry (_import_structure/_LazyModule) package map. Everything
 * classifyOne needs.
 */
export function buildJoinContext(B) {
  const { records: bRecords, packages: bPackages } = extractExports(B);
  const rootIsPackage = Boolean(bPackages.get('') && bPackages.get('').initFile);
  const bFileMap = buildFileMap(B);
  const bImports = extractImports(B);
  const bPkgLabels = new Set(bRecords.map(r => r.package));
  const exportsByPkg = new Map();
  for (const r of bRecords) {
    let m = exportsByPkg.get(r.package);
    if (!m) { m = new Map(); exportsByPkg.set(r.package, m); }
    const prev = m.get(r.name);
    if (!prev || TIER_RANK[r.tier] < TIER_RANK[prev.tier]) m.set(r.name, r);
  }
  const roots = deriveRootAliases(bFileMap, bPkgLabels, bImports.rows, rootIsPackage);

  const lazyPkgs = new Map();   // label -> { initLines, dir }
  for (const p of bPackages.values()) {
    if (p.notes && p.notes.some(n => n.includes('_import_structure'))) {
      lazyPkgs.set(p.dotted || '(root)', {
        initLines: (p.initFile && B.fileLines.get(p.initFile)) || [],
        dir: p.dir,
      });
    }
  }
  return { B, bRecords, bPackages, bFileMap, bPkgLabels, exportsByPkg, roots, lazyPkgs };
}

export function lazyOwnerOf(ctx, sub) {
  const parts = sub ? sub.split('.') : [];
  for (let k = parts.length; k >= 0; k--) {
    const label = parts.slice(0, k).join('.') || '(root)';
    if (ctx.lazyPkgs.has(label)) return label;
  }
  return null;
}

/**
 * Classify one imported name against B. `sub` is the module path inside B
 * (from subPathInB), `name` the imported symbol. Returns
 * { verdict, rec?, defSite?, isModule?, lazyOwner?, fromFile? }.
 * Verbatim port of imports-from.js's verdict logic (#154).
 */
export function classifyOne(ctx, sub, name) {
  const { exportsByPkg, bFileMap, bPackages, B } = ctx;
  const label = sub || '(root)';
  const rec = exportsByPkg.get(label) && exportsByPkg.get(label).get(name);
  if (rec && rec.tier !== 'heuristic') return { verdict: 'resolved', rec };

  // Ancestor packages: `from b.metrics.pairwise import cosine_similarity`
  // where metrics/__init__ re-exports the name — public via the parent.
  {
    const parts = sub ? sub.split('.') : [];
    for (let k = parts.length - 1; k >= 0; k--) {
      const ancLabel = parts.slice(0, k).join('.') || '(root)';
      const r2 = exportsByPkg.get(ancLabel) && exportsByPkg.get(ancLabel).get(name);
      if (r2 && r2.tier !== 'heuristic') return { verdict: 'resolved', rec: r2 };
    }
  }

  // `from b.pkg import submodule` — the imported name is itself a module.
  const subModFile = resolveModuleFile(bFileMap, '', (sub ? sub + '.' : '') + name);
  if (subModFile) {
    return { verdict: 'resolved', rec: rec || null, defSite: { file: subModFile, line: 1 }, isModule: true };
  }

  if (rec) return { verdict: 'private', rec };   // heuristic-tier hit

  // sub '' = B's root package: the "module" is the root __init__ itself.
  const fromFile = sub
    ? resolveModuleFile(bFileMap, '', sub)
    : (bPackages.get('') && bPackages.get('').initFile) || null;
  if (fromFile) {
    const modLines = B.fileLines.get(fromFile) || [];
    const modAll = extractDunderAll(modLines);
    const declaredHere = modAll.names.some(n => n.name === name);
    let defLine = findDefLine(modLines, name);
    let defSite = defLine ? { file: fromFile, line: defLine } : null;
    if (!defSite) {
      const modDir = norm(fromFile).includes('/') ? norm(fromFile).slice(0, norm(fromFile).lastIndexOf('/')) : '';
      const reexp = extractPythonImports(modLines, fromFile, { includeRelative: true })
        .find(r => (r.alias || r.name) === name);
      if (reexp) {
        const srcFile = resolveModuleFile(bFileMap, modDir, reexp.module);
        if (srcFile) {
          const srcLine = findDefLine(B.fileLines.get(srcFile) || [], reexp.name);
          defSite = { file: srcFile, line: srcLine || 1 };
        }
      }
    }
    if (declaredHere && defSite) {
      return { verdict: 'resolved', rec: { tier: 'declared', idiom: 'module __all__', defSite, dottedPath: null } };
    }
    if (defSite) return { verdict: 'private', defSite, lazyOwner: lazyOwnerOf(ctx, sub) };
  }

  // Lazy-registry rescue (#153 fast-follow gap).
  const lazyLabel = lazyOwnerOf(ctx, sub);
  if (lazyLabel) {
    const lazy = ctx.lazyPkgs.get(lazyLabel);
    const reLit = new RegExp(`["']${name}["']`);
    if (lazy.initLines.some(l => reLit.test(l))) {
      return { verdict: 'resolved', rec: { tier: 'declared', idiom: 'lazy registry (literal)', defSite: null, dottedPath: null } };
    }
    let childHit = null;
    for (const fp of B.fileLines.keys()) {
      const n = norm(fp);
      const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
      if (dir !== lazy.dir || !/\.pyi?$/i.test(n) || /(^|\/)__init__\.pyi?$/i.test(n)) continue;
      const childLines = B.fileLines.get(fp);
      if (extractDunderAll(childLines).names.some(x => x.name === name)) {
        childHit = { file: fp, line: findDefLine(childLines, name) || 1 };
        break;
      }
    }
    if (childHit) {
      return { verdict: 'resolved', rec: { tier: 'declared', idiom: 'module __all__ (lazy auto-discovery)', defSite: childHit, dottedPath: null } };
    }
    return { verdict: 'notfound', fromFile: fromFile || null, lazyOwner: lazyLabel };
  }
  return { verdict: 'notfound', fromFile: fromFile || null };
}

// ---------------------------------------------------------------------------
// Catalog emit (#162 issue-162-imports-catalog) — library-keyed, de-duped.
// ---------------------------------------------------------------------------

// v2 adds per-library `usedBy` provenance (#162b who-uses): library.usedBy =
// { exportName -> { importingIndex -> count } }, the de facto API. v1 catalogs
// (export-only) are refused by readers that need provenance.
export const CATALOG_VERSION = 2;

/**
 * Build the serializable catalog contribution of one index: a map of
 * libraryName -> { language, index, insidePackage, exportCount, packages }.
 * An inside-package index contributes ONE library (its derived root alias),
 * owning all packages. A site-packages-style index contributes one library
 * per top-level package. `packages` is name -> {tier, defSite, dottedPath}
 * keyed by the package label, exactly the --exports tiered records.
 */
export function buildCatalogEntry(index, { language = 'python', indexName = null } = {}) {
  const ctx = buildJoinContext(index);
  const idx = indexName || index.indexPath;
  const libs = {};

  // Partition packages into libraries by root alias.
  // insidePackage: all packages belong to the single derived root alias, and
  // their labels are already root-relative (decomposition, cluster, ...).
  // not insidePackage: a package label's first segment IS its library.
  const ensure = (lib) => (libs[lib] ||= {
    language, index: idx, insidePackage: ctx.roots.insidePackage,
    exportCount: 0, packages: {},
  });

  for (const [label, nameMap] of ctx.exportsByPkg) {
    let lib, pkgKey;
    if (ctx.roots.insidePackage) {
      lib = [...ctx.roots.aliases][0] || '(unknown)';
      pkgKey = label;                                  // root-relative already
    } else {
      lib = (label === '(root)') ? '(root)' : label.split('.')[0];
      pkgKey = label;
    }
    const entry = ensure(lib);
    const pkg = (entry.packages[pkgKey] ||= {});
    for (const [name, rec] of nameMap) {
      pkg[name] = {
        tier: rec.tier,
        defSite: rec.defSite ? `${norm(rec.defSite.file)}:${rec.defSite.line}` : null,
        dottedPath: rec.dottedPath || null,
        idiom: rec.idiom || null,
      };
      entry.exportCount++;
    }
  }

  // lazyPackages provenance (consumer caveats, doesn't mislabel skew).
  for (const lib of Object.keys(libs)) {
    const lazy = [];
    for (const lbl of ctx.lazyPkgs.keys()) {
      const owner = ctx.roots.insidePackage ? lib : (lbl === '(root)' ? '(root)' : lbl.split('.')[0]);
      if (owner === lib) lazy.push(lbl);
    }
    if (lazy.length) libs[lib].lazyPackages = lazy;
  }
  return libs;
}

// ---------------------------------------------------------------------------
// Static consumer (#162 issue-162-imports-consumer): classify an import
// against a SERIALIZED catalog entry — pure lookup, no live B files. This is
// the subset of classifyOne that works on baked data: tiered-record lookup +
// ancestor walk + lazy-package caveat. The file-read rescues (module-level
// __all__, lazy literal/auto-discovery) that LIVE --imports-from applies are
// NOT baked into the v1 catalog, so a name reachable only through those reads
// as not-found here, caveated when its package is lazy.
// ---------------------------------------------------------------------------

/** The catalog package-key for an import module, honoring how the entry was
 *  built: an inside-package library stores root-relative labels (strip the
 *  library root segment); a site-packages library stores full dotted labels. */
export function catalogPkgKey(entry, module) {
  if (!entry.insidePackage) return module;
  const segs = module.split('.');
  return segs.slice(1).join('.');   // drop the root alias; '' => root package
}

/** Classify `name` imported from `module` against a serialized catalog
 *  `entry`. Returns { verdict, rec?, lazyOwner? } where rec carries the
 *  baked {tier, defSite, dottedPath, idiom}. */
export function classifyAgainstCatalogEntry(entry, module, name) {
  const pkgs = entry.packages || {};
  const lookup = (label) => {
    const key = label === '' ? '(root)' : label;
    return pkgs[key] && pkgs[key][name];
  };
  const baseKey = catalogPkgKey(entry, module);

  // Exact package, then ancestor packages (re-export through a parent).
  const parts = baseKey ? baseKey.split('.') : [];
  for (let k = parts.length; k >= 0; k--) {
    const rec = lookup(parts.slice(0, k).join('.'));
    if (rec && rec.tier !== 'heuristic') return { verdict: 'resolved', rec };
  }
  // Heuristic-tier hit: present but the floor found it, not declared public.
  for (let k = parts.length; k >= 0; k--) {
    const rec = lookup(parts.slice(0, k).join('.'));
    if (rec) return { verdict: 'private', rec };
  }
  // Lazy-registry package whose names aren't baked into the v1 catalog.
  const lazy = entry.lazyPackages || [];
  if (lazy.length) {
    const owner = lazy.find(lbl => {
      const l = lbl === '(root)' ? '' : lbl;
      return baseKey === l || baseKey.startsWith(l + '.') || l === '';
    });
    if (owner) return { verdict: 'notfound', lazyOwner: owner };
  }
  return { verdict: 'notfound' };
}

/**
 * Merge a per-index library map into an accumulating catalog, de-duping by
 * library name: the entry with the most exports wins; the loser's index is
 * recorded in `alsoProvidedBy` (the overlap audit the user asked for, given a
 * haphazard collection of indexes). Appendable: re-emitting an index replaces
 * its own contributions and re-evaluates the winner.
 */
/**
 * Credit one index's NAMED imports as who-uses provenance on the catalog
 * (#162b). For each `from lib[.sub] import Name` whose Name resolves as an
 * export of catalogued library `lib`, record the importing index under
 * `catalog.libraries[lib].usedBy[Name]`. The providing index is excluded
 * (self-import is not external use). Keyed by BARE export name so it matches
 * regardless of which copy of the library de-dupe kept (label structures
 * differ across inside-package vs site-packages copies). Mutates `catalog`.
 *
 * Named imports only in v2 — qualified attribute access (`import lib;
 * lib.Name()`) provenance is a refinement (it needs a per-file scan of every
 * index at emit time).
 */
export function annotateUsedBy(catalog, indexName, importRows) {
  const libs = catalog.libraries || {};
  for (const row of importRows) {
    if (!row.name || row.star) continue;            // named imports only
    const lib = row.module.split('.')[0];
    const entry = libs[lib];
    if (!entry) continue;                            // uncatalogued
    // Self-use exclusion: the providing index AND every alsoProvidedBy index
    // are COPIES of this library, so their imports of it are internal, not
    // external use. (De-dupe can make a non-winning copy — e.g. .scikit-learn
    // when .Py314_site_pkg wins sklearn — land in alsoProvidedBy; its
    // self-imports must not count as who-uses.)
    if (entry.index === indexName || (entry.alsoProvidedBy || []).includes(indexName)) continue;
    const v = classifyAgainstCatalogEntry(entry, row.module, row.name);
    if (v.verdict !== 'resolved') continue;          // only real exports get provenance
    entry.usedBy ||= {};
    const m = (entry.usedBy[row.name] ||= {});
    m[indexName] = (m[indexName] || 0) + 1;
  }
  return catalog;
}

export function mergeCatalog(catalog, libMap) {
  catalog.libraries ||= {};
  for (const [lib, entry] of Object.entries(libMap)) {
    const prev = catalog.libraries[lib];
    if (!prev) { catalog.libraries[lib] = entry; continue; }
    // Same index re-emitted → replace outright (appendable refresh).
    if (prev.index === entry.index) {
      entry.alsoProvidedBy = prev.alsoProvidedBy || [];
      catalog.libraries[lib] = entry;
      continue;
    }
    // Different index also provides this library → keep the richer, note the other.
    const [winner, loser] = entry.exportCount > prev.exportCount ? [entry, prev] : [prev, entry];
    const also = new Set(winner.alsoProvidedBy || []);
    for (const x of (loser.alsoProvidedBy || [])) also.add(x);
    also.add(loser.index);
    also.delete(winner.index);
    winner.alsoProvidedBy = [...also].sort();
    catalog.libraries[lib] = winner;
  }
  return catalog;
}
