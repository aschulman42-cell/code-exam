// test_concepts.js — --concepts: the concepts on their own, each one's top files, its mechanisms as what to hunt for, one concept in full, the cap, test code
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// issue-364-concepts-cli (#364, parts B1, B2, B6). A small corpus of seven domains, each a made-up
// word used inside compound names over and over (so that the word is a concept), a test file that
// names one of them, and the index built twice: once with a mechanisms file and once without. Every
// assertion reads the command's output and compares it with what the functions underneath give:
// the Overview's concepts, the density's per-term files, and the rows --toc <word> lists.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { buildMechanismsIndex, saveMechanismsIndex, loadMechanismsIndex, foldRecords, filterRecords, withoutTestEntries, isTestEntry } from '../src/core/mechanisms-index.js';
import { harvestPurpose } from '../src/commands/pseudo-claims.js';
import { buildOverview } from '../src/core/overview.js';
import { extractConcepts, conceptLabel, CONCEPT_NAMES, KEY_FILE_NAMES } from '../src/core/vocabulary.js';
import { TESTS_OUT_BY_DEFAULT_KEYS } from '../src/core/test-paths.js';
import { parseArgs as parseProcessArgs } from '../src/argparse.js';

// parseArgs reads process.argv: set it for one call.
const parseArgs = (argv) => { const saved = process.argv; process.argv = ['node', 'ce', ...argv]; try { return parseProcessArgs(); } finally { process.argv = saved; } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'index.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-concepts-'));
const SRC = path.join(TMP, 'src');
const IDX = path.join(TMP, '.concepts_ndx');          // with a mechanisms file
const IDX_NOMECH = path.join(TMP, '.concepts_bare');  // without one

const VERBS = ['post', 'seal', 'audit', 'void', 'open'];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
// A domain is a word used inside compound names and, for all but one, alone in the comments (so it
// is a vocabulary term itself). `gribble` is never written alone: it is a concept only as a part
// of postGribbleRecord and its kin, so it is not one of the top vocabulary terms.
const DOMAINS = ['zorble', 'quibbit', 'frobnic', 'wumpus', 'snarfle', 'blorple', 'gribble'];
const domainFile = (d, noun, bare) => {
  const D = cap(d);
  let t = `// ${bare ? d : 'this domain'}.js: handles the ${bare ? d : 'domain'} ${noun}s.\n`;
  for (const v of VERBS) {
    const calls = VERBS.filter((x) => x !== v).slice(0, 2).map((x) => `${x}${D}${cap(noun)}(a, b);`).join(' ');
    t += `export function ${v}${D}${cap(noun)}(a, b) {\n  // ${v} the ${bare ? d : 'domain'} ${noun}\n  const r = a + b;\n  ${calls}\n  return r;\n}\n`;
  }
  return t;
};
const FILES = {};
for (const d of DOMAINS) {
  // The same names in two files: a vocabulary token must be in at least two documents.
  FILES[`src/${d}/${d}.js`] = domainFile(d, 'record', d !== 'gribble');
  FILES[`src/${d}/${d}_more.js`] = domainFile(d, 'record', d !== 'gribble').replace(/^\/\/.*\n/, '// more of the same.\n');
}
FILES['tests/test_zorble.js'] = VERBS.map((v) => `export function test_${v}ZorbleRecord(a, b) {\n  // tests ${v} of a zorble record\n  const r = a + b;\n  return r;\n}\n`).join('\n');

// A mechanism that carries the word quibbit only by its file's path: nothing in its labels or its
// function names does, so `--toc quibbit` lists it and --concepts does not count it.
FILES['src/quibbit/helpers.js'] = ['One', 'Two', 'Three', 'Four'].map((n) => `export function plain${n}(a, b) {\n  // adds two numbers\n  const r = a + b;\n  return r * 3;\n}\n`).join('\n');

// A word that is in many files and names nothing: a word in an ordinary comment at the head of
// the file. It ranks as a concept because it is widespread, and no mechanism is named for it. Half
// the files carry it: put in every file of this fixture it did not come out as a concept.
// issue-351-header-words-out-of-vocabulary (2026-11-23): this line used to stand for a holder's name
// in a header, the defect of #351 (a), which is now not counted. The line has no notice marker
// (Copyright, (c) and a year, SPDX, Licensed under) and is not a bare URL, so it is an ordinary
// comment and still ranks; the test keeps the behaviour it tests (a concept that names nothing)
// without depending on the header rule. test_vocabulary.js has the header cases.
Object.keys(FILES).forEach((k, i) => { if (i % 2 === 0) FILES[k] = `// kept by Glorfindus.\n${FILES[k]}`; });

