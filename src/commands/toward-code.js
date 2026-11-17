// toward-code.js — --embed-distance --toward-code and --semantic-search --toward-code: reword each claim element toward an index's own names with a model, one call per element, as the search query --embed-distance ranks by
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// vocab-rewrite-to-embed-distance (2026-11-16). --embed-distance embeds a claim element as
// written, and on a litigated claim that fails at the wording: the embedding does its work
// within a register and does not cross registers (docs/describe-reach.md, "Register, not
// breadth"). This module is the query-side step of that page as a command option, for
// testing: one model call per element, on the claim side only (never one call per function),
// given what the index calls things, returning text the ranking is then run against.
//
//   ce --ndx <index> --embed-distance @claim.txt --toward-code restate|label [--spec <file>]
//   ce --ndx <index> --embed-distance @claim.txt --toward-code @<saved rewrites>     no model call
//
// The opposite direction is src/commands/synonymize.js, which rewrites a claim AWAY from code
// vocabulary and by construction cannot read an index. This one needs the index by
// definition, so it is a separate module and synonymize.js imports nothing from it.
//
// WHAT THE MODEL IS GIVEN, and why each piece:
// - the element, and the whole claim for its antecedents;
// - the index's vocabulary, as a HINT. Two earlier bridges are on record. One restricted the
//   model to a vocabulary slice and it answered NONE (the comment at buildIndexProfile in
//   claim-locate.js). One asked the model to pick this codebase's terms for the claim's
//   concepts and got the most prominent words back, not the discriminating ones, which
//   diluted the keyword search it fed (commit 213d481, built and removed). So the prompt says
//   the list is what this code calls things, to be used where it fits and not otherwise;
// - in the label form, a sample of the index's own mechanism entries, for their shape: that
//   form writes what --embed-distance ranks against, a label and function names, on the
//   finding that text in the shape of the target scores above a paraphrase of the query;
// - the patent's specification when --spec supplies it, the proper source for what a claim
//   term means.
//
// WHAT A REWRITE IS NOT. It is a search query. It is printed beside the element it replaces,
// saved to a file, and never substituted silently; nothing reads it as the claim. A model
// told a codebase's words steers toward them whether or not the code practises the element,
// so a good rank under this option is not evidence that it does; the controls for that are a
// separate measurement (the worklist item claim-rewording-blind-test).
import fs from 'node:fs';
import path from 'node:path';
import { resolveModel, makeDrafter, claimsCostGate, actualCostLine, resetCloudUsage, describeEngine, printShownPrompts } from '../core/llm-runner.js';
import { cachedVocabularyWords } from '../core/vocabulary.js';
import { entryChunks } from '../core/embed.js';
import { vocabConcordanceOptions } from './claim.js';
import { parseElementsFile } from './claim-locate.js';
import { cleanRewrite } from './synonymize.js';

export const TOWARD_CODE_FORMS = ['restate', 'label'];

export const TOWARD_CODE_DEFAULTS = {
  // One sentence, or one label with a handful of names: 300 leaves room without inviting an essay.
  maxTokens: 300,
  // Sample entries shown to the label form, taken at even steps through the index's entries.
  sampleEntries: 40,
  // The member names of a sample entry, as --embed-distance chunks them.
  chunk: 8,
  // A sample entry is cut here; a label with eight long names can run past it.
  sampleChars: 220,
};

/**
 * What --toward-code was given: `restate` or `label` (a model rewrites each element in that
 * form), or `@<file>` (rewrites saved by an earlier run, used with no model call). Throws
 * with the choices on anything else.
 */
export function parseTowardCode(value) {
  const v = String(value == null ? '' : value).trim();
  if (v.startsWith('@') && v.length > 1) return { file: v.slice(1) };
  if (TOWARD_CODE_FORMS.includes(v)) return { form: v };
  throw new Error(`--toward-code takes ${TOWARD_CODE_FORMS.join(' or ')}, or @<file> of rewrites an earlier run saved${v ? ` (got "${v}")` : ''}`);
}

