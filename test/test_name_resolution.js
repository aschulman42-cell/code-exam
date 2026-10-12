// test_name_resolution.js — bare-name resolution precision (#343 ★A): locality of nested functions, file-local visibility (non-exported JS, C static), the receiver rule, import-directed picks, target-aware Find Callers, ambiguity labels and (file scope)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// The three #343 ★A repros in miniature, on both parsers:
//   1. two file-local `_shortPath`s must not share one caller list;
//   2. `out.push(s)` must not bind to a `const push = ...` local of another
//      function, while `push('x')` inside that function must bind to it;
//   3. a module-scope call site is `(file scope)`, not the nearest function.
// Plus: non-exported JS and C `static` definitions bind only from their own
// file; the import-directed pick between two exported `shared`s; a script
// file with no export syntax stays globally visible; Python nested defs and
// module-alias receivers.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { TreeSitterParser } from '../src/core/TreeSitterParser.js';

const TMP = path.join(os.tmpdir(), 'ce_test_name_resolution');
const SRC = path.join(TMP, 'src');
const CLI = path.resolve('src/index.js');

const FILES = {
  'a.js': [
    "import { tiny } from './util.js';",
    'function _shortPath(p) { return p.slice(0, 3); }',
    'export function doA(x) { return _shortPath(x) + tiny(); }',
  ],
  'b.js': [
    'function _shortPath(p) { return p.slice(-3); }',
    'export function doB(x) {',
    '  _shortPath(x);',
    '  return _shortPath(x + x);',
    '}',
  ],
  'c.js': [
    "import { doA } from './a.js';",
    'export function doC(out, arr) {',
    '  const push = (s) => out.push(s);',
    "  push('x');",
    '  const hit = arr.find((y) => y);',
    '  return doA(hit);',
    '}',
  ],
  'd.js': [
    'function find(a) { return a[0]; }',
    'export function doD(a) { return find(a); }',
    'export function doD2(a) { return a.find(Boolean); }',
  ],
  'e.js': [
    "import { doA } from './a.js';",
    "import { shared } from './f.js';",
    'doA(1);',
    'export function doE() { return shared(); }',
  ],
  'f.js': ['export function shared() { return 1; }'],
  'g.js': ['export function shared() { return 2; }'],
  'util.js': ['export function tiny() { return 0; }'],
  'script1.js': ['function helper() { return 1; }', 'function runScript() { return helper(); }'],
  'script2.js': ['function useHelper() { return helper(); }'],
  'm.py': ['def outer():', '    def inner():', '        return 1', '    return inner()', '', 'def top():', '    return 2'],
  'n.py': ['import m', 'from m import top', '', 'def inner():', '    return 3', '', 'def use():', '    return inner() + m.outer() + top()'],
  's.c': ['static int helper(void) {', '  return 1;', '}', 'int run_s(void) {', '  return helper();', '}'],
  't.c': ['int helper(void) {', '  return 2;', '}', 'int run_t(void) {', '  return helper();', '}'],
  'u.c': ['int run_u(void) {', '  return helper();', '}'],
};

function writeFixture() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  for (const [name, lines] of Object.entries(FILES)) fs.writeFileSync(path.join(SRC, name), lines.join('\n') + '\n');
}

function callee(idx, fn, name, fileHint = null) {
  const list = idx.findCallees(fn, fileHint);
  const hit = list.find(c => c.name === name);
  assert.ok(hit, `${fn} should list a callee named ${name}; got ${list.map(c => c.name).join(', ')}`);
  return hit;
}

