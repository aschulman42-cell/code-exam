/**
 * dep-claims.js -- facts about ONE claim (dep-claim-rules.js) -> a CHAIN across a claim set.
 *
 * #311 step 1. `dep-claim-rules.js` answers "is this text dependent, and on which number"; this module
 * takes a whole claim set and resolves the graph: depth (`I`, `D`, `D2`, `D3` ...), forward references,
 * multi-parent choice, what each dependent CONTRIBUTES (ADDITION / MODIFICATION / UNDETERMINED, or a
 * cross-class VARIANT), and -- the half `claimlen.awk` (Andrew, 2007) never had -- a residue report:
 * independent claims are the fall-through after every dependent pattern fails, and a missed pattern
 * therefore does not error, it produces a confident wrong answer. So every independent says WHY, the
 * ones that smell dependent are listed, a dependent whose parent will not resolve is reported rather
 * than downgraded, and a two-number or self-referential reference is AMBIGUOUS, never guessed.
 *
 * Contribution matters analytically, not cosmetically (Andrew, 2026-08-24): an ADDITION adds a
 * limitation to be satisfied on its own; a MODIFICATION re-opens a verdict already reached -- code
 * that met the parent's broad limitation may fail the narrowed one, so an inherited PRESENT can become
 * ABSENT. Measured on two corpora the phrase alternation (`further comprising` vs `wherein` /
 * `in which`) decides 88-90% of dependents; the rest are UNDETERMINED here, on purpose -- a wrong call
 * silently skips a re-evaluation, and that is the costlier failure.
 *
 * Multi-parent references ("claims 1 to 4", "claim 1 or 2") have no single row set. The default takes
 * the SHORTEST parent present -- the broadest, least favourable to the patent owner, what the awk did
 * -- and the choice is stated in the output, never resolved silently.
 *
 * No charting, no generation, no consumer rewiring: those are issue-311-dep-claim-input and the
 * generation items, which import this.
 */
import { classifyClaim, stripOwnNumber } from './dep-claim-rules.js';

/** How a multi-parent reference is collapsed to one chain. */
export const PARENT_POLICIES = {
  'shortest-parent': 'the shortest parent text present in the set (the broadest claim; least favourable to the patent owner)',
  'first-listed': 'the first parent number the reference lists',
};

const ADDITION_RE = /\bfurther\s+(?:comprising|comprises|including|includes|having|containing)\b/i;
// pseudo-claims-statutory-class: apparatus/CRM ADDITION forms. "wherein the
// processor is further configured to <op>" ADDS an operation; under the
// wherein rule alone it filed as MODIFICATION (measured: ADDITION count 0 in
// all 20 both-ways system drafts). The wherein rule yields to these.
const APPARATUS_ADDITION_RE = /\b(?:further\s+configured\s+to|further\s+compris\w*\s+instructions|instructions\s+further\s+caus\w*)\b/i;
const MODIFICATION_RE = /\b(?:wherein|in\s+which|where\s+(?:the|said|each|at\s+least))\b/i;
// Cross-class variants (Andrew, 2026-08-24: dependent VARIANTS -- they still require looking at another
// claim, so they ride the same machinery, but they are their own kind and never forced into (a)/(b)).
const PRODUCT_BY_PROCESS_RE = /\b(?:produced|formed|made|obtained|prepared|manufactured|coated|treated)\s+(?:by|from|according\s+to|using)\s+the\s+(?:method|process)\s+of\b/i;
const COMBINATION_RE = /\bcombination\s+(?:comprising|including|of)\b[\s\S]{0,80}\b(?:system|apparatus|device|method|assembly|circuit)\s+of\s+claim\b/i;

/**
 * What a dependent claim contributes relative to its parent.
 * @returns {{kind:'ADDITION'|'MODIFICATION'|'UNDETERMINED'|'PRODUCT-BY-PROCESS'|'COMBINATION', cue:string|null, note:string}}
 */
