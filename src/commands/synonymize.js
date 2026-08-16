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
import { splitClaimElements, parseElementsFile } from './claim-locate.js';

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
    // Overlap is scored on the BODY, not the marker: "(a)" is not vocabulary,
    // and counting it would flatter every rewrite by a constant.
    const kept = error ? { kept: 0, total: 0, pct: 100, survivors: [] }
                       : vocabularyOverlap(bodyText, rewritten);
    const row = { n: i + 1, original, rewritten: error ? original : rewritten, error, overlap: kept };
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

// `#` provenance, matching --targets-out. HOF depends on knowing WHICH model did
// the rewriting, since the premise of HOF-b is that it is a different model from
// the one being tested.
export function buildSynonymizeProvenance({ engineLabel, claimSource, elements, failed, meanOverlap, argv, ceVersion, generatedAt, reSplit }) {
  const skeleton = reSplit == null ? null
    : reSplit === elements ? `${reSplit} — preserved`
    : `${reSplit} — CHANGED, comparison unsafe`;
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
    `# CE:         ${ceVersion}`,
    `# Generated:  ${generatedAt}`,
    `# Command:    ${argv}`,
  ].join('\n');
}

export async function doSynonymize(args, opts = {}) {
  const spec = String(args.synonymize || '');
  let claimText = spec, claimSource = null;
  if (spec.startsWith('@')) {
    claimSource = spec.slice(1);
    try { claimText = fs.readFileSync(claimSource, 'utf8'); }
    catch (e) { console.error(`Cannot read claim file: ${e.message}`); process.exitCode = 1; return; }
  }
  if (!claimText.trim()) { console.error('--synonymize: no claim text.'); process.exitCode = 1; return; }

  // --elements @file wins over the heuristic split, same contract as --claim-chart:
  // a practitioner's construction of the claim beats any regex.
  let elements = null, elementsSource = null;
  if (args.elements) {
    const espec = String(args.elements);
    const epath = espec.startsWith('@') ? espec.slice(1) : espec;
    let eraw;
    try { eraw = fs.readFileSync(epath, 'utf8'); }
    catch (e) { console.error(`Cannot read elements file: ${e.message}`); process.exitCode = 1; return; }
    ({ elements } = parseElementsFile(eraw));
    if (!elements.length) { console.error(`--elements: ${epath} has no element lines.`); process.exitCode = 1; return; }
    elementsSource = `\`${epath}\` — ${elements.length} supplied verbatim`;
  } else {
    elements = splitClaimElements(claimText);
    elementsSource = `${elements.length} from CE's split`;
  }
  if (!elements.length) { console.error('--synonymize: the claim produced no elements.'); process.exitCode = 1; return; }

  const model = resolveModel(args);
  if (!model) { console.error('--synonymize needs a model: --llm <provider> or --model <gguf>.'); process.exitCode = 1; return; }
  if (model.kind === 'error') { console.error(`Error: ${model.error}`); process.exitCode = 1; return; }
  let draft;
  try { draft = opts.draft || makeDrafter(model, args.temperature ?? 0); }
  catch (e) { console.error(`--synonymize: ${e.message}`); process.exitCode = 1; return; }

  const engineLabel = describeEngine(model);
  process.stderr.write(`[synonymize] ${elements.length} element(s), engine ${engineLabel}\n`);
  process.stderr.write('[synonymize] the model is shown the CLAIM ONLY — no index, no code, no paths\n');

  // One call per element, gated before spending.
  const calls = elements.map((e) => ({ inChars: String(e).length + 1500, outTokens: SYNONYMIZE_DEFAULTS.maxTokensPerElement }));
  if (!claimsCostGate(model, calls, `synonymize (${elements.length} calls)`, args)) return;
  resetCloudUsage();

  const rows = await synonymizeElements({
    draft, elements, opts: args,
    onElement: (r) => process.stderr.write(
      r.error ? `  ${r.n}: FAILED (${r.error}) — keeping original\n`
              : `  ${r.n}: ${r.overlap.pct.toFixed(0)}% of content words survive`
                + `${r.overlap.survivors.length ? ` [${r.overlap.survivors.slice(0, 6).join(', ')}]` : ''}\n`),
  });

  const failed = rows.filter((r) => r.error).length;
  const scored = rows.filter((r) => !r.error);
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
  const terms = terminatorsFor(claimText, elements);
  let restored = 0, replaced = 0;
  for (let i = 0; i < rows.length; i++) {
    const t = terms[i];
    if (!t) continue;
    const cur = rows[i].rewritten;
    if (cur.endsWith(t)) continue;                 // already exactly right
    const ownMark = cur.match(/([;,:.])\s*$/);
    if (ownMark) {
      // The source is authoritative about structure. Swap the model's mark for
      // the one the claim actually used -- except a FINAL period, which is the
      // sentence ending and correct.
      const isFinal = i === rows.length - 1;
      if (isFinal && ownMark[1] === '.') continue;
      rows[i].rewritten = cur.replace(/[;,:.]\s*$/, '') + t;
      replaced++;
    } else {
      rows[i].rewritten = cur + t;
      restored++;
    }
  }
  const placeable = terms.filter(Boolean).length;
  process.stderr.write(`[synonymize] terminal punctuation: ${restored} added, ${replaced} corrected`
    + ` (of ${elements.length} element(s))${placeable < elements.length
      ? `; ${elements.length - placeable} could not be located in the source` : ''}\n`);

  // SPLIT-INVARIANCE IS THE GUARANTEE THIS COMMAND EXISTS TO PROVIDE, so it is
  // CHECKED rather than assumed. Feed the output back through the same splitter
  // and require the same element count. A rewrite that changes the row skeleton
  // makes the before/after retrieval comparison uninterpretable -- vocabulary
  // change and structure change become inseparable -- which is precisely the
  // confound that motivated rewriting per limitation in the first place.
  //
  // Not fatal: the artifact is still worth having, and the caller may know why.
  // But it must never be silent, because the failure is invisible downstream --
  // the file still has the right number of LINES.
  const rebuiltSplit = splitClaimElements(rows.map((r) => r.rewritten).join('\n'));
  const skeletonHeld = rebuiltSplit.length === elements.length;
  if (!skeletonHeld) {
    process.stderr.write(`[synonymize] WARNING: the rewritten claim re-splits to `
      + `${rebuiltSplit.length} element(s), not ${elements.length}. The row skeleton did NOT survive,`
      + ` so a before/after retrieval comparison against this claim cannot separate`
      + ` vocabulary change from structure change.\n`);
  }

  const provenance = buildSynonymizeProvenance({
    engineLabel, claimSource, elements: elements.length, failed, meanOverlap,
    reSplit: rebuiltSplit.length,
    argv: process.argv.slice(1).join(' '),
    ceVersion: readCeVersion(), generatedAt: new Date().toISOString(),
  });
  // One element per line, so the result feeds straight back in via --elements
  // and the row skeleton is preserved across the comparison.
  const body = rows.map((r) => r.rewritten).join('\n');
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
      + ` This claim is not meaningfully harder; a retrieval comparison against it proves little.\n`);
  }
  const cost = actualCostLine(model);
  if (cost) process.stderr.write(cost + '\n');
  return { rows, meanOverlap, failed, elementsSource };
}
