// test_synonymize.js — synonymizer: prompt build, marker/punctuation restore, overlap, corpus-arg guards
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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
  stripClaimComments, detectClaims, looksLikeWholeClaim, claimArgProblem,
  CLAIMS_PER_LINE_MARKER, doSynonymize, artifactProblem,
} from '../src/commands/synonymize.js';
// The PRODUCTION module must not import this (analyze.js reaches the index);
// the test imports both so the duplicated comment-strip cannot drift.
import { readClaimFile } from '../src/commands/analyze.js';
import { splitClaimElements } from '../src/commands/claim-locate.js';
import { fileURLToPath } from 'node:url';
// Fixtures resolve from THIS FILE, never from the working directory. A bare
// readFileSync('name.txt') resolves against cwd, which is what made these
// files' absence invisible to anyone running npm test from the repo root
// with them already sitting there (#314).
const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));

const DEMO_CLAIM = fs.readFileSync(fixture('sample_patent_claim.txt'), 'utf8');
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
      // A provenance STRING under test, not a path to read — it must stay the
      // short recorded name, or the assertion becomes machine-dependent.
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
    const stripped = DEMO_ELEMENTS.map((e) => e.replace(/[;,]\s*$/, ''));
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

describe('HOF-b: the model\'s own punctuation does not override the source', () => {
  // MEASURED (Gemini, 2026-08-16, after the marker fix). The model ended several
  // limitations with '.' where the source had ';'. The first version of the
  // restore loop skipped any rewrite already ending in punctuation, read those
  // periods as "already punctuated", and restored only 2 of 6 semicolons -- so
  // the claim still collapsed on rewrap, 11 elements to 6. Deferring to the
  // model's punctuation was the same mistake as deferring to its markers, one
  // layer on: A CLAIM IS ONE SENTENCE, so a period anywhere but the end is wrong.
  const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ');

  // Apply the production rule to a set of rewrites. Mirrors doSynonymize.
  function applyTerminators(rewrites, terms) {
    return rewrites.map((cur, i) => {
      const t = terms[i];
      if (!t || cur.endsWith(t)) return cur;
      const own = cur.match(/([;,:.])\s*$/);
      if (own) {
        if (i === rewrites.length - 1 && own[1] === '.') return cur;
        return cur.replace(/[;,]\s*$/, '') + t;
      }
      return cur + t;
    });
  }

  it('replaces a mid-claim period with the source terminator', () => {
    const terms = terminatorsFor(DEMO_CLAIM, DEMO_ELEMENTS);
    const periodEnding = DEMO_ELEMENTS.map((e) => e.replace(/[;,]\s*$/, '') + '.');
    const fixed = applyTerminators(periodEnding, terms);
    const srcSemis = (DEMO_CLAIM.match(/;/g) || []).length;
    assert.equal((periodEnding.join('\n').match(/;/g) || []).length, 0, 'baseline: model gave none');
    assert.equal((fixed.join('\n').match(/;/g) || []).length, srcSemis,
      'every source semicolon must be recovered despite the model supplying periods');
  });

  it('and that restores rewrap survivability, which the old rule did not', () => {
    const terms = terminatorsFor(DEMO_CLAIM, DEMO_ELEMENTS);
    const periodEnding = DEMO_ELEMENTS.map((e) => e.replace(/[;,]\s*$/, '') + '.');
    const fixed = applyTerminators(periodEnding, terms);
    const target = splitClaimElements(oneLine(DEMO_CLAIM)).length;
    assert.equal(splitClaimElements(oneLine(fixed.join('\n'))).length, target);
    assert.ok(splitClaimElements(oneLine(periodEnding.join('\n'))).length < target,
      'the unfixed version must be measurably worse, or this proves nothing');
  });

  it('leaves the FINAL period alone — it is the sentence ending', () => {
    const terms = terminatorsFor(DEMO_CLAIM, DEMO_ELEMENTS);
    const periodEnding = DEMO_ELEMENTS.map((e) => e.replace(/[;,]\s*$/, '') + '.');
    const fixed = applyTerminators(periodEnding, terms);
    assert.match(fixed[fixed.length - 1], /\.$/, 'a claim ends in a period');
  });

  it('does not touch a rewrite that already matches the source', () => {
    const terms = terminatorsFor(DEMO_CLAIM, DEMO_ELEMENTS);
    const already = DEMO_ELEMENTS.map((e, i) => (terms[i] ? e.replace(/[;,]\s*$/, '') + terms[i] : e));
    assert.deepEqual(applyTerminators(already, terms), already);
  });
});

