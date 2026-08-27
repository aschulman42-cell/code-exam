#!/usr/bin/env node
// claim-ballpark.mjs -- which CE index is in the ballpark of each claim? No model calls.
//
// For each claim: its distinctive words (TF x IDF against a claim background, stem-deduplicated)
// become ONE multi-term intersection search (`--multisect-search` with `--min-terms`), run in-process
// against every index in the list -- each index is loaded once and every claim runs against it, so
// 385 claims x 15 indexes is minutes, not 385 CLI runs that each reload every index. Each (claim,
// index) pair reduces to one row: terms present, functions matching >= min-terms, files, best k-of-N,
// and functions per 10k symbols (raw counts favour big indexes). The top of a claim's ranking is its
// chart candidate; the bottom is a clean negative control (truth ABSENT by construction).
//
// Inputs
//   --claims <file>      a --claims-only file (one claim per line, `#` header lines skipped) or the
//                        litigated-claims-fetch.mjs JSONL (uses `patent` + `claim1.text`)
//   --indexes <list>     @file with one index path per line (the --multi-index form; zips allowed),
//                        or a comma-separated list
//   --idf <claims-file>  background corpus for the rarity weighting (default: the input claims
//                        themselves; a bigger claims-only file gives a steadier IDF)
//   --terms N            distinctive words per claim (default 8)
//   --min-terms N        a function must match at least N of them (default 3). Terms are HARD on
//                        purpose: multisect's min-terms gates on hard positives only, so `?` soft
//                        terms would switch the gate off
//   --max-file-lines N   a file match counts as a neighbourhood only up to N lines (default 2000); a
//   --max-function-lines N   function match up to N (default 300). A 4,556-line RELEASENOTES.md and a
//                        minified bundle each "contain" every term; neither is a place to look. Drops
//                        are counted per row and per index.
//   --include-prose      keep .md/.txt/.html/.json/... file matches (skipped and counted by default)
//   --hit-k N            print a HIT line the moment a (claim, index) row reaches file-level k >= N or
//                        function-level k >= N-1 (default 6 of 8), so good-looking pairs surface while a
//                        long run is still going. The final ranking is unchanged by it.
//   --top K / --bottom K pairs to emit per claim (default 3 / 3)
//   --limit N            first N claims only
//   --out <dir>          default ./ballpark
//   --dry-terms          print each claim's terms and exit (no index is loaded)
// Outputs
//   ballpark.csv         one row per (claim, index)
//   pairs.tsv            claim_id, index, kind (top|bottom), rank, best_k, functions -- ready to drive
//                        a --claim-chart batch or a negative-control run
//   stderr               per-claim top-K / bottom-K as it goes

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { parseMultisectTerms } from '../src/commands/multisect.js';
import { isPseudoSource } from '../src/binstrings.js';

// Claim boilerplate: words that carry no subject matter. Kept deliberately long -- every one of
// these ranked into a claim's top 8 on the 2026-08-27 litigated set before it was listed.
const STOP = new Set((
  'a an the of to in on for and or by with as at is are be from that this each when least one any all into than then its it ' +
  'wherein further comprising claim method system said plurality configured device devices first second third information data ' +
  'receiving received receive response based associated including includes include having processor memory computer computing ' +
  'user users apparatus means step steps thereof whether such being between within during through about after before via more ' +
  'other another where which while comprises comprise operable adapted coupled connected corresponding respective determined ' +
  'determining providing provided provide generating generated generate storing stored store using used use selected selecting ' +
  'selection performing performed perform transmitting transmitted transmit sending sent send signal signals value values set ' +
  'portion portions element elements unit units module modules medium program programs instructions executed executable ' +
  'operation operations process processing content items item object objects number amount type types display displaying ' +
  'displayed request requests application applications software hardware interface input output message messages least ' +
  'non-transitory readable storage causing cause caused least also further whereby thereby therein wherein ' +
  // Code-ubiquitous words. The IDF background is CLAIMS, so a word rare in claims but everywhere in code
  // (`file` is in 88% of ExoPlayer3's files) earns a slot it cannot use; the first 385-claim run spent
  // slots on file / make / source / target / directory / string / list.
  'file files make source sources target targets directory directories string strings list lists name names time ' +
  'default defaults option options config configuration mode modes state states server servers client clients ' +
  'error errors return returns object method function class code path paths index key keys node nodes entry entries ' +
  'field fields record records table tables event events format formats size sizes count counts update updates updated ' +
  'check checks read reads write writes load loads call calls start starts stop stops create creates created delete ' +
  'deletes remove removes removed add adds added get gets put puts open opens close closes enable enables enabled ' +
  'disable disables disabled given make makes text line lines block blocks flag flags result results ' +
  // Function words of 4+ letters. Claims are written in the present tense, so `were` / `been` / `have`
  // are RARE in a claim background and scored as distinctive -- `were` took a slot on US claim 347
  // (a DMA controller) before this was listed.
  'were been have having will would shall should could does done there these those their them they what only some same ' +
  'both either neither ever never once upon over under above below along among across against toward towards without ' +
  'whose whom until unless whereas wherever whenever whether although though because since thus hence therefore'
).split(/\s+/));

