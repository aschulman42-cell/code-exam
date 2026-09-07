// mechanism-grouper.js — clusters index functions into candidate mechanism groups from token, class, file and command seeds
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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
import { TEXT_EXTENSIONS, splitCompoundToken } from '../utils.js';

export const GROUPER_DEFAULTS = {
  mode: 'multi',        // 'multi' (token+class+optional file) | 'concept' (token-only baseline)
  minLines: 4,          // skip one-liner getters/wrappers
  minComm: 3,           // a real group has >= this many functions
  concepts: 24,         // distinctive concepts seeded (extractConcepts)
  classes: 12,          // top-N substantial classes admitted by the class seed
  overbroadPct: 0.20,   // over-broad by COUNT: a token owning > this fraction of candidates...
  overbroadFileFrac: 0.25, // ...is a namespace ONLY if it also cross-cuts > this fraction of the corpus files
  fileMax: 20,          // 'all' file seed only considers files this small
  // FILE seed: 'doc-header' (default) | 'all' | false. See the note at the seed.
  // Measured 2026-08-28/29: on .CE_082526 default seeds grouped 32% of
  // candidates, + file seed 61% (81 of 91 files); drafted, file-seeded groups
  // gave 50 of 54 genuinely new claims on CE and 140 of 148 on sr_gh at
  // mechanism median 6 -- air-gapping, GGUF, binstrings, one script per
  // experiment: the mechanisms the name-token seeds never group. The C++
  // firehose that kept it opt-in comes from files that are NOT mechanisms
  // (translation units, headers, generated code), and what separates the two
  // is a leading doc comment, not size.
  fileSeed: 'doc-header',
  docHeaderMin: 80,     // chars of header text (markers stripped) for a file to count as doc-headed
  useDocs: false,       // --use-docs (#284 signal-rich gather): doc-inclusive gather vocabulary
  // COMMAND-CATALOG seed, ON BY DEFAULT (--no-catalog-seed opts out).
  //
  // MEASURED on .CE_081726: 41 -> 62 groups, files represented 40/92 (43%) ->
  // 55/92 (60%), and the top file's share of grouped functions FALLS 28% -> 20%.
  // It produces the group that was missing entirely -- `[cmd] --candidates`
  // holding pseudo-claims.js -- plus --claim-chart / --claim-locate /
  // --claim-analyze as four separate mechanisms where token seeding fuses them
  // into one 35-function `claim` blob (asus-CC, #314: all 35 members merely
  // contain the SUBSTRING "claim", including _printDisclaimer).
  //
  // Safe to default because it is an EXACT NO-OP where there is no command
  // surface: .sr_gh (Python RL research) and .dspy both produce 0 [cmd] groups
  // and byte-identical output. "Group by command" is only meaningful for a
  // codebase that has commands.
  catalogSeed: true,
  // Bound on [cmd] groups, mirroring `classes`. The seed previously iterated
  // EVERY cli option, so a codebase with a very large command surface could
  // emit one group per command -- the over-proliferation risk that otherwise
  // blocks defaulting this on. Commands are taken biggest-mechanism-first, so
  // the cap drops the thinnest ones.
  catalogMax: 24,
  literalSeed: false,   // --literal-seed (#289): rare-shared-literal seed on the residue
  minLitLen: 8,         // literal seed: minimum literal length considered
  maxLitSpread: 10,     // literal seed: a literal in more containing functions than this is too common to seed
  bodyMatchSeed: false, // --body-match-seed (#289): body-containment rescue for name-match-failed cutoff tokens
  maxBodySpread: 16,    // body-match seed: a token body-matching more candidate functions than this is too common
  maxFuncs: Infinity,   // cap candidates on huge indexes (0/Infinity = no cap)
  // A group larger than this is re-grouped over its own members before it is
  // emitted. MEASURED on the sr_gh run (23 groups, both drafting passes): a
  // group over 15 functions gets 34% of its functions cited by the claim
  // drafted from it; a group of 15 or fewer gets 85%. A 46-function group
  // yields a claim citing ~8 of them -- the other 38 were packed, sent to the
  // model and paid for, and produced nothing citable.
  //
  // NOT a claim-LENGTH control: correlation(group size, claim length) measured
  // 0.12, so splitting does not and is not meant to shorten claims. Length is
  // governed by the drafting prompt (see PSEUDO_CLAIM_GENERATE_SYS, 9d453489).
  // 0 or Infinity disables splitting and reproduces pre-split behaviour.
  groupMax: 15,
  // A split whose largest part is at least this share of the parent has not
  // divided anything -- it peeled off one small group and relabelled the rest.
  splitMaxShare: 0.8,
  splitMaxDepth: 2,     // recursion bound; anything still oversized is reported, not looped on
};