export function classifyContribution(text) {
  const s = String(text || '');
  if (PRODUCT_BY_PROCESS_RE.test(s)) return { kind: 'PRODUCT-BY-PROCESS', cue: s.match(PRODUCT_BY_PROCESS_RE)[0], note: 'the referenced claim constrains how the product came to be, not what it structurally exhibits' };
  if (COMBINATION_RE.test(s)) return { kind: 'COMBINATION', cue: s.match(COMBINATION_RE)[0].slice(0, 60), note: 'the referenced claim is incorporated whole and something is added beside it, across a class boundary' };
  const app = APPARATUS_ADDITION_RE.exec(s);
  if (app) return { kind: 'ADDITION', cue: app[0], note: 'apparatus addition form; the wherein rule yields to it' };
  const add = ADDITION_RE.exec(s), mod = MODIFICATION_RE.exec(s);
  if (add && !mod) return { kind: 'ADDITION', cue: add[0], note: 'adds a limitation to be satisfied on its own; nothing already judged changes' };
  if (mod && !add) return { kind: 'MODIFICATION', cue: mod[0], note: 'narrows an inherited limitation; the parent’s verdict on it must be re-evaluated' };
  if (add && mod) return { kind: 'UNDETERMINED', cue: `${add[0]} + ${mod[0]}`, note: 'both an addition cue and a narrowing cue are present; not guessed' };
  return { kind: 'UNDETERMINED', cue: null, note: 'neither an addition cue nor a narrowing cue is present; not guessed' };
}

// "claims 1 to 4" / "claims 2 through 8" / "claims 1-4" mean every claim in the range, and
// resolveParents (dep-claim-rules.js) currently returns the ENDPOINTS of such a reference. Expanded
// here so multi-parent choice sees the whole set; the range regex belongs in resolveParents
// eventually (noted for dep-claim-rule-set), and expanding an already-expanded list is a no-op.
const RANGE_RE = /\bclai?ms?\s+(?:of\s+|in\s+)?(?:any\s+(?:one\s+)?of\s+)?([0-9]+)\s*(?:to|through|-|–)\s*([0-9]+)\b/i;
export function expandRanges(text, parents) {
  const m = RANGE_RE.exec(String(text || ''));
  if (!m) return parents;
  const lo = Number(m[1]), hi = Number(m[2]);
  if (!(lo > 0 && hi > lo && hi - lo < 200)) return parents;
  const out = new Set(parents);
  for (let k = lo; k <= hi; k++) out.add(k);
  return [...out].sort((a, b) => a - b);
}

/** Depth label: 'I' for an independent claim, 'D' for depth 1, 'D2', 'D3' ... */
export function depthLabel(depth) {
  if (depth == null) return null;
  if (depth === 0) return 'I';
  return depth === 1 ? 'D' : `D${depth}`;
}

// Does an INDEPENDENT-classified claim smell dependent? The low-confidence residue channel: short and
// mentioning "claim", or carrying a preposition-plus-number that a missed pattern would leave behind.
function dependencySmell(body) {
  const reasons = [];
  if (body.length < 400 && /\bclai?ms?\b/i.test(body)) reasons.push('short and mentions "claim" without a recognised dependency pattern');
  if (/\b(?:of|in|to|per|under)\s+(?:the\s+)?(?:preceding|previous|above|foregoing)\b/i.test(body)) reasons.push('refers to a preceding claim without a number');
  return reasons;
}

/**
 * Analyse a claim set.
 * @param {Array<{n?:number, text:string}|string>} claims  claims in any order; a bare string's number is read from its own leading "N."
 * @param {object} [opts]
 * @param {'shortest-parent'|'first-listed'} [opts.policy='shortest-parent']
 * @returns {{claims:object[], byNumber:Map<number,object>, report:object}}
 */
