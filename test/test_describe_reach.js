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
import { parseOwnArgs, entryText, splitName, entriesHolding, ranksOf, medianOf, scoreRun, bm25Index, cosine, locatorBaseline, renderRun, renderPooled } from '../scripts/describe-reach.mjs';

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
});
