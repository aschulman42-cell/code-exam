// ============================================================================
// analyze.js - Phase 8b: LLM analysis integration for Code Exam
//
// Connects the extract -> analyze pipeline.  Ported from Python ce_analyze.py
// into the Node.js modular architecture.
//
// Analysis modes:
//   --analyze FUNCTION          General "what does this code do?" analysis
//   --claim-analyze CLAIM       End-to-end patent claim analysis: extract search
//                                terms from claim, find matching code, analyze
//                                matches against the claim.
//   --multisect-analyze TERMS   Search for functions matching semicolon-separated
//                                terms, then analyze the best 1-2 hits with LLM.
//   --file-analyze FILEPATH     Analyze an entire source file with LLM.
//
// All modes:
//   - Support --mask-all to strip comments and mask string contents
//   - Support --llm claude (API) or --analyze-model (local GGUF)
//   - Support --show-prompt to see what would be sent without calling LLM
//   - Support --line-numbers to include source line numbers in prompts
//
// Zero external deps for Claude API path.  Local GGUF requires node-llama-cpp.
// ============================================================================

import { extname } from 'path';
import { readFileSync, existsSync } from 'fs';
import https from 'https';
import http from 'http';
import {
  extractClaimTerms, sanitizeLlmTerms, sanitizeBroadTerms, dropStopListedTerms,
  CLAIM_EXTRACTION_PROMPT, CLAIM_EXTRACTION_PROMPT_LOCAL, parseTermResponse,
  buildExtractionPromptWithVocab, buildLocalExtractionPromptWithVocab,
  extractClaimKeywords, vocabConcordanceOptions,
} from './claim.js';
import { parseMultisectTerms, displayMultisectResults, printSelectivityReport } from './multisect.js';
import { displayName, claudeSupportsTemperature } from '../utils.js';
import { resolveProvider, PROVIDERS } from '../core/providers.js';
import { estimateCost } from '../core/pricing.js';
import { assertLocalOnly, isLocalApiUrl, isAirGapped } from '../core/air-gapped.js';
import { openaiSupportsTemperature, openaiCompletionBudget, openaiUsage, openaiText, openaiFinishReason } from '../core/openai-util.js';
import { makeDrafter, ggufDescriptor, resolveModel, claimsCostGate } from '../core/llm-runner.js';
import { buildSymbolTable } from '../core/symbol-verify.js';
import { splitClaimElements, retrievePerElement } from './claim-locate.js';


// ============================================================================
// LLM CLIENT
// ============================================================================

/**
 * Unified LLM interface for analysis - Claude API or local GGUF model.
 *
 * Singleton pattern: call getAnalysisLLM(opts) to get-or-create.
 * Two backends:
 *   - Claude API: built-in Node.js https (same as claim.js)
 *   - Local GGUF: node-llama-cpp (optional dependency)
 */
// #246: the cloud provider selected for this run (registry entry) or null for
// local/none. The single source for every "is this cloud?" / "which provider?"
// decision that used to be `use_claude || use_openai` (which silently excluded
// a 3rd provider from cost guards/caps) or `useOpenAI ? 'openai' : 'claude'`
// (which silently picked Claude for anything else — the #246 bug).
function selectedCloudProvider(args) {
  const id = args.llm || (args.use_openai ? 'openai' : args.use_claude ? 'claude' : null);
  return id ? resolveProvider(id, { allowDefault: false }).provider : null;
}

class AnalysisLLM {
  constructor(opts = {}) {
    // #246: the cloud backend is a resolved provider registry entry (or null
    // for a local GGUF), replacing the useClaude/useOpenAI binary. `provider`
    // may be passed directly, else derived from the legacy booleans.
    this.provider = opts.provider
      || (opts.useOpenAI ? PROVIDERS.openai : opts.useClaude ? PROVIDERS.claude : null);
    // Back-compat derived flags for external readers (label pickers, etc.).
    this.useClaude = this.provider?.wire === 'anthropic';
    this.useOpenAI = this.provider?.wire === 'openai-compat';  // openai OR gemini
    this.apiKey = opts.apiKey || null;
    this._compatKey = null;       // resolved key for the openai-compat provider
    this.modelPath = opts.modelPath || null;
    this.forceCpu = !!opts.forceCpu;              // #293: --cpu for the local GGUF path
    this.contextSize = opts.contextSize || null;  // #293: --context-size ladder head
    this.flashAttention = !!opts.flashAttention;  // #306 F67: was dropped here entirely
    this.liveTodayDate = !!opts.liveTodayDate;    // #306 F58: default pinned, so this was safe by luck
    this.claudeModel = opts.claudeModel || null;  // Claude API model id override
    this.openaiModel = opts.openaiModel || null;  // OpenAI model id override
    this.geminiModel = opts.geminiModel || null;  // Gemini model id override
    this.temperature = opts.temperature ?? 0.0;
    this.verbose = opts.verbose || false;

    this._llm = null;           // local GGUF drafter (llm-runner makeDrafter closure)
    this._requestCount = 0;
    this._totalInputTokens = 0;
    this._totalOutputTokens = 0;

    if (this.provider?.wire === 'anthropic') {
      this._initClaude(opts.apiKey);
    } else if (this.provider?.wire === 'openai-compat') {
      const explicitKey = this.provider.id === 'gemini' ? opts.geminiKey : opts.openaiKey;
      this._initCompat(explicitKey, opts.apiKey);
    } else if (this.modelPath) {
      // Local model init is async - call ensureLocalModel() before generate()
      this._localReady = false;
    }
  }

  /** True when the active backend is a cloud API (Claude / OpenAI / Gemini)
   *  rather than a local GGUF — drives the not-air-gapped disclaimer + caps. */
  isCloud() { return !!this.provider; }

  // --- Claude API ---

  _initClaude(apiKey) {
    // #223/#247 defense-in-depth: under --air-gapped resolve NO cloud key. The
    // env is already scrubbed at startup; this also skips the claude.txt file
    // read, so a stray key file can't re-arm a missed call-site guard. The call
    // sites (_callClaude) still assertLocalOnly, so this only removes the key
    // from memory — it does not become the sole line of defense.
    if (isAirGapped()) return;
    if (apiKey) {
      this.apiKey = apiKey;
    } else if (process.env.ANTHROPIC_API_KEY) {
      this.apiKey = process.env.ANTHROPIC_API_KEY;
    } else {
      // Try claude.txt in current directory
      for (const fname of ['claude.txt', 'claude_key.txt']) {
        try {
          const key = readFileSync(fname, 'utf-8').trim();
          if (key) { this.apiKey = key; break; }
        } catch { /* ignore */ }
      }
    }
    if (!this.apiKey) {
      process.stderr.write('ERROR: No API key found. Provide --api-key, set ANTHROPIC_API_KEY, or create claude.txt\n');
    }
  }

