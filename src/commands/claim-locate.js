// ============================================================================
// claim-locate.js — --claim-locate: PROPOSE -> VERIFY -> NAVIGATE -> REFINE
//
// Ask the model the question whose answer the index can CHECK: not "give me
// search terms" (four measured failures — see
// worklist-drafts/claim-locate-verify-navigate.md) but "name the classes and
// methods you would expect to implement this claim in this codebase."
//
// Symbol names are verifiable; regex patterns are not. Every proposal is
// labeled VERIFIED (with file@symbol and line range) or NOT FOUND — a model
// guess that does not exist is reported, never silently dropped, because an
// unverifiable citation is the one thing a litigation deliverable cannot
// contain.
//
// Division of labor, established by measurement: the model supplies the
// semantic bridge (patent-ese -> engineering names, which two different
// models produced unaided), the index supplies proof and navigation.
// ============================================================================

import fs from 'node:fs';
import crypto from 'node:crypto';
import { readCeVersion } from '../utils.js';
import { resolveModel, makeDrafter, claimsCostGate, actualCostLine, resetCloudUsage, describeEngine } from '../core/llm-runner.js';
import {
  buildSymbolTable, verifySymbol, isFound, nearbySymbols, navigateFrom,
  parseProposedSymbols,
} from '../core/symbol-verify.js';
// The scavenger hunt reuses the local tool-loop's hard-won guards rather than
// reinventing them: budget-with-synthesize-now-stop, special-token
// neutralization, Gemma's strict framing, and the zero-tool-call fabrication
// warning. See the HUNT section below.
import {
  makeToolBudget, neutralizeSpecialTokens, strictInstructionsFor,
} from '../core/ai-overview-local.js';

export const LOCATE_DEFAULTS = {
  maxProposals: 24, navLimit: 8, refine: true,
  navPerSeed: 4,      // callees promoted per seed
  maxNavRows: 24,     // total navigation-derived rows
  maxSeedSpan: 200,   // only FUNCTION-sized seeds navigate (lines)
  candidatesPerElement: 25,  // real symbols shown per element in the select step
};

// Split a claim into elements the way the charting code does: preamble to the
// first ':', then semicolon-separated limitations.
export function splitClaimElements(claimText) {
  const t = String(claimText || '').trim().replace(/^\s*\d+\s*\.\s*/, '');
  // Patent claims are conventionally typeset one limitation per line, and the
  // '101 claim is: 6 lines, 1 semicolon, and its first ':' is the "wherein:"
  // near the END — so the original colon-then-semicolon split produced 2
  // elements for a 6-element claim. Prefer LINE structure when present.
  const lines = t.split(/\r?\n/).map((l) => l.trim().replace(/[;,]?\s*(?:and)?\s*$/, '')).filter((l) => l.length > 15);
  if (lines.length >= 2) return lines;
  const ci = t.indexOf(':');
  const body = ci >= 0 ? t.slice(ci + 1) : t;
  return body.split(';').map((e) => e.trim().replace(/[.\s]+$/, '')).filter(Boolean);
}

// A light profile of the codebase — enough for the model to orient (what kind
// of system, what naming conventions), WITHOUT constraining it to a vocabulary
// slice. Constraining is precisely what the abandoned #301 bridge got wrong:
// it forbade `bitrate` because that token was not in the frequency-ranked
// top-300, and the model dutifully answered NONE.
export function buildIndexProfile(index, symbols, opts = {}) {
  const sample = opts.sample ?? 40;
  const exts = new Map();
  const dirs = new Map();
  for (const s of symbols) {
    const fp = s.filepath.split('!').pop();
    const ext = (fp.match(/\.([A-Za-z0-9]+)$/) || [])[1];
    if (ext) exts.set(ext, (exts.get(ext) || 0) + 1);
    const parts = fp.split('/');
    if (parts.length > 2) {
      const d = parts.slice(0, -1).slice(-2).join('/');
      dirs.set(d, (dirs.get(d) || 0) + 1);
    }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  // A NAME SAMPLE (not a vocabulary whitelist) so the model can match the
  // codebase's naming style; it remains free to propose anything.
  const step = Math.max(1, Math.floor(symbols.length / sample));
  const names = [];
  for (let i = 0; i < symbols.length && names.length < sample; i += step) names.push(symbols[i].name);
  return [
    `Symbols indexed: ${symbols.length}`,
    `Languages (by symbol count): ${top(exts, 6).join(', ')}`,
    `Representative packages/directories: ${top(dirs, 10).join(', ')}`,
    `Sample of symbol names (style reference only — you are NOT limited to these):`,
    ...names.map((n) => `  ${n}`),
  ].join('\n');
}

// ===========================================================================
// DISCOVERY (default path) — the model never needs to have seen this codebase
// ===========================================================================
//
// The first design asked the model to NAME the implementing classes from its
// own knowledge. That worked on ExoPlayer only because the model had memorized
// ExoPlayer: on a confidential codebase — the actual use case — there is
// nothing to recall and the step collapses. So instead:
//
//   1. ask what WORDS would appear in the names of code implementing each
//      element (reasoning about how software is written — general knowledge);
//   2. CE greps its OWN symbol table for those words (ground truth);
//   3. the model picks from candidates that demonstrably exist.
//
// The model supplies the bridge, the index supplies the vocabulary. No
// tool-use loop, so a 12B can drive it.

export function buildDiscoverPrompt() {
  return `You are given ONE element of a patent claim at a time, in patent language.

Patent language and source code never share vocabulary. Your job: predict the \
WORDS that would appear in the NAMES of classes, methods, and functions that \
implement this element in real working software.

Think about how such a system is actually built and what programmers call \
things — not what the patent calls them. Prefer words that would appear inside \
identifiers.

Example of the transformation (illustrative only, unrelated domain):
  claim says "means for persisting the transaction record durably"
  code words: commit, flush, journal, write, persist, transaction, log

Rules:
- 4 to 10 words per element, lowercase, single words (no phrases).
- NO patent boilerplate (unit, means, method, device, system, module, element).
- Words that would plausibly appear in an identifier, not prose connectors.
- You are NOT told which codebase this is, and you do not need to know.

OUTPUT — one line per element, nothing else:
ELEMENT 1: word; word; word
ELEMENT 2: word; word`;
}

// Parse "ELEMENT n: word; word" into [{element, words[]}].
export function parseElementWords(text) {
  const out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim().replace(/^[-*•]\s*/, '').replace(/\*\*/g, '');
    const m = line.match(/^(?:ELEMENT\s*)?(\d+)\s*[:.)]\s*(.+)$/i);
    if (!m) continue;
    const words = m[2].split(/[;,]/)
      .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter((w) => w.length >= 3 && w.length <= 24);
    if (words.length) out.push({ element: Number(m[1]), words: [...new Set(words)] });
  }
  return out;
}

// Grep the symbol table for model-supplied words. Ranked by how many DISTINCT
// element words a symbol's name contains, then by the rarity of those words
// (a word matching half the index says nothing), then by brevity.
// Test/mock/fake code, by symbol name OR by living under a test source root.
// Matches "Test" at a segment END too (`DrmPlaybackTest::clearkeyPlayback_…`),
// which an earlier segment-START-only pattern missed.
export function isTestSymbol(s) {
  return /(?:^|::)[A-Za-z0-9_]*(?:Test|Tests|Mock|Fake|Stub)(?:$|::)/.test(s.name || '')
    || /(?:^|[\\/])(?:test|tests|androidTest)[\\/]/i.test(s.filepath || '');
}