// A 3-letter token survives only when the claim writes it in capitals -- `DMA`, `LAN`, `API`, `CRC` --
// i.e. it is an acronym, and for a hardware or network claim usually the most distinctive word in it.
// Two-letter ones (`IO`, `IP`, `OS`) stay out: multisect substring-matches, and `ip` is inside `zip`,
// `chip` and `description`.
const ACRONYM_SKIP = new Set(['AND', 'THE', 'NOT', 'FOR']);
const isAcronym = (raw) => raw.length === 3 && raw === raw.toUpperCase() && /^[A-Z][A-Z0-9]{2}$/.test(raw) && !ACRONYM_SKIP.has(raw);

// Files that are not code: a 4,556-line RELEASENOTES.md held 7 of the Sonos claim's 8 terms and topped
// ExoPlayer3's file-level ranking; a 10 MB minified bundle "contains" every word. Neither is a
// neighbourhood. Skipped by default (--include-prose keeps them) and counted in the row.
const PROSE_RE = /\.(md|markdown|txt|rst|adoc|html?|pdf|csv|tsv|log|json|xml|yaml|yml|lock)$/i;

const tokens = (text) => String(text || '').replace(/[^A-Za-z0-9-]+/g, ' ').split(' ')
  .filter((raw) => raw.length >= 4 || isAcronym(raw))
  .map((raw) => raw.toLowerCase())
  .filter((w) => !STOP.has(w) && !/^[0-9-]+$/.test(w));

// Crude stem so `player`/`players`, `detect`/`detected`/`detecting` do not take two slots --
// multisect already substring-matches, so the shorter form finds the longer.
export const stem = (w) => w.replace(/(ings?|ations?|ation|ed|es|s|ly)$/, '').slice(0, 6);

/** Document frequency over a background corpus of claim texts. */
export function buildDf(texts) {
  const df = new Map();
  for (const t of texts) for (const w of new Set(tokens(t))) df.set(w, (df.get(w) || 0) + 1);
  return { df, n: texts.length };
}

/** The claim's n most distinctive words: TF x IDF, stem-deduplicated, shortest surface form kept. */
export function claimTerms(text, bg, n = 8) {
  const tf = new Map();
  for (const w of tokens(text)) tf.set(w, (tf.get(w) || 0) + 1);
  const scored = [...tf.entries()]
    .map(([w, f]) => [w, f * Math.log((bg.n + 1) / ((bg.df.get(w) || 0) + 1))])
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  const out = [], seen = new Set();
  for (const [w] of scored) { const s = stem(w); if (seen.has(s)) continue; seen.add(s); out.push(w); if (out.length >= n) break; }
  return out;
}