  async _callClaude(prompt, maxTokens = 500) {
    if (!this.apiKey) return '(Claude API not available - no API key)';

    const apiUrl = process.env.CLAIM_SEARCH_API_URL || 'https://api.anthropic.com/v1/messages';
    if (!isLocalApiUrl(apiUrl)) assertLocalOnly('analyze (cloud LLM)'); // #223: hostname-parsed, fail-closed
    const model = this.claudeModel || process.env.CLAIM_SEARCH_MODEL || 'claude-sonnet-4-6';
    // Frontier Claude models reject `temperature` (400); omit it there (#254/#215).
    const _claudeTemp = claudeSupportsTemperature(model);
    if (!_claudeTemp) process.stderr.write(`Note: ${model} does not accept a temperature — sampling default, runs may vary.\n`);

    const payload = JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(_claudeTemp ? { temperature: this.temperature } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    try {
      const body = await _httpPost(apiUrl, payload, {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      });

      this._requestCount++;
      if (body.usage) {
        this._totalInputTokens += body.usage.input_tokens || 0;
        this._totalOutputTokens += body.usage.output_tokens || 0;
      }

      const content = body.content || [];
      const text = content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();

      return text || '(Empty response)';
    } catch (e) {
      return `(Claude API error: ${String(e.message || e).slice(0, 200)})`;
    }
  }

  // --- OpenAI-compatible API (#243B OpenAI; #246 generalized to any
  //     openai-compat provider — OpenAI, Gemini, localhost gateways) ---

  /** Resolve the model id for the active openai-compat provider. Preserves
   *  OpenAI's CE_OPENAI_MODEL env override; Gemini uses its flag or default. */
  _compatModel() {
    if (this.provider.id === 'openai') return this.openaiModel || process.env.CE_OPENAI_MODEL || this.provider.defaultModel;
    if (this.provider.id === 'gemini') return this.geminiModel || this.provider.defaultModel;
    return this.provider.defaultModel;
  }

  _initCompat(explicitKey, apiKeyFallback) {
    // Key resolution mirrors _initClaude: provider flag > --api-key (selected
    // provider) > provider env var > provider key file. Generalized over the
    // registry entry so a new openai-compat provider needs no new code here.
    // #223/#247 defense-in-depth: resolve no cloud key under --air-gapped.
    if (isAirGapped()) return;
    this._compatKey = explicitKey || apiKeyFallback || process.env[this.provider.keyEnv] || '';
    if (!this._compatKey) {
      for (const fname of this.provider.keyFiles) {
        try {
          const key = readFileSync(fname, 'utf-8').trim();
          if (key) { this._compatKey = key; break; }
        } catch { /* ignore */ }
      }
    }
    if (!this._compatKey) {
      process.stderr.write(`ERROR: No ${this.provider.label} key found. Provide ${this.provider.keyFlag}/--api-key, set ${this.provider.keyEnv}, or create ${this.provider.keyFiles[0]}\n`);
    }
  }

  async _callOpenAI(prompt, maxTokens = 500) {
    if (!this._compatKey) return `(${this.provider.label} not available - no API key)`;

    // #246: baseUrl from the provider entry (OpenAI or Gemini's compat
    // endpoint), still overridable to a localhost gateway via CE_OPENAI_API_URL.
    const apiUrl = process.env.CE_OPENAI_API_URL || `${this.provider.baseUrl}/chat/completions`;
    if (!isLocalApiUrl(apiUrl)) assertLocalOnly('analyze (cloud LLM)'); // #223: hostname-parsed, fail-closed
    const model = this._compatModel();

    const payload = JSON.stringify({
      model,
      // Reasoning models (gpt-5*, o*) spend hidden tokens against this cap; floor
      // it so a Claude-tuned 500 isn't consumed entirely by reasoning (openai-util).
      max_completion_tokens: openaiCompletionBudget(model, maxTokens),
      ...(openaiSupportsTemperature(model) ? { temperature: this.temperature } : {}),
      messages: [{ role: 'user', content: prompt }],
    });

    try {
      const body = await _httpPost(apiUrl, payload, {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this._compatKey}`,
      });

      this._requestCount++;
      const u = openaiUsage(body.usage);
      this._totalInputTokens += u.input_tokens;
      this._totalOutputTokens += u.output_tokens;

      const text = openaiText(body);
      if (!text) {
        if (openaiFinishReason(body) === 'length') {
          return '(Empty response - token budget exhausted, likely by reasoning tokens; raise the budget or use a non-reasoning model)';
        }
        return '(Empty response)';
      }
      return text;
    } catch (e) {
      return `(${this.provider.label} error: ${String(e.message || e).slice(0, 200)})`;
    }
  }

  // --- Local GGUF model ---

  async ensureLocalModel() {
    if (this._llm || this._localReady) return;
    if (!this.modelPath) return;

    if (!existsSync(this.modelPath)) {
      process.stderr.write(`ERROR: Model file not found: ${this.modelPath}\n`);
      return;
    }

    // #293: delegate to llm-runner's shared GGUF drafter — 16k-first context
    // ladder (--context-size at its head, reported at load), #277 GPU->CPU
    // fallback, and ONE session reused across term extraction and analysis
    // with history reset between calls. The old per-call getSequence() +
    // sequence.dispose() pair leaked sequences on Gemma (dispose is a no-op —
    // upstream node-llama-cpp #623), so the second call died "No sequences
    // left"; the drafter never disposes, matching the pattern server.js
    // adopted for the GUI (#248). Model load is lazy (first generate), so an
    // existing-but-unloadable file surfaces there, not here.
    // ggufDescriptor rather than an object literal: this site silently dropped
    // `flashAttention` because it hand-rolled the descriptor, and --analyze on a
    // large file with a 20B model is exactly the case that flag exists for
    // (#306 F67). The factory means the next field cannot be missed here.
    this._llm = makeDrafter(ggufDescriptor({
      modelPath: this.modelPath, forceCpu: this.forceCpu, contextSize: this.contextSize,
      flashAttention: this.flashAttention, liveTodayDate: this.liveTodayDate,
    }), this.temperature);
    this._localReady = true;
  }

  async _callLocal(prompt, maxTokens = 500) {
    await this.ensureLocalModel();
    if (!this._llm) return '(Local LLM not loaded)';

    try {
      const response = await this._llm(prompt, '', maxTokens);
      return response.trim();
    } catch (e) {
      return `(Local LLM error: ${String(e.message || e).slice(0, 200)})`;
    }
  }

  // --- Unified interface ---

  isAvailable() {
    if (this.provider?.wire === 'anthropic') return !!this.apiKey;
    if (this.provider?.wire === 'openai-compat') return !!this._compatKey;
    return !!this._llm || !!this.modelPath; // modelPath means we'll try to load
  }

  async generate(prompt, maxTokens = 500) {
    if (this.provider?.wire === 'anthropic') return this._callClaude(prompt, maxTokens);
    if (this.provider?.wire === 'openai-compat') return this._callOpenAI(prompt, maxTokens);
    if (this.modelPath) return this._callLocal(prompt, maxTokens);
    return '(No LLM available - use --llm claude|openai|gemini, or --analyze-model)';
  }

  getUsageSummary() {
    if (!this.isCloud() || this._requestCount === 0) return '';
    // Shared pricing helper — was hardcoded to Sonnet's $3/$15 per 1M regardless
    // of model, so it under-reported ~40% once --claude-model selects Opus.
    const model = this.provider.wire === 'openai-compat'
      ? this._compatModel()
      : (this.claudeModel || process.env.CLAIM_SEARCH_MODEL || 'claude-sonnet-4-6');
    const { usd: totalCost } = estimateCost(model, {
      input_tokens: this._totalInputTokens, output_tokens: this._totalOutputTokens,
    });
    const label = `${this.provider.label} Usage`;
    return `${label}: ${this._requestCount} requests, ` +
      `${this._totalInputTokens.toLocaleString()} in / ${this._totalOutputTokens.toLocaleString()} out, ` +
      `~$${totalCost.toFixed(4)}`;
  }
}


// Singleton instance
let _llmInstance = null;

/**
 * Get or create the singleton LLM instance.
 */
function getAnalysisLLM(opts = {}) {
  if (!_llmInstance) {
    // #246: resolve the cloud provider through the registry. Priority: an
    // explicit --llm id (incl. gemini) > the legacy use_openai/use_claude
    // booleans. A local GGUF (analyze_model) is NOT a cloud provider — leave
    // provider null. `allowDefault:false` means "no cloud unless asked".
    let providerId = opts.llm
      || (opts.use_openai || opts.useOpenAI ? 'openai'
        : opts.use_claude || opts.useClaude ? 'claude' : null);
    const { provider } = providerId
      ? resolveProvider(providerId, { allowDefault: false })
      : { provider: null };

    const apiKey = opts.apiKey || opts.api_key || null;
    const openaiKey = opts.openaiKey || opts.openai_key || null;
    const geminiKey = opts.geminiKey || opts.gemini_key || null;
    // #293: --model routes here too — same precedence as llm-runner's resolveModel.
    const modelPath = opts.modelPath || opts.model || opts.analyze_model || null;
    const claudeModel = opts.claudeModel || opts.claude_model || null;
    const openaiModel = opts.openaiModel || opts.openai_model || null;
    const geminiModel = opts.geminiModel || opts.gemini_model || null;
    const temperature = opts.temperature ?? 0.0;
    const verbose = opts.verbose || false;
    const forceCpu = !!opts.cpu;
    const contextSize = opts.context_size || null;
    // #306 F67: these two reach the GGUF context/wrapper and were not threaded.
    const flashAttention = !!(opts.flashAttention || opts.flash_attention);
    const liveTodayDate = !!(opts.liveTodayDate || opts.live_today_date);

    if (provider) {
      console.log();
      console.log('='.repeat(70));
      console.log(`WARNING:  WARNING: ${provider.label.toUpperCase()} MODE - NOT AIR-GAPPED`);
      console.log('='.repeat(70));
      console.log(`Code will be sent to ${provider.label} over the internet.`);
      if (opts.maskAll || opts.mask_all) {
        console.log('String contents will be masked before sending.');
      } else {
        console.log('Use --mask-all to strip comments and mask strings before sending.');
      }
      console.log('='.repeat(70));
      console.log();
    }

    _llmInstance = new AnalysisLLM({
      provider, apiKey, openaiKey, geminiKey, modelPath, claudeModel, openaiModel, geminiModel, temperature, verbose,
      forceCpu, contextSize, flashAttention, liveTodayDate,
    });
  }
  return _llmInstance;
}

/**
 * Reset singleton (for testing).
 */
export function resetAnalysisLLM() {
  _llmInstance = null;
}


// ============================================================================
// SIMPLE MASKER - Layers 1 + 2 + 3 (comments + strings + identifiers)
// ============================================================================

/**
 * Mask identifiers, comments, and string literals in source code.
 *
 * Three layers of masking for genuine IP protection:
 *
 * Layer 1 — Comments:  Stripped entirely.  Comments like
 *           "// Step 3: Verify certificate chain" are dead giveaways.
 * Layer 2 — String literals:  Replaced with STR_N placeholders.
 *           "Cipher negotiation failed for %s" reveals the function's
 *           purpose even when all identifiers are masked.  We preserve
 *           the quotes and the fact that a string *exists*.
 * Layer 3 — Identifiers:  Function name, parameters, local variables,
 *           called functions.  Regex-based heuristic approach that works
 *           on raw source text without needing a parsed AST.  Handles
 *           common cases for C, C++, Java, JavaScript/TS, and Python.
 *
 * Ported from Python ce_analyze.py SimpleMasker.
 */
export class SimpleMasker {
  constructor() {
    this._counter = 0;
    this._map = {};        // original name -> masked name
    this._strCounter = 0;
  }

  /** Map an identifier to a masked name (stable: same input → same output). */
  _mask(name, category) {
    if (this._map[name]) return this._map[name];
    this._counter++;
    const masked = `${category}_${this._counter}`;
    this._map[name] = masked;
    return masked;
  }

  _nextStr() {
    this._strCounter++;
    return `STR_${this._strCounter}`;
  }

  /** Detect SQL-like string content (SELECT, INSERT, CREATE TABLE, etc.). */
  _looksLikeSQL(s) {
    return /\b(SELECT\s+.+\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX))\b/i.test(s);
  }

  // -----------------------------------------------------------------
  // Layer 1: Strip comments
  // -----------------------------------------------------------------

  stripComments(code, language) {
    if (language === 'c' || language === 'cpp' || language === 'java' || language === 'javascript') {
      return code.replace(
        /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (match, quoted) => quoted || ' '
      );
    }
    if (language === 'python') {
      return code.replace(
        /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|#[^\n]*/g,
        (match, quoted) => quoted || ''
      );
    }
    return code;
  }

  // -----------------------------------------------------------------
  // Layer 2: Mask string literal contents
  // -----------------------------------------------------------------

  maskStrings(code, language) {
    const _maskOne = (match) => {
      // Preserve short char literals ('x')
      if (match.startsWith("'") && match.length <= 4) return match;
      // Preserve SQL-like strings — they reveal query structure, not IP
      const inner = match.slice(match.startsWith('"""') || match.startsWith("'''") ? 3 : 1,
                                match.endsWith('"""') || match.endsWith("'''") ? -3 : -1);
      if (this._looksLikeSQL(inner)) return match;
      const quote = match.startsWith('"""') || match.startsWith("'''")
        ? match.slice(0, 3) : match.startsWith('`') ? '`' : match[0];
      return `${quote}${this._nextStr()}${quote}`;
    };

    if (language === 'c' || language === 'cpp' || language === 'java' || language === 'javascript') {
      code = code.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, _maskOne);
      if (language === 'javascript') {
        code = code.replace(/`(?:[^`\\]|\\.)*`/g, _maskOne);
      }
      return code;
    }
    if (language === 'python') {
      return code.replace(
        /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g,
        _maskOne
      );
    }
    return code;
  }

  // -----------------------------------------------------------------
  // Combined Layer 1 + 2 (for file-level masking without func context)
  // -----------------------------------------------------------------

  mask(source, language) {
    let code = this.stripComments(source, language);
    code = this.maskStrings(code, language);
    return code;
  }

  // -----------------------------------------------------------------
  // Layer 3: Mask identifiers (function name, params, locals, calls)
  // -----------------------------------------------------------------

  /**
   * Full 3-layer masking: comments, strings, and identifiers.
   *
   * @param {string} source - Raw function source code
   * @param {string} funcName - Function name (may include Class:: prefix)
   * @param {string} language - 'c'|'cpp'|'java'|'javascript'|'python'
   * @returns {string} Masked source code
   */
  maskFunctionSource(source, funcName, language) {
    // --- Layer 1: Strip comments ---
    let code = this.stripComments(source, language);

    // --- Layer 2: Mask string contents ---
    code = this.maskStrings(code, language);

    // --- Layer 3: Mask identifiers ---

    const _isMasked = (n) => /^(?:FUNC|PARAM|VAR|CALL|STR)_\d+$/.test(n);

    // 3a. Mask function name
    if (funcName) {
      const bare = funcName.includes('::') ? funcName.split('::').pop() : funcName;
      if (bare.length > 1) {
        const masked = this._mask(bare, 'FUNC');
        code = code.replace(new RegExp('\\b' + _escRe(bare) + '\\b', 'g'), masked);
      }
    }

    // 3b. Detect and mask parameter names
    // For JS/TS, use code (post-comment-strip) for sig detection
    // For C/Python, use original source
    const sigLines = language === 'javascript'
      ? code.split('\n').slice(0, 10).join('\n')
      : source.split('\n').slice(0, 5).join('\n');

    const _KEYWORDS = new Set([
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
      'continue', 'return', 'void', 'int', 'char', 'float', 'double',
      'long', 'short', 'unsigned', 'signed', 'const', 'static',
      'struct', 'enum', 'typedef', 'sizeof', 'NULL', 'nullptr',
      'true', 'false', 'class', 'public', 'private', 'protected',
      'self', 'cls', 'def', 'import', 'from', 'None', 'True', 'False',
      'and', 'or', 'not', 'in', 'is', 'lambda', 'try', 'except',
      'finally', 'raise', 'with', 'as', 'yield', 'pass', 'goto',
      'size_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
      'int8_t', 'int16_t', 'int32_t', 'int64_t', 'bool', 'string',
    ]);

    if (language === 'javascript') {
      // JS/TS: untyped params — extract names from signature parentheses
      const parenStart = sigLines.indexOf('(');
      if (parenStart >= 0) {
        let depth = 0, parenEnd = parenStart;
        for (let i = parenStart; i < sigLines.length; i++) {
          if (sigLines[i] === '(') depth++;
          else if (sigLines[i] === ')') { depth--; if (depth === 0) { parenEnd = i; break; } }
        }
        const paramStr = sigLines.slice(parenStart + 1, parenEnd);
        const _jsSkip = new Set([..._KEYWORDS,
          'async', 'await', 'const', 'let', 'var', 'function', 'class',
          'new', 'this', 'undefined', 'null', 'typeof', 'instanceof',
          'delete', 'void', 'throw', 'catch', 'export', 'import',
          'default', 'extends', 'super', 'yield', 'of', 'from',
          'true', 'false', 'static', 'get', 'set',
        ]);
        for (const pm of paramStr.matchAll(/\b(\w+)\b/g)) {
          const pname = pm[1];
          if (pname.length > 1 && !_jsSkip.has(pname) && !_isMasked(pname)) {
            const masked = this._mask(pname, 'PARAM');
            code = code.replace(new RegExp('\\b' + _escRe(pname) + '\\b', 'g'), masked);
          }
        }
      }
    } else if (language === 'c' || language === 'cpp' || language === 'java') {
      // C-family: type *?name [;=,)]
      const paramPat = /(?:const\s+)?(?:unsigned\s+)?(?:struct\s+)?\w+[\s*&]+(\w+)\s*[,)]/g;
      for (const m of sigLines.matchAll(paramPat)) {
        const pname = m[1];
        if (pname && pname.length > 1 && !_KEYWORDS.has(pname) && !_isMasked(pname)) {
          const masked = this._mask(pname, 'PARAM');
          code = code.replace(new RegExp('\\b' + _escRe(pname) + '\\b', 'g'), masked);
        }
      }
    } else {
      // Python: self, name: or name= or name)
      const pyParamPat = /(?:self|cls)\s*,\s*|(\w+)\s*(?:[:,=)])/g;
      for (const m of sigLines.matchAll(pyParamPat)) {
        const pname = m[1];
        if (pname && pname.length > 1 && !_KEYWORDS.has(pname) && !_isMasked(pname)) {
          const masked = this._mask(pname, 'PARAM');
          code = code.replace(new RegExp('\\b' + _escRe(pname) + '\\b', 'g'), masked);
        }
      }
    }

    // 3c. Mask local variable declarations
    const localVars = new Set();

    if (language === 'javascript') {
      const _jsSkip = new Set([..._KEYWORDS,
        'async', 'await', 'const', 'let', 'var', 'function', 'class',
        'new', 'this', 'undefined', 'null', 'typeof', 'instanceof',
        'delete', 'void', 'throw', 'catch', 'export', 'import',
        'default', 'extends', 'super', 'yield', 'of', 'from',
        'true', 'false', 'static', 'get', 'set',
      ]);
      const _jsAdd = (name) => {
        if (name && name.length > 1 && !_jsSkip.has(name) && !_isMasked(name))
          localVars.add(name);
      };

      // const/let/var name = ...
      for (const m of code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=/g)) _jsAdd(m[1]);

      // Destructuring: const { a, b } = ... or const [a, b] = ...
      for (const m of code.matchAll(/\b(?:const|let|var)\s*[{[]([^\]}]+)[}\]]\s*=/g)) {
        for (const n of m[1].matchAll(/\w+/g)) _jsAdd(n[0]);
      }

      // for (const/let/var name of/in ...)
      for (const m of code.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+(\w+)\s+(?:of|in)\b/g)) _jsAdd(m[1]);

      // catch (e)
      for (const m of code.matchAll(/\bcatch\s*\(\s*(\w+)\s*\)/g)) _jsAdd(m[1]);

    } else if (language === 'c' || language === 'cpp' || language === 'java') {
      // C-family: type *?name [;=,[
      const localPat = /\b(int|double|float|char|long|short|unsigned|size_t|void|bool|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int64_t)\s+\*?\s*(\w+)\s*[;=,[\]]/g;
      for (const m of code.matchAll(localPat)) {
        const vname = m[2];
        if (vname.length > 1 && !_KEYWORDS.has(vname) && !_isMasked(vname)) localVars.add(vname);
      }
      // for-loop variables: for (int i = ...)
      for (const m of code.matchAll(/for\s*\(\s*(?:int|size_t)\s+(\w+)\s*=/g)) {
        if (!_isMasked(m[1])) localVars.add(m[1]);
      }

    } else {
      // Python: assignment targets
      const _PY_BUILTINS = new Set([
        'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter',
        'isinstance', 'hasattr', 'getattr', 'setattr', 'super',
        'open', 'close', 'read', 'write', 'append', 'extend',
        'sort', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs',
        'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
        'type', 'id', 'hash', 'repr', 'format', 'any', 'all',
        'iter', 'next', 'input', 'property', 'staticmethod',
        'classmethod', 'ValueError', 'TypeError', 'KeyError',
        'IndexError', 'AttributeError', 'RuntimeError', 'Exception',
        'StopIteration', 'FileNotFoundError', 'IOError', 'OSError',
      ]);
      const _pySkip = new Set([..._KEYWORDS, ..._PY_BUILTINS]);
      const _pyAdd = (name) => {
        if (name && name.length > 1 && !_pySkip.has(name)
            && !_isMasked(name) && !name.startsWith('__'))
          localVars.add(name);
      };

      // Simple/augmented assignment: name = / name += etc.
      for (const m of code.matchAll(/^[ \t]*(\w+)\s*(?:=|\+=|-=|\*=|\/=|\/\/=|%=|\|=|&=|\^=|<<=|>>=)/gm)) {
        // Skip name == (comparison)
        const pos = m.index + m[0].length;
        if (code[pos - 1] === '=' && code[pos] === '=') continue;
        _pyAdd(m[1]);
      }

      // Tuple unpacking: a, b = ...
      for (const m of code.matchAll(/^[ \t]*((?:\w+\s*,\s*)+\w+)\s*=/gm)) {
        for (const n of m[1].matchAll(/\w+/g)) _pyAdd(n[0]);
      }

      // for name in ...
      for (const m of code.matchAll(/\bfor\s+(\w+)\s+in\b/g)) _pyAdd(m[1]);

      // for name, name2 in ...
      for (const m of code.matchAll(/\bfor\s+((?:\w+\s*,\s*)+\w+)\s+in\b/g)) {
        for (const n of m[1].matchAll(/\w+/g)) _pyAdd(n[0]);
      }

      // with ... as name
      for (const m of code.matchAll(/\bas\s+(\w+)\s*:/g)) _pyAdd(m[1]);

      // except ... as name
      for (const m of code.matchAll(/\bexcept\s+\w+\s+as\s+(\w+)/g)) _pyAdd(m[1]);
    }

    // Apply local variable masking
    for (const vname of localVars) {
      const masked = this._mask(vname, 'VAR');
      code = code.replace(new RegExp('\\b' + _escRe(vname) + '\\b', 'g'), masked);
    }

    // 3d. Mask remaining function calls (word followed by '(')
    const _STD_CALLS = new Set([
      'printf', 'fprintf', 'sprintf', 'snprintf', 'malloc', 'calloc',
      'realloc', 'free', 'memset', 'memcpy', 'memmove', 'memcmp',
      'strlen', 'strcpy', 'strncpy', 'strcmp', 'strncmp', 'strcat',
      'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs',
      'assert', 'exit', 'abort', 'sizeof', 'offsetof',
      'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter',
      'isinstance', 'hasattr', 'getattr', 'setattr', 'super',
      'open', 'close', 'read', 'write', 'append', 'extend',
      'sort', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs',
      'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
      'type', 'id', 'hash', 'repr', 'format',
      // JS common
      'require', 'console', 'log', 'warn', 'error', 'push', 'pop',
      'shift', 'unshift', 'slice', 'splice', 'concat', 'join',
      'indexOf', 'includes', 'find', 'forEach', 'map', 'filter',
      'reduce', 'some', 'every', 'Object', 'Array', 'String',
      'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Promise',
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent',
    ]);
    const _maskedValues = new Set(Object.values(this._map));

    for (const m of code.matchAll(/\b(\w+)\s*\(/g)) {
      const cname = m[1];
      if (cname.length > 1
          && !_maskedValues.has(cname)
          && !_KEYWORDS.has(cname)
          && !_STD_CALLS.has(cname)
          && !_isMasked(cname)
          && !this._map[cname]) {
        const masked = this._mask(cname, 'CALL');
        code = code.replace(new RegExp('\\b' + _escRe(cname) + '\\b', 'g'), masked);
      }
    }

    // 3e. Mask member property accesses (.name patterns not yet masked)
    //     Catches this.invertedIndex, obj._privateProp, etc.
    const _SAFE_MEMBERS = new Set([
      // Generic object properties
      'length', 'size', 'prototype', 'constructor', 'name', 'message',
      'stack', 'index', 'input', 'groups', 'cause',
      'next', 'done', 'value', 'key', 'type', 'code', 'data',
      'writable', 'enumerable', 'configurable',
      'global', 'ignoreCase', 'multiline', 'source', 'flags',
      'buffer', 'byteLength', 'byteOffset',
      'target', 'currentTarget', 'status', 'statusText',
      'ok', 'body', 'headers', 'url', 'method', 'path',
      'width', 'height', 'top', 'left', 'right', 'bottom',
      'parent', 'children', 'firstChild', 'lastChild', 'nextSibling',
      'result', 'results', 'count', 'total', 'offset', 'limit',
      'start', 'end', 'min', 'max', 'default', 'options', 'config',
      'args', 'argv', 'env', 'pid', 'cwd', 'stdin', 'stdout', 'stderr',
    ]);

    for (const m of code.matchAll(/\.(\w+)\b/g)) {
      const pname = m[1];
      if (pname.length > 1
          && !_isMasked(pname)
          && !this._map[pname]
          && !_KEYWORDS.has(pname)
          && !_STD_CALLS.has(pname)
          && !_SAFE_MEMBERS.has(pname)) {
        const masked = this._mask(pname, 'PROP');
        code = code.replace(new RegExp('\\b' + _escRe(pname) + '\\b', 'g'), masked);
      }
    }

    return code;
  }
}

