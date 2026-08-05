import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeLlmTerms, sanitizeBroadTerms, dropStopListedTerms, extractFirstClaim,
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

  it('reports a multi-word limitation as SET ASIDE, not degenerate', () => {
    // A three-word patent limitation is the claim, not garbage from a small
    // model. Calling it "degenerate" is what let four of them vanish unexamined
    // on US 8,752,101 claim 1. Behavior is unchanged — only the reporting.
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { lines.push(String(s)); return true; };
    const result = sanitizeLlmTerms('code rate;available reproduction time;change', 'TIGHT');
    process.stderr.write = orig;

    const log = lines.join('');
    assert.match(log, /Dropped 0 degenerate/, 'a limitation must not inflate the degenerate count');
    assert.match(log, /set aside 1 multi-word/);
    assert.match(log, /set aside: available reproduction time/,
      'the term itself must be named — a bare count is what hid this');
    assert.equal(result, 'code rate;change', 'which terms survive is unchanged');
  });

  it('still counts genuine gibberish as degenerate, separately', () => {
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s) => { lines.push(String(s)); return true; };
    sanitizeLlmTerms(`alpha;${'x'.repeat(40)};three word phrase;beta`, 'BROAD');
    process.stderr.write = orig;

    const log = lines.join('');
    assert.match(log, /Dropped 1 degenerate/, 'over-long junk stays degenerate');
    assert.match(log, /set aside 1 multi-word/, 'and is not conflated with the limitation');
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
  it('drops short alternations below the 4-char floor', () => {
    hushStderr();
    const input = '/query|q/;server;/key|k/';
    const result = sanitizeBroadTerms(input);
    restoreStderr();
    // q & k are sub-4-char and not whitelisted; key (3 chars) is too -> /key|k/
    // loses all alternations and is dropped entirely.
    assert.equal(result, 'query;server');
  });

  it('drops 3-char alternations that are not whitelisted acronyms', () => {
    const input = '/sequence|seq/;/value|val/';
    const result = sanitizeBroadTerms(input);
    // seq & val are 3 chars, not on the acronym whitelist -> dropped.
    assert.equal(result, 'sequence;value');
  });

  it('keeps whitelisted short acronyms below the 4-char floor', () => {
    hushStderr();
    const input = '/secure|tls|ssl/;/subject|san|cn/';
    const result = sanitizeBroadTerms(input);
    restoreStderr();
    // tls, ssl, san, cn are all whitelisted acronyms -> survive intact.
    assert.equal(result, '/secure|tls|ssl/;/subject|san|cn/');
  });

  it('drops term if ALL alternations are too short', () => {
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

  it('handles mixed: some long, some too short', () => {
    hushStderr();
    const input = '/value|v|val/;/ok|x/';
    const result = sanitizeBroadTerms(input);
    restoreStderr();
    // value survives; v, val, ok, x all dropped -> /ok|x/ vanishes.
    assert.equal(result, 'value');
  });
});


describe('dropStopListedTerms', () => {
  it('drops bare stop-listed terms', () => {
    hushStderr();
    const result = dropStopListedTerms('facade;session;handshake', 'BROAD');
    restoreStderr();
    assert.equal(result, 'facade;handshake');
  });

  it('trims stop-listed alternates from a regex term', () => {
    hushStderr();
    const result = dropStopListedTerms('/key|secret|keystore/', 'BROAD');
    restoreStderr();
    assert.equal(result, '/secret|keystore/');
  });

  it('drops a regex term when ALL alternates are stop-listed', () => {
    hushStderr();
    const result = dropStopListedTerms('handshake;/common|name/', 'BROAD');
    restoreStderr();
    assert.equal(result, 'handshake');
  });

  it('collapses a single surviving alternate to a bare term', () => {
    hushStderr();
    const result = dropStopListedTerms('/secret|key/', 'BROAD');
    restoreStderr();
    assert.equal(result, 'secret');
  });

  it('dedupes a bare term already covered by a surviving regex term', () => {
    hushStderr();
    const result = dropStopListedTerms('/cryptograph|crypto|cipher/;cipher', 'BROAD');
    restoreStderr();
    assert.equal(result, '/cryptograph|crypto|cipher/');
  });

  it('dedupes a repeated PLAIN term, keeping first occurrence and order', () => {
    // The live failure: `commands` appeared three times in the BROAD list for
    // the '101 claim while the sanitizer reported `deduped 0`. The pass above
    // only compares bare terms against surviving REGEX alternates, so two
    // identical plain terms were never compared to each other. The duplicate
    // triple-counted toward min_terms and the IDF score, and every top-ranked
    // class hit was carried by exactly those three term slots.
    hushStderr();
    const result = dropStopListedTerms('commands;player;commands;render;commands', 'BROAD');
    restoreStderr();
    assert.equal(result, 'commands;player;render');
  });

  it('dedupes plain terms case-insensitively', () => {
    hushStderr();
    const result = dropStopListedTerms('Commands;commands;COMMANDS', 'BROAD');
    restoreStderr();
    assert.equal(result, 'Commands', 'first spelling wins');
  });

  it('does NOT merge a NOT term with its plain twin', () => {
    // `foo` and `NOT foo` together are a contradiction worth surfacing to the
    // caller, not silently collapsing into one.
    hushStderr();
    const result = dropStopListedTerms('foo;NOT foo', 'BROAD');
    restoreStderr();
    assert.equal(result, 'foo;NOT foo');
  });

  it('passes NOT terms through untouched', () => {
    hushStderr();
    const result = dropStopListedTerms('facade;NOT session;NOT /client|server/', 'TIGHT');
    restoreStderr();
    assert.equal(result, 'facade;NOT session;NOT /client|server/');
  });

  it('returns empty input unchanged', () => {
    assert.equal(dropStopListedTerms('', 'BROAD'), '');
    assert.equal(dropStopListedTerms(null, 'BROAD'), null);
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

  it('sanitize chain drops degenerate and short terms', () => {
    hushStderr();
    // Simulate LLM output with degenerate terms
    let broad = '/facade|proxy|f/;server;/key|k|val|v/;NOT /tcp|t/';
    broad = sanitizeLlmTerms(broad, 'BROAD');
    broad = sanitizeBroadTerms(broad);
    restoreStderr();
    // /facade|proxy|f/ -> /facade|proxy/ (f too short); /key|k|val|v/ dropped
    // entirely (key & val are 3-char, not whitelisted); NOT /tcp|t/ -> NOT tcp
    // (tcp survives as a whitelisted acronym, t dropped).
    assert.equal(broad, '/facade|proxy/;server;NOT tcp');
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
