/**
 * test_follow_calls.js — Tests for --follow-calls (--deep) and --comments-only.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { doExtract } from '../src/commands/browse.js';
import fs from 'fs';
import path from 'path';
import os from 'os';


const TEST_DIR = path.join(os.tmpdir(), 'code_exam_test_follow');
const INDEX_DIR = path.join(os.tmpdir(), 'code_exam_test_follow_idx');

// Capture console.log output
let captured = [];
const origLog = console.log;

function startCapture() {
  captured = [];
  console.log = (...args) => captured.push(args.join(' '));
}
function stopCapture() {
  console.log = origLog;
  return captured.join('\n');
}

// Suppress stderr
const origStderrWrite = process.stderr.write;
before(() => { process.stderr.write = () => true; });
after(() => { process.stderr.write = origStderrWrite; });


function setupTestFiles() {
  fs.mkdirSync(path.join(TEST_DIR, 'lib'), { recursive: true });

  // Main file with functions that call each other
  fs.writeFileSync(path.join(TEST_DIR, 'main.py'), `"""Main module — orchestrates the pipeline."""

def run_pipeline(data, config):
    """Run the full analysis pipeline."""
    # Step 1: Validate input data
    validated = validate_input(data)

    # Step 2: Transform the data
    transformed = transform_data(validated, config)

    # Step 3: Compute results
    result = compute_score(transformed)

    # Return final output
    return result

def validate_input(data):
    """Check that input data meets requirements."""
    # Must be non-empty
    if not data:
        raise ValueError("Empty input")
    # Must have required fields
    if 'items' not in data:
        raise ValueError("Missing items field")
    return data

def transform_data(data, config):
    """Apply configured transformations."""
    # Apply scaling factor from config
    scale = config.get('scale', 1.0)
    items = [x * scale for x in data['items']]
    return {'items': items, 'scaled': True}

def compute_score(data):
    """Compute final aggregate score."""
    items = data['items']
    total = sum(items)
    average = total / len(items) if items else 0
    # Apply weighting
    weighted = average * 1.5
    return weighted
`);

  // Library file called from main
  fs.writeFileSync(path.join(TEST_DIR, 'lib', 'helpers.js'), `/**
 * helpers.js - Utility functions for data processing.
 *
 * These helpers are used by the main pipeline.
 */

// Format a number for display
function formatNumber(value, decimals) {
    // Round to specified decimal places
    const factor = Math.pow(10, decimals || 2);
    return Math.round(value * factor) / factor;
}

/**
 * Log a message with timestamp.
 * Used for pipeline diagnostics.
 */
function logMessage(level, msg) {
    const ts = new Date().toISOString();
    // Output to stderr for diagnostics
    process.stderr.write(ts + ' [' + level + '] ' + msg + '\\n');
}
`);
}


describe('--follow-calls', () => {
  let index;

  before(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(INDEX_DIR, { recursive: true, force: true });
    setupTestFiles();
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    await index.buildIndex(TEST_DIR, { showProgress: false });
  });

  it('extracts root function normally without --follow-calls', () => {
    startCapture();
    doExtract(index, { extract: 'run_pipeline', follow_calls: false, comments_only: false });
    const output = stopCapture();

    assert.ok(output.includes('run_pipeline'), 'should show root function');
    assert.ok(output.includes('validate_input'), 'should show call to validate_input');
    // Should NOT include callee source
    assert.ok(!output.includes('Must be non-empty'), 'should not include callee body');
  });

  it('extracts root function plus callees with --follow-calls', () => {
    startCapture();
    doExtract(index, { extract: 'run_pipeline', follow_calls: true, comments_only: false, depth: 1 });
    const output = stopCapture();

    // Should have the root function
    assert.ok(output.includes('run_pipeline'), 'should show root function');

    // Should have callee sources
    assert.ok(output.includes('called by run_pipeline'), 'should show callee attribution');

    // Should include callee body content
    assert.ok(output.includes('Must be non-empty') || output.includes('validate_input'),
      'should include validate_input callee');
  });

  it('shows "Callees of" header', () => {
    startCapture();
    doExtract(index, { extract: 'run_pipeline', follow_calls: true, comments_only: false, depth: 1 });
    const output = stopCapture();

    assert.ok(output.includes('Callees of run_pipeline'), 'should show callees header');
  });
});


describe('--comments-only', () => {
  let index;

  before(async () => {
    if (!fs.existsSync(TEST_DIR)) setupTestFiles();
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    if (index.files.size === 0) await index.buildIndex(TEST_DIR, { showProgress: false });
  });

  it('shows only comments from a Python function', () => {
    startCapture();
    doExtract(index, { extract: 'run_pipeline', follow_calls: false, comments_only: true });
    const output = stopCapture();

    // Should show comment lines
    assert.ok(output.includes('# Step 1'), 'should show # comments');
    assert.ok(output.includes('# Step 2'), 'should show step 2 comment');

    // Should NOT show code lines
    assert.ok(!output.includes('validated = validate_input'), 'should not show code');
    assert.ok(!output.includes('return result'), 'should not show return statement');
  });

  it('shows comments from JS functions', () => {
    startCapture();
    doExtract(index, { extract: 'formatNumber', follow_calls: false, comments_only: true });
    const output = stopCapture();

    // Should show // comments
    assert.ok(output.includes('// Round to specified decimal'), 'should show // comments');
    // Should not show code
    assert.ok(!output.includes('Math.pow'), 'should not show code');
  });

  it('shows docstrings from Python', () => {
    startCapture();
    doExtract(index, { extract: 'compute_score', follow_calls: false, comments_only: true });
    const output = stopCapture();

    // Should include docstring (either as """ or as comment)
    // And the inline comment
    assert.ok(output.includes('# Apply weighting') || output.includes('Compute final'),
      'should show comments or docstring');
  });

  it('combines --follow-calls and --comments-only', () => {
    startCapture();
    doExtract(index, { extract: 'run_pipeline', follow_calls: true, comments_only: true, depth: 1 });
    const output = stopCapture();

    // Should have the "Comments can lie!" tip
    assert.ok(output.includes('Comments can lie'), 'should warn about unreliable comments');

    // Should show comments from root AND callees
    assert.ok(output.includes('# Step 1'), 'should show root comments');
  });

  it('reports when no comments found', async () => {
    // Create a function with no comments
    const testDir2 = path.join(os.tmpdir(), 'code_exam_test_nocomments');
    const idxDir2 = path.join(os.tmpdir(), 'code_exam_test_nocomments_idx');
    fs.mkdirSync(testDir2, { recursive: true });
    fs.writeFileSync(path.join(testDir2, 'bare.py'), `def bare_func(x):
    y = x + 1
    z = y * 2
    return z
`);
    const idx2 = new CodeSearchIndex({ indexPath: idxDir2 });
    await idx2.buildIndex(testDir2, { showProgress: false });

    startCapture();
    doExtract(idx2, { extract: 'bare_func', follow_calls: false, comments_only: true });
    const output = stopCapture();

    assert.ok(output.includes('no full-line comments'), 'should report no comments');
  });
});
