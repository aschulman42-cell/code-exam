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
    // Possessive stripped: "OpenAI's models" names OpenAI, not "OpenAI's" — and
    // since the table holds gpt-* ids, OpenAI is that table restated by maker
    // (class G), so only the invented id remains.
    assert.deepEqual(got['.agent_books_source'], ['oai_text_embedding']);
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

  it('only scans sentences that mention models with an AI/ML cue', () => {
    const prose = 'The CLI entry point is src/index.js and the parser is ArgParse.\nIt loads models such as resnet50.';
    assert.deepEqual(unsupportedModelNames(prose, '1 models used:\nlocal resnet50'), []);
    // "model" in the data-modelling sense, no cue: the sentence is not scanned,
    // so `schema/Entity.js` is never a candidate.
    const data = 'The data model is defined in `schema/Entity.js` and validated by `EntityGuard`.';
    assert.deepEqual(namesInModelSentences(data), []);
  });

  it('reports rather than classifies — the note disclaims judgement', () => {
    const note = aimlVerificationNote('It uses models including Anthropic.', '1 models used:\nlocal x');
    assert.match(note, /mechanical comparison, not a judgement/);
    assert.match(note, /may be a vendor or framework rather than a model/);
  });
});

// ===========================================================================
// #320 — the guard's 0-for-3 scoreboard, repaired. Three mechanisms:
// 1b: CE's own ⓘ disclosure lines are stripped before the prose is scanned
//     (both observed firings footnoted CE's own RECOVERED-OUTPUT banner);
// 1c: verification is seed-aware (a correct citation of a filename from the
//     deterministic overview seed must not be footnoted), and the CONVERSE
//     direction — prose denies AI/ML while models_used reports models — is
//     checked at all (the one wrong answer in the 11-run matrix, unflagged).
// item 4: the evidentiary footer states what the answer is based on.
// ===========================================================================
import { aimlConverseNote, modelsUsedCount, modelsUsedDeclaredOnly, toolCallFooter, looksLikePathRef, indexPathsFromListFiles } from '../src/core/answer-disclosure.js';
import { modelsUsedNegative } from '../src/commands/metrics.js';

describe('#320 1b: CE ⓘ banner lines are not scanned as model prose', () => {
  const banner = 'ⓘ RECOVERED OUTPUT: the model made 5 tool call(s) and then ended its turn without writing anything.';
  it('the RECOVERED-OUTPUT banner alone produces no unsupported names', () => {
    // Before the fix: "RECOVERED", "OUTPUT" shaped like names, the banner's
    // "the model made..." matched /\bmodels?\b/, and the guard footnoted CE.
    assert.deepEqual(unsupportedModelNames(`${banner}\n\nA clean overview paragraph.`, '2 models used:\n- qwen\n- gemma'), []);
  });
  it('model prose around the banner is still scanned', () => {
    const prose = `${banner}\n\nThe code uses models including FakeNet-9000.`;
    assert.deepEqual(unsupportedModelNames(prose, '2 models used:\n- qwen\n- gemma'), ['FakeNet-9000']);
  });
});

describe('#320 1c: seed-aware verification', () => {
  it('a name present in the overview seed is supported evidence', () => {
    // Gemma K_M's CORRECT sr_gh sentence cited a filename from the seed's
    // vocabulary lines — not one of models_used's ids. Must not be footnoted.
    const prose = 'Local models are trained via `Qwen_Qwen1_5_0_5B_Chat_e5_lr0` runs.';
    const used = '21 models used — 2 api, 19 local\n- sonnet\n- qwen1.5';
    const seed = '**Vocabulary:**\n- lr0 (Qwen_Qwen1_5_0_5B_Chat_e5_lr0)';
    assert.deepEqual(unsupportedModelNames(prose, used, seed), []);
    assert.equal(aimlVerificationNote(prose, used, seed), '');
  });
  it('a name in neither the tool output nor the seed is still footnoted', () => {
    const prose = 'Models include `TotallyInvented-7B` throughout.';
    assert.deepEqual(unsupportedModelNames(prose, '1 models used:\n- qwen', 'seed text'), ['TotallyInvented-7B']);
  });
});