export function analyzeClaimSet(claims, opts = {}) {
  const policy = opts.policy || 'shortest-parent';
  if (!PARENT_POLICIES[policy]) throw new Error(`unknown parent policy "${policy}"; one of ${Object.keys(PARENT_POLICIES).join(', ')}`);

  // 1. One claim at a time: number, detection, parents. Order-independent, so a forward reference
  //    (5,677,880 #31 depends on #32) costs nothing -- resolution happens after every claim is in.
  const rows = [];
  const byNumber = new Map();
  for (const c of claims || []) {
    const text = typeof c === 'string' ? c : String((c && c.text) || '');
    const { own } = stripOwnNumber(text);
    const n = typeof c === 'object' && c && c.n != null ? Number(c.n) : own;
    const v = classifyClaim(text);
    const parents = v.parents ? expandRanges(text, v.parents) : null;
    const row = { n, text, dependent: v.dependent, rule: v.rule || null, parents, parent: null, parentChoice: null,
      ambiguous: v.ambiguous || null, missingParents: [], forward: false, depth: null, depthLabel: null, chain: null, contribution: null, why: null, smell: [] };
    if (!v.dependent) {
      row.why = 'no dependent pattern matched (independent is the residue, not a detection)';
      row.smell = dependencySmell(text);
      row.depth = 0;
    }
    rows.push(row);
    if (n != null && !byNumber.has(n)) byNumber.set(n, row);
  }

  // 2. Parent choice, with the set in hand.
  for (const row of rows) {
    if (!row.dependent || !row.parents) continue;
    const present = row.parents.filter((p) => byNumber.has(p));
    row.missingParents = row.parents.filter((p) => !byNumber.has(p));
    if (row.parents.length === 1) {
      row.parent = present.length ? row.parents[0] : null;
    } else if (present.length) {
      let chosen;
      if (policy === 'shortest-parent') chosen = present.slice().sort((a, b) => byNumber.get(a).text.length - byNumber.get(b).text.length || a - b)[0];
      else chosen = present[0];
      row.parent = chosen;
      row.parentChoice = { policy, description: PARENT_POLICIES[policy], chosen, alternatives: row.parents.filter((p) => p !== chosen),
        note: 'a multi-parent reference has no single row set; the choice is stated, never silent' };
    }
    if (row.parent != null && row.n != null && row.parent > row.n) row.forward = true;
    row.contribution = classifyContribution(row.text);
  }

  // 3. Depth and chain, memoised, cycle-guarded.
  const cycles = [];
  const depthOf = (row, trail) => {
    if (row.depth != null) return row.depth;
    if (!row.dependent) { row.depth = 0; return 0; }
    if (row.parent == null) return null;                       // unresolved: depth unknown, stays null
    if (trail.includes(row.n)) { cycles.push([...trail, row.n]); return null; }
    const p = byNumber.get(row.parent);
    const pd = depthOf(p, [...trail, row.n]);
    if (pd == null) return null;
    row.depth = pd + 1;
    return row.depth;
  };
  for (const row of rows) depthOf(row, []);
  for (const row of rows) {
    row.depthLabel = depthLabel(row.depth);
    if (row.depth != null && row.dependent) {
      const chain = [row.n]; let cur = row;
      while (cur.parent != null && byNumber.has(cur.parent) && chain.length <= rows.length) { cur = byNumber.get(cur.parent); chain.unshift(cur.n); }
      row.chain = chain;
    }
  }

  // 4. The report. Every bound reports what it dropped; the residue reports itself.
  const dep = rows.filter((r) => r.dependent);
  const report = {
    total: rows.length,
    independent: rows.length - dep.length,
    independentWhy: 'no dependent pattern matched (residue)',
    dependent: dep.length,
    resolved: dep.filter((r) => r.parent != null).length,
    ambiguous: dep.filter((r) => r.ambiguous).map((r) => ({ n: r.n, rule: r.rule, reason: r.ambiguous })),
    missingParent: dep.filter((r) => r.parents && r.missingParents.length).map((r) => ({ n: r.n, missing: r.missingParents })),
    multiParent: dep.filter((r) => r.parentChoice).map((r) => ({ n: r.n, chosen: r.parent, alternatives: r.parentChoice.alternatives, policy })),
    forward: dep.filter((r) => r.forward).map((r) => ({ n: r.n, parent: r.parent })),
    cycles,
    byDepth: Object.fromEntries([...new Set(rows.map((r) => r.depthLabel || 'unresolved'))].sort().map((k) => [k, rows.filter((r) => (r.depthLabel || 'unresolved') === k).length])),
    byContribution: Object.fromEntries(['ADDITION', 'MODIFICATION', 'UNDETERMINED', 'PRODUCT-BY-PROCESS', 'COMBINATION'].map((k) => [k, dep.filter((r) => r.contribution && r.contribution.kind === k).length])),
    lowConfidenceResidue: rows.filter((r) => !r.dependent && r.smell.length).map((r) => ({ n: r.n, reasons: r.smell })),
    policy,
  };
  return { claims: rows, byNumber, report };
}

/** The inherited chain for claim n, root first: [1, 3, 7] for a D2 claim 7 via 3. Null if unresolved. */
export function chainOf(result, n) {
  const row = result && result.byNumber && result.byNumber.get(Number(n));
  return row ? (row.dependent ? row.chain : [row.n]) : null;
}

