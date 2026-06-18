// Coverage for the vocab-density "key files" roll-up (vocab-output-hygiene-and-
// density): computeVocabDensity ranks files by summed score x concentration
// (NOT raw counts — raw counts let big files win, the hotspots failure mode of
// #187), folds per-function doc-ids back to their file, and counts distinct
// terms per file.
import { test } from 'node:test';
import assert from 'node:assert';
import { computeVocabDensity } from '../src/commands/metrics.js';

test('vocab-density: ranks by score x concentration, not raw counts', () => {
  // big.js has 100x the raw hits but low concentration; small.js is dense.
  const topTokens = [{
    token: 'widget', score: 100,
    top_files: [
      { path: 'big.js', count: 1000, concentration: 0.01 },   // weight 1
      { path: 'small.js', count: 10, concentration: 0.5 },     // weight 50
    ],
  }];
  const { ranked } = computeVocabDensity(topTokens);
  assert.equal(ranked[0].file, 'small.js');   // dense file wins despite fewer hits
  assert.equal(ranked[1].file, 'big.js');
  assert.ok(ranked[0].weight > ranked[1].weight);
});

test('vocab-density: folds per-function doc-ids back to the file', () => {
  const topTokens = [{
    token: 'parse', score: 10,
    top_files: [
      { path: 'p.js|||fnA', count: 5, concentration: 0.5 },
      { path: 'p.js|||fnB', count: 3, concentration: 0.3 },
    ],
  }];
  const { ranked, fileCount } = computeVocabDensity(topTokens);
  assert.equal(fileCount, 1);                  // both folded into p.js
  assert.equal(ranked[0].file, 'p.js');
  assert.equal(ranked[0].terms, 1);            // same token, one distinct term
  assert.ok(Math.abs(ranked[0].weight - (10 * 0.5 + 10 * 0.3)) < 1e-9);
});

test('vocab-density: terms count = distinct tokens concentrating in a file', () => {
  const topTokens = [
    { token: 'a', score: 5, top_files: [{ path: 'x.js', count: 1, concentration: 0.2 }] },
    { token: 'b', score: 5, top_files: [{ path: 'x.js', count: 1, concentration: 0.2 }] },
    { token: 'c', score: 5, top_files: [{ path: 'y.js', count: 1, concentration: 0.9 }] },
  ];
  const { ranked, fileCount } = computeVocabDensity(topTokens);
  assert.equal(fileCount, 2);
  const x = ranked.find(r => r.file === 'x.js');
  assert.equal(x.terms, 2);                    // tokens a + b
});

test('vocab-density: empty input yields empty ranking', () => {
  const { ranked, fileCount } = computeVocabDensity([]);
  assert.equal(fileCount, 0);
  assert.equal(ranked.length, 0);
});