/** Escape string for use in RegExp. */
function _escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


// ============================================================================
// LANGUAGE DETECTION
// ============================================================================

/**
 * Detect language from filepath extension (for masking purposes).
 */
export function detectLanguage(filepath) {
  const ext = extname(filepath).toLowerCase();
  if (ext === '.py' || ext === '.pyw') return 'python';
  if (ext === '.c' || ext === '.h') return 'c';
  if (ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.hpp' || ext === '.hxx' || ext === '.h++') return 'cpp';
  if (ext === '.java') return 'java';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return 'javascript';
  return 'c'; // default fallback
}


// ============================================================================
// LINE NUMBERS
// ============================================================================

/**
 * Prepend line numbers to source code.
 *
 * @param {string} source - Source code text
 * @param {number} startLine - 1-based line number of first line in original file
 * @returns {string} Numbered source
 */
export function addLineNumbers(source, startLine = 1) {
  const lines = source.split('\n');
  const endLine = startLine + lines.length - 1;
  const width = String(endLine).length;
  return lines.map((line, i) => {
    const lineno = startLine + i;
    return `${String(lineno).padStart(width)} | ${line}`;
  }).join('\n');
}


// ============================================================================
// PROMPT BUILDERS
// ============================================================================

/**
 * General analysis prompt - "what does this code do?"
 */
export function buildAnalyzePrompt(funcSource, funcName, filepath, masked) {
  if (masked === 'masked' || masked === true) {
    return `You are analyzing code where comments have been stripped and string contents masked.
Analyze the actual code logic and operations, not string contents.

FUNCTION TO ANALYZE:
${funcSource}

CRITICAL INSTRUCTIONS:
1. Analyze the actual code logic - operations, algorithms, formulas
2. Note specific values used (constants, thresholds, magic numbers)
3. Describe what data transformations occur
4. Identify known algorithms by name (e.g., "QuickSort", "DJB2 hash", "binary search", "Adam optimizer", "Euclidean GCD")
5. Be specific: describe inputs, processing steps, and outputs
6. Keep your response concise - under 150 words
7. End with: "In summary, this function implements [algorithm/purpose]."

Provide a detailed description of what this code does:`;
  }

  const preamble = masked === 'comments'
    ? 'You are analyzing code where comments have been stripped. Identifiers and strings are intact.'
    : `Analyze this function with full context.\n\nSOURCE FILE: ${filepath}`;

  return `${preamble}

FUNCTION TO ANALYZE:
${funcSource}

CRITICAL INSTRUCTIONS:
1. Describe what the code actually does (not just what the name suggests)
2. Note specific constant values used
3. Identify algorithms and techniques by their standard names
4. Describe inputs, processing, and outputs
5. Keep your response concise - under 150 words
6. End with: "In summary, this function implements [algorithm/purpose]."

Provide a detailed description:`;
}


/**
 * Claim analysis prompt - "does this code implement these claim elements?"
 */
export function buildClaimAnalyzePrompt(funcSource, funcName, filepath, claimText, masked) {
  const preamble = (masked === 'masked' || masked === true)
    ? 'You are analyzing code where comments have been stripped and string contents masked. Analyze the actual code logic, not names.'
    : masked === 'comments'
    ? 'You are analyzing code where comments have been stripped. Identifiers and strings are intact.'
    : `SOURCE FILE: ${filepath}`;

  return `${preamble}

FUNCTION TO ANALYZE:
${funcSource}

PATENT CLAIM TEXT:
${claimText}

TASK: For each element/limitation in the patent claim, categorize how this
function relates to it using EXACTLY one of these labels:

  PRESENT  - The code in this function plainly implements the element.
             You MUST quote the specific line(s) that perform the
             element's action, verbatim. If you cannot quote such a line
             from THIS function, the label is not PRESENT.
  ASSUMED  - The function calls another function whose NAME suggests it
             implements the element, but the actual implementation is not
             visible in this code. State what you are assuming and why.
  PARTIAL  - The code configures, prepares, or partially addresses the
             element, but does not fully implement it. Explain the gap.
  ABSENT   - No code in this function implements or references this element.

CRITICAL INSTRUCTIONS:
1. For each claim element, first describe what the code actually does in
   plain language, THEN assign the label. Do not skip the description.
2. A suggestive function or variable NAME is not the same as implementation.
   If you can only see a call like validateRecord(entry) but not the
   validation logic, that is ASSUMED, not PRESENT.
3. Configuration that would be used BY an implementation is PARTIAL,
   not PRESENT (e.g., storing a maxRetryCount setting is not the same as
   performing the retries).
4. ADJACENT ROLE IS NOT IMPLEMENTATION: code that reads, hashes,
   displays, records, or consumes the RESULTS of a mechanism does not
   implement that mechanism (a function hashing a menu's fields does not
   IDENTIFY menus; a function reading ledger entries does not CREATE
   them). Label such code PARTIAL or ABSENT for that element.
5. Note any operations in the code that go BEYOND what the claim describes.
6. Be specific: cite line numbers and operations.
7. Keep your response concise - under 350 words.
8. End with a COVERAGE summary, e.g.:
   "Claim coverage: 2 PRESENT, 1 ASSUMED, 1 PARTIAL, 1 ABSENT out of 5 elements."

Analyze the function against the patent claim:`;
}


/**
 * Multisect analysis prompt - "describe this code in relation to these terms."
 */
export function buildMultisectAnalyzePrompt(funcSource, funcName, filepath, terms, masked) {
  const preamble = (masked === 'masked' || masked === true)
    ? 'You are analyzing code where comments have been stripped and string contents masked. Analyze the actual code logic, not names.'
    : masked === 'comments'
    ? 'You are analyzing code where comments have been stripped. Identifiers and strings are intact.'
    : `SOURCE FILE: ${filepath}`;

  const termsList = terms.map((t, i) => `  ${i + 1}. ${t}`).join('\n');

  return `${preamble}

FUNCTION TO ANALYZE:
${funcSource}

SEARCH TERMS THAT LED TO THIS FUNCTION:
${termsList}

TASK: Produce your response in THREE parts, in this order: a one-line search
restatement, a structured per-term verdict block, then a prose summary.

PART 0 - SEARCH RESTATEMENT: Begin your response with a single line listing
the search terms, so the report stands on its own:

  SEARCH TERMS: <term 1>; <term 2>; ...

PART 1 - TERM VERDICTS: Output one line for EVERY search term above, in order.
Use EXACTLY this format, one line per term, no blank lines between them:

  TERM <n> (<term text>): <verdict> | evidence: <line numbers or a short quote> | confidence: <high|medium|low>

where <term text> is the search term itself, copied verbatim from the numbered
list above (this makes each verdict line self-describing).

<verdict> must be EXACTLY one of these four keywords:
  PRESENT    - the term is implemented as actual logic in this function
  NAME-ONLY  - the term appears only as a name (a variable, identifier, or
               call), not as implemented logic visible in this code
  IFFY       - partial, configuration-only, or otherwise ambiguous relation
  ABSENT     - nothing in this function relates to the term

Example block:
  TERM 1 (claude): PRESENT | evidence: lines 14-19 hash the request buffer | confidence: high
  TERM 2 (anthropic): NAME-ONLY | evidence: calls validateChain() at line 22 | confidence: medium

PART 2 - SUMMARY: After the verdict block, write a prose summary (under 200
words): the overall purpose of the function and how the search terms connect
to form a coherent picture. Cite specific code lines and operations.

Begin with the SEARCH TERMS line, then the TERM VERDICTS block, then the SUMMARY:`;
}


/**
 * Tolerant parser for the structured per-term verdict block emitted under the
 * buildMultisectAnalyzePrompt instructions. Local LLMs vary in format
 * compliance, so this scans loosely: it accepts any line that names a term by
 * number and carries a recognizable verdict keyword, and tolerates missing or
 * reordered evidence/confidence fields.
 *
 * Returns { verdicts, prose }:
 *   verdicts - array of { term, verdict, evidence, confidence }, one per
 *              recognized row. `term` is the 1-based term index from the
 *              prompt's numbered list. `verdict` is normalized to one of
 *              'present' | 'name-only' | 'iffy' | 'absent'. `evidence` and
 *              `confidence` are '' when the model omitted them.
 *   prose    - the summary text following the verdict block (a leading
 *              PART 2 / SUMMARY header is stripped). Falls back to the whole
 *              response when no verdict rows were found.
 */
export function parseMultisectAnalyzeVerdicts(response) {
  const empty = { verdicts: [], prose: (response || '').trim() };
  if (!response || typeof response !== 'string') return empty;

  const lines = response.split(/\r?\n/);
  const verdicts = [];
  let lastVerdictLine = -1;

  // Match the verdict keyword in the segment before the first '|' only, so an
  // "absent" row whose evidence text happens to mention "present" is not
  // misread.
  const normVerdict = (head) => {
    const t = head.toLowerCase();
    if (/name[\s-]*only/.test(t)) return 'name-only';
    if (/\bpresent\b/.test(t)) return 'present';
    if (/\babsent\b/.test(t)) return 'absent';
    if (/\biffy\b|\bpartial\b|\bambiguous\b/.test(t)) return 'iffy';
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // A verdict row names a term by number, optionally with the term text in
    // parens: "TERM 3 (foo):", "TERM 3:", "Term 3 -", "3.", "- Term 3:" all
    // qualify. The "(...)" group is optional so old-format output still parses.
    const m = raw.match(/^\s*(?:[-*]\s*)?(?:term\s*)?(\d+)\s*(?:\([^)]*\))?\s*[:.)\-]/i);
    if (!m) continue;
    // Read the verdict from after the term-label prefix and before the first
    // '|', so neither the parenthesized term text nor the evidence field can
    // contribute a stray verdict keyword.
    const verdict = normVerdict(raw.slice(m[0].length).split('|')[0]);
    if (!verdict) continue;  // a numbered line with no verdict keyword is prose

    const evMatch = raw.match(/evidence\s*[:\-]\s*([^|]+)/i);
    const confMatch = raw.match(/confidence\s*[:\-]\s*(high|medium|low|[A-Za-z]+)/i);
    verdicts.push({
      term: Number(m[1]),
      verdict,
      evidence: evMatch ? evMatch[1].trim() : '',
      confidence: confMatch ? confMatch[1].trim().toLowerCase() : '',
    });
    lastVerdictLine = i;
  }

  if (verdicts.length === 0) return empty;

  let prose = lines.slice(lastVerdictLine + 1).join('\n').trim();
  prose = prose.replace(/^\s*(?:part\s*2\s*[-—:]*\s*)?summary\s*[:.\-—]*\s*/i, '').trim();
  return { verdicts, prose };
}


/**
 * Context analysis prompt - "analyze this code in the context of provided text."
 *
 * Generic prompt that works with any context text: patent claims, design specs,
 * requirements, bug reports, etc.  Adapts its analysis based on what the
 * context text appears to describe.
 */
export function buildContextAnalyzePrompt(funcSource, funcName, filepath, contextText, masked) {
  const preamble = (masked === 'masked' || masked === true)
    ? 'You are analyzing code where comments have been stripped and string contents masked. Analyze the actual code logic, not names.'
    : masked === 'comments'
    ? 'You are analyzing code where comments have been stripped. Identifiers and strings are intact.'
    : `SOURCE FILE: ${filepath}`;

  return `${preamble}

FUNCTION TO ANALYZE:
${funcSource}

CONTEXT (provided by user — could be a patent claim, specification, design
document, requirement, or other descriptive text):
${contextText}

TASK: Analyze the function in relation to the context text above.

INSTRUCTIONS:
1. First, briefly describe what the code actually does (2-3 sentences).
2. Then, for each concept, element, or requirement described in the context
   text, explain whether and how this function relates to it:
   - PRESENT: The code plainly implements this. Cite specific lines.
   - ASSUMED: A function/variable name suggests it, but the actual logic
     is in code not shown here. State what you are assuming.
   - PARTIAL: The code partially addresses this. Explain the gap.
   - ABSENT: No code here implements or references this.
3. Note any operations in the code that go BEYOND what the context describes.
4. Be specific: cite line numbers, operations, and data flow.
5. Keep your response concise - under 350 words.
6. End with a brief summary, e.g.:
   "Summary: 2 PRESENT, 1 ASSUMED, 1 PARTIAL, 1 ABSENT out of 5 elements."

Analyze the function against the context text:`;
}


/**
 * File-level analysis prompt - "what does this file do?"
 */
export function buildFileAnalyzePrompt(fileSource, filepath, masked, funcNames = null) {
  const preamble = (masked === 'masked' || masked === true)
    ? 'You are analyzing code where comments have been stripped and string contents masked. Analyze the actual code logic, not names.'
    : masked === 'comments'
    ? 'You are analyzing code where comments have been stripped. Identifiers and strings are intact.'
    : `SOURCE FILE: ${filepath}`;

  const funcHint = (funcNames && masked !== 'masked' && masked !== true && funcNames.length > 0)
    ? `\n\nFUNCTIONS IN THIS FILE: ${funcNames.join(', ')}`
    : '';

  return `${preamble}

FILE TO ANALYZE:
${fileSource}${funcHint}

CRITICAL INSTRUCTIONS:
1. Describe the overall purpose and responsibility of this file.
2. Identify the key functions and explain what each does (1-2 sentences each).
3. Describe the data flow: what comes in, how it's transformed, what goes out.
4. Note any design patterns, algorithms, or architectural decisions.
5. Identify external dependencies (libraries, APIs, system calls).
6. If there are potential issues (error handling gaps, security concerns), note them.
7. Keep your response to 2-3 concise paragraphs (under 400 words).
8. End with: "In summary, this file implements [purpose]."

Provide a comprehensive analysis:`;
}


