/**
 * test_first_run.js - First-run / no-command experience.
 *
 * Run: node --test test/test_first_run.js
 *
 * Verifies: bare `ce` (no index) → short welcome leading with --gui, no load
 * (exit 0); a command with no index (--overview) → auto-loads the bundled demo;
 * explicit bad --index-path → "No index found" (exit 1); index loaded but no
 * command → guidance (exit 0), no auto-drop into the REPL.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-firstrun-'));

// input:'' feeds EOF on stdin, so a regression to auto-REPL can't hang the test.
function run(args, opts = {}) {
  return spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', input: '', timeout: 30000, ...opts });
}

describe('first-run experience', () => {
  it('bare `ce` (no index) → short welcome leading with --gui, no load/dump, exit 0', () => {
    const r = run([], { cwd: WORK });   // WORK has no .code_search_index, no --index-path
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
    assert.match(r.stdout, /CodeExam --/);                  // banner
    assert.match(r.stdout, /Welcome/);                      // a short welcome, not an info dump
    assert.match(r.stdout, /demo index is bundled/i);
    assert.match(r.stdout, /--gui/);                        // leads with --gui (users don't know it yet)
    assert.match(r.stdout, /--overview/);
    assert.match(r.stdout, /--build-index/);                // examine-your-own-code
    assert.doesNotMatch(r.stdout, /# Overview/);            // NO Overview dump on a bare run
    assert.doesNotMatch(r.stderr, /Loaded existing index|zip-index/);  // bare `ce` does NOT load the demo
    assert.doesNotMatch(r.stdout, /\.code_search_index/);   // never expose the internal default name
  });

  it('command with no index (--overview) → auto-loads the bundled demo and runs it', () => {
    const r = run(['--overview'], { cwd: WORK });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /bundled demo index/i);          // "using bundled demo" note
    assert.match(r.stdout, /# Overview/);                   // the demo Overview actually ran
  });

  it('explicit bad --index-path → "No index found at <path>", exit 1', () => {
    const r = run(['--index-path', 'definitely_not_here'], { cwd: WORK });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /No index found at "definitely_not_here"/);
  });

  it('index loaded, no command → guidance + exit 0, does NOT enter the REPL', () => {
    const src = path.join(WORK, 'proj');
    const idx = path.join(WORK, '.idx');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'a.py'), 'def hello():\n    return 1\n');

    const build = run(['--build-index', src, '--index-path', idx]);
    assert.equal(build.status, 0, `build failed: ${build.stderr}`);

    const r = run(['--index-path', idx]);   // no command
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No command given/);   // the new guidance (REPL wouldn't print this)
    assert.match(r.stdout, /CodeExam --/);        // banner
  });
});
