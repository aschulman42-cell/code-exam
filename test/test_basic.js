/**
 * test_basic.js - Basic smoke tests for code-exam Node.js port.
 *
 * Run: node --test test/test_basic.js
 * Or:  node test/test_basic.js  (standalone)
 *
 * Tests build, search, function parsing, extract, and cross-language support.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

// ========================================================================
// Test fixtures
// ========================================================================

const TEST_DIR = path.join(os.tmpdir(), 'code_exam_test_src');
const INDEX_DIR = path.join(os.tmpdir(), 'code_exam_test_idx');

function setupTestFiles() {
  fs.mkdirSync(path.join(TEST_DIR, 'subdir'), { recursive: true });

  fs.writeFileSync(path.join(TEST_DIR, 'main.py'), `#!/usr/bin/env python3
"""Main entry point."""

import os
from utils import helper_function

class Application:
    def __init__(self, config):
        self.config = config
    
    def run(self):
        return helper_function(self.config)

def main():
    app = Application("test")
    return app.run()
`);

  fs.writeFileSync(path.join(TEST_DIR, 'utils.py'), `"""Utilities."""

def helper_function(data):
    if not data:
        return "empty"
    return str(data).upper()

def compute_score(items):
    total = sum(items)
    return total
`);

  fs.writeFileSync(path.join(TEST_DIR, 'subdir', 'worker.java'), `package com.example;

public class Worker {
    public void addTask(String task) {
        // add task
    }
    
    public int processTasks() {
        return 0;
    }
    
    private boolean executeTask(String task) {
        // TODO: implement
        return true;
    }
}
`);
}


// ========================================================================
// Tests
// ========================================================================

describe('CodeSearchIndex', () => {

  // Setup: create test files and build index once
  let index;

  it('setup: creates test files and builds index', async () => {
    setupTestFiles();
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    const stats = await index.buildIndex(TEST_DIR, { showProgress: false });

    assert.ok(stats.files_indexed >= 3, `Expected >=3 files, got ${stats.files_indexed}`);
    assert.ok(stats.total_lines > 20, `Expected >20 lines, got ${stats.total_lines}`);
    assert.equal(stats.errors.length, 0, `Unexpected errors: ${stats.errors}`);
  });

  it('stats: correct file and line counts', () => {
    const stats = index.getStats();
    assert.ok(stats.files_indexed >= 3);
    assert.ok(stats.total_lines > 20);
  });

  it('listFiles: returns all indexed files', () => {
    const files = index.listFiles();
    assert.ok(files.length >= 3);
    assert.ok(files.some(f => f.includes('main.py')));
    assert.ok(files.some(f => f.includes('utils.py')));
    assert.ok(files.some(f => f.includes('worker.java')));
  });

  it('listFunctions: finds Python functions and classes', () => {
    const funcs = index.listFunctions();
    const names = funcs.map(f => f.name);
    assert.ok(names.includes('main'), 'Should find main()');
    assert.ok(names.includes('helper_function'), 'Should find helper_function()');
    assert.ok(names.includes('compute_score'), 'Should find compute_score()');
    assert.ok(names.includes('Application'), 'Should find Application class');
    assert.ok(names.some(n => n.includes('Application') && n.includes('run')),
              'Should find Application.run method');
  });

  it('listFunctions: finds Java methods with class qualification', () => {
    const funcs = index.listFunctions('worker.java');
    const names = funcs.map(f => f.name);
    assert.ok(names.includes('Worker'), 'Should find Worker class');
    assert.ok(names.some(n => n.includes('addTask')), 'Should find addTask method');
    assert.ok(names.some(n => n.includes('processTasks')), 'Should find processTasks');
    assert.ok(names.some(n => n.includes('executeTask')), 'Should find executeTask');
  });

  it('searchLiteral: finds exact text matches', () => {
    const results = index.searchLiteral('helper_function');
    assert.ok(results.length >= 2, `Expected >=2 results, got ${results.length}`);
    assert.ok(results.some(r => r.filePath.includes('main.py')));
    assert.ok(results.some(r => r.filePath.includes('utils.py')));
  });

  it('searchLiteral: regex mode works', () => {
    const results = index.searchLiteral('def \\w+\\(', { useRegex: true });
    assert.ok(results.length >= 4, `Expected >=4 def results, got ${results.length}`);
  });

  it('searchInverted: finds matches via inverted index', () => {
    const results = index.searchInverted('TODO');
    assert.ok(results.length >= 1, 'Should find TODO comment');
    assert.ok(results.some(r => r.filePath.includes('worker.java')));
  });

  it('getFunctionSource: extracts Python function', () => {
    const source = index.getFunctionSource('utils.py', 'helper_function');
    assert.ok(source !== null, 'Should find function source');
    assert.ok(source.includes('def helper_function'), 'Should contain def');
    assert.ok(source.includes('return'), 'Should contain return statement');
  });

  it('getFunctionSource: extracts qualified method', () => {
    const source = index.getFunctionSource('main.py', 'Application::run');
    assert.ok(source !== null, 'Should find method source');
    assert.ok(source.includes('def run'), 'Should contain def run');
  });

  it('findFunctionMatches: bare name finds across files', () => {
    const matches = index.findFunctionMatches('main');
    assert.ok(matches.length >= 1, 'Should find main function');
    assert.ok(matches.some(m => m.filepath.includes('main.py')));
  });

  it('findPathMatches: finds files/dirs matching pattern', () => {
    const matches = index.findPathMatches('worker');
    assert.ok(matches.length >= 1, 'Should find worker.java');
  });

  it('_findContainingFunction: identifies function for a line', () => {
    // Line inside helper_function in utils.py should be in that function
    const funcName = index._findContainingFunction('utils.py', 5);
    assert.ok(funcName !== null, 'Should find containing function');
    assert.ok(funcName.includes('helper_function') || funcName === 'helper_function',
              `Expected helper_function, got ${funcName}`);
  });

  it('search results include function context', () => {
    const results = index.searchLiteral('TODO');
    assert.ok(results.length >= 1);
    assert.ok(results[0].functionName !== null, 'Should include function name');
  });

  it('persistence: can reload index from disk', () => {
    const fresh = new CodeSearchIndex({ indexPath: INDEX_DIR });
    assert.ok(fresh.files.size >= 3, `Expected >=3 files after reload, got ${fresh.files.size}`);
    const results = fresh.searchLiteral('helper_function');
    assert.ok(results.length >= 2, 'Search should work after reload');
  });

  it('#191 persistence: skippedExtensions round-trips through save/load', () => {
    // Archive/zip builds record extensions present-but-not-indexed; persist them
    // so the GUI Extensions accordion can surface them without re-expanding.
    index.skippedExtensions = { '.cu': 12, '.png': 3 };
    index._saveLiteralIndex();
    const fresh = new CodeSearchIndex({ indexPath: INDEX_DIR });
    assert.equal(fresh.skippedExtensions['.cu'], 12);
    assert.equal(fresh.skippedExtensions['.png'], 3);
  });

  it('JSON format: compatible with Python version', () => {
    // Verify the on-disk format matches Python's structure
    const funcIndex = JSON.parse(fs.readFileSync(path.join(INDEX_DIR, 'function_index.json'), 'utf-8'));
    
    // Should have filepath keys
    assert.ok('utils.py' in funcIndex, 'Should have utils.py key');
    
    // Each function should have start, end, type, base_name
    const helperFunc = funcIndex['utils.py']['helper_function'];
    assert.ok(helperFunc, 'Should have helper_function entry');
    assert.ok(typeof helperFunc.start === 'number', 'start should be number');
    assert.ok(typeof helperFunc.end === 'number', 'end should be number');
    assert.ok(typeof helperFunc.type === 'string', 'type should be string');
    assert.ok(typeof helperFunc.base_name === 'string', 'base_name should be string');
  });
});


// ========================================================================
// Run standalone if not using node --test
// ========================================================================

// The test runner handles execution via `node --test`
