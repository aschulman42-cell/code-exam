#!/usr/bin/env node
// hof-stage1.mjs — scores every HOF claim against every grouper group of its index by tier-0 text (BM25, no model): where does the drafted group rank?
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * scripts/hof-stage1.mjs — issue-359-hof-stage1-feasibility-check (2026-11-03).
 *
 * The question (issue #359, part E.1): if --claim-locate retrieved from a
 * MECHANISMS INDEX instead of the symbol table, would the cheap record be
 * enough? A tier-0 record is what the grouper already writes for a group with
 * no model: its label, its purpose text (the file's doc header), its member
 * function names and their file names. This script scores every claim a HOF
 * run drafted against every group of that run's candidate list, by that text
 * alone, and reports where the group the claim was drafted FROM ranks.
 *
 * Usage:
 *   node scripts/hof-stage1.mjs (--hof <dir>[,<dir>...] | --hof-root [<root>])
 *        [--index-path <dir>] [--scorer bm25|overlap] [--top N] [--out <file.md>]
 *
 *   --hof <dir>        one or more HOF run directories (scripts/hof.mjs output:
 *                      cand.lst + claims.txt.anchors.json), comma-separated
 *   --hof-root [root]  every run directory under <root> that holds both files
 *                      (default root: %LOCALAPPDATA%\CodeExam\hof)
 *   --index-path <dir> the tier-0+body variant: add each member's comments and
 *                      string literals from the index (one --hof dir only)
 *   --scorer           bm25 (default; k1 1.2, b 0.75) or overlap (distinct
 *                      query stems present)
 *   --b <0..1>         BM25 length normalization (default 0.75; 0 = none).
 *                      The drafted groups on large indexes are the hundreds-
 *                      of-members residue and class groups, which b punishes
 *   --top N            labels shown per claim in the detail (default 5)
 *   --out <file.md>    write the Markdown report there and a JSON record
 *                      (format 'ce-hof-stage1') beside it
 *   --records-out <dir> write each index's mechanism list as it was scored,
 *                      one Markdown table per run (<index>_records.md: label,
 *                      members, files, cleaned purpose, stem count)
 *
 * A VALIDATION HARNESS, NOT A CLI COMMAND, beside anchor-recall.mjs and
 * hof.mjs. The claim was drafted from the group's own names, so a high rank is
 * necessary for the mechanisms-index design and not sufficient: the litigants'
 * charts are the honest test. The control column scores each claim with
 * ANOTHER claim's text from the same run (embedding-reach's shuffled control),
 * so a hit is attributed to the claim and not to the index.
 *
 * What is reused, not re-parsed: the claim tokenizer of src/core/claim-terms.js
 * (STOP list, stemmer), splitCompoundToken of src/utils.js for identifiers,
 * parseCandidateGroups of scripts/hof.mjs for cand.lst and parseAnchorHeader
 * of src/core/mechanism-grouper.js for the group header.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentWords, stem } from '../src/core/claim-terms.js';
import { splitCompoundToken } from '../src/utils.js';
import { parseAnchorHeader } from '../src/core/mechanism-grouper.js';
import { parseCandidateGroups, baseName } from './hof.mjs';

export const SCORERS = ['bm25', 'overlap'];
export const HITS_AT = [1, 5, 20];

const USAGE = [
  'usage: node scripts/hof-stage1.mjs (--hof <dir>[,<dir>...] | --hof-root [<root>])',
  '            [--index-path <dir>] [--scorer bm25|overlap] [--b <0..1>] [--top N] [--out <file.md>]',
  '            [--records-out <dir>]',
  '',
  '  Scores every claim a HOF run drafted against every group of its candidate',
  '  list by tier-0 text (label, purpose, member and file names; no model) and',
  '  reports where the group the claim was drafted from ranks. Issue #359 E.1.',
].join('\n');

// ---------------------------------------------------------------- arguments

export function defaultHofRoot() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(root, 'CodeExam', 'hof');
}

