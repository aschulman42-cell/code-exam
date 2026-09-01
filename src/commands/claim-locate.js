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
// CIRCULAR, AND SAFE — but say so rather than leave it to be rediscovered.
// analyze.js already imports splitClaimElements/retrievePerElement from this
// file, so this edge closes a cycle. It works because `readClaimFile` is only
// ever referenced INSIDE a function body, never at module-init time, so the
// binding is resolved by the time anything calls it. Verified in BOTH load
// orders, which is where a cycle normally bites.
//
// It is still the wrong home for a helper three commands share. `readClaimFile`
// belongs in `utils.js` — which all of them already import — and moving it is a
// small follow-up deliberately kept out of this item's scope.
import { readClaimFile } from './analyze.js';
import { parseMultisectTerms } from './multisect.js';
import { isPseudoSource } from '../binstrings.js';
import { claimGenericity } from '../core/claim-genericity.js';
import { wasLastDraftTruncated, resolveModel, makeDrafter, claimsCostGate, actualCostLine, resetCloudUsage, describeEngine } from '../core/llm-runner.js';
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
  // A BOUND on the content arm, not a target. Content search is more expensive
  // than a symbol-table scan and its hits are a different kind of evidence, so
  // it contributes a minority of each element's candidate list rather than
  // flooding it. 8 against candidatesPerElement's 25 keeps the name arm
  // dominant while leaving room for the case the arm exists for — a symbol
  // whose NAME says nothing, which name search cannot reach at any depth.
  contentPerElement: 8,
};

export const SPLIT_DEFAULTS = {
  // A fragment shorter than this is a connective ("and", "wherein:"), not a
  // limitation, so it merges back into its neighbour instead of becoming a row.
  //
  // 35 measured, not guessed. Sweeping the floor over the two real claims on
  // disk ('101 claim 1, samples/tls_demo/sample_patent_claim.txt):
  //
  //   floor    25    30    35    40    50
  //   '101     12    10    10    10    10
  //   TLS      12    11    11    11    11
  //
  // At 25 the split strands connectives — `which is a time available` (25) and
  // `wherein verifying comprises:` (28) become rows. 30 through 50 are one
  // plateau, so the value is chosen from the INTERIOR of a stable region rather
  // than its edge: at exactly 30, `for determining the code rate.` (30 chars,
  // a bare purpose clause with no conditions) squeaks in as its own row, which
  // is a split no practitioner would make. The real '101 counterpart carries
  // 255 chars of conditions and splits at any floor in the range.
  minElementChars: 35,
  // Ceiling on rows. On overflow the COARSE split is returned rather than a
  // truncated fine one: dropping limitations from a legal deliverable is worse
  // than charting them coarsely.
  maxElements: 40,
};

// Sub-element markers — "(a)", "(b)", "(i)", "(ii)". A claim using them is
// declaring its own structure, so they outrank every heuristic below.
const SUBELEMENT_RE = /^\s*\(\s*(?:[a-z]|[ivx]+|\d+)\s*\)\s*/i;

// Stage-B boundaries: constructions that introduce a separately-arguable
// limitation. Each splits BEFORE the match, so the connective travels with the
// fragment it introduces. Order matters — the regex alternation is
// first-match-wins, not longest-match — so the more specific "and also" and
// "which is" precede the bare ", and".
// `whereby` is NOT here, deliberately. Andrew (#310): it is "generally treated
// as non-limiting", so splitting on it manufactures a row that should not exist.
// Elsewhere he puts it more carefully -- whereby clauses "may or may not
// constitute limitations depending on context" -- so the fix is to stop treating
// it as an AUTOMATIC boundary, not to treat it as automatically ignorable; the
// text still lands in whichever element contains it.
//
// MEASURED: 30 of 5,382 real independent claims contain `whereby` (0.56%),
// against `wherein` at 67.7% as a control. About 1 claim in 180 was getting a
// spurious row -- rare, never zero, and invisible unless someone read the claim
// carefully.
//
// `for <verb>ing` is NOT here either, as of claim-granularity-tiers. It was a
// stage-B boundary from the first version, calibrated on the one '101 claim.
// Measured against the drafting attorneys' own element structure for 380
// litigated claim 1s (test/fixtures/litigated-claim1-structure.jsonl, f2179ab):
// it cut INSIDE single attorney elements 315 times, and what it produced was
// fragments, not limitations -- US 7,703,036 became "receiving an indication
// of a selection of an object" / "for editing via the software application"
// as two rows, and means-plus-function claims were cut at "...including
// means" / "for associating data...". A purpose phrase is not a separately
// arguable limitation. Dropping it moved count agreement with the attorneys
// from 30% to 42% and left 95% of fine rows inside one attorney element. The
// remaining boundaries are the litigator's cuts and stay: each embedded
// `wherein`, `, and`, `which is` is a narrowing a chart argues on its own.
const BOUNDARY_RE = new RegExp([
  String.raw`\bwherein\b`,
  String.raw`,?\s+and\s+also\s+`,
  String.raw`,\s*which\s+is\b`,
  String.raw`,\s*and\s+(?=\w)`,
].join('|'), 'gi');

