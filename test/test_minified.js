// Regression coverage for isMinified — the gate for the whole minified-JS
// prettify pipeline (#161). Previously untested; the avg-only gate silently
// skipped tall SPA bundles (claude.ai / Google Docs .har captures) whose
// per-file average line length is low despite carrying monster minified lines.
// These cases bracket the maxLine>2000 clause that fixes that.
import { test } from 'node:test';
import assert from 'node:assert';
import { isMinified } from '../src/core/CSI-helpers.js';

const rep = (line, n) => Array.from({ length: n }, () => line).join('\n');

test('isMinified: .min.* shortcut returns true regardless of content shape', () => {
  assert.equal(isMinified('foo.min.js', 'short\n'), true);
  assert.equal(isMinified('a/b/c.min.css', 'x'), true);
  assert.equal(isMinified('d.min.tsx', 'y\n'), true);
});

test('isMinified: only JS/CSS-family extensions are eligible', () => {
  const blob = 'x'.repeat(5000);            // would be "minified" if eligible
  assert.equal(isMinified('data.json', blob), false);
  assert.equal(isMinified('readme.md', blob), false);
  assert.equal(isMinified('mod.py', blob), false);
});

test('isMinified: empty / blank content is not minified', () => {
  assert.equal(isMinified('a.js', ''), false);
  assert.equal(isMinified('a.js', '\n\n\n'), false);
});

test('isMinified: normal readable source is not minified', () => {
  const src = rep('  const value = computeSomething(arg1, arg2);', 400);
  assert.equal(isMinified('app.js', src), false);
});

test('isMinified: uniformly-minified single blob (high average) is minified', () => {
  const blob = 'a'.repeat(1200);            // one line, avg 1200 > 500
  assert.equal(isMinified('bundle.js', blob), true);
});

test('isMinified: tall bundle — low average but a monster line — is minified (#161)', () => {
  // 9000 short lines + one 5000-char line: avg ~50 (< 500), maxLine 5000 (> 2000).
  // The pre-#161 avg-only gate returned FALSE here — the claude.ai/connectrpc bug.
  const tall = rep('a=1;', 9000) + '\n' + 'x'.repeat(5000);
  assert.equal(isMinified('connectrpc.js', tall), true);
});

test('isMinified: normal source with one stray long line (< 2000) is NOT minified', () => {
  // Guards against false-beautify of e.g. a file carrying one big base64 literal
  // or a long array literal — must stay below the maxLine threshold.
  const src = rep('  doThing();', 200) + '\n  const data = "' + 'A'.repeat(1500) + '";';
  assert.equal(isMinified('with-data.js', src), false);
});
