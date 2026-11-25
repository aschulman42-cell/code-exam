#!/usr/bin/env node
// doc-contents.mjs — keeps the "## Contents" list at the front of a long docs page equal to the page's own "##" headings; --check reports a stale or missing list and changes nothing
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// docs-contents-lists (2026-11-25). A page under docs/ of 300 lines or more with five or more
// "##" sections opens with a linked list of those sections. Written by hand, such a list is
// wrong the first time a section is added or renamed, and a wrong contents list is worse than
// none. So the list sits between two markers and this script writes what goes between them:
//
//   ## Contents
//
//   <!-- contents:start -->
//   - [Using it](#using-it)
//   <!-- contents:end -->
//
// `<!-- contents:start compact -->` gives the same links several to a line, for a page with
// dozens of sections. Only "##" headings are listed; "###" and deeper are not. The anchors are
// made the way GitHub makes them. No model, no network.
//
//   node scripts/doc-contents.mjs                 rewrite the list on every docs/ page that has the markers
//   node scripts/doc-contents.mjs --check         change nothing; exit 1 if a list is stale, or a long page has none
//   node scripts/doc-contents.mjs --add docs/X.md put a list on a page that has none (before its first "##" heading)
//   node scripts/doc-contents.mjs --add --compact docs/X.md    the same, in the compact form
//   node scripts/doc-contents.mjs --print docs/X.md            print the block a page would get; change nothing
//
// test/test_doc_contents.js runs the check in `npm test`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIN_LINES = 300;
export const MIN_SECTIONS = 5;
export const START_RE = /^<!-- contents:start( compact)? -->[ \t]*$/;
export const END_RE = /^<!-- contents:end -->[ \t]*$/;
const TITLE = 'Contents';

// Pages at or over the threshold that have no list, each with the reason. A page not named
// here and over the threshold fails the check.
export const EXCEPTIONS = {
  'source-map.md': 'a list of files whose bullets are read by a test; its seven headings are the repository\'s folders',
  'claims-pipeline-state.md': 'the Worklist item retire-claims-state-pages would retire the page; if that item is dropped, it gets a list',
};

/** The lines of a page and its line ending. A final newline does not make a line. */
export function splitLines(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { lines, eol };
}

/**
 * Every heading of a page, in order, outside fenced code: [{ level, text, line }] with `line`
 * the index into the page's lines. A fence opens with three or more backticks or tildes (up to
 * three spaces in) and closes with at least as many of the same character.
 */
export function headingsOf(lines) {
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && !f[2].trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === '`' && f[2].includes('`'))) { fence = { ch: f[1][0], len: f[1].length }; continue; }
    const h = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(l);
    if (h && h[2]) out.push({ level: h[1].length, text: h[2], line: i });
  }
  return out;
}

