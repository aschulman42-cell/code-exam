// ask.js — --ask-ai: one question to the chosen engine over an index, through the Chat tool loops, printed with a provenance header and the tool-call footer
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * cli-ask-ai. `ce --index-path <idx> --ask-ai "question" [--llm claude|openai|gemini | --model <gguf>]`
 *
 * One question, one answer, exit. The engine runs the same loops the GUI
 * Chat runs (src/core/chat-runner.js): the same system prompt, the same tool
 * menus (every registered tool on a cloud engine, the curated core on a local
 * model), the same guards. Output on stdout: the provenance header, the
 * answer, then the `ⓘ Based on N model tool calls` footer, so the answer says
 * what it rested on. Progress (each tool call, timing) goes to stderr, so
 * stdout stays the answer for redirection.
 *
 * Exit codes: 0 answered; 1 no index at the path, no key for a cloud engine,
 * a cloud engine under --air-gapped, or an empty answer.
 *
 * `deps` is the test seam: the three loops and the local-model loader can be
 * replaced so the command's own behaviour (pre-flight, engine choice, output
 * shape, exit codes) is testable with no model and no network.
 */

import fs from 'fs';
import path from 'path';
import { CodeSearchIndex } from '../core/CodeSearchIndex.js';
import { resolveProvider, PROVIDERS } from '../core/providers.js';
import { buildProvenanceHeader } from '../core/provenance.js';
import { toolCallFooter } from '../core/answer-disclosure.js';
import { CE_VERSION } from '../version.js';
import { ggufContextLadder, ggufContextOptions, getLlamaShared, rethrowNoBinary } from '../core/llm-runner.js';
import { isAirGapped } from '../core/air-gapped.js';

const CLI_AIR_GAP_HINT = 'Use --model <file.gguf> for a local engine, or restart without --air-gapped to allow cloud calls.';

/**
 * Resolve the cloud key for a provider the way the overview branch in
 * src/index.js does: --api-key applies to the selected provider, then the
 * provider-specific flag, env var and key file.
 */
export function resolveCloudKey(args, providerId) {
  const p = PROVIDERS[providerId] || PROVIDERS.claude;
  let key = '';
  if (providerId === 'openai') key = args.openai_key || args.api_key || process.env.OPENAI_API_KEY || '';
  else if (providerId === 'gemini') key = args.gemini_key || args.api_key || process.env.GEMINI_API_KEY || '';
  else key = args.api_key || process.env.ANTHROPIC_API_KEY || '';
  if (!key) {
    for (const fname of p.keyFiles || []) {
      try { const k = fs.readFileSync(fname, 'utf-8').trim(); if (k) { key = k; break; } } catch { /* ignore */ }
    }
  }
  return key;
}

/**
 * Load a GGUF for one question and return the holder shape the local loop
 * drives (the same four members the GUI's ServerLLM exposes): node-llama-cpp
 * imported lazily, the context ladder from --context-size downward, --cpu
 * forcing the CPU, one shared sequence for the session.
 */
export async function loadLocalHolder({ modelPath, contextSize = null, flashAttention = false, cpu = false, reproducible = false, log = () => {} }) {
  if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);
  const { LlamaChatSession, defineChatSessionFunction } = await import('node-llama-cpp');
  // The process's one engine instance (shared with the early touch in index.js).
  const llama = await getLlamaShared({ cpu }).catch(rethrowNoBinary);
  log(`[ask-ai] loading ${path.basename(modelPath)}${cpu ? ' (CPU)' : ''}…`);
  const model = await llama.loadModel({ modelPath });
  let context = null, achieved = 0;
  for (const sz of ggufContextLadder(contextSize)) {
    try { context = await model.createContext(ggufContextOptions(sz, flashAttention)); achieved = sz; break; }
    catch { /* shrink */ }
  }
  if (!context) {
    try { await model.dispose(); } catch { /* */ }
    throw new Error(`Cannot allocate a context for ${path.basename(modelPath)} (tried ${ggufContextLadder(contextSize).join('/')}). Try --cpu, or a smaller model.`);
  }
  log(`[ask-ai] context ${achieved}${flashAttention ? ' (flash attention)' : ''}`);
  let sequence = null;
  return {
    _localModel: { llama, model, context, LlamaChatSession, defineChatSessionFunction, contextSize: achieved, modelPath },
    reproducible: !!reproducible,
    ensureLocalModel: async () => ({ ok: true }),
    acquireSharedSequence: async () => { if (!sequence) sequence = context.getSequence(); return sequence; },
  };
}

/**
 * Run the question. Returns the exit code; writes through `out` (stdout) and
 * `err` (stderr). `deps` lets tests supply the loops and the loader.
 */
