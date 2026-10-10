// test_pseudo_claims_candidate_filter.js — --pseudo-claims honors --filter over candidate groups
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_pseudo_claims_candidate_filter.js — candidate-group filtering.
 *
 * `--filter` selects candidate groups by header text (label + purpose), the
 * same substring / `/regex/` contract as every other CLI listing:
 *   - `--candidates out.lst --filter T` writes only matching groups (⊆ the
 *     unfiltered set, every kept group's header containing T);
 *   - `--filter T` with no `--candidates` and no model prints the filtered
 *     candidates to stdout (no interim file);
 *   - a filter that matches nothing errors cleanly ("matched 0 of N").
 *
 * Drafting (forms needing a live model) is not exercised offline. The synthetic
 * index is too thin for the grouper's doc-header / vocabulary seeds, so the
 * tests pass --file-seed to force one candidate group per file; the --filter
 * code path under test is identical however the groups were seeded.
 *
 * Run: node --test test/test_pseudo_claims_candidate_filter.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_pc_filter');
const CLI = path.resolve('src/index.js');
const SRC_DIR = path.join(TEST_DIR, 'src');
const IDX_DIR = path.join(TEST_DIR, '.idx');

function runCLI(args) {
  try {
    return execSync(`node ${CLI} ${args}`, { encoding: 'utf-8', timeout: 60000, cwd: TEST_DIR });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

// Count candidate groups in a candidates .lst by its "# <label>  (N fns)"
// headers. A group header has TWO spaces before "(N fns)" (formatAnchors emits
// `# <label>  (<n> fns)`); the grouper's provenance lines ("… 0 noise files
// (0 fns)") have a single space, so the two-space guard excludes them.
function groupHeaders(text) {
  return text.split(/\r?\n/).filter((l) => /^#\s+\S.* {2}\(\d+\s+fns?\)/.test(l));
}

before(() => {
  fs.mkdirSync(SRC_DIR, { recursive: true });
  // Two topically distinct files, each with a leading doc comment so the
  // grouper's default doc-header seed yields one candidate group per file, with
  // headers carrying distinguishable tokens ("auth" vs "payment").
  let auth = '/**\n * auth_service.js — authentication and login token handling.\n */\n';
  for (let i = 0; i < 8; i++) {
    auth += `function authLogin${i}(user) {\n  const token = authenticate(user);\n  return token;\n}\n\n`;
  }
  auth += 'function authenticate(user) {\n  return "auth-" + user;\n}\n\n';
  fs.writeFileSync(path.join(SRC_DIR, 'auth_service.js'), auth);

  let pay = '/**\n * payment_service.js — payment charge and settlement.\n */\n';
  for (let i = 0; i < 8; i++) {
    pay += `function paymentCharge${i}(amount) {\n  const receipt = settle(amount);\n  return receipt;\n}\n\n`;
  }
  pay += 'function settle(amount) {\n  return "paid-" + amount;\n}\n\n';
  fs.writeFileSync(path.join(SRC_DIR, 'payment_service.js'), pay);

  runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
});

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('--pseudo-claims --candidates --filter', () => {
  const ALL = path.join(TEST_DIR, 'all.lst');
  const FILT = path.join(TEST_DIR, 'filt.lst');

  it('writes a filtered candidates file that is a subset matching the token', () => {
    runCLI(`--pseudo-claims --candidates ${ALL} --file-seed --index-path ${IDX_DIR} 2>&1`);
    runCLI(`--pseudo-claims --candidates ${FILT} --file-seed --filter auth --index-path ${IDX_DIR} 2>&1`);
    assert.ok(fs.existsSync(ALL), 'unfiltered candidates file should exist');
    assert.ok(fs.existsSync(FILT), 'filtered candidates file should exist');

    const allGroups = groupHeaders(fs.readFileSync(ALL, 'utf8'));
    const filtGroups = groupHeaders(fs.readFileSync(FILT, 'utf8'));
    assert.ok(allGroups.length >= 2, 'expected >= 2 unfiltered groups, got ' + allGroups.length);
    assert.ok(filtGroups.length >= 1, 'filter should keep at least one group');
    assert.ok(filtGroups.length < allGroups.length, 'filter should drop some groups');
    for (const h of filtGroups) {
      assert.match(h.toLowerCase(), /auth/, 'every kept group header should contain the token: ' + h);
    }
  });

  it('a filter that matches nothing errors cleanly', () => {
    const out = runCLI(`--pseudo-claims --candidates ${path.join(TEST_DIR, 'none.lst')} --file-seed --filter zzzznope --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /matched 0 of \d+/i, 'should report 0 matches: ' + out);
  });
});

describe('--pseudo-claims --filter with no file and no model', () => {
  it('prints the filtered candidates to stdout (no interim file)', () => {
    const out = runCLI(`--pseudo-claims --filter payment --file-seed --index-path ${IDX_DIR} 2>&1`);
    const headers = groupHeaders(out);
    assert.ok(headers.length >= 1, 'should print at least one candidate group header: ' + out);
    for (const h of headers) {
      assert.match(h.toLowerCase(), /payment/, 'printed groups should match the filter: ' + h);
    }
    // No model ran: must say these are candidates, not claims, and how to draft.
    assert.match(out, /not claims/i, 'should warn these are candidates, not claims: ' + out);
    assert.match(out, /--llm|--model/, 'should say how to draft claims: ' + out);
  });

  it('a non-matching filter errors cleanly in the no-file path too', () => {
    const out = runCLI(`--pseudo-claims --filter zzzznope --file-seed --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /matched 0 of \d+/i, 'should report 0 matches: ' + out);
  });
});
