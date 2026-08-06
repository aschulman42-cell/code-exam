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
  lexicalStems, stemMatches, lexicalGate,
  redraftTriggered, coverageScore, betterCoverage, buildRedraftPrompt, parseRedraft, emptyChartTable,
} from '../src/commands/claims-loop.js';
import { buildClaimAnalyzePrompt } from '../src/commands/analyze.js';
import { projectCloudCost, claimsCostGate, CLAIMS_COST_GUARD_USD } from '../src/core/llm-runner.js';

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
  it('splits bold-wrapped numbered elements ("**1. …**") into separate blocks', () => {
    const { elements } = parseAnalysisLabels(
      '**1. Scanning source files:**\nDoes scan things. **PRESENT**\n\n**2. Inferring pipelines from co-occurrence:**\nGroups cells and classifies. **PRESENT**\n');
    assert.equal(elements.length, 2);
    assert.match(elements[1].text, /Inferring pipelines/);
    assert.equal(elements[1].label, 'PRESENT');
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

// #290 precision tuning: stems, the fill gate, member pre-rank, rubric.
describe('claims-loop lexical gate + pre-rank (precision tuning)', () => {
  it('stems match identifier-dense code as substrings', () => {
    const stems = lexicalStems('tracing the submission attempt');
    assert.ok(stemMatches(stems, 'window.__bramIframeTrace("message-agent-submit")') >= 2); // trac + submi
  });
  it('gates PRESENT/PARTIAL with no vocabulary overlap down to ASSUMED', () => {
    assert.equal(lexicalGate('PRESENT', 'retrieving a file from the bundle', 'function decideSpinner(ids) { return ids[0]; }'), 'ASSUMED');
    assert.equal(lexicalGate('PARTIAL', 'retrieving a file from the bundle', 'function decideSpinner() {}'), 'ASSUMED');
    assert.equal(lexicalGate('PRESENT', 'routing the widget', 'function routeWidget(w) {}'), 'PRESENT');
    assert.equal(lexicalGate('ABSENT', 'anything at all zzz', 'function q() {}'), 'ABSENT'); // gate only touches fills
  });
  it('adapts the bar to short elements', () => {
    // one usable stem -> one match suffices
    assert.equal(lexicalGate('PRESENT', 'frobnicating it', 'function frobnicate(x) {}'), 'PRESENT');
  });
  it('pre-ranks members by claim-text overlap so the right function surfaces', () => {
    const members = ['a.js@listModels', 'a.js@listArtifacts', 'a.js@listPipelines'];
    const anchors = pickAnchors('[class] _AIMLMethods', members, 1,
      'inferring end-to-end AI/ML pipelines based on co-occurrence of component cells');
    assert.deepEqual(anchors, ['a.js@listPipelines']);
  });
  it('keeps .lst order when no claim text is given (back-compat)', () => {
    const members = ['a.js@listModels', 'a.js@listPipelines'];
    assert.deepEqual(pickAnchors('[class] X', members, 1), ['a.js@listModels']);
  });
  it('rubric demands a verbatim quote for PRESENT and bars adjacent roles', () => {
    const p = buildClaimAnalyzePrompt('function f() {}', 'f', 'a.js', 'A method.', false);
    assert.match(p, /MUST quote the specific line/);
    assert.match(p, /ADJACENT ROLE IS NOT IMPLEMENTATION/);
  });
});

describe('claims-loop convergence flag', () => {
  it('flags ABSENT-heavy + retrieval-silent, and only that', () => {
    assert.equal(needsRedraft({ PRESENT: 0, PARTIAL: 0, ABSENT: 3, ASSUMED: 1 }, 0), true);
    assert.equal(needsRedraft({ PRESENT: 0, PARTIAL: 0, ABSENT: 3, ASSUMED: 1 }, 1), false); // retrieval found the group
    assert.equal(needsRedraft({ PRESENT: 2, PARTIAL: 0, ABSENT: 3, ASSUMED: 0 }, 0), false); // some PRESENT
  });
});

// pseudo-claims-cost-guard: projection math and gate behavior (no LLM, no
// network — the gate is pure arithmetic over call descriptors).
describe('claims cost guard', () => {
  const sonnet = { kind: 'cloud', model: 'claude-sonnet-4-6', label: 'Claude API' };

  it('projects chars->tokens->USD at the model rate', () => {
    // 4M chars in = 1M tokens @ $3; 100k tokens out @ $15 -> $3 + $1.50
    const { usd, inTok, outTok } = projectCloudCost(sonnet, [{ inChars: 4_000_000, outTokens: 100_000 }]);
    assert.equal(inTok, 1_000_000);
    assert.equal(outTok, 100_000);
    assert.ok(Math.abs(usd - 4.5) < 0.01, `usd=${usd}`);
  });
  it('gates an over-threshold cloud run, --force overrides', () => {
    const big = [{ inChars: 40_000_000, outTokens: 0 }]; // ~$30 at sonnet rates
    assert.equal(claimsCostGate(sonnet, big, 'test', {}), false);
    assert.equal(claimsCostGate(sonnet, big, 'test', { force: true }), true);
  });
  it('passes small runs and never gates local models', () => {
    assert.equal(claimsCostGate(sonnet, [{ inChars: 4000, outTokens: 100 }], 'test', {}), true);
    assert.equal(claimsCostGate({ kind: 'gguf', modelPath: 'x.gguf' }, [{ inChars: 1e9, outTokens: 1e6 }], 'test', {}), true);
    assert.equal(claimsCostGate(null, [{ inChars: 1e9 }], 'test', {}), true);
  });
  it('honors the CE_CLAIMS_COST_GUARD env override', () => {
    const calls = [{ inChars: 4_000_000, outTokens: 0 }]; // ~$3 > default $2
    assert.equal(claimsCostGate(sonnet, calls, 'test', {}), false);
    process.env.CE_CLAIMS_COST_GUARD = '10';
    try { assert.equal(claimsCostGate(sonnet, calls, 'test', {}), true); }
    finally { delete process.env.CE_CLAIMS_COST_GUARD; }
    assert.ok(CLAIMS_COST_GUARD_USD === 2.0);
  });
});

// issue-290-loop-redraft: trigger, accept-best scoring, prompt discipline,
// CLAIM: parsing, and the fresh-table builder.
describe('claims-loop redraft helpers', () => {
  it('triggers on an ABSENT best label or the flag, never on ASSUMED alone', () => {
    assert.equal(redraftTriggered(['PRESENT', 'ABSENT'], false), true);
    assert.equal(redraftTriggered(['PRESENT', 'ASSUMED'], false), false);
    assert.equal(redraftTriggered(['PRESENT'], true), true);
    assert.equal(redraftTriggered([], false), false);
  });
  it('accept-best requires strict coverage improvement', () => {
    const a = coverageScore(['PRESENT', 'PARTIAL', 'ABSENT']);
    const b = coverageScore(['PRESENT', 'ABSENT', 'ABSENT']);
    assert.equal(betterCoverage(a, b), true);
    assert.equal(betterCoverage(b, a), false);
    assert.equal(betterCoverage(a, a), false); // ties keep the original
  });
  it('redraft prompt carries the preserve/rewrite/drop discipline + verdicts', () => {
    const { sys, user } = buildRedraftPrompt('A method.', [{ label: 'ABSENT', text: 'el one' }], 'function f() {}');
    assert.match(sys, /PRESERVE verbatim/);
    assert.match(sys, /REWRITE each element listed as ABSENT/);
    assert.match(sys, /DROP the element rather than inventing/);
    assert.match(user, /\[ABSENT\] el one/);
    assert.match(user, /ORIGINAL CLAIM:\nA method\./);
  });
  it('parses CLAIM: replies and rejects stubs', () => {
    assert.match(parseRedraft('CLAIM: A method for widget routing, comprising: receiving a widget request thing.'), /^A method for widget routing/);
    assert.equal(parseRedraft('I cannot.'), null);
    assert.equal(parseRedraft('CLAIM: too short'), null);
  });
  it('builds an empty chart table from redrafted prose', () => {
    const t = emptyChartTable('A method, comprising: step one; and step two.');
    assert.match(t, /\| 1 \| A method, comprising: \| _Preamble_ \|/);
    assert.match(t, /\| 2 \| step one \|\s*\|/);
    assert.match(t, /\| 3 \| and step two \|\s*\|/);
  });
});

describe('doClaimsLoop --loop-redraft end-to-end (mock drafter + stub index)', () => {
  it('redrafts the ABSENT claim, keeps grounded claims untouched, reports convergence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-redraft-'));
    const chartPath = path.join(dir, 'chart.md');
    const lstPath = path.join(dir, 'cand.lst');
    fs.writeFileSync(chartPath, CHART);
    fs.writeFileSync(lstPath, LST);

    const index = {
      getFunctionSource: (fp, fn) => (fp.startsWith('src/') ? `function ${fn}(widgetRequest) { return routeWidget(widgetRequest); }` : null),
      formatVocabularyForPrompt: () => '',
      multisectSearch: () => ({ function_matches: [{ function: 'frob', filepath: 'src/b.js', terms_matched: 3 }] }),
    };
    const draftShim = async (a, b) => {
      const p = String(a) + String(b);
      if (p.includes('Extract search terms')) return 'TIGHT: widget;routing;frob\nBROAD: widget;route';
      if (p.includes('PRESERVE verbatim')) {
        return 'CLAIM: A method for frobnicating, comprising: routing the widget request through the frobnicator.';
      }
      if (p.includes('through the frobnicator')) {
        return '1. **"routing the widget request through the frobnicator"** — routeWidget does this. **PRESENT**\n\nClaim coverage: 1 PRESENT, 0 PARTIAL, 0 ABSENT, 0 ASSUMED out of 1 elements.';
      }
      if (p.includes('frobnicating the input')) {
        return '1. **"frobnicating the input"** — nothing frobnicates here. **ABSENT**\n\nClaim coverage: 0 PRESENT, 0 PARTIAL, 1 ABSENT, 0 ASSUMED out of 1 elements.';
      }
      return '1. **"receiving a widget request"** yes. **PRESENT**\n\nClaim coverage: 1 PRESENT, 0 PARTIAL, 0 ABSENT, 0 ASSUMED out of 1 elements.';
    };

    const res = await doClaimsLoop(index,
      { claims_loop: chartPath, candidates: lstPath, model: 'fake.gguf', temperature: 0, loop_redraft: true },
      { draft: draftShim });
    assert.equal(res.redrafts.accepted.length, 1);
    assert.equal(res.redrafts.accepted[0].label, '[class] Beta');
    const out = fs.readFileSync(res.outPath, 'utf8');
    assert.match(out, /Redrafted by the claims-loop/);
    assert.match(out, /routing the widget request through the frobnicator/);
    assert.match(out, /> Original claim \(pre-redraft\): A method for frobnicating, comprising: frobnicating the input\./);
    assert.match(out, /### Redrafted \(coverage improved/);
    assert.match(out, /Convergence: \d\/1 accepted redrafts retrieve their own group/);
    // the grounded claim (alpha) still has its normal fill, not a redraft
    assert.match(out, /_\(loop: PRESENT\)_/);
    assert.doesNotMatch(out.split('## Pseudo-claim 2')[0], /Redrafted by the claims-loop/);
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
      // Body carries widget/request vocabulary so claim 1's fill passes the
      // lexical gate; claim 2's ("frobnicating") fill gets gated on Beta::frob.
      getFunctionSource: (fp, fn) => (fp.startsWith('src/') ? `function ${fn}(widgetRequest) { return routeWidget(widgetRequest); }` : null),
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
      { claims_loop: chartPath, candidates: lstPath, model: 'fake.gguf', temperature: 0, loop_save_analyses: true },
      { draft: draftShim });
    assert.ok(res && fs.existsSync(res.outPath));
    const out = fs.readFileSync(res.outPath, 'utf8');
    assert.match(out, /_\(loop: PRESENT\)_/);
    assert.match(out, /## Claims-loop summary/);
    assert.match(out, /Lexical gate downgraded \d+ PRESENT\/PARTIAL/);
    assert.match(out, /`printUsage`/); // sponge (hit in >2 of the 2 claims? T=2 needs >2) —
    // printUsage hits both claims = 2 ids, not >2, so it SURVIVES and shows as cross-group.
    assert.match(out, /cross-group candidate\(s\): `printUsage`/);
    // --loop-save-analyses wrote the raw per-anchor outputs
    const saveDir = res.outPath.replace(/_looped\.md$/, '_looped_analyses');
    assert.ok(fs.existsSync(saveDir) && fs.readdirSync(saveDir).length >= 1);
  });
});
