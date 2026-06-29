// ─────────────────────────────────────────────────────────────────────────────
// Hunch™ — Overfit Labs' post-hoc rationalization engine.
// SYNTHETIC DEMO CODE shipped with CodeExam's first-run index. Not a real
// product; never run by CodeExam. Written by Claude (Anthropic) for the CodeExam
// demo, to exercise the AI/ML detectors on honest, real-marker usage.
//
// This is a real hand-rolled agent: a loop over an LLM call that dispatches
// tools and feeds results back. CodeExam's --chains flags exactly this shape.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from '@anthropic-ai/sdk';
import { TOOLS } from './tools.js';
import { SYSTEM_PROMPT, EXPLAIN_PROMPT } from './prompts.js';

const client = new Anthropic();
const MODEL = 'claude-sonnet-4-6';

// Assess a subject: the model commits to a verdict, then the agent rationalizes
// it by calling tools until the explanation is sufficiently confident.
export async function runHunch(question) {
  const messages = [{ role: 'user', content: question }];

  for (let turn = 0; turn < 6; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason !== 'tool_use') {
      return response.content.map((b) => b.text || '').join('');
    }

    messages.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const out = await dispatchTool(block.name, block.input);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: out });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  return '(Hunch is still very confident, but ran out of turns.)';
}

// Tool dispatch — the "call + dispatch + loop" the hand-rolled-agent detector keys on.
async function dispatchTool(name, input) {
  switch (name) {
    case 'fetch_features':
      return JSON.stringify(await fetchFeatures(input.id));
    case 'run_model':
      return JSON.stringify(await runModel(input.features));
    case 'explain':
      return await explain(input.verdict, input.features);
    default:
      return `Unknown tool: ${name}`;
  }
}

async function fetchFeatures(id) {
  // A demo stub: in the "product" this hits the feature warehouse.
  return { id, vector: Array.from({ length: 64 }, (_, i) => (i % 7) / 7) };
}

async function runModel(features) {
  // Calls into the Python service (model/pipeline.py) over RPC in the "product".
  return { verdict: 'AI-washing', confidence: 0.99 };
}

// Second LLM call: turn a verdict into a convincing story after the fact.
async function explain(verdict, features) {
  const prompt = EXPLAIN_PROMPT.replace('{verdict}', verdict)
    .replace('{confidence}', '0.99')
    .replace('{features}', JSON.stringify(features));
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content.map((b) => b.text || '').join('');
}
