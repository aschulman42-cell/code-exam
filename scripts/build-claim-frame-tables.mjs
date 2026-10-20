// build-claim-frame-tables.mjs — frequency tables of the FRAME words of litigated software claims
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// build-claim-frame-tables.mjs -- what real claims say AROUND the invention: preamble openers and
// templates, transitions, element openers, dependent reference phrases and kinds, with counts. The
// shape profiles in src/commands/pseudo-claims.js say how MANY elements and dependents a litigated
// claim 1 carries; these tables say which WORDS carry them. Both feed the pseudo-claim drafter: the
// counts bound a claim object's lists, the tables fill its enums and pick its exemplars (#322).
//
//   node scripts/build-claim-frame-tables.mjs [--litigated litig_claims_gp/litigated_claims.jsonl]
//        [--fixture test/fixtures/litigated-claim1-structure.jsonl]
//        [--out src/core/claim-frame-tables.json] [--min-count 2] [--print]
//
// --print writes a Markdown digest of the tables to stdout after the JSON: the readable view, for a
// reviewer who should not have to read 150 KB of JSON to see what the population says.
//
// Inputs. The litigated corpus (385 families from litigated-claims-fetch.mjs: claim 1 plus its
// dependent chain, with the office's own parent numbers) is NOT in the repo; the structure fixture
// (380 claim 1s, the attorney's own element rows, preamble first) is. Claim-1 tables are built from
// the fixture so the test can rebuild them; dependent tables need the corpus. The JSON records which
// inputs it saw and their sizes, so a rebuild is a script run and a missing corpus is visible.
//
// The preamble CLASS rule is the one that split the fixture on 2026-09-01 for the `litigated-system`
// shape profile (method 187 / system 70 / crm 15 / jepson 35 / other 73), carried verbatim so that
// profile's source is reproducible. It is deliberately narrow: `other` holds the apparatus claims
// whose head noun is not in its short list ("a capacitive touch sensor panel", "a passive RF
// transponder"), and the head-noun table is what shows them. Re-derive, don't re-guess: a wider
// rule changes the profile's population, and that is a separate, measured decision.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { classifyClaim } from '../src/core/dep-claim-rules.js';
import { classifyContribution } from '../src/core/dep-claims.js';

export const CLAIM_CLASSES = ['method', 'system', 'crm', 'jepson', 'other'];

const NUMBER_PREFIX = /^\s*\d+\s*[.)]\s*/;
// The transition, with the plain-verb and "consisting" forms the fixture shows. `comprsing` (US
// 7702352) is a real typo and is reported, not matched. The LAST one in the preamble row is the
// claim's transition: "A method for processing data including metadata, comprising:" transitions
// on `comprising`, and a Jepson "In a system having ..., a method comprising:" likewise.
const TRANSITION = /\b(comprising|comprises|consisting essentially of|consisting of|including|includes|having|characterized (?:in|by)|wherein)\b/gi;

/** The 2026-09-01 preamble-class rule, verbatim (see the file comment). Input: claim text or its first row. */
export function preambleClass(text) {
  const s = String(text || '').replace(NUMBER_PREFIX, '').trim();
  if (/^in\s+a\b/i.test(s)) return 'jepson';
  if (/computer[- ](readable|usable)|storage medium|program product/i.test(s.slice(0, 120))) return 'crm';
  if (/^(a|an)?\s*(computer[- ]implemented\s+)?method\b/i.test(s)) return 'method';
  if (/^(a|an)\s+\w[\w-]*(\s+\w[\w-]*)?\s*(system|apparatus|device|server|terminal|controller|circuit)\b/i.test(s)
    || /^(a|an)\s+(system|apparatus|device|server|terminal|controller|circuit)\b/i.test(s)) return 'system';
  return 'other';
}

/**
 * The preamble row split at its LAST transition word: `preamble` before it, `transition`, and
 * `tail` after it ("the steps of", "a processor configured to") when the attorney's row runs on.
 */
export function preambleOf(text) {
  const s = String(text || '').replace(NUMBER_PREFIX, '').replace(/\s+/g, ' ').trim();
  let last = null;
  for (const m of s.matchAll(TRANSITION)) last = m;
  const clean = (t) => t.replace(/^[\s:,]+|[\s:,]+$/g, '');
  if (!last) return { preamble: clean(s), transition: null, tail: '' };
  return { preamble: clean(s.slice(0, last.index)), transition: last[1].toLowerCase().replace(/\s+/g, ' '), tail: clean(s.slice(last.index + last[0].length)) };
}

