/**
 * test_whousedby.js — #162b catalog-v2 who-uses provenance: annotateUsedBy
 * credits a codebase's NAMED imports of a catalogued export to that library's
 * usedBy, keyed by bare name, excluding self-imports.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateUsedBy, CATALOG_VERSION } from '../src/core/import-join.js';

function cat() {
  return {
    version: CATALOG_VERSION,
    libraries: {
      sklearn: {
        index: '.scikit-learn', insidePackage: true,
        packages: { decomposition: { PCA: { tier: 'declared', defSite: 'decomposition/_pca.py:113' } } },
      },
    },
  };
}
const imp = (module, name) => ({ module, name, star: false, relative: false });

describe('annotateUsedBy', () => {
  it('credits a resolved named import to the export, keyed by importing index', () => {
    const c = cat();
    annotateUsedBy(c, '.as_ml_code', [imp('sklearn.decomposition', 'PCA')]);
    annotateUsedBy(c, '.as_ml_code', [imp('sklearn.decomposition', 'PCA')]);
    annotateUsedBy(c, '.Manning_books', [imp('sklearn.decomposition', 'PCA')]);
    assert.deepEqual(c.libraries.sklearn.usedBy.PCA, { '.as_ml_code': 2, '.Manning_books': 1 });
  });

  it('excludes the providing index (self-import is not external use)', () => {
    const c = cat();
    annotateUsedBy(c, '.scikit-learn', [imp('sklearn.decomposition', 'PCA')]);
    assert.equal(c.libraries.sklearn.usedBy, undefined);
  });

  it('excludes alsoProvidedBy indexes (a de-dupe-losing COPY is still self-use)', () => {
    // .Py314_site_pkg won sklearn de-dupe; .scikit-learn is a losing copy.
    // Its own `from sklearn... import PCA` must NOT count as external use.
    const c = cat();
    c.libraries.sklearn.index = '.Py314_site_pkg';
    c.libraries.sklearn.alsoProvidedBy = ['.scikit-learn'];
    annotateUsedBy(c, '.scikit-learn', [imp('sklearn.decomposition', 'PCA')]);
    annotateUsedBy(c, '.as_ml_code', [imp('sklearn.decomposition', 'PCA')]);
    assert.deepEqual(c.libraries.sklearn.usedBy.PCA, { '.as_ml_code': 1 });
  });

  it('does not credit a name that is not a catalogued export', () => {
    const c = cat();
    annotateUsedBy(c, '.user', [imp('sklearn.decomposition', 'NotAnExport')]);
    assert.equal(c.libraries.sklearn.usedBy, undefined);
  });

  it('ignores module-only and star imports (no named export to credit)', () => {
    const c = cat();
    annotateUsedBy(c, '.user', [{ module: 'sklearn', name: null, star: false }]);
    annotateUsedBy(c, '.user', [{ module: 'sklearn.decomposition', name: '*', star: true }]);
    assert.equal(c.libraries.sklearn.usedBy, undefined);
  });

  it('ignores imports of uncatalogued libraries', () => {
    const c = cat();
    annotateUsedBy(c, '.user', [imp('numpy', 'array')]);
    assert.equal(c.libraries.sklearn.usedBy, undefined);
  });
});
