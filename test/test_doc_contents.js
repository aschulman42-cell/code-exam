// test_doc_contents.js — every "## Contents" list under docs/ matches its page's "##" headings, and every page of 300 lines and five sections has one or is a named exception; the anchor and list arithmetic of scripts/doc-contents.mjs
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// docs-contents-lists (2026-11-25). A section added or renamed without its page's list being
// rebuilt, or a page that grows past the threshold with no list, fails here with the page's
// name and the command that repairs it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIN_LINES, MIN_SECTIONS, EXCEPTIONS, splitLines, headingsOf, plainText, anchorFor, sectionsOf, listLines,
  findMarkers, refresh, add, overThreshold, checkDir,
} from '../scripts/doc-contents.mjs';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const anchor = (h) => anchorFor(h, new Map());

describe('the docs/ pages', () => {
  it('every contents list matches its page, and every long page has one or is a named exception', () => {
    const problems = checkDir(DOCS);
    assert.equal(problems.length, 0, '\n' + problems.map((p) => `${p.page}: ${p.problem}.\n  To repair: ${p.fix}`).join('\n'));
  });

  it('every named exception is a page that exists, is over the threshold, and has no list', () => {
    for (const name of Object.keys(EXCEPTIONS)) {
      const file = path.join(DOCS, name);
      assert.ok(fs.existsSync(file), `${name} is named as an exception and is not under docs/: take it off EXCEPTIONS in scripts/doc-contents.mjs`);
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(overThreshold(text), `${name} is under ${MIN_LINES} lines or ${MIN_SECTIONS} sections now, so it needs no exception`);
      assert.equal(refresh(text).has, false);
    }
  });

  it('a list is where a reader meets it: before the page\'s second "##" section', () => {
    for (const name of fs.readdirSync(DOCS).filter((f) => f.endsWith('.md'))) {
      const { lines } = splitLines(fs.readFileSync(path.join(DOCS, name), 'utf8'));
      const m = findMarkers(lines);
      if (!m) continue;
      const before = sectionsOf(lines).filter((s) => s.line < m.start).length;
      assert.ok(before <= 1, `${name}: ${before} sections come before its contents list`);
    }
  });
});

describe('anchors, as GitHub makes them', () => {
  it('lower case, punctuation dropped, spaces to hyphens', () => {
    assert.equal(anchor('Using it'), 'using-it');
    assert.equal(anchor('What "embedding" means here'), 'what-embedding-means-here');
    assert.equal(anchor('Why this works when "embeddings won\'t work here" was the earlier answer'), 'why-this-works-when-embeddings-wont-work-here-was-the-earlier-answer');
    assert.equal(anchor('Does this mean moving away from multisect?'), 'does-this-mean-moving-away-from-multisect');
    assert.equal(anchor('1. Where you see concepts'), '1-where-you-see-concepts');
  });

  it('code marks go and what is inside stays; a colon goes; a hyphen and an underscore stay', () => {
    assert.equal(anchor('Searching from a mechanism: `id:m70`'), 'searching-from-a-mechanism-idm70');
    assert.equal(anchor('`--build-index` and func_hashes'), '--build-index-and-func_hashes');
    assert.equal(anchor('src/core — the engine room'), 'srccore--the-engine-room');
  });

  it('a link in a heading counts as its words', () => {
    assert.equal(plainText('See [the CLI page](cli.md#x) first'), 'See the CLI page first');
    assert.equal(anchor('See [the CLI page](cli.md#x) first'), 'see-the-cli-page-first');
  });

  it('a repeated heading is numbered, and a heading of any level counts toward the number', () => {
    const lines = ['# T', '## Related', '### Related', '## Related'];
    assert.deepEqual(sectionsOf(lines).map((s) => s.anchor), ['related', 'related-2']);
  });
});

describe('which lines are headings', () => {
  it('a "##" line inside fenced code is not a heading, whatever the fence', () => {
    const lines = ['## A', '```markdown', '## Contents', '## not one', '```', '## B', '~~~', '## nor this', '~~~', '````', '```', '## nor this', '````', '## C'];
    assert.deepEqual(headingsOf(lines).map((h) => h.text), ['A', 'B', 'C']);
  });

  it('a line of inline code that starts with three backticks does not open a fence', () => {
    assert.deepEqual(headingsOf(['```x``` is code', '## A']).map((h) => h.text), ['A']);
  });

  it('only "##" sections are listed, and the Contents heading is not', () => {
    const lines = ['# Title', '## Contents', '## One', '### Deeper', '#### Deeper still', '## Two'];
    assert.deepEqual(sectionsOf(lines).map((s) => s.text), ['One', 'Two']);
  });
});

