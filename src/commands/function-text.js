// function-text.js — --show-function-text: list the text --semantic-search and --embed-distance --function-text embed for each function, with the mechanisms holding it
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// show-function-text-option (2026-11-22). The two embedding commands build one short text
// per function from the index with no model (src/core/function-text.js, the FUSE_ARM form),
// embed it and throw it away, so a reader could not see what a function's vector stands
// for. This lists the texts exactly as they are embedded (the same functionText and the
// same cut to the model's length), each with its lines and the record ids (m70) of the
// mechanisms that hold the function.
//
//   --show-function-text [filter]   every function, or those whose file@name matches
//   --show-function-text id:m33     the functions of one mechanism
//   --text-has <text|/regex/>       only the functions whose embedded text matches
//   -v                              the text's pieces apart, with their lengths
//   --include-tests                 test functions too (left out by default)
//   --max-results N / --all-results the cap (50 by default)
//
// No model is loaded and nothing is written.

import { effectiveMaxResults, capNotice } from '../argparse.js';
import { cut } from '../core/embed.js';
import { buildCorpus, functionText, functionTextParts, memberId, FUSE_ARM } from '../core/function-text.js';
import { loadMechanismsIndex, foldRecords } from '../core/mechanisms-index.js';
import { makeFilterMatcher, filteredEmptyNotice } from '../core/filter-match.js';
import { isTestPath } from '../core/test-paths.js';
import { mechanismQueryId, entryIndexById } from './embed-distance.js';

const nf = (n) => Number(n).toLocaleString('en-US');
const idNumber = (id) => Number(String(id).replace(/^m/, '')) || 0;

/** A function the listing leaves out by default: one in a test file, or a test inside a source file (buildCorpus's mark). */
export const isTestFunction = (f) => !!(f && (f.test || isTestPath(f.file)));

/**
 * Which mechanism entries hold which functions, two ways. `byId`: function id (`file@name`)
 * to the record ids of the entries holding it, lowest number first; this is the join the
 * embedding commands make (functionTexts in embed-distance.js), so a function it finds is
 * one they embed. `byLine`: `file|start line` to the same, which also finds a second
 * definition of a name within one file: the index names it `name@<line>`, a mechanism
 * holds it under the bare name, and the join by name reaches only the first definition.
 * `entries` are the folded records; an entry several records folded into is named by its own id.
 */
export function mechanismsOfFunctions(entries) {
  const byId = new Map(), byLine = new Map();
  const add = (m, k, id) => { if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(id)) m.get(k).push(id); };
  for (const e of entries || []) for (const m of e.members || []) {
    add(byId, memberId(m), e.id);
    if (m && m.start != null) add(byLine, `${String(m.file || '').split('\\').join('/')}|${m.start}`, e.id);
  }
  for (const map of [byId, byLine]) for (const l of map.values()) l.sort((a, b) => idNumber(a) - idNumber(b));
  return { byId, byLine };
}

/** Where a function stands: { ids, embedded }. `ids`: the mechanisms holding it; `embedded`: whether the embedding commands make a text for it. */
export function standingOf(f, mechs) {
  const named = mechs.byId.get(f.id);
  if (named && named.length) return { ids: named, embedded: true };
  return { ids: mechs.byLine.get(`${f.file}|${f.start}`) || [], embedded: false };
}

/**
 * The functions a listing shows, in file and line order, each with its embedded text.
 * `want`: null for every function, or a Set of function ids (the members of one mechanism).
 * `textFilter`: keep only the functions whose embedded text matches it (--text-has).
 * Returns { rows: [{ f, text, full, wasCut }], total, testsLeft }; `total` counts the
 * functions before the filter (tests already left out), `testsLeft` those left out as tests
 * among the functions the filter or `want` would otherwise have shown.
 */
export function selectFunctionTexts(corpus, { filter = null, want = null, includeTests = false, textFilter = null } = {}) {
  const match = makeFilterMatcher(filter), inText = makeFilterMatcher(textFilter);
  const textOf = (f) => cut(functionText(f, FUSE_ARM, corpus));
  const pool = corpus.fns.filter((f) => !want || want.has(f.id));
  const visible = pool.filter((f) => includeTests || !isTestFunction(f));
  const hit = (f) => match(f.id, f.name) && (!textFilter || inText(textOf(f)));
  const kept = visible.filter(hit);
  const testsLeft = includeTests ? 0 : pool.filter((f) => isTestFunction(f) && hit(f)).length;
  kept.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start || (a.name < b.name ? -1 : 1)));
  const rows = kept.map((f) => { const full = functionText(f, FUSE_ARM, corpus); const text = cut(full); return { f, text, full, wasCut: text.length < full.length }; });
  return { rows, total: visible.length, testsLeft };
}

