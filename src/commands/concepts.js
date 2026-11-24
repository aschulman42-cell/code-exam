// concepts.js — --concepts [filter]: the concepts the Overview prints, on their own, each with its example, its top files and the mechanisms that carry the word
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// issue-364-concepts-cli (#364, parts B1, B2, B6). Andrew, 2026-11-19: the Overview prints twelve
// concepts on one line, and there was no way to ask for them alone, to learn where one lives, or
// to go from one to the mechanisms listings ("what are some things to look for when I eyeball?").
//
//   ce --index-path <index> --concepts [filter] [--max-results N | --all-results] [--include-tests]
//
// The concepts are extractConcepts' own, called with the Overview's arguments (the index's top
// CONCEPT_NAMES vocabulary entries, 500 since 2026-11-24) and no cap, so the first twelve rows are
// the Overview's twelve, in its order and with its examples; nothing here finds or ranks a concept.
// Files per concept are computeVocabDensity's data read term to files (computeTermFiles,
// metrics.js), and only for a concept that is itself one of the top KEY_FILE_NAMES (200) terms. Mechanisms per concept are those whose label
// (or a folded record's label) or member function names carry the word, case-insensitively, as
// a substring (the mechanisms file folded by member set, test rows left out unless
// --include-tests). `--toc <word>` and `--mechanisms <word>` also match file paths, purposes and
// descriptions, so they may list more; the output says so and never claims the two agree. No
// model and no embeddings are used.
import { extractConcepts, conceptLabel, CONCEPT_NAMES, KEY_FILE_NAMES } from '../core/vocabulary.js';
import { computeTermFiles } from './metrics.js';
import { loadMechanismsIndex, foldRecords, notBuiltLine, orderEntries, DEFAULT_LISTING_ORDER } from '../core/mechanisms-index.js';
import { makeFilterMatcher } from '../core/filter-match.js';
import { isTestEntry, testsTip, printTip } from '../core/test-paths.js';
import { effectiveMaxResults, capNotice } from '../argparse.js';
import { quotePathIfNeeded } from '../utils.js';

const nf = (x) => Number(x || 0).toLocaleString('en-US');
const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;
/** The concepts a list shows when no number is given. */
export const CONCEPTS_DEFAULT = 30;
/** How many files a list row names, and a concept shown in full. */
const ROW_FILES = 3, FULL_FILES = 10;
const shortFile = (fp, maxLen = 45) => (fp.length <= maxLen ? fp : '...' + fp.slice(-(maxLen - 3)));

/**
 * The concepts of an index exactly as the Overview computes them, without its cap: { vocab, all }.
 * `all` is made from the top CONCEPT_NAMES vocabulary entries; `vocab` is the top KEY_FILE_NAMES of
 * them, the ones the Overview's file ranking uses.
 */
export function allConcepts(index) {
  let pool = [];
  try { pool = index.getTopVocabulary(CONCEPT_NAMES) || []; } catch { pool = []; }
  return { vocab: pool.slice(0, KEY_FILE_NAMES), all: extractConcepts(index, { entries: pool, maxConcepts: Infinity }) };
}

/**
 * The mechanisms the listings of an index show, ready to be counted per word, or null with the
 * reason: { entries, tests: Set of test entries, all } or { missing: true } or { error }.
 */
function loadMechanisms(index) {
  let data;
  try { data = loadMechanismsIndex(index); } catch (e) { return { error: e.message }; }
  if (!data) return { missing: true };
  const all = foldRecords(data.records);
  return { all, tests: new Set(all.filter(isTestEntry)) };
}

/** True when a mechanism's label (or a folded record's label) or one of its member function names carries `lw` (lowercase), as a substring. */
const carriesWord = (e, lw) => String(e.label || '').toLowerCase().includes(lw)
  || (e.aliases || []).some((a) => String(a.label || '').toLowerCase().includes(lw))
  || (e.members || []).some((m) => String(m.name || '').toLowerCase().includes(lw));

