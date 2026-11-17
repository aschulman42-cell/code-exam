#!/usr/bin/env node
// claim-evidence-map.mjs — deterministic, provisional claim evidence map prototype
// Copyright (c) 2026 Andrew Schulman
// Codex (GPT-5.6-Luna medium) contribution.
//
// This is an R&D report generator, not a claim-chart verdict engine. It uses local
// embeddings and index data only. A later local-GGUF reader may classify the short
// candidate bundles; this first prototype deliberately does not call an LLM.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  resolveEmbedModels, resolveQueries, embedCacheFile, rankCandidates, rankFused,
  functionTexts, listingStats, CHUNK,
} from '../src/commands/embed-distance.js';
import { resolveEmbedModel, openEmbedder, embedAll, entryChunks, entryText, cut } from '../src/core/embed.js';
import { loadMechanismsIndex, foldRecords } from '../src/core/mechanisms-index.js';
import { buildCorpus, FUSE_ARM, FUSE_LABEL_WEIGHT } from '../src/core/function-text.js';

export function parseArgs(argv) {
  const o = { index: null, claim: null, model: null, top: 12, cpu: false, functionText: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} takes a value`); return argv[++i]; };
    if (a === '--ndx' || a === '--index') o.index = next();
    else if (a === '--claim') o.claim = next();
    else if (a === '--embed-model') o.model = next();
    else if (a === '--top') o.top = Math.max(1, parseInt(next(), 10) || 12);
    else if (a === '--cpu') o.cpu = true;
    else if (a === '--function-text') o.functionText = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help && (!o.index || !o.claim)) throw new Error('usage: node codex-tests/claim-evidence-map.mjs --ndx <index> --claim @<claim.txt> [--embed-model nomic] [--top N] [--function-text] [--cpu]');
  return o;
}

const STOPWORDS = new Set('a an and are as at be based by each for from in including into is it of on one or that the their them then to was with which'.split(' '));
const tokenise = (s) => [...new Set((String(s || '').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).filter((t) => !STOPWORDS.has(t)))];

export function lexicalEvidence(query, candidate) {
  const q = new Set(tokenise(query));
  const text = [candidate.label, candidate.text, ...(candidate.members || []).map((m) => m.name || '')].join(' ').toLowerCase();
  const hits = [...q].filter((t) => text.includes(t));
  return { hits, count: hits.length };
}

/** Keep the embedding head, then add a small lexical head without changing the embedding rank. */
export function mergeCandidates(ranked, query, top = 12, lexicalTop = 6) {
  const lexical = ranked
    .map((x) => ({ x, lexical: lexicalEvidence(query, x) }))
    .filter((x) => x.lexical.count)
    .sort((a, b) => b.lexical.count - a.lexical.count || a.x.rank - b.x.rank)
    .slice(0, lexicalTop);
  const picked = new Map();
  for (const x of ranked.slice(0, top)) picked.set(x.entry?.id ?? x.label ?? x.rank, { ...x, source: 'embedding' });
  for (const { x } of lexical) {
    const key = x.entry?.id ?? x.label ?? x.rank;
    if (!picked.has(key)) picked.set(key, { ...x, source: 'lexical-name' });
    else picked.get(key).source = 'embedding + lexical-name';
  }
  return [...picked.values()].map((x) => ({
    ...x,
    lexical: lexicalEvidence(query, x),
  })).sort((a, b) => a.rank - b.rank);
}

const shortPath = (s) => String(s || '').split('!').pop().replace(/\\/g, '/');

export function renderEvidenceMap({ index, claimSource, model, functionText, elements, reports, top }) {
  const out = [
    '# Provisional claim evidence map',
    '',
    '> R&D output only. These are ranked candidates, not claim-chart verdicts or legal conclusions.',
    '> `NOT_SHOWN` is not inferred here: absence requires a separate reviewed assessment.',
    '',
    `- Claim: ${claimSource}`,
    `- Index: ${index}`,
    `- Embedding model: ${model}`,
    `- Candidate budget: top ${top} embedding entries plus up to 6 lexical-name additions per element`,
    `- Function text: ${functionText ? 'enabled' : 'not enabled'}`,
    '',
    '## Elements',
    '',
  ];
  reports.forEach((r, i) => {
    const { med, margin, word } = r.stats;
    out.push(`### Element ${i + 1}`,'',r.element,'');
    out.push(`- Evidence candidates: ${r.candidates.length}`);
    out.push(`- Median cosine: ${med.toFixed(4)}; nearest margin: ${margin.toFixed(4)}${word ? ` (${word})` : ''}`);
    out.push('- No verdict is assigned by this deterministic report. Read the candidates before classifying the element.','');
    r.candidates.forEach((c, n) => {
      const label = c.label || c.text || '(unnamed entry)';
      const members = (c.members || []).slice(0, 8).map((m) => `${shortPath(m.file || m.filepath)}@${m.name || m.full_name || '(member)'}`);
      out.push(`${n + 1}. **${label}** — embedding rank ${c.rank}, cosine ${c.cos.toFixed(4)}, source ${c.source}`);
      const lexical = c.lexical || lexicalEvidence(r.element, c);
      out.push(`   - lexical-name hits: ${lexical.hits.length ? lexical.hits.join(', ') : 'none'}`);
      if (members.length) out.push(`   - members: ${members.join('; ')}${(c.members || []).length > members.length ? `; +${c.members.length - members.length} more` : ''}`);
      if (c.fnShort) out.push(`   - function-text witness: ${c.fnShort}`);
    });
    out.push('');
  });
  out.push('## Interpretation', '',
    'This report is the retrieval layer only. A future local-GGUF step may read these short bundles and propose `SUPPORTED`, `PARTIAL`, `ARCHITECTURAL_MISMATCH`, or `NOT_SHOWN`; that step is intentionally absent from this prototype.', '');
  return out.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { console.log('usage: node codex-tests/claim-evidence-map.mjs --ndx <index> --claim @<claim.txt> [--embed-model nomic] [--top N] [--function-text] [--cpu]'); return; }
  const { queries, source } = resolveQueries(o.claim);
  const indexPath = path.resolve(o.index);
  const data = loadMechanismsIndex({ indexPath }, { cache: false });
  if (!data?.records?.length) throw new Error(`${o.index} has no mechanisms.json`);
  const entries = foldRecords(data.records);
  const model = resolveEmbedModels(o.model || undefined, { modelsDir: process.env.CODEX_MODELS_DIR })[0];
  const embedder = await openEmbedder(model.path, { cpu: o.cpu });
  try {
    const prefix = model.query;
    const qvs = await embedAll(embedder.ctx, queries.map((q, i) => ({ key: `q${i}`, text: q })), null, { prefix, quiet: true });
    const texts = entries.map((e) => entryText(e, 'label+members').text);
    const chunks = entries.map((e) => entryChunks(e, 'label+members', CHUNK));
    const whole = await embedAll(embedder.ctx, entries.map((e, i) => ({ key: `${e.id}:${i}`, text: texts[i] })), embedCacheFile(indexPath, model.base, 'label+members'), { prefix: model.doc, quiet: true });
    const extra = [];
    chunks.forEach((cs, i) => cs.forEach((t, c) => { if (t !== texts[i]) extra.push({ key: `${entries[i].id}:${i}:${c}`, text: t }); }));
    const more = extra.length ? await embedAll(embedder.ctx, extra, embedCacheFile(indexPath, model.base, `label+members_chunks${CHUNK}`), { prefix: model.doc, quiet: true }) : new Map();
    const cands = entries.map((e, i) => ({ text: texts[i], label: e.label, members: e.members || [], entry: e, chunks: chunks[i], vectors: chunks[i].map((t, c) => t === texts[i] ? whole.get(`${e.id}:${i}`) : more.get(`${e.id}:${i}:${c}`)) }));
    let fnVecs = null, fnPlan = null;
    if (o.functionText) {
      const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
      const old = console.log; console.log = () => {};
      let idx; try { idx = new CodeSearchIndex({ indexPath }); if (idx._ensureFunctionIndex) idx._ensureFunctionIndex(); } finally { console.log = old; }
      fnPlan = functionTexts(entries, buildCorpus(idx.functionIndex || {}, (f) => idx.fileLines.get(f)));
      const vectors = await embedAll(embedder.ctx, fnPlan.texts, embedCacheFile(indexPath, model.base, `function-text-${FUSE_ARM}`), { prefix: model.doc, quiet: true });
      fnVecs = vectors;
      cands.forEach((c, i) => { c.fnIds = fnPlan.ids[i]; });
    }
    const reports = queries.map((element, i) => {
      const ranked = fnVecs ? rankFused(qvs.get(`q${i}`), cands, fnVecs, FUSE_LABEL_WEIGHT, fnPlan.short) : rankCandidates(qvs.get(`q${i}`), cands);
      return { element, stats: listingStats(ranked, { calibrated: !fnVecs }), candidates: mergeCandidates(ranked, element, o.top) };
    });
    console.log(renderEvidenceMap({ index: o.index, claimSource: source || o.claim, model: model.name || model.base, functionText: o.functionText, elements: queries, reports, top: o.top }));
  } finally { await embedder.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error(`claim-evidence-map: ${e.message}`); process.exit(1); });