describe('HOF-b: the stray-comma repair, wired at the one site holding the pair', () => {
  // THE THIRD STRUCTURAL FAILURE MODE, and the only one that cannot be fixed by
  // strip-before-and-restore-after: the rewrite ADDS a boundary rather than
  // dropping one. The comma is inside prose the model was asked to rewrite.
  //
  // MEASURED on sample_patent_claim_synon_gemini_NEW.txt, generated AFTER the
  // marker and punctuation fixes: Gemini wrote element (a) with ", and
  // incorporating" where the source reads "... version and loading ..." -- same
  // word, no comma. BOUNDARY_RE cuts at /,\s*and\s+/, so the claim went from 11
  // rows to 12 and the re-split guard flagged the comparison unsafe.

  it('repairs the REAL recorded Gemini rewrite: 12 rows back to 11', async () => {
    const gem = fs.readFileSync(fixture('sample_patent_claim_synon_gemini_NEW.txt'), 'utf-8')
      .split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    let i = 0;
    const replay = () => Promise.resolve(
      gem[i++].replace(/^\s*\(\s*(?:[a-z]|[ivx]+|\d+)\s*\)\s*/i, ''));
    const rows = await synonymizeElements({ draft: replay, elements: DEMO_ELEMENTS });
    assert.deepEqual(rows.filter((r) => r.repaired).map((r) => r.n), [2],
      'element 2 is where Gemini introduced the comma');
    assert.equal(splitClaimElements(rows.map((r) => r.rewritten).join('\n')).length,
      DEMO_ELEMENTS.length, 'the skeleton is restored');
  });

  it('leaves a GENUINE ", and" boundary alone — the regression that matters', async () => {
    // `, and` is a real limitation boundary; Part III names it as "often a good
    // place to divide". Repairing blind would MERGE limitations a claim
    // deliberately separated, which is worse than the defect being fixed.
    const original = ['initializing a first module configured to do one thing, and '
      + 'loading a second module configured to do another thing here'];
    const rewrite = () => Promise.resolve('establishing a primary component arranged to '
      + 'perform one function, and provisioning a secondary component arranged to perform another');
    const rows = await synonymizeElements({ draft: rewrite, elements: original });
    assert.equal(rows[0].repaired, false, 'the source already split here');
    assert.match(rows[0].rewritten, /,\s+and\s+provisioning/, 'the comma survives');
  });

  it('reports the repair per row and in the summary — never silent', async () => {
    const gem = fs.readFileSync(fixture('sample_patent_claim_synon_gemini_NEW.txt'), 'utf-8')
      .split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
    let i = 0;
    const replay = () => Promise.resolve(
      gem[i++].replace(/^\s*\(\s*(?:[a-z]|[ivx]+|\d+)\s*\)\s*/i, ''));
    const seen = [];
    await synonymizeElements({ draft: replay, elements: DEMO_ELEMENTS, onElement: (r) => seen.push(r) });
    assert.equal(seen.filter((r) => r.repaired).length, 1,
      'the flag must reach the caller, which is what drives the stderr line');
  });

  it('provenance records repairs ONLY when there were any', () => {
    // A line saying "0 repaired" on every run trains the reader to skip it, and
    // this one has to be noticed when it appears.
    const withRepairs = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: 'c.txt', elements: 11, failed: 0, meanOverlap: 10,
      reSplit: 11, repairs: 2, argv: 'ce', ceVersion: '1', generatedAt: 'now',
    });
    assert.match(withRepairs, /# Repaired:\s+2 element\(s\)/);
    const none = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: 'c.txt', elements: 11, failed: 0, meanOverlap: 10,
      reSplit: 11, repairs: 0, argv: 'ce', ceVersion: '1', generatedAt: 'now',
    });
    assert.ok(!/# Repaired:/.test(none), 'silence when there is nothing to say');
  });

  it('a rewrite with no comma at all is untouched', async () => {
    const rows = await synonymizeElements({ draft: rewriter, elements: DEMO_ELEMENTS });
    assert.equal(rows.filter((r) => r.repaired).length, 0);
  });
});

