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
import { buildClaimAnalyzePrompt, addLineNumbers, readClaimFile, resolveClaimScope, splitNumberedClaims } from './analyze.js';
import { analyzeClaimSet, parentElementSynonyms } from '../core/dep-claims.js';
import { extractClientServer } from '../core/client-server.js';
import { contentWords, stem } from '../core/claim-terms.js';
import { isPseudoSource } from '../binstrings.js';
import { elementClasses, tallyByClass, classHeadline, claimGenericity } from '../core/claim-genericity.js';

// A target spec is `file@symbol`; the file half says whether the target is a
// binstrings `.op` dump. Labelled wherever a spec is printed so a reader never
// mistakes a string table for a function (op-pseudo-source-kind-gate).
const pseudoTag = (spec) => (isPseudoSource(String(spec || '').split('@')[0]) ? ' [pseudo-source]' : '');

// Shared reporter for dropped `#` provenance lines. Never silent: discarding
// input without saying so is how the next version of this bug hides.
const _noteComments = (n, f) => process.stderr.write(
  `  Claim file ${f}: ignored ${n} '#' comment line(s) (provenance, not claim text).\n`);
import { splitClaimElements, targetsChecksum, dedupeTargets, parseElementsFile, retrievePerElement, isPreambleRow, limitationTag, classifyLimitation, searchSymbolsByWords, contentCandidatesForWords, isTestSymbol, targetConnectivity, indexCallNeighbors, detectClaimSides } from './claim-locate.js';
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
  // chart-retrieval-whole-claim-arm: targets added from the claim's own words
  // on top of the per-element budget. 0 disables the arm.
  wholeClaimTargets: 5,
  // chart-retrieval-content-arm-and-budget: when two or more elements' top
  // candidates share a file that contributed no target, the file's best hit is
  // added (the bridged '101: three rows' hits concentrated in
  // AdaptiveTrackSelection.java at ranks the per-element budget never reaches).
  // 0 disables.
  concentrationTargets: 3,
  concentrationDepth: 10,  // how deep in each element's list concentration looks
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

// The one reduction that must agree in three places: SELECTION (which target
// specs get picked), the ANALYSIS LOOP (what a perTarget entry is keyed by),
// and the VERDICTS SIDECAR (what a replay joins nominations to). It had been
// written out separately in each; a fourth copy is how they start disagreeing,
// and a sidecar whose key silently diverged from selection's would produce a
// replay that looks right and joins nothing.
export function targetSpec(sym) {
  return `${String(sym?.filepath || '').split('!').pop().split('/').pop()}@${sym?.name}`;
}

// WHICH ELEMENT nominated each target, AT WHAT RANK -- the join the verdicts
// sidecar needs and could not previously express.
//
// Analysis order alone scores arrival-order and LABEL_RANK rules. It cannot
// score the rule RUN 9's evidence points at: prefer the target the element
// ITSELF ranked highest over one that arrived from another element's list.
// `LaunchActivity::onStart` took row 6 without element 6 nominating it at all,
// and nothing on disk recorded that.
//
// ONE ENTRY PER NOMINATOR. A target three elements wanted carries three rows.
// Collapsing them to a single number is a scoring choice, and this is the
// merge's INPUT -- it does not make scoring choices on the replay's behalf.
//
// Empty for a --targets run: nobody nominated those, they were handed to CE,
// and targetSource already records that. Empty is the true answer there, and is
// not the same as a missing field.
export function nominationIndex(retrieval) {
  const out = new Map();
  for (const pe of (Array.isArray(retrieval) ? retrieval : [])) {
    (pe.hits || []).forEach((h, rank) => {
      if (!h || !h.sym) return;
      const k = targetSpec(h.sym);
      if (!out.has(k)) out.set(k, []);
      // `arm` rides along so the renderers can tell the whole-claim arm from
      // concentration (both use element 0) without a second index.
      out.get(k).push({ element: pe.element ?? null, rank, ...(pe.arm ? { arm: pe.arm } : {}) });
    });
  }
  return out;
}

// chart-duplicate-surface-note: structural twins of cited implementations.
// zlib's loop slice scored twin-file hits as misses (ioapi/iowin32,
// inftrees/inftree9) while the chart said nothing about the twins. Cited
// PRESENT/PARTIAL functions are checked against the index's structural-
// duplicate groups; an out-of-file twin becomes a disclosure line and a
// sidecar record. Expert-relevant both ways: a reading on one copy
// presumptively reaches its twin, and the twin explains retrieval landing
// on either. Verdicts never change. `getDupes` injectable for tests.
// Boilerplate floor (asus-CC RUN16, 2026-09-02): 3-line getters form giant
// structural groups on Java corpora and flooded one cited file with eight
// twin lines (incl. getUri ~ getText). File-level pairs only come from
// groups of at least this many lines; the motivating zlib fill_* group (10
// lines) clears it, getter noise does not. Constants stated, no option.
export const TWIN_GROUP_MIN_LINES = 8;
const TWIN_PAIRS_PER_FILE = 2;

export function citedDuplicates(index, fills, { getDupes = null } = {}) {
  const cited = [...new Set(fills.filter((f) => f.target && (f.label === 'PRESENT' || f.label === 'PARTIAL')).map((f) => f.target))];
  if (!cited.length) return [];
  let groups;
  try {
    if (getDupes) groups = getDupes() || [];
    else {
      // getFuncDupes prints its progress to stdout, which is the CHART on a
      // redirected run -- asus-CC's RUN16 artifact opened with five lines of
      // hashing output. Silenced here (the analyseTargetForRows pattern); one
      // stderr line states the cost instead.
      const _log = console.log;
      console.log = () => {};
      try {
        index.getFuncDupes(1, 3, true);   // populates the structural groups
        groups = index.getStructDupes(10000) || [];
      } finally { console.log = _log; }
      process.stderr.write(`  struct-dupes: ${groups.length} structural group(s) consulted for twin notes`
        + ' (function-body hashing is one-time per index, then cached)\n');
    }
  } catch { return []; }
  const short = (fp) => String(fp).split('!').pop().split('/').pop();
  const out = [];
  const citedFiles = new Set();
  for (const spec of cited) {
    const file = short(String(spec).split('@')[0]);
    citedFiles.add(file);
    const bare = String(spec).split('@').pop().replace(/@\d+$/, '').split('::').pop();
    for (const g of groups) {
      const insts = g.instances || [];
      if (!insts.some((i) => short(i.filepath) === file && String(i.name).split('::').pop() === bare)) continue;
      const twins = [...new Set(insts.filter((i) => short(i.filepath) !== file).map((i) => `${short(i.filepath)}@${i.name}`))];
      if (twins.length) { out.push({ target: spec, twins: twins.slice(0, 4) }); break; }
    }
  }
  // FILE-level pass -- the draft's own example ("cited inftrees.c has a
  // structural near-duplicate at inftree9.c") is file-level, and the first
  // zlib re-render showed why function-level alone under-fires: claim 7
  // cited win32_open64_file_funcA while the cross-file group held the
  // fill_* siblings. A cited FILE that shares any structural group with
  // another file gets one line naming the pair and an example.
  const seenPair = new Set();
  const perFile = new Map();
  for (const file of citedFiles) {
    for (const g of groups) {
      if ((g.lines || 0) < TWIN_GROUP_MIN_LINES) continue;   // boilerplate floor
      const insts = g.instances || [];
      const inFile = insts.filter((i) => short(i.filepath) === file);
      if (!inFile.length) continue;
      for (const twin of [...new Set(insts.filter((i) => short(i.filepath) !== file).map((i) => short(i.filepath)))]) {
        const key = [file, twin].sort().join('~');
        if (seenPair.has(key) || (perFile.get(file) || 0) >= TWIN_PAIRS_PER_FILE || out.length >= 8) continue;
        seenPair.add(key);
        perFile.set(file, (perFile.get(file) || 0) + 1);
        const other = insts.find((i) => short(i.filepath) === twin);
        out.push({ file, twinFile: twin, example: `${inFile[0].name} ~ ${other.name}` });
      }
    }
  }
  return out;
}

