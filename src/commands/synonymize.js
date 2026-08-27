// synonymize.js — HOF-b. Rewrite a claim's WORDING away from a codebase's
// identifiers while preserving its MEANING and STRUCTURE.
//
// WHY THIS EXISTS
// Every ground-truth corpus we have is compromised. `ce_anchors.lst` is
// hand-written and small; `.demo` was authored alongside its own claim, so claim
// and code share vocabulary; US 8,752,101 is a real patent with no answer key.
// HOF-b manufactures the missing property — a corpus whose answers we know, and
// a claim that does NOT name the code.
//
// DIRECTION MATTERS, AND THE NAME IS AMBIGUOUS. There are two plausible
// "synonymizers" and they point opposite ways:
//
//   HARDER (this file)  claim wording AWAY from the codebase's identifiers,
//                       to MANUFACTURE a gap. Never sees the index.
//   EASIER (not built)  claim wording TOWARD them -- `change the code rate` ->
//                       `adaptive bitrate` -- to CLOSE a gap at retrieval time.
//                       Needs the index by definition.
//
// They share a mechanism (patent-register <-> programmer-register translation)
// which is exactly why they get conflated. They are separate commands on
// purpose: this one must never be able to read an index, and the other cannot
// work without one. See resources/worklist-drafts/hof-b-synonymizer.md.
//
// NO INDEX ACCESS. Deliberately not a convenience: withholding the code IS the
// mechanism by which the gap is manufactured. A command that CANNOT reach the
// index cannot leak it by accident, so this module imports nothing that reads
// one and `index.js` dispatches it before any index is constructed.
//
// MEASURED, and it shapes the prompt (asus-CC, #307, 2026-08-16): morphological
// variation is NOT sufficient to move retrieval. Expanding a six-word set to 24
// morphological variants left the target outside the top 25 and made the top-5
// worse. The gap that matters is between patent register and programmer
// register, not between word forms — so the prompt asks for a REGISTER change
// and explicitly forbids merely inflecting the same stems, which would produce
// a claim that reads differently without being any harder.
import fs from 'node:fs';
import { readCeVersion } from '../utils.js';
import { resolveModel, makeDrafter, claimsCostGate, actualCostLine, resetCloudUsage, describeEngine } from '../core/llm-runner.js';
import { splitClaimElements, parseElementsFile, repairStrayAndComma } from './claim-locate.js';

export const SYNONYMIZE_DEFAULTS = {
  // Output budget per element. Elements are one or two sentences; 400 leaves
  // room to rephrase without inviting the model to expand or explain.
  maxTokensPerElement: 400,
};

// The register the rewrite must move BETWEEN. Naming both ends in the prompt is
// what separates this from a thesaurus pass.
export function buildSynonymizePrompt() {
  return [
    'You rewrite one limitation of a patent claim.',
    '',
    'GOAL: express the SAME technical requirement in DIFFERENT WORDS, so that the',
    'wording no longer matches the vocabulary a programmer would have used when',
    'implementing it. You are testing a search tool: if your rewrite still shares',
    'the implementation\'s words, the test is worthless.',
    '',
    'PRESERVE, exactly:',
    '- the technical requirement, including every condition, quantity and relation',
    '- the scope. Do not broaden or narrow it. "at least one" stays "at least one".',
    '- patent-claim register. The output must still read as claim language, not as',
    '  a code comment, a summary, or an explanation.',
    '- negatives, alternatives and antecedents. "without X" must stay a prohibition;',
    '  "said gizmo" must still refer back to the gizmo already introduced.',
    '',
    'CHANGE:',
    '- the concrete nouns and verbs, to different words of equivalent meaning',
    '- prefer a more abstract or more formal synonym over the everyday word, since',
    '  the everyday word is the one the code is likely to use',
    '',
    'DO NOT:',
    '- merely inflect or re-form the same stem. "selector" -> "selection" is NOT a',
    '  rewrite; it is the same word and it has been measured not to change anything.',
    '- introduce implementation vocabulary, library names, or terms of art from the',
    '  relevant industry. Moving TOWARD the code is the opposite of the goal.',
    '- add, remove, explain, or comment. Output the limitation and nothing else.',
    '',
    'Output ONLY the rewritten limitation, as a single paragraph, with no preamble,',
    'no quotation marks, and no trailing notes.',
  ].join('\n');
}

// Strip the things models add despite being told not to. Kept narrow: this
// removes framing, never content.
export function cleanRewrite(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // Fenced block, whole-output only.
  const fence = s.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fence) s = fence[1].trim();
  // Leading label the instruction forbids but models emit anyway.
  s = s.replace(/^(?:rewritten|rewrite|output|limitation|element)\s*[:\-]\s*/i, '');
  // Wrapping quotes, only when they enclose the WHOLE string.
  const q = s.match(/^"([\s\S]+)"$/) || s.match(/^'([\s\S]+)'$/);
  if (q) s = q[1].trim();
  return s.replace(/\s+/g, ' ').trim();
}

