// concepts-recall.mjs — how many words from a codebase's own README and docs headings turn up among its concepts
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// The accuracy measurement of docs/CODEEXAM_CONCEPTS.md (issue-364-concepts-doc-and-accuracy,
// 2026-11-24; #364 part B8, #307). The question: given words known to matter in a codebase, how
// many of them are among the concepts `ce --concepts` lists, in the first 12 (what the Overview
// shows), the first 24 (what --build-mechanisms seeds from), the first 50, and the whole list.
//
// WHERE THE WORDS COME FROM. The headings of the codebase's own README and docs files, as they
// are in the index. Its authors wrote them, without CodeExam. They are also independent of the
// concepts by construction: the vocabulary the concepts come from skips README and docs files
// when it is built (ensureVocabulary's skipDoc, TEXT_EXTENSIONS), so a heading word is a concept
// only if the code's own text carries it.
//
// THE RULES, FIXED BEFORE ANY RESULT WAS LOOKED AT (they are tested in test/test_concepts_recall.js):
//   1. A documentation file is README.md, README.txt or README.rst, or a .md / .rst file under a
//      directory named doc, docs or documentation: the extensions the vocabulary skips. Not
//      under a vendored, test, example or fixture directory. (This rule alone was changed after
//      the first run: it had also taken a README with no extension and .markdown files, which
//      the vocabulary does count, so their headings were not independent of the concepts.)
//   2. A heading is a Markdown ATX line (`## Title`) or a line underlined with === or ---,
//      outside fenced code. Links, backticks and emphasis marks are taken off.
//   3. A term is a word of a heading, split the way the concepts are split (splitCompoundToken:
//      `WorklistPane` gives worklist and pane), lowercased, three letters or more, and not an
//      English function word or a word of documentation headings in general (GENERIC_HEADING_WORDS:
//      installation, usage, license ...). A term is counted once per heading.
//   4. A term and a concept are the same word when they are equal, or when one begins the other
//      and the shorter is five letters or more (faithful and faithfulness; station and stations).
//      Both counts are reported: equal ("exact") and by this rule ("same word").
//   5. A term is "in the vocabulary" when it is the same word, by rule 4, as a piece of any token
//      of the index's vocabulary. A miss is then one of two kinds: not in the vocabulary at all
//      (the code does not say the word), or there and not among the concepts (ranked out).
//
// WHAT IT DOES NOT SHOW. The match is by name. A term "found" means the word is in the list, not
// that the code the concept points to is the code that matters. A heading word is what authors
// chose to explain, which is not the same as what an examiner needs to find.
//
// Usage:
//   node scripts/concepts-recall.mjs [--docs-from <dir>] [--list] [--json] <index> [<index> ...]
//     --docs-from <dir>   read the README and docs/*.md of <dir> on disk as the documentation,
//                         for an index that does not hold its own (one index only)
//     --list              print the terms, and for each miss which kind it is
//     --json              one JSON object per index on stdout, in place of the text
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { recallAtK } from '../src/core/ranker-eval.js';
import { splitCompoundToken } from '../src/utils.js';

export const CUTS = [12, 24, 50];
const VOCAB_KEPT = 15000;   // what ensureVocabulary writes to vocabulary.json

// English function words, and words that head sections of documentation whatever the project is.
// Fixed on 2026-11-24 before any concepts listing was compared with any heading.
const ENGLISH = 'the and for with from into onto over under about after before between through during without within along across behind beyond this that these those here there when where what which who whom whose why how are was were been being have has had does did doing will would shall should can could may might must not nor but yet also than then them they their its our your you his her she him all any both each few more most other some such only own same very just too via per out off use used uses using one two three four five first second third next last new old'.split(' ');
const DOCWORDS = 'installation install installing installed setup usage use license licence licensing contributing contribute contributors contribution contributions getting started start quickstart quick overview introduction intro example examples sample samples demo demos requirements requirement prerequisites dependencies table contents content toc changelog changes history faq questions notes note documentation docs doc reference references guide guides tutorial tutorials manual building build builds running run runs testing tests test development developing developer developers troubleshooting known issues issue limitations limitation see more further reading links link resources resource version versions release releases roadmap status summary description background about support supported help acknowledgements acknowledgments authors author credits credit todo step steps part parts section sections appendix download downloads citation cite contact community code conduct security features feature options option configuration config configuring details detail general basic basics advanced additional other misc miscellaneous information info what why how when using works work working important tips tip caveats warning warnings disclaimer copyright trademark trademarks project projects welcome home index page pages list lists platform platforms compatibility migration upgrading upgrade update updates updating related future plans plan goals goal motivation purpose scope design architecture structure layout organization directory directories files file source sources'.split(' ');
export const GENERIC_HEADING_WORDS = new Set([...ENGLISH, ...DOCWORDS]);

const _SKIP_DIR_RE = /(^|[\/!])(node_modules|site-packages|vendor|third_party|third-party|bower_components|tests?|__tests__|specs?|examples?|fixtures?|samples?)\//i;
const _DOC_DIR_RE = /(^|[\/!])(docs?|documentation)\//i;

