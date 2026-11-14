#!/usr/bin/env node
// mechanism-containment.mjs — do the mechanism records hold the functions cited for a claim or a feature: against the names litigants cite in public claim charts (--filings) or the lines a hand-written rubric page cites; per filing or page, the records holding each cited function, the best record, how many records hold them all; no model
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * scripts/mechanism-containment.mjs — mechanism-containment-test (2026-11-14).
 *
 * The mechanisms index (--build-mechanisms) puts every function of four lines
 * or more in at least one record. That is coverage. This script asks the other
 * question: for a feature someone can name, is there a record that IS the
 * feature, or is the feature spread over records that nothing links? The
 * ground truth is a page that cites, row by row, the lines a feature's
 * description was written from: the rubric pages under
 * docs/pseudo-claim-rubrics/, each ending in a "## Citations and provenance"
 * table (| claim | where | provenance |) under a key of file abbreviations.
 *
 * Per page: every cite is carried from the commit the page was keyed at to
 * the tree the index was built from (git diff hunks; a page's line numbers
 * go stale as the files grow), then mapped to the function whose extent holds
 * it (function_index.json, so functions under the four-line floor are seen),
 * then to every record whose members carry that function (mechanisms.json).
 * No model, no index load: two JSON files and git.
 *
 * Usage:
 *   node scripts/mechanism-containment.mjs --index <dir> [page.md ...]
 *        [--keyed-at auto|none|<rev>] [--tree <rev>] [--rows <regex>]
 *        [-v] [--md] [--json <file>]
 *   node scripts/mechanism-containment.mjs --filings <work dir> [--only id,id] [--calls]
 *        [-v] [--md] [--json <file>]
 *
 *   --filings <dir>    the other ground truth, litigants' claim charts: the work
 *                      directory of scripts/recap-chart-agreement.mjs
 *                      (manifest.json and indexes/<org__repo__sha>/, each with
 *                      a mechanisms.json). Per filing and repository: the names
 *                      the litigant cited, those in the index, those in a
 *                      mechanism, the mechanism holding most, and how many
 *                      hold them all. A name matches by its last segment,
 *                      narrowed by its qualifier or a cited file. A hit is
 *                      agreement with a party, not correctness.
 *                      Each chart row (one claim limitation and the names
 *                      cited for it) is scored the same way.
 *   --only id,id       with --filings: those filings only
 *   --calls            with --filings: load each index and report, per chart
 *                      row and per filing, how many groups the names matching
 *                      one function fall into when linked by calls: direct,
 *                      with one function between, and with a common caller.
 *                      Also the callers that join (a function calling two or
 *                      more of them): how many, how many in test code, the
 *                      groups with test callers left out, and the best caller
 *                      outside test code; -v lists them per chart row
 *   --index <dir>      the index directory (function_index.json, mechanisms.json)
 *   page.md ...        ground-truth pages; default docs/pseudo-claim-rubrics/*.md
 *   --keyed-at <rev>   the commit the page's line numbers were true at. auto
 *                      (default): of the commits that wrote the page, the one
 *                      at which the most named cites land, by their lines, in
 *                      the function they name (the last commit to touch a
 *                      page is often not it: the files grow, the page's
 *                      lines stay). none: take the lines as written.
 *   --tree <rev>       the commit the index was built from (default HEAD)
 *   --rows <regex>     only rows whose claim cell matches, e.g. "^[A-Z]+1\b"
 *                      for the independent claim alone
 *   -v                 every cite, where it landed, and the records holding it
 *   --md               the summary as a Markdown table
 *   --json <file>      the full result
 *
 * What the columns mean:
 *   cites          line cites into indexed source in the selected rows
 *   set aside      cites to docs and tests, and cites that name a file with
 *                  no line; not part of any figure below
 *   not indexed    the cited file is not in the index
 *   no function    the cited lines are in no function: a comment block, a
 *                  table, a constant, a route registered at module scope. No
 *                  grouper change can put these in a record.
 *   functions      distinct functions the remaining cites land in
 *   in a record    of those, how many some record carries (the rest are
 *                  under the four-line floor)
 *   best record    the one record holding the most cited functions; recall is
 *                  its share of the cited functions, purity the share of its
 *                  own members that are cited
 *   to cover       how many records a greedy cover needs to hold every cited
 *                  function that is in a record; one is a feature with a
 *                  record, six is a feature spread with nothing linking it
 *   moved / edited cites whose lines shifted, or were themselves changed,
 *                  between --keyed-at and --tree
 *   named          cites written with the name of a function of that file
 *                  beside them, and how many of them the lines alone would
 *                  have landed on: the check on the line mapping. A named
 *                  cite lands on the function it names either way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECTION = /^## Citations and provenance\s*$/m;
const LINE_SPEC = /^~?\d+(?:-\d+)?\+?$/;

// --- the page ---------------------------------------------------------------

/** `ab` = `path/to/file.js` pairs anywhere in the text (the key above a table). */
export function parseKey(text) {
  const key = new Map();
  const re = /`([A-Za-z][\w-]*)`\s*=\s*`([^`\s]+)`/g;
  let m;
  while ((m = re.exec(text))) key.set(m[1], m[2]);
  return key;
}

/** A table row's cells; a pipe inside a backtick span does not split. */
export function splitRow(line) {
  const cells = [];
  let cur = '';
  let tick = false;
  for (const ch of line.trim()) {
    if (ch === '`') tick = !tick;
    if (ch === '|' && !tick) { cells.push(cur.trim()); cur = ''; } else cur += ch;
  }
  cells.push(cur.trim());
  if (cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

function parseSpec(spec) {
  const m = spec.trim().match(/^(~?)(\d+)(?:-(\d+))?(\+?)$/);
  if (!m) return null;
  const start = Number(m[2]);
  const end = m[3] ? Number(m[3]) : start;
  if (!start || end < start) return null;
  return { start, end, approx: !!m[1], open: !!m[4] };
}

/**
 * The cites in one `where` cell, in order. A cite is a backtick span of one of
 * three shapes: `key:lines` or `path:lines` (lines a comma list of N or N-M,
 * with ~ for approximate and + for "and below"); bare `lines`, which belongs
 * to the file of the cite before it in the cell; a key or a path alone, which
 * names a file with no line. Any other span (an identifier, a flag) is prose.
 * A cite followed by a parenthesis that opens with a backticked identifier
 * carries that identifier as `named`.
 */
export function parseCites(cell, key = new Map()) {
  const cites = [];
  let lastFile = null;
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(cell))) {
    const span = m[1].trim();
    const after = cell.slice(re.lastIndex);
    const nm = after.match(/^\s*\(`([A-Za-z_$][\w$.:]*)`/);
    const named = nm ? nm[1] : null;
    let file = null;
    let specs = null;
    const colon = span.match(/^([\w.\/-]+):(.+)$/);
    if (colon && colon[2].split(',').every((s) => LINE_SPEC.test(s.trim()))) {
      file = resolveFile(colon[1], key);
      specs = colon[2].split(',');
    } else if (span.split(',').every((s) => LINE_SPEC.test(s.trim()))) {
      if (!lastFile) continue;
      file = lastFile;
      specs = span.split(',');
    } else if (key.has(span) || /^[\w.-]+(?:\/[\w.-]+)+\.\w+$/.test(span)) {
      file = resolveFile(span, key);
      lastFile = file;
      cites.push({ file, start: null, end: null, fileOnly: true, raw: span, named: null });
      continue;
    } else continue;
    if (!file) continue;
    lastFile = file;
    for (const s of specs) {
      const r = parseSpec(s);
      if (r) cites.push({ file, ...r, fileOnly: false, raw: span, named });
    }
  }
  return cites;
}

