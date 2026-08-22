// ============================================================================
// claim-chart.js — --claim-chart: ONE element-per-row chart for a real patent
// claim, merged across explicit targets. The client deliverable (#300 Tier 2).
//
// WHY THIS EXISTS. `--claim-analyze` over N targets produces N isolated
// verdicts. On the live '101 run that meant the same structural absence was
// re-derived three times and ~60% of the output was redundant restatement,
// with nothing merged per element. The value here is the MERGE, not the
// batching.
//
// TWO STRUCTURAL RULES, both load-bearing for the artifact:
//
//   1. CE OWNS THE STRUCTURE, the model owns only the cell contents. Rows come
//      from splitClaimElements, the table/caveats/coverage summary are emitted
//      here, and every engine produces the identical skeleton. That is what
//      makes `--llm claude`, `--llm chatgpt`, `--llm gemini` and `--model
//      <gguf>` charts juxtaposable — which is the whole local-vs-cloud
//      argument. If the model formatted, four charts would not be comparable.
//
//   2. VERDICTS ARE NEVER SOFTENED. ABSENT is a result. This file does not
//      argue toward or away from any label; the scope note states a structural
//      fact once instead of the model re-deriving it per element, and that is
//      the only thing it does.
//
// The output is the deliverable, verbatim. Commentary belongs beside it, never
// inside it.
// ============================================================================

import fs from 'node:fs';
import { resolveModel, makeDrafter, claimsCostGate, actualCostLine, resetCloudUsage, describeEngine, engineBuildLine } from '../core/llm-runner.js';
import { buildClaimAnalyzePrompt, addLineNumbers, readClaimFile } from './analyze.js';

// Shared reporter for dropped `#` provenance lines. Never silent: discarding
// input without saying so is how the next version of this bug hides.
const _noteComments = (n, f) => process.stderr.write(
  `  Claim file ${f}: ignored ${n} '#' comment line(s) (provenance, not claim text).\n`);
import { splitClaimElements, targetsChecksum, dedupeTargets, parseElementsFile, retrievePerElement, isPreambleRow, limitationTag, classifyLimitation } from './claim-locate.js';
import { readCeVersion } from '../utils.js';
import { buildSymbolTable, verifySymbol, isFound, navigateFrom } from '../core/symbol-verify.js';
import { parseAnalysisLabels, lexicalGate } from './claims-loop.js';

// Mirrors claims-loop's private LABEL_RANK. Duplicated deliberately rather than
// widening this item's file list to re-export it; if a label is ever added,
// both must change together.
const LABEL_RANK = { ABSENT: 0, ASSUMED: 1, PARTIAL: 2, PRESENT: 3 };

// package.json version, best-effort. A chart that cannot say which build made
// it cannot be reproduced.
export { readCeVersion };

export const CHART_DEFAULTS = {
  calleeDepth: 1,          // depth-1 bodies only; depth 2 blew the local context
  maxCalleeBytes: 6000,    // total appended callee source per target
  maxCallees: 6,
  // Per-element retrieval bounds. Every target is a model call, and 10 elements
  // x 25 candidates is 250 analyses — so the candidates are a pool to select
  // from, not a target list.
  //
  // How deep to go per element. The total is DERIVED from this and the element
  // count; it is not a second, independent number that can quietly override it.
  targetsPerElement: 3,
  // A COST ceiling, and nothing else. It exists to stop a 20-element claim
  // becoming a 60-call run, not to define the depth — that is what the previous
  // value of 12 did by accident, making the real depth 12/elements and putting
  // `targetsPerElement: 3` out of reach on any claim over 4 limitations. Real
  // independent claims run median 9 (5,395 measured), so the knob had never
  // been active on a real claim.
  //
  // 30 lets depth 3 be reached on a 10-element claim. Raising it costs model
  // calls in direct proportion — on a 24B local model, 12 -> ~27 targets is
  // roughly 11 min -> 26 min per chart — so it is meant to be LOWERED for
  // casual use, via --max-retrieved-targets, not treated as free.
  maxRetrievedTargets: 30,
};

// The total is `targetsPerElement x elements`, bounded by the cost ceiling.
// Deriving it is the whole point: an independent constant is what let the
// documented knob be silently overridden for months.
export function resolveTargetBudget(elementCount, opts = {}) {
  const perEl = Math.max(1, Number(
    opts.targetsPerElement ?? opts.targets_per_element ?? CHART_DEFAULTS.targetsPerElement));
  const ceiling = Math.max(1, Number(
    opts.maxRetrievedTargets ?? opts.max_retrieved_targets ?? CHART_DEFAULTS.maxRetrievedTargets));
  const wanted = perEl * Math.max(1, Number(elementCount) || 1);
  return { perEl, ceiling, total: Math.min(wanted, ceiling), wanted };
}

// Turn per-element candidates into a bounded target list, ROUND-ROBIN by rank:
// every element contributes its best candidate before any element contributes a
// second. Taking the first N in element order would spend the whole budget on
// elements 1-3 and leave the rest with no evidence at all — and an element with
// no evidence is precisely what this path exists to make visible.
export function perElementTargets(perElement, opts = {}) {
  return perElementTargetsWithStats(perElement, opts).targets;
}

