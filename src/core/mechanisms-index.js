// mechanisms-index.js — builds, saves and loads <index>/mechanisms.json, the persisted cover of an index's functions by mechanism record
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

// Functions grouped per minute of build, from the 2026-11-04 apply
// measurements: .CE_103126 2,987 functions in 4.1 s, .AI_Manning_recent
// 1,622 in 1.8 s, .sr_gh 6,368 in 14.0 s, .WinAPI_Classic 74,061 in about
// eight minutes (the grouping is a third of it; the rest is purposes and
// outbound calls, one findCallees per member walked). Small indexes run
// far faster than this rate; the estimate is for the not-built line, so
// "about N minutes" is a reader's order of magnitude on a large index, not
// a promise.
export const FUNCTIONS_PER_MINUTE = 9000;
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
 * the purpose text `purposeFor(label, members, group)` yields (the
 * pseudo-claims harvester, passed in by the command so core does not import
 * a command module) and the outbound calls as the last-resort purpose.
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
    if (purposeFor) { try { purpose = String(purposeFor(g.label, g.members, g) || ''); } catch { purpose = ''; } }
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

/** CE's shared filter contract (substring, `/regex/`) over a record's id, label, purpose, description, tags, files and member names. */
export function filterRecords(records, filter) {
  if (!filter) return records || [];
  const match = makeFilterMatcher(filter);
  return (records || []).filter((r) => match(r.id, r.label, r.purpose || '', r.description || '', ...(r.tags || []), ...(r.files || []), ...(r.members || []).map((m) => m.name)));
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

/**
 * The CLI rendering of a record list: a header, then per record its id,
 * label, counts and tags, the description (when a model wrote one) or the
 * purpose, and the member names (every member as `file@name` under
 * `verbose`). Returns { lines, shown, total }.
 */
export function formatMechanismsList(data, records, { filter = null, max = 100, verbose = false, displayName = null } = {}) {
  const dn = typeof displayName === 'function' ? displayName : (n) => n;
  const total = records.length;
  const shown = Math.min(total, Number.isFinite(max) ? max : total);
  const lines = [];
  lines.push(`${nf(total)} mechanism record${total === 1 ? '' : 's'}${filter ? ` matching '${filter}'` : ''}${shown < total ? ` (showing ${nf(shown)})` : ''}: ${coverageLine(data)}`);
  for (const r of records.slice(0, shown)) {
    const files = r.files ? r.files.length : 0;
    const tags = r.tags && r.tags.length ? `  [${r.tags.join(', ')}]` : '';
    lines.push('', `${r.id.padEnd(6)}${r.label}  (${nf(r.members.length)} fn${r.members.length === 1 ? '' : 's'}, ${nf(files)} file${files === 1 ? '' : 's'})${tags}`);
    const text = r.description || r.purpose || '';
    if (text) lines.push(`      ${(!verbose && text.length > 240) ? text.slice(0, 239) + '…' : text}`);
    if (verbose) {
      for (const m of r.members) lines.push(`      ${m.file}@${dn(m.name)}`);
    } else {
      const names = r.members.slice(0, 12).map((m) => dn(m.name));
      const more = r.members.length > 12 ? ` (+${nf(r.members.length - 12)} more; -v lists every member as file@name)` : '';
      lines.push(`      ${names.join(', ')}${more}`);
    }
  }
  if (shown < total) lines.push('', `${nf(shown)} of ${nf(total)} shown; --max-results 0 shows all, --mechanisms <filter> narrows.`);
  return { lines, shown, total };
}
