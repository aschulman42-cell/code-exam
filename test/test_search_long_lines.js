// test_search_long_lines.js — a search hit on a very long line is shown as a window around the match, not as the whole line
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// search-huge-line-from-minified-bundle (2026-11-19). `ce --ndx .bram-src-ndx --search rust`
// printed nine lines of one vendored, minified bundle whole: 9,837 to 327,144 characters
// each, about 930,000 in a 42-line result, with the match up to 285,944 characters in.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { windowLine, printResults, LONG_LINE, queryFinder } from '../src/commands/search.js';

const capture = (fn) => { const out = []; const log = console.log; console.log = (...a) => out.push(a.join(' ')); try { fn(); } finally { console.log = log; } return out; };
const filler = (n) => 'function a(e,t){return e+t};'.repeat(Math.ceil(n / 28)).slice(0, n);

describe('a search hit on a very long line', () => {
  const long = `${filler(50000)}if(e.isTrusted){go()}${filler(40000)}var untrusted=1;${filler(1000)}`;

  it('a line of ordinary length is printed as it is', () => {
    assert.equal(windowLine('  let trust = 1;  ', queryFinder('rust')), 'let trust = 1;');
    assert.equal(windowLine('x'.repeat(LONG_LINE), queryFinder('rust')), 'x'.repeat(LONG_LINE));
  });

  it('a long line is cut to a window that holds the first match, and says how long the line is', () => {
    const w = windowLine(long, queryFinder('rust'));
    assert.ok(w.length < 500, `shown ${w.length} characters`);
    assert.match(w, /isTrusted/);
    assert.match(w, /^…/);
    assert.match(w, /\[line of 91,0\d\d chars; 2 matches, the first shown; --full-lines shows it whole\]$/);
  });

  it('a match at the very start has no leading cut mark; one match is not counted aloud', () => {
    const w = windowLine(`trust${filler(5000)}`, queryFinder('rust'));
    assert.match(w, /^trust/);
    assert.match(w, /…  \[line of 5,005 chars; --full-lines shows it whole\]$/);
  });

  it('with no way to find the match the line is cut from its start and still says its length', () => {
    const w = windowLine(filler(5000), null);
    assert.ok(w.length < 500);
    assert.match(w, /\[line of 5,000 chars; --full-lines shows it whole\]$/);
  });

  it('a search for several words finds whichever comes first; a regex is taken as written', () => {
    assert.match(windowLine(long, queryFinder('nothing untrusted')), /untrusted/);
    assert.match(windowLine(long, queryFinder('is[A-Z]rusted', { regex: true })), /isTrusted/);
    assert.equal(queryFinder('(', { regex: true }), null, 'a pattern that does not compile finds nothing and does not throw');
  });

  const result = (lineText) => ({ filePath: 'app/vendor/bundle.umd.js', lineNumber: 6, lineText, functionName: null, matchType: 'literal', context: lineText });

  it('printResults shows the window, and the whole line under fullLines', () => {
    const cut = capture(() => printResults([result(long)], { find: queryFinder('rust') }));
    const row = cut.find((l) => /^\s+L6 /.test(l));
    assert.ok(row && row.length < 600, `the row is ${row && row.length} characters`);
    assert.match(row, /isTrusted/);
    const whole = capture(() => printResults([result(long)], { find: queryFinder('rust'), fullLines: true }));
    assert.ok(whole.find((l) => /^\s+L6 /.test(l)).length > 90000);
  });

  it('the context lines of --verbose are cut the same way', () => {
    const out = capture(() => printResults([result(long)], { find: queryFinder('rust'), verbose: true }));
    assert.ok(out.every((l) => l.length < 700), `longest line printed: ${Math.max(...out.map((l) => l.length))}`);
  });
});
