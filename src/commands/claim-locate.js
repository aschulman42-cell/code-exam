// ============================================================================
// claim-locate.js — --claim-locate: PROPOSE -> VERIFY -> NAVIGATE -> REFINE
//
// Ask the model the question whose answer the index can CHECK: not "give me
// search terms" (four measured failures — see
// worklist-drafts/claim-locate-verify-navigate.md) but "name the classes and
// methods you would expect to implement this claim in this codebase."
//
// Symbol names are verifiable; regex patterns are not. Every proposal is
// labeled VERIFIED (with file@symbol and line range) or NOT FOUND — a model
// guess that does not exist is reported, never silently dropped, because an
// unverifiable citation is the one thing a litigation deliverable cannot
// contain.
//
// Division of labor, established by measurement: the model supplies the
// semantic bridge (patent-ese -> engineering names, which two different
// models produced unaided), the index supplies proof and navigation.
// ============================================================================

import fs from 'node:fs';
import { resolveModel, makeDrafter, claimsCostGate, actualCostLine, resetCloudUsage } from '../core/llm-runner.js';
import {
  buildSymbolTable, verifySymbol, isFound, nearbySymbols, navigateFrom,
  parseProposedSymbols,
} from '../core/symbol-verify.js';

export const LOCATE_DEFAULTS = {
  maxProposals: 24, navLimit: 8, refine: true,
  navPerSeed: 4,      // callees promoted per seed
  maxNavRows: 24,     // total navigation-derived rows
  maxSeedSpan: 200,   // only FUNCTION-sized seeds navigate (lines)
  candidatesPerElement: 25,  // real symbols shown per element in the select step
};

// Split a claim into elements the way the charting code does: preamble to the
// first ':', then semicolon-separated limitations.
export function splitClaimElements(claimText) {
  const t = String(claimText || '').trim().replace(/^\s*\d+\s*\.\s*/, '');
  // Patent claims are conventionally typeset one limitation per line, and the
  // '101 claim is: 6 lines, 1 semicolon, and its first ':' is the "wherein:"
  // near the END — so the original colon-then-semicolon split produced 2
  // elements for a 6-element claim. Prefer LINE structure when present.
  const lines = t.split(/\r?\n/).map((l) => l.trim().replace(/[;,]?\s*(?:and)?\s*$/, '')).filter((l) => l.length > 15);
  if (lines.length >= 2) return lines;
  const ci = t.indexOf(':');
  const body = ci >= 0 ? t.slice(ci + 1) : t;
  return body.split(';').map((e) => e.trim().replace(/[.\s]+$/, '')).filter(Boolean);
}

// A light profile of the codebase — enough for the model to orient (what kind
// of system, what naming conventions), WITHOUT constraining it to a vocabulary
// slice. Constraining is precisely what the abandoned #301 bridge got wrong:
// it forbade `bitrate` because that token was not in the frequency-ranked
// top-300, and the model dutifully answered NONE.
export function buildIndexProfile(index, symbols, opts = {}) {
  const sample = opts.sample ?? 40;
  const exts = new Map();
  const dirs = new Map();
  for (const s of symbols) {
    const fp = s.filepath.split('!').pop();
    const ext = (fp.match(/\.([A-Za-z0-9]+)$/) || [])[1];
    if (ext) exts.set(ext, (exts.get(ext) || 0) + 1);
    const parts = fp.split('/');
    if (parts.length > 2) {
      const d = parts.slice(0, -1).slice(-2).join('/');
      dirs.set(d, (dirs.get(d) || 0) + 1);
    }
  }
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
  // A NAME SAMPLE (not a vocabulary whitelist) so the model can match the
  // codebase's naming style; it remains free to propose anything.
  const step = Math.max(1, Math.floor(symbols.length / sample));
  const names = [];
  for (let i = 0; i < symbols.length && names.length < sample; i += step) names.push(symbols[i].name);
  return [
    `Symbols indexed: ${symbols.length}`,
    `Languages (by symbol count): ${top(exts, 6).join(', ')}`,
    `Representative packages/directories: ${top(dirs, 10).join(', ')}`,
    `Sample of symbol names (style reference only — you are NOT limited to these):`,
    ...names.map((n) => `  ${n}`),
  ].join('\n');
}

