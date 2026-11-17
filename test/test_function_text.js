// test_function_text.js — the mechanical text for a function, class or file and the reach script's scoring, with no index and no model: source split into code, comments and literals, the ranked vocabulary, the four arms, unit chunks, the roll-up, the set reading, the pool, the tallies and the control
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// function-text-reach-test (2026-11-14). src/core/function-text.js is pure
// given a function index and a file's lines; scripts/function-text-reach.mjs
// keeps the model and the index in main() and prepare(), and what it computes
// from vectors is tested here with hand-made scores.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMS, classOf, leafOf, phrase, splitSource, leadingComment, identifierCounts, calledNames,
  literalWords, rankIdentifiers, buildCorpus, functionText, unitChunks, unitsOf, rollUp, setReading,
} from '../src/core/function-text.js';
import {
  parseOwnArgs, pickPool, anchorIds, answerRanks, emptyTally, addToTally, mergeTally, scoreIndex,
  tallyLine, headOf, renderTable,
} from '../scripts/function-text-reach.mjs';

const SRC = {
  'src/rate.c': [
    '/* Pick the bit rate the channel can carry. */',
    'int select_rate(struct channel *ch) {',
    '  // measure first',
    '  int snr = measure_snr(ch);',
    '  log_msg("selected rate for channel");',
    '  return lookup_rate(snr);',
    '}',
    '',
    'int measure_snr(struct channel *ch) {',
    '  return ch->signal - ch->noise;',
    '}',
    'int lookup_rate(int snr) {',
    '  return rate_table[snr];',
    '}',
  ],
  'lib/q.py': [
    'class Queue:',
    '    # put one item',
    '    def push(self, item):',
    '        """Append the item to the tail."""',
    '        self.items.append(item)',
    '    def pop(self):',
    '        return self.items.pop()',
  ],
};
const FI = {
  'src\\rate.c': { select_rate: { start: 2, end: 7 }, measure_snr: { start: 9, end: 11 }, lookup_rate: { start: 12, end: 14 } },
  'lib/q.py': { 'Queue.push': { start: 3, end: 5 }, 'Queue.pop': { start: 6, end: 7 } },
};
const corpus = () => buildCorpus(FI, (f) => SRC[f.replace(/\\/g, '/')]);
const fn = (c, name) => c.fns.find((f) => f.name === name);

describe('function-text: names', () => {
  it('reads the class and the last segment of a qualified name', () => {
    assert.equal(classOf('A::B::f'), 'A::B');
    assert.equal(classOf('Queue.push'), 'Queue');
    assert.equal(classOf('free_fn'), '');
    assert.equal(leafOf('A::B::f'), 'f');
  });
  it('writes an identifier as lower-case words and drops the second-definition mark', () => {
    assert.equal(phrase('secp256k1_fe_getB32'), 'secp256k1 fe get b32');
    assert.equal(phrase('compute@110'), 'compute');
  });
});

describe('function-text: splitting a source text', () => {
  it('separates code, comments and literals for a C-family file', () => {
    const s = splitSource('int a = f("hello world"); // set a\n/* block\n * two */ b();', 'x.c');
    assert.ok(!s.code.includes('hello') && !s.code.includes('set a') && s.code.includes('b()'));
    assert.equal(s.comments, 'set a block two');
    assert.deepEqual(s.strings, ['hello world']);
  });
  it('reads # comments and docstrings in Python, and leaves # alone in C', () => {
    const p = splitSource('x = 1  # one\n"""Doc here."""\n', 'a.py');
    assert.equal(p.comments, 'one Doc here.');
    assert.ok(splitSource('#include <a.h>\n', 'a.c').code.includes('include'));
  });
  it('takes the comment block directly above a function and stops at code', () => {
    assert.equal(leadingComment(SRC['src/rate.c'], 2, 'src/rate.c'), 'Pick the bit rate the channel can carry.');
    assert.equal(leadingComment(SRC['src/rate.c'], 9, 'src/rate.c'), '');
    assert.equal(leadingComment(SRC['lib/q.py'], 3, 'lib/q.py'), 'put one item');
  });
});

