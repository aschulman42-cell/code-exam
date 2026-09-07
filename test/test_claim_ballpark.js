// test_claim_ballpark.js — claim-ballpark script: distinctive-term selection, row reduction, ranking
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// claim-ballpark: claim -> distinctive terms -> one multisect per index -> one row per (claim, index).
//
// The pure parts are tested here without loading an index: term selection (the part that decides
// whether the screen asks a sensible question), the row reduction from a multisectSearch result
// (the part that decides the ranking), and the two claim readers. Specimens are real litigated
// claim text (US 9,195,258 and US 5,946,647), because the stoplist and the stemmer were tuned on
// real claims and an invented specimen would prove only what its author imagined.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDf, claimTerms, reduceResult, rankRows, readClaims, stem, isHit } from '../scripts/claim-ballpark.mjs';
import * as core from '../src/core/claim-terms.js';

// claim-chart-element-classes (2026-08-28): the term code moved to src/core/claim-terms.js and the
// script re-exports it, so every measurement above this line is unchanged by construction.
describe('claim-ballpark term code is src/core/claim-terms.js', () => {
  it('re-exports, not copies', () => {
    assert.equal(stem, core.stem);
    assert.equal(buildDf, core.buildDf);
    assert.equal(claimTerms, core.claimTerms);
  });
});

const SONOS = 'In a system comprising a plurality of controllers that are communicatively coupled via at least a local area network (LAN) with a plurality of zone players including a first zone player and a second zone player, a method comprising: receiving, at the first zone player, control information from any one of the plurality of controllers via the LAN, wherein the received control information comprises a direction that instructs the first zone player to enter into a synchrony group with at least the second zone player; in response to the direction, the first zone player entering into the synchrony group with the second zone player, wherein in the synchrony group, the first and second zone players are configured to play back audio in synchrony; transmitting, by the first zone player to at least one of the plurality of controllers via the LAN, status information.';
const APPLE = 'A computer-based system for detecting structures in data and performing actions on detected structures, comprising: an input device for receiving data; an output device for presenting the data; a memory storing information including program routines including an analyzer server for detecting structures in the data, and for linking actions to the detected structures; a user interface enabling the selection of a detected structure and a linked action; an action processor for performing the selected action linked to the selected structure; and a processing unit coupled to the input device, the output device, and the memory for controlling the execution of the program routines.';
const FILLER = [
  'A method comprising: receiving data at a device; processing the data by a processor; and transmitting a result to a user.',
  'A system comprising a memory and a processor configured to store information and display a value to a user.',
  'A computer-readable medium storing instructions that, when executed, cause a processor to perform a method of processing data.',
];

describe('claim-ballpark term selection', () => {
  const bg = buildDf([SONOS, APPLE, ...FILLER]);

  it('picks the claim\'s own vocabulary, not claim boilerplate', () => {
    const t = claimTerms(SONOS, bg, 8);
    assert.ok(t.includes('zone'), `expected zone in ${t}`);
    assert.ok(t.includes('synchrony'), `expected synchrony in ${t}`);
    for (const w of ['method', 'comprising', 'plurality', 'first', 'second', 'information', 'wherein', 'least']) {
      assert.ok(!t.includes(w), `boilerplate ${w} leaked into ${t}`);
    }
  });

  it('spends one slot per stem', () => {
    const t = claimTerms(APPLE, bg, 8);
    const stems = t.map(stem);
    assert.equal(new Set(stems).size, stems.length, `duplicate stems in ${t}`);
    // structures / structure / detected / detecting all collapse; at most one of each family survives
    assert.ok(t.filter((w) => w.startsWith('structur')).length <= 1, t);
    assert.ok(t.filter((w) => w.startsWith('detect')).length <= 1, t);
  });

  it('keeps capitalised 3-letter acronyms and drops tense/function words', () => {
    const DMA = 'A method for controlling a DMA controller through a linear descriptor list, comprising: reading a descriptor pointed to by a pointer; starting a transfer whose parameters were written in the descriptor; and, when the descriptor was the last, stopping the DMA controller. The LAN interface is not involved.';
    const t = claimTerms(DMA, buildDf([DMA, SONOS, APPLE, ...FILLER]), 8);
    assert.ok(t.includes('dma'), `expected dma in ${t}`);
    // `LAN` occurs once here and also in the Sonos background claim, so against that background it
    // loses the race on IDF to every word unique to the specimen. Against a background without Sonos it
    // ties on IDF and the shorter-first tie-break keeps it: the rule under test is that it is a candidate.
    assert.ok(claimTerms(DMA, buildDf([DMA, APPLE, ...FILLER]), 8).includes('lan'));
    for (const w of ['were', 'was', 'the', 'and', 'for']) assert.ok(!t.includes(w), `${w} leaked into ${t}`);
    // lower-case 3-letter words are not acronyms
    const t2 = claimTerms('a method using the dma and the bus and a fan', buildDf([SONOS, APPLE]), 8);
    assert.ok(!t2.includes('dma') && !t2.includes('bus') && !t2.includes('fan'), t2);
  });

  it('returns at most n terms and never fewer than the claim can supply', () => {
    assert.equal(claimTerms(SONOS, bg, 4).length, 4);
    assert.ok(claimTerms(FILLER[0], bg, 8).length <= 8);
  });

  it('ranks rarer words above common ones at equal in-claim frequency', () => {
    // `synchrony` appears in one background claim; `data` is stopped outright, `audio` appears once too --
    // the check is that a word present in EVERY background claim ranks below one present in one.
    const bg2 = buildDf([SONOS, APPLE, ...FILLER, 'zone zone zone']);
    const t = claimTerms('zone synchrony', bg2, 2);
    assert.equal(t[0], 'synchrony', t);
  });
});