// ===========================================================================
// DISCOVERY (default path) — the model never needs to have seen this codebase
// ===========================================================================
//
// The first design asked the model to NAME the implementing classes from its
// own knowledge. That worked on ExoPlayer only because the model had memorized
// ExoPlayer: on a confidential codebase — the actual use case — there is
// nothing to recall and the step collapses. So instead:
//
//   1. ask what WORDS would appear in the names of code implementing each
//      element (reasoning about how software is written — general knowledge);
//   2. CE greps its OWN symbol table for those words (ground truth);
//   3. the model picks from candidates that demonstrably exist.
//
// The model supplies the bridge, the index supplies the vocabulary. No
// tool-use loop, so a 12B can drive it.

export function buildDiscoverPrompt() {
  return `You are given ONE element of a patent claim at a time, in patent language.

Patent language and source code never share vocabulary. Your job: predict the \
WORDS that would appear in the NAMES of classes, methods, and functions that \
implement this element in real working software.

Think about how such a system is actually built and what programmers call \
things — not what the patent calls them. Prefer words that would appear inside \
identifiers.

Example of the transformation (illustrative only, unrelated domain):
  claim says "means for persisting the transaction record durably"
  code words: commit, flush, journal, write, persist, transaction, log

Rules:
- 4 to 10 words per element, lowercase, single words (no phrases).
- NO patent boilerplate (unit, means, method, device, system, module, element).
- Words that would plausibly appear in an identifier, not prose connectors.
- You are NOT told which codebase this is, and you do not need to know.

OUTPUT — one line per element, nothing else:
ELEMENT 1: word; word; word
ELEMENT 2: word; word`;
}

// Parse "ELEMENT n: word; word" into [{element, words[]}].
export function parseElementWords(text) {
  const out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim().replace(/^[-*•]\s*/, '').replace(/\*\*/g, '');
    const m = line.match(/^(?:ELEMENT\s*)?(\d+)\s*[:.)]\s*(.+)$/i);
    if (!m) continue;
    const words = m[2].split(/[;,]/)
      .map((w) => w.trim().toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter((w) => w.length >= 3 && w.length <= 24);
    if (words.length) out.push({ element: Number(m[1]), words: [...new Set(words)] });
  }
  return out;
}

// Grep the symbol table for model-supplied words. Ranked by how many DISTINCT
// element words a symbol's name contains, then by the rarity of those words
// (a word matching half the index says nothing), then by brevity.
// Test/mock/fake code, by symbol name OR by living under a test source root.
// Matches "Test" at a segment END too (`DrmPlaybackTest::clearkeyPlayback_…`),
// which an earlier segment-START-only pattern missed.
export function isTestSymbol(s) {
  return /(?:^|::)[A-Za-z0-9_]*(?:Test|Tests|Mock|Fake|Stub)(?:$|::)/.test(s.name || '')
    || /(?:^|[\\/])(?:test|tests|androidTest)[\\/]/i.test(s.filepath || '');
}

export function searchSymbolsByWords(symbols, words, opts = {}) {
  const limit = opts.limit ?? 25;
  if (!words || !words.length) return [];
  const freq = new Map(words.map((w) => [w, 0]));
  const lowered = symbols.map((s) => ({ s, low: s.name.toLowerCase() }));
  for (const { low } of lowered) {
    for (const w of words) if (low.includes(w)) freq.set(w, freq.get(w) + 1);
  }
  const total = Math.max(1, symbols.length);
  const rarity = (w) => {
    const c = freq.get(w) || 0;
    return c === 0 ? 0 : Math.log(total / c);
  };
  // Scoring principles (corpus-independent, not tuned to any expected answer):
  //  - RARE words carry the signal; count alone rewards verbose names.
  //  - TEST symbols are not implementations. Long generated test-method names
  //    like `...withLateThresholdToDropDecoderInput_dropsInputBuffers` matched
  //    3 words and buried `shouldStartPlayback`, which matched 2.
  //  - Shorter names are better matches at equal evidence.
  // Test symbols are EXCLUDED, not merely penalized. A weight was tried and
  // lost to rarity sums: long generated names like
  // `...withLateThresholdToDropDecoderInput_dropsInputBuffers` matched three
  // words and buried `shouldStartPlayback`, which matched two. We are asking
  // which code IMPLEMENTS an element; a test exercising it is a different
  // question. `--include-tests` restores them.
  // Collapse REDUNDANT matches before scoring. `rate` and `bitrate` are one
  // signal, not two: `calculateEac3Bitrate` matched rate+bitrate+calculate and
  // outranked `determineIdealSelectedIndex`, which matched the single rare word
  // `determine` — so the crux was never offered to one provider and it could
  // not pick what it was not shown. When one matched word contains another,
  // keep only the longer (more specific) one.
  const collapse = (matched) => matched.filter((w) =>
    !matched.some((o) => o !== w && o.includes(w) && o.length > w.length));
  const hits = [];
  for (const { s, low } of lowered) {
    if (!opts.includeTests && isTestSymbol(s)) continue;
    const raw = words.filter((w) => low.includes(w));
    if (!raw.length) continue;
    const matched = collapse(raw);
    const score = matched.reduce((n, w) => n + rarity(w), 0)
      + Math.log(1 + matched.length)      // breadth still helps, sub-linearly
      - Math.log(Math.max(8, s.name.length)) / 2;
    hits.push({ sym: s, matched, score });
  }
  hits.sort((a, b) => b.score - a.score);
  // De-duplicate by NAME: interfaces and their implementations share method
  // names, and three identical rows waste candidate slots the model needs.
  // The model selects a name; verifySymbol resolves it and flags ambiguity.
  // De-duplicate by BARE name, not full name. `getLicenseDurationRemainingSec`,
  // `WidevineUtil::getLicenseDurationRemainingSec`, and
  // `OfflineLicenseHelper::getLicenseDurationRemainingSec` are one function
  // seen through interface and implementations — five of one provider's top
  // six candidates were copies of a single method, spending the model's
  // attention and pushing real alternatives out of the window.
  const byBare = new Map();
  for (const h of hits) {
    const key = h.sym.bare || h.sym.name;
    const prev = byBare.get(key);
    if (prev) { prev.dupes = (prev.dupes || 1) + 1; continue; }
    byBare.set(key, h);
  }
  return [...byBare.values()].slice(0, limit);
}

