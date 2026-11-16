// test_toward_code.js — --embed-distance --toward-code with a stub model: the two prompts and what each is given, a failed call keeping the element, the saved rewrites file read back, the sample entries, the option end to end
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// vocab-rewrite-to-embed-distance (2026-11-16). No model is called here: `draft` is a
// stub, and the vocabulary reader is replaced where an index would be needed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TOWARD_CODE_FORMS, TOWARD_CODE_DEFAULTS, parseTowardCode, buildTowardCodePrompt, buildTowardCodeUser,
  sampleEntryTexts, rewriteElements, rewriteFilePath, formatRewriteFile, readRewriteFile, towardCodeHeader, towardCode,
} from '../src/commands/toward-code.js';

const ELEMENTS = ['a first unit for doing a thing to the data', 'a second unit configured to change the thing'];
const CLAIM = '1. A system, comprising:\na first unit for doing a thing to the data; and\na second unit configured to change the thing.';
const VOCAB = ['alpha', 'beta', 'gamma'];
const entry = (label, names) => ({ id: label, label, members: names.map((name) => ({ name, file: 'dir/a.ext' })) });

/** Run `fn` with stderr and stdout captured; returns what was written. */
async function quiet(fn) {
  const ew = process.stderr.write, ow = console.log, er = console.error;
  const cap = { err: '', out: '' };
  process.stderr.write = (s) => { cap.err += s; return true; };
  console.log = (...a) => { cap.out += a.join(' ') + '\n'; };
  console.error = (...a) => { cap.err += a.join(' ') + '\n'; };
  try { cap.result = await fn(); } finally { process.stderr.write = ew; console.log = ow; console.error = er; }
  return cap;
}

describe('--toward-code: what it takes', () => {
  it('takes restate, label or @file, and says so on anything else', () => {
    assert.deepEqual(TOWARD_CODE_FORMS, ['restate', 'label']);
    assert.deepEqual(parseTowardCode('restate'), { form: 'restate' });
    assert.deepEqual(parseTowardCode('label'), { form: 'label' });
    assert.deepEqual(parseTowardCode('@saved.txt'), { file: 'saved.txt' });
    assert.throws(() => parseTowardCode('paraphrase'), /takes restate or label, or @<file>.*got "paraphrase"/);
    assert.throws(() => parseTowardCode('@'), /takes restate or label/);
  });
});

describe('--toward-code: the prompts', () => {
  it('the restate prompt asks for one sentence with the same requirement; the label prompt for an entry in the samples\' shape', () => {
    const r = buildTowardCodePrompt('restate');
    assert.match(r, /ONE sentence/);
    assert.match(r, /Add\s+no feature it does not state/);
    assert.ok(!r.includes('SAMPLE ENTRIES'), 'the restate form is shown no entries');
    const l = buildTowardCodePrompt('label');
    assert.match(l, /catalog entry you would expect/);
    assert.match(l, /not chosen for this claim: do not copy one/);
  });

  it('both prompts make the vocabulary a hint and not a whitelist, and tell the model the text is only a search query', () => {
    for (const form of TOWARD_CODE_FORMS) {
      const p = buildTowardCodePrompt(form);
      assert.match(p, /Do not use a word because it is listed/, form);
      assert.match(p, /You may use any engineering term, listed or not/, form);
      assert.match(p, /write what this element itself\s+requires, not what the claim as a whole is about/, form);
      assert.match(p, /used only to\s+search/, form);
      assert.match(p, /never\s+read as the claim/, form);
    }
  });

  it('the user message carries the claim, the whole vocabulary and the element last; a specification only when given, first', () => {
    const u = buildTowardCodeUser({ element: ELEMENTS[0], claim: CLAIM, vocabulary: VOCAB, form: 'restate' });
    assert.ok(u.startsWith('WHOLE CLAIM:\n1. A system'), u.slice(0, 60));
    assert.ok(u.includes('CODEBASE VOCABULARY (3 words from the names in this codebase, the most characteristic first):\nalpha, beta, gamma'));
    assert.ok(u.endsWith(`ELEMENT:\n${ELEMENTS[0]}`));
    assert.ok(!u.includes('PATENT SPECIFICATION'));
    const s = buildTowardCodeUser({ element: ELEMENTS[0], claim: CLAIM, vocabulary: VOCAB, spec: '  The thing is a widget.  ', form: 'restate' });
    assert.ok(s.startsWith('PATENT SPECIFICATION:\nThe thing is a widget.\n\nWHOLE CLAIM:'), s.slice(0, 80));
    assert.ok(s.endsWith(`ELEMENT:\n${ELEMENTS[0]}`));
  });

  it('sample entries go to the label form only; a typed text has no WHOLE CLAIM; no vocabulary says so', () => {
    const samples = ['one: a, b', 'two: c'];
    assert.ok(buildTowardCodeUser({ element: 'e', vocabulary: VOCAB, samples, form: 'label' }).includes('SAMPLE ENTRIES (2, taken at regular intervals through the catalog):\none: a, b\ntwo: c'));
    assert.ok(!buildTowardCodeUser({ element: 'e', vocabulary: VOCAB, samples, form: 'restate' }).includes('SAMPLE ENTRIES'));
    assert.ok(!buildTowardCodeUser({ element: 'e', vocabulary: VOCAB }).includes('WHOLE CLAIM'));
    assert.ok(buildTowardCodeUser({ element: 'e', vocabulary: [] }).includes('CODEBASE VOCABULARY:\n(none available)'));
  });

  it('sample entries are taken at even steps by position, as the text the ranking embeds, at most n of them, the same every time', () => {
    const entries = Array.from({ length: 100 }, (_, i) => entry(`label${i}`, [`doThing${i}`, `undoThing${i}`]));
    const s = sampleEntryTexts(entries, 10);
    assert.equal(s.length, 10);
    assert.equal(s[0], 'label0: do Thing0, undo Thing0');
    assert.equal(s[1], 'label10: do Thing10, undo Thing10');
    assert.deepEqual(sampleEntryTexts(entries, 10), s);
    assert.equal(sampleEntryTexts(entries.slice(0, 3), 40).length, 3, 'a small index gives what it has');
    assert.deepEqual(sampleEntryTexts([], 40), []);
    const long = sampleEntryTexts([entry('big', Array.from({ length: 8 }, (_, i) => `aVeryLongFunctionNameNumber${i}OfTheEntry`))], 1)[0];
    assert.ok(long.length <= TOWARD_CODE_DEFAULTS.sampleChars && long.endsWith('…'), long);
  });
});

