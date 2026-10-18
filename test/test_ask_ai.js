// test_ask_ai.js — --ask-ai: flag and alias, pre-flight refusals, engine choice, output shape and exit codes, with the loops stubbed
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * cli-ask-ai. The command's own behaviour is tested through its `deps` seam:
 * the three chat loops and the local loader are stubs, so no model loads and
 * nothing reaches a network. The loops themselves are the GUI Chat's,
 * exercised by hand there.
 *
 * Run: node --test test/test_ask_ai.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../src/argparse.js';
import { doAskAi } from '../src/commands/ask.js';

function withArgv(argv, fn) {
  const saved = process.argv;
  process.argv = ['node', 'src/index.js', ...argv];
  try { return fn(); } finally { process.argv = saved; }
}

function fakeIndexDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-ask-'));
  fs.writeFileSync(path.join(dir, 'literal_index.json'), '{}');
  return dir;
}

const fakeIndex = { files: new Map([['a.js', 1], ['b.js', 1]]) };

function capture() {
  const out = [], err = [];
  return { out, err, deps: { out: (s) => out.push(s), err: (s) => err.push(s), index: fakeIndex } };
}

test('--ask-ai takes the question, and --ask-AI is accepted as the same flag', () => {
  assert.equal(withArgv(['--ask-ai', 'what does X do?'], () => parseArgs()).ask_ai, 'what does X do?');
  assert.equal(withArgv(['--ask-AI', 'what does X do?'], () => parseArgs()).ask_ai, 'what does X do?');
  assert.equal(withArgv(['--overview'], () => parseArgs()).ask_ai, null);
});

test('refuses a missing index before loading anything, with exit 1', async () => {
  const c = capture();
  let loopCalled = false;
  const code = await doAskAi({ ask_ai: 'q?', index_path: path.join(os.tmpdir(), 'no-such-index-here'), llm: '' },
    { ...c.deps, chatRunner: { runChatToolLoop: async () => { loopCalled = true; } } });
  assert.equal(code, 1);
  assert.ok(!loopCalled);
  assert.match(c.err.join(''), /No CodeExam index at/);
  assert.equal(c.out.length, 0);
});

test('refuses an empty question', async () => {
  const c = capture();
  assert.equal(await doAskAi({ ask_ai: '   ', index_path: fakeIndexDir(), llm: '' }, c.deps), 1);
  assert.match(c.err.join(''), /A question is required/);
});

test('a cloud engine with no key exits 1 and names the key variable, without calling the loop', async () => {
  const c = capture();
  let loopCalled = false;
  const code = await doAskAi({ ask_ai: 'q?', index_path: fakeIndexDir(), llm: '' },
    { ...c.deps, cloudKey: '', chatRunner: { runChatToolLoop: async () => { loopCalled = true; return { answer: 'x' }; } } });
  assert.equal(code, 1);
  assert.ok(!loopCalled);
  assert.match(c.err.join(''), /no API key/);
  assert.match(c.err.join(''), /ANTHROPIC_API_KEY/);
});

test('cloud: prints the provenance header, the answer, then the tool-call footer, and exits 0', async () => {
  const c = capture();
  const seen = {};
  const runner = {
    runChatToolLoop: async (o) => {
      seen.opts = o;
      o.onToolCall('search', { pattern: 'x' });
      o.onToolCall('search', { pattern: 'y' });
      o.onToolCall('extract', { function_name: 'f' });
      return { answer: 'The answer, from the code.', content: [] };
    },
  };
  const dir = fakeIndexDir();
  const code = await doAskAi({ ask_ai: 'what calls f?', index_path: dir, llm: '', verbose: false }, { ...c.deps, cloudKey: 'k', chatRunner: runner });
  assert.equal(code, 0);
  const text = c.out.join('');
  const iHeader = text.indexOf('CodeExam ');
  const iQuestion = text.indexOf('Question: what calls f?');
  const iCommand = text.indexOf('Command: --ask-ai (grounding grounded)');
  const iAnswer = text.indexOf('The answer, from the code.');
  const iFooter = text.indexOf('ⓘ Based on 3 model tool calls: search ×2, extract.');
  for (const [name, i] of Object.entries({ iHeader, iQuestion, iCommand, iAnswer, iFooter })) assert.ok(i >= 0, `${name} present`);
  assert.ok(iHeader < iQuestion && iQuestion < iCommand && iCommand < iAnswer && iAnswer < iFooter, 'header, answer, footer in that order');
  assert.match(text, /AI: claude — claude-sonnet-4-6/);
  // The loop got the index, a single user message, and the CLI's air-gap hint.
  assert.equal(seen.opts.index, fakeIndex);
  assert.deepEqual(seen.opts.messages, [{ role: 'user', content: 'what calls f?' }]);
  assert.equal(seen.opts.fileCount, 2);
  assert.match(seen.opts.airGapHint, /--model <file\.gguf>/);
  // Each tool call was echoed on stderr.
  assert.equal((c.err.join('').match(/\[ask-ai\] tool: /g) || []).length, 3);
});

