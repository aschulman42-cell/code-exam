/**
 * imports-from.js — --imports-from <lib-index> (#154): cross-index
 * import <-> export resolution.
 *
 * Joins A's imports (the loaded index, via #156's extractImports) against
 * B's export catalog (a second index, via #153's extractExports), so the
 * examiner sees which of a dependency's public API a codebase ACTUALLY
 * uses — and, higher-signal, where it reaches past the public surface:
 *
 *   resolved             name is a Tier-A/B export of B (tier + defSite)
 *   private-or-internal  name exists in B but is NOT publicly exported —
 *                        fragile coupling to the dependency's internals
 *   not-found-in-B       the import names B's namespace but nothing in
 *                        B's index matches (moved API / version skew /
 *                        compiled extension module)
 *
 * Never silently assume a bare name resolves (#154; cf. #85).
 */

import { CodeSearchIndex } from '../core/CodeSearchIndex.js';
import { extractImports, extractPythonImports } from '../core/imports.js';
import { extractExports, resolveModuleFile, findDefLine, extractDunderAll } from '../core/exports.js';
import { reTestExamplePath } from '../core/ai-ml-detectors.js';
import { makeFilterMatcher } from '../core/filter-match.js';

const CAP = 50;  // census/exports cap convention: explicit --max-results raises

const norm = (fp) => fp.replace(/\\/g, '/');

function buildFileMap(index) {
  const map = new Map();
  for (const fp of index.fileLines.keys()) map.set(norm(fp).toLowerCase(), fp);
  return map;
}

/**
 * B's root aliases — the first segments under which OTHER codebases import
 * B. Two sources: top-level package labels (site-packages-style indexes,
 * where `sklearn/...` exists on disk) and B's own absolute self-imports
 * (inside-the-package indexes like .scikit-learn, where `sklearn.base`
 * only resolves after dropping the first segment — the same evidence
 * derivePackageName uses in harness.js, recomputed here from import rows).
 */
function deriveRootAliases(bFileMap, bPkgLabels, bImportRows, rootIsPackage) {
  // Structural signal first: an index whose ROOT directory carries an
  // __init__.py was built inside a package (.scikit-learn). A root without
  // one is a collection of packages (site-packages, a repos dir) — its
  // top-level labels are genuine roots, and self-import derivation must be
  // skipped (stray quirks like jax's own indirections otherwise win the
  // count and hijack the whole join).
  if (!rootIsPackage) {
    const aliases = new Set();
    for (const label of bPkgLabels) {
      if (label !== '(root)') aliases.add(label.split('.')[0]);
    }
    return { aliases, insidePackage: false };
  }
  // Self-import evidence: B's own absolute imports whose path only resolves
  // after dropping the first segment mean B was indexed INSIDE that package.
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
  // sklearn's cluster/, scipy.datasets matching datasets/) score a handful
  // of hits; the real package name scores hundreds. Without this, scipy
  // imports joined to a .scikit-learn B.
  const top = Math.max(0, ...counts.values());
  const selfAliases = new Set(
    [...counts.entries()]
      .filter(([, c]) => c >= 3 && c >= top * 0.5)
      .map(([seg]) => seg));
  // Inside-the-package index: B's "top-level" labels are really its
  // subpackages (cluster, datasets, ...) — A never addresses those bare,
  // so full-label matching must stay OFF or HF-datasets/scipy joins leak in.
  return { aliases: selfAliases, insidePackage: true };
}

/** Does A's import module target B? Returns the module path INSIDE B
 *  ('' = B's root) or null. */
function subPathInB(module, bPkgLabels, roots) {
  if (!roots.insidePackage && bPkgLabels.has(module)) return module;
  const segs = module.split('.');
  if (roots.aliases.has(segs[0])) {
    if (roots.insidePackage) return segs.slice(1).join('.');
    return module;   // site-packages-style: B paths keep the root segment
  }
  return null;
}

