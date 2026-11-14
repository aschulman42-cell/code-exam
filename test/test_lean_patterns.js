// test_lean_patterns.js — Lean 4 at the regex tier: declarations by keyword, names with dots, primes and Unicode, ends by indentation, tactic lines and comments never definitions, structures and inductives as data structures
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// lean-regex-patterns (2026-11-13). Before this, `.lean` was not indexed by
// default and an admitted file fell to the generic C and Python patterns, which
// on a Mathlib-style number-theory corpus found 36% of the declarations (def
// 68%, theorem 27%, lemma 24%) and filled 39% of the entries with tactic lines
// (`exact foo (x)`, `apply bar (y)`) read as function definitions, each
// truncating the theorem above it. This file is the fixture for that class.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { familyForExt, maskCodeLines } from '../src/core/function-bounds.js';
import { extractDataStructures } from '../src/core/data-structs.js';
import { DEFAULT_EXTENSIONS } from '../src/utils.js';

const TMP = path.join(os.tmpdir(), 'ce_test_lean_patterns');

function parse(filename, source) {
  const idx = new CodeSearchIndex({ indexPath: path.join(TMP, '.unused') });
  idx.fileLines = new Map([[filename, source.split('\n')]]);
  return idx._parseFunctionsRegex(filename);
}

const SRC = [
  'import Mathlib.NumberTheory.Basic',                                            // 1
  '',
  '/-- A docstring that mentions theorem fake_in_doc (x : ℕ) : True and must not count. -/',
  'theorem closes_on_line (x : ℕ) (h : 0 < x)',                                  // 4
  '    : 0 < x + 1 := by',
  '  exact Nat.succ_pos x',                                                       // 6
  '',
  'theorem ends_in_colon :',                                                      // 8
  '    ∀ n : ℕ, n ≤ n := by',
  '  intro n',
  '  exact le_refl n',                                                            // 11
  '',
  'lemma a_lemma (n : ℕ) : n + 0 = n := by',                                      // 13
  '  simp',                                                                       // 14
  '',
  'def withBinders (n : ℕ) : ℕ :=',                                              // 16
  '  n + 1',                                                                      // 17
  '',
  'def noBinders : ℕ := 5',                                                       // 19
  '',
  'noncomputable def nc (x : ℝ) : ℝ := x',                                        // 21
  '',
  'abbrev Idx := Fin 3',                                                          // 23
  '',
  'instance namedInst : Inhabited Idx := ⟨0⟩',                                    // 25
  '',
  'instance : ToString Idx where',                                                // 27
  '  toString i := s!"{i.val}"',                                                  // 28
  '',
  'instance (priority := low) : Nonempty Idx := ⟨default⟩',                       // 30
  '',
  'structure Point where',                                                        // 32
  '  x : ℕ',
  '  y : ℕ',                                                                      // 34
  '',
  'inductive Color where',                                                        // 36
  '  | red',
  '  | green',                                                                    // 38
  '',
  'class Shape (α : Type) where',                                                 // 40
  '  area : α → ℕ',                                                               // 41
  '',
  '@[simp] theorem simp_same_line (p : Point) : p.x = p.x := rfl',                // 43
  '',
  '@[simp, norm_cast]',                                                           // 45
  'theorem attr_above (n : ℕ) : (n : ℤ) = n := by',                               // 46
  '  simp',                                                                       // 47
  '',
  'private theorem hidden : True := trivial',                                     // 49
  '',
  'protected def Point.sum (p : Point) : ℕ := p.x + p.y',                         // 51
  '',
  "theorem prime' (n : ℕ) : n = n := rfl",                                        // 53
  '',
  'theorem hζ_unicode (ζ : ℕ) : ζ = ζ := rfl',                                    // 55
  '',
  'namespace Point',                                                              // 57
  '',
  'theorem in_namespace (p : Point) : p.x + 0 = p.x := by',                       // 59
  '  have h : p.x = p.x := rfl',
  '  let z := p.y',
  '  apply Nat.add_zero (p.x)',
  '  exact Nat.lt_irrefl (z)',                                                    // 63
  '',
  'end Point',                                                                    // 65
  '',
  'section Indented',                                                             // 67
  '',
  '  theorem indented_decl (n : ℕ) : n = n := by',                                // 69
  '    exact rfl',                                                                // 70
  '',
  'end Indented',                                                                 // 72
  '',
  '/- a block comment with theorem fake_in_block (x) : True := trivial -/',       // 74
  '',
  'theorem one_liner : True := trivial -- theorem fake_in_comment (x) : True := trivial', // 76
  '',
  'theorem after_one_liner (n : ℕ) : n = n := rfl',                               // 78
  '',
  'example : True := trivial',                                                    // 80
  '',
  'macro "mytac" : tactic => `(tactic| trivial)',                                 // 82
  '',
  'notation "⟪" x "⟫" => x',                                                      // 84
  '',
  'theorem with_calc (a b : ℕ) (h : a = b) : a + 0 = b := by',                    // 86
  '  calc a + 0 = a := Nat.add_zero a',
  '    _ = b := h',                                                               // 88
  '',
  'theorem last_decl : True := by',                                               // 90
  '  trivial',                                                                    // 91
  '',
].join('\n');

