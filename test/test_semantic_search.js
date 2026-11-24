// test_semantic_search.js — --semantic-search and --build-embeddings with no model: the flags, which model a search uses and what it says when embeddings are missing, results as functions with entries of one function collapsed, the tiers, the filter, the view across elements, the closing steps, and the CLI's messages
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// semantic-search-cli (2026-11-17). The embedding itself needs a model and is not exercised
// here, except end to end when the model and CodeExam's own built embeddings are present.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/argparse.js';
import { EMBED_MODELS, missingInCache, embedAll } from '../src/core/embed.js';
import { MECHANISMS_FORMAT } from '../src/core/mechanisms-index.js';
import { FUSE_ARM } from '../src/core/function-text.js';
import { CHUNK, entryEmbedPlan, entryCandidates } from '../src/commands/embed-distance.js';
import {
  builtModelBases, chooseSearchModel, chooseBuildModel, searchRows, searchTiers, filterRows, formatSearchRow, groupName,
  renderSearch, acrossElements, renderAcross, readsLikeClaim, closingTips, nextFunctions, isTestEntry,
  shortPath, sourcePath, unusedOptionNotes, acrossDepth, HIT_SHARE, NEAR_SHARE, TOP_UP_MAX, PREFERRED_EMBED_MODEL,
} from '../src/commands/semantic-search.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', input: '' });
function withArgv(argv, fn) {
  const saved = process.argv;
  process.argv = [saved[0], saved[1], ...argv];
  try { return fn(); } finally { process.argv = saved; }
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
const base = (name) => EMBED_MODELS[name].file.replace(/\.gguf$/i, '');

/** An index folder holding embedding files for the named models (empty caches) and, in `models`, those models' files. */
function fakeIndex({ built = [], partial = [], installed = [] } = {}) {
  const dir = tmp('ce-sem-');
  const emb = path.join(dir, 'embeddings');
  fs.mkdirSync(emb);
  const write = (b, kind) => fs.writeFileSync(path.join(emb, `${b}_${kind}.json`), JSON.stringify({ items: {} }));
  for (const n of built) for (const k of ['label+members', `label+members_chunks${CHUNK}`, `function-text-${FUSE_ARM}`]) write(base(n), k);
  for (const n of partial) write(base(n), 'label+members');
  const models = path.join(dir, 'models');
  fs.mkdirSync(models);
  for (const n of installed) fs.writeFileSync(path.join(models, EMBED_MODELS[n].file), '');
  return { dir, models };
}

const entry = (id, label, members, description = '') => ({ id, label, kind: 'file', members: members.map(([name, file]) => ({ name, file })), description });
const fn = (file, name, start, end) => ({ id: `${file}@${name}`, file, name, start, end });

describe('--semantic-search: the flags', () => {
  it('parses --semantic-search as a value and --build-embeddings as a flag, both absent by default', () => {
    const a = withArgv(['--semantic-search', 'refuse a cloud model', '--ndx', '.x', '--filter', 'air', '--include-tests'], () => parseArgs());
    assert.equal(a.semantic_search, 'refuse a cloud model');
    assert.equal(a.build_embeddings, false);
    assert.equal(a.filter, 'air');
    assert.equal(a.include_tests, true);
    const b = withArgv(['--build-embeddings', '--ndx', '.x'], () => parseArgs());
    assert.equal(b.build_embeddings, true);
    assert.equal(b.semantic_search, null);
  });
});

describe('--semantic-search: which model, and what it says when there are no embeddings', () => {
  it('an index counts as built for a model only with both its group and its function embeddings', () => {
    const { dir } = fakeIndex({ built: ['gemma'], partial: ['nomic'] });
    assert.deepEqual(builtModelBases(dir), [base('gemma')]);
    assert.deepEqual(builtModelBases(path.join(dir, 'nowhere')), []);
  });

  it('uses gemma when the index has gemma embeddings, and says so without being asked', () => {
    const { dir, models } = fakeIndex({ built: ['nomic', 'gemma'], installed: ['nomic', 'gemma'] });
    const c = chooseSearchModel(dir, null, { modelsDir: models, ndx: '.idx' });
    assert.equal(c.model.name, 'gemma');
    assert.match(c.note, /^using the gemma embeddings already built for this index; --embed-model <name> chooses another$/);
  });

  it('uses what the index has when it has no gemma embeddings, names it, and gives the command that builds gemma', () => {
    const { dir, models } = fakeIndex({ built: ['nomic'], installed: ['nomic', 'gemma'] });
    const c = chooseSearchModel(dir, null, { modelsDir: models, ndx: '.idx' });
    assert.equal(c.model.name, 'nomic');
    assert.match(c.note, /using the nomic embeddings built for this index \(it has none for gemma; ce --ndx \.idx --build-embeddings --embed-model gemma builds them\)/);
  });

  it('no embeddings at all is a message with the build command and "run the search again"', () => {
    const { dir, models } = fakeIndex({ installed: ['nomic', 'gemma'] });
    const c = chooseSearchModel(dir, null, { modelsDir: models, ndx: '.idx' });
    assert.equal(c.model, undefined);
    assert.match(c.problem, /\.idx has no embeddings yet\. Build them \(once per index\), then run the search again:\n {2}ce --ndx \.idx --build-embeddings$/);
  });

  it('group embeddings alone (an --embed-distance run without --function-text) are not a build', () => {
    const { dir, models } = fakeIndex({ partial: ['gemma'], installed: ['gemma'] });
    assert.match(chooseSearchModel(dir, null, { modelsDir: models, ndx: '.idx' }).problem, /has no embeddings yet/);
  });

  it('--embed-model wins; a model the index has no embeddings for names the build command for that model', () => {
    const { dir, models } = fakeIndex({ built: ['gemma', 'nomic'], installed: ['nomic', 'gemma', 'jina'] });
    assert.equal(chooseSearchModel(dir, 'nomic', { modelsDir: models }).model.name, 'nomic');
    const c = chooseSearchModel(dir, 'jina', { modelsDir: models, ndx: '.idx' });
    assert.match(c.problem, /\.idx has no jina embeddings yet\. Build them, then run the search again:\n {2}ce --ndx \.idx --build-embeddings --embed-model jina/);
    assert.match(chooseSearchModel(dir, 'coderank', { modelsDir: models }).problem, /is not installed/);
  });

  it('embeddings whose model file is not installed here say so', () => {
    const { dir, models } = fakeIndex({ built: ['gemma'], installed: [] });
    assert.match(chooseSearchModel(dir, null, { modelsDir: models, ndx: '.idx' }).problem, /has embeddings for gemma, and that model's file is not installed here/);
  });

  it('a build uses gemma when its file is installed, else the shipped default, else the model named', () => {
    assert.equal(PREFERRED_EMBED_MODEL, 'gemma');
    const both = fakeIndex({ installed: ['nomic', 'gemma'] });
    assert.equal(chooseBuildModel(null, { modelsDir: both.models }).name, 'gemma');
    const one = fakeIndex({ installed: ['nomic'] });
    assert.equal(chooseBuildModel(null, { modelsDir: one.models }).name, 'nomic');
    assert.equal(chooseBuildModel('nomic', { modelsDir: both.models }).name, 'nomic');
    assert.throws(() => chooseBuildModel('jina', { modelsDir: one.models }), /not installed/);
  });

  it('missingInCache counts the texts a cache lacks or holds under another text, and embeds nothing', async () => {
    const dir = tmp('ce-sem-cache-');
    const file = path.join(dir, 'c.json');
    const texts = [{ key: 'a', text: 'one' }, { key: 'b', text: 'two' }];
    assert.equal(missingInCache(file, texts, 'p: '), 2);
    await embedAll({ getEmbeddingFor: async (t) => ({ vector: [t.length, 1] }) }, [texts[0]], file, { prefix: 'p: ', quiet: true });
    assert.equal(missingInCache(file, texts, 'p: '), 1);
    assert.equal(missingInCache(file, [{ key: 'a', text: 'changed' }], 'p: '), 1);
    assert.equal(missingInCache(file, [texts[0]], 'other: '), 1, 'a different prefix is a different text');
    assert.ok(TOP_UP_MAX > 0);
  });

  it('entryEmbedPlan and entryCandidates give --embed-distance and the search one set of cache keys', () => {
    const es = [entry('m1', '[file] a.js', [['f', 'a.js'], ['g', 'a.js']]), entry('m2', '[file] b.js', Array.from({ length: 12 }, (_, i) => [`fn${i}`, 'b.js']))];
    const plan = entryEmbedPlan(es);
    assert.deepEqual(plan.whole.map((x) => x.key), ['m1:0', 'm2:1']);
    assert.ok(plan.extra.every((x) => /^m2:1:\d+$/.test(x.key)), 'only the entry longer than one chunk has extra chunks');
    assert.equal(plan.chunks[1].length, 2);
    const vec = new Map([...plan.whole, ...plan.extra].map((x, i) => [x.key, [i, 1]]));
    const cands = entryCandidates(es, plan, vec, vec);
    assert.equal(cands[0].vectors.length, 1);
    assert.equal(cands[1].vectors.length, 2);
    assert.ok(cands[1].vectors.every(Boolean));
    assert.equal(cands[1].label, '[file] b.js');
  });
});

describe('--semantic-search: a result is the function that scored', () => {
  const fns = new Map([
    fn('src/core/air.js', 'assertLocal', 37, 45), fn('src/core/air.js', 'Guard::assertLocal', 36, 45), fn('src/core/air.js', 'scrub', 51, 55),
    fn('src/run.js', 'resolveModel', 63, 87), fn('src/run.js', 'draft', 100, 120),
  ].map((f) => [f.id, f]));
  const fnOf = (id) => fns.get(id);
  const air = entry('m1', '[file] air.js', [['assertLocal', 'src/core/air.js'], ['scrub', 'src/core/air.js']], 'air.js blocks cloud calls.');
  const cmdA = entry('m2', '[cmd] --synonymize', Array.from({ length: 30 }, (_, i) => [`f${i}`, 'src/x.js']));
  const cmdB = entry('m3', '[cmd] --claim-search', Array.from({ length: 36 }, (_, i) => [`g${i}`, 'src/y.js']));
  const run2 = entry('m4', '[file] run.js', [['resolveModel', 'src/run.js'], ['draft', 'src/run.js']]);
  const bare = entry('m5', '[file] notes.md', [['x', 'notes.md']]);
  const ranked = [
    { entry: cmdA, cos: 0.44, labelCos: 0.37, fnCos: 0.46, fn: 'src/core/air.js@assertLocal', fnIds: [], rank: 1 },
    { entry: run2, cos: 0.43, labelCos: 0.40, fnCos: 0.44, fn: 'src/run.js@resolveModel', fnIds: ['src/run.js@resolveModel', 'src/run.js@draft'], rank: 2 },
    { entry: cmdB, cos: 0.42, labelCos: 0.35, fnCos: 0.46, fn: 'src/core/air.js@Guard::assertLocal', fnIds: [], rank: 3 },
    { entry: air, cos: 0.41, labelCos: 0.32, fnCos: 0.46, fn: 'src/core/air.js@assertLocal', fnIds: ['src/core/air.js@assertLocal', 'src/core/air.js@scrub'], rank: 4 },
    { entry: bare, cos: 0.20, labelCos: 0.20, fnCos: null, fn: null, fnIds: [], rank: 5 },
  ];

  it('entries whose best function is the same one are one row, ranked where the first ranked, the smallest group first; Class::method and method are one function', () => {
    const rows = searchRows(ranked, fnOf);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
    assert.equal(rows[0].fn.name, 'assertLocal');
    assert.equal(rows[0].score, 0.44);
    assert.deepEqual(rows[0].groups.map((g) => g.label), ['[file] air.js', '[cmd] --synonymize', '[cmd] --claim-search']);
    assert.equal(rows[1].fn.name, 'resolveModel');
    assert.equal(rows[2].fn, null, 'an entry with no function text is its own row');
    assert.equal(rows[2].key, 'entry:m5');
  });

  it('a row prints the function, its file and lines, the groups holding it and the smallest group\'s description; no cosine or distance', () => {
    const rows = searchRows(ranked, fnOf);
    const text = formatSearchRow(rows[0]);
    const lines = text.split('\n');
    assert.match(lines[0], /^ {2}1\. 0\.440 {2}assertLocal {3}src\/core\/air\.js:37-45$/);
    // embed-distance-rows-show-mechanism-id (2026-11-21): each group is named by its record id, then its label.
    assert.match(lines[1], /in (m\d+) \[file\] air\.js \(2 fn\); also in (m\d+) \[cmd\] --synonymize, (m\d+) \[cmd\] --claim-search$/);
    assert.deepEqual(lines[1].match(/m\d+/g), rows[0].groups.map((g) => g.id), 'the ids are the groups\' own, in the order the labels print');
    assert.equal(groupName({ label: '[file] x.js' }), '[file] x.js', 'a group without an id prints its label alone');
    assert.match(lines[2], /air\.js blocks cloud calls\.$/);
    assert.doesNotMatch(text, /cosine|distance/);
    assert.match(formatSearchRow(rows[2]), /0\.\d+ {2}m5 \[file\] notes\.md {3}\(a group of 1 function; no single function scored\)/, 'a row that is a group leads with the group\'s id');
    assert.match(formatSearchRow(rows[0], { verbose: true }), /score parts: group name 0\.3700, function text 0\.4600; the group ranked 1 among groups/);
  });

  it('the next-best functions of the group are named under the row, a method held twice counted once', () => {
    const rows = searchRows(ranked, fnOf);
    const scores = { 'src/run.js@draft': 0.3, 'src/core/air.js@scrub': 0.2 };
    rows[1].next = nextFunctions(rows[1], (id) => scores[id] ?? null, fnOf);
    assert.deepEqual(rows[1].next.map((x) => x.fn.name), ['draft']);
    assert.match(formatSearchRow(rows[1]), /next best in this group: draft \(lines 100-120\)/);
    const r = { fn: fns.get('src/core/air.js@assertLocal'), fnId: 'src/core/air.js@assertLocal', fnIds: ['src/core/air.js@assertLocal', 'src/core/air.js@Guard::assertLocal', 'src/core/air.js@scrub'] };
    assert.deepEqual(nextFunctions(r, () => 0.5, fnOf).map((x) => x.fn.name), ['scrub']);
    assert.deepEqual(nextFunctions({ fn: null }, () => 1, fnOf), []);
  });

  it('a path loses its archive prefix and is cut to its last segments unless verbose', () => {
    const f = 'media.zip!media-release\\libraries\\exoplayer\\src\\main\\java\\androidx\\media3\\exoplayer\\trackselection\\AdaptiveTrackSelection.java';
    assert.equal(sourcePath(f), 'media-release/libraries/exoplayer/src/main/java/androidx/media3/exoplayer/trackselection/AdaptiveTrackSelection.java');
    assert.equal(shortPath(f), '…/exoplayer/trackselection/AdaptiveTrackSelection.java');
    assert.equal(shortPath('src/core/air.js'), 'src/core/air.js');
  });

  it('an entry is test code when every member is, by the --claim-locate rule', () => {
    assert.equal(isTestEntry(entry('t', '[file] test_x.js', [['runCLI', 'test/test_x.js']])), true);
    assert.equal(isTestEntry(entry('s', '[file] air.js', [['assertLocal', 'src/core/air.js'], ['helper', 'test/test_x.js']])), false);
    assert.equal(isTestEntry({ members: [] }), false);
  });
});

describe('--semantic-search: hits, near hits, the filter and the listing', () => {
  const row = (rank, score, name) => ({ rank, score, key: name, fn: fn('src/a.js', name, rank, rank + 5), groups: [entry(`g${rank}`, `[file] ${name}.js`, [[name, 'src/a.js']])], next: [] });
  // best 0.50, typical 0.30: the hit line is 0.47, the near line 0.43
  const rows = [row(1, 0.50, 'alpha'), row(2, 0.48, 'beta'), row(3, 0.45, 'gamma'), row(4, 0.44, 'delta'), row(5, 0.40, 'epsilon'), row(6, 0.31, 'zeta')];

  it('a hit is within HIT_SHARE of the way from the best score down to the typical one, a near hit within NEAR_SHARE', () => {
    assert.equal(HIT_SHARE, 0.15);
    assert.equal(NEAR_SHARE, 0.35);
    const t = searchTiers(rows, 0.30);
    assert.deepEqual(t.hits.map((r) => r.key), ['alpha', 'beta']);
    assert.deepEqual(t.near.map((r) => r.key), ['gamma', 'delta']);
    assert.deepEqual(searchTiers([], 0.3).hits, []);
  });

  it('the listing gives the text, typical and best, HITS then NEAR HITS, and caps each tier with the way to see more', () => {
    const L = renderSearch({ query: 'do the thing', rows, typical: 0.30 });
    assert.equal(L[0], 'do the thing');
    assert.match(L[1], /typical score 0\.300, best 0\.500; 2 hits, 2 near hits/);
    const text = L.join('\n');
    assert.ok(text.indexOf('  HITS') < text.indexOf('  NEAR HITS'));
    assert.match(text, /HITS\n {2}1\. 0\.500 {2}alpha/);
    assert.doesNotMatch(text, /epsilon|zeta/, 'what is below the near hits is not listed');
    const capped = renderSearch({ query: 'q', rows, typical: 0.30, top: 1 }).join('\n');
    assert.match(capped, /… 1 more \(--max-results N, or 0 for all\)/);
    assert.equal(renderSearch({ query: 'q', heading: 'ELEMENT 2 of 3', rows, typical: 0.3 })[0], 'ELEMENT 2 of 3: q');
  });

  it('a plateau of many equal hits is called what it is', () => {
    const many = Array.from({ length: 14 }, (_, i) => row(i + 1, 0.50 - i * 0.001, `f${i}`));
    assert.match(renderSearch({ query: 'q', rows: many, typical: 0.30 }).join('\n'), /14 places score about as high as the best one: nothing stands out for this text\./);
    assert.doesNotMatch(renderSearch({ query: 'q', rows, typical: 0.30 }).join('\n'), /nothing stands out/);
  });

  it('--filter keeps ranks, counts matches per tier, and lists matches below the near hits', () => {
    assert.deepEqual(filterRows(rows, 'ETA').map((r) => r.key), ['beta', 'zeta']);
    const text = renderSearch({ query: 'q', rows, typical: 0.30, filter: 'eta' }).join('\n');
    assert.match(text, /HITS matching --filter "eta": 1 of 2\n {2}2\. 0\.480 {2}beta/);
    assert.match(text, /NEAR HITS matching --filter "eta": 0 of 2/);
    assert.match(text, /BELOW THE NEAR HITS, matching --filter "eta": 1\n {2}6\. 0\.310 {2}zeta/);
    assert.match(renderSearch({ query: 'q', rows, typical: 0.30, filter: 'nope' }).join('\n'), /nothing matches --filter "nope"/);
  });
});

describe('--semantic-search: several elements, and the closing steps', () => {
  const row = (name, score) => ({ key: name, score, fn: fn('src/a.js', name, 1, 9), groups: [entry(name, `[file] ${name}.js`, [[name, 'src/a.js']])] });
  const per = [[row('start', 0.5), row('probe', 0.4)], [row('start', 0.45), row('scrub', 0.4)], [row('probe', 0.5), row('start', 0.3)]];

  it('the view across elements lists the places found for the most elements, with a mark per element', () => {
    const a = acrossElements(per);
    assert.deepEqual(a.map((x) => [x.row.key, x.els]), [['start', [1, 2, 3]], ['probe', [1, 3]], ['scrub', [2]]]);
    const L = renderAcross(per);
    assert.match(L[0], /^ACROSS THE 3 ELEMENTS: the places within the first 25 results for the most elements$/);
    assert.match(L[1], /elements 1 2 3$/);
    assert.match(L[2], /^ {2}1\. {2}3 of 3 {2}# # # {3}start {3}src\/a\.js:1-9$/);
    assert.match(L[3], /2 of 3 {2}# \. # {3}probe/);
    assert.equal(L.length, 4, 'a place found for one element only is not listed');
    assert.match(renderAcross([[row('a', 1)], [row('b', 1)]]).join('\n'), /no place is within the first results for more than one element/);
  });

  it('a text of several elements, or with a claim\'s turns of phrase, reads like a claim; a plain question does not', () => {
    assert.equal(readsLikeClaim(['a', 'b'], true), true);
    assert.equal(readsLikeClaim(['A method for enforcing no-cloud operation, comprising:'], false), true);
    assert.equal(readsLikeClaim(['refuse to send code to a cloud model'], false), false);
  });

  it('the closing steps name --describe when the index has no descriptions and the rewording when the text reads like a claim; neither when neither applies', () => {
    const none = closingTips({ ndx: '.x', raw: 'plain words', described: 10, entriesN: 10, claimLike: false });
    assert.deepEqual(none, []);
    const both = closingTips({ ndx: '.x', raw: '@claim.txt', described: 0, entriesN: 1200, claimLike: true }).join('\n');
    assert.match(both, /^Steps that use a language model and might help:/);
    assert.match(both, /This index has no descriptions\..*\(1,200 groups, one call each\)/);
    assert.match(both, /ce --ndx \.x --describe --llm <provider> {2}\(or --model <gguf> for a local model\)/);
    assert.match(both, /untested on code a model has not seen/);
    assert.match(both, /ce --ndx \.x --semantic-search @claim\.txt --toward-code label --llm <provider>/);
    const some = closingTips({ ndx: '.x', raw: 'q', described: 4, entriesN: 10, claimLike: false }).join('\n');
    assert.match(some, /6 of this index's 10 groups have no description/);
  });

  it('the rewording is also offered when nothing stood out, whatever the text reads like, and not when the run was already reworded', () => {
    const one = closingTips({ ndx: '.x', raw: 'code rate determining unit', described: 5, entriesN: 5, claimLike: false, plateau: 1, elementsN: 1 }).join('\n');
    assert.match(one, /Nothing stood out for this text\. A model can reword the text toward this codebase's names before the search \(--toward-code label, or restate\)/);
    assert.match(one, /ce --ndx \.x --semantic-search "<text>" --toward-code label --llm <provider>/);
    const some = closingTips({ ndx: '.x', raw: '@c.txt', described: 5, entriesN: 5, claimLike: true, plateau: 3, elementsN: 9 }).join('\n');
    assert.match(some, /Nothing stood out for 3 of the 9 elements\. A model can reword each element/);
    assert.deepEqual(closingTips({ ndx: '.x', raw: '@c.txt', described: 5, entriesN: 5, claimLike: true, plateau: 3, elementsN: 9, reworded: true }), []);
  });

  it('an option given with a search that does nothing there is named, not dropped silently', () => {
    assert.deepEqual(unusedOptionNotes({}), []);
    const n = unusedOptionNotes({ function_text: true, against: 'x', no_prefix: true });
    assert.equal(n.length, 3);
    assert.match(n[0], /^note: --function-text changes nothing here: a search already ranks each group by its best function's text\.$/);
    assert.match(n[1], /^note: --against was ignored/);
    assert.match(n[2], /^note: --no-prefix was ignored/);
  });

  it('under --toward-code the text as written is the heading and the line under it is what was searched for, or that it was not reworded', () => {
    const rows = [{ rank: 1, score: 0.5, key: 'a', fn: fn('src/a.js', 'alpha', 1, 5), groups: [entry('g', '[file] a.js', [['alpha', 'src/a.js']])], next: [] }];
    const L = renderSearch({ query: 'the claim element', rows, typical: 0.3, searchedAs: 'BITRATE: select Bitrate, get Buffered Duration' });
    assert.equal(L[0], 'AS WRITTEN: the claim element');
    assert.equal(L[1], '  SEARCHED AS (a model\'s rewording; the results below are for this, not for the text above): BITRATE: select Bitrate, get Buffered Duration');
    assert.match(L[2], /typical score/);
    const el = renderSearch({ query: 'the claim element', heading: 'ELEMENT 2 of 9', rows, typical: 0.3, searchedAs: 'x' });
    assert.equal(el[0], 'ELEMENT 2 of 9, as written: the claim element');
    const failed = renderSearch({ query: 'the claim element', rows, typical: 0.3, searchedAs: 'the claim element', notReworded: 'the model returned nothing' });
    assert.equal(failed[1], '  SEARCHED AS WRITTEN: the model did not reword this text (the model returned nothing); the results below are for the text above');
    const plain = renderSearch({ query: 'q', rows, typical: 0.3 });
    assert.equal(plain[0], 'q');
    assert.doesNotMatch(plain.join('\n'), /searched as|as written/i);
  });

  it('the view across elements looks no deeper than a fifth of a small index, and says how deep it looked', () => {
    assert.equal(acrossDepth(24), 4);
    assert.equal(acrossDepth(8), 3);
    assert.equal(acrossDepth(300), 25);
    assert.match(renderAcross(per, { depth: 4 })[0], /within the first 4 results/);
  });

  it('under --air-gapped the steps name a local model only', () => {
    const t = closingTips({ ndx: '.x', raw: '@claim.txt', described: 0, entriesN: 5, claimLike: true, airGapped: true }).join('\n');
    assert.match(t, /--describe --model <gguf>/);
    assert.match(t, /--toward-code label --model <gguf>/);
    assert.doesNotMatch(t, /--llm/);
  });
});

describe('--semantic-search and --build-embeddings: the command line', () => {
  const indexWith = (mech) => {
    const dir = tmp('ce-sem-cli-');
    if (mech) fs.writeFileSync(path.join(dir, 'mechanisms.json'), JSON.stringify({ format: MECHANISMS_FORMAT, version: 1, records: [{ id: 'm1', label: '[file] a.js', kind: 'file', members: [{ file: 'a.js', name: 'f', start: 1, end: 9 }] }] }));
    return dir;
  };

  it('with no --ndx the default index path is used, and a folder with no index there says what to build, exit 2', () => {
    const cwd = tmp('ce-sem-cwd-');
    const a = spawnSync(process.execPath, [ENTRY, '--semantic-search', 'x'], { cwd, encoding: 'utf8', input: '' });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /\.code_search_index has no mechanisms\.json/);
    const b = spawnSync(process.execPath, [ENTRY, '--build-embeddings'], { cwd, encoding: 'utf8', input: '' });
    assert.equal(b.status, 2);
    assert.match(b.stderr, /\.code_search_index has no mechanisms\.json/);
  });

  it('an index with no mechanisms names --build-mechanisms and then --build-embeddings', () => {
    const dir = indexWith(false);
    const r = run('--ndx', dir, '--semantic-search', 'x');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /has no mechanisms\.json/);
    assert.match(r.stderr, /--build-mechanisms\n.*--build-embeddings/);
    const b = run('--ndx', dir, '--build-embeddings');
    assert.equal(b.status, 2);
    assert.match(b.stderr, /Build it first \(no model needed\):\n.*--build-mechanisms/);
  });

  it('an index with no embeddings says to build them and run the search again, loads no model, and prints no results', () => {
    const dir = indexWith(true);
    const r = run('--ndx', dir, '--semantic-search', 'refuse a cloud model');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /has no embeddings yet\. Build them \(once per index\), then run the search again:\n {2}ce --ndx .* --build-embeddings/);
    assert.doesNotMatch(r.stderr, /loading/);
    assert.equal(r.stdout.trim(), '');
  });

  it('--help has an entry for each, says a search builds nothing, and shows both under --help embed', () => {
    const entryOf = (out, flag) => out.split(/\r?\n/).some((l) => l.startsWith('  ' + flag + ' ') || l === '  ' + flag);
    const h = run('--help');
    assert.ok(entryOf(h.stdout, '--semantic-search <text|@file>'), 'no entry headed --semantic-search');
    assert.ok(entryOf(h.stdout, '--build-embeddings'), 'no entry headed --build-embeddings');
    assert.match(h.stdout, /a search builds\s+nothing and says what to run/);
    assert.match(h.stdout, /places to read and\s+not findings/);
    const e = run('--help', 'embed');
    assert.ok(entryOf(e.stdout, '--semantic-search <text|@file>') && entryOf(e.stdout, '--build-embeddings'), e.stdout.slice(0, 300));
  });

  const gemma = path.join(ROOT, 'models', EMBED_MODELS.gemma.file);
  const canRun = fs.existsSync(gemma) && builtModelBases(path.join(ROOT, '.CE')).includes(base('gemma'));
  it('end to end on CodeExam\'s own index, when gemma and its embeddings are there: the model is chosen and named, and results are functions with lines', { skip: canRun ? false : 'needs models/' + EMBED_MODELS.gemma.file + ' and built gemma embeddings in .CE' }, () => {
    const r = spawnSync(process.execPath, [ENTRY, '--ndx', '.CE', '--semantic-search', 'refuse to send code to a cloud model'], { cwd: ROOT, encoding: 'utf8', input: '' });
    assert.equal(r.status, 0, r.stderr.slice(-400));
    assert.match(r.stdout, /^Semantic search of \.CE for: refuse to send code to a cloud model/);
    assert.match(r.stdout, /using the gemma embeddings already built for this index/);
    // the closing line (part E4 of test-options-remaining-commands), the last line of the output, not a clause of the header
    assert.match(r.stdout.trim().split('\n').pop(), /^Tip: [\d,]+ groups?(?: and [\d,]+ functions?)? of test, benchmark, mock and example code left out; --include-tests lists (?:it|them)\.$/);
    assert.match(r.stdout, /\n {2}HITS\n\s+1\. 0\.\d{3} {2}\S+ {3}\S+:\d+-\d+\n/);
    assert.match(r.stdout, /It is not a finding that the code does what the text says\./);
    assert.doesNotMatch(r.stdout, /cosine \d|distance \d/);
  });

  it('--toward-code is taken by a search: an unknown form is refused by name with no results, and --spec without it is refused', { skip: canRun ? false : 'needs models/' + EMBED_MODELS.gemma.file + ' and built gemma embeddings in .CE' }, () => {
    const a = spawnSync(process.execPath, [ENTRY, '--ndx', '.CE', '--semantic-search', 'refuse a cloud model', '--toward-code', 'rewrite', '--llm', 'claude'], { cwd: ROOT, encoding: 'utf8', input: '' });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /--toward-code takes restate or label, or @<file> of rewrites an earlier run saved \(got "rewrite"\)/);
    assert.equal(a.stdout.trim(), '', 'no listing is printed as if the option had not been given');
    const b = spawnSync(process.execPath, [ENTRY, '--ndx', '.CE', '--semantic-search', 'refuse a cloud model', '--spec', 'spec.txt'], { cwd: ROOT, encoding: 'utf8', input: '' });
    assert.equal(b.status, 2);
    assert.match(b.stderr, /--spec gives the patent's specification to the model that --toward-code restate\|label asks for rewrites/);
  });
});

// rust-inline-tests-pass-as-code (2026-11-19): a member the mechanisms index marks as a test
// counts as one, whatever its name and path.
import { buildCorpus as _bc } from '../src/core/function-text.js';
describe('semantic search: tests marked in the index, not only by name and path', () => {
  it('an entry whose members are all marked is test code; a mixed entry is not', () => {
    const allTests = { members: [{ name: 'posting_does_not_settle', file: 'src/ledger.rs', test: true }, { name: 'settling_keeps_total', file: 'src/ledger.rs', test: true }] };
    const mixed = { members: [{ name: 'settle_ledger', file: 'src/ledger.rs' }, { name: 'posting_does_not_settle', file: 'src/ledger.rs', test: true }] };
    assert.equal(isTestEntry(allTests), true);
    assert.equal(isTestEntry(mixed), false);
  });
  it('the closing line counts whole test groups and the test functions left out of the groups kept; the header says only that tests are included', async () => {
    const { testLeftOutNote, semanticTestsTip } = await import('../src/commands/semantic-search.js');
    assert.equal(semanticTestsTip(5, 0, false), 'Tip: 5 groups of test, benchmark, mock and example code left out; --include-tests lists them.');
    assert.equal(semanticTestsTip(5, 71, false), 'Tip: 5 groups and 71 functions of test, benchmark, mock and example code left out; --include-tests lists them.');
    assert.equal(semanticTestsTip(0, 1, false), 'Tip: 1 function of test, benchmark, mock and example code left out; --include-tests lists it.');
    assert.equal(semanticTestsTip(0, 0, false), '');
    assert.equal(semanticTestsTip(5, 71, true), '', 'with --include-tests nothing is left out');
    assert.equal(testLeftOutNote(false), '');
    assert.equal(testLeftOutNote(true), '; test code included');
  });
  it('the function corpus marks a function under a test attribute', () => {
    const lines = ['fn settle_ledger() {', '}', '', '#[test]', 'fn posting_does_not_settle() {', '}'];
    const c = _bc({ 'src/ledger.rs': { settle_ledger: { start: 1, end: 2 }, posting_does_not_settle: { start: 5, end: 6 } } }, () => lines);
    const by = (n) => c.fns.find((f) => f.name === n);
    assert.equal(by('posting_does_not_settle').test, true);
    assert.equal('test' in by('settle_ledger'), false);
  });
});