/**
 * One (claim, index) row from a multisectSearch result.
 *
 * A raw "functions matching >= k terms" count is driven by the COMMON terms: on ExoPlayer3 the Sonos
 * claim's `audio` / `playback` / `group` sit in 11-23% of files each, and swapping one common term for
 * a rare one moved the count from 198 to 27 (2026-08-27). So each row also carries an IDF-weighted
 * best match -- the best function's sum of log(files / files-with-term) over its matched terms -- and
 * the number of RARE terms present (under 5% of files). Ranking goes by those first.
 */
export function reduceResult(res, symbols, totalFiles = 0, opts = {}) {
  const { maxFileLines = 2000, maxFunctionLines = 300, codeOnly = true } = opts;
  const counts = res.term_file_counts || [];
  const termsTotal = (res.terms || []).length;
  const termsPresent = counts.filter((c) => c > 0).length;
  const idf = counts.map((c) => (c > 0 && totalFiles > 0 ? Math.log(totalFiles / c) : 0));
  const rareTerms = counts.filter((c) => c > 0 && totalFiles > 0 && c / totalFiles < 0.05).length;
  const best = (matches) => {
    let k = 0, score = 0;
    for (const m of matches) {
      const idxs = m.matched_indices ? [...m.matched_indices] : [];
      k = Math.max(k, idxs.length);
      score = Math.max(score, idxs.reduce((s, i) => s + (idf[i] || 0), 0));
    }
    return { k, score: +score.toFixed(2) };
  };
  // Size bounds: a match is a neighbourhood only if a reader could take it in. Every drop is counted.
  let oversizedFunctions = 0, oversizedFiles = 0, proseFiles = 0, opFunctions = 0;
  const funcs = (res.function_matches || []).filter((m) => {
    if (m.function === '(global)') return false;
    // A binstrings `.op` dump is one pseudo-function holding every string in the binary: it passes
    // the line bound and matches everything. Not a function for k; the FILE stays (a real binary's
    // dump is a legitimate neighbourhood at file level). Measured 2026-08-27: 30 of 39 "strong"
    // .langchain claims had a bin_pycache_* bag as their best function; 23 fell out without them.
    if (isPseudoSource(m.filepath)) { opFunctions++; return false; }
    if (m.lines != null && m.lines > maxFunctionLines) { oversizedFunctions++; return false; }
    return true;
  });
  const files = (res.file_matches || []).filter((m) => {
    if (codeOnly && PROSE_RE.test(m.filepath || '')) { proseFiles++; return false; }
    if (m.lines != null && m.lines > maxFileLines) { oversizedFiles++; return false; }
    return true;
  });
  const fn = best(funcs), fl = best(files);
  const functions = funcs.length;
  return {
    termsPresent, termsTotal, rareTerms, functions, files: files.length,
    bestK: fn.k, bestScore: fn.score,          // function level: what a chart would cite
    fileBestK: fl.k, fileBestScore: fl.score,  // file level: the neighbourhood -- a claim's elements span functions
    oversizedFunctions, oversizedFiles, proseFiles, opFunctions,
    symbols, per10k: symbols > 0 ? +(functions / symbols * 1e4).toFixed(2) : 0,
  };
}

/**
 * Rank rows for one claim: file-level k first, then density, then the rarity scores, then function k.
 *
 * Two questions live here and they pull apart. "Is this index about the claim's subject?" is answered
 * by breadth -- many terms co-occurring in one (size-bounded, non-prose) file, and many functions
 * clearing the min-terms gate. "Is there a specific spot?" is answered by the IDF-weighted scores.
 * An earlier version ranked on the scores first and put ExoPlayer3 LAST for a media-playback claim
 * despite a 6-of-8 file and 1,815 qualifying functions, because IDF-within-the-index penalises
 * precisely the vocabulary a domain match shares (`playback`, `media`, `queue` are common THERE).
 * Now that giant files and prose are excluded by the bounds above, raw file-level k is meaningful
 * again and leads; the scores are reported for the reader and break ties.
 */
