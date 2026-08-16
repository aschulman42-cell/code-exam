// HOF-b synonymizer. Rewrite a claim's wording AWAY from code vocabulary, so a
// corpus whose answers we already know becomes a real test of retrieval.
//
// TEST SHAPE. Inputs come from the REAL claim files and the REAL splitter, and
// only the model call is stubbed. The per-element arm shipped a helper whose
// test passed strings where production passed objects, and the helper took a
// different branch in production for months; hand-shaped input is the trap.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildSynonymizePrompt, buildSynonymizeProvenance, cleanRewrite, contentWords,
  synonymizeElements, vocabularyOverlap, SYNONYMIZE_DEFAULTS, terminatorsFor,
} from '../src/commands/synonymize.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';

const DEMO_CLAIM = fs.readFileSync('sample_patent_claim.txt', 'utf8');
const DEMO_ELEMENTS = splitClaimElements(DEMO_CLAIM);

// A stub that genuinely re-registers rather than inflecting, which is what the
// prompt asks for and what asus-CC measured morphology failing to do.
const REGISTER = new Map(Object.entries({
  secure: 'protected', communication: 'correspondence', connection: 'linkage',
  network: 'lattice', cryptographic: 'cipherbased', certificate: 'attestation',
  transmitting: 'conveying', channel: 'conduit', session: 'dialogue',
  cipher: 'encipherment', handshake: 'greeting', hostname: 'designation',
}));
const rewriter = (sys, user) => {
  const body = user.replace(/^LIMITATION:\n/, '');
  return Promise.resolve(body.replace(/[A-Za-z]+/g, (w) => REGISTER.get(w.toLowerCase()) || w));
};

describe('HOF-b: the element skeleton survives, by construction', () => {
  it('returns exactly one row per element, in order', async () => {
    const rows = await synonymizeElements({ draft: rewriter, elements: DEMO_ELEMENTS });
    assert.equal(rows.length, DEMO_ELEMENTS.length);
    assert.deepEqual(rows.map((r) => r.n), DEMO_ELEMENTS.map((_, i) => i + 1));
  });

  it('the rewritten claim re-splits to the SAME element count', async () => {
    // The whole validation is a before/after retrieval comparison. If the
    // rewrite changed how the claim splits, that comparison would confound
    // vocabulary change with structure change and neither could be attributed.
    const rows = await synonymizeElements({ draft: rewriter, elements: DEMO_ELEMENTS });
    const rebuilt = rows.map((r) => r.rewritten).join('\n');
    assert.equal(splitClaimElements(rebuilt).length, DEMO_ELEMENTS.length,
      'a rewrite that changes the row count invalidates the comparison it exists to enable');
  });

  it('a FAILED element keeps its original text rather than dropping out', async () => {
    // A claim missing a limitation is not a harder claim; it is a different and
    // invalid one, and silently shortening it corrupts every downstream number.
    let n = 0;
    const flaky = (sys, user) => (++n === 2
      ? Promise.reject(new Error('engine exploded'))
      : rewriter(sys, user));
    const rows = await synonymizeElements({ draft: flaky, elements: DEMO_ELEMENTS });
    assert.equal(rows.length, DEMO_ELEMENTS.length);
    assert.equal(rows[1].error, 'engine exploded');
    assert.equal(rows[1].rewritten, DEMO_ELEMENTS[1], 'the original must survive a failure');
    assert.equal(rows[0].error, null, 'one failure must not abort the rest');
  });

  it('treats a suspiciously short answer as a failure, not a terse rewrite', async () => {
    const lazy = () => Promise.resolve('ok');
    const rows = await synonymizeElements({ draft: lazy, elements: DEMO_ELEMENTS });
    assert.ok(rows.every((r) => r.error), 'every element should be flagged');
    assert.ok(/too short/.test(rows[0].error));
    assert.deepEqual(rows.map((r) => r.rewritten), DEMO_ELEMENTS);
  });
});

