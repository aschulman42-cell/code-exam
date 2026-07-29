// mechanism-grouper.js — #284 B1 candidate-emitter.
//
// Deterministic (no LLM) clustering of an index's functions into candidate
// mechanism groups, emitted as a `# Label` + `file@func` anchors.lst that
// `--pseudo-claims` consumes. This is the mechanical baseline the later #284
// seams lift; it does NOT rank worthiness (that is the bounded-LLM seam), detect
// collections (#285), or resolve anchor grammar (#286) — the emitted set is
// UNRANKED; a human hand-selects the claim-worthy.
//
// Validated across a dozen corpora (see pcrun_save_072526/_MAP.md). Ported from
// scripts/grouper-prototype.mjs; the graph-decomposition experiment in that
// prototype (label propagation / Louvain) FAILED and was intentionally left
// behind — only the multi-seed path graduates here.

import { isIntrinsicName, extractConcepts, buildDocInclusiveVocabulary, _isNoiseDoc } from './vocabulary.js';
import { extractCommandCatalog } from './breadcrumbs-commands.js';
import { findCallees } from './calls.js';

export const GROUPER_DEFAULTS = {
  mode: 'multi',        // 'multi' (token+class+optional file) | 'concept' (token-only baseline)
  minLines: 4,          // skip one-liner getters/wrappers
  minComm: 3,           // a real group has >= this many functions
  concepts: 24,         // distinctive concepts seeded (extractConcepts)
  classes: 12,          // top-N substantial classes admitted by the class seed
  overbroadPct: 0.20,   // over-broad by COUNT: a token owning > this fraction of candidates...
  overbroadFileFrac: 0.25, // ...is a namespace ONLY if it also cross-cuts > this fraction of the corpus files
  fileMax: 20,          // residual FILE seed only considers files this small
  fileSeed: false,      // FILE seed is opt-in (firehoses on C++ — see the note below)
  useDocs: false,       // --use-docs (#284 signal-rich gather): doc-inclusive gather vocabulary
  catalogSeed: false,   // --catalog-seed (#284 signal-rich gather): command-catalog handler seed
  maxFuncs: Infinity,   // cap candidates on huge indexes (0/Infinity = no cap)
};

// Concepts for the token seeds. Default: the cached code-only vocabulary via
// extractConcepts. With `useDocs` (#284 signal-rich gather), build a
// doc-INCLUSIVE vocabulary (uncached, cache untouched — see
// buildDocInclusiveVocabulary) and inject its top entries, so doc-borne
// feature terms compete for the same top-N concept cutoff as code tokens —
// included, not promoted. Fail-open: any error yields no token seeds and the
// class/catalog/file seeds still run (stub indexes in tests take this path).
function gatherConcepts(index, o) {
  try {
    if (o.useDocs) {
      const vocab = buildDocInclusiveVocabulary(index, false);
      const entries = [...vocab.entries()].map(([token, data]) => ({ token, ...data }))
        .sort((a, b) => b.score - a.score).slice(0, 200); // mirror extractConcepts' topN default
      return extractConcepts(index, { maxConcepts: o.concepts, entries }) || [];
    }
    return extractConcepts(index, { maxConcepts: o.concepts }) || [];
  } catch { return []; }
}

// Mechanical noise pre-filter: drop whole noise files (test / vendor / minified /
// build / lockfile via the shared _isNoiseDoc, plus dist/ output, dead/backup
// files, and Google-style foo_unittest.cc / foo_browsertest.cc suffixes) from the
// candidate set. JUNK REMOVAL ONLY. CAVEAT: this is a BLUNT cut — some dropped
// categories (testing frameworks especially) can be patentable; anything filtered
// here is invisible to a later worthiness stage forever. Revisit as tag-and-demote
// if that matters.
export function isNoiseFile(file) {
  if (_isNoiseDoc(file, null)) return true;
  const n = String(file).replace(/\\/g, '/');
  const base = n.slice(n.lastIndexOf('/') + 1);
  if (/(?:^|[._-])(?:(?:unit|browser|api)?tests?|specs?)(?:[._-]|$)/i.test(base)) return true;
  return /\/dist\//i.test(n) || /_old\d*[._-]|\.old$|_bak[._-]|~$/i.test(n);
}