export async function doAskAi(args, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s));
  const err = deps.err || ((s) => process.stderr.write(s));
  const question = String(args.ask_ai || '').trim();
  if (!question) { err('[ask-ai] A question is required: --ask-ai "what does X do?"\n'); return 1; }

  // Pre-flight: never load a model or call an API against a missing index (the
  // same marker check the overview branch makes; no full load for the check).
  const idxArg = String(args.index_path || '').replace(/[\\/]+$/, '');
  if (!/\.zip$/i.test(idxArg) && !fs.existsSync(`${idxArg}/literal_index.json`)) {
    err(`[ask-ai] No CodeExam index at "${args.index_path}" (no literal_index.json — check the path / cwd). Not calling the LLM.\n`);
    return 1;
  }

  // Engine: --model <gguf> is the local engine; otherwise the cloud provider
  // from --llm, resolved through the registry (Claude is the deliberate default).
  const localGguf = args.model || null;
  const cloudEngine = localGguf ? null : resolveProvider(args.llm).provider.id;
  const mode = ['grounded', 'augmented', 'attributed'].includes(args.grounding) ? args.grounding : 'grounded';

  let runner;
  try { runner = deps.chatRunner || await import('../core/chat-runner.js'); }
  catch (e) { err(`[ask-ai] cannot load the chat loops: ${e.message}\n`); return 1; }

  // Load the index (full load: the tools need it in memory).
  let index;
  try { index = deps.index || new CodeSearchIndex({ indexPath: args.index_path }); }
  catch (e) { err(`[ask-ai] cannot load the index: ${e.message}\n`); return 1; }
  const fileCount = index.files ? index.files.size : 0;
  const indexName = path.basename(idxArg) || args.index_path;

  const counts = new Map();
  const onToolCall = (name, input) => {
    counts.set(name, (counts.get(name) || 0) + 1);
    err(`[ask-ai] tool: ${name}(${JSON.stringify(input || {}).slice(0, 120)})\n`);
  };
  const log = (s) => { if (args.verbose) err(`${s}\n`); };
  const messages = [{ role: 'user', content: question }];
  const startedAt = Date.now();

  let answer = '';
  let engineLabel, modelLabel;
  try {
    if (localGguf) {
      engineLabel = 'local';
      modelLabel = path.basename(localGguf);
      err(`[ask-ai] running local ${modelLabel}${args.cpu ? ' (CPU)' : ''}, grounding=${mode}, over ${args.index_path}…\n`);
      const local = deps.localHolder || await (deps.loadLocalHolder || loadLocalHolder)({
        modelPath: localGguf,
        contextSize: args.context_size || null,
        flashAttention: !!args.flash_attention,
        cpu: !!args.cpu,
        reproducible: !!args.reproducible,
        log: (s) => err(`${s}\n`),
      });
      ({ answer } = await runner.runChatToolLoopLocal({ messages, index, indexName, fileCount, mode, onToolCall, local, log }));
    } else {
      const prov = PROVIDERS[cloudEngine];
      // Say the cloud engine is blocked BEFORE asking for a key: under
      // --air-gapped a "set your key" message would send the user the wrong way.
      // (The loop checks again, hostname-parsed, before any call.)
      if ((deps.isAirGapped || isAirGapped)()) {
        err(`[ask-ai] --air-gapped: ${prov.label} is blocked. ${CLI_AIR_GAP_HINT}\n`);
        return 1;
      }
      const key = deps.cloudKey !== undefined ? deps.cloudKey : resolveCloudKey(args, cloudEngine);
      if (!key) {
        err(`[ask-ai] ${prov.label}: no API key — set ${prov.keyEnv}, pass ${prov.keyFlag}, or create ${prov.keyFiles[0]}; or run with a local --model <file.gguf>.\n`);
        return 1;
      }
      engineLabel = cloudEngine;
      modelLabel = cloudEngine === 'openai' ? (args.openai_model || process.env.CE_OPENAI_MODEL || prov.defaultModel)
        : cloudEngine === 'gemini' ? (args.gemini_model || prov.defaultModel)
        : (args.claude_model || process.env.CE_AI_OVERVIEW_MODEL || prov.defaultModel);
      err(`[ask-ai] running ${prov.label} (${modelLabel}), grounding=${mode}, over ${args.index_path}…\n`);
      const common = { messages, index, indexName, fileCount, mode, onToolCall, log, airGapHint: CLI_AIR_GAP_HINT, apiKey: key, model: modelLabel };
      if (cloudEngine === 'claude') ({ answer } = await runner.runChatToolLoop({ ...common, temperature: 0 }));
      else ({ answer } = await runner.runChatToolLoopOpenAI({ ...common, baseUrl: cloudEngine === 'gemini' ? prov.baseUrl : undefined }));
    }
  } catch (e) {
    err(`[ask-ai] did not complete: ${e.message}\n`);
    return 1;
  }
  if (!String(answer || '').trim()) { err('[ask-ai] the model returned no answer.\n'); return 1; }

  const header = buildProvenanceHeader({
    version: CE_VERSION,
    indexPath: args.index_path,
    fileCount,
    command: `--ask-ai (grounding ${mode})`,
    engine: engineLabel,
    model: modelLabel,
    subject: `Question: ${question}`,
  });
  // The evidentiary footer, the same line an Overview by AI carries: which
  // tools the model chose to call, and how often.
  const footer = toolCallFooter(counts);
  out(`${header}\n\n${answer.trim()}\n\n${footer}\n`);
  err(`[ask-ai] done in ${Math.round((Date.now() - startedAt) / 1000)}s\n`);
  return 0;
}
