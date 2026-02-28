// ============================================================================
// claim.js - --claim-search: LLM keyword extraction from patent claim text
//
// Phase 8a: Send patent claim text to LLM (Claude API or local model),
// extract TIGHT and BROAD multisect search term lists, then run both
// through the existing multisectSearch engine.
//
// Pipeline:
//   patent claim text -> LLM -> TIGHT: terms;... / BROAD: terms;...
//     -> sanitize -> multisectSearch (TIGHT) -> multisectSearch (BROAD)
//
// Two LLM paths:
//   --use-claude    : Anthropic API (needs ANTHROPIC_API_KEY env var)
//   --claim-model   : Local GGUF model via node-llama-cpp (TODO: Phase 8a+)
// ============================================================================

import { parseMultisectTerms, displayMultisectResults, printSelectivityReport } from './multisect.js';
import fs from 'fs';
import https from 'https';
import http from 'http';

// ============================================================================
// LLM Prompt for patent claim -> search term extraction
// ============================================================================

const _CLAIM_EXTRACTION_PROMPT = `\
You are a patent-claim-to-source-code keyword extractor with expertise in \
both patent law terminology and software engineering implementation patterns.

INPUT: A patent claim (or set of claims) describing a software system.

TASK: Extract TWO sets of search terms for a code-search tool. The tool \
finds the smallest code location (function -> file -> folder) containing \
all search terms simultaneously.

OUTPUT FORMAT - exactly two labeled lines:
TIGHT: term1;term2;/regex/;NOT negated;...
BROAD: term1;term2;/regex/;NOT negated;...

TERM SYNTAX:
- Plain terms: literal case-insensitive match (e.g. facade)
- /regex/: regex alternation for synonyms (e.g. /facade|proxy|gateway/)
- NOT term: scope must NOT contain this (e.g. NOT /tcp|udp/)
- NOT /regex/: negated regex

============================================================================

TIGHT SEARCH - literal claim language, narrow:
  Purpose: Find code that uses the EXACT terminology from the claim.
  Rules:
  - Extract keywords that appear directly in the claim text.
  - Use regex only for morphological variants (/exchang|transfer/).
  - For negation clauses ("without utilizing X"), generate narrow NOT \
terms for ONLY the specific thing excluded - not broader concepts.
    "without utilizing network protocols" -> NOT /protocol|tcp|udp|http/
    (do NOT include bare "network" - too broad, matches "neural network").
  - Skip purely abstract phrasing ("a method comprising", "a system").
  - NEVER include these generic patent-boilerplate words as search terms:
    method, device, apparatus, system, step, means, unit, module,
    component, element, embodiment, implementation, comprising, wherein.
    These appear in virtually every source file and provide zero
    discrimination. Only include them if they are PART of a compound
    technical term (e.g. "finite element" is OK, bare "element" is not).
  - Skip generic hardware (CPU, memory) unless they're identifiers.
  - Aim for 5-12 positive terms + any NOT terms.

============================================================================

BROAD SEARCH - implementation-aware, expansive:
  Purpose: Find code that IMPLEMENTS the claim, even if it uses \
completely different terminology. Think like a developer.
  
  Rules:
  1. IMPLEMENTATION SYNONYMS: What would a developer actually NAME these \
things in code? A "facade server" might be called: wrapper, shim, \
adapter, front_end, proxy, gateway, bridge, middleware. Include these.

  2. NEGATION -> ALTERNATIVE MECHANISMS (CRITICAL):
     When a claim says "without utilizing X", this implies the invention \
uses an ALTERNATIVE to X. You MUST generate positive search terms \
for plausible alternatives, not just NOT terms.
     
     Examples:
     - "without utilizing network protocols" -> the code must communicate \
some other way. Search FOR: /loopback|localhost|127\\.0\\.0\\.1/; \
/IPC|ipc|inter.process/; /shared.memory|shm|mmap/; \
/named.pipe|pipe|fifo/; /local.procedure|lpc|rpc/; /cgi.bin|cgi/
     - "without opening network ports" -> Search FOR: \
/loopback|localhost/; /unix.socket|domain.socket/; /pipe|fifo/
     - "without a database" -> Search FOR: /file.system|flat.file|csv|json/
     
     Also include narrower NOT terms: NOT /tcp|udp|http/ (but NOT bare \
"network" or "port" - these are too broad).
  
  3. ARCHITECTURAL PATTERNS: Include design pattern names that implement \
the claim's architecture: /adapter|bridge|mediator|facade|proxy|wrapper/

  4. Use regex alternations generously: /term1|term2|term3/ counts as \
ONE search term but matches any of them.

  5. Include alternative mechanisms for each claim element, not just \
the literal words. If the claim says "exchanging data", a developer \
might use: serialize, marshal, transfer, send, recv, pipe, stream.

  6. Aim for 10-20 positive terms + NOT terms.

  7. Keep NOT terms NARROW and SPECIFIC:
     BAD:  NOT network (too broad - matches "neural network", "network cable")
     GOOD: NOT /tcp|udp|http/ (specific protocol indicators)
     BAD:  NOT port (too broad - matches "portable", "viewport")
     GOOD: NOT /listen.*port|bind.*port|open.*port/

============================================================================

FORMAT EXAMPLE (for illustration of output FORMAT ONLY - do NOT copy these terms):
The following shows the STRUCTURE of your response. The actual terms \
MUST come from the user's patent claim, NOT from this example.

Example input: "A system comprising a facade server that hosts an application \
and creates an interface to a web-browser for exchanging data, wherein \
the facade server operates without utilizing network protocols and \
without opening network ports."

Example output (DO NOT COPY - these terms are for the facade patent above, not the user's patent):
TIGHT: /facade|proxy/;server;/browser|web/;interface;/exchang|transfer/;application;host;NOT /protocol|tcp|udp|http/;NOT /port|socket|listen/
BROAD: /facade|proxy|gateway|wrapper|shim|adapter|bridge/;server;/browser|web|front.end/;/interface|adapter|mediator|bridge/;/exchang|transfer|marshal|serial/;/application|app/;/host|embed|in.process|local/;/loopback|localhost|127\\.0\\.0\\.1/;/IPC|ipc|inter.process/;/shared.memory|shm|mmap/;/named.pipe|pipe|fifo/;/cgi.bin|cgi|local.cgi/;/legacy|moderniz|wrapper/;NOT /protocol|tcp|udp|http/;NOT /listen.*port|bind.*port|open.*port/

============================================================================

CRITICAL: The example above is ONLY about a "facade server" patent. \
You MUST ignore those example terms entirely and generate NEW terms \
based on the ACTUAL patent claim the user provides below.
If the user's patent is about audio compression, your terms must be about \
audio/compression/codec - NOT facade/server/browser.

Respond with ONLY the two labeled lines. No explanation, no preamble.
Extract terms from the user's ACTUAL patent claim text:
TIGHT: ...
BROAD: ...`;