/** Shortest, median and longest length of the texts, and how many are under `short` characters. */
export function lengthStats(rows, short = 40) {
  const len = rows.map((r) => r.text.length).sort((a, b) => a - b);
  return { shortest: len[0] || 0, median: len[len.length >> 1] || 0, longest: len[len.length - 1] || 0, under: len.filter((n) => n < short).length, short };
}

/**
 * The listing's lines. `mechs`: mechanismsOfFunctions' map, or null when the index has no
 * mechanisms file (the entries then carry no ids and one line says why). `of`: the
 * mechanism entry the listing was narrowed to with id:mNNN, or null.
 */
export function formatFunctionTexts(sel, { indexPath = '', filter = null, textFilter = null, of = null, mechs = null, max = 50, verbose = false, exe = 'ce' } = {}) {
  const { rows, total, testsLeft } = sel;
  const L = [];
  const inText = textFilter ? ` whose text holds ${JSON.stringify(String(textFilter))}` : '';
  const what = `${of ? ` of mechanism ${of.id} (${of.label})` : filter ? ` matching ${JSON.stringify(String(filter))}` : ''}${inText}`;
  const count = rows.length === total && !of && !textFilter ? `${nf(rows.length)} function text${rows.length === 1 ? '' : 's'}` : `${nf(rows.length)} function text${rows.length === 1 ? '' : 's'}${what}${of ? (textFilter ? `, of its ${nf(total)}` : '') : `, of ${nf(total)}`}`;
  L.push(`${count} in ${indexPath}: what --semantic-search and --embed-distance --function-text embed for each function.`);
  L.push(`  Built from the index with no model (the "${FUSE_ARM}" form): the name as words, a colon, the body's ranked identifiers, the function's comments, then "Text:" and the words of its string literals.`);
  const s = lengthStats(rows);
  L.push(`  Characters: shortest ${nf(s.shortest)}, median ${nf(s.median)}, longest ${nf(s.longest)}; under ${s.short}: ${nf(s.under)}.${testsLeft ? ` ${nf(testsLeft)} test function${testsLeft === 1 ? '' : 's'} left out (--include-tests lists ${testsLeft === 1 ? 'it' : 'them'}).` : ''}`);
  // The two commands embed a text only for a function some mechanism holds; the rest are
  // listed all the same (the text is what would be embedded) and marked, so the header's
  // "what they embed" is not read as covering them.
  const stand = mechs ? rows.map((r) => standingOf(r.f, mechs)) : null;
  const outside = stand ? stand.filter((s) => !s.embedded && !s.ids.length).length : 0;
  const second = stand ? stand.filter((s) => !s.embedded && s.ids.length).length : 0;
  const why = [outside ? `${nf(outside)} in no mechanism` : '', second ? `${nf(second)} a second definition of a name in its file` : ''].filter(Boolean).join(', ');
  L.push(mechs
    ? `  Each entry: file@function, its lines, then the ids of the mechanisms that hold it (as --mechanisms shows them).${why ? ` For ${nf(outside + second)} of these the two commands embed no text (${why}); they are marked.` : ''}`
    : `  Each entry: file@function and its lines. No mechanism ids, and nothing is embedded yet: this index has no mechanisms file (${exe} --index-path ${indexPath} --build-mechanisms writes one).`);
  L.push('');
  const shown = rows.slice(0, Number.isFinite(max) ? max : rows.length);
  for (const r of shown) {
    const s = mechs ? standingOf(r.f, mechs) : null;
    const where = !s ? '' : s.embedded ? `; in ${s.ids.join(' ')}` : s.ids.length ? `; in ${s.ids.join(' ')}, not embedded: a second definition of this name in the file` : '; in no mechanism, not embedded';
    L.push(`${r.f.id}  (L${r.f.start}-${r.f.end}${where})`);
    L.push(`    ${r.text}`);
    if (verbose) {
      const p = r.parts;
      const piece = (name, t) => `      ${name.padEnd(12)} ${String(t.length).padStart(4)} chars${t ? `  ${t}` : ''}`;
      L.push(`      ${nf(r.text.length)} characters${r.wasCut ? ` (cut from ${nf(r.full.length)} to what the model takes)` : ''}:`);
      L.push(piece('name', p.name), piece('identifiers', p.identifiers.join(', ')), piece('comment', p.comment), piece('strings', p.strings.join(' ')));
    }
    L.push('');
  }
  const note = capNotice(rows.length, shown.length, 'function texts');
  if (note) L.push(note);
  else L.pop();
  return L;
}