describe('--toward-code: the rewrites', () => {
  it('one call per element, each given the form\'s prompt and its own element; the answer is cleaned to one line', async () => {
    const seen = [];
    const draft = async (sys, user, max) => { seen.push({ sys, user, max }); return '"Compute the widget\n  from the gadget."'; };
    const rows = await rewriteElements({ draft, elements: ELEMENTS, claim: CLAIM, vocabulary: VOCAB, form: 'restate' });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].sys, buildTowardCodePrompt('restate'));
    assert.ok(seen[1].user.endsWith(`ELEMENT:\n${ELEMENTS[1]}`));
    assert.equal(seen[0].max, TOWARD_CODE_DEFAULTS.maxTokens);
    assert.deepEqual(rows[0], { original: ELEMENTS[0], rewritten: 'Compute the widget from the gadget.', error: null });
  });

  it('a failed call, an empty answer or a too-short one keeps the element as written and says why', async () => {
    const answers = [() => { throw new Error('HTTP 529 overloaded'); }, () => '', () => 'NONE'];
    let i = 0;
    const rows = await rewriteElements({ draft: async () => answers[i++](), elements: ['first element text', 'second element text', 'third element text'], vocabulary: VOCAB });
    assert.deepEqual(rows.map((r) => r.rewritten), ['first element text', 'second element text', 'third element text']);
    assert.equal(rows[0].error, 'HTTP 529 overloaded');
    assert.equal(rows[1].error, 'the model returned nothing');
    assert.match(rows[2].error, /too short to be a rewrite \("NONE"\)/);
  });

  it('the saved file is named for the form, the specification and the index, and sits beside the claim', () => {
    assert.equal(rewriteFilePath(path.join('dir', 'claim_1.txt'), { form: 'label', indexPath: '.MyIndex', spec: false }), path.join('dir', 'claim_1.toward-code-label.MyIndex.txt'));
    assert.equal(rewriteFilePath('claim_1.txt', { form: 'restate', indexPath: path.join('x', '.MyIndex'), spec: true }), 'claim_1.toward-code-restate-spec.MyIndex.txt');
  });

  it('the saved file reads back as the same rewrites, a failed element marked; another element count is refused', () => {
    const rows = [
      { original: ELEMENTS[0], rewritten: 'compute the widget from the gadget', error: null },
      { original: ELEMENTS[1], rewritten: ELEMENTS[1], error: 'HTTP 529' },
    ];
    const text = formatRewriteFile({ rows, form: 'restate', engine: 'stub engine', indexPath: '.MyIndex', claimSource: 'claim.txt', vocabularyCount: 3, generatedAt: '2026-11-16T00:00:00.000Z' });
    assert.ok(text.startsWith('# --toward-code restate: 2 elements of claim.txt reworded toward the names of .MyIndex\n# by stub engine, 2026-11-16T00:00:00.000Z; given 3 vocabulary words, no specification\n'), text);
    assert.ok(text.includes(`# element 1 as written: ${ELEMENTS[0]}\ncompute the widget from the gadget\n`));
    assert.ok(text.includes('# element 2 was not reworded (HTTP 529); the line below is the element as written'));
    assert.ok(text.includes('not a reading of the claim'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toward-code-'));
    const file = path.join(dir, 'saved.txt');
    fs.writeFileSync(file, text);
    const back = readRewriteFile(file, ELEMENTS);
    assert.deepEqual(back.map((r) => r.rewritten), rows.map((r) => r.rewritten));
    assert.equal(back[0].error, null);
    assert.equal(back[1].error, 'not reworded in the saved file');
    assert.throws(() => readRewriteFile(file, [...ELEMENTS, 'a third']), /holds 2 rewrites and there are 3 elements/);
    const withSpec = formatRewriteFile({ rows, form: 'label', engine: 'e', indexPath: '.I', claimSource: 'c.txt', vocabularyCount: 150, sampleCount: 40, specFile: 'spec.txt' });
    assert.ok(withSpec.includes('given 150 vocabulary words, 40 sample entries, the specification in spec.txt'), withSpec);
  });

  it('the header says the ranking is against a model\'s rewording and what that does not show', () => {
    const h = towardCodeHeader({ form: 'restate', engine: 'stub engine', savedTo: 'c.toward-code-restate.I.txt', failed: 1, n: 9 });
    assert.ok(h.startsWith('--toward-code restate: each element was reworded toward this codebase\'s names by stub engine; 1 of 9 could not be reworded and is searched as written.'), h);
    assert.match(h, /not a reading of the claim/);
    assert.match(h, /does not show that the code practises the element/);
    assert.match(h, /--toward-code @c\.toward-code-restate\.I\.txt reuses them with no model call/);
    assert.ok(towardCodeHeader({ file: 'saved.txt', n: 9 }).startsWith('--toward-code @saved.txt: each element is searched by the rewording saved for it.'));
  });
});

