// test_mechanisms_index.js — the mechanisms index: the cover build (every function in a record, overlap, tags, labels), the harvester's doc readers on real files, save/load, --build-mechanisms and --mechanisms through the CLI, the list_mechanisms tool, --describe on a stub drafter
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// mechanisms-index-prebuild-cli-gui (#359, #284). A small mixed corpus --
// a Python package whose docs are all docstrings (the shape that left
// AI_Manning's list 106 of 146 rows blank on 2026-11-03), a JavaScript module
// with JSDoc, a file with no docs at all, a test file, and two files sharing
// a basename -- built into a real index, then every surface read against it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { buildMechanismsIndex, saveMechanismsIndex, loadMechanismsIndex, mechanismsPath, filterRecords, formatMechanismsList, notBuiltLine, kindOf, estimateBuildMinutes, carryDescriptions, MECHANISMS_FORMAT } from '../src/core/mechanisms-index.js';
import { harvestPurpose, firstSentence } from '../src/commands/pseudo-claims.js';
import { describeMechanisms, describePack, cleanDescription } from '../src/commands/mechanisms.js';
import { handleTool, TOOLS, setIndex } from '../src/mcp-server.js';
import { CURATED_LOCAL_CHAT_TOOLS } from '../src/core/local-chat-tools.js';
import { outboundCalls } from '../src/core/mechanism-grouper.js';
import { findCallees } from '../src/core/calls.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'index.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mechanisms-'));
const SRC = path.join(TMP, 'src');
const IDX = path.join(TMP, '.mech_ndx');       // in-process build, save, load
const IDX2 = path.join(TMP, '.mech_cli_ndx');  // the CLI and the MCP tool, not-built first

const FILES = {
  'pkg/parser.py': [
    '"""parser.py -- tokenizes claim text into elements and resolves each element against the symbol table of an index, so a chart row can cite the function it reads on."""',
    'import re',
    '',
    'class Tokenizer:',
    '    """Splits claim text into tokens, keeping the numbering of each element."""',
    '',
    '    def __init__(self, text):',
    '        self.text = text',
    '        self.n = 0',
    '        self.done = False',
    '',
    '    def tokenize(self):',
    '        """Return the tokens of the text."""',
    '        out = []',
    '        for part in self.text.split():',
    '            out.append(part)',
    '        return out',
    '',
    '    def tally_tokens(self):',
    '        n = 0',
    '        for _ in self.tokenize():',
    '            n += 1',
    '        return n',
    '',
    '    def head(self):',
    '        toks = self.tokenize()',
    '        if not toks:',
    '            return None',
    '        return toks[0]',
    '',
    '',
    'def resolve_element(element, table):',
    '    """Find the symbol an element names.',
    '',
    '    Returns None when nothing matches.',
    '    """',
    '    for name in table:',
    '        if name in element:',
    '            return name',
    '    return None',
    '',
    '',
    'def chart_row(element, table):',
    '    name = resolve_element(element, table)',
    '    if name is None:',
    '        return (element, "ABSENT")',
    '    return (element, name)',
    '',
  ].join('\n'),
  'pkg/nodoc.py': [
    'import os',
    '',
    'def gamma_one(a):',
    '    """Gamma does a thing. And then another."""',
    '    b = a + 1',
    '    c = b + 1',
    '    return c',
    '',
    '',
    'def delta_two(a):',
    '    """Delta does another thing."""',
    '    b = a - 1',
    '    c = b - 1',
    '    return c',
    '',
  ].join('\n'),
  'pkg/__init__.py': ['def one_pkg():', '    a = 1', '    b = 2', '    return a + b', ''].join('\n'),
  'other/__init__.py': ['def one_other():', '    a = 3', '    b = 4', '    return a + b', ''].join('\n'),
  'lib/stream.js': [
    '/**',
    ' * stream.js — reads a JSON document in chunks and yields one top-level value at a time, so a multi-gigabyte index file never sits in memory whole.',
    ' * https://example.org/not-a-purpose',
    ' * Co-authored with Someone.',
    ' */',
    "import fs from 'node:fs';",
    '',
    '/** Opens the file and yields values. */',
    'export class Reader {',
    '  constructor(file) {',
    '    this.file = file;',
    '    this.pos = 0;',
    '    this.open = true;',
    '  }',
    '  /** Reads the next chunk. */',
    '  next() {',
    '    const buf = fs.readFileSync(this.file);',
    '    this.pos += buf.length;',
    '    return buf;',
    '  }',
    '  done() {',
    '    const b = this.next();',
    '    this.open = b.length > 0;',
    '    return !this.open;',
    '  }',
    '}',
    '',
    '// Totals the lengths of the chunks a reader yields.',
    'export function total(reader) {',
    '  let n = 0;',
    '  while (!reader.done()) n += reader.next().length;',
    '  return n;',
    '}',
    '',
  ].join('\n'),
  'lib/bare.js': [
    'export function alphaOne(a) {',
    '  const r = helperOutside(a);',
    '  const s = r + 1;',
    '  return s;',
    '}',
    'export function betaTwo(b) {',
    '  const r = helperOutside(b);',
    '  const s = r + 2;',
    '  return s;',
    '}',
    'export function helperOutside(x) {',
    '  const y = x * 2;',
    '  const z = y + 0;',
    '  return z;',
    '}',
    '',
  ].join('\n'),
  // build-mechanisms-reads-by-span: two nested functions share a name; the
  // second calls a different helper, so a read by name (the first `walk` in
  // the file) and a read by span (its own range) disagree.
  'lib/dupe.js': [
    '// dupe.js -- two outer functions each define a walk of their own.',
    'function helperA() { return 1; }',
    'function helperB() { return 2; }',
    'export function outerOne() {',
    '  function walk(n) {',
    '    // walks one',
    '    return helperA() + n;',
    '  }',
    '  return walk(1);',
    '}',
    'export function outerTwo() {',
    '  function walk(n) {',
    '    // walks two',
    '    return helperB() + n;',
    '  }',
    '  return walk(2);',
    '}',
    '',
  ].join('\n'),
  'tests/test_parser.py': [
    'from pkg.parser import Tokenizer',
    '',
    '',
    'def test_tokenize():',
    '    t = Tokenizer("a b")',
    '    toks = t.tokenize()',
    '    assert toks == ["a", "b"]',
    '',
    '',
    'def test_tally():',
    '    t = Tokenizer("a b")',
    '    n = t.tally_tokens()',
    '    assert n == 2',
    '',
  ].join('\n'),
};

