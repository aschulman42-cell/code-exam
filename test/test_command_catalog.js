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

describe('command catalog: GUI actions', () => {
  const HTML = [
    '<div class="menu">',
    '  <button data-action="search-fast">Fast search</button> <button data-action="help">Help</button>',
    '  <button data-action="reset-layout">Reset</button>',
    '</div>',
    '<div class="accordion-section" data-section="overview"></div>',
    '<div class="accordion-section" data-section="stats"></div>',
  ].join('\n');
  const MENU = [
    'function openReadme() { return 1; }',
    'function showSearchDialog(a) { return a; }',
    'function handleMenuAction(action) {',
    '  switch (action) {',
    "    case 'help':",
    '      openReadme();',
    '      break;',
    "    case 'search-fast': {",
    "      const label = 'Fast';",
    '      const r = await showSearchDialog(label);',
    '      break;',
    '    }',
    '  }',
    '}',
    "for (const btn of document.querySelectorAll('button[data-action]')) btn.addEventListener('click', () => handleMenuAction(btn.dataset.action));",
  ].join('\n');
  const LAYOUT = ['function resetLayout() { return 1; }', "const resetBtn = document.querySelector('[data-action=\"reset-layout\"]');", 'resetBtn.addEventListener(\'click\', resetLayout);'].join('\n');
  const TOURS = ["const steps = [{ sel: '.accordion-section[data-section=\"overview\"]', open: true }];"].join('\n');
  // Server-side code that happens to compare against the same words.
  const SERVER = ['function doHelp() { return 1; }', "if (cmd === 'help') doHelp();", "if (cmd === 'stats') doHelp();", "const opts = ['overview', 'flag'];"].join('\n');
  // The catalog's own kind of source: the attribute inside a regex, a template and a comment.
  const NOISE = [
    '/**',
    ' *   - HTML data-* attributes: data-action="name", data-section="name"',
    ' */',
    'const m = line.match(/data-action="([^"]+)"/);',
    'const s = document.querySelector(`.accordion-section[data-section="${sectionId}"]`);',
  ].join('\n');
  const files = { 'public/index.html': HTML, 'public/menu-bar.js': MENU, 'public/layout.js': LAYOUT, 'public/tours.js': TOURS, 'src/server.js': SERVER, 'src/catalog.js': NOISE };
  const fns = { 'public/menu-bar.js': ['openReadme', 'showSearchDialog', 'handleMenuAction'], 'public/layout.js': ['resetLayout'], 'src/server.js': ['doHelp'] };
  const build = (order = Object.keys(files), drop = []) => extractCommandCatalog(indexOf(Object.fromEntries(order.filter((f) => !drop.includes(f)).map((f) => [f, files[f]])), fns), false);
  const act = (cat, name) => cat.guiActions.find((a) => a.name === name);
  const names = (cat) => cat.guiActions.map((a) => a.name).sort();

  it('lists every action and section of the markup, two on one line included', () => {
    assert.deepEqual(names(build()), ['help', 'overview', 'reset-layout', 'search-fast', 'stats']);
  });
  it('drops a regex source, a template placeholder and a word in a comment', () => {
    const got = names(build());
    for (const bad of ['([^', '${sectionId}', 'name']) assert.ok(!got.includes(bad), `${bad} is not an action`);
  });
  it('cites the markup that defines an action, not a script that mentions it', () => {
    const cat = build(['public/tours.js', 'public/layout.js', 'public/menu-bar.js', 'src/server.js', 'src/catalog.js', 'public/index.html']);
    assert.equal(act(cat, 'overview').filepath, 'public/index.html');
    assert.equal(act(cat, 'reset-layout').filepath, 'public/index.html');
  });
  it('joins an action to the client-side case that dispatches it, and names the call in that case', () => {
    const cat = build();
    assert.equal(act(cat, 'help').handler.filepath, 'public/menu-bar.js');
    assert.equal(act(cat, 'help').handler.line, 5);
    assert.equal(act(cat, 'help').handler.handlerFunc, 'openReadme');
    assert.equal(act(cat, 'search-fast').handler.handlerFunc, 'showSearchDialog');
  });
  it('falls back to the script that selects the control when nothing dispatches on its name', () => {
    const h = act(build(), 'reset-layout').handler;
    assert.equal(h.filepath, 'public/layout.js');
    assert.equal(h.line, 2);
  });
  it('gives no handler when the only matches are server-side code or a plain list', () => {
    assert.equal(act(build(), 'stats').handler, undefined);
    assert.equal(act(build(undefined, ['public/tours.js']), 'overview').handler, undefined);
  });
  it('gives the same rows and joins whatever the file order', () => {
    const view = (cat) => cat.guiActions.map((a) => `${a.name}|${a.type}|${a.filepath}:${a.line}|${a.handler ? `${a.handler.filepath}:${a.handler.line}:${a.handler.handlerFunc}` : '-'}`);
    const a = view(build());
    assert.deepEqual(view(build(['src/server.js', 'src/catalog.js', 'public/tours.js', 'public/menu-bar.js', 'public/index.html', 'public/layout.js'])), a);
    assert.deepEqual(view(build(['public/layout.js', 'public/index.html', 'src/catalog.js', 'public/menu-bar.js', 'src/server.js', 'public/tours.js'])), a);
  });
  it('says so when scripts drive a page but no markup is in the index', () => {
    const cat = build(undefined, ['public/index.html']);
    assert.match(cat.guiNote, /No HTML in this index/);
    assert.match(cat.guiNote, /--build-index .*--add-extensions \.html,\.htm/);
    assert.ok(act(cat, 'reset-layout'), 'a name seen only in a script selector is still listed');
  });
  it('counts the HTML an archive build recorded as skipped', () => {
    const idx = indexOf(Object.fromEntries(Object.entries(files).filter(([f]) => f !== 'public/index.html')), fns);
    idx.skippedExtensions = { '.html': 3 };
    assert.match(extractCommandCatalog(idx, false).guiNote, /^3 HTML file\(s\) were not indexed/);
  });
  it('has no note when the markup is indexed, or when nothing in the index drives a page', () => {
    assert.equal(build().guiNote, null);
    assert.equal(extractCommandCatalog(base(), false).guiNote, null);
  });
});

