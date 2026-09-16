// test_llm_runner_session_isolation.js — local GGUF drafter isolates each target's KV sequence, not just its chat history
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// #328 / #325 position defect. makeGgufDrafter reused one LlamaChatSession and
// called resetChatHistory() between targets. That rewrites the history object
// but leaves every evaluated token in the context sequence, so a target's
// verdict depended on its position in the run (updateSelectedTrack: ASSUMED at
// position 1-2, ABSENT at position 9, deterministic). These tests pin the
// isolation contract with fakes, so no model is needed and a revert to
// history-only reset fails the suite.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { isolateLocalSession } from '../src/core/llm-runner.js';

function fakes({ clearThrows = false } = {}) {
  const calls = [];
  const sequence = {
    async clearHistory() { calls.push('sequence.clearHistory'); if (clearThrows) throw new Error('old build'); },
  };
  const session = { async resetChatHistory() { calls.push('session.resetChatHistory'); } };
  class ChatSession { constructor(opts) { calls.push('new ChatSession'); this.opts = opts; } }
  const sessionOptions = async (seq) => { calls.push('sessionOptions'); return { contextSequence: seq }; };
  return { calls, sequence, session, ChatSession, sessionOptions };
}

test('#328 default: clears the KV sequence and rebuilds the session on it', async () => {
  const f = fakes();
  const next = await isolateLocalSession({ ...f, reuse: false });
  assert.deepEqual(f.calls, ['sequence.clearHistory', 'sessionOptions', 'new ChatSession']);
  assert.notStrictEqual(next, f.session, 'a fresh session, not the reused one');
  assert.strictEqual(next.opts.contextSequence, f.sequence, 'rebuilt on the SAME sequence (no new slot)');
});

test('#328 default never relies on resetChatHistory alone', async () => {
  const f = fakes();
  await isolateLocalSession({ ...f, reuse: false });
  assert.ok(!f.calls.includes('session.resetChatHistory'),
    'history-object reset leaves evaluated tokens in the sequence — the defect');
});

test('#328 a build without clearHistory support still gets a fresh session', async () => {
  const f = fakes({ clearThrows: true });
  const next = await isolateLocalSession({ ...f, reuse: false });
  assert.notStrictEqual(next, f.session);
  assert.ok(f.calls.includes('new ChatSession'));
});

test('#328 CE_REUSE_SESSION=1 reproduces the old behaviour exactly', async () => {
  const f = fakes();
  const next = await isolateLocalSession({ ...f, reuse: true });
  assert.deepEqual(f.calls, ['session.resetChatHistory']);
  assert.strictEqual(next, f.session);
});

test('#328 reuse defaults from the environment at call time', async () => {
  const prev = process.env.CE_REUSE_SESSION;
  try {
    process.env.CE_REUSE_SESSION = '1';
    const a = fakes();
    assert.strictEqual(await isolateLocalSession({ session: a.session, sequence: a.sequence, ChatSession: a.ChatSession, sessionOptions: a.sessionOptions }), a.session);
    delete process.env.CE_REUSE_SESSION;
    const b = fakes();
    assert.notStrictEqual(await isolateLocalSession({ session: b.session, sequence: b.sequence, ChatSession: b.ChatSession, sessionOptions: b.sessionOptions }), b.session);
  } finally {
    if (prev === undefined) delete process.env.CE_REUSE_SESSION; else process.env.CE_REUSE_SESSION = prev;
  }
});

// The helper is only a fix if the drafter calls it. Comments are stripped
// because they discuss resetChatHistory at length.
test('#328 makeGgufDrafter routes between-target reset through isolateLocalSession', () => {
  const src = fs.readFileSync(new URL('../src/core/llm-runner.js', import.meta.url), 'utf8');
  const code = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const start = code.indexOf('function makeGgufDrafter(');
  assert.ok(start >= 0, 'makeGgufDrafter not found');
  const body = code.slice(start, code.indexOf('\nexport function makeDrafter(', start));
  assert.match(body, /isolateLocalSession\(\{/);
  assert.doesNotMatch(body, /session\.resetChatHistory\(/, 'direct history-only reset is back in the drafter');
});
