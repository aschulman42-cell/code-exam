// test_carve.js — --carve clusters|calls: the two techniques recover planted groups, the listing's rows and tags, the header's counts, what is said when something is missing, and the command line
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_carve.js - carve-command-clusters-and-calls (2026-11-23).
 *
 * No model and no real index: planted vectors and planted calls, and for the command line
 * folders holding only what each message depends on.
 *
 * Run: node --test test/test_carve.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/argparse.js';
import { sha } from '../src/core/embed.js';
import { MECHANISMS_FORMAT } from '../src/core/mechanisms-index.js';
import {
  leafOrder, readCarveOrder, similarityOrderFor,
  wardMerges, cutTree, louvain, makeRng, callEdges, carveClusters, carveCalls, carveListing, carveUsage, mechanismVectors,
  headingMaker, labelWords, wrapText, purposeText, defaultSections, defaultSubs, PURPOSE_MAX, CALLS_SEED,
} from '../src/core/carve.js';
import { renderCalls, renderClusters, carveNumbers, carveUnusedNotes, cachedVectors, vectorsKey, carveTreeFile } from '../src/commands/carve.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'index.js');
const run = (...args) => spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', input: '' });
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
function withArgv(argv, fn) {
  const saved = process.argv;
  process.argv = [saved[0], saved[1], ...argv];
  try { return fn(); } finally { process.argv = saved; }
}
/** A partition as a canonical string, so two labelings can be compared whatever their label values. */
const partition = (labels) => { const m = new Map(); labels.forEach((l, i) => (m.get(l) || m.set(l, []).get(l)).push(i)); return [...m.values()].map((g) => g.join(',')).sort().join(' | '); };
const partitionOf = (groups) => groups.map((g) => [...g].sort((a, b) => a - b).join(',')).sort().join(' | ');
const unit = (v) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return Float32Array.from(v, (x) => x / n); };

// ---- a planted codebase: three features of four mechanisms each, and one mechanism apart
const FEATURES = ['ledger', 'parser', 'render'];
const planted = () => {
  const entries = [], fnIds = [], fns = [];
  FEATURES.forEach((feat, f) => {
    for (let k = 0; k < 4; k++) {
      const file = `src/${feat}${k}.js`, name = `${feat}Step${k}`;
      entries.push({ id: `m${entries.length + 1}`, label: k === 0 ? `[cmd] --${feat}` : `[file] ${feat}${k}.js`, description: k === 1 ? `Posts ${feat} entries.` : null, purpose: `does ${feat} work ${k}` });
      // each function calls the other three of its feature
      fns.push({ id: `${file}@${name}`, file, name, start: 1, end: 10 + k, calls: [0, 1, 2, 3].filter((j) => j !== k).map((j) => `${feat}Step${j}`) });
      fnIds.push([`${file}@${name}`]);
    }
    void f;
  });
  entries.push({ id: 'm13', label: '[file] lonely.js', description: null, purpose: null });
  fns.push({ id: 'src/lonely.js@lonely', file: 'src/lonely.js', name: 'lonely', start: 1, end: 3, calls: [] });
  fnIds.push(['src/lonely.js@lonely']);
  return { entries, fnIds, fnById: new Map(fns.map((f) => [f.id, f])) };
};
const PLANTED = '0,1,2,3 | 4,5,6,7 | 8,9,10,11';
/** One vector per planted mechanism: its feature's axis plus a little of its own. */
const plantedVectors = () => { const out = []; for (let f = 0; f < 3; f++) for (let k = 0; k < 4; k++) { const v = new Array(8).fill(0); v[f] = 1; v[3 + k] = 0.15; out.push(unit(v)); } return out; };

