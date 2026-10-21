// recap-chart-agreement.mjs — does CodeExam find the code a litigant charted? Agreement with a party, measured
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// A public claim chart that cites open-source code pairs a litigated claim with the functions and
// files one party says meet it (docs/real-world-claim-charts.md). This harness turns such a pair
// into a test: clone the repository at the filing's commit, build a CodeExam index of it, fetch the
// patent's claims, and ask CodeExam for the code of the claim, then score how much of the
// litigant's cited set CodeExam found and how much of what CodeExam chose the litigant also chose.
// A chart is advocacy, so the score is agreement with a party, never correctness; CodeExam's picks
// outside the litigant's set are different, not wrong, until a person reads them.
//
//   node scripts/recap-chart-agreement.mjs --picks test/fixtures/recap-chart-agreement-candidates.json \
//       --catalog <run>/catalog.jsonl --work <dir outside the repo> [--steps prepare,clone,index,claims,reach,tier0,tier1,tier2,score]
//       [--only id,id] [--llm claude] [--blind both|on|off] [--runs N] [--render docs/claim-chart-agreement.md]
//
// Steps, each resumable (what exists in --work is not redone):
//   prepare  the manifest: the picks plus the litigant's cited set read from the catalog
//   clone    git clone each repository; a worktree per ref (the filing's pinned commit, else the default branch at the filing date)
//   index    node src/index.js --build-index <tree> --index-path <work>/indexes/<org>__<repo>__<sha7>
//   claims   the patents' claims from Google Patents through litigated-claims-fetch.mjs; one text and one elements file per asserted claim
//   reach    are the litigant's names and files in the index at all? (absent names are reported, never scored against CodeExam)
//   tier0    no model: the claim's content words against the index's symbol names, rarity-weighted
//   tier1    --claim-locate --targets-out, run twice (--blind and not) so recall of a memorized codebase is told from discovery
//   tier2    --claim-chart --elements @<claim>.elements.txt --verdicts-out, per-element retrieval, no --targets
//   score    agreement.jsonl and agreement.md in --work; --render puts the tables into the docs page
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEPS = ['prepare', 'clone', 'index', 'claims', 'reach', 'tier0', 'tier1', 'tier2', 'score'];

// ---- names and matching ------------------------------------------------------------------------

/** The identifier a chart's name points at: the last segment of a dotted or scoped path, the whole of an underscore name. */
export function lastSegment(name) {
  const s = String(name || '').trim().replace(/\(.*$/, '');
  const parts = s.split(/::|->|\./).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}
export const nameKey = (name) => lastSegment(name).toLowerCase();

/**
 * Which of the litigant's names exist among the index's symbols: the whole name or its last
 * segment against the whole symbol or its last segment (CodeExam names a method `Class::method`,
 * so `RowIterator.fromScala` meets `RowIterator::fromScala` at `fromScala`), exact first, then
 * case-insensitive.
 */
export function matchFunctions(keyNames, symbols) {
  const exact = new Map(), lower = new Map();
  const put = (m, k, s) => { if (k && !m.has(k)) m.set(k, s); };
  for (const s of symbols) { put(exact, s, s); put(exact, lastSegment(s), s); put(lower, s.toLowerCase(), s); put(lower, lastSegment(s).toLowerCase(), s); }
  const present = [], absent = [];
  for (const n of keyNames) {
    const seg = lastSegment(n);
    const hit = exact.get(n) || exact.get(seg) || lower.get(n.toLowerCase()) || lower.get(seg.toLowerCase());
    if (hit) present.push({ name: n, symbol: hit }); else absent.push(n);
  }
  return { present, absent };
}
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.?\//, '');
/** Which of the litigant's file names (a basename, or a path) match an indexed file by path suffix. */
export function matchFiles(keyFiles, files) {
  const list = files.map(norm);
  const present = [], absent = [];
  for (const f of keyFiles) {
    const want = norm(f);
    const hit = list.find((p) => p === want || p.endsWith(`/${want}`) || (want.includes('/') && p.endsWith(want)));
    if (hit) present.push({ name: f, file: hit }); else absent.push(f);
  }
  return { present, absent };
}

/** Agreement in both directions between what CodeExam chose and what the litigant cited (sets of lower-cased keys). */
export function agreement(ceSet, keySet) {
  const ce = new Set([...ceSet].map((s) => s.toLowerCase())), key = new Set([...keySet].map((s) => s.toLowerCase()));
  const matched = [...key].filter((k) => ce.has(k));
  const r = (n, d) => (d ? Number((n / d).toFixed(2)) : null);
  return { ce: ce.size, key: key.size, hit: matched.length, agreement: r(matched.length, key.size), precision: r(matched.length, ce.size), matched };
}

// ---- CodeExam's outputs ------------------------------------------------------------------------

/** The targets of a --targets-out file: "file@symbol" per line, the '#' provenance block and any trailing annotation ignored. */
export function parseTargets(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)@(\S+)/.exec(line);
    if (m) out.push({ file: norm(m[1]), symbol: m[2].replace(/[,;]$/, ''), raw: line });
  }
  return out;
}
/** Every "file@symbol" citation a --verdicts-out JSON carries, wherever its format puts them, plus any {file, symbol|function} objects. */
export function parseVerdicts(json) {
  const found = new Map();
  const add = (file, symbol, element) => { const k = `${norm(file)}@${symbol}`; if (!found.has(k)) found.set(k, { file: norm(file), symbol, elements: new Set() }); if (element != null) found.get(k).elements.add(String(element)); };
  // The element numbers below a target group (its per-element verdicts) belong to that group's symbol.
  const elementsBelow = (v, out = []) => {
    if (Array.isArray(v)) v.forEach((x) => elementsBelow(x, out));
    else if (v && typeof v === 'object') { const el = v.element ?? v.elementIndex ?? v.row; if (el != null && !v.file) out.push(el); for (const k of Object.keys(v)) elementsBelow(v[k], out); }
    return out;
  };
  const walk = (v, element) => {
    if (v == null) return;
    if (typeof v === 'string') { for (const m of v.matchAll(/([\w./\\-]+\.[A-Za-z0-9]{1,8})@([A-Za-z_$][\w$:.]*)/g)) add(m[1], m[2], element); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, element)); return; }
    if (typeof v === 'object') {
      const el = v.element ?? v.elementIndex ?? v.row ?? element;
      if (v.file && (v.symbol || v.function || v.fn)) { const sym = v.symbol || v.function || v.fn; add(v.file, sym, el); for (const e of elementsBelow(v)) add(v.file, sym, e); }
      for (const k of Object.keys(v)) walk(v[k], el);
    }
  };
  walk(json, null);
  return [...found.values()].map((e) => ({ ...e, elements: [...e.elements] }));
}