// ---------------------------------------------------------------------------
// HOF: reading a CORPUS, not just a claim.
//
// Every failure tested below was hit on a real run (Andrew, iOS 8.1 headers):
// `--synonymize ios81_pseudo.txt` -- no '@' -- synonymized the FILENAME, and
// `--synonymize @ios81_pseudo.txt` split the human artifact into 171 "elements"
// and began rewriting the legal disclaimer one model call at a time.

describe('HOF-b: the bare argument that cost a run', () => {
  it('rejects a path-shaped argument and names the fix', () => {
    const problem = claimArgProblem('ios81_pseudo.txt');
    assert.ok(problem, 'a filename is not claim text');
    assert.match(problem, /@ios81_pseudo\.txt/, 'the error must name the @ form, not just complain');
  });

  it('rejects a path with separators too', () => {
    assert.match(claimArgProblem('out/claims.txt'), /@out\/claims\.txt/);
    assert.match(claimArgProblem('C:\\work\\claims.txt'), /Did you mean/);
  });

  it('accepts @file and real inline claim text — the regression this could cause', () => {
    assert.equal(claimArgProblem('@sample_patent_claim.txt'), null);
    assert.equal(claimArgProblem(DEMO_CLAIM.slice(0, 200)), null,
      'inline claim text must still work; the guard is not allowed to break it');
  });

  it('a short bare word is rejected with the OTHER message', () => {
    // Same rule as --claim-analyze (analyze.js:1495): inline text needs a space
    // and more than 30 chars. A short word is neither a path nor a claim.
    const problem = claimArgProblem('claim');
    assert.ok(problem && !/Did you mean/.test(problem), 'no @ suggestion for something path-unlike');
  });
});