function runCLI(indexDir, args) {
  const r = spawnSync(process.execPath, [CLI, '--index-path', indexDir, ...args], { encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '') + (r.stderr || '');
}

const VARIANTS = [
  { label: 'regex', dir: path.join(TMP, '.idx_regex'), useTreeSitter: false },
  { label: 'tree-sitter', dir: path.join(TMP, '.idx_ts'), useTreeSitter: true },
];

describe('bare-name resolution precision', () => {
  const built = {};
  let haveTreeSitter = false;

  before(async () => {
    writeFixture();
    const ts = new TreeSitterParser();
    haveTreeSitter = await ts.init();
    for (const v of VARIANTS) {
      if (v.useTreeSitter && !haveTreeSitter) continue;
      const idx = new CodeSearchIndex({ indexPath: v.dir });
      await idx.buildIndex(SRC, { showProgress: false, useTreeSitter: v.useTreeSitter });
      built[v.label] = idx;
    }
  });

  after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

  for (const v of VARIANTS) {
    describe(`${v.label} index`, () => {
      const idx = () => built[v.label];
      const skip = () => v.useTreeSitter && !haveTreeSitter;

      it('a non-exported function binds only from its own file (the _shortPath split)', () => {
        if (skip()) return;
        assert.equal(callee(idx(), 'doA', '_shortPath').resolved_def.filepath, 'a.js');
        assert.equal(callee(idx(), 'doA', '_shortPath').ambiguous, false);
        assert.equal(callee(idx(), 'doB', '_shortPath').resolved_def.filepath, 'b.js');
      });

      it('Find Callers of a file-qualified definition lists only the sites that can reach it', () => {
        if (skip()) return;
        const inA = idx().findCallers('_shortPath', 500, { fileHint: 'a.js' });
        const inB = idx().findCallers('_shortPath', 500, { fileHint: 'b.js' });
        const all = idx().findCallers('_shortPath', 500);
        assert.deepEqual(inA.map(c => c.filepath), ['a.js']);
        assert.deepEqual(inB.map(c => c.filepath), ['b.js', 'b.js']);
        assert.equal(all.length, 3, 'without a target the search stays name-based');
      });

      it('a local arrow binds from inside its container and nowhere else; a receiver call never binds to a free function', () => {
        if (skip()) return;
        const push = callee(idx(), 'doC', 'push');
        assert.ok(push.resolved_def, 'push("x") binds to the local push');
        assert.equal(push.resolved_def.filepath, 'c.js');
        assert.equal(push.ambiguous, false);
        const find = callee(idx(), 'doC', 'find');
        assert.equal(find.resolved_def, null, 'arr.find(...) must not bind to d.js find');
        assert.equal(find.ambiguous, true);
        assert.ok(['unreachable', 'receiver'].includes(find.reason), find.reason);
      });

      it('a named import directs a cross-file bind; a direct same-file call binds; a receiver call with no import evidence is a marked guess', () => {
        if (skip()) return;
        const tiny = callee(idx(), 'doA', 'tiny');
        assert.deepEqual([tiny.resolved_def.filepath, tiny.ambiguous], ['util.js', false]);
        const own = callee(idx(), 'doD', 'find');
        assert.deepEqual([own.resolved_def.filepath, own.ambiguous], ['d.js', false]);
        const guess = callee(idx(), 'doD2', 'find');
        assert.ok(guess.resolved_def, 'kept as a guess: d.js has no imports to judge by');
        assert.deepEqual([guess.ambiguous, guess.reason], [true, 'receiver']);
      });

      it('two exported same-named functions: the one the caller imports wins outright', () => {
        if (skip()) return;
        const shared = callee(idx(), 'doE', 'shared');
        assert.deepEqual([shared.resolved_def.filepath, shared.ambiguous], ['f.js', false]);
      });

      it('a module-scope call site has no caller function, and the CLI names it (file scope)', () => {
        if (skip()) return;
        const sites = idx().findCallers('doA', 500);
        const byFile = Object.fromEntries(sites.map(s => [s.filepath, s.caller_function]));
        assert.equal(byFile['c.js'], 'doC');
        assert.equal(byFile['e.js'], null);
        const out = runCLI(v.dir, ['--callers', 'doA']);
        assert.ok(out.includes('(file scope)'), out);
        assert.ok(!out.includes('(unknown)'), out);
      });

      it('a script file with no export syntax stays globally visible', () => {
        if (skip()) return;
        const h = callee(idx(), 'useHelper', 'helper');
        assert.deepEqual([h.resolved_def.filepath, h.ambiguous], ['script1.js', false]);
      });

      it('Python: nested def is local, module alias and named import direct the bind', () => {
        if (skip()) return;
        const inner = callee(idx(), 'outer', 'inner', 'm.py');
        assert.deepEqual([inner.resolved_def.filepath, inner.ambiguous], ['m.py', false]);
        const ownInner = callee(idx(), 'use', 'inner', 'n.py');
        assert.deepEqual([ownInner.resolved_def.filepath, ownInner.ambiguous], ['n.py', false]);
        const outer = callee(idx(), 'use', 'outer', 'n.py');
        assert.deepEqual([outer.resolved_def.filepath, outer.ambiguous], ['m.py', false]);
        const top = callee(idx(), 'use', 'top', 'n.py');
        assert.deepEqual([top.resolved_def.filepath, top.ambiguous], ['m.py', false]);
      });

      it('C: a static function binds only from its own file; the external one is the only candidate elsewhere', () => {
        if (skip()) return;
        assert.equal(callee(idx(), 'run_s', 'helper').resolved_def.filepath, 's.c');
        assert.equal(callee(idx(), 'run_t', 'helper').resolved_def.filepath, 't.c');
        const fromU = callee(idx(), 'run_u', 'helper');
        assert.deepEqual([fromU.resolved_def.filepath, fromU.ambiguous], ['t.c', false]);
      });

      it('CLI: the call tree labels nothing as a subtree it cannot justify', () => {
        if (skip()) return;
        const tree = runCLI(v.dir, ['--call-tree', 'doC']);
        assert.ok(/\[unresolved: [^\]]*find/.test(tree), tree);
        assert.ok(!/\n\s+find\s+\(/.test(tree), 'find must not appear as a resolved node');
        const callees = runCLI(v.dir, ['--callees', 'doC']);
        assert.ok(/find.*\[unresolved\]/.test(callees), callees);
        const inv = runCLI(v.dir, ['--call-inventory', 'doC']);
        assert.ok(/EXTERNAL[\s\S]*find/.test(inv), inv);
        assert.ok(/IN INDEX[\s\S]*push/.test(inv), inv);
      });
    });
  }
});
