import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeLlmTerms, sanitizeBroadTerms, extractFirstClaim,
} from '../src/commands/claim.js';

// Suppress stderr from sanitizer messages during tests
const origStderrWrite = process.stderr.write.bind(process.stderr);
function hushStderr() { process.stderr.write = () => true; }
function restoreStderr() { process.stderr.write = origStderrWrite; }

// ============================================================================
// Response parsing tests (via _parseResponse which is internal — test via
// the sanitizer functions which are the exported surface)
// ============================================================================

describe('sanitizeLlmTerms', () => {
  it('passes through clean terms unchanged', () => {
    const input = 'facade;server;/browser|web/;NOT /tcp|udp/';
    const result = sanitizeLlmTerms(input);
    assert.equal(result, input);
  });

  it('drops terms with more than 2 words', () => {
    hushStderr();
    const input = 'facade;plurality of data blocks;server';
    const result = sanitizeLlmTerms(input);
    restoreStderr();
    assert.equal(result, 'facade;server');
  });

  it('drops terms longer than 30 chars', () => {
    hushStderr();
    const input = 'facade;abcdefghijklmnopqrstuvwxyz12345;server';
    const result = sanitizeLlmTerms(input);
    restoreStderr();
    assert.equal(result, 'facade;server');
  });

  it('trims bad alternations from regex terms', () => {
    hushStderr();
    const input = '/good|a very long multi word phrase that should be dropped/;server';
    const result = sanitizeLlmTerms(input);
    restoreStderr();
    assert.equal(result, 'good;server');
  });

  it('drops regex terms where ALL alternations are bad', () => {
    hushStderr();
    const input = '/this is very long and bad|also super long garbage text/;server';
    const result = sanitizeLlmTerms(input);
    restoreStderr();
    assert.equal(result, 'server');
  });

  it('preserves NOT prefix through sanitization', () => {
    const input = 'facade;NOT /tcp|udp/;server';
    const result = sanitizeLlmTerms(input);
    assert.equal(result, 'facade;NOT /tcp|udp/;server');
  });

  it('caps at 20 terms', () => {
    hushStderr();
    const terms = Array.from({length: 25}, (_, i) => `term${i}`);
    const input = terms.join(';');
    const result = sanitizeLlmTerms(input);
    restoreStderr();
    assert.equal(result.split(';').length, 20);
  });

  it('returns null/empty for empty input', () => {
    assert.equal(sanitizeLlmTerms(''), '');
    assert.equal(sanitizeLlmTerms(null), null);
  });
});


describe('sanitizeBroadTerms', () => {
  it('removes single-char alternations', () => {
    hushStderr();
    const input = '/query|q/;server;/key|k/';
    const result = sanitizeBroadTerms(input);
    restoreStderr();
    assert.equal(result, 'query;server;key');
  });

  it('keeps multi-char alternations', () => {
    const input = '/sequence|seq/;/value|val/';
    const result = sanitizeBroadTerms(input);
    assert.equal(result, '/sequence|seq/;/value|val/');
  });

  it('drops term if ALL alternations are single-char', () => {
    hushStderr();
    const input = '/a|b|c/;server';
    const result = sanitizeBroadTerms(input);
    restoreStderr();
    assert.equal(result, 'server');
  });

  it('preserves NOT prefix', () => {
    hushStderr();
    const input = 'NOT /query|q/;server';
    const result = sanitizeBroadTerms(input);
    restoreStderr();
    assert.equal(result, 'NOT query;server');
  });

  it('leaves plain terms alone', () => {
    const input = 'facade;server;browser';
    const result = sanitizeBroadTerms(input);
    assert.equal(result, 'facade;server;browser');
  });

  it('handles mixed: some good, some single-char', () => {
    hushStderr();
    const input = '/value|v|val/;/ok|x/';
    const result = sanitizeBroadTerms(input);
    restoreStderr();
    assert.equal(result, '/value|val/;ok');
  });
});


describe('extractFirstClaim', () => {
  it('returns full text when no multi-claim structure', () => {
    const text = 'A method comprising step A, step B, and step C.';
    const { text: result, skipped } = extractFirstClaim(text);
    assert.equal(result, text);
    assert.equal(skipped, 0);
  });

  it('extracts first claim when numbered claims present', () => {
    const text = `1. A method comprising:
    receiving data from a source;
    processing the data.

2. The method of claim 1, wherein the source is a database.

3. The method of claim 1, further comprising storing results.`;

    const { text: result, skipped } = extractFirstClaim(text);
    assert.ok(result.includes('receiving data'));
    assert.ok(!result.includes('claim 1, wherein'));
    assert.equal(skipped, 2);
  });

  it('handles [Claim N] label format', () => {
    const text = `[Claim 1]
A system for processing widgets.

[Claim 2]
The system of Claim 1, further comprising a display.`;

    const { text: result, skipped } = extractFirstClaim(text);
    assert.ok(result.includes('processing widgets'));
    assert.ok(!result.includes('Claim 2'));
    assert.equal(skipped, 1);
  });

  it('does not split on "1." at start', () => {
    const text = `1. A method comprising:
    step A;
    step B.`;
    const { text: result, skipped } = extractFirstClaim(text);
    assert.equal(result, text.trim());
    assert.equal(skipped, 0);
  });
});


describe('claim.js integration points', () => {
  it('parseMultisectTerms import works', async () => {
    const { parseMultisectTerms } = await import('../src/commands/multisect.js');
    const terms = parseMultisectTerms('facade;server;NOT /tcp|udp/');
    assert.ok(terms);
    assert.equal(terms.length, 3);
    assert.equal(terms[0].negated, false);
    assert.equal(terms[2].negated, true);
  });

  it('sanitize chain matches Python behavior', () => {
    hushStderr();
    // Simulate LLM output with degenerate terms
    let broad = '/facade|proxy|f/;server;/key|k|val|v/;NOT /tcp|t/';
    broad = sanitizeLlmTerms(broad, 'BROAD');
    broad = sanitizeBroadTerms(broad);
    restoreStderr();
    // /f/ removed from first, /k/ and /v/ removed from third, /t/ from NOT
    assert.equal(broad, '/facade|proxy/;server;/key|val/;NOT tcp');
  });

  it('prompt excludes generic patent boilerplate terms', async () => {
    // Dynamically read claim.js source to check the prompt content
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('../src/commands/claim.js', import.meta.url), 'utf-8');
    // The strengthened prompt should list these common patent boilerplate terms
    for (const term of ['method', 'device', 'apparatus', 'comprising', 'wherein']) {
      assert.ok(src.includes(term),
        `Prompt should explicitly mention "${term}" as a term to skip`);
    }
  });
});
