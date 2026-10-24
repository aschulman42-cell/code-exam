#!/usr/bin/env node
// recap-chart-drafter-ceiling.mjs — the drafter's ceiling on real claims.
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Question (Andrew, 2026-10-21): given the very functions one party says practice the claim,
// does CodeExam's pseudo-claim drafter write a claim that reads like the asserted one? If it
// misses the order-q test even from MARA's cited functions, the drafter is the limit and the
// locator cannot be blamed for not finding it.
//
// Reads the agreement harness's work directory (scripts/recap-chart-agreement.mjs): per
// candidate the asserted claim, its elements (Google Patents' divisions), the litigant's cited
// functions resolved against the index, and the indexes. Per candidate and repository:
//
//   anchors   the litigant's reachable cited functions as an anchors list (chart order, capped);
//             nothing from the patent goes near the drafter
//   draft     --pseudo-claims @anchors.lst --claim-schema --claim-class both --claims-only, for the
//             litigant-seeded group and for a FLOOR group of the same size from the grouper's own
//             candidates that shares no function with the litigant's set
//   compare   one model call per pair, element by element: MET / PARTIAL / ABSENT per asserted
//             element with the pseudo-claim's element quoted, plus the pseudo-claim elements with no
//             counterpart; three pairs per candidate: litigant-seeded vs the asserted claim (the
//             MEASURE), floor-seeded vs the asserted claim (the FLOOR), litigant-seeded vs another
//             candidate's claim of the same art (the CONTROL)
//   score     mechanism elements met or partial over mechanism elements (headline), all elements,
//             the reverse count; the measure is a finding only where it exceeds both controls
//
// Usage:
//   node scripts/recap-chart-drafter-ceiling.mjs --work <dir> [--only id,id] [--llm claude | --model <gguf>]
//        [--steps anchors,draft,compare,score] [--render docs/claim-chart-drafter-ceiling.md] [--runs N]
//
// --only limits the CANDIDATES RUN; records of other candidates are kept (unlike the harness's --only).
// Every CodeExam call is logged beside its output under <work>/ceiling/<id>/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lastSegment, nameKey, replaceSection as replaceBetween } from './recap-chart-agreement.mjs';
import { parseElementsFile, isPreambleRow } from '../src/commands/claim-locate.js';
import { elementClasses } from '../src/core/claim-genericity.js';
import { resolveModel, makeDrafter, claimsCostGate, actualCostLine, describeEngine } from '../src/core/llm-runner.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CEILING_START = '<!-- ceiling:start -->';
export const CEILING_END = '<!-- ceiling:end -->';
export const DEFAULTS = { maxAnchors: 24, maxPerName: 3, maxCompareTokens: 1400 };

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2));
const log = (s) => process.stderr.write(`# ${s}\n`);

// ---------------------------------------------------------------------------------------------
// anchors — the litigant's reachable cited functions as file@symbol, in chart order
// ---------------------------------------------------------------------------------------------
// `present` is the reach file's list of {name, symbol} (name as cited, symbol as the index knows
// it); `functionIndex` is the index's file -> {symbol: {start, end}}; `citedFiles` the chart's
// cited files present in the index (their paths). Resolution: exact symbol match first, then the
// last segment; where several files define the symbol, the cited files first, then at most
// `maxPerName`; the whole group capped at `maxAnchors` in chart order, with the cap reported.
// A bare generic name in a chart (`bytes.data`, `hasher.Write`, `toString`) is a method call on a
// local, not a function the litigant cited; resolved by last segment it lands on an unrelated
// definition (`interfaces::FoundBlock::data`, `CBanDB::Write`) and would seed the drafter with
// noise. Seen across the fourteen (MARA, VM Innovations, PROGME), so the guard is population-wide:
// a cited name whose last segment is one of these and that carries no qualifier the index matches
// is skipped and reported.
export const GENERIC_NAMES = new Set(['data', 'size', 'write', 'read', 'finalize', 'get', 'set', 'print', 'println',
  'wait', 'equals', 'hashcode', 'tostring', 'length', 'count', 'close', 'open', 'init', 'run', 'main', 'update', 'add']);

