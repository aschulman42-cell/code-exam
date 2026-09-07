// build-worker.js — worker thread that runs CodeSearchIndex.buildIndex off the main loop, streaming progress to the parent
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * Worker thread for building indexes without blocking the main event loop.
 * Receives { sourcePath, indexPath, useTreeSitter } via workerData.
 * Posts progress messages and final result back to parent.
 */
import { parentPort, workerData } from 'worker_threads';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';

const { sourcePath, indexPath, useTreeSitter, extensions, excludeExtensions } = workerData;

// Intercept console.log and stdout.write to capture progress
const origLog = console.log;
const origWrite = process.stdout.write;

console.log = (...args) => {
  const msg = args.map(a => typeof a === 'string' ? a : String(a)).join(' ');
  if (msg) parentPort.postMessage({ type: 'progress', message: msg });
};

const boundOrigWrite = origWrite.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : chunk.toString();
  const trimMsg = s.replace(/\r?\n$/, '').trim();
  if (trimMsg) parentPort.postMessage({ type: 'progress', message: trimMsg });
  return boundOrigWrite(chunk, ...rest);
};

(async () => {
  try {
    // Parse extension include/exclude lists
    let customExtensions = null;
    if (extensions) {
      customExtensions = new Set(
        extensions.split(',').map(e => { e = e.trim(); return e.startsWith('.') ? e : '.' + e; })
      );
    }
    let excludeCompound = null;
    if (excludeExtensions) {
      if (!customExtensions) {
        customExtensions = new Set(CodeSearchIndex.DEFAULT_EXTENSIONS);
      }
      for (let ext of excludeExtensions.split(',')) {
        ext = ext.trim().toLowerCase();
        if (!ext.startsWith('.')) ext = '.' + ext;
        customExtensions.delete(ext);
        if ((ext.match(/\./g) || []).length > 1) {
          if (!excludeCompound) excludeCompound = new Set();
          excludeCompound.add(ext);
        }
      }
    }

    const idx = new CodeSearchIndex({ indexPath, extensions: customExtensions, excludeCompound });
    const stats = await idx.buildIndex(sourcePath, {
      showProgress: true,
      skipSemantic: true,
      useTreeSitter: useTreeSitter || false,
    });
    console.log = origLog;
    process.stdout.write = origWrite;
    parentPort.postMessage({ type: 'done', stats });
  } catch (err) {
    console.log = origLog;
    process.stdout.write = origWrite;
    parentPort.postMessage({ type: 'error', error: err.message });
  }
})();
