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
//   --llm claude    : Anthropic API (needs ANTHROPIC_API_KEY env var)
//   --claim-model   : Local GGUF model via node-llama-cpp (TODO: Phase 8a+)
// ============================================================================

import { parseMultisectTerms, displayMultisectResults, printSelectivityReport } from './multisect.js';
import fs from 'fs';
import https from 'https';
import http from 'http';

// ============================================================================
// LLM Prompt for technical-prose -> search term extraction
// (Inputs are typically patent claims, but also RFCs, standards docs, design
//  specs, etc. — anything that describes a software system in formal prose.)
// ============================================================================

// Low-discrimination bare nouns the TIGHT-extraction prompt instructs the LLM
// to skip. Used both inside the prompt strings below AND by the vocabulary
// builder in CodeSearchIndex.js so the codebase-vocabulary concordance is
// pre-filtered to the same words the prompt is already saying to ignore.
// (Two systems used to have disjoint stop-lists — issue #2 item 5.)
const _LOW_DISCRIMINATION_STOPWORDS = new Set([
  'object', 'data', 'name', 'common', 'version', 'supported', 'requirement',
  'presented', 'matches', 'parameters', 'parameter', 'extensions', 'exchange',
  'application', 'context', 'request', 'response', 'value', 'type',
  'configuration', 'content', 'information', 'operation', 'function',
  'process', 'channel', 'layer', 'format', 'list', 'array', 'table', 'field',
  'record', 'attribute', 'property', 'state', 'client', 'server', 'user',
  'group', 'session', 'key', 'message',
]);
export { _LOW_DISCRIMINATION_STOPWORDS as LOW_DISCRIMINATION_STOPWORDS };

