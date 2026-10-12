// test_local_chat_tools.js — the local Chat tool menu: curated default, CE_LOCAL_CHAT_TOOLS all / +names / names
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// claim-mcp-primitives: the claim tools stay off the curated local core (the
// measured menu); CE_LOCAL_CHAT_TOOLS lets one launch extend or replace it for
// a test, and the server must say so. The resolver is pure, so this exercises
// it against the real TOOLS table without starting a server.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/mcp-server.js';
import { resolveLocalChatTools, CURATED_LOCAL_CHAT_TOOLS } from '../src/core/local-chat-tools.js';

const REG = TOOLS.map((t) => t.name);

describe('resolveLocalChatTools', () => {
  it('unset keeps the curated core, silently', () => {
    for (const spec of [undefined, '', '   ']) {
      const r = resolveLocalChatTools(spec, REG);
      assert.deepEqual(r.names, CURATED_LOCAL_CHAT_TOOLS);
      assert.equal(r.note, null);
    }
  });

  it('every curated name is a registered tool (the core cannot silently shrink)', () => {
    for (const n of CURATED_LOCAL_CHAT_TOOLS) assert.ok(REG.includes(n), `${n} not in TOOLS`);
  });

  it('"all" exposes every registered tool and says the menu is unmeasured', () => {
    const r = resolveLocalChatTools('all', REG);
    assert.equal(r.names.length, REG.length);
    assert.match(r.note, /all \d+ tools via CE_LOCAL_CHAT_TOOLS=all/);
    assert.match(r.note, /measured/);
  });

  it('"+names" extends the core, core first, and notes the size', () => {
    const r = resolveLocalChatTools('+claim_elements,claim_candidates,capabilities', REG);
    assert.deepEqual(r.names.slice(0, CURATED_LOCAL_CHAT_TOOLS.length), CURATED_LOCAL_CHAT_TOOLS);
    assert.deepEqual(r.names.slice(CURATED_LOCAL_CHAT_TOOLS.length), ['claim_elements', 'claim_candidates', 'capabilities']);
    assert.match(r.note, new RegExp(`${CURATED_LOCAL_CHAT_TOOLS.length + 3} tools via CE_LOCAL_CHAT_TOOLS`));
    assert.match(r.note, /unmeasured/);
  });

  it('a plain list replaces the core exactly, deduplicated', () => {
    const r = resolveLocalChatTools('search, extract,search', REG);
    assert.deepEqual(r.names, ['search', 'extract']);
    assert.match(r.note, /2 tools via CE_LOCAL_CHAT_TOOLS/);
  });

  it('unknown names are ignored and named in the note; a core-only result stays the core', () => {
    const r = resolveLocalChatTools('+bogus_tool', REG);
    assert.deepEqual(r.names, CURATED_LOCAL_CHAT_TOOLS);
    assert.match(r.note, /unknown tool name\(s\) ignored: bogus_tool/);
    const r2 = resolveLocalChatTools('bogus_tool', REG);
    assert.deepEqual(r2.names, CURATED_LOCAL_CHAT_TOOLS, 'a value naming nothing real falls back to the core');
    assert.match(r2.note, /named no registered tool/);
  });

  it('the claim tools are registered but not in the core (the decision this knob exists for)', () => {
    for (const n of ['claim_elements', 'claim_candidates', 'capabilities']) {
      assert.ok(REG.includes(n), `${n} registered`);
      assert.ok(!CURATED_LOCAL_CHAT_TOOLS.includes(n), `${n} not in the curated core`);
    }
  });
});
