// test_function_bounds.js — function-end detection: masked tokenizer, brace / arrow / indentation ends, prose-in-template guard, hybrid-merge dedupe, tree-sitter macro names and parse-error counts
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Red fixtures from the 2026-10-11 measurements (worklist item
// function-end-detection-accuracy, #343 ★A): the one-line arrow `kTok` that
// ran 594 -> 1068, `function rollup (...` prose inside the usage template
// literal, braces in strings / comments / regex literals cutting real
// functions short, Python spans running to the next def, the hybrid merge
// keeping a regex duplicate of a tree-sitter entry under another name, and
// tree-sitter naming every `TEST_F(Suite, Name)` just `TEST_F`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import {
  maskCodeLines, findBraceEnd, computeFunctionEnd, findIndentEnd, familyForExt,
  trimTrailingBlank, mergeRegexOnlyEntries, macroFunctionName,
} from '../src/core/function-bounds.js';
import { TreeSitterParser } from '../src/core/TreeSitterParser.js';

const TMP = path.join(os.tmpdir(), 'ce_test_function_bounds');

function regexParse(filename, source) {
  const idx = new CodeSearchIndex({ indexPath: path.join(TMP, '.unused') });
  idx.fileLines = new Map([[filename, source.split('\n')]]);
  return idx._parseFunctionsRegex(filename);
}

function span(funcs, name) {
  const e = funcs[name];
  assert.ok(e, `expected an entry named ${name}; have ${Object.keys(funcs).join(', ')}`);
  return [e.start, e.end];
}

// ---------------------------------------------------------------------------
describe('maskCodeLines', () => {
  it('blanks string, comment and regex-literal contents and keeps columns (JS)', () => {
    const src = [
      'const a = "x { y"; // c {',
      'const r = /[{]/; const d = 4 / 2 / 1;',
      '/* a',
      'b } */ let z = `t ${ {k:1} } u`;',
    ];
    const m = maskCodeLines(src, 'js');
    assert.equal(m.length, 4);
    for (let i = 0; i < src.length; i++) assert.equal(m[i].length, src[i].length, `line ${i} keeps its length`);
    assert.ok(!m[0].includes('{'), m[0]);
    assert.ok(!m[1].includes('['), m[1]);
    assert.ok(m[1].includes('4 / 2 / 1'), m[1]);
    assert.equal(m[2].trim(), '');
    assert.ok(m[3].includes('let z'), m[3]);
    assert.ok(m[3].includes('{k:1}'), 'interpolation code is kept');
    assert.ok(!m[3].includes('u`'), 'template text is masked');
  });
  it('python: # comments and triple-quoted strings across lines', () => {
    const src = ['def f():  # note {', '    s = """', 'not code {', '"""', '    return 1'];
    const m = maskCodeLines(src, 'python');
    assert.ok(!m[0].includes('{'));
    assert.equal(m[2].trim(), '');
    assert.ok(m[4].includes('return 1'));
  });
  it('unknown family returns the lines unchanged', () => {
    const src = ["' a VBScript comment {", 'Sub Go()'];
    assert.deepEqual(maskCodeLines(src, familyForExt('.vbs')), src);
  });
});

// ---------------------------------------------------------------------------
describe('findBraceEnd / computeFunctionEnd / trimTrailingBlank', () => {
  it('ignores braces in the parameter list and ends a declaration at its semicolon', () => {
    assert.deepEqual(findBraceEnd(['function f(opts = {}) {', '  return 1;', '}'], 0), { end: 3, kind: 'body' });
    assert.deepEqual(findBraceEnd(['int f(int a);', 'int g() {', '}'], 0), { end: 1, kind: 'declaration' });
  });
  it('treats C++ initializer-list brace groups as header, not body', () => {
    assert.deepEqual(findBraceEnd(['Foo::Foo() : a_{1}, b_{2} {', '  init();', '}'], 0), { end: 3, kind: 'body' });
  });
  it('trims trailing blank lines but never above start', () => {
    assert.equal(trimTrailingBlank(['a', '', '  ', 'b', ''], 1, 3), 1);
    assert.equal(trimTrailingBlank(['a', 'b', '', ''], 1, 4), 2);
  });
  it('returns null for a family without a strategy so the caller falls back', () => {
    assert.equal(computeFunctionEnd(['def x', 'end'], ['def x', 'end'], 0, 'hash'), null);
  });
});