// ============================================================================
// LLM call: Anthropic Claude API
// ============================================================================

/**
 * Call Claude API to extract search terms from patent claim text.
 *
 * @param {string} claimText - Raw patent claim text
 * @param {object} opts
 * @param {string} [opts.apiKey] - Anthropic API key (or ANTHROPIC_API_KEY env)
 * @param {string} [opts.apiUrl] - API endpoint override
 * @param {string} [opts.model] - Model name override
 * @param {boolean} [opts.verbose] - Print debug info
 * @param {number} [opts.temperature=0.0] - Temperature
 * @param {string} [opts.vocabConcordance] - Vocabulary concordance from index
 * @returns {Promise<{tight: string|null, broad: string|null, raw: string}|{error: string}>}
 */
export async function extractClaimTerms(claimText, opts = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) {
    return { error: 'No API key. Set ANTHROPIC_API_KEY environment variable or use --api-key KEY.' };
  }

  const apiUrl = opts.apiUrl
    || process.env.CLAIM_SEARCH_API_URL
    || 'https://api.anthropic.com/v1/messages';
  const model = opts.model
    || process.env.CLAIM_SEARCH_MODEL
    || 'claude-sonnet-4-20250514';
  const temperature = opts.temperature ?? 0.0;
  const verbose = opts.verbose || false;

  // -- SECURITY: Network egress warning --
  const isLocal = /localhost|127\.0\.0\.1|::1|0\.0\.0\.0|\.local/.test(apiUrl);
  if (isLocal) {
    process.stderr.write(`  -- NETWORK: Local LLM endpoint -> ${apiUrl}\n`);
  } else {
    const w = 63;
    const pad = (s) => s.padEnd(w);
    const ctr = (s) => s.padStart(Math.floor((w + s.length) / 2)).padEnd(w);
    process.stderr.write(`  +${'-'.repeat(w)}+\n`);
    process.stderr.write(`  |${ctr('WARNING: EXTERNAL NETWORK REQUEST')}|\n`);
    process.stderr.write(`  |${ctr('CLAIM TEXT WILL BE SENT TO:')}|\n`);
    process.stderr.write(`  |${pad('  ' + apiUrl)}|\n`);
    process.stderr.write(`  |${pad('  Model: ' + model)}|\n`);
    process.stderr.write(`  |${pad('  Claim text: ' + claimText.length + ' chars')}|\n`);
    process.stderr.write(`  |${ctr('Do NOT use on air-gapped/litigation systems')}|\n`);
    process.stderr.write(`  |${ctr('unless endpoint is a local LLM (CLAIM_SEARCH_API_URL).')}|\n`);
    process.stderr.write(`  +${'-'.repeat(w)}+\n`);
  }

  // Build request payload
  const systemPrompt = opts.vocabConcordance
    ? buildExtractionPromptWithVocab(opts.vocabConcordance, opts.vocabTight || false)
    : _CLAIM_EXTRACTION_PROMPT;
  const payload = JSON.stringify({
    model,
    max_tokens: 2048,
    temperature,
    system: systemPrompt,
    messages: [
      { role: 'user', content: claimText.trim() }
    ],
  });

  if (verbose) {
    process.stderr.write(`  API: ${apiUrl}\n`);
    process.stderr.write(`  Model: ${model}\n`);
    process.stderr.write(`  Claim text: ${claimText.length} chars\n`);
    process.stderr.write(`  Sending request...\n`);
  }

  // Send request
  try {
    const body = await _httpPost(apiUrl, payload, {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });

    const usage = body.usage || {};
    const inTok = usage.input_tokens || 0;
    const outTok = usage.output_tokens || 0;
    if (!isLocal) {
      // Estimate cost (Sonnet: $3/$15 per MTok in/out)
      let costStr = '';
      if (typeof inTok === 'number' && typeof outTok === 'number') {
        const cost = (inTok * 3 + outTok * 15) / 1_000_000;
        costStr = `, est. $${cost.toFixed(4)}`;
      }
      process.stderr.write(`  OK: ${model} (${inTok} in / ${outTok} out tokens${costStr})\n`);
    }

    // Extract text from response
    const content = body.content || [];
    const textParts = content
      .filter(b => b.type === 'text')
      .map(b => b.text);
    const rawResponseText = textParts.join('\n').trim();

    if (!rawResponseText) {
      return { error: 'LLM returned empty response' };
    }

    // Always show raw LLM response (useful for debugging term quality)
    process.stderr.write(`  LLM response:\n`);
    for (const line of rawResponseText.split('\n')) {
      process.stderr.write(`    ${line}\n`);
    }

    return _parseResponse(rawResponseText);

  } catch (e) {
    return { error: `API error: ${e.message || e}` };
  }
}


