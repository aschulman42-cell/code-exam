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
  perElementTargets, normalizeVerdictLine, perElementTargetsWithStats, resolveTargetBudget,
} from '../src/commands/claim-chart.js';
import { targetsChecksum } from '../src/commands/claim-locate.js';
import { engineBuildLine, getEngineBuild, formatEngineBuild } from '../src/core/llm-runner.js';
import { createRequire } from 'node:module';
import { readClaimFile, addLineNumbers } from '../src/commands/analyze.js';
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
    assert.match(rows[0], /^\| 1 \| first limitation here \|/);
    assert.match(rows[2], /^\| 3 \| third one \|/);
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
