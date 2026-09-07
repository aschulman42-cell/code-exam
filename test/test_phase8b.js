// test_phase8b.js — analyze.js primitives: SimpleMasker comment/string masking, language detect, prompts
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SimpleMasker, detectLanguage, addLineNumbers,
  buildAnalyzePrompt, buildClaimAnalyzePrompt,
  buildMultisectAnalyzePrompt, buildFileAnalyzePrompt,
  resolveFunction, resetAnalysisLLM,
} from '../src/commands/analyze.js';

// Suppress stderr noise during tests
const origStderrWrite = process.stderr.write.bind(process.stderr);
function hushStderr() { process.stderr.write = () => true; }
function restoreStderr() { process.stderr.write = origStderrWrite; }


// ============================================================================
// SimpleMasker tests
// ============================================================================

describe('SimpleMasker — Layer 1: comment stripping', () => {
  it('strips C-style line comments', () => {
    const masker = new SimpleMasker();
    const code = 'int x = 5; // important value\nint y = 10;';
    const result = masker.stripComments(code, 'c');
    assert.ok(!result.includes('important value'));
    assert.ok(result.includes('int x = 5;'));
    assert.ok(result.includes('int y = 10;'));
  });

  it('strips C-style block comments', () => {
    const masker = new SimpleMasker();
    const code = 'int x = 5; /* this is\na block comment */ int y = 10;';
    const result = masker.stripComments(code, 'java');
    assert.ok(!result.includes('block comment'));
    assert.ok(result.includes('int x = 5;'));
    assert.ok(result.includes('int y = 10;'));
  });

  it('preserves strings that look like comments', () => {
    const masker = new SimpleMasker();
    const code = 'const s = "hello // not a comment";';
    const result = masker.stripComments(code, 'javascript');
    assert.ok(result.includes('hello // not a comment'));
  });

  it('strips Python hash comments', () => {
    const masker = new SimpleMasker();
    const code = 'x = 5  # set x\ny = 10';
    const result = masker.stripComments(code, 'python');
    assert.ok(!result.includes('set x'));
    assert.ok(result.includes('x = 5'));
    assert.ok(result.includes('y = 10'));
  });

  it('preserves Python strings containing #', () => {
    const masker = new SimpleMasker();
    const code = 's = "color: #ff0000"  # hex color';
    const result = masker.stripComments(code, 'python');
    assert.ok(result.includes('color: #ff0000'));
    assert.ok(!result.includes('hex color'));
  });

  it('returns unknown languages unchanged', () => {
    const masker = new SimpleMasker();
    const code = '// this stays; /* this too */';
    const result = masker.stripComments(code, 'cobol');
    assert.equal(result, code);
  });
});


describe('SimpleMasker — Layer 2: string masking', () => {
  it('masks double-quoted string contents', () => {
    const masker = new SimpleMasker();
    const code = 'printf("Cipher negotiation failed for %s", host);';
    const result = masker.maskStrings(code, 'c');
    assert.ok(!result.includes('Cipher negotiation'));
    assert.ok(result.includes('STR_'));
    // Quotes preserved
    assert.ok(result.includes('"'));
  });

  it('preserves single-char literals', () => {
    const masker = new SimpleMasker();
    const code = "char c = 'x'; char nl = '\\n';";
    const result = masker.maskStrings(code, 'c');
    assert.ok(result.includes("'x'"));
    assert.ok(result.includes("'\\n'"));
  });

  it('masks Python triple-quoted strings', () => {
    const masker = new SimpleMasker();
    const code = 'doc = """This is a docstring\nwith multiple lines"""';
    const result = masker.maskStrings(code, 'python');
    assert.ok(!result.includes('docstring'));
    assert.ok(result.includes('STR_'));
    assert.ok(result.includes('"""'));
  });

  it('masks JavaScript template literals', () => {
    const masker = new SimpleMasker();
    const code = 'const msg = `Hello ${name}`;';
    const result = masker.maskStrings(code, 'javascript');
    assert.ok(!result.includes('Hello'));
    assert.ok(result.includes('STR_'));
    assert.ok(result.includes('`'));
  });

  it('increments STR counters', () => {
    const masker = new SimpleMasker();
    const code = 'log("first"); log("second");';
    const result = masker.maskStrings(code, 'c');
    assert.ok(result.includes('STR_1'));
    assert.ok(result.includes('STR_2'));
  });
});


