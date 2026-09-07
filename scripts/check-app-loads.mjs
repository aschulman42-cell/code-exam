#!/usr/bin/env node
// check-app-loads.mjs — smoke test that evaluates app.js's module graph under DOM stubs
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Smoke test: verifies that public/app.js and its ES-module dependency graph
// evaluate cleanly without runtime errors. Catches syntax errors, missing
// exports, top-level reference errors, and circular-import deadlocks that
// wedge module init.
//
// Does NOT catch: runtime errors inside event handlers, DOM-shape mismatches,
// or visual regressions. Run a browser sanity check for those.
//
// Usage: node scripts/check-app-loads.mjs
// Exit:  0 on success ("app.js loads OK"), 1 on any load error.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const APP_PATH = resolve(__dirname, '..', 'public', 'app.js');

// Minimal stubs for the globals app.js touches at module-evaluation time.
// Anything reachable only from event-handler bodies does NOT need a stub here;
// those code paths are never executed during a load test. If a future peel
// causes a new bare-identifier reference to surface at top-level, extend this
// surface accordingly.
const noop = () => {};
const stubElement = () => ({
  style: {},
  classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  addEventListener: noop,
  removeEventListener: noop,
  appendChild: noop,
  removeChild: noop,
  setAttribute: noop,
  getAttribute: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  insertAdjacentHTML: noop,
  remove: noop,
  innerHTML: '',
  textContent: '',
  value: '',
  dataset: {},
  children: [],
});

globalThis.document = {
  addEventListener: noop,
  removeEventListener: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: stubElement,
  createTextNode: () => ({ textContent: '' }),
  body: stubElement(),
  documentElement: stubElement(),
};

globalThis.window = {
  addEventListener: noop,
  removeEventListener: noop,
  location: { href: 'about:blank', search: '', hash: '' },
  history: { pushState: noop, replaceState: noop, back: noop, forward: noop },
  localStorage: {
    getItem: () => null,
    setItem: noop,
    removeItem: noop,
    clear: noop,
  },
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
};

globalThis.localStorage = globalThis.window.localStorage;
globalThis.fetch = () => Promise.reject(new Error('fetch stubbed in load test'));
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = clearTimeout;

const appUrl = pathToFileURL(APP_PATH).href;

import(appUrl)
  .then(() => {
    console.log('app.js loads OK');
    process.exit(0);
  })
  .catch((err) => {
    console.log('LOAD ERROR:', err.message);
    if (err.stack) {
      const trimmed = err.stack
        .split('\n')
        .filter((line) => !line.includes('node:internal'))
        .slice(0, 8)
        .join('\n');
      console.log(trimmed);
    }
    process.exit(1);
  });
