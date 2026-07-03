#!/usr/bin/env node
/**
 * web-app.js — Chat web app: Claude or local LLM + MCP CodeExam tools.
 *
 * Spawns mcp-server.js as a subprocess, connects via MCP protocol,
 * exposes a chat API that lets the LLM call CodeExam tools.
 *
 * Usage (Claude):
 *   ANTHROPIC_API_KEY=sk-... node src/web-app.js --index-path .test_ndx
 *
 * Usage (local model):
 *   node src/web-app.js --index-path .test_ndx --local-model /path/to/model.gguf
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertLocalOnly, setAirGapped, scrubApiKey, airGappedStartupCheck, AIR_GAPPED_DISCLAIMER } from './core/air-gapped.js';
// Anthropic SDK loaded lazily in chatWithClaude() so --local-model works without API key

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========================================================================
// Parse args
// ========================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { indexPath: '.test_ndx', port: 3000, localModel: null, airGapped: false, allowConnected: false };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--index-path' || args[i] === '--index') && args[i + 1]) {
      result.indexPath = args[++i];
    }
    if (args[i] === '--port' && args[i + 1]) {
      result.port = parseInt(args[++i], 10);
    }
    if ((args[i] === '--local-model' || args[i] === '--model') && args[i + 1]) {
      result.localModel = args[++i];
    }
    // #247: this entry point previously ignored --air-gapped entirely, so its
    // assertLocalOnly guard had nothing to enforce. Honor the flag here too.
    if (args[i].replace(/_/g, '-') === '--air-gapped') result.airGapped = true;
    if (args[i].replace(/_/g, '-') === '--allow-connected') result.allowConnected = true;
  }
  return result;
}

const config = parseArgs();

// ========================================================================
// MCP client — connect to code-exam server as subprocess
// ========================================================================

let mcpClient;
let mcpTools = [];      // MCP format
let anthropicTools = []; // Anthropic API format

async function initMCP() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [path.join(__dirname, 'mcp-server.js'), '--index-path', config.indexPath],
    stderr: 'pipe',
  });

  // Log MCP server stderr
  transport.stderr?.on('data', (data) => {
    process.stderr.write(`[mcp] ${data}`);
  });

  mcpClient = new Client({ name: 'web-app', version: '1.0.0' }, {});
  await mcpClient.connect(transport);

  // Fetch tools
  const result = await mcpClient.listTools();
  mcpTools = result.tools;

  // Convert to Anthropic tool format
  anthropicTools = mcpTools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));

  console.log(`MCP connected: ${mcpTools.length} tools available`);
}

// ========================================================================
// LLM layer — Claude API or local model via node-llama-cpp
// ========================================================================

const SYSTEM_PROMPT = `You are a code analysis assistant. You have access to CodeExam tools that let you search, analyze, and explore indexed codebases. Use the tools to answer the user's questions about code. Be concise and direct.`;

// --- Claude mode ---

let anthropic;

async function chatWithClaude(messages, tools) {
  assertLocalOnly('chat (cloud Claude)'); // #223
  if (!anthropic) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    anthropic = new Anthropic();
  }
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages,
    tools,
  });
  return response;
}

// --- Local model mode ---

let localModel = null;  // { llama, model, context, LlamaChatSession, defineChatSessionFunction }

async function initLocalModel(modelPath) {
  const { getLlama, LlamaChatSession, defineChatSessionFunction } = await import('node-llama-cpp');
  console.log(`Loading local model: ${modelPath}...`);
  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });

  let context = null;
  let contextSize = 0;
  for (const trySize of [8192, 4096, 2048]) {
    try { context = await model.createContext({ contextSize: trySize }); contextSize = trySize; break; }
    catch (_) { /* try smaller */ }
  }
  if (!context) throw new Error('Cannot allocate context (tried 8192/4096/2048)');

  localModel = { llama, model, context, LlamaChatSession, defineChatSessionFunction, contextSize };
  console.log(`Local model loaded (context: ${contextSize} tokens)`);
}