/** The entries whose label or member function names carry the word, in --toc's order, and the test entries that were left out. */
function mechanismsFor(mech, word, includeTests) {
  const lw = String(word).toLowerCase();
  const hit = mech.all.filter((e) => carriesWord(e, lw));
  const kept = includeTests ? hit : hit.filter((e) => !mech.tests.has(e));
  return { entries: orderEntries(kept, DEFAULT_LISTING_ORDER), testsLeft: includeTests ? 0 : hit.length - kept.length, testEntries: includeTests ? [] : hit.filter((e) => mech.tests.has(e)) };
}

/** The concepts a filter selects: the one concept equal to it, or all whose word it matches (substring or /regex/). */
function matchConcepts(all, filter) {
  if (!filter) return all;
  const exact = all.filter((c) => c.concept === String(filter).toLowerCase());
  const match = makeFilterMatcher(filter);
  return exact.length === 1 ? exact : all.filter((c) => match(c.concept));
}

/** One row of a concepts listing: `  3. zorble (postZorbleRecord): files: a, b  (4)`. `named` is the count of mechanisms named for the concept, or null when the index has no mechanisms file. */
export function conceptRowText(n, width, label, files, named, showPath = shortFile) {
  const f = files && files.length ? `: files: ${files.slice(0, ROW_FILES).map((x) => showPath(x.file)).join(', ')}` : '';
  return `  ${String(n).padStart(width)}. ${label}${f}${named == null ? '' : `  (${nf(named)})`}`;
}

/**
 * A concepts listing as data, for a caller that writes its own sentences around the rows (the MCP
 * tool `concepts`, issue-364-concepts-mcp-tool). The same functions as `--concepts`, in the same
 * order, so the rows cannot differ from the command's:
 *   { total, matched: [concept], shown: [{ concept, example, label, files, mechanisms }],
 *     mechanisms: 'ok' | 'missing' | 'error', mechanismsError, testsLeft }
 * `files` is null for a concept that is not itself a top vocabulary term; `mechanisms` is null
 * when the index has no mechanisms file, which this never builds. `testsLeft` counts the distinct
 * test mechanisms that a shown concept's word matched and that were left out.
 */
export function conceptRows(index, { filter = null, includeTests = false, max = CONCEPTS_DEFAULT } = {}) {
  const { vocab, all } = allConcepts(index);
  const matched = matchConcepts(all, filter);
  const mech = loadMechanisms(index);
  const termFiles = computeTermFiles(vocab);
  const leftOut = new Set();
  const rankOf = new Map(all.map((c, i) => [c.concept, i + 1]));   // a concept's place in the whole list, kept under a filter
  const shown = matched.slice(0, Number.isFinite(max) && max > 0 ? max : matched.length).map((c) => {
    const m = mech.all ? mechanismsFor(mech, c.concept, includeTests) : null;
    if (m) m.testEntries.forEach((e) => leftOut.add(e));
    return { rank: rankOf.get(c.concept), concept: c.concept, example: c.example || null, exampleFile: c.exampleFile || null, exampleIsFunction: !!c.exampleIsFunction, label: conceptLabel(c), files: termFiles.get(c.concept) || null, mechanisms: m ? m.entries : null };
  });
  return { total: all.length, matched, shown, mechanisms: mech.all ? 'ok' : mech.error ? 'error' : 'missing', mechanismsError: mech.error || null, testsLeft: leftOut.size };
}

