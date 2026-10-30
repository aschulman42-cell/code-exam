// test_rubric_score.js — rubric-score: the page and artifact parsers, cite matching, MET/PARTIAL/ABSENT, surplus bins, the sidecar read
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// issue-353-rubric-score-script (#353 part (e), 2026-10-30). The fixtures under
// test/fixtures/rubric/ pin the page format (claim markers, the citations
// table and its legend) and the artifact format (the claim paragraph, the
// numbered dependents, the cited-anchor lines with a zip! prefix).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRubricPage, parseCites, parseRunArtifact, fromSidecar, scoreClaim, scoreRubric,
  contentStems, overlapRatio, formatRubricScorecard, summaryLine, RUBRIC_MET_OVERLAP,
} from '../src/core/rubric-score.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(HERE, 'fixtures', 'rubric');
const PAGE = fs.readFileSync(path.join(FX, 'rubric.md'), 'utf8');
const RUN = fs.readFileSync(path.join(FX, 'run.txt'), 'utf8');
const SIDE = fs.readFileSync(path.join(FX, 'run.anchors.json'), 'utf8');

describe('parseRubricPage: the claim set and the citations table', () => {
  const r = parseRubricPage(PAGE);
  it('finds the set, the title and seven rows in order', () => {
    assert.equal(r.set, 'X');
    assert.match(r.title, /widget filter/);
    assert.deepEqual(r.rows.map((x) => x.id), ['1 preamble', '1(a)', '1(b)', '1(c)', '1 wherein', '2', '3']);
    assert.deepEqual(r.rows.map((x) => x.kind), ['preamble', 'element', 'element', 'element', 'wherein', 'dependent', 'dependent']);
    assert.match(r.rows[2].text, /^discarding every widget whose weight exceeds a threshold weight, the threshold being read from a configuration file;$/);
    assert.match(r.rows[5].text, /^The method of claim 1, in which the threshold weight defaults to forty/);
  });
  it('resolves legend keys, path cites, continued ranges, named functions and whole files', () => {
    assert.deepEqual(r.legend, { wf: 'src/widgets/filter.js', cf: 'src/config.js' });
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x.cites]));
    assert.deepEqual(by['1 preamble'], [{ file: 'docs/WIDGETS.md', base: 'WIDGETS.md', start: 3, end: 5, func: null }]);
    assert.deepEqual(by['1(a)'], [
      { file: 'src/widgets/filter.js', base: 'filter.js', start: 10, end: 24, func: null },
      { file: 'src/widgets/filter.js', base: 'filter.js', start: null, end: null, func: 'loadCatalog' },
    ]);
    assert.equal(by['1(b)'].length, 4);
    assert.deepEqual(by['1(c)'].map((c) => [c.start, c.end]), [[50, 70], [72, 80]], 'a bare range continues the previous file');
    assert.deepEqual(by['1 wherein'], [{ file: 'src/widgets/filter.js', base: 'filter.js', start: null, end: null, func: null }], 'a legend key alone is the whole file');
    assert.deepEqual(by['3'][1], { file: 'src/widgets/cache.js', base: 'cache.js', start: null, end: null, func: 'writeSidecar' });
    assert.deepEqual(r.warnings, []);
  });
  it('warns about a row with no table entry and a key it does not understand', () => {
    const page = PAGE.replace('| X2 | `cf:5-9` | C |\n', '| Y2 | `cf:5-9` | C |\n| X9 | `cf:1` | C |\n');
    const w = parseRubricPage(page).warnings;
    assert.ok(w.some((x) => /X9 has no claim text/.test(x)), w.join('; '));
    assert.ok(w.some((x) => /Y2 is not set X/.test(x)));
    assert.ok(w.some((x) => /^2: no cites/.test(x)));
  });
  it('parseCites skips what it does not understand and keeps order', () => {
    const cites = parseCites('`vo:604-620` (score), `vo:277-291` (`_crossCorpusWeight`); `nope`; `1199-1200`', { vo: 'src/core/vocabulary.js' });
    assert.deepEqual(cites.map((c) => [c.base, c.start, c.end, c.func]), [
      ['vocabulary.js', 604, 620, null], ['vocabulary.js', 277, 291, null], ['vocabulary.js', null, null, '_crossCorpusWeight'],
      ['vocabulary.js', null, null, 'nope'], ['vocabulary.js', 1199, 1200, null],
    ]);
  });
});

