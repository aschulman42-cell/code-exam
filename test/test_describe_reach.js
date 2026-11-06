// test_describe_reach.js — the describe-reach harness's scoring with no model: anchor-to-entry mapping, conservative ranks, reach@k and strict, the BM25 control, the report
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// issue-322-describe-reach (2026-11-05). The script's scoring is pure; the
// embedding is the only part that needs a model, and it is not exercised here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOwnArgs, entryText, entryChunks, splitName, entriesHolding, ranksOf, medianOf, scoreRun, bm25Index, cosine, locatorBaseline, renderRun, renderPooled, rrfFuse, RRF_K, embedAll, CACHE_CHECKPOINT, renderCompare } from '../scripts/describe-reach.mjs';

const entries = [
  { id: 'm1', label: '[class] Ledger', kind: 'class', description: 'Ledger keeps a running balance per account and settles the entries of one day.', purpose: 'Holds the entries of one day.', members: [{ file: 'pkg/ledger.py', name: 'Ledger::post_entry' }, { file: 'pkg/ledger.py', name: 'Ledger::settle' }] },
  { id: 'm2', label: '[file] util.js', kind: 'file', description: 'Pads and rounds numbers for the ledger scripts.', purpose: 'small helpers', members: [{ file: 'src/util.js', name: 'pad' }, { file: 'src/util.js', name: 'round2' }] },
  { id: 'm3', label: '[file] report.py', kind: 'file', description: null, purpose: 'One line per entry and the total.', members: [{ file: 'pkg/report.py', name: 'statement' }] },
  { id: 'm4', label: 'walk (walkTree)', kind: 'token', description: null, purpose: '', members: [{ file: 'lib/tree.js', name: 'walkTree' }] },
];