async function chatWithLocalModel(userMessage) {
  const { LlamaChatSession, defineChatSessionFunction, context } = localModel;
  const sequence = context.getSequence();
  const session = new LlamaChatSession({
    contextSequence: sequence,
    systemPrompt: SYSTEM_PROMPT,
  });

  // Build MCP tools as node-llama-cpp functions
  const functions = {};
  const toolCalls = [];  // track calls for UI display

  for (const tool of mcpTools) {
    functions[tool.name] = defineChatSessionFunction({
      description: tool.description,
      params: tool.inputSchema,
      async handler(params) {
        console.log(`  tool: ${tool.name}(${JSON.stringify(params)})`);
        try {
          const result = await mcpClient.callTool({
            name: tool.name,
            arguments: params,
          });
          const text = result.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('\n');
          toolCalls.push({ name: tool.name, input: params, result: text });
          return text;
        } catch (err) {
          const errText = `Error: ${err.message}`;
          toolCalls.push({ name: tool.name, input: params, result: errText });
          return errText;
        }
      },
    });
  }

  try {
    const response = await session.prompt(userMessage, { functions, maxTokens: 2048 });
    session.dispose();
    sequence.dispose();

    // Build content blocks matching the format the UI expects
    const blocks = [];
    for (const tc of toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: tc.name,
        input: tc.input,
        _result: tc.result,
      });
    }
    blocks.push({ type: 'text', text: response });
    return blocks;
  } catch (err) {
    try { session.dispose(); sequence.dispose(); } catch (_) {}
    throw err;
  }
}

// ========================================================================
// Chat loop — handles tool calls (Claude mode with multi-turn tool loop)
// ========================================================================

async function handleChat(messages) {
  // --- Local model mode: session handles tool loop internally ---
  if (config.localModel) {
    const lastMsg = messages[messages.length - 1];
    const userText = typeof lastMsg.content === 'string'
      ? lastMsg.content
      : lastMsg.content.map(b => b.text || '').join('\n');
    return await chatWithLocalModel(userText);
  }

  // --- Claude mode: manual tool loop ---
  const allBlocks = [];
  let currentMessages = [...messages];

  for (let iteration = 0; iteration < 20; iteration++) {
    const response = await chatWithClaude(currentMessages, anthropicTools);

    allBlocks.push(...response.content);

    if (response.stop_reason !== 'tool_use') {
      break;
    }

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];
    const toolResultMap = {};

    for (const toolUse of toolUseBlocks) {
      console.log(`  tool: ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
      try {
        const result = await mcpClient.callTool({
          name: toolUse.name,
          arguments: toolUse.input,
        });
        const text = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('\n');
        toolResultMap[toolUse.id] = text;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: text,
        });
      } catch (err) {
        toolResultMap[toolUse.id] = `Error: ${err.message}`;
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: ${err.message}`,
          is_error: true,
        });
      }
    }

    for (const block of allBlocks) {
      if (block.type === 'tool_use' && toolResultMap[block.id] !== undefined) {
        block._result = toolResultMap[block.id];
      }
    }

    const cleanContent = response.content.map(b => {
      const { _result, ...rest } = b;
      return rest;
    });
    currentMessages = [
      ...currentMessages,
      { role: 'assistant', content: cleanContent },
      { role: 'user', content: toolResults },
    ];
  }

  return allBlocks;
}

// ========================================================================
// Express app
// ========================================================================

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// List available tools + status info
app.get('/api/tools', (req, res) => {
  const modelName = config.localModel
    ? path.basename(config.localModel)
    : 'Claude API';
  res.json({
    tools: mcpTools,
    index: config.indexPath,
    model: modelName,
  });
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }
    console.log(`\nChat: ${messages.length} messages`);
    const content = await handleChat(messages);
    res.json({ content });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========================================================================
// Start
// ========================================================================

async function main() {
  // #223/#247: apply --air-gapped before anything can reach the network. Set the
  // flag, scrub cloud keys, print the disclaimer, refuse a reachable-network run
  // (unless --allow-connected), and require a local model (cloud chat is blocked).
  if (config.airGapped) {
    setAirGapped(true, { allowConnected: config.allowConnected });
    scrubApiKey();
    console.error(AIR_GAPPED_DISCLAIMER);
    const refusal = await airGappedStartupCheck();
    if (refusal) { console.error(`[air-gapped] ${refusal}`); process.exit(2); }
    if (!config.localModel) {
      console.error('Error: --air-gapped blocks cloud AI. Pass --local-model <path> to use a local GGUF model.');
      process.exit(2);
    }
  }
  if (!config.localModel && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY required (or use --local-model <path>)');
    process.exit(1);
  }

  console.log(`Connecting to MCP server (index: ${config.indexPath})...`);
  await initMCP();

  if (config.localModel) {
    await initLocalModel(config.localModel);
    console.log(`Mode: local model`);
  } else {
    console.log(`Mode: Claude API`);
  }

  app.listen(config.port, () => {
    console.log(`Web app: http://localhost:${config.port}/chat.html`);
  });
}

main().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
