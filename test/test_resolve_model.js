// test_resolve_model.js — resolveModel refuses a --model path that is not a file when the arguments are read (model-path-fail-fast, 2026-11-09)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Before, resolveModel returned a GGUF descriptor for any string and the file
// was checked at load time, so `--hof --model chatgpt` ran the grouper and then
// failed 189 drafts one by one ("model file not found: chatgpt"), and
// `--pseudo-claims --model chatgpt` wrote a claims file with 0 claims at exit
// 0. Now the refusal is the `kind: 'error'` every command already handles at
// its top, with the loader's own message and hints.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveModel, missingModelMessage } from '../src/core/llm-runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('resolveModel: a --model path that is not a file is refused at argument time', () => {
  it('a missing path is an error, not a descriptor', () => {
    const m = resolveModel({ model: 'no-such-model-here.gguf' });
    assert.equal(m.kind, 'error');
    assert.equal(m.error, 'model file not found: no-such-model-here.gguf (a relative --model path resolves against the current directory)');
  });
  it('a provider name given to --model says to use --llm', () => {
    for (const name of ['chatgpt', 'claude', 'gemini', 'openai']) {
      const m = resolveModel({ model: name });
      assert.equal(m.kind, 'error', name);
      assert.ok(m.error.endsWith(`; "${name}" names a cloud provider: --llm ${name}`), m.error);
    }
  });
  it('the legacy --claim-model and --analyze-model values go through the same check', () => {
    assert.equal(resolveModel({ claim_model: 'x.gguf' }).kind, 'error');
    assert.equal(resolveModel({ analyze_model: 'x.gguf' }).kind, 'error');
  });
  it('an existing file resolves as before, with the descriptor\'s fields', () => {
    const p = path.join(os.tmpdir(), 'ce-test-resolve-model.gguf');
    fs.writeFileSync(p, '');
    const m = resolveModel({ model: p, cpu: true });
    assert.deepEqual([m.kind, m.modelPath, m.forceCpu], ['gguf', p, true]);
  });
  const underModels = fs.existsSync(path.join(ROOT, 'models')) ? fs.readdirSync(path.join(ROOT, 'models')).find((f) => f.endsWith('.gguf')) : null;
  it('a bare file name that lives under models/ gets the did-you-mean hint', { skip: underModels ? false : 'no .gguf under models/' }, () => {
    const prev = process.cwd();
    process.chdir(ROOT);
    try {
      const m = resolveModel({ model: underModels });
      assert.equal(m.kind, 'error');
      assert.equal(m.error, `model file not found: ${underModels} — did you mean models/${underModels} ?`);
    } finally { process.chdir(prev); }
  });
  it('the loader shares the message (one site for the wording)', () => {
    assert.match(missingModelMessage('gone.gguf'), /^model file not found: gone\.gguf \(a relative --model path/);
  });
  it('--llm is untouched: a provider resolves to a cloud descriptor, an unknown one to the provider error', () => {
    assert.equal(resolveModel({ llm: 'claude' }).kind, 'cloud');
    assert.match(resolveModel({ llm: 'nope' }).error, /unknown cloud provider 'nope'/);
  });
});
