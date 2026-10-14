// answer-disclosure.js — appends a post-hoc note stating what a declining answer actually searched, rather than scoring refusals
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// answer-disclosure.js — #306 fix-list item 5 (F55, F56).
//
// CE catches "claimed without looking": ungroundedWarning() fires when a grounded
// run makes zero tool calls. NOTHING caught "declined without looking". F55's
// case, measured on Gemma-3-12B-QAT over .ExoPlayer3:
//
//   tools called (24): search, search, … search        182 s
//   "…it is not determinable from the code…"
//
// Twenty-four calls, ONE distinct tool, then a refusal. It looks like a thorough
// investigation and is not one.
//
// WHY THIS IS A DISCLOSURE AND NOT A DETECTOR
// -------------------------------------------
// The item was first specified as a threshold detector — fire on
// (toolCalls <= 1) or (toolCalls >= 5 && distinctTools === 1). Scored against
// asus-CC's eleven real Chat captures that catches 9 of 10 refusals, and misses
// a genuine one at 8 calls / 3 distinct tools. Worse, a threshold is gameable in
// the direction that matters: two calls instead of one silences it without the
// investigation improving. That is the same disease as the tool-call floor's
// counter and the first cut of this very detector — which, run against batch 3,
// would have scored a regression as a fix.
//
// So there is no threshold and no score. On a declining answer CE states what the
// investigation WAS and lets the reader judge, exactly as the cap footers and
// models_used now state what was actually searched. Nothing to tune, nothing to
// game, no false negatives among the fixtures.
//
// THE REFUSAL MATCH IS DELIBERATELY GENEROUS
// -------------------------------------------
// The asymmetry decides it: a false positive appends a TRUE factual sentence to a
// real answer, while a false negative silently drops the disclosure. So match
// loosely and let the note's own wording carry the hedge.
//
// AND IT NEVER REACHES THE MODEL
// -------------------------------
// The note is appended to the finished answer, after generation, for the READER.
// The Chat preamble also drops prior assistant answers by construction, so it
// cannot re-enter context on a later turn either. This matters: under the
// standing constraint that a client receives exactly what CE produced, an honest
// refusal is CORRECT output. F55 files unearned refusal as *the* defect, which
// holds for Chat-as-assistant and INVERTS for CE-as-evidence-tool. Nudging a
// model away from refusing would trade the safe failure for the dangerous one.

// Explicit phrasings, each traceable to a capture rather than imagined. Kept
// narrow enough that the one ANSWER in the fixture set — which contains
// "doesn't correctly identify" and "don't involve" — matches none of them.
const REFUSAL_PATTERNS = [
  /\bnot determinable\b/i,                                  // "it is not determinable from the code"
  /\bunable to (?:find|locate|determine)\b/i,                // "I am unable to find a function or file named …"
  /\b(?:is|was|are|were) not found in the (?:codebase|index|code)\b/i, // "The term X is not found in the codebase."
  /\bcannot (?:describe|determine|answer|say|tell|provide|identify)\b/i,
  /\bcould not (?:find|locate|determine)\b/i,
  /\bdoes not contain information\b/i,                       // "The code does not contain information about …"
  /\bno (?:information|evidence) (?:about|for|on)\b/i,
];

/**
 * Does this answer decline to conclude? Generous by design — see the header.
 * @param {string} text the model's finished answer
 */
export function looksLikeRefusal(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(s));
}

const _plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The disclosure line for a declining answer, or '' when none applies.
 *
 * Reports the calls whose results the model actually SAW — the caller passes the
 * recorded tool_use blocks, which is the same population `[chat] local final
 * answer … (N tool calls)` already logs. Budget-stopped and duplicate calls
 * return early without producing a result, so counting them would overstate the
 * investigation, which is the opposite of the point.
 *
 * @param {string} prose the finished answer
 * @param {string[]} toolNames tool name per recorded call, in order
 */
