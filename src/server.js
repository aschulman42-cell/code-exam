#!/usr/bin/env node
// server.js — GUI HTTP server: /api JSON routes over loaded indexes, index building, LLM chat and Overview by AI
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * server.js - GUI server for Code Exam.
 *
 * The HTTP layer is Node's built-in http module (no web framework); the MCP
 * and Overview by AI imports bring the dependencies declared in package.json.
 * Loads one or more CodeSearchIndex instances and exposes API routes
 * that return JSON. The browser UI (public/) handles rendering.
 *
 * Usage:
 *   node src/server.js --index-path .my_index
 *   node src/server.js --index-path .idx1 --index-path .idx2
 *   node src/server.js --port 8080
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import v8 from 'v8';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';
import { IndexManager } from './core/index-manager.js';
import { handleTool, TOOLS, setIndex } from './mcp-server.js';
import { resolveIndexDir } from './archive.js';
import { groupSites, groupPipelines, reTestExamplePath, KERNELS_DRILLDOWN, MULTIMODAL_DRILLDOWN, POSTTRAINING_DRILLDOWN, REASONING_DRILLDOWN, MODELS_DRILLDOWN, ARTIFACTS_DRILLDOWN, DATASETS_DRILLDOWN, TOOLS_DRILLDOWN, TRAINING_DRILLDOWN, INFERENCE_DRILLDOWN, LLMCALLS_DRILLDOWN, CHAINS_DRILLDOWN, EMBEDDINGS_DRILLDOWN, STRUCTURED_OUTPUT_DRILLDOWN, EXPLAINABILITY_DRILLDOWN } from './core/ai-ml-detectors.js';
import { makeFilterMatcher } from './core/filter-match.js';
// F58: pin `Today Date:` so the GUI's local sessions do not inherit a live clock.
import { chatSessionOptions, ggufContextOptions, stripLocalArtifacts, draftCloud, getLlamaShared, isNoBinaryError, NO_BINARY_MESSAGE } from './core/llm-runner.js';
import { extractExports } from './core/exports.js';
import { extractImports, bomReport } from './core/imports.js';
import { copyrightNotices } from './core/copyrights.js';
import { extractConcepts, INTRINSIC_NAMES, isIntrinsicName } from './core/vocabulary.js';
import { buildOverviewFast, buildOverviewDeep } from './core/overview.js';
import { extractDataStructures } from './core/data-structs.js';
import { extractClientServer } from './core/client-server.js';
import { extractReferencedResources } from './core/referenced-resources.js';
import { runAiOverview, AI_OVERVIEW_TOOLS, aiOverviewPrompt, questionsRegenPrompt, questionLinesFromAnswer, QUESTIONS_REGEN_TEMPERATURE, QUESTIONS_REGEN_MAX_TOKENS } from './core/ai-overview.js';
import { strictInstructionsFor, ungroundedWarning, localBudgets } from './core/ai-overview-local.js';
import { aimlVerificationNote, aimlConverseNote, toolCallFooter } from './core/answer-disclosure.js';
// cli-ask-ai: the chat loops live in core/chat-runner.js now, shared with the
// CLI's --ask-ai; the server keeps thin wrappers below so its routes are unchanged.
import { CHAT_GROUNDING_CLAUSES, neutralizeSpecialTokens, measureOverhead, runChatToolLoop as runChatToolLoopCore, runChatToolLoopOpenAI as runChatToolLoopOpenAICore, runChatToolLoopLocal as runChatToolLoopLocalCore } from './core/chat-runner.js';
import { setAirGapped, scrubApiKey, airGappedStartupCheck, isAirGapped, isLocalApiUrl, AIR_GAPPED_DISCLAIMER } from './core/air-gapped.js';
import { estimateCost } from './core/pricing.js';
import { openaiSupportsTemperature, openaiCompletionBudget, openaiUsage, openaiFinishReason } from './core/openai-util.js';
import { skippedExtensionCensus } from './core/extension-census.js';
import { loadUsedByCatalog, makeUsedByFor } from './commands/exports.js';
import { detectInfrastructure } from './core/stack-detectors.js';
import { SERVER_BUILD, CE_VERSION } from './version.js';
import { buildProvenanceHeader, sanitizedCommandLine } from './core/provenance.js';
import { parseMultisectTerms, prepareMultisectViews, filterLowSelectivity } from './commands/multisect.js';
import { formatFunctionDigest, formatClassDigest, formatFileDigest } from './commands/digest.js';
import { collectPrompts } from './commands/prompts.js';
import { displayName, parseFuncSpec, claudeSupportsTemperature, MEDIA_BINARY_EXTENSIONS, ARCHIVE_EXTENSIONS, EXECUTABLE_EXTENSIONS } from './utils.js';
import { resolveProvider, PROVIDERS } from './core/providers.js';
import { BINSTRING_EXTENSIONS } from './binstrings.js';
import { execCommand } from './commands/interactive.js';
import {
  extractClaimKeywords, extractClaimTerms, sanitizeLlmTerms, sanitizeBroadTerms, dropStopListedTerms,
  parseTermResponse, extractFirstClaim,
  buildExtractionPromptWithVocab, buildLocalExtractionPromptWithVocab,
  CLAIM_EXTRACTION_PROMPT, CLAIM_EXTRACTION_PROMPT_LOCAL,
} from './commands/claim.js';
import {
  buildAnalyzePrompt, buildClaimAnalyzePrompt,
  buildMultisectAnalyzePrompt, buildContextAnalyzePrompt,
  buildFileAnalyzePrompt,
  SimpleMasker, detectLanguage, addLineNumbers,
} from './commands/analyze.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Static-files lookup: `<repo>/public/`, reachable from `src/` via
// `../public`. (A second candidate next to `process.execPath` once served the
// Bun-compiled standalone exe; the exe was retired, see #78.)
const PUBLIC_DIR = path.join(__dirname, '..', 'public');


// ========================================================================
// Safe max-result parsing — prevents DoS via ?max=999999999
// ========================================================================

function safeMax(raw, defaultVal, ceiling = 10000) {
  const n = parseInt(raw);
  if (isNaN(n) || n < 1) return defaultVal;
  return Math.min(n, ceiling);
}

// ========================================================================
// Parse server arguments
// ========================================================================

function parseServerArgs() {
  const args = process.argv.slice(2);
  const result = { indexPaths: [], port: 3000, host: '127.0.0.1', modelPath: null, apiKey: null, temperature: 0.0, catalogPath: null, airGapped: false, allowConnected: false, contextSize: null, flashAttention: false, reproducible: false, openaiKey: null, openaiModel: null, geminiKey: null, geminiModel: null, defaultEngine: null, provenance: false };

  // A value-taking flag must be followed by a non-flag token; otherwise warn
  // and do NOT consume the next token. Without this, `--llm --air-gapped`
  // swallows --air-gapped as the value of --llm and the server silently runs
  // with air-gap protection OFF. (index.js's _argAfter guards the `ce --gui`
  // wrapper the same way; this covers direct `node src/server.js` launches.)
  let i = 0;
  const takeValue = (flag) => {
    const v = args[i + 1];
    if (v === undefined || String(v).startsWith('-')) {
      console.error(`[args] ${flag} requires a value; flag ignored`);
      return null;
    }
    i++;
    return v;
  };

  for (i = 0; i < args.length; i++) {
    const a = args[i];
    let v;
    if (a === '--index-path' || a === '--index') {
      if ((v = takeValue(a)) !== null) result.indexPaths.push(v);
    } else if (a === '--exports-catalog' || a === '--catalog') {
      if ((v = takeValue(a)) !== null) result.catalogPath = v;
    } else if (a === '--port') {
      if ((v = takeValue(a)) !== null) result.port = parseInt(v) || 3000;
    } else if (a === '--host') {
      if ((v = takeValue(a)) !== null) result.host = v;
    } else if (a === '--model-path' || a === '--model' || a === '--local-model') {
      if ((v = takeValue(a)) !== null) result.modelPath = v;
    } else if (a === '--claude-model') {
      if ((v = takeValue(a)) !== null) result.claudeModel = v;
    } else if (a === '--api-key' || a === '--key') {
      if ((v = takeValue(a)) !== null) result.apiKey = v;
    } else if (a === '--llm') {
      // GUI default engine: --llm <provider> sets which engine the Chat +
      // Workspace controls start on. Local stays the default when a
      // --model-path is given without --llm. #246: resolved through the ONE
      // provider registry (fail loud on unknown; never coerce to Claude).
      if ((v = takeValue(a)) !== null) {
        const norm = String(v).toLowerCase();
        const { provider, error } = resolveProvider(norm, { allowDefault: false });
        if (provider) {
          result.defaultEngine = provider.id;   // claude | openai | gemini
        } else {
          if (norm === 'local' || norm.endsWith('.gguf')) {
            const ex = norm.endsWith('.gguf') ? ` (e.g. --model-path ${v})` : '';
            console.error(`ERROR: --llm selects a CLOUD provider, not a local model. For the local engine, start with --model-path <gguf>${ex} or pick Local in the Chat / Workspace Engine dropdown.`);
          } else {
            console.error(`ERROR: ${error}`);
          }
          process.exit(1);
        }
      }
    } else if (a === '--gemini-key' || a === '--gemini_key') {   // #246
      if ((v = takeValue(a)) !== null) result.geminiKey = v;
    } else if (a === '--gemini-model' || a === '--gemini_model') {
      if ((v = takeValue(a)) !== null) result.geminiModel = v;
    } else if (a === '--openai-key' || a === '--openai_key') {
      if ((v = takeValue(a)) !== null) result.openaiKey = v;
    } else if (a === '--openai-model' || a === '--openai_model') {
      if ((v = takeValue(a)) !== null) result.openaiModel = v;
    } else if (a === '--temperature') {
      if ((v = takeValue(a)) !== null) result.temperature = parseFloat(v) || 0.0;
    } else if (a === '--context-size' || a === '--context_size') {
      // #239 convention: accept either flag spelling.
      if ((v = takeValue(a)) !== null) result.contextSize = parseInt(v) || null;
    } else if (a === '--flash-attention' || a === '--flash_attention') {
      // #306 F67: --context-size was accepted here all along while its sibling,
      // which governs whether the requested size FITS, was not — so a GUI run
      // asking for 16384 silently landed at 8192 on a model needing the flag.
      result.flashAttention = true;
    } else if (a === '--reproducible') {
      // local-chat-determinism: reproducible local-LLM runs (temperature 0 +
      // fixed seed). Default OFF — run-to-run variation is the chosen default.
      // Named "reproducible" (not "deterministic") deliberately: the claim is
      // empirical and environment-scoped, not a formal guarantee.
      result.reproducible = true;
    } else if (a === '--air-gapped') {
      result.airGapped = true;
    } else if (a === '--allow-connected') {
      result.allowConnected = true;
    } else if (a === '--provenance') {
      // #215 Phase 2: GUI saves get the provenance header (served via
      // /api/provenance; the 💾 handlers prepend it to downloads).
      result.provenance = true;
    } else if (!a.startsWith('-')) {
      result.indexPaths.push(a);
    }
  }

  if (result.indexPaths.length === 0) {
    // Only default to .code_search_index if it actually exists
    if (fs.existsSync('.code_search_index')) {
      result.indexPaths.push('.code_search_index');
    }
  }

  // A --model-path without an explicit --llm implies the local engine is the
  // intended default: seed the GUI Chat/Workspace dropdowns to Local so they
  // match the loaded model rather than defaulting to the Claude cloud API.
  // (An explicit --llm claude|openai wins — the user chose a cloud engine.)
  if (result.modelPath && result.defaultEngine === null) {
    result.defaultEngine = 'local';
  }

  return result;
}


// ========================================================================
// Index manager: holds one or more named indexes — see core/index-manager.js
// (moved there so replace() is unit-testable; this file can't be imported by
// tests because it starts the HTTP server on import).
// ========================================================================

const serverArgs = parseServerArgs();

// Loopback test for the bind host, shared by the #266 non-loopback bind guard
// below, validateFilePath, and the DNS-rebinding Host-allowlist. Defined up here
// so the startup guard can use it before any model/index load.
const _LOCALHOST = /^(127\.\d|localhost$|::1$)/;

// #223: --air-gapped for the GUI server (forwarded from `ce --gui --air-gapped`).
// Block cloud AI, scrub the key, print the disclaimer, and refuse to start if
// the internet is reachable unless --allow-connected.
if (serverArgs.airGapped) {
  setAirGapped(true, { allowConnected: serverArgs.allowConnected });
  scrubApiKey();
  console.error(AIR_GAPPED_DISCLAIMER);
  if (serverArgs.allowConnected) {
    console.error('[air-gapped] --allow-connected accepted: cloud AI calls stay BLOCKED; the network-reachability refusal is skipped so CodeExam can run on a connected machine.');
  }
  const _refusal = await airGappedStartupCheck();
  if (_refusal) { console.error(`[air-gapped] ${_refusal}`); process.exit(2); }
}

// #266: non-loopback bind guard. Binding a public/LAN interface serves the
// indexed (protected) source and local files with NO authentication. Under
// --air-gapped that contradicts the isolation promise, so refuse to start;
// otherwise proceed with a loud warning (the operator's deliberate choice). The
// loopback Host-allowlist in handleRequest only fires on a loopback bind, so
// this is the coverage for the exposed case.
if (!_LOCALHOST.test(serverArgs.host)) {
  if (isAirGapped()) {
    console.error(`[air-gapped] Refusing to start: --host ${serverArgs.host} binds a non-loopback interface, which would serve your indexed source on the network — incompatible with an air-gapped run. Bind loopback (the default) and reach it over an SSH tunnel, or drop --air-gapped to serve on a trusted network.`);
    process.exit(2);
  }
  console.error(`\n⚠  CodeExam GUI is bound to a NON-LOOPBACK address (--host ${serverArgs.host}) with NO authentication.\n   Anyone who can reach ${serverArgs.host}:${serverArgs.port} can read your indexed (protected) source and local files.\n   Use only on a trusted, firewalled network; for remote access, prefer binding loopback (the default) + an SSH tunnel.\n`);
}

const mgr = new IndexManager();
const buildJobs = new Map();  // jobId -> { status, progress, stats, error, loaded, indexes }
let nextBuildJobId = 1;

for (const ip of serverArgs.indexPaths) {
  mgr.load(ip);
}

if (mgr.indexes.size === 0) {
  console.error('No indexes loaded — use File > Load Index or File > Build Index in the GUI, or restart with --index-path.');
}

// #166: optional who-uses catalog for the Exports "Used by" column. Specified
// on the CLI (--exports-catalog <file>); the GUI picker is deferred. Loaded
// once at startup; a bad path disables the column but never stops the server.
let exportsCatalog = null;
if (serverArgs.catalogPath) {
  try {
    exportsCatalog = loadUsedByCatalog(serverArgs.catalogPath);
    const n = Object.keys(exportsCatalog.libraries).length;
    // #215: catalog-usage is a provenance fact -> stderr (was stdout), so the
    // server's machine-readable stdout stays clean; #215 brings a controlled
    // stdout path back later.
    console.error(`Loaded exports catalog "${serverArgs.catalogPath}": ${n} librar${n === 1 ? 'y' : 'ies'} (Used-by column enabled)`);
  } catch (e) {
    console.error(`Warning: ${e.message.replace(/^--used-by /, '--exports-catalog ')} — Used-by column disabled.`);
  }
}


// ========================================================================
// Server-side LLM manager
// ========================================================================
// Supports two backends:
//   Claude API  - uses Anthropic Messages API with system+user prompts
//   Local GGUF  - uses node-llama-cpp (lazy-loaded, persistent model)
//
// Configured via server args (--model-path, --api-key) and/or per-request
// params (engine, apiKey). Local model is loaded once and reused.
// ========================================================================

// Serialize ALL local-GGUF work — chat, Overview by AI, and analyze/claim term
// extraction share the model's single cached sequence (and clearHistory reset),
// so overlapping local requests would prompt the same sequence concurrently and
// corrupt both generations (garbled output or a native crash). This promise-
// chain mutex runs local requests strictly one at a time; cloud requests are
// unaffected. #248
let _localTail = Promise.resolve();
function withLocalLock(fn) {
  const result = _localTail.then(fn, fn);
  _localTail = result.then(() => {}, () => {});
  return result;
}

// #248: output reserve + tool-result budget must fit the loaded context. The old
// floors (2400 output tokens, 6000 result chars) exceeded the 2048/4096 fallback
// rungs, guaranteeing the context overflow they were meant to prevent on modest
// hardware. Scale with context and CLAMP the output reserve so prompt overhead
// plus a minimum tool budget always fit — while preserving the 8k+ behavior
// (maxTokens stays 2400 there; only the tiny rungs clamp down).
// #320: delegates to the canonical implementation in ai-overview-local.js so
// the two copies cannot drift (this one had already drifted from it once —
// the measured-overhead third parameter exists only there).
//
// That third parameter is now threaded through. The old note here said callers
// "have no measured overhead in hand", and that was simply not true: both call
// sites hold the loaded model, so they hold its tokenizer. Taking the 1200
// fallback was therefore a GUI/CLI divergence of the #306-F67 family — the CLI
// measures ~2970 and passes it, the GUI assumed 1200 — and at ctx-8192 that
// understatement is larger than the entire remaining slack, so the tool budget
// handed out more space than existed and the context-shift failure was
// arithmetic rather than bad luck (asus-CC, 2026-10-13).
function _localBudgets(contextSize, explicitMaxTokens, overheadTokens = null) {
  return localBudgets(contextSize, explicitMaxTokens, overheadTokens);
}

// The CLI's measurement (ai-overview-local.js), mirrored rather than re-derived:
// base prompt through the model's own tokenizer, tool definitions at chars/3.5,
// plus the same stated 400-token margin. One implementation now, in
// core/chat-runner.js (cli-ask-ai); this alias keeps the call sites readable.
const _measureOverhead = measureOverhead;

class ServerLLM {
  constructor(opts = {}) {
    this.defaultModelPath = opts.modelPath || null;
    this.defaultClaudeModel = opts.claudeModel || null;  // --claude-model server default
    this.preferredContextSize = opts.contextSize || null;
    // --context-size: first rung of the context ladder
    this.flashAttention = !!opts.flashAttention;  // #306 F67: never threaded to the GUI path
    // --reproducible: pinned local-LLM sampling. Honest scope: same
    // question + same index + same model file + same CE build/config on the
    // same machine => same answer. Cross-machine or cross-driver bit-identity
    // is NOT promised (GPU kernel scheduling can differ across backends).
    this.reproducible = !!opts.reproducible;
    // #223 layer 2: under --air-gapped, skip cloud-key resolution entirely.
    // Env keys are scrubbed at startup, but the key-FILE fallbacks below would
    // re-arm any missed or bypassed call-site guard — so neither cloud key may
    // load at all, and /api/llm-status then honestly reports both cloud
    // engines unavailable instead of inviting a selection that fails at call time.
    this.defaultApiKey = isAirGapped() ? '' : (opts.apiKey || process.env.ANTHROPIC_API_KEY || '');
    this._localModel = null;     // { llama, model, context, LlamaChatSession, contextSize }
    this._localLoading = null;   // Promise while model is loading (prevents double-load)

    // Try reading API key from file if not in env
    if (!this.defaultApiKey && !isAirGapped()) {
      for (const fname of ['claude.txt', 'claude_key.txt']) {
        try {
          const key = fs.readFileSync(fname, 'utf-8').trim();
          if (key) { this.defaultApiKey = key; break; }
        } catch { /* ignore */ }
      }
    }

    // OpenAI / ChatGPT provider (#243 Part B): key + model resolution mirrors
    // the Claude pattern (flag > env > key file).
    this.defaultOpenAIKey = isAirGapped() ? '' : (opts.openaiKey || process.env.OPENAI_API_KEY || '');
    if (!this.defaultOpenAIKey && !isAirGapped()) {
      for (const fname of ['openai.txt', 'openai_key.txt']) {
        try {
          const key = fs.readFileSync(fname, 'utf-8').trim();
          if (key) { this.defaultOpenAIKey = key; break; }
        } catch { /* ignore */ }
      }
    }
    this.defaultOpenAIModel = opts.openaiModel || process.env.CE_OPENAI_MODEL || 'gpt-5.1';

    // #246: Gemini provider (openai-compat). Same flag > env > key file pattern.
    this.defaultGeminiKey = isAirGapped() ? '' : (opts.geminiKey || process.env.GEMINI_API_KEY || '');
    if (!this.defaultGeminiKey && !isAirGapped()) {
      for (const fname of PROVIDERS.gemini.keyFiles) {
        try {
          const key = fs.readFileSync(fname, 'utf-8').trim();
          if (key) { this.defaultGeminiKey = key; break; }
        } catch { /* ignore */ }
      }
    }
    this.defaultGeminiModel = opts.geminiModel || PROVIDERS.gemini.defaultModel;
  }

  // --- Claude API: system + user message structure ---