/**
 * Simple HTTP/HTTPS POST helper using Node.js built-in modules.
 * Returns parsed JSON body.
 */
function _httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 90000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out (90s)'));
    });
    req.write(body);
    req.end();
  });
}


// ============================================================================
// Response parsing
// ============================================================================

// ============================================================================
// Simplified prompt for local models (smaller context, simpler instructions)
// ============================================================================

const _CLAIM_EXTRACTION_PROMPT_LOCAL = `\
Extract search terms from a patent claim for a code search tool.

OUTPUT: Exactly two lines:
TIGHT: term1;term2;/regex/;NOT negated;...
BROAD: term1;term2;/regex/;NOT negated;...

SYNTAX:
- Plain text: literal case-insensitive match
- /word1|word2/: regex alternation, matches any of the words
- NOT word: the code must NOT contain this word
- NOT /word1|word2/: negated regex

TIGHT terms: Use the actual technical words from the claim text. \
Skip generic patent words: method, system, device, apparatus, comprising, wherein. \
Use /regex/ only for morphological variants of the same word. \
Aim for 5-12 terms.

BROAD terms: Think like a software developer implementing the claim. \
What variable names, function names, and class names would they use? \
Add programming synonyms and design pattern names. \
Use /word1|word2|word3/ to group synonyms as one term. \
Aim for 10-20 terms.

IMPORTANT: Only generate terms from the patent claim below. \
Do NOT invent terms unrelated to the claim.

Respond with ONLY the two labeled lines, nothing else.`;


/**
 * Parse TIGHT: and BROAD: lines from LLM response text.
 */
// Exported for use by analyze.js (local model term extraction)
export { _CLAIM_EXTRACTION_PROMPT as CLAIM_EXTRACTION_PROMPT };
export { _CLAIM_EXTRACTION_PROMPT_LOCAL as CLAIM_EXTRACTION_PROMPT_LOCAL };
export { _parseResponse as parseTermResponse };


// ============================================================================
// Patent claim keyword extraction (for vocabulary filtering)
// ============================================================================

/**
 * Words appearing in 10%+ of a random sample of 2,000 US patents.
 * These are boilerplate - they appear in virtually every patent claim
 * and provide zero discrimination for matching claims to source code.
 * Derived from empirical analysis of actual patent corpora.
 *
 * Source: pat_topwords.txt (175 words from cross-validated patent samples)
 */