// How much of the original vocabulary survived. This is the measure of whether
// the rewrite did anything, and it is deliberately computed on CONTENT words:
// claim boilerplate is shared by every claim and would swamp the signal.
const BOILERPLATE = new Set(`a an and are as at be being by comprising configured
consisting each for from further has have having in including into is it its least
method more not of on one or other plurality respectively said same set so such
system that the their then there thereby to upon use used using wherein whereby
which while with within without all also any apparatus device devices unit units
means step steps claim claims according present second first third
over through across between during after before under above along toward towards
against beyond about based responsive corresponding associated`.split(/\s+/));

export function contentWords(text) {
  return new Set((String(text).toLowerCase().match(/[a-z]{4,}/g) || [])
    .filter((w) => !BOILERPLATE.has(w)));
}

export function vocabularyOverlap(before, after) {
  const a = contentWords(before);
  const b = contentWords(after);
  if (!a.size) return { kept: 0, total: 0, pct: 0, survivors: [] };
  const survivors = [...a].filter((w) => b.has(w));
  return { kept: survivors.length, total: a.size, pct: 100 * survivors.length / a.size, survivors };
}

/**
 * Rewrite each element, in order, one model call apiece.
 *
 * PER-LIMITATION, NOT WHOLE-CLAIM, and the reason is a measurement one: this
 * command's own validation is a before/after retrieval comparison, and a rewrite
 * that also changed how the claim SPLITS would confound vocabulary change with
 * structure change — neither could then be attributed. Rewriting element by
 * element keeps the row skeleton identical by construction.
 *
 * A failed element keeps its ORIGINAL text rather than dropping out. A claim
 * missing a limitation is not a harder claim, it is a different and invalid one,
 * and silently shortening it would corrupt every downstream comparison.
 */
export async function synonymizeElements({ draft, elements, opts = {}, onElement } = {}) {
  const sys = buildSynonymizePrompt();
  const maxTok = opts.maxTokensPerElement ?? SYNONYMIZE_DEFAULTS.maxTokensPerElement;
  const out = [];
  for (let i = 0; i < elements.length; i++) {
    const original = String(elements[i]);
    // MARKERS ARE STRUCTURE, NOT WORDING — split them off and re-attach verbatim.
    //
    // MEASURED, first live run (Gemini 2.5 Flash, 2026-08-16): asked to rewrite
    // "(a) initializing a cryptographic context...", it returned prose that had
    // silently dropped the "(a)". Five of eleven elements lost their markers,
    // and because splitClaimElements takes the MARKER path whenever any marker
    // is present -- merging unmarked lines into the preceding group -- the
    // eleven-line output re-split to EIGHT. The skeleton this command exists to
    // preserve was destroyed by the rewrite itself.
    //
    // Instructing the model to keep the marker would be the weaker fix: it is
    // an instruction where a mechanism will do, and the marker carries no
    // vocabulary worth rewriting.
    const mk = original.match(/^\s*(\(\s*(?:[a-z]|[ivx]+|\d+)\s*\)\s*)/i);
    const marker = mk ? mk[1] : '';
    const bodyText = marker ? original.slice(mk[0].length) : original;
    let rewritten = '', error = null;
    try {
      rewritten = cleanRewrite(await draft(sys, `LIMITATION:\n${bodyText}`, maxTok));
      // Strip any marker the model reproduced anyway, so it cannot be doubled.
      rewritten = rewritten.replace(/^\s*\(\s*(?:[a-z]|[ivx]+|\d+)\s*\)\s*/i, '');
      if (rewritten) rewritten = marker + rewritten;
    } catch (e) {
      error = e.message;
    }
    // An empty or trivially-short answer is a failure, not a terse rewrite.
    if (!error && rewritten.length < Math.min(20, original.length * 0.4)) {
      error = `rewrite too short (${rewritten.length} chars for a ${original.length}-char limitation)`;
    }
    // THE THIRD STRUCTURAL FAILURE MODE, and the only one that cannot be fixed
    // by strip-before-and-restore-after: the rewrite ADDS a boundary rather than
    // dropping one.
    //
    // MEASURED on sample_patent_claim_synon_gemini_NEW.txt, generated AFTER the
    // marker and punctuation fixes: Gemini wrote element (a) with ", and
    // incorporating" where the source reads "... version and loading ..." --
    // same word, no comma. BOUNDARY_RE cuts at /,\s*and\s+/, so the claim went
    // from 11 rows to 12 and the re-split guard flagged the comparison unsafe.
    //
    // The repair needs THE PAIR, which is why it happens here and not in the
    // splitter: from element text alone a stray ", and" is indistinguishable
    // from a genuine one, and repairing blind would merge limitations a claim
    // deliberately separated. `original` is in hand at exactly this point and
    // nowhere else.
    let repaired = false;
    if (!error) {
      const fixed = repairStrayAndComma(rewritten, original, opts);
      if (fixed !== rewritten) { rewritten = fixed; repaired = true; }
    }
    // Overlap is scored on the BODY, not the marker: "(a)" is not vocabulary,
    // and counting it would flatter every rewrite by a constant.
    const kept = error ? { kept: 0, total: 0, pct: 100, survivors: [] }
                       : vocabularyOverlap(bodyText, rewritten);
    const row = { n: i + 1, original, rewritten: error ? original : rewritten, error, overlap: kept, repaired };
    out.push(row);
    onElement?.(row);
  }
  return out;
}

