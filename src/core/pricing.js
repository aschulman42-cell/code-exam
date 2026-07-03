/**
 * pricing.js — Anthropic model pricing + cost estimation (#llm-cost-display).
 *
 * Shared by the AI-overview engine and ServerLLM (Analyze) so the rate table
 * lives in ONE place. The prior Analyze calc hardcoded Sonnet's $3/$15 per 1M
 * regardless of model, under-reporting by ~40% on Opus.
 *
 * Rates are USD per 1M tokens, [input, output], from the published Anthropic
 * pricing. Matched by substring of the model id so dated/aliased variants work.
 */
const RATES = [
  [/opus-4/i,   [5, 25]],
  [/sonnet-4/i, [3, 15]],
  [/haiku-4/i,  [1, 5]],
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
  [/gpt-5-nano/i, [0.05, 0.4]],
  [/gpt-5-mini/i, [0.25, 2]],
  [/o[34]-mini/i, [1.1, 4.4]],
  [/gpt-5/i,    [1.25, 10]],
  [/gpt-4o/i,   [2.5, 10]],
  [/gpt-4\.1/i, [2, 8]],
  [/^o[34]/i,   [2, 8]],
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
