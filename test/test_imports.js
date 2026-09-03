// test_imports.js -- imports-bill-of-materials tier 1: the per-language
// extractors. Same language-neutral row shape as Python; semantics mapped
// per language (relative = intra-project wiring; C quoted includes are the
// project-local form; star per language).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJsImports, extractCImports, extractJavaImports, extractCSharpImports,
  extractFileImports, isJsFile, isCFile, isJavaFile, isCSharpFile,
} from '../src/core/imports.js';

describe('extractJsImports', () => {
  it('default, named, aliased, namespace, bare, and require forms', () => {
    const rows = extractJsImports([
      "import fs from 'node:fs';",
      "import { readClaimFile, addLineNumbers as num } from './analyze.js';",
      "import * as path from 'path';",
      "import 'polyfill';",
      "const chalk = require('chalk');",
      "export { helper } from 'lib-a';",
      "export * from 'lib-b';",
    ], 'x.js');
    const t = (target) => rows.find((r) => r.target === target);
    assert.ok(t('node:fs.default') && t('node:fs.default').alias === 'fs');
    assert.ok(!rows.some((r) => r.module === './analyze.js'), 'relative skipped by default');
    assert.ok(t('path') && t('path').star && t('path').alias === 'path');
    assert.ok(t('polyfill'));
    assert.ok(t('chalk') && t('chalk').alias === 'chalk');
    assert.ok(t('lib-a.helper'), 're-export is an import');
    assert.ok(t('lib-b') && t('lib-b').star);
    assert.ok(rows.every((r) => r.lang === 'js'));
  });
  it('includeRelative admits ./ and ../ specifiers; multi-line named imports join', () => {
    const rel = extractJsImports(["import { a } from './x.js';"], 'y.js', { includeRelative: true });
    assert.equal(rel.length, 1);
    assert.ok(rel[0].relative);
    const multi = extractJsImports(['import {', '  alpha,', '  beta as b,', "} from 'wide-lib';"], 'z.js');
    assert.deepEqual(multi.map((r) => r.target).sort(), ['wide-lib.alpha', 'wide-lib.beta']);
  });
  it('a // comment does not hide an import and a commented line does not produce one', () => {
    const rows = extractJsImports([
      "import x from 'real'; // trailing note",
      "// import y from 'ghost';",
    ], 'c.js');
    assert.deepEqual(rows.map((r) => r.module), ['real']);
  });
});

describe('extractCImports', () => {
  it('angle includes are the external surface; quoted includes are relative and held back by default', () => {
    const lines = ['#include <stdio.h>', '#include "zlib.h"', '  #  include <sys/types.h>'];
    const rows = extractCImports(lines, 'a.c');
    assert.deepEqual(rows.map((r) => r.module), ['stdio.h', 'sys/types.h']);
    assert.ok(rows.every((r) => !r.relative && r.lang === 'c'));
    const all = extractCImports(lines, 'a.c', { includeRelative: true });
    assert.equal(all.length, 3);
    assert.ok(all.find((r) => r.module === 'zlib.h').relative);
  });
});

describe('extractJavaImports', () => {
  it('plain, static, and star imports; Kotlin without semicolon; no match on bare identifiers', () => {
    const rows = extractJavaImports([
      'import androidx.media3.common.Format;',
      'import static java.lang.Math.max;',
      'import java.util.*;',
      'import kotlinx.coroutines.flow',
      'importantVariable = 3;',
    ], 'A.java');
    assert.deepEqual(rows.map((r) => r.target), [
      'androidx.media3.common.Format', 'java.lang.Math.max', 'java.util.*', 'kotlinx.coroutines.flow',
    ]);
    assert.ok(rows[2].star && rows[2].name === '*');
    assert.equal(rows[0].name, 'Format');
    assert.equal(rows[0].module, 'androidx.media3.common');
  });
});

describe('extractCSharpImports', () => {
  it('namespace, alias, and static usings; using-statements never match', () => {
    const rows = extractCSharpImports([
      'using System.IO;',
      'using IO = System.IO.Compression;',
      'using static System.Math;',
      'using (var stream = File.OpenRead(path)) {',
    ], 'B.cs');
    assert.deepEqual(rows.map((r) => r.target), ['System.IO', 'System.IO.Compression', 'System.Math']);
    assert.equal(rows[1].alias, 'IO');
    assert.equal(rows[2].name, 'Math');
  });
});

describe('extractFileImports dispatch', () => {
  it('routes by extension, tags lang, returns null for unknown languages', () => {
    assert.equal(extractFileImports(['x'], 'a.rs'), null);
    assert.equal(extractFileImports(['import os'], 'a.py')[0].lang, 'py');
    assert.equal(extractFileImports(["import x from 'y';"], 'a.tsx')[0].lang, 'js');
    assert.equal(extractFileImports(['#include <a.h>'], 'a.hpp')[0].lang, 'c');
    assert.equal(extractFileImports(['import a.b.C;'], 'a.kt')[0].lang, 'java');
    assert.equal(extractFileImports(['using A.B;'], 'a.cs')[0].lang, 'cs');
  });
  it('the file classifiers agree with the dispatch', () => {
    assert.ok(isJsFile('m.mjs') && isCFile('x.cxx') && isJavaFile('k.kts') && isCSharpFile('p.cs'));
    assert.ok(!isJsFile('a.json') && !isCFile('a.cs'));
  });
});