// ---- tier 0: a rule, no model ----------------------------------------------------------------------
const STOP = new Set(['the', 'and', 'said', 'wherein', 'whereby', 'comprising', 'comprises', 'comprise', 'method', 'system', 'data', 'first', 'second', 'third', 'plurality',
  'least', 'configured', 'device', 'means', 'step', 'steps', 'each', 'having', 'being', 'one', 'more', 'from', 'with', 'into', 'that', 'which', 'this', 'there', 'thereof', 'based',
  'associated', 'corresponding', 'respective', 'value', 'values', 'information', 'such', 'than', 'other', 'using', 'used', 'use', 'including', 'includes', 'include', 'provide',
  'providing', 'provided', 'receiving', 'received', 'receive', 'determining', 'determine', 'determined', 'generating', 'generate', 'generated', 'further', 'processor', 'memory',
  'computer', 'medium', 'storage', 'program', 'instructions', 'operable', 'operation', 'operations', 'performed', 'perform', 'performing', 'wherein', 'apparatus', 'claim', 'claims',
  'where', 'when', 'then', 'between', 'through', 'over', 'under', 'within', 'without', 'about', 'after', 'before', 'during', 'while', 'also', 'thereby', 'therein', 'thereto',
  'non', 'transitory', 'readable', 'executed', 'cause', 'causing', 'caused', 'set', 'sets', 'number', 'type', 'types', 'via', 'per', 'any', 'all', 'some', 'new', 'given']);
// One suffix off, so a claim's word and a symbol's word meet at the same stem ("signature" and "signatures" at "signatur", "generating" and "generate" at "generat"); "sign" stays apart from "signature", which is what a name rule can see.
const stem = (w) => w.replace(/(ations?|ation|ings?|ers?|ed|es|ly|al|ic|e|s)$/, '');
/** The content words of a claim, stemmed, as a set. */
export function claimWords(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) { if (w.length >= 4 && !STOP.has(w)) { const s = stem(w); if (s.length >= 3) out.add(s); } }
  return out;
}
/** The words of a symbol name: camelCase, underscores, dots and scopes split, stemmed. */
export function symbolWords(name) {
  const out = new Set();
  for (const w of String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) { if (w.length >= 3) out.add(stem(w)); }
  return out;
}
/**
 * The symbols whose names share the most claim words, each word weighted by its rarity across the
 * index's symbols (log(1 + N / df)); the deterministic name-match half of retrieval, with no model's
 * words and no content search, so weaker than --claim-locate's own. Returns the top symbols as
 * {file, symbol, score, words}.
 */
