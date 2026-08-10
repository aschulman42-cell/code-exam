// #306 F70 — credential masking at the tool-output seam.
//
// The measured leak: `claude_pto.py:97  API_KEY = "pVJt….uqDZ…SPdJ"` reached an
// Overview as a model name. asus-CC established the path is `search` returning a
// raw source line — no deterministic tool classified it as a model — so the mask
// belongs upstream of every consumer, not at the prose layer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskCredentials, hasCredential } from '../src/core/credential-mask.js';

describe('#306 credential mask — values go, everything else stays', () => {
  it('masks the .as_ml_code shape that caused the leak', () => {
    const out = maskCredentials('claude_pto.py:97:  API_KEY = "pVJtBCU4.uqDZQQQQQQQQSPdJ"');
    // The FINDING survives: file, line, identifier.
    assert.match(out, /claude_pto\.py:97/);
    assert.match(out, /API_KEY/);
    // The value does not.
    assert.doesNotMatch(out, /uqDZ/);
    assert.match(out, /<redacted \d+-char secret>/);
  });

  it('catches the assignment forms the corpora actually use', () => {
    for (const src of [
      'config.py:12:  api_key = "abcdefghijklmnop123"',
      'const cfg = { authToken: "zzzzzzzzzzzzzzzzzzzz" };',
      "SECRET_KEY := 'aaaaaaaaaaaaaaaaaaaaaa'",
      'password = "hunter2hunter2hunter2"',
    ]) assert.ok(hasCredential(src), `missed: ${src}`);
  });

  it('catches vendor key shapes with no assignment context at all', () => {
    for (const src of [
      'curl -H "Bearer sk-abcdefghijklmnopqrstuvwxyz123456"',
      'ghp_abcdefghijklmnopqrstuvwxyz01',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghijkl',
    ]) assert.ok(hasCredential(src), `missed: ${src}`);
  });

  // THE FALSE-POSITIVE TESTS. Entropy alone was rejected as a rule precisely
  // because minified identifiers and hashes are high-entropy and legitimate;
  // masking those would gut every bundled file CE exists to examine.
  it('leaves env-var NAMES alone — that is what referenced_resources reports', () => {
    const src = 'Environment variables (2):\n  OPENAI_API_KEY\n  ANTHROPIC_API_KEY';
    assert.equal(maskCredentials(src), src);
  });

  it('leaves long legitimate identifiers and hashes alone', () => {
    for (const src of [
      'function buildVocabularyFromFilesAndDirectories(index) {',
      'const sha = "e3b0c44298fc1c149afbf4c8996fb924"; // not assigned to a secret name',
      'import { AuthProvider } from "./auth/provider.js";',
      'KEY = "abc"',   // under the 8-char floor
    ]) assert.equal(maskCredentials(src), src, `over-masked: ${src}`);
  });

  it('reports the length so the reader knows what was there', () => {
    assert.match(maskCredentials('token = "0123456789abcdef"'), /<redacted 16-char secret>/);
  });

  it('is inert on empty and non-string input', () => {
    for (const v of ['', null, undefined]) assert.equal(maskCredentials(v), v == null ? '' : v);
  });
});

// The regression that nearly shipped: the mask was added as a wrapper around the
// EXPORT, while the MCP server's own dispatch called the raw switch directly. It
// would have covered importers (overview loop, chat loop, tests) and NOT the MCP
// server — the path Claude Code and Claude Desktop use. Same shape as F67:
// accepted at one site, dropped at the one that matters.
describe('#306 credential mask — reaches the MCP dispatch, not just importers', () => {
  it('the exported handleTool is the masked one, and the raw one is distinct', async () => {
    const mod = await import('../src/mcp-server.js');
    assert.equal(typeof mod.handleTool, 'function');
    assert.equal(typeof mod._handleToolUnmasked, 'function');
    assert.notEqual(mod.handleTool, mod._handleToolUnmasked,
      'export must be the wrapper — if these are the same function nothing is masked');
  });

  it('source has no call to the raw switch outside the wrapper', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/mcp-server.js', 'utf8');
    // Exclude the declaration — `function handleToolRaw(` matches the same
    // pattern as a call, which is what this assertion first tripped over.
    const rawCalls = [...src.matchAll(/(?<!function\s)handleToolRaw\(/g)].length;
    // Exactly one: inside handleTool(). Any other is a path that skips the mask.
    assert.equal(rawCalls, 1, 'handleToolRaw is called somewhere other than the mask wrapper');
  });
});
