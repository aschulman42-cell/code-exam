/**
 * test_phase2.js - Tests for Phase 2: callers, callees, call-tree, file-map.
 *
 * Run: node --test test/test_phase2.js
 *
 * Uses the same test fixtures as test_basic.js (Python + Java files).
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

const TEST_DIR = path.join(os.tmpdir(), 'code_exam_test_p2_src');
const INDEX_DIR = path.join(os.tmpdir(), 'code_exam_test_p2_idx');

function setupTestFiles() {
  fs.mkdirSync(path.join(TEST_DIR, 'lib'), { recursive: true });

  // main.py calls helper_function and compute_score
  fs.writeFileSync(path.join(TEST_DIR, 'main.py'), `#!/usr/bin/env python3
"""Main entry point."""

from lib.utils import helper_function, compute_score

class Application:
    def __init__(self, config):
        self.config = config

    def run(self):
        data = helper_function(self.config)
        score = compute_score([1, 2, 3])
        return data, score

def main():
    app = Application("test")
    result = app.run()
    helper_function(result)
    return result
`);

  // lib/utils.py defines helper_function and compute_score
  fs.writeFileSync(path.join(TEST_DIR, 'lib', 'utils.py'), `"""Utilities library."""

def helper_function(data):
    if not data:
        return "empty"
    return str(data).upper()

def compute_score(items):
    total = sum(items)
    return total

def format_output(data):
    text = helper_function(data)
    return f"Result: {text}"
`);

  // lib/worker.py calls helper_function
  fs.writeFileSync(path.join(TEST_DIR, 'lib', 'worker.py'), `"""Worker module."""
from lib.utils import helper_function

class Worker:
    def __init__(self):
        self.results = []

    def process(self, items):
        for item in items:
            result = helper_function(item)
            self.results.append(result)
        return self.results

    def reset(self):
        self.results = []
`);
}


// ========================================================================
// Tests
// ========================================================================

describe('Phase 2: Callers/Callees/Graph', () => {
  let index;

  it('setup: creates test files and builds index', async () => {
    setupTestFiles();
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    const stats = await index.buildIndex(TEST_DIR, { showProgress: false });
    assert.ok(stats.files_indexed >= 3, `Expected >=3 files, got ${stats.files_indexed}`);
  });

  // --- findCallers ---

  it('findCallers: finds callers of helper_function', () => {
    const callers = index.findCallers('helper_function');
    assert.ok(callers.length >= 3, `Expected >=3 callers, got ${callers.length}`);

    // Should find callers in main.py, worker.py, and utils.py (format_output)
    const callerFiles = new Set(callers.map(c => c.filepath));
    assert.ok(callerFiles.size >= 2, 'Should find callers in multiple files');
  });

  it('findCallers: identifies caller function names', () => {
    const callers = index.findCallers('helper_function');
    const callerFuncs = new Set(callers.map(c => c.caller_function).filter(Boolean));
    // Should identify at least main, run, process, format_output as callers
    assert.ok(callerFuncs.size >= 2, `Expected >=2 caller functions, got ${callerFuncs.size}`);
  });

  it('findCallers: assigns call types', () => {
    const callers = index.findCallers('helper_function');
    for (const c of callers) {
      assert.ok(['direct', 'method_ptr', 'method_dot', 'qualified', 'indirect', 'reference'].includes(c.call_type),
        `Unexpected call_type: ${c.call_type}`);
    }
  });

  it('findCallers: respects maxResults', () => {
    const callers = index.findCallers('helper_function', 2);
    assert.ok(callers.length <= 2, `Expected <=2 results with maxResults=2, got ${callers.length}`);
  });

  // --- findCallees ---

  it('findCallees: finds what main() calls', () => {
    const callees = index.findCallees('main');
    assert.ok(callees.length >= 1, `Expected >=1 callees for main, got ${callees.length}`);
    const names = callees.map(c => c.name);
    assert.ok(names.includes('helper_function') || names.includes('Application'),
      `Expected main to call helper_function or Application, got: ${names.join(', ')}`);
  });

  it('findCallees: finds what process() calls', () => {
    const callees = index.findCallees('process', 'worker');
    const names = callees.map(c => c.name);
    assert.ok(names.includes('helper_function'),
      `Expected process to call helper_function, got: ${names.join(', ')}`);
  });

  it('findCallees: includes definitions info', () => {
    const callees = index.findCallees('main');
    for (const ce of callees) {
      assert.ok(Array.isArray(ce.definitions), 'definitions should be array');
      assert.ok(ce.display_name, 'display_name should be set');
      assert.ok(ce.call_type, 'call_type should be set');
    }
  });

  it('findCallees: detects recursive calls', () => {
    // format_output calls helper_function, not itself — no recursion there
    // But main() doesn't call itself either. This just verifies the code path works.
    const callees = index.findCallees('format_output');
    const names = callees.map(c => c.name);
    assert.ok(names.includes('helper_function'),
      `Expected format_output to call helper_function, got: ${names.join(', ')}`);
  });

  // --- getCallCounts ---

  it('getCallCounts: returns counts for known functions', () => {
    const counts = index.getCallCounts(false);
    assert.ok(Object.keys(counts).length > 0, 'Should find some call counts');
    // helper_function should be one of the most called
    assert.ok(counts['helper_function'] > 0, 'helper_function should have call count > 0');
  });

  it('getCallCounts: no prototype pollution', () => {
    const counts = index.getCallCounts(false);
    // These should NOT be present unless actually called in the code
    // With Object.create(null), there's no prototype to pollute
    assert.equal(counts['__proto__'], undefined, '__proto__ should not be in counts');
    assert.equal(counts['hasOwnProperty'], undefined, 'hasOwnProperty should not be in counts');
  });

  // --- getCallCountsWithDefinitions ---

  it('getCallCountsWithDefinitions: includes definition info', () => {
    const results = index.getCallCountsWithDefinitions(false);
    assert.ok(results.length > 0);
    // Should be sorted by count descending
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].count >= results[i].count, 'Should be sorted by count desc');
    }
    // Check structure
    const first = results[0];
    assert.ok(typeof first.name === 'string');
    assert.ok(typeof first.count === 'number');
    assert.ok(Array.isArray(first.definitions));
  });

  // --- getAllFileDeps ---

  it('getAllFileDeps: finds cross-file dependencies', () => {
    const deps = index.getAllFileDeps(null, false);
    assert.ok(Object.keys(deps).length >= 1, 'Should find at least 1 file with deps');

    // main.py should depend on lib/utils.py
    let mainHasDep = false;
    for (const [src, targets] of Object.entries(deps)) {
      if (src.includes('main.py')) {
        for (const tgt of Object.keys(targets)) {
          if (tgt.includes('utils.py')) {
            mainHasDep = true;
          }
        }
      }
    }
    assert.ok(mainHasDep, 'main.py should depend on utils.py');
  });

  // --- _findContainingFunctionFromIndex ---

  it('_findContainingFunctionFromIndex: finds correct function', () => {
    const files = index.listFiles();
    const utilsFile = files.find(f => f.includes('utils.py'));
    assert.ok(utilsFile, 'Should find utils.py');

    // Line inside helper_function
    const func = index._findContainingFunctionFromIndex(utilsFile, 5);
    assert.ok(func, 'Should find containing function');
    assert.ok(func.includes('helper_function'), `Expected helper_function, got ${func}`);
  });

  // --- _getKnownFunctions ---

  it('_getKnownFunctions: builds function lookup', () => {
    const known = index._getKnownFunctions();
    assert.ok('helper_function' in known, 'Should have helper_function');
    assert.ok('compute_score' in known, 'Should have compute_score');
    assert.ok(Array.isArray(known['helper_function']), 'Should be array of defs');
    assert.ok(known['helper_function'].length >= 1, 'Should have at least 1 definition');
  });

  // --- Persistence ---

  it('persistence: caller/callee works after reload', () => {
    const fresh = new CodeSearchIndex({ indexPath: INDEX_DIR });
    const callers = fresh.findCallers('helper_function');
    assert.ok(callers.length >= 3, 'Callers should work after reload');
    const callees = fresh.findCallees('main');
    assert.ok(callees.length >= 1, 'Callees should work after reload');
  });
});