export function resolveAnchors(present, functionIndex, citedFiles = [], opts = {}) {
  const maxPerName = opts.maxPerName ?? DEFAULTS.maxPerName;
  const maxAnchors = opts.maxAnchors ?? DEFAULTS.maxAnchors;
  const byExact = new Map();   // symbol name -> [file]
  const byLast = new Map();    // last segment (lower) -> [{file, symbol}]
  for (const [file, syms] of Object.entries(functionIndex || {})) {
    for (const sym of Object.keys(syms || {})) {
      (byExact.get(sym) || byExact.set(sym, []).get(sym)).push(file);
      const k = nameKey(sym);
      (byLast.get(k) || byLast.set(k, []).get(k)).push({ file, symbol: sym });
    }
  }
  const cited = new Set((citedFiles || []).map((f) => String(f)));
  const preferCited = (a, b) => (cited.has(b.file) ? 1 : 0) - (cited.has(a.file) ? 1 : 0);
  const anchors = [];
  const seen = new Set();
  const unresolved = [];
  const skippedGeneric = [];
  for (const p of present || []) {
    const sym = p.symbol || p.name;
    const cited = String(p.name || sym);
    let hits = (byExact.get(sym) || []).map((file) => ({ file, symbol: sym }));
    // A generic last segment counts only when the cited name's qualifier matched exactly
    // (`CKey::Check` is fine; a bare `data` or a local's `bytes.data` is not).
    if (GENERIC_NAMES.has(nameKey(sym)) && !(hits.length && /::/.test(sym) && cited.includes(sym.split('::')[0]))) { skippedGeneric.push(cited); continue; }
    if (!hits.length) hits = byLast.get(nameKey(sym)) || [];
    if (!hits.length) { unresolved.push(sym); continue; }
    hits = [...hits].sort(preferCited).slice(0, maxPerName);
    for (const h of hits) {
      const spec = `${h.file}@${h.symbol}`;
      if (seen.has(spec)) continue;
      seen.add(spec);
      anchors.push(spec);
    }
  }
  const capped = anchors.length > maxAnchors;
  return { anchors: anchors.slice(0, maxAnchors), total: anchors.length, capped, unresolved, skippedGeneric };
}

export function formatAnchorsList(groups) {
  const out = [];
  for (const g of groups) {
    out.push(`# ${g.label}`);
    for (const a of g.anchors) out.push(a);
    out.push('');
  }
  return out.join('\n');
}

