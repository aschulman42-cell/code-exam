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
