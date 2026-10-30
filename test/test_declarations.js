// test_declarations.js — the module-level constant scanner behind evidence-pack constants: heads per language, where a declaration ends, the size floor, and the join to the functions that name each constant
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// pseudo-claims-pack-constants-components-anchors, part (a). The scanner is
// a line walker with a bracket/string tracker, not a parser; these fixtures
// pin the shapes it must get right (prompts, lists, regex tables, strings
// concatenated across lines) and the ones it must leave alone (one-line
// scalars, calls, brackets inside strings, regexes and comments).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findDeclarations, declarationsFor, constantsReferencedBy } from '../src/core/declarations.js';

const JS = [
  '// header',                                                    // 1
  'import x from "y";',                                           // 2
  'const SMALL = 1;',                                             // 3  one-line scalar: not data
  'export const PROMPT = `You are orienting a reader.',           // 4
  'Write 2-4 paragraphs (NOT a list).',                           // 5
  'Then the lists.`;',                                            // 6
  'const STOP = [',                                               // 7
  "  'data', 'value', // ( a bracket in a comment",               // 8
  "  'handle', 'item',",                                          // 9
  '];',                                                           // 10
  'const RE = /\\(/;',                                            // 11  a regex with an unbalanced paren inside
  'const TABLE = new RegExp([',                                   // 12
  "  '\\\\[x\\\\]',",                                             // 13
  "  '(a|b)',",                                                   // 14
  "].join('|'), 'g');",                                           // 15
  "const JOINED = 'first part ' +",                               // 16
  "  'second part ' +",                                           // 17
  "  'third part';",                                              // 18
  'const call = compute([1, 2]);',                                // 19  a call: not data
  'function f() { return PROMPT + STOP.length; }',                // 20
  "const WORDS = { a: 'one', b: 'two' };",                        // 21  one line, under the char floor
];

describe('findDeclarations: JavaScript', () => {
  const decls = findDeclarations(JS, 'src/a.js');
  const byName = Object.fromEntries(decls.map((d) => [d.name, d]));

  it('finds the template prompt, the list, the regex table and the concatenated string, with their line ranges', () => {
    assert.deepEqual(Object.keys(byName).sort(), ['JOINED', 'PROMPT', 'STOP', 'TABLE']);
    assert.deepEqual([byName.PROMPT.start, byName.PROMPT.end, byName.PROMPT.kind], [4, 6, 'string']);
    assert.deepEqual([byName.STOP.start, byName.STOP.end, byName.STOP.kind], [7, 10, 'array']);
    assert.deepEqual([byName.TABLE.start, byName.TABLE.end, byName.TABLE.kind], [12, 15, 'regex']);
    assert.deepEqual([byName.JOINED.start, byName.JOINED.end, byName.JOINED.kind], [16, 18, 'string']);
  });

  it('leaves out one-line scalars, calls and small one-line objects', () => {
    assert.ok(!byName.SMALL && !byName.call && !byName.WORDS && !byName.RE);
  });

  it('a bracket inside a comment, a string or a regex does not extend a declaration', () => {
    // STOP ends at line 10 despite the `(` in line 8's comment; RE's `\(`
    // does not swallow TABLE; TABLE's bracketed strings do not swallow JOINED.
    assert.equal(byName.STOP.end, 10);
    assert.equal(byName.TABLE.start, 12);
    assert.equal(byName.JOINED.start, 16);
  });

  it('the size floor is lines OR characters: a long one-liner counts', () => {
    const long = ['const RULE = "' + 'x'.repeat(300) + '";'];
    const d = findDeclarations(long, 'src/b.js');
    assert.equal(d.length, 1);
    assert.equal(d[0].chars > 200, true);
  });

  it('an unterminated value is bounded by maxLines, not scanned to the end of the file', () => {
    const lines = ['const A = [', ...Array.from({ length: 50 }, () => "  'x',")];
    const d = findDeclarations(lines, 'src/c.js', { maxLines: 10 });
    assert.equal(d.length, 1);
    assert.ok(d[0].end <= 11, `bounded: ended at ${d[0].end}`);
  });
});

describe('findDeclarations: other languages', () => {
  it('Python: a triple-quoted prompt and a list; a # comment with a bracket is ignored', () => {
    const py = ['import os', 'PROMPT = """You are', 'a helper.', '"""', 'STOP = [  # ( bracket', "  'a',", "  'b',", ']', 'x = run()'];
    const d = findDeclarations(py, 'pkg/mod.py');
    assert.deepEqual(d.map((x) => [x.name, x.start, x.end, x.kind]), [['PROMPT', 2, 4, 'string'], ['STOP', 5, 8, 'array']]);
  });

  it('Java: an ALL_CAPS static final array inside a class', () => {
    const java = ['class K {', '  private static final String[] STOP = {', '    "a", "b",', '  };', '  int n = 1;', '}'];
    const d = findDeclarations(java, 'src/K.java');
    assert.deepEqual(d.map((x) => [x.name, x.start, x.end]), [['STOP', 2, 4]]);
  });

  it('Go and Rust: a var slice and a const slice reference', () => {
    const go = ['package p', 'var Names = []string{', '  "a",', '  "b",', '}'];
    assert.deepEqual(findDeclarations(go, 'p/x.go').map((x) => [x.name, x.start, x.end]), [['Names', 2, 5]]);
    const rs = ['pub const NAMES: &[&str] = &[', '    "a",', '    "b",', '];'];
    assert.deepEqual(findDeclarations(rs, 'src/x.rs').map((x) => [x.name, x.start, x.end]), [['NAMES', 1, 4]]);
  });

  it('an extension the scanner does not know yields nothing rather than guesses', () => {
    assert.deepEqual(findDeclarations(['X = [', '1,', ']'], 'notes.txt'), []);
  });
});

describe('the join: which constants a group of functions names', () => {
  const idx = { fileLines: new Map([['src/a.js', JS]]) };
  const fn = (name, source, start, end) => ({ filepath: 'src/a.js', name, source, start, end });

  it('declarationsFor reads the index file lines and caches per file', () => {
    const a = declarationsFor(idx, 'src/a.js');
    const b = declarationsFor(idx, 'src/a.js');
    assert.equal(a, b, 'same array back from the cache');
    assert.equal(a.length, 4);
    assert.deepEqual(declarationsFor({}, 'src/a.js'), [], 'an index without fileLines yields nothing');
  });

  it('a function that names PROMPT and STOP gets both, ranked by how many functions name each', () => {
    const out = constantsReferencedBy(idx, [
      fn('f', 'function f() { return PROMPT + STOP.length; }', 20, 20),
      fn('g', 'function g() { return STOP; }', 21, 21),
    ]);
    assert.deepEqual(out.map((c) => [c.name, c.referencedBy]), [['STOP', ['f', 'g']], ['PROMPT', ['f']]]);
    assert.equal(out[0].start, 7);
    assert.match(out[0].source, /^const STOP = \[/);
    assert.match(out[0].source, /\];$/);
  });

  it('a name that merely looks like a constant is not a reference; the cap holds', () => {
    assert.deepEqual(constantsReferencedBy(idx, [fn('h', 'function h() { return PROMPTS; }', 1, 1)]), []);
    const capped = constantsReferencedBy(idx, [fn('f', 'PROMPT STOP TABLE JOINED', 1, 1)], { maxPerGroup: 2 });
    assert.equal(capped.length, 2);
  });

  it('a declaration inside the function\'s own range is not a module constant', () => {
    assert.deepEqual(constantsReferencedBy(idx, [fn('big', 'PROMPT', 1, 25)]), []);
  });
});
