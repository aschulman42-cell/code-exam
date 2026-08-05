/**
 * ai-overview-local.js — "Overview by AI" via a LOCAL GGUF model (#196 spike).
 *
 * Air-gapped alternative to the `claude` CLI engine (ai-overview.js): loads a
 * GGUF with node-llama-cpp IN-PROCESS and runs the same orientation prompt as an
 * agentic tool-loop. Instead of MCP-over-stdio, the CE tools are exposed as
 * node-llama-cpp chat functions that call CE's exported `handleTool` directly —
 * so there's no subprocess and no MCP transport, just the model + the tool seam.
 *
 * Reuses: the shared AI_OVERVIEW_PROMPT / AI_OVERVIEW_TOOLS (ai-overview.js),
 * CE's `handleTool` / `TOOLS` / `setIndex` (mcp-server.js), and the same
 * getLlama→loadModel→createContext pattern CE already uses for claim/analyze
 * (server.js). The new piece is the multi-turn function-calling loop, which
 * node-llama-cpp's `session.prompt(..., { functions })` runs for us.
 *
 * Spike status: CLI-first; validated against Qwen3-4B-Q4_K_M. GUI wiring and
 * a local-vs-claude comparison harness are later increments.
 */

import { CodeSearchIndex } from './CodeSearchIndex.js';
import { handleTool, TOOLS, setIndex } from '../mcp-server.js';
import { AI_OVERVIEW_TOOLS, aiOverviewPrompt } from './ai-overview.js';

// The CE tool names the overview may call (same allow-list as the claude
// engine), with the mcp__code-exam__ prefix stripped to the handleTool case.
const TOOL_NAMES = AI_OVERVIEW_TOOLS.split(',').map(t => t.replace(/^mcp__code-exam__/, ''));

const MAX_TOOL_OUTPUT = 4000; // chars — cap each tool result so the loop doesn't blow the context window

// ---------------------------------------------------------------------------
// #276 hardening-parity helpers. Shared by this CLI path and server.js's
// runAiOverviewLocalShared; the chat loop keeps its own earlier copies — a
// later cleanup can dedupe all three (see the note in ai-overview.js).
// ---------------------------------------------------------------------------

// Special-token neutralization (port of the server chat-loop guard, #250):
// tool results can contain text that lexes as chat-template control tokens
// (ChatML <|...|>, Gemma turn tags, Mistral [INST], DeepSeek fullwidth bars).
// Break every form with visibly-distinct lookalike delimiters.
const SPECIAL_TOKEN_RE = new RegExp([
  '</?think>',
  '</?tool_(?:call|response)>',
  '<\\|[^|<>]{1,32}\\|>',
  '<\\uff5c[^\\uff5c<>]{1,40}\\uff5c>',
  '<(?:start|end)_of_turn>',
  '\\[/?INST\\]', '\\[TOOL_CALLS\\]',
  '</?s>',
].join('|'), 'gi');

export function neutralizeSpecialTokens(s, where = 'tool result', log = null) {
  const str = String(s || '');
  const hits = str.match(SPECIAL_TOKEN_RE);
  if (!hits) return str;
  if (log) log(`neutralized ${hits.length} special token(s) in ${where}: ${[...new Set(hits)].slice(0, 5).join(' ')}`);
  return str.replace(SPECIAL_TOKEN_RE, (m) => m
    .replace(/</g, '‹').replace(/>/g, '›')
    .replace(/\[/g, '⟦').replace(/\]/g, '⟧')
    .replace(/[|｜]/g, '¦'));
}

// node-llama-cpp's Gemma wrapper silently drops system turns, and the family
// under-uses tools without explicit insistence — deliver the instructions
// under the same strict framing header the chat loop's fold uses. Other
// families get the prompt unchanged.
export function strictInstructionsFor(wrapperName, promptText) {
  if (wrapperName !== 'Gemma') return promptText;
  return `Instructions (follow these strictly):\n${promptText}`;
}

// #276 fabrication guard: a "grounded" overview produced with ZERO tool calls
// cannot be grounded in the index — some families (Gemma 3 observed) invent a
// plausible generic codebase instead of refusing. Make that unmissable.
export function ungroundedWarning(toolCalls, grounding) {
  if (toolCalls > 0) return null;
  if (grounding && grounding !== 'grounded') return null;
  return '⚠ UNGROUNDED OUTPUT: the model made no tool calls, so nothing below '
    + 'is based on the loaded index. Treat this as generic prose, not an '
    + 'overview of this codebase. (Known behavior for some model families; '
    + 'try Qwen3.5-class, or re-run — see code-exam #276.)';
}

