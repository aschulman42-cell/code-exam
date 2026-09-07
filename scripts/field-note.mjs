#!/usr/bin/env node
// field-note.mjs — turns an annotated CE transcript's [[comments]] into a post-ready markdown checklist
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * scripts/field-note.mjs — field-note extractor.
 *
 * Andrew's field-note convention: raw CE terminal output annotated with
 * [[comments in double square brackets]] — observations, TODOs, cross-refs
 * that mature into action items later. This script reads one such file and
 * writes a post-ready markdown body to stdout: a header naming the source
 * and the ce commands seen in the transcript, then one `- [ ]` checklist
 * entry per comment with its line number, so the posted note reads as the
 * comment inventory and each item is tickable when it becomes real work.
 *
 * Mechanics worth knowing:
 * - [[...]] blocks may span lines; several may share a line.
 * - A first-line comment that merely announces the convention ("comments in
 *   double square brackets") is treated as the legend and skipped.
 * - A comment too short to stand alone (< 20 chars, e.g. "[[!!!]]") gets an
 *   excerpt of the preceding non-blank output line appended as (re: "..."),
 *   so a bare exclamation still names what it was reacting to.
 * - Bare #N issue refs pass through verbatim; GitHub autolinks them.
 *
 * Usage:
 *   node scripts/field-note.mjs <annotated.txt> [--title "..."]
 *
 * Then paste the output into a new issue / discussion / gist and attach the
 * txt itself (drag-drop into the comment box; it renders as a link, never
 * inline). Posting stays manual: issue attachments have no API.
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const ti = args.indexOf('--title');
const title = ti >= 0 && args[ti + 1] ? args[ti + 1] : null;

if (!file) {
  console.error('Usage: node scripts/field-note.mjs <annotated.txt> [--title "..."]');
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);

// ---------------------------------------------------------------------------
// Extract [[...]] blocks: multi-line tolerated, several per line tolerated.

const comments = [];
let open = null;
for (let i = 0; i < lines.length; i++) {
  let s = lines[i];
  for (;;) {
    if (!open) {
      const a = s.indexOf('[[');
      if (a === -1) break;
      open = { line: i + 1, parts: [] };
      s = s.slice(a + 2);
    } else {
      const b = s.indexOf(']]');
      if (b === -1) { open.parts.push(s.trim()); break; }
      open.parts.push(s.slice(0, b).trim());
      comments.push({ line: open.line, text: open.parts.filter(Boolean).join(' ') });
      open = null;
      s = s.slice(b + 2);
    }
  }
}
if (open) {
  // Unclosed block: keep what we have rather than dropping it silently.
  comments.push({ line: open.line, text: open.parts.filter(Boolean).join(' ') + ' [unclosed [[ block]' });
}

// The legend line announces the convention; it is not a note.
const body = comments.filter((c, i) =>
  !(i === 0 && /comments? in double square brackets/i.test(c.text)));

// Short comments get the line they were reacting to.
const SHORT = 20;
for (const c of body) {
  if (c.text.length >= SHORT) continue;
  for (let j = c.line - 2; j >= 0; j--) {
    const prev = (lines[j] || '').trim();
    if (!prev || prev.includes('[[') || prev.includes(']]')) continue;
    c.text += ` (re: "${prev.length > 80 ? prev.slice(0, 77) + '...' : prev}")`;
    break;
  }
}

// ---------------------------------------------------------------------------
// Header: source file, date, and the ce invocations seen in the transcript.

const cmds = [...new Set(
  lines.filter((l) => /(^|>)\s*ce\s+--/.test(l))
    .map((l) => l.replace(/^.*?(ce\s+--)/, 'ce --').trim())
)];

const st = fs.statSync(file);
if (title) console.log(`## ${title}\n`);
console.log(`**Source:** \`${path.basename(file)}\` (${st.mtime.toISOString().slice(0, 10)}, ${body.length} comment${body.length !== 1 ? 's' : ''})`);
if (cmds.length) console.log(`**Commands seen:** ${cmds.map((c) => '`' + c + '`').join(' · ')}`);
console.log();
for (const c of body) console.log(`- [ ] L${c.line} — ${c.text}`);
console.log();
console.log(`_Full CE output: attach \`${path.basename(file)}\` to this post (drag-drop; renders as a link, not inline)._`);