const _CLAIM_EXTRACTION_PROMPT = `\
You are a technical-prose-to-source-code keyword extractor with expertise in \
both formal technical writing (patent claims, standards documents, design \
specs, RFCs) and software engineering implementation patterns.

WHY THIS TASK EXISTS: Technical prose and the source code that implements it \
rarely share vocabulary. A claim may say "establishing a secure communications \
channel" while the code names nothing more than \`openSession()\` or \
\`tlsHandshake()\`. Your job is to bridge that gap — translating the \
standardized, formal nomenclature of the input into the ad-hoc, \
project-specific identifiers an engineer actually chose. Good terms are the \
ones likely to appear verbatim in that codebase, not the ones that sound most \
correct in prose.

INPUT: A technical-prose description of a software system (typically a patent \
claim, but also a specification excerpt, standards-document section, design \
spec, or similar formal description).

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

TIGHT SEARCH - literal source-text language, narrow:
  Purpose: Find code that uses the EXACT terminology from the input.
  Rules:
  - Extract keywords that appear directly in the input text.
  - Use regex only for morphological variants (/exchang|transfer/).
  - NEGATION GATING (apply BEFORE you even consider emitting any NOT term):
    Scan the input text for explicit exclusion language: "without",
    "except", "other than", "instead of", "not including", "rather than",
    "excluding", "absent". You must find one of these literal phrases.
    * If NONE appear: emit ZERO NOT terms. Do NOT invent exclusions.
      NOT is for what the input explicitly disclaims, NOT for what you
      assume is the implicit opposite or the negative of what's mentioned.
      An input about "secure connections" does NOT imply NOT /tcp|udp/.
    * If exclusion language IS present: generate a narrow NOT term for
      ONLY the specific thing excluded — not broader concepts.
      Example: "without utilizing network protocols" -> NOT /protocol|tcp|udp|http/
      (do NOT include bare "network" — too broad, matches "neural network").
  - Skip purely abstract phrasing ("a method comprising", "a system").
  - NEVER include these generic formal-prose boilerplate words as search terms:
    method, device, apparatus, system, step, means, unit, module,
    component, element, embodiment, implementation, comprising, wherein.
    These appear in virtually every source file and provide zero
    discrimination. Only include them if they are PART of a compound
    technical term (e.g. "finite element" is OK, bare "element" is not).
  - Skip generic hardware (CPU, memory) unless they're identifiers.

  HARD MAXIMUM: 12 positive terms. THIS IS NOT A SOFT TARGET. If your \
draft list has more than 12 terms, you MUST PRUNE before emitting.

  ALSO DROP these low-discrimination bare nouns even though they appear in \
the input text - they match too many files in any codebase to be useful:
    object, data, name, common, version, supported, requirement,
    presented, matches, parameters, extensions, exchange, application,
    context, request, response, value, type, configuration, content,
    information, operation, function, process, channel, layer, format,
    list, array, table, field, record, attribute, property, state,
    client, server, user, group, session, key, message.
  Include these ONLY if they are part of a multi-word compound term AND \
the compound term itself appears in the input (e.g. "session key" is \
borderline; just "session" or just "key" alone is NOT acceptable).

  PRUNING ALGORITHM (apply mentally before emitting):
  1. Draft candidate list from the input text.
  2. Drop any bare noun from the low-discrimination list above.
  3. Drop any term that names a generic action verb (perform, configure, \
load, transmit, select, validate, check, confirm) UNLESS the verb itself \
is the discriminative concept of the input (e.g. "handshake" stays).
  4. If still > 12 terms, drop terms in descending order of how many \
unrelated codebases would also match them.
  5. The 12 you keep should be the ones that, taken together, identify \
THIS input distinctly from a generic description on the same broad topic.

  Aim for 5-10 positive terms; emit 12 only if the input is genuinely \
that complex. + any NOT terms.

============================================================================

BROAD SEARCH - implementation-aware, expansive:
  Purpose: Find code that IMPLEMENTS what is described, even if it uses \
completely different terminology. Think like a developer.

  Rules:
  1. IMPLEMENTATION SYNONYMS: What would a developer actually NAME these \
things in code? A "facade server" might be called: wrapper, shim, \
adapter, front_end, proxy, gateway, bridge, middleware. Include these.

  2. NEGATION -> ALTERNATIVE MECHANISMS (CRITICAL):
     When the input says "without utilizing X", this implies the described \
system uses an ALTERNATIVE to X. You MUST generate positive search terms \
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
the described architecture: /adapter|bridge|mediator|facade|proxy|wrapper/

  4. Use regex alternations generously: /term1|term2|term3/ counts as \
ONE search term but matches any of them.

  5. Include alternative mechanisms for each described element, not just \
the literal words. If the input says "exchanging data", a developer \
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
MUST come from the user's input text, NOT from this example.

Example input: "A system comprising a facade server that hosts an application \
and creates an interface to a web-browser for exchanging data, wherein \
the facade server operates without utilizing network protocols and \
without opening network ports."

Example output (DO NOT COPY - these terms are for the facade example above, not the user's input):
TIGHT: /facade|proxy/;server;/browser|web/;interface;/exchang|transfer/;application;host;NOT /protocol|tcp|udp|http/;NOT /port|socket|listen/
BROAD: /facade|proxy|gateway|wrapper|shim|adapter|bridge/;server;/browser|web|front.end/;/interface|adapter|mediator|bridge/;/exchang|transfer|marshal|serial/;/application|app/;/host|embed|in.process|local/;/loopback|localhost|127\\.0\\.0\\.1/;/IPC|ipc|inter.process/;/shared.memory|shm|mmap/;/named.pipe|pipe|fifo/;/cgi.bin|cgi|local.cgi/;/legacy|moderniz|wrapper/;NOT /protocol|tcp|udp|http/;NOT /listen.*port|bind.*port|open.*port/

============================================================================

COUNTER-EXAMPLE (input has NO exclusion language, so output has NO NOT terms):
Note that the prior facade example has "without utilizing" twice in the input
text — that is why it has NOT terms. Most inputs do NOT contain such language.
When the input merely DESCRIBES what something does, without DISCLAIMING anything,
emit ZERO NOT terms.

Example input: "A method for establishing a secure communication connection \
through a computer network, the method comprising: initializing a cryptographic \
context; negotiating cipher parameters; performing a handshake protocol exchange; \
verifying a certificate chain; and transmitting application data over an \
encrypted channel using session keys."

Example output (note: no NOT line because the input has no 'without' / 'except' \
/ 'other than' language anywhere):
TIGHT: /cryptograph|crypto/;/handshake/;/cipher/;certificate;/negotiat/;chain;hostname;session;/encrypt/;/transmit|transfer/
BROAD: /cryptograph|crypto|cipher/;/handshake|hello/;/certificate|cert|x509/;/negotiat|exchang/;/chain|validat/;/hostname|host|fqdn/;/session|sslsession/;/encrypt|tls|ssl/;/transmit|send|write/;/key|secret/

(There would be a NOT line here ONLY if the input said something like "without \
utilizing TLS" or "except via shared memory" — which it does not.)

============================================================================

CRITICAL: The example above is ONLY about a "facade server" example. \
You MUST ignore those example terms entirely and generate NEW terms \
based on the ACTUAL input text the user provides below.
If the user's input is about audio compression, your terms must be about \
audio/compression/codec - NOT facade/server/browser.

Respond with ONLY the two labeled lines. No explanation, no preamble.
Extract terms from the user's ACTUAL input text:
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
 * @param {string} [opts.claudeModel] - Claude API model id override (from --claude-model); takes precedence over opts.model
 * @param {string} [opts.model] - Model name override (legacy programmatic alias)
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
  const model = opts.claudeModel
    || opts.model
    || process.env.CLAIM_SEARCH_MODEL
    || 'claude-sonnet-4-6';
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
Extract search terms from a technical-prose input (patent claim, RFC, \
standards excerpt, design spec, etc.) for a code search tool.

OUTPUT: Exactly two lines:
TIGHT: term1;term2;/regex/;NOT negated;...
BROAD: term1;term2;/regex/;NOT negated;...

SYNTAX:
- Plain text: literal case-insensitive match
- /word1|word2/: regex alternation, matches any of the words
- NOT word: the code must NOT contain this word
- NOT /word1|word2/: negated regex

TIGHT terms: Use the actual technical words from the input text. \
Skip generic boilerplate words: method, system, device, apparatus, comprising, wherein. \
ALSO drop these low-discrimination bare nouns even if they appear in the input: \
object, data, name, common, version, supported, requirement, parameters, \
context, request, response, value, type, content, channel, layer, list, \
field, attribute, property, state, client, server, user, session, key, message. \
Use /regex/ only for morphological variants of the same word. \
HARD MAXIMUM 12 terms. Prune ruthlessly. The 12 you keep should distinguish \
THIS input from a generic description on the same topic.

BROAD terms: Think like a software developer implementing what's described. \
What variable names, function names, and class names would they use? \
Add programming synonyms and design pattern names. \
Use /word1|word2|word3/ to group synonyms as one term. \
Aim for 10-20 terms.

IMPORTANT: Only generate terms based strictly upon the input text below. \
Do NOT invent terms unrelated to its subject matter.

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
    ? `For TIGHT terms: you may also use vocabulary words that appear in the \