describe('--carve: the flags', () => {
  it('parses the technique as an optional value and the numbers as numbers; nothing is set by default', () => {
    const a = withArgv(['--carve', 'calls', '--resolution', '4.5', '--seed', '9', '--brief', '--description', '--purpose'], () => parseArgs());
    assert.equal(a.carve, 'calls');
    assert.equal(a.resolution, 4.5);
    assert.equal(a.seed, 9);
    assert.equal(a.brief, true);
    assert.equal(a.description, true);
    assert.equal(a.purpose, true);
    const b = withArgv(['--carve', '--sections', '20', '--sub', '80'], () => parseArgs());
    assert.equal(b.carve, true, 'bare --carve is present with no value');
    assert.equal(b.sections, 20);
    assert.equal(b.sub, 80);
    const c = withArgv([], () => parseArgs());
    assert.equal(c.carve, null);
    for (const k of ['sections', 'sub', 'resolution', 'seed']) assert.equal(c[k], null, k);
    for (const k of ['brief', 'description', 'purpose']) assert.equal(c[k], false, k);
    assert.equal(withArgv(['--carve', 'clusters', '--descriptions'], () => parseArgs()).description, true, '--descriptions is the same option');
  });

  it('checks the numbers and says which is wrong', () => {
    assert.deepEqual(carveNumbers({ sections: 12, sub: 45, resolution: 3, seed: 0 }), { sections: 12, sub: 45, seed: 0, resolution: 3 });
    assert.deepEqual(carveNumbers({}), {});
    assert.match(carveNumbers({ sections: 0 }).problem, /--sections takes a whole number, 1 or more \(got 0\)/);
    assert.match(carveNumbers({ seed: -1 }).problem, /--seed takes a whole number, 0 or more/);
    assert.match(carveNumbers({ resolution: 0 }).problem, /--resolution takes a number above 0/);
  });

  it('names the options that do nothing under the technique chosen', () => {
    const given = (...ks) => ({ _explicit: new Set(ks) });
    assert.deepEqual(carveUnusedNotes(given(), 'calls'), []);
    assert.match(carveUnusedNotes(given('seed', 'resolution'), 'clusters')[0], /^Not used: --resolution, --seed belong to --carve calls/);
    assert.match(carveUnusedNotes(given('sections', 'embed_model'), 'calls')[0], /^Not used: --sections, --embed-model belong to --carve clusters/);
    assert.deepEqual(carveUnusedNotes(given('seed'), 'calls'), []);
    assert.match(carveUnusedNotes(given('filter'), 'calls')[0], /^Not used: --filter does not apply to --carve/);
    assert.match(carveUnusedNotes(given('filter', 'sort_by'), 'calls')[0], /^Not used: --filter, --sort-by do not apply to --carve/);
    assert.match(carveUnusedNotes(given('seed'), 'clusters')[0], /^Not used: --seed belongs to --carve calls/);
  });
});