export function doImportsFrom(index, args) {
  const bPath = args.imports_from;
  process.stderr.write(`[imports-from] loading library index: ${bPath}\n`);
  const B = new CodeSearchIndex({ indexPath: bPath });
  if (B.files.size === 0) {
    console.log(`No index found at: ${bPath} — --imports-from needs a built library index (B).`);
    return;
  }

  // --- B side: export catalog, package labels, root aliases.
  const { records: bRecords, packages: bPackages } = extractExports(B);
  const rootIsPackage = Boolean(bPackages.get('') && bPackages.get('').initFile);
  const bFileMap = buildFileMap(B);
  const bImports = extractImports(B);
  const bPkgLabels = new Set(bRecords.map(r => r.package));
  const exportsByPkg = new Map();
  const TIER_RANK = { declared: 0, promoted: 1, heuristic: 2 };
  for (const r of bRecords) {
    let m = exportsByPkg.get(r.package);
    if (!m) { m = new Map(); exportsByPkg.set(r.package, m); }
    const prev = m.get(r.name);
    if (!prev || TIER_RANK[r.tier] < TIER_RANK[prev.tier]) m.set(r.name, r);
  }
  const roots = deriveRootAliases(bFileMap, bPkgLabels, bImports.rows, rootIsPackage);

  // Packages whose __init__ declares exports via a lazy registry
  // (_import_structure/_LazyModule — HF style). CE does not parse the
  // registry yet (#153 fast-follow), so a miss in these packages is a
  // KNOWN BLIND SPOT, not evidence of version skew — verdicts must say so.
  const lazyPkgs = new Map();   // label -> { initLines, dir }
  for (const p of bPackages.values()) {
    if (p.notes && p.notes.some(n => n.includes('_import_structure'))) {
      lazyPkgs.set(p.dotted || '(root)', {
        initLines: (p.initFile && B.fileLines.get(p.initFile)) || [],
        dir: p.dir,
      });
    }
  }
  const lazyOwnerOf = (sub) => {
    const parts = sub ? sub.split('.') : [];
    for (let k = parts.length; k >= 0; k--) {
      const label = parts.slice(0, k).join('.') || '(root)';
      if (lazyPkgs.has(label)) return label;
    }
    return null;
  };
  if (roots.aliases.size === 0) {
    console.log(`Could not determine a root package name for ${bPath} — no top-level`);
    console.log('packages and no self-imports to derive one from. Nothing to join.');
    return;
  }

  // --- A side: imports, joined to B.
  const { rows: aRows } = extractImports(index);
  // key: module + ' ' + name -> { name, module, sub, sites: [], testSites }
  const joined = new Map();
  let moduleImports = 0, starImports = 0, totalSites = 0;
  for (const row of aRows) {
    const sub = subPathInB(row.module, bPkgLabels, roots);
    if (sub === null) continue;
    totalSites++;
    if (row.star) { starImports++; continue; }
    if (!row.name) { moduleImports++; continue; }   // plain `import b.x` — counted, listed under -v later if wanted
    const key = `${row.module} ${row.name}`;
    let j = joined.get(key);
    if (!j) {
      j = { name: row.name, module: row.module, sub, sites: [], testSites: 0 };
      joined.set(key, j);
    }
    if (j.sites.length < 3) j.sites.push(`${row.file}:${row.line}`);
    j.siteCount = (j.siteCount || 0) + 1;
    if (reTestExamplePath.test(norm(row.file))) j.testSites++;
  }

  // --- Verdicts.
  const verdicts = { resolved: [], private: [], notfound: [] };
  for (const j of joined.values()) {
    const label = j.sub || '(root)';
    const rec = exportsByPkg.get(label) && exportsByPkg.get(label).get(j.name);
    if (rec && rec.tier !== 'heuristic') {
      j.verdict = 'resolved'; j.rec = rec;
      verdicts.resolved.push(j);
      continue;
    }
    // Ancestor packages: `from b.metrics.pairwise import cosine_similarity`
    // where metrics/__init__ re-exports the name — public via the parent
    // even when the leaf module declares nothing. defSite in the verdict
    // row lets the examiner verify it's the same object (#85 care).
    {
      const parts = j.sub ? j.sub.split('.') : [];
      let anc = null;
      for (let k = parts.length - 1; k >= 0 && !anc; k--) {
        const ancLabel = parts.slice(0, k).join('.') || '(root)';
        const r2 = exportsByPkg.get(ancLabel) && exportsByPkg.get(ancLabel).get(j.name);
        if (r2 && r2.tier !== 'heuristic') anc = r2;
      }
      if (anc) {
        j.verdict = 'resolved'; j.rec = anc;
        verdicts.resolved.push(j);
        continue;
      }
    }
    // `from b.pkg import submodule` — the imported name is itself a module.
    const subModFile = resolveModuleFile(bFileMap, '', (j.sub ? j.sub + '.' : '') + j.name);
    if (subModFile) {
      j.verdict = 'resolved'; j.rec = rec || null;
      j.defSite = { file: subModFile, line: 1 };
      j.isModule = true;
      verdicts.resolved.push(j);
      continue;
    }
    if (rec) {  // heuristic-tier hit: B never declared it, the floor found it
      j.verdict = 'private'; j.rec = rec;
      verdicts.private.push(j);
      continue;
    }
    // sub '' = B's root package: the "module" is the root __init__ itself.
    const fromFile = j.sub
      ? resolveModuleFile(bFileMap, '', j.sub)
      : (bPackages.get('') && bPackages.get('').initFile) || null;
    if (fromFile) {
      const modLines = B.fileLines.get(fromFile) || [];
      // MODULE-level __all__ (text.py declaring TfidfVectorizer) — public
      // API the package-level catalog deliberately doesn't enumerate, but
      // the join must honor or it calls public names "private".
      const modAll = extractDunderAll(modLines);
      const declaredHere = modAll.names.some(n => n.name === j.name);
      let defLine = findDefLine(modLines, j.name);
      let defSite = defLine ? { file: fromFile, line: defLine } : null;
      if (!defSite) {
        // Re-exported through this module (`from ._stop_words import X`) —
        // follow the module's own import to the real definition.
        const modDir = norm(fromFile).includes('/')
          ? norm(fromFile).slice(0, norm(fromFile).lastIndexOf('/')) : '';
        const reexp = extractPythonImports(modLines, fromFile, { includeRelative: true })
          .find(r => (r.alias || r.name) === j.name);
        if (reexp) {
          const srcFile = resolveModuleFile(bFileMap, modDir, reexp.module);
          if (srcFile) {
            const srcLine = findDefLine(B.fileLines.get(srcFile) || [], reexp.name);
            defSite = { file: srcFile, line: srcLine || 1 };
          }
        }
      }
      if (declaredHere && defSite) {
        j.verdict = 'resolved';
        j.rec = { tier: 'declared', idiom: 'module __all__', defSite, dottedPath: null };
        verdicts.resolved.push(j);
        continue;
      }
      if (defSite) {
        j.verdict = 'private';
        j.defSite = defSite;
        j.lazyOwner = lazyOwnerOf(j.sub);
        verdicts.private.push(j);
        continue;
      }
    }
    // Lazy-registry rescue (#153 fast-follow gap): a literal `"Name"` in the
    // owning package's registry init, or the name in a direct child module's
    // own __all__ (what HF's define_import_structure auto-discovers), means
    // B DOES declare it — without this, AutoTokenizer reads as "not found".
    const lazyLabel = lazyOwnerOf(j.sub);
    if (lazyLabel) {
      const lazy = lazyPkgs.get(lazyLabel);
      const reLit = new RegExp(`["']${j.name}["']`);
      if (lazy.initLines.some(l => reLit.test(l))) {
        j.verdict = 'resolved';
        j.rec = { tier: 'declared', idiom: 'lazy registry (literal)', defSite: null, dottedPath: null };
        verdicts.resolved.push(j);
        continue;
      }
      // Direct child modules' __all__ — the auto-discovery source.
      let childHit = null;
      for (const fp of B.fileLines.keys()) {
        const n = norm(fp);
        const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
        if (dir !== lazy.dir || !/\.pyi?$/i.test(n) || /(^|\/)__init__\.pyi?$/i.test(n)) continue;
        const childLines = B.fileLines.get(fp);
        if (extractDunderAll(childLines).names.some(x => x.name === j.name)) {
          childHit = { file: fp, line: findDefLine(childLines, j.name) || 1 };
          break;
        }
      }
      if (childHit) {
        j.verdict = 'resolved';
        j.rec = { tier: 'declared', idiom: 'module __all__ (lazy auto-discovery)', defSite: childHit, dottedPath: null };
        verdicts.resolved.push(j);
        continue;
      }
      j.lazyOwner = lazyLabel;   // miss inside a lazy package: caveat, don't claim skew
    }
    j.verdict = 'notfound';
    j.fromFile = fromFile || null;
    verdicts.notfound.push(j);
  }

  // --- Filter + render.
  const match = makeFilterMatcher(args.filter);
  for (const k of Object.keys(verdicts)) {
    verdicts[k] = verdicts[k]
      .filter(j => match(j.name, j.module))
      .sort((x, y) => y.siteCount - x.siteCount || x.name.localeCompare(y.name));
  }
  const cap = args._explicit && args._explicit.has('max_results') ? args.max_results : CAP;
  const filterNote = args.filter ? ` — filter: '${args.filter}'` : '';
  const nNames = verdicts.resolved.length + verdicts.private.length + verdicts.notfound.length;

  const rootNote = roots.insidePackage
    ? `B root package: ${[...roots.aliases].join(', ')}`
    : `B top-level packages: ${roots.aliases.size}`;
  console.log(`Imports-from join — A: ${index.indexPath}  ->  B: ${bPath}  (${rootNote})${filterNote}\n`);
  console.log(`  A import sites targeting B: ${totalSites}` +
              ` (${nNames} distinct from-import names, ${moduleImports} module imports` +
              `${starImports ? `, ${starImports} star imports` : ''})`);
  console.log(`  verdicts: ${verdicts.resolved.length} resolved, ` +
              `${verdicts.private.length} private-or-internal, ` +
              `${verdicts.notfound.length} not-found-in-B\n`);

  if (nNames === 0) {
    console.log(args.filter
      ? `  No joined names match --filter '${args.filter}'.`
      : '  A has no from-imports of B (module-level imports only, or none at all).');
    return;
  }

  const site = (s) => (s ? `${s.file}:${s.line}` : 'unresolved');
  const tag = (j) => (j.testSites && j.testSites === j.siteCount ? '  [test-only]' : '');
  let printed = 0, truncated = false;
  const emit = (j, glyph, detail) => {
    console.log(`  ${glyph}  ${j.name.padEnd(30)} ${detail}  | ${j.siteCount} site(s)${tag(j)}`);
    if (args.verbose) {
      console.log(`        from ${j.module} @ ${j.sites.join(', ')}` +
                  (j.testSites ? `  (${j.testSites}/${j.siteCount} sites in tests)` : ''));
    }
    printed++;
  };

  const SECTIONS = [
    ['resolved', verdicts.resolved, (j) => {
      const d = j.rec && j.rec.defSite ? site(j.rec.defSite) : site(j.defSite);
      const dp = j.rec && j.rec.dottedPath ? `  (${j.rec.dottedPath})` : '';
      if (j.isModule && !j.rec) return `->  ${d} [submodule]`;
      const t = { declared: 'A', promoted: 'B' }[j.rec.tier] || '?';
      const idm = j.rec.idiom && j.rec.idiom.includes('lazy') ? `, ${j.rec.idiom}` : '';
      return `->  ${d} (tier ${t}${idm})${dp}${j.isModule ? ' [submodule]' : ''}`;
    }],
    ['private-or-internal', verdicts.private, (j) => {
      const d = j.rec && j.rec.defSite ? site(j.rec.defSite) : site(j.defSite);
      return `->  ${d}  (not in B's declared/promoted exports)`;
    }],
    ['not-found-in-B', verdicts.notfound, (j) =>
      j.lazyOwner
        ? `(${j.lazyOwner === '(root)' ? "B's root" : j.lazyOwner} uses a lazy export registry CE does not yet parse (#153 fast-follow) — likely registry-exported, not version skew)`
        : j.fromFile
          ? `(module ${j.sub || '(root)'} resolves to ${j.fromFile}; name not found — moved/renamed or compiled?)`
          : `(module ${j.sub || '(root)'} not in B's index — version skew or extension module?)`],
  ];
  const GLYPH = { 'resolved': ' ', 'private-or-internal': '!', 'not-found-in-B': '?' };

  for (const [title, list, detail] of SECTIONS) {
    if (!list.length) continue;
    console.log(`${title} (${list.length}):`);
    for (const j of list) {
      if (printed >= cap) { truncated = true; break; }
      emit(j, GLYPH[title], detail(j));
    }
    console.log('');
    if (truncated) break;
  }
  if (truncated) {
    console.log(`  (showing ${printed} of ${nNames} names — raise with --max-results N, or narrow with --filter)\n`);
  }

  // --- Reverse view (-v): B's public surface A never touches.
  if (args.verbose) {
    const used = new Set(verdicts.resolved.map(j => `${j.sub || '(root)'} ${j.name}`));
    const unused = [];
    for (const [label, m] of exportsByPkg) {
      for (const [name, rec] of m) {
        if (rec.tier === 'heuristic' || name.startsWith('*')) continue;
        if (!used.has(`${label} ${name}`)) unused.push(`${label === '(root)' ? '' : label + '.'}${name}`);
      }
    }
    unused.sort();
    console.log(`unused exports of B (public surface A never imports): ${unused.length}`);
    if (unused.length) {
      console.log(`  ${unused.slice(0, 20).join(', ')}${unused.length > 20 ? `, ... (${unused.length} total)` : ''}`);
    }
  } else {
    console.log(`  Tip: -v adds per-name use sites and the unused-exports reverse view` +
                ` (B's public surface A never touches).`);
  }
}
