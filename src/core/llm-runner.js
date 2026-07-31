// llm-runner.js — shared LLM model-resolution + call plumbing.
//
// Lifted verbatim from pseudo-claims.js (#284 ranker Phase 0) so both the
// pseudo-claim DRAFTER and the mechanism-RANKER consume one implementation of
// model resolution, the cloud/GGUF call, and the fail-closed air-gap gate.
// Behavior-preserving move — the existing pseudo-claims tests are the guard.
//
// Public surface: resolveModel(args) -> descriptor|null|{kind:'error'};
// makeDrafter(model, temperature) -> (sys, user, maxTokens) => Promise<text>.

import fs from 'node:fs';
import { claudeSupportsTemperature } from '../utils.js';
import { assertLocalOnly, isLocalApiUrl, isAirGapped } from './air-gapped.js';
import { resolveProvider } from './providers.js';
import { openaiCompletionBudget, openaiSupportsTemperature, openaiText } from './openai-util.js';

// Resolve which model to draft with, using CE's shared provider registry so the
// surface matches analyze/claim/overview:
//   1. local GGUF via --model / --claim-model (--cpu forces CPU);
//   2. an explicit cloud provider via --llm claude|openai|gemini (keys from the
//      provider's env var / flag / key file — same as the other commands);
//   3. a raw openai-compatible endpoint via CE_OPENAI_API_URL (a localhost
//      gateway), with no --llm.
// Returns null when nothing is configured (pack-only), or { kind:'error' } for an
// unrecognized --llm value (never silently coerced to a provider).
export function resolveModel(args) {
  const modelPath = args.model || args.claim_model || args.analyze_model || null;
  if (modelPath) return { kind: 'gguf', modelPath, forceCpu: !!args.cpu, contextSize: args.context_size || null };

  if (args.llm) {
    const { provider, error } = resolveProvider(args.llm, { allowDefault: false });
    if (error) return { kind: 'error', error };
    if (provider) return cloudDescriptor(provider, args);
  }

  if (process.env.CE_OPENAI_API_URL) {
    return {
      kind: 'cloud', wire: 'openai-compat', provider: null, label: 'openai-compatible endpoint',
      apiUrl: process.env.CE_OPENAI_API_URL,
      model: process.env.CE_OPENAI_MODEL || 'local-model',
      key: process.env.OPENAI_API_KEY || null,
    };
  }
  return null;
}

// Build a cloud descriptor for a resolved provider — key + model + endpoint
// resolution mirrors analyze.js (provider flag > --api-key > provider key env >
// provider key file; CE_OPENAI_API_URL / CLAIM_SEARCH_API_URL override the base).
function cloudDescriptor(provider, args) {
  const key = resolveCloudKey(provider, args);
  if (provider.wire === 'anthropic') {
    return {
      kind: 'cloud', wire: 'anthropic', provider, key, label: provider.label,
      model: args.claude_model || process.env.CLAIM_SEARCH_MODEL || provider.defaultModel,
      apiUrl: process.env.CLAIM_SEARCH_API_URL || 'https://api.anthropic.com/v1/messages',
    };
  }
  const model = provider.id === 'openai'
    ? (args.openai_model || process.env.CE_OPENAI_MODEL || provider.defaultModel)
    : provider.id === 'gemini'
      ? (args.gemini_model || provider.defaultModel)
      : provider.defaultModel;
  return {
    kind: 'cloud', wire: 'openai-compat', provider, key, label: provider.label, model,
    apiUrl: process.env.CE_OPENAI_API_URL || `${provider.baseUrl}/chat/completions`,
  };
}

// #223/#247 defense-in-depth: resolve NO cloud key under --air-gapped (the
// call-site air-gap gate still guards; this just keeps the key out of memory).
function resolveCloudKey(provider, args) {
  if (isAirGapped()) return null;
  const flagKey = provider.id === 'openai' ? args.openai_key
    : provider.id === 'gemini' ? args.gemini_key : null;
  let key = flagKey || args.api_key || process.env[provider.keyEnv] || null;
  if (!key) {
    for (const f of provider.keyFiles || []) {
      try { const k = fs.readFileSync(f, 'utf8').trim(); if (k) { key = k; break; } } catch { /* ignore */ }
    }
  }
  return key;
}