describe('HOF-b: one claim, or one claim per line', () => {
  const CLAIM_A = 'A method for protecting a lattice linkage, comprising: establishing a dialogue '
    + 'with a remote node; and conveying a payload over the established dialogue.';
  const CLAIM_B = 'A system for indexing a repository, comprising: a parser configured to read '
    + 'source files; and a store configured to persist the parsed symbols.';

  it('the format marker is authoritative — no heuristic involved', () => {
    const raw = `# Format:     one claim per line\n${CLAIM_A}\n${CLAIM_B}\n`;
    const { claims, mode } = detectClaims(raw);
    assert.equal(mode, 'marker');
    assert.deepEqual(claims, [CLAIM_A, CLAIM_B]);
  });

  it('detects a corpus structurally when every line is a whole claim', () => {
    const { claims, mode } = detectClaims(`${CLAIM_A}\n${CLAIM_B}\n`);
    assert.equal(mode, 'structural');
    assert.equal(claims.length, 2);
  });

  it('a HARD-WRAPPED single claim stays ONE claim — the expensive misread', () => {
    // sample_patent_claim.txt is 28 physical lines for 11 elements. Reading it
    // as 28 claims is the failure that produced 171 model calls; requiring
    // EVERY line to be a whole claim is what prevents it.
    const { claims, mode } = detectClaims(DEMO_CLAIM);
    assert.equal(mode, 'single');
    assert.equal(claims.length, 1);
  });

  it('and a real multi-claim ARTIFACT is not mistaken for a corpus either', () => {
    // The pseudo-claims artifact has prose, headings and tables around its
    // claims. Those lines are not whole claims, so the strict rule collapses it
    // to single-claim reading — wrong, but LOUDLY wrong (one call, not 171),
    // and --claims-only is the supported path.
    const artifact = `# PSEUDO-CLAIMS — illustrative drafting exercise\n\n`
      + `The material below consists of pseudo patent claims.\n\n`
      + `## Pseudo-claim 1\n\n${CLAIM_A}\n\n### Cited anchors (3 grounded)\n`
      + `- \`Foo.h@bar\` — L11-34\n`;
    const { claims } = detectClaims(artifact);
    assert.equal(claims.length, 1, 'no silent 171-way split');
  });

  it('--claims-per-line forces the corpus reading for a hand-made file', () => {
    const { claims, mode } = detectClaims(`${CLAIM_A}\n${CLAIM_B}\n`, { force: 'multi' });
    assert.equal(mode, 'forced-multi');
    assert.equal(claims.length, 2);
  });

  it('--single-claim forces the other way', () => {
    const { claims, mode } = detectClaims(`${CLAIM_A}\n${CLAIM_B}\n`, { force: 'single' });
    assert.equal(mode, 'forced-single');
    assert.equal(claims.length, 1);
  });

  it('looksLikeWholeClaim keys off STRUCTURE, not length', () => {
    assert.ok(looksLikeWholeClaim(CLAIM_A));
    assert.ok(!looksLikeWholeClaim('wherein the second module is configured to '
      + 'perform the described operation upon receipt of the signal'),
      'a long continuation line is not a claim: no preamble transition + colon');
    assert.ok(!looksLikeWholeClaim('A method, comprising: x'), 'too short to be a claim');
  });
});

describe('HOF-b: `#` comments, and the copy that must not drift', () => {
  it('strips comment lines exactly as readClaimFile does', () => {
    // DUPLICATED ON PURPOSE — synonymize.js cannot import analyze.js, which
    // reaches the index. The equivalence is checked rather than trusted, so the
    // two copies cannot drift apart silently. The test may import both.
    const cases = [
      '# header\nA method, comprising: doing a thing; and doing another.',
      'no comments at all here\nsecond line',
      '# only\n# comments\n',
      '  # indented comment\nkept',
      'A method\r\nwith CRLF\r\nand no comments',
    ];
    const tmp = 'test/.tmp-claim-comments.txt';
    for (const c of cases) {
      fs.writeFileSync(tmp, c, 'utf8');
      assert.equal(stripClaimComments(c), readClaimFile(tmp),
        `stripClaimComments diverged from readClaimFile on: ${JSON.stringify(c)}`);
    }
    fs.unlinkSync(tmp);
  });

  it('preserves CRLF when there is nothing to strip', () => {
    // Rejoining unconditionally normalises CRLF to LF, and the claim files on
    // this project are Windows-authored.
    const crlf = 'A method\r\nwith CRLF';
    assert.ok(stripClaimComments(crlf).includes('\r\n'));
  });

  it('reports how many lines it dropped', () => {
    let dropped = 0;
    stripClaimComments('# a\n# b\nclaim text', { onComments: (n) => { dropped = n; } });
    assert.equal(dropped, 2);
  });
});

