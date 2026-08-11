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
  perElementTargets,
} from '../src/commands/claim-chart.js';
import { targetsChecksum } from '../src/commands/claim-locate.js';
import { createRequire } from 'node:module';
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
