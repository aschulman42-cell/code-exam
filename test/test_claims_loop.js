// test_claims_loop.js — #290 harness: the deterministic pieces (chart/lst
// parsing, namesake anchoring, tolerant label parsing, sponge detection,
// cell writeback, convergence flag) plus doClaimsLoop end-to-end with a mock
// drafter + stub index. No live LLM in CI; the pod measurement gate covers
// real-model behavior.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseChartClaims, parseCandidateGroups, pickAnchors, parseAnalysisLabels,
  detectSponges, hitInGroup, fillChartSection, needsRedraft, doClaimsLoop,
} from '../src/commands/claims-loop.js';

const CHART = `# PSEUDO-CLAIMS — illustrative drafting exercise

_Drafted from 2 evidence pack(s)._

## Contents

1. [P3] alpha (doAlpha) — "A method for widget routing"

## Pseudo-claim 1 — alpha (doAlpha)  (P3)

**[PSEUDO-CLAIM — illustrative only; not a legal opinion.]**

A method for widget routing, comprising: receiving a widget request; routing the widget to a handler; and logging the routing decision.

### Claim chart (0 grounded cites)

| # | Claim element / step | Cited code |
|---|---|---|
| 1 | A method for widget routing, comprising: | _Preamble_ |
| 2 | receiving a widget request |  |
| 3 | routing the widget to a handler |  |
| 4 | and logging the routing decision |  |

## Pseudo-claim 2 — [class] Beta  (P2)

**[PSEUDO-CLAIM — illustrative only; not a legal opinion.]**

A method for frobnicating, comprising: frobnicating the input.

### Claim chart (0 grounded cites)

| # | Claim element / step | Cited code |
|---|---|---|
| 1 | A method for frobnicating, comprising: | _Preamble_ |
| 2 | frobnicating the input |  |
`;

const LST = `# ILLUSTRATIVE ranking disclaimer line
#
# alpha (doAlpha)  (3 fns)  [P3 codebase-specific/keep — routing core]
docs/notes.md@L1-10
src/a.js@doAlpha
src/a.js@handleWidget
src/a.js@logRoute

# [class] Beta  (1 fns)  [P2 standard-pattern/keep — frob]
src/b.js@Beta::frob
`;

describe('claims-loop chart/lst parsing', () => {
  it('parses claims with prose and labels', () => {
    const claims = parseChartClaims(CHART);
    assert.equal(claims.length, 2);
    assert.equal(claims[0].label, 'alpha (doAlpha)');
    assert.equal(claims[0].prio, 'P3');
    assert.match(claims[0].claimText, /^A method for widget routing/);
    assert.equal(claims[1].label, '[class] Beta');
  });
  it('parses lst groups, skipping the disclaimer comments', () => {
    const groups = parseCandidateGroups(LST);
    assert.deepEqual([...groups.keys()], ['alpha (doAlpha)', '[class] Beta']);
    assert.equal(groups.get('alpha (doAlpha)').length, 4);
  });
  it('anchors namesake-first and skips doc anchors', () => {
    const groups = parseCandidateGroups(LST);
    const anchors = pickAnchors('alpha (doAlpha)', groups.get('alpha (doAlpha)'), 2);
    assert.deepEqual(anchors, ['src/a.js@doAlpha', 'src/a.js@handleWidget']);
  });
});

describe('claims-loop label parsing', () => {
  it('prefers the coverage-summary line for counts', () => {
    const { counts } = parseAnalysisLabels(
      '1. **"receiving"** ... **PRESENT**\n2. **"routing"** ... **ABSENT**\n\nClaim coverage: 2 PRESENT, 1 ASSUMED, 0 PARTIAL, 1 ABSENT out of 4 elements.');
    assert.deepEqual(counts, { PRESENT: 2, PARTIAL: 0, ABSENT: 1, ASSUMED: 1 });
  });
  it('falls back to inline bold labels and captures element text', () => {
    const { counts, elements } = parseAnalysisLabels(
      '1. **"receiving a widget request"** — the code receives it. **PRESENT** (Lines 2-4)\n\n2. **"routing the widget"** — not visible here. Label: ABSENT\n');
    assert.deepEqual(counts, { PRESENT: 1, PARTIAL: 0, ABSENT: 1, ASSUMED: 0 });
    assert.equal(elements.length, 2);
    assert.match(elements[0].text, /receiving a widget request/);
    assert.equal(elements[1].label, 'ABSENT');
  });
});

