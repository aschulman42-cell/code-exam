#!/usr/bin/env node
/**
 * server.js - GUI server for Code Exam.
 *
 * Zero external dependencies - uses Node built-in http module.
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
import { handleTool, TOOLS, setIndex } from './mcp-server.js';
import { resolveIndexDir } from './archive.js';
import { groupSites, groupPipelines, reTestExamplePath, KERNELS_DRILLDOWN, MULTIMODAL_DRILLDOWN, POSTTRAINING_DRILLDOWN, REASONING_DRILLDOWN, MODELS_DRILLDOWN, ARTIFACTS_DRILLDOWN, DATASETS_DRILLDOWN, TOOLS_DRILLDOWN, TRAINING_DRILLDOWN, INFERENCE_DRILLDOWN, LLMCALLS_DRILLDOWN, CHAINS_DRILLDOWN, EMBEDDINGS_DRILLDOWN, STRUCTURED_OUTPUT_DRILLDOWN, EXPLAINABILITY_DRILLDOWN } from './core/ai-ml-detectors.js';
import { makeFilterMatcher } from './core/filter-match.js';
import { extractExports } from './core/exports.js';
import { extractImports } from './core/imports.js';
import { extractConcepts } from './core/vocabulary.js';
import { buildOverviewFast, buildOverviewDeep } from './core/overview.js';
import { extractDataStructures } from './core/data-structs.js';
import { extractClientServer } from './core/client-server.js';
import { extractReferencedResources } from './core/referenced-resources.js';
import { runAiOverview, AI_OVERVIEW_TOOLS, aiOverviewPrompt } from './core/ai-overview.js';
import { setAirGapped, scrubApiKey, airGappedStartupCheck, isAirGapped, isLocalApiUrl, AIR_GAPPED_DISCLAIMER } from './core/air-gapped.js';
import { estimateCost } from './core/pricing.js';
import { openaiSupportsTemperature, openaiCompletionBudget, openaiUsage, openaiFinishReason } from './core/openai-util.js';
import { skippedExtensionCensus } from './core/extension-census.js';
import { loadUsedByCatalog, makeUsedByFor } from './commands/exports.js';
import { detectInfrastructure } from './core/stack-detectors.js';
import { SERVER_BUILD } from './version.js';
import { parseMultisectTerms, prepareMultisectViews, filterLowSelectivity } from './commands/multisect.js';
import { formatFunctionDigest, formatClassDigest, formatFileDigest } from './commands/digest.js';
import { collectPrompts } from './commands/prompts.js';
import { displayName, parseFuncSpec, MEDIA_BINARY_EXTENSIONS, ARCHIVE_EXTENSIONS, EXECUTABLE_EXTENSIONS } from './utils.js';
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

// Static-files lookup. Dev/install path: `<repo>/public/`, reachable from
// `src/` via `../public`. Standalone-exe path (Bun --compile, see #78):
// `__dirname` resolves into the embedded virtual filesystem
// (e.g. `/$bunfs/root/src/`), which won't hit disk. Fall back to a
// `public/` directory sitting next to the exe (`process.execPath`), the
// layout `scripts/build-exe.js` produces.
function _resolvePublicDir() {
  const candidates = [
    path.join(__dirname, '..', 'public'),
    path.join(path.dirname(process.execPath), 'public'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch { /* try next */ }
  }
  return candidates[0];
}
const PUBLIC_DIR = _resolvePublicDir();


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
  const result = { indexPaths: [], port: 3000, host: '127.0.0.1', modelPath: null, apiKey: null, temperature: 0.0, catalogPath: null, airGapped: false, allowConnected: false, contextSize: null, reproducible: false, openaiKey: null, openaiModel: null, defaultEngine: null };

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
      // GUI default engine (#243 Part B): --llm chatgpt|openai|claude sets which
      // engine the Chat + Workspace controls start on. Local stays the default
      // when a --model-path is given without --llm.
      if ((v = takeValue(a)) !== null) {
        const norm = String(v).toLowerCase();
        result.defaultEngine = (['chatgpt', 'gpt', 'openai'].includes(norm)) ? 'openai'
          : (norm === 'claude') ? 'claude' : null;
        if (result.defaultEngine === null) {
          // Strict: refuse to launch on an unrecognized provider (#246). --llm
          // selects the CLOUD provider only; the local engine is chosen with
          // --model-path <gguf>, so `--llm local` / `--llm <file>.gguf` are
          // refused with a local-specific hint.
          if (norm === 'local' || norm.endsWith('.gguf')) {
            const ex = norm.endsWith('.gguf') ? ` (e.g. --model-path ${v})` : '';
            console.error(`ERROR: --llm selects the CLOUD provider ('claude' or 'openai'), not a local model. For the local engine, start with --model-path <gguf>${ex} or pick Local in the Chat / Workspace Engine dropdown.`);
          } else {
            console.error(`ERROR: unknown --llm value '${v}'. --llm selects the cloud provider: 'claude' or 'openai' (alias 'chatgpt' / 'gpt').`);
          }
          process.exit(1);
        }
      }
    } else if (a === '--openai-key' || a === '--openai_key') {
      if ((v = takeValue(a)) !== null) result.openaiKey = v;
    } else if (a === '--openai-model' || a === '--openai_model') {
      if ((v = takeValue(a)) !== null) result.openaiModel = v;
    } else if (a === '--temperature') {
      if ((v = takeValue(a)) !== null) result.temperature = parseFloat(v) || 0.0;
    } else if (a === '--context-size' || a === '--context_size') {
      // #239 convention: accept either flag spelling.
      if ((v = takeValue(a)) !== null) result.contextSize = parseInt(v) || null;
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
// Index manager: holds one or more named indexes
// ========================================================================

class IndexManager {
  constructor() {
    /** @type {Map<string, CodeSearchIndex>} name -> index */
    this.indexes = new Map();
    /** @type {string|null} */
    this.activeIndex = null;
  }

  load(indexPath) {
    const idx = new CodeSearchIndex({ indexPath });
    if (idx.files.size === 0) {
      console.error(`Warning: No files loaded from index at ${indexPath}`);
      return null;
    }
    const name = path.basename(indexPath) || indexPath;
    this.indexes.set(name, idx);
    if (!this.activeIndex) this.activeIndex = name;
    console.log(`Loaded index "${name}": ${idx.files.size} files`);
    return name;
  }

  get(name = null) {
    const key = name || this.activeIndex;
    return this.indexes.get(key) || null;
  }

  list() {
    return [...this.indexes.entries()].map(([name, idx]) => ({
      name, files: idx.files.size, active: name === this.activeIndex,
      indexSource: idx.indexSource || null, indexPath: idx.indexPath || null,
    }));
  }
}

const serverArgs = parseServerArgs();

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

// Serialize ALL local-GGUF work — chat, AI-overview, and analyze/claim term
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
function _localBudgets(contextSize, explicitMaxTokens) {
  const OVERHEAD = 1200;         // system prompt + tool defs + question, approx tokens
  const MIN_TOOL_TOKENS = 400;
  let maxTokens = explicitMaxTokens || Math.min(6144, Math.max(2400, Math.floor(contextSize / 6)));
  maxTokens = Math.max(256, Math.min(maxTokens, contextSize - OVERHEAD - MIN_TOOL_TOKENS));
  const toolBudgetChars = Math.max(500, Math.floor((contextSize - maxTokens - OVERHEAD) * 2.5));
  return { maxTokens, toolBudgetChars };
}

class ServerLLM {
  constructor(opts = {}) {
    this.defaultModelPath = opts.modelPath || null;
    this.defaultClaudeModel = opts.claudeModel || null;  // --claude-model server default
    this.preferredContextSize = opts.contextSize || null; // --context-size: first rung of the context ladder
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

    const payload = JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
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
    const apiKey = opts.apiKey || this.defaultOpenAIKey;
    if (!apiKey) {
      return { error: 'No OpenAI API key. Set OPENAI_API_KEY env var, create openai.txt, or pass --openai-key.' };
    }
    const apiUrl = opts.apiUrl || process.env.CE_OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
    const model = opts.model || this.defaultOpenAIModel;
    const maxTokens = opts.maxTokens || 2048;

    // Same cloud guard as the Claude branch (#223) — hostname-parsed, fail-closed.
    const isLocal = isLocalApiUrl(apiUrl);
    if (!isLocal && isAirGapped()) {
      console.error('[air-gapped] blocked: GUI cloud LLM (OpenAI)');
      return { error: '--air-gapped: cloud LLM is blocked. Set the engine to Local in the Workspace pane (LLM controls), or restart without --air-gapped to allow cloud calls (your data would leave this machine).' };
    }
    if (!isLocal) {
      const tnote = openaiSupportsTemperature(model) ? '' : ' [temperature not pinnable on this model — sampling default, runs may vary]';
      console.log(`  [LLM] OpenAI API -> ${apiUrl} (model: ${model})${tnote}`);
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
    if (!mp) return { error: 'No local model configured. Use --model-path <path-to-gguf> when starting the server.' };

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
      const { getLlama, LlamaChatSession, defineChatSessionFunction } = await import('node-llama-cpp');
      console.log(`  [LLM] Loading local model: ${mp}...`);
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath: mp });

      // Context ladder: try big, fall back on allocation failure.
      // --context-size prepends a user-chosen first rung — agentic multi-tool
      // investigations want 16k+ when VRAM allows (a 27B Q4 + 24k context
      // measured 17.9 GB on a 24 GB card; see docs/cloud-gpu-chat-testing.md).
      // The smaller rungs still protect modest hardware from OOM.
      const ladder = this.preferredContextSize
        ? [this.preferredContextSize, ...[8192, 4096, 2048].filter(s => s < this.preferredContextSize)]
        : [8192, 4096, 2048];
      let context = null;
      let contextSize = 0;
      for (const trySize of ladder) {
        try { context = await model.createContext({ contextSize: trySize }); contextSize = trySize; break; }
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
      console.log(`  [LLM] OK: Local model loaded (context: ${contextSize} tokens)`);
      return { ok: true };
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find/.test(e.message)) {
        return { error: 'node-llama-cpp not installed. Run: npm install node-llama-cpp' };
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
        session = new LlamaChatSession({ contextSequence: sequence });
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
    } else if (engine === 'openai') {
      return this.callOpenAI(systemPrompt, userMessage, opts);
    } else {
      return this.callLocal(systemPrompt, userMessage, opts);
    }
  }

  /** Check if the requested engine is available without actually calling it. */
  checkAvailability(engine) {
    // Cloud engines are honestly unavailable under --air-gapped (keys are
    // never resolved then), with a reason that names the cause rather than
    // a misleading "no key configured".
    if ((engine === 'claude' || engine === 'openai') && isAirGapped()) {
      return { available: false, reason: 'Blocked by --air-gapped: cloud AI calls are disabled this run. Use the Local GGUF engine.' };
    }
    if (engine === 'claude') {
      if (!this.defaultApiKey) return { available: false, reason: 'No API key configured.' };
      return { available: true };
    } else if (engine === 'openai') {
      if (!this.defaultOpenAIKey) return { available: false, reason: 'No OpenAI API key configured. Set OPENAI_API_KEY, create openai.txt, or pass --openai-key.' };
      return { available: true };
    } else {
      if (!this.defaultModelPath) return { available: false, reason: 'No local model configured. Start server with --model-path <path-to-gguf>.' };
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
  contextSize: serverArgs.contextSize,
  reproducible: serverArgs.reproducible,
  openaiKey: serverArgs.openaiKey,
  openaiModel: serverArgs.openaiModel,
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
const _LOCALHOST = /^(127\.\d|localhost$|::1$)/;

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
  // CORS allowed (same rationale as /api/prompts — used by the xmlui prototype).
  res.setHeader('Access-Control-Allow-Origin', '*');
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
  jsonResponse(res, {
    claude: { available: claudeAvail.available, name: 'Claude API' },
    openai: { available: openaiAvail.available, name: `ChatGPT API (${serverLLM.defaultOpenAIModel})` },
    local:  { available: localAvail.available,  name: localName ? `Local: ${localName}` : 'Local GGUF Model', detail },
    // #223: lets the client show "blocked by --air-gapped" for cloud engines
    // instead of a misleading "not configured / set a key" message.
    airGapped: isAirGapped(),
    // --llm at launch (#243 Part B): the engine the GUI controls should start
    // on. Client applies once so it doesn't override a manual switch.
    preferred: serverArgs.defaultEngine || null,
  });
};


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
// Used by /api/extract-linkified to decide which identifiers in a function's
// body correspond to known functions (i.e. linkable call sites).
function _buildKnownNameSet(index) {
  const known = new Set();
  for (const fn of index.listFunctions()) {
    known.add(index.getDisplayName(fn.name));
  }
  return known;
}

routes['/api/extract'] = (req, res) => {
  // CORS allowed (same rationale as /api/prompts — used by the xmlui prototype).
  res.setHeader('Access-Control-Allow-Origin', '*');
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
  const source = index.getFunctionSource(m.filepath, m.name);
  jsonResponse(res, {
    filepath: m.filepath, name: index.getDisplayName(m.name), display_name: displayName(index.getDisplayName(m.name), m.filepath),
    start: m.start, end: m.end, lines: m.end - m.start + 1,
    start_line: m.start,
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
  res.setHeader('Access-Control-Allow-Origin', '*');
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
  const rawSource = index.getFunctionSource(m.filepath, m.name) || '(source not available)';
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
    start_line: m.start,
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
  if (func.includes('@')) func = func.slice(func.indexOf('@') + 1);
  func = index.getOriginalName(func);
  let callers;
  try {
    callers = index.findCallers(func, safeMax(q.max, 200));
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
      if (mode === 'replace') { mgr.indexes.clear(); mgr.activeIndex = null; }
      const name = mgr.load(indexDir);
      if (!name) return errorResponse(res, `No files found in index at: ${indexPath}`, 400);
      mgr.activeIndex = name;
      const resp = { loaded: name, mode, indexes: mgr.list() };
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
        workerData: { sourcePath, indexPath: resolvedIndex, useTreeSitter: useTreeSitter || false, extensions: extensions || '', excludeExtensions: excludeExtensions || '' }
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
  function addEdge(fromName, toName) {
    const key = `${fromName}-->${toName}`;
    if (edges.has(key)) return;
    edges.add(key);
    mermaidLines.push(`  ${safeId(fromName)}["${safeLbl(fromName)}"] --> ${safeId(toName)}["${safeLbl(toName)}"]`);
  }

  // --- Callees (downward from root) ---
  const visitedDown = new Set();
  function addCallees(fn, fh, d) {
    if (d >= depth || visitedDown.has(fn)) return;
    visitedDown.add(fn);
    const callees = index.findCallees(fn, fh);
    for (const c of callees.slice(0, 12)) {
      if (c.ambiguous && !c.resolved_def) continue;  // skip unresolved
      addEdge(fn, c.name);
      if (c.resolved_def) addCallees(c.name, null, d + 1);
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
      for (const c of callerHits) {
        if (c.caller_function && c.caller_function !== fn && c.caller_function !== '(global)') {
          callerCounts.set(c.caller_function, (callerCounts.get(c.caller_function) || 0) + 1);
        }
      }
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
    throw new Error('local AI overview: node-llama-cpp function-calling unavailable (update node-llama-cpp).');
  }
  const { LlamaChatSession, defineChatSessionFunction } = lm;
  const { maxTokens, toolBudgetChars } = _localBudgets(lm.contextSize, null);
  const overviewToolNames = AI_OVERVIEW_TOOLS.split(',').map(t => t.replace(/^mcp__code-exam__/, ''));
  const byName = new Map(TOOLS.map(t => [t.name, t]));
  let toolCalls = 0;
  let toolChars = 0;
  let budgetStopped = false;
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
        let out;
        try { out = String(handleTool(name, args || {})); }
        catch (e) { out = `Error calling ${name}: ${e.message}`; }
        const capped = neutralizeSpecialTokens(out.slice(0, 4000), `${name} result`);
        toolChars += capped.length;
        return capped;
      },
    });
  }
  // Same cached-sequence reuse as runChatToolLoopLocal — never dispose.
  const sequence = await serverLLM.acquireSharedSequence();
  const session = new LlamaChatSession({ contextSequence: sequence });
  try {
    const sampling = serverLLM.reproducible ? { temperature: 0, seed: 1 } : {};
    const raw = await session.prompt(aiOverviewPrompt(grounding), { functions, maxTokens, ...sampling });
    const prose = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
    if (!prose) throw new Error('local AI overview: the model returned no prose — try a stronger model or larger --context-size.');
    console.log(`  [ai-overview] local done: ${prose.length} chars, ${toolCalls} tool calls`);
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
  if (!idxPath) return errorResponse(res, 'The loaded index has no on-disk path; AI Overview needs one to point the MCP server at it.', 400);

  // Cloud engines: 'openai' (#243 Part B) or claude (default). Same agentic
  // loop over CE's own mcp-server either way; runAiOverview dispatches.
  const cloudEngine = q.engine === 'openai' ? 'openai' : 'claude';
  const cloudModel = q.model
    || (cloudEngine === 'openai' ? serverLLM.defaultOpenAIModel : process.env.CE_AI_OVERVIEW_MODEL);
  const cloudDisplayModel = cloudModel || (cloudEngine === 'openai' ? serverLLM.defaultOpenAIModel : 'claude-sonnet-4-6');
  console.log(`  [ai-overview] running ${cloudEngine} over ${path.basename(idxPath)} …`);
  // Forward the resolved key for BOTH engines — the Claude overview branch now
  // honors it (was hard-requiring ANTHROPIC_API_KEY), so a --api-key / claude.txt
  // server can run a Claude overview like it already runs Chat/Analyze (#243B).
  const overviewKey = cloudEngine === 'openai' ? serverLLM.defaultOpenAIKey : serverLLM.defaultApiKey;
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
  // Cross-origin: allow the xmlui prototype (running on a separate dev port)
  // to fetch prompts. Same-origin callers ignore this header.
  res.setHeader('Access-Control-Allow-Origin', '*');
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
  const merged = new Map();   // `${pkg} ${name}` -> row
  for (const r of records) {
    if (match && !match(r.name, r.dottedPath || '', r.package)) continue;
    const key = `${r.package} ${r.name}`;
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
  const { rows, pyFiles } = extractImports(index);   // external imports only (relative skipped)
  if (pyFiles === 0) return jsonResponse(res, { total: 0, instances: 0, imports: [], pyFiles: 0 });

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
    imports: libs.slice(0, max).map(g => ({
      library: g.library, count: g.count, targets: g.targets.size, sites: g.sites,
    })),
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
        let source = index.getFunctionSource(m.filepath, m.name);
        if (!source) return errorResponse(res, 'Source not available', 404);
        const lang = detectLanguage(m.filepath);
        if (mask) source = masker.maskFunctionSource(source, m.name, lang);
        else if (maskComments) source = masker.stripComments(source, lang);
        if (lineNumbers) source = addLineNumbers(source, m.start);

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
            topN: engine === 'local' ? 200 : 300,
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
            topN: engine === 'local' ? 200 : 300,
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

        let source = index.getFunctionSource(m.filepath, m.name);
        if (!source) return errorResponse(res, 'Source not available', 404);

        const lang = detectLanguage(m.filepath);
        const masker = new SimpleMasker();
        if (mask) source = masker.maskFunctionSource(source, m.name, lang);
        else if (maskComments) source = masker.stripComments(source, lang);
        if (lineNumbers) source = addLineNumbers(source, m.start);

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

// Grounding mode (#36): how freely the model may use knowledge beyond this
// codebase. Default 'grounded' — CE's forensic identity makes the inferential
// modes a deliberate opt-in, not a silent default that could undermine a finding.
const CHAT_GROUNDING_CLAUSES = {
  grounded: `GROUNDING — STRICT: Answer ONLY from what the tools surface about this code. If something cannot be determined from the code, say so explicitly ("not determinable from the code") rather than filling the gap with general knowledge. Do NOT assert the purpose of a referenced library/algorithm, the research domain, or any external framing as fact about this codebase unless the code itself states it. Stay within the evidence the tools return. Never expand an acronym or abbreviation unless the expansion appears in tool results from this codebase — otherwise write the acronym as-is. Never state aggregate statistics (file counts, line counts, percentages) other than numbers a tool returned verbatim.`,
  augmented: `GROUNDING — AUGMENTED: You may combine what the tools surface with your general knowledge to give the richest, most useful explanation — naming the domain or research area, explaining what a referenced library or algorithm does, and supplying standard context the code assumes its readers already know.`,
  attributed: `GROUNDING — ATTRIBUTED: Combine codebase evidence with general knowledge for a rich explanation, but make provenance explicit — clearly distinguish claims grounded in THIS code (cite the file/function/tool that shows them) from claims that come from your general knowledge or inference. Flag every non-trivial external claim as such. Acronym expansions and statistics that come from your general knowledge rather than tool results must be explicitly flagged as such.`,
};

// Built per request so the model is re-grounded in the CURRENT index every turn
// (#36 cross-codebase fix) and carries the selected grounding clause.
function chatSystemPrompt(indexName, fileCount, mode) {
  const id = indexName
    ? `You are examining the codebase currently indexed as "${indexName}"${fileCount ? ` (${fileCount} files)` : ''}.`
    : 'You are examining the currently indexed codebase.';
  const grounding = CHAT_GROUNDING_CLAUSES[mode] || CHAT_GROUNDING_CLAUSES.grounded;
  return `You are a code-analysis assistant for CodeExam. ${id} You have tools that search, analyze, and explore THIS index — use them to ground every answer in this specific code, citing files and functions by name. Be concise and direct; prefer calling a tool over guessing.

The active index can be switched mid-conversation: always answer about the CURRENT index named above. Earlier messages in this conversation may refer to a DIFFERENT codebase, so re-query the tools rather than trusting prior context.

${grounding}`;
}

// CE's MCP tool defs -> Anthropic tool-use format.
function chatAnthropicTools() {
  return TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

// Multi-turn Claude tool loop. Executes tool calls in-process via handleTool
// against `index`. Returns the flat content blocks (text + tool_use{_result})
// the chat UI renders — same shape web-app.js produces.
async function runChatToolLoop({ messages, index, indexName, fileCount, mode, apiKey, model, maxTokens = 4096, temperature = 0, onToolCall }) {
  setIndex(index); // point handleTool at the active GUI index (in-process; no subprocess / re-index)
  const tools = chatAnthropicTools();
  const system = chatSystemPrompt(indexName, fileCount, mode);
  const apiUrl = process.env.CLAIM_SEARCH_API_URL || 'https://api.anthropic.com/v1/messages';
  // #223: air-gapped blocks the GUI cloud chat loop (a loopback endpoint is OK).
  // Hostname-parsed, fail-closed (see isLocalApiUrl) — never substring-matched.
  if (!isLocalApiUrl(apiUrl) && isAirGapped()) {
    console.error('[air-gapped] blocked: GUI chat (cloud Claude)');
    throw new Error('--air-gapped: chat over the cloud LLM is blocked. Set the engine to Local in the Workspace pane (LLM controls), or restart without --air-gapped to allow cloud calls.');
  }
  const allBlocks = [];
  let current = [...messages];
  const MAX_ITERATIONS = 25;  // raised from 15 (#36): attributed/augmented modes explore harder

  // Join the text blocks of one content array into trimmed prose.
  const textOf = (content) => content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  // An end_turn that is actually a STALL, not an answer: short prose that announces
  // a next step it never took ("Let me find …", "Now I'll check:", a trailing
  // colon). The model "finished" per the API but hasn't answered — synthesize below.
  const looksUnfinished = (t) => t.length < 300 && (
    /\b(let me|let's|now i['’]?ll|i['’]?ll now|next,? i|first,? (?:let me|i)|i will now)\b/i.test(t)
    || /[:：]\s*$/.test(t)
  );

  let answer = '';            // the FINAL answer — NOT a mash of interim narration
  let genuineFinal = false;   // an end_turn with real, complete text → no synthesis needed

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const payload = JSON.stringify({
      model, max_tokens: maxTokens, temperature, system, messages: current, tools,
    });
    const body = await _serverHttpPost(apiUrl, payload, {
      'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
    });
    const content = body.content || [];
    allBlocks.push(...content);

    if (body.stop_reason === 'tool_use') {
      const resultMap = {};
      const toolResults = [];
      for (const b of content) {
        if (b.type !== 'tool_use') continue;
        if (onToolCall) onToolCall(b.name, b.input);
        let text;
        try { text = String(handleTool(b.name, b.input || {})); }
        catch (e) { text = `Error: ${e.message}`; }
        resultMap[b.id] = text;
        toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: text });
      }
      for (const b of allBlocks) {
        if (b.type === 'tool_use' && resultMap[b.id] !== undefined) b._result = resultMap[b.id];
      }
      // Strip our _result annotation before echoing assistant turn back to the API.
      const clean = content.map(({ _result, ...rest }) => rest);
      current = [...current, { role: 'assistant', content: clean }, { role: 'user', content: toolResults }];
      continue;
    }

    // Non-tool stop. Only an end_turn with real, complete text is a genuine final
    // answer. max_tokens / pause_turn are truncated mid-thought; an end_turn whose
    // text just narrates a next step is a stall. Anything not genuine falls through
    // to the synthesis pass below (this is the #36 "(no text response)" bug:
    // max_tokens and narrate-and-stop were treated as final, skipping synthesis).
    const turnText = textOf(content);
    if (body.stop_reason === 'end_turn' && turnText && !looksUnfinished(turnText)) {
      answer = turnText;
      genuineFinal = true;
    }
    break;
  }

  // No genuine final answer (iteration cap hit while still calling tools, a
  // max_tokens/pause_turn truncation, or a narrate-and-stop): make ONE tools-OFF
  // call so the model MUST answer from what it already gathered, and use ITS text.
  if (!genuineFinal) {
    // Append an explicit "answer now" instruction so the model SUMMARIZES from
    // what it gathered. Re-sending the tool results tools-off WITHOUT an
    // instruction left it "expecting" to keep calling tools and sometimes
    // returning nothing — the cause of a late "(no text response)" on
    // exploration-heavy chats. Augment the last user turn (vs. appending a new
    // one, which would make two consecutive user turns the API rejects).
    const NUDGE = 'Based on everything above, write your complete final answer to my question now. Do not call any more tools.';
    const synthMsgs = current.slice();
    const last = synthMsgs[synthMsgs.length - 1];
    if (last && last.role === 'user') {
      const lc = Array.isArray(last.content) ? last.content : [{ type: 'text', text: String(last.content) }];
      synthMsgs[synthMsgs.length - 1] = { role: 'user', content: [...lc, { type: 'text', text: NUDGE }] };
    } else {
      synthMsgs.push({ role: 'user', content: NUDGE });
    }
    try {
      const body = await _serverHttpPost(apiUrl, JSON.stringify({
        model, max_tokens: maxTokens, temperature, system, messages: synthMsgs,  // no `tools` → stop_reason can't be tool_use
      }), { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
      const content = body.content || [];
      allBlocks.push(...content);
      answer = textOf(content) || answer;
    } catch (e) {
      const msg = `(Reached the ${MAX_ITERATIONS}-step tool limit and could not produce a final summary: ${e.message})`;
      allBlocks.push({ type: 'text', text: msg });
      answer = answer || msg;
    }
  }

  // Never hand back an empty answer — last-resort fall back to any text in the trace.
  if (!answer) answer = textOf(allBlocks);

  // Diagnostic: an empty answer here means the synthesis produced no text — the
  // root of a "(no text response)" on the client. A non-empty answer with an empty
  // client bubble points at the delivery path instead.
  console.log(`  [chat] final answer ${answer.length} chars (genuineFinal=${genuineFinal}, ${allBlocks.length} blocks)`);

  // content = the full block trace (drives the tool-call view); answer = the final
  // synthesized reply only (no interim narration). (#36 final-answer-robustness)
  return { content: allBlocks, answer };
}

// #243 Part B — OpenAI/ChatGPT counterpart to runChatToolLoop. Same multi-turn
// agentic structure (tool loop -> stall detection -> tools-off synthesis), with
// the Anthropic tool-use shapes swapped for OpenAI tool-calling: tools are
// {type:"function", function:{...}}, calls arrive as message.tool_calls with
// JSON-string arguments, and results go back as role:"tool" messages. Returns
// the SAME { content, answer } block shape as the Claude loop so the routes
// and the GUI stay engine-agnostic.
function chatOpenAITools() {
  return TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));
}

async function runChatToolLoopOpenAI({ messages, index, indexName, fileCount, mode, apiKey, model, maxTokens = 4096, onToolCall }) {
  setIndex(index);
  const tools = chatOpenAITools();
  const system = chatSystemPrompt(indexName, fileCount, mode);
  const apiUrl = process.env.CE_OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';
  if (!isLocalApiUrl(apiUrl) && isAirGapped()) {
    console.error('[air-gapped] blocked: GUI chat (cloud OpenAI)');
    throw new Error('--air-gapped: chat over the cloud LLM is blocked. Set the engine to Local in the Workspace pane (LLM controls), or restart without --air-gapped to allow cloud calls.');
  }
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };

  // Incoming history may carry Anthropic-shaped content arrays from prior
  // turns; OpenAI wants plain strings for user/assistant text turns.
  const flat = (c) => Array.isArray(c)
    ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
    : String(c || '');
  let current = [
    { role: 'system', content: system },
    ...messages.map(m => ({ role: m.role, content: flat(m.content) })),
  ];

  const allBlocks = [];
  const MAX_ITERATIONS = 25; // parity with the Claude loop
  const looksUnfinished = (t) => t.length < 300 && (
    /\b(let me|let's|now i['’]?ll|i['’]?ll now|next,? i|first,? (?:let me|i)|i will now)\b/i.test(t)
    || /[:：]\s*$/.test(t)
  );
  let answer = '';
  let genuineFinal = false;

  const post = (msgs, withTools) => _serverHttpPost(apiUrl, JSON.stringify({
    model,
    // Floor the cap for reasoning models so hidden reasoning tokens don't starve
    // the answer (openai-util).
    max_completion_tokens: openaiCompletionBudget(model, maxTokens),
    ...(openaiSupportsTemperature(model) ? { temperature: 0 } : {}),
    messages: msgs,
    ...(withTools ? { tools } : {}),
  }), headers);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const body = await post(current, true);
    const choice = (body.choices && body.choices[0]) || {};
    const msg = choice.message || {};
    const text = String(msg.content || '').trim();
    if (text) allBlocks.push({ type: 'text', text });

    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      const toolMsgs = [];
      for (const tc of msg.tool_calls) {
        const name = tc.function && tc.function.name;
        const rawArgs = (tc.function && tc.function.arguments) || '{}';
        let input, parseErr = null;
        try { input = JSON.parse(rawArgs); } catch (e) { parseErr = e; }
        const validInput = input && typeof input === 'object' && !Array.isArray(input);
        let result;
        if (parseErr || !validInput) {
          // Don't silently run the tool with {} on malformed arguments — return an
          // invalid-arguments error so the model retries, instead of grounding on
          // a wrong-scope result it believes is legitimate (#243B). Mirrors the
          // Claude loop's handleTool(name, input || {}).
          result = `Error: tool arguments were not a valid JSON object: ${String(rawArgs).slice(0, 200)}`;
          if (onToolCall) onToolCall(name, {});
          allBlocks.push({ type: 'tool_use', name, input: {}, _result: result });
        } else {
          if (onToolCall) onToolCall(name, input);
          try { result = String(handleTool(name, input)); }
          catch (e) { result = `Error: ${e.message}`; }
          allBlocks.push({ type: 'tool_use', name, input, _result: result });
        }
        toolMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      current = [...current, { role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls }, ...toolMsgs];
      continue;
    }

    // Non-tool stop: mirror the Claude loop's genuine-final test — a 'stop'
    // finish with real, complete text; 'length' truncations and
    // narrate-and-stop stalls fall through to synthesis.
    if (choice.finish_reason === 'stop' && text && !looksUnfinished(text)) {
      answer = text;
      genuineFinal = true;
    }
    break;
  }

  if (!genuineFinal) {
    const NUDGE = 'Based on everything above, write your complete final answer to my question now. Do not call any more tools.';
    try {
      const body = await post([...current, { role: 'user', content: NUDGE }], false);
      const text = String((body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || '').trim();
      if (text) allBlocks.push({ type: 'text', text });
      answer = text || answer;
    } catch (e) {
      const msgTxt = `(Reached the ${MAX_ITERATIONS}-step tool limit and could not produce a final summary: ${e.message})`;
      allBlocks.push({ type: 'text', text: msgTxt });
      answer = answer || msgTxt;
    }
  }

  if (!answer) answer = allBlocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  console.log(`  [chat] openai final answer ${answer.length} chars (${allBlocks.filter(b => b.type === 'tool_use').length} tool calls)`);
  return { content: allBlocks, answer };
}

// #243 Part A — local (GGUF) counterpart to runChatToolLoop. Mirrors the PROVEN
// ai-overview-local.js pattern: expose CE's TOOLS as node-llama-cpp chat
// functions (backed by handleTool in-process — no MCP subprocess) and let the
// model drive a multi-turn function-calling loop via session.prompt(...,
// { functions }). Returns the SAME { content, answer } shape as the Claude loop
// so the routes and the GUI stay engine-agnostic. Air-gapped-safe: no cloud call.
//
// The tool-exposure snippet is intentionally a mirror of ai-overview-local.js
// (not a shared extraction) so this change doesn't destabilize the working
// overview path; a DRY refactor into a shared helper is a fair follow-up.
// Prior conversation is flattened into a preamble (version-robust across
// node-llama-cpp releases); higher-fidelity multi-turn history is a follow-up.
const _asChatText = (c) => Array.isArray(c)
  ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
  : String(c || '');

// Local models degrade sharply as the tool menu grows (see
// docs/cloud-gpu-chat-testing.md, First-run findings + Cross-model matrix:
// 8B/14B collapse to zero calls or garbage args at 26 tools; even 32B args
// degrade). Keep the local loop to this curated core; the cloud (Claude)
// loop still gets all TOOLS.
const LOCAL_CHAT_TOOLS = ['search', 'extract', 'show_file', 'callers',
  'callees', 'digest', 'overview', 'list_functions'];

// Chat-template special tokens must never reach a local model as literal
// text: a user who TYPES <think> in a question — or a tool result carrying
// real template strings (this is a code-examination tool; corpora ABOUT LLMs
// contain them) — derails the template's turn/reasoning/tool-call state.
// Measured: literal <think> in a question dropped Qwen3.5-9B from 19 native
// tool calls to 0 on the otherwise-identical question. Fake turn tags inside
// hostile code comments are also a prompt-injection vector. Neutralize by
// swapping angle brackets for ‹ › single angle quotes: visibly distinct,
// meaning-preserving for the model and the reader, token-breaking for the
// template. Covers: Qwen/DeepSeek think tags, Qwen tool-channel tags, the
// ChatML/Llama/DeepSeek/Phi <|...|> family, Gemma turn tags, Mistral [INST]
// forms, and BOS/EOS sentinels.
const _SPECIAL_TOKEN_RE = new RegExp([
  '</?think>',
  '</?tool_(?:call|response)>',
  '<\\|[^|<>]{1,32}\\|>',
  '<\\uff5c[^\\uff5c<>]{1,40}\\uff5c>',
  '<(?:start|end)_of_turn>',
  '\\[/?INST\\]', '\\[TOOL_CALLS\\]',
  '</?s>',
].join('|'), 'gi');
function neutralizeSpecialTokens(s, where) {
  const str = String(s || '');
  const hits = str.match(_SPECIAL_TOKEN_RE);
  if (!hits) return str;
  console.log(`  [chat] neutralized ${hits.length} special token(s) in ${where}: ${[...new Set(hits)].slice(0, 5).join(' ')}`);
  // #250: break EVERY token form, not just angle brackets. Bracket-delimited
  // Mistral tokens ([INST] etc.) and fullwidth-bar DeepSeek tokens (<｜…｜>) carry
  // no ASCII angle brackets, so an angle-only swap left them intact while still
  // counting/logging them as neutralized — a live template token plus a false
  // audit line. Swap all structural delimiters for visibly-distinct,
  // meaning-preserving lookalikes.
  return str.replace(_SPECIAL_TOKEN_RE, (m) => m
    .replace(/</g, '‹').replace(/>/g, '›')
    .replace(/\[/g, '⟦').replace(/\]/g, '⟧')
    .replace(/[|｜]/g, '¦'));
}

async function runChatToolLoopLocal({ messages, index, indexName, fileCount, mode, onToolCall, maxTokens = null }) {
  // #248: serialize the entire local request (setIndex + shared-sequence chat)
  // so a concurrent local request can neither repoint the tool index mid-loop
  // nor clobber the shared sequence's history.
  return withLocalLock(async () => {
  setIndex(index); // point handleTool at the active GUI index (in-process)
  const loaded = await serverLLM.ensureLocalModel();
  if (loaded.error) throw new Error(loaded.error);
  const lm = serverLLM._localModel;
  if (!lm || !lm.defineChatSessionFunction) {
    throw new Error('local chat: node-llama-cpp function-calling unavailable (update node-llama-cpp).');
  }
  const { LlamaChatSession, defineChatSessionFunction } = lm;
  const system = chatSystemPrompt(indexName, fileCount, mode);

  // Response-length budget: scale with the loaded context unless the caller
  // passed an explicit value — 2400 at the 8k default (laptop behavior
  // unchanged), 4096 at 24k. The old fixed 2400 truncated page-scale answers
  // mid-sentence at large contexts (chat-response-length). Must be resolved
  // BEFORE the tool budget below, which reserves this many output tokens.
  // #248: budgets that provably fit the loaded context (incl. the 2048/4096 rungs).
  const _b = _localBudgets(lm.contextSize, maxTokens);
  maxTokens = _b.maxTokens;

  // --reproducible pins sampling for reproducible runs (honest scope: see
  // the ServerLLM constructor). Default is node-llama-cpp sampling — run-to-
  // run variation is the chosen default (exploration; comparing variant
  // answers across runs is itself informative in examination work).
  const sampling = serverLLM.reproducible ? { temperature: 0, seed: 1 } : {};

  // Acquire a chat sequence — ONE per loaded model, cached on _localModel,
  // reset between chats, never disposed. Rationale: sequence.dispose()
  // silently fails to release the slot for some model families (Gemma 3 on
  // node-llama-cpp <= 3.19.0, both unsloth and official-QAT GGUFs), so the
  // canonical acquire/dispose-per-chat pattern locks the context out with
  // "No sequences left" after one chat — and disposing the poisoned context
  // in-process deadlocks native teardown, so there is no in-place recovery.
  // Reuse sidesteps the broken dispose entirely. Verified: no cross-chat
  // state bleed (a fresh LlamaChatSession re-evaluates the sequence from
  // scratch; probed with distinct per-chat secrets). Chats already
  // serialize per model — concurrent requests were equally unsupported
  // before (the second getSequence would have thrown).
  // Shared with callLocal + the overview loop (one cached sequence per model).
  const acquireSequence = () => serverLLM.acquireSharedSequence();

  // Tool budget: strong models (Qwen3.5 class) investigate until they burst —
  // 10-22 calls whose accumulated results overflow ANY context and error out,
  // losing the whole investigation. Track result chars (~2.5 chars/token,
  // conservative for code) against the context left after the output
  // reservation and prompt overhead, plus a call-count backstop. When
  // crossed, handlers stop executing tools and return a terminal instruction
  // so the model synthesizes from what it already has. session.prompt drives
  // the multi-call loop internally, so the handlers are the only place this
  // check can live.
  const MAX_TOOL_CALLS = 24;
  const toolBudgetChars = _b.toolBudgetChars;
  let toolChars = 0;
  let toolCalls = 0;
  let budgetStopped = false;
  const seenCalls = new Map(); // dedup: identical repeat calls waste context

  // Expose the curated tool core as node-llama-cpp chat functions backed by
  // handleTool, recording each call as a tool_use block so the GUI's
  // tool-call view renders.
  const blocks = [];
  const functions = {};
  for (const t of TOOLS.filter(tl => LOCAL_CHAT_TOOLS.includes(tl.name))) {
    functions[t.name] = defineChatSessionFunction({
      description: String(t.description || '').slice(0, 280),
      params: (t.inputSchema && t.inputSchema.properties) ? t.inputSchema : { type: 'object', properties: {} },
      handler: (args) => {
        toolCalls++;
        if (budgetStopped || toolCalls > MAX_TOOL_CALLS || toolChars > toolBudgetChars) {
          if (!budgetStopped) {
            budgetStopped = true;
            console.log(`  [chat] budget-stop after ${toolCalls - 1} calls (${toolChars} result chars, budget ${Math.floor(toolBudgetChars)})`);
          }
          return 'TOOL BUDGET EXHAUSTED — do not call any more tools. Write your complete final answer now from the results you already have.';
        }
        const callKey = t.name + ' ' + JSON.stringify(args || {});
        if (seenCalls.has(callKey)) {
          return `Duplicate call — ${t.name} already returned this result earlier in this conversation; reuse it.`;
        }
        if (onToolCall) onToolCall(t.name, args || {});
        let out;
        try { out = String(handleTool(t.name, args || {})); }
        catch (e) { out = `Error: ${e.message}`; }
        // Cap so one result doesn't blow the context, then neutralize any
        // chat-template tokens riding in the examined code. The GUI block
        // records the neutralized form — i.e., exactly what the model saw.
        const capped = neutralizeSpecialTokens(out.slice(0, 4000), `${t.name} result`);
        seenCalls.set(callKey, true);
        toolChars += capped.length;
        blocks.push({ type: 'tool_use', name: t.name, input: args || {}, _result: capped });
        return capped;
      },
    });
  }

  // Preamble = prior USER questions ONLY (capped), for pronoun/reference
  // resolution. Deliberately DROP prior assistant answers: feeding a small model
  // its own earlier answer invites it to re-summarize from that text instead of
  // calling tools to read the CURRENT code (the "answered without fresh tool
  // calls" failure Andrew hit on question 2). The current question is wrapped
  // with an explicit read-the-code-first directive to push tool use.
  const priorQs = messages.slice(0, -1)
    .filter(m => m.role === 'user')
    .map(m => `- ${_asChatText(m.content).slice(0, 300)}`)
    .join('\n');
  const question = _asChatText(messages[messages.length - 1] && messages[messages.length - 1].content);
  const promptText = neutralizeSpecialTokens(priorQs
    ? `Earlier questions in this chat (reference only — the code is the source of truth; do NOT answer from these or from memory):\n${priorQs}\n\nNow answer this question. First call the tools to read the ACTUAL current code, then answer from what they return:\n${question}`
    : question, 'user question');

  // Strip a chain-of-thought block — closed OR truncated-open (Qwen3 etc. emit
  // <think>…</think>; maxTokens can cut it off before the closing tag, which
  // would otherwise leave the raw <think> as the "answer").
  const stripThink = (s) => String(s || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();

  const sequence = await acquireSequence();
  let session;
  try {
    session = new LlamaChatSession({ contextSequence: sequence, systemPrompt: system });
    // node-llama-cpp's Gemma wrapper silently drops systemPrompt (verified on
    // 3.19.0 with the official QAT GGUF: system-turn instructions have no
    // effect; the same text in a user turn works). For Gemma only, fold the
    // grounding preamble into the user prompt; other families keep the real
    // system turn (double-delivery would waste their context).
    const wrapperName = session.chatWrapper && session.chatWrapper.wrapperName;
    const effectivePrompt = wrapperName === 'Gemma'
      ? `Instructions (follow these strictly):\n${system}\n\n---\n\n${promptText}`
      : promptText;
    // promptWithMeta (when available) reports WHY generation stopped, so a
    // length-capped answer gets a visible marker instead of a silent
    // mid-sentence cut — users read those as model failures.
    let prose, stopReason = null;
    if (typeof session.promptWithMeta === 'function') {
      const meta = await session.promptWithMeta(effectivePrompt, { functions, maxTokens, ...sampling });
      prose = stripThink(String(meta.responseText ?? ''));
      stopReason = meta.stopReason || null;
    } else {
      prose = stripThink(await session.prompt(effectivePrompt, { functions, maxTokens, ...sampling }));
    }
    // Small local models often call a tool then stop without composing an answer
    // (the "(no text response)" symptom Andrew hit on question 2), or emit only a
    // <think> block that strips to empty. Mirror the Claude loop's synthesis pass:
    // one more turn on the SAME session (tools OFF, so it MUST answer) using the
    // tool results already in the session's history.
    if (!prose) {
      const NUDGE = 'Based on the tool results above, write your complete final answer now. Do not call any more tools.';
      // #250: recompute stopReason from the NUDGE pass — the marker below must
      // describe the pass that actually produced the answer, not the stale first
      // pass (for a reasoning model that spent its budget inside <think>, the
      // first-pass stopReason would mislabel a complete nudge answer as truncated,
      // or vice-versa).
      try {
        if (typeof session.promptWithMeta === 'function') {
          const meta = await session.promptWithMeta(NUDGE, { maxTokens, ...sampling });
          prose = stripThink(String(meta.responseText ?? ''));
          stopReason = meta.stopReason || null;
        } else {
          prose = stripThink(await session.prompt(NUDGE, { maxTokens, ...sampling }));
          stopReason = null;
        }
      } catch { /* keep empty */ }
    }
    if (!prose) prose = '(the local model returned no answer — try a shorter question, a larger context, or a stronger model)';
    else if (stopReason === 'maxTokens') {
      prose += `\n\n…*[response reached CodeExam's length cap (${maxTokens} tokens) — ask for the remaining part specifically]*`;
      console.log(`  [chat] response hit the ${maxTokens}-token cap`);
    }
    blocks.push({ type: 'text', text: prose });
    console.log(`  [chat] local final answer ${prose.length} chars (${blocks.filter(b => b.type === 'tool_use').length} tool calls)`);
    return { content: blocks, answer: prose };
  } finally {
    // #248: dispose the SESSION on every path (success OR throw) — the old code
    // disposed it only on success, leaking a session (with full history) on any
    // mid-generation error. NOT disposing `sequence`: it is the cached long-lived
    // per-model sequence (see acquireSharedSequence); the next chat resets it
    // with clearHistory.
    if (session) { try { session.dispose(); } catch (e) { console.warn(`  [chat] session dispose failed: ${e.message}`); } }
  }
  }); // #248 withLocalLock
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
        : ['claude', 'local', 'openai'].includes(params.engine) ? params.engine
        : null;
      if (engine === null) return errorResponse(res, `Unknown chat engine "${params.engine}". Use 'claude', 'openai', or 'local'.`, 400);
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
      } else if (engine === 'openai') {
        const model = params.model || serverLLM.defaultOpenAIModel;
        console.log(`  [chat] ${messages.length} msg(s) over "${indexName}", model=${model}, grounding=${mode}`);
        ({ content, answer } = await runChatToolLoopOpenAI({
          messages, index, indexName, fileCount: index.files.size, mode,
          apiKey: serverLLM.defaultOpenAIKey,
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
        : ['claude', 'local', 'openai'].includes(params.engine) ? params.engine
        : null;
      if (engine === null) { send('error', { error: `Unknown chat engine "${params.engine}". Use 'claude', 'openai', or 'local'.` }); return res.end(); }
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
      } else if (engine === 'openai') {
        const model = params.model || serverLLM.defaultOpenAIModel;
        console.log(`  [chat-stream] ${messages.length} msg(s) over "${indexName}", model=${model}, grounding=${mode}`);
        ({ answer } = await runChatToolLoopOpenAI({
          messages, index, indexName, fileCount: index.files.size, mode,
          apiKey: serverLLM.defaultOpenAIKey,
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
  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    const handler = routes[urlPath];
    if (handler) {
      try { handler(req, res); }
      catch (err) { console.error(`API error: ${urlPath}`, err); errorResponse(res, `Internal error: ${err.message}`, 500); }
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
    console.log(`  Claude API:  key configured (${serverLLM.defaultApiKey.slice(0, 10)}...)${isAirGapped() ? '  — BLOCKED by --air-gapped' : ''}`);
  } else if (isAirGapped()) {
    console.log(`  Claude API:  BLOCKED by --air-gapped (cloud key not loaded this run)`);
  } else {
    console.log(`  Claude API:  no key (set ANTHROPIC_API_KEY or --api-key)`);
  }
  if (serverLLM.defaultOpenAIKey) {
    console.log(`  OpenAI API:  key configured (${serverLLM.defaultOpenAIKey.slice(0, 10)}...)${isAirGapped() ? '  — BLOCKED by --air-gapped' : ''}`);
  } else if (isAirGapped()) {
    console.log(`  OpenAI API:  BLOCKED by --air-gapped (cloud key not loaded this run)`);
  } else {
    console.log(`  OpenAI API:  no key (set OPENAI_API_KEY or --openai-key)`);
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