describe('--toward-code: the option, with a stub model and a stub vocabulary', () => {
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toward-code-run-'));
    const claimFile = path.join(dir, 'claim.txt');
    fs.writeFileSync(claimFile, CLAIM);
    const asked = [];
    const vocabulary = (indexPath, opts) => { asked.push({ indexPath, opts }); return { words: VOCAB, totalVocab: 3, fileCount: 1, generated: '2026-11-01T00:00:00.000Z' }; };
    return { dir, claimFile, asked, vocabulary };
  };
  const local = { kind: 'gguf', modelPath: 'stub.gguf' };
  const entries = Array.from({ length: 50 }, (_, i) => entry(`label${i}`, [`doThing${i}`]));

  it('asks for the unfiltered vocabulary, rewrites every element, saves the file beside the claim and returns the rows and a header', async () => {
    const { claimFile, asked, vocabulary, dir } = setup();
    const users = [];
    const cap = await quiet(() => towardCode({ toward_code: 'label' }, { queries: ELEMENTS, claimFile, entries, indexPath: '.MyIndex' },
      { model: local, vocabulary, draft: async (sys, user) => { users.push(user); return 'widget computation: compute Widget, update Gadget'; } }));
    const r = cap.result;
    assert.deepEqual(r.rows.map((x) => x.rewritten), ['widget computation: compute Widget, update Gadget', 'widget computation: compute Widget, update Gadget']);
    assert.equal(asked[0].indexPath, '.MyIndex');
    assert.equal(asked[0].opts.topN, 15000, 'the whole cached vocabulary is split, as --claim-search --no-claim-filter does');
    assert.equal(asked[0].opts.claimKeywords, undefined, 'not filtered by the claim\'s own words');
    assert.equal(asked[0].opts.maxSubTokens, 80, 'a local model gets the shorter list');
    assert.equal(asked[0].opts.maxFuncNames, 0);
    assert.ok(users[0].includes('WHOLE CLAIM:\n1. A system') && users[0].includes('SAMPLE ENTRIES (40,'), 'the claim file and the sample entries reach the label form');
    const saved = path.join(dir, 'claim.toward-code-label.MyIndex.txt');
    assert.ok(fs.existsSync(saved));
    assert.deepEqual(readRewriteFile(saved, ELEMENTS).map((x) => x.rewritten), r.rows.map((x) => x.rewritten));
    assert.ok(r.header.includes(saved));
    assert.match(cap.err, /the model is shown the claim, 3 vocabulary words of \.MyIndex \(from vocabulary\.json, cached 2026-11-01\), 40 sample entries; no source code/);
  });

  it('a cloud model gets the longer list; --spec puts the specification in every call and in the file name', async () => {
    const { claimFile, asked, vocabulary, dir } = setup();
    const specFile = path.join(dir, 'spec.txt');
    fs.writeFileSync(specFile, 'The thing is a widget.');
    const users = [];
    const saved0 = process.env.CE_CLAIMS_COST_GUARD;
    const cap = await quiet(() => towardCode({ toward_code: 'restate', spec: specFile }, { queries: ELEMENTS, claimFile, entries, indexPath: '.MyIndex' },
      { model: { kind: 'cloud', model: 'stub-model', label: 'Stub' }, vocabulary, draft: async (sys, user) => { users.push(user); return 'compute the widget from the gadget'; } }));
    assert.equal(process.env.CE_CLAIMS_COST_GUARD, saved0);
    assert.equal(asked[0].opts.maxSubTokens, 150);
    assert.ok(users.every((u) => u.startsWith('PATENT SPECIFICATION:\nThe thing is a widget.')));
    assert.ok(fs.existsSync(path.join(dir, 'claim.toward-code-restate-spec.MyIndex.txt')));
    assert.match(cap.err, /# projected cost: .*toward-code \(2 calls\)/);
    assert.match(cap.err, /and the specification \(.*spec\.txt, 22 characters, in every call\)/);
  });

  it('--show-prompt prints the system prompt and one user message per element and calls no model', async () => {
    const { claimFile, vocabulary } = setup();
    let called = 0;
    const cap = await quiet(() => towardCode({ toward_code: 'restate', show_prompt: true }, { queries: ELEMENTS, claimFile, entries, indexPath: '.MyIndex' },
      { model: null, vocabulary, draft: async () => { called++; return 'x'; } }));
    assert.deepEqual(cap.result, { shown: true });
    assert.equal(called, 0);
    assert.ok(cap.out.includes('===== SYSTEM PROMPT =====') && cap.out.includes('USER 2/2 — element 2'), cap.out.slice(0, 300));
  });

  it('with @file it makes no model call and needs no model; a typed text is reworded and nothing is saved', async () => {
    const { claimFile, vocabulary, dir } = setup();
    const saved = path.join(dir, 'saved.txt');
    fs.writeFileSync(saved, '# a comment\nfirst rewrite\nsecond rewrite\n');
    const a = await quiet(() => towardCode({ toward_code: `@${saved}` }, { queries: ELEMENTS, claimFile, entries, indexPath: '.MyIndex' }, { model: null, vocabulary: () => { throw new Error('not read'); } }));
    assert.deepEqual(a.result.rows.map((x) => x.rewritten), ['first rewrite', 'second rewrite']);
    assert.ok(a.result.header.startsWith(`--toward-code @${saved}:`));
    const before = fs.readdirSync(dir).length;
    const b = await quiet(() => towardCode({ toward_code: 'restate' }, { queries: ['one typed element of text'], claimFile: null, entries, indexPath: '.MyIndex' }, { model: local, vocabulary, draft: async () => 'compute the widget' }));
    assert.equal(b.result.rows[0].rewritten, 'compute the widget');
    assert.equal(fs.readdirSync(dir).length, before);
    assert.ok(!b.result.header.includes('saved to'));
  });

  it('says what is wrong and ranks nothing: no model, an unreadable --spec, a vocabulary that is not cached, every call failing', async () => {
    const { claimFile, vocabulary } = setup();
    const ctx = { queries: ELEMENTS, claimFile, entries, indexPath: '.MyIndex' };
    const saved = process.exitCode;
    try {
      const a = await quiet(() => towardCode({ toward_code: 'restate' }, ctx, { model: null, vocabulary }));
      assert.equal(a.result, null);
      assert.match(a.err, /--toward-code: needs a model to write the rewrites: --llm <provider> or --model <gguf>/);
      const b = await quiet(() => towardCode({ toward_code: 'restate', spec: path.join(os.tmpdir(), 'no-such-spec-file.txt') }, ctx, { model: local, vocabulary }));
      assert.equal(b.result, null);
      assert.match(b.err, /--spec .*no-such-spec-file\.txt could not be read/);
      const c = await quiet(() => towardCode({ toward_code: 'restate' }, ctx, { model: local, vocabulary: () => { throw new Error('.MyIndex has no cached vocabulary (vocabulary.json); write it with: ce --ndx .MyIndex --vocabulary'); } }));
      assert.equal(c.result, null);
      assert.match(c.err, /--toward-code: \.MyIndex has no cached vocabulary .* --vocabulary/);
      const d = await quiet(() => towardCode({ toward_code: 'restate' }, ctx, { model: local, vocabulary, draft: async () => { throw new Error('boom'); } }));
      assert.equal(d.result, null);
      assert.match(d.err, /no element could be reworded \(boom\); nothing was ranked/);
      const e = await quiet(() => towardCode({ toward_code: 'sideways' }, ctx, { model: local, vocabulary }));
      assert.equal(e.result, null);
      assert.match(e.err, /--toward-code takes restate or label/);
    } finally { process.exitCode = saved; }
  });
});
