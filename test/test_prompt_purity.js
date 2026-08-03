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
} from '../src/commands/claim-locate.js';
import { buildClaimAnalyzePrompt, buildAnalyzePrompt } from '../src/commands/analyze.js';

// Vocabulary from the domains CE has been developed against. If a template
// mentions any of these, an author has leaked the corpus into the question.
const DOMAIN_TERMS = [
  // streaming / media (ExoPlayer, ffmpeg)
  'adaptive', 'bitrate', 'bit rate', 'codec', 'transcode', 'streaming',
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

  it('any worked example in step 1 comes from an unrelated domain', () => {
    // An example is the subtlest leak: illustrating with a streaming example
    // while examining a streaming codebase primes the exact answer.
    const p = buildDiscoverPrompt().toLowerCase();
    if (!p.includes('example')) return;
    for (const t of DOMAIN_TERMS) assert.ok(!p.includes(t), `example leaks '${t}'`);
  });
});