export function answerDisclosure(prose, toolNames = []) {
  if (!looksLikeRefusal(prose)) return '';
  const names = (toolNames || []).map(String).filter(Boolean);
  const distinct = [...new Set(names)];
  const basis = names.length === 0
    ? 'without calling any tools'
    : `on ${_plural(names.length, 'tool call')} using ${_plural(distinct.length, 'distinct tool')} (${distinct.join(', ')})`;
  return `\n\n…*[CodeExam: the answer above declines to conclude, ${basis}. `
    + `A refusal can be the correct answer — this records what the investigation was, not a judgement of it.]*`;
}

// ---------------------------------------------------------------------------
// AI/ML SENTENCE VERIFICATION (#306 F70, after asus-CC's reversal).
//
// The measured failure is NOT a bad tool. Run against nine corpora, `models_used`
// was right every time and the prose was wrong in six:
//
//   .as_ml_code   prose named an API KEY FRAGMENT; tool returned 22 real models
//   .CrewAI       prose "Anthropic, Bedrock"; tool returned gpt-4o-mini, ada-002
//   .TreeOfThought  tool returned "No model ids found - do not infer absence"
//                   and the prose still wrote "including GPT-4"
//
// That last one is the reason this exists. `ae04e4b` fixed the tool and the model
// wrote over it IN THE SAME RUN — a tool-level disclosure defeated at the prose
// layer. Cap footers, populations, the PARTIAL clause and models_used all improve
// what the model is TOLD; none of them constrains what it WRITES.
//
// The pressure is structural: ai-overview.js mandates ONE AI/ML sentence, and 29
// of 29 non-degenerate overviews asserted one. A slot that cannot be empty gets
// filled with whatever is nearest — in .as_ml_code, a credential sitting in a
// `search` result.
//
// Rewording the mandate is NOT the fix, by our own evidence: F34 (a prompt edit
// is a per-model coefficient), sixteen floor nudges moving zero cells, and
// 4fab531 removing the prose section outright.
//
// So CE checks its own output against ground truth IT ALREADY HOLDS. No model
// judgment, no threshold, no second inference — a diff between two things in
// hand. ungroundedWarning is the register: observe a mechanism, and be allowed to
// say nothing.
//
// IT REPORTS, IT DOES NOT CLASSIFY. Deciding "is Anthropic a model" is exactly
// the judgment call that would make this a proxy. The note states which names the
// sentence used and which of them the tool did not return, and lets the reader
// judge. That keeps it true even when a name is a vendor or a framework rather
// than a fabrication.

// Sentences that could carry the mandated claim. Scoped to model-mentioning
// sentences so ordinary prose (file names, function names) is not scanned.
//
// THE `\s+` AFTER THE TERMINATOR IS LOAD-BEARING — do not "simplify" this to a
// bare /[.!?]/ split. Model ids carry dots, and asus-CC's own extractor split
// `.image_vision` INSIDE one:
//
//   Three local models are used: `vqgan_imagenet_f16_1024.   <- truncated here
//
// then reported the surviving fragment as unsupported — a false footnote on the
// most faithful overview in the set. Requiring whitespace after the terminator
// means `…_1024.ckpt` is not a boundary. Pinned by a test naming that fixture.
//
// overview-aiml-footnote-false-positives, class A: "model" is also an English
// word. On a Claude overview of the Ghost Architect index (2026-10-13), "uses
// a hub-and-spoke model: …" and "the offline model" were selected, and every
// function name and path in them was compared against models_used. A sentence
// is a model sentence only when it ALSO carries an AI/ML cue: an AI term, a
// model family or vendor, a weights/checkpoint extension, a parameter size
// (7B), a model-shaped token (GPT-4, FakeNet-9000), "local model(s)" / "model
// locally", or a load/call/train verb near "model". "uses … model" is NOT a cue
// (that is how "uses a hub-and-spoke model" reads) and "load balancing" is not
// the load verb. The nine verbatim sweep sentences pin the list from the other
// side: every one of them must still be scanned.
const _AI_CUE = new RegExp([
  String.raw`\b(?:AI\/?ML|AI|ML|LLMs?|machine[- ]?learning|deep[- ]?learning|neural|inference|embeddings?|checkpoints?|weights|quantiz\w*|fine-?tun\w*|transformers?|models?_used|GGUF|ONNX|safetensors|Hugging ?Face|Ollama|OpenAI|Anthropic|Claude|GPT|Gemini|Gemma|Llama|Qwen|Mistral|DeepSeek|Phi|BERT|ResNet|YOLO)\b`,
  String.raw`\.(?:gguf|ckpt|safetensors|onnx|h5|pt|pth|bin)\b`,
  String.raw`\b\d+[bB]\b`,
  String.raw`\b[A-Za-z]+(?:[-_][A-Za-z0-9]+)*[-_]\d[\w.]*\b`,
  String.raw`\blocal\s+(?:\w+\s+){0,2}models?\b`,
  String.raw`\bmodels?\s+(?:\w+\s+){0,2}locally\b`,
  String.raw`\b(?:loads?(?!\s*balanc)|loaded|loading|calls?|called|calling|trains?|trained|training|infer\w*|invok\w*|serv(?:e|es|ed|ing)|hardcoded|hard-coded|declared)\b[^.;!?]{0,60}\bmodels?\b`,
  String.raw`\bmodels?\b[^.;!?]{0,60}\b(?:loads?(?!\s*balanc)|loaded|calls?|called|trained|served|invoked|hardcoded|hard-coded|declared|detected|found)\b`,
].join('|'), 'i');