/** Rule 1: is this indexed path one of the codebase's documentation files? */
export function isDocSource(fp) {
  const norm = String(fp).replace(/\\/g, '/');
  if (_SKIP_DIR_RE.test(norm)) return false;
  const base = norm.split(/[\/!]/).pop();
  // Only the extensions the vocabulary skips (TEXT_EXTENSIONS: .md, .txt, .rst). A README with no
  // extension, or a .markdown file, is counted when the vocabulary is built, so its headings would
  // not be independent of the concepts. (Tightened 2026-11-24 after the first run, for that reason
  // and no other: the first form of this rule also took `README` and `.markdown`.)
  if (/^readme\.(md|txt|rst)$/i.test(base)) return true;
  return _DOC_DIR_RE.test(norm) && /\.(md|rst)$/i.test(base);
}

const _clean = (s) => s
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')   // [text](url) and images
  .replace(/<[^>]+>/g, ' ')                    // html tags
  .replace(/[`*_~]+/g, (m) => (m.includes('_') && !/[`*~]/.test(m) ? m : ''))   // emphasis marks; a bare _ inside a name stays
  .replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')       // emphasis underscores at word edges
  .replace(/\s+#+\s*$/, '')                    // closing hashes
  .replace(/\s+/g, ' ').trim();

/** Rule 2: the headings of a Markdown (or underlined-heading) document, markup taken off. */
export function headingsOf(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { if (!fence) fence = f[1]; else if (fence === f[1]) fence = null; continue; }
    if (fence) continue;
    const atx = /^ {0,3}#{1,6}\s+(.*)$/.exec(line);
    if (atx) { const h = _clean(atx[1]); if (h) out.push(h); continue; }
    if (i + 1 < lines.length && /^ {0,3}(=+|-{3,})\s*$/.test(lines[i + 1]) && /[A-Za-z]/.test(line) && !/^\s*([-*+>|]|\d+\.)\s/.test(line) && line.trim().length <= 120 && (i === 0 || !lines[i - 1].trim())) {
      const h = _clean(line); if (h) out.push(h); i++;
    }
  }
  return out;
}

/** Rule 3: Map of term -> number of headings that carry it. */
export function termsOf(headings) {
  const counts = new Map();
  for (const h of headings) {
    const seen = new Set();
    for (const word of h.match(/[A-Za-z][A-Za-z0-9_]*/g) || []) {
      const parts = splitCompoundToken(word).map((p) => p.toLowerCase());
      for (const p of parts.length ? parts : [word.toLowerCase()]) {
        if (p.length < 3 || !/[a-z]/.test(p) || GENERIC_HEADING_WORDS.has(p)) continue;
        seen.add(p);
      }
    }
    for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

/** Rule 4. */
export function sameWord(a, b) {
  if (a === b) return true;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return s.length >= 5 && l.startsWith(s);
}

/**
 * The shares. `terms` is termsOf's Map; `concepts` the concept words in listing order; `vocabPieces` a
 * Set of every lowercased piece of every vocabulary token. `minHeadings` keeps only terms in that
 * many headings or more.
 */
export function recallReport({ terms, concepts, vocabPieces, ks = CUTS, minHeadings = 1 }) {
  const list = [...terms].filter(([, n]) => n >= minHeadings).map(([t]) => t);
  const worthy = new Set(list);
  // each concept is turned into the term it stands for (or nothing), once per term, so that
  // recallAtK counts terms found and not concepts that found them
  const keysBy = (same) => {
    const taken = new Set();
    return concepts.map((c) => {
      // the term equal to the concept first: `multi` must not take `multisect` from `multisect`
      const t = list.find((x) => !taken.has(x) && x === c) || (same ? list.find((x) => !taken.has(x) && sameWord(x, c)) : undefined);
      if (t) taken.add(t);
      return t || null;
    });
  };
  const exactKeys = keysBy(false), sameKeys = keysBy(true);
  const cut = (k) => ({ k, exact: recallAtK(exactKeys, worthy, k), same: recallAtK(sameKeys, worthy, k) });
  const pieces = [...vocabPieces];
  const inVocab = list.filter((t) => vocabPieces.has(t) || pieces.some((p) => sameWord(t, p)));
  const inVocabSet = new Set(inVocab);
  const found = new Set(sameKeys.filter(Boolean));
  return {
    terms: list.length,
    concepts: concepts.length,
    at: ks.map(cut),
    all: cut(concepts.length),
    inVocabulary: { hits: inVocab.length, recall: list.length ? inVocab.length / list.length : null },
    missed: {
      notInVocabulary: list.filter((t) => !inVocabSet.has(t)).sort(),
      inVocabularyNotAConcept: list.filter((t) => inVocabSet.has(t) && !found.has(t)).sort(),
    },
    foundAt: Object.fromEntries(list.filter((t) => found.has(t)).map((t) => [t, sameKeys.indexOf(t) + 1])),
  };
}

// ---- the runner -------------------------------------------------------------------------------

function docsOnDisk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) if (isDocSource(name)) out.push([name, fs.readFileSync(path.join(dir, name), 'utf8')]);
  for (const d of ['docs', 'doc', 'documentation']) {
    const p = path.join(dir, d);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) continue;
    for (const name of fs.readdirSync(p)) if (isDocSource(`${d}/${name}`)) out.push([`${d}/${name}`, fs.readFileSync(path.join(p, name), 'utf8')]);
  }
  return out;
}

