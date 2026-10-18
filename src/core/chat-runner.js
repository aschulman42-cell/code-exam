// chat-runner.js — the chat-about-code tool loops (Claude, OpenAI-compatible, local GGUF), shared by the GUI server and the CLI's --ask-ai
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * Extracted from src/server.js (cli-ask-ai) so the CLI can ask one question
 * over an index with the same loops the GUI Chat runs: the same system prompt,
 * the same tools (every registered tool on a cloud engine, the curated core
 * on a local model), the same guards (budgets, duplicate refusal, result cap,
 * special-token neutralization), the same stall detection and tools-off
 * synthesis. The server's own comment above the local loop said a shared
 * extraction was "a fair follow-up"; this is it. The loop bodies are the
 * server's, unchanged in behaviour; what the server used to reach through
 * module scope is now a parameter:
 *
 *   log          where progress lines go (default console.log; the CLI sends
 *                them to stderr so stdout stays the answer)
 *   local        the loaded-model holder the local loop drives: an object with
 *                ensureLocalModel() -> { ok } | { error }, _localModel (the
 *                node-llama-cpp handles, see server.js's _loadLocalModel),
 *                reproducible (bool) and acquireSharedSequence(). The GUI
 *                passes its ServerLLM; the CLI builds one around the GGUF it
 *                loads for the question.
 *   withLock     serializes local work (the GUI's withLocalLock; the CLI has
 *                one request and passes nothing)
 *   airGapHint   the sentence after "--air-gapped: chat over the cloud LLM is
 *                blocked." — the GUI names its engine control, the CLI --model
 *
 * Every tool call still runs in-process through handleTool: no subprocess, no
 * MCP transport (CODEEXAM_MCP.md, "one tool table, three menus").
 */

import http from 'http';
import https from 'https';
import { handleTool, TOOLS, setIndex } from '../mcp-server.js';
import { isLocalApiUrl, isAirGapped } from './air-gapped.js';
import { claudeSupportsTemperature } from '../utils.js';
import { openaiSupportsTemperature, openaiCompletionBudget } from './openai-util.js';
import { chatSessionOptions, stripLocalArtifacts } from './llm-runner.js';
import { localBudgets } from './ai-overview-local.js';
import { resolveLocalChatTools } from './local-chat-tools.js';
import { answerDisclosure } from './answer-disclosure.js';

const GUI_AIR_GAP_HINT = 'Set the engine to Local in the Workspace pane (LLM controls), or restart without --air-gapped to allow cloud calls.';

// Grounding mode (#36): how freely the model may use knowledge beyond this
// codebase. Default 'grounded' — CE's forensic identity makes the inferential
// modes a deliberate opt-in, not a silent default that could undermine a finding.
export const CHAT_GROUNDING_CLAUSES = {
  grounded: `GROUNDING — STRICT: Answer ONLY from what the tools surface about this code. If something cannot be determined from the code, say so explicitly ("not determinable from the code") rather than filling the gap with general knowledge. Do NOT assert the purpose of a referenced library/algorithm, the research domain, or any external framing as fact about this codebase unless the code itself states it. Stay within the evidence the tools return. Never expand an acronym or abbreviation unless the expansion appears in tool results from this codebase — otherwise write the acronym as-is. Never state aggregate statistics (file counts, line counts, percentages) other than numbers a tool returned verbatim.`,
  augmented: `GROUNDING — AUGMENTED: You may combine what the tools surface with your general knowledge to give the richest, most useful explanation — naming the domain or research area, explaining what a referenced library or algorithm does, and supplying standard context the code assumes its readers already know.`,
  attributed: `GROUNDING — ATTRIBUTED: Combine codebase evidence with general knowledge for a rich explanation, but make provenance explicit — clearly distinguish claims grounded in THIS code (cite the file/function/tool that shows them) from claims that come from your general knowledge or inference. Flag every non-trivial external claim as such. Acronym expansions and statistics that come from your general knowledge rather than tool results must be explicitly flagged as such.`,
};

// Built per request so the model is re-grounded in the CURRENT index every turn
// (#36 cross-codebase fix) and carries the selected grounding clause.
export function chatSystemPrompt(indexName, fileCount, mode) {
  const id = indexName
    ? `You are examining the codebase currently indexed as "${indexName}"${fileCount ? ` (${fileCount} files)` : ''}.`
    : 'You are examining the currently indexed codebase.';
  const grounding = CHAT_GROUNDING_CLAUSES[mode] || CHAT_GROUNDING_CLAUSES.grounded;
  return `You are a code-analysis assistant for CodeExam. ${id} You have tools that search, analyze, and explore THIS index — use them to ground every answer in this specific code, citing files and functions by name. Be concise and direct; prefer calling a tool over guessing.

The active index can be switched mid-conversation: always answer about the CURRENT index named above. Earlier messages in this conversation may refer to a DIFFERENT codebase, so re-query the tools rather than trusting prior context.

${grounding}`;
}

// CE's MCP tool defs -> Anthropic tool-use format.
export function chatAnthropicTools() {
  return TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

// #243 Part B — the same defs in OpenAI tool-calling format.
export function chatOpenAITools() {
  return TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } },
  }));
}