describe('HOF-b: a corpus run reports PER CLAIM', () => {
  const mk = (n, reSplit, elements = 3) => ({ n, elements, reSplit, failed: 0 });

  it('names WHICH claim broke, not just that one did', () => {
    // An aggregate "171 became 172" does not say where to look, and can hold
    // while one claim gained a row and another lost one.
    const prov = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: 'c.txt', elements: 9, failed: 0, meanOverlap: 12,
      reSplit: 3, argv: 'ce', ceVersion: '1', generatedAt: 'now',
      perClaim: [mk(1, 3), mk(2, 4), mk(3, 3)],
    });
    assert.match(prov, /Re-split:\s+2 of 3 preserved/);
    assert.match(prov, /claim 2 \(3 → 4\)/, 'the broken claim must be named');
  });

  it('says so plainly when every claim held', () => {
    const prov = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: 'c.txt', elements: 9, failed: 0, meanOverlap: 12,
      reSplit: 3, argv: 'ce', ceVersion: '1', generatedAt: 'now',
      perClaim: [mk(1, 3), mk(2, 3), mk(3, 3)],
    });
    assert.match(prov, /Re-split:\s+all 3 preserved/);
  });

  it('carries the format marker, so the OUTPUT round-trips as input', () => {
    const prov = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: 'c.txt', elements: 6, failed: 0, meanOverlap: 12,
      reSplit: 3, argv: 'ce', ceVersion: '1', generatedAt: 'now',
      perClaim: [mk(1, 3), mk(2, 3)],
    });
    assert.ok(CLAIMS_PER_LINE_MARKER.test(prov),
      'a corpus written out must be readable back in without a flag');
    assert.equal(detectClaims(`${prov}\nclaim one text\nclaim two text\n`).mode, 'marker');
  });

  it('the SINGLE-claim provenance is untouched — no marker, no claim count', () => {
    const prov = buildSynonymizeProvenance({
      engineLabel: 'x', claimSource: 'c.txt', elements: 11, failed: 0, meanOverlap: 12,
      reSplit: 11, argv: 'ce', ceVersion: '1', generatedAt: 'now',
    });
    assert.ok(!CLAIMS_PER_LINE_MARKER.test(prov));
    assert.ok(!/# Claims:/.test(prov));
    assert.match(prov, /# Synonymized claim — HOF-b/);
  });
});

// ---------------------------------------------------------------------------
// END TO END. The unit tests above cover the pieces; this exercises the command
// the way Andrew ran it, because every defect in this item was a piece that
// worked in isolation and was bypassed or misfed on the real path.