// ---------------------------------------------------------------------------
describe('regex parser ends: JavaScript', () => {
  const JS = [
    /* 1 */ 'const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));',
    /* 2 */ '',
    /* 3 */ 'function outer(opts = {}) {',
    /* 4 */ '  // a comment with { brace',
    /* 5 */ '  const inner = (x) => {',
    /* 6 */ '    return x + 1;',
    /* 7 */ '  };',
    /* 8 */ '  const s = "} not an end";',
    /* 9 */ '  if (/[}]/.test(s)) {',
    /* 10 */ '    return inner(1);',
    /* 11 */ '  } else if (opts.x) {',
    /* 12 */ '    return 2;',
    /* 13 */ '  }',
    /* 14 */ '  return 0;',
    /* 15 */ '}',
    /* 16 */ '',
    /* 17 */ 'const usage = `',
    /* 18 */ 'function rollup ("which functions emit which events")',
    /* 19 */ 'const seeds = (a, b) => nothing here either',
    /* 20 */ '`;',
    /* 21 */ 'const tail = async (a) =>',
    /* 22 */ '  a.map((y) => y * 2)',
    /* 23 */ '    .filter(Boolean);',
    /* 24 */ '',
    /* 25 */ 'function last() {',
    /* 26 */ '  return 1;',
    /* 27 */ '}',
    /* 28 */ '',
    /* 29 */ '',
  ].join('\n');
  const funcs = regexParse('fixture.js', JS);

  it('a brace-less one-line arrow ends on its own line (the kTok case)', () => {
    assert.deepEqual(span(funcs, 'kTok'), [1, 1]);
  });
  it('braces in comments, strings and regex literals do not end or extend a function', () => {
    assert.deepEqual(span(funcs, 'outer'), [3, 15]);
  });
  it('a nested arrow keeps its own tight span and the outer keeps its real end', () => {
    assert.deepEqual(span(funcs, 'inner'), [5, 7]);
  });
  it('prose inside a template literal does not become a function (the rollup / seeds case)', () => {
    assert.ok(!('rollup' in funcs), 'rollup must not be a function');
    assert.ok(!('seeds' in funcs), 'seeds must not be a function');
  });
  it('an arrow whose body starts on the next line ends where the chained expression ends', () => {
    assert.deepEqual(span(funcs, 'tail'), [21, 23]);
  });
  it('trailing blank lines are not part of the last function', () => {
    assert.deepEqual(span(funcs, 'last'), [25, 27]);
  });
});

// ---------------------------------------------------------------------------
describe('regex parser ends: Python (indentation)', () => {
  const PY = [
    /* 1 */ 'def first(x):',
    /* 2 */ '    """Doc with',
    /* 3 */ 'unindented text',
    /* 4 */ '    """',
    /* 5 */ '    if x:',
    /* 6 */ '        return 1',
    /* 7 */ '    return 0',
    /* 8 */ '',
    /* 9 */ '# comment between',
    /* 10 */ 'CONST = compute()',
    /* 11 */ '',
    /* 12 */ 'class Thing:',
    /* 13 */ '    def m(self):',
    /* 14 */ '        return 2',
    /* 15 */ '',
    /* 16 */ '    def n(self):',
    /* 17 */ '        def helper():',
    /* 18 */ '            return 3',
    /* 19 */ '        return helper()',
    /* 20 */ '',
    /* 21 */ 'x = Thing()',
  ].join('\n');
  const funcs = regexParse('fixture.py', PY);
  const byBase = (base) => Object.values(funcs).filter(e => e.base_name === base);

  it('a def ends at its last indented line, not at the next def (module code excluded)', () => {
    assert.deepEqual(span(funcs, 'first'), [1, 7]);
  });
  it('a class spans all of its methods', () => {
    assert.deepEqual(span(funcs, 'Thing'), [12, 19]);
  });
  it('methods and a nested def each get their own span', () => {
    assert.deepEqual([byBase('m')[0].start, byBase('m')[0].end], [13, 14]);
    assert.deepEqual([byBase('n')[0].start, byBase('n')[0].end], [16, 19]);
    assert.deepEqual([byBase('helper')[0].start, byBase('helper')[0].end], [17, 18]);
  });
  it('findIndentEnd skips comment lines at outer indent without ending the block', () => {
    const lines = ['def f():', '    a = 1', '# stray comment', '    return a', 'b = 2'];
    const m = maskCodeLines(lines, 'python');
    assert.deepEqual(findIndentEnd(lines, m, 0), { end: 4, kind: 'indent' });
  });
});