function resolveFile(token, key) {
  if (key.has(token)) return key.get(token);
  if (token.includes('/')) return token;
  if (/\.md$/i.test(token)) return `docs/${token}`;
  return null;
}

/** The key and the rows of a page's citations table: [{ claim, cites }]. */
export function parsePage(text) {
  const at = text.search(SECTION);
  if (at < 0) return { key: new Map(), rows: [] };
  let section = text.slice(at).replace(SECTION, '');
  const next = section.search(/^## /m);
  if (next >= 0) section = section.slice(0, next);
  const key = parseKey(section);
  const rows = [];
  let inTable = false;
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) { if (inTable) break; continue; }
    const cells = splitRow(line);
    if (!inTable) { inTable = /^claim$/i.test(cells[0] || '') && /^where$/i.test(cells[1] || ''); continue; }
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
    if (cells.length < 2) continue;
    rows.push({ claim: cells[0], cites: parseCites(cells[1], key) });
  }
  return { key, rows };
}

// --- carrying a line from one commit to another ------------------------------

/** The hunks of a `git diff -U0`: [{ oldStart, oldCount, newStart, newCount }]. */
export function parseHunks(diff) {
  const hunks = [];
  const re = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let m;
  while ((m = re.exec(diff))) {
    hunks.push({
      oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  return hunks;
}

/** Where an old line is in the new file; `edited` when the line itself was changed or removed. */
export function mapLine(hunks, line) {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) {
      if (line > h.oldStart) delta += h.newCount; else break;
      continue;
    }
    if (line < h.oldStart) break;
    if (line <= h.oldStart + h.oldCount - 1) {
      const to = h.newCount ? h.newStart + Math.min(line - h.oldStart, h.newCount - 1) : Math.max(1, h.newStart);
      return { line: to, edited: true };
    }
    delta += h.newCount - h.oldCount;
  }
  return { line: line + delta, edited: false };
}

/** A range carried across; `edited` when a hunk changed any line in it, `moved` when it shifted. */
export function mapRange(hunks, start, end) {
  const a = mapLine(hunks, start);
  const b = mapLine(hunks, end);
  const edited = a.edited || b.edited
    || hunks.some((h) => h.oldCount > 0 && h.oldStart <= end && h.oldStart + h.oldCount - 1 >= start)
    || hunks.some((h) => h.oldCount === 0 && h.oldStart >= start && h.oldStart < end);
  return { start: a.line, end: Math.max(a.line, b.line), edited, moved: a.line !== start || b.line !== end };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** A hunk source for one pair of commits, one diff per file, cached. */
export function gitHunkSource(from, to) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      let hunks = [];
      try { hunks = parseHunks(git(['diff', '-U0', '--no-color', from, to, '--', file])); } catch { /* no such file at one end */ }
      cache.set(file, hunks);
    }
    return cache.get(file);
  };
}

// --- the index ----------------------------------------------------------------

const slash = (p) => String(p).replace(/\\/g, '/');

/** function_index.json as Map<file, [{ name, start, end }]>, type definitions left out. */
export function functionsByFile(functionIndex) {
  const out = new Map();
  for (const [file, fns] of Object.entries(functionIndex || {})) {
    const list = [];
    for (const [name, f] of Object.entries(fns || {})) {
      if (!f || f.type === 'class' || !f.start) continue;
      list.push({ name, start: f.start, end: f.end || f.start, raw: file });
    }
    out.set(slash(file), list);
  }
  return out;
}

/**
 * The functions a cited range lands in. Inside one function: the innermost
 * that holds the whole range. Otherwise every function the range overlaps,
 * less any nested in another of them: a range that takes in a whole function
 * (often with the comment above it) cites that function, not its helpers.
 */
export function functionsAt(fns, start, end) {
  const holding = fns.filter((f) => f.start <= start && f.end >= end);
  if (holding.length) return [holding.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a))];
  const over = fns.filter((f) => f.start <= end && f.end >= start);
  return over.filter((f) => !over.some((g) => g !== f && g.start <= f.start && g.end >= f.end && (g.start < f.start || g.end > f.end)));
}

/** Map<'file@name', [record]> over a mechanisms.json's records. */
export function recordsByMember(records) {
  const out = new Map();
  for (const r of records || []) {
    for (const m of r.members || []) {
      const id = `${slash(m.file)}@${m.name}`;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(r);
    }
  }
  return out;
}

// --- the score -----------------------------------------------------------------

const isDoc = (file) => /\.(md|txt)$/i.test(file);
const isTest = (file) => /^tests?\//.test(file);

/**
 * One page scored. `rows` from parsePage; `fnsByFile` from functionsByFile;
 * `byMember` from recordsByMember; `hunksFor(file)` the line carrier (absent:
 * lines as written); `rowFilter` a RegExp on the claim cell.
 */