  async callClaude(systemPrompt, userMessage, opts = {}) {
    const apiKey = opts.apiKey || this.defaultApiKey;
    if (!apiKey) {
      return { error: 'No API key. Set ANTHROPIC_API_KEY env var, create claude.txt, or pass --api-key.' };
    }

    const apiUrl = opts.apiUrl || process.env.CLAIM_SEARCH_API_URL || 'https://api.anthropic.com/v1/messages';
    const model = opts.model || this.defaultClaudeModel || process.env.CLAIM_SEARCH_MODEL || 'claude-sonnet-4-6';
    const maxTokens = opts.maxTokens || 2048;
    const temperature = opts.temperature ?? 0.0;
    // Frontier Claude models (Opus 4.7+, Sonnet 5+, Fable) reject `temperature`
    // with a 400; omit it there. Note the loss of sampling pinning (#254/#215).
    const _claudeTemp = claudeSupportsTemperature(model);
    if (!_claudeTemp) console.log(`  [claude] ${model}: temperature not pinnable on this model — sampling default, runs may vary`);

    const payload = JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(_claudeTemp ? { temperature } : {}),
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    // #223: air-gapped blocks a remote cloud LLM (a loopback endpoint is OK).
    // Hostname-parsed, not substring-matched — see isLocalApiUrl.
    const isLocal = isLocalApiUrl(apiUrl);
    if (!isLocal && isAirGapped()) {
      console.error('[air-gapped] blocked: GUI cloud LLM (claim-search/analyze)');
      return { error: '--air-gapped: cloud LLM is blocked. Set the engine to Local in the Workspace pane (LLM controls), or restart without --air-gapped to allow cloud calls (your data would leave this machine).' };
    }
    if (!isLocal) {
      console.log(`  [LLM] Claude API -> ${apiUrl} (model: ${model})`);
    }

    try {
      const body = await _serverHttpPost(apiUrl, payload, {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      });

      const usage = body.usage || {};
      const inTok = usage.input_tokens || 0;
      const outTok = usage.output_tokens || 0;
      let costStr = '';
      if (!isLocal && inTok && outTok) {
        // Shared pricing helper (src/core/pricing.js) — was hardcoded to Sonnet's
        // $3/$15 per 1M regardless of model, under-reporting ~40% on Opus.
        const { usd } = estimateCost(model, usage);
        costStr = `, est. $${usd.toFixed(4)}`;
      }
      console.log(`  [LLM] OK: ${model} (${inTok} in / ${outTok} out tokens${costStr})`);

      const content = body.content || [];
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text) return { error: 'LLM returned empty response' };

      return { text, usage: { input_tokens: inTok, output_tokens: outTok, model } };
    } catch (e) {
      return { error: `Claude API error: ${e.message || e}` };
    }
  }

  // --- OpenAI / ChatGPT API (#243 Part B): system + user message structure ---

  async callOpenAI(systemPrompt, userMessage, opts = {}) {
    // #246: label + defaults come from opts for a non-OpenAI compat provider
    // (Gemini); plain OpenAI keeps its own defaults.
    const label = opts._providerLabel || 'OpenAI';
    const apiKey = opts.apiKey || this.defaultOpenAIKey;
    if (!apiKey) {
      return { error: `No ${label} API key configured.` };
    }
    const apiUrl = opts.apiUrl || process.env.CE_OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
    const model = opts.model || this.defaultOpenAIModel;
    const maxTokens = opts.maxTokens || 2048;

    // Same cloud guard as the Claude branch (#223) — hostname-parsed, fail-closed.
    const isLocal = isLocalApiUrl(apiUrl);
    if (!isLocal && isAirGapped()) {
      console.error(`[air-gapped] blocked: GUI cloud LLM (${label})`);
      return { error: '--air-gapped: cloud LLM is blocked. Set the engine to Local in the Workspace pane (LLM controls), or restart without --air-gapped to allow cloud calls (your data would leave this machine).' };
    }
    if (!isLocal) {
      const tnote = openaiSupportsTemperature(model) ? '' : ' [temperature not pinnable on this model — sampling default, runs may vary]';
      console.log(`  [LLM] ${label} API -> ${apiUrl} (model: ${model})${tnote}`);
    }

    const payload = JSON.stringify({
      model,
      // Reasoning models (gpt-5*, o*) count hidden reasoning tokens against this
      // cap; floor it so a Claude-tuned maxTokens isn't consumed entirely by
      // reasoning, leaving no room for the answer (openai-util).
      max_completion_tokens: openaiCompletionBudget(model, maxTokens),
      // gpt-5 / o-series reject a non-default temperature; only the gpt-4 family
      // accepts an explicit value (0 for parity with Claude).
      ...(openaiSupportsTemperature(model) ? { temperature: opts.temperature ?? 0.0 } : {}),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    try {
      const body = await _serverHttpPost(apiUrl, payload, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      });
      const usage = openaiUsage(body.usage);
      let costStr = '';
      if (!isLocal && usage.input_tokens && usage.output_tokens) {
        const { usd } = estimateCost(model, usage);
        costStr = `, est. $${usd.toFixed(4)}`;
      }
      console.log(`  [LLM] OK: ${model} (${usage.input_tokens} in / ${usage.output_tokens} out tokens${costStr})`);
      const text = String((body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '').trim();
      if (!text) {
        // Reasoning models can spend the whole budget on hidden reasoning and
        // return empty content with finish_reason 'length' — name the cause
        // instead of a bare "empty response" (#243B).
        if (openaiFinishReason(body) === 'length') {
          return { error: 'OpenAI returned no text — the token budget was exhausted (likely by reasoning tokens). Use a larger budget or a non-reasoning model.' };
        }
        return { error: 'LLM returned empty response' };
      }
      return { text, usage: { ...usage, model } };
    } catch (e) {
      return { error: `OpenAI API error: ${e.message || e}` };
    }
  }

  // --- Local GGUF model: lazy-load, persistent ---

  async ensureLocalModel(modelPath) {
    const mp = modelPath || this.defaultModelPath;
    if (!mp) return { error: 'No local model configured — pick a GGUF via the Workspace pane’s Engine selector (Browse GGUFs), or start the server with --model-path <path-to-gguf>.' };

    // Already loaded with same path?
    if (this._localModel && this._localModel.modelPath === mp) return { ok: true };

    // Currently loading?
    if (this._localLoading) {
      await this._localLoading;
      if (this._localModel) return { ok: true };
      return { error: 'Local model failed to load.' };
    }

    // Load
    this._localLoading = this._loadLocalModel(mp);
    const result = await this._localLoading;
    this._localLoading = null;
    return result;
  }

  async _loadLocalModel(mp) {
    if (!fs.existsSync(mp)) {
      return { error: `Model file not found: ${mp}` };
    }
    try {
      const { LlamaChatSession, defineChatSessionFunction } = await import('node-llama-cpp');
      console.log(`  [LLM] Loading local model: ${mp}...`);
      // The process's one engine instance (shared with the late-init touch in
      // index.js): a second getLlama() silences the logger, upstream #684.
      const llama = await getLlamaShared();
      const model = await llama.loadModel({ modelPath: mp });

      // Context ladder: try big, fall back on allocation failure.
      // --context-size prepends a user-chosen first rung — agentic multi-tool
      // investigations want 16k+ when VRAM allows (a 27B Q4 + 24k context
      // measured 17.9 GB on a 24 GB card; see docs/cloud-gpu-chat-testing.md).
      // The smaller rungs still protect modest hardware from OOM.
      // #330: lead the ladder with 16384 to match the CLI's --overview-by-ai
      // ladder (index.js) — the GUI used to default to 8192, handing the same
      // model half the context purely by launch path (the remaining half of the
      // #306 F67 GUI/CLI divergence). Fall-through still protects small cards.
      const ladder = this.preferredContextSize
        ? [this.preferredContextSize, ...[16384, 8192, 4096, 2048].filter(s => s < this.preferredContextSize)]
        : [16384, 8192, 4096, 2048];
      let context = null;
      let contextSize = 0;
      for (const trySize of ladder) {
        // #306 F67: the THIRD createContext site. Batch 1 threaded the flag to
        // the other two and the commit message claimed "both", so the GUI path
        // silently fell to 8192 on a model that needs flash attention to fit
        // 16384 — a comparability defect as well as a capability one, since the
        // same model then runs at a different context on GUI vs CLI.
        try { context = await model.createContext(ggufContextOptions(trySize, this.flashAttention)); contextSize = trySize; break; }
        catch (_) { /* try smaller */ }
      }
      if (!context) {
        // #248: free the just-loaded weights so a failed context allocation
        // (e.g. switching models on a memory-constrained box) doesn't leak the
        // whole model and wedge subsequent loads.
        try { model.dispose(); } catch (_) {}
        return { error: `Cannot allocate context for local model (tried ${ladder.join('/')}).` };
      }

      this._localModel = { llama, model, context, LlamaChatSession, defineChatSessionFunction, contextSize, modelPath: mp };
      // Say whether flash attention was on, the way the two CLI paths already do.
      // F67 test B could only be scored by inferring it from the achieved context,
      // which cannot distinguish "flag dropped" from "flag applied and 16384 still
      // did not fit" — two different bugs with the same symptom.
      console.log(`  [LLM] OK: Local model loaded (context: ${contextSize} tokens`
        + `${this.flashAttention ? ', flash attention' : ''})`);
      return { ok: true };
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find/.test(e.message)) {
        return { error: 'node-llama-cpp not installed. Run: npm install node-llama-cpp' };
      }
      if (isNoBinaryError(e)) {
        // #231: installed, but no llama.cpp binary loads and CodeExam will not
        // download or build one at run time.
        return { error: `${NO_BINARY_MESSAGE} (${e.message})` };
      }
      console.error(`  [LLM] Failed to load model: ${mp}`);
      console.error(`  [LLM] Error:`, e);
      return { error: `Failed to load local model: ${e.message}` };
    }
  }

  // One chat sequence per loaded model, cached on _localModel and reused across
  // ALL local calls (chat, overview, analyze, claim). Contexts are created with a
  // single sequence, and sequence.dispose() is a silent no-op for some families
  // (Gemma 3, upstream #623) that permanently consumes the slot — so acquire-
  // once-reuse is the only pattern that survives. clearHistory() resets it
  // between uses. Never disposed. Callers MUST hold withLocalLock. #248
  async acquireSharedSequence() {
    const lm = this._localModel;
    if (lm.chatSequence) {
      if (lm.chatSequence.clearHistory) await lm.chatSequence.clearHistory();
      return lm.chatSequence;
    }
    lm.chatSequence = lm.context.getSequence();
    return lm.chatSequence;
  }

  async callLocal(systemPrompt, userMessage, opts = {}) {
    const mp = opts.modelPath || this.defaultModelPath;
    const loadResult = await this.ensureLocalModel(mp);
    if (loadResult.error) return loadResult;

    const maxTokens = opts.maxTokens || 2048;
    const temperature = opts.temperature ?? 0.0;
    const combinedPrompt = systemPrompt + '\n\n' + userMessage;

    // #248: reuse the shared cached sequence (never a fresh getSequence, which
    // throws "No sequences left" once a chat has claimed the slot) and serialize
    // against chat/overview so they don't clobber each other's history.
    return withLocalLock(async () => {
      let session;
      try {
        const { LlamaChatSession } = this._localModel;
        const sequence = await this.acquireSharedSequence();
        session = new LlamaChatSession(await chatSessionOptions(sequence));
        console.log(`  [LLM] Sending to local model (${combinedPrompt.length} chars)...`);
        const response = await session.prompt(combinedPrompt, { maxTokens, temperature });
        console.log(`  [LLM] Local model response: ${response.length} chars`);
        return { text: response.trim() };
      } catch (e) {
        return { error: `Local model error: ${e.message || e}` };
      } finally {
        if (session) { try { session.dispose(); } catch (_) {} }
      }
    });
  }

  // --- Unified dispatch ---

  async call(engine, systemPrompt, userMessage, opts = {}) {
    if (engine === 'claude') {
      return this.callClaude(systemPrompt, userMessage, opts);
    } else if (engine === 'openai' || engine === 'gemini') {
      // #246: both are openai-compat. Gemini reuses callOpenAI with the
      // provider's endpoint/key/model injected via opts.
      return this.callOpenAI(systemPrompt, userMessage, this._compatOpts(engine, opts));
    } else {
      return this.callLocal(systemPrompt, userMessage, opts);
    }
  }

  /** #246: opts for an openai-compat provider — inject Gemini's endpoint/key/
   *  model; OpenAI keeps callOpenAI's own defaults. */
  _compatOpts(engine, opts) {
    if (engine !== 'gemini') return opts;
    const p = PROVIDERS.gemini;
    return {
      ...opts,
      apiUrl: opts.apiUrl || process.env.CE_OPENAI_API_URL || `${p.baseUrl}/chat/completions`,
      apiKey: opts.apiKey || this.defaultGeminiKey,
      model: opts.model || this.defaultGeminiModel,
      _providerLabel: p.label,
    };
  }

  /** Check if the requested engine is available without actually calling it. */
  checkAvailability(engine) {
    // Cloud engines are honestly unavailable under --air-gapped (keys are
    // never resolved then), with a reason that names the cause rather than
    // a misleading "no key configured".
    if ((engine === 'claude' || engine === 'openai' || engine === 'gemini') && isAirGapped()) {
      return { available: false, reason: 'Blocked by --air-gapped: cloud AI calls are disabled this run. Use the Local GGUF engine.' };
    }
    if (engine === 'claude') {
      if (!this.defaultApiKey) return { available: false, reason: 'No API key configured.' };
      return { available: true };
    } else if (engine === 'openai') {
      if (!this.defaultOpenAIKey) return { available: false, reason: 'No OpenAI API key configured. Set OPENAI_API_KEY, create openai.txt, or pass --openai-key.' };
      return { available: true };
    } else if (engine === 'gemini') {
      if (!this.defaultGeminiKey) return { available: false, reason: 'No Gemini API key configured. Set GEMINI_API_KEY, create gemini.txt, or pass --gemini-key.' };
      return { available: true };
    } else {
      if (!this.defaultModelPath) return { available: false, reason: 'No local model configured — pick a GGUF via the Workspace pane’s Engine selector (Browse GGUFs), or start the server with --model-path <path-to-gguf>.' };
      return { available: true };
    }
  }
}

// OpenAI provider-shape helpers (temperature support, reasoning-token budget,
// usage normalization, finish_reason) live in core/openai-util.js so the CLI,
// GUI, and overview surfaces share one implementation.

/** Simple HTTP/HTTPS POST for server-side LLM calls. */
function _serverHttpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,   // 2 min for slow models
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (120s)')); });
    req.write(body);
    req.end();
  });
}

const serverLLM = new ServerLLM({
  modelPath: serverArgs.modelPath,
  apiKey: serverArgs.apiKey,
  claudeModel: serverArgs.claudeModel,   // --claude-model: was parsed but dropped here, so chat/analyze always fell back to the hardcoded default
  contextSize: serverArgs.contextSize,
  flashAttention: serverArgs.flashAttention,
  reproducible: serverArgs.reproducible,
  openaiKey: serverArgs.openaiKey,
  openaiModel: serverArgs.openaiModel,
  geminiKey: serverArgs.geminiKey,      // #246
  geminiModel: serverArgs.geminiModel,
});
if (serverArgs.reproducible) {
  console.log('  Local LLM sampling: REPRODUCIBLE (temperature 0, fixed seed) — scoped to this machine/model/config; verify per protocol');
}


// ========================================================================
// Static file serving
// ========================================================================

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}


// ========================================================================
// API helpers
// ========================================================================

function parseQuery(url) {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return {};
  const params = {};
  for (const pair of url.slice(qIdx + 1).split('&')) {
    const [k, v] = pair.split('=').map(decodeURIComponent);
    params[k] = v;
  }
  return params;
}

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function errorResponse(res, message, status = 400) {
  jsonResponse(res, { error: message }, status);
}

// parseFuncSpec (file@funcName splitting, scoped-package- and
// line-disambiguator-aware) moved to utils.js so the MCP tools and CLI
// commands share it (#252) — imported above.


// ========================================================================
// Helper: resolve @filepath references in text
// ========================================================================

// ========================================================================
// Path safety: reject reads of sensitive system files from web endpoints
// ========================================================================
//
// Only enforced when the server is bound to a non-localhost address
// (--host 0.0.0.0 or similar). On localhost (default), the user already
// has full filesystem access, so restrictions would just get in the way
// of legitimate use (e.g. building indexes of C:\Windows or /usr/lib).

// WSL: convert Windows paths (C:\foo) to /mnt/c/foo when running under Linux
const _isWSL = process.platform === 'linux' && fs.existsSync('/mnt/c');
function toNativePath(p) {
  if (_isWSL && /^[A-Za-z]:\\/.test(p)) {
    return '/mnt/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
  }
  return p;
}

const _SENSITIVE_PATHS = /^\/(etc|proc|sys|dev|var\/log|var\/run|boot|root)\b/;
const _SENSITIVE_WIN = /^[a-z]:\\(windows|program files|programdata|users\\[^\\]+\\appdata)/i;
const _KEY_EXTENSIONS = /\.(pem|key|pfx|p12|jks|keystore|id_rsa|id_ed25519)$/i;

/**
 * Check if a file path is safe to read from a web endpoint.
 * Only enforced when server is network-exposed (non-localhost host).
 * Returns { safe, reason }.
 */
function validateFilePath(filePath) {
  // On localhost, allow everything — user already has shell access
  if (_LOCALHOST.test(serverArgs.host)) {
    return { safe: true };
  }
  if (!filePath || typeof filePath !== 'string') {
    return { safe: false, reason: 'Empty path' };
  }
  const resolved = path.resolve(filePath);
  if (_SENSITIVE_PATHS.test(resolved)) {
    return { safe: false, reason: 'Access to system directory blocked (server is network-exposed)' };
  }
  if (_SENSITIVE_WIN.test(resolved)) {
    return { safe: false, reason: 'Access to system directory blocked (server is network-exposed)' };
  }
  if (_KEY_EXTENSIONS.test(resolved)) {
    return { safe: false, reason: 'Access to key/certificate files blocked (server is network-exposed)' };
  }
  return { safe: true };
}


/**
 * If text starts with @, treat the rest as a file path to read.
 * Returns { text, resolvedFrom } where resolvedFrom is the filepath if resolved.
 */
function resolveAtFile(text) {
  if (!text) return { text: text || '', resolvedFrom: null };
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  const firstLine = lines[0].trim();
  if (firstLine.startsWith('@') && firstLine.length > 1) {
    const filePath = firstLine.slice(1).trim();
    const pathCheck = validateFilePath(filePath);
    if (!pathCheck.safe) {
      return { text: trimmed, resolvedFrom: null, error: pathCheck.reason };
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // If there are lines after the @path, append them as additional context
      const extra = lines.slice(1).join('\n').trim();
      const fullText = extra ? content.trim() + '\n\n' + extra : content.trim();
      return { text: fullText, resolvedFrom: filePath };
    } catch (e) {
      return { text: trimmed, resolvedFrom: null, error: `Cannot read file: ${filePath} (${e.message})` };
    }
  }
  return { text: trimmed, resolvedFrom: null };
}


// ========================================================================
// API routes
// ========================================================================

const routes = {};

// --- Index management ---

routes['/api/indexes'] = (req, res) => {
  jsonResponse(res, { indexes: mgr.list() });
};

// --- Resolve @filepath to file content ---
routes['/api/resolve-file'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 100_000) req.destroy(); });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const filePath = toNativePath(params.path || '');
      if (!filePath) return errorResponse(res, 'Missing "path" parameter');
      const pathCheck = validateFilePath(filePath);
      if (!pathCheck.safe) return errorResponse(res, pathCheck.reason, 403);
      const content = fs.readFileSync(filePath, 'utf-8');
      jsonResponse(res, { path: filePath, content, chars: content.length });
    } catch (err) {
      errorResponse(res, `Cannot read file: ${err.message}`, 400);
    }
  });
};

// --- Scan for available indexes ---
routes['/api/scan-indexes'] = (req, res) => {
  const q = parseQuery(req.url);
  const scanDir = path.resolve(toNativePath(q.dir || '') || process.cwd());
  const pathCheck = validateFilePath(scanDir);
  if (!pathCheck.safe) return errorResponse(res, pathCheck.reason, 403);
  const available = [];
  try {
    for (const entry of fs.readdirSync(scanDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const litIdx = path.join(scanDir, entry.name, 'literal_index.json');
        if (fs.existsSync(litIdx)) {
          // Quick stats: file count from function_index.json or literal_index.json
          let fileCount = 0;
          try {
            const funcIdx = path.join(scanDir, entry.name, 'function_index.json');
            if (fs.existsSync(funcIdx)) {
              const raw = fs.readFileSync(funcIdx, 'utf-8');
              const parsed = JSON.parse(raw);
              // function_index.json uses filenames as top-level keys
              fileCount = Object.keys(parsed).length;
            } else {
              // Fallback: count "files" keys in literal_index
              const raw = fs.readFileSync(litIdx, 'utf-8');
              const parsed = JSON.parse(raw);
              fileCount = Object.keys(parsed.files || {}).length;
            }
          } catch (_) {}
          const fullPath = path.join(scanDir, entry.name);
          const isLoaded = [...mgr.indexes.keys()].some(k => {
            const loadedPath = mgr.indexes.get(k)?.indexPath || '';
            return loadedPath === fullPath || k === entry.name;
          });
          // Validate index completeness
          const invIdx = path.join(scanDir, entry.name, 'inverted_index.json');
          const funcIdx2 = path.join(scanDir, entry.name, 'function_index.json');
          const missing = [];
          if (!fs.existsSync(invIdx))  missing.push('inverted_index.json');
          if (!fs.existsSync(funcIdx2)) missing.push('function_index.json');
          const info = { name: entry.name, path: fullPath, files: fileCount, loaded: isLoaded };
          if (missing.length > 0) info.missing = missing;
          available.push(info);
        }
      }
    }
  } catch (_) {}
  jsonResponse(res, { available, loaded: mgr.list(), scanDir });
};


// --- LLM engine status (for GUI context-menu labels) ---
routes['/api/llm-status'] = async (req, res) => {
  const claudeAvail = serverLLM.checkAvailability('claude');
  const localAvail  = serverLLM.checkAvailability('local');
  const localName   = serverLLM.defaultModelPath
    ? path.basename(serverLLM.defaultModelPath)
    : null;
  // Best-effort hardware/context detail for the LOADED model, so the GUI can
  // answer "which model is running, on what?" (llm-status-display). Absent
  // fields render as absent client-side; failures never block the response.
  const detail = { modelFile: localName, contextSize: null, backend: null, vramUsedMB: null, vramTotalMB: null };
  const lm = serverLLM._localModel;
  if (lm) {
    detail.contextSize = lm.contextSize || null;
    try { detail.backend = lm.llama && lm.llama.gpu ? String(lm.llama.gpu) : 'cpu'; } catch (_) { /* leave null */ }
    try {
      if (lm.llama && typeof lm.llama.getVramState === 'function') {
        const v = await lm.llama.getVramState();
        if (v && v.total) {
          detail.vramUsedMB = Math.round(v.used / 1048576);
          detail.vramTotalMB = Math.round(v.total / 1048576);
        }
      }
    } catch (_) { /* leave null */ }
  }
  const openaiAvail = serverLLM.checkAvailability('openai');
  const geminiAvail = serverLLM.checkAvailability('gemini');   // #246
  jsonResponse(res, {
    claude: { available: claudeAvail.available, name: 'Claude API' },
    openai: { available: openaiAvail.available, name: `ChatGPT API (${serverLLM.defaultOpenAIModel})` },
    gemini: { available: geminiAvail.available, name: `Gemini API (${serverLLM.defaultGeminiModel})` },
    local:  { available: localAvail.available,  name: localName ? `Local: ${localName}` : 'Local GGUF Model', detail },
    // #223: lets the client show "blocked by --air-gapped" for cloud engines
    // instead of a misleading "not configured / set a key" message.
    airGapped: isAirGapped(),
    // --llm at launch (#243 Part B): the engine the GUI controls should start
    // on. Client applies once so it doesn't override a manual switch.
    preferred: serverArgs.defaultEngine || null,
    // #265 "Simon Says": a cloud MODEL/KEY flag was given but no --llm to
    // actually select the cloud engine. Local-first means we do NOT flip the
    // engine for them — but we also must not silently ignore the flag. Surface
    // a one-time hint. An ambient ANTHROPIC_API_KEY is NOT intent (it's not a
    // serverArgs flag), so it never triggers this.
    configHint: _engineConfigHint(),
  });
};

/** Build the #265 engine-config hint, or null. Fires only when the user passed
 *  a cloud-pointing FLAG (--claude-model / --openai-model / --openai-key) but
 *  no --llm, so the local-first default stands and the flag would otherwise
 *  look ignored. */
function _engineConfigHint() {
  if (serverArgs.defaultEngine) return null;   // --llm given → engine chosen, no ambiguity
  if (serverArgs.claudeModel) {
    return `You set a Claude model (--claude-model ${serverArgs.claudeModel}) but no engine (--llm). ` +
      `Chat and Workspace default to Local GGUF — pick Engine: Claude API to use Claude, or restart with --llm claude.`;
  }
  if (serverArgs.openaiModel || serverArgs.openaiKey) {
    const what = serverArgs.openaiModel ? `a ChatGPT model (--openai-model ${serverArgs.openaiModel})` : 'a ChatGPT key (--openai-key)';
    return `You set ${what} but no engine (--llm). ` +
      `Chat and Workspace default to Local GGUF — pick Engine: ChatGPT API to use it, or restart with --llm openai.`;
  }
  if (serverArgs.geminiModel || serverArgs.geminiKey) {
    const what = serverArgs.geminiModel ? `a Gemini model (--gemini-model ${serverArgs.geminiModel})` : 'a Gemini key (--gemini-key)';
    return `You set ${what} but no engine (--llm). ` +
      `Chat and Workspace default to Local GGUF — pick Engine: Gemini API to use it, or restart with --llm gemini.`;
  }
  return null;
}


