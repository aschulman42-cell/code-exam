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
  coverageLine, formatChart, doClaimChart, CHART_DEFAULTS, nominationIndex, targetSpec,
  parseChartVerdicts, fillChartRows, buildChartAnalysisPrompt, buildProvenanceHeader,
  perElementTargets, normalizeVerdictLine, perElementTargetsWithStats, resolveTargetBudget,
  filterMatchesByFile,
} from '../src/commands/claim-chart.js';
import { targetsChecksum } from '../src/commands/claim-locate.js';
import { engineBuildLine, getEngineBuild, formatEngineBuild } from '../src/core/llm-runner.js';
import { createRequire } from 'node:module';
import { readClaimFile, addLineNumbers, SimpleMasker, detectLanguage } from '../src/commands/analyze.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
// Fixtures resolve from THIS FILE, never from the working directory. A bare
// readFileSync('name.txt') resolves against cwd, which is what made these
// files' absence invisible to anyone running npm test from the repo root
// with them already sitting there (#314).
const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const require = createRequire(import.meta.url);

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

  // claim-chart-element-classes (2026-08-28): every row carries its class, and
  // the coverage line tallies verdicts by class so two PRESENT bookends never
  // read as a partial hit on the mechanism.
  const CLASSED = '1. A method comprising:\nreceiving an input text;\nvalidating the input based on a parse tree having best-match elements;\noutputting the result.';
  it('tags every row preamble / generic / mechanism and returns the classes', () => {
    const { table, elements, classes } = buildChartTable(CLASSED);
    assert.equal(elements.length, 4);
    assert.deepEqual(classes, ['preamble', 'generic', 'mechanism', 'generic']);
    const rows = table.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    assert.match(rows[0], /_\[preamble\]_/);
    assert.match(rows[1], /_\[generic\]_/);
    assert.match(rows[2], /_\[mechanism\]_/);
    assert.match(rows[3], /_\[generic\]_/);
  });
  it('the coverage line adds a by-class tally when it is given the elements', () => {
    const { elements } = buildChartTable(CLASSED);
    const fills = [
      { element: 1, label: 'ABSENT' }, { element: 2, label: 'PRESENT' },
      { element: 3, label: 'PARTIAL' }, { element: 4, label: 'PRESENT' },
    ];
    const line = coverageLine(fills, 4, elements);
    assert.match(line, /\*\*Coverage:\*\* 2 PRESENT · 1 PARTIAL/);
    assert.match(line, /\*\*By element class:\*\* mechanism 1: 1 PARTIAL; generic 2: 2 PRESENT; preamble 1\./);
    assert.doesNotMatch(coverageLine(fills, 4), /By element class/, 'no elements, no class line');
  });

  // preamble-row-on-supplied-elements (2026-08-28): a supplied list keeps its
  // claim-number prefix, and the preamble must still be found through it.
  it('a supplied row 1 with its "1." prefix is the preamble, in the table and in the coverage line', () => {
    const supplied = ['1. A system comprising:', 'a receiver for receiving packets;', 'a scheduler configured to reorder the packets based on a deadline.'];
    const { table, classes } = buildChartTable('ignored', { elements: supplied });
    assert.equal(classes[0], 'preamble');
    assert.match(table.split('\n').find((l) => /^\| 1 \|/.test(l)), /_\[preamble\]_/);
    const line = coverageLine([{ element: 1, label: 'ABSENT' }, { element: 2, label: 'PRESENT' }, { element: 3, label: 'PARTIAL' }], 3, supplied);
    assert.match(line, /across 2 limitation\(s\); preamble ABSENT/);
    assert.match(line, /preamble 1\./);
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

// The merge is strongest-wins, so a row can be carried by ONE target over
// twenty-two dissents. The per-row agreement block has shown that since the
// tally landed; the headline discarded it. These lock the arithmetic that
// stopped discarding it -- and lock that it stays arithmetic: nothing here
// asserts a threshold, because no quorum rule survived measurement across
// three engines.
describe('coverage summary reports how well-supported its own counts are', () => {
  const agree = (label, mine, total) => ({
    label,
    agreement: { PRESENT: 0, PARTIAL: 0, ASSUMED: 0, ABSENT: 0, [label]: mine, total },
  });

  it('counts non-ABSENT rows resting on a single target, and names the weakest', () => {
    const line = coverageLine([
      agree('PARTIAL', 1, 23),
      agree('PARTIAL', 1, 25),
      agree('PRESENT', 1, 24),
      agree('ASSUMED', 1, 24),
      agree('PRESENT', 6, 24),
      agree('PARTIAL', 3, 24),
      agree('ASSUMED', 9, 24),
      agree('PRESENT', 2, 24),
      agree('ABSENT', 22, 23),
    ], 9);
    assert.match(
      line,
      /\*\*Support: 4 of 8 non-ABSENT row\(s\) rest on a single target; weakest 1 of 23\.\*\*/,
    );
  });

  it('excludes ABSENT rows from both the ratio and the weakest figure', () => {
    // Near-unanimity on ABSENT is the norm and carries no signal. Were ABSENT
    // counted, this would read "1 of 2 ... weakest 1 of 23" -- a chart of
    // unanimous ABSENTs would report perfect support and mean nothing by it.
    const line = coverageLine([agree('ABSENT', 1, 23), agree('PRESENT', 5, 23)], 2);
    assert.match(line, /Support: 0 of 1 non-ABSENT row\(s\)/);
    assert.match(line, /weakest 5 of 23/);
  });

  it('omits the clause entirely when there are no non-ABSENT rows', () => {
    const line = coverageLine([agree('ABSENT', 23, 23), agree('ABSENT', 22, 23)], 2);
    assert.ok(!line.includes('Support'), `no support clause on an all-ABSENT chart: ${line}`);
  });

  it('does not count the preamble row, which is not a limitation', () => {
    const elements = ['A distribution system comprising:', 'transmitting content data'];
    const line = coverageLine([agree('PRESENT', 1, 23), agree('PRESENT', 4, 23)], 2, elements);
    // Only the limitation is assessed; the lone preamble finding is not a row
    // the support ratio speaks for.
    assert.match(line, /Support: 0 of 1 non-ABSENT row\(s\)/);
    assert.match(line, /weakest 4 of 23/);
  });

  it('discloses rows whose support could not be computed rather than shrinking the denominator', () => {
    // Silently dropping them would report a ratio over a set the reader takes
    // to be every non-ABSENT row.
    const line = coverageLine([{ label: 'PRESENT' }, agree('PARTIAL', 2, 5)], 2);
    assert.match(line, /Support: 0 of 1 non-ABSENT row\(s\)/);
    assert.match(line, /1 further non-ABSENT row\(s\) carried no agreement data/);
  });

  it('says support was not computed when no row carries agreement data', () => {
    const line = coverageLine([{ label: 'PRESENT' }, { label: 'ABSENT' }], 2);
    assert.match(line, /Support not computed: 1 non-ABSENT row\(s\) carried no agreement data/);
  });

  it('leaves the label counts themselves untouched', () => {
    const line = coverageLine([agree('PRESENT', 1, 23), agree('ABSENT', 22, 23)], 5);
    assert.match(line, /1 PRESENT/);
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
    // The chart numbers from THIS, not from m.start (#306). A mock offering
    // only getFunctionSource would exercise a path production no longer takes.
    getFunctionSourceWithRange: (fp, n) => (n.includes('determineIdeal')
      ? { source: 'int determineIdealSelectedIndex() { return 0; }', start: 1, end: 1, prepended: 0 } : null),
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
    getFunctionSourceWithRange: () => ({ source: 'void one() { rate(); }', start: 1, end: 1, prepended: 0 }),
  };

  it('produces a chart with the merged finding in the row', async () => {
    // Must use the real `VERDICT n:` shape parseChartVerdicts expects. This
    // mock previously used a prose form that parsed to ZERO verdicts, and the
    // test still passed because a no-verdict target was pushed to perTarget
    // anyway — the exact defect drop accounting exists to expose.
    const analysis = [
      'VERDICT 1: ABSENT — no transmission side in this index.',
      'VERDICT 4: PRESENT — rate() computes it.',
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

describe('presentation is normalized away before matching (#306 Edit 6)', () => {
  const ELS = ['first element about transmitting', 'second about reproducing', 'third about rate'];

  // The exact table asus-CC measured. The first two already parsed; the last
  // three cost Devstral 73% of its analyses on the '101 chart — 16 of 22
  // targets returned 0/10 while their raw text held ten correct VERDICT lines.
  const FORMS = [
    ['plain', 'VERDICT 3: ABSENT | no line'],
    ['bold', '**VERDICT 3:** ABSENT | no line'],
    ['bullet', '- VERDICT 3: ABSENT | no line'],
    ['bullet + bold', '- **VERDICT 3:** ABSENT | no line'],
    ['indented bullet + bold', '  - **VERDICT 3:** ABSENT | no line'],
  ];

  for (const [name, line] of FORMS) {
    it(`parses the ${name} form identically`, () => {
      const v = parseChartVerdicts(line, ELS);
      assert.equal(v.length, 1, `${name} produced no verdict`);
      assert.deepEqual([v[0].element, v[0].label], [3, 'ABSENT']);
      assert.equal(v[0].note, 'no line');
    });
  }

  it('normalizes only leading decoration — emphasis inside the note is content', () => {
    // `__init__` and `**` in a citation are what the model is telling us about
    // the code, not how it is dressing the line up.
    const v = parseChartVerdicts('- **VERDICT 2:** PARTIAL | see `__init__` at L88', ELS);
    assert.deepEqual([v[0].element, v[0].label], [2, 'PARTIAL']);
    assert.match(v[0].note, /__init__/, 'note survived normalization intact');
  });

  it('leaves a single leading asterisk to the regex, not the bullet stripper', () => {
    // "*VERDICT" is emphasis; "* VERDICT" is a list item. The space decides.
    assert.equal(normalizeVerdictLine('*VERDICT 1: ABSENT'), '*VERDICT 1: ABSENT');
    assert.equal(normalizeVerdictLine('* VERDICT 1: ABSENT'), 'VERDICT 1: ABSENT');
  });

  it('collapses whitespace runs without touching the contract', () => {
    const v = parseChartVerdicts('VERDICT   1 :   PRESENT   |   spaced   out', ELS);
    assert.deepEqual([v[0].element, v[0].label], [1, 'PRESENT']);
    assert.equal(v[0].note, 'spaced out');
  });

  it('still returns nothing for a line that is genuinely not a verdict', () => {
    // Normalization must not manufacture verdicts out of prose — the whole
    // point is to distinguish "not parsed" from "not found", not to blur them.
    assert.equal(parseChartVerdicts('- the function is absent from this file', ELS).length, 0);
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
    // start 599 mirrors the callee's OWN recorded start — this suite exists to
    // check a callee is numbered from its own range, not the target's.
    getFunctionSourceWithRange: (fp, n) => (n.includes('helper')
      ? { source: 'int helper() {\n  return 1;\n}', start: 599, end: 601, prepended: 0 } : null),
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

// ---------------------------------------------------------------------------
// Target-list integrity. Curating targets is a legitimate operator action, so
// CE reports an edit rather than forbidding it — but a provenance block that
// keeps vouching for a run which produced a DIFFERENT list than the one under
// it just relocates the problem the block exists to solve.
// ---------------------------------------------------------------------------
describe('target-list integrity', () => {
  const fs = require('node:fs');
  const tmp = (name, body) => {
    const p = `${process.env.TEMP || '/tmp'}/${name}`;
    fs.writeFileSync(p, body, 'utf8');
    return `@${p}`;
  };
  const BLOCK = [
    '# Produced by CodeExam v0.5.0 --claim-locate --hunt --blind',
    '# Engine: Gemini API — gemini-2.5-flash (cloud LLM)',
    '# Targets-checksum: ',
  ];

  it('reports an unmodified list as unmodified', () => {
    const sum = targetsChecksum(['A.java@f', 'B.java@g']);
    const spec = tmp('ce_t_ok.txt',
      [...BLOCK.slice(0, 2), `# Targets-checksum: ${sum}`, 'A.java@f', 'B.java@g'].join('\n'));
    const r = parseTargets(spec);
    assert.equal(r.integrity, 'unmodified');
    assert.equal(r.provenance.length, 2, 'the checksum line is not prose');
  });

  it('reports an edited list as modified', () => {
    const sum = targetsChecksum(['A.java@f', 'B.java@g']);
    const spec = tmp('ce_t_bad.txt',
      [...BLOCK.slice(0, 2), `# Targets-checksum: ${sum}`, 'A.java@f', 'B.java@CHANGED'].join('\n'));
    assert.equal(parseTargets(spec).integrity, 'modified');
  });

  it('stays silent when no checksum was recorded', () => {
    // Legacy and hand-written targets files must not be accused of anything.
    const spec = tmp('ce_t_none.txt', ['# hand written', 'A.java@f'].join('\n'));
    assert.equal(parseTargets(spec).integrity, null);
  });

  it('surfaces a modified list in the header, unmissably', () => {
    const h = buildProvenanceHeader({
      claimText: '1. A thing.', indexPath: '.I', engineLabel: 'x', argv: 'y',
      targets: 2, targetSource: '`t.txt`', targetProvenance: ['produced by X'],
      targetIntegrity: 'modified', generatedAt: 'T', ceVersion: 'v0',
    });
    assert.match(h, /MODIFIED after generation/);
    assert.match(h, /not the one the recorded command produced/);
  });

  it('says so when the list is intact', () => {
    const h = buildProvenanceHeader({
      claimText: '1. A thing.', indexPath: '.I', engineLabel: 'x', argv: 'y',
      targets: 2, targetSource: '`t.txt`', targetProvenance: ['produced by X'],
      targetIntegrity: 'unmodified', generatedAt: 'T', ceVersion: 'v0',
    });
    assert.match(h, /unmodified since generation/);
  });
});

// ---------------------------------------------------------------------------
// The chart must never under-report its own inputs. A target the model never
// saw changes what the verdicts and the agreement counts mean. (#305 Part A.)
// ---------------------------------------------------------------------------
describe('dropped-target reporting', () => {
  const base = {
    claimText: '1. A thing.', indexPath: '.I', engineLabel: 'x', argv: 'y',
    targets: 2, targetSource: '`t.txt`', targetProvenance: ['produced by X'],
    generatedAt: 'T', ceVersion: 'v0',
  };

  it('names targets that could not be resolved, in the chart itself', () => {
    // Before this the warning went to stderr only, so an element whose evidence
    // was dropped by mechanism rendered ABSENT — indistinguishable from an
    // element the codebase genuinely does not satisfy.
    const h = buildProvenanceHeader({ ...base,
      targetUnresolved: ['`Foo.java@nope` (no such symbol)'] });
    assert.match(h, /could not be resolved/);
    assert.match(h, /NOT analysed/);
    assert.match(h, /Foo\.java@nope/);
  });

  it('reconciles supplied vs analysed when targets produced no verdict', () => {
    // The live failure: header said "37 analysed" while every agreement count
    // read "of 30", with nothing on the page explaining the other 7.
    const h = buildProvenanceHeader({ ...base, targets: 30, targetsSupplied: 37 });
    assert.match(h, /37 supplied · 30 analysed · 7 produced no verdict/);
  });

  it('stays quiet when every supplied target was analysed', () => {
    const h = buildProvenanceHeader({ ...base, targets: 37, targetsSupplied: 37 });
    assert.match(h, /37 analysed/);
    assert.ok(!/supplied/.test(h), 'a clean run reads as it always did');
  });

  it('names targets that parsed only some elements', () => {
    const h = buildProvenanceHeader({ ...base, targetsPartial: ['`A.java@one` (2/6)'] });
    assert.match(h, /verdicts for only some/);
    assert.match(h, /A\.java@one/);
  });

  it('lists each dropped target with its reason, and only when there are any', () => {
    const withDrops = formatChart({
      claimText: '1. A thing.', table: '| # |\n|---|', fills: [], elements: ['a'],
      engineLabel: 'x', targets: ['A.java@kept'],
      dropped: [{ target: 'DefaultLoadControl.java@shouldStartPlayback',
        reason: 'no verdicts parsed from the engine response' }],
    });
    assert.match(withDrops, /Targets that produced no finding \(1 of 2\)/);
    assert.match(withDrops, /shouldStartPlayback/);
    assert.match(withDrops, /no verdicts parsed/);
    assert.match(withDrops, /excluded from every agreement count/);

    const clean = formatChart({
      claimText: '1. A thing.', table: '| # |\n|---|', fills: [], elements: ['a'],
      engineLabel: 'x', targets: ['A.java@kept'], dropped: [],
    });
    assert.ok(!/produced no finding/.test(clean), 'a clean run emits no drop section');
  });

  it('reports collapsed duplicates', () => {
    const h = buildProvenanceHeader({ ...base, targetDuplicates: 2 });
    assert.match(h, /2 duplicate\(s\) collapsed/);
  });

  it('names a dropped class target and why', () => {
    const h = buildProvenanceHeader({ ...base,
      targetContainers: ['A.java@A'] });
    assert.match(h, /class target\(s\) dropped in favour of their own methods/);
    assert.match(h, /A\.java@A/);
  });

  it('surfaces ambiguous targets, since the chart silently picks one', () => {
    const h = buildProvenanceHeader({ ...base,
      targetAmbiguous: ['`A.java@run` (2 symbols match; used a/A.java)'] });
    assert.match(h, /ambiguous target\(s\) — first match used/);
  });

  it('says nothing when nothing was dropped', () => {
    const h = buildProvenanceHeader({ ...base,
      targetDuplicates: 0, targetContainers: [], targetUnresolved: [], targetAmbiguous: [] });
    assert.ok(!/collapsed|dropped|could not be resolved|ambiguous/.test(h),
      'a clean run gets no noise');
  });

  it('dedups on the consumption side too, for hand-written files', () => {
    const fs2 = require('node:fs');
    const p = `${process.env.TEMP || '/tmp'}/ce_t_dupes.txt`;
    fs2.writeFileSync(p, ['A.java@Cls::m', 'A.java@m', 'B.java@n'].join('\n'), 'utf8');
    const r = parseTargets(`@${p}`);
    assert.equal(r.targets.length, 2, 'cross-form duplicate collapsed');
    assert.equal(r.duplicates, 1);
  });
});

// ===========================================================================
// claim-chart-limitation-granularity — supplied elements + per-element evidence
// ===========================================================================

// A supplied list is the escape hatch from heuristic splitting: no regex
// reaches a practitioner's construction of a claim, and letting the MODEL pick
// rows would make two engines' charts undiffable.
describe('--elements supplies the row skeleton', () => {
  it('uses the supplied list verbatim — N lines in, N rows out, in order', () => {
    const supplied = ['first limitation here', 'second limitation here', 'third one'];
    const { table, elements } = buildChartTable(CLAIM, { elements: supplied });
    assert.deepEqual(elements, supplied);
    const rows = table.split('\n').filter((l) => /^\| \d+ \|/.test(l));
    assert.equal(rows.length, 3);
    // The element text is verbatim; the class tag that follows it is CE's
    // (claim-chart-element-classes), not the practitioner's.
    assert.match(rows[0], /^\| 1 \| first limitation here _\[(?:generic|mechanism|preamble)\]_ \|/);
    assert.match(rows[2], /^\| 3 \| third one _\[(?:generic|mechanism|preamble)\]_ \|/);
  });

  it('falls back to CE splitting when no list is supplied or it is empty', () => {
    const fromClaim = buildChartTable(CLAIM).elements;
    assert.deepEqual(buildChartTable(CLAIM, {}).elements, fromClaim);
    assert.deepEqual(buildChartTable(CLAIM, { elements: [] }).elements, fromClaim);
  });

  it('records the skeleton source, so two charts can be compared honestly', () => {
    const hdr = buildProvenanceHeader({
      claimText: CLAIM, indexPath: '.X', engineLabel: 'claude', targets: 1,
      elementsSource: '`rms_elements.txt` — 12 supplied verbatim, not split by CE',
      elementComments: ['split by RMS 2026-08-11'],
    });
    assert.match(hdr, /\*\*Elements:\*\* `rms_elements\.txt`/);
    assert.match(hdr, /split by RMS 2026-08-11/);
  });

  it('omits the Elements row entirely when nothing was recorded', () => {
    const hdr = buildProvenanceHeader({
      claimText: CLAIM, indexPath: '.X', engineLabel: 'claude', targets: 1,
    });
    assert.ok(!hdr.includes('**Elements:**'));
  });
});

// Every target is a model call, so 10 elements x 25 candidates cannot become a
// target list. Round-robin is what keeps the budget from being eaten by the
// first few elements.
describe('perElementTargets', () => {
  const sym = (n, f) => ({ sym: { name: n, filepath: `idx!src/${f}` } });
  const PER = [
    { element: 1, hits: [sym('A::one', 'A.java'), sym('A::two', 'A.java'), sym('A::three', 'A.java')] },
    { element: 2, hits: [sym('B::one', 'B.java'), sym('B::two', 'B.java')] },
    { element: 3, hits: [] },
  ];

  it('gives every element its best candidate before any element gets a second', () => {
    const t = perElementTargets(PER, { targetsPerElement: 3, maxRetrievedTargets: 10 });
    assert.deepEqual(t.slice(0, 2), ['A.java@A::one', 'B.java@B::one'],
      'rank-1 of each element comes first');
    assert.deepEqual(t.slice(2, 4), ['A.java@A::two', 'B.java@B::two']);
  });

  it('a starved element cannot be crowded out by a rich one', () => {
    const t = perElementTargets(PER, { targetsPerElement: 3, maxRetrievedTargets: 2 });
    assert.ok(t.includes('B.java@B::one'),
      'element 2 must be represented even at a budget of 2');
  });

  it('honours the per-element cap and the total cap', () => {
    assert.equal(perElementTargets(PER, { targetsPerElement: 1, maxRetrievedTargets: 10 }).length, 2);
    assert.equal(perElementTargets(PER, { targetsPerElement: 3, maxRetrievedTargets: 3 }).length, 3);
  });

  it('emits basename@symbol specs and never duplicates one', () => {
    const dup = [{ element: 1, hits: [sym('A::one', 'A.java')] }, { element: 2, hits: [sym('A::one', 'A.java')] }];
    assert.deepEqual(perElementTargets(dup), ['A.java@A::one']);
  });

  it('survives an index that produced nothing at all', () => {
    assert.deepEqual(perElementTargets([{ element: 1, hits: [] }]), []);
    assert.deepEqual(perElementTargets([]), []);
  });
});

// THE KNOB HAD NEVER TAKEN EFFECT ON A REAL CLAIM. With an independent
// maxRetrievedTargets of 12, achieved depth was 12/elements — 1.3 on a
// median-length claim of 9 — so `targetsPerElement: 3` was unreachable above 4
// limitations, while the provenance line advertised "at most 3" on every chart.
// asus-CC found it on the '101 run: the crux sits at rank 3 of element 6.
// asus-CC (#306): the header records engine and model but NOT the
// node-llama-cpp version or the llama.cpp build, "and those decide the
// numerics". Bit-determinism under greedy decoding is the local path's headline
// asymmetry against cloud engines — and a reader who wanted to REPRODUCE a
// local chart had no way to learn which engine build to install.
// THE INVARIANT THE CODE ALREADY DEMANDED AND NOTHING CHECKED.
//
// claim-chart's own comment: "File-ABSOLUTE line numbers… Every chart citation
// must survive `ce --extract file@fn`." It was broken by its own base.
// getFunctionSource prepends the preceding doc comment; numbering from m.start
// (the signature) labelled the comment's first line as the signature and shifted
// every line below it — median 6, max 25, per-function (#306).
//
// The two audits that existed could not see it: a containment check validates
// shifted refs against the shifted range and passes, and `--extract` prints
// source UNNUMBERED. So the check has to be against the FILE ON DISK.
describe('rendered line numbers agree with the file on disk (#306)', () => {
  const INDEX = '.demo_code_only';
  const have = fs.existsSync(INDEX);

  it('a prepended doc comment does not shift the numbering', { skip: !have }, async () => {
    const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
    const idx = new CodeSearchIndex({ indexPath: INDEX });
    idx._ensureFunctionIndex();

    let checked = 0, withComment = 0;
    for (const [fp, fns] of Object.entries(idx.functionIndex)) {
      const disk = fs.existsSync(fp) ? fp : ['samples/tls_demo/' + fp].find((p) => fs.existsSync(p));
      if (!disk) continue;
      const lines = fs.readFileSync(disk, 'utf8').split('\n');
      for (const name of Object.keys(fns)) {
        const _l = console.log; console.log = () => {};
        const got = idx.getFunctionSourceWithRange(fp, name);
        console.log = _l;
        if (!got) continue;
        if (got.prepended > 0) withComment++;
        const rendered = addLineNumbers(got.source, got.start).split('\n');
        // Every rendered label must name the file line whose text it carries.
        for (let i = 0; i < rendered.length; i++) {
          const m = rendered[i].match(/^\s*(\d+) \| (.*)$/);
          if (!m) continue;
          const label = Number(m[1]);
          assert.equal(m[2], lines[label - 1],
            `${fp}@${name}: rendered line ${label} does not match file line ${label}`);
        }
        checked++;
      }
    }
    assert.ok(checked > 0, 'the fixture index must actually have been read');
    // Without this the test could pass vacuously on an index of undocumented
    // functions, where the shift is zero and there is nothing to get wrong.
    assert.ok(withComment > 0, `no function had a prepended comment — nothing was proved (checked ${checked})`);
  });

  it('reports what it prepended, so the caller is not guessing', { skip: !have }, async () => {
    const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
    const idx = new CodeSearchIndex({ indexPath: INDEX });
    idx._ensureFunctionIndex();
    const fp = Object.keys(idx.functionIndex).find((f) => f.endsWith('cert_verify.c'));
    const _l = console.log; console.log = () => {};
    const got = idx.getFunctionSourceWithRange(fp, 'verify_certificate_chain');
    console.log = _l;
    const rec = idx.functionIndex[fp].verify_certificate_chain;
    assert.equal(got.start, rec.start - got.prepended, 'start walks back by exactly the prepended block');
    assert.ok(got.prepended > 0, 'this function is documented; the block is real');
    assert.equal(got.source.split('\n').length, got.end - got.start + 1, 'the range describes the text');
  });

  it('getFunctionSource still returns a bare string for its other callers', { skip: !have }, async () => {
    const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
    const idx = new CodeSearchIndex({ indexPath: INDEX });
    idx._ensureFunctionIndex();
    const fp = Object.keys(idx.functionIndex).find((f) => f.endsWith('cert_verify.c'));
    const _l = console.log; console.log = () => {};
    const s = idx.getFunctionSource(fp, 'verify_certificate_chain');
    console.log = _l;
    assert.equal(typeof s, 'string', '~22 callers depend on this shape');
    assert.equal(idx.getFunctionSource(fp, 'no_such_function_xyz'), null);
  });
});

describe('the chart records the inference-engine build (#306)', () => {
  const base = () => ({
    claimText: CLAIM, indexPath: '.idx', engineLabel: 'local GGUF — g.gguf (local LLM, no network egress)',
    argv: 'ce --claim-chart x', targets: 3, targetSource: 'the --targets argument',
  });

  it('carries the build on its own line, below Engine', () => {
    const h = buildProvenanceHeader({ ...base(), engineBuild: 'node-llama-cpp 3.18.1 · llama.cpp b8390 · prebuilt · cuda' });
    assert.match(h, /\*\*Engine build:\*\* node-llama-cpp 3\.18\.1 · llama\.cpp b8390/);
    // Separate from Engine on purpose: that line carries the air-gap statement
    // and is quoted as such, so build metadata must not dilute it.
    assert.ok(h.indexOf('**Engine:**') < h.indexOf('**Engine build:**'));
    assert.match(h, /\*\*Engine:\*\* local GGUF — g\.gguf \(local LLM, no network egress\)/);
  });

  it('emits NO build line for a cloud run', () => {
    // A field that is empty on every cloud chart is noise, not provenance.
    const h = buildProvenanceHeader({ ...base(), engineLabel: 'Anthropic — claude-opus-5 (cloud LLM)', engineBuild: null });
    assert.ok(!h.includes('Engine build:'));
  });

  it('renders an honest blank rather than omitting or inventing', () => {
    // The silent omission IS the defect. A confident-looking guess would be
    // worse than either, so unknown parts have to say the word "unknown".
    const h = buildProvenanceHeader({ ...base(), engineBuild: 'node-llama-cpp 3.18.1 · llama.cpp build unknown · prebuilt · CPU' });
    assert.match(h, /llama\.cpp build unknown/);
  });
});

describe('engineBuildLine names what ran, and where', () => {
  it('is null when no local model was loaded — cloud runs add nothing', () => {
    // Nothing in this suite loads a GGUF, so the un-captured state is the one
    // under test here, and it must be the quiet one.
    assert.equal(engineBuildLine(), null);
    assert.equal(getEngineBuild(), null);
  });

  it('renders the full build', () => {
    // Field names live-probed against node-llama-cpp 3.18.1: getModuleVersion()
    // -> "3.18.1", llama.llamaCppRelease -> {repo, release:"b8390"},
    // llama.buildType -> "prebuilt", llama.gpu -> false | "cuda" | "metal".
    assert.equal(
      formatEngineBuild({ moduleVersion: '3.18.1', llamaCppRelease: 'b8390', buildType: 'prebuilt', gpu: 'cuda' }),
      'node-llama-cpp 3.18.1 · llama.cpp b8390 · prebuilt · cuda');
  });

  it('says "unknown" for each part it could not learn, and still renders', () => {
    // The header must never be taken down by its own provenance, and a missing
    // part must be visible as missing rather than absent from the line.
    assert.equal(formatEngineBuild({}),
      'node-llama-cpp version unknown · llama.cpp build unknown · build type unknown · device unknown');
    assert.match(formatEngineBuild({ moduleVersion: '3.18.1' }), /llama\.cpp build unknown/);
  });

  it('records CPU distinctly, because a silent GPU fallback changes the numerics', () => {
    // llama.gpu is boolean false for CPU, which would render as "device
    // unknown" under a plain falsy check. It is not unknown — it is known, and
    // it is the case that matters: two concurrent CE processes race on VRAM
    // probing and BOTH land on CPU (#316), with nothing in the artifact to show
    // for it. Capture happens on every load attempt so the fallback is what
    // gets recorded, not the intent.
    assert.match(formatEngineBuild({ moduleVersion: '3.18.1', gpu: 'CPU' }), /· CPU$/);
    assert.ok(!formatEngineBuild({ gpu: 'CPU' }).includes('device unknown'));
  });
});

describe('the target budget is DERIVED, and reports what it achieved (#306 Edit 5)', () => {
  const sym = (n, f) => ({ sym: { name: n, filepath: `idx!src/${f}` } });
  // Nine elements, three deep — a median-length claim with evidence to spare.
  const NINE = Array.from({ length: 9 }, (_, i) => ({
    element: i + 1,
    hits: [sym(`E${i}::a`, `E${i}.java`), sym(`E${i}::b`, `E${i}.java`), sym(`E${i}::c`, `E${i}.java`)],
  }));

  it('reaches depth 3 on a nine-element claim at defaults — the case that never worked', () => {
    const r = perElementTargetsWithStats(NINE, {});
    assert.equal(r.achievedDepth, 3, 'the documented depth is now the achieved depth');
    assert.equal(r.targets.length, 27, '9 elements x depth 3');
    assert.equal(r.budgetLimited, false);
  });

  it('derives the total from targetsPerElement x elements, not a constant', () => {
    assert.equal(resolveTargetBudget(9, { targetsPerElement: 2 }).total, 18);
    assert.equal(resolveTargetBudget(4, { targetsPerElement: 3 }).total, 12);
  });

  it('says BUDGET-LIMITED and names the depth it could not reach', () => {
    const r = perElementTargetsWithStats(NINE, { maxRetrievedTargets: 12 });
    assert.equal(r.budgetLimited, true);
    assert.equal(r.requestedDepth, 3);
    assert.equal(r.achievedDepth, 1, 'rank 0 completed; rank 1 hit the ceiling mid-way');
    assert.equal(r.wanted, 27, 'reports what it wanted, so the user can size the raise');
  });

  it('distinguishes a thin index from a binding budget', () => {
    // Both produce a short list. Only one is fixed by raising the ceiling, and
    // telling a user to raise a ceiling that was never the constraint wastes
    // an hour of model time to reproduce the same chart.
    const thin = perElementTargetsWithStats(
      [{ element: 1, hits: [sym('A::one', 'A.java')] }], { targetsPerElement: 3 });
    assert.equal(thin.budgetLimited, false);
    assert.equal(thin.candidatesExhausted, true);
    // And the depth must not be VACUOUSLY 3. All three ranks "complete" over a
    // one-candidate index without finding anything, which would put "depth 3
    // achieved" on a chart built from a single target — a depth claim with no
    // retrieval behind it, which is the defect this whole item is about.
    assert.equal(thin.achievedDepth, 1, 'depth is bounded by what the index yielded');
  });

  it('--max-retrieved-targets 12 reproduces the OLD list exactly', () => {
    // Every chart already sent to RMS must stay reproducible, including the
    // '101 charts. This is the compatibility contract for the whole change.
    const old = ['A.java@A::one', 'B.java@B::one', 'A.java@A::two', 'B.java@B::two',
      'A.java@A::three'];
    const PER = [
      { element: 1, hits: [sym('A::one', 'A.java'), sym('A::two', 'A.java'), sym('A::three', 'A.java')] },
      { element: 2, hits: [sym('B::one', 'B.java'), sym('B::two', 'B.java')] },
      { element: 3, hits: [] },
    ];
    assert.deepEqual(perElementTargets(PER, { targetsPerElement: 3, maxRetrievedTargets: 12 }), old);
  });

  it('keeps round-robin order — no element loses its rank-0 slot to a raise', () => {
    const r = perElementTargetsWithStats(NINE, {});
    assert.deepEqual(r.targets.slice(0, 9), NINE.map((_, i) => `E${i}.java@E${i}::a`),
      'every element contributes rank 0 before any element contributes rank 1');
  });

  it('accepts the snake_case STRING values argparse actually produces', () => {
    // perElementTargets is called with `args` straight from argparse, which
    // emits targets_per_element as a STRING. Two ways this silently reverts to
    // the defect being repaired: camelCase-only lookup, or arithmetic on "2".
    // Asserting with numbers here would pass while the CLI stayed inert.
    const r = perElementTargetsWithStats(NINE, { targets_per_element: '2', max_retrieved_targets: '18' });
    assert.equal(r.achievedDepth, 2);
    assert.equal(r.targets.length, 18, '"2" x 9 must be 18, not "2" repeated or NaN');
    assert.equal(r.budgetLimited, false);
    assert.equal(resolveTargetBudget(9, { targets_per_element: '3' }).total, 27);
  });
});

// THE DISTINCTION THIS EXISTS FOR: "CE examined this element and found nothing"
// and "CE had nothing to examine" render identically without it, and only the
// first is defensible in front of a client.
describe('per-element retrieval provenance on the artifact', () => {
  const base = () => {
    const { table, elements } = buildChartTable(CLAIM);
    return { claimText: CLAIM, table, elements, targets: ['A.java@one'], engineLabel: 'claude', fills: [] };
  };
  const RET = [
    { element: 1, words: ['store', 'chunk'], hits: [{}, {}] },
    { element: 2, words: ['bitrate'], hits: [] },
  ];

  it('reports each element\'s predicted words and candidate count', () => {
    const out = formatChart({ ...base(), retrieval: RET });
    assert.match(out, /## Retrieval by element/);
    assert.match(out, /\| 1 \| store, chunk \| 2 \|/);
    assert.match(out, /\| 2 \| bitrate \| 0 \|/);
  });

  it('flags elements that were never examined', () => {
    const out = formatChart({ ...base(), retrieval: RET });
    assert.match(out, /1 of 2 element\(s\) produced no candidate: 2/);
    assert.match(out, /not a finding about the code/);
  });

  it('says nothing when targets were supplied — that path is unchanged', () => {
    const out = formatChart({ ...base() });
    assert.ok(!out.includes('## Retrieval by element'));
  });

  it('adds no warning when every element was covered', () => {
    const out = formatChart({ ...base(), retrieval: [{ element: 1, words: ['a'], hits: [{}] }] });
    assert.match(out, /## Retrieval by element/);
    assert.ok(!out.includes('produced no candidate'));
  });
});

// `#` provenance reaching a CHART's left-hand column. Same defect cbb8e98 fixed
// for --claim-analyze; worse here, because the obvious guard does not catch it.
describe('claim-chart: # provenance is not a limitation', () => {
  const SYN = fixture('sample_patent_claim_synon_gemini_2.txt');   // real --synonymize-out file

  it('THE COUNT IS NOT THE TEST — the broken case also yields 11', () => {
    // Measured 2026-08-16: read raw, the ten header lines and the real preamble
    // collapse into ROW 1 TOGETHER, because the marker path merges unmarked
    // lines into the preceding group and the preamble is unmarked. The element
    // count stays correct while row 1 becomes provenance text and the preamble
    // stops being a row at all. Asserting on the count would pass either way.
    const raw = fs.readFileSync(SYN, 'utf-8');
    const broken = splitClaimElements(raw);
    assert.equal(broken.length, 11, 'the BROKEN reading also gives 11 — hence this test');
    assert.match(broken[0], /^#\s*Synonymized claim/, 'and row 1 is the header');
    assert.match(broken[0], /A method of effectuating/,
      'with the real preamble buried inside it');
  });

  it('stripping comments puts the preamble back as row 1', () => {
    const text = readClaimFile(SYN);
    const els = splitClaimElements(text);
    assert.equal(els.length, 11);
    assert.match(els[0], /^A method of effectuating a protected informational/);
    assert.ok(!/^#/.test(els[0]), 'row 1 must not be a comment');
  });

  it('no provenance reaches ANY row — it would print in the chart LHC', () => {
    // A chart whose first limitation announces the claim is fabricated does not
    // merely retrieve badly; it destroys the artifact.
    const els = splitClaimElements(readClaimFile(SYN));
    const all = els.join(' ');
    for (const leak of [/Synonymized claim/, /Gemini API/, /content-word survival/,
                        /NOT a patent claim/, /Re-split/, /--synonymize/]) {
      assert.ok(!leak.test(all), `provenance leaked into a chart row: ${leak}`);
    }
  });

  it('a comment-free claim file is byte-identical, on this path too', () => {
    const raw = fs.readFileSync(fixture('sample_patent_claim.txt'), 'utf-8');
    assert.equal(readClaimFile(fixture('sample_patent_claim.txt')), raw.trim());
  });
});

// THE LABELS MEAN "IS THE LIMITATION MET", NOT "DOES THE FEATURE APPEAR".
// Andrew's ruling, 2026-08-22: "if a claim limitation calls for X to be absent,
// then if X is present, the claim limitation is NOT met."
describe('verdict semantics reach the artifact, not just the prompt', () => {
  const NEG = '1. A method comprising: transferring funds in the absence of information about any account of the second party.';

  it('the prompt states what a verdict answers, and tags the row', () => {
    const els = splitClaimElements(NEG);
    const p = buildChartAnalysisPrompt('code', 'fn', 'f.c', NEG, els);
    assert.match(p, /is this claim limitation MET by this code\?/i);
    // The prompt is hard-wrapped, so assert on a fragment that cannot straddle
    // a line break — matching across the wrap makes the test brittle against
    // rewording that changes nothing.
    assert.match(p, /limitation is NOT met and the verdict is ABSENT/);
    assert.match(p, /NEGATIVE — met when the recited feature is ABSENT/);
  });

  it('the CHART carries the definition too — a reader-side legend, not only a prompt', () => {
    // A definition the model is told and the reader is not leaves the
    // misreading exactly where it was.
    const { table, elements } = buildChartTable(NEG);
    const out = formatChart({ claimText: NEG, table, elements, fills: [], targets: [], engineLabel: 'x' });
    assert.match(out, /describe whether the CLAIM\nLIMITATION is met/);
    assert.match(out, /not whether the recited feature appears/);
  });

  it('names the column as a question, since the header sets the reading', () => {
    const { table } = buildChartTable(NEG);
    assert.match(table, /CE finding — is the limitation met\?/);
  });

  it('glosses negative rows, because the word inverts exactly there', () => {
    const { table, elements } = buildChartTable(NEG);
    const out = formatChart({ claimText: NEG, table, elements, fills: [], targets: [], engineLabel: 'x' });
    assert.match(out, /\*\*Negative limitations in this claim\*\*/);
    assert.match(out, /ABSENT means the limitation is\nNOT met/);
    assert.match(out, /cue: `in the absence of`/);
  });

  it('says NOTHING on a claim with no such construction — no tax on the other 81%', () => {
    const { table, elements } = buildChartTable(CLAIM);
    const out = formatChart({ claimText: CLAIM, table, elements, fills: [], targets: [], engineLabel: 'x' });
    assert.ok(!out.includes('Negative limitations in this claim'));
    const p = buildChartAnalysisPrompt('code', 'fn', 'f.c', CLAIM, elements);
    assert.ok(!/NEGATIVE —/.test(p) && !/CHOICE —/.test(p), 'untagged claims get no tags');
  });
});

// THE READ-BACK HALF. Metadata nothing consumes is documentation, not a fix:
// the stated purpose is closing the locate->chart loop, so the chart has to
// render the same `Retrieval by element` table it renders when it retrieved for
// itself.
describe('a locate file restores the retrieval table to the chart', () => {
  const TMP = fileURLToPath(new URL('./.tmp-targets-attrib.txt', import.meta.url));
  const FILE = [
    '# Produced by CodeExam v0.5.0 --claim-locate --per-element-select',
    '# Attribution: per-element retrieval, 2 element(s)',
    '',
    '# Element 4: selecting a cipher suite from a set of supported cipher suites',
    '# Element-words: select, suite, supported',
    '# Element-candidates: 8',
    'CipherNegotiator.java@CipherNegotiator::selectCipherSuites',
    'ConnectionConfig.java@ConnectionConfig::getMinKeyBits',
    '',
    '# Element 10: transmitting application data over an encrypted channel',
    '# Element-words: transmit, send, encrypt',
    '# Element-candidates: 25',
    'tls.c@tls_send_encrypted',
    '',
  ].join('\n');

  it('parses attribution into the shape the renderer already consumes', (t) => {
    t.after(() => { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); });
    fs.writeFileSync(TMP, FILE);
    const r = parseTargets(`@${TMP}`);
    assert.equal(r.targets.length, 3);
    assert.equal(r.retrieval.length, 2);
    assert.deepEqual(r.retrieval[0].words, ['select', 'suite', 'supported']);
    // `hits` is a length-only stand-in — the table reports the COUNT, and the
    // file records the count rather than the candidates themselves.
    assert.equal(r.retrieval[0].hits.length, 8);
    assert.equal(r.retrieval[1].hits.length, 25);
  });

  it('renders the same table the self-retrieval path renders', (t) => {
    t.after(() => { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); });
    fs.writeFileSync(TMP, FILE);
    const { retrieval, targets } = parseTargets(`@${TMP}`);
    // The table lives in formatChart, not the provenance header.
    const { table, elements } = buildChartTable(CLAIM);
    const h = formatChart({ claimText: CLAIM, table, elements, fills: [], targets,
      engineLabel: 'x', retrieval });
    assert.match(h, /## Retrieval by element/);
    assert.match(h, /\| 4 \| select, suite, supported \| 8 \|/);
    assert.match(h, /\| 10 \| transmit, send, encrypt \| 25 \|/);
  });

  it('the element markers do NOT leak into provenance prose', (t) => {
    t.after(() => { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); });
    fs.writeFileSync(TMP, FILE);
    const r = parseTargets(`@${TMP}`);
    assert.ok(!r.provenance.some((l) => /^Element[ -]/i.test(l)),
      'recognised markers are structure, not prose');
    assert.ok(r.provenance.some((l) => /Produced by CodeExam/.test(l)), 'real provenance still carried');
  });

  it('an OLD file with no markers parses exactly as before', (t) => {
    t.after(() => { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); });
    fs.writeFileSync(TMP, '# hand-written\na.java@one\nb.java@two\n');
    const r = parseTargets(`@${TMP}`);
    assert.deepEqual(r.targets, ['a.java@one', 'b.java@two']);
    assert.equal(r.retrieval, null, 'no attribution means no table, not an empty one');
    assert.deepEqual(r.provenance, ['hand-written']);
  });

  it('the checksum is over TARGETS — comments cannot move it', (t) => {
    t.after(() => { if (fs.existsSync(TMP)) fs.unlinkSync(TMP); });
    const bare = ['CipherNegotiator.java@CipherNegotiator::selectCipherSuites',
      'ConnectionConfig.java@ConnectionConfig::getMinKeyBits', 'tls.c@tls_send_encrypted'];
    fs.writeFileSync(TMP, FILE);
    const withAttrib = parseTargets(`@${TMP}`).targets;
    fs.writeFileSync(TMP, bare.join('\n'));
    assert.equal(targetsChecksum(withAttrib), targetsChecksum(parseTargets(`@${TMP}`).targets),
      'adding attribution must not invalidate a checksum already issued');
  });
});

// THE FILE HALF OF A TARGET WAS PARSED OFF AND NEVER USED (#309 Part A).
// Measured on .AndroidX_Media_ExoPlayer3: asked for
// AdaptiveTrackSelection.java@updateSelectedTrack, analysed
// DownloadHelper::DownloadTrackSelection::updateSelectedTrack — a different
// class in offline/, with 0 callee bodies. The delivered '101 chart cited the
// download-path implementation on every updateSelectedTrack row.
describe('a file hint selects the symbol, it does not merely decorate it', () => {
  const M = [
    { name: 'AdaptiveTrackSelection::updateSelectedTrack', filepath: 'x!src/trackselection/AdaptiveTrackSelection.java' },
    { name: 'DownloadHelper::DownloadTrackSelection::updateSelectedTrack', filepath: 'x!src/offline/DownloadHelper.java' },
  ];

  it('picks the hinted file out of same-named symbols', () => {
    const r = filterMatchesByFile(M, 'AdaptiveTrackSelection.java');
    assert.equal(r.length, 1);
    assert.match(r[0].filepath, /trackselection/);
  });

  it('the hint SELECTS — the other file still resolves to its own symbol', () => {
    // If the hint merely reordered, both targets would land on the same match.
    const r = filterMatchesByFile(M, 'DownloadHelper.java');
    assert.equal(r.length, 1);
    assert.match(r[0].filepath, /offline/);
  });

  it('matches on SUFFIX, so a longer path works too', () => {
    // The measured failure had the user try both forms; both must work.
    assert.equal(filterMatchesByFile(M, 'trackselection/AdaptiveTrackSelection.java').length, 1);
    assert.equal(filterMatchesByFile(M, 'src/trackselection/AdaptiveTrackSelection.java').length, 1);
    assert.equal(filterMatchesByFile(M, './AdaptiveTrackSelection.java').length, 1);
  });

  it('is boundary-anchored — Helper.java must not match DownloadHelper.java', () => {
    // A bare endsWith would make the hint quietly wrong in the same direction
    // as the bug it is fixing.
    assert.equal(filterMatchesByFile(M, 'Helper.java').length, 0);
    assert.equal(filterMatchesByFile(M, 'ackselection/AdaptiveTrackSelection.java').length, 0);
  });

  it('tolerates backslashes and the index archive segment', () => {
    assert.equal(filterMatchesByFile(M, 'trackselection\\AdaptiveTrackSelection.java').length, 1);
    assert.equal(filterMatchesByFile([{ name: 'f', filepath: 'a.zip!deep/b/C.java' }], 'b/C.java').length, 1);
  });

  it('a hint matching NOTHING returns nothing — no silent substitution', () => {
    // Falling back to a same-named symbol elsewhere is the defect itself. The
    // caller turns this into a loud NOT FOUND naming the hint.
    assert.deepEqual(filterMatchesByFile(M, 'NoSuchFile.java'), []);
  });

  it('no hint leaves the match set untouched', () => {
    // A bare Class::method target must behave exactly as before — requiring the
    // prefix would reject the form users most naturally type.
    assert.deepEqual(filterMatchesByFile(M, ''), M);
    assert.deepEqual(filterMatchesByFile(M, undefined), M);
  });
});

// THE FIELD DESIGNED TO SAY "I DO NOT KNOW" COULD NOT FIRE.
//
// getModuleVersion is async in node-llama-cpp 3.18.1. Called synchronously it
// returned a Promise — truthy, so it survived `|| null` and stringified into
// the Daubert-facing line as `node-llama-cpp [object Promise]` (asus-CC, #315,
// on a live chart).
//
// formatEngineBuild was split out as a pure function precisely so every
// partial-knowledge case could be asserted without a model, and those
// assertions passed. They covered ABSENT values. A Promise is not absent; it is
// a truthy non-string. The tests checked for missing inputs and never for
// wrong-typed ones.
describe('a captured build field is a string or it is unknown (#315)', () => {
  it('a Promise renders as unknown, not as [object Promise]', () => {
    const s = formatEngineBuild({ moduleVersion: Promise.resolve('3.18.1'),
      llamaCppRelease: 'b8390', buildType: 'prebuilt', gpu: 'cuda' });
    assert.ok(!s.includes('[object Promise]'), 'the exact string that shipped');
    assert.match(s, /node-llama-cpp version unknown/);
    assert.match(s, /llama\.cpp b8390 · prebuilt · cuda/, 'the other three were always correct');
  });

  it('rejects every other truthy non-string the same way', () => {
    // A thenable, an object, a number, an array. Each is truthy and each would
    // have rendered its own garbage into a legal artifact.
    for (const v of [{ then() {} }, { version: '3.18.1' }, 3.18, ['3.18.1'], true]) {
      assert.match(formatEngineBuild({ moduleVersion: v }), /version unknown/,
        `truthy non-string must not render: ${Object.prototype.toString.call(v)}`);
    }
  });

  it('an empty or whitespace string is unknown too', () => {
    assert.match(formatEngineBuild({ moduleVersion: '   ' }), /version unknown/);
    assert.match(formatEngineBuild({ moduleVersion: '' }), /version unknown/);
  });

  it('a real string still renders, and is trimmed', () => {
    assert.match(formatEngineBuild({ moduleVersion: ' 3.18.1 ' }), /node-llama-cpp 3\.18\.1 ·/);
  });
});

// ===========================================================================
// COMMENT STRIPPING MUST NOT MOVE LINES
//
// 4b39295 repaired a FIXED shift: getFunctionSource prepends a doc comment, so
// numbering from m.start labelled the comment as the signature. This is the
// broader sibling at the same call sites, and it is worse: stripComments
// replaced a matched comment with a single SPACE, so a multi-line block
// comment collapsed and every line after it was numbered too low -- an error
// that ACCUMULATES down the file. A fixed shift a reader might notice; a
// drifting one stays plausible all the way down.
// ===========================================================================
describe('stripComments preserves line count, so numbering cannot drift (#306)', () => {
  const masker = new SimpleMasker();
  const countLines = (s) => s.split('\n').length;

  it('a multi-line BLOCK comment leaves its lines behind (C family)', () => {
    const src = [
      'int main() {',
      '  /* this comment',
      '     spans three',
      '     whole lines */',
      '  int x = 1;',
      '  // and a line comment',
      '  return x;',
      '}',
    ].join('\n');
    const out = masker.stripComments(src, 'c');
    assert.equal(countLines(out), countLines(src),
      'the stripped source must have exactly as many lines as the original');
    // The line that mattered: `int x = 1;` is file line 5 and must stay line 5.
    assert.match(out.split('\n')[4], /int x = 1;/);
    assert.match(out.split('\n')[6], /return x;/);
  });

  it('removes the comment CONTENT — the masking guarantee is not weakened', () => {
    const src = 'a();\n/* SECRET banana\n   more secret */\nb();';
    const out = masker.stripComments(src, 'javascript');
    assert.ok(!/banana/.test(out), 'comment text is gone');
    assert.ok(!/secret/i.test(out), 'comment text is gone');
    assert.equal(countLines(out), countLines(src), 'but its lines are not');
  });

  it('holds for each C-family language the branch claims to cover', () => {
    const src = 'x;\n/* one\ntwo */\ny;';
    for (const lang of ['c', 'cpp', 'java', 'javascript']) {
      assert.equal(countLines(masker.stripComments(src, lang)), countLines(src), lang);
    }
  });

  it('holds for python, whose # comments carry no newline', () => {
    const src = 'def f():\n    # a comment\n    return 1\n';
    const out = masker.stripComments(src, 'python');
    assert.equal(countLines(out), countLines(src));
    assert.ok(!/a comment/.test(out));
    assert.match(out.split('\n')[2], /return 1/);
  });

  it('a string that merely LOOKS like a comment is untouched', () => {
    // The regex captures quoted spans first for exactly this reason; blanking
    // one would delete real code and move lines.
    const src = 'const s = "/* not a comment */";\nnext();';
    const out = masker.stripComments(src, 'javascript');
    assert.match(out, /"\/\* not a comment \*\/"/);
    assert.equal(countLines(out), countLines(src));
  });

  it('numbering survives stripping: rendered line N is file line N', () => {
    // The end-to-end property, which is what the four server.js call sites do:
    // strip, then number. Before the repair this drifted by the number of
    // lines every block comment occupied.
    const src = [
      'line one',                 // 1
      '/* two',                   // 2
      '   three',                 // 3
      '   four */',               // 4
      'line five',                // 5
      'line six',                 // 6
    ].join('\n');
    const rendered = addLineNumbers(masker.stripComments(src, 'c'), 1).split('\n');
    const labelled = Object.fromEntries(rendered
      .map((l) => l.match(/^\s*(\d+) \| (.*)$/)).filter(Boolean)
      .map((m) => [Number(m[1]), m[2]]));
    assert.match(labelled[1], /line one/);
    assert.match(labelled[5], /line five/, 'line 5 must still be labelled 5');
    assert.match(labelled[6], /line six/, 'and the drift must not accumulate');
  });
});

// ===========================================================================
// THE VERDICT SIDECAR (#315)
//
// RUN 7 established that retrieval is no longer the blocker on '101 x
// ExoPlayer -- 8 of 45 targets were real playback code, up from 0 of 22, crux
// included -- and the chart still got worse. Both remaining defects are in
// mergeBestPerElement: ASSUMED outranks ABSENT, and strictly-greater
// replacement means a TIE keeps the FIRST-ANALYSED target's citation.
//
// Nobody knows which merge rule is right, and each candidate costs a full
// model run to evaluate. These analyses already contain the answer and were
// discarded the moment the merge read them. On disk, any rule can be replayed
// with no GPU. What the file must and must NOT contain is the whole design.
// ===========================================================================
describe('--verdicts-out dumps the merge INPUT, replayable offline (#315)', () => {
  const SIDECAR = {
    _format: 'codeexam-chart-verdicts/1',
    analysed: [
      { target: 'A.java@junk', elements: [{ element: 6, text: 'a rate', label: 'ASSUMED', note: 'n1' }] },
      { target: 'B.java@crux', elements: [{ element: 6, text: 'a rate', label: 'ASSUMED', note: 'n2' }] },
    ],
    dropped: [{ target: 'C.java@x', reason: 'PARSE-FAILED: 21 non-empty line(s) returned, none matched the VERDICT contract' }],
  };

  it('the recorded order is what mergeBestPerElement actually depends on', () => {
    // asus-CC's three-line proof, run here: same labels, same evidence,
    // opposite citation, decided purely by arrival order. This is WHY the
    // sidecar must be an ordered array -- a keyed object would destroy the one
    // property the replay exists to measure.
    const forward = mergeBestPerElement(SIDECAR.analysed);
    const reversed = mergeBestPerElement([...SIDECAR.analysed].reverse());
    const cite = (m) => [...m.values()][0].target;
    assert.equal(cite(forward), 'A.java@junk');
    assert.equal(cite(reversed), 'B.java@crux');
    assert.notEqual(cite(forward), cite(reversed),
      'citation is decided by analysis order, which is the defect under study');
  });

  it('a replay can be run from the sidecar alone, with no model', () => {
    // The point of the file: an alternative merge rule scored against real
    // verdicts. Here, a corroboration-preferring rule over the same input.
    const byLabel = (recs, label) => recs.flatMap((r) =>
      r.elements.filter((e) => e.label === label).map(() => r.target));
    assert.deepEqual(byLabel(SIDECAR.analysed, 'ASSUMED'), ['A.java@junk', 'B.java@crux'],
      'both targets and their labels survive the round trip');
  });

  it('DROPPED targets carry their reason, so the denominator is right', () => {
    // 45 analysed and 41 parsed are different populations. A rule scored
    // against the wrong one is scored wrong.
    assert.equal(SIDECAR.dropped.length, 1);
    assert.match(SIDECAR.dropped[0].reason, /PARSE-FAILED/);
    assert.ok(!SIDECAR.analysed.some((a) => a.target === 'C.java@x'),
      'a dropped target is not counted among the analysed');
  });

  // These exercise the REAL derivation. The fixture above proves things about
  // the fixture; nominationIndex is where the sidecar's new field actually
  // comes from, and a hand-built object could not have caught a wrong join key.
  it('records which element nominated each target, and at what rank', () => {
    const sym = (f, n) => ({ filepath: f, name: n });
    const idx = nominationIndex([
      { element: 6, hits: [{ sym: sym('a!x/AdaptiveTrackSelection.java', 'determineIdealSelectedIndex') }] },
      { element: 7, hits: [
        { sym: sym('a!x/LaunchActivity.java', 'onStart') },
        { sym: sym('a!x/AdaptiveTrackSelection.java', 'determineIdealSelectedIndex') },
      ] },
    ]);
    assert.deepEqual(idx.get('AdaptiveTrackSelection.java@determineIdealSelectedIndex'),
      [{ element: 6, rank: 0 }, { element: 7, rank: 1 }],
      'one entry per nominator, each carrying that element own rank');
    assert.deepEqual(idx.get('LaunchActivity.java@onStart'), [{ element: 7, rank: 0 }]);
  });

  it('joins on exactly the key selection uses, or the replay joins nothing', () => {
    // The whole point of extracting targetSpec: selection picks a spec, the
    // analysis loop keys perTarget by it, and the sidecar looks nominations up
    // by it. A divergence here yields a file that LOOKS right and matches no
    // rows -- so assert the two agree on the same symbol rather than trusting
    // that three copies of a formula stayed equal.
    const sym = { filepath: 'zip!deep/path/AdaptiveTrackSelection.java', name: 'determineIdealSelectedIndex' };
    const selected = perElementTargets([{ element: 1, hits: [{ sym }] }]);
    const idx = nominationIndex([{ element: 1, hits: [{ sym }] }]);
    assert.equal(selected.length, 1);
    assert.ok(idx.has(selected[0]),
      `sidecar key must match the selected target spec: ${selected[0]} vs ${[...idx.keys()]}`);
  });

  it('is empty for a --targets run, which is an answer and not a gap', () => {
    // Nobody nominated a supplied target. Empty says that; a missing key would
    // read as "this run recorded nothing".
    const idx = nominationIndex(null);
    assert.equal(idx.size, 0);
    assert.deepEqual(idx.get('anything.java@x') || [], []);
  });

  it('skips candidates with no symbol without shifting the ranks after them', () => {
    // rank is the position retrieval ASSIGNED. Compacting the array would
    // silently promote later candidates and misreport the one number the
    // tie-break rules will be scored on.
    const idx = nominationIndex([
      { element: 3, hits: [null, { sym: { filepath: 'A.java', name: 'x' } }] },
    ]);
    assert.deepEqual(idx.get('A.java@x'), [{ element: 3, rank: 1 }], 'rank 1 stays rank 1');
  });

  it('carries NO derived field — not tally, agreement, or winner', () => {
    // Derived fields would bake in the assumptions the replay exists to test.
    // This is the merge INPUT, not its output.
    const flat = JSON.stringify(SIDECAR);
    for (const forbidden of ['tally', 'agreement', 'winner', 'best']) {
      assert.ok(!flat.includes(`"${forbidden}"`), `sidecar must not carry a derived "${forbidden}"`);
    }
  });
});

// --granularity (A14, claim-granularity-tiers): the tier reaches the chart's row structure.
// `coarse` is the drafter's rows (stage A only); `fine`, the default, is the litigator's --
// every embedded wherein / ", and" / "which is" its own row. A supplied --elements list wins
// over either. The header line that records the tier is built in doClaimChart, from the
// same option, so a fine chart and a coarse chart of one claim are never confused.
describe('claim chart: --granularity reaches the rows', () => {
  const CLAIM = 'A method of routing a packet, comprising: receiving the packet at an interface, wherein the packet carries a priority field, and the priority field selects a queue; enqueueing the packet on the selected queue; and forwarding the packet from the queue, wherein forwarding is rate-limited per queue.';

  it('coarse yields the semicolon rows; fine subdivides them; fine is the default', () => {
    const coarse = buildChartTable(CLAIM, { granularity: 'coarse' }).elements;
    const fine = buildChartTable(CLAIM, { granularity: 'fine' }).elements;
    const dflt = buildChartTable(CLAIM).elements;
    assert.equal(coarse.length, 4, `preamble + three semicolon rows: ${JSON.stringify(coarse)}`);
    assert.ok(fine.length > coarse.length, `fine (${fine.length}) should subdivide coarse (${coarse.length})`);
    assert.deepEqual(dflt, fine, 'no option = fine');
  });

  it('a supplied --elements list wins over either tier', () => {
    const supplied = ['A method of routing a packet, comprising:', 'receiving the packet', 'forwarding the packet'];
    for (const granularity of ['coarse', 'fine']) {
      assert.deepEqual(buildChartTable(CLAIM, { elements: supplied, granularity }).elements, supplied);
    }
  });
});

// issue-311-dep-claim-chart: a claims file carries more than claim 1, and the
// chart used to read all of it as ONE claim. Scope is now resolved (first
// claim / --claim-number / --claim-family), and a family charts each
// dependent as its parent's rows plus its contribution -- an ADDITION adds a
// row, a MODIFICATION re-evaluates the row it narrows. The stub model below
// answers the VERDICT contract from the prompt's ELEMENT lines: a narrowed row
// is ABSENT, everything else PRESENT, so a re-evaluation comes back different
// from its parent on the same code -- which is what a graded dependent is for.
import { chartScope, dependentBody, narrowedRowFor, familyVerdictLine } from '../src/commands/claim-chart.js';
import os from 'node:os';
import path from 'node:path';

describe('dependent claims: scope and --claim-family (issue-311-dep-claim-chart)', () => {
  const index = {
    functionIndex: { 'x/A.java': { 'A::one': { start: 1, end: 5 }, 'A::two': { start: 7, end: 9 } } },
    _ensureFunctionIndex() {},
    findCallers: () => [], findCallees: () => [],
    getFunctionSource: () => 'void one() { rate(); }',
    getFunctionSourceWithRange: () => ({ source: 'void one() { rate(); }', start: 1, end: 1, prepended: 0 }),
  };
  const FAMILY = [
    '1. A method of rating a stream, comprising: receiving a stream; computing a rate from the stream; and storing the rate.',
    '2. The method of claim 1, further comprising: transmitting the rate to a client.',
    '3. The method of claim 1, wherein computing the rate comprises weighting the rate by a window.',
    '4. The method of claim 3, wherein the window is squared.',
    '5. The method of claim 1, characterized by a threshold on the rate.',
    '6. The method of any of claims 1 to 3, further comprising: logging the rate.',
  ].join('\n');
  const draft = async (prompt) => {
    const lines = [];
    for (const m of String(prompt).matchAll(/^ELEMENT (\d+): (.*)$/gm)) {
      lines.push(`VERDICT ${m[1]}: ${/as narrowed by claim/.test(m[2]) ? 'ABSENT — the narrowing is not in this function, no line.' : 'PRESENT — rate() computes it, line 1.'}`);
    }
    return lines.join('\n');
  };
  const run = async (args, extraOpts = {}) => {
    const out = [];
    const origLog = console.log; console.log = (s) => out.push(String(s));
    const origErr = process.stderr.write; process.stderr.write = () => true;
    let res;
    try { res = await doClaimChart(index, { targets: 'x/A.java@A::one', model: 'f.gguf', no_callees: true, ...args }, { draft, ...extraOpts }); }
    finally { console.log = origLog; process.stderr.write = origErr; }
    return { res, chart: out.join('\n') };
  };

  it('a two-sided claim rebuilds the table with other-side tags (regression: table must be reassignable)', async () => {
    const TWO_SIDED = ['1. A distribution system, including a transmission device and a reception device configured to be capable of communicating with each other,',
      'the transmission device being equipped with a content transmitting unit for transmitting content data to the reception device, and',
      'the reception device being equipped with a content reproducing unit for storing received data,',
      'wherein the content transmitting unit is configured to change the code rate; and',
      'the content reproducing unit is configured to start reproduction.'].join('\n');
    const { chart } = await run({ claim_chart: TWO_SIDED },
      { clientServerVerdict: () => ({ serverRoutes: 0, clientCalls: 0, socketClient: 1, socketServer: 0, verdict: 'client-only' }) });
    assert.match(chart, /Two-sided claim: transmission device \/ reception device/);
    assert.match(chart, /CLIENT-ONLY/);
    assert.ok(chart.includes('_[other side]_'), 'transmission-device rows tagged');
  });

  it('dependentBody strips the reference; narrowedRowFor picks the row sharing the most stems', () => {
    assert.equal(dependentBody('The method of claim 1, wherein the window is squared.'), 'wherein the window is squared.');
    assert.equal(dependentBody('The method of any of claims 1 to 3, further comprising: logging the rate.'), 'further comprising: logging the rate.');
    const rows = [{ designation: '[1a]', text: 'receiving a stream' }, { designation: '[1b]', text: 'computing a rate from the stream' }];
    assert.equal(narrowedRowFor('wherein computing the rate comprises weighting the rate', rows).row.designation, '[1b]');
    assert.equal(narrowedRowFor('wherein the colour is blue', rows), null);
  });

  it('chartScope: first claim by default, the chain for a dependent, the family on request, and a dependent root refused', () => {
    const one = chartScope(FAMILY, {});
    assert.match(one.text, /^1\. A method of rating a stream/);
    assert.ok(!/transmitting/.test(one.text), 'claim 2 text must not fold into claim 1');
    assert.match(one.note, /5 other claim\(s\) in the input not used/);
    const three = chartScope(FAMILY, { claim: 3 });
    assert.match(three.text, /^1\. A method of rating[\s\S]*\n3\. The method of claim 1, wherein computing/);
    const fam = chartScope(FAMILY, { family: true });
    assert.equal(fam.family.root, 1);
    // Claim 6 ("any of claims 1 to 3") resolves to claim 2 by shortest-parent, so it is D2 like claim 4.
    assert.deepEqual(fam.family.members.map((m) => m.n), [2, 3, 5, 4, 6], 'depth-1 dependents first, then D2');
    assert.equal(fam.family.members.find((m) => m.n === 4).depthLabel, 'D2');
    assert.equal(fam.family.members.find((m) => m.n === 6).parent, 2);
    assert.throws(() => chartScope(FAMILY, { claim: 3, family: true }), /needs an independent claim as its root/);
  });

  it('familyVerdictLine counts every limitation, shown or not', () => {
    const dep = {
      n: 3, depthLabel: 'D',
      inherited: [{ from: 1, label: 'PRESENT' }, { from: 1, label: 'ABSENT' }, { from: 1, label: 'PRESENT', narrowedBy: 3 }],
      judged: [{ origin: 'narrowed', label: 'ABSENT' }],
      effective: [{ label: 'PRESENT' }, { label: 'ABSENT' }, { label: 'ABSENT' }],
    };
    assert.equal(familyVerdictLine(dep), 'claim 3 (D): NOT MET (1 of 3 limitations PRESENT) over 3 limitations -- 2 inherited from claim 1 (evaluated there, not shown; 1 PRESENT), 1 re-evaluated as narrowed, 0 new');
  });

  it('without --claim-family a numbered claims file charts claim 1 only; --claim-number charts a chain', async () => {
    const { res, chart } = await run({ claim_chart: FAMILY });
    assert.ok(res && res.family === 0);
    assert.ok(!/transmitting the rate/.test(chart), 'claim 2 must not appear in a claim-1 chart');
    assert.match(chart, /Scope: claim 1 \(independent\)/);
    const three = await run({ claim_chart: FAMILY, claim_number: 3 });
    assert.match(three.chart, /3\. The method of claim 1, wherein computing/);
  });

  it('--claim-family charts each dependent as inherited rows plus its contribution, with the sidecar family block', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-family-'));
    const sidecarPath = path.join(dir, 'verdicts.json');
    try {
      const { res, chart } = await run({ claim_chart: FAMILY, claim_family: true, verdicts_out: sidecarPath });
      assert.ok(res && res.family === 5, JSON.stringify(res));
      assert.match(chart, /## Dependent claims \(family of claim 1\)/);
      assert.match(chart, /### Claim 2 \(D\) — ADDITION/);
      assert.match(chart, /### Claim 3 \(D\) — MODIFICATION/);
      assert.match(chart, /### Claim 4 \(D2\) — MODIFICATION/);
      assert.match(chart, /### Claim 5 \(D\) — UNDETERMINED/);
      assert.match(chart, /_Multi-parent reference: charted under claim \d by shortest-parent \(alternatives/);
      const j = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      assert.equal(j._format, 'codeexam-chart-verdicts/1', 'the claim-1 half of the sidecar is untouched');
      assert.equal(j.family.members.length, 5);
      const byN = (n) => j.family.members.find((m) => m.n === n);
      // ADDITION: every claim-1 row inherited with its verdict carried, one new row.
      const c2 = byN(2);
      assert.equal(c2.kind, 'ADDITION');
      assert.equal(c2.rows.filter((r) => r.origin === 'inherited').length, j.elements);
      const added = c2.rows.find((r) => r.origin === 'new');
      assert.match(added.text, /transmitting the rate to a client/);
      assert.equal(added.designation, '[2a]');
      // The stub says PRESENT; the lexical gate may downgrade it on the one-line
      // mock source. What matters here is that the row WAS judged.
      assert.ok(['PRESENT', 'PARTIAL', 'ASSUMED'].includes(added.label), added.label);
      assert.ok(added.target, 'judged on a target');
      assert.match(c2.verdict, /^claim 2 \(D\): .*over \d+ limitations -- \d+ inherited from claim 1 \(evaluated there, not shown; \d+ PRESENT\), 0 re-evaluated as narrowed, 1 new$/);
      // MODIFICATION: the row about computing the rate is re-evaluated and comes back different.
      const c3 = byN(3);
      assert.equal(c3.kind, 'MODIFICATION');
      const narrowed = c3.rows.find((r) => r.origin === 'narrowed');
      assert.ok(narrowed, JSON.stringify(c3.rows));
      assert.match(narrowed.text, /computing a rate from the stream — as narrowed by claim 3/);
      // Claim 1's rows live in the chart table; the narrowed row records the parent's label itself.
      assert.notEqual(narrowed.parentLabel, 'ABSENT', 'parent row was not ABSENT');
      assert.equal(narrowed.label, 'ABSENT', 're-evaluated against the narrowing on the same code');
      assert.match(narrowed.narrows, /^\[1[a-z]\]$/);
      assert.match(chart, new RegExp(`\\| \\[3a\\] narrows ${narrowed.narrows.replace(/[[\]]/g, '\\$&')} \\|`));
      assert.match(c3.verdict, /1 re-evaluated as narrowed, 0 new$/);
      assert.equal(c3.rows.length, j.elements, 'a narrowing adds no row');
      // D2: claim 4 narrows claim 3's narrowed row, not claim 1's.
      const c4 = byN(4);
      assert.deepEqual(c4.chain, [1, 3, 4]);
      const n4 = c4.rows.find((r) => r.origin === 'narrowed');
      assert.equal(n4.narrows, '[3a]');
      assert.match(n4.text, /as narrowed by claim 3[\s\S]*as narrowed by claim 4: the window is squared/);
      // UNDETERMINED: judged as its own row, the ambiguity stated.
      const c5 = byN(5);
      assert.equal(c5.kind, 'UNDETERMINED');
      assert.match(c5.rows.find((r) => r.origin === 'new').ambiguous, /UNDETERMINED kind/);
      // Multi-parent: the chosen parent is named and the alternatives recorded.
      const c6 = byN(6);
      assert.equal(c6.parentChoice.policy, 'shortest-parent');
      assert.ok(c6.parentChoice.alternatives.length >= 1);
      assert.equal(c6.parent, c6.parentChoice.chosen);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// chart-cite-nearest-miss: on a tie the citation goes to the row's own
// nominee, and an ABSENT citation is labelled as the closest candidate
// examined. The '101 family chart cited AdTagLoader::sendContentComplete (the
// first target analysed) on four of six ABSENT rows while the one
// AdaptiveTrackSelection method examined carried the near-miss sentence.
describe('nearest-miss citation on ties (chart-cite-nearest-miss)', () => {
  const v = (element, label, note = '') => ({ element, text: `e${element}`, label, note });
  const perTarget = [
    { target: 'a/First.java@first', elements: [v(1, 'ABSENT', 'first analysed'), v(2, 'PARTIAL', 'p-first')] },
    { target: 'b/Other.java@other', elements: [v(1, 'ABSENT', 'other'), v(2, 'PARTIAL', 'p-other')] },
    { target: 'c/Near.java@near', elements: [v(1, 'ABSENT', 'the near miss: no remaining-time input'), v(2, 'ABSENT')] },
  ];
  const nominators = new Map([
    ['c/Near.java@near', [{ element: 1, rank: 0 }]],
    ['b/Other.java@other', [{ element: 2, rank: 0 }, { element: 1, rank: 3 }]],
    ['a/First.java@first', [{ element: 2, rank: 1 }]],
  ]);

  it('an all-ABSENT row cites the target its own element nominated highest, analysed last or not', () => {
    const fills = mergeBestPerElement(perTarget, { nominators });
    const r1 = fills.find((f) => f.element === 1);
    assert.equal(r1.target, 'c/Near.java@near');
    assert.equal(r1.note, 'the near miss: no remaining-time input');
    assert.equal(r1.closest, true);
    assert.equal(r1.agreement.ABSENT, 3);
  });

  it('a shared PARTIAL cites the element\'s own nominee over the first analysed; a better label still wins outright', () => {
    const fills = mergeBestPerElement(perTarget, { nominators });
    const r2 = fills.find((f) => f.element === 2);
    assert.equal(r2.target, 'b/Other.java@other', 'rank 0 for element 2 beats rank 1');
    assert.equal(r2.closest, false);
    const withPresent = [...perTarget, { target: 'd/Late.java@late', elements: [v(2, 'PRESENT', 'wins')] }];
    assert.equal(mergeBestPerElement(withPresent, { nominators }).find((f) => f.element === 2).target, 'd/Late.java@late');
  });

  it('without nomination data the first analysed keeps a true tie (unchanged behaviour)', () => {
    const fills = mergeBestPerElement(perTarget);
    assert.equal(fills.find((f) => f.element === 1).target, 'a/First.java@first');
    assert.equal(fills.find((f) => f.element === 2).target, 'a/First.java@first');
  });

  it('the chart labels an ABSENT citation as the closest examined, and the coverage line counts them', () => {
    // Supplied elements, no preamble row: the preamble is counted apart by the
    // coverage line and must not be the row under test here.
    const table = buildChartTable('x', { elements: ['receiving a packet', 'routing the packet by its header'] });
    const fills = mergeBestPerElement(perTarget, { nominators }).map((f) => ({ ...f }));
    const filled = fillChartRows(table.table, fills);
    assert.match(filled, /\| 1 \| .*\*\*ABSENT\*\*.*\| closest examined: `c\/Near\.java@near` \|/);
    assert.match(filled, /\| 2 \| .*\*\*PARTIAL\*\*.*\| `b\/Other\.java@other` \|/);
    const cov = coverageLine(fills, table.elements.length, table.elements);
    assert.match(cov, /1 ABSENT row\(s\) cite the closest candidate examined, not a finding/);
  });
});

// chart-retrieval-whole-claim-arm: the claim's own words over the whole symbol
// table, on top of the per-element budget, attributed as element 0. On the
// '101 chart the per-element words never retrieved determineIdealSelectedIndex;
// the claim's own vocabulary (track, selection, bitrate, buffer) does.
import { wholeClaimTerms, wholeClaimArm } from '../src/commands/claim-chart.js';

describe('whole-claim retrieval arm (chart-retrieval-whole-claim-arm)', () => {
  const sym = (name, filepath) => ({ name, bare: name.split('::').pop(), filepath, start: 1, end: 10 });
  const symbols = [
    sym('AdaptiveTrackSelection::determineIdealSelectedIndex', 'x/trackselection/AdaptiveTrackSelection.java'),
    sym('TimeFormat::remaining', 'x/ui/TimeText.kt'),
    sym('AdTagLoader::sendContentComplete', 'x/ima/AdTagLoader.java'),
    sym('AdaptiveTrackSelectionTest::testBitrate', 'x/test/AdaptiveTrackSelectionTest.java'),
    sym('Unrelated::thing', 'x/Unrelated.java'),
  ];
  // `selection`, `determining`, `unit`, `time` are claim-genre stop words in
  // contentWords (the ballpark's list); what survives is the claim's own
  // vocabulary: track, adaptive, bitrate, buffered, index ...
  const CLAIM = 'A distribution system comprising a code rate determining unit for an adaptive selection of a track by its bitrate and the buffered duration, and storing the selected index and a remaining time.';

  it('terms are the claim\'s content words, one per stem, lowercased', () => {
    const t = wholeClaimTerms(CLAIM);
    assert.ok(t.includes('track') && t.includes('adaptive') && t.includes('bitrate'), t.join(' '));
    assert.ok(!t.includes('selection'), 'claim-genre stop words are out');
    assert.equal(new Set(t.map((w) => w.slice(0, 6))).size, t.length, 'one surface form per stem');
  });

  it('finds a symbol the per-element words missed, as element 0, tests excluded by default', () => {
    const arm = wholeClaimArm({ claimText: CLAIM, symbols, limit: 3 });
    assert.equal(arm.element, 0);
    assert.equal(arm.arm, 'claim');
    const names = arm.hits.map((h) => h.sym.name);
    assert.equal(names[0], 'AdaptiveTrackSelection::determineIdealSelectedIndex', names.join(' | '));
    assert.ok(!names.some((n) => /Test/.test(n)), 'test symbol excluded');
    assert.ok(arm.hits.length <= 3);
    const withTests = wholeClaimArm({ claimText: CLAIM, symbols, limit: 5, includeTests: true });
    assert.ok(withTests.hits.some((h) => /Test/.test(h.sym.name)), 'admitted with includeTests');
  });

  it('rides the nomination index as element 0 and the chart names the arm', () => {
    const arm = wholeClaimArm({ claimText: CLAIM, symbols, limit: 2 });
    const retrieval = [
      { element: 1, words: ['remaining', 'time'], hits: [{ sym: symbols[1] }] },
      arm,
    ];
    const noms = nominationIndex(retrieval);
    const crux = targetSpec(symbols[0]);
    assert.equal(noms.get(crux).length, 1);
    assert.equal(noms.get(crux)[0].element, 0, 'nominated by the whole claim');
    assert.ok(noms.get(crux)[0].rank >= 0);
    // The merge's tie-break treats element 0 like any nominator: a row this
    // element did not nominate falls back to analysis order.
    const perTarget = [
      { target: targetSpec(symbols[1]), elements: [{ element: 1, text: 'e1', label: 'ABSENT' }] },
      { target: crux, elements: [{ element: 1, text: 'e1', label: 'ABSENT' }] },
    ];
    assert.equal(mergeBestPerElement(perTarget, { nominators: noms })[0].target, targetSpec(symbols[1]));
    const table = buildChartTable('x', { elements: ['a remaining time'] });
    const chart = formatChart({
      claimText: CLAIM, table: table.table, fills: [], elements: table.elements, engineLabel: 'stub',
      targets: [targetSpec(symbols[1]), crux], dropped: [], retrieval,
    });
    assert.match(chart, /\| whole claim \| .*track.*\| 2 \|/);
    assert.match(chart, new RegExp('- `' + crux.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '` _\\(whole-claim arm\\)_'));
    const t1 = targetSpec(symbols[1]);
    assert.ok(chart.includes('- `' + t1 + '`\n'), 'the per-element target carries no arm marker');
  });
});

// chart-retrieval-content-arm-and-budget: concentration and the label-split
// tie-break. The bridged '101 is the motivating shape: three elements' hits in
// one file at ranks the round-robin never reaches.
describe('file concentration and the label-split tie-break (chart-retrieval-content-arm-and-budget)', () => {
  const sym = (name, filepath) => ({ name, bare: name.split('::').pop(), filepath, start: 1, end: 9 });
  const hit = (name, filepath) => ({ sym: sym(name, filepath) });

  it('a file 2+ elements point at, with no selected target, contributes its best hit on top of the budget', () => {
    const shared = 'x/Mechanism.java';
    const perElement = [
      { element: 1, hits: [hit('A::a1', 'x/A.java'), hit('Mechanism::partOne', shared)] },
      { element: 2, hits: [hit('B::b1', 'x/B.java'), hit('C::c1', 'x/C.java'), hit('Mechanism::partTwo', shared)] },
      { element: 3, hits: [hit('D::d1', 'x/D.java')] },
    ];
    const b = perElementTargetsWithStats(perElement, { targets_per_element: 1 });
    assert.equal(b.concentration.length, 1, JSON.stringify(b.concentration));
    assert.equal(b.concentration[0].file, shared);
    assert.deepEqual(b.concentration[0].elements, [1, 2]);
    assert.match(b.concentration[0].target, /Mechanism::partOne$/, 'the best-ranked hit of the file');
    assert.ok(b.targets.includes(b.concentration[0].target), 'added on top of the budget');
    // Depth 1 selected only the rank-0 hits; the shared file's hits were below the cut.
    assert.ok(!b.targets.includes('x/A.java@A::a1') || b.targets.length >= 4);
  });

  it('a file that already contributed a selected target is not concentration-promoted; 0 disables', () => {
    const shared = 'x/Mechanism.java';
    const perElement = [
      { element: 1, hits: [hit('Mechanism::partOne', shared), hit('A::a1', 'x/A.java')] },
      { element: 2, hits: [hit('B::b1', 'x/B.java'), hit('Mechanism::partTwo', shared)] },
    ];
    const b = perElementTargetsWithStats(perElement, { targets_per_element: 1 });
    assert.equal(b.concentration.length, 0, 'partOne was selected at rank 0, so the file already contributes');
    const off = perElementTargetsWithStats([
      { element: 1, hits: [hit('A::a1', 'x/A.java'), hit('Mechanism::partOne', shared)] },
      { element: 2, hits: [hit('B::b1', 'x/B.java'), hit('Mechanism::partTwo', shared)] },
    ], { targets_per_element: 1, concentration_targets: 0 });
    assert.equal(off.concentration.length, 0);
  });

  it('a non-ABSENT tie cites the implementer (most PRESENT rows), not the row\'s nominee; ABSENT ties keep the nearest miss', () => {
    const v = (element, label) => ({ element, text: 'e' + element, label });
    const perTarget = [
      { target: 'x/Namesake.java@namesake', elements: [v(1, 'PRESENT'), v(2, 'ABSENT'), v(3, 'ABSENT')] },
      { target: 'x/Impl.java@implementer', elements: [v(1, 'PRESENT'), v(2, 'PRESENT'), v(3, 'ABSENT')] },
    ];
    const nominators = new Map([
      ['x/Namesake.java@namesake', [{ element: 1, rank: 0 }, { element: 3, rank: 0 }]],
      ['x/Impl.java@implementer', [{ element: 1, rank: 5 }]],
    ]);
    const fills = mergeBestPerElement(perTarget, { nominators });
    assert.equal(fills.find((f) => f.element === 1).target, 'x/Impl.java@implementer', 'PRESENT tie -> most PRESENT rows wins over the rank-0 nominee');
    assert.equal(fills.find((f) => f.element === 3).target, 'x/Namesake.java@namesake', 'ABSENT tie -> the row\'s own nominee (nearest miss)');
  });
});

import { buildChartAnalysisPrompt as _depBcap } from '../src/commands/claim-chart.js';
import { retrievePerElement as _depRpe } from '../src/commands/claim-locate.js';

describe('dep-claims-broaden-parent: species vocabulary reaches retrieval and the prompt', () => {
  it('extraWords join the element word list, retrieve the species symbol, and are attributed', async () => {
    const symbols = [
      { name: 'WidgetAssembly::spin', filepath: 'src/widget.js' },
      { name: 'GizmoUnit::run', filepath: 'src/gizmo.js' },
    ];
    const draft = async () => 'ELEMENT 1: gizmo, unit';
    const got = await _depRpe({ draft, elements: ['a gizmo unit'], symbols,
      opts: { extraWords: new Map([[1, { words: ['widget', 'assembly'], from: [{ claim: 2, words: ['widget', 'assembly'] }] }]]) } });
    const p = got.perElement[0];
    assert.ok(p.words.includes('widget'), 'species word joined the search list');
    assert.deepEqual(p.depFrom, [2], 'attributed to the donating claim');
    assert.ok(p.hits.some((h) => /WidgetAssembly/.test(h.sym.name)), 'species word retrieved the species symbol');
  });
  it('an element the model response never parsed still gets its species words', async () => {
    const draft = async () => 'ELEMENT 1: alpha';
    const got = await _depRpe({ draft, elements: ['alpha row', 'beta row'],
      symbols: [{ name: 'ZetaTransform::apply', filepath: 'z.js' }],
      opts: { extraWords: new Map([[2, { words: ['zeta'], from: [{ claim: 3, words: ['zeta'] }] }]]) } });
    const p2 = got.perElement.find((p) => p.element === 2);
    assert.ok(p2, 'element 2 searched despite no model words');
    assert.ok(p2.words.includes('zeta') && p2.depFrom.includes(3));
  });
  it('buildChartAnalysisPrompt carries the differentiation NOTE on the narrowed row only', () => {
    const prompt = _depBcap('src', 'f', 'a.js', 'claim', ['row one', 'row two'],
      { depNotes: new Map([[1, 'Dependent claim 2 narrows this element to: widget (claim differentiation — a species the element presumptively covers).']]) });
    assert.ok(prompt.includes('ELEMENT 2: row two'));
    assert.ok(/NOTE: Dependent claim 2 narrows/.test(prompt), 'note present on row two');
    assert.ok(!/ELEMENT 1:[^\n]*\n\s+NOTE:/.test(prompt), 'no note on the un-narrowed row');
  });
});

import { drilldownTargets as _ddT, DRILLDOWN_PER_CHART as _ddChartMax } from '../src/commands/claim-chart.js';

describe('chart-within-file-drilldown: scoped per-element nomination', () => {
  const hit = (name, filepath, arm = null) => ({ sym: { name, filepath }, ...(arm ? { arm } : {}) });
  const mkRetrieval = (entries) => entries.map(([el, hits]) => ({ element: el, words: [`w${el}`, 'shared'], hits }));
  const idx = {};   // truthiness only; the injected contentSearch never touches it
  it('derives multi-element files from hit windows -- including files that already contributed a target', () => {
    const calls = [];
    const search = (index, words, opts) => {
      calls.push(opts.includePath[0]);
      return [{ name: `Impl_${words[0]}`, filepath: opts.includePath[0] }];
    };
    const retrieval = mkRetrieval([
      [4, [hit('A::sel', 'a/F.java')]],       // F already gave a target: still drillable
      [6, [hit('A::other', 'a/F.java')]],
      [8, [hit('B::x', 'b/G.java')]],          // single-element file: never drilled
    ]);
    const got = _ddT({ index: idx, retrieval, targets: ['a/F.java@A::sel'], contentSearch: search });
    assert.deepEqual(got.added.map((a) => a.element), [4, 6]);
    assert.ok(calls.every((f) => f === 'a/F.java'), 'searches scoped to the shared file only');
  });
  it('a candidate already in targets is skipped for the next in-file hit', () => {
    const two = (index, words, opts) => [
      { name: 'Same::fn', filepath: opts.includePath[0] },
      { name: 'Next::fn', filepath: opts.includePath[0] },
    ];
    const retrieval = () => mkRetrieval([[4, [hit('A::a', 'a/F.java')]], [6, [hit('A::b', 'a/F.java')]]]);
    const first = _ddT({ index: idx, retrieval: retrieval(), targets: [], contentSearch: two });
    assert.ok(first.added.length >= 1);
    const taken = first.added[0].spec;
    const again = _ddT({ index: idx, retrieval: retrieval(), targets: [taken], contentSearch: two });
    assert.ok(again.added.length >= 1);
    assert.notEqual(again.added[0].spec, taken, 'dedup moved to the next in-file candidate');
  });
  it('caps hold; disjoint-file retrieval is a no-op', () => {
    const search = (index, words, opts) => [{ name: `Impl_${words[0]}_${opts.includePath[0]}`, filepath: opts.includePath[0] }];
    const overlapping = mkRetrieval([
      [4, [hit('x', 'a/F.java'), hit('y', 'b/G.java')]],
      [6, [hit('z', 'a/F.java'), hit('w', 'c/H.java')]],
      [8, [hit('u', 'b/G.java'), hit('v', 'c/H.java')]],
    ]);
    const got = _ddT({ index: idx, retrieval: overlapping, targets: [], contentSearch: search });
    assert.ok(got.added.length <= _ddChartMax);
    const perEl = {};
    for (const a of got.added) perEl[a.element] = (perEl[a.element] || 0) + 1;
    assert.ok(Object.values(perEl).every((n) => n === 1), 'one per element');
    const disjoint = mkRetrieval([[4, [hit('x', 'a/F.java')]], [6, [hit('y', 'b/G.java')]]]);
    const none = _ddT({ index: idx, retrieval: disjoint, targets: [], contentSearch: search });
    assert.deepEqual(none.added, [], 'no multi-element file, no drilldown');
  });
  it('round-robins across files: a sponge file cannot consume the whole budget', () => {
    const search = (index, words, opts) => [{ name: `Impl_${words[0]}_${opts.includePath[0]}`, filepath: opts.includePath[0] }];
    const retrieval = mkRetrieval([
      [1, [hit('a', 'sponge/M.java')]],
      [4, [hit('b', 'sponge/M.java'), hit('e', 'a/ATS.java')]],
      [7, [hit('c', 'sponge/M.java')]],
      [6, [hit('f', 'a/ATS.java')]],
    ]);
    const got = _ddT({ index: idx, retrieval, targets: [], contentSearch: search });
    const files = new Set(got.added.map((a) => a.file));
    assert.ok(files.has('a/ATS.java'), 'the rank-2 file gets a drill before the sponge takes a second');
    assert.ok(got.added.length <= _ddChartMax);
  });
});

import { targetConnectivity as _tcon } from '../src/commands/claim-locate.js';

describe('claim-chart-scattered-targets: cited-target connectivity', () => {
  it('call-linked targets group; an unlinked one stands apart', () => {
    const edges = { 'a.js@A::run': ['b.js@B::step'], 'b.js@B::step': ['a.js@A::run'], 'c.js@C::other': [] };
    const got = _tcon({ targets: ['a.js@A::run', 'b.js@B::step', 'c.js@C::other'], neighbors: (s) => edges[s] || [] });
    assert.equal(got.groups.length, 2);
    assert.deepEqual([...got.groups[0]].sort(), ['a.js@A::run', 'b.js@B::step']);
  });
  it('same file counts as connected without any call edge', () => {
    const got = _tcon({ targets: ['x/f.js@F::a', 'y/f.js@F::b'], neighbors: () => [] });
    assert.equal(got.groups.length, 1);
  });
  it('a 3-hop path connects; a 4-hop one does not; fewer than 2 targets yields null', () => {
    const chain3 = { 'a@A': ['m1@M1'], 'm1@M1': ['m2@M2'], 'm2@M2': ['b@B'] };
    assert.equal(_tcon({ targets: ['a@A', 'b@B'], neighbors: (s) => chain3[s] || [] }).groups.length, 1);
    const chain4 = { 'a@A': ['m1@M1'], 'm1@M1': ['m2@M2'], 'm2@M2': ['m3@M3'], 'm3@M3': ['b@B'] };
    assert.equal(_tcon({ targets: ['a@A', 'b@B'], neighbors: (s) => chain4[s] || [] }).groups.length, 2);
    assert.equal(_tcon({ targets: ['a@A'], neighbors: () => [] }), null);
  });
});

import { clientServerVerdict as _csv, buildChartTable as _bct } from '../src/commands/claim-chart.js';

describe('chart-client-server-scope: index-side verdict and row tags', () => {
  it('client-only, server-only, both, undetermined from injected counts', () => {
    const mk = (stats, sockets = []) => _csv({}, { extract: () => ({ sockets, stats }) });
    assert.equal(mk({ serverCount: 0, clientCount: 0 }, [{ role: 'client' }]).verdict, 'client-only');
    assert.equal(mk({ serverCount: 3, clientCount: 0 }).verdict, 'server-only');
    assert.equal(mk({ serverCount: 2, clientCount: 5 }).verdict, 'both');
    assert.equal(mk({ serverCount: 0, clientCount: 0 }).verdict, 'undetermined');
  });
  it('sideTags render the other-side mark beside the class tag; absent without tags', () => {
    const claim = '1. A method, comprising: sending data; and receiving data.';
    const tagged = _bct(claim, { sideTags: [false, true, false] });
    assert.ok(tagged.table.includes('_[other side]_'), 'tagged row marked');
    const plain = _bct(claim, {});
    assert.ok(!plain.table.includes('_[other side]_'));
  });
});

import { citedDuplicates as _cdup, unshownQualifiers as _unq } from '../src/commands/claim-chart.js';

describe('chart-duplicate-surface-note: structural twins of cited implementations', () => {
  const fills = [
    { element: 1, label: 'PRESENT', target: 'contrib/minizip/iowin32.c@win32_open_file_func', note: 'x' },
    { element: 2, label: 'ABSENT', target: 'a.c@f', note: 'x' },
  ];
  it('a cited function with an out-of-file twin surfaces both function- and file-level entries', () => {
    const getDupes = () => [{ lines: 26, instances: [
      { filepath: 'contrib/minizip/iowin32.c', name: 'win32_open_file_func' },
      { filepath: 'contrib/minizip/ioapi.c', name: 'fopen_file_func' },
    ] }];
    const got = _cdup({}, fills, { getDupes });
    const fn = got.find((d) => d.target);
    assert.ok(fn && fn.target === fills[0].target);
    assert.match(fn.twins[0], /ioapi\.c@/);
    const fl = got.find((d) => d.file);
    assert.ok(fl && fl.file === 'iowin32.c' && fl.twinFile === 'ioapi.c');
    assert.match(fl.example, /win32_open_file_func ~ fopen_file_func/);
  });
  it('the claim-7 shape: cited function NOT in any group, but its FILE shares a group -> file-level only', () => {
    const shapeFills = [{ element: 1, label: 'PRESENT', target: 'contrib/minizip/iowin32.c@MySetFilePointerEx', note: 'x' }];
    const getDupes = () => [{ lines: 10, instances: [
      { filepath: 'contrib/minizip/iowin32.c', name: 'fill_win32_filefunc' },
      { filepath: 'contrib/minizip/ioapi.c', name: 'fill_fopen_filefunc' },
    ] }];
    const got = _cdup({}, shapeFills, { getDupes });
    assert.ok(!got.some((d) => d.target), 'no function-level entry');
    const fl = got.find((d) => d.file);
    assert.ok(fl && fl.twinFile === 'ioapi.c');
  });
  it('a boilerplate-sized group never nominates a file pair (asus-CC RUN16 getter flood)', () => {
    const shapeFills = [{ element: 1, label: 'PRESENT', target: 'a/ContentDataSource.java@getUri', note: 'x' }];
    const getDupes = () => [{ lines: 3, instances: [
      { filepath: 'a/ContentDataSource.java', name: 'ContentDataSource::getUri' },
      { filepath: 'a/Cue.java', name: 'Cue::Builder::getText' },
    ] }];
    const got = _cdup({}, shapeFills, { getDupes });
    assert.ok(!got.some((d) => d.file), 'no file-level entry from a 3-line group');
    assert.ok(got.some((d) => d.target), 'the function-level fact (cited fn IS in the group) still surfaces');
  });
  it('per-cited-file pair cap holds at 2', () => {
    const shapeFills = [{ element: 1, label: 'PRESENT', target: 'x/F.java@fn', note: 'x' }];
    const mk = (twin) => ({ lines: 20, instances: [
      { filepath: 'x/F.java', name: `F::impl_${twin}` },
      { filepath: `x/${twin}.java`, name: `${twin}::impl` },
    ] });
    const got = _cdup({}, shapeFills, { getDupes: () => [mk('A'), mk('B'), mk('C')] });
    assert.equal(got.filter((d) => d.file).length, 2);
  });
  it('same-file-only groups and un-cited groups yield nothing', () => {
    const getDupes = () => [{ lines: 26, instances: [
      { filepath: 'contrib/minizip/iowin32.c', name: 'win32_open_file_func' },
      { filepath: 'contrib/minizip/iowin32.c', name: 'win32_open64_file_func' },
    ] }];
    assert.deepEqual(_cdup({}, fills, { getDupes }), []);
  });
});

describe('chart-qualifier-check v1: limitation words unmatched in the finding', () => {
  it('the cloud/resolveProvider shape fires on exactly the unshown word', () => {
    const un = _unq('resolving a cloud provider from a provider identifier',
      'canonicalProviderId(value) maps the identifier and PROVIDERS[id] returns the resolved provider entry');
    assert.ok(un.includes('cloud'), 'cloud is not shown');
    assert.ok(!un.some((w) => /provider|identifier/i.test(w)), 'shown words stay silent');
  });
  it('a fully covered row stays silent; stemming matches inflections', () => {
    assert.deepEqual(_unq('computing a rate', 'computes the rate at line 5'), []);
  });
});

import { rawClaimBlock as _rawBlk, chartScope as _csp } from '../src/commands/claim-chart.js';
import { splitClaimElements as _sce } from '../src/commands/claim-locate.js';

describe('family-split-parity: same claim text, same rows, solo or family', () => {
  const LINEATED = ['1. A widget system, comprising:',
    'a frobnicator being equipped with a gizmo unit for gizmoing,',
    'the gizmo unit is configured to spin; and',
    'a stopper configured to halt the spin.',
    '2. The system of claim 1, wherein the stopper is magnetic.'].join('\n');
  it('rawClaimBlock preserves lineation and bounds at the next claim number', () => {
    const b = _rawBlk(LINEATED, 1);
    assert.ok(b.includes('\n'), 'lineation preserved');
    assert.ok(!b.includes('magnetic'), 'stops before claim 2');
    assert.equal(_rawBlk(LINEATED, 2), 'The system of claim 1, wherein the stopper is magnetic.');
  });
  it('first-claim and family scope split identically to the solo block (the 9-vs-7 invariant)', () => {
    const solo = _rawBlk(LINEATED, 1);
    const a = _sce(solo, { fine: true }).length;
    const b = _sce(_csp(LINEATED, {}).text, { fine: true }).length;
    const c = _sce(_csp(LINEATED, { claim: 1, family: true }).text, { fine: true }).length;
    assert.equal(a, b);
    assert.equal(b, c);
  });
  it('a claim with no internal lineation is unchanged by the parity path', () => {
    const FLAT = '1. A method, comprising: stepping; and halting.\n2. The method of claim 1, wherein halting is soft.';
    assert.ok(!_rawBlk(FLAT, 1).includes('\n'));
    assert.equal(_sce(_csp(FLAT, {}).text, { fine: true }).length, _sce(_rawBlk(FLAT, 1), { fine: true }).length);
  });
});

import { formatFamilySection as _ffs } from '../src/commands/claim-chart.js';

describe('chart-voice-demarcation', () => {
  it('the narrowed row renders three demarcated parts, claim language in italics', () => {
    const fam = { root: 1, members: [{ n: 2, text: 'x', depthLabel: 'D', kind: 'MODIFICATION', cue: 'wherein',
      parent: 1, chain: [1, 2], parentChoice: null,
      inherited: [], analysed: [], dropped: [],
      judged: [{ designation: '[2a]', origin: 'narrowed', own: 'the stopper is magnetic',
        text: 'a stopper configured to halt — as narrowed by claim 2: the stopper is magnetic',
        narrows: '[1c]', parentLabel: 'PRESENT', label: 'PARTIAL', note: 'n', target: 'a.c@f' }],
      get effective() { return this.judged; }, verdictLine: 'v' }] };
    const md = String(_ffs(fam));
    assert.ok(md.includes('_a stopper configured to halt_<br>**as narrowed by claim 2:**<br>_the stopper is magnetic_'),
      'three-part demarcation present');
  });
  it('the chart header carries the voice legend', () => {
    const out = formatChart({ claimText: '1. x', table: '| # | Claim element | CE finding — is the limitation met? | Cited code |\n|---|---|---|---|',
      fills: [], targets: [], engineLabel: 'e', elements: ['x'], scopeNote: null, provenance: null, dropped: [], retrieval: null });
    assert.match(out, /Voices: .*claim language verbatim/);
  });
});

import { renderChartHtml as _rch } from '../src/commands/claim-chart.js';

describe('chart-printable-render: --chart-html', () => {
  const longNote = 'x'.repeat(400) + ' the details of that calculation are not visible here.';
  const html = _rch({
    claimText: '1. A widget system, comprising: a gizmo.',
    fills: [{ element: 1, label: 'PARTIAL', note: longNote, target: 'a.java@A::f', agreement: { total: 30, PARTIAL: 1 }, closest: false }],
    elements: ['a gizmo'], engineLabel: 'test-engine', scopeNote: null, sideScope: 'Two-sided claim: x / y.',
    otherSideElements: new Set([1]), provenance: 'Retrieval: p', connectivity: { targets: 2, depth: 3, groups: [['a'], ['b']] },
    citedDupes: [{ file: 'x.c', twinFile: 'y.c', example: 'f ~ g' }], targets: ['a.java@A::f'],
  });
  it('carries the FULL note (no 160-char amputation) and the qualification survives', () => {
    assert.ok(html.includes('not visible here'), 'the amputated half is present');
    assert.ok(html.includes(longNote.slice(0, 100)));
  });
  it('is self-contained: no external references', () => {
    assert.ok(!/src=|href=|url\(|@import/.test(html), 'no external asset refs');
  });
  it('renders rail, other-side tag, agreement, connectivity and twin disclosures', () => {
    assert.ok(html.includes('other side'));
    assert.ok(html.includes('1 of 30'));
    assert.ok(html.includes('unconnected groups'));
    assert.ok(html.includes('structural near-duplicates'));
  });
  it('the closest-examined label renders only for ABSENT-style fills', () => {
    assert.ok(!html.includes('not a finding'));
    const h2 = _rch({ claimText: 'c', fills: [{ element: 1, label: 'ABSENT', note: 'n', target: 't@t', closest: true }],
      elements: ['e'], engineLabel: 'e' });
    assert.ok(h2.includes('Closest candidate examined'));
  });
});

// chart-html-notes-appendix: analyst commentary is a labeled FOURTH voice.
// What is asserted is demarcation — the standing label, the visual separation,
// no interleaving — never the commentary's content, which is the analyst's.
import { formatNotesSection, CHART_NOTES_LABEL } from '../src/commands/claim-chart.js';
import fsn from 'node:fs';
import osn from 'node:os';
import pathn from 'node:path';

describe('examiner notes appendix (chart-html-notes-appendix)', () => {
  it('markdown section carries the standing label and quotes every line', () => {
    const s = formatNotesSection('First point.\n\nSecond point with `code`.');
    assert.match(s, /^## Examiner's notes/);
    assert.ok(s.includes(CHART_NOTES_LABEL), 'standing label present');
    assert.match(s, /^> First point\.$/m, 'content quoted');
    assert.match(s, /^>$/m, 'blank lines keep the quote rail');
    assert.match(s, /^> Second point with `code`\.$/m);
  });

  it('html page renders the notes block, labeled and escaped; footer names the voice', () => {
    const html = _rch({ claimText: 'c', fills: [], elements: ['e'], engineLabel: 'e',
      notes: 'Watch <script>alert(1)</script> & row 6.' });
    assert.ok(html.includes('class="notes"'), 'notes block present');
    assert.ok(html.includes(CHART_NOTES_LABEL.replace(/&/g, '&amp;')) || html.includes(CHART_NOTES_LABEL),
      'standing label present');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'notes content is escaped');
    assert.ok(html.includes('&lt;script&gt;'), 'escaped form present');
    assert.match(html, /dashed amber box = analyst commentary/, 'voices footer names the fourth voice');
  });

  it('without notes the page has no notes block and the footer is unchanged', () => {
    const html = _rch({ claimText: 'c', fills: [], elements: ['e'], engineLabel: 'e' });
    assert.ok(!html.includes('class="notes"'));
    assert.ok(!html.includes('analyst commentary'));
  });

  it('a missing notes file fails loudly before any model call', async () => {
    const prev = process.exitCode;
    const errs = [];
    const origErr = console.error; console.error = (s) => errs.push(String(s));
    let drafted = 0;
    try {
      await doClaimChart({ functionIndex: {}, _ensureFunctionIndex() {} },
        { claim_chart: '1. A method comprising: a step.', chart_notes: 'no_such_notes_file.md', model: 'f.gguf' },
        { draft: async () => { drafted++; return 'x'; } });
    } finally { console.error = origErr; }
    assert.match(errs.join(' '), /--chart-notes: cannot read no_such_notes_file\.md/);
    assert.equal(drafted, 0, 'failed before any draft call');
    assert.equal(process.exitCode, 1);
    process.exitCode = prev;
  });

  it('an empty notes file is refused, not silently rendered as an empty appendix', async () => {
    const prev = process.exitCode;
    const p = pathn.join(osn.tmpdir(), `ce-empty-notes-${process.pid}.md`);
    fsn.writeFileSync(p, '   \n', 'utf8');
    const errs = [];
    const origErr = console.error; console.error = (s) => errs.push(String(s));
    try {
      await doClaimChart({ functionIndex: {}, _ensureFunctionIndex() {} },
        { claim_chart: '1. A method comprising: a step.', chart_notes: p, model: 'f.gguf' },
        { draft: async () => 'x' });
    } finally { console.error = origErr; fsn.unlinkSync(p); }
    assert.match(errs.join(' '), /--chart-notes: .* is empty/);
    process.exitCode = prev;
  });
});

// chart-html-replay: re-render the page from a verdicts sidecar — the same
// merge replay loop-score performs, handed to the same renderer, plus the
// honest bounds a replay must state. No model, no index, no re-rolled dice.
import { replayChartHtml, sideScopeFromRecorded } from '../src/commands/claim-chart.js';

describe('chart html replay (chart-html-replay)', () => {
  const SIDECAR = {
    _format: 'codeexam-chart-verdicts/1',
    engine: 'Test Engine — stub',
    index: '.stub',
    claimSource: '(inline)',
    claimChars: 0,
    elements: 2,
    generatedAt: '2026-09-04T00:00:00.000Z',
    argv: 'src/index.js --claim-chart @x --verdicts-out y.json',
    claimSides: { parties: ['transmission device', 'reception device'], directional: true,
      perElement: ['transmission device', null] },
    indexSide: { serverRoutes: 0, clientCalls: 0, socketClient: 1, socketServer: 0, verdict: 'client-only' },
    analysed: [
      { target: 'A.java@A::one', nominatedBy: [{ element: 1, rank: 0 }],
        elements: [
          { element: 1, text: 'first element about transmitting', label: 'ABSENT', note: 'no line' },
          { element: 2, text: 'second element about reproducing', label: 'PARTIAL', note: 'line 3 reproduces.' },
        ] },
      { target: 'B.java@B::two', nominatedBy: [{ element: 2, rank: 1 }],
        elements: [
          { element: 1, text: 'first element about transmitting', label: 'ABSENT', note: 'no line' },
          { element: 2, text: 'second element about reproducing', label: 'ABSENT', note: 'no line' },
        ] },
    ],
    family: { root: 1, members: [
      { n: 2, depth: 'D', kind: 'MODIFICATION', cue: 'wherein', parent: 1, chain: [1, 2],
        verdict: 'claim 2 (D): NOT MET', rows: [
          { designation: '[1a]', origin: 'inherited', text: 'first element about transmitting',
            from: 1, parentDesignation: '[1a]', label: 'ABSENT', note: 'no line', target: 'A.java@A::one' },
        ] },
    ] },
  };

  it('replays the merge and renders rows, family, scope, and the re-rendered marker', () => {
    const html = replayChartHtml({ sidecar: SIDECAR, sidecarPath: 'y.json' });
    assert.ok(html.includes('RE-RENDERED from `y.json`'), 're-rendered marker present');
    assert.ok(html.includes('second element about reproducing'), 'element text recovered from analysed rows');
    assert.match(html, /PARTIAL/, 'merged verdict rendered (strongest label wins)');
    assert.ok(html.includes('Two-sided claim: transmission device / reception device'),
      'side scope rebuilt from recorded halves');
    assert.ok(html.includes('This index is CLIENT-ONLY'));
    assert.ok(html.includes('Dependent claims (family of claim 1)'), 'family section rendered');
    assert.ok(html.includes('not recorded in the sidecar'), 'unrecorded sections stated, not silently omitted');
    assert.ok(html.includes('claim source not readable') || html.includes('(inline'),
      'inline claim source falls back with a stated bound');
  });

  it('attaches post-hoc examiner notes with the standing label', () => {
    const html = replayChartHtml({ sidecar: SIDECAR, sidecarPath: 'y.json', notes: 'Across N runs, row 2 wobbled.' });
    assert.ok(html.includes('class="notes"'));
    assert.ok(html.includes(CHART_NOTES_LABEL));
    assert.ok(html.includes('Across N runs, row 2 wobbled.'));
  });

  it('refuses a sidecar with nothing to replay', () => {
    assert.throws(() => replayChartHtml({ sidecar: { analysed: [] } }), /nothing to replay/);
  });

  it('sideScopeFromRecorded reproduces the live paragraph from recorded halves', () => {
    const { sideScope, otherSideElements, otherParty } = sideScopeFromRecorded(
      SIDECAR.claimSides, SIDECAR.indexSide);
    assert.equal(otherParty, 'transmission device');
    assert.deepEqual([...otherSideElements], [1]);
    assert.match(sideScope, /^Two-sided claim: transmission device \/ reception device\./);
    assert.match(sideScope, /Rows attributed to the transmission device \(1\)/);
  });
});