describe('claim-ballpark row reduction', () => {
  const res = {
    terms: Array.from({ length: 8 }, (_, i) => ({ display: `t${i}` })),
    term_file_counts: [11, 0, 838, 357, 231, 819, 80, 0],
    function_matches: [
      { function: 'checkNotNull', filepath: 'a.java', matched_indices: new Set([0, 2, 3, 5]) },
      { function: 'CompositionPlayer@616', filepath: 'a.java', matched_indices: new Set([2, 3, 5, 6, 0, 4, 1]) },
      { function: '(global)', filepath: 'b.java', matched_indices: new Set([0, 1, 2, 3, 4, 5, 6, 7]) },
    ],
    file_matches: [
      { filepath: 'a.java', matched_indices: new Set([0, 2, 3, 4, 5]) },
      { filepath: 'c.java', matched_indices: new Set([2, 5]) },
      { filepath: 'd.java', matched_indices: new Set([5]) },
    ],
  };
  // ExoPlayer3-sized index: 3578 files. idf = ln(files / files-with-term); a term in 0 files scores 0.
  // t0 11 -> 5.78, t2 838 -> 1.45, t3 357 -> 2.30, t4 231 -> 2.74, t5 819 -> 1.47, t6 80 -> 3.80.

  it('counts present terms, rare terms, real functions, best k, and density', () => {
    const r = reduceResult(res, 65370, 3578);
    assert.equal(r.termsTotal, 8);
    assert.equal(r.termsPresent, 6);
    assert.equal(r.rareTerms, 2, 'under 5% of files: t0 (11) and t6 (80)');
    assert.equal(r.functions, 2, '(global) is not a function');
    assert.equal(r.bestK, 7, 'best k ignores the (global) pseudo-match');
    assert.equal(r.files, 3);
    assert.equal(r.per10k, +(2 / 65370 * 1e4).toFixed(2));
  });

  it('weights the best match by term rarity, at function and file level', () => {
    const r = reduceResult(res, 65370, 3578);
    // CompositionPlayer@616: t0+t1+t2+t3+t4+t5+t6 with t1 absent -> 5.78+1.45+2.30+2.74+1.47+3.80
    assert.equal(r.bestScore.toFixed(1), '17.6');
    // a.java: t0,t2,t3,t4,t5 -> 5.78+1.45+2.30+2.74+1.47
    assert.equal(r.fileBestK, 5);
    assert.equal(r.fileBestScore.toFixed(1), '13.8');
  });

  it('excludes oversized and prose matches from the neighbourhood, and counts them', () => {
    const big = {
      ...res,
      function_matches: [
        ...res.function_matches,
        { function: 'minified', filepath: 'bundle.js', lines: 40000, matched_indices: new Set([0, 1, 2, 3, 4, 5, 6, 7]) },
      ],
      file_matches: [
        ...res.file_matches,
        { filepath: 'RELEASENOTES.md', lines: 4556, matched_indices: new Set([0, 1, 2, 3, 4, 5, 6]) },
        { filepath: 'bundle.js', lines: 40000, matched_indices: new Set([0, 1, 2, 3, 4, 5, 6, 7]) },
      ],
    };
    const r = reduceResult(big, 65370, 3578);
    assert.equal(r.bestK, 7, 'the 40k-line minified function is not a neighbourhood');
    assert.equal(r.fileBestK, 5, 'neither the release notes nor the bundle');
    assert.deepEqual([r.oversizedFunctions, r.oversizedFiles, r.proseFiles], [1, 1, 1]);
    const loose = reduceResult(big, 65370, 3578, { maxFileLines: 1e9, maxFunctionLines: 1e9, codeOnly: false });
    assert.equal(loose.fileBestK, 8, 'bounds off: the bundle wins');
    assert.equal(loose.bestK, 8);
  });

  it('does not count a binstrings .op pseudo-function as a function, and says so', () => {
    // op-pseudo-source-kind-gate: on .langchain, 30 of 39 "strong" claims had a bin_pycache_* bag
    // as their best function (2026-08-27). The dump stays at FILE level (a real binary's dump is a
    // legitimate neighbourhood) but never sets function-level k.
    const withOp = {
      ...res,
      function_matches: [
        ...res.function_matches,
        { function: 'bin_pycache_x', filepath: 'pkg/__pycache__/x.cpython-310.pyc.op', lines: 120, matched_indices: new Set([0, 1, 2, 3, 4, 5, 6, 7]) },
      ],
      file_matches: [
        ...res.file_matches,
        { filepath: 'pkg/__pycache__/x.cpython-310.pyc.op', lines: 120, matched_indices: new Set([0, 1, 2, 3, 4, 5, 6, 7]) },
      ],
    };
    const r = reduceResult(withOp, 65370, 3578);
    assert.equal(r.bestK, 7, 'the bag does not set function-level k');
    assert.equal(r.functions, 2, 'nor count as a function');
    assert.equal(r.opFunctions, 1, 'but it is counted as what it is');
    assert.equal(r.fileBestK, 8, 'file level keeps it');
  });

  it('flags a live hit on file k >= N or function k >= N-1', () => {
    assert.ok(isHit({ fileBestK: 6, bestK: 2 }));
    assert.ok(isHit({ fileBestK: 3, bestK: 5 }));
    assert.ok(!isHit({ fileBestK: 5, bestK: 4 }));
    assert.ok(isHit({ fileBestK: 5, bestK: 4 }, 5), 'threshold is configurable');
  });

  it('survives an empty result', () => {
    const r = reduceResult({ terms: [], term_file_counts: [], function_matches: [], file_matches: [] }, 0, 0);
    assert.deepEqual([r.termsPresent, r.rareTerms, r.functions, r.bestK, r.bestScore, r.fileBestK, r.fileBestScore, r.per10k], [0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('ranks by file-level k, then density, then rarity scores -- domain breadth before specificity', () => {
    const rows = [
      { index: 'small-dense', fileBestScore: 12, bestScore: 8, fileBestK: 5, bestK: 4, per10k: 9.0, functions: 9 },
      { index: 'big-sparse', fileBestScore: 12, bestScore: 8, fileBestK: 5, bestK: 4, per10k: 1.0, functions: 100 },
      { index: 'one-file', fileBestScore: 20, bestScore: 9, fileBestK: 7, bestK: 4, per10k: 0.5, functions: 3 },
      // the media library for a media claim: shared vocabulary scores low on IDF, but a 7-of-8 file
      // (bounded, non-prose) and 300 qualifying functions is the ballpark by any reading
      { index: 'domain-dense', fileBestScore: 6, bestScore: 6, fileBestK: 7, bestK: 7, per10k: 30, functions: 300 },
      { index: 'nothing', fileBestScore: 0, bestScore: 0, fileBestK: 0, bestK: 0, per10k: 0, functions: 0 },
    ];
    assert.deepEqual(rankRows(rows).map((r) => r.index), ['domain-dense', 'one-file', 'small-dense', 'big-sparse', 'nothing']);
  });
});

describe('claim-ballpark readers', () => {
  it('reads a --claims-only file, skipping # header lines, and a fetcher JSONL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballpark-'));
    const txt = path.join(dir, 'c.txt');
    fs.writeFileSync(txt, `# Pseudo-claims -- header\n# Claims: 2\n${SONOS}\n\n${APPLE}\n`);
    const a = readClaims(txt);
    assert.equal(a.length, 2);
    assert.deepEqual(a.map((c) => c.id), ['claim-1', 'claim-2']);
    assert.equal(a[0].text, SONOS);
    const jsonl = path.join(dir, 'c.jsonl');
    fs.writeFileSync(jsonl, [
      JSON.stringify({ patent: '9195258', title: 'Sync', claim1: { text: SONOS, lines: [] } }),
      JSON.stringify({ patent: '0000000', title: 'no claim 1', claim1: null }),
    ].join('\n') + '\n');
    const b = readClaims(jsonl);
    assert.equal(b.length, 1, 'a record without claim 1 is skipped');
    assert.equal(b[0].id, '9195258');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
