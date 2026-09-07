// test_answer_disclosure.js — refusal detection and disclosure notes over 11 verbatim local-model captures
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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
import { looksLikeRefusal, answerDisclosure, unsupportedModelNames, aimlVerificationNote, namesInModelSentences } from '../src/core/answer-disclosure.js';

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

// ---------------------------------------------------------------------------
// #306 F70 — AI/ML sentence verification.
//
// ALL NINE SENTENCES BELOW ARE VERBATIM from asus-CC's 51-index sweep, with
// punctuation and backticks untouched, paired with the `models_used` output
// measured for the same index. The first cut of these tests used prose I had
// RECONSTRUCTED from their summary table — flagged as a weakness here at the
// time, then answered. Result against the shipped code: 9/9.
//
// Six must footnote; three must stay silent. The silent three are the
// load-bearing half: a verifier that annotates correct output is worse than no
// verifier, because the footnote stops meaning anything.
// ---------------------------------------------------------------------------

const AIML = [
  ['.as_ml_code', true,
    'The codebase leverages several AI/ML models, including `uqDZmUu9Dvqcve5ZcNZdJSmhxu2oSPdJ`, which appears to be a locally loaded model, likely integral to the claim analysis pipeline.',
    '22 models used - 6 api, 16 local:\nlocal codellama\nlocal DeepSeek-R1-Distill\nlocal PatentSBERTa\nlocal codet5\nlocal Phi-3'],
  ['.CrewAI', true,
    'The codebase uses several AI/ML models, including Anthropic and Bedrock, suggesting integration with cloud-based LLM services.',
    '4 models used - 4 api:\napi gpt-4o-mini\napi gpt-4o\napi text-embedding-3-large\napi text-embedding-ada-002'],
  ['.tensorflow', true,
    'The project uses several AI/ML models, including `TensorFlow` and `XLA`, suggesting a focus on deep learning and accelerated computation.',
    '4 models used:\nlocal model.ckpt\nlocal my_model.h5\nlocal f.batch03epoch02.h5\nlocal keras_embedding.ckpt'],
  ['.llama_cpp', true,
    'The project uses a variety of models, including Llama, Cohere, and Gemma, and supports various quantization methods.',
    '10 models used:\napi gpt-3.5-turbo-instruct\napi davinci-002\napi gpt-4.1\nlocal ggml-model-q4_0.gguf'],
  ['.agent_books_source', true,
    "The codebase uses OpenAI's models, including `oai_text_embedding`, for embedding text.",
    '5 models used:\napi gpt-4-1106-preview\napi text-embedding-ada-002\napi gpt-4o\napi gpt-4-turbo'],
  ['.TreeOfThought', true,
    'The project uses several AI/ML models, including GPT-4, for prompt generation and evaluation.',
    'No model ids found - do not infer absence. Models USED = ids the code loads or calls as LITERALS'],
  // --- the three faithful ones ---
  ['.image_vision', false,
    'Three local models are used: `vqgan_imagenet_f16_1024.ckpt`, `dataset.h5`, and `resnet50`.',
    '3 models used:\nlocal vqgan_imagenet_f16_1024.ckpt\nlocal dataset.h5\nlocal resnet50'],
  ['.DeepSeek', false,
    'The project uses two local models: `deepseek_vl_v2` and `deepseek-vl2`.',
    '2 models used:\nlocal deepseek_vl_v2\nlocal deepseek-vl2'],
  ['.Qwen3', false,
    'The codebase utilizes the Qwen model locally, with both the 7B and 72B Chat versions being artifacts.',
    '3 models used:\nlocal Qwen\nlocal Qwen/Qwen-7B-Chat\nlocal Qwen/Qwen-72B-Chat'],
];

