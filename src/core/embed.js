// embed.js — the local embedding substrate: a text per mechanism entry, its chunks, the model registry with each model's retrieval prefixes, the checkpointed vector cache, and cosine
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// embed-distance-cli (2026-11-07). Lifted from scripts/describe-reach.mjs without
// change of behaviour, so that --embed-distance (src/commands/embed-distance.js)
// and the measurement script score a mechanism entry the same way: the entry's
// label and member names split to words, embedded in chunks of N names each led
// by the label, the entry scored by its best chunk; vectors cached as JSON keyed
// by the text's hash and written every CACHE_CHECKPOINT embeddings. The script
// imports from here and re-exports what its test holds.
//
// Everything runs through node-llama-cpp's embedding context: no network, no
// key, the CPU is enough. Raw cosines are not comparable across models; each
// has its own baseline, which is why the listings print the median.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MODELS_DIR = path.join(ROOT, 'models');

// ---- the registry ------------------------------------------------------------

/**
 * Short names for the embedding models the measurements used, with the prefixes
 * each expects on a query and on a document (its retrieval convention) and the
 * file under models/. Only nomic ships with CodeExam; the others are downloads,
 * named here so a run can be repeated with one word.
 */
export const EMBED_MODELS = {
  nomic: { file: 'nomic-embed-text-v1.5.Q8_0.gguf', query: 'search_query: ', doc: 'search_document: ', source: 'https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF' },
  jina: { file: 'jina-embeddings-v2-base-code-q8_0.gguf', query: '', doc: '', source: 'https://huggingface.co/ggml-org/jina-embeddings-v2-base-code-Q8_0-GGUF' },
  coderank: { file: 'coderankembed-q8_0.gguf', query: 'Represent this query for searching relevant code: ', doc: '', source: 'https://huggingface.co/ineersa/CodeRankEmbed-Q8_0-GGUF' },
  qwen06: { file: 'Qwen3-Embedding-0.6B-Q8_0.gguf', query: 'Instruct: Given a patent claim limitation, retrieve the source code mechanism that implements it\nQuery:', doc: '', source: 'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF' },
  qwen4: { file: 'Qwen3-Embedding-4B-Q8_0.gguf', query: 'Instruct: Given a patent claim limitation, retrieve the source code mechanism that implements it\nQuery:', doc: '', source: 'https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF' },
};
export const DEFAULT_EMBED_MODEL = 'nomic';

/**
 * A short name or a path to any .gguf -> { name, path, base, query, doc }. A path
 * gets no prefixes (unless its base name says nomic, whose prefixes are known).
 * Throws with the path and the download source when a named model's file is absent.
 */
export function resolveEmbedModel(nameOrPath = DEFAULT_EMBED_MODEL, { modelsDir = MODELS_DIR } = {}) {
  const spec = EMBED_MODELS[nameOrPath];
  if (spec) {
    const p = path.join(modelsDir, spec.file);
    if (!fs.existsSync(p)) throw new Error(`embedding model "${nameOrPath}" is not installed: expected ${p}; download it from ${spec.source}, or pass --embed-model <path.gguf>`);
    return { name: nameOrPath, path: p, base: spec.file.replace(/\.gguf$/i, ''), query: spec.query, doc: spec.doc };
  }
  const p = path.resolve(nameOrPath);
  if (!/\.gguf$/i.test(p)) throw new Error(`--embed-model takes one of ${Object.keys(EMBED_MODELS).join(', ')} or a path to a .gguf file; got "${nameOrPath}"`);
  if (!fs.existsSync(p)) throw new Error(`embedding model not found: ${p}`);
  const base = path.basename(p).replace(/\.gguf$/i, '');
  const nomic = /nomic-embed-text/i.test(base);
  return { name: base, path: p, base, query: nomic ? 'search_query: ' : '', doc: nomic ? 'search_document: ' : '' };
}

// ---- the text per entry --------------------------------------------------------

// A text longer than the embedding context fails the call (a giant entry's
// member list on WinAPI did, 2026-11-05); every text is cut here, well under the
// context the embedder opens below. A description never reaches it, a purpose or
// a member list can.
export const TEXT_MAX_CHARS = 1500;
export const cut = (s) => (s.length > TEXT_MAX_CHARS ? s.slice(0, TEXT_MAX_CHARS) : s);

