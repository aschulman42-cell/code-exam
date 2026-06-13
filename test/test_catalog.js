/**
 * test_catalog.js — #162 catalog emit: buildCatalogEntry (library-keyed,
 * partitioned by root alias) + mergeCatalog (de-dupe by library, richest
 * wins, alsoProvidedBy audit; appendable refresh by index identity).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { buildCatalogEntry, mergeCatalog, CATALOG_VERSION } from '../src/core/import-join.js';

function indexOf(files, indexPath = '.__test_catalog__') {
  const idx = new CodeSearchIndex({ indexPath });
  idx.fileLines = new Map(Object.entries(files).map(([p, src]) => [p, src.split('\n')]));
  return idx;
}

describe('buildCatalogEntry', () => {
  it('inside-package index → one library owning all packages, root-relative', () => {
    // A package indexed from inside: __init__ has no `mypkg/` prefix on disk,
    // self-imports reference `mypkg.sub` (resolves after dropping `mypkg`).
    const idx = indexOf({
      '__init__.py': 'from .core import Thing\n__all__ = ["Thing"]',
      'core.py': 'from mypkg.helpers import h\nclass Thing:\n    pass',
      'helpers.py': 'def h():\n    pass',
      'sub/__init__.py': 'from mypkg.sub.impl import S\n__all__ = ["S"]',
      'sub/impl.py': 'from mypkg.helpers import h\nclass S:\n    pass',
    });
    const libs = buildCatalogEntry(idx, { indexName: '.mypkg' });
    // Self-import evidence (mypkg.*) → inside-package; library = mypkg.
    assert.deepEqual(Object.keys(libs), ['mypkg']);
    assert.equal(libs.mypkg.insidePackage, true);
    assert.equal(libs.mypkg.index, '.mypkg');
    assert.ok(libs.mypkg.exportCount > 0);
    assert.ok(libs.mypkg.packages['(root)'] || libs.mypkg.packages['sub']);
  });

  it('site-packages index → one library per top-level package', () => {
    const idx = indexOf({
      'alpha/__init__.py': 'from .m import A\n__all__ = ["A"]',
      'alpha/m.py': 'class A:\n    pass',
      'beta/__init__.py': 'from .n import B\n__all__ = ["B"]',
      'beta/n.py': 'class B:\n    pass',
    });
    const libs = buildCatalogEntry(idx, { indexName: '.pkgs' });
    assert.deepEqual(Object.keys(libs).sort(), ['alpha', 'beta']);
    assert.equal(libs.alpha.insidePackage, false);
    assert.ok(libs.alpha.packages.alpha.A);
    assert.equal(libs.alpha.packages.alpha.A.tier, 'declared');
  });

  it('records resolved defSite as file:line strings', () => {
    const idx = indexOf({
      'alpha/__init__.py': 'from .m import A\n__all__ = ["A"]',
      'alpha/m.py': '\nclass A:\n    pass',
    });
    const libs = buildCatalogEntry(idx, { indexName: '.pkgs' });
    assert.match(libs.alpha.packages.alpha.A.defSite, /alpha\/m\.py:\d+$/);
  });
});

describe('mergeCatalog — de-dupe by library', () => {
  const lib = (name, index, exportCount) => ({ [name]: { index, exportCount, packages: {} } });

  it('keeps the richest copy and records the loser in alsoProvidedBy', () => {
    const cat = { version: CATALOG_VERSION, libraries: {} };
    mergeCatalog(cat, lib('sklearn', '.scikit-learn', 581));
    mergeCatalog(cat, lib('sklearn', '.Py314_site_pkg', 622));
    assert.equal(cat.libraries.sklearn.index, '.Py314_site_pkg');     // richer wins
    assert.equal(cat.libraries.sklearn.exportCount, 622);
    assert.deepEqual(cat.libraries.sklearn.alsoProvidedBy, ['.scikit-learn']);
  });

  it('is order-independent (richest wins regardless of insert order)', () => {
    const cat = { version: CATALOG_VERSION, libraries: {} };
    mergeCatalog(cat, lib('sklearn', '.Py314_site_pkg', 622));
    mergeCatalog(cat, lib('sklearn', '.scikit-learn', 581));
    assert.equal(cat.libraries.sklearn.index, '.Py314_site_pkg');
    assert.deepEqual(cat.libraries.sklearn.alsoProvidedBy, ['.scikit-learn']);
  });

  it('appendable: re-emitting the same index refreshes its entry in place', () => {
    const cat = { version: CATALOG_VERSION, libraries: {} };
    mergeCatalog(cat, lib('alpha', '.pkgs', 5));
    mergeCatalog(cat, lib('alpha', '.pkgs', 9));   // same index, updated
    assert.equal(cat.libraries.alpha.exportCount, 9);
    assert.deepEqual(cat.libraries.alpha.alsoProvidedBy || [], []);
  });

  it('distinct libraries coexist; adding one leaves others untouched', () => {
    const cat = { version: CATALOG_VERSION, libraries: {} };
    mergeCatalog(cat, lib('sklearn', '.scikit-learn', 581));
    mergeCatalog(cat, lib('keras', '.keras', 200));
    assert.deepEqual(Object.keys(cat.libraries).sort(), ['keras', 'sklearn']);
    assert.equal(cat.libraries.sklearn.exportCount, 581);
  });
});