export function searchSymbolsByWords(symbols, words, opts = {}) {
  const limit = opts.limit ?? 25;
  if (!words || !words.length) return [];
  const freq = new Map(words.map((w) => [w, 0]));
  const lowered = symbols.map((s) => ({ s, low: s.name.toLowerCase() }));
  for (const { low } of lowered) {
    for (const w of words) if (low.includes(w)) freq.set(w, freq.get(w) + 1);
  }
  const total = Math.max(1, symbols.length);
  const rarity = (w) => {
    const c = freq.get(w) || 0;
    return c === 0 ? 0 : Math.log(total / c);
  };
  // Scoring principles (corpus-independent, not tuned to any expected answer):
  //  - RARE words carry the signal; count alone rewards verbose names.
  //  - TEST symbols are not implementations. Long generated test-method names
  //    like `...withLateThresholdToDropDecoderInput_dropsInputBuffers` matched
  //    3 words and buried `shouldStartPlayback`, which matched 2.
  //  - Shorter names are better matches at equal evidence.
  // Test symbols are EXCLUDED, not merely penalized. A weight was tried and
  // lost to rarity sums: long generated names like
  // `...withLateThresholdToDropDecoderInput_dropsInputBuffers` matched three
  // words and buried `shouldStartPlayback`, which matched two. We are asking
  // which code IMPLEMENTS an element; a test exercising it is a different
  // question. `--include-tests` restores them.
  // Collapse REDUNDANT matches before scoring. `rate` and `bitrate` are one
  // signal, not two: `calculateEac3Bitrate` matched rate+bitrate+calculate and
  // outranked `determineIdealSelectedIndex`, which matched the single rare word
  // `determine` — so the crux was never offered to one provider and it could
  // not pick what it was not shown. When one matched word contains another,
  // keep only the longer (more specific) one.
  const collapse = (matched) => matched.filter((w) =>
    !matched.some((o) => o !== w && o.includes(w) && o.length > w.length));
  const hits = [];
  for (const { s, low } of lowered) {
    if (!opts.includeTests && isTestSymbol(s)) continue;
    const raw = words.filter((w) => low.includes(w));
    if (!raw.length) continue;
    const matched = collapse(raw);
    const score = matched.reduce((n, w) => n + rarity(w), 0)
      + Math.log(1 + matched.length)      // breadth still helps, sub-linearly
      - Math.log(Math.max(8, s.name.length)) / 2;
    hits.push({ sym: s, matched, score });
  }
  hits.sort((a, b) => b.score - a.score);
  // De-duplicate by NAME: interfaces and their implementations share method
  // names, and three identical rows waste candidate slots the model needs.
  // The model selects a name; verifySymbol resolves it and flags ambiguity.
  // De-duplicate by BARE name, not full name. `getLicenseDurationRemainingSec`,
  // `WidevineUtil::getLicenseDurationRemainingSec`, and
  // `OfflineLicenseHelper::getLicenseDurationRemainingSec` are one function
  // seen through interface and implementations — five of one provider's top
  // six candidates were copies of a single method, spending the model's
  // attention and pushing real alternatives out of the window.
  const byBare = new Map();
  for (const h of hits) {
    const key = h.sym.bare || h.sym.name;
    const prev = byBare.get(key);
    if (prev) { prev.dupes = (prev.dupes || 1) + 1; continue; }
    byBare.set(key, h);
  }
  return [...byBare.values()].slice(0, limit);
}

// Round 2: choose from candidates that EXIST. Blind mode hides file paths so a
// run can prove discovery rather than recall.
export function buildSelectPrompt(perElement, opts = {}) {
  const blind = !!opts.blind;
  const blocks = perElement.map(({ element, text, hits }) => {
    const lines = hits.map((h, i) => `  ${i + 1}. ${h.sym.name}${blind ? '' : `   [${h.sym.filepath.split('!').pop()}]`}`);
    return `ELEMENT ${element}: ${text}\nCandidates found in the codebase:\n${lines.join('\n') || '  (none found)'}`;
  });
  return `For each claim element below you are shown REAL symbols from the codebase \
under examination, found by searching its symbol table.

Choose the symbol(s) that most plausibly IMPLEMENT that element. Prefer the \
specific function that performs the action over a container class. Choose at \
most 3 per element. If none of the candidates plausibly implement the element, \
answer NONE — that is a meaningful answer, not a failure.

Copy names EXACTLY as shown.

OUTPUT — one line per element, nothing else:
ELEMENT 1: ExactName; Other::exactName
ELEMENT 2: NONE

${blocks.join('\n\n')}`;
}

// ===========================================================================
// SCAVENGER HUNT (--hunt) — the model drives its own search of the symbol table
// ===========================================================================
//
// The discovery path above is ONE fixed search: the model predicts words, CE
// greps once, the model picks from what that grep returned. Measured on the
// '101 claim, that made success depend on a lucky word — Claude reached the
// crux because its word list happened to contain `adaptive`, matching a class
// name outright; Gemini's list was sound but its best word was rare enough to
// rank below a longer name matching three weak ones. The model could not say
// "none of these look right, try something else" or "show me what else is in
// that class." That conversation is what this adds.
//
// TRANSPORT. The loop is a TEXT protocol over the same `draft(sys, user,
// maxTokens)` seam every provider already implements, NOT node-llama-cpp's
// `defineChatSessionFunction`. The worklist draft proposed the latter, but it
// is local-GGUF-only, and the pre-registered gate requires all three cloud
// providers to run the hunt — so that plan could not satisfy its own gate
// without three more provider-specific tool-use implementations. One text
// protocol covers cloud and local identically and is testable against a mock
// drafter with no live model.
//
// What IS reused from the local tool loop (ai-overview-local.js) is everything
// that was learned the hard way: a tool budget with an explicit
// synthesize-now stop rather than a silent halt, special-token neutralization
// on every tool result, Gemma's strict-instruction framing, and the
// zero-tool-call fabrication guard. That last one is the point of the whole
// exercise here: a hallucinated hunt is worse than no hunt, because its output
// looks like evidence.

export const HUNT_DEFAULTS = {
  maxRounds: 8,        // model turns before we force a decision
  maxCalls: 24,        // total tool invocations (matches the local overview loop)
  maxLogChars: 24000,  // transcript cap; the smallest context we target is 16k
  searchLimit: 12,     // symbols returned per SEARCH
  membersLimit: 30,
  navLimit: 12,
  extractLines: 80,    // a function, not a file
  extractChars: 2500,
};

export function buildHuntPrompt() {
  return `You locate the code that implements a patent claim, inside a codebase you \
have never seen. You are NOT told which codebase it is and you do not need to know.

You cannot read the code directly. You can only ask for information about it, \
one step at a time, using the commands below. Use them to hunt for the \
functions that actually perform what each claim element describes.

COMMANDS — one per line, as many per reply as you want:
  SEARCH: word word word
      Symbols whose NAME contains any of those words.
  MEMBERS: SomeClass
      The other symbols defined in that class.
  CALLEES: SomeClass::someMethod
      What that function calls.
  CALLERS: SomeClass::someMethod
      What calls that function.
  EXTRACT: SomeClass::someMethod
      That function's source, so you can check what it really does.

Patent language and source code do not share vocabulary. Search for words a \
programmer would put in an identifier, not words taken from the claim.

A strategy that works: SEARCH broad words first. When a result looks close, \
MEMBERS to see what lives beside it, CALLEES to follow the work it delegates, \
and EXTRACT to confirm. A name is a hint, not proof — EXTRACT before you commit \
to it. If a search returns nothing useful, try different words rather than \
settling for the closest miss.

When you can name the implementing symbols — or have established that this \
codebase does not contain them — reply with exactly:

DONE
ELEMENT 1: ExactName; Other::exactName
ELEMENT 2: NONE

Rules:
- Copy symbol names EXACTLY as the results spell them.
- Prefer the specific function that performs the action over a container class.
- At most 3 symbols per element.
- NONE is a real answer. Never name a symbol you have not seen in a result.
- Reply with commands only, or with the final DONE block. No commentary.`;
}