describe('--carve clusters: Ward\'s method', () => {
  /** The plain form: merge the closest pair each time (cubic), for comparison. */
  const plainMerges = (vs) => {
    const n = vs.length, dim = vs[0].length, D = Array.from({ length: n }, () => new Float64Array(n)), size = new Array(n).fill(1), alive = new Array(n).fill(true), merges = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { let s = 0; for (let d = 0; d < dim; d++) s += vs[i][d] * vs[j][d]; D[i][j] = D[j][i] = Math.fround(2 - 2 * s); }
    for (let step = 0; step < n - 1; step++) {
      let bi = -1, bj = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (alive[i]) for (let j = i + 1; j < n; j++) if (alive[j] && D[i][j] < best) { best = D[i][j]; bi = i; bj = j; }
      const ni = size[bi], nj = size[bj];
      for (let k = 0; k < n; k++) if (alive[k] && k !== bi && k !== bj) { const nk = size[k]; D[bi][k] = D[k][bi] = ((ni + nk) * D[bi][k] + (nj + nk) * D[bj][k] - nk * best) / (ni + nj + nk); }
      alive[bj] = false; size[bi] = ni + nj; merges.push([bi, bj, best]);
    }
    return merges;
  };

  it('the nearest-neighbour chain gives the same clusters as the plain form, at every cut', () => {
    const rnd = makeRng(11), n = 40, dim = 6;
    // five loose blobs, so the tree has structure and no ties
    const vs = Array.from({ length: n }, (_, i) => unit(Array.from({ length: dim }, (_, d) => (d === i % 5 ? 1 : 0) + 0.6 * rnd())));
    const P = new Float32Array(n * dim); vs.forEach((v, i) => P.set(v, i * dim));
    const chain = wardMerges(P, n, dim), plain = plainMerges(vs);
    assert.equal(chain.length, n - 1);
    for (const k of [2, 3, 5, 8, 13, 21, 34]) assert.equal(partition(cutTree(n, chain, k)), partition(cutTree(n, plain, k)), `cut at ${k}`);
    assert.equal(new Set(cutTree(n, chain, 1)).size, 1);
    assert.equal(new Set(cutTree(n, chain, n)).size, n);
  });

  it('recovers three planted features as three sections, and their pairs as sub-sections', () => {
    const c = carveClusters(plantedVectors(), { sections: 3, sub: 6 });
    assert.equal(partitionOf(c.sections), PLANTED);
    assert.equal(c.top, 3);
    assert.equal(c.sub, 6);
    for (const g of c.sections) { const parts = c.subsOf(g); assert.equal(parts.flat().length, 4); assert.ok(parts.length >= 1); }
  });

  it('a mechanism with no vector is not placed and is not lost; a saved tree gives the same sections', () => {
    const vs = [...plantedVectors(), null];
    const c = carveClusters(vs, { sections: 3 });
    assert.deepEqual(c.placed, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal(partitionOf(c.sections), PLANTED);
    const again = carveClusters(vs, { sections: 3, merges: c.merges });
    assert.equal(partitionOf(again.sections), PLANTED);
    assert.deepEqual(carveClusters([null, null]).sections, []);
  });

  it('the default counts are 12 sections and 45 sub-sections on 363 mechanisms, and never fewer than 6 sections', () => {
    assert.equal(defaultSections(363), 12);
    assert.equal(defaultSubs(363), 45);
    assert.equal(defaultSections(20), 6);
    const c = carveClusters(plantedVectors());   // 12 mechanisms: 6 sections asked, 6 sub-sections at least
    assert.equal(c.top, 6);
    assert.equal(c.sub, 6);
  });

  it('a mechanism\'s vector weights its functions, and falls back to its label\'s vector', () => {
    const fnVecs = new Map([['a', [1, 0]], ['b', [0, 1]]]);
    const [both, labelOnly, none] = mechanismVectors({ fnIds: [['a', 'b'], ['zz'], ['zz']], fnVecs, weightOf: (id) => (id === 'a' ? 3 : 1), labelVecs: [null, [0, 2], null], dim: 2 });
    assert.ok(both[0] > both[1] * 2.9 && both[0] < both[1] * 3.1, 'the heavier function counts three times');
    assert.ok(Math.abs(Math.hypot(both[0], both[1]) - 1) < 1e-6, 'unit length');
    assert.deepEqual([...labelOnly], [0, 1]);
    assert.equal(none, null);
  });
});

describe('--carve calls: the call graph and its communities', () => {
  it('recovers three planted features from who calls whom; the mechanism nothing calls stands alone', () => {
    const { fnIds, fnById } = planted();
    const edges = callEdges(fnIds, fnById);
    const c = carveCalls(13, edges, { resolution: 1 });
    assert.equal(partitionOf(c.sections.filter((g) => g.length > 1)), PLANTED);
    assert.deepEqual(c.sections.filter((g) => g.length === 1), [[12]]);
    assert.equal(c.touched.has(12), false);
    assert.equal(c.touched.size, 12);
  });

  it('the same seed gives the same sections, and edges are between different mechanisms only', () => {
    const { fnIds, fnById } = planted();
    const edges = callEdges(fnIds, fnById);
    assert.ok(edges.every(([a, b, w]) => a < b && w > 0));
    const a = carveCalls(13, edges, { seed: 3 }), b = carveCalls(13, edges, { seed: 3 });
    assert.deepEqual(a.sections, b.sections);
    assert.equal(CALLS_SEED, 5);
  });

  it('leaves out a call to the function\'s own name, a name too many functions call, and a name defined in more than three files', () => {
    const f = (file, name, calls) => ({ id: `${file}@${name}`, file, name, calls });
    // own name: a method calling a same-named method elsewhere is not an edge
    let fns = [f('a.js', 'A::run', ['run']), f('b.js', 'B::run', [])];
    assert.deepEqual(callEdges(fns.map((x) => [x.id]), new Map(fns.map((x) => [x.id, x]))), []);
    // a name defined in four files is too ambiguous; in three it is matched, the weight shared
    const helpers = (k) => Array.from({ length: k }, (_, i) => f(`h${i}.js`, 'helper', []));
    fns = [f('a.js', 'caller', ['helper']), ...helpers(4)];
    assert.deepEqual(callEdges(fns.map((x) => [x.id]), new Map(fns.map((x) => [x.id, x]))), []);
    fns = [f('a.js', 'caller', ['helper']), ...helpers(3)];
    const e = callEdges(fns.map((x) => [x.id]), new Map(fns.map((x) => [x.id, x])));
    assert.equal(e.length, 3);
    assert.ok(e.every(([, , w]) => Math.abs(w - 1 / 3) < 1e-12));
    // plumbing: with 200 functions the limit is 4 callers; `log` called by 5 is dropped, `rare` by 2 kept
    fns = Array.from({ length: 200 }, (_, i) => f(`f${i}.js`, `fn${i}`, i < 5 ? ['log'] : i < 7 ? ['rare'] : []));
    fns.push(f('log.js', 'log', []), f('rare.js', 'rare', []));
    const edges = callEdges(fns.map((x) => [x.id]), new Map(fns.map((x) => [x.id, x])));
    assert.equal(edges.length, 2);
    assert.ok(edges.every(([, b]) => b === 201), 'both edges go to rare');
  });

  it('Louvain leaves a node with no edge alone and joins two triangles into two communities', () => {
    const edges = [[0, 1, 1], [1, 2, 1], [0, 2, 1], [3, 4, 1], [4, 5, 1], [3, 5, 1], [2, 3, 0.1]];
    assert.equal(partition(louvain(7, edges, 1, makeRng(1))), '0,1,2 | 3,4,5 | 6');
  });
});

describe('--carve: the listing', () => {
  it('heads a group by the words its labels share and the listing does not', () => {
    const labels = ['[file] ledger-post.js', '[file] ledger-close.js', '[cmd] --ledger', '[file] parser.js', '[file] parserTokens.js', '[file] other.js'];
    const h = headingMaker(labels);
    assert.equal(h([0, 1, 2]), 'ledger');
    assert.equal(h([3, 4]), 'parser');
    assert.equal(h([0, 5]), '(no shared word)');
    assert.deepEqual(labelWords('[file] claimChart.js / chart / other'), ['claim', 'chart', 'chart']);
  });

  it('numbers sections largest first, puts commands first, and ends every row with its section', () => {
    const { entries, fnIds, fnById } = planted();
    const c = carveCalls(13, callEdges(fnIds, fnById), { resolution: 1 });
    const { lines, sections, largest, alone } = carveListing(entries, c.sections, c.subsOf);
    assert.equal(sections, 3);
    assert.equal(largest, 4);
    assert.equal(alone, 1);
    assert.match(lines[0], /^1\. ledger   \(4 mechanisms\)$/);
    assert.match(lines[1], /^ {7}m1 {5}\[cmd\] --ledger \[1\]$/, 'the command leads its section');
    const rows = lines.filter((l) => /^ {7}m\d+/.test(l));
    assert.equal(rows.length, 13);
    assert.ok(rows.every((l) => /\[(\d+(\.\d+)?|alone)\]$/.test(l)), 'every row is tagged');
    const at = lines.indexOf('In a section of their own (1):');
    assert.ok(at > 0);
    assert.match(lines[at + 1], /^ {7}m13 {4}\[file\] lonely\.js \[alone\]$/);
  });

  it('sub-sections are numbered inside their section, with the single ones gathered last', () => {
    const rows = ['[file] aa-x.js', '[file] aa-y.js', '[file] aa-z.js', '[file] bb-x.js', '[file] bb-y.js', '[file] cc.js'].map((label, i) => ({ id: `m${i + 1}`, label }));
    const { lines } = carveListing(rows, [[0, 1, 2, 3, 4, 5]], () => [[0, 1, 2], [3, 4], [5]]);
    assert.deepEqual(lines.filter((l) => /^ {3}\d/.test(l)), ['   1.1 (no shared word)   (3)', '   1.2 (no shared word)   (2)', '   1.3 (others in this section)   (1)']);
    assert.ok(lines.includes('       m4     [file] bb-x.js [1.2]'));
    assert.ok(lines.includes('       m6     [file] cc.js [1.3]'));
  });

  it('--brief keeps the headings and drops the rows; --description and --purpose add their lines and say which is which', () => {
    const { entries, fnIds, fnById } = planted();
    const c = carveCalls(13, callEdges(fnIds, fnById), { resolution: 1 });
    const brief = carveListing(entries, c.sections, c.subsOf, { brief: true }).lines;
    assert.equal(brief.filter((l) => /^\d+\. /.test(l)).length, 3);
    assert.equal(brief.filter((l) => /\[\d+\]$/.test(l)).length, 0);
    const full = carveListing(entries, c.sections, c.subsOf, { description: true, purpose: true }).lines;
    const at = full.findIndex((l) => l.includes('m2 '));
    assert.equal(full[at + 1], `${' '.repeat(14)}Posts ledger entries.`);
    assert.equal(full[at + 2], `${' '.repeat(14)}purpose: does ledger work 1`);
    assert.equal(carveListing(entries, c.sections, c.subsOf).lines.some((l) => l.includes('purpose:')), false);
  });

  it('wraps long text under the row and cuts a purpose at its limit', () => {
    const w = wrapText('one two three four five six seven eight nine ten', '    ', 20);
    assert.ok(w.length > 1 && w.every((l) => l.startsWith('    ') && l.length <= 20));
    assert.equal(w.map((l) => l.trim()).join(' '), 'one two three four five six seven eight nine ten');
    const long = purposeText(`a  b\n${'x'.repeat(400)}`);
    assert.equal(long.length, PURPOSE_MAX + 2);
    assert.ok(long.endsWith(' …'));
    assert.equal(purposeText(' short\ntext '), 'short text');
  });
});

describe('--carve: the whole output', () => {
  it('calls: the header says what was done, what was left out and what came of it', () => {
    const { entries, fnIds, fnById } = planted();
    const text = renderCalls({ ndx: '.idx', entries, fnIds, fnById, tests: 2, numbers: { resolution: 1 }, description: true, purpose: true, notes: ['Not used: --sections belong to --carve clusters; x'] });
    const L = text.split('\n');
    assert.match(L[0], /^\.idx: 13 mechanisms carved by CALLS \(experimental: the groups are a suggestion and not a finding; they move when the index or the seed changes\)$/);
    assert.match(L[1], /^How: mechanisms that call each other go together\..*No embedding is read and no model is used\.$/);
    assert.match(L[2], /^Settings: resolution 1 .*seed 5 /);
    assert.match(L[3], /^1 of the 13 make or receive no call/);   // what was left out is the closing line (test-paths.js testsTip), printed by doCarve after the listing
    assert.match(L[4], /^Result: 3 sections of 2 or more, the largest 4; 1 mechanisms standing alone\./);
    assert.match(L[5], /^Descriptions: shown under 3 of the 13 mechanisms; a language model wrote them/);
    assert.match(L[6], /^Purpose: shown under 12 of the 13 mechanisms, on lines starting "purpose:"\..*no model.*cut at 240 characters\.$/);
    assert.match(L[7], /^Not used: --sections/);
    assert.equal(L[8], '');
    assert.match(L[9], /^1\. /);
    assert.match(text, /Standing alone \(no call that could be matched, or in no community\) \(1\):\n {7}m13 {4}\[file\] lonely\.js \[alone\]/);
    assert.match(renderCalls({ ndx: '.idx', entries, fnIds, fnById, includeTests: true }), /\nTest mechanisms are included \(--include-tests\)\. /);
    assert.match(renderCalls({ ndx: '.idx', entries: entries.map((e) => ({ ...e, description: null })), fnIds, fnById, description: true }), /\nDescriptions: none in this index\..*--purpose shows the text harvested with no model\./);
  });

  it('clusters: a mechanism with no embedded text is listed at the end as not placed, and the header counts it', () => {
    const { entries } = planted();
    const { text, merges } = renderClusters({ ndx: '.idx', entries, vectors: [...plantedVectors(), null], modelBase: 'some-model', tests: 0, numbers: { sections: 3, sub: 3 }, behind: 4 });
    const L = text.split('\n');
    assert.match(L[0], /^\.idx: 13 mechanisms carved by CLUSTERS \(experimental: .*they move when the index or its embeddings change\)$/);
    assert.match(L[1], /\(model some-model\).*No model is run\.$/);
    assert.match(L[2], /^Settings: 3 sections, 3 sub-sections \(--sections N, --sub N\)\. The same index and embeddings always give the same listing\.$/);
    assert.match(L[3], /1 of the 13 have no embedded text and are listed at the end, not placed\. 4 function texts are not embedded \(the index changed since --build-embeddings\)/);
    assert.match(L[4], /^Result: 3 sections of 2 or more, the largest 4; 0 mechanisms in a section of their own\./);
    assert.match(text, /\nNot placed: no embedded text \(1\):\n {7}m13 {4}\[file\] lonely\.js \[unplaced\]\n/);
    assert.equal(merges.length, 11);
    assert.equal(text.split('\n').filter((l) => /^ {7}m\d+/.test(l)).length, 13, 'every mechanism is on the page once');
  });

  it('the saved tree belongs to the vectors it was built from', () => {
    const a = plantedVectors(), b = plantedVectors();
    assert.equal(vectorsKey(a), vectorsKey(b));
    b[0] = unit([0, 0, 1, 0, 0, 0, 0, 0]);
    assert.notEqual(vectorsKey(a), vectorsKey(b));
    assert.notEqual(vectorsKey(a), vectorsKey([...a, null].slice(1)));
    assert.match(carveTreeFile('.idx', 'model-x'), /[\\/]embeddings[\\/]model-x_carve-tree\.json$/);
  });

  it('reads from a saved cache only the vectors it holds for these texts, and writes nothing', async () => {
    const dir = tmp('ce-carve-cache-');
    const file = path.join(dir, 'cache.json');
    const before = JSON.stringify({ items: { a: { h: sha('p:alpha'), v: [1, 0] }, b: { h: sha('p:OLD'), v: [0, 1] } } });
    fs.writeFileSync(file, before);
    const got = await cachedVectors(file, [{ key: 'a', text: 'alpha' }, { key: 'b', text: 'beta' }, { key: 'c', text: 'gamma' }], 'p:');
    assert.deepEqual([...got.keys()], ['a']);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal((await cachedVectors(path.join(dir, 'absent.json'), [{ key: 'a', text: 'alpha' }])).size, 0);
  });
});

describe('--carve clusters: the order it saves for --sort-by similarity', () => {
  it('keeps a cluster\'s members together and holds every placed mechanism once', () => {
    const vs = plantedVectors();
    // interleave the three features so that the input order is not the answer
    const mixed = [0, 4, 8, 1, 5, 9, 2, 6, 10, 3, 7, 11].map((i) => vs[i]);
    const feature = (i) => i % 3;   // position in `mixed` -> planted feature
    const c = carveClusters([...mixed, null], { sections: 3 });
    assert.equal(c.order.length, 12);
    assert.deepEqual([...c.order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'each placed mechanism once, the one with no vector not at all');
    const runs = c.order.map(feature).filter((f, i, a) => i === 0 || f !== a[i - 1]);
    assert.equal(runs.length, 3, `three runs, one per feature: ${c.order.map(feature).join('')}`);
    assert.deepEqual(carveClusters([null]).order, []);
  });

  it('lays two clusters end to end with the closer ends meeting', () => {
    // four points on a line of angles: 0, 10, 50 and 60 degrees. The tree joins (0,10) and (50,60);
    // read down, 10 must sit beside 50.
    const at = (deg) => unit([Math.cos(deg * Math.PI / 180), Math.sin(deg * Math.PI / 180)]);
    const pts = [at(10), at(60), at(0), at(50)];   // given out of order
    const P = new Float32Array(8); pts.forEach((v, i) => P.set(v, i * 2));
    const order = leafOrder(4, wardMerges(P, 4, 2), P, 2);
    const degs = order.map((i) => [10, 60, 0, 50][i]).join(',');
    assert.ok(degs === '0,10,50,60' || degs === '60,50,10,0', degs);
  });

  it('a listing reads the newest saved order, knows a stale one, and counts the rows it does not hold', () => {
    const dir = tmp('ce-carve-order-');
    assert.equal(readCarveOrder(dir, 'g1', fs, path), null, 'no embeddings folder');
    fs.mkdirSync(path.join(dir, 'embeddings'));
    const write = (name, t) => fs.writeFileSync(path.join(dir, 'embeddings', name), JSON.stringify(t));
    write('old_carve-tree.json', { format: 'ce-carve-tree', generated: '2026-01-01', model: 'old', mechanisms: 'g1', order: ['m9'], merges: [] });
    write('new_carve-tree.json', { format: 'ce-carve-tree', generated: '2026-02-01', model: 'new', mechanisms: 'g1', order: ['m3', 'm1'], merges: [] });
    write('v1_carve-tree.json', { format: 'ce-carve-tree', generated: '2026-03-01', model: 'v1', merges: [] });   // before the order was saved: not an order
    write('other_label+members.json', { items: {} });
    assert.deepEqual(readCarveOrder(dir, 'g1', fs, path), { ids: ['m3', 'm1'], model: 'new', generated: '2026-02-01', stale: false });
    assert.equal(readCarveOrder(dir, 'g2', fs, path).stale, true);
    const rows = [{ id: 'm1' }, { id: 'm2' }, { id: 'm7', aliases: [{ id: 'm3' }] }];
    assert.deepEqual(similarityOrderFor(dir, 'g1', rows, fs, path), { similarIds: ['m3', 'm1'], similar: { model: 'new', stale: false, unplaced: 1 } });
  });
});

describe('--carve: the command line', () => {
  const indexWith = (records) => {
    const dir = tmp('ce-carve-cli-');
    if (records) fs.writeFileSync(path.join(dir, 'mechanisms.json'), JSON.stringify({ format: MECHANISMS_FORMAT, version: 1, records }));
    return dir;
  };
  const one = [{ id: 'm1', label: '[file] a.js', kind: 'file', members: [{ file: 'a.js', name: 'f', start: 1, end: 9 }] }];

  it('bare --carve explains the two techniques and picks neither, exit 0', () => {
    const r = run('--ndx', '.idx', '--carve');
    assert.equal(r.status, 0);
    const first = r.stdout.split(/\r?\n/)[0];
    assert.match(first, /^--carve carves an indexed codebase along its joints: it divides the codebase's mechanisms \(the rows --toc and --mechanisms list\) into numbered sections and sub-sections/, 'the first line says what carving is');
    assert.match(first, /It takes the technique, clusters or calls:$/);
    assert.match(r.stdout, /--index-path \.idx --carve clusters /);
    assert.match(r.stdout, /--index-path \.idx --carve calls /);
    assert.equal(carveUsage('ce', '.idx').length, 5);
  });

  it('a technique it does not know, or a number out of range, is refused by name, exit 2', () => {
    const a = run('--ndx', '.idx', '--carve', 'kmeans');
    assert.equal(a.status, 2);
    assert.match(a.stderr, /^--carve takes clusters or calls, not "kmeans"\./);
    assert.equal(a.stdout, '');
    const b = run('--ndx', indexWith(one), '--carve', 'clusters', '--sections', '0');
    assert.equal(b.status, 2);
    assert.match(b.stderr, /--carve: --sections takes a whole number, 1 or more/);
  });

  it('an index with no mechanisms names --build-mechanisms, exit 2', () => {
    const dir = indexWith(null);
    for (const how of ['clusters', 'calls']) {
      const r = run('--ndx', dir, '--carve', how);
      assert.equal(r.status, 2, how);
      assert.match(r.stderr, /has no mechanisms\.json, the groups of functions --carve arranges\.[^]*--build-mechanisms/);
      assert.equal(r.stdout, '');
    }
  });

  it('clusters with no embeddings gives the build command and nothing else, and says calls needs none', () => {
    const r = run('--ndx', indexWith(one), '--carve', 'clusters');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^--carve clusters: .* has no embeddings yet\. Build them \(once per index\), then run this again:\n {2}\S.* --index-path \S+ --build-embeddings\n--carve calls needs no embeddings\.$/m);
    assert.equal(r.stdout, '');
  });

  it('calls runs with no embeddings in the index', () => {
    const r = run('--ndx', indexWith(one), '--carve', 'calls');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /: 1 mechanisms carved by CALLS /);
    assert.match(r.stdout, /m1 {5}\[file\] a\.js \[alone\]/);
  });
});

// issue-364-concepts-where (2026-11-24): where a set of mechanisms sits in a carved listing.
import { numberSections, sectionUnits, placeInSections, PLACE_DRAWS, PLACE_LEVEL } from '../src/core/carve.js';

describe('--carve: where rows sit (for --concepts)', () => {
  // three sections: 0-7 (two sub-sections of four), 8-11, 12-13; 14 and 15 alone
  const sections = [[0, 1, 2, 3, 4, 5, 6, 7], [8, 9, 10, 11], [12, 13], [14], [15]];
  const subsOf = (g) => (g.length === 8 ? [[0, 1, 2, 3], [4, 5, 6], [7]] : null);
  const rows = Array.from({ length: 16 }, (_, i) => ({ id: `m${i + 1}`, label: `[file] f${i}.js` }));
  const population = rows.map((_, i) => i);

  it('gives every row the tag the listing prints after it', () => {
    const { tagOf } = sectionUnits(sections, subsOf);
    const printed = new Map();
    for (const l of carveListing(rows, sections, subsOf).lines) { const m = /^\s+(m\d+)\s+.* \[([^\]]+)\]$/.exec(l); if (m) printed.set(Number(m[1].slice(1)) - 1, m[2]); }
    assert.equal(printed.size, 16);
    assert.deepEqual([...tagOf].sort((a, b) => a[0] - b[0]), [...printed].sort((a, b) => a[0] - b[0]));
    assert.equal(tagOf.get(0), '1.1');
    assert.equal(tagOf.get(7), '1.3', 'a row left single in its section is in the last sub-section');
    assert.equal(tagOf.get(8), '2');
    assert.equal(tagOf.get(14), 'alone');
    assert.equal(sectionUnits(sections, subsOf, [15]).tagOf.get(15), 'unplaced');
  });

  it('the units are the numbered sections, whole, and their sub-sections', () => {
    const { units } = sectionUnits(sections, subsOf);
    assert.deepEqual([...units.keys()].sort(), ['1', '1.1', '1.2', '1.3', '2', '3']);
    assert.deepEqual([...units.get('1')].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(numberSections(sections, subsOf).lone, [14, 15]);
  });

  const place = (members) => placeInSections(members, { ...sectionUnits(sections, subsOf), population, rnd: makeRng(CALLS_SEED) });

  it('rows confined to one sub-section have it as their home, held and pure at 100%', () => {
    const p = place([0, 1, 2, 3]);
    assert.deepEqual([p.unit, p.inUnit, p.size, p.held, p.pure, p.home], ['1.1', 4, 4, 1, 1, true]);
    assert.deepEqual(p.elsewhere, []);
  });

  it('rows mostly in one section have it as home, and the rest are counted where they are', () => {
    const p = place([8, 9, 10, 11, 0, 14]);
    assert.equal(p.unit, '2');
    assert.equal(p.inUnit, 4);
    assert.equal(p.held, 4 / 6);
    assert.equal(p.pure, 1);
    assert.equal(p.home, true);
    assert.deepEqual(p.elsewhere, [['1.1', 1], ['alone', 1]]);
    // three of five in a section of four is no better than a lucky draw from sixteen rows:
    // on a small listing chance does well, and the test says so
    assert.equal(place([8, 9, 10, 0, 14]).home, false);
  });

  it('a home that is a whole section does not count its own sub-sections as elsewhere', () => {
    const p = place([0, 1, 2, 4, 5, 6, 7]);
    assert.equal(p.unit, '1');
    assert.deepEqual(p.elsewhere, []);
  });

  it('rows spread one to a section have no home: chance does as well', () => {
    const p = place([0, 8, 12, 14]);
    assert.equal(p.home, false);
    assert.ok(p.unit, 'the best unit is still named, for the sentence that says it is no better than chance');
  });

  it('one row is where it is; a row standing alone has no unit; no rows, nothing', () => {
    assert.deepEqual([place([9]).unit, place([9]).home, place([9]).n], ['2', true, 1]);
    const alone = place([14]);
    assert.deepEqual([alone.unit, alone.home, alone.elsewhere], [null, false, [['alone', 1]]]);
    assert.equal(place([]), null);
  });

  it('the same listing gives the same answer; a home is a unit that at most one random pick in twenty matches, of two hundred', () => {
    assert.deepEqual(place([8, 9, 0, 12, 14]), place([8, 9, 0, 12, 14]));
    assert.equal(PLACE_DRAWS, 200);
    assert.equal(PLACE_LEVEL, 0.05);
    // the level is the bar: with every pick allowed to match, anything with a unit is a home
    const lax = placeInSections([0, 8, 12, 14], { ...sectionUnits(sections, subsOf), population, rnd: makeRng(CALLS_SEED), level: 1 });
    assert.equal(lax.home, true);
  });

  it('a home that is a sub-section says how many its whole section holds', () => {
    const p = place([0, 1, 2, 3, 4]);
    assert.equal(p.unit, '1.1');
    assert.deepEqual(p.section, { tag: '1', inUnit: 5, size: 8 });
    assert.deepEqual(p.elsewhere, [['1.2', 1]]);
    assert.equal(place([8, 9, 10, 11]).section, null, 'a home that is a whole section has no parent');
  });
});
