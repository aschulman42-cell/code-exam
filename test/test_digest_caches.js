// test_digest_caches.js — digests share one breadcrumb scan per index, and commentsFor reads comments without the walks
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// grouper-performance-large-repos (2026-10-30): a `--pseudo-claims --filter`
// run on CodeExam's own index took 176 s, of which the grouper was under two.
// The purpose harvester built a full digest per group member to read its
// comments, and every digest rescanned the whole index for breadcrumbs
// (uncached) and walked the whole inverted index for callers (run even under
// maxCallers: 0). Two fixes, both output-identical: the three digest builders
// read one breadcrumb scan per index instance, and `commentsFor(target)`
// resolves a target as a digest would and returns the digest's comments with
// the callers, callees, strings table, breadcrumb filter and AI/ML signal
// skipped. These tests pin both on a two-file index.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_digest_caches_src');
const INDEX_DIR = path.join(os.tmpdir(), 'ce_test_digest_caches_idx');

describe('digest caches: one breadcrumb scan per index, comments without the walks', () => {
  let index;
  before(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(INDEX_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.writeFileSync(path.join(TEST_DIR, 'lib.js'), `// lib.js -- the module header: helpers for the test.
/**
 * Doubles a number.
 * @param {number} n
 */
export function helper(n) {
  // the body comment
  tp("helper_entry_marker_one");
  return n * 2; /* inline block */
}

export class Widget {
  // a class comment
  constructor(opts) { this.opts = opts; }
  render() { return helper(this.opts.n); }
}
`);
    fs.writeFileSync(path.join(TEST_DIR, 'main.js'), `import { helper, Widget } from './lib.js';
// main.js -- calls the helpers
export function main() {
  tp("main_entry_marker_two");
  return new Widget({ n: helper(2) }).render();
}
`);
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    await index.buildIndex(TEST_DIR, { showProgress: false });
  });
  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(INDEX_DIR, { recursive: true, force: true });
  });

  it('the breadcrumb scan runs once per index and every digest reads the same result', () => {
    assert.equal(index._breadcrumbsCache, undefined, 'nothing scanned before the first digest');
    const d1 = index.buildDigest('helper');
    assert.ok(d1 && d1.breadcrumbs, 'a function digest carries a breadcrumbs section');
    const first = index._breadcrumbsCache;
    assert.ok(first && Array.isArray(first.markers), 'the first digest filled the cache');
    index.buildDigest('lib.js');
    index.buildDigest('Widget');
    assert.equal(index._breadcrumbsCache, first, 'later digests read the same object; no rescan');
    assert.equal(index._breadcrumbsCached(), first);
    // The public method still scans afresh: its callers rewrite the object.
    assert.notEqual(index.extractBreadcrumbs(false), first);
  });

  it('commentsFor equals the full digest\'s comments for a function, a file and a class', () => {
    for (const target of ['helper', 'lib.js', 'Widget']) {
      const full = index.buildDigest(target, { maxCallers: 0, maxCallees: 0, maxStrings: 0 });
      assert.ok(full, `${target} resolves`);
      assert.ok(full.comments.length > 0, `${target} has comments to compare`);
      assert.deepEqual(index.commentsFor(target), full.comments, `${target}: same comments`);
    }
    assert.deepEqual(index.commentsFor('noSuchThing'), []);
  });

  it('a comments-only read makes no callers or callees walk and no AI/ML pass', () => {
    const full = index.buildDigest('helper', { maxCallers: 0, maxCallees: 0, maxStrings: 0 }).comments;
    const widget = index.buildDigest('Widget').comments;
    try {
      index.findCallers = () => { throw new Error('findCallers ran under commentsOnly'); };
      index.findCallees = () => { throw new Error('findCallees ran under commentsOnly'); };
      index._aimlSignalFor = () => { throw new Error('_aimlSignalFor ran under commentsOnly'); };
      assert.deepEqual(index.commentsFor('helper'), full);
      assert.deepEqual(index.commentsFor('Widget'), widget);
      const only = index.buildDigest('helper', { commentsOnly: true });
      assert.deepEqual(only.comments, full);
      assert.deepEqual(only.aiml, []);
      assert.equal(only.callers.totalSites, 0, 'the section exists, empty');
    } finally {
      delete index.findCallers;
      delete index.findCallees;
      delete index._aimlSignalFor;
    }
    // And the full digest still walks: the prototype methods are back.
    assert.ok(index.buildDigest('helper').callers.totalSites >= 1, 'main.js calls helper');
  });
});