describe('describe-reach', () => {
  it('parses its arguments and refuses an unknown text mode', () => {
    const o = parseOwnArgs(['--hof', 'a,b', '--k', '1,3', '--top', '2', '--cpu', '--dry', '--text', 'purpose']);
    assert.deepEqual([o.hof, o.k, o.top, o.cpu, o.dry, o.text], [['a', 'b'], [1, 3], 2, true, true, 'purpose']);
    assert.throws(() => parseOwnArgs(['--text', 'members']), /--text takes/);
    assert.throws(() => parseOwnArgs(['--bogus']), /unknown argument/);
  });

  it('the text per entry: the description, then the purpose, then the label and members, and the kind says which', () => {
    assert.deepEqual(entryText(entries[0], 'description'), { text: entries[0].description, kind: 'description' });
    assert.deepEqual(entryText(entries[2], 'description'), { text: 'One line per entry and the total.', kind: 'purpose' });
    assert.deepEqual(entryText(entries[3], 'description'), { text: 'walk (walkTree): walk Tree', kind: 'label' });
    assert.equal(entryText(entries[0], 'description+purpose').text, `${entries[0].description} ${entries[0].purpose}`);
    assert.equal(entryText(entries[0], 'purpose').text, 'Holds the entries of one day.');
    assert.equal(entryText(entries[0], 'label+members').text, '[class] Ledger: Ledger post entry, Ledger settle');
    assert.equal(splitName('TreeSitterParser::_extractCCpp'), 'Tree Sitter Parser extract CCpp');
  });

  it('an anchor maps to every entry whose members hold it, by file base name and bare or qualified function name', () => {
    assert.deepEqual(entriesHolding(entries, { file: 'src/pkg/ledger.py', base: 'ledger.py', func: 'settle' }), [0]);
    assert.deepEqual(entriesHolding(entries, { file: 'pkg/LEDGER.py', func: 'Ledger::settle' }), [0], 'the base name is case-insensitive and a qualified name matches');
    assert.deepEqual(entriesHolding(entries, { file: 'lib/tree.js', func: 'walkTree' }), [3]);
    assert.deepEqual(entriesHolding(entries, { file: 'pkg/ledger.py', func: 'nope' }), []);
  });

  it('ranks are conservative within a tie and the median ignores the unreached', () => {
    assert.deepEqual(ranksOf([0.9, 0.5, 0.9, 0.1]), [2, 3, 2, 4]);
    assert.deepEqual(ranksOf([0, 0, 0]), [3, 3, 3], 'all tied: every entry takes the last place');
    assert.equal(medianOf([1, 5, 3]), 3);
    assert.equal(medianOf([1, 2, 3, 4]), 2.5);
    assert.equal(medianOf([Infinity, 2]), 2);
    assert.equal(medianOf([]), null);
    assert.equal(cosine([1, 0], [0, 1]), 0);
  });

  it('scoreRun: reach@k over the union of a claim\'s elements, strict on each element\'s top entry, an anchor in no entry counted and reported', () => {
    const claims = [{ n: 1, label: 'c1', claim: 'x', anchors: [{ file: 'pkg/ledger.py', base: 'ledger.py', func: 'settle' }, { file: 'src/util.js', base: 'util.js', func: 'pad' }, { file: 'gone.py', base: 'gone.py', func: 'lost' }] }];
    const elementsOf = () => ['settles the day', 'pads numbers'];
    // element 1 ranks m1 first; element 2 ranks m2 second behind m3
    const scoreOf = (t) => (t.startsWith('settles') ? [0.9, 0.2, 0.1, 0.0] : [0.1, 0.5, 0.6, 0.0]);
    const r = scoreRun(claims, entries, scoreOf, { ks: [1, 2], top: 2, elementsOf });
    assert.deepEqual(r.reach, { 1: 1, 2: 2 });
    assert.equal(r.unmapped, 1);
    assert.deepEqual(r.anchors.map((a) => a.best), [1, 2, null]);
    assert.equal(r.median, 1.5, 'the median over the reached anchors');
    assert.deepEqual(r.strict, { elements: 2, hit: 1 }, 'one element\'s top entry holds an anchor');
    assert.deepEqual(r.claims[0].anchorsReached, { 1: 1, 2: 2 });
    assert.equal(r.claims[0].top[1].entries[0].label, '[file] report.py');
    assert.equal(r.claims[0].top[1].entries[1].anchor, true);
  });

  it('the BM25 control ranks the entry whose text carries the element\'s words', () => {
    const ix = bm25Index(entries.map((e) => entryText(e, 'description').text));
    const s = ix.score('settles the entries of one day into a balance');
    assert.equal(ranksOf(s)[0], 1, 'the ledger description leads');
    assert.ok(s[3] === 0, 'a text sharing no stem scores zero');
  });

  it('the locator baseline reads the report totals, and the report renders a table per run and a pooled table', () => {
    assert.deepEqual(locatorBaseline({ totals: { anchors: 10, function: 4, class: 1, file: 2, miss: 3 } }), { anchors: 10, fn: 4, fileOrBetter: 7 });
    const m = { reach: { 1: 3, 5: 5 }, median: 2, strict: { elements: 4, hit: 2 }, claims: [] };
    const run = { name: 'r', entries: 4, textKinds: { description: 2, purpose: 1, label: 1 }, claims: [{}], anchors: 6, unmapped: 1, methods: { lexical: m }, locator: { anchors: 6, fn: 2, fileOrBetter: 5 }, ks: [1, 5], primary: 'lexical' };
    const lines = renderRun(run);
    assert.equal(lines[0], '### r');
    assert.match(lines[2], /^4 entries \(2 description, 1 purpose, 1 label as the text\); 1 claims, 6 anchors, 1 in no entry\.$/);
    assert.match(lines.join('\n'), /\| lexical \| 3 \(50%\) \| 5 \(83%\) \| 2 \| 2 of 4 \(50%\) \|/);
    assert.match(lines.join('\n'), /locator \(hof_report\): anchors at the function rung \| 2 \(33%\)/);
    const pooled = renderPooled([run, run], [1, 5]).join('\n');
    assert.match(pooled, /Pooled over 2 runs, 12 anchors/);
    assert.match(pooled, /\| lexical \| 6 \(50%\) \| 10 \(83%\) \| 4 of 8 \(50%\) \|/);
    assert.match(pooled, /locator: function rung \| 4 \(33%\)/);
  });

  // describe-reach-second-describer (2026-11-06): --chunk, --fuse, --compare, the cache checkpoint.

  it('parses --chunk, --fuse and --compare, and refuses a bad chunk or a one-file compare', () => {
    const o = parseOwnArgs(['--chunk', '0', '--fuse', '--compare', 'a.json,b.json']);
    assert.deepEqual([o.chunk, o.fuse, o.compare], [0, true, ['a.json', 'b.json']]);
    assert.equal(parseOwnArgs([]).chunk, 8, 'chunks of 8 by default');
    assert.throws(() => parseOwnArgs(['--chunk', 'x']), /--chunk takes/);
    assert.throws(() => parseOwnArgs(['--compare', 'a.json']), /--compare takes two/);
  });

  it('entryChunks: a label text of 20 names is three chunks of 8, 8 and 4, each led by the label; 0 is the whole text; a description is one chunk', () => {
    const big = { id: 'm9', label: '[file] big.c', kind: 'file', members: Array.from({ length: 20 }, (_, i) => ({ file: 'big.c', name: `fn_${i}` })) };
    const cs = entryChunks(big, 'label+members', 8);
    assert.equal(cs.length, 3);
    assert.ok(cs.every((c) => c.startsWith('[file] big.c: ')));
    assert.deepEqual(cs.map((c) => c.split(', ').length), [8, 8, 4]);
    assert.deepEqual(entryChunks(big, 'label+members', 0), [entryText(big, 'label+members').text]);
    assert.deepEqual(entryChunks(entries[0], 'description', 8), [entries[0].description], 'a sentence is never chunked');
    assert.deepEqual(entryChunks(entries[1], 'label+members', 8), [entryText(entries[1], 'label+members').text], 'two names fit one chunk, which is the whole text');
  });

  it('rrfFuse: an entry second in both lists outranks one first in one and far down the other, and a 1-2 swap resolves by the last list', () => {
    // entries: 0 is first lexically and 9th by embedding; 1 is second in both; 2 is first by embedding and 9th lexically
    const lex = [1.0, 0.9, 0.1, 0.5, 0.4, 0.3, 0.2, 0.15, 0.12];
    const emb = [0.1, 0.9, 1.0, 0.5, 0.4, 0.3, 0.2, 0.15, 0.12];
    const r = ranksOf(rrfFuse([lex, emb]));
    assert.equal(r[1], 1, 'second in both wins');
    assert.equal(1 / (RRF_K + 1) + 1 / (RRF_K + 9) < 2 / (RRF_K + 2), true);
    // a pure 1-2 swap: lexical says A then B, embedding says B then A; the embedding breaks the tie
    const lex2 = [1.0, 0.9, 0.1], emb2 = [0.9, 1.0, 0.1];
    assert.deepEqual(ranksOf(rrfFuse([lex2, emb2])).slice(0, 2), [2, 1], 'B first, by the embedding');
    assert.deepEqual(ranksOf(rrfFuse([emb2, lex2])).slice(0, 2), [1, 2], 'and A first when the lexical list comes last');
  });

  it('embedAll: the cache is written every CACHE_CHECKPOINT embeddings, so a stop keeps what ran, and a rerun reads it back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'describe-reach-'));
    const file = path.join(dir, 'vecs.json');
    const texts = Array.from({ length: CACHE_CHECKPOINT + 1 }, (_, i) => ({ key: `k${i}`, text: `text ${i}` }));
    let calls = 0;
    const failing = { getEmbeddingFor: async () => { calls++; if (calls > CACHE_CHECKPOINT) throw new Error('stopped'); return { vector: [calls, 1] }; } };
    await assert.rejects(embedAll(failing, texts, file, { quiet: true }), /stopped/);
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.keys(kept.items).length, CACHE_CHECKPOINT, 'the checkpoint holds the first batch');
    let fresh = 0;
    const working = { getEmbeddingFor: async () => { fresh++; return { vector: [1, 0] }; } };
    const out = await embedAll(working, texts, file, { quiet: true });
    assert.equal(fresh, 1, 'only the one past the checkpoint is embedded again');
    assert.equal(out.size, CACHE_CHECKPOINT + 1);
    assert.ok(Math.abs(Math.hypot(...out.get('k0')) - 1) < 1e-9, 'vectors are unit');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renderCompare: two records of the same runs, one table per run and pooled, the difference B minus A, a dash where a method is missing', () => {
    const m = (r1, r25, hit, els) => ({ reach: { 1: r1, 25: r25 }, strict: { hit, elements: els }, claims: [] });
    const run = (name, anchors, methods, engine) => ({ name, anchors, methods, locator: { anchors, fn: 2, fileOrBetter: 5 }, describedEngine: engine });
    const a = { format: 'ce-describe-reach', text: 'description', ks: [1, 5, 10, 25], runs: [run('r1', 10, { lexical: m(7, 9, 3, 10), embedding: m(8, 9, 4, 10) }, 'Claude API'), run('r2', 20, { lexical: m(10, 18, 5, 20), embedding: m(12, 19, 6, 20) }, 'Claude API')] };
    const b = { format: 'ce-describe-reach', text: 'description', ks: [1, 5, 10, 25], runs: [run('r1', 10, { lexical: m(5, 9, 2, 10) }, 'Gemini API'), run('r2', 20, { lexical: m(6, 16, 3, 20), embedding: m(9, 18, 4, 20) }, 'Gemini API')] };
    const out = renderCompare(a, b).join('\n');
    assert.match(out, /^## Claude API against Gemini API: 2 runs in common/);
    assert.match(out, /\| method \| reach@1 Claude API \| Gemini API \| Δ \| reach@25 Claude API \| Gemini API \| Δ \| strict Claude API \| Gemini API \| Δ \|/);
    assert.match(out, /### r1 \(10 anchors; described by Claude API \/ Gemini API\)/);
    assert.match(out, /\| lexical \| 70% \| 50% \| -20 \| 90% \| 90% \| 0 \| 30% \| 20% \| -10 \|/);
    assert.match(out, /\| embedding \| 80% \| — \|  \| 90% \| — \|  \| 40% \| — \|  \|/, 'a method the second record lacks');
    assert.match(out, /### Pooled over 2 runs, 30 anchors/);
    assert.match(out, /\| lexical \| 57% \| 37% \| -20 \| 90% \| 83% \| -7 \| 27% \| 17% \| -10 \|/);
    assert.match(out, /\| embedding \| 67% \| — \|/, 'pooled only over runs both records score');
    const named = renderCompare({ runs: [run('r1', 10, { lexical: m(1, 2, 1, 2) }, null)], ks: [1, 25] }, { runs: [run('r1', 10, { lexical: m(2, 2, 1, 2) }, null)], ks: [1, 25] }, { nameA: 'run5', nameB: 'run11' }).join('\n');
    assert.match(named, /^## run5 against run11: 1 run in common/);
  });
});
