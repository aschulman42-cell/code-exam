// rubric-score.js — scores a pseudo-claims run against a hand rubric page: MET / PARTIAL / ABSENT per row, surplus binned
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// issue-353-rubric-score-script (#353 part (e), 2026-10-30).
//
// A RUBRIC PAGE is a hand-written claim set for one CodeExam feature
// (docs/pseudo-claim-rubrics/*.md): claim 1 with lettered elements and a
// wherein, numbered dependents, and a "Citations and provenance" table that
// ties every row to file lines. A RUN is a --pseudo-claims artifact (or its
// .anchors.json sidecar). The score answers, per rubric row: did the run say
// it, and did it cite the code the row cites? And for the run: what did it
// say that the rubric does not ask for, and was that grounded and
// substantive, grounded and trivial, or ungrounded? Until this existed, the
// drafting changes of #353 (a) to (d) could not be measured on the same rows.
//
// The agreement rule is a PROXY for a reading, and the scorecard prints the
// overlap beside every verdict so a reader can audit it:
//   - a row is ADDRESSED by the run claim's anchors that touch the row's
//     cites (same file basename and overlapping lines, or the named function);
//   - agreement is content-word overlap (stemmed, boilerplate removed) between
//     the row's text and the best of the claim's elements, dependents and
//     anchor notes;
//   - MET = a cite match and overlap at or above RUBRIC_MET_OVERLAP;
//     PARTIAL = a cite match with overlap at or above RUBRIC_PARTIAL_OVERLAP,
//     or overlap at or above the MET floor with no cite match (said in words,
//     cited elsewhere); ABSENT = neither, a cite with next to no words included.
// Surplus = the run's elements and dependents that reach no row's overlap
// floor, binned grounded-substantive, grounded-trivial, ungrounded.
//
// PURE on purpose, like loop-score.js: no model, no filesystem, no imports
// from commands/. The element splitter and the element classifier are
// INJECTED (claim-locate's splitClaimElements, claim-genericity's kind) so
// this module never drifts from the chart's own rules; the defaults are
// plain enough for the tests.

export const RUBRIC_MET_OVERLAP = 0.5;
// A cite match says the claim cited the code; below this share of the row's
// words it did not say the thing (a long cited function matches many rows), so
// the row is ABSENT, cite or no cite. Printed on every scorecard.
export const RUBRIC_PARTIAL_OVERLAP = 0.25;

