// test_build_oom_preflight.js — build-oom-preflight-guidance: the advisory decision
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_build_oom_preflight.js — a `--build-index` run can die with an UNCATCHABLE
 * V8 heap OOM, so the only remedy is guidance BEFORE the build. `buildOomAdvisory`
 * is the pure decision: given a cheap census of the input (largest file, file
 * count, total bytes), return a one-time advisory or null. Advisory only; nothing
 * is skipped. A real OOM can't be unit-tested, so this pins the decision directly.
 *
 * Run: node --test test/test_build_oom_preflight.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildOomAdvisory } from '../src/core/CodeSearchIndex.js';

const MB = 1024 * 1024, GB = 1024 * MB;

describe('buildOomAdvisory', () => {
  it('shape 1 — one very large file → heap + --split-bundle advice', () => {
    const m = buildOomAdvisory({ largestFileBytes: 20 * MB, fileCount: 3, totalBytes: 21 * MB });
    assert.ok(m, 'should advise on a tens-of-MB single file');
    assert.match(m, /--split-bundle/, m);
    assert.match(m, /heap out of memory/i, m);
    assert.doesNotMatch(m, /--multi-index/, 'shape 1 is not the shard remedy');
  });

  it('shape 2 — huge file count → heap + shard / --multi-index advice', () => {
    const m = buildOomAdvisory({ largestFileBytes: 50 * 1024, fileCount: 60000, totalBytes: 500 * MB });
    assert.ok(m, 'should advise on a huge file count');
    assert.match(m, /--multi-index/, m);
    assert.match(m, /shard/i, m);
  });

  it('shape 2 — large total bytes → heap + shard advice', () => {
    const m = buildOomAdvisory({ largestFileBytes: 50 * 1024, fileCount: 2000, totalBytes: Math.round(1.2 * GB) });
    assert.ok(m, 'should advise on a ~1 GB+ corpus');
    assert.match(m, /--multi-index/, m);
  });

  it('a single large file dominates when both trip (split-bundle, not multi-index)', () => {
    const m = buildOomAdvisory({ largestFileBytes: 30 * MB, fileCount: 60000, totalBytes: Math.round(1.2 * GB) });
    assert.match(m, /--split-bundle/, m);
    assert.doesNotMatch(m, /--multi-index/, m);
  });

  it('ordinary input → no advisory (must not false-fire on normal builds)', () => {
    assert.equal(buildOomAdvisory({ largestFileBytes: 2 * MB, fileCount: 500, totalBytes: 50 * MB }), null);
    assert.equal(buildOomAdvisory({}), null);
  });
});