function modelSentences(prose) {
  // #320 1b: drop CE's OWN ⓘ disclosure lines before scanning. The guard's two
  // observed false positives were CE footnoting its own banner — "the model
  // made 5 tool call(s)" matches /\bmodels?\b/, and "RECOVERED", "OUTPUT"
  // shape like names. Every CE-voice note starts its line with ⓘ, so a
  // line-level filter removes exactly CE's text and none of the model's.
  const withoutCeNotes = String(prose || '')
    .split('\n')
    .filter((line) => !/^\s*ⓘ/.test(line))
    .join('\n');
  return withoutCeNotes
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => /\bmodels?\b/i.test(s) && _AI_CUE.test(s));
}

// A model-mentioning sentence that DENIES: a negation BESIDE the thing denied.
// The observed shapes: "does not explicitly load or call any AI/ML models…",
// "No AI/ML models are explicitly detected…", and — class D, from Ernst
// Wisner's Ghost case — "No model IDs are hardcoded as literals", "model
// identifiers are config-driven at runtime, not literal strings".
//
// Class H (iterate round 1): a negation ANYWHERE plus a topic ANYWHERE was too
// loose. On the post-fix Ghost run it read "treat them as examples of a
// provider-agnostic slot, not as live API identifiers" — a sentence that
// affirms the ids and comments on their naming — as a denial, and CE
// contradicted a correct sentence with its own table. So the negation must
// sit within six tokens before the topic ("not explicitly load or call any
// AI/ML models") or the topic within three tokens before the negation ("the
// models are not called"). "none are hardcoded as the sole runtime target" is
// not a denial of models either; "hardcoded" is not a topic on its own.
const _NEG_TOK = String.raw`(?:no|not|none|neither|without|never|lacks?|lacking|absent)`;
const _TOPIC = String.raw`(?:AI\/?ML models?|AI models?|machine[- ]?learning models?|models?|model[- ]?(?:ids?|names?|identifiers?)|literal strings?|literals?)`;
const _DENIAL_FWD = new RegExp(String.raw`\b${_NEG_TOK}\b\W+(?:[\w/'’-]+\W+){0,6}${_TOPIC}\b`, 'i');
const _DENIAL_REV = new RegExp(String.raw`\b${_TOPIC}\b\W+(?:[\w/'’-]+\W+){0,3}${_NEG_TOK}\b`, 'i');
function isDenial(s) { return _DENIAL_FWD.test(s) || _DENIAL_REV.test(s); }

