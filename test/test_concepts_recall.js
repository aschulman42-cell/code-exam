// test_concepts_recall.js — the arithmetic of scripts/concepts-recall.mjs (issue-364-concepts-doc-and-accuracy)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// The script measures how many words from a codebase's own README and docs headings turn up among
// its concepts. These tests fix its rules, which were written before any result was looked at:
// what a heading is, which words of a heading are terms, when a term and a concept are the same
// word, and how the shares are counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDocSource, headingsOf, termsOf, sameWord, recallReport, GENERIC_HEADING_WORDS } from '../scripts/concepts-recall.mjs';

test('concepts-recall: which indexed files are documentation', () => {
  for (const p of ['README.md', 'readme.txt', 'README.rst', 'pkg.zip!pkg-main/README.md', 'docs/guide.md', 'a/doc/intro.md', 'documentation/x.rst']) assert.ok(isDocSource(p), p);
  for (const p of ['src/readme_parser.js', 'docs/api.json', 'notes.md', 'node_modules/x/README.md', 'vendor/y/README.md', 'tests/README.md', 'examples/demo/README.md', 'CHANGELOG.md']) assert.ok(!isDocSource(p), p);
  // the vocabulary counts these, so their headings are not independent of the concepts
  for (const p of ['README', 'readme', 'docs/x.markdown', 'README.html']) assert.ok(!isDocSource(p), p);
});

test('concepts-recall: headings are ATX and underlined lines outside code fences, with markup taken off', () => {
  const md = ['# Track selection in `ExoPlayer`', 'text', '', 'Adaptive bitrate', '----------------', '```', '# not a heading, a comment in a code block', '```', '## [DRM sessions](drm.md) ##', '#hashtag is not a heading', '~~~', '## nor this', '~~~', '### **Bold** _one_'].join('\n');
  assert.deepEqual(headingsOf(md), ['Track selection in ExoPlayer', 'Adaptive bitrate', 'DRM sessions', 'Bold one']);
});

test('concepts-recall: terms are the pieces of a heading\'s words, without English and documentation words', () => {
  const t = termsOf(['Getting started', 'Installing the WorklistPane', 'Track selection', 'track_selection options', 'Usage']);
  assert.deepEqual([...t.keys()].sort(), ['pane', 'selection', 'track', 'worklist']);
  assert.equal(t.get('track'), 2, 'counted once per heading');
  assert.equal(t.get('worklist'), 1);
  for (const w of ['installation', 'usage', 'license', 'contributing', 'overview']) assert.ok(GENERIC_HEADING_WORDS.has(w), w);
});

test('concepts-recall: a term and a concept are the same word when equal, or when one begins the other and the shorter is five letters or more', () => {
  assert.ok(sameWord('multisect', 'multisect'));
  assert.ok(sameWord('faithful', 'faithfulness') && sameWord('stations', 'station'));
  assert.ok(!sameWord('cot', 'cotton'), 'three letters is too short to stand for a longer word');
  assert.ok(!sameWord('play', 'player'), 'four letters too');
  assert.ok(!sameWord('track', 'racktrack'), 'a beginning, not any part');
});

test('concepts-recall: shares at each cut, exact and by the same-word rule, and where the misses are', () => {
  const terms = new Map([['multisect', 3], ['faithful', 2], ['worklist', 1], ['zeppelin', 1]]);
  const concepts = ['multisect', 'exam', 'faithfulness', 'worklist'];
  const vocabPieces = new Set(['multisect', 'exam', 'faithfulness', 'worklist', 'drift']);
  const r = recallReport({ terms, concepts, vocabPieces, ks: [1, 2, 3] });
  assert.equal(r.terms, 4);
  assert.deepEqual(r.at.map((a) => [a.k, a.exact.hits, a.same.hits]), [[1, 1, 1], [2, 1, 1], [3, 1, 2]]);
  assert.equal(r.at[2].same.recall, 0.5);
  assert.deepEqual([r.all.exact.hits, r.all.same.hits], [2, 3]);
  assert.equal(r.inVocabulary.hits, 3, 'faithful is in the vocabulary as faithfulness; zeppelin is not there at all');
  assert.deepEqual(r.missed.notInVocabulary, ['zeppelin']);
  assert.deepEqual(r.missed.inVocabularyNotAConcept, []);
  // a term found twice among the concepts is one hit, not two
  const twice = recallReport({ terms: new Map([['station', 1]]), concepts: ['station', 'stations'], vocabPieces: new Set(['station']), ks: [2] });
  assert.equal(twice.at[0].same.hits, 1);
  // a concept goes to the term equal to it before one that only begins it
  const eq = recallReport({ terms: new Map([['multi', 1], ['multisect', 1]]), concepts: ['multisect'], vocabPieces: new Set(['multisect']), ks: [1] });
  assert.deepEqual(eq.foundAt, { multisect: 1 });
  // the repeated list: only terms in two or more headings
  const rep = recallReport({ terms, concepts, vocabPieces, ks: [3], minHeadings: 2 });
  assert.equal(rep.terms, 2);
  assert.equal(rep.at[0].same.recall, 1);
  // nothing to measure
  assert.equal(recallReport({ terms: new Map(), concepts, vocabPieces, ks: [3] }).at[0].same.recall, null);
});
