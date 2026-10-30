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
import { llamaInitOptions, llamaLogToStderr, getLlamaShared, isNoBinaryError, NO_BINARY_MESSAGE } from '../src/core/llm-runner.js';

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

test('llamaInitOptions pins build to "never", routes llama.cpp logs to stderr, and sets gpu only when CPU is forced', () => {
  for (const o of [llamaInitOptions(), llamaInitOptions({}), llamaInitOptions({ cpu: false })]) {
    assert.deepStrictEqual(Object.keys(o).sort(), ['build', 'logger']);
    assert.strictEqual(o.build, 'never');
    assert.strictEqual(o.logger, llamaLogToStderr);
  }
  const cpu = llamaInitOptions({ cpu: true });
  assert.deepStrictEqual(Object.keys(cpu).sort(), ['build', 'gpu', 'logger']);
  assert.strictEqual(cpu.gpu, false);
  assert.strictEqual(cpu.build, 'never');
  assert.strictEqual(cpu.logger, llamaLogToStderr);
  // No gpu key unless CPU is forced: node-llama-cpp's own GPU detection decides.
  assert.ok(!('gpu' in llamaInitOptions()));
  // No logLevel key: the threshold stays node-llama-cpp's, only the stream moves.
  assert.ok(!('logLevel' in llamaInitOptions()));
});

// The loader's notes (`load: control-looking token: …`) arrive below `warn`, and
// node-llama-cpp's default logger prints those levels with console.info, which is
// stdout -- so a `ce … > chart.md` capture of a local run opened with them (#325
// on the Gemma 3 chart; four lines on the Gemma 4 run of 2026-10-29). Every level
// goes to stderr now, with a newline each, and nothing touches stdout.
test('llamaLogToStderr writes every level to stderr and nothing to stdout', () => {
  const out = [];
  const err = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  try {
    llamaLogToStderr('info', "load: control-looking token:      1 '<eos>' was not control-type; this is probably a bug in the model. its type will be overridden");
    llamaLogToStderr('warn', "load: special_eog_ids contains '<|tool_response>', removing '</s>' token from EOG list\n");
    llamaLogToStderr('debug', '');
    llamaLogToStderr('disabled', 'never shown');
    llamaLogToStderr('log', 'two\nlines');
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
  }
  assert.deepStrictEqual(out, []);
  assert.deepStrictEqual(err, [
    "load: control-looking token:      1 '<eos>' was not control-type; this is probably a bug in the model. its type will be overridden\n",
    "load: special_eog_ids contains '<|tool_response>', removing '</s>' token from EOG list\n",
    'two\nlines\n',
  ]);
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

// local-llama-one-instance-per-process (2026-10-30): node-llama-cpp 3.22.1 loses
// the JavaScript logger after a SECOND getLlama() in a process (upstream
// withcatai/node-llama-cpp#684), and CodeExam called twice on every local GPU
// run (the early CUDA touch, then the lazy load). So the one getLlama( call
// under src/ lives in llm-runner.js, pinned to llamaInitOptions( as before, and
// every other engine site asks getLlamaShared( for the process's instance.
test('one getLlama( call under src/, in llm-runner.js, pinned to llamaInitOptions(; every other site calls getLlamaShared( (#231, #684)', () => {
  const direct = [];
  const unpinned = [];
  const shared = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;          // comment-only line
      if (/\bgetLlamaShared\s*\(/.test(line) && !/^\s*export\s+async\s+function/.test(line)) shared.push(`${rel}:${i + 1}`);
      if (!/(?<!Shared)\bgetLlama\s*\(/.test(line.replace(/getLlamaShared/g, 'X'))) return; // not a direct call
      direct.push(`${rel}:${i + 1}`);
      if (!/\bgetLlama\s*\(\s*llamaInitOptions\s*\(/.test(line) && !/\.getLlama\(opts\)/.test(line)) unpinned.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepStrictEqual(direct.filter((c) => !c.startsWith('src/core/llm-runner.js')), [],
    `getLlama( called outside llm-runner.js (a second instance silences the logger, #684):\n  ${direct.join('\n  ')}`);
  assert.ok(direct.length >= 1, 'llm-runner.js holds the one direct getLlama( call');
  assert.deepStrictEqual(unpinned, [], `getLlama( called without llamaInitOptions( (build "never", #231):\n  ${unpinned.join('\n  ')}`);
  // The six engine sites: the CLI's early touch, the server's late-init, the
  // server's load, --ask-ai, the local overview, the drafter's lazy load.
  assert.ok(shared.length >= 6, `expected at least 6 getLlamaShared( sites under src/, found ${shared.length}: ${shared.join(', ')}`);
});

test('getLlamaShared: one instance per option set, a rejected creation retried, the second-instance note once', async () => {
  const made = [];
  const loader = async (opts) => { made.push(opts); return { id: made.length, opts }; };
  const instances = new Map();
  const a = await getLlamaShared({}, { loader, instances });
  const b = await getLlamaShared({ cpu: false }, { loader, instances });
  assert.strictEqual(a, b, 'the same instance for the same option set');
  assert.strictEqual(made.length, 1);
  assert.deepStrictEqual(made[0], llamaInitOptions(), 'the loader receives the pinned options');
  // A different option set is a second instance, and says so on stderr once.
  const err = [];
  const se = process.stderr.write;
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  let c;
  try {
    c = await getLlamaShared({ cpu: true }, { loader, instances });
    await getLlamaShared({ cpu: true }, { loader, instances });
  } finally { process.stderr.write = se; }
  assert.notStrictEqual(c, a);
  assert.strictEqual(made.length, 2);
  assert.deepStrictEqual(made[1], llamaInitOptions({ cpu: true }));
  assert.strictEqual(err.length, 1, 'one note for the second instance, none for the reuse');
  assert.match(err[0], /second engine instance \(cpu\).*stdout.*#684/);
  // A rejected creation is not cached: the next request tries again.
  const failing = new Map();
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new Error('NoBinaryFoundError'); return { ok: true }; };
  await assert.rejects(getLlamaShared({}, { loader: flaky, instances: failing }), /NoBinaryFoundError/);
  assert.strictEqual(failing.size, 0, 'nothing cached after the failure');
  assert.deepStrictEqual(await getLlamaShared({}, { loader: flaky, instances: failing }), { ok: true });
  assert.strictEqual(calls, 2);
  // Concurrent requests share one creation.
  const slow = new Map();
  let slowCalls = 0;
  const slowLoader = async () => { slowCalls++; await new Promise((r) => setTimeout(r, 5)); return { slow: true }; };
  const [x, y] = await Promise.all([getLlamaShared({}, { loader: slowLoader, instances: slow }), getLlamaShared({}, { loader: slowLoader, instances: slow })]);
  assert.strictEqual(x, y);
  assert.strictEqual(slowCalls, 1);
});