// Cloud draft via the resolved provider. Folds the instruction into a single
// user message (parity with analyze/claim). The openai-compat wire uses
// openai-util so a reasoning model (gpt-5*, o*, gemini-2.5) isn't starved of
// output budget and doesn't 400 on an unsupported `temperature`.
export async function draftCloud(model, sys, user, maxTokens, temperature) {
  const prompt = `${sys}\n\n${user}`;
  if (model.wire === 'anthropic') {
    const useTemp = claudeSupportsTemperature(model.model);
    const res = await fetch(model.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': model.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model.model, max_tokens: maxTokens,
        ...(useTemp ? { temperature } : {}),
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`${model.label} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }
  const headers = { 'Content-Type': 'application/json' };
  if (model.key) headers.Authorization = `Bearer ${model.key}`;
  const res = await fetch(model.apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model.model,
      max_completion_tokens: openaiCompletionBudget(model.model, maxTokens),
      ...(openaiSupportsTemperature(model.model) ? { temperature } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`${model.label} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return openaiText(await res.json());
}

// gguf-context-ladder: context sizes to attempt, largest first. 8192 was the
// old ceiling, and the biggest evidence packs (24KB ≈ 6-7k tokens + system +
// ~900 output) overflowed it — 10 of ~240 Gemma pod drafts failed with
// node-llama-cpp's "too long prompt for context shift". A 24 GB card fits a
// 12B Q4 at 16k with room; a smaller GPU simply fails the first allocation
// and falls down the ladder exactly as before. An explicit --context-size
// goes to the head of the ladder. Exported for tests.
export function ggufContextLadder(explicit = null) {
  const base = [16384, 8192, 4096, 2048];
  const e = Number(explicit);
  if (Number.isFinite(e) && e > 0) return [e, ...base.filter((s) => s !== e)];
  return base;
}

// In-process GGUF drafter (node-llama-cpp), loaded once and reused across
// groups. Mirrors claim.js's GPU->CPU fallback (#277): a GGUF too big for VRAM
// hard-errors on context allocation, so retry on CPU before giving up; --cpu
// forces CPU up front. node-llama-cpp is imported lazily so the command loads
// without it when only the endpoint path (or dry-run) is used.
function makeGgufDrafter(modelPath, forceCpu, temperature, contextSize = null) {
  let session = null;
  return async (sys, user, maxTokens) => {
    if (!session) {
      let mod;
      try { mod = await import('node-llama-cpp'); }
      catch (e) { throw new Error(`local GGUF needs node-llama-cpp (npm install node-llama-cpp): ${e.message}`); }
      const { getLlama, LlamaChatSession } = mod;
      const tryLoad = async (cpuOnly) => {
        const llama = await getLlama(cpuOnly ? { gpu: false } : undefined);
        const m = await llama.loadModel({ modelPath });
        for (const sz of ggufContextLadder(contextSize)) {
          try {
            const ctx = await m.createContext({ contextSize: sz });
            process.stderr.write(`  context ${sz}${cpuOnly ? ' (CPU)' : ''}\n`);
            return ctx;
          } catch (_) { /* shrink */ }
        }
        try { await m.dispose(); } catch (_) { /* */ }
        return null;
      };
      process.stderr.write(`Loading local model: ${modelPath}…\n`);
      let ctx = forceCpu ? null : await tryLoad(false);
      if (!ctx) {
        process.stderr.write(forceCpu ? '  Using CPU (--cpu)…\n' : '  GPU could not fit model+context; retrying on CPU…\n');
        ctx = await tryLoad(true);
      }
      if (!ctx) throw new Error('could not allocate a context for the local model (tried GPU and CPU) — try --cpu');
      session = new LlamaChatSession({ contextSequence: ctx.getSequence() });
    } else {
      // Isolate each claim: drop the prior claim's accumulated history so it
      // can't bleed into this draft, and so long claim sets don't overflow.
      await session.resetChatHistory();
    }
    return session.prompt(`${sys}\n\n${user}`, { temperature: temperature ?? 0, maxTokens });
  };
}

// Build a draft(sys,user,maxTokens)->text function for the resolved model,
// applying the air-gap gate + cloud-key check ONCE up front (fail-closed: a
// remote endpoint under --air-gapped, or a missing cloud key, throws before any
// group is drafted).
export function makeDrafter(model, temperature) {
  if (model.kind === 'gguf') return makeGgufDrafter(model.modelPath, model.forceCpu, temperature, model.contextSize);
  if (!isLocalApiUrl(model.apiUrl)) assertLocalOnly(`pseudo-claims (cloud ${model.label})`);
  if (!model.key && !isLocalApiUrl(model.apiUrl)) {
    const p = model.provider;
    throw new Error(p
      ? `no ${p.label} key — set ${p.keyEnv}, pass ${p.keyFlag}/--api-key, or create ${p.keyFiles[0]}`
      : `no API key for ${model.apiUrl}`);
  }
  return (sys, user, maxTokens) => draftCloud(model, sys, user, maxTokens, temperature);
}
