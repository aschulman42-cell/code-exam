// test_llama_init_options.js — every node-llama-cpp engine load is pinned to build "never" (#231)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// node-llama-cpp's getLlama() defaults to build "auto": when no prebuilt
// llama.cpp binary loads on the machine, it downloads the llama.cpp source from
// GitHub and compiles it. That is a network fetch at first use, which fails in a
// sealed review room at the moment the feature is needed, and is an outbound
// connection on a machine that was supposed to be offline (#231). CodeExam
// therefore passes llamaInitOptions() to every getLlama() call, which pins
// build "never": a local build or a prebuilt binary loads as before; nothing
// else is attempted, and the NoBinaryFoundError is turned into one message
// that names the fix.
//
// Three checks: the helper's shape, the error recognizer, and a scan of src/
// asserting that every getLlama( call passes the helper, so a seventh call
// site cannot drift back to the default. The scan is by regex over the source
// with comment lines stripped (the AI/ML detector vocabulary and several
// comments mention getLlama( without calling it).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { llamaInitOptions, isNoBinaryError, NO_BINARY_MESSAGE } from '../src/core/llm-runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'vendor']);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), out);
    } else if (ent.name.endsWith('.js')) {
      out.push(path.join(dir, ent.name));
    }
  }
  return out;
}

test('llamaInitOptions pins build to "never" and sets gpu only when CPU is forced', () => {
  assert.deepStrictEqual(llamaInitOptions(), { build: 'never' });
  assert.deepStrictEqual(llamaInitOptions({}), { build: 'never' });
  assert.deepStrictEqual(llamaInitOptions({ cpu: false }), { build: 'never' });
  assert.deepStrictEqual(llamaInitOptions({ cpu: true }), { gpu: false, build: 'never' });
  // No gpu key unless CPU is forced: node-llama-cpp's own GPU detection decides.
  assert.ok(!('gpu' in llamaInitOptions()));
});

test('isNoBinaryError recognizes NoBinaryFoundError by class name or message, nothing else', () => {
  class NoBinaryFoundError extends Error { constructor(m = 'NoBinaryFoundError') { super(m); } }
  assert.strictEqual(isNoBinaryError(new NoBinaryFoundError()), true);
  assert.strictEqual(isNoBinaryError(new NoBinaryFoundError(
    'No prebuilt binaries found, no llama.cpp source found and `skipDownload` or NODE_LLAMA_CPP_SKIP_DOWNLOAD env var is set to true, so llama.cpp cannot be built from source')), true);
  // The upstream class does not set .name, so a plain Error carrying the class's
  // default message must still count (the class name is lost across a rethrow).
  assert.strictEqual(isNoBinaryError(new Error('NoBinaryFoundError')), true);
  assert.strictEqual(isNoBinaryError(new Error('cudaMalloc failed: out of memory')), false);
  assert.strictEqual(isNoBinaryError(new Error('Model file not found: x.gguf')), false);
  assert.strictEqual(isNoBinaryError(null), false);
  assert.strictEqual(isNoBinaryError(undefined), false);
  assert.strictEqual(isNoBinaryError('NoBinaryFoundError'), false);
  assert.match(NO_BINARY_MESSAGE, /#231/);
  assert.match(NO_BINARY_MESSAGE, /npm install/);
  assert.match(NO_BINARY_MESSAGE, /source download/);
});

test('every getLlama( call under src/ passes llamaInitOptions( — no download-and-build at first use (#231)', () => {
  const calls = [];
  const unpinned = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // comment-only line
      if (!/\bgetLlama\s*\(/.test(line)) return;              // not a call
      calls.push(`${rel}:${i + 1}`);
      if (!/\bgetLlama\s*\(\s*llamaInitOptions\s*\(/.test(line)) unpinned.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  // The scan must see the real call sites, or a regex drift would pass vacuously.
  assert.ok(calls.length >= 6, `expected at least 6 getLlama( call sites under src/, found ${calls.length}: ${calls.join(', ')}`);
  assert.deepStrictEqual(unpinned, [], `getLlama( called without llamaInitOptions( (build "never", #231):\n  ${unpinned.join('\n  ')}`);
});
