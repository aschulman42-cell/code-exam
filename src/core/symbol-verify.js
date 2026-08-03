// symbol-verify.js — claim-locate-verify-navigate: check a MODEL'S PROPOSED
// symbol names against the index, and navigate one hop from the survivors.
//
// WHY. Four text-retrieval approaches were measured against US 8,752,101
// claim 1 vs ExoPlayer3 and all four failed (concept bridge, density ranking,
// IDF-mass gate + BM25 sweep, symbol lens on claim-derived stems). Their
// common flaw: CE asked the model for SEARCH TERMS. The claim says "code rate
// determining unit"; the code says `AdaptiveTrackSelection`. No scoring over
// text connects those — the gap is semantic.
//
// It is not, however, a hard gap: Claude and ChatGPT each named
// AdaptiveTrackSelection / determineIdealSelectedIndex from the claim alone.
// So the model supplies the bridge (priors) and the index supplies the proof
// (verification). This module is the proof half — entirely mechanical, no LLM,
// so it is deterministic and testable.
//
// A proposal that does not exist is reported NOT FOUND, never silently
// dropped: an unverifiable citation is the one thing a litigation deliverable
// cannot contain.

// Split an identifier into lowercase tokens: camelCase, snake_case, ::, dots.
export function symbolTokens(name) {
  return String(name || '')
    .replace(/[:.]+/g, ' ')
    .replace(/[_\-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

// Flat symbol table from the index: every function/method/class entry.
export function buildSymbolTable(index) {
  index._ensureFunctionIndex?.();
  const out = [];
  for (const [filepath, fns] of Object.entries(index.functionIndex || {})) {
    for (const [name, info] of Object.entries(fns || {})) {
      out.push({
        filepath, name,
        bare: name.replace(/^.*::/, ''),
        start: info?.start, end: info?.end,
        tokens: symbolTokens(name),
      });
    }
  }
  return out;
}

// Resolve one proposed symbol name against the table, strongest tier first.
// Returns { candidate, status, matches[] } where status is one of:
//   exact | case-insensitive | token-subset | substring | not-found
// A candidate may be "Class::method", "Class.method", or a bare name.
export function verifySymbol(table, candidate, opts = {}) {
  const limit = opts.limit ?? 5;
  const raw = String(candidate || '').trim().replace(/\(\s*\)$/, '');
  if (!raw) return { candidate, status: 'not-found', matches: [] };
  const norm = raw.replace(/\./g, '::');
  const bare = norm.replace(/^.*::/, '');
  const lower = norm.toLowerCase();
  const bareLower = bare.toLowerCase();
  const tokens = symbolTokens(norm);
  // A QUALIFIED proposal (Class::method) names its class deliberately and the
  // qualifier must be honored. The '101 run proposed
  // `AdaptiveTrackSelection::updateSelectedTrack` — correct — and bare-name
  // matching resolved it to `DownloadHelper::DownloadTrackSelection::
  // updateSelectedTrack`, one of EIGHT symbols with that bare name. A
  // precise-looking citation to the wrong class is the worst failure this
  // command can produce, so qualified proposals never fall back to bare.
  const qualified = norm.includes('::');
  const qualifier = qualified ? norm.slice(0, norm.lastIndexOf('::')).toLowerCase() : null;
  const qualifierMatches = (s) => {
    if (!qualified) return true;
    const n = s.name.toLowerCase();
    return n === lower || n.endsWith(`::${bareLower}`) && n.includes(qualifier);
  };

  // ambiguous: more than one DISTINCT symbol survived at the winning tier.
  const pick = (rows, status) => ({
    candidate, status, matches: rows.slice(0, limit),
    ambiguous: rows.length > 1 ? rows.length : 0,
  });

  let rows = table.filter((s) => s.name === norm);
  if (rows.length) return pick(rows, 'exact');

  rows = table.filter((s) => s.name.toLowerCase() === lower);
  if (rows.length) return pick(rows, 'exact');

  if (qualified) {
    // Qualified: the class must appear in the symbol's own qualified name.
    rows = table.filter((s) => s.bare.toLowerCase() === bareLower && qualifierMatches(s));
    if (rows.length) return pick(rows, 'qualified');
  } else {
    rows = table.filter((s) => s.bare === bare);
    if (rows.length) return pick(rows, 'exact');
    rows = table.filter((s) => s.bare.toLowerCase() === bareLower);
    if (rows.length) return pick(rows, 'case-insensitive');
  }

  // Token-subset: every token of the proposal appears in the symbol's tokens.
  // Catches `AdaptiveTrackSelection.updateSelectedTrack` vs the indexed
  // `AdaptiveTrackSelection::updateSelectedTrack`, and word-order variants.
  if (tokens.length) {
    rows = table.filter((s) => tokens.every((t) => s.tokens.includes(t)));
    if (rows.length) return pick(rows, 'token-subset');
  }

  if (bareLower.length >= 5) {
    rows = table.filter((s) => s.name.toLowerCase().includes(bareLower));
    if (rows.length) return pick(rows, 'substring');
  }

  return { candidate, status: 'not-found', matches: [] };
}

export const FOUND_STATUSES = new Set(['exact', 'qualified', 'case-insensitive', 'token-subset', 'substring']);
export const isFound = (v) => FOUND_STATUSES.has(v.status);

// For a NOT-FOUND proposal, real symbols sharing its tokens — fed back to the
// model for ONE bounded refine round so it can correct toward what exists.
export function nearbySymbols(table, candidate, limit = 8) {
  const tokens = symbolTokens(candidate);
  if (!tokens.length) return [];
  const scored = [];
  for (const s of table) {
    let n = 0;
    for (const t of tokens) if (s.tokens.includes(t)) n++;
    if (n > 0) scored.push({ n, s });
  }
  scored.sort((a, b) => b.n - a.n || a.s.name.length - b.s.name.length);
  return scored.slice(0, limit).map((x) => x.s);
}

// One hop out from a verified symbol. This is where the crux function arrives
// for free: determineIdealSelectedIndex is a callee of updateSelectedTrack,
// and callee bodies were exactly what the analyses were blind to (#303).
export function navigateFrom(index, sym, opts = {}) {
  const limit = opts.limit ?? 10;
  const out = { callers: [], callees: [] };
  // findCallers rows are keyed `caller_function` (findCallees `callee`/`name`).
  // Guessing these field names wrong printed "[object Object]" in the first
  // live run — read the shape, do not assume it.
  const nameOf = (r) => (typeof r === 'string' ? r
    : r?.caller_function || r?.callee_function || r?.callee || r?.function || r?.name || null);
  const clean = (rows) => {
    const seen = new Set();
    const out2 = [];
    for (const r of rows || []) {
      const n = nameOf(r);
      if (!n) continue;
      // Drop self-references: the declaration line matches the callee scan, so
      // `updateSelectedTrack` was listing itself under "calls".
      if (n === sym.name || n.replace(/^.*::/, '') === sym.bare) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out2.push(n);
      if (out2.length >= limit) break;
    }
    return out2;
  };
  try {
    const c = index.findCallers?.(sym.bare, 200);
    out.callers = clean(Array.isArray(c) ? c : (c?.callers || c?.matches || []));
  } catch { /* navigation is best-effort */ }
  try {
    const c = index.findCallees?.(sym.bare, sym.filepath);
    out.callees = clean(Array.isArray(c) ? c : (c?.callees || c?.matches || []));
  } catch { /* best-effort */ }
  return out;
}

// Parse the propose-step reply. Expected line shape:
//   ELEMENT <n>: <symbol>; <symbol>; ...
// Tolerant of bullets, bold, backticks, and a bare symbol list.
export function parseProposedSymbols(text) {
  const out = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim().replace(/^[-*•]\s*/, '').replace(/\*\*/g, '');
    if (!line) continue;
    const m = line.match(/^(?:ELEMENT\s*)?(\d+)\s*[:.)]\s*(.+)$/i);
    const body = m ? m[2] : (/^[A-Za-z_][\w:.]*(\s*;|$)/.test(line) ? line : null);
    if (!body) continue;
    const element = m ? Number(m[1]) : null;
    for (const part of body.split(/[;,]/)) {
      const cand = part.trim().replace(/^`|`$/g, '').replace(/\(\s*\)$/, '');
      if (!cand || cand.length > 120) continue;
      if (!/^[A-Za-z_][\w:.]*$/.test(cand)) continue;
      // Every prompt that asks for symbols also offers NONE as a real answer
      // ("an element with no plausible implementer is meaningful evidence").
      // NONE is shaped exactly like an identifier, so it was being verified as
      // one and reported as a NOT-FOUND proposal — turning the model's correct
      // abstention into a fabricated-looking miss, and inflating the not-found
      // count that the specificity note reads.
      if (/^(?:none|n\/a|unknown|nothing)$/i.test(cand)) continue;
      out.push({ element, candidate: cand });
    }
  }
  // De-dupe on candidate, keeping the first element attribution.
  const seen = new Set();
  return out.filter((r) => (seen.has(r.candidate) ? false : (seen.add(r.candidate), true)));
}
