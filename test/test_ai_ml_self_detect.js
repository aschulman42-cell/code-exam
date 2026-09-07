// test_ai_ml_self_detect.js — AI/ML detectors: a pattern-table line is not a framework instance (#227)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_ai_ml_self_detect.js — #227.
 *
 * AI/ML marker detectors must not report a *pattern definition* (a regex
 * literal or its co-located label, as found in a detector / linter / scanner /
 * test fixture) as a real *instance* of the framework it names. A regex that
 * matches CLIP is not an instance of CLIP.
 *
 * The fix blanks lines carrying a `\b`-flanked regex literal before the marker
 * scan (CodeSearchIndex._AIMLMethods._scanLines). These tests pin both halves:
 * the false positive is suppressed, and real usage on an ordinary line is still
 * detected (guarding against a false negative).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';

// Build an index over synthetic in-memory files (mirrors test_explainability.js).
function indexOf(files) {
  const idx = new CodeSearchIndex({ indexPath: '.__test_self_detect_noindex__' });
  idx.fileLines = new Map(Object.entries(files).map(([p, src]) => [p, src.split('\n')]));
  return idx;
}
const mentions = (rows, word) => rows.filter(r => new RegExp(`\\b${word}\\b`).test(JSON.stringify(r)));

describe('#227 — chains/agents detector does not self-detect its pattern table', () => {
  it('a marker-table definition line is NOT a chain site', () => {
    // Byte-for-byte the shape of ai-ml-detectors.js's own table.
    const rows = indexOf({
      'detectors.js': "      { re: /\\bLLMChain\\b/, kind: 'chain', fw: 'LangChain', m: 'LLMChain' },",
    }).listChains();
    assert.equal(mentions(rows, 'LLMChain').length, 0,
      'pattern-definition line must not be a chain site: ' + JSON.stringify(rows));
  });

  it('real LLMChain usage on an ordinary line is STILL detected (no false negative)', () => {
    const rows = indexOf({
      'app.py': 'from langchain.chains import LLMChain\nchain = LLMChain(llm=llm, prompt=p)',
    }).listChains();
    assert.ok(mentions(rows, 'LLMChain').length > 0,
      'real LLMChain usage must still be detected: ' + JSON.stringify(rows));
  });
});

describe('#227 — inference detector does not self-detect its pattern table', () => {
  it('a marker-table definition line is NOT an inference site', () => {
    const rows = indexOf({
      'detectors.js': "      { re: /\\bmax_new_tokens\\b/, fam: 'HF', m: 'max_new_tokens' },",
    }).listInference();
    assert.equal(mentions(rows, 'max_new_tokens').length, 0,
      'pattern-definition line must not be an inference site: ' + JSON.stringify(rows));
  });

  it('real generation usage on an ordinary line is STILL detected', () => {
    // listInference gates on the file actually importing an ML library (so a
    // bare mention isn't counted). The #227 fix also stops ai-ml-detectors.js
    // from faking that gate via its own `import torch`-shaped regex patterns.
    const rows = indexOf({
      'gen.py': 'import torch\nfrom transformers import AutoModelForCausalLM\nout = model.generate(ids, max_new_tokens=50, do_sample=True)',
    }).listInference();
    assert.ok(mentions(rows, 'max_new_tokens').length > 0,
      'real generation usage must still be detected: ' + JSON.stringify(rows));
  });
});