describe('HOF-b: the overlap measure is what says whether anything happened', () => {
  it('scores a genuine re-registering as low overlap', async () => {
    const rows = await synonymizeElements({ draft: rewriter, elements: DEMO_ELEMENTS });
    const scored = rows.filter((r) => !r.error);
    const mean = scored.reduce((n, r) => n + r.overlap.pct, 0) / scored.length;
    assert.ok(mean < 90, `expected the stub to displace some vocabulary, got ${mean.toFixed(1)}%`);
  });

  it('scores an identity rewrite as 100% — the failure this must catch', async () => {
    // A model that returns the input unchanged produces a claim that is not
    // harder at all, and the downstream comparison would read as a success.
    const identity = (sys, user) => Promise.resolve(user.replace(/^LIMITATION:\n/, ''));
    const rows = await synonymizeElements({ draft: identity, elements: DEMO_ELEMENTS });
    assert.ok(rows.every((r) => r.overlap.pct === 100), 'identity must score 100%');
  });

  it('ignores claim boilerplate, which every claim shares', () => {
    const o = vocabularyOverlap(
      'a method comprising transmitting content data wherein said content is coded',
      'an apparatus comprising conveying informational payload wherein said payload is encoded');
    assert.ok(!o.survivors.includes('comprising'), 'boilerplate must not count as survival');
    assert.ok(!o.survivors.includes('wherein'));
    assert.ok(!contentWords('a method comprising wherein said').size, 'pure boilerplate has no content words');
  });

  it('reports WHICH words survived, so a failure is diagnosable', () => {
    const o = vocabularyOverlap('transmitting content data over a secure channel',
                                'conveying content data across a protected conduit');
    assert.deepEqual(o.survivors.sort(), ['content', 'data']);
    assert.equal(o.total, 5);
  });

  it('is not fooled by mere inflection — the measured failure mode', () => {
    // asus-CC, #307: expanding six words to 24 morphological variants moved the
    // target not at all. `selector` -> `selection` is the same word.
    const o = vocabularyOverlap('a selector estimating the scheduling policy',
                                'selectors estimated by scheduled policies');
    assert.equal(o.survivors.length, 0,
      'stem-level overlap is invisible to a word-level measure — so the measure alone cannot detect inflection-only rewrites');
  });
});

