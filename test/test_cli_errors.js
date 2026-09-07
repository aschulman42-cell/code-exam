// test_cli_errors.js — CLI bad input fails before index load: banner, error, run-help, exit 2
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_cli_errors.js - CLI bad-input handling.
 *
 * Run: node --test test/test_cli_errors.js
 *
 * Verifies that bad CLI input fails cleanly BEFORE the index load (so the real
 * error isn't masked by "No index found"): banner + error + run-help, exit 2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
// A cwd with no default .code_search_index — so a pre-fix run would hit the
// "No index found" exit instead of the arg error. This is what guards the fix.
const CLEAN_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-cli-err-'));

function runCE(...args) {
  return spawnSync(process.execPath, [ENTRY, ...args], { cwd: CLEAN_CWD, encoding: 'utf8' });
}

describe('cmdline error handling', () => {
  it('unknown flag → exit 2, banner + error + run-help, not "No index found"', () => {
    const r = runCE('--foobar');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unknown option '--foobar'/);
    assert.match(r.stderr, /CodeExam/);                       // banner
    assert.match(r.stderr, /Run 'ce --help'/);                // run-help hint
    assert.doesNotMatch(r.stdout + r.stderr, /No index found/);
  });

  it('unexpected positional → exit 2, banner + error, not "No index found"', () => {
    const r = runCE('foobar');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Unexpected argument 'foobar'/);
    assert.match(r.stderr, /CodeExam/);
    assert.match(r.stderr, /Run 'ce --help'/);
    assert.doesNotMatch(r.stdout + r.stderr, /No index found/);
  });

  it('--version still works → exit 0, CodeExam <major.minor>', () => {
    const r = runCE('--version');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /CodeExam \d+\.\d+/);
  });

  it('--help still works → exit 0, banner present', () => {
    const r = runCE('--help');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /CodeExam --/);
    assert.match(r.stdout, /USAGE:/);
  });
});
