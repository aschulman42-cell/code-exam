// ============================================================================
// claims-loop.js — #290 harness: fill pseudo-claim chart cells and measure
// draft<->retrieve agreement, from a finished chart + the candidates .lst
// that produced it.
//
//   ce --index-path IDX --claims-loop <chart.md> --candidates <cand.lst> \
//      --model <gguf> [--loop-k 3]
//
// Emits <chart>_looped.md (input never mutated) + a run summary. Design is
// soak-calibrated (62 claims, 2026-07-31, soak_out/assessment_rows.json):
//
//   1. ANCHORED element mapping (primary fill): analyze the claim against its
//      own group's namesake function first, then further members (K total),
//      with the shipped buildClaimAnalyzePrompt rubric. Best label per claim
//      element wins; PRESENT/PARTIAL fill empty chart cells with explicit
//      "(loop: ...)" provenance — an LLM semantic judgment, NOT the
//      mechanical grounding the chart's "grounded" means.
//   2. RETRIEVAL (secondary): local term extraction + multisect per claim,
//      with SPONGE SUPPRESSION — a function hitting more than spongeT
//      distinct claims' searches is a vocabulary sponge (printUsage,
//      x265_param: help text and parsers match everything) and is demoted.
//      Survivors give cross-group cite candidates + the agreement metric.
//   3. CONVERGENCE flags: ABSENT-heavy against its own anchors AND
//      retrieval-silent -> "Needs redraft" — the #290 disagreement signal.
//
// One model load for the whole run (llm-runner drafter, #293 pattern).
// ============================================================================

import fs from 'node:fs';
import { resolveModel, makeDrafter, claimsCostGate, actualCostLine, resetCloudUsage } from '../core/llm-runner.js';
import { buildClaimAnalyzePrompt } from './analyze.js';
import {
  CLAIM_EXTRACTION_PROMPT_LOCAL, buildLocalExtractionPromptWithVocab,
  parseTermResponse, sanitizeLlmTerms, dropStopListedTerms, extractClaimKeywords,
} from './claim.js';
import { parseMultisectTerms } from './multisect.js';

export const LOOP_DEFAULTS = { loopK: 3, spongeT: 2, minTermsFrac: 0.75 };

// --- chart parsing ----------------------------------------------------------

// Parse "## Pseudo-claim N — LABEL  (Pn)" sections out of a chart .md.
// Returns [{ n, label, prio, claimText, headStart }] (headStart = char offset
// of the section heading, used by the writeback pass).
export function parseChartClaims(chartText) {
  const out = [];
  const re = /^## Pseudo-claim (\d+) — (.*?)\s+\((P\d)\)\s*$/gm;
  let m;
  while ((m = re.exec(chartText)) !== null) {
    const secEnd = chartText.indexOf('\n## ', m.index + 4);
    const section = chartText.slice(m.index, secEnd === -1 ? chartText.length : secEnd);
    const body = section.split(/^### Claim chart/m)[0];
    const pm = body.match(/\*\*\[PSEUDO-CLAIM[^\]]*\]\*\*\s*([\s\S]*?)\s*$/);
    if (!pm) continue;
    out.push({ n: Number(m[1]), label: m[2].trim(), prio: m[3], claimText: pm[1].trim(), headStart: m.index });
  }
  return out;
}

// Parse a ranked candidates .lst into Map(label -> members[]). Group headers
// look like "# LABEL  (12 fns)  [P3 ...]"; member lines follow, one per line.
export function parseCandidateGroups(lstText) {
  const groups = new Map();
  let cur = null;
  for (const line of lstText.split(/\r?\n/)) {
    const h = line.match(/^# (.*?)\s+\((\d+) fns?\)\s+\[P/);
    if (h) { cur = []; groups.set(h[1].trim(), cur); continue; }
    if (line.startsWith('#')) continue;
    if (!line.trim()) { cur = null; continue; }
    if (cur) cur.push(line.trim());
  }
  return groups;
}

const isDocAnchor = (m) => /@L\d+(-\d+)?$/.test(m);
const memberName = (m) => m.slice(m.indexOf('@') + 1);
const bareName = (n) => n.replace(/^.*::/, '');
const kw = (s) => new Set(String(s).toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) || []);

// --- lexical stems (#290 precision tuning) ----------------------------------
// Suffix-stripped stems of claim/element keywords, matched as SUBSTRINGS
// against identifier-dense code — element "tracing" must match a body's
// __bramIframeTrace. Stems shorter than 4 chars are dropped as too noisy.