// Parse a hunt turn into actions, and the terminal selections when DONE.
export function parseHuntActions(text) {
  const lines = String(text || '').split(/\r?\n/);
  const actions = [];
  let done = false;
  let doneAt = -1;
  for (let i = 0; i < lines.length; i++) {
    // Strip bold BEFORE bullets: `**MEMBERS: X**` otherwise loses only its
    // first asterisk to the bullet rule and never matches the command regex.
    const raw = lines[i].trim()
      .replace(/\*\*/g, '').replace(/^[-*•>]\s*/, '').replace(/^`+|`+$/g, '').trim();
    if (/^DONE\b/i.test(raw)) { done = true; doneAt = i; break; }
    const m = raw.match(/^(SEARCH|MEMBERS|CALLEES|CALLERS|EXTRACT)\s*[:=]\s*(.+)$/i);
    if (!m) continue;
    const arg = m[2].trim().replace(/^`+|`+$/g, '').replace(/\(\s*\)$/, '');
    if (arg) actions.push({ tool: m[1].toUpperCase(), arg });
  }
  // Tolerate "DONE" trailing on the same line as the first ELEMENT.
  const tail = done ? lines.slice(doneAt).join('\n').replace(/^\s*DONE\b/i, '') : '';
  return { actions, done, selections: done ? parseProposedSymbols(tail) : [] };
}

// The read-only tools. Every result is ground truth from the index — the model
// never sees anything CE did not read out of the loaded codebase.
export function makeHuntTools(index, symbols, opts = {}) {
  const D = HUNT_DEFAULTS;
  const includeTests = !!opts.includeTests;
  const blind = !!opts.blind;
  const where = (s) => (blind ? '' : `   [${s.filepath.split('!').pop()}]`);
  const resolve = (arg) => {
    const v = verifySymbol(symbols, arg);
    return isFound(v) ? v : null;
  };

  return (tool, arg) => {
    switch (tool) {
      case 'SEARCH': {
        const words = String(arg).toLowerCase().split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 3 && w.length <= 24);
        if (!words.length) return 'SEARCH needs one or more words of 3+ letters.';
        const hits = searchSymbolsByWords(symbols, words, { limit: D.searchLimit, includeTests });
        if (!hits.length) return `No symbol name contains any of: ${words.join(', ')}`;
        return hits.map((h) => `${h.sym.name}${where(h.sym)}`).join('\n');
      }
      case 'MEMBERS': {
        const cls = String(arg).replace(/::$/, '').replace(/^.*::/, '').toLowerCase();
        if (!cls) return 'MEMBERS needs a class name.';
        const rows = symbols.filter((s) => {
          if (!includeTests && isTestSymbol(s)) return false;
          const n = s.name.toLowerCase();
          return n.includes(`${cls}::`) || n === cls;
        });
        if (!rows.length) return `No class named ${arg} in this codebase.`;
        const shown = rows.slice(0, D.membersLimit).map((s) => `${s.name}${where(s)}`);
        if (rows.length > shown.length) shown.push(`… ${rows.length - shown.length} more`);
        return shown.join('\n');
      }
      case 'CALLERS':
      case 'CALLEES': {
        const v = resolve(arg);
        if (!v) return `No symbol named ${arg} in this codebase.`;
        const nav = navigateFrom(index, v.matches[0], { limit: D.navLimit });
        const rows = tool === 'CALLERS' ? nav.callers : nav.callees;
        if (!rows.length) return `${v.matches[0].name}: no ${tool.toLowerCase()} recorded in the index.`;
        return rows.join('\n');
      }
      case 'EXTRACT': {
        const v = resolve(arg);
        if (!v) return `No symbol named ${arg} in this codebase.`;
        const m = v.matches[0];
        let src = null;
        // getFunctionSource narrates failures on console; keep the hunt log clean.
        const _log = console.log; console.log = () => {};
        try { src = index.getFunctionSource?.(m.filepath, m.name); }
        catch { src = null; }
        finally { console.log = _log; }
        if (!src) return `${m.name}: source not retrievable from the index.`;
        const lines = String(src).split(/\r?\n/);
        const clipped = lines.slice(0, D.extractLines).join('\n').slice(0, D.extractChars);
        const note = lines.length > D.extractLines ? `\n… (${lines.length - D.extractLines} more lines)` : '';
        return `${m.name}${where(m)}  (L${m.start}-${m.end})\n${clipped}${note}`;
      }
      default:
        return `Unknown command ${tool}.`;
    }
  };
}

// ---------------------------------------------------------------------------
// TRANSCRIPT-MEMBERSHIP GATE
//
// The hunt prompt says "Never name a symbol you have not seen in a result."
// Nothing enforced it, and blind Gemini run 1 proposed `PlaybackBuffer::append`
// and `PlaybackBuffer::getSample` — no such class exists, and neither name
// appears anywhere in that run's transcript. verifySymbol's substring tier then
// resolved them to `AdPlaybackState::withLivePostrollPlaceholderAppended` (125
// ambiguous) and `SpeedChangingAudioProcessor::getSampleCountAfterProcessorApplied`
// (117 ambiguous), and both were reported as function-scale LOCATED SYMBOLS
// with line ranges and emitted into --targets.
//
// CE produced the transcript, so membership in it is ground truth — no reliance
// on the model's honesty. Rejections are REPORTED, never silently dropped:
// "the model named code that appears in no search result" is a finding about
// that model on that corpus, and is precisely the signal a local-GGUF run needs
// to surface.
// ---------------------------------------------------------------------------

// Symbol names that actually appeared in tool RESULTS. Command echo lines are
// excluded — the argument of `EXTRACT: Invented::name` is model input, not
// evidence. Prose responses ("No symbol named X in this codebase.") and source
// lines from EXTRACT fail the identifier shape and contribute nothing.
export function transcriptSymbols(log) {
  const full = new Set();
  const bare = new Set();
  for (const entry of log || []) {
    for (const rawLine of String(entry).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('>')) continue;
      const head = line.split(/\s{2,}/)[0].trim();
      if (!/^[A-Za-z_][\w:.$]*$/.test(head)) continue;
      full.add(head);
      bare.add(head.replace(/^.*::/, ''));
    }
  }
  return { full, bare };
}

// Was this selection observable from what the hunt actually saw?
// Verbatim passes. A qualified name whose CLASS and MEMBER were each seen
// passes as legitimate composition — run 2's `RtspMessageChannel::Sender::send`
// was built from a class seen in a search result and a member seen in an
// extract header, and verified exact. A guard that rejects that is too strict.
export function selectionSeen(name, seen) {
  const n = String(name || '').trim();
  if (!n) return false;
  if (seen.full.has(n) || seen.bare.has(n)) return true;
  if (!n.includes('::')) return false;
  const cls = n.slice(0, n.lastIndexOf('::'));
  const member = n.slice(n.lastIndexOf('::') + 2);
  const clsSeen = seen.full.has(cls) || seen.bare.has(cls.replace(/^.*::/, ''));
  return clsSeen && seen.bare.has(member);
}