describe('HOF-b: --synonymize over a corpus, end to end', () => {
  const CLAIM_A = 'A method for protecting a lattice linkage, comprising: establishing a dialogue '
    + 'with a remote node; conveying a payload over the established dialogue; and closing the '
    + 'dialogue after the payload has been conveyed.';
  const CLAIM_B = 'A system for indexing a repository, comprising: a parser configured to read '
    + 'source files; and a store configured to persist the parsed symbols for later retrieval.';
  const CORPUS = `# Format:     one claim per line\n# Claims:     2\n${CLAIM_A}\n${CLAIM_B}\n`;

  const TMP = 'test/.tmp-corpus.txt';
  const OUT = 'test/.tmp-corpus-out.txt';
  const cleanup = () => { for (const f of [TMP, OUT]) if (fs.existsSync(f)) fs.unlinkSync(f); };

  // A drafter that TAGS each rewrite with the element it saw, so misordering or
  // cross-claim bleed is visible in the output rather than inferred.
  const makeTagged = () => {
    const seen = [];
    const draft = (sys, user) => {
      const body = user.replace(/^LIMITATION:\n/, '').trim();
      seen.push(body);
      return Promise.resolve(body.replace(/[A-Za-z]+/g, (w) => REGISTER.get(w.toLowerCase()) || w));
    };
    return { draft, seen };
  };

  const runArgs = (extra = {}) => ({
    synonymize: `@${TMP}`, synonymize_out: OUT,
    llm: null, model: null, temperature: 0, ...extra,
  });

  it('rewrites every claim, ONE PER LINE, in order', async (t) => {
    process.env.CE_OPENAI_API_URL = 'http://127.0.0.1:1/v1';
    t.after(() => { delete process.env.CE_OPENAI_API_URL; cleanup(); });
    fs.writeFileSync(TMP, CORPUS, 'utf8');
    const { draft, seen } = makeTagged();
    const res = await doSynonymize(runArgs(), { draft });

    assert.ok(res, 'the command must not bail');
    assert.equal(res.claims.length, 2);
    assert.equal(res.isCorpus, true);
    assert.equal(res.mode, 'marker');

    const body = fs.readFileSync(OUT, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(body.length, 2, 'one claim per line out, matching one claim per line in');

    // ORDER IS THE GUARANTEE SCORING DEPENDS ON: claim i is compared against
    // key i, so a run that reorders or drops silently poisons every later row.
    assert.match(body[0], /lattice/, 'claim 1 stays first');
    assert.match(body[1], /repository/, 'claim 2 stays second');

    // And no claim's elements leaked into another's.
    assert.ok(!/repository/.test(body[0]) && !/lattice/.test(body[1]));
    assert.equal(seen.length, res.rows.length, 'one model call per element, no more');
  });

  it('makes ONE call per element — not one per line of the artifact', async (t) => {
    process.env.CE_OPENAI_API_URL = 'http://127.0.0.1:1/v1';
    t.after(() => { delete process.env.CE_OPENAI_API_URL; cleanup(); });
    fs.writeFileSync(TMP, CORPUS, 'utf8');
    const { draft, seen } = makeTagged();
    const res = await doSynonymize(runArgs(), { draft });
    const expected = res.claims.reduce((n, c) => n + c.elements, 0);
    assert.equal(seen.length, expected, `${expected} elements, ${seen.length} calls`);
    // The disclaimer-rewriting run made 171 calls for 13 claims. Two claims of
    // three and two elements is five, and nothing about the file's other lines
    // may add to it.
    assert.ok(seen.length < 10, `a two-claim corpus must not cost ${seen.length} calls`);
  });

  it('each claim re-splits to its OWN element count', async (t) => {
    process.env.CE_OPENAI_API_URL = 'http://127.0.0.1:1/v1';
    t.after(() => { delete process.env.CE_OPENAI_API_URL; cleanup(); });
    fs.writeFileSync(TMP, CORPUS, 'utf8');
    const { draft } = makeTagged();
    const res = await doSynonymize(runArgs(), { draft });
    for (const c of res.claims) {
      assert.equal(c.reSplit, c.elements, `claim ${c.n} skeleton must hold on its own terms`);
    }
  });

  it('the output ROUND-TRIPS: read it back and get the same claim count', async (t) => {
    process.env.CE_OPENAI_API_URL = 'http://127.0.0.1:1/v1';
    t.after(() => { delete process.env.CE_OPENAI_API_URL; cleanup(); });
    fs.writeFileSync(TMP, CORPUS, 'utf8');
    const { draft } = makeTagged();
    await doSynonymize(runArgs(), { draft });
    const back = detectClaims(fs.readFileSync(OUT, 'utf8'));
    assert.equal(back.mode, 'marker', 'no flag needed to read our own output');
    assert.equal(back.claims.length, 2);
  });

  it('a SINGLE claim still writes one ELEMENT per line — unchanged behaviour', async (t) => {
    process.env.CE_OPENAI_API_URL = 'http://127.0.0.1:1/v1';
    t.after(() => { delete process.env.CE_OPENAI_API_URL; cleanup(); });
    fs.writeFileSync(TMP, DEMO_CLAIM, 'utf8');
    const { draft } = makeTagged();
    const res = await doSynonymize(runArgs(), { draft });
    assert.equal(res.isCorpus, false);
    const out = fs.readFileSync(OUT, 'utf8');
    const body = out.split('\n').filter((l) => l && !l.startsWith('#'));
    assert.equal(body.length, DEMO_ELEMENTS.length,
      'the single-claim format is one element per line, so it feeds back in via --elements');
    assert.ok(!CLAIMS_PER_LINE_MARKER.test(out), 'and carries no corpus marker');
  });

  it('refuses --elements against a corpus rather than applying one construction to all', async (t) => {
    process.env.CE_OPENAI_API_URL = 'http://127.0.0.1:1/v1';
    const code = process.exitCode;
    t.after(() => { delete process.env.CE_OPENAI_API_URL; cleanup(); process.exitCode = code; });
    fs.writeFileSync(TMP, CORPUS, 'utf8');
    const { draft, seen } = makeTagged();
    const res = await doSynonymize(runArgs({ elements: '@some-elements.txt' }), { draft });
    assert.equal(res, undefined, 'the command must bail');
    assert.equal(seen.length, 0, 'and must not spend a single call first');
  });

  it('rejects the missing-@ argument before reading or spending anything', async (t) => {
    const code = process.exitCode;
    t.after(() => { process.exitCode = code; });
    const { draft, seen } = makeTagged();
    const res = await doSynonymize({ synonymize: 'ios81_pseudo.txt' }, { draft });
    assert.equal(res, undefined);
    assert.equal(seen.length, 0, 'the guard fires before the model is even resolved');
  });
});

describe('HOF-b: the human artifact, pointed at the wrong command', () => {
  // Refusing to mis-split the artifact into a corpus is not the same as
  // refusing to read it: single-claim fallback still splits it into 144
  // elements and still bills 144 calls. MEASURED on the real file.
  const ARTIFACT = fs.existsSync('ios81_pseudo.txt')
    ? fs.readFileSync('ios81_pseudo.txt', 'utf8') : null;

  it('recognises the artifact by its OWN structure, not its filename', () => {
    const synthetic = `# PSEUDO-CLAIMS — illustrative drafting exercise, NOT legal analysis\n\n`
      + `The material below consists of pseudo patent claims.\n\n`
      + `## Pseudo-claim 1 — address book\n\nA method, comprising: a; and b.\n\n`
      + `## Pseudo-claim 2 — media\n\nA system, comprising: c; and d.\n`;
    const problem = artifactProblem(synthetic);
    assert.ok(problem, 'the artifact must be refused');
    assert.match(problem, /--claims-only/, 'and the error must name the supported path');
    assert.match(problem, /2 `## Pseudo-claim` heading/);
  });

  it('refuses the REAL ios81_pseudo.txt', { skip: !ARTIFACT }, () => {
    assert.ok(artifactProblem(ARTIFACT), 'the file that produced the 171-call run');
  });

  it('and a plain claim file is NOT refused — the regression that matters', () => {
    assert.equal(artifactProblem(DEMO_CLAIM), null);
    assert.equal(artifactProblem('# header\nA method, comprising: a; and b.'), null,
      'a `#` provenance header is not an artifact heading');
  });

  it('a claims-only file is not refused either', () => {
    const claimsOnly = `# Pseudo-claims — illustrative drafting exercise, NOT legal analysis.\n`
      + `# Format:     one claim per line\n`
      + `A method for x, comprising: doing a thing; and doing another thing here.\n`
      + `A system for y, comprising: a part configured to act; and a store to persist.\n`;
    assert.equal(artifactProblem(claimsOnly), null,
      'the machine format must pass; it is the whole point of the fix');
  });

  it('--single-claim overrides, for someone who means it', async (t) => {
    const code = process.exitCode;
    t.after(() => { process.exitCode = code; });
    // The guard is skipped, so the run proceeds far enough to fail on the
    // MISSING MODEL rather than on the artifact check.
    const res = await doSynonymize(
      { synonymize: 'A method, comprising: a; and b. ## Pseudo-claim 1\n## Pseudo-claim 2', single_claim: true },
      { draft: () => Promise.resolve('x') });
    assert.equal(res, undefined, 'no model configured, so it still bails — but not on the artifact guard');
  });
});
