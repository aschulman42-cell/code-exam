// #306 F70 — credential masking at the tool-output seam.
//
// The measured leak: `claude_pto.py:97  API_KEY = "pVJt….uqDZ…SPdJ"` reached an
// Overview as a model name. asus-CC established the path is `search` returning a
// raw source line — no deterministic tool classified it as a model — so the mask
// belongs upstream of every consumer, not at the prose layer.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maskCredentials, hasCredential } from '../src/core/credential-mask.js';
import {
  looksLikeRandomToken, getTopVocabulary, extractConcepts, conceptLabel,
  describeWithheldToken,
} from '../src/core/vocabulary.js';

describe('#306 credential mask — values go, everything else stays', () => {
  it('masks the .as_ml_code shape that caused the leak', () => {
    const out = maskCredentials('claude_pto.py:97:  API_KEY = "pVJtBCU4.uqDZQQQQQQQQSPdJ"');
    // The FINDING survives: file, line, identifier.
    assert.match(out, /claude_pto\.py:97/);
    assert.match(out, /API_KEY/);
    // The value does not.
    assert.doesNotMatch(out, /uqDZ/);
    assert.match(out, /<redacted \d+-char secret>/);
  });

  it('catches the assignment forms the corpora actually use', () => {
    for (const src of [
      'config.py:12:  api_key = "abcdefghijklmnop123"',
      'const cfg = { authToken: "zzzzzzzzzzzzzzzzzzzz" };',
      "SECRET_KEY := 'aaaaaaaaaaaaaaaaaaaaaa'",
      'password = "hunter2hunter2hunter2"',
    ]) assert.ok(hasCredential(src), `missed: ${src}`);
  });

  it('catches vendor key shapes with no assignment context at all', () => {
    for (const src of [
      'curl -H "Bearer sk-abcdefghijklmnopqrstuvwxyz123456"',
      'ghp_abcdefghijklmnopqrstuvwxyz01',
      'AKIAIOSFODNN7EXAMPLE',
      'xoxb-1234567890-abcdefghijkl',
    ]) assert.ok(hasCredential(src), `missed: ${src}`);
  });

  // THE FALSE-POSITIVE TESTS. Entropy alone was rejected as a rule precisely
  // because minified identifiers and hashes are high-entropy and legitimate;
  // masking those would gut every bundled file CE exists to examine.
  it('leaves env-var NAMES alone — that is what referenced_resources reports', () => {
    const src = 'Environment variables (2):\n  OPENAI_API_KEY\n  ANTHROPIC_API_KEY';
    assert.equal(maskCredentials(src), src);
  });

  it('leaves long legitimate identifiers and hashes alone', () => {
    for (const src of [
      'function buildVocabularyFromFilesAndDirectories(index) {',
      'const sha = "e3b0c44298fc1c149afbf4c8996fb924"; // not assigned to a secret name',
      'import { AuthProvider } from "./auth/provider.js";',
      'KEY = "abc"',   // under the 8-char floor
    ]) assert.equal(maskCredentials(src), src, `over-masked: ${src}`);
  });

  it('reports the length so the reader knows what was there', () => {
    assert.match(maskCredentials('token = "0123456789abcdef"'), /<redacted 16-char secret>/);
  });

  it('is inert on empty and non-string input', () => {
    for (const v of ['', null, undefined]) assert.equal(maskCredentials(v), v == null ? '' : v);
  });
});

// The regression that nearly shipped: the mask was added as a wrapper around the
// EXPORT, while the MCP server's own dispatch called the raw switch directly. It
// would have covered importers (overview loop, chat loop, tests) and NOT the MCP
// server — the path Claude Code and Claude Desktop use. Same shape as F67:
// accepted at one site, dropped at the one that matters.
describe('#306 credential mask — reaches the MCP dispatch, not just importers', () => {
  it('the exported handleTool is the masked one, and the raw one is distinct', async () => {
    const mod = await import('../src/mcp-server.js');
    assert.equal(typeof mod.handleTool, 'function');
    assert.equal(typeof mod._handleToolUnmasked, 'function');
    assert.notEqual(mod.handleTool, mod._handleToolUnmasked,
      'export must be the wrapper — if these are the same function nothing is masked');
  });

  it('source has no call to the raw switch outside the wrapper', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync('src/mcp-server.js', 'utf8');
    // Exclude the declaration — `function handleToolRaw(` matches the same
    // pattern as a call, which is what this assertion first tripped over.
    const rawCalls = [...src.matchAll(/(?<!function\s)handleToolRaw\(/g)].length;
    // Exactly one: inside handleTool(). Any other is a path that skips the mask.
    assert.equal(rawCalls, 1, 'handleToolRaw is called somewhere other than the mask wrapper');
  });
});