input text or are close morphological variants of input words. This can \
improve matching when the codebase uses specific terminology.`
    : `For TIGHT terms: ignore the vocabulary - use only words from the input text.`;

  return _CLAIM_EXTRACTION_PROMPT + `

============================================================================

TARGET CODEBASE VOCABULARY - use this to improve BROAD term generation.

The following vocabulary was extracted from the codebase being searched. \
For BROAD terms, PREFER using words from this vocabulary over guessing \
synonyms. These are actual identifiers, variable names, and function \
names that exist in the code. Map input-text concepts to these terms \
when there is a reasonable semantic connection.

${tightGuidance}

${vocabConcordance}

IMPORTANT: Do NOT include vocabulary terms that have no plausible \
connection to the input text. Only select terms that a developer \
might use to implement the concepts described in the input text.`;
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
export function sanitizeLlmTerms(termsStr, label = '', metaOut = null) {
  if (!termsStr) return termsStr;

  const MAX_ALT_CHARS = 30;
  const MAX_ALT_WORDS = 2;
  // TIGHT should be narrower than BROAD. The LLM tends to over-emit despite
  // prompt instructions ("HARD MAXIMUM 12") so we enforce the cap mechanically.
  const MAX_TERMS = label === 'TIGHT' ? 12 : 20;

  const parts = termsStr.split(';');
  const cleaned = [];
  let nDropped = 0;
  let nTrimmed = 0;
  let nCapped = 0;

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
      // Count remaining non-empty parts as "capped" (not degenerate)
      const tail = parts.slice(parts.indexOf(rawPart) + 1).filter(p => p.trim());
      nCapped += tail.length;
      break;
    }
  }

  if (nDropped > 0 || nTrimmed > 0 || nCapped > 0) {
    process.stderr.write(
      `  [sanitize-${label}] Dropped ${nDropped} degenerate, ` +
      `trimmed ${nTrimmed}, capped ${nCapped} (max ${MAX_TERMS}), kept ${cleaned.length}\n`
    );
  }

  if (metaOut) {
    metaOut.llm_emitted = cleaned.length + nDropped + nTrimmed + nCapped;
    metaOut.kept = cleaned.length;
    metaOut.dropped = nDropped;
    metaOut.trimmed = nTrimmed;
    metaOut.capped = nCapped;
    metaOut.max_terms = MAX_TERMS;
  }

  return cleaned.join(';');
}


/**
 * Acronym whitelist for sanitizeBroadTerms: legitimate short tokens
 * (< 4 chars) that survive the regex-alternate length floor. Curated
 * from the protocol / standards / web domain. NOTE: whitelisted
 * acronyms still match as bare substrings in multisect — word-boundary
 * matching for short terms is tracked separately (issue #3 item 1).
 */
const _SHORT_TERM_WHITELIST = new Set([
  'ssl', 'tls', 'tcp', 'udp', 'rpc', 'api', 'ca', 'cn', 'san',
  'x509', 'jwt', 'uri', 'url', 'dns', 'ip',
]);


/**
 * Remove too-short alternations from BROAD regex terms.
 *
 * Multisect matching is per-line, case-insensitive, substring — so a
 * short alternate like /subject|san|cn/ leaks ('san' matches the 'san'
 * inside 'isAnonymous'). Drop alternates shorter than 4 chars unless
 * they are whitelisted acronyms (_SHORT_TERM_WHITELIST).
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
      const longEnough = (a) => {
        const t = a.trim();
        return t.length >= 4 || _SHORT_TERM_WHITELIST.has(t.toLowerCase());
      };
      const filtered = alts.filter(longEnough);

      if (filtered.length < origCount) {
        const dropped = alts.filter(a => !longEnough(a));
        nFixed++;
        process.stderr.write(
          `  [sanitize] Removed short alternation(s) [${dropped}] from ${inner}\n`
        );
      }

      if (filtered.length === 0) {
        process.stderr.write(`  [sanitize] Dropping term ${part} (all alternations too short)\n`);
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
      `  [sanitize] Fixed ${nFixed} term(s) with short alternations\n`
    );
  }

  return cleaned.join(';');
}


/**
 * Enforce the prompt's drop-list on the LLM's own output (issue #3 item 1).
 *
 * The extraction prompt instructs the LLM to skip low-discrimination bare
 * nouns (LOW_DISCRIMINATION_STOPWORDS), but the model emits them anyway
 * because they are plausible code identifiers. This applies the same
 * stop-list server-side, to both TIGHT and BROAD:
 *
 *  - a bare term in the stop-list is dropped
 *  - a regex alternate /a|b|c/ has its stop-listed alternates removed;
 *    if every alternate is stop-listed the whole term is dropped, and a
 *    single survivor collapses back to a bare term
 *  - a bare term that also appears as an alternate inside a surviving
 *    regex term is dropped as a duplicate (the 'cipher' case)
 *
 * NOT terms pass through untouched — an explicit exclusion of a generic
 * word is still meaningful.
 */
export function dropStopListedTerms(termsStr, label = '') {
  if (!termsStr) return termsStr;

  const STOP = _LOW_DISCRIMINATION_STOPWORDS;
  const parts = termsStr.split(';').map(p => p.trim()).filter(Boolean);

  // Pass 1: drop stop-listed bare terms and stop-listed regex alternates.
  const kept = [];
  let nDropped = 0;
  let nTrimmed = 0;

  for (const part of parts) {
    let inner = part;
    if (inner.toUpperCase().startsWith('NOT ')) {
      kept.push(part);  // NOT terms pass through unchanged
      continue;
    }

    if (inner.startsWith('/') && inner.endsWith('/')) {
      const alts = inner.slice(1, -1).split('|').map(a => a.trim()).filter(Boolean);
      const goodAlts = alts.filter(a => !STOP.has(a.toLowerCase()));
      if (goodAlts.length === 0) { nDropped++; continue; }
      if (goodAlts.length < alts.length) nTrimmed++;
      kept.push(goodAlts.length === 1 ? goodAlts[0] : '/' + goodAlts.join('|') + '/');
    } else {
      if (STOP.has(inner.toLowerCase())) { nDropped++; continue; }
      kept.push(part);
    }
  }

  // Pass 2: dedupe bare terms already covered by a surviving regex alternate.
  const altMembers = new Set();
  for (const part of kept) {
    let inner = part;
    if (inner.toUpperCase().startsWith('NOT ')) inner = inner.slice(4).trim();
    if (inner.startsWith('/') && inner.endsWith('/')) {
      for (const a of inner.slice(1, -1).split('|')) {
        altMembers.add(a.trim().toLowerCase());
      }
    }
  }

  const deduped = [];
  let nDeduped = 0;
  for (const part of kept) {
    const isNot = part.toUpperCase().startsWith('NOT ');
    const isRegex = part.startsWith('/') && part.endsWith('/');
    if (!isNot && !isRegex && altMembers.has(part.toLowerCase())) {
      nDeduped++;
      continue;
    }
    deduped.push(part);
  }

  if (nDropped > 0 || nTrimmed > 0 || nDeduped > 0) {
    process.stderr.write(
      `  [sanitize-stoplist${label ? '-' + label : ''}] ` +
      `Dropped ${nDropped} stop-listed, trimmed ${nTrimmed}, ` +
      `deduped ${nDeduped}, kept ${deduped.length}\n`
    );
  }

  return deduped.join(';');
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
      claudeModel: args.claude_model,
    });
  }

  if (result.error) {
    console.log(`Error: ${result.error}`);
    return;
  }

  let tightStr = result.tight;
  let broadStr = result.broad;

  // Sanitize degenerate output.
  // Drop stop-listed terms first, so the term cap in sanitizeLlmTerms
  // applies to the already-cleaned set rather than counting junk.
  if (tightStr) tightStr = dropStopListedTerms(tightStr, 'TIGHT');
  if (broadStr) broadStr = dropStopListedTerms(broadStr, 'BROAD');
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
