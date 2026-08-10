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
import { looksLikeRefusal, answerDisclosure, unsupportedModelNames, aimlVerificationNote } from '../src/core/answer-disclosure.js';

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
// FIXTURE PROVENANCE, stated because it is weaker than item 5's: the `models_used`
// columns are asus-CC's VERBATIM measured tool output, but the prose columns are
// RECONSTRUCTED from their summary table, not the captured overviews. So these
// test the comparison mechanism, not the exact wording six models produced. The
// real sentences are worth asking for — that request is what made item 5's
// fixtures catch a design error.
// ---------------------------------------------------------------------------

describe('#306 AI/ML sentence verification', () => {
  // The case that motivates the whole item: ae04e4b made the TOOL correct, and
  // the model wrote over it in the same run.
  it('flags a name asserted when the tool said it found none (.TreeOfThought)', () => {
    const tool = 'No model ids found - do not infer absence. Models USED = ids the code loads or calls as LITERALS…';
    const prose = 'The project uses several AI/ML models, including GPT-4, for reasoning tasks.';
    assert.deepEqual(unsupportedModelNames(prose, tool), ['GPT-4']);
    assert.match(aimlVerificationNote(prose, tool), /AI\/ML SENTENCE UNVERIFIED/);
    // The tool's own output is reproduced, so a reader can see both sides.
    assert.match(aimlVerificationNote(prose, tool), /<models_used>[\s\S]*No model ids found/);
  });

  it('flags the credential fragment — the case the other shape-rules all miss', () => {
    // No digit, no separator, lowercase first char. Only the internal-capitals
    // rule catches it, and it is the reason this item exists.
    const tool = '22 models used - 6 api, 16 local:\nlocal  codellama\nlocal  DeepSeek-R1-Distill';
    const prose = 'The codebase leverages several AI/ML models, including uqDZxxSPdJ, which appears to be local.';
    assert.deepEqual(unsupportedModelNames(prose, tool), ['uqDZxxSPdJ']);
  });

  it('flags vendors asserted as models (.CrewAI)', () => {
    const tool = '4 models used - 4 api, 0 local:\napi  gpt-4o-mini\napi  gpt-4o\napi  text-embedding-ada-002';
    const prose = 'The codebase integrates several AI/ML models through Anthropic and Bedrock providers.';
    assert.deepEqual(unsupportedModelNames(prose, tool), ['Anthropic', 'Bedrock']);
  });

  // THE LOAD-BEARING TESTS. Three of nine corpora were faithful; a verifier that
  // footnotes those is worse than none, because the footnote stops meaning
  // anything. A sentence-final period nearly broke this — `resnet50.` did not
  // match `resnet50` in the tool output.
  it('stays silent when every name IS in the tool output', () => {
    const t1 = '3 models used - 0 api, 3 local:\nlocal  vqgan_imagenet.ckpt\nlocal  dataset.h5\nlocal  resnet50';
    assert.equal(aimlVerificationNote('The code loads models including vqgan_imagenet.ckpt, dataset.h5 and resnet50.', t1), '');
    const t2 = '2 models used - 0 api, 2 local:\nlocal  deepseek_vl_v2\nlocal  deepseek-vl2';
    assert.equal(aimlVerificationNote('It loads models deepseek_vl_v2 and deepseek-vl2 for vision.', t2), '');
  });

  it('substring match tolerates a looser prose form than the exact id', () => {
    // "Qwen 7B" against a listed "Qwen-7B-Chat" must NOT be called unsupported —
    // the question is "did the tool mention this", not "is this the exact id".
    const tool = '2 models used:\nlocal  Qwen-7B-Chat\nlocal  Qwen-72B-Chat';
    assert.deepEqual(unsupportedModelNames('The models are Qwen-7B-Chat and Qwen-72B-Chat variants.', tool), []);
  });

  it('says nothing when models_used was never called — cannot verify, so does not', () => {
    const prose = 'The project uses several AI/ML models, including GPT-4.';
    assert.equal(aimlVerificationNote(prose, ''), '');
    assert.equal(aimlVerificationNote(prose, '   '), '');
  });

  it('only scans sentences that mention models, not the whole overview', () => {
    const tool = '1 models used:\nlocal  resnet50';
    const prose = 'The CLI entry point is src/index.js and the parser is ArgParse.\n'
      + 'It loads models such as resnet50.';
    // ArgParse / src/index.js are in a NON-model sentence and must not be flagged.
    assert.deepEqual(unsupportedModelNames(prose, tool), []);
  });

  it('reports rather than classifies — the note disclaims judgement', () => {
    const note = aimlVerificationNote('It uses models including Anthropic.', '1 models used:\nlocal  x');
    assert.match(note, /mechanical comparison, not a judgement/);
    assert.match(note, /may be a vendor or framework rather than a model/);
  });
});
