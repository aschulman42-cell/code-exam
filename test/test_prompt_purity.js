// test_prompt_purity.js — CI guard: shipped prompts must carry NO knowledge of
// any particular codebase or problem domain.
//
// WHY THIS EXISTS. CE's claim commands are validated against corpora the
// assistant developing them happens to know (ExoPlayer, ffmpeg). During that
// work, three separate probes were later found contaminated: hand-picked
// "representative" search stems, a hand-built multisect query, and hand-chosen
// example words — each unknowingly seeded with the expected answer, each
// producing a false success. The live prompts were clean, but only by
// inspection, and inspection does not survive future edits.
//
// So: assert mechanically that no domain vocabulary reaches a model through a
// STATIC prompt template. A prompt that names `bitrate` while examining a
// streaming codebase is not asking the model what it knows — it is telling it
// the answer, and any result becomes unfalsifiable.
//
// SCOPE. This checks the fixed template text authors write, not the runtime
// arguments (claim text, source code, vocabulary concordances, symbol
// candidates), which SHOULD carry domain content — that is the data under
// examination. Builders are therefore invoked with neutral placeholder args.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiscoverPrompt, buildSelectPrompt, buildProposePrompt, buildRefinePrompt,
  buildHuntPrompt,
} from '../src/commands/claim-locate.js';
import { buildClaimAnalyzePrompt, buildAnalyzePrompt } from '../src/commands/analyze.js';

// Vocabulary from the domains CE has been developed against. If a template
// mentions any of these, an author has leaked the corpus into the question.
const DOMAIN_TERMS = [
  // streaming / media (ExoPlayer, ffmpeg)
  'adaptive', 'bitrate', 'bit rate', 'code rate', 'codec', 'transcode', 'streaming',
  'playback', 'buffer', 'chunk', 'manifest', 'dash', 'hls', 'mpeg', 'h264',
  'video', 'audio', 'player', 'renderer', 'track selection', 'throughput',
  // specific projects
  'exoplayer', 'androidx', 'media3', 'ffmpeg', 'libav', 'x265', 'chromium',
  'zlib', 'bram', 'codeexam',
  // other domains CE has been pointed at
  'tls', 'cipher', 'handshake', 'certificate',
];

// Neutral placeholders: nothing here may hint at a domain either.
const NEUTRAL = {
  profile: 'Symbols indexed: 3\nLanguages (by symbol count): ext\nRepresentative packages/directories: dir/sub',
  perElement: [{ element: 1, text: 'a claim element', hits: [{ sym: { name: 'Alpha::beta', filepath: 'dir/Alpha.ext' }, matched: ['beta'] }] }],
  notFound: [{ candidate: 'Gamma::delta' }],
  table: [{ name: 'Alpha::beta', bare: 'beta', filepath: 'dir/Alpha.ext', tokens: ['alpha', 'beta'] }],
  source: 'function beta() { return 1; }',
};

const PROMPTS = {
  'claim-locate discover (step 1)': () => buildDiscoverPrompt(),
  'claim-locate hunt': () => buildHuntPrompt(),
  'claim-locate select (step 3)': () => buildSelectPrompt(NEUTRAL.perElement, { blind: true }),
  'claim-locate propose (legacy)': () => buildProposePrompt(NEUTRAL.profile),
  'claim-locate refine': () => buildRefinePrompt(NEUTRAL.notFound, NEUTRAL.table),
  'claim-analyze rubric': () => buildClaimAnalyzePrompt(NEUTRAL.source, 'beta', 'dir/Alpha.ext', 'A method, comprising: doing a thing.', false),
  'analyze': () => buildAnalyzePrompt(NEUTRAL.source, 'beta', 'dir/Alpha.ext', false),
};