// Per-file sorted candidate ranges + line -> containing-candidate lookup,
// shared by the literal and body-match seeds (line-range bucketing avoids
// name-format drift between the string table / raw lines and functionIndex keys).
function buildFuncRanges(funcs) {
  const ranges = new Map();
  for (const f of funcs) (ranges.get(f.file) || ranges.set(f.file, []).get(f.file)).push(f);
  for (const arr of ranges.values()) arr.sort((a, b) => a.start - b.start);
  return ranges;
}
function containingFunc(ranges, file, line) {
  const arr = ranges.get(file);
  if (!arr) return null;
  let lo = 0, hi = arr.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid].start <= line) { best = arr[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best && line <= best.end ? best : null;
}

// Concepts for the token seeds. Default: the cached code-only vocabulary via
// extractConcepts. With `useDocs` (#284 signal-rich gather), build a
// doc-INCLUSIVE vocabulary (uncached, cache untouched — see
// buildDocInclusiveVocabulary) and inject its top entries, so doc-borne
// feature terms compete for the same top-N concept cutoff as code tokens —
// included, not promoted. Fail-open: any error yields no token seeds and the
// class/catalog/file seeds still run (stub indexes in tests take this path).
function gatherConcepts(index, o) {
  try {
    if (Array.isArray(o.conceptsList)) return o.conceptsList; // injectable for tests (extractConcepts precedent)
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

// #291 Part A: a candidate whose declaration is preceded by a test attribute
// (Rust `#[test]` / `#[tokio::test]` / a `#[cfg(test)]` opener in the small
// attribute stack directly above it) is an inline TEST function — the
// file-level noise filter can't see test modules living inside lib.rs, which
// is how 46 scope-leaked test fns (#287 family) became a candidate "class"
// and then a drafted claim on writing tests (the Bram field test, #291).
// Window = the declaration line plus 3 lines above; heuristic and
// Rust-focused by design (JS it()/describe() anonymity is out of scope).
function isTestAttributedFunction(lines, startLine) {
  for (let i = Math.max(0, startLine - 4); i < Math.min(lines.length, startLine); i++) {
    const t = String(lines[i] || '').trim();
    if (/^#\[(?:\w+(?:::\w+)*::)?test(?:\]|\()/.test(t) || /^#\[cfg\(test\)\]/.test(t)) return true;
  }
  return false;
}

// --- third-party subtree detection (candidates-claim-worthiness) -------------
// Candidate discovery answers a PROXY for the question it is asked: the user
// wants "which parts of this codebase are claim-worthy", the grouper answers
// "which parts have distinctive vocabulary". Those diverge worst on vendored
// code. MEASURED on .sr_gh: 98 of 156 grounded anchors (63%) landed in
// `faithful-cot-main/train/verl/`, a vendored copy of ByteDance's verl RL
// framework -- so 23 claims about a chain-of-thought-faithfulness repo were
// about PPO batching and FSDP sharding instead. For patent work that is not a
// ranking imperfection but a WRONG ANSWER: not the client's invention, the most
// likely thing to be prior art, and the most likely to be memorized by any
// model used downstream.
//
// EVERY OBVIOUS SIGNAL WAS REFUTED BY MEASUREMENT BEFORE THIS WAS WRITTEN:
//   - PATH NAMES (node_modules/, vendor/, third_party/) miss the actual case:
//     `train/verl/` is not a conventional vendor directory name.
//   - "HOLDER DIFFERS FROM THE PROJECT'S DOMINANT HOLDER" -- the mechanism this
//     item was approved with -- is BACKWARDS here. 381 of 449 headered files in
//     .sr_gh say Bytedance, so ByteDance IS the dominant holder; that rule would
//     have excluded the research code and kept verl.
//   - COPYRIGHT ALONE is absent where it is most needed: .CE_081726 carries 0
//     copyright headers across 159 files.
//   - A NESTED PACKAGE MANIFEST ALONE over-triggers: .sr_gh's
//     `w2s_research/web_ui/frontend/package.json` is the project's own sub-app.
//
// WHAT WORKS is the conjunction: a NESTED package root that has its OWN
// dominant copyright holder. On .sr_gh that flags exactly
// `faithful-cot-main/train` (Bytedance, 381/449 headered) and leaves the
// frontend alone; on .CE_081726 it flags nothing, which is correct.
//
// The share is over files that CARRY a header, not all files: 866 files sit
// under `train/` but only 449 are headered, and the wrong denominator puts a
// genuine 85% detection at 44% and misses it.
const VENDOR_MANIFEST = /^(setup[.]py|pyproject[.]toml|package[.]json|Cargo[.]toml|go[.]mod|composer[.]json|Gemfile)$/i;
const COPYRIGHT_RE = /copyright\s*(?:[(][cC][)]|[©])?\s*(?:\d{4}(?:\s*[-,]\s*\d{4})?)?\s*(?:by\s+)?([^\n\r*#/]{3,60})/i;

// Copyright holder from a file's first 25 lines, or null. Trailing boilerplate
// ("and/or its affiliates", "All rights reserved") is trimmed so the same
// company does not split into several holders.
export function copyrightHolder(lines) {
  const m = COPYRIGHT_RE.exec((lines || []).slice(0, 25).join('\n'));
  if (!m) return null;
  // The capture class excludes '/', so "Bytedance Ltd. and/or its affiliates"
  // arrives already truncated to "Bytedance Ltd. and" -- a dangling conjunction
  // that reached the candidates-file header before a test caught it. Strip the
  // boilerplate, THEN the orphaned conjunction, THEN trailing punctuation.
  const h = m[1].trim().replace(/\s+/g, ' ')
    .replace(/\s+(and[/]or its affiliates|All rights reserved).*$/i, '')
    .replace(/[\s.,]+(and|&|et al)\.?$/i, '')
    .replace(/[.,;:]+$/, '').trim();
  return (!h || /^\d+$/.test(h)) ? null : h;
}

export function detectVendoredSubtrees(index, o = {}) {
  const minHeadered = o.vendorMinHeadered == null ? 3 : o.vendorMinHeadered;
  const share = o.vendorHolderShare == null ? 0.5 : o.vendorHolderShare;
  const files = [];
  try { for (const k of index.fileLines.keys()) files.push(k); } catch { return []; }
  const norm = (s) => String(s).split(String.fromCharCode(92)).join('/');
  const roots = new Set();
  for (const f of files) {
    const n = norm(f);
    const slash = n.lastIndexOf('/');
    if (slash < 0) continue;             // a manifest at the index root IS the project
    if (VENDOR_MANIFEST.test(n.slice(slash + 1))) roots.add(n.slice(0, slash));
  }
  const out = [];
  for (const root of roots) {
    const under = files.filter((f) => norm(f).startsWith(root + '/'));
    if (!under.length) continue;
    const holders = new Map();
    for (const f of under) {
      const h = copyrightHolder(index.fileLines.get(f));
      if (h) holders.set(h, (holders.get(h) || 0) + 1);
    }
    const headered = [...holders.values()].reduce((a, b) => a + b, 0);
    // ABSENCE OF THE SIGNAL IS NOT EVIDENCE OF THIRD-PARTY ORIGIN. A subtree
    // with no copyright headers is left alone, which is why .CE_081726 (0
    // headers) excludes nothing.
    if (headered < minHeadered) continue;
    const top = [...holders.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] / headered < share) continue;
    out.push({ root, holder: top[0], holderFiles: top[1], headered, files: under.length });
  }
  return out.sort((a, b) => b.root.length - a.root.length);
}

export function isUnderVendored(file, vendored) {
  if (!vendored || !vendored.length) return null;
  const n = String(file).split(String.fromCharCode(92)).join('/');
  for (const v of vendored) if (n.startsWith(v.root + '/')) return v;
  return null;
}

// Enumerate candidate functions from the index's functionIndex: skip noise files,
// class-declaration entries, intrinsics, sub-MIN_LINES one-liners, and
// test-attributed inline test functions (#291 Part A). Returns the candidate
// list + a byId map + the noise-file/function counts (+ testFns dropped).
export function enumerateFuncs(index, opts = {}) {
  const o = { ...GROUPER_DEFAULTS, ...opts };
  index._ensureFunctionIndex?.();
  const funcs = [];
  const byId = new Map();
  let noiseFiles = 0, noiseFns = 0, testFns = 0, vendorFiles = 0, vendorFns = 0;
  // Third-party subtrees are excluded from CANDIDATE DISCOVERY, not from the
  // index -- search, digest and every other command still see them. Only the
  // question "what might be claim-worthy here" is scoped to the project's own
  // code, and `--include-vendored` puts them back.
  const vendored = o.includeVendored ? [] : detectVendoredSubtrees(index, o);
  for (const [file, fns] of Object.entries(index.functionIndex || {})) {
    if (isUnderVendored(file, vendored)) { vendorFiles++; vendorFns += Object.keys(fns).length; continue; }
    if (isNoiseFile(file)) { noiseFiles++; noiseFns += Object.keys(fns).length; continue; }
    const fileLines = (index.fileLines && typeof index.fileLines.get === 'function') ? index.fileLines.get(file) : null;
    for (const [full, info] of Object.entries(fns)) {
      if ((info.type || 'function') === 'class') continue;
      const bare = (info.base_name || full.split('::').pop() || '').split('@')[0];
      if (!bare || isIntrinsicName(bare)) continue;
      const lines = (info.end || 0) - (info.start || 0) + 1;
      if (lines < o.minLines) continue;
      if (Array.isArray(fileLines) && isTestAttributedFunction(fileLines, info.start || 0)) { testFns++; continue; }
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
  return { funcs, byId, noiseFiles, noiseFns, testFns, vendored, vendorFiles, vendorFns };
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
  // Same shape as multiSeedGroups so the single call site stays one expression.
  // The concept path runs no catalog seed, hence zeroes.
  return {
    groups: [...groups.entries()].filter(([, ids]) => ids.size >= o.minComm).map(([tok, ids]) => ({ label: label.get(tok) || tok, ids })),
    stats: { catalogMade: 0, catalogCapped: 0 },
  };
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
  // Rescue bookkeeping (--body-match-seed): which cutoff tokens were rejected
  // as namespaces (never rescued) and which name-matched members each kept
  // token claimed. A token whose name members stay below minComm produces a
  // group the FINAL filter silently drops — its members are assigned-but-
  // orphaned, and the body-match rescue reclaims them.
  const overBroad = new Set();
  const tokenNameMembers = new Map(); // token -> Set(funcId)
  for (const [t, ids] of tokGroups) {
    const fileCount = new Set([...ids].map((id) => fileOf.get(id))).size;
    if (isOverBroadNamespace(ids.size, cap, fileCount, spreadCap)) { overBroad.add(t); continue; } // namespace/prefix -> funcs fall through
    tokenNameMembers.set(t, ids);
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
  let catalogCapped = 0, catalogMade = 0;
  if (o.catalogSeed) {
    let cliOptions = [];
    try { cliOptions = (extractCommandCatalog(index, false) || {}).cliOptions || []; } catch { /* */ }
    // Biggest mechanism first, so a cap drops the thinnest commands rather than
    // whichever happened to appear last in the catalog. Deterministic tiebreak
    // on the flag: two runs of --candidates must produce the same file.
    const ranked = cliOptions
      .map((opt) => ({ opt, n: ((opt.handler && opt.handler.callees) || []).length }))
      .sort((a, b) => b.n - a.n
        || String((a.opt.flags || [])[0] || a.opt.name).localeCompare(String((b.opt.flags || [])[0] || b.opt.name)))
      .map((x) => x.opt);
    catalogMade = 0;
    for (const opt of ranked) {
      if (o.catalogMax && catalogMade >= o.catalogMax) { catalogCapped += 1; continue; }
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
      catalogMade += 1;
    }
  }

  // 4) LITERAL seed (OPT-IN --literal-seed, issue-289-literal-seed) — functions
  // sharing a RARE string literal cluster into a group on the unassigned
  // residue. What connects a cross-file feature when names and catalogs don't
  // is its literals (error messages, banners, keys) — language-agnostic, and
  // membership comes from CONTAINING the literal, not from the function name
  // matching a token, so the token seed's member-math blockers don't apply.
  // The minimal one-hop slice of #185 seed-search: no identifier flow (a
  // literal counts where it is WRITTEN — `var xyz = "s"` used thrice is ONE
  // occurrence), no call edges, no frontier. Rarity bounds: a seed literal
  // lives in 2..maxLitSpread candidate functions, is >= minLitLen chars, and
  // has at least one real word. Assigned functions do NOT conduct: clusters
  // union only unassigned members, so prior seeds' groups stay untouched.
  // Fail-open: an index without ensureStringTable contributes nothing.
  if (o.literalSeed) {
    let table = [];
    try { table = index.ensureStringTable?.(o.minLitLen, false) || []; } catch { /* */ }
    const ranges = buildFuncRanges(funcs);
    const hasWord = /[A-Za-z]{4,}/;
    const seedLits = [];
    for (const e of table) {
      const val = String((e && e.value) ?? '');
      if (val.length < o.minLitLen || !hasWord.test(val)) continue;
      if (!Array.isArray(e.locations) || e.locations.length < 2) continue;
      if (e.count > o.maxLitSpread * 3) continue; // locations are capped (20); a huge count is common regardless
      const members = new Set();
      for (const loc of e.locations) { const f = containingFunc(ranges, loc.filepath, loc.line); if (f) members.add(f.id); }
      if (members.size < 2 || members.size > o.maxLitSpread) continue;
      const un = [...members].filter((id) => !assigned.has(id));
      if (un.length >= 2) seedLits.push({ val, ids: un, spread: members.size });
    }
    // Union-find over unassigned members; a component >= minComm becomes a group.
    const parent = new Map();
    const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); let c = x; while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
    for (const s of seedLits) for (const id of s.ids) if (!parent.has(id)) parent.set(id, id);
    for (const s of seedLits) { const root = find(s.ids[0]); for (const id of s.ids.slice(1)) parent.set(find(id), root); }
    const comps = new Map(); // root -> { ids:Set, lits:[] }
    for (const id of parent.keys()) { const r = find(id); (comps.get(r) || comps.set(r, { ids: new Set(), lits: [] }).get(r)).ids.add(id); }
    for (const s of seedLits) comps.get(find(s.ids[0])).lits.push(s);
    for (const c of comps.values()) {
      if (c.ids.size < o.minComm) continue;
      // SNOWBALL guard: transitive closure can chain template-literal
      // copy-paste into a residue-swallowing blob (first CE run: one 247-fn
      // component). A component far larger than any single literal's allowed
      // spread is incoherent-by-construction — REJECT it outright (dropping,
      // not truncating: there is no principled member subset to keep).
      if (c.ids.size > o.maxLitSpread * 3) continue;
      // Label by the most distinctive shared literal: rarest spread, then longest.
      const best = c.lits.sort((a, b) => a.spread - b.spread || b.val.length - a.val.length)[0];
      const short = best.val.replace(/\s+/g, ' ').trim().slice(0, 40);
      const lbl = `[lit] "${short}${best.val.length > 40 ? '…' : ''}"`;
      for (const id of c.ids) assigned.set(id, lbl);
    }
  }

  // 5) BODY-MATCH rescue (OPT-IN --body-match-seed, issue-289-body-match-token-seed)
  // — for cutoff concept tokens the NAME-match failed (< minComm name members;
  // includes zero), retry membership by BODY containment: identifiers, call
  // sites, and string contents all count, which is the air-gap feature shape
  // (a cutoff-worthy token spread across bodies in several files while too few
  // function NAMES carry it — the gap both prior seeds missed, each for a
  // different reason; see ffd333b). RESCUE-ONLY: tokens that formed a real
  // name group never enter (so `rect` body-noise — 'direct', 'correction' —
  // can't), and over-broad namespace rejections stay rejected. Membership =
  // unassigned residue PLUS the token's own assigned-but-orphaned sub-minComm
  // name members (headed for the final filter's silent drop otherwise).
  // Firehose control: a token body-matching more than maxBodySpread candidate
  // functions in TOTAL is rejected outright. Fail-open: no fileLines, no rescue.
  if (o.bodyMatchSeed) {
    const rescueTokens = tokens.filter((t) => !overBroad.has(t) && (tokenNameMembers.get(t)?.size ?? 0) < o.minComm);
    const fl = index.fileLines;
    if (rescueTokens.length && fl && typeof fl.entries === 'function') {
      const ranges = buildFuncRanges(funcs);
      const hits = new Map(); // token -> Set(funcId), ALL candidate hits (assigned or not)
      for (const [file, lines] of fl) {
        const arr = ranges.get(file);
        if (!arr || !Array.isArray(lines)) continue;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line) continue;
          const lc = line.toLowerCase();
          for (const t of rescueTokens) {
            if (!lc.includes(t)) continue;
            const f = containingFunc(ranges, file, i + 1);
            if (f) (hits.get(t) || hits.set(t, new Set()).get(t)).add(f.id);
          }
        }
      }
      for (const t of rescueTokens) {
        const all = hits.get(t);
        if (!all || all.size > o.maxBodySpread) continue; // too common in bodies -> reject, don't truncate
        const own = tokenNameMembers.get(t) || new Set();
        const members = [...all].filter((id) => !assigned.has(id) || own.has(id));
        if (members.length < o.minComm) continue;
        for (const id of members) assigned.set(id, `[body] ${tlabel.get(t) || t}`);
      }
    }
  }

  // 6) FILE seed (OPT-IN) — a SMALL file whose leftover (unassigned) functions are
  // its MAJORITY is one cohesive mechanism (scattered names token+class miss).
  // FILE seed. Residual file-cohesion can't tell a distinctive mechanism from
  // an ordinary module or a codec kernel file by itself, so as an ALL-files
  // seed it firehoses on C++ (~50 file-groups) and stayed opt-in. What it
  // finds where a codebase is organised one-mechanism-per-module is exactly
  // what the name-token seeds cannot (candidate-file-seed-doc-header,
  // 2026-08-29: air-gapped.js, llm-runner.js, ai-overview-local.js on CE; one
  // script per experiment on sr_gh). The gate that separates the two cases is
  // whether the file opens with a comment saying what the module is for --
  // 'doc-header' mode: any size, doc-headed files only, license-only headers
  // rejected, every skip counted. 'all' is the old size-gated behaviour.
  const fileSeedMode = o.fileSeed === true ? 'all' : (o.fileSeed || false);
  let fileSeeded = 0, fileNoHeader = 0, fileLicenseOnly = 0, fileTooBig = 0;
  if (fileSeedMode) {
    const byFileU = new Map();
    for (const f of funcs) { const e = byFileU.get(f.file) || byFileU.set(f.file, { total: 0, un: [] }).get(f.file); e.total++; if (!assigned.has(f.id)) e.un.push(f.id); }
    const base = (fp) => { const s = String(fp).replace(/\\/g, '/'); return s.slice(s.lastIndexOf('/') + 1); };
    const linesOf = (file) => (index && index.fileLines && typeof index.fileLines.get === 'function') ? index.fileLines.get(file) : null;
    for (const [file, e] of byFileU) {
      if (!(e.un.length >= o.minComm && e.un.length * 2 >= e.total)) continue;
      if (fileSeedMode === 'all') {
        if (e.total > o.fileMax) { fileTooBig++; continue; }
      } else {
        const h = docHeaderOf(linesOf(file), { min: o.docHeaderMin });
        if (h.kind === 'license') { fileLicenseOnly++; continue; }
        if (h.kind !== 'doc') { fileNoHeader++; continue; }
      }
      for (const id of e.un) assigned.set(id, `[file] ${base(file)}`);
      fileSeeded++;
    }
  }

  const groups = new Map();
  for (const [id, lbl] of assigned) (groups.get(lbl) || groups.set(lbl, new Set()).get(lbl)).add(id);
  // RETURN STATS ALONGSIDE THE GROUPS. `catalogCapped` was previously
  // incremented and never read -- a dead store, because this returned a bare
  // array and the count could not reach groupMechanisms or formatAnchors. The
  // cap it records is the one bound in the candidates header that was silent,
  // and it is the bound most likely to be doing real work unobserved: it exists
  // BECAUSE the large-command-surface corpora (.langchain 98M, .CC_cli_js_3
  // 84M) both blew a 10-minute grouping budget and went unsampled.
  return {
    groups: [...groups.entries()].filter(([, ids]) => ids.size >= o.minComm).map(([lbl, ids]) => ({ label: lbl, ids })),
    stats: { catalogMade, catalogCapped, fileSeedMode, fileSeeded, fileNoHeader, fileLicenseOnly, fileTooBig },
  };
}

// --- doc header detection (candidate-file-seed-doc-header) -------------------
//
// A file's LEADING comment, when it reads as a description of the module:
// `/** ... */` or `/* ... */`, a run of `//` or `#` lines, a Python/Ruby
// docstring, or `<!-- -->`, ending at the first code line. License / copyright
// headers are recognised and returned as `kind: 'license'` so the caller can
// count them apart from "no header at all" -- a license block is the most
// common leading comment in third-party code and says nothing about the
// module. Shebangs, encoding lines and `'use strict'` are skipped first.
const LICENSE_RE = /\b(copyright|\(c\)\s*\d{4}|licen[cs]ed? (?:under|to)|apache license|mit license|gnu (?:general|lesser)|spdx-license|all rights reserved|permission is hereby granted|redistribution and use|warranty|as-is)\b/i;

export function docHeaderOf(lines, { min = GROUPER_DEFAULTS.docHeaderMin } = {}) {
  if (!Array.isArray(lines) || !lines.length) return { kind: 'none', text: '', chars: 0 };
  let i = 0;
  const skip = (l) => /^\s*$/.test(l) || /^#!/.test(l) || /^\s*#\s*-\*-.*-\*-\s*$/.test(l) || /^\s*['"]use strict['"];?\s*$/.test(l);
  while (i < lines.length && skip(lines[i])) i++;
  if (i >= lines.length) return { kind: 'none', text: '', chars: 0 };
  const first = String(lines[i]);
  const body = [];
  if (/^\s*\/\*/.test(first)) {                                  // block comment
    for (; i < lines.length; i++) { const l = String(lines[i]); body.push(l.replace(/^\s*\/\*+/, '').replace(/\*+\/.*$/, '').replace(/^\s*\*\s?/, '')); if (/\*\//.test(l)) break; }
  } else if (/^\s*<!--/.test(first)) {
    for (; i < lines.length; i++) { const l = String(lines[i]); body.push(l.replace(/^\s*<!--\s?/, '').replace(/-->.*$/, '')); if (/-->/.test(l)) break; }
  } else if (/^\s*("""|''')/.test(first)) {                        // docstring
    const q = first.match(/("""|''')/)[1];
    let l = first.replace(/^\s*("""|''')/, ''); let closed = l.includes(q);
    body.push(l.replace(q, ''));
    for (i++; !closed && i < lines.length; i++) { l = String(lines[i]); closed = l.includes(q); body.push(l.replace(q, '')); }
  } else if (/^\s*(\/\/|#|--)/.test(first)) {                      // line-comment run
    const mark = first.match(/^\s*(\/\/|#|--)/)[1];
    for (; i < lines.length; i++) { const l = String(lines[i]); if (!new RegExp('^\\s*' + mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(l)) break; body.push(l.replace(new RegExp('^\\s*' + mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s?'), '')); }
  } else {
    return { kind: 'none', text: '', chars: 0 };
  }
  const text = body.map((s) => s.replace(/^[\s=\-#*]+$/, '').trim()).filter(Boolean).join(' ');
  const licenseLines = body.filter((s) => LICENSE_RE.test(s)).length;
  const descriptive = body.filter((s) => s.trim() && !LICENSE_RE.test(s) && !/^[\s=\-#*]+$/.test(s)).join(' ').trim();
  if (descriptive.length >= min) return { kind: 'doc', text, chars: descriptive.length };
  if (licenseLines) return { kind: 'license', text, chars: descriptive.length };
  return { kind: 'none', text, chars: descriptive.length };
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

// Identifier sub-tokens of a member's own name: snake_case and camelCase both,
// leading underscores stripped, 3+ chars. `_build_lr_scheduler` ->
// [build, scheduler]; `forwardBackwardBatch` -> [forward, backward, batch].
export function subTokens(name) {
  return String(name || '')
    .replace(/^_+/, '')
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 3 && !SUBTOKEN_STOP.has(t));
}
// Generic enough to group functions that share nothing but a calling
// convention. Deliberately short: the frequency bounds below do most of the
// filtering, and an over-eager stop list would suppress real mechanisms
// (`init`, `run`, `load` can all be the substance of a limitation).
const SUBTOKEN_STOP = new Set(['get', 'set', 'the', 'for', 'and', 'not', 'self', 'this', 'str', 'obj']);

// PARTITION an oversized group on the LOCAL vocabulary of its own member names.
//
// The first implementation re-ran `groupMechanisms` over the group's members
// and split nothing: 15 of 15 oversized sr_gh groups came back `indivisible`,
// and disabling the class seed did not help. The reason is near-tautological --
// re-running a clustering algorithm over one of its own output clusters
// reproduces that cluster, because the features that made those functions
// group together are still their dominant shared features. `reward
// (use_kl_in_reward)` re-grouped on the corpus vocabulary gives back `reward`.
//
// Local sub-tokens are a DIFFERENT feature space, and one the parent grouping
// did not use. MEASURED on the groups that defeated recursion:
//   [class] RayPPOTrainer (33) -> generations(4) batch(4) checkpoint(4) profiling(4)
//   rollout (41)               -> weights(7) sync(6) actor(5) compute(5) async(4)
//   [class] DataProto (24)     -> from(4) get(3)   -- too weak, correctly declines
//
// Chunking by declaration order was rejected and stays rejected: methods 1-11
// of a class are not a mechanism, and a claim drafted from them reads as
// incoherent to exactly the audience that matters. A group that will not divide
// is emitted INTACT.
export function subTokenPartition(group, o) {
  const members = group.members;
  const freq = new Map();
  const memberToks = new Map();
  for (const m of members) {
    const ts = new Set(subTokens(m.bare || m.name || ''));
    memberToks.set(m.id, ts);
    for (const t of ts) freq.set(t, (freq.get(t) || 0) + 1);
  }
  // A token in nearly every member does not discriminate (it is what makes this
  // one group); a token in fewer than minComm cannot carry a group of its own.
  const ceiling = Math.max(o.minComm, Math.floor(members.length * 0.9));
  const seeds = [...freq.entries()]
    .filter(([, n]) => n >= o.minComm && n < ceiling)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!seeds.length) return [];

  // Assign each member to its highest-frequency qualifying seed, so sub-groups
  // reach minComm rather than shattering into pairs. Ties break alphabetically
  // for determinism -- two runs of --candidates must produce the same file.
  const bySeed = new Map();
  for (const m of members) {
    const ts = memberToks.get(m.id);
    const hit = seeds.find(([t]) => ts.has(t));
    if (!hit) continue;
    if (!bySeed.has(hit[0])) bySeed.set(hit[0], []);
    bySeed.get(hit[0]).push(m);
  }
  const out = [...bySeed.entries()]
    .filter(([, ms]) => ms.length >= o.minComm)
    .map(([t, ms]) => ({ label: t, members: ms }))
    .sort((a, b) => b.members.length - a.members.length);
  if (!out.length) return [];

  // ORPHANS GO TO A RESIDUAL SUB-GROUP, they are not discarded. The first cut
  // rejected any split leaving >40% of members unassigned, on the reasoning
  // that a split orphaning half its members defeats a coverage fix -- true only
  // if the orphans are dropped. Keeping them costs nothing and turns four
  // rejected splits into accepted ones (RayPPOTrainer 58%, ActorRolloutRefWorker
  // 57%, RayWorkerGroup 56%, LiberoEnv 47% coverage on the sr_gh run).
  //
  // `/ other` is honestly named: it is the leftovers, not a mechanism, and a
  // reader hand-pruning the candidates should be able to see that and delete it.
  const claimed = new Set(out.flatMap((g) => g.members.map((m) => m.id)));
  const rest = members.filter((m) => !claimed.has(m.id));
  if (rest.length >= o.minComm) {
    out.push({ label: 'other', members: rest });
  } else if (rest.length) {
    // TOO FEW ORPHANS TO FORM A GROUP, so they join the smallest sub-group
    // rather than being dropped. Caught by a test asserting every member of a
    // split parent survives somewhere: a straggler below minComm was silently
    // discarded, which would have made the split REDUCE coverage for exactly
    // the functions it failed to cluster -- the opposite of this feature's
    // purpose, and invisible because the group counts still looked right.
    out[out.length - 1].members.push(...rest);
  }
  return out;
}

// Returns { groups, split } -- `split` records what happened for the report,
// because silently restructuring the candidate list would make two runs
// incomparable with no visible cause.
export function splitOversizedGroup(index, group, byId, o, depth = 1) {
  const max = o.groupMax;
  if (!max || !Number.isFinite(max) || group.members.length <= max) {
    return { groups: [group], split: null };
  }
  if (depth > o.splitMaxDepth) {
    return { groups: [group], split: { label: group.label, n: group.members.length, reason: 'depth-cap' } };
  }
  const rebuilt = subTokenPartition(group, o)
    .map((g) => ({
      label: `${group.label} / ${g.label}`,
      ids: new Set(g.members.map((m) => m.id)),
      members: g.members,
    }))
    .filter((g) => g.members.length > 0);

  // Reject a split that did not actually divide. Coverage is no longer a
  // rejection reason -- orphans ride in the residual sub-group, so it is always
  // 100% -- but the ratio is still reported, since a split that is mostly
  // residual is a weak one a hand-pruner may want to undo.
  const covered = new Set(rebuilt.flatMap((g) => [...g.ids])).size;
  const coverage = covered / group.members.length;
  const biggest = rebuilt.reduce((n, g) => Math.max(n, g.members.length), 0);
  const seeded = rebuilt.filter((g) => !g.label.endsWith(' / other'))
    .reduce((n, g) => n + g.members.length, 0) / group.members.length;
  let reason = null;
  if (rebuilt.length < 2) reason = 'indivisible';
  // A "split" whose largest part is nearly the whole parent has not divided
  // anything -- it has peeled off one small group and relabelled the rest.
  else if (biggest >= group.members.length * o.splitMaxShare) reason = 'no-reduction';
  if (reason) {
    return { groups: [group], split: { label: group.label, n: group.members.length, reason } };
  }

  // Recurse into any sub-group still oversized.
  const out = [], nested = [];
  for (const g of rebuilt) {
    const r = splitOversizedGroup(index, g, byId, o, depth + 1);
    out.push(...r.groups);
    if (r.split) nested.push(r.split);
  }
  return {
    groups: out,
    split: {
      label: group.label, n: group.members.length,
      into: out.map((g) => ({ label: g.label, n: g.members.length })),
      coverage, seeded, nested,
    },
  };
}

// Group an index's functions into candidate mechanism groups. Returns
// { groups: [{label, ids:Set, members:[func]}], funcs, byId, noiseFiles, noiseFns, mode, splits }.
export function groupMechanisms(index, opts = {}) {
  const o = { ...GROUPER_DEFAULTS, ...opts };
  const { funcs, byId, noiseFiles, noiseFns, vendored, vendorFiles, vendorFns } = enumerateFuncs(index, o);
  const seeded = o.mode === 'concept' ? conceptSeededGroups(index, funcs, o) : multiSeedGroups(index, funcs, o);
  const raw = seeded.groups;
  const built = raw
    .map((g) => {
      // Filter junk members, then rebuild ids from the survivors so emit,
      // members, and ids (the scoring path) stay consistent.
      const members = filterMembers(index, [...g.ids].map((id) => byId.get(id)).filter(Boolean));
      return { label: g.label, ids: new Set(members.map((m) => m.id)), members };
    })
    .filter((g) => g.members.length > 0); // a group whose anchors were all junk is dropped

  const groups = [], splits = [];
  for (const g of built) {
    const r = splitOversizedGroup(index, g, byId, o);
    groups.push(...r.groups);
    if (r.split) splits.push(r.split);
  }
  groups.sort((a, b) => b.ids.size - a.ids.size);
  return { groups, funcs, byId, noiseFiles, noiseFns, mode: o.mode, splits, vendored, vendorFiles, vendorFns, ...seeded.stats };
}

// --- doc-anchor enrichment (issue-289-doc-anchor-enrichment) -----------------
// Attach the best-matching DOC sections to each emitted group as
// `path@L<start>-<end>` anchors (the issue-286 grammar), so documentation
// rides into the evidence pack and the claim chart as citable disclosure.
// ENRICHMENT ONLY: decorates groups the grouper found; it cannot conjure a
// missing group (that is the deferred doc-mention seed, #289/#185).

// Split a doc file's lines into heading-bounded sections
// [{start, end, heading}] (1-based, inclusive): a `#`..`###` heading up to the
// next same-or-higher heading, capped at `cap` lines; sections under 3 lines
// are skipped. Exported for tests.
export function splitDocSections(lines, cap = 120) {
  const heads = [];
  for (let i = 0; i < (lines || []).length; i++) {
    const m = /^(#{1,3})\s/.exec(lines[i] || '');
    if (m) heads.push({ line: i + 1, level: m[1].length, text: String(lines[i]).trim() });
  }
  const sections = [];
  for (let h = 0; h < heads.length; h++) {
    let end = lines.length;
    for (let j = h + 1; j < heads.length; j++) {
      if (heads[j].level <= heads[h].level) { end = heads[j].line - 1; break; }
    }
    end = Math.min(end, heads[h].line + cap - 1);
    if (end - heads[h].line + 1 >= 3) sections.push({ start: heads[h].line, end, heading: heads[h].text });
  }
  return sections;
}

// A group's topic tokens for doc matching: the CONCEPT token (from the label —
// weighted, and also matched against a punctuation-stripped view of each line
// so `aiml` finds "AI/ML") plus the namesake example and the first few member
// bare names (plain substring, weight 1).
function groupTopicTokens(label, members) {
  const raw = String(label || '');
  const lc = raw.toLowerCase();
  const tokens = [];
  const mClass = raw.match(/^\[class\]\s+_*(\w+)/);
  const mCmd = lc.match(/^\[cmd\]\s+--?([\w-]+)/);
  const mBody = lc.match(/^\[body\]\s+([a-z0-9_-]+)/);
  const mLit = lc.match(/^\[lit\]\s+"(.{4,40}?)"/);
  const mTok = lc.match(/^([a-z0-9_-]+)\s*\(/);
  const conceptRaw = mClass ? mClass[1] : mCmd ? mCmd[1] : mBody ? mBody[1] : mLit ? mLit[1] : mTok ? mTok[1] : raw.split(/\s+/)[0];
  const conceptLc = String(conceptRaw || '').toLowerCase();
  if (conceptLc.length >= 3) tokens.push({ t: conceptLc, w: 3, concept: true });
  // Sub-parts of a compound concept count as concept evidence at lower weight
  // (with the normalized-line check) so a class-shaped concept like
  // AIMLMethods can meet a doc that spells it "AI/ML".
  try {
    for (const part of (splitCompoundToken(conceptRaw || '') || []).slice(0, 3)) {
      const p = String(part).toLowerCase();
      if (p.length >= 4 && p !== conceptLc) tokens.push({ t: p, w: 2, concept: true });
    }
  } catch { /* sub-parts are optional */ }
  const ex = lc.match(/\(([^)]+)\)\s*$/);
  if (ex && ex[1] && ex[1].length >= 4 && !mCmd) tokens.push({ t: ex[1], w: 1, concept: false });
  for (const m of (members || []).slice(0, 8)) {
    const b = String(m.bare || '').toLowerCase();
    if (b.length >= 4) tokens.push({ t: b, w: 1, concept: false });
  }
  return tokens;
}

// Attach the best-matching doc sections for a group, as emitted anchor lines.
// Scoring: weighted per-line substring hits over the section (+ its filename);
// a section qualifies only when the CONCEPT token itself matched (member-name
// hits alone can't attach a doc) and the weighted score clears `docMinScore`.
// Top `docMaxAnchors` sections win, distinct files preferred. Fail-open: no
// fileLines, no docs, or nothing qualifying -> []. Exported for tests and for
// the --rank emit path.
export function docAnchorsForGroup(index, label, members, o = {}) {
  const minScore = o.docMinScore ?? 6;
  const maxAnchors = o.docMaxAnchors ?? 2;
  const fl = index && index.fileLines;
  if (!fl || typeof fl.entries !== 'function') return [];
  const tokens = groupTopicTokens(label, members);
  if (!tokens.some((t) => t.concept)) return [];
  const candidates = [];
  for (const [file, lines] of fl) {
    const dot = String(file).lastIndexOf('.');
    const ext = dot >= 0 ? String(file).slice(dot).toLowerCase() : '';
    if (!TEXT_EXTENSIONS.has(ext) || _isNoiseDoc(file, null)) continue;
    if (!Array.isArray(lines)) continue;
    const fname = String(file).toLowerCase();
    const fnameNorm = fname.replace(/[^a-z0-9]/g, '');
    for (const sec of splitDocSections(lines, o.docSectionCap ?? 120)) {
      let score = 0, conceptHit = false;
      for (const { t, w, concept } of tokens) {
        if (fname.includes(t) || (concept && fnameNorm.includes(t))) { score += w; if (concept) conceptHit = true; }
      }
      for (let i = sec.start - 1; i < sec.end; i++) {
        const line = String(lines[i] || '').toLowerCase();
        for (const { t, w, concept } of tokens) {
          if (line.includes(t) || (concept && line.replace(/[^a-z0-9]/g, '').includes(t))) {
            score += w;
            if (concept) conceptHit = true;
          }
        }
      }
      if (conceptHit && score >= minScore) candidates.push({ file, start: sec.start, end: sec.end, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  const usedFiles = new Set();
  // Distinct files first; a same-file second pick must not OVERLAP an already
  // picked range (a level-1 section and its level-2 child score near-identically
  // and would pack the same prose twice — observed on STRUCTURAL_SEARCH.md).
  const overlaps = (a, b) => a.file === b.file && a.start <= b.end && b.start <= a.end;
  for (const c of candidates) { if (picked.length >= maxAnchors) break; if (usedFiles.has(c.file)) continue; usedFiles.add(c.file); picked.push(c); }
  for (const c of candidates) { if (picked.length >= maxAnchors) break; if (picked.includes(c) || picked.some((p) => overlaps(p, c))) continue; picked.push(c); }
  return picked.map((c) => `${c.file}@L${c.start}-${c.end}`);
}

// Render grouping output as a draft anchors.lst (the grammar --pseudo-claims parses).
export function formatAnchors(result, meta = {}) {
  const { groups, noiseFiles, noiseFns } = result;
  const minComm = meta.minComm ?? GROUPER_DEFAULTS.minComm;
  const out = [`# mechanism-grouper  index=${meta.indexName || '?'}  group-by=${result.mode}  ${groups.length} groups (>= ${minComm} fns), ${noiseFiles} noise files (${noiseFns} fns) pre-filtered — UNRANKED draft; hand-select the claim-worthy`];
  // EXCLUSIONS ARE NAMED, never silent. A user whose own vendored-then-modified
  // fork was quietly dropped would never learn why their code produced no
  // claims -- and on .sr_gh this removes 866 of 1,490 files, which is not a
  // detail to leave to inference.
  for (const v of result.vendored || []) {
    out.push(`# excluded (third-party): ${v.root}  ${v.files} files  `
      + `[${v.holder}, ${v.holderFiles}/${v.headered} headered]  --include-vendored to keep`);
  }
  if ((result.vendored || []).length) {
    out.push(`# ${result.vendorFns} function(s) in ${result.vendorFiles} file(s) excluded from candidate discovery `
      + `(the index is untouched -- search/digest still see them)`);
  }
  // THE CAP REPORTS WHAT IT DROPPED, and only when it dropped something.
  // A line reading "0 dropped" on every run trains the reader to skip it, and
  // this one has to be noticed the first time it appears -- same rule as
  // `# Repaired:` in the synonymize provenance. It goes in the ARTIFACT, not
  // stderr: the candidates file is what someone hand-prunes later, possibly on
  // another machine, by which time stderr is gone.
  if (result.catalogCapped) {
    out.push(`# catalog seed: ${result.catalogMade} command group(s) formed; cap reached, `
      + `${result.catalogCapped} further command(s) NOT EVALUATED`);
    out.push('#   commands are tried biggest-mechanism-first; raise --catalog-max to evaluate more.');
    out.push('#   NOT-EVALUATED is not the number of groups foregone: most CLI options never form a');
    out.push('#   group anyway (no resolvable handler, or fewer than minComm unassigned members).');
  }
  // THE FILE SEED REPORTS WHAT IT SEEDED AND WHAT IT SKIPPED. A codebase where
  // the doc-header gate finds nothing must say so, or "no [file] groups" reads
  // as "no modules" instead of "no headers".
  if (result.fileSeedMode === 'doc-header') {
    out.push(`# file seed (doc-header): ${result.fileSeeded || 0} group(s) from files whose leading comment describes the module; `
      + `${result.fileNoHeader || 0} file(s) skipped (no such header), ${result.fileLicenseOnly || 0} license-only header(s) rejected. `
      + `--file-seed seeds every file under the size cap; --no-file-seed turns the seed off.`);
  } else if (result.fileSeedMode === 'all') {
    out.push(`# file seed (all files <= ${meta.fileMax ?? GROUPER_DEFAULTS.fileMax} candidates): ${result.fileSeeded || 0} group(s); `
      + `${result.fileTooBig || 0} file(s) over the cap skipped.`);
  }
  // OBSERVE-ONLY COVERAGE (Part B). "Distinctive vocabulary" is a PROXY for
  // claim-worthiness and this reports the skew rather than correcting it: a
  // re-ranking heuristic would imply a judgment CE cannot make. MEASURED on
  // CodeExam: 53 of 78 src files produced no cited anchor while analyze.js
  // supplied 22% of them. Graduation to a per-file cap needs this number across
  // >=3 corpora plus a human judging the unrepresented files claim-worthy.
  if (result.funcs) {
    const inGroups = new Set(groups.flatMap((g) => [...g.ids]));
    const groupFiles = new Set(groups.flatMap((g) => g.members.map((m) => m.file)));
    const allFiles = new Set(result.funcs.map((f) => f.file));
    out.push(`# coverage: ${inGroups.size}/${result.funcs.length} candidate function(s) in a group `
      + `(${Math.round(100 * inGroups.size / Math.max(result.funcs.length, 1))}%), `
      + `${groupFiles.size}/${allFiles.size} file(s) represented `
      + `(${Math.round(100 * groupFiles.size / Math.max(allFiles.size, 1))}%)`);
    const byFile = new Map();
    for (const g of groups) for (const m of g.members) byFile.set(m.file, (byFile.get(m.file) || 0) + 1);
    const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    const tot = [...byFile.values()].reduce((a, b) => a + b, 0) || 1;
    if (top.length) {
      out.push(`# coverage: top file(s) by share of grouped functions — `
        + top.map(([f, n]) => `${f} ${Math.round(100 * n / tot)}%`).join(', '));
    }
    const unrep = [...allFiles].filter((f) => !groupFiles.has(f));
    if (unrep.length) {
      out.push(`# coverage: ${unrep.length} file(s) with candidate functions are in NO group`
        + (unrep.length <= 6 ? ` — ${unrep.join(', ')}` : ''));
    }
  }
  // Splits are REPORTED, never silent: restructuring the candidate list without
  // saying so makes two runs incomparable with no visible cause.
  for (const s of result.splits || []) {
    if (s.into) {
      out.push(`# split: ${s.label} (${s.n} fns) → ${s.into.length} sub-group(s): `
        + `${s.into.map((x) => `${x.label} (${x.n})`).join(', ')}`
        + `  [${Math.round(s.coverage * 100)}% of members kept]`);
      for (const n of s.nested || []) {
        if (!n.into) out.push(`#   still oversized: ${n.label} (${n.n} fns) — ${n.reason}`);
      }
    } else {
      out.push(`# NOT split: ${s.label} (${s.n} fns) — ${s.reason}; emitted intact`);
    }
  }
  for (const g of groups) {
    const purpose = meta.purposeFor ? meta.purposeFor(g.label, g.members) : '';
    out.push('', `# ${g.label}  (${g.members.length} fns)${purpose ? '  — ' + purpose : ''}`);
    // issue-289-doc-anchor-enrichment: doc anchors emit FIRST — the evidence
    // pack fills in member order, so top placement survives the budget.
    if (meta.docAnchorsFor) for (const d of meta.docAnchorsFor(g.label, g.members)) out.push(d);
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
  let priority = null, fold = null;
  const tag = rest.match(/^(\[P([0-3])\b[^\]]*\])\s*(.*)$/);
  if (tag) {
    priority = Number(tag[2]);
    // #291 Part C: carry the ranker's fold verdict (keep|merge|split) so the
    // drafter can DISCLOSE a split-flagged over-broad group on its claim.
    const fm = tag[1].match(/\/(keep|merge|split)\b/);
    fold = fm ? fm[1] : null;
    rest = tag[3];
  } else { const un = rest.match(/^\[unscored\]\s*(.*)$/); if (un) rest = un[1]; }
  const purpose = rest.replace(/^[—–-]+\s*/, '').trim();
  // Bare trailing tier tag on a hand-tagged header (`# Label [P3]`).
  const bare = label.match(/\s*\[P([0-3])\]\s*$/);
  if (bare) { if (priority == null) priority = Number(bare[1]); label = label.slice(0, bare.index).trim(); }
  return { label, priority, fold, purpose };
}

// --- echo detection (grouper-echo-flag-fold Phase 1 — observe-only) ----------
//
// Multi-seed sweeps produce SEMANTIC echoes: one mechanism claimed twice from
// disjoint residue slices (CE: json-stream as `[class] FileScanner` AND
// `[file] json-stream.js`). Member overlap between echoes is ZERO by
// construction — the grouper emits a PARTITION — so the detectable signal is
// FILE-LOCALITY: both groups' members dominantly in the same file (the
// grouper-subsumption-suppression postmortem established this; containment
// was the wrong theory). Conservative by construction: a spread-out group
// has no dominant file and can never pair, which excludes the known
// false-positive shape (two real mechanisms co-located in one file, e.g.
// exports.js's declared-exports builder vs the catalog group's members —
// catalog is spread, so no flag). Phase 2 (--fold-echoes) stays design-on-
// record in the worklist draft, gated on a >=90% true-echo soak.

// The file holding >= threshold of a group's code members, else null.
// Accepts grouper members ({file}) and chart-side resolved anchors
// ({filepath, kind}); doc anchors (kind 'lines') never count.
export function dominantFile(group, threshold = 0.6) {
  const members = (group?.members || []).filter((m) => m && (m.filepath || m.file) && m.kind !== 'lines');
  if (!members.length) return null;
  const counts = new Map();
  for (const m of members) {
    const f = m.filepath || m.file;
    counts.set(f, (counts.get(f) || 0) + 1);
  }
  let best = null, n = 0;
  for (const [f, c] of counts) if (c > n) { n = c; best = f; }
  return n / members.length >= threshold ? best : null;
}

// Echo pairs across a group list: [{host, echo, file}] where host is the
// LARGER group of a same-dominant-file pair (ties keep list order). A 3+
// cluster yields one pair per non-host group; hosts never re-echo, so a
// future fold is bounded and non-transitive by construction.
export function echoPairs(groups) {
  const byFile = new Map();
  for (const g of groups || []) {
    const f = dominantFile(g);
    if (!f) continue;
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(g);
  }
  const out = [];
  for (const [file, gs] of byFile) {
    if (gs.length < 2) continue;
    const sorted = [...gs].sort((a, b) => ((b.members || []).length) - ((a.members || []).length));
    for (let i = 1; i < sorted.length; i++) out.push({ host: sorted[0], echo: sorted[i], file });
  }
  return out;
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