function runCLI(indexDir, args) {
  const r = spawnSync(process.execPath, [CLI, '--index-path', indexDir, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}
const nfm = (s) => Number(String(s).replace(/,/g, ''));
/** The concept rows of a listing: [{ n, label, rest, count }] from lines like `  3. zorble (postZorbleRecord): files: ...  (4)`. `count`, the number in brackets at the end, is the mechanisms named for the concept; null when the row has none (no mechanisms file). */
function rowsOf(stdout) {
  return stdout.split(/\r?\n/).map((l) => /^\s{1,3}(\d+)\. (.+?)(?:: (.*?))?(?: {2}\(([\d,]+)\))?$/.exec(l)).filter(Boolean).map((m) => ({ n: Number(m[1]), label: m[2], rest: m[3] || '', count: m[4] == null ? null : nfm(m[4]) }));
}
const wordOf = (label) => label.split(' ')[0];

let idx = null, overview = null, all = null, vocab = null;

describe('--concepts', () => {
  before(async () => {
    for (const [rel, text] of Object.entries(FILES)) {
      const p = path.join(SRC, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    idx = new CodeSearchIndex({ indexPath: IDX });
    await idx.buildIndex(SRC, { showProgress: false });
    const bare = new CodeSearchIndex({ indexPath: IDX_NOMECH });
    await bare.buildIndex(SRC, { showProgress: false });
    const data = buildMechanismsIndex(idx, { indexName: 'fixture', purposeFor: (l, m, g, calls) => harvestPurpose(idx, l, m, g && g.residue, { calls: false, first: !!(g && g.splitFirst), hasCalls: !!(calls && calls.length) }) });
    saveMechanismsIndex(idx, data);
    // as the command and the Overview do it: concepts from the top CONCEPT_NAMES names, files from the top KEY_FILE_NAMES
    const pool = idx.getTopVocabulary(CONCEPT_NAMES);
    vocab = pool.slice(0, KEY_FILE_NAMES);
    overview = buildOverview(idx);
    all = extractConcepts(idx, { entries: pool, maxConcepts: Infinity });
  });
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows holds a handle sometimes */ } });

  // The mechanisms whose label (or a folded record's label) or member function name carries the word.
  const namedFor = (word, includeTests) => {
    const lw = word.toLowerCase();
    const folded = foldRecords(loadMechanismsIndex(idx).records);
    return withoutTestEntries(folded, includeTests).kept.filter((e) => [e.label, ...(e.aliases || []).map((a) => a.label), ...(e.members || []).map((m) => m.name)].some((s) => String(s).toLowerCase().includes(lw)));
  };
  const countFor = (word, includeTests) => namedFor(word, includeTests).length;
  const tocHeader = (word, extra = []) => {
    const r = runCLI(IDX, ['--toc', word, ...extra]);
    const m = /^([\d,]+) mechanisms?\b/m.exec(r.stdout);
    return m ? nfm(m[1]) : 0;
  };

  it('the fixture yields concepts, a zorble among them, one that is not a top vocabulary term, and a mechanisms file with a test mechanism', () => {
    assert.ok(all.length >= 4, all.map(conceptLabel).join(', '));
    assert.ok(all.some((c) => c.concept === 'zorble'), all.map((c) => c.concept).join(', '));
    assert.ok(all.some((c) => !vocab.some((v) => String(v.token).toLowerCase() === c.concept)), 'a concept that is not itself a top term: ' + all.map((c) => c.concept).join(', '));
    const folded = foldRecords(loadMechanismsIndex(idx).records);
    assert.ok(folded.some(isTestEntry), 'a mechanism wholly of test code');
  });

  it('is an option with an optional value, explicit when given, and one of the commands that leave test code out unasked', () => {
    const a = parseArgs(['--ndx', '.x', '--concepts']);
    assert.equal(a.concepts, true);
    assert.ok(a._explicit.has('concepts'));
    assert.equal(parseArgs(['--ndx', '.x', '--concepts', 'zorble']).concepts, 'zorble');
    assert.ok(TESTS_OUT_BY_DEFAULT_KEYS.includes('concepts'));
  });

  describe('the list', () => {
    it('is the Overview\'s concepts, in its order and with its examples, and goes on past the twelve', () => {
      const r = runCLI(IDX, ['--concepts', '--all-results']);
      assert.equal(r.code, 0, r.out);
      const rows = rowsOf(r.stdout);
      assert.deepEqual(rows.map((x) => x.label), all.map(conceptLabel), r.stdout);
      assert.deepEqual(rows.slice(0, overview.concepts.length).map((x) => x.label), overview.concepts.map(conceptLabel), 'the first rows are what --overview prints');
      assert.ok(rows.map((x) => x.n).every((n, i) => n === i + 1), 'numbered from 1');
    });

    it('says in its header what the list is: the Overview\'s concepts, found by counting names with no model, a suggestion and not a finding', () => {
      const r = runCLI(IDX, ['--concepts']);
      const head = r.stdout.split(/\r?\n/).slice(0, 3).join(' ');
      assert.match(head, /concepts/);
      assert.match(head, /Overview/);
      assert.match(head, /no model/);
      assert.match(head, /a suggestion of what to look for, not a finding/);
      assert.doesNotMatch(r.stdout, /—/, 'no em dash in the output');
    });

    it('the cap is the project\'s: 30 by default, --max-results N, --all-results and --max-results 0 for every concept, the notice names both ways to raise it', () => {
      const two = runCLI(IDX, ['--concepts', '--max-results', '2']);
      assert.equal(rowsOf(two.stdout).length, 2, two.stdout);
      assert.match(two.stdout, new RegExp(`\\+${all.length - 2} more concepts \\(use --max-results <N> or --all-results to see all\\)`));
      for (const opt of [['--all-results'], ['--max-results', '0']]) {
        const r = runCLI(IDX, ['--concepts', ...opt]);
        assert.equal(rowsOf(r.stdout).length, all.length, opt.join(' '));
        assert.doesNotMatch(r.stdout, /more concepts/);
      }
      const dflt = runCLI(IDX, ['--concepts']);
      assert.equal(rowsOf(dflt.stdout).length, Math.min(30, all.length));
    });
  });

  describe('each concept\'s files', () => {
    it('are the density\'s data read term to files: a concept that is a top vocabulary term lists the files its score concentrates in, best first', () => {
      const termOf = (c) => vocab.filter((v) => String(v.token).toLowerCase() === c.concept);
      const hit = all.find((c) => termOf(c).length);
      assert.ok(hit, 'the fixture has a concept that is itself a top vocabulary term: ' + all.map((c) => c.concept).join(', '));
      const weight = new Map();
      for (const v of termOf(hit)) for (const f of v.top_files || []) { const file = String(f.path).split('|||')[0]; weight.set(file, (weight.get(file) || 0) + (v.score || 0) * (f.concentration || 0)); }
      const best = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
      const list = runCLI(IDX, ['--concepts', '--all-results', '--full-path']);
      const row = rowsOf(list.stdout).find((x) => wordOf(x.label) === hit.concept);
      assert.match(row.rest, /files: /);
      assert.ok(row.rest.includes(path.basename(best)), `${best} in ${row.rest}`);
      const full = runCLI(IDX, ['--concepts', hit.concept, '--full-path']);
      assert.match(full.stdout, /Files/);
      assert.ok(full.stdout.includes(path.basename(best)), full.stdout);
    });

    it('a concept that is not one of those terms has no files part in its row, one line under the header says how many rows have files and why, and its full view says so in one sentence pointing to --search', () => {
      const miss = all.find((c) => !vocab.some((v) => String(v.token).toLowerCase() === c.concept));
      assert.ok(miss, 'the fixture has a concept that is not a top vocabulary term: ' + all.map((c) => c.concept).join(', '));
      const list = runCLI(IDX, ['--concepts', '--all-results']);
      const row = rowsOf(list.stdout).find((x) => wordOf(x.label) === miss.concept);
      assert.doesNotMatch(row.rest, /files/);
      assert.doesNotMatch(row.rest, /\.js/);
      assert.doesNotMatch(list.stdout, /not among the top vocabulary terms, so no files/, 'not repeated down the page');
      const withFiles = rowsOf(list.stdout).filter((x) => /files: /.test(x.rest)).length;
      assert.ok(withFiles > 0 && withFiles < all.length);
      assert.match(list.stdout, new RegExp(`Files are shown for ${withFiles} of the ${all.length} rows listed\\. Files are listed only where the concept is itself one of the top vocabulary terms`));
      assert.doesNotMatch(list.stdout, /splitClaimElements/, 'the example of a part of a longer name comes from this index, not from CodeExam');
      const full = runCLI(IDX, ['--concepts', miss.concept]);
      assert.match(full.stdout, /Files: none are listed, because this word is a part of longer names/);
      assert.match(full.stdout, new RegExp(`--search ${miss.concept} finds where it is`));
    });
  });

  describe('as something to hunt for', () => {
    it('the count of mechanisms is of those whose label or member function name carries the word, test mechanisms left out, and the row says what it is', () => {
      const list = runCLI(IDX, ['--concepts', '--all-results']);
      const rows = rowsOf(list.stdout);
      let checked = 0;
      for (const row of rows) {
        // the count is the bare number in brackets at the end of the row; what it is, is said once in the header
        assert.notEqual(row.count, null, `${row.label}: ${row.rest}`);
        assert.equal(row.count, countFor(wordOf(row.label), false), `${wordOf(row.label)}: the count`);
        assert.doesNotMatch(`${row.label} ${row.rest}`, /named for it|mechanisms?\b/, 'the phrase is not repeated on every row');
        checked++;
      }
      assert.equal(checked, all.length);
      assert.match(list.stdout, /^The number in brackets at the end of a row is how many mechanisms are named for the concept: those whose label or a member function name carries the word/m);
      assert.match(list.stdout, /whose label or a member function name carries the word/);
      assert.match(list.stdout, /--toc <word> and --mechanisms <word> list those and also any mechanism whose file path, purpose or description carries the word, so they may list more/);
      assert.doesNotMatch(list.stdout, /counts? (match|equal)/);
    });

    it('a concept that no mechanism is named for says so, in the list and in full, and is not sent to the commands that go by names', () => {
      // Andrew, 2026-11-23: `schulman` and `aschulman42` were among CodeExam's concepts (his name,
      // from every file's header), and `--concepts schulman` suggested --carve, which shows nothing for it.
      const list = runCLI(IDX, ['--concepts', '--all-results']);
      const unnamed = rowsOf(list.stdout).filter((x) => x.count === 0);
      assert.ok(unnamed.length >= 1, `the fixture has a concept that names nothing:\n${list.stdout}`);
      assert.match(list.stdout, new RegExp(`^${unnamed.length} of the rows listed ha(s|ve) no mechanism named for (it|them) \\(0\\)\\. Such a word is in the code's text \\(comments, strings, file headers, names that are not functions\\) and in no mechanism's label or function names\\. It may be boilerplate`, 'm'));
      assert.match(list.stdout, /For a word that no mechanism is named for, only --search will find anything\./);
      const word = wordOf(unnamed[0].label);
      const one = runCLI(IDX, ['--concepts', word]);
      assert.match(one.stdout, /Mechanisms: 0 named for it/);
      assert.match(one.stdout, /Such a word is in the code's text/);
      assert.match(one.stdout, new RegExp(`--search ${word}\\b`));
      assert.match(one.stdout, /Not offered for this word: --mechanisms, --carve and the pseudo-claims candidates/);
      assert.doesNotMatch(one.stdout, /--carve calls/);
      assert.doesNotMatch(one.stdout, new RegExp(`--mechanisms ${word}\\b`));
      // a concept that does name mechanisms keeps every suggestion
      const named = rowsOf(list.stdout).find((x) => x.count > 0);
      const two = runCLI(IDX, ['--concepts', wordOf(named.label)]);
      assert.match(two.stdout, /--carve calls/);
      assert.doesNotMatch(two.stdout, /Not offered for this word/);
    });

    it('a mechanism that carries the word only in its file path is not counted, though --toc <word> lists it', () => {
      const named = namedFor('quibbit', false);
      const toc = tocHeader('quibbit');
      assert.ok(toc > named.length, `--toc quibbit lists ${toc}, the names carry it in ${named.length}`);
      const r = runCLI(IDX, ['--concepts', 'quibbit']);
      assert.equal(nfm(/Mechanisms: ([\d,]+) named for it/.exec(r.stdout)[1]), named.length);
      const tocIds = [...runCLI(IDX, ['--toc', 'quibbit']).stdout.matchAll(/^\s*\d+\.\s+(m\d+)\s/gm)].map((m) => m[1]);
      const pathOnly = tocIds.filter((id) => !named.some((e) => e.id === id));
      assert.ok(pathOnly.length >= 1, 'a mechanism listed by --toc only');
      for (const id of pathOnly) assert.ok(!new RegExp(`\\b${id}\\b`).test(r.stdout), `${id} is not named for quibbit`);
      for (const e of named) assert.ok(r.stdout.includes(e.id), e.id);
    });

    it('--include-tests counts the test mechanisms too; without it the closing Tip says how many were left out', () => {
      const word = all.map((c) => c.concept).find((w) => countFor(w, true) > countFor(w, false));
      assert.ok(word, 'a concept with a test mechanism');
      const without = runCLI(IDX, ['--concepts', word]);
      assert.match(without.stdout, /Tip: [\d,]+ mechanisms? of test, benchmark, mock and example code left out; --include-tests lists (it|them)\./);
      assert.ok(without.stdout.trimEnd().split(/\r?\n/).pop().startsWith('Tip: '), 'the Tip is the last line');
      const withTests = runCLI(IDX, ['--concepts', word, '--include-tests']);
      assert.doesNotMatch(withTests.stdout, /Tip: /);
      const header = (s) => nfm(/Mechanisms: ([\d,]+)/.exec(s)[1]);
      assert.equal(header(without.stdout), countFor(word, false));
      assert.equal(header(withTests.stdout), countFor(word, true));
      const left = nfm(/Tip: ([\d,]+) mechanism/.exec(without.stdout)[1]);
      assert.equal(left, countFor(word, true) - countFor(word, false), 'the Tip counts the test mechanisms that carry the word');
    });

    it('the list names the commands that take a concept as a filter, among them --mechanisms, --toc, --carve (with the advice to search its output), the pseudo-claims candidates --filter and --search', () => {
      const r = runCLI(IDX, ['--concepts']);
      for (const s of ['--mechanisms <word>', '--toc <word>', '--carve calls', '--carve clusters', '--pseudo-claims --candidates', '--filter <word>', '--search <word>']) assert.ok(r.stdout.includes(s), `${s} in:\n${r.stdout}`);
      assert.match(r.stdout, /search (its|the) output for the word/);
    });

    it('with no mechanisms file the rows leave the count out and one line says how to build it', () => {
      const r = runCLI(IDX_NOMECH, ['--concepts']);
      assert.equal(r.code, 0, r.out);
      const rows = rowsOf(r.stdout);
      assert.ok(rows.length >= 3);
      for (const row of rows) { assert.doesNotMatch(row.rest, /mechanism/, row.label); assert.equal(row.count, null, `${row.label}: no count without a mechanisms file`); }
      const lines = r.stdout.split(/\r?\n/).filter((l) => /--build-mechanisms/.test(l));
      assert.equal(lines.length, 1, r.stdout);
      assert.match(lines[0], /not built: run .*--build-mechanisms/);
      assert.doesNotMatch(r.stdout, /Tip: /);
    });
  });

  describe('--concepts <word>', () => {
    it('one concept: shows it in full, its example, its files, and its mechanisms by id and label as --toc names them', () => {
      const r = runCLI(IDX, ['--concepts', 'zorble']);
      assert.equal(r.code, 0, r.out);
      const zorble = all.find((c) => c.concept === 'zorble');
      assert.ok(r.stdout.includes(`zorble (${zorble.example})`), r.stdout);
      assert.match(r.stdout, /Mechanisms: [\d,]+ named for it/);
      const named = namedFor('zorble', false);
      assert.ok(named.length >= 2, 'mechanisms named for zorble');
      const shownIds = [...r.stdout.matchAll(/^ {4}(m\d+)\s/gm)].map((m) => m[1]);
      assert.deepEqual(shownIds, named.map((e) => e.id), 'exactly the counted mechanisms, in --toc\'s order');
      assert.match(r.stdout, /Example: /);
      assert.match(r.stdout, /Files/);
    });

    it('a filter that matches several concepts lists those rows, in the Overview\'s order, and does not show any in full', () => {
      const several = runCLI(IDX, ['--concepts', '/zorble|quibbit/']);
      assert.equal(several.code, 0, several.out);
      const labels = rowsOf(several.stdout).map((x) => wordOf(x.label));
      assert.deepEqual(labels, all.map((c) => c.concept).filter((w) => /zorble|quibbit/i.test(w)));
      assert.ok(labels.length >= 2, several.stdout);
      assert.doesNotMatch(several.stdout, /Mechanisms: /);
    });

    it('a word that is not one of the index\'s concepts gets a plain sentence naming --vocabulary and --search, exit code 0', () => {
      const r = runCLI(IDX, ['--concepts', 'zzznothing']);
      assert.equal(r.code, 0, r.out);
      assert.match(r.stdout, /'zzznothing' is not one of this index's \d+ concepts\./);
      assert.match(r.stdout, /--vocabulary/);
      assert.match(r.stdout, /--search/);
      assert.equal(rowsOf(r.stdout).length, 0);
    });

    it('--filter does what the value does, as in --toc', () => {
      const a = runCLI(IDX, ['--concepts', '--filter', 'quibbit']);
      const b = runCLI(IDX, ['--concepts', 'quibbit']);
      assert.equal(a.stdout, b.stdout);
    });
  });

  it('--exclude-tests draws no "does nothing" note: --concepts leaves test mechanisms out already', () => {
    const r = runCLI(IDX, ['--concepts', '--exclude-tests']);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.stderr, /does nothing here/);
  });
});
