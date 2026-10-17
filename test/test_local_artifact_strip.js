// test_local_artifact_strip.js — one cleanup for every local-model text path
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Covers stripLocalArtifacts / stripLeadingStructuralNoise: the shared helper
// that replaced three divergent copies (ai-overview-local, GUI Chat, GUI AI
// Overview — only two of which had ever received the Gemma 4 marker fix).
//
// The samples marked REAL are verbatim model output captured on .GhostArch
// with gemma-4-12b-it-Q4_K_M, not invented for the test.
import { test } from 'node:test';
import assert from 'node:assert';
import { stripLocalArtifacts, stripLeadingStructuralNoise } from '../src/core/llm-runner.js';

const Q = String.fromCharCode(34);
const DELIM = `<|${Q}|>`;          // token 52, the DSL string delimiter

test('REAL: a <|"|> run ahead of the prose (GUI Overview by AI)', () => {
  const out = stripLocalArtifacts(DELIM.repeat(7) + 'Ghost Architect is a multi-pass scanning engine.');
  assert.equal(out, 'Ghost Architect is a multi-pass scanning engine.');
});

test('REAL: fabricated closing tags that are NOT in the vocabulary (GUI Chat)', () => {
  // </div_thought> and friends are spelled out of ordinary word tokens — a
  // scan of all 262,144 entries finds no such token — so they can only be
  // caught positionally, never by a token list.
  const raw = '</div></div_thought></div_thought></div_response></divthought>'
    + 'Based on the codebase, license keys are validated by two modules.';
  assert.equal(stripLocalArtifacts(raw),
    'Based on the codebase, license keys are validated by two modules.');
});

test('REAL: a bare brace run (GUI Chat)', () => {
  const out = stripLocalArtifacts('}'.repeat(24) + 'The system handles prompt budget dynamically.');
  assert.equal(out, 'The system handles prompt budget dynamically.');
});

test('REAL: mixed markers, fabricated tags and a stray > in one prefix', () => {
  // Captured from run B.1 of the 2026-10-13 matrix. The stray '>' after
  // <channel|> is what defeated the first version of this cleaner: it matched
  // no rule, the loop stopped, and the twelve markers behind it survived.
  const raw = '<channel|>>' + DELIM.repeat(12) + 'The system estimates inference capacity.';
  assert.equal(stripLocalArtifacts(raw), 'The system estimates inference capacity.');
});

test('prose containing the same characters mid-sentence is untouched', () => {
  // The reason the fabricated-structure rules are anchored to the START: }}
  // and </div> are ordinary content, and an examiner asking about them must
  // get them back verbatim.
  const prose = 'The handler returns {} when no match is found, and the caller closes with }}.';
  assert.equal(stripLocalArtifacts(prose), prose);
  const tags = 'Use </div> to close the block; nest </div_thought> inside it.';
  assert.equal(stripLocalArtifacts(tags), tags);
});

test('a markdown blockquote survives — "> " is not a stray closer', () => {
  const quoted = '> Quoted guidance from the README, kept verbatim.';
  assert.equal(stripLocalArtifacts(quoted), quoted);
  assert.equal(stripLeadingStructuralNoise(quoted), quoted);
});

test('chain-of-thought still strips, closed and truncated-open', () => {
  assert.equal(stripLocalArtifacts('<think>weighing it</think>The answer.'), 'The answer.');
  // maxTokens can cut the block before its closing tag; without this the raw
  // <think> body would BE the answer.
  assert.equal(stripLocalArtifacts('<think>cut off here'), '');
});

test('complete DSL blocks are removed wherever they appear, not just in front', () => {
  // Tier 1 is deliberately global: these are real tokens from the model's
  // vocabulary and are never legitimate prose.
  const raw = 'Before. <|tool_call>search({})<tool_call|> After.';
  assert.equal(stripLocalArtifacts(raw), 'Before.  After.');
});

test('empty and nullish input do not throw', () => {
  for (const v of [null, undefined, '', '   \n\n ']) assert.equal(stripLocalArtifacts(v), '');
});

test('a junk-only response strips to empty — which is what triggers the nudge', () => {
  // Measured 4/4 with reasoning left on: the model emits closers and never
  // reaches an answer. The overview path must recover from this rather than
  // display it, which is why the strip landed together with a nudge.
  assert.equal(stripLocalArtifacts('\n' + DELIM.repeat(2) + '\n' + DELIM + '\n\n'), '');
});
