// test_retrieval_reachability.js — the retrieval acceptance instrument.
//
// Proposed by asus-CC (#311, 2026-09-04): three weeks of retrieval work had
// no acceptance test — every change was scored against someone's judgement of
// whether a citation looked better. The fixture carries two externally-named
// implementer lists for '101 x ExoPlayer3 (ChatGPT's reference chart and
// asus-CC's own prior reading) with per-symbol provenance, and this test asks
// one question: of those symbols, how many does per-element retrieval put in
// the SELECTED TARGET LIST — in front of the selection model — today?
//
// REPORT + RATCHET, never aspiration. The test reports N-of-M per provenance
// set and fails only when a count REGRESSES below the fixture's recorded
// high-water mark. Reachable-at-selection-depth is the bar, NOT
// expected-to-be-cited: whether the analysis model then cites a reached
// symbol is a different property and is measured by the loop, not here.
//
// Model-free: the vocabulary step is stubbed with RUN 17's recorded predicted
// words (fixture-pinned), so everything downstream — searchSymbolsByWords,
// the content arm and its promoted slot, round-robin selection,
// concentration, drilldown, the whole-claim arm — is the REAL pipeline code
// with no API key and no network. vocabRuns stays 1: the multi-run merge is
// a cloud temp-0 stabilizer, meaningless when the words are pinned.
//
// The target-assembly sequence below mirrors doClaimChart's no-`--targets`
// path (claim-chart.js, retrievePerElement -> perElementTargetsWithStats ->
// drilldownTargets -> wholeClaimArm). If that assembly changes shape, update
// this mirror — or better, lift the assembly into an exported function both
// can call; until then this comment is the drift warning.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { buildSymbolTable } from '../src/core/symbol-verify.js';
import { splitClaimElements, retrievePerElement } from '../src/commands/claim-locate.js';
import {
  perElementTargetsWithStats, drilldownTargets, wholeClaimArm, CHART_DEFAULTS,
} from '../src/commands/claim-chart.js';

// Fixtures resolve from THIS FILE, never from the working directory (#314).
const fixturePath = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const repoPath = (n) => fileURLToPath(new URL(`../${n}`, import.meta.url));

const FIXTURE = 'retrieval-reachability-8752101-exoplayer3.json';
const fx = JSON.parse(fs.readFileSync(fixturePath(FIXTURE), 'utf8'));

// Membership per provenance set. The independent intersection EXCLUDES
// contaminated symbols — provenance inherited from a handover doc spends the
// independence that makes two-source agreement evidence (asus-CC, #311).
const inSet = {
  'union': () => true,
  'chatgpt-external': (e) => e.sources.includes('chatgpt-external'),
  'asus-reading': (e) => e.sources.includes('asus-reading'),
  'independent-intersection': (e) =>
    e.sources.includes('chatgpt-external') && e.sources.includes('asus-reading') && !e.contaminated,
};

describe('retrieval reachability fixture — integrity', () => {
  it('declared set sizes match the symbol list', () => {
    for (const [set, size] of Object.entries(fx.set_sizes)) {
      const got = fx.expected_reachable.filter(inSet[set]).length;
      assert.equal(got, size, `set '${set}' declares ${size}, list yields ${got}`);
    }
  });

  it('every ratchet floor names a declared set and fits inside it', () => {
    for (const [set, floor] of Object.entries(fx.ratchet.floors)) {
      assert.ok(set in fx.set_sizes, `floor '${set}' has no declared set size`);
      assert.ok(floor >= 0 && floor <= fx.set_sizes[set],
        `floor '${set}' = ${floor} outside 0..${fx.set_sizes[set]}`);
    }
  });

  it('pinned element words parse and cover every element of the claim fixture', () => {
    const claimText = fs.readFileSync(fixturePath(fx.claim_file), 'utf8');
    const elements = splitClaimElements(claimText);
    const els = Object.keys(fx.element_words).map(Number).sort((a, b) => a - b);
    assert.deepEqual(els, elements.map((_, i) => i + 1),
      'one pinned word set per claim element, 1..N');
    for (const ws of Object.values(fx.element_words)) {
      assert.ok(Array.isArray(ws) && ws.length, 'non-empty word set');
      for (const w of ws) assert.match(w, /^[a-z0-9]{3,24}$/, `word '${w}' violates the parser charset`);
    }
  });
});

