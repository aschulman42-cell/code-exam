#!/usr/bin/env node
// concept-toc.mjs — deterministic concept/TOC feasibility experiment
// Copyright (c) 2026 Andrew Schulman
// Codex (GPT-5.6-Luna medium) contribution.
//
// This is a retrieval/menu experiment, not a claim-chart or legal-verdict engine.
// It uses index data, lexical overlap, and optional local embeddings only.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMechanismsIndex, foldRecords } from '../src/core/mechanisms-index.js';
import { resolveEmbedModels, resolveQueries, embedCacheFile } from '../src/commands/embed-distance.js';
import { resolveEmbedModel, openEmbedder, embedAll, cut, entryText } from '../src/core/embed.js';

const STOP = new Set('about after again also and are based between by each from have into more most other over such than that their these this those through using were which with class file java src main test builder factory util default data device configuration sink write bundle playback state media androidx'.split(' '));

export function splitConceptWords(value) {
  return String(value || '')
    .replace(/[:./\\@#$()[\]{}<>+,;=]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [];
}

export function conceptTokens(value) {
  return [...new Set(splitConceptWords(value).filter((x) => !STOP.has(x)))];
}

function conceptEntryText(entry) {
  // Vocabulary lanes come from names and descriptions. Paths and call unions
  // remain evidence on a card, but must not make every card a path/call card.
  return [entry.label, entry.description, entry.purpose,
    ...(entry.members || []).map((m) => m.name)].filter(Boolean).join(' ');
}

/** Keep embedding input small while leaving the complete card available to render. */
export function compactCardText(term, entries, files = [], calls = []) {
  const parts = [`concept ${term}`];
  for (const entry of entries || []) {
    const members = (entry.members || []).slice(0, 4).map((m) => `${m.file || ''}@${m.name || ''}`).join(', ');
    parts.push(`${entry.label || ''}${members ? `: ${members}` : ''}`);
  }
  if (files.length) parts.push(`files: ${files.slice(0, 12).join(', ')}`);
  if (calls.length) parts.push(`calls: ${calls.slice(0, 12).join(', ')}`);
  return cut(parts.filter(Boolean).join(' | ').replace(/\s+/g, ' ')).slice(0, 1200);
}

/** Build one compact concept card per distinctive vocabulary term. */
export function buildConceptCards(entries, { maxCards = 240, minEntries = 1, maxEntries = 500 } = {}) {
  const buckets = new Map();
  for (const entry of entries || []) {
    for (const term of conceptTokens(conceptEntryText(entry))) {
      const b = buckets.get(term) || { term, entries: [], files: new Set(), calls: new Set() };
      if (!b.entries.some((e) => e.id === entry.id)) b.entries.push(entry);
      for (const f of entry.files || []) b.files.add(f);
      for (const c of entry.calls || []) b.calls.add(c);
      buckets.set(term, b);
    }
  }
  return [...buckets.values()]
    .filter((b) => b.entries.length >= minEntries)
    .sort((a, b) => b.entries.length - a.entries.length || a.term.localeCompare(b.term))
    .slice(0, maxCards)
    .map((b, i) => ({
      id: `concept:${b.term}`,
      level: 'concept',
      label: b.term,
      terms: [b.term],
      entries: b.entries,
      files: [...b.files].sort(),
      calls: [...b.calls].sort(),
      text: compactCardText(b.term, b.entries.slice(0, maxEntries), [...b.files].sort(), [...b.calls].sort()),
      order: i,
    }));
}

export function buildConceptHierarchy(cards) {
  return (cards || []).map((card) => ({
    ...card,
    levels: {
      concept: { label: card.label },
      mechanisms: card.entries.map((e) => ({ id: e.id, label: e.label, kind: e.kind })),
      members: card.entries.flatMap((e) => (e.members || []).map((m) => ({ file: m.file, name: m.name }))),
    },
  }));
}

function lexicalScore(query, card) {
  const q = new Set(conceptTokens(query));
  const label = new Set(conceptTokens(card.label));
  const text = new Set(conceptTokens(card.text));
  const labelHits = [...q].filter((t) => label.has(t));
  const hits = [...q].filter((t) => text.has(t));
  // A term naming the lane is stronger evidence than a term inherited from
  // every entry in that lane (for example the file extension `java`).
  return { hits, score: q.size ? ((labelHits.length * 2) + hits.length) / (q.size * 3) : 0 };
}

function entryLexicalScore(query, term, entry) {
  const q = new Set(conceptTokens(query));
  const label = new Set(conceptTokens(`${entry.label} ${(entry.members || []).map((m) => m.name).join(' ')}`));
  const direct = label.has(term) ? 1 : 0;
  const hits = [...q].filter((t) => label.has(t)).length;
  return direct * 10 + hits;
}

function tokenMatches(a, b) { return a === b || a.includes(b) || b.includes(a); }

/** Direct symbol/member lane: do not require a vocabulary card to rank highly. */
export function rankDirectEntries(entries, query, { queryVector = null, vectors = null, limit = 8 } = {}) {
  const q = conceptTokens(query);
  return (entries || []).map((entry) => {
    const terms = conceptTokens(`${entry.label} ${(entry.members || []).map((m) => m.name).join(' ')}`);
    const hits = q.filter((qt) => terms.some((t) => tokenMatches(t, qt)));
    const lexical = q.length ? hits.length / q.length : 0;
    const embedding = queryVector && vectors ? cosine(queryVector, vectors.get(entry.id)) : null;
    const score = embedding == null ? lexical : (embedding * 0.7) + (lexical * 0.3);
    return { entry, score, embedding, lexicalHits: [...new Set(hits)] };
  }).sort((a, b) => b.score - a.score || String(a.entry.label).localeCompare(String(b.entry.label)))
    .slice(0, limit).map((x, i) => ({ ...x, rank: i + 1 }));
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : null;
}

/** Rank a concept menu; vectors is a Map keyed by card id and is optional for unit tests. */
export function rankConceptCards(cards, query, { queryVector = null, vectors = null, limit = 12 } = {}) {
  const ranked = (cards || []).map((card) => {
    const lexical = lexicalScore(query, card);
    const embedding = queryVector && vectors ? cosine(queryVector, vectors.get(card.id)) : null;
    const score = embedding == null ? lexical.score : (embedding * 0.7) + (lexical.score * 0.3);
    const evidenceEntries = [...card.entries].sort((a, b) => entryLexicalScore(query, card.label, b) - entryLexicalScore(query, card.label, a) || String(a.label).localeCompare(String(b.label)));
    return { ...card, score, embedding, lexicalHits: lexical.hits, evidenceEntries };
  }).sort((a, b) => b.score - a.score || a.label.localeCompare(b.label) || b.entries.length - a.entries.length || a.order - b.order);
  return ranked.slice(0, limit).map((card, i) => ({ ...card, rank: i + 1 }));
}

const shortPath = (s) => String(s || '').split('!').pop().replace(/\\/g, '/');

export function renderConceptToc({ index, claimSource, model, elements, reports, top, verboseMenu = false }) {
  const out = [
    '# Concept-oriented claim retrieval menu', '',
    '> R&D feasibility output only. This menu exposes related code candidates; it assigns no claim verdicts.',
    '> A concept card is a vocabulary lane, followed by mechanism entries and concrete members/files.', '',
    `- Claim: ${claimSource}`, `- Index: ${index}`, `- Embedding model: ${model}`,
    `- Menu view: ${verboseMenu ? `top ${top} concept cards per claim element` : 'compact: six direct mechanisms and three concept cards per element'}`,
    '- Direct mechanism lane: compact indexed entries ranked independently of concept cards', '', '## Elements', '',
  ];
  for (const [i, report] of reports.entries()) {
    out.push(`### Element ${i + 1}`, '', report.element, '', `- Direct mechanisms: ${report.direct.length}`, '');
    for (const x of report.direct.slice(0, verboseMenu ? report.direct.length : 6)) {
      const e = x.entry;
      const members = (e.members || []).slice(0, 3).map((m) => `${shortPath(m.file)}@${m.name}`).join('; ');
      out.push(`${x.rank}. **${e.label}** — score ${x.score.toFixed(4)}${x.embedding == null ? ' (lexical)' : `; cosine ${x.embedding.toFixed(4)}`}`);
      if (x.lexicalHits.length) out.push(`   - direct symbol/member hits: ${x.lexicalHits.join(', ')}`);
      if (members) out.push(`   - members: ${members}`);
    }
    const shownCards = verboseMenu ? report.cards : report.cards.slice(0, 3);
    out.push('', `- Concept cards: ${shownCards.length}${shownCards.length < report.cards.length ? ` of ${report.cards.length}` : ''}`, '');
    for (const card of shownCards) {
      const score = card.score.toFixed(4);
      out.push(`${card.rank}. **${card.label}** — score ${score}${card.embedding == null ? ' (lexical)' : `; cosine ${card.embedding.toFixed(4)}`}`);
      out.push(`   - levels: concept → ${card.entries.length} mechanism entr${card.entries.length === 1 ? 'y' : 'ies'} → ${card.levels.members.length} members`);
      if (card.lexicalHits.length) out.push(`   - lexical hits: ${card.lexicalHits.join(', ')}`);
      for (const entry of card.evidenceEntries.slice(0, 3)) {
        const members = (entry.members || []).slice(0, 3).map((m) => `${shortPath(m.file)}@${m.name}`).join('; ');
        out.push(`   - mechanism: **${entry.label}**${members ? ` — ${members}` : ''}`);
      }
      if (card.evidenceEntries.length > 3) out.push(`   - +${card.evidenceEntries.length - 3} more mechanisms`);
      if (card.files.length) out.push(`   - files: ${card.files.slice(0, 4).map(shortPath).join(', ')}${card.files.length > 4 ? `; +${card.files.length - 4} more` : ''}`);
      if (card.calls.length) out.push(`   - relationships/calls: ${card.calls.slice(0, 4).join(', ')}${card.calls.length > 4 ? `; +${card.calls.length - 4} more` : ''}`);
    }
    out.push('');
  }
  out.push('## Interpretation', '', 'This report tests whether a compact concept lane can gather distributed code evidence before any claim-element assessment. It is not a support, infringement, or absence determination.', '');
  return out.join('\n');
}

export function parseArgs(argv) {
  const o = { index: null, claim: null, model: null, top: 12, cpu: false, directEmbed: false, verboseMenu: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} takes a value`); return argv[++i]; };
    if (a === '--ndx' || a === '--index') o.index = next();
    else if (a === '--claim') o.claim = next();
    else if (a === '--embed-model') o.model = next();
    else if (a === '--top') o.top = Math.max(1, parseInt(next(), 10) || 12);
    else if (a === '--cpu') o.cpu = true;
    else if (a === '--direct-embed') o.directEmbed = true;
    else if (a === '--verbose-menu') o.verboseMenu = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.help && (!o.index || !o.claim)) throw new Error('usage: node codex-tests/concept-toc.mjs --ndx <index> --claim @<claim.txt> [--embed-model gemma] [--top N] [--cpu] [--direct-embed] [--verbose-menu]');
  return o;
}

async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (o.help) { console.log('usage: node codex-tests/concept-toc.mjs --ndx <index> --claim @<claim.txt> [--embed-model gemma] [--top N] [--cpu] [--direct-embed] [--verbose-menu]'); return; }
  const { queries, source } = resolveQueries(o.claim);
  const indexPath = path.resolve(o.index);
  const data = loadMechanismsIndex({ indexPath }, { cache: false });
  if (!data?.records?.length) throw new Error(`${o.index} has no mechanisms.json`);
  const entries = foldRecords(data.records);
  const cards = buildConceptHierarchy(buildConceptCards(entries));
  const model = resolveEmbedModels(o.model || undefined, { modelsDir: process.env.CODEX_MODELS_DIR })[0];
  const embedder = await openEmbedder(model.path, { cpu: o.cpu });
  try {
    const qvs = await embedAll(embedder.ctx, queries.map((q, i) => ({ key: `q${i}`, text: q })), null, { prefix: model.query, quiet: true });
    // Do not embed the entire index for the direct lane. A lexical/subtoken
    // preselection keeps this experiment usable with a small local model.
    const directPool = [...new Map(queries.flatMap((element) => rankDirectEntries(entries, element, { limit: 200 }).map((x) => [x.entry.id, x.entry]))).values()];
    const entryVectors = o.directEmbed
      ? await embedAll(embedder.ctx, directPool.map((e) => ({ key: e.id, text: entryText(e, 'label+members').text })), embedCacheFile(indexPath, model.base, 'concept-toc-direct'), { prefix: model.doc, quiet: true, compact: true })
      : null;
    const vectors = await embedAll(embedder.ctx, cards.map((c) => ({ key: c.id, text: c.text })), embedCacheFile(indexPath, model.base, 'concept-toc'), { prefix: model.doc, quiet: true, compact: true });
    const reports = queries.map((element, i) => ({ element, direct: rankDirectEntries(directPool, element, { queryVector: qvs.get(`q${i}`), vectors: entryVectors }), cards: rankConceptCards(cards, element, { queryVector: qvs.get(`q${i}`), vectors, limit: o.top }) }));
    console.log(renderConceptToc({ index: o.index, claimSource: source || o.claim, model: model.name || model.base, elements: queries, reports, top: o.top, verboseMenu: o.verboseMenu }));
  } finally { await embedder.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((e) => { console.error(`concept-toc: ${e.message}`); process.exit(1); });