export function tier0Rank(claimText, symbolsByFile, { top = 24 } = {}) {
  const words = claimWords(claimText);
  if (!words.size) return [];
  const entries = [];
  for (const [file, syms] of Object.entries(symbolsByFile)) for (const s of syms) entries.push({ file: norm(file), symbol: s, words: symbolWords(s) });
  const df = new Map();
  for (const e of entries) for (const w of e.words) if (words.has(w)) df.set(w, (df.get(w) || 0) + 1);
  const N = entries.length || 1;
  const scored = [];
  for (const e of entries) {
    const hit = [...e.words].filter((w) => words.has(w));
    if (!hit.length) continue;
    const score = hit.reduce((a, w) => a + Math.log(1 + N / (df.get(w) || 1)), 0);
    scored.push({ file: e.file, symbol: e.symbol, score: Number(score.toFixed(2)), words: hit });
  }
  return scored.sort((a, b) => (b.score - a.score) || (b.words.length - a.words.length) || a.symbol.localeCompare(b.symbol)).slice(0, top);
}

// ---- the manifest ---------------------------------------------------------------------------------

/** The picks file's shape: every candidate needs an id, a docId, a patent of 7 or 8 digits, at least one claim and one repository. */
export function validatePicks(picks) {
  const errors = [];
  if (!picks || !Array.isArray(picks.candidates) || !picks.candidates.length) return ['no candidates'];
  const ids = new Set();
  for (const c of picks.candidates) {
    const at = c.id || '(no id)';
    if (!c.id) errors.push('a candidate has no id'); else if (ids.has(c.id)) errors.push(`${at}: duplicate id`); else ids.add(c.id);
    if (!Number.isInteger(c.docId)) errors.push(`${at}: docId must be the catalog's document id`);
    if (!/^\d{7,8}$/.test(String(c.patent || ''))) errors.push(`${at}: patent must be 7 or 8 digits, no commas`);
    if (!Array.isArray(c.claims) || !c.claims.length || c.claims.some((n) => !Number.isInteger(n) || n < 1)) errors.push(`${at}: claims must be claim numbers`);
    if (!Array.isArray(c.repos) || !c.repos.length || c.repos.some((r) => !r.org || !r.repo)) errors.push(`${at}: repos need org and repo`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.dateFiled || ''))) errors.push(`${at}: dateFiled must be YYYY-MM-DD`);
  }
  return errors;
}

/** The manifest: each pick plus the litigant's cited set from its catalog row (every name the catalog lists, in the top list, the chart rows or the paragraphs; the file- and line-level links; the chart rows for per-row scoring). */
export function buildManifest(picks, catalogRows) {
  const byId = new Map(catalogRows.map((r) => [Number(r.docId), r]));
  const candidates = picks.candidates.map((c) => {
    const r = byId.get(Number(c.docId));
    if (!r) return { ...c, key: null, rows: [], missing: 'not in the catalog' };
    const code = r.code || {};
    const fns = new Set((code.functions || []).map((f) => f.name)), files = new Set((code.files || []).map((f) => f.name));
    for (const u of [...(code.rows || []), ...(code.paragraphs || [])]) { for (const f of u.functions || []) fns.add(f); for (const f of u.files || []) files.add(f); }
    const links = (r.citations || []).filter((x) => ['file', 'function', 'line'].includes(x.granularity))
      .map((x) => ({ repo: `${x.org}/${x.repo}`, path: x.path, ref: x.ref || null, fragment: x.fragment || null, function: x.function || null }));
    const rows = (code.rows || []).filter((w) => (w.functions || []).length || (w.files || []).length)
      .map((w) => ({ label: w.label, claim: w.claim, limitation: w.limitation || null, source: w.source || null, functions: w.functions || [], files: w.files || [] }));
    return { ...c, pdfUrl: r.pdfUrl || null, key: { functions: [...fns], files: [...files], links }, rows };
  });
  return { generatedAt: new Date().toISOString().slice(0, 10), picks: picks.generatedAt || null, candidates };
}

// ---- rendering -------------------------------------------------------------------------------------
export const AGREEMENT_START = '<!-- agreement:start -->';
export const AGREEMENT_END = '<!-- agreement:end -->';
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const pct = (x) => (x == null ? '—' : x.toFixed(2));

