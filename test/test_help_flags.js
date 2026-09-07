// test_help_flags.js — help discoverability: --gui/--port/--load-index in --help; --load-index synonym
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_help_flags.js - CLI help discoverability + --load-index synonym.
 *
 * Run: node --test test/test_help_flags.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
function run(...args) {
  return spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', input: '' });
}

describe('help discoverability', () => {
  it('--help lists --gui, --port, and --load-index', () => {
    const r = run('--help');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--gui\b/);
    assert.match(r.stdout, /--port\b/);
    assert.match(r.stdout, /--load-index\b/);
  });

  it('--help gui (filtered) surfaces the GUI flag', () => {
    const r = run('--help', 'gui');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--gui\b/);
  });

  it('--load-index is a synonym for --index-path (bad path → No index found)', () => {
    const r = run('--load-index', 'definitely_not_here');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /No index found at "definitely_not_here"/);
  });
});