describe('index-path carve-out: a file CE indexed is not an invented model id', () => {
  // Measured on .GhostArch: the overview said "Model selection is handled in
  // `src/model-provider.js`" — a file CE had just digested — and CE footnoted
  // its own prose as naming an unverified model. The quoted/backticked branch
  // of namesInModelSentences adds the span verbatim, bypassing the shape
  // filter that rejects the same path unquoted, so ordinary markdown is the
  // trigger.
  const PROSE = 'Model selection is handled in `src/model-provider.js`, which routes AI calls.';
  const NONE = 'No model ids found - do not infer absence. Models USED = ids the code loads as LITERALS';
  const FILES = ['package/src/model-provider.js', 'package/src/portal-server.js', 'package/README.md'];

  it('reproduces the false positive when the index is not supplied', () => {
    assert.deepEqual(unsupportedModelNames(PROSE, NONE, ''), ['src/model-provider.js']);
  });
  it('clears once the indexed paths are passed', () => {
    assert.deepEqual(unsupportedModelNames(PROSE, NONE, '', FILES), []);
    // On a zero-id table the sentence is not footnoted as UNVERIFIED; CE says
    // instead that it had nothing to check it against (class B).
    const note = aimlVerificationNote(PROSE, NONE, '', FILES);
    assert.doesNotMatch(note, /UNVERIFIED/);
    assert.match(note, /found no literal model ids/);
  });
  it('matches by whole path as well as by suffix', () => {
    const exact = 'The model registry lives in `package/src/model-provider.js` only.';
    assert.deepEqual(unsupportedModelNames(exact, NONE, '', FILES), []);
  });
  it('an invented model id is STILL footnoted when an index is supplied', () => {
    // The carve-out must not become a blanket amnesty.
    const made_up = 'Models include `FakeNet-9000` for ranking.';
    assert.deepEqual(unsupportedModelNames(made_up, NONE, '', FILES), ['FakeNet-9000']);
  });
  it('a bare word is not excused by a file that merely contains it', () => {
    // Deliberately narrow: only candidates shaped like a file reference get
    // the carve-out, matched whole or by path suffix — never by substring.
    const bare = 'The models are served by Portal, the deployment target.';
    assert.deepEqual(unsupportedModelNames(bare, NONE, '', FILES), ['Portal']);
  });
  it('accepts an iterator, which is what index.files.keys() gives', () => {
    assert.deepEqual(unsupportedModelNames(PROSE, NONE, '', new Map(FILES.map(f => [f, 1])).keys()), []);
  });
});