// Same selection, but it also reports what the budget DID — requested depth vs
// achieved, and which bound stopped it. The defect this repairs went unnoticed
// for months because nothing compared the two: the provenance line printed the
// requested depth on every chart CE has ever produced, including the ones that
// reached depth 1. A bound that fires has to say so in the artifact — the same
// rule as the truncation detector (58a596d) and the catalog cap (221895c).
export function perElementTargetsWithStats(perElement, opts = {}) {
  const elements = Array.isArray(perElement) ? perElement : [];
  const { perEl, ceiling, total, wanted } = resolveTargetBudget(elements.length, opts);
  const spec = (sym) => `${String(sym.filepath || '').split('!').pop().split('/').pop()}@${sym.name}`;
  const out = [];
  const seen = new Set();
  let ranksCompleted = 0;
  let deepestRankUsed = -1;
  let budgetLimited = false;
  for (let rank = 0; rank < perEl; rank++) {
    let cappedMidRank = false;
    for (const p of elements) {
      if (out.length >= total) { cappedMidRank = true; budgetLimited = true; break; }
      const h = (p.hits || [])[rank];
      if (!h || !h.sym) continue;
      const s = spec(h.sym);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      deepestRankUsed = Math.max(deepestRankUsed, rank);
    }
    // A rank counts as achieved when every element got its chance at it —
    // including elements with no candidate that deep, and duplicates that were
    // collapsed. Depth is about what CE offered to look at, not what survived.
    if (cappedMidRank) break;
    ranksCompleted = rank + 1;
  }
  // Two different numbers, and reporting the wrong one is how this defect
  // started. `ranksCompleted` is the depth CE OFFERED every element; on a thin
  // index all three ranks "complete" while finding nothing, which would state
  // "depth 3 achieved" over a single candidate. So the reported depth is the
  // floor of the two: no deeper than CE offered, and no deeper than the index
  // actually yielded.
  const achievedDepth = Math.min(ranksCompleted, deepestRankUsed + 1);
  // A short list has two very different causes and they must not be conflated:
  // the budget stopped us, or the index simply had nothing deeper to offer.
  // Reporting the second as BUDGET-LIMITED would send a user to raise a ceiling
  // that was never the constraint.
  const deepest = elements.reduce((m, p) => Math.max(m, (p.hits || []).length), 0);
  return {
    targets: out,
    requestedDepth: perEl,
    achievedDepth,
    total,
    ceiling,
    wanted,
    budgetLimited,
    candidatesExhausted: !budgetLimited && deepest < perEl,
  };
}

// Rows come from the CLAIM, not from the model — one row per element, in claim
// order, so every engine's chart lines up row-for-row.
export function buildChartTable(claimText, opts = {}) {
  // A supplied list (--elements @file) wins over the heuristic split: no regex
  // reaches a practitioner's construction of a claim.
  const elements = (opts.elements && opts.elements.length)
    ? opts.elements
    : splitClaimElements(claimText);
  // The header is where a reader forms their interpretation of the column, and
  // "CE finding" invited the wrong one. The verdict answers whether the
  // LIMITATION is met, not whether the recited feature appears — the same word
  // on a negative limitation would otherwise read backwards.
  const lines = ['| # | Claim element | CE finding — is the limitation met? | Cited code |', '|---|---|---|---|'];
  elements.forEach((e, i) => {
    // Part B: mark the preamble row.
    //
    // Andrew (#310): "Preamble must always be shown as first row. Point is that
    // failure to find matching code for a preamble would often not be fatal."
    // Unlabelled, the two cases render identically and a reader cannot act on
    // that distinction:
    //
    //   '101 chart  | 1 | A distribution system, including ... | ABSENT  |
    //   TLS chart   | 1 | A method of establishing a secure ... | PRESENT |
    //
    // An examiner reading the first cold sees a claim whose very first row
    // failed, when a preamble is "generally not a limitation" unless it
    // "breathes life and meaning into the claim".
    const tag = isPreambleRow(e, i) ? ' _[preamble]_' : '';
    lines.push(`| ${i + 1} | ${String(e).replace(/\|/g, '\\|')}${tag} |  |  |`);
  });
  return { table: lines.join('\n'), elements };
}

// Parse `--targets "file.java@Class::fn;other.java@fn"` or `@targets.txt`.
export function parseTargets(spec) {
  let raw = String(spec || '');
  let source = 'the --targets argument';
  if (raw.startsWith('@')) {
    const path = raw.slice(1);
    try { raw = fs.readFileSync(path, 'utf8'); }
    catch (e) { throw new Error(`cannot read targets file: ${e.message}`); }
    source = `\`${path}\``;
  }
  // Leading `#` lines are PROVENANCE, carried verbatim into the header. This is
  // what makes a targets file self-documenting — the operator (or a future
  // --claim-locate that stamps its own command line into the file it suggests)
  // records how the list was produced, and the chart can then answer for it.
  const provenance = [];
  const targets = [];
  let claimed = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const body = t.replace(/^#+\s*/, '');
      const m = /^Targets-checksum:\s*([0-9a-f]+)$/i.exec(body);
      if (m) { claimed = m[1].toLowerCase(); continue; }
      provenance.push(body);
      continue;
    }
    for (const part of t.split(';')) {
      const p = part.trim();
      if (p) targets.push(p);
    }
  }
  // Curating a target list is a legitimate operator action — CE reports it, it
  // does not forbid it. But without this the provenance block would keep
  // vouching for a run that produced a DIFFERENT list than the one below it,
  // which just relocates the honesty problem the block exists to solve.
  //
  // Checksummed BEFORE dedup, deliberately: a duplicate hand-added to a
  // CE-produced file is an edit, and deduping first would hide it.
  const integrity = claimed == null ? null
    : (targetsChecksum(targets) === claimed ? 'unmodified' : 'modified');
  // Defence in depth — a hand-written targets file gets the same protection as
  // a CE-emitted one. A duplicate here would inflate the per-element agreement
  // count, which is the one number in the chart a reader cannot sanity-check.
  const { targets: unique, duplicates, containers } = dedupeTargets(targets);
  return { targets: unique, provenance, source, integrity, duplicates, containers };
}

