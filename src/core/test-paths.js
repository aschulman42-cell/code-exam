// test-paths.js — one rule for "this file is test code", and the two options that leave such files out of a listing
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// multisect-test-options-do-nothing (2026-11-19). Andrew ran
//   ce --ndx .CE --multisect "gguf;gapped;local;cuda" --exclude-tests
// and again with --no-tests; both were accepted and the results still listed test/ with
// its test_*.js files. Multisect read neither option. Nor did the text searches or the
// file and function listings; --callers and the --hotspots family read --exclude-tests as
// "the path contains the letters test" (so latest.js went and examples/ stayed), and
// --no-tests was read only by the AI/ML listings.
//
// Here: the path rule the claim tools already used (it was in claim-locate.js, beside the
// rule for symbol names, and --include-tests is its other face), the one predicate every
// listing applies, and the note for a command that reads neither option. The two options
// mean the same thing everywhere they are read: leave test, benchmark, mock and example
// files out. Nothing is left out unless one of them is given.
//
// test-options-remaining-commands part E (2026-11-23). THE RULE, stated once, for every
// command and every surface that decides what is test code:
//   a file       is test code by its path (testPathClass: a test, bench, mock or example
//                directory, or a file name of that shape);
//   a function or other symbol is test code by its path, its name, or a test attribute
//                above it (testSymbolClass / isTestSymbol: rule one, plus names such as
//                test_sign, FooTest, MockClock, plus `#[test]`);
//   a group of functions (a mechanism) is test code when it has members and every member is
//                (isTestEntry), decided when the listing is made and not by the tag the
//                build wrote.
// Two families of command use it. Those that find exactly what was typed (the searches, the
// listings, callers, callees) list everything unless --exclude-tests or --no-tests is given.
// Those that rank or summarise (--mechanisms, --toc, --carve, --semantic-search, the claim
// tools) leave test code out unless --include-tests is given. Either way a command that left
// anything out ends with one line, testsTip, saying how many and what lists them.

// Every pattern is anchored at a token boundary so look-alikes stay in: attest, latest,
// contest, testimony, benchley, mockingbird, exampleless, Testament, Fakespot. `!` is the
// separator between a zip file and a member inside it.
const TEST_DIR_RE = {
  test: /(?:^|[\\/!])(?:test|tests|testing|testdata|androidTest|__tests__|spec|specs|conftest)[\\/]/i,
  bench: /(?:^|[\\/!])(?:bench|benches|benchmark|benchmarks)[\\/]/i,
  mock: /(?:^|[\\/!])(?:mock|mocks|__mocks__|fakes|stubs)[\\/]/i,
  example: /(?:^|[\\/!])(?:example|examples|samples)[\\/]/i,   // not demo/: the claim tools' demo corpus is a directory of that name (test_claim_analyze.js); the AI/ML tag adds demos/ itself (ai-ml-detectors.js)
};
// On the basename without its extension (`foo.test` for foo.test.js).
const TEST_STEM_RE = {
  test: /^(?:tests?|testutils?|testing|conftest)(?:$|[_.\-])|[_.\-](?:tests?|spec)$/i,
  bench: /^bench(?:$|[_.\-]|marks?$)|[_.\-]bench(?:marks?)?$/i,
  mock: /^(?:mocks?|fakes?|stubs?)(?:$|[_.\-])|[_.\-](?:mocks?|fakes?|stubs?)$/i,
  example: /^examples?(?:$|[_.\-])/i,
};
const TEST_STEM_CASED_RE = /^Tests?[A-Z]|Tests?$/;       // TestToken.sol, FooTest.java

/** The class a file's path puts it in (`test`, `bench`, `mock`, `example`) by a directory on the path or by the file's name, or null. */
export function testPathClass(filepath) {
  const fp = String(filepath || '');
  if (!fp) return null;
  for (const c of ['test', 'bench', 'mock', 'example']) if (TEST_DIR_RE[c].test(fp)) return c;
  const base = fp.split(/[\\/!]/).pop() || '';
  const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
  if (TEST_STEM_CASED_RE.test(stem)) return 'test';
  for (const c of ['test', 'bench', 'mock', 'example']) if (TEST_STEM_RE[c].test(stem)) return c;
  return null;
}

