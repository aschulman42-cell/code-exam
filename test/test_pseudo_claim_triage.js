// pseudo-claim-triage: the deterministic first cut over a run's pseudo-claims.
//
// WHY THESE TESTS. Each fixture claim is built to trip exactly one signal --
// a bookend-only shape, no grounded anchor, a near-duplicate sibling, an echo
// of a bigger group over the same file, a dependent set that restates claim 1
// -- so a verdict can be traced to its reason and the reason to its rule.
// The thresholds themselves are pinned from the population (see the module
// header), NOT from these fixtures; a fixture is a demonstration that a rule
// fires, not a calibration point.
//
// The eyeball-picks fixture (test/fixtures/pseudo-claim-picks.json) is EMPTY
// by design: the picks are read off blind after the cut exists, and the last
// describe below is the harness that will hold them.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRIAGE_THRESHOLDS, claimStems, jaccard, dependentBody, dependentSignal,
  triageClaims, formatTriage, keepSidecar, formatKeepFile,
} from '../src/core/pseudo-claim-triage.js';
import { shapeReport } from '../src/commands/pseudo-claims.js';
import { detectClaims } from '../src/commands/synonymize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const shape = (claim, deps) => shapeReport(claim, deps, 'litigated');

const anchor = (file, func) => ({ file, func, start: 1, end: 20, kind: 'func', element: '' });

// A seven-claim run. Numbers are the sidecar's `n`; labels are group labels.
function fixture() {
  return {
    format: 'ce-pseudo-claim-anchors', version: 1, note: 'fixture', claims: [
      {
        n: 1, label: 'shard (partitionShards)',
        claim: 'A method for indexing a corpus of source files, comprising: partitioning the corpus into overlapping shards according to a hash of each identifier; assigning each shard a rarity weight derived from cross-corpus document frequency; ranking the shards by the rarity weight; merging the ranked shards by interleaving members whose weights fall within a tolerance; and emitting the merged shards as an anchor list.',
        grounded: [anchor('src/shard.js', 'partitionShards'), anchor('src/shard.js', 'rarityWeight'), anchor('src/shard.js', 'mergeShards')], dropped: [],
      },
      {
        n: 2, label: '[cmd] --serve',
        claim: 'A method comprising: receiving a request from a client; storing the request in a memory; transmitting a response to the client; and displaying the response on a display.',
        grounded: [anchor('src/api.js', 'handleRequest'), anchor('src/api.js', 'respond')], dropped: [],
      },
      {
        n: 3, label: 'planner (buildPlan)',
        claim: 'A method for planning an examination, comprising: enumerating the entry points of a program; ordering the entry points by fan-out; allocating an inspection budget to each entry point in proportion to its fan-out; and pruning entry points whose budget falls below a floor.',
        grounded: [], dropped: [{ file: 'src/plan.js', func: 'buildPlan', reason: 'not in index' }],
      },
      {
        n: 4, label: 'graph (layoutGraph)',
        claim: 'A method for rendering a call graph, comprising: traversing the graph from a root node depth-first; collapsing cycles into a single node labelled with the cycle members; laying out the collapsed graph in ranked layers by longest path; and colouring each node by its module.',
        grounded: [anchor('src/graph.js', 'layoutGraph'), anchor('src/graph.js', 'collapseCycles')], dropped: [],
      },
      {
        n: 5, label: '[file] graph.js',
        claim: 'A method for rendering a call graph, comprising: traversing the graph from an entry node depth-first; collapsing cycles into a single node labelled with the cycle members; laying out the collapsed graph in ranked layers by longest path; and shading each node by its module.',
        grounded: [anchor('src/graph.js', 'layoutGraph'), anchor('src/graph.js', 'shadeNodes')], dropped: [],
      },
      {
        n: 6, label: 'verify (verifyAnchors)',
        claim: 'A method for validating an anchor list, comprising: resolving each anchor against the function index; rejecting anchors whose line span exceeds the function body; and recording each rejected anchor with the reason.',
        grounded: [anchor('src/shard.js', 'verifyAnchors')], dropped: [],
      },
      {
        n: 7, label: 'renames (detectRenames)',
        claim: 'A method for detecting renamed functions, comprising: hashing the normalized body of each function; pairing functions whose hashes collide across two indexes; scoring each pair by the edit distance of their call sequences; and reporting pairs above a threshold as renames.',
        grounded: [anchor('src/rename.js', 'detectRenames'), anchor('src/rename.js', 'pairByHash')], dropped: [],
        dependents: [
          { n: 2, text: 'The method of claim 1, wherein the hashes are the hashes of the normalized body.' },
          { n: 3, text: 'The method of claim 1, wherein the pairs are the pairs whose hashes collide.' },
          { n: 4, text: 'The method of claim 1, wherein the threshold is a threshold.' },
        ],
      },
    ],
  };
}

