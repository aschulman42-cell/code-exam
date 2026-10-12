// index-manager.js — holds the GUI server's named indexes; replace() releases the old one, forces a GC when one is available, and logs process memory per stage
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Moved out of server.js (2026-10-11, worklist item gui-load-index-memory-release)
// so the replace path is unit-testable: server.js starts the HTTP server on
// import, and no test imports it.
//
// WHY replace() EXISTS. The GUI's Load Index (replace mode) used to clear the
// map and load inline in the route — correct as far as this manager goes. But
// the chat / analyze / overview-by-AI loops hand the active index to the MCP
// tool module (mcp-server.js setIndex), and nothing reset that reference on
// Load Index. After a switch the OLD index stayed reachable from a module-level
// variable until the next chat call on the new one — or forever if there was
// none. A user who examined a large index, then loaded a small one, watched
// Task Manager stay full and had to Ctrl-C the server. replace() takes
// onRelease / onActive hooks so server.js drops and re-points that reference
// in the same step, and logs process memory before / after release / after
// load so "is anything else still pinned?" is answered by the user's normal
// run, not by inspection.

import v8 from 'v8';
import vm from 'vm';
import path from 'path';
import { CodeSearchIndex } from './CodeSearchIndex.js';

const MB = (n) => Math.round((n || 0) / 1048576);

// Forced GC. The documented lever is the --expose-gc V8 flag (CLI or
// NODE_OPTIONS), which defines globalThis.gc. `ce --gui` imports server.js
// in-process, so that flag can't be added after launch. The runtime idiom
// below (setFlagsFromString + reading `gc` from a fresh vm context) is widely
// used, but Node's v8 docs call post-startup flag changes undefined behavior,
// so it is best-effort: on any failure the log says gc=unavailable and nothing
// else changes. A gc() obtained either way runs V8's collect-all-available-
// garbage path with its reduce-memory flags, which also uncommits freed pages —
// so RSS normally drops after it. What stays high after a forced GC is a live
// reference, or native memory outside V8 (a local model's context, #248).
let _forcedGc = null;   // { gc: Function|null, how: 'flag' | 'runtime' | 'unavailable' }
export function obtainForcedGc() {
  if (_forcedGc) return _forcedGc;
  if (typeof globalThis.gc === 'function') {
    _forcedGc = { gc: globalThis.gc, how: 'flag' };
    return _forcedGc;
  }
  try {
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc');
    if (typeof gc === 'function') {
      _forcedGc = { gc, how: 'runtime' };
      return _forcedGc;
    }
  } catch (_) { /* fall through to unavailable */ }
  _forcedGc = { gc: null, how: 'unavailable' };
  return _forcedGc;
}

// Plain gc() frees the objects, but V8 keeps the freed pages RESIDENT until a
// later reduce-memory GC that it schedules itself ~10 s on. Measured (Node
// v24.13.1, Windows 11, a 1 GB index-shaped heap): rss 1111 → 1107 MB at
// gc(), → 47 MB ten seconds later; two or three back-to-back gc() calls change
// nothing; the field test showed the same (heap 1632 → 27 MB, rss 1853 → 1650).
// The gc extension's "last-resort" flavor runs that collect-all-and-shrink path
// synchronously: rss 1111 → 47 MB at the call. Use it; fall back to a plain
// gc() on a V8 whose extension rejects the options form.
export function runForcedGc(gc) {
  try { gc({ type: 'major', execution: 'sync', flavor: 'last-resort' }); return 'ran:last-resort'; }
  catch (_) { /* older gc extension: no options object */ }
  try { gc(); return 'ran'; }
  catch (e) { return `failed:${String(e.message || e).replace(/\s+/g, '_')}`; }
}

/** process.memoryUsage() in whole MB — the fields that decide the question. */
export function memorySnapshot() {
  const m = process.memoryUsage();
  return {
    rssMB: MB(m.rss),
    heapUsedMB: MB(m.heapUsed),
    heapTotalMB: MB(m.heapTotal),
    externalMB: MB(m.external + (m.arrayBuffers || 0)),
  };
}

/**
 * One event per line, stable tag, named fields. Read it like this:
 *   heapUsedMB collapsing at stage=released  → the old index is gone from the
 *     process; whatever rssMB still shows is V8 keeping committed pages, which
 *     a forced GC usually returns (gc=ran) and an idle V8 returns on its own
 *     schedule (gc=unavailable).
 *   heapUsedMB staying high at stage=released → a live reference somewhere; the
 *     next thing to find.
 */
export function formatLoadIndexLog(stage, { name = null, files = 0, gc = 'unavailable' } = {}, snap = memorySnapshot()) {
  return `[load-index] stage=${stage} index=${name || '-'} files=${files || 0} ` +
    `rssMB=${snap.rssMB} heapUsedMB=${snap.heapUsedMB} heapTotalMB=${snap.heapTotalMB} ` +
    `externalMB=${snap.externalMB} gc=${gc}`;
}