/** True when the path is test, benchmark, mock or example code by testPathClass. */
export const isTestPath = (filepath) => testPathClass(filepath) !== null;

/** The two options that ask for test code to be left out; either one, the same meaning. */
export const leavesTestsOut = (args) => !!(args && (args.exclude_tests || args.no_tests));

/** Which of the two the user typed, for a message: `--exclude-tests`, `--no-tests`, or both. */
export const testOptionGiven = (args) => [args && args.exclude_tests ? '--exclude-tests' : null, args && args.no_tests ? '--no-tests' : null].filter(Boolean).join(' / ');

/**
 * `items` without those in test code, when one of the two options was given. `pathOf`
 * reads an item's file path. Returns { kept, left }: `left` is how many were left out
 * (0 when neither option was given, and then `kept` is `items` itself).
 */
export function withoutTests(items, args, pathOf = (x) => x) {
  if (!leavesTestsOut(args)) return { kept: items, left: 0 };
  const kept = items.filter((x) => !isTestPath(pathOf(x)));
  return { kept, left: items.length - kept.length };
}

import { isTestAttributedIn } from './test-attribute.js';

// ---- the symbol rule (moved here from claim-locate.js, test-options-remaining-commands part E1) ----
// Test/mock/fake code, by symbol name OR by living under a test source root.
// Matches "Test" at a segment END too (`DrmPlaybackTest::clearkeyPlayback_…`),
// which an earlier segment-START-only pattern missed.
// claim-locate-test-filter-by-filename (2026-10-22). The gate was keyed on a
// `test/` directory or a Test|Mock|Fake|Stub token at the END of a name
// segment, so a project that keeps its tests, benches, mocks and examples
// beside the sources (secp256k1: src/tests.c, src/testutil.h, src/bench.c,
// examples/examples_util.h) had them chosen as implementers (Foundry 1-11
// blind, 2026-10-21: four of sixteen), and a marker at the START of a segment
// passed (`FakeGroup::size`, `TestToken.sol`, 2026-10-22). Every pattern is
// anchored at a token boundary so look-alikes stay in. On each `::`-separated segment of
// the symbol name: a marker at the end (RateChooserTest), at the start followed by a
// capital (FakeGroup), or as a snake_case word (test_sign, run_test, bench_sign_run).
const TEST_NAME_RE = {
  test: /(?:^|::)(?:[A-Za-z0-9_]*Tests?|Tests?[A-Z][A-Za-z0-9_]*|tests?_[A-Za-z0-9_]*|[A-Za-z0-9_]*_tests?)(?:$|::)/,
  bench: /(?:^|::)(?:bench_[A-Za-z0-9_]*|[A-Za-z0-9_]*_bench)(?:$|::)/,
  mock: /(?:^|::)(?:[A-Za-z0-9_]*(?:Mock|Fake|Stub)|(?:Mock|Fake|Stub)[A-Z][A-Za-z0-9_]*|(?:mock|fake|stub)_[A-Za-z0-9_]*|[A-Za-z0-9_]*_(?:mock|fake|stub))(?:$|::)/,
};
/** The class that holds a symbol back (test, bench, mock or example), or null: a test mark, the symbol's name, then its file's path. */
export function testSymbolClass(s) {
  // Marked where the symbol was made (the symbol table, the function corpus, a
  // mechanisms member): a test attribute stands above it in a source file, the
  // one kind of test neither a name nor a path gives away (test-attribute.js).
  if (s && s.test === true) return 'test';
  const name = (s && s.name) || '';
  for (const c of ['test', 'mock', 'bench']) if (TEST_NAME_RE[c].test(name)) return c;
  return testPathClass(s && s.filepath);
}
/** True when the function or other symbol { name, filepath, test } is test code by path, name or attribute. */
export function isTestSymbol(s) {
  return testSymbolClass(s) !== null;
}
/** True when a group of functions (a mechanism, with `members` of { name, file, test }) has members and every one is test code by isTestSymbol. */
export function isTestEntry(e) {
  const ms = (e && e.members) || [];
  return ms.length > 0 && ms.every((m) => isTestSymbol({ name: m.name, filepath: m.file, test: m.test === true }));
}