// ---------------------------------------------------------------------------
describe('regex parser ends: C / C++', () => {
  const CC = [
    /* 1 */ 'struct Fwd;',
    /* 2 */ 'static int helper(const char *s) {',
    /* 3 */ "  if (s[0] == '{') return 1;",
    /* 4 */ '  return 0; /* } */',
    /* 5 */ '}',
    /* 6 */ 'Foo::Foo() : a_{1}, b_{2} {',
    /* 7 */ '  init();',
    /* 8 */ '}',
    /* 9 */ 'void Foo::Bar(int x)',
    /* 10 */ '{',
    /* 11 */ '  helper("}");',
    /* 12 */ '}',
    /* 13 */ 'TEST_F(PaintTest, Flattens) {',
    /* 14 */ '  helper("x");',
    /* 15 */ '}',
    /* 16 */ 'void Last() {',
    /* 17 */ '}',
  ].join('\n');
  const funcs = regexParse('fixture.cc', CC);

  it('a forward declaration ends on its own line', () => {
    assert.deepEqual(span(funcs, 'Fwd'), [1, 1]);
  });
  it('a char literal and a block comment do not move the end', () => {
    assert.deepEqual(span(funcs, 'helper'), [2, 5]);
  });
  it('a constructor with a brace-init member list ends at its body close', () => {
    assert.deepEqual(span(funcs, 'Foo::Foo'), [6, 8]);
  });
  it('an Allman-style body brace on the next line is found', () => {
    assert.deepEqual(span(funcs, 'Foo::Bar'), [9, 12]);
  });
  it('a Google Test macro function keeps its Suite::Name and ends at its own close', () => {
    assert.deepEqual(span(funcs, 'PaintTest::Flattens'), [13, 15]);
    assert.deepEqual(span(funcs, 'Last'), [16, 17]);
  });
});

// ---------------------------------------------------------------------------
describe('quoted and escaped braces never reach the brace counter', () => {
  it('JS: braces in strings, escape sequences, regex literals and template text', () => {
    const src = [
      'function a() {',
      "  const s1 = '{';",
      '  const s2 = "}}";',
      '  const s3 = "\\{\\}";',
      '  const r = /\\{[^}]*\\}/g;',
      '  const t = `{{ ${s1} }} \\` }`;',
      '  return s1 + s2 + s3 + r + t;',
      '}',
      'function b() {',
      '  return 2;',
      '}',
    ].join('\n');
    const f = regexParse('esc.js', src);
    assert.deepEqual(span(f, 'a'), [1, 8]);
    assert.deepEqual(span(f, 'b'), [9, 11]);
  });
  it('C: char literals, escaped quotes, a brace in a string and in a line comment', () => {
    const src = [
      'int a(void) {',
      "  char c = '}';",
      "  char d = '\\'';",
      '  const char *s = "{\\"}";',
      '  return 0; // {',
      '}',
      'int b(void) {',
      '  return 1;',
      '}',
    ].join('\n');
    const f = regexParse('esc.c', src);
    assert.deepEqual(span(f, 'a'), [1, 6]);
    assert.deepEqual(span(f, 'b'), [7, 9]);
  });
  it('Python: braces in f-strings and dict literals do not matter to indentation ends', () => {
    const src = ['def a(x):', "    s = f'{{{x}}}'", '    d = {"k": {"n": 1}}', '    return s, d', 'def b():', '    return 1'].join('\n');
    const f = regexParse('esc.py', src);
    assert.deepEqual(span(f, 'a'), [1, 4]);
    assert.deepEqual(span(f, 'b'), [5, 6]);
  });
});

