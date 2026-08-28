// #301 — `--no-claim-filter`: send the codebase's own vocabulary instead of its
// intersection with patent-ese.
//
// MEASURED 2026-08-10 on US 8,752,101 x .AndroidX_Media_ExoPlayer3. The target
// function's parameters are `bufferedDurationUs` / `availableDurationUs`; inside
// it /Duration/ appears on 9 lines and /remaining/ on none. The claim says
// "remaining time" and "available reproduction time", so `duration` is not a
// claim keyword — and the filter removed it, for 196 characters of budget:
//
//   FILTERED   8354 chars -> `duration` ABSENT
//   UNFILTERED 8550 chars -> `duration` PRESENT
//
// Never shown the word, the extractor guessed `bufferDuration` (one missing
// "ed"), the function scored 6/13 against a quorum of 7, and the implementation
// was excluded by ONE TERM.
//
// These tests pin the OPTIONS DECISION, which is the part that has repeatedly
// been applied to only some of the three call sites. The behavioural comparison
// is a live run against a real index and is recorded in the commit, not here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { vocabConcordanceOptions, extractFirstClaim } from '../src/commands/claim.js';

// #311 step 3 (issue-311-dep-claim-input): the local-model first-claim cut used to call every claim
// numbered >= 2 "dependent". It now classifies through dep-claims.js and reports what it dropped.
describe('extractFirstClaim classifies what it skips', () => {
  it('two independent claims in one file: the second is reported as an INDEPENDENT claim dropped, not a dependent', () => {
    const text = '1. A method comprising heating a substrate.\n\n8. An apparatus comprising a heater and a substrate holder.\n\n15. A method of cooling a substrate.';
    const r = extractFirstClaim(text);
    assert.equal(r.selected, 1);
    assert.equal(r.skipped, 2);
    assert.equal(r.skippedDependent, 0);
    assert.equal(r.skippedIndependent, 2, 'the old code called these dependents');
    assert.ok(r.text.includes('heating a substrate') && !r.text.includes('heater'));
  });
  it('a mixed file counts dependents and independents apart', () => {
    const text = '1. A method comprising heating a substrate.\n2. The method of claim 1, wherein the substrate is silicon.\n3. An apparatus comprising a heater.';
    const r = extractFirstClaim(text);
    assert.equal(r.skipped, 2);
    assert.equal(r.skippedDependent, 1);
    assert.equal(r.skippedIndependent, 1);
  });
  it('a single claim is returned untouched with nothing skipped', () => {
    const text = '1. A method comprising:\n    step A;\n    step B.';
    const r = extractFirstClaim(text);
    assert.equal(r.text, text);
    assert.equal(r.skipped, 0);
    assert.equal(r.skippedIndependent, 0);
  });
});

const KW = new Set(['transmission', 'reproduction', 'storage']);

describe('#301 vocabConcordanceOptions', () => {
  it('filters by claim keywords by default — unchanged shipped behaviour', () => {
    const r = vocabConcordanceOptions({ args: {}, localModelPath: null, claimKeywords: KW });
    assert.equal(r.unfiltered, false);
    assert.equal(r.options.claimKeywords, KW);
  });

  it('drops the filter under --no-claim-filter, which is the whole change', () => {
    const r = vocabConcordanceOptions({ args: { no_claim_filter: true }, localModelPath: null, claimKeywords: KW });
    assert.equal(r.unfiltered, true);
    assert.equal(r.options.claimKeywords, undefined,
      'passing the keywords is what severs the bridge — they must be absent, not empty');
  });

  it('reports which arm ran, so a log line cannot claim the wrong one', () => {
    // The first cut of this change printed "claim-filtered" while the flag was
    // set, on the command Andrew was running. The flag and the message now come
    // from the same value.
    assert.equal(vocabConcordanceOptions({ args: { no_claim_filter: true } }).unfiltered, true);
    assert.equal(vocabConcordanceOptions({ args: {} }).unfiltered, false);
  });

  it('keeps the local-model budget split intact', () => {
    const cloud = vocabConcordanceOptions({ args: {}, localModelPath: null, claimKeywords: KW }).options;
    const local = vocabConcordanceOptions({ args: {}, localModelPath: 'x.gguf', claimKeywords: KW }).options;
    assert.equal(cloud.maxSubTokens, 150);
    assert.equal(cloud.maxFuncNames, 40);
    assert.equal(local.maxSubTokens, 80);
    assert.equal(local.maxFuncNames, 0, 'local prompts carry no function names');
    assert.equal(cloud.topN, 15000);
    assert.equal(local.topN, 15000, 'topN is build-time only, not a prompt-budget knob');
  });

  it('tolerates a missing args object rather than throwing at a call site', () => {
    assert.equal(vocabConcordanceOptions({}).unfiltered, false);
    assert.equal(vocabConcordanceOptions({ args: null }).unfiltered, false);
  });
});

// The reason this helper exists at all. Three sites request the concordance and
// every previous change to its shape reached a subset:
//   aa2bdc9  missed claims-loop.js — optional chaining hid it from the audit grep
//   #301 v1  missed analyze.js, so --no-claim-filter did nothing on --claim-analyze
describe('#301 one definition, not three', () => {
  it('both cloud sites call the shared helper and neither builds its own options', async () => {
    const fs = await import('node:fs');
    for (const p of ['src/commands/claim.js', 'src/commands/analyze.js']) {
      const src = fs.readFileSync(p, 'utf8');
      assert.ok(src.includes('vocabConcordanceOptions({'), `${p} does not use the shared helper`);
      // A literal `claimKeywords,` shorthand in a formatVocabularyForPrompt call
      // is the old hand-rolled shape — that is what diverged.
      const call = src.indexOf('formatVocabularyForPrompt(');
      const window = src.slice(call, call + 400);
      assert.ok(!/^\s*claimKeywords,\s*$/m.test(window),
        `${p} still hand-rolls the options object`);
    }
  });
});

// The failure this file could not catch, and now can.
//
// The refactor to the shared helper left `vocabConcordanceOptions` out of
// analyze.js's import list. Every unit test still passed — the helper works in
// isolation — while the real command threw ReferenceError inside a `catch` that
// is silent without --verbose. The concordance vanished and the suite said green.
//
// A live run caught it. This asserts the import statically so a green suite
// means the call sites can actually reach what they call.
describe('#301 the shared helper is imported where it is used', () => {
  it('every file calling vocabConcordanceOptions also imports or defines it', async () => {
    const fs = await import('node:fs');
    for (const p of ['src/commands/claim.js', 'src/commands/analyze.js']) {
      const src = fs.readFileSync(p, 'utf8');
      if (!src.includes('vocabConcordanceOptions({')) continue;   // not a caller
      const defines = /export function vocabConcordanceOptions\b/.test(src);
      const imports = /import\s*\{[^}]*\bvocabConcordanceOptions\b[^}]*\}\s*from/s.test(src);
      assert.ok(defines || imports,
        `${p} calls vocabConcordanceOptions but neither defines nor imports it`);
    }
  });
});
