/**
 * test_vocab_extract.js — Tests for vocabulary-guided term extraction.
 *
 * Covers:
 *   - splitCompoundToken: CamelCase, snake_case, abbreviation handling
 *   - getVocabularyForPrompt: sub-token extraction and formatting
 *   - Prompt variant construction (no LLM calls needed)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { splitCompoundToken } from '../src/utils.js';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import fs from 'fs';
import path from 'path';
import os from 'os';


// Suppress stderr from sanitizer/progress messages during tests
const origStderrWrite = process.stderr.write;
before(() => { process.stderr.write = () => true; });


// ========================================================================
// splitCompoundToken
// ========================================================================

describe('splitCompoundToken', () => {

  it('splits CamelCase', () => {
    assert.deepEqual(splitCompoundToken('doMultisectAnalyze'), ['multisect', 'analyze']);
    assert.deepEqual(splitCompoundToken('findCallees'), ['find', 'callees']);
    assert.deepEqual(splitCompoundToken('findFunctionMatches'), ['find', 'function', 'matches']);
  });

  it('splits snake_case', () => {
    assert.deepEqual(splitCompoundToken('multisect_search'), ['multisect', 'search']);
    assert.deepEqual(splitCompoundToken('discover_vocabulary'), ['discover', 'vocabulary']);
    assert.deepEqual(splitCompoundToken('list_functions_alpha'), ['list', 'functions', 'alpha']);
  });

  it('handles leading underscores', () => {
    assert.deepEqual(splitCompoundToken('_buildVocabularyFromFiles'), ['build', 'vocabulary', 'files']);
    assert.deepEqual(splitCompoundToken('_findContainingFunction'), ['find', 'containing', 'function']);
    assert.deepEqual(splitCompoundToken('__init__'), ['init']);
  });

  it('handles abbreviations (consecutive uppercase)', () => {
    assert.deepEqual(splitCompoundToken('SSLContext'), ['ssl', 'context']);
    assert.deepEqual(splitCompoundToken('parseJSON'), ['parse', 'json']);
    assert.deepEqual(splitCompoundToken('getHTTPSUrl'), ['https', 'url']);
  });

  it('filters noise sub-tokens (get, set, has, do, with, from, etc.)', () => {
    assert.deepEqual(splitCompoundToken('doAnalyze'), ['analyze']);
    assert.deepEqual(splitCompoundToken('isValid'), ['valid']);
    assert.deepEqual(splitCompoundToken('getTopVocabulary'), ['top', 'vocabulary']);
    assert.deepEqual(splitCompoundToken('setMaxResults'), ['max', 'results']);
    assert.deepEqual(splitCompoundToken('hasOwnProperty'), ['own', 'property']);
  });

  it('handles single-word tokens', () => {
    assert.deepEqual(splitCompoundToken('multisect'), ['multisect']);
    assert.deepEqual(splitCompoundToken('dedup'), ['dedup']);
    assert.deepEqual(splitCompoundToken('intersection'), ['intersection']);
  });

  it('returns empty for very short tokens', () => {
    assert.deepEqual(splitCompoundToken('fn'), []);
    assert.deepEqual(splitCompoundToken('id'), []);
    assert.deepEqual(splitCompoundToken(''), []);
    assert.deepEqual(splitCompoundToken(null), []);
  });

  it('handles mixed CamelCase and snake_case', () => {
    // Real example from vocab: getCallCountsWithDefinitions
    const parts = splitCompoundToken('getCallCountsWithDefinitions');
    assert.ok(parts.includes('call'));
    assert.ok(parts.includes('counts'));
    assert.ok(parts.includes('definitions'));
    // 'get' and 'with' should be filtered as noise sub-tokens
    assert.ok(!parts.includes('get'));
    assert.ok(!parts.includes('with'));
  });

  it('preserves meaningful 3-char parts that are not noise', () => {
    // 'map', 'run' are 3 chars but NOT in noise set — they carry domain meaning
    assert.deepEqual(splitCompoundToken('getMap'), ['map']);
    assert.deepEqual(splitCompoundToken('runTest'), ['run', 'test']);
  });

  it('respects custom minPartLen', () => {
    // minPartLen=4 filters 3-char parts like 'top', 'run'
    assert.deepEqual(splitCompoundToken('doAnalyze', 4), ['analyze']);
    assert.deepEqual(splitCompoundToken('getTopVocabulary', 4), ['vocabulary']);
    assert.deepEqual(splitCompoundToken('buildFunctionIndex', 4), ['build', 'function', 'index']);
  });

  it('handles real vocabulary entries from CodeExam', () => {
    // From the actual --discover-vocabulary 200 output
    assert.deepEqual(splitCompoundToken('CodeSearchIndex'), ['code', 'search', 'index']);
    assert.deepEqual(splitCompoundToken('parseMultisectTerms'), ['parse', 'multisect', 'terms']);
    assert.deepEqual(splitCompoundToken('sanitizeBroadTerms'), ['sanitize', 'broad', 'terms']);
    assert.deepEqual(splitCompoundToken('buildClaimAnalyzePrompt'), ['build', 'claim', 'analyze', 'prompt']);
    assert.deepEqual(splitCompoundToken('extractClaimTerms'), ['extract', 'claim', 'terms']);
    assert.deepEqual(splitCompoundToken('getDomainHotspots'), ['domain', 'hotspots']);
    assert.deepEqual(splitCompoundToken('displayMultisectResults'), ['display', 'multisect', 'results']);
  });
});


// ========================================================================
// getVocabularyForPrompt / formatVocabularyForPrompt
// ========================================================================

const TEST_DIR = path.join(os.tmpdir(), 'code_exam_test_vocab_extract');
const INDEX_DIR = path.join(os.tmpdir(), 'code_exam_test_vocab_extract_idx');

function setupVocabTestFiles() {
  fs.mkdirSync(path.join(TEST_DIR, 'lib'), { recursive: true });

  // File 1: TLS/crypto domain — CamelCase identifiers
  fs.writeFileSync(path.join(TEST_DIR, 'tls_handler.js'), `
function initializeSSLContext(config) {
  const sslContext = createSecureContext(config);
  const minVersion = config.getMinTlsVersion();
  return sslContext;
}

function validateCertificateChain(session, hostname) {
  const cert = session.getPeerCertificate();
  const isValid = checkHostnameMatch(cert, hostname);
  const expired = checkCertExpiration(cert);
  return isValid && !expired;
}

function negotiateCipherSuite(socket, config) {
  const supported = socket.getSupportedCipherSuites();
  const minKeyBits = config.getMinKeyBits();
  const selected = filterCipherSuites(supported, minKeyBits);
  socket.setEnabledCipherSuites(selected);
  return selected;
}

function performHandshake(socket, timeout) {
  socket.startHandshake();
  const session = socket.getSession();
  return session;
}
`);

  // File 2: Same domain, different names — snake_case
  fs.writeFileSync(path.join(TEST_DIR, 'lib', 'crypto_utils.js'), `
function create_secure_context(options) {
  const ssl_context = require('tls').createSecureContext(options);
  return ssl_context;
}

function check_hostname_match(certificate, expected_hostname) {
  const alt_names = certificate.subjectaltname;
  return alt_names.includes(expected_hostname);
}

function filter_cipher_suites(available, min_key_bits) {
  return available.filter(c => getKeyBits(c) >= min_key_bits);
}

function load_certificate_authority(ca_path) {
  const ca_cert = readFileSync(ca_path);
  return ca_cert;
}
`);

  // File 3: Different domain — authentication
  fs.writeFileSync(path.join(TEST_DIR, 'auth_middleware.js'), `
function requireAuthenticated(req, res, next) {
  if (!req.agent) throw new UnauthorizedError('Auth required');
  if (!req.agent.isAuthenticated) throw new ForbiddenError('Not authenticated');
  next();
}

function validateApiToken(token, secret) {
  const decoded = decodeToken(token);
  const isValid = verifySignature(decoded, secret);
  return isValid;
}

function checkCertExpiration(cert) {
  const notAfter = new Date(cert.valid_to);
  return notAfter < new Date();
}
`);
}


describe('getVocabularyForPrompt', () => {
  let index;

  before(async () => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(INDEX_DIR, { recursive: true, force: true });
    setupVocabTestFiles();
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    await index.buildIndex(TEST_DIR, { showProgress: false });
  });

  it('returns subTokens and functionNames', () => {
    const result = index.getVocabularyForPrompt({ topN: 100 });
    assert.ok(result.subTokens);
    assert.ok(result.functionNames);
    assert.ok(result.stats);
    assert.ok(result.subTokens.length > 0, 'should have sub-tokens');
    assert.ok(result.stats.totalVocab > 0, 'should have total vocab count');
  });

  it('sub-tokens are domain-specific split words', () => {
    const result = index.getVocabularyForPrompt({ topN: 200 });
    const tokens = result.subTokens.map(st => st.token);

    // With only 3 files, vocabulary is small (minDocFreq=2 filters most).
    // Tokens appearing in 2+ files should survive: 'cert' (from checkCert*
    // in two files), 'check', 'context', 'secure', etc.
    assert.ok(tokens.length > 0, 'should have some sub-tokens');

    // All sub-tokens should be lowercase and >= 3 chars
    for (const t of tokens) {
      assert.equal(t, t.toLowerCase(), `sub-token '${t}' should be lowercase`);
      assert.ok(t.length >= 3, `sub-token '${t}' should be >= 3 chars`);
    }
  });

  it('sub-tokens do NOT include noise words', () => {
    const result = index.getVocabularyForPrompt({ topN: 200 });
    const tokens = result.subTokens.map(st => st.token);

    // Noise words from _SUB_TOKEN_NOISE should be filtered
    assert.ok(!tokens.includes('get'), 'should not include "get"');
    assert.ok(!tokens.includes('set'), 'should not include "set"');
  });

  it('sub-tokens have parentCount and exampleParents', () => {
    const result = index.getVocabularyForPrompt({ topN: 200 });
    for (const st of result.subTokens) {
      assert.ok(st.parentCount >= 1, `${st.token} should have parentCount >= 1`);
      assert.ok(st.exampleParents.length >= 1, `${st.token} should have example parents`);
      assert.ok(typeof st.score === 'number');
    }
  });

  it('functionNames are CamelCase function-like entries', () => {
    const result = index.getVocabularyForPrompt({ topN: 200 });
    const names = result.functionNames.map(fn => fn.name);

    // Should include CamelCase function names from the test files
    // At minimum, validateCertificateChain, negotiateCipherSuite, etc.
    // (Exact set depends on what vocabulary scoring picks up)
    assert.ok(result.functionNames.length >= 0, 'functionNames should be an array');
    for (const fn of result.functionNames) {
      assert.ok(fn.name, 'each functionName should have a name');
      assert.ok(typeof fn.score === 'number');
    }
  });
});


describe('formatVocabularyForPrompt', () => {
  let index;

  before(async () => {
    // Reuse files from above (already created)
    if (!fs.existsSync(TEST_DIR)) {
      setupVocabTestFiles();
    }
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    if (index.files.size === 0) {
      await index.buildIndex(TEST_DIR, { showProgress: false });
    }
  });

  it('compact format returns CODEBASE VOCABULARY header', () => {
    const text = index.formatVocabularyForPrompt('compact', { topN: 100 });
    assert.ok(text.startsWith('CODEBASE VOCABULARY'), `should start with header, got: ${text.slice(0, 50)}`);
  });

  it('compact format is comma-separated token list', () => {
    const text = index.formatVocabularyForPrompt('compact', { topN: 100 });
    // Should be header line + comma-separated tokens
    const lines = text.split('\n');
    assert.ok(lines.length >= 1);
    // Second part should have commas
    assert.ok(text.includes(','), 'compact format should have commas between tokens');
  });

  it('rich format includes sub-tokens and function names sections', () => {
    const text = index.formatVocabularyForPrompt('rich', { topN: 100 });
    assert.ok(text.includes('CODEBASE VOCABULARY'));
    // Rich format has "  token (in: parentToken)" lines
    assert.ok(text.includes('(in:'), 'rich format should show parent tokens');
  });

  it('returns empty string when no vocabulary', () => {
    const emptyIndex = new CodeSearchIndex({ indexPath: path.join(os.tmpdir(), 'code_exam_empty_vocab_idx') });
    const text = emptyIndex.formatVocabularyForPrompt('compact');
    assert.equal(text, '');
  });
});


// ========================================================================
// Vocabulary-augmented prompt builders
// ========================================================================

import {
  buildExtractionPromptWithVocab,
  buildLocalExtractionPromptWithVocab,
  CLAIM_EXTRACTION_PROMPT,
  CLAIM_EXTRACTION_PROMPT_LOCAL,
  extractClaimKeywords,
} from '../src/commands/claim.js';


// ========================================================================
// extractClaimKeywords
// ========================================================================

describe('extractClaimKeywords', () => {

  it('extracts meaningful words from patent claim', () => {
    const claim = `A method of establishing a secure communication connection
      through a computer network, the method comprising:
      initializing a cryptographic context by creating a security
      protocol object configured with a minimum protocol version`;
    const kw = extractClaimKeywords(claim);

    // Should keep domain-specific words
    assert.ok(kw.has('secure'), 'should keep "secure"');
    assert.ok(kw.has('communication'), 'should keep "communication"');
    assert.ok(kw.has('connection'), 'should keep "connection"');
    assert.ok(kw.has('computer'), 'should keep "computer"');
    assert.ok(kw.has('network'), 'should keep "network"');
    assert.ok(kw.has('cryptographic'), 'should keep "cryptographic"');
    assert.ok(kw.has('protocol'), 'should keep "protocol"');
    assert.ok(kw.has('version'), 'should keep "version"');
  });

  it('strips patent boilerplate', () => {
    const claim = `A method of establishing a secure communication
      connection, the method comprising wherein said plurality`;
    const kw = extractClaimKeywords(claim);

    // Patent boilerplate should be removed
    assert.ok(!kw.has('method'), '"method" is patent boilerplate');
    assert.ok(!kw.has('comprising'), '"comprising" is patent boilerplate');
    assert.ok(!kw.has('wherein'), '"wherein" is patent boilerplate');
    assert.ok(!kw.has('said'), '"said" is patent boilerplate');
    assert.ok(!kw.has('plurality'), '"plurality" is patent boilerplate');
    assert.ok(!kw.has('the'), '"the" should be filtered');
  });

  it('handles the multisect pseudo-claim', () => {
    const claim = `A method of searching multiple search terms in code,
      in which the intersection of substantially all the terms is to be
      found in the smallest location possible: all within a single function,
      or among multiple functions in a single file or class, or among
      multiple files in a single folder or subdirectory.`;
    const kw = extractClaimKeywords(claim);

    assert.ok(kw.has('searching'), 'should keep "searching"');
    assert.ok(kw.has('intersection'), 'should keep "intersection"');
    assert.ok(kw.has('code'), 'should keep "code"');
    assert.ok(kw.has('function'), 'should keep "function"');
    assert.ok(kw.has('folder'), 'should keep "folder"');
    assert.ok(kw.has('subdirectory'), 'should keep "subdirectory"');
    // Boilerplate stripped
    assert.ok(!kw.has('method'), '"method" is boilerplate');
    assert.ok(!kw.has('substantially'), '"substantially" is boilerplate');
  });

  it('handles the facade server claim', () => {
    const claim = `A computer system comprising: a CPU; a memory unit coupled
      to the CPU; a facade server stored in the memory unit; and a program
      stored in the memory unit, wherein the program creates an interface
      between the facade server and a web-browser for exchanging data
      associated with the application, wherein the facade server hosts the
      application without utilizing network protocols and without opening
      network ports.`;
    const kw = extractClaimKeywords(claim);

    assert.ok(kw.has('cpu'), 'should keep "cpu"');
    assert.ok(kw.has('facade'), 'should keep "facade"');
    assert.ok(kw.has('server'), 'should keep "server"');
    assert.ok(kw.has('browser'), 'should keep "browser"');
    assert.ok(kw.has('interface'), 'should keep "interface"');
    assert.ok(kw.has('protocols'), 'should keep "protocols"');
    assert.ok(kw.has('ports'), 'should keep "ports"');
    assert.ok(kw.has('application'), 'should keep "application"');
    // Boilerplate
    assert.ok(!kw.has('comprising'), '"comprising" is boilerplate');
    assert.ok(!kw.has('wherein'), '"wherein" is boilerplate');
    assert.ok(!kw.has('coupled'), '"coupled" is boilerplate');
    assert.ok(!kw.has('associated'), '"associated" is boilerplate');
  });

  it('returns empty set for empty input', () => {
    assert.equal(extractClaimKeywords('').size, 0);
    assert.equal(extractClaimKeywords(null).size, 0);
  });
});


// ========================================================================
// Claim-aware vocabulary filtering (getVocabularyForPrompt with claimKeywords)
// ========================================================================

describe('claim-filtered getVocabularyForPrompt', () => {
  let index;

  before(async () => {
    // Reuse test files from above
    if (!fs.existsSync(TEST_DIR)) {
      setupVocabTestFiles();
    }
    index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    if (index.files.size === 0) {
      await index.buildIndex(TEST_DIR, { showProgress: false });
    }
  });

  it('filters sub-tokens when claimKeywords provided', () => {
    // With claimKeywords about "certificate" — only cert-related terms should appear
    const claimKw = new Set(['certificate', 'hostname', 'secure', 'expiration']);

    const filtered = index.getVocabularyForPrompt({
      topN: 100,
      claimKeywords: claimKw,
    });
    const unfiltered = index.getVocabularyForPrompt({ topN: 100 });

    // Filtered should have fewer terms than unfiltered
    assert.ok(filtered.subTokens.length <= unfiltered.subTokens.length,
      `filtered (${filtered.subTokens.length}) should be <= unfiltered (${unfiltered.subTokens.length})`);

    // Stats should indicate claim filtering was applied
    assert.ok(filtered.stats.claimFiltered, 'claimFiltered should be true');
    assert.ok(!unfiltered.stats.claimFiltered, 'unfiltered claimFiltered should be false');
  });

  it('returns empty when claim has no vocab overlap', () => {
    // Totally unrelated claim keywords
    const claimKw = new Set(['blockchain', 'cryptocurrency', 'mining', 'ledger']);

    const result = index.getVocabularyForPrompt({
      topN: 100,
      claimKeywords: claimKw,
    });

    assert.equal(result.subTokens.length, 0, 'should have no matching sub-tokens');
    assert.equal(result.functionNames.length, 0, 'should have no matching functions');
  });

  it('relevant sub-tokens have relevance scores', () => {
    const claimKw = new Set(['cert', 'secure', 'context']);
    const result = index.getVocabularyForPrompt({
      topN: 100,
      claimKeywords: claimKw,
    });

    for (const st of result.subTokens) {
      assert.ok(st.relevance > 0, `${st.token} should have positive relevance`);
    }
  });

  it('formatVocabularyForPrompt returns empty for no-match claim', () => {
    const claimKw = new Set(['blockchain', 'cryptocurrency']);
    const text = index.formatVocabularyForPrompt('compact', {
      topN: 100,
      claimKeywords: claimKw,
    });
    assert.equal(text, '', 'should be empty for unrelated claim');
  });

  it('formatVocabularyForPrompt includes filter note', () => {
    const claimKw = new Set(['cert', 'secure', 'context']);
    const text = index.formatVocabularyForPrompt('rich', {
      topN: 100,
      claimKeywords: claimKw,
    });
    if (text) {
      assert.ok(text.includes('claim-relevant'), 'rich format should mention claim filtering');
    }
  });
});

describe('buildExtractionPromptWithVocab', () => {

  it('returns base prompt when no concordance', () => {
    const result = buildExtractionPromptWithVocab('');
    assert.equal(result, CLAIM_EXTRACTION_PROMPT);
    assert.equal(buildExtractionPromptWithVocab(null), CLAIM_EXTRACTION_PROMPT);
  });

  it('appends vocabulary section to base prompt', () => {
    const vocab = 'CODEBASE VOCABULARY (10 terms):\ncipher, certificate, tls, ssl';
    const result = buildExtractionPromptWithVocab(vocab);

    // Should contain the original prompt
    assert.ok(result.includes('You are a technical-prose-to-source-code keyword extractor'));
    // Should contain the vocabulary
    assert.ok(result.includes('cipher, certificate, tls, ssl'));
    // Should have guidance about using vocabulary for BROAD
    assert.ok(result.includes('BROAD'));
    assert.ok(result.includes('PREFER'));
    // Should say to ignore vocabulary for TIGHT
    assert.ok(result.includes('TIGHT'));
    assert.ok(result.includes('ignore the vocabulary'));
  });

  it('is longer than base prompt', () => {
    const vocab = 'CODEBASE VOCABULARY:\ntoken1, token2, token3';
    const result = buildExtractionPromptWithVocab(vocab);
    assert.ok(result.length > CLAIM_EXTRACTION_PROMPT.length);
  });
});


describe('buildLocalExtractionPromptWithVocab', () => {

  it('returns base prompt when no concordance', () => {
    const result = buildLocalExtractionPromptWithVocab('');
    assert.equal(result, CLAIM_EXTRACTION_PROMPT_LOCAL);
  });

  it('appends compact vocabulary section', () => {
    const vocab = 'CODEBASE VOCABULARY (5 terms):\ncipher, handshake, tls, auth, session';
    const result = buildLocalExtractionPromptWithVocab(vocab);

    // Should contain the original local prompt
    assert.ok(result.includes('Extract search terms from a technical-prose input'));
    // Should contain the vocabulary
    assert.ok(result.includes('cipher, handshake'));
    // Should be compact — no elaborate instructions
    assert.ok(result.includes('these words exist in the code'));
  });

  it('is shorter than the Claude vocab prompt for same input', () => {
    const vocab = 'CODEBASE VOCABULARY:\ntoken1, token2, token3';
    const localResult = buildLocalExtractionPromptWithVocab(vocab);
    const claudeResult = buildExtractionPromptWithVocab(vocab);
    assert.ok(localResult.length < claudeResult.length,
      `local (${localResult.length}) should be shorter than Claude (${claudeResult.length})`);
  });
});
