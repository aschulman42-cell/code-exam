// test_overview_questions.js — overview-questions.js: section detection, question extraction (Claude and Qwen shapes), splice
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * gui-overview-questions-to-chat / gui-overview-questions-regenerate. The
 * module is DOM-free so the renderer's logic is testable here; the Ask-in-Chat
 * link and the regenerate control themselves are judged in the GUI.
 *
 * Run: node --test test/test_overview_questions.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuestionsHeader, isHeaderLine, isNoteLine, findQuestionsSection,
  questionFromOverviewLine, questionsInProse, spliceQuestions,
} from '../public/overview-questions.js';
import { AI_OVERVIEW_PROMPT, QUESTIONS_RULE, questionsRegenPrompt, questionLinesFromAnswer } from '../src/core/ai-overview.js';

// Two real shapes from the Ghost Architect index (2026-10-13), abbreviated.
const CLAUDE = [
  '**Where to look first**',
  '1. `src/api/routes.js` — the HTTP surface.',
  '',
  '**Questions to start with**',
  '1. *How does a scan move from the CLI queue into a spoke node for remote execution?* — Open the Functions accordion and filter for `spoke`.',
  '2. *What does the health score actually count?* — Ask the Chat pane: "what goes into the health score?"',
  '3. *Which routes are reachable without a session?* — `ce --client-server`',
  '',
  'ⓘ Based on 7 model tool calls: overview ×1, digest ×3, search ×3',
].join('\n');

const QWEN = [
  'Questions to start with:',
  '• Ask the Chat pane about `runBlastScanInBackground` to understand background scanning processes.',
  '• Use `ce --client-server` to see which routes exist.',
  '',
  'ⓘ Based on 4 model tool calls: overview ×1, search ×3',
].join('\n');

describe('section detection', () => {
  it('recognizes the header in bold, Markdown-header and plain-with-colon shapes, and not a sentence about it', () => {
    assert.ok(isQuestionsHeader('**Questions to start with**'));
    assert.ok(isQuestionsHeader('## Questions to start with'));
    assert.ok(isQuestionsHeader('Questions to start with:'));
    assert.ok(!isQuestionsHeader('The questions to start with are the ones a reviewer brings, as the paragraph below argues.'));
    assert.ok(!isQuestionsHeader(''));
  });

  it('ends the section at the next header or the first ⓘ note', () => {
    assert.ok(isHeaderLine('**Where to look first**'));
    assert.ok(isHeaderLine('## Architecture'));
    assert.ok(!isHeaderLine('1. *A question?* — an action'));
    assert.ok(isNoteLine('ⓘ Based on 7 model tool calls: overview'));
    // The section runs to the ⓘ note, so the blank line before it belongs to
    // the section (a blank yields no question; the splice re-adds one).
    const sec = findQuestionsSection(CLAUDE.split('\n'));
    assert.deepEqual(sec, { headerAt: 3, start: 4, end: 8 });
    const q = findQuestionsSection(QWEN.split('\n'));
    assert.deepEqual(q, { headerAt: 0, start: 1, end: 4 });
  });

  it('returns null when there is no section', () => {
    assert.equal(findQuestionsSection(['**Where to look first**', '1. a', '']), null);
  });
});

describe('question extraction', () => {
  it("takes the italic question from Claude's shape", () => {
    assert.equal(
      questionFromOverviewLine('1. *How does a scan move from the CLI queue into a spoke node?* — Open the Functions accordion.'),
      'How does a scan move from the CLI queue into a spoke node?',
    );
  });

  it("strips the marker from Qwen's shape and keeps the rest as the prompt", () => {
    assert.equal(
      questionFromOverviewLine('• Ask the Chat pane about `runBlastScanInBackground` to understand background scanning processes.'),
      'Ask the Chat pane about `runBlastScanInBackground` to understand background scanning processes.',
    );
    assert.equal(questionFromOverviewLine('- Use `ce --client-server` to see which routes exist.'), 'Use `ce --client-server` to see which routes exist.');
    assert.equal(questionFromOverviewLine('2) What is the entry point?'), 'What is the entry point?');
  });

  it('is null for blank lines and bare markers', () => {
    assert.equal(questionFromOverviewLine(''), null);
    assert.equal(questionFromOverviewLine('   '), null);
    assert.equal(questionFromOverviewLine('- '), null);
  });

  it('does not mistake **bold** for an italic question', () => {
    assert.equal(questionFromOverviewLine('1. **Which routes?** — see routes.js'), '**Which routes?** — see routes.js');
  });

  it('lists the current questions of a prose', () => {
    assert.deepEqual(questionsInProse(CLAUDE), [
      'How does a scan move from the CLI queue into a spoke node for remote execution?',
      'What does the health score actually count?',
      'Which routes are reachable without a session?',
    ]);
    assert.equal(questionsInProse(QWEN).length, 2);
    assert.deepEqual(questionsInProse('no section here'), []);
  });
});