// ---- the closing line (part E4) ----
const singularOf = (noun) => { const s = String(noun), e = s.replace(/(ss|ch|sh|x)es$/, '$1'); return e !== s ? e : s.replace(/s$/, ''); };
/**
 * The ONE closing line of every command that left test code out, whether by default or because
 * an option asked: '' when `n` is 0. `o.option` (the option the user typed, `testOptionGiven`)
 * selects the form for a command that lists everything unless asked; without it the form is
 * the default one, and `o.include` names what lists the test code (`--include-tests`, or
 * `include_tests: true` for an MCP tool). `o.atLeast` says the count is a lower bound.
 */
export function testsTip(n, noun, o = {}) {
  // `o.also`: [[count, noun], ...], other things the command left out (semantic search: test functions inside the groups it kept)
  const parts = [[n, noun], ...(o.also || [])].filter(([c]) => c > 0);
  if (!parts.length) return '';
  const one = parts.length === 1 && parts[0][0] === 1 && !o.atLeast;
  const count = parts.map(([c, w], i) => `${o.atLeast && i === 0 ? 'at least ' : ''}${Number(c).toLocaleString('en-US')} ${c === 1 && !(o.atLeast && i === 0) ? singularOf(w) : w}`).join(' and ');
  const what = `${count} of test, benchmark, mock and example code left out`;
  if (o.option) return `Tip: ${what} (${o.option}); run without it to list ${one ? 'it' : 'them'}.`;
  return `Tip: ${what}; ${o.include || '--include-tests'} lists ${one ? 'it' : 'them'}.`;
}
/** testsTip for a command that reads --exclude-tests / --no-tests: `left` things of kind `noun`, naming the option typed. */
export const optionTestsTip = (args, left, noun, o = {}) => (leavesTestsOut(args) ? testsTip(left, noun, { ...o, option: testOptionGiven(args) }) : '');
/** Print a closing Tip as the last line of a command's output: a blank line, then the line; nothing when `tip` is ''. `endsBlank` when the output already ends with a blank line. */
export function printTip(tip, endsBlank = false) {
  if (!tip) return;
  if (!endsBlank) console.log('');
  console.log(tip);
}
/**
 * `functions` ({ name, filepath, start }) without those that are test code by the one rule for a
 * function: its file's path, its name, or a test attribute above it. `index` supplies the source
 * lines the attribute is read from. Returns { kept, left }; with neither option, everything and 0.
 */
export function functionsWithoutTests(index, functions, args) {
  if (!leavesTestsOut(args)) return { kept: functions, left: 0 };
  const kept = functions.filter((f) => !isTestSymbol({ name: f.name, filepath: f.filepath, test: isTestAttributedIn(index, f.filepath, f.start) }));
  return { kept, left: functions.length - kept.length };
}
/** How many of an index's files are test code by isTestPath (the count a whole-index search leaves out). */
export const indexTestFileCount = (index) => (index && index.files ? [...index.files.keys()].filter(isTestPath).length : 0);

/**
 * The commands that read --exclude-tests and --no-tests, by the key each sets in the
 * parsed arguments, with the option a user types. A command not here accepts the two
 * options and does nothing with them, and unreadTestOptionNote says so.
 */
export const TEST_OPTION_READERS = {
  search: '--search', literal: '--literal', fast: '--fast', regex: '--regex',
  files_search: '--files-search', folders_search: '--folders-search',
  multisect_search: '--multisect-search',
  list_files: '--list-files', list_functions: '--list-functions', list_functions_alpha: '--list-functions-alpha', list_functions_size: '--list-functions-size',
  most_called: '--most-called',
  callers: '--callers', callees: '--callees',   // test-options-remaining-commands (2026-11-23)
  multisect_analyze: '--multisect-analyze', claim_search: '--claim-search', claim_analyze: '--claim-analyze', claims_loop: '--claims-loop',
  hotspots: '--hotspots', entry_points: '--entry-points', gaps: '--gaps', domain_fns: '--domain-fns',
  list_classes: '--list-classes', class_hotspots: '--class-hotspots', data_structs: '--data-structs',
};

