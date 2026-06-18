// Coverage for #169: LLM-Prompt detector precision on minified bundles —
// reject code/markup/identifier-list false positives, and dedup the same prompt
// duplicated across webpack chunks. Real prompts (prose, even with an embedded
// code snippet) must survive.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { _looksLikeNonPrompt, collectPrompts } from '../src/commands/prompts.js';

test('#169: keeps real prompts (prose, incl. prose-with-a-snippet)', () => {
  for (const t of [
    'You are an assistant that can retrieve Wikipedia articles.',
    'Tool call returned undefined. This is not expected as the model always expects a result. If you don\'t want to return anything, just return a string reporting success. For example: "operation successful." In this case we give the model "${x}".',
    'You cannot create a local LMStudioClient in a plugin context. To use LM Studio APIs, use the "client" property attached to the Controllers. For example, instead of: ${a} Do this: ${b}.',
  ]) {
    assert.equal(_looksLikeNonPrompt(t), false, 'should KEEP: ' + t.slice(0, 50));
  }
});

test('#169: rejects code / markup / identifier-list false positives', () => {
  const idList = Array(40).fill('abs acos sin cos tan').join(' '); // >200 chars, all short tokens
  for (const t of [
    'if __name__ == "__main__":\n    chat_loop()',
    '<svg width="120" height="90" viewBox="0 0 48 48"><path d="M38 20C37 19"/></svg>',
    'window.parent.postMessage({type:"_edit_mode_chat", text:x}, "*");',
    '}}}}var ofH=2(.)(.)(.)/,nfi=function(a,b){return a(b)};for(;;){a++}',
    idList,
  ]) {
    assert.equal(_looksLikeNonPrompt(t), true, 'should REJECT: ' + t.slice(0, 50));
  }
});

test('#169: dedup collapses the same prompt duplicated across files', async () => {
  const SRC = path.join(os.tmpdir(), 'ce_prompts_src');
  const IDX = path.join(os.tmpdir(), 'ce_prompts_idx');
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  const PROMPT = 'You are a helpful TLS assistant. Answer questions about certificates and handshakes.';
  // Distinct surrounding code per file (so the indexer doesn't dedup identical
  // files) but the SAME prompt text — mimics a bundler copying one module into
  // multiple chunks.
  ['chunkA.js', 'chunkB.js', 'chunkC.js'].forEach((f, i) => {
    fs.writeFileSync(path.join(SRC, f),
      `const filler${i} = ${i};\nfunction helper${i}() { return ${i}; }\nconst systemPrompt = ${JSON.stringify(PROMPT)};\n`);
  });
  const index = new CodeSearchIndex({ indexPath: IDX });
  await index.buildIndex(SRC, { showProgress: false });

  const prompts = await collectPrompts(index, {});
  const matches = prompts.filter(p => p.text.includes('helpful TLS assistant'));
  assert.equal(matches.length, 1, 'the prompt duplicated across 3 files should appear once: ' +
    JSON.stringify(matches.map(m => m.filepath)));
  assert.ok(matches[0].dupLocations && matches[0].dupLocations.length === 2,
    'the canonical entry should record the 2 other locations: ' + JSON.stringify(matches[0].dupLocations));
});
