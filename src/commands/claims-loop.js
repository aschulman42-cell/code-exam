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
import { resolveModel, makeDrafter } from '../core/llm-runner.js';
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
  process.stderr.write(`# claims-loop: ${claims.length} claims, K=${loopK}, model=${model.modelPath || model.label}\n`);

  // Pass 1: per-claim anchored analysis + retrieval hit collection.
  const perClaim = [];
  const hitsPerClaim = new Map();
  for (const c of claims) {
    const members = groups.get(c.label) || null;
    const rec = { ...c, members, anchors: [], counts: { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 }, best: new Map(), hits: [] };
    if (!members) process.stderr.write(`#   [c${c.n}] group not found in .lst: "${c.label}"\n`);

    // Stage 1 — anchored element mapping.
    const srcLookup = (m) => {
      const i2 = m.indexOf('@');
      try { return index.getFunctionSource(m.slice(0, i2), m.slice(i2 + 1)); } catch { return null; }
    };
    for (const anchor of pickAnchors(c.label, members || [], loopK, c.claimText, srcLookup)) {
      const at = anchor.indexOf('@');
      const fp = anchor.slice(0, at), fn = anchor.slice(at + 1);
      let src = null;
      try { src = index.getFunctionSource(fp, fn); } catch { /* fall through */ }
      if (!src) continue;
      let out;
      try { out = await draft(buildClaimAnalyzePrompt(src, fn, fp, c.claimText, false), '', 800); }
      catch (e) { process.stderr.write(`#   [c${c.n}] draft error on ${fn}: ${e.message}\n`); continue; }
      if (saveDir) {
        const safe = bareName(fn).replace(/[^A-Za-z0-9_]/g, '_');
        fs.writeFileSync(`${saveDir}/c${c.n}_${safe}.txt`, `# ${anchor}\n# claim c${c.n}: ${c.label}\n\n${out || ''}\n`);
      }
      const parsed = parseAnalysisLabels(out || '');
      // Apply the lexical gate per element, then derive counts from the GATED
      // labels when element blocks exist (the gate must be visible to the
      // needs-redraft threshold — a drift claim whose PRESENTs are all gated
      // away should flag). Coverage-line counts are the fallback when the
      // model emitted no parseable element blocks.
      const gated = parsed.elements.map((e) => {
        const label = lexicalGate(e.label, e.text, fn + '\n' + src);
        if (label !== e.label) rec.gatedCount = (rec.gatedCount || 0) + 1;
        return { ...e, label };
      });
      const counts = { PRESENT: 0, PARTIAL: 0, ABSENT: 0, ASSUMED: 0 };
      if (gated.length) for (const e of gated) counts[e.label]++;
      else for (const k of Object.keys(counts)) counts[k] = parsed.counts[k];
      rec.anchors.push({ anchor, counts });
      for (const k of Object.keys(rec.counts)) rec.counts[k] += counts[k];
      for (const e of gated) {
        const key = [...kw(e.text)].sort().join(' ');
        const prev = rec.best.get(key);
        if (!prev || LABEL_RANK[e.label] > LABEL_RANK[prev.label]) {
          rec.best.set(key, { text: e.text, label: e.label, target: `${fp.split('!').pop()}@${bareName(fn)}` });
        }
      }
    }

    // Stage 2 — retrieval (local term extraction + multisect).
    try {
      let vocab = '';
      try {
        vocab = index.formatVocabularyForPrompt?.('compact', {
          topN: 200, maxSubTokens: 80, maxFuncNames: 0, claimKeywords: extractClaimKeywords(c.claimText),
        }) || '';
      } catch { /* vocabulary optional */ }
      const sys = vocab ? buildLocalExtractionPromptWithVocab(vocab, false) : CLAIM_EXTRACTION_PROMPT_LOCAL;
      const raw = await draft(sys, 'Extract search terms from this patent claim:\n\n' + c.claimText, 2048);
      let tight = parseTermResponse(raw || '').tight || '';
      tight = sanitizeLlmTerms(dropStopListedTerms(tight, 'TIGHT'), 'TIGHT');
      const terms = tight ? parseMultisectTerms(tight) : null;
      if (terms) {
        const pos = terms.filter((t) => !t.negated).length;
        const res = index.multisectSearch(terms, { minTerms: Math.max(2, Math.floor(pos * LOOP_DEFAULTS.minTermsFrac)) });
        rec.hits = (res?.function_matches || []).filter((f) => f.function !== '(global)')
          .map((f) => ({ name: f.function, filepath: f.filepath, k: f.terms_matched }));
      }
    } catch (e) {
      process.stderr.write(`#   [c${c.n}] retrieval error: ${e.message}\n`);
    }
    hitsPerClaim.set(c.n, rec.hits);
    perClaim.push(rec);
    const t = rec.counts;
    process.stderr.write(`#   [c${c.n}] ${c.label.slice(0, 40)}  anchors=${rec.anchors.length} P=${t.PRESENT}/Pa=${t.PARTIAL}/Ab=${t.ABSENT}/As=${t.ASSUMED} gated=${rec.gatedCount || 0} hits=${rec.hits.length}\n`);
  }

  // Pass 2: sponge suppression, agreement, writeback.
  const spongeT = Number(args.sponge_t) || LOOP_DEFAULTS.spongeT;
  const sponges = detectSponges(hitsPerClaim, spongeT);
  let agree = 0, flagged = [];
  const sections = [];
  let cursor = 0;
  for (let i = 0; i < perClaim.length; i++) {
    const rec = perClaim[i];
    const secStart = rec.headStart;
    const secEnd = i + 1 < perClaim.length ? perClaim[i + 1].headStart : chartText.length;
    if (secStart > cursor) sections.push(chartText.slice(cursor, secStart));
    cursor = secEnd;
    let section = chartText.slice(secStart, secEnd);

    const survivors = rec.hits.filter((h) => !sponges.has(h.name));
    const inGroup = survivors.filter((h) => hitInGroup(h, rec.members)).length;
    if (inGroup > 0) agree += 1;
    const crossGroup = survivors.filter((h) => !hitInGroup(h, rec.members)).slice(0, 3);

    const fills = [...rec.best.values()].filter((f) => f.label === 'PRESENT' || f.label === 'PARTIAL');
    section = fillChartSection(section, fills);
    const noteBits = [];
    if (crossGroup.length) noteBits.push(`cross-group candidate(s): ${crossGroup.map((h) => `\`${h.name}\``).join(', ')}`);
    if (rec.hits.length && !survivors.length) noteBits.push('all retrieval hits were vocabulary sponges');
    if (noteBits.length) section = section.trimEnd() + `\n\n_Loop retrieval (sponge-filtered): ${noteBits.join('; ')}._\n\n`;

    if (needsRedraft(rec.counts, inGroup)) flagged.push(rec);
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
  if (flagged.length) {
    summary.push('### Needs redraft (ABSENT-heavy vs own anchors, retrieval-silent)', '');
    for (const r of flagged) summary.push(`- Pseudo-claim ${r.n} — ${r.label}`);
    summary.push('');
  }

  const outPath = chartPath.replace(/\.md$/i, '') + '_looped.md';
  fs.writeFileSync(outPath, sections.join('') + summary.join('\n'));
  console.log(`# claims-loop: wrote ${outPath}`);
  console.log(`#   filled from anchored analysis; agreement ${agree}/${perClaim.length}; sponges: ${[...sponges].join(', ') || 'none'}; needs-redraft: ${flagged.length}`);
  return { outPath, perClaim, sponges, agree, flagged };
}