const EXPECTED_FUNCTIONS = {
  closes_on_line: [4, 6], ends_in_colon: [8, 11], a_lemma: [13, 14], withBinders: [16, 17],
  noBinders: [19, 19], nc: [21, 21], Idx: [23, 23], namedInst: [25, 25],
  instance: [27, 28], 'instance@30': [30, 30],
  simp_same_line: [43, 43], attr_above: [46, 47], hidden: [49, 49], 'Point.sum': [51, 51],
  "prime'": [53, 53], 'hζ_unicode': [55, 55], in_namespace: [59, 63], indented_decl: [69, 70],
  one_liner: [76, 76], after_one_liner: [78, 78], with_calc: [86, 88], last_decl: [90, 91],
};
const EXPECTED_TYPES = { Point: [32, 34], Color: [36, 38], Shape: [40, 41] };

describe('Lean 4 at the regex tier', () => {
  it('.lean is indexed by default and has a masking family that ends by indentation', () => {
    assert.ok(DEFAULT_EXTENSIONS.has('.lean'), '.lean must be in DEFAULT_EXTENSIONS');
    assert.equal(familyForExt('.lean'), 'lean');
  });

  it('masks -- line comments, /- block -/ and /-- doc -/ comments and "strings", and keeps primes', () => {
    const masked = maskCodeLines([
      'theorem one_liner : True := trivial -- theorem fake (x) : True',
      '/-- doc with theorem fake2 (y) -/',
      "theorem prime' (n : ℕ) : n = n := rfl",
      'instance : ToString Idx where',
      '  toString i := "theorem fake3 (z)"',
    ], 'lean');
    assert.doesNotMatch(masked[0], /fake/);
    assert.match(masked[0], /^theorem one_liner : True := trivial/);
    assert.doesNotMatch(masked[1], /theorem/);
    assert.equal(masked[2], "theorem prime' (n : ℕ) : n = n := rfl", 'a prime is not a string delimiter');
    assert.doesNotMatch(masked[4], /fake3/);
  });

  it('every declaration is an entry with its name as written and its kind; nothing else is', () => {
    const got = parse('Geometry/Point.lean', SRC);
    const names = Object.keys(got).sort();
    const expected = [...Object.keys(EXPECTED_FUNCTIONS), ...Object.keys(EXPECTED_TYPES)].sort();
    assert.deepEqual(names, expected, `entries differ:\n  extra: ${names.filter((n) => !expected.includes(n)).join(', ')}\n  missing: ${expected.filter((n) => !names.includes(n)).join(', ')}`);
    for (const name of Object.keys(EXPECTED_FUNCTIONS)) assert.equal(got[name].type, 'function', `${name} is a function`);
    for (const name of Object.keys(EXPECTED_TYPES)) assert.equal(got[name].type, 'class', `${name} is a type`);
    assert.equal(Object.keys(got).length, 25, 'entry count equals the declaration count');
  });

  it('tactic lines, comments, docstrings, example, macro, notation, namespace and section are never definitions', () => {
    const got = parse('Geometry/Point.lean', SRC);
    const bad = Object.keys(got).filter((n) => /fake|^Nat\.|^le_refl|^(?:exact|apply|have|let|example|macro|notation|namespace|section|end|import|mytac|Indented|Mathlib\.NumberTheory\.Basic)(?:@\d+)?$/.test(n));
    assert.deepEqual(bad, [], `phantom entries: ${bad.join(', ')}`);
  });

  it('ends by indentation: the last line indented under the keyword line; a one-liner ends on its own line', () => {
    const got = parse('Geometry/Point.lean', SRC);
    for (const [name, [start, end]] of Object.entries({ ...EXPECTED_FUNCTIONS, ...EXPECTED_TYPES })) {
      assert.equal(got[name].start, start, `${name} starts at ${start}`);
      assert.equal(got[name].end, end, `${name} ends at ${end}`);
    }
  });

  it('an attribute on its own line is not part of the entry; a same-line attribute is skipped over', () => {
    const got = parse('Geometry/Point.lean', SRC);
    assert.equal(got.attr_above.start, 46, 'the entry starts at the keyword line, below the @[simp, norm_cast] line');
    assert.equal(got.simp_same_line.start, 43);
  });

  it('an indented declaration inside a section is not nested under the type declared above it', () => {
    const got = parse('Geometry/Point.lean', SRC);
    assert.ok(got.indented_decl, 'indented_decl is a plain entry');
    assert.equal(Object.keys(got).find((n) => n.includes('::')), undefined, 'no Type::name nesting for Lean');
    assert.equal(got.indented_decl.base_name, 'indented_decl');
  });

  it('an anonymous instance with binders in braces or brackets before the colon is still an instance', () => {
    // 194 of 2,476 instances on the number-theory corpus had this shape and were missed
    // by a pattern that allowed only parenthesized binders (2026-11-13).
    const got = parse('Geometry/Inst.lean', [
      'instance {α : Type*} [Fintype α] : Nonempty (Finset α) := ⟨∅⟩',
      'instance (n : ℕ) [NeZero n] : Inhabited (Fin n) := ⟨0⟩',
      'instance ⦃K : Type*⦄ [Field K] {p : ℕ} [Fact p.Prime] : Foo K p where',
      '  bar := 0',
      'instance named [Fintype α] : Baz α := ⟨⟩',
      '',
    ].join('\n'));
    assert.deepEqual(Object.keys(got).sort(), ['instance', 'instance@2', 'instance@3', 'named'].sort());
    assert.equal(got['instance@3'].end, 4);
  });

  it('structure, inductive and class reach the Data Structures view with their kinds', () => {
    const idx = { fileLines: new Map([['Geometry/Point.lean', SRC.split('\n')]]) };
    const defs = extractDataStructures(idx);
    const byName = Object.fromEntries(defs.map((d) => [d.name, d.kind]));
    assert.equal(byName.Point, 'structure');
    assert.equal(byName.Color, 'inductive');
    assert.equal(byName.Shape, 'class');
    assert.equal(defs.filter((d) => /fake/.test(d.name)).length, 0);
    // The detector reads raw lines: a docstring line that begins with a keyword
    // is prose (on the number-theory corpus, "class of actual discrete windows"
    // became a class named `of` with 9,242 references).
    const prose = extractDataStructures({ fileLines: new Map([['Geometry/Window.lean', [
      '/-- Every discrete window belongs to a',
      'class of actual discrete windows, including nonunit classes. -/',
      'structure Window where',
      '  w : ℕ',
      'inductive Kind : Type where',
      '  | unit',
      'structure Legacy :=',
      '  (n : ℕ)',
      'class Measurable (α : Type) extends Inhabited α where',
      '  m : α → ℕ',
    ]]]) });
    assert.deepEqual(prose.map((d) => d.name).sort(), ['Kind', 'Legacy', 'Measurable', 'Window']);
  });
});