// --- Scan for available GGUF models ---
routes['/api/scan-models'] = (req, res) => {
  const q = parseQuery(req.url);
  const defaultDir = serverLLM.defaultModelPath
    ? path.dirname(serverLLM.defaultModelPath)
    : process.cwd();
  const scanDir = path.resolve(toNativePath(q.dir || '') || defaultDir);
  const pathCheck = validateFilePath(scanDir);
  if (!pathCheck.safe) return errorResponse(res, pathCheck.reason, 403);
  const models = [];
  try {
    for (const entry of fs.readdirSync(scanDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.gguf')) {
        const fullPath = path.join(scanDir, entry.name);
        let size = 0;
        try { size = fs.statSync(fullPath).size; } catch (_) {}
        const loaded = serverLLM.defaultModelPath === fullPath;
        models.push({ name: entry.name, path: fullPath, size, loaded });
      }
    }
    // Also check one level of subdirectories
    for (const entry of fs.readdirSync(scanDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        try {
          for (const sub of fs.readdirSync(path.join(scanDir, entry.name), { withFileTypes: true })) {
            if (sub.isFile() && sub.name.toLowerCase().endsWith('.gguf')) {
              const fullPath = path.join(scanDir, entry.name, sub.name);
              let size = 0;
              try { size = fs.statSync(fullPath).size; } catch (_) {}
              const loaded = serverLLM.defaultModelPath === fullPath;
              models.push({ name: entry.name + '/' + sub.name, path: fullPath, size, loaded });
            }
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  models.sort((a, b) => a.name.localeCompare(b.name));
  jsonResponse(res, { models, scanDir, currentModel: serverLLM.defaultModelPath || null });
};


// --- Switch GGUF model at runtime ---
routes['/api/switch-model'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 10_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const params = JSON.parse(body);
      const modelPath = params.path;
      if (!modelPath) return errorResponse(res, 'Missing "path" parameter');
      if (!fs.existsSync(modelPath)) return errorResponse(res, `File not found: ${modelPath}`, 404);
      console.log(`  [switch-model] Switching to: ${modelPath}`);
      // #248: tear down under the local lock so no chat/overview/analyze is mid-
      // generation on the sequence we're about to drop. And do NOT dispose a
      // context whose cached sequence was never released — for some families
      // (Gemma 3, upstream #623) that dispose deadlocks native teardown and hangs
      // the process. Drop the references instead (the old model's native memory is
      // reclaimed at process exit); only dispose when no sequence was cached (safe).
      const loadResult = await withLocalLock(async () => {
        const old = serverLLM._localModel;
        const prevModelPath = serverLLM.defaultModelPath;
        if (old) {
          try {
            if (!old.chatSequence && old.context) old.context.dispose();
            if (!old.chatSequence && old.model) old.model.dispose();
          } catch (_) {}
          serverLLM._localModel = null;
        }
        serverLLM.defaultModelPath = modelPath;
        // Eagerly load the new model so we can report errors immediately.
        const r = await serverLLM.ensureLocalModel(modelPath);
        // #248/#623: when the old model's context couldn't be disposed (cached
        // sequence) its memory stays resident, so on a constrained box the new
        // model may fail to allocate. Rather than wedge the server with no model
        // loaded, restore the still-resident old one and tell the user to restart.
        if (r.error && old && old.chatSequence) {
          serverLLM._localModel = old;
          serverLLM.defaultModelPath = prevModelPath;
          return { error: `Could not load "${path.basename(modelPath)}" while "${path.basename(prevModelPath || '')}" is still resident — its memory can't be freed in-process (upstream node-llama-cpp #623). Kept the current model; restart CodeExam with --model-path to switch cleanly.` };
        }
        return r;
      });
      if (loadResult.error) return errorResponse(res, loadResult.error, 500);
      jsonResponse(res, { ok: true, model: modelPath });
    } catch (err) {
      errorResponse(res, `Switch model error: ${err.message}`, 500);
    }
  });
};


routes['/api/browse-dir'] = (req, res) => {
  const q = parseQuery(req.url);
  const dirPath = path.resolve(toNativePath(q.path || '') || process.cwd());
  const pathCheck = validateFilePath(dirPath);
  if (!pathCheck.safe) return errorResponse(res, pathCheck.reason, 403);

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
    return errorResponse(res, `Cannot read directory: ${err.message}`, code);
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dirPath, entry.name);
    let isIndex = false;
    try { isIndex = fs.existsSync(path.join(fullPath, 'literal_index.json')); } catch (_) {}
    const info = { name: entry.name, isIndex };
    if (isIndex) {
      const missing = [];
      if (!fs.existsSync(path.join(fullPath, 'inverted_index.json')))  missing.push('inverted_index.json');
      if (!fs.existsSync(path.join(fullPath, 'function_index.json'))) missing.push('function_index.json');
      if (missing.length > 0) info.missing = missing;
    }
    dirs.push(info);
  }

  // Sort: index dirs first, then alphabetical (case-insensitive)
  dirs.sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  // #176: also surface .zip files so a zipped index can be picked from Browse.
  const zips = [];
  for (const entry of entries) {
    if (entry.isFile() && /\.zip$/i.test(entry.name)) zips.push({ name: entry.name });
  }
  zips.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const parent = path.dirname(dirPath);
  jsonResponse(res, { current: dirPath, parent: parent !== dirPath ? parent : null, sep: path.sep, dirs, zips });
};

routes['/api/stats'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const stats = index.getStats();
  const funcCount = index.listFunctions().length;
  jsonResponse(res, { ...stats, function_count: funcCount, index_path: index.indexPath, base_path: index.basePath });
};


// --- File / function listing ---

routes['/api/list-files'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let files = index.listFiles();
  if (q.filter) { const match = makeFilterMatcher(q.filter); files = files.filter(f => match(f)); }
  const max = safeMax(q.max, 200);
  jsonResponse(res, { total: files.length, files: files.slice(0, max) });
};

routes['/api/list-functions'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let funcs = index.listFunctions();
  if (q.filter) { const match = makeFilterMatcher(q.filter); funcs = funcs.filter(f => match(f.name, index.getDisplayName(f.name), f.filepath)); }
  const sort = q.sort || 'lines';
  if (sort === 'lines') funcs.sort((a, b) => b.lines - a.lines);
  else if (sort === 'alpha') funcs.sort((a, b) => a.name.localeCompare(b.name));
  const max = safeMax(q.max, 200);
  jsonResponse(res, {
    total: funcs.length,
    functions: funcs.slice(0, max).map(f => ({
      name: index.getDisplayName(f.name), display_name: index.getDisplayName(f.displayName || f.name), filepath: f.filepath,
      lines: f.lines, start: f.start, end: f.end, type: f.type,
    })),
  });
};

routes['/api/file-functions'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const filepath = q.path;
  if (!filepath) return errorResponse(res, 'Missing ?path= parameter');
  let funcs = index.listFunctions(filepath);
  funcs.sort((a, b) => a.start - b.start);
  jsonResponse(res, {
    filepath, total: funcs.length,
    functions: funcs.map(f => ({
      name: index.getDisplayName(f.name), display_name: index.getDisplayName(f.displayName || f.name), filepath: f.filepath,
      lines: f.lines, start: f.start, end: f.end, type: f.type,
    })),
  });
};


// --- Extract function source ---

// Build a Set of display-name strings for all functions in the index.
// Used by /api/extract-linkified and /api/function-names to decide which
// identifiers correspond to known functions (i.e. linkable call sites).
// Cached per index instance — the set only changes when an index is
// (re)loaded, which replaces the instance and lets the WeakMap entry drop.
// #275: names of the JS intrinsic prototype/static members (Array.prototype
// .map, Map.prototype.get, console.log, …), enumerated from the runtime
// rather than hand-listed, plus a few cross-language container generics
// (Python list/dict methods). A corpus function or method sharing one of
// these names would turn every `.map(` / `.get(` / `.log(` in the source
// pane blue, so intrinsic-named entries are excluded from the linkify gate
// set entirely — the function itself stays reachable via the function
// lists, digests, and search.
// The intrinsic-name set was relocated to core/vocabulary.js (exported as
// INTRINSIC_NAMES, #276 U1) and imported above, so the linkify gate and Most
// Called filtering share one definition.

const _knownNameSetCache = new WeakMap();
function _buildKnownNameSet(index) {
  let known = _knownNameSetCache.get(index);
  if (known) return known;
  known = new Set();
  for (const fn of index.listFunctions()) {
    const display = index.getDisplayName(fn.name);
    if (!INTRINSIC_NAMES.has(display)) known.add(display);
    // #275: methods are indexed under qualified names
    // (CodeSearchIndex::buildFunctionIndexTreeSitter) but appear BARE at
    // their definition and call sites in source text — add the bare last
    // segment too (minus any @-disambiguator), or the gate never matches
    // them. Bare-name clicks resolve via findFunctionMatches' existing
    // endsWith('::name') path, with same-file auto-disambiguation.
    const bare = String(display).split('::').pop().split('@')[0];
    if (bare && bare !== display && !INTRINSIC_NAMES.has(bare)) known.add(bare);
  }
  _knownNameSetCache.set(index, known);
  return known;
}

// --- Known function names (#275) ---
//
// The loaded index's full display-name set, fetched once per index by the
// GUI source viewer to gate linkification on names that actually resolve
// (and to link non-call references like import bindings). Above the cap we
// return capped:true with no names — the client then falls back to the
// legacy shape-only linkification rather than shipping a multi-MB payload.
routes['/api/function-names'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const CAP = 50000;
  const known = _buildKnownNameSet(index);
  if (known.size > CAP) return jsonResponse(res, { total: known.size, capped: true, names: [] });
  jsonResponse(res, { total: known.size, capped: false, names: [...known] });
};

routes['/api/extract'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const funcSpec = q.func;
  if (!funcSpec) return errorResponse(res, 'Missing ?func= parameter');
  const { funcName: rawFuncName, fileHint } = parseFuncSpec(funcSpec);
  const funcName = index.getOriginalName(rawFuncName);
  const matches = index.findFunctionMatches(funcName, fileHint);
  if (matches.length === 0) return errorResponse(res, `Function '${rawFuncName}' not found`, 404);
  if (matches.length > 1 && !fileHint) {
    // Deprioritize TypeScript type-declaration stubs (.d.ts): they contain
    // only signatures, so landing on one when a real implementation exists
    // elsewhere in the index is never useful. Sorted to the end of the
    // returned matches so both the auto-disambiguate path (picks matches[0]
    // or same-file) and the Disambiguation UI list show the real impl first.
    const sorted = matches.slice().sort((a, b) => {
      const aIsDts = a.filepath.endsWith('.d.ts');
      const bIsDts = b.filepath.endsWith('.d.ts');
      if (aIsDts !== bIsDts) return aIsDts ? 1 : -1;
      return 0;
    });
    return jsonResponse(res, {
      ambiguous: true,
      matches: sorted.map(m => ({ filepath: m.filepath, name: m.name, display_name: displayName(m.name, m.filepath), start: m.start, end: m.end, lines: m.end - m.start + 1 })),
    });
  }
  const m = matches[0];
  // #343: number from the range the SOURCE actually covers, not from m.start.
  // getFunctionSourceWithRange prepends the preceding doc comment and reports the
  // true first line of the returned text in `.start`; m.start is the signature
  // line, so numbering from it labels every displayed line too high by the length
  // of the function's own doc comment. `start` stays m.start for the info panel
  // (the symbol's own location); `start_line` is the numbering anchor.
  const got = index.getFunctionSourceWithRange?.(m.filepath, m.name);
  const source = got ? got.source : index.getFunctionSource(m.filepath, m.name);
  const srcStart = got ? got.start : m.start;
  jsonResponse(res, {
    filepath: m.filepath, name: index.getDisplayName(m.name), display_name: displayName(index.getDisplayName(m.name), m.filepath),
    start: m.start, end: m.end, lines: m.end - m.start + 1,
    start_line: srcStart,
    type: m.type,  // #198: lets the info panel label a class "Class Info:" vs "Function Info:"
    source: index.applyRenames(source || '(source not available)'), language: guessLanguage(m.filepath),
  });
};


// --- Extract function source as linkified segments ---
//
// Same as /api/extract, but returns source as a per-line array of segments
// where each call-site identifier (an identifier followed by `(`) that
// resolves to a known function in the index is flagged with isCall:true and
// a spec string suitable for a follow-up /api/extract[-linkified] call.
// Used by the xmlui prototype for click-to-navigate between functions.

routes['/api/extract-linkified'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const funcSpec = q.func;
  if (!funcSpec) return errorResponse(res, 'Missing ?func= parameter');
  const { funcName: rawFuncName, fileHint } = parseFuncSpec(funcSpec);
  const funcName = index.getOriginalName(rawFuncName);
  const matches = index.findFunctionMatches(funcName, fileHint);
  if (matches.length === 0) return errorResponse(res, `Function '${rawFuncName}' not found`, 404);
  if (matches.length > 1 && !fileHint) {
    const sorted = matches.slice().sort((a, b) => {
      const aIsDts = a.filepath.endsWith('.d.ts');
      const bIsDts = b.filepath.endsWith('.d.ts');
      if (aIsDts !== bIsDts) return aIsDts ? 1 : -1;
      return 0;
    });
    return jsonResponse(res, {
      ambiguous: true,
      matches: sorted.map(m => ({
        filepath: m.filepath, name: m.name,
        display_name: displayName(m.name, m.filepath),
        start: m.start, end: m.end, lines: m.end - m.start + 1,
      })),
    });
  }
  const m = matches[0];
  // #343: use the range's true start for line numbering (see /api/extract).
  const gotRange = index.getFunctionSourceWithRange?.(m.filepath, m.name);
  const rawSource = (gotRange ? gotRange.source : index.getFunctionSource(m.filepath, m.name)) || '(source not available)';
  const srcStart = gotRange ? gotRange.start : m.start;
  const renamedSource = index.applyRenames(rawSource);
  const knownNames = _buildKnownNameSet(index);
  const selfDisplay = index.getDisplayName(m.name);

  // Split into lines and linkify per-line. A call site is a bare identifier
  // followed (optionally by whitespace) by an open paren. Only emit an isCall
  // segment when the identifier resolves to a function in the index — this
  // filters out keywords (if, for, while …), local variables, and noise.
  const sourceLines = renamedSource.split('\n');
  const outLines = sourceLines.map(line => {
    const segments = [];
    const CALL_RE = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let lastEnd = 0;
    let mm;
    while ((mm = CALL_RE.exec(line)) !== null) {
      const name = mm[1];
      const nameStart = mm.index;
      if (!knownNames.has(name)) continue;
      // Don't linkify the function's own name at the declaration site —
      // clicking it would re-navigate to the same function.
      if (name === selfDisplay) continue;
      if (nameStart > lastEnd) segments.push({ text: line.slice(lastEnd, nameStart) });
      segments.push({ text: name, isCall: true, spec: name });
      lastEnd = nameStart + name.length;
    }
    if (lastEnd < line.length) segments.push({ text: line.slice(lastEnd) });
    if (segments.length === 0) segments.push({ text: '' });
    return { segments };
  });

  jsonResponse(res, {
    filepath: m.filepath,
    name: selfDisplay,
    display_name: displayName(selfDisplay, m.filepath),
    start: m.start, end: m.end,
    line_count: m.end - m.start + 1,
    start_line: srcStart,
    lines: outLines,
    language: guessLanguage(m.filepath),
  });
};


// --- Show file contents ---

routes['/api/show-file'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const filePath = q.path;
  if (!filePath) return errorResponse(res, 'Missing ?path= parameter');
  const matches = index.findPathMatches(filePath);
  const exactFiles = matches.filter(m => index.files.has(m));
  if (exactFiles.length === 0) return errorResponse(res, `File '${filePath}' not found`, 404);
  const fp = exactFiles[0];
  const allLines = index.fileLines.get(fp) || [];
  const totalLines = allLines.length;

  // For large files, return a window around the requested line instead of the whole file
  const targetLine = parseInt(q.line) || 0;
  const maxLines = parseInt(q.max_lines) || 5000;
  let content;
  let startLine = 1;
  if (totalLines > maxLines && targetLine > 0) {
    const half = Math.floor(maxLines / 2);
    const from = Math.max(0, targetLine - half - 1);
    const to = Math.min(totalLines, from + maxLines);
    content = allLines.slice(from, to).join('\n');
    startLine = from + 1;
  } else if (totalLines > maxLines) {
    // No target line specified — return first chunk
    content = allLines.slice(0, maxLines).join('\n');
  } else {
    content = index.files.get(fp) || '';
  }
  jsonResponse(res, { filepath: fp, content: index.applyRenames(content), lines: totalLines, startLine, language: guessLanguage(fp) });
};


// --- Hotspots ---

routes['/api/hotspots'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 25;
  let hotspots = index.getHotspots(n * 3, true);
  if (q.filter) { const match = makeFilterMatcher(q.filter); hotspots = hotspots.filter(h => match(h.name, index.getDisplayName(h.name), h.filepath)); }
  jsonResponse(res, {
    hotspots: hotspots.slice(0, n).map((h, i) => ({
      rank: i + 1, name: index.getDisplayName(h.name), display_name: index.getDisplayName(h.display_name || h.name), filepath: h.filepath,
      lines: h.lines, calls: h.calls, score: Math.round(h.score * 10) / 10, type: h.type,
    })),
  });
};


// --- Hot Folders ---

routes['/api/hot-folders'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  const hotspots = index.getHotspots(50000, true);
  if (!hotspots.length) return jsonResponse(res, { folders: [] });

  const folderStats = {};
  for (const h of hotspots) {
    const fp = h.filepath.replace(/\\/g, '/');
    const parts = fp.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      if (!folderStats[folder]) folderStats[folder] = { score: 0, funcs: 0, files: new Set(), top_func: null, top_score: 0 };
      const s = folderStats[folder];
      s.score += h.score; s.funcs++; s.files.add(fp);
      if (h.score > s.top_score) { s.top_score = h.score; s.top_func = h.display_name || h.name; }
    }
  }

  const sorted = Object.entries(folderStats).sort((a, b) => b[1].score - a[1].score);
  const shownFolders = new Set();
  let filtered = [];
  for (const [folder, stats] of sorted) {
    const parts = folder.split('/');
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
    if (parent && shownFolders.has(parent)) {
      const ps = folderStats[parent];
      if (ps && Math.abs(ps.score - stats.score) < 1) continue;
    }
    filtered.push([folder, stats]);
    shownFolders.add(folder);
  }
  if (q.filter) { const match = makeFilterMatcher(q.filter); filtered = filtered.filter(([f]) => match(f)); }

  jsonResponse(res, {
    folders: filtered.slice(0, n).map(([folder, stats], i) => ({
      rank: i + 1, folder, score: Math.round(stats.score),
      funcs: stats.funcs, files: stats.files.size, top_func: stats.top_func || '',
    })),
  });
};


// --- Entry points ---

routes['/api/entry-points'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 25;
  const maxCalls = parseInt(q.max_calls) || 0;
  let entries = index.getEntryPoints(n * 3, maxCalls, true);
  if (q.filter) { const match = makeFilterMatcher(q.filter); entries = entries.filter(e => match(e.name, index.getDisplayName(e.name), e.filepath)); }
  jsonResponse(res, {
    entries: entries.slice(0, n).map((e, i) => ({
      rank: i + 1, name: index.getDisplayName(e.name), display_name: index.getDisplayName(e.display_name || e.name), filepath: e.filepath,
      lines: e.lines, calls: e.calls, type: e.type,
    })),
  });
};


// --- Gaps (dead code) ---

routes['/api/gaps'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  const entries = index.getEntryPoints(999, 0, true);

  const skipKw = new Set(['if','while','for','switch','catch','return','sizeof','typeof','void','int','char','Copyright','copyright']);
  const epPat = ['handle','render','componentdid','componentwill','useeffect','oncreate','ondestroy','onmount','onsubmit','onchange','onclick','oninit','onload','main','run','start','init','setup','configure','bootstrap','register','execute','test','spec','describe'];

  function isEntry(name, filepath) {
    const bare = name.includes('::') ? name.split('::').pop() : name;
    const lower = bare.toLowerCase();
    if (epPat.some(p => lower.startsWith(p))) return true;
    if (/^(get|set|is|has)[A-Z]/.test(bare)) return true;
    if (/test/i.test(filepath)) return true;
    return false;
  }

  let suspicious = [];
  for (const e of entries) {
    const bare = e.name.includes('::') ? e.name.split('::').pop() : e.name;
    if (bare.length < 2 || skipKw.has(bare)) continue;
    if (e.type === 'class') continue;
    if (isEntry(e.name, e.filepath)) continue;
    suspicious.push(e);
  }
  if (q.filter) { const match = makeFilterMatcher(q.filter); suspicious = suspicious.filter(s => match(s.name, index.getDisplayName(s.name), s.filepath)); }

  jsonResponse(res, {
    total: suspicious.length,
    gaps: suspicious.slice(0, n).map((s, i) => ({
      rank: i + 1, name: index.getDisplayName(s.name), display_name: index.getDisplayName(s.display_name || s.name),
      filepath: s.filepath, lines: s.lines,
    })),
  });
};


// --- Domain functions ---

routes['/api/domain-fns'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 25;
  let results = index.getDomainHotspots(n * 3, true);
  if (q.filter) { const match = makeFilterMatcher(q.filter); results = results.filter(r => match(r.name, index.getDisplayName(r.name), r.filepath)); }
  jsonResponse(res, {
    functions: results.slice(0, n).map((r, i) => ({
      rank: i + 1, name: index.getDisplayName(r.name), display_name: index.getDisplayName(r.display_name || r.name), filepath: r.filepath,
      lines: r.lines, calls: r.calls, score: Math.round(r.score * 10) / 10, type: r.type,
    })),
  });
};


// --- Most Called ---

routes['/api/most-called'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  const callData = index.getCallCountsWithDefinitions(true);

  const definedOnly = q.defined_only === '1' || q.defined_only === 'true';
  const matchMostCalled = q.filter ? makeFilterMatcher(q.filter) : null;
  let filtered = [];
  for (const item of callData) {
    if (item.name.length < 2) continue;
    const bare = item.name.includes('::') ? item.name.split('::').pop() : item.name;
    if (bare.length >= 2 && /^[A-Z][A-Z0-9_]+$/.test(bare)) continue;
    if (isIntrinsicName(bare)) continue; // #276 U1: drop built-ins
    if (definedOnly && item.definitions.length === 0) continue;
    if (matchMostCalled && !matchMostCalled(item.name, index.getDisplayName(item.name))) continue;
    filtered.push(item);
  }

  jsonResponse(res, {
    total: filtered.length,
    functions: filtered.slice(0, n).map((item, i) => ({
      rank: i + 1, name: index.getDisplayName(item.name), count: item.count,
      definitions: item.definitions.length,
      def_files: item.definitions.slice(0, 3).map(d => d.filepath),
    })),
  });
};


