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
function modelSentences(prose) {
  return String(prose || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => /\bmodels?\b/i.test(s));
}

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
  'No', 'None', 'I', 'GPU', 'CPU', 'LLM', 'LLMs', 'SDK', 'CLI', 'README']);

export function namesInModelSentences(prose) {
  const out = new Set();
  for (const s of modelSentences(prose)) {
    for (const m of s.matchAll(/`([^`]{2,60})`|"([^"]{2,60})"/g)) out.add((m[1] || m[2]).trim());
    // Bare tokens; drop the sentence's first word so a leading "The" is not a name.
    const bare = s.replace(/`[^`]*`|"[^"]*"/g, ' ').trim().split(/\s+/).slice(1);
    for (const raw of bare) {
      // `.` stays inside the allowed set because model ids carry it
      // (`model.ckpt`), which means a SENTENCE-final period survives the first
      // strip. Left in, `resnet50.` fails to match a tool output containing
      // `resnet50` and the faithful case footnotes itself — caught in the first
      // smoke test, and the reason for the second strip.
      const t = raw.replace(/^[^A-Za-z0-9_.\-/]+|[^A-Za-z0-9_.\-/]+$/g, '')
        .replace(/\.+$/, '')
        .replace(/['’]s$/, '');   // possessive: "OpenAI's models" names OpenAI
      if (t.length < 3 || _STOP.has(t)) continue;
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
export function unsupportedModelNames(prose, modelsUsedOutput) {
  const hay = String(modelsUsedOutput || '').toLowerCase();
  if (!hay) return [];
  return namesInModelSentences(prose).filter((n) => !hay.includes(n.toLowerCase()));
}

/**
 * The footnote, or '' when the sentence is fully supported — or when CE has no
 * tool output to check against, which is the "allowed to say nothing" case.
 */
export function aimlVerificationNote(prose, modelsUsedOutput) {
  if (!String(modelsUsedOutput || '').trim()) return '';
  const unsupported = unsupportedModelNames(prose, modelsUsedOutput);
  if (!unsupported.length) return '';
  const listed = unsupported.slice(0, 8).map((n) => `"${n}"`).join(', ');
  const more = unsupported.length > 8 ? ` (+${unsupported.length - 8} more)` : '';
  return `\n\nⓘ AI/ML SENTENCE UNVERIFIED: the prose above names ${listed}${more}, which `
    + `CodeExam's own \`models_used\` result for this index does NOT contain. That result is `
    + `reproduced below. This is a mechanical comparison, not a judgement — a name may be a `
    + `vendor or framework rather than a model — but nothing here was read out of the index.`
    + `\n\n<models_used>\n${String(modelsUsedOutput).trim().slice(0, 1200)}\n</models_used>`;
}