describe('parseRunArtifact and fromSidecar: the same shape from either', () => {
  const run = parseRunArtifact(RUN);
  it('reads the claims, their prose, dependents and anchors, stripping the zip prefix', () => {
    assert.equal(run.claims.length, 2);
    const c = run.claims[0];
    assert.equal(c.n, 1);
    assert.equal(c.label, 'filter (discardHeavy)');
    assert.match(c.prose, /^A method of filtering a catalog of widgets, comprising: receiving/);
    assert.deepEqual(c.dependents.map((d) => d.n), [2, 3, 4]);
    assert.equal(c.anchors.length, 4);
    assert.deepEqual(c.anchors[0], { file: 'proj/src/widgets/filter.js', base: 'filter.js', func: 'loadCatalog', start: 10, end: 24, kind: 'func', element: 'receiving a catalog of widgets each having a name and a weight' });
    assert.deepEqual(c.anchors[3], { file: 'proj/src/config.js', base: 'config.js', func: '', start: 5, end: 9, kind: 'constant', element: 'the threshold weight defaults to forty' });
    assert.equal(run.claims[1].dependents.length, 0);
    assert.equal(run.claims[1].anchors[0].func, 'send');
  });
  it('the sidecar read equals the artifact read on the same run', () => {
    const side = fromSidecar(SIDE);
    assert.deepEqual(side.claims.map((c) => [c.n, c.label, c.prose, c.dependents, c.anchors]),
      run.claims.map((c) => [c.n, c.label, c.prose, c.dependents, c.anchors]));
  });
});