// Enumerate candidate functions from the index's functionIndex: skip noise files,
// class-declaration entries, intrinsics, and sub-MIN_LINES one-liners. Returns
// the candidate list + a byId map + the noise-file/function counts.
export function enumerateFuncs(index, opts = {}) {
  const o = { ...GROUPER_DEFAULTS, ...opts };
  index._ensureFunctionIndex?.();
  const funcs = [];
  const byId = new Map();
  let noiseFiles = 0, noiseFns = 0;
  for (const [file, fns] of Object.entries(index.functionIndex || {})) {
    if (isNoiseFile(file)) { noiseFiles++; noiseFns += Object.keys(fns).length; continue; }
    for (const [full, info] of Object.entries(fns)) {
      if ((info.type || 'function') === 'class') continue;
      const bare = (info.base_name || full.split('::').pop() || '').split('@')[0];
      if (!bare || isIntrinsicName(bare)) continue;
      const lines = (info.end || 0) - (info.start || 0) + 1;
      if (lines < o.minLines) continue;
      const id = `${file}@${full}`;
      const f = { id, file, name: full, bare, start: info.start, end: info.end, lines };
      funcs.push(f); byId.set(id, f);
    }
  }
  // Optional cap for huge indexes; keep ground-truth files fully in the set when
  // scoring so recall isn't capped by truncation.
  if (Number.isFinite(o.maxFuncs) && o.maxFuncs > 0 && funcs.length > o.maxFuncs) {
    let keep;
    if (opts.gtFiles && opts.gtFiles.size) {
      const inGt = funcs.filter((f) => opts.gtFiles.has(f.file));
      const rest = funcs.filter((f) => !opts.gtFiles.has(f.file)).slice(0, Math.max(0, o.maxFuncs - inGt.length));
      keep = [...inGt, ...rest];
    } else keep = funcs.slice(0, o.maxFuncs);
    funcs.length = 0; funcs.push(...keep);
    byId.clear(); for (const f of funcs) byId.set(f.id, f);
  }
  return { funcs, byId, noiseFiles, noiseFns };
}

// TOKEN-only baseline (`--group-by concept`): seed from CE's cross-corpus-
// distinctive concepts, gather each concept's members by name-token match, one
// function per highest-ranked matching concept.
function conceptSeededGroups(index, funcs, o) {
  const concepts = gatherConcepts(index, o);
  const rank = new Map(), label = new Map();
  concepts.forEach((c, i) => {
    const t = String(c.concept || '').toLowerCase();
    if (t.length >= 3 && !rank.has(t)) { rank.set(t, i); label.set(t, c.example ? `${c.concept} (${c.example})` : c.concept); }
  });
  const tokens = [...rank.keys()];
  const groups = new Map();
  for (const f of funcs) {
    const nameLc = f.bare.toLowerCase();
    let bestTok = null, bestRank = Infinity;
    for (const t of tokens) if (nameLc.includes(t) && rank.get(t) < bestRank) { bestRank = rank.get(t); bestTok = t; }
    if (bestTok) (groups.get(bestTok) || groups.set(bestTok, new Set()).get(bestTok)).add(f.id);
  }
  return [...groups.entries()].filter(([, ids]) => ids.size >= o.minComm).map(([tok, ids]) => ({ label: label.get(tok) || tok, ids }));
}

// Multi-seed grouping (default): a "seed" is any distinctive COHESION UNIT. TOKEN
// seed (name-token, cross-file) first, rejecting corpus-name and over-broad
// namespace concepts; then CLASS seed (methods of a substantial indexed class);
// then a residual FILE seed (a small file whose leftover functions are its
// majority) picks up the file-cohesive mechanism (scattered names, low-frequency
// tokens) token+class can't see.

// An over-broad token is a namespace/prefix (reject) only when it BOTH owns more
// than `cap` candidates AND cross-cuts more than `spreadCap` files. A token that
// owns a big fraction but concentrates in one/few files is a real mechanism
// (deflate -> deflate.c), so it is KEPT — which is what lets a small corpus, where
// every mechanism token exceeds the percentage cap, still produce groups (#284).
export function isOverBroadNamespace(size, cap, fileCount, spreadCap) {
  return size > cap && fileCount > spreadCap;
}