/** The AI/ML listings (--models-used, --training, --inference and the rest), which drop the records their detectors tagged as test or example code. */
export const AIML_LISTING_KEYS = ['list_models', 'list_artifacts', 'list_kernels', 'list_multimodal', 'list_post_training', 'list_reasoning', 'list_datasets', 'list_training', 'list_inference', 'list_llm_calls', 'list_tools', 'list_chains', 'list_embeddings', 'list_structured_output', 'list_models_used', 'list_pipelines', 'list_explainability'];

/**
 * The listings that leave test rows out unless --include-tests is given (--mechanisms,
 * --toc, --show-function-text). Given --exclude-tests or --no-tests they do what was asked already, so the
 * note below, which says no test code was left out, would be false for them.
 */
export const TESTS_OUT_BY_DEFAULT_KEYS = ['mechanisms', 'toc', 'show_function_text'];

/**
 * Commands that accept the two options and deliberately do not read them, by argument
 * key, with the option a user types and the reason (test-options-remaining-commands,
 * 2026-11-23). A run that names one of these hears about it whether or not another
 * command in the run reads the options.
 */
export const TEST_OPTION_NON_READERS = {
  call_tree: { flag: '--call-tree', why: 'a tree with branches left out would look complete when it is not, so every branch is shown, test code included' },
};

/**
 * When --exclude-tests or --no-tests was given and a command in the run does not read
 * it, a line saying so and naming what does; '' otherwise. `isSet(key)` says whether the
 * command with that argument key is being run (some are set by presence, some by value,
 * which the caller knows). The note is per command: a run of one command that reads the
 * option and one that does not (TEST_OPTION_NON_READERS) names the one that did not. A
 * run whose commands all read it, or that names none of the known non-readers and has a
 * reader, gets no note. Only the commands in TEST_OPTION_NON_READERS can be named; any
 * other command is known only as "not a reader" when no reader is in the run.
 */
export function unreadTestOptionNote(args, isSet) {
  if (!leavesTestsOut(args)) return '';
  const readers = [...Object.keys(TEST_OPTION_READERS), ...AIML_LISTING_KEYS, ...TESTS_OUT_BY_DEFAULT_KEYS].filter((k) => isSet(k));
  const nonReaders = Object.keys(TEST_OPTION_NON_READERS).filter((k) => isSet(k));
  const given = testOptionGiven(args);
  const reasons = nonReaders.map((k) => `${TEST_OPTION_NON_READERS[k].flag} does not read it: ${TEST_OPTION_NON_READERS[k].why}.`).join(' ');
  if (readers.length && !nonReaders.length) return '';
  if (readers.length) {
    const names = nonReaders.map((k) => TEST_OPTION_NON_READERS[k].flag).join(', ');
    const read = readers.map((k) => TEST_OPTION_READERS[k] || `--${k.replace(/_/g, '-')}`).join(', ');
    return `# ${given} was not read by ${names}: ${nonReaders.map((k) => TEST_OPTION_NON_READERS[k].why).join('; ')}. It was read by ${read}.`;
  }
  return `# ${given} does nothing here: no command in this run reads it, and no test code was left out. ${reasons ? reasons + ' ' : ''}It is read by the text searches (--search, --regex, --literal, --fast, --files-search, --folders-search), --multisect-search, --multisect-analyze, --claim-search, --claim-analyze, --claims-loop, --callers, --callees, the listings (--list-files, --list-functions, --list-classes, --most-called, --hotspots, --entry-points, --gaps, --domain-fns, --class-hotspots, --data-structs) and the AI/ML listings. --exclude-path <text> leaves out any path. The claim tools, --semantic-search, --mechanisms and --toc leave test code out unless --include-tests is given.`;
}