describe('#320 1c: the converse check — denial vs a non-empty models_used', () => {
  const USED_21 = '21 models used — 2 api, 19 local\n- Qwen_Qwen1_5_0_5B_Chat\n…';
  const NEGATIVE = 'Models USED = ids the code loads or calls as LITERALS. '
    + 'To see what is actually loaded, search/regex_search the loader terms.';
  it('modelsUsedCount reads the positive header and nothing else', () => {
    assert.equal(modelsUsedCount(USED_21), 21);
    assert.equal(modelsUsedCount('1 model used — 1 local\n- x'), 1);
    assert.equal(modelsUsedCount(NEGATIVE), 0);
    assert.equal(modelsUsedCount(''), 0);
  });
  it('fires on the observed qwen3-14b denial with 21 models reported', () => {
    const note = aimlConverseNote('No AI/ML models are explicitly detected in this index.', USED_21);
    assert.match(note, /AI\/ML CLAIM CONTRADICTED/);
    assert.match(note, /reports 21 models/);
  });
  it('fires on the observed gemini phrasing too', () => {
    const note = aimlConverseNote(
      'The codebase does not explicitly load or call any AI/ML models directly that could be identified.', USED_21);
    assert.match(note, /CONTRADICTED/);
  });
  it('discloses when CE ran the tool itself for verification (the model never called it)', () => {
    const note = aimlConverseNote('No AI/ML models detected.', USED_21, { selfCalled: true });
    assert.match(note, /ran `models_used` unfiltered for this check/);
    assert.match(note, /the model never called it/);
  });
  it('discloses the model\'s own call when it differed (overview-verification-basis-unfiltered)', () => {
    // asus-CC, #330: Gemma called models_used({"filter":"/"}), emptied the table,
    // and CE verified against that. The basis is now CE's unfiltered call; the
    // model's call is disclosed, not used.
    const note = aimlConverseNote('No AI/ML models detected.', USED_21, { selfCalled: true, modelCallArgs: '{"filter":"/"}' });
    assert.match(note, /the model's own call was `models_used\(\{"filter":"\/"\}\)`/);
    assert.match(note, /CodeExam re-ran it unfiltered for this check/);
  });
  it('silent when the denial is CORRECT (zlib case: negative tool output)', () => {
    assert.equal(aimlConverseNote('No AI/ML models are detected here.', NEGATIVE), '');
  });
  it('silent when the prose affirms models (nothing denied)', () => {
    assert.equal(aimlConverseNote('The code loads two Qwen models for inference.', USED_21), '');
  });
});

// ===========================================================================
// overview-aiml-footnote-false-positives — two classes seen on a Claude
// overview of the Ghost Architect index (2026-10-13), plus what reading the
// same overview against the post-#345 table showed. Prose below carries the
// Ghost SHAPES under invented names; the real text stays local.
//   A: the English word "model" ("hub-and-spoke model", "data model") selected
//      a sentence, and every name in it was compared against models_used.
//   B: a zero-id table makes every name "not contained" by construction, and
//      reproduces 1,200 characters of loader-search boilerplate under it.
//   C: the indexed-path carve-out, extended to the cloud path (parser + shape).
//   D: a denial of "model ids" / "literals" is a denial the CONTRADICTED check
//      must recognise; and a denial of CALLING is not contradicted by a table
//      whose rows are all declared-only.
//   E: names inside a denial sentence are not claims to verify; an env-var
//      name (OPENAI_API_KEY) is never a model id.
// ===========================================================================

const HUB = 'The multi-node architecture uses a hub-and-spoke model: "relays" are remote agents that report scan results back to the hub portal via a queue (handleRelayScan, handleRelayQueueUpdate), and "mirrors" are sibling hubs that participate in load balancing (handleMirrorScan, cluster/balancer.js).';
const DENIAL = 'No model IDs are hardcoded as literals; they are resolved at runtime from user configuration, so models_used returns nothing — but RELAY_API_KEY is read in settings.js and Ollama is prominently the default local backend.';
const OFFLINE = 'The offline model keeps scans local when the relay is unreachable.';
const DECLARED_36 = '36 models used — 24 api, 12 local; 36 declared only (no call site):\napi    claude-sonnet-4-6  (declared, 8 sites)\nlocal  qwen3-coder:30b  (declared, 3 sites)';
const CALLED_3 = '3 models used — 3 api, 0 local:\napi    gpt-4o  (llm-call, 2 sites)';
const NEG = modelsUsedNegative(0);

describe('class A: the English word "model" — a sentence needs an AI/ML cue to be scanned', () => {
  it('the hub-and-spoke sentence is not scanned (function names and a path are not model claims)', () => {
    assert.deepEqual(namesInModelSentences(HUB), []);
    assert.equal(aimlVerificationNote(HUB, DECLARED_36), '');
  });
  it('"the offline model" is not scanned', () => {
    assert.deepEqual(namesInModelSentences(OFFLINE), []);
  });
  it('"load balancing" is not a load verb', () => {
    assert.deepEqual(namesInModelSentences('The model: a queue feeds workers that do load balancing via Dispatcher.'), []);
  });
  it('every one of the nine sweep sentences is still scanned', () => {
    for (const [idx, , prose] of AIML) {
      assert.ok(namesInModelSentences(prose).length > 0, `${idx} dropped by the cue rule`);
    }
  });
  it('a model-shaped token is a cue on its own (the FakeNet-9000 carve-out case stays live)', () => {
    assert.deepEqual(namesInModelSentences('Models include `FakeNet-9000` for ranking.'), ['FakeNet-9000']);
  });
  it('a sentence with "model" in both senses and an AI cue is still scanned (stated residual)', () => {
    const both = 'The data model feeds the LLM model `Ranker-7B` at inference time.';
    assert.ok(namesInModelSentences(both).includes('Ranker-7B'));
  });
});

describe('class B: the zero-id path', () => {
  it('the Ghost shapes on a zero-id table: no UNVERIFIED note, and nothing at all for a consistent denial', () => {
    const note = aimlVerificationNote([HUB, DENIAL].join(' '), NEG, '', ['package/src/settings.js']);
    assert.equal(note, '');
  });
  it('an affirming AI/ML sentence with no model-shaped name gets the one-line disclosure, not a comparison', () => {
    const note = aimlVerificationNote('The service uses several AI/ML models for ranking and Ollama as the backend.', NEG);
    assert.doesNotMatch(note, /UNVERIFIED/);
    assert.match(note, /found no literal model ids/);
    assert.doesNotMatch(note, /<models_used>/);
  });
  it('an invented model-shaped id on a zero-id table is STILL footnoted (.TreeOfThought keeps its catch), without the boilerplate', () => {
    const row = AIML.find((c) => c[0] === '.TreeOfThought');
    const note = aimlVerificationNote(row[2], NEG);
    assert.match(note, /UNVERIFIED/);
    assert.match(note, /"GPT-4"/);
    assert.match(note, /<models_used>\nNo model ids found - do not infer absence\.\n<\/models_used>/);
    assert.doesNotMatch(note, /search\/regex_search the loader terms/);
  });
  it('prose with no model sentence at all says nothing', () => {
    assert.equal(aimlVerificationNote('The entry point is bin/ghost.js and the server is portal-server.js.', NEG), '');
  });
});

describe('class C: the cloud path\'s carve-out — list_files parsing and path shape', () => {
  it('parses the list_files text: header and cap footer dropped, paths kept', () => {
    const text = '3 files (showing 2):\npackage/src/model-provider.js\npackage/README.md\n... 1 more not shown (total 3). Raise "max" or use a filter.';
    assert.deepEqual(indexPathsFromListFiles(text), ['package/src/model-provider.js', 'package/README.md']);
    assert.deepEqual(indexPathsFromListFiles('No files found'), []);
    assert.deepEqual(indexPathsFromListFiles(''), []);
  });
  it('only path-shaped candidates trigger the lookup', () => {
    assert.equal(looksLikePathRef('src/model-provider.js'), true);
    assert.equal(looksLikePathRef('model.ckpt'), true);
    assert.equal(looksLikePathRef('Portal'), false);
    assert.equal(looksLikePathRef('GPT-4'), false);
  });
  it('the parsed list clears a cited indexed file on a positive table', () => {
    const prose = 'All LLM traffic flows through `model-provider.js`, the central inference layer.';
    const paths = indexPathsFromListFiles('2 files (showing 2):\npackage/src/model-provider.js\npackage/src/settings.js');
    assert.deepEqual(unsupportedModelNames(prose, DECLARED_36, '', paths), []);
  });
});

describe('class D: denials of model ids, and denials of calling against a declared-only table', () => {
  it('modelsUsedDeclaredOnly reads the headline', () => {
    assert.equal(modelsUsedDeclaredOnly(DECLARED_36), 36);
    assert.equal(modelsUsedDeclaredOnly(CALLED_3), 0);
    assert.equal(modelsUsedDeclaredOnly(NEG), 0);
  });
  it('"No model IDs are hardcoded as literals" is contradicted by a declared table, and the note says what the rows are', () => {
    const note = aimlConverseNote(DENIAL, DECLARED_36);
    assert.match(note, /AI\/ML CLAIM CONTRADICTED/);
    assert.match(note, /reports 36 models/);
    assert.match(note, /declared in the code/);
  });
  it('"model identifiers are ... not literal strings" is a denial too', () => {
    const note = aimlConverseNote('Skip models_used here — model identifiers are config-driven at runtime, not literal strings.', DECLARED_36);
    assert.match(note, /CONTRADICTED/);
  });
  it('a denial of CALLING is not contradicted when every row is declared-only', () => {
    assert.equal(aimlConverseNote('The code does not call any AI/ML models at run time.', DECLARED_36), '');
  });
  it('the same denial of calling IS contradicted by a call-site row', () => {
    assert.match(aimlConverseNote('The code does not call any AI/ML models at run time.', CALLED_3), /CONTRADICTED/);
  });
  it('a denial of detection is contradicted by any table (the qwen3-14b shape)', () => {
    assert.match(aimlConverseNote('No AI/ML models are explicitly detected in this index.', DECLARED_36), /CONTRADICTED/);
  });
});

describe('class E: names in a denial sentence are not claims; env-var names are not models', () => {
  it('the Ghost denial sentence on the post-#345 table draws no UNVERIFIED note for Ollama or the env var', () => {
    assert.deepEqual(unsupportedModelNames(DENIAL, DECLARED_36, '', ['package/src/settings.js']), []);
    assert.equal(aimlVerificationNote(DENIAL, DECLARED_36, '', ['package/src/settings.js']), '');
  });
  it('a vendor named in an AFFIRMING sentence is still reported (unchanged breadth)', () => {
    assert.deepEqual(unsupportedModelNames('It uses models including Anthropic.', '1 models used:\nlocal x'), ['Anthropic']);
  });
  it('an ALLCAPS_WITH_UNDERSCORES token is an env var, never a model id', () => {
    const prose = 'The loader reads OPENAI_API_KEY before loading the GPT-4 model.';
    assert.deepEqual(unsupportedModelNames(prose, '1 models used:\nlocal x'), ['GPT-4']);
  });
  it('the tool\'s own name is not a model name', () => {
    assert.ok(!namesInModelSentences('The models_used tool lists the AI models the code loads.').includes('models_used'));
  });
});

// Iterate round 1 (2026-10-14): Andrew re-ran the Claude overview on Ghost with
// the classes above in place. The prose was now RIGHT (it read the declared
// table and said so), and CE footnoted it twice anyway. Shapes under invented
// identifiers; the real text stays local.
const LAYER = '`model-provider.js` (5,700 lines) is the inference layer — it abstracts Ollama, OpenAI-compatible, and relay-hub backends behind a unified `dispatch`/`invokeModel` surface, handling streaming and retry budgets.';
const MENU = 'The model layer declares a large menu of API-hosted models across Anthropic, OpenAI, Google, Mistral, and DeepSeek families, plus local Ollama models (Qwen3, Llama 3.3, Phi-4), all declared but dynamically selected via `getProviderConfig` — none are hardcoded as the sole runtime target.';
const ALIASES = 'The model IDs themselves have version suffixes (e.g., `claude-sonnet-4-6`, `gpt-5`) that look like internal or forward-looking aliases rather than published API names; treat them as examples of a provider-agnostic slot, not as live API identifiers.';
const GHOST_TABLE = '36 models used — 24 api, 12 local; 36 declared only (a literal in code, no call site):\n  api    claude-sonnet-4-6  (declared, 8 sites)\n  api    gpt-5  (declared, 2 sites)\n  api    gemini-2-5-flash  (declared, 1 site)\n  api    deepseek-r1  (declared, 1 site)\n  local  qwen3-coder:30b  (declared, 3 sites)\n  local  llama3.3:70b  (declared, 2 sites)\n  local  phi-4-reasoning  (declared, 1 site)\n  local  mistral-large-latest  (declared, 1 site)';

describe('class F: camelCase code identifiers are not model names', () => {
  it('backticked identifiers in a scanned sentence are not candidates', () => {
    const names = namesInModelSentences(LAYER);
    assert.ok(!names.includes('invokeModel'), JSON.stringify(names));
    assert.ok(!names.includes('getProviderConfig'), JSON.stringify(namesInModelSentences(MENU)));
  });
  it('a bare camelCase identifier is not a candidate either', () => {
    assert.ok(!namesInModelSentences('The AI models are chosen by selectModelForTask at run time.').includes('selectModelForTask'));
  });
  it('a digit-bearing opaque token (the credential case) is still caught', () => {
    const row = AIML.find((c) => c[0] === '.as_ml_code');
    assert.deepEqual(unsupportedModelNames(row[2], row[3]), ['uqDZmUu9Dvqcve5ZcNZdJSmhxu2oSPdJ']);
  });
  it('a backticked plain word is an identifier unless it is a family name', () => {
    const names = namesInModelSentences(LAYER);
    assert.ok(!names.includes('dispatch'), JSON.stringify(names));
    assert.ok(namesInModelSentences('The AI layer loads `llama` and `qwen` models by family.').includes('llama'));
  });
  it('"IDs" and "e.g" in the aliases sentence are vocabulary, not names', () => {
    assert.deepEqual(namesInModelSentences(ALIASES), ['claude-sonnet-4-6', 'gpt-5']);
    assert.deepEqual(unsupportedModelNames(ALIASES, GHOST_TABLE), []);
  });
  it('the whole post-fix overview draws no note at all against its own table', () => {
    const prose = [LAYER, MENU, ALIASES].join('\n');
    assert.equal(aimlVerificationNote(prose, GHOST_TABLE, '', ['model-provider.js']), '');
    assert.equal(aimlConverseNote(prose, GHOST_TABLE), '');
  });
});

describe('class G: a vendor is supported by an id of its family in the table', () => {
  it('Anthropic / OpenAI / Google / Ollama against claude-*, gpt-*, gemini-* and an Ollama tag: nothing to report', () => {
    assert.deepEqual(unsupportedModelNames(MENU, GHOST_TABLE, '', ['model-provider.js']), []);
    assert.equal(aimlVerificationNote([LAYER, MENU].join(' '), GHOST_TABLE, 'dispatch', ['model-provider.js']), '');
  });
  it('a vendor whose family is absent is still reported (.CrewAI: Anthropic and Bedrock against an all-OpenAI table)', () => {
    const row = AIML.find((c) => c[0] === '.CrewAI');
    assert.deepEqual(unsupportedModelNames(row[2], row[3]), ['Anthropic', 'Bedrock']);
  });
  it('Llama, Cohere and Gemma against an OpenAI-plus-gguf table are still reported (.llama_cpp)', () => {
    const row = AIML.find((c) => c[0] === '.llama_cpp');
    assert.deepEqual(unsupportedModelNames(row[2], row[3]), ['Llama', 'Cohere', 'Gemma']);
  });
});

describe('class H: a denial needs the negation beside the topic', () => {
  it('"not as live API identifiers" affirms the ids and is not a denial', () => {
    assert.equal(aimlConverseNote(ALIASES, GHOST_TABLE), '');
  });
  it('"none are hardcoded as the sole runtime target" is consistent with declared-only rows', () => {
    assert.equal(aimlConverseNote(MENU, GHOST_TABLE), '');
  });
  it('the observed denials still fire', () => {
    for (const s of [
      'No AI/ML models are explicitly detected in this index.',
      'The codebase does not explicitly load or call any AI/ML models directly that could be identified.',
      'No model IDs are hardcoded as literals; they are resolved at runtime from user configuration.',
      'Skip models_used here — model identifiers are config-driven at runtime, not literal strings.',
      'The AI models are not called anywhere in this tree.',
    ]) {
      assert.match(aimlConverseNote(s, CALLED_3), /CONTRADICTED/, s);
    }
  });
});

// Iterate round 2 (2026-10-14): the CLI cloud path (`--overview-by-AI --llm
// claude`) on Ghost. The prose was right; the note was extraction junk.
const CLI_DISPATCH = 'Model dispatch (`model-provider.js`, ~5,765 lines) is the centralized LLM call layer.';
const CLI_LIST = 'The declared model list spans Claude variants (Sonnet, Opus, Haiku, Fable — all via API), GPT-4o/GPT-5, Gemini 2.5, Mistral, DeepSeek-r1, and local Ollama models (Qwen3, Llama 3.3/4, Phi-4).';
const CLI_CONST = 'All 36 are declared constants — none have call-site evidence beyond the declaration locations, so which models are live in any given deployment depends on configuration (`getProviderConfig`/`saveProviderConfig`).';
const CLI_CORE = '`model-provider.js@invokeModel` — 864-line core LLM call with retry, streaming, and budget logic; use `digest model-provider.js@invokeModel` for a focused summary before reading source.';
const CLI_TABLE = '36 models used — 24 api, 12 local; 36 declared only (a literal in code, no call site):\n  api    claude-sonnet-4-6  (declared, 8 sites)\n  api    claude-opus-4-8  (declared, 4 sites)\n  api    claude-haiku-4-5  (declared, 2 sites)\n  api    claude-fable-5  (declared, 4 sites)\n  api    gpt-4o  (declared, 2 sites)\n  api    gpt-5  (declared, 2 sites)\n  api    gemini-2-5-flash  (declared, 1 site)\n  api    deepseek-r1  (declared, 1 site)\n  api    mistral-large-latest  (declared, 1 site)\n  local  qwen3-coder:30b  (declared, 3 sites)\n  local  llama3.3:70b  (declared, 2 sites)\n  local  llama-4-maverick  (declared, 1 site)\n  local  phi-4-reasoning  (declared, 1 site)';

describe('class I: extraction junk from the CLI cloud run', () => {
  it('a slash-joined pair is supported when both halves are', () => {
    assert.deepEqual(unsupportedModelNames('The AI models are GPT-4o/GPT-5 and Qwen/Qwen-7B-Chat.', CLI_TABLE + '\n  local  Qwen/Qwen-7B-Chat  (artifact, 1 site)'), []);
    assert.deepEqual(unsupportedModelNames('The AI models are GPT-4o/FakeNet-9.', CLI_TABLE), ['GPT-4o/FakeNet-9']);
  });
  it('trailing punctuation comes off in any order ("Phi-4)." is Phi-4)', () => {
    assert.ok(namesInModelSentences(CLI_LIST).includes('Phi-4'), JSON.stringify(namesInModelSentences(CLI_LIST)));
    assert.ok(!namesInModelSentences(CLI_LIST).some((n) => /[)(.,]$/.test(n)));
  });
  it('a file@function reference and a backticked command are code, not names', () => {
    const names = namesInModelSentences(CLI_CORE);
    assert.ok(!names.some((n) => /@/.test(n) || /^digest/.test(n)), JSON.stringify(names));
  });
  it('"864-line" is English; "70B" is still a candidate', () => {
    assert.ok(!namesInModelSentences(CLI_CORE).includes('864-line'));
    assert.ok(namesInModelSentences('The AI model ships at 70B parameters.').includes('70B'));
  });
  it('the whole CLI run draws no note against its own table', () => {
    const prose = [CLI_DISPATCH, CLI_LIST, CLI_CONST, CLI_CORE].join('\n');
    assert.equal(aimlVerificationNote(prose, CLI_TABLE, '', ['model-provider.js']), '');
    assert.equal(aimlConverseNote(prose, CLI_TABLE), '');
  });
  it('a quoted span with spaces is seen word by word, not dropped', () => {
    assert.ok(namesInModelSentences('The AI model is "FakeNet 9000 Turbo" by the vendor.').includes('FakeNet'));
  });
});

describe('overview-verification-basis-unfiltered: the footer names the unfiltered self-call', () => {
  it('the verification extra says unfiltered', () => {
    const line = toolCallFooter(new Map([['overview', 1], ['models_used', 1]]), { selfCalledModelsUsed: true });
    assert.match(line, /CE ran `models_used` unfiltered for verification/);
  });
});

describe('#320 item 4: the evidentiary footer', () => {
  it('lists tools with counts, sorted by frequency', () => {
    const f = toolCallFooter(new Map([['overview', 1], ['digest', 3], ['search', 1]]));
    assert.match(f, /Based on 5 model tool calls: digest ×3, overview, search\./);
  });
  it('names the paraphrase case in CE voice', () => {
    const f = toolCallFooter(new Map([['overview', 1]]));
    assert.match(f, /rewording of `--overview`, not an independent second view/);
  });
  it('zero calls says nothing came from the index', () => {
    assert.match(toolCallFooter(new Map()), /0 model tool calls — nothing in this overview came from querying the index/);
  });
  it('disclosures ride in the parenthetical', () => {
    const f = toolCallFooter(new Map([['overview', 1], ['stats', 1]]),
      { substituted: ['models_used'], prefetched: true, selfCalledModelsUsed: false });
    assert.match(f, /CE prefetched `overview` itself; CE ran models_used on the model's behalf/);
  });
});
