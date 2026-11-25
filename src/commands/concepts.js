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
import { CARVE_HOWS, CALLS_SEED, makeRng, placeInSections } from '../core/carve.js';

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
export function conceptRowText(n, width, label, files, named, showPath = shortFile, whereTag = '') {
  const f = files && files.length ? `: files: ${files.slice(0, ROW_FILES).map((x) => showPath(x.file)).join(', ')}` : '';
  return `  ${String(n).padStart(width)}. ${label}${f}${whereTag ? `  [${whereTag}]` : ''}${named == null ? '' : `  (${nf(named)})`}`;
}

const pct = (x) => `${Math.round(x * 100)}%`;
const unitName = (tag) => (String(tag).includes('.') ? `sub-section ${tag}` : `section ${tag}`);
/**
 * The bracket a list row carries for where its mechanisms sit (issue-364-concepts-where):
 * `3.3: 43%` (sub-section 3.3 of the carved listing holds 43% of them), `5.4` for a concept
 * with one mechanism, `spread` when no section holds them better than chance, `alone` when
 * its one mechanism is in no section. Empty when there is nothing to place.
 */
export function whereTag(p) {
  if (!p) return '';
  if (p.n === 1) return p.unit || (p.elsewhere[0] ? p.elsewhere[0][0] : '');
  return p.home ? `${p.unit}: ${pct(p.held)}` : 'spread';
}
/** The lines that say where a concept's mechanisms sit, for the concept shown in full. */
export function whereLines(p, pad = '    ') {
  if (!p) return [];
  const rest = (list) => (list.length ? `${list.slice(0, 8).map(([t, c]) => `${t} (${c})`).join(', ')}${list.length > 8 ? `, and ${nf(list.length - 8)} more places` : ''}` : '');
  if (p.n === 1) return [p.unit ? `${pad}Its one mechanism is in ${unitName(p.unit)}, which has ${plural(p.size, 'mechanism', 'mechanisms')}.` : `${pad}Its one mechanism is in no section (${p.elsewhere[0] ? p.elsewhere[0][0] : 'not listed'}).`];
  if (!p.home) {
    return [`${pad}Spread: no section holds them better than a random pick of ${nf(p.n)} mechanisms would.${p.unit ? ` The most in one place: ${nf(p.inUnit)} of the ${nf(p.n)}, in ${unitName(p.unit)} (which has ${nf(p.size)}).` : ''}`,
      ...(p.elsewhere.length ? [`${pad}The others: ${rest(p.elsewhere)}.`] : [])];
  }
  return [`${pad}Home: ${unitName(p.unit)} holds ${nf(p.inUnit)} of the ${nf(p.n)} (${pct(p.held)}), and they are ${nf(p.inUnit)} of its ${plural(p.size, 'mechanism', 'mechanisms')} (${pct(p.pure)}).`,
    ...(p.section && p.section.inUnit > p.inUnit ? [`${pad}Its section, ${p.section.tag}, holds ${p.section.inUnit === p.n ? `all ${nf(p.n)}` : `${nf(p.section.inUnit)} of the ${nf(p.n)}`} (the section has ${plural(p.section.size, 'mechanism', 'mechanisms')}).`] : []),
    ...(p.elsewhere.length ? [`${pad}Also in: ${rest(p.elsewhere)}.`] : [`${pad}None is anywhere else.`])];
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

/** `--concepts [filter]`. Async since issue-364-concepts-where: the carve reads the function corpus. */
export async function doConcepts(index, args, { exe = process.env.CODEEXAM_INVOKED_AS || 'ce' } = {}) {
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
  // issue-364-concepts-where: where each concept's mechanisms sit in the carved listing. The
  // sections are --carve's own, with its default settings, so a number here is the number that
  // listing prints. Only when --carve is given with --concepts (Andrew, 2026-11-24): placing
  // needs the carve, which reads every function, and took the plain command from 4.5 s to
  // 14 s on ExoPlayer 3. `--carve calls` needs only the mechanisms file; bare --carve means calls.
  const whereAsked = !!(args._explicit && args._explicit.has('carve'));
  const whereHow = typeof args.carve === 'string' && args.carve.trim() ? args.carve.trim().toLowerCase() : 'calls';
  let where = null;
  if (hasMech && whereAsked) {
    if (!CARVE_HOWS.includes(whereHow)) where = { problem: `--carve takes clusters or calls, not "${args.carve}".` };
    else {
      // loaded here and not at the top: the carve command brings the embedding code with it, and
      // the MCP server and the GUI server import this module for conceptRows alone
      try { const { carveSectionsFor } = await import('./carve.js'); where = await carveSectionsFor(args.index_path, whereHow, { includeTests, embedModel: args.embed_model || null, exe, index }); }
      catch (e) { where = { problem: `it could not be worked out (${e.message}).` }; }
    }
    if (!where.problem) where.population = where.entries.map((_, i) => i);
  }
  const hasWhere = !!(where && !where.problem);
  // One generator per concept, from the one seed: a concept's answer is the same in the list
  // and when shown alone.
  const placeOf = (entries) => (hasWhere ? placeInSections(entries.map((e) => where.indexOf.get(e.id)).filter((i) => i != null), { ...where, rnd: makeRng(CALLS_SEED) }) : null);
  const tagOfEntry = (e) => (hasWhere && where.indexOf.has(e.id) ? where.tagOf.get(where.indexOf.get(e.id)) : null);
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
  const carveCmd = `${exe} --index-path ${ndx} --carve ${whereHow}`;
  // (a refusal is said once, here, for the list and for one concept alike)
  if (hasWhere && !full) lines.push(`In square brackets before that number: where those mechanisms sit in the sections of ${carveCmd}, and the share of them there. [3.3: 43%] is sub-section 3.3 of that listing holding 43% of the concept's mechanisms; [spread] means no section holds them better than a random pick would. ${exe} --index-path ${ndx} --concepts <word> says how many are there and where the others are.`);
  else if (hasMech && where && where.problem) lines.push(`Where the mechanisms sit is left out. ${where.problem.replace(/\s*\n\s*/g, ' ')}${whereHow === 'clusters' ? ' Without --carve clusters, --concepts places them by who calls whom.' : ''}`);
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
        const tag = tagOfEntry(e);   // the bracket --carve ends this mechanism's row with
        lines.push(`    ${String(e.id || '').padEnd(idWidth)}  ${e.label}  (${plural(fns, 'fn', 'fns')}, ${plural(files, 'file', 'files')})${tag ? `  [${tag}]` : ''}`);
      }
      if (hasWhere && m.entries.length) {
        lines.push(`  Where they sit, in the sections of ${carveCmd} (${where.settings}; the bracket at the end of each row above is its section there):`);
        lines.push(...whereLines(placeOf(m.entries)));
        lines.push(`    A suggestion, not a finding: the sections move when the index changes, and ${whereHow === 'calls' ? `${exe} --index-path ${ndx} --concepts ${quotePathIfNeeded(c.concept)} --carve clusters places the same mechanisms by likeness of their text` : 'without --carve clusters they are placed by who calls whom'}, which can give another answer.`);
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
      let named = null, tag = '';
      if (hasMech) {
        const m = mechanismsFor(mech, c.concept, includeTests);
        m.testEntries.forEach((e) => leftOut.add(e));
        if (!m.entries.length) unnamed++;
        named = m.entries.length;   // said once in the header what the number is (Andrew, 2026-11-23: the phrase on every row was too repetitive)
        tag = whereTag(placeOf(m.entries));
      }
      const files = termFiles.get(c.concept);
      if (files && files.length) withFiles++;
      lines.push(conceptRowText(i + 1, width, conceptLabel(c), files, named, showPath, tag));
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
  // the way to the brackets, said where the other next steps are (they are off unless asked for)
  if (hasMech && !whereAsked && !(full && unnamed > 0)) lines.push(`  ${pre} --concepts ${full ? `${word} ` : ''}--carve calls   ${full ? 'this concept' : 'these rows'} with where the mechanisms sit: the section of --carve calls that holds them best (slower: it carves the codebase first; --carve clusters places by likeness of text)`);
  // One concept that no mechanism is named for: the commands that list mechanisms by name
  // would show nothing for it, so they are not offered (`--carve` printed nothing with
  // "schulman" in it, and the suggestion to search its output for the word was false).
  const namesNothing = full && hasMech && unnamed > 0;
  if (hasMech && !namesNothing) {
    lines.push(`  ${pre} --mechanisms ${word}   the mechanisms that carry the word, with members and purposes`);
    lines.push(`  ${pre} --toc ${word}   one line each; also lists mechanisms whose file path, purpose or description carries the word`);
    lines.push(hasWhere
      ? `  ${pre} --carve ${whereHow}   the listing the section numbers are from: the mechanisms under sections and sub-sections (${pre} --concepts --carve ${whereHow === 'calls' ? 'clusters places the concepts by likeness of text' : 'calls places the concepts by who calls whom'} instead)`
      : `  ${pre} --carve calls   or --carve clusters: the mechanisms under sections; search its output for the word to see which section holds them`);
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
