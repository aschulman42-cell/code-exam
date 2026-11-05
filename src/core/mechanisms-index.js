// mechanisms-index.js — builds, saves, loads and folds <index>/mechanisms.json, the persisted cover of an index's functions by mechanism record; the entries every consumer lists (records with identical member sets as one) and the --mechanisms and --toc renderings
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// mechanisms-index-prebuild-cli-gui (#359 parts C and D, #284): the grouper
// run ONCE in cover mode and written beside the index, so the CLI
// (--mechanisms), the GUI's Mechanisms list and the MCP list_mechanisms tool
// read one file instead of each recomputing a grouping that takes minutes
// on a large index (13 on .WinAPI_Classic, 73 on .Py314_site_pkg for the
// drafting list, 2026-11-03). Nothing here runs a model; --describe (Part E,
// src/commands/mechanisms.js) fills `description` afterwards.
//
// The file:
//   { format: 'ce-mechanisms', version, generated, index, settings,
//     coverage: { functions, inGroups, files, filesRepresented }, timing,
//     described?: { engine, generated, records, failed },
//     records: [ { id, label, kind, members, files, purpose, calls,
//                  priority, description, tags } ] }
// one record per cover group: `kind` is 'file' | 'class' | 'cmd' | 'token'
// | 'lit' | 'body' | 'residue'; `members` are { file, name, start, end }, read
// by file and line range (never re-resolved from an anchor); `purpose` is the
// harvester's text; `calls` the top outbound callees; `priority` null until
// a ranker writes it; `description` null until --describe; `tags` any of
// 'test', 'noise', 'vendored', 'giant', 'indivisible'. Records are written
// one per line so `grep` finds a label without parsing the file.
//
// Alternatives the item's draft rejected: building inside --build-index
// (adds the grouping time to every big build) and building lazily on first
// request (the GUI would hang on it).

import fs from 'node:fs';
import path from 'node:path';
import { groupMechanisms, GROUPER_DEFAULTS, outboundCalls } from './mechanism-grouper.js';
import { makeFilterMatcher } from './filter-match.js';
import { quotePathIfNeeded } from '../utils.js';

export const MECHANISMS_FORMAT = 'ce-mechanisms';
export const MECHANISMS_VERSION = 1;
export const MECHANISMS_FILE = 'mechanisms.json';

export function mechanismsPath(index) {
  if (index && typeof index._mechanismsPath === 'function') return index._mechanismsPath();
  return path.join((index && index.indexPath) || '.', MECHANISMS_FILE);
}

/** The record kind a grouper label encodes. */
export function kindOf(label) {
  const l = String(label || '');
  if (/\/\s*rest(\s*\/|\s*$)/.test(l)) return 'residue';
  const m = l.match(/^\[(file|class|cmd|lit|body)\]/);
  return m ? m[1] : 'token';
}

/** Indexed-function count of a loaded index: the size the build time scales with. */
export function candidateCount(index) {
  try { index._ensureFunctionIndex?.(); } catch { /* a fake */ }
  let n = 0;
  for (const fns of Object.values((index && index.functionIndex) || {})) n += Object.keys(fns || {}).length;
  return n;
}

// Functions (the index's count, candidates or not) per minute of build,
// from the 2026-11-04 rebuilds after build-mechanisms-reads-by-span:
// .Py314_site_pkg 378,225 functions (229,665 candidates, 51,194 records) in
// 520 s, 13 s of it the grouping; .WinAPI_Classic 74,061 (60,991; 13,078) in
// 208 s, 182 s of it the grouping; .sr_gh 6,368 in 14 s; .CE_103126 2,987
// in 4 s. Before that item the per-record reads resolved names against the
// whole function index and Py314 projected to a day (the rate was 9,000 and
// said 42 minutes). The estimate is for the not-built line, so "about N
// minutes" is a reader's order of magnitude on a large index, not a
// promise; 25,000 puts Py314 at about 15 and WinAPI at about 3.
export const FUNCTIONS_PER_MINUTE = 25000;
export function estimateBuildMinutes(functionCount) {
  return Math.max(1, Math.round((Number(functionCount) || 0) / FUNCTIONS_PER_MINUTE));
}

