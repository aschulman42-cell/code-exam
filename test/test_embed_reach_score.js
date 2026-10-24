// issue-322-codebert-reach-test: the scorer's arithmetic and bookkeeping, with
// no model and no vectors from disk beyond a tiny .npy the test writes itself.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readNpy, row, scoresFor, rankOf, bestRank, hitsAt, median, controlPairing, bareOf, citedRows,
  bestRankForName, summarize, rollup, parseElementWords, renderReach, spliceBetweenMarkers, BEGIN, END,
} from '../scripts/embed-reach-score.mjs';

// The renderer's number format, exercised through a one-row render.
const fmtForTest = (x) => {
  const body = renderReach({ generatedAt: 't', device: 'cpu', models: ['m'], reprs: ['name'], filings: [],
    pooled: { names: 1, methods: { 'm:name': { names: 1, hits25: 0, hits60: 0, median: x } } }, runtimes: [], missing: [] });
  return /\| m \| name \| 1 \| 0 \| 0 \| (.*?) \|/.exec(body)[1];
};

function writeNpy(file, rows) {
  const d = rows[0].length;
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows.length}, ${d}), }`;
  const pad = 64 - ((10 + header.length + 1) % 64);
  const h = `${header}${' '.repeat(pad)}\n`;
  const buf = Buffer.alloc(10 + h.length + rows.length * d * 4);
  buf.write('\x93NUMPY', 0, 'latin1'); buf[6] = 1; buf[7] = 0; buf.writeUInt16LE(h.length, 8);
  buf.write(h, 10, 'latin1');
  let o = 10 + h.length;
  for (const r of rows) for (const v of r) { buf.writeFloatLE(v, o); o += 4; }
  fs.writeFileSync(file, buf);
}

describe('embed-reach scorer', () => {
  it('reads the .npy the embedder writes (float32, C order)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-npy-'));
    try {
      const f = path.join(dir, 'v.npy');
      writeNpy(f, [[1, 0, 0], [0, 1, 0]]);
      const m = readNpy(f);
      assert.deepEqual(m.shape, [2, 3]);
      assert.deepEqual([...row(m, 1)], [0, 1, 0]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('ranks by cosine with ties counted as worse, best rank across elements, hits within k', () => {
    const symbols = { shape: [4, 2], data: new Float32Array([1, 0, 0, 1, 0.6, 0.8, 1, 0]) };
    const s = scoresFor(new Float32Array([1, 0]), symbols);
    assert.equal(rankOf(s, 0), 1, 'a tie with row 3 does not demote row 0 below rank 1');
    assert.equal(rankOf(s, 2), 3);
    assert.equal(rankOf(s, 1), 4);
    assert.equal(bestRank([7, 3, 9]), 3);
    assert.equal(bestRank([]), Infinity);
    assert.equal(hitsAt([1, 25, 26, 60, 61], 25), 2);
    assert.equal(hitsAt([1, 25, 26, 60, 61], 60), 4);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([Infinity]), Infinity, 'a name never ranked sorts last');
    assert.equal(median([3, Infinity, Infinity]), Infinity, 'reaching fewer than half the names is an infinite median');
    assert.equal(median([3, 9, Infinity]), 9, 'reaching more than half gives a finite one');
    assert.deepEqual(summarize([4, 4, Infinity]), { names: 3, hits25: 2, hits60: 2, median: 4 });
  });

  it('the shuffled control pairs every filing with another, never itself', () => {
    const p = controlPairing(['a', 'b', 'c']);
    assert.deepEqual([...p.entries()], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
    assert.equal(controlPairing(['only']).size, 0);
  });

  it('a cited bare name finds every symbol row that carries it, qualified or not', () => {
    const keys = ['a.c@foo', 'b.cpp@Klass::foo', 'c.c@foobar', 'd.c@Other::bar'];
    assert.deepEqual(citedRows(keys, 'foo'), [0, 1]);
    assert.deepEqual(citedRows(keys, 'bar'), [3]);
    assert.equal(bareOf('x/y.java@Outer::Inner::m'), 'm');
    const scoreRows = [new Float32Array([0.1, 0.9, 0.5, 0.2]), new Float32Array([0.95, 0.1, 0.2, 0.3])];
    assert.equal(bestRankForName(scoreRows, [0, 1]), 1, 'best over its rows and over the elements');
  });

  it('summarizes and pools rank lists', () => {
    assert.deepEqual(summarize([1, 30, 70]), { names: 3, hits25: 1, hits60: 2, median: 30 });
    assert.deepEqual(rollup([{ ranks: [1, 30] }, { ranks: [70] }]), { names: 3, hits25: 1, hits60: 2, median: 30 });
  });

  it('reads the tier-1 log\'s predicted words per element', () => {
    const log = 'x\n  element 1: words [generate, key] -> 25 candidate(s)\n  element 2: words [hash, seed, output] -> 3 candidate(s)\n';
    const w = parseElementWords(log);
    assert.deepEqual(w.get(1), ['generate', 'key']);
    assert.deepEqual(w.get(2), ['hash', 'seed', 'output']);
  });

  it('renders the tables and splices between the page markers', () => {
    const results = {
      generatedAt: '2026-10-24T00:00:00Z', device: 'cpu', models: ['codebert'], reprs: ['name'],
      filings: [{ id: 'f', repo: 'o/r', index: 'o__r__abc', names: 2, methods: { 'codebert:name': summarize([3, 40]), codeexam: summarize([1, 100]) } }],
      pooled: { names: 2, methods: { 'codebert:name': summarize([3, 40]), codeexam: summarize([1, 100]), 'control:codebert:name': summarize([500, 900]) } },
      runtimes: [{ index: 'o__r__abc', symbols: 950, device: 'cpu', model: 'codebert', repr: 'name', seconds: 12.3 }],
      missing: ['g o/s'],
    };
    results.pooled.methods.unreached = summarize([2, Infinity, Infinity]);
    results.pooled.methods['control:codeexam'] = summarize([Infinity, 40]);
    const body = renderReach(results);
    assert.match(body, /\| shuffled control \(CodeExam name search\) \| another claim's predicted words \| 2 \| 0 \| 1 \| beyond the list \|/);
    assert.match(body, /\| codebert \| name \| 2 \| 1 \| 2 \| 21\.5 \|/);
    assert.match(body, /\| CodeExam name search \| predicted words \| 2 \| 1 \| 1 \| 50\.5 \|/);
    assert.match(body, /\| o__r__abc \| 950 \| cpu \| codebert \| name \| 12\.3 \|/);
    assert.equal(fmtForTest(Infinity), 'beyond the list');
    assert.match(body, /shuffled control \(codebert, name\)/);
    assert.match(body, /\| f \| o\/r \| 2 \| 1 \/ 2 \/ 21\.5 \| 1 \/ 1 \/ 50\.5 \|/);
    assert.match(body, /Not yet embedded \(1\): g o\/s/);
    const page = `top\n${BEGIN}\nold\n${END}\nbottom`;
    const out = spliceBetweenMarkers(page, body);
    assert.ok(out.startsWith('top\n') && out.endsWith('\nbottom'));
    assert.ok(!out.includes('\nold\n'));
    assert.throws(() => spliceBetweenMarkers('no markers', body), /markers not found/);
  });
});
