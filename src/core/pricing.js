// pricing.js — per-1M rate table for Claude/OpenAI/Gemini plus the USD cost estimator every AI surface shares
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * pricing.js — cloud model pricing (Anthropic/OpenAI/Gemini) + cost
 * estimation (#llm-cost-display).
 *
 * Shared by the AI-overview engine and ServerLLM (Analyze) so the rate table
 * lives in ONE place. The prior Analyze calc hardcoded Sonnet's $3/$15 per 1M
 * regardless of model, under-reporting by ~40% on Opus.
 *
 * Rates are USD per 1M tokens, [input, output], from each provider's
 * published pricing. Matched by substring of the model id so dated/aliased
 * variants work.
 */
const RATES = [
  // #254: Anthropic tier rates are stable across recent generations, so match
  // the tier plus ANY generation digit (sonnet-4, sonnet-5, …) — sonnet-5 used
  // to fall through to the conservative default and over-report. Sonnet 5
  // verified $3/$15 per 1M (July 2026; launch-intro discount ignored). Refresh
  // if a future generation reprices its tier.
  [/opus-\d/i,   [5, 25]],
  [/sonnet-\d/i, [3, 15]],
  [/haiku-\d/i,  [1, 5]],
  [/fable-5/i,  [10, 50]],
  [/mythos-5/i, [10, 50]],
  // OpenAI (#243 Part B) — published per-1M rates; refresh when defaults move.
  // NOTE: order matters — RATES is first-match-wins, so the cheaper -mini /
  // -nano variants MUST precede their flagship family patterns (e.g. gpt-4o-mini
  // before gpt-4o), or a substring family match bills them at flagship rates
  // (~16x over on gpt-4o-mini). #243B follow-up.
  [/gpt-4o-mini/i, [0.15, 0.6]],
  [/gpt-4\.1-mini/i, [0.4, 1.6]],
  [/gpt-4\.1-nano/i, [0.1, 0.4]],
  // #254: generation-agnostic (gpt-5-nano, gpt-5.1-nano, gpt-5.2-nano, …) —
  // the gpt-5.1 generation used to fall through to the flagship /gpt-5/ rate
  // and bill ~5x too high, and gpt-5.1 is the codebase's default OpenAI model.
  [/gpt-5(\.\d+)?-nano/i, [0.05, 0.4]],
  [/gpt-5(\.\d+)?-mini/i, [0.25, 2]],
  [/o[34]-mini/i, [1.1, 4.4]],
  [/gpt-5/i,    [1.25, 10]],
  [/gpt-4o/i,   [2.5, 10]],
  [/gpt-4\.1/i, [2, 8]],
  [/^o[34]/i,   [2, 8]],
  // #246 Gemini (published per-1M rates, July 2026). Flash-lite before flash
  // (first-match-wins), and both before the bare generation fallback. Refresh
  // when defaults move; a future 4.x generation falls through to the last
  // gemini row rather than the Opus-tier default.
  [/gemini-\d+(\.\d+)?-flash-lite/i, [0.10, 0.40]],
  [/gemini-2(\.\d+)?-flash/i,        [0.30, 2.50]],   // 2.x Flash
  [/gemini-\d+(\.\d+)?-flash/i,      [1.50, 9.00]],   // 3.x+ Flash (default gemini-2.5-flash matched above)
  [/gemini-\d+(\.\d+)?-pro/i,        [1.25, 10.00]],  // Pro tier
];
const DEFAULT_RATE = [5, 25]; // conservative (Opus-tier) for an unrecognized id

export function rateFor(model) {
  const id = String(model || '');
  for (const [re, rate] of RATES) if (re.test(id)) return rate;
  return DEFAULT_RATE;
}

/**
 * Estimate USD cost from an Anthropic `usage` object. Cache tokens are priced
 * relative to the input rate: cache_read ≈ 0.1×, cache_creation ≈ 1.25×.
 * @returns {{usd:number, inTok:number, outTok:number}} inTok includes cache tokens
 */
export function estimateCost(model, usage = {}) {
  const [inRate, outRate] = rateFor(model);
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const usd = (inTok * inRate
    + cacheRead * inRate * 0.1
    + cacheWrite * inRate * 1.25
    + outTok * outRate) / 1_000_000;
  return { usd, inTok: inTok + cacheRead + cacheWrite, outTok };
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Compact one-liner: "est. $0.0042, 3.1k in / 1.2k out". */
export function formatCost(model, usage = {}) {
  const { usd, inTok, outTok } = estimateCost(model, usage);
  return `est. $${usd.toFixed(4)}, ${k(inTok)} in / ${k(outTok)} out`;
}