describe('prompt purity — no domain knowledge in shipped templates', () => {
  for (const [label, build] of Object.entries(PROMPTS)) {
    it(`${label} names no domain vocabulary`, () => {
      const text = build().toLowerCase();
      const leaked = DOMAIN_TERMS.filter((t) => text.includes(t));
      assert.deepEqual(leaked, [],
        `${label} leaks domain term(s): ${leaked.join(', ')}. A prompt that names the ` +
        'examined domain tells the model the answer and makes any result unfalsifiable. ' +
        'Put domain content in the runtime arguments (claim text, source, candidates), never the template.');
    });
  }

  it('the step-1 prompt states the model is not told the codebase', () => {
    // The load-bearing property of the discovery design: step 1 must be
    // answerable without knowing which codebase is under examination, or the
    // command cannot work on confidential code with no training presence.
    assert.match(buildDiscoverPrompt(), /NOT told which codebase/i);
  });

  it('the hunt prompt states the model is not told the codebase', () => {
    // Same load-bearing property as step 1, and more so: the hunt's whole
    // premise is that the model finds the code by searching rather than by
    // recognizing a repository it was trained on.
    assert.match(buildHuntPrompt(), /NOT told which codebase/i);
  });

  it('the hunt prompt never invites the model to answer from memory', () => {
    // A hunt that can be satisfied from priors is not a hunt. The prompt must
    // bind every named symbol to something a tool actually returned.
    assert.match(buildHuntPrompt(), /Never name a symbol you have not seen in a result/i);
  });

  // WHY A VOCABULARY FILTER IS NOT ENOUGH, and why the test that used to sit
  // here was replaced rather than extended (#317).
  //
  // The old assertion re-ran DOMAIN_TERMS over buildDiscoverPrompt -- the same
  // scan the loop above already runs over every prompt. The one test written
  // specifically to catch example leaks therefore added no coverage at all, and
  // it showed: both prompts shipped `determineIdealSelectedIndex`, a real
  // function in AdaptiveTrackSelection.java from the corpus CE is measured
  // against, and every check passed.
  //
  // It passed because the symbol decomposes into determine / ideal / selected /
  // index -- four generic words. A REAL SYMBOL BUILT FROM GENERIC WORDS CANNOT
  // BE CAUGHT BY A WORD LIST, and never will be. So the check inverts: any
  // identifier-shaped token in a prompt must be on an allowlist, and anything
  // unrecognised fails closed. Adding an example then costs one deliberate
  // line here, which is the review moment this guard exists to create.
  const NEUTRAL_EXAMPLE_SYMBOLS = new Set([
    'redactSensitiveField', // #317: replaced determineIdealSelectedIndex, invented domain
    'someMethod', 'exactName', 'realMethod',
    'validateRecord', 'maxRetryCount',
  ]);
  // camelCase with at least one internal capital. Measured across all seven
  // prompts when written: it found exactly the six placeholders above plus the
  // one leak, and nothing else -- no false positives to suppress.
  const IDENTIFIER_SHAPED = /\b[a-z][a-z0-9]*(?:[A-Z][a-zA-Z0-9]*)+\b/g;

  for (const [label, build] of Object.entries(PROMPTS)) {
    it(`${label} names no symbol outside the neutral allowlist`, () => {
      const found = [...new Set(String(build()).match(IDENTIFIER_SHAPED) || [])];
      const rogue = found.filter((t) => !NEUTRAL_EXAMPLE_SYMBOLS.has(t));
      assert.deepEqual(rogue, [],
        `${label} names symbol(s) not on the neutral allowlist: ${rogue.join(', ')}. `
        + 'A prompt naming a real symbol primes the answer on the corpus it came from '
        + 'and ships an unrelated codebase to every other user. If the symbol is '
        + 'invented, add it to NEUTRAL_EXAMPLE_SYMBOLS deliberately.');
    });
  }

  it('the guard fails on the symbol that got past it', () => {
    // Provenance check, not a soak: this guard reads zero forever when it is
    // working, and a dead one reads zero identically. So fire it on purpose,
    // with the exact string that shipped in two prompts and passed everything.
    const leaked = 'a function called determineIdealSelectedIndex, and';
    const found = [...new Set(leaked.match(IDENTIFIER_SHAPED) || [])];
    const rogue = found.filter((t) => !NEUTRAL_EXAMPLE_SYMBOLS.has(t));
    assert.deepEqual(rogue, ['determineIdealSelectedIndex'],
      'the check must reject the real symbol that the vocabulary filter allowed');
  });

  it("catches the '101 claim's own spelling, which the word list had missed", () => {
    // DOMAIN_TERMS carried bitrate and bit rate; the claim says "code rate".
    assert.ok(DOMAIN_TERMS.includes('code rate'));
    const leaked = 'a claim reading "a code rate DETERMINING unit"'.toLowerCase();
    assert.ok(DOMAIN_TERMS.some((t) => leaked.includes(t)), 'code rate must now leak-fail');
  });
});