export function partitionSelections(selections, log) {
  const seen = transcriptSymbols(log);
  const kept = [];
  const unseen = [];
  for (const s of selections || []) (selectionSeen(s.candidate, seen) ? kept : unseen).push(s);
  return { kept, unseen };
}

// Run the hunt. Returns { selections, toolCalls, rounds, log, stopped }.
// `draft` is the shared (sys, user, maxTokens) seam, so this is provider-neutral
// and unit-testable against a scripted mock.
export async function runSymbolHunt(draft, { claimText, elements, index, symbols, opts = {}, onStatus } = {}) {
  const D = HUNT_DEFAULTS;
  const maxRounds = opts.maxRounds ?? D.maxRounds;
  const budget = makeToolBudget({ maxCalls: opts.maxCalls ?? D.maxCalls, maxChars: opts.maxLogChars ?? D.maxLogChars });
  const run = makeHuntTools(index, symbols, opts);
  const status = (s) => { if (onStatus) onStatus(s); };

  // Gemma's chat wrapper drops system turns, and the family under-uses tools
  // without explicit insistence — the same reason the local overview loop
  // applies this framing. The drafter seam hides the wrapper name, so the
  // caller tells us when the target is a local Gemma build.
  const sys = opts.strictFraming
    ? strictInstructionsFor('Gemma', buildHuntPrompt())
    : buildHuntPrompt();
  const header = `PATENT CLAIM:\n${claimText}\n\nCLAIM ELEMENTS:\n`
    + elements.map((e, i) => `${i + 1}. ${e}`).join('\n');
  const log = [];
  let selections = [];
  let rounds = 0;
  let stopped = null;

  for (let turn = 0; turn < maxRounds; turn++) {
    rounds++;
    const transcript = log.length ? `\n\n--- YOUR HUNT SO FAR ---\n${log.join('\n\n')}` : '';
    const closing = budget.stopped
      ? '\n\nTOOL BUDGET EXHAUSTED — issue no more commands. Reply with the DONE block now, using only what you have already seen.'
      : (turn === maxRounds - 1
        ? '\n\nThis is your LAST turn. Reply with the DONE block now.'
        : '\n\nIssue your next commands, or reply DONE with your selections.');
    let raw;
    try { raw = await draft(sys, header + transcript + closing, 900); }
    catch (e) { stopped = `hunt turn failed: ${e.message}`; break; }

    const { actions, done, selections: sel } = parseHuntActions(raw || '');
    if (done) { selections = sel; stopped = 'done'; break; }
    if (!actions.length) {
      // No commands and no DONE: the model is talking instead of hunting. One
      // nudge, then give up rather than burn the budget on prose.
      if (log.length && log[log.length - 1].startsWith('(no commands')) { stopped = 'no-commands'; break; }
      log.push('(no commands recognized in your reply — reply with commands only, or the DONE block)');
      continue;
    }
    for (const a of actions) {
      const stop = budget.gate();
      if (stop) { budget.stopped = true; break; }
      status(`${a.tool}: ${a.arg}`.slice(0, 100));
      let out;
      try { out = String(run(a.tool, a.arg)); }
      catch (e) { out = `Error running ${a.tool}: ${e.message}`; }
      out = neutralizeSpecialTokens(out, `${a.tool} result`);
      budget.charge(out.length);
      log.push(`> ${a.tool}: ${a.arg}\n${out}`);
    }
  }
  if (!stopped) stopped = 'max-rounds';
  // budget.calls counts attempts including the one that tripped the stop.
  const toolCalls = Math.max(0, budget.stopped ? budget.calls - 1 : budget.calls);
  return { selections, toolCalls, rounds, log, stopped };
}

export function buildProposePrompt(profile) {
  return `You locate the code that implements a patent claim, in a specific codebase.

You will be given a patent claim and a profile of the codebase being examined.

For EACH numbered claim element, name the CLASSES and METHODS you would expect \
to implement it in a codebase of this kind. Use your knowledge of how such \
systems are actually built and what their components are conventionally named.

CRITICAL:
- Answer with SYMBOL NAMES (class, method, or Class::method), not search terms, \
not regular expressions, not prose.
- Draw on your domain knowledge. You are NOT restricted to names appearing in \
the profile — the profile is a style reference, not a whitelist.
- Prefer the specific component that PERFORMS the element's action over generic \
container classes.
- If you genuinely cannot name a plausible implementer for an element, write \
NONE for it. An element with no plausible implementer is meaningful evidence.
- Every name you give will be checked against the real index and reported as \
verified or not found, so guess your best but do not pad the list.

OUTPUT FORMAT — one line per claim element, nothing else:
ELEMENT 1: Name; Class::method; Other
ELEMENT 2: NONE

CODEBASE PROFILE:
${profile}`;
}

export function buildRefinePrompt(notFound, table) {
  const blocks = notFound.map((v) => {
    const near = nearbySymbols(table, v.candidate, 8).map((s) => s.name);
    return `${v.candidate} -> NOT FOUND. Real symbols sharing its words: ${near.length ? near.join('; ') : '(none)'}`;
  });
  return `Some proposed symbols do not exist in this codebase. Below is each \
failed proposal with REAL symbol names from the index that share its words.

Revise ONLY the failed proposals. Choose from the real names shown, or propose \
different names you believe exist. Do not repeat names already marked NOT FOUND.

OUTPUT FORMAT — one line per revision, nothing else:
ELEMENT 1: RealName; Other::realMethod

FAILED PROPOSALS:
${blocks.join('\n')}`;
}

