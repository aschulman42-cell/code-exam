// llm-runner.js — resolves cloud/GGUF model descriptors and runs the calls, with cost gates, truncation tracking and provenance
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// llm-runner.js — shared LLM model-resolution + call plumbing.
//
// Lifted verbatim from pseudo-claims.js (#284 ranker Phase 0) so both the
// pseudo-claim DRAFTER and the mechanism-RANKER consume one implementation of
// model resolution, the cloud/GGUF call, and the fail-closed air-gap gate.
// Behavior-preserving move — the existing pseudo-claims tests are the guard.
//
// Core surface: resolveModel(args) -> descriptor|null|{kind:'error'} and
// makeDrafter(model, temperature) -> (sys, user, maxTokens) => Promise<text>.
// Around those, the module also exports the claims cost gate
// (claimsCostGate / CLAIMS_COST_GUARD_USD), engine-build provenance
// (getEngineBuild / engineBuildLine), truncation tracking, and the GGUF
// context/session helpers (ggufContextLadder / ggufContextOptions /
// chatSessionOptions) that ai-overview-local.js and the claims commands use.

import fs from 'node:fs';
import { claudeSupportsTemperature } from '../utils.js';
import { assertLocalOnly, isLocalApiUrl, isAirGapped } from './air-gapped.js';
import { resolveProvider } from './providers.js';
import { openaiCompletionBudget, openaiSupportsTemperature, openaiText, openaiUsage, openaiFinishReason } from './openai-util.js';
import { estimateCost } from './pricing.js';

// Resolve which model to draft with, using CE's shared provider registry so the
// surface matches analyze/claim/overview:
//   1. local GGUF via --model / --claim-model (--cpu forces CPU);
//   2. an explicit cloud provider via --llm claude|openai|gemini (keys from the
//      provider's env var / flag / key file — same as the other commands);
//   3. a raw openai-compatible endpoint via CE_OPENAI_API_URL (a localhost
//      gateway), with no --llm.
// Returns null when nothing is configured (pack-only), or { kind:'error' } for an
// unrecognized --llm value (never silently coerced to a provider).
// ONE place a local-model descriptor is built. Two call sites used to hand-roll
// this object (`analyze.js`, `claim.js`) and therefore silently dropped every
// field added after they were written — `flashAttention` was simply the first
// such field, so `--analyze` on a 20B model got the flag dropped with no error
// and no warning (asus-CC, F67).
//
// The general shape, worth keeping in view: a struct a factory builds everywhere
// else, hand-built in two places, loses each new field at exactly those two
// sites. A factory removes the recurrence rather than fixing one instance of it.
//
// NOT `resolveModel(args)` at those sites, which was the other candidate:
// resolveModel also handles `--llm`, cloud descriptors and the air-gap gate, and
// both callers have already decided they are local by the time they call. This
// removes the recurrence without changing resolution semantics.
export function ggufDescriptor({ modelPath, forceCpu = false, contextSize = null,
  flashAttention = false, liveTodayDate = false } = {}) {
  return {
    kind: 'gguf', modelPath,
    forceCpu: !!forceCpu,
    contextSize: contextSize || null,
    flashAttention: !!flashAttention,
    liveTodayDate: !!liveTodayDate,
  };
}