/**
 * File-level claim analysis prompt (fallback when no function match).
 */
function buildClaimFilePrompt(fileSource, filepath, nLines, claimText, masked) {
  const preamble = (masked === 'masked' || masked === true)
    ? 'You are analyzing code where comments have been stripped and string contents masked. Analyze the actual code logic.'
    : masked === 'comments'
    ? 'You are analyzing code where comments have been stripped. Identifiers and strings are intact.'
    : `SOURCE FILE: ${filepath}`;

  return `${preamble}

FILE TO ANALYZE (${nLines} lines):
${fileSource}

PATENT CLAIM TEXT:
${claimText}

TASK: For each element/limitation in the patent claim, categorize how this
file relates to it using EXACTLY one of these labels:

  PRESENT  - Code in this file plainly implements the element. Cite lines.
  ASSUMED  - A function name suggests it implements the element, but the
             logic is in a called function not shown. State your assumption.
  PARTIAL  - Code addresses the element partially. Explain the gap.
  ABSENT   - No code implements or references this element.

CRITICAL INSTRUCTIONS:
1. For each claim element, describe what the code does, then assign a label.
2. A suggestive name is not implementation - that is ASSUMED, not PRESENT.
3. Note operations that go BEYOND the claim.
4. Cite specific function names, line operations, and data flow.
5. Keep your response concise - under 400 words.
6. End with a COVERAGE summary, e.g.:
   "Claim coverage: 2 PRESENT, 1 ASSUMED, 1 PARTIAL, 1 ABSENT out of 5 elements."

Analyze the file against the patent claim:`;
}


// ============================================================================
// FUNCTION RESOLUTION
// ============================================================================

/**
 * Resolve a function specifier to exactly one match from the index.
 *
 * @param {CodeSearchIndex} index
 * @param {string} spec - "func_name" or "file@func_name"
 * @returns {{ filepath, name, start, end, source } | null}
 */
export function resolveFunction(index, spec) {
  let fileHint = null;
  let funcName = spec;

  if (spec.includes('@')) {
    const firstAt = spec.indexOf('@');
    fileHint = spec.slice(0, firstAt);
    funcName = spec.slice(firstAt + 1);
    if (!fileHint || !funcName) {
      console.log('Usage: FUNCTION or FILE@FUNCTION');
      console.log('Example: --analyze tls_connect');
      console.log('Example: --analyze demo/tls_handler.c@tls_connect');
      return null;
    }
  }

  const matches = index.findFunctionMatches(funcName, fileHint);

  if (matches.length === 0) {
    if (fileHint) {
      console.log(`Function '${funcName}' not found in files matching '${fileHint}'.`);
    } else {
      console.log(`Function '${funcName}' not found in index.`);
    }
    console.log('  Tip: Use --list-functions "PATTERN" --full-path to search');
    return null;
  }

  if (matches.length > 1) {
    console.log(`Multiple functions match '${funcName}' - narrow with FILE@FUNCTION:`);
    for (let i = 0; i < Math.min(matches.length, 15); i++) {
      const m = matches[i];
      const lines = m.end - m.start + 1;
      console.log(`  [${i + 1}] ${m.filepath}@${displayName(m.name, m.filepath)} (${lines} lines)`);
    }
    if (matches.length > 15) {
      console.log(`  ... and ${matches.length - 15} more`);
    }
    return null;
  }

  // Exactly one match - extract source
  const m = matches[0];
  const source = index.getFunctionSource(m.filepath, m.name);
  if (!source) {
    console.log(`Could not extract source for ${m.filepath}@${m.name}`);
    return null;
  }

  return {
    filepath: m.filepath,
    name: m.name,
    start: m.start,
    end: m.end,
    source,
  };
}


/**
 * Resolve a file specifier to exactly one file in the index.
 *
 * @param {CodeSearchIndex} index
 * @param {string} spec - filename or partial path
 * @returns {{ filepath, source, lines } | null}
 */
function resolveFile(index, spec) {
  // #238: exact full-path match / root anchor wins before partial matching.
  const exact = index.resolveExactFileTarget(spec);
  if (exact && !exact.anchored) {
    const lines = index.fileLines.get(exact.filepath);
    return { filepath: exact.filepath, source: lines.join('\n'), lines: lines.length };
  }
  if (exact && exact.anchored) {
    console.log(`File '${spec}' not found at the root path in index.`);
    return null;
  }

  const specLower = spec.toLowerCase().replace(/\\/g, '/');
  const allFiles = [...index.fileLines.keys()];

  // Exact match
  if (index.fileLines.has(spec)) {
    const lines = index.fileLines.get(spec);
    return { filepath: spec, source: lines.join('\n'), lines: lines.length };
  }

  // Partial match
  const matches = allFiles.filter(fp => {
    const fpNorm = fp.toLowerCase().replace(/\\/g, '/');
    return fpNorm.endsWith(specLower) || fpNorm.includes(specLower);
  });

  if (matches.length === 0) {
    console.log(`File '${spec}' not found in index.`);
    console.log('  Tip: Use --stats to see indexed files, or check the path.');
    return null;
  }

  if (matches.length > 1) {
    // Prefer exact suffix match
    const suffixMatches = matches.filter(fp =>
      fp.toLowerCase().replace(/\\/g, '/').endsWith(specLower)
    );
    if (suffixMatches.length === 1) {
      const lines = index.fileLines.get(suffixMatches[0]);
      return { filepath: suffixMatches[0], source: lines.join('\n'), lines: lines.length };
    }

    console.log(`Ambiguous file '${spec}' - matches ${matches.length} files:`);
    for (const fp of matches.slice(0, 10)) {
      const n = index.fileLines.get(fp).length;
      console.log(`  ${fp} (${n} lines)`);
    }
    if (matches.length > 10) console.log(`  ... and ${matches.length - 10} more`);
    console.log('  Use a more specific path.');
    return null;
  }

  const lines = index.fileLines.get(matches[0]);
  return { filepath: matches[0], source: lines.join('\n'), lines: lines.length };
}


// ============================================================================
// HELPERS
// ============================================================================

// Local (air-gapped) file analysis is bounded by the model's context window, not
// dollars, so it keeps a line cap. Claude analysis is bounded by a projected-COST
// guard instead (see below) — the old fixed Claude line cap (was 500) is gone.
const _FILE_MAX_LINES_LOCAL = 200;
// Cloud engines (Claude / OpenAI) have no fixed line cap for the file-level
// fallback — the model-aware projected-cost guard (_analyzeCostBlock) is the
// real protection. Infinity => always attempt; the cost guard gates spend.
// (Also resolves a dangling _FILE_MAX_LINES_CLAUDE reference left when the old
// Claude line cap was replaced by the cost guard — it was undefined, so the
// cloud file-fallback threw ReferenceError.)
const _FILE_MAX_LINES_CLOUD = Infinity;

// Projected-cost guard for paid (Claude) analysis. Decided with the user; goal:
// "don't surprise users with large costs." Chosen over a line cap because it is
// model-aware (Opus costs ~1.7x Sonnet for the same tokens), catches minified
// one-liners (chars, not lines), and is uniform across --analyze and
// --file-analyze. $0.50 default; CE_ANALYZE_COST_GUARD env overrides; --force
// bypasses. Alternatives (remove cap entirely / raise the line number / line-
// based --max-lines) were rejected as no-protection or arbitrary-and-model-blind.
const _ANALYZE_COST_GUARD_USD = 0.50;

// Returns a block descriptor when a cloud analysis (Claude or OpenAI) would
// exceed the guard, else null (always null for local — no API cost). Input
// tokens are estimated from prompt size (~3 chars/token for code, slightly
// conservative so it guards a touch early rather than late); output assumed
// ~800 tokens. Model-aware, so the OpenAI default (gpt-5.1) and --openai-model
// are priced at their own rates.
function _analyzeCostBlock(args, promptChars) {
  const p = selectedCloudProvider(args);
  if (!p || args.force) return null;
  const model = p.id === 'openai' ? (args.openai_model || process.env.CE_OPENAI_MODEL || p.defaultModel)
    : p.id === 'gemini' ? (args.gemini_model || p.defaultModel)
    : (args.claude_model || process.env.CLAIM_SEARCH_MODEL || p.defaultModel);
  const estIn = Math.ceil(promptChars / 3);
  const { usd } = estimateCost(model, { input_tokens: estIn, output_tokens: 800 });
  const envGuard = parseFloat(process.env.CE_ANALYZE_COST_GUARD);
  const guard = Number.isFinite(envGuard) ? envGuard : _ANALYZE_COST_GUARD_USD;
  return usd > guard ? { usd, estIn, guard, model } : null;
}

function _printCostBlock(b, kind) {
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  console.log(`\n${kind} would cost ~$${b.usd.toFixed(2)} (~${k(b.estIn)} input tokens, ${b.model}) —`);
  console.log(`  over the $${b.guard.toFixed(2)} analyze cost guard. Large inputs can run up real cost.`);
  console.log(`  Tip: --force to send anyway, --mask-all to shrink the prompt, or raise CE_ANALYZE_COST_GUARD.`);
}

function _printDisclaimer(isClaude) {
  if (isClaude) {
    console.log('  WARNING: AI analysis may contain errors. Verify claims against the source code.');
  } else {
    console.log('  WARNING: AI analysis may contain errors - local models are less accurate than');
    console.log('    cloud models. Treat as preliminary guidance and verify against source.');
  }
}

function _printExtractTip(filepath, funcName) {
  const fname = filepath.replace(/\\/g, '/').split('/').pop();
  console.log(`  Tip: --extract ${fname}@${funcName} to see the full function source`);
}


// Line numbers default ON for the prompt paths that ASK for them.
//
// buildClaimAnalyzePrompt (:907), buildMultisectAnalyzePrompt (:947) and
// buildContextAnalyzePrompt (:1075) all instruct the model to cite line numbers
// as evidence — unconditionally. But `--line-numbers` defaulted to false, so
// the source it was citing arrived unnumbered and the model invented plausible
// anchors. Observed on a live multisect run: two distinct if/else-if arms were
// both cited as "lines 48-51", and a function was cited at "38-43" where it
// appears elsewhere. The reasoning was sound; it fabricated only the anchor CE
// asked for and withheld.
//
// A fabricated line cite is worse than none in a claim chart — it looks
// verifiable. `startLine` is already threaded at every call site, so the numbers
// emitted are file-absolute and check directly against `--extract …@fn`.
//
// Deliberately NOT applied to plain --analyze or --file-analyze:
// buildAnalyzePrompt and buildFileAnalyzePrompt never ask for line numbers, so
// numbering there would be pure token cost on a context-tight local model.
// `--no-line-numbers` opts out; `--line-numbers` remains accepted (now a no-op
// on these paths) so existing invocations keep working.
export function wantsLineNumbers(args) {
  return args?.no_line_numbers !== true;
}

/**
 * Prepare source for LLM: optionally mask and add line numbers.
 *
 * @param {string} source - Raw source code
 * @param {string} filepath - For language detection
 * @param {object} opts - { maskAll, lineNumbers, startLine, funcName }
 * @returns {string} Prepared source
 */
function _prepareSource(source, filepath, opts = {}) {
  const language = detectLanguage(filepath);
  let prepared = source;

  if (opts.maskAll) {
    const masker = new SimpleMasker();
    if (opts.funcName) {
      // Full 3-layer masking: comments + strings + identifiers
      prepared = masker.maskFunctionSource(prepared, opts.funcName, language);
    } else {
      // Layer 1+2 only (no identifier context): comments + strings
      prepared = masker.mask(prepared, language);
    }
  }

  if (opts.lineNumbers) {
    prepared = addLineNumbers(prepared, opts.startLine || 1);
  }

  return prepared;
}


/**
 * Resolve claim text from various sources:
 *   1. Inline text or @filename
 *   2. --claim-text / --claim-file arg
 *
 * @param {object} args
 * @param {string} [claimArg] - The --claim-analyze argument value
 * @returns {string|null}
 */
/**
 * Read a claim file, dropping `#` comment lines.
 *
 * WHY. Files written by `--synonymize-out` carry a `#` provenance block, the
 * same convention `--targets-out` uses. Read raw, that block became CLAIM TEXT,
 * and it did two things (measured on a real run, 2026-08-16):
 *
 *  1. The skeleton went wrong. The file split to TWELVE elements, not eleven:
 *     row 1 was the provenance block, and row 2 was a TRUNCATED first limitation
 *     -- "for creating a protected exchange link...", with "A method" sheared
 *     off, because the splitter merged the header's last line into it. Every row
 *     was then offset against the chart it was being compared to.
 *
 *  2. The header leaked the experiment into the prompt. The model was shown
 *     "Synonymized claim -- HOF-b. Wording changed, requirement preserved",
 *     which engine produced it, and how much vocabulary was displaced. That is
 *     precisely the knowledge HOF-b exists to WITHHOLD: a model told it is
 *     reading a deliberate restatement of another document may reason back
 *     toward the original.
 *
 * The convention already existed one command over -- `parseElementsFile` strips
 * `#` for `--claim-chart --elements` -- and simply was not reached here. Same
 * shape as the rest of this batch.
 *
 * Exported because THREE other commands read claim files by their own
 * readFileSync and have the identical defect: `--claim-chart` (claim-chart.js),
 * `--claim-locate` (claim-locate.js) and `--claim-search` (claim.js). They are
 * deliberately NOT changed here -- out of the approved scope -- and this helper
 * exists so that fixing them is an import rather than three more copies.
 */