test('under --air-gapped a cloud engine is refused before any key is looked for', async () => {
  const c = capture();
  let keyLookedFor = false;
  const code = await doAskAi({ ask_ai: 'q?', index_path: fakeIndexDir(), llm: 'openai' },
    { ...c.deps, isAirGapped: () => true, get cloudKey() { keyLookedFor = true; return 'k'; }, chatRunner: { runChatToolLoopOpenAI: async () => { throw new Error('must not run'); } } });
  assert.equal(code, 1);
  assert.ok(!keyLookedFor, 'no key lookup before the refusal');
  assert.match(c.err.join(''), /--air-gapped: ChatGPT API is blocked\. Use --model <file\.gguf>/);
  assert.equal(c.out.length, 0);
});

test('a loop that throws (the air-gap refusal, say) exits 1 with the reason on stderr and nothing on stdout', async () => {
  const c = capture();
  const runner = { runChatToolLoop: async () => { throw new Error('--air-gapped: chat over the cloud LLM is blocked. Use --model <file.gguf>'); } };
  const code = await doAskAi({ ask_ai: 'q?', index_path: fakeIndexDir(), llm: '' }, { ...c.deps, cloudKey: 'k', chatRunner: runner });
  assert.equal(code, 1);
  assert.match(c.err.join(''), /did not complete: --air-gapped/);
  assert.equal(c.out.length, 0);
});

test('local: --model selects the local loop with the loaded holder; no key is needed', async () => {
  const c = capture();
  const seen = {};
  const holder = { _localModel: { contextSize: 8192 }, reproducible: false, ensureLocalModel: async () => ({ ok: true }), acquireSharedSequence: async () => ({}) };
  const runner = {
    runChatToolLoopLocal: async (o) => { seen.opts = o; o.onToolCall('digest', {}); return { answer: 'Local answer.', content: [] }; },
    runChatToolLoop: async () => { throw new Error('cloud loop must not run'); },
  };
  const code = await doAskAi({ ask_ai: 'q?', index_path: fakeIndexDir(), llm: '', model: '/models/gemma-4-12b-it-Q4_K_M.gguf' },
    { ...c.deps, chatRunner: runner, localHolder: holder });
  assert.equal(code, 0);
  assert.equal(seen.opts.local, holder);
  const text = c.out.join('');
  assert.match(text, /AI: local — gemma-4-12b-it-Q4_K_M\.gguf/);
  assert.match(text, /ⓘ Based on 1 model tool call: digest\./);
});

test('an openai-compatible engine goes to the OpenAI loop with its base URL for gemini', async () => {
  const c = capture();
  const seen = {};
  const runner = { runChatToolLoopOpenAI: async (o) => { seen.opts = o; return { answer: 'ok', content: [] }; } };
  const code = await doAskAi({ ask_ai: 'q?', index_path: fakeIndexDir(), llm: 'gemini' }, { ...c.deps, cloudKey: 'k', chatRunner: runner });
  assert.equal(code, 0);
  assert.match(seen.opts.baseUrl, /generativelanguage\.googleapis\.com/);
  assert.match(c.out.join(''), /ⓘ Based on 0 model tool calls/);
});