/** The tables the docs page carries: reachability per candidate, then agreement per tier and mode, both directions. */
export function renderAgreement(records, { generatedAt = new Date().toISOString().slice(0, 10) } = {}) {
  const out = [`_Generated ${generatedAt} by \`scripts/recap-chart-agreement.mjs --render\` from ${records.length} record(s); edit the script, not this block._`, ''];
  const reach = records.filter((r) => r.tier === 'reach');
  if (reach.length) {
    out.push('| candidate | repository @ ref | index symbols | functions reachable / cited | files reachable / cited | absent names |', '|---|---|---:|---|---|---|');
    for (const r of reach) out.push(`| ${esc(r.id)} | ${esc(r.repo === 'all' ? 'all repositories' : `${r.repo} @ ${(r.ref || '').slice(0, 7)}`)} | ${r.symbols ?? ''} | ${r.functionsPresent} / ${r.functionsCited} | ${r.filesPresent} / ${r.filesCited} | ${esc((r.absent || []).slice(0, 6).join(', '))}${(r.absent || []).length > 6 ? ', …' : ''} |`);
  }
  const tiers = records.filter((r) => r.tier !== 'reach');
  if (tiers.length) {
    out.push('', '| candidate | claim | tier | mode | CodeExam chose | litigant cited (reachable) | both | found of cited | cited of chosen | matched |', '|---|---:|---|---|---:|---:|---:|---:|---:|---|');
    for (const r of tiers) out.push(`| ${esc(r.id)} | ${r.claim ?? ''} | ${r.tier} | ${esc(r.mode || '')} | ${r.skipped ? esc(r.skipped) : r.ce} | ${r.key ?? ''} | ${r.hit ?? ''} | ${pct(r.agreement)} | ${pct(r.precision)} | ${esc((r.matched || []).slice(0, 8).join(', '))} |`);
  }
  return out.join('\n');
}
export function replaceSection(docText, rendered) {
  const a = docText.indexOf(AGREEMENT_START), b = docText.indexOf(AGREEMENT_END);
  if (a < 0 || b < 0 || b < a) throw new Error(`markers ${AGREEMENT_START} … ${AGREEMENT_END} not found`);
  return `${docText.slice(0, a + AGREEMENT_START.length)}\n${rendered}\n${docText.slice(b)}`;
}

// ---- the run -----------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { picks: null, catalog: null, work: null, steps: STEPS.slice(), only: null, llm: null, blind: 'both', runs: 1, render: null, top: 24 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--picks') { o.picks = v; i++; } else if (a === '--catalog') { o.catalog = v; i++; } else if (a === '--work') { o.work = v; i++; }
    else if (a === '--steps') { o.steps = v.split(',').map((s) => s.trim()).filter(Boolean); i++; } else if (a === '--only') { o.only = v.split(',').map((s) => s.trim()); i++; }
    else if (a === '--llm') { o.llm = v; i++; } else if (a === '--blind') { o.blind = v; i++; } else if (a === '--runs') { o.runs = Number(v); i++; }
    else if (a === '--render') { o.render = v; i++; } else if (a === '--top') { o.top = Number(v); i++; }
    else throw new Error(`unknown argument ${a}`);
  }
  for (const s of o.steps) if (!STEPS.includes(s)) throw new Error(`unknown step ${s}; steps are ${STEPS.join(',')}`);
  if (!['both', 'on', 'off'].includes(o.blind)) throw new Error('--blind must be both, on or off');
  return o;
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
// core.longpaths on every call: Spark's deepest paths pass Windows's 260-character limit from any work directory, and a worktree's checkout does not read the setting the clone wrote.
const git = (cwd, args) => { const r = spawnSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd}: ${(r.stderr || '').trim().slice(0, 300)}`); return (r.stdout || '').trim(); };
/** A worktree whose checkout completed: it has its .git link and no tracked file is missing or modified. */
const cleanTree = (t) => { try { return fs.existsSync(path.join(t, '.git')) && git(t, ['status', '--porcelain', '--untracked-files=no']) === ''; } catch { return false; } };
const slug = (org, repo) => `${org}__${repo}`;
const log = (m) => console.error(`# ${m}`);

