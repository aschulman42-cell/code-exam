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

// The RESOLVER (#312's missing layer): four classes plus the residue, every
// classification naming its source. What is asserted is the RULE and its
// stated source, never a guess: a target no list/manifest/index confirms must
// come back external, saying so.
import { classifyImports, classifyImportRow, corpusFacts, manifestDeps } from '../src/core/imports.js';
import { doBom } from '../src/commands/imports.js';

describe('import classification (imports-bill-of-materials resolver)', () => {
  const stub = () => ({
    indexPath: '.stub',
    fileLines: new Map([
      ['app/Main.java', [
        'package com.corp.app;',
        'import com.corp.app.util.Helper;',
        'import java.util.List;',
        'import org.apache.commons.lang3.StringUtils;',
        'import org.mystery.Thing;',
      ]],
      ['app/util/Helper.java', ['package com.corp.app.util;']],
      ['native/core.c', [
        '#include "local.h"',
        '#include <stdio.h>',
        '#include <windows.h>',
        '#include "ven.h"',
        '#include <weird_platform.h>',
      ]],
      ['native/local.h', ['/* local */']],
      ['third_party/venlib/ven.h', ['/* vendored */']],
      ['web/app.js', [
        "import './x.js';",
        "import fs from 'node:fs';",
        "import _ from 'lodash';",
        "import lp from 'leftpad';",
      ]],
      ['web/x.js', ['export const x = 1;']],
      ['tools/runner.py', [
        'import config_parser',
        'import os',
        'import requests',
        'import numpy',
      ]],
      ['tools/config_parser.py', ['pass']],
      ['package.json', ['{ "dependencies": { "lodash": "^4.17.0" } }']],
      ['requirements.txt', ['requests>=2.31', '# a comment', '-r other.txt']],
      ['build.gradle', ["implementation 'org.apache.commons:commons-lang3:3.14.0'"]],
    ]),
  });

  it('classifies each language against its own rules, sources named', () => {
    const { rows, summary } = classifyImports(stub());
    const by = (target) => rows.find((r) => r.target === target || r.module === target);
    const expect = (target, cls, srcRe) => {
      const r = by(target);
      assert.ok(r, `row for ${target}`);
      assert.equal(r.cls, cls, `${target} -> ${cls} (got ${r.cls}: ${r.clsSource})`);
      assert.match(r.clsSource, srcRe, `${target} source`);
    };
    expect('com.corp.app.util.Helper', 'internal', /corpus declares package/);
    expect('java.util.List', 'stdlib', /java standard library/);
    expect('org.apache.commons.lang3.StringUtils', 'third-party', /indexed manifest/);
    expect('org.mystery.Thing', 'external', /not declared in any indexed manifest/);
    expect('local.h', 'internal', /resolves to `native\/local\.h`/);
    expect('stdio.h', 'stdlib', /ISO C\/C\+\+ standard header/);
    expect('windows.h', 'stdlib', /windows platform header/);
    expect('ven.h', 'vendored', /vendored subtree `third_party\/`/);
    expect('weird_platform.h', 'external', /no standard-list or index match/);
    expect('./x.js', 'internal', /relative specifier/);
    expect('node:fs.default', 'stdlib', /node builtin/);
    expect('lodash', 'third-party', /indexed manifest/);
    expect('leftpad', 'external', /not declared in any indexed manifest/);
    expect('config_parser', 'internal', /config_parser\.py.*in this index/);
    expect('os', 'stdlib', /python standard library/);
    expect('requests', 'third-party', /indexed manifest/);
    expect('numpy', 'external', /not declared/);
    for (const k of ['internal', 'stdlib', 'third-party', 'vendored', 'external']) {
      assert.ok(summary[k] > 0, `summary counts ${k}`);
    }
  });

  it('with no manifest indexed, the residue says exactly that', () => {
    const idx = stub();
    idx.fileLines.delete('package.json');
    idx.fileLines.delete('requirements.txt');
    idx.fileLines.delete('build.gradle');
    const { rows } = classifyImports(idx);
    const lodash = rows.find((r) => r.module === 'lodash');
    assert.equal(lodash.cls, 'external');
    assert.match(lodash.clsSource, /no manifest indexed to confirm/);
  });

  it('manifestDeps reads each manifest kind best-effort', () => {
    assert.ok(manifestDeps('p/package.json', ['{"dependencies":{"a":"1"},"devDependencies":{"b":"2"}}']).has('a'));
    assert.ok(manifestDeps('p/requirements.txt', ['flask==3.0', '# c', '-e .']).has('flask'));
    assert.ok(manifestDeps('p/build.gradle', ["api 'com.x:y:1.0'"]).has('com.x'));
    assert.ok(manifestDeps('p/pom.xml', ['<dependency>', '<groupId>org.g</groupId>', '<artifactId>art</artifactId>', '</dependency>']).has('org.g'));
    assert.ok(manifestDeps('p/app.csproj', ['<PackageReference Include="Newtonsoft.Json" Version="13" />']).has('Newtonsoft.Json'));
    assert.equal(manifestDeps('p/README.md', ['whatever']).size, 0);
  });

  it('a corpus that IS the platform library classifies its own packages internal', () => {
    const facts = corpusFacts({ fileLines: new Map([
      ['lib/Player.java', ['package androidx.media3.exoplayer;']],
    ]) });
    const r = classifyImportRow(
      { target: 'androidx.media3.common.Format', module: 'androidx.media3.common', name: 'Format', lang: 'java' },
      facts);
    // Declared corpus packages are checked BEFORE the platform lists — but
    // androidx.media3.common is NOT declared here, only ...exoplayer, so the
    // androidx list catches it; the sibling declared package stays internal.
    assert.equal(r.cls, 'stdlib');
    const r2 = classifyImportRow(
      { target: 'androidx.media3.exoplayer.Renderer', module: 'androidx.media3.exoplayer', name: 'Renderer', lang: 'java' },
      facts);
    assert.equal(r2.cls, 'internal');
    assert.match(r2.source, /corpus declares package/);
  });

  it('doBom renders rollup, ranked surface, vendored subtrees, and the residue note', () => {
    const out = [];
    const origLog = console.log; console.log = (s) => out.push(String(s));
    try { doBom(stub(), { _explicit: new Set() }); } finally { console.log = origLog; }
    const text = out.join('\n');
    assert.match(text, /Bill of materials — \.stub/);
    assert.match(text, /internal\s+\d+ site/);
    assert.match(text, /external\s+\d+ site\(s\) — UNCONFIRMED/);
    assert.match(text, /third_party\/\s+— \d+ indexed file/);
    assert.match(text, /Manifests indexed/);
    assert.match(text, /Residue: \d+ site\(s\)/);
    assert.match(text, /statement about what this index can show/);
  });
});