export const rankRows = (rows) => [...rows].sort((a, b) => b.fileBestK - a.fileBestK || b.per10k - a.per10k
  || b.fileBestScore - a.fileBestScore || b.bestK - a.bestK || b.bestScore - a.bestScore || b.functions - a.functions);

/** Worth a line while the run is still going: a bounded file holding k of N terms, or a function holding k-1. */
export const isHit = (row, hitK = 6) => row.fileBestK >= hitK || row.bestK >= hitK - 1;

export function readClaims(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (/\.jsonl$/i.test(file)) {
    return raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => r.claim1 && r.claim1.text)
      .map((r) => ({ id: r.patent, label: r.title || '', text: r.claim1.text }));
  }
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.map((text, i) => ({ id: `claim-${i + 1}`, label: text.slice(0, 60), text }));
}

function readIndexList(spec) {
  if (spec.startsWith('@')) return fs.readFileSync(spec.slice(1), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return spec.split(',').map((s) => s.trim()).filter(Boolean);
}

// The same count the chart header prints ("3578 files, 65370 symbols"): every function/class/method
// definition. `functionIndex` is keyed by FILE, so its key count is not it.
function countSymbols(idx) {
  idx._ensureFunctionIndex();
  return typeof idx.listFunctions === 'function' ? idx.listFunctions().length : 0;
}

const csvCell = (s) => /[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s);

async function main() {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; args[k] = v; }
  }
  if (args.help || !args.claims || (!args.indexes && !args['dry-terms'])) {
    console.error(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
    process.exit(2);
  }
  let claims = readClaims(args.claims);
  if (args.limit) claims = claims.slice(0, Number(args.limit));
  const bg = buildDf((args.idf ? readClaims(args.idf) : claims).map((c) => c.text));
  const N = Number(args.terms || 8), MIN = Number(args['min-terms'] || 3), TOP = Number(args.top || 3), BOT = Number(args.bottom || 3);
  const bounds = { maxFileLines: Number(args['max-file-lines'] || 2000), maxFunctionLines: Number(args['max-function-lines'] || 300), codeOnly: !args['include-prose'] };
  const HIT = Number(args['hit-k'] || 6);
  const termsOf = new Map(claims.map((c) => [c.id, claimTerms(c.text, bg, N)]));
  if (args['dry-terms']) { for (const c of claims) console.log(`${c.id}\t${termsOf.get(c.id).join('; ')}`); return; }

  const indexes = readIndexList(args.indexes);
  const OUT = args.out || './ballpark';
  fs.mkdirSync(OUT, { recursive: true });
  process.stderr.write(`${claims.length} claim(s) x ${indexes.length} index(es); ${N} terms, min-terms ${MIN}; background ${bg.n} claims\n`);

  const rows = new Map(claims.map((c) => [c.id, []])); // claim id -> rows
  for (const ip of indexes) {
    const t0 = Date.now();
    let idx;
    try { idx = new CodeSearchIndex({ indexPath: ip }); } catch (e) { process.stderr.write(`  ${ip}: cannot load (${e.message}) -- skipped\n`); continue; }
    const symbols = countSymbols(idx);
    if (!symbols || !idx.files.size) { process.stderr.write(`  ${ip}: no function index or no files -- skipped\n`); continue; }
    let done = 0; const dropped = { oversizedFunctions: 0, oversizedFiles: 0, proseFiles: 0, opFunctions: 0 };
    for (const c of claims) {
      const terms = parseMultisectTerms(termsOf.get(c.id).join(';'));
      let res = null;
      try { res = idx.multisectSearch(terms, { minTerms: MIN, showProgress: false }); } catch (e) { process.stderr.write(`  ${ip} x ${c.id}: ${e.message}\n`); }
      const row = res ? reduceResult(res, symbols, idx.files.size, bounds)
        : { termsPresent: 0, termsTotal: terms.length, rareTerms: 0, functions: 0, files: 0, bestK: 0, bestScore: 0, fileBestK: 0, fileBestScore: 0, oversizedFunctions: 0, oversizedFiles: 0, proseFiles: 0, opFunctions: 0, symbols, per10k: 0, error: true };
      for (const k of Object.keys(dropped)) dropped[k] += row[k] || 0;
      rows.get(c.id).push({ index: ip, ...row });
      if (isHit(row, HIT)) process.stderr.write(`  HIT ${ip}  ${c.id} "${c.label.slice(0, 50)}"  file ${row.fileBestK}/${row.termsTotal} (${row.fileBestScore})  fn ${row.bestK}/${row.termsTotal} (${row.bestScore})  ${row.functions}f  [${termsOf.get(c.id).join('; ')}]\n`);
      done++;
      if (done % 50 === 0) process.stderr.write(`  ${ip}: ${done}/${claims.length} claims...\n`);
    }
    // Size profile, so the reader can tell whether the bounds are cutting outliers or the index's normal
    // files: Android 1.5's framework classes run 5-20k lines and a fixed 2,000 drops real code there.
    const sizes = [...idx.fileLines.values()].map((l) => l.length).sort((a, b) => a - b);
    const pct = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : 0);
    process.stderr.write(`  ${ip}: ${idx.files.size} files (median ${pct(0.5)} lines, p99 ${pct(0.99)}), ${symbols} symbols, ${done} claim(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s.` +
      ` Index ranked; bounds dropped individual matches: ${dropped.oversizedFiles} in files over ${bounds.maxFileLines} lines, ${dropped.proseFiles} in prose files, ${dropped.oversizedFunctions} in functions over ${bounds.maxFunctionLines} lines, ${dropped.opFunctions} pseudo-source (.op) functions` +
      `${pct(0.99) > bounds.maxFileLines ? ` -- p99 exceeds the file bound; consider --max-file-lines ${Math.ceil(pct(0.99) / 1000) * 1000} for this index` : ''}\n`);
    idx = null; // let the index go before the next one loads
  }

  const csv = ['claim_id,index,terms,terms_present,terms_total,rare_terms,file_best_k,file_best_score,best_k,best_score,functions,files,oversized_files,prose_files,oversized_functions,symbols,functions_per_10k'];
  const pairs = ['claim_id\tindex\tkind\trank\tfile_best_k\tfile_best_score\tbest_k\tbest_score\tfunctions\tterms'];
  for (const c of claims) {
    const ranked = rankRows(rows.get(c.id));
    const terms = termsOf.get(c.id).join('; ');
    for (const r of ranked) csv.push([c.id, csvCell(r.index), csvCell(terms), r.termsPresent, r.termsTotal, r.rareTerms, r.fileBestK, r.fileBestScore, r.bestK, r.bestScore, r.functions, r.files, r.oversizedFiles, r.proseFiles, r.oversizedFunctions, r.symbols, r.per10k].join(','));
    const top = ranked.slice(0, TOP), bottom = ranked.slice(-BOT).reverse().filter((r) => !top.includes(r));
    top.forEach((r, i) => pairs.push([c.id, r.index, 'top', i + 1, r.fileBestK, r.fileBestScore, r.bestK, r.bestScore, r.functions, terms].join('\t')));
    bottom.forEach((r, i) => pairs.push([c.id, r.index, 'bottom', i + 1, r.fileBestK, r.fileBestScore, r.bestK, r.bestScore, r.functions, terms].join('\t')));
    const fmt = (r) => `${r.index} file ${r.fileBestK}/${r.termsTotal} (${r.fileBestScore}) fn ${r.bestK}/${r.termsTotal} (${r.bestScore}) ${r.functions}f`;
    process.stderr.write(`${c.id}  [${terms}]\n   top: ${top.map(fmt).join(' | ')}\n   bottom: ${bottom.map(fmt).join(' | ')}\n`);
  }
  fs.writeFileSync(path.join(OUT, 'ballpark.csv'), csv.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'pairs.tsv'), pairs.join('\n') + '\n');
  process.stderr.write(`wrote ${OUT}/ballpark.csv (${csv.length - 1} rows) and ${OUT}/pairs.tsv (${pairs.length - 1} pairs)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