// --- Class Hotspots ---

routes['/api/class-hotspots'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  let results = index.getClassHotspots(n, true);
  if (q.filter) { const match = makeFilterMatcher(q.filter); results = results.filter(c => match(c.name, c.filepath)); }
  jsonResponse(res, {
    classes: results.slice(0, n).map((c, i) => ({
      rank: i + 1, name: c.name, filepath: c.filepath,
      methods: c.method_count, total_lines: c.total_method_lines,
      total_calls: c.total_calls || 0, score: Math.round((c.score || 0) * 10) / 10,
    })),
  });
};


// --- Class Hierarchy ---

routes['/api/class-hierarchy'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  try {
    const hierarchy = index.getClassHierarchy(q.filter || null);
    jsonResponse(res, hierarchy);
  } catch (err) {
    errorResponse(res, `Class hierarchy failed: ${err.message}`, 500);
  }
};


// --- Callers / Callees ---

routes['/api/callers'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let func = q.func;
  if (!func) return errorResponse(res, 'Missing ?func= parameter');
  // `file@name`: the file names which definition is asked for, so the search
  // can drop call sites that cannot reach it (#343 ★A: two file-local
  // `_shortPath`s shared one "Called By" list).
  let fileHint = null;
  if (func.includes('@')) {
    fileHint = func.slice(0, func.indexOf('@')) || null;
    func = func.slice(func.indexOf('@') + 1);
  }
  func = index.getOriginalName(func);
  let callers;
  try {
    callers = index.findCallers(func, safeMax(q.max, 200), { fileHint });
  } catch (e) {
    // Short-name bail-out (#280): scan would block the event loop for
    // minutes on short bundled-JS names like 'h1' or 'N8'. Return 400 with
    // a clear message so the GUI can show it instead of the spinner hanging.
    if (e.code === 'SHORT_NAME_BAILOUT') return errorResponse(res, e.message, 400);
    throw e;
  }
  jsonResponse(res, {
    target: index.getDisplayName(func),
    callers: callers.map(c => ({ filepath: c.filepath, line_number: c.line_number, line_text: index.applyRenames(c.line_text || ''), caller_function: index.getDisplayName(c.caller_function || ''), call_type: c.call_type })),
  });
};

routes['/api/callees'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let func = q.func;
  if (!func) return errorResponse(res, 'Missing ?func= parameter');
  const { funcName: rawCallees, fileHint } = parseFuncSpec(func);
  const funcName = index.getOriginalName(rawCallees);
  const callees = index.findCallees(funcName, fileHint);
  jsonResponse(res, {
    target: index.getDisplayName(funcName),
    callees: callees.map(c => {
      const rd = c.resolved_def;
      return { name: c.name, display_name: c.display_name, definitions: (c.definitions || []).length, resolved_def: rd ? { full_name: rd.full_name, filepath: rd.filepath, class_name: rd.class_name } : null, call_type: c.call_type, ambiguous: c.ambiguous || false };
    }),
  });
};


// --- Load / replace index at runtime ---

routes['/api/load-index'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const indexPath = toNativePath(params.path || '');
      if (!indexPath) return errorResponse(res, 'Missing "path" in body');
      const mode = params.mode || 'replace';
      if (!fs.existsSync(indexPath)) return errorResponse(res, `Path not found: ${indexPath}`, 404);
      // #176: a .zip of an index — extract to a cached temp dir and validate/
      // load the resulting directory. resolveIndexDir is a no-op for non-zip
      // paths, so directory indexes are unchanged.
      let indexDir = indexPath;
      if (/\.zip$/i.test(indexPath)) {
        try {
          if (fs.statSync(indexPath).isFile()) indexDir = resolveIndexDir(indexPath);
        } catch (e) {
          return errorResponse(res, `Cannot open zipped index ${indexPath}: ${e.message}`, 400);
        }
      }
      // Lightweight validation: check files exist without loading the index
      // (Loading a probe CodeSearchIndex would read the entire literal_index.json,
      // which OOMs on huge indexes like Chromium's 5.3GB literal_index.)
      const warnings = [];
      const litPath = path.join(indexDir, 'literal_index.json');
      if (!fs.existsSync(litPath)) {
        return errorResponse(res, `Index at ${indexPath} is unusable: literal_index.json is missing`, 400);
      }
      try {
        const litStat = fs.statSync(litPath);
        if (litStat.size === 0) return errorResponse(res, `Index at ${indexPath} is unusable: literal_index.json is empty`, 400);
      } catch (e) {
        return errorResponse(res, `Cannot read literal_index.json: ${e.message}`, 400);
      }
      for (const fname of ['inverted_index.json', 'function_index.json']) {
        const fp = path.join(indexDir, fname);
        if (!fs.existsSync(fp)) warnings.push(`${fname} is missing`);
        else {
          try { if (fs.statSync(fp).size === 0) warnings.push(`${fname} is empty`); }
          catch (_) { warnings.push(`${fname} is unreadable`); }
        }
      }
      // Replace mode (the only mode the dialog offers today): release every
      // loaded index AND the MCP tool module's reference to it (the chat /
      // analyze / overview loops point handleTool at the active index via
      // setIndex, and that reference used to outlive a Load Index — the big
      // index stayed in memory until Ctrl-C), force a GC when one is available,
      // then load. Three [load-index] lines land in this console per switch;
      // core/index-manager.js says how to read them.
      const released = (mode === 'replace') ? (mgr.activeIndex || null) : null;
      const name = (mode === 'replace')
        ? mgr.replace(indexDir, { onRelease: () => setIndex(null), onActive: (idx) => setIndex(idx) })
        : mgr.load(indexDir);
      if (!name) return errorResponse(res, `No files found in index at: ${indexPath}`, 400);
      mgr.activeIndex = name;
      const resp = { loaded: name, mode, indexes: mgr.list() };
      // Tell the GUI which index was let go and what the process's memory did,
      // so its Console note states numbers rather than reassurance.
      if (released && released !== name) {
        resp.released = released;
        if (mgr.lastReplace) resp.memory = mgr.lastReplace;
      }
      if (warnings.length > 0) resp.warnings = warnings;
      jsonResponse(res, resp);
    } catch (err) {
      errorResponse(res, `Load error: ${err.message}`, 500);
    }
  });
};


// --- Build index from GUI ---

routes['/api/build-index'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const { sourcePath: rawSourcePath, indexName: rawIndexName, useTreeSitter, extensions, excludeExtensions, autoLoad = true } = params;
      if (!rawSourcePath) return errorResponse(res, 'Missing "sourcePath" in body');
      if (!rawIndexName) return errorResponse(res, 'Missing "indexName" in body');
      let sourcePath = rawSourcePath.trim();
      // Convert Windows paths, preserving @ prefix for file lists
      if (sourcePath.startsWith('@')) {
        sourcePath = '@' + toNativePath(sourcePath.slice(1));
      } else {
        sourcePath = toNativePath(sourcePath);
      }
      const indexName = toNativePath(rawIndexName);

      // Validate path exists for non-glob, non-@file paths
      const trimmed = sourcePath;
      const pathCheck = validateFilePath(trimmed);
      if (!pathCheck.safe) return errorResponse(res, pathCheck.reason, 403);
      const isGlob = trimmed.includes('*') || trimmed.includes('?');
      const isFileList = trimmed.startsWith('@');
      if (!isGlob && !isFileList) {
        if (!fs.existsSync(trimmed)) return errorResponse(res, `Path not found: ${trimmed}`, 404);
      }

      // Create a background job and return immediately
      const resolvedIndex = path.resolve(indexName.trim());
      const jobId = nextBuildJobId++;
      buildJobs.set(jobId, { status: 'building', progress: 'Starting…', stats: null, error: null, loaded: null, indexes: null });
      jsonResponse(res, { jobId });

      // Run the build in a Worker thread so the event loop stays responsive
      const workerPath = path.join(__dirname, 'build-worker.js');
      const worker = new Worker(workerPath, {
        workerData: { sourcePath, indexPath: resolvedIndex, useTreeSitter: useTreeSitter !== false, extensions: extensions || '', excludeExtensions: excludeExtensions || '' }
      });

      const job = buildJobs.get(jobId);

      worker.on('message', (msg) => {
        if (msg.type === 'progress') {
          job.progress = msg.message;
        } else if (msg.type === 'done') {
          const stats = msg.stats;
          if (stats.files_indexed === 0) {
            job.status = 'error';
            job.error = `No files were indexed from: ${sourcePath}`;
            return;
          }

          // #218: decouple build from load. By default the freshly-built index
          // is loaded (rebuild + back-compat); with autoLoad:false (the GUI
          // Build dialog) we build to disk only and leave the loaded set
          // untouched, so a build never silently discards the user's currently
          // loaded index(es) — the client then offers to load it explicitly.
          const name = path.basename(resolvedIndex) || resolvedIndex;
          if (autoLoad) {
            const idx = new CodeSearchIndex({ indexPath: resolvedIndex });
            mgr.indexes.clear();
            mgr.activeIndex = null;
            mgr.indexes.set(name, idx);
            mgr.activeIndex = name;
            job.loaded = name;
          } else {
            job.loaded = null;
          }

          const errorCount = stats.errors.length;
          const cappedErrors = stats.errors.slice(0, 50);

          job.status = 'done';
          job.indexes = mgr.list();
          job.indexPath = resolvedIndex;
          job.stats = {
            files_indexed: stats.files_indexed,
            total_lines: stats.total_lines,
            archives_expanded: stats.archives_expanded || 0,
            archive_files: stats.archive_files || 0,
            binstrings_processed: stats.binstrings_processed || 0,
            dupes_skipped: stats.dupes_skipped || 0,
            errors: cappedErrors,
            error_count: errorCount,
          };
        } else if (msg.type === 'error') {
          job.status = 'error';
          job.error = msg.error;
        }
      });

      worker.on('error', (err) => {
        job.status = 'error';
        job.error = err.message;
      });
    } catch (err) {
      errorResponse(res, `Build error: ${err.message}`, 500);
    }
  });
};

routes['/api/build-index-status'] = (req, res) => {
  const q = parseQuery(req.url);
  const jobId = parseInt(q.jobId, 10);
  if (!jobId || !buildJobs.has(jobId)) return errorResponse(res, 'Unknown jobId', 404);
  const job = buildJobs.get(jobId);
  jsonResponse(res, {
    status: job.status,
    progress: job.progress,
    stats: job.stats,
    error: job.error,
    loaded: job.loaded,
    indexes: job.indexes,
    indexPath: job.indexPath,   // #218: so the client can pre-fill the Load dialog
  });
  // Clean up completed/errored jobs after delivering the result
  if (job.status === 'done' || job.status === 'error') {
    buildJobs.delete(jobId);
  }
};

// gui-help: serve the repo-root README.md so the GUI Help popup can render it
// (static serving is public/ only, so the browser can't fetch it directly).
routes['/api/readme'] = (req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf-8');
    jsonResponse(res, { content });
  } catch (e) {
    errorResponse(res, `README not found: ${e.message}`, 404);
  }
};

// gui-help: serve the repo-root TOUR.md for the GUI tour popup, plus a flag
// telling the GUI whether the bundled first-run demo index is loaded — that
// flag drives the one-time auto-pop on a fresh download (#230 Part B).
routes['/api/tour'] = (req, res) => {
  try {
    const content = fs.readFileSync(path.join(__dirname, '..', 'TOUR.md'), 'utf-8');
    const firstRunDemo = (serverArgs.indexPaths || []).some(
      (p) => path.basename(String(p)).toLowerCase() === 'first_run_index.zip');
    jsonResponse(res, { content, firstRunDemo });
  } catch (e) {
    errorResponse(res, `TOUR not found: ${e.message}`, 404);
  }
};


// --- Call tree (Mermaid) ---

