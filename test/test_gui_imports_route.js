// test_gui_imports_route.js — /api/imports answers for a corpus with no Python (the Imports accordion is not Python-only)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// gui-imports-accordion-not-python-only: the route returned an empty result
// whenever the index held no Python files, so a C, Java or JavaScript corpus
// showed an empty Imports accordion under a label that blamed Python. The GUI
// bug is a route bug, so it is tested at the server layer: a tiny index with
// a C file and a JavaScript file, the real server on a free loopback port,
// one GET.
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
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-imports-route-'));
const src = path.join(work, 'src');
const indexPath = path.join(work, '.no_python_ndx');
let server = null;
let port = 0;
let log = '';

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on('error', reject);
});

describe('/api/imports is not Python-only', () => {
  before(async () => {
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'core.c'), '#include <stdio.h>\n#include "local.h"\nint main(void) { return 0; }\n');
    fs.writeFileSync(path.join(src, 'local.h'), '/* local */\n');
    fs.writeFileSync(path.join(src, 'app.js'), "import fs from 'node:fs';\nimport _ from 'lodash';\nexport const a = 1;\n");
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

  after(() => { if (server) server.kill(); });

  it('a corpus with C and JavaScript and no Python gets its imports', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/imports?index=${encodeURIComponent(path.basename(indexPath))}`);
    assert.equal(r.status, 200, `status ${r.status}\n${log.slice(0, 1000)}`);
    const body = await r.json();
    assert.ok(body.instances >= 2, `expected the C include and the JS imports as instances, got ${JSON.stringify(body).slice(0, 300)}`);
    const libs = body.imports.map((g) => g.library);
    assert.ok(libs.some((l) => /stdio/.test(l)), `expected stdio.h among ${libs.join(', ')}`);
    assert.ok(libs.includes('lodash'), `expected lodash among ${libs.join(', ')}`);
    assert.equal(body.pyFiles, undefined, 'the Python-only gate and its field are gone');
    assert.deepEqual(Object.keys(body.filesByLang || {}).sort(), ['c', 'js']);
  });
});