// Depth-1 callee BODIES for the analysed function.
//
// This is the #300 Tier-1 fix. On the live run the model wrote "the function
// calls determineIdealSelectedIndex(...) to select a track. However, the
// determination uses bufferedDurationUs…" — it INFERRED what the crux function
// did because the prompt held only the target's own source. A digest would not
// have fixed that: a digest lists callee NAMES. The bodies are what settle it.
export function collectCalleeBodies(index, symbols, seed, opts = {}) {
  const depth = opts.calleeDepth ?? CHART_DEFAULTS.calleeDepth;
  const maxBytes = opts.maxCalleeBytes ?? CHART_DEFAULTS.maxCalleeBytes;
  const maxCallees = opts.maxCallees ?? CHART_DEFAULTS.maxCallees;
  if (depth < 1 || !seed) return { text: '', included: [] };

  const nav = navigateFrom(index, seed, { limit: maxCallees * 2 });
  const out = [];
  const included = [];
  let bytes = 0;
  for (const name of (nav.callees || []).slice(0, maxCallees * 2)) {
    if (included.length >= maxCallees || bytes >= maxBytes) break;
    // Resolve within the seed's own file first — a bare callee name is
    // ambiguous index-wide (eight symbols share `updateSelectedTrack`).
    const bare = String(name).replace(/^.*::/, '');
    const local = symbols.filter((s) => s.filepath === seed.filepath && s.bare === bare);
    const v = local.length ? { status: 'exact', matches: local } : verifySymbol(symbols, name);
    if (!isFound(v)) continue;
    const m = v.matches[0];
    let got = null;
    const _log = console.log; console.log = () => {};
    try { got = index.getFunctionSourceWithRange?.(m.filepath, m.name); } catch { got = null; } finally { console.log = _log; }
    const src = got?.source;
    if (!src) continue;
    const clipped = String(src).slice(0, Math.max(0, maxBytes - bytes));
    bytes += clipped.length;
    included.push(m.name);
    // Number each callee with ITS OWN start line. A callee from another file
    // has its own numbering; sharing the target's offset would be worse than no
    // numbers, because it looks authoritative and is wrong.
    //
    // And number from the range the SOURCE covers, not from m.start: the text
    // begins at the prepended doc comment, so m.start labels the comment as the
    // signature and shifts every line below it (#306).
    const numFrom = got?.start ?? m.start;
    const body = numFrom != null ? addLineNumbers(clipped, numFrom) : clipped;
    out.push(`\n// ---- callee: ${m.name}  (${m.filepath.split('!').pop()}${m.start != null ? `, L${m.start}-${m.end}` : ''}) ----\n${body}`);
  }
  return { text: out.join('\n'), included };
}

// The chart needs machine-parseable per-element verdicts; `--claim-analyze`
// does not. buildClaimAnalyzePrompt asks for prose plus a single coverage
// summary line ("Claim coverage: 2 PRESENT, 1 ABSENT out of 5 elements") and
// never requests a label per element — so claims-loop's parser recovers COUNTS
// from it but no per-element labels, and counts cannot fill rows. Rather than
// change the output contract of the interactive command for every caller, the
// chart appends its own explicit contract and parses that.
export function buildChartAnalysisPrompt(src, fnName, filepath, claimText, elements) {
  const base = buildClaimAnalyzePrompt(src, fnName, filepath, claimText, false);
  // The tag travels with the element, so the model judges the right question.
  // Deterministic regex, not a model construing a claim — see classifyLimitation.
  const rows = elements.map((e, i) => {
    const tag = limitationTag(e);
    return `ELEMENT ${i + 1}: ${String(e).slice(0, 150)}${tag ? `\n  ${tag}` : ''}`;
  }).join('\n');
  return `${base}

Each verdict answers ONE question: is this claim limitation MET by this code?
It does not answer whether the recited feature appears. For most limitations
those coincide. For a limitation requiring something to be ABSENT they are
opposites: if the limitation calls for X to be absent and the code does X, the
limitation is NOT met and the verdict is ABSENT — even though X is plainly
there. Elements where this applies are tagged below.

The claim has been split into the numbered elements below. AFTER your analysis,
emit one line per element, in this exact form and nothing else on the line:

VERDICT <n>: <PRESENT|PARTIAL|ASSUMED|ABSENT> | <one sentence, and the line
number(s) in this function that justify it, or "no line" if none>

Emit a VERDICT line for EVERY element, including ones this function has nothing
to do with — ABSENT is a correct and expected answer for those. Do not omit an
element, do not merge two elements onto one line, and do not renumber.

The source above carries its OWN file line numbers in the left margin, in the
form "  436 | code". Cite those numbers exactly as shown. Do not count lines
yourself and do not renumber from 1: a citation that does not match the file
cannot be verified, and an unverifiable citation is worse than none.

${rows}`;
}

// Strip presentation from a candidate VERDICT line before matching it.
//
// Every engine tested decorates this contract differently, though the prompt
// says "in this exact form and nothing else on the line": Gemini doubled `@`,
// Gemma parenthesised line ranges, Devstral emits markdown bullets. Devstral
// lost 73% of its analyses to a leading "- " — 16 of 22 targets returned 0/10
// while their raw text held ten correct, well-reasoned VERDICT lines (#306,
// asus-CC "Edit 6"). Normalising retires the class; adding a character to the
// regex per engine does not, and a fourth engine will invent a fourth form.
//
// Only leading decoration is removed. Emphasis inside the note is left alone —
// `__init__` in a citation is content, not formatting.
export function normalizeVerdictLine(line) {
  let s = String(line || '').trim();
  // Leading list markers and bold, possibly stacked ("- **", "* - "). The
  // required space after a bullet char keeps "*VERDICT" (emphasis, not a
  // bullet) intact for the regex's own `\**` tolerance to handle.
  for (let i = 0; i < 4; i++) {
    const t = s.replace(/^(?:[-*+•‣◦⁃]\s+|\*\*|__)/, '');
    if (t === s) break;
    s = t;
  }
  // Runs of whitespace, including the non-breaking and full-width spaces that
  // turn up in model output, collapse to one. Spacing is never content here.
  return s.replace(/[\s 　]+/g, ' ').trim();
}

