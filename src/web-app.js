#!/usr/bin/env node
/**
 * web-app.js — Chat web app: Claude + MCP CodeExam tools.
 *
 * Spawns mcp-server.js as a subprocess, connects via MCP protocol,
 * exposes a chat API that lets Claude call CodeExam tools.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node src/web-app.js --index-path .test_ndx
 *   ANTHROPIC_API_KEY=sk-... node src/web-app.js --index-path .test_ndx --port 3000
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ========================================================================
// Parse args
// ========================================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { indexPath: '.test_ndx', port: 3000 };
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--index-path' || args[i] === '--index') && args[i + 1]) {
      result.indexPath = args[++i];
    }
    if (args[i] === '--port' && args[i + 1]) {
      result.port = parseInt(args[++i], 10);
    }
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
// Claude API — the swappable LLM layer
// ========================================================================

const anthropic = new Anthropic();  // reads ANTHROPIC_API_KEY from env

const SYSTEM_PROMPT = `You are a code analysis assistant. You have access to CodeExam tools that let you search, analyze, and explore indexed codebases. Use the tools to answer the user's questions about code. Be concise and direct.`;

async function chatWithLLM(messages, tools) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages,
    tools,
  });
  return response;
}

// ========================================================================
// Chat loop — handles tool calls
// ========================================================================

async function handleChat(messages) {
  const allBlocks = [];  // collect all content blocks for the response
  let currentMessages = [...messages];

  for (let iteration = 0; iteration < 20; iteration++) {
    const response = await chatWithLLM(currentMessages, anthropicTools);

    // Collect this response's content blocks
    allBlocks.push(...response.content);

    // If no tool use, we're done
    if (response.stop_reason !== 'tool_use') {
      break;
    }

    // Process tool calls
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResults = [];
    const toolResultMap = {};  // tool_use id → result text

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

    // Annotate allBlocks for the UI (separate from what we send to Claude)
    for (const block of allBlocks) {
      if (block.type === 'tool_use' && toolResultMap[block.id] !== undefined) {
        block._result = toolResultMap[block.id];
      }
    }

    // Append clean (unannotated) copy of assistant content + tool results for next iteration
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

// List available tools
app.get('/api/tools', (req, res) => {
  res.json(mcpTools);
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
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable required');
    process.exit(1);
  }

  console.log(`Connecting to MCP server (index: ${config.indexPath})...`);
  await initMCP();

  app.listen(config.port, () => {
    console.log(`Web app: http://localhost:${config.port}/chat.html`);
  });
}

main().catch(err => {
  console.error('Startup error:', err);
  process.exit(1);
});
