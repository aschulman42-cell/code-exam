// test_gui_concepts_route.js — /api/concepts answers the rows of `ce --concepts`: the same concepts in the same order with the same counts, with what a row opens to, before and after a mechanisms index is built
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// issue-364-concepts-gui-accordion (2026-11-24). The GUI has no automated coverage (#262), so
// the Concepts accordion is tested at its route, on the test_gui_mechanisms_route.js pattern: a
// small index, the real server on a free loopback port, GETs before and after the CLI builds the
// mechanisms index. What the route sends is what the pane shows: a row's word, example, files
// and count, and under it the mechanisms a click opens. That the pane reads well is not tested
// here and is for a person to judge in the running GUI.
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-concepts-route-'));
const tree = path.join(work, 'tree');   // the source tree; the index sits beside it, not inside
const indexPath = path.join(work, '.concepts_route_ndx');
let server = null, port = 0, log = '';
const url = (extra = '') => `http://127.0.0.1:${port}/api/concepts?index=${encodeURIComponent(path.basename(indexPath))}${extra}`;
const get = async (extra) => { const r = await fetch(url(extra)); return { status: r.status, body: await r.json() }; };
const cli = (args) => spawnSync(process.execPath, [CLI, '--index-path', indexPath, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
/** The rows of the command's listing: [{ n, word, count }]. */
const rowsOf = (stdout) => stdout.split(/\r?\n/).map((l) => /^\s{1,4}(\d+)\. (\S+?):?(?: .*?)?(?: {2}\(([\d,]+)\))?$/.exec(l)).filter(Boolean).map((m) => ({ n: Number(m[1]), word: m[2], count: m[3] == null ? null : Number(m[3].replace(/,/g, '')) }));

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

// The fixture of test_concepts.js, smaller: a domain word inside compound names in two files each
// (a vocabulary token must be in two documents), one test file, and a word that is in comments
// of half the files and names nothing.
const VERBS = ['post', 'seal', 'audit', 'void', 'open'];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const DOMAINS = ['zorble', 'quibbit', 'frobnic', 'wumpus', 'snarfle', 'blorple'];
const domainFile = (d) => {
  let t = `// ${d}.js: handles the ${d} records.\n`;
  for (const v of VERBS) {
    const calls = VERBS.filter((x) => x !== v).slice(0, 2).map((x) => `${x}${cap(d)}Record(a, b);`).join(' ');
    t += `export function ${v}${cap(d)}Record(a, b) {\n  // ${v} the ${d} record\n  const r = a + b;\n  ${calls}\n  return r;\n}\n`;
  }
  return t;
};

describe('/api/concepts', () => {
  before(async () => {
    const files = {};
    for (const d of DOMAINS) { files[`src/${d}/${d}.js`] = domainFile(d); files[`src/${d}/${d}_more.js`] = domainFile(d).replace(/^\/\/.*\n/, '// more of the same.\n'); }
    files['tests/test_zorble.js'] = VERBS.map((v) => `export function test_${v}ZorbleRecord(a, b) {\n  // tests ${v} of a zorble record\n  const r = a + b;\n  return r;\n}\n`).join('\n');
    Object.keys(files).forEach((k, i) => { if (i % 2 === 0) files[k] = `// kept by Glorfindus.\n${files[k]}`; });
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

  it('before a mechanisms index is built: the command\'s concepts in its order, no counts, and the one not-built line', async () => {
    const { status, body } = await get('&max=1000');
    assert.equal(status, 200, log.slice(0, 1000));
    const want = rowsOf(cli(['--concepts', '--all-results']).stdout);
    assert.ok(want.length >= 5, 'the fixture has concepts');
    assert.deepEqual(body.rows.map((r) => r.concept), want.map((r) => r.word));
    assert.equal(body.total, want.length);
    assert.equal(body.mechanisms, 'missing');
    assert.match(body.message, /^not built: run .*--build-mechanisms/);
    assert.ok(body.rows.every((r) => r.named === null && r.mechanisms === null));
    assert.ok(!fs.existsSync(path.join(indexPath, 'mechanisms.json')), 'the route never builds');
  });

  it('after the build: every row has the command\'s count, and under it the mechanisms that count is of', async () => {
    const b = cli(['--build-mechanisms']);
    assert.equal(b.status, 0, b.stdout + b.stderr);
    const { body } = await get('&max=1000');
    const want = rowsOf(cli(['--concepts', '--all-results']).stdout);
    assert.deepEqual(body.rows.map((r) => [r.rank, r.concept, r.named]), want.map((r) => [r.n, r.word, r.count]));
    assert.equal(body.mechanisms, 'ok');
    const z = body.rows.find((r) => r.concept === 'zorble');
    assert.ok(z.named >= 1);
    assert.equal(z.mechanisms.length, z.named);
    for (const m of z.mechanisms) { assert.match(m.id, /^m\d+$/); assert.ok(m.label && m.fns >= 1 && m.files >= 1, JSON.stringify(m)); }
    // a row's example and where it is, for the click that opens it
    assert.match(z.example, /Zorble/);
    assert.ok(z.example_file && /zorble/.test(z.example_file), z.example_file);
    // a concept that is itself a top vocabulary term has files; one that names nothing has a zero count and no mechanisms
    assert.ok(z.files.length >= 1 && z.files.every((f) => typeof f === 'string'));
    const g = body.rows.find((r) => r.concept === 'glorfindus');
    assert.ok(g, body.rows.map((r) => r.concept).join(' '));
    assert.equal(g.named, 0);
    assert.deepEqual(g.mechanisms, []);
  });

  it('test mechanisms are left out of the counts unless include_tests is set, and the answer says how many', async () => {
    const without = (await get('&max=1000')).body;
    const withTests = (await get('&max=1000&include_tests=1')).body;
    const named = (b) => b.rows.find((r) => r.concept === 'zorble').named;
    assert.ok(named(withTests) > named(without), `${named(withTests)} > ${named(without)}`);
    assert.ok(without.tests_left >= 1);
    assert.equal(withTests.tests_left, 0);
  });

  it('filter keeps the concepts whose word matches, with their place in the whole list; max caps the rows and total says how many there are', async () => {
    const all = (await get('&max=1000')).body;
    const f = (await get('&max=1000&filter=quib')).body;
    assert.deepEqual(f.rows.map((r) => r.concept), ['quibbit']);
    assert.equal(f.rows[0].rank, all.rows.find((r) => r.concept === 'quibbit').rank);
    assert.equal(f.matched, 1);
    assert.equal(f.total, all.total, 'total is of the index, not of the filter');
    const capped = (await get('&max=2')).body;
    assert.equal(capped.rows.length, 2);
    assert.equal(capped.matched, all.total);
    const none = (await get('&filter=zzznothing')).body;
    assert.deepEqual(none.rows, []);
    assert.equal(none.matched, 0);
    assert.match(none.empty_message, /zzznothing/);
  });

  it('with no index the answer is a 404, as for the other lists', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/concepts?index=no_such_index`);
    assert.equal(r.status, 404);
  });
});
