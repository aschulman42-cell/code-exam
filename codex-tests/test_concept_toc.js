// Codex (GPT-5.6-Luna medium) contribution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitConceptWords, conceptTokens, compactCardText, buildConceptCards, buildConceptHierarchy, rankDirectEntries, rankConceptCards, renderConceptToc, parseArgs } from './concept-toc.mjs';

const entries = [
  { id: 'a', label: '[class] AdaptiveTrackSelection', kind: 'class', files: ['track/Adaptive.java'], members: [{ file: 'track/Adaptive.java', name: 'updateSelectedTrack' }], calls: ['BandwidthMeter.getBitrateEstimate'] },
  { id: 'b', label: '[token] Format.bitrate', kind: 'token', files: ['Format.java'], members: [{ file: 'Format.java', name: 'bitrate' }] },
  { id: 'c', label: '[class] DefaultLoadControl', kind: 'class', files: ['LoadControl.java'], members: [{ file: 'LoadControl.java', name: 'shouldStartPlayback' }] },
];

test('concept tokenization splits code names and removes short/common words', () => {
  assert.deepEqual(splitConceptWords('AdaptiveTrackSelection.update_selected-track'), ['adaptive', 'track', 'selection', 'update', 'selected', 'track']);
  assert.deepEqual(conceptTokens('A Format.bitrate and the adaptive choice'), ['format', 'bitrate', 'adaptive', 'choice']);
});

test('concept cards group entries by distinctive vocabulary and retain relationships', () => {
  const cards = buildConceptCards(entries);
  const adaptive = cards.find((c) => c.label === 'adaptive');
  assert.ok(adaptive);
  assert.deepEqual(adaptive.entries.map((e) => e.id), ['a']);
  assert.deepEqual(adaptive.calls, ['BandwidthMeter.getBitrateEstimate']);
  assert.equal(adaptive.level, 'concept');
});

test('concept lanes exclude generic path/relationship vocabulary', () => {
  const cards = buildConceptCards(entries);
  assert.equal(cards.some((c) => c.label === 'java'), false);
  assert.equal(cards.some((c) => c.label === 'builder'), false);
  assert.ok(cards.some((c) => c.label === 'adaptive'));
});

test('broad lanes remain eligible but their embedding evidence is bounded', () => {
  const broad = Array.from({ length: 700 }, (_, i) => ({ id: `b${i}`, label: `[class] AdaptiveThing${i}`, members: [{ file: `F${i}.java`, name: `adaptive${i}` }] }));
  const cards = buildConceptCards(broad, { maxEntries: 80 });
  const adaptive = cards.find((c) => c.label === 'adaptive');
  assert.ok(adaptive);
  assert.equal(adaptive.entries.length, 700);
  assert.ok(adaptive.text.length <= 1200);
});

test('card embedding text is bounded while retaining representative evidence', () => {
  const huge = Array.from({ length: 300 }, (_, i) => ({ label: `Mechanism${i}`, members: [{ file: `src/${i}.java`, name: `function${i}` }] }));
  const text = compactCardText('adaptive', huge, ['Adaptive.java'], ['BandwidthMeter.getBitrateEstimate']);
  assert.ok(text.length <= 1200);
  assert.match(text, /concept adaptive/);
  assert.match(text, /Mechanism0/);
});

test('hierarchy exposes concept, mechanism, and member levels', () => {
  const card = buildConceptHierarchy(buildConceptCards(entries)).find((c) => c.label === 'adaptive');
  assert.deepEqual(card.levels.mechanisms[0].label, '[class] AdaptiveTrackSelection');
  assert.deepEqual(card.levels.members[0].name, 'updateSelectedTrack');
});

test('ranking combines lexical overlap and optional vectors with deterministic ties', () => {
  const cards = buildConceptHierarchy(buildConceptCards(entries));
  const got = rankConceptCards(cards, 'adaptive bitrate selection', { limit: 3 });
  assert.equal(got[0].label, 'adaptive');
  assert.deepEqual(got[0].lexicalHits, ['adaptive', 'bitrate', 'selection']);
  assert.equal(got[0].rank, 1);
  assert.equal(got[0].evidenceEntries[0].label, '[class] AdaptiveTrackSelection');
});

test('direct mechanism lane matches subtokens independently of concept-card rank', () => {
  const got = rankDirectEntries(entries, 'determine code rate before playback start', { limit: 3 });
  const bitrate = got.find((x) => x.entry.label === '[token] Format.bitrate');
  assert.ok(bitrate);
  assert.ok(bitrate.lexicalHits.includes('rate'));
});

test('rendering shows the menu levels and does not assign a verdict', () => {
  const cards = buildConceptHierarchy(buildConceptCards(entries));
  const md = renderConceptToc({ index: '.demo', claimSource: 'claim.txt', model: 'gemma', top: 2, elements: ['adaptive bitrate selection'], reports: [{ element: 'adaptive bitrate selection', direct: rankDirectEntries(entries, 'adaptive bitrate selection', { limit: 2 }), cards: rankConceptCards(cards, 'adaptive bitrate selection', { limit: 2 }) }] });
  assert.match(md, /Concept-oriented claim retrieval menu/);
  assert.match(md, /concept .* mechanism/);
  assert.match(md, /AdaptiveTrackSelection/);
  assert.match(md, /assigns no claim verdicts/);
  assert.doesNotMatch(md, /SUPPORTED|NOT_SHOWN/);
});

test('CLI parsing stays local-model and index oriented', () => {
  assert.deepEqual(parseArgs(['--ndx', '.demo', '--claim', '@claim.txt', '--embed-model', 'gemma', '--top', '4', '--cpu', '--direct-embed', '--verbose-menu']), { index: '.demo', claim: '@claim.txt', model: 'gemma', top: 4, cpu: true, directEmbed: true, verboseMenu: true, help: false });
});
