// test_gui_mechanisms_route.js — /api/list-mechanisms answers the not-built line before --build-mechanisms and the records, with members a click can open, after it
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// mechanisms-index-prebuild-cli-gui, Part C: the GUI has no automated
// coverage (#262), so the Mechanisms accordion is tested at its route, on
// the test_gui_imports_route.js pattern -- a tiny index, the real server on
// a free loopback port, GETs before and after the CLI build. The pane renders
// `message` as the whole list when `built` is false, and a member's
// filepath / start / end are what its click hands the source viewer.
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-mechanisms-route-'));
const src = path.join(work, 'src');
const indexPath = path.join(work, '.mech_route_ndx');
const q = (extra = '') => `http://127.0.0.1:${port}/api/list-mechanisms?index=${encodeURIComponent(path.basename(indexPath))}${extra}`;
let server = null;
let port = 0;
let log = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

describe('/api/list-mechanisms', () => {
  before(async () => {
    fs.mkdirSync(path.join(src, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(src, 'pkg', 'ledger.py'), [
      '"""ledger.py -- keeps a running balance per account and settles the day\'s entries into one statement per account."""',
      '',
      'class Ledger:',
      '    """Holds the entries of one day."""',
      '',
      '    def __init__(self):',
      '        self.entries = []',
      '        self.closed = False',
      '        self.total = 0',
      '',
      '    def post_entry(self, amount):',
      '        self.entries.append(amount)',
      '        self.total += amount',
      '        return self.total',
      '',
      '    def settle(self):',
      '        self.closed = True',
      '        s = sum(self.entries)',
      '        return s',
      '',
      '',
      'def statement(ledger):',
      '    """One line per entry and the total."""',
      '    lines = [str(e) for e in ledger.entries]',
      '    lines.append(str(ledger.total))',
      '    return lines',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(src, 'util.js'), [
      '// util.js — small helpers the ledger scripts share: padding and rounding.',
      'export function pad(s, n) {',
      '  const t = String(s);',
      '  const k = Math.max(0, n - t.length);',
      '  return t + " ".repeat(k);',
      '}',
      'export function round2(x) {',
      '  const y = Math.round(x * 100);',
      '  const z = y / 100;',
      '  return z;',
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

  it('before the build: built is false and the message is the one not-built line with the command to run', async () => {
    const r = await fetch(q());
    assert.equal(r.status, 200, `status ${r.status}\n${log.slice(0, 1000)}`);
    const body = await r.json();
    assert.equal(body.built, false);
    assert.equal(body.total, 0);
    assert.deepEqual(body.records, []);
    assert.match(body.message, /^not built: run .*--index-path .* --build-mechanisms \(about \d+ minutes? on an index this size\)$/, body.message);
  });

  it('after the CLI build: the records, each with counts, text, tags and members a click can open; the filter and the cap work', async () => {
    const b = spawnSync(process.execPath, ['src/index.js', '--index-path', indexPath, '--build-mechanisms'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    assert.equal(b.status, 0, (b.stdout || '') + (b.stderr || ''));
    const body = await (await fetch(q())).json();
    assert.equal(body.built, true, JSON.stringify(body).slice(0, 300));
    assert.ok(body.generated && body.coverage && body.coverage.inGroups === body.coverage.functions, JSON.stringify(body.coverage));
    assert.equal(body.total, body.total_all);
    assert.ok(body.total >= 3, `records: ${body.records.map((r) => r.label).join(' | ')}`);
    const ledger = body.records.find((r) => r.label === '[class] Ledger');
    assert.ok(ledger, body.records.map((r) => r.label).join(' | '));
    assert.equal(ledger.kind, 'class');
    assert.equal(ledger.files, 1);
    assert.match(ledger.purpose, /^Holds the entries of one day\./);
    assert.equal(ledger.description, null);
    assert.deepEqual(ledger.tags, []);
    assert.equal(ledger.members_total, ledger.members.length);
    const add = ledger.members.find((m) => m.name === 'Ledger::post_entry');
    assert.ok(add, ledger.members.map((m) => m.name).join(', '));
    assert.ok(/ledger\.py$/.test(add.filepath) && add.start >= 1 && add.end >= add.start && add.lines === add.end - add.start + 1, JSON.stringify(add));
    assert.equal(add.display_name, 'Ledger::post_entry');
    const file = body.records.find((r) => r.label === '[file] ledger.py');
    assert.match(file.purpose, /^ledger\.py -- keeps a running balance per account/);
    assert.ok(file.members.some((m) => m.name === 'Ledger::post_entry'), 'overlap: the method is in its file record too');
    const util = body.records.find((r) => r.label === '[file] util.js');
    assert.match(util.purpose, /^util\.js — small helpers/);

    const filtered = await (await fetch(q('&filter=statement'))).json();
    assert.ok(filtered.total >= 1 && filtered.total < body.total_all, JSON.stringify({ total: filtered.total, all: filtered.total_all }));
    assert.equal(filtered.total_all, body.total_all);
    assert.ok(filtered.records.every((r) => r.label.includes('ledger') || r.members.some((m) => m.name === 'statement')), filtered.records.map((r) => r.label).join(' | '));
    const none = await (await fetch(q('&filter=zzz-nothing'))).json();
    assert.equal(none.built, true); assert.equal(none.total, 0); assert.deepEqual(none.records, []);
    const capped = await (await fetch(q('&max=1'))).json();
    assert.equal(capped.records.length, 1); assert.equal(capped.total, body.total);
  });
});