export function lexicalStems(text) {
  const out = new Set();
  for (const w of kw(text)) {
    // "ssion" before "sion": submission -> "submi" (matches submit/submitted);
    // plain "sion" would leave "submis", which matches neither.
    const s = w.replace(/(?:ssion|sion|tion|ing|ment|ed|es|s)$/, '');
    if (s.length >= 4) out.add(s);
  }
  return out;
}

export function stemMatches(stems, haystack) {
  const h = String(haystack).toLowerCase();
  let n = 0;
  for (const s of stems) if (h.includes(s)) n += 1;
  return n;
}

// Lexical gate on fills: a PRESENT/PARTIAL whose element text shares no
// vocabulary with the analyzed function (name+body) is a drift-stretch —
// the audited claim-4 PARTIALs ("bundle path" vs a spinner decider) had
// zero overlap. Downgrade to ASSUMED (fills accept only PRESENT/PARTIAL,
// so gated results reach the footnote at most, never a cell). The bar
// adapts to short elements: min(LEXICAL_GATE_MIN, usable stems).
export const LEXICAL_GATE_MIN = 2;
export function lexicalGate(label, elemText, fnPlusSrc, min = LEXICAL_GATE_MIN) {
  if (label !== 'PRESENT' && label !== 'PARTIAL') return label;
  const stems = lexicalStems(elemText);
  const needed = Math.min(min, stems.size);
  if (needed === 0) return label; // nothing to judge with
  return stemMatches(stems, fnPlusSrc) >= needed ? label : 'ASSUMED';
}

// Anchors to analyze for a group: the NAMESAKE function first (the name in
// the label's trailing parens — the soak's first-member heuristic picked the
// namesake only 4/62 times, so this ordering is the cheap accuracy lever),
// then remaining code members ranked by lexical overlap with the claim text
// (#290 precision tuning: "inferring pipelines" reaches listPipelines even
// when it is member #14 — blind .lst order never did). Name matches weigh
// double; body overlap counts when the caller supplies srcLookup. Ties keep
// .lst order (stable sort), and no claimText degrades to plain .lst order.
export function pickAnchors(label, members, k, claimText = '', srcLookup = null) {
  const code = (members || []).filter((m) => m.includes('@') && !isDocAnchor(m));
  const nm = label.match(/\(([^)]+)\)\s*$/);
  const ordered = [];
  if (nm) {
    const want = bareName(nm[1].trim());
    const hit = code.find((m) => bareName(memberName(m)) === want)
      || code.find((m) => memberName(m).includes(want));
    if (hit) ordered.push(hit);
  }
  const rest = code.filter((m) => !ordered.includes(m));
  const stems = claimText ? lexicalStems(claimText) : null;
  if (stems && stems.size) {
    const scored = rest.map((m) => {
      let s = 2 * stemMatches(stems, memberName(m));
      if (srcLookup) {
        const src = srcLookup(m);
        if (src) s += stemMatches(stems, String(src).slice(0, 4000));
      }
      return [s, m];
    });
    scored.sort((a, b) => b[0] - a[0]);
    for (const [, m] of scored) { if (ordered.length >= k) break; ordered.push(m); }
  } else {
    for (const m of rest) { if (ordered.length >= k) break; ordered.push(m); }
  }
  return ordered.slice(0, k);
}

// --- analysis-output parsing ------------------------------------------------

const LABEL_RANK = { ABSENT: 0, ASSUMED: 1, PARTIAL: 2, PRESENT: 3 };

