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
 * (service.js). The new piece is the multi-turn function-calling loop, which
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
export async function runAiOverviewLocal({ indexPath, modelPath, contextSize = 16384, maxTokens = 2400, timeoutMs = 1200000, gpu = 'auto', grounding, onStatus, onStream } = {}) {
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

    // Expose the CE tools as chat functions backed by handleTool.
    const byName = new Map(TOOLS.map(t => [t.name, t]));
    let toolCalls = 0;
    const functions = {};
    for (const name of TOOL_NAMES) {
      const def = byName.get(name);
      if (!def) continue;
      functions[name] = defineChatSessionFunction({
        description: String(def.description || '').slice(0, 280),
        params: (def.inputSchema && def.inputSchema.properties) ? def.inputSchema : { type: 'object', properties: {} },
        handler: (args) => {
          toolCalls++;
          status(`tool ${name}(${JSON.stringify(args || {}).slice(0, 120)})`);
          try { return String(handleTool(name, args || {})).slice(0, MAX_TOOL_OUTPUT); }
          catch (e) { return `Error calling ${name}: ${e.message}`; }
        },
      });
    }

    const session = new LlamaChatSession({ contextSequence: context.getSequence() });

    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`local AI overview timed out (${Math.round(timeoutMs / 60000)} min)`)), timeoutMs);
      if (timer.unref) timer.unref();
    });

    let raw;
    try {
      // onStream surfaces the live model output (incl. <think> blocks and tool
      // reasoning) for testing; the final stdout prose still strips <think>.
      raw = await Promise.race([
        session.prompt(aiOverviewPrompt(grounding), { functions, maxTokens, onTextChunk: onStream ? (c) => onStream(c) : undefined }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }

    // Strip any chain-of-thought block (Qwen3 etc. emit <think>…</think>).
    const prose = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Output token count from the model's own tokenizer (air-gapped: no $ to
    // report, just tokens). Best-effort — null if the tokenizer isn't reachable.
    let outTokens = null;
    try { if (prose && typeof model.tokenize === 'function') outTokens = model.tokenize(prose).length; } catch { /* */ }
    return { prose, toolCalls, contextSize, outTokens };
  } finally {
    console.log = _log; console.warn = _warn; console.error = _err;
    try { if (model) await model.dispose(); } catch { /* */ }
  }
}
