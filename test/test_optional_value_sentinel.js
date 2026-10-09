// test_optional_value_sentinel.js — bare optional_value flags must not inject a literal '.'
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_optional_value_sentinel.js — a flag of type `optional_value` given with no
 * value used to receive the literal string '.' (argparse.js flag-only branch).
 * Filter-consuming commands then matched on '.', which:
 *   - mislabeled output (`Strings matching "."`, `Filtered to: .`), and
 *   - BROKE --pseudo-claims, which fed '.' in as the sole anchor and no-opped.
 *
 * These are the "first-contact bare-command sweep" fixtures (2026-10-09): run
 * each command bare and read the output as a first-time user would. The fix
 * replaces the '.' marker with a boolean sentinel that no consumer mistakes for
 * a user-supplied filter string. An explicitly typed `.` is still honored.
 *
 * Run: node --test test/test_optional_value_sentinel.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_optional_value_sentinel');
const CLI = path.resolve('src/index.js');
const SRC_DIR = path.join(TEST_DIR, 'src');
const IDX_DIR = path.join(TEST_DIR, '.idx');

function runCLI(args) {
  try {
    return execSync(`node ${CLI} ${args}`, { encoding: 'utf-8', timeout: 30000, cwd: TEST_DIR });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

before(() => {
  fs.mkdirSync(SRC_DIR, { recursive: true });

  // Two modules with a cross-file call (a.py -> b.py), so --file-map has a real
  // dependency to show, and a distinctive string literal to filter on.
  fs.writeFileSync(path.join(SRC_DIR, 'a.py'), `
from b import shared_helper

def alpha():
    result = shared_helper()
    print("NEEDLE_STRING_ZZ")
    return result
`);
  fs.writeFileSync(path.join(SRC_DIR, 'b.py'), `
def shared_helper():
    return "helper_result_value"
`);

  runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
});

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});


describe('optional_value sentinel: --string-table', () => {
  it('bare --string-table shows no spurious `matching "."` filter label', () => {
    const out = runCLI(`--string-table --index-path ${IDX_DIR} 2>&1`);
    assert.doesNotMatch(out, /matching "\."/, 'bare --string-table must not filter on ".": ' + out);
    assert.match(out, /^\s*Strings: \d+ unique/m, 'label should read plain "Strings: N unique": ' + out);
  });

  it('an explicit filter is still honored (no regression)', () => {
    const out = runCLI(`--string-table NEEDLE --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /matching "NEEDLE"/, 'explicit filter should still label: ' + out);
    assert.match(out, /NEEDLE_STRING_ZZ/, 'explicit filter should match the string: ' + out);
  });
});


describe('optional_value sentinel: --file-map', () => {
  it('bare --file-map shows no spurious `Filtered to: .` line', () => {
    const out = runCLI(`--file-map --index-path ${IDX_DIR} 2>&1`);
    assert.doesNotMatch(out, /Filtered to: \./, 'bare --file-map must not report a "." filter: ' + out);
  });
});


describe('optional_value sentinel: --pseudo-claims', () => {
  it('bare --pseudo-claims gives the clean "no anchors" help, not a "." resolve no-op', () => {
    const out = runCLI(`--pseudo-claims --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /no anchors given/, 'bare --pseudo-claims should explain it needs anchors: ' + out);
    assert.doesNotMatch(out, /resolves to this anchor/, 'must not try to resolve "." as an anchor: ' + out);
    assert.doesNotMatch(out, /✗ \./, 'must not emit a "✗ ." failed-anchor line: ' + out);
  });
});