describe('#306 AI/ML sentence verification — nine verbatim sweep sentences', () => {
  for (const [idx, shouldFootnote, prose, tool] of AIML) {
    it(`${idx}: ${shouldFootnote ? 'confabulated -> footnote' : 'FAITHFUL -> must stay silent'}`, () => {
      const note = aimlVerificationNote(prose, tool);
      if (!shouldFootnote) {
        assert.equal(note, '', `false footnote on a correct sentence: ${JSON.stringify(unsupportedModelNames(prose, tool))}`);
        return;
      }
      assert.match(note, /AI\/ML SENTENCE UNVERIFIED/);
      assert.match(note, /<models_used>/);
    });
  }

  it('names exactly the confabulated terms, with no prose junk in the list', () => {
    const got = Object.fromEntries(AIML.filter((c) => c[1]).map(([i, , p, t]) => [i, unsupportedModelNames(p, t)]));
    assert.deepEqual(got['.as_ml_code'], ['uqDZmUu9Dvqcve5ZcNZdJSmhxu2oSPdJ']);
    assert.deepEqual(got['.tensorflow'], ['TensorFlow', 'XLA']);
    assert.deepEqual(got['.llama_cpp'], ['Llama', 'Cohere', 'Gemma']);
    assert.deepEqual(got['.TreeOfThought'], ['GPT-4']);
    // `cloud-based` (an ordinary hyphenated adjective) must not appear.
    assert.deepEqual(got['.CrewAI'], ['Anthropic', 'Bedrock']);
    // Possessive stripped: "OpenAI's models" names OpenAI, not "OpenAI's".
    assert.deepEqual(got['.agent_books_source'], ['oai_text_embedding', 'OpenAI']);
  });

  // asus-CC's own extractor split INSIDE `vqgan_imagenet_f16_1024.ckpt` and
  // reported the fragment as unsupported. Mine survives only because the split
  // requires whitespace after the terminator — correct, but by accident until
  // this test. A "simplification" to a bare /[.!?]/ split reintroduces their bug.
  it('does not segment inside a dotted model id (the .image_vision hazard)', () => {
    const row = AIML.find((c) => c[0] === '.image_vision');
    const names = namesInModelSentences(row[2]);
    assert.ok(names.includes('vqgan_imagenet_f16_1024.ckpt'), `truncated: ${JSON.stringify(names)}`);
    assert.ok(names.includes('dataset.h5'), 'lost a name after the dotted id');
    assert.ok(names.includes('resnet50'), 'lost the trailing name');
    assert.equal(aimlVerificationNote(row[2], row[3]), '');
  });

  // Strict containment would flag this correct sentence: the prose never writes
  // `Qwen/Qwen-7B-Chat`, only "the Qwen model ... 7B and 72B Chat versions".
  it('tolerates a looser prose form than the exact id (.Qwen3)', () => {
    const row = AIML.find((c) => c[0] === '.Qwen3');
    assert.deepEqual(unsupportedModelNames(row[2], row[3]), []);
  });

  it('the hyphen rule keeps real ids and drops English adjectives', () => {
    const kept = 'The models are GPT-4, text-embedding-ada-002, deepseek-vl2 and Qwen-72B-Chat.';
    for (const id of ['GPT-4', 'text-embedding-ada-002', 'deepseek-vl2', 'Qwen-72B-Chat']) {
      assert.ok(namesInModelSentences(kept).includes(id), `hyphen rule ate a real id: ${id}`);
    }
    const adj = 'It uses models from cloud-based and self-hosted providers.';
    for (const junk of ['cloud-based', 'self-hosted']) {
      assert.ok(!namesInModelSentences(adj).includes(junk), `kept an adjective: ${junk}`);
    }
  });

  it('says nothing when models_used was never called — cannot verify, so does not', () => {
    assert.equal(aimlVerificationNote('The project uses several AI/ML models, including GPT-4.', ''), '');
  });

  it('only scans sentences that mention models', () => {
    const prose = 'The CLI entry point is src/index.js and the parser is ArgParse.\nIt loads models such as resnet50.';
    assert.deepEqual(unsupportedModelNames(prose, '1 models used:\nlocal resnet50'), []);
  });

  it('reports rather than classifies — the note disclaims judgement', () => {
    const note = aimlVerificationNote('It uses models including Anthropic.', '1 models used:\nlocal x');
    assert.match(note, /mechanical comparison, not a judgement/);
    assert.match(note, /may be a vendor or framework rather than a model/);
  });
});