describe('SimpleMasker — combined mask()', () => {
  it('strips comments then masks strings', () => {
    const masker = new SimpleMasker();
    const code = `// Step 1: Initialize TLS
const ctx = createContext("TLS 1.3"); // secure version`;
    const result = masker.mask(code, 'javascript');
    assert.ok(!result.includes('Step 1'));
    assert.ok(!result.includes('secure version'));
    assert.ok(!result.includes('TLS 1.3'));
    assert.ok(result.includes('STR_'));
    assert.ok(result.includes('createContext'));
  });

  it('handles empty input', () => {
    const masker = new SimpleMasker();
    assert.equal(masker.mask('', 'c'), '');
  });

  it('handles code with no comments or strings', () => {
    const masker = new SimpleMasker();
    const code = 'int x = 5;\nint y = x + 1;';
    const result = masker.mask(code, 'c');
    assert.equal(result, code);
  });
});


// ============================================================================
// detectLanguage tests
// ============================================================================

describe('detectLanguage', () => {
  it('detects Python', () => {
    assert.equal(detectLanguage('foo/bar.py'), 'python');
    assert.equal(detectLanguage('script.pyw'), 'python');
  });

  it('detects C', () => {
    assert.equal(detectLanguage('main.c'), 'c');
    assert.equal(detectLanguage('header.h'), 'c');
  });

  it('detects C++', () => {
    assert.equal(detectLanguage('main.cpp'), 'cpp');
    assert.equal(detectLanguage('util.hpp'), 'cpp');
  });

  it('detects Java', () => {
    assert.equal(detectLanguage('Main.java'), 'java');
  });

  it('detects JavaScript/TypeScript', () => {
    assert.equal(detectLanguage('app.js'), 'javascript');
    assert.equal(detectLanguage('component.tsx'), 'javascript');
    assert.equal(detectLanguage('util.mjs'), 'javascript');
  });

  it('falls back to c for unknown', () => {
    assert.equal(detectLanguage('script.rb'), 'c');
    assert.equal(detectLanguage('makefile'), 'c');
  });
});


// ============================================================================
// addLineNumbers tests
// ============================================================================

describe('addLineNumbers', () => {
  it('adds 1-based line numbers', () => {
    const result = addLineNumbers('a\nb\nc', 1);
    assert.ok(result.includes('1 | a'));
    assert.ok(result.includes('2 | b'));
    assert.ok(result.includes('3 | c'));
  });

  it('uses startLine offset', () => {
    const result = addLineNumbers('x\ny', 42);
    assert.ok(result.includes('42 | x'));
    assert.ok(result.includes('43 | y'));
  });

  it('pads to consistent width', () => {
    const lines = Array.from({length: 10}, (_, i) => `line${i}`);
    const result = addLineNumbers(lines.join('\n'), 95);
    // Lines 95-104 — 3 digits
    assert.ok(result.includes(' 95 | line0'));
    assert.ok(result.includes('104 | line9'));
  });
});


// ============================================================================
// Prompt builder tests
// ============================================================================

describe('buildAnalyzePrompt', () => {
  const source = 'function foo(x) { return x * 2; }';

  it('includes source code in prompt', () => {
    const prompt = buildAnalyzePrompt(source, 'foo', 'test.js', false);
    assert.ok(prompt.includes(source));
    assert.ok(prompt.includes('test.js'));
  });

  it('includes masked preamble when masked', () => {
    const prompt = buildAnalyzePrompt(source, 'foo', 'test.js', true);
    assert.ok(prompt.includes('comments have been stripped'));
    assert.ok(!prompt.includes('test.js'));
  });

  it('includes critical instructions', () => {
    const prompt = buildAnalyzePrompt(source, 'foo', 'test.js', false);
    assert.ok(prompt.includes('CRITICAL INSTRUCTIONS'));
    assert.ok(prompt.includes('In summary'));
  });
});


describe('buildClaimAnalyzePrompt', () => {
  const source = 'void tls_connect() { ssl_handshake(); }';
  const claim = 'A method of establishing a secure communication connection.';

  it('includes both source and claim text', () => {
    const prompt = buildClaimAnalyzePrompt(source, 'tls_connect', 'crypto.c', claim, false);
    assert.ok(prompt.includes(source));
    assert.ok(prompt.includes(claim));
    assert.ok(prompt.includes('PATENT CLAIM TEXT'));
    assert.ok(prompt.includes('crypto.c'));
  });

  it('asks for coverage summary with PRESENT/ASSUMED/PARTIAL/ABSENT', () => {
    const prompt = buildClaimAnalyzePrompt(source, 'tls_connect', 'crypto.c', claim, false);
    assert.ok(prompt.includes('PRESENT'));
    assert.ok(prompt.includes('ASSUMED'));
    assert.ok(prompt.includes('PARTIAL'));
    assert.ok(prompt.includes('ABSENT'));
    assert.ok(prompt.includes('Claim coverage:'));
  });

  it('uses masked preamble when masked', () => {
    const prompt = buildClaimAnalyzePrompt(source, 'tls_connect', 'crypto.c', claim, true);
    assert.ok(prompt.includes('comments have been stripped'));
    assert.ok(!prompt.includes('crypto.c'));
  });
});


