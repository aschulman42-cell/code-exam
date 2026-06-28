// #196: unit coverage for the SDK-based AI Overview (runAiOverview ported off
// the `claude` CLI). The live agentic cloud call is verified manually (needs an
// API key + network); here we cover the deterministic, key-free pieces: the
// tool allow-list, the bare/prefixed tool-name normalization used to filter the
// MCP tool list, and grounding-clause selection.

import { test } from 'node:test';
import assert from 'node:assert';
import {
  AI_OVERVIEW_TOOL_NAMES, AI_OVERVIEW_TOOLS, aiOverviewPrompt,
  AI_OVERVIEW_GROUNDING_CLAUSES,
} from '../src/core/ai-overview.js';

test('AI_OVERVIEW_TOOLS is the prefixed, comma-joined form of the names', () => {
  assert.ok(Array.isArray(AI_OVERVIEW_TOOL_NAMES));
  assert.ok(AI_OVERVIEW_TOOL_NAMES.includes('overview'));
  const expected = AI_OVERVIEW_TOOL_NAMES.map(n => `mcp__code-exam__${n}`).join(',');
  assert.strictEqual(AI_OVERVIEW_TOOLS, expected);
  assert.ok(!AI_OVERVIEW_TOOLS.includes(' '), 'comma-joined, no spaces');
});

test('tool-name normalization maps bare + prefixed forms to the allowed set', () => {
  // Mirrors the filter inside runAiOverview: allowed.has(name.split('__').pop()).
  const allowed = new Set(AI_OVERVIEW_TOOL_NAMES);
  const bare = (name) => String(name).split('__').pop();
  for (const n of AI_OVERVIEW_TOOL_NAMES) {
    assert.ok(allowed.has(bare(n)), `bare ${n} kept`);
    assert.ok(allowed.has(bare(`mcp__code-exam__${n}`)), `prefixed ${n} kept`);
  }
  // A tool outside the allow-list is filtered out, prefixed or not.
  assert.ok(!allowed.has(bare('mcp__code-exam__delete_everything')));
  assert.ok(!allowed.has(bare('write_file')));
});

test('aiOverviewPrompt embeds the prompt + the selected grounding clause', () => {
  const grounded = aiOverviewPrompt('grounded');
  assert.ok(grounded.includes('orienting a code examiner'), 'includes the base prompt');
  assert.ok(grounded.includes(AI_OVERVIEW_GROUNDING_CLAUSES.grounded));
  assert.ok(aiOverviewPrompt('augmented').includes(AI_OVERVIEW_GROUNDING_CLAUSES.augmented));
  assert.ok(aiOverviewPrompt('attributed').includes(AI_OVERVIEW_GROUNDING_CLAUSES.attributed));
  // Unknown / undefined grounding falls back to 'grounded' (forensic default).
  assert.ok(aiOverviewPrompt('bogus').includes(AI_OVERVIEW_GROUNDING_CLAUSES.grounded));
  assert.ok(aiOverviewPrompt(undefined).includes(AI_OVERVIEW_GROUNDING_CLAUSES.grounded));
});
