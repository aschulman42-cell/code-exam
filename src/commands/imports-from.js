// imports-from.js — --imports-from: joins this index's imports against a second index's exports (resolved/private/not-found)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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
import { effectiveMaxResults, capNotice } from '../argparse.js';
import { extractImports } from '../core/imports.js';
import { reTestExamplePath } from '../core/ai-ml-detectors.js';
import { makeFilterMatcher } from '../core/filter-match.js';
import { buildJoinContext, subPathInB, classifyOne, norm } from '../core/import-join.js';

const CAP = 50;  // census/exports cap convention: explicit --max-results raises

export function doImportsFrom(index, args) {
  const bPath = args.imports_from;
  process.stderr.write(`[imports-from] loading library index: ${bPath}\n`);
  const B = new CodeSearchIndex({ indexPath: bPath });
  if (B.files.size === 0) {
    console.log(`No index found at: ${bPath} — --imports-from needs a built library index (B).`);
    return;
  }

  // --- B side: shared join context (export catalog, root aliases, lazy map).
  const ctx = buildJoinContext(B);
  const { bPkgLabels, roots } = ctx;
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
    if (!row.name) { moduleImports++; continue; }   // plain `import b.x`
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

  // --- Verdicts (shared classifier).
  const verdicts = { resolved: [], private: [], notfound: [] };
  for (const j of joined.values()) {
    const v = classifyOne(ctx, j.sub, j.name);
    Object.assign(j, v);
    if (v.verdict === 'resolved') verdicts.resolved.push(j);
    else if (v.verdict === 'private') verdicts.private.push(j);
    else verdicts.notfound.push(j);
  }

  // --- Filter + render.
  const match = makeFilterMatcher(args.filter);
  for (const k of Object.keys(verdicts)) {
    verdicts[k] = verdicts[k]
      .filter(j => match(j.name, j.module))
      .sort((x, y) => y.siteCount - x.siteCount || x.name.localeCompare(y.name));
  }
  const cap = effectiveMaxResults(args, CAP);
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
    const note = capNotice(nNames, printed, 'names');
    if (note) console.log('  ' + note + '  (or narrow with --filter)\n');
  }

  // --- Reverse view (-v): B's public surface A never touches.
  if (args.verbose) {
    const used = new Set(verdicts.resolved.map(j => `${j.sub || '(root)'} ${j.name}`));
    const unused = [];
    for (const [label, m] of ctx.exportsByPkg) {
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