// Round 2: choose from candidates that EXIST. Blind mode hides file paths so a
// run can prove discovery rather than recall.
export function buildSelectPrompt(perElement, opts = {}) {
  const blind = !!opts.blind;
  const blocks = perElement.map(({ element, text, hits }) => {
    const lines = hits.map((h, i) => `  ${i + 1}. ${h.sym.name}${blind ? '' : `   [${h.sym.filepath.split('!').pop()}]`}`);
    return `ELEMENT ${element}: ${text}\nCandidates found in the codebase:\n${lines.join('\n') || '  (none found)'}`;
  });
  return `For each claim element below you are shown REAL symbols from the codebase \
under examination, found by searching its symbol table.

Choose the symbol(s) that most plausibly IMPLEMENT that element. Prefer the \
specific function that performs the action over a container class. Choose at \
most 3 per element. If none of the candidates plausibly implement the element, \
answer NONE — that is a meaningful answer, not a failure.

Copy names EXACTLY as shown.

OUTPUT — one line per element, nothing else:
ELEMENT 1: ExactName; Other::exactName
ELEMENT 2: NONE

${blocks.join('\n\n')}`;
}

export function buildProposePrompt(profile) {
  return `You locate the code that implements a patent claim, in a specific codebase.

You will be given a patent claim and a profile of the codebase being examined.

For EACH numbered claim element, name the CLASSES and METHODS you would expect \
to implement it in a codebase of this kind. Use your knowledge of how such \
systems are actually built and what their components are conventionally named.

CRITICAL:
- Answer with SYMBOL NAMES (class, method, or Class::method), not search terms, \
not regular expressions, not prose.
- Draw on your domain knowledge. You are NOT restricted to names appearing in \
the profile — the profile is a style reference, not a whitelist.
- Prefer the specific component that PERFORMS the element's action over generic \
container classes.
- If you genuinely cannot name a plausible implementer for an element, write \
NONE for it. An element with no plausible implementer is meaningful evidence.
- Every name you give will be checked against the real index and reported as \
verified or not found, so guess your best but do not pad the list.

OUTPUT FORMAT — one line per claim element, nothing else:
ELEMENT 1: Name; Class::method; Other
ELEMENT 2: NONE

CODEBASE PROFILE:
${profile}`;
}

export function buildRefinePrompt(notFound, table) {
  const blocks = notFound.map((v) => {
    const near = nearbySymbols(table, v.candidate, 8).map((s) => s.name);
    return `${v.candidate} -> NOT FOUND. Real symbols sharing its words: ${near.length ? near.join('; ') : '(none)'}`;
  });
  return `Some proposed symbols do not exist in this codebase. Below is each \
failed proposal with REAL symbol names from the index that share its words.

Revise ONLY the failed proposals. Choose from the real names shown, or propose \
different names you believe exist. Do not repeat names already marked NOT FOUND.

OUTPUT FORMAT — one line per revision, nothing else:
ELEMENT 1: RealName; Other::realMethod

FAILED PROPOSALS:
${blocks.join('\n')}`;
}

