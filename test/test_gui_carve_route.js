// test_gui_carve_route.js — /api/carve answers the listing of `ce --carve calls|clusters` as data: the same sections, numbers, headings and rows as the command, and says what to run when something is missing; /api/list-mechanisms takes the similarity order
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// carve-in-gui (2026-11-24). The GUI has no automated coverage (#262), so the Carve list is
// tested at its route, on the test_gui_mechanisms_route.js pattern: a small index, the real
// server on a free loopback port, GETs before and after the CLI builds the mechanisms index.
// The route sends what the pane shows. That the pane reads well is for a person to judge.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'index.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-carve-route-'));
const tree = path.join(work, 'tree');
const indexPath = path.join(work, '.carve_route_ndx');
let server = null, port = 0, log = '';
const base = (route) => `http://127.0.0.1:${port}/api/${route}?index=${encodeURIComponent(path.basename(indexPath))}`;
const get = async (extra = '', route = 'carve') => { const r = await fetch(base(route) + extra); return { status: r.status, body: await r.json() }; };
const cli = (args) => spawnSync(process.execPath, [CLI, '--index-path', indexPath, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });

/** What the command printed: { headings: Map(tag -> heading line text), tagOf: Map(id -> tag), order: [id...] }. */
function printed(stdout) {
  const headings = new Map(), tagOf = new Map(), order = [];
  for (const l of stdout.split(/\r?\n/)) {
    let m;
    if ((m = /^(\d+)\. (.*?) {3}\((\d+) mechanisms\)$/.exec(l))) headings.set(m[1], { heading: m[2], count: Number(m[3]) });
    else if ((m = /^ {3}(\d+\.\d+) (.*?) {3}\((\d+)\)$/.exec(l))) headings.set(m[1], { heading: m[2], count: Number(m[3]) });
    else if ((m = /^\s+(m\d+)\s+(.*) \[([^\]]+)\]$/.exec(l))) { tagOf.set(m[1], m[3]); order.push(m[1]); }
  }
  return { headings, tagOf, order };
}
/** The same three things from the route's answer. */
function answered(body) {
  const headings = new Map(), tagOf = new Map(), order = [];
  const take = (rows, tag) => { for (const r of rows) { tagOf.set(r.id, tag); order.push(r.id); } };
  for (const s of body.sections) {
    headings.set(s.tag, { heading: s.heading, count: s.count });
    if (s.rows) take(s.rows, s.tag);
    else for (const p of s.subs) { headings.set(p.tag, { heading: p.others ? '(others in this section)' : p.heading, count: p.count }); take(p.rows, p.tag); }
  }
  take(body.alone, 'alone'); take(body.unplaced, 'unplaced');
  return { headings, tagOf, order };
}

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

// Six domains of five functions that call each other inside the domain and never across, in two
// files each, so who-calls-whom has something to find; one test file; one file nothing calls.
const VERBS = ['post', 'seal', 'audit', 'void', 'open'];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const DOMAINS = ['zorble', 'quibbit', 'frobnic', 'wumpus', 'snarfle', 'blorple'];
const domainFile = (d, suffix) => {
  let t = `// ${d}${suffix}.js: handles the ${d} records.\n`;
  for (const v of VERBS) {
    const calls = VERBS.filter((x) => x !== v).slice(0, 3).map((x) => `${x}${cap(d)}Record${suffix}(a, b);`).join(' ');
    t += `export function ${v}${cap(d)}Record${suffix}(a, b) {\n  // ${v} the ${d} record\n  const r = a + b;\n  ${calls}\n  return r;\n}\n`;
  }
  return t;
};

