// test_llm_calls_local.js — listLlmCalls tier C: Ollama endpoints (port unconditional, /api/* paths gated on a file-level Ollama marker) (#345 part B)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_llm_calls_local.js — #345 part B. On the Ghost Architect index,
 * `--llm-calls` listed 7 Anthropic sites and 1 OpenAI site on a codebase whose
 * default backend is Ollama, because tier C recognized hosted endpoints only.
 *
 * The trap in the obvious fix: `/api/chat` is a generic route name. CodeExam's
 * own GUI serves `routes['/api/chat']` (src/server.js), and so does every chat
 * app. So:
 *
 *   - `localhost:11434` / `127.0.0.1:11434` are unconditional Ollama markers
 *     (the port is Ollama's and nothing else's);
 *   - `/api/chat` and `/api/generate` are Ollama markers only when the file
 *     also carries an Ollama marker (`ollama`, case-insensitive, or `11434`) —
 *     the same file-level gate shape as the tier B import gates. `/api/tags`
 *     (model listing) and `/api/embeddings` are not completion requests and
 *     are not markers.
 *
 * Also the combined read with part A (`declared` cell): the Ghost-shaped file
 * yields two Ollama endpoint sites (the config's endpoint default and the URL
 * build), a declared local `qwen3-coder:30b` and a declared api
 * `claude-sonnet-4-6`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

function indexOf(files) {
  const idx = new CodeSearchIndex({ indexPath: '.__test_llm_calls_local_noindex__' });
  idx.fileLines = new Map(Object.entries(files).map(([p, src]) => [p, Array.isArray(src) ? src : src.split('\n')]));
  return idx;
}

const GHOST = {
  // Ghost-shaped: the endpoint is a config default; the URL is built from it
  // with `/api/chat` and fetched; the model id is a config default, with a
  // hosted fallback in a getter.
  'model-provider.js': [
    'const DEFAULT_CONFIG = {',
    "  provider: 'ollama',",
    "  model: 'qwen3-coder:30b',",
    "  endpoint: 'http://localhost:11434',",
    '};',
    "function getModel(cfg) { return cfg.model || 'claude-sonnet-4-6'; }",
    "const trimSlash = (s) => s.endsWith('/') ? s.slice(0, -1) : s;",
    'export async function chat(cfg, messages) {',
    '  const url = `${trimSlash(cfg.endpoint)}/api/chat`;',
    "  const r = await fetch(url, { method: 'POST', body: JSON.stringify({ model: cfg.model, messages, stream: false }) });",
    '  return r.json();',
    '}',
  ],
  // Control: a CE-shaped route table with no Ollama marker anywhere in the file.
  'server.js': [
    'const routes = {};',
    "routes['/api/chat'] = (req, res) => { res.end('ok'); };",
    "routes['/api/generate'] = (req, res) => { res.end('ok'); };",
  ],
  // The port alone, with no other marker, is enough.
  'port-only.js': [
    "const base = 'http://localhost:11434';",
    "const alt = 'http://127.0.0.1:11434/v1';",
  ],
  // A health check against the model list is not a completion call.
  'probe.js': [
    "const probe = config.provider === 'ollama' ? '/api/tags' : '/';",
  ],
};

describe('#345 part B — Ollama endpoints in llm_calls', () => {
  const idx = indexOf(GHOST);
  const calls = idx.listLlmCalls();
  const ollama = calls.filter(t => t.provider === 'Ollama');

  it('the Ghost-shaped URL build is an Ollama endpoint site (tier C, heuristic)', () => {
    const site = ollama.find(t => t.filepath === 'model-provider.js' && /\/api\/chat/.test(t.marker));
    assert.ok(site, `no /api/chat site in ${JSON.stringify(calls.map(t => [t.filepath, t.line, t.provider, t.marker]))}`);
    assert.equal(site.kind, 'endpoint');
    assert.equal(site.tier, 'C');
    assert.equal(site.tag, 'heuristic');
    assert.equal(site.line, 9);
    assert.equal(site.model, null, 'the model id is not on the URL line');
  });

  it("the config's endpoint default is a second Ollama site, by the port", () => {
    const site = ollama.find(t => t.filepath === 'model-provider.js' && /11434/.test(t.marker));
    assert.ok(site, JSON.stringify(ollama.map(t => [t.filepath, t.line, t.marker])));
    assert.equal(site.line, 4);
  });

  it('a route table defining /api/chat with no Ollama marker is not listed', () => {
    assert.ok(!calls.some(t => t.filepath === 'server.js'), JSON.stringify(calls.map(t => [t.filepath, t.line, t.provider])));
  });

  it('the port is an unconditional marker', () => {
    const sites = ollama.filter(t => t.filepath === 'port-only.js');
    assert.equal(sites.length, 2, JSON.stringify(sites));
    assert.ok(sites.every(t => /11434/.test(t.marker)));
  });

  it('/api/tags in an Ollama file is a probe, not a call', () => {
    assert.ok(!calls.some(t => t.filepath === 'probe.js'), JSON.stringify(calls.filter(t => t.filepath === 'probe.js')));
  });

  it('the combined read with part A: two Ollama sites, a declared local tag, a declared api fallback', () => {
    assert.equal(ollama.filter(t => t.filepath === 'model-provider.js').length, 2);
    const models = idx.listModelsUsed();
    const byId = Object.fromEntries(models.map(m => [m.model, m]));
    assert.ok(byId['qwen3-coder:30b'], JSON.stringify(Object.keys(byId)));
    assert.equal(byId['qwen3-coder:30b'].access, 'local');
    assert.deepEqual(byId['qwen3-coder:30b'].cells, ['declared']);
    assert.equal(byId['qwen3-coder:30b'].sites[0].marker, 'assigned:model');
    assert.ok(byId['claude-sonnet-4-6'], JSON.stringify(Object.keys(byId)));
    assert.equal(byId['claude-sonnet-4-6'].access, 'api');
    assert.deepEqual(byId['claude-sonnet-4-6'].cells, ['declared']);
    assert.equal(byId['claude-sonnet-4-6'].sites[0].marker, 'fallback:model');
    assert.equal(models.unresolved, 0);
  });
});

describe('#345 part B — the self-match trap on CodeExam\'s own server', () => {
  it('src/server.js (which serves /api/chat) is not an Ollama caller', () => {
    const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
    const calls = indexOf({ 'src/server.js': src }).listLlmCalls();
    assert.ok(!calls.some(t => t.provider === 'Ollama'), JSON.stringify(calls.filter(t => t.provider === 'Ollama').map(t => [t.line, t.marker])));
  });
});