// Tolerant label parse. Gemma emits labels three ways (all seen in the soak):
// a "Claim coverage: N PRESENT, ..." summary line, inline **PRESENT** bolds,
// or "Label: PRESENT" lines. Returns { counts, elements } where elements is
// [{ text, label }] — one per analyzed element block, text being the block's
// element prose (used to match chart table rows by keyword overlap).
export function parseAnalysisLabels(text) {
  const counts = { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 };
  const cov = text.match(/(?:Claim )?coverage(?: summary)?:?[^\n]*/i);
  const covLine = cov && /\d+\s+(PRESENT|PARTIAL|ABSENT|ASSUMED)/i.test(cov[0]) ? cov[0] : null;
  if (covLine) {
    for (const k of Object.keys(counts)) {
      const m = covLine.match(new RegExp(`(\\d+)\\s+${k}`, 'i'));
      if (m) counts[k] = Number(m[1]);
    }
  }

  // Element blocks: numbered items or "Claim Element N" headings. The digit
  // may be bold-wrapped ("**1. Scanning…**" — observed from both Claude and
  // 12B): without the leading \*{0,2} the whole analysis collapsed into ONE
  // block, one fill per anchor, matched by the wrong element text (the CE
  // claim-2 row-3 miss in the tuning gate).
  const elements = [];
  const blocks = text.split(/^(?=\s*(?:\*{0,2}\d+\.\s|\*{0,2}(?:Claim )?Element\s+\d))/mi).slice(0, 24);
  for (const b of blocks) {
    const lm = [...b.matchAll(/(?:Label:?\**\s*\**|\*\*)(PRESENT|PARTIAL|ABSENT|ASSUMED)\b/gi)];
    if (!lm.length) continue;
    const label = lm[lm.length - 1][1].toUpperCase();
    const text0 = b.replace(/[*#`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
    elements.push({ text: text0, label });
  }
  if (!covLine) for (const e of elements) counts[e.label]++;
  return { counts, elements };
}

// --- retrieval + sponge suppression ----------------------------------------

// A function whose name tops the search hits of more than spongeT distinct
// claims is a vocabulary sponge. Returns the Set of sponge names.
export function detectSponges(hitsPerClaim, spongeT = LOOP_DEFAULTS.spongeT) {
  const claimsPerFn = new Map();
  for (const [id, hits] of hitsPerClaim) {
    for (const name of new Set(hits.map((h) => h.name))) {
      if (!claimsPerFn.has(name)) claimsPerFn.set(name, new Set());
      claimsPerFn.get(name).add(id);
    }
  }
  const sponges = new Set();
  for (const [name, ids] of claimsPerFn) if (ids.size > spongeT) sponges.add(name);
  return sponges;
}

export function hitInGroup(hit, members) {
  const names = new Set((members || []).filter((m) => m.includes('@') && !isDocAnchor(m)).map((m) => bareName(memberName(m))));
  const b = bareName(hit.name).replace(/@\d+$/, '');
  return names.has(b) || [...names].some((g) => g === hit.name || hit.name.endsWith(`::${g}`));
}

// --- chart writeback --------------------------------------------------------

// Fill empty cite cells in one claim's section. fills = [{ text, label,
// target }] (PRESENT/PARTIAL only). Matching mirrors formatClaimChart's
// keyword overlap; unmatched fills go to a footnote. Returns the new section.
export function fillChartSection(section, fills) {
  if (!fills.length) return section;
  const lines = section.split('\n');
  const rowIdx = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\| \d+ \| (.*?) \|(\s*)\|\s*$/);
    if (m) rowIdx.push({ i, elemKw: kw(m[1]) });
  }
  const unmatched = [];
  for (const f of fills) {
    const fk = kw(f.text);
    let best = null, score = 0;
    for (const r of rowIdx) {
      let s = 0; for (const w of fk) if (r.elemKw.has(w)) s += 1;
      if (s > score) { score = s; best = r; }
    }
    const cite = `\`${f.target}\` _(loop: ${f.label})_`;
    if (best && score >= 2) {
      lines[best.i] = lines[best.i].replace(/\|(\s*)\|\s*$/, `| ${cite} |`);
      rowIdx.splice(rowIdx.indexOf(best), 1); // one fill per empty row
    } else {
      unmatched.push(cite);
    }
  }
  let out = lines.join('\n');
  if (unmatched.length) {
    out += `\n_Loop result(s) not matched to a specific element: ${unmatched.join(', ')}._\n`;
  }
  return out;
}

// Convergence flag: ABSENT-heavy against the claim's own anchors AND no
// surviving retrieval hit inside the group.
export function needsRedraft(counts, inGroupSurvivors) {
  const labeled = counts.PRESENT + counts.PARTIAL + counts.ABSENT + counts.ASSUMED;
  const absHeavy = counts.PRESENT === 0 && counts.ABSENT >= Math.max(1, Math.floor(labeled / 2));
  return absHeavy && inGroupSurvivors === 0;
}

// --- redraft (issue-290-loop-redraft: the "back" half of draft<->retrieve) ---