// The opener is the leading noun phrase -- article, modifiers, head noun -- up to the first word
// that starts the purpose or the body. "A non-transitory computer-readable medium storing
// instructions" opens with "a non-transitory computer-readable medium"; "In a computer system
// having a display, a method ..." opens with "in a computer system". A span past eight words is no
// opener (the row is not a noun phrase) and is reported, not guessed.
const OPENER_STOP = /\b(?:for|of|to|in|on|with|by|that|which|when|configured|operable|adapted|arranged|programmed|having|storing|stored|containing|comprising|comprises|including|includes|wherein|embodying|encoded|being|used|usable)\b|[,(:;]/i;

export function openerOf(preamble) {
  const s = String(preamble || '').trim();
  const m = OPENER_STOP.exec(s.replace(/^(?:in|for|with)\s+/i, (p) => ' '.repeat(p.length)));
  const span = (m ? s.slice(0, m.index) : s).trim().replace(/[\s,]+$/, '');
  const norm = span.toLowerCase().replace(/computer readable/g, 'computer-readable').replace(/machine readable/g, 'machine-readable').replace(/computer implemented/g, 'computer-implemented');
  const words = norm.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return { opener: null, rest: s };
  return { opener: norm, rest: s.slice(span.length).replace(/^[\s,]+/, '') };
}

/** The last word of the opener; null when no opener. */
export function headNoun(preamble) {
  const { opener } = openerOf(preamble);
  if (!opener) return null;
  const words = opener.replace(/[^\w\s-]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return words.length ? words[words.length - 1] : null;
}

// Frame tokens: the connective vocabulary a preamble is built from after its opener. A template
// keeps these in order and collapses every other run of words to `...`; an article is kept only
// when a head word follows it ("a method", "the system"), so the free purpose phrase does not leak
// its own articles into the skeleton. "A method for distributing programs to a server on a network,
// the method comprising" and "a method for routing packets, the method comprising" become one row.
export const FRAME_TOKENS = new Set(('for of to in on by with that which when executed executing storing stored thereon therein ' +
  'embodying embodied encoded containing instructions program code programs operations steps perform performing cause causes ' +
  'causing configured operable adapted arranged programmed use using comprising comprises including includes having wherein ' +
  'processor processors computer computers memory method process system device apparatus medium media product machine circuit ' +
  'server network controller terminal').split(/\s+/));
const HEAD_WORDS = new Set('method process system apparatus device medium media product computer processor processors machine program instructions code operations steps memory circuit server network controller terminal'.split(' '));
const ARTICLES = new Set(['a', 'an', 'the', 'said']);

export function preambleTemplate(preamble, transition) {
  const { opener, rest } = openerOf(preamble);
  const parts = [];
  if (opener) parts.push(opener); else parts.push('...');
  let gap = !opener;
  const words = rest.toLowerCase().replace(/[():;"]/g, ' ').replace(/,/g, ' , ').split(/\s+/).filter(Boolean).map((w) => w.replace(/[.]+$/, ''));
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === ',') { if (parts.length && parts[parts.length - 1] !== ',') parts.push(','); continue; }
    const keep = FRAME_TOKENS.has(w) || (ARTICLES.has(w) && HEAD_WORDS.has(words[i + 1] || ''));
    if (keep) { parts.push(w); gap = false; } else if (!gap) { parts.push('...'); gap = true; }
  }
  if (transition) parts.push(transition);
  return parts.join(' ').replace(/ ,/g, ',').replace(/,\s*(comprising|comprises|including|includes|having|wherein|consisting)/g, ', $1').trim();
}

// The skeleton is the coarse frame a drafter chooses between: opener, the connector that introduces
// the purpose (for / of / in ...), the purpose itself as `...`, the re-mention of the head noun that
// some attorneys close the preamble with (", the method"), the transition, and a "the steps of"
// tail. "A method for distributing programs to a server on a network, the method comprising the
// steps of:" is `a method for ..., the method comprising the steps of`.
const CONNECTOR = /^(?:for|of|in|to|on|with|by|that|which|storing|having|containing|embodying|encoded|comprising|configured|operable|adapted|wherein|including)$/;
const TAIL_KEEP = /^the\s+(?:[\w-]+\s+)?(?:steps?|following)\b/;

export function preambleSkeleton(preamble, transition, tail) {
  const { opener, rest } = openerOf(preamble);
  const parts = [opener || '...'];
  const words = rest.toLowerCase().replace(/[():;"]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length) {
    const connector = CONNECTOR.test(words[0]) ? words[0] : null;
    if (connector) parts.push(connector);
    const segs = rest.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
    const last = segs.length > 1 ? segs[segs.length - 1] : '';
    const rem = /^(the|said)\s+((?:[\w-]+\s+){0,2}[\w-]+)\s*$/.exec(last);
    const mention = rem && HEAD_WORDS.has(rem[2].split(/\s+/).pop()) ? `, ${rem[1]} ${rem[2]}` : null;
    const body = mention ? words.length - last.split(/\s+/).length : words.length;
    if (body > (connector ? 1 : 0)) parts.push('...');
    if (mention) parts.push(mention);
  }
  if (transition) parts.push(transition);
  if (tail) { const tw = tail.toLowerCase().split(/\s+/).slice(0, 4).join(' '); if (TAIL_KEEP.test(tw)) parts.push(tw.split(/\s+/).slice(0, 3).join(' ')); }
  return parts.join(' ').replace(/ ,/g, ',');
}

const ENUMERATOR = /^(?:\(?(?:[a-z]|[ivx]{1,4}|\d{1,2})[.)]\s+)+/i;
const STEP_OF = /^(?:the\s+)?steps?\s+of\s+/i;
const WHEREIN_ROW = /^\s*(?:and\s+)?(?:wherein|whereby|where|in which)\b/i;
const APPARATUS_FORMS = [
  /\bconfigured to\b/i, /\boperable to\b/i, /\badapted to\b/i, /\barranged to\b/i, /\bprogrammed to\b/i,
  /\bmeans for\b/i, /\bexecutable (?:by|to)\b/i, /\bwhen executed\b/i, /\bcaus(?:e|es|ing) the\b/i,
];

/** Per element row (preamble excluded): first token, first two, the opener's kind, and apparatus forms. */
export function elementOpeners(lines) {
  const rows = (lines || []).slice(1);
  const out = [];
  for (const raw of rows) {
    let s = String(raw || '').replace(/^[\s\-–—]+/, '').trim();
    s = s.replace(ENUMERATOR, '').replace(/^\s*(?:and|or)\s+/i, '').replace(ENUMERATOR, '').replace(STEP_OF, '').trim();
    const words = s.toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const first = words[0], two = words.slice(0, 2).join(' ');
    let kind = 'other';
    if (WHEREIN_ROW.test(s)) kind = 'wherein';
    else if (/^(?:a|an|the|said|one|at|each|plurality)$/.test(first)) kind = 'noun-phrase';
    else if (/ing$/.test(first) && first.length > 4) kind = 'gerund';
    else if (first === 'means') kind = 'means';
    const forms = APPARATUS_FORMS.map((re) => (re.exec(s) || [null])[0]).filter(Boolean).map((f) => f.toLowerCase().replace(/\s+/g, ' '));
    out.push({ first, two, kind, forms });
  }
  return out;
}

const REFERENCE = /\b((?:of|according to|as (?:recited|claimed|defined|set forth|described|stated|specified) in|as in|in|recited in|per|under)\s+clai?ms?)\b/i;
// `(?:\d+|\b[lIi]\b)`: the OCR'd `claim l` that dep-claim-rules.js reads as claim 1 still has an opener.
const DEP_OPENER = /\bclai?ms?\s+[\w,\s-]*?(?:\d+|\b[lIi]\b)\s*,?\s*(and\s+)?(further\s+comprising|further\s+including|further\s+having|further\s+configured|further\s+comprises|wherein|whereby|where|in\s+which|which|comprising|including|characterized)\b/i;

/**
 * The frame of ONE dependent claim: who it names (subject, reduced to its opener), how it refers
 * (reference phrase), what it opens with after the number, what it contributes (dep-claims'
 * classifier), and the parent dep-claim-rules reads from the text. The office's parent, when the
 * caller has it, is compared outside. Malformed text (`claim l`, `claimed 3`) is the rules
 * module's business, not this function's.
 */
export function dependentFrame(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const ref = REFERENCE.exec(s);
  const reference = ref ? ref[1].toLowerCase().replace(/\bclai?ms?\b/, 'claim') : null;
  const rawSubject = ref ? s.slice(0, ref.index).replace(/[\s,]+$/, '') : null;
  const subject = rawSubject ? (openerOf(rawSubject).opener || rawSubject.toLowerCase()) : null;
  const op = DEP_OPENER.exec(s);
  const opener = op ? `${op[1] ? 'and ' : ''}${op[2].toLowerCase().replace(/\s+/g, ' ')}` : null;
  const contribution = classifyContribution(s).kind;
  const parsed = classifyClaim(s);
  return { subject, reference, opener, contribution, parents: parsed.dependent ? parsed.parents : null };
}

/** Counts -> ranked `{value, count, share}` rows; share is of ALL values, min-count filters the rows kept. */
export function tally(values, minCount = 1) {
  const m = new Map();
  let total = 0;
  for (const v of values) { if (v == null || v === '') continue; total++; m.set(v, (m.get(v) || 0) + 1); }
  const rows = [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .filter(([, c]) => c >= minCount).map(([value, count]) => ({ value, count, share: +(count / Math.max(1, total)).toFixed(3) }));
  return { total, distinct: m.size, rows };
}

function quantiles(arr) {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return null;
  const q = (p) => s[Math.min(s.length - 1, Math.round(p * (s.length - 1)))];
  return { n: s.length, median: q(0.5), p10: q(0.1), p90: q(0.9), max: s[s.length - 1] };
}

function byClass(items, classOf, pick, minCount) {
  const out = { all: tally(items.flatMap(pick), minCount) };
  for (const c of CLAIM_CLASSES) {
    const sub = items.filter((it) => classOf(it) === c);
    if (sub.length) out[c] = tally(sub.flatMap(pick), minCount);
  }
  return out;
}

/** Claim-1 tables from structure rows `{patent, text, lines}` (the fixture's shape). */
export function claim1Tables(rows, minCount = 2) {
  const items = rows.map((r) => {
    const cls = preambleClass(r.text || r.lines?.[0]);
    const { preamble, transition, tail } = preambleOf(r.lines?.[0] || r.text);
    const { opener } = openerOf(preamble);
    return { patent: r.patent, cls, preamble, transition, tail, opener, head: headNoun(preamble), template: preambleTemplate(preamble, transition), skeleton: preambleSkeleton(preamble, transition, tail), elements: elementOpeners(r.lines || []) };
  });
  const cls = (it) => it.cls;
  return {
    rows: items.length,
    classes: tally(items.map(cls)),
    preambles: {
      openers: byClass(items, cls, (it) => [it.opener], minCount),
      headNouns: byClass(items, cls, (it) => [it.head], minCount),
      skeletons: byClass(items, cls, (it) => [it.skeleton], minCount),
      templates: byClass(items, cls, (it) => [it.template], minCount),
      withoutTransition: items.filter((it) => !it.transition).map((it) => ({ patent: it.patent, row: it.preamble.slice(0, 80) })),
      withoutOpener: items.filter((it) => !it.opener).map((it) => ({ patent: it.patent, cls: it.cls, row: it.preamble.slice(0, 80) })),
    },
    transitions: byClass(items, cls, (it) => [it.transition], 1),
    transitionTails: byClass(items, cls, (it) => [it.tail ? it.tail.toLowerCase().split(/\s+/).slice(0, 4).join(' ') : '(none)'], minCount),
    elements: {
      rowsPerClaim: quantiles(items.map((it) => it.elements.length)),
      firstWord: byClass(items, cls, (it) => it.elements.map((e) => e.first), minCount),
      firstTwoWords: byClass(items, cls, (it) => it.elements.map((e) => e.two), minCount),
      openerKinds: byClass(items, cls, (it) => it.elements.map((e) => e.kind), 1),
      apparatusForms: byClass(items, cls, (it) => it.elements.flatMap((e) => e.forms), minCount),
    },
  };
}

/** Dependent tables from corpus records `{claim1:{text}, family1:[{n,parent,depth,multiParent,text}]}`. */
export function dependentTables(records, minCount = 2) {
  const fams = records.map((r) => ({ cls: preambleClass(r.claim1?.text), deps: (r.family1 || []).map((d) => ({ ...d, frame: dependentFrame(d.text) })) }));
  const deps = fams.flatMap((f) => f.deps.map((d) => ({ cls: f.cls, ...d })));
  const cls = (d) => d.cls;
  let agree = 0, disagree = 0, unresolved = 0;
  for (const d of deps) {
    if (!d.frame.parents) unresolved++;
    else if (d.frame.parents.includes(d.parent)) agree++;
    else disagree++;
  }
  const openersByDepth = {};
  for (const depth of [...new Set(deps.map((d) => d.depth))].sort((a, b) => a - b)) {
    openersByDepth[depth] = tally(deps.filter((d) => d.depth === depth).map((d) => d.frame.opener), minCount);
  }
  return {
    families: fams.length,
    dependents: deps.length,
    classesOfClaim1: tally(fams.map((f) => f.cls)),
    referencePhrases: byClass(deps, cls, (d) => [d.frame.reference], minCount),
    withoutReference: deps.filter((d) => !d.frame.reference).length,
    subjects: byClass(deps, cls, (d) => [d.frame.subject], minCount),
    openers: byClass(deps, cls, (d) => [d.frame.opener], minCount),
    withoutOpener: deps.filter((d) => !d.frame.opener).length,
    openersByDepth,
    contributions: byClass(deps, cls, (d) => [d.frame.contribution], 1),
    perFamily: {
      dependents: quantiles(fams.map((f) => f.deps.length)),
      maxDepth: quantiles(fams.map((f) => f.deps.reduce((m, d) => Math.max(m, d.depth || 0), 0))),
    },
    depthDistribution: tally(deps.map((d) => d.depth)),
    multiParent: deps.filter((d) => d.multiParent).length,
    parentAgreement: { agree, disagree, unresolved, note: 'dep-claim-rules.js parent vs the office markup parent, on dependents of claim 1 only' },
  };
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/** A Markdown digest of the tables -- the readable view of the JSON, for a reviewer (`--print`). */
export function digest(out, n = 10) {
  const L = [];
  const tbl = (title, t, k = n) => {
    if (!t || !t.rows) return;
    L.push(`**${title}** — ${t.total} values, ${t.distinct} distinct`, '', '| count | share | value |', '|---:|---:|---|');
    for (const r of t.rows.slice(0, k)) L.push(`| ${r.count} | ${(r.share * 100).toFixed(1)}% | ${String(r.value).replace(/\|/g, '\\|')} |`);
    L.push('');
  };
  const q = (label, x) => x && L.push(`- ${label}: median ${x.median}, p10 ${x.p10}, p90 ${x.p90}, max ${x.max} (n ${x.n})`);
  L.push(`## Claim-frame tables, built ${out.builtAt} (min-count ${out.minCount})`, '');
  for (const [k, v] of Object.entries(out.inputs || {})) L.push(`- ${k}: \`${v.path}\` — ${Object.entries(v).filter(([kk]) => !['path', 'note'].includes(kk)).map(([kk, vv]) => `${kk} ${vv}`).join(', ')}`);
  L.push('');
  const c = out.claim1;
  if (c) {
    L.push('### Claim 1 (fixture)', '');
    tbl('Preamble class', c.classes);
    tbl('Openers, all classes', c.preambles.openers.all, 12);
    for (const k of ['method', 'system', 'crm', 'jepson', 'other']) tbl(`Skeletons, ${k}`, c.preambles.skeletons[k], k === 'method' ? 12 : 6);
    tbl('Head nouns of `other`', c.preambles.headNouns.other, 8);
    tbl('Transitions', c.transitions.all, 6);
    tbl('After the transition', c.transitionTails.all, 5);
    L.push('**Element rows beyond the preamble**', '');
    q('rows per claim', c.elements.rowsPerClaim);
    L.push('');
    for (const k of ['method', 'system', 'crm']) tbl(`Element opener kind, ${k}`, c.elements.openerKinds[k], 5);
    tbl('Element first word, method', c.elements.firstWord.method, 12);
    tbl('Element first two words, system', c.elements.firstTwoWords.system, 10);
    tbl('Apparatus forms, all classes', c.elements.apparatusForms.all, 8);
  }
  const d = out.dependents;
  if (d) {
    L.push(`### Dependents of claim 1 (corpus: ${d.families} families, ${d.dependents} dependents)`, '');
    tbl('Reference phrase', d.referencePhrases.all, 8);
    L.push(`- without a reference phrase: ${d.withoutReference}; without a recognised opener: ${d.withoutOpener}; multi-parent: ${d.multiParent}`, '');
    tbl('Opener after the claim number', d.openers.all, 8);
    tbl('Contribution (dep-claims.js)', d.contributions.all, 5);
    for (const k of ['method', 'system', 'crm']) tbl(`Subject, ${k} families`, d.subjects[k], 5);
    L.push('**Per family**', '');
    q('dependents', d.perFamily.dependents);
    q('max depth', d.perFamily.maxDepth);
    L.push(`- depth distribution: ${d.depthDistribution.rows.map((r) => `${r.value}: ${r.count}`).join(', ')}`);
    L.push(`- parent read from the text vs the office markup: ${d.parentAgreement.agree} agree, ${d.parentAgreement.disagree} disagree, ${d.parentAgreement.unresolved} unresolved`, '');
  }
  return L.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] != null ? argv[i + 1] : d; };
  const LIT = opt('--litigated', 'litig_claims_gp/litigated_claims.jsonl');
  const FIX = opt('--fixture', 'test/fixtures/litigated-claim1-structure.jsonl');
  const OUT = opt('--out', 'src/core/claim-frame-tables.json');
  const MIN = Number(opt('--min-count', '2'));
  const out = {
    builtAt: new Date().toLocaleDateString('sv'), // local calendar date, the one the ledger records
    note: 'frame words of litigated software claims, with counts; see scripts/build-claim-frame-tables.mjs (#322)',
    minCount: MIN,
    rules: {
      preambleClass: 'the 2026-09-01 rule, verbatim in preambleClass(): jepson = opens "In a"; crm = computer-readable/usable, storage medium or program product in the first 120 characters; method = "[a|an] [computer-implemented] method" head; system = [a|an] + up to two modifiers + system|apparatus|device|server|terminal|controller|circuit; other = the rest',
      transition: 'the LAST transition word in the attorney’s preamble row; the text after it is the tail ("the steps of")',
      opener: 'the leading noun phrase up to the first purpose or body word (for / of / to / configured / having / storing / comprising ...); over eight words is no opener',
      skeleton: 'opener, the connector that introduces the purpose, the purpose as "...", a closing re-mention of the head noun (", the method") when present, the transition, and a "the steps of" tail',
      template: 'opener kept; after it only frame tokens are kept, in order, an article only before a head word, every other run of words collapsed to "..."; the transition closes it',
      frameTokens: [...FRAME_TOKENS],
    },
    inputs: {},
  };
  if (fs.existsSync(FIX)) {
    const rows = readJsonl(FIX);
    out.inputs.fixture = { path: FIX, rows: rows.length, note: 'claim 1 only; lines = the attorney’s own element rows, preamble first' };
    out.claim1 = claim1Tables(rows, MIN);
  } else console.error(`fixture not found: ${FIX} (claim-1 tables skipped)`);
  if (fs.existsSync(LIT)) {
    const recs = readJsonl(LIT);
    out.inputs.litigated = { path: LIT, families: recs.length, dependentsOfClaim1: recs.reduce((n, r) => n + (r.family1 || []).length, 0), claims: recs.reduce((n, r) => n + (r.allClaims || []).length, 0), note: 'not in the repo; litigated-claims-fetch.mjs output' };
    out.dependents = dependentTables(recs, MIN);
  } else console.error(`litigated corpus not found: ${LIT} (dependent tables skipped)`);
  if (!out.claim1 && !out.dependents) { console.error('no inputs; nothing written'); process.exit(2); }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  if (out.claim1) console.error(`claim 1: ${out.claim1.rows} rows; classes ${out.claim1.classes.rows.map((r) => `${r.value} ${r.count}`).join(', ')}; ${out.claim1.preambles.templates.all.distinct} templates (${out.claim1.preambles.templates.all.rows.length} kept), ${out.claim1.preambles.withoutTransition.length} without a transition, ${out.claim1.preambles.withoutOpener.length} without an opener`);
  if (out.dependents) console.error(`dependents: ${out.dependents.dependents} in ${out.dependents.families} families; parent agreement ${out.dependents.parentAgreement.agree}/${out.dependents.dependents} (${out.dependents.parentAgreement.unresolved} unresolved); ${out.dependents.withoutReference} without a reference phrase`);
  console.error(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
  if (argv.includes('--print')) process.stdout.write(digest(out) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