export function scorePage(rows, fnsByFile, byMember, { hunksFor = null, rowFilter = null } = {}) {
  const detail = [];
  const cited = new Map();   // 'file@name' -> [record]
  const n = { cites: 0, setAside: 0, notIndexed: 0, noFunction: 0, moved: 0, edited: 0, named: 0, namedAgree: 0 };
  for (const row of rows) {
    if (rowFilter && !rowFilter.test(row.claim)) continue;
    for (const c of row.cites) {
      const file = slash(c.file);
      if (c.fileOnly || isDoc(file) || isTest(file)) { n.setAside++; detail.push({ claim: row.claim, cite: c, kind: 'set-aside' }); continue; }
      n.cites++;
      const fns = fnsByFile.get(file);
      if (!fns) { n.notIndexed++; detail.push({ claim: row.claim, cite: c, kind: 'not-indexed' }); continue; }
      const r = hunksFor ? mapRange(hunksFor(file), c.start, c.end) : { start: c.start, end: c.end, edited: false, moved: false };
      if (r.moved) n.moved++;
      if (r.edited) n.edited++;
      // A range that grew between the two commits had lines inserted inside it
      // that the page never cited: it lands on the functions at its two ends.
      const grew = r.edited && !c.open && r.end - r.start > c.end - c.start;
      let hit = grew
        ? [...new Set([...functionsAt(fns, r.start, r.start), ...functionsAt(fns, r.end, r.end)])]
        : functionsAt(fns, r.start, c.open ? Infinity : r.end);
      // A cite that names a function of this file lands on that function: names
      // outlive line numbers. Whether the lines pointed at it too is the check
      // on the line mapping. A name that is no function here (a constant, a
      // callee from another file) is prose and the lines decide.
      const leaf = (s) => s.split(/::|\./).pop();
      const byName = c.named ? fns.filter((f) => f.name === c.named || leaf(f.name) === leaf(c.named)) : [];
      if (byName.length) {
        n.named++;
        if (hit.some((f) => byName.includes(f))) n.namedAgree++;
        hit = byName.length === 1 ? byName : (byName.filter((f) => hit.includes(f)).length ? byName.filter((f) => hit.includes(f)) : [byName[0]]);
      }
      if (!hit.length) { n.noFunction++; detail.push({ claim: row.claim, cite: c, at: r, kind: 'no-function' }); continue; }
      const landed = hit.map((f) => {
        const id = `${file}@${f.name}`;
        const recs = byMember.get(id) || [];
        cited.set(id, recs);
        return { id, records: recs.map((x) => x.id) };
      });
      detail.push({ claim: row.claim, cite: c, at: r, kind: 'function', landed });
    }
  }
  return { ...n, ...scoreCited(cited), detail };
}

/**
 * The arithmetic both ground truths share. `cited` is Map<unit, [record]>: a
 * unit is a cited function (a page) or a cited name (a filing), with every
 * record that holds it. Returns the units in a record, the best record, the
 * five records holding most, and a greedy cover.
 */
export function scoreCited(cited) {
  const ids = [...cited.keys()];
  const inRecord = ids.filter((id) => cited.get(id).length);
  // The best record: most cited functions, then purest, then smallest, then first by id.
  const tally = new Map();
  for (const id of inRecord) for (const rec of new Set(cited.get(id))) (tally.get(rec) || tally.set(rec, []).get(rec)).push(id);
  let best = null;
  for (const [rec, held] of tally) {
    const size = (rec.members || []).length || 1;
    const cand = { id: rec.id, label: rec.label, kind: rec.kind, held: held.length, size, recall: ids.length ? held.length / ids.length : 0, purity: held.length / size, holds: held };
    if (!best || cand.held > best.held || (cand.held === best.held && (cand.purity > best.purity || (cand.purity === best.purity && String(cand.id) < String(best.id))))) best = cand;
  }
  const top = [...tally].map(([rec, held]) => ({ id: rec.id, label: rec.label, held: held.length, size: (rec.members || []).length }))
    .sort((a, b) => b.held - a.held || a.size - b.size || String(a.id).localeCompare(String(b.id))).slice(0, 5);
  // A greedy cover of the cited functions that are in a record.
  const left = new Set(inRecord);
  const cover = [];
  while (left.size) {
    let pick = null;
    let gain = 0;
    for (const [rec, held] of tally) {
      const g = held.filter((id) => left.has(id)).length;
      if (g > gain || (g === gain && g > 0 && pick && (rec.members || []).length < (pick.members || []).length)) { pick = rec; gain = g; }
    }
    if (!pick) break;
    for (const id of tally.get(pick)) left.delete(id);
    cover.push({ id: pick.id, label: pick.label, gain });
  }
  return { functions: ids.length, inRecord: inRecord.length, belowFloor: ids.filter((id) => !cited.get(id).length), best, top, cover };
}

// --- a litigant's filing as the ground truth -----------------------------------------

