// test_imports.js — BoM tier 1: JS/C/Java/C# extractors, resolver classes, platform lists, residue
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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
    assert.equal(extractFileImports(['<script src="/vendor/x.js"></script>'], 'a.html')[0].lang, 'html');
    assert.equal(extractFileImports(['<script src="/vendor/x.js"></script>'], 'views/layout.php')[0].lang, 'html');
  });
  it('the file classifiers agree with the dispatch', () => {
    assert.ok(isJsFile('m.mjs') && isCFile('x.cxx') && isJavaFile('k.kts') && isCSharpFile('p.cs') && isHtmlFile('p.htm'));
    assert.ok(isTemplateFile('a.php') && isTemplateFile('show.html.erb') && isTemplateFile('page.cshtml') && isTemplateFile('t.jinja2'));
    assert.ok(!isJsFile('a.json') && !isCFile('a.cs') && !isHtmlFile('a.xml') && !isTemplateFile('a.vue') && !isTemplateFile('a.html'));
  });
});

// The RESOLVER (#312's missing layer): four classes plus the residue, every
// classification naming its source. What is asserted is the RULE and its
// stated source, never a guess: a target no list/manifest/index confirms must
// come back external, saying so.
import { classifyImports, classifyImportRow, corpusFacts, manifestDeps } from '../src/core/imports.js';
import { doBom } from '../src/commands/imports.js';
import { doCensusImports } from '../src/commands/census.js';
import { extractHtmlImports, libFromBasename, libFromUrl, htmlCoverageNote, isHtmlFile, isTemplateFile, tagsInCodeStrings, codeStringTagNote } from '../src/core/imports.js';
import { lockfileDeps, manifestDepKinds, bomJoins } from '../src/core/imports.js';

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
    assert.match(lodash.clsSource, /bare npm-style specifier/,
      'no-manifest rows state positive evidence, not the absence');
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
    assert.match(text, /external\s+\d+ site\(s\) — outside this index and the stated lists/);
    assert.match(text, /third_party\/\s+— \d+ indexed file/);
    assert.match(text, /Manifests indexed/);
    assert.match(text, /Manifests indexed \(corroborates third-party rows\)/);
    // The report says what it reads (import-reports-coverage-truth): the
    // Mermaid case — a library loaded by a <script> tag — is absent by design,
    // and the output, which travels as a file, must say so itself.
    assert.match(text, /Coverage: import and include statements in Python, JS\/TS, C\/C\+\+, Java\/Kotlin and C#,/);
    assert.match(text, /plus script, stylesheet and importmap tags in indexed HTML/);
    // The stub has JS and no HTML, so the conditional note fires.
    assert.match(text, /No HTML in this index: if the source has pages that load libraries/);
  });

  it('doCensusImports ends with the same coverage statement', () => {
    const out = [];
    const origLog = console.log; console.log = (s) => out.push(String(s));
    try { doCensusImports(stub(), { _explicit: new Set() }); } finally { console.log = origLog; }
    const text = out.join('\n');
    assert.match(text, /Import census — \d+ import sites/);
    assert.match(text, /Coverage: import and include statements in Python, JS\/TS, C\/C\+\+, Java\/Kotlin and C#,/);
    assert.match(text, /counted from the tag alone \(#27\)/);
    assert.match(text, /No HTML in this index/);
  });
});

describe('#pragma comment(lib) — the in-source linker surface', () => {
  it('extracts pragma libs as linkLib rows and classifies system vs external', () => {
    const rows = extractCImports([
      '#pragma comment(lib, "ws2_32.lib")',
      '#pragma comment(lib, "SomeVendorSdk.lib")',
      '#include <winsock2.h>',
    ], 'net/io.c');
    const libs = rows.filter((r) => r.linkLib);
    assert.equal(libs.length, 2);
    assert.equal(libs[0].target, 'ws2_32.lib');
    const facts = corpusFacts({ fileLines: new Map([['net/io.c', []]]) });
    const sys = classifyImportRow(libs[0], facts);
    assert.equal(sys.cls, 'stdlib');
    assert.match(sys.source, /windows system library/);
    const vendor = classifyImportRow(libs[1], facts);
    assert.equal(vendor.cls, 'external');
    assert.match(vendor.source, /linker input/);
  });
});

describe('platform-list gaps from .WinAPI_Classic (case, winrt/, WinRT., tlbimp)', () => {
  const facts = corpusFacts({ fileLines: new Map([['app/main.cpp', []]]) });
  const c = (module, extra = {}) => classifyImportRow({ target: module, module, name: null, lang: 'c', ...extra }, facts);
  const cs = (module) => classifyImportRow({ target: module, module, name: null, lang: 'cs' }, facts);

  it('header lists are case-insensitive; resolution keeps raw spelling', () => {
    const r = c('Windows.h');
    assert.equal(r.cls, 'stdlib');
    assert.match(r.source, /windows platform header/);
    assert.equal(c('STDIO.H').cls, 'stdlib');
  });

  it('winrt/ projection headers classify by SDK family', () => {
    const w = c('winrt/Windows.Foundation.h');
    assert.equal(w.cls, 'stdlib');
    assert.match(w.source, /Windows SDK/);
    const m = c('winrt/Microsoft.UI.Xaml.h');
    assert.equal(m.cls, 'stdlib');
    assert.match(m.source, /Windows App SDK/);
  });

  it('C# WinRT.* is the CsWinRT projection; XxxLib names the tlbimp convention', () => {
    const w = cs('WinRT.Interop');
    assert.equal(w.cls, 'stdlib');
    assert.match(w.source, /CsWinRT/);
    const f = cs('FAXCOMEXLib');
    assert.equal(f.cls, 'external', 'COM origin not determinable — stays external');
    assert.match(f.source, /tlbimp convention/);
  });
});

// bom-small-fixes-sweep-residue: six list/regex fixes named by the 52-index
// sweep (multi_index_BOM.txt, 2026-09-04). Each asserts the RULE the sweep
// showed missing, and that its why-line names the list that fired.
// bom-html-loaded-libraries: what a page LOADS. One fixture page carries
// every tag kind, a commented-out tag, a data: URL, a data-src decoy and a
// tag that spans lines; Mermaid's own case (a vendored bundle the index never
// holds, loaded by one <script> tag) is the row the item exists for.
describe('HTML-loaded libraries (bom-html-loaded-libraries)', () => {
  const page = [
    '<!doctype html>',
    '<html><head>',
    '  <link rel="icon" href="favicon.ico">',
    '  <link rel="stylesheet" href="/vendor/bootstrap-5.3.2.min.css">',
    '  <link rel="modulepreload" href="./app.js">',
    '  <script type="importmap">',
    '  { "imports": { "vue": "https://cdn.jsdelivr.net/npm/vue@3.4.0/dist/vue.esm-browser.js",',
    '                 "lodash": "./lib/lodash.min.js" } }',
    '  </script>',
    '  <!-- <script src="/vendor/old-thing.min.js"></script> -->',
    '  <script src="data:text/javascript;base64,AAAA"></script>',
    '  <script',
    '    src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js"',
    '    defer></script>',
    '</head><body>',
    "  <script src='/vendor/mermaid.min.js'></script>",
    '  <script src="app.js" data-src="not-this.js"></script>',
    '</body></html>',
  ];
  const webIndex = () => ({
    indexPath: '.web',
    fileLines: new Map([
      ['web/index.html', page],
      ['web/app.js', ["import p from 'https://esm.sh/preact@10.19.3';", 'export const a = 1;']],
      ['web/lib/lodash.min.js', ['/* a copy of lodash carried in lib/ */']],
      ['package.json', ['{ "dependencies": { "vue": "^3.4.0", "lodash": "^4.17.0" } }']],
    ]),
    skippedExtensions: {},
  });
  // A server-side template is a page too: tags with literal paths, a vendored
  // path, templated values with and without a literal asset inside.
  const phpIndex = () => ({
    indexPath: '.php',
    fileLines: new Map([
      ['views/layout.php', [
        '<?php $v = "1.9.10"; ?>',
        '<html><head>',
        '<script src="/vendor/htmx-1.9.10.min.js"></script>',
        '<script src="<?= asset(\'js/app.js\') ?>"></script>',
        '<script src="{{ static(\'vendor/chart.umd.min.js\') }}"></script>',
        '<script src="<?= $dynamic ?>"></script>',
        '</head></html>',
      ]],
      ['public/js/app.js', ['export const a = 1;']],
    ]),
    skippedExtensions: {},
  });
  const capture = (fn) => {
    const out = [];
    const orig = console.log; console.log = (s) => out.push(String(s));
    try { fn(); } finally { console.log = orig; }
    return out.join('\n');
  };

  it('extractHtmlImports reads script, stylesheet, modulepreload and importmap tags; skips comments, data: URLs and data-src', () => {
    const rows = extractHtmlImports(page, 'web/index.html', { includeRelative: true });
    assert.deepEqual(rows.map((r) => [r.module, r.kind, r.line]), [
      ['/vendor/bootstrap-5.3.2.min.css', 'stylesheet', 4],
      ['./app.js', 'modulepreload', 5],
      ['https://cdn.jsdelivr.net/npm/vue@3.4.0/dist/vue.esm-browser.js', 'importmap', 7],
      ['./lib/lodash.min.js', 'importmap', 8],
      ['https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'script-tag', 12],
      ['/vendor/mermaid.min.js', 'script-tag', 16],
      ['app.js', 'script-tag', 17],
    ]);
    const by = (m) => rows.find((r) => r.module === m);
    const bs = by('/vendor/bootstrap-5.3.2.min.css');
    assert.deepEqual([bs.libName, bs.libVersion, bs.relative], ['bootstrap', '5.3.2', false], 'a vendored path is a library, not the page\'s own asset');
    assert.equal(by('./app.js').relative, true);
    const vue = by('https://cdn.jsdelivr.net/npm/vue@3.4.0/dist/vue.esm-browser.js');
    assert.deepEqual([vue.url, vue.host, vue.libName, vue.libVersion, vue.importName], [true, 'cdn.jsdelivr.net', 'vue', '3.4.0', 'vue']);
    const jq = by('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js');
    assert.deepEqual([jq.host, jq.libName, jq.libVersion, jq.target], ['cdnjs.cloudflare.com', 'jquery', '3.7.1', 'jquery']);
    const mm = by('/vendor/mermaid.min.js');
    assert.deepEqual([mm.libName, mm.libVersion, mm.relative, mm.lang], ['mermaid', null, false, 'html']);
    // The census view (no includeRelative) keeps the libraries and drops the page's own assets.
    assert.deepEqual(extractHtmlImports(page, 'web/index.html').map((r) => r.target), ['bootstrap', 'vue', 'jquery', 'mermaid']);
  });

  it('libFromBasename and libFromUrl name the library and version from filenames and CDN paths', () => {
    assert.deepEqual(libFromBasename('jquery-3.7.1.min.js'), { name: 'jquery', version: '3.7.1' });
    assert.deepEqual(libFromBasename('mermaid.min.js'), { name: 'mermaid', version: null });
    assert.deepEqual(libFromBasename('bootstrap.bundle.min.js'), { name: 'bootstrap', version: null });
    assert.deepEqual(libFromBasename('d3.v7.min.js'), { name: 'd3', version: '7' });
    assert.deepEqual(libFromBasename('vue.global.prod.js'), { name: 'vue', version: null });
    assert.deepEqual(libFromBasename('react-dom.development.js'), { name: 'react-dom', version: null });
    const u = (s) => { const l = libFromUrl(s); return [l.host, l.name, l.version]; };
    assert.deepEqual(u('https://cdn.jsdelivr.net/npm/@scope/pkg@1.2.3/dist/x.js'), ['cdn.jsdelivr.net', '@scope/pkg', '1.2.3']);
    assert.deepEqual(u('https://cdn.jsdelivr.net/gh/user/repo@v2.0/lib.js'), ['cdn.jsdelivr.net', 'repo', '2.0']);
    assert.deepEqual(u('https://unpkg.com/three@0.160.0/build/three.module.js'), ['unpkg.com', 'three', '0.160.0']);
    assert.deepEqual(u('https://esm.sh/preact@10.19.3'), ['esm.sh', 'preact', '10.19.3']);
    assert.deepEqual(u('https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js'), ['ajax.googleapis.com', 'jquery', '3.7.1']);
    assert.deepEqual(u('//static.example.com/js/htmx-1.9.10.min.js'), ['static.example.com', 'htmx', '1.9.10']);
    assert.equal(libFromUrl('not a url'), null);
  });

  it('classifies what the page loads: vendored by path shape, CDN by host (third-party when the manifest declares it), own assets internal', () => {
    const { rows, summary, filesByLang } = classifyImports(webIndex());
    const by = (m) => rows.find((r) => r.module === m);
    const expect = (m, cls, re) => { const r = by(m); assert.ok(r, m); assert.equal(r.cls, cls, `${m}: ${r.clsSource}`); assert.match(r.clsSource, re); };
    expect('/vendor/mermaid.min.js', 'vendored', /vendored directory \(`vendor\/`\), which the index skips/);
    expect('/vendor/bootstrap-5.3.2.min.css', 'vendored', /stylesheet in `web\/index\.html:4`/);
    expect('https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'external', /loaded from `cdnjs\.cloudflare\.com` by script-tag/);
    expect('https://cdn.jsdelivr.net/npm/vue@3.4.0/dist/vue.esm-browser.js', 'third-party', /declared in an indexed manifest \(`vue`\); loaded from `cdn\.jsdelivr\.net`/);
    // A library copy under a non-vendor name is third-party when the manifest declares it, with the copy's location named.
    expect('./lib/lodash.min.js', 'third-party', /declared in an indexed manifest \(`lodash`\); a copy at `web\/lib\/lodash\.min\.js` is loaded by importmap/);
    expect('app.js', 'internal', /resolves to `web\/app\.js` in this index/);
    expect('./app.js', 'internal', /resolves to `web\/app\.js`/);
    expect('https://esm.sh/preact@10.19.3', 'external', /URL import, loaded from `esm\.sh`/);
    assert.equal(filesByLang.html, 1);
    assert.equal(summary.vendored, 2);
  });

  it('page templates are scanned like HTML: literal paths resolve, templated values resolve by their quoted asset, or say they cannot', () => {
    const rows = extractHtmlImports(phpIndex().fileLines.get('views/layout.php'), 'views/layout.php', { includeRelative: true });
    assert.deepEqual(rows.map((r) => [r.module, r.libName, r.templated || false, r.templatedPath || null, r.relative]), [
      ['/vendor/htmx-1.9.10.min.js', 'htmx', false, null, false],
      ["<?= asset('js/app.js') ?>", 'app', true, 'js/app.js', true],
      ["{{ static('vendor/chart.umd.min.js') }}", 'chart', true, 'vendor/chart.umd.min.js', false],
      ['<?= $dynamic ?>', '<?= $dynamic ?>', true, null, true],
    ]);
    // The census view keeps the two libraries and drops the page's own wiring, templated or not.
    assert.deepEqual(extractHtmlImports(phpIndex().fileLines.get('views/layout.php'), 'views/layout.php').map((r) => r.target), ['htmx', 'chart']);
    const { rows: classified, filesByLang } = classifyImports(phpIndex());
    const by = (m) => classified.find((r) => r.module === m);
    assert.equal(by('/vendor/htmx-1.9.10.min.js').cls, 'vendored');
    assert.equal(by("<?= asset('js/app.js') ?>").cls, 'internal');
    assert.match(by("<?= asset('js/app.js') ?>").clsSource, /resolves to `public\/js\/app\.js` in this index \(script-tag, templated src\)/);
    assert.equal(by("{{ static('vendor/chart.umd.min.js') }}").cls, 'vendored');
    assert.match(by("{{ static('vendor/chart.umd.min.js') }}").clsSource, /\(templated src\) loads `vendor\/chart\.umd\.min\.js` under a vendored directory/);
    assert.equal(by('<?= $dynamic ?>').cls, 'external');
    assert.match(by('<?= $dynamic ?>').clsSource, /template expression \(`<\?= \$dynamic \?>`\) with no literal path to resolve/);
    assert.equal(filesByLang.html, 1, 'a template counts as an HTML-class file');
  });

  it('--bom and the census show what the page loads, name the version, and say their coverage', () => {
    const bom = capture(() => doBom(webIndex(), { _explicit: new Set() }));
    assert.match(bom, /of which\s+7 site\(s\) are script\/stylesheet\/importmap tags in indexed HTML or page templates/);
    assert.match(bom, /vendored\s+mermaid\s+script-tag in `web\/index\.html:16`/);
    assert.match(bom, /vendored\s+bootstrap@5\.3\.2\s+stylesheet/);
    assert.match(bom, /external\s+jquery@3\.7\.1\s+loaded from `cdnjs\.cloudflare\.com`/);
    assert.match(bom, /third-party\s+vue@3\.4\.0\s+declared in an indexed manifest/);
    assert.match(bom, /third-party\s+lodash\s+declared in an indexed manifest \(`lodash`\); a copy at `web\/lib\/lodash\.min\.js`/);
    assert.match(bom, /external\s+preact@10\.19\.3\s+URL import, loaded from `esm\.sh`/);
    assert.match(bom, /plus script, stylesheet and importmap tags in indexed HTML/);
    assert.doesNotMatch(bom, /No HTML in this index/);
    const census = capture(() => doCensusImports(webIndex(), { _explicit: new Set() }));
    assert.match(census, /1 HTML/);
    assert.match(census, /\bmermaid\b/);
    assert.match(census, /counted from the tag alone \(#27\)/);
    assert.doesNotMatch(census, /No HTML in this index/);
    // Nothing in the web index emits HTML from code, so no signpost.
    assert.doesNotMatch(bom, /inside non-page files/);
    assert.doesNotMatch(census, /inside non-page files/);
  });

  it('HTML emitted by code is signposted, not counted: the jdiff case', () => {
    // .android-1.5-java: two Java sites write the Google Analytics tag into
    // generated reports. Not a dependency of the program; the reports say the
    // strings exist and point at --referenced-resources.
    const idx = {
      indexPath: '.jdiff',
      fileLines: new Map([
        ['jdiff/HTMLReportGenerator.java', [
          'package jdiff;',
          'public class HTMLReportGenerator {',
          '  void writeHTMLFooter() {',
          '    writeText("<script src=\\"http://www.google-analytics.com/ga.js\\" type=\\"text/javascript\\">");',
          '  }',
          '}',
        ]],
        ['jdiff/HTMLStatistics.java', [
          'package jdiff;',
          '  h_.writeText("<script src=\\"http://www.google-analytics.com/ga.js\\" type=\\"text/javascript\\">");',
          '  h_.writeText("<link rel=\\"stylesheet\\" href=\\"stylesheet-jdiff.css\\">");',
        ]],
        ['jdiff/Notes.java', ['// a <script> in a comment with no src is not a tag-shaped string']],
        ['web/page.html', ['<script src="/vendor/x.js"></script>']],
      ]),
      skippedExtensions: {},
    };
    assert.deepEqual(tagsInCodeStrings(idx), { sites: 3, files: 2 });
    assert.equal(codeStringTagNote({ sites: 0, files: 0 }), null);
    assert.match(codeStringTagNote(tagsInCodeStrings(idx)), /^3 script\/link tag\(s\) inside non-page files \(code strings, docs\) in 2 file\(s\), not counted above; --referenced-resources catalogues the URLs they name\.$/);
    const bom = capture(() => doBom(idx, { _explicit: new Set() }));
    assert.match(bom, /3 script\/link tag\(s\) inside non-page files .* in 2 file\(s\), not counted above/);
    assert.doesNotMatch(bom, /google-analytics/, 'the emitted tag is not a BoM row');
    const census = capture(() => doCensusImports(idx, { _explicit: new Set() }));
    assert.match(census, /3 script\/link tag\(s\) inside non-page files/);
  });

  it('htmlCoverageNote names skipped HTML, or the conditional form for a JS index with no HTML', () => {
    assert.match(htmlCoverageNote({ skippedExtensions: { '.html': 3 } }, { js: 2 }), /^3 HTML file\(s\) were not indexed at build/);
    assert.match(htmlCoverageNote({ skippedExtensions: {} }, { js: 2 }), /^No HTML in this index/);
    assert.equal(htmlCoverageNote({ skippedExtensions: {} }, { js: 2, html: 1 }), null);
    assert.equal(htmlCoverageNote({}, { py: 4 }), null);
  });
});

// bom-lockfiles-resolved-tree: what gets installed. Hand-built lockfiles of
// each kind, the facts they feed, the rows they enrich, the joins they make
// decidable, and the --bom sections that print them.
describe('lockfiles: resolved tree, sources and the joins (bom-lockfiles-resolved-tree)', () => {
  const npmLockV3 = [JSON.stringify({
    name: 'app', lockfileVersion: 3,
    packages: {
      '': { dependencies: { alpha: '^1.0.0', echo: '^2.0.0' }, devDependencies: { bravo: '^3.0.0' } },
      'node_modules/alpha': { version: '1.2.3', resolved: 'https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz' },
      'node_modules/echo': { version: '2.0.0', resolved: 'https://registry.npmjs.org/echo/-/echo-2.0.0.tgz' },
      'node_modules/bravo': { version: '3.0.1', resolved: 'https://registry.npmjs.org/bravo/-/bravo-3.0.1.tgz', dev: true },
      'node_modules/charlie': { version: '0.9.0', resolved: 'git+ssh://git@github.com/x/charlie.git#abc123' },
      'node_modules/alpha/node_modules/delta': { version: '4.0.0', resolved: 'https://npm.example.corp/delta/-/delta-4.0.0.tgz' },
    },
  })];
  const capture = (fn) => {
    const out = [];
    const orig = console.log; console.log = (s) => out.push(String(s));
    try { fn(); } finally { console.log = orig; }
    return out.join('\n');
  };
  const appIndex = () => ({
    indexPath: '.app',
    fileLines: new Map([
      ['package.json', [JSON.stringify({ dependencies: { alpha: '^1.0.0', echo: '^2.0.0' }, devDependencies: { bravo: '^3.0.0' } })]],
      ['package-lock.json', npmLockV3],
      ['src/main.js', ["import a from 'alpha';", "import c from 'charlie';", "import z from 'zulu';", "import fs from 'node:fs';"]],
      ['rs/Cargo.toml', ['[package]', 'name = "tool"', '[dependencies]', 'serde = "1"', '[dev-dependencies]', 'pretty_assertions = "1"']],
      ['rs/Cargo.lock', ['[[package]]', 'name = "serde"', 'version = "1.0.200"', 'source = "registry+https://github.com/rust-lang/crates.io-index"', '',
        '[[package]]', 'name = "tool"', 'version = "0.1.0"', 'dependencies = [', ' "serde 1.0.200",', ']', '',
        '[[package]]', 'name = "pretty_assertions"', 'version = "1.4.0"', 'source = "git+https://github.com/rust-pretty-assertions/rust-pretty-assertions?rev=deadbeef"']],
      ['go/go.mod', ['module example.com/svc', 'go 1.22', 'require github.com/stretchr/testify v1.9.0']],
      ['web/yarn.lock', ['# yarn lockfile v1']],
    ]),
    skippedExtensions: {},
  });

  it('lockfileDeps reads package-lock v3 and v1: entries, direct set, nested copies, sources', () => {
    const v3 = lockfileDeps('package-lock.json', npmLockV3);
    assert.equal(v3.kind, 'npm');
    assert.deepEqual([v3.total, v3.directCount, [...v3.direct].sort()], [5, 3, ['alpha', 'bravo', 'echo']]);
    assert.deepEqual([...v3.hosts.entries()], [['registry.npmjs.org', 3], ['npm.example.corp', 1]]);
    assert.deepEqual(v3.nonRegistry.map((n) => n.name), ['charlie']);
    assert.equal(v3.packages.get('delta').nested, true);
    assert.equal(v3.packages.get('bravo').dev, true);
    const v1 = lockfileDeps('package-lock.json', [JSON.stringify({ lockfileVersion: 1, dependencies: {
      alpha: { version: '1.2.3', resolved: 'https://registry.npmjs.org/alpha/-/alpha-1.2.3.tgz', dependencies: { delta: { version: '4.0.0' } } },
    } })]);
    assert.deepEqual([v1.total, v1.direct.size, v1.packages.get('delta').nested], [2, 0, true]);
  });

  it('lockfileDeps reads Pipfile.lock, composer.lock, go.sum, Cargo.lock and poetry.lock', () => {
    const pip = lockfileDeps('Pipfile.lock', [JSON.stringify({ _meta: { sources: [{ name: 'pypi', url: 'https://pypi.org/simple' }] },
      default: { requests: { version: '==2.31.0', index: 'pypi' } }, develop: { pytest: { version: '==8.0.0' } } })]);
    assert.deepEqual([pip.kind, pip.total, pip.packages.get('requests').version, pip.packages.get('pytest').dev, [...pip.hosts.entries()]], ['pipenv', 2, '2.31.0', true, [['pypi.org', 2]]]);
    const comp = lockfileDeps('composer.lock', [JSON.stringify({ packages: [{ name: 'monolog/monolog', version: '3.5.0', dist: { url: 'https://api.github.com/repos/Seldaek/monolog/zipball/abc' } }], 'packages-dev': [] })]);
    assert.deepEqual([comp.kind, comp.total, [...comp.hosts.keys()]], ['composer', 1, ['api.github.com']]);
    const gosum = lockfileDeps('go.sum', ['github.com/stretchr/testify v1.9.0 h1:abc=', 'github.com/stretchr/testify v1.9.0/go.mod h1:def=', 'golang.org/x/sys v0.20.0 h1:ghi=']);
    assert.deepEqual([gosum.kind, gosum.total, gosum.packages.get('github.com/stretchr/testify').version, [...gosum.hosts.entries()]], ['go', 2, 'v1.9.0', [['github.com', 1], ['golang.org', 1]]]);
    const cargo = lockfileDeps('Cargo.lock', appIndex().fileLines.get('rs/Cargo.lock'));
    assert.deepEqual([cargo.kind, cargo.total, [...cargo.hosts.entries()], cargo.nonRegistry.map((n) => n.name)], ['cargo', 3, [['crates.io', 1]], ['pretty_assertions']]);
    assert.equal(cargo.packages.get('tool').source, null, 'a workspace member has no source');
    const poetry = lockfileDeps('poetry.lock', ['[[package]]', 'name = "httpx"', 'version = "0.27.0"', 'category = "main"', '',
      '[[package]]', 'name = "mylib"', 'version = "0.1.0"', 'category = "dev"', '', '[package.source]', 'type = "git"', 'url = "https://github.com/me/mylib.git"']);
    assert.deepEqual([poetry.kind, poetry.total, poetry.packages.get('mylib').dev, poetry.nonRegistry.map((n) => n.name)], ['poetry', 2, true, ['mylib']]);
    assert.equal(lockfileDeps('README.md', ['x']).kind, null);
  });

  it('manifestDepKinds separates runtime from dev/peer/optional where the manifest says', () => {
    const k = manifestDepKinds('package.json', [JSON.stringify({ dependencies: { a: '1' }, devDependencies: { b: '1' }, peerDependencies: { c: '1' } })]);
    assert.deepEqual([k.get('a'), k.get('b'), k.get('c')], ['runtime', 'dev', 'peer']);
    assert.equal(manifestDepKinds('requirements-dev.txt', ['pytest==8']).get('pytest'), 'dev');
    const c = manifestDepKinds('Cargo.toml', appIndex().fileLines.get('rs/Cargo.toml'));
    assert.deepEqual([c.get('serde'), c.get('pretty_assertions')], ['runtime', 'dev']);
  });

  it('corpusFacts carries the lockfiles: direct set from the lockfile or the manifest beside it, unread kinds named, manifests without a lockfile', () => {
    const facts = corpusFacts(appIndex());
    const by = (f) => facts.lockfiles.find((l) => l.file === f);
    assert.deepEqual(facts.lockfiles.map((l) => [l.file, l.kind, l.read]), [['package-lock.json', 'npm', true], ['rs/Cargo.lock', 'cargo', true], ['web/yarn.lock', 'yarn', false]]);
    assert.equal(by('package-lock.json').directFrom, undefined, 'package-lock v3 names its own direct set');
    assert.deepEqual([by('rs/Cargo.lock').directFrom, by('rs/Cargo.lock').directCount], ['rs/Cargo.toml', 2], 'Cargo.lock takes its direct set from Cargo.toml');
    assert.deepEqual(facts.lockedVersions.get('alpha'), { version: '1.2.3', file: 'package-lock.json', name: 'alpha' });
    assert.deepEqual(facts.manifestsNoLock, [{ file: 'go/go.mod', kind: 'go' }]);
  });

  it('rows carry the lockfile evidence: locked versions on third-party rows, transitive presence on the residue', () => {
    const { rows } = classifyImports(appIndex());
    const by = (m) => rows.find((r) => r.module === m);
    assert.equal(by('alpha').cls, 'third-party');
    assert.match(by('alpha').clsSource, /declared in an indexed manifest \(`alpha`\), locked at 1\.2\.3/);
    assert.equal(by('charlie').cls, 'external');
    assert.match(by('charlie').clsSource, /not declared in any indexed manifest; present in `package-lock\.json` as a transitive dependency \(0\.9\.0\)/);
    assert.equal(by('zulu').cls, 'external');
    assert.equal(by('zulu').clsSource, 'not declared in any indexed manifest');
  });

  it('scoped packages that share a last segment keep their own locked versions (@a/sdk vs @b/sdk)', () => {
    const idx = {
      indexPath: '.scoped',
      fileLines: new Map([
        ['package.json', [JSON.stringify({ dependencies: { '@a/sdk': '^1', '@b/sdk': '^2' } })]],
        ['package-lock.json', [JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@a/sdk': '^1', '@b/sdk': '^2' } },
          'node_modules/@a/sdk': { version: '1.0.0' }, 'node_modules/@b/sdk': { version: '2.0.0' } } })]],
        ['m.js', ["import a from '@a/sdk';", "import b from '@b/sdk';"]],
      ]),
    };
    const { rows } = classifyImports(idx);
    assert.match(rows.find((r) => r.module === '@a/sdk').clsSource, /locked at 1\.0\.0/);
    assert.match(rows.find((r) => r.module === '@b/sdk').clsSource, /locked at 2\.0\.0/);
  });

  it('bomJoins: declared-not-imported (runtime apart from dev), imported-not-declared (transitive or absent), declared-not-locked', () => {
    const idx = appIndex();
    // echo is declared and locked but imported nowhere; foxtrot is declared and never locked.
    idx.fileLines.set('package.json', [JSON.stringify({ dependencies: { alpha: '^1.0.0', echo: '^2.0.0', foxtrot: '^1.0.0' }, devDependencies: { bravo: '^3.0.0' } })]);
    const { rows, facts } = classifyImports(idx);
    const j = bomJoins(rows, facts);
    assert.equal(j.checked, true);
    assert.deepEqual(j.declaredNotImported, [{ manifest: 'package.json', runtime: ['echo', 'foxtrot'], dev: ['bravo'] }]);
    assert.deepEqual(j.importedNotDeclared, { transitive: [{ pkg: 'charlie', lockfile: 'package-lock.json', version: '0.9.0' }], absent: ['zulu'] });
    assert.deepEqual(j.declaredNotLocked, [{ manifest: 'package.json', lockfile: 'package-lock.json', names: ['foxtrot'] }]);
    const none = bomJoins([], corpusFacts({ fileLines: new Map([['a.c', ['#include <stdio.h>']]]) }));
    assert.equal(none.checked, false, 'no npm or Python manifest: nothing to join');
  });

  it('--bom prints the Resolved section, the joins and the lockfile coverage line', () => {
    const text = capture(() => doBom(appIndex(), { _explicit: new Set() }));
    assert.match(text, /Resolved by lockfiles \(what gets installed; says nothing about runtime reach\):/);
    assert.match(text, /package-lock\.json — 5 package\(s\): 3 direct, 2 transitive/);
    assert.match(text, /sources: registry\.npmjs\.org \(3\), npm\.example\.corp \(1\)/);
    assert.match(text, /non-registry source: charlie@0\.9\.0 <- git\+ssh:\/\/git@github\.com\/x\/charlie\.git#abc123/);
    assert.match(text, /rs\/Cargo\.lock — 3 package\(s\): 2 direct \(per rs\/Cargo\.toml\), 1 transitive/);
    assert.match(text, /1 without a source \(bundled, linked or workspace packages: no download of their own\)/);
    assert.match(text, /web\/yarn\.lock — Yarn lockfile, not read yet/);
    assert.match(text, /go\/go\.mod has no lockfile beside it \(go\.sum; lockfiles are indexed by name/);
    assert.match(text, /Declared vs imported vs locked \(npm and Python manifests\):/);
    assert.match(text, /declared in package\.json, imported nowhere: echo/);
    assert.match(text, /declared in package\.json as dev\/peer\/optional, imported nowhere \(expected for build-time tools\): bravo/);
    assert.match(text, /imported but not declared: charlie — present in package-lock\.json as a transitive dependency \(0\.9\.0\); a dependency bump can drop it/);
    assert.match(text, /imported but neither declared nor locked: zulu/);
    assert.match(text, /Manifests, lockfiles and build files are indexed by name in every default build/);
    // With nothing to join, the section says so instead of vanishing.
    const clean = appIndex();
    clean.fileLines.set('package.json', [JSON.stringify({ dependencies: { alpha: '^1.0.0', charlie: '^0.9.0', zulu: '^1.0.0' } })]);
    clean.fileLines.set('package-lock.json', [JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { alpha: '^1.0.0', charlie: '^0.9.0', zulu: '^1.0.0' } },
      'node_modules/alpha': { version: '1.2.3' }, 'node_modules/charlie': { version: '0.9.0' }, 'node_modules/zulu': { version: '1.0.0' } } })]);
    const t2 = capture(() => doBom(clean, { _explicit: new Set() }));
    assert.match(t2, /nothing to report: every declared runtime dependency is imported, every imported package is declared/);
  });
});