// The WHOLE CLAIM rule was changed once after seeing results, and the reason is on record
// (2026-11-16, the '101 claim against ExoPlayer 3): as first written it ended at "Work on
// the ELEMENT only.", and the label form wrote the claim's main idea for five of nine
// elements, so the preamble ("a system with a transmitter and a receiver") ranked the
// rate-selection class 7th. The added sentences say what "only" means.
const SHARED_RULES = [
  '- CODEBASE VOCABULARY lists words that occur in the names of the codebase being',
  '  searched. Where one of them is the right word for something the element requires,',
  '  prefer it to a synonym. Do not use a word because it is listed: most of the list has',
  '  nothing to do with this element. You may use any engineering term, listed or not.',
  '- WHOLE CLAIM is given only so that you can resolve references in the element ("the',
  '  unit", "said data"). Work on the ELEMENT only: write what this element itself',
  '  requires, not what the claim as a whole is about. An element that only names parts',
  '  or sets the scene gets text that does the same and says nothing of what the other',
  '  elements require.',
  '- PATENT SPECIFICATION, when given, says what the claim\'s terms mean. Use it to',
  '  understand the element, and prefer the engineering terms it uses for an embodiment',
  '  over the claim\'s abstractions.',
  '- You are not told which codebase this is and must not guess at one: write no name of',
  '  a product, a library or a project.',
];

/**
 * The system prompt of a form. Static text: nothing of any codebase or technical field may
 * appear in it (test/test_prompt_purity.js holds it to that); what the model learns about
 * the code arrives in the user message, as data.
 */
export function buildTowardCodePrompt(form = 'restate') {
  if (form === 'label') {
    return [
      'You write a search query for a source-code search tool, from one element of a patent claim.',
      '',
      'The tool holds a catalog of the mechanisms of one codebase. Each catalog entry is a',
      'short label, a colon, and the names of some of its functions split into words, as in',
      'SAMPLE ENTRIES. The tool ranks the entries by how close they are to your text. A',
      'patent claim\'s legal wording is far from every entry, even from the entry for code',
      'that does what the claim says; text in the shape and vocabulary of an entry is close',
      'to the entries about the same thing. Your text is used only to search. It is never',
      'read as the claim.',
      '',
      'TASK: write the catalog entry you would expect for code that implements the ELEMENT:',
      'a label in the style of the samples, a colon, then five to eight plausible function',
      'names for that code, split into words as the samples are.',
      '',
      'RULES:',
      '- Describe what the element requires and nothing else. Keep its conditions and inputs',
      '  visible in the label or the names; add no feature it does not state.',
      '- Where the claim names something abstractly, use the concrete term of art that',
      '  engineers in the technical field use for it.',
      '- SAMPLE ENTRIES show the shape and the naming style. They were taken at regular',
      '  intervals through the catalog, not chosen for this claim: do not copy one, and do',
      '  not treat them as the candidates.',
      ...SHARED_RULES,
      '',
      'Output ONLY the entry, on one line: no preamble, no quotation marks, no notes.',
    ].join('\n');
  }
  return [
    'You rewrite one element of a patent claim as a search query for a source-code search tool.',
    '',
    'The tool compares your text with short descriptions of code. A patent claim is written',
    'in a legal register, abstract and general on purpose; code is named in the working',
    'vocabulary of the engineers who wrote it. Text in the claim\'s register does not find',
    'the code, even when the code does what the claim says. Your text is used only to',
    'search. It is never read as the claim, so it does not need claim form.',
    '',
    'TASK: state what the ELEMENT requires, in ONE sentence, in the words an engineer who',
    'implemented it would use.',
    '',
    'RULES:',
    '- Same requirement. Keep every condition, input and relation the element states. Add',
    '  no feature it does not state, and drop none.',
    '- Where the claim names something abstractly, use the concrete term of art that',
    '  engineers in the technical field use for it.',
    ...SHARED_RULES,
    '',
    'Output ONLY the sentence: no preamble, no quotation marks, no notes.',
  ].join('\n');
}

/**
 * The sample entries of the label form: up to `n` of the index's mechanism entries taken at
 * even steps through them, each as the first text --embed-distance embeds for it (the label
 * and its first member names, split into words). Position decides, never the claim: a sample
 * chosen by nearness to the element would hand the model the ranking's own answer.
 */