// Content words: four letters or more, minus claim boilerplate (the list the
// synonymize measure uses, kept here so the module imports nothing from
// commands/), stemmed by the loop's suffix rule.
const BOILERPLATE = new Set(`a an and are as at be being by comprising configured
consisting each for from further has have having in including into is it its least
method more not of on one or other plurality respectively said same set so such
system that the their then there thereby to upon use used using wherein whereby
which while with within without all also any apparatus device devices unit units
means step steps claim claims according present second first third
over through across between during after before under above along toward towards
against beyond about based responsive corresponding associated
said comprising wherein which whereby thereby`.split(/\s+/));
// Plural first (names/name, widgets/widget, entries/entry), then the loop's
// suffixes, then a seven-character fold so configuration/configured and
// identification/identified meet. A proxy, printed beside every verdict.
const stem = (w) => {
  let s = w;
  if (/ies$/.test(s)) s = `${s.slice(0, -3)}y`;
  else if (/sses$/.test(s)) s = s.slice(0, -2);
  else if (/[^s]s$/.test(s)) s = s.slice(0, -1);
  const t = s.replace(/(?:ssion|sion|tion|ing|ment|ed)$/, '');
  const base = t.length >= 4 ? t : (s.length >= 4 ? s : w);
  return base.length > 7 ? base.slice(0, 7) : base;
};
export function contentStems(text) {
  const out = new Set();
  for (const w of (String(text || '').toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [])) {
    if (BOILERPLATE.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}
/** Share of `row`'s content stems that `text` carries; 0 when the row has none. */
export function overlapRatio(row, text) {
  const a = row instanceof Set ? row : contentStems(row);
  if (!a.size) return 0;
  const b = text instanceof Set ? text : contentStems(text);
  let n = 0;
  for (const s of a) if (b.has(s)) n++;
  return +(n / a.size).toFixed(2);
}

const basename = (p) => String(p || '').replace(/^.*!/, '').split(/[\\/]/).pop();
const stripZip = (p) => String(p || '').replace(/^.*!/, '');

// ---------------------------------------------------------------------------
// The rubric page.
// ---------------------------------------------------------------------------

const CLAIM_START_RE = /^\*\*(\d+)\.\*\*\s*(.*)$/;
const ELEMENT_RE = /^\(([a-z])\)\s*(.*)$/;
const ROW_KEY_RE = /^([A-Z])(\d+)(?:\s*\(([a-z])\)|\s+(preamble|wherein))?$/;

function joinLines(lines) { return lines.join(' ').replace(/\s+/g, ' ').trim(); }

/**
 * Parse a rubric page. Returns `{ set, title, rows, legend, warnings }` where
 * each row is `{ id, kind, text, cites: [{ file, base, start, end, func }] }`:
 * kind `preamble` | `element` | `wherein` | `dependent`; id `1 preamble`,
 * `1(a)`, `1 wherein`, `2`, …  Cites come from the "Citations and provenance"
 * table, keyed `<Set><claim>(<elem>)`, `<Set><claim> preamble|wherein`, or
 * `<Set><N>` for a dependent. A row without a table entry has no cites and a
 * warning names it.
 */
export function parseRubricPage(md) {
  const lines = String(md || '').split(/\r?\n/);
  const warnings = [];
  const title = (lines.find((l) => /^# /.test(l)) || '').replace(/^# /, '').trim();
  const setM = lines.map((l) => l.match(/^## Set ([A-Z])\b/)).find(Boolean);
  const set = setM ? setM[1] : null;
  if (!set) warnings.push('no "## Set X:" heading; row keys cannot be matched');

  // --- the claim set: from the Set heading to the next "## " heading ---
  const setStart = lines.findIndex((l) => /^## Set [A-Z]\b/.test(l));
  let setEnd = lines.length;
  for (let i = setStart + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { setEnd = i; break; }
  const body = setStart >= 0 ? lines.slice(setStart + 1, setEnd) : [];

  const rows = [];
  let cur = null;   // { id, kind, buf: [] }
  const flush = () => { if (cur) { const text = joinLines(cur.buf); if (text) rows.push({ id: cur.id, kind: cur.kind, text, cites: [] }); } cur = null; };
  let claimN = 0;
  for (const raw of body) {
    const l = raw.trim();
    if (/^### /.test(l)) { flush(); continue; }           // "### Dependents"
    if (!l) { if (cur && (cur.kind === 'dependent' || cur.kind === 'wherein')) flush(); continue; }
    let m;
    if ((m = l.match(CLAIM_START_RE))) {
      flush();
      claimN = Number(m[1]);
      cur = claimN === 1 ? { id: '1 preamble', kind: 'preamble', buf: [m[2]] } : { id: String(claimN), kind: 'dependent', buf: [m[2]] };
      continue;
    }
    if (claimN === 1 && (m = l.match(ELEMENT_RE))) { flush(); cur = { id: `1(${m[1]})`, kind: 'element', buf: [m[2]] }; continue; }
    if (claimN === 1 && /^wherein\b/i.test(l) && cur && cur.kind !== 'wherein') { flush(); cur = { id: '1 wherein', kind: 'wherein', buf: [l] }; continue; }
    if (cur) cur.buf.push(l);
  }
  flush();

  // --- the citations table and its legend ---
  const citStart = lines.findIndex((l) => /^## Citations and provenance/.test(l));
  let citEnd = lines.length;
  for (let i = citStart + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { citEnd = i; break; }
  const cit = citStart >= 0 ? lines.slice(citStart + 1, citEnd) : [];
  const legend = new Map();
  for (const l of cit) {
    if (/^\|/.test(l)) break;
    for (const m of l.matchAll(/`([a-z]{1,4})`\s*=\s*`([^`]+)`/g)) legend.set(m[1], m[2]);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const l of cit) {
    if (!/^\|/.test(l) || /^\|\s*-+\s*\|/.test(l) || /^\|\s*claim\s*\|/i.test(l)) continue;
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const key = cells[0].match(ROW_KEY_RE);
    if (!key) { warnings.push(`table key not understood: ${cells[0]}`); continue; }
    if (set && key[1] !== set) { warnings.push(`table key ${cells[0]} is not set ${set}`); continue; }
    const n = Number(key[2]);
    const id = n === 1 ? (key[3] ? `1(${key[3]})` : key[4] ? `1 ${key[4]}` : '1 preamble') : String(n);
    const row = byId.get(id);
    if (!row) { warnings.push(`table row ${cells[0]} has no claim text`); continue; }
    row.cites.push(...parseCites(cells[1], legend));
  }
  for (const r of rows) if (!r.cites.length) warnings.push(`${r.id}: no cites in the table`);
  return { set, title, rows, legend: Object.fromEntries(legend), warnings };
}

/**
 * The cites in one "where" cell: backticked tokens, in order. `key:range` with a
 * legend key, or `path:range`, name a file and lines; a bare `range` (or
 * `L<a>-<b>`) continues the previous file; an identifier that is not a legend
 * key is a function cite on the previous file; a legend key alone is the
 * whole file. Anything else is skipped.
 */
export function parseCites(cell, legend) {
  const out = [];
  let lastFile = null;
  const lg = legend instanceof Map ? legend : new Map(Object.entries(legend || {}));
  for (const m of String(cell || '').matchAll(/`([^`]+)`/g)) {
    const tok = m[1].trim();
    let mm;
    if ((mm = tok.match(/^([A-Za-z0-9_./\\-]+?):(?:L)?(\d+)(?:-(\d+))?$/))) {
      const file = lg.get(mm[1]) || (/[/.]/.test(mm[1]) ? mm[1] : null);
      if (!file) continue;
      lastFile = file;
      out.push({ file, base: basename(file), start: Number(mm[2]), end: Number(mm[3] || mm[2]), func: null });
    } else if ((mm = tok.match(/^L?(\d+)(?:-(\d+))?$/))) {
      if (lastFile) out.push({ file: lastFile, base: basename(lastFile), start: Number(mm[1]), end: Number(mm[2] || mm[1]), func: null });
    } else if (lg.has(tok)) {
      lastFile = lg.get(tok);
      out.push({ file: lastFile, base: basename(lastFile), start: null, end: null, func: null });
    } else if (/^[A-Za-z_$][\w$]*(?:::[\w$]+)?$/.test(tok)) {
      if (lastFile) out.push({ file: lastFile, base: basename(lastFile), start: null, end: null, func: tok.split('::').pop() });
    } else if (/^[A-Za-z0-9_./\\-]+\.[a-z]{1,4}$/.test(tok)) {
      lastFile = tok;
      out.push({ file: tok, base: basename(tok), start: null, end: null, func: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The run artifact.
// ---------------------------------------------------------------------------

const ANCHOR_LINE_RE = /^- `([^`]+)`(?:\s+—\s+L(\d+)-(\d+))?(?:\s+—\s+(.*))?$/;

/**
 * Parse a --pseudo-claims artifact. Returns `{ claims }`, each
 * `{ n, label, prose, dependents: [{ n, text }], anchors: [{ file, base, func,
 * start, end, kind, element }] }`. A `zip!` prefix on a path is stripped. The
 * chart-mode and by-element lists are not read (no baseline uses them).
 */
export function parseRunArtifact(md) {
  const lines = String(md || '').split(/\r?\n/);
  const claims = [];
  let cur = null;
  let mode = 'head';
  const push = () => { if (cur) { cur.prose = joinLines(cur.proseBuf); delete cur.proseBuf; claims.push(cur); } };
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, '');
    const h = l.match(/^## Pseudo-claim (\d+)(?:\s+—\s+(.*?))?(?:\s{2,}\(P\d\))?\s*$/);
    if (h) { push(); cur = { n: Number(h[1]), label: (h[2] || '').trim(), proseBuf: [], dependents: [], anchors: [] }; mode = 'claim'; continue; }
    if (!cur) continue;
    if (/^## /.test(l)) { push(); cur = null; mode = 'head'; continue; }
    if (/^### Cited anchors/.test(l)) { mode = 'anchors'; continue; }
    if (/^### /.test(l)) { mode = 'other'; continue; }
    if (/^\*\*Dependent claims/.test(l)) { mode = 'deps'; continue; }
    if (mode === 'claim') {
      const t = l.trim();
      if (!t) { if (cur.proseBuf.length) mode = 'after-claim'; continue; }
      if (/^(\*\*\[|_|#|\||-\s)/.test(t)) continue;      // caveats, notes, lists
      cur.proseBuf.push(t);
      continue;
    }
    if (mode === 'deps') {
      const d = l.match(/^(\d+)\.\s+(.*)$/);
      if (d) cur.dependents.push({ n: Number(d[1]), text: d[2].trim() });
      else if (l.trim() && cur.dependents.length && !/^(_|\*\*|#)/.test(l.trim())) cur.dependents[cur.dependents.length - 1].text += ' ' + l.trim();
      else if (/^_/.test(l.trim())) mode = 'after-deps';
      continue;
    }
    if (mode === 'anchors') {
      const a = l.match(ANCHOR_LINE_RE);
      if (!a) { if (l.trim() && !/^-/.test(l.trim())) mode = 'other'; continue; }
      const ref = a[1].replace(/[`'"]/g, '');
      const at = ref.lastIndexOf('@');
      const path = stripZip(at >= 0 ? ref.slice(0, at) : ref);
      const tail = at >= 0 ? ref.slice(at + 1) : '';
      const lr = tail.match(/^L(\d+)-(\d+)$/);
      const start = a[2] ? Number(a[2]) : lr ? Number(lr[1]) : null;
      const end = a[3] ? Number(a[3]) : lr ? Number(lr[2]) : null;
      const note = (a[4] || '').trim();
      const constM = note.match(/^constant\s+(\S+)\s*(?:—\s*)?(.*)$/);
      cur.anchors.push({
        file: path, base: basename(path), func: lr ? '' : tail.replace(/\(\)$/, ''),
        start, end, kind: lr ? (constM ? 'constant' : 'lines') : 'func',
        element: constM ? constM[2] : note,
      });
    }
  }
  push();
  return { claims };
}

/** The same shape from a `ce-pseudo-claim-anchors` sidecar. */
export function fromSidecar(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const claims = (j && j.claims ? j.claims : []).map((c) => ({
    n: c.groupN || c.n, label: c.label || '', prose: String(c.claim || ''),
    dependents: (c.dependents || []).map((d) => ({ n: d.n, text: String(d.text || '') })),
    anchors: (c.grounded || []).map((a) => ({
      file: stripZip(a.file), base: basename(a.file), func: a.func || '', start: a.start ?? null, end: a.end ?? null,
      kind: a.kind || 'func', element: String(a.element || ''),
    })),
  }));
  return { claims };
}

// ---------------------------------------------------------------------------
// The score.
// ---------------------------------------------------------------------------

const defaultSplit = (prose) => {
  const t = String(prose || '');
  const ci = t.indexOf(':');
  const pre = ci >= 0 ? t.slice(0, ci + 1) : '';
  const body = ci >= 0 ? t.slice(ci + 1) : t;
  return [pre, ...body.split(';')].map((s) => s.trim().replace(/^and\s+/, '').replace(/[.\s]+$/, '')).filter((s) => s.length > 15);
};
const defaultClassify = (text) => (contentStems(text).size >= 4 ? 'mechanism' : 'generic');

function citeMatches(cite, anchor) {
  if (cite.base !== anchor.base) return false;
  if (cite.func) return !!anchor.func && anchor.func.split('::').pop() === cite.func;
  if (cite.start == null) return true;                      // the whole file
  if (anchor.start == null) return false;
  return anchor.start <= cite.end && anchor.end >= cite.start;
}

/**
 * Score one run claim against the rubric. Returns the per-row verdicts, the
 * totals and the surplus bins. `splitElements(prose) -> string[]` and
 * `classify(text) -> 'mechanism'|'generic'` are injected.
 */
export function scoreClaim(rubric, claim, { metOverlap = RUBRIC_MET_OVERLAP, partialOverlap = RUBRIC_PARTIAL_OVERLAP, splitElements = defaultSplit, classify = defaultClassify } = {}) {
  const elements = (splitElements(claim.prose) || []).map((t, i) => ({ source: `claim ${claim.n} element ${i + 1}`, text: t, stems: contentStems(t) }));
  const deps = claim.dependents.map((d) => ({ source: `claim ${claim.n} dependent ${d.n}`, text: d.text, stems: contentStems(d.text) }));
  const notes = claim.anchors.filter((a) => a.element).map((a) => ({ source: `claim ${claim.n} anchor ${a.base}@${a.func || `L${a.start}-${a.end}`}`, text: a.element, stems: contentStems(a.element) }));
  const candidates = [...elements, ...deps, ...notes];
  const rowStems = rubric.rows.map((r) => contentStems(r.text));

  const verdicts = rubric.rows.map((row, i) => {
    const hits = claim.anchors.filter((a) => row.cites.some((c) => citeMatches(c, a)));
    let best = { overlap: 0, source: null };
    for (const c of candidates) {
      const o = overlapRatio(rowStems[i], c.stems);
      if (o > best.overlap) best = { overlap: o, source: c.source };
    }
    const cite = hits.length > 0;
    const verdict = cite && best.overlap >= metOverlap ? 'MET'
      : (cite && best.overlap >= partialOverlap) || (!cite && best.overlap >= metOverlap) ? 'PARTIAL' : 'ABSENT';
    return { id: row.id, kind: row.kind, verdict, overlap: best.overlap, citeMatch: cite,
      citedBy: hits.map((a) => `${a.base}@${a.func || `L${a.start}-${a.end}`}`), addressedBy: best.source };
  });

  // Surplus: elements and dependents that reach no row's floor.
  const surplus = [];
  for (const c of [...elements, ...deps]) {
    let best = 0;
    for (const rs of rowStems) best = Math.max(best, overlapRatio(rs, c.stems));
    if (best >= metOverlap) continue;
    const grounded = notes.some((nt) => overlapRatio(c.stems, nt.stems) >= metOverlap || overlapRatio(nt.stems, c.stems) >= metOverlap);
    const kind = classify(c.text);
    surplus.push({ source: c.source, text: c.text, bestOverlap: best, bin: grounded ? (kind === 'generic' ? 'grounded-trivial' : 'grounded-substantive') : 'ungrounded' });
  }
  const count = (vs, v) => vs.filter((x) => x.verdict === v).length;
  const claimRows = verdicts.filter((v) => v.kind !== 'dependent');
  const depRows = verdicts.filter((v) => v.kind === 'dependent');
  const totals = {
    rows: verdicts.length, MET: count(verdicts, 'MET'), PARTIAL: count(verdicts, 'PARTIAL'), ABSENT: count(verdicts, 'ABSENT'),
    claim1: { rows: claimRows.length, MET: count(claimRows, 'MET'), PARTIAL: count(claimRows, 'PARTIAL'), ABSENT: count(claimRows, 'ABSENT') },
    dependents: { rows: depRows.length, MET: count(depRows, 'MET'), PARTIAL: count(depRows, 'PARTIAL'), ABSENT: count(depRows, 'ABSENT') },
    surplus: {
      total: surplus.length,
      'grounded-substantive': surplus.filter((s) => s.bin === 'grounded-substantive').length,
      'grounded-trivial': surplus.filter((s) => s.bin === 'grounded-trivial').length,
      ungrounded: surplus.filter((s) => s.bin === 'ungrounded').length,
    },
  };
  return { claim: { n: claim.n, label: claim.label, elements: elements.length, dependents: deps.length, anchors: claim.anchors.length }, verdicts, surplus, totals };
}

/**
 * Score a run against a rubric: every run claim with an anchor that matches a
 * row's cite (or the `claims` given), the best one first (MET twice, PARTIAL
 * once). `best` is null when no considered claim meets or partly meets a row,
 * so a run with nothing on the feature reads "none" rather than naming a
 * stranger. Returns `{ considered, scored, best }`.
 */
export function scoreRubric(rubric, run, { claims = null, ...opts } = {}) {
  const cites = rubric.rows.flatMap((r) => r.cites);
  const pool = run.claims.filter((c) => claims ? claims.includes(c.n) : c.anchors.some((a) => cites.some((ct) => citeMatches(ct, a))));
  const scored = pool.map((c) => scoreClaim(rubric, c, opts))
    .sort((a, b) => (2 * b.totals.MET + b.totals.PARTIAL) - (2 * a.totals.MET + a.totals.PARTIAL) || a.claim.n - b.claim.n);
  const best = scored.find((sc) => sc.totals.MET + sc.totals.PARTIAL > 0) || null;
  return { considered: pool.map((c) => c.n), scored, best };
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

const pct = (x) => `${Math.round(100 * x)}%`;
export function summaryLine(runName, result) {
  const b = result.best;
  if (!b) return `| ${runName} | none | — | — | — | — | ${result.considered.length} |`;
  const t = b.totals; const s = t.surplus;
  return `| ${runName} | ${b.claim.n}${b.claim.label ? ` (${b.claim.label})` : ''} | ${t.MET} | ${t.PARTIAL} | ${t.ABSENT} | ${s['grounded-substantive']} / ${s['grounded-trivial']} / ${s.ungrounded} | ${result.considered.length} |`;
}
export const SUMMARY_HEADER = '| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |\n|---|---|---|---|---|---|---|';

/** One run's scorecard in Markdown: the best claim's rows, then the other candidates in a line each. */
export function formatRubricScorecard(rubric, runName, result, { all = false } = {}) {
  const out = [];
  const title = rubric.title ? `${rubric.title} (Set ${rubric.set})` : `Set ${rubric.set}`;
  out.push(`## ${runName} against ${title}`, '');
  if (!result.best) {
    out.push(result.considered.length
      ? `_${result.considered.length} claim(s) cite code the rubric cites (${result.considered.join(', ')}) but none meets or partly meets a row._`
      : '_No run claim cites code the rubric cites._', '');
    return out.join('\n');
  }
  const render = (sc) => {
    const t = sc.totals; const s = t.surplus;
    out.push(`### Claim ${sc.claim.n}${sc.claim.label ? ` — ${sc.claim.label}` : ''}: MET ${t.MET} · PARTIAL ${t.PARTIAL} · ABSENT ${t.ABSENT} of ${t.rows} rows`
      + ` (claim 1 ${t.claim1.MET}/${t.claim1.PARTIAL}/${t.claim1.ABSENT} of ${t.claim1.rows}; dependents ${t.dependents.MET}/${t.dependents.PARTIAL}/${t.dependents.ABSENT} of ${t.dependents.rows});`
      + ` surplus ${s.total} (${s['grounded-substantive']} grounded-substantive, ${s['grounded-trivial']} grounded-trivial, ${s.ungrounded} ungrounded)`, '');
    out.push('| row | verdict | overlap | cite match | addressed by |', '|---|---|---|---|---|');
    for (const v of sc.verdicts) out.push(`| ${v.id} | ${v.verdict} | ${pct(v.overlap)} | ${v.citedBy.length ? v.citedBy.slice(0, 3).join(', ') : '—'} | ${v.addressedBy || '—'} |`);
    out.push('');
    if (sc.surplus.length) {
      out.push('Surplus (reaches no row at the floor):', '');
      for (const su of sc.surplus) out.push(`- ${su.bin}: ${su.source}: ${su.text.length > 120 ? `${su.text.slice(0, 119).trimEnd()}…` : su.text} (best ${pct(su.bestOverlap)})`);
      out.push('');
    }
  };
  render(result.best);
  const others = result.scored.slice(1);
  if (others.length) {
    if (all) for (const sc of others) render(sc);
    else {
      out.push(`Other claims considered (${others.length}): ` + others.map((sc) => `claim ${sc.claim.n} MET ${sc.totals.MET} / PARTIAL ${sc.totals.PARTIAL} / ABSENT ${sc.totals.ABSENT}`).join('; ') + '.', '');
    }
  }
  if (rubric.warnings && rubric.warnings.length) out.push(`_Rubric page warnings: ${rubric.warnings.join('; ')}._`, '');
  return out.join('\n');
}