describe('retrieval reachability — measured against the real index', () => {
  const indexPath = repoPath(fx.index);
  const present = fs.existsSync(indexPath);

  it(`reaches at least the ratchet floors on ${fx.index}`, { timeout: 120000 }, async (t) => {
    if (!present) {
      // CI safety: the index is a locally-built artifact, not in git. Absence
      // skips with a stated notice — it must never fail a fresh clone.
      t.skip(`${fx.index} not present — reachability is measured only where the index exists`);
      return;
    }
    const claimText = fs.readFileSync(fixturePath(fx.claim_file), 'utf8');
    const elements = splitClaimElements(claimText);
    const stubDraft = async () => Object.entries(fx.element_words)
      .map(([el, ws]) => `${el}: ${ws.join(', ')}`).join('\n');

    const index = new CodeSearchIndex({ indexPath });
    const symbols = buildSymbolTable(index);
    assert.ok(symbols.length > 0, 'index yielded a symbol table');

    // retrievePerElement narrates to stderr; keep the suite's output clean.
    const _w = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    let disc;
    try {
      disc = await retrievePerElement({ draft: stubDraft, elements, symbols,
        opts: { index, vocabRuns: 1 } });
    } finally { process.stderr.write = _w; }
    assert.equal(disc.error, null, `retrieval errored: ${disc.error}`);
    const retrieval = disc.perElement;
    assert.equal(retrieval.length, elements.length, 'every element retrieved');

    // Mirror of doClaimChart's default target assembly (see header comment).
    const budget = perElementTargetsWithStats(retrieval, {});
    const targets = budget.targets.slice();
    if (budget.concentration.length) {
      retrieval.push({ element: 0, arm: 'concentration', words: [],
        hits: budget.concentration.map((c) => c.hit) });
    }
    const dd = drilldownTargets({ index, retrieval, targets });
    for (const a of dd.added) {
      targets.push(a.spec);
      retrieval.push({ element: a.element, arm: 'drilldown', file: a.file,
        words: [], hits: [{ sym: a.sym, arm: 'content' }] });
    }
    const whole = wholeClaimArm({ claimText, symbols, index,
      limit: CHART_DEFAULTS.wholeClaimTargets });
    const have = new Set(targets);
    for (const h of whole.hits) {
      const s = `${String(h.sym.filepath || '').split('!').pop().split('/').pop()}@${h.sym.name}`;
      if (!have.has(s)) { have.add(s); targets.push(s); }
    }
    assert.ok(targets.length > 0, 'selection produced targets');

    // A symbol is REACHED when any selected target spec (`File.java@Name`)
    // contains it — family-level on purpose: a target inside SampleQueue.java
    // means retrieval put the implementer in front of the model, which is the
    // property under test. (An interface name inside an implementer's name —
    // Allocator in DefaultAllocator — credits both; disclosed, and honest.)
    const reached = fx.expected_reachable
      .filter((e) => targets.some((tg) => tg.includes(e.symbol)));
    const reachedSet = new Set(reached.map((e) => e.symbol));

    // THE REPORT — always printed, whatever the verdict.
    const lines = [`retrieval reachability — ${fx.claim} x ${fx.index} (${targets.length} selected targets):`];
    for (const [set, size] of Object.entries(fx.set_sizes)) {
      const n = reached.filter(inSet[set]).length;
      const floor = fx.ratchet.floors[set];
      lines.push(`  ${set}: ${n} of ${size} reachable`
        + (floor != null ? ` (ratchet floor ${floor})` : ' (reported, no floor)'));
    }
    lines.push(`  reached: ${[...reachedSet].join(', ') || '(none)'}`);
    t.diagnostic(lines.join('\n'));

    // THE RATCHET — regression below a recorded high-water mark fails.
    let aboveFloor = false;
    for (const [set, floor] of Object.entries(fx.ratchet.floors)) {
      const n = reached.filter(inSet[set]).length;
      assert.ok(n >= floor,
        `REGRESSION: '${set}' reached ${n}, below the recorded high-water mark ${floor}. `
        + `A retrieval change dropped symbols the pipeline could previously reach — `
        + `see the report above for which sets moved.`);
      if (n > floor) aboveFloor = true;
    }
    if (aboveFloor) {
      t.diagnostic('HIGH-WATER MARK RISEN: a count exceeds its recorded floor. '
        + `Raise the floors in test/fixtures/${FIXTURE} (with a dated history entry) `
        + 'so the gain is locked in.');
    }
  });
});