describe('buildMultisectAnalyzePrompt', () => {
  const source = 'function encrypt(key, data) { ... }';
  const terms = ['encrypt', 'key', 'cipher'];

  it('includes source and terms list', () => {
    const prompt = buildMultisectAnalyzePrompt(source, 'encrypt', 'crypto.js', terms, false);
    assert.ok(prompt.includes(source));
    assert.ok(prompt.includes('1. encrypt'));
    assert.ok(prompt.includes('2. key'));
    assert.ok(prompt.includes('3. cipher'));
    assert.ok(prompt.includes('SEARCH TERMS'));
  });
});


describe('buildFileAnalyzePrompt', () => {
  const source = 'import os\n\ndef main():\n    pass';
  const funcNames = ['main', 'helper'];

  it('includes file source and function hints', () => {
    const prompt = buildFileAnalyzePrompt(source, 'app.py', false, funcNames);
    assert.ok(prompt.includes(source));
    assert.ok(prompt.includes('main, helper'));
    assert.ok(prompt.includes('app.py'));
  });

  it('omits function hints when masked', () => {
    const prompt = buildFileAnalyzePrompt(source, 'app.py', true, funcNames);
    assert.ok(!prompt.includes('main, helper'));
    assert.ok(!prompt.includes('app.py'));
  });
});


// ============================================================================
// resolveFunction tests (need a mock index)
// ============================================================================

describe('resolveFunction', () => {
  // Minimal mock index
  const mockIndex = {
    functionIndex: {
      'src/crypto.c': {
        'tls_connect': { start: 10, end: 25, type: 'function' },
        'tls_close': { start: 30, end: 40, type: 'function' },
      },
      'src/net.c': {
        'tls_connect': { start: 5, end: 15, type: 'function' },
      },
    },
    fileLines: new Map([
      ['src/crypto.c', Array.from({length: 50}, (_, i) => `line ${i + 1}`)],
      ['src/net.c', Array.from({length: 20}, (_, i) => `line ${i + 1}`)],
    ]),
    _ensureFunctionIndex() {},
    findFunctionMatches(funcName, fileHint) {
      const matches = [];
      for (const [filepath, funcs] of Object.entries(this.functionIndex)) {
        if (fileHint) {
          const fpNorm = filepath.toLowerCase();
          if (!fpNorm.includes(fileHint.toLowerCase())) continue;
        }
        for (const [name, info] of Object.entries(funcs)) {
          const baseName = name.split('::').pop();
          if (name === funcName || baseName === funcName) {
            matches.push({ filepath, name, start: info.start, end: info.end, type: info.type });
          }
        }
      }
      return matches;
    },
    getFunctionSource(filepath, funcName) {
      const lines = this.fileLines.get(filepath);
      if (!lines) return null;
      const info = (this.functionIndex[filepath] || {})[funcName];
      if (!info) return null;
      return lines.slice(info.start - 1, info.end).join('\n');
    },
  };

  it('resolves unique function by name', () => {
    const result = resolveFunction(mockIndex, 'tls_close');
    assert.ok(result);
    assert.equal(result.filepath, 'src/crypto.c');
    assert.equal(result.name, 'tls_close');
    assert.equal(result.start, 30);
    assert.equal(result.end, 40);
    assert.ok(result.source);
  });

  it('resolves ambiguous function with FILE@ prefix', () => {
    const result = resolveFunction(mockIndex, 'crypto.c@tls_connect');
    assert.ok(result);
    assert.equal(result.filepath, 'src/crypto.c');
  });

  it('returns null for ambiguous without file hint', () => {
    // Capture stdout to suppress "Multiple functions match" message
    const origLog = console.log;
    const logged = [];
    console.log = (...args) => logged.push(args.join(' '));

    const result = resolveFunction(mockIndex, 'tls_connect');
    console.log = origLog;

    assert.equal(result, null);
    assert.ok(logged.some(l => l.includes('Multiple functions match')));
  });

  it('returns null for non-existent function', () => {
    const origLog = console.log;
    console.log = () => {};
    const result = resolveFunction(mockIndex, 'does_not_exist');
    console.log = origLog;
    assert.equal(result, null);
  });

  it('rejects invalid FILE@FUNCTION format', () => {
    const origLog = console.log;
    const logged = [];
    console.log = (...args) => logged.push(args.join(' '));

    const result = resolveFunction(mockIndex, '@tls_connect');
    console.log = origLog;
    assert.equal(result, null);
  });
});


