// test_regex_signatures.js — regex-parser definition detection: pointer-on-name C signatures, GNU type-on-previous-line C, one-line bodies, wrapped Java params, typedef struct, exported JS arrows, qualifier tails; wrapped declarations and keyword-led lines are not definitions
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// regex-parser-signature-detection (2026-10-13, #343): red fixtures from the
// recall measurement of the regex parser (the `--build-index` default) against
// tree-sitter. The shipped demo never listed `tls_connect` because the plain-C
// pattern wanted whitespace between the return type and the name; libxml and
// libpng, written with the return type on its own line and the name at column
// 0, came out at 4 % and 7 % recall; Java and JS one-line bodies, wrapped Java
// parameter lists, `typedef struct`, `export const f = () =>` and `void Foo()
// const {` were all missed; wrapped declarations and `return foo(` / `throw
// Foo(` lines were counted as definitions. Each case here is one of those
// lines, as the parser sees it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

const TMP = path.join(os.tmpdir(), 'ce_test_regex_signatures');

function regexParse(filename, source) {
  const idx = new CodeSearchIndex({ indexPath: path.join(TMP, '.unused') });
  idx.fileLines = new Map([[filename, source]]);
  return idx._parseFunctionsRegex(filename);
}

function names(funcs) { return Object.keys(funcs).sort(); }
function startOf(funcs, name) {
  const e = funcs[name];
  assert.ok(e, `expected an entry named ${name}; have ${names(funcs).join(', ') || '(none)'}`);
  return e.start;
}
function absent(funcs, name) {
  assert.ok(!(name in funcs), `${name} must not be a definition; have ${names(funcs).join(', ')}`);
}

// ---------------------------------------------------------------------------
describe('C: pointer or reference return type written on the name', () => {
  const SRC = [
    '#include "tls.h"',
    '',
    'SSL_CTX *initialize_crypto_context(const tls_config_t *config)',
    '{',
    '  return NULL;',
    '}',
    '',
    'unsigned char *pool_checkout(int *out_size) {',
    '  return NULL;',
    '}',
    '',
    'tls_connection_t *tls_connect(const char *hostname, int port,',
    '                              const tls_config_t *config)',
    '{',
    '  return NULL;',
    '}',
    '',
    'static const char **names_of(int n) { return NULL; }',
  ];
  it('finds `Type *name(` definitions at their line (the shipped demo\'s star functions)', () => {
    const f = regexParse('tls_handler.c', SRC);
    assert.equal(startOf(f, 'initialize_crypto_context'), 3);
    assert.equal(startOf(f, 'pool_checkout'), 8);
    assert.equal(startOf(f, 'tls_connect'), 12);
    assert.equal(startOf(f, 'names_of'), 18);
    assert.equal(f.names_of.end, 18, 'a one-line body ends on its own line');
  });
});

describe('C: GNU style, return type on its own line and the name at column 0', () => {
  const SRC = [
    'static void',
    'xmlBufMemoryError(xmlBufPtr buf, const char *extra)',
    '{',
    '  (void) buf;',
    '}',
    '',
    'xmlChar *',
    'xmlBufDetach(xmlBufPtr buf) {',
    '  return NULL;',
    '}',
    '',
    'void PNGAPI',
    'png_set_sig_bytes(png_structrp png_ptr, int num_bytes)',
    '{',
    '  (void) png_ptr;',
    '}',
    '',
    'int',
    'wrapped_params(int a,',
    '               int b)',
    '{',
    '  return a + b;',
    '}',
  ];
  it('starts each definition at its return-type line, as tree-sitter does, so an extract keeps the type', () => {
    const f = regexParse('buf.c', SRC);
    assert.equal(startOf(f, 'xmlBufMemoryError'), 1);
    assert.equal(f.xmlBufMemoryError.end, 5);
    assert.equal(startOf(f, 'xmlBufDetach'), 7);
    assert.equal(f.xmlBufDetach.end, 10);
    assert.equal(startOf(f, 'png_set_sig_bytes'), 12);
    assert.equal(startOf(f, 'wrapped_params'), 18);
    assert.equal(f.wrapped_params.end, 23);
  });
  it('does not take a column-0 line whose previous line is not a type', () => {
    const f = regexParse('calls.c', [
      'int main(void)',
      '{',
      'x = y;',
      'foo(x,',
      '    y);',
      'return 0;',
      '}',
    ]);
    assert.deepEqual(names(f), ['main']);
  });
});