// Cut one coarse element at every boundary, then merge back any fragment under
// the floor. Returns [text] unchanged when nothing survives the floor, so a
// short element is never destroyed by a boundary inside it.
export function subdivideElement(text, opts = {}) {
  const floor = opts.minElementChars ?? SPLIT_DEFAULTS.minElementChars;
  const t = String(text || '').trim();
  if (!t) return [];
  const cuts = [];
  // `opts.boundaryRe` lets a caller measure a CANDIDATE boundary set against the attorney-structure
  // fixture (test/fixtures/litigated-claim1-structure.jsonl) without changing the default -- the
  // stage-B calibration runs that way. A fresh RegExp is built so a caller's regex never carries
  // lastIndex state between calls.
  const re = opts.boundaryRe ? new RegExp(opts.boundaryRe.source, 'gi') : BOUNDARY_RE;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (m.index > 0) cuts.push(m.index);
    if (re.lastIndex === m.index) re.lastIndex++;   // zero-width guard
  }
  if (!cuts.length) return [t];
  const parts = [];
  let prev = 0;
  for (const c of [...cuts, t.length]) {
    const seg = t.slice(prev, c).trim().replace(/^[,;\s]+/, '').trim();
    if (seg) parts.push(seg);
    prev = c;
  }
  // Merge sub-floor fragments into a neighbour rather than emitting them.
  const merged = [];
  for (const p of parts) {
    if (merged.length && (p.length < floor || merged[merged.length - 1].length < floor)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${p}`;
    } else merged.push(p);
  }
  return merged.length ? merged : [t];
}

// Split a claim into elements.
//
// STAGE A picks the coarse structure the claim itself declares:
//   1. lettered/roman sub-elements "(a)"/"(i)" when present — these also
//      re-join wrapped continuation lines, which the line path could not: the
//      TLS demo claim is typeset with hanging indents, and splitting it by
//      physical line cut limitations mid-sentence.
//   2. otherwise LINE structure — patent claims are conventionally typeset one
//      limitation per line. The '101 claim is 6 lines, 1 semicolon, and its
//      first ':' is a trailing "wherein:", so colon-then-semicolon yielded 2
//      elements for a 6-element claim.
//   3. otherwise preamble-colon then semicolons.
//
// STAGE B subdivides each coarse element on claim constructions (`wherein`,
// `, and`, `which is`, `for <gerund>-ing`), floored and capped. Practitioners
// chart '101 claim 1 at ~12 limitations where stage A alone yields 6; no regex
// reaches practitioner judgement, which is what `--elements @file` is for.
// WHAT A ROW MEANS ONCE IT IS CUT.
//
// The splitter above implements Andrew's Part III rules for CUTTING a claim
// into rows. Those rules also say what a row MEANS, and that changes what a
// verdict is worth. Two constructions matter enough to detect:
//
//   CHOICE   "at least one of A or B" is satisfied by finding EITHER. Charted
//            as one row and judged without saying so, an ABSENT may be
//            reporting "I did not find both" when the claim asks for either.
//            Measured: 782 of 5,397 real independent claims (14.5%).
//
//   NEGATIVE "without X", "in the absence of X" is satisfied when X is NOT
//            there. This is the dangerous one: the element's whole vocabulary
//            is the forbidden feature, so a model shown code that does X sees
//            every word present and answers PRESENT. Andrew's ruling: if the
//            limitation calls for X to be absent and X is present, the
//            limitation is NOT met. Measured: 228 of 5,397 (4.2%).
//
// Detection is regex and deterministic. It does not change the cut and it does
// not ask a model to construe a claim — it annotates the row so the analysis
// knows which question it is answering.
//
// `without` carries this on its own (223 of the 228). Checked against the
// corpus rather than assumed: the phrases following it are "without active
// intervention", "without using an X", "without user intervention", "without
// joining the ...". Claim text, not specification boilerplate — no "without
// limitation" or "without departing from" in the frequency table at all.
export function classifyLimitation(text) {
  const t = String(text || '');
  const cues = {};
  // `selected from the group consisting of` is a CHOICE, not closed claiming.
  // The two share the word `consisting` and mean opposite things, which is
  // exactly the confusion worth pinning in a test.
  const choice = t.match(/\bat\s+least\s+one\s+of\b|\bselected\s+from\s+the\s+group\s+consisting\s+of\b/i);
  if (choice) cues.choice = choice[0];
  const negative = t.match(/\bwithout\b|\bin\s+the\s+absence\s+of\b|\bsubstantially\s+free\s+(?:of|from)\b|\bfree\s+(?:of|from)\b|\bdevoid\s+of\b/i);
  if (negative) cues.negative = negative[0];
  const kinds = Object.keys(cues);
  // claim-chart-element-classes (2026-08-28): the element's genericity rides
  // along for reports and sidecars. Deliberately NOT part of `kinds`, so
  // limitationTag -- which reaches the model's prompt -- never prints it: the
  // label is for the reader, and a model told a row is "generic" would judge
  // a different question.
  const g = claimGenericity(t);
  return { kinds, cues, genericity: g.kind, genericityScore: g.score };
}

// One short tag per element, or '' — the form the prompt and the chart row
// both use, so the reader sees the same annotation the model was given.
export function limitationTag(text) {
  const { kinds } = classifyLimitation(text);
  if (!kinds.length) return '';
  const parts = [];
  if (kinds.includes('choice')) parts.push('CHOICE — met if ANY ONE alternative is found');
  if (kinds.includes('negative')) parts.push('NEGATIVE — met when the recited feature is ABSENT from the code');
  return `[${parts.join('; ')}]`;
}

export function splitClaimElements(claimText, opts = {}) {
  const fine = opts.fine !== false;
  const cap = opts.maxElements ?? SPLIT_DEFAULTS.maxElements;
  const t = String(claimText || '').trim().replace(/^\s*\d+\s*\.\s*/, '');
  const rawLines = t.split(/\r?\n/);

  let coarse;
  if (rawLines.some((l) => SUBELEMENT_RE.test(l))) {
    // Marker-structured: a new element starts at each marker; everything else
    // is a continuation of the current one.
    const groups = [];
    for (const raw of rawLines) {
      const l = raw.trim();
      if (!l) continue;
      if (SUBELEMENT_RE.test(l) || !groups.length) groups.push(l);
      else groups[groups.length - 1] += ` ${l}`;
    }
    coarse = groups.map((g) => g.replace(/[;,]?\s*(?:and)?\s*$/, '').trim()).filter((g) => g.length > 15);
  } else {
    const lines = rawLines.map((l) => l.trim().replace(/[;,]?\s*(?:and)?\s*$/, '')).filter((l) => l.length > 15);
    if (lines.length >= 2) coarse = lines;
    else {
      // PREAMBLE-COLON path, and this is where the preamble used to be thrown
      // away. `t.slice(ci + 1)` kept only the body, so everything before the
      // first colon vanished.
      //
      // MEASURED against 5,382 real independent claims: the preamble was
      // discarded on 5,297 of 5,369 -- 98.7% -- and retained in element 1 on
      // ZERO. It was invisible because both CE test claims are hand-wrapped and
      // take the marker or line path above; real corpora deliver claims as ONE
      // LINE and land here.
      //
      // The consequence was worse than a missing row. US 8,752,101 claim 1 as
      // the file on disk gives 10 elements with the preamble first; the SAME
      // text joined to a single line -- a paste from a PDF, an email, a database
      // field -- gave 2 with no preamble. Whitespace decided how many
      // limitations existed, and nothing in the output said which happened.
      //
      // Andrew's ruling (#310): "Preamble must always be shown as first row."
      // His own stated algorithm is "mechanically adding a newline after each
      // semicolon AND AFTER THE COLON" -- CE performed only the semicolon half.
      const ci = t.indexOf(':');
      const preamble = ci >= 0 ? t.slice(0, ci + 1).trim() : '';
      const body = ci >= 0 ? t.slice(ci + 1) : t;
      coarse = body.split(';').map((e) => e.trim().replace(/[.\s]+$/, '')).filter(Boolean);
      // The preamble leads, and is NOT subdivided below: it is one row by
      // definition, and stage B's boundaries (`wherein`, `, and`, `for -ing`)
      // would happily cut "A method of establishing a secure connection ...
      // comprising:" into fragments.
      if (preamble.length > 15) coarse.unshift(preamble);
    }
  }
  if (!fine) return coarse;
  // NOTE: `repairStrayAndComma` is deliberately NOT applied here. It needs the
  // ORIGINAL element to know whether a `, and` boundary was introduced by a
  // rewrite or belongs to the claim, and this function has no original. Applying
  // it blind would merge limitations a claim deliberately separated. See its
  // doc comment.
  const finer = coarse.flatMap((e) => subdivideElement(e, opts));
  // Overflow returns the coarse split whole — see SPLIT_DEFAULTS.maxElements.
  return finer.length > cap ? coarse : finer;
}

/**
 * Repair an element that subdivides ONLY because of a stray ", and".
 *
 * Returns the element with the comma dropped when that is the sole cause of a
 * subdivision, and unchanged otherwise. Exported so `--synonymize` and any other
 * producer of rewritten claims can apply it, and so the condition is testable
 * without going through the whole splitter.
 *
 * The condition is the point: repairing unconditionally would merge limitations
 * a claim genuinely separated with ", and".
 */
/**
 * Is this row the claim's preamble?
 *
 * POSITIONAL, with a fails-safe guard — and it is worth being exact about which
 * half does the work. The rule is "row 1"; the article + transitional test is a
 * sanity check, NOT a discriminator.
 *
 * MEASURED (2026-08-16): asus-CC proposed the guard as though it identified
 * preambles. Run against every element of US 8,752,101 rather than just element
 * 2, it also matches element 6 -- "the distribution system, comprising a code
 * rate determining unit" -- which is a genuine limitation and arguably the heart
 * of the claim. Across the corpus it matches more than one element in 15.5% of
 * claims. So it cannot be used to FIND the preamble; it can only confirm that
 * row 1 looks like one.
 *
 * Fails safe: if either test misses, the row is not labelled. A missing label is
 * a cosmetic gap; a wrong one is a false statement about a claim.
 */
const PREAMBLE_OPEN = /^\s*(?:a|an|the)\b/i;
const PREAMBLE_TRANS = /\b(?:comprising|consisting of|including|having|characterized (?:in|by))\b/i;

// A SUPPLIED row keeps its claim-number prefix -- "1. A method ... comprising:"
// from an attorney element file or the litigated fixture -- where CE's own
// splitter has already stripped it. PREAMBLE_OPEN failed on the `1.`, so 0 of
// the 380 fixture element sets got a preamble row and every attorney-row chart
// of 2026-08-27 judged the preamble as a limitation (preamble-row-on-supplied-
// elements, 2026-08-28). The prefix is ignored for the test only; the row text
// is never rewritten.
const CLAIM_NUMBER_PREFIX = /^\s*\d+\s*[.)]\s*/;

export function isPreambleRow(text, index) {
  if (index !== 0) return false;
  const s = String(text || '').replace(CLAIM_NUMBER_PREFIX, '');
  return PREAMBLE_OPEN.test(s) && PREAMBLE_TRANS.test(s);
}

/**
 * Repair a REWRITTEN element that subdivides only because the rewrite
 * introduced a `, and` the ORIGINAL did not have.
 *
 * REQUIRES THE ORIGINAL, and that requirement is the whole design. The first
 * version took only the element, on the theory that "subdivides on `, and`
 * alone" was a narrow enough condition. It is not, and testing said so
 * immediately:
 *
 *   "initializing a first module ..., and loading a second module ..."
 *
 * is indistinguishable from Gemini's stray comma BY TEXT ALONE — both subdivide
 * on `, and` and nothing else. Repairing unconditionally would MERGE limitations
 * a claim deliberately separated, which is a worse error than the one being
 * fixed: `, and` is a genuine limitation boundary in real claims, and Part III
 * names it as "often a good place to divide".
 *
 * So the signal cannot come from the element. It comes from the PAIR — a rewrite
 * that subdivides where its source did not — and only a caller holding both can
 * ask. `splitClaimElements` therefore does NOT call this: it sees one claim and
 * has no original to compare against.
 *
 * MEASURED (2026-08-16), the case this exists for: Gemini rewrote element (a) as
 * "..., and incorporating ..." where the source reads "... version and loading
 * ..." — same word, no comma. The claim went 11 rows to 12, and the
 * synonymizer's re-split guard flagged the comparison unsafe.
 */
export function repairStrayAndComma(rewritten, original, opts = {}) {
  const s = String(rewritten || '');
  if (original == null) return s;                           // no pair, no signal
  if (!/,\s+and\s+\w/i.test(s)) return s;
  if (subdivideElement(s, opts).length < 2) return s;       // did not subdivide anyway
  // The source already split here, so the boundary is the claim's own.
  if (subdivideElement(String(original), opts).length >= 2) return s;
  const repaired = s.replace(/,(\s+and\s+)/gi, '$1');
  // Only accept if it actually stops the subdivision. If the element also splits
  // on `wherein` or another boundary, the comma was not the cause.
  return subdivideElement(repaired, opts).length < 2 ? repaired : s;
}

// `--elements @file.txt`: the element list as a reusable INPUT. Heuristic
// splitting cannot match a practitioner's construction of a claim, and the
// chart must not let a MODEL choose rows — engine comparability requires all
// engines produce the identical skeleton. A file gives both: practitioner
// granularity, and a skeleton fixed across engines because it came from disk.
// One limitation per line; '#' lines are comments and are returned separately
// so the provenance header can carry them.
export function parseElementsFile(text) {
  const elements = [];
  const comments = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) { comments.push(l.replace(/^#\s?/, '')); continue; }
    elements.push(l);
  }
  return { elements, comments };
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

Patent language and source code USUALLY differ, and the common mistake is \
assuming they match. Your job: predict the WORDS that would appear in the NAMES \
of classes, methods, and functions that implement this element in real working \
software.

So think about how such a system is actually built and what programmers call \
things. But do NOT discard a claim word that a programmer would plausibly also \
use — a claim reading "a message REDACTING unit" is implemented by a \
function called redactSensitiveField, and "redact" is the word that \
finds it. Translate the boilerplate, keep the concrete verbs and nouns.

Example of the transformation (illustrative only, unrelated domain):
  claim says "means for persisting the transaction record durably"
  ELEMENT 1: commit; flush; journal; write; persist; transaction; log
  (note: "persist" and "transaction" come straight from the claim and are kept;
   "means for" and "durably" are boilerplate and are dropped)

Rules:
- 4 to 10 words per element, lowercase, single words (no phrases).
- NO patent boilerplate (unit, means, method, device, system, module, element).
- BASE FORMS, not -ing forms. Identifiers say "determine", "store", "reproduce";
  they almost never say "determining", "storing", "reproducing".
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

// PER-ELEMENT RETRIEVAL — steps 1-2 of --claim-locate's discovery path, lifted
// out so --claim-chart uses the SAME retrieval instead of a fourth
// implementation of "find code for this text". The three that already exist
// have each diverged once.
//
// Why this shape matters, measured by scripts/claim-selftest.mjs: a whole-claim
// search scores a function against the WHOLE claim's terms and needs a quorum,
// so four of five ground-truth anchors were never candidates (2, 3, 5 and 5 of
// 11 terms against a quorum of 6). A 10-line function cannot hold six terms of
// a claim describing a system. Here each element carries its own predicted
// vocabulary, `searchSymbolsByWords` ranks by rarity, and there is NO QUORUM —
// it takes the top N per element — so nothing is excluded before ranking.
//
// Step 1 shows the model the CLAIM ONLY: no codebase name, no paths, no
// profile. Nothing it returns can be answered from memory of a repository,
// which is the property the whole air-gapped argument rests on.
// Step 2 involves no model at all — CE greps its own symbol table.
// DIRECTION: a limitation about SENDING should not be answered by a function
// named `receive`.
//
// Observed live 2026-08-16: element 10, "conveying application-layer information
// through a cryptographically protected communication path" — transmitting — had
// its vocabulary step predict `receive`, and retrieval faithfully returned
// `receiveSecureData`. The corpus held `sendSecureData`, `sendMessage` and
// `tls_send_encrypted`; none was retrieved for that element. Only the analysis
// step stopped it becoming a citation, which means it reaches the chart whenever
// analysis does not.
//
// Named in the rules independently of this observation
// (docs/claim-chart-rules-checklist.md B6, from Part IV): charts "often confuse
// client/send/write with server/receive/read". Recorded there as mechanically
// checkable and not yet checked.
//
// Deliberately small and explicit, not an ontology.
const DIRECTION_WORDS = {
  limitation: {
    outbound: ['transmit', 'transmitting', 'send', 'sending', 'convey', 'conveying',
      'write', 'writing', 'publish', 'emit', 'upload', 'push'],
    inbound: ['receive', 'receiving', 'read', 'reading', 'accept', 'accepting',
      'consume', 'download', 'fetch', 'pull', 'obtain'],
  },
  symbol: {
    outbound: ['send', 'transmit', 'write', 'publish', 'emit', 'upload', 'push', 'put', 'post'],
    inbound: ['receive', 'recv', 'read', 'accept', 'consume', 'download', 'fetch', 'pull', 'get', 'listen'],
  },
};

// One direction, or null. BOTH directions yields null, and so does neither:
// silence has to mean "no signal", never "checked and fine".
export function directionOf(text, kind = 'limitation') {
  const t = String(text || '').toLowerCase();
  const table = DIRECTION_WORDS[kind] || DIRECTION_WORDS.limitation;
  const has = (words) => words.some((w) => new RegExp(`\\b${w}`, 'i').test(t));
  const out = has(table.outbound);
  const inb = has(table.inbound);
  if (out === inb) return null;
  return out ? 'outbound' : 'inbound';
}

// A mismatch, or null. WARNS ONLY — nothing is filtered and nothing is
// re-ranked. A send/receive pair can legitimately be the right citation: a
// duplex channel, a function that does both, a limitation about the link rather
// than either end. Suppressing the candidate would be the worse error, and
// broadening term sets to "fix" retrieval has come out zero-sum four times on
// this project. The retrieved set is byte-identical with this change.
export function directionalMismatch(limitationText, symbolName) {
  const lim = directionOf(limitationText, 'limitation');
  if (!lim) return null;
  const sym = directionOf(symbolName, 'symbol');
  if (!sym || sym === lim) return null;
  return { limitation: lim, symbol: sym };
}

// OUTPUT BUDGET for the vocabulary step — the one model call that decides what
// per-element retrieval searches for.
//
// Was a bare 600 at the call site, never measured against a real response. That
// is ~55 tokens per element on an 11-element claim including the `ELEMENT n:`
// scaffolding, and it does not fail gracefully: the step fails CLOSED, so every
// downstream stage reports "no candidates" for a reason that has nothing to do
// with the codebase.
//
// MEASURED (asus-CC, #306 "Edit 7", --claim-chart on .demo_code_only):
//
//   at  600   0 bytes, twice, byte-identical
//             "The model produced no parseable code-word predictions."
//   at 3000   11 of 11 elements, 26 targets, depth 3 achieved
//
// Qwen produced NOTHING at 600 and a complete chart at 3000. Not a degraded
// result -- a zero-byte one, reproducibly.
//
// Raising it is close to free because maxTokens is a CEILING, not a target: a
// model that finishes its word lists in 400 tokens is unaffected, and the four
// engines that already worked at 600 keep emitting what they emitted.
//
// Not a flag. `--vocab-budget` defaulting to 600 would make the user
// responsible for discovering that their model emitted zero bytes because of an
// output ceiling -- the exact failure that cost two runs to diagnose. A ceiling
// that silently zeroes a capable model is not a knob, it is a defect.
export const VOCAB_MAX_OUTPUT_TOKENS = 3000;

// THE CONTENT ARM. `searchSymbolsByWords` matches SYMBOL NAMES ONLY; multisect
// searches CONTENT, and the chart's no-`--targets` path never looked there.
//
// MEASURED (asus-CC, #315 lever 2): Gemma's own already-predicted word
// `estimator` reaches `AdaptiveTrackSelection@330` at rank 1 of 104 through
// content search, and NOWHERE through name search. The model had already
// produced a word that finds the right file, and CE looked in the one place
// that word does not appear.
//
// AN ARM, NEVER A BLEND. asus-CC measured that merging word sets dilutes: the
// claim's own stems put the crux at #2 alone and at #23 blended into Gemma's
// words, because searchSymbolsByWords scores breadth and the rare decisive word
// gets averaged away — the fifth zero-sum confirmation on this project. So this
// runs as its own query producing its own ranked list, and the lists merge
// AFTER scoring. Same shape, and the same stated reason, as the TIGHT/BROAD
// merge in analyze.js: "an all-or-nothing fallback makes the two searches
// alternatives when they are complements."
//
// SOFT terms with a quorum of 1: the winning signal in the measurement was a
// SINGLE word, so requiring agreement across an element's words would discard
// exactly the case this exists to catch.
export function contentCandidatesForWords(index, words, opts = {}) {
  if (!index || typeof index.multisectSearch !== 'function' || !words || !words.length) return [];
  const limit = opts.limit ?? 10;
  // Terms are built by the CANONICAL parser, not constructed here.
  //
  // 2e867ec hand-rolled `{ term, negated, hard }` while multisectSearch reaches
  // for `regex.test(line)` and the contract is `{ display, regex, negated,
  // hard }` (multisect.js:44). The first line tested threw, the catch below
  // swallowed it, and the arm returned [] on EVERY call from the day it shipped
  // until asus-CC found it (#315). A second hand-rolled copy of a shape is what
  // drifts; there is now one builder.
  //
  // `?` marks each term SOFT — the arm gates on minTerms:1, not on every word
  // matching. parseElementWords has already reduced every word to [a-z0-9]{3,24},
  // so nothing here can collide with the `;` separator or the `?`/`!`/`NOT `
  // prefixes. This function is exported, though, so a caller could pass anything:
  // words that cannot round-trip are dropped and REPORTED, never quietly
  // searched for as something else.
  const safe = [];
  for (const w of words) {
    if (/^[a-z0-9]+$/i.test(String(w))) safe.push(String(w).toLowerCase());
  }
  if (safe.length !== words.length) {
    opts.onError?.(new Error(`${words.length - safe.length} term(s) dropped:`
      + ` not [a-z0-9] and cannot round-trip the multisect term syntax`));
  }
  if (!safe.length) return [];
  const terms = parseMultisectTerms(safe.map((w) => `?${w}`).join(';'));
  if (!terms || !terms.length) {
    opts.onError?.(new Error('multisect term parsing produced no terms'));
    return [];
  }
  let res;
  // opts.includePath (chart-within-file-drilldown): scope the search to the
  // named file(s) -- the drilldown arm re-runs this per element inside a
  // concentration file. Same parser, same gates; only the corpus shrinks.
  try { res = index.multisectSearch(terms, { minTerms: 1, showProgress: false, includePath: opts.includePath || null }); }
  catch (e) {
    // The POLICY stays — retrieval must not take the run down. The SILENCE does
    // not. A swallowed throw and an empty result set are different events, and
    // before this the code could not tell them apart, which is what made a
    // hard type error look like "searched, found nothing new" for two days.
    opts.onError?.(e);
    return [];
  }
  const fns = (res && res.function_matches) || [];
  // A FILE-SCOPE match is not a citable function. multisect reports matter
  // outside any function as `(global)`, and on the arm's first real output
  // those were 20-50% of what it returned, which corpus-scale measurement
  // CONFIRMED: 117 of 706 = 16.6% on the demo corpus and 16,147 of 130,647 =
  // 12.4% on ExoPlayer (asus-CC, #315).
  //
  // A "73%" figure briefly stood here and was WRONG -- it divided dropped
  // matches by the POST-LIMIT kept count rather than by raw output. asus-CC
  // caught their own arithmetic and corrected it; the note survives so a reader
  // who saw 3a23dda's version knows which number to trust — unseeable before now, because the
  // arm returned nothing at all. Dropped and COUNTED: a candidate list quietly
  // carrying uncitable entries overstates what the arm found, which is the
  // same class of overstatement that hid the arm's failure.
  //
  // Filtered BEFORE the limit, not after. The old order sliced first, so a
  // result set half full of file-scope matches yielded fewer real candidates
  // than the caller asked for and never said why.
  const named = [];
  let fileScope = 0;
  let pseudo = 0;
  let tests = 0;
  for (const m of fns) {
    const name = m.name || m.function || m.full_name || '';
    if (!name) continue;
    if (/^\(/.test(name)) { fileScope += 1; continue; }
    const filepath = m.filepath || m.file || '';
    // A binstrings `.op` dump is one pseudo-function holding every string in
    // the binary; it matches any word list and is not a citable function.
    // Held back unless the caller admits it (--include-op); counted either way.
    if (!opts.includeOp && isPseudoSource(filepath)) { pseudo += 1; continue; }
    // chart-retrieval-content-arm-and-budget: the SAME test gate the name arm
    // has always had. Without it, tests dominated the arm's top ranks (36 of
    // 60 candidates on the bridged '101 row 6), a unit test of the mechanism
    // was promoted over the mechanism, and the real code sat outside the cap.
    // Counted only while the candidate list is still filling: the arm sees
    // tens of thousands of raw matches on a big index, and "52,398 tests held
    // back" would describe the corpus, not the candidacy. What is counted is
    // the tests that stood between the caller and its limit.
    if (!opts.includeTests && isTestSymbol({ name, filepath })) { if (named.length < limit) tests += 1; continue; }
    named.push({ name, filepath });
  }
  if (fileScope) opts.onNote?.(`${fileScope} file-scope (non-function) match(es) dropped`);
  if (pseudo) opts.onPseudoSource?.(pseudo);
  if (tests) opts.onTestSymbol?.(tests);
  return named.slice(0, limit);
}

export async function retrievePerElement({ draft, elements, symbols, opts = {} }) {
  const sys = buildDiscoverPrompt();
  const user = `CLAIM ELEMENTS:\n` + elements.map((e, i) => `${i + 1}. ${e}`).join('\n');
  let raw;
  try { raw = await draft(sys, user, VOCAB_MAX_OUTPUT_TOKENS); }
  catch (e) { return { perElement: [], raw: null, error: `vocabulary step failed: ${e.message}` }; }
  // The vocabulary step is the NARROWEST point in the pipeline: it fails closed,
  // and everything downstream then reports "no candidates" for a reason that has
  // nothing to do with the codebase. So a response that was CUT OFF has to say
  // so — the detector has existed since 58a596d and this path never consulted
  // it, which is why the failure presented as "the model produced nothing
  // useful" rather than "the response hit its ceiling".
  const truncated = wasLastDraftTruncated();
  const wordSets = parseElementWords(raw || '');
  if (truncated) {
    process.stderr.write(`  ⚠ vocabulary response hit the ${VOCAB_MAX_OUTPUT_TOKENS}-token output`
      + ` budget and was CUT OFF — ${wordSets.length} of ${elements.length} element(s) parsed;`
      + ` the rest have no predicted words and will retrieve nothing\n`);
  }
  if (!wordSets.length) {
    return { perElement: [], raw, truncated,
      error: truncated
        ? `The vocabulary response was cut off at the ${VOCAB_MAX_OUTPUT_TOKENS}-token output budget before any element parsed.`
        : 'The model produced no parseable code-word predictions.' };
  }
  // dep-claims-broaden-parent: species vocabulary donated by MODIFICATION
  // dependents joins the narrowed element's search words -- BOTH arms, since
  // the merged list flows into searchSymbolsByWords and
  // contentCandidatesForWords alike. Model words keep precedence; donated
  // words are normalised to the charset the parser enforces. An element the
  // (possibly truncated) response never parsed still gets its species words
  // rather than retrieving nothing.
  if (opts.extraWords instanceof Map && opts.extraWords.size) {
    const norm = (w) => String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [el, add] of opts.extraWords) {
      const words = [...new Set((add.words || []).map(norm).filter((w) => w.length >= 3 && w.length <= 24))];
      if (!words.length) continue;
      const from = (add.from || []).map((f) => f.claim);
      const ws = wordSets.find((x) => x.element === el);
      if (ws) {
        const have = new Set(ws.words);
        const fresh = words.filter((w) => !have.has(w));
        if (!fresh.length) continue;
        ws.depWords = fresh;
        ws.depFrom = from;
        ws.words = [...ws.words, ...fresh];
      } else {
        wordSets.push({ element: el, words, depWords: words, depFrom: from });
      }
    }
    wordSets.sort((a, b) => a.element - b.element);
  }
  // PSEUDO-SOURCE GATE (op-pseudo-source-kind-gate). A binstrings `.op` dump
  // indexes as one `bin_<name>` pseudo-function holding every string in the
  // binary, so the name arm matches it on almost any word list and the content
  // arm ranks it like a function that mentions everything. Measured 2026-08-27
  // (#310): `.op` files were nominated as chart targets in six of six charts on
  // indexes holding binaries -- a fifth of the target budget spent asking the
  // model to judge string tables. Held back from BOTH arms by default, counted
  // so the chart can say so, admitted by --include-op. An explicit --targets
  // list never comes through here, so a user naming a `.op` file keeps it.
  const includeOp = !!opts.includeOp;
  const pool = includeOp ? symbols : symbols.filter((s) => !isPseudoSource(s.filepath));
  const heldBack = { symbols: symbols.length - pool.length, content: 0, contentTests: 0 };
  if (heldBack.symbols) {
    process.stderr.write(`  ${heldBack.symbols} pseudo-source (.op) symbol(s) held back from`
      + ` retrieval — --include-op to admit them\n`);
  }
  const perElement = [];
  for (const ws of wordSets) {
    const { element, words } = ws;
    const hits = searchSymbolsByWords(pool, words, {
      limit: opts.candidatesPerElement ?? LOCATE_DEFAULTS.candidatesPerElement,
      includeTests: !!opts.includeTests,
    });
    // Attach the direction verdict to each hit rather than recomputing it in
    // every consumer — the limitation text is here and nowhere downstream.
    const limText = elements[element - 1] || '';
    let mismatches = 0;
    for (const h of hits) {
      const mm = directionalMismatch(limText, h.sym?.name || '');
      if (mm) { h.directionalMismatch = mm; mismatches += 1; }
    }
    if (mismatches) {
      process.stderr.write(`    ⚠ element ${element}: ${mismatches} candidate(s) point the`
        + ` OPPOSITE direction to the limitation (${directionOf(limText)}) — not filtered,`
        + ` verify before citing\n`);
    }
    // Merge the content arm AFTER scoring, de-duplicated by symbol. Each
    // candidate records which arm found it: a symbol found only by content
    // search is a different kind of evidence from one whose NAME matches, and a
    // reader deciding whether to trust a citation should be able to see which.
    //
    // The name arm keeps precedence on ties — it is the narrower, higher
    // confidence read, same rule as TIGHT over BROAD in analyze.js.
    let contentAdded = 0;
    if (opts.index) {
      const key = (s) => `${String(s.filepath || '').split('!').pop()}@${s.name}`;
      const seen = new Set(hits.map((h) => key(h.sym)));
      for (const h of hits) h.arm = 'name';
      let armError = null;
      let armNote = null;
      for (const c of contentCandidatesForWords(opts.index, words,
        { limit: opts.contentPerElement ?? LOCATE_DEFAULTS.contentPerElement,
          includeOp,
          includeTests: !!opts.includeTests,
          onPseudoSource: (n) => { heldBack.content += n; },
          onTestSymbol: (n) => { heldBack.contentTests += n; },
          onError: (e) => { armError = e; },
          onNote: (n) => { armNote = n; } })) {
        if (seen.has(key(c))) {
          const prior = hits.find((h) => key(h.sym) === key(c));
          if (prior) prior.arm = 'both';       // corroborated by two searches
          continue;
        }
        seen.add(key(c));
        hits.push({ sym: c, matched: [], score: -Infinity, arm: 'content' });
        contentAdded += 1;
      }
      // RESERVE ONE SLOT for the content arm's best NEW candidate.
      //
      // Content hits carry -Infinity and the list is already sorted descending,
      // so every one of them sits behind every name-arm candidate and selection
      // -- which reads from the top -- could never reach one. Measured: target
      // lists with the arm on and off were BYTE-IDENTICAL on both corpora
      // (#315). The arm contributed candidates and changed nothing.
      //
      // WHY ONE, AND WHY THE FIRST. asus-CC judged the candidates directly:
      // rank 1 is good and the tail is noise. On the demo corpus content rank 1
      // for element 2 is `initialize_crypto_context` -- the implementer of the
      // element that recites "initializing a cryptographic context", absent
      // from the 26 targets, and reached today only by inference through two
      // wrappers. On ExoPlayer, content rank 1 for element 7 is
      // AdaptiveTrackSelection::updateSelectedTrack at name-arm rank >2000:
      // UNREACHABLE at any depth, because it contains none of the predicted
      // words and its BODY does the work. The name arm finds its callee and
      // structurally cannot find the caller.
      //
      // Below rank 1 it degrades fast -- NAL-unit tests, audio-sink tests, a
      // Builder::build. So `contentPerElement` is still fetched for the count
      // and the file-scope reporting, and exactly ONE is promoted.
      //
      // SPLICE, NOT SCORE. -Infinity stands for "no comparable score", and
      // multisect IDF and name-arm rarity measure different things. Converting
      // between them would be a guess; reserving a POSITION is a stated policy.
      // The top name candidate keeps rank 1 -- this goes immediately after it.
      let promoted = null;
      if (contentAdded > 0) {
        const at = hits.findIndex((h) => h.arm === 'content');
        if (at > 1) {
          promoted = hits.splice(at, 1)[0];
          hits.splice(Math.min(1, hits.length), 0, promoted);
        } else if (at >= 0) {
          promoted = hits[at];                 // already within reach
        }
      }
      // Reported UNCONDITIONALLY where the arm is enabled. Emitting only the
      // non-zero case is what hid the arm's total failure: an absent line meant
      // "found nothing new" and "never ran" alike, so three separate checks
      // read a dead arm as a healthy one. Three states, three distinct lines.
      if (armError) {
        process.stderr.write(`    ⚠ CONTENT search arm ERRORED and contributed nothing:`
          + ` ${armError.message}\n`);
      } else {
        process.stderr.write(`    +${contentAdded} candidate(s) from CONTENT search`
          + `${contentAdded ? ' (name search did not surface them)' : ' (searched, nothing new)'}`
          + `${promoted ? ` - 1 promoted to the reserved slot: ${promoted.sym?.name || '?'}`
            : ''}`
          + `${contentAdded > 1 ? ` (the other ${contentAdded - 1} rank below every`
            + ` name-arm candidate and cannot reach a target)` : ''}`
          + `${heldBack.contentTests ? ` (${heldBack.contentTests} test-file candidate(s) held back — --include-tests to admit)` : ''}`
          + `${armNote ? ` — ${armNote}` : ''}\n`);
      }
    }
    perElement.push({ element, text: limText.slice(0, 160), words, hits, mismatches, contentAdded,
      ...(ws.depWords && ws.depWords.length ? { depWords: ws.depWords, depFrom: ws.depFrom } : {}) });
    opts.onElement?.({ element, words, hits, mismatches });
  }
  return { perElement, raw, error: null, prompt: { sys, user }, heldBack };
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
  const lowered = symbols.map((s) => ({ s, low: s.name.toLowerCase() }));

  const freq = new Map(words.map((w) => [w, 0]));
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

Patent language and source code USUALLY differ, and the common mistake is \
assuming they match. So search for words a programmer would put in an \
identifier. But do NOT discard a claim word that a programmer would plausibly \
also use — a claim reading "a message REDACTING unit" is implemented by a \
function called redactSensitiveField, and "redact" is the word that \
finds it. Translate the boilerplate, keep the concrete verbs and nouns.

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
  // claim-chart-scattered-targets: the located set carries the same
  // connectivity disclosure the chart does.
  if (opts.connectivity) {
    const c = opts.connectivity;
    out.push(c.groups.length <= 1
      ? `  Selected symbols form one connected group (call paths within ${c.depth} hops, or same file).`
      : `  SCATTERED: ${c.targets} selected symbol(s) in ${c.groups.length} unconnected groups (no call path within ${c.depth} hops): `
        + c.groups.map((g) => g.join(', ')).join('  |  '));
    out.push('');
  }
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

// WHICH LIMITATION EACH TARGET ANSWERS — the one thing per-element retrieval
// knows that nothing else does, and the one thing `--targets-out` dropped.
//
// Stdout carried it during the run ("element 4: words [...] -> 8 candidate(s)")
// and the file did not, so a chart fed a locate file could not render the
// `Retrieval by element` table it renders when it retrieves for itself. Two
// paths, same underlying work, artifacts of different evidentiary quality — and
// that table is what distinguishes "CE examined this limitation and found
// nothing" from "CE had nothing to examine".
//
// Attribution is per-RETRIEVAL, not per-selection, which is why it exists even
// when selection was pooled: every element is searched with its own vocabulary
// regardless of how the selection call was batched.
export function attributeTargets(found, discovery) {
  const specOf = (r) => `${r.match.filepath.split('!').pop().split('/').pop()}@${r.match.name}`;
  const bySpec = new Map();
  for (const r of found) if (r.match) bySpec.set(specOf(r), r);

  const groups = [];
  const claimed = new Set();
  const sharedWith = new Map();
  for (const p of (discovery || [])) {
    const names = new Set((p.hits || []).map((h) => h.sym && `${String(h.sym.filepath || '').split('!').pop().split('/').pop()}@${h.sym.name}`).filter(Boolean));
    const mine = [];
    for (const [spec, r] of bySpec) {
      // A row that names its own element (per-element selection) wins outright;
      // otherwise the element whose retrieval surfaced the symbol claims it.
      const owns = r.element != null ? r.element === p.element : names.has(spec);
      if (!owns) continue;
      if (claimed.has(spec)) { (sharedWith.get(spec) || sharedWith.set(spec, []).get(spec)).push(p.element); continue; }
      claimed.add(spec);
      mine.push(spec);
    }
    groups.push({ element: p.element, text: String(p.text || ''), words: p.words || [],
      candidates: (p.hits || []).length, targets: mine });
  }
  // A target no element claims must still ship. Silently dropping one would
  // make the file disagree with the run that produced it.
  const orphans = [...bySpec.keys()].filter((s) => !claimed.has(s));
  return { groups, orphans, shared: sharedWith };
}

// The `--targets-out` body. Marker comments are BACKWARD COMPATIBLE by
// construction: parseTargets already treats every `#` line as provenance, so an
// older reader ingests these as prose rather than choking, and the checksum is
// computed over targets only.
export function buildTargetsFileBody({ provenance = [], found, discovery, mode = 'discovery', runs = 1 }) {
  const specs = targetSpecs(found);
  // spec -> how many runs proposed it, so the union can state its own firmness.
  const freq = new Map();
  for (const r of found || []) {
    if (r.runsFound == null || !r.match) continue;
    const k = `${r.match.filepath.split('!').pop().split('/').pop()}@${r.match.name}`;
    freq.set(k, Math.max(freq.get(k) || 0, r.runsFound));
  }
  // The frequency goes on its OWN line ABOVE the target, never as a trailing
  // `spec  # 3/3` comment. claim-chart's parseTargets treats only lines
  // STARTING with `#` as provenance, so a trailing comment would be read as
  // part of the symbol name and would change the Targets-checksum — the one
  // thing the file exists to make verifiable. Same shape as `# Element-shared:`.
  const emit = (out, s) => {
    if (runs > 1 && freq.has(s)) out.push(`# Runs-found: ${freq.get(s)}/${runs}`);
    out.push(s);
  };
  const out = provenance.map((l) => `# ${l}`);
  // Hunt mode has no per-element retrieval to attribute, so it keeps today's
  // format exactly rather than emitting empty markers that would read as
  // "examined, nothing found".
  if (mode !== 'discovery' || !discovery || !discovery.length) {
    out.push(`# Attribution: none — produced by ${mode} mode, which does not retrieve per element`);
    for (const s of specs) emit(out, s);
    out.push('');
    return out.join('\n');
  }
  const { groups, orphans, shared } = attributeTargets(found, discovery);
  out.push(`# Attribution: per-element retrieval, ${groups.length} element(s)`);
  for (const g of groups) {
    out.push('');
    out.push(`# Element ${g.element}: ${g.text.replace(/\s+/g, ' ').slice(0, 160)}`);
    out.push(`# Element-words: ${g.words.join(', ')}`);
    out.push(`# Element-candidates: ${g.candidates}`);
    for (const s of g.targets) {
      const also = shared.get(s);
      if (also && also.length) out.push(`# Element-shared: ${s} also retrieved for element(s) ${also.join(', ')}`);
      emit(out, s);
    }
  }
  if (orphans.length) {
    out.push('');
    out.push(`# Element: unattributed — ${orphans.length} target(s) no element's retrieval claims`);
    for (const s of orphans) emit(out, s);
  }
  out.push('');
  return out.join('\n');
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
// What the list IS, in one line a reader can act on. Cloud engines sample and
// expose no seed; the local path decodes greedily at temperature 0. Neither
// statement promises repeatability — the first says it is one draw, the second
// says which decode mode produced it.
export function samplingLine(model, runs = 1) {
  // "Votes", not "union". Union names the mechanism; voting names what the
  // number MEANS to whoever reads the chart. (Andrew, 2026-08-23.)
  //
  // BUT THE VOTE COUNT DOES NOT MEAN THE SAME THING ON BOTH ENGINES, and
  // saying so is the whole point of this branch. Measured by asus-CC (#315,
  // CLAIM 2 / .demo_code_only / gemma-3-12b, union under the cap so nothing is
  // confounded):
  //
  //   THREE SEPARATE PROCESSES  ->  byte-identical target lists, 3 for 3
  //                                 (differing only in `# Command:`/`# Generated:`)
  //   THREE RUNS IN ONE PROCESS ->  4 of 23 targets non-unanimous
  //
  // Randomness gives three different answers; this gave TWO — run 1 matched a
  // fresh process exactly, runs 2 and 3 matched each other exactly. A step
  // function on first use is carried state, not sampling: all N runs share one
  // process, so run 1 is cold and the rest are warm. The entire difference was
  // one permutation of one element's word list, and order breaks ties
  // downstream.
  //
  // So on the local path a target the engine reproduces BYTE-FOR-BYTE can be
  // stamped `2/3`, and a reader following the documented meaning DISCOUNTS it.
  // That is worse than uninformative — it inverts — and it is printed into
  // charts. The label now says what it actually measured.
  const isLocal = !!(model && model.kind === 'gguf');
  const r = runs <= 1
    ? `Runs: ${runs}.`
    : isLocal
      ? `Runs: ${runs} — WITHIN-PROCESS stability, NOT run-to-run variation:`
        + ` all ${runs} runs share one process, so run 1 is cold and the rest are warm.`
        + ` "Runs-found: N/${runs}" counts warm-vs-cold agreement, not engine reliability.`
      : `Runs: ${runs} (each run votes; "Runs-found: N/${runs}" is a target's vote count).`;
  if (!model) return `unknown engine. ${r}`;
  if (isLocal) {
    // The good news, stated because it is a genuine checkable property that
    // nothing in CE's output claimed. Scoped to the measurement rather than
    // asserted as a law — one corpus, one model, three processes.
    return `local GGUF, temperature 0 (greedy decoding, no RNG) — REPRODUCIBLE`
      + ` ACROSS PROCESSES ON WHAT HAS BEEN MEASURED: identical target lists were`
      + ` observed across 3 separate processes on .demo_code_only with gemma-3-12b`
      + ` (#315). An OBSERVATION, not a guarantee - GPU kernel float`
      + ` non-associativity remains unmeasured on other models and hardware. ${r}`;
  }
  return `cloud engine, no seed control — this list is ONE SAMPLE and an`
    + ` identical command may produce a different one. ${r}`;
}

// Mode flags print from the PARSED ARGS, not from a re-render of argv, so a
// truncated or reconstructed command line cannot misreport the mode that ran.
export function buildTargetsProvenance({
  ceVersion, engine, blind, hunt, mode, indexPath, indexFiles, indexSymbols,
  claimSource, claimChars, elements, argv, generatedAt, targets,
  perElementSelect, selectionCalls, sampling,
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
  // SAY WHAT THIS LIST IS. Measured 2026-08-12 on .demo x sample_patent_claim:
  // identical --per-element-select invocations lost element group (e) in 3 of 7
  // runs, mean pairwise difference 5.9 targets (worst 11), stable core 72%. A
  // chart built from a losing run reports (e) ABSENT; from a winning run,
  // PRESENT. The verdict on a limitation flips between identical commands.
  //
  // Nothing on the artifact disclosed it. The Targets-checksum guards against
  // the list being EDITED, not against its GENERATION being unstable, so both
  // runs pass their own integrity check while disagreeing with each other.
  //
  // The claim made here is exactly the claim measured: the local line states
  // the DECODE MODE that was used, never that output is identical — greedy
  // decoding uses no RNG, but floating-point non-associativity in GPU kernels
  // is not something a flag fixes, and whether it bites has not been measured.
  // (`--reproducible` is parsed by the GUI server and reaches no CLI command;
  // a provenance line naming a seed would vouch for a pin that never happened.)
  if (sampling) lines.push(`Sampling: ${sampling}`);
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
    // `#` lines are PROVENANCE, not limitations — see the note at the same read
    // in claim-chart.js. Included here because --claim-locate writes the targets
    // file --claim-chart consumes, so a polluted locate run poisons the chart
    // downstream even when the chart itself reads a clean claim.
    try {
      claimText = readClaimFile(spec.slice(1), {
        onComments: (n, f) => process.stderr.write(
          `  Claim file ${f}: ignored ${n} '#' comment line(s) (provenance, not claim text).\n`),
      });
    } catch (e) { console.error(`Cannot read claim file: ${e.message}`); process.exitCode = 1; return; }
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
  const elements = splitClaimElements(claimText, { fine: args.granularity !== 'coarse' });
  const blind = !!args.blind;

  const hunting = !!args.hunt && args.no_hunt !== true;
  const perElementSelect = args.per_element_select === true;
  let selectionCalls = null;   // set by the discovery path; null on hunt/priors

  // --runs N repeats the discovery+selection cycle and UNIONS what it finds.
  // Refused rather than ignored on the paths that cannot honour it: an
  // accepted-but-inert flag is the exact defect the parent item found in
  // --reproducible, which the GUI server parses and no CLI command reads.
  const runs = args.runs == null ? 1 : Number(args.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error('--runs takes a whole number of runs, 1 or more.');
    process.exitCode = 1; return;
  }
  if (runs > 1 && (hunting || args.propose_from_priors)) {
    console.error(`--runs ${runs} applies to the discovery path only;`
      + ` ${hunting ? '--hunt' : '--propose-from-priors'} runs a different cycle and cannot union across runs.`);
    process.exitCode = 1; return;
  }
  // How many runs actually completed. Not the same as `runs` when a later run
  // fails, and the frequency denominator has to be the honest one.
  let runsCompleted = runs;
  // NOT a refusal - refusing would break the within-process measurement that
  // discovered this (#315). A warning, once, because on a local engine the
  // counts measure process warmup rather than sampling, and the engine is
  // cross-process deterministic anyway.
  if (runs > 1 && model && model.kind === 'gguf') {
    process.stderr.write(`  WARNING: --runs ${runs} on a LOCAL engine measures within-process`
      + ` stability, not run-to-run variation: all ${runs} runs share one process`
      + ` (run 1 cold, the rest warm). This engine reproduces byte-for-byte across`
      + ` processes, so a target stamped "Runs-found: ${runs - 1}/${runs}" may be`
      + ` perfectly stable - see #315.
`);
  }
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
    // Cost is LINEAR in --runs and is stated BEFORE spending: 3 runs of an
    // 11-element --per-element-select claim is 36 calls, not 12.
    const oneRun = [{ inChars: sys1.length + user1.length, outTokens: 400 }, ...selCost];
    const runCost = Array.from({ length: runs }, () => oneRun).flat();
    if (!claimsCostGate(model, runCost,
      `claim-locate discovery (${(1 + nSel) * runs} calls${runs > 1 ? ` across ${runs} runs` : ''})`, args)) return;
    resetCloudUsage();

    // UNION ACROSS RUNS, never intersection. Recall is what a single run loses:
    // identical --per-element-select invocations dropped one element group in 3
    // of 7 runs (scripts/claim-locate-stability.mjs). An intersection would
    // discard exactly those unstable targets — the marginal coverage — and
    // report a confidently wrong ABSENT. Frequency is recorded instead, so a
    // reader can see which citations are firm without CE dropping any.
    const byCandidate = new Map();   // candidate -> { element, candidate, runsFound }
    const byElement = new Map();     // element   -> unioned retrieval record
    let completed = 0;

    for (let run = 1; run <= runs; run++) {
      if (runs > 1) process.stderr.write(`\nRun ${run} of ${runs}:\n`);
      process.stderr.write('Step 1: predicting code vocabulary from the claim (no codebase shown)...\n');
      // Steps 1-2 now live in retrievePerElement so --claim-chart runs the same
      // retrieval; the onElement callback keeps this command's output identical.
      const disc = await retrievePerElement({
        draft, elements, symbols,
        opts: {
          includeTests: !!args.include_tests,
          onElement: ({ element, words, hits }) =>
            console.log(`  element ${element}: words [${words.join(', ')}] -> ${hits.length} candidate(s)`),
        },
      });
      if (disc.error) {
        // A failing FIRST run aborts exactly as before. A later run failing must
        // not destroy the runs that succeeded — it is reported and the
        // denominator shrinks to what actually ran.
        if (run === 1) {
          console.error(/^vocabulary/.test(disc.error) ? `--claim-locate: ${disc.error}` : disc.error);
          process.exitCode = 1;
          if (args.verbose && disc.raw) console.log(disc.raw);
          return;
        }
        process.stderr.write(`  run ${run} of ${runs}: retrieval failed — ${disc.error}\n`);
        continue;
      }
      const perElement = disc.perElement;
      // Attribution has to cover every target the union carries, so the
      // retrieval record is unioned too. Attributing against run 1 alone would
      // report a target found only in run 3 as unattributed.
      for (const pe of perElement) {
        const prior = byElement.get(pe.element);
        if (!prior) {
          byElement.set(pe.element, { ...pe, words: [...pe.words], hits: [...pe.hits] });
          continue;
        }
        for (const w of pe.words) if (!prior.words.includes(w)) prior.words.push(w);
        const seenHit = new Set(prior.hits.map((h) => `${h.sym?.filepath}@${h.sym?.name}`));
        for (const h of pe.hits) {
          const k = `${h.sym?.filepath}@${h.sym?.name}`;
          if (!seenHit.has(k)) { seenHit.add(k); prior.hits.push(h); }
        }
      }
      const withHits = perElement.filter((p) => p.hits.length);
      if (!withHits.length) {
        if (runs === 1) {
          console.log('\nNo symbol in this index matches any predicted code word.');
          return;
        }
        process.stderr.write(`  run ${run} of ${runs}: no symbol matched any predicted code word.\n`);
        completed++;
        continue;
      }

      // Step 3: the model chooses among symbols that DEMONSTRABLY EXIST.
      process.stderr.write(`Step 3: selecting implementers from real candidates`
        + `${perElementSelect ? `, one call per element (${withHits.length})` : ''}...\n`);
      selectionCalls = perElementSelect ? withHits.length : 1;
      let runProposals = [];
      if (!perElementSelect) {
        let rawSel;
        try { rawSel = await draft(buildSelectPrompt(withHits, { blind }), `PATENT CLAIM:\n${claimText}`, 700); }
        catch (e) {
          if (run === 1) { console.error(`--claim-locate: selection step failed: ${e.message}`); process.exitCode = 1; return; }
          process.stderr.write(`  run ${run} of ${runs}: selection failed — ${e.message}\n`);
          continue;
        }
        runProposals = parseProposedSymbols(rawSel || '').slice(0, LOCATE_DEFAULTS.maxProposals);
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
          runProposals.push(...picked);
        }
        if (failed) process.stderr.write(`  ${failed} of ${withHits.length} element selection(s) failed.\n`);
        runProposals = runProposals.slice(0, LOCATE_DEFAULTS.maxProposals);
      }
      completed++;
      for (const p of runProposals) {
        const prior = byCandidate.get(p.candidate);
        if (prior) { prior.runsFound++; continue; }
        byCandidate.set(p.candidate, { ...p, runsFound: 1 });
      }
      console.log();
    }

    discovery = [...byElement.values()].sort((a, b) => a.element - b.element);
    runsCompleted = completed;

    // QUORUM. The cap below is 24 and a single pooled run already yields ~22.6
    // targets on the '101 claim, so with more than one run the cap BINDS — it
    // is the expected case, not an overflow. Something must therefore be cut,
    // and run order is not a quality signal: cutting by insertion order
    // discarded whatever runs 2 and 3 found first, which is exactly the
    // marginal recall that running more than once exists to recover.
    //
    // Sorting by votes cuts the least-corroborated instead. That is defensible
    // — a target every run proposed is better evidence than one proposed once —
    // but it does mean that under a binding cap --runs CONFIRMS run 1 rather
    // than extending it. The disclosure below is what keeps that visible.
    //
    // Array.prototype.sort is stable, so equal vote counts keep their insertion
    // order. At --runs 1 every target has exactly one vote, so this is a no-op
    // and the single-run path stays byte-identical.
    const proposed = [...byCandidate.values()]
      .sort((a, b) => (b.runsFound || 1) - (a.runsFound || 1));
    proposals = proposed.slice(0, LOCATE_DEFAULTS.maxProposals);
    const cut = proposed.length - proposals.length;

    if (runs > 1) {
      if (completed !== runs) {
        process.stderr.write(`  ⚠ ${runs} run(s) requested, ${completed} completed —`
          + ` vote counts are out of ${completed}, not ${runs}\n`);
      }
      const unanimous = proposals.filter((p) => p.runsFound === completed).length;
      // A bound that does not say what it dropped reads as a finding when it is
      // a ceiling: a bare "24 proposals" cannot be told apart from "41 proposed,
      // 17 discarded". Same discipline as BUDGET-LIMITED and the content-arm
      // counts.
      console.log(`${completed} run(s): ${proposed.length} target(s) proposed,`
        + ` ${proposals.length} kept`
        + `${cut ? ` (${cut} CUT by the ${LOCATE_DEFAULTS.maxProposals}-target cap)` : ''},`
        + ` ${unanimous} proposed by every run.`);
      if (cut) {
        process.stderr.write(`  ⚠ ${cut} target(s) cut by the ${LOCATE_DEFAULTS.maxProposals}-target`
          + ` cap — the cut falls on the FEWEST votes first, so what was dropped is what`
          + ` fewest runs agreed on\n`);
      }
      console.log();
    }
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
        // How many runs proposed this candidate. Undefined on the hunt and
        // propose paths, which refuse --runs and so have nothing to report.
        runsFound: p.runsFound,
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
    // Runs is 1 because --runs is NOT implemented. Deliberately no flag: an
    // accepted-but-inert `--runs 3` would be the same defect this item found in
    // `--reproducible`, which the GUI server parses and no CLI command reads.
    sampling: samplingLine(model, runsCompleted),
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

  // claim-chart-scattered-targets: reported only, never changes selection.
  let locConnectivity = null;
  try {
    const locSpecs = targetSpecs(found);
    if (locSpecs.length >= 2) locConnectivity = targetConnectivity({ targets: locSpecs, neighbors: indexCallNeighbors(index) });
  } catch { locConnectivity = null; }
  for (const ln of formatLocateReport(rows, {
    targetsLine: true, hunt, unseen: huntUnseen, provenance, connectivity: locConnectivity,
  })) console.log(ln);

  // --targets-out closes the loop mechanically: the chart reads this file and
  // reports the provenance verbatim, with no hand-copying step in between —
  // and hand-copying is exactly where the risk of an edited-but-still-vouched
  // target list enters.
  if (args.targets_out && found.length) {
    const body = buildTargetsFileBody({
      provenance, found, discovery, mode: hunt ? 'hunt' : 'discovery', runs: runsCompleted,
    });
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

// ========================================================================
// claim-chart-scattered-targets: cited-target connectivity
// ========================================================================
//
// A chart whose PRESENT/PARTIAL verdicts sit on call-graph-disconnected
// targets shows CAPABILITIES, not the claimed combination -- the 9,152,713
// x .langchain reading (#310): an ASR wrapper and a web-research retriever,
// each verdict right about its target, nothing joining them, and nothing in
// the chart saying so. Deterministic connectivity over the cited targets,
// REPORTED and recorded, never used to change a verdict. Undirected BFS
// over callers+callees; same file counts as connected; bounds fixed here.
export const CONNECTIVITY_DEPTH = 3;
const CONNECTIVITY_FRONTIER_CAP = 40;   // neighbors kept per node per hop
const CONNECTIVITY_TOTAL_CAP = 400;     // visited nodes per cited target

export function targetConnectivity({ targets, neighbors, depth = CONNECTIVITY_DEPTH }) {
  const specs = [...new Set(targets || [])];
  if (specs.length < 2) return null;
  const fileKey = (spec) => String(spec).slice(0, Math.max(0, String(spec).indexOf('@'))).split('!').pop().split('/').pop().toLowerCase();
  const nodeKey = (spec) => {
    const at = String(spec).indexOf('@');
    const name = String(spec).slice(at + 1).replace(/@\d+$/, '');
    return `${fileKey(spec)}@${name.toLowerCase()}`;
  };
  const reach = (spec) => {
    const seen = new Set([nodeKey(spec)]);
    let frontier = [spec];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const s of frontier) {
        let n = 0;
        for (const nb of neighbors(s) || []) {
          if (n >= CONNECTIVITY_FRONTIER_CAP || seen.size >= CONNECTIVITY_TOTAL_CAP) break;
          const k = nodeKey(nb);
          if (seen.has(k)) continue;
          seen.add(k);
          next.push(nb);
          n++;
        }
      }
      frontier = next;
    }
    return seen;
  };
  const sets = specs.map((s) => reach(s));
  const parent = specs.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i, j) => { parent[find(j)] = find(i); };
  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      if (fileKey(specs[i]) === fileKey(specs[j])
        || sets[i].has(nodeKey(specs[j])) || sets[j].has(nodeKey(specs[i]))) union(i, j);
    }
  }
  const byRoot = new Map();
  specs.forEach((s, i) => { const r = find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(s); });
  const groups = [...byRoot.values()].sort((a, b) => b.length - a.length || String(a[0]).localeCompare(String(b[0])));
  return { targets: specs.length, depth, groups };
}

/** Call-graph neighbor function over a live index, for targetConnectivity. */
export function indexCallNeighbors(index) {
  return (spec) => {
    const at = String(spec).indexOf('@');
    const file = String(spec).slice(0, at);
    const bare = String(spec).slice(at + 1).replace(/@\d+$/, '').split('::').pop();
    const out = [];
    try {
      for (const c of index.findCallees(bare, file) || []) {
        if (c && c.name) out.push(`${String(c.filepath || file).split('!').pop()}@${c.name}`);
      }
    } catch { /* reported-only instrument: a resolution failure is silence, not a crash */ }
    try {
      for (const c of index.findCallers(bare, 50) || []) {
        const nm = c && (c.name || c.function);
        if (nm) out.push(`${String(c.filepath || c.file || '').split('!').pop()}@${nm}`);
      }
    } catch { /* ditto */ }
    return out;
  };
}

// ========================================================================
// chart-client-server-scope: two-sided claim detection
// ========================================================================
//
// A system claim can recite two communicating parties, and an index can be
// one of them ('101 x ExoPlayer: the reception device). Rows attributed to
// the other party come back ABSENT and a reader cannot tell "this codebase
// does not do it" from "this codebase is the other half of the system".
// Deterministic detection: the pair must be NAMED, attribution comes from
// the claim's own equipped-with/comprising constructions plus direct party
// mentions -- never inferred from vocabulary alone. `directional` says which
// party is the serving/transmitting side; the first/second pair has no
// inherent direction and gets the scope paragraph without row tags.
const CLAIM_SIDE_PAIRS = [
  { pair: ['transmission device', 'reception device'], directional: true },
  { pair: ['server', 'client'], directional: true },
  { pair: ['transmitter', 'receiver'], directional: true },
  { pair: ['sender', 'recipient'], directional: true },
  { pair: ['first device', 'second device'], directional: false },
];

export function detectClaimSides(claimText, elements) {
  const whole = String(claimText || '').toLowerCase();
  let found = null;
  for (const p of CLAIM_SIDE_PAIRS) {
    if (whole.includes(p.pair[0]) && whole.includes(p.pair[1])) { found = p; break; }
  }
  if (!found) return null;
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Units each party is "equipped with" / "comprising": the claim's own
  // attribution, harvested once from the whole text.
  const unitOf = new Map();
  for (const party of found.pair) {
    const re = new RegExp(esc(party)
      + String.raw`[^.;:]{0,80}?(?:equipped\s+with|comprising|including|includes|having)\s+(?:a|an|the)\s+([a-z][a-z\- ]{2,50}?unit)`, 'gi');
    let m;
    while ((m = re.exec(whole))) unitOf.set(m[1].trim(), party);
  }
  const markersFor = (party) => [party, ...[...unitOf].filter(([, p]) => p === party).map(([u]) => u)];
  const markers = { [found.pair[0]]: markersFor(found.pair[0]), [found.pair[1]]: markersFor(found.pair[1]) };
  // An element belongs to the party whose marker appears EARLIEST in it (the
  // acting subject leads); an element with no marker stays untagged.
  const perElement = (elements || []).map((e) => {
    const t = String(e).toLowerCase();
    let best = null;
    for (const party of found.pair) {
      for (const mk of markers[party]) {
        const at = t.indexOf(mk);
        if (at >= 0 && (!best || at < best.at)) best = { party, at };
      }
    }
    return best ? best.party : null;
  });
  if (!perElement.some(Boolean)) return null;
  return { parties: found.pair, directional: found.directional, perElement, units: Object.fromEntries(unitOf) };
}