export function resolveModel(args) {
  const modelPath = args.model || args.claim_model || args.analyze_model || null;
  if (modelPath) {
    return ggufDescriptor({
      modelPath, forceCpu: args.cpu, contextSize: args.context_size,
      flashAttention: args.flash_attention, liveTodayDate: args.live_today_date,
    });
  }

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

// One-line engine identity for a resolved descriptor, for artifacts that must
// say what actually ran. `provider.label` alone ("Claude API") is not enough:
// two runs a year apart against different Claude generations are then
// indistinguishable in the artifact, so the exact model id — which is already
// resolved, and already used to price the run — is named too.
//
// The cloud/local parenthetical is the air-gap claim stated ON the artifact
// rather than asserted around it, which is the whole point of the local path.
export function describeEngine(model) {
  if (!model) return 'none';
  if (model.kind === 'gguf') {
    const base = String(model.modelPath || '').split(/[\\/]/).pop() || 'unknown.gguf';
    return `local GGUF — ${base} (local LLM, no network egress)`;
  }
  if (model.kind !== 'cloud') return String(model.kind || 'unknown');
  const label = model.provider?.label || model.label || 'cloud endpoint';
  const id = model.model ? ` — ${model.model}` : '';
  return `${label}${id} (cloud LLM)`;
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
  _truncation.last = false;   // this call's verdict, not the previous call's
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
    _recordUsage(body.usage);
    // BOTH wires are checked. The anthropic branch ignored stop_reason exactly
    // as the openai branch ignored finish_reason; Claude has not visibly
    // truncated only because its drafts run shorter.
    _recordTruncation(body.stop_reason === 'max_tokens');
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
  const body = await res.json();
  // openaiUsage takes the USAGE object, not the whole body — passing `body`
  // silently returned zeros, so OpenAI/Gemini runs reported "0 tok, $0.00"
  // while Claude's anthropic-wire accounting worked.
  _recordUsage(openaiUsage(body.usage));
  _recordTruncation(openaiFinishReason(body) === 'length');
  return openaiText(body);
}

// --- pseudo-claims-cost-guard: projection + consent gate + actuals ----------
//
// The pseudo-claims family (rank / chart drafting / claims-loop) is CE's most
// expensive cloud surface and had no dollar guard — the ffmpeg P2 chart ran
// 115 Claude drafts (~$4-6) unwarned. Before the first API call each stage
// projects its cost from what is already known deterministically and gates on
// a threshold: --force sends anyway, CE_CLAIMS_COST_GUARD (USD) overrides.
// Default $2 — deliberately above analyze's $0.50 (a chart run is
// legitimately multi-dollar; the guard is against SURPRISE scale). Local GGUF
// runs are free and never gated. draftCloud accumulates real usage so each
// stage can print an actual-cost line for calibrating the projections.

export const CLAIMS_COST_GUARD_USD = 2.0;
const CHARS_PER_TOKEN = 4; // the convention estimateCost pricing assumes

let _cloudUsage = { input_tokens: 0, output_tokens: 0, calls: 0 };
function _recordUsage(u) {
  if (!u) return;
  _cloudUsage.input_tokens += u.input_tokens || 0;
  _cloudUsage.output_tokens += u.output_tokens || 0;
  _cloudUsage.calls += 1;
}
export function resetCloudUsage() {
  _cloudUsage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  _truncation = { last: false, count: 0 };
}

// TRUNCATION SIDE CHANNEL, mirroring _cloudUsage above.
//
// WHY A SIDE CHANNEL and not a richer return value: draft(sys, user, max) ->
// Promise<string> has a dozen call sites across claim-locate, claim-chart,
// analyze, claim.js, pseudo-claims and synonymize, plus every test stub that
// passes opts.draft. Changing the contract would touch all of them for a signal
// most callers ignore.
//
// MEASURED, and this is why it exists: the Gemini drafter-swap run cut 15 of 41
// pseudo-claims off mid-sentence. Because the ANCHORS: block FOLLOWS the claim
// prose, every one of those lost its citations -- 16 claims with zero anchors,
// emitted as ordinary output and read as such for a day. openaiFinishReason
// already existed and was already used at analyze.js:243 and server.js:539;
// this draft path simply never asked.
//
// `last` is cleared at the START of every draftCloud call and written at the
// end, so a caller reading it immediately after `await draft(...)` sees THAT
// call's verdict. Drafting is sequential by construction (a shared GGUF session
// is not concurrent-safe), so there is no interleaving to race with.
let _truncation = { last: false, count: 0 };
function _recordTruncation(hit) {
  _truncation.last = !!hit;
  if (hit) _truncation.count += 1;
}
/** Did the most recent draft call stop because it hit the output budget? */
export function wasLastDraftTruncated() { return _truncation.last; }
/** How many draft calls were truncated since the last resetCloudUsage(). */
export function truncationCount() { return _truncation.count; }
/** Human-readable summary, or null when nothing was truncated. */
export function truncationLine() {
  if (!_truncation.count) return null;
  return `# WARNING: ${_truncation.count} draft(s) hit the output budget and were CUT OFF`
    + ` - text is incomplete and any trailing structured block (ANCHORS:, etc.) is missing.`;
}
export function getCloudUsage() { return { ..._cloudUsage }; }

// THE INFERENCE-ENGINE BUILD, captured at model load.
//
// asus-CC (#306): the chart header records engine and model but not the
// node-llama-cpp version or the llama.cpp build, "and those decide the
// numerics". Two local runs months apart on different builds are
// indistinguishable in the artifact, and `^3.18.1` lets the build move with no
// CE commit — so the reproducibility claim is the one thing the artifact could
// not support.
//
// Captured rather than probed: `getLlama()` loads the native binding and can
// allocate GPU, so asking for provenance must not become a side effect of
// reporting it. The values are read off the instance the run already built.
let _engineBuild = null;
// A captured field is a STRING or it is unknown.
//
// `getModuleVersion` is async in node-llama-cpp 3.18.1, so calling it
// synchronously returned a Promise — truthy, so it survived `|| null`, and it
// stringified into the Daubert-facing provenance line as
// `node-llama-cpp [object Promise]` (asus-CC, #315, on a live chart).
//
// The tests could not catch it, and that is the part worth keeping.
// `formatEngineBuild` was split out as a pure function precisely so every
// partial-knowledge combination could be asserted without a model, and those
// assertions pass — they cover ABSENT values. A Promise is not absent, it is a
// truthy non-string, so it sailed past `|| 'version unknown'`: the one field
// designed to say "I do not know" was the one that could not fire.
//
// So the type is enforced at CAPTURE. The renderer's fallbacks are written for
// absence, and absence is not the only way to be wrong.
const _str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

async function _recordEngineBuild(mod, llama) {
  try {
    const rel = llama?.llamaCppRelease;
    _engineBuild = {
      // Awaited, not read from package.json. asus-CC preferred the file to keep
      // provenance from becoming a side effect of reporting it — but that
      // property is about not PROBING at report time, and this runs inside
      // tryLoad, which is already async. The capture still happens once, off
      // the instance the run already built, and engineBuildLine() stays sync.
      moduleVersion: _str(typeof mod?.getModuleVersion === 'function'
        ? await mod.getModuleVersion() : null),
      llamaCppRelease: _str(rel?.release),
      buildType: _str(llama?.buildType),
      // WHERE it ran, not only what ran. CPU and CUDA do not produce identical
      // numerics, and CE falls back to CPU silently when the GPU cannot be
      // claimed — including the VRAM-probing race between two concurrent CE
      // processes that asus-CC measured (#316), where a run lands on CPU with
      // nothing in the artifact to show for it.
      gpu: llama?.gpu === false ? 'CPU' : _str(llama?.gpu),
      // The CARD, not only the backend: "cuda" satisfies numerics provenance,
      // but a customer-facing header wants "NVIDIA GeForce RTX 5080"
      // (chart-html-provenance-header; Andrew, 2026-09-04). Same capture
      // rules: read off the instance the run built, string-or-unknown, and
      // never let provenance take the run down.
      gpuDevice: _str(typeof llama?.getGpuDeviceNames === 'function'
        ? (await llama.getGpuDeviceNames().catch(() => null) || [])[0] : null),
    };
  } catch (_) { /* provenance must never take the run down */ }
}
/** The captured build, or null if no local model was loaded this process. */
export function getEngineBuild() { return _engineBuild ? { ..._engineBuild } : null; }
/**
 * Render a captured build. Pure, so every partial-knowledge combination is
 * testable without loading a model — the stateful reader below is a one-liner
 * over it. Unknown parts say the word "unknown": a silent omission is the
 * defect being repaired, and a confident-looking guess would be worse than
 * either.
 */
export function formatEngineBuild(b) {
  if (!b) return null;
  // Guarded here TOO, not only at capture. The capture guard is where the fix
  // belongs — a wrong type should never get this far — but this function is
  // exported, pure, and renders into a legal artifact, so it is made total
  // rather than trusting its caller. `|| 'version unknown'` was the whole
  // defect: a Promise is truthy, so the fallback could not fire (#315).
  return [
    `node-llama-cpp ${_str(b.moduleVersion) || 'version unknown'}`,
    `llama.cpp ${_str(b.llamaCppRelease) || 'build unknown'}`,
    _str(b.buildType) || 'build type unknown',
    _str(b.gpu) || 'device unknown',
  ].join(' · ');
}
/** One line naming the inference-engine build, or null for a cloud-only run. */
export function engineBuildLine() { return formatEngineBuild(_engineBuild); }

// calls: [{ inChars, outTokens }] — outTokens should be the EXPECTED output
// (not the maxTokens ceiling) so projections stay within ~2x of actuals.
export function projectCloudCost(model, calls) {
  let inTok = 0, outTok = 0;
  for (const c of calls || []) {
    inTok += Math.ceil((c.inChars || 0) / CHARS_PER_TOKEN);
    outTok += c.outTokens || 0;
  }
  const { usd } = estimateCost(model?.model, { input_tokens: inTok, output_tokens: outTok });
  return { usd, inTok, outTok };
}

// Print the projection; return false when the run should NOT proceed.
// Cloud models only — a null/gguf model always passes silently.
export function claimsCostGate(model, calls, label, args = {}) {
  if (!model || model.kind !== 'cloud') return true;
  const { usd, inTok, outTok } = projectCloudCost(model, calls);
  const kk = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  process.stderr.write(`# projected cost: ~$${usd.toFixed(2)} (${label}, ~${kk(inTok)} tok in / ${kk(outTok)} out, ${model.model})\n`);
  const env = parseFloat(process.env.CE_CLAIMS_COST_GUARD);
  const guard = Number.isFinite(env) ? env : CLAIMS_COST_GUARD_USD;
  if (usd <= guard || args.force) return true;
  console.error(`# projected ~$${usd.toFixed(2)} exceeds the $${guard.toFixed(2)} cost guard — not sending.`);
  console.error('#   --force to proceed anyway, or set CE_CLAIMS_COST_GUARD (USD) to raise the threshold.');
  return false;
}

// One-line actuals from the accumulated usage (null when nothing was spent or
// the model is not cloud). Callers resetCloudUsage() at stage start.
export function actualCostLine(model) {
  if (!model || model.kind !== 'cloud' || !_cloudUsage.calls) return null;
  const { usd } = estimateCost(model.model, _cloudUsage);
  const kk = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return `# actual cost: ~$${usd.toFixed(2)} (${_cloudUsage.calls} calls, ${kk(_cloudUsage.input_tokens)} tok in / ${kk(_cloudUsage.output_tokens)} out)`;
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
// A code index has no "today", but node-llama-cpp tells the model there is one.
// It resolves a Llama-3.1 GGUF to its OWN wrapper rather than the file's jinja
// template, and that wrapper defaults `todayDate` to a live clock
// (`Llama3_1ChatWrapper.js:30`), rendering into the system prompt at `:215`:
//
//   ["Cutting Knowledge Date: December 2023","Today Date: 7 Aug 2026"]
//   ["Cutting Knowledge Date: December 2023","Today Date: 9 Aug 2026"]
//
// So the prompt is a function of the calendar and the same command produces
// different output on different days. Measured by asus-CC (F58) after two Llama
// cells failed to reproduce; two other explanations were refuted first — the
// model is byte-stable 3/3, and the preserved prior tree produces today's bytes
// today. Llama-3.2 has the same default
// (`Llama3_2LightweightChatWrapper.js:191,197`); Gemma, Mistral and Qwen inject
// nothing.
//
// `--reproducible` does NOT cover this: that pins temperature and seed, which is
// a sampling axis. This is an input-text axis.
//
// PINNED rather than removed. Passing null deletes the `Today Date:` line
// entirely, which is semantically cleaner — but it changes the prompt SHAPE away
// from what the family was instruction-tuned on, and `Cutting Knowledge Date:` /
// `Today Date:` are a pair the template emits together. Dropping half of that
// pair is an unmeasured bet. The constant is the date the GGUF's own template
// hardcodes, so it is what the model's packager intended when the library is not
// overriding them.
// LOCAL noon, not a UTC instant. The wrappers format this date in LOCAL time,
// so `new Date('2024-07-26T00:00:00Z')` — the first version of this constant —
// renders "25 Jul 2024" in every timezone west of UTC and "26 Jul" only in UTC
// itself. Stable per machine, but two machines in different timezones then send
// different prompts, reintroducing exactly the cross-machine incomparability
// this fix exists to remove. Measured across UTC / Los_Angeles / Tokyo / London
// / New_York (asus-CC D2).
//
// Noon gives ~12h of margin either side, so every real UTC offset (-12..+14)
// lands on the same calendar day. The library agrees with this reading: its own
// test constant is `new Date("2024-07-26T00:00:00")` — no `Z`.
//
// The value is the date Llama 3.1's own jinja template hardcodes, so CE pins to
// what the model's packager intended rather than inventing one. Month is
// 0-indexed: 6 = July.
export const PINNED_TODAY_DATE = new Date(2024, 6, 26, 12);

// The wrappers that default `todayDate` to a live clock in node-llama-cpp
// 3.18.1. Verified by grepping the installed dist rather than assumed:
// `todayDate` appears in exactly these three.
//
// HARMONY IS THE ONE THAT NEARLY GOT MISSED. gpt-oss-20b resolves to it, and a
// Llama-only fix would have left the model this program is spending a 12 GB
// download to test drifting day to day. Caught by asus-CC before batch 2 was
// tested. Any wrapper added upstream with the same default needs adding here —
// the check is `grep -l todayDate node_modules/node-llama-cpp/dist/chatWrappers/`.
export const DATE_INJECTING_WRAPPERS = ['llama3.1', 'llama3.2-lightweight', 'harmony'];


// Options for every `new LlamaChatSession` CE creates. One helper so the six
// call sites cannot drift apart.
//
// `todayDate` is a WRAPPER CONSTRUCTOR option, not a session option — passing it
// to LlamaChatSession is silently dropped. That was version 1 of this fix and it
// did nothing.
//
// Version 2 passed it via `customWrapperSettings` to `resolveChatWrapper`, and
// that was WORSE on gpt-oss. The resolver merges customWrapperSettings into each
// candidate wrapper BEFORE testing whether it can supersede the model's jinja
// template (`resolveChatWrapper.js:154`), so any `todayDate` we supply changes
// what the test renderings produce and therefore which wrapper is chosen.
//
// Llama 3.1 survives it: its GGUF template hardcodes `date_string = "26 Jul
// 2024"`, and the wrapper ships a test config pinned to exactly that date, so a
// match is still found. Harmony has no config whose rendered date can match what
// its template produces, so every candidate fails and resolution falls through
// to JinjaTemplate. On gpt-oss that swapped the wrapper AND left the clock live,
// while bypassing Harmony's own modelIdentity / cuttingKnowledgeDate /
// reasoningEffort defaults — strictly worse than the drift it was meant to fix,
// on the one model the roster's 12 GB download was for.
//
// Found by asus-CC (D1) before it was ever measured. Their bisect is the
// load-bearing fact and it is empirical: `{harmony: {todayDate: <anything>}}`,
// including `null`, drops Harmony to JinjaTemplate, while `{harmony: {}}` and no
// settings both keep it. Their stated cause — "Harmony's configs never mention
// todayDate" — is not quite right (its last five configs set it to null), which
// is why the reasoning above is phrased around the RENDERED date rather than the
// presence of the key. The remedy is unaffected either way: do not perturb the
// resolver at all.
//
// VERSION 3, this one: resolve UNPERTURBED, then set the field on the resolved
// instance. All three dated wrappers read `this.todayDate` at RENDER time
// (Llama3_1 :195/:211, Harmony :403, Llama3_2Lightweight :177/:193), never
// capturing it at construction, so assignment takes effect — and unlike
// reconstructing via `new probe.constructor({todayDate})` it preserves every
// other setting the resolver applied. That matters: Llama3_1 has a test config
// whose applyConfig is `{cuttingKnowledgeDate: ...}`, which a reconstruct would
// silently drop.
//
// When the resolved wrapper injects no date (Gemma, Mistral, Qwen) CE passes NO
// wrapper at all and lets the session resolve as it always did — minimum
// deviation, and provably byte-identical for those families.
//
// Async because node-llama-cpp is imported dynamically everywhere else in CE —
// it must stay an optional dependency. Every call site is already in an async
// context.
export async function chatSessionOptions(contextSequence, { liveTodayDate = false, onStatus, ...rest } = {}) {
  if (liveTodayDate) return { contextSequence, ...rest };
  let chatWrapper = null;
  try {
    const { resolveChatWrapper } = await import('node-llama-cpp');
    const probe = resolveChatWrapper(contextSequence.model);
    if (probe && probe.todayDate != null) {
      probe.todayDate = PINNED_TODAY_DATE;
      chatWrapper = probe;
      if (onStatus) onStatus(`chat wrapper: ${probe.wrapperName} (Today Date pinned)`);
    } else if (probe && onStatus) {
      // Do not claim a pin that never happened — the previous wording said
      // "Today Date pinned" on Gemma, which injects no date at all.
      onStatus(`chat wrapper: ${probe.wrapperName} (no date injected)`);
    }
  } catch (e) {
    // Failing to PIN must never fail the RUN. Falling back to the library's own
    // resolution means the date drifts again on the three affected wrappers —
    // worse than pinned, no worse than before this existed — so it is reported
    // rather than swallowed.
    if (onStatus) onStatus(`could not pin Today Date (${e.message}); using library default wrapper`);
    chatWrapper = null;
  }
  return { contextSequence, ...(chatWrapper ? { chatWrapper } : {}), ...rest };
}

// Options for node-llama-cpp's createContext. Split out and exported so the
// byte-identical-default guarantee is testable without a GPU: when flash
// attention is off the key is ABSENT, not false, so a default run hands the
// library exactly the object it received before the flag existed. That is what
// keeps a byte-compare re-pin of existing measurement runs cheap.
export function ggufContextOptions(contextSize, flashAttention = false) {
  return { contextSize, ...(flashAttention ? { flashAttention: true } : {}) };
}

// ISOLATION BETWEEN TARGETS — and `resetChatHistory()` alone does not provide it.
//
// resetChatHistory() calls setChatHistory(), which rewrites the chat history
// OBJECT. It does not touch the context sequence, which still holds every token
// evaluated for every previous target. By target N the sequence is near-full,
// context shifting starts evicting, and the prompt the model actually sees is
// not the prompt CE built.
//
// MEASURED (asus-CC, 2026-09-09, #325): the same target, same code, same 6
// inlined callee bodies, same claim, temperature 0 —
// AdaptiveTrackSelection::updateSelectedTrack returns ASSUMED with a line
// citation when analysed at position 1 or 2 of a run, and a bare
// `ABSENT | no line` at position 9. Deterministic in both directions, and the
// position-9 reconstruction reproduced the production chart exactly. That
// element is the one the frontier reference rates STRONG, so the defect cost a
// real chart its best citation for a make-or-break limitation — and it silently
// inflates the `(1 of 25; 24 ABSENT)` agreement counts the artifact offers as
// evidence.
//
// So the sequence is cleared and the session rebuilt on it. Building a
// LlamaChatSession is cheap — no model load, no context allocation — and it
// guarantees neither half carries state across targets. This is the pattern
// server.js callLocal already uses (acquireSharedSequence clears the sequence,
// then a fresh session per call); the CLI drafter was the one path without it.
//
// CE_REUSE_SESSION=1 restores the old behaviour, for reproducing the defect
// rather than for use. Exported so the isolation contract is testable without
// a model.
export async function isolateLocalSession({ session, sequence, ChatSession, sessionOptions, reuse = process.env.CE_REUSE_SESSION === '1' }) {
  if (reuse) {
    await session.resetChatHistory();
    return session;
  }
  try { await sequence.clearHistory(); } catch { /* older builds: best effort */ }
  return new ChatSession(await sessionOptions(sequence));
}

function makeGgufDrafter(modelPath, forceCpu, temperature, contextSize = null, flashAttention = false, liveTodayDate = false) {
  let session = null;
  // Held so the KV state can be cleared between targets, not just the chat
  // history object — see isolateLocalSession above.
  // The constructor is hoisted too: it is destructured inside the load block,
  // and the per-target rebuild needs it after that block has returned.
  let sequence = null;
  let ChatSession = null;
  // A load failure is structural for the life of the process (no binding, no
  // VRAM budget, model file missing/too large): cache the first one and fail
  // fast on every later draft() instead of re-entering the load path once per
  // target — one OOM used to become 44 full load attempts, each dumping
  // llama.cpp diagnostics into the chart's stdout. Deliberately no
  // retry-with-backoff. #323.
  let loadFailure = null;
  return async (sys, user, maxTokens) => {
    if (loadFailure) throw loadFailure;
    if (!session) {
      try {
      let mod;
      try { mod = await import('node-llama-cpp'); }
      catch (e) { throw new Error(`local GGUF needs node-llama-cpp (npm install node-llama-cpp): ${e.message}`); }
      const { getLlama, LlamaChatSession } = mod;
      ChatSession = LlamaChatSession;
      let lastError = null;
      const tryLoad = async (cpuOnly) => {
        // getLlama/_recordEngineBuild/loadModel sit INSIDE the guarded region:
        // a model that cannot be loaded at all (cudaMalloc failure on the
        // weights buffer, ENOENT) used to throw straight past the GPU->CPU
        // retry below — the ladder guarded model+context, nothing guarded the
        // model. #323.
        let m;
        try {
          const llama = await getLlama(cpuOnly ? { gpu: false } : undefined);
          // Recorded on EVERY attempt, so a chart built after a GPU->CPU fallback
          // reports the device it actually ran on rather than the one it wanted.
          await _recordEngineBuild(mod, llama);
          m = await llama.loadModel({ modelPath });
        } catch (e) {
          lastError = e;
          process.stderr.write(`  ${cpuOnly ? 'CPU' : 'GPU'} model load failed: ${e.message}\n`);
          return null;
        }
        for (const sz of ggufContextLadder(contextSize)) {
          try {
            const ctx = await m.createContext(ggufContextOptions(sz, flashAttention));
            process.stderr.write(`  context ${sz}${cpuOnly ? ' (CPU)' : ''}${flashAttention ? ' (flash attention)' : ''}\n`);
            return ctx;
          } catch (e) { lastError = e; /* shrink */ }
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
      if (!ctx) throw new Error('could not allocate a context for the local model (tried GPU and CPU) — try --cpu'
        + (lastError ? ` (last error: ${lastError.message})` : ''));
      sequence = ctx.getSequence();
      session = new LlamaChatSession(await chatSessionOptions(sequence, { liveTodayDate }));
      } catch (e) { loadFailure = e; throw e; }
    } else {
      // Isolate each target — the KV sequence, not just the chat history
      // object. See isolateLocalSession.
      session = await isolateLocalSession({
        session, sequence, ChatSession,
        sessionOptions: (seq) => chatSessionOptions(seq, { liveTodayDate }),
      });
    }
    // LOCAL PATH: node-llama-cpp's promptWithMeta reports WHY generation stopped,
    // so the local drafter gets the same signal as the cloud wires rather than a
    // heuristic. Falls back to plain prompt() on older versions -- and when it
    // does, truncation goes UNDETECTED here, which is stated rather than papered
    // over: a silent local truncation is exactly the Gemma failure mode this
    // item exists to make visible.
    _truncation.last = false;
    if (typeof session.promptWithMeta === 'function') {
      const r = await session.promptWithMeta(`${sys}\n\n${user}`, { temperature: temperature ?? 0, maxTokens });
      _recordTruncation(r && (r.stopReason === 'maxTokens' || r.stopReason === 'contextSizeExceeded'));
      return typeof r === 'string' ? r : (r && r.responseText) || '';
    }
    return session.prompt(`${sys}

${user}`, { temperature: temperature ?? 0, maxTokens });
  };
}

// Build a draft(sys,user,maxTokens)->text function for the resolved model,
// applying the air-gap gate + cloud-key check ONCE up front (fail-closed: a
// remote endpoint under --air-gapped, or a missing cloud key, throws before any
// group is drafted).
export function makeDrafter(model, temperature) {
  if (model.kind === 'gguf') {
    return makeGgufDrafter(model.modelPath, model.forceCpu, temperature, model.contextSize, model.flashAttention,
      model.liveTodayDate);
  }
  if (!isLocalApiUrl(model.apiUrl)) assertLocalOnly(`pseudo-claims (cloud ${model.label})`);
  if (!model.key && !isLocalApiUrl(model.apiUrl)) {
    const p = model.provider;
    throw new Error(p
      ? `no ${p.label} key — set ${p.keyEnv}, pass ${p.keyFlag}/--api-key, or create ${p.keyFiles[0]}`
      : `no API key for ${model.apiUrl}`);
  }
  return (sys, user, maxTokens) => draftCloud(model, sys, user, maxTokens, temperature);
}