const byN = (result, n) => result.claims.find((c) => c.n === n);

describe('triage: the primitives', () => {
  it('stems are content words, stemmed; jaccard is symmetric and 0-1', () => {
    const a = claimStems('partitioning the corpus into overlapping shards');
    const b = claimStems('partition the corpus into shards that overlap');
    assert.ok(a.has('partit') && a.has('corpu') && a.has('shard'), [...a].join(' '));
    assert.equal(jaccard(a, b), jaccard(b, a));
    assert.ok(jaccard(a, b) > 0.5 && jaccard(a, b) <= 1);
    assert.equal(jaccard(new Set(), new Set()), 0);
  });

  it('dependentBody strips the "of claim N" reference; dependentSignal counts what is new', () => {
    assert.equal(dependentBody('The method of claim 12, wherein the weight is squared.'), ', wherein the weight is squared.');
    const c1 = claimStems('ranking the shards by the rarity weight');
    const fresh = dependentSignal(c1, { n: 2, text: 'The method of claim 1, wherein the rarity weight is squared before ranking.' });
    assert.equal(fresh.fresh, 1, JSON.stringify(fresh));
    assert.deepEqual(fresh.freshWords, ['squar']);
    const empty = dependentSignal(c1, { n: 3, text: 'The method of claim 1, wherein the shards are ranked by the weight.' });
    assert.equal(empty.fresh, 0, JSON.stringify(empty));
  });
});