// Render the located-symbol report. Provenance per row is the point.
export function formatLocateReport(rows, opts = {}) {
  const out = ['', '='.repeat(72), ' LOCATED SYMBOLS — model-proposed, index-verified', '='.repeat(72), ''];
  const found = rows.filter((r) => r.verified);
  const missing = rows.filter((r) => !r.verified);
  if (!found.length) {
    out.push('  No proposed symbol could be verified in this index.');
  }
  for (const r of found) {
    const m = r.match;
    const span = (m.end != null && m.start != null) ? (m.end - m.start) : null;
    const scale = span == null ? '' : (span <= LOCATE_DEFAULTS.maxSeedSpan ? ', function-scale' : `, class-scale ${span} lines`);
    out.push(`  [${r.status}${scale}] ${m.name}  (L${m.start}-${m.end})`);
    out.push(`      ${m.filepath.split('!').pop()}`);
    if (r.element != null) out.push(`      claim element ${r.element}`);
    if (r.viaNavigation) {
      out.push(`      reached by navigation from ${r.viaNavigation} (not model-proposed)`);
    } else {
      out.push(`      proposed as: ${r.candidate}${r.round === 2 ? ' (refine round)' : ''}`);
    }
    if (r.ambiguous > 1) {
      out.push(`      AMBIGUOUS: ${r.ambiguous} symbols match this name — first shown; verify manually`);
    }
    if (r.nav && (r.nav.callers.length || r.nav.callees.length)) {
      if (r.nav.callees.length) out.push(`      calls: ${r.nav.callees.slice(0, 6).join(', ')}`);
      if (r.nav.callers.length) out.push(`      called by: ${r.nav.callers.slice(0, 6).join(', ')}`);
    }
    out.push('');
  }
  if (missing.length) {
    out.push(`  NOT FOUND in this index (${missing.length}) — proposed by the model, no such symbol:`);
    for (const r of missing) out.push(`    ${r.candidate}${r.element != null ? `  [element ${r.element}]` : ''}`);
    out.push('');
  }
  out.push(`  Verified ${found.length} of ${rows.length} proposals.`);

  // SPECIFICITY. Verification rate alone is a RISK metric, not a quality one:
  // measured on the '101 claim, one provider verified 48 of 48 (zero
  // hallucinations) by proposing generic container classes and missed the
  // claimed mechanism entirely, while providers that risked specific decision
  // functions had NOT-FOUNDs and found it. So report how much of what was
  // verified is actually function-scale, and flag the safe-and-empty pattern.
  const proposed = found.filter((r) => !r.viaNavigation);
  const spanOf = (r) => ((r.match.end != null && r.match.start != null) ? r.match.end - r.match.start : null);
  const fnScale = proposed.filter((r) => { const s = spanOf(r); return s != null && s <= LOCATE_DEFAULTS.maxSeedSpan; }).length;
  const pct = proposed.length ? Math.round((fnScale / proposed.length) * 100) : 0;
  const ambig = found.filter((r) => r.ambiguous > 1).length;
  out.push(`  Specificity: ${fnScale}/${proposed.length} model-proposed symbols are function-scale (${pct}%);`);
  out.push(`  ${ambig} ambiguous name(s); ${missing.length} not found.`);
  if (proposed.length >= 5 && pct < 35 && missing.length === 0) {
    out.push('  NOTE: high class-scale share with zero not-found suggests the model');
    out.push('        proposed safe container classes rather than the specific code');
    out.push('        performing each element — treat coverage here as weak.');
  }
  out.push('  Symbol names come from the model\'s domain knowledge; existence,');
  out.push('  location, and call relationships come from the index.');
  if (opts.targetsLine && found.length) {
    out.push('');
    out.push('  Use as claim-chart targets:');
    out.push(`    --targets "${found.map((r) => `${r.match.filepath.split('!').pop().split('/').pop()}@${r.match.name}`).join(';')}"`);
  }
  return out;
}