// Parse the VERDICT contract above. Falls back to claims-loop's parser so a
// model that ignores the contract but produces its usual labelled blocks still
// yields something rather than an empty chart.
export function parseChartVerdicts(text, elements) {
  const out = [];
  const seen = new Set();
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = normalizeVerdictLine(rawLine);
    const m = line.match(/^\**VERDICT\s*(\d+)\s*\**\s*[:\-]\s*\**\s*(PRESENT|PARTIAL|ASSUMED|ABSENT)\b\**\s*\|?\s*(.*)$/i);
    if (!m) continue;
    const n = Number(m[1]);
    if (!(n >= 1 && n <= elements.length) || seen.has(n)) continue;
    seen.add(n);
    out.push({
      element: n,
      text: String(elements[n - 1] || ''),
      label: m[2].toUpperCase(),
      note: (m[3] || '').trim(),
    });
  }
  if (out.length) return out;
  // Fallback: labelled blocks in claims-loop's shape, matched to elements by
  // position. Weaker, but better than discarding a usable analysis.
  const parsed = parseAnalysisLabels(text || '');
  return parsed.elements.slice(0, elements.length).map((e, i) => ({
    element: i + 1, text: String(elements[i] || e.text), label: e.label, note: '',
  }));
}

// Merge per-element verdicts across targets: best label wins, carrying the
// citation that produced it. Same rule as claims-loop's anchoredPass.
export function mergeBestPerElement(perTarget) {
  const best = new Map();
  // Tally every label each element received, not just the winner. The merge
  // already visits all of them and was discarding the field: a cell reading
  // "ASSUMED, RtspMessageChannel" could be 1 of 34 targets with 33 dissenting,
  // or 30 agreeing, and the chart rendered those identically. The rule stays
  // strongest-wins — one function implementing an element IS infringement of
  // that element, so requiring agreement would suppress true findings — but the
  // reader has to be able to see how lonely a finding is.
  const tally = new Map();
  for (const { target, elements } of perTarget) {
    for (const e of elements) {
      // Key on the element NUMBER when the VERDICT contract supplied one —
      // exact, and immune to the model paraphrasing the element text. Fall back
      // to normalized text only for the legacy labelled-block path.
      const key = e.element != null
        ? `#${e.element}`
        : String(e.text || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      if (!key) continue;
      const t = tally.get(key) || { PRESENT: 0, PARTIAL: 0, ASSUMED: 0, ABSENT: 0, total: 0 };
      if (t[e.label] != null) t[e.label] += 1;
      t.total += 1;
      tally.set(key, t);
      const prev = best.get(key);
      if (!prev || (LABEL_RANK[e.label] ?? 0) > (LABEL_RANK[prev.label] ?? 0)) {
        best.set(key, { element: e.element, text: e.text, label: e.label, target, note: e.note || '' });
      }
    }
  }
  for (const [key, v] of best) v.agreement = tally.get(key) || null;
  return [...best.values()];
}

// Fill the chart by element NUMBER. claims-loop's fillChartSection is built for
// a 3-column table, fills a single cell, and matches rows by fuzzy keyword
// overlap — all three are wrong here: this table has a separate finding column,
// and the VERDICT contract already carries the element number, so row targeting
// is exact rather than inferred. Its `(loop: X)` marker would also mislabel the
// provenance.
export function fillChartRows(table, fills) {
  const lines = table.split('\n');
  const byNum = new Map(fills.filter((f) => f.element != null).map((f) => [f.element, f]));
  const unplaced = fills.filter((f) => f.element == null);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\| (\d+) \| (.*?) \|\s*\|\s*\|\s*$/);
    if (!m) continue;
    const f = byNum.get(Number(m[1]));
    if (!f) continue;
    const cite = f.target ? `\`${f.target}\`` : '—';
    const note = f.note ? ` ${String(f.note).replace(/\|/g, '\\|').slice(0, 160)}` : '';
    // How lonely is this finding? "(1 of 34; 33 ABSENT)" tells the reader that
    // a lone PRESENT was promoted over 33 dissents — which deserves scrutiny —
    // while "(30 of 34)" does not.
    const a = f.agreement;
    let agree = '';
    if (a && a.total > 1) {
      const mine = a[f.label] || 0;
      const others = Object.entries(a)
        .filter(([k, n]) => k !== 'total' && k !== f.label && n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      agree = ` _(${mine} of ${a.total}${others ? `; ${others}` : ''})_`;
    }
    lines[i] = `| ${m[1]} | ${m[2]} | **${f.label}**${agree}${note} | ${cite} |`;
  }
  let out = lines.join('\n');
  if (unplaced.length) {
    out += `\n\n_Finding(s) not matched to a numbered element: ${
      unplaced.map((f) => `${f.label} (\`${f.target}\`)`).join(', ')}._`;
  }
  return out;
}

export function coverageLine(fills, nElements, elements = null) {
  // Part C: the preamble is counted SEPARATELY.
  //
  // Every row used to count identically, so a headline like "9 PRESENT of 11"
  // silently mixed a preamble verdict into a count of LIMITATIONS -- and the
  // preamble is generally not a limitation. asus-CC quoted exactly that number
  // in the artifact and to Andrew before noticing. Same data, separated: the
  // reader can see the limitations tally and the preamble's fate without one
  // being folded into the other.
  const preIdx = Array.isArray(elements)
    ? elements.findIndex((e, i) => isPreambleRow(e, i))
    : -1;
  const isPre = (f, i) => (preIdx >= 0 && (f.element != null ? f.element - 1 : i) === preIdx);

  const c = { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 };
  let preLabel = null, cited = 0;
  fills.forEach((f, i) => {
    if (isPre(f, i)) { preLabel = f.label; return; }
    cited++;
    if (c[f.label] != null) c[f.label] += 1;
  });
  const nLimitations = preIdx >= 0 ? Math.max(0, nElements - 1) : nElements;
  const noFinding = Math.max(0, nLimitations - cited);
  return `**Coverage:** ${c.PRESENT} PRESENT · ${c.PARTIAL} PARTIAL · ${c.ASSUMED} ASSUMED · `
    + `${c.ABSENT} ABSENT · ${noFinding} element(s) with no finding`
    + `${preIdx >= 0 ? ` across ${nLimitations} limitation(s); preamble ${preLabel || 'no finding'}` : ''}.`;
}

// Provenance the artifact must carry to be defensible. Everything here is
// machine-derived except targetProvenance, which CANNOT be — CE has no way to
// know how a targets file was produced. When it is unknown the header says so
// rather than leaving a silent gap: an honest blank is defensible, an invisible
// one is not. "Where did these targets come from, and why these and not others?"
// is the first question an opposing expert asks.
export function buildProvenanceHeader({
  claimText, claimSource, indexPath, indexFiles, indexSymbols, engineLabel, engineBuild,
  argv, targets, targetSource, targetProvenance, targetIntegrity, ceVersion, generatedAt,
  targetDuplicates, targetContainers, targetUnresolved, targetAmbiguous,
  targetsSupplied, targetsPartial, elementsSource, elementComments,
}) {
  const firstLine = String(claimText || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  const rows = [];
  rows.push(`- **Claim:** ${firstLine.slice(0, 120)}${firstLine.length > 120 ? '…' : ''}`);
  rows.push(`- **Claim source:** ${claimSource || 'inline text (not from a file)'}`);
  // Where the ROW SKELETON came from. Two engines' charts are only juxtaposable
  // if they charted the same elements, so the skeleton's origin belongs on the
  // artifact rather than in the operator's memory.
  if (elementsSource) rows.push(`- **Elements:** ${elementsSource}`);
  for (const c of (elementComments || [])) rows.push(`  - ${c}`);
  rows.push(`- **Index:** \`${indexPath}\`${indexFiles != null ? ` — ${indexFiles} files` : ''}${indexSymbols != null ? `, ${indexSymbols} symbols` : ''}`);
  rows.push(`- **Engine:** ${engineLabel}`);
  // A SEPARATE line, deliberately. The Engine line carries the air-gap
  // statement ("local LLM, no network egress") and gets quoted as such;
  // appending build metadata would dilute a sentence doing legal work.
  //
  // Local runs only — a cloud chart has no client-side build to report, and
  // inventing a field that is empty on every cloud chart is noise. The line is
  // what makes "reproducible given the same model AND the same build" a claim
  // the artifact can actually support.
  if (engineBuild) rows.push(`- **Engine build:** ${engineBuild}`);
  const integrity = targetIntegrity === 'unmodified'
    ? ' — _unmodified since generation_'
    : targetIntegrity === 'modified'
      ? ' — ⚠ **MODIFIED after generation**: the list below is not the one the'
        + ' recorded command produced, so the provenance describes how the'
        + ' original list was made, not this one'
      : '';
  // Supplied vs analysed must reconcile ON THE PAGE. A chart that says "37
  // analysed" while every agreement count reads "of 30" contradicts itself, and
  // the reader cannot tell that the missing 7 were dropped rather than judged.
  // Worse, the drop is not random: on the 2026-08-07 Gemma run the drop rate was
  // 8% at 0-4 inlined callee bodies and 45% at 5-6, so the targets most likely
  // to vanish are the ones doing the most work — `shouldStartPlayback`, the only
  // citation the Claude baseline had for element 6, dropped, and the chart then
  // printed `ABSENT (30 of 30)`. A unanimity over a filtered set, unmarked.
  const noVerdict = targetsSupplied != null ? Math.max(0, targetsSupplied - targets) : 0;
  const countLine = noVerdict > 0
    ? `${targetsSupplied} supplied · ${targets} analysed · ${noVerdict} produced no verdict`
    : `${targets} analysed`;
  rows.push(`- **Targets:** ${countLine}, from ${targetSource || 'the --targets argument'}${integrity}`);
  // The chart must never under-report its own inputs. A target the model never
  // saw — dropped as a duplicate, subsumed by a class, or unresolvable in this
  // index — changes what the verdicts and the agreement counts mean, and a
  // reader who cannot see the drop reads ABSENT as "CE looked and found
  // nothing" when it may mean "CE could not look". (#305 Part A.)
  const drops = [];
  if (targetDuplicates) drops.push(`${targetDuplicates} duplicate(s) collapsed`);
  if (targetContainers && targetContainers.length) {
    drops.push(`${targetContainers.length} class target(s) dropped in favour of their own`
      + ` methods, which were also targeted (${targetContainers.join(', ')})`);
  }
  if (targetUnresolved && targetUnresolved.length) {
    drops.push(`**${targetUnresolved.length} target(s) could not be resolved in this index`
      + ` and were NOT analysed**: ${targetUnresolved.join(', ')}`);
  }
  if (targetAmbiguous && targetAmbiguous.length) {
    // The chart picks the first match. Silently, until now — so a citation
    // could point at a different symbol than the one the target names, with
    // nothing in the artifact to reveal it.
    drops.push(`${targetAmbiguous.length} ambiguous target(s) — first match used:`
      + ` ${targetAmbiguous.join(', ')}`);
  }
  if (targetsPartial && targetsPartial.length) {
    // Analysed, but not for every element. Counted in `analysed` because it did
    // contribute verdicts; named here because its absence from some elements'
    // denominators is otherwise invisible.
    drops.push(`${targetsPartial.length} target(s) produced verdicts for only some`
      + ` elements: ${targetsPartial.join(', ')}`);
  }
  for (const d of drops) rows.push(`  - ${d}`);
  if (targetProvenance && targetProvenance.length) {
    rows.push('- **Target provenance:**');
    for (const l of targetProvenance) rows.push(`  - ${l}`);
  } else {
    rows.push('- **Target provenance:** _not recorded_ — the targets file carried no'
      + ' `#` provenance comments and no `--targets-note` was given, so how these'
      + ' targets were selected (and why these and not others) is not established'
      + ' by this document.');
  }
  rows.push(argv && argv.trim()
    ? `- **Command:** \`${argv}\``
    : '- **Command:** _not captured_');
  rows.push(`- **Generated:** ${generatedAt}`);
  if (ceVersion) rows.push(`- **CodeExam:** ${ceVersion}`);
  return rows.join('\n');
}