describe('function-text: vocabulary', () => {
  it('counts identifiers and leaves out language words and short names', () => {
    const tf = identifierCounts('int snr = measure_snr(ch); return snr;');
    assert.equal(tf.get('snr'), 2);
    assert.equal(tf.get('measure_snr'), 1);
    assert.ok(!tf.has('int') && !tf.has('return') && !tf.has('ch'));
  });
  it('ranks the rare identifier first and honours the cut and the skip list', () => {
    const tf = new Map([['common', 3], ['rare', 1], ['own', 5]]);
    const df = new Map([['common', 90], ['rare', 2], ['own', 1]]);
    assert.deepEqual(rankIdentifiers(tf, df, 100, 2, new Set(['own'])), ['rare', 'common']);
    assert.deepEqual(rankIdentifiers(tf, df, 100, 1), ['own']);
  });
  it('reads calls by name against the names the index defines', () => {
    assert.deepEqual(calledNames('a(); b (x); c(); a();', new Set(['a', 'b'])), ['a', 'b']);
  });
  it('keeps literal words once each, up to the cut', () => {
    assert.deepEqual(literalWords(['selected rate for channel', 'rate %d'], 3), ['selected', 'rate', 'channel']);
  });
});

describe('function-text: the corpus and the four arms', () => {
  it('builds one entry per function with slash paths, comments, literals and calls', () => {
    const c = corpus();
    assert.equal(c.n, 5);
    const f = fn(c, 'select_rate');
    assert.equal(f.id, 'src/rate.c@select_rate');
    assert.deepEqual(f.calls, ['measure_snr', 'lookup_rate']);
    assert.ok(f.comments.startsWith('Pick the bit rate'));
    assert.ok(f.comments.includes('measure first'));
    assert.deepEqual(c.callersOf.get('measure_snr'), ['select_rate']);
    assert.equal(fn(c, 'Queue.push').cls, 'Queue');
  });
  it('keeps a function whose file has no lines, by its name alone', () => {
    const c = buildCorpus({ 'gone.c': { f: { start: 1, end: 3 } } }, () => null);
    assert.equal(functionText(c.fns[0], 'context', c), 'f. In gone');
  });
  it('makes each arm a superset of the one before', () => {
    const c = corpus();
    const f = fn(c, 'select_rate');
    const t = Object.fromEntries(ARMS.map((a) => [a, functionText(f, a, c)]));
    assert.equal(t.name, 'select rate');
    assert.ok(t.vocab.startsWith('select rate: ') && t.vocab.includes('measure snr'));
    assert.ok(t.comments.startsWith(t.vocab) && t.comments.includes('Pick the bit rate') && t.comments.includes('Text: selected rate channel'));
    assert.ok(t.context.startsWith(t.comments) && t.context.includes('In rate') && t.context.includes('Calls measure snr, lookup rate'));
    assert.ok(functionText(fn(c, 'measure_snr'), 'context', c).includes('Called by select rate'));
    assert.ok(functionText(fn(c, 'Queue.push'), 'context', c).includes('In q, queue'));
    assert.throws(() => functionText(f, 'prose', c), /arm is one of/);
  });
});

describe('function-text: classes and files', () => {
  it('groups by file, and by class leaving free functions out', () => {
    const c = corpus();
    assert.deepEqual(unitsOf(c.fns, 'file').map((u) => [u.label, u.members.length]), [['rate', 3], ['q', 2]]);
    assert.deepEqual(unitsOf(c.fns, 'class').map((u) => [u.label, u.members.length]), [['Queue', 2]]);
  });
  it('gives a small unit one text and a large one a text per run of functions as well', () => {
    const c = corpus();
    const u = unitsOf(c.fns, 'file')[0];
    const one = unitChunks(u.label, u.members, c);
    assert.equal(one.length, 1);
    assert.ok(one[0].startsWith('rate: select rate, measure snr, lookup rate'));
    assert.equal(unitChunks(u.label, u.members, c, { run: 2 }).length, 3);
  });
  it('scores a group as its best member, and an empty group as nothing', () => {
    assert.deepEqual(rollUp([0.1, 0.9, 0.4], [[0, 2], [1], []]), [0.4, 0.9, -Infinity]);
  });
  it('reads a set three ways at a depth', () => {
    assert.deepEqual(setReading([1, 30, 4], 5), { n: 3, hit: 2, any: true, share: 2 / 3, all: false });
    assert.equal(setReading([2, 3], 5).all, true);
    assert.deepEqual(setReading([], 5), { n: 0, hit: 0, any: false, share: null, all: false });
  });
});

