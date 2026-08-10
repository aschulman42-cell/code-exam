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