// Render the located-symbol report. Provenance per row is the point.
export function formatLocateReport(rows, opts = {}) {
  const out = ['', '='.repeat(72), ' LOCATED SYMBOLS — model-proposed, index-verified', '='.repeat(72), ''];
  const found = rows.filter((r) => r.verified);
  const missing = rows.filter((r) => !r.verified);
  if (!found.length) {
    out.push('  No proposed symbol could be verified in this index.');
  }
  for (const r of found) {
    const m = r.match;
    const span = (m.end != null && m.start != null) ? (m.end - m.start) : null;
    const scale = span == null ? '' : (span <= LOCATE_DEFAULTS.maxSeedSpan ? ', function-scale' : `, class-scale ${span} lines`);
    out.push(`  [${r.status}${scale}] ${m.name}  (L${m.start}-${m.end})`);
    out.push(`      ${m.filepath.split('!').pop()}`);
    if (r.element != null) out.push(`      claim element ${r.element}`);
    if (r.viaNavigation) {
      out.push(`      reached by navigation from ${r.viaNavigation} (not model-proposed)`);
    } else {
      out.push(`      proposed as: ${r.candidate}${r.round === 2 ? ' (refine round)' : ''}`);
    }
    if (r.ambiguous > 1) {
      out.push(`      AMBIGUOUS: ${r.ambiguous} symbols match this name — first shown; verify manually`);
    }
    if (r.nav && (r.nav.callers.length || r.nav.callees.length)) {
      if (r.nav.callees.length) out.push(`      calls: ${r.nav.callees.slice(0, 6).join(', ')}`);
      if (r.nav.callers.length) out.push(`      called by: ${r.nav.callers.slice(0, 6).join(', ')}`);
    }
    out.push('');
  }
  if (missing.length) {
    out.push(`  NOT FOUND in this index (${missing.length}) — proposed by the model, no such symbol:`);
    for (const r of missing) out.push(`    ${r.candidate}${r.element != null ? `  [element ${r.element}]` : ''}`);
    out.push('');
  }
  out.push(`  Verified ${found.length} of ${rows.length} proposals.`);

  // SPECIFICITY. Verification rate alone is a RISK metric, not a quality one:
  // measured on the '101 claim, one provider verified 48 of 48 (zero
  // hallucinations) by proposing generic container classes and missed the
  // claimed mechanism entirely, while providers that risked specific decision
  // functions had NOT-FOUNDs and found it. So report how much of what was
  // verified is actually function-scale, and flag the safe-and-empty pattern.
  const proposed = found.filter((r) => !r.viaNavigation);
  const spanOf = (r) => ((r.match.end != null && r.match.start != null) ? r.match.end - r.match.start : null);
  const fnScale = proposed.filter((r) => { const s = spanOf(r); return s != null && s <= LOCATE_DEFAULTS.maxSeedSpan; }).length;
  const pct = proposed.length ? Math.round((fnScale / proposed.length) * 100) : 0;
  const ambig = found.filter((r) => r.ambiguous > 1).length;
  out.push(`  Specificity: ${fnScale}/${proposed.length} model-proposed symbols are function-scale (${pct}%);`);
  out.push(`  ${ambig} ambiguous name(s); ${missing.length} not found.`);
  if (proposed.length >= 5 && pct < 35 && missing.length === 0) {
    out.push('  NOTE: high class-scale share with zero not-found suggests the model');
    out.push('        proposed safe container classes rather than the specific code');
    out.push('        performing each element — treat coverage here as weak.');
  }
  // Selections the hunt never saw. Reported as a model-reliability finding for
  // this corpus, not hidden — and kept out of the verified rows and --targets.
  if (opts.unseen && opts.unseen.length) {
    out.push(`  REJECTED — named by the model but absent from every search result (${opts.unseen.length}):`);
    for (const u of opts.unseen) out.push(`    ${u.candidate}${u.element != null ? `  [element ${u.element}]` : ''}`);
    out.push('    These were not verified. A name the hunt never saw is a guess, and');
    out.push('    substring matching can resolve a guess to an unrelated real symbol.');
    out.push('');
  }

  // FABRICATION GUARD (ported from the local overview loop's #276 lesson). A
  // hunt that made zero tool calls searched nothing: its selections came from
  // the model's memory of some codebase, not from this index. Verification
  // still ran, so nonexistent names were caught — but a guess that happens to
  // exist would otherwise read as a discovered result. Say so unmissably.
  if (opts.hunt) {
    const h = opts.hunt;
    if (h.toolCalls === 0) {
      out.push('');
      out.push('  ⚠ UNGROUNDED: the model issued NO searches, so nothing above was');
      out.push('    discovered from this index — any name it produced came from its own');
      out.push('    priors and merely survived verification. Treat as a failed hunt.');
    } else if (h.stopped !== 'done') {
      out.push('');
      out.push(`  NOTE: the hunt ended on '${h.stopped}' rather than the model's own DONE —`);
      out.push('    selections were forced, not concluded. Consider --hunt-rounds/--hunt-calls.');
    }
  }
  out.push('  Symbol names come from the model\'s domain knowledge; existence,');
  out.push('  location, and call relationships come from the index.');
  if (opts.targetsLine && found.length) {
    const targets = targetSpecs(found);
    out.push('');
    out.push('  Use as claim-chart targets:');
    out.push(`    --targets "${targets.join(';')}"`);
    // The provenance-carrying form. Indented for the report; --claim-chart
    // trims each line, so this block can be copy-pasted into a file as-is.
    if (opts.provenance && opts.provenance.length) {
      out.push('');
      out.push('  Or as a targets FILE, provenance included (--targets-out writes this):');
      for (const l of opts.provenance) out.push(`    # ${l}`);
      for (const t of targets) out.push(`    ${t}`);
    }
  }
  return out;
}

/** `File.java@symbol` specs for verified rows — the targets a chart consumes. */
// What to do with a navigated callee once the index has been asked about it.
// Split out from the promotion loop so the rule is testable and so the three
// outcomes are named rather than implied by control flow.
//
//   not-found  — the index has no such symbol; nothing to say.
//   ambiguous  — several definitions share the name and the index cannot tell
//                which one the caller reaches. Promoting matches[0] would put
//                an ASSERTED edge ("reached by navigation from X") into the
//                targets file and the chart's citations on a coin flip: `clear`
//                has 59 definitions in the ExoPlayer index.
//   promote    — exactly one definition, so the edge is established.
export function classifyNavCallee(v) {
  if (!v || !isFound(v)) return 'not-found';
  return v.ambiguous > 1 ? 'ambiguous' : 'promote';
}

export function targetSpecs(found) {
  return dedupeTargets(found.map(
    (r) => `${r.match.filepath.split('!').pop().split('/').pop()}@${r.match.name}`)).targets;
}

// Identity key for a target spec. `File.java@Class::method` and
// `File.java@method` name the SAME function, and both forms appear — models mix
// conventions within one list, and two engines disagree on which they emit. A
// string compare would leave both, so the chart would analyse one function
// twice, pay twice, and count it twice in the per-element agreement tally that
// exists to show how lonely a finding is.
export function normalizeTargetSpec(spec) {
  const s = String(spec || '').trim();
  const at = s.lastIndexOf('@');
  const file = (at >= 0 ? s.slice(0, at) : '').split(/[\\/]/).pop().toLowerCase();
  const sym = (at >= 0 ? s.slice(at + 1) : s).trim();
  return `${file}@${sym.replace(/^.*::/, '').toLowerCase()}`;
}

// Collapse duplicates, then drop any CLASS target whose own methods are also
// targeted. On the live run Claude's list held `AdaptiveTrackSelection.java@
// AdaptiveTrackSelection` — 815 lines, and ambiguous (--extract resolves two
// symbols for that name) — alongside four of its methods. The class body
// already contains them, so the same source went to the model five times and
// four verdicts rested on evidence the fifth subsumed.
//
// Methods win over the class: the methods are the specific evidence, and a
// citation to an 815-line class is not a citation a reader can check.
export function dedupeTargets(specs) {
  const seen = new Map();
  let duplicates = 0;
  for (const spec of specs || []) {
    const key = normalizeTargetSpec(spec);
    if (seen.has(key)) { duplicates++; continue; }
    seen.set(key, spec);
  }
  // A spec is class-shaped for this purpose when another spec in the same file
  // qualifies its members with that class name (`File@Cls` vs `File@Cls::m`).
  //
  // EVERY qualifier segment counts, not just the outermost. Nested classes are
  // common in Java and the live gemini run produced two cases the
  // outermost-only version missed: `AdTagLoader.java@ContentPlaybackAdapter`
  // beside `AdTagLoader::ContentPlaybackAdapter::getContentProgress`, and
  // `NetworkTypeObserver.java@Receiver` beside
  // `NetworkTypeObserver::Receiver::onReceive`. Splitting on the first `::`
  // registered only `AdTagLoader` / `NetworkTypeObserver`, so the nested class
  // survived alongside its own method — the exact redundancy this rule exists
  // to remove.
  const owners = new Set();
  for (const spec of seen.values()) {
    const at = spec.lastIndexOf('@');
    const sym = at >= 0 ? spec.slice(at + 1) : spec;
    const file = (at >= 0 ? spec.slice(0, at) : '').split(/[\\/]/).pop().toLowerCase();
    const parts = sym.split('::');
    // All but the last segment: the last is the member, the rest are containers.
    for (const p of parts.slice(0, -1)) owners.add(`${file}@${p.toLowerCase()}`);
  }
  const kept = [];
  const containers = [];
  for (const spec of seen.values()) {
    const at = spec.lastIndexOf('@');
    const sym = at >= 0 ? spec.slice(at + 1) : spec;
    if (!sym.includes('::') && owners.has(normalizeTargetSpec(spec))) { containers.push(spec); continue; }
    kept.push(spec);
  }
  return { targets: kept, duplicates, containers };
}