describe('function-text-reach: arguments and the pool', () => {
  it('reads its options and refuses what it cannot run', () => {
    const o = parseOwnArgs(['--filings', 'w', '--arms', 'name,vocab', '--k', '5,25', '--pool', '100', '--dry']);
    assert.deepEqual([o.filings, o.arms, o.k, o.pool, o.dry], ['w', ['name', 'vocab'], [5, 25], 100, true]);
    assert.throws(() => parseOwnArgs([]), /--filings <work dir> or --hof/);
    assert.throws(() => parseOwnArgs(['--hof', 'a', '--arms', 'prose']), /--arms takes/);
    assert.throws(() => parseOwnArgs(['--hof', 'a,b', '--claims-file', 'c']), /one --hof run/);
  });
  it('keeps every function of a small index, and of a large one the answers, their files and a fixed sample', () => {
    const fns = [];
    for (let i = 0; i < 40; i++) fns.push({ id: `f${i % 4}.c@fn${i}`, file: `f${i % 4}.c`, name: `fn${i}` });
    assert.equal(pickPool(fns, new Set(), 40).sampled, false);
    const a = pickPool(fns, new Set(['f1.c@fn1']), 15);
    assert.equal(a.sampled, true);
    assert.equal(a.fns.length, 15);
    assert.equal(a.fns.filter((f) => f.file === 'f1.c').length >= 10, true);
    assert.deepEqual(pickPool(fns, new Set(['f1.c@fn1']), 15).fns.map((f) => f.id), a.fns.map((f) => f.id));
  });
  it('resolves a self-test anchor by file base name and name or last segment', () => {
    const fns = [{ id: 'a/q.py@Queue.push', file: 'a/q.py', name: 'Queue.push' }, { id: 'b/q.py@push', file: 'b/q.py', name: 'push' }, { id: 'a/r.py@push', file: 'a/r.py', name: 'push' }];
    assert.deepEqual(anchorIds(fns, { file: 'x/q.py', func: 'push' }), ['a/q.py@Queue.push', 'b/q.py@push']);
  });
});

describe('function-text-reach: scoring', () => {
  const ks = [1, 2];
  it('takes an answer\'s best rank over the texts and the units holding it', () => {
    const holders = new Map([['a', [0, 2]], ['b', [1]]]);
    assert.deepEqual(answerRanks([[3, 2, 5], [4, 1, 1]], holders, ['a', 'b', 'c']), { ranks: [1, 1], notHeld: 1 });
  });
  it('tallies functions within k, any, and all over queries of two or more', () => {
    const t = emptyTally(ks);
    addToTally(t, [1, 3], 1, ks);
    addToTally(t, [2], 0, ks);
    addToTally(t, [], 2, ks);
    assert.deepEqual([t.queries, t.multi, t.answers, t.notHeld], [2, 1, 3, 3]);
    assert.deepEqual([t.hit[1], t.hit[2], t.any[1], t.any[2], t.all[2]], [1, 2, 1, 2, 0]);
    const m = mergeTally(t, t, ks);
    assert.deepEqual([m.queries, m.answers, m.hit[2], m.ranks.length], [4, 6, 4, 6]);
  });
  it('scores each query under its own text and the control under the next query\'s', () => {
    // Three functions; a query's vector is the scores themselves.
    const fnMethod = { name: 'fn', unit: 'function', units: 3, holders: new Map([['x', [0]], ['y', [1]], ['z', [2]]]), scoreOf: (q, shared) => (shared.s = q) };
    const up = { name: 'file', unit: 'file', units: 2, holders: new Map([['x', [0]], ['y', [0]], ['z', [1]]]), scoreOf: (q, shared) => rollUp(shared.s, [[0, 1], [2]]) };
    const queries = [{ id: 'q1', vecs: [[0.9, 0.1, 0.2]], answers: ['x'] }, { id: 'q2', vecs: [[0.1, 0.2, 0.9]], answers: ['z'] }];
    const r = scoreIndex([fnMethod, up], queries, ks);
    assert.deepEqual([r.fn.real.hit[1], r.fn.real.answers], [2, 2]);
    assert.deepEqual([r.fn.control.hit[1], r.fn.control.answers], [0, 2]);
    assert.deepEqual([r.file.real.hit[1], r.file.control.hit[1]], [2, 0]);
    // Chance draws as many held functions as each answer has, the same ones on every run.
    assert.equal(r.fn.chance.answers, 2);
    assert.deepEqual(scoreIndex([fnMethod, up], queries, ks).fn.chance, r.fn.chance);
  });
  it('prints chance after the other-query control when a tally carries it', () => {
    const t = { real: addToTally(emptyTally(ks), [1, 3], 0, ks), control: addToTally(emptyTally(ks), [3, 3], 0, ks), chance: addToTally(emptyTally(ks), [1, 1], 0, ks) };
    assert.equal(tallyLine('m', 9, t, ks)[4], '50% (0% / 100%)');
    assert.ok(headOf(ks)[4].includes('other query / chance'));
  });
  it('prints one line per method with the control beside each depth', () => {
    const t = { real: addToTally(emptyTally(ks), [1, 3], 1, ks), control: addToTally(emptyTally(ks), [3, 3], 0, ks) };
    const line = tallyLine('function: name', 900, t, ks);
    assert.equal(line.length, headOf(ks).length);
    assert.deepEqual(line.slice(0, 6), ['function: name', '900', '1', '2', '50% (0%)', '50% (0%)']);
    assert.ok(renderTable('t', [line], ks, true).includes('| function: name | 900 |'));
    assert.ok(renderTable('t', [line], ks, false).startsWith('t\nmethod'));
  });
});