/**
 * `--show-function-text [filter | id:mNNN]`. Reads the loaded index's functions and source
 * lines and, when it has one, its mechanisms file. Exit code 2 for an id the index lacks,
 * as --embed-distance and --semantic-search give.
 */
export function doShowFunctionText(index, args, { exe = 'ce' } = {}) {
  const raw = typeof args.show_function_text === 'string' ? args.show_function_text : '';
  const own = raw || (typeof args.filter === 'string' ? args.filter : '') || null;
  const fromId = mechanismQueryId(raw);
  if (typeof index._ensureFunctionIndex === 'function') index._ensureFunctionIndex();
  const corpus = buildCorpus(index.functionIndex || {}, (f) => index.fileLines.get(f));
  if (!corpus.fns.length) { console.log(`--show-function-text: ${args.index_path} holds no functions.`); return; }
  let data = null;
  try { data = loadMechanismsIndex(index); } catch (e) { console.error(`--show-function-text: ${e.message}`); process.exitCode = 1; return; }
  const entries = data ? foldRecords(data.records) : null;
  let of = null, want = null;
  if (fromId) {
    if (!entries) { console.error(`--show-function-text: ${args.index_path} has no mechanisms file, so it has no mechanism ${fromId}. ${exe} --index-path ${args.index_path} --build-mechanisms writes one.`); process.exitCode = 2; return; }
    const at = entryIndexById(entries, fromId);
    if (at < 0) { console.error(`--show-function-text: ${args.index_path} has no mechanism ${fromId}. Its mechanisms file, built ${String(data.generated || '').slice(0, 10) || 'at an unrecorded date'}, has ${nf(entries.length)} mechanisms; ${exe} --index-path ${args.index_path} --mechanisms lists them with their ids.`); process.exitCode = 2; return; }
    of = entries[at];
    want = new Set((of.members || []).map(memberId));
  }
  const filter = fromId ? null : own;
  const textFilter = typeof args.text_has === 'string' && args.text_has ? args.text_has : null;
  const sel = selectFunctionTexts(corpus, { filter, want, includeTests: !!args.include_tests, textFilter });
  if (!sel.rows.length && textFilter) {
    const scope = of ? `of mechanism ${of.id} ` : filter ? `matching ${JSON.stringify(String(filter))} ` : '';
    console.log(`No function ${scope}has text holding ${JSON.stringify(textFilter)}${sel.testsLeft ? ` outside test code: ${nf(sel.testsLeft)} test function${sel.testsLeft === 1 ? '' : 's'} left out (--include-tests lists ${sel.testsLeft === 1 ? 'it' : 'them'})` : ''}. The text is the function's name as words, its identifiers, comments and string words, not its source: --regex searches the source.`);
    return;
  }
  if (!sel.rows.length) {
    console.log(of ? `Mechanism ${of.id} (${of.label}) has no function the listing shows${sel.testsLeft ? `: its ${nf(sel.testsLeft)} function${sel.testsLeft === 1 ? ' is' : 's are'} test code (--include-tests lists ${sel.testsLeft === 1 ? 'it' : 'them'})` : ': the index holds none of its members as a function'}.`
      : filter && sel.testsLeft ? `No function outside test code matches filter ${JSON.stringify(String(filter))}: ${nf(sel.testsLeft)} test function${sel.testsLeft === 1 ? '' : 's'} left out (--include-tests lists ${sel.testsLeft === 1 ? 'it' : 'them'}).`
        : filter ? filteredEmptyNotice('functions', sel.total, filter)
          : `No functions outside test code: ${nf(sel.testsLeft)} test function${sel.testsLeft === 1 ? '' : 's'} left out (--include-tests lists them).`);
    return;
  }
  const max = effectiveMaxResults(args, 50);
  if (args.verbose) for (const r of sel.rows.slice(0, Number.isFinite(max) ? max : sel.rows.length)) r.parts = functionTextParts(r.f, corpus);
  console.log(formatFunctionTexts(sel, { indexPath: args.index_path, filter, textFilter, of, mechs: entries ? mechanismsOfFunctions(entries) : null, max, verbose: !!args.verbose, exe }).join('\n'));
}