export function formatChart({
  claimText, table, fills, targets, engineLabel, elements, scopeNote, provenance,
  dropped, retrieval,
}) {
  const filled = fillChartRows(table, fills);
  const out = [];
  out.push('# Claim chart');
  out.push('');
  if (provenance) { out.push(provenance); out.push(''); }
  else { out.push(`_Generated by CodeExam. Engine: ${engineLabel}. ${targets.length} analysed target(s)._`); out.push(''); }
  out.push('## Claim');
  out.push('');
  out.push('```');
  out.push(String(claimText).trim());
  out.push('```');
  out.push('');
  if (scopeNote) { out.push('## Scope'); out.push(''); out.push(scopeNote); out.push(''); }
  out.push('## Chart');
  out.push('');
  // WHAT THE LABELS MEAN, stated on the artifact rather than only in the prompt.
  // A definition the model is told and the reader is not leaves the misreading
  // exactly where it was.
  out.push('_**PRESENT** / **PARTIAL** / **ASSUMED** / **ABSENT** describe whether the CLAIM');
  out.push('LIMITATION is met by the cited code — not whether the recited feature appears in it.');
  out.push('For most limitations those coincide; for a limitation requiring something to be');
  out.push('absent they are opposites, and such rows are marked._');
  out.push('');
  out.push(filled);
  out.push('');
  // Negative rows get a gloss, because a legend is not enough where the word
  // inverts: a reader seeing ABSENT on a row whose limitation requires X to be
  // absent will read it as "X is absent", which would mean the limitation IS
  // met. Same word, opposite conclusion, on the rows where that is worst.
  const negRows = (elements || []).map((e, i) => ({ n: i + 1, e, c: classifyLimitation(e) }))
    .filter((r) => r.c.kinds.includes('negative'));
  if (negRows.length) {
    out.push('**Negative limitations in this claim** — these rows are met when the recited');
    out.push('feature is ABSENT from the code, so a verdict of ABSENT means the limitation is');
    out.push('NOT met (the feature was found), and PRESENT means it is met (the feature was not):');
    out.push('');
    for (const r of negRows) out.push(`- Row ${r.n} — cue: \`${r.c.cues.negative}\``);
    out.push('');
  }
  out.push(coverageLine(fills, elements.length, elements));
  out.push('');
  out.push('## Analysed targets');
  out.push('');
  for (const t of targets) out.push(`- \`${t}\``);
  out.push('');
  // PER-ELEMENT RETRIEVAL PROVENANCE. Without it an ABSENT row is ambiguous:
  // "CE examined this element and found nothing" and "CE had nothing to examine"
  // render identically, and only the first is defensible in front of a client.
  if (retrieval && retrieval.length) {
    const blind = retrieval.filter((p) => !(p.hits || []).length);
    out.push('## Retrieval by element');
    out.push('');
    out.push('Each element was searched with its OWN predicted vocabulary, ranked by term'
      + ' rarity, with no quorum. An element with 0 candidates was never examined — that'
      + ' row reports what CE could not look at, not a finding about the code.');
    out.push('');
    out.push('| element | predicted words | candidates |');
    out.push('|---|---|---|');
    for (const p of retrieval) {
      out.push(`| ${p.element} | ${(p.words || []).join(', ').replace(/\|/g, '\\|')} `
        + `| ${(p.hits || []).length} |`);
    }
    out.push('');
    if (blind.length) {
      out.push(`⚠ ${blind.length} of ${retrieval.length} element(s) produced no candidate: `
        + `${blind.map((p) => p.element).join(', ')}. Those rows were not examined.`);
      out.push('');
    }
  }
  // Emitted ONLY when something dropped, so a clean run stays clean. A target
  // the operator supplied and CE never judged is not a detail: the operator
  // chose it, and every per-element denominator above excludes it.
  if (dropped && dropped.length) {
    out.push(`## Targets that produced no finding (${dropped.length} of `
      + `${targets.length + dropped.length})`);
    out.push('');
    out.push('These were supplied as targets but yielded no verdict, so they are'
      + ' excluded from every agreement count above. This is a report of what was'
      + ' *not* examined — not a finding about the code.');
    out.push('');
    out.push('| target | reason |');
    out.push('|---|---|');
    for (const d of dropped) out.push(`| \`${d.target}\` | ${d.reason} |`);
    out.push('');
  }
  out.push('---');
  out.push('');
  out.push('_This chart is machine-generated from a source index and is illustrative only.');
  out.push('It is not legal advice and is not an infringement opinion. Every citation should');
  out.push('be verified against the source — each is reproducible with_ `ce --index-path <idx>');
  out.push('--extract <file>@<function>`_._');
  return out.join('\n');
}