// ---------------------------------------------------------------------------
describe('hybrid merge: mergeRegexOnlyEntries', () => {
  it('drops a regex duplicate at a tree-sitter start line, clamps a regex-only entry to its container, labels it', () => {
    const ts = {
      Outer: { start: 1, end: 40, type: 'function', base_name: 'Outer' },
      m: { start: 10, end: 10, type: 'function', base_name: 'm' },
    };
    const rx = {
      Outer: { start: 1, end: 45, type: 'function', base_name: 'Outer' },
      'Cls::m': { start: 10, end: 60, type: 'method', base_name: 'm' },
      local: { start: 20, end: 55, type: 'function', base_name: 'local' },
    };
    const merged = mergeRegexOnlyEntries({ ...ts }, rx);
    assert.ok(!('Cls::m' in merged), 'same start line: tree-sitter entry wins');
    assert.equal(merged.Outer.end, 40, 'tree-sitter entry kept as is');
    assert.equal(merged.Outer.parser, undefined, 'tree-sitter entries carry no parser field');
    assert.equal(merged.local.end, 40, 'regex-only entry clamped to its container');
    assert.equal(merged.local.parser, 'regex');
  });
  it('after a parse that recovered from errors, a longer regex end repairs the tree-sitter entry', () => {
    const ts = { doImports: { start: 124, end: 161, type: 'function', base_name: 'doImports' } };
    const rx = { doImports: { start: 124, end: 274, type: 'function', base_name: 'doImports' } };
    assert.equal(mergeRegexOnlyEntries({ ...ts }, rx).doImports.end, 161, 'no repair without the flag');
    const repaired = mergeRegexOnlyEntries({ ...ts }, rx, { parseHadErrors: true }).doImports;
    assert.deepEqual([repaired.end, repaired.parser], [274, 'regex-end']);
    const shorter = mergeRegexOnlyEntries({ ...ts }, { doImports: { ...rx.doImports, end: 150 } }, { parseHadErrors: true }).doImports;
    assert.equal(shorter.end, 161, 'a shorter regex end never shrinks the tree-sitter entry');
  });
});

describe('macroFunctionName', () => {
  it('names Google Test and generic macro-defined functions', () => {
    assert.equal(macroFunctionName('TEST_F', ['PaintTest', 'Flattens']), 'PaintTest::Flattens');
    assert.equal(macroFunctionName('DEFINE_METHOD', ['Foo', 'bar']), 'Foo::bar');
    assert.equal(macroFunctionName('DEFINE_THING', ['thing']), 'thing');
    assert.equal(macroFunctionName('DEF3', ['a', 'b', 'c']), 'a::b_c');
  });
});

