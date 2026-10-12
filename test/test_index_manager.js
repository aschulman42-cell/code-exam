// test_index_manager.js — IndexManager.replace releases the old index, re-points the caller's reference, and logs memory per stage
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_index_manager.js — worklist item gui-load-index-memory-release.
 *
 * The bogosity: load a large index in the GUI, Load Index a small one, and
 * memory stays put until Ctrl-C. The GUI route cleared its own map, but the
 * MCP tool module kept a reference (setIndex) that nothing reset. This test
 * pins the contract that fixes it:
 *   - replace() leaves only the new index in the manager, active;
 *   - the onRelease hook fires BEFORE the forced GC and onActive fires with
 *     the new instance, so a caller can drop and re-point its own reference;
 *   - the old instance is actually collectable afterwards (WeakRef + forced
 *     GC), when a forced GC can be obtained;
 *   - three [load-index] log lines with the named fields land, in order;
 *   - server.js wires the route to replace() with setIndex on both hooks
 *     (source assertion — server.js can't be imported, it starts the server).
 *
 * Run: node --test test/test_index_manager.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { IndexManager, obtainForcedGc, runForcedGc, formatLoadIndexLog, memorySnapshot } from '../src/core/index-manager.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(os.tmpdir(), 'ce_index_manager_test');
const SRC_A = path.join(ROOT, 'src_a');
const IDX_A = path.join(ROOT, 'idx_alpha');
const SRC_B = path.join(ROOT, 'src_b');
const IDX_B = path.join(ROOT, 'idx_beta');

async function buildFixture(src, idx, files) {
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(idx, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(src, name), body);
  const index = new CodeSearchIndex({ indexPath: idx });
  await index.buildIndex(src, { showProgress: false });
}

const LOG_RE = /^\[load-index\] stage=(before|released|loaded|settled\+\d+s) index=(\S+) files=(\d+) rssMB=\d+ heapUsedMB=\d+ heapTotalMB=\d+ externalMB=\d+ gc=(\S+)$/;

before(async () => {
  await buildFixture(SRC_A, IDX_A, {
    'alpha.py': 'def alpha_one():\n    return 1\n\ndef alpha_two():\n    return alpha_one() + 1\n',
    'alpha_util.py': 'def alpha_helper(x):\n    return str(x)\n',
  });
  await buildFixture(SRC_B, IDX_B, {
    'beta.py': 'def beta_only():\n    return "beta"\n',
  });
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function managerWithLog() {
  const lines = [];
  // settleMs: null — no delayed stage=settled timer inside the test process.
  const mgr = new IndexManager({ log: (s) => lines.push(String(s)), warn: (s) => lines.push('WARN ' + String(s)), settleMs: null });
  return { mgr, lines };
}

describe('IndexManager.load / get / list (unchanged behavior after the move)', () => {
  it('loads an index by directory, names it by basename, makes the first one active', () => {
    const { mgr } = managerWithLog();
    const name = mgr.load(IDX_A);
    assert.equal(name, 'idx_alpha');
    assert.equal(mgr.activeIndex, 'idx_alpha');
    assert.equal(mgr.get().files.size, 2);
    assert.deepEqual(mgr.list().map(i => [i.name, i.active]), [['idx_alpha', true]]);
  });
});

describe('IndexManager.replace — the Load Index (replace mode) contract', () => {
  it('leaves only the new index, active, and fires onRelease then onActive(newIndex)', () => {
    const { mgr, lines } = managerWithLog();
    mgr.load(IDX_A);
    const calls = [];
    const name = mgr.replace(IDX_B, {
      onRelease: () => calls.push(['release']),
      onActive: (idx) => calls.push(['active', idx]),
    });
    assert.equal(name, 'idx_beta');
    assert.deepEqual([...mgr.indexes.keys()], ['idx_beta']);
    assert.equal(mgr.activeIndex, 'idx_beta');
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'release');
    assert.equal(calls[1][0], 'active');
    assert.equal(calls[1][1], mgr.get(), 'onActive receives the instance the manager now serves');
    assert.equal(calls[1][1].files.size, 1);
    // The release hook must run BEFORE the "released" log line (i.e. before the GC).
    const releasedAt = lines.findIndex(l => l.includes('stage=released'));
    assert.ok(releasedAt > 0, 'a stage=released line was logged');
  });

  it('logs before / released / loaded with the named fields, in that order', () => {
    const { mgr, lines } = managerWithLog();
    mgr.load(IDX_A);
    mgr.replace(IDX_B);
    const stages = lines.filter(l => l.startsWith('[load-index]'));
    assert.equal(stages.length, 3, `three [load-index] lines, got:\n${lines.join('\n')}`);
    const parsed = stages.map(l => {
      const m = LOG_RE.exec(l);
      assert.ok(m, `line matches the documented shape: ${l}`);
      return { stage: m[1], index: m[2], files: Number(m[3]), gc: m[4] };
    });
    assert.deepEqual(parsed.map(p => p.stage), ['before', 'released', 'loaded']);
    assert.deepEqual(parsed.map(p => p.index), ['idx_alpha', '-', 'idx_beta']);
    assert.deepEqual(parsed.map(p => p.files), [2, 0, 1]);
    // gc at "released" is the outcome (ran[:last-resort] / unavailable / failed:…); never blank.
    assert.ok(parsed[1].gc.length > 0);
    if (obtainForcedGc().gc) assert.match(parsed[1].gc, /^ran(:last-resort)?$/);
    else assert.equal(parsed[1].gc, 'unavailable');
  });

  it('records a memory summary of the last replace for the GUI (whole MB, gc outcome)', () => {
    const { mgr } = managerWithLog();
    mgr.load(IDX_A);
    assert.equal(mgr.lastReplace, null);
    mgr.replace(IDX_B);
    const r = mgr.lastReplace;
    for (const k of ['beforeMB', 'releasedMB', 'loadedMB', 'heapBeforeMB', 'heapReleasedMB']) {
      assert.ok(Number.isInteger(r[k]) && r[k] >= 0, `${k}=${r[k]}`);
    }
    assert.ok(typeof r.gc === 'string' && r.gc.length > 0);
  });

  it('with no prior index, stage=before reports index=- files=0 and still loads', () => {
    const { mgr, lines } = managerWithLog();
    const name = mgr.replace(IDX_B);
    assert.equal(name, 'idx_beta');
    const before = lines.find(l => l.includes('stage=before'));
    assert.match(before, /index=- files=0 /);
  });

  it('the GC that replace() itself runs frees the old index — no later collection needed', async (t) => {
    // The field test (2026-10-11, 29,597-file index): heapUsedMB identical at
    // stage=before and stage=released with gc=ran. Cause: replace() held the
    // outgoing index in a local while calling gc(). The test below this one
    // passed anyway because it ran ITS OWN gc() after replace() returned. This
    // test derefs immediately after replace(), so the in-replace GC is the
    // only collection that could have freed the instance.
    const { gc, how } = obtainForcedGc();
    if (!gc) {
      t.skip(`no forced GC available in this process (gc=${how})`);
      return;
    }
    const { mgr, lines } = managerWithLog();
    mgr.load(IDX_A);
    const ref = new WeakRef(mgr.get());
    // WeakRef targets are kept alive to the end of the job that created the
    // ref; start a fresh job before replace() so only replace()'s own gc counts.
    await new Promise(r => setTimeout(r, 0));
    mgr.replace(IDX_B, { onRelease: () => {}, onActive: () => {} });
    assert.ok(lines.some(l => l.includes('stage=released') && l.includes('gc=ran')), 'replace ran the forced GC');
    assert.equal(ref.deref(), undefined, 'the outgoing index was collected by the GC inside replace()');
  });

  it('the old index instance is collectable after replace (WeakRef + forced GC)', async (t) => {
    const { gc, how } = obtainForcedGc();
    if (!gc) {
      t.skip(`no forced GC available in this process (gc=${how}); the contract is covered structurally above`);
      return;
    }
    const { mgr } = managerWithLog();
    mgr.load(IDX_A);
    let ref = new WeakRef(mgr.get());
    // Mirror what server.js does: the caller holds its own reference and drops
    // it in onRelease — if it didn't, this test is what would catch the pin.
    let callerRef = mgr.get();
    mgr.replace(IDX_B, { onRelease: () => { callerRef = null; }, onActive: (idx) => { callerRef = idx; } });
    assert.equal(callerRef, mgr.get());
    // WeakRef targets are kept alive for the rest of the current job; yield to
    // a macrotask before collecting, then yield again so finalization settles.
    await new Promise(r => setTimeout(r, 0));
    gc();
    await new Promise(r => setTimeout(r, 0));
    gc();
    assert.equal(ref.deref(), undefined, 'the replaced CodeSearchIndex is no longer reachable');
  });
});

describe('forced GC + memory snapshot helpers', () => {
  it('obtainForcedGc reports how it got a gc (flag / runtime) or that none is available', () => {
    const r = obtainForcedGc();
    assert.ok(['flag', 'runtime', 'unavailable'].includes(r.how), r.how);
    assert.equal(typeof r.gc === 'function', r.how !== 'unavailable');
    if (r.gc) assert.doesNotThrow(() => r.gc());
  });

  it('runForcedGc returns freed heap to the OS at the call, not ~10 s later (the Task Manager bogosity)', (t) => {
    // Field test 2 (2026-10-11): heapUsedMB 1632 → 27 but rssMB only 1853 →
    // 1650 — plain gc() frees objects while V8 keeps the pages resident until a
    // reduce-memory GC it schedules itself ~10 s on. The "last-resort" flavor
    // runs that path synchronously. Fixture: ~200 MB of index-shaped heap.
    const { gc, how } = obtainForcedGc();
    if (!gc) { t.skip(`no forced GC available (gc=${how})`); return; }
    let junk = new Map();
    for (let f = 0; f < 6000; f++) {
      const lines = [];
      for (let i = 0; i < 60; i++) lines.push(`file_${f}_line_${i}: def function_${f}_${i}(value, other): return value * ${i} + other  # ${'x'.repeat(40)}`);
      junk.set(`dir/file_${f}.py`, { lines, calls: new Map(lines.map((l, i) => [`fn_${f}_${i}`, i])) });
    }
    const before = memorySnapshot();
    junk = null;
    const outcome = runForcedGc(gc);
    const after = memorySnapshot();
    assert.match(outcome, /^ran(:last-resort)?$/);
    assert.ok(after.heapUsedMB < before.heapUsedMB - 100, `heap freed: ${before.heapUsedMB} → ${after.heapUsedMB} MB`);
    if (outcome === 'ran:last-resort') {
      assert.ok(after.rssMB < before.rssMB - 100, `resident memory returned at the call: rss ${before.rssMB} → ${after.rssMB} MB`);
    } else {
      t.diagnostic(`gc extension has no last-resort flavor here (${outcome}); rss ${before.rssMB} → ${after.rssMB} MB not asserted`);
    }
  });

  it('memorySnapshot returns whole-MB integers for the four fields', () => {
    const s = memorySnapshot();
    for (const k of ['rssMB', 'heapUsedMB', 'heapTotalMB', 'externalMB']) {
      assert.equal(typeof s[k], 'number', k);
      assert.ok(Number.isInteger(s[k]) && s[k] >= 0, `${k}=${s[k]}`);
    }
  });

  it('formatLoadIndexLog produces the documented one-line shape', () => {
    const line = formatLoadIndexLog('before', { name: '.py_tools', files: 183422, gc: 'runtime' }, { rssMB: 6120, heapUsedMB: 5410, heapTotalMB: 5890, externalMB: 12 });
    assert.equal(line, '[load-index] stage=before index=.py_tools files=183422 rssMB=6120 heapUsedMB=5410 heapTotalMB=5890 externalMB=12 gc=runtime');
    assert.match(line, LOG_RE);
  });
});

describe('server.js wiring (source assertion — server.js starts the HTTP server on import)', () => {
  it('/api/load-index replace mode calls mgr.replace with setIndex on both hooks', () => {
    const src = fs.readFileSync(path.join(HERE, '..', 'src', 'server.js'), 'utf8');
    const start = src.indexOf("routes['/api/load-index']");
    assert.ok(start > 0, 'the load-index route exists');
    const end = src.indexOf('routes[', start + 10);
    const route = src.slice(start, end > 0 ? end : undefined);
    assert.match(route, /mgr\.replace\(/, 'replace mode goes through IndexManager.replace');
    assert.match(route, /onRelease:\s*\(\)\s*=>\s*setIndex\(null\)/, 'the tool module reference is dropped before the GC');
    assert.match(route, /onActive:\s*\(idx\)\s*=>\s*setIndex\(idx\)/, 'the tool module is re-pointed at the new index');
    assert.doesNotMatch(route, /mgr\.indexes\.clear\(\)/, 'the old inline clear is gone (it left the tool module reference behind)');
    assert.match(src, /import \{ IndexManager \} from '\.\/core\/index-manager\.js'/, 'server.js imports the moved manager');
    assert.doesNotMatch(src, /^class IndexManager\b/m, 'no second copy of IndexManager lives in server.js');
  });
});