describe('sweep-residue small fixes', () => {
  const facts0 = () => corpusFacts({ fileLines: new Map([['a/main.m', []]]) });

  it('ObjC #import (quoted and angle) and @import extract like includes', () => {
    const rows = extractCImports([
      '#import <Foundation/Foundation.h>',
      '#import "MyThing.h"',
      '@import UIKit;',
    ], 'a/main.m', { includeRelative: true });
    assert.deepEqual(rows.map((r) => r.module), ['UIKit', 'Foundation/Foundation.h', 'MyThing.h']
      .sort((a, b) => 0) && rows.map((r) => r.module).sort(), ['Foundation/Foundation.h', 'MyThing.h', 'UIKit']);
    assert.ok(rows.find((r) => r.module === 'MyThing.h').relative, 'quoted #import is project-local');
    assert.ok(rows.find((r) => r.module === 'UIKit').objcModule);
  });

  it('@import classifies via the apple framework list; unknown modules say so', () => {
    const f = facts0();
    const uikit = classifyImportRow({ module: 'UIKit', lang: 'c', objcModule: true }, f);
    assert.equal(uikit.cls, 'stdlib');
    assert.match(uikit.source, /apple platform framework/);
    const other = classifyImportRow({ module: 'VendorSDK', lang: 'c', objcModule: true }, f);
    assert.equal(other.cls, 'external');
    assert.match(other.source, /not on the apple framework list/);
  });

  it('__future__ is python stdlib', () => {
    const r = classifyImportRow({ module: '__future__', lang: 'py' }, facts0());
    assert.equal(r.cls, 'stdlib');
  });

  it('JS @/ and ~/ specifiers are path aliases, not npm scopes', () => {
    const r = classifyImportRow({ module: '@/components/Button', lang: 'js' }, facts0());
    assert.equal(r.cls, 'internal');
    assert.match(r.source, /path alias/);
    assert.equal(classifyImportRow({ module: '~/lib/util', lang: 'js' }, facts0()).cls, 'internal');
    assert.equal(classifyImportRow({ module: '@scope/pkg', lang: 'js' }, facts0()).cls, 'external', 'real scopes unaffected');
  });

  it('MFC/ATL headers land on the windows platform list', () => {
    const r = classifyImportRow({ module: 'afxwin.h', lang: 'c' }, facts0());
    assert.equal(r.cls, 'stdlib');
    assert.match(r.source, /MFC\/ATL/);
    assert.equal(classifyImportRow({ module: 'atlbase.h', lang: 'c' }, facts0()).cls, 'stdlib');
  });

  it('java external why names two package segments', () => {
    const r = classifyImportRow({ module: 'org.apache.avalon.framework', lang: 'java' }, facts0());
    assert.match(r.source, /`org\.apache`/);
  });

  it('.xs dispatches to the JS extractor', () => {
    assert.ok(isJsFile('Globals.xs'));
    const rows = extractFileImports(["import { x } from 'lib';"], 'Globals.xs');
    assert.equal(rows[0].lang, 'js');
  });
});
