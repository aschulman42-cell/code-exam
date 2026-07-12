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