describe('/api/carve', () => {
  before(async () => {
    const files = {};
    for (const d of DOMAINS) { files[`src/${d}/${d}.js`] = domainFile(d, ''); files[`src/${d}/${d}_more.js`] = domainFile(d, 'More') + `export function link${cap(d)}(a, b) {\n  post${cap(d)}Record(a, b);\n  post${cap(d)}RecordMore(a, b);\n  return a;\n}\n`; }
    files['tests/test_zorble.js'] = VERBS.map((v) => `export function test_${v}ZorbleRecord(a, b) {\n  // tests ${v} of a zorble record\n  const r = a + b;\n  ${v}ZorbleRecord(a, b);\n  return r;\n}\n`).join('\n');
    files['src/lonely/lonely.js'] = ['One', 'Two', 'Three', 'Four'].map((n) => `export function plain${n}(a, b) {\n  // adds two numbers\n  const r = a + b;\n  return r * 3;\n}\n`).join('\n');
    for (const [rel, text] of Object.entries(files)) { const p = path.join(tree, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); }
    const idx = new CodeSearchIndex({ indexPath });
    await idx.buildIndex(tree, { showProgress: false });
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

  it('before a mechanisms index is built: nothing is carved, the answer is the one not-built line, and nothing is built', async () => {
    const { status, body } = await get('&how=calls');
    assert.equal(status, 200, log.slice(0, 1000));
    assert.equal(body.built, false);
    assert.equal(body.kind, 'no-mechanisms');
    assert.match(body.message, /^not built: run .*--build-mechanisms/);
    assert.deepEqual(body.sections, []);
    assert.ok(!fs.existsSync(path.join(indexPath, 'mechanisms.json')));
  });

  it('calls: the command\'s sections, numbers, headings and rows, row for row and in its order', async () => {
    const b = cli(['--build-mechanisms']);
    assert.equal(b.status, 0, b.stdout + b.stderr);
    const out = cli(['--carve', 'calls']);
    assert.equal(out.status, 0, out.stderr);
    const want = printed(out.stdout);
    assert.ok(want.order.length >= 8 && want.headings.size >= 2, out.stdout);
    const { status, body } = await get('&how=calls');
    assert.equal(status, 200);
    assert.equal(body.built, true);
    assert.equal(body.how, 'calls');
    const got = answered(body);
    assert.deepEqual(got.order, want.order, 'the same rows in the same order');
    assert.deepEqual([...got.tagOf], [...want.tagOf], 'each under the same number');
    assert.deepEqual([...got.headings], [...want.headings], 'the same headings and counts');
    assert.equal(body.total, want.order.length);
    assert.deepEqual([body.settings.resolution, body.settings.seed], [2, 5]);
    assert.equal(body.sections_count, [...want.headings.keys()].filter((t) => !t.includes('.')).length);
    // a row carries what the pane shows and what its click needs
    const row = body.sections[0].rows ? body.sections[0].rows[0] : body.sections[0].subs[0].rows[0];
    assert.match(row.id, /^m\d+$/);
    assert.ok(row.label && typeof row.text === 'string');
    // the header facts of the command are in the answer, not dropped
    assert.match(body.facts.join('\n'), /Louvain community detection/);
    assert.match(body.facts.join('\n'), /a suggestion and not a finding/);
  });

  it('test mechanisms are left out unless include_tests is set, and the answer says how many', async () => {
    const without = (await get('&how=calls')).body, withTests = (await get('&how=calls&include_tests=1')).body;
    assert.ok(without.tests_left >= 1);
    assert.equal(withTests.tests_left, 0);
    assert.equal(withTests.total, without.total + without.tests_left);
    assert.deepEqual(answered(withTests).order, printed(cli(['--carve', 'calls', '--include-tests']).stdout).order);
  });

  it('resolution and seed are the command\'s: another resolution gives the command\'s listing for it, and a wrong number is refused in its words', async () => {
    const got = answered((await get('&how=calls&resolution=6&seed=3')).body), want = printed(cli(['--carve', 'calls', '--resolution', '6', '--seed', '3']).stdout);
    assert.deepEqual([...got.tagOf], [...want.tagOf]);
    const bad = await get('&how=calls&resolution=-1');
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /--resolution takes a number above 0/);
    assert.equal((await get('&how=sideways')).status, 400);
  });

  it('a filter keeps the rows whose id or label matches and the sections that hold them, with their numbers and whole counts', async () => {
    const all = (await get('&how=calls')).body, f = (await get('&how=calls&filter=quibbit')).body;
    const got = answered(f), whole = answered(all);
    assert.ok(got.order.length >= 1 && got.order.length < whole.order.length);
    for (const id of got.order) assert.equal(got.tagOf.get(id), whole.tagOf.get(id), `${id} keeps its number`);
    for (const [tag, h] of got.headings) assert.deepEqual(h, whole.headings.get(tag), `${tag} keeps its heading and its whole count`);
    assert.equal(f.matched, got.order.length);
    assert.equal(f.total, all.total);
    const none = (await get('&how=calls&filter=zzznothing')).body;
    assert.equal(none.matched, 0);
    assert.deepEqual(none.sections, []);
  });

  it('clusters with no embeddings: carved nothing, said why and what to run, and that calls needs none', async () => {
    const { status, body } = await get('&how=clusters');
    assert.equal(status, 200);
    assert.equal(body.built, false);
    assert.equal(body.kind, 'no-embeddings');
    assert.match(body.message, /--build-embeddings/);
    assert.match(body.message, /calls needs no embeddings/);
    assert.deepEqual(body.sections, []);
  });

  it('/api/list-mechanisms takes sort=similarity: with no saved order it lists nothing and says how to make one', async () => {
    const { status, body } = await get('&sort=similarity', 'list-mechanisms');
    assert.equal(status, 200);
    assert.equal(body.order, 'similarity');
    assert.deepEqual(body.records, []);
    assert.match(body.order_message, /No similarity order is saved for this index/);
    assert.match(body.order_message, /--carve clusters/);
    const size = (await get('', 'list-mechanisms')).body;
    assert.equal(size.order, 'size');
    assert.ok(size.records.length >= 5 && !size.order_message);
  });
});