describe('scoreRubric: verdicts, surplus bins, the best claim', () => {
  const rubric = parseRubricPage(PAGE);
  const run = parseRunArtifact(RUN);
  it('content stems drop boilerplate and short words, and the overlap is the row\'s share', () => {
    assert.deepEqual([...contentStems('The method of claim 1, wherein the widgets are ranked by names')].sort(), ['name', 'rank', 'widget']);
    assert.deepEqual([...contentStems('configuration configured identification identified entries entry')].sort(), ['configu', 'entry', 'identif']);
    // row stems: rank, remain, widget, name, length; the text shares four of the five
    assert.equal(overlapRatio('ranking the remaining widgets by name length', 'sorting the remaining widgets by the length of the name'), 0.8);
  });
  it('considers only claims whose anchors touch the rubric\'s files, and scores claim 1 of the fixture as expected', () => {
    const res = scoreRubric(rubric, run);
    assert.deepEqual(res.considered, [1], 'the mailer claim cites no rubric file');
    const sc = res.best;
    const v = Object.fromEntries(sc.verdicts.map((x) => [x.id, x]));
    assert.equal(v['1(a)'].verdict, 'MET');            // cited loadCatalog's lines, and said it
    assert.equal(v['1(b)'].verdict, 'MET');            // discardHeavy's lines and the config constant
    assert.equal(v['1(c)'].verdict, 'MET');            // rankByName's lines overlap 50-70; "ranking … ten longest names" said
    assert.equal(v['1 preamble'].verdict, 'PARTIAL');  // said (filtering widgets, catalog) but the doc cite is not in the run
    assert.equal(v['1 wherein'].verdict, 'ABSENT');    // the whole-file cite matches, but "without a language model" is never said
    assert.equal(v['1 wherein'].citeMatch, true);
    assert.equal(v['2'].verdict, 'MET');               // the constant anchor overlaps cf:5-9 and dependent 2 says it
    assert.equal(v['3'].verdict, 'ABSENT');            // no cache.js anchor, nothing about a sidecar
    assert.ok(v['1(c)'].overlap >= RUBRIC_MET_OVERLAP);
    assert.match(v['1(b)'].citedBy.join(','), /filter\.js@discardHeavy/);
    assert.deepEqual(sc.totals.claim1, { rows: 5, MET: 3, PARTIAL: 1, ABSENT: 1 });
    assert.deepEqual(sc.totals.dependents, { rows: 2, MET: 1, PARTIAL: 0, ABSENT: 1 });
    // a cite with next to no words in common is ABSENT, not PARTIAL
    const rb2 = parseRubricPage(PAGE.replace('(c) ranking the remaining widgets by name length and reporting the ten longest names,', '(c) computing a checksum over the archive manifest and verifying it against the ledger,'));
    const v2 = Object.fromEntries(scoreRubric(rb2, run).best.verdicts.map((x) => [x.id, x]));
    assert.equal(v2['1(c)'].citeMatch, true);
    assert.equal(v2['1(c)'].verdict, 'ABSENT');
  });
  it('bins the surplus: a grounded substantive element, and ungrounded dependents', () => {
    const sc = scoreRubric(rubric, run).best;
    const bins = Object.fromEntries(sc.surplus.map((s) => [s.source, s.bin]));
    // "emitting a report of the ten longest names together with a timestamp" reaches 1(c) at
    // the floor? It shares report/ten/longest/name with 1(c): 4 of 1(c)'s stems, below 0.5 of
    // 1(c)'s nine, and 1(c)'s stems are the denominator — so it is surplus; grounded through
    // rankByName's note? No: the note is about sorting. Ungrounded, substantive text.
    assert.equal(bins['claim 1 dependent 3'], 'ungrounded', 'JSON report: nothing in the rubric, no anchor note');
    assert.equal(bins['claim 1 dependent 4'], 'ungrounded', 'compressed archive: nothing in the rubric');
    assert.ok(sc.totals.surplus.total >= 2);
    assert.equal(sc.totals.surplus.total, sc.totals.surplus['grounded-substantive'] + sc.totals.surplus['grounded-trivial'] + sc.totals.surplus.ungrounded);
  });
  it('the injected splitter and classifier are used', () => {
    const splitElements = () => ['receiving a catalog of widgets each having a name and a weight'];
    let classified = 0;
    const classify = () => { classified++; return 'generic'; };
    const sc = scoreClaim(rubric, run.claims[0], { splitElements, classify });
    assert.equal(sc.claim.elements, 1);
    assert.ok(classified >= 1);
    assert.ok(sc.surplus.every((s) => s.bin !== 'grounded-substantive'));
  });
  it('--claims restricts the pool; a claim that meets nothing is considered but never best', () => {
    const res = scoreRubric(rubric, run, { claims: [2] });
    assert.deepEqual(res.considered, [2]);
    assert.equal(res.scored[0].totals.MET, 0);
    assert.equal(res.best, null, 'the mailer claim meets no row');
    assert.match(formatRubricScorecard(rubric, 'r.txt', res), /1 claim\(s\) cite code the rubric cites \(2\) but none meets or partly meets a row/);
    assert.match(summaryLine('r.txt', res), /^\| r\.txt \| none \| — \| — \| — \| — \| 1 \|$/);
    const none = scoreRubric(rubric, { claims: [run.claims[1]] });
    assert.deepEqual(none.considered, [], 'no anchor of the mailer claim matches a rubric cite');
    assert.match(formatRubricScorecard(rubric, 'r.txt', none), /No run claim cites code the rubric cites/);
  });
  it('renders a scorecard and a summary line', () => {
    const res = scoreRubric(rubric, run);
    const md = formatRubricScorecard(rubric, 'run.txt', res);
    assert.match(md, /^## run\.txt against Pseudo-claims for the widget filter \(fixture\) \(Set X\)/);
    assert.match(md, /### Claim 1 — filter \(discardHeavy\): MET 4 · PARTIAL 1 · ABSENT 2 of 7 rows/);
    assert.match(md, /\| 1\(b\) \| MET \| \d+% \| filter\.js@discardHeavy, config\.js@L5-9 \| claim 1 element 3 \|/);
    assert.match(md, /- ungrounded: claim 1 dependent 3/);
    assert.match(summaryLine('run.txt', res), /^\| run\.txt \| 1 \(filter \(discardHeavy\)\) \| 4 \| 1 \| 2 \| \d+ \/ \d+ \/ \d+ \| 1 \|$/);
  });
});
