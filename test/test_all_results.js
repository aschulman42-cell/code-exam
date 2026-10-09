// test_all_results.js — --all-results / --max-results 0 cap semantics (effectiveMaxResults)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Coverage for the cli-all-results item: --all-results lifts the per-scope cap,
// an explicit --max-results N uses N, an explicit 0 means "no cap" (fixing the
// `args.max_results || <default>` trap that silently showed FEWER than asked),
// and the per-command default applies when the user set nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import { effectiveMaxResults, capNotice } from '../src/argparse.js';

const mk = ({ explicit = false, max_results = 20, all_results = false } = {}) => ({
  _explicit: new Set(explicit ? ['max_results'] : []),
  max_results,
  all_results,
});

test('default: unset max-results uses the command default', () => {
  assert.strictEqual(effectiveMaxResults(mk(), 10), 10);
  assert.strictEqual(effectiveMaxResults(mk(), 30), 30);
});

test('--all-results lifts the cap (Infinity) regardless of max-results', () => {
  assert.strictEqual(effectiveMaxResults(mk({ all_results: true }), 10), Infinity);
  assert.strictEqual(
    effectiveMaxResults(mk({ all_results: true, explicit: true, max_results: 5 }), 10),
    Infinity,
  );
});

test('explicit --max-results N uses N', () => {
  assert.strictEqual(effectiveMaxResults(mk({ explicit: true, max_results: 50 }), 10), 50);
  assert.strictEqual(effectiveMaxResults(mk({ explicit: true, max_results: 1 }), 30), 1);
});

test('explicit --max-results 0 means no cap (not the old default-fallback trap)', () => {
  assert.strictEqual(effectiveMaxResults(mk({ explicit: true, max_results: 0 }), 10), Infinity);
});

test('non-positive / NaN explicit values fall through to no cap, not a silent default', () => {
  assert.strictEqual(effectiveMaxResults(mk({ explicit: true, max_results: -3 }), 10), Infinity);
});

test('an Infinity cap passes slice() and never trips a "+N more" truncation check', () => {
  const rows = [1, 2, 3, 4, 5];
  const cap = effectiveMaxResults(mk({ all_results: true }), 2);
  assert.deepStrictEqual(rows.slice(0, cap), rows);
  assert.strictEqual(rows.length > cap, false);
});

test('capNotice: withheld rows produce a tip that names --all-results', () => {
  const n = capNotice(165, 50, 'strings');
  assert.match(n, /\+115 more strings/);
  assert.match(n, /--all-results/);
});

test('capNotice: nothing withheld yields no tip (shown >= total, e.g. under --all-results)', () => {
  assert.strictEqual(capNotice(50, 50, 'strings'), '');
  assert.strictEqual(capNotice(165, Infinity, 'strings'), '');
});