/** A heading as it reads once rendered: link targets, images, tags and code marks gone. */
export function plainText(heading) {
  return heading
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`/g, '');
}

/**
 * GitHub's anchor for a heading: lower case, everything but letters, digits, spaces, hyphens
 * and underscores dropped, each space a hyphen. `seen` (a Map) carries the page's earlier
 * anchors: a repeat gets -1, -2, ... as GitHub gives it.
 */
export function anchorFor(heading, seen) {
  const base = plainText(heading).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
  const n = seen.get(base) || 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

/** The "##" sections of a page with their anchors, the Contents heading itself left out. */
export function sectionsOf(lines) {
  const seen = new Map();
  const out = [];
  for (const h of headingsOf(lines)) {
    const anchor = anchorFor(h.text, seen);   // every level counts toward the numbering of repeats
    if (h.level === 2 && plainText(h.text).trim() !== TITLE) out.push({ text: h.text, anchor, line: h.line });
  }
  return out;
}

/** The link text for a heading: the heading, with any link in it reduced to its words. */
const linkText = (heading) => heading.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').trim();

/** The lines that belong between the markers. */
export function listLines(sections, compact = false) {
  const links = sections.map((s) => `[${linkText(s.text)}](#${s.anchor})`);
  if (!compact) return links.map((l) => `- ${l}`);
  return links.map((l, i) => (i < links.length - 1 ? `${l} ·` : l));
}

/** Where the markers are: { start, end, compact } as line indexes, or null. */
export function findMarkers(lines) {
  const start = lines.findIndex((l) => START_RE.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && END_RE.test(l));
  if (end < 0) return { start, end: -1, compact: false, broken: true };
  return { start, end, compact: / compact /.test(lines[start]) };
}

/**
 * A page's text with its list rebuilt. { text, changed, has } : `has` is false, and the text
 * is returned as it came, when the page has no markers.
 */
export function refresh(text) {
  const { lines, eol } = splitLines(text);
  const m = findMarkers(lines);
  if (!m) return { text, changed: false, has: false };
  if (m.broken) throw new Error('a "<!-- contents:start -->" line has no "<!-- contents:end -->" line after it');
  const want = listLines(sectionsOf(lines), m.compact);
  const have = lines.slice(m.start + 1, m.end);
  if (have.length === want.length && have.every((l, i) => l === want[i])) return { text, changed: false, has: true };
  const next = [...lines.slice(0, m.start + 1), ...want, ...lines.slice(m.end)];
  return { text: next.join(eol) + (/\r?\n$/.test(text) ? eol : ''), changed: true, has: true };
}

/** The whole block for a page: heading, markers, list. */
export function blockLines(lines, compact = false) {
  return [`## ${TITLE}`, '', `<!-- contents:start${compact ? ' compact' : ''} -->`, ...listLines(sectionsOf(lines), compact), '<!-- contents:end -->'];
}

/** A page's text with a list put before its first "##" heading. Throws when it has one already. */
export function add(text, compact = false) {
  const { lines, eol } = splitLines(text);
  if (findMarkers(lines)) throw new Error('the page already has the markers; run without --add');
  if (headingsOf(lines).some((h) => h.level === 2 && plainText(h.text).trim() === TITLE)) throw new Error('the page has a "## Contents" section with no markers; put the two marker lines around its list by hand');
  const first = headingsOf(lines).find((h) => h.level === 2);
  if (!first) throw new Error('the page has no "##" heading');
  const next = [...lines.slice(0, first.line), ...blockLines(lines, compact), '', ...lines.slice(first.line)];
  return next.join(eol) + (/\r?\n$/.test(text) ? eol : '');
}

/** Does a page of this text have to carry a list? */
export function overThreshold(text) {
  const { lines } = splitLines(text);
  return lines.length >= MIN_LINES && sectionsOf(lines).length >= MIN_SECTIONS;
}

/**
 * What is wrong under a docs directory: [{ page, problem, fix }]. Empty when every page with
 * the markers is current and every page over the threshold has a list or a named exception.
 */
export function checkDir(dir) {
  const problems = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const rel = `docs/${name}`;
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    let r;
    try { r = refresh(text); } catch (e) { problems.push({ page: rel, problem: e.message, fix: 'repair the marker lines by hand' }); continue; }
    if (r.has && r.changed) problems.push({ page: rel, problem: 'its contents list does not match its "##" headings', fix: `node scripts/doc-contents.mjs ${rel}` });
    if (!r.has && overThreshold(text) && !EXCEPTIONS[name]) {
      const n = splitLines(text).lines.length;
      problems.push({ page: rel, problem: `it is ${n} lines with ${sectionsOf(splitLines(text).lines).length} "##" sections (a list is wanted from ${MIN_LINES} lines and ${MIN_SECTIONS} sections) and has no contents list`, fix: `node scripts/doc-contents.mjs --add ${rel}` });
    }
    if (r.has && EXCEPTIONS[name]) problems.push({ page: rel, problem: 'it has a contents list and is also named as an exception in scripts/doc-contents.mjs', fix: 'take it off EXCEPTIONS' });
  }
  return problems;
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const named = argv.filter((a) => !a.startsWith('--'));
  for (const f of flags) if (!['--check', '--add', '--compact', '--print', '--help'].includes(f)) { console.error(`doc-contents: unknown option ${f}. Options: --check, --add, --compact, --print.`); return 2; }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const docs = path.join(root, 'docs');
  if (flags.has('--help')) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(7, 30).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }

  if (flags.has('--check')) {
    const problems = checkDir(docs);
    for (const p of problems) console.log(`${p.page}: ${p.problem}.\n  To repair: ${p.fix}`);
    if (!problems.length) console.log('Every contents list under docs/ matches its page, and every long page has one or is a named exception.');
    return problems.length ? 1 : 0;
  }

  if (flags.has('--print') || flags.has('--add')) {
    if (!named.length) { console.error(`doc-contents: ${flags.has('--add') ? '--add' : '--print'} needs a page, for example docs/cli.md.`); return 2; }
    for (const p of named) {
      const file = path.resolve(p);
      const text = fs.readFileSync(file, 'utf8');
      if (flags.has('--print')) { console.log(blockLines(splitLines(text).lines, flags.has('--compact')).join('\n')); continue; }
      try { fs.writeFileSync(file, add(text, flags.has('--compact'))); console.log(`${p}: contents list added.`); }
      catch (e) { console.error(`${p}: ${e.message}.`); return 1; }
    }
    return 0;
  }

  const pages = named.length ? named.map((p) => path.resolve(p)) : fs.readdirSync(docs).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(docs, f));
  let changed = 0, had = 0;
  for (const file of pages) {
    const text = fs.readFileSync(file, 'utf8');
    const r = refresh(text);
    if (!r.has) { if (named.length) console.log(`${path.relative(root, file)}: no markers, so nothing to rebuild (--add puts a list on it).`); continue; }
    had++;
    if (r.changed) { fs.writeFileSync(file, r.text); changed++; console.log(`${path.relative(root, file)}: contents list rebuilt.`); }
  }
  console.log(`${had} page${had === 1 ? '' : 's'} with a contents list; ${changed} rebuilt.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