export async function doClaimLocate(index, args, opts = {}) {
  const spec = args.claim_locate;
  let claimText = spec;
  if (typeof spec === 'string' && spec.startsWith('@')) {
    try { claimText = fs.readFileSync(spec.slice(1), 'utf8'); }
    catch (e) { console.error(`Cannot read claim file: ${e.message}`); process.exitCode = 1; return; }
  }
  if (!claimText || !String(claimText).trim()) {
    console.error('--claim-locate needs claim text: --claim-locate @claim.txt'); process.exitCode = 1;
    return;
  }
  claimText = String(claimText).trim();

  const model = resolveModel(args);
  if (!model) { console.error('--claim-locate needs a model: --llm <provider> or --model <gguf>.'), process.exitCode = 1; return; }
  if (model.kind === 'error') { console.error(`Error: ${model.error}`), process.exitCode = 1; return; }
  let draft;
  try { draft = opts.draft || makeDrafter(model, args.temperature ?? 0); }
  catch (e) { console.error(`--claim-locate: ${e.message}`); process.exitCode = 1; return; }

  const symbols = buildSymbolTable(index);
  if (!symbols.length) { console.error('Index has no function/class symbols to verify against.'), process.exitCode = 1; return; }
  const elements = splitClaimElements(claimText);
  const blind = !!args.blind;

  console.log(`Claim: ${claimText.length} chars, ${elements.length} element(s)`);
  console.log(`Index: ${symbols.length} symbols`);
  console.log(`Mode: ${args.propose_from_priors ? 'propose-from-priors (model names symbols from its own knowledge)'
    : `symbol-table discovery${blind ? ' — BLIND (no paths or codebase identity shown to the model)' : ''}`}`);
  console.log();

  let proposals = [];
  let discovery = null;

  if (args.propose_from_priors) {
    // LEGACY PATH — only sound for codebases the model has memorized. On
    // confidential code there is nothing to recall, which is the real use
    // case, so this is opt-in and labeled.
    const profile = buildIndexProfile(index, symbols);
    const sys = buildProposePrompt(profile);
    const user = `PATENT CLAIM:\n${claimText}\n\nNumbered elements:\n`
      + elements.map((e, i) => `${i + 1}. ${e}`).join('\n');
    if (!claimsCostGate(model, [{ inChars: sys.length + user.length, outTokens: 500 }], 'claim-locate propose', args)) return;
    resetCloudUsage();
    process.stderr.write('Proposing implementing symbols from model knowledge...\n');
    let raw;
    try { raw = await draft(sys, user, 800); }
    catch (e) { console.error(`--claim-locate: propose failed: ${e.message}`); process.exitCode = 1; return; }
    proposals = parseProposedSymbols(raw || '').slice(0, LOCATE_DEFAULTS.maxProposals);
  } else {
    // DISCOVERY PATH (default). Step 1 gives the model the claim ONLY — no
    // codebase name, no paths, no profile — so nothing here can be answered
    // from memory of a specific repository.
    const sys1 = buildDiscoverPrompt();
    const user1 = `CLAIM ELEMENTS:\n` + elements.map((e, i) => `${i + 1}. ${e}`).join('\n');
    if (!claimsCostGate(model, [{ inChars: sys1.length + user1.length, outTokens: 400 },
      { inChars: 6000, outTokens: 300 }], 'claim-locate discovery (2 calls)', args)) return;
    resetCloudUsage();

    process.stderr.write('Step 1: predicting code vocabulary from the claim (no codebase shown)...\n');
    let rawWords;
    try { rawWords = await draft(sys1, user1, 600); }
    catch (e) { console.error(`--claim-locate: vocabulary step failed: ${e.message}`); process.exitCode = 1; return; }
    const wordSets = parseElementWords(rawWords || '');
    if (!wordSets.length) {
      console.error('The model produced no parseable code-word predictions.'); process.exitCode = 1;
      if (args.verbose) console.log(rawWords);
      return;
    }

    // Step 2: CE greps its own symbol table — ground truth, no model involved.
    const perElement = [];
    for (const { element, words } of wordSets) {
      const hits = searchSymbolsByWords(symbols, words, { limit: LOCATE_DEFAULTS.candidatesPerElement, includeTests: !!args.include_tests });
      perElement.push({ element, text: (elements[element - 1] || '').slice(0, 160), words, hits });
      console.log(`  element ${element}: words [${words.join(', ')}] -> ${hits.length} candidate(s)`);
    }
    discovery = perElement;
    const withHits = perElement.filter((p) => p.hits.length);
    if (!withHits.length) {
      console.log('\nNo symbol in this index matches any predicted code word.');
      return;
    }

    // Step 3: the model chooses among symbols that DEMONSTRABLY EXIST.
    process.stderr.write('Step 3: selecting implementers from real candidates...\n');
    let rawSel;
    try { rawSel = await draft(buildSelectPrompt(withHits, { blind }), `PATENT CLAIM:\n${claimText}`, 700); }
    catch (e) { console.error(`--claim-locate: selection step failed: ${e.message}`); process.exitCode = 1; return; }
    proposals = parseProposedSymbols(rawSel || '').slice(0, LOCATE_DEFAULTS.maxProposals);
    console.log();
  }

  if (!proposals.length) {
    console.error('No symbol selections were parseable.'); process.exitCode = 1;
    return;
  }
  process.stderr.write(`  ${proposals.length} selection(s); verifying against the index...\n`);

  const rows = [];
  const seen = new Set();
  const verifyInto = (list, round) => {
    for (const p of list) {
      if (seen.has(p.candidate)) continue;
      seen.add(p.candidate);
      const v = verifySymbol(symbols, p.candidate);
      const ok = isFound(v);
      rows.push({
        candidate: p.candidate, element: p.element, round,
        verified: ok, status: v.status, ambiguous: v.ambiguous || 0,
        match: ok ? v.matches[0] : null,
        nav: ok ? navigateFrom(index, v.matches[0], { limit: LOCATE_DEFAULTS.navLimit }) : null,
      });
    }
  };
  verifyInto(proposals, 1);

  // Promote NAVIGATION results to first-class verified rows. The one-hop
  // callees of a correctly-resolved symbol are where the decision logic
  // actually lives — `determineIdealSelectedIndex` is a callee of
  // `updateSelectedTrack`, and both independent model analyses named it. It
  // is unreachable by proposal alone (models name the entry point), so the
  // index contributes it. Marked `via-navigation` so provenance stays honest.
  if (args.no_navigate !== true) {
    // Promote CALLEES only, and only from FUNCTION-sized seeds. Measured on
    // the '101 re-run: promoting callers too, from class-sized seeds, produced
    // 129 rows — mostly constructor noise under the 2,000-line `ExoPlayer`
    // class, plus test classes arriving as "callers". Callees of a real
    // function are where decision logic lives (determineIdealSelectedIndex is
    // a callee of the 50-line updateSelectedTrack); a class's callees are its
    // members, which say nothing about the claim.
    let promoted = 0;
    const navSeeds = rows.filter((r) => r.verified && r.nav
      && r.match.start != null && (r.match.end - r.match.start) <= LOCATE_DEFAULTS.maxSeedSpan);
    for (const seed of navSeeds) {
      if (promoted >= LOCATE_DEFAULTS.maxNavRows) break;
      for (const name of seed.nav.callees.slice(0, LOCATE_DEFAULTS.navPerSeed)) {
        if (promoted >= LOCATE_DEFAULTS.maxNavRows) break;
        if (seen.has(name)) continue;
        // Resolve within the SEED'S OWN FILE first — a bare callee name is
        // ambiguous index-wide (8 symbols are named `updateSelectedTrack`).
        const local = symbols.filter((s) => s.filepath === seed.match.filepath && s.bare === name.replace(/^.*::/, ''));
        const v = local.length ? { status: 'exact', matches: local, ambiguous: local.length > 1 ? local.length : 0 }
          : verifySymbol(symbols, name);
        if (!isFound(v)) continue;
        seen.add(name);
        promoted++;
        rows.push({
          candidate: name, element: seed.element, round: 1,
          verified: true, status: v.status, ambiguous: v.ambiguous,
          match: v.matches[0], nav: null,
          viaNavigation: seed.match.name,
        });
      }
    }
  }

  // ONE bounded refine round: hand back real symbols sharing the failed
  // proposals' words. No open-ended loop.
  const missing = rows.filter((r) => !r.verified);
  if (missing.length && args.no_refine !== true && LOCATE_DEFAULTS.refine) {
    process.stderr.write(`  ${missing.length} not found; one refine round...\n`);
    const rp = buildRefinePrompt(missing, symbols);
    try {
      const raw2 = await draft(rp, `PATENT CLAIM:\n${claimText}`, 600);
      verifyInto(parseProposedSymbols(raw2 || ''), 2);
    } catch (e) {
      process.stderr.write(`  refine round failed: ${e.message}\n`);
    }
  }

  for (const ln of formatLocateReport(rows, { targetsLine: true })) console.log(ln);
  const cost = actualCostLine(model);
  if (cost) console.log(cost);
  return { rows, symbols: symbols.length };
}
