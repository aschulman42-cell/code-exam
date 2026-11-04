// test_treesitter_c_names.js — a C/C++ function's name never carries the token before it (CALLBACK, APIENTRY, a type the grammar could not place), on tree-sitter and the regex fallback
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// c-parser-macro-token-in-function-name (2026-11-03). On .WinAPI_Classic the
// index stored `CALLBACK WndProc`, `WINAPI CControl::ThreadFunction` and
// `APIENTRY` + newline + `BarWndProc`; on .ffmpeg `int64_t avio_tell`; on
// .x264 `uint32_t pack16to32`. When tree-sitter cannot place the token before
// the name, the declarator's text spans both, and the name absorbs it. A
// newline-bearing name was then written as two candidate lines and neither
// resolved. Counted in the HOF candidate lists: 1,408 space-bearing and 516
// newline-bearing names of 56,540 lines on WinAPI, 68 on ffmpeg, 10 on x264.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TreeSitterParser } from '../src/core/TreeSitterParser.js';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

const CPP = [
  '#include <windows.h>',
  'LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)',
  '{',
  '  return DefWindowProc(hwnd, msg, wParam, lParam);',
  '}',
  'LRESULT APIENTRY',
  'BarWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)',
  '{',
  '  return 0;',
  '}',
  'LRESULT CALLBACK App::WndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam)',
  '{',
  '  return 1;',
  '}',
  'DWORD WINAPI CControl::ThreadFunction(LPVOID p)',
  '{',
  '  return 2;',
  '}',
  'int foo(void)',
  '{',
  '  return 3;',
  '}',
  'int Widget::paint(int x)',
  '{',
  '  return x;',
  '}',
];

const C = [
  '#include <stdint.h>',
  'static av_always_inline int64_t avio_tell(AVIOContext *s)',
  '{',
  '  return s->pos;',
  '}',
  'static ALWAYS_INLINE uint32_t pack16to32(uint32_t a, uint32_t b)',
  '{',
  '  return a | (b << 16);',
  '}',
  'int plain(int a)',
  '{',
  '  return a;',
  '}',
];

const EXPECT_CPP = ['WndProc', 'BarWndProc', 'App::WndProc', 'CControl::ThreadFunction', 'foo', 'Widget::paint'];
const EXPECT_C = ['avio_tell', 'pack16to32', 'plain'];

const namesOf = (funcs) => Object.keys(funcs || {}).map((k) => k.replace(/@\d+$/, ''));
const noWhitespace = (names) => names.filter((n) => /\s/.test(n));

describe('C/C++ function names carry no leading token (tree-sitter)', () => {
  let ts = null;
  before(async () => {
    const p = new TreeSitterParser();
    ts = (await p.init()) ? p : null;
  });
  it('C++: CALLBACK, APIENTRY on the line above, a qualified name, WINAPI; the clean ones unchanged', async () => {
    if (!ts) return;
    const funcs = await ts.parseFunctions('win.cpp', CPP);
    assert.ok(funcs, 'tree-sitter parsed the file');
    const names = namesOf(funcs);
    assert.deepEqual(noWhitespace(names), [], `names with whitespace: ${JSON.stringify(noWhitespace(names))}`);
    for (const want of EXPECT_CPP) assert.ok(names.includes(want), `${want} missing from ${JSON.stringify(names)}`);
    assert.equal(funcs['BarWndProc'].start, 6, 'the record keeps the symbol\'s own start line');
    assert.equal(funcs['App::WndProc'].type, 'method');
    assert.equal(funcs['App::WndProc'].base_name, 'WndProc');
  });
  it('C: an attribute macro and a type the grammar could not place, before the name', async () => {
    if (!ts) return;
    const funcs = await ts.parseFunctions('avio.c', C);
    assert.ok(funcs, 'tree-sitter parsed the file');
    const names = namesOf(funcs);
    assert.deepEqual(noWhitespace(names), [], `names with whitespace: ${JSON.stringify(noWhitespace(names))}`);
    for (const want of EXPECT_C) assert.ok(names.includes(want), `${want} missing from ${JSON.stringify(names)}`);
  });
});

describe('C/C++ function names carry no leading token (regex fallback)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-c-names-'));
  const idx = new CodeSearchIndex({ indexPath: path.join(tmp, '.idx') });
  idx.fileLines.set('win.cpp', CPP);
  idx.fileLines.set('avio.c', C);
  it('C++ and C shapes', () => {
    const cpp = namesOf(idx._parseFunctionsRegex('win.cpp'));
    assert.deepEqual(noWhitespace(cpp), [], `names with whitespace: ${JSON.stringify(noWhitespace(cpp))}`);
    for (const want of EXPECT_CPP) assert.ok(cpp.includes(want), `${want} missing from ${JSON.stringify(cpp)}`);
    const c = namesOf(idx._parseFunctionsRegex('avio.c'));
    assert.deepEqual(noWhitespace(c), [], `names with whitespace: ${JSON.stringify(noWhitespace(c))}`);
    for (const want of EXPECT_C) assert.ok(c.includes(want), `${want} missing from ${JSON.stringify(c)}`);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