// ===========================================================================
// #309 PART B — the leak the context-keyed mask cannot reach
//
// The mask above works on `API_KEY = "..."`. It cannot fire on `vocabulary`
// output, because stripping tokens OUT of their lines is that tool's entire
// job: the secret arrives with nothing beside it that looks like a credential.
// So the test has to be a property of the token, and the thresholds below are
// MEASURED across 925,665 tokens rather than chosen -- see the block comment
// on looksLikeRandomToken.
// ===========================================================================
describe('#309 vocabulary withholds random tokens the mask cannot see', () => {
  // The three that were actually sitting in .as_ml_code's vocabulary.
  const SECRETS = [
    'uqDZmUu9Dvqcve5ZcNZdJSmhxu2oSPdJ',
    'Lihvcptf5A9GRIMMs7BP9wiq4KFPlmPh',
    'yzRmwktiLf0DObYHvpxU6mRBKKcjguxV',
  ];

  it('catches every secret that was actually leaking', () => {
    for (const s of SECRETS) {
      assert.ok(looksLikeRandomToken(s), `should withhold ${s}`);
    }
  });

  it('KEEPS the legitimate long tokens measured beside them', () => {
    // This is the real gate. The security half is easy to get right and easy
    // to over-apply; losing domain vocabulary is the expensive failure.
    // Every one of these is a real token from a real index, including the
    // high-entropy ones that entropy ALONE would have eaten.
    const KEEP = [
      'df_claim_train_1M_pre_duplicates_removed_663',   // 4.13 bits/char
      'debug_combined_output_with_allcites_icl_pdpass',
      'OpenSSL_add_all_algorithms',
      'validateCertificateChain',
      'InterpretableNeuralNet',
      'CertificateValidator',
      'gradient_accumulation_steps',
      'get_most_specialized_neurons',
      'determineIdealSelectedIndex',
      'perElementTargetsWithStats',
    ];
    for (const k of KEEP) {
      assert.ok(!looksLikeRandomToken(k), `must NOT withhold legitimate token ${k}`);
    }
  });

  it('a separator alone protects a token, however long and mixed', () => {
    // No base64/base62 payload carries one, and this is what keeps every
    // snake_case and kebab-case identifier safe without consulting entropy.
    assert.ok(!looksLikeRandomToken('uqDZmUu9Dvqcve5Zc_NZdJSmhxu2oSPdJ'));
    assert.ok(!looksLikeRandomToken('uqDZmUu9Dvqcve5Zc-NZdJSmhxu2oSPdJ'));
  });

  it('short tokens are never examined, so ordinary code is untouched', () => {
    assert.ok(!looksLikeRandomToken('AES256'));
    assert.ok(!looksLikeRandomToken('sha1'));
    assert.ok(!looksLikeRandomToken(''));
    assert.ok(!looksLikeRandomToken(null));
  });

  it('withholding is REPORTED, not silent', () => {
    // A filter that drops without saying so is indistinguishable from a corpus
    // that never had the tokens -- the defect this project keeps paying for.
    const vocab = new Map([
      ['authenticate', { score: 90, doc_freq: 3, total_count: 9 }],
      ['handshake', { score: 80, doc_freq: 2, total_count: 5 }],
    ]);
    for (const s of SECRETS) vocab.set(s, { score: 999, doc_freq: 1, total_count: 1 });
    const idx = { _vocabulary: vocab, vocabulary: vocab, files: new Map() };

    let reported = 0;
    const out = getTopVocabulary(idx, 50, null, null, { onFiltered: (k) => { reported += k; } });
    assert.equal(reported, SECRETS.length, 'the count of withheld tokens is handed to the caller');
    const tokens = out.map((e) => e.token);
    for (const s of SECRETS) assert.ok(!tokens.includes(s), 'and the token itself is gone');
    // The point of the whole exercise: the domain terms survive, and the
    // secret does not outrank them despite its far higher score.
    assert.ok(tokens.includes('authenticate'));
    assert.ok(tokens.includes('handshake'));
  });

  it('a secret cannot return as a CONCEPT EXAMPLE, which is the shape it leaked in', () => {
    // The observed output was `uu9dvqcve5zc (uqDZmUu9Dvqcve5ZcNZdJSmhxu2oSPdJ)`:
    // the concept a fragment of the secret, the example the secret entire.
    // Injected entries bypass getTopVocabulary, so the guard is needed here too.
    const entries = [
      { token: 'parseHandshakeRecord', score: 50, doc_freq: 2, total_count: 4, top_files: [] },
      { token: SECRETS[0], score: 999, doc_freq: 1, total_count: 1, top_files: [] },
    ];
    const concepts = extractConcepts({}, { entries, catalog: null, maxConcepts: 15 });
    const rendered = concepts.map(conceptLabel).join(', ');
    for (const s of SECRETS) {
      assert.ok(!rendered.includes(s), `secret must not appear as a concept example: ${rendered}`);
    }
    assert.ok(!/uu9dvqcve5zc/i.test(rendered), 'nor as a fragment concept derived from it');
  });
});