describe('claims-loop sponge detection + agreement', () => {
  it('suppresses functions hitting more than T claims', () => {
    const hits = new Map([
      [1, [{ name: 'printUsage' }, { name: 'doAlpha' }]],
      [2, [{ name: 'printUsage' }]],
      [3, [{ name: 'printUsage' }, { name: 'frob' }]],
    ]);
    const sponges = detectSponges(hits, 2);
    assert.deepEqual([...sponges], ['printUsage']);
  });
  it('matches hits into a group by bare name incl. class-qualified', () => {
    const members = ['src/b.js@Beta::frob'];
    assert.equal(hitInGroup({ name: 'frob' }, members), true);
    assert.equal(hitInGroup({ name: 'Beta::frob' }, members), true);
    assert.equal(hitInGroup({ name: 'other' }, members), false);
  });
});

describe('claims-loop writeback', () => {
  const section = CHART.slice(CHART.indexOf('## Pseudo-claim 1'), CHART.indexOf('## Pseudo-claim 2'));
  it('fills the best-matching empty cell with loop provenance', () => {
    const out = fillChartSection(section, [
      { text: 'receiving a widget request the code receives', label: 'PRESENT', target: 'src/a.js@doAlpha' },
    ]);
    assert.match(out, /\| 2 \| receiving a widget request \| `src\/a\.js@doAlpha` _\(loop: PRESENT\)_ \|/);
    assert.match(out, /\| 3 \| routing the widget to a handler \|\s*\|/); // untouched
  });
  it('footnotes fills that match no row', () => {
    const out = fillChartSection(section, [
      { text: 'completely unrelated verbiage zzz', label: 'PARTIAL', target: 'src/a.js@logRoute' },
    ]);
    assert.match(out, /Loop result\(s\) not matched to a specific element: `src\/a\.js@logRoute` _\(loop: PARTIAL\)_/);
  });
});

describe('claims-loop convergence flag', () => {
  it('flags ABSENT-heavy + retrieval-silent, and only that', () => {
    assert.equal(needsRedraft({ PRESENT: 0, PARTIAL: 0, ABSENT: 3, ASSUMED: 1 }, 0), true);
    assert.equal(needsRedraft({ PRESENT: 0, PARTIAL: 0, ABSENT: 3, ASSUMED: 1 }, 1), false); // retrieval found the group
    assert.equal(needsRedraft({ PRESENT: 2, PARTIAL: 0, ABSENT: 3, ASSUMED: 0 }, 0), false); // some PRESENT
  });
});

describe('doClaimsLoop end-to-end (mock drafter + stub index)', () => {
  it('writes a _looped.md with fills, sponge list, and summary', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-loop-'));
    const chartPath = path.join(dir, 'chart.md');
    const lstPath = path.join(dir, 'cand.lst');
    fs.writeFileSync(chartPath, CHART);
    fs.writeFileSync(lstPath, LST);

    const index = {
      getFunctionSource: (fp, fn) => (fp.startsWith('src/') ? `function ${fn}() { return 1; }` : null),
      formatVocabularyForPrompt: () => '',
      multisectSearch: () => ({ function_matches: [{ function: 'printUsage', filepath: 'src/u.js', terms_matched: 3 }] }),
    };
    // Anchored prompts get an element-labeled reply; term-extraction prompts get TIGHT/BROAD.
    const draft = async (sys) => (sys.includes('Extract search terms')
      ? 'TIGHT: widget;routing;handler\nBROAD: widget;route'
      : '1. **"receiving a widget request"** yes. **PRESENT**\n\nClaim coverage: 1 PRESENT, 0 PARTIAL, 0 ABSENT, 0 ASSUMED out of 1 elements.');
    // sys arrives as the first arg for term extraction; anchored calls pass the whole prompt first.
    const draftShim = async (a, b, mt) => draft(String(a) + String(b), mt);

    const res = await doClaimsLoop(index,
      { claims_loop: chartPath, candidates: lstPath, model: 'fake.gguf', temperature: 0 },
      { draft: draftShim });
    assert.ok(res && fs.existsSync(res.outPath));
    const out = fs.readFileSync(res.outPath, 'utf8');
    assert.match(out, /_\(loop: PRESENT\)_/);
    assert.match(out, /## Claims-loop summary/);
    assert.match(out, /`printUsage`/); // sponge (hit in >2 of the 2 claims? T=2 needs >2) —
    // printUsage hits both claims = 2 ids, not >2, so it SURVIVES and shows as cross-group.
    assert.match(out, /cross-group candidate\(s\): `printUsage`/);
  });
});