// ---------------------------------------------------------------------------
describe('tree-sitter path (live wasm; skipped without grammars)', () => {
  const MACROS_CC = [
    '#include "foo.h"',
    'TEST_F(PaintTest, Flattens) {',
    '  helper1();',
    '}',
    'DEFINE_METHOD(Foo, bar) {',
    '  helper2();',
    '}',
    'void Foo::Baz() {',
    '  IPC_BEGIN_MESSAGE_MAP(Foo, msg)',
    '    IPC_MESSAGE_HANDLER(FooMsg_Go, OnGo)',
    '  IPC_END_MESSAGE_MAP()',
    '  helper3();',
    '}',
    'void Last() {',
    '  helper5();',
    '}',
  ];

  it('names macro-defined C++ functions from their arguments and records the macro', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    const r = await ts.parseFunctions('macros.cc', MACROS_CC);
    assert.ok(r, 'parsed');
    assert.ok(!('TEST_F' in r), `no entry named by the macro itself: ${Object.keys(r).join(', ')}`);
    assert.deepEqual([r['PaintTest::Flattens'].start, r['PaintTest::Flattens'].end], [2, 4]);
    assert.equal(r['PaintTest::Flattens'].macro, 'TEST_F');
    assert.equal(r['PaintTest::Flattens'].type, 'method');
    assert.deepEqual([r['Foo::bar'].start, r['Foo::bar'].end, r['Foo::bar'].macro], [5, 7, 'DEFINE_METHOD']);
    assert.deepEqual([r['Foo::Baz'].start, r['Foo::Baz'].end], [8, 13]);
    assert.equal(r['Foo::Baz'].macro, undefined);
    assert.deepEqual([r.Last.start, r.Last.end], [14, 16]);
  });

  it('counts files whose parse recovered from errors', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    assert.deepEqual(ts.stats, { filesWithErrors: 0, errorFiles: [] });
    await ts.parseFunctions('clean.js', ['function a() {', '  return 1;', '}']);
    assert.equal(ts.stats.filesWithErrors, 0);
    await ts.parseFunctions('stray.js', ['function b() {', '  return 2;', '}', '}', 'function c() {}']);
    assert.equal(ts.stats.filesWithErrors, 1);
    assert.deepEqual(ts.stats.errorFiles, ['stray.js']);
  });

  it('parses .tsx with the TSX grammar: JSX is not an error and the function after it is found', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    assert.ok(ts.getAvailableGrammars().includes('tsx'), 'tree-sitter-tsx.wasm is vendored in grammars/');
    const r = await ts.parseFunctions('card.tsx', [
      'import React from "react";',
      'export function Card({ title }: { title: string }) {',
      '  return <div className="card"><h1>{title}</h1></div>;',
      '}',
      'const Tiny = () => <span />;',
      'export function after() {',
      '  return 1;',
      '}',
    ]);
    assert.ok(r, 'parsed');
    assert.equal(ts.stats.filesWithErrors, 0, 'JSX must not be a parse error');
    assert.deepEqual([r.Card.start, r.Card.end], [2, 4]);
    assert.deepEqual([r.Tiny.start, r.Tiny.end], [5, 5]);
    assert.deepEqual([r.after.start, r.after.end], [6, 8]);
  });

  it('every vendored grammar in grammars/ is byte-identical to its npm package copy', () => {
    // The vendored files are plain copies of the prebuilt wasm the grammar
    // packages ship; a package bump without a re-copy would silently leave
    // users on the old grammar. Skipped per file when the (dev) package is
    // not installed.
    const PAIRS = {
      'tree-sitter-c.wasm': 'tree-sitter-c/tree-sitter-c.wasm',
      'tree-sitter-cpp.wasm': 'tree-sitter-cpp/tree-sitter-cpp.wasm',
      'tree-sitter-c-sharp.wasm': 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
      'tree-sitter-go.wasm': 'tree-sitter-go/tree-sitter-go.wasm',
      'tree-sitter-java.wasm': 'tree-sitter-java/tree-sitter-java.wasm',
      'tree-sitter-javascript.wasm': 'tree-sitter-javascript/tree-sitter-javascript.wasm',
      'tree-sitter-php.wasm': 'tree-sitter-php/tree-sitter-php.wasm',
      'tree-sitter-python.wasm': 'tree-sitter-python/tree-sitter-python.wasm',
      'tree-sitter-ruby.wasm': 'tree-sitter-ruby/tree-sitter-ruby.wasm',
      'tree-sitter-rust.wasm': 'tree-sitter-rust/tree-sitter-rust.wasm',
      'tree-sitter-typescript.wasm': 'tree-sitter-typescript/tree-sitter-typescript.wasm',
      'tree-sitter-tsx.wasm': 'tree-sitter-typescript/tree-sitter-tsx.wasm',
    };
    let compared = 0;
    for (const [vendored, npmRel] of Object.entries(PAIRS)) {
      const v = path.resolve('grammars', vendored);
      const n = path.resolve('node_modules', npmRel);
      assert.ok(fs.existsSync(v), `${vendored} is vendored`);
      if (!fs.existsSync(n)) continue;
      assert.ok(fs.readFileSync(v).equals(fs.readFileSync(n)), `${vendored} matches ${npmRel}`);
      compared++;
    }
    assert.ok(compared > 0 || !fs.existsSync(path.resolve('node_modules', 'tree-sitter-c')), 'compared at least one pair when packages are installed');
  });

  it('a --use-tree-sitter build keeps one entry per definition and labels regex-only entries', async () => {
    const ts = new TreeSitterParser();
    if (!(await ts.init())) return;
    const src = path.join(TMP, 'hybrid_src');
    const idxDir = path.join(TMP, '.hybrid_idx');
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'masker.js'), [
      'class Masker {',
      "  _isMasked = (s) => s.startsWith('#');",
      '  run(x) {',
      '    const log = (m) => console.log(m);',
      '    log(x);',
      '    return this._isMasked(x);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const idx = new CodeSearchIndex({ indexPath: idxDir });
    await idx.buildIndex(src, { showProgress: false, useTreeSitter: true });
    const fi = JSON.parse(fs.readFileSync(path.join(idxDir, 'function_index.json'), 'utf-8'));
    const entries = Object.entries(fi['masker.js'] || {});
    assert.ok(entries.length > 0, 'parsed masker.js');
    const starts = entries.map(([, e]) => e.start);
    assert.equal(new Set(starts).size, starts.length, `one entry per start line: ${entries.map(([n, e]) => n + '@' + e.start).join(', ')}`);
    for (const [, e] of entries) assert.ok(e.end >= e.start && e.end <= 9, `sane span ${e.start}-${e.end}`);
    for (const [, e] of entries) if (e.parser !== undefined) assert.equal(e.parser, 'regex');
    assert.ok(['tree-sitter', 'tree-sitter+regex'].includes(idx.parseMethod), idx.parseMethod);
    fs.rmSync(TMP, { recursive: true, force: true });
  });
});
