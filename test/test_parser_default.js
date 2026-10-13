// test_parser_default.js — tree-sitter is the build default wherever a grammar ships; --regex-parser (CLI) and useTreeSitter:false (API) build regex-only; --use-tree-sitter is still accepted; both flags together is an error
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// tree-sitter-default-parser (2026-10-13). Before this, --build-index used the
// regex parser unless --use-tree-sitter was given (and the GUI's Build Index
// box was off by default), so most indexes in the wild were the coarse ones.
// The decision: the grammar parser is the default when a grammar is present;
// the regex parser is per-file fallback and the explicit --regex-parser build.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { TreeSitterParser } from '../src/core/TreeSitterParser.js';

const TMP = path.join(os.tmpdir(), 'ce_test_parser_default');
const SRC = path.join(TMP, 'src');
const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function writeCorpus() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  // A grammar language (C, GNU layout so both parsers start at line 1), a
  // regex-only language (Swift has no shipped grammar), and a JavaScript file:
  // on Windows with Node 24, a tree-sitter build of a tiny JavaScript corpus
  // followed by an immediate process.exit() died in libuv ("Assertion failed:
  // !(handle->flags & UV_HANDLE_CLOSING)", exit 127) while V8 background work
  // was still winding down; the CLI now lets the loop drain after a build.
  fs.writeFileSync(path.join(SRC, 'a.c'), ['static int', 'add(int a, int b)', '{', '  return a + b;', '}', ''].join('\n'));
  fs.writeFileSync(path.join(SRC, 'b.swift'), ['func greet(name: String) -> String {', '  return name', '}', ''].join('\n'));
  fs.writeFileSync(path.join(SRC, 'c.js'), ['function runPipeline(data) {', '  return data.map((d) => d * 2);', '}', 'module.exports = { runPipeline };', ''].join('\n'));
}

function fileEntries(idx, basename) {
  const key = Object.keys(idx.functionIndex || {}).find((k) => path.basename(k) === basename);
  return key ? idx.functionIndex[key] : null;
}

function runCLI(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: TMP, encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

describe('parser default: tree-sitter where a grammar ships, regex otherwise', () => {
  let haveTreeSitter = false;
  before(async () => {
    writeCorpus();
    haveTreeSitter = await new TreeSitterParser().init();
  });
  after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

  it('buildIndex with no parser choice is the hybrid tree-sitter + regex build', async (t) => {
    if (!haveTreeSitter) return t.skip('web-tree-sitter not installed');
    const idx = new CodeSearchIndex({ indexPath: path.join(TMP, '.idx_default') });
    await idx.buildIndex(SRC, { showProgress: false });
    assert.equal(idx.parseMethod, 'tree-sitter+regex');
    const c = fileEntries(idx, 'a.c');
    assert.ok(c && c.add, `a.c must list add; have ${c ? Object.keys(c).join(', ') : '(no file)'}`);
    assert.equal(c.add.parser, undefined, 'a grammar-parsed entry carries no parser label');
    assert.equal(c.add.start, 1);
    const swift = fileEntries(idx, 'b.swift');
    assert.ok(swift && Object.keys(swift).length > 0, 'b.swift must have regex entries');
    for (const [name, e] of Object.entries(swift)) assert.equal(e.parser, 'regex', `${name} in b.swift is a regex entry`);
  });

  it('buildIndex with useTreeSitter:false is the regex build on every file', async () => {
    const idx = new CodeSearchIndex({ indexPath: path.join(TMP, '.idx_regex') });
    await idx.buildIndex(SRC, { showProgress: false, useTreeSitter: false });
    assert.equal(idx.parseMethod, 'regex');
    const c = fileEntries(idx, 'a.c');
    assert.ok(c && c.add, 'the regex parser finds the GNU-layout definition too');
    assert.equal(c.add.start, 1);
  });

  it('--regex-parser builds regex-only; a bare --build-index and --use-tree-sitter build the hybrid', (t) => {
    const rx = runCLI(['--build-index', SRC, '--index-path', path.join(TMP, '.cli_regex'), '--regex-parser']);
    assert.equal(rx.status, 0, rx.out);
    const rxStats = runCLI(['--index-path', path.join(TMP, '.cli_regex'), '--stats']);
    assert.match(rxStats.out, /^Parse method: regex$/m);
    if (!haveTreeSitter) return t.skip('web-tree-sitter not installed');
    const bare = runCLI(['--build-index', SRC, '--index-path', path.join(TMP, '.cli_bare')]);
    assert.equal(bare.status, 0, bare.out);
    assert.match(runCLI(['--index-path', path.join(TMP, '.cli_bare'), '--stats']).out, /^Parse method: tree-sitter\+regex$/m);
    const legacy = runCLI(['--build-index', SRC, '--index-path', path.join(TMP, '.cli_legacy'), '--use-tree-sitter']);
    assert.equal(legacy.status, 0, legacy.out);
    assert.doesNotMatch(legacy.out, /deprecated/i, '--use-tree-sitter names the default and is accepted silently');
    assert.match(runCLI(['--index-path', path.join(TMP, '.cli_legacy'), '--stats']).out, /^Parse method: tree-sitter\+regex$/m);
  });

  it('--regex-parser together with --use-tree-sitter is refused, naming both flags', () => {
    const r = runCLI(['--build-index', SRC, '--index-path', path.join(TMP, '.cli_both'), '--regex-parser', '--use-tree-sitter']);
    assert.notEqual(r.status, 0, 'must exit non-zero');
    assert.match(r.out, /--regex-parser/);
    assert.match(r.out, /--use-tree-sitter/);
    assert.ok(!fs.existsSync(path.join(TMP, '.cli_both', 'literal_index.json')), 'nothing is built');
  });

  it('--help documents --regex-parser and no longer advertises --use-tree-sitter', () => {
    const r = runCLI(['--help']);
    assert.match(r.out, /--regex-parser/);
    assert.doesNotMatch(r.out, /--use-tree-sitter/);
  });
});
