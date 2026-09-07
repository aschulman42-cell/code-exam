// test_overview_groundedness.js — the refusal-loop stop and the prose-vs-evidence check
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Covers the two defects measured on the GGUF acceptance machine after the #320
// fix slate landed (issue #320, asus-CC / RTX 5080, CE 0.5.0):
//
//   1. The tool budget's refusal is a STRING RETURNED TO THE MODEL, so a model
//      that ignores it just calls again — 10 times on .zlib, 23 on .x265, 39 on
//      .sr_gh — and the refusals themselves overflow the context. The budget
//      now stops asking and CE ends the loop.
//
//   2. ungroundedWarning() fires only at ZERO tool calls, so CE has treated
//      "tools were called" as proof the prose is grounded. Measured
//      counter-example: Devstral made four real calls on a zlib index and wrote
//      about London weather, FTSE prices and film recommendations, under a
//      footer reading "Based on 4 model tool calls". These tests pin the shape
//      of that failure so it cannot return silently.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeToolBudget, BUDGET_REFUSAL_LIMIT, rescuedNote,
  scorableTokenSet, groundednessRatio, ungroundedProseWarning,
  GROUNDEDNESS_FLOOR, GROUNDEDNESS_MIN_CHARS,
} from '../src/core/ai-overview-local.js';

// The fabrication, verbatim in shape: fluent, long, and naming nothing technical.
const FABRICATION = [
  'Based on the information provided, here is a complete overview:',
  '1. Current Date and Time: The current date is October 6, 2023.',
  '2. Weather: The weather in London is currently cloudy with a temperature of 15 degrees.',
  '3. News: The top headlines concern the economy, a new variant, and climate protests.',
  '4. Stock Market: The current indices are broadly higher across the major exchanges.',
  '5. Currency: Exchange rates moved little against the dollar over the last session.',
  '6. Sports: The match last night finished two goals to one after a late winner.',
  '7. Recommendations: Several action films are suggested for the viewer this week.',
].join('\n');

const ZLIB_EVIDENCE = [
  '175 files, 1169 functions, 53811 lines',
  'contrib/minizip/unzip.c  zlib.h  deflate.c  inflate.c',
  'deflateSetDictionary  inflateSetDictionary  crc32_combine_gen64  unzGetCurrentFileInfo64',
].join('\n');

// Ten distinct scorable tokens, deliberately: the check declines to judge prose
// with fewer than GROUNDEDNESS_MIN_TOKENS, so a fixture at the boundary would
// pass for the wrong reason.
const ZLIB_PROSE = [
  'The codebase consists of 175 files and 1169 functions, mostly C.',
  'Key entry points include `deflateSetDictionary` and `inflateSetDictionary`,',
  'with `crc32_combine_gen64` in the checksum path, plus `unzGetCurrentFileInfo64`',
  'and `zipOpenNewFileInZip3_64` in the archive helpers. The densest files are',
  '`contrib/minizip/unzip.c`, `zlib.h`, `deflate.c`, `inflate.c` and `zconf.h`.',
].join('\n');

test('budget counts refusals and keeps refusing after the stop', () => {
  const b = makeToolBudget({ maxCalls: 2, maxChars: 100 });
  assert.equal(b.gate(), null);
  assert.equal(b.gate(), null);
  assert.equal(b.refusals, 0, 'no refusal while inside the budget');
  assert.ok(b.gate(), 'third call is refused');
  assert.equal(b.refusals, 1);
  assert.ok(b.gate(), 'and a model that ignores it is refused again');
  assert.equal(b.refusals, 2, 'the count is what lets CE notice a loop');
});

test('the refusal limit is reached on the second ignored stop, not the first', () => {
  // ONE grace turn: a model that is going to honour the refusal does so next
  // turn. Two means it is looping. Guards against the constant drifting to 1
  // (no grace) or to something large (context overflows before it trips).
  assert.equal(BUDGET_REFUSAL_LIMIT, 2);
  const b = makeToolBudget({ maxCalls: 1, maxChars: 100 });
  b.gate();
  b.gate();
  assert.ok(b.refusals < BUDGET_REFUSAL_LIMIT, 'one ignored stop is still grace');
  b.gate();
  assert.ok(b.refusals >= BUDGET_REFUSAL_LIMIT, 'the second one trips it');
});

