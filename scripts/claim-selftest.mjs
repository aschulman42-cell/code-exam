// claim-selftest.mjs — score CE's claim retrieval against hand-curated anchors,
// with no GPU, no API key and no network.
//
// WHY THIS EXISTS. Every retrieval decision made in #307 rests on one
// measurement: Andrew's hand-written pseudo-claim for multisect, run against
// .CE_080426, scored on ce_anchors.lst claim 1's five anchors. It is the only
// claim-retrieval regression target that is free, deterministic and
// ground-truthed — and it is what REFUTED IDF weighting before a line of it was
// written, by showing four of five anchors sit below any whole-claim quorum.
//
// Until now those numbers came from throwaway scripts rewritten each time, and
// that cost real accuracy: asus-CC's figures and mine needed reconciling twice
// (file rank 98 vs "absent", a CLI-display artifact; and a six-term rank-1 result
// still unreproduced). Two agents measuring the same thing with different ad-hoc
// code is how that happens. This is the shared instrument.
//
// IT CALLS THE PRODUCTION PATH. parseMultisectTerms -> index.multisectSearch ->
// the same livePositiveTerms / claimNeighbourhoodN the claim-analyze ladder uses.
// A harness that reimplements what it measures only tests itself.
//
// Dev-side only, not wired into the ce CLI — same precedent as rank-eval.mjs and
// overview-eval.mjs: an unstable metric stays out of the shipping command.
//
// Usage:
//   node scripts/claim-selftest.mjs
//   node scripts/claim-selftest.mjs --index-path .CE_080426 --claim <file> --gt <anchors.lst>
//   node scripts/claim-selftest.mjs --neighbourhood 0        # pre-ladder baseline
//   node scripts/claim-selftest.mjs --terms 'a;/b|c/;d'      # skip extraction entirely
//
// RECORDED BASELINE (.CE_080426, the default terms, 2026-08-11, at a351ba9):
//   multisectSearch=12  matchIdfScore=14  computeIdfScores=16
//   parseMultisectTerms=ABSENT  computeTermFileCounts=ABSENT
//   With --neighbourhood 0 (pre-ladder): multisectSearch=20, other four ABSENT.
// A change that does not move these is not working, whatever it does on '101.

import fs from 'node:fs';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { parseMultisectTerms } from '../src/commands/multisect.js';
import { livePositiveTerms, claimNeighbourhoodN } from '../src/commands/analyze.js';

// Andrew's hand-written pseudo-claim for multisect, reduced to search terms.
// These are TERMS, not the claim prose: extraction needs an LLM, and the point of
// this harness is to measure retrieval with the model held constant. Override
// with --terms to score a different extraction.
const DEFAULT_TERMS =
  'intersection;/term|terms/;/synonym/;scope;function;class;file;folder;/rank|ranked/;/uniq/;/match/';

// ce_anchors.lst claim 1 — "smallest-scope multi-term intersection search".
const DEFAULT_GT = ['parseMultisectTerms', 'multisectSearch', 'computeTermFileCounts',
  'computeIdfScores', 'matchIdfScore'];

function parseArgv(argv) {
  const o = { indexPath: '.CE_080426', terms: DEFAULT_TERMS, gt: DEFAULT_GT, minFrac: 0.60, neighbourhood: null };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--index-path': case '--index': o.indexPath = next(); break;
      case '--terms': o.terms = next(); break;
      case '--min-frac': o.minFrac = Number(next()); break;
      case '--neighbourhood': case '--neighborhood': o.neighbourhood = Number(next()); break;
      case '--gt': o.gtFile = next(); break;
      case '--gt-claim': o.gtClaim = Number(next()); break;
      case '--claim': o.claimFile = next(); break;   // recorded in output, not parsed
      default: break;
    }
  }
  return o;
}

// An anchors .lst holds EVERY claim's anchors — ce_anchors.lst is 8 claims and
// 39 anchors — so scoring ONE claim against the whole file gives a denominator
// that reads as failure (3/39 rather than 3/5). `--gt-claim N` selects the
// `# Claim N — …` section; without it the whole file is used, which is right
// only for a single-claim file.
function loadGt(file, claimN) {
  const out = [];
  let inSection = claimN === undefined;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      if (claimN !== undefined) {
        const m = l.match(/Claim\s+(\d+)/i);
        if (m) inSection = Number(m[1]) === claimN;
      }
      continue;
    }
    if (inSection) out.push(l.split('@').pop().replace(/^.*::/, ''));
  }
  return out.filter(Boolean);
}

const o = parseArgv(process.argv.slice(2));
if (o.gtFile) {
  o.gt = loadGt(o.gtFile, o.gtClaim);
  if (!o.gt.length) {
    console.error(`No anchors read from ${o.gtFile}${o.gtClaim ? ` for claim ${o.gtClaim}` : ''}.`);
    process.exit(1);
  }
}
const idx = new CodeSearchIndex({ indexPath: o.indexPath });
const terms = parseMultisectTerms(o.terms);
if (!terms) { console.error('Could not parse --terms (an invalid regex rejects the whole set).'); process.exit(1); }
const positives = terms.filter((t) => !t.negated);

