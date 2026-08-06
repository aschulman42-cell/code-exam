// test_claim_chart.js — #300 Tier 2, the client deliverable.
//
// What is asserted here is STRUCTURE, never verdict content. The chart's value
// is that CE owns the table, the caveats and the coverage summary so charts
// from different engines are row-for-row comparable; the model owns only what
// goes in a cell. An ABSENT verdict is a legitimate result and nothing in this
// file may push toward or away from any label.
//
// The analysis half is an LLM call, mocked. Its quality is measured by the
// pre-registered live gate on the real '101 claim, not asserted here.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChartTable, parseTargets, collectCalleeBodies, mergeBestPerElement,
  coverageLine, formatChart, doClaimChart, CHART_DEFAULTS,
  parseChartVerdicts, fillChartRows, buildChartAnalysisPrompt, buildProvenanceHeader,
} from '../src/commands/claim-chart.js';

const CLAIM = [
  '1. A distribution system, including a transmission device and a reception device,',
  'the transmission device being equipped with a content transmitting unit for transmitting content data,',
  'the reception device being equipped with a content reproducing unit for reproducing the content,',
  'the distribution system comprising a code rate determining unit for determining the code rate.',
].join('\n');

describe('chart structure comes from the claim, not the model', () => {
  it('emits one row per claim element, in claim order', () => {
    const { table, elements } = buildChartTable(CLAIM);
    assert.equal(elements.length, 4);
    const rows = table.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    assert.equal(rows.length, 4, 'one row per element');
    assert.match(rows[0], /^\| 1 \|/);
    assert.match(rows[3], /^\| 4 \|/);
  });

  it('escapes pipes so a claim containing | cannot break the table', () => {
    const { table } = buildChartTable('1. A method comprising: doing a | b thing;\nand another step here.');
    const rows = table.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    for (const r of rows) {
      // Count UNESCAPED pipes: a backslash-escaped pipe is literal text inside
      // a cell and must not be counted as a delimiter.
      const delims = (r.match(/(^|[^\\])\|/g) || []).length;
      assert.equal(delims, 5, `row has exactly 5 delimiters: ${r}`);
    }
    // The claim's own pipe is preserved as literal text, in the row that had
    // it — not silently deleted.
    assert.ok(rows[0].includes('\\|'), 'the pipe from the claim survived, escaped');
    assert.ok(!rows[1].includes('\\|'), 'rows without a pipe are untouched');
  });

  it('leaves finding and citation cells empty for the merge to fill', () => {
    const { table } = buildChartTable(CLAIM);
    const first = table.split('\n').find((l) => /^\| 1 \|/.test(l));
    assert.match(first, /\|\s*\|\s*\|\s*$/, 'trailing cells start empty');
  });
});

describe('targets', () => {
  it('parses a semicolon list and trims', () => {
    assert.deepEqual(parseTargets('a.java@Foo::bar ; b.java@baz').targets, ['a.java@Foo::bar', 'b.java@baz']);
  });
  it('parses newline-separated too (targets file shape)', () => {
    assert.deepEqual(parseTargets('a@b\nc@d\n\n').targets, ['a@b', 'c@d']);
  });
  it('carries leading # lines as PROVENANCE, not as targets', () => {
    // This is what makes a targets file self-documenting: the operator records
    // how the list was produced, and the chart can then answer for it.
    const r = parseTargets(['# produced by --claim-locate --hunt --blind', '# run 2 of 2', 'a@b', 'c@d'].join('\n'));
    assert.deepEqual(r.targets, ['a@b', 'c@d']);
    assert.deepEqual(r.provenance, ['produced by --claim-locate --hunt --blind', 'run 2 of 2']);
  });
  it('reports a missing targets file rather than silently continuing', () => {
    assert.throws(() => parseTargets('@definitely_not_here_12345.txt'), /cannot read targets file/);
  });
});

describe('merge: best label per element, carrying its citation', () => {
  it('a stronger label from a later target wins', () => {
    const merged = mergeBestPerElement([
      { target: 'A.java@one', elements: [{ text: 'determining the code rate', label: 'ABSENT' }] },
      { target: 'B.java@two', elements: [{ text: 'determining the code rate', label: 'PRESENT' }] },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].label, 'PRESENT');
    assert.equal(merged[0].target, 'B.java@two', 'the citation travels with the winning label');
  });

  it('a weaker label does NOT displace a stronger one', () => {
    const merged = mergeBestPerElement([
      { target: 'A.java@one', elements: [{ text: 'reproducing the content', label: 'PARTIAL' }] },
      { target: 'B.java@two', elements: [{ text: 'reproducing the content', label: 'ABSENT' }] },
    ]);
    assert.equal(merged[0].label, 'PARTIAL');
    assert.equal(merged[0].target, 'A.java@one');
  });

  it('ABSENT survives when it is the only finding — absences are results', () => {
    const merged = mergeBestPerElement([
      { target: 'A.java@one', elements: [{ text: 'transmitting content data', label: 'ABSENT' }] },
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].label, 'ABSENT');
  });
});