/** The one line every consumer prints when the file is absent. */
export function notBuiltLine(index, { exe = process.env.CODEEXAM_INVOKED_AS || 'ce', indexPath = null } = {}) {
  const ip = indexPath || (index && index.indexPath) || '<index>';
  const minutes = estimateBuildMinutes(candidateCount(index));
  return `not built: run ${exe} --index-path ${quotePathIfNeeded(String(ip))} --build-mechanisms (about ${minutes} minute${minutes === 1 ? '' : 's'} on an index this size)`;
}

/**
 * Build the records: the grouper in cover mode, one record per group, with
 * the purpose text `purposeFor(label, members, group, calls)` yields (the
 * pseudo-claims harvester, passed in by the command so core does not import
 * a command module; the calls go along so the harvester knows the builder
 * has a `calls:` line to write before its own last resort) and the outbound
 * calls as the purpose when the harvester yields nothing.
 */
export function buildMechanismsIndex(index, { indexName = '', purposeFor = null, groupMax = GROUPER_DEFAULTS.groupMax, onProgress = null } = {}) {
  const t0 = Date.now();
  const result = groupMechanisms(index, { mode: 'cover', indexName, groupMax });
  const groupMs = Date.now() - t0;
  const records = [];
  let n = 0;
  for (const g of result.groups) {
    n++;
    const members = g.members.map((m) => ({ file: m.file, name: m.name.includes('@') ? m.bare : m.name, start: m.start, end: m.end }));
    const files = [...new Set(members.map((m) => m.file))];
    const calls = outboundCalls(index, g.members);
    let purpose = '';
    if (purposeFor) { try { purpose = String(purposeFor(g.label, g.members, g, calls) || ''); } catch { purpose = ''; } }
    if (!purpose && calls.length) purpose = `calls: ${calls.join(', ')}`;
    records.push({ id: `m${n}`, label: g.label, kind: kindOf(g.label), members, files, purpose, calls, priority: null, description: null, tags: g.tags || [] });
    if (onProgress && n % 200 === 0) onProgress(n, result.groups.length);
  }
  const inGroups = new Set(result.groups.flatMap((g) => [...g.ids])).size;
  const allFiles = new Set(result.funcs.map((f) => f.file)).size;
  const filesRepresented = new Set(records.flatMap((r) => r.files)).size;
  return {
    format: MECHANISMS_FORMAT,
    version: MECHANISMS_VERSION,
    generated: new Date().toISOString(),
    index: indexName,
    settings: {
      mode: 'cover', groupMax, minComm: 1,
      catalogDepth: result.catalogDepth ?? null, catalogClosureMax: result.catalogClosureMax ?? null,
      vendored: (result.vendored || []).map((v) => v.root), noiseFiles: result.noiseFiles || 0, vendorFiles: result.vendorFiles || 0,
    },
    coverage: { functions: result.funcs.length, inGroups, files: allFiles, filesRepresented },
    timing: { groupMs, totalMs: Date.now() - t0 },
    records,
  };
}

/**
 * Carry the model descriptions of a previous file into a rebuilt one: a new
 * record takes the old description when a record of the same label held
 * exactly the same members (`file@name` set), so a sentence paid for once
 * survives a rebuild whose grouping did not change that record. Returns the
 * count carried; the `described` block comes along when anything did.
 */
export function carryDescriptions(prev, next) {
  if (!prev || !Array.isArray(prev.records) || !next || !Array.isArray(next.records)) return 0;
  const key = (r) => `${r.label}\u0000${(r.members || []).map((m) => `${m.file}@${m.name}`).sort().join('\u0001')}`;
  const old = new Map();
  for (const r of prev.records) if (r.description) old.set(key(r), r.description);
  let carried = 0;
  for (const r of next.records) {
    const d = old.get(key(r));
    if (d) { r.description = d; carried++; }
  }
  if (carried && prev.described) {
    next.described = { ...prev.described, records: carried, carriedFrom: prev.generated || null };
  }
  return carried;
}