const _PATENT_STOPWORDS = new Set([
  // Articles, prepositions, conjunctions (also in general English stopwords)
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'being', 'between', 'both',
  'by', 'can', 'during', 'each', 'for', 'from', 'further', 'has', 'have',
  'having', 'i', 'in', 'into', 'is', 'its', 'not', 'of', 'on', 'one', 'or',
  'other', 'over', 'same', 'so', 'such', 'than', 'that', 'the', 'to', 'two',
  'upon', 'we', 'what', 'when', 'where', 'which', 'while', 'with', 'within',
  // Patent-specific boilerplate
  'about', 'according', 'adapted', 'adjacent', 'after', 'along', 'amount',
  'another', 'apparatus', 'arranged', 'associated', 'attached', 'axis',
  'based', 'body', 'claim', 'claimed', 'claims', 'comprising', 'comprises',
  'connected', 'connecting', 'consisting', 'containing', 'controlling',
  'corresponding', 'coupled', 'defined', 'defining', 'device', 'different',
  'direction', 'disposed', 'element', 'end', 'ends', 'extending', 'first',
  'form', 'formed', 'forming', 'generating', 'greater', 'group', 'includes',
  'including', 'inner', 'least', 'length', 'less', 'located', 'lower',
  'means', 'member', 'method', 'more', 'mounted', 'movement', 'number',
  'opening', 'opposite', 'outer', 'output', 'pair', 'parallel', 'part',
  'plurality', 'portion', 'portions', 'position', 'positioned',
  'predetermined', 'process', 'provide', 'provided', 'providing', 'range',
  'receiving', 'relative', 'respect', 'respective', 'respectively',
  'response', 'said', 'second', 'selected', 'set', 'side', 'spaced', 'step',
  'steps', 'substantially', 'support', 'system', 'temperature', 'thereby',
  'therein', 'thereof', 'third', 'through', 'time', 'unit', 'use', 'using',
  'value', 'weight', 'whereby', 'wherein', 'words',
  // Common English that leaks through
  'also', 'but', 'if', 'may', 'no', 'only', 'then', 'there', 'these',
  'this', 'was', 'were', 'will', 'would',
  // Generic technical (too broad for code search)
  'circuit', 'contact', 'control', 'data', 'edge', 'input', 'layer',
  'material', 'pressure', 'signal', 'signals', 'source', 'surface',
  'area', 'determining',
]);


/**
 * Extract meaningful keywords from patent claim text.
 *
 * Tokenizes the claim, strips patent boilerplate, and returns lowercase
 * keywords that carry discriminative content - the words that distinguish
 * THIS claim from all other claims.
 *
 * @param {string} claimText - Raw patent claim text
 * @returns {Set<string>} Set of lowercase keywords (typically 5-30 words)
 */
export function extractClaimKeywords(claimText) {
  if (!claimText) return new Set();

  // Tokenize: split on non-alphanumeric, lowercase, filter short
  const words = claimText.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 3);

  const keywords = new Set();
  for (const word of words) {
    if (_PATENT_STOPWORDS.has(word)) continue;
    // Skip pure numbers
    if (/^\d+$/.test(word)) continue;
    keywords.add(word);
  }

  return keywords;
}


// ============================================================================
// Vocabulary-augmented prompt builders
// ============================================================================

/**
 * Build vocabulary-augmented extraction prompt for Claude / large models.
 *
 * @param {string} vocabConcordance - Output of formatVocabularyForPrompt('rich')
 * @param {boolean} [vocabTight=false] - Also use vocabulary for TIGHT terms
 * @returns {string} Full system prompt with vocabulary section
 */
export function buildExtractionPromptWithVocab(vocabConcordance, vocabTight = false) {
  if (!vocabConcordance) return _CLAIM_EXTRACTION_PROMPT;

  const tightGuidance = vocabTight
    ? `For TIGHT terms: you may also use vocabulary words that appear in the claim \
or are close morphological variants of claim words. This can improve matching \
when the codebase uses specific terminology.`
    : `For TIGHT terms: ignore the vocabulary - use only words from the claim text.`;

  return _CLAIM_EXTRACTION_PROMPT + `

============================================================================

TARGET CODEBASE VOCABULARY - use this to improve BROAD term generation.

The following vocabulary was extracted from the codebase being searched. \
For BROAD terms, PREFER using words from this vocabulary over guessing \
synonyms. These are actual identifiers, variable names, and function \
names that exist in the code. Map patent claim concepts to these terms \
when there is a reasonable semantic connection.

${tightGuidance}

${vocabConcordance}

IMPORTANT: Do NOT include vocabulary terms that have no plausible \
connection to the patent claim. Only select terms that a developer \
might use to implement the concepts described in the claim.`;
}


/**
 * Build vocabulary-augmented extraction prompt for local 7B models.
 *
 * @param {string} vocabConcordance - Output of formatVocabularyForPrompt('compact')
 * @param {boolean} [vocabTight=false] - Also use vocabulary for TIGHT terms
 * @returns {string} Combined prompt with vocabulary
 */
export function buildLocalExtractionPromptWithVocab(vocabConcordance, vocabTight = false) {
  if (!vocabConcordance) return _CLAIM_EXTRACTION_PROMPT_LOCAL;

  const tightNote = vocabTight
    ? 'For both TIGHT and BROAD terms, prefer words from this list when they relate to the claim:'
    : 'For BROAD terms, prefer words from this list when they relate to the claim:';

  return _CLAIM_EXTRACTION_PROMPT_LOCAL + `

TARGET CODEBASE - these words exist in the code being searched. \
${tightNote}

${vocabConcordance}

Use ONLY vocabulary words that connect to the patent claim concepts.`;
}