// The grouper's own candidates (`--pseudo-claims --candidates <file>` writes an anchors list):
// the first group that shares no function with the litigant's set, trimmed to the same size.
export function pickFloorGroup(candidatesText, litigantAnchors, size) {
  const taken = new Set(litigantAnchors.map((a) => nameKey(a.split('@').pop())));
  const groups = [];
  let cur = null;
  for (const raw of String(candidatesText || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { cur = { label: line.replace(/^#\s*/, ''), anchors: [] }; groups.push(cur); continue; }
    if (!cur) { cur = { label: 'candidates', anchors: [] }; groups.push(cur); }
    cur.anchors.push(line);
  }
  for (const g of groups) {
    if (g.anchors.length < Math.min(3, size)) continue;
    if (g.anchors.some((a) => taken.has(nameKey(a.split('@').pop())))) continue;
    // The grouper's header carries the file's leading comment after an em dash; keep the name.
    const label = g.label.split(/\s+—\s+/)[0].replace(/\s+/g, ' ').trim().slice(0, 80);
    return { label: `floor: ${label}`, anchors: g.anchors.slice(0, size) };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// control pairing — same art, never self, every candidate paired
// ---------------------------------------------------------------------------------------------
// `art` of a candidate is its first repository (`org/repo`); candidates sharing an art rotate
// among themselves; the rest rotate in picks order. A list of one has no control.
export function controlPairs(candidates) {
  const byArt = new Map();
  for (const c of candidates) {
    const art = c.repos && c.repos.length ? `${c.repos[0].org}/${c.repos[0].repo}` : '(none)';
    (byArt.get(art) || byArt.set(art, []).get(art)).push(c);
  }
  const pairs = new Map();
  const singles = [];
  for (const [, group] of byArt) {
    if (group.length === 1) { singles.push(group[0]); continue; }
    group.forEach((c, i) => pairs.set(c.id, group[(i + 1) % group.length].id));
  }
  if (singles.length > 1) singles.forEach((c, i) => pairs.set(c.id, singles[(i + 1) % singles.length].id));
  else for (const c of singles) pairs.set(c.id, null);
  return pairs;
}

// ---------------------------------------------------------------------------------------------
// compare — the judge's prompt and its strict parser
// ---------------------------------------------------------------------------------------------
export function buildComparePrompt(assertedElements, pseudoClaim) {
  const numbered = assertedElements.map((e, i) => `${i + 1}. ${e}`).join('\n');
  const sys = `You compare two patent-style claims element by element. Claim A is the ASSERTED claim, \
split into numbered elements. Claim B is a DRAFTED claim (claim 1 and its dependents) written from \
source code. For EACH element of A, say whether B expresses the same limitation:

MET      B states the limitation (same function, not the same words)
PARTIAL  B states part of it, or a narrower or broader version
ABSENT   B says nothing that expresses it

Quote the B text you rely on (a short phrase) for MET and PARTIAL; write "none" for ABSENT.
Then list each B element that has NO counterpart in A (what the code does that A does not claim).
Judge substance, not vocabulary. Do not infer from the subject matter what B "must" mean.

OUTPUT, one line per A element, then the reverse list, nothing else:
A1: MET | "<quoted B phrase>"
A2: ABSENT | none
...
B-ONLY: <B element text>; <B element text>   (or: B-ONLY: none)`;
  const user = `CLAIM A (asserted), numbered elements:\n${numbered}\n\nCLAIM B (drafted):\n${pseudoClaim}`;
  return { sys, user };
}

export function parseCompareResponse(text, elementCount) {
  const verdicts = [];
  let bOnly = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^A(\d+)\s*:\s*(MET|PARTIAL|ABSENT)\b\s*\|?\s*(.*)$/i.exec(line);
    if (m) {
      const n = Number(m[1]);
      const quote = m[3].replace(/^"|"$/g, '').trim();
      if (n >= 1 && n <= elementCount && !verdicts.some((v) => v.element === n)) {
        verdicts.push({ element: n, label: m[2].toUpperCase(), quote: /^none$/i.test(quote) ? '' : quote });
      }
      continue;
    }
    m = /^B-ONLY\s*:\s*(.*)$/i.exec(line);
    if (m) bOnly = /^none$/i.test(m[1].trim()) ? [] : m[1].split(';').map((s) => s.trim()).filter(Boolean);
  }
  const complete = verdicts.length === elementCount && bOnly !== null;
  return { verdicts, bOnly: bOnly || [], complete };
}

// ---------------------------------------------------------------------------------------------
// score — by element class; the measure against its two controls
// ---------------------------------------------------------------------------------------------
export function scoreComparison(verdicts, classes) {
  const rows = classes.map((cls, i) => ({ cls, label: (verdicts.find((v) => v.element === i + 1) || {}).label || 'UNPARSED' }));
  const count = (pred) => rows.filter(pred).length;
  const met = (r) => r.label === 'MET' || r.label === 'PARTIAL';
  const strict = (r) => r.label === 'MET';
  const mech = rows.filter((r) => r.cls === 'mechanism');
  // Two reads: MET or PARTIAL (the headline the draft pre-registered) and MET alone (strict).
  // The first Foundry run showed why both are needed: the judge gave four PARTIALs to the
  // other signing claim of the same art on shared words ("modular reduction"), so the
  // PARTIAL-inclusive control matched the measure while the strict one did not.
  return {
    mechanism: { met: mech.filter(met).length, of: mech.length },
    mechanismStrict: { met: mech.filter(strict).length, of: mech.length },
    all: { met: count(met), of: rows.length },
    metOnly: count(strict),
    unparsed: count((r) => r.label === 'UNPARSED'),
  };
}

// A measure is a FINDING only where it beats both the floor and the control for that candidate;
// otherwise "indistinguishable", which is itself the finding.
export function readMeasure(measure, floor, control, key = 'mechanism') {
  const frac = (s) => (s && s.of ? s.met / s.of : null);
  const m = frac(measure && measure[key]);
  if (m == null) return 'unscored';
  const f = frac(floor && floor[key]);
  const c = frac(control && control[key]);
  if (f != null && m <= f) return 'indistinguishable from the floor';
  if (c != null && m <= c) return 'indistinguishable from the control';
  if (f == null && c == null) return 'uncontrolled';
  return 'finding';
}

export function renderCeiling(records, { generatedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [CEILING_START, '', `_Generated ${generatedAt} by \`scripts/recap-chart-drafter-ceiling.mjs --render\``,
    `from ${records.length} record(s); edit the script, not this block._`, ''];
  out.push('| candidate | repository | engine | measure (mechanism, MET+PARTIAL; MET) | floor | control | read | strict read | B-only |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  const cell = (s) => (s && s.mechanism && s.mechanism.of != null
    ? `${s.mechanism.met} / ${s.mechanism.of}; ${s.mechanismStrict ? s.mechanismStrict.met : '?'}` : '—');
  for (const r of records) {
    out.push(`| ${r.id} | ${r.repo} | ${r.engine || ''} | ${cell(r.measure)} | ${cell(r.floor)} | ${cell(r.control)} | ${r.read || ''} | ${r.readStrict || ''} | ${r.bOnly != null ? r.bOnly : '—'} |`);
  }
  out.push('');
  out.push(CEILING_END);
  return out.join('\n');
}

export function replaceCeilingSection(docText, rendered) {
  const s = docText.indexOf(CEILING_START);
  const e = docText.indexOf(CEILING_END);
  if (s < 0 || e < 0) throw new Error('ceiling markers not found in the page');
  return docText.slice(0, s) + rendered + docText.slice(e + CEILING_END.length);
}

// ---------------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = { steps: ['anchors', 'draft', 'compare', 'score'], only: null, render: null, runs: 1, llm: null, model: null, work: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--work') o.work = v();
    else if (a === '--only') o.only = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--steps') o.steps = v().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--render') o.render = v();
    else if (a === '--runs') o.runs = Number(v()) || 1;
    else if (a === '--llm') o.llm = v();
    else if (a === '--model') o.model = v();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.work) throw new Error('--work <agreement work dir> is required');
  return o;
}

function ce(args, cwd, logFile) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.writeFileSync(logFile, `node src/index.js ${args.join(' ')}\n\n${r.stdout || ''}\n${r.stderr || ''}`);
  return { ok: r.status === 0, status: r.status };
}

function indexDirOf(work, r) {
  const sha = String(r.resolvedRef || r.ref || '').slice(0, 7);
  return path.join(work, 'indexes', `${r.org}__${r.repo}__${sha}`);
}

function engineArgs(o) { return o.model ? ['--model', o.model] : ['--llm', o.llm || 'claude']; }

// The drafter's --claims-only sidecar: claims with their class, text and dependents. The shape
// is read defensively; what the sidecar carries is recorded in the record for the reader.
function readPseudo(sidecarPath) {
  if (!fs.existsSync(sidecarPath)) return [];
  const j = readJson(sidecarPath);
  const claims = Array.isArray(j) ? j : (j.claims || []);
  return claims.map((c) => ({
    cls: String(c.class || c.statutoryClass || c.claimClass || '').toLowerCase(),
    text: c.claim || c.text || '',
    dependents: (c.dependents || []).map((d) => (typeof d === 'string' ? d : d.claim || d.text || '')),
  }));
}

function claimClassOf(elements) {
  const pre = (elements[0] || '').toLowerCase();
  return /\b(system|apparatus|device|medium|computer)\b/.test(pre) && !/\bmethod\b/.test(pre) ? 'system' : 'method';
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const work = path.resolve(o.work);
  const man = readJson(path.join(work, 'manifest.json'));
  let cands = man.candidates.filter((c) => c.key && c.claimFiles);
  const recFile = path.join(work, 'ceiling.jsonl');
  const records = fs.existsSync(recFile) ? fs.readFileSync(recFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const upsert = (rec) => { const i = records.findIndex((r) => r.id === rec.id && r.repo === rec.repo); if (i >= 0) records[i] = rec; else records.push(rec); };
  const save = () => fs.writeFileSync(recFile, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  const pairs = controlPairs(cands);
  if (o.only) cands = cands.filter((c) => o.only.includes(c.id));
  const model = (o.steps.includes('compare')) ? resolveModel({ llm: o.llm || (o.model ? null : 'claude'), model: o.model }) : null;

  for (const c of cands) {
    const n = c.claims[0];
    const cf = c.claimFiles[n];
    const claimText = fs.readFileSync(cf.text, 'utf8');
    // parseElementsFile returns { elements, comments }; the comments are the file's header.
    const { elements } = parseElementsFile(fs.readFileSync(cf.elements, 'utf8'));
    const classes = elementClasses(elements, { isPreambleRow });
    for (const r of c.repos) {
      const idx = indexDirOf(work, r);
      const fiPath = path.join(idx, 'function_index.json');
      if (!fs.existsSync(fiPath)) { log(`${c.id}: no index at ${idx}`); continue; }
      const repo = `${r.org}/${r.repo}`;
      const dir = path.join(work, 'ceiling', c.id, `${r.org}__${r.repo}`);
      fs.mkdirSync(dir, { recursive: true });
      const rec = records.find((x) => x.id === c.id && x.repo === repo) || { id: c.id, repo, patent: c.patent, claim: n, elements: elements.length, classes };
      rec.engine = model ? describeEngine(model) : rec.engine;

      if (o.steps.includes('anchors')) {
        const reachPath = path.join(work, 'out', c.id, `reach_${path.basename(idx)}.json`);
        if (!fs.existsSync(reachPath)) { log(`${c.id}: no reach file for ${repo}`); continue; }
        const reach = readJson(reachPath);
        const fi = readJson(fiPath);
        const citedFiles = ((reach.files && reach.files.present) || []).map((f) => f.file);
        const res = resolveAnchors((reach.functions && reach.functions.present) || [], fi, citedFiles);
        rec.anchors = { count: res.anchors.length, total: res.total, capped: res.capped, unresolved: res.unresolved, skippedGeneric: res.skippedGeneric };
        fs.writeFileSync(path.join(dir, 'anchors.lst'), formatAnchorsList([{ label: `${c.case} — ${repo}`, anchors: res.anchors }]));
        log(`${c.id} ${repo}: ${res.anchors.length} anchor(s)${res.capped ? ` (capped from ${res.total})` : ''}${res.unresolved.length ? `, ${res.unresolved.length} unresolved` : ''}${res.skippedGeneric.length ? `, ${res.skippedGeneric.length} generic name(s) skipped (${res.skippedGeneric.join(', ')})` : ''}`);
      }

      if (o.steps.includes('draft')) {
        const anchorsFile = path.join(dir, 'anchors.lst');
        if (!fs.existsSync(anchorsFile)) { log(`${c.id}: anchors first`); continue; }
        const pseudo = path.join(dir, 'pseudo.txt');
        if (!fs.existsSync(`${pseudo}.anchors.json`)) {
          const st = ce(['--index-path', idx, '--pseudo-claims', `@${anchorsFile}`, '--claim-schema', '--claim-class', 'both', '--claims-only', pseudo, ...engineArgs(o)], ROOT, path.join(dir, 'draft.log'));
          rec.draft = { ok: st.ok };
        }
        const candFile = path.join(dir, 'candidates.lst');
        if (!fs.existsSync(candFile)) ce(['--index-path', idx, '--pseudo-claims', '--candidates', candFile], ROOT, path.join(dir, 'candidates.log'));
        const litAnchors = fs.readFileSync(anchorsFile, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
        const floor = fs.existsSync(candFile) ? pickFloorGroup(fs.readFileSync(candFile, 'utf8'), litAnchors, litAnchors.length) : null;
        if (floor) {
          const floorFile = path.join(dir, 'floor-anchors.lst');
          fs.writeFileSync(floorFile, formatAnchorsList([floor]));
          const fpseudo = path.join(dir, 'floor-pseudo.txt');
          if (!fs.existsSync(`${fpseudo}.anchors.json`)) {
            const st = ce(['--index-path', idx, '--pseudo-claims', `@${floorFile}`, '--claim-schema', '--claim-class', 'both', '--claims-only', fpseudo, ...engineArgs(o)], ROOT, path.join(dir, 'floor-draft.log'));
            rec.floorDraft = { ok: st.ok, group: floor.label, size: floor.anchors.length };
          }
        } else rec.floorDraft = { ok: false, reason: 'no disjoint candidate group' };
      }

      if (o.steps.includes('compare') && model) {
        const cls = claimClassOf(elements);
        const pick = (sidecar) => { const cs = readPseudo(sidecar); return cs.find((x) => x.cls.startsWith(cls)) || cs[0] || null; };
        const pseudo = pick(path.join(dir, 'pseudo.txt.anchors.json'));
        const floorP = pick(path.join(dir, 'floor-pseudo.txt.anchors.json'));
        const ctrlId = pairs.get(c.id);
        const ctrl = ctrlId ? man.candidates.find((x) => x.id === ctrlId) : null;
        const ctrlElements = ctrl && ctrl.claimFiles ? parseElementsFile(fs.readFileSync(ctrl.claimFiles[ctrl.claims[0]].elements, 'utf8')).elements : null;
        const draft = makeDrafter(model, 0);
        // A transient network failure (`fetch failed`) killed the first run mid-way; retry the
        // call twice with a pause, and persist each pair's parsed answer so a re-run resumes.
        const callDraft = async (sys, user) => {
          let err;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { return await draft(sys, user, DEFAULTS.maxCompareTokens); }
            catch (e) { err = e; log(`compare call failed (${e.message}); retry ${attempt + 1}`); await new Promise((res) => setTimeout(res, 5000 * (attempt + 1))); }
          }
          throw err;
        };
        const judge = async (aElements, pc, label) => {
          if (!pc) return null;
          const done = path.join(dir, `compare-${label}.json`);
          if (fs.existsSync(done)) return readJson(done);
          const bText = [pc.text, ...pc.dependents].join('\n');
          const { sys, user } = buildComparePrompt(aElements, bText);
          if (!claimsCostGate(model, [{ inChars: sys.length + user.length, outTokens: DEFAULTS.maxCompareTokens }], `ceiling compare ${label}`, {})) return null;
          let raw = await callDraft(sys, user);
          let parsed = parseCompareResponse(raw, aElements.length);
          if (!parsed.complete) { raw = await callDraft(sys, `${user}\n\nYour previous answer did not follow the format. Answer again, one line per A element, then the B-ONLY line.`); parsed = parseCompareResponse(raw, aElements.length); }
          fs.writeFileSync(path.join(dir, `compare-${label}.txt`), `${sys}\n\n---\n${user}\n\n=== answer ===\n${raw}`);
          const result = { verdicts: parsed.verdicts, bOnly: parsed.bOnly, complete: parsed.complete };
          writeJson(done, result);
          return result;
        };
        const m = await judge(elements, pseudo, 'measure');
        const f = await judge(elements, floorP, 'floor');
        const k = ctrlElements ? await judge(ctrlElements, pseudo, 'control') : null;
        rec.compare = { measure: m, floor: f, control: k, controlId: ctrlId, pseudoClass: pseudo ? pseudo.cls : null };
        rec.cost = actualCostLine(model);
      }

      if (o.steps.includes('score') && rec.compare) {
        const ctrl = rec.compare.controlId ? man.candidates.find((x) => x.id === rec.compare.controlId) : null;
        const ctrlClasses = ctrl && ctrl.claimFiles ? elementClasses(parseElementsFile(fs.readFileSync(ctrl.claimFiles[ctrl.claims[0]].elements, 'utf8')).elements, { isPreambleRow }) : null;
        rec.measure = rec.compare.measure ? scoreComparison(rec.compare.measure.verdicts, classes) : null;
        rec.floor = rec.compare.floor ? scoreComparison(rec.compare.floor.verdicts, classes) : null;
        rec.control = rec.compare.control && ctrlClasses ? scoreComparison(rec.compare.control.verdicts, ctrlClasses) : null;
        rec.bOnly = rec.compare.measure ? rec.compare.measure.bOnly.length : null;
        rec.read = readMeasure(rec.measure, rec.floor, rec.control);
        rec.readStrict = readMeasure(rec.measure, rec.floor, rec.control, 'mechanismStrict');
      }
      upsert(rec);
      save();
    }
  }
  const rendered = renderCeiling(records);
  fs.writeFileSync(path.join(work, 'ceiling.md'), rendered + '\n');
  if (o.render) { fs.writeFileSync(o.render, replaceCeilingSection(fs.readFileSync(o.render, 'utf8'), rendered)); log(`rendered into ${o.render}`); }
  log(`${records.length} record(s); ${records.filter((r) => r.read === 'finding').length} finding(s)`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