/** Write the file, one record per line; returns its path. Drops the loader's cache. */
export function saveMechanismsIndex(index, data) {
  const file = mechanismsPath(index);
  const { records, ...head } = data;
  const text = JSON.stringify(head).slice(0, -1) + ',"records":[\n'
    + (records || []).map((r) => JSON.stringify(r)).join(',\n')
    + '\n]}\n';
  fs.writeFileSync(file, text, 'utf8');
  if (index) index._mechanismsCache = null;
  return file;
}

/**
 * Read the file: null when absent; throws when present but not a
 * ce-mechanisms file. Cached on the index object by the file's mtime and
 * size, so the GUI route and the MCP tool do not re-parse it per request.
 */
export function loadMechanismsIndex(index, { cache = true } = {}) {
  const file = mechanismsPath(index);
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.mtimeMs}:${st.size}`;
  if (cache && index && index._mechanismsCache && index._mechanismsCache.key === key) return index._mechanismsCache.data;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || data.format !== MECHANISMS_FORMAT || !Array.isArray(data.records)) throw new Error(`${file} is not a ${MECHANISMS_FORMAT} file`);
  if (cache && index) index._mechanismsCache = { key, data };
  return data;
}

// mechanisms-toc-one-row-per-mechanism (#296): the cover overlaps by design,
// and a one-class file comes out as both `[class] Foo` and `[file] foo.py`
// with the same functions, a token group and a file piece likewise
// (measured 2026-11-05: CodeExam 7 such pairs among 390 records, Bram 28 of
// 723, sr_gh 127 of 1,299, WinAPI 1,191 of 13,078). Two rows for one function
// set is a duplicate in every listing and two paid sentences in a describe
// pass, so every consumer lists ENTRIES: records with identical member sets
// folded into one. Nothing looser folds: a class inside a larger file record
// is its own mechanism. A listing never writes the file.

/** The `file@name` set of a record, sorted, as one string: the identity the fold works on. */
export function memberKey(r) {
  return ((r && r.members) || []).map((m) => `${m.file}@${m.name}`).sort().join('\u0001');
}

/** Records grouped by identical member set, in the records' order (a group sits where its first record sat). */
export function foldGroups(records) {
  const groups = new Map();
  for (const r of records || []) {
    const k = memberKey(r);
    const g = groups.get(k);
    if (g) g.push(r); else groups.set(k, [r]);
  }
  return [...groups.values()];
}

// The representative names the entry: the described record when exactly one
// is (the sentence a reader paid for), else the record whose kind names a
// thing rather than a place; ties keep the file's order.
const KIND_RANK = { cmd: 0, class: 1, token: 2, lit: 2, body: 2, residue: 3, file: 3 };
export function pickRepresentative(group) {
  const described = group.filter((r) => r.description);
  if (described.length === 1) return described[0];
  const pool = described.length ? described : group;
  let best = pool[0];
  for (const r of pool) if ((KIND_RANK[r.kind] ?? 2) < (KIND_RANK[best.kind] ?? 2)) best = r;
  return best;
}

/**
 * The entries every consumer lists: one per distinct member set, the
 * representative's fields (its id still means what it meant) with `aliases`
 * ({ id, label, kind } of the other records), `tags` the union and
 * `recordCount`.
 */
export function foldRecords(records) {
  return foldGroups(records).map((g) => {
    const rep = pickRepresentative(g);
    const tags = [...new Set(g.flatMap((r) => r.tags || []))];
    return { ...rep, tags, aliases: g.filter((r) => r !== rep).map((r) => ({ id: r.id, label: r.label, kind: r.kind })), recordCount: g.length };
  });
}

/** "(N records, K folded as the same functions under another label)" for a list of entries, or '' when nothing folded. */
export function foldNote(entries) {
  const records = (entries || []).reduce((s, r) => s + (r.recordCount || 1), 0);
  const folded = records - (entries || []).length;
  return folded ? ` (${nf(records)} records, ${nf(folded)} folded as the same functions under another label)` : '';
}

/** CE's shared filter contract (substring, `/regex/`) over a record's id, label, purpose, description, tags, files, member names and, on an entry, its aliases' ids and labels. */
export function filterRecords(records, filter) {
  if (!filter) return records || [];
  const match = makeFilterMatcher(filter);
  return (records || []).filter((r) => match(r.id, r.label, r.purpose || '', r.description || '', ...(r.tags || []), ...(r.files || []), ...(r.members || []).map((m) => m.name), ...(r.aliases || []).flatMap((a) => [a.id, a.label])));
}

const nf = (x) => Number(x || 0).toLocaleString('en-US');

/** The one-line summary of a loaded file: what it covers and when it was built. */
export function coverageLine(data) {
  const c = (data && data.coverage) || {};
  const pct = c.functions ? Math.round(100 * c.inGroups / c.functions) : 0;
  const when = String(data && data.generated || '').slice(0, 10);
  const d = data && data.described;
  const total = (data && data.records || []).length;
  const desc = d ? (d.records >= total ? `, described by ${d.engine}` : `, ${nf(d.records)} of ${nf(total)} described by ${d.engine}`) : '';
  return `a cover of ${nf(c.inGroups)} of ${nf(c.functions)} functions (${pct}%), ${nf(c.filesRepresented)} of ${nf(c.files)} files; built ${when || 'unknown'} by --build-mechanisms${desc}`;
}

const countsOf = (r) => {
  const files = r.files ? r.files.length : 0;
  return `${nf(r.members.length)} fn${r.members.length === 1 ? '' : 's'}, ${nf(files)} file${files === 1 ? '' : 's'}`;
};
const tagsOf = (r) => (r.tags && r.tags.length ? `  [${r.tags.join(', ')}]` : '');
const alsoOf = (r) => (r.aliases && r.aliases.length ? `also ${r.aliases.map((a) => a.label).join(', ')}` : '');

/**
 * One entry's block: its id and, when a model wrote one, its description
 * first with the label, counts and tags on the next line
 * (mechanisms-description-leads: the sentence is the record's title; the
 * harvested purpose is a doc fragment or a `calls:` line, so it stays under
 * the label), else the label line and the purpose beneath it; `also` and the
 * other labels when the entry folds several records; then the member names
 * (every member as `file@name` under `verbose`). `cut` trims the text.
 */
export function recordBlock(r, { verbose = false, dn = (n) => n, cut = (t) => t } = {}) {
  const labelLine = `${r.label}  (${countsOf(r)})${tagsOf(r)}`;
  const lines = [];
  if (r.description) {
    lines.push(`${r.id.padEnd(6)}${cut(r.description)}`, `      ${labelLine}`);
  } else {
    lines.push(`${r.id.padEnd(6)}${labelLine}`);
    if (r.purpose) lines.push(`      ${cut(r.purpose)}`);
  }
  const also = alsoOf(r);
  if (also) lines.push(`      ${also}`);
  if (verbose) {
    for (const m of r.members) lines.push(`      ${m.file}@${dn(m.name)}`);
  } else {
    const names = r.members.slice(0, 12).map((m) => dn(m.name));
    const more = r.members.length > 12 ? ` (+${nf(r.members.length - 12)} more; -v lists every member as file@name)` : '';
    lines.push(`      ${names.join(', ')}${more}`);
  }
  return lines;
}

/**
 * The CLI rendering of an entry list (the MCP list_mechanisms tool prints
 * the same lines): a header with the entry count, the fold note and the
 * coverage line, then each entry's block (`verbose` also lifts the
 * 240-character cut on the text). Returns { lines, shown, total }.
 */
export function formatMechanismsList(data, records, { filter = null, max = 100, verbose = false, displayName = null, exe = process.env.CODEEXAM_INVOKED_AS || 'ce', describeHint = true } = {}) {
  const dn = typeof displayName === 'function' ? displayName : (n) => n;
  const total = records.length;
  const shown = Math.min(total, Number.isFinite(max) ? max : total);
  const cut = (text) => (!verbose && text.length > 240) ? text.slice(0, 239) + '…' : text;
  const lines = [];
  lines.push(`${nf(total)} mechanism${total === 1 ? '' : 's'}${foldNote(records)}${filter ? ` matching '${filter}'` : ''}${shown < total ? ` (showing ${nf(shown)})` : ''}: ${coverageLine(data)}`);
  for (const r of records.slice(0, shown)) lines.push('', ...recordBlock(r, { verbose, dn, cut }));
  if (shown < total) lines.push('', `${nf(shown)} of ${nf(total)} shown; --all-results or --max-results 0 shows all, --mechanisms <filter> narrows.`);
  // A file nobody has described yet ends by saying how to get descriptions,
  // with the active filter in the command because describing the listed
  // records is the cheap way (Andrew's first Bram listing, 2026-11-04, asked
  // exactly this); at the bottom, where a reader of a long listing looks.
  // Once any record is described the header's "described by" line and its
  // "N of M" count carry the state instead; a --describe in the same command
  // reports its own outcome there and turns the line off.
  if (describeHint && total && !(data && data.described)) {
    const ip = quotePathIfNeeded(String((data && data.index) || '<index>'));
    lines.push('', `No model descriptions yet: ${exe} --index-path ${ip} --mechanisms${filter ? ` ${quotePathIfNeeded(String(filter))}` : ''} --describe --llm claude writes one sentence per listed mechanism (about $0.003 each on Claude; above the $2 claims guard add --force).`);
  }
  return { lines, shown, total };
}

/** A purpose as a table-of-contents snippet: whitespace collapsed, cut at `max` characters (the chart TOC's rule). */
export function purposeSnippet(text, max = 90) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/**
 * `--toc [filter]` (#296): the table of contents, one numbered line per
 * entry in the file's order (the order --mechanisms prints, so the two
 * agree; no rank, since `priority` is null until a ranker exists, so the
 * number is an ordinal). A described entry leads with its sentence and
 * carries the label in the parenthesis; an undescribed one leads with its
 * label and quotes its purpose cut at 90 characters; tags in brackets; a
 * folded entry ends `also <labels>`. `verbose` follows each line with the
 * block --mechanisms -v prints, the terminal's "clickable to cites". The
 * footer counts the entries without a sentence and says how to get them,
 * with the filter in the command. Returns { lines, shown, total }.
 */
export function formatMechanismsToc(data, entries, { filter = null, max = 100, verbose = false, displayName = null, exe = process.env.CODEEXAM_INVOKED_AS || 'ce', describeHint = true } = {}) {
  const dn = typeof displayName === 'function' ? displayName : (n) => n;
  const total = entries.length;
  const shown = Math.min(total, Number.isFinite(max) ? max : total);
  const width = String(shown).length;
  const lines = [`${nf(total)} mechanism${total === 1 ? '' : 's'}${foldNote(entries)}${filter ? ` matching '${filter}'` : ''}${shown < total ? ` (showing ${nf(shown)})` : ''}: ${coverageLine(data)}`, ''];
  let n = 0;
  for (const r of entries.slice(0, shown)) {
    n++;
    const num = `${String(n).padStart(width)}. `;
    const also = alsoOf(r) ? `  ${alsoOf(r)}` : '';
    if (r.description) lines.push(`${num}${r.description}  (${r.label}; ${countsOf(r)})${tagsOf(r)}${also}`);
    else lines.push(`${num}${r.label}  (${countsOf(r)})${r.purpose ? ` — "${purposeSnippet(r.purpose)}"` : ''}${tagsOf(r)}${also}`);
    if (verbose) {
      for (const l of recordBlock(r, { verbose: true, dn })) lines.push(`${' '.repeat(width + 2)}${l}`);
      lines.push('');
    }
  }
  if (shown < total) lines.push('', `${nf(shown)} of ${nf(total)} shown; --all-results or --max-results 0 shows all, --toc <filter> narrows.`);
  const undescribed = entries.filter((r) => !r.description).length;
  if (describeHint && undescribed) {
    const ip = quotePathIfNeeded(String((data && data.index) || '<index>'));
    lines.push('', `${nf(undescribed)} of ${nf(total)} without a model description: ${exe} --index-path ${ip} --toc${filter ? ` ${quotePathIfNeeded(String(filter))}` : ''} --describe --llm claude writes one sentence per listed mechanism (about $0.003 each on Claude; above the $2 claims guard add --force).`);
  }
  return { lines, shown, total };
}