const leafOf = (s) => String(s || '').split(/::|\.|#/).pop();
const qualOf = (s) => { const p = String(s || '').split(/::|\.|#/); return p.length > 1 ? p[p.length - 2] : null; };
const baseOf = (file) => slash(file).split('/').pop();

/**
 * One filing against one index. `names` and `files` are what the litigant
 * cited (the agreement harness's manifest: bare or qualified identifiers, file
 * names or path tails; no line numbers). A name matches the functions whose
 * last segment equals its last segment, the harness's rule. Where the filing
 * says more, the match is narrowed: a qualifier (`Class.method`) keeps the
 * same-named functions of that class or of a file of that name; else a cited
 * file keeps those in it. A name left with several functions is `ambiguous`,
 * and it counts as held by a record that holds any of them: an upper reading.
 * The unit scored is the cited name, not the function.
 */
export function scoreFiling(names, files, fnsByFile, byMember) {
  const byLeaf = new Map();
  const byClass = new Map();
  const put = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const [file, fns] of fnsByFile) for (const f of fns) {
    const e = { file, name: f.name, start: f.start, end: f.end, raw: f.raw || file };
    put(byLeaf, leafOf(f.name), e);
    if (qualOf(f.name)) put(byClass, qualOf(f.name), e);
  }
  const fileTails = (files || []).map(slash).filter(Boolean);
  const inCited = (file) => fileTails.some((t) => file === t || file.endsWith(`/${t}`) || baseOf(file) === baseOf(t));
  // The unit is the distinct last segment, as the harness and the 2026-11-06
  // reach run counted: `user.getUserId` and `mainUser.getUserId` are one name.
  const quals = new Map();
  for (const name of names || []) {
    const k = leafOf(name);
    if (!k) continue;
    if (!quals.has(k)) quals.set(k, new Set());
    if (qualOf(name)) quals.get(k).add(qualOf(name));
  }
  const loose = new Map();    // every name in the index: held by a record holding any function of that name
  const strict = new Map();   // only the names left with exactly one function
  const detail = [];
  const strictFiles = new Set();   // the files the strict names in a mechanism sit in
  const n = { names: 0, notIndexed: 0, ambiguous: 0, narrowed: 0, classNames: 0 };
  for (const [name, qs] of quals) {
    n.names++;
    let cand = byLeaf.get(name) || [];
    let isClass = false;
    if (!cand.length && byClass.has(name)) { cand = byClass.get(name); isClass = true; n.classNames++; }
    if (!cand.length) { n.notIndexed++; detail.push({ name, kind: 'not-indexed' }); continue; }
    const all = cand.length;
    if (!isClass) {
      const byQual = qs.size ? cand.filter((c) => qs.has(qualOf(c.name)) || qs.has(baseOf(c.file).replace(/\.[^.]+$/, ''))) : [];
      if (byQual.length) cand = byQual;
      else { const byFile = cand.filter((c) => inCited(c.file)); if (byFile.length) cand = byFile; }
      if (cand.length < all) n.narrowed++;
      if (cand.length > 1) n.ambiguous++;
    }
    const recs = [...new Set(cand.flatMap((c) => byMember.get(`${c.file}@${c.name}`) || []))];
    loose.set(name, recs);
    if (isClass || cand.length === 1) { strict.set(name, recs); if (recs.length) strictFiles.add(cand[0].file); }
    detail.push({ name, kind: isClass ? 'class' : 'function', matched: all, kept: cand.length, at: cand.slice(0, 3).map((c) => `${c.file}@${c.name}`), records: recs.map((r) => r.id), fn: !isClass && cand.length === 1 ? cand[0] : null });
  }
  return { ...n, ...scoreCited(loose), strict: { ...scoreCited(strict), files: strictFiles.size }, detail };
}

/**
 * Are the cited functions joined by calls? `nodes` are function ids; `out`
 * maps an id to the ids it calls; `callers` maps an id to the ids that call
 * it. Returns how many groups the nodes fall into under three widening links:
 * `direct` (one calls the other), `chain` (also: one calls a function that
 * calls the other), `commonCaller` (also: one function calls both). One group
 * means joined. A shared callee is not a link: two functions that both call
 * memcpy are not thereby related.
 */
export function callComponents(nodes, out, callers = new Map()) {
  const O = (id) => out.get(id) || new Set();
  const C = (id) => callers.get(id) || new Set();
  const mk = () => {
    const p = new Map(nodes.map((x) => [x, x]));
    const find = (x) => { while (p.get(x) !== x) x = p.get(x); return x; };
    return { join: (a, b) => p.set(find(a), find(b)), count: () => new Set(nodes.map(find)).size };
  };
  const direct = mk();
  const chain = mk();
  const common = mk();
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i];
    const b = nodes[j];
    const d = O(a).has(b) || O(b).has(a);
    const c = d || [...O(a)].some((x) => O(x).has(b)) || [...O(b)].some((x) => O(x).has(a));
    const s = c || [...C(a)].some((x) => C(b).has(x));
    if (d) direct.join(a, b);
    if (c) chain.join(a, b);
    if (s) common.join(a, b);
  }
  return { functions: nodes.length, direct: direct.count(), chain: chain.count(), commonCaller: common.count() };
}

/** The ids of the names of a scored filing or row that matched exactly one function. */
export const oneFunctionIds = (score) => score.detail.filter((d) => d.fn).map((d) => `${d.fn.file}@${d.fn.name}`);

/** A test, benchmark or example file, judged by its path alone. */
export const isTestPath = (file) => /(^|\/)(tests?|testing|bench|benchmarks?|examples?)(\/|_|\.)|(^|\/)[^/]*(_tests?|tests?_|_bench|bench_)[^/]*$|Test\.(java|scala|kt)$|Suite\.scala$|\.(test|spec)\.[a-z]+$/i.test(slash(file));

/**
 * Which callers do the joining? For the cited functions `nodes`: every
 * function that calls two or more of them (a joining caller), how many of
 * those are test code, the groups the nodes fall into by direct calls plus a
 * common caller with test callers counted and left out, and the best caller
 * outside test code: the one calling the most of the nodes, the fewest callees
 * of its own breaking a tie. `calls` is how many nodes it calls, `cited`
 * whether it is itself one of them, `callees` everything it calls. A caller
 * of one node joins nothing and is not counted.
 */
export function callerReading(nodes, out, callers = new Map()) {
  const O = (id) => out.get(id) || new Set();
  const C = (id) => callers.get(id) || new Set();
  const fileOf = (id) => id.slice(0, id.lastIndexOf('@'));
  const tally = new Map();
  for (const id of nodes) for (const x of C(id)) (tally.get(x) || tally.set(x, []).get(x)).push(id);
  const joiners = [...tally].filter(([, held]) => held.length >= 2)
    .map(([caller, held]) => ({ caller, calls: held.length, callees: O(caller).size, test: isTestPath(fileOf(caller)), cited: nodes.includes(caller), holds: held }))
    .sort((a, b) => b.calls - a.calls || a.callees - b.callees || a.caller.localeCompare(b.caller));
  const groups = (allow) => {
    const p = new Map(nodes.map((x) => [x, x]));
    const find = (x) => { while (p.get(x) !== x) x = p.get(x); return x; };
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (O(a).has(b) || O(b).has(a) || [...C(a)].some((x) => C(b).has(x) && allow(x))) p.set(find(a), find(b));
    }
    return new Set(nodes.map(find)).size;
  };
  return {
    functions: nodes.length, joiners: joiners.length, testJoiners: joiners.filter((j) => j.test).length,
    groups: groups(() => true), groupsNoTest: groups((x) => !isTestPath(fileOf(x))),
    best: joiners.find((j) => !j.test) || null, list: joiners,
  };
}