// Checksum over the NORMALIZED target list (one per line), so it survives
// reformatting — `;`-joined on one line and one-per-line hash identically,
// because both sides compute it over the parsed array.
export function targetsChecksum(targets) {
  const norm = (targets || []).map((t) => String(t).trim()).filter(Boolean).join('\n');
  return crypto.createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16);
}

// The `#` provenance block stamped into the targets file this command emits.
//
// This exists because the first '101 chart's provenance block was TYPED BY
// HAND: --claim-locate recorded nothing about how it was invoked, so "was this
// actually run with --llm gemini?" could not be answered from the artifact —
// only from a filename and someone's recollection. In a deliverable whose
// premise is "this is exactly what CE produced", the block a reader leans on
// hardest to check that premise must not be the one block a human wrote.
//
// Mode flags print from the PARSED ARGS, not from a re-render of argv, so a
// truncated or reconstructed command line cannot misreport the mode that ran.
export function buildTargetsProvenance({
  ceVersion, engine, blind, hunt, mode, indexPath, indexFiles, indexSymbols,
  claimSource, claimChars, elements, argv, generatedAt, targets,
  perElementSelect, selectionCalls,
}) {
  const flags = [hunt ? '--hunt' : null, blind ? '--blind' : null,
    perElementSelect ? '--per-element-select' : null].filter(Boolean).join(' ');
  const lines = [];
  lines.push(`Produced by CodeExam${ceVersion ? ` ${ceVersion}` : ''} --claim-locate${flags ? ` ${flags}` : ''}`);
  lines.push(`Mode: ${mode}`);
  // Two runs of the same command line produce different target lists depending
  // on this, so the file has to say which it was.
  if (!hunt && selectionCalls != null) {
    lines.push(perElementSelect
      ? `Selection: per-element — ${selectionCalls} model call(s), one per element`
      : 'Selection: pooled — one model call chose across all elements at once');
  }
  lines.push(`Engine: ${engine}`);
  lines.push(`Index: ${indexPath || 'unknown'}${indexFiles != null ? ` (${indexFiles} files` : ''}${
    indexSymbols != null ? `${indexFiles != null ? ', ' : ' ('}${indexSymbols} symbols)` : (indexFiles != null ? ')' : '')}`);
  lines.push(`Claim: ${claimSource || 'inline text'}${claimChars != null ? ` (${claimChars} chars` : ''}${
    elements != null ? `, ${elements} element${elements === 1 ? '' : 's'})` : (claimChars != null ? ')' : '')}`);
  if (hunt) {
    lines.push(`Hunt: ${hunt.toolCalls} tool call(s) over ${hunt.rounds} round(s), `
      + `caps ${hunt.maxCalls}/${hunt.maxRounds}; ended: ${hunt.stopped}`);
  }
  if (argv) lines.push(`Command: ${argv}`);
  lines.push(`Generated: ${generatedAt}`);
  lines.push('Uncurated: this is the command\'s own output, unedited.');
  lines.push(`Targets-checksum: ${targetsChecksum(targets)}`);
  return lines;
}