/** An identifier as words: camel, snake, ::, . split, the way the symbol searches split it. */
export function splitName(name) {
  return String(name || '').replace(/[:.]+/g, ' ').replace(/[_\-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

/** The text embedded per entry under `mode`, with `kind` saying which text answered (the description, else the purpose, else the label and members). */
export function entryText(e, mode) {
  const d = String(e.description || '').trim();
  const p = String(e.purpose || '').trim();
  const lm = `${e.label}: ${(e.members || []).map((m) => splitName(m.name)).join(', ')}`;
  const r = (text, kind) => ({ text: cut(text), kind });
  if (mode === 'description') return d ? r(d, 'description') : p ? r(p, 'purpose') : r(lm, 'label');
  if (mode === 'description+purpose') return r([d, p].filter(Boolean).join(' ') || lm, d ? 'description' : p ? 'purpose' : 'label');
  if (mode === 'purpose') return p ? r(p, 'purpose') : r(lm, 'label');
  return r(lm, 'label');
}

/**
 * The chunks of an entry's text: the label-and-members text as runs of `n` member
 * names, each led by the label, so an entry of 400 functions is 50 short texts and
 * not one 1,500-character cut; any other text kind (a description, a purpose) is
 * its own single chunk. `n` of 0 means one chunk, the whole text. Every chunk is
 * cut like a whole text would be.
 */
export function entryChunks(e, mode, n) {
  const t = entryText(e, mode);
  if (t.kind !== 'label' || !n) return [t.text];
  const names = (e.members || []).map((m) => splitName(m.name));
  const out = [];
  for (let c = 0; c * n < Math.max(names.length, 1); c++) out.push(cut(`${e.label}: ${names.slice(c * n, (c + 1) * n).join(', ')}`));
  return out;
}

// ---- vectors ---------------------------------------------------------------------

export const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);
export const normalize = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return Array.from(v, (x) => x / n); };
export const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export const median = (xs) => { const a = [...xs].sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/** The cache is written after this many fresh embeddings, and at the end. */
export const CACHE_CHECKPOINT = 500;
/** Vectors wider than this are stored as base64 float32, not JSON arrays (a 2,560-dim model's 15,000 vectors as arrays overflowed V8's string limit on the Asus, 2026-11-07). */
export const COMPACT_ABOVE_DIMS = 1024;

const encodeVec = (v) => (v.length > COMPACT_ABOVE_DIMS ? { b: Buffer.from(new Float32Array(v).buffer).toString('base64') } : { v });
const decodeVec = (item) => (Array.isArray(item.v) ? item.v : typeof item.b === 'string' ? Array.from(new Float32Array(new Uint8Array(Buffer.from(item.b, 'base64')).buffer)) : null);

export function readCache(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && j.items ? j : { items: {} }; } catch { return { items: {} }; }
}

/**
 * Embed `texts` (array of { key, text }) with the cache at `file`; returns a Map
 * key -> unit vector, and reports { fresh, cached } through `stats` when given.
 * `ctx` is anything with getEmbeddingFor(text) -> { vector }. Written every
 * CACHE_CHECKPOINT fresh embeddings, so a stop keeps what ran.
 */
export async function embedAll(ctx, texts, file, { prefix = '', label = '', quiet = false, stats = null } = {}) {
  const cache = file ? readCache(file) : { items: {} };
  const out = new Map();
  let fresh = 0;
  const t0 = Date.now();
  const save = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ format: 'ce-describe-reach-vectors', generated: new Date().toISOString(), items: cache.items }));
  };
  for (const { key, text } of texts) {
    const h = sha(prefix + text);
    const hit = cache.items[key];
    const hv = hit && hit.h === h ? decodeVec(hit) : null;
    if (hv) { out.set(key, hv); continue; }
    const e = await ctx.getEmbeddingFor(prefix + text);
    const v = normalize([...e.vector]);
    cache.items[key] = { h, ...encodeVec(v) };
    out.set(key, v);
    fresh++;
    if (fresh % CACHE_CHECKPOINT === 0) save();
    if (!quiet && fresh % 100 === 0) process.stderr.write(`  ${label}: ${fresh.toLocaleString('en-US')} embedded…\n`);
  }
  if (fresh % CACHE_CHECKPOINT) save();
  if (stats) { stats.fresh = fresh; stats.cached = texts.length - fresh; stats.seconds = (Date.now() - t0) / 1000; }
  if (!quiet) process.stderr.write(`  ${label}: ${texts.length.toLocaleString('en-US')} texts, ${fresh.toLocaleString('en-US')} embedded, ${(texts.length - fresh).toLocaleString('en-US')} from cache, ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
  return out;
}

/** The embedding context for a GGUF, through the pinned engine; dispose() releases the model. */
export async function openEmbedder(modelPath, { cpu = false } = {}) {
  const { getLlamaShared } = await import('./llm-runner.js');
  const llama = await getLlamaShared({ cpu });
  const model = await llama.loadModel({ modelPath });
  // 2048 tokens holds any text TEXT_MAX_CHARS allows, identifiers included.
  const ctx = await model.createEmbeddingContext({ contextSize: 2048 });
  return { ctx, dispose: async () => { await ctx.dispose(); await model.dispose(); } };
}