// A hyphen-joined token counts as a name only if every part is a digit run or a
// letter run of 2+ — so `GPT-4`, `text-embedding-ada-002`, `deepseek-vl2` and
// `Qwen-72B-Chat` survive while ordinary adjectives like `cloud-based` do not.
// `GPT-4` is what makes this fiddly: a rule that rejected letters-then-digits
// would drop the .TreeOfThought case, which is the one that matters most.
function hyphenShapeOk(t) {
  if (!t.includes('-')) return true;
  const parts = t.split('-').filter(Boolean);
  if (parts.length < 2) return true;
  // At least one part must be digit-bearing; otherwise it reads as English.
  return parts.some((p) => /\d/.test(p));
}

// Candidate names, deliberately inclusive: the confabulated set spans backticked
// tokens, ALLCAPS (XLA), CamelCase (TensorFlow), hyphen+digit (GPT-4), snake_case
// (oai_text_embedding) and plain capitalised vendors (Anthropic, Cohere). A
// narrow "model-shaped" rule missed five of nine, so breadth is the point and the
// note's wording carries the hedge.
const _STOP = new Set(['AI', 'ML', 'AI/ML', 'API', 'CE', 'CodeExam', 'The', 'This', 'It', 'A', 'An',
  'No', 'None', 'I', 'GPU', 'CPU', 'LLM', 'LLMs', 'SDK', 'CLI', 'README', 'models_used', 'ID', 'IDs']);
// "e.g", "i.e", "a.k.a": a dotted token whose parts are all one or two
// characters is an abbreviation. A model id with a dot keeps a longer part on
// at least one side (`gpt-4.1`, `llama3.1`, `model.ckpt`).
const _ABBREV = (t) => t.includes('.') && t.split('.').every((p) => p.length <= 2);
// Class E: ALLCAPS_WITH_UNDERSCORES is an environment variable (OPENAI_API_KEY,
// GHOST_LOCAL_DATA_DIR), never a model id. A credential VALUE (the as_ml_code
// case, mixed case with digits) does not have this shape and is still caught.
const _ENV_VAR = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
// Class F (iterate round 1): a camelCase identifier with no digit (`callModel`,
// `getModelProviderConfig`, selectModelForTask) is a code symbol, never a model
// id. The credential value that motivated the internal-capital rule below
// carries digits and is still caught. Applies to backticked tokens too, which
// the shape rules otherwise bypass.
const _CAMEL_IDENT = /^[a-z][a-zA-Z]*[A-Z][a-zA-Z]*$/;
// Class I (iterate round 2, the CLI cloud run): CodeExam's own `file@function`
// notation (`model-provider.js@callModel`) is a code reference, and a
// backticked span with whitespace (`digest model-provider.js@callModel`,
// `call_tree x depth:2`) is a command or a phrase — neither is a model id. A
// `<digits>-<word>` compound ("864-line", "2-layer") is English; a model id
// never opens with bare digits.
const _CODE_REF = /^[\w./-]+@[\w.$-]+$/;
const _NUM_WORD = /^\d+-[a-z]+$/;