describe('triage: every verdict names its rule', () => {
  const result = triageClaims(fixture(), { shapeReport: shape });

  it('a sound, distinctive claim is KEEP with no penalty', () => {
    const c = byN(result, 1);
    assert.equal(c.tier, 'KEEP', JSON.stringify(c));
    assert.ok(c.score <= 0, `score ${c.score}: ${c.reasons.join('; ')}`);
    assert.ok(c.signals.mechanism >= 4, `mechanism ${c.signals.mechanism}`);
  });

  it('shape without mechanism is a hard DROP', () => {
    const c = byN(result, 2);
    assert.equal(c.tier, 'DROP');
    assert.ok(c.hard);
    assert.ok(c.reasons.some((r) => /shape without mechanism/.test(r)), c.reasons.join('; '));
  });

  it('no grounded anchor is a hard DROP: it cannot be charted back', () => {
    const c = byN(result, 3);
    assert.equal(c.tier, 'DROP');
    assert.ok(c.reasons.some((r) => /no grounded anchor/.test(r)), c.reasons.join('; '));
  });

  it('of a near-duplicate pair the less distinctive (or later) one DROPs and names the survivor', () => {
    const keep = byN(result, 4), drop = byN(result, 5);
    assert.ok(keep.signals.maxSim >= TRIAGE_THRESHOLDS.dupSim, `similarity ${keep.signals.maxSim}`);
    assert.equal(drop.tier, 'DROP');
    assert.ok(drop.reasons.some((r) => r.startsWith('near-duplicate of graph (layoutGraph)')), drop.reasons.join('; '));
    assert.notEqual(keep.tier, 'DROP');
    assert.ok(keep.reasons.some((r) => /near-duplicate pair with \[file\] graph\.js/.test(r) && /kept/.test(r)), keep.reasons.join('; '));
  });

  it('an echo (smaller cut of a bigger group\'s dominant file) is REVIEW, not DROP: it is a different cut, not a duplicate', () => {
    const c = byN(result, 6);
    assert.equal(c.signals.echoOf, 'shard (partitionShards)');
    assert.ok(c.reasons.some((r) => r.startsWith('echo of shard (partitionShards)')), c.reasons.join('; '));
    assert.equal(c.tier, 'REVIEW', `score ${c.score}: ${c.reasons.join('; ')}`);
  });

  it('a dependent set that restates claim 1 costs a point and a reason, and does NOT sink claim 1', () => {
    const c = byN(result, 7);
    assert.equal(c.signals.dependents, 3);
    assert.equal(c.signals.depWeak, 3, JSON.stringify(c.signals));
    assert.ok(c.reasons.some((r) => /3 of 3 dependents add <= 2 new words/.test(r)), c.reasons.join('; '));
    assert.equal(c.tier, 'KEEP', `score ${c.score}: ${c.reasons.join('; ')}`);
  });

  it('tier counts add up and the result keeps sidecar order', () => {
    assert.deepEqual(result.claims.map((c) => c.n), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(result.tiers.KEEP + result.tiers.REVIEW + result.tiers.DROP, 7);
    assert.deepEqual(result.tiers, { KEEP: 3, REVIEW: 1, DROP: 3 });
  });

  it('without a shape (old sidecar, no shapeReport) the mechanism rules stay silent rather than guessing', () => {
    const r = triageClaims(fixture());
    const c = byN(r, 2);
    assert.equal(c.signals.mechanism, null);
    assert.ok(!c.reasons.some((x) => /mechanism/.test(x)), c.reasons.join('; '));
  });

  it('a stored shape is used as-is; the sidecar does not have to be re-scored', () => {
    const f = fixture();
    f.claims[0].shape = shape(f.claims[0].claim, null);
    const r = triageClaims(f); // no shapeReport passed
    assert.equal(byN(r, 1).signals.mechanism, f.claims[0].shape.mechanism);
  });
});

describe('triage: the artifacts', () => {
  const sidecar = fixture();
  const result = triageClaims(sidecar, { shapeReport: shape });

  it('the ranked table leads with the caveat, the counts, and KEEP rows first', () => {
    const md = formatTriage(result, { source: 'run.txt.anchors.json' });
    assert.match(md, /NOT legal analysis/);
    assert.match(md, /KEEP 3\*\*, REVIEW 1, DROP 3/);
    const rows = md.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((l) => l.split('|')[2].trim()), ['KEEP', 'KEEP', 'KEEP', 'REVIEW', 'DROP', 'DROP', 'DROP']);
    assert.ok(rows.some((l) => /near-duplicate of graph/.test(l)));
  });

  it('the KEEP sidecar is renumbered, remembers the source number, and carries its verdict', () => {
    const keep = keepSidecar(sidecar, result, { source: 'run.txt.anchors.json', triagePath: 'run_triage.md' });
    assert.equal(keep.claims.length, 3);
    assert.deepEqual(keep.claims.map((c) => c.n), [1, 2, 3]);
    assert.deepEqual(keep.claims.map((c) => c.sourceN), [1, 4, 7]);
    assert.equal(keep.claims[0].triage.tier, 'KEEP');
    assert.equal(keep.triage.tiers.DROP, 3);
    assert.match(keep.note, /TRIAGE: the KEEP tier of run\.txt\.anchors\.json \(3 of 7\)/);
    assert.equal(keep.format, 'ce-pseudo-claim-anchors');
  });

  it('the keep file reads back through --synonymize as one claim per line, exactly the KEEP claims', () => {
    const keep = keepSidecar(sidecar, result, { source: 'run.txt.anchors.json', triagePath: 'run_triage.md' });
    const text = formatKeepFile(keep, { source: 'run.txt.anchors.json', triagePath: 'run_triage.md', keepPath: 'run_keep.txt', ceVersion: 'test', generatedAt: 'now' });
    const back = detectClaims(text);
    assert.equal(back.mode, 'marker');
    assert.deepEqual(back.claims, keep.claims.map((c) => c.claim));
    assert.match(text, /^# Claims:\s+3 \(the KEEP tier of 7 triaged; 1 REVIEW and 3 DROP left out\)$/m);
    assert.match(text, /^# Dependents: 3 drafted, NOT in this file/m);
  });
});

describe('triage: the blind eyeball-picks harness', () => {
  const picks = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'pseudo-claim-picks.json'), 'utf8'));

  it('the fixture has the schema the blind round fills in', () => {
    assert.ok(Array.isArray(picks.picks));
    assert.equal(typeof picks.runs, 'object');
  });

  it('every recorded pick still gets the tier it was read off with (KEEP, or a recorded known miss)', () => {
    const cache = new Map();
    for (const p of picks.picks) {
      assert.ok(p.label && p.run, `pick needs label + run: ${JSON.stringify(p)}`);
      const rel = picks.runs[p.run];
      assert.ok(rel, `run ${p.run} has no sidecar fixture in runs`);
      if (!cache.has(p.run)) {
        const sidecar = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', rel), 'utf8'));
        cache.set(p.run, triageClaims(sidecar, { shapeReport: shape }));
      }
      const c = cache.get(p.run).claims.find((x) => x.label === p.label);
      assert.ok(c, `pick ${p.label} not in ${p.run}`);
      if (p.knownMiss) assert.notEqual(c.tier, 'KEEP', `${p.label}: a known miss that now KEEPs -- promote it in the fixture`);
      else assert.equal(c.tier, p.expect || 'KEEP', `${p.label} (${p.run}): ${c.tier} -- ${c.reasons.join('; ')}`);
    }
  });
});