// chart-qualifier-check (v1, mechanical, report-only): the limitation words
// a careful reader would check the citation for. Andrew's motivating case:
// "resolving a CLOUD provider" PRESENT on resolveProvider -- dead on for
// resolve/provider/identifier, silent on whether "cloud" is shown or
// assumed. Words are matched by stem against the finding text; a synonym in
// the citation still counts as not shown, which is DISCLOSED on the
// artifact -- this is a reading prompt, never a verdict.
export function unshownQualifiers(elementText, noteText, { genreFilter = true } = {}) {
  const noteStems = new Set(contentWords(String(noteText || '')).map(stem));
  // The registered fire-rate check tripped its named contingency (46/49 rows
  // fired unfiltered -- a one-sentence finding cannot restate a 15-word
  // limitation), so the pool is the element's claim-genre RARE words
  // (claimGenericity's existing classification, nothing new tuned): the
  // distinctive words a reader would actually check for, with genre-common
  // boilerplate (receiving/system/device...) excluded. A generic I/O row has
  // no rare words and never fires.
  let pool = contentWords(String(elementText || ''));
  if (genreFilter) {
    try {
      const g = claimGenericity(String(elementText || ''));
      if (g && g.kind !== 'unscored' && Array.isArray(g.rareWords)) {
        const rare = new Set(g.rareWords);
        pool = pool.filter((w) => rare.has(w));
      }
    } catch { /* unfiltered fallback */ }
  }
  const out = [];
  const seen = new Set();
  for (const w of pool) {
    const s = stem(w);
    if (noteStems.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(w);
  }
  return out;
}

// chart-client-server-scope: the index-side fact for a two-sided claim.
// CE already knows it deterministically (--client-server); the chart states
// it instead of leaving ABSENT rows ambiguous between "not in this code" and
// "this code is the other half of the system". `extract` injectable for tests.
export function clientServerVerdict(index, { extract = extractClientServer } = {}) {
  const { sockets = [], stats = {} } = extract(index) || {};
  const socketClient = sockets.filter((e) => e && e.role === 'client').length;
  const socketServer = sockets.filter((e) => e && e.role === 'server').length;
  const counts = {
    serverRoutes: stats.serverCount || 0,
    clientCalls: stats.clientCount || 0,
    socketClient, socketServer,
  };
  const hasServer = counts.serverRoutes > 0 || socketServer > 0;
  const hasClient = counts.clientCalls > 0 || socketClient > 0;
  const verdict = hasServer && hasClient ? 'both' : hasServer ? 'server-only' : hasClient ? 'client-only' : 'undetermined';
  return { ...counts, verdict };
}

// chart-within-file-drilldown: mechanized arm-B. Concentration proves that a
// FILE matters (2+ elements' candidates share it); this arm finishes the job
// per element: re-run the CONTENT search scoped to that file with the
// element's own predicted words, and the top in-file function not already a
// target joins the analysis set. The manual proof (8752101_armB_chart_*,
// $0.42) did exactly this by hand and landed updateSelectedTrack. Bounds are
// FIXED here, not options -- the --concentration-targets-6 episode is the
// option-archaeology this exists to remove. Byte-identical charts when
// concentration found nothing.
export const DRILLDOWN_PER_ELEMENT = 1;
export const DRILLDOWN_PER_CHART = 3;
export function drilldownTargets({ index, retrieval, targets, includeOp = false, includeTests = false, contentSearch = contentCandidatesForWords }) {
  if (!index || !Array.isArray(retrieval)) return { added: [] };
  // Candidate files are derived HERE, not taken from concentration's rescue
  // list. Concentration only names files that contributed NO selected target,
  // and the registered '101 check showed that precondition excludes exactly
  // the half-represented file: AdaptiveTrackSelection contributed
  // determineIdealSelectedIndex via one element, so the file was never
  // drilled and row 6's updateSelectedTrack stayed unexamined. Any file
  // where 2+ elements' candidates land in the window qualifies, whether or
  // not it already contributed a target -- dedup against existing targets
  // keeps re-nomination out. Same window shape as concentration (top
  // concentrationDepth plus every content/both hit).
  const fileOf = (s) => String((s && s.filepath) || '');
  const byFile = new Map();
  for (const p of retrieval) {
    if (!p || p.arm === 'drilldown' || !p.element) continue;
    const window = (p.hits || []).slice(0, CHART_DEFAULTS.concentrationDepth);
    for (const h of p.hits || []) if (h && (h.arm === 'content' || h.arm === 'both') && !window.includes(h)) window.push(h);
    window.forEach((h, rank) => {
      if (!h || !h.sym) return;
      const f = fileOf(h.sym);
      if (!f) return;
      const e = byFile.get(f) || byFile.set(f, { els: new Set(), content: false, bestRank: Infinity }).get(f);
      e.els.add(p.element);
      if (h.arm === 'content' || h.arm === 'both') e.content = true;
      if (rank < e.bestRank) e.bestRank = rank;
    });
  }
  const files = [...byFile.entries()].filter(([, e]) => e.els.size >= 2)
    .sort((a, b) => (b[1].els.size - a[1].els.size)
      || ((b[1].content ? 1 : 0) - (a[1].content ? 1 : 0))
      || (a[1].bestRank - b[1].bestRank))
    .map(([file, e]) => ({ file, elements: [...e.els].sort((x, y) => x - y) }));
  if (!files.length) return { added: [] };
  const have = new Set(targets);
  const perElement = new Map();
  const added = [];
  // ROUND-ROBIN across files: every file gets one drill before any file gets
  // a second -- the same principle perElementTargetsWithStats states for
  // elements ("taking the first N in order spends the whole budget on the
  // first few"). Measured on the '101 (drill2): MediaCodecRenderer, a
  // sponge-sized file in three elements' windows, consumed the whole
  // per-chart budget while AdaptiveTrackSelection sat at file rank 2 and
  // row 6's crux stayed unexamined.
  const maxEls = Math.max(...files.map((c) => (c.elements || []).length));
  outer:
  for (let round = 0; round < maxEls; round++) {
    for (const c of files) {
      if (added.length >= DRILLDOWN_PER_CHART) break outer;
      const el = (c.elements || [])[round];
      if (el == null) continue;
      if ((perElement.get(el) || 0) >= DRILLDOWN_PER_ELEMENT) continue;
      const p = retrieval.find((x) => x.element === el && x.arm !== 'drilldown');
      if (!p || !(p.words || []).length) continue;
      let chosen = null;
      for (const cand of contentSearch(index, p.words, { limit: 5, includePath: [String(c.file)], includeOp, includeTests })) {
        const s = targetSpec({ name: cand.name, filepath: cand.filepath });
        if (have.has(s)) continue;
        chosen = { spec: s, sym: { name: cand.name, filepath: cand.filepath } };
        break;
      }
      if (!chosen) continue;
      have.add(chosen.spec);
      perElement.set(el, (perElement.get(el) || 0) + 1);
      added.push({ element: el, file: c.file, spec: chosen.spec, sym: chosen.sym });
    }
  }
  return { added };
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
      const s = targetSpec(h.sym);
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

  // chart-retrieval-content-arm-and-budget: FILE CONCENTRATION. Several
  // elements pointing at one file is a signal the per-element round-robin
  // cannot see: each element's slice of that file can sit below its own depth
  // cut while the file is the strongest cross-element candidate on the board
  // (the bridged '101: three rows' hits in AdaptiveTrackSelection.java at
  // ranks 4/5/9, none selected). When two or more elements have a hit in the
  // top concentrationDepth of their lists in a file that contributed no
  // selected target, the file's best-ranked hit is added ON TOP of the
  // budget, bounded by concentration_targets and attributed as its own arm.
  const concentration = [];
  const cMax = opts.concentration_targets == null
    ? CHART_DEFAULTS.concentrationTargets
    : Math.max(0, Number(opts.concentration_targets) || 0);
  if (cMax > 0) {
    const fileOf = (s) => String((s && s.filepath) || '');
    const selFiles = new Set();
    for (const p of elements) for (const h of p.hits || []) if (h && h.sym && seen.has(targetSpec(h.sym))) selFiles.add(fileOf(h.sym));
    const byFile = new Map();
    for (const p of elements) {
      // The window is the top of the element's list PLUS every content-arm
      // hit: content hits sit behind the whole name list (splice policy, one
      // promoted), so a depth window alone would never see them -- and the
      // motivating case (AdaptiveTrackSelection on the bridged '101) is
      // reachable ONLY through content hits, at gated ranks the window misses.
      const window = (p.hits || []).slice(0, CHART_DEFAULTS.concentrationDepth);
      // 'both' = found by name AND corroborated by content -- the strongest
      // per-candidate signal there is, and often parked at a name rank the
      // depth window misses (AdaptiveTrackSelection on the bridged '101).
      for (const h of p.hits || []) if (h && (h.arm === 'content' || h.arm === 'both') && !window.includes(h)) window.push(h);
      window.forEach((h, rank) => {
        if (!h || !h.sym) return;
        const f = fileOf(h.sym);
        if (!f || selFiles.has(f)) return;
        const e = byFile.get(f) || byFile.set(f, { els: new Set(), best: null, content: false }).get(f);
        e.els.add(p.element);
        if (h.arm === 'content' || h.arm === 'both') e.content = true;
        if (!e.best || rank < e.best.rank) e.best = { hit: h, rank };
      });
    }
    // Within an element count, a file reached through the CONTENT arm outranks
    // one reached only by names: the body doing the work with no name match is
    // the case concentration exists for, and a name-rank comparison would bury
    // it behind whatever long name matched the most words.
    const cands = [...byFile.entries()].filter(([, e]) => e.els.size >= 2)
      .sort((a, b) => (b[1].els.size - a[1].els.size)
        || ((b[1].content ? 1 : 0) - (a[1].content ? 1 : 0))
        || (a[1].best.rank - b[1].best.rank));
    for (const [file, e] of cands) {
      if (concentration.length >= cMax) break;
      const s = targetSpec(e.best.hit.sym);
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      concentration.push({ file, target: s, elements: [...e.els].sort((x, y) => x - y), hit: e.best.hit });
    }
  }

  return {
    targets: out,
    requestedDepth: perEl,
    achievedDepth,
    total,
    ceiling,
    wanted,
    budgetLimited,
    candidatesExhausted: !budgetLimited && deepest < perEl,
    concentration,
  };
}

// Rows come from the CLAIM, not from the model — one row per element, in claim
// order, so every engine's chart lines up row-for-row.
export function buildChartTable(claimText, opts = {}) {
  // A supplied list (--elements @file) wins over the heuristic split: no regex
  // reaches a practitioner's construction of a claim.
  const elements = (opts.elements && opts.elements.length)
    ? opts.elements
    : splitClaimElements(claimText, { fine: opts.granularity !== 'coarse' });
  // The header is where a reader forms their interpretation of the column, and
  // "CE finding" invited the wrong one. The verdict answers whether the
  // LIMITATION is met, not whether the recited feature appears — the same word
  // on a negative limitation would otherwise read backwards.
  const lines = ['| # | Claim element | CE finding — is the limitation met? | Cited code |', '|---|---|---|---|'];
  const classes = elementClasses(elements, { isPreambleRow });
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
    //
    // claim-chart-element-classes (2026-08-28): every other row is tagged
    // generic or mechanism too. On 25 charts every PRESENT on a
    // vocabulary-selected pair was a bookend ("receiving an input ...",
    // "outputting the identified documents"); the tag lets a reader see which
    // rows a PRESENT could mean anything on. Deterministic (claim-genericity.js),
    // and NOT shown to the model -- the prompt rows carry only limitationTag.
    const tag = ` _[${classes[i]}]_`;
    // chart-client-server-scope: rows the claim attributes to the OTHER party
    // of a two-sided claim are tagged beside their class. The tag explains,
    // it never excuses -- verdicts are unchanged.
    const side = opts.sideTags && opts.sideTags[i] ? ' _[other side]_' : '';
    lines.push(`| ${i + 1} | ${String(e).replace(/\|/g, '\\|')}${tag}${side} |  |  |`);
  });
  return { table: lines.join('\n'), elements, classes };
}