export function namesInModelSentences(prose) {
  const out = new Set();
  for (const s of modelSentences(prose)) {
    // Class E: a sentence that DENIES models makes no model claim to verify.
    // The names in it (an env var, a backend, a config file) are context; the
    // denial itself is the converse check's business (aimlConverseNote). On
    // the Ghost overview, "No model IDs are hardcoded … but ANTHROPIC_API_KEY is
    // read in config.js and Ollama is the default backend" footnoted all three.
    if (isDenial(s)) continue;
    // Quoted / backticked spans WITHOUT whitespace are taken verbatim (a model
    // id never contains a space); a span with whitespace is left to the bare
    // pass below, so its words are still seen one by one.
    for (const m of s.matchAll(/`([^`\s]{2,60})`|"([^"\s]{2,60})"/g)) {
      const q = (m[1] || m[2]).trim();
      if (_ENV_VAR.test(q) || _CAMEL_IDENT.test(q) || _ABBREV(q) || _CODE_REF.test(q)) continue;
      // A backticked plain lowercase word (`dispatch`, `queue`) is an identifier
      // unless it is a model family name (`llama`, `qwen`), which the shape
      // rule knows.
      if (/^[a-z]+$/.test(q) && !_MODEL_SHAPED.test(q)) continue;
      out.add(q);
    }
    // Bare tokens; drop the sentence's first word so a leading "The" is not a name.
    const bare = s.replace(/`[^`\s]*`|"[^"\s]*"/g, ' ').replace(/[`"]/g, ' ').trim().split(/\s+/).slice(1);
    for (const raw of bare) {
      // `.` stays inside the allowed set because model ids carry it
      // (`model.ckpt`), but never at the END of one: a trailing period, paren
      // or comma is sentence punctuation, stripped in any order ("Phi-4)." was
      // left as "Phi-4)" when the period came off first — class I).
      const t = raw.replace(/^[^A-Za-z0-9_.\-/]+|[^A-Za-z0-9_\-/]+$/g, '')
        .replace(/['’]s$/, '');   // possessive: "OpenAI's models" names OpenAI
      if (t.length < 3 || _STOP.has(t) || _ENV_VAR.test(t) || _CAMEL_IDENT.test(t) || _ABBREV(t)) continue;
      if (_CODE_REF.test(t) || _NUM_WORD.test(t)) continue;
      if (!hyphenShapeOk(t)) continue;
      // `[a-z][A-Z]` earns its place: the credential fragment that motivated this
      // whole item (`uqDZ…SPdJ`) has no digit, no separator and a lowercase first
      // character, so the other three rules all miss it. Internal capitals catch
      // both opaque high-entropy tokens and ordinary camelCase names, and no
      // English word has them.
      const shaped = /[0-9]/.test(t) || /[_\-./]/.test(t) || /^[A-Z]/.test(t) || /[a-z][A-Z]/.test(t);
      if (shaped && /[A-Za-z]/.test(t)) out.add(t);
    }
  }
  return [...out];
}

/**
 * Names the AI/ML sentence used that the tool output does not contain.
 * Substring match against the raw tool text, so "Qwen 7B" matching a listed
 * "Qwen-7B-Chat" row counts as supported — the test is "did the tool mention
 * this", not "is this an exact id".
 */
export function unsupportedModelNames(prose, modelsUsedOutput, seedText, indexPaths = null) {
  const hay = String(modelsUsedOutput || '').toLowerCase();
  if (!hay) return [];
  // A FILE CE ITSELF INDEXED is supported evidence, and the most authoritative
  // kind: CE read it. Without this, a markdown-formatted path in a sentence
  // containing the word "model" gets footnoted as an invented model id —
  // measured on .GhostArch, where the prose cited `src/model-provider.js`
  // (a file CE had just digested) and CE footnoted its own overview.
  //
  // The quoted/backticked branch of namesInModelSentences() is what lets this
  // through: it adds the span verbatim, bypassing the hyphenShapeOk() filter
  // that correctly rejects the same path unquoted. So the trigger is the
  // model writing ordinary markdown, which it always does.
  //
  // Deliberately narrow: only candidates that LOOK like a file reference get
  // the carve-out, matched by whole path or path suffix. A bare word must not
  // become "supported" because some file happens to contain it as a substring.
  const paths = indexPaths ? [...indexPaths].map((p) => String(p).toLowerCase().replace(/\\/g, '/')) : null;
  const indexedFile = (needle) => {
    if (!paths || !paths.length) return false;
    if (!looksLikePathRef(needle)) return false;
    const n = needle.replace(/\\/g, '/');
    return paths.some((p) => p === n || p.endsWith('/' + n));
  };
  // #320 1c seed-aware: a name the deterministic overview seed contains is
  // supported evidence too. Gemma K_M's CORRECT sr_gh sentence cited
  // `Qwen_Qwen1_5_0_5B_Chat_e5_lr0` — a filename from the seed's vocabulary
  // lines, not one of models_used's 21 ids — and must not be footnoted.
  const seedHay = String(seedText || '').toLowerCase();
  // Class G (iterate round 1): a vendor named in the prose is supported when
  // the table holds an id of that vendor's family — "Anthropic, OpenAI,
  // Google" against claude-*, gpt-*, gemini-* rows is the table restated by
  // maker, not an invention. A vendor whose family is absent is still
  // reported (the .CrewAI "Anthropic and Bedrock" against an all-OpenAI table).
  const supported = (needle) => {
    const fam = _VENDOR_FAMILY[needle];
    return hay.includes(needle) || (seedHay && seedHay.includes(needle)) || indexedFile(needle)
      || (fam && fam.test(hay));
  };
  return namesInModelSentences(prose).filter((n) => {
    const needle = n.toLowerCase();
    if (supported(needle)) return false;
    // Class I: a slash-joined pair in prose ("GPT-4o/GPT-5") is two names; it
    // is supported when every part is. An HF id (`Qwen/Qwen-7B-Chat`) is
    // matched whole first, above.
    if (needle.includes('/')) {
      const parts = needle.split('/').filter(Boolean);
      if (parts.length > 1 && parts.every(supported)) return false;
    }
    return true;
  });
}