// ===========================================================================
// #309 FOLLOW-UP — the filter loses ~0.15% of real identifiers, and that has
// to be VISIBLE rather than fixed by a guess.
//
// asus-CC's 115-corpus sweep (#315) scanned ~2M tokens: all three secrets
// withheld (0 leaks), and 3 of 1,992 withheld tokens were genuine identifiers.
// I tried four CamelCase-segmentation guards to rescue them; none separates
// them from base62 alphabet constants without fitting to the three specimens.
// So the loss is ACCEPTED and DISCLOSED instead: a redacted fingerprint an
// operator can recognise, that reconstructs nothing.
// ===========================================================================
describe('#309 withheld tokens are inspectable without being leaked', () => {
  const SECRET = 'uqDZmUu9Dvqcve5ZcNZdJSmhxu2oSPdJ';
  const LOST_IDENTIFIER = 'MTScratchpadRTStylusForm';   // real Windows class, .WinAPI_Classic

  it('the fingerprint identifies to an author and reconstructs nothing', () => {
    const d = describeWithheldToken(SECRET);
    assert.equal(d.length, 32, 'length is disclosed — it is not sensitive');
    assert.equal(d.hint, 'uq…dJ', 'first two and last two characters only');
    // The whole point: four characters of a 32-char credential is not a leak.
    assert.ok(!d.hint.includes(SECRET.slice(2, -2)), 'the interior never appears');
    assert.ok(d.entropy > 4, 'the measurement that caused the withholding is shown');
    assert.equal(typeof d.vowelPct, 'number');
    assert.equal(typeof d.upperPct, 'number');
  });

  it('a SHORT token discloses no characters at all', () => {
    // Below 8 chars, two-and-two would be most of the string.
    assert.equal(describeWithheldToken('abc').hint, '…');
  });

  it('an operator can recognise their own lost identifier from the hint', () => {
    // This is the affordance the bare count could not provide: the person who
    // wrote MTScratchpadRTStylusForm sees MT…rm and knows what went missing.
    const d = describeWithheldToken(LOST_IDENTIFIER);
    assert.equal(d.hint, 'MT…rm');
    assert.equal(d.length, 24);
  });

  it('getTopVocabulary hands the caller a fingerprint per withheld token', () => {
    const vocab = new Map([
      ['authenticate', { score: 90, doc_freq: 3, total_count: 9 }],
      [SECRET, { score: 999, doc_freq: 1, total_count: 1 }],
    ]);
    const idx = { _vocabulary: vocab, vocabulary: vocab, files: new Map() };
    let count = 0; let details = null;
    const out = getTopVocabulary(idx, 50, null, null,
      { onFiltered: (k, d) => { count = k; details = d; } });
    assert.equal(count, 1);
    assert.equal(details.length, 1, 'one fingerprint per withheld token');
    assert.equal(details[0].hint, 'uq…dJ');
    assert.ok(!out.map((e) => e.token).includes(SECRET), 'and the token is still gone');
  });

  it('the three known losses are STILL WITHHELD — no guard was shipped', () => {
    // Recorded deliberately. Four segmentation variants were measured and none
    // separated these from base62 alphabet constants; the best rescued 34 of
    // 2,126 withheld tokens across local corpora, almost all of them alphabets.
    // If a guard ever lands, this test is what must be changed on purpose.
    for (const t of ['MTScratchpadRTStylusForm', 'AVDynamicHDRSmpte2094App5', 'CXMLHttpRequest2Callback']) {
      assert.ok(looksLikeRandomToken(t),
        `${t} is a known false positive, still withheld, and now disclosed rather than rescued`);
    }
  });
});