// ============================================================================
// Integration: module imports work correctly
// ============================================================================

describe('analyze.js module exports', () => {
  it('exports all expected symbols', async () => {
    const mod = await import('../src/commands/analyze.js');
    assert.equal(typeof mod.SimpleMasker, 'function');
    assert.equal(typeof mod.detectLanguage, 'function');
    assert.equal(typeof mod.addLineNumbers, 'function');
    assert.equal(typeof mod.buildAnalyzePrompt, 'function');
    assert.equal(typeof mod.buildClaimAnalyzePrompt, 'function');
    assert.equal(typeof mod.buildMultisectAnalyzePrompt, 'function');
    assert.equal(typeof mod.buildFileAnalyzePrompt, 'function');
    assert.equal(typeof mod.resolveFunction, 'function');
    assert.equal(typeof mod.doAnalyze, 'function');
    assert.equal(typeof mod.doClaimAnalyze, 'function');
    assert.equal(typeof mod.doMultisectAnalyze, 'function');
    assert.equal(typeof mod.doFileAnalyze, 'function');
    assert.equal(typeof mod.resetAnalysisLLM, 'function');
  });

  it('claim.js exports are importable from analyze.js', async () => {
    // Verify the cross-module dependency chain works
    const { extractClaimTerms, sanitizeLlmTerms, sanitizeBroadTerms } = await import('../src/commands/claim.js');
    assert.equal(typeof extractClaimTerms, 'function');
    assert.equal(typeof sanitizeLlmTerms, 'function');
    assert.equal(typeof sanitizeBroadTerms, 'function');
  });
});


// ============================================================================
// Masker edge cases
// ============================================================================

describe('SimpleMasker edge cases', () => {
  it('handles nested quotes in C', () => {
    const masker = new SimpleMasker();
    const code = 'printf("He said \\"hello\\"");';
    const result = masker.maskStrings(code, 'c');
    assert.ok(result.includes('STR_'));
    assert.ok(!result.includes('hello'));
  });

  it('handles multi-line block comments', () => {
    const masker = new SimpleMasker();
    const code = `/**
 * This function does TLS handshake.
 * It verifies certificates.
 */
int tls_handshake() { return 0; }`;
    const result = masker.stripComments(code, 'c');
    assert.ok(!result.includes('TLS handshake'));
    assert.ok(!result.includes('verifies certificates'));
    assert.ok(result.includes('tls_handshake'));
  });

  it('handles JavaScript with mixed comment styles', () => {
    const masker = new SimpleMasker();
    const code = `// line comment
const x = "str"; /* block */ const y = 'c';`;
    const result = masker.mask(code, 'javascript');
    assert.ok(!result.includes('line comment'));
    assert.ok(!result.includes('block'));
    assert.ok(result.includes('STR_'));
    assert.ok(result.includes('const x'));
    assert.ok(result.includes('const y'));
  });
});


// ============================================================================
// Show-prompt mode (verifies prompt is well-formed without LLM call)
// ============================================================================

describe('show-prompt mode prompt structure', () => {
  it('claim-analyze prompt contains all required sections', () => {
    const source = 'function validate(cert) { if (cert.expired) throw new Error(); }';
    const claim = '1. A method comprising: (a) validating a certificate; (b) checking expiration.';
    const prompt = buildClaimAnalyzePrompt(source, 'validate', 'tls.js', claim, false);

    // Must have all structural elements
    assert.ok(prompt.includes('FUNCTION TO ANALYZE:'));
    assert.ok(prompt.includes('PATENT CLAIM TEXT:'));
    assert.ok(prompt.includes('CRITICAL INSTRUCTIONS:'));
    assert.ok(prompt.includes('PRESENT'));
    assert.ok(prompt.includes('ASSUMED'));
    assert.ok(prompt.includes('Claim coverage:'));

    // Must include the actual content
    assert.ok(prompt.includes('validate'));
    assert.ok(prompt.includes('cert.expired'));
    assert.ok(prompt.includes('checking expiration'));
  });

  it('masked claim-analyze omits filepath', () => {
    const source = 'function validate(cert) { ... }';
    const claim = 'A method comprising validating.';
    const prompt = buildClaimAnalyzePrompt(source, 'validate', 'secret/path.js', claim, true);

    assert.ok(!prompt.includes('secret/path.js'));
    assert.ok(prompt.includes('comments have been stripped'));
  });
});
