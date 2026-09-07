// providers.js — cloud-LLM registry (Claude/OpenAI/Gemini) with a resolver that defaults deliberately and fails loud
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * providers.js — #246 cloud-LLM provider registry + resolver.
 *
 * Kills the binary "OpenAI if useOpenAI, else Claude" dispatch that repeated
 * across analyze / claim / server: every cloud provider is now ONE registry
 * entry, and `resolveProvider()` is the single chokepoint that
 *
 *   (a) defaults to Claude DELIBERATELY when nothing is requested — a chosen
 *       default, documented here, not an else-branch fall-through;
 *   (b) resolves known ids and aliases; and
 *   (c) FAILS LOUD on an unrecognized value (returns an error string) rather
 *       than silently coercing it to Claude.
 *
 * `wire` selects the request/response shape:
 *   'anthropic'     — Anthropic Messages API (Claude).
 *   'openai-compat' — OpenAI Chat Completions shape. OpenAI itself, Gemini via
 *                     its OpenAI-compatible endpoint, and localhost gateways
 *                     (LM Studio, etc.) all share it, parameterized by
 *                     baseUrl + key + model — so a new one is just an entry.
 *
 * `local` (a GGUF via node-llama-cpp) is deliberately NOT a registry entry:
 * it's not a cloud provider and its dispatch/air-gap handling lives elsewhere.
 * The registry is the CLOUD dispatch surface only.
 */

export const PROVIDERS = {
  claude: {
    id: 'claude', label: 'Claude API', wire: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY', keyFlag: '--api-key',
    keyFiles: ['claude.txt', 'claude_key.txt'],
    defaultModel: 'claude-sonnet-4-6',
    egressHosts: ['api.anthropic.com'],
  },
  openai: {
    id: 'openai', label: 'ChatGPT API', wire: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY', keyFlag: '--openai-key',
    keyFiles: ['openai.txt', 'openai_key.txt'],
    defaultModel: 'gpt-5.1',
    egressHosts: ['api.openai.com'],
  },
  gemini: {
    id: 'gemini', label: 'Gemini API', wire: 'openai-compat',
    // Google's OpenAI-compatible endpoint. `/chat/completions` is appended by
    // the openai-compat call path, same as OpenAI's baseUrl.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY', keyFlag: '--gemini-key',
    keyFiles: ['gemini.txt', 'gemini_key.txt'],
    defaultModel: 'gemini-2.5-flash',
    egressHosts: ['generativelanguage.googleapis.com'],
  },
};

// The DELIBERATE default when no provider is requested. Named here so the
// choice is explicit and greppable — not an if/else that happens to end at
// Claude. Changing the product default is a one-line edit with a clear diff.
export const DEFAULT_PROVIDER = 'claude';

const ALIASES = {
  chatgpt: 'openai', gpt: 'openai',
  anthropic: 'claude',
  google: 'gemini',
};

/** Canonical provider id for an id-or-alias, or null if unrecognized. */
export function canonicalProviderId(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  if (PROVIDERS[v]) return v;
  if (ALIASES[v]) return ALIASES[v];
  return null;
}

/**
 * Resolve a requested cloud provider to its registry entry. Returns
 * `{ provider, error }` with EXACTLY one populated; never throws, never
 * coerces an unknown value to a provider.
 *
 * @param {string|null} value      --llm value / engine name (id or alias)
 * @param {object}  [opts]
 * @param {boolean} [opts.allowDefault=true]  when `value` is empty, return the
 *        DELIBERATE default (Claude). Pass false to require an explicit choice
 *        (returns `{ provider: null, error: null }` for empty input).
 */
export function resolveProvider(value, { allowDefault = true } = {}) {
  if (!value) {
    return { provider: allowDefault ? PROVIDERS[DEFAULT_PROVIDER] : null, error: null };
  }
  const id = canonicalProviderId(value);
  if (id) return { provider: PROVIDERS[id], error: null };
  const known = Object.keys(PROVIDERS).join(', ');
  return {
    provider: null,
    error: `unknown cloud provider '${value}'. Known: ${known} (aliases: chatgpt/gpt → openai, google → gemini). ` +
           `For a local GGUF model use --model <file.gguf>, not --llm.`,
  };
}

/** Deduped egress hosts across all cloud providers — for the air-gap surfaces. */
export function allProviderEgressHosts() {
  return [...new Set(Object.values(PROVIDERS).flatMap((p) => p.egressHosts || []))];
}
