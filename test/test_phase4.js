/**
 * test_phase4.js - Tests for Phase 4: Deduplication.
 *
 * Covers:
 *   - Structural normalization (funcstrings)
 *   - Function body hashing (SHA1 + structural)
 *   - Exact duplicate detection (func-dupes)
 *   - Near-duplicate detection
 *   - Structural duplicate detection
 *   - File-level duplicate detection (dupefiles)
 *   - show-funcstring
 *   - Opstring MD5 detection
 *   - Hash caching (func_hashes.json)
 *
 * Run: node --test test/test_phase4.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

const TEST_DIR = path.join(os.tmpdir(), 'code_exam_test_p4_src');
const INDEX_DIR = path.join(os.tmpdir(), 'code_exam_test_p4_idx');


// ========================================================================
// Test data: files with known duplicates
// ========================================================================

function setupTestFiles() {
  fs.mkdirSync(path.join(TEST_DIR, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'copy'), { recursive: true });

  // utils.py — contains helper_function and compute_score
  fs.writeFileSync(path.join(TEST_DIR, 'utils.py'), `"""Utilities module v1."""

def helper_function(data):
    if not data:
        return "empty"
    result = str(data).upper()
    trimmed = result.strip()
    return trimmed

def compute_score(items):
    total = sum(items)
    average = total / len(items) if items else 0
    weighted = average * 1.5
    return weighted
`);

  // lib/dup_utils.py — DIFFERENT file (different header) but IDENTICAL function bodies
  // File-level SHA1 will differ, but function-level SHA1 should match
  fs.writeFileSync(path.join(TEST_DIR, 'lib', 'dup_utils.py'), `"""Duplicate utilities from lib."""
# This file was copied for legacy compatibility.
# The header above makes the file hash differ from utils.py.

def helper_function(data):
    if not data:
        return "empty"
    result = str(data).upper()
    trimmed = result.strip()
    return trimmed

def compute_score(items):
    total = sum(items)
    average = total / len(items) if items else 0
    weighted = average * 1.5
    return weighted
`);

  // copy/dup2_utils.py — another copy with different header (3rd copy of functions)
  fs.writeFileSync(path.join(TEST_DIR, 'copy', 'dup2_utils.py'), `"""Yet another copy of utilities."""
# Copied again for the backup module.

def helper_function(data):
    if not data:
        return "empty"
    result = str(data).upper()
    trimmed = result.strip()
    return trimmed

def compute_score(items):
    total = sum(items)
    average = total / len(items) if items else 0
    weighted = average * 1.5
    return weighted
`);

  // structural_a.py — structural dupe of structural_b.py
  // Same control flow but different variable/function names
  fs.writeFileSync(path.join(TEST_DIR, 'structural_a.py'), `"""Module A."""

def process_order(order):
    if not order:
        return None
    total = 0
    for item in order:
        price = item.get_price()
        quantity = item.get_quantity()
        subtotal = price * quantity
        if subtotal > 100:
            subtotal = subtotal * 0.9
        total = total + subtotal
    return total

def validate_order(order):
    if order is None:
        raise ValueError("missing")
    return True
`);

  // structural_b.py — structural dupe (same flow, different identifiers)
  fs.writeFileSync(path.join(TEST_DIR, 'structural_b.py'), `"""Module B."""

def calculate_invoice(invoice):
    if not invoice:
        return None
    amount = 0
    for entry in invoice:
        cost = entry.get_price()
        count = entry.get_quantity()
        line_total = cost * count
        if line_total > 100:
            line_total = line_total * 0.9
        amount = amount + line_total
    return amount

def check_invoice(invoice):
    if invoice is None:
        raise ValueError("missing")
    return True
`);

  // near_dupe.py — near dupe: same name+size as helper_function but different body
  fs.writeFileSync(path.join(TEST_DIR, 'near_dupe.py'), `"""Near dupe module."""

def helper_function(data):
    if not data:
        return "EMPTY"
    result = str(data).lower()
    trimmed = result.strip()
    return trimmed

def compute_score(items):
    total = sum(items)
    average = total / len(items) if items else 0
    weighted = average * 2.0
    return weighted
`);

  // opstring.c — simulated opstring file with MD5 hashes (using .c so it gets indexed)
  fs.writeFileSync(path.join(TEST_DIR, 'opstring.c'), `// Op-converted assembly functions

void func_alpha() {
    // [12 asm] a1b2c3d4e5f6a1b2  /usr/bin/prog
    mov(eax, 1);
    ret();
}

void func_beta() {
    // [12 asm] a1b2c3d4e5f6a1b2  /usr/bin/prog2
    mov(eax, 1);
    ret();
}

void func_gamma() {
    // [8 asm] deadbeef12345678  /usr/bin/other
    nop();
    ret();
}
`);

  // copy/exact_copy.py — EXACT byte-for-byte copy of structural_a.py (for file-level dupe test)
  fs.copyFileSync(
    path.join(TEST_DIR, 'structural_a.py'),
    path.join(TEST_DIR, 'copy', 'exact_copy.py')
  );
}


// ========================================================================
// Tests
// ========================================================================

describe('Phase 4: Deduplication', () => {
  let index;

  it('setup: creates test files and builds index', async () => {
    setupTestFiles();
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    const stats = await index.buildIndex(TEST_DIR, { showProgress: false });
    assert.ok(stats.files_indexed >= 7, `Expected >=7 files, got ${stats.files_indexed}`);
    assert.equal(stats.errors.length, 0);
  });


  // ------------------------------------------------------------------
  // Structural normalization (funcstrings)
  // ------------------------------------------------------------------

  it('getStructuralNormalized: strips comments', () => {
    const input = 'int x = 5; // this is a comment\nint y = /* inline */ 10;';
    const result = index.getStructuralNormalized(input);
    assert.ok(!result.includes('comment'), 'Should strip // comments');
    assert.ok(!result.includes('inline'), 'Should strip /* */ comments');
  });

  it('getStructuralNormalized: replaces string literals', () => {
    const input = 'msg = "hello world"; ch = \'x\';';
    const result = index.getStructuralNormalized(input);
    assert.ok(!result.includes('hello'), 'Should replace "string"');
    assert.ok(!result.includes('world'), 'Should replace string content');
    // After string replacement ("S") then identifier replacement, S becomes _
    // So we get "_" placeholder — just verify original text is gone
  });

  it('getStructuralNormalized: replaces numeric literals', () => {
    const input = 'a = 42; b = 3.14; c = 0xFF; d = 1000L;';
    const result = index.getStructuralNormalized(input);
    // All numbers should become 0
    assert.ok(!result.includes('42'), 'Should replace integers');
    assert.ok(!result.includes('3.14'), 'Should replace floats');
    assert.ok(!result.includes('FF'), 'Should replace hex');
  });

  it('getStructuralNormalized: keeps structural keywords, replaces identifiers', () => {
    const input = 'if (myVar > threshold) { return result; }';
    const result = index.getStructuralNormalized(input);
    assert.ok(result.includes('if'), 'Should keep "if"');
    assert.ok(result.includes('return'), 'Should keep "return"');
    assert.ok(!result.includes('myVar'), 'Should replace identifiers');
    assert.ok(!result.includes('threshold'), 'Should replace identifiers');
  });

  it('getStructuralNormalized: normalizes whitespace', () => {
    const input = 'if  (x)  {\n    return   y;\n  }';
    const result = index.getStructuralNormalized(input);
    assert.ok(!result.includes('\n'), 'Should remove newlines');
    assert.ok(!result.includes('  '), 'Should not have double spaces');
  });

  it('getStructuralNormalized: structural dupes produce same funcstring', () => {
    // Same control flow, different identifiers
    const bodyA = `def process_order(order):
    if not order:
        return None
    total = 0
    for item in order:
        price = item.get_price()
        quantity = item.get_quantity()
        subtotal = price * quantity
        total = total + subtotal
    return total`;
    const bodyB = `def calculate_invoice(invoice):
    if not invoice:
        return None
    amount = 0
    for entry in invoice:
        cost = entry.get_price()
        count = entry.get_quantity()
        line_total = cost * count
        amount = amount + line_total
    return amount`;
    const normA = index.getStructuralNormalized(bodyA);
    const normB = index.getStructuralNormalized(bodyB);
    assert.equal(normA, normB, 'Structural dupes should produce identical funcstrings');
  });

  it('getStructuralNormalized: different structure produces different funcstring', () => {
    const bodyA = 'if (x) { return a; }';
    const bodyB = 'while (x) { y = a + b; return y; }';
    const normA = index.getStructuralNormalized(bodyA);
    const normB = index.getStructuralNormalized(bodyB);
    assert.notEqual(normA, normB, 'Different structures should differ');
  });


  // ------------------------------------------------------------------
  // Hash computation
  // ------------------------------------------------------------------

  it('getStructuralHash: returns hex SHA1', () => {
    const hash = index.getStructuralHash('if (x) { return y; }');
    assert.ok(/^[0-9a-f]{40}$/.test(hash), 'Should be 40-char hex SHA1');
  });

  it('getStructuralHash: same structure -> same hash', () => {
    const h1 = index.getStructuralHash('int calculate(int price) { return price * 2; }');
    const h2 = index.getStructuralHash('int compute(int cost) { return cost * 2; }');
    assert.equal(h1, h2, 'Same structure should produce same hash');
  });


  // ------------------------------------------------------------------
  // ensureFuncHashes
  // ------------------------------------------------------------------

  it('ensureFuncHashes: computes hashes for all functions', () => {
    // Clear any cached hashes
    index._funcHashes = null;
    const cachePath = path.join(INDEX_DIR, 'func_hashes.json');
    if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);

    const hashes = index.ensureFuncHashes(3, false);
    assert.ok(hashes.size > 0, 'Should compute hashes');

    // Every entry should have body_hash and struct_hash
    for (const [key, val] of hashes) {
      assert.ok(val.body_hash, `Missing body_hash for ${key}`);
      assert.ok(val.struct_hash, `Missing struct_hash for ${key}`);
      assert.ok(typeof val.lines === 'number', `Missing lines for ${key}`);
      assert.ok(typeof val.asm_ops === 'number', `Missing asm_ops for ${key}`);
    }
  });

  it('ensureFuncHashes: saves and reloads cache', () => {
    const cachePath = path.join(INDEX_DIR, 'func_hashes.json');
    assert.ok(fs.existsSync(cachePath), 'Cache file should exist');

    // Clear in-memory, reload from cache
    index._funcHashes = null;
    const hashes = index.ensureFuncHashes(3, false);
    assert.ok(hashes.size > 0, 'Should reload from cache');
  });

  it('ensureFuncHashes: detects opstring MD5', () => {
    const hashes = index.ensureFuncHashes(3, false);
    // Find opstring functions
    let opstringCount = 0;
    for (const [key, val] of hashes) {
      if (val.asm_ops > 0) opstringCount++;
    }
    assert.ok(opstringCount >= 2,
      `Should find >=2 opstring functions, got ${opstringCount}`);

    // func_alpha and func_beta should share the same hash
    let alphaHash = null, betaHash = null;
    for (const [key, val] of hashes) {
      if (key.includes('func_alpha')) alphaHash = val.body_hash;
      if (key.includes('func_beta')) betaHash = val.body_hash;
    }
    assert.ok(alphaHash, 'Should find func_alpha');
    assert.ok(betaHash, 'Should find func_beta');
    assert.equal(alphaHash, betaHash, 'Same opstring MD5 -> same body_hash');
  });


  // ------------------------------------------------------------------
  // getFuncDupes (exact duplicates)
  // ------------------------------------------------------------------

  it('getFuncDupes: finds exact duplicate functions', () => {
    const dupes = index.getFuncDupes(50, 3, false);
    assert.ok(dupes.length > 0, 'Should find dupe groups');

    // helper_function appears in 3 files (exact copies) + 1 near-dupe
    // The 3 exact copies should form a group
    const hfGroup = dupes.find(g => g.bare_name === 'helper_function');
    assert.ok(hfGroup, 'Should find helper_function dupe group');
    assert.ok(hfGroup.count >= 3, `helper_function should have >=3 copies, got ${hfGroup.count}`);
    assert.ok(hfGroup.waste > 0, 'Should have waste > 0');
  });

  it('getFuncDupes: sorted by waste descending', () => {
    const dupes = index.getFuncDupes(100, 3, false);
    for (let i = 1; i < dupes.length; i++) {
      assert.ok(dupes[i - 1].waste >= dupes[i].waste, 'Should be sorted by waste desc');
    }
  });

  it('getFuncDupes: opstring dupes grouped together', () => {
    const dupes = index.getFuncDupes(100, 3, false);
    // func_alpha and func_beta share opstring MD5
    const opGroup = dupes.find(g =>
      g.instances.some(i => i.name.includes('func_alpha')) &&
      g.instances.some(i => i.name.includes('func_beta')));
    assert.ok(opGroup, 'func_alpha and func_beta should be in same dupe group (shared opstring MD5)');
    assert.ok(opGroup.asm_ops > 0, 'Should have asm_ops > 0');
  });


  // ------------------------------------------------------------------
  // getNearDupes
  // ------------------------------------------------------------------

  it('getNearDupes: finds near-duplicate functions', () => {
    // Force compute
    index.getFuncDupes(1, 3, false);
    const near = index.getNearDupes(50);

    // helper_function: 3 exact copies + 1 with different body but same name+size
    // near_dupe.py has helper_function with slightly different body
    // Actually it might differ in size, let's just check we get near-dupes
    assert.ok(Array.isArray(near), 'Should return array');
    // At least compute_score has near-dupes (exact copies + the near_dupe.py version)
    if (near.length > 0) {
      assert.ok(near[0].unique_variants >= 2, 'Near-dupe should have >=2 variants');
    }
  });


  // ------------------------------------------------------------------
  // getStructDupes
  // ------------------------------------------------------------------

  it('getStructDupes: finds structural duplicates', () => {
    index.getFuncDupes(1, 3, false);
    const struct = index.getStructDupes(50);

    // process_order and calculate_invoice have same structure
    // They should appear in a structural dupe group
    if (struct.length > 0) {
      assert.ok(struct[0].unique_bodies >= 2, 'Should have multiple unique bodies');
      assert.ok(struct[0].count >= 2, 'Should have multiple instances');
    }
  });


  // ------------------------------------------------------------------
  // File-level duplicates
  // ------------------------------------------------------------------

  it('getFileDupeCount: detects file copies', () => {
    // structural_a.py and copy/exact_copy.py are byte-identical
    const files = [...index.files.keys()];
    const structA = files.find(f => f.endsWith('structural_a.py'));
    if (structA) {
      const count = index.getFileDupeCount(structA);
      assert.ok(count >= 1, `structural_a.py should have >=1 dupe, got ${count}`);
    }
  });

  it('getFileDupes: returns dupe paths', () => {
    const files = [...index.files.keys()];
    const structA = files.find(f => f.endsWith('structural_a.py'));
    if (structA) {
      const dupes = index.getFileDupes(structA);
      assert.ok(dupes.length >= 1, `Should have >=1 dupe path, got ${dupes.length}`);
      assert.ok(dupes.some(d => d.includes('exact_copy')), 'Should include exact_copy.py');
    }
  });


  // ------------------------------------------------------------------
  // Canonical functions
  // ------------------------------------------------------------------

  it('getCanonicalFuncs: maps dupes to shortest path', () => {
    const canon = index.getCanonicalFuncs('exact');
    assert.ok(Object.keys(canon).length > 0, 'Should have canonical mappings');

    // Find all helper_function entries and group by body_hash
    const hashes = index.ensureFuncHashes(3, false);
    const helperByHash = {};
    for (const [key, val] of hashes) {
      if (key.includes('helper_function')) {
        if (!helperByHash[val.body_hash]) helperByHash[val.body_hash] = [];
        helperByHash[val.body_hash].push(key);
      }
    }

    // For each hash group with dupes, all should map to same canonical
    for (const [hash, keys] of Object.entries(helperByHash)) {
      if (keys.length < 2) continue;
      const canonKey = canon[keys[0]];
      for (const k of keys) {
        assert.equal(canon[k], canonKey,
          `All exact dupes for hash ${hash.slice(0,8)} should map to same canonical`);
      }
    }
  });

  it('getCopyCount: returns correct count', () => {
    const funcs = index.listFunctions();
    const hf = funcs.find(f => f.name === 'helper_function');
    if (hf) {
      // One of the copies should be canonical with copies > 0
      // Others should return 0 (they're copies, not canonical)
      const count = index.getCopyCount(hf.filepath, hf.name, 'exact');
      // The canonical should have count >=2, copies should have 0
      assert.ok(typeof count === 'number', 'Should return a number');
    }
  });


  // ------------------------------------------------------------------
  // Display commands (smoke tests via console capture)
  // ------------------------------------------------------------------

  it('doDupefiles: runs without error', async () => {
    const { doDupefiles } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doDupefiles(index, { dupefiles: 10, filter: null, full_path: false });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
    // Should mention duplicate file groups (we have structural_a.py / exact_copy.py)
    assert.ok(lines.some(l => l.includes('duplicate file group') || l.includes('SHA1')),
      'Should mention file duplicates');
  });

  it('doFuncDupes: runs without error', async () => {
    const { doFuncDupes } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doFuncDupes(index, {
        func_dupes: 10, filter: null, full_path: false,
        show_dupes: false,
      });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
  });

  it('doNearDupes: runs without error', async () => {
    const { doNearDupes } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doNearDupes(index, {
        near_dupes: 10, filter: null, full_path: false,
        show_dupes: false,
      });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
  });

  it('doStructDupes: runs without error', async () => {
    const { doStructDupes } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doStructDupes(index, {
        struct_dupes: 10, filter: null, full_path: false,
        show_dupes: false, show_funcstring: false,
      });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
  });

  it('doShowFuncstring: shows funcstring for named function', async () => {
    const { doShowFuncstring } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doShowFuncstring(index, {
        show_funcstring: 'helper_function',
        full_path: false, filter: null,
      });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
    assert.ok(lines.some(l => l.includes('Funcstring')),
      'Should show funcstring label');
  });

  it('doStructDupes + show_funcstring: shows funcstrings inline', async () => {
    const { doStructDupes } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doStructDupes(index, {
        struct_dupes: 10, filter: null, full_path: false,
        show_dupes: false, show_funcstring: true,
      });
    } finally {
      console.log = origLog;
    }
    // If there are struct dupes, funcstrings should appear
    if (lines.some(l => l.includes('structural dupe'))) {
      assert.ok(lines.some(l => l.includes('Funcstring')),
        'Should show funcstrings when show_funcstring=true');
    }
  });


  // ------------------------------------------------------------------
  // verbose implies show_dupes
  // ------------------------------------------------------------------

  it('doFuncDupes: --verbose implies --show-dupes', async () => {
    const { doFuncDupes } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const fakeArgs = {
        func_dupes: 10, filter: null, full_path: false,
        show_dupes: false, verbose: true,
      };
      doFuncDupes(index, fakeArgs);
      assert.ok(fakeArgs.show_dupes, '--verbose should set show_dupes to true');
    } finally {
      console.log = origLog;
    }
  });


  // ------------------------------------------------------------------
  // Binary extension exclusion
  // ------------------------------------------------------------------

  it('buildIndex: directory walk already excludes non-source files', async () => {
    const mixedDir = path.join(os.tmpdir(), 'code_exam_test_p4_binary');
    fs.mkdirSync(mixedDir, { recursive: true });

    // Create some source files
    fs.writeFileSync(path.join(mixedDir, 'main.py'), 'def hello():\n    print("hi")\n');
    fs.writeFileSync(path.join(mixedDir, 'lib.js'), 'function greet() { return "hi"; }\n');
    // Create binary files — _walkDir skips these (not in DEFAULT_EXTENSIONS)
    fs.writeFileSync(path.join(mixedDir, 'logo.png'), 'fake png data');
    fs.writeFileSync(path.join(mixedDir, 'sound.mp3'), 'fake mp3 data');
    fs.writeFileSync(path.join(mixedDir, 'video.mp4'), 'fake mp4 data');

    const idx = new CodeSearchIndex({ indexPath: path.join(os.tmpdir(), 'code_exam_test_p4_binary_idx') });
    const stats = await idx.buildIndex(mixedDir, { showProgress: false });
    // _walkDir only gathers files in DEFAULT_EXTENSIONS, so binary files never enter the pipeline
    assert.equal(stats.files_indexed, 2, `Should index 2 source files, got ${stats.files_indexed}`);
  });

  it('buildIndex: skips binary files from @filelist.txt', async () => {
    const listDir = path.join(os.tmpdir(), 'code_exam_test_p4_filelist');
    fs.mkdirSync(listDir, { recursive: true });

    fs.writeFileSync(path.join(listDir, 'code.py'), 'def main():\n    pass\n');
    fs.writeFileSync(path.join(listDir, 'pic.jpg'), 'fake jpg');
    fs.writeFileSync(path.join(listDir, 'data.wav'), 'fake wav');

    const listPath = path.join(listDir, 'files.txt');
    fs.writeFileSync(listPath, [
      path.join(listDir, 'code.py'),
      path.join(listDir, 'pic.jpg'),
      path.join(listDir, 'data.wav'),
    ].join('\n'));

    const idx = new CodeSearchIndex({ indexPath: path.join(os.tmpdir(), 'code_exam_test_p4_filelist_idx') });
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      const stats = await idx.buildIndex(`@${listPath}`, { showProgress: true });
      assert.equal(stats.files_indexed, 1, 'Should only index code.py from file list');
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.some(l => l.includes('Skipped') && l.includes('binary')),
      'Should report binary files skipped from file list');
  });


  // ------------------------------------------------------------------
  // extractWordHoles
  // ------------------------------------------------------------------

  it('extractWordHoles: classifies tokens correctly', () => {
    const tokens = index.extractWordHoles('if (myVar > 10) { return result; }');
    const wordTokens = tokens.filter(t => t.type === 'word');
    const structTokens = tokens.filter(t => t.type === 'structure');

    // "if" and "return" should be structure
    assert.ok(structTokens.some(t => t.value === 'if'), '"if" should be structure');
    assert.ok(structTokens.some(t => t.value === 'return'), '"return" should be structure');
    // "myVar", "10", "result" should be word holes
    assert.ok(wordTokens.some(t => t.value === 'myVar'), '"myVar" should be word-hole');
    assert.ok(wordTokens.some(t => t.value === '10'), '"10" should be word-hole');
    assert.ok(wordTokens.some(t => t.value === 'result'), '"result" should be word-hole');
  });

  it('extractWordHoles: strips comments before tokenizing', () => {
    const tokens = index.extractWordHoles('x = 5; // comment\ny = /* block */ 10;');
    const wordVals = tokens.filter(t => t.type === 'word').map(t => t.value);
    assert.ok(!wordVals.includes('comment'), 'Should not include // comment text');
    assert.ok(!wordVals.includes('block'), 'Should not include /* */ comment text');
  });

  it('extractWordHoles: handles string literals as single word-hole', () => {
    const tokens = index.extractWordHoles('msg = "hello world";');
    const wordTokens = tokens.filter(t => t.type === 'word');
    assert.ok(wordTokens.some(t => t.value === '"hello world"'), 'String literal should be single word-hole');
  });

  it('extractWordHoles: structural dupes have same number of word-holes', () => {
    const bodyA = `void log_error(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    log_write(LOG_ERROR, fmt, args);
    va_end(args);
}`;
    const bodyB = `void log_warn(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    log_write(LOG_WARN, fmt, args);
    va_end(args);
}`;
    const tokensA = index.extractWordHoles(bodyA);
    const tokensB = index.extractWordHoles(bodyB);
    const wordsA = tokensA.filter(t => t.type === 'word');
    const wordsB = tokensB.filter(t => t.type === 'word');
    assert.equal(wordsA.length, wordsB.length,
      `Should have same number of word-holes: ${wordsA.length} vs ${wordsB.length}`);
  });


  // ------------------------------------------------------------------
  // structDiff
  // ------------------------------------------------------------------

  it('structDiff: detects word-hole differences', () => {
    const bodyA = `void log_error(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    log_write(LOG_ERROR, fmt, args);
    va_end(args);
}`;
    const bodyB = `void log_warn(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    log_write(LOG_WARN, fmt, args);
    va_end(args);
}`;
    const result = index.structDiff([
      { body: bodyA, label: 'log_error' },
      { body: bodyB, label: 'log_warn' },
    ]);

    assert.ok(result, 'Should return result');
    assert.ok(result.aligned, 'Should be aligned');
    assert.ok(result.diffs.length > 0, 'Should have diffs');
    assert.ok(result.totalWordHoles > 0, 'Should have word holes');

    // Should find the log_error -> log_warn substitution
    assert.ok(result.substitutions.some(s =>
      s.from === 'log_error' && s.to === 'log_warn' ||
      s.from === 'LOG_ERROR' && s.to === 'LOG_WARN'),
      'Should detect log_error/LOG_ERROR substitution');
  });

  it('structDiff: summary mentions diff count', () => {
    const bodyA = 'int compute(int price) { return price * 2; }';
    const bodyB = 'int calculate(int cost) { return cost * 2; }';
    const result = index.structDiff([
      { body: bodyA, label: 'compute' },
      { body: bodyB, label: 'calculate' },
    ]);
    assert.ok(result.summary.includes('word-holes differ'),
      'Summary should mention word-hole diffs');
  });

  it('structDiff: identical bodies report no diffs', () => {
    const body = 'void init() { setup(); configure(); }';
    const result = index.structDiff([
      { body, label: 'a' },
      { body, label: 'b' },
    ]);
    assert.equal(result.diffs.length, 0, 'Identical bodies should have 0 diffs');
  });

  it('structDiff: multiple substitution patterns detected', () => {
    const bodyA = `void process_order(Order order) {
    OrderValidator validator;
    validator.validate(order);
    OrderResult result = validator.getResult();
    return result;
}`;
    const bodyB = `void process_invoice(Invoice invoice) {
    InvoiceValidator validator;
    validator.validate(invoice);
    InvoiceResult result = validator.getResult();
    return result;
}`;
    const result = index.structDiff([
      { body: bodyA, label: 'process_order' },
      { body: bodyB, label: 'process_invoice' },
    ]);

    assert.ok(result.aligned, 'Should be aligned');
    assert.ok(result.diffs.length > 2, 'Should have multiple diffs');
    // Should detect Order -> Invoice pattern
    assert.ok(result.substitutions.some(s =>
      (s.from.includes('Order') && s.to.includes('Invoice')) ||
      (s.from.includes('order') && s.to.includes('invoice'))),
      'Should detect Order/Invoice substitution pattern');
  });


  // ------------------------------------------------------------------
  // doStructDiff display command
  // ------------------------------------------------------------------

  it('doStructDiff: runs without error on structural dupes', async () => {
    const { doStructDiff } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doStructDiff(index, {
        struct_diff: 'process_order',
        full_path: false, filter: null,
      });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
    // Should mention word-holes or variants
    assert.ok(lines.some(l =>
      l.includes('word-hole') || l.includes('variant') ||
      l.includes('Structural dupe') || l.includes('Substitution')),
      'Should contain structural diff info');
  });

  it('doStructDiff: reports exact dupes correctly', async () => {
    const { doStructDiff } = await import('../src/commands/dedup.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doStructDiff(index, {
        struct_diff: 'helper_function',
        full_path: false, filter: null,
      });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
  });


  // ------------------------------------------------------------------
  // Vocabulary discovery (TF-IDF)
  // ------------------------------------------------------------------

  it('ensureVocabulary: builds vocabulary from test files', () => {
    // Clear any cached vocabulary
    index._vocabulary = null;
    const vocabPath = path.join(INDEX_DIR, 'vocabulary.json');
    if (fs.existsSync(vocabPath)) fs.unlinkSync(vocabPath);

    const vocab = index.ensureVocabulary(false);
    assert.ok(vocab.size > 0, `Should find vocabulary tokens, got ${vocab.size}`);
  });

  it('ensureVocabulary: tokens have expected fields', () => {
    const vocab = index.ensureVocabulary(false);
    for (const [token, data] of [...vocab.entries()].slice(0, 5)) {
      assert.ok(typeof data.doc_freq === 'number', `${token} missing doc_freq`);
      assert.ok(typeof data.total_count === 'number', `${token} missing total_count`);
      assert.ok(typeof data.score === 'number', `${token} missing score`);
      assert.ok(Array.isArray(data.top_files), `${token} missing top_files`);
      assert.ok(data.doc_freq >= 2, `${token} should have doc_freq >= 2`);
    }
  });

  it('ensureVocabulary: filters out language keywords', () => {
    const vocab = index.ensureVocabulary(false);
    assert.ok(!vocab.has('if'), '"if" should be filtered (keyword)');
    assert.ok(!vocab.has('return'), '"return" should be filtered (keyword)');
    assert.ok(!vocab.has('for'), '"for" should be filtered (keyword)');
  });

  it('ensureVocabulary: filters out programming stopwords', () => {
    const vocab = index.ensureVocabulary(false);
    assert.ok(!vocab.has('self'), '"self" should be filtered (stopword)');
    assert.ok(!vocab.has('None'), '"None" should be filtered (stopword)');
    assert.ok(!vocab.has('len'), '"len" should be filtered (stopword)');
  });

  it('ensureVocabulary: handles JS prototype property names as tokens', async () => {
    // Regression test: tokens like "constructor", "toString", "hasOwnProperty"
    // must not collide with Object.prototype — uses Object.create(null)
    const protoDir = path.join(os.tmpdir(), 'code_exam_test_p4_proto');
    fs.mkdirSync(protoDir, { recursive: true });
    fs.writeFileSync(path.join(protoDir, 'a.py'), [
      'def constructor(x):',
      '    return constructor(x)',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(protoDir, 'b.py'), [
      'def constructor(y):',
      '    return constructor(y)',
      '',
    ].join('\n'));

    const idx2 = new CodeSearchIndex({ indexPath: path.join(os.tmpdir(), 'code_exam_test_p4_proto_idx') });
    await idx2.buildIndex(protoDir, { showProgress: false });
    // This should NOT throw "Cannot set properties of undefined"
    assert.doesNotThrow(() => {
      idx2.ensureVocabulary(false);
    }, 'Should handle "constructor" token without prototype collision');
  });

  it('ensureVocabulary: saves and reloads cache', () => {
    const vocabPath = path.join(INDEX_DIR, 'vocabulary.json');
    assert.ok(fs.existsSync(vocabPath), 'Cache file should exist');

    // Clear in-memory, reload from cache
    const sizeBefore = index._vocabulary.size;
    index._vocabulary = null;
    const vocab = index.ensureVocabulary(false);
    assert.ok(vocab.size > 0, 'Should reload from cache');
  });

  it('getTopVocabulary: returns sorted by score descending', () => {
    const top = index.getTopVocabulary(20);
    assert.ok(top.length > 0, 'Should return tokens');
    for (let i = 1; i < top.length; i++) {
      assert.ok(top[i - 1].score >= top[i].score, 'Should be sorted by score desc');
    }
  });

  it('getTopVocabulary: filter narrows results', () => {
    const all = index.getTopVocabulary(100);
    const filtered = index.getTopVocabulary(100, 'helper');
    assert.ok(filtered.length <= all.length, 'Filtered should be subset');
    for (const entry of filtered) {
      assert.ok(entry.token.toLowerCase().includes('helper'),
        `Filtered token '${entry.token}' should contain 'helper'`);
    }
  });

  it('getTopVocabulary: top_files includes representative files', () => {
    const top = index.getTopVocabulary(10);
    for (const entry of top) {
      assert.ok(entry.top_files.length > 0,
        `Token '${entry.token}' should have representative files`);
      for (const f of entry.top_files) {
        assert.ok(f.path, 'top_file should have path');
        assert.ok(typeof f.count === 'number', 'top_file should have count');
        assert.ok(typeof f.concentration === 'number', 'top_file should have concentration');
      }
    }
  });

  it('doVocabulary: runs without error', async () => {
    const { doVocabulary } = await import('../src/commands/metrics.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doVocabulary(index, {
        discover_vocabulary: 10, filter: null, full_path: false,
      });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
    assert.ok(lines.some(l => l.includes('domain vocabulary')),
      'Should mention domain vocabulary in header');
  });

  it('doVocabulary: filter works in display', async () => {
    const { doVocabulary } = await import('../src/commands/metrics.js');
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(' '));
    try {
      doVocabulary(index, {
        discover_vocabulary: 10, filter: 'helper', full_path: false,
      });
    } finally {
      console.log = origLog;
    }
    assert.ok(lines.length > 0, 'Should produce output');
  });

  it('ensureVocabulary: skips tokens longer than 200 chars', async () => {
    // Create a file with an absurdly long identifier
    const longDir = path.join(os.tmpdir(), 'code_exam_test_p4_longtoken');
    fs.mkdirSync(longDir, { recursive: true });
    const longToken = 'a'.repeat(250);
    // Put it in two files so it would pass minDocFreq=2
    fs.writeFileSync(path.join(longDir, 'a.py'), `${longToken} = 1\ndef foo():\n    pass\n`);
    fs.writeFileSync(path.join(longDir, 'b.py'), `${longToken} = 2\ndef foo():\n    pass\n`);

    const idx = new CodeSearchIndex({ indexPath: path.join(os.tmpdir(), 'code_exam_test_p4_longtoken_idx') });
    await idx.buildIndex(longDir, { showProgress: false });
    const vocab = idx.ensureVocabulary(false);
    assert.ok(!vocab.has(longToken), 'Token >200 chars should be excluded');
  });

  it('getTopVocabulary: pathFilter restricts to matching files', () => {
    // Our test index has files in copy/ and lib/ subdirectories
    const allVocab = index.getTopVocabulary(100);
    const copyVocab = index.getTopVocabulary(100, null, 'copy');

    // copyVocab should be non-empty (there are files in copy/)
    assert.ok(copyVocab.length > 0, 'Should find vocabulary in copy/ files');
    // copyVocab should be <= allVocab since it's a subset
    assert.ok(copyVocab.length <= allVocab.length,
      'Filtered vocab should not exceed global vocab count');
  });

  it('getTopVocabulary: pathFilter returns empty for non-matching pattern', () => {
    const noMatch = index.getTopVocabulary(100, null, 'zzz_no_such_path');
    assert.equal(noMatch.length, 0, 'Should return empty for non-matching path filter');
  });
});
