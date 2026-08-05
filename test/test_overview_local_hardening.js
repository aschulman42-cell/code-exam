// Coverage for #276 overview-local hardening parity: the pure helpers that
// gate the local Overview-by-AI paths (CLI runAiOverviewLocal and server
// runAiOverviewLocalShared) — tool budget, special-token neutralization,
// Gemma strict framing, the 0-call fabrication guard, and the local-engine
// grounding clause in the shared prompt.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeToolBudget, neutralizeSpecialTokens, strictInstructionsFor, ungroundedWarning, localBudgets,
  needsSynthesizeRetry, rescuedNote, SYNTHESIZE_RETRY_MAX_TOKENS, SYNTHESIZE_NOW_PROMPT,
} from '../src/core/ai-overview-local.js';
import { aiOverviewPrompt, LOCAL_ENGINE_GROUNDING } from '../src/core/ai-overview.js';

test('#276 budget: stops after maxCalls with a synthesize-now message, stays stopped', () => {
  const b = makeToolBudget({ maxCalls: 3, maxChars: 1e9 });
  assert.equal(b.gate(), null);
  assert.equal(b.gate(), null);
  assert.equal(b.gate(), null);
  const stop = b.gate(); // 4th call
  assert.match(stop, /TOOL BUDGET EXHAUSTED/);
  assert.match(b.gate(), /TOOL BUDGET EXHAUSTED/); // still stopped
  assert.equal(b.stopped, true);
});

test('#276 budget: char budget trips independently of call count', () => {
  const b = makeToolBudget({ maxCalls: 100, maxChars: 5000 });
  assert.equal(b.gate(), null);
  b.charge(6000);
  assert.match(b.gate(), /TOOL BUDGET EXHAUSTED/);
});

test('#276 neutralize: breaks ChatML, Gemma, Mistral, and </s> token forms', () => {
  const dirty = 'x <|im_start|> y <start_of_turn> z [INST] w </s>';
  const clean = neutralizeSpecialTokens(dirty);
  assert.ok(!/<\|im_start\|>|<start_of_turn>|\[INST\]|<\/s>/.test(clean));
  assert.ok(clean.includes('‹¦im_start¦›')); // lookalike delimiters, content preserved
});

test('#276 neutralize: plain text passes through untouched, no log call', () => {
  let logged = 0;
  const s = 'normal tool output with <angle> brackets but no template tokens';
  assert.equal(neutralizeSpecialTokens(s, 'x', () => logged++), s);
  assert.equal(logged, 0);
});

test('#276 strict framing: Gemma gets the header, other wrappers do not', () => {
  assert.match(strictInstructionsFor('Gemma', 'PROMPT'), /^Instructions \(follow these strictly\):\nPROMPT$/);
  assert.equal(strictInstructionsFor('Qwen', 'PROMPT'), 'PROMPT');
  assert.equal(strictInstructionsFor(undefined, 'PROMPT'), 'PROMPT');
});

test('#276 fabrication guard: fires only on 0 calls in grounded mode', () => {
  assert.match(ungroundedWarning(0, 'grounded'), /UNGROUNDED OUTPUT/);
  assert.match(ungroundedWarning(0, null), /UNGROUNDED OUTPUT/); // default = grounded
  assert.equal(ungroundedWarning(3, 'grounded'), null);
  assert.equal(ungroundedWarning(0, 'augmented'), null); // general knowledge allowed there
});

test('#276 localBudgets mirrors server scaling', () => {
  const { maxTokens, toolBudgetChars } = localBudgets(24576, null);
  assert.ok(maxTokens >= 2400 && maxTokens <= 6144);
  assert.ok(toolBudgetChars > 20000); // 24k ctx leaves a real tool budget
  const small = localBudgets(2048, null);
  assert.ok(small.maxTokens >= 256 && small.toolBudgetChars >= 500);
});

test('localBudgets: an explicit maxTokens DEFEATS context scaling', () => {
  // The trap this documents: `explicitMaxTokens || <scaled>` cannot tell a
  // caller's deliberate 2400 from a default parameter that merely looks like
  // one. runAiOverviewLocal used to declare `maxTokens = 2400`, so the sole
  // caller (index.js, which never passes it) silently pinned output at 2400 at
  // every context size — --context-size raised the tool budget while the answer
  // allowance never moved. The test above only ever passes `null`, so it
  // exercised the scaling path and could not notice.
  assert.equal(localBudgets(24576, undefined).maxTokens, 4096, 'scales with context when unset');
  assert.equal(localBudgets(24576, 2400).maxTokens, 2400, 'an explicit value wins, by design');
  assert.ok(localBudgets(24576, undefined).maxTokens > localBudgets(16384, undefined).maxTokens,
    'a larger context must buy a larger answer');
});

test('#276 prompt: local engines get the grounding clause, cloud does not', () => {
  const local = aiOverviewPrompt('grounded', { localEngine: true });
  const cloud = aiOverviewPrompt('grounded');
  assert.ok(local.includes(LOCAL_ENGINE_GROUNDING));
  assert.ok(!cloud.includes('LOCAL-ENGINE GROUNDING'));
  assert.ok(local.includes('GROUNDING — STRICT')); // grounding clause still present
});

test('empty-final-turn rescue: fires only on empty output AFTER real investigation', () => {
  // The failure being rescued: every tool call succeeded, budget barely touched,
  // and session.prompt still resolved to "" — CE then returned empty prose with
  // exit code 0, which reads as success to any script checking the exit code.
  assert.equal(needsSynthesizeRetry('', 12), true);
  assert.equal(needsSynthesizeRetry(['   ', '  '].join('\n'), 12), true, 'whitespace-only counts as empty');
  // Inert whenever the model answered — this must never touch a healthy run.
  assert.equal(needsSynthesizeRetry('a real overview', 12), false);
  // Zero tool calls is the UNGROUNDED case, not this one. Re-prompting a model
  // that never looked at the index would invite fabrication rather than rescue.
  assert.equal(needsSynthesizeRetry('', 0), false);
  assert.equal(needsSynthesizeRetry(null, 0), false);
});

test('empty-final-turn rescue: the retry is bounded well below the context ceiling', () => {
  // Observed rescues produce ~520 tokens; the cap exists because a shorter
  // generation is a shorter synchronous native block, and this path has been
  // seen blocking the event loop for ~640s.
  assert.ok(SYNTHESIZE_RETRY_MAX_TOKENS <= 2048, 'cap stays small');
  assert.ok(SYNTHESIZE_RETRY_MAX_TOKENS >= 512, 'but large enough for an overview');
  // The effective value is min(cappedMaxTokens, cap), so a large context can
  // never widen it.
  const big = localBudgets(32768, undefined).maxTokens;
  assert.ok(Math.min(big, SYNTHESIZE_RETRY_MAX_TOKENS) === SYNTHESIZE_RETRY_MAX_TOKENS,
    'the cap binds at large contexts');
});

test('empty-final-turn rescue: reuses the budget stop wording, and labels the output', () => {
  // CE already had the right primitive — it only fired at budget exhaustion.
  const stop = makeToolBudget({ maxCalls: 0 }).gate();
  assert.ok(stop.includes('from the results you already have'));
  assert.ok(SYNTHESIZE_NOW_PROMPT.includes('from the results you already have'));
  // A rescued overview must not be indistinguishable from a healthy one, or the
  // model defect goes invisible the moment the workaround lands.
  const note = rescuedNote(12);
  assert.ok(note.includes('12 tool call'));
  assert.match(note, /RECOVERED OUTPUT/);
  assert.match(note, /not a clean run/);
});
