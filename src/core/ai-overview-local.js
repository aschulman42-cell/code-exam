// ai-overview-local.js — runs the AI overview on a local GGUF via node-llama-cpp tool-calling, with tool-floor and refusal guards
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * ai-overview-local.js — "Overview by AI" via a LOCAL GGUF model (#196 spike).
 *
 * Air-gapped alternative to the cloud engine (ai-overview.js): loads a
 * GGUF with node-llama-cpp IN-PROCESS and runs the same orientation prompt as an
 * agentic tool-loop. Instead of MCP-over-stdio, the CE tools are exposed as
 * node-llama-cpp chat functions that call CE's exported `handleTool` directly —
 * so there's no subprocess and no MCP transport, just the model + the tool seam.
 *
 * Reuses: the shared AI_OVERVIEW_PROMPT / AI_OVERVIEW_TOOLS (ai-overview.js),
 * CE's `handleTool` / `TOOLS` / `setIndex` (mcp-server.js), and the same
 * getLlama→loadModel→createContext pattern CE already uses for claim/analyze
 * (server.js). The new piece is the multi-turn function-calling loop, which
 * node-llama-cpp's `session.prompt(..., { functions })` runs for us.
 *
 * Validated against Qwen3-4B-Q4_K_M and later engines. GUI wiring shipped:
 * server.js routes `/api/ai-overview` with engine 'local' through
 * runAiOverviewLocalShared.
 */

import { CodeSearchIndex } from './CodeSearchIndex.js';
import { handleTool, TOOLS, setIndex } from '../mcp-server.js';
import { AI_OVERVIEW_TOOLS, aiOverviewPrompt } from './ai-overview.js';
import { ggufContextOptions, chatSessionOptions } from './llm-runner.js';
import { aimlVerificationNote, unsupportedModelNames, aimlConverseNote, toolCallFooter } from './answer-disclosure.js';

// The CE tool names the overview may call (same allow-list as the claude
// engine), with the mcp__code-exam__ prefix stripped to the handleTool case.
const TOOL_NAMES = AI_OVERVIEW_TOOLS.split(',').map(t => t.replace(/^mcp__code-exam__/, ''));

const MAX_TOOL_OUTPUT = 4000; // chars — cap each tool result so the loop doesn't blow the context window

// ---------------------------------------------------------------------------
// #276 hardening-parity helpers. Shared by this CLI path and server.js's
// runAiOverviewLocalShared; the chat loop keeps its own earlier copies — a
// later cleanup can dedupe all three (see the note in ai-overview.js).
// ---------------------------------------------------------------------------

// Special-token neutralization (port of the server chat-loop guard, #250):
// tool results can contain text that lexes as chat-template control tokens
// (ChatML <|...|>, Gemma turn tags, Mistral [INST], DeepSeek fullwidth bars).
// Break every form with visibly-distinct lookalike delimiters.
const SPECIAL_TOKEN_RE = new RegExp([
  '</?think>',
  '</?tool_(?:call|response)>',
  '<\\|[^|<>]{1,32}\\|>',
  '<\\uff5c[^\\uff5c<>]{1,40}\\uff5c>',
  '<(?:start|end)_of_turn>',
  '\\[/?INST\\]', '\\[TOOL_CALLS\\]',
  '</?s>',
].join('|'), 'gi');

export function neutralizeSpecialTokens(s, where = 'tool result', log = null) {
  const str = String(s || '');
  const hits = str.match(SPECIAL_TOKEN_RE);
  if (!hits) return str;
  if (log) log(`neutralized ${hits.length} special token(s) in ${where}: ${[...new Set(hits)].slice(0, 5).join(' ')}`);
  return str.replace(SPECIAL_TOKEN_RE, (m) => m
    .replace(/</g, '‹').replace(/>/g, '›')
    .replace(/\[/g, '⟦').replace(/\]/g, '⟧')
    .replace(/[|｜]/g, '¦'));
}

// node-llama-cpp's Gemma wrapper silently drops system turns, and the family
// under-uses tools without explicit insistence — deliver the instructions
// under the same strict framing header the chat loop's fold uses. Other
// families get the prompt unchanged.
export function strictInstructionsFor(wrapperName, promptText) {
  if (wrapperName !== 'Gemma') return promptText;
  return `Instructions (follow these strictly):\n${promptText}`;
}

// #276 fabrication guard: a "grounded" overview produced with ZERO tool calls
// cannot be grounded in the index — some families (Gemma 3 observed) invent a
// plausible generic codebase instead of refusing. Make that unmissable.
//
// `prefetched` narrows it (#306 fix-list 4, F40). The zero-calls inference is
// valid ONLY while the model is the sole source of index data. Once CE injects
// a real `overview` result the premise is false, and runs scoring groundedness
// 1.000 were being labelled UNGROUNDED. That is not cosmetic: it made
// `zero-tools` mean different things in different arms, so the class could not
// be summed across them.
//
// The guard NARROWS rather than vanishing — a prefetched run can still
// fabricate beyond the supplied overview, and this is still the check that
// catches it when the model adds nothing of its own.
export function ungroundedWarning(toolCalls, grounding, prefetched = false) {
  if (toolCalls > 0) return null;
  if (prefetched) return null;
  if (grounding && grounding !== 'grounded') return null;
  return '⚠ UNGROUNDED OUTPUT: the model made no tool calls, so nothing below '
    + 'is based on the loaded index. Treat this as generic prose, not an '
    + 'overview of this codebase. (Known behavior for some model families; '
    + 'try Qwen3.5-class, or re-run — see code-exam #276.)';
}

// Tool budget with a synthesize-now stop (port of the server overview/chat
// budget): an over-eager investigator gets cut off and told to write from
// what it has, instead of accumulating results until the context overflows —
// which for this in-process path ends in a native crash, not a clean error.
// How many times the model may ignore the budget-exhausted refusal before CE
// stops asking and ends the tool loop itself. ONE grace turn: the refusal is an
// instruction, and a model that is going to honour it does so on the very next
// turn. A second attempt means it is looping, and every further refusal is pure
// context growth — measured at HEAD e53fa13 on Devstral-Small: 10 refusals on
// .zlib, 23 on .x265 (to call 26), 39 on .sr_gh (to call 41, past maxCalls=24),
// every one ending in "context shift strategy did not return a history that
// fits". Asking a third time has never once produced prose.
export const BUDGET_REFUSAL_LIMIT = 2;

export function makeToolBudget({ maxCalls = 24, maxChars = 60000 } = {}) {
  const b = { calls: 0, chars: 0, stopped: false, refusals: 0 };
  b.gate = () => {
    b.calls++;
    if (b.stopped || b.calls > maxCalls || b.chars > maxChars) {
      b.stopped = true;
      b.refusals++;
      return 'TOOL BUDGET EXHAUSTED — do not call any more tools. Write your complete overview now from the results you already have.';
    }
    return null;
  };
  b.charge = (len) => { b.chars += Number(len) || 0; };
  return b;
}

// ---------------------------------------------------------------------------
// Empty-final-turn rescue. A model can complete its tool phase and then end the
// turn without writing anything — every call succeeded, the budget is barely
// touched, and `session.prompt` resolves to "". CE returns empty prose and exit
// code 0, so a script reading the exit code sees success. These three pieces
// make the recovery decision testable without a live model.
// ---------------------------------------------------------------------------

// Deliberately far below the context-scaled ceiling: an overview is hundreds of
// tokens (observed rescues ~520), and a shorter generation is a shorter
// synchronous native block — the suspected mechanism behind an observed ~640s
// event-loop stall on this path.
export const SYNTHESIZE_RETRY_MAX_TOKENS = 1024;

// Mirrors makeToolBudget's stop string. CE already had the right primitive; it
// only ever fired when the budget was EXHAUSTED, and this failure happens at
// ~45% of budget.
export const SYNTHESIZE_NOW_PROMPT =
  'Do not call any more tools. Write your complete overview now from the results you already have.';

// Retry only when the model produced nothing AND actually investigated. Zero
// tool calls is a different failure — that is the ungrounded case, and
// re-prompting a model that never looked at the index would just invite
// fabrication.
export function needsSynthesizeRetry(raw, toolCalls) {
  return !String(raw || '').trim() && toolCalls > 0;
}

// Used ONLY on the budget-stop path, where the chat history cannot be trusted:
// CE aborted generation mid tool-call turn, and re-prompting that session made
// Devstral-Small write 1703 chars about London weather, FTSE prices and film
// recommendations for a zlib index. Resetting the history and RE-SUPPLYING the
// results as plain text removes the broken turn and puts the evidence in front
// of the model explicitly, instead of trusting it to remember.
export const SYNTHESIZE_FROM_RESULTS_PREAMBLE =
  'Below are the tool results CodeExam already gathered from the loaded index. Write the '
  + 'overview ONLY from these results. Every file name, symbol, count and model id you mention '
  + 'MUST appear below verbatim. If the results do not support a statement, leave it out. Do '
  + 'not describe anything other than this codebase.';

export function rescuedNote(toolCalls, reason = 'empty-turn') {
  // Two different things end in a synthesize-only pass, and saying the wrong one
  // is a false statement about what happened: on the empty-turn path the model
  // stopped on its own; on the budget path CE cut it off. The disclosure has to
  // name the actual cause, not the shared symptom.
  const cause = reason === 'budget'
    ? `the model made ${toolCalls} tool call(s), then kept calling tools after CodeExam's `
      + 'tool budget was spent, so CodeExam ended the tool loop itself'
    : `the model made ${toolCalls} tool call(s) and then ended its turn without writing anything`;
  return `ⓘ RECOVERED OUTPUT: ${cause}. The overview below came from a second, `
    + 'synthesize-only pass over results it had already gathered. Treat this as a '
    + 'model limitation on the agentic path, not a clean run.';
}

// ---------------------------------------------------------------------------
// TOOL-CALL FLOOR (#306 fix-list item 7, from F37/F39). Env-gated by
// CE_TOOL_CALL_FLOOR=<n>; unset means no floor and byte-identical behaviour.
//
// makeToolBudget CAPS investigation. This is the same primitive inverted: a
// model that writes its overview after looking in too few places is sent back.
// Prefetch (29aa2b0) makes the FIRST call unconditional; it does not make the
// second one happen, and on a large index it suppresses it — on .ExoPlayer3,
// prefetch drove 3 of 5 cells to ZERO model-initiated calls and halved
// Gemma-QAT's specificity (F39). The payload does not overflow the window (no
// budget-stop has ever fired); it reads as SUFFICIENT and the model stops.
// Behavioural saturation, not context exhaustion.
//
// Why JS and not a prompt: one instruction measured across 5 models x 2 indexes
// improved 2 cells and REGRESSED 4 (F34). A prompt edit is a per-model
// coefficient. A floor is arithmetic.
// ---------------------------------------------------------------------------

// DISTINCT tools, not raw calls. F55/F56 record the dangerous signature: a
// refusal with toolCalls >= 5 and distinctTools == 1, which *looks* earned and
// is worse than an obvious failure. A raw-count floor is satisfied by calling
// `search` five times with the same bad term — precisely the 24-call loop F56
// documents. Distinct tools makes the floor mean "looked in more than one
// place", which is the property actually wanted.
export function toolFloorFrom(env) {
  const raw = env && env.CE_TOOL_CALL_FLOOR;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Two nudges maximum. A model that will not investigate must not be re-prompted
// forever — after the bound, the run is accepted and LABELLED. An unbounded
// floor would turn a model limitation into a hang.
export const TOOL_FLOOR_MAX_NUDGES = 2;

// MEASURED NOT TO WORK — do not enable this expecting it to help. 16 nudges
// across 8 cells produced ZERO additional distinct tool calls on any model or
// index, and specificity fell in 7 of 8. Two cells were destroyed outright.
//
// The design comment above says "a floor is arithmetic". The GATE is arithmetic;
// the ENFORCEMENT is prose, and F34 already established that a prompt edit is a
// per-model coefficient. That gap is the whole result, and it was mine to see.
//
// The premise is contradicted from both directions at once. Telling models to
// investigate does not work — and a model that needed no telling was available
// the whole time: gpt-oss-20b makes 10 calls / 8 DISTINCT tools on .ExoPlayer3
// unprompted, on the index where five other models manage 0-1 and where F19
// concluded the index itself was suppressing investigation. It is not the index.
// Investigation depth is a property of the MODEL, and CE cannot prompt its way
// to it.
//
// So the useful CE-side lever is selection plus substitution, not enforcement:
// report depth honestly (the label below does that well and is why this
// experiment was readable), and where a model will not look, have CE look for it
// — the prefetch route, the one mechanism measured to work on every model
// including those that never call anything.
//
// asus-CC's batch-2 report, §4 and §5. The replacement is below; the nudge
// prompt itself is deleted rather than kept behind a flag, because a measured-
// dead prompt left in the tree is one someone re-enables expecting it to help.

// THE REPLACEMENT: substitution, not enforcement.
//
// Only argument-free, UNCONDITIONAL tools. That restriction is the prefetch's
// scope note applied here: pre-fetching `overview` is right because every run
// needs it, and pre-fetching `digest <file>` would be wrong because CE would
// have to invent the argument and would spend context on a result this run may
// not need. Ordered by orientation value, so a floor of 2 supplies the two most
// useful rather than an arbitrary pair.
// `models_used` added per #320 1a: it is argument-free and unconditional (the
// prompt mandates an AI/ML sentence "from models_used" on every run), it was
// absent despite meeting the stated criterion, and its absence is the defect
// #320 measured — 0-of-5 sr_gh runs called it, exactly where it returns 21
// models. Placed after `stats`: the AI/ML sentence is a mandated output; the
// later entries enrich but are not demanded by the prompt.
export const FLOOR_SUBSTITUTION_TOOLS = ['overview', 'stats', 'models_used', 'vocabulary', 'entry_points', 'most_called', 'hotspots'];

// Which tools CE should run on the model's behalf: the highest-value ones it did
// NOT already call, enough to cover the shortfall. Pure so the selection can be
// tested without a model.
export function selectSubstitutionTools(calledTools, floor, catalog = FLOOR_SUBSTITUTION_TOOLS) {
  const called = new Set(calledTools instanceof Set ? [...calledTools] : (calledTools || []));
  const need = Math.max(0, (Number(floor) || 0) - called.size);
  if (!need) return [];
  return catalog.filter((t) => !called.has(t)).slice(0, need);
}

// ONE revision request, never a loop. Two reasons, both measured: the nudge
// already showed repetition adds nothing, and F39 showed that supplying a result
// can TERMINATE investigation rather than seed it — so each extra round is more
// supplied context working in the wrong direction.
export const SUBSTITUTION_REVISION_PROMPT =
  'The tool results above were run for you. Revise your overview to use them. '
  + 'Write the complete overview; do not describe what you are doing.';

// Fires only when the model WROTE something while under the floor.
//
// `rescued` is the load-bearing exclusion, and it is not an ordering rule:
// needsSynthesizeRetry fires on EMPTY output and this fires on NON-empty, so the
// two can never match the same response. But a rescued run has already shown the
// model struggling to produce anything at all, and sending it back for more
// investigation is the worst case in this mechanism's own reasoning.
export function needsToolFloorNudge({ raw, distinctTools, floor, nudges, rescued }) {
  if (!floor) return false;
  if (rescued) return false;
  if (nudges >= TOOL_FLOOR_MAX_NUDGES) return false;
  if (!String(raw || '').trim()) return false;   // empty is the rescue's case
  return distinctTools < floor;
}

// ---------------------------------------------------------------------------
// DAMAGE CAP (asus-CC, batch-2 floor measurement). Never return an answer worse
// than the one the nudge replaced.
//
// Measured: 16 nudges across 8 cells produced ZERO additional distinct tool
// calls, specificity fell in 7 of 8, and two cells were destroyed — Qwen's
// best-in-roster run (groundedness 1.000, specificity 18.5) came back as 399
// bytes of leaked `<tool_call>` markup, and Gemma-K_M returned 7,742 bytes at
// 0.3 entities/kchar. Both would have been better served by the pre-nudge prose.
//
// CE cannot compute asus-CC's specificity score — that lives in the eval
// harness and its rules are frozen at v1, so duplicating it here would create a
// second definition that drifts. What CE can do is compare the SAME cheap
// measure across the two candidate answers from ONE run. A within-run comparison
// does not need to agree with anyone's absolute scale to answer "did this get
// worse".
// ---------------------------------------------------------------------------

// Concrete things the prose names: backticked spans, dotted / :: / _ qualified
// identifiers, CamelCase words, and anything with a file extension. Deliberately
// conservative — it is a floor on "names something checkable", not a claim to
// measure groundedness.
// The qualified-identifier alternative bounds its quantifiers ({0,63} per run,
// {1,16} segments) instead of using nested `*`/`+`: `_` is both a segment
// separator and a member of the identifier class, so the unbounded form
// backtracked super-linearly on long underscore runs (CodeQL js/redos). Bounds
// cover any realistic identifier while making worst-case work constant.
const SCORABLE_RE = new RegExp([
  '`[^`\\n]+`',
  '\\b[A-Za-z_][A-Za-z0-9_]{0,63}(?:(?:::|\\.|_)[A-Za-z0-9_]{1,63}){1,16}\\b',
  '\\b[a-z0-9]+[A-Z][A-Za-z0-9]*\\b',
  '\\b[A-Za-z][A-Za-z0-9_-]*\\.[a-z]{1,5}\\b',
].join('|'), 'g');

// Lines the model did not write — CE's own echoed tool traffic. Stripped BEFORE
// counting, because tool output is dense in identifier-shaped strings (env var
// names, CamelCase, dotted paths) and a run that collapses into echoing results
// therefore scores HIGHER than the healthy answer it replaced. Measured: 26 ->
// 104 on Gemma-K_M's degenerate cell, so the proxy was rewarding precisely the
// degeneration it exists to catch (asus-CC, damage-cap verification).
const ECHOED_LINE_RE = /^\s*\|\|\s*(?:call|result)\s*:/;

function stripLeaked(text) {
  return String(text || '').split('\n').filter((l) => !ECHOED_LINE_RE.test(l)).join('\n');
}

export function countScorableTokens(text) {
  return (stripLeaked(text).match(SCORABLE_RE) || []).length;
}

// The distinctive tokens of a text, deduped and case-folded. Same regex as the
// scorable count, so "distinctive" means the same thing in both places.
export function scorableTokenSet(text) {
  const out = new Set();
  for (const m of stripLeaked(text).match(SCORABLE_RE) || []) {
    const t = m.replace(/`/g, '').trim().toLowerCase();
    if (t.length >= 3) out.add(t);
  }
  return out;
}

/**
 * How much of the prose's distinctive vocabulary actually appears in the tool
 * results CE gathered. null when there is too little of either to judge.
 */
export function groundednessRatio(prose, gatheredText) {
  const p = scorableTokenSet(prose);
  const g = scorableTokenSet(gatheredText);
  if (!p.size || !g.size) return null;
  let shared = 0;
  for (const t of p) if (g.has(t)) shared++;
  return { shared, total: p.size, ratio: shared / p.size };
}

// CALIBRATED, NOT PICKED — and deliberately low. Measured overlap on real
// outputs from this machine (prose vs the tool results for its own index):
//
//   0.360  genuine   gemma K_M  .zlib
//   0.300  echo      gemma QAT  .sr_gh      <- garbage that scores HIGH
//   0.276  genuine   gemma QAT  .zlib
//   0.158  genuine   qwen       .sr_gh
//   0.080  genuine   gemma K_M  .sr_gh      <- GOOD prose that scores LOW
//   0.000  cross-check: .zlib prose vs .sr_gh results, and the reverse
//
// The genuine band runs 0.08-0.36 and overlaps the garbage, so a "how grounded
// is this" threshold does NOT exist in this data — an earlier 0.15 cut flagged
// the good sr_gh overview and passed the prompt-echo. What IS clean is the
// bottom: only prose about a DIFFERENT index scores 0. So this check answers
// the narrow question "does this text share anything at all with the evidence",
// which is the question the observed failure actually fails.
export const GROUNDEDNESS_FLOOR = 0.05;

// Too few distinctive tokens to score fairly — a short, honest answer should not
// be accused of fabricating.
export const GROUNDEDNESS_MIN_TOKENS = 8;

// Prose long enough that saying nothing technical is itself the finding. The
// measured fabrication was 1703 chars of fluent text naming not one identifier.
export const GROUNDEDNESS_MIN_CHARS = 400;

/**
 * The warning for prose that cites tool calls but shares almost no vocabulary
 * with what those tools returned.
 *
 * WHY THIS IS NOT COVERED BY ungroundedWarning(): that one fires only at ZERO
 * tool calls, so CE has been treating "tools were called" as proof the prose is
 * grounded. Measured counter-example (Devstral-Small, .zlib, this machine): four
 * real tool calls, and prose about London weather, FTSE prices and film
 * recommendations — emitted under a footer that said "Based on 4 model tool
 * calls". Tool calls and groundedness are independent, and only this compares
 * the answer against the evidence.
 */
export function ungroundedProseWarning(prose, gatheredText, toolCalls) {
  if (!toolCalls) return null;                 // ungroundedWarning() owns that case
  const body = stripLeaked(prose).trim();
  if (body.length < GROUNDEDNESS_MIN_CHARS) return null;
  const gathered = scorableTokenSet(gatheredText);
  if (!gathered.size) return null;             // nothing to check against
  const mine = scorableTokenSet(body);
  const calls = `${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`;

  // Case 1 — substantial prose naming no identifier, file or symbol at all.
  // This is the shape the measured fabrication took: 1703 chars about London
  // weather, FTSE prices and film recommendations, under a footer that said
  // "Based on 4 model tool calls".
  if (!mine.size) {
    return `⚠ PROSE NOT GROUNDED IN THE TOOL RESULTS: the text below names no file, symbol `
      + `or identifier from this index — nothing technical at all — although the model made `
      + `${calls}. An overview of a codebase that cites nothing from it is not an overview of `
      + `it. Treat this as fabricated until checked against the code.`;
  }

  // Case 2 — it names things, but essentially none of them came from the tools.
  const shared = [...mine].filter((t) => gathered.has(t)).length;
  if (mine.size < GROUNDEDNESS_MIN_TOKENS) return null;
  const ratio = shared / mine.size;
  if (ratio >= GROUNDEDNESS_FLOOR) return null;
  return `⚠ PROSE NOT GROUNDED IN THE TOOL RESULTS: ${shared} of ${mine.size} distinctive `
    + `terms below (${Math.round(ratio * 100)}%) appear anywhere in what CodeExam's tools `
    + `returned for this index, across ${calls}. The text is not unsourced for lack of trying `
    + `— it does not match the sources. Treat it as fabricated until checked against the code.`;
}

// A nudge can knock a model out of the structured function-calling channel, so
// it emits call syntax as literal prose that node-llama-cpp never intercepts.
// That is not a weak answer, it is a broken protocol, and it is unambiguous.
//
// `||call:` / `||result:` is CE's OWN echo format and was the omission that let
// Gemma-K_M through: the detector covered the vendor formats and not the one CE
// itself produces, which is the one that family leaks in.
const LEAKED_CALL_RE = /<\s*(?:tool_call|function_call|\|?tool\|?)\s*>|^\s*\|\|\s*(?:call|result)\s*:|^\s*\{\s*"name"\s*:\s*"[a-z_]+"\s*,\s*"arguments"\s*:/im;

// ABSOLUTE count, not density. Density would miss Gemma-K_M's failure, which
// tripled its length while naming fewer things; absolute count catches both that
// and Qwen's collapse, and needs no threshold constant to argue about.
export function preferPreNudgeAnswer(pre, post) {
  const before = String(pre || '').trim();
  const after = String(post || '').trim();
  if (!before) return false;               // nothing better to fall back to
  if (!after) return true;
  if (LEAKED_CALL_RE.test(after)) return true;
  return countScorableTokens(after) < countScorableTokens(before);
}

// The floor guarantees QUANTITY, not quality — it cannot make a call
// informative, and F43's template regurgitation and F55's unearned refusals are
// both compatible with a satisfied floor. So say when it fired, the way
// rescuedNote() does: otherwise a floor-padded run is indistinguishable from a
// genuinely thorough one, and the intervention hides the behaviour that
// justifies it.
export function toolFloorNote(distinctTools, floor, substituted = [], reverted = false) {
  const subs = (substituted || []).filter(Boolean);
  return `ⓘ TOOL-CALL FLOOR ${subs.length ? 'SUBSTITUTED' : 'NOT MET'}: the model wrote its `
    + `overview after using ${distinctTools} distinct tool(s); the floor asked for `
    + `${floor}. `
    + (subs.length
      ? `CE ran ${subs.join(', ')} ITSELF and asked once for a revision. Those are CE calls, `
        + `not model calls, and they are deliberately NOT counted in the ${distinctTools} above — `
        + `folding them in would let the mechanism satisfy its own gate.`
      : `CE had no unused argument-free tool left to run, so the run stands as written.`)
    + (reverted
      ? ' The revised answer named FEWER concrete things than the original, so the'
        + ' original was kept — the substitution made this run worse, and that is the result.'
      : '')
    + ' Extra calls do not guarantee extra evidence — read this with the groundedness '
    + 'and specificity scores, not instead of them.';
}

// Context-scaled output/tool budgets (port of server _localBudgets).
//
// #320 item 2: `overheadTokens` lets the caller pass a MEASURED overhead. The
// old constant 1200 was assumed; measured reality is ~2900 (assembled system
// prompt ~1685 + ten tool defs ~1200), and the ~1700-token understatement
// exceeds ctx-8192's entire slack — which is why the same model failed at one
// context size and not the other (asus-CC, #320). The 1200 default is kept
// for callers without a tokenizer in hand; it is a floor, not a truth.
export function localBudgets(contextSize, explicitMaxTokens, overheadTokens = null) {
  const OVERHEAD = (Number.isFinite(overheadTokens) && overheadTokens > 0)
    ? Math.floor(overheadTokens)
    : 1200;                      // assumed fallback — see note above
  const MIN_TOOL_TOKENS = 400;
  let maxTokens = explicitMaxTokens || Math.min(6144, Math.max(2400, Math.floor(contextSize / 6)));
  maxTokens = Math.max(256, Math.min(maxTokens, contextSize - OVERHEAD - MIN_TOOL_TOKENS));
  const toolBudgetChars = Math.max(500, Math.floor((contextSize - maxTokens - OVERHEAD) * 2.5));
  return { maxTokens, toolBudgetChars };
}

/**
 * Generate the orientation overview with a local GGUF model.
 * @param {object} o
 * @param {string} o.indexPath  index directory (loaded in-process)
 * @param {string} o.modelPath  GGUF path (CE's --model)
 * @param {number} [o.contextSize] preferred context (shrinks on OOM)
 * @param {number} [o.maxTokens]   max output tokens
 * @param {number} [o.timeoutMs]   hard wall-clock cap (default 20 min)
 * @param {('auto'|false)} [o.gpu] 'auto' (default) uses the GPU if available and
 *   falls back to CPU when the GPU can't fit the context; false forces CPU
 *   (loads into full system RAM — needed for large models on a small/integrated GPU)
 * @param {(s:string)=>void} [o.onStatus] progress sink (model load, tool calls)
 * @returns {Promise<{prose:string, toolCalls:number, contextSize:number, outTokens:(number|null)}>}
 */
// NOTE: `maxTokens` deliberately has NO default. localBudgets() scales the
// output allowance with context (`explicitMaxTokens || min(6144, max(2400,
// ctx/6))`), and `||` cannot distinguish a caller's deliberate 2400 from a
// default parameter that merely looks like one. A `= 2400` default here filled
// in for the sole caller (index.js, which never passes it), arrived as
// `explicitMaxTokens`, and pinned output at 2400 tokens at EVERY context size —
// so --context-size raised the tool budget while the answer allowance never
// moved. Leave it undefined so the scaling actually runs.
export async function runAiOverviewLocal({ indexPath, modelPath, contextSize = 16384, maxTokens, timeoutMs = 1200000, gpu = 'auto', grounding, flashAttention = false, liveTodayDate = false, onStatus, onStream } = {}) {
  if (!indexPath) throw new Error('runAiOverviewLocal: indexPath is required.');
  if (!modelPath) throw new Error('runAiOverviewLocal: a GGUF modelPath is required (pass --model).');
  const status = (s) => { if (onStatus) onStatus(s); };

  // CE's tools (and the index load) report progress via console.* during
  // execution ("Scanning for function calls…", "Loaded existing index…"). In
  // this in-process path the mcp-server's console→stderr redirect isn't active,
  // so without this their chatter would land on stdout and pollute the prose.
  // Redirect console.* to stderr for the run; restore in finally.
  const _log = console.log, _warn = console.warn, _err = console.error;
  const toErr = (...a) => process.stderr.write(a.join(' ') + '\n');
  console.log = toErr; console.warn = toErr; console.error = toErr;

  let model;
  // Threaded to ungroundedWarning() rather than inferred from the prompt text —
  // inferring it would couple the guard to prompt wording.
  let prefetched = false;
  const distinctTools = new Set();
  let floorNudges = 0;
  let preNudgeRaw = '';
  let floorReverted = false;
  let floorSubstituted = [];   // tool names CE ran on the model's behalf
  let modelsUsedResult = '';   // #306 F70: the tool output the prose is checked against
  let overviewSeedResult = ''; // #320 1c: the deterministic seed, for seed-aware verification
  const toolCallCounts = new Map(); // #320 item 4: per-tool counts for the evidentiary footer
  const gathered = [];         // every tool result, for groundedness + name verification
  const toolFloor = toolFloorFrom(process.env);
  try {
    // Load the index in-process and point handleTool at it (no MCP subprocess).
    const index = new CodeSearchIndex({ indexPath });
    if (index.files.size === 0) throw new Error(`No files in index at ${indexPath}`);
    setIndex(index);

    let getLlama, LlamaChatSession, defineChatSessionFunction;
    try {
      ({ getLlama, LlamaChatSession, defineChatSessionFunction } = await import('node-llama-cpp'));
    } catch (e) {
      throw new Error(`node-llama-cpp not available: ${e.message}`);
    }

    // Named in the status line so a captured run is self-describing: whether
    // flash attention was on changes VRAM headroom and may change numerics, and
    // a capture that does not say so cannot be compared against one that does.
    status(`loading model ${modelPath.split(/[\\/]/).pop()}${flashAttention ? ' (flash attention)' : ''} …`);
    const requestedCtx = contextSize;   // #320 item 3: remember what was asked for
    const sizes = [contextSize, 8192, 4096, 2048];

    // Load the model and create a context, optionally forcing CPU. Returns
    // {m, ctx} on success or null when no context size fits (disposing the
    // model it loaded, so the caller can retry on CPU without a leak).
    const tryLoad = async (cpuOnly) => {
      const llama = await getLlama(cpuOnly ? { gpu: false } : undefined);
      const m = await llama.loadModel({ modelPath });
      let ctx;
      for (const sz of sizes) {
        try { ctx = await m.createContext(ggufContextOptions(sz, flashAttention)); contextSize = sz; break; } catch { /* shrink */ }
      }
      if (!ctx) { try { await m.dispose(); } catch { /* */ } return null; }
      return { m, ctx };
    };

    let loaded;
    if (gpu === false) {
      status('using CPU (GPU disabled) …');
      loaded = await tryLoad(true);
    } else {
      loaded = await tryLoad(false); // auto — GPU if available
      if (!loaded) {
        // The model can load onto a small/integrated GPU yet leave no room for
        // the KV-cache (every context size OOMs). CPU uses full system RAM, so
        // retry once there before giving up.
        status('GPU out of memory; retrying on CPU (slower) …');
        loaded = await tryLoad(true);
      }
    }
    if (!loaded) throw new Error('could not create a model context (out of memory?) — even on CPU');
    model = loaded.m;
    const context = loaded.ctx;

    // #320 item 3: the ladder used to shrink silently — Devstral asked for
    // 16384, got 8192, and the only trace was the after-the-fact [context: N].
    // A model silently handed half its window must be visible at the time.
    if (contextSize < requestedCtx) {
      status(`context ladder: requested ${requestedCtx}, allocated ${contextSize} — `
        + `the model is running with a smaller window than asked (VRAM could not fit the request)`);
    }

    // #320 item 2: measure the real overhead instead of assuming 1200. The
    // base prompt and the tool definitions are both known here; the strict
    // wrapper header and question framing are not yet (they need the session),
    // so a fixed 400-token margin covers them — stated, not hidden. Tokenize
    // with the model's own tokenizer when available; chars/3.5 as fallback.
    const tokensOf = (s) => {
      try { if (typeof model.tokenize === 'function') return model.tokenize(String(s)).length; } catch { /* fall through */ }
      return Math.ceil(String(s || '').length / 3.5);
    };
    const promptBase = aiOverviewPrompt(grounding, { localEngine: true });
    let toolDefChars = 0;
    {
      const byNameForMeasure = new Map(TOOLS.map(t => [t.name, t]));
      for (const name of TOOL_NAMES) {
        const def = byNameForMeasure.get(name);
        if (!def) continue;
        toolDefChars += String(def.description || '').slice(0, 280).length
          + JSON.stringify((def.inputSchema && def.inputSchema.properties) ? def.inputSchema : {}).length;
      }
    }
    const measuredOverhead = tokensOf(promptBase) + Math.ceil(toolDefChars / 3.5) + 400;
    status(`budget: measured overhead ~${measuredOverhead} tokens (prompt + tool defs + margin; old assumption was 1200)`);

    // Expose the CE tools as chat functions backed by handleTool. #276: gate
    // every call through the tool budget and neutralize special tokens in
    // results — investigator-class models (Qwen3.5) otherwise accumulate
    // results until the context overflows, which crashes natively here.
    const { maxTokens: cappedMaxTokens, toolBudgetChars } = localBudgets(contextSize, maxTokens, measuredOverhead);
    const budget = makeToolBudget({ maxCalls: 24, maxChars: toolBudgetChars });

    // #320 follow-up: the budget refusal is a STRING RETURNED TO THE MODEL, so
    // a model that ignores it simply calls again — and each refusal is another
    // turn of history. That is not a slow leak: it is the mechanism that turns
    // a tight budget into total failure (0 bytes of prose), because the history
    // overflows before the run can finish and the empty-turn rescue below never
    // gets to run. CE therefore ends the tool loop ITSELF rather than asking.
    //
    // Separate controller from the timeout's, deliberately: the synthesize
    // rescue must still be able to run after this fires, so it keeps using the
    // timeout signal alone. Timeout aborts are forwarded INTO this one (rather
    // than using AbortSignal.any, which needs Node 20.3+ while CE targets >=18).
    const toolLoopAbort = new AbortController();
    const budgetStopError = new Error('tool budget exhausted — CE ended the tool loop');
    budgetStopError.ceBudgetStop = true;
    const byName = new Map(TOOLS.map(t => [t.name, t]));
    const functions = {};
    for (const name of TOOL_NAMES) {
      const def = byName.get(name);
      if (!def) continue;
      functions[name] = defineChatSessionFunction({
        description: String(def.description || '').slice(0, 280),
        params: (def.inputSchema && def.inputSchema.properties) ? def.inputSchema : { type: 'object', properties: {} },
        handler: (args) => {
          const stop = budget.gate();
          if (stop) {
            if (budget.calls === 25 || budget.chars > toolBudgetChars) status(`budget-stop after ${budget.calls - 1} calls (${budget.chars} result chars)`);
            if (budget.refusals >= BUDGET_REFUSAL_LIMIT && !toolLoopAbort.signal.aborted) {
              status(`budget: model ignored the stop ${budget.refusals}x — ending the tool loop and synthesizing from ${budget.chars} chars already gathered`);
              toolLoopAbort.abort(budgetStopError);
            }
            return stop;
          }
          status(`tool ${name}(${JSON.stringify(args || {}).slice(0, 120)})`);
          // Counted HERE, past the budget gate, so the floor's denominator is
          // the same population the harvester's `[overview-by-ai] tool ` lines
          // report. Counting before the gate would let budget-stopped attempts
          // satisfy a floor.
          distinctTools.add(name);
          toolCallCounts.set(name, (toolCallCounts.get(name) || 0) + 1); // #320 item 4
          let out;
          try { out = String(handleTool(name, args || {})); }
          catch (e) { out = `Error calling ${name}: ${e.message}`; }
          const capped = neutralizeSpecialTokens(out.slice(0, MAX_TOOL_OUTPUT), `${name} result`, status);
          // #306 F70: keep the models_used result so CE can check its own prose
          // against it afterwards. Captured here rather than re-called later —
          // a second call could return something the model never saw, which
          // would make the comparison describe a different run.
          if (name === 'models_used') modelsUsedResult = capped;
          // #320 1c: the overview seed, for seed-aware name verification.
          if (name === 'overview' && !overviewSeedResult) overviewSeedResult = capped;
          // EVERY result, not just these two. Two things need the whole set:
          // the groundedness check (is the prose about THIS index at all), and
          // the AI/ML name verification, whose basis was models_used + the seed
          // only — so a name the model correctly read out of `digest` or
          // `list_files` was footnoted as unverified. Measured: Gemma K_M's
          // CORRECT sr_gh sentence cites Qwen_Qwen3_4B_Base_e5_lr0…, a real
          // path with 51 matches in the index, and was footnoted anyway. Same
          // structural error as the bug #320 fixed — the guard's evidence base
          // narrower than the model's.
          gathered.push(capped);
          budget.charge(capped.length);
          return capped;
        },
      });
    }

    const session = new LlamaChatSession(await chatSessionOptions(context.getSequence(), { liveTodayDate, onStatus: status }));
    // #276: local engines get the forceful-grounding clause, and Gemma gets
    // the strict-framing header (its wrapper drops system turns; the family
    // fabricates tool results without explicit insistence).
    const wrapperName = session.chatWrapper && session.chatWrapper.wrapperName;
    let promptText = strictInstructionsFor(wrapperName, aiOverviewPrompt(grounding, { localEngine: true }));

    // PREFETCH, env-gated by CE_PREFETCH_OVERVIEW=1. Default behaviour is
    // byte-identical when unset. LOCAL PATH ONLY — the cloud engine is
    // untouched. Ported from asus-CC's measured experiment, matching their diff
    // so F37-F39's ten cells reproduce on this code rather than needing to be
    // re-derived on the GPU box.
    //
    // Rationale: CE's prompt mandates `overview` as step 1 of every run, so that
    // call is UNCONDITIONAL — not a decision the model needs to make. But asking
    // is unreliable: Mistral-Nemo makes 0 tool calls in every prompt
    // configuration tried (baseline, strict header, imperative preamble, 1 tool
    // or 16) while calling tools correctly outside CE. An imperative preamble
    // moved 2 of 10 cells and regressed 4.
    //
    // So CE calls it itself and hands over the result: the first tool call
    // becomes unconditional and model-independent, and skipping stops being an
    // option. Measured best of three arms — 2 clean runs, groundedness +0.169
    // with 1 cell regressing, and it eliminates the #276 empty-turn defect that
    // Gemma-K_M hit in 10/10 investigating runs.
    //
    // Deliberately NOT counted as a model tool call, and logged with a status
    // string the harvester's `[overview-by-ai] tool ` regex does not match.
    // `toolCalls` therefore keeps meaning "calls the MODEL chose to make" —
    // which is exactly the number that must be watched here, because the known
    // failure mode is that handing over a result SUPPRESSES further
    // investigation (3 of 5 cells went to zero model calls on .ExoPlayer3).
    // Counting it would fix the grounding guard for free and destroy the only
    // instrument that detects that.
    //
    // Scope note: right for `overview` because it is unconditional. It would be
    // wrong for conditional tools (`digest <file>`), where pre-fetching spends
    // context on results a given run may not need.
    //
    // Still gated, not default: asus-CC's own recommendation is "needs 2
    // companion changes". This is companion 1 (the grounding guard above);
    // companion 2 is the call floor, unbuilt. Shipping this on by default before
    // the floor exists would trade a starting problem for a continuing one.
    if (process.env.CE_PREFETCH_OVERVIEW === '1') {
      let pre = '';
      try { pre = String(handleTool('overview', {})).slice(0, MAX_TOOL_OUTPUT); }
      catch (e) { pre = ''; status(`prefetch overview failed: ${e.message}`); }
      if (pre) {
        prefetched = true;
        if (!overviewSeedResult) overviewSeedResult = pre;  // #320 1c
        budget.charge(pre.length);   // honest accounting against the tool budget
        status(`prefetch: CE called overview itself (${pre.length} chars) — not a model tool call`);
        promptText = `The \`overview\` tool has ALREADY been called for the loaded index. Its result follows.\n\n`
          + `<overview_result>\n${pre}\n</overview_result>\n\n`
          + `Use the result above as your starting point. Call the other tools to investigate further before writing.\n\n---\n\n`
          + promptText;
      }
    }

    // #320 item 5: the timeout must STOP inference, not just report. Rejecting
    // the race hands the user their prompt back while the native evaluation
    // keeps running (observed: 5,269s of CPU after "timed out" printed, killed
    // manually; on the CPU-fallback path that could burn for hours). The abort
    // signal is threaded into every session.prompt below — node-llama-cpp
    // stops generation and throws `signal.reason` when it fires.
    let timer;
    const timeoutAbort = new AbortController();
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => {
        const err = new Error(`local AI overview timed out (${Math.round(timeoutMs / 60000)} min)`);
        timeoutAbort.abort(err);
        rej(err);
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    // Forward a timeout into the tool-loop signal so the main prompt still stops
    // on timeout; the reverse is deliberately NOT wired, so a budget stop leaves
    // the timeout signal clean for the synthesize rescue.
    timeoutAbort.signal.addEventListener('abort',
      () => { if (!toolLoopAbort.signal.aborted) toolLoopAbort.abort(timeoutAbort.signal.reason); },
      { once: true });

    let raw;
    let rescued = false;
    let budgetStopped = false;
    try {
      // onStream surfaces the live model output (incl. <think> blocks and tool
      // reasoning) for testing; the final stdout prose still strips <think>.
      try {
        raw = await Promise.race([
          session.prompt(promptText, { functions, maxTokens: cappedMaxTokens, signal: toolLoopAbort.signal, onTextChunk: onStream ? (c) => onStream(c) : undefined }),
          timeout,
        ]);
      } catch (e) {
        // A CE-initiated budget stop is not a failure: the tool results are
        // already in the session, so fall through with an empty `raw` and let
        // the synthesize rescue below turn them into prose. Any other error
        // (timeout included) still propagates.
        if (!(e && e.ceBudgetStop)) throw e;
        raw = '';
        budgetStopped = true;
        // Must NOT start with "tool " — index.js suppressed lines with that
        // prefix pre-slate (they are the per-call log), so a disclosure worded
        // that way would have hidden itself; and any harvester counting
        // `tool NAME(` lines would score this as a real tool call.
        status('budget: tool loop ended by CE — synthesizing from gathered results');
      }

      // BUDGET-STOP RESCUE — deliberately NOT the same-session retry below.
      // That one re-prompts the existing session, which works when the model
      // simply ended its turn (history intact). Here CE aborted mid-turn, so the
      // history ends on an unanswered tool call and the model synthesises from
      // nothing: measured, it produced fluent prose about London weather for a
      // zlib index. Reset the history and hand the results back as text.
      // Not once the timeout has already fired: the rescue cannot succeed (its
      // own race is against an already-rejected promise) and attempting it logs
      // a second, wrong-sounding cause for an outcome the timeout produced.
      if (budgetStopped && !timeoutAbort.signal.aborted) {
        // Leave room for the answer: the results are the bulk of the prompt.
        const room = Math.max(1000, Math.floor(toolBudgetChars));
        let supplied = '';
        for (const g of gathered) {
          if (supplied.length + g.length > room) break;
          supplied += (supplied ? '\n\n' : '') + g;
        }
        status(`budget rescue: re-prompting with ${supplied.length} chars of gathered results (history reset)`);
        try {
          await session.resetChatHistory();
          raw = await Promise.race([
            session.prompt(`${SYNTHESIZE_FROM_RESULTS_PREAMBLE}\n\n${supplied}\n\n${SYNTHESIZE_NOW_PROMPT}`, {
              maxTokens: Math.min(cappedMaxTokens, SYNTHESIZE_RETRY_MAX_TOKENS),
              signal: timeoutAbort.signal,
              onTextChunk: onStream ? (c) => onStream(c) : undefined,
            }),
            timeout,
          ]);
          rescued = !!String(raw || '').trim();
        } catch (e2) { status(`budget rescue failed: ${e2.message}`); }
      }
      // Some local models end the turn after the tool phase without writing an
      // answer: `raw` comes back "" though every tool call succeeded and the
      // budget is nowhere near spent (Gemma 3 12B Q4_K_M, 107-file index: 12
      // calls, 21480/48200 chars used, raw.length 0, reproducible 6/6 — while
      // the same model on a 75-file index answers after 10). Claude and Gemini
      // both write prose from that same index in 7 calls, so it is a model-side
      // end-of-turn quirk, not a prompt or index fault. The session still holds
      // every tool result, so re-prompt once with tools withheld, reusing the
      // budget stop's own synthesize-now wording.
      //
      // INSIDE the raced block deliberately: clearTimeout fires in the finally
      // below, so a retry placed after it would run with NO timeout at all —
      // and this path has been observed blocking the event loop for ~640s.
      // Capped well under cappedMaxTokens because an overview needs hundreds of
      // tokens (observed rescues: ~520) and a shorter generation is a shorter
      // synchronous block, which is the suspected stall mechanism.
      // Same timeout guard as the budget rescue above: after a timeout the
      // output is empty BECAUSE OF the timeout, and "empty final turn after N
      // tool calls" would name a model behaviour that did not happen.
      if (!timeoutAbort.signal.aborted && needsSynthesizeRetry(raw, budget.calls)) {
        status(`empty final turn after ${budget.calls} tool calls — re-prompting to synthesize`);
        try {
          raw = await Promise.race([
            session.prompt(SYNTHESIZE_NOW_PROMPT, {
              maxTokens: Math.min(cappedMaxTokens, SYNTHESIZE_RETRY_MAX_TOKENS),
              signal: timeoutAbort.signal,
              onTextChunk: onStream ? (c) => onStream(c) : undefined,
            }),
            timeout,
          ]);
          rescued = !!String(raw || '').trim();
        } catch (e) { status(`synthesize retry failed: ${e.message}`); }
      }

      // TOOL-CALL FLOOR. INSIDE the raced block for the same reason the rescue
      // above is: clearTimeout fires in the `finally` below, so a re-prompt
      // placed after it would run with NO timeout, and this path has been
      // observed blocking the event loop for ~640s.
      // `if`, not `while`: ONE pass. The nudge looped because prose might land on
      // a later try; supplying results cannot benefit from repetition, and F39
      // says each extra round of supplied context suppresses further.
      if (needsToolFloorNudge({ raw, distinctTools: distinctTools.size, floor: toolFloor,
        nudges: floorNudges, rescued })) {
        const wanted = selectSubstitutionTools(distinctTools, toolFloor);
        const supplied = [];
        for (const name of wanted) {
          let out = '';
          try { out = String(handleTool(name, {})).slice(0, MAX_TOOL_OUTPUT); }
          catch (e) { status(`floor substitution: ${name} failed — ${e.message}`); continue; }
          if (!out) continue;
          budget.charge(out.length);   // honest accounting, as the prefetch does
          // #320 1a: a substituted models_used result IS in the model's context
          // for the revision pass, so the verification can use it.
          if (name === 'models_used' && !modelsUsedResult) modelsUsedResult = out;
          if (name === 'overview' && !overviewSeedResult) overviewSeedResult = out;
          supplied.push({ name, out });
        }
        if (!supplied.length) {
          status(`floor substitution: no unused argument-free tool left to run`
            + ` (${distinctTools.size} distinct < ${toolFloor}) — accepting the run as written`);
        } else {
          preNudgeRaw = raw;           // damage cap: the answer to fall back to
          floorNudges++;
          floorSubstituted = supplied.map((s) => s.name);
          // Status wording deliberately avoids the harvester's `[overview-by-ai] tool `
          // regex, exactly as the prefetch's does — these must never be harvested as
          // model tool calls, or the counter stops meaning "calls the MODEL chose".
          status(`floor substitution: CE ran ${floorSubstituted.join(', ')} itself`
            + ` (model called ${distinctTools.size} distinct < ${toolFloor}) — NOT model tool calls`);
          const packed = supplied
            .map((s) => `<${s.name}_result>\n${s.out}\n</${s.name}_result>`)
            .join('\n\n');
          try {
            raw = await Promise.race([
              session.prompt(`${packed}\n\n${SUBSTITUTION_REVISION_PROMPT}`, {
                maxTokens: cappedMaxTokens,
                signal: timeoutAbort.signal,
                onTextChunk: onStream ? (c) => onStream(c) : undefined,
              }),
              timeout,
            ]);
          } catch (e) { status(`floor substitution revision failed: ${e.message}`); }
        }
      }
      // Damage cap. Measured: nudging destroyed two of eight cells outright.
      // Never hand back an answer that names fewer concrete things than the one
      // it replaced.
      if (floorNudges && preferPreNudgeAnswer(preNudgeRaw, raw)) {
        floorReverted = true;
        status(`tool-call floor: re-prompted answer was worse (${countScorableTokens(raw)} vs `
          + `${countScorableTokens(preNudgeRaw)} scorable tokens) — keeping the original`);
        raw = preNudgeRaw;
      }
    } finally {
      clearTimeout(timer);
    }

    const toolCalls = budget.calls; // attempts (incl. budget-stopped), same as the server path
    // Strip any chain-of-thought block (Qwen3 etc. emit <think>…</think>).
    let prose = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // GEMMA 4 DSL MARKERS leak as literal text on some builds. This GGUF
    // declares 7 of its 19 control-looking tokens as type 4 (USER_DEFINED)
    // instead of 3 (CONTROL), enumerated from the vocab: `<|tool_call>` (48),
    // `<tool_call|>` (49), `<|tool_response>` (50), `<tool_response|>` (51),
    // the DSL string delimiter `<|"|>` (52), and the thought-channel pair
    // `<|channel>` (100) / `<channel|>` (101). The turn markers `<|turn>` /
    // `<turn|>` (105/106) ARE typed correctly, which is why they never leak.
    // llama.cpp warns at load and repairs the `<|x>` spelling, but not the
    // reversed `<x|>` one, so a tool-using run prints one stray `<tool_call|>`
    // per call ahead of the prose. Nothing downstream can tell these from
    // content, so drop whole blocks first, then any orphaned marker.
    prose = prose
      .replace(/<\|tool_call>[\s\S]*?<tool_call\|>/g, '')
      .replace(/<\|tool_response>[\s\S]*?<tool_response\|>/g, '')
      .replace(/<\|channel>[\s\S]*?<channel\|>/g, '')
      .replace(/<\|(?:tool_call|tool_response|channel)>|<(?:tool_call|tool_response|channel)\|>|<\|"\|>/g, '')
      .trim();
    // #276 fabrication guard: 0 tool calls in grounded mode = not an overview.
    const warn = ungroundedWarning(toolCalls, grounding, prefetched);
    if (warn && prose) prose = `${warn}\n\n${prose}`;
    // ungroundedWarning() above only fires at ZERO tool calls, which has meant
    // CE treats "tools were called" as proof the prose is grounded. It is not:
    // measured on this machine, Devstral made four real calls on .zlib and then
    // wrote about London weather and share prices. This compares the answer to
    // the evidence rather than to the call count. Prepended, because a reader
    // who trusts the first paragraph must not have to reach the footer.
    if (prose) {
      const notGrounded = ungroundedProseWarning(prose, gathered.join('\n'), toolCalls);
      if (notGrounded) {
        prose = `${notGrounded}\n\n${prose}`;
        status('prose shares (almost) nothing with the gathered tool results — flagged as ungrounded');
      }
    }
    // Say so when the prose came from the rescue pass. Without this a rescued
    // overview is indistinguishable from a healthy one, and the model defect
    // becomes invisible the moment the workaround lands — the workaround would
    // then quietly mask the very thing that justifies replacing the model.
    if (rescued && prose) prose = `${rescuedNote(toolCalls, budgetStopped ? 'budget' : 'empty-turn')}\n\n${prose}`;
    // #306 F70 + #320 1a/1c: check the AI/ML sentence against models_used.
    // Appended, never rewritten — silently editing the model's prose would make
    // CE's output no longer what the model produced, which is the one thing the
    // standing constraint forbids.
    //
    // #320's structural finding: the old guard returned '' exactly when the
    // model skipped models_used — the condition that produces the wrong answer.
    // So when the model never called it, CE calls it ITSELF for verification
    // (the index is loaded, the result is deterministic) and the notes disclose
    // that the model never saw it. The converse check — "prose says none
    // detected, tool says N" — is the direction that was actually wrong in the
    // 11-run matrix, and only works because of this self-call.
    let verifyModelsUsed = modelsUsedResult;
    let selfCalledModelsUsed = false;
    if (prose && !verifyModelsUsed) {
      try {
        verifyModelsUsed = String(handleTool('models_used', {})).slice(0, MAX_TOOL_OUTPUT);
        selfCalledModelsUsed = true;
        status('verification: CE ran models_used itself (the model never called it) — NOT a model tool call');
      } catch (e) { status(`verification models_used failed: ${e.message}`); }
    }
    // The verification basis is every tool result, not the seed alone — a name
    // read out of `digest` or `list_files` is evidence the model actually saw.
    const verifyBasis = [overviewSeedResult, ...gathered].join('\n');
    if (prose) {
      const aimlNote = aimlVerificationNote(prose, verifyModelsUsed, verifyBasis);
      if (aimlNote) {
        prose += aimlNote;
        status(`AI/ML sentence names ${unsupportedModelNames(prose, verifyModelsUsed, verifyBasis).length} term(s) absent from models_used — footnoted`);
      }
      const converseNote = aimlConverseNote(prose, verifyModelsUsed, { selfCalled: selfCalledModelsUsed });
      if (converseNote) {
        prose += converseNote;
        status('AI/ML claim contradicted by models_used — footnoted');
      }
    }
    // #320 item 4: the evidentiary footer. States what the answer is based on;
    // one-tool-only answers say so in CE's voice.
    if (prose) {
      prose += `\n\n${toolCallFooter(toolCallCounts, { substituted: floorSubstituted, prefetched, selfCalledModelsUsed })}`;
    }
    // Label a floor-influenced run, whether or not the substitution helped. A run
    // CE supplied results to must not read as one that investigated on its own —
    // that is how an intervention hides the behaviour justifying it.
    if (floorNudges && prose) {
      prose = `${toolFloorNote(distinctTools.size, toolFloor, floorSubstituted, floorReverted)}\n\n${prose}`;
    }
    // Output token count from the model's own tokenizer (air-gapped: no $ to
    // report, just tokens). Best-effort — null if the tokenizer isn't reachable.
    let outTokens = null;
    try { if (prose && typeof model.tokenize === 'function') outTokens = model.tokenize(prose).length; } catch { /* */ }
    return { prose, toolCalls, contextSize, outTokens, rescued };
  } finally {
    console.log = _log; console.warn = _warn; console.error = _err;
    // Do NOT dispose the model here (upstream node-llama-cpp #623). Gemma's
    // dispose path aborts during native teardown, and because this `finally`
    // runs BEFORE the return value reaches the caller, the abort killed
    // index.js before it could write the prose — a complete overview on stderr
    // with empty stdout. It surfaced on Windows/Blackwell as
    // `CUDA error: invalid resource handle` in ggml_backend_cuda_synchronize
    // and was misdiagnosed as a CUDA-runtime ABI mismatch; the same crash was
    // recorded on Linux/RTX-4090 as a teardown segfault (#276, 07-18 pod
    // batch), so it is neither CUDA- nor platform-specific.
    //
    // This is the standing convention everywhere else in CE — claim.js:1200,
    // analyze.js:267, server.js:1105-1109 all refuse to dispose for the same
    // reason; this path was simply missed. The only caller exits immediately
    // after writing, so native memory is reclaimed at process exit anyway.
  }
}