// Parse `--targets "file.java@Class::fn;other.java@fn"` or `@targets.txt`.
// Match a supplied file hint against an index path by SUFFIX, not equality.
// Users supply both `AdaptiveTrackSelection.java` and
// `trackselection/AdaptiveTrackSelection.java` and both must work, and index
// paths carry a `!`-prefixed archive segment that is not part of what anyone
// types. Boundary-anchored so `Helper.java` cannot match `DownloadHelper.java`.
export function filterMatchesByFile(matches, fileHint) {
  const hint = String(fileHint || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!hint) return matches;
  const lower = hint.toLowerCase();
  return (matches || []).filter((m) => {
    const p = String(m.filepath || '').split('!').pop().replace(/\\/g, '/').toLowerCase();
    return p === lower || p.endsWith(`/${lower}`);
  });
}

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
  // Element attribution, in file order. Empty for a file that carries none.
  const elementMap = [];
  let curEl = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const body = t.replace(/^#+\s*/, '');
      const m = /^Targets-checksum:\s*([0-9a-f]+)$/i.exec(body);
      if (m) { claimed = m[1].toLowerCase(); continue; }
      // Per-element attribution written by --targets-out. Recognised here so a
      // chart fed a locate file renders the same `Retrieval by element` table
      // it renders when it retrieved for itself — the table that distinguishes
      // "examined and found nothing" from "had nothing to examine".
      //
      // Anything unrecognised keeps flowing to provenance exactly as before, so
      // an older file, or a hand-written one, parses unchanged.
      const el = /^Element\s+(\d+):\s*(.*)$/i.exec(body);
      if (el) {
        curEl = { element: Number(el[1]), text: el[2], words: [], candidates: 0 };
        elementMap.push(curEl);
        continue;
      }
      if (/^Element:\s*unattributed/i.test(body)) { curEl = null; provenance.push(body); continue; }
      const w = /^Element-words:\s*(.*)$/i.exec(body);
      if (w && curEl) { curEl.words = w[1].split(',').map((s) => s.trim()).filter(Boolean); continue; }
      const c = /^Element-candidates:\s*(\d+)$/i.exec(body);
      if (c && curEl) { curEl.candidates = Number(c[1]); continue; }
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
  // Shaped exactly like retrievePerElement's output, so the existing
  // `Retrieval by element` renderer consumes it without knowing which path
  // produced it. `hits` is a length-only stand-in: the file records how many
  // candidates an element had, which is what that table reports.
  const retrieval = elementMap.length
    ? elementMap.map((e) => ({ element: e.element, text: e.text, words: e.words,
      hits: new Array(e.candidates).fill(null) }))
    : null;
  return { targets: unique, provenance, source, integrity, duplicates, containers, retrieval };
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
export function buildChartAnalysisPrompt(src, fnName, filepath, claimText, elements, { depNotes = null } = {}) {
  const base = buildClaimAnalyzePrompt(src, fnName, filepath, claimText, false);
  // The tag travels with the element, so the model judges the right question.
  // Deterministic regex, not a model construing a claim — see classifyLimitation.
  // depNotes (dep-claims-broaden-parent) adds the disclosed claim-
  // differentiation line to the rows dependents narrow -- visible to the
  // model AND to anyone reading the saved prompt, never an invisible rule.
  const rows = elements.map((e, i) => {
    const tag = limitationTag(e);
    const note = depNotes && depNotes.get(i);
    return `ELEMENT ${i + 1}: ${String(e).slice(0, 150)}${tag ? `\n  ${tag}` : ''}${note ? `\n  NOTE: ${note}` : ''}`;
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
//
// chart-cite-nearest-miss (2026-08-29): on a TIE the citation goes to the
// target the row's OWN element nominated highest, then to any target the
// element nominated, then -- only as the last resort -- to the first analysed
// (the old rule, kept so charts without retrieval attribution are unchanged).
// On the '101 family chart every ABSENT row tied and four of six cited
// AdTagLoader::sendContentComplete, the first target analysed (an ad-event
// callback), while the one AdaptiveTrackSelection method examined carried the
// sentence the reader wanted ("switch order is based on log bitrate
// differences only, not on remaining time") and never reached the chart. An
// ABSENT citation is the CLOSEST CANDIDATE EXAMINED, not a finding, and the
// fill says so (`closest: true`) so the renderers label it that way.
export function mergeBestPerElement(perTarget, { nominators = null } = {}) {
  const best = new Map();
  // Best rank at which `element` nominated `target`; Infinity when it did not.
  const nomRank = (target, element) => {
    if (!nominators || element == null) return Infinity;
    const list = nominators.get(target) || [];
    let r = Infinity;
    for (const n of list) if (n.element === element && n.rank < r) r = n.rank;
    return r;
  };
  // How many rows each target is PRESENT on -- the "implementer" signal the
  // non-ABSENT tie-break uses. Computed up front so ties are order-independent.
  const presentCount = new Map();
  for (const { target, elements } of perTarget) {
    for (const e of elements) if (e.label === 'PRESENT') presentCount.set(target, (presentCount.get(target) || 0) + 1);
  }
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
      const mine = LABEL_RANK[e.label] ?? 0;
      const theirs = prev ? (LABEL_RANK[prev.label] ?? 0) : -1;
      // Strictly better label wins. Ties split by label
      // (chart-retrieval-content-arm-and-budget, from Andrew's claim-69 row 3
      // and the positive control's row 6): an ABSENT tie cites the row's own
      // nominee -- the nearest miss; a non-ABSENT tie cites the target that is
      // PRESENT on the MOST rows of the claim -- the implementer, not a
      // namesake or a caller that happens to top the row's retrieval. Then the
      // row's nominee, then analysis order.
      let takes = !prev || mine > theirs;
      if (!takes && mine === theirs) {
        if (e.label === 'ABSENT') {
          takes = nomRank(target, e.element) < nomRank(prev.target, e.element);
        } else {
          const pc = (t) => presentCount.get(t) || 0;
          takes = pc(target) > pc(prev.target)
            || (pc(target) === pc(prev.target) && nomRank(target, e.element) < nomRank(prev.target, e.element));
        }
      }
      if (takes) {
        best.set(key, { element: e.element, text: e.text, label: e.label, target, note: e.note || '' });
      }
    }
  }
  for (const [key, v] of best) {
    v.agreement = tally.get(key) || null;
    v.closest = v.label === 'ABSENT';
  }
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
    // An ABSENT row's citation is the closest candidate examined, not a
    // finding, and says so (chart-cite-nearest-miss).
    const cite = f.target
      ? `${f.closest ? 'closest examined: ' : ''}\`${f.target}\`${pseudoTag(f.target)}`
      : '—';
    const noteBase = f.note ? ` ${String(f.note).replace(/\|/g, '\\|').slice(0, 160)}` : '';
    const note = noteBase + (f.unshown && f.unshown.length
      ? ` _(not shown in citation: ${f.unshown.slice(0, 6).join(', ')}${f.unshown.length > 6 ? ', …' : ''})_`
      : '');
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

  // Part D: the headline reports how well-supported its own counts are.
  //
  // The merge is strongest-wins, so ONE target saying PARTIAL takes a row that
  // twenty-two called ABSENT. fillChartRows above already renders that ratio
  // per row, and this line was throwing all of it away -- "4 PARTIAL" and "4
  // PARTIAL, every one a lone dissenter of 23" are different documents, and
  // only the second lets a reader judge the first.
  //
  // REPORT, do not enforce. A quorum rule is the obvious alternative and is
  // wrong: measured across three engines on the same claim and corpus, no
  // threshold is correct for all of them. Gemma3-12B emits no PRESENT at all,
  // so a rule changes nothing; Gemini's lone dissenters were mostly WRONG, so a
  // rule would help; Qwen3-14B's were mostly RIGHT, so a rule takes it 8/10 ->
  // 6/10. Any threshold tunes the chart to whichever model happened to be
  // tested. Suppressing a lone finding would also defeat the reason
  // strongest-wins exists: one function implementing an element IS infringement
  // of that element. CE states the support; the reader picks the threshold.
  //
  // ABSENT rows are excluded because near-unanimity there is the norm and
  // carries no signal -- a chart of unanimous ABSENTs would otherwise report
  // perfect support and mean nothing by it.
  const c = { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 };
  let preLabel = null, cited = 0, closestCited = 0;
  let assessed = 0, lone = 0, unassessed = 0, weakest = null;
  fills.forEach((f, i) => {
    if (isPre(f, i)) { preLabel = f.label; return; }
    cited++;
    if (c[f.label] != null) c[f.label] += 1;
    if (f.label === 'ABSENT') { if (f.target) closestCited++; return; }
    const a = f.agreement;
    // No tally means this row's support CANNOT be computed. Counted separately
    // and disclosed rather than folded into either side of the ratio: silently
    // shrinking the denominator would report a support figure over a set the
    // reader thinks is every non-ABSENT row.
    if (!a || !(a.total > 0)) { unassessed++; return; }
    const mine = a[f.label] || 0;
    assessed++;
    if (mine <= 1) lone++;
    if (!weakest || mine < weakest.mine) weakest = { mine, total: a.total };
  });
  let support = '';
  if (assessed > 0) {
    support = ` **Support: ${lone} of ${assessed} non-ABSENT row(s) rest on a single`
      + ` target; weakest ${weakest.mine} of ${weakest.total}.**`;
    if (unassessed > 0) support += ` _(${unassessed} further non-ABSENT row(s) carried no agreement data.)_`;
  } else if (unassessed > 0) {
    support = ` _(Support not computed: ${unassessed} non-ABSENT row(s) carried no agreement data.)_`;
  }
  const nLimitations = preIdx >= 0 ? Math.max(0, nElements - 1) : nElements;
  const noFinding = Math.max(0, nLimitations - cited);
  // claim-chart-element-classes: the same verdicts, tallied by what kind of row
  // they landed on. "2 PRESENT" on the all-rows line and "generic 3: 2 PRESENT;
  // mechanism 4: 0 PRESENT" are different documents, and 25 charts on
  // 2026-08-27 were the first kind while reading as the second.
  let byClass = '';
  if (Array.isArray(elements) && elements.length) {
    const classes = elementClasses(elements, { isPreambleRow });
    const byEl = new Map();
    fills.forEach((f, i) => { byEl.set(f.element != null ? f.element - 1 : i, f.label); });
    const rows = elements.map((_, i) => ({ elementClass: classes[i], verdict: byEl.get(i) || null }));
    byClass = `\n**By element class:** ${classHeadline(tallyByClass(rows))}.`;
  }
  return `**Coverage:** ${c.PRESENT} PRESENT · ${c.PARTIAL} PARTIAL · ${c.ASSUMED} ASSUMED · `
    + `${c.ABSENT} ABSENT · ${noFinding} element(s) with no finding`
    + `${preIdx >= 0 ? ` across ${nLimitations} limitation(s); preamble ${preLabel || 'no finding'}` : ''}.`
    + support
    + (closestCited ? ` _(${closestCited} ABSENT row(s) cite the closest candidate examined, not a finding.)_` : '')
    + byClass;
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
  dropped, retrieval, connectivity, sideScope, otherSideElements, citedDupes,
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
  if (scopeNote || sideScope) {
    out.push('## Scope'); out.push('');
    if (scopeNote) { out.push(scopeNote); out.push(''); }
    if (sideScope) { out.push(sideScope); out.push(''); }
  }
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
  // chart-qualifier-check: disclose the check's bluntness once, when it fires.
  if ((fills || []).some((f) => f.unshown && f.unshown.length)) {
    out.push('_Some rows note "not shown in citation": limitation words with no lexical match in the');
    out.push('cited finding. A synonym in the citation still counts as not shown — a reading prompt,');
    out.push('not a verdict._');
    out.push('');
  }
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
  {
    let cov = coverageLine(fills, elements.length, elements);
    // chart-client-server-scope: how much of the ABSENT count is the other
    // party's -- counted apart, never excused.
    if (otherSideElements && otherSideElements.size) {
      const osAbsent = fills.filter((f) => f.label === 'ABSENT' && f.element != null && otherSideElements.has(f.element)).length;
      if (osAbsent) cov += ` _(${osAbsent} of the ABSENT row(s) are other-side rows)_`;
    }
    out.push(cov);
  }
  out.push('');
  // claim-chart-scattered-targets: does the chart show the claimed
  // COMBINATION, or unrelated capabilities? A litigator reads this shape on
  // sight; a chart that does not name it invites the reader to add rows up.
  if (connectivity) {
    if (connectivity.groups.length <= 1) {
      out.push('_Cited PRESENT/PARTIAL targets form one connected group (call paths within '
        + `${connectivity.depth} hops, or same file)._`);
    } else {
      out.push(`**PRESENT/PARTIAL verdicts rest on ${connectivity.targets} target(s) in `
        + `${connectivity.groups.length} unconnected groups (no call path within ${connectivity.depth} hops): `
        + connectivity.groups.map((g) => g.map((s) => `\`${s}\``).join(', ')).join(' | ')
        + ' — the combination of these elements is not shown.**');
    }
    out.push('');
  }
  // chart-duplicate-surface-note: twin implementations of cited code.
  if (citedDupes && citedDupes.length) {
    for (const d of citedDupes) {
      if (d.target) {
        out.push(`_Cited \`${d.target}\` has structural near-duplicate(s) at ${d.twins.map((t) => `\`${t}\``).join(', ')}`
          + ' (--struct-dupes) — a reading on one copy presumptively reaches its twin._');
      } else {
        out.push(`_Cited \`${d.file}\` shares structural near-duplicates with \`${d.twinFile}\``
          + ` (e.g. \`${d.example}\`; --struct-dupes) — a reading on one copy presumptively reaches its twin._`);
      }
    }
    out.push('');
  }
  out.push('## Analysed targets');
  out.push('');
  // A target only the whole-claim arm nominated says so: which arm found the
  // code is part of the evidence (chart-retrieval-whole-claim-arm).
  const noms = nominationIndex(retrieval);
  const armMark = (t) => {
    const n = noms.get(t) || [];
    if (n.length && n.every((x) => x.arm === 'drilldown')) return ' _(drilldown)_';
    if (!n.length || !n.every((x) => x.element === 0)) return '';
    return n.every((x) => x.arm === 'concentration') ? ' _(concentration)_' : ' _(whole-claim arm)_';
  };
  for (const t of targets) out.push(`- \`${t}\`${pseudoTag(t)}${armMark(t)}`);
  out.push('');
  // PER-ELEMENT RETRIEVAL PROVENANCE. Without it an ABSENT row is ambiguous:
  // "CE examined this element and found nothing" and "CE had nothing to examine"
  // render identically, and only the first is defensible in front of a client.
  if (retrieval && retrieval.length) {
    const perElementOnly = retrieval.filter((p) => p.element !== 0);
    const blind = perElementOnly.filter((p) => !(p.hits || []).length);
    out.push('## Retrieval by element');
    out.push('');
    out.push('Each element was searched with its OWN predicted vocabulary, ranked by term'
      + ' rarity, with no quorum. An element with 0 candidates was never examined — that'
      + ' row reports what CE could not look at, not a finding about the code.');
    out.push('');
    // The ARM column, because a candidate found only by CONTENT search is a
    // different kind of evidence from one whose NAME matches. A reader deciding
    // whether to trust a citation should see which search surfaced it.
    const anyContent = retrieval.some((p) => p.contentAdded);
    out.push(`| element | predicted words | candidates |${anyContent ? ' via content |' : ''}`);
    out.push(`|---|---|---|${anyContent ? '---|' : ''}`);
    for (const p of retrieval) {
      // Element 0 entries are the extra arms: the whole-claim arm (the
      // claim's own words) and concentration (a file 2+ elements point at).
      const label = p.arm === 'drilldown' ? `${p.element} (drilldown)`
        : p.arm === 'concentration' ? 'concentration' : p.element === 0 ? 'whole claim' : p.element;
      const depMark = p.depFrom && p.depFrom.length ? ` _(+dep ${p.depFrom.join(', ')})_` : '';
      const wordsCell = p.arm === 'drilldown'
        ? `_scoped to ${String(p.file || '').split('/').pop().split('!').pop()}_`
        : `${(p.words || []).map((w) => (p.wordRuns && p.wordRuns.single && p.wordRuns.single.includes(w) ? `${w}?` : w)).join(', ').replace(/\|/g, '\\|')}${depMark}`;
      out.push(`| ${label} | ${wordsCell} `
        + `| ${(p.hits || []).length} |${anyContent ? ` ${p.contentAdded || 0} |` : ''}`);
    }
    if (anyContent) {
      out.push('');
      out.push('_Name search matches SYMBOL NAMES; content search matches the code itself.'
        + ' A candidate reached only by content search has a name that says nothing about'
        + ' the limitation — which is the case name search cannot reach at any depth._');
    }
    out.push('');
    if (blind.length) {
      out.push(`⚠ ${blind.length} of ${perElementOnly.length} element(s) produced no candidate: `
        + `${blind.map((p) => p.element).join(', ')}. Those rows were not examined.`);
      out.push('');
    }
    // What the pseudo-source gate held back (op-pseudo-source-kind-gate). A
    // binstrings `.op` dump is a string table, not a function; it is indexed
    // and searchable, but not nominated as a target unless --include-op.
    const hb = retrieval.heldBack;
    if (hb && (hb.symbols || hb.content)) {
      out.push(`${hb.symbols} pseudo-source (.op) symbol(s)`
        + `${hb.content ? ` and ${hb.content} content-search match(es)` : ''}`
        + ' were held back from nomination — CE-generated string-dumps of binaries,'
        + ' indexed and searchable but not functions. `--include-op` admits them.');
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

// ============================================================================
// Dependent claims (issue-311-dep-claim-chart)
// ============================================================================
//
// A claims file usually carries more than claim 1, and until this landed the
// chart read the whole file as ONE claim: every dependent's text collapsed
// into claim 1's rows. Scope is now resolved the way --claim-analyze resolves
// it (20f0756): the first claim by default, `--claim-number <n>` to pick one
// (a dependent charts its chain), `--claim-family` to chart claim 1 and every
// dependent that resolves to it.
//
// WHAT A DEPENDENT'S CHART IS. Its rows are its parent's rows plus what it
// contributes (1c71015's kinds): an ADDITION appends a row; a MODIFICATION
// narrows one inherited row, which is re-evaluated against the dependent's
// language and may come back with a different verdict on the same code --
// that is the point of a dependent as a graded test (#311). Inherited rows
// are rendered as one-line references carrying the parent's verdict; they
// are not re-judged, so a family costs claim 1 plus the deltas, not N charts.
// UNDETERMINED contributions are judged as their own row and the ambiguity
// is stated; cross-class kinds (PRODUCT-BY-PROCESS, COMBINATION) inherit the
// referenced claim's rows with their kind named.

const ROW_LETTERS = 'abcdefghijklmnopqrstuvwxyz';
export const rowDesignation = (n, i) => `[${n}${i < ROW_LETTERS.length ? ROW_LETTERS[i] : `r${i + 1}`}]`;

/** A dependent's contribution: the text after its "... of claim N" reference. */
export function dependentBody(text) {
  const s = String(text || '').trim();
  const m = s.match(/\bclai?ms?\s+(?:of\s+|in\s+)?(?:any\s+(?:one\s+)?of\s+)?[0-9]+(?:\s*(?:to|through|-|–|or|and)\s*[0-9]+)*\s*,?\s*/i);
  if (!m) return s;
  return s.slice(m.index + m[0].length).replace(/^[\s,;:]+/, '').trim() || s;
}

const stemsOf = (t) => new Set(contentWords(t).map(stem));

/** The parent row a narrowing most plausibly narrows: best content-stem overlap, ties to the earlier row. */
export function narrowedRowFor(ownText, parentRows) {
  const own = stemsOf(ownText);
  let best = null;
  for (const row of parentRows || []) {
    let shared = 0;
    for (const s of stemsOf(row.text)) if (own.has(s)) shared++;
    if (shared > 0 && (!best || shared > best.shared)) best = { row, shared };
  }
  return best;
}

/**
 * Resolve what to chart from the claim text: `{ text, note, family }`.
 * `family` is null unless `--claim-family`; then `{ root, rootText, members }`
 * with members in chart order (depth, then number), each carrying the
 * dep-claims row (n, text, parent, chain, depthLabel, contribution, parentChoice).
 */
export function chartScope(claimText, { claim = null, family = false } = {}) {
  const parts = splitNumberedClaims(claimText).filter((p) => p.n != null);
  if (parts.length < 2) {
    if (claim != null && parts.length === 1 && Number(claim) !== parts[0].n) {
      throw new Error(`claim ${claim} is not in the input (only claim ${parts[0].n} is present)`);
    }
    return { text: String(claimText || '').trim(), note: null, family: null };
  }
  if (!family) {
    const s = resolveClaimScope(claimText, { claim });
    return { text: s.text, note: s.note, family: null };
  }
  const res = analyzeClaimSet(parts.map((p) => ({ n: p.n, text: `${p.n}. ${p.text}` })));
  const rootN = claim != null ? Number(claim) : parts[0].n;
  const root = res.byNumber.get(rootN);
  if (!root) throw new Error(`claim ${rootN} is not in the input (claims present: ${parts.map((p) => p.n).join(', ')})`);
  if (root.dependent) throw new Error(`--claim-family needs an independent claim as its root; claim ${rootN} depends on claim ${root.parent ?? '?'} -- chart it with --claim-number ${rootN} instead`);
  const textOf = (k) => (parts.find((p) => p.n === k) || { text: '' }).text;
  const members = res.claims
    .filter((r) => r.dependent && r.n !== rootN && Array.isArray(r.chain) && r.chain.includes(rootN))
    .sort((a, b) => (a.depth - b.depth) || (a.n - b.n))
    .map((r) => ({ n: r.n, text: textOf(r.n), parent: r.parent, chain: r.chain, depth: r.depth, depthLabel: r.depthLabel,
      contribution: r.contribution, parentChoice: r.parentChoice, rule: r.rule }));
  const unresolved = res.claims.filter((r) => r.dependent && (r.parent == null || !r.chain));
  const other = res.claims.filter((r) => !r.dependent && r.n !== rootN);
  const note = [`family of claim ${rootN}: ${members.length} dependent claim(s) charted beneath it`];
  if (unresolved.length) note.push(`${unresolved.length} dependent claim(s) not charted, parent unresolved: ${unresolved.map((r) => r.n).join(', ')}`);
  if (other.length) note.push(`${other.length} other independent claim(s) in the input not charted: ${other.map((r) => r.n).join(', ')}`);
  // Numbered like the single-claim path (resolveClaimScope keeps "1. ..."), so
  // the Claim block reads the same whichever way the chart was scoped.
  return { text: `${rootN}. ${textOf(rootN)}`, note: note.join('; '), family: { root: rootN, rootText: textOf(rootN), members, textOf } };
}

// The transitional cue is the dependent's KIND, not a limitation: "further
// comprising:" split off as a row of its own on the first fixture.
const DEP_CUE_RE = /^(?:further\s+(?:comprising|comprises|including|includes|having|containing)|wherein|in\s+which|where|characteri[sz]ed\s+(?:by|in\s+that))\b\s*[:,]?\s*/i;
export function dependentRows(body) {
  const stripped = String(body || '').replace(DEP_CUE_RE, '').trim();
  const rows = splitClaimElements(stripped, { fine: false })
    .map((s) => String(s).replace(DEP_CUE_RE, '').trim())
    .filter((s) => s && contentWords(s).length);
  return rows.length ? rows : [stripped || String(body || '').trim()];
}

/** The one-sentence verdict that distinguishes a compressed dependent chart from an incomplete one. */
export function familyVerdictLine(dep) {
  const rows = dep.effective;
  const inherited = dep.inherited.filter((r) => !r.narrowedBy).length;
  const narrowed = dep.judged.filter((j) => j.origin === 'narrowed').length;
  const fresh = dep.judged.filter((j) => j.origin === 'new').length;
  const notMet = rows.filter((r) => r.label !== 'PRESENT');
  const present = rows.length - notMet.length;
  const from = [...new Set(dep.inherited.map((r) => r.from))].sort((a, b) => a - b);
  const inhPresent = dep.inherited.filter((r) => !r.narrowedBy && r.label === 'PRESENT').length;
  const verdict = notMet.length ? `NOT MET (${present} of ${rows.length} limitations PRESENT)` : `MET (all ${rows.length} limitations PRESENT)`;
  return `claim ${dep.n} (${dep.depthLabel || 'D'}): ${verdict} over ${rows.length} limitations -- `
    + `${inherited} inherited from claim${from.length > 1 ? 's' : ''} ${from.join(', ')} (evaluated there, not shown; ${inhPresent} PRESENT), `
    + `${narrowed} re-evaluated as narrowed, ${fresh} new`;
}

export function formatFamilySection(fam) {
  const esc = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const out = [];
  out.push('', `## Dependent claims (family of claim ${fam.root})`, '');
  out.push(`_${fam.members.length} dependent claim(s). An inherited row is a one-line reference to the parent row it`);
  out.push('incorporates, carrying that row\'s verdict (evaluated on the parent, not re-judged). An ADDITION adds a row.');
  out.push('A MODIFICATION re-evaluates the one inherited row it narrows, against the dependent\'s own language and on');
  out.push('the code the parent row cited; its verdict may differ from the parent\'s, and the row says so. The verdict');
  out.push('line under each claim counts every limitation the dependent carries, shown or not._');
  for (const dep of fam.members) {
    const kind = dep.kind + (dep.cue ? ` ("${dep.cue}")` : '');
    out.push('', `### Claim ${dep.n} (${dep.depthLabel || 'D'}) — ${kind}`, '');
    out.push('```', `${dep.n}. ${dep.text}`, '```', '');
    if (dep.parentChoice) out.push(`_Multi-parent reference: charted under claim ${dep.parent} by ${dep.parentChoice.policy} (alternatives ${dep.parentChoice.alternatives.join(', ')})._`, '');
    out.push(`**Verdict:** ${dep.verdictLine}`, '');
    out.push('| # | Claim element | CE finding — is the limitation met? | Cited code |', '|---|---|---|---|');
    for (const r of dep.effective) {
      if (r.origin === 'inherited') {
        out.push(`| ${r.designation} | _inherited from claim ${r.from}; see ${r.parentDesignation}_ | **${r.label}** _(carried)_ | ${r.target ? `${r.label === 'ABSENT' ? 'closest examined: ' : ''}\`${r.target}\`` : '—'} |`);
      } else if (r.origin === 'narrowed') {
        const was = r.parentLabel ? ` _(was ${r.parentLabel} on ${r.narrows})_` : '';
        out.push(`| ${r.designation} narrows ${r.narrows} | ${esc(r.text)} | **${r.label}**${was}${r.note ? ' ' + esc(r.note).slice(0, 160) : ''} | ${r.target ? `${r.label === 'ABSENT' ? 'closest examined: ' : ''}\`${r.target}\`` : '—'} |`);
      } else {
        const amb = r.ambiguous ? ` _(${esc(r.ambiguous)})_` : '';
        out.push(`| ${r.designation} | ${esc(r.text)}${amb} | **${r.label}**${r.note ? ' ' + esc(r.note).slice(0, 160) : ''} | ${r.target ? `${r.label === 'ABSENT' ? 'closest examined: ' : ''}\`${r.target}\`` : '—'} |`);
      }
    }
    const judgedOn = dep.analysed.map((a) => `\`${a.target}\``).join(', ');
    out.push('', `_Re-evaluated / new rows judged on ${dep.analysed.length} target(s)${judgedOn ? `: ${judgedOn}` : ''}`
      + `${dep.dropped.length ? `; ${dep.dropped.length} dropped (${dep.dropped.map((d) => d.reason).join('; ')})` : ''}._`);
  }
  return out.join('\n');
}

// ============================================================================
// Whole-claim retrieval arm (chart-retrieval-whole-claim-arm)
// ============================================================================
//
// Per-element retrieval asks the model for code vocabulary PER ELEMENT and
// searches with that. On the '101 family chart it never retrieved the crux --
// AdaptiveTrackSelection::determineIdealSelectedIndex, in the index -- because
// element 4's words (reproduce, playback, determine, code, rate, remaining,
// time, start) put TimeText.kt@TimeFormat::remaining first. The two-chart
// protocol (#310, 2026-08-27) measured the other arm: the CLAIM's own rare
// vocabulary over the whole index finds different code, and it is what found
// the track-selection files. This is that arm, joined into the target list ON
// TOP of the per-element budget and attributed as element 0 (the whole claim),
// so the nomination index, the Retrieval-by-element table, the sidecar and the
// nearest-miss rule all see which arm nominated what. No model call: the
// words are the claim's own content words, rarity-ranked by the symbol table
// the way every other name search here is.

/** The claim's content words, one surface form per stem, in claim order. */
export function wholeClaimTerms(claimText, max = 24) {
  const out = [];
  const seen = new Set();
  for (const w of contentWords(claimText)) {
    const s = stem(w);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(w.toLowerCase());
    if (out.length >= max) break;
  }
  return out;
}

/**
 * `{ element: 0, words, hits, contentAdded, arm: 'claim' }` -- the same shape
 * as a per-element retrieval entry, so it rides the same plumbing.
 */
export function wholeClaimArm({ claimText, symbols, index = null, includeTests = false, includeOp = false, limit = 5 }) {
  const words = wholeClaimTerms(claimText);
  const pool = includeOp ? symbols : symbols.filter((s) => !isPseudoSource(s.filepath));
  const hits = searchSymbolsByWords(pool, words, { limit: Math.max(limit * 3, 15), includeTests })
    .map((h) => ({ ...h, arm: 'name' }));
  let contentAdded = 0;
  if (index && words.length) {
    const key = (s) => `${String(s.filepath || '').split('!').pop()}@${s.name}`;
    const seen = new Set(hits.map((h) => key(h.sym)));
    try {
      for (const c of contentCandidatesForWords(index, words, { limit, includeOp, includeTests })) {
        if (!c) continue;
        if (seen.has(key(c))) {
          const prior = hits.find((h) => key(h.sym) === key(c));
          if (prior) prior.arm = 'both';
          continue;
        }
        seen.add(key(c));
        hits.push({ sym: c, matched: [], score: 0, arm: 'content' });
        contentAdded++;
      }
    } catch { /* the content arm is best-effort; the name arm stands alone */ }
  }
  return { element: 0, words, hits: hits.slice(0, limit), contentAdded, arm: 'claim' };
}

// One target judged against a dependent's re-evaluated / new rows. The same
// steps as claim 1's loop (resolve, file-hint filter, source with file line
// numbers, depth-1 callees, the VERDICT contract, the lexical gate); kept
// separate rather than refactoring the loop the '101 charts were produced by.
async function analyseTargetForRows({ index, symbols, target, claimText, rows, draft, args }) {
  const t = String(target);
  const at = t.indexOf('@');
  const fnSpec = at >= 0 ? t.slice(at + 1) : t;
  const fileHint = at >= 0 ? t.slice(0, at).trim() : '';
  let v = verifySymbol(symbols, fnSpec);
  if (fileHint && isFound(v)) {
    const hinted = filterMatchesByFile(v.matches, fileHint);
    if (!hinted.length) return { dropped: { target: t, reason: `not found in a file matching \`${fileHint}\`` } };
    v = { ...v, matches: hinted, ambiguous: hinted.length };
  }
  if (!isFound(v)) return { dropped: { target: t, reason: 'not found in this index' } };
  const m = v.matches[0];
  let got = null;
  const _log = console.log; console.log = () => {};
  try { got = index.getFunctionSourceWithRange?.(m.filepath, m.name); } catch { got = null; } finally { console.log = _log; }
  const src = got?.source;
  if (!src) return { dropped: { target: t, reason: 'source not retrievable from the index' } };
  const { text: calleeText } = args.no_callees === true ? { text: '' } : collectCalleeBodies(index, symbols, m, args);
  const numFrom = got?.start ?? m.start;
  const numbered = numFrom != null ? addLineNumbers(String(src), numFrom) : String(src);
  const promptSrc = calleeText
    ? `${numbered}\n\n// ===== depth-1 callees, included so the analysis need not infer what they do =====\n${calleeText}`
    : numbered;
  const label = targetSpec(m);
  let out;
  try { out = await draft(buildChartAnalysisPrompt(promptSrc, m.name, m.filepath, claimText, rows), '', 1100); }
  catch (e) { return { dropped: { target: label, reason: `analysis failed — ${e.message}` } }; }
  const verdicts = parseChartVerdicts(out || '', rows);
  const gated = verdicts.map((e) => ({ ...e, label: lexicalGate(e.label, e.text, `${m.name}\n${promptSrc}`) }));
  if (!gated.length) {
    const rawLines = String(out || '').split(/\r?\n/).filter((l) => l.trim()).length;
    return { dropped: { target: label, reason: rawLines ? `PARSE-FAILED: ${rawLines} non-empty line(s), none matched the VERDICT contract` : 'engine returned an empty response' } };
  }
  return { target: label, elements: gated };
}

/**
 * Chart every dependent in the family beneath an already-charted claim 1.
 * Returns `{ root, members: [...] }` for formatFamilySection and the sidecar.
 */
export async function chartFamily({ index, symbols, draft, args, scope, rootElements, rootFills, targetsSupplied, onProgress = null }) {
  const fam = scope.family;
  const rootN = fam.root;
  const rowsOf = new Map();
  rowsOf.set(rootN, rootElements.map((e, i) => {
    const f = rootFills.find((x) => x.element === i + 1) || null;
    return { designation: rowDesignation(rootN, i), text: String(e), label: f ? f.label : 'UNANALYSED', note: f ? f.note || '' : '', target: f ? f.target || null : null };
  }));
  const chainText = (dep) => (dep.chain || [rootN, dep.n]).map((k) => `${k}. ${fam.textOf(k)}`).join('\n');
  const members = [];
  for (const dep of fam.members) {
    const parentRows = rowsOf.get(dep.parent) || rowsOf.get(rootN);
    const own = dependentRows(dependentBody(dep.text));
    const kind = dep.contribution ? dep.contribution.kind : 'UNDETERMINED';
    const judged = [];
    const narrowed = new Map(); // parent designation -> judged row
    own.forEach((t, i) => {
      const d = rowDesignation(dep.n, i);
      if (kind === 'MODIFICATION') {
        const m = narrowedRowFor(t, parentRows);
        if (m && !narrowed.has(m.row.designation)) {
          const j = { designation: d, origin: 'narrowed', own: t, text: `${m.row.text} — as narrowed by claim ${dep.n}: ${t}`, narrows: m.row.designation, parentLabel: m.row.label, parentTarget: m.row.target, shared: m.shared };
          narrowed.set(m.row.designation, j);
          judged.push(j);
        } else {
          judged.push({ designation: d, origin: 'new', own: t, text: t, ambiguous: 'narrowing cue, but no parent row shares its vocabulary; judged as its own row' });
        }
      } else if (kind === 'UNDETERMINED') {
        const m = narrowedRowFor(t, parentRows);
        judged.push({ designation: d, origin: 'new', own: t, text: t, ambiguous: m ? `UNDETERMINED kind: judged as its own row; could also read as narrowing ${m.row.designation}` : 'UNDETERMINED kind (neither an addition nor a narrowing cue); judged as its own row' });
      } else {
        judged.push({ designation: d, origin: 'new', own: t, text: t });
      }
    });
    const inherited = parentRows.map((r) => ({ ...r, origin: 'inherited', from: dep.parent ?? rootN, parentDesignation: r.designation, narrowedBy: narrowed.has(r.designation) ? dep.n : null }));

    // Targets: the parent row's cited code for a narrowed row (the narrowing is
    // judged where the parent was found), plus per-element retrieval for the
    // judged rows when the chart retrieves for itself; with --targets supplied,
    // every target claim 1 cited.
    const targetSet = new Set();
    let nominators = null;
    for (const j of judged) if (j.parentTarget) targetSet.add(j.parentTarget);
    if (targetsSupplied) { for (const r of parentRows) if (r.target) targetSet.add(r.target); }
    else if (judged.length) {
      const disc = await retrievePerElement({ draft, elements: judged.map((j) => j.text), symbols,
        opts: { includeTests: !!args.include_tests, includeOp: !!args.include_op, index } });
      if (!disc.error) {
        for (const t of perElementTargetsWithStats(disc.perElement, args).targets) targetSet.add(t);
        nominators = nominationIndex(disc.perElement);
      }
    }
    const analysed = [];
    const dropped = [];
    for (const t of targetSet) {
      if (onProgress) onProgress(`  claim ${dep.n}: judging ${judged.length} row(s) on ${t}`);
      const r = await analyseTargetForRows({ index, symbols, target: t, claimText: chainText(dep), rows: judged.map((j) => j.text), draft, args });
      if (r.dropped) dropped.push(r.dropped); else analysed.push(r);
    }
    const fills = analysed.length ? mergeBestPerElement(analysed, { nominators }) : [];
    judged.forEach((j, i) => {
      const f = fills.find((x) => x.element === i + 1) || null;
      j.label = f ? f.label : 'UNANALYSED';
      j.note = f ? f.note || '' : (targetSet.size ? 'no target produced a verdict for this row' : 'no target to judge this row on');
      j.target = f ? f.target || null : null;
    });
    const effective = [
      ...inherited.map((r) => (r.narrowedBy ? narrowed.get(r.designation) : r)),
      ...judged.filter((j) => j.origin === 'new'),
    ];
    const rec = { n: dep.n, text: dep.text, depthLabel: dep.depthLabel, depth: dep.depth, kind, cue: dep.contribution ? dep.contribution.cue : null,
      parent: dep.parent ?? rootN, chain: dep.chain || [rootN, dep.n], parentChoice: dep.parentChoice || null,
      inherited, judged, effective, analysed, dropped };
    rec.verdictLine = familyVerdictLine(rec);
    rowsOf.set(dep.n, effective.map((r) => ({ designation: r.designation, text: r.text, label: r.label, note: r.note || '', target: r.target || null })));
    members.push(rec);
  }
  return { root: rootN, members };
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
  // dep-claims-broaden-parent: the full input (all claims) survives scoping,
  // so MODIFICATION dependents can donate species vocabulary to the root's rows.
  const fullInputText = claimText;

  // issue-311-dep-claim-chart: which claim(s) of the input this chart is of.
  // Default the first; --claim-number <n> selects (a dependent charts its
  // chain); --claim-family charts claim 1 and its dependents beneath it.
  let scope;
  try { scope = chartScope(claimText, { claim: args.claim_number ?? null, family: !!args.claim_family }); }
  catch (e) { console.error(`--claim-chart: ${e.message}`); process.exitCode = 1; return; }
  claimText = scope.text;
  if (scope.note) process.stderr.write(`[claim-chart] scope: ${scope.note}\n`);

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
  const tier = args.granularity === 'coarse' ? 'coarse' : 'fine';
  // `table` is rebuilt when a two-sided claim tags other-side rows
  // (chart-client-server-scope) -- hence let, not const. Andrew's pre-commit
  // test caught the const assignment; the mock e2e now pins this path.
  let { table, elements } = buildChartTable(claimText, { elements: suppliedElements, granularity: tier });
  // The tier is part of the row structure's provenance: a fine chart and a coarse
  // chart of the same claim have different row counts, and a reader comparing two
  // charts needs the header to say which split produced each.
  if (!elementsSource) elementsSource = `${elements.length} from CE's split of the claim text (--granularity ${tier})`;

  // dep-claims-broaden-parent: claim differentiation as retrieval guidance.
  // A MODIFICATION dependent narrowing an element to a species is presumptive
  // evidence the parent's genus term covers that species -- so the species
  // words join the narrowed row's SEARCH (never its verdict rule), and the
  // analysis prompt carries one disclosed, doctrine-named note per such row.
  let depSyn = null;
  let depNotes = null;
  if (!args.no_dep_synonyms) {
    const parts = splitNumberedClaims(fullInputText).filter((p) => p.n != null);
    if (parts.length > 1) {
      const rootM = String(claimText).match(/^\s*(\d+)\s*[.)]/);
      const rootN = scope.family ? scope.family.root
        : rootM ? Number(rootM[1])
          : args.claim_number != null ? Number(args.claim_number) : parts[0].n;
      const parentRows = elements.map((text, index) => ({ text, index }));
      depSyn = parentElementSynonyms(parts.map((p) => ({ n: p.n, text: `${p.n}. ${p.text}` })), parentRows,
        { rootN, dependentBody, narrowedRowFor, contentWords, stem });
      if (!depSyn.rows.length) depSyn = null;
      else {
        process.stderr.write(`[claim-chart] claim differentiation: ${depSyn.rows.length} element(s) gain species words from`
          + ` MODIFICATION dependent(s): `
          + depSyn.rows.map((r) => `element ${r.row + 1} +[${r.words.join(', ')}] (claim ${r.from.map((f) => f.claim).join(', ')})`).join('; ')
          + ` -- --no-dep-synonyms disables\n`);
        if (depSyn.unmatched.length) {
          process.stderr.write(`  ${depSyn.unmatched.length} narrowing dependent(s) matched no parent row -- reported, not guessed:`
            + ` claim ${depSyn.unmatched.map((u) => u.claim).join(', ')}\n`);
        }
        depNotes = new Map(depSyn.rows.map((r) => [r.row,
          `Dependent claim ${r.from.map((f) => f.claim).join(' and ')} narrows this element to: ${r.words.join(', ')}`
          + ` (claim differentiation — a species the element presumptively covers).`]));
      }
    }
  }
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
      duplicates: targetDuplicates, containers: targetContainers, retrieval } = parseTargets(args.targets)); }
    catch (e) { console.error(e.message); process.exitCode = 1; return; }
    if (!targets.length) { console.error('No targets parsed.'); process.exitCode = 1; return; }
    // A locate file that carries attribution restores the `Retrieval by element`
    // table to the locate->chart path. Without it the two paths produced
    // artifacts of different evidentiary quality from the same work.
    if (retrieval) {
      targetProvenance = [...targetProvenance,
        `Retrieval: attribution carried from the targets file — ${retrieval.length} element(s)`
        + ` searched with their own predicted vocabulary during --claim-locate.`];
    }
  } else {
    // chart-retrieval-multi-run-merge: two vocabulary calls on cloud engines
    // (temp-0 drift), one on bit-stable local models (#306). The gate sees
    // the real call count.
    const vocabRuns = model.kind === 'gguf' ? 1 : 2;
    if (!claimsCostGate(model, Array.from({ length: vocabRuns }, () => ({ inChars: claimText.length + 2000, outTokens: 600 })),
      `claim-chart per-element retrieval (${vocabRuns} call${vocabRuns > 1 ? 's' : ''})`, args)) return;
    process.stderr.write('[claim-chart] no --targets: retrieving per element'
      + ' (the model is shown the CLAIM ONLY — no paths, no codebase identity)...\n');
    const disc = await retrievePerElement({
      draft, elements, symbols,
      opts: {
        includeTests: !!args.include_tests,
        includeOp: !!args.include_op,
        // The CONTENT arm needs the index; searchSymbolsByWords only needs the
        // symbol table. Passing it is what turns the arm on, and omitting it
        // leaves this path byte-identical to before (#315 lever 2).
        index,
        // dep-claims-broaden-parent: species words for the rows dependents narrow.
        extraWords: depSyn ? new Map(depSyn.rows.map((r) => [r.row + 1, { words: r.words, from: r.from }])) : null,
        vocabRuns,
        onElement: ({ element, words, hits, contentAdded }) => process.stderr.write(
          `  element ${element}: words [${words.join(', ')}] -> ${hits.length} candidate(s)`
          + `${contentAdded ? ` (${contentAdded} via content search)` : ''}\n`),
      },
    });
    if (disc.error) { console.error(`--claim-chart: ${disc.error}`); process.exitCode = 1; return; }
    retrieval = disc.perElement;
    // Rides on the array so the provenance renderer can say what retrieval
    // held back; JSON serialisation of the array drops it, which is fine —
    // the verdicts sidecar records nominations, not the gate.
    retrieval.heldBack = disc.heldBack || { symbols: 0, content: 0 };
    const budget = perElementTargetsWithStats(retrieval, args);
    targets = budget.targets;
    // Carried on the array (like heldBack) for the attribution block below;
    // JSON serialisation drops it, which is fine -- the sidecar records
    // nominations, not the selection mechanics.
    retrieval._concentration = budget.concentration || [];
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
  // chart-retrieval-content-arm-and-budget: attribute the concentration
  // targets (already in `targets` via perElementTargetsWithStats) so the
  // retrieval table, sidecar and merge tie-break can see them.
  if (!args.targets && Array.isArray(retrieval) && retrieval._concentration && retrieval._concentration.length) {
    const conc = retrieval._concentration;
    retrieval.push({ element: 0, arm: 'concentration', words: [], hits: conc.map((c) => c.hit) });
    process.stderr.write(`  concentration: ${conc.length} target(s) added -- 2+ elements pointed at the same file: `
      + conc.map((c) => `${String(c.file).split('/').pop()} (elements ${c.elements.join(', ')})`).join('; ') + '\n');
    targetProvenance = [...targetProvenance,
      `Concentration: ${conc.length} target(s) added because two or more elements' top candidates share a file`
      + ` that contributed no target: ${conc.map((c) => `${String(c.file).split('/').pop().split('!').pop()} (elements ${c.elements.join(', ')})`).join('; ')}.`
      + ' --concentration-targets 0 disables it.'];
  }
  // dep-claims-broaden-parent: say which rows were searched with dependent
  // species vocabulary -- retrieval guidance, disclosed, never a verdict rule.
  if (!args.targets && depSyn) {
    targetProvenance = [...targetProvenance,
      `Claim differentiation: ${depSyn.rows.length} element(s) also searched with species vocabulary donated by`
      + ` MODIFICATION dependent(s): ${depSyn.rows.map((r) => `element ${r.row + 1} from claim ${r.from.map((f) => f.claim).join('/')}`).join('; ')}.`
      + ' --no-dep-synonyms disables it.'];
  }
  // chart-retrieval-multi-run-merge: how stable the vocabulary was, on the
  // artifact -- the agreement rate is the reader's variance disclosure.
  if (!args.targets && Array.isArray(retrieval)) {
    const rr = retrieval.filter((p) => p.wordRuns);
    if (rr.length) {
      let agreed = 0, total = 0;
      for (const p of rr) { agreed += p.wordRuns.agreed.length; total += (p.words || []).length; }
      targetProvenance = [...targetProvenance,
        `Vocabulary: 2 prediction runs merged per element (cloud temp-0 drift); ${total ? Math.round(100 * agreed / total) : 0}%`
        + ` of searched words agreed between runs — one-run-only words are marked \`?\` in the retrieval table.`];
    }
  }
  // chart-client-server-scope: a two-sided claim gets the index-side fact
  // stated on the artifact, and the other party's rows tagged. Deterministic
  // in both halves; verdicts never change.
  let claimSides = null;
  let indexSide = null;
  let sideScope = null;
  let otherSideElements = new Set();
  try { claimSides = detectClaimSides(claimText, elements); } catch { claimSides = null; }
  if (claimSides) {
    try { indexSide = (opts.clientServerVerdict || clientServerVerdict)(index); } catch { indexSide = null; }
    const [serving, consuming] = claimSides.parties;
    let otherParty = null;
    if (claimSides.directional && indexSide) {
      if (indexSide.verdict === 'client-only') otherParty = serving;
      else if (indexSide.verdict === 'server-only') otherParty = consuming;
    }
    if (otherParty) {
      claimSides.perElement.forEach((p, i) => { if (p === otherParty) otherSideElements.add(i + 1); });
    }
    const countsLine = indexSide
      ? `--client-server: ${indexSide.serverRoutes} server route(s), ${indexSide.clientCalls} client HTTP call(s), socket/TLS client ${indexSide.socketClient} / server ${indexSide.socketServer}`
      : '--client-server: unavailable';
    const rowsList = [...otherSideElements].sort((a, b) => a - b).join(', ');
    sideScope = `Two-sided claim: ${serving} / ${consuming}. This index is ${indexSide ? indexSide.verdict.toUpperCase() : 'UNDETERMINED'} (${countsLine}).`
      + (otherParty && rowsList
        ? ` Rows attributed to the ${otherParty} (${rowsList}) can only be met by a counterpart not in this index; their verdicts below are findings about THIS code, not about the system.`
        : indexSide && indexSide.verdict === 'undetermined'
          ? ' Nothing was detected either way (e.g. a library with no network code); no row is tagged.'
          : '');
    if (otherSideElements.size) {
      const sideTags = elements.map((_, i) => otherSideElements.has(i + 1));
      ({ table } = buildChartTable(claimText, { elements, granularity: tier, sideTags }));
    }
    process.stderr.write(`[claim-chart] two-sided claim (${serving} / ${consuming}); index ${indexSide ? indexSide.verdict : 'undetermined'}`
      + (otherSideElements.size ? `; other-side rows: ${[...otherSideElements].sort((a, b) => a - b).join(', ')}` : '') + '\n');
  }

  // chart-within-file-drilldown: spend the file-level signal. Concentration
  // named the file(s); per element, the scoped content search names the
  // FUNCTION -- the last mile the sweep showed the pipeline missing.
  if (!args.targets && Array.isArray(retrieval) && index) {
    const dd = drilldownTargets({ index, retrieval, targets,
      includeOp: !!args.include_op, includeTests: !!args.include_tests });
    if (dd.added.length) {
      for (const a of dd.added) {
        targets.push(a.spec);
        retrieval.push({ element: a.element, arm: 'drilldown', file: a.file, words: [], hits: [{ sym: a.sym, arm: 'content' }] });
      }
      process.stderr.write(`  drilldown: ${dd.added.length} target(s) added -- per-element content search scoped to concentration file(s): `
        + dd.added.map((a) => `element ${a.element} -> ${a.spec.split('@').pop()} (${String(a.file).split('/').pop().split('!').pop()})`).join('; ') + '\n');
      targetProvenance = [...targetProvenance,
        `Drilldown: ${dd.added.length} target(s) added by re-running the content search scoped to concentration file(s), per element`
        + ` (bounds fixed in code: ${DRILLDOWN_PER_ELEMENT} per element, ${DRILLDOWN_PER_CHART} per chart):`
        + ` ${dd.added.map((a) => `element ${a.element} -> \`${a.spec}\``).join('; ')}.`];
    }
  }
  // chart-retrieval-whole-claim-arm: the claim's own words over the whole
  // symbol table, on top of the per-element budget. --whole-claim-targets 0
  // turns it off; an explicit --targets list never comes through here.
  if (!args.targets && Array.isArray(retrieval)) {
    const wholeN = args.whole_claim_targets == null ? CHART_DEFAULTS.wholeClaimTargets : Math.max(0, Number(args.whole_claim_targets) || 0);
    if (wholeN > 0) {
      const arm = wholeClaimArm({ claimText, symbols, index, includeTests: !!args.include_tests, includeOp: !!args.include_op, limit: wholeN });
      const have = new Set(targets);
      arm.added = [];
      for (const h of arm.hits) {
        const s = targetSpec(h.sym);
        if (have.has(s)) continue;
        have.add(s); targets.push(s); arm.added.push(s);
      }
      retrieval.push(arm);
      process.stderr.write(`  whole claim: words [${arm.words.slice(0, 8).join(', ')}${arm.words.length > 8 ? ', …' : ''}]`
        + ` -> ${arm.hits.length} candidate(s), ${arm.added.length} added on top of the per-element targets\n`);
      targetProvenance = [...targetProvenance,
        `Whole-claim arm: ${arm.added.length} target(s) added from the claim's own content words`
        + ` (${arm.words.slice(0, 8).join(', ')}${arm.words.length > 8 ? ', …' : ''}), rarity-ranked over the symbol table,`
        + ` on top of the per-element budget (${arm.hits.length - arm.added.length} of its ${arm.hits.length} candidate(s) were already nominated per element).`
        + ' --whole-claim-targets 0 disables it.'];
    }
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
    const fileHint = at >= 0 ? t.slice(0, at).trim() : '';
    let v = verifySymbol(symbols, fnSpec);
    // THE FILE HALF OF THE TARGET WAS PARSED OFF AND NEVER USED, so
    // `AdaptiveTrackSelection.java@updateSelectedTrack` and
    // `DownloadHelper.java@updateSelectedTrack` were identical inputs. Measured
    // on `.AndroidX_Media_ExoPlayer3` (#309 Part A): asked for the first,
    // analysed the second — a different class in `offline/`, with 0 callee
    // bodies — and the delivered '101 chart cited the download-path
    // implementation on every `updateSelectedTrack` row. Re-running with a
    // longer path gave the same wrong symbol, because both attempts varied only
    // the discarded half.
    //
    // On a document that names a function per row and invites verification,
    // citing the wrong class is worse than ABSENT. ABSENT is honest.
    //
    // Filtered here rather than inside verifySymbol, which --claim-locate shares.
    if (fileHint && isFound(v)) {
      const hinted = filterMatchesByFile(v.matches, fileHint);
      if (hinted.length) {
        v = { ...v, matches: hinted, ambiguous: hinted.length };
      } else {
        // Silent fallback to a same-named symbol elsewhere IS the defect. A
        // hint that matches nothing must fail loudly and name itself.
        process.stderr.write(`  NOT FOUND in index: ${fnSpec} in a file matching '${fileHint}'`
          + ` (${v.matches.length} symbol(s) with that name exist in other files)\n`);
        unresolved.push(`\`${t}\` (no such symbol in a file matching \`${fileHint}\`)`);
        dropped.push({ target: t,
          reason: `not found in a file matching \`${fileHint}\` — ${v.matches.length} same-named symbol(s) exist elsewhere and were NOT substituted` });
        continue;
      }
    }
    if (!isFound(v)) {
      process.stderr.write(`  NOT FOUND in index: ${t}\n`);
      unresolved.push(`\`${t}\` (no such symbol)`);
      dropped.push({ target: t, reason: 'not found in this index' });
      continue;
    }
    const m = v.matches[0];
    if (v.ambiguous > 1) {
      // Only recommend qualification when qualification was not already given
      // and used — otherwise the message sends a user to do the thing they did.
      process.stderr.write(`  AMBIGUOUS: ${v.ambiguous} symbols match ${fnSpec}`
        + `${fileHint ? ` in a file matching '${fileHint}'` : ''} — using ${m.filepath.split('!').pop()};`
        + `${fileHint ? ' qualify further (Class::method) to choose' : ' qualify the target to choose'}\n`);
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
    const label = targetSpec(m);
    let out;
    try { out = await draft(buildChartAnalysisPrompt(promptSrc, m.name, m.filepath, claimText, elements, { depNotes }), '', 1100); }
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

  // THE MERGE'S INPUT, DUMPED BEFORE THE MERGE CONSUMES IT.
  //
  // RUN 7 (#315) established that retrieval is no longer the blocker on
  // '101 x ExoPlayer -- 8 of 45 targets were real playback code, up from 0 of
  // 22, with the crux in the list -- and the chart still got worse. The
  // remaining defects are both in mergeBestPerElement: ASSUMED outranks ABSENT
  // in LABEL_RANK, so a row where 41 targets said ABSENT can report ASSUMED;
  // and replacement is strictly-greater, so on a TIE the FIRST-ANALYSED target
  // keeps the citation. asus-CC's three-line proof:
  //
  //   mergeBestPerElement([junk, crux]) -> cites LaunchActivity::onStart
  //   mergeBestPerElement([crux, junk]) -> cites determineIdealSelectedIndex
  //
  // Nobody knows which rule is RIGHT, and each candidate rule currently costs a
  // full model run to evaluate. These per-target analyses already contain the
  // answer and were being discarded the moment the merge read them. On disk,
  // any rule can be replayed against real data with no GPU and no model calls.
  //
  // WHAT IS AND IS NOT IN THE FILE, and each choice is load-bearing:
  //   - targets IN ANALYSIS ORDER, because arrival order is the defect under
  //     study; a replay must reproduce it exactly and be able to permute it. An
  //     array preserves it, a keyed object would destroy the one property being
  //     measured.
  //   - RAW labels and notes only. No tally, no agreement, no winner -- derived
  //     fields would bake in the assumptions the replay exists to test. This is
  //     the merge's INPUT, not its output.
  //   - DROPPED targets with their reason, including the PARSE-FAILED string.
  //     45 analysed and 41 parsed are different populations, and a rule scored
  //     against the wrong denominator is scored wrong.
  //   - provenance binding it to its chart, so a replay cannot be run against
  //     the wrong run's verdicts and produce a confident answer.
  //   - WHICH ELEMENT nominated each target, AT WHAT RANK. Analysis order alone
  //     scores arrival-order and LABEL_RANK rules, but not the rule RUN 9's
  //     evidence points at -- prefer the target the element ITSELF ranked
  //     highest over one that arrived from another element's list.
  //     LaunchActivity::onStart took row 6 without element 6 nominating it at
  //     all, and without this field nothing on disk records that. Still the
  //     merge's INPUT: a rank is what retrieval SAID, not a derived winner.
  // claim-chart-scattered-targets: computed after the merge (the fills are
  // what a reader sees); declared here so the sidecar can carry the field.
  let connectivity = null;
  if (args.verdicts_out) {
    const nominators = nominationIndex(retrieval);
    const sidecar = {
      _format: 'codeexam-chart-verdicts/1',
      _note: 'Raw per-target verdicts as the merge received them, in analysis '
        + 'order, plus which element nominated each target at what rank. No '
        + 'MERGE-derived fields: no tally, agreement, or winner. '
        + 'See mergeBestPerElement.',
      engine: engineLabel,
      engineBuild: engineBuildLine(),
      index: args.index_path || '(unknown)',
      indexSymbols: symbols.length,
      claimSource: (typeof spec === 'string' && spec.startsWith('@')) ? spec.slice(1) : 'inline text',
      claimChars: claimText.length,
      elements: elements.length,
      // Per-row class (preamble / generic / mechanism), so a replay or a loop
      // test can re-tally by class without re-deriving the rule.
      elementClasses: elementClasses(elements, { isPreambleRow }),
      // Which rows were searched with dependent-donated species vocabulary
      // (dep-claims-broaden-parent); null when none or --no-dep-synonyms.
      depSynonyms: depSyn
        ? Object.fromEntries(depSyn.rows.map((r) => [String(r.row + 1), { words: r.words, from: r.from }]))
        : null,
      // claim-chart-scattered-targets: connectivity groups of the cited
      // PRESENT/PARTIAL targets (null when fewer than 2 cited).
      targetGroups: connectivity ? connectivity.groups : null,
      // chart-client-server-scope: the two-sided-claim facts, so the loop
      // scorer can exclude other-side rows without re-deriving the rule.
      claimSides: claimSides ? { parties: claimSides.parties, directional: claimSides.directional, perElement: claimSides.perElement } : null,
      indexSide: indexSide || null,
      // The integrity VERDICT, not a checksum -- targetIntegrity is a string
      // ('unmodified' / 'modified' / null), and writing `.checksum` here would
      // have silently recorded undefined in the one field meant to bind this
      // file to its chart.
      targetsIntegrity: targetIntegrity || 'not-supplied',
      argv: process.argv.slice(1).join(' '),
      generatedAt: new Date().toISOString(),
      analysed: perTarget.map((p) => ({
        target: p.target,
        nominatedBy: nominators.get(p.target) || [],
        elements: p.elements.map((e) => ({
          element: e.element ?? null, text: e.text ?? '', label: e.label, note: e.note || '',
        })),
      })),
      dropped: dropped.map((d) => ({ target: d.target, reason: d.reason })),
    };
    try {
      fs.writeFileSync(args.verdicts_out, `${JSON.stringify(sidecar, null, 2)}
`, 'utf8');
      console.log(`
Per-target verdicts written to ${args.verdicts_out}`
        + ` (${sidecar.analysed.length} analysed, ${sidecar.dropped.length} dropped).`);
    } catch (e) {
      console.error(`--verdicts-out: cannot write ${args.verdicts_out}: ${e.message}`);
      process.exitCode = 1;
    }
  }

  const fills = mergeBestPerElement(perTarget, { nominators: nominationIndex(retrieval) });
  // claim-chart-scattered-targets: connectivity of the cited PRESENT/PARTIAL
  // targets. Reported and recorded; never changes a verdict.
  {
    const cited = [...new Set(fills.filter((f) => f.target && (f.label === 'PRESENT' || f.label === 'PARTIAL')).map((f) => f.target))];
    if (cited.length >= 2) {
      try { connectivity = targetConnectivity({ targets: cited, neighbors: indexCallNeighbors(index) }); }
      catch { connectivity = null; }
    }
  }
  // chart-duplicate-surface-note + chart-qualifier-check: post-merge,
  // deterministic, report-only.
  let citedDupes = [];
  try { citedDupes = citedDuplicates(index, fills); } catch { citedDupes = []; }
  const qualifiers = new Map();
  for (const f of fills) {
    if (!(f.label === 'PRESENT' || f.label === 'PARTIAL') || f.element == null) continue;
    const un = unshownQualifiers(f.text, f.note);
    if (un.length) { qualifiers.set(f.element, un); f.unshown = un; }
  }
  const wordRunsRecorded = Array.isArray(retrieval) ? retrieval.filter((p) => p.wordRuns && p.element) : [];
  // The sidecar was already written (raw pre-merge verdicts, by design), so
  // the post-merge facts ride in via the same read-modify-write the family
  // block uses.
  if ((connectivity || citedDupes.length || qualifiers.size || wordRunsRecorded.length) && args.verdicts_out && !process.exitCode) {
    try {
      const j = JSON.parse(fs.readFileSync(args.verdicts_out, 'utf8'));
      if (connectivity) j.targetGroups = connectivity.groups;
      if (citedDupes.length) j.citedDuplicates = citedDupes;
      if (qualifiers.size) j.unshownQualifiers = Object.fromEntries([...qualifiers].map(([k, v]) => [String(k), v]));
      if (wordRunsRecorded.length) j.wordRuns = Object.fromEntries(wordRunsRecorded.map((p) => [String(p.element), p.wordRuns]));
      fs.writeFileSync(args.verdicts_out, `${JSON.stringify(j, null, 2)}
`, 'utf8');
    } catch { /* best-effort; the chart line still reports */ }
  }
  const scopeNote =[scope.note ? `_Scope: ${scope.note}._` : null, args.scope_note ? String(args.scope_note) : null]
    .filter(Boolean).join('\n\n') || null;
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
  // issue-311-dep-claim-chart: the dependents, after claim 1 is settled. Each
  // costs its re-evaluated / new rows only (one retrieval call when the chart
  // retrieves for itself, plus one analysis per target); inherited rows carry
  // claim 1's verdicts. Gated as its own spend before the first call.
  let family = null;
  if (scope.family && scope.family.members.length) {
    const n = scope.family.members.length;
    const calls = [];
    for (let i = 0; i < n; i++) {
      if (!args.targets) calls.push({ inChars: 2500, outTokens: 600 });
      for (let k = 0; k < 3; k++) calls.push({ inChars: 9000, outTokens: 900 });
    }
    if (!claimsCostGate(model, calls, `claim-chart family: ${n} dependent claim(s)`, args)) {
      process.stderr.write('[claim-chart] family pass declined by the cost gate; claim 1 charted alone.\n');
    } else {
      process.stderr.write(`[claim-chart] family: ${n} dependent claim(s) beneath claim ${scope.family.root}\n`);
      family = await chartFamily({
        index, symbols, draft, args, scope, rootElements: elements, rootFills: fills, targetsSupplied: !!args.targets,
        onProgress: (line) => process.stderr.write(line + '\n'),
      });
    }
  }

  console.log(formatChart({
    claimText, table, fills, elements, engineLabel, scopeNote, provenance,
    targets: perTarget.map((p) => p.target),
    dropped, retrieval, connectivity, sideScope, otherSideElements, citedDupes,
  }) + (family ? formatFamilySection(family) + '\n' : ''));

  // The sidecar's family block: per dependent, every row with its origin and
  // verdict, and the raw per-target analyses of the judged rows -- what the
  // loop test grades. Appended to the file written above so the claim-1 half
  // stays exactly the shape replay tools already read.
  if (family && args.verdicts_out && !process.exitCode) {
    try {
      const j = JSON.parse(fs.readFileSync(args.verdicts_out, 'utf8'));
      j.family = {
        root: family.root,
        members: family.members.map((d) => ({
          n: d.n, depth: d.depthLabel, kind: d.kind, cue: d.cue, parent: d.parent, chain: d.chain,
          parentChoice: d.parentChoice ? { policy: d.parentChoice.policy, chosen: d.parentChoice.chosen, alternatives: d.parentChoice.alternatives } : null,
          verdict: d.verdictLine,
          rows: d.effective.map((r) => ({
            designation: r.designation, origin: r.origin, text: r.text,
            ...(r.origin === 'inherited' ? { from: r.from, parentDesignation: r.parentDesignation } : {}),
            ...(r.origin === 'narrowed' ? { narrows: r.narrows, parentLabel: r.parentLabel, own: r.own } : {}),
            ...(r.ambiguous ? { ambiguous: r.ambiguous } : {}),
            label: r.label, note: r.note || '', target: r.target || null,
          })),
          analysed: d.analysed.map((a) => ({ target: a.target, elements: a.elements.map((e) => ({ element: e.element ?? null, text: e.text ?? '', label: e.label, note: e.note || '' })) })),
          dropped: d.dropped,
        })),
      };
      fs.writeFileSync(args.verdicts_out, `${JSON.stringify(j, null, 2)}\n`, 'utf8');
      console.log(`Family block added to ${args.verdicts_out} (${family.members.length} dependent claim(s)).`);
    } catch (e) {
      console.error(`--verdicts-out: cannot add the family block to ${args.verdicts_out}: ${e.message}`);
      process.exitCode = 1;
    }
  }
  const cost = actualCostLine(model);
  if (cost) process.stderr.write(cost + '\n');
  return { fills, elements: elements.length, targets: perTarget.length, family: family ? family.members.length : 0 };
}