/** Clones once per repository, resolves each candidate's ref (pinned, else the default branch at the filing date), and adds a worktree per resolved commit. */
function stepClone(man, o) {
  for (const c of man.candidates) for (const r of c.repos) {
    const dir = path.join(o.work, 'repos', slug(r.org, r.repo));
    if (!fs.existsSync(path.join(dir, '.git'))) {
      log(`clone ${r.org}/${r.repo}`);
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); // a clone that failed part-way
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      // Spark's deepest paths pass Windows's 260-character limit from any work directory; core.longpaths on the clone (repo-local, inherited by its worktrees) lets git write them.
      git(o.work, ['clone', '--no-tags', '--quiet', `https://github.com/${r.org}/${r.repo}.git`, dir]);
    }
    if (!r.resolvedRef) {
      if (r.ref) {
        try { git(dir, ['rev-parse', '--verify', '--quiet', `${r.ref}^{commit}`]); } catch { git(dir, ['fetch', '--quiet', 'origin', r.ref]); }
        r.resolvedRef = git(dir, ['rev-parse', '--verify', `${r.ref}^{commit}`]); r.refRule = 'pinned by the filing';
      } else {
        const head = git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']); // origin/master
        const sha = git(dir, ['rev-list', '-1', `--before=${c.dateFiled}T23:59:59Z`, head]);
        if (!sha) throw new Error(`${r.org}/${r.repo}: no commit on ${head} before ${c.dateFiled}`);
        r.resolvedRef = sha; r.refRule = `${head} at ${c.dateFiled}`;
      }
    }
    const tree = path.join(o.work, 'trees', `${slug(r.org, r.repo)}__${r.resolvedRef.slice(0, 7)}`);
    if (fs.existsSync(tree) && !cleanTree(tree)) { // a checkout that stopped part-way would be indexed half-empty
      log(`worktree ${path.basename(tree)} is incomplete; re-adding`);
      try { git(dir, ['worktree', 'remove', '--force', tree]); } catch { /* not registered, or already gone */ }
      fs.rmSync(tree, { recursive: true, force: true });
      git(dir, ['worktree', 'prune']);
    }
    if (!fs.existsSync(tree)) {
      log(`worktree ${r.org}/${r.repo} @ ${r.resolvedRef.slice(0, 7)}`);
      git(dir, ['worktree', 'add', '--detach', '--quiet', tree, r.resolvedRef]);
      if (!cleanTree(tree)) throw new Error(`worktree ${tree} did not check out completely`);
    }
    r.tree = tree;
  }
}
const indexDirOf = (o, r) => path.join(o.work, 'indexes', `${slug(r.org, r.repo)}__${r.resolvedRef.slice(0, 7)}`);
/** The build command for one repository: a pick's `addExtensions` (".sol" for a Solidity repository, which the default extension set leaves out) is passed through. */
export function indexArgs(r, idx) {
  return ['--build-index', r.tree, '--index-path', idx, ...(r.addExtensions ? ['--add-extensions', r.addExtensions] : [])];
}
function stepIndex(man, o, state) {
  for (const c of man.candidates) for (const r of c.repos) {
    const idx = indexDirOf(o, r);
    if (fs.existsSync(path.join(idx, 'function_index.json'))) continue;
    log(`index ${path.basename(idx)}${r.addExtensions ? ` (+${r.addExtensions})` : ''}`);
    const t0 = Date.now();
    const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), ...indexArgs(r, idx)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.mkdirSync(path.join(o.work, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(o.work, 'logs', `index_${path.basename(idx)}.log`), `${res.stdout || ''}\n${res.stderr || ''}`);
    if (res.status !== 0 || !fs.existsSync(path.join(idx, 'function_index.json'))) throw new Error(`index build failed for ${idx} (exit ${res.status}); see logs`);
    state.indexSeconds = state.indexSeconds || {}; state.indexSeconds[path.basename(idx)] = Math.round((Date.now() - t0) / 1000);
  }
}
/** The claims of every candidate's patent, cached by litigated-claims-fetch.mjs; one text file and one elements file (Google's claim-text divisions, the preamble first) per asserted claim. */
function stepClaims(man, o) {
  const dir = path.join(o.work, 'claims');
  fs.mkdirSync(path.join(dir, 'patents'), { recursive: true });
  const need = [...new Set(man.candidates.map((c) => c.patent))].filter((p) => !fs.existsSync(path.join(dir, 'patents', `${p}.json`)));
  if (need.length) {
    const list = path.join(dir, 'patents.txt'); fs.writeFileSync(list, need.join('\n') + '\n');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'litigated-claims-fetch.mjs'), '--patents', list, '--out', dir, '--delay', '2000'], { stdio: 'inherit' });
    if (r.status !== 0) log(`claims fetch exited ${r.status}`);
  }
  for (const c of man.candidates) {
    const f = path.join(dir, 'patents', `${c.patent}.json`);
    if (!fs.existsSync(f)) { c.claimsMissing = 'patent not fetched'; continue; }
    const j = readJson(f);
    if (j.error || !j.claims) { c.claimsMissing = j.error || 'no claims'; continue; }
    c.claimFiles = {};
    for (const n of c.claims) {
      const cl = j.claims.find((x) => x.n === n);
      if (!cl) { log(`${c.id}: claim ${n} not in US ${c.patent}`); continue; }
      const out = path.join(o.work, 'out', c.id);
      fs.mkdirSync(out, { recursive: true });
      const text = path.join(out, `claim-${n}.txt`), elements = path.join(out, `claim-${n}.elements.txt`);
      fs.writeFileSync(text, `${cl.text}\n`);
      const lines = (cl.lines && cl.lines.length >= 2) ? cl.lines : [cl.text];
      fs.writeFileSync(elements, [`# US ${c.patent} claim ${n}: the attorney's claim-text divisions from patents.google.com; the preamble is row 1`, ...lines].join('\n') + '\n');
      c.claimFiles[n] = { text, elements, words: cl.text.split(/\s+/).length, lines: lines.length };
    }
  }
}
const symbolsOf = (idx) => {
  const fi = readJson(path.join(idx, 'function_index.json'));
  const byFile = {};
  for (const [file, syms] of Object.entries(fi)) byFile[file] = Object.keys(syms || {});
  return byFile;
};
function stepReach(man, o, records) {
  for (const c of man.candidates) {
    if (!c.key) continue;
    for (const r of c.repos) {
      const idx = indexDirOf(o, r);
      if (!fs.existsSync(path.join(idx, 'function_index.json'))) continue;
      const byFile = symbolsOf(idx);
      const files = Object.keys(byFile), symbols = [...new Set(Object.values(byFile).flat())];
      const fn = matchFunctions(c.key.functions, symbols), fl = matchFiles([...new Set([...c.key.files, ...c.key.links.map((l) => l.path).filter(Boolean)])], files);
      const rec = { id: c.id, repo: `${r.org}/${r.repo}`, ref: r.resolvedRef, tier: 'reach', symbols: symbols.length, files: files.length,
        functionsCited: c.key.functions.length, functionsPresent: fn.present.length, filesCited: fl.present.length + fl.absent.length, filesPresent: fl.present.length,
        present: fn.present.map((p) => p.symbol), presentNames: fn.present.map((p) => p.name), absent: fn.absent, filesAbsent: fl.absent };
      records.push(rec);
      writeJson(path.join(o.work, 'out', c.id, `reach_${path.basename(idx)}.json`), { ...rec, functions: fn, files: fl });
    }
  }
}
const score = (c, picked, reachable, extra) => {
  const ce = new Set(picked.map((p) => nameKey(p.symbol)));
  const key = new Set(reachable.map((n) => nameKey(n)));
  return { id: c.id, ...extra, ...agreement(ce, key), chosen: picked.slice(0, 40).map((p) => `${p.file}@${p.symbol}`), keyNames: [...key] };
};
const reachableNames = (c, o, r) => { const f = path.join(o.work, 'out', c.id, `reach_${path.basename(indexDirOf(o, r))}.json`); return fs.existsSync(f) ? readJson(f).functions.present.map((p) => p.name) : c.key.functions; };
function stepTier0(man, o, records) {
  for (const c of man.candidates) {
    if (!c.key || !c.claimFiles) continue;
    for (const r of c.repos) {
      const idx = indexDirOf(o, r);
      if (!fs.existsSync(path.join(idx, 'function_index.json'))) continue;
      const byFile = symbolsOf(idx), reach = reachableNames(c, o, r);
      for (const [n, f] of Object.entries(c.claimFiles)) {
        const picked = tier0Rank(fs.readFileSync(f.text, 'utf8'), byFile, { top: o.top });
        const rec = score(c, picked, reach, { repo: `${r.org}/${r.repo}`, claim: Number(n), tier: 'tier0', mode: 'rule' });
        records.push(rec); writeJson(path.join(o.work, 'out', c.id, `tier0_claim${n}_${path.basename(idx)}.json`), { ...rec, picked });
      }
    }
  }
}
/** Runs a CodeExam command against an index; the model's refusal (no key, no model) is recorded as skipped, not as a failure. */
function ce(args, o, logFile) {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src', 'index.js'), ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, `node src/index.js ${args.join(' ')}\n\n${res.stdout || ''}\n${res.stderr || ''}`);
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  if (/No API key|API key|not found|ENOENT.*gguf|no model/i.test(text) && res.status !== 0) return { skipped: 'no model or key (see log)' };
  if (res.status !== 0) return { skipped: `exit ${res.status} (see log)` };
  return { ok: true };
}
function stepTier1(man, o, records) {
  const modes = o.blind === 'both' ? ['blind', 'plain'] : [o.blind === 'on' ? 'blind' : 'plain'];
  for (const c of man.candidates) {
    if (!c.key || !c.claimFiles) continue;
    const n = c.claims[0], f = c.claimFiles[n];
    if (!f) continue;
    for (const r of c.repos) {
      const idx = indexDirOf(o, r);
      if (!fs.existsSync(path.join(idx, 'function_index.json'))) continue;
      const reach = reachableNames(c, o, r);
      for (const mode of modes) {
        const out = path.join(o.work, 'out', c.id, `tier1_claim${n}_${mode}_${path.basename(idx)}.targets.txt`);
        let status = { ok: true };
        if (!fs.existsSync(out)) {
          const args = ['--index-path', idx, '--claim-locate', `@${f.text}`, '--targets-out', out, ...(mode === 'blind' ? ['--blind'] : []), ...(o.llm ? ['--llm', o.llm] : []), ...(o.runs > 1 ? ['--runs', String(o.runs)] : [])];
          status = ce(args, o, out.replace(/\.targets\.txt$/, '.log'));
        }
        const picked = status.ok && fs.existsSync(out) ? parseTargets(fs.readFileSync(out, 'utf8')) : [];
        records.push({ ...score(c, picked, reach, { repo: `${r.org}/${r.repo}`, claim: n, tier: 'tier1', mode }), skipped: status.skipped || null });
      }
    }
  }
}
function stepTier2(man, o, records) {
  for (const c of man.candidates) {
    if (!c.key || !c.claimFiles) continue;
    const n = c.claims[0], f = c.claimFiles[n];
    if (!f) continue;
    for (const r of c.repos) {
      const idx = indexDirOf(o, r);
      if (!fs.existsSync(path.join(idx, 'function_index.json'))) continue;
      const reach = reachableNames(c, o, r);
      const out = path.join(o.work, 'out', c.id, `tier2_claim${n}_${path.basename(idx)}.verdicts.json`);
      let status = { ok: true };
      if (!fs.existsSync(out)) status = ce(['--index-path', idx, '--claim-chart', `@${f.text}`, '--elements', `@${f.elements}`, '--verdicts-out', out, ...(o.llm ? ['--llm', o.llm] : [])], o, out.replace(/\.verdicts\.json$/, '.log'));
      const picked = status.ok && fs.existsSync(out) ? parseVerdicts(readJson(out)) : [];
      records.push({ ...score(c, picked, reach, { repo: `${r.org}/${r.repo}`, claim: n, tier: 'tier2', mode: 'per-element' }), skipped: status.skipped || null });
    }
  }
}

