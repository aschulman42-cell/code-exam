// build-claim-genre-df.mjs — builds the content-word document-frequency JSON for the genericity score
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// build-claim-genre-df.mjs -- content-word document frequencies over claim corpora, for the element
// genericity score (src/core/claim-genericity.js). The corpora are NOT in the repo; this script names
// them, and the JSON it writes records their sizes and the build date, so a rebuild is a script run.
//
//   node scripts/build-claim-genre-df.mjs [--ai-ml <candidates.jsonl>] [--litigated <claims-only.txt>]
//                                         [--out src/core/claim-genre-df.json] [--min-df 3]
//
// Defaults are the 2026-08-28 build inputs: the AI/ML candidate corpus (AIPD 2023 predict93 x patbert
// claim texts, 54,398 claim 1s) and the 385 litigated big-tech software claim 1s from
// litigated-claims-fetch.mjs. Words are `contentWords()` from claim-terms.js -- the same tokenizer and
// STOP list the ballpark scores with -- so "generic" here means generic AFTER claim boilerplate is gone.
import fs from 'node:fs';
import { contentWords } from '../src/core/claim-terms.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const AI = opt('--ai-ml', 'C:/work/work_11525/ml/ai_ml_claims/ai_ml_candidates.ballpark.jsonl');
const LIT = opt('--litigated', 'litig_claims_gp/litigated_claim1.txt');
const OUT = opt('--out', 'src/core/claim-genre-df.json');
const MIN_DF = Number(opt('--min-df', '3'));

function readJsonlClaims(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l)).map((r) => (r.claim1 && r.claim1.text) || r.text || '').filter(Boolean);
}
function readClaimsOnly(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}
function df(texts, minDf) {
  const m = new Map();
  for (const t of texts) for (const w of new Set(contentWords(t))) m.set(w, (m.get(w) || 0) + 1);
  const kept = {};
  for (const [w, c] of [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) if (c >= minDf) kept[w] = c;
  return { docs: texts.length, vocabulary: m.size, minDf, df: kept };
}

const profiles = {};
if (fs.existsSync(AI)) { profiles['ai-ml'] = { source: 'AIPD 2023 predict93 x patbert claim 1s (2013-2017)', ...df(readJsonlClaims(AI), MIN_DF) }; }
else console.error(`ai-ml corpus not found: ${AI} (skipped)`);
if (fs.existsSync(LIT)) { profiles.litigated = { source: 'litigated big-tech software claim 1s, litigated-claims-fetch.mjs', ...df(readClaimsOnly(LIT), Math.min(MIN_DF, 2)) }; }
else console.error(`litigated corpus not found: ${LIT} (skipped)`);
if (!Object.keys(profiles).length) { console.error('no corpora; nothing written'); process.exit(2); }

const out = { builtAt: new Date().toISOString().slice(0, 10), note: 'content-word document frequencies over claim corpora; see scripts/build-claim-genre-df.mjs', profiles };
fs.writeFileSync(OUT, JSON.stringify(out));
for (const [k, p] of Object.entries(profiles)) console.error(`${k}: ${p.docs} claims, ${p.vocabulary} content words, ${Object.keys(p.df).length} kept at df >= ${p.minDf}`);
console.error(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