describe('C: lines that are not definitions', () => {
  it('a declaration wrapped over several lines is a declaration, not a function', () => {
    const f = regexParse('tls_handler.h', [
      'int                 negotiate_cipher_params(SSL *ssl, SSL_CTX *ctx,',
      '                                            const char *cipher);',
      'extern int ZEXPORT unzRepair(const char* file,',
      '                             const char* fileOut);',
      'tls_connection_t *tls_connect(const char *hostname, int port,',
      '                              const tls_config_t *config);',
      'virtual void NotifyAnimationStarted(base::TimeTicks monotonic_time,',
      '                                    int target_property) = 0;',
    ]);
    assert.deepEqual(names(f), []);
  });
  it('`return` / `throw` / `new` with a wrapped argument list is a statement', () => {
    const f = regexParse('unzip.c', [
      'int f(void)',
      '{',
      '  return unz64local_GetCurrentFileInfoInternal(file, pfile_info, NULL,',
      '                                               0, NULL, 0);',
      '  throw std::runtime_error(',
      '      "x");',
      '  auto* p = new Widget(',
      '      1);',
      '}',
    ]);
    assert.deepEqual(names(f), ['f']);
  });
  it('a wrapped variable initialisation `Type var(` is not a function', () => {
    const f = regexParse('t.cc', [
      'void g() {',
      '  scoped_refptr<AnimationTimeline> timeline(',
      '      AnimationTimeline::Create(1));',
      '}',
    ]);
    assert.deepEqual(names(f), ['g']);
  });
  it('an indented `Qualified::call(x)` continuation line and `__asm__ volatile (` are not definitions', () => {
    const f = regexParse('t.cc', [
      'int h() {',
      '  return KeyframeModel::ToCcKeyframeModel(keyframe_model)',
      '      ->id();',
      '  std::ranges::find_if(ticking_animations_, [id](auto& it) {',
      '    return it->id() == id; });',
      '  __asm__ volatile (',
      '      "nop");',
      '  return 0;',
      '}',
    ]);
    assert.deepEqual(names(f), ['h']);
  });
  it('a declaration wrapped over more than twelve lines is still a declaration', () => {
    const lines = ['extern int ZEXPORT zipOpenNewFileInZip3(zipFile file,'];
    for (let i = 0; i < 20; i++) lines.push(`                                        int p${i},`);
    lines.push('                                        int last);');
    assert.deepEqual(names(regexParse('zip.h', lines)), []);
  });
});

describe('C++: Google Test macro with the test name wrapped onto the next line', () => {
  it('names the test Suite::Name from the two lines', () => {
    const f = regexParse('t_unittest.cc', [
      'TEST_F(ElementAnimationsTest,',
      '       ObserverNotifiedWhenTransformAnimationChangesWhileImplOnly) {',
      '  EXPECT_TRUE(true);',
      '}',
      'TEST_F(ElementAnimationsTest, ShortName) {',
      '}',
    ]);
    assert.equal(startOf(f, 'ElementAnimationsTest::ObserverNotifiedWhenTransformAnimationChangesWhileImplOnly'), 1);
    assert.equal(f['ElementAnimationsTest::ObserverNotifiedWhenTransformAnimationChangesWhileImplOnly'].end, 4);
    assert.equal(startOf(f, 'ElementAnimationsTest::ShortName'), 5);
  });
});

describe('C++: qualifier tails and typedef struct', () => {
  it('finds inline methods ending in const / override / final / noexcept', () => {
    const f = regexParse('t.h', [
      'class Foo {',
      '  void SetUp() override {',
      '  }',
      '  void Tick() const {',
      '  }',
      '  int Size() const noexcept { return 1; }',
      '};',
    ]);
    assert.equal(startOf(f, 'Foo::SetUp'), 2);
    assert.equal(startOf(f, 'Foo::Tick'), 4);
    assert.equal(startOf(f, 'Foo::Size'), 6);
  });
  it('`typedef struct name {` is a struct like `struct name {`', () => {
    const f = regexParse('tls_handler.h', [
      'typedef struct buffer_node {',
      '  int n;',
      '} buffer_node_t;',
      'struct plain {',
      '  int m;',
      '};',
    ]);
    assert.equal(startOf(f, 'buffer_node'), 1);
    assert.equal(f.buffer_node.type, 'class');
    assert.equal(startOf(f, 'plain'), 4);
  });
});

