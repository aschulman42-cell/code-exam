// test_cap_notice.js — capped CLI lists disclose --all-results via the central capNotice
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_cap_notice.js — the CLI cap-notice central sweep.
 *
 * Every capped list/catalog command should: (a) honor --all-results /
 * --max-results 0, and (b) end a truncated listing with the standard capNotice
 * tip that names --all-results — with the per-command flag named for top-N
 * count commands (e.g. --hotspots <N>), not the generic --max-results.
 *
 * Unit tests pin capNotice's wording + the raiseWith argument; an integration
 * test drives --hotspots end-to-end to confirm the tip appears when truncated
 * and is gone under --all-results / --max-results 0.
 *
 * Run: node --test test/test_cap_notice.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { capNotice } from '../src/argparse.js';

describe('capNotice wording', () => {
  it('names --max-results by default and --all-results always', () => {
    assert.equal(
      capNotice(100, 20, 'things'),
      '  ... +80 more things (use --max-results <N> or --all-results to see all)');
  });

  it('names a per-command flag when raiseWith is given', () => {
    assert.equal(
      capNotice(100, 20, 'hotspots', '--hotspots <N>'),
      '  ... +80 more hotspots (use --hotspots <N> or --all-results to see all)');
  });

  it('returns empty when nothing was withheld (shown >= total)', () => {
    assert.equal(capNotice(20, 20, 'things'), '');
    assert.equal(capNotice(20, 50, 'things'), '');
    assert.equal(capNotice(20, Infinity, 'things'), '');
  });
});


const TEST_DIR = path.join(os.tmpdir(), 'ce_test_cap_notice');
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
  // 25 called functions → more than the default --hotspots cap of 20.
  let body = 'def main():\n';
  for (let i = 0; i < 25; i++) body += `    f${i}()\n`;
  body += '\n';
  for (let i = 0; i < 25; i++) body += `def f${i}():\n    x = ${i}\n    return x + 1\n\n`;
  fs.writeFileSync(path.join(SRC_DIR, 'app.py'), body);
  runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
});

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('cap-notice end-to-end (--hotspots)', () => {
  const TIP = /\+\d+ more hotspots \(use --hotspots <N> or --all-results to see all\)/;

  it('a truncated --hotspots discloses the flag-aware --all-results tip', () => {
    const out = runCLI(`--hotspots --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, TIP, 'truncated hotspots should disclose the tip: ' + out);
    assert.doesNotMatch(out, /for more\./, 'old bespoke wording should be gone: ' + out);
  });

  it('--all-results removes the truncation tip (shows everything)', () => {
    const out = runCLI(`--hotspots --all-results --index-path ${IDX_DIR} 2>&1`);
    assert.doesNotMatch(out, TIP, 'under --all-results nothing is withheld: ' + out);
  });

  it('--max-results 0 also means unlimited (no tip)', () => {
    const out = runCLI(`--hotspots --max-results 0 --index-path ${IDX_DIR} 2>&1`);
    assert.doesNotMatch(out, TIP, '--max-results 0 should uncap: ' + out);
  });
});
