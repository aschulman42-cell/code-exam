// test_ai_ml_self_detect.js — AI/ML detectors: a pattern-table line is not a framework instance (#227)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_ai_ml_self_detect.js — #227.
 *
 * AI/ML marker detectors must not report a *pattern definition* (a regex
 * literal or its co-located label, as found in a detector / linter / scanner /
 * test fixture) as a real *instance* of the framework it names. A regex that
 * matches CLIP is not an instance of CLIP.
 *
 * The fix blanks lines carrying a `\b`-flanked regex literal before the marker
 * scan (CodeSearchIndex._AIMLMethods._scanLines). These tests pin both halves:
 * the false positive is suppressed, and real usage on an ordinary line is still
 * detected (guarding against a false negative).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

// Build an index over synthetic in-memory files (mirrors test_explainability.js).
function indexOf(files) {
  const idx = new CodeSearchIndex({ indexPath: '.__test_self_detect_noindex__' });
  idx.fileLines = new Map(Object.entries(files).map(([p, src]) => [p, src.split('\n')]));
  return idx;
}
const mentions = (rows, word) => rows.filter(r => new RegExp(`\\b${word}\\b`).test(JSON.stringify(r)));

describe('#227 — chains/agents detector does not self-detect its pattern table', () => {
  it('a marker-table definition line is NOT a chain site', () => {
    // Byte-for-byte the shape of ai-ml-detectors.js's own table.
    const rows = indexOf({
      'detectors.js': "      { re: /\\bLLMChain\\b/, kind: 'chain', fw: 'LangChain', m: 'LLMChain' },",
    }).listChains();
    assert.equal(mentions(rows, 'LLMChain').length, 0,
      'pattern-definition line must not be a chain site: ' + JSON.stringify(rows));
  });

  it('real LLMChain usage on an ordinary line is STILL detected (no false negative)', () => {
    const rows = indexOf({
      'app.py': 'from langchain.chains import LLMChain\nchain = LLMChain(llm=llm, prompt=p)',
    }).listChains();
    assert.ok(mentions(rows, 'LLMChain').length > 0,
      'real LLMChain usage must still be detected: ' + JSON.stringify(rows));
  });
});

describe('#227 — inference detector does not self-detect its pattern table', () => {
  it('a marker-table definition line is NOT an inference site', () => {
    const rows = indexOf({
      'detectors.js': "      { re: /\\bmax_new_tokens\\b/, fam: 'HF', m: 'max_new_tokens' },",
    }).listInference();
    assert.equal(mentions(rows, 'max_new_tokens').length, 0,
      'pattern-definition line must not be an inference site: ' + JSON.stringify(rows));
  });

  it('real generation usage on an ordinary line is STILL detected', () => {
    // listInference gates on the file actually importing an ML library (so a
    // bare mention isn't counted). The #227 fix also stops ai-ml-detectors.js
    // from faking that gate via its own `import torch`-shaped regex patterns.
    const rows = indexOf({
      'gen.py': 'import torch\nfrom transformers import AutoModelForCausalLM\nout = model.generate(ids, max_new_tokens=50, do_sample=True)',
    }).listInference();
    assert.ok(mentions(rows, 'max_new_tokens').length > 0,
      'real generation usage must still be detected: ' + JSON.stringify(rows));
  });
});

