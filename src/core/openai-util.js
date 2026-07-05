/**
 * openai-util.js — provider-shape helpers for the OpenAI / ChatGPT engine
 * (#243 Part B), shared by every OpenAI call site (server GUI dispatch, the CLI
 * analyze/claim family, and the AI-overview engine) so the semantics live in
 * ONE place instead of being copy-pasted per file.
 *
 * These encode two OpenAI-vs-Anthropic mismatches that bite Claude-tuned code:
 *
 *  - `max_completion_tokens` on gpt-5 / o-series ALSO covers hidden reasoning
 *    tokens, so a small Claude-style cap can be consumed entirely by reasoning
 *    and return empty content. `openaiCompletionBudget` floors the cap for
 *    those families.
 *  - gpt-5 / o-series reject an explicit `temperature`; only the gpt-4 family
 *    accepts one. `openaiSupportsTemperature` gates whether to send it.
 */

/** gpt-5 / o-series reject an explicit temperature; the gpt-4 family accepts
 *  one (0 for determinism parity with Claude). */
export function openaiSupportsTemperature(model) {
  return /gpt-4/i.test(String(model || ''));
}

/** True for the reasoning families (gpt-5*, o1/o3/o4…) that spend hidden
 *  reasoning tokens against max_completion_tokens. */
export function isOpenAIReasoningModel(model) {
  return /^(gpt-5|o\d)/i.test(String(model || ''));
}

/** Minimum completion budget for a reasoning model, so a Claude-tuned request
 *  (e.g. 500–800 tokens) isn't entirely consumed by reasoning, leaving no room
 *  for the actual answer. */
export const OPENAI_REASONING_FLOOR = 4096;

/** Resolve the max_completion_tokens to send: models that spend hidden
 *  thinking/reasoning tokens against the cap are floored to
 *  OPENAI_REASONING_FLOOR; others use the requested cap verbatim.
 *  #246: Gemini 2.5+ Flash/Pro think by default over the compat endpoint —
 *  same starvation as the OpenAI reasoning family (a small analyze cap left
 *  only ~29 answer tokens, cut off mid-sentence), so floor them too. Harmless
 *  for non-thinking gemini variants (just permits more output). */
export function openaiCompletionBudget(model, requested) {
  const req = requested || 0;
  const needsFloor = isOpenAIReasoningModel(model) || /^gemini-/i.test(String(model || ''));
  return needsFloor ? Math.max(req, OPENAI_REASONING_FLOOR) : req;
}

/** Normalize an OpenAI chat-completions `usage` object to the Anthropic-shaped
 *  { input_tokens, output_tokens } the shared pricing helper expects. Safe when
 *  `usage` is null/undefined (some OpenAI-compatible endpoints return null). */
export function openaiUsage(usage) {
  const u = usage || {};
  return { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 };
}

/** Extract assistant text from an OpenAI chat-completions response body, or ''
 *  if none. */
export function openaiText(body) {
  const choice = (body && body.choices && body.choices[0]) || {};
  return String((choice.message && choice.message.content) || '').trim();
}

/** finish_reason for the first choice, or '' — 'length' means the completion
 *  hit max_completion_tokens (on a reasoning model, usually reasoning-exhausted). */
export function openaiFinishReason(body) {
  const choice = (body && body.choices && body.choices[0]) || {};
  return String(choice.finish_reason || '');
}