function multiSeedGroups(index, funcs, o) {
  const idxName = String(o.indexName || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const cap = Math.max(o.minComm, Math.floor((funcs.length || 1) * o.overbroadPct));
  const totalFiles = new Set(funcs.map((f) => f.file)).size || 1;
  const spreadCap = Math.max(3, Math.ceil(totalFiles * o.overbroadFileFrac)); // a namespace cross-cuts many files
  const fileOf = new Map(funcs.map((f) => [f.id, f.file]));
  const assigned = new Map(); // funcId -> label

  // 1) TOKEN seeds — reject corpus-name and over-broad namespace concepts.
  const concepts = gatherConcepts(index, o);
  const rank = new Map(), tlabel = new Map();
  concepts.forEach((c, i) => { const t = String(c.concept || '').toLowerCase(); if (t.length >= 3 && !rank.has(t) && !(idxName && idxName.includes(t))) { rank.set(t, i); tlabel.set(t, c.example ? `${c.concept} (${c.example})` : c.concept); } });
  const tokens = [...rank.keys()];
  const tokGroups = new Map();
  for (const f of funcs) {
    const nameLc = f.bare.toLowerCase();
    let best = null, bestRank = Infinity;
    for (const t of tokens) if (nameLc.includes(t) && rank.get(t) < bestRank) { bestRank = rank.get(t); best = t; }
    if (best) (tokGroups.get(best) || tokGroups.set(best, new Set()).get(best)).add(f.id);
  }
  for (const [t, ids] of tokGroups) {
    const fileCount = new Set([...ids].map((id) => fileOf.get(id))).size;
    if (isOverBroadNamespace(ids.size, cap, fileCount, spreadCap)) continue; // namespace/prefix -> funcs fall through
    for (const id of ids) assigned.set(id, tlabel.get(t));
  }

  // 2) CLASS seeds for the unassigned — methods of an indexed class only, so a
  // bare namespace (blink::) is NOT swept up as a class. Key by the LEAF class
  // name so namespace-inconsistent index records merge (blink::Foo + bare Foo ->
  // one Foo), EXCEPT when a leaf is ambiguous (>=2 distinct non-empty parents:
  // AlertDialog::Builder, Uri::Builder) -> key by parent::leaf. Drop gtest/junit
  // harness classes. Gate to the top-N substantial classes (by method count) so a
  // codec's ~50 utility/data classes (Lock, Event, MD5, SEI*) don't firehose.
  const classNames = new Set();
  for (const fns of Object.values(index.functionIndex || {})) for (const [full, info] of Object.entries(fns)) if (info && info.type === 'class') classNames.add((info.base_name || full.split('::').pop() || full).split('@')[0]);
  const leafParents = new Map(); const recs = [];
  for (const f of funcs) {
    if (assigned.has(f.id)) continue;
    const ix = f.name.lastIndexOf('::'); if (ix <= 0) continue;
    const segs = f.name.slice(0, ix).split('::');
    const leaf = segs[segs.length - 1], parent = segs.length >= 2 ? segs[segs.length - 2] : '';
    if (!leaf || !classNames.has(leaf) || /(?:Test|Tests|TestCase|Fixture)$/.test(leaf)) continue;
    recs.push({ id: f.id, leaf, parent });
    if (parent) (leafParents.get(leaf) || leafParents.set(leaf, new Set()).get(leaf)).add(parent);
  }
  const classMethods = new Map();
  for (const r of recs) {
    const key = ((leafParents.get(r.leaf)?.size || 0) >= 2 && r.parent) ? `${r.parent}::${r.leaf}` : r.leaf;
    (classMethods.get(key) || classMethods.set(key, []).get(key)).push(r.id);
  }
  for (const [cls, ids] of [...classMethods.entries()].filter(([, m]) => m.length >= o.minComm).sort((a, b) => b[1].length - a[1].length).slice(0, o.classes)) for (const id of ids) assigned.set(id, `[class] ${cls}`);

  // 3) CATALOG seed (OPT-IN --catalog-seed, #284 signal-rich gather) — each
  // command-catalog CLI option with a resolved handler join seeds
  // `[cmd] <flag>` = the handler function + its direct callees, on the
  // UNASSIGNED residue only (after token/class, so the coverage gain is
  // isolated and attributable; a function already claimed stays put).
  // Cross-file by construction — the seed shape token/class can't express
  // (a feature implemented across several files, e.g. an air-gap mode).
  // Junk controls: options with no handler join are skipped; handlers that
  // don't resolve to exactly one indexed function are skipped (catalog joins
  // are heuristic — the harness measures their fidelity, we don't assume it);
  // ambiguous callees are skipped; the group still needs minComm members.
  // Fail-open like the token seed: a stub index without fileLines just
  // contributes no catalog groups.
  if (o.catalogSeed) {
    let cliOptions = [];
    try { cliOptions = (extractCommandCatalog(index, false) || {}).cliOptions || []; } catch { /* */ }
    for (const opt of cliOptions) {
      const hname = opt.handler && opt.handler.handlerFunc;
      if (!hname) continue;
      let hm = [];
      try { hm = index.findFunctionMatches(hname) || []; } catch { /* */ }
      if (hm.length !== 1) continue;
      const h = hm[0];
      const memberIds = new Set();
      const tryAdd = (fid) => { if (fid && fileOf.has(fid) && !assigned.has(fid)) memberIds.add(fid); };
      tryAdd(`${h.filepath}@${h.name}`);
      let callees = [];
      try { callees = findCallees(index, h.name, h.filepath) || []; } catch { /* */ }
      for (const c of callees) {
        const def = c.resolved_def;
        if (!def || c.ambiguous) continue;
        tryAdd(`${def.filepath}@${def.name || c.name}`);
      }
      if (memberIds.size < o.minComm) continue;
      const flag = (opt.flags || []).find((f) => f.startsWith('--')) || `--${opt.name}`;
      for (const fid of memberIds) assigned.set(fid, `[cmd] ${flag}`);
    }
  }

  // 4) FILE seed (OPT-IN) — a SMALL file whose leftover (unassigned) functions are
  // its MAJORITY is one cohesive mechanism (scattered names token+class miss).
  // OFF by default: residual file-cohesion can't tell a distinctive mechanism from
  // an ordinary module or a codec kernel file, so it firehoses on C++ (~50
  // file-groups). The clean signal is import/export fan-out — the deferred
  // import/resource seed — not raw co-location.
  if (o.fileSeed) {
    const byFileU = new Map();
    for (const f of funcs) { const e = byFileU.get(f.file) || byFileU.set(f.file, { total: 0, un: [] }).get(f.file); e.total++; if (!assigned.has(f.id)) e.un.push(f.id); }
    const base = (fp) => { const s = String(fp).replace(/\\/g, '/'); return s.slice(s.lastIndexOf('/') + 1); };
    for (const [file, e] of byFileU) if (e.un.length >= o.minComm && e.total <= o.fileMax && e.un.length * 2 >= e.total) for (const id of e.un) assigned.set(id, `[file] ${base(file)}`);
  }

  const groups = new Map();
  for (const [id, lbl] of assigned) (groups.get(lbl) || groups.set(lbl, new Set()).get(lbl)).add(id);
  return [...groups.entries()].filter(([, ids]) => ids.size >= o.minComm).map(([lbl, ids]) => ({ label: lbl, ids }));
}

// Emit-faithful anchor spec for a member: exactly the `file@<spec>` tail
// formatAnchors (and the --rank emit) prints — the bare name for an
// @-disambiguated index key (`reComment@227` -> `reComment`), else the full
// qualified name (`Class::method`). Single source of truth so the member filter
// pre-resolves the SAME line that will be emitted.
export function anchorSpec(f) {
  return f.name.includes('@') ? f.bare : f.name;
}

// A member is claim-worthy only if its emitted anchor resolves to EXACTLY ONE
// indexed function. Parses the emitted `file@spec` line the same way the
// --pseudo-claims resolver (loadGroundTruth) does, then checks
// findFunctionMatches. This drops the anonymous / regex-literal / duplicate
// anchors the regex fallback parser mis-detects as functions (`reComment` x11 —
// a `const reComment = /.../ ` literal keyed per line; `walk` x8 — anonymous
// nested closures) at their source, so they never reach the candidate .lst and
// never raise "ambiguous — N functions match" at draft time.
function memberResolvesUniquely(index, f) {
  // Fail open: without a resolver we can't verify, so keep the member rather than
  // drop it (a real index always exposes findFunctionMatches — cf. loadGroundTruth;
  // resolver-less stubs pass through unfiltered).
  if (typeof index.findFunctionMatches !== 'function') return true;
  const line = `${f.file}@${anchorSpec(f)}`;
  const at = line.lastIndexOf('@');
  const after = line.slice(at + 1);
  let fileHint = null, funcName = line;
  if (!/^\d+$/.test(after)) { fileHint = line.slice(0, at); funcName = after; }
  const ms = index.findFunctionMatches(funcName, fileHint);
  return !!(ms && ms.length === 1);
}

// Filter a group's materialized members: dedupe members that emit the same
// `file@spec` anchor (the x11/x8 collapse), then drop any that don't resolve
// uniquely. Order preserved.
function filterMembers(index, members) {
  const seen = new Set();
  const kept = [];
  for (const f of members) {
    const line = `${f.file}@${anchorSpec(f)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    if (memberResolvesUniquely(index, f)) kept.push(f);
  }
  return kept;
}

// Group an index's functions into candidate mechanism groups. Returns
// { groups: [{label, ids:Set, members:[func]}], funcs, byId, noiseFiles, noiseFns, mode }.
export function groupMechanisms(index, opts = {}) {
  const o = { ...GROUPER_DEFAULTS, ...opts };
  const { funcs, byId, noiseFiles, noiseFns } = enumerateFuncs(index, o);
  const raw = o.mode === 'concept' ? conceptSeededGroups(index, funcs, o) : multiSeedGroups(index, funcs, o);
  const groups = raw
    .map((g) => {
      // Filter junk members, then rebuild ids from the survivors so emit,
      // members, and ids (the scoring path) stay consistent.
      const members = filterMembers(index, [...g.ids].map((id) => byId.get(id)).filter(Boolean));
      return { label: g.label, ids: new Set(members.map((m) => m.id)), members };
    })
    .filter((g) => g.members.length > 0) // a group whose anchors were all junk is dropped
    .sort((a, b) => b.ids.size - a.ids.size);
  return { groups, funcs, byId, noiseFiles, noiseFns, mode: o.mode };
}

// Render grouping output as a draft anchors.lst (the grammar --pseudo-claims parses).
export function formatAnchors(result, meta = {}) {
  const { groups, noiseFiles, noiseFns } = result;
  const minComm = meta.minComm ?? GROUPER_DEFAULTS.minComm;
  const out = [`# mechanism-grouper  index=${meta.indexName || '?'}  group-by=${result.mode}  ${groups.length} groups (>= ${minComm} fns), ${noiseFiles} noise files (${noiseFns} fns) pre-filtered — UNRANKED draft; hand-select the claim-worthy`];
  for (const g of groups) {
    const purpose = meta.purposeFor ? meta.purposeFor(g.label, g.members) : '';
    out.push('', `# ${g.label}  (${g.members.length} fns)${purpose ? '  — ' + purpose : ''}`);
    for (const f of g.members) out.push(`${f.file}@${anchorSpec(f)}`);
  }
  return out.join('\n') + '\n';
}

// Parse one anchors-.lst `#` header line back into { label, priority, purpose }
// — the inverse of the emit grammar above (formatAnchors here, the --rank emit
// in pseudo-claims.js):
//   `# label  (N fns)  [P2 signal/fold — note]  — purpose`   (ranked)
//   `# label  (N fns)  — purpose`                            (unranked)
//   `# label [P3]`                                           (hand-tier-tagged)
//   `# label`                                                (plain, passes through whole)
// The label may itself contain parens (`catalog (exportCatalogJson)`), so the
// split point is the FIRST `(N fns)`-shaped marker; the `[P…]` tag closes at
// the first `]` (ranker notes are bounded, whitespace-collapsed, and `]`-free
// in practice). Consumers: collectAnchorGroups (pseudo-claims.js) builds the
// drafter's MECHANISM hint from label + purpose so triage annotations —
// member counts, priority tags, ranker notes — never leak into the one line
// the drafter is told to honor as the mechanism's identity. The scoring
// harness keeps a private copy of this grammar (src/core/ranker-eval.js;
// dedup deferred until that item commits) — change the emit and BOTH parsers
// must track it.
export function parseAnchorHeader(line) {
  const h = String(line).replace(/^#+/, '').trim();
  const m = h.match(/^(.*?)\s*\(\d+\s*fns?\)\s*(.*)$/);
  let label = m ? m[1].trim() : h;
  let rest = m ? m[2] : '';
  let priority = null;
  const tag = rest.match(/^\[P([0-3])\b[^\]]*\]\s*(.*)$/);
  if (tag) { priority = Number(tag[1]); rest = tag[2]; }
  else { const un = rest.match(/^\[unscored\]\s*(.*)$/); if (un) rest = un[1]; }
  const purpose = rest.replace(/^[—–-]+\s*/, '').trim();
  // Bare trailing tier tag on a hand-tagged header (`# Label [P3]`).
  const bare = label.match(/\s*\[P([0-3])\]\s*$/);
  if (bare) { if (priority == null) priority = Number(bare[1]); label = label.slice(0, bare.index).trim(); }
  return { label, priority, purpose };
}

// --- ground-truth scoring (dev / test path) ---------------------------------
// GT-scoring split (legal gate): the ground-truth text is CALLER-SUPPLIED. The
// committed test scores only against Class-B PUBLIC fixtures in
// scripts/fixtures/grouper/. The Class-A claim-derived ground truth
// (ce_anchors.lst, bram_anchors.lst) is gitignored (root `/*.lst`) and stays
// local — never reference it from shipped code or committed tests.
// Resolve a ground-truth anchors.lst (`# Label` + `file@func`) against the index.
export function loadGroundTruth(index, text) {
  index._ensureFunctionIndex?.();
  const groups = []; let cur = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim(); if (!line) continue;
    if (line.startsWith('#')) { cur = { label: line.replace(/^#+/, '').trim(), ids: new Set(), specs: [], unresolved: [] }; groups.push(cur); continue; }
    if (!cur) { cur = { label: '(implicit)', ids: new Set(), specs: [], unresolved: [] }; groups.push(cur); }
    cur.specs.push(line);
    let fileHint = null, funcName = line;
    if (line.includes('@')) { const at = line.lastIndexOf('@'); const before = line.slice(0, at), after = line.slice(at + 1); if (!/^\d+$/.test(after)) { fileHint = before; funcName = after; } }
    const ms = index.findFunctionMatches(funcName, fileHint);
    if (ms && ms.length === 1) cur.ids.add(`${ms[0].filepath}@${ms[0].name}`);
    else cur.unresolved.push(line + (ms && ms.length > 1 ? ' (ambig)' : ' (miss)'));
  }
  return groups.filter((g) => g.ids.size + g.unresolved.length > 0);
}

// For each ground-truth group, find the best-matching candidate cluster and
// compute recall (fraction of the mechanism kept together) + precision (purity).
export function evaluate(clusters, gtGroups) {
  const rows = []; let sumR = 0, sumP = 0, n = 0;
  for (const g of gtGroups) {
    if (g.ids.size === 0) { rows.push({ label: g.label, note: 'no anchors resolved' }); continue; }
    let best = null, bestOv = -1;
    for (const c of clusters) { let ov = 0; for (const id of g.ids) if (c.has(id)) ov++; if (ov > bestOv) { bestOv = ov; best = c; } }
    const recall = bestOv / g.ids.size;
    const precision = best ? bestOv / best.size : 0;
    sumR += recall; sumP += precision; n++;
    rows.push({ label: g.label, resolved: g.ids.size, together: bestOv, clusterSize: best ? best.size : 0, recall, precision });
  }
  return { rows, avgRecall: n ? sumR / n : 0, avgPrecision: n ? sumP / n : 0, scored: n };
}

// Score a grouping result against a ground-truth anchors.lst string.
export function scoreGrouping(index, result, gtText) {
  const gt = loadGroundTruth(index, gtText);
  const ev = evaluate(result.groups.map((g) => g.ids), gt);
  return { ...ev, gtGroups: gt.length };
}
