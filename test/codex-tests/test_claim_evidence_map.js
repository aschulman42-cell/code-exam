// Codex (GPT-5.6-Luna medium) contribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, lexicalEvidence, mergeCandidates, renderEvidenceMap } from './claim-evidence-map.mjs';

const candidate = (id, rank, label, members = []) => ({ entry: { id }, rank, cos: 0.8 - rank / 100, label, members, text: label });

test('parseArgs requires an index and claim and accepts the deterministic options', () => {
  assert.deepEqual(parseArgs(['--ndx', '.demo', '--claim', '@claim.txt', '--top', '5', '--function-text', '--cpu']), {
    index: '.demo', claim: '@claim.txt', model: null, top: 5, cpu: true, functionText: true, help: false,
  });
  assert.throws(() => parseArgs(['--ndx', '.demo']), /needs|usage/);
});

test('lexicalEvidence reports claim tokens found in labels and members', () => {
  const got = lexicalEvidence('adaptive bitrate selection', candidate('a', 1, 'track selection', [{ name: 'getAdaptiveBitrate' }]));
  assert.deepEqual(got.hits, ['adaptive', 'bitrate', 'selection']);
  assert.equal(got.count, 3);
});

test('mergeCandidates keeps the embedding head and adds lexical evidence without duplicates', () => {
  const ranked = [
    candidate('a', 1, 'generic'),
    candidate('b', 2, 'adaptive bitrate'),
    candidate('c', 3, 'other'),
  ];
  const got = mergeCandidates(ranked, 'adaptive bitrate selection', 1, 2);
  assert.deepEqual(got.map((x) => x.entry.id), ['a', 'b']);
  assert.equal(got[0].source, 'embedding');
  assert.equal(got[1].source, 'lexical-name');
});

test('renderEvidenceMap discloses candidates rather than assigning verdicts', () => {
  const md = renderEvidenceMap({
    index: '.demo', claimSource: 'claim.txt', model: 'nomic', functionText: false, top: 2,
    elements: ['an adaptive selection element'],
    reports: [{ element: 'an adaptive selection element', stats: { med: 0.4, margin: 0.2, word: '' }, candidates: [{ ...candidate('a', 1, 'AdaptiveTrackSelection', [{ file: 'Adaptive.java', name: 'updateSelectedTrack' }]), lexical: { hits: ['adaptive', 'selection'], count: 2 }, source: 'embedding' }] }],
  });
  assert.match(md, /Provisional claim evidence map/);
  assert.match(md, /not claim-chart verdicts/);
  assert.match(md, /updateSelectedTrack/);
  assert.doesNotMatch(md, /- Verdict:/);
});
