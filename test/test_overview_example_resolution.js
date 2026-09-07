// test_overview_example_resolution.js — concept examples resolve to a definition, never the mention hub
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Coverage for #275 Part 1: Overview concept examples must resolve to the
// example identifier's DEFINITION, not to the vocab's mention-concentration
// top file (typically an import/dispatch hub, where the old hinted lookup
// degraded to the file's first mention — an import line). Mock index, same
// pattern as test_overview.js.
import { test } from 'node:test';
import assert from 'node:assert';
import { buildOverview } from '../src/core/overview.js';

// Vocab surfaces parseWorklistEntry (concept "worklist") with top_files[0]
// pointing at hub.js, which only IMPORTS it. The function index defines it
// in impl.js at line 42. A .d.ts stub also matches, and must lose to the
// real implementation.
function mockIndex({ withDefinition = true } = {}) {
  return {
    indexSource: '/one/project',
    files: new Map([['src/hub.js', 1], ['src/impl.js', 1], ['types/impl.d.ts', 1]]),
    functionIndex: withDefinition
      ? {
          'src/impl.js': { parseWorklistEntry: { start: 42, end: 90 } },
          'types/impl.d.ts': { parseWorklistEntry: { start: 3, end: 3 } },
        }
      : { 'src/impl.js': { unrelated: { start: 1, end: 5 } } },
    findFunctionMatches(name, fileHint = null) {
      const out = [];
      for (const [filepath, fns] of Object.entries(this.functionIndex)) {
        if (fileHint && !filepath.toLowerCase().includes(fileHint.toLowerCase())) continue;
        for (const [fn, info] of Object.entries(fns)) {
          if (fn === name) out.push({ filepath, name: fn, start: info.start, end: info.end, type: 'function' });
        }
      }
      return out;
    },
    fileLines: new Map([
      ['src/hub.js', [
        "import { parseWorklistEntry } from './impl.js';",
        'parseWorklistEntry(x);',
      ]],
    ]),
    getStats: () => ({ total_lines: 100, parse_method: 'tree-sitter' }),
    getDisplayName: (n) => n,
    getEntryPoints: () => [],
    getTopVocabulary: () => [
      { token: 'parseWorklistEntry', score: 80, top_files: [{ path: 'src/hub.js', concentration: 0.5 }] },
    ],
  };
}

test('#275: concept example resolves to definition, not the importing hub file', () => {
  const ov = buildOverview(mockIndex());
  const c = ov.concepts.find(c => c.example === 'parseWorklistEntry');
  assert.ok(c, 'concept with parseWorklistEntry example expected');
  assert.equal(c.exampleFile, 'src/impl.js'); // definition, not src/hub.js
  assert.equal(c.exampleLine, 42);            // definition start, not import line 1
});

test('#275: .d.ts stub loses to the real implementation', () => {
  const ov = buildOverview(mockIndex());
  const c = ov.concepts.find(c => c.example === 'parseWorklistEntry');
  assert.notEqual(c.exampleFile, 'types/impl.d.ts');
});

test('#275: non-function example keeps vocab-file first-mention fallback (#181)', () => {
  const ov = buildOverview(mockIndex({ withDefinition: false }));
  const c = ov.concepts.find(c => c.example === 'parseWorklistEntry');
  assert.ok(c, 'concept expected even without a function-index definition');
  assert.equal(c.exampleFile, 'src/hub.js'); // vocab file retained
  assert.equal(c.exampleLine, 1);            // first mention in that file
});

// --- #275 Part 3: the example PICKER prefers function-resolvable tokens ---

test('#275 Part 3: function-resolvable runner-up beats higher-scoring CLI-key token', () => {
  const idx = mockIndex();
  // Same concept part ("worklist") carried by two compound tokens: the CLI-key
  // style token outscores the real function. The picker must choose the function.
  idx.getTopVocabulary = () => [
    { token: 'worklist_flag_limit', score: 100, top_files: [{ path: 'src/argparse.js', concentration: 0.5 }] }, // not a function
    { token: 'parseWorklistEntry', score: 80, top_files: [{ path: 'src/hub.js', concentration: 0.4 }] },        // defined in impl.js
  ];
  const ov = buildOverview(idx);
  const c = ov.concepts.find(c => c.concept === 'worklist');
  assert.ok(c, 'worklist concept expected');
  assert.equal(c.example, 'parseWorklistEntry');
  assert.equal(c.exampleIsFunction, true);
  assert.equal(c.exampleFile, 'src/impl.js'); // Part 1 then resolves to the definition
  assert.equal(c.exampleLine, 42);
});

test('#275 Part 3: with only non-function candidates the top-scoring pick survives', () => {
  const idx = mockIndex({ withDefinition: false });
  idx.getTopVocabulary = () => [
    { token: 'zqwx_flag_limit', score: 100, top_files: [{ path: 'src/hub.js', concentration: 0.5 }] }, // nothing resolves
  ];
  idx.fileLines = new Map([['src/hub.js', ['const zqwx_flag_limit = 1;']]]);
  const ov = buildOverview(idx);
  const c = ov.concepts.find(c => c.concept === 'zqwx');
  assert.ok(c, 'zqwx concept expected');
  assert.equal(c.example, 'zqwx_flag_limit'); // pre-Part-3 behavior preserved
  assert.equal(c.exampleIsFunction, false);
  assert.equal(c.exampleFile, 'src/hub.js');  // vocab file + first-mention fallback
  assert.equal(c.exampleLine, 1);
});