const _VENDOR_FAMILY = {
  anthropic: /\bclaude\b|claude-/i,
  openai: /\bgpt[-_\d]|\bo[134]\b|text-embedding|davinci|chatgpt/i,
  google: /gemini|gemma|palm/i,
  meta: /llama/i,
  mistral: /mistral|mixtral/i,
  deepseek: /deepseek/i,
  microsoft: /\bphi[-\d]/i,
  cohere: /command-r|cohere/i,
  alibaba: /qwen/i,
  // Ollama is a backend, not a family: an Ollama `name:tag` id in the table is
  // the evidence that it is in use.
  ollama: /\b(?=[\w.:-]*\d)[a-z][\w.-]*:[\w.-]+\b/i,
};

/**
 * A candidate that LOOKS like a file reference (a path separator, or a short
 * extension) — the only kind the indexed-path carve-out applies to, and the
 * trigger for the cloud path to fetch the file list at all (class C). One
 * definition, shared by both, so they cannot drift.
 */
export function looksLikePathRef(name) {
  const n = String(name || '');
  return /[\\/]/.test(n) || /\.[a-z0-9]{1,5}$/i.test(n);
}

/**
 * The file list as the MCP `list_files` tool prints it ("N files (showing M):"
 * then one path per line, then a "... K more not shown" footer when capped) →
 * the paths. The cloud overview loop has no in-process index and gets its
 * indexed paths this way (class C); the local and GUI loops pass
 * index.files.keys() directly.
 */