// Local models degrade sharply as the tool menu grows (see
// docs/cloud-gpu-chat-testing.md, First-run findings + Cross-model matrix:
// 8B/14B collapse to zero calls or garbage args at 26 tools; even 32B args
// degrade). Keep the local loop to the curated core in
// src/core/local-chat-tools.js; the cloud loops still get all TOOLS.
// CE_LOCAL_CHAT_TOOLS extends or replaces the core for one launch — a testing
// knob, the core is the measured product — and the process says so at startup
// so an unmeasured menu is never silent.
const _resolved = resolveLocalChatTools(process.env.CE_LOCAL_CHAT_TOOLS, TOOLS.map((t) => t.name));
export const LOCAL_CHAT_TOOLS = _resolved.names;
export const localChatToolsNote = _resolved.note;
if (localChatToolsNote) console.error(localChatToolsNote);

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
export function neutralizeSpecialTokens(s, where, log = console.log) {
  const str = String(s || '');
  const hits = str.match(_SPECIAL_TOKEN_RE);
  if (!hits) return str;
  log(`  [chat] neutralized ${hits.length} special token(s) in ${where}: ${[...new Set(hits)].slice(0, 5).join(' ')}`);
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

// The CLI's measurement (ai-overview-local.js), mirrored rather than re-derived:
// base prompt through the model's own tokenizer, tool definitions at chars/3.5,
// plus the same stated 400-token margin for the framing that only exists once
// the session is built. Returns null when there is nothing to measure with, so
// the caller falls back to the documented 1200.
export function measureOverhead(model, promptBase, toolDefs) {
  try {
    const tokensOf = (s) => {
      try { if (model && typeof model.tokenize === 'function') return model.tokenize(String(s)).length; }
      catch { /* fall through to the ratio */ }
      return Math.ceil(String(s || '').length / 3.5);
    };
    let toolDefChars = 0;
    for (const def of toolDefs || []) {
      if (!def) continue;
      toolDefChars += String(def.description || '').slice(0, 280).length
        + JSON.stringify((def.inputSchema && def.inputSchema.properties) ? def.inputSchema : {}).length;
    }
    return tokensOf(promptBase) + Math.ceil(toolDefChars / 3.5) + 400;
  } catch { return null; }
}

// JSON over HTTP(S) for the cloud loops. 2 minutes for slow models.
export function httpPostJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
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

// An end_turn that is actually a STALL, not an answer: short prose that announces
// a next step it never took ("Let me find …", "Now I'll check:", a trailing
// colon). The model "finished" per the API but hasn't answered — synthesize.
const looksUnfinished = (t) => t.length < 300 && (
  /\b(let me|let's|now i['’]?ll|i['’]?ll now|next,? i|first,? (?:let me|i)|i will now)\b/i.test(t)
  || /[:：]\s*$/.test(t)
);

// Multi-turn Claude tool loop. Executes tool calls in-process via handleTool
// against `index`. Returns the flat content blocks (text + tool_use{_result})
// the chat UI renders, and the final answer alone.
export async function runChatToolLoop({ messages, index, indexName, fileCount, mode, apiKey, model, maxTokens = 4096, temperature = 0, onToolCall, log = console.log, airGapHint = GUI_AIR_GAP_HINT }) {
  setIndex(index); // point handleTool at the active index (in-process; no subprocess / re-index)
  const tools = chatAnthropicTools();
  const system = chatSystemPrompt(indexName, fileCount, mode);
  const apiUrl = process.env.CLAIM_SEARCH_API_URL || 'https://api.anthropic.com/v1/messages';
  // #223: air-gapped blocks the cloud chat loop (a loopback endpoint is OK).
  // Hostname-parsed, fail-closed (see isLocalApiUrl) — never substring-matched.
  if (!isLocalApiUrl(apiUrl) && isAirGapped()) {
    console.error('[air-gapped] blocked: chat (cloud Claude)');
    throw new Error(`--air-gapped: chat over the cloud LLM is blocked. ${airGapHint}`);
  }
  const allBlocks = [];
  let current = [...messages];
  const MAX_ITERATIONS = 25;  // raised from 15 (#36): attributed/augmented modes explore harder
  // Frontier Claude models reject `temperature` (400); omit it there (#254/#215).
  const _claudeTemp = claudeSupportsTemperature(model);
  if (!_claudeTemp) log(`  [chat] ${model}: temperature not pinnable on this model — sampling default, runs may vary`);

  // Join the text blocks of one content array into trimmed prose.
  const textOf = (content) => content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

  let answer = '';            // the FINAL answer — NOT a mash of interim narration
  let genuineFinal = false;   // an end_turn with real, complete text → no synthesis needed

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const payload = JSON.stringify({
      model, max_tokens: maxTokens, ...(_claudeTemp ? { temperature } : {}), system, messages: current, tools,
    });
    const body = await httpPostJson(apiUrl, payload, {
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
      const body = await httpPostJson(apiUrl, JSON.stringify({
        model, max_tokens: maxTokens, ...(_claudeTemp ? { temperature } : {}), system, messages: synthMsgs,  // no `tools` → stop_reason can't be tool_use
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
  log(`  [chat] final answer ${answer.length} chars (genuineFinal=${genuineFinal}, ${allBlocks.length} blocks)`);

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
export async function runChatToolLoopOpenAI({ messages, index, indexName, fileCount, mode, apiKey, model, baseUrl, maxTokens = 4096, onToolCall, log = console.log, airGapHint = GUI_AIR_GAP_HINT }) {
  setIndex(index);
  const tools = chatOpenAITools();
  const system = chatSystemPrompt(indexName, fileCount, mode);
  // #246: baseUrl parameterizes the openai-compat provider (OpenAI or Gemini);
  // CE_OPENAI_API_URL still overrides for a localhost gateway.
  const apiUrl = process.env.CE_OPENAI_API_URL || (baseUrl ? `${baseUrl}/chat/completions` : 'https://api.openai.com/v1/chat/completions');
  if (!isLocalApiUrl(apiUrl) && isAirGapped()) {
    console.error('[air-gapped] blocked: chat (cloud openai-compat)');
    throw new Error(`--air-gapped: chat over the cloud LLM is blocked. ${airGapHint}`);
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
  let answer = '';
  let genuineFinal = false;

  const post = (msgs, withTools) => httpPostJson(apiUrl, JSON.stringify({
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
  // #246: this loop serves any openai-compat provider (OpenAI or Gemini), so
  // log the actual model, not a hardcoded "openai" (which read as if a gemini
  // chat had gone to OpenAI).
  log(`  [chat] ${model} final answer ${answer.length} chars (${allBlocks.filter(b => b.type === 'tool_use').length} tool calls)`);
  return { content: allBlocks, answer };
}

// Prior conversation is flattened into a preamble (version-robust across
// node-llama-cpp releases); higher-fidelity multi-turn history is a follow-up.
const _asChatText = (c) => Array.isArray(c)
  ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n')
  : String(c || '');

// #243 Part A — local (GGUF) counterpart to runChatToolLoop. Mirrors the PROVEN
// ai-overview-local.js pattern: expose CE's TOOLS as node-llama-cpp chat
// functions (backed by handleTool in-process — no MCP subprocess) and let the
// model drive a multi-turn function-calling loop via session.prompt(...,
// { functions }). Returns the SAME { content, answer } shape as the Claude loop
// so the routes and the GUI stay engine-agnostic. Air-gapped-safe: no cloud call.
export async function runChatToolLoopLocal({ messages, index, indexName, fileCount, mode, onToolCall, maxTokens = null, local, withLock = (fn) => fn(), localToolNames = LOCAL_CHAT_TOOLS, log = console.log }) {
  if (!local) throw new Error('local chat: no local model holder was supplied');
  // #248: serialize the entire local request (setIndex + shared-sequence chat)
  // so a concurrent local request can neither repoint the tool index mid-loop
  // nor clobber the shared sequence's history.
  return withLock(async () => {
  setIndex(index); // point handleTool at the active index (in-process)
  const loaded = await local.ensureLocalModel();
  if (loaded.error) throw new Error(loaded.error);
  const lm = local._localModel;
  if (!lm || !lm.defineChatSessionFunction) {
    throw new Error('local chat: node-llama-cpp function-calling unavailable (update node-llama-cpp).');
  }
  const { LlamaChatSession, defineChatSessionFunction } = lm;
  const system = chatSystemPrompt(indexName, fileCount, mode);
  const menu = TOOLS.filter(tl => localToolNames.includes(tl.name));

  // Response-length budget: scale with the loaded context unless the caller
  // passed an explicit value — 2400 at the 8k default (laptop behavior
  // unchanged), 4096 at 24k. The old fixed 2400 truncated page-scale answers
  // mid-sentence at large contexts (chat-response-length). Must be resolved
  // BEFORE the tool budget below, which reserves this many output tokens.
  // #248: budgets that provably fit the loaded context (incl. the 2048/4096 rungs).
  // Same measured overhead as the overview path: the chat tool definitions are
  // rendered into the prompt too, so assuming 1200 over-issues the tool budget
  // by whatever they actually cost.
  const _b = localBudgets(lm.contextSize, maxTokens, measureOverhead(lm.model, system, menu));
  maxTokens = _b.maxTokens;

  // --reproducible pins sampling for reproducible runs (honest scope: see
  // the ServerLLM constructor). Default is node-llama-cpp sampling — run-to-
  // run variation is the chosen default (exploration; comparing variant
  // answers across runs is itself informative in examination work).
  const sampling = local.reproducible ? { temperature: 0, seed: 1 } : {};

  // Acquire a chat sequence — ONE per loaded model, cached on the holder,
  // reset between chats, never disposed. Rationale: sequence.dispose()
  // silently fails to release the slot for some model families (Gemma 3 on
  // node-llama-cpp <= 3.19.0, both unsloth and official-QAT GGUFs), so the
  // canonical acquire/dispose-per-chat pattern locks the context out with
  // "No sequences left" after one chat — and disposing the poisoned context
  // in-process deadlocks native teardown, so there is no in-place recovery.
  // Reuse sidesteps the broken dispose entirely. Verified: no cross-chat
  // state bleed (a fresh LlamaChatSession re-evaluates the sequence from
  // scratch; probed with distinct per-chat secrets).
  const acquireSequence = () => local.acquireSharedSequence();

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
  for (const t of menu) {
    functions[t.name] = defineChatSessionFunction({
      description: String(t.description || '').slice(0, 280),
      params: (t.inputSchema && t.inputSchema.properties) ? t.inputSchema : { type: 'object', properties: {} },
      handler: (args) => {
        toolCalls++;
        if (budgetStopped || toolCalls > MAX_TOOL_CALLS || toolChars > toolBudgetChars) {
          if (!budgetStopped) {
            budgetStopped = true;
            log(`  [chat] budget-stop after ${toolCalls - 1} calls (${toolChars} result chars, budget ${Math.floor(toolBudgetChars)})`);
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
        // chat-template tokens riding in the examined code. The recorded block
        // holds the neutralized form — i.e., exactly what the model saw.
        const capped = neutralizeSpecialTokens(out.slice(0, 4000), `${t.name} result`, log);
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
    : question, 'user question', log);

  // One exported helper (llm-runner's stripLocalArtifacts) handles the
  // chain-of-thought block, the mis-typed Gemma 4 markers, and the fabricated
  // closers, for this path and both overview paths alike.
  const stripThink = stripLocalArtifacts;

  const sequence = await acquireSequence();
  let session;
  try {
    session = new LlamaChatSession(await chatSessionOptions(sequence, { systemPrompt: system }));
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
      log(`  [chat] response hit the ${maxTokens}-token cap`);
    }
    // #306 item 5 (F55/F56): a declining answer records what the investigation
    // behind it was. Appended AFTER generation and never fed back — an honest
    // refusal is correct output for an evidence tool, so this must not nudge the
    // model away from refusing. Names come from the recorded blocks, the same
    // population the log line below counts.
    const _answeredWith = blocks.filter(b => b.type === 'tool_use').map(b => b.name);
    const _disclosure = answerDisclosure(prose, _answeredWith);
    if (_disclosure) {
      prose += _disclosure;
      log(`  [chat] declining answer — ${_answeredWith.length} calls, ${new Set(_answeredWith).size} distinct`);
    }
    blocks.push({ type: 'text', text: prose });
    log(`  [chat] local final answer ${prose.length} chars (${blocks.filter(b => b.type === 'tool_use').length} tool calls)`);
    return { content: blocks, answer: prose };
  } finally {
    // #248: dispose the SESSION on every path (success OR throw) — the old code
    // disposed it only on success, leaking a session (with full history) on any
    // mid-generation error. NOT disposing `sequence`: it is the cached long-lived
    // per-model sequence (see acquireSharedSequence); the next chat resets it
    // with clearHistory.
    if (session) { try { session.dispose(); } catch (e) { console.warn(`  [chat] session dispose failed: ${e.message}`); } }
  }
  }); // withLock
}