describe('Java', () => {
  it('finds a method whose parameter list continues on the next line', () => {
    const f = regexParse('CertificateValidator.java', [
      'public class CertificateValidator {',
      '  public boolean validateCertificateChain(SSLSession session,',
      '                                          String hostname) {',
      '    return true;',
      '  }',
      '  public Map<String, Integer> counts(String a,',
      '                                     int b) throws IOException {',
      '    return null;',
      '  }',
      '}',
    ]);
    assert.equal(startOf(f, 'CertificateValidator::validateCertificateChain'), 2);
    assert.equal(startOf(f, 'CertificateValidator::counts'), 6);
  });
  it('finds a one-line body and leaves `synchronized (x) {` and wrapped calls alone', () => {
    const f = regexParse('ConnectionConfig.java', [
      'public class ConnectionConfig {',
      '  public ConnectionConfig() {}',
      '  public String getMinTlsVersion() { return minTlsVersion; }',
      '  public void setMinTlsVersion(String v) { this.minTlsVersion = v; }',
      '  void run() {',
      '    synchronized (entry) {',
      '      assertEquals(',
      '          1, 2);',
      '    }',
      '  }',
      '}',
    ]);
    assert.equal(startOf(f, 'ConnectionConfig::ConnectionConfig'), 2);
    assert.equal(startOf(f, 'ConnectionConfig::getMinTlsVersion'), 3);
    assert.equal(f['ConnectionConfig::getMinTlsVersion'].end, 3);
    assert.equal(startOf(f, 'ConnectionConfig::setMinTlsVersion'), 4);
    assert.equal(startOf(f, 'ConnectionConfig::run'), 5);
    absent(f, 'ConnectionConfig::synchronized');
    absent(f, 'synchronized');
    absent(f, 'ConnectionConfig::assertEquals');
    absent(f, 'assertEquals');
  });
});

describe('JavaScript', () => {
  it('finds one-line class methods and exported arrow / function-expression constants', () => {
    const f = regexParse('a.js', [
      'export const rowDesignation = (n, i) => `[${n}${i}]`;',
      'export const helper = function (a) {',
      '  return a;',
      '};',
      'export const CE_VERSION = (() => {',
      '  return "1";',
      '})();',
      'const obj = {',
      '  one(a) { return a; },',
      '};',
      'class Runner {',
      '  isCloud() { return !!this.provider; }',
      '  _literalIndexPath()  { return path.join(this.indexPath, "x"); }',
      '  start() {',
      '    if (x) { y(); }',
      '    while (z) { w(); }',
      '  }',
      '}',
    ]);
    assert.equal(startOf(f, 'rowDesignation'), 1);
    assert.equal(startOf(f, 'helper'), 2);
    absent(f, 'CE_VERSION');
    assert.equal(startOf(f, 'one'), 9);
    assert.equal(startOf(f, 'Runner::isCloud'), 12);
    assert.equal(f['Runner::isCloud'].end, 12);
    assert.equal(startOf(f, 'Runner::_literalIndexPath'), 13);
    assert.equal(startOf(f, 'Runner::start'), 14);
    absent(f, 'Runner::if');
    absent(f, 'Runner::while');
  });
});

describe('callers: a `Type *name(` prototype is a declaration, and a GNU header is not a call site of itself', () => {
  const sitesOf = (r) => (Array.isArray(r) ? r : (r.callers || [])).map((c) => `${path.basename(c.filepath || '')}:${c.line_number} ${c.caller_function || '(file scope)'}`);
  it('--callers lists the real call, not the header prototype, and keeps a recursive call', async () => {
    const src = path.join(TMP, 'callers_src');
    const idxDir = path.join(TMP, 'callers_idx');
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });
    // The shipped demo's shape: the prototype wraps onto a second line, so a
    // one-line declaration skip never sees its `);`. Both forms are here.
    fs.writeFileSync(path.join(src, 'tls_handler.h'), [
      '#pragma once',
      'typedef struct tls_connection tls_connection_t;',
      'tls_connection_t *tls_connect(const char *hostname,',
      '                              int port);',
      'int                 tls_close(tls_connection_t *conn);',
      '',
    ].join('\n'));
    // `tls_retry` is GNU layout: the entry starts at line 14 (`static int`),
    // its name is on line 15, and line 17 is a real recursive call.
    fs.writeFileSync(path.join(src, 'tls_handler.c'), [
      '#include "tls_handler.h"',
      '',
      'tls_connection_t *tls_connect(const char *hostname, int port)',
      '{',
      '  return NULL;',
      '}',
      '',
      'int session_open(const char *h)',
      '{',
      '  tls_connection_t *c = tls_connect(h, 443);',
      '  return c != NULL;',
      '}',
      '',
      'static int',
      'tls_retry(int n)',
      '{',
      '  return n > 0 ? tls_retry(n - 1) : 0;',
      '}',
      '',
    ].join('\n'));
    const idx = new CodeSearchIndex({ indexPath: idxDir });
    // Pinned: this case is about the regex parser's entries, whatever the
    // build default is.
    await idx.buildIndex(src, { showProgress: false, useTreeSitter: false });
    assert.deepEqual(sitesOf(idx.findCallers('tls_connect')), ['tls_handler.c:10 session_open']);
    const cFile = Object.values(idx.functionIndex).find((f) => f && f.tls_retry);
    assert.ok(cFile, 'tls_retry must be indexed');
    assert.equal(cFile.tls_retry.start, 14);
    assert.deepEqual(sitesOf(idx.findCallers('tls_retry')), ['tls_handler.c:17 tls_retry']);
    fs.rmSync(TMP, { recursive: true, force: true });
  });
});