/** Human-readable report lines, for CLI consumers. */
export function formatDepReport(result) {
  const r = result.report;
  const out = [`${r.total} claim(s): ${r.independent} independent (${r.independentWhy}), ${r.dependent} dependent, ${r.resolved} with a resolved parent`];
  out.push(`  depth: ${Object.entries(r.byDepth).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  out.push(`  contribution: ${Object.entries(r.byContribution).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  for (const a of r.ambiguous) out.push(`  AMBIGUOUS claim ${a.n} (${a.rule}): ${a.reason}`);
  for (const m of r.missingParent) out.push(`  claim ${m.n} depends on missing claim(s) ${m.missing.join(', ')}`);
  for (const m of r.multiParent) out.push(`  claim ${m.n}: multi-parent reference; chose ${m.chosen} by ${m.policy} (alternatives ${m.alternatives.join(', ')})`);
  for (const f of r.forward) out.push(`  claim ${f.n} depends forward on claim ${f.parent}`);
  for (const c of r.cycles) out.push(`  CYCLE: ${c.join(' -> ')} -- depth not assigned`);
  for (const l of r.lowConfidenceResidue) out.push(`  low-confidence residue: claim ${l.n} classified independent but ${l.reasons.join('; ')}`);
  return out;
}

/**
 * dep-claims-broaden-parent: claim differentiation as retrieval guidance.
 *
 * A MODIFICATION dependent narrowing an element to a species ("wherein said
 * gizmo is a widget") is presumptive evidence the parent's genus term covers
 * that species. The species words are exactly the vocabulary bridge lexical
 * retrieval lacks -- code-shaped where the genus term is claim-shaped. This
 * returns, per parent row, the fresh species WORDS the dependents donate,
 * with per-dependent provenance; it never pools sources and never touches
 * verdicts. ADDITION adds a limitation and broadens nothing; the cross-class
 * kinds are skipped with their kind named. Only DIRECT children of the
 * charted claim donate (a D2 narrows its own parent's row set, not the
 * root's); a multi-parent dependent contributes via its chosen parent only.
 *
 * Helpers are INJECTED (dependentBody, narrowedRowFor, contentWords, stem)
 * so this core module never imports from commands/ -- claim-chart owns the
 * row-matching machinery, and injection keeps this pure and cycle-free (the
 * same rule as loop-score's injected merge).
 *
 * @param {Array<{n:number,text:string}>} claims  the WHOLE input claim set
 * @param {Array<{text:string,index:number}>} parentRows  the charted claim's rows
 * @returns {{rows:Array<{row:number,words:string[],from:Array<{claim:number,words:string[]}>}>, unmatched:Array<{claim:number}>, skipped:Array<{claim:number,kind:string}>}}
 */
export function parentElementSynonyms(claims, parentRows, { rootN = null, dependentBody, narrowedRowFor, contentWords, stem } = {}) {
  const res = analyzeClaimSet(claims);
  const parentStems = new Set();
  for (const r of parentRows || []) for (const w of contentWords(r.text)) parentStems.add(stem(w));
  const byRow = new Map();
  const unmatched = [];
  const skipped = [];
  for (const row of res.claims) {
    if (!row.dependent) continue;
    if (rootN != null && row.parent !== Number(rootN)) continue;
    const kind = row.contribution && row.contribution.kind;
    if (kind !== 'MODIFICATION') { skipped.push({ claim: row.n, kind: kind || 'UNDETERMINED' }); continue; }
    const body = dependentBody(row.text);
    const match = narrowedRowFor(body, parentRows);
    if (!match) { unmatched.push({ claim: row.n }); continue; }
    const seen = new Set();
    const words = [];
    for (const w of contentWords(body)) {
      const s = stem(w);
      if (parentStems.has(s) || seen.has(s)) continue;
      seen.add(s);
      words.push(w);
    }
    if (!words.length) continue;
    const idx = match.row.index;
    if (!byRow.has(idx)) byRow.set(idx, { row: idx, words: [], from: [] });
    const entry = byRow.get(idx);
    for (const w of words) if (!entry.words.includes(w)) entry.words.push(w);
    entry.from.push({ claim: row.n, words });
  }
  return { rows: [...byRow.values()].sort((a, b) => a.row - b.row), unmatched, skipped };
}
