// Coverage for #187: hotspots / entry_points exclude vendored + minified files
// (reusing the #172 _isNoiseDoc gate). The noise files stay INDEXED and
// searchable — only the ranked listings skip them, so they don't bury real
// source (e.g. XMLUI bundles on .Bram_src, a bundled cli.js).
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

const SRC = path.join(os.tmpdir(), 'ce_hotspots_src');
const IDX = path.join(os.tmpdir(), 'ce_hotspots_idx');

before(async () => {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(path.join(SRC, 'src'), { recursive: true });
  fs.mkdirSync(path.join(SRC, 'node_modules', 'somelib'), { recursive: true });

  // Real source: an uncalled function (entry-point shaped) + one that calls the
  // vendored helper (so the helper would rank as a hotspot without the fix).
  fs.writeFileSync(path.join(SRC, 'src', 'app.js'), `function realThing() {
  let total = 0;
  for (let i = 0; i < 50; i++) total += i;
  return total;
}
function useHelper() {
  return helperFn() + helperFn();
}
`);

  // Minified-by-content (normal extension, so definitely indexed): one ~3000-char
  // line trips isMinified via maxLineLen > 2000.
  fs.writeFileSync(path.join(SRC, 'src', 'bundle.js'),
    `const bundleData = "${'x'.repeat(3000)}";
function bundledThing() {
  return bundleData.length;
}
`);

  // Vendored: a called helper + a dead (uncalled) function under node_modules.
  fs.writeFileSync(path.join(SRC, 'node_modules', 'somelib', 'index.js'), `function helperFn() {
  let y = 0;
  for (let j = 0; j < 50; j++) y += j;
  return y;
}
function deadLib() {
  let q = 1;
  return q + 2;
}
`);

  const index = new CodeSearchIndex({ indexPath: IDX });
  await index.buildIndex(SRC, { showProgress: false });
  globalThis.__hotspotIndex = index;
});

describe('#187: hotspots/entry_points exclude vendored + minified', () => {
  it('noise files are still indexed (searchable) — exclusion is listing-only', () => {
    const fns = globalThis.__hotspotIndex.listFunctions();
    assert.ok(fns.some(f => /bundle\.js/.test(f.filepath)),
      'the minified-by-content bundle.js should be indexed (searchable)');
  });

  it('hotspots exclude vendored/minified (even a called vendored helper)', () => {
    const hs = globalThis.__hotspotIndex.getHotspots(50, false);
    assert.ok(!hs.some(f => /node_modules|bundle\.js/.test(f.filepath)),
      'hotspots must exclude vendored/minified: ' + JSON.stringify(hs.map(h => h.filepath)));
  });

  it('entry_points exclude vendored/minified but keep real source', () => {
    const eps = globalThis.__hotspotIndex.getEntryPoints(50, 0, false);
    assert.ok(!eps.some(f => /node_modules|bundle\.js/.test(f.filepath)),
      'entry_points must exclude vendored/minified: ' + JSON.stringify(eps.map(e => e.filepath)));
    assert.ok(eps.some(f => /app\.js/.test(f.filepath)),
      'real source should still appear in entry_points: ' + JSON.stringify(eps.map(e => e.filepath)));
  });
});