export function parseOwnArgs(argv) {
  const o = { hof: [], hofRoot: null, indexPath: null, scorer: 'bm25', b: 0.75, top: 5, out: null, recordsOut: null, help: false };
  const need = (i, flag) => {
    if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--hof') o.hof.push(...need(i++, a).split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--hof-root') {
      if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) o.hofRoot = argv[++i];
      else o.hofRoot = defaultHofRoot();
    } else if (a === '--index-path') o.indexPath = need(i++, a);
    else if (a === '--scorer') o.scorer = need(i++, a);
    else if (a === '--b') o.b = Number(need(i++, a));
    else if (a === '--top') o.top = Number(need(i++, a));
    else if (a === '--out') o.out = need(i++, a);
    else if (a === '--records-out') o.recordsOut = need(i++, a);
    else throw new Error(`unknown option: ${a}`);
  }
  if (o.help) return o;
  if (!o.hof.length && !o.hofRoot) throw new Error('one of --hof <dir> or --hof-root is required');
  if (!SCORERS.includes(o.scorer)) throw new Error(`--scorer must be ${SCORERS.join(' or ')}, got "${o.scorer}"`);
  if (!Number.isFinite(o.top) || o.top < 1) throw new Error('--top needs a positive number');
  if (!Number.isFinite(o.b) || o.b < 0 || o.b > 1) throw new Error('--b needs a number from 0 to 1');
  if (o.indexPath && (o.hofRoot || o.hof.length !== 1)) throw new Error('--index-path applies to exactly one --hof <dir>');
  return o;
}

/** Run directories under root that hold both files, sorted by name. */
export function listRunDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name))
    .filter((p) => fs.existsSync(path.join(p, 'cand.lst')) && fs.existsSync(path.join(p, 'claims.txt.anchors.json')))
    .sort();
}

// ------------------------------------------------------------- group records

