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

// Every pattern is anchored at a token boundary so look-alikes stay in: attest, latest,
// contest, testimony, benchley, mockingbird, exampleless, Testament, Fakespot. `!` is the
// separator between a zip file and a member inside it.
const TEST_DIR_RE = {
  test: /(?:^|[\\/!])(?:test|tests|testing|testdata|androidTest|__tests__|spec|specs)[\\/]/i,
  bench: /(?:^|[\\/!])(?:bench|benches|benchmark|benchmarks)[\\/]/i,
  mock: /(?:^|[\\/!])(?:mock|mocks|__mocks__|fakes|stubs)[\\/]/i,
  example: /(?:^|[\\/!])(?:example|examples|samples)[\\/]/i,
};
// On the basename without its extension (`foo.test` for foo.test.js).
const TEST_STEM_RE = {
  test: /^(?:tests?|testutils?|testing)(?:$|[_.\-])|[_.\-](?:tests?|spec)$/i,
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

/** One line for a listing's header saying what an option left out: "--exclude-tests: 49 files of test, benchmark, mock and example code left out". Empty when nothing was. */
export function testsLeftOutLine(args, left, what = 'files') {
  if (!leavesTestsOut(args) || !left) return '';
  return `${testOptionGiven(args)}: ${Number(left).toLocaleString('en-US')} ${left === 1 ? what.replace(/s$/, '') : what} of test, benchmark, mock and example code left out`;
}

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
  hotspots: '--hotspots', entry_points: '--entry-points', gaps: '--gaps', domain_fns: '--domain-fns',
  list_classes: '--list-classes', class_hotspots: '--class-hotspots', data_structs: '--data-structs',
};

/** The AI/ML listings (--models-used, --training, --inference and the rest), which drop the records their detectors tagged as test or example code. */
export const AIML_LISTING_KEYS = ['list_models', 'list_artifacts', 'list_kernels', 'list_multimodal', 'list_post_training', 'list_reasoning', 'list_datasets', 'list_training', 'list_inference', 'list_llm_calls', 'list_tools', 'list_chains', 'list_embeddings', 'list_structured_output', 'list_models_used', 'list_pipelines', 'list_explainability'];

/**
 * When --exclude-tests or --no-tests was given and no command in the run reads it, one
 * line saying so and naming what does; '' otherwise. `isSet(key)` says whether the
 * command with that argument key is being run (some are set by presence, some by value,
 * which the caller knows). A run with one command that reads the option and one that does
 * not gets no note: the option did something.
 */
export function unreadTestOptionNote(args, isSet) {
  if (!leavesTestsOut(args)) return '';
  if ([...Object.keys(TEST_OPTION_READERS), ...AIML_LISTING_KEYS].some((k) => isSet(k))) return '';
  return `# ${testOptionGiven(args)} does nothing here: no command in this run reads it, and no test code was left out. It is read by the text searches (--search, --regex, --literal, --fast, --files-search, --folders-search), --multisect-search, the listings (--list-files, --list-functions, --list-classes, --most-called, --hotspots, --entry-points, --gaps, --domain-fns, --class-hotspots, --data-structs) and the AI/ML listings. --exclude-path <text> leaves out any path. The claim tools and --semantic-search leave test code out unless --include-tests is given.`;
}