describe('embeddings detector: local runtimes, named models, and a marker inside a message', () => {
  const emb = (files) => indexOf(files).listEmbeddings();
  const kinds = (rows) => rows.map((r) => `${r.kind}|${r.framework}|${r.marker}`);

  it('finds a node-llama-cpp embedding context and the call that embeds', () => {
    const rows = emb({ 'embed.js': [
      "import { getLlama } from 'node-llama-cpp';",
      'const ctx = await model.createEmbeddingContext({ contextSize: 2048 });',
      'const e = await ctx.getEmbeddingFor(prefix + text);',
    ].join('\n') });
    assert.deepEqual(kinds(rows), ['embedding|node-llama-cpp|createEmbeddingContext', 'embedding|node-llama-cpp|getEmbeddingFor']);
  });
  it('finds llama.cpp and llama-cpp-python embedding calls', () => {
    const rows = emb({ 'a.cpp': 'const float * e = llama_get_embeddings_seq(ctx, 0);', 'b.py': 'out = llm.create_embedding("hello")' });
    assert.deepEqual(rows.map((r) => r.framework), ['llama.cpp', 'llama.cpp']);
  });
  it('finds an Ollama or OpenAI-compatible embedding endpoint, which is a string by nature', () => {
    const rows = emb({ 'c.js': "const r = await fetch(base + '/api/embeddings', { method: 'POST' });\nconst q = await fetch(`${base}/v1/embeddings`, opts);\nconst v = await ollama.embed({ model: 'nomic-embed-text', input });" });
    assert.deepEqual(rows.map((r) => r.framework), ['Ollama', 'Ollama', 'OpenAI-compatible']);
    assert.ok(rows.every((r) => r.kind === 'embedding'));
  });
  it('lists an embedding model named by file or id, with the name as its id', () => {
    const rows = emb({ 'models.js': [
      "  nomic: { file: 'nomic-embed-text-v1.5.Q8_0.gguf', query: 'search_query: ' },",
      "  jina: { file: 'jina-embeddings-v2-base-code-q8_0.gguf' },",
      '  other = "BAAI/bge-small-en-v1.5"',
      "  const chat = 'llama-3.1-8b-instruct.gguf';",
    ].join('\n') });
    assert.deepEqual(rows.map((r) => r.id), ['nomic-embed-text-v1.5.Q8_0.gguf', 'jina-embeddings-v2-base-code-q8_0.gguf', 'BAAI/bge-small-en-v1.5']);
    assert.ok(rows.every((r) => r.kind === 'embedding' && r.marker === 'embedding-model'));
  });
  it('does not take a marker word inside a help line or a message for a site', () => {
    const rows = emb({ 'help.js': [
      "console.log('No embeddings/vector search found (no OpenAIEmbeddings/SentenceTransformer/'",
      "  + 'embed_query, FAISS/Chroma/Pinecone/VectorStore, similarity_search, text-splitters, or '",
      "  --embeddings               Embeddings & vector search (FAISS/Chroma, similarity_search, distance)",
    ].join('\n'), 'fixture.js': "const grounded = [{ file: 'x/embeddings.py', func: 'embed_documents' }];" });
    // The fixture's 'embed_documents' is a whole string, a name used as a value, and stays; prose does not.
    assert.deepEqual(kinds(rows), ['embedding|LangChain|embed_documents', 'vector-store|FAISS|FAISS'], JSON.stringify(rows));
  });
  it('still finds the same markers used as code', () => {
    const rows = emb({ 'app.py': 'from langchain_openai import OpenAIEmbeddings\nemb = OpenAIEmbeddings(model="text-embedding-3-small")\ndb = FAISS.from_documents(docs, emb)\nhits = db.similarity_search(q)' });
    assert.deepEqual(rows.map((r) => r.marker).sort(), ['FAISS', 'OpenAIEmbeddings', 'OpenAIEmbeddings', 'similarity_search']);
    assert.equal(rows.find((r) => r.marker === 'OpenAIEmbeddings' && r.id).id, 'text-embedding-3-small');
  });
  it('does not take a string search with a regex for a vector search', () => {
    const rows = emb({ 's.js': "class VectorStore {}\nconst stop = rest.search(/_end|## /);\nconst hits = store.search(queryVector, 5);" });
    assert.deepEqual(rows.filter((r) => r.kind === 'search').map((r) => r.line), [3]);
  });
});

