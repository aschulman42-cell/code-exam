// test_models_used_defaults.js — listModelsUsed: declared model ids (config defaults, fallbacks, bare literals) and unresolved call arguments (#345 part A)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_models_used_defaults.js — #345 part A, reported by Ernst Wisner (Ghost
 * Architect): both AI overviews of his codebase said no model ids are written
 * into the code, while a config object set `model: 'qwen3-coder:30b'` and a
 * getter fell back to `'claude-sonnet-4-6'`. CodeExam's own `src/` had the same
 * miss (ten default-id literals invisible to `--models-used`).
 *
 * Two mechanisms, both locked in here:
 *
 *   1. A `declared` cell: a model-shaped string literal anywhere in code (a
 *      known family such as `claude-` / `gpt-` / `qwen`, an Ollama `name:tag`,
 *      or a weights file), reported as declared-in-code, not used-at-a-call.
 *      The family shape is the gate (Wisner's refinement); the assignment slot,
 *      when there is one, is a marker on the site, not a precondition.
 *   2. Disclosure of unresolved call arguments: a `{ model }` shorthand or a
 *      `model: getModel()` expression at a recognized call site counts as an
 *      unresolved reference, so the negative message reads "N model references
 *      found, but no id resolved" (#106 / #306 F50) instead of "No model ids
 *      found".
 *
 * The four-file fixture is the one measured in #345; `e.js` and `README.md`
 * carry the refinement cases and the negatives.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

// Synthetic in-memory index (same pattern as test_models_used_fp.js).
function indexOf(files) {
  const idx = new CodeSearchIndex({ indexPath: '.__test_models_used_defaults_noindex__' });
  idx.fileLines = new Map(Object.entries(files).map(([p, src]) => [p, Array.isArray(src) ? src : src.split('\n')]));
  return idx;
}

const FIXTURE = {
  // a.js — a JS `model:` literal on the call line is found as an llm-call id.
  'a.js': [
    "import Anthropic from '@anthropic-ai/sdk';",
    'const client = new Anthropic();',
    "const r = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 100, messages });",
  ],
  // d.py — a Python `model="…"` keyword at the call is found.
  'd.py': [
    'import anthropic',
    'client = anthropic.Anthropic()',
    'r = client.messages.create(model="claude-sonnet-4-6", max_tokens=100, messages=msgs)',
  ],
  // b.js — the id lives in a `||` fallback; the call passes a `{ model }` shorthand.
  'b.js': [
    "import OpenAI from 'openai';",
    'const openai = new OpenAI();',
    "const model = opts.model || 'gpt-5.1';",
    'const r = await openai.chat.completions.create({ model, messages });',
  ],
  // c.js — a config-object default plus an Ollama fetch (the fetch half is part B).
  'c.js': [
    'const DEFAULT_CONFIG = {',
    "  provider: 'ollama',",
    "  model: 'qwen3-coder:30b',",
    "  endpoint: 'http://localhost:11434',",
    '};',
    'export async function ask(cfg, messages) {',
    "  const r = await fetch(`${cfg.endpoint}/api/chat`, { method: 'POST', body: JSON.stringify({ model: cfg.model, messages }) });",
    '  return r.json();',
    '}',
  ],
  // e.js — refinement cases: a non-model-named variable, an array of candidates,
  // and the negatives (package names, a bare family word, a comment).
  'e.js': [
    "const M = 'gemini-2.5-flash';",
    "const CANDIDATES = ['claude-3-5-haiku-20241022', 'gpt-4o-mini'];",
    "const pkg = 'node-llama-cpp';",
    "const mod = 'llama_index';",
    "const word = 'gpt';",
    "// the old default was 'claude-opus-4-1' — comment only",
  ],
  // Documentation markup is not code.
  'README.md': ['Use `claude-opus-4-1` for best results.'],
  // A JSON key is a name (a token-statistics catalog), a JSON value is a default.
  'stats.json': ['{"tokens":{"gpt2":12,"llama3":4},"model":"gpt-4.1-mini"}'],
  // A prefix used for matching is not an id.
  'match.js': ["const isOpus = (id) => id.startsWith('claude-opus-4-7-');"],
};

describe('#345 part A — declared model ids reach models_used', () => {
  const models = indexOf(FIXTURE).listModelsUsed();
  const byId = Object.fromEntries(models.map(m => [m.model, m]));
  const ids = Object.keys(byId);

  it('a call-line literal stays an llm-call id, not doubled as declared (a.js + d.py)', () => {
    const m = byId['claude-sonnet-4-6'];
    assert.ok(m, `claude-sonnet-4-6 missing from ${JSON.stringify(ids)}`);
    assert.deepEqual(m.cells, ['llm-call']);
    assert.equal(m.count, 2);
    assert.equal(m.access, 'api');
  });

  it('a `|| literal` fallback is a declared default (b.js)', () => {
    const m = byId['gpt-5.1'];
    assert.ok(m, `gpt-5.1 missing from ${JSON.stringify(ids)}`);
    assert.deepEqual(m.cells, ['declared']);
    assert.equal(m.access, 'api');
    assert.match(m.sites[0].marker, /fallback/);
  });

  it('a config-object default with an Ollama tag is declared and local (c.js)', () => {
    const m = byId['qwen3-coder:30b'];
    assert.ok(m, `qwen3-coder:30b missing from ${JSON.stringify(ids)}`);
    assert.ok(m.cells.includes('declared'), JSON.stringify(m.cells));
    assert.equal(m.access, 'local');
    const declaredSite = m.sites.find(s => s.cell === 'declared');
    assert.ok(declaredSite && declaredSite.line === 3, JSON.stringify(m.sites));
    assert.equal(declaredSite.marker, 'assigned:model');
  });

  it('the family shape is the gate: a non-model-named variable and an array both count (e.js)', () => {
    for (const id of ['gemini-2.5-flash', 'claude-3-5-haiku-20241022', 'gpt-4o-mini']) {
      assert.ok(byId[id], `${id} missing from ${JSON.stringify(ids)}`);
      assert.deepEqual(byId[id].cells, ['declared']);
    }
  });

  it('package names, a bare family word, comments and Markdown are not models', () => {
    for (const id of ['node-llama-cpp', 'llama_index', 'gpt', 'claude-opus-4-1']) {
      assert.ok(!ids.includes(id), `${id} should not be in ${JSON.stringify(ids)}`);
    }
  });

  it('a JSON key is a name, a JSON value is a default; a matching prefix is not an id', () => {
    for (const id of ['gpt2', 'llama3', 'claude-opus-4-7-']) {
      assert.ok(!ids.includes(id), `${id} should not be in ${JSON.stringify(ids)}`);
    }
    assert.ok(byId['gpt-4.1-mini'], `gpt-4.1-mini missing from ${JSON.stringify(ids)}`);
    assert.equal(byId['gpt-4.1-mini'].sites[0].marker, 'assigned:model');
  });

  it('the `{ model }` shorthand is counted as an unresolved reference', () => {
    assert.ok(models.unresolved >= 1, `unresolved=${models.unresolved}`);
  });
});

describe('#345 part A — unresolved call arguments are disclosed, not dropped', () => {
  it('a shorthand with no resolvable assignment gives the "N references found" branch', () => {
    const models = indexOf({
      'f.js': [
        "import OpenAI from 'openai';",
        'const r = await openai.chat.completions.create({ model, messages });',
      ],
    }).listModelsUsed();
    assert.equal(models.length, 0);
    assert.equal(models.unresolved, 1);
  });

  it('a call expression as the model argument is unresolved and shown as a call', () => {
    const idx = indexOf({
      'g.js': [
        "import OpenAI from 'openai';",
        'const r = await openai.chat.completions.create({ model: getModel(), messages });',
      ],
    });
    const call = idx.listLlmCalls().find(t => t.marker === 'chat.completions.create');
    assert.ok(call, 'call site found');
    assert.equal(call.modelResolved, false);
    assert.equal(call.model, '<getModel()>');
    assert.equal(idx.listModelsUsed().unresolved, 1);
  });

  it('a shorthand that resolves to a same-file literal is resolved, not counted', () => {
    const models = indexOf({
      'h.js': [
        "import OpenAI from 'openai';",
        "const model = 'gpt-4o';",
        'const r = await openai.chat.completions.create({ model, messages });',
      ],
    }).listModelsUsed();
    assert.equal(models.unresolved, 0);
    const m = models.find(x => x.model === 'gpt-4o');
    assert.ok(m, JSON.stringify(models.map(x => x.model)));
    assert.ok(m.cells.includes('llm-call'), JSON.stringify(m.cells));
  });
});

describe('#345 part A — CodeExam\'s own provider registry', () => {
  // The measured miss on CE's own src/: `defaultModel:` ids in src/core/providers.js
  // were invisible to --models-used. A single-file index of the real file.
  const src = readFileSync(new URL('../src/core/providers.js', import.meta.url), 'utf8');
  const models = indexOf({ 'src/core/providers.js': src }).listModelsUsed();
  const ids = models.map(m => m.model);

  it('finds the three defaultModel ids as declared, all api', () => {
    for (const id of ['claude-sonnet-4-6', 'gpt-5.1', 'gemini-2.5-flash']) {
      const m = models.find(x => x.model === id);
      assert.ok(m, `${id} missing from ${JSON.stringify(ids)}`);
      assert.deepEqual(m.cells, ['declared']);
      assert.equal(m.access, 'api');
      assert.match(m.sites[0].marker, /defaultModel/);
    }
  });

  it('reports nothing else from that file', () => {
    assert.deepEqual([...ids].sort(), ['claude-sonnet-4-6', 'gemini-2.5-flash', 'gpt-5.1']);
  });
});
