/**
 * test_first_run.js - First-run / no-command experience.
 *
 * Run: node --test test/test_first_run.js
 *
 * Verifies: no index → banner + getting-started (exit 1); index loaded but no
 * command → banner + guidance (exit 0) and CE does NOT auto-drop into the REPL.
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
  it('no index (default) → banner + getting-started, exit 1, no ".code_search_index" fixation', () => {
    const r = run([], { cwd: WORK });   // WORK has no .code_search_index, no --index-path
    assert.equal(r.status, 1);
    assert.match(r.stdout, /CodeExam --/);                              // banner
    assert.match(r.stdout, /No index loaded/);                         // generic, not the internal path
    assert.doesNotMatch(r.stdout, /\.code_search_index/);             // don't expose the internal default
    assert.match(r.stdout, /Getting started/);
    assert.match(r.stdout, /--indexes/);                               // see existing
    assert.match(r.stdout, /--build-index/);                          // build advice
    assert.match(r.stdout, /--index-path <dir>\s+load an existing index/);  // standalone load line
    assert.match(r.stdout, /-i --index-path <dir>/);                       // distinct REPL line (-i first)
    assert.match(r.stdout, /github\.com\/aschulman42-cell\/code-exam/);  // README/source
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