describe('function-text-reach: fusing a unit\'s own text with its best function\'s', async () => {
  const { fuseMax, fuseSum, fuseRanks, fusedMethods, catalogEntries, FUSE_WEIGHTS, FUSE_ARM } = await import('../scripts/function-text-reach.mjs');
  const NI = -Infinity;

  it('the weights and the arm are fixed, not searched', () => {
    assert.deepEqual(FUSE_WEIGHTS, [0.3, 0.5, 0.7]);
    assert.equal(FUSE_ARM, 'comments');
  });
  it('takes the higher cosine, and a unit with one text keeps that one', () => {
    assert.deepEqual(fuseMax([0.2, 0.9, NI], [0.5, 0.1, 0.4]), [0.5, 0.9, 0.4]);
    assert.deepEqual(fuseMax([NI], [NI]), [NI]);
  });
  it('weights the two, and scores a unit missing one text on the other alone', () => {
    const s = fuseSum([0.2, NI, 0.6], [0.6, 0.4, NI], 0.5);
    assert.ok(Math.abs(s[0] - 0.4) < 1e-12);
    assert.equal(s[1], 0.4);
    assert.equal(s[2], 0.6);
    const w = fuseSum([1, 0], [0, 1], 0.7);
    assert.ok(Math.abs(w[0] - 0.7) < 1e-12 && Math.abs(w[1] - 0.3) < 1e-12);
  });
  it('by rank: a unit second on both lists beats one first on one and last on the other', () => {
    //            unit:   A     B     C     D
    const label =      [0.9,  0.8,  0.1,  0.0];
    const fn =         [0.0,  0.8,  0.1,  0.9];
    const fused = fuseRanks(label, fn);
    assert.ok(fused[1] > fused[0] && fused[1] > fused[3], 'B, second on both, is first');
    assert.ok(fused[2] < fused[1]);
  });
  it('builds five methods for a kind, each reading the two lists from the per-query scratch', () => {
    const K = { n: 2, holders: new Map(), groups: [[0], [1]] };
    const ms = fusedMethods('mechanism', K, 'own:mechanism', 'comments');
    assert.equal(ms.length, 2 + FUSE_WEIGHTS.length);
    assert.ok(ms.every((m) => m.name.startsWith('mechanism: fused, ') && m.unit === 'mechanism' && m.units === 2));
    // unit 0: label 0.1, its function 0.9; unit 1: label 0.6, its function 0.2
    const shared = { 'own:mechanism': [0.1, 0.6], comments: [0.9, 0.2] };
    const max = ms.find((m) => /higher cosine/.test(m.name)).scoreOf(null, shared);
    assert.deepEqual(max, [0.9, 0.6]);
    const half = ms.find((m) => /weighted sum, 0.5/.test(m.name)).scoreOf(null, shared);
    assert.ok(Math.abs(half[0] - 0.5) < 1e-12 && Math.abs(half[1] - 0.4) < 1e-12);
  });
  it('turns catalog rows into texts credited to the one function a handler resolves to', () => {
    const fns = [{ id: 'a.js@doSearch', name: 'doSearch' }, { id: 'b.js@Cls::render', name: 'Cls::render' }, { id: 'c.js@dup', name: 'dup' }, { id: 'd.js@dup', name: 'dup' }];
    const cat = {
      cliOptions: [
        { name: 'search', flags: ['--search'], help: 'Search the index', handler: { handlerFunc: 'doSearch' } },
        { name: 'x', flags: ['--x'], handler: { handlerFunc: 'dup' } },          // two functions of that name: not credited
        { name: 'y', flags: ['--y'], handler: { handlerFunc: null } },          // a modifier: no handler
      ],
      guiActions: [
        { name: 'vocab', label: 'Vocabulary', handler: { handlerFunc: 'render' } },
        { name: 'nolabel', handler: { handlerFunc: 'doSearch' } },               // no label: no text to score
      ],
    };
    const e = catalogEntries(cat, fns);
    assert.deepEqual(e.map((x) => `${x.kind}|${x.fnId}|${x.text}`), ['cli|a.js@doSearch|--search  Search the index', 'gui|b.js@Cls::render|Vocabulary']);
    assert.deepEqual(catalogEntries(null, fns), []);
  });
});

