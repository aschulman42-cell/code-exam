// test_gui_index_switch.js — /api/activate-index makes another loaded index the active one: routes asked without ?index= then answer for it, every index stays loaded, and a name that is not loaded is refused
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// gui-loaded-index-row-makes-it-active (2026-11-25). With several indexes loaded
// (`--index-path` given more than once) the page's Indexes list showed them and a click on one
// did nothing. The GUI has no automated coverage (#262), so the click is tested at the route it
// calls, on the test_gui_carve_route.js pattern: small indexes, the real server on a free
// loopback port. That the row looks clickable and the page resets is for a person to see.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-index-switch-'));
const idxA = path.join(work, '.switch_alpha');
const idxB = path.join(work, '.switch_beta');
let server = null, port = 0, log = '';
const url = (route) => `http://127.0.0.1:${port}/api/${route}`;
const get = async (route) => { const r = await fetch(url(route)); return { status: r.status, body: await r.json() }; };
const post = async (route, payload) => {
  const r = await fetch(url(route), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.json() };
};
const activeName = (body) => (body.indexes.find((i) => i.active) || {}).name;
const fileNames = (body) => JSON.stringify(body);

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

async function build(indexPath, files) {
  const tree = indexPath + '_tree';
  for (const [rel, text] of Object.entries(files)) { const p = path.join(tree, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
  const idx = new CodeSearchIndex({ indexPath });
  await idx.buildIndex(tree, { showProgress: false });
}

describe('/api/activate-index', () => {
  before(async () => {
    await build(idxA, { 'alpha_one.js': 'export function alphaOne(a) {\n  return a + 1;\n}\n', 'alpha_two.js': 'export function alphaTwo(a) {\n  return a + 2;\n}\n' });
    await build(idxB, { 'beta_only.js': 'export function betaOnly(a) {\n  return a * 2;\n}\n' });
    port = await freePort();
    server = spawn(process.execPath, ['src/server.js', '--port', String(port), '--index-path', idxA, '--index-path', idxB], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => { log += d; });
    server.stderr.on('data', (d) => { log += d; });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try { const r = await fetch(url('indexes')); if (r.ok) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server did not answer on ${port}:\n${log.slice(0, 2000)}`);
  });

  after(() => {
    if (server) server.kill();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* a handle may linger on Windows */ }
  });

  it('at start the first index given is active, and a route asked without ?index= answers for it', async () => {
    const { body } = await get('indexes');
    assert.deepEqual(body.indexes.map((i) => i.name), ['.switch_alpha', '.switch_beta'], log.slice(0, 1000));
    assert.equal(activeName(body), '.switch_alpha');
    const files = fileNames((await get('list-files')).body);
    assert.match(files, /alpha_one\.js/);
    assert.doesNotMatch(files, /beta_only\.js/);
  });

  it('switching makes the other index active, routes without ?index= then answer for it, and both stay loaded', async () => {
    const before = log.length;
    const { status, body } = await post('activate-index', { name: '.switch_beta' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.active, '.switch_beta');
    assert.equal(body.previous, '.switch_alpha');
    assert.equal(activeName(body), '.switch_beta');
    assert.deepEqual(body.indexes.map((i) => i.name), ['.switch_alpha', '.switch_beta']);
    assert.equal(activeName((await get('indexes')).body), '.switch_beta');
    const files = fileNames((await get('list-files')).body);
    assert.match(files, /beta_only\.js/);
    assert.doesNotMatch(files, /alpha_one\.js/);
    // The index not active still answers when named.
    assert.match(fileNames((await get('list-files?index=.switch_alpha')).body), /alpha_one\.js/);
    assert.doesNotMatch(log.slice(before), /Loaded index|\[load-index\]/, 'nothing was loaded or released by the switch');
  });

  it('switching back works, and asking for the one already active changes nothing', async () => {
    const back = await post('activate-index', { name: '.switch_alpha' });
    assert.equal(back.body.active, '.switch_alpha');
    assert.match(fileNames((await get('list-files')).body), /alpha_one\.js/);
    const again = await post('activate-index', { name: '.switch_alpha' });
    assert.equal(again.status, 200);
    assert.equal(again.body.active, '.switch_alpha');
    assert.equal(again.body.previous, '.switch_alpha');
  });

  it('a name that is not loaded is refused with the loaded names, and the active index stays', async () => {
    const { status, body } = await post('activate-index', { name: '.switch_gamma' });
    assert.equal(status, 404);
    assert.match(body.error, /\.switch_gamma/);
    assert.match(body.error, /\.switch_alpha/);
    assert.match(body.error, /\.switch_beta/);
    assert.equal(activeName((await get('indexes')).body), '.switch_alpha');
    const none = await post('activate-index', {});
    assert.equal(none.status, 400);
  });

  it('GET is refused', async () => {
    const { status } = await get('activate-index');
    assert.equal(status, 405);
  });
});
