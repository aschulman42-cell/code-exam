// test_show_prompt.js — --show-prompt works on every LLM command (show-prompt-all-llm-commands)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_show_prompt.js — `--show-prompt` must work on EVERY command that talks to
 * an LLM: print the prompt(s) that would be sent and exit with no API call, even
 * when no --llm/--model is given. Commands: --pseudo-claims, --synonymize,
 * --claim-chart, --claim-locate, --claims-loop (analyze and claim-search already
 * had it).
 *
 * The harness has no API key, so if a command failed to short-circuit on
 * --show-prompt it would either error ("needs a model") or try to call out; the
 * `--llm claude` case proves it exits BEFORE touching the provider.
 *
 * Run: node --test test/test_show_prompt.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_show_prompt');
const CLI = path.resolve('src/index.js');
const SRC_DIR = path.join(TEST_DIR, 'src');
const IDX_DIR = path.join(TEST_DIR, '.idx');
const CLAIM = path.join(TEST_DIR, 'claim.txt');
const CHART = path.join(TEST_DIR, 'chart.md');
const CAND = path.join(TEST_DIR, 'cand.lst');

function runCLI(args) {
  try {
    return execSync(`node ${CLI} ${args}`, { encoding: 'utf-8', timeout: 60000, cwd: TEST_DIR });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}

const FOOTER = /--show-prompt: prompt displayed above, no LLM call made/;

before(() => {
  fs.mkdirSync(SRC_DIR, { recursive: true });
  fs.writeFileSync(path.join(SRC_DIR, 'app.js'),
    'function validateChain(cert) {\n  const ok = verifyTrust(cert);\n  return ok && notExpired(cert);\n}\n\n' +
    'function verifyTrust(cert) { return cert.issuer === "root"; }\n\n' +
    'function notExpired(cert) { return cert.exp > Date.now(); }\n');
  runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  fs.writeFileSync(CLAIM,
    'A method for verifying a certificate chain, comprising: retrieving a certificate; and validating its chain of trust.\n');
  fs.writeFileSync(CHART, '# Pseudo-claim 1 — chain check\nA method comprising: foo; and bar.\n');
  fs.writeFileSync(CAND, '# [file] app.js  (3 fns)\napp.js@validateChain\n');
});

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('--show-prompt on every LLM command (no model → prints prompt, no call)', () => {
  it('--pseudo-claims', () => {
    const out = runCLI(`--pseudo-claims "app.js@validateChain" --show-prompt --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /SYSTEM PROMPT/, out);
    assert.match(out, FOOTER, out);
  });

  it('--synonymize', () => {
    const out = runCLI(`--synonymize @${CLAIM} --show-prompt --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /SYSTEM PROMPT/, out);
    assert.match(out, FOOTER, out);
  });

  it('--claim-chart', () => {
    const out = runCLI(`--claim-chart @${CLAIM} --show-prompt --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, FOOTER, out);
    assert.doesNotMatch(out, /needs a model/, out);
  });

  it('--claim-locate', () => {
    const out = runCLI(`--claim-locate @${CLAIM} --show-prompt --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, /system prompt/i, out);
    assert.match(out, FOOTER, out);
  });

  it('--claims-loop', () => {
    const out = runCLI(`--claims-loop ${CHART} --candidates ${CAND} --show-prompt --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, FOOTER, out);
    assert.doesNotMatch(out, /needs a model/, out);
  });
});

describe('--show-prompt short-circuits BEFORE the provider (no API call)', () => {
  it('--pseudo-claims --llm claude --show-prompt prints the prompt and does not call out', () => {
    const out = runCLI(`--pseudo-claims "app.js@validateChain" --llm claude --show-prompt --index-path ${IDX_DIR} 2>&1`);
    assert.match(out, FOOTER, out);
    // Would-be signs of actually trying to draft:
    assert.doesNotMatch(out, /Drafting \d+ pseudo-claim/, out);
    assert.doesNotMatch(out, /No API key|api key|ANTHROPIC_API_KEY env/i, out);
  });
});