routes['/api/call-tree'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let func = q.func;
  if (!func) return errorResponse(res, 'Missing ?func= parameter');
  const depth = parseInt(q.depth) || 3;
  const { funcName: rawCT, fileHint } = parseFuncSpec(func);
  const funcName = index.getOriginalName(rawCT);
  const matches = index.findFunctionMatches(funcName, fileHint);
  if (matches.length === 0) return errorResponse(res, `Function '${rawCT}' not found`, 404);

  const root = matches[0];
  const mermaidLines = ['graph TD'];
  const edges = new Set();  // dedup edges

  function safeId(name) { return name.replace(/[^a-zA-Z0-9_]/g, '_'); }
  function safeLbl(name) { return name.replace(/["<>&]/g, c => ({'<':'‹','>':'›','"':"'", '&':'+'}[c])); }
  function addEdge(fromName, toName, { dashed = false, toLabel = null } = {}) {
    const key = `${fromName}-->${toName}`;
    if (edges.has(key)) return;
    edges.add(key);
    const arrow = dashed ? '-.->' : '-->';
    mermaidLines.push(`  ${safeId(fromName)}["${safeLbl(fromName)}"] ${arrow} ${safeId(toName)}["${safeLbl(toLabel || toName)}"]`);
  }

  // --- Callees (downward from root) ---
  const visitedDown = new Set();
  function addCallees(fn, fh, d) {
    if (d >= depth || visitedDown.has(fn)) return;
    visitedDown.add(fn);
    const callees = index.findCallees(fn, fh);
    for (const c of callees.slice(0, 12)) {
      if (c.ambiguous && !c.resolved_def) continue;  // no reachable definition: no edge
      // A pick among several reachable definitions is a dashed edge to a
      // `?`-labelled node and is not descended into.
      addEdge(fn, c.name, c.ambiguous ? { dashed: true, toLabel: `${c.name} ?` } : {});
      if (c.resolved_def && !c.ambiguous) addCallees(c.name, null, d + 1);
    }
  }
  addCallees(root.name, root.filepath, 0);

  // --- Callers (upward from root) ---
  const visitedUp = new Set();
  function addCallers(fn, d) {
    if (d >= depth || visitedUp.has(fn)) return;
    visitedUp.add(fn);
    try {
      const callerHits = index.findCallers(fn, 100);
      // Deduplicate by caller function name, keep top by frequency
      const callerCounts = new Map();
      let fileScopeSites = 0;
      for (const c of callerHits) {
        if (!c.caller_function) { fileScopeSites++; continue; }   // module-scope call site
        if (c.caller_function !== fn && c.caller_function !== '(global)') {
          callerCounts.set(c.caller_function, (callerCounts.get(c.caller_function) || 0) + 1);
        }
      }
      // Module-scope callers were dropped from the diagram (#343 ★A); draw
      // them as one `(file scope)` node, never walked further.
      if (fileScopeSites > 0) addEdge('(file scope)', fn);
      const topCallers = [...callerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      for (const [callerName] of topCallers) {
        addEdge(callerName, fn);
        addCallers(callerName, d + 1);
      }
    } catch (_) {}
  }
  addCallers(root.name, 0);

  jsonResponse(res, { target: root.name, filepath: root.filepath, mermaid: mermaidLines.join('\n') });
};


// --- File map (all cross-file dependencies as Mermaid) ---

routes['/api/file-map'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const pathFilter = q.filter || null;
  const fileDeps = index.getAllFileDeps(pathFilter, false);
  if (!fileDeps || Object.keys(fileDeps).length === 0)
    return jsonResponse(res, { mermaid: 'graph LR\n  empty["No cross-file deps found"]', files: 0, edges: 0 });

  const mermaidLines = ['flowchart LR'];
  const nodeIds = {};
  let edgeCount = 0;
  const mfid = (fp) => {
    const b = path.basename(fp).replace(/[^a-zA-Z0-9_]/g, '_');
    return `f_${b}_${Buffer.from(fp).toString('base64').slice(0, 6)}`;
  };

  // Build summary: file -> total outgoing calls
  const fileSummary = {};
  for (const [src, deps] of Object.entries(fileDeps)) {
    fileSummary[src] = Object.values(deps).reduce((a, b) => a + b, 0);
  }
  // Show top N files by coupling
  const topFiles = Object.entries(fileSummary).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const topSet = new Set(topFiles.map(([fp]) => fp));

  for (const [src, deps] of Object.entries(fileDeps)) {
    if (!topSet.has(src)) continue;
    const sid = mfid(src);
    if (!(sid in nodeIds)) { nodeIds[sid] = src; mermaidLines.push(`    ${sid}["${path.basename(src)}"]`); }
    for (const [tgt, count] of Object.entries(deps).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const tid = mfid(tgt);
      if (!(tid in nodeIds)) { nodeIds[tid] = tgt; mermaidLines.push(`    ${tid}["${path.basename(tgt)}"]`); }
      const label = count > 1 ? `|${count}|` : '';
      mermaidLines.push(`    ${sid} -->${label} ${tid}`);
      edgeCount++;
    }
  }

  // Also return textual summary
  const summary = topFiles.map(([fp, calls], i) => ({
    rank: i + 1, filepath: fp, total_calls: calls,
    targets: Object.keys(fileDeps[fp] || {}).length,
  }));

  jsonResponse(res, { mermaid: mermaidLines.join('\n'), files: Object.keys(nodeIds).length, edges: edgeCount, summary });
};


// --- File tree (deps of single file as Mermaid) ---

routes['/api/file-tree'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const fileArg = q.file;
  if (!fileArg) return errorResponse(res, 'Missing ?file= parameter');
  const depth = parseInt(q.depth) || 2;

  const filePattern = fileArg.replace(/\\/g, '/').toLowerCase();
  let fmatches = [...index.files.keys()].filter(fp => fp.replace(/\\/g, '/').toLowerCase().includes(filePattern));
  if (fmatches.length === 0) return errorResponse(res, `No files matching '${fileArg}'`, 404);
  if (fmatches.length > 1) {
    const bm = fmatches.filter(fp => path.basename(fp).toLowerCase() === path.basename(fileArg).toLowerCase());
    if (bm.length === 1) fmatches = bm;
    else return jsonResponse(res, { ambiguous: true, matches: fmatches.slice(0, 20) });
  }

  const targetFile = fmatches[0];
  const targetBase = path.basename(targetFile);
  index._ensureFunctionIndex();

  // Helper: outgoing deps
  function getOutDeps(fp) {
    const deps = {};
    if (!index.functionIndex[fp]) return deps;
    for (const [fname] of Object.entries(index.functionIndex[fp])) {
      const callees = index.findCallees(fname, fp);
      for (const ce of callees) {
        const bestDef = ce.resolved_def || (ce.definitions && ce.definitions[0]);
        if (bestDef && bestDef.filepath !== fp) deps[bestDef.filepath] = (deps[bestDef.filepath] || 0) + 1;
      }
    }
    return deps;
  }

  // Helper: incoming deps
  function getInDeps(fp) {
    const incoming = {};
    if (!index.functionIndex[fp]) return incoming;
    for (const fname of Object.keys(index.functionIndex[fp])) {
      let bare = fname.includes('::') ? fname.split('::').pop() : fname;
      bare = bare.includes('.') ? bare.split('.').pop() : bare;
      try {
        const callers = index.findCallers(bare, 100);
        for (const c of callers) { if (c.filepath !== fp) incoming[c.filepath] = (incoming[c.filepath] || 0) + 1; }
      } catch (_) {}
    }
    return incoming;
  }

  const nLines = (index.fileLines.get(targetFile) || []).length;
  const nFuncs = Object.keys(index.functionIndex[targetFile] || {}).length;
  const incoming = getInDeps(targetFile);

  const mermaidLines = ['flowchart LR'];
  const mfid = (fp) => {
    const b = path.basename(fp).replace(/[^a-zA-Z0-9_]/g, '_');
    return `f_${b}_${Buffer.from(fp).toString('base64').slice(0, 6)}`;
  };
  const nodes = new Set();
  const edges = [];
  const tid = mfid(targetFile);
  nodes.add(tid);
  mermaidLines.push(`    ${tid}[["${targetBase} (${nLines}L, ${nFuncs}fn)"]]`);

  // Incoming edges
  for (const [src, count] of Object.entries(incoming).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const sid = mfid(src);
    if (!nodes.has(sid)) { nodes.add(sid); mermaidLines.push(`    ${sid}["${path.basename(src)}"]`); }
    edges.push(`    ${sid} -->${count > 1 ? `|${count}|` : ''} ${tid}`);
  }

  // Outgoing edges (recursive to depth)
  const visited = new Set([targetFile]);
  function collectOut(fp, rem) {
    if (rem <= 0) return;
    const deps = getOutDeps(fp);
    const sid = mfid(fp);
    for (const [tgt, count] of Object.entries(deps).sort((a, b) => b[1] - a[1])) {
      const tgid = mfid(tgt);
      const tl = (index.fileLines.get(tgt) || []).length;
      if (!nodes.has(tgid)) { nodes.add(tgid); mermaidLines.push(`    ${tgid}["${path.basename(tgt)} (${tl}L)"]`); }
      edges.push(`    ${sid} -->${count > 1 ? `|${count}|` : ''} ${tgid}`);
      if (!visited.has(tgt) && rem > 1) { visited.add(tgt); collectOut(tgt, rem - 1); }
    }
  }
  collectOut(targetFile, depth);

  for (const e of edges) mermaidLines.push(e);
  mermaidLines.push(`    style ${tid} fill:#ff9,stroke:#333,stroke-width:3px`);

  jsonResponse(res, {
    target: targetFile, target_base: targetBase, lines: nLines, functions: nFuncs,
    incoming_count: Object.keys(incoming).length,
    mermaid: mermaidLines.join('\n'),
  });
};


// --- Call inventory ---

routes['/api/call-inventory'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const func = q.func || null;
  const result = index.getCallInventory(func || null, {
    includePath: q.include_path || null,
    excludePath: q.exclude_path || null,
  });
  const max = safeMax(q.max, 100);
  let inIndex = result.in_index;
  let external = result.external;
  if (q.filter) {
    const match = makeFilterMatcher(q.filter);
    inIndex = inIndex.filter(i => match(i.name, i.filepath));
    external = external.filter(e => match(e.name, e.provenance));
  }
  jsonResponse(res, {
    summary: result.summary,
    in_index: inIndex.slice(0, max).map(item => ({
      name: item.name, qualified_name: item.qualified_name,
      filepath: item.filepath, lines: item.lines,
      caller_count: item.callers.length,
    })),
    external: external.slice(0, max).map(item => ({
      name: item.name, call_count: item.call_sites.length,
      provenance: item.provenance || null,
    })),
  });
};


// --- Index extensions ---

// #191: "present in source but not indexed" extension census. Delegates to the
// shared helper (src/core/extension-census.js), which UNIONS the persisted
// archive-internal skips with a live directory scan and drops already-indexed
// extensions — fixing the directory-of-archives blind spot where a directory of
// zips reported nothing because the live dir scan saw only the .zip files.
function computeSkippedExtensions(index) {
  return skippedExtensionCensus(index);
}

routes['/api/index-extensions'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const extCounts = {};
  for (const fp of index.files.keys()) {
    const ext = path.extname(fp).toLowerCase() || '(none)';
    extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  const sorted = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
  jsonResponse(res, {
    total_files: index.files.size,
    extensions: sorted.map(([ext, count]) => ({ ext, count, pct: Math.round(count / index.files.size * 1000) / 10 })),
    skipped: computeSkippedExtensions(index),
  });
};

// #194: data structures (struct/enum/union/typedef/trait/interface/record),
// ranked by reference count. Complements /api/classes for systems code.
routes['/api/data-structures'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let structs = extractDataStructures(index);
  if (q.filter) { const match = makeFilterMatcher(q.filter); structs = structs.filter(s => match(s.name)); }
  const max = safeMax(q.max, 500);
  jsonResponse(res, { total: structs.length, structs: structs.slice(0, max) });
};

// #203: the codebase's external surface — URLs/hosts, env vars, filesystem
// paths, external commands, cloud/infra, model IDs. Aggregator over existing
// detectors + net-new literal scans (see core/referenced-resources.js).
routes['/api/referenced-resources'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const rr = extractReferencedResources(index);
  if (q.filter) {
    const match = makeFilterMatcher(q.filter);
    rr.network = rr.network.filter(e => match(e.value) || match(e.host || ''));
    rr.env = rr.env.filter(e => match(e.value));
    rr.filesystem = rr.filesystem.filter(e => match(e.value));
    rr.subprocess = rr.subprocess.filter(e => match(e.value));
    rr.cloud = rr.cloud.filter(e => match(e.kind) || match(e.cell));
    rr.models = rr.models.filter(e => match(e.model));
  }
  jsonResponse(res, rr);
};

// #197: client/server HTTP surface — server routes, client calls, and the
// reconciliation (internal client calls with no matching server route).
routes['/api/client-server'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const data = extractClientServer(index);
  if (q.filter) {
    const match = makeFilterMatcher(q.filter);
    const apiMatch = (e) => match(e.api) || match(e.filepath);
    data.server = data.server.filter(s => match(s.path));
    data.client = data.client.filter(c => match(c.url));
    data.unmatched = data.unmatched.filter(u => match(u.pathOnly || ''));
    data.sockets = data.sockets.filter(apiMatch);
    data.rpc = data.rpc.filter(apiMatch);
    data.ipc = data.ipc.filter(apiMatch);
  }
  const max = safeMax(q.max, 500);
  jsonResponse(res, {
    server: data.server.slice(0, max),
    client: data.client.slice(0, max),
    unmatched: data.unmatched.slice(0, max),
    sockets: data.sockets.slice(0, max),  // non-HTTP transports — forwarded so the GUI can render them
    rpc: data.rpc.slice(0, max),
    ipc: data.ipc.slice(0, max),
    stats: data.stats,
  });
};

// #191: list the indexed files of one extension (or the no-extension bucket),
// for the Extensions accordion drill-down. `ext` is e.g. ".xmlui" or "(none)".
routes['/api/files-by-extension'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const want = (q.ext || '').toLowerCase();
  if (!want) return errorResponse(res, 'Missing ?ext= parameter');
  const files = [];
  for (const fp of index.files.keys()) {
    const ext = path.extname(fp).toLowerCase() || '(none)';
    if (ext === want) files.push(fp);
  }
  files.sort();
  const max = safeMax(q.max, 500);
  jsonResponse(res, { ext: want, total: files.length, files: files.slice(0, max) });
};


// --- Multisect search ---

routes['/api/multisect'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const terms = q.terms;
  if (!terms) return errorResponse(res, 'Missing ?terms= parameter');
  const parsed = parseMultisectTerms(terms);
  if (!parsed || parsed.length === 0) return errorResponse(res, 'No valid search terms parsed');
  const minTerms = parseInt(q.min_terms) || 0;
  const maxResults = safeMax(q.max, 25);
  const verbose = q.verbose === 'true';
  const includePath = (typeof q.in === 'string' && q.in.trim()) ? q.in.trim() : null;
  const matchRenames = q.match_renames === 'true' || q.match_renames === '1';
  jsonResponse(res, _runMultisectViews(index, parsed, minTerms, maxResults, verbose, includePath, matchRenames));
};


// --- Build version (restart canary) ---

routes['/api/version'] = (req, res) => {
  // platform / isWSL let path-shaping clients (e.g. the Rebuild flow in
  // public/dialogs.js) decide whether a C:\ -> /mnt/c/ conversion is
  // actually warranted — it is only correct when the server runs inside
  // WSL. _isWSL is computed once at startup (see above). #43.
  jsonResponse(res, { build: SERVER_BUILD, platform: process.platform, isWSL: _isWSL });
};

// #215 Phase 2: provenance banner for GUI saves. Built server-side (one
// builder for every surface — src/core/provenance.js, which also documents
// the litigation print-out roadmap this seeds). Returns {enabled:false}
// unless the server was started with --provenance, so the client's save
// path stays a no-op by default.
routes['/api/provenance'] = (req, res) => {
  if (!serverArgs.provenance) return jsonResponse(res, { enabled: false });
  const q = parseQuery(req.url);
  const indexName = q.index || mgr.activeIndex;
  const index = mgr.get(indexName);
  const engine = serverArgs.defaultEngine || (serverArgs.modelPath ? 'local' : null);
  // Read the parsed args directly, not serverLLM.defaultClaudeModel — the
  // latter is null until the gui-launcher-forward-claude-model wiring fix
  // lands (ServerLLM ctor drops claudeModel), and this header must not
  // silently omit a model the user explicitly configured.
  const model = engine === 'openai' ? (serverArgs.openaiModel || serverLLM.defaultOpenAIModel || null)
    : engine === 'gemini' ? (serverArgs.geminiModel || serverLLM.defaultGeminiModel || null)   // #246
    : engine === 'local' ? (serverArgs.modelPath || null)
    : (serverArgs.claudeModel || serverLLM.defaultClaudeModel || null);
  jsonResponse(res, {
    enabled: true,
    header: buildProvenanceHeader({
      version: CE_VERSION,
      indexPath: indexName,
      fileCount: index && index.files ? index.files.size : undefined,
      command: sanitizedCommandLine(),
      engine, model,
      subject: q.subject || undefined,   // client passes the per-pane subject line
    }),
  });
};


// --- Search (literal) ---

routes['/api/search'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const query = q.q;
  if (!query) return errorResponse(res, 'Missing ?q= parameter');
  const maxResults = safeMax(q.max, 20);
  const contextLines = parseInt(q.context) || 3;
  const type = q.type || 'literal'; // literal, regex, fast
  // Optional path filter (GUI search dialog / CLI --in). Case-insensitive
  // substring match against the filepath; blank/absent = unfiltered.
  const includePath = (typeof q.in === 'string' && q.in.trim()) ? q.in.trim().toLowerCase() : null;
  const pathOk = (fp) => !includePath || (fp || '').toLowerCase().includes(includePath);

  // Search stored content with original query
  const caseSensitive = q.case_sensitive === '1' || q.case_sensitive === 'true';
  // With a path filter active, over-fetch so filtering doesn't starve the
  // result set, then trim back to maxResults below. Over-fetch by 1 past the
  // display cap either way, so we can tell the client whether results were
  // truncated -- otherwise a full page looks complete (the silent-cap bug).
  const searchCap = (includePath ? maxResults * 5 : maxResults) + 1;
  let results;
  if (type === 'fast' || type === 'regex') {
    results = index.searchInverted(query, { useRegex: type === 'regex', caseSensitive, maxResults: searchCap });
  } else {
    results = index.searchLiteral(query, { caseSensitive, maxResults: searchCap, contextLines });
  }
  if (includePath) results = results.filter(r => pathOk(r.filePath));
  let truncated = results.length > maxResults;
  results = results.slice(0, maxResults);

  // If no hits and query looks like a display name pattern (e.g. _TMPL_),
  // find original names whose display names match and search for those
  if (results.length === 0) {
    const originals = index.findOriginalsByDisplayPattern(query);
    if (originals.length > 0) {
      // Search for each original name, collect up to maxResults
      for (const orig of originals.slice(0, 20)) {
        let hits;
        if (type === 'fast' || type === 'regex') {
          hits = index.searchInverted(orig, { maxResults: 3 });
        } else {
          hits = index.searchLiteral(orig, { maxResults: 3, contextLines });
        }
        if (includePath) hits = hits.filter(r => pathOk(r.filePath));
        results.push(...hits);
        if (results.length >= maxResults) break;
      }
      results = results.slice(0, maxResults);
    }
  }
  jsonResponse(res, {
    query, type, truncated, shown: results.length, cap: maxResults,
    results: results.map(r => ({ filepath: r.filePath, line_number: r.lineNumber, line_text: index.applyRenames(r.lineText || ''), context: index.applyRenames(r.context || ''), containing_function: index.getDisplayName(r.functionName || '') || null })),
  });
};


// --- Files search ---

routes['/api/files-search'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const term = q.q;
  if (!term) return errorResponse(res, 'Missing ?q= parameter');
  const max = safeMax(q.max, 30);
  // Optional path filter (GUI search dialog / CLI --in). Blank = unfiltered.
  const includePath = (typeof q.in === 'string' && q.in.trim()) ? q.in.trim().toLowerCase() : null;
  const fileCounts = new Map();
  const termLower = term.toLowerCase();
  for (const [filepath, lines] of index.fileLines) {
    if (includePath && !filepath.toLowerCase().includes(includePath)) continue;
    let count = 0;
    for (const line of lines) { if (line.toLowerCase().includes(termLower)) count++; }
    if (count > 0) fileCounts.set(filepath, count);
  }
  const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
  jsonResponse(res, { term, total: fileCounts.size, files: sorted.map(([fp, count], i) => ({ rank: i + 1, filepath: fp, hits: count })) });
};


// --- Vocabulary ---

// #181: one-shot orientation summary (structured) for the GUI Overview pane.
// Fast by contract — buildOverview leans on cached stats/vocabulary/structure.
// Fast half — instant orientation (counts, languages, structure). The GUI
// renders this immediately, then fetches /api/overview-deep for the rest.
routes['/api/overview'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const ov = buildOverviewFast(index);
  // Short index name (e.g. `.plugins_from_gh`) for the pane title, distinct from
  // ov.source (the build source path/glob). Falls back to source if unavailable.
  const list = mgr.list() || [];
  const entry = q.index ? list.find(i => i.name === q.index) : list.find(i => i.active);
  ov.name = (entry && entry.name) || ov.source || null;
  jsonResponse(res, ov);
};

// Deep half — O(corpus) signals (function count, concepts, key files, entry
// points). Can take minutes on a very large index; requested separately so the
// fast half is never blocked on it.
routes['/api/overview-deep'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  jsonResponse(res, buildOverviewDeep(index));
};

// #196 "Overview by AI" — a prose 1–2 page orientation, generated by running
// Claude AGENTICALLY over CE's own MCP tools. The prompt + tool allow-list +
// spawn plumbing live in core/ai-overview.js so the GUI route and the CLI
// (`--overview-by-ai`) share one implementation. Non-air-gapped: spawns the
// `claude` CLI with CE's mcp-server pointed at the loaded index.
// Local-engine "Overview by AI" (overview-by-ai-local-engine): the same
// orientation prompt as the claude engine, run agentically against the
// SERVER-LOADED model. Deliberately does NOT call runAiOverviewLocal (the CLI
// path): that loads its own model copy, and a second copy beside the loaded
// one measured-OOMs a 24 GB GPU. Shares the chat loop's hardening: cached
// sequence reuse (dispose is broken upstream for some families — see
// runChatToolLoopLocal), special-token neutralization of tool results, capped
// results, context-scaled output, and a tool budget so an over-eager model
// synthesizes instead of overflowing the context.
async function runAiOverviewLocalShared({ index, grounding }) {
  return withLocalLock(async () => {
  setIndex(index);
  const loaded = await serverLLM.ensureLocalModel();
  if (loaded.error) throw new Error(loaded.error);
  const lm = serverLLM._localModel;
  if (!lm || !lm.defineChatSessionFunction) {
    throw new Error('local Overview by AI: node-llama-cpp function-calling unavailable (update node-llama-cpp).');
  }
  const { LlamaChatSession, defineChatSessionFunction } = lm;
  const overviewToolNames = AI_OVERVIEW_TOOLS.split(',').map(t => t.replace(/^mcp__code-exam__/, ''));
  const byName = new Map(TOOLS.map(t => [t.name, t]));
  // Measure the overhead instead of assuming 1200 — the tool definitions below
  // are rendered into the prompt and are ~1500 tokens on their own.
  const _overhead = _measureOverhead(
    lm.model,
    aiOverviewPrompt(grounding, { localEngine: true }),
    overviewToolNames.map(n => byName.get(n)),
  );
  const { maxTokens, toolBudgetChars } = _localBudgets(lm.contextSize, null, _overhead);
  console.log(`  [ai-overview] budget: context ${lm.contextSize}, measured overhead ~${_overhead ?? 1200} tokens, `
    + `maxTokens ${maxTokens}, tool budget ${toolBudgetChars} chars`);
  // PRE-FLIGHT. Once the overhead is measured rather than assumed, some rungs
  // are arithmetically impossible: at 4096 the prompt plus the 16 tool
  // definitions are ~3478 of 4096 tokens, leaving no room for a single tool
  // result. Measured end to end — that configuration dies inside
  // node-llama-cpp with "The default context shift strategy did not return a
  // history that fits the context size. This may happen due to the system
  // prompt being too long", which sends the user to debug a prompt they did
  // not write. Say it in CE's own voice, with the numbers and a way out,
  // BEFORE spending a model call on a run that cannot finish.
  const _headroom = lm.contextSize - (_overhead ?? 1200) - maxTokens;
  if (_headroom < 400) {
    throw new Error(
      `local Overview by AI needs a larger context: ${lm.contextSize} tokens cannot hold the prompt and `
      + `${overviewToolNames.length} tool definitions (~${_overhead ?? 1200} tokens) plus room for tool results. `
      + `Try --context-size 8192 or more, add --flash-attention so a larger context fits in the same VRAM, `
      + `or use a smaller model.`);
  }
  let toolCalls = 0;
  let toolChars = 0;
  let budgetStopped = false;
  const toolCallCounts = new Map(); // #320 item 4
  let modelsUsedResult = '';        // #320 1a/1c (the model's own view, for the prose)
  let modelsUsedArgs = null;        // the model's own call's arguments, disclosed in the notes
  let overviewSeedResult = '';
  const functions = {};
  for (const name of overviewToolNames) {
    const def = byName.get(name);
    if (!def) continue;
    functions[name] = defineChatSessionFunction({
      description: String(def.description || '').slice(0, 280),
      params: (def.inputSchema && def.inputSchema.properties) ? def.inputSchema : { type: 'object', properties: {} },
      handler: (args) => {
        toolCalls++;
        if (budgetStopped || toolCalls > 24 || toolChars > toolBudgetChars) {
          if (!budgetStopped) {
            budgetStopped = true;
            console.log(`  [ai-overview] budget-stop after ${toolCalls - 1} calls (${toolChars} result chars)`);
          }
          return 'TOOL BUDGET EXHAUSTED — do not call any more tools. Write your complete overview now from the results you already have.';
        }
        console.log(`  [ai-overview] tool: ${name}(${JSON.stringify(args || {}).slice(0, 120)})`);
        toolCallCounts.set(name, (toolCallCounts.get(name) || 0) + 1);
        let out;
        try { out = String(handleTool(name, args || {})); }
        catch (e) { out = `Error calling ${name}: ${e.message}`; }
        const capped = neutralizeSpecialTokens(out.slice(0, 4000), `${name} result`);
        if (name === 'models_used' && !modelsUsedResult) { modelsUsedResult = capped; modelsUsedArgs = JSON.stringify(args || {}); }
        if (name === 'overview' && !overviewSeedResult) overviewSeedResult = capped;
        toolChars += capped.length;
        return capped;
      },
    });
  }
  // Same cached-sequence reuse as runChatToolLoopLocal — never dispose.
  const sequence = await serverLLM.acquireSharedSequence();
  const session = new LlamaChatSession(await chatSessionOptions(sequence));
  try {
    const sampling = serverLLM.reproducible ? { temperature: 0, seed: 1 } : {};
    // #276: local engines get the forceful-grounding clause, and Gemma the
    // strict-framing header (its wrapper drops system turns; observed
    // fabricating a whole codebase here with 0 tool calls otherwise).
    const wrapperName = session.chatWrapper && session.chatWrapper.wrapperName;
    const promptText = strictInstructionsFor(wrapperName, aiOverviewPrompt(grounding, { localEngine: true }));
    const raw = await session.prompt(promptText, { functions, maxTokens, ...sampling });
    // Was <think>-only here, so the mis-typed Gemma 4 markers reached the GUI
    // verbatim — the `<|"|>`-prefixed overviews in the release screenshots.
    let prose = stripLocalArtifacts(raw);
    // Adding that strip without this nudge would REGRESS the visible result:
    // a Gemma 4 run with reasoning left on returns closers and no prose at all
    // (measured 4/4), which used to render as junk and would now throw. Chat
    // has recovered from this since #250 by re-prompting with tools off; the
    // overview path never got it. Same remedy, same reason — the tool results
    // are already in the session's history, so the model only has to write.
    if (!prose) {
      const NUDGE = 'Based on the tool results above, write your complete overview now. Do not call any more tools.';
      try {
        prose = stripLocalArtifacts(await session.prompt(NUDGE, { maxTokens, ...sampling }));
        if (prose) console.log('  [ai-overview] first pass returned no prose — recovered via nudge');
      } catch (e) { console.warn(`  [ai-overview] nudge failed: ${e.message}`); }
    }
    if (!prose) throw new Error('local Overview by AI: the model returned no prose — try a stronger model or larger --context-size.');
    // #276 fabrication guard: 0 tool calls in grounded mode = not an overview.
    const ungroundedNote = ungroundedWarning(toolCalls, grounding);
    if (ungroundedNote) prose = `${ungroundedNote}\n\n${prose}`;
    // #320 1a/1c: AI/ML verification. The basis is CE's OWN unfiltered call,
    // always — never the model's captured result (overview-verification-basis-
    // unfiltered; asus-CC on #330: Gemma called models_used({"filter":"/"}),
    // emptied the table, and the footnote then said "found no literal model ids
    // in this index"). The model's result stays for the prose; its arguments
    // are disclosed in the notes. Same wiring as the CLI paths.
    let verifyModelsUsed = '';
    let selfCalledModelsUsed = false;
    try {
      verifyModelsUsed = String(handleTool('models_used', {})).slice(0, 4000);
      selfCalledModelsUsed = true;
    } catch { /* verification is best-effort */ }
    // index.files.keys(): a path CE itself indexed is not an invented model id.
    // index.files.keys(): a path CE itself indexed is not an invented model id;
    // TOOLS: a CE tool name the prose suggests is not one either.
    const aimlNote = aimlVerificationNote(prose, verifyModelsUsed, overviewSeedResult, index.files.keys(), { toolNames: TOOLS.map(t => t.name) });
    if (aimlNote) prose += aimlNote;
    const converseNote = aimlConverseNote(prose, verifyModelsUsed, { selfCalled: selfCalledModelsUsed, modelCallArgs: modelsUsedArgs });
    if (converseNote) prose += converseNote;
    // #320 item 4: the evidentiary footer.
    prose += `\n\n${toolCallFooter(toolCallCounts, { selfCalledModelsUsed })}`;
    console.log(`  [ai-overview] local done: ${prose.length} chars, ${toolCalls} tool calls${ungroundedNote ? ' (UNGROUNDED — 0 tool calls)' : ''}`);
    return { prose, toolCalls, contextSize: lm.contextSize };
  } finally {
    try { session.dispose(); } catch (e) { console.warn(`  [ai-overview] session dispose failed: ${e.message}`); }
  }
  }); // #248 withLocalLock
}

routes['/api/ai-overview'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);

  // engine=local runs the overview against the server-loaded GGUF (air-gapped);
  // anything else keeps the original claude path.
  if (q.engine === 'local') {
    const mName = serverLLM.defaultModelPath ? path.basename(serverLLM.defaultModelPath) : '(no model)';
    console.log(`  [ai-overview] running LOCAL (${mName}) over ${q.index || mgr.activeIndex} …`);
    runAiOverviewLocalShared({ index, grounding: q.grounding })
      .then(({ prose, toolCalls, contextSize }) => jsonResponse(res, { prose, engine: 'local', model: mName, toolCalls, contextSize, costUsd: 0, index: index.indexSource || index.indexPath || (q.index || mgr.activeIndex) }))
      .catch((e) => errorResponse(res, (e && e.message) ? e.message : String(e), 502));
    return;
  }

  const idxPath = index.indexPath;
  if (!idxPath) return errorResponse(res, 'The loaded index has no on-disk path; Overview by AI needs one to point the MCP server at it.', 400);

  // #246: cloud engines resolved through the registry (claude / openai /
  // gemini). Same agentic loop over CE's own mcp-server; runAiOverview
  // dispatches. Unknown/local already filtered above.
  const cloudEngine = (q.engine === 'openai' || q.engine === 'gemini') ? q.engine : 'claude';
  const cloudModel = q.model
    || (cloudEngine === 'openai' ? serverLLM.defaultOpenAIModel
      : cloudEngine === 'gemini' ? serverLLM.defaultGeminiModel
      : process.env.CE_AI_OVERVIEW_MODEL);
  const cloudDisplayModel = cloudModel
    || (cloudEngine === 'openai' ? serverLLM.defaultOpenAIModel
      : cloudEngine === 'gemini' ? serverLLM.defaultGeminiModel
      : 'claude-sonnet-4-6');
  console.log(`  [ai-overview] running ${cloudEngine} over ${path.basename(idxPath)} …`);
  // Forward the resolved key for the selected engine — the Claude overview
  // branch now honors it (was hard-requiring ANTHROPIC_API_KEY), parity with
  // Chat/Analyze (#243B).
  const overviewKey = cloudEngine === 'openai' ? serverLLM.defaultOpenAIKey
    : cloudEngine === 'gemini' ? serverLLM.defaultGeminiKey
    : serverLLM.defaultApiKey;
  runAiOverview({ indexPath: idxPath, engine: cloudEngine, model: cloudModel, apiKey: overviewKey, timeoutMs: 600000 })
    .then(({ prose, costUsd }) => jsonResponse(res, { prose, costUsd, engine: cloudEngine, model: cloudDisplayModel, index: index.indexSource || idxPath }))
    .catch((e) => {
      const msg = (e && e.message) ? e.message : String(e);
      // Follow the "running <engine>" line with the outcome, so the stdout log
      // shows the refusal (e.g. --air-gapped) instead of a dangling "running".
      console.log(`  [ai-overview] ${cloudEngine} did not complete: ${msg}`);
      const code = /not found on PATH|Could not launch/i.test(msg) ? 400
        : /timed out/i.test(msg) ? 504 : 502;
      errorResponse(res, msg, code);
    });
};

routes['/api/vocabulary'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  const filter = q.filter || null;
  const items = index.getTopVocabulary(n, filter);
  jsonResponse(res, {
    concepts: extractConcepts(index),
    vocabulary: items.map((v, i) => ({ rank: i + 1, token: v.token, score: Math.round(v.score * 1000) / 1000, doc_freq: v.doc_freq, total_freq: v.total_count })),
  });
};


// --- String table ---

routes['/api/string-table'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const max = safeMax(q.max, 50);
  const filter = q.filter || null;
  const minLength = parseInt(q.min_length) || 8;
  const { total, results } = index.queryStringTable({ filter, max, minLength });
  jsonResponse(res, {
    total,
    shown: results.length,
    truncated: total > results.length,
    strings: results.map((s, i) => ({
      rank: i + 1,
      value: s.value,
      count: s.count,
      files: s.files,
      locations: s.locations.map(loc => ({
        filepath: loc.filepath,
        line: loc.line,
        func: loc.func ? index.getDisplayName(loc.func) : null,
      })),
    })),
  });
};


// --- Breadcrumbs (telemetry trace) ---

// gui-overview-questions-regenerate: one short, tool-free call for a different
// "Questions to start with" list. The client sends the overview it shows and
// the questions on screen; the prompt builder drops CE's ⓘ notes from the
// orientation and quotes the current five so the new ones differ. Sampled on
// purpose: the overview runs pinned or greedy, so a re-run gives the same
// five. Local: the server-loaded GGUF on the shared sequence, serialized like
// every local request, refused as "pinned" under --reproducible. Cloud: a
// single draftCloud call over the selected engine, no tools, behind the
// air-gap check like the chat loops.
routes['/api/ai-overview-questions'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 400_000) req.destroy(); });
  req.on('end', async () => {
    let params;
    try { params = JSON.parse(body || '{}'); } catch { return errorResponse(res, 'Invalid JSON body'); }
    const index = mgr.get(params.index);
    if (!index) return errorResponse(res, 'No index loaded', 404);
    const prose = String(params.prose || '');
    if (!prose.trim()) return errorResponse(res, 'Missing "prose" (the overview to write new questions for)');
    const current = Array.isArray(params.current) ? params.current.map(String) : [];
    const { system, user } = questionsRegenPrompt(prose, current);
    const engine = params.engine === 'local' ? 'local'
      : (params.engine === 'openai' || params.engine === 'gemini') ? params.engine : 'claude';
    const note = `ⓘ Questions regenerated (sampled, temperature ${QUESTIONS_REGEN_TEMPERATURE}); the overview above is unchanged.`;
    try {
      if (engine === 'local') {
        const out = await withLocalLock(async () => {
          if (serverLLM.reproducible) return { pinned: true };
          const loaded = await serverLLM.ensureLocalModel();
          if (loaded.error) throw new Error(loaded.error);
          const lm = serverLLM._localModel;
          const sequence = await serverLLM.acquireSharedSequence();
          const session = new lm.LlamaChatSession(await chatSessionOptions(sequence));
          const wrapperName = session.chatWrapper && session.chatWrapper.wrapperName;
          const promptText = strictInstructionsFor(wrapperName, `${system}\n\n${user}`);
          const raw = await session.prompt(promptText, { maxTokens: QUESTIONS_REGEN_MAX_TOKENS, temperature: QUESTIONS_REGEN_TEMPERATURE });
          return { text: stripLocalArtifacts(raw), model: serverLLM.defaultModelPath ? path.basename(serverLLM.defaultModelPath) : '(local)' };
        });
        if (out.pinned) return jsonResponse(res, { pinned: true, note: 'Pinned sampling (--reproducible) cannot give new questions.' });
        const lines = questionLinesFromAnswer(out.text);
        if (!lines.length) return errorResponse(res, 'local Overview by AI: the model returned no questions — try again, or a stronger model.', 502);
        console.log(`  [ai-overview] new questions (local · ${out.model}): ${lines.length}`);
        return jsonResponse(res, { lines, note, engine: 'local', model: out.model });
      }
      if (isAirGapped()) return errorResponse(res, '--air-gapped: new questions over a cloud engine are blocked. Set the Workspace engine to Local.', 403);
      const prov = PROVIDERS[engine];
      const key = engine === 'openai' ? serverLLM.defaultOpenAIKey : engine === 'gemini' ? serverLLM.defaultGeminiKey : serverLLM.defaultApiKey;
      if (!key) return errorResponse(res, `${prov.label}: no API key configured (set ${prov.keyEnv}).`, 400);
      const modelId = engine === 'openai' ? serverLLM.defaultOpenAIModel
        : engine === 'gemini' ? serverLLM.defaultGeminiModel
        : (process.env.CE_AI_OVERVIEW_MODEL || prov.defaultModel);
      const descriptor = prov.wire === 'anthropic'
        ? { wire: 'anthropic', apiUrl: process.env.CLAIM_SEARCH_API_URL || 'https://api.anthropic.com/v1/messages', key, model: modelId, label: prov.label }
        : { wire: prov.wire, apiUrl: `${prov.baseUrl}/chat/completions`, key, model: modelId, label: prov.label };
      const text = await draftCloud(descriptor, system, user, QUESTIONS_REGEN_MAX_TOKENS, QUESTIONS_REGEN_TEMPERATURE);
      const lines = questionLinesFromAnswer(text);
      if (!lines.length) return errorResponse(res, `${prov.label} returned no questions.`, 502);
      console.log(`  [ai-overview] new questions (${engine} · ${modelId}): ${lines.length}`);
      return jsonResponse(res, { lines, note, engine, model: modelId });
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      console.log(`  [ai-overview] new questions did not complete: ${msg}`);
      return errorResponse(res, msg, /timed out/i.test(msg) ? 504 : 502);
    }
  });
};

routes['/api/breadcrumbs'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const data = index.extractBreadcrumbs(false);
  // Apply display names to function references
  for (const m of data.markers) {
    if (m.func) m.func = index.getDisplayName(m.func);
  }
  for (const ev of data.events) {
    if (ev.func) ev.func = index.getDisplayName(ev.func);
  }
  jsonResponse(res, data);
};


// --- Command catalog ---

routes['/api/command-catalog'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const catalog = index.extractCommandCatalog(false);
  // Apply display names to function references
  for (const section of ['cliOptions', 'commands', 'routes', 'guiActions']) {
    for (const item of catalog[section]) {
      if (item.func) item.func = index.getDisplayName(item.func);
    }
  }
  jsonResponse(res, catalog);
};


// --- Function digest (#329) ---
//
// Returns both the structured digest object (for any future client-side
// rendering) and the text-formatted version (for immediate display).
// Frontend currently uses the text; JSON is included so a fancier panel
// can be built later without changing the endpoint.

routes['/api/digest'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const spec = q.name || q.func;
  if (!spec) return errorResponse(res, 'Missing ?name= parameter');

  // buildDigest is the target-aware dispatcher (#51); routes function / class /
  // file targets to their respective builders and adds a target_type field.
  // #198: kind=class forces the class digest so a same-named constructor
  // can't preempt it (the Classes accordion passes this).
  const digestObj = index.buildDigest(spec, {
    maxCallers: safeMax(q.max, 10),
    maxCallees: safeMax(q.max, 10),
    maxStrings: parseInt(q.max_strings) || 15,
    kind: q.kind || undefined,
  });
  if (!digestObj) return errorResponse(res, `Target not found: ${spec}`, 404);

  let text;
  switch (digestObj.target_type) {
    case 'class': text = formatClassDigest(digestObj); break;
    case 'file':  text = formatFileDigest(digestObj); break;
    case 'function':
    default:      text = formatFunctionDigest(digestObj); break;
  }
  jsonResponse(res, { spec, text, digest: digestObj });
};


// --- Prompt catalog ---
//
// Returns all detected LLM prompts in the index as JSON (full text, no
// truncation). Consumed by external GUI prototypes (e.g. xmlui prompt viewer).

routes['/api/prompts'] = async (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  try {
    const prompts = await collectPrompts(index, { filter: q.filter || null });
    jsonResponse(res, { total: prompts.length, prompts });
  } catch (err) {
    errorResponse(res, `collectPrompts failed: ${err.message}`, 500);
  }
};


// --- Bundle seams ---
//
// Scans all indexed JS files >1000 lines for esbuild module-wrapper patterns
// and returns the per-module breakdown (line ranges, kind, content preview,
// function inventory). Optional filter narrows by filename substring.
// Renames are applied to module names and per-function names so the GUI can
// render readable identifiers without doing its own rename lookups.

routes['/api/bundle-seams'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);

  const matchFile = q.filter ? makeFilterMatcher(q.filter) : null;
  const result = { files: [] };

  for (const filepath of index.fileLines.keys()) {
    const lower = filepath.toLowerCase();
    if (!(lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))) continue;
    if (matchFile && !matchFile(filepath)) continue;
    const lines = index.fileLines.get(filepath);
    if (!lines || lines.length < 1000) continue;

    const detection = index.detectBundleSeams(filepath, { scanHints: true });
    if (!detection.pattern) continue;

    // Apply renames to displayed module names and per-function names
    for (const m of detection.modules) {
      m.displayName = index.getDisplayName(m.name);
      if (m.functions) {
        for (const fn of m.functions) {
          fn.displayName = index.getDisplayName(fn.name);
        }
      }
    }

    result.files.push({
      filepath,
      lineCount: lines.length,
      pattern: detection.pattern,
      helpers: detection.helpers,
      moduleCount: detection.modules.length,
      esmCount: detection.modules.filter(m => m.kind === 'ESM').length,
      cjsCount: detection.modules.filter(m => m.kind === 'CJS').length,
      gapCount: detection.modules.filter(m => m.kind === 'GAP').length,
      modules: detection.modules,
    });
  }

  jsonResponse(res, result);
};


