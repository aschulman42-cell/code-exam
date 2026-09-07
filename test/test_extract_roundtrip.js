// test_extract_roundtrip.js — #241 parse safety: emitted file@func copy-targets round-trip through doExtract
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_extract_roundtrip.js — #241 parse-safety.
 *
 * The #241 quoting sweep makes emitted paths *shell*-safe. This guards that they
 * are also *parse*-safe: a token CE prints as a copy-target (`file@func`,
 * `name@line`) must round-trip back through `doExtract` to the SAME function —
 * even when `@` is in the path (scoped-npm) or the name, or the path has a space.
 *
 * Method: build a fixture index, take the exact token an emitter produces
 * (`filepath@displayName`), feed it to `doExtract`, and assert the single-match
 * header (`# filepath@name`) names the same file — i.e. it resolved uniquely and
 * correctly, not "Multiple functions match" or "not found".
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { displayName } from '../src/utils.js';
import { doExtract } from '../src/commands/browse.js';

const TEST_DIR = path.join(os.tmpdir(), 'ce_extract_roundtrip_fixture');
const INDEX_DIR = path.join(os.tmpdir(), 'ce_extract_roundtrip_index');

let index;

before(async () => {
  process.stderr.write = () => true; // silence progress
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'has space'), { recursive: true });
  // '@'-in-path (scoped-npm shape) but NOT under node_modules, which CE excludes.
  fs.mkdirSync(path.join(TEST_DIR, 'pkgs', '@scope'), { recursive: true });
  // Two files with the SAME function name -> ambiguous -> forces file-qualified
  // disambiguation (and, in the display layer, a name@line form).
  fs.writeFileSync(path.join(TEST_DIR, 'a.js'), 'function dup() {\n  return "from-a";\n}\nfunction onlyInA() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(TEST_DIR, 'sub', 'b.js'), 'function dup() {\n  return "from-b";\n}\n');
  // Path with a space (the #241-quoted form's content).
  fs.writeFileSync(path.join(TEST_DIR, 'has space', 'c.js'), 'function spacedFn() {\n  return "from-c";\n}\n');
  // Scoped-npm-style path: '@' legitimately inside the path.
  fs.writeFileSync(path.join(TEST_DIR, 'pkgs', '@scope', 'pkg.js'), 'function scopedFn() {\n  return "from-scope";\n}\n');

  index = new CodeSearchIndex({ indexPath: INDEX_DIR });
  await index.buildIndex(TEST_DIR, { showProgress: false });
});

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(INDEX_DIR, { recursive: true, force: true });
});

// Run doExtract for a token, capturing stdout lines.
function extractOutput(token) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.map(x => (x === undefined ? '' : String(x))).join(' '));
  try { doExtract(index, { extract: token }); } finally { console.log = orig; }
  return lines.join('\n');
}

// A token round-trips iff doExtract resolved it to a single function in `wantFile`
// (its `# <file>@…` header names that file) and did not report ambiguity / miss.
function assertResolves(token, wantFile, wantBody) {
  const out = extractOutput(token);
  assert.ok(!/Multiple functions match/.test(out), `ambiguous for token: ${token}\n${out}`);
  assert.ok(!/not found/i.test(out), `not found for token: ${token}\n${out}`);
  assert.ok(out.includes(`# ${wantFile}@`) || out.includes(`# ${wantFile.replace(/\\/g, '/')}@`),
    `expected header for ${wantFile}, token: ${token}\n${out}`);
  if (wantBody) assert.ok(out.includes(wantBody), `expected body ${wantBody}, token: ${token}\n${out}`);
}

test('bare ambiguous name is reported ambiguous (baseline)', () => {
  const out = extractOutput('dup');
  assert.ok(/Multiple functions match/.test(out), `expected ambiguity for bare 'dup'\n${out}`);
});

test('file@func round-trips for each side of a same-name collision (both emitter forms)', () => {
  const matches = index.findFunctionMatches('dup');
  assert.equal(matches.length, 2, 'fixture should have two dup() defs');
  for (const m of matches) {
    const fp = m.filepath.replace(/\\/g, '/');
    // Form 1: the ambiguity list (util displayName).
    assertResolves(`${fp}@${displayName(m.name, m.filepath)}`, fp);
    // Form 2: `--list-functions --full-path` (index.getDisplayName — may add an
    // @line / _KW_ suffix, yielding a double-@ token that must still round-trip).
    const dn = index.getDisplayName ? index.getDisplayName(m.name) : m.name;
    assertResolves(`${fp}@${dn}`, fp);
  }
});

test('scoped-npm path (@ inside the path) round-trips', () => {
  const m = index.findFunctionMatches('scopedFn')[0];
  assert.ok(m, 'scopedFn should be indexed');
  const fp = m.filepath.replace(/\\/g, '/');
  const token = `${fp}@${displayName(m.name, m.filepath)}`;
  assert.ok(token.includes('@scope/'), 'token should contain the scoped-npm @');
  assertResolves(token, 'pkgs/@scope/pkg.js', 'from-scope');
});

test('path with a space round-trips (the #241-quoted form, unquoted here)', () => {
  const m = index.findFunctionMatches('spacedFn')[0];
  assert.ok(m, 'spacedFn should be indexed');
  const fp = m.filepath.replace(/\\/g, '/');
  const token = `${fp}@${displayName(m.name, m.filepath)}`;
  assert.ok(token.includes(' '), 'token path should contain a space');
  assertResolves(token, 'has space/c.js', 'from-c');
});

test('FILE:LNNN (the emitted file:line site-ref form) resolves the function at that line', () => {
  // search/metrics print `file:line` site-refs; --extract accepts FILE:LNNN
  // (function containing that line). Test on a clean, a scoped-@, and a space path.
  for (const name of ['onlyInA', 'scopedFn', 'spacedFn']) {
    const m = index.findFunctionMatches(name)[0];
    assert.ok(m, `${name} should be indexed`);
    const fp = m.filepath.replace(/\\/g, '/');
    assertResolves(`${fp}:${m.start}`, fp);
  }
});
