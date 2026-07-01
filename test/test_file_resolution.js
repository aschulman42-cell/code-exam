/**
 * #238: file-target resolution — exact match wins, leading '/' anchors to root.
 *
 * Guards against re-drift into the pure-substring matching that caused #238: a
 * same-basename collision (root `README.md` + `hunch/README.md`) reported the
 * root file as ambiguous, and a leading-'/' query selected the *nested* file.
 * These unit-test `resolveExactFileTarget` (the shared helper) and
 * `_resolveFilepathTarget` (the core resolver that digest/extract route through)
 * directly, by setting `fileLines` — no on-disk index build needed.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

function makeIndex(paths) {
  const idx = new CodeSearchIndex({ indexPath: '.' });
  idx.fileLines = new Map(paths.map(p => [p, ['// ' + p]]));
  return idx;
}

test('resolveExactFileTarget: exact full path wins over a same-basename collision', () => {
  const idx = makeIndex(['README.md', 'hunch/README.md']);
  assert.deepEqual(idx.resolveExactFileTarget('README.md'), { filepath: 'README.md' });
  assert.deepEqual(idx.resolveExactFileTarget('hunch/README.md'), { filepath: 'hunch/README.md' });
});

test('resolveExactFileTarget: leading "/" anchors to the repo root', () => {
  const idx = makeIndex(['README.md', 'hunch/README.md']);
  assert.deepEqual(idx.resolveExactFileTarget('/README.md'), { filepath: 'README.md' });
  assert.deepEqual(idx.resolveExactFileTarget('/hunch/README.md'), { filepath: 'hunch/README.md' });
});

test('resolveExactFileTarget: root anchor with no exact match returns {anchored} (no fuzzy fallback)', () => {
  const idx = makeIndex(['hunch/README.md']); // no root README.md
  assert.deepEqual(idx.resolveExactFileTarget('/README.md'), { anchored: true });
});

test('resolveExactFileTarget: exact match is case-insensitive', () => {
  const idx = makeIndex(['README.md']);
  assert.deepEqual(idx.resolveExactFileTarget('readme.md'), { filepath: 'README.md' });
});

test('resolveExactFileTarget: non-exact, non-anchored query returns null (caller falls back to fuzzy)', () => {
  const idx = makeIndex(['hunch/app/agent.js']);
  assert.equal(idx.resolveExactFileTarget('agent'), null);    // substring, not exact
  assert.equal(idx.resolveExactFileTarget('agent.js'), null); // basename only, not full path
});

test('_resolveFilepathTarget: exact wins (not ambiguous), root anchor honored, suffix still falls back', () => {
  const idx = makeIndex(['README.md', 'hunch/README.md', 'hunch/app/agent.js']);
  assert.equal(idx._resolveFilepathTarget('README.md'), 'README.md');   // #238: exact, not ambiguous
  assert.equal(idx._resolveFilepathTarget('/README.md'), 'README.md');  // #238: root, never nested
  assert.equal(idx._resolveFilepathTarget('agent.js'), 'hunch/app/agent.js'); // unique suffix fallback
});