function _parseResponse(rawText) {
  let tight = null;
  let broad = null;

  for (let line of rawText.split('\n')) {
    line = line.trim().replace(/^`+|`+$/g, '');
    if (line.toUpperCase().startsWith('TIGHT:')) {
      tight = line.slice(6).trim().replace(/^`+|`+$/g, '');
    } else if (line.toUpperCase().startsWith('BROAD:')) {
      broad = line.slice(6).trim().replace(/^`+|`+$/g, '');
    }
  }

  // Fallback: if no labels, treat first semicolon-containing line as tight
  if (tight === null && broad === null) {
    for (let line of rawText.split('\n')) {
      line = line.trim();
      if (line && line.includes(';')) {
        tight = line.replace(/^`+|`+$/g, '');
        break;
      }
    }
    if (tight === null) {
      tight = rawText.split('\n')[0].trim().replace(/^`+|`+$/g, '');
    }
  }

  return { tight, broad, raw: rawText };
}


// ============================================================================
// Sanitizers - clean degenerate LLM output
// ============================================================================

/**
 * Filter degenerate LLM output: overly long terms, multi-word phrases,
 * Latin gibberish from small models.
 *
 * Rules:
 *   - Each alternation (split by |) must be <= 30 chars and <= 2 words
 *   - Terms where ALL alternations fail are dropped
 *   - Max 20 terms total
 */
export function sanitizeLlmTerms(termsStr, label = '') {
  if (!termsStr) return termsStr;

  const MAX_ALT_CHARS = 30;
  const MAX_ALT_WORDS = 2;
  const MAX_TERMS = 20;

  const parts = termsStr.split(';');
  const cleaned = [];
  let nDropped = 0;
  let nTrimmed = 0;

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    let isNot = false;
    let inner = part;
    if (inner.toUpperCase().startsWith('NOT ')) {
      isNot = true;
      inner = inner.slice(4).trim();
    }

    if (inner.startsWith('/') && inner.endsWith('/')) {
      // Regex term: check each alternation
      const alts = inner.slice(1, -1).split('|');
      const goodAlts = [];
      for (let alt of alts) {
        alt = alt.trim();
        if (alt.length > MAX_ALT_CHARS) continue;
        if (alt.split(/\s+/).length > MAX_ALT_WORDS) continue;
        if (alt) goodAlts.push(alt);
      }

      if (goodAlts.length === 0) { nDropped++; continue; }
      if (goodAlts.length < alts.length) nTrimmed++;

      const rebuilt = goodAlts.length === 1
        ? goodAlts[0]
        : '/' + goodAlts.join('|') + '/';

      cleaned.push(isNot ? `NOT ${rebuilt}` : rebuilt);
    } else {
      // Plain term
      if (inner.length > MAX_ALT_CHARS || inner.split(/\s+/).length > MAX_ALT_WORDS) {
        nDropped++;
        continue;
      }
      cleaned.push(part);
    }

    if (cleaned.length >= MAX_TERMS) {
      nDropped += parts.length - parts.indexOf(rawPart) - 1;
      break;
    }
  }

  if (nDropped > 0 || nTrimmed > 0) {
    process.stderr.write(
      `  [sanitize-${label}] Dropped ${nDropped} degenerate term(s), ` +
      `trimmed ${nTrimmed} term(s), kept ${cleaned.length}\n`
    );
  }

  return cleaned.join(';');
}


/**
 * Remove single-character alternations from BROAD regex terms.
 *
 * The LLM sometimes generates /query|q/ or /key|k/ which match nearly
 * every file. Filter to alternations with 2+ characters.
 */
export function sanitizeBroadTerms(termsStr) {
  if (!termsStr) return termsStr;

  const parts = termsStr.split(';');
  const cleaned = [];
  let nFixed = 0;

  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;

    let isNot = false;
    let inner = part;
    if (inner.toUpperCase().startsWith('NOT ')) {
      isNot = true;
      inner = inner.slice(4).trim();
    }

    if (inner.startsWith('/') && inner.endsWith('/')) {
      const alts = inner.slice(1, -1).split('|');
      const origCount = alts.length;
      const filtered = alts.filter(a => a.length >= 2);

      if (filtered.length < origCount) {
        const dropped = alts.filter(a => a.length < 2);
        nFixed++;
        process.stderr.write(
          `  [sanitize] Removed single-char alternation(s) [${dropped}] from ${inner}\n`
        );
      }

      if (filtered.length === 0) {
        process.stderr.write(`  [sanitize] Dropping term ${part} (all single-char)\n`);
        continue;
      }

      const rebuilt = filtered.length === 1
        ? filtered[0]
        : '/' + filtered.join('|') + '/';

      cleaned.push(isNot ? `NOT ${rebuilt}` : rebuilt);
    } else {
      cleaned.push(part);
    }
  }

  if (nFixed > 0) {
    process.stderr.write(
      `  [sanitize] Fixed ${nFixed} term(s) with single-char alternations\n`
    );
  }

  return cleaned.join(';');
}


