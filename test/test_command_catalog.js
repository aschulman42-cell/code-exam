// test_command_catalog.js — the command catalog's CLI rows and their option-to-handler joins on small in-memory indexes: four-element argparse rows, a one-line dispatch beside another option's, a call ten lines into a block, a modifier option, `await import`, and one answer whatever order the files are indexed in
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { extractCommandCatalog } from '../src/core/breadcrumbs-commands.js';

/** An in-memory index: files in the order given, with a function index naming `functions` per file. */
function indexOf(files, functions = {}) {
  const idx = new CodeSearchIndex({ indexPath: '.__test_command_catalog__' });
  idx.fileLines = new Map(Object.entries(files).map(([p, src]) => [p, src.split('\n')]));
  idx.functionIndex = {};
  for (const [file, names] of Object.entries(functions)) {
    idx.functionIndex[file] = {};
    const lines = idx.fileLines.get(file) || [];
    for (const name of names) {
      const at = lines.findIndex((l) => new RegExp(`function\\s+${name}\\b`).test(l));
      idx.functionIndex[file][name] = { start: at + 1, end: at + 1 };
    }
  }
  idx._ensureFunctionIndex = () => {};
  return idx;
}

const row = (cat, name) => cat.cliOptions.find((o) => o.name === name);
const handlerOf = (cat, name) => { const r = row(cat, name); return r && r.handler ? r.handler.handlerFunc : undefined; };

const ARGS = [
  'const defs = [',
  "  ['overview',      'flag',           ['--overview']],",
  "  ['stats',         'flag',           ['--stats']],",
  "  ['list_files',    'optional_value', ['--files'], ['--list-files']],",
  "  ['list_alpha',    'flag',           [], ['--list-functions-alpha']],",
  "  ['build_index',   'value',          ['--build-index']],",
  "  ['cpu',           'flag',           ['--cpu']],",
  "  ['api_key',       'value',          ['--api-key']],",
  "  ['search',        'value',          ['--search']],",
  '];',
].join('\n');

const HELPERS = [
  'function formatOverview(o) { return o; }',
  'function buildOverview(i) { return i; }',
  'function doStats(i) { return i; }',
  'function doListFiles(i) { return i; }',
  'function doSearch(i) { return i; }',
  'function buildIndex(p) { return p; }',
  'function loadModel(p) { return p; }',
].join('\n');
const HELPER_NAMES = ['formatOverview', 'buildOverview', 'doStats', 'doListFiles', 'doSearch', 'buildIndex', 'loadModel'];

const MAIN = [
  "import { parseArgs } from './argparse.js';",
  'const args = parseArgs();',
  "if (args.api_key) { const m = await import('./keys.js'); m.set(args.api_key); }",
  'if (model && !args.cpu) {',
  '  await loadModel(model);',
  '}',
  'if (args.build_index) {',
  '  const a = 1;',
  '  const b = 2;',
  '  const c = 3;',
  '  const d = 4;',
  '  const e = 5;',
  '  const f = 6;',
  '  const g = 7;',
  '  const h = 8;',
  '  const i = 9;',
  '  const stats = await index.buildIndex(args.build_index, { a, b });',
  '}',
  'if (args.overview)                          console.log(formatOverview(buildOverview(index)));',
  'if (args.stats)                             doStats(index, args);',
  'if (args.list_files)                        doListFiles(index, args);',
  'if (args.search)                            doSearch(index, args);',
].join('\n');

const base = () => indexOf({ 'src/argparse.js': ARGS, 'src/helpers.js': HELPERS, 'src/index.js': MAIN }, { 'src/helpers.js': HELPER_NAMES });

describe('command catalog: argparse rows', () => {
  it('catalogs a row that carries a fourth element, the deprecated aliases', () => {
    const cat = extractCommandCatalog(base(), false);
    const r = row(cat, 'list_files');
    assert.ok(r, 'the four-element row is in the catalog');
    assert.deepEqual(r.flags, ['--files', '--list-files']);
    assert.deepEqual(r.deprecatedFlags, ['--list-files']);
  });
  it('catalogs a row whose only flags are deprecated ones', () => {
    const r = row(extractCommandCatalog(base(), false), 'list_alpha');
    assert.ok(r);
    assert.deepEqual(r.flags, ['--list-functions-alpha']);
  });
  it('leaves a three-element row as it was', () => {
    const r = row(extractCommandCatalog(base(), false), 'stats');
    assert.deepEqual(r.flags, ['--stats']);
    assert.equal(r.deprecatedFlags, undefined);
  });
});