describe('coverage summary counts what CE found, including nothing', () => {
  it('counts each label and reports elements with no finding', () => {
    const line = coverageLine([{ label: 'PRESENT' }, { label: 'ABSENT' }, { label: 'PARTIAL' }], 6);
    assert.match(line, /1 PRESENT/);
    assert.match(line, /1 PARTIAL/);
    assert.match(line, /1 ABSENT/);
    assert.match(line, /3 element\(s\) with no finding/);
  });
});

describe('the emitted artifact', () => {
  const base = () => {
    const { table, elements } = buildChartTable(CLAIM);
    return { claimText: CLAIM, table, elements, targets: ['A.java@one'], engineLabel: 'local test.gguf' };
  };

  it('carries the claim verbatim, the engine, and the caveats', () => {
    const out = formatChart({ ...base(), fills: [] });
    assert.ok(out.includes('A distribution system'), 'claim text is reproduced');
    assert.match(out, /Engine: local test\.gguf/);
    assert.match(out, /not legal advice/i);
    assert.match(out, /--extract/, 'tells the reader how to verify a citation');
  });

  it('includes a scope note only when one was supplied', () => {
    assert.ok(!formatChart({ ...base(), fills: [] }).includes('## Scope'));
    const withNote = formatChart({ ...base(), fills: [], scopeNote: 'Index is one component.' });
    assert.match(withNote, /## Scope[\s\S]*Index is one component\./);
  });

  it('is byte-identical in structure across engines — only the label differs', () => {
    const strip = (s) => s.replace(/Engine: .*?\. \d+ analysed/, 'Engine: X. N analysed');
    const fills = [{ text: 'determining the code rate', label: 'PRESENT', target: 'A.java@one' }];
    const a = strip(formatChart({ ...base(), fills, engineLabel: 'local gemma.gguf' }));
    const b = strip(formatChart({ ...base(), fills, engineLabel: 'claude' }));
    assert.equal(a, b, 'two engines must produce the same skeleton');
  });
});

describe('callee bodies (#300 Tier 1)', () => {
  const seed = { filepath: 'x/A.java', name: 'A::updateSelectedTrack', bare: 'updateSelectedTrack', start: 1, end: 9 };
  const symbols = [
    seed,
    { filepath: 'x/A.java', name: 'A::determineIdealSelectedIndex', bare: 'determineIdealSelectedIndex', start: 20, end: 30 },
  ];
  const index = {
    findCallers: () => [],
    findCallees: () => [{ callee_function: 'determineIdealSelectedIndex' }],
    getFunctionSource: (fp, n) => (n.includes('determineIdeal') ? 'int determineIdealSelectedIndex() { return 0; }' : null),
  };

  it('appends the callee BODY, not just its name', () => {
    const { text, included } = collectCalleeBodies(index, symbols, seed, {});
    assert.deepEqual(included, ['A::determineIdealSelectedIndex']);
    assert.match(text, /return 0;/, 'the body is present — a digest would give only the name');
    assert.match(text, /---- callee: A::determineIdealSelectedIndex/);
  });

  it('respects the byte budget', () => {
    const { text } = collectCalleeBodies(index, symbols, seed, { maxCalleeBytes: 10 });
    assert.ok(text.length < 200, 'clipped to the budget');
  });

  it('returns nothing when depth is 0', () => {
    assert.deepEqual(collectCalleeBodies(index, symbols, seed, { calleeDepth: 0 }).included, []);
  });
});

describe('end to end, mocked model', () => {
  const index = {
    functionIndex: { 'x/A.java': { 'A::one': { start: 1, end: 5 }, 'A::two': { start: 7, end: 9 } } },
    _ensureFunctionIndex() {},
    findCallers: () => [], findCallees: () => [],
    getFunctionSource: () => 'void one() { rate(); }',
  };

  it('produces a chart with the merged finding in the row', async () => {
    const analysis = [
      '1. A distribution system: ABSENT — no transmission side in this index.',
      '4. determining the code rate: PRESENT — rate() computes it.',
    ].join('\n');
    const out = [];
    const origLog = console.log; console.log = (s) => out.push(String(s));
    let res;
    try {
      res = await doClaimChart(index,
        { claim_chart: CLAIM, targets: 'x/A.java@A::one', model: 'f.gguf', no_callees: true },
        { draft: async () => analysis });
    } finally { console.log = origLog; }
    const chart = out.join('\n');
    assert.ok(res && res.targets === 1);
    assert.match(chart, /# Claim chart/);
    assert.match(chart, /\| 1 \|/, 'rows present');
    assert.match(chart, /Coverage:/);
  });

  it('fails loudly when no target resolves, rather than emitting an empty chart', async () => {
    const prev = process.exitCode;
    const errs = [];
    const origErr = console.error; console.error = (s) => errs.push(String(s));
    try {
      await doClaimChart(index,
        { claim_chart: CLAIM, targets: 'nowhere.java@missing', model: 'f.gguf' },
        { draft: async () => 'x' });
    } finally { console.error = origErr; }
    assert.match(errs.join(' '), /No target produced a parseable analysis/);
    process.exitCode = prev;
  });
});

describe('the VERDICT contract (chart-specific, not claim-analyze\'s)', () => {
  const ELS = ['first element about transmitting', 'second about reproducing', 'third about rate'];

  it('parses the contract and keeps element numbers', () => {
    const v = parseChartVerdicts([
      'Some prose first.',
      'VERDICT 1: ABSENT | nothing here, no line',
      'VERDICT 3: PRESENT | computes it at L42',
    ].join('\n'), ELS);
    assert.deepEqual(v.map((x) => [x.element, x.label]), [[1, 'ABSENT'], [3, 'PRESENT']]);
    assert.equal(v[0].text, ELS[0], 'element text comes from the CLAIM, not the model');
    assert.match(v[1].note, /L42/);
  });

  it('tolerates bold and dash variants a model may emit', () => {
    const v = parseChartVerdicts('**VERDICT 2** - PARTIAL | partly', ELS);
    assert.deepEqual([v[0].element, v[0].label], [2, 'PARTIAL']);
  });

  it('ignores out-of-range and duplicate element numbers', () => {
    const v = parseChartVerdicts([
      'VERDICT 9: PRESENT | out of range',
      'VERDICT 1: PRESENT | first',
      'VERDICT 1: ABSENT | duplicate, ignored',
    ].join('\n'), ELS);
    assert.equal(v.length, 1);
    assert.deepEqual([v[0].element, v[0].label], [1, 'PRESENT']);
  });

  it('falls back to labelled blocks when the model ignores the contract', () => {
    // buildClaimAnalyzePrompt asks for prose + a coverage line, so a model that
    // answers in THAT shape must still yield something rather than an empty
    // chart. This is the mismatch that made the first wiring produce 0 fills.
    const v = parseChartVerdicts('1. thing\n**ABSENT**\n\n2. other\n**PRESENT**', ELS);
    assert.ok(v.length >= 1, 'fallback recovered labels');
    assert.equal(v[0].element, 1);
  });
});

describe('fillChartRows targets by number, not by keyword overlap', () => {
  it('puts the label in the finding column and the citation in its own', () => {
    const { table } = buildChartTable(CLAIM);
    const out = fillChartRows(table, [
      { element: 4, label: 'PRESENT', target: 'A.java@f', note: 'at L469' },
    ]);
    const row4 = out.split('\n').find((l) => /^\| 4 \|/.test(l));
    assert.match(row4, /\*\*PRESENT\*\* at L469/);
    assert.match(row4, /`A\.java@f`/);
    const row1 = out.split('\n').find((l) => /^\| 1 \|/.test(l));
    assert.match(row1, /\|\s*\|\s*\|\s*$/, 'unfilled rows stay empty');
  });

  it('reports a finding it could not place rather than dropping it', () => {
    const { table } = buildChartTable(CLAIM);
    const out = fillChartRows(table, [{ label: 'PRESENT', target: 'A.java@f' }]);
    assert.match(out, /not matched to a numbered element/);
    assert.match(out, /A\.java@f/);
  });
});

describe('citations must be file-absolute (the smoke-run defect)', () => {
  // updateSelectedTrack lives at file L436-485. Before this fix, claim-chart
  // handed RAW source to the prompt, so models counted lines themselves and
  // cited "L27" — which resolves to file line 462 and sends a verifier to
  // unrelated code. Every chart citation must survive `ce --extract file@fn`.
  const seed = { filepath: 'x/A.java', name: 'A::target', bare: 'target', start: 436, end: 485 };
  const callee = { filepath: 'y/B.java', name: 'B::helper', bare: 'helper', start: 599, end: 613 };
  const index = {
    findCallers: () => [],
    findCallees: () => [{ callee_function: 'helper' }],
    getFunctionSource: (fp, n) => (n.includes('helper') ? 'int helper() {\n  return 1;\n}' : null),
  };

  it('numbers a callee body from ITS OWN start, not the target\'s', () => {
    const { text } = collectCalleeBodies(index, [seed, callee], seed, {});
    assert.match(text, /^\s*599 \|/m, 'callee numbering starts at its own file line');
    assert.match(text, /^\s*600 \|/m);
    assert.ok(!/^\s*43[6-9] \|/m.test(text), 'must NOT inherit the target function offset');
  });

  it('tells the model the numbers are the file\'s own', () => {
    const p = buildChartAnalysisPrompt('  436 | code', 'A::target', 'x/A.java', 'a claim', ['e1']);
    assert.match(p, /OWN file line numbers/);
    assert.match(p, /Do not count lines/);
    assert.match(p, /do not renumber from 1/i);
  });
});

describe('provenance header', () => {
  const base = {
    claimText: '1. A distribution system, comprising a thing.',
    claimSource: '`claim.txt`', indexPath: '.Idx', indexFiles: 3578, indexSymbols: 65370,
    engineLabel: 'claude', argv: 'src/index.js --claim-chart @claim.txt',
    targets: 34, targetSource: '`t.txt`', ceVersion: 'v0.5.0',
    generatedAt: '2026-08-06T00:00:00.000Z',
  };

  it('records what is needed to reproduce the run', () => {
    const h = buildProvenanceHeader({ ...base, targetProvenance: ['produced by X'] });
    for (const want of ['A distribution system', '`claim.txt`', '.Idx', '3578 files',
      '65370 symbols', 'claude', '34 analysed', '`t.txt`', 'produced by X',
      '--claim-chart @claim.txt', '2026-08-06T', 'v0.5.0']) {
      assert.ok(h.includes(want), `header must record ${want}`);
    }
  });

  it('says so explicitly when target provenance is unknown', () => {
    // An honest blank is defensible; an invisible one is not. "Why these
    // targets and not others" is the first question asked of a claim chart.
    const h = buildProvenanceHeader({ ...base, targetProvenance: [] });
    assert.match(h, /not recorded/);
    assert.match(h, /why these and not others/);
  });

  it('does not fabricate a command line it did not capture', () => {
    const h = buildProvenanceHeader({ ...base, argv: '', targetProvenance: [] });
    assert.match(h, /not captured/);
  });
});

describe('agreement counts', () => {
  const many = (labels) => labels.map((label, i) => ({
    target: `T${i}.java@f${i}`,
    elements: [{ element: 1, text: 'an element', label, note: '' }],
  }));

  it('tallies every target verdict, not just the winner', () => {
    const merged = mergeBestPerElement(many(['ABSENT', 'PRESENT', 'ABSENT']));
    assert.equal(merged[0].label, 'PRESENT', 'strongest still wins');
    assert.equal(merged[0].agreement.PRESENT, 1);
    assert.equal(merged[0].agreement.ABSENT, 2);
    assert.equal(merged[0].agreement.total, 3);
  });

  it('renders how lonely a finding is', () => {
    // A lone PRESENT promoted over 33 dissents deserves scrutiny; 30-of-34 does
    // not. The chart rendered those two situations identically before this.
    const { table } = buildChartTable(CLAIM);
    const out = fillChartRows(table, [{
      element: 1, label: 'PRESENT', target: 'A.java@f', note: 'x',
      agreement: { PRESENT: 1, PARTIAL: 0, ASSUMED: 0, ABSENT: 33, total: 34 },
    }]);
    assert.ok(out.includes('(1 of 34; 33 ABSENT)'), 'agreement is rendered');
  });

  it('omits the count when there was only one target', () => {
    const { table } = buildChartTable(CLAIM);
    const out = fillChartRows(table, [{
      element: 1, label: 'PRESENT', target: 'A.java@f',
      agreement: { PRESENT: 1, PARTIAL: 0, ASSUMED: 0, ABSENT: 0, total: 1 },
    }]);
    assert.ok(!out.includes('of 1'), 'no agreement note for a single target');
  });
});