const pct = (r) => (r.recall == null ? '  n/a' : `${String(Math.round(r.recall * 100)).padStart(4)}%`);

async function main() {
  const argv = process.argv.slice(2);
  let docsFrom = null, list = false, json = false;
  const indexes = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--docs-from') docsFrom = argv[++i];
    else if (argv[i] === '--list') list = true;
    else if (argv[i] === '--json') json = true;
    else indexes.push(argv[i]);
  }
  if (!indexes.length) { console.error('usage: node scripts/concepts-recall.mjs [--docs-from <dir>] [--list] [--json] <index> [<index> ...]'); process.exit(2); }
  if (docsFrom && indexes.length !== 1) { console.error('--docs-from goes with one index'); process.exit(2); }
  const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
  const { allConcepts } = await import('../src/commands/concepts.js');
  for (const ip of indexes) {
    const quiet = console.error; console.error = () => {};
    let idx, concepts, vocab;
    try {
      idx = new CodeSearchIndex({ indexPath: ip });
      concepts = allConcepts(idx).all.map((c) => c.concept);
      vocab = idx.ensureVocabulary(false);
    } catch (e) { console.error = quiet; console.error(`${ip}: cannot be read (${e.message})`); continue; } finally { console.error = quiet; }
    const docs = docsFrom ? docsOnDisk(docsFrom) : [...idx.files.entries()].filter(([fp]) => isDocSource(fp));
    const headings = docs.flatMap(([, text]) => headingsOf(text));
    const terms = termsOf(headings);
    // The vocabulary as vocabulary.json keeps it: the 15,000 best-scored tokens. A vocabulary built in
    // this run holds every token and one read from the cache holds those 15,000, so without this cut
    // the same index gave two answers (ExoPlayer 3: 93% built, 87% read).
    const vocabPieces = new Set();
    const kept = [...vocab.entries()].sort((a, b) => (b[1].score || 0) - (a[1].score || 0)).slice(0, VOCAB_KEPT);
    for (const [token] of kept) { vocabPieces.add(token.toLowerCase()); for (const p of splitCompoundToken(token)) vocabPieces.add(p.toLowerCase()); }
    const every = recallReport({ terms, concepts, vocabPieces });
    const repeated = recallReport({ terms, concepts, vocabPieces, minHeadings: 2 });
    if (json) { console.log(JSON.stringify({ index: ip, docsFrom, files: idx.files.size, docs: docs.length, headings: headings.length, every, repeated })); continue; }
    console.log(`\n${ip}: ${idx.files.size} files; documentation ${docsFrom ? `read from ${docsFrom}` : 'from the index'}: ${docs.length} files, ${headings.length} headings; ${concepts.length} concepts`);
    if (!terms.size) { console.log('  no heading terms: nothing to measure'); continue; }
    for (const [name, r] of [['every heading term', every], ['terms in two or more headings', repeated]]) {
      if (!r.terms) { console.log(`  ${name}: none`); continue; }
      console.log(`  ${name} (${r.terms}):`);
      // Two readings of one count. "of the terms": the share of the terms found, which cannot pass
      // k / terms (12 concepts cannot find 600 terms). "of the concepts": how many of the first k
      // concepts are a heading term at all.
      console.log(`    of the terms, found among the concepts (same word):  ${r.at.map((a) => `first ${a.k} ${pct(a.same)}`).join('   ')}   all ${r.concepts} ${pct(r.all.same)}`);
      console.log(`    of the terms, found among the concepts (exact):      ${r.at.map((a) => `first ${a.k} ${pct(a.exact)}`).join('   ')}   all ${r.concepts} ${pct(r.all.exact)}`);
      console.log(`    of the concepts, how many are a heading term (same word):  ${r.at.map((a) => `${a.same.hits} of the first ${Math.min(a.k, r.concepts)}`).join('   ')}   ${r.all.same.hits} of all ${r.concepts}`);
      console.log(`    in the vocabulary at all: ${pct(r.inVocabulary)} (${r.inVocabulary.hits}); missed: ${r.missed.notInVocabulary.length} not in the vocabulary, ${r.missed.inVocabularyNotAConcept.length} there and not a concept`);
      if (list) {
        console.log(`    found (term: row): ${Object.entries(r.foundAt).sort((a, b) => a[1] - b[1]).map(([t, n]) => `${t}: ${n}`).join(', ') || 'none'}`);
        console.log(`    in the vocabulary, not a concept: ${r.missed.inVocabularyNotAConcept.join(', ') || 'none'}`);
        console.log(`    not in the vocabulary: ${r.missed.notInVocabulary.join(', ') || 'none'}`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
