// test_bare_count_commands.js — top-N list commands must default, not error, when run bare
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_bare_count_commands.js — the inverse of the optional_value '.' sentinel.
 *
 * A family of list commands whose argument is a top-N count (--hotspots,
 * --most-called, --entry-points, --vocabulary, --hot-folders, --class-hotspots,
 * --domain-fns) were required `int` args, so running them bare printed
 * `Error: --X requires a number` instead of a sensible top-N. A newcomer running
 * `ce --hotspots` to "see the hotspots" got an error, not the hotspots.
 *
 * From the first-contact bare-command sweep (2026-10-09). The four named in the
 * sweep plus the three same-shape siblings found while scanning. Fix: default to
 * a top-N (20; vocabulary 50) and honor --all-results / --max-results 0. An
 * explicit count is still respected.
 *
 * Run: node --test test/test_bare_count_commands.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_bare_count_commands');
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

const BARE_COMMANDS = [
  'hotspots', 'most-called', 'entry-points', 'vocabulary',
  'hot-folders', 'class-hotspots', 'domain-fns',
];

before(() => {
  fs.mkdirSync(SRC_DIR, { recursive: true });

  // Functions that call each other → call counts, entry points, hotspots.
  fs.writeFileSync(path.join(SRC_DIR, 'app.py'), `
def main():
    helper()
    helper()
    compute()

def helper():
    compute()

def compute():
    return 1 + 2
`);
  // A class with methods that call each other → class hotspots.
  fs.writeFileSync(path.join(SRC_DIR, 'svc.py'), `
class Service:
    def run(self):
        self.load()
        self.load()

    def load(self):
        return 2
`);

  runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
});

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});


describe('bare top-N commands default instead of erroring', () => {
  for (const cmd of BARE_COMMANDS) {
    it(`--${cmd} run bare does not error "requires a number"`, () => {
      const out = runCLI(`--${cmd} --index-path ${IDX_DIR} 2>&1`);
      assert.doesNotMatch(out, /requires a number/, `bare --${cmd} should not demand a count: ${out}`);
      assert.doesNotMatch(out, /^Error:/m, `bare --${cmd} should not error: ${out}`);
    });
  }

  it('bare --hotspots shows the hotspots header (actually ran)', () => {
    const out = runCLI(`--hotspots --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /Top \d+ hotspots/i, 'should show the hotspots table: ' + out);
  });

  it('bare --entry-points actually ran (no parse error)', () => {
    const out = runCLI(`--entry-points --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /entry|point/i, 'should show entry-points output: ' + out);
  });
});


describe('explicit count is still respected (no regression)', () => {
  it('--hotspots 1 shows exactly the top 1', () => {
    const out = runCLI(`--hotspots 1 --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /Top 1 hotspots/, 'explicit count should drive the header: ' + out);
  });
});