export class IndexManager {
  /**
   * @param {{log?: Function, warn?: Function}} [io] — injectable for tests;
   *   defaults to the server console, where `ce --gui` users will see the
   *   [load-index] lines.
   */
  constructor({ log = console.log, warn = console.error, settleMs = 15000 } = {}) {
    /** @type {Map<string, CodeSearchIndex>} name -> index */
    this.indexes = new Map();
    /** @type {string|null} */
    this.activeIndex = null;
    this._log = log;
    this._warn = warn;
    /** Delay for the stage=settled line after a replace; null/0 disables (tests). */
    this._settleMs = settleMs;
    /** Memory summary of the last replace(), for the GUI: { beforeMB, releasedMB, loadedMB, heapBeforeMB, heapReleasedMB, gc } */
    this.lastReplace = null;
  }

  load(indexPath) {
    const idx = new CodeSearchIndex({ indexPath });
    if (idx.files.size === 0) {
      this._warn(`Warning: No files loaded from index at ${indexPath}`);
      return null;
    }
    const name = path.basename(indexPath) || indexPath;
    this.indexes.set(name, idx);
    if (!this.activeIndex) this.activeIndex = name;
    this._log(`Loaded index "${name}": ${idx.files.size} files`);
    return name;
  }

  get(name = null) {
    const key = name || this.activeIndex;
    return this.indexes.get(key) || null;
  }

  list() {
    return [...this.indexes.entries()].map(([name, idx]) => ({
      name, files: idx.files.size, active: name === this.activeIndex,
      indexSource: idx.indexSource || null, indexPath: idx.indexPath || null,
    }));
  }

  /**
   * Replace every loaded index with the one at indexPath (the GUI's Load Index
   * in replace mode). Order matters:
   *   1. log stage=before (the outgoing index, if any);
   *   2. drop this manager's references; call onRelease() so the caller drops
   *      ITS references (server.js: the MCP tool module's setIndex(null));
   *   3. force a GC when one is available; log stage=released;
   *   4. load the new index, make it active, call onActive(idx) so the caller
   *      re-points at it; log stage=loaded.
   * Returns the new name, or null when the index had no files — in which case
   * the map is left empty, exactly as the previous inline clear-then-load did.
   * A load error (unreadable index) propagates for the same reason.
   */
  /** Name and file count of the active index as primitives — see replace(). */
  _activeSummary() {
    const idx = this.get();
    return { name: this.activeIndex, files: idx ? idx.files.size : 0 };
  }

  replace(indexPath, { onActive = null, onRelease = null } = {}) {
    // The outgoing index must not be referenced from THIS frame while gc()
    // runs, or the collection cannot free it. The first version held it in a
    // local (`const prev = this.get()`) to read its file count, and the
    // field test showed exactly that: heapUsedMB unchanged at stage=released
    // with gc=ran, 1.4 GB still resident. So the summary is read as
    // primitives through a helper whose frame is gone before the clear.
    const before = this._activeSummary();
    const { gc, how } = obtainForcedGc();
    const snapBefore = memorySnapshot();
    this._log(formatLoadIndexLog('before', { name: before.name, files: before.files, gc: how }, snapBefore));

    this.indexes.clear();
    this.activeIndex = null;
    if (onRelease) {
      try { onRelease(); }
      catch (e) { this._warn(`[load-index] onRelease hook failed: ${e.message}`); }
    }
    const gcState = gc ? runForcedGc(gc) : how;
    const snapReleased = memorySnapshot();
    this._log(formatLoadIndexLog('released', { name: null, files: 0, gc: gcState }, snapReleased));

    const name = this.load(indexPath);
    if (!name) return null;
    this.activeIndex = name;
    const idx = this.indexes.get(name);
    if (onActive) {
      try { onActive(idx); }
      catch (e) { this._warn(`[load-index] onActive hook failed: ${e.message}`); }
    }
    const snapLoaded = memorySnapshot();
    this._log(formatLoadIndexLog('loaded', { name, files: idx.files.size, gc: how }, snapLoaded));
    this.lastReplace = {
      beforeMB: snapBefore.rssMB, releasedMB: snapReleased.rssMB, loadedMB: snapLoaded.rssMB,
      heapBeforeMB: snapBefore.heapUsedMB, heapReleasedMB: snapReleased.heapUsedMB, gc: gcState,
    };
    // The steady state, for the field: whatever V8 or the OS does on its own
    // schedule after the switch shows up here, in the user's normal run.
    if (this._settleMs) {
      const t = setTimeout(() => {
        const s = this._activeSummary();
        this._log(formatLoadIndexLog(`settled+${Math.round(this._settleMs / 1000)}s`, { name: s.name, files: s.files, gc: '-' }));
      }, this._settleMs);
      if (t.unref) t.unref();
    }
    return name;
  }
}