export async function doClaimLocate(index, args, opts = {}) {
  const spec = args.claim_locate;
  let claimText = spec;
  if (typeof spec === 'string' && spec.startsWith('@')) {
    try { claimText = fs.readFileSync(spec.slice(1), 'utf8'); }
    catch (e) { console.error(`Cannot read claim file: ${e.message}`); process.exitCode = 1; return; }
  }
  if (!claimText || !String(claimText).trim()) {
    console.error('--claim-locate needs claim text: --claim-locate @claim.txt'); process.exitCode = 1;
    return;
  }
  claimText = String(claimText).trim();

  const model = resolveModel(args);
  if (!model) { console.error('--claim-locate needs a model: --llm <provider> or --model <gguf>.'), process.exitCode = 1; return; }
  if (model.kind === 'error') { console.error(`Error: ${model.error}`), process.exitCode = 1; return; }
  let draft;
  try { draft = opts.draft || makeDrafter(model, args.temperature ?? 0); }
  catch (e) { console.error(`--claim-locate: ${e.message}`); process.exitCode = 1; return; }

  const symbols = buildSymbolTable(index);
  if (!symbols.length) { console.error('Index has no function/class symbols to verify against.'), process.exitCode = 1; return; }
  const elements = splitClaimElements(claimText);
  const blind = !!args.blind;

  const hunting = !!args.hunt && args.no_hunt !== true;
  const perElementSelect = args.per_element_select === true;
  let selectionCalls = null;   // set by the discovery path; null on hunt/priors
  const modeLabel = args.propose_from_priors
    ? 'propose-from-priors (model names symbols from its own knowledge)'
    : hunting
      ? `scavenger hunt (model searches the symbol table itself)${blind ? ' — BLIND' : ''}`
      : `symbol-table discovery${blind ? ' — BLIND (no paths or codebase identity shown to the model)' : ''}`;
  console.log(`Claim: ${claimText.length} chars, ${elements.length} element(s)`);
  console.log(`Index: ${symbols.length} symbols`);
  console.log(`Mode: ${modeLabel}`);
  console.log();

  let proposals = [];
  let discovery = null;
  let hunt = null;
  let huntUnseen = [];

  if (hunting) {
    // The model drives its own search. Budget is bounded and reported, so a run
    // that hit the ceiling is distinguishable from one that finished thinking.
    const maxRounds = Number(args.hunt_rounds) > 0 ? Number(args.hunt_rounds) : HUNT_DEFAULTS.maxRounds;
    const maxCalls = Number(args.hunt_calls) > 0 ? Number(args.hunt_calls) : HUNT_DEFAULTS.maxCalls;
    // Cost gate: worst case is every round issuing a full turn.
    if (!claimsCostGate(model, Array.from({ length: maxRounds },
      () => ({ inChars: 4000 + HUNT_DEFAULTS.maxLogChars / 2, outTokens: 900 })),
    `claim-locate hunt (up to ${maxRounds} rounds)`, args)) return;
    resetCloudUsage();
    hunt = await runSymbolHunt(draft, {
      claimText, elements, index, symbols,
      opts: {
        maxRounds, maxCalls, blind, includeTests: !!args.include_tests,
        strictFraming: model.kind === 'gguf' && /gemma/i.test(model.modelPath || ''),
      },
      onStatus: (s) => process.stderr.write(`  ${s}\n`),
    });
    // Carry the caps on the result so the provenance block can report what the
    // ceiling WAS, not just how close the run got to it — a run that finished
    // under a raised cap and one that hit a default cap are different runs.
    hunt.maxRounds = maxRounds; hunt.maxCalls = maxCalls;
    console.log(`Hunt: ${hunt.toolCalls} tool call(s) over ${hunt.rounds} round(s); ended: ${hunt.stopped}`);
    if (args.verbose) for (const entry of hunt.log) console.log(`\n${entry}`);
    // Reject selections the hunt never actually saw, before verification can
    // dress an invented name as a located symbol.
    const part = partitionSelections(hunt.selections, hunt.log);
    huntUnseen = part.unseen;
    if (part.unseen.length) {
      console.log(`  ${part.unseen.length} selection(s) named no symbol from any search result — rejected.`);
    }
    proposals = part.kept.slice(0, LOCATE_DEFAULTS.maxProposals);
    console.log();
  } else if (args.propose_from_priors) {
    // LEGACY PATH — only sound for codebases the model has memorized. On
    // confidential code there is nothing to recall, which is the real use
    // case, so this is opt-in and labeled.
    const profile = buildIndexProfile(index, symbols);
    const sys = buildProposePrompt(profile);
    const user = `PATENT CLAIM:\n${claimText}\n\nNumbered elements:\n`
      + elements.map((e, i) => `${i + 1}. ${e}`).join('\n');
    if (!claimsCostGate(model, [{ inChars: sys.length + user.length, outTokens: 500 }], 'claim-locate propose', args)) return;
    resetCloudUsage();
    process.stderr.write('Proposing implementing symbols from model knowledge...\n');
    let raw;
    try { raw = await draft(sys, user, 800); }
    catch (e) { console.error(`--claim-locate: propose failed: ${e.message}`); process.exitCode = 1; return; }
    proposals = parseProposedSymbols(raw || '').slice(0, LOCATE_DEFAULTS.maxProposals);
  } else {
    // DISCOVERY PATH (default). Step 1 gives the model the claim ONLY — no
    // codebase name, no paths, no profile — so nothing here can be answered
    // from memory of a specific repository.
    const sys1 = buildDiscoverPrompt();
    const user1 = `CLAIM ELEMENTS:\n` + elements.map((e, i) => `${i + 1}. ${e}`).join('\n');
    // Selection POOLS all elements into one call by default. Splitting it per
    // element was tried and measured on 2026-08-08 ('101 claim, --llm claude,
    // n=5/6, same build both arms) and LOST:
    //
    //   metric                    pooled     per-element
    //   shouldStartPlayback        5/5          3/6
    //   determineIdealSelectedIndex 5/5         6/6
    //   on-crux density            25%          53%
    //   targets/run                22.6         14.3
    //
    // The hypothesis was that 150 candidate lines under one 700-token answer
    // budget made the model miss candidates that were on the page. Pooled does
    // not miss `shouldStartPlayback`; isolating elements loses it. Best current
    // explanation: pooling supplies CONTEXT, not just competition — a claim is
    // one system, and seeing the storage and rate-determination elements helps
    // the model recognise the buffering-control function as the reproduction-
    // start implementer. Isolation removes information along with the noise.
    // For a legal deliverable recall beats concentration, so pooled is the
    // default; --per-element-select keeps the other arm measurable, and its
    // density gain may yet win on the local path where fewer, denser targets
    // means fewer chart analyses.
    const nSel = perElementSelect ? elements.length : 1;
    const selCost = Array.from({ length: nSel }, () => (perElementSelect
      ? { inChars: 2000, outTokens: 120 }
      : { inChars: 6000, outTokens: 300 }));
    if (!claimsCostGate(model, [{ inChars: sys1.length + user1.length, outTokens: 400 }, ...selCost],
      `claim-locate discovery (${1 + nSel} calls)`, args)) return;
    resetCloudUsage();

    process.stderr.write('Step 1: predicting code vocabulary from the claim (no codebase shown)...\n');
    let rawWords;
    try { rawWords = await draft(sys1, user1, 600); }
    catch (e) { console.error(`--claim-locate: vocabulary step failed: ${e.message}`); process.exitCode = 1; return; }
    const wordSets = parseElementWords(rawWords || '');
    if (!wordSets.length) {
      console.error('The model produced no parseable code-word predictions.'); process.exitCode = 1;
      if (args.verbose) console.log(rawWords);
      return;
    }

    // Step 2: CE greps its own symbol table — ground truth, no model involved.
    const perElement = [];
    for (const { element, words } of wordSets) {
      const hits = searchSymbolsByWords(symbols, words, { limit: LOCATE_DEFAULTS.candidatesPerElement, includeTests: !!args.include_tests });
      perElement.push({ element, text: (elements[element - 1] || '').slice(0, 160), words, hits });
      console.log(`  element ${element}: words [${words.join(', ')}] -> ${hits.length} candidate(s)`);
    }
    discovery = perElement;
    const withHits = perElement.filter((p) => p.hits.length);
    if (!withHits.length) {
      console.log('\nNo symbol in this index matches any predicted code word.');
      return;
    }

    // Step 3: the model chooses among symbols that DEMONSTRABLY EXIST.
    process.stderr.write(`Step 3: selecting implementers from real candidates`
      + `${perElementSelect ? `, one call per element (${withHits.length})` : ''}...\n`);
    selectionCalls = perElementSelect ? withHits.length : 1;
    if (!perElementSelect) {
      let rawSel;
      try { rawSel = await draft(buildSelectPrompt(withHits, { blind }), `PATENT CLAIM:\n${claimText}`, 700); }
      catch (e) { console.error(`--claim-locate: selection step failed: ${e.message}`); process.exitCode = 1; return; }
      proposals = parseProposedSymbols(rawSel || '').slice(0, LOCATE_DEFAULTS.maxProposals);
    } else {
      let failed = 0;
      for (const pe of withHits) {
        let rawSel;
        try { rawSel = await draft(buildSelectPrompt([pe], { blind }), `PATENT CLAIM:\n${claimText}`, 300); }
        catch (e) {
          // One element failing must not lose the other five. Report and go on.
          process.stderr.write(`  element ${pe.element}: selection failed: ${e.message}\n`);
          failed++;
          continue;
        }
        // The element number is OURS, not the model's. Asked about one element
        // in isolation, a model commonly answers "ELEMENT 1:" whatever the real
        // number is; taking its word would mis-attribute every selection after
        // the first.
        const picked = parseProposedSymbols(rawSel || '').map((p) => ({ ...p, element: pe.element }));
        proposals.push(...picked);
      }
      if (failed) process.stderr.write(`  ${failed} of ${withHits.length} element selection(s) failed.\n`);
      proposals = proposals.slice(0, LOCATE_DEFAULTS.maxProposals);
    }
    console.log();
  }

  if (!proposals.length) {
    // A hunt that searched and then answered NONE for every element is a
    // RESULT, not a parse failure: the model looked and reported the codebase
    // does not contain implementers. Only call it an error if nothing was
    // searched, or if we are not hunting at all.
    if (hunt && hunt.toolCalls > 0 && hunt.stopped === 'done') {
      for (const u of huntUnseen) console.log(`  REJECTED (never seen in a search result): ${u.candidate}`);
      console.log(`After ${hunt.toolCalls} search(es), the model named no implementing symbol for any element.`);
      console.log('That is a substantive answer — this index may not contain the claimed mechanism.');
      return { rows: [], symbols: symbols.length, hunt };
    }
    console.error(hunt
      ? `No symbol selections were parseable (hunt ended: ${hunt.stopped}, ${hunt.toolCalls} tool call(s)).`
      : 'No symbol selections were parseable.');
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`  ${proposals.length} selection(s); verifying against the index...\n`);

  const rows = [];
  const seen = new Set();
  const verifyInto = (list, round) => {
    for (const p of list) {
      if (seen.has(p.candidate)) continue;
      seen.add(p.candidate);
      const v = verifySymbol(symbols, p.candidate);
      const ok = isFound(v);
      rows.push({
        candidate: p.candidate, element: p.element, round,
        verified: ok, status: v.status, ambiguous: v.ambiguous || 0,
        match: ok ? v.matches[0] : null,
        nav: ok ? navigateFrom(index, v.matches[0], { limit: LOCATE_DEFAULTS.navLimit }) : null,
      });
    }
  };
  verifyInto(proposals, 1);

  // Promote NAVIGATION results to first-class verified rows. The one-hop
  // callees of a correctly-resolved symbol are where the decision logic
  // actually lives — `determineIdealSelectedIndex` is a callee of
  // `updateSelectedTrack`, and both independent model analyses named it. It
  // is unreachable by proposal alone (models name the entry point), so the
  // index contributes it. Marked `via-navigation` so provenance stays honest.
  if (args.no_navigate !== true) {
    // Promote CALLEES only, and only from FUNCTION-sized seeds. Measured on
    // the '101 re-run: promoting callers too, from class-sized seeds, produced
    // 129 rows — mostly constructor noise under the 2,000-line `ExoPlayer`
    // class, plus test classes arriving as "callers". Callees of a real
    // function are where decision logic lives (determineIdealSelectedIndex is
    // a callee of the 50-line updateSelectedTrack); a class's callees are its
    // members, which say nothing about the claim.
    let promoted = 0;
    let navTestsSkipped = 0;
    // A promoted callee carries an ASSERTED call edge ("reached by navigation
    // from X") into the targets file and thence into the chart's citations. The
    // index frequently cannot resolve that edge: `--callees` on
    // CachedContentIndex::store reports `size [unresolved] (27 definitions)`,
    // `clear [unresolved] (59)`. Taking matches[0] of 59 is right about 2% of
    // the time, and CE then states the relationship as fact — a false
    // provenance claim inside the deliverable, which is worse than noise.
    // Observed live on 2026-08-07 in BOTH engines' target lists.
    let navAmbiguousSkipped = 0;
    const navAmbiguousNames = [];
    const navSeeds = rows.filter((r) => r.verified && r.nav
      && r.match.start != null && (r.match.end - r.match.start) <= LOCATE_DEFAULTS.maxSeedSpan);
    for (const seed of navSeeds) {
      if (promoted >= LOCATE_DEFAULTS.maxNavRows) break;
      for (const name of seed.nav.callees.slice(0, LOCATE_DEFAULTS.navPerSeed)) {
        if (promoted >= LOCATE_DEFAULTS.maxNavRows) break;
        if (seen.has(name)) continue;
        // Resolve within the SEED'S OWN FILE first — a bare callee name is
        // ambiguous index-wide (8 symbols are named `updateSelectedTrack`).
        const local = symbols.filter((s) => s.filepath === seed.match.filepath && s.bare === name.replace(/^.*::/, ''));
        const v = local.length ? { status: 'exact', matches: local, ambiguous: local.length > 1 ? local.length : 0 }
          : verifySymbol(symbols, name);
        // Deliberately NOT applied to model-PROPOSED symbols: those carry the
        // model's own qualifier and are reported with an AMBIGUOUS warning for
        // the operator to adjudicate. This gate is narrow to navigation, where
        // nothing chose the symbol at all.
        const verdict = classifyNavCallee(v);
        if (verdict === 'not-found') continue;
        if (verdict === 'ambiguous') {
          navAmbiguousSkipped++;
          if (navAmbiguousNames.length < 8) navAmbiguousNames.push(`${name} (${v.ambiguous})`);
          continue;
        }
        // Same test predicate SEARCH and MEMBERS apply. Not because test code
        // is noise — a claim reading on instrumentation, coverage, fault
        // injection or a harness lands squarely in test utilities — but because
        // --include-tests must mean the SAME thing on every path. Before this,
        // an operator who excluded test code still got it (FakeClock arrived as
        // a callee of updateSelectedTrack on the live '101 run), and an
        // operator who wanted it had no way to know navigation was the only
        // reason any appeared.
        if (!args.include_tests && isTestSymbol(v.matches[0])) { navTestsSkipped++; continue; }
        seen.add(name);
        promoted++;
        rows.push({
          candidate: name, element: seed.element, round: 1,
          verified: true, status: v.status, ambiguous: v.ambiguous,
          match: v.matches[0], nav: null,
          viaNavigation: seed.match.name,
        });
      }
    }
    // Never lose a symbol silently. An operator examining a test suite as the
    // accused artifact needs to know --include-tests is what they want.
    if (navTestsSkipped) {
      console.log(`  ${navTestsSkipped} navigated symbol(s) skipped as test code `
        + '(--include-tests to keep them).');
    }
    // Never lose a symbol silently — same rule as the test-code skip. The count
    // is also the diagnostic: a large number here means the seed's callees are
    // mostly common names (`get`, `size`, `build`), which is itself a signal
    // that the seed is not a useful navigation origin.
    if (navAmbiguousSkipped) {
      console.log(`  ${navAmbiguousSkipped} navigated symbol(s) skipped as ambiguous — the`
        + ' index cannot resolve which definition the caller reaches, so promoting one'
        + ' would assert a call edge that is not established'
        + `: ${navAmbiguousNames.join(', ')}${navAmbiguousSkipped > navAmbiguousNames.length ? ', …' : ''}`);
    }
  }

  // ONE bounded refine round: hand back real symbols sharing the failed
  // proposals' words. No open-ended loop.
  const missing = rows.filter((r) => !r.verified);
  if (missing.length && args.no_refine !== true && LOCATE_DEFAULTS.refine) {
    process.stderr.write(`  ${missing.length} not found; one refine round...\n`);
    const rp = buildRefinePrompt(missing, symbols);
    try {
      const raw2 = await draft(rp, `PATENT CLAIM:\n${claimText}`, 600);
      verifyInto(parseProposedSymbols(raw2 || ''), 2);
    } catch (e) {
      process.stderr.write(`  refine round failed: ${e.message}\n`);
    }
  }

  const found = rows.filter((r) => r.verified);
  const provenance = found.length ? buildTargetsProvenance({
    ceVersion: readCeVersion(),
    engine: describeEngine(model),
    blind, hunt, mode: modeLabel,
    perElementSelect, selectionCalls,
    indexPath: args.index_path || '(unknown)',
    indexFiles: index.files ? (index.files.size ?? index.files.length ?? null) : null,
    indexSymbols: symbols.length,
    claimSource: typeof spec === 'string' && spec.startsWith('@') ? spec.slice(1) : null,
    claimChars: claimText.length,
    elements: elements.length,
    argv: process.argv.slice(1).join(' '),
    generatedAt: new Date().toISOString(),
    targets: targetSpecs(found),
  }) : [];

  for (const ln of formatLocateReport(rows, {
    targetsLine: true, hunt, unseen: huntUnseen, provenance,
  })) console.log(ln);

  // --targets-out closes the loop mechanically: the chart reads this file and
  // reports the provenance verbatim, with no hand-copying step in between —
  // and hand-copying is exactly where the risk of an edited-but-still-vouched
  // target list enters.
  if (args.targets_out && found.length) {
    const body = [...provenance.map((l) => `# ${l}`), ...targetSpecs(found), ''].join('\n');
    try {
      fs.writeFileSync(args.targets_out, body, 'utf8');
      console.log(`\nTargets written to ${args.targets_out} (${found.length} target(s), provenance included).`);
    } catch (e) {
      console.error(`--targets-out: cannot write ${args.targets_out}: ${e.message}`);
      process.exitCode = 1;
    }
  }

  const cost = actualCostLine(model);
  if (cost) console.log(cost);
  return { rows, symbols: symbols.length, hunt };
}