// --- Classes ---

routes['/api/list-classes'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let classes = index.listClasses();
  if (q.filter) {
    const match = makeFilterMatcher(q.filter);
    classes = classes.filter(c =>
      match(
        c.name,
        c.filepath,
        ...(c.methods || []).flatMap(m => [
          m.name.includes('::') ? m.name.split('::').pop() : m.name,
          m.name,
        ]))
    );
  }
  classes.sort((a, b) => b.method_count - a.method_count);
  const max = safeMax(q.max, 100);
  jsonResponse(res, {
    total: classes.length,
    classes: classes.slice(0, max).map(c => ({ name: c.name, filepath: c.filepath, start: c.start, end: c.end, methods: c.method_count, total_lines: c.total_method_lines, inferred: c.inferred || false })),
  });
};

// #134 drill-down: one generic route per AI/ML cell. Groups the flat detector rows
// by the cell's name-identity keyFn, returns deduped groups (each `row(rep)` +
// count + sites). `instances` is the pre-dedup count (badge). The flat `listX`
// itself is unchanged, so raw `--multi-index` consumers are unaffected.
const drilldownRoute = (method, spec, key) => (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let flat = index[method](q.filter);
  if (spec.sort) flat = [...flat].sort(spec.sort);
  const groups = groupSites(flat, spec.keyFn, spec.pick);
  const max = safeMax(q.max, 500);
  jsonResponse(res, {
    total: groups.length,
    instances: flat.length,
    // #132: a group is test/example only when EVERY site is — mixed groups stay undimmed.
    [key]: groups.slice(0, max).map(g => ({
      ...spec.row(g.rep), count: g.count,
      isTest: g.sites.length > 0 && g.sites.every(s => s.filepath && reTestExamplePath.test(s.filepath)),
      sites: g.sites.slice(0, 200),
    })),
  });
};

routes['/api/list-models'] = drilldownRoute('listModels', MODELS_DRILLDOWN, 'models');
routes['/api/list-artifacts'] = drilldownRoute('listArtifacts', ARTIFACTS_DRILLDOWN, 'artifacts');
routes['/api/list-kernels'] = drilldownRoute('listKernels', KERNELS_DRILLDOWN, 'kernels');
routes['/api/list-multimodal'] = drilldownRoute('listMultimodal', MULTIMODAL_DRILLDOWN, 'multimodal');
routes['/api/list-post-training'] = drilldownRoute('listPostTraining', POSTTRAINING_DRILLDOWN, 'post-training');
routes['/api/list-reasoning'] = drilldownRoute('listReasoning', REASONING_DRILLDOWN, 'reasoning');
routes['/api/list-explainability'] = drilldownRoute('listExplainability', EXPLAINABILITY_DRILLDOWN, 'explainability');