// Tool budget with a synthesize-now stop (port of the server overview/chat
// budget): an over-eager investigator gets cut off and told to write from
// what it has, instead of accumulating results until the context overflows —
// which for this in-process path ends in a native crash, not a clean error.
export function makeToolBudget({ maxCalls = 24, maxChars = 60000 } = {}) {
  const b = { calls: 0, chars: 0, stopped: false };
  b.gate = () => {
    b.calls++;
    if (b.stopped || b.calls > maxCalls || b.chars > maxChars) {
      b.stopped = true;
      return 'TOOL BUDGET EXHAUSTED — do not call any more tools. Write your complete overview now from the results you already have.';
    }
    return null;
  };
  b.charge = (len) => { b.chars += Number(len) || 0; };
  return b;
}

// ---------------------------------------------------------------------------
// Empty-final-turn rescue. A model can complete its tool phase and then end the
// turn without writing anything — every call succeeded, the budget is barely
// touched, and `session.prompt` resolves to "". CE returns empty prose and exit
// code 0, so a script reading the exit code sees success. These three pieces
// make the recovery decision testable without a live model.
// ---------------------------------------------------------------------------

// Deliberately far below the context-scaled ceiling: an overview is hundreds of
// tokens (observed rescues ~520), and a shorter generation is a shorter
// synchronous native block — the suspected mechanism behind an observed ~640s
// event-loop stall on this path.
export const SYNTHESIZE_RETRY_MAX_TOKENS = 1024;

// Mirrors makeToolBudget's stop string. CE already had the right primitive; it
// only ever fired when the budget was EXHAUSTED, and this failure happens at
// ~45% of budget.
export const SYNTHESIZE_NOW_PROMPT =
  'Do not call any more tools. Write your complete overview now from the results you already have.';

// Retry only when the model produced nothing AND actually investigated. Zero
// tool calls is a different failure — that is the ungrounded case, and
// re-prompting a model that never looked at the index would just invite
// fabrication.
export function needsSynthesizeRetry(raw, toolCalls) {
  return !String(raw || '').trim() && toolCalls > 0;
}

export function rescuedNote(toolCalls) {
  return `ⓘ RECOVERED OUTPUT: the model made ${toolCalls} tool call(s) and then ended `
    + 'its turn without writing anything. The overview below came from a second, '
    + 'synthesize-only pass over results it had already gathered. Treat this as a '
    + 'model limitation on the agentic path, not a clean run.';
}

// Context-scaled output/tool budgets (port of server _localBudgets).
export function localBudgets(contextSize, explicitMaxTokens) {
  const OVERHEAD = 1200;         // system prompt + tool defs + question, approx tokens
  const MIN_TOOL_TOKENS = 400;
  let maxTokens = explicitMaxTokens || Math.min(6144, Math.max(2400, Math.floor(contextSize / 6)));
  maxTokens = Math.max(256, Math.min(maxTokens, contextSize - OVERHEAD - MIN_TOOL_TOKENS));
  const toolBudgetChars = Math.max(500, Math.floor((contextSize - maxTokens - OVERHEAD) * 2.5));
  return { maxTokens, toolBudgetChars };
}

/**
 * Generate the orientation overview with a local GGUF model.
 * @param {object} o
 * @param {string} o.indexPath  index directory (loaded in-process)
 * @param {string} o.modelPath  GGUF path (CE's --model)
 * @param {number} [o.contextSize] preferred context (shrinks on OOM)
 * @param {number} [o.maxTokens]   max output tokens
 * @param {number} [o.timeoutMs]   hard wall-clock cap (default 20 min)
 * @param {('auto'|false)} [o.gpu] 'auto' (default) uses the GPU if available and
 *   falls back to CPU when the GPU can't fit the context; false forces CPU
 *   (loads into full system RAM — needed for large models on a small/integrated GPU)
 * @param {(s:string)=>void} [o.onStatus] progress sink (model load, tool calls)
 * @returns {Promise<{prose:string, toolCalls:number, contextSize:number, outTokens:(number|null)}>}
 */
