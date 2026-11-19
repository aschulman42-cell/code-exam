// test-attribute.js — is a function marked as a test by an attribute written above it?
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// A Rust test lives in the source file it tests, under `#[test]`, and is named like a
// sentence (`posting_does_not_settle_when_ledger_is_empty`). Neither its path nor its name
// says "test", so a rule that reads names and paths (isTestSymbol, claim-locate.js) cannot
// see it. This rule reads the lines above the declaration instead.
//
// It began in the mechanisms grouper (#291 Part A, where 46 such functions became a
// candidate "class" and then a drafted claim on writing tests) and was the grouper's alone
// until 2026-11-19, when a snapshot of Bram showed 78 of them reaching search results and
// claim candidates with none held back. It lives here so the symbol table, the function
// corpus and the grouper mark the same functions.
//
// What it sees: `#[test]`, `#[<path>::test]` (`#[tokio::test]`) with or without arguments,
// and a `#[cfg(test)]` opener, on the declaration line or the three lines above it.
// What it does not see, by design until measured: `#[rstest]`, `#[test_case(..)]`,
// `#[wasm_bindgen_test]`, `#[bench]`; a helper function inside a `#[cfg(test)] mod` that
// carries no attribute of its own and sits more than three lines below the opener; and
// the test annotations of other languages (C# `[Fact]`, Java `@Test`), whose tests are
// usually caught by file or class name.

const TEST_ATTRIBUTE_RE = /^#\[(?:\w+(?:::\w+)*::)?test(?:\]|\()/;
const CFG_TEST_RE = /^#\[cfg\(test\)\]/;

/**
 * True when one of the four lines ending at `startLine` (1-based, the declaration's line as
 * the index records it) is a test attribute. `lines` is the file as an array of lines.
 */
export function isTestAttributedFunction(lines, startLine) {
  if (!Array.isArray(lines)) return false;
  for (let i = Math.max(0, startLine - 4); i < Math.min(lines.length, startLine); i++) {
    const t = String(lines[i] || '').trim();
    if (TEST_ATTRIBUTE_RE.test(t) || CFG_TEST_RE.test(t)) return true;
  }
  return false;
}

/** The same question asked of an index: `index.fileLines` is a Map of file to lines, when it is there at all. */
export function isTestAttributedIn(index, file, startLine) {
  const fl = index && index.fileLines;
  if (!fl || typeof fl.get !== 'function' || startLine == null) return false;
  return isTestAttributedFunction(fl.get(file), startLine);
}