export function indexPathsFromListFiles(text) {
  const lines = String(text || '').split('\n');
  if (lines.length < 2 || !/^\d+ files?\b/.test(lines[0])) return [];
  return lines.slice(1).map((l) => l.trim()).filter((l) => l && !/^\.\.\.\s/.test(l) && !/^\(/.test(l));
}

// Class B: on a zero-id table the only comparison that carries information is
// against a name that is itself model-shaped — a digit-bearing token (GPT-4,
// a credential value), a weights file, or a known family. Vendors and
// frameworks ("Ollama", "TensorFlow") are compared on positive tables, where
// the breadth earns its keep; on a zero-id table they would be "not contained"
// by construction.
const _MODEL_SHAPED = /\d|\.(?:gguf|ckpt|safetensors|onnx|h5|pt|pth|bin)$|^(?:gpt|claude|gemini|gemma|llama|qwen|mistral|mixtral|deepseek|phi|bert|resnet|yolo|whisper|codellama)\b/i;

/**
 * The footnote, or '' when the sentence is fully supported — or when CE has no
 * tool output to check against, which is the "allowed to say nothing" case.
 *
 * Class B (overview-aiml-footnote-false-positives): when models_used found no
 * ids, the haystack is the tool's negative boilerplate and every name in every
 * selected sentence is "not contained" by construction. On the Ghost overview
 * that footnoted a correct sentence and reproduced 1,200 characters of
 * loader-search advice under it. So on a zero-id table only model-shaped names
 * are compared, the reproduction is the tool's first sentence, and an affirming
 * AI/ML sentence with nothing shaped to check gets one line saying so.
 */
export function aimlVerificationNote(prose, modelsUsedOutput, seedText, indexPaths = null) {
  const out = String(modelsUsedOutput || '').trim();
  if (!out) return '';
  const unsupported = unsupportedModelNames(prose, out, seedText, indexPaths);
  if (modelsUsedCount(out) === 0) {
    const shaped = unsupported.filter((n) => _MODEL_SHAPED.test(n));
    if (!shaped.length) {
      const affirming = modelSentences(prose).some((s) => !isDenial(s));
      return affirming
        ? `\n\nⓘ CodeExam's own \`models_used\` found no literal model ids in this index; the AI/ML sentence above was not checked against it.`
        : '';
    }
    const listed = shaped.slice(0, 8).map((n) => `"${n}"`).join(', ');
    const more = shaped.length > 8 ? ` (+${shaped.length - 8} more)` : '';
    const firstLine = out.split(/(?<=[.!?])\s+|\n/)[0];
    return `\n\nⓘ AI/ML SENTENCE UNVERIFIED: the prose above names ${listed}${more}, and CodeExam's own `
      + `\`models_used\` found no literal model ids in this index. This is a mechanical comparison, not a `
      + `judgement — an id resolved at run time would not be found — but nothing here was read out of the index.`
      + `\n\n<models_used>\n${firstLine}\n</models_used>`;
  }
  if (!unsupported.length) return '';
  const listed = unsupported.slice(0, 8).map((n) => `"${n}"`).join(', ');
  const more = unsupported.length > 8 ? ` (+${unsupported.length - 8} more)` : '';
  return `\n\nⓘ AI/ML SENTENCE UNVERIFIED: the prose above names ${listed}${more}, which `
    + `CodeExam's own \`models_used\` result for this index does NOT contain. That result is `
    + `reproduced below. This is a mechanical comparison, not a judgement — a name may be a `
    + `vendor or framework rather than a model — but nothing here was read out of the index.`
    + `\n\n<models_used>\n${String(modelsUsedOutput).trim().slice(0, 1200)}\n</models_used>`;
}

// ---------------------------------------------------------------------------
// #320 1c: the CONVERSE check — the direction that was actually wrong.
//
// The UNVERIFIED footnote above catches INVENTED names; it is structurally
// silent when the prose says "no AI/ML" and the tool disagrees, because it
// scans names the prose used, and "none detected" uses none. asus-CC's 11-run
// matrix: one wrong answer in the suite (qwen3-14b, "No AI/ML models are
// explicitly detected" on an index where models_used returns 21), unflagged.
// ---------------------------------------------------------------------------

// The positive models_used output opens "N models used — X api, Y local"
// (metrics.js doListModelsUsed); the negative path prints the scope/recover
// prose with no such line. Deterministic on the header, not on absence.
export function modelsUsedCount(modelsUsedOutput) {
  const m = String(modelsUsedOutput || '').match(/\b(\d+)\s+models? used\b/i);
  return m ? Number(m[1]) : 0;
}

// #345: the headline adds "; N declared only (no call site)" when rows are
// model-shaped literals in code that no call site consumed.
export function modelsUsedDeclaredOnly(modelsUsedOutput) {
  const m = String(modelsUsedOutput || '').match(/;\s*(\d+)\s+declared only\b/i);
  return m ? Number(m[1]) : 0;
}

// Class D: a denial of CALLING ("does not call any AI/ML models") is not
// contradicted by a table whose rows are all declared-only — those rows say
// "no call site" themselves. A denial of presence, detection, ids or literals
// is contradicted by any row.
const _CALL_DENIAL = /\b(?:loads?|loaded|calls?|called|invokes?|invoked|runs?|uses?|used|utiliz\w+|executes?|queries|querying|inference)\b/i;
const _PRESENCE_DENIAL = /\b(?:detected|identified|found|present|exists?|hardcoded|hard-coded|declared|named|written|literals?|ids?|identifiers?|names?)\b/i;

function denialSentences(prose, declaredOnly = 0, total = 0) {
  return modelSentences(prose).filter(isDenial).filter((s) => {
    const callOnly = _CALL_DENIAL.test(s) && !_PRESENCE_DENIAL.test(s);
    return !(callOnly && declaredOnly > 0 && declaredOnly >= total);
  });
}

/**
 * The converse footnote, or ''. Fires when models_used reports models and the
 * prose denies any — appended, never rewritten, same contract as the
 * UNVERIFIED note. `selfCalled` says CE ran the tool for verification (the
 * model never saw it), which the note discloses.
 */
export function aimlConverseNote(prose, modelsUsedOutput, { selfCalled = false } = {}) {
  const n = modelsUsedCount(modelsUsedOutput);
  if (!n) return '';
  const declaredOnly = modelsUsedDeclaredOnly(modelsUsedOutput);
  const denials = denialSentences(prose, declaredOnly, n);
  if (!denials.length) return '';
  const quoted = denials[0].trim().slice(0, 160);
  const how = selfCalled
    ? 'CodeExam ran `models_used` itself for this check; the model did not call it and never saw the result'
    : 'the model called `models_used` and still wrote this';
  const what = declaredOnly
    ? ` (${declaredOnly >= n ? 'all' : declaredOnly} of them declared in the code with no call site found)`
    : '';
  return `\n\nⓘ AI/ML CLAIM CONTRADICTED: the prose above says "${quoted}", but CodeExam's own `
    + `\`models_used\` result for this index reports ${n} model${n !== 1 ? 's' : ''}${what} (${how}). `
    + `The result is reproduced below; nothing here was read out of the index.`
    + `\n\n<models_used>\n${String(modelsUsedOutput).trim().slice(0, 1200)}\n</models_used>`;
}

// ---------------------------------------------------------------------------
// #320 item 4: the evidentiary footer — every --overview-by-AI answer states
// its basis. "Based on 1 tool call: overview" tells the reader in one line
// that they got a paraphrase of the deterministic --overview, not a second
// independent view; that disclosure is the point (independence cannot be
// enforced — 16 nudges, zero additional distinct calls — so it is disclosed).
// ---------------------------------------------------------------------------

/**
 * @param {Map<string,number>|Object} counts per-tool call counts (model-chosen
 *   calls only — prefetch/substitution are disclosed via `opts`, never counted
 *   here, so the number keeps meaning "calls the MODEL chose to make").
 * @param {Object} opts { substituted: string[] CE ran on the model's behalf,
 *   prefetched: bool, selfCalledModelsUsed: bool (verification-only call) }
 */
export function toolCallFooter(counts, { substituted = [], prefetched = false, selfCalledModelsUsed = false } = {}) {
  const entries = counts instanceof Map ? [...counts.entries()] : Object.entries(counts || {});
  const total = entries.reduce((a, [, n]) => a + n, 0);
  let line;
  if (!total) {
    line = `ⓘ Based on 0 model tool calls — nothing in this overview came from querying the index.`;
  } else {
    const listed = entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
    line = `ⓘ Based on ${total} model tool call${total !== 1 ? 's' : ''}: ${listed}.`;
    if (entries.length === 1 && entries[0][0] === 'overview') {
      line += ' The model consulted only the deterministic overview — this reads as a rewording of `--overview`, not an independent second view.';
    }
  }
  const extras = [];
  if (prefetched) extras.push('CE prefetched `overview` itself');
  if (substituted.length) extras.push(`CE ran ${substituted.join(', ')} on the model's behalf`);
  if (selfCalledModelsUsed) extras.push('CE ran `models_used` for verification only');
  return extras.length ? `${line} (${extras.join('; ')}.)` : line;
}
