// test_binary_sniff.js — TreeSitterParser guards: binary/MPEG-TS sniff keeps grammars off non-source (#299)
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// test_binary_sniff.js — #299/#88: binary content must never reach a language
// grammar (the ExoPlayer MPEG-TS-as-TypeScript 2-hour build). Deterministic
// units for the sniff + signature helpers, plus a live integration check that
// parseFunctions refuses binary and still parses real code.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TreeSitterParser, looksBinaryContent, looksMpegTs,
  TS_PARSE_MAX_CHARS, TS_PARSE_TIMEOUT_MICROS, TS_SLOW_FILE_MS,
} from '../src/core/TreeSitterParser.js';

const NUL = String.fromCharCode(0);
const FFFD = String.fromCharCode(0xfffd);

describe('binary content sniff', () => {
  it('flags NUL and replacement-char content immediately', () => {
    assert.equal(looksBinaryContent([`GET ${NUL}${NUL} stuff`]), true);
    assert.equal(looksBinaryContent([`decoded garbage ${FFFD}${FFFD}`]), true);
  });
  it('flags high control-char density, passes real code', () => {
    const ctl = String.fromCharCode(1, 2, 3, 4, 5, 6, 7, 8).repeat(64);
    assert.equal(looksBinaryContent([ctl]), true);
    assert.equal(looksBinaryContent(['function f(x) {', '  return x + 1; // tab\tok', '}']), false);
    assert.equal(looksBinaryContent([]), false);
  });
  it('tolerates unicode source (comments, strings)', () => {
    assert.equal(looksBinaryContent(['const s = "héllo wörld — em—dash";', 'console.log(s);']), false);
  });
});

describe('MPEG-TS signature', () => {
  const G = 'G';
  const pkt = (fill) => G + fill.repeat(187);
  it('detects the 0x47 sync pattern at 0/188/376', () => {
    const line = pkt('a') + pkt('b') + pkt('c');
    assert.equal(looksMpegTs([line]), true);
  });
  it('does not flag TypeScript that merely starts with G', () => {
    assert.equal(looksMpegTs(['Generic comment line about types'.padEnd(400, ' ')]), false);
    assert.equal(looksMpegTs(['const g = 1;']), false); // too short
  });
});

describe('guard constants', () => {
  it('are exported at the documented values', () => {
    assert.equal(TS_PARSE_MAX_CHARS, 2_000_000);
    assert.equal(TS_PARSE_TIMEOUT_MICROS, 5_000_000);
    assert.equal(TS_SLOW_FILE_MS, 2000);
  });
});

describe('parseFunctions refuses binary, still parses code (live wasm)', () => {
  it('returns null for MPEG-TS-shaped .ts and functions for real .js', async () => {
    const ts = new TreeSitterParser();
    const ok = await ts.init();
    if (!ok) return; // environment without wasm — units above still cover the sniff
    const binary = ['G' + `${NUL}xx`.repeat(200)];
    assert.equal(await ts.parseFunctions('fixture/bbb_2500ms.ts', binary), null);
    const real = await ts.parseFunctions('fixture/a.js', ['function alpha() { return 1; }', 'const beta = () => 2;']);
    assert.ok(real && ('alpha' in real), 'real JS still parses');
  });
});