describe('the list', () => {
  const secs = [{ text: 'One', anchor: 'one' }, { text: '`two` things', anchor: 'two-things' }, { text: 'See [three](x.md)', anchor: 'see-three' }];
  it('one bullet a section, the heading as the link text', () => {
    assert.deepEqual(listLines(secs), ['- [One](#one)', '- [`two` things](#two-things)', '- [See three](#see-three)']);
  });
  it('compact: the same links, a separator after each but the last, so they run together when rendered', () => {
    assert.deepEqual(listLines(secs, true), ['[One](#one) ·', '[`two` things](#two-things) ·', '[See three](#see-three)']);
  });
});

describe('refresh and add', () => {
  const page = (eol, list) => ['# T', '', 'Opening.', '', '## Contents', '', '<!-- contents:start -->', ...list, '<!-- contents:end -->', '', '## One', '', 'text', '', '## Two', ''].join(eol);

  it('a stale list is rebuilt, and nothing outside the markers changes', () => {
    const r = refresh(page('\n', ['- [Old](#old)']));
    assert.equal(r.changed, true);
    assert.equal(r.text, page('\n', ['- [One](#one)', '- [Two](#two)']));
  });

  it('a current list is left byte for byte', () => {
    const text = page('\n', ['- [One](#one)', '- [Two](#two)']);
    const r = refresh(text);
    assert.equal(r.changed, false);
    assert.equal(r.text, text);
  });

  it('a page with Windows line endings keeps them', () => {
    const r = refresh(page('\r\n', []));
    assert.equal(r.text, page('\r\n', ['- [One](#one)', '- [Two](#two)']));
    assert.ok(!/[^\r]\n/.test(r.text));
  });

  it('a page with no markers is reported as having none and returned as it came', () => {
    const r = refresh('# T\n\n## One\n');
    assert.deepEqual([r.has, r.changed, r.text], [false, false, '# T\n\n## One\n']);
  });

  it('a start marker with no end marker is an error, not a rewrite of the rest of the page', () => {
    assert.throws(() => refresh('## Contents\n<!-- contents:start -->\n## One\n'), /no "<!-- contents:end -->"/);
  });

  it('add puts the block before the first "##" heading, and refresh then finds it current', () => {
    const out = add('# T\n\nOpening.\n\n## One\n\n## Two\n');
    assert.equal(out, '# T\n\nOpening.\n\n## Contents\n\n<!-- contents:start -->\n- [One](#one)\n- [Two](#two)\n<!-- contents:end -->\n\n## One\n\n## Two\n');
    assert.equal(refresh(out).changed, false);
  });

  it('add, compact', () => {
    const out = add('# T\n\n## One\n\n## Two\n', true);
    assert.match(out, /<!-- contents:start compact -->\n\[One\]\(#one\) ·\n\[Two\]\(#two\)\n<!-- contents:end -->/);
    assert.equal(refresh(out).changed, false);
  });

  it('add refuses a page that has a list, or a Contents section written by hand', () => {
    assert.throws(() => add(page('\n', [])), /already has the markers/);
    assert.throws(() => add('# T\n\n## Contents\n\n- [One](#one)\n\n## One\n'), /by hand/);
  });
});

describe('the threshold', () => {
  const pageOf = (lines, sections) => [...Array.from({ length: sections }, (_, i) => `## S${i}`), ...Array.from({ length: lines - sections }, () => 'x')].join('\n') + '\n';
  it(`${MIN_LINES} lines and ${MIN_SECTIONS} sections, both`, () => {
    assert.equal(overThreshold(pageOf(MIN_LINES, MIN_SECTIONS)), true);
    assert.equal(overThreshold(pageOf(MIN_LINES - 1, MIN_SECTIONS)), false);
    assert.equal(overThreshold(pageOf(MIN_LINES, MIN_SECTIONS - 1)), false);
  });
});