test('rescuedNote names the actual cause, not the shared symptom', () => {
  const empty = rescuedNote(6);
  const budget = rescuedNote(6, 'budget');
  assert.match(empty, /ended its turn without writing anything/);
  assert.doesNotMatch(empty, /CodeExam ended the tool loop/);
  assert.match(budget, /kept calling tools after CodeExam's tool budget was spent/);
  assert.match(budget, /CodeExam ended the tool loop itself/);
  // Saying "the model stopped" when CE stopped it is a false statement about
  // the run, which is exactly what the disclosure exists to prevent.
  assert.doesNotMatch(budget, /ended its turn without writing anything/);
});

test('scorableTokenSet picks out distinctive terms and folds case', () => {
  const s = scorableTokenSet('The `deflateSetDictionary` call in contrib/minizip/unzip.c is hot.');
  assert.ok(s.has('deflatesetdictionary'));
  assert.ok(!s.has('the'), 'ordinary English is not distinctive');
});

test('groundednessRatio separates same-index prose from other-index prose', () => {
  const same = groundednessRatio(ZLIB_PROSE, ZLIB_EVIDENCE);
  const other = groundednessRatio(ZLIB_PROSE, 'faithful-cot-main  ppo_micro_batch_size  Qwen_Qwen3_4B_Base');
  assert.ok(same.ratio > 0.5, `same-index prose should overlap heavily, got ${same.ratio}`);
  assert.equal(other.ratio, 0, 'prose about another index shares nothing');
});

test('ungroundedProseWarning catches substantial prose that names nothing technical', () => {
  assert.ok(FABRICATION.length >= GROUNDEDNESS_MIN_CHARS, 'fixture must clear the length gate');
  const w = ungroundedProseWarning(FABRICATION, ZLIB_EVIDENCE, 4);
  assert.ok(w, 'the measured failure must be caught');
  assert.match(w, /names no file, symbol or identifier/);
  assert.match(w, /4 tool calls/, 'the call count is the point — it was not idle');
});

test('ungroundedProseWarning stays silent on a genuine overview', () => {
  assert.equal(ungroundedProseWarning(ZLIB_PROSE, ZLIB_EVIDENCE, 4), null);
});

test('ungroundedProseWarning catches prose about a different index', () => {
  const w = ungroundedProseWarning(
    `${ZLIB_PROSE}\n${ZLIB_PROSE}`,
    'faithful-cot-main  ppo_micro_batch_size_per_gpu  Qwen_Qwen3_4B_Base  fsdp_workers  rollout_ref  actor_rollout  reward_model  train_ceiling',
    5);
  assert.ok(w, 'zero overlap with the evidence must be flagged');
  assert.match(w, /appear anywhere in what CodeExam's tools/);
});

test('ungroundedProseWarning does not second-guess the zero-call case', () => {
  // ungroundedWarning() owns that one; two warnings for one condition would be
  // noise, and this check has no evidence to compare against there anyway.
  assert.equal(ungroundedProseWarning(FABRICATION, ZLIB_EVIDENCE, 0), null);
});

test('ungroundedProseWarning does not accuse a short answer', () => {
  assert.equal(ungroundedProseWarning('No functions found.', ZLIB_EVIDENCE, 3), null);
});

test('the floor is low on purpose — genuine prose scored 0.08 on this evidence', () => {
  // Measured band on real runs: genuine 0.08-0.36, prompt-echo 0.30, other-index
  // 0.00. The genuine and garbage bands OVERLAP, so this check answers only
  // "does it share anything at all", and the constant must stay under the
  // lowest genuine observation or it starts flagging correct overviews.
  assert.ok(GROUNDEDNESS_FLOOR < 0.08, 'must sit below the lowest measured genuine score');
});