describe('local runtimes in the other AI/ML cells', () => {
  const ix = (files) => indexOf(files);
  const L = (...lines) => lines.join('\n');

  it('Inference: the llama.cpp C API that generates and samples', () => {
    const rows = ix({ 'run.cpp': L(
      '#include "llama.h"',
      'if (llama_decode(ctx, batch) != 0) return 1;',
      'llama_sampler * smpl = llama_sampler_chain_init(sparams);',
      'const llama_token id = llama_sampler_sample(smpl, ctx, -1);',
      'int n = other.generate(x);',
    ) }).listInference();
    assert.deepEqual(rows.map((r) => `${r.family}|${r.marker}|${r.line}`), ['llama.cpp|llama_decode|2', 'llama.cpp|llama_sampler|3', 'llama.cpp|llama_sampler|4']);
  });
  it('Inference: MLX and ctranslate2 generation, in a file that imports them', () => {
    const mlx = ix({ 'm.py': L('from mlx_lm import load, generate', 'model, tok = load("mlx-community/Mistral-7B-4bit")', 'text = generate(model, tok, prompt=p)') }).listInference();
    assert.deepEqual(mlx.map((r) => `${r.family}|${r.marker}|${r.line}`).sort(), ['MLX|mlx_lm.generate|3', 'MLX|mlx_lm.load|2']);
    assert.equal(mlx.find((r) => r.marker === 'mlx_lm.load').id, 'mlx-community/Mistral-7B-4bit');
    const ct = ix({ 'c.py': L('import ctranslate2', 'gen = ctranslate2.Generator("ct2-model", device="cpu")', 'out = gen.generate_batch([tokens])') }).listInference();
    assert.deepEqual(ct.map((r) => `${r.family}|${r.line}`).sort(), ['ctranslate2|2', 'ctranslate2|3']);
    const none = ix({ 'x.py': L('def generate(a, b):', '    return load(a)') }).listInference();
    assert.equal(none.length, 0, 'generate( and load( mean nothing without the import');
  });
  it('Artifacts: the llama.cpp call that loads a model file', () => {
    const rows = ix({ 'load.cpp': 'llama_model * model = llama_model_load_from_file("models/q.gguf", mparams);' }).listArtifacts();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].family, 'llama.cpp');
    assert.equal(rows[0].direction, 'load');
    assert.equal(rows[0].path, 'models/q.gguf');
  });
  it('LLM Calls: where node-llama-cpp is asked, not only where the session is made', () => {
    const rows = ix({ 'chat.js': L(
      "import { getLlama, LlamaChatSession } from 'node-llama-cpp';",
      'const session = new LlamaChatSession({ contextSequence });',
      'const response = await session.prompt(combinedPrompt, { maxTokens });',
      'const meta = await session.promptWithMeta(q);',
    ), 'cli.js': L("import inquirer from 'inquirer';", 'const { name } = await inquirer.prompt([{ type: "input" }]);') }).listLlmCalls();
    assert.deepEqual(rows.filter((r) => r.marker === 'session.prompt').map((r) => `${r.filepath}:${r.line}`), ['chat.js:3', 'chat.js:4']);
    assert.ok(rows.every((r) => r.filepath !== 'cli.js'), 'inquirer.prompt is not an LLM call');
    assert.ok(rows.filter((r) => r.marker === 'session.prompt').every((r) => r.provider === 'local'));
  });
  it('LLM Calls: llama.cpp chat templating, and LM Studio by client or by its port in a file that names it', () => {
    const rows = ix({
      't.cpp': 'const int res = llama_chat_apply_template(tmpl.c_str(), chat, 1, true, nullptr, 0);',
      'lm.ts': L("import { LMStudioClient } from '@lmstudio/sdk';", 'const client = new LMStudioClient();'),
      'cfg.js': L('// LM Studio default', "const base = 'http://localhost:1234/v1';"),
      'dev.js': "const dev = 'http://localhost:1234/app';",
      'msg.js': "throw new Error('You cannot create a local LMStudioClient in a plugin context.');",
    }).listLlmCalls();
    const at = rows.map((r) => `${r.provider}|${r.filepath}:${r.line}`).sort();
    assert.deepEqual(at, ['LM Studio|cfg.js:2', 'LM Studio|lm.ts:1', 'LM Studio|lm.ts:2', 'local|t.cpp:1']);
  });
  it('Structured Output: grammar-constrained output', () => {
    const rows = ix({ 'g.js': L(
      "import { getLlama } from 'node-llama-cpp';",
      'const grammar = await llama.createGrammarForJsonSchema(schema);',
      'const g2 = new LlamaJsonSchemaGrammar(llama, schema);',
    ), 'p.py': L('from llama_cpp import Llama, LlamaGrammar', 'g = LlamaGrammar.from_json_schema(json.dumps(schema))') }).listStructuredOutput();
    assert.deepEqual(rows.map((r) => `${r.kind}|${r.filepath}:${r.line}`).sort(), ['constrained|g.js:2', 'constrained|g.js:3', 'constrained|p.py:1', 'constrained|p.py:2']);
  });
  it('Embeddings: a reranker is a search site', () => {
    const rows = ix({ 'r.py': L(
      'from sentence_transformers import CrossEncoder',
      'model = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")',
      'results = self._client.rerank(query=q, documents=docs)',
    ), 'n.js': 'const ctx = await model.createRankingContext();' }).listEmbeddings();
    assert.deepEqual(rows.filter((r) => r.kind === 'search').map((r) => `${r.framework}|${r.filepath}:${r.line}`).sort(), ['rerank|n.js:1', 'rerank|r.py:1', 'rerank|r.py:2', 'rerank|r.py:3']);
  });
  it('Models Used: a weights file carries its family when the name or the folder says it', () => {
    const rows = ix({ 'voice.js': L(
      'const engines = { whisper: {',
      '  modelPath: "~/.local/share/whisper-models/ggml-small.en.bin",',
      '} };',
      'const other = "models/custom-weights.gguf";',
      'const direct = "ggml-base.bin";',
    ) }).listModelsUsed();
    const by = Object.fromEntries(rows.map((r) => [r.model, r.family || null]));
    assert.equal(by['ggml-small.en.bin'], 'Whisper');
    assert.equal(by['ggml-base.bin'], 'Whisper');
    assert.equal(by['custom-weights.gguf'], null, 'no family is shown where nothing says one');
    assert.deepEqual(ix({ 'voice.js': 'const p = "~/x/whisper-models/ggml-small.en.bin";' }).listModelsUsed('whisper').map((r) => r.model), ['ggml-small.en.bin']);
  });
});
