// test_class_digest.js — #198 class digest targets the class not its constructor; listClasses start line
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_class_digest.js — #198: class digest must target the class, not a
 * same-named constructor/function, when the caller passes kind:'class'.
 * Also covers that listClasses exposes the class definition `start` line
 * (the field /api/list-classes forwards so the GUI can jump to the class
 * definition rather than its constructor — Part B).
 *
 * Run: node --test test/test_class_digest.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_class_digest_src');
const INDEX_DIR = path.join(os.tmpdir(), 'ce_test_class_digest_idx');

describe('#198 class digest (kind:class) and class start line', () => {
  let index;

  before(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // widget.js: a real class with methods.
    fs.writeFileSync(path.join(TEST_DIR, 'widget.js'), `export class Widget {
  constructor(opts) {
    this.opts = opts;
  }
  render() {
    return '<div>' + this.opts.label + '</div>';
  }
  destroy() {
    this.opts = null;
  }
}
`);
    // factory.js: a top-level FUNCTION with the SAME bare name as the class,
    // in a different file. This is the collision the kind:'class' hint must
    // survive — findFunctionMatches may surface this function first.
    fs.writeFileSync(path.join(TEST_DIR, 'factory.js'), `export function Widget() {
  return { label: 'default' };
}
`);
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    await index.buildIndex(TEST_DIR, { showProgress: false });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(INDEX_DIR, { recursive: true, force: true });
  });

  it('listClasses exposes the Widget class with a definition start line', () => {
    const classes = index.listClasses();
    const widget = classes.find(c => {
      const bare = c.name.includes('::') ? c.name.split('::').pop() : c.name;
      return bare === 'Widget';
    });
    assert.ok(widget, 'Widget class should be listed');
    assert.ok(Number.isInteger(widget.start) && widget.start > 0,
      `class should carry a positive start line, got ${widget.start}`);
  });

  // Use the filepath exactly as listClasses / the /api/list-classes route
  // reports it (relative, normalized) — that's the form the GUI builds the
  // `filepath@name` digest spec from.
  function classFilepath(name) {
    return index.listClasses().find(c => {
      const bare = c.name.includes('::') ? c.name.split('::').pop() : c.name;
      return bare === name;
    })?.filepath;
  }

  it('buildDigest with kind:class yields a class digest', () => {
    const digest = index.buildDigest(`${classFilepath('Widget')}@Widget`, { kind: 'class' });
    assert.ok(digest, 'digest should resolve');
    assert.equal(digest.target_type, 'class',
      `kind:class must produce a class digest, got ${digest.target_type}`);
  });

  it('buildDigest with kind:class resolves the class even from the bare name (collision)', () => {
    // A same-named top-level function lives in factory.js; without the hint
    // findFunctionMatches could surface it first. kind:class must win.
    const digest = index.buildDigest('Widget', { kind: 'class' });
    assert.ok(digest, 'digest should resolve');
    assert.equal(digest.target_type, 'class',
      `the same-named function must not preempt the class digest, got ${digest.target_type}`);
  });

  it('kind:class falls through gracefully when the name is not a class', () => {
    // render() is a method, not a class — the short-circuit returns null and
    // normal resolution takes over, so the result matches the no-hint call.
    const spec = `${classFilepath('Widget')}@render`;
    const withHint = index.buildDigest(spec, { kind: 'class' });
    const without = index.buildDigest(spec, {});
    assert.deepEqual(
      withHint ? withHint.target_type : null,
      without ? without.target_type : null,
      'kind:class on a non-class name must not change the resolved target',
    );
  });
});
