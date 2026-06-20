// Coverage for #181 buildOverview / formatOverview: the one-shot orientation
// summary. Uses a mock index (no on-disk index needed) so the collection
// detector, language histogram, vocab-density key files, and absence checks
// are exercised deterministically.
import { test } from 'node:test';
import assert from 'node:assert';
import { buildOverview, buildOverviewFast, buildOverviewDeep, formatOverview } from '../src/core/overview.js';

// 10 files across 3 top-level folders: projA 40%, projB 40%, projC 20%.
// .js x6, .py x2, .md x2. functionIndex has 3 functions total.
function mockIndex() {
  return {
    indexSource: '/some/collection',
    files: new Map([
      ['projA/a1.js', 1], ['projA/a2.js', 1], ['projA/a3.py', 1], ['projA/a4.py', 1],
      ['projB/b1.js', 1], ['projB/b2.js', 1], ['projB/b3.js', 1], ['projB/b4.js', 1],
      ['projC/c1.md', 1], ['projC/c2.md', 1],
    ]),
    functionIndex: { 'projA/a1.js': { foo: {}, bar: {} }, 'projB/b1.js': { baz: {} } },
    getStats: () => ({ total_lines: 1234, parse_method: 'tree-sitter+regex' }),
    getDisplayName: (n) => n,
    getEntryPoints: () => [{ name: 'main', filepath: 'projB/b1.js' }],
    getTopVocabulary: () => [
      { token: 'widget', score: 100, top_files: [{ path: 'projA/a1.js', concentration: 0.5 }, { path: 'projB/b1.js', concentration: 0.1 }] },
      { token: 'gadget', score: 50, top_files: [{ path: 'projA/a1.js', concentration: 0.4 }] },
      { token: 'parseWorklistEntry', score: 80, top_files: [{ path: 'projA/a2.js', concentration: 0.3 }] }, // CamelCase -> concept "worklist"
    ],
  };
}

test('#181 buildOverview: size, languages, function count', () => {
  const ov = buildOverview(mockIndex());
  assert.equal(ov.size.files, 10);
  assert.equal(ov.size.functions, 3);
  assert.equal(ov.size.lines, 1234);
  assert.equal(ov.languages.find(l => l.ext === '.js').count, 6);
  assert.equal(ov.languages[0].ext, '.js'); // most common, sorted first
});

test('#181 buildOverview: collection detector fires for multi-project trees', () => {
  const ov = buildOverview(mockIndex());
  assert.equal(ov.isCollection, true);
  assert.ok(ov.absence.some(a => /COLLECTION/.test(a)));
  assert.deepEqual(ov.topFolders.map(f => f.folder).slice(0, 3).sort(), ['projA', 'projB', 'projC']);
});

test('#181 buildOverview: key files ranked by breadth (distinct top terms)', () => {
  const ov = buildOverview(mockIndex());
  // a1 carries 2 top terms (widget+gadget); a2 and b1 carry 1 each → a1 first.
  assert.equal(ov.keyFiles[0].file, 'projA/a1.js');
  assert.equal(ov.keyFiles[0].terms, 2);
  // breadth-descending order
  for (let i = 1; i < ov.keyFiles.length; i++) {
    assert.ok(ov.keyFiles[i - 1].terms >= ov.keyFiles[i].terms);
  }
});

test('#181 buildOverview: concepts surface sub-terms buried in CamelCase', () => {
  const ov = buildOverview(mockIndex());
  // "worklist" lives only inside parseWorklistEntry and is absent from the public
  // cross-corpus catalog → reliably surfaces. (The IDF/drop logic is tested
  // hermetically in test_vocabulary's extractConcepts test.)
  assert.ok(Array.isArray(ov.concepts));
  const names = ov.concepts.map(c => c.concept);
  assert.ok(names.includes('worklist'), `concepts: ${names.join(',')}`);
  // #181 polish: grounded in the identifier it was split from
  assert.equal(ov.concepts.find(c => c.concept === 'worklist').example, 'parseWorklistEntry');
});

test('#181 buildOverview: absence flags an empty index', () => {
  const empty = { indexSource: null, files: new Map(), functionIndex: {},
    getStats: () => ({}), getEntryPoints: () => [], getTopVocabulary: () => [] };
  const ov = buildOverview(empty);
  assert.equal(ov.size.functions, 0);
  assert.ok(ov.absence.some(a => /No functions indexed/.test(a)));
});

test('#181 buildOverview: strips a shared root so the collection detector sees real sub-folders', () => {
  const files = new Map();
  for (const [proj, n] of [['projA', 4], ['projB', 4], ['projC', 2]]) {
    for (let i = 0; i < n; i++) files.set(`repo.zip!repo/${proj}/f${i}.js`, 1);
  }
  const idx = {
    indexSource: 'repo.zip', files, functionIndex: {},
    getStats: () => ({}), getEntryPoints: () => [], getTopVocabulary: () => [],
  };
  const ov = buildOverview(idx);
  assert.equal(ov.root, 'repo.zip!repo/');               // shared wrapper detected
  assert.equal(ov.isCollection, true);                   // sub-projects seen UNDER the root
  assert.deepEqual(ov.topFolders.map(f => f.folder).sort(), ['projA', 'projB', 'projC']);
});