// TERMINAL PUNCTUATION IS STRUCTURE, AND CE STRIPS IT BEFORE THE MODEL RUNS.
//
// MEASURED (2026-08-16): all three synonymized claims came back with ZERO
// semicolons, where the original has six. The obvious reading -- "every engine
// dropped them" -- is WRONG, and worth recording because it was stated before it
// was checked. `splitClaimElements` ends each element with
// `.replace(/[;,]?\s*(?:and)?\s*$/, '')`, so a limitation reaches the model as
// `...credentials`, never `...credentials;`. The model cannot preserve what it
// was never shown.
//
// WHY IT MATTERS. A claim is one sentence; the line breaks are a display
// convention. With semicolons the claim survives being rewrapped -- the original
// gives 11 elements multi-line and 10 joined to a single line. Without them it
// collapses to 4. So a synonymized claim that loses its semicolons is fragile in
// exactly the way A3's rewrap defect describes: a paste from a PDF, an email
// body or a database field destroys it.
//
// So the job is to RESTORE, not to preserve. The raw claim still has the
// punctuation; recover it per line and re-attach on output.
// Recovered by LOCATING each element in the source, not by line position.
//
// A line-indexed version was written first and was wrong: real claim files are
// hard-wrapped mid-sentence. `sample_patent_claim.txt` is 28 physical lines, 22
// of them long enough to qualify, for 11 elements — so there is no 1:1 mapping
// to recover from. Whitespace-normalising both sides and finding the element in
// the source works regardless of wrapping, and returns '' for anything it cannot
// place rather than guessing.
export function terminatorsFor(rawClaimText, elements) {
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
  const hay = norm(String(rawClaimText || '').replace(/^\s*\d+\s*\.\s*/, ''));
  return elements.map((el) => {
    const needle = norm(el);
    if (!needle) return '';
    const at = hay.indexOf(needle);
    if (at < 0) return '';
    const after = hay.slice(at + needle.length);
    const m = after.match(/^\s*(and\s*[;,]|[;,:.])/i);
    if (!m) return '';
    // Normalise "and;" / ", and" to the form the claim actually used.
    return /and/i.test(m[1]) ? '; and' : m[1];
  });
}