export function sampleEntryTexts(entries, n = TOWARD_CODE_DEFAULTS.sampleEntries, { chunk = TOWARD_CODE_DEFAULTS.chunk, maxChars = TOWARD_CODE_DEFAULTS.sampleChars } = {}) {
  const list = entries || [];
  if (!list.length || n <= 0) return [];
  const step = Math.max(1, Math.floor(list.length / n));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length && out.length < n; i += step) {
    const t = String(entryChunks(list[i], 'label+members', chunk)[0] || '').replace(/\s+/g, ' ').trim();
    const s = t.length > maxChars ? t.slice(0, maxChars - 1) + '…' : t;
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

/**
 * The user message for one element. The long, fixed parts come first and the element last.
 * `claim` is null for a typed text (the element is all there is); `samples` are sent only in
 * the label form; `spec` only when --spec gave one.
 */
export function buildTowardCodeUser({ element, claim = null, vocabulary = [], samples = [], spec = null, form = 'restate' } = {}) {
  const parts = [];
  if (spec) parts.push(`PATENT SPECIFICATION:\n${String(spec).trim()}`);
  if (claim) parts.push(`WHOLE CLAIM:\n${String(claim).trim()}`);
  parts.push(vocabulary.length
    ? `CODEBASE VOCABULARY (${vocabulary.length} words from the names in this codebase, the most characteristic first):\n${vocabulary.join(', ')}`
    : 'CODEBASE VOCABULARY:\n(none available)');
  if (form === 'label' && samples.length) parts.push(`SAMPLE ENTRIES (${samples.length}, taken at regular intervals through the catalog):\n${samples.join('\n')}`);
  parts.push(`ELEMENT:\n${String(element).trim()}`);
  return parts.join('\n\n');
}

/**
 * One model call per element. Returns a row per element, { original, rewritten, error }: on a
 * failed call, an empty answer or one too short to be a rewrite, `rewritten` is the element
 * as written and `error` says why, so the ranking still has a query for every element and the
 * listing can say which were not reworded. `draft` is (system, user, maxTokens) -> text.
 */
export async function rewriteElements({ draft, elements, claim = null, vocabulary = [], samples = [], spec = null, form = 'restate', maxTokens = TOWARD_CODE_DEFAULTS.maxTokens, onElement = null } = {}) {
  const sys = buildTowardCodePrompt(form);
  const rows = [];
  for (let i = 0; i < elements.length; i++) {
    const original = String(elements[i]);
    let rewritten = '', error = null;
    try {
      rewritten = cleanRewrite(await draft(sys, buildTowardCodeUser({ element: original, claim, vocabulary, samples, spec, form }), maxTokens));
    } catch (e) {
      error = e.message || String(e);
    }
    if (!error && rewritten.length < 12) error = rewritten ? `the answer was too short to be a rewrite ("${rewritten}")` : 'the model returned nothing';
    const row = { original, rewritten: error ? original : rewritten, error };
    rows.push(row);
    if (onElement) onElement(row, i);
  }
  return rows;
}

/** Where a run's rewrites are saved: beside the claim file, named for the form, a specification's presence and the index. */
export function rewriteFilePath(claimFile, { form, indexPath, spec = false } = {}) {
  const p = path.parse(claimFile);
  const ndx = path.basename(path.resolve(indexPath || '.')).replace(/^\.+/, '') || 'index';
  return path.join(p.dir, `${p.name}.toward-code-${form}${spec ? '-spec' : ''}.${ndx}.txt`);
}

/**
 * The saved file: one rewrite per line, in element order, the element as written above each
 * as a `#` comment, and a header saying what made them. It is an elements file
 * (parseElementsFile reads it: `#` lines are comments), so `--toward-code @file` reuses the
 * rewrites with no model call and `--elements @file` ranks by them with no "searched as" line.
 */
export function formatRewriteFile({ rows, form, engine, indexPath, claimSource, vocabularyCount, sampleCount = 0, specFile = null, generatedAt = new Date().toISOString() }) {
  const one = (s) => String(s).replace(/\s+/g, ' ').trim();
  const L = [
    `# --toward-code ${form}: ${rows.length} element${rows.length === 1 ? '' : 's'} of ${claimSource} reworded toward the names of ${indexPath}`,
    `# by ${engine}, ${generatedAt}; given ${vocabularyCount} vocabulary word${vocabularyCount === 1 ? '' : 's'}${sampleCount ? `, ${sampleCount} sample entries` : ''}${specFile ? `, the specification in ${specFile}` : ', no specification'}`,
    '# A rewording is a search query written by a model, not a reading of the claim.',
    '# Reuse with no model call: --embed-distance @<claim> --toward-code @<this file>  (or --semantic-search @<claim> --toward-code @<this file>)',
  ];
  rows.forEach((r, i) => {
    L.push(`# element ${i + 1} as written: ${one(r.original)}`);
    if (r.error) L.push(`# element ${i + 1} was not reworded (${one(r.error)}); the line below is the element as written`);
    L.push(one(r.rewritten));
  });
  return L.join('\n') + '\n';
}

/**
 * Rewrites saved by an earlier run, as rows for `elements`: one line per element, in order.
 * A file with another number of lines than there are elements is refused, since a line would
 * then be searched under the wrong element.
 */
export function readRewriteFile(file, elements) {
  const { elements: lines, comments } = parseElementsFile(fs.readFileSync(file, 'utf8'));
  if (lines.length !== elements.length) throw new Error(`${file} holds ${lines.length} rewrite${lines.length === 1 ? '' : 's'} and there ${elements.length === 1 ? 'is 1 element' : `are ${elements.length} elements`}; a saved file is used with the claim and the split it was made from`);
  const failed = new Set(comments.map((c) => (c.match(/^element (\d+) was not reworded/) || [])[1]).filter(Boolean).map(Number));
  return lines.map((l, i) => ({ original: String(elements[i]), rewritten: l, error: failed.has(i + 1) ? 'not reworded in the saved file' : null }));
}

/** The header line of a reworded run, printed once above the listings. */
export function towardCodeHeader({ form = null, engine = null, file = null, savedTo = null, failed = 0, n = 0 }) {
  const how = file
    ? `--toward-code @${file}: each element is searched by the rewording saved for it`
    : `--toward-code ${form}: each element was reworded toward this codebase's names by ${engine}`;
  const fail = failed ? `; ${failed} of ${n} could not be reworded and ${failed === 1 ? 'is' : 'are'} searched as written` : '';
  const saved = savedTo ? ` Rewrites saved to ${savedTo} (--toward-code @${savedTo} reuses them with no model call).` : '';
  return `${how}${fail}. The ranking is against the rewording, a model's search query and not a reading of the claim: a model told a codebase's words uses them whether or not the code is there, so a good rank here does not show that the code practises the element.${saved}`;
}

/**
 * The option, run from --embed-distance before any embedding model loads. `queries` are the
 * elements, `claimFile` the claim's path (null for a typed text), `entries` the index's
 * mechanism entries. Returns { rows, header } to rank by, { shown: true } after --show-prompt,
 * or null after printing why not (process.exitCode set). `opts.draft` replaces the model in
 * tests.
 */
export async function towardCode(args, { queries, claimFile = null, entries = [], indexPath }, opts = {}) {
  const fail = (msg, code = 2) => { console.error(`--toward-code: ${msg}`); process.exitCode = code; return null; };
  let want;
  try { want = parseTowardCode(args.toward_code); } catch (e) { console.error(e.message); process.exitCode = 2; return null; }

  if (want.file) {
    if (args.spec) return fail('--spec is read when a model writes the rewrites; with @<file> they are already written');
    let rows;
    try { rows = readRewriteFile(want.file, queries); } catch (e) { return fail(e.message); }
    return { rows, header: towardCodeHeader({ file: want.file, failed: rows.filter((r) => r.error).length, n: rows.length }) };
  }
  const form = want.form;

  let spec = null;
  const specFile = args.spec ? String(args.spec).replace(/^@/, '') : null;
  if (specFile) {
    try { spec = fs.readFileSync(specFile, 'utf8').trim(); } catch (e) { return fail(`--spec ${specFile} could not be read (${e.message})`); }
    if (!spec) return fail(`--spec ${specFile} is empty`);
  }
  let claim = null;
  if (claimFile) { try { claim = fs.readFileSync(claimFile, 'utf8').trim(); } catch { claim = null; } }

  const model = opts.model !== undefined ? opts.model : resolveModel(args);
  const local = !!(model && model.kind === 'gguf');
  // The unfiltered concordance of --claim-search, through its one definition; the function's
  // own defaults (topN 300) drop the words this exists to supply.
  const vopt = vocabConcordanceOptions({ args: { no_claim_filter: true }, localModelPath: local ? model.modelPath : null }).options;
  let vocab;
  try { vocab = (opts.vocabulary || cachedVocabularyWords)(indexPath, { ...vopt, maxFuncNames: 0 }); } catch (e) { return fail(e.message); }
  const samples = form === 'label' ? sampleEntryTexts(entries) : [];
  const sys = buildTowardCodePrompt(form);
  const users = queries.map((q) => buildTowardCodeUser({ element: q, claim, vocabulary: vocab.words, samples, spec, form }));

  if (args.show_prompt) {
    printShownPrompts({
      system: sys,
      users: users.map((text, i) => ({ label: `element ${i + 1}`, text })),
      note: `(one model call per element; ${users.length} shown. The model is given the claim, ${vocab.words.length} vocabulary words of ${indexPath}${samples.length ? `, ${samples.length} sample entries` : ''}${spec ? `, and the specification in ${specFile}` : ''}; no source code.)`,
    });
    return { shown: true };
  }

  if (!model) return fail('needs a model to write the rewrites: --llm <provider> or --model <gguf> (or @<file> of rewrites already saved)', 1);
  if (model.kind === 'error') return fail(model.error, 1);
  let draft;
  try { draft = opts.draft || makeDrafter(model, args.temperature ?? 0); } catch (e) { return fail(e.message, 1); }
  const engine = describeEngine(model);
  const when = vocab.generated ? `, cached ${String(vocab.generated).slice(0, 10)}` : '';
  process.stderr.write(`[toward-code] ${queries.length} element(s), form ${form}, engine ${engine}\n`);
  process.stderr.write(`[toward-code] the model is shown the claim, ${vocab.words.length} vocabulary words of ${indexPath} (from vocabulary.json${when})${samples.length ? `, ${samples.length} sample entries` : ''}${spec ? `, and the specification (${specFile}, ${spec.length.toLocaleString('en-US')} characters, in every call)` : ''}; no source code\n`);
  const calls = users.map((u) => ({ inChars: sys.length + u.length, outTokens: 80 }));
  if (!claimsCostGate(model, calls, `toward-code (${calls.length} calls)`, args)) { process.exitCode = 1; return null; }
  resetCloudUsage();

  const rows = await rewriteElements({
    draft, elements: queries, claim, vocabulary: vocab.words, samples, spec, form,
    onElement: (r, i) => process.stderr.write(`[toward-code] element ${i + 1}/${queries.length}${r.error ? `: not reworded (${r.error})` : ''}\n`),
  });
  const cost = actualCostLine(model);
  if (cost) process.stderr.write(`${cost}\n`);
  const failed = rows.filter((r) => r.error).length;
  if (failed === rows.length) return fail(`no element could be reworded (${rows[0].error}); nothing was ranked`, 1);

  let savedTo = null;
  if (claimFile) {
    savedTo = rewriteFilePath(claimFile, { form, indexPath, spec: !!spec });
    try {
      fs.writeFileSync(savedTo, formatRewriteFile({ rows, form, engine, indexPath, claimSource: claimFile, vocabularyCount: vocab.words.length, sampleCount: samples.length, specFile }));
      process.stderr.write(`[toward-code] rewrites saved to ${savedTo}\n`);
    } catch (e) {
      process.stderr.write(`[toward-code] the rewrites could not be saved to ${savedTo} (${e.message}); they are in the listing\n`);
      savedTo = null;
    }
  }
  return { rows, header: towardCodeHeader({ form, engine, savedTo, failed, n: rows.length }) };
}