export const ROW_HEAD = ['filing', 'repository', 'row', 'cited', 'one function', 'in a mechanism', 'files', 'best holds', 'to hold all', 'groups by direct calls', 'with one step between', 'with a common caller', 'common caller, tests left out', 'best non-test caller calls'];

/** One table row per chart row (a claim limitation) of each filing-repository pair. */
export function rowLines(results) {
  const lines = [];
  for (const f of results) for (const r of f.rows || []) {
    const t = r.score.strict;
    const c = r.calls;
    const k = r.callers;
    lines.push([f.id, f.repo, r.label, r.score.names, t.functions, t.inRecord, t.files, t.best ? t.best.held : 'none', t.cover.length,
      c ? c.direct : '', c ? c.chain : '', c ? c.commonCaller : '',
      k ? k.groupsNoTest : '', k ? (k.best ? k.best.calls + (k.best.cited ? 1 : 0) : 0) : '']);
  }
  return lines;
}

export function renderRows(results, { md = false } = {}) {
  const lines = rowLines(results);
  if (!lines.length) return '';
  if (md) return [`| ${ROW_HEAD.join(' | ')} |`, `|${ROW_HEAD.map((_, i) => (i < 3 ? '---' : '--:')).join('|')}|`, ...lines.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
  return lines.map((r) => `${String(r[0]).padEnd(22)} ${String(r[1]).padEnd(38)} ${String(r[2]).padEnd(8)} cited ${String(r[3]).padStart(2)}; one function ${String(r[4]).padStart(2)}; in a mechanism ${String(r[5]).padStart(2)}, in ${r[6]} file(s); best holds ${r[7]}; to hold all ${r[8]}${r[9] !== '' ? `; groups by calls ${r[9]} / ${r[10]} / ${r[11]} (direct / one step / common caller)` : ''}${r[12] !== '' ? `; ${r[12]} with test callers left out; best non-test caller holds ${r[13]}` : ''}`).join('\n');
}

/**
 * The same names counted by the rule of the 2026-11-06 reach run
 * (docs/describe-reach.md, phase 2), with no narrowing: a name is in the index
 * when any symbol, type definitions included, has it as its last segment; it
 * is in a mechanism when any member has, or any member is `Name::x`. The check
 * that this script and that run read the same data.
 */
export function harnessCounts(names, functionIndex, records) {
  const want = new Set((names || []).map(leafOf).filter(Boolean));
  const symbols = new Set();
  // The harness falls back to a case-blind match for presence in the index.
  for (const fns of Object.values(functionIndex || {})) for (const name of Object.keys(fns || {})) { symbols.add(leafOf(name)); symbols.add(leafOf(name).toLowerCase()); }
  const members = new Set();
  for (const r of records || []) for (const m of r.members || []) { members.add(leafOf(m.name)); if (qualOf(m.name)) members.add(qualOf(m.name)); }
  let inIndex = 0;
  let inRecord = 0;
  for (const n of want) { if (symbols.has(n) || symbols.has(n.toLowerCase())) inIndex++; if (members.has(n)) inRecord++; }
  return { names: want.size, inIndex, inRecord };
}

/** The filing-repository pairs of an agreement-harness work directory. */
export function filingsOf(manifest) {
  const out = [];
  for (const c of (manifest && manifest.candidates) || []) {
    for (const r of c.repos || []) {
      const sha = String(r.resolvedRef || r.ref || '').slice(0, 7);
      const chartRows = (c.rows || []).filter((w) => (w.functions || []).length).map((w) => ({ label: w.label || '', claim: w.claim || '', limitation: w.limitation || '', names: w.functions, files: w.files || [] }));
      out.push({ id: c.id, repo: `${r.org}/${r.repo}`, dir: `${r.org}__${r.repo}__${sha}`, claims: c.claims || [], names: (c.key && c.key.functions) || [], files: (c.key && c.key.files) || [], chartRows });
    }
  }
  return out;
}

export const FILING_HEAD = ['filing', 'repository', 'names cited', 'in the index', 'in a mechanism', 'one function', 'of those in a mechanism', 'in files', 'best mechanism', 'holds', 'to hold all', 'any match: best holds', 'any match: to hold all'];

/**
 * One row. The first three counts are over every cited name; "one function"
 * on are the strict reading (names matching exactly one function, or a class);
 * the last two are the loose reading, where a name that matches several
 * functions is held by a record holding any of them.
 */
export function filingRow(f) {
  const s = f.score;
  const t = s.strict;
  return [f.id, f.repo, s.names, s.names - s.notIndexed, s.inRecord, t.functions, t.inRecord, t.files,
    t.best ? `${t.best.id} ${t.best.label}` : 'none',
    t.best ? `${t.best.held} of ${t.inRecord}` : 'n/a',
    t.cover.length,
    s.best ? `${s.best.held} of ${s.inRecord}` : 'n/a',
    s.cover.length];
}

export function renderFilings(results, { md = false, verbose = false } = {}) {
  const rows = results.map(filingRow);
  const sum = (i) => rows.reduce((a, r) => a + r[i], 0);
  const held = (k) => results.reduce((a, f) => { const b = k === 'strict' ? f.score.strict.best : f.score.best; return a + (b ? b.held : 0); }, 0);
  const total = ['all', `${rows.length} filing-repository pairs`, sum(2), sum(3), sum(4), sum(5), sum(6), sum(7), '', `${held('strict')} of ${sum(6)}`, sum(10), `${held('loose')} of ${sum(4)}`, sum(12)];
  const out = [];
  if (md) {
    out.push(`| ${FILING_HEAD.join(' | ')} |`, `|${FILING_HEAD.map((_, i) => (i < 2 || i === 8 ? '---' : '--:')).join('|')}|`);
    for (const r of [...rows, total]) out.push(`| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
    return out.join('\n');
  }
  for (const f of results) {
    const s = f.score;
    const t = s.strict;
    out.push(`${f.id}  ${f.repo}  (claims ${f.claims.join(', ') || 'not listed'}; ${f.records} mechanisms, generated ${f.generated || 'date not recorded'})`);
    out.push(`  names cited ${s.names}; in the index ${s.names - s.notIndexed}; in a mechanism ${s.inRecord}; in the index but in no mechanism ${s.belowFloor.length}${s.belowFloor.length ? `: ${s.belowFloor.slice(0, 12).join(', ')}${s.belowFloor.length > 12 ? ', ...' : ''}` : ''}`);
    out.push(`  matching exactly one function (or naming a class): ${t.functions}, of which in a mechanism ${t.inRecord}; matching several functions: ${s.ambiguous}; narrowed by a qualifier or a cited file: ${s.narrowed}`);
    if (t.best) out.push(`  one-function names: best mechanism ${t.best.id} ${t.best.label} (${t.best.size} members) holds ${t.best.held} of ${t.inRecord}; they sit in ${t.files} file(s); mechanisms to hold them all: ${t.cover.length}`);
    else out.push('  one-function names: none in a mechanism');
    if (t.top.length > 1) out.push(`    by names held: ${t.top.map((x) => `${x.id} ${x.label} ${x.held} (${x.size} members)`).join('; ')}`);
    if (s.best) out.push(`  any match (upper reading): best mechanism ${s.best.id} ${s.best.label} (${s.best.size} members) holds ${s.best.held} of ${s.inRecord}; mechanisms to hold them all: ${s.cover.length}`);
    if (verbose) for (const d of s.detail) out.push(`    ${d.name.padEnd(36)} ${d.kind === 'not-indexed' ? 'not in the index' : `${d.kind === 'class' ? 'class, ' : ''}${d.kept} of ${d.matched} function(s) kept, e.g. ${d.at[0]}  [${d.records.slice(0, 6).join(' ') || 'no mechanism'}${d.records.length > 6 ? ' ...' : ''}]`}`);
    out.push('');
  }
  out.push(`all ${rows.length} filing-repository pairs: names cited ${total[2]}; in the index ${total[3]}; in a mechanism ${total[4]}`);
  out.push(`  one-function names ${total[5]}, in a mechanism ${total[6]}; in ${total[7]} files; best mechanisms hold ${total[9]}; mechanisms to hold them all, summed ${total[10]}`);
  out.push(`  any match: best mechanisms hold ${total[11]}; mechanisms to hold them all, summed ${total[12]}`);
  return out.join('\n');
}

// --- output ----------------------------------------------------------------------

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');

export function summaryRow(name, s) {
  return [
    name, s.cites, s.setAside, s.notIndexed, s.noFunction, s.functions, s.inRecord,
    s.best ? `${s.best.id} ${s.best.label}` : 'none',
    s.best ? `${s.best.held} of ${s.functions} (${pct(s.best.held, s.functions)})` : 'n/a',
    s.best ? `${s.best.held} of ${s.best.size} (${pct(s.best.held, s.best.size)})` : 'n/a',
    s.cover.length, s.moved, s.edited, s.named ? `${s.namedAgree} of ${s.named}` : 'none',
  ];
}

export const SUMMARY_HEAD = ['page', 'cites', 'set aside', 'not indexed', 'no function', 'functions', 'in a record', 'best record', 'recall', 'purity', 'to cover', 'moved', 'edited', 'named'];

export function renderMarkdown(results) {
  const lines = [`| ${SUMMARY_HEAD.join(' | ')} |`, `|${SUMMARY_HEAD.map((_, i) => (i === 0 || i === 7 ? '---' : '--:')).join('|')}|`];
  for (const r of results) lines.push(`| ${summaryRow(r.name, r.score).map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  return lines.join('\n');
}

export function renderText(results, { verbose = false } = {}) {
  const out = [];
  for (const r of results) {
    const s = r.score;
    out.push(`${r.name}  (keyed at ${r.keyedAt || 'as written'}${r.keyedHow ? `, ${r.keyedHow}` : ''})`);
    out.push(`  cites ${s.cites}; set aside ${s.setAside} (docs, tests, file with no line); file not indexed ${s.notIndexed}; in no function ${s.noFunction} (${pct(s.noFunction, s.cites)})`);
    out.push(`  cited functions ${s.functions}; in a record ${s.inRecord}; under the four-line floor ${s.belowFloor.length}${s.belowFloor.length ? `: ${s.belowFloor.join(', ')}` : ''}`);
    if (s.best) out.push(`  best record ${s.best.id} ${s.best.label}: recall ${s.best.held} of ${s.functions} (${pct(s.best.held, s.functions)}), purity ${s.best.held} of ${s.best.size} (${pct(s.best.held, s.best.size)})`);
    else out.push('  best record: none');
    if (s.top.length > 1) out.push(`  records by cited functions held: ${s.top.map((t) => `${t.id} ${t.label} ${t.held} of its ${t.size}`).join('; ')}`);
    out.push(`  records to cover every cited function: ${s.cover.length}${s.cover.length ? ` (${s.cover.map((c) => `${c.id} ${c.label} +${c.gain}`).join('; ')})` : ''}`);
    out.push(`  line mapping: ${s.moved} cite(s) moved, ${s.edited} edited; named functions found where cited: ${s.named ? `${s.namedAgree} of ${s.named}` : 'none named'}`);
    if (verbose) {
      for (const d of s.detail) {
        const c = d.cite;
        const where = c.fileOnly ? c.file : `${c.file}:${c.start}${c.end !== c.start ? `-${c.end}` : ''}${c.open ? '+' : ''}`;
        const to = d.at && (d.at.start !== c.start || d.at.end !== c.end) ? ` -> ${d.at.start}-${d.at.end}${d.at.edited ? ' (edited)' : ''}` : '';
        const what = d.kind === 'function' ? d.landed.map((l) => `${l.id.split('@')[1]} [${l.records.join(' ') || 'no record'}]`).join(', ') : d.kind;
        out.push(`    ${d.claim.padEnd(12)} ${where}${to}  ${what}`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

// --- main ----------------------------------------------------------------------------

export function parseOwnArgs(argv) {
  const o = { index: null, pages: [], keyedAt: 'auto', tree: 'HEAD', rows: null, verbose: false, md: false, json: null, help: false, filings: null, only: null, calls: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--index' || a === '--ndx' || a === '--index-path') o.index = argv[++i];
    else if (a === '--keyed-at') o.keyedAt = argv[++i];
    else if (a === '--tree') o.tree = argv[++i];
    else if (a === '--rows') o.rows = argv[++i];
    else if (a === '--filings') o.filings = argv[++i];
    else if (a === '--calls') o.calls = true;
    else if (a === '--only') o.only = String(argv[++i] || '').split(',').map((x) => x.trim()).filter(Boolean);
    else if (a === '-v' || a === '--verbose') o.verbose = true;
    else if (a === '--md') o.md = true;
    else if (a === '--json') o.json = argv[++i];
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.pages.push(a);
  }
  return o;
}

/**
 * The call edges --calls needs, read from the full index: what each
 * one-function name calls, what those callees call, and who calls each name.
 * A callee is taken where CodeExam resolves it to one definition. A caller is
 * found by name (at most 300 call sites a name) and kept only when its own
 * resolved callees include the cited function, so a same-named function
 * elsewhere does not count.
 */
async function callEdges(dir, fnsByFile, scores) {
  const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
  const { findCallees, findCallersMany } = await import('../src/core/calls.js');
  const log = console.log;
  console.log = () => {};   // the index loader reports progress on stdout
  let idx;
  try { idx = new CodeSearchIndex({ indexPath: dir }); if (idx._ensureFunctionIndex) idx._ensureFunctionIndex(); } finally { console.log = log; }
  const fnById = new Map();
  for (const [file, fns] of fnsByFile) for (const f of fns) fnById.set(`${file}@${f.name}`, { ...f, file });
  const out = new Map();
  const outOf = (id) => {
    if (out.has(id)) return out.get(id);
    const set = new Set();
    out.set(id, set);
    const f = fnById.get(id);
    if (!f) return set;
    let rows = [];
    try { rows = findCallees(idx, f.name, f.raw, { target: { filepath: f.raw, name: f.name, start: f.start, end: f.end } }) || []; } catch { /* a body the reader cannot parse has no edges */ }
    for (const r of rows) { const d = r.resolved_def; if (d && d.filepath && d.full_name) set.add(`${slash(d.filepath)}@${d.full_name}`); }
    set.delete(id);
    return set;
  };
  const cited = new Map();
  for (const s of scores) for (const d of s.detail) if (d.fn) cited.set(`${d.fn.file}@${d.fn.name}`, d.fn);
  for (const id of cited.keys()) for (const x of [...outOf(id)]) outOf(x);
  const callers = new Map([...cited.keys()].map((id) => [id, new Set()]));
  const names = [...new Set([...cited.values()].map((f) => leafOf(f.name)))];
  let found = { byName: new Map() };
  console.log = () => {};
  try { found = findCallersMany(idx, names, 300); } catch { /* no inverted index: no caller edges */ } finally { console.log = log; }
  for (const [id, f] of cited) {
    for (const row of found.byName.get(leafOf(f.name)) || []) {
      if (!row.caller_function) continue;
      const file = slash(row.filepath);
      const x = (fnsByFile.get(file) || []).find((g) => g.name === row.caller_function) || (fnsByFile.get(file) || []).find((g) => leafOf(g.name) === leafOf(row.caller_function));
      if (!x) continue;
      const xid = `${file}@${x.name}`;
      if (xid !== id && outOf(xid).has(id)) callers.get(id).add(xid);
    }
  }
  return { out, callers };
}

async function mainFilings(o) {
  const work = path.resolve(o.filings);
  const mf = path.join(work, 'manifest.json');
  if (!fs.existsSync(mf)) { console.error(`mechanism-containment: ${mf} not found (--filings takes the work directory of scripts/recap-chart-agreement.mjs)`); process.exit(1); }
  const results = [];
  for (const f of filingsOf(JSON.parse(fs.readFileSync(mf, 'utf8')))) {
    if (o.only && !o.only.includes(f.id)) continue;
    const dir = path.join(work, 'indexes', f.dir);
    const fi = path.join(dir, 'function_index.json');
    const mj = path.join(dir, 'mechanisms.json');
    if (!fs.existsSync(fi) || !fs.existsSync(mj)) { console.error(`mechanism-containment: ${f.id} ${f.repo}: no ${fs.existsSync(fi) ? 'mechanisms.json (build it with --build-mechanisms)' : 'index'} under ${dir}; skipped`); continue; }
    const mech = JSON.parse(fs.readFileSync(mj, 'utf8'));
    const functionIndex = JSON.parse(fs.readFileSync(fi, 'utf8'));
    const fnsByFile = functionsByFile(functionIndex);
    const byMember = recordsByMember(mech.records);
    const score = scoreFiling(f.names, f.files, fnsByFile, byMember);
    // Each chart row is one claim limitation with the names cited for it. A
    // row's own files narrow its names; the filing's files do when it has none.
    const rows = f.chartRows.map((w) => ({ label: w.label, limitation: w.limitation, score: scoreFiling(w.names, w.files.length ? w.files : f.files, fnsByFile, byMember) }));
    const res = { ...f, records: mech.records.length, generated: mech.generated || null, score, rows, harness: harnessCounts(f.names, functionIndex, mech.records) };
    if (o.calls) {
      const edges = await callEdges(dir, fnsByFile, [score, ...rows.map((r) => r.score)]);
      res.calls = callComponents(oneFunctionIds(score), edges.out, edges.callers);
      // The check on the reader: a function with no edge read cannot be joined to anything.
      const ids = oneFunctionIds(score);
      res.calls.withCallee = ids.filter((id) => (edges.out.get(id) || new Set()).size).length;
      res.calls.withCaller = ids.filter((id) => (edges.callers.get(id) || new Set()).size).length;
      res.callers = callerReading(ids, edges.out, edges.callers);
      for (const r of rows) { r.calls = callComponents(oneFunctionIds(r.score), edges.out, edges.callers); r.callers = callerReading(oneFunctionIds(r.score), edges.out, edges.callers); }
      process.stderr.write(`# ${f.id} ${f.repo}: call edges read for ${edges.out.size} functions\n`);
    }
    results.push(res);
  }
  if (!results.length) { console.error('mechanism-containment: no filing scored'); process.exit(1); }
  console.log(renderFilings(results, { md: o.md, verbose: o.verbose }));
  const rowsOut = renderRows(results, { md: o.md });
  if (rowsOut) console.log(`\n${o.md ? '' : 'per chart row (one claim limitation each):\n'}${rowsOut}`);
  if (o.calls) {
    console.log(`\n${o.md ? '' : 'per filing, the one-function names by calls:\n'}${results.map((f) => (o.md ? `| ${f.id} | ${f.repo} | ${f.calls.functions} | ${f.calls.direct} | ${f.calls.chain} | ${f.calls.commonCaller} |` : `${f.id.padEnd(22)} ${f.repo.padEnd(38)} functions ${String(f.calls.functions).padStart(2)}; groups by calls ${f.calls.direct} / ${f.calls.chain} / ${f.calls.commonCaller} (direct / one step / common caller); with a callee read ${f.calls.withCallee}, with a caller read ${f.calls.withCaller}`)).join('\n')}`);
  }
  if (o.calls && !o.md) {
    // Which callers join: per filing, then per chart row with -v.
    const line = (name, k, bestHeld) => `${name} joining callers ${k.joiners} (${k.testJoiners} in test code); groups with a common caller ${k.groups}, test callers left out ${k.groupsNoTest}; best non-test caller ${k.best ? `${k.best.caller.split('@').pop()} holds ${k.best.calls + (k.best.cited ? 1 : 0)} (${k.best.callees} callees${k.best.cited ? ', itself cited' : ''})` : 'none'}; best mechanism holds ${bestHeld}`;
    const held = (s) => (s.strict.best ? s.strict.best.held : 0);
    console.log('\nthe callers that join (a function calling two or more of the one-function names):');
    for (const f of results) {
      console.log(line(`${f.id.padEnd(22)} ${f.repo.padEnd(38)}`, f.callers, held(f.score)));
      if (o.verbose) for (const r of f.rows) if (r.callers.functions >= 2) {
        console.log(`  ${line(r.label.padEnd(8), r.callers, held(r.score))}`);
        for (const j of r.callers.list.slice(0, 6)) console.log(`      ${j.test ? 'test  ' : '      '}${j.caller}: calls ${j.calls} of ${r.callers.functions}, ${j.callees} callees${j.cited ? ', itself cited' : ''}`);
      }
    }
  }
  const h = results.reduce((a, r) => ({ inIndex: a.inIndex + r.harness.inIndex, inRecord: a.inRecord + r.harness.inRecord }), { inIndex: 0, inRecord: 0 });
  console.log(`\ncheck, by the 2026-11-06 reach run's rule (any symbol of that name, no narrowing): ${h.inIndex} names in the indexes, ${h.inRecord} in a mechanism`);
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ filings: o.filings, results }, null, 2));
}

function main() {
  let o;
  try { o = parseOwnArgs(process.argv.slice(2)); } catch (e) { console.error(`mechanism-containment: ${e.message} (--help lists the options)`); process.exit(2); }
  if (o.filings && !o.help) { mainFilings(o).catch((e) => { console.error(`mechanism-containment: ${e.stack || e.message}`); process.exit(1); }); return; }
  if (o.help || !o.index) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => /^ \*( |$)/.test(l)).map((l) => l.slice(3)).join('\n'));
    if (!o.help) console.error('\nmechanism-containment: --index <dir> or --filings <work dir> is required');
    process.exit(o.help ? 0 : 2);
  }
  const dir = path.resolve(ROOT, o.index);
  const need = (f, how) => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { console.error(`mechanism-containment: ${p} not found (${how})`); process.exit(1); }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };
  const fnsByFile = functionsByFile(need('function_index.json', 'is --index an index directory?'));
  const mech = need('mechanisms.json', `build it with: node src/index.js --index-path ${o.index} --build-mechanisms`);
  const byMember = recordsByMember(mech.records);
  if (!o.pages.length) {
    const d = path.join(ROOT, 'docs', 'pseudo-claim-rubrics');
    o.pages = fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort().map((f) => path.join(d, f));
  }
  const rowFilter = o.rows ? new RegExp(o.rows) : null;
  const results = [];
  for (const p of o.pages) {
    const abs = path.resolve(p);
    const { rows } = parsePage(fs.readFileSync(abs, 'utf8'));
    if (!rows.length) { console.error(`mechanism-containment: no citations table in ${p}; skipped`); continue; }
    let keyedAt = null;
    let keyedHow = null;
    if (o.keyedAt === 'auto') {
      // The page's lines were true at one of the commits that wrote the page.
      // Which one: the commit at which the most named cites land, by their
      // lines, in the function they name; the earliest such commit on a tie.
      let commits = [];
      try { commits = git(['log', '--format=%h', '--', abs]).trim().split(/\s+/).filter(Boolean).reverse(); } catch { /* not in git */ }
      let bestAgree = -1;
      for (const c of commits) {
        const s = scorePage(rows, fnsByFile, byMember, { hunksFor: gitHunkSource(c, o.tree) });
        if (s.namedAgree > bestAgree) { bestAgree = s.namedAgree; keyedAt = c; keyedHow = `best of the page's ${commits.length} commits: ${s.namedAgree} of ${s.named} named cites land by line`; }
      }
    } else if (o.keyedAt !== 'none') keyedAt = o.keyedAt;
    const hunksFor = keyedAt ? gitHunkSource(keyedAt, o.tree) : null;
    results.push({ name: path.basename(abs, '.md'), keyedAt, keyedHow, score: scorePage(rows, fnsByFile, byMember, { hunksFor, rowFilter }) });
  }
  console.log(`index ${o.index}: ${mech.records.length} records (mechanisms.json generated ${mech.generated || 'date not recorded'}); tree ${o.tree}${rowFilter ? `; rows matching ${o.rows}` : ''}\n`);
  console.log(o.md ? renderMarkdown(results) : renderText(results, { verbose: o.verbose }));
  if (o.json) fs.writeFileSync(o.json, JSON.stringify({ index: o.index, tree: o.tree, rows: o.rows, generated: mech.generated || null, results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