test('#193 buildOverview: displayRoot peels the shown-paths prefix when the whole index has none', () => {
  // A near-single-project collection: a dominant zip plus a tiny sibling zip.
  // The whole index shares no common root, but every top result lives in the
  // dominant zip → displayRoot peels that prefix from the lists.
  const files = new Map();
  for (let i = 0; i < 12; i++) files.set(`big.zip!proj-main/src/f${i}.js`, 1);
  for (let i = 0; i < 2; i++) files.set(`small.zip!other-main/x${i}.js`, 1);
  const idx = {
    indexSource: 'collection', files, functionIndex: {},
    getStats: () => ({}),
    getEntryPoints: () => [{ name: 'main', filepath: 'big.zip!proj-main/src/f0.js' }],
    getTopVocabulary: () => [
      { token: 'widget', score: 100, top_files: [{ path: 'big.zip!proj-main/src/f0.js', concentration: 0.5 }] },
      { token: 'gadget', score: 80, top_files: [{ path: 'big.zip!proj-main/src/f1.js', concentration: 0.4 }] },
    ],
  };
  const ov = buildOverview(idx);
  assert.equal(ov.root, '');                              // two zips → no whole-index root
  assert.equal(ov.displayRoot, 'big.zip!proj-main/src/'); // but the shown paths share this
  const out = formatOverview(ov);
  assert.match(out, /Paths under:.*big\.zip!proj-main\/src\//);
  assert.doesNotMatch(out, /big\.zip!proj-main\/src\/f0\.js/); // peeled off the key-file rows
});

test('#181 fast/deep split: fast omits O(corpus) signals, deep supplies them', () => {
  const fast = buildOverviewFast(mockIndex());
  assert.equal(fast.partial, true);
  assert.equal(fast.size.functions, null);          // deferred to deep
  assert.equal(fast.concepts, undefined);           // not computed in fast
  assert.equal(fast.keyFiles, undefined);
  assert.equal(fast.entryPoints, undefined);
  assert.ok(fast.languages.length && fast.topFolders.length); // cheap signals present

  const deep = buildOverviewDeep(mockIndex());
  assert.equal(deep.functions, 3);
  assert.ok(deep.concepts.some(c => c.concept === 'worklist'));
  assert.ok(deep.keyFiles.length);
  // merged buildOverview() == fast ∪ deep
  const full = buildOverview(mockIndex());
  assert.equal(full.partial, false);
  assert.equal(full.size.functions, 3);
  assert.ok(full.concepts.length && full.keyFiles.length);
});

test('#181 lineOf falls back to first whole-word occurrence for non-function examples', () => {
  // Concept example `welfare_poison` is a module-level const (not in the function
  // index) → findFunctionMatches misses; the fileLines scan finds it at line 3.
  const idx = {
    indexSource: '/x', files: new Map([['m/suites.py', 1]]),
    functionIndex: {}, getStats: () => ({}), getEntryPoints: () => [],
    findFunctionMatches: () => [],                  // no function match
    fileLines: new Map([['m/suites.py', ['import os', '', 'WELFARE_POISON = welfare_poison()', 'x = 1']]]),
    getTopVocabulary: () => [
      { token: 'welfare_poison', score: 90, top_files: [{ path: 'm/suites.py', concentration: 0.9 }] },
    ],
  };
  const deep = buildOverviewDeep(idx);
  const c = deep.concepts.find(c => c.concept === 'welfare' || c.concept === 'poison');
  assert.ok(c, `expected a welfare/poison concept, got ${deep.concepts.map(x => x.concept).join(',')}`);
  assert.equal(c.exampleFile, 'm/suites.py');
  assert.equal(c.exampleLine, 3);                   // first mention, not file top
});

test('#181 formatOverview: renders the sections', () => {
  const out = formatOverview(buildOverview(mockIndex()));
  assert.match(out, /# Overview — \/some\/collection/);
  assert.match(out, /\*\*Size:\*\* 10 files, 3 functions/);
  assert.match(out, /Looks like a collection/);      // isCollection banner
  assert.match(out, /\*\*Key concepts \(with examples\):\*\*/); // section header (#181 rename)
  assert.match(out, /- worklist \(parseWorklistEntry\)/); // one per line, concept + example
  assert.doesNotMatch(out, /Top identifiers/);            // dropped (#181 polish)
  assert.match(out, /Key files \(by vocabulary density\)/);
  assert.match(out, /Entry points:/);
  assert.match(out, /\*\*Next:\*\*/);                 // next-hop guidance
});
