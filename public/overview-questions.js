// overview-questions.js — the "Questions to start with" section of an Overview by AI: find it, extract a chat prompt from each line, splice a fresh set in
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// DOM-free on purpose: the renderer (list-renderers.js) and the regenerate
// control use these, and test/test_overview_questions.js imports them under
// the node test runner. Two model shapes are handled, observed on the Ghost
// Architect index (gui-overview-questions-to-chat):
//
//   Claude:  1. *How does a scan move from the CLI queue into a spoke node?* — Open the Functions accordion and filter for ...
//   Qwen:    • Ask the Chat pane about `runBlastScanInBackground` to understand background scanning processes.
//
// The italic question is the prompt when there is one; otherwise the line
// minus its list marker already reads as a prompt.

const HEADER_RE = /questions to start with/i;
// A header line in the overview's light Markdown: `## ...`, or a whole-line
// **bold** phrase, optionally ending in a colon (Claude's shape); Qwen writes
// the same phrase as plain text with a colon, which HEADER_RE still matches
// on text, so isQuestionsHeader does not require the header styling.
const MD_HEADER_RE = /^#{1,6}\s/;
const BOLD_LINE_RE = /^\*\*[^*].*\*\*:?\s*$/;
const LIST_MARKER_RE = /^\s*(?:\d+[.)]\s+|[-*•]\s+)/;

/** True when the line is the section's header, in any of the model shapes. */
export function isQuestionsHeader(line) {
  const s = String(line || '').trim();
  if (!s) return false;
  const text = s.replace(MD_HEADER_RE, '').replace(/\*\*/g, '').replace(/:\s*$/, '').trim();
  // The header is the phrase alone (plus trailing punctuation), not a sentence
  // that happens to mention it.
  return HEADER_RE.test(text) && text.length <= 40;
}

/** True when the line is a header of any kind (what ends the section). */
export function isHeaderLine(line) {
  const s = String(line || '');
  return MD_HEADER_RE.test(s) || BOLD_LINE_RE.test(s.trim());
}

/** True when the line is one of CE's own notes under the answer (`ⓘ …`). */
export function isNoteLine(line) {
  return /^\s*ⓘ/.test(String(line || ''));
}

/**
 * The section's bounds in a prose split into lines: `start` is the index of
 * the first line after the header, `end` is the index of the first line that
 * ends the section (the next header, the first ⓘ note, or lines.length).
 * Null when there is no section.
 */
export function findQuestionsSection(lines) {
  const arr = Array.isArray(lines) ? lines : String(lines || '').split('\n');
  const headerAt = arr.findIndex(isQuestionsHeader);
  if (headerAt < 0) return null;
  let end = headerAt + 1;
  while (end < arr.length && !isHeaderLine(arr[end]) && !isNoteLine(arr[end])) end++;
  return { headerAt, start: headerAt + 1, end };
}

/**
 * The chat prompt in one line of the section, or null when the line carries
 * none (blank, or a bare marker). An italic `*...?*` segment wins (Claude's
 * shape); otherwise the line with its list marker stripped (Qwen's shape).
 */
export function questionFromOverviewLine(line) {
  const s = String(line || '').replace(/\s+$/, '');
  if (!s.trim()) return null;
  const italic = s.match(/(?:^|[^*])\*([^*\n]+\?)\*(?!\*)/);
  if (italic) {
    const q = italic[1].trim();
    if (q) return q;
  }
  const stripped = s.replace(LIST_MARKER_RE, '').trim();
  if (!stripped || /^[-*•]$/.test(stripped)) return null;
  return stripped;
}

/**
 * The questions the section carries now, for "different from these".
 */
export function questionsInProse(prose) {
  const lines = String(prose || '').split('\n');
  const sec = findQuestionsSection(lines);
  if (!sec) return [];
  return lines.slice(sec.start, sec.end).map(questionFromOverviewLine).filter(Boolean);
}

/**
 * The prose with the section's body replaced by `newLines` (strings, one per
 * line; a model's answer split on newlines works). The header, everything
 * before it, and everything from the section's end (the ⓘ notes, the footer)
 * are untouched. The prose unchanged when there is no section.
 */
export function spliceQuestions(prose, newLines) {
  const text = String(prose || '');
  const lines = text.split('\n');
  const sec = findQuestionsSection(lines);
  if (!sec) return text;
  const body = (Array.isArray(newLines) ? newLines : String(newLines || '').split('\n'))
    .map((l) => String(l).replace(/\s+$/, ''));
  // Trim blank edges of the new body, then keep exactly one blank line before
  // whatever followed the old section (a ⓘ note or the footer), as the
  // overview's own layout does.
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  const after = lines.slice(sec.end);
  const sep = after.length && after[0].trim() ? [''] : [];
  return [...lines.slice(0, sec.start), ...body, ...sep, ...after].join('\n');
}