// The grouper's residue template carries no mechanism; the names after the
// colon are the members, already tokenized from the anchor lines.
const RESIDUE_RE = /^the remainder of .*?\(draft what these functions do; the module'?s purpose belongs to its other groups\):?\s*/i;
// License boilerplate harvested as a doc header (the WinAPI `wnd` group got
// the Microsoft warranty paragraph). Same shape as the grouper's own rule.
const LICENSE_RE = /\b(copyright|\(c\)\s*\d{4}|licen[cs]ed? (?:under|to)|see licen[cs]e|apache license|mit license|gnu (?:general|lesser)|spdx-license|all rights reserved|permission is hereby granted|redistribution and use|warranty|as[- ]is)\b/i;

/** Purpose text with the residue template, license sentences and rule lines (`====`) removed. */
export function purposeText(purpose) {
  let p = String(purpose || '').replace(/[=\-_*#~]{4,}/g, ' ').replace(/\s+/g, ' ').trim();
  const m = p.match(RESIDUE_RE);
  if (m) p = p.slice(m[0].length);
  return p.split(/(?<=[.;!?])\s+/).filter((s) => !LICENSE_RE.test(s)).join(' ').trim();
}

/** Stems of the content words of free text (the claim tokenizer, both sides). */
export function textStems(text) {
  return contentWords(text).map(stem);
}

/** Stems of an identifier's parts: `CControl::ThreadFunction` -> control, thread, function. */
export function identStems(name) {
  const out = [];
  for (const part of String(name || '').split(/::|\./)) {
    for (const w of splitCompoundToken(part.replace(/[^A-Za-z0-9_]+/g, '_'), 3)) {
      if (/^[0-9]+$/.test(w)) continue;
      out.push(stem(w));
    }
  }
  return out;
}

/** One member anchor line -> { file, name } (line-range anchors have no name). */
export function parseMemberLine(line) {
  const s = String(line).trim();
  const at = s.lastIndexOf('@');
  if (at < 0) return { file: '', name: s };
  const name = s.slice(at + 1).replace(/@\d+$/, '');
  return { file: s.slice(0, at), name: /^L\d+-\d+$/.test(name) ? '' : name };
}

/**
 * The tier-0 record of one candidate group: its label, purpose, member names
 * and file names as stems. `bodyOf(file, name)` (optional) returns a member's
 * source for the tier-0+body variant: comments and string literals join.
 */
export function groupRecord(group, { bodyOf = null, maxBodyMembers = 60, maxBodyTokens = 200 } = {}) {
  const { label, priority, purpose } = group.header ? parseAnchorHeader(group.header) : { label: '', priority: null, purpose: '' };
  const tokens = [];
  tokens.push(...textStems(label.replace(/[()\[\]\/]/g, ' ')));
  for (const part of label.split(/[\s()\[\]\/]+/)) if (/[_A-Z]/.test(part) || part.length >= 8) tokens.push(...identStems(part));
  tokens.push(...textStems(purposeText(purpose)));
  const files = new Set();
  const members = [];
  for (const line of group.lines) {
    const m = parseMemberLine(line);
    members.push(m);
    if (m.name) tokens.push(...identStems(m.name));
    const base = baseName(m.file).replace(/\.[A-Za-z0-9]+$/, '');
    if (base && !files.has(base)) { files.add(base); tokens.push(...identStems(base)); }
  }
  let bodyTokens = 0;
  if (bodyOf) {
    for (const m of members.slice(0, maxBodyMembers)) {
      if (!m.name) continue;
      let src = null;
      try { src = bodyOf(m.file, m.name); } catch { src = null; }
      if (!src) continue;
      const t = textStems(commentsAndStrings(src)).slice(0, maxBodyTokens);
      bodyTokens += t.length;
      tokens.push(...t);
    }
  }
  return { label, priority, purpose: purposeText(purpose), members: members.length, files: files.size, tokens, bodyTokens };
}

/** Comments and string literals of a function body, crudely, every language. */
export function commentsAndStrings(src) {
  const out = [];
  const s = String(src || '');
  for (const m of s.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) out.push(m[0]);
  return out.join(' ');
}

// --------------------------------------------------------------------- scorers

/** BM25 over records; score(queryStems) returns one score per record. */
export function buildBm25(records, { k1 = 1.2, b = 0.75 } = {}) {
  const N = records.length;
  const df = new Map();
  const tfs = records.map((r) => {
    const tf = new Map();
    for (const t of r.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return tf;
  });
  const lens = records.map((r) => r.tokens.length);
  const avgdl = N ? lens.reduce((a, x) => a + x, 0) / N : 0;
  return {
    N, avgdl, df,
    score(queryStems) {
      const out = new Float64Array(N);
      for (const t of new Set(queryStems)) {
        const n = df.get(t) || 0;
        if (!n) continue;
        const w = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        for (let i = 0; i < N; i++) {
          const f = tfs[i].get(t);
          if (!f) continue;
          out[i] += w * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (avgdl ? lens[i] / avgdl : 1)));
        }
      }
      return out;
    },
  };
}

/** Overlap: distinct query stems present in the record, shorter record first on ties. */
export function buildOverlap(records) {
  const sets = records.map((r) => new Set(r.tokens));
  const N = records.length;
  return {
    N,
    score(queryStems) {
      const out = new Float64Array(N);
      const q = [...new Set(queryStems)];
      for (let i = 0; i < N; i++) {
        let hit = 0;
        for (const t of q) if (sets[i].has(t)) hit++;
        out[i] = hit ? hit + 1 / (1 + sets[i].size) : 0;
      }
      return out;
    },
  };
}

/** Competition rank of record i under scores (1 + records scoring higher); null when it scored 0. */
export function rankOf(scores, i) {
  const s = scores[i];
  if (!(s > 0)) return { rank: null, ties: 0, score: 0 };
  let greater = 0, ties = 0;
  for (let j = 0; j < scores.length; j++) {
    if (j === i) continue;
    if (scores[j] > s) greater++;
    else if (scores[j] === s) ties++;
  }
  return { rank: greater + 1, ties, score: s };
}

export function topOf(scores, records, n) {
  const idx = [...scores.keys()].filter((i) => scores[i] > 0).sort((a, b) => scores[b] - scores[a] || a - b).slice(0, n);
  return idx.map((i) => ({ i, label: records[i].label, score: scores[i] }));
}

// ------------------------------------------------------------------- sidecar

/** The sidecar's claims: n, groupN, label, claim text, element texts. */
export function readSidecarClaims(sidecar) {
  const out = [];
  for (const c of (sidecar && sidecar.claims) || []) {
    const elements = (Array.isArray(c.elements) ? c.elements : [])
      .map((e) => (typeof e === 'string' ? e : (e && (e.text || e.claim || e.limitation)) || ''))
      .filter(Boolean);
    out.push({ n: c.n, groupN: c.groupN ?? null, label: String(c.label || ''), claim: String(c.claim || ''), elements });
  }
  return out;
}

const normLabel = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The record index of the group a claim was drafted from, by label (then by groupN). */
export function findDrafted(claim, records) {
  const want = normLabel(claim.label);
  let i = records.findIndex((r) => normLabel(r.label) === want);
  if (i < 0 && want) i = records.findIndex((r) => normLabel(r.label).startsWith(want) || want.startsWith(normLabel(r.label)));
  if (i < 0 && Number.isInteger(claim.groupN) && claim.groupN >= 1 && claim.groupN <= records.length) i = claim.groupN - 1;
  return i;
}

// ------------------------------------------------------------------ scoring

/**
 * Score one run directory. Returns { dir, index, groups, variant, claims: [...] }
 * or { dir, error } when its files cannot be read.
 */
/** The mechanism list of one index as it was scored: one row per record, in the grouper's order. */
export function renderRecords(indexName, records, { variant = 'tier0' } = {}) {
  const out = [];
  out.push(`# ${indexName}: the ${records.length} mechanism records scored by hof-stage1 (${variant})`, '');
  out.push('One row per candidate group of the grouper\'s list, in its order. Purpose is the harvested doc-header text with license and residue boilerplate removed; stems is the number of tokens the record carries (label, purpose, member and file names split and stemmed), which is what the claim is scored against.', '');
  out.push('| # | mechanism | members | files | stems | purpose |');
  out.push('|--:|:--|--:|--:|--:|:--|');
  records.forEach((r, i) => {
    out.push(`| ${i + 1} | ${cut(r.label, 80).replace(/\|/g, '\\|')} | ${r.members} | ${r.files} | ${r.tokens.length} | ${cut(r.purpose, 160).replace(/\|/g, '\\|')} |`);
  });
  return out.join('\n') + '\n';
}

const safeName = (s) => String(s).replace(/^\.+/, '').replace(/[^A-Za-z0-9_.-]+/g, '_') || 'index';

export function scoreRun(dir, { scorer = 'bm25', b = 0.75, top = 5, bodyOf = null, recordsOut = null } = {}) {
  const candPath = path.join(dir, 'cand.lst');
  const sidecarPath = path.join(dir, 'claims.txt.anchors.json');
  if (!fs.existsSync(candPath)) return { dir, error: `no cand.lst in ${dir}` };
  if (!fs.existsSync(sidecarPath)) return { dir, error: `no claims.txt.anchors.json in ${dir}` };
  let sidecar;
  try { sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')); } catch (e) { return { dir, error: `sidecar unreadable: ${e.message}` }; }
  const candText = fs.readFileSync(candPath, 'utf8');
  const indexName = (candText.match(/index=(\S+)/) || [])[1] || path.basename(dir);
  const groups = parseCandidateGroups(candText);
  const records = groups.map((g) => groupRecord(g, { bodyOf }));
  const claims = readSidecarClaims(sidecar);
  const variant = bodyOf ? 'tier0+body' : 'tier0';
  const run = scoreClaims({ dir, index: indexName, records, claims, scorer, b, top, variant });
  if (recordsOut) {
    fs.mkdirSync(recordsOut, { recursive: true });
    run.recordsFile = path.join(recordsOut, `${safeName(indexName)}_records.md`);
    fs.writeFileSync(run.recordsFile, renderRecords(indexName, records, { variant }), 'utf8');
  }
  return run;
}

/** Pure half of scoreRun: records and claims in, the run record out. */
export function scoreClaims({ dir = '', index = '', records, claims, scorer = 'bm25', b = 0.75, top = 5, variant = 'tier0' }) {
  const model = scorer === 'overlap' ? buildOverlap(records) : buildBm25(records, { b });
  const rows = [];
  claims.forEach((c, ci) => {
    const drafted = findDrafted(c, records);
    const row = { n: c.n, label: c.label, groupN: c.groupN, drafted, members: null, claimStems: 0, rank: null, ties: 0, score: 0, elementRanks: [], elementBest: null, control: null, top: [] };
    if (drafted < 0) { row.error = 'drafted group not found in cand.lst'; rows.push(row); return; }
    row.members = records[drafted].members;
    const q = textStems(c.claim);
    row.claimStems = new Set(q).size;
    const scores = model.score(q);
    Object.assign(row, rankOf(scores, drafted));
    row.top = topOf(scores, records, top);
    row.elementRanks = c.elements.map((e) => rankOf(model.score(textStems(e)), drafted).rank);
    const er = row.elementRanks.filter((r) => r != null);
    row.elementBest = er.length ? Math.min(...er) : null;
    if (claims.length > 1) {
      const other = claims[(ci + 1) % claims.length];
      row.control = { from: other.n, rank: rankOf(model.score(textStems(other.claim)), drafted).rank };
    }
    rows.push(row);
  });
  return { dir, index, groups: records.length, variant, scorer, b: scorer === 'bm25' ? b : null, claims: rows };
}

// -------------------------------------------------------------------- pooling

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** hits@k, MRR and median over a list of ranks (null = not reached). */
export function summarize(ranks) {
  const n = ranks.length;
  const reached = ranks.filter((r) => r != null);
  const out = { claims: n, reached: reached.length, mrr: n ? ranks.reduce((a, r) => a + (r ? 1 / r : 0), 0) / n : 0, median: median(reached) };
  for (const k of HITS_AT) out[`hits@${k}`] = ranks.filter((r) => r != null && r <= k).length;
  return out;
}

export function poolRuns(runs) {
  const ok = runs.filter((r) => !r.error);
  const rows = ok.flatMap((r) => r.claims.filter((c) => !c.error));
  return {
    runs: ok.length, errors: runs.length - ok.length,
    whole: summarize(rows.map((c) => c.rank)),
    element: summarize(rows.map((c) => c.elementBest)),
    control: summarize(rows.filter((c) => c.control).map((c) => c.control.rank)),
  };
}

// ------------------------------------------------------------------- report

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const fmtRank = (r) => (r == null ? '—' : String(r));
const cut = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export function renderMarkdown(report) {
  const out = [];
  out.push(`# HOF stage 1: where the drafted group ranks by tier-0 text`, '');
  out.push(`Generated ${report.generated} by scripts/hof-stage1.mjs; scorer ${report.scorer}${report.scorer === 'bm25' ? ` (b ${report.b})` : ''}; variant ${report.variant}.`, '');
  out.push('The claim was drafted from the group\'s own names, so a high rank is necessary for a mechanisms index and not sufficient. The control column is the rank of the same group under another claim\'s text from the same run. Members is the drafted group\'s size.', '');
  out.push('| run | n | drafted group | members | groups | rank | ties | best element | control |');
  out.push('|:--|--:|:--|--:|--:|--:|--:|--:|--:|');
  for (const r of report.runs) {
    if (r.error) { out.push(`| ${path.basename(r.dir)} | | *(${r.error})* | | | | | | |`); continue; }
    for (const c of r.claims) {
      if (c.error) { out.push(`| ${r.index} | ${c.n} | ${cut(c.label, 48)} *(${c.error})* | | ${r.groups} | | | | |`); continue; }
      out.push(`| ${r.index} | ${c.n} | ${cut(c.label, 48).replace(/\|/g, '\\|')} | ${c.members} | ${r.groups} | ${fmtRank(c.rank)} | ${c.ties || ''} | ${fmtRank(c.elementBest)} | ${c.control ? fmtRank(c.control.rank) : ''} |`);
    }
  }
  out.push('');
  const p = report.pooled;
  const line = (name, s) => `| ${name} | ${s.claims} | ${s['hits@1']} (${pct(s['hits@1'], s.claims)}) | ${s['hits@5']} (${pct(s['hits@5'], s.claims)}) | ${s['hits@20']} (${pct(s['hits@20'], s.claims)}) | ${s.mrr.toFixed(2)} | ${s.median == null ? '—' : s.median} | ${s.claims - s.reached} |`;
  out.push('| pooled | claims | top 1 | top 5 | top 20 | MRR | median rank | not reached |');
  out.push('|:--|--:|--:|--:|--:|--:|--:|--:|');
  out.push(line('whole claim', p.whole));
  out.push(line('best element', p.element));
  out.push(line('control (another claim)', p.control));
  out.push('');
  out.push('## Detail', '');
  for (const r of report.runs) {
    if (r.error) continue;
    out.push(`### ${r.index} (${r.groups} groups)`, '');
    for (const c of r.claims) {
      out.push(`**${c.n}. ${c.label}**${c.error ? ` *(${c.error})*` : ` — rank ${fmtRank(c.rank)}${c.ties ? ` (${c.ties} tied)` : ''}, score ${c.score.toFixed(2)}, ${c.claimStems} claim stems; elements ${c.elementRanks.map(fmtRank).join(', ') || '—'}; control ${c.control ? fmtRank(c.control.rank) : '—'}`}`, '');
      for (const t of c.top) out.push(`- ${t.i === c.drafted ? '**' : ''}${cut(t.label, 90)}${t.i === c.drafted ? '** ← drafted' : ''} (${t.score.toFixed(2)})`);
      out.push('');
    }
  }
  return out.join('\n');
}

// ----------------------------------------------------------------------- main

export async function main(argv) {
  let o;
  try { o = parseOwnArgs(argv); } catch (e) { console.error(`hof-stage1: ${e.message}\n\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  const dirs = o.hofRoot ? listRunDirs(o.hofRoot) : o.hof.map((d) => path.resolve(d));
  if (!dirs.length) { console.error(`hof-stage1: no run directories${o.hofRoot ? ` under ${o.hofRoot}` : ''}`); return 1; }
  let bodyOf = null;
  if (o.indexPath) {
    const { CodeSearchIndex } = await import('../src/core/CodeSearchIndex.js');
    const idx = new CodeSearchIndex({ indexPath: o.indexPath });
    bodyOf = (file, name) => idx.getFunctionSource(file, name);
  }
  const runs = dirs.map((d) => {
    const r = scoreRun(d, { scorer: o.scorer, b: o.b, top: o.top, bodyOf, recordsOut: o.recordsOut });
    process.stderr.write(r.error ? `  ${path.basename(d)}: ${r.error}\n` : `  ${r.index}: ${r.groups} groups, ${r.claims.length} claim(s)${r.recordsFile ? `; records in ${r.recordsFile}` : ''}\n`);
    return r;
  });
  const report = { format: 'ce-hof-stage1', generated: new Date().toISOString(), scorer: o.scorer, b: o.scorer === 'bm25' ? o.b : null, variant: bodyOf ? 'tier0+body' : 'tier0', runs, pooled: poolRuns(runs) };
  const md = renderMarkdown(report);
  console.log(md);
  if (o.out) {
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(o.out, md, 'utf8');
    const jsonPath = o.out.replace(/\.md$/i, '') + '.json';
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    process.stderr.write(`\nWrote ${o.out} and ${jsonPath}\n`);
  }
  return runs.some((r) => r.error) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