// A claim redrafts when >=1 element's best label is ABSENT, or the
// needs-redraft flag fired. ASSUMED does not trigger — "implementation
// plausibly elsewhere" is not a language defect.
export function redraftTriggered(bestLabels, flagged) {
  return !!flagged || (bestLabels || []).includes('ABSENT');
}

// Coverage comparison for accept-best: primary = elements at PRESENT/PARTIAL,
// tie-break = summed label rank. The redraft is kept only if STRICTLY better.
export function coverageScore(labels) {
  let geq = 0, sum = 0;
  for (const l of labels || []) {
    sum += LABEL_RANK[l] ?? 0;
    if (l === 'PRESENT' || l === 'PARTIAL') geq += 1;
  }
  return { geq, sum };
}
export function betterCoverage(a, b) {
  return a.geq > b.geq || (a.geq === b.geq && a.sum > b.sum);
}

// The redraft prompt. Discipline lives here: grounded language is preserved
// verbatim, ABSENT elements are rewritten to describe the code, and dropping
// beats inventing.
export function buildRedraftPrompt(claimText, verdicts, sources) {
  const sys = [
    'You revise a draft patent-style claim so it accurately describes the provided code.',
    'Rules:',
    '- PRESERVE verbatim every element listed as PRESENT or PARTIAL — that language is grounded in the code.',
    '- REWRITE each element listed as ABSENT so it describes what the code actually does.',
    '- If no code supports an element, DROP the element rather than inventing code that is not there.',
    '- Keep the preamble\'s mechanism intent and the "A method/apparatus for ... comprising:" shape,',
    '  elements separated by semicolons.',
    'Reply with exactly "CLAIM:" followed by the revised claim text. No other output.',
  ].join('\n');
  const v = (verdicts || []).map((x) => `- [${x.label}] ${x.text}`).join('\n');
  const user = `ORIGINAL CLAIM:\n${claimText}\n\nELEMENT VERDICTS (from analysis against the code below):\n${v}\n\nCODE:\n${sources}`;
  return { sys, user };
}

export function parseRedraft(text) {
  const m = String(text || '').match(/CLAIM:\s*([\s\S]*)/i);
  if (!m) return null;
  const prose = m[1].trim().replace(/\s+/g, ' ');
  return prose.length > 40 ? prose : null;
}

// An empty claim-chart table for redrafted prose (preamble to the first ':',
// elements on ';') — fillChartSection then populates the cells.
export function emptyChartTable(prose) {
  const text = String(prose || '').trim();
  const ci = text.indexOf(':');
  const preamble = ci >= 0 ? text.slice(0, ci + 1).trim() : '';
  const body = ci >= 0 ? text.slice(ci + 1) : text;
  const elements = body.split(';').map((e) => e.trim().replace(/[.\s]+$/, '')).filter(Boolean);
  const lines = ['| # | Claim element / step | Cited code |', '|---|---|---|'];
  let n = 0;
  if (preamble) { n += 1; lines.push(`| ${n} | ${preamble.replace(/\|/g, '\\|')} | _Preamble_ |`); }
  for (const e of elements) { n += 1; lines.push(`| ${n} | ${e.replace(/\|/g, '\\|')} |  |`); }
  return lines.join('\n');
}

// --- the command ------------------------------------------------------------

