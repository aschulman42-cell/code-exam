// test_function_texts_route.js — /api/function-texts: the texts the embedding commands embed, the mechanisms holding each function, the filters, tests left out, and the no-mechanisms-file answer
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// gui-function-texts-section: the GUI form of --show-function-text, tested at its
// route on the test_gui_mechanisms_route.js pattern -- a tiny index, the real server on
// a free loopback port. The mechanisms file is written by hand after the first group
// of tests (the no-file answer comes first), with members taken from the route's own
// rows, so which function is in no mechanism is the test's choice, not the grouper's.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { MECHANISMS_FORMAT } from '../src/core/mechanisms-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-function-texts-route-'));
const src = path.join(work, 'src');
const indexPath = path.join(work, '.fn_texts_ndx');
const q = (extra = '') => `http://127.0.0.1:${port}/api/function-texts?index=${encodeURIComponent(path.basename(indexPath))}${extra}`;
const get = async (extra = '') => (await fetch(q(extra))).json();
let server = null;
let port = 0;
let log = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

describe('/api/function-texts', () => {
  before(async () => {
    fs.mkdirSync(path.join(src, 'test'), { recursive: true });
    fs.writeFileSync(path.join(src, 'gate.js'), [
      '// Refuse a cloud call when the run is air-gapped.',
      'export function assertLocalOnly(feature) {',
      '  if (airGapped) throw new Error("air-gapped: " + feature + " needs a cloud call");',
      '  return true;',
      '}',
      'export function tiny() { return 1; }',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(src, 'catalog.js'), [
      '// Read the catalog of libraries a project declares.',
      'export function loadCatalog(file) {',
      '  const prior = JSON.parse(readFileSync(file, "utf8"));',
      '  return prior.libraries;',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(src, 'test', 'test_gate.js'), [
      'export function checksGate() {',
      '  assertLocalOnly("x");',
      '  return true;',
      '}',
      '',
    ].join('\n'));
    const idx = new CodeSearchIndex({ indexPath });
    await idx.buildIndex(src, { showProgress: false });
    port = await freePort();
    server = spawn(process.execPath, ['src/server.js', '--port', String(port), '--index-path', indexPath], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => { log += d; });
    server.stderr.on('data', (d) => { log += d; });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/indexes`); if (r.ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server did not answer on ${port}:\n${log.slice(0, 2000)}`);
  });

  after(() => {
    if (server) server.kill();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
  });

  it('no mechanisms file: the texts are listed, with no ids, nothing embedded, and a message that says why', async () => {
    const body = await get();
    assert.equal(body.hasMechanisms, false);
    assert.match(body.message, /no mechanisms file/);
    assert.equal(body.mechanism, null);
    const names = body.rows.map((r) => r.name);
    assert.deepEqual(names.sort(), ['assertLocalOnly', 'loadCatalog', 'tiny']);
    assert.ok(body.rows.every((r) => r.mechanisms.length === 0 && r.embedded === false));
    assert.equal(body.not_embedded, 0, 'no file: the header does not claim a gap it cannot measure');
    const r = await fetch(q('&id=m1'));
    assert.equal(r.status, 404);
    assert.match((await r.json()).error, /no mechanisms file, so it has no mechanism m1/);
  });

  it('the shape of the response: header counts and rows with the text, its four pieces and their lengths', async () => {
    const body = await get();
    assert.equal(body.shown, 3); assert.equal(body.total, 3); assert.equal(body.total_all, 3);
    assert.equal(body.tests_left, 1, 'checksGate is test code and is left out');
    assert.deepEqual(Object.keys(body.stats).sort(), ['longest', 'median', 'shortest', 'short', 'under'].sort());
    assert.ok(body.stats.shortest <= body.stats.median && body.stats.median <= body.stats.longest);
    const a = body.rows.find((r) => r.name === 'assertLocalOnly');
    assert.ok(a, JSON.stringify(body.rows.map((r) => r.id)));
    assert.match(a.id, /gate\.js@assertLocalOnly$/);
    assert.ok(/gate\.js$/.test(a.file) && a.start === 2 && a.end === 5, JSON.stringify(a));
    assert.match(a.text, /^assert local only/);
    assert.deepEqual(Object.keys(a.parts), ['name', 'identifiers', 'comment', 'strings']);
    assert.deepEqual(a.parts.name, { text: 'assert local only', length: 17 });
    assert.match(a.parts.comment.text, /^Refuse a cloud call/);
    for (const p of Object.values(a.parts)) assert.equal(p.length, p.text.length);
    assert.ok(a.parts.strings.length > 0, 'the string literal words are a piece');
    // file and line order
    const order = body.rows.map((r) => `${r.file}:${r.start}`);
    assert.deepEqual(order, [...order].sort((x, y) => { const [fx, sx] = x.split(':'), [fy, sy] = y.split(':'); return fx < fy ? -1 : fx > fy ? 1 : sx - sy; }));
  });

  it('filter keeps the functions whose file@name matches; textHas keeps those whose text matches', async () => {
    const f = await get('&filter=catalog');
    assert.deepEqual(f.rows.map((r) => r.name), ['loadCatalog']);
    assert.equal(f.total, 1); assert.equal(f.total_all, 3);
    const t = await get(`&textHas=${encodeURIComponent('cloud call')}`);
    assert.deepEqual(t.rows.map((r) => r.name), ['assertLocalOnly']);
    const re = await get(`&textHas=${encodeURIComponent('/^load catalog/')}`);
    assert.deepEqual(re.rows.map((r) => r.name), ['loadCatalog']);
    const none = await get('&textHas=zzz-nothing-zzz');
    assert.deepEqual(none.rows, []); assert.equal(none.total, 0);
    const capped = await get('&max=1');
    assert.equal(capped.rows.length, 1); assert.equal(capped.shown, 1); assert.equal(capped.total, 3);
  });

  it('textOrName keeps a function whose text or file@name matches; textHas stays text only; the parameters are ANDed', async () => {
    // the name is in the text only as separate words ("assert local only"), so the lower-case name without spaces is not in it
    const byName = await get('&textOrName=assertlocalonly');
    assert.deepEqual(byName.rows.map((r) => r.name), ['assertLocalOnly']);
    assert.deepEqual((await get('&textHas=assertlocalonly')).rows, [], 'textHas is the text only: the CLI meaning is unchanged');
    const byText = await get(`&textOrName=${encodeURIComponent('cloud call')}`);
    assert.deepEqual(byText.rows.map((r) => r.name), ['assertLocalOnly']);
    const byPath = await get('&textOrName=catalog.js');
    assert.deepEqual(byPath.rows.map((r) => r.name), ['loadCatalog'], 'the file part of file@name matches too');
    const rx = await get(`&textOrName=${encodeURIComponent('/^assertlocal/')}`);
    assert.deepEqual(rx.rows.map((r) => r.name), ['assertLocalOnly']);
    // AND with filter: the name filter keeps loadCatalog, the text filter only assertLocalOnly
    const both = await get(`&filter=catalog&textOrName=${encodeURIComponent('cloud call')}`);
    assert.deepEqual(both.rows, []); assert.equal(both.total, 0);
    assert.equal(both.empty_message, 'No function texts match name filter "catalog" and text-or-name filter "cloud call".');
    const agree = await get('&filter=gate&textOrName=assertlocalonly');
    assert.deepEqual(agree.rows.map((r) => r.name), ['assertLocalOnly']);
    // textHas and textOrName together are ANDed as well
    assert.deepEqual((await get('&textHas=cloud&textOrName=tiny')).rows, []);
    assert.equal((await get()).empty_message, '', 'no empty message when there are rows');
  });

  it('an empty answer names the filters in force and the test functions left out that would match', async () => {
    const m = await get('&textOrName=zzz-nothing-zzz');
    assert.equal(m.empty_message, 'No function texts match text-or-name filter "zzz-nothing-zzz".');
    const t = await get('&textOrName=checksgate');
    assert.deepEqual(t.rows, []); assert.equal(t.tests_left, 1);
    assert.match(t.empty_message, /^No function texts match text-or-name filter "checksgate"\. 1 test function left out would match/);
    const inc = await get('&textOrName=checksgate&includeTests=1');
    assert.deepEqual(inc.rows.map((r) => r.name), ['checksGate']); assert.equal(inc.tests_left, 0);
    // a test function that does not match leaves the count alone
    assert.equal((await get('&textOrName=tiny')).tests_left, 0);
  });

  it('test functions are left out unless includeTests', async () => {
    const out = await get();
    assert.ok(!out.rows.some((r) => r.name === 'checksGate'));
    const inc = await get('&includeTests=1');
    assert.equal(inc.tests_left, 0);
    assert.equal(inc.total, 4);
    assert.ok(inc.rows.some((r) => r.name === 'checksGate'));
    const onlyTest = await get('&filter=checksGate');
    assert.deepEqual(onlyTest.rows, []); assert.equal(onlyTest.tests_left, 1);
  });

  describe('with a mechanisms file', () => {
    before(async () => {
      const rows = (await get('&includeTests=1')).rows;
      const member = (name) => { const r = rows.find((x) => x.name === name); return { file: r.file, name: r.name, start: r.start, end: r.end }; };
      // tiny is in no mechanism; assertLocalOnly is in two; checksGate only in a test mechanism
      const records = [
        { id: 'm1', label: '[file] gate.js', kind: 'file', members: [member('assertLocalOnly')] },
        { id: 'm12', label: 'catalog (loadCatalog)', kind: 'token', members: [member('loadCatalog'), member('assertLocalOnly')] },
        { id: 'm3', label: '[file] test_gate.js', kind: 'file', tags: ['test'], members: [member('checksGate')] },
      ];
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(path.join(indexPath, 'mechanisms.json'), JSON.stringify({ format: MECHANISMS_FORMAT, version: 1, generated: '2026-11-10T00:00:00.000Z', records }));
    });

    it('each row names the mechanisms holding it, lowest number first; a function in no mechanism is embedded: false', async () => {
      const body = await get();
      assert.equal(body.hasMechanisms, true); assert.equal(body.message, '');
      const by = Object.fromEntries(body.rows.map((r) => [r.name, r]));
      assert.deepEqual(by.assertLocalOnly.mechanisms, ['m1', 'm12']);
      assert.equal(by.assertLocalOnly.embedded, true);
      assert.deepEqual(by.loadCatalog.mechanisms, ['m12']);
      assert.deepEqual(by.tiny.mechanisms, []);
      assert.equal(by.tiny.embedded, false);
      assert.equal(by.tiny.second_definition, false);
      assert.deepEqual([body.not_embedded, body.in_no_mechanism, body.second_definition], [1, 1, 0]);
    });

    it('id restricts the list to one mechanism\'s functions, as the CLI\'s id:mNNN does', async () => {
      const body = await get('&id=m12');
      assert.deepEqual(body.rows.map((r) => r.name).sort(), ['assertLocalOnly', 'loadCatalog']);
      assert.deepEqual(body.mechanism, { id: 'm12', label: 'catalog (loadCatalog)' });
      assert.ok(!body.rows.some((r) => r.name === 'tiny'));
      const viaCli = await get('&id=id:m12');
      assert.deepEqual(viaCli.rows.map((r) => r.id), body.rows.map((r) => r.id));
      // a mechanism of test code lists nothing until includeTests
      const t = await get('&id=m3');
      assert.deepEqual(t.rows, []); assert.equal(t.tests_left, 1);
      assert.deepEqual((await get('&id=m3&includeTests=1')).rows.map((r) => r.name), ['checksGate']);
      const bad = await fetch(q('&id=m999'));
      assert.equal(bad.status, 404);
      assert.match((await bad.json()).error, /has no mechanism m999; its mechanisms file has 3 mechanisms/);
      assert.equal((await fetch(q('&id=zzz'))).status, 400);
    });

    it('the filters combine with the mechanisms: textHas inside one mechanism', async () => {
      const body = await get(`&id=m12&textHas=${encodeURIComponent('cloud call')}`);
      assert.deepEqual(body.rows.map((r) => r.name), ['assertLocalOnly']);
      assert.equal(body.total_all, 2);
    });
  });
});