export function readClaimFile(fpath, { onComments } = {}) {
  const raw = readFileSync(fpath, 'utf-8');
  const lines = raw.split(/\r?\n/);
  const kept = lines.filter((l) => !/^\s*#/.test(l));
  const dropped = lines.length - kept.length;
  // A file with no comments is returned UNTOUCHED. Rejoining would silently
  // normalise CRLF to LF, which is a change to every claim file on a Windows
  // checkout for no reason -- and "this fix alters files it has no business
  // altering" is exactly the regression worth not shipping.
  if (!dropped) return raw.trim();
  // Never silent: discarding input without saying so is how the next version of
  // this bug hides.
  onComments?.(dropped, fpath);
  return kept.join('\n').trim();
}

function _readClaimFileReporting(fpath) {
  return readClaimFile(fpath, {
    onComments: (n, f) => process.stderr.write(
      `  Claim file ${f}: ignored ${n} '#' comment line(s) (provenance, not claim text).\n`),
  });
}

function _resolveClaimText(args, claimArg) {
  // Source 1: the --claim-analyze argument itself
  if (claimArg) {
    if (claimArg.startsWith('@')) {
      const fpath = claimArg.slice(1);
      try { return _readClaimFileReporting(fpath); }
      catch { console.log(`Claim file not found: ${fpath}`); return null; }
    }
    // If it looks like substantial text, use it directly
    if (claimArg.includes(' ') && claimArg.length > 30) {
      return claimArg.trim();
    }
  }

  // Source 2: --claim-text
  const claimText = args.claim_text || null;
  if (claimText) {
    if (claimText.startsWith('@')) {
      const fpath = claimText.slice(1);
      try { return _readClaimFileReporting(fpath); }
      catch { console.log(`Claim file not found: ${fpath}`); return null; }
    }
    return claimText.trim();
  }

  // Source 3: --claim-file (backward compatibility)
  const claimFile = args.claim_file || null;
  if (claimFile) {
    try { return _readClaimFileReporting(claimFile); }
    catch { console.log(`Claim file not found: ${claimFile}`); return null; }
  }

  console.log('--claim-analyze requires patent claim text.');
  console.log('  --claim-analyze @patent_claim.txt --llm claude');
  console.log('  --claim-analyze "A method comprising..." --llm claude');
  console.log('  --claim-analyze FUNCNAME --claim-text @patent_claim.txt --llm claude');
  return null;
}


// ============================================================================
// do_analyze - general "what does this code do?"
// ============================================================================

/**
 * Handle --analyze FUNCTION: extract function and run LLM analysis.
 */
export async function doAnalyze(index, args) {
  const match = resolveFunction(index, args.analyze);
  if (!match) return;

  const { filepath, name: funcName, start, end, source } = match;
  const linesCount = end - start + 1;
  const maskAll = args.mask_all || false;
  const showPrompt = args.show_prompt || false;
  let lineNumbers = args.line_numbers || false;

  // Resolve --with context text (supports @file.txt syntax)
  let contextText = null;
  if (args.analyze_context) {
    const raw = args.analyze_context;
    if (raw.startsWith('@')) {
      const fpath = raw.slice(1);
      try { contextText = readFileSync(fpath, 'utf-8').trim(); }
      catch { console.log(`Context file not found: ${fpath}`); return; }
    } else {
      contextText = raw.trim();
    }
  }

  // Only the --with (context) prompt asks the model to cite line numbers;
  // buildAnalyzePrompt does not. Number the source exactly when it will be used.
  if (contextText) lineNumbers = wantsLineNumbers(args);

  const sourceForLLM = _prepareSource(source, filepath, {
    maskAll, lineNumbers, startLine: start, funcName,
  });

  let prompt = contextText
    ? buildContextAnalyzePrompt(sourceForLLM, funcName, filepath, contextText, maskAll)
    : buildAnalyzePrompt(sourceForLLM, funcName, filepath, maskAll);

  // --with-digest: prepend the #329 digest as a "facts preamble" so the LLM
  // has static-analysis context (call graph, strings, breadcrumbs, etc.)
  // before it reads the source. Lets the user A/B whether CodeExam-provided
  // context improves local-LLM output quality.
  let digestText = null;
  if (args.with_digest && index.buildFunctionDigest) {
    // #251: pass the file-qualified spec — a bare funcName gives buildFunctionDigest
    // no path hint, so it digests matches[0], the WRONG same-named function when
    // the name exists in multiple files.
    const digestObj = index.buildFunctionDigest(`${filepath}@${funcName}`);
    if (digestObj) {
      // Import formatter lazily so analyze.js doesn't hard-depend on digest.js
      const { formatFunctionDigest } = await import('./digest.js');
      digestText = formatFunctionDigest(digestObj);
      prompt =
        `Below is a mechanical summary of the function you're about to\n` +
        `analyze, produced by a static-analysis tool (CodeExam). These are\n` +
        `FACTS extracted directly from the code — counts of callers and\n` +
        `callees, string literals in the body, trace markers emitted, etc.\n` +
        `Use this to orient yourself BEFORE reading the source. Where the\n` +
        `digest and the source disagree, trust the source.\n` +
        `\n` +
        `=== BEGIN STATIC-ANALYSIS DIGEST ===\n` +
        `${digestText}` +
        `=== END STATIC-ANALYSIS DIGEST ===\n` +
        `\n` +
        `${prompt}`;
    }
  }

  // Header
  console.log('='.repeat(70));
  console.log(`ANALYZE: ${filepath}@${displayName(funcName, filepath)}`);
  console.log(`  Lines ${start}-${end} (${linesCount} lines)`);
  if (contextText) console.log(`  Context: ${contextText.length} chars (--with)`);
  if (digestText) console.log(`  Digest prepended: ${digestText.length} chars (--with-digest)`);
  if (maskAll) console.log('  Masked: comments, strings, identifiers');
  console.log('='.repeat(70));

  if (showPrompt) {
    console.log();
    console.log('PROMPT TO LLM:');
    console.log('-'.repeat(70));
    console.log(prompt);
    console.log('-'.repeat(70));
    console.log('\n(--show-prompt: prompt displayed, no LLM call made)');
    _printExtractTip(filepath, funcName);
    return;
  }

  // Prompt-length summary to stderr so the user sees progress when stdout
  // is redirected to a file. Full prompt is gated behind --verbose since
  // users who want the actual prompt text can already get it via
  // --show-prompt. Previously we unconditionally spilled the entire prompt
  // to stderr, which was noisy when piping stdout > file.txt.
  if (args.verbose) {
    process.stderr.write(`\n--- Prompt sent to LLM (${prompt.length} chars) ---\n`);
    process.stderr.write(prompt + '\n');
    process.stderr.write('--- End prompt ---\n\n');
  } else {
    process.stderr.write(`\nSending prompt to LLM (${prompt.length} chars)...\n`);
  }

  const costBlock = _analyzeCostBlock(args, prompt.length);
  if (costBlock) {
    console.log('='.repeat(70));
    console.log(`ANALYZE: ${filepath}@${displayName(funcName, filepath)} (${linesCount} lines)`);
    _printCostBlock(costBlock, 'This analysis');
    return;
  }

  const llm = getAnalysisLLM(args);
  if (!llm.isAvailable()) {
    console.log();
    console.log(`Source code (${linesCount} lines):`);
    console.log(sourceForLLM);
    console.log();
    console.log('WARNING: No LLM available. Use --llm claude or --analyze-model <path>');
    console.log('  Source extracted successfully - LLM analysis requires an AI backend.');
    _printExtractTip(filepath, funcName);
    return;
  }

  console.log();
  const label = llm.useClaude ? '[AI] Claude Analysis:' : '[AI] AI Analysis:';
  console.log(label);
  const response = await llm.generate(prompt, 500);
  console.log(response);
  console.log('='.repeat(70));

  const usage = llm.getUsageSummary();
  if (usage) console.log(usage);
  _printDisclaimer(llm.isCloud());
  _printExtractTip(filepath, funcName);
}


// ============================================================================
// do_claim_analyze - end-to-end patent claim analysis
// ============================================================================

/**
 * Handle --claim-analyze CLAIM: extract terms, search, then analyze against claim.
 *
 * Pipeline:
 *   1. Read claim text (inline, @file, or --claim-text/--claim-file)
 *   2. Extract search terms from claim (LLM call via claim.js)
 *   3. Run multisect search with TIGHT terms
 *   4. Pick best 1-2 function matches
 *   5. Analyze each match against the original claim text (LLM call)
 */
// #307 helpers for the claim-analyze retrieval path. Exported for test.

/**
 * How many positive terms actually match at least one file. A term that matches
 * nothing cannot contribute to an intersection, so it must not count toward the
 * quorum — see the comment at the minTerms computation for the measurement.
 * Fails OPEN: if the index cannot answer, every term is treated as live, so a
 * missing capability can only restore the old behaviour, never tighten it.
 */
// #307 scope ladder: how many top-ranked FILES form the neighbourhood that
// function selection is re-run inside. Default 10 — the measured point, where
// the '101 target sits at file rank 9. 0 disables the ladder entirely.
//
// One measured point is not a tuned parameter: Gemma's terms put the same file
// at rank 101, so a corpus (or a model) whose right file ranks low is not
// rescued by 10, and widening trades precision for reach. `--neighbourhood 0`
// restores pre-ladder behaviour exactly.
export function claimNeighbourhoodN(args) {
  const raw = args && (args.neighbourhood ?? args.neighborhood);
  if (raw === undefined || raw === null || raw === '') return 10;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
}

// Default 6, overridable with --top-n. See the comment at the slice for why 6.
export function claimAnalyzeTopN(args) {
  const raw = args && (args.top_n ?? args.topN);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * The parsed-term shape, which is what every production caller passes:
 *
 *   { display: '/bitrate|bit.rate/', regex: RegExp, negated: false, hard: true }
 *
 * NO `term`, NO `pattern`, NO `isRegex`. The first cut of this function read
 * `t.term ?? t.pattern`, got undefined for every parsed term, and took the
 * empty-string branch that counts a term live without probing — so between
 * c169ca7 and this change the live-term quorum was INERT IN PRODUCTION for all
 * terms, not merely for regexes as asus-CC and I both believed.
 *
 * It looked verified because the check ran against an array of STRINGS I chose,
 * reproducing 5-of-9 on the real index, while the call site supplies objects.
 * Testing a helper with input other than what its caller passes is the whole
 * failure; `termProbeSource` exists so the shape is named in one place and the
 * tests can use the same parser production uses.
 */
export function termProbeSource(t) {
  if (typeof t === 'string') return { text: t, isRegex: false };
  if (!t) return null;
  const disp = String(t.display ?? t.term ?? t.pattern ?? '').trim();
  if (!disp) return null;
  const m = disp.match(/^\/(.*)\/$/);      // multisect's own regex form
  if (m) return { text: m[1], isRegex: true };
  return { text: disp, isRegex: false };
}

export function livePositiveTerms(index, positiveTerms) {
  const terms = positiveTerms || [];
  if (!terms.length) return 0;
  if (typeof index?.multisectTermFileCount !== 'function'
    && typeof index?.searchLiteral !== 'function') return terms.length;
  let live = 0;
  for (const t of terms) {
    const src = termProbeSource(t);
    if (!src) { live++; continue; }        // unreadable -> fail open
    let hits = 0;
    try {
      if (typeof index.multisectTermFileCount === 'function') {
        hits = index.multisectTermFileCount(t) || 0;
      } else {
        // #307: `maxResults`, not `max` — the option name matters. asus-CC's
        // rarity probe reported "100 files" for 18 of 20 terms because `max` is
        // silently ignored and the default is 100; the same wrong name was here.
        // A liveness question needs exactly one hit.
        //
        // useRegex is the entry point CodeSearchIndex already exposes
        // (mcp-server.js:511) — a regex term probed literally finds nothing,
        // which is not the same as the term being dead.
        hits = (index.searchLiteral(src.text, { maxResults: 1, useRegex: src.isRegex }) || []).length;
      }
    } catch { hits = 1; }   // fail open: an index error is not a dead term
                            // (an UNPARSEABLE regex never arrives — parseMultisectTerms
                            //  rejects the whole set and returns null)
    if (hits > 0) live++;
  }
  return live || terms.length;   // never return 0: a 0 quorum matches everything
}

/**
 * Union two multisect results, keeping A's ordering ahead of B's and tagging each
 * function match with the search that found it. A appears first on ties because
 * TIGHT is the narrower, higher-confidence read.
 */
export function mergeSearchResults(tight, broad) {
  if (!tight) return broad;
  if (!broad) return tight;
  const seen = new Set();
  const out = [];
  for (const m of (tight.function_matches || [])) { seen.add(matchKey(m)); out.push({ ...m, _via: 'tight' }); }
  for (const m of (broad.function_matches || [])) { if (!seen.has(matchKey(m))) { seen.add(matchKey(m)); out.push({ ...m, _via: 'broad' }); } }
  return { ...tight, function_matches: out, _broad_merged: true };
}

// ---------------------------------------------------------------------------
// PER-ELEMENT ARM — the third search, beside TIGHT and BROAD.
//
// WHY. Whole-claim retrieval applies a QUORUM over the claim's whole vocabulary,
// so a function implementing ONE limitation holds roughly 1/N of the terms and
// cannot clear it. MEASURED on .demo x sample_patent_claim.txt (2026-08-11):
// `SecureChannel::sendMessage` matches 2 of 12 TIGHT terms against a quorum of 6.
// Adding the one term it is missing takes it to 3. NO TERM-SET FIX REACHES IT —
// the exclusion is arithmetic, not vocabulary. Both cloud engines therefore
// returned element (e) ABSENT on a corpus that plainly implements it, and an
// ABSENT that is true of the function analyzed and false of the codebase is the
// worst thing a client deliverable can contain.
//
// Per-element retrieval searches SYMBOL NAMES with NO QUORUM, top-N per element,
// which is precisely the blind spot whole-claim search cannot cover.
//
// OVERLAP WITH --claim-chart, ACKNOWLEDGED (Andrew, 2026-08-16). `--claim-chart`
// already does per-element retrieval (e17e40d) AND pulls depth-1 callee bodies,
// which `--claim-analyze` does not. So the two commands now overlap
// substantially, and --claim-chart is the stronger of the two: it synthesises
// one verdict per limitation across all targets (mergeBestPerElement), where
// --claim-analyze emits N independent per-function analyses and leaves the union
// to the reader.
//
// This arm is still worth having -- it removes a confident-but-wrong ABSENT from
// a command people run -- but the claim-command family wants consolidating, and
// this file should be read as a candidate for absorption rather than as a second
// path to maintain indefinitely.
//
// MERGED, NOT SUBSTITUTED. The two have opposite blind spots: body-text search
// finds a limitation implemented in `doWork()`, which name search cannot; name
// search finds a well-named single-purpose function, which the quorum excludes.
// Replacing one with the other trades one blind spot for another — the same
// mistake #307 fixed for BROAD, where an all-or-nothing fallback made two
// complements into alternatives.
// ---------------------------------------------------------------------------

/**
 * The identity of a function match, shared by all three arms. Extracted from
 * mergeSearchResults rather than written twice: two definitions of "same
 * function" drift, and the failure mode is silent — one function analyzed twice
 * at double cost, or a per-element hit suppressed because its key was shaped
 * differently from the whole-claim key it duplicates.
 */
export function matchKey(m) {
  return `${m.filepath || m.file || ''}@${m.function || m.name || ''}`;
}

// Ceiling on per-element additions regardless of element count. A 40-element
// claim (splitClaimElements' own maxElements) must not silently schedule 40
// analysis calls; claim-chart's maxRetrievedTargets is 12, and this is the same
// budget for the same reason.
//
// KNOWN LIMIT, stated rather than hidden: on a claim that splits past 12,
// elements after the twelfth get no candidate and can still be reported ABSENT
// for want of retrieval. The cap trades that tail for cost. `--per-element-n`
// raises it deliberately; nothing raises it silently.
export const PER_ELEMENT_MAX = 12;

/**
 * How many per-element candidates to schedule. Default is ONE PER ELEMENT
 * (capped), because the defect being fixed is per-element: an element with no
 * implementer in the analyzed set is reported ABSENT, so coverage is counted in
 * elements, not in functions.
 *
 * ONE PER ELEMENT IS A REQUIREMENT, NOT A GENEROUS DEFAULT. Measured against the
 * real .demo index: CE splits sample_patent_claim.txt into ELEVEN elements and
 * the transmitting limitation (e) is the TENTH. Round-robin reaches element 10
 * only on the tenth slot, so any budget below 10 covers elements 1-9 and misses
 * exactly the one whose ABSENT verdict prompted this work. A default of 6 —
 * matching top-N, which would have looked tidy — fails the acceptance test.
 *
 * `--per-element-n 0` disables the arm exactly as `--no-per-element` does; both
 * exist because one is a switch and the other is a budget.
 */
export function perElementBudget(args, nElements) {
  const raw = args && (args.per_element_n ?? args.perElementN);
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return Math.min(Math.max(0, nElements | 0), PER_ELEMENT_MAX);
}

function symbolLineCount(sym) {
  const a = Number(sym && sym.start), b = Number(sym && sym.end);
  return (Number.isFinite(a) && Number.isFinite(b) && b >= a) ? (b - a + 1) : 0;
}

/**
 * Convert --claim-locate's per-element hits into the function-match shape this
 * pipeline already consumes.
 *
 * Selection is ROUND-ROBIN BY RANK — rank 0 of every element before rank 1 of
 * any. That ordering IS the mechanism, not a preference: a budget spent
 * depth-first on the strongest element reproduces exactly the failure this arm
 * exists to fix, because the elements that go uncovered are the ones reported
 * ABSENT. Breadth-first spends the first N slots on N DISTINCT elements.
 *
 * `skip` carries the whole-claim matches already scheduled, so a function both
 * arms found is analyzed ONCE and attributed to the whole-claim arm — which
 * ranked it on term evidence, where this arm ranked it on its name.
 */
export function perElementMatches(perElement, opts = {}) {
  const passes = Math.max(1, opts.ranksPerElement ?? 1);
  const total = Math.max(0, opts.max ?? PER_ELEMENT_MAX);
  const list = perElement || [];
  const seen = new Set(opts.skip || []);
  const out = [];
  // Per-element cursor, NOT a shared rank index. Neighbouring limitations
  // predict overlapping vocabulary — .demo's elements 10 and 11 are both about
  // transmitting over an encrypted channel — so their candidate lists start
  // with the same symbol. Indexing every element at the same rank meant the
  // first element took it and the second was deduped out of its own slot,
  // leaving it uncovered while its second-choice candidate sat unused. Each
  // element instead advances to its best candidate NOT ALREADY TAKEN, which
  // keeps the sweep breadth-first while making coverage robust to overlap.
  const cursor = new Map();
  for (let pass = 0; pass < passes && out.length < total; pass++) {
    for (let ei = 0; ei < list.length; ei++) {
      if (out.length >= total) break;
      const p = list[ei];
      const hits = p.hits || [];
      let i = cursor.get(ei) ?? 0;
      let chosen = null;
      while (i < hits.length) {
        const h = hits[i];
        i++;
        if (!h || !h.sym) continue;
        const m = {
          filepath: h.sym.filepath,
          function: h.sym.name,
          lines: symbolLineCount(h.sym),
          // NO terms_matched. Per-element retrieval has no quorum and counts no
          // terms; inventing a number here would put a fabricated [n/N] beside
          // a real one in the same list. The display branches on `_via` instead.
          terms_matched: null,
          _via: 'per-element',
          _element: p.element,
          _element_words: h.matched || [],
        };
        const k = matchKey(m);
        if (seen.has(k)) continue;
        seen.add(k);
        chosen = m;
        break;
      }
      cursor.set(ei, i);
      if (chosen) out.push(chosen);
    }
  }
  return out;
}

/**
 * The engine for the per-element vocabulary call.
 *
 * It follows claim-analyze's TERM-EXTRACTION choice, NOT resolveModel's own
 * precedence. `--llm claude --analyze-model x.gguf` extracts terms on Claude and
 * analyzes locally; resolveModel prefers the GGUF and would silently move this
 * step to the other engine. Predicting code vocabulary from claim text is a
 * term-extraction task, so it rides the term-extraction engine — and the
 * air-gap claim depends on that being stated rather than assumed.
 *
 * Returns null when nothing is resolvable, and the caller then skips the arm:
 * failing to resolve an engine must degrade to today's behaviour, never abort a
 * run whose whole-claim half is still valid.
 */
export function perElementModel(args, termModelPath) {
  if (termModelPath) {
    return ggufDescriptor({
      modelPath: termModelPath, forceCpu: args.cpu, contextSize: args.context_size,
      flashAttention: args.flash_attention, liveTodayDate: args.live_today_date,
    });
  }
  // `llm || 'claude'` mirrors doClaimAnalyze's own default for term extraction
  // (`provider: cloudProvider ? cloudProvider.id : 'claude'`), so a bare
  // --claim-analyze uses one engine for both steps rather than two.
  const m = resolveModel({
    ...args, model: null, claim_model: null, analyze_model: null, llm: args.llm || 'claude',
  });
  return (m && m.kind !== 'error') ? m : null;
}

export async function doClaimAnalyze(index, args) {
  // --- Step 1: Resolve claim text ---
  const claimText = _resolveClaimText(args, args.claim_analyze);
  if (!claimText) return;

  // #290: direct-target mode. "--claim-analyze FUNCNAME --claim-text @f" was
  // advertised in the usage text but FUNCNAME was silently ignored (the arg
  // is only ever a claim-text SOURCE above). A short, non-prose argument now
  // targets that function directly — element-map the claim against it,
  // skipping term extraction and retrieval. This is also the building block
  // the --claims-loop harness exercises per group anchor.
  const caArg = args.claim_analyze;
  const isDirectTarget = caArg && !caArg.startsWith('@')
    && !(caArg.includes(' ') && caArg.length > 30) && caArg !== claimText;
  if (isDirectTarget) {
    const match = resolveFunction(index, caArg);
    if (!match) return; // resolveFunction printed the reason — no silent retrieval fallback
    console.log(`Direct-target claim analysis: ${match.filepath}@${match.name}`);
    console.log();
    await _doClaimSingleAnalyze(
      { filepath: match.filepath, funcName: match.name, source: match.source, start: match.start, end: match.end, lines: match.end - match.start + 1 },
      claimText, args, args.mask_all || false, args.show_prompt || false, wantsLineNumbers(args),
    );
    return;
  }

  const showPrompt = args.show_prompt || false;
  const maskAll = args.mask_all || false;
  const lineNumbers = wantsLineNumbers(args);
  const cloudProvider = selectedCloudProvider(args);  // #246: registry entry or null

  // Echo claim text
  console.log(`Claim text (${claimText.length} chars):`);
  for (const line of claimText.trim().split('\n')) {
    const trimmed = line.trim();
    if (trimmed) console.log(`  ${trimmed}`);
  }
  console.log();

  // Show LLM configuration
  // #293: --model routes to both slots — same precedence as llm-runner's
  // resolveModel (model > claim_model > analyze_model).
  const analyzeModel = args.model || args.analyze_model || null;
  const claimModel = args.model || args.claim_model || null;

  // Term extraction: --model > --claim-model > --analyze-model > cloud API.
  // (If user only specifies --analyze-model, use it for both tasks.)
  // A cloud engine does term extraction on that provider, so it does not fall
  // back to a local --analyze-model for terms.
  const cloudApiLabel = cloudProvider ? cloudProvider.label : 'Claude API';
  const termModelPath = claimModel || (!cloudProvider ? analyzeModel : null);
  const termExtractionEngine = termModelPath
    ? `local: ${termModelPath}`
    : cloudApiLabel;
  const analysisEngine = cloudProvider
    ? cloudApiLabel
    : (analyzeModel ? `local: ${analyzeModel}` : '(none - will extract source only)');
  console.log(`  Term extraction: ${termExtractionEngine}`);
  console.log(`  Code analysis:   ${analysisEngine}`);
  console.log();

  // --- Step 2: Extract search terms from claim ---
  // Note: term extraction is intentionally decoupled from analysis LLM.
  // It uses claim.js's extractClaimTerms (Claude API) and may in future
  // be replaced with embeddings, a small language model, or keyword extraction.
  console.log('[Step 1/4] Extracting search terms from claim via ' + termExtractionEngine + '...');

  const apiKey = args.api_key || null;
  const localModelPath = termModelPath;  // resolved above: claim_model > analyze_model > null
  const temperature = args.temperature ?? 0.0;
  const verbose = args.verbose || false;
  const vocabTight = args.vocab_tight || false;
  const noVocabulary = args.no_vocabulary || false;

  // Fetch vocabulary concordance from index.
  //
  // #301: SECOND of three sites that build this — claim.js:1330 is the
  // --claim-search path, this is --claim-analyze, and claims-loop.js:443 is the
  // third. The first cut of the bridge patched only claim.js, so
  // `--concept-bridge` on --claim-analyze silently did nothing and the run still
  // printed `claim-filtered`. Fourth instance today of one shape: the flag was
  // accepted at one site and dropped at the one that mattered.
  let vocabConcordance = '';
  if (!noVocabulary) {
    const claimKeywords = extractClaimKeywords(claimText);
    try {
      const format = localModelPath ? 'compact' : 'rich';
      const _vc = vocabConcordanceOptions({ args, localModelPath, claimKeywords });
      vocabConcordance = index.formatVocabularyForPrompt(format, _vc.options);
      if (vocabConcordance) {
        process.stderr.write(`  Vocabulary concordance: ${vocabConcordance.length} chars (${format} format, `
          + `${_vc.unfiltered ? 'UNFILTERED - #301' : 'claim-filtered'})\n`);
      } else {
        process.stderr.write(`  Vocabulary: no claim-relevant terms found in index\n`);
      }
    } catch (e) {
      if (verbose) {
        process.stderr.write(`  Note: vocabulary not available: ${e.message}\n`);
      }
    }
  } else {
    process.stderr.write(`  Vocabulary: disabled (--no-vocabulary)\n`);
  }

  let result;
  // Hoisted out of the branch below: the per-element arm reuses this already
  // loaded model rather than loading a second copy of the same GGUF (12 GB on
  // the measured card, and a second load can simply fail to allocate).
  let termLlm = null;
  if (localModelPath) {
    // Local model for term extraction.
    // Reuse the analysis LLM singleton ONLY when it is the SAME local model
    // already loaded (avoids a second load). #247: if the analysis backend is
    // cloud, getAnalysisLLM returns a cloud client whose generate() would send
    // this claim text off-machine — local term extraction must never route
    // through it. Falling back to a fresh local AnalysisLLM keeps local intent
    // local (worst case the model loads twice, which is correctness-safe).
    const _shared = (localModelPath === analyzeModel) ? getAnalysisLLM(args) : null;
    if (_shared && _shared.modelPath === localModelPath) {
      termLlm = _shared;
    } else {
      termLlm = new AnalysisLLM({
        modelPath: localModelPath, temperature,
        forceCpu: !!args.cpu, contextSize: args.context_size || null,
        flashAttention: !!args.flash_attention, liveTodayDate: !!args.live_today_date,
      });
    }
    await termLlm.ensureLocalModel();
    if (!termLlm._llm) {
      console.log('Error: Could not load local model for term extraction.');
      console.log(`  Path: ${localModelPath}`);
      return;
    }

    // Combine system prompt + claim text (shorter prompt for local models)
    const basePrompt = vocabConcordance
      ? buildLocalExtractionPromptWithVocab(vocabConcordance, vocabTight)
      : CLAIM_EXTRACTION_PROMPT_LOCAL;
    const combinedPrompt = basePrompt + '\n\n' +
      'Extract search terms from this patent claim:\n\n' +
      claimText.trim();

    process.stderr.write('  Sending to local model for term extraction...\n');
    const rawResponse = await termLlm.generate(combinedPrompt, 2048);
    process.stderr.write('  LLM response:\n');
    for (const line of rawResponse.split('\n')) {
      process.stderr.write(`    ${line}\n`);
    }
    result = parseTermResponse(rawResponse);
  } else {
    result = await extractClaimTerms(claimText, {
      apiKey, verbose, temperature, vocabConcordance, vocabTight,
      claudeModel: args.claude_model,
      // #246: route term extraction through the selected cloud provider.
      provider: cloudProvider ? cloudProvider.id : 'claude',
      openaiKey: args.openai_key || null,
      openaiModel: args.openai_model || null,
      geminiKey: args.gemini_key || null,
      geminiModel: args.gemini_model || null,
    });
  }

  if (result.error) {
    console.log(`Error: ${result.error}`);
    return;
  }

  let tightStr = result.tight;
  let broadStr = result.broad;

  // Sanitize (drop stop-listed terms before the term cap in sanitizeLlmTerms)
  if (tightStr) tightStr = dropStopListedTerms(tightStr, 'TIGHT');
  if (broadStr) broadStr = dropStopListedTerms(broadStr, 'BROAD');
  if (tightStr) tightStr = sanitizeLlmTerms(tightStr, 'TIGHT');
  if (broadStr) broadStr = sanitizeLlmTerms(broadStr, 'BROAD');
  if (broadStr) broadStr = sanitizeBroadTerms(broadStr);

  if (!tightStr) {
    console.log('No search terms could be extracted from the claim.');
    return;
  }

  console.log(`  TIGHT terms: ${tightStr}`);
  if (broadStr) console.log(`  BROAD terms: ${broadStr}`);
  console.log();

  // --- Step 3: Run multisect search ---
  let terms = parseMultisectTerms(tightStr);
  if (!terms) {
    console.log('Failed to parse extracted terms.');
    return;
  }

  let positiveTerms = terms.filter(t => !t.negated);
  if (positiveTerms.length < 2) {
    console.log('Too few positive terms extracted. Cannot search.');
    return;
  }

  // Min terms: user override, else 80% of the terms that can actually MATCH.
  //
  // #307: the quorum was computed over ALL positive terms, including ones that
  // match zero files. Measured on Gemma's extraction for US 8,752,101 against
  // .AndroidX_Media_ExoPlayer3: 9 terms, quorum floor(9 × 0.80) = 7, and FOUR of
  // the nine (`content data`, `code rate`, `plurality`, `storage device`) hit no
  // file at all. Five live terms against a quorum of seven — the search could not
  // succeed before it started. Sweep on the same terms: 7→0, 5→0, 4→0, 3→2.
  //
  // A dead term cannot contribute to an intersection, so counting it in the
  // quorum is arithmetic, not strictness. CE already printed "Some terms had zero
  // hits" and then did nothing with it; now the number acts on it.
  const liveTerms = livePositiveTerms(index, positiveTerms);
  const deadCount = positiveTerms.length - liveTerms;
  let minTerms;
  const userMin = args.min_terms;
  if (userMin && userMin !== '0') {
    minTerms = parseInt(userMin, 10);
    if (isNaN(minTerms)) minTerms = Math.max(Math.floor(liveTerms * 0.80), 2);
  } else {
    minTerms = Math.max(Math.floor(liveTerms * 0.80), 2);
  }
  if (deadCount) {
    console.log(`  ${deadCount} of ${positiveTerms.length} term(s) match no file; `
      + `quorum computed over the ${liveTerms} live term(s).`);
  }

  console.log(`[Step 2/4] Multisect search (min_terms=${minTerms}/${positiveTerms.length})...`);

  let results = index.multisectSearch(terms, {
    minTerms,
    includePath: args.include_path || null,
    excludePath: args.exclude_path || null,
  });

  // BROAD: MERGED, not a fallback.
  //
  // #307: this used to run only when TIGHT returned ZERO function matches. On
  // Andrew's Claude run for US 8,752,101, TIGHT found plenty — so BROAD never
  // executed, and the target (`AdaptiveTrackSelection`) sat at BROAD function
  // ranks 2-3, never a candidate at any threshold. An all-or-nothing fallback
  // makes the two searches alternatives when they are complements: TIGHT is
  // literal source language, BROAD is implementation-aware, and a claim element
  // can be present under either vocabulary.
  //
  // Merged with provenance so a chart can say which search surfaced a cite, and
  // TIGHT keeps precedence on ties — it is the narrower, higher-confidence read.
  const tightFuncCount = (results && (results.function_matches || []).length) || 0;
  if (broadStr) {
    const broadTerms = parseMultisectTerms(broadStr);
    if (broadTerms) {
      const broadPositive = broadTerms.filter(t => !t.negated);
      const broadLive = livePositiveTerms(index, broadPositive);
      const broadMin = Math.max(Math.floor(broadLive * 0.60), 3);
      const broadResults = index.multisectSearch(broadTerms, {
        minTerms: broadMin,
        includePath: args.include_path || null,
        excludePath: args.exclude_path || null,
      });
      if (!tightFuncCount) {
        // Nothing from TIGHT — BROAD becomes the result outright, as before.
        console.log('  TIGHT search found no function matches. Using BROAD...');
        if (broadResults) { results = broadResults; terms = broadTerms; positiveTerms = broadPositive; }
      } else if (broadResults && (broadResults.function_matches || []).length) {
        results = mergeSearchResults(results, broadResults);
        const added = (results.function_matches || []).length - tightFuncCount;
        console.log(`  BROAD search merged: +${added} function match(es) TIGHT did not reach`
          + ` (${tightFuncCount} tight, min_terms=${broadMin}/${broadLive}).`);
      }
    }
  }

  if (!results) {
    console.log('No matches found for the extracted terms.');
    console.log('  Try --claim-search to see the full search results,');
    console.log('  then --analyze on a specific function.');
    return;
  }

  // --- Step 4: Pick best function matches ---
  // Filter out (global) scope entries - they aren't extractable functions.
  // Also filter 0-line entries which can't be sent to LLM.
  const allFuncMatches = (results.function_matches || []);
  let funcMatches = allFuncMatches.filter(
    fm => fm.function !== '(global)' && fm.lines > 0
  );
  const fileMatches = results.file_matches || [];
  const folderMatches = results.folder_matches || [];

  // #307 SCOPE LADDER. multisect computes four rungs — function, class, file,
  // folder — and this consumer read only the bottom one. Andrew's own
  // pseudo-claim for multisect describes the ladder ("a widening scope of
  // locations … ranked by criteria such as smaller location first"); it is
  // implemented in the search and was discarded here.
  //
  // MEASURED, US 8,752,101 x .AndroidX_Media_ExoPlayer3, Claude's BROAD terms:
  //
  //   AdaptiveTrackSelection.java                  file rank 9 of 103
  //   AdaptiveTrackSelection::updateSelectedTrack  function rank ABSENT (6/13 vs quorum 7)
  //
  // The file scores well because the claim's terms are SPREAD ACROSS IT; no
  // single function concentrates enough to clear a global quorum. So the
  // file-level signal knows something the function ranking throws away.
  //
  // Restricting function ranking to the top-N files put the target at rank 4 —
  // the first retrieval of Andrew's acceptance symbol on any provider.
  //
  // FOLDERS DO NOT WORK as the neighbourhood: `folder_matches` scores every
  // ancestor prefix, so `libraries` (2,248 files) and the repo root both score
  // 13/13, and `trackselection` lands at rank 113 of 345. Files are the workable
  // rung. Suppression is NOT a factor — `filteredFiles` lives in
  // commands/multisect.js (display); core/multisect.js returns the complete set.
  // RE-SEARCHES the neighbourhood; does NOT filter the existing results. That
  // distinction is the whole mechanism: at the global quorum the target is
  // ABSENT from function_matches, so filtering could never surface it. The
  // neighbourhood is re-searched at a LOWER quorum, which is only safe because
  // the field has been narrowed first — at min=6 unrestricted, the '101 set goes
  // from 38 to 107 function matches and the target sits at rank 50.
  const ladderN = claimNeighbourhoodN(args);
  if (ladderN > 0 && fileMatches.length > 1) {
    const hood = fileMatches.slice(0, ladderN).map((f) => f.filepath);
    // Live-term arithmetic (c169ca7) applied at stage 2: the quorum drops by one
    // rung inside the neighbourhood. The target matches 6 of 13 against a global
    // quorum of 7 — the same one-term margin seen everywhere in this
    // investigation — so without this the ladder finds nothing new.
    const hoodMin = Math.max(2, Math.floor(livePositiveTerms(index, positiveTerms) * 0.60) - 1);
    let hoodResults = null;
    try {
      hoodResults = index.multisectSearch(terms, {
        minTerms: hoodMin, includePath: hood, excludePath: args.exclude_path || null,
      });
    } catch (e) { console.log(`  [#307 ladder] neighbourhood search failed: ${e.message}`); }
    const hoodFuncs = ((hoodResults && hoodResults.function_matches) || [])
      .filter((fm) => fm.function !== '(global)' && fm.lines > 0);
    // Fall back rather than narrow to nothing: a corpus whose files do not
    // concentrate terms must be no worse off than before this existed.
    if (hoodFuncs.length) {
      console.log(`  [#307 ladder] top ${ladderN} file(s) by term coverage, re-ranked at min_terms=${hoodMin}: `
        + `${funcMatches.length} -> ${hoodFuncs.length} function(s)`);
      funcMatches = hoodFuncs;
    } else if (funcMatches.length) {
      console.log(`  [#307 ladder] neighbourhood yielded no functions - keeping the unrestricted set`);
    }
  }

  // Show search result summary
  console.log(`[Step 3/4] Selecting best matches...`);
  console.log(`  Search found: ${allFuncMatches.length} function(s), ${fileMatches.length} file(s), ${folderMatches.length} folder(s)`);
  if (allFuncMatches.length !== funcMatches.length) {
    console.log(`  (filtered ${allFuncMatches.length - funcMatches.length} non-extractable entries)`)
  }

  // Top 2 function matches
  // #307: was a hardcoded 2, and it was the binding constraint once scope is
  // right. Measured on US 8,752,101 x .AndroidX_Media_ExoPlayer3, scoped: ranks
  // 1-4 are AdaptiveTrackSelectionTest methods, 5 is evaluateQueueSize and 6 is
  // AdaptiveTrackSelection::updateSelectedTrack -- the acceptance symbol. The
  // first symbol OUTSIDE that class is rank 12, so 6 is a clean cut, not a taste
  // call. At 2, a [10/13] vs [9/13] term-count difference -- inside the noise of
  // the heuristic -- decided the whole chart.
  const topMatches = funcMatches.slice(0, claimAnalyzeTopN(args));
  const nPos = positiveTerms.length;

  // --- Per-element arm: appended to the whole-claim selection, never replacing
  // it. See the block comment above perElementMatches for the measurement.
  //
  // RUNS BEFORE the no-matches bail-out below, deliberately. Keying that bail
  // on the whole-claim result alone would skip this arm on the one path where
  // it helps most — a claim whose vocabulary reaches no function at all — and
  // CE would report "no matches found" while the retrieval that would have
  // found them sat unreached. That is the exact shape of every defect in this
  // batch, and it is not going to be introduced by the fix for it.
  const perElementAdded = await _addPerElementMatches({
    index, args, claimText, topMatches, termLlm, termModelPath,
  });

  if (topMatches.length === 0) {
    // File-level fallback: BOTH arms came back empty.
    if (fileMatches.length > 0) {
      const topFile = fileMatches[0];
      const maxLines = cloudProvider ? _FILE_MAX_LINES_CLOUD : _FILE_MAX_LINES_LOCAL;
      if (topFile.lines <= maxLines) {
        console.log(`\n  No function-level match, but file '${topFile.filepath}' (${topFile.lines} lines) matches.`);
        console.log('  Analyzing whole file against claim...');
        await _doClaimFileAnalyze(index, args, topFile.filepath, claimText, maskAll, showPrompt, lineNumbers);
        return;
      }
      console.log(`\n  No function match. Best file match is '${topFile.filepath}' (${topFile.lines} lines) - too large for analysis.`);
      console.log('  Try --claim-search to see full results.');
      return;
    }
    console.log('  No function or file matches found.');
    return;
  }

  console.log(`\n  Found ${funcMatches.length} function match(es), analyzing top ${topMatches.length - perElementAdded.length}`
    + `${perElementAdded.length ? ` + ${perElementAdded.length} per-element` : ''}:`);
  for (let i = 0; i < topMatches.length; i++) {
    const fm = topMatches[i];
    // Per-element hits carry no term count — see perElementMatches. Labelling
    // them with the element they were retrieved FOR is the useful provenance
    // anyway: it says which limitation this function is here to answer.
    const tag = fm._via === 'per-element'
      ? `[element ${fm._element}]`
      : `[${fm.terms_matched}/${nPos} terms]`;
    console.log(`  [${i + 1}] ${tag} ${fm.filepath}@${fm.function} (${fm.lines || '?'} lines)`);
  }

  // --- Step 5: Extract and analyze each match ---
  const extracted = [];
  for (const fm of topMatches) {
    const source = index.getFunctionSource(fm.filepath, fm.function);
    if (source) {
      const funcInfo = _getFuncLineRange(index, fm.filepath, fm.function);
      extracted.push({
        filepath: fm.filepath,
        funcName: fm.function,
        source,
        start: funcInfo.start,
        end: funcInfo.end,
        termsMatched: fm.terms_matched,
        // A per-element hit takes its line count from the symbol table, which
        // can be absent; fall back to the resolved range rather than printing
        // "(0 lines)" for a function that plainly has some.
        lines: fm.lines > 0 ? fm.lines : (Math.max(0, (funcInfo.end - funcInfo.start) + 1) || null),
        via: fm._via || 'tight',
        element: fm._element ?? null,
        elementWords: fm._element_words || null,
      });
    }
  }

  if (extracted.length === 0) {
    console.log('Could not extract source for any matching functions.');
    return;
  }

  console.log(`\n[Step 4/4] Analyzing ${extracted.length} function(s) against claim via ${analysisEngine}...`);

  for (let i = 0; i < extracted.length; i++) {
    if (i > 0) console.log();
    await _doClaimSingleAnalyze(extracted[i], claimText, args, maskAll, showPrompt, lineNumbers);
  }
}


/**
 * Run the per-element arm and APPEND its additions to `topMatches` IN PLACE,
 * returning what was added (empty array when the arm did not run).
 *
 * Every failure path here is deliberately non-fatal. The whole-claim half of the
 * run is already valid by the time this is called, so a missing engine, a
 * missing key, an unparseable vocabulary response or a cost-guard refusal must
 * degrade to exactly today's output — never abort a run that would otherwise
 * have produced results.
 *
 * Outcomes go to STDOUT (like the BROAD merge line) so a redirected run records
 * whether this arm contributed; per-element progress goes to stderr.
 */
async function _addPerElementMatches({ index, args, claimText, topMatches, termLlm, termModelPath }) {
  if (args.no_per_element) {
    console.log('  Per-element arm: disabled (--no-per-element).');
    return [];
  }
  const elements = splitClaimElements(claimText);
  if (!elements.length) return [];

  const budget = perElementBudget(args, elements.length);
  if (budget <= 0) {
    console.log('  Per-element arm: disabled (--per-element-n 0).');
    return [];
  }

  const model = perElementModel(args, termModelPath);
  if (!model) {
    console.log('  Per-element arm: no engine resolvable for the vocabulary call — skipped.');
    return [];
  }
  // ONE extra model call: the vocabulary step, ~600 output tokens on a
  // claim-sized prompt. Gated before spending, and a refusal skips the arm
  // rather than the run.
  if (!claimsCostGate(model, [{ inChars: claimText.length + 2000, outTokens: 600 }],
    'claim-analyze per-element retrieval (1 call)', args)) {
    console.log('  Per-element arm: skipped by the cost guard; whole-claim results stand.');
    return [];
  }

  let draft;
  try {
    draft = (termLlm && termLlm._llm)
      // Reuse the already-loaded local model. makeGgufDrafter prompts with
      // exactly `${sys}\n\n${user}`, so this is prompt-identical to
      // --claim-chart's local path: the two commands must not diverge on the
      // step whose output the whole air-gapped argument rests on.
      ? ((sys, user, maxTokens) => termLlm.generate(`${sys}\n\n${user}`, maxTokens))
      : makeDrafter(model, args.temperature ?? 0);
  } catch (e) {
    console.log(`  Per-element arm: ${e.message} — skipped.`);
    return [];
  }

  const symbols = buildSymbolTable(index);
  if (!symbols.length) {
    console.log('  Per-element arm: index exposes no symbol table — skipped.');
    return [];
  }

  process.stderr.write(`  Per-element retrieval: ${elements.length} element(s), budget ${budget}`
    + ' (the model is shown the CLAIM ONLY — no paths, no codebase identity)...\n');
  let disc;
  try {
    disc = await retrievePerElement({
      draft, elements, symbols,
      opts: {
        includeTests: !!args.include_tests,
        onElement: ({ element, words, hits }) => process.stderr.write(
          `    element ${element}: words [${words.join(', ')}] -> ${hits.length} candidate(s)\n`),
      },
    });
  } catch (e) {
    console.log(`  Per-element arm: retrieval failed (${e.message}) — skipped.`);
    return [];
  }
  const perElement = (disc && disc.perElement) || [];
  if (!perElement.length) {
    console.log(`  Per-element arm: ${(disc && disc.error) || 'no candidates'} — skipped.`);
    return [];
  }

  const added = perElementMatches(perElement, { max: budget, skip: topMatches.map(matchKey) });
  if (!added.length) {
    console.log('  Per-element arm: every candidate was already selected by the whole-claim search.');
    return [];
  }
  const covered = new Set(added.map((m) => m._element)).size;
  console.log(`  Per-element arm merged: +${added.length} function(s) the whole-claim search did not reach`
    + ` (covering ${covered} of ${elements.length} element(s), no quorum, symbol-name search).`);
  topMatches.push(...added);
  return added;
}


/**
 * Analyze one function against a patent claim.
 */
async function _doClaimSingleAnalyze(ext, claimText, args, maskAll, showPrompt, lineNumbers) {
  const { filepath, funcName, source, start, end, lines } = ext;

  const sourceForLLM = _prepareSource(source, filepath, {
    maskAll, lineNumbers, startLine: start, funcName,
  });

  const prompt = buildClaimAnalyzePrompt(sourceForLLM, funcName, filepath, claimText, maskAll);

  // Header
  console.log('='.repeat(70));
  console.log(`CLAIM-ANALYZE: ${filepath}@${funcName}`);
  console.log(`  Lines ${start}-${end} (${lines} lines)`);
  // Provenance ON the artifact, not around it: which search put this function in
  // front of the model. A per-element cite answers ONE limitation and was chosen
  // by symbol name with no quorum, which a reader checking the chart should know.
  if (ext.via === 'per-element') {
    console.log(`  Retrieved by: per-element search for element ${ext.element}`
      + `${ext.elementWords && ext.elementWords.length ? ` [${ext.elementWords.join(', ')}]` : ''}`);
    // Beside the retrieval provenance, because that is where a reader is
    // already asking "why is this function in front of me". A limitation about
    // sending answered by a function named `receive` is B6 in the rules, and it
    // reached this point once already (2026-08-16). Stated, never filtered.
    if (ext.directionalMismatch) {
      console.log(`  ⚠ DIRECTION: the limitation is ${ext.directionalMismatch.limitation}`
        + ` and this symbol reads as ${ext.directionalMismatch.symbol}`
        + ` — verify before citing; it may still be correct (duplex, or a function that does both)`);
    }
  }
  console.log(`  Claim: ${claimText.slice(0, 80)}${claimText.length > 80 ? '...' : ''}`);
  if (maskAll) console.log('  Masked: comments, strings, identifiers');
  console.log('='.repeat(70));

  if (showPrompt) {
    console.log();
    console.log('PROMPT TO LLM:');
    console.log('-'.repeat(70));
    console.log(prompt);
    console.log('-'.repeat(70));
    console.log('\n(--show-prompt: prompt displayed, no LLM call made)');
    _printExtractTip(filepath, funcName);
    return;
  }

  // Prompt-length summary to stderr so the user sees progress when stdout
  // is redirected to a file. Full prompt is gated behind --verbose since
  // users who want the actual prompt text can already get it via
  // --show-prompt. Previously we unconditionally spilled the entire prompt
  // to stderr, which was noisy when piping stdout > file.txt.
  if (args.verbose) {
    process.stderr.write(`\n--- Prompt sent to LLM (${prompt.length} chars) ---\n`);
    process.stderr.write(prompt + '\n');
    process.stderr.write('--- End prompt ---\n\n');
  } else {
    process.stderr.write(`\nSending prompt to LLM (${prompt.length} chars)...\n`);
  }

  const llm = getAnalysisLLM(args);
  if (!llm.isAvailable()) {
    console.log();
    console.log(`Source code (${lines} lines):`);
    console.log(sourceForLLM);
    console.log();
    console.log('WARNING: No LLM available. Use --llm claude or --analyze-model <path>');
    _printExtractTip(filepath, funcName);
    return;
  }

  console.log();
  const label = llm.useClaude ? '[AI] Claude Claim Analysis:' : '[AI] AI Claim Analysis:';
  console.log(label);
  const response = await llm.generate(prompt, 800);
  console.log(response);
  console.log('='.repeat(70));

  const usage = llm.getUsageSummary();
  if (usage) console.log(usage);
  _printDisclaimer(llm.isCloud());
  _printExtractTip(filepath, funcName);
}


/**
 * Analyze a whole file against a patent claim (fallback when no function match).
 */
async function _doClaimFileAnalyze(index, args, filepath, claimText, maskAll, showPrompt, lineNumbers) {
  const fileMatch = resolveFile(index, filepath);
  if (!fileMatch) return;

  const { source, lines: nLines } = fileMatch;
  filepath = fileMatch.filepath;

  const sourceForLLM = _prepareSource(source, filepath, {
    maskAll, lineNumbers, startLine: 1,
  });

  const prompt = buildClaimFilePrompt(sourceForLLM, filepath, nLines, claimText, maskAll);

  // Header
  console.log('='.repeat(70));
  console.log(`CLAIM-ANALYZE (file): ${filepath}`);
  console.log(`  ${nLines} lines`);
  console.log(`  Claim: ${claimText.slice(0, 80)}${claimText.length > 80 ? '...' : ''}`);
  if (maskAll) console.log('  Masked: comments, strings (file-level)');
  console.log('='.repeat(70));

  if (showPrompt) {
    console.log();
    console.log('PROMPT TO LLM:');
    console.log('-'.repeat(70));
    console.log(prompt);
    console.log('-'.repeat(70));
    console.log('\n(--show-prompt: prompt displayed, no LLM call made)');
    return;
  }

  process.stderr.write(`\n--- Prompt sent to LLM (${prompt.length} chars) ---\n`);
  process.stderr.write(prompt + '\n');
  process.stderr.write('--- End prompt ---\n\n');

  const llm = getAnalysisLLM(args);
  if (!llm.isAvailable()) {
    console.log();
    console.log(`WARNING: No LLM available. Use --llm claude or --analyze-model <path>`);
    return;
  }

  console.log();
  const label = llm.useClaude ? '[AI] Claude Claim Analysis:' : '[AI] AI Claim Analysis:';
  console.log(label);
  const response = await llm.generate(prompt, 800);
  console.log(response);
  console.log('='.repeat(70));

  const usage = llm.getUsageSummary();
  if (usage) console.log(usage);
  _printDisclaimer(llm.isCloud());
}


// ============================================================================
// do_multisect_analyze
// ============================================================================

/**
 * Handle --multisect-analyze TERMS: search for functions, then analyze best hits.
 */
export async function doMultisectAnalyze(index, args) {
  const termsStr = args.multisect_analyze;
  if (!termsStr) return;

  const terms = parseMultisectTerms(termsStr);
  if (!terms) return;

  const positiveTerms = terms.filter(t => !t.negated);
  if (positiveTerms.length < 2) {
    console.log('Need at least 2 positive (non-NOT) semicolon-separated search terms.');
    console.log('Example: --multisect-analyze "allocate;free;buffer"');
    return;
  }

  // Build display terms (strip /.../ for display)
  const displayTerms = positiveTerms.map(t => {
    let d = t.display;
    if (d.startsWith('/') && d.endsWith('/')) d = d.slice(1, -1);
    return d;
  });
  const negatedTerms = terms.filter(t => t.negated);

  // Run search
  console.log(`Searching for functions matching: ${displayTerms.join('; ')}`);
  if (negatedTerms.length > 0) {
    console.log(`  NOT terms (must be absent): ${negatedTerms.map(t => t.display.replace(/^NOT /, '')).join('; ')}`);
  }

  const minTermsRaw = args.min_terms || '0';
  let minTerms;
  if (minTermsRaw === '0' || minTermsRaw.toLowerCase() === 'all') {
    minTerms = positiveTerms.length;
  } else {
    minTerms = parseInt(minTermsRaw, 10) || positiveTerms.length;
  }

  let results;
  console.log(`  Requiring ${minTerms}/${positiveTerms.length} positive terms`);
  if (minTerms === positiveTerms.length && positiveTerms.length > 10) {
    console.log(`  (Tip: ${positiveTerms.length} required terms is very restrictive. Try min=${Math.floor(positiveTerms.length * 0.6)} for partial matching.)`);
  }
  try {
    results = index.multisectSearch(terms, {
      minTerms,
      includePath: args.include_path || null,
      excludePath: args.exclude_path || null,
    });
  } catch (e) {
    console.log(`Multisect search failed: ${e.message}`);
    return;
  }

  if (!results) {
    console.log('Multisect search returned no results.');
    return;
  }

  // Filter out (global) scope entries - not extractable functions
  const funcMatches = (results.function_matches || []).filter(
    fm => fm.function !== '(global)' && fm.lines > 0
  );

  if (funcMatches.length === 0) {
    // File-level fallback
    const fileMatches = results.file_matches || [];
    if (fileMatches.length > 0) {
      const topFile = fileMatches[0];
      const maxLines = selectedCloudProvider(args) ? _FILE_MAX_LINES_CLOUD : _FILE_MAX_LINES_LOCAL;  // #246

      if (topFile.lines <= maxLines) {
        console.log(`\nNo single function contains all terms, but file '${topFile.filepath}' (${topFile.lines} lines) does.`);
        console.log('  Falling through to whole-file analysis...');
        await doFileAnalyze(index, { ...args, file_analyze: topFile.filepath });
      } else {
        console.log(`\nNo single function contains all terms, but ${fileMatches.length} file(s) do.`);
        console.log('Top file matches:');
        for (const fm of fileMatches.slice(0, 5)) {
          console.log(`  [${fm.terms_matched}/${positiveTerms.length}] ${fm.filepath} (${fm.lines} lines)`);
        }
        console.log(`\n  Top file is ${topFile.lines} lines - too large for ${maxLines}-line limit.`);
        console.log('  Try --multisect-search for full results, or reduce terms.');
      }
    } else {
      console.log('No function or file matches found for these terms.');
    }
    return;
  }

  // Top 2 matches
  // #307: was a hardcoded 2, and it was the binding constraint once scope is
  // right. Measured on US 8,752,101 x .AndroidX_Media_ExoPlayer3, scoped: ranks
  // 1-4 are AdaptiveTrackSelectionTest methods, 5 is evaluateQueueSize and 6 is
  // AdaptiveTrackSelection::updateSelectedTrack -- the acceptance symbol. The
  // first symbol OUTSIDE that class is rank 12, so 6 is a clean cut, not a taste
  // call. At 2, a [10/13] vs [9/13] term-count difference -- inside the noise of
  // the heuristic -- decided the whole chart.
  const topMatches = funcMatches.slice(0, claimAnalyzeTopN(args));

  console.log(`\n  Found ${funcMatches.length} function match(es), analyzing top ${topMatches.length}:`);
  for (let i = 0; i < topMatches.length; i++) {
    const fm = topMatches[i];
    console.log(`  [${i + 1}] [${fm.terms_matched}/${positiveTerms.length} terms] ${fm.filepath}@${fm.function} (${fm.lines} lines)`);
  }

  // Extract and analyze
  const extracted = [];
  for (const fm of topMatches) {
    const source = index.getFunctionSource(fm.filepath, fm.function);
    if (source) {
      const funcInfo = _getFuncLineRange(index, fm.filepath, fm.function);
      extracted.push({
        filepath: fm.filepath,
        funcName: fm.function,
        source,
        start: funcInfo.start,
        end: funcInfo.end,
        termsMatched: fm.terms_matched,
        lines: fm.lines,
      });
    }
  }

  if (extracted.length === 0) {
    console.log('Could not extract source for any matching functions.');
    return;
  }

  const maskAll = args.mask_all || false;
  const showPrompt = args.show_prompt || false;
  const lineNumbers = wantsLineNumbers(args);

  // Analyze each separately (combined mode deferred - structure supports it)
  for (let i = 0; i < extracted.length; i++) {
    if (i > 0) console.log();
    await _doMultisectSingleAnalyze(extracted[i], displayTerms, args, maskAll, showPrompt, lineNumbers);
  }
}


/**
 * Analyze one function in multisect context.
 */
async function _doMultisectSingleAnalyze(ext, displayTerms, args, maskAll, showPrompt, lineNumbers) {
  const { filepath, funcName, source, start, end, lines } = ext;

  const sourceForLLM = _prepareSource(source, filepath, {
    maskAll, lineNumbers, startLine: start, funcName,
  });

  const prompt = buildMultisectAnalyzePrompt(sourceForLLM, funcName, filepath, displayTerms, maskAll);

  // Header
  console.log('='.repeat(70));
  console.log(`MULTISECT-ANALYZE: ${filepath}@${funcName}`);
  console.log(`  Lines ${start}-${end} (${lines} lines)`);
  console.log(`  Terms: ${displayTerms.join('; ')}`);
  if (maskAll) console.log('  Masked: comments, strings, identifiers');
  console.log('='.repeat(70));

  if (showPrompt) {
    console.log();
    console.log('PROMPT TO LLM:');
    console.log('-'.repeat(70));
    console.log(prompt);
    console.log('-'.repeat(70));
    console.log('\n(--show-prompt: prompt displayed, no LLM call made)');
    _printExtractTip(filepath, funcName);
    return;
  }

  process.stderr.write(`\n--- Prompt sent to LLM (${prompt.length} chars) ---\n`);
  process.stderr.write(prompt + '\n');
  process.stderr.write('--- End prompt ---\n\n');

  const llm = getAnalysisLLM(args);
  if (!llm.isAvailable()) {
    console.log();
    console.log(`Source code (${lines} lines):`);
    console.log(sourceForLLM);
    console.log();
    console.log('WARNING: No LLM available. Use --llm claude or --analyze-model <path>');
    _printExtractTip(filepath, funcName);
    return;
  }

  console.log();
  const label = llm.useClaude ? '[AI] Claude Multisect Analysis:' : '[AI] AI Multisect Analysis:';
  console.log(label);
  const response = await llm.generate(prompt, 600);
  console.log(response);
  console.log('='.repeat(70));

  const usage = llm.getUsageSummary();
  if (usage) console.log(usage);
  _printDisclaimer(llm.isCloud());
  _printExtractTip(filepath, funcName);
}


// ============================================================================
// do_file_analyze
// ============================================================================

/**
 * Handle --file-analyze FILEPATH: analyze an entire source file with LLM.
 */
export async function doFileAnalyze(index, args) {
  const fileSpec = args.file_analyze;
  if (!fileSpec) return;

  const fileMatch = resolveFile(index, fileSpec);
  if (!fileMatch) return;

  const { filepath, source, lines: nLines } = fileMatch;
  const maskAll = args.mask_all || false;
  const showPrompt = args.show_prompt || false;
  const lineNumbers = args.line_numbers || false;
  const _cloudProvider = selectedCloudProvider(args);  // #246: any cloud provider

  // Local (air-gapped) analysis is bounded by the model's context window, so keep
  // a line cap. Cloud analysis is bounded by a projected-COST guard applied below
  // (after the prompt is built), which replaces the old fixed Claude line cap.
  if (!_cloudProvider && nLines > _FILE_MAX_LINES_LOCAL && !showPrompt) {
    console.log(`File '${filepath}' is ${nLines} lines - too large for local file analysis (limit: ${_FILE_MAX_LINES_LOCAL}).`);
    console.log(`  Tip: Use --analyze FILE@FUNCTION to analyze individual functions.`);
    console.log(`  Tip: Use --list-functions "${filepath.split(/[\\/]/).pop()}" to see functions in this file.`);
    return;
  }

  // Get function names for hint
  const funcNames = [];
  if (index.functionIndex && index.functionIndex[filepath]) {
    funcNames.push(...Object.keys(index.functionIndex[filepath]).sort());
  }

  const sourceForLLM = _prepareSource(source, filepath, {
    maskAll, lineNumbers, startLine: 1,
  });

  const prompt = buildFileAnalyzePrompt(
    sourceForLLM, filepath, maskAll,
    maskAll ? null : funcNames,
  );

  // Header
  console.log('='.repeat(70));
  console.log(`FILE-ANALYZE: ${filepath}`);
  console.log(`  ${nLines} lines, ${funcNames.length} functions`);
  if (maskAll) console.log('  Masked: comments, strings (file-level)');
  console.log('='.repeat(70));

  if (showPrompt) {
    console.log();
    console.log('PROMPT TO LLM:');
    console.log('-'.repeat(70));
    console.log(prompt);
    console.log('-'.repeat(70));
    console.log('\n(--show-prompt: prompt displayed, no LLM call made)');
    return;
  }

  const costBlock = _analyzeCostBlock(args, prompt.length);
  if (costBlock) {
    _printCostBlock(costBlock, 'This file analysis');
    console.log(`  Tip: --analyze ${filepath.split(/[\\/]/).pop()}@FUNCTION to analyze a single function instead.`);
    return;
  }

  process.stderr.write(`\n--- Prompt sent to LLM (${prompt.length} chars) ---\n`);
  process.stderr.write(prompt + '\n');
  process.stderr.write('--- End prompt ---\n\n');

  const llm = getAnalysisLLM(args);
  if (!llm.isAvailable()) {
    console.log();
    console.log(`File source (${nLines} lines) - first 20 lines:`);
    for (const line of sourceForLLM.split('\n').slice(0, 20)) {
      console.log(`  ${line}`);
    }
    console.log('  ...');
    console.log();
    console.log('WARNING: No LLM available. Use --llm claude or --analyze-model <path>');
    return;
  }

  console.log();
  const label = llm.useClaude ? '[AI] Claude File Analysis:' : '[AI] AI File Analysis:';
  console.log(label);
  const response = await llm.generate(prompt, 800);
  console.log(response);
  console.log('='.repeat(70));

  const usage = llm.getUsageSummary();
  if (usage) console.log(usage);
  _printDisclaimer(llm.isCloud());
  if (funcNames.length > 0) {
    const fname = filepath.split(/[\\/]/).pop();
    console.log(`  Tip: --analyze ${fname}@FUNCTION to analyze individual functions`);
  }
}


// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Look up start/end lines for a function from the function index.
 */
function _getFuncLineRange(index, filepath, funcName) {
  if (index.functionIndex && index.functionIndex[filepath]) {
    const fileFuncs = index.functionIndex[filepath];
    const info = fileFuncs[funcName];
    if (info) {
      return { start: info.start || 1, end: info.end || 1 };
    }
    // Try base_name match
    for (const [, info] of Object.entries(fileFuncs)) {
      if (info.base_name === funcName) {
        return { start: info.start || 1, end: info.end || 1 };
      }
    }
  }
  return { start: 1, end: 1 };
}


/**
 * Simple HTTP/HTTPS POST helper (mirrors claim.js's _httpPost).
 */
function _httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 90000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (90s)')); });
    req.write(body);
    req.end();
  });
}