function runCLI(indexDir, args) {
  const r = spawnSync(process.execPath, [CLI, '--index-path', indexDir, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  return { out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '', code: r.status };
}

let idx = null;
const byLabel = (data, label) => data.records.find((r) => r.label === label);
const memberOf = (idx_, file, name) => {
  idx_._ensureFunctionIndex();
  const key = Object.keys(idx_.functionIndex).find((f) => f.replace(/\\/g, '/').endsWith(file));
  const info = idx_.functionIndex[key][name];
  return { id: `${key}@${name}`, file: key, name, bare: name.split('::').pop(), start: info.start, end: info.end, lines: info.end - info.start + 1 };
};

describe('the mechanisms index', () => {
  before(async () => {
    for (const [rel, text] of Object.entries(FILES)) {
      const p = path.join(SRC, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, text);
    }
    idx = new CodeSearchIndex({ indexPath: IDX });
    await idx.buildIndex(SRC, { showProgress: false });
    const idx2 = new CodeSearchIndex({ indexPath: IDX2 });
    await idx2.buildIndex(SRC, { showProgress: false });
  });
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows holds a handle sometimes */ } });

  describe('the cover build', () => {
    let data = null;
    before(() => {
      data = buildMechanismsIndex(idx, { indexName: 'fixture', purposeFor: (l, m, g) => harvestPurpose(idx, l, m, g && g.residue, { calls: false }) });
    });

    it('every candidate function is in at least one record, and the file carries the format, a coverage block and one record per line', () => {
      assert.equal(data.format, MECHANISMS_FORMAT);
      assert.ok(data.coverage.functions >= 12, `candidate functions: ${data.coverage.functions}`);
      assert.equal(data.coverage.inGroups, data.coverage.functions, 'the cover is complete');
      assert.equal(data.coverage.filesRepresented, data.coverage.files);
      assert.ok(data.records.length >= 7, data.records.map((r) => r.label).join(' | '));
      for (const r of data.records) {
        assert.ok(r.id && r.label && r.kind && Array.isArray(r.members) && r.members.length >= 1, JSON.stringify(r).slice(0, 200));
        for (const m of r.members) assert.ok(m.file && m.name && m.start >= 1 && m.end >= m.start, JSON.stringify(m));
        assert.equal(r.priority, null); assert.equal(r.description, null); assert.ok(Array.isArray(r.tags));
      }
    });

    it('records overlap: a method sits in its class record and in its file record', () => {
      const cls = byLabel(data, '[class] Tokenizer');
      const file = byLabel(data, '[file] parser.py');
      assert.ok(cls, 'the class record: ' + data.records.map((r) => r.label).join(' | '));
      assert.ok(file, 'the file record');
      assert.equal(cls.kind, 'class'); assert.equal(file.kind, 'file');
      const inClass = cls.members.map((m) => m.name);
      const inFile = file.members.map((m) => m.name);
      assert.ok(inClass.includes('Tokenizer::tokenize'), inClass.join(', '));
      assert.ok(inFile.includes('Tokenizer::tokenize'), inFile.join(', '));
      assert.equal(inClass.length, 3, 'tokenize, tally_tokens, head (the dunder constructor is an intrinsic name)');
      assert.ok(inFile.includes('resolve_element') && inFile.includes('chart_row'), inFile.join(', '));
      assert.equal(cls.files.length, 1);
    });

    it('same-basename files get distinct labels; a test file\'s record is tagged test; a tiny class is still a record', () => {
      assert.ok(byLabel(data, '[file] pkg/__init__.py'), data.records.map((r) => r.label).join(' | '));
      assert.ok(byLabel(data, '[file] other/__init__.py'));
      const t = byLabel(data, '[file] test_parser.py');
      assert.ok(t, 'the test file is covered, not dropped');
      assert.deepEqual(t.tags, ['test']);
      assert.ok(byLabel(data, '[class] Reader'), 'a two-method class is a record in cover mode');
      assert.deepEqual(byLabel(data, '[file] parser.py').tags, []);
    });

    it('purposes: the module docstring, the class docstring, a JSDoc with its boilerplate out, member sentences when the file has no header, empty when nothing is readable', () => {
      assert.match(byLabel(data, '[file] parser.py').purpose, /^parser\.py -- tokenizes claim text into elements/);
      assert.match(byLabel(data, '[class] Tokenizer').purpose, /^Splits claim text into tokens/);
      const stream = byLabel(data, '[file] stream.js').purpose;
      assert.match(stream, /^stream\.js — reads a JSON document in chunks/);
      assert.doesNotMatch(stream, /example\.org|Co-authored/, 'a bare URL and a co-author line are provenance, not purpose');
      assert.match(byLabel(data, '[class] Reader').purpose, /^Opens the file and yields values\./);
      const nodoc = byLabel(data, '[file] nodoc.py');
      assert.match(nodoc.purpose, /Gamma does a thing\./, 'the first sentence of a member docstring');
      assert.match(nodoc.purpose, /Delta does another thing\./);
      assert.doesNotMatch(nodoc.purpose, /And then another/, 'first sentence only');
      const bare = byLabel(data, '[file] bare.js');
      assert.equal(bare.purpose, '', 'no header, no docs, and every callee is in the record: nothing to read');
      assert.deepEqual(bare.calls, []);
    });

    it('the harvester reads a split sub-group through its file, a namesake\'s docstring, and writes the calls line last', () => {
      const parserMembers = ['resolve_element', 'chart_row'].map((n) => memberOf(idx, 'pkg/parser.py', n));
      assert.match(harvestPurpose(idx, '[file] parser.py / chart', parserMembers), /^parser\.py -- tokenizes/);
      const gamma = memberOf(idx, 'pkg/nodoc.py', 'gamma_one');
      assert.match(harvestPurpose(idx, 'gamma (gamma_one)', [gamma]), /^Gamma does a thing\. And then another\./, 'the namesake\'s whole docstring');
      const ab = ['alphaOne', 'betaTwo'].map((n) => memberOf(idx, 'lib/bare.js', n));
      assert.equal(harvestPurpose(idx, 'alpha (alphaOne)', ab), 'calls: helperOutside');
      assert.equal(harvestPurpose(idx, 'alpha (alphaOne)', ab, null, { calls: false }), '', 'the caller computes the calls line itself');
    });

    it('kindOf, firstSentence and the estimate', () => {
      assert.equal(kindOf('[file] a.js / rest'), 'residue');
      assert.equal(kindOf('[cmd] --build'), 'cmd');
      assert.equal(kindOf('token (fn)'), 'token');
      assert.equal(firstSentence('--- Step 1: do it --- Then more.'), 'Step 1: do it --- Then more.');
      assert.equal(firstSentence('No end here'), 'No end here');
      assert.equal(estimateBuildMinutes(100), 1);
      assert.ok(estimateBuildMinutes(74061) >= 2, 'WinAPI_Classic: measured 208 s after build-mechanisms-reads-by-span');
      assert.ok(estimateBuildMinutes(378225) >= 10, 'Py314_site_pkg: measured 520 s');
    });

    it('save and load round-trip, one record per line; absent is null; a foreign file throws; the loader caches by mtime', () => {
      assert.equal(loadMechanismsIndex(idx), null, 'nothing written yet');
      const file = saveMechanismsIndex(idx, data);
      assert.equal(file, mechanismsPath(idx));
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.split('\n').filter((l) => l.startsWith('{"id":"m')).length, data.records.length, 'grep finds a record by its line');
      const back = loadMechanismsIndex(idx);
      assert.equal(back.records.length, data.records.length);
      assert.deepEqual(back.coverage, data.coverage);
      assert.equal(loadMechanismsIndex(idx), back, 'the cached object comes back while the file is unchanged');
      fs.writeFileSync(file, '{"nope":true}');
      assert.throws(() => loadMechanismsIndex(idx), /not a ce-mechanisms file/);
      fs.unlinkSync(file);
      assert.equal(loadMechanismsIndex(idx), null);
    });

    it('filterRecords matches id, label, purpose, member and file names; the CLI formatter prints ids, counts, tags, text and members, and caps', () => {
      assert.deepEqual(filterRecords(data.records, 'Tokenizer').map((r) => r.label).sort(), ['[class] Tokenizer', '[file] parser.py', '[file] test_parser.py']);
      assert.ok(filterRecords(data.records, 'yields values').some((r) => r.label === '[class] Reader'), 'purpose text matches');
      assert.ok(filterRecords(data.records, '/^\\[file\\] other/').length === 1, 'the /regex/ form');
      assert.deepEqual(filterRecords(data.records, 'zzz-none'), []);
      const { lines, shown, total } = formatMechanismsList(data, data.records, { max: 2 });
      assert.equal(shown, 2); assert.equal(total, data.records.length);
      assert.match(lines[0], /^\d+ mechanism records \(showing 2\): a cover of \d+ of \d+ functions \(100%\)/);
      assert.match(lines.join('\n'), /^m1\s+\[/m);
      assert.match(lines[lines.length - 3], /2 of \d+ shown; --all-results or --max-results 0 shows all/, 'the cap footer, before the how-to line that ends an undescribed file');
      const t = formatMechanismsList(data, [byLabel(data, '[file] test_parser.py')], {}).lines.join('\n');
      assert.match(t, /\[file\] test_parser\.py  \(2 fns, 1 file\)  \[test\]/);
      assert.match(t, /test_tokenize, test_tally/);
      const v = formatMechanismsList(data, [byLabel(data, '[file] test_parser.py')], { verbose: true }).lines.join('\n');
      assert.match(v, /test_parser\.py@test_tokenize/);
    });

    it('outboundCalls reads a member by its own span: the second same-named function in a file yields its own callees (build-mechanisms-reads-by-span)', () => {
      idx._ensureFunctionIndex();
      const key = Object.keys(idx.functionIndex).find((f) => f.replace(/\\/g, '/').endsWith('lib/dupe.js'));
      const fns = idx.functionIndex[key];
      const walks = Object.entries(fns).filter(([n]) => n === 'walk' || n.startsWith('walk@'))
        .map(([n, i]) => ({ id: `${key}@${n}`, file: key, name: n, bare: 'walk', start: i.start, end: i.end }))
        .sort((a, b) => a.start - b.start);
      assert.equal(walks.length, 2, `two walks indexed; keys: ${Object.keys(fns).join(', ')}`);
      assert.deepEqual(outboundCalls(idx, [walks[0]]), ['helperA']);
      assert.deepEqual(outboundCalls(idx, [walks[1]]), ['helperB'], 'the second walk reads its own body, not the first one\'s');
      // The name-and-hint resolution lands on the first walk for both; the
      // span is what makes the second right, and it skips the resolution.
      assert.deepEqual(findCallees(idx, 'walk', key).map((c) => c.name), ['helperA']);
      const second = findCallees(idx, 'walk', key, { target: { filepath: key, name: walks[1].name, start: walks[1].start, end: walks[1].end } });
      assert.deepEqual(second.map((c) => c.name), ['helperB']);
      const spy = idx.findFunctionMatches;
      try {
        idx.findFunctionMatches = () => { throw new Error('findFunctionMatches ran with a target given'); };
        assert.deepEqual(outboundCalls(idx, walks), ['helperA', 'helperB'], 'both walks read by their spans, and no resolution ran');
      } finally { idx.findFunctionMatches = spy; }
    });

    it('a described record leads with its sentence and the label follows; an undescribed one leads with its label; -v lifts the cut', () => {
      // mechanisms-description-leads: the model's sentence is the record's title.
      const rec = byLabel(data, '[file] test_parser.py');
      const long = 'Tests the tokenizer. ' + 'x'.repeat(260);
      rec.description = long;
      const first = (ls) => ls.findIndex((l) => /^m\d+\s/.test(l));
      try {
        const d = formatMechanismsList(data, [rec], {}).lines; const i = first(d);
        assert.match(d[i], /^m\d+\s+Tests the tokenizer\. x+…$/, 'first line: the id, then the description, cut at 240');
        assert.equal(d[i].length, 6 + 240, 'the cut applies to the description line');
        assert.equal(d[i + 1], '      [file] test_parser.py  (2 fns, 1 file)  [test]', 'second line: the label, counts and tags');
        assert.equal(d[i + 2], '      test_tokenize, test_tally', 'then the members');
        const dv = formatMechanismsList(data, [rec], { verbose: true }).lines; const j = first(dv);
        assert.equal(dv[j], `${rec.id.padEnd(6)}${long}`, '-v lifts the cut');
        assert.match(dv[j + 1], /^      \[file\] test_parser\.py  \(2 fns/);
      } finally { rec.description = null; }
      const u = formatMechanismsList(data, [byLabel(data, '[class] Reader')], { filter: 'Reader', exe: 'ce' }).lines; const k = first(u);
      assert.match(u[k], /^m\d+\s+\[class\] Reader  \(\d+ fns?, 1 file\)/, 'an undescribed record still leads with its label');
      assert.match(u[k + 1], /yields values/, 'and its purpose stays beneath the label');
      assert.match(u[u.length - 1], /^No model descriptions yet: ce --index-path \S+ --mechanisms Reader --describe --llm claude writes one sentence per listed record \(about \$0\.003 each on Claude; above the \$2 claims guard add --force\)\.$/, 'a file nobody has described ends by saying how, with the filter in the command');
      assert.ok(!formatMechanismsList(data, [rec], { describeHint: false }).lines.some((l) => /^No model descriptions yet/.test(l)), 'describeHint: false turns the line off (a --describe in the same command reports instead)');
      const capped = formatMechanismsList(data, data.records, { max: 1 }).lines;
      assert.match(capped[capped.length - 3], /^1 of \d+ shown; --all-results or --max-results 0 shows all/, 'the cap footer names --all-results and comes before the how-to line');
      data.described = { engine: 'stub', generated: 'now', records: 1, failed: 0, filter: null };
      try {
        assert.ok(!formatMechanismsList(data, [rec], {}).lines.some((l) => /^No model descriptions yet/.test(l)), 'no hint once anything is described');
      } finally { delete data.described; }
    });
  });

  describe('the CLI, the MCP tool and --describe', () => {
    let idx2 = null;
    before(() => { idx2 = new CodeSearchIndex({ indexPath: IDX2 }); setIndex(idx2); });
    after(() => { setIndex(new CodeSearchIndex({ indexPath: IDX })); });

    it('--mechanisms before any build prints the one not-built line, with the command and an estimate', () => {
      const { out } = runCLI(IDX2, ['--mechanisms']);
      assert.match(out, /not built: run .*--index-path .*\.mech_cli_ndx.* --build-mechanisms \(about 1 minute on an index this size\)/, out);
      assert.equal(notBuiltLine(idx2, { exe: 'ce' }).startsWith('not built: run ce --index-path '), true);
    });

    it('list_mechanisms before the build answers the same line and names the tools that work without it; the tool is registered and in the local core', () => {
      assert.ok(TOOLS.some((t) => t.name === 'list_mechanisms'));
      assert.ok(CURATED_LOCAL_CHAT_TOOLS.includes('list_mechanisms'));
      const out = handleTool('list_mechanisms', {});
      assert.match(out, /^not built: run .*--build-mechanisms/, out);
      assert.match(out, /list_functions, list_classes and list_files answer without it/);
    });

    it('--build-mechanisms writes the file and reports the cover; --mechanisms lists, filters, caps, and tells a filter that matched nothing from an empty index', () => {
      const b = runCLI(IDX2, ['--build-mechanisms']);
      assert.equal(b.code, 0, b.out);
      assert.match(b.out, /Building mechanisms index from \d+ loaded files, \d+ functions/);
      assert.match(b.out, /Done: \d+ record\(s\) covering (\d+) of \1 functions \(100%\), (\d+) of \2 files, written to .*mechanisms\.json/, b.out);
      assert.ok(fs.existsSync(path.join(IDX2, 'mechanisms.json')));
      const l = runCLI(IDX2, ['--mechanisms']);
      assert.match(l.out, /\d+ mechanism records: a cover of/, l.out);
      assert.match(l.out, /\[class\] Tokenizer  \(\d fns, 1 file\)\n\s+Splits claim text into tokens/, l.out);
      const f = runCLI(IDX2, ['--mechanisms', 'Reader']);
      assert.match(f.out, /mechanism records? matching 'Reader'/, f.out);
      assert.doesNotMatch(f.out, /\[file\] parser\.py/);
      const c = runCLI(IDX2, ['--mechanisms', '--max-results', '1']);
      assert.match(c.out, /\(showing 1\)/); assert.match(c.out, /1 of \d+ shown/);
      const z = runCLI(IDX2, ['--mechanisms', 'zzz-nothing']);
      assert.match(z.out, /No mechanisms match filter "zzz-nothing" \(\d+ exist — omit the filter to see them all\)/, z.out);
      const fl = runCLI(IDX2, ['--mechanisms', '--filter', 'nodoc']);
      assert.match(fl.out, /\[file\] nodoc\.py/, '--filter is honored when the flag carries no value');
    });

    it('list_mechanisms after the build lists rows with counts, text and members, honors filter and max, and discloses an empty filter', () => {
      const out = handleTool('list_mechanisms', {});
      assert.match(out, /^\d+ mechanism record\(s\) \(showing \d+\): a cover of/, out);
      assert.match(out, /  m\d+  \[class\] Tokenizer  \(\d fns, 1 file\)  — Splits claim text/, out);
      assert.match(out, /Tokenizer::tokenize/);
      const one = handleTool('list_mechanisms', { max: 1 });
      assert.match(one, /more not shown \(total \d+\)\. Raise "max" or use a filter\./);
      const f = handleTool('list_mechanisms', { filter: 'Reader' });
      assert.match(f, /matching "Reader"/); assert.doesNotMatch(f, /\[file\] parser/);
      assert.match(handleTool('list_mechanisms', { filter: 'zzz-nothing' }), /No mechanisms match filter "zzz-nothing"/);
    });

    it('--describe through a stub drafter writes one cleaned sentence per record from a pack that carries members and source, and the listing prefers it', async () => {
      const data = loadMechanismsIndex(idx2, { cache: false });
      const seen = [];
      const drafter = async (sys, user) => {
        seen.push(user);
        assert.match(sys, /ONE plain sentence/);
        const label = user.split('\n')[0].replace('MECHANISM: ', '');
        return `Description: "${label} reads things."\nSecond line ignored.`;
      };
      const r = await describeMechanisms(idx2, data, {}, { drafter });
      assert.deepEqual([r.ok, r.done, r.failed, r.reason], [true, data.records.length, 0, null]);
      assert.equal(data.described.records, data.records.length);
      assert.equal(data.described.filter, null);
      assert.equal(data.described.engine, 'stub');
      for (const r of data.records) assert.equal(r.description, `${r.label} reads things.`);
      const pack = seen.find((u) => u.startsWith('MECHANISM: [class] Tokenizer'));
      assert.match(pack, /^KIND: class/m);
      assert.match(pack, /^MEMBERS \(\d\): .*Tokenizer::tokenize/m);
      assert.match(pack, /^--- .*parser\.py@Tokenizer::\w+ \(lines \d+-\d+/m, 'the first lines of a member ride in the pack');
      assert.match(describePack(idx2, byLabel(data, '[file] bare.js')), /^MEMBERS \(3\)/m);
      assert.equal(cleanDescription('  - "Reads things."  '), 'Reads things.');
      assert.equal(cleanDescription('Sentence:\n\nIt does X.'), 'It does X.');
      saveMechanismsIndex(idx2, data);
      const l = runCLI(IDX2, ['--mechanisms', 'Tokenizer']);
      assert.match(l.out, /described by stub/);
      assert.match(l.out, /^m\d+\s+\[class\] Tokenizer reads things\.\n      \[class\] Tokenizer  \(\d+ fns?, 1 file\)/m, 'a described record leads with its sentence; the label line follows');
      assert.doesNotMatch(l.out.split('[class] Tokenizer  (')[1] || '', /^\s*Splits claim text/m, 'the description replaces the purpose in the listing');
    });

    it('--describe without a model says what it needs, says on stdout that nothing was written, and leaves the file alone', () => {
      // Undescribed records, or the skip rule answers before any model is looked for.
      const data = loadMechanismsIndex(idx2, { cache: false });
      for (const rec of data.records) rec.description = null;
      delete data.described;
      saveMechanismsIndex(idx2, data);
      const before = fs.readFileSync(path.join(IDX2, 'mechanisms.json'), 'utf8');
      const r = runCLI(IDX2, ['--describe']);
      assert.match(r.out, /--describe needs a model: pass --llm <provider> or --model <gguf>/, r.out);
      assert.match(r.out, /^No descriptions written: --describe needs a model/m, r.out);
      assert.doesNotMatch(r.out, /lists them; the GUI/, 'no success hint after a refusal');
      assert.equal(fs.readFileSync(path.join(IDX2, 'mechanisms.json'), 'utf8'), before);
      // With --mechanisms in the same command the outcome is the listing's last
      // line, where a reader of a long list looks, and the how-to line yields.
      const both = runCLI(IDX2, ['--mechanisms', '--describe']);
      assert.match(both.stdout.trim().split('\n').pop(), /^No descriptions written: --describe needs a model/, both.stdout);
      assert.match(both.stdout, /^m1\s/m, 'the listing still prints');
      assert.doesNotMatch(both.stdout, /^No model descriptions yet/m, 'the how-to line yields to the outcome');
      // --all-results lifts the cap, as on every listing; the footer names it.
      const all = runCLI(IDX2, ['--mechanisms', '--all-results']);
      assert.doesNotMatch(all.stdout, /of \d+ shown;/, '--all-results lifts the cap');
      assert.match(all.stdout.trim().split('\n').pop(), /^No model descriptions yet: /, 'an undescribed file ends with the how-to line');
      const one = runCLI(IDX2, ['--mechanisms', '--max-results', '1']);
      assert.match(one.stdout, /^1 of \d+ shown; --all-results or --max-results 0 shows all/m, one.stdout);
    });

    it('a describe run stops after five failures in a row, keeps what it got and says how to resume; one that wrote nothing is a refusal', async () => {
      const data = loadMechanismsIndex(idx2, { cache: false });
      assert.ok(data.records.length > 5, 'the stub has more records than the streak');
      for (const rec of data.records) rec.description = null;
      delete data.described;
      let calls = 0;
      const flaky = async (sys, user) => { calls++; if (calls <= 2) throw new Error('fetch failed'); return `${user.split('\n')[0].replace('MECHANISM: ', '')} works.`; };
      const partial = await describeMechanisms(idx2, data, {}, { drafter: flaky });
      assert.deepEqual([partial.ok, partial.done, partial.failed, partial.stopped, partial.lastError], [true, data.records.length - 2, 2, 0, 'fetch failed'], 'two failures do not stop the run; the rest are written');
      assert.equal(data.described.failed, 2);
      for (const rec of data.records) rec.description = null;
      delete data.described;
      let dead = 0;
      const down = async () => { dead++; throw new Error('fetch failed'); };
      const r = await describeMechanisms(idx2, data, {}, { drafter: down });
      assert.equal(dead, 5, 'stops at the streak, not at the end of the file');
      assert.deepEqual([r.ok, r.done, r.failed, r.stopped], [false, 0, 5, 5]);
      assert.equal(r.reason, 'every call failed (fetch failed); stopped after 5 failures in a row; nothing written. Rerun the same command when the model is reachable.');
      assert.equal(data.described, undefined, 'a run that wrote nothing leaves the described block alone');
    });

    it('--mechanisms <filter> --describe describes the matching records only, keeps the others, and the header counts them', async () => {
      const data = loadMechanismsIndex(idx2, { cache: false });
      for (const r of data.records) r.description = null;
      const subset = filterRecords(data.records, 'Reader');
      assert.ok(subset.length >= 1 && subset.length < data.records.length);
      const seen = [];
      const drafter = async (sys, user) => { seen.push(user.split('\n')[0]); return 'Reads chunks.'; };
      const r = await describeMechanisms(idx2, data, {}, { drafter, records: subset, filter: 'Reader' });
      assert.deepEqual([r.ok, r.done, r.failed], [true, subset.length, 0]);
      assert.equal(seen.length, subset.length, 'one call per matching record, none for the rest');
      assert.ok(data.records.every((rec) => (subset.includes(rec) ? rec.description === 'Reads chunks.' : rec.description === null)));
      assert.deepEqual([data.described.records, data.described.filter], [subset.length, 'Reader']);
      saveMechanismsIndex(idx2, data);
      const l = runCLI(IDX2, ['--mechanisms']);
      assert.match(l.out, new RegExp(`${subset.length} of ${data.records.length} described by stub`), l.out);
      const z = runCLI(IDX2, ['--mechanisms', 'zzz-nothing', '--describe', '--llm', 'claude']);
      assert.match(z.out, /^No descriptions written: No mechanisms match filter "zzz-nothing"/m, z.out);
      assert.doesNotMatch(z.out, /projected cost/, 'nothing to describe asks no model and projects no cost');
    });

    it('a description is paid for once: an unfiltered run skips described records, --redescribe rewrites them, and a run with nothing left asks no model', async () => {
      const data = loadMechanismsIndex(idx2, { cache: false });
      const described = data.records.filter((r) => r.description).map((r) => r.id);
      assert.ok(described.length >= 1 && described.length < data.records.length, 'the filtered run left a mix');
      const calls = [];
      const drafter = async (sys, user) => { calls.push(user.split('\n')[0]); return 'Filled in.'; };
      const r = await describeMechanisms(idx2, data, {}, { drafter });
      assert.deepEqual([r.ok, r.done, r.skipped], [true, data.records.length - described.length, described.length]);
      assert.equal(calls.length, data.records.length - described.length, 'no call for a record already described');
      for (const rec of data.records) assert.equal(rec.description, described.includes(rec.id) ? 'Reads chunks.' : 'Filled in.');
      assert.equal(data.described.records, data.records.length);
      const none = await describeMechanisms(idx2, data, {}, { drafter });
      assert.deepEqual([none.ok, none.done, none.skipped], [false, 0, data.records.length]);
      assert.match(none.reason, /already carry a description \(--redescribe rewrites them\)/);
      const redo = await describeMechanisms(idx2, data, {}, { drafter, redo: true, records: filterRecords(data.records, 'Reader'), filter: 'Reader' });
      assert.equal(redo.ok, true);
      assert.ok(filterRecords(data.records, 'Reader').every((rec) => rec.description === 'Filled in.'));
      saveMechanismsIndex(idx2, data);
      const full = runCLI(IDX2, ['--describe', '--llm', 'claude']);
      assert.match(full.out, /^No descriptions written: all \d+ record\(s\) already carry a description/m, full.out);
      assert.doesNotMatch(full.out, /projected cost|needs a model/, 'the skip comes before any model is resolved');
    });

    it('a rebuild carries descriptions over where the record is unchanged, and says how many', () => {
      const before = loadMechanismsIndex(idx2, { cache: false });
      assert.ok(before.records.every((r) => r.description), 'every record described going in');
      const b = runCLI(IDX2, ['--build-mechanisms']);
      assert.equal(b.code, 0, b.out);
      assert.match(b.out, new RegExp(`${before.records.length} of the previous file's ${before.records.length} description\\(s\\) carried over \\(same label and members\\); 0 belonged to records the rebuild changed`), b.out);
      const after = loadMechanismsIndex(idx2, { cache: false });
      assert.ok(after.records.every((r) => r.description), 'the rebuilt file keeps every sentence');
      assert.equal(after.described.records, after.records.length);
      assert.equal(after.described.carriedFrom, before.generated);
      // The unit: a changed member set does not inherit.
      const prev = { generated: 'g0', described: { engine: 'stub', generated: 'g0', records: 2, failed: 0, filter: null }, records: [
        { label: '[file] a.js', members: [{ file: 'a.js', name: 'x' }, { file: 'a.js', name: 'y' }], description: 'A.' },
        { label: '[class] K', members: [{ file: 'k.js', name: 'K::m' }], description: 'K.' },
      ] };
      const next = { records: [
        { label: '[file] a.js', members: [{ file: 'a.js', name: 'y' }, { file: 'a.js', name: 'x' }], description: null },
        { label: '[class] K', members: [{ file: 'k.js', name: 'K::m' }, { file: 'k.js', name: 'K::n' }], description: null },
      ] };
      assert.equal(carryDescriptions(prev, next), 1);
      assert.deepEqual(next.records.map((r) => r.description), ['A.', null]);
      assert.deepEqual([next.described.records, next.described.carriedFrom, next.described.engine], [1, 'g0', 'stub']);
      assert.equal(carryDescriptions(null, next), 0);
    });
  });
});
