// test_third_party_notices.js — every shipped third-party file (grammars/*.wasm, public/vendor/*) has a row in THIRD-PARTY-NOTICES.md naming the installed version
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// grammars-third-party-notices: CodeExam ships the tree-sitter grammar wasm
// files and mermaid.min.js, each MIT, and THIRD-PARTY-NOTICES.md is what
// carries their notices. The registration-point rule turned on licensing: a
// new vendored file or a package bump cannot land without its row, and a row
// cannot drift from what is installed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTICES = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');

// One row per shipped file:
// | `path` | `package` x.y.z … | copyright | repository | licence |
function rows() {
  const text = fs.readFileSync(NOTICES, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s+(\d+\.\d+\.\d+)[^|]*\|([^|]*)\|([^|]*)\|\s*([\w-]+)\s*\|/);
    if (m) out.push({ file: m[1], pkg: m[2], version: m[3], copyright: m[4].trim(), repo: m[5].trim(), licence: m[6] });
  }
  return out;
}

function shippedFiles() {
  const out = fs.readdirSync(path.join(ROOT, 'grammars')).filter((f) => f.endsWith('.wasm')).map((f) => `grammars/${f}`);
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/${e.name}`);
      else out.push(`${rel}/${e.name}`);
    }
  };
  walk(path.join(ROOT, 'public', 'vendor'), 'public/vendor');
  return out.sort();
}

function installedVersion(pkg) {
  const pj = path.join(ROOT, 'node_modules', pkg, 'package.json');
  return fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')).version : null;
}

describe('THIRD-PARTY-NOTICES.md inventory', () => {
  it('parses to rows that each carry a copyright holder, a repository URL and the MIT licence', () => {
    const r = rows();
    assert.ok(r.length >= 13, `expected at least 13 rows (12 grammars + mermaid), parsed ${r.length}`);
    for (const row of r) {
      assert.ok(row.copyright, `${row.file}: copyright holder`);
      assert.match(row.repo, /^https?:\/\//, `${row.file}: repository URL`);
      // The file reproduces the MIT text once; a non-MIT file would need its own text added.
      assert.equal(row.licence, 'MIT', `${row.file}: licence`);
    }
  });

  it('every grammars/*.wasm and every public/vendor file has a row, and no row names a file that is not shipped', () => {
    const listed = new Set(rows().map((r) => r.file));
    for (const f of shippedFiles()) assert.ok(listed.has(f), `${f} is shipped but has no row in THIRD-PARTY-NOTICES.md`);
    for (const f of listed) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} has a row but is not in the tree`);
  });

  it('each grammar row names the installed package version (skipped per row when the dev package is absent)', () => {
    let compared = 0;
    for (const row of rows().filter((r) => r.file.startsWith('grammars/'))) {
      const installed = installedVersion(row.pkg);
      if (installed === null) continue;
      assert.equal(row.version, installed, `${row.file}: row says ${row.pkg} ${row.version}, installed ${installed}`);
      compared++;
    }
    assert.ok(compared > 0 || installedVersion('tree-sitter-c') === null, 'compared at least one row when the grammar packages are installed');
  });

  it('the mermaid row names the version string inside the shipped bundle', () => {
    const row = rows().find((r) => r.file === 'public/vendor/mermaid.min.js');
    assert.ok(row, 'mermaid.min.js has a row');
    const bundle = fs.readFileSync(path.join(ROOT, row.file), 'utf8');
    const m = bundle.match(/version:"(\d+\.\d+\.\d+)"/);
    assert.ok(m, 'the bundle carries a version:"x.y.z" string');
    assert.equal(row.version, m[1], `row says mermaid ${row.version}, bundle says ${m[1]}`);
  });

  it('the web-tree-sitter runtime note names the installed version', () => {
    const m = fs.readFileSync(NOTICES, 'utf8').match(/`web-tree-sitter`\s+(\d+\.\d+\.\d+)/);
    assert.ok(m, 'the notices name the web-tree-sitter version');
    const installed = installedVersion('web-tree-sitter');
    if (installed === null) return;
    assert.equal(m[1], installed, `note says web-tree-sitter ${m[1]}, installed ${installed}`);
  });

  it('NOTICE points at the inventory', () => {
    assert.match(fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8'), /THIRD-PARTY-NOTICES\.md/);
  });
});