/**
 * A candidate that cites several repositories is scored on their union too: the litigant's names
 * reachable in any of them against everything CodeExam chose across them, as records with
 * repo "all". Per-repository records stay; a name cited for one repository is not expected in
 * another.
 */
export function rollup(records) {
  const out = [];
  const byCand = new Map();
  for (const r of records) { const l = byCand.get(r.id) || []; l.push(r); byCand.set(r.id, l); }
  for (const [id, recs] of byCand) {
    const repos = new Set(recs.map((r) => r.repo));
    if (repos.size < 2) continue;
    const reach = recs.filter((r) => r.tier === 'reach');
    if (reach.length) {
      // Counted by the litigant's names, as the per-repository rows are: three names can share one symbol ("depositTx.wait" and "approveTx.wait" both meet "wait").
      const names = new Set(reach.flatMap((r) => r.presentNames || r.present || []));
      const absent = [...new Set(reach.flatMap((r) => r.absent || []))].filter((n) => !names.has(n));
      out.push({ id, repo: 'all', ref: '', tier: 'reach', symbols: reach.reduce((a, r) => a + (r.symbols || 0), 0), functionsCited: reach[0].functionsCited, functionsPresent: names.size,
        filesCited: Math.max(...reach.map((r) => r.filesCited || 0)), filesPresent: Math.max(...reach.map((r) => r.filesPresent || 0)), present: [...new Set(reach.flatMap((r) => r.present || []))], presentNames: [...names], absent, union: true });
    }
    const groups = new Map();
    for (const r of recs) { if (r.tier === 'reach') continue; const k = `${r.tier}|${r.claim}|${r.mode}`; const g = groups.get(k) || []; g.push(r); groups.set(k, g); }
    for (const [k, g] of groups) {
      const [tier, claim, mode] = k.split('|');
      const ce = new Set(g.flatMap((r) => (r.chosen || []).map((c) => nameKey(c.split('@').pop()))));
      const key = new Set(g.flatMap((r) => r.keyNames || []));
      out.push({ id, repo: 'all', claim: Number(claim), tier, mode, ...agreement(ce, key), skipped: g.every((r) => r.skipped) ? g[0].skipped : null, union: true });
    }
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  if (!o.work || !o.picks) { console.error('usage: node scripts/recap-chart-agreement.mjs --picks <picks.json> --work <dir> [--catalog <catalog.jsonl>] [--steps a,b] [--only id,id] [--llm X] [--blind both|on|off] [--runs N] [--render <docs page>]'); process.exit(2); }
  fs.mkdirSync(o.work, { recursive: true });
  const manFile = path.join(o.work, 'manifest.json'), stateFile = path.join(o.work, 'state.json'), recFile = path.join(o.work, 'agreement.jsonl');
  const state = fs.existsSync(stateFile) ? readJson(stateFile) : {};
  let man;
  if (o.steps.includes('prepare') || !fs.existsSync(manFile)) {
    const picks = readJson(o.picks);
    const errors = validatePicks(picks);
    if (errors.length) throw new Error(`picks: ${errors.join('; ')}`);
    if (!o.catalog) throw new Error('--catalog <run>/catalog.jsonl is needed to prepare the manifest');
    const fresh = buildManifest(picks, readJsonl(o.catalog));
    if (fs.existsSync(manFile)) { // keep resolved refs and claim files across re-prepares
      const old = readJson(manFile);
      for (const c of fresh.candidates) { const oc = old.candidates.find((x) => x.id === c.id); if (oc) { c.repos.forEach((r) => { const or = (oc.repos || []).find((x) => x.org === r.org && x.repo === r.repo); if (or) Object.assign(r, { resolvedRef: or.resolvedRef, refRule: or.refRule, tree: or.tree }); }); if (oc.claimFiles) c.claimFiles = oc.claimFiles; } }
    }
    man = fresh; writeJson(manFile, man);
    log(`manifest: ${man.candidates.length} candidate(s), ${man.candidates.filter((c) => !c.key).length} not in the catalog`);
  } else man = readJson(manFile);
  if (o.only) man.candidates = man.candidates.filter((c) => o.only.includes(c.id));
  const records = readJsonl(recFile).filter((r) => !o.only || !o.only.includes(r.id));
  const steps = o.steps.filter((s) => s !== 'prepare');
  const keep = (tier) => { for (let i = records.length - 1; i >= 0; i--) if (records[i].tier === tier && (!o.only || o.only.includes(records[i].id))) records.splice(i, 1); };
  for (const s of steps) {
    log(`step ${s}`);
    if (s === 'clone') stepClone(man, o);
    else if (s === 'index') stepIndex(man, o, state);
    else if (s === 'claims') stepClaims(man, o);
    else if (s === 'reach') { keep('reach'); stepReach(man, o, records); }
    else if (s === 'tier0') { keep('tier0'); stepTier0(man, o, records); }
    else if (s === 'tier1') { keep('tier1'); stepTier1(man, o, records); }
    else if (s === 'tier2') { keep('tier2'); stepTier2(man, o, records); }
    if (o.only) { const all = readJson(manFile); for (const c of man.candidates) { const i = all.candidates.findIndex((x) => x.id === c.id); if (i >= 0) all.candidates[i] = c; } writeJson(manFile, all); } else writeJson(manFile, man);
    writeJson(stateFile, state);
    fs.writeFileSync(recFile, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  }
  const md = renderAgreement([...records.filter((r) => !r.union), ...rollup(records.filter((r) => !r.union))]);
  fs.writeFileSync(path.join(o.work, 'agreement.md'), md + '\n');
  if (o.render) { fs.writeFileSync(o.render, replaceSection(fs.readFileSync(o.render, 'utf8'), md)); log(`rendered into ${o.render}`); }
  const tiers = records.filter((r) => r.tier !== 'reach');
  console.log(`candidates ${man.candidates.length}; records ${records.length} (${records.filter((r) => r.tier === 'reach').length} reach, ${tiers.length} tier, ${tiers.filter((r) => r.skipped).length} skipped); index seconds ${JSON.stringify(state.indexSeconds || {})}; ${path.join(o.work, 'agreement.md')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