// #153 Exports catalog. Not a marker cell — a package -> exports tree, so a
// custom route rather than drilldownRoute. Each "group" is a package; its
// `sites` are the package's exported names, each carrying its resolved
// defSite so a click jumps to the definition (#153 decision 5). Merge mirrors
// the CLI doExports: declared+promoted of the same (package,name) collapse to
// one row showing both tiers, keeping the best defSite/dottedPath.
routes['/api/exports'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const { records, packages, pyFiles } = extractExports(index);
  if (pyFiles === 0) return jsonResponse(res, { total: 0, instances: 0, exports: [], pyFiles: 0 });

  const match = q.filter ? makeFilterMatcher(q.filter) : null;
  const TIER_RANK = { declared: 0, promoted: 1, heuristic: 2 };
  const TIER_GLYPH = { declared: 'A', promoted: 'B', heuristic: 'C' };

  // Merge per (package, name).
  const merged = new Map();   // `${pkg}\0${name}` -> row
  for (const r of records) {
    if (match && !match(r.name, r.dottedPath || '', r.package)) continue;
    const key = `${r.package}\0${r.name}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { name: r.name, package: r.package, tiers: new Set([r.tier]),
        dottedPath: r.dottedPath || null, defSite: r.defSite });
    } else {
      prev.tiers.add(r.tier);
      if (!prev.defSite && r.defSite) prev.defSite = r.defSite;
      if (!prev.dottedPath && r.dottedPath) prev.dottedPath = r.dottedPath;
    }
  }

  // Group by package.
  const byPkg = new Map();
  for (const m of merged.values()) {
    if (!byPkg.has(m.package)) byPkg.set(m.package, []);
    byPkg.get(m.package).push(m);
  }
  const pkgMeta = new Map();
  for (const p of packages.values()) pkgMeta.set(p.dotted || '(root)', p);

  // #166: per-(package, name) used-by lookup, built once per request from the
  // CLI-supplied catalog (reuses the exact CLI --used-by resolution). Null when
  // no catalog was passed at startup — the column then never renders.
  const usedByFor = exportsCatalog ? makeUsedByFor(exportsCatalog, index) : null;

  const max = safeMax(q.max, 500);
  const pkgLabels = [...byPkg.keys()].sort();
  let instances = 0;
  const exportsOut = pkgLabels.map(label => {
    const rows = byPkg.get(label).sort((a, b) => a.name.localeCompare(b.name));
    instances += rows.length;
    const a = rows.filter(r => r.tiers.has('declared')).length;
    const b = rows.filter(r => r.tiers.has('promoted')).length;
    const c = rows.filter(r => r.tiers.has('heuristic')).length;
    const meta = pkgMeta.get(label);
    const notes = (meta && meta.notes) ? [...meta.notes] : [];
    if (meta && meta.implicit) {
      notes.unshift('no __init__.py in the index (empty file skipped at build, or a ' +
        'PEP 420 namespace package) — declared/promoted tiers unavailable; heuristic floor only.');
    }
    return {
      package: label,
      a, b, c,
      count: rows.length,
      notes,
      // tier topmost for each export (A>B>C) drives the glyph in the sites pane.
      sites: rows.map(r => {
        const top = [...r.tiers].sort((x, y) => TIER_RANK[x] - TIER_RANK[y])[0];
        const site = {
          name: r.name,
          tier: TIER_GLYPH[top] || '?',
          tiers: [...r.tiers].map(t => TIER_GLYPH[t]).sort().join(''),
          dottedPath: r.dottedPath || '',
          filepath: r.defSite ? r.defSite.file : null,
          line: r.defSite ? r.defSite.line : null,
        };
        if (usedByFor) {
          // Defined (even if '') only when a catalog is loaded — the GUI keys
          // the Used-by column on presence. '' = declared-but-unused in corpus.
          const users = usedByFor(label, r.name);
          site.usedBy = users && users.length ? users.map(u => `${u.index}(${u.count})`).join(', ') : '';
        }
        return site;
      }),
    };
  });

  jsonResponse(res, {
    total: pkgLabels.length,
    instances,
    exports: exportsOut.slice(0, max),
  });
};

// #162 (2a) Imports accordion — the "consumes" ledger beside Exports'
// "offers". Single-index import census grouped by top-level library; each
// group's sites are the import sites (target + file:line). Catalog-graded
// verdicts (resolved / private / not-found per import) are 2b, which needs the
// catalog's import provenance.
routes['/api/imports'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  // external imports only (relative skipped); every indexed language, plus what
  // HTML and page templates load. The pane's Imports accordion was empty for any
  // corpus without Python files because this gated on pyFiles — the GUI sibling
  // of the "Python only" claim the CLI dropped in 3c3b903.
  const { rows, filesByLang } = extractImports(index);

  const byLib = new Map();
  for (const r of rows) {
    const lib = r.target.split('.')[0] || r.target;
    let g = byLib.get(lib);
    if (!g) { g = { library: lib, count: 0, targets: new Set(), sites: [] }; byLib.set(lib, g); }
    g.count++;
    g.targets.add(r.target);
    if (g.sites.length < 200) g.sites.push({ name: r.target, filepath: r.file, line: r.line });
  }
  const match = q.filter ? makeFilterMatcher(q.filter) : null;
  let libs = [...byLib.values()].filter(g => !match || match(g.library));
  libs.sort((a, b) => b.count - a.count || a.library.localeCompare(b.library));
  const max = safeMax(q.max, 500);
  jsonResponse(res, {
    total: libs.length,
    instances: rows.length,
    filesByLang: filesByLang || {},
    imports: libs.slice(0, max).map(g => ({
      library: g.library, count: g.count, targets: g.targets.size, sites: g.sites,
    })),
  });
};

// gui-bom-imports-section: the bill of materials as the CLI prints it, one
// fetch — the class rollup, the ranked external surface with sites and each
// row's reason, vendored subtrees, manifests, lockfiles, the joins, coverage.
routes['/api/bom'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  jsonResponse(res, bomReport(index, { filter: q.filter || null, max: safeMax(q.max, 500) }));
};

// The in-tree half: copyright holders with the first-vs-third presumption
// (marked presumptive, with its reason), license identifiers, license
// documents apart, bundles. --filter matches the holder or a path.
routes['/api/copyrights'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const cr = copyrightNotices(index);
  const match = q.filter ? makeFilterMatcher(q.filter) : null;
  const holders = cr.holders.filter((hd) => !match || match(hd.holder) || hd.sites.some((s) => match(s.file)));
  const max = safeMax(q.max, 500);
  jsonResponse(res, {
    scanned: cr.scanned, withNotice: cr.withNotice, noNotice: cr.noNotice,
    total: holders.length,
    holders: holders.slice(0, max).map((hd) => ({
      holder: hd.holder, files: hd.files, spellings: hd.spellings, presumption: hd.presumption, reason: hd.reason,
      embeddedOnly: hd.embeddedOnly, vendoredFiles: hd.vendoredFiles, example: hd.example,
      sites: hd.sites.map((s) => ({ filepath: s.file, line: s.line, embedded: !!s.embedded })),
    })),
    dominant: cr.dominant ? cr.dominant.holder : null, tie: cr.tie,
    licenses: cr.licenses, documents: cr.documents, bundles: cr.bundles,
  });
};

// #168 Infrastructure — non-AI/ML operational stack by file shape, grouped into
// cells (Containers / Kubernetes / IaC / CI-CD). Mirrors /api/imports' shape:
// top-level rows are cells, each with a kind breakdown + drill-down sites.
routes['/api/infrastructure'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const { rows, filesScanned } = detectInfrastructure(index);
  const match = q.filter ? makeFilterMatcher(q.filter) : null;
  const found = rows.filter(r => !match || match(r.name, r.filepath, r.cell, r.kind));

  const byCell = new Map();
  for (const r of found) {
    let g = byCell.get(r.cell);
    if (!g) { g = { cell: r.cell, count: 0, kinds: {}, sites: [] }; byCell.set(r.cell, g); }
    g.count++;
    g.kinds[r.kind] = (g.kinds[r.kind] || 0) + 1;
    if (g.sites.length < 500) g.sites.push({ name: r.name, filepath: r.filepath, line: r.line, kind: r.kind, tag: r.tag, marker: r.marker });
  }
  const order = { Containers: 0, Kubernetes: 1, 'IaC': 2, Cloud: 3, 'CI/CD': 4 };
  const cells = [...byCell.values()].sort((a, b) => (order[a.cell] ?? 9) - (order[b.cell] ?? 9));
  const max = safeMax(q.max, 500);
  jsonResponse(res, {
    total: cells.length,
    instances: found.length,
    filesScanned,
    infrastructure: cells.slice(0, max).map(g => ({
      cell: g.cell,
      count: g.count,
      kinds: Object.entries(g.kinds).map(([k, n]) => `${k}:${n}`).join(', '),
      sites: g.sites,
    })),
  });
};

routes['/api/list-datasets'] = drilldownRoute('listDatasets', DATASETS_DRILLDOWN, 'datasets');

// #134 batch 2: all six marker-driven cells now go through the same drilldownRoute.
routes['/api/list-training'] = drilldownRoute('listTraining', TRAINING_DRILLDOWN, 'training');
routes['/api/list-inference'] = drilldownRoute('listInference', INFERENCE_DRILLDOWN, 'inference');
routes['/api/list-llm-calls'] = drilldownRoute('listLlmCalls', LLMCALLS_DRILLDOWN, 'calls');
routes['/api/list-tools'] = drilldownRoute('listTools', TOOLS_DRILLDOWN, 'tools');
routes['/api/list-chains'] = drilldownRoute('listChains', CHAINS_DRILLDOWN, 'chains');
routes['/api/list-embeddings'] = drilldownRoute('listEmbeddings', EMBEDDINGS_DRILLDOWN, 'embeddings');
routes['/api/list-structured-output'] = drilldownRoute('listStructuredOutput', STRUCTURED_OUTPUT_DRILLDOWN, 'items');

routes['/api/list-models-used'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const models = index.listModelsUsed(q.filter);  // sorted: access, count; .unresolved attached
  const max = safeMax(q.max, 500);
  jsonResponse(res, {
    total: models.length,
    unresolved: models.unresolved || 0,
    models: models.slice(0, max).map(m => ({
      model: m.model, access: m.access, cells: m.cells, count: m.count, isTest: m.isTest || false,
      sites: (m.sites || []).slice(0, 50),
    })),
  });
};

routes['/api/list-pipelines'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const flows = index.listPipelines(q.filter);  // sorted: scope, shape priority, cellCount
  const max = safeMax(q.max, 500);
  // #142 drill-down dedupe: collapse identical-signature flows (same shape + same
  // ordered stage cells/first-ids) into groups so the GUI shows one row per group
  // + ×count, then drills into the group's members. Each member keeps its full
  // `stages`, so renderPipelineStages still works at the leaf. The flat
  // listPipelines is unchanged, so --multi-index consumers are unaffected.
  const slimRow = (w) => ({
    shape: w.shape, shapes: w.shapes, scope: w.scope, location: w.location, cellCount: w.cellCount, loop: w.loop || null, isTest: w.isTest || false,
    stages: (w.stages || []).map(s => ({ cell: s.cell, ids: s.ids, count: s.count, sites: (s.sites || []).slice(0, 50) })),
  });
  const groups = groupPipelines(flows);
  jsonResponse(res, {
    total: flows.length,
    groups: groups.slice(0, max).map(g => ({
      sig: g.sig, rep: slimRow(g.rep), count: g.count, members: g.members.map(slimRow),
    })),
  });
};

routes['/api/class-methods'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const className = q.name;
  if (!className) return errorResponse(res, 'Missing ?name= parameter');
  const allClasses = index.listClasses();
  const cls = allClasses.find(c => c.name === className);
  if (!cls) return errorResponse(res, `Class '${className}' not found`, 404);
  jsonResponse(res, {
    name: cls.name, filepath: cls.filepath, method_count: cls.method_count,
    total_lines: cls.total_method_lines, inferred: cls.inferred || false,
    methods: (cls.methods || []).map(m => ({ name: m.name, filepath: m.filepath, start: m.start, end: m.end, lines: m.lines || (m.end - m.start + 1) })),
  });
};


// --- Func Dupes ---

routes['/api/func-dupes'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 30;
  const minLines = parseInt(q.min_lines) || 3;
  let groups = index.getFuncDupes(n, minLines, true);
  if (q.filter) { const match = makeFilterMatcher(q.filter); groups = groups.filter(g => match(g.bare_name, ...g.instances.map(i => i.filepath))); }
  jsonResponse(res, {
    total: groups.length,
    groups: groups.slice(0, n).map((g, i) => ({
      rank: i + 1, name: g.bare_name, lines: g.lines, count: g.count, waste: g.waste,
      instances: g.instances.slice(0, 5).map(inst => ({
        filepath: inst.filepath, name: inst.name,
        display_name: displayName(inst.name, inst.filepath),
        start: inst.start, lines: inst.lines,
      })),
    })),
  });
};

routes['/api/near-dupes'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 30;
  index.getFuncDupes(n, 3, true);
  let groups = index.getNearDupes(n);
  if (q.filter) { const match = makeFilterMatcher(q.filter); groups = groups.filter(g => match(g.bare_name, ...g.instances.map(i => i.filepath))); }
  jsonResponse(res, {
    total: groups.length,
    groups: groups.slice(0, n).map((g, i) => ({
      rank: i + 1, name: g.bare_name, lines: g.lines, count: g.count, variants: g.unique_variants || 0,
      instances: g.instances.slice(0, 5).map(inst => ({
        filepath: inst.filepath, name: inst.name,
        display_name: displayName(inst.name, inst.filepath),
        start: inst.start, lines: inst.lines,
      })),
    })),
  });
};

routes['/api/struct-dupes'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 30;
  index.getFuncDupes(n, 3, true);
  let groups = index.getStructDupes(n);
  if (q.filter) { const match = makeFilterMatcher(q.filter); groups = groups.filter(g => match(g.bare_name, ...g.instances.map(i => i.filepath))); }
  jsonResponse(res, {
    total: groups.length,
    groups: groups.slice(0, n).map((g, i) => ({
      rank: i + 1, name: g.bare_name, lines: g.lines, count: g.count,
      unique_bodies: g.unique_bodies || 0, waste: g.waste,
      files: g.instances.slice(0, 5).map(inst => inst.filepath),
      instances: g.instances.map(inst => ({
        filepath: inst.filepath,
        name: index.getDisplayName(inst.name),
        display_name: index.getDisplayName(displayName(inst.name, inst.filepath)),
        start: inst.start, lines: inst.lines,
      })),
    })),
  });
};


// --- Funcstring (structural normalization) ---

routes['/api/funcstring'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const funcSpec = q.func;
  if (!funcSpec) return errorResponse(res, 'Missing ?func= parameter');
  const { funcName, fileHint } = parseFuncSpec(funcSpec);
  const matches = index.findFunctionMatches(funcName, fileHint);
  if (matches.length === 0) return errorResponse(res, `Function '${funcName}' not found`, 404);
  const m = matches[0];
  const source = index.getFunctionSource(m.filepath, m.name);
  if (!source) return errorResponse(res, 'Source not available', 404);
  const funcstring = index.getStructuralNormalized(source);
  jsonResponse(res, {
    filepath: m.filepath, name: m.name,
    display_name: displayName(m.name, m.filepath),
    lines: m.end - m.start + 1,
    funcstring,
  });
};


// --- Surprising funcstrings (codebase-wide scan for groups with high-surprise pairs) ---

routes['/api/surprising-funcstrings'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const minLines = q.minLines ? Math.max(3, parseInt(q.minLines)) : 3;
  const minPeakSurprise = q.minSurprise ? parseFloat(q.minSurprise) : 0.5;
  const includeAllExactGroups = q.includeAllExact === '1' || q.includeAllExact === 'true';
  const limit = q.limit ? Math.max(1, Math.min(500, parseInt(q.limit))) : 100;
  const sortBy = ['peak', 'mean', 'lines'].includes(q.sortBy) ? q.sortBy : 'peak';
  const tight = q.tight === '1' || q.tight === 'true';
  const result = index.findSurprisingStructGroups({
    minLines, minPeakSurprise, includeAllExactGroups, limit, sortBy, tight,
  });
  // Optional filter on instance names or filepaths (matches existing dupe routes)
  let groups = result.groups;
  if (q.filter) {
    const match = makeFilterMatcher(q.filter);
    groups = groups.filter(g =>
      g.instances.some(i => match(i.name, i.filepath))
    );
  }
  jsonResponse(res, {
    total: groups.length,
    total_unfiltered: result.total,
    truncated: result.truncated,
    sortBy,
    groups: groups.map((g, i) => ({
      rank: i + 1,
      struct_hash: g.struct_hash,
      count: g.count,
      lines: g.lines,
      raw_lines: g.raw_lines,
      unique_bodies: g.uniqueBodies,
      all_exact: g.allExact,
      peak_surprise: g.peakSurprise,
      mean_surprise: g.meanSurprise,
      pairs_sampled: g.pairsSampled,
      peak_pair: g.peakPair,
      instances: g.instances.map(inst => ({
        filepath: inst.filepath,
        name: inst.name,
        display_name: inst.displayName,
        start: inst.start, end: inst.end,
        lines: inst.lines,
        raw_lines: inst.raw_lines,
        body_hash: inst.body_hash,
        exact_copies: inst.exact_copies,
      })),
    })),
  });
};


// --- Funcstring peers (search by structural hash with surprise ranking) ---

routes['/api/funcstring-peers'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const funcSpec = q.func;
  if (!funcSpec) return errorResponse(res, 'Missing ?func= parameter');
  const { funcName, fileHint } = parseFuncSpec(funcSpec);
  const includeExact = q.includeExact === '1' || q.includeExact === 'true';
  const minSurprise = q.minSurprise ? parseFloat(q.minSurprise) : 0;
  const limit = q.limit ? Math.max(1, Math.min(500, parseInt(q.limit))) : 200;
  const tight = q.tight === '1' || q.tight === 'true';
  const result = index.findFuncstringPeers(funcName, fileHint, {
    includeExact, minSurprise, limit, tight,
  });
  if (result.error) return errorResponse(res, result.error, 404);
  jsonResponse(res, {
    query: {
      filepath: result.query.filepath,
      name: result.query.name,
      display_name: result.query.displayName,
      lines: result.query.lines,
      struct_hash: result.query.struct_hash,
      body_hash: result.query.body_hash,
    },
    matches: result.matches,
    total_peers: result.totalPeers,
    truncated: result.truncated,
    peers: result.peers.map(p => ({
      filepath: p.filepath,
      name: p.name,
      display_name: p.displayName,
      start: p.start,
      end: p.end,
      lines: p.lines,
      kind: p.kind,
      surprise: p.surprise,
    })),
  });
};


// --- Structural diff all ---

routes['/api/struct-diff-all'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 30;
  index.getFuncDupes(n, 3, false);
  let groups = index.getStructDupes(n);
  if (q.filter) { const match = makeFilterMatcher(q.filter); groups = groups.filter(g => match(g.bare_name, ...g.instances.map(i => i.filepath))); }
  const results = [];
  for (let i = 0; i < Math.min(groups.length, n); i++) {
    const g = groups[i];
    const bodies = g.instances.map(inst => {
      const src = index.getFunctionSource(inst.filepath, inst.name);
      return { filepath: inst.filepath, name: inst.name, body: src || '' };
    }).filter(b => b.body);
    let diff = null;
    if (bodies.length >= 2) {
      try { diff = index.structDiff(bodies); } catch { /* ignore */ }
    }
    results.push({
      rank: i + 1,
      name: g.bare_name,
      count: g.count,
      unique_bodies: g.unique_bodies || 0,
      lines: g.lines,
      summary: diff ? diff.summary : '(diff unavailable)',
      totalHoles: diff ? diff.totalWordHoles : 0,
      diffCount: diff ? diff.diffs.length : 0,
      substitutions: diff ? diff.substitutions.slice(0, 5) : [],
      instances: g.instances.slice(0, 6).map(inst => ({
        filepath: inst.filepath,
        name: inst.name,
        display_name: displayName(inst.name, inst.filepath),
      })),
    });
  }
  jsonResponse(res, { total: results.length, groups: results });
};


// --- Build LLM analysis prompt ---

routes['/api/build-prompt'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);
      const mode = params.mode;
      const mask = !!params.mask;
      const maskComments = !!params.maskComments;
      const lineNumbers = !!params.lineNumbers;
      const masker = (mask || maskComments) ? new SimpleMasker() : null;

      if (mode === 'analyze' || mode === 'claim-analyze' || mode === 'multisect-analyze') {
        // Function-level analysis
        const funcSpec = params.func;
        if (!funcSpec) return errorResponse(res, 'Missing "func" parameter');
        const { funcName, fileHint } = parseFuncSpec(funcSpec);
        const matches = index.findFunctionMatches(funcName, fileHint);
        if (matches.length === 0) return errorResponse(res, `Function '${funcName}' not found`, 404);
        const m = matches[0];
        // Number from the range the SOURCE covers, not from m.start.
        // getFunctionSource prepends the preceding doc comment and says nothing
        // about it, while m.start is the SIGNATURE line — so m.start labels the
        // comment's first line as the signature and every citation is shifted.
        // Measured on .demo_code_only: 64 of 154 symbols (42%) carry a
        // prepended block, median 6 lines, max 25, varying per function so no
        // constant corrects it. Same defect 4b39295 repaired on the CLI side.
        const got = index.getFunctionSourceWithRange?.(m.filepath, m.name);
        let source = got?.source ?? index.getFunctionSource(m.filepath, m.name);
        if (!source) return errorResponse(res, 'Source not available', 404);
        const srcStart = got?.start ?? m.start;
        const lang = detectLanguage(m.filepath);
        if (mask) source = masker.maskFunctionSource(source, m.name, lang);
        else if (maskComments) source = masker.stripComments(source, lang);
        if (lineNumbers) source = addLineNumbers(source, srcStart);

        // Determine masking state for prompt preamble
        const maskState = mask ? 'masked' : maskComments ? 'comments' : false;

        let prompt;
        if (mode === 'analyze') {
          prompt = buildAnalyzePrompt(source, m.name, m.filepath, maskState);
        } else if (mode === 'claim-analyze') {
          const claim = params.claim;
          if (!claim) return errorResponse(res, 'Missing "claim" parameter');
          prompt = buildClaimAnalyzePrompt(source, m.name, m.filepath, claim, maskState);
        } else {
          const terms = params.terms;
          if (!terms) return errorResponse(res, 'Missing "terms" parameter');
          const termList = typeof terms === 'string' ? terms.split(';').map(t => t.trim()).filter(Boolean) : terms;
          prompt = buildMultisectAnalyzePrompt(source, m.name, m.filepath, termList, maskState);
        }
        jsonResponse(res, {
          mode, prompt,
          target: displayName(m.name, m.filepath),
          filepath: m.filepath,
          lines: m.end - m.start + 1,
        });

      } else if (mode === 'file-analyze') {
        const filePath = params.file;
        if (!filePath) return errorResponse(res, 'Missing "file" parameter');
        const pathMatches = index.findPathMatches(filePath);
        const exactFiles = pathMatches.filter(m => index.files.has(m));
        if (exactFiles.length === 0) return errorResponse(res, `File '${filePath}' not found`, 404);
        const fp = exactFiles[0];
        let source = index.files.get(fp) || '';
        const lang = detectLanguage(fp);
        if (mask) source = masker.mask(source, lang);
        else if (maskComments) source = masker.stripComments(source, lang);
        if (lineNumbers) source = addLineNumbers(source);
        const funcNames = Object.keys(index.functionIndex?.[fp] || {});
        const maskState = mask ? 'masked' : maskComments ? 'comments' : false;
        const prompt = buildFileAnalyzePrompt(source, fp, maskState, funcNames);
        jsonResponse(res, { mode, prompt, target: fp, filepath: fp });

      } else {
        return errorResponse(res, `Unknown mode: ${mode}`, 400);
      }
    } catch (err) {
      errorResponse(res, `Build prompt error: ${err.message}`, 500);
    }
  });
};


// --- Claim search (heuristic keyword extraction + multisect) ---

routes['/api/claim-search'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 500_000) req.destroy(); });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);
      const claim = params.claim;
      if (!claim) return errorResponse(res, 'Missing "claim" parameter');

      // Extract keywords heuristically (no LLM needed)
      const keywords = extractClaimKeywords(claim);
      if (keywords.size === 0) return errorResponse(res, 'No searchable keywords found in claim text');

      // Convert to multisect terms (each keyword as a separate search term)
      const termStrings = [...keywords].join(';');
      const parsed = parseMultisectTerms(termStrings);
      if (!parsed || parsed.length === 0) return errorResponse(res, 'No valid search terms parsed');

      const maxResults = parseInt(params.max) || 25;
      const views = _runMultisectViews(index, parsed, 0, maxResults, false);
      jsonResponse(res, { keywords: [...keywords], ...views });
    } catch (err) {
      errorResponse(res, `Claim search error: ${err.message}`, 500);
    }
  });
};


// --- Claim extraction prompt (LLM prompt builder for claim-search) ---

routes['/api/claim-extraction-prompt'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 500_000) req.destroy(); });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);
      const claim = params.claim;
      if (!claim) return errorResponse(res, 'Missing "claim" parameter');
      const claimRes = resolveAtFile(claim);
      if (claimRes.error) return errorResponse(res, claimRes.error, 400);
      const claimText = claimRes.text;

      const engine = params.engine || 'claude';   // 'claude' or 'local'
      const vocabTight = !!params.vocabTight;
      const noVocab = !!params.noVocabulary;

      // Extract heuristic keywords for vocabulary filtering
      const claimKeywords = extractClaimKeywords(claimText);

      // Build vocabulary concordance
      let vocabConcordance = '';
      if (!noVocab) {
        try {
          const format = engine === 'local' ? 'compact' : 'rich';
          vocabConcordance = index.formatVocabularyForPrompt(format, {
            // topN selects which compounds get SPLIT; maxSubTokens caps what is
            // EMITTED. They are independent, so a large topN costs build time only
            // (3ms -> 20ms at 15000), never prompt budget. 15000 is not a tuned
            // number: vocabulary.js caps the cached vocabulary at slice(0, 15000),
            // so this means 'the whole vocabulary' -- do not pre-truncate, let the
            // cross-corpus weight select. At topN 200 the pool was nearly all
            // boilerplate and the weight had nothing better to promote.
            topN: 15000,
            maxSubTokens: engine === 'local' ? 80 : 150,
            maxFuncNames: engine === 'local' ? 0 : 40,
            claimKeywords,
          });
        } catch (e) {
          // Vocabulary is optional
        }
      }

      // Build the extraction prompt
      let systemPrompt;
      if (engine === 'local') {
        systemPrompt = vocabConcordance
          ? buildLocalExtractionPromptWithVocab(vocabConcordance, vocabTight)
          : CLAIM_EXTRACTION_PROMPT_LOCAL;
      } else {
        systemPrompt = vocabConcordance
          ? buildExtractionPromptWithVocab(vocabConcordance, vocabTight)
          : CLAIM_EXTRACTION_PROMPT;
      }

      jsonResponse(res, {
        systemPrompt,
        userMessage: claimText.trim(),
        keywords: [...claimKeywords],
        vocabChars: vocabConcordance.length,
        engine,
      });
    } catch (err) {
      errorResponse(res, `Extraction prompt error: ${err.message}`, 500);
    }
  });
};


// --- LLM-powered claim search (term extraction + multisect) ---

routes['/api/claim-search-llm'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 500_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);

      const claim = params.claim;
      if (!claim) return errorResponse(res, 'Missing "claim" parameter');

      // Resolve @filepath references in claim text
      const claimResolved = resolveAtFile(claim);
      if (claimResolved.error) return errorResponse(res, claimResolved.error, 400);
      const claimText = claimResolved.text;

      const engine = params.engine || 'claude';
      const vocabTight = !!params.vocabTight;
      const noVocab = !!params.noVocabulary;
      const temperature = params.temperature ?? serverArgs.temperature;
      const maxResults = parseInt(params.max) || 25;
      const userMinTerms = parseInt(params.minTerms) || 0;  // 0 = auto
      // Optional user-supplied selectivity threshold (0..1). If null/undefined,
      // server-side tier defaults apply (TIGHT 0.5, BROAD 0.7). A value of 1.0
      // effectively disables the filter; 0.0 drops every positive term.
      const userSelThreshold = (typeof params.selectivityThreshold === 'number' && params.selectivityThreshold >= 0 && params.selectivityThreshold <= 1)
        ? params.selectivityThreshold
        : null;
      const includePath = (typeof params.in === 'string' && params.in.trim()) ? params.in.trim() : null;

      // Check LLM availability
      const avail = serverLLM.checkAvailability(engine);
      if (!avail.available) return errorResponse(res, avail.reason, 400);

      console.log(`  [claim-search-llm] engine=${engine}, claim=${claimText.length} chars${claimResolved.resolvedFrom ? ' (from ' + claimResolved.resolvedFrom + ')' : ''}`);

      // --- Build vocabulary concordance ---
      let vocabConcordance = '';
      const claimKeywords = extractClaimKeywords(claimText);
      if (!noVocab) {
        try {
          const format = engine === 'local' ? 'compact' : 'rich';
          vocabConcordance = index.formatVocabularyForPrompt(format, {
            // topN selects which compounds get SPLIT; maxSubTokens caps what is
            // EMITTED. They are independent, so a large topN costs build time only
            // (3ms -> 20ms at 15000), never prompt budget. 15000 is not a tuned
            // number: vocabulary.js caps the cached vocabulary at slice(0, 15000),
            // so this means 'the whole vocabulary' -- do not pre-truncate, let the
            // cross-corpus weight select. At topN 200 the pool was nearly all
            // boilerplate and the weight had nothing better to promote.
            topN: 15000,
            maxSubTokens: engine === 'local' ? 80 : 150,
            maxFuncNames: engine === 'local' ? 0 : 40,
            claimKeywords,
          });
        } catch (e) { /* vocabulary is optional */ }
      }

      // --- Build extraction prompt ---
      let systemPrompt;
      if (engine === 'local') {
        systemPrompt = vocabConcordance
          ? buildLocalExtractionPromptWithVocab(vocabConcordance, vocabTight)
          : CLAIM_EXTRACTION_PROMPT_LOCAL;
      } else {
        systemPrompt = vocabConcordance
          ? buildExtractionPromptWithVocab(vocabConcordance, vocabTight)
          : CLAIM_EXTRACTION_PROMPT;
      }

      // For local models with limited context, use first claim only
      let claimForLLM = claimText.trim();
      let skippedClaims = 0;
      if (engine === 'local') {
        const { text, skipped } = extractFirstClaim(claimForLLM);
        claimForLLM = text;
        skippedClaims = skipped;
      }

      // --- Call LLM for term extraction ---
      console.log(`  [claim-search-llm] Calling ${engine} for term extraction...`);
      const userMessage = engine === 'local'
        ? 'Extract search terms from this patent claim:\n\n' + claimForLLM
        : claimForLLM;
      const llmResult = await serverLLM.call(engine, systemPrompt, userMessage, {
        apiKey: params.apiKey,
        temperature,
        maxTokens: 2048,
      });

      if (llmResult.error) {
        return errorResponse(res, `LLM error: ${llmResult.error}`, 502);
      }

      // --- Parse TIGHT / BROAD from LLM response ---
      const rawResponse = llmResult.text;
      console.log(`  [claim-search-llm] Raw LLM response:\n    ${rawResponse.replace(/\n/g, '\n    ')}`);
      const parsed = parseTermResponse(rawResponse);
      let tightStr = parsed.tight;
      let broadStr = parsed.broad;

      // Sanitize (collect per-tier meta so the GUI can show what got truncated).
      // Drop stop-listed terms first, so the term cap counts cleaned terms only.
      const tightSanitizeMeta = {};
      const broadSanitizeMeta = {};
      if (tightStr) tightStr = dropStopListedTerms(tightStr, 'TIGHT');
      if (broadStr) broadStr = dropStopListedTerms(broadStr, 'BROAD');
      if (tightStr) tightStr = sanitizeLlmTerms(tightStr, 'TIGHT', tightSanitizeMeta);
      if (broadStr) broadStr = sanitizeLlmTerms(broadStr, 'BROAD', broadSanitizeMeta);
      if (broadStr) broadStr = sanitizeBroadTerms(broadStr);

      const sumHits = (v) => (v ? v.function_matches.length + v.class_matches.length
        + v.file_matches.length + v.folder_matches.length : 0);

      // Selectivity threshold per tier. TIGHT stricter; BROAD looser since
      // its whole point is to be expansive. User override (from workspace
      // input) replaces BOTH defaults when provided.
      const TIGHT_THRESHOLD = userSelThreshold !== null ? userSelThreshold : 0.5;
      const BROAD_THRESHOLD = userSelThreshold !== null ? userSelThreshold : 0.7;

      // --- Run multisect for TIGHT ---
      let tightViews = null;
      if (tightStr) {
        const allTightTerms = parseMultisectTerms(tightStr);
        const filter = filterLowSelectivity(index, allTightTerms, { threshold: TIGHT_THRESHOLD, label: 'TIGHT' });
        const tightTerms = filter.kept;
        if (tightTerms && tightTerms.length > 0) {
          const positiveTerms = tightTerms.filter(t => !t.negated);
          const minTerms = userMinTerms > 0 ? userMinTerms : Math.max(Math.floor(positiveTerms.length * 0.80), 2);
          tightViews = _runMultisectViews(index, tightTerms, minTerms, maxResults, false, includePath);
          tightViews.termsStr = tightStr;
          tightViews.sanitize_meta = tightSanitizeMeta;
          tightViews.selectivity_filter = { threshold: filter.threshold, total_files: filter.total_files, dropped: filter.dropped };
          console.log(`  [claim-search-llm] TIGHT: ${positiveTerms.length} positive terms (after selectivity filter dropped ${filter.dropped.length}), min=${minTerms}${userMinTerms > 0 ? ' (user)' : ''}, ${sumHits(tightViews)} hits across scopes`);
        }
      }

      // --- Run multisect for BROAD ---
      let broadViews = null;
      if (broadStr) {
        const allBroadTerms = parseMultisectTerms(broadStr);
        const filter = filterLowSelectivity(index, allBroadTerms, { threshold: BROAD_THRESHOLD, label: 'BROAD' });
        const broadTermsParsed = filter.kept;
        if (broadTermsParsed && broadTermsParsed.length > 0) {
          const positiveTerms = broadTermsParsed.filter(t => !t.negated);
          const minTerms = userMinTerms > 0 ? userMinTerms : Math.max(Math.floor(positiveTerms.length * 0.60), 3);
          broadViews = _runMultisectViews(index, broadTermsParsed, minTerms, maxResults, false, includePath);
          broadViews.termsStr = broadStr;
          broadViews.sanitize_meta = broadSanitizeMeta;
          broadViews.selectivity_filter = { threshold: filter.threshold, total_files: filter.total_files, dropped: filter.dropped };
          console.log(`  [claim-search-llm] BROAD: ${positiveTerms.length} positive terms (after selectivity filter dropped ${filter.dropped.length}), min=${minTerms}${userMinTerms > 0 ? ' (user)' : ''}, ${sumHits(broadViews)} hits across scopes`);
        }
      }

      // --- Build response ---
      jsonResponse(res, {
        engine,
        raw: rawResponse,
        skippedClaims,
        vocabChars: vocabConcordance.length,
        vocabTight: vocabTight && vocabConcordance.length > 0,
        usage: llmResult.usage || null,
        tight: tightViews,
        broad: broadViews,
      });
    } catch (err) {
      console.error('  [claim-search-llm] Error:', err);
      errorResponse(res, `Claim search LLM error: ${err.message}`, 500);
    }
  });
};


// --- LLM-powered code analysis ---

routes['/api/analyze-llm'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 500_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);

      const engine = params.engine || 'claude';
      const mode = params.mode || 'analyze';  // 'analyze' | 'claim-analyze' | 'multisect-analyze' | 'context-analyze' | 'file-analyze'
      const mask = !!params.mask;
      const maskComments = !!params.maskComments;
      const lineNumbers = params.lineNumbers !== false;
      const temperature = params.temperature ?? serverArgs.temperature;

      // Check LLM availability
      const avail = serverLLM.checkAvailability(engine);
      if (!avail.available) return errorResponse(res, avail.reason, 400);

      let prompt, target, filepath, lines;
      // Determine masking state for prompt preamble: 'masked' (full), 'comments' (layer 1 only), or false
      const maskState = mask ? 'masked' : maskComments ? 'comments' : false;

      if (mode === 'file-analyze') {
        // --- File-level analysis ---
        const filePath = params.file;
        if (!filePath) return errorResponse(res, 'Missing "file" parameter');
        const pathMatches = index.findPathMatches(filePath);
        const exactFiles = pathMatches.filter(m => index.files.has(m));
        if (exactFiles.length === 0) return errorResponse(res, `File '${filePath}' not found`, 404);
        const fp = exactFiles[0];
        let source = index.files.get(fp) || '';
        const nLines = source.split('\n').length;
        const maxLines = engine === 'local' ? 200 : 500;
        if (nLines > maxLines) return errorResponse(res, `File too large (${nLines} lines, max ${maxLines} for ${engine})`, 400);
        const lang = detectLanguage(fp);
        const masker = new SimpleMasker();
        if (mask) source = masker.mask(source, lang);
        else if (maskComments) source = masker.stripComments(source, lang);
        if (lineNumbers) source = addLineNumbers(source);
        const funcNames = Object.keys(index.functionIndex?.[fp] || {});
        prompt = buildFileAnalyzePrompt(source, fp, maskState, funcNames);
        target = fp;
        filepath = fp;
        lines = nLines;
        console.log(`  [analyze-llm] file-analyze on ${fp} (${nLines} lines), engine=${engine}`);

      } else {
        // --- Function-level analysis ---
        const funcSpec = params.func;
        if (!funcSpec) return errorResponse(res, 'Missing "func" parameter');
        const { funcName, fileHint } = parseFuncSpec(funcSpec);
        const matches = index.findFunctionMatches(funcName, fileHint);
        if (matches.length === 0) return errorResponse(res, `Function '${funcName}' not found`, 404);
        const m = matches[0];

        // Number from the range the SOURCE covers, not from m.start — see the
        // sibling site above; getFunctionSource prepends the doc comment.
        const got = index.getFunctionSourceWithRange?.(m.filepath, m.name);
        let source = got?.source ?? index.getFunctionSource(m.filepath, m.name);
        if (!source) return errorResponse(res, 'Source not available', 404);
        const srcStart = got?.start ?? m.start;

        const lang = detectLanguage(m.filepath);
        const masker = new SimpleMasker();
        if (mask) source = masker.maskFunctionSource(source, m.name, lang);
        else if (maskComments) source = masker.stripComments(source, lang);
        if (lineNumbers) source = addLineNumbers(source, srcStart);

        if (mode === 'claim-analyze') {
          let claim = params.claim;
          if (!claim) return errorResponse(res, 'Missing "claim" parameter');
          const claimRes = resolveAtFile(claim);
          if (claimRes.error) return errorResponse(res, claimRes.error, 400);
          prompt = buildClaimAnalyzePrompt(source, m.name, m.filepath, claimRes.text, maskState);
        } else if (mode === 'multisect-analyze') {
          const terms = params.terms;
          if (!terms) return errorResponse(res, 'Missing "terms" parameter');
          const termList = typeof terms === 'string' ? terms.split(';').map(t => t.trim()).filter(Boolean) : terms;
          prompt = buildMultisectAnalyzePrompt(source, m.name, m.filepath, termList, maskState);
        } else if (mode === 'context-analyze') {
          let contextText = params.contextText;
          if (!contextText) return errorResponse(res, 'Missing "contextText" parameter');
          const ctxResolved = resolveAtFile(contextText);
          if (ctxResolved.error) return errorResponse(res, ctxResolved.error, 400);
          contextText = ctxResolved.text;
          prompt = buildContextAnalyzePrompt(source, m.name, m.filepath, contextText, maskState);
        } else {
          prompt = buildAnalyzePrompt(source, m.name, m.filepath, maskState);
        }

        target = displayName(m.name, m.filepath);
        filepath = m.filepath;
        lines = m.end - m.start + 1;
        console.log(`  [analyze-llm] ${mode} on ${m.filepath}@${m.name} (${lines} lines), engine=${engine}`);

        // Optional: prepend mechanical static-analysis digest to the prompt.
        if (params.withDigest && index.buildFunctionDigest) {
          try {
            const digestObj = index.buildFunctionDigest(`${m.filepath}@${m.name}`);
            if (digestObj) {
              const digestText = formatFunctionDigest(digestObj);
              prompt =
                `Below is a mechanical static-analysis digest of the function you are about to analyze.\n` +
                `Use it as factual context (call graph, strings, breadcrumbs, dupes) — but base your analysis on the source code shown after it.\n\n` +
                `=== BEGIN STATIC-ANALYSIS DIGEST ===\n${digestText}=== END STATIC-ANALYSIS DIGEST ===\n\n${prompt}`;
            }
          } catch (e) {
            console.error('  [analyze-llm] digest-prepend failed:', e.message);
          }
        }
      }

      // --- Call LLM ---
      const systemMsg = 'You are a code analysis assistant. Be precise and concise.';
      const llmResult = await serverLLM.call(engine, systemMsg, prompt, {
        apiKey: params.apiKey,
        temperature,
        maxTokens: engine === 'local' ? 600 : 800,
      });

      if (llmResult.error) {
        return errorResponse(res, `LLM error: ${llmResult.error}`, 502);
      }

      jsonResponse(res, {
        mode, engine,
        analysis: llmResult.text,
        prompt,
        target, filepath, lines,
        usage: llmResult.usage || null,
      });
    } catch (err) {
      console.error('  [analyze-llm] Error:', err);
      errorResponse(res, `Analyze LLM error: ${err.message}`, 500);
    }
  });
};


/** Helper: run multisect and format results into unified array. */
/**
 * Run multisect and return per-scope arrays (function/class/file/folder)
 * with IDF reranking, scope dedup, and per-scope caps. Used by /api/multisect,
 * /api/claim-search, and /api/claim-search-llm.
 */
function _runMultisectViews(index, terms, minTerms, maxPerScope, verbose, includePath = null, matchRenames = false) {
  const searchOpts = { minTerms };
  if (includePath) searchOpts.includePath = [includePath];
  if (matchRenames) searchOpts.matchRenames = true;
  const results = index.multisectSearch(terms, searchOpts);
  const nPositive = terms.filter(t => !t.negated).length;
  const totalFiles = (index.files && index.files.size) || 0;
  const views = prepareMultisectViews(results, { totalFiles, maxPerScope, verbose: !!verbose });
  return {
    terms: terms.map(t => ({ display: t.display, negated: t.negated, hard: t.hard !== false })),
    num_positive: nPositive,
    min_terms: results.min_terms,
    term_file_counts: results.term_file_counts || [],
    ...views,
  };
}


// ========================================================================
// Universal command execution via interactive dispatch
// ========================================================================

routes['/api/exec'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const cmd = q.cmd || q.command || '';
  if (!cmd) return errorResponse(res, 'Missing ?cmd= parameter');
  const max = safeMax(q.max, 25);

  const opts = {
    max,
    verbose: q.verbose === 'true',
    fullPath: q.fullpath === 'true',
    showDupes: q.showdupes === 'true',
    // LLM passthrough
    use_claude: !!serverLLM.defaultApiKey,
    api_key: serverLLM.defaultApiKey || null,
    analyze_model: serverArgs.modelPath || null,
    claim_model: serverArgs.modelPath || null,
    temperature: serverArgs.temperature || 0.0,
    mask_all: q.mask_all === 'true',
    line_numbers: q.line_numbers === 'true',
  };

  execCommand(index, cmd, opts).then(output => {
    jsonResponse(res, { command: cmd, output });
  }).catch(err => {
    errorResponse(res, `Exec error: ${err.message}`, 500);
  });
};


// ========================================================================
// Helpers
// ========================================================================

function guessLanguage(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const map = {
    '.js': 'javascript', '.ts': 'typescript', '.jsx': 'javascript',
    '.py': 'python', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
    '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby',
    '.go': 'go', '.rs': 'rust', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.scala': 'scala', '.m': 'objectivec',
    '.sql': 'sql', '.sh': 'bash', '.xml': 'xml', '.html': 'html',
    '.css': 'css', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  };
  return map[ext] || 'text';
}


// ========================================================================
// Router
// ========================================================================

// ========================================================================
// Chat about code (#36 Phase 1) — Claude engine, in-process MCP tools
//
// A multi-turn Claude tool loop that drives CE's own MCP tools IN-PROCESS
// (handleTool against the active GUI index via setIndex) — no second
// mcp-server subprocess, so chat sees exactly the index the GUI has loaded.
// Phase 2 (air-gapped local GGUF, mirroring ai-overview-local.js) is deferred
// until appropriate hardware (#36 / #196).
// ========================================================================

// The grounding clauses, the system prompt, and the three tool loops moved to
// core/chat-runner.js (cli-ask-ai) so the CLI's --ask-ai runs exactly what the
// GUI Chat runs. The wrappers below keep the routes' call sites unchanged: the
// cloud loops take the same options; the local loop gets this server's model
// holder and its lock.
function runChatToolLoop(opts) {
  return runChatToolLoopCore(opts);
}

function runChatToolLoopOpenAI(opts) {
  return runChatToolLoopOpenAICore(opts);
}

function runChatToolLoopLocal(opts) {
  return runChatToolLoopLocalCore({ ...opts, local: serverLLM, withLock: withLocalLock });
}


routes['/api/chat'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);
      const messages = params.messages;
      if (!Array.isArray(messages) || messages.length === 0) return errorResponse(res, 'messages array required', 400);
      // #243: engine is 'claude' (cloud), 'openai' (cloud, Part B), or 'local'
      // (GGUF, the air-gapped path). All three drive the same in-process CE
      // tool loop with engine-specific wire formats.
      // #247: an absent engine defaults to 'claude' (long-standing behavior), but
      // an unrecognized non-empty value is REJECTED rather than silently coerced
      // to the cloud path — a typo like "Local" must not send an intended-local
      // conversation to a cloud API.
      const engine = params.engine == null || params.engine === '' ? 'claude'
        : ['claude', 'local', 'openai', 'gemini'].includes(params.engine) ? params.engine
        : null;
      if (engine === null) return errorResponse(res, `Unknown chat engine "${params.engine}". Use 'claude', 'openai', 'gemini', or 'local'.`, 400);
      const indexName = params.index || mgr.activeIndex;
      const mode = CHAT_GROUNDING_CLAUSES[params.mode] ? params.mode : 'grounded';
      const avail = serverLLM.checkAvailability(engine);
      if (!avail.available) return errorResponse(res, avail.reason, 400);
      let content, answer;
      if (engine === 'local') {
        console.log(`  [chat] local GGUF over "${indexName}", grounding=${mode}`);
        ({ content, answer } = await runChatToolLoopLocal({
          messages, index, indexName, fileCount: index.files.size, mode,
          onToolCall: (name, input) => console.log(`  [chat] tool: ${name}(${JSON.stringify(input || {}).slice(0, 120)})`),
        }));
      } else if (engine === 'openai' || engine === 'gemini') {
        // #246: both openai-compat; Gemini injects its baseUrl/key/model.
        const gem = engine === 'gemini';
        const model = params.model || (gem ? serverLLM.defaultGeminiModel : serverLLM.defaultOpenAIModel);
        console.log(`  [chat] ${messages.length} msg(s) over "${indexName}", engine=${engine}, model=${model}, grounding=${mode}`);
        ({ content, answer } = await runChatToolLoopOpenAI({
          messages, index, indexName, fileCount: index.files.size, mode,
          apiKey: gem ? serverLLM.defaultGeminiKey : serverLLM.defaultOpenAIKey,
          baseUrl: gem ? PROVIDERS.gemini.baseUrl : undefined,
          model,
          onToolCall: (name, input) => console.log(`  [chat] tool: ${name}(${JSON.stringify(input || {}).slice(0, 120)})`),
        }));
      } else {
        const model = params.model || serverLLM.defaultClaudeModel || 'claude-sonnet-4-6';
        console.log(`  [chat] ${messages.length} msg(s) over "${indexName}", model=${model}, grounding=${mode}`);
        ({ content, answer } = await runChatToolLoop({
          messages, index, indexName, fileCount: index.files.size, mode,
          apiKey: serverLLM.defaultApiKey,
          model,
          temperature: params.temperature ?? 0,
          onToolCall: (name, input) => console.log(`  [chat] tool: ${name}(${JSON.stringify(input || {}).slice(0, 120)})`),
        }));
      }
      jsonResponse(res, { content, answer, index: indexName });
    } catch (e) {
      console.error('chat error:', e.message);
      errorResponse(res, `Chat error: ${e.message}`, 500);
    }
  });
};

// Tier-2 live progress (#36). Same tool loop as /api/chat, but streamed as
// Server-Sent Events so tool-call activity renders LIVE instead of a frozen
// "…thinking…" wait. The SSE payload is CE's OWN event shape (tool / done /
// error) — NOT a provider's token-delta format — so it stays provider-agnostic
// when a 2nd LLM (e.g. ChatGPT) is added. The buffered /api/chat route and
// runChatToolLoop are UNTOUCHED (the batch fallback); this only supplies an
// onToolCall that emits an event.
routes['/api/chat-stream'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy(); });
  req.on('end', async () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) { send('error', { error: 'No index loaded' }); return res.end(); }
      const messages = params.messages;
      if (!Array.isArray(messages) || messages.length === 0) { send('error', { error: 'messages array required' }); return res.end(); }
      // #243: 'claude' (cloud), 'openai' (cloud, Part B), or 'local' (GGUF);
      // tool calls stream live for all three.
      // #247: absent engine → 'claude' (default), but an unrecognized non-empty
      // value is rejected, never silently coerced to the cloud path.
      const engine = params.engine == null || params.engine === '' ? 'claude'
        : ['claude', 'local', 'openai', 'gemini'].includes(params.engine) ? params.engine
        : null;
      if (engine === null) { send('error', { error: `Unknown chat engine "${params.engine}". Use 'claude', 'openai', 'gemini', or 'local'.` }); return res.end(); }
      const indexName = params.index || mgr.activeIndex;
      const mode = CHAT_GROUNDING_CLAUSES[params.mode] ? params.mode : 'grounded';
      const avail = serverLLM.checkAvailability(engine);
      if (!avail.available) { send('error', { error: avail.reason }); return res.end(); }
      const onToolCall = (name, input) => {
        console.log(`  [chat-stream] tool: ${name}(${JSON.stringify(input || {}).slice(0, 120)})`);
        send('tool', { name, input });
      };
      let answer;
      if (engine === 'local') {
        console.log(`  [chat-stream] local GGUF over "${indexName}", grounding=${mode}`);
        ({ answer } = await runChatToolLoopLocal({
          messages, index, indexName, fileCount: index.files.size, mode, onToolCall,
        }));
      } else if (engine === 'openai' || engine === 'gemini') {
        // #246: both openai-compat; Gemini injects its baseUrl/key/model.
        const gem = engine === 'gemini';
        const model = params.model || (gem ? serverLLM.defaultGeminiModel : serverLLM.defaultOpenAIModel);
        console.log(`  [chat-stream] ${messages.length} msg(s) over "${indexName}", engine=${engine}, model=${model}, grounding=${mode}`);
        ({ answer } = await runChatToolLoopOpenAI({
          messages, index, indexName, fileCount: index.files.size, mode,
          apiKey: gem ? serverLLM.defaultGeminiKey : serverLLM.defaultOpenAIKey,
          baseUrl: gem ? PROVIDERS.gemini.baseUrl : undefined,
          model,
          onToolCall,
        }));
      } else {
        const model = params.model || serverLLM.defaultClaudeModel || 'claude-sonnet-4-6';
        console.log(`  [chat-stream] ${messages.length} msg(s) over "${indexName}", model=${model}, grounding=${mode}`);
        ({ answer } = await runChatToolLoop({
          messages, index, indexName, fileCount: index.files.size, mode,
          apiKey: serverLLM.defaultApiKey,
          model,
          temperature: params.temperature ?? 0,
          onToolCall,
        }));
      }
      // Only the final answer is needed client-side (tool calls already streamed
      // live); dropping the full block trace keeps the `done` frame small. Always
      // send it: gating on a req-'close' flag suppressed `done` because that event
      // fires when the request BODY finishes, not on client disconnect — which is
      // exactly what produced "(no text response)" with a valid answer server-side.
      // send()'s try/catch already no-ops a genuinely disconnected client.
      send('done', { answer, index: indexName });
      res.end();
    } catch (e) {
      console.error('chat-stream error:', e.message);
      send('error', { error: `Chat error: ${e.message}` });
      try { res.end(); } catch { /* */ }
    }
  });
};

function handleRequest(req, res) {
  // DNS-rebinding defense: when bound to loopback (the default), a request whose
  // Host header isn't a loopback name/address is a remote site reaching
  // 127.0.0.1 via rebinding — refuse it. Skipped when the user explicitly bound a
  // non-loopback --host (network exposure is then intentional; see the --host
  // caution in the docs — docs-host-network-exposure-warning).
  if (_LOCALHOST.test(serverArgs.host)) {
    const hostname = String(req.headers.host || '')
      .replace(/:\d+$/, '')       // strip :port
      .replace(/^\[|\]$/g, '')    // unwrap [::1]
      .toLowerCase();
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: unexpected Host header (possible DNS-rebinding attempt).');
      return;
    }
  }
  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    const handler = routes[urlPath];
    if (handler) {
      try { handler(req, res); }
      catch (err) { console.error('API error:', urlPath, err); errorResponse(res, 'Internal error', 500); }
    } else {
      errorResponse(res, 'Unknown API endpoint', 404);
    }
    return;
  }
  serveStatic(req, res);
}


// ========================================================================
// Start server
// ========================================================================

const server = http.createServer(handleRequest);

// Friendly failure when the port is taken — almost always a CodeExam GUI already
// running in another window, not a situation that warrants a raw EADDRINUSE stack.
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nCan't start the CodeExam GUI: ${serverArgs.host}:${serverArgs.port} is already in use.`);
    console.error(`  You likely already have a CodeExam GUI running in another window —`);
    console.error(`  close it, or start this one on a different port:  --port <n>  (e.g. --port 8081).`);
    process.exit(1);
  }
  console.error(`\nCodeExam GUI server error: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

server.listen(serverArgs.port, serverArgs.host, () => {
  const indexNames = [...mgr.indexes.keys()].join(', ');
  console.log(`\nCode Exam GUI`);
  console.log(`  Build:   ${SERVER_BUILD}`);
  console.log(`  URL:     http://${serverArgs.host}:${serverArgs.port}/`);
  console.log(`  Indexes: ${indexNames}`);
  console.log(`  Files:   ${[...mgr.indexes.values()].reduce((s, i) => s + i.files.size, 0)} total`);
  // LLM status
  if (serverArgs.modelPath) {
    console.log(`  Local model: ${serverArgs.modelPath}`);
  }
  if (serverLLM.defaultApiKey) {
    console.log(`  Claude API:  key configured (...${serverLLM.defaultApiKey.slice(-4)})${isAirGapped() ? '  — BLOCKED by --air-gapped' : ''}`);
  } else if (isAirGapped()) {
    console.log(`  Claude API:  BLOCKED by --air-gapped (cloud key not loaded this run)`);
  } else {
    console.log(`  Claude API:  no key (set ANTHROPIC_API_KEY or --api-key)`);
  }
  if (serverLLM.defaultOpenAIKey) {
    console.log(`  OpenAI API:  key configured (...${serverLLM.defaultOpenAIKey.slice(-4)})${isAirGapped() ? '  — BLOCKED by --air-gapped' : ''}`);
  } else if (isAirGapped()) {
    console.log(`  OpenAI API:  BLOCKED by --air-gapped (cloud key not loaded this run)`);
  } else {
    console.log(`  OpenAI API:  no key (set OPENAI_API_KEY or --openai-key)`);
  }
  if (serverLLM.defaultGeminiKey) {   // #246: every cloud provider on the startup key ledger, so air-gapped-or-not is verifiable
    console.log(`  Gemini API:  key configured (...${serverLLM.defaultGeminiKey.slice(-4)})${isAirGapped() ? '  — BLOCKED by --air-gapped' : ''}`);
  } else if (isAirGapped()) {
    console.log(`  Gemini API:  BLOCKED by --air-gapped (cloud key not loaded this run)`);
  } else {
    console.log(`  Gemini API:  no key (set GEMINI_API_KEY or --gemini-key)`);
  }
  if (serverArgs.temperature > 0) {
    console.log(`  Temperature: ${serverArgs.temperature}`);
  }
  // Warn about heap size for large indexes
  const totalFiles = [...mgr.indexes.values()].reduce((s, i) => s + i.files.size, 0);
  if (totalFiles > 50000) {
    const heapLimit = Math.round(v8.getHeapStatistics().heap_size_limit / 1024 / 1024);
    console.log(`  Note: Large index (${totalFiles} files). Heap limit: ${heapLimit} MB.`);
    if (heapLimit < 8192) {
      console.log(`  Tip: For large indexes, start with: NODE_OPTIONS=--max-old-space-size=8192 node src/server.js ...`);
    }
  }
  console.log(`\nPress Ctrl+C to stop.\n`);

  // Pre-warm note: call count scanning for large indexes (5.6M entries for Chromium)
  // blocks the event loop for minutes, making the server unresponsive. Disabled until
  // this can be moved to a worker thread. First metrics command will trigger the scan.
  // TODO: move getCallCounts() to a worker thread for background pre-warm.
});