// `#` COMMENT STRIPPING, DUPLICATED ON PURPOSE.
//
// The canonical implementation is `readClaimFile` in analyze.js, and every other
// claim-reading command imports it. This one cannot: analyze.js reaches the
// index, and the guarantee this module is built around is that it CANNOT. The
// import would be the leak, however carefully the binding were used.
//
// So the six lines are repeated, and the equivalence is CHECKED rather than
// asserted -- a test feeds the same inputs to both and requires identical
// output, so the copies cannot drift apart silently. When `readClaimFile` moves
// to `utils.js` (a known follow-up: it is a text helper with no business living
// in an index-reading module, and three commands already share it), this
// function is deleted and the import taken from there.
//
// A file with no comments is returned UNTOUCHED, which is not fussiness: the
// round trip through split/join normalises CRLF to LF, and the claim files on
// this project are Windows-authored.
export function stripClaimComments(raw, { onComments } = {}) {
  const lines = String(raw).split(/\r?\n/);
  const kept = lines.filter((l) => !/^\s*#/.test(l));
  const dropped = lines.length - kept.length;
  if (!dropped) return String(raw).trim();
  onComments?.(dropped);
  return kept.join('\n').trim();
}

// A claim is one sentence, so it survives being written as one line. Used for
// the pass-through of a claim that produced no elements to rewrite.
export function claimLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Written by --pseudo-claims --claims-only. Read from the RAW text, before the
// comment strip removes it -- a machine-readable format declaration is exactly
// the kind of thing that should not depend on a heuristic.
export const CLAIMS_PER_LINE_MARKER = /^#\s*Format:\s*one claim per line\b/im;

// STRUCTURAL, NOT LEXICAL. A line is a whole claim if it carries a preamble
// transition followed by the colon that opens the body -- the shape every claim
// in this project's corpora has, and the shape splitClaimElements already keys
// off. Deliberately NOT a length or word-count test: a long hard-wrapped line
// from a single claim would pass that and a short claim would fail it.
export function looksLikeWholeClaim(line) {
  const s = String(line || '').trim();
  if (s.length < 40) return false;
  return /\b(?:comprising|consisting of|including|having|characterized (?:in|by))\b[^.;]*:/i.test(s);
}

// ONE CLAIM PER LINE, OR ONE CLAIM. Getting this wrong in either direction is
// expensive, so the rule is conservative and the verdict is always announced.
//
// Auto-detection requires that EVERY non-empty line be a whole claim, and that
// there be at least two of them. Requiring every line is what makes a
// hard-wrapped single claim safe: its continuation lines ("wherein the second
// module ...") carry no preamble transition, so one failing line collapses the
// whole file back to single-claim reading. The cost of the strict rule is a
// hand-made corpus that needs --claims-per-line; the cost of a loose one is a
// claim silently torn into fragments and billed as separate claims.
export function detectClaims(rawText, { force = null } = {}) {
  const stripped = stripClaimComments(rawText);
  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (force === 'single') return { claims: [stripped], mode: 'forced-single' };
  if (force === 'multi') return { claims: lines, mode: 'forced-multi' };
  if (CLAIMS_PER_LINE_MARKER.test(String(rawText))) return { claims: lines, mode: 'marker' };
  if (lines.length >= 2 && lines.every(looksLikeWholeClaim)) {
    return { claims: lines, mode: 'structural' };
  }
  return { claims: [stripped], mode: 'single' };
}

// THE ARGUMENT THAT COST A RUN. `--synonymize ios81_pseudo.txt` -- no '@' --
// took the literal string "ios81_pseudo.txt" as the claim and dutifully
// synonymized a filename. --claim-analyze has guarded this for as long as it has
// accepted claim text; this command never did.
//
// Same rule as analyze.js:1495 (inline text must contain a space and exceed 30
// chars), but the failure is LOUD instead of silent, and names the likely cause:
// a wasted run that produces a plausible-looking artifact is worse than an error.
export function claimArgProblem(spec) {
  const s = String(spec || '');
  if (s.startsWith('@')) return null;
  if (s.includes(' ') && s.length > 30) return null;
  const looksLikePath = /[\\/]/.test(s) || /\.[a-z0-9]{1,5}$/i.test(s);
  return looksLikePath
    ? `--synonymize: '${s}' looks like a file, not claim text. Did you mean '@${s}'?`
    : `--synonymize: '${s}' is too short to be a claim. Use '@<file>' to read a claim `
      + `from a file, or pass the claim text itself.`;
}

// THE HUMAN ARTIFACT, POINTED AT THE WRONG COMMAND.
//
// detectClaims refuses to mis-split `--pseudo-claims` output into a corpus,
// which is right -- but the fallback is single-claim reading, and a single
// "claim" spanning the whole artifact still splits into 144 elements and still
// bills 144 model calls. Declining to read it the wrong way is not the same as
// declining to read it.
//
// MEASURED on the real ios81_pseudo.txt: 171 elements raw, 144 after the `#`
// strip. So the comment fix alone takes a third off a bill that should be zero.
//
// Detected from the artifact's own structure -- its caveat heading and its
// per-claim `## Pseudo-claim N` headings -- not from the filename, which says
// nothing. The message names --claims-only because the user's intent was never
// in doubt; only the path was.
export function artifactProblem(rawText) {
  const s = String(rawText || '');
  // A FILE THAT DECLARES A MACHINE FORMAT IS A MACHINE FILE, and the check stops
  // there. Caught by its own test: --claims-only writes "# Pseudo-claims —
  // illustrative drafting exercise..." as its first line, which is close enough
  // to the artifact's caveat to trip the heuristic below. An explicit
  // declaration must always beat a shape guess -- the same reason detectClaims
  // reads the marker before it looks at structure.
  if (CLAIMS_PER_LINE_MARKER.test(s)) return null;
  const headings = (s.match(/^##\s+Pseudo-claim\s+\d+/gim) || []).length;
  const caveat = /^#\s*PSEUDO-CLAIMS\b/im.test(s);
  if (!caveat && headings < 2) return null;
  return `--synonymize: this looks like a --pseudo-claims ARTIFACT`
    + `${headings ? ` (${headings} \`## Pseudo-claim\` heading(s))` : ''}, not claim text.`
    + ` It carries caveat prose, a contents list and anchor tables, all of which would be`
    + ` rewritten as limitations at one model call each.\n`
    + `  Re-run --pseudo-claims with --claims-only <file> to write the claims alone,`
    + ` then synonymize that file.`;
}

// `#` provenance, matching --targets-out. HOF depends on knowing WHICH model did
// the rewriting, since the premise of HOF-b is that it is a different model from
// the one being tested.
export function buildSynonymizeProvenance({ engineLabel, claimSource, elements, failed, meanOverlap, argv, ceVersion, generatedAt, reSplit, repairs = 0, perClaim = null }) {
  const skeleton = reSplit == null ? null
    : reSplit === elements ? `${reSplit} — preserved`
    : `${reSplit} — CHANGED, comparison unsafe`;
  // CORPUS FORM. A run over 13 claims that reports one aggregate re-split number
  // has thrown away the only thing worth knowing when it goes wrong: WHICH claim
  // broke. The guard that caught Gemini's marker loss is useless at scale if it
  // cannot name the row.
  if (perClaim) {
    const broke = perClaim.filter((c) => c.reSplit !== c.elements);
    const claimFails = perClaim.filter((c) => c.failed).length;
    return [
      `# Synonymized claims — HOF-b. Wording changed, requirement preserved.`,
      `# NOT patent claims. Generated for retrieval testing; do not file, quote, or rely on.`,
      // Read back by detectClaims, so this file round-trips without a flag.
      `# Format:     one claim per line`,
      `# Engine:     ${engineLabel}`,
      `# Source:     ${claimSource || '(inline)'}`,
      `# Claims:     ${perClaim.length}${claimFails ? ` (${claimFails} with at least one failed element)` : ''}`,
      `# Elements:   ${elements} total${failed ? ` (${failed} kept original — rewrite failed)` : ''}`,
      `# Vocabulary: ${meanOverlap.toFixed(1)}% mean per-element content-word survival (lower = harder)`,
      broke.length
        ? `# Re-split:   ${perClaim.length - broke.length} of ${perClaim.length} preserved — CHANGED on `
          + `${broke.map((c) => `claim ${c.n} (${c.elements} → ${c.reSplit})`).join(', ')}; `
          + `comparison unsafe for those`
        : `# Re-split:   all ${perClaim.length} preserved`,
      ...(repairs ? [`# Repaired:   ${repairs} element(s) — stray ", and" introduced by the rewrite`] : []),
      `# CE:         ${ceVersion}`,
      `# Generated:  ${generatedAt}`,
      `# Command:    ${argv}`,
    ].join('\n');
  }
  return [
    `# Synonymized claim — HOF-b. Wording changed, requirement preserved.`,
    `# NOT a patent claim. Generated for retrieval testing; do not file, quote, or rely on.`,
    `# Engine:     ${engineLabel}`,
    `# Source:     ${claimSource || '(inline)'}`,
    `# Elements:   ${elements}${failed ? ` (${failed} kept original — rewrite failed)` : ''}`,
    // Named as a MEAN OVER ELEMENTS: it is not the whole-claim figure, and the
    // two differ enough to mislead. Scoring the claim as one blob counts a word
    // as surviving if it survived ANYWHERE, which is the more forgiving reading.
    `# Vocabulary: ${meanOverlap.toFixed(1)}% mean per-element content-word survival (lower = harder)`,
    ...(skeleton ? [`# Re-split:   ${skeleton}`] : []),
    // Only when non-zero: a line saying "0 repaired" on every run trains the
    // reader to skip it, and this one has to be noticed when it appears.
    ...(repairs ? [`# Repaired:   ${repairs} element(s) — stray ", and" introduced by the rewrite`] : []),
    `# CE:         ${ceVersion}`,
    `# Generated:  ${generatedAt}`,
    `# Command:    ${argv}`,
  ].join('\n');
}

export async function doSynonymize(args, opts = {}) {
  const spec = String(args.synonymize || '');

  // Rejected BEFORE anything is read or any model is resolved: the whole point
  // is to fail before spending, since the failure this guards produced a
  // plausible-looking artifact after a full run.
  const argProblem = claimArgProblem(spec);
  if (argProblem) { console.error(argProblem); process.exitCode = 1; return; }

  let rawText = spec, claimSource = null;
  if (spec.startsWith('@')) {
    claimSource = spec.slice(1);
    try { rawText = fs.readFileSync(claimSource, 'utf8'); }
    catch (e) { console.error(`Cannot read claim file: ${e.message}`); process.exitCode = 1; return; }
  }
  if (!rawText.trim()) { console.error('--synonymize: no claim text.'); process.exitCode = 1; return; }

  // Also before spending. --single-claim is the deliberate override for someone
  // who really does mean to rewrite an artifact wholesale.
  const artifact = args.single_claim ? null : artifactProblem(rawText);
  if (artifact) { console.error(artifact); process.exitCode = 1; return; }

  if (args.claims_per_line && args.single_claim) {
    console.error('--synonymize: --claims-per-line and --single-claim contradict each other.');
    process.exitCode = 1; return;
  }
  const { claims: claimTexts, mode } = detectClaims(rawText, {
    force: args.claims_per_line ? 'multi' : args.single_claim ? 'single' : null,
  });
  const isCorpus = claimTexts.length > 1 || mode === 'forced-multi' || mode === 'marker';
  if (!claimTexts.length || !claimTexts.some((c) => c.trim())) {
    console.error('--synonymize: no claim text.'); process.exitCode = 1; return;
  }

  // ANNOUNCED, ALWAYS. Reading a corpus as one claim, or one claim as a corpus,
  // changes the number of model calls and the shape of the output; the user
  // should never have to infer which reading happened from the bill.
  if (isCorpus) {
    process.stderr.write(`[synonymize] reading ${claimTexts.length} claim(s), one per line`
      + ` (${mode === 'marker' ? 'format marker' : mode === 'forced-multi' ? '--claims-per-line' : 'structure'})\n`);
  }

  // --elements @file supplies ONE construction, so it cannot describe a corpus.
  // Silently applying one claim's elements to thirteen would be a fabrication.
  if (args.elements && isCorpus) {
    console.error('--synonymize: --elements supplies the construction of ONE claim and cannot be'
      + ` applied to ${claimTexts.length}. Synonymize that claim on its own, or drop --elements.`);
    process.exitCode = 1; return;
  }

  // --elements @file wins over the heuristic split, same contract as --claim-chart:
  // a practitioner's construction of the claim beats any regex.
  let suppliedElements = null, elementsSource = null;
  if (args.elements) {
    const espec = String(args.elements);
    const epath = espec.startsWith('@') ? espec.slice(1) : espec;
    let eraw;
    try { eraw = fs.readFileSync(epath, 'utf8'); }
    catch (e) { console.error(`Cannot read elements file: ${e.message}`); process.exitCode = 1; return; }
    ({ elements: suppliedElements } = parseElementsFile(eraw));
    if (!suppliedElements.length) { console.error(`--elements: ${epath} has no element lines.`); process.exitCode = 1; return; }
    elementsSource = `\`${epath}\` — ${suppliedElements.length} supplied verbatim`;
  }

  // Split every claim UP FRONT, so the cost gate sees the true total. A gate
  // that fires per claim asks thirteen times and tells the user nothing about
  // what the whole run costs.
  const perClaim = claimTexts.map((text, i) => {
    const elements = suppliedElements || splitClaimElements(text, { fine: args.granularity !== 'coarse' });
    return { n: i + 1, text, elements };
  });
  const emptyClaims = perClaim.filter((c) => !c.elements.length);
  if (emptyClaims.length === perClaim.length) {
    console.error('--synonymize: the claim produced no elements.'); process.exitCode = 1; return;
  }
  if (emptyClaims.length) {
    // Named, not dropped silently: a claim that produced no elements is a
    // finding about the input, and the output must stay positionally aligned
    // with it (HOF scores claim i against key i).
    process.stderr.write(`[synonymize] WARNING: ${emptyClaims.length} claim(s) produced no elements`
      + ` and are passed through unchanged: ${emptyClaims.map((c) => c.n).join(', ')}\n`);
  }
  if (!suppliedElements) {
    const total = perClaim.reduce((n, c) => n + c.elements.length, 0);
    elementsSource = `${total} from CE's split`;
  }

  const model = resolveModel(args);
  if (!model) { console.error('--synonymize needs a model: --llm <provider> or --model <gguf>.'); process.exitCode = 1; return; }
  if (model.kind === 'error') { console.error(`Error: ${model.error}`); process.exitCode = 1; return; }
  let draft;
  try { draft = opts.draft || makeDrafter(model, args.temperature ?? 0); }
  catch (e) { console.error(`--synonymize: ${e.message}`); process.exitCode = 1; return; }

  const engineLabel = describeEngine(model);
  const totalElements = perClaim.reduce((n, c) => n + c.elements.length, 0);
  process.stderr.write(`[synonymize] ${totalElements} element(s)`
    + `${isCorpus ? ` across ${perClaim.length} claim(s)` : ''}, engine ${engineLabel}\n`);
  process.stderr.write('[synonymize] the model is shown the CLAIM ONLY — no index, no code, no paths\n');

  // One call per element ACROSS ALL CLAIMS, gated once before spending. This is
  // the number that would have said "171 calls" out loud on the run that
  // synonymized a legal disclaimer element by element.
  const calls = perClaim.flatMap((c) => c.elements.map((e) => ({
    inChars: String(e).length + 1500, outTokens: SYNONYMIZE_DEFAULTS.maxTokensPerElement,
  })));
  if (!claimsCostGate(model, calls, `synonymize (${calls.length} calls`
    + `${isCorpus ? `, ${perClaim.length} claims` : ''})`, args)) return;
  resetCloudUsage();

  for (const c of perClaim) {
    if (isCorpus) {
      process.stderr.write(`[synonymize] claim ${c.n}/${perClaim.length}`
        + ` — ${c.elements.length} element(s)\n`);
    }
    c.rows = await synonymizeElements({
      draft, elements: c.elements, opts: args,
      onElement: (r) => process.stderr.write(
        r.error ? `  ${isCorpus ? `${c.n}.` : ''}${r.n}: FAILED (${r.error}) — keeping original\n`
                : `  ${isCorpus ? `${c.n}.` : ''}${r.n}: ${r.overlap.pct.toFixed(0)}% of content words survive`
                  + `${r.overlap.survivors.length ? ` [${r.overlap.survivors.slice(0, 6).join(', ')}]` : ''}`
                  + `${r.repaired ? ' — stray ", and" repaired' : ''}\n`),
    });
  }

  const allRows = perClaim.flatMap((c) => c.rows);
  const failed = allRows.filter((r) => r.error).length;
  const scored = allRows.filter((r) => !r.error);
  const meanOverlap = scored.length
    ? scored.reduce((n, r) => n + r.overlap.pct, 0) / scored.length : 100;

  // Restore the terminal punctuation the splitter removed, so the output claim
  // survives being rewrapped the way the original does. See terminatorsFor.
  // A CLAIM IS ONE SENTENCE, so a period anywhere but the end is wrong, and a
  // rewrite that supplies one must not be deferred to.
  //
  // MEASURED (Gemini, 2026-08-16, after the marker fix): the model ended several
  // limitations with '.' where the source had ';'. The first version of this
  // loop skipped any rewrite already ending in punctuation, read those periods
  // as "already punctuated", and restored only 2 of 6 semicolons -- so the claim
  // still collapsed on rewrap, 11 elements to 6. Deferring to the model's
  // punctuation was the same mistake as deferring to its markers, one layer on.
  let restored = 0, replaced = 0, unplaceable = 0;
  for (const c of perClaim) {
    const terms = terminatorsFor(c.text, c.elements);
    for (let i = 0; i < c.rows.length; i++) {
      const t = terms[i];
      if (!t) continue;
      const cur = c.rows[i].rewritten;
      if (cur.endsWith(t)) continue;                 // already exactly right
      const ownMark = cur.match(/([;,:.])\s*$/);
      if (ownMark) {
        // The source is authoritative about structure. Swap the model's mark for
        // the one the claim actually used -- except a FINAL period, which is the
        // sentence ending and correct.
        const isFinal = i === c.rows.length - 1;
        if (isFinal && ownMark[1] === '.') continue;
        c.rows[i].rewritten = cur.replace(/[;,:.]\s*$/, '') + t;
        replaced++;
      } else {
        c.rows[i].rewritten = cur + t;
        restored++;
      }
    }
    unplaceable += c.elements.length - terms.filter(Boolean).length;

    // SPLIT-INVARIANCE IS THE GUARANTEE THIS COMMAND EXISTS TO PROVIDE, so it is
    // CHECKED rather than assumed, PER CLAIM. Feed the output back through the
    // same splitter and require the same element count. A rewrite that changes
    // the row skeleton makes the before/after retrieval comparison
    // uninterpretable -- vocabulary change and structure change become
    // inseparable -- which is precisely the confound that motivated rewriting
    // per limitation in the first place.
    //
    // PER CLAIM AND NOT PER RUN. An aggregate count over 13 claims can hold
    // while one claim gained a row and another lost one; and even when it does
    // report a change, "171 became 172" does not say where to look. The number
    // that matters downstream is claim-scoped, because scoring pairs claim i
    // with key i.
    //
    // Not fatal: the artifact is still worth having, and the caller may know
    // why. But it must never be silent, because the failure is invisible
    // downstream -- the file still has the right number of LINES.
    c.reSplit = splitClaimElements(c.rows.map((r) => r.rewritten).join('\n'), { fine: args.granularity !== 'coarse' }).length;
    c.failed = c.rows.filter((r) => r.error).length;
    if (c.reSplit !== c.elements.length) {
      process.stderr.write(`[synonymize] WARNING: ${isCorpus ? `claim ${c.n} ` : 'the rewritten claim '}`
        + `re-splits to ${c.reSplit} element(s), not ${c.elements.length}. The row skeleton did NOT`
        + ` survive, so a before/after retrieval comparison against`
        + `${isCorpus ? ' this claim' : ' it'} cannot separate vocabulary change from structure change.\n`);
    }
  }

  // Repairs are REPORTED, never silent: a synonymized claim used as ground truth
  // must not quietly differ from what the engine produced, and a high repair
  // count is itself a finding about the engine.
  const repairs = allRows.filter((r) => r.repaired).length;
  if (repairs) {
    process.stderr.write(`[synonymize] stray ", and" repaired on ${repairs} element(s)`
      + ` — the rewrite introduced a boundary the source did not have
`);
  }
  process.stderr.write(`[synonymize] terminal punctuation: ${restored} added, ${replaced} corrected`
    + ` (of ${totalElements} element(s))${unplaceable
      ? `; ${unplaceable} could not be located in the source` : ''}\n`);

  const broke = perClaim.filter((c) => c.reSplit !== c.elements.length);
  if (isCorpus) {
    process.stderr.write(`[synonymize] re-split: ${perClaim.length - broke.length} of ${perClaim.length}`
      + ` claim(s) preserved${broke.length ? ` — CHANGED on claim ${broke.map((c) => c.n).join(', ')}` : ''}\n`);
  }

  const provenance = buildSynonymizeProvenance({
    engineLabel, claimSource, elements: totalElements, failed, meanOverlap,
    reSplit: perClaim[0].reSplit, repairs,
    perClaim: isCorpus
      ? perClaim.map((c) => ({ n: c.n, elements: c.elements.length, reSplit: c.reSplit, failed: c.failed }))
      : null,
    argv: process.argv.slice(1).join(' '),
    ceVersion: readCeVersion(), generatedAt: new Date().toISOString(),
  });
  // SINGLE CLAIM: one element per line, so the result feeds straight back in via
  // --elements and the row skeleton is preserved across the comparison.
  //
  // CORPUS: one CLAIM per line, matching the input format, so the file
  // round-trips -- back into --synonymize, or on to retrieval, with position
  // preserved and no re-parsing step in between. The elements are joined by the
  // terminal punctuation just restored, which is the whole reason that
  // restoration matters here: a claim written back as one line is re-split from
  // its punctuation alone.
  const body = isCorpus
    // A claim that produced no elements is written back AS IT CAME IN, not as a
    // blank line: position is the pairing, and a dropped line silently shifts
    // every later claim against its key.
    ? perClaim.map((c) => (c.rows.length
        ? c.rows.map((r) => r.rewritten).join(' ').replace(/\s+/g, ' ').trim()
        : claimLine(c.text))).join('\n')
    : perClaim[0].rows.map((r) => r.rewritten).join('\n');
  const outText = `${provenance}\n${body}\n`;

  if (args.synonymize_out) {
    try { fs.writeFileSync(args.synonymize_out, outText, 'utf8'); }
    catch (e) { console.error(`Cannot write ${args.synonymize_out}: ${e.message}`); process.exitCode = 1; return; }
    process.stderr.write(`[synonymize] wrote ${args.synonymize_out}\n`);
  } else {
    console.log(outText);
  }

  process.stderr.write(`[synonymize] mean vocabulary overlap ${meanOverlap.toFixed(1)}%`
    + `${failed ? `, ${failed} element(s) kept original` : ''}\n`);
  // A rewrite that changed almost nothing is a failed test setup, not a result —
  // say so, because the downstream comparison would look like a success.
  if (meanOverlap > 60) {
    process.stderr.write(`[synonymize] WARNING: ${meanOverlap.toFixed(0)}% of the original vocabulary survived.`
      + ` ${isCorpus ? 'These claims are' : 'This claim is'} not meaningfully harder;`
      + ` a retrieval comparison against ${isCorpus ? 'them' : 'it'} proves little.\n`);
  }
  const cost = actualCostLine(model);
  if (cost) process.stderr.write(cost + '\n');
  return {
    rows: allRows, meanOverlap, failed, elementsSource,
    claims: perClaim.map((c) => ({
      n: c.n, elements: c.elements.length, reSplit: c.reSplit, failed: c.failed,
      rewritten: c.rows.map((r) => r.rewritten),
    })),
    mode, isCorpus,
  };
}
