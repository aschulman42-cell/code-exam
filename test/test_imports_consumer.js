// test_imports_consumer.js — catalog consumer: classifyAgainstCatalogEntry, ancestor walk, catalogPkgKey
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_imports_consumer.js — #162 split 2: classifyAgainstCatalogEntry, the
 * static (no-live-B) classifier the --imports <catalog> consumer uses.
 * Mirrors classifyOne's lookup + ancestor walk over a SERIALIZED entry, with
 * the lazy-package caveat for names the v1 catalog doesn't bake.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAgainstCatalogEntry, catalogPkgKey } from '../src/core/import-join.js';

const rec = (tier, defSite) => ({ tier, defSite: defSite || null, dottedPath: null, idiom: null });

describe('catalogPkgKey', () => {
  it('site-packages entry keeps the full dotted module', () => {
    assert.equal(catalogPkgKey({ insidePackage: false }, 'sklearn.decomposition'), 'sklearn.decomposition');
  });
  it('inside-package entry strips the root alias segment', () => {
    assert.equal(catalogPkgKey({ insidePackage: true }, 'sklearn.decomposition'), 'decomposition');
    assert.equal(catalogPkgKey({ insidePackage: true }, 'sklearn'), '');
  });
});

describe('classifyAgainstCatalogEntry', () => {
  it('resolves a declared name in a site-packages entry, with its defSite', () => {
    const entry = { insidePackage: false, packages: { 'sklearn.decomposition': { PCA: rec('declared', 'sklearn/decomposition/_pca.py:113') } } };
    const v = classifyAgainstCatalogEntry(entry, 'sklearn.decomposition', 'PCA');
    assert.equal(v.verdict, 'resolved');
    assert.equal(v.rec.defSite, 'sklearn/decomposition/_pca.py:113');
  });

  it('resolves through an inside-package entry (root-relative labels)', () => {
    const entry = { insidePackage: true, packages: { decomposition: { PCA: rec('declared') } } };
    assert.equal(classifyAgainstCatalogEntry(entry, 'sklearn.decomposition', 'PCA').verdict, 'resolved');
  });

  it('resolves via an ancestor package re-export', () => {
    const entry = { insidePackage: false, packages: { 'sklearn.metrics': { cosine_similarity: rec('promoted') } } };
    // imported from a deeper module, re-exported by the parent package.
    assert.equal(classifyAgainstCatalogEntry(entry, 'sklearn.metrics.pairwise', 'cosine_similarity').verdict, 'resolved');
  });

  it('reports a heuristic-tier hit as private-or-internal', () => {
    const entry = { insidePackage: false, packages: { mypkg: { _helper: rec('heuristic') } } };
    assert.equal(classifyAgainstCatalogEntry(entry, 'mypkg', '_helper').verdict, 'private');
  });

  it('reports an absent name as not-found', () => {
    const entry = { insidePackage: false, packages: { 'sklearn.decomposition': { PCA: rec('declared') } } };
    assert.equal(classifyAgainstCatalogEntry(entry, 'sklearn.decomposition', 'Nonexistent').verdict, 'notfound');
  });

  it('caveats a name in a lazy-registry package instead of mislabeling', () => {
    const entry = { insidePackage: false, packages: { transformers: {} }, lazyPackages: ['(root)'] };
    const v = classifyAgainstCatalogEntry(entry, 'transformers', 'AutoTokenizer');
    assert.equal(v.verdict, 'notfound');
    assert.equal(v.lazyOwner, '(root)');
  });
});