// ============================================================================
// First-claim extraction (for local models with limited context)
// ============================================================================

/**
 * Extract only the first claim from multi-claim patent text.
 * Small local models degenerate with too much text.
 *
 * @returns {{ text: string, skipped: number }}
 */
export function extractFirstClaim(claimText) {
  const lines = claimText.trim().split('\n');
  let cutoff = lines.length;
  const claimsFound = [];

  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();

    // Pattern: "2." at start of line (claim numbers 2-999)
    let m = stripped.match(/^(\d+)\s*\./);
    if (m) {
      const claimNum = parseInt(m[1], 10);
      if (claimNum >= 2) {
        if (claimsFound.length === 0) cutoff = i;
        claimsFound.push(claimNum);
        continue;
      }
    }

    // Pattern: "[claim 2]" or "[Claim 2]"
    m = stripped.match(/^\[(?:claim|Claim)\s+(\d+)\]/);
    if (m) {
      const claimNum = parseInt(m[1], 10);
      if (claimNum >= 2) {
        if (claimsFound.length === 0) cutoff = i;
        claimsFound.push(claimNum);
        continue;
      }
    }
  }

  if (claimsFound.length === 0) {
    return { text: claimText, skipped: 0 };
  }

  return {
    text: lines.slice(0, cutoff).join('\n').trim(),
    skipped: claimsFound.length,
  };
}


// ============================================================================
// Run one tier of claim search (TIGHT or BROAD)
// ============================================================================

/**
 * Run one tier of a claim search through the multisect engine.
 *
 * @returns {{ hasResults: boolean, nFunc: number, nFile: number, nFolder: number }}
 */
function _runClaimTier(index, tierName, termsStr, minTermsOverride, opts) {
  process.stderr.write(`  --- ${tierName} search ---\n`);

  const terms = parseMultisectTerms(termsStr);
  if (!terms || terms.length === 0) {
    console.log(`  Failed to parse ${tierName} terms.`);
    return { hasResults: false, nFunc: 0, nFile: 0, nFolder: 0 };
  }

  const positiveTerms = terms.filter(t => !t.negated);
  if (positiveTerms.length < 2) {
    console.log(`  Too few positive terms for ${tierName} search.`);
    return { hasResults: false, nFunc: 0, nFile: 0, nFolder: 0 };
  }

  let minTerms;
  if (minTermsOverride && minTermsOverride > 0) {
    minTerms = minTermsOverride;
  } else {
    // TIGHT: 80%, BROAD: 60%
    if (tierName === 'TIGHT') {
      minTerms = Math.max(Math.floor(positiveTerms.length * 0.80), 2);
    } else {
      minTerms = Math.max(Math.floor(positiveTerms.length * 0.60), 3);
    }
  }

  console.log(`  Searching (min_terms=${minTerms}/${positiveTerms.length})...`);

  const results = index.multisectSearch(terms, {
    minTerms,
    includePath: opts.includePath,
    excludePath: opts.excludePath,
  });

  if (!results) {
    return { hasResults: false, nFunc: 0, nFile: 0, nFolder: 0 };
  }

  // Selectivity report
  const totalFiles = index.files ? index.files.length : 0;
  console.log();
  printSelectivityReport(results, totalFiles);

  // Display results (compact mode: detail for top 3)
  displayMultisectResults(results, {
    max_results: opts.maxResults || 10,
    verbose: opts.verbose || false,
    full_path: false,
    // compact: true,     // TODO: add compact mode to displayMultisectResults
    // detailTopN: 3,
  }, totalFiles);

  const nFunc = (results.function_matches || []).length;
  const nFile = (results.file_matches || []).length;
  const nFolder = (results.folder_matches || []).length;

  return { hasResults: nFunc + nFile + nFolder > 0, nFunc, nFile, nFolder };
}


// ============================================================================
// Main entry point: doClaimSearch
// ============================================================================

/**
 * Handle --claim-search / --claim-file: LLM keyword extraction from patent claim.
 *
 * Runs two search strategies:
 *   TIGHT - literal claim language, narrow NOT terms
 *   BROAD - implementation-level synonyms, alternative mechanisms
 */