// claim-rewording-blind-test (2026-11-16): the --reword run's own arithmetic, with no model.
import path from 'node:path';
import { sameness, crowding, topUnits, rewordFile, REWORD_ARMS, REWORD_ARM_SPEC } from '../scripts/function-text-reach.mjs';

describe('function-text-reach: --reword, the limitations reworded before they are embedded', () => {
  it('parses the arms, the rewriting model and where the rewrites and specifications are, and refuses what cannot run', () => {
    const o = parseOwnArgs(['--filings', 'w', '--reword', 'blind,label', '--llm', 'claude', '--reword-dir', 'r', '--wrong-map', 'm.json', '--force']);
    assert.deepEqual([o.reword, o.llm, o.rewordDir, o.wrongMap, o.force], [['blind', 'label'], 'claude', 'r', 'm.json', true]);
    assert.equal(parseOwnArgs(['--filings', 'w']).reword, null);
    assert.throws(() => parseOwnArgs(['--filings', 'w', '--reword', 'paraphrase', '--llm', 'claude']), /--reword takes blind, restate, label, spec/);
    assert.throws(() => parseOwnArgs(['--hof', 'a', '--reword', 'blind', '--llm', 'claude']), /--reword goes with --filings/);
    assert.throws(() => parseOwnArgs(['--filings', 'w', '--reword', 'blind']), /--reword needs --llm/);
    assert.throws(() => parseOwnArgs(['--filings', 'w', '--reword', 'spec', '--llm', 'claude']), /the spec arm needs --spec-dir/);
  });

  it('the four arms differ only in what the model is given: blind is the restate form with no vocabulary', () => {
    assert.deepEqual(REWORD_ARMS, ['blind', 'restate', 'label', 'spec']);
    assert.deepEqual(REWORD_ARM_SPEC.blind, { form: 'restate', vocabulary: false, spec: false });
    assert.deepEqual(REWORD_ARM_SPEC.restate, { form: 'restate', vocabulary: true, spec: false });
    assert.deepEqual(REWORD_ARM_SPEC.label, { form: 'label', vocabulary: true, spec: false });
    assert.deepEqual(REWORD_ARM_SPEC.spec, { form: 'restate', vocabulary: true, spec: true });
  });

  it('a job\'s rewordings are one file per model, arm and job, with the wrong index in the name', () => {
    const f = rewordFile('dir', 'claude-sonnet-4-6', 'label', 'foundry-1-11__bitcoin-core__secp256k1__b6c2a3c@huggingface__tgi');
    assert.ok(f.split(path.sep).join('/').endsWith('dir/claude-sonnet-4-6/label/foundry-1-11__bitcoin-core__secp256k1__b6c2a3c@huggingface__tgi.json'), f);
    assert.ok(!/[ :]/.test(rewordFile('d', 'a model: x', 'blind', 'a job/b').replace(/^d/, '').split(path.sep).join('')), 'a name is made safe for a file');
  });

  it('sameness is the cosines over every pair of a chart\'s limitations; one limitation has no pair', () => {
    const s = sameness([[1, 0], [0, 1], [1, 0]]);
    assert.deepEqual(s, { sum: 1, pairs: 3 });
    assert.deepEqual(sameness([[1, 0]]), { sum: 0, pairs: 0 });
  });

  it('topUnits gives the first n units, the best score and the median, skipping a unit with no score', () => {
    const t = topUnits([0.2, 0.9, -Infinity, 0.5, 0.7], 2);
    assert.deepEqual(t.top, [1, 4]);
    assert.equal(t.best, 0.9);
    assert.equal(t.median, 0.6);
    assert.deepEqual(topUnits([], 5), { top: [], best: null, median: null });
  });

  it('crowding counts the first-row slots taken by a unit in half or more of an index\'s lists, and in at least two', () => {
    // four queries: unit 7 is in all four lists, unit 3 in two (half), the rest in one
    const c = crowding([[7, 3, 1], [7, 3, 2], [7, 4, 5], [7, 6, 8]]);
    assert.equal(c.slots, 12);
    assert.equal(c.crowded, 6);
    assert.deepEqual(c.units.sort(), [3, 7]);
    // two queries: a unit must be in both
    assert.equal(crowding([[1, 2], [2, 3]]).crowded, 2);
    assert.equal(crowding([[1, 2], [3, 4]]).crowded, 0);
    // one query crowds nothing
    assert.deepEqual(crowding([[1, 2, 3]]), { slots: 0, crowded: 0, units: [] });
  });
});
