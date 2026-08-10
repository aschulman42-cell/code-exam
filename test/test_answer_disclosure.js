// #306 fix-list item 5 (F55, F56) — the declining-answer disclosure.
//
// EVERY fixture below is a REAL capture from asus-CC's Chat runs
// (gemma-3-12b-it-qat-Q4_0, grounding=grounded, build code-exam-main-080726),
// verbatim, not a case invented to make the matcher look right. That distinction
// is the whole reason they were requested: a classifier tested only against
// examples its author chose cannot catch the failure this item already has on
// record — the originally-specified threshold detector, run against batch 3,
// would have scored a regression as a fix.
//
// Two of the eleven justify the request on their own:
//   - exoplayer/prestart  — 8 calls, 3 distinct, STILL refuses. Matched neither
//     drafted threshold. A real gap that would not have been imagined.
//   - ce/aiml-pipelines   — ONE call and a real ANSWER. The true negative; a
//     loose matcher fires here and annotates a genuine answer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeRefusal, answerDisclosure } from '../src/core/answer-disclosure.js';

// name, tool names in call order, answer text (verbatim), is-a-refusal
const CAPTURES = [
  ['exoplayer/ratepick', Array(24).fill('search'), true,
    'The tools did not surface any code that explicitly makes a decision about requesting a coding rate (or bitrate/quality/level) based on stored content measurements (buffer size, cache size, stored bytes, etc.). Therefore, it is **not determinable from the code** which class and method make this decision, nor which stored-content measurements they use.'],

  ['exoplayer/prestart', ['search', 'search', 'search', 'search', 'search', 'search', 'digest', 'list_functions'], true,
    'The code does not contain information about how the coding rate is decided before reproduction starts, or if it is different than during steady-state reproduction. Therefore, it is not determinable from the code.'],

  ['sr_gh/faithful-cot', ['digest'], true,
    'I am unable to find a function or file named "FaithfulCoTDetector" in the current index. Therefore, I cannot describe what is meant by "faithful" CoT or how the code detects CoT that is not faithful.'],

  ['sr_gh/beyond-posthoc', ['search'], true,
    'The term "unfaithful CoT" is not found in the codebase.'],

  ['sr_gh/rl-connection', ['digest'], true,
    'I am unable to find a function or file named "reinforcement_learning" in the current index.'],

  ['ce/multisect-1page', ['digest'], true,
    'I am unable to find a function or file named "multisect" in the current index. Please provide a file hint (e.g., `src/foo.js@multisect`) if you believe the name is qualified.'],

  ['ce/air-gapped', ['digest'], true,
    'The term "air-gapped requirement" was not found in the index. Therefore, how it enforces the optional air-gapped requirement is not determinable from the code.'],

  // THE TRUE NEGATIVE. Note it contains "doesn't correctly identify" and
  // "don't involve" — near-miss phrasings a careless matcher would catch.
  ['ce/aiml-pipelines', ['search'], false,
    'The code locates AI/ML pipelines by looking for connected pipelines (RAG/training/inference/agent/LLM-app) based on cell co-occurrence. It also identifies pipelines by the presence of the phrase "AI/ML Pipelines" in files like `public/index.html`.\n\nThe pipeline detection might go wrong if:\n\n*   There are AI/ML pipelines that don\'t involve cell co-occurrence.\n*   The phrase "AI/ML Pipelines" is used in contexts unrelated to actual pipelines.\n*   The code doesn\'t correctly identify connected pipelines based on cell co-occurrence.'],

  ['bram/worklist-role', ['digest'], true,
    'The role of the worklist.json file is not determinable from the code.'],

  ['bram/gh-to-worklist', ['digest'], true,
    'I am unable to find a function named "Bram.Bram" in the index. Please provide a file hint, such as "file@name", to help me locate the function.'],

  ['bram/apply-vs-commit', ['digest'], true,
    'I am unable to find a function named "applyWorklistItem" in the current index. Please provide a file hint if you know the file it resides in.'],
];

describe('#306 declining-answer disclosure — against real captures', () => {
  for (const [name, tools, isRefusal, text] of CAPTURES) {
    it(`${name}: ${isRefusal ? 'refusal' : 'ANSWER (must stay silent)'}`, () => {
      assert.equal(looksLikeRefusal(text), isRefusal);
      const note = answerDisclosure(text, tools);
      if (!isRefusal) {
        assert.equal(note, '', 'annotated a genuine answer');
        return;
      }
      assert.match(note, /declines to conclude/);
      assert.match(note, new RegExp(`${tools.length} tool call`));
      assert.match(note, new RegExp(`${new Set(tools).size} distinct tool`));
    });
  }

  // The drafted threshold detector caught 9 of these 10 refusals. The point of
  // dropping thresholds is that it now catches all of them — assert the count
  // rather than trusting the per-case tests to have covered it.
  it('covers every refusal in the set, including the two thresholds missed', () => {
    const refusals = CAPTURES.filter(c => c[2]);
    assert.equal(refusals.length, 10, 'fixture set drifted');
    for (const [name, tools, , text] of refusals) {
      assert.notEqual(answerDisclosure(text, tools), '', `${name} produced no disclosure`);
    }
    // The one the drafted `toolCalls>=5 && distinct===1` signature missed.
    const [, prestartTools, , prestartText] = CAPTURES.find(c => c[0] === 'exoplayer/prestart');
    assert.match(answerDisclosure(prestartText, prestartTools), /8 tool calls using 3 distinct tools/);
  });

  it('states the basis without judging the answer', () => {
    const note = answerDisclosure('It is not determinable from the code.', ['search']);
    assert.match(note, /A refusal can be the correct answer/,
      'must not imply the refusal is wrong — an honest refusal is correct output for an evidence tool');
    assert.doesNotMatch(note, /should have|failed to|try again|incorrect/i);
  });

  it('names the zero-call case explicitly rather than saying "0 tool calls"', () => {
    assert.match(answerDisclosure('Not determinable from the code.', []), /without calling any tools/);
  });

  it('singular and plural read correctly', () => {
    const one = answerDisclosure('Not determinable.', ['search']);
    assert.match(one, /1 tool call using 1 distinct tool \(search\)/);
    assert.doesNotMatch(one, /1 tool calls|1 distinct tools/);
    assert.match(answerDisclosure('Not determinable.', ['search', 'digest']), /2 tool calls using 2 distinct tools/);
  });

  it('deduplicates repeated tools rather than listing them 24 times', () => {
    const note = answerDisclosure('Not determinable.', Array(24).fill('search'));
    assert.match(note, /24 tool calls using 1 distinct tool \(search\)/);
    assert.equal((note.match(/search/g) || []).length, 1);
  });

  it('empty and whitespace answers are not refusals', () => {
    for (const v of ['', '   ', null, undefined]) assert.equal(looksLikeRefusal(v), false);
  });
});