export async function doClaimSearch(index, args) {
  // -- Resolve claim text --
  let claimText = null;
  let sourceLabel = null;

  if (args.claim_file) {
    try {
      claimText = fs.readFileSync(args.claim_file, 'utf-8');
      sourceLabel = args.claim_file;
    } catch (e) {
      console.log(`Error reading claim file: ${e.message}`);
      return;
    }
  } else if (args.claim_search) {
    const text = args.claim_search;
    // Support @filename syntax
    if (text.startsWith('@')) {
      const filepath = text.slice(1).trim();
      try {
        claimText = fs.readFileSync(filepath, 'utf-8');
        sourceLabel = filepath;
      } catch (e) {
        console.log(`Error reading claim file: ${e.message}`);
        return;
      }
    } else {
      claimText = text;
      sourceLabel = 'command line';
    }
  }

  if (!claimText || !claimText.trim()) {
    console.log('Error: no claim text provided.');
    return;
  }

  const apiKey = args.api_key || null;
  // Term extraction: --claim-model > --analyze-model > Claude API
  const localModelPath = args.claim_model || args.analyze_model || null;
  const temperature = args.temperature ?? 0.0;
  const showPrompt = args.show_prompt || false;
  const verbose = args.verbose || false;
  const vocabTight = args.vocab_tight || false;
  const noVocabulary = args.no_vocabulary || false;

  // For local GGUF: extract first claim only
  if (localModelPath && !showPrompt) {
    const { text, skipped } = extractFirstClaim(claimText);
    if (skipped > 0) {
      const msg = `Local model: using first claim only (skipped ${skipped} dependent claim(s))`;
      process.stderr.write(`  ${msg}\n`);
      console.log(`NOTE: ${msg}`);
      claimText = text;
    }
  }

  // -- Fetch vocabulary concordance from index --
  let vocabConcordance = '';
  if (!noVocabulary) {
    // Extract claim keywords for relevance filtering
    const claimKeywords = extractClaimKeywords(claimText);
    if (verbose && claimKeywords.size > 0) {
      process.stderr.write(`  Claim keywords (${claimKeywords.size}): ${[...claimKeywords].slice(0, 15).join(', ')}${claimKeywords.size > 15 ? '...' : ''}\n`);
    }

    try {
      const format = localModelPath ? 'compact' : 'rich';
      vocabConcordance = index.formatVocabularyForPrompt(format, {
        topN: localModelPath ? 200 : 300,
        maxSubTokens: localModelPath ? 80 : 150,
        maxFuncNames: localModelPath ? 0 : 40,
        claimKeywords,
      });
      if (vocabConcordance) {
        process.stderr.write(`  Vocabulary concordance: ${vocabConcordance.length} chars (${format} format, claim-filtered)\n`);
      } else {
        process.stderr.write(`  Vocabulary: no claim-relevant terms found in index\n`);
      }
    } catch (e) {
      // Vocabulary is optional - proceed without it
      if (verbose) {
        process.stderr.write(`  Note: vocabulary not available: ${e.message}\n`);
      }
    }
  } else {
    process.stderr.write(`  Vocabulary: disabled (--no-vocabulary)\n`);
  }

  // --show-prompt: display prompt on stderr and exit (no API call)
  if (showPrompt) {
    let promptToShow;
    if (localModelPath) {
      promptToShow = vocabConcordance
        ? buildLocalExtractionPromptWithVocab(vocabConcordance, vocabTight)
        : _CLAIM_EXTRACTION_PROMPT_LOCAL;
    } else {
      promptToShow = vocabConcordance
        ? buildExtractionPromptWithVocab(vocabConcordance, vocabTight)
        : _CLAIM_EXTRACTION_PROMPT;
    }
    const label = localModelPath ? 'LOCAL MODEL PROMPT (combined)' : 'CLAIM EXTRACTION PROMPT (sent as system message to LLM)';
    process.stderr.write('='.repeat(72) + '\n');
    process.stderr.write(` ${label}\n`);
    if (vocabConcordance) {
      process.stderr.write(` (vocabulary-augmented: ${vocabConcordance.length} chars)\n`);
    }
    process.stderr.write('='.repeat(72) + '\n');
    process.stderr.write(promptToShow + '\n');
    process.stderr.write('\n');
    process.stderr.write('='.repeat(72) + '\n');
    process.stderr.write(' USER MESSAGE (the patent claim text)\n');
    process.stderr.write('='.repeat(72) + '\n');
    process.stderr.write(claimText.trim() + '\n');
    return;
  }

  // Echo claim text for self-contained output
  if (sourceLabel) {
    console.log(`Claim source: ${sourceLabel}`);
  }
  console.log(`Claim text (${claimText.length} chars):`);
  for (const line of claimText.trim().split('\n')) {
    const trimmed = line.trim();
    if (trimmed) console.log(`  ${trimmed}`);
  }
  console.log();
  process.stderr.write('Extracting search terms from patent claim...\n');
  console.log();

  // -- Call LLM --
  let result;
  if (localModelPath) {
    // Local model for term extraction via node-llama-cpp
    try {
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
      process.stderr.write(`Loading local model: ${localModelPath}...\n`);
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath: localModelPath });

      // Find workable context size
      let context = null;
      for (const trySize of [8192, 4096, 2048]) {
        try { context = await model.createContext({ contextSize: trySize }); break; }
        catch (_) { /* try smaller */ }
      }
      if (!context) {
        console.log('Error: Cannot allocate context for local model.');
        return;
      }
      process.stderr.write(`OK: Local model loaded (context: ${context.contextSize} tokens).\n`);

      // Combine system prompt + claim text (shorter prompt for local models)
      const basePrompt = vocabConcordance
        ? buildLocalExtractionPromptWithVocab(vocabConcordance, vocabTight)
        : _CLAIM_EXTRACTION_PROMPT_LOCAL;
      const combinedPrompt = basePrompt + '\n\n' +
        'Extract search terms from this patent claim:\n\n' +
        claimText.trim();

      const sequence = context.getSequence();
      const session = new LlamaChatSession({ contextSequence: sequence });
      process.stderr.write('  Sending to local model for term extraction...\n');
      const rawResponse = await session.prompt(combinedPrompt, {
        maxTokens: 2048,
        temperature,
      });
      session.dispose();
      sequence.dispose();
      context.dispose();

      process.stderr.write('  LLM response:\n');
      for (const line of rawResponse.split('\n')) {
        process.stderr.write(`    ${line}\n`);
      }
      result = _parseResponse(rawResponse.trim());
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find/.test(e.message)) {
        console.log('Error: node-llama-cpp not installed. Run: npm install node-llama-cpp');
      } else {
        console.log(`Error loading local model: ${e.message}`);
      }
      return;
    }
  } else {
    result = await extractClaimTerms(claimText, {
      apiKey,
      verbose,
      temperature,
      vocabConcordance,
      vocabTight,
    });
  }

  if (result.error) {
    console.log(`Error: ${result.error}`);
    return;
  }

  let tightStr = result.tight;
  let broadStr = result.broad;

  // Sanitize degenerate output
  if (tightStr) tightStr = sanitizeLlmTerms(tightStr, 'TIGHT');
  if (broadStr) broadStr = sanitizeLlmTerms(broadStr, 'BROAD');
  if (broadStr) broadStr = sanitizeBroadTerms(broadStr);

  const searchOpts = {
    includePath: args.include_path || args.in || null,
    excludePath: args.exclude_path || null,
    maxResults: args.max_results || 10,
    verbose,
  };

  // Parse --min-terms
  const minTermsRaw = args.min_terms || '0';
  let minTerms;
  if (minTermsRaw.toString().toLowerCase() === 'all') {
    minTerms = 9999;
  } else {
    minTerms = parseInt(minTermsRaw, 10);
    if (isNaN(minTerms)) {
      console.log(`Error: --min-terms must be a number or 'all', got '${minTermsRaw}'`);
      return;
    }
  }

  let tightTotal = 0;

  // -- TIGHT search --
  if (tightStr) {
    console.log('='.repeat(72));
    console.log(' TIGHT SEARCH - literal claim language');
    console.log('='.repeat(72));
    console.log(`  Terms: ${tightStr}`);
    console.log();
    const { nFunc, nFile } = _runClaimTier(
      index, 'TIGHT', tightStr, minTerms, searchOpts);
    tightTotal = nFunc + nFile;
  } else {
    console.log('No TIGHT terms extracted.');
  }

  // -- BROAD search --
  if (broadStr) {
    const tightSufficient = tightTotal >= 10;
    console.log();
    console.log('='.repeat(72));
    console.log(' BROAD SEARCH - implementation patterns & alternative mechanisms');
    console.log('='.repeat(72));
    console.log(`  Terms: ${broadStr}`);
    console.log();
    if (tightSufficient && !verbose) {
      console.log(`  BROAD search skipped (TIGHT had ${tightTotal} function+file matches).`);
      console.log('  Use --verbose to run BROAD search, or copy the equivalent command below.');
    } else {
      _runClaimTier(index, 'BROAD', broadStr, minTerms, searchOpts);
    }
  } else {
    console.log('No BROAD terms extracted.');
  }

  // -- Equivalent manual commands --
  console.log();
  console.log('-'.repeat(72));
  console.log('Equivalent manual commands (copy, edit, re-run):');
  if (tightStr) {
    const tTerms = parseMultisectTerms(tightStr);
    const tPos = tTerms ? tTerms.filter(t => !t.negated).length : 0;
    const tMin = (minTerms && minTerms < 9999)
      ? minTerms
      : Math.max(Math.floor(tPos * 0.80), 2);
    console.log(`  TIGHT: --multisect-search "${tightStr}" --min-terms ${tMin}`);
  }
  if (broadStr) {
    const bTerms = parseMultisectTerms(broadStr);
    const bPos = bTerms ? bTerms.filter(t => !t.negated).length : 0;
    const bMin = (minTerms && minTerms < 9999)
      ? minTerms
      : Math.max(Math.floor(bPos * 0.60), 3);
    console.log(`  BROAD: --multisect-search "${broadStr}" --min-terms ${bMin}`);
  }

  // Temperature tip - only if temperature > 0 (non-deterministic)
  const tempUsed = args.temperature ?? 0.0;
  if (tempUsed > 0) {
    console.log();
    console.log(`Tip: LLM temperature was ${tempUsed}. Terms may vary between runs.`);
    console.log(`     Use --temperature 0.0 for deterministic output.`);
  }
}