export async function doClaimChart(index, args, opts = {}) {
  const spec = args.claim_chart;
  let claimText = spec;
  if (typeof spec === 'string' && spec.startsWith('@')) {
    // `#` lines are PROVENANCE, not limitations. Same defect cbb8e98 fixed for
    // --claim-analyze, and worse here: measured on a real --synonymize-out file,
    // the header collapsed into row 1 TOGETHER WITH the preamble, so the element
    // count stayed correct at 11 while row 1 of the delivered chart became
    // provenance text and the preamble stopped being a row at all. A count check
    // passes; the chart is wrong.
    //
    // --claim-chart already strips `#` from its ELEMENTS file (parseElementsFile)
    // — the convention was in this command, on the adjacent argument.
    try { claimText = readClaimFile(spec.slice(1), { onComments: _noteComments }); }
    catch (e) { console.error(`Cannot read claim file: ${e.message}`); process.exitCode = 1; return; }
  }
  if (!claimText || !String(claimText).trim()) {
    console.error('--claim-chart needs claim text: --claim-chart @claim.txt'); process.exitCode = 1; return;
  }
  claimText = String(claimText).trim();

  // --elements @file.txt supplies the row skeleton verbatim. Read before the
  // model exists so a bad path fails immediately rather than after a paid call.
  let suppliedElements = null; let elementComments = []; let elementsSource = null;
  if (args.elements) {
    const espec = String(args.elements);
    const epath = espec.startsWith('@') ? espec.slice(1) : espec;
    let eraw;
    try { eraw = fs.readFileSync(epath, 'utf8'); }
    catch (e) { console.error(`Cannot read elements file: ${e.message}`); process.exitCode = 1; return; }
    ({ elements: suppliedElements, comments: elementComments } = parseElementsFile(eraw));
    if (!suppliedElements.length) {
      console.error(`--elements: ${epath} has no element lines (only comments or blanks).`);
      process.exitCode = 1; return;
    }
    elementsSource = `\`${epath}\` — ${suppliedElements.length} supplied verbatim, not split by CE`;
  }

  const model = resolveModel(args);
  if (!model) { console.error('--claim-chart needs a model: --llm <provider> or --model <gguf>.'); process.exitCode = 1; return; }
  if (model.kind === 'error') { console.error(`Error: ${model.error}`); process.exitCode = 1; return; }
  let draft;
  try { draft = opts.draft || makeDrafter(model, args.temperature ?? 0); }
  catch (e) { console.error(`--claim-chart: ${e.message}`); process.exitCode = 1; return; }

  const symbols = buildSymbolTable(index);
  const { table, elements } = buildChartTable(claimText, { elements: suppliedElements });
  if (!elementsSource) elementsSource = `${elements.length} from CE's split of the claim text`;
  // Same descriptor the targets file records, so the chart's `**Engine:**` line
  // and the target provenance `Engine:` line cannot disagree about what ran —
  // and so the cloud-vs-local distinction the air-gap argument turns on is
  // stated on the artifact rather than around it.
  const engineLabel = describeEngine(model);

  // TARGETS. Explicit --targets keeps the previous behaviour exactly. Without
  // them the chart retrieves its own evidence PER ELEMENT, reusing
  // --claim-locate's discovery rather than adding a fourth implementation of
  // "find code for this text". Per-element retrieval has no quorum, so an
  // element whose implementer holds few of the claim's whole-claim terms is
  // still reachable — which whole-claim search structurally cannot do.
  let targets, targetProvenance = [], targetSource = null, targetIntegrity = null;
  let targetDuplicates = null, targetContainers = null;
  let retrieval = null;
  if (args.targets) {
    try { ({ targets, provenance: targetProvenance, source: targetSource, integrity: targetIntegrity,
      duplicates: targetDuplicates, containers: targetContainers } = parseTargets(args.targets)); }
    catch (e) { console.error(e.message); process.exitCode = 1; return; }
    if (!targets.length) { console.error('No targets parsed.'); process.exitCode = 1; return; }
  } else {
    if (!claimsCostGate(model, [{ inChars: claimText.length + 2000, outTokens: 600 }],
      'claim-chart per-element retrieval (1 call)', args)) return;
    process.stderr.write('[claim-chart] no --targets: retrieving per element'
      + ' (the model is shown the CLAIM ONLY — no paths, no codebase identity)...\n');
    const disc = await retrievePerElement({
      draft, elements, symbols,
      opts: {
        includeTests: !!args.include_tests,
        onElement: ({ element, words, hits }) => process.stderr.write(
          `  element ${element}: words [${words.join(', ')}] -> ${hits.length} candidate(s)\n`),
      },
    });
    if (disc.error) { console.error(`--claim-chart: ${disc.error}`); process.exitCode = 1; return; }
    retrieval = disc.perElement;
    const budget = perElementTargetsWithStats(retrieval, args);
    targets = budget.targets;
    if (!targets.length) {
      console.error('Per-element retrieval found no candidate symbols in this index.'
        + ' Supply --targets to chart explicit ones.');
      process.exitCode = 1; return;
    }
    targetSource = 'per-element retrieval (no --targets supplied)';
    const covered = retrieval.filter((p) => (p.hits || []).length).length;
    targetProvenance = [
      `Retrieval: one model call predicted code vocabulary per element from the claim alone;`
      + ` CE then searched its own symbol table per element (rarity-ranked, no quorum).`,
      `Coverage: ${covered} of ${elements.length} element(s) produced at least one candidate.`,
      // ACHIEVED depth, never the requested one. The old line read "at most 3
      // per element" on every chart CE produced, including the ones that
      // reached depth 1 — a litigation artifact stating a retrieval depth it
      // did not perform.
      `Selection: round-robin by rank, ${targets.length} target(s) over`
      + ` ${elements.length} element(s) — depth ${budget.achievedDepth} achieved`
      + (budget.budgetLimited
        ? `. BUDGET-LIMITED: requested ${budget.requestedDepth},`
          + ` ${budget.wanted} target(s) wanted, ceiling ${budget.ceiling}.`
          + ` Raise --max-retrieved-targets to reach it.`
        : budget.candidatesExhausted
          ? ` of ${budget.requestedDepth} requested — the index offered no`
            + ` candidates deeper than this, so the budget was not the constraint.`
          : '.'),
    ];
  }
  if (args.targets_note) targetProvenance = [...targetProvenance, String(args.targets_note)];

  process.stderr.write(`[claim-chart] ${elements.length} element(s), ${targets.length} target(s), engine ${engineLabel}\n`);

  if (!claimsCostGate(model, targets.map(() => ({ inChars: 9000, outTokens: 900 })), 'claim-chart', args)) return;
  resetCloudUsage();

  const perTarget = [];
  const unresolved = [];
  const ambiguous = [];
  // Every reason a supplied target can fail to reach the chart. CE already
  // wrote all four to stderr; none of them reached the artifact, so a reader
  // saw only the survivors and had no way to know there had been others.
  const dropped = [];
  const partial = [];
  for (const t of targets) {
    // `file.java@Class::method` (what --claim-locate emits) or a bare qualified
    // `Class::method` — verifySymbol resolves either, and requiring the file
    // prefix would reject the form a user most naturally types.
    const at = t.indexOf('@');
    const fnSpec = at >= 0 ? t.slice(at + 1) : t;
    const v = verifySymbol(symbols, fnSpec);
    if (!isFound(v)) {
      process.stderr.write(`  NOT FOUND in index: ${t}\n`);
      unresolved.push(`\`${t}\` (no such symbol)`);
      dropped.push({ target: t, reason: 'not found in this index' });
      continue;
    }
    const m = v.matches[0];
    if (v.ambiguous > 1) {
      process.stderr.write(`  AMBIGUOUS: ${v.ambiguous} symbols match ${fnSpec} — using ${m.filepath.split('!').pop()}; qualify the target to choose\n`);
      ambiguous.push(`\`${t}\` (${v.ambiguous} matches)`);
    }
    let got = null;
    const _log = console.log; console.log = () => {};
    try { got = index.getFunctionSourceWithRange?.(m.filepath, m.name); } catch { got = null; } finally { console.log = _log; }
    const src = got?.source;
    if (!src) {
      process.stderr.write(`  source not retrievable: ${t}\n`);
      dropped.push({ target: t, reason: 'source not retrievable from the index' });
      continue;
    }

    const { text: calleeText, included } = args.no_callees === true
      ? { text: '', included: [] }
      : collectCalleeBodies(index, symbols, m, args);
    process.stderr.write(`  ${m.name}: ${included.length} callee body(ies)${included.length ? ' — ' + included.join(', ') : ''}\n`);

    // File-ABSOLUTE line numbers. Without this the model counts lines off raw
    // source and emits function-relative offsets: on the smoke run
    // updateSelectedTrack (file L436-485) drew citations like "L27", which
    // resolves to file line 462 and sends a verifier to unrelated code. Every
    // chart citation must survive `ce --extract file@fn`.
    //
    // The base is the range the SOURCE covers, not m.start. This invariant was
    // stated here and then broken by the base: getFunctionSource prepends the
    // doc comment, so numbering from m.start labelled the comment's first line
    // as the signature and shifted everything below it — median 6 lines, up to
    // 25, differently per function (#306). Two models cited the shifted numbers
    // faithfully and were blamed for it.
    const numFrom = got?.start ?? m.start;
    const numbered = numFrom != null ? addLineNumbers(String(src), numFrom) : String(src);
    const promptSrc = calleeText
      ? `${numbered}\n\n// ===== depth-1 callees, included so the analysis need not infer what they do =====\n${calleeText}`
      : numbered;
    const label = `${m.filepath.split('!').pop().split('/').pop()}@${m.name}`;
    let out;
    try { out = await draft(buildChartAnalysisPrompt(promptSrc, m.name, m.filepath, claimText, elements), '', 1100); }
    catch (e) {
      process.stderr.write(`  analysis failed for ${m.name}: ${e.message}\n`);
      dropped.push({ target: label, reason: `analysis failed — ${e.message}` });
      continue;
    }

    const verdicts = parseChartVerdicts(out || '', elements);
    // The same lexical gate the loop applies: a PRESENT whose element
    // vocabulary does not appear in the analysed source is downgraded, so a
    // confident label cannot outrun its evidence.
    const gated = verdicts.map((e) => ({ ...e, label: lexicalGate(e.label, e.text, `${m.name}\n${promptSrc}`) }));
    // Zero verdicts is a DROP, not an analysis. Pushing it to perTarget listed
    // it under "Analysed targets" while contributing nothing to any element —
    // which is how a 37-target chart came to report "of 30" with no explanation.
    if (!gated.length) {
      // A zero here means "the model said nothing" OR "we could not read what
      // it said", and those demand opposite responses from the reader. Reported
      // identically, the second masquerades as the first: Devstral's 73% loss
      // read as a model that produced no analysis. Count the non-empty lines it
      // did return — that number is the whole difference.
      const rawLines = String(out || '').split(/\r?\n/).filter((l) => l.trim()).length;
      const why = rawLines
        ? `PARSE-FAILED: ${rawLines} non-empty line(s) returned, none matched the VERDICT contract`
        : 'engine returned an empty response';
      process.stderr.write(`    0/${elements.length} element verdicts parsed  (${why})\n`);
      dropped.push({ target: label, reason: why });
      continue;
    }
    process.stderr.write(`    ${gated.length}/${elements.length} element verdict(s) parsed\n`);
    if (gated.length < elements.length) partial.push(`\`${label}\` (${gated.length}/${elements.length})`);
    perTarget.push({ target: label, elements: gated });
  }

  if (!perTarget.length) { console.error('No target produced a parseable analysis.'); process.exitCode = 1; return; }

  const fills = mergeBestPerElement(perTarget);
  const scopeNote = args.scope_note ? String(args.scope_note) : null;
  const provenance = buildProvenanceHeader({
    claimText,
    claimSource: (typeof spec === 'string' && spec.startsWith('@')) ? `\`${spec.slice(1)}\`` : null,
    indexPath: args.index_path || '(unknown)',
    indexFiles: index.files ? (index.files.size ?? index.files.length ?? null) : null,
    indexSymbols: symbols.length,
    engineLabel,
    // Read AFTER the analysis loop, so a GPU->CPU fallback mid-run is what
    // gets recorded rather than what was requested.
    engineBuild: engineBuildLine(),
    argv: process.argv.slice(1).join(' '),
    targets: perTarget.length,
    targetSource, targetProvenance, targetIntegrity,
    targetDuplicates, targetContainers,
    targetUnresolved: unresolved, targetAmbiguous: ambiguous,
    targetsSupplied: targets.length, targetsPartial: partial,
    ceVersion: readCeVersion(),
    generatedAt: new Date().toISOString(),
    elementsSource, elementComments,
  });
  console.log(formatChart({
    claimText, table, fills, elements, engineLabel, scopeNote, provenance,
    targets: perTarget.map((p) => p.target),
    dropped, retrieval,
  }));
  const cost = actualCostLine(model);
  if (cost) process.stderr.write(cost + '\n');
  return { fills, elements: elements.length, targets: perTarget.length };
}