describe('command catalog: GUI controls beyond data-action and data-section', () => {
  const HTML = [
    '<button data-action="search-regex">Regex Search</button>',
    '<button class="pane-tab active" data-tab="analysis">Analysis</button> <button class="pane-tab" data-tab="chat">Chat</button>',
    '<div class="workspace-handle" id="workspace-toggle">',
    '  <span>Claim / Multisect Workspace</span>',
    '</div>',
    '<div id="plain-box"><span>Just a box</span></div>',
    '<button id="ws-browse-model" class="btn-secondary" title="Browse for GGUF model">Browse GGUFs</button>',
    '<label><input type="checkbox" id="ws-vocab-tight"> Vocab-Tight</label>',
    '<button id="chat-send" class="pane-action" title="Send message">&#10148;</button>',
    '<input type="text" id="console-input" placeholder="Type command">',
    '<label for="chat-engine">Engine</label> <select id="chat-engine"><option value="a">A</option></select>',
    '<input type="hidden" id="csrf" value="x">',
    '<a href="/docs">Docs</a>',
  ].join('\n');
  const APP = [
    'function openModelBrowser() { return 1; }',
    'function sendChatMessage() { return 1; }',
    'function toggleWorkspace() { return 1; }',
    'function switchTab(t) { return t; }',
    'function setup() {',
    "  $('#workspace-toggle').addEventListener('click', (e) => {",
    '    toggleWorkspace();',
    '  });',
    "  $('#ws-browse-model').addEventListener('click', openModelBrowser);",
    "  const vocabTight = $('#ws-vocab-tight')?.checked || false;",
    "  const send = document.getElementById('chat-send');",
    "  send.addEventListener('click', sendChatMessage);",
    "  for (const tab of $$('.pane-tab')) tab.addEventListener('click', () => {",
    "    if (tab.dataset.tab === 'chat') switchTab('chat');",
    '  });',
    "  $('#plain-box').textContent = 'x';",
    '}',
  ].join('\n');
  const files = { 'public/index.html': HTML, 'public/app.js': APP };
  const fns = { 'public/app.js': ['openModelBrowser', 'sendChatMessage', 'toggleWorkspace', 'switchTab', 'setup'] };
  const cat = () => extractCommandCatalog(indexOf(files, fns), false);
  const act = (c, name) => c.guiActions.find((a) => a.name === name);

  it('labels a control with the text a user sees', () => {
    const c = cat();
    assert.equal(act(c, 'search-regex').label, 'Regex Search');
    assert.equal(act(c, 'ws-browse-model').label, 'Browse GGUFs');
    assert.equal(act(c, 'ws-vocab-tight').label, 'Vocab-Tight');
    assert.equal(act(c, 'chat-send').label, 'Send message');
    assert.equal(act(c, 'console-input').label, 'Type command');
    assert.equal(act(c, 'chat-engine').label, 'Engine');
  });
  it('lists a control named by another data attribute, each one on the line', () => {
    const c = cat();
    assert.equal(act(c, 'analysis').type, 'tab');
    assert.equal(act(c, 'analysis').label, 'Analysis');
    assert.equal(act(c, 'chat').type, 'tab');
  });
  it('lists buttons, checkboxes, inputs and selects that have an id, by kind', () => {
    const c = cat();
    assert.equal(act(c, 'ws-browse-model').type, 'button');
    assert.equal(act(c, 'ws-vocab-tight').type, 'checkbox');
    assert.equal(act(c, 'console-input').type, 'input');
    assert.equal(act(c, 'chat-engine').type, 'select');
  });
  it('lists a plain element only when a script attaches a listener to it, labeled from the line under it', () => {
    const c = cat();
    assert.equal(act(c, 'workspace-toggle').label, 'Claim / Multisect Workspace');
    assert.equal(act(c, 'plain-box'), undefined);
  });
  it('leaves out a hidden input and a link with no id', () => {
    const c = cat();
    assert.equal(act(c, 'csrf'), undefined);
    assert.ok(!c.guiActions.some((a) => a.label === 'Docs'));
  });
  it('joins a control to the listener a script attaches by id, directly or through a variable', () => {
    const c = cat();
    assert.equal(act(c, 'ws-browse-model').handler.handlerFunc, 'openModelBrowser');
    assert.equal(act(c, 'workspace-toggle').handler.handlerFunc, 'toggleWorkspace');
    assert.equal(act(c, 'chat-send').handler.handlerFunc, 'sendChatMessage');
    assert.equal(act(c, 'chat-send').handler.line, 12);
    assert.equal(act(c, 'chat-send').handler.kind, 'dispatch');
  });
  it('marks a control a script only reads as used there, not handled', () => {
    const h = act(cat(), 'ws-vocab-tight').handler;
    assert.equal(h.kind, 'selector');
    assert.equal(h.line, 10);
  });
  it('joins a tab to the comparison that dispatches on its value', () => {
    const h = act(cat(), 'chat').handler;
    assert.equal(h.line, 14);
    assert.equal(h.handlerFunc, 'switchTab');
  });
});