export async function doClaimsLoop(index, args, opts = {}) {
  const chartPath = args.claims_loop;
  const candPath = args.candidates;
  if (!chartPath || !candPath) {
    console.log('--claims-loop needs both the chart and its candidates list:');
    console.log('  --claims-loop <chart.md> --candidates <cand.lst> --model <gguf>');
    return;
  }
  let chartText, lstText;
  try { chartText = fs.readFileSync(chartPath, 'utf8'); }
  catch (e) { console.log(`Cannot read chart: ${e.message}`); return; }
  try { lstText = fs.readFileSync(candPath, 'utf8'); }
  catch (e) { console.log(`Cannot read candidates: ${e.message}`); return; }

  const model = resolveModel(args);
  if (!model) { console.log('--claims-loop needs a model: --model <gguf> or --llm <provider>.'); return; }
  if (model.kind === 'error') { console.log(`Error: ${model.error}`); return; }
  const draft = opts.draft || makeDrafter(model, args.temperature ?? 0);

  const claims = parseChartClaims(chartText);
  const groups = parseCandidateGroups(lstText);
  const loopK = Number(args.loop_k) || LOOP_DEFAULTS.loopK;
  if (!claims.length) { console.log('No pseudo-claims found in the chart.'); return; }
  // #290 precision tuning: --loop-save-analyses keeps every raw per-anchor
  // analysis on disk so any fill can be audited against the model's own
  // justification (the first audit had to re-derive them by hand).
  let saveDir = null;
  if (args.loop_save_analyses) {
    saveDir = chartPath.replace(/\.md$/i, '') + '_looped_analyses';
    fs.mkdirSync(saveDir, { recursive: true });
  }
  // pseudo-claims-cost-guard: pre-walk the anchors (string ops only — no LLM)
  // so the projection reflects the actual function sources to be analyzed.
  // Out-token estimates are EXPECTED output, not maxTokens ceilings (term
  // extraction emits ~2 short lines, nowhere near its 2048 cap).
  {
    const calls = [];
    for (const c of claims) {
      const members = groups.get(c.label) || [];
      const look = (m) => {
        const i2 = m.indexOf('@');
        try { return index.getFunctionSource(m.slice(0, i2), m.slice(i2 + 1)); } catch { return null; }
      };
      for (const anchor of pickAnchors(c.label, members, loopK, c.claimText, look)) {
        const src = look(anchor);
        if (src) calls.push({ inChars: src.length + c.claimText.length + 1600, outTokens: 800 });
      }
      calls.push({ inChars: c.claimText.length + 3000, outTokens: 150 }); // term extraction
    }
    if (!claimsCostGate(model, calls, `claims-loop ${claims.length} claims × K=${loopK}`, args)) return;
  }
  resetCloudUsage();
  process.stderr.write(`# claims-loop: ${claims.length} claims, K=${loopK}, model=${model.modelPath || model.label}\n`);

  const srcLookup = (m) => {
    const i2 = m.indexOf('@');
    try { return index.getFunctionSource(m.slice(0, i2), m.slice(i2 + 1)); } catch { return null; }
  };

  // One anchored element-mapping pass over a claim text: analyze each anchor,
  // gate labels lexically, keep best-per-element. Shared by pass 1 and the
  // redraft phase's re-analysis (issue-290-loop-redraft).
  const anchoredPass = async (claimTag, claimText, anchorSpecs, savePrefix) => {
    const res = { counts: { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 }, best: new Map(), perAnchor: [], gatedCount: 0 };
    for (const anchor of anchorSpecs) {
      const at = anchor.indexOf('@');
      const fp = anchor.slice(0, at), fn = anchor.slice(at + 1);
      const src = srcLookup(anchor);
      if (!src) continue;
      let out;
      try { out = await draft(buildClaimAnalyzePrompt(src, fn, fp, claimText, false), '', 800); }
      catch (e) { process.stderr.write(`#   [${claimTag}] draft error on ${fn}: ${e.message}\n`); continue; }
      if (saveDir) {
        const safe = bareName(fn).replace(/[^A-Za-z0-9_]/g, '_');
        fs.writeFileSync(`${saveDir}/${savePrefix}_${safe}.txt`, `# ${anchor}\n# claim ${claimTag}\n\n${out || ''}\n`);
      }
      const parsed = parseAnalysisLabels(out || '');
      // Apply the lexical gate per element, then derive counts from the GATED
      // labels when element blocks exist (the gate must be visible to the
      // needs-redraft threshold — a drift claim whose PRESENTs are all gated
      // away should flag). Coverage-line counts are the fallback when the
      // model emitted no parseable element blocks.
      const gated = parsed.elements.map((e) => {
        const label = lexicalGate(e.label, e.text, fn + '\n' + src);
        if (label !== e.label) res.gatedCount += 1;
        return { ...e, label };
      });
      const counts = { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 };
      if (gated.length) for (const e of gated) counts[e.label]++;
      else for (const k of Object.keys(counts)) counts[k] = parsed.counts[k];
      res.perAnchor.push({ anchor, counts });
      for (const k of Object.keys(res.counts)) res.counts[k] += counts[k];
      for (const e of gated) {
        const key = [...kw(e.text)].sort().join(' ');
        const prev = res.best.get(key);
        if (!prev || LABEL_RANK[e.label] > LABEL_RANK[prev.label]) {
          res.best.set(key, { text: e.text, label: e.label, target: `${fp.split('!').pop()}@${bareName(fn)}` });
        }
      }
    }
    return res;
  };

  // Retrieval for a claim text: local term extraction + multisect. Shared by
  // pass 1 and the redraft phase's convergence re-measurement.
  const retrievalPass = async (claimText) => {
    let vocab = '';
    try {
      // topN selects which compounds get SPLIT; maxSubTokens caps what is
      // EMITTED. They are independent, so a large topN costs build time only
      // (~3ms -> ~20-58ms at 15000), never prompt budget. 15000 is not a tuned
      // number: vocabulary.js caps the cached vocabulary at slice(0, 15000), so
      // it means 'the whole vocabulary' -- do not pre-truncate, let the
      // cross-corpus weight select. Matches claim.js, analyze.js and both
      // server.js routes; this site was missed in aa2bdc9 because it uses
      // optional chaining (`formatVocabularyForPrompt?.(`) and the audit grep
      // searched for identifier-plus-paren.
      vocab = index.formatVocabularyForPrompt?.('compact', {
        topN: 15000, maxSubTokens: 80, maxFuncNames: 0, claimKeywords: extractClaimKeywords(claimText),
      }) || '';
    } catch { /* vocabulary optional */ }
    const sys = vocab ? buildLocalExtractionPromptWithVocab(vocab, false) : CLAIM_EXTRACTION_PROMPT_LOCAL;
    const raw = await draft(sys, 'Extract search terms from this patent claim:\n\n' + claimText, 2048);
    let tight = parseTermResponse(raw || '').tight || '';
    tight = sanitizeLlmTerms(dropStopListedTerms(tight, 'TIGHT'), 'TIGHT');
    const terms = tight ? parseMultisectTerms(tight) : null;
    if (!terms) return [];
    const pos = terms.filter((t) => !t.negated).length;
    const res = index.multisectSearch(terms, { minTerms: Math.max(2, Math.floor(pos * LOOP_DEFAULTS.minTermsFrac)) });
    return (res?.function_matches || []).filter((f) => f.function !== '(global)')
      .map((f) => ({ name: f.function, filepath: f.filepath, k: f.terms_matched }));
  };

  // Pass 1: per-claim anchored analysis + retrieval hit collection.
  const perClaim = [];
  const hitsPerClaim = new Map();
  for (const c of claims) {
    const members = groups.get(c.label) || null;
    const rec = { ...c, members, anchors: [], counts: { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 }, best: new Map(), hits: [] };
    if (!members) process.stderr.write(`#   [c${c.n}] group not found in .lst: "${c.label}"\n`);

    // Stage 1 — anchored element mapping.
    rec.anchorSpecs = pickAnchors(c.label, members || [], loopK, c.claimText, srcLookup);
    const a = await anchoredPass(`c${c.n}: ${c.label}`, c.claimText, rec.anchorSpecs, `c${c.n}`);
    rec.anchors = a.perAnchor;
    rec.counts = a.counts;
    rec.best = a.best;
    rec.gatedCount = a.gatedCount;

    // Stage 2 — retrieval (local term extraction + multisect).
    try { rec.hits = await retrievalPass(c.claimText); }
    catch (e) { process.stderr.write(`#   [c${c.n}] retrieval error: ${e.message}\n`); }
    hitsPerClaim.set(c.n, rec.hits);
    perClaim.push(rec);
    const t = rec.counts;
    process.stderr.write(`#   [c${c.n}] ${c.label.slice(0, 40)}  anchors=${rec.anchors.length} P=${t.PRESENT}/Pa=${t.PARTIAL}/Ab=${t.ABSENT}/As=${t.ASSUMED} gated=${rec.gatedCount || 0} hits=${rec.hits.length}\n`);
  }

  // Pass 2a: sponge suppression, agreement, convergence flags.
  const spongeT = Number(args.sponge_t) || LOOP_DEFAULTS.spongeT;
  const sponges = detectSponges(hitsPerClaim, spongeT);
  let agree = 0;
  const flagged = [];
  for (const rec of perClaim) {
    rec.survivors = rec.hits.filter((h) => !sponges.has(h.name));
    rec.inGroup = rec.survivors.filter((h) => hitInGroup(h, rec.members)).length;
    if (rec.inGroup > 0) agree += 1;
    rec.crossGroup = rec.survivors.filter((h) => !hitInGroup(h, rec.members)).slice(0, 3);
    rec.flagged = needsRedraft(rec.counts, rec.inGroup);
    if (rec.flagged) flagged.push(rec);
  }

  // Pass 2b: redraft (issue-290-loop-redraft) — ONE cycle, accept-best.
  // Feed the anchored verdicts back to the drafter for triggered claims,
  // re-analyze the new language against the same anchors, keep the redraft
  // only if element coverage strictly improves. Second cost gate here: the
  // triggered count is now known deterministically.
  const redrafts = { accepted: [], rejected: [], gateSkipped: false };
  if (args.loop_redraft) {
    const triggered = perClaim.filter((r) => r.members && r.anchorSpecs?.length
      && redraftTriggered([...r.best.values()].map((b) => b.label), r.flagged));
    if (triggered.length) {
      const calls = [];
      for (const r of triggered) {
        const srcChars = r.anchorSpecs.reduce((n, a2) => n + (srcLookup(a2)?.length || 0), 0);
        calls.push({ inChars: srcChars + r.claimText.length + 1200, outTokens: 400 }); // redraft
        for (const a2 of r.anchorSpecs) calls.push({ inChars: (srcLookup(a2)?.length || 0) + r.claimText.length + 1600, outTokens: 800 }); // re-analysis
        calls.push({ inChars: r.claimText.length + 3000, outTokens: 150 }); // convergence retrieval
      }
      if (!claimsCostGate(model, calls, `redraft ${triggered.length} claims`, args)) {
        redrafts.gateSkipped = true;
        process.stderr.write(`#   redraft phase skipped by cost gate (${triggered.length} triggered)\n`);
      } else {
        for (const r of triggered) {
          const sources = r.anchorSpecs.map((a2) => srcLookup(a2) || '').filter(Boolean).join('\n\n').slice(0, 48000);
          const { sys, user } = buildRedraftPrompt(r.claimText, [...r.best.values()], sources);
          let prose = null;
          try { prose = parseRedraft(await draft(sys, user, 700)); }
          catch (e) { process.stderr.write(`#   [c${r.n}] redraft error: ${e.message}\n`); }
          if (!prose) { redrafts.rejected.push({ rec: r, reason: 'no parseable redraft' }); continue; }
          const re = await anchoredPass(`c${r.n} redraft: ${r.label}`, prose, r.anchorSpecs, `c${r.n}_r2`);
          const oldScore = coverageScore([...r.best.values()].map((b) => b.label));
          const newScore = coverageScore([...re.best.values()].map((b) => b.label));
          if (betterCoverage(newScore, oldScore)) {
            let newHits = [];
            try { newHits = await retrievalPass(prose); } catch { /* convergence metric optional */ }
            const newInGroup = newHits.filter((h) => !sponges.has(h.name) && hitInGroup(h, r.members)).length;
            r.redraft = { prose, best: re.best, counts: re.counts, inGroup: newInGroup };
            redrafts.accepted.push(r);
          } else {
            redrafts.rejected.push({ rec: r, reason: 'coverage did not improve' });
          }
          const t2 = r.redraft ? r.redraft.counts : null;
          process.stderr.write(`#   [c${r.n}] redraft ${r.redraft ? `ACCEPTED P=${t2.PRESENT}/Pa=${t2.PARTIAL}/Ab=${t2.ABSENT}/As=${t2.ASSUMED}` : 'rejected'}\n`);
        }
      }
    }
  }

  // Pass 2c: writeback.
  const sections = [];
  let cursor = 0;
  for (let i = 0; i < perClaim.length; i++) {
    const rec = perClaim[i];
    const secStart = rec.headStart;
    const secEnd = i + 1 < perClaim.length ? perClaim[i + 1].headStart : chartText.length;
    if (secStart > cursor) sections.push(chartText.slice(cursor, secStart));
    cursor = secEnd;
    const original = chartText.slice(secStart, secEnd);
    let section;

    if (rec.redraft) {
      // Accepted redraft: new language + fresh chart, original preserved for
      // audit. The heading line is reused verbatim from the original section.
      const heading = original.split('\n')[0];
      const rewritten = [...rec.redraft.best.values()].filter((f) => f.label === 'PRESENT' || f.label === 'PARTIAL');
      const table = fillChartSection(emptyChartTable(rec.redraft.prose), rewritten);
      section = [
        heading, '',
        `_Redrafted by the claims-loop (#290 draft↔retrieve convergence): ABSENT elements rewritten to match the anchored code; grounded language preserved. Original claim below for audit._`, '',
        rec.redraft.prose, '',
        '### Claim chart (loop-redrafted)', '',
        table, '',
        `> Original claim (pre-redraft): ${rec.claimText.replace(/\n/g, ' ')}`, '', '',
      ].join('\n');
    } else {
      let s2 = original;
      const fills = [...rec.best.values()].filter((f) => f.label === 'PRESENT' || f.label === 'PARTIAL');
      s2 = fillChartSection(s2, fills);
      section = s2;
    }

    const noteBits = [];
    if (rec.crossGroup.length) noteBits.push(`cross-group candidate(s): ${rec.crossGroup.map((h) => `\`${h.name}\``).join(', ')}`);
    if (rec.hits.length && !rec.survivors.length) noteBits.push('all retrieval hits were vocabulary sponges');
    if (noteBits.length) section = section.trimEnd() + `\n\n_Loop retrieval (sponge-filtered): ${noteBits.join('; ')}._\n\n`;
    sections.push(section);
  }
  sections.push(chartText.slice(cursor));

  const summary = [
    '',
    '## Claims-loop summary',
    '',
    `_Cells marked \`(loop: PRESENT|PARTIAL)\` were filled by the claims-loop: an LLM judged the element against the claim's own group functions (anchored element mapping). That is a **semantic judgment**, not the mechanical index grounding of the drafter's cites — verify independently._`,
    '',
    `- Claims processed: ${perClaim.length} (anchors per claim: up to ${loopK}, namesake first, lexical member pre-rank)`,
    `- Agreement (retrieval, sponge-filtered, hit-in-own-group): ${agree}/${perClaim.length}`,
    `- Vocabulary sponges suppressed (topped >${spongeT} claims): ${[...sponges].map((s) => `\`${s}\``).join(', ') || '(none)'}`,
    `- Lexical gate downgraded ${perClaim.reduce((n, r) => n + (r.gatedCount || 0), 0)} PRESENT/PARTIAL result(s) to ASSUMED (no element↔function vocabulary overlap)`,
    '',
  ];
  if (args.loop_redraft) {
    if (redrafts.accepted.length) {
      const conv = redrafts.accepted.filter((r) => r.redraft.inGroup > 0).length;
      const convWas = redrafts.accepted.filter((r) => r.inGroup > 0).length;
      summary.push('### Redrafted (coverage improved; original preserved in-section)', '');
      for (const r of redrafts.accepted) {
        const t = r.redraft.counts;
        summary.push(`- Pseudo-claim ${r.n} — ${r.label} (now P=${t.PRESENT}/Pa=${t.PARTIAL}/Ab=${t.ABSENT}/As=${t.ASSUMED})`);
      }
      summary.push('', `- Convergence: ${conv}/${redrafts.accepted.length} accepted redrafts retrieve their own group (originals: ${convWas}/${redrafts.accepted.length})`, '');
    }
    if (redrafts.rejected.length) {
      summary.push('### Redraft rejected (kept original)', '');
      for (const x of redrafts.rejected) summary.push(`- Pseudo-claim ${x.rec.n} — ${x.rec.label} (${x.reason})`);
      summary.push('');
    }
    if (redrafts.gateSkipped) summary.push('_Redraft phase skipped by the cost gate — re-run with --force or a higher CE_CLAIMS_COST_GUARD._', '');
  }
  const stillFlagged = flagged.filter((r) => !r.redraft);
  if (stillFlagged.length) {
    summary.push('### Needs redraft (ABSENT-heavy vs own anchors, retrieval-silent)', '');
    for (const r of stillFlagged) summary.push(`- Pseudo-claim ${r.n} — ${r.label}`);
    summary.push('');
  }

  const outPath = chartPath.replace(/\.md$/i, '') + '_looped.md';
  fs.writeFileSync(outPath, sections.join('') + summary.join('\n'));
  const loopCost = actualCostLine(model);
  if (loopCost) console.log(loopCost);
  console.log(`# claims-loop: wrote ${outPath}`);
  console.log(`#   filled from anchored analysis; agreement ${agree}/${perClaim.length}; sponges: ${[...sponges].join(', ') || 'none'}; needs-redraft: ${flagged.length}${args.loop_redraft ? `; redrafted: ${redrafts.accepted.length} (rejected ${redrafts.rejected.length})` : ''}`);
  return { outPath, perClaim, sponges, agree, flagged, redrafts };
}