describe('HOF-b: output contract', () => {
  it('cleanRewrite strips framing without touching content', () => {
    assert.equal(cleanRewrite('```\nthe thing\n```'), 'the thing');
    assert.equal(cleanRewrite('Rewritten: the thing'), 'the thing');
    assert.equal(cleanRewrite('"the whole thing"'), 'the whole thing');
    assert.equal(cleanRewrite('a "partial" quote'), 'a "partial" quote', 'inner quotes are content');
    assert.equal(cleanRewrite('  spaced   out  '), 'spaced out');
    assert.equal(cleanRewrite(null), '');
  });

  it('the prompt names both registers and forbids inflection-only rewrites', () => {
    const p = buildSynonymizePrompt();
    assert.match(p, /patent-claim register/i);
    assert.match(p, /inflect/i, 'the measured failure mode must be named in the prompt');
    assert.match(p, /selector.*selection/i, 'and given the concrete example');
    assert.match(p, /terms of art/i, 'moving TOWARD code vocabulary is the opposite goal');
  });

  it('provenance records the engine, since HOF-b assumes a DIFFERENT model', () => {
    const p = buildSynonymizeProvenance({
      engineLabel: 'local GGUF — gemma-3-12b-it-Q4_K_M.gguf (local LLM, no network egress)',
      claimSource: 'sample_patent_claim.txt', elements: 11, failed: 0, meanOverlap: 12.5,
      argv: 'ce --synonymize @x.txt', ceVersion: '1.2.3', generatedAt: '2026-08-16T00:00:00Z',
    });
    assert.match(p, /^# Synonymized claim/m);
    assert.match(p, /NOT a patent claim/, 'the artifact must disclaim itself');
    assert.match(p, /gemma-3-12b/);
    assert.match(p, /12\.5% mean per-element content-word survival/);
    assert.ok(p.split('\n').every((l) => l.startsWith('#')), 'every provenance line must be a comment');
  });

  it('defaults are stated, not magic', () => {
    assert.equal(typeof SYNONYMIZE_DEFAULTS.maxTokensPerElement, 'number');
    assert.ok(SYNONYMIZE_DEFAULTS.maxTokensPerElement >= 200);
  });
});

describe('HOF-b: the code is withheld STRUCTURALLY, not by convention', () => {
  it('the module imports nothing that can read an index', () => {
    // Withholding the code is the mechanism by which the gap is manufactured.
    // A command that CANNOT reach an index cannot leak one by accident, so this
    // is asserted against the source rather than trusted.
    const src = fs.readFileSync('src/commands/synonymize.js', 'utf8');
    const imports = [...src.matchAll(/^import .*?from '([^']+)'/gm)].map((m) => m[1]);
    for (const bad of ['CodeSearchIndex', 'symbol-verify', 'multisect', 'search']) {
      assert.ok(!imports.some((i) => i.includes(bad)),
        `synonymize.js must not import ${bad} — it must not be able to see the code`);
    }
  });

  it('and takes no index argument', () => {
    const src = fs.readFileSync('src/commands/synonymize.js', 'utf8');
    assert.ok(!/args\.index_path/.test(src), 'no index path may be consulted');
    assert.ok(!/doSynonymize\s*\(\s*index/.test(src), 'the entry point takes args, not an index');
  });
});

describe('HOF-b: markers are structure, and a model WILL drop them', () => {
  // MEASURED, first live run (Gemini 2.5 Flash, 2026-08-16). Asked to rewrite
  // "(a) initializing a cryptographic context...", it returned prose with the
  // "(a)" silently gone. Five of eleven elements lost their markers, and because
  // splitClaimElements takes the MARKER path whenever any marker is present --
  // merging unmarked lines into the preceding group -- the eleven-line output
  // re-split to EIGHT. The skeleton this command exists to preserve was
  // destroyed by the rewrite itself.
  const dropsMarker = () => Promise.resolve(
    'completely rephrased limitation text with entirely different wording throughout');

  it('re-attaches a marker the model dropped', async () => {
    const rows = await synonymizeElements({ draft: dropsMarker, elements: DEMO_ELEMENTS });
    const before = DEMO_ELEMENTS.filter((e) => /^\s*\(/.test(e)).length;
    const after = rows.filter((r) => /^\s*\(/.test(r.rewritten)).length;
    assert.equal(before, 8, 'the demo claim has 8 marked elements');
    assert.equal(after, before, 'every dropped marker must be restored');
  });

  it('does not DOUBLE a marker the model kept', async () => {
    const echoes = () => Promise.resolve('(a) some rephrased text long enough to pass the length guard');
    const rows = await synonymizeElements({ draft: echoes, elements: DEMO_ELEMENTS });
    for (const r of rows.filter((x) => /^\s*\(/.test(x.original))) {
      assert.ok(!/^\s*\([a-z ivx0-9]+\)\s*\(/i.test(r.rewritten),
        `doubled marker: ${r.rewritten.slice(0, 40)}`);
    }
  });

  it('scores overlap on the BODY, so the marker cannot flatter the result', async () => {
    const identity = (sys, user) => Promise.resolve(user.replace(/^LIMITATION:\n/, ''));
    const rows = await synonymizeElements({ draft: identity, elements: DEMO_ELEMENTS });
    assert.ok(rows.every((r) => r.overlap.pct === 100));
    // The marker is never a survivor, because it never reaches the scorer.
    assert.ok(rows.every((r) => !r.overlap.survivors.some((w) => /^[ivx]+$/.test(w))));
  });

  it('the SPLIT is idempotent on rejoined elements — so the invariant check is sound', () => {
    // If re-splitting an unmodified claim did not return the original count, the
    // command's own warning would fire on every run and mean nothing.
    assert.equal(splitClaimElements(DEMO_ELEMENTS.join('\n')).length, DEMO_ELEMENTS.length);
  });
});

describe('HOF-b: provenance records whether the skeleton held', () => {
  it('says so when it did', () => {
    const p = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: 'c.txt', elements: 11, failed: 0, meanOverlap: 20,
      reSplit: 11, argv: 'ce', ceVersion: '1', generatedAt: 'now',
    });
    assert.match(p, /# Re-split:\s+11 — preserved/);
  });

  it('and flags the comparison unsafe when it did not', () => {
    const p = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: 'c.txt', elements: 11, failed: 0, meanOverlap: 20,
      reSplit: 8, argv: 'ce', ceVersion: '1', generatedAt: 'now',
    });
    assert.match(p, /8 — CHANGED, comparison unsafe/);
  });

  it('labels the overlap as a per-element MEAN, not a whole-claim figure', () => {
    // The two differ enough to mislead: scoring the claim as one blob counts a
    // word as surviving if it survived ANYWHERE, which is more forgiving.
    const p = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: null, elements: 3, failed: 0, meanOverlap: 14.7,
      reSplit: 3, argv: 'ce', ceVersion: '1', generatedAt: 'now',
    });
    assert.match(p, /mean per-element content-word survival/);
  });
});

describe('HOF-b: terminal punctuation is restored, not preserved', () => {
  // MEASURED, and the first reading was WRONG. All three synonymized claims came
  // back with zero semicolons where the original has six, which looked like
  // "every engine dropped them". It is not: splitClaimElements ends each element
  // with .replace(/[;,]?\s*(?:and)?\s*$/, ''), so a limitation reaches the model
  // as "...credentials", never "...credentials;". The model cannot preserve what
  // it was never shown, so the job is to RESTORE from the source.
  it('recovers the source terminators by LOCATING each element, not by line', () => {
    // A line-indexed version was written first and failed: the real claim file is
    // hard-wrapped mid-sentence -- 28 physical lines, 22 qualifying, for 11
    // elements -- so there is no 1:1 mapping to recover from.
    const t = terminatorsFor(DEMO_CLAIM, DEMO_ELEMENTS);
    assert.equal(t.length, DEMO_ELEMENTS.length);
    const semis = t.filter((x) => x === ';').length;
    assert.equal(semis, (DEMO_CLAIM.match(/;/g) || []).length,
      'every semicolon in the source should be recovered');
  });

  it('returns empty for an element it cannot place, rather than guessing', () => {
    const t = terminatorsFor(DEMO_CLAIM, ['a limitation that appears nowhere in the source text']);
    assert.deepEqual(t, ['']);
  });

  it('RESTORING makes the claim survive being rewrapped, which is the whole point', () => {
    // A claim is one sentence; line breaks are a display convention. Without
    // terminators the claim collapses when pasted from a PDF or an email.
    const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ');
    const t = terminatorsFor(DEMO_CLAIM, DEMO_ELEMENTS);
    const stripped = DEMO_ELEMENTS.map((e) => e.replace(/[;,:.]\s*$/, ''));
    const restored = stripped.map((e, i) => (/[;,:.]$/.test(e) ? e : e + (t[i] || '')));

    const origOneLine = splitClaimElements(oneLine(DEMO_CLAIM)).length;
    assert.equal(splitClaimElements(oneLine(restored.join('\n'))).length, origOneLine,
      'restored claim must rewrap exactly like the original');
    assert.ok(splitClaimElements(oneLine(stripped.join('\n'))).length < origOneLine,
      'and the unrestored one must be measurably worse, or this test proves nothing');
  });

  it('does not double a terminator the rewrite already carries', () => {
    const t = terminatorsFor(DEMO_CLAIM, DEMO_ELEMENTS);
    const already = DEMO_ELEMENTS.map((e, i) => (t[i] ? e + t[i] : e));
    for (let i = 0; i < already.length; i++) {
      if (!t[i]) continue;
      const twice = /[;,:.]$/.test(already[i]) ? already[i] : already[i] + t[i];
      assert.ok(!/;;|,,|\.\./.test(twice), `doubled terminator: ${twice.slice(-12)}`);
    }
  });
});