describe('command catalog: option-to-handler joins', () => {
  it('takes the call on a one-line dispatch, not the next option\'s do-call', () => {
    const cat = extractCommandCatalog(base(), false);
    assert.equal(handlerOf(cat, 'overview'), 'formatOverview');
    assert.equal(handlerOf(cat, 'stats'), 'doStats');
  });
  it('still finds a call ten lines into the option\'s own block', () => {
    assert.equal(handlerOf(extractCommandCatalog(base(), false), 'build_index'), 'buildIndex');
  });
  it('gives a modifier tested inside another condition no handler of its own', () => {
    const cat = extractCommandCatalog(base(), false);
    assert.equal(handlerOf(cat, 'cpu'), null);
    assert.ok(row(cat, 'cpu').handler, 'where it is tested is still recorded');
  });
  it('never takes await import( as a handler', () => {
    assert.equal(handlerOf(extractCommandCatalog(base(), false), 'api_key'), null);
  });
  it('does not run past the end of a block into the next option\'s dispatch', () => {
    const main = ['if (args.cpu) {', '  quiet = true;', '}', 'if (args.stats) doStats(index, args);'].join('\n');
    const cat = extractCommandCatalog(indexOf({ 'src/argparse.js': ARGS, 'src/helpers.js': HELPERS, 'src/index.js': main }, { 'src/helpers.js': HELPER_NAMES }), false);
    assert.equal(handlerOf(cat, 'cpu'), null);
    assert.equal(handlerOf(cat, 'stats'), 'doStats');
  });
  it('passes over another option\'s guard nested in the block, and prefers the option tested alone', () => {
    const main = [
      'if (args.stats && args.search) {',
      '  doSearch(index, args);',
      '}',
      'if (args.stats) {',
      '  if (args.search) doSearch(index, args);',
      '  else doStats(index, args);',
      '}',
      'if (args.overview || args.list_files) {',
      '  doListFiles(index, args);',
      '}',
    ].join('\n');
    const cat = extractCommandCatalog(indexOf({ 'src/argparse.js': ARGS, 'src/helpers.js': HELPERS, 'src/index.js': main }, { 'src/helpers.js': HELPER_NAMES }), false);
    assert.equal(handlerOf(cat, 'stats'), 'doStats');
    assert.equal(row(cat, 'stats').handler.line, 4);
    assert.equal(handlerOf(cat, 'search'), 'doSearch');
    assert.equal(handlerOf(cat, 'overview'), 'doListFiles');
    assert.equal(handlerOf(cat, 'list_files'), 'doListFiles');
  });
  it('reads a dispatch table row', () => {
    const main = ['for (const [key, title, fn] of [', "  ['list_files', 'files', doListFiles],", "  ['stats', 'stats', doStats],", ']) if (args[key]) fn(index, args);'].join('\n');
    const cat = extractCommandCatalog(indexOf({ 'src/argparse.js': ARGS, 'src/helpers.js': HELPERS, 'src/index.js': main }, { 'src/helpers.js': HELPER_NAMES }), false);
    assert.equal(handlerOf(cat, 'list_files'), 'doListFiles');
    assert.equal(handlerOf(cat, 'stats'), 'doStats');
  });
  it('resolves a Python elif dispatch', () => {
    const py = ['parser.add_argument("--scan", action="store_true")', '', '', '', '', '', '', 'parser.add_argument("--report", action="store_true")', '', '', '', '', '', '', 'if args.scan:', '    do_scan(args)', 'elif args.report:', '    do_report(args)'].join('\n');
    const cat = extractCommandCatalog(indexOf({ 'tool.py': py }), false);
    assert.equal(handlerOf(cat, 'scan'), 'do_scan');
    assert.equal(handlerOf(cat, 'report'), 'do_report');
  });
});

describe('command catalog: one answer whatever the file order', () => {
  // A GUI file that mentions the option's word in an if, and a second file that tests it in passing.
  const GUI = ["function loadOverviewInto(el) { return el; }", "if (tab === 'overview') {", '  await loadOverviewInto(el);', '}', "if (tab === 'stats') {", '  await loadOverviewInto(el);', '}'].join('\n');
  const CHAT = ['function chatSessionOptions(a) { return a; }', 'if (opts.x && args.overview) {', '  await chatSessionOptions(args);', '}'].join('\n');
  const files = { 'src/argparse.js': ARGS, 'src/helpers.js': HELPERS, 'src/index.js': MAIN, 'public/gui.js': GUI, 'src/chat.js': CHAT };
  const fns = { 'src/helpers.js': HELPER_NAMES, 'public/gui.js': ['loadOverviewInto'], 'src/chat.js': ['chatSessionOptions'] };
  const inOrder = (order) => extractCommandCatalog(indexOf(Object.fromEntries(order.map((f) => [f, files[f]])), fns), false);
  const joins = (cat) => Object.fromEntries(cat.cliOptions.map((o) => [o.name, o.handler ? `${o.handler.handlerFunc}@${o.handler.filepath}:${o.handler.line}` : null]));

  it('gives the same joins with the dispatch file first, last or in the middle', () => {
    const a = joins(inOrder(['src/argparse.js', 'src/helpers.js', 'src/index.js', 'public/gui.js', 'src/chat.js']));
    const b = joins(inOrder(['public/gui.js', 'src/chat.js', 'src/argparse.js', 'src/helpers.js', 'src/index.js']));
    const c = joins(inOrder(['src/chat.js', 'src/index.js', 'public/gui.js', 'src/helpers.js', 'src/argparse.js']));
    assert.deepEqual(b, a);
    assert.deepEqual(c, a);
  });
  it('prefers the file that dispatches the most options over one that only mentions the word', () => {
    const cat = inOrder(['public/gui.js', 'src/chat.js', 'src/argparse.js', 'src/helpers.js', 'src/index.js']);
    assert.equal(handlerOf(cat, 'overview'), 'formatOverview');
    assert.equal(row(cat, 'overview').handler.filepath, 'src/index.js');
    assert.equal(handlerOf(cat, 'stats'), 'doStats');
  });
});
