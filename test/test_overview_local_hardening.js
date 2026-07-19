// Coverage for #276 overview-local hardening parity: the pure helpers that
// gate the local Overview-by-AI paths (CLI runAiOverviewLocal and server
// runAiOverviewLocalShared) — tool budget, special-token neutralization,
// Gemma strict framing, the 0-call fabrication guard, and the local-engine
// grounding clause in the shared prompt.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeToolBudget, neutralizeSpecialTokens, strictInstructionsFor, ungroundedWarning, localBudgets,
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

test('#276 prompt: local engines get the grounding clause, cloud does not', () => {
  const local = aiOverviewPrompt('grounded', { localEngine: true });
  const cloud = aiOverviewPrompt('grounded');
  assert.ok(local.includes(LOCAL_ENGINE_GROUNDING));
  assert.ok(!cloud.includes('LOCAL-ENGINE GROUNDING'));
  assert.ok(local.includes('GROUNDING — STRICT')); // grounding clause still present
});