// Stage 1 — the unrestricted search, exactly as claim-analyze issues it.
const minTerms = Math.max(Math.floor(positives.length * o.minFrac), 3);
const r0 = idx.multisectSearch(terms, { minTerms });
const asFuncs = (r) => ((r && r.function_matches) || []).filter((f) => f.function !== '(global)' && f.lines > 0);

// Stage 2 — the scope ladder, unless --neighbourhood 0 asks for the pre-ladder view.
const hoodN = o.neighbourhood === null ? claimNeighbourhoodN({}) : o.neighbourhood;
let funcs = asFuncs(r0);
let hoodMin = null;
if (hoodN > 0 && (r0.file_matches || []).length > 1) {
  const hood = r0.file_matches.slice(0, hoodN).map((f) => f.filepath);
  hoodMin = Math.max(2, Math.floor(livePositiveTerms(idx, positives) * 0.60) - 1);
  const hoodFuncs = asFuncs(idx.multisectSearch(terms, { minTerms: hoodMin, includePath: hood }));
  if (hoodFuncs.length) funcs = hoodFuncs;
}

// WHY an anchor is missing matters more than THAT it is missing: four of the five
// were never candidates, which is what showed the problem is not ranking. So
// report each anchor's own term coverage against the quorum it had to clear.
idx._ensureFunctionIndex?.();

// Coverage for ONE (filepath, name) pair.
const coverageAt = (filepath, name) => {
  const info = (idx.functionIndex[filepath] || {})[name];
  if (!info) return null;
  const body = (idx.fileLines.get(filepath) || []).slice(info.start - 1, info.end).join('\n');
  let hit = 0;
  for (const t of positives) { try { if (t.regex && t.regex.test(body)) hit++; } catch { /* skip */ } }
  return { lines: info.end - info.start + 1, hit };
};

// A bare name can occur in several files, and the FIRST match is not necessarily
// the one meant — the first cut of this script reported `multisectSearch` as
// 1 line / 0 terms while it was simultaneously ranked 12th, because it had picked
// a same-named entry elsewhere. So:
//   - anchor FOUND in the results -> use that exact match, which is authoritative
//   - anchor ABSENT -> take the BEST-covering same-named function, so
//     "below quorum" is the conservative claim rather than an artifact of
//     which duplicate happened to be first.
const coverageOf = (name, foundMatch) => {
  if (foundMatch) return coverageAt(foundMatch.filepath, foundMatch.function);
  const ms = idx.findFunctionMatches(name, null) || [];
  let best = null;
  for (const m of ms) {
    const c = coverageAt(m.filepath, m.name);
    if (c && (!best || c.hit > best.hit)) best = { ...c, ambiguous: ms.length > 1 };
  }
  return best;
};

const rows = o.gt.map((g) => {
  const i = funcs.findIndex((f) => f.function.includes(g));
  return { name: g, rank: i < 0 ? null : i + 1, cov: coverageOf(g, i < 0 ? null : funcs[i]) };
});

const W = Math.max(...o.gt.map((g) => g.length));
console.log(`index      ${o.indexPath}${o.claimFile ? `   claim ${o.claimFile}` : ''}`);
console.log(`terms      ${positives.length} positive   stage-1 quorum ${minTerms}`
  + (hoodMin === null ? '   ladder OFF' : `   ladder top-${hoodN} @ quorum ${hoodMin}`));
console.log(`candidates ${funcs.length} function(s)   files ${(r0.file_matches || []).length}`);
console.log();
console.log(`${'anchor'.padEnd(W)}  rank   lines  terms  note`);
for (const r of rows) {
  const cov = r.cov ? `${String(r.cov.lines).padStart(5)}  ${String(r.cov.hit).padStart(2)}/${positives.length}` : '    ?    ?  ';
  // An anchor below the quorum could not be a candidate at all — no ranking
  // change can surface it, and that distinction is the whole finding.
  let note = '';
  if (!r.rank) {
    note = (r.cov && r.cov.hit < (hoodMin ?? minTerms)) ? 'below quorum — NOT A CANDIDATE' : 'absent';
    if (r.cov && r.cov.ambiguous) note += ' (best of several same-named)';
  }
  console.log(`${r.name.padEnd(W)}  ${(r.rank ? String(r.rank) : '-').padStart(4)}  ${cov}  ${note}`);
}
const found = rows.filter((r) => r.rank).length;
const best = rows.filter((r) => r.rank).map((r) => r.rank).sort((a, b) => a - b)[0];
console.log();
// One pasteable line, so two agents can compare numbers without comparing code.
console.log(`SELFTEST ${o.indexPath} ladder=${hoodMin === null ? 'off' : hoodN} `
  + `found=${found}/${rows.length} best=${best ?? '-'} `
  + rows.map((r) => `${r.name}=${r.rank ?? '-'}`).join(' '));