/** `--concepts [filter]`. */
export function doConcepts(index, args, { exe = process.env.CODEEXAM_INVOKED_AS || 'ce' } = {}) {
  const ndxArg = args.index_path || '<index>';
  const ndx = quotePathIfNeeded(String(ndxArg));
  const ndxName = String(ndxArg).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(ndxArg);
  const { vocab, all } = allConcepts(index);
  if (!all.length) {
    console.log(`No concepts in ${ndxName}: its top vocabulary gives none. ${exe} --index-path ${ndx} --vocabulary lists its top terms.`);
    return;
  }
  const own = args.concepts;
  const filter = typeof own === 'string' && own ? own : (args.filter || null);
  const matched = matchConcepts(all, filter);
  if (filter) {
    if (!matched.length) {
      console.log(`'${filter}' is not one of this index's ${nf(all.length)} concepts. ${exe} --index-path ${ndx} --vocabulary lists its top terms, and ${exe} --index-path ${ndx} --search ${quotePathIfNeeded(String(filter))} finds the word in the code.`);
      return;
    }
  }
  const full = !!filter && matched.length === 1;
  const includeTests = !!args.include_tests;
  const max = effectiveMaxResults(args, CONCEPTS_DEFAULT);
  const mech = loadMechanisms(index);
  const hasMech = !!mech.all;
  const termFiles = computeTermFiles(vocab);
  const showPath = (f) => (args.full_path ? quotePathIfNeeded(f) : shortFile(f));
  const leftOut = new Set();   // distinct test entries that a shown concept's word matched
  let unnamed = 0;             // shown concepts that no mechanism is named for
  // Concepts are found by counting words in the code's whole text. The ranking does not yet
  // tell a word the code is about from one that is merely everywhere (#351), so the listing says which rows name nothing.
  const NAMES_NOTHING = 'Such a word is in the code\'s text (comments, strings, file headers, names that are not functions) and in no mechanism\'s label or function names. It may be boilerplate, such as a name in the header of every file, and not something the code is about.';

  const head = full
    ? `Concept '${matched[0].concept}' of ${ndxName}: one of the ${nf(all.length)} concepts the Overview prints (its first 12 are on one line), found by counting the names in the code with no model; a suggestion of what to look for, not a finding.`
    : `${filter ? `${nf(matched.length)} of ${nf(all.length)} concepts matching '${filter}'` : max < matched.length ? `The first ${nf(max)} of ${nf(all.length)} concepts` : `${nf(all.length)} concepts`} of ${ndxName}: the same concepts the Overview prints (it shows the first 12, in this order), found by counting the names in the code with no model; a suggestion of what to look for, not a finding.`;
  const lines = [head];
  if (hasMech) lines.push(`${full ? 'Mechanisms named for a concept' : 'The number in brackets at the end of a row is how many mechanisms are named for the concept'}: those whose label or a member function name carries the word${includeTests ? '' : ' (test mechanisms left out)'}. ${exe} --index-path ${ndx} --toc <word> and --mechanisms <word> list those and also any mechanism whose file path, purpose or description carries the word, so they may list more.`);
  const noteAt = lines.length;   // the line about files goes here once the rows are known
  lines.push('');

  if (full) {
    const c = matched[0];
    lines.push(`  Example: ${c.example || 'none: the word is only ever a whole name'}`);
    const files = termFiles.get(c.concept);
    if (!files) lines.push(`  Files: none are listed, because this word is a part of longer names and not one of the top vocabulary terms the Overview's file ranking uses; ${exe} --index-path ${ndx} --search ${quotePathIfNeeded(c.concept)} finds where it is in the code.`);
    else if (!files.length) lines.push('  Files: a top vocabulary term, but no file holds it more than others.');
    else {
      lines.push('  Files: where this top vocabulary term concentrates, best first');
      files.slice(0, FULL_FILES).forEach((f, i) => lines.push(`    ${i + 1}. ${showPath(f.file)}`));
      if (files.length > FULL_FILES) lines.push(`    ... +${nf(files.length - FULL_FILES)} more files`);
    }
    if (hasMech) {
      const m = mechanismsFor(mech, c.concept, includeTests);
      m.testEntries.forEach((e) => leftOut.add(e));
      lines.push(`  Mechanisms: ${nf(m.entries.length)} named for it (a label or a member function name carries the word; ${exe} --index-path ${ndx} --toc ${quotePathIfNeeded(c.concept)} may list more, by file path, purpose or description)`);
      const shown = Math.min(m.entries.length, Number.isFinite(max) ? max : m.entries.length);
      const idWidth = Math.max(0, ...m.entries.slice(0, shown).map((e) => String(e.id || '').length));
      for (const e of m.entries.slice(0, shown)) {
        const fns = (e.members || []).length, files = (e.files || []).length;
        lines.push(`    ${String(e.id || '').padEnd(idWidth)}  ${e.label}  (${plural(fns, 'fn', 'fns')}, ${plural(files, 'file', 'files')})`);
      }
      const more = capNotice(m.entries.length, shown, 'mechanisms');
      if (more) lines.push(more);
      // A concept is a word counted in the code's text, comments and strings included. One
      // that names nothing is said to be so (Andrew, 2026-11-23, on `schulman` and
      // `aschulman42` among CodeExam's concepts: his name, from the header of every file).
      if (!m.entries.length) { unnamed = 1; lines.push(`  ${NAMES_NOTHING}`); }
    }
  } else {
    const shown = matched.slice(0, Number.isFinite(max) ? max : matched.length);
    const width = String(shown.length).length;
    let withFiles = 0;
    shown.forEach((c, i) => {
      let named = null;
      if (hasMech) {
        const m = mechanismsFor(mech, c.concept, includeTests);
        m.testEntries.forEach((e) => leftOut.add(e));
        if (!m.entries.length) unnamed++;
        named = m.entries.length;   // said once in the header what the number is (Andrew, 2026-11-23: the phrase on every row was too repetitive)
      }
      const files = termFiles.get(c.concept);
      if (files && files.length) withFiles++;
      lines.push(conceptRowText(i + 1, width, conceptLabel(c), files, named, showPath));
    });
    // One line, not one per row: files are listed only for a concept that is itself a top vocabulary term.
    // The example of "a part of longer names" is taken from this listing, not from CodeExam's own code.
    const part = shown.find((c) => c.example && !(termFiles.get(c.concept) || []).length);
    const eg = part ? ` (\`${part.concept}\` in \`${part.example}\`)` : '';
    lines.splice(noteAt, 0, `Files are shown for ${nf(withFiles)} of the ${nf(shown.length)} rows listed. Files are listed only where the concept is itself one of the top vocabulary terms the Overview's file ranking uses; a concept that is a part of longer names${eg} is not, and its row has no files.`);
    if (hasMech && unnamed) lines.splice(noteAt + 1, 0, `${nf(unnamed)} of the rows listed ${unnamed === 1 ? 'has' : 'have'} no mechanism named for ${unnamed === 1 ? 'it' : 'them'} (0). ${NAMES_NOTHING}`);
  }

  lines.push('');
  const word = full ? quotePathIfNeeded(matched[0].concept) : '<word>';
  const pre = `${exe} --index-path ${ndx}`;
  lines.push(full ? 'To follow this concept:' : 'To follow a concept (put one of these words where <word> is):');
  if (!full) lines.push(`  ${pre} --concepts <word>   one concept in full: its files and its mechanisms`);
  // One concept that no mechanism is named for: the commands that list mechanisms by name
  // would show nothing for it, so they are not offered (`--carve` printed nothing with
  // "schulman" in it, and the suggestion to search its output for the word was false).
  const namesNothing = full && hasMech && unnamed > 0;
  if (hasMech && !namesNothing) {
    lines.push(`  ${pre} --mechanisms ${word}   the mechanisms that carry the word, with members and purposes`);
    lines.push(`  ${pre} --toc ${word}   one line each; also lists mechanisms whose file path, purpose or description carries the word`);
    lines.push(`  ${pre} --carve calls   or --carve clusters: the mechanisms under sections; search its output for the word to see which section holds them`);
  }
  if (!namesNothing) lines.push(`  ${pre} --pseudo-claims --candidates <file> --filter ${word}   candidate groups of functions for the word, written to <file>`);
  lines.push(`  ${pre} --search ${word}   every place the word is in the code`);
  if (namesNothing) lines.push(`  Not offered for this word: --mechanisms, --carve and the pseudo-claims candidates, which go by the names of mechanisms and functions. ${pre} --toc ${word} lists a mechanism only if its file path, purpose or description carries the word.`);
  else if (!full && hasMech && unnamed) lines.push('  For a word that no mechanism is named for, only --search will find anything.');
  if (!hasMech) lines.push(mech.error ? `Mechanism counts left out: the mechanisms file could not be read (${mech.error}).` : `Mechanism counts left out; ${notBuiltLine(index, { exe, indexPath: args.index_path })}`);

  console.log(lines.join('\n'));
  if (!full) {
    const more = capNotice(matched.length, Math.min(matched.length, Number.isFinite(max) ? max : matched.length), 'concepts');
    if (more) console.log(more);
  }
  printTip(testsTip(leftOut.size, 'mechanisms'));
}