describe('splice', () => {
  it('replaces exactly the section body and preserves the header, the ⓘ notes and the footer', () => {
    const out = spliceQuestions(CLAUDE, ['1. *Where is the queue drained?* — `ce --callers drain`', '2. *What logs a scan?* — Ask the Chat pane.']);
    const lines = out.split('\n');
    assert.equal(lines[3], '**Questions to start with**');
    assert.equal(lines[4], '1. *Where is the queue drained?* — `ce --callers drain`');
    assert.equal(lines[5], '2. *What logs a scan?* — Ask the Chat pane.');
    assert.equal(lines[6], '');
    assert.match(lines[7], /^ⓘ Based on 7 model tool calls/);
    assert.equal(lines.length, 8);
    assert.ok(out.startsWith('**Where to look first**'), 'everything before the section is untouched');
  });

  it('accepts the new body as one string and trims its blank edges', () => {
    const out = spliceQuestions(QWEN, '\n• One?\n• Two?\n\n');
    assert.equal(out, ['Questions to start with:', '• One?', '• Two?', '', 'ⓘ Based on 4 model tool calls: overview ×1, search ×3'].join('\n'));
  });

  it('is a no-op when there is no section', () => {
    const prose = '**Where to look first**\n1. a\n';
    assert.equal(spliceQuestions(prose, ['x']), prose);
  });

  it('a second regeneration replaces the first set and leaves one note and the footer', () => {
    const once = spliceQuestions(CLAUDE, ['1. *A?* — x', '', 'ⓘ Questions regenerated (sampled, temperature 0.8); the overview above is unchanged.']);
    const base = once.replace(/^ⓘ Questions regenerated[^\n]*\n?/m, '');
    const twice = spliceQuestions(base, ['1. *B?* — y', '', 'ⓘ Questions regenerated (sampled, temperature 0.8); the overview above is unchanged.']);
    assert.equal((twice.match(/Questions regenerated/g) || []).length, 1);
    assert.doesNotMatch(twice, /\*A\?\*/);
    assert.match(twice, /\*B\?\*/);
    assert.match(twice, /ⓘ Based on 7 model tool calls/);
  });
});

describe('regenerate prompt (one registration point for the questions rule)', () => {
  it('the overview prompt interpolates the same rule the regenerate prompt quotes', () => {
    assert.ok(AI_OVERVIEW_PROMPT.includes(QUESTIONS_RULE));
    const { system } = questionsRegenPrompt(CLAUDE, ['one?']);
    assert.ok(system.includes(QUESTIONS_RULE));
  });

  it('quotes the current questions and drops the ⓘ notes from the orientation', () => {
    const current = questionsInProse(CLAUDE);
    const { user } = questionsRegenPrompt(CLAUDE, current);
    for (const q of current) assert.ok(user.includes(q));
    assert.doesNotMatch(user, /ⓘ Based on/);
    assert.match(user, /CURRENT QUESTIONS/);
  });

  it('turns an answer into at most five marked lines, numbering bare ones and dropping an echoed header', () => {
    const lines = questionLinesFromAnswer('Questions to start with:\n1. *A?* — x\n\nWhat is B? — y\n3) *C?* — z\n4. d\n5. e\n6. f');
    assert.equal(lines.length, 5);
    assert.equal(lines[0], '1. *A?* — x');
    assert.equal(lines[1], '2. What is B? — y');
    assert.equal(lines[2], '3) *C?* — z');
  });
});