// NOTE: `maxTokens` deliberately has NO default. localBudgets() scales the
// output allowance with context (`explicitMaxTokens || min(6144, max(2400,
// ctx/6))`), and `||` cannot distinguish a caller's deliberate 2400 from a
// default parameter that merely looks like one. A `= 2400` default here filled
// in for the sole caller (index.js, which never passes it), arrived as
// `explicitMaxTokens`, and pinned output at 2400 tokens at EVERY context size —
// so --context-size raised the tool budget while the answer allowance never
// moved. Leave it undefined so the scaling actually runs.
export async function runAiOverviewLocal({ indexPath, modelPath, contextSize = 16384, maxTokens, timeoutMs = 1200000, gpu = 'auto', grounding, onStatus, onStream } = {}) {
  if (!indexPath) throw new Error('runAiOverviewLocal: indexPath is required.');
  if (!modelPath) throw new Error('runAiOverviewLocal: a GGUF modelPath is required (pass --model).');
  const status = (s) => { if (onStatus) onStatus(s); };

  // CE's tools (and the index load) report progress via console.* during
  // execution ("Scanning for function calls…", "Loaded existing index…"). In
  // this in-process path the mcp-server's console→stderr redirect isn't active,
  // so without this their chatter would land on stdout and pollute the prose.
  // Redirect console.* to stderr for the run; restore in finally.
  const _log = console.log, _warn = console.warn, _err = console.error;
  const toErr = (...a) => process.stderr.write(a.join(' ') + '\n');
  console.log = toErr; console.warn = toErr; console.error = toErr;

  let model;
  try {
    // Load the index in-process and point handleTool at it (no MCP subprocess).
    const index = new CodeSearchIndex({ indexPath });
    if (index.files.size === 0) throw new Error(`No files in index at ${indexPath}`);
    setIndex(index);

    let getLlama, LlamaChatSession, defineChatSessionFunction;
    try {
      ({ getLlama, LlamaChatSession, defineChatSessionFunction } = await import('node-llama-cpp'));
    } catch (e) {
      throw new Error(`node-llama-cpp not available: ${e.message}`);
    }

    status(`loading model ${modelPath.split(/[\\/]/).pop()} …`);
    const sizes = [contextSize, 8192, 4096, 2048];

    // Load the model and create a context, optionally forcing CPU. Returns
    // {m, ctx} on success or null when no context size fits (disposing the
    // model it loaded, so the caller can retry on CPU without a leak).
    const tryLoad = async (cpuOnly) => {
      const llama = await getLlama(cpuOnly ? { gpu: false } : undefined);
      const m = await llama.loadModel({ modelPath });
      let ctx;
      for (const sz of sizes) {
        try { ctx = await m.createContext({ contextSize: sz }); contextSize = sz; break; } catch { /* shrink */ }
      }
      if (!ctx) { try { await m.dispose(); } catch { /* */ } return null; }
      return { m, ctx };
    };

    let loaded;
    if (gpu === false) {
      status('using CPU (GPU disabled) …');
      loaded = await tryLoad(true);
    } else {
      loaded = await tryLoad(false); // auto — GPU if available
      if (!loaded) {
        // The model can load onto a small/integrated GPU yet leave no room for
        // the KV-cache (every context size OOMs). CPU uses full system RAM, so
        // retry once there before giving up.
        status('GPU out of memory; retrying on CPU (slower) …');
        loaded = await tryLoad(true);
      }
    }
    if (!loaded) throw new Error('could not create a model context (out of memory?) — even on CPU');
    model = loaded.m;
    const context = loaded.ctx;

    // Expose the CE tools as chat functions backed by handleTool. #276: gate
    // every call through the tool budget and neutralize special tokens in
    // results — investigator-class models (Qwen3.5) otherwise accumulate
    // results until the context overflows, which crashes natively here.
    const { maxTokens: cappedMaxTokens, toolBudgetChars } = localBudgets(contextSize, maxTokens);
    const budget = makeToolBudget({ maxCalls: 24, maxChars: toolBudgetChars });
    const byName = new Map(TOOLS.map(t => [t.name, t]));
    const functions = {};
    for (const name of TOOL_NAMES) {
      const def = byName.get(name);
      if (!def) continue;
      functions[name] = defineChatSessionFunction({
        description: String(def.description || '').slice(0, 280),
        params: (def.inputSchema && def.inputSchema.properties) ? def.inputSchema : { type: 'object', properties: {} },
        handler: (args) => {
          const stop = budget.gate();
          if (stop) {
            if (budget.calls === 25 || budget.chars > toolBudgetChars) status(`budget-stop after ${budget.calls - 1} calls (${budget.chars} result chars)`);
            return stop;
          }
          status(`tool ${name}(${JSON.stringify(args || {}).slice(0, 120)})`);
          let out;
          try { out = String(handleTool(name, args || {})); }
          catch (e) { out = `Error calling ${name}: ${e.message}`; }
          const capped = neutralizeSpecialTokens(out.slice(0, MAX_TOOL_OUTPUT), `${name} result`, status);
          budget.charge(capped.length);
          return capped;
        },
      });
    }

    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    // #276: local engines get the forceful-grounding clause, and Gemma gets
    // the strict-framing header (its wrapper drops system turns; the family
    // fabricates tool results without explicit insistence).
    const wrapperName = session.chatWrapper && session.chatWrapper.wrapperName;
    const promptText = strictInstructionsFor(wrapperName, aiOverviewPrompt(grounding, { localEngine: true }));

    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`local AI overview timed out (${Math.round(timeoutMs / 60000)} min)`)), timeoutMs);
      if (timer.unref) timer.unref();
    });

    let raw;
    let rescued = false;
    try {
      // onStream surfaces the live model output (incl. <think> blocks and tool
      // reasoning) for testing; the final stdout prose still strips <think>.
      raw = await Promise.race([
        session.prompt(promptText, { functions, maxTokens: cappedMaxTokens, onTextChunk: onStream ? (c) => onStream(c) : undefined }),
        timeout,
      ]);
      // Some local models end the turn after the tool phase without writing an
      // answer: `raw` comes back "" though every tool call succeeded and the
      // budget is nowhere near spent (Gemma 3 12B Q4_K_M, 107-file index: 12
      // calls, 21480/48200 chars used, raw.length 0, reproducible 6/6 — while
      // the same model on a 75-file index answers after 10). Claude and Gemini
      // both write prose from that same index in 7 calls, so it is a model-side
      // end-of-turn quirk, not a prompt or index fault. The session still holds
      // every tool result, so re-prompt once with tools withheld, reusing the
      // budget stop's own synthesize-now wording.
      //
      // INSIDE the raced block deliberately: clearTimeout fires in the finally
      // below, so a retry placed after it would run with NO timeout at all —
      // and this path has been observed blocking the event loop for ~640s.
      // Capped well under cappedMaxTokens because an overview needs hundreds of
      // tokens (observed rescues: ~520) and a shorter generation is a shorter
      // synchronous block, which is the suspected stall mechanism.
      if (needsSynthesizeRetry(raw, budget.calls)) {
        status(`empty final turn after ${budget.calls} tool calls — re-prompting to synthesize`);
        try {
          raw = await Promise.race([
            session.prompt(SYNTHESIZE_NOW_PROMPT, {
              maxTokens: Math.min(cappedMaxTokens, SYNTHESIZE_RETRY_MAX_TOKENS),
              onTextChunk: onStream ? (c) => onStream(c) : undefined,
            }),
            timeout,
          ]);
          rescued = !!String(raw || '').trim();
        } catch (e) { status(`synthesize retry failed: ${e.message}`); }
      }
    } finally {
      clearTimeout(timer);
    }

    const toolCalls = budget.calls; // attempts (incl. budget-stopped), same as the server path
    // Strip any chain-of-thought block (Qwen3 etc. emit <think>…</think>).
    let prose = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // #276 fabrication guard: 0 tool calls in grounded mode = not an overview.
    const warn = ungroundedWarning(toolCalls, grounding);
    if (warn && prose) prose = `${warn}\n\n${prose}`;
    // Say so when the prose came from the rescue pass. Without this a rescued
    // overview is indistinguishable from a healthy one, and the model defect
    // becomes invisible the moment the workaround lands — the workaround would
    // then quietly mask the very thing that justifies replacing the model.
    if (rescued && prose) prose = `${rescuedNote(toolCalls)}\n\n${prose}`;
    // Output token count from the model's own tokenizer (air-gapped: no $ to
    // report, just tokens). Best-effort — null if the tokenizer isn't reachable.
    let outTokens = null;
    try { if (prose && typeof model.tokenize === 'function') outTokens = model.tokenize(prose).length; } catch { /* */ }
    return { prose, toolCalls, contextSize, outTokens, rescued };
  } finally {
    console.log = _log; console.warn = _warn; console.error = _err;
    // Do NOT dispose the model here (upstream node-llama-cpp #623). Gemma's
    // dispose path aborts during native teardown, and because this `finally`
    // runs BEFORE the return value reaches the caller, the abort killed
    // index.js before it could write the prose — a complete overview on stderr
    // with empty stdout. It surfaced on Windows/Blackwell as
    // `CUDA error: invalid resource handle` in ggml_backend_cuda_synchronize
    // and was misdiagnosed as a CUDA-runtime ABI mismatch; the same crash was
    // recorded on Linux/RTX-4090 as a teardown segfault (#276, 07-18 pod
    // batch), so it is neither CUDA- nor platform-specific.
    //
    // This is the standing convention everywhere else in CE — claim.js:1200,
    // analyze.js:267, server.js:1105-1109 all refuse to dispose for the same
    // reason; this path was simply missed. The only caller exits immediately
    // after writing, so native memory is reclaimed at process exit anyway.
  }
}
