/**
 * claim-genericity.js -- is a claim element GENERIC (the bookend every system of the genre
 * satisfies) or a MECHANISM element (where a chart can be right or wrong about something)?
 *
 * Why this exists (claim-chart-element-classes, 2026-08-28; #310). On the 25 charts of 2026-08-27,
 * every PRESENT on a vocabulary-selected (claim, index) pair was a bookend -- "receiving an input
 * comprising an input text portion" -> a `query: str` parameter; "outputting a representation of the
 * identified documents" -> a retriever returning Documents; "providing one or more of the ordered
 * search results" -> `return ret`; "receiving a generic command from the user" -> `wmain(argc, argv)`.
 * Zero PRESENT on a mechanism element. A coverage headline that counts those rows together with the
 * mechanism rows reads as a partial hit and is not one.
 *
 * Two deterministic signals, no model:
 *
 *   1. STRUCTURE. A bookend is an input/output/storage step: its head verb is an I/O verb and it
 *      carries no mechanism cue (`based on`, `wherein`, `using`, `when`, `such that`, ...). This is
 *      what the calibration set actually shares -- their NOUNS are not generic at all (`documents`,
 *      `command` sit in under 2% of AI/ML claims), which is why a frequency rule alone mis-filed
 *      three of the four bookends as mechanism on the first cut.
 *   2. FREQUENCY, for everything else. Content words (claim-terms.js; claim boilerplate such as
 *      receiving / input / processor / storing is already STOP-listed) scored by document frequency
 *      in a claim corpus (claim-genre-df.json). Words the claim introduced in an EARLIER element are
 *      back-references, not new mechanism, so the caller passes the preceding elements as context.
 *      An element with no content words at all is generic by construction; one whose words are all
 *      common or back-referenced is generic; one carrying new rare words is a mechanism candidate.
 *
 * The thresholds are pinned by test/test_claim_genericity.js against the six bookends and the
 * mechanism elements of those charts; change them there first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentWords, stem } from './claim-terms.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DF_PATH = path.join(HERE, 'claim-genre-df.json');

/** A word is COMMON in the genre when it appears in at least this share of the corpus's claims. */
export const COMMON_SHARE = 0.02;
/** A non-bookend element is GENERIC when at least this share of its content words are common or back-referenced. */
export const GENERIC_THRESHOLD = 0.85;

/** Head verbs of input / output / storage steps -- the bookends. */
export const IO_VERBS = new Set([
  'receiving', 'receive', 'receives', 'obtaining', 'obtain', 'acquiring', 'acquire', 'accepting', 'accept',
  'inputting', 'reading', 'collecting', 'capturing', 'retrieving',
  'outputting', 'output', 'providing', 'provide', 'provides', 'transmitting', 'transmit', 'sending', 'send',
  'returning', 'return', 'presenting', 'present', 'displaying', 'display', 'delivering', 'deliver',
  'forwarding', 'forward', 'communicating', 'reporting', 'printing', 'rendering', 'emitting',
  'storing', 'store', 'stores', 'saving', 'recording', 'maintaining', 'persisting', 'caching',
  // Deliberately drafting-grammar verbs only. Genre words ("reproducing", "playing") were tried here
  // on the strength of one claim ('101, 2026-08-28) and removed: on the 380 litigated attorney element
  // sets they flipped 18 of 2,294 elements, and a rule list that carries an example claim's own
  // vocabulary tunes the yardstick instead of measuring it. Population evidence (negative-control
  // charts) is what admits a verb here.
]);

/** A relationship, condition or method-of-doing inside the element: not a bookend, whatever its verb. */
export const MECHANISM_CUE = /\b(based (?:at least in part )?(?:on|upon)|according to|as a function of|in response to|responsive to|such that|wherein|whereby|using|by (?:\w+ing)|if|when|whenever|whether|unless|only|comparing|matching|calculat\w+|comput\w+|determin\w+ whether)\b/i;

let _table = null;
function table() {
  if (_table) return _table;
  try { _table = JSON.parse(fs.readFileSync(DF_PATH, 'utf8')); }
  catch { _table = { profiles: {} }; }
  return _table;
}

/** Profiles available in the shipped table (e.g. ['ai-ml', 'litigated']). */
export function genericityProfiles() { return Object.keys(table().profiles || {}); }

/** Verbs that carry no action of their own: skipped when looking for the element's head verb. */
const NON_HEAD = new Set(['being', 'having', 'including', 'comprising', 'using', 'wherein', 'according', 'corresponding', 'during', 'following', 'existing', 'something', 'anything', 'nothing', 'everything']);

/**
 * The element's head verb and its form. Apparatus claims put the verb after `configured to` /
 * `operable to` / `adapted to` / `unit for` ("the content transmitting unit is configured to CHANGE the
 * code rate"), method steps put it after `using X to` ("using a processor to IDENTIFY"), and the `-ing`
 * inside a noun phrase ("transmitting unit") or a copula ("being equipped") is not it -- '101 rows 2, 4
 * and 8 were mis-filed on exactly those (2026-08-28). Otherwise the first `-ing` token among the first
 * six words, else the first word.
 * @returns {{verb:string, form:'base'|'ing'|'none'}}  `form` says whether the head is an action verb
 */
export function headVerbInfo(elementText) {
  const low = String(elementText || '').toLowerCase().replace(/^\s*(?:[a-z]|[0-9]+)\s*[).]\s*/, '');
  let m = low.match(/\b(?:configured|operable|adapted|arranged|programmed|operative)\s+(?:to|for)\s+([a-z]+)/);
  if (m) return { verb: m[1], form: 'base' };
  m = low.match(/\b(?:unit|module|means|component|device|processor|circuit|engine|logic)\s+for,?\s+(?:while\s+|when\s+|upon\s+)?([a-z]+ing)\b/);
  if (m) return { verb: m[1], form: 'ing' };
  m = low.match(/\busing\s+[^,;]{0,60}?\bto\s+([a-z]+)\b/);
  if (m) return { verb: m[1], form: 'base' };
  const toks = low.replace(/[^a-z\s-]+/g, ' ').split(/\s+/).filter(Boolean);
  const ing = toks.slice(0, 8).find((w) => w.endsWith('ing') && w.length > 4 && !NON_HEAD.has(w));
  if (ing) return { verb: ing, form: 'ing' };
  return { verb: toks[0] || '', form: 'none' };
}

/** The head verb alone (see headVerbInfo). */
export function headVerb(elementText) { return headVerbInfo(elementText).verb; }

/**
 * @param {string} elementText  one claim element / limitation
 * @param {object} [opts]
 * @param {string} [opts.profile='ai-ml']       which corpus's frequencies to score against
 * @param {string[]} [opts.context=[]]         the claim's PRECEDING elements (back-references are not new mechanism)
 * @returns {{kind:'generic'|'mechanism'|'unscored', reason:string, score:number, words:number,
 *            commonWords:string[], rareWords:string[], backReferenced:string[], headVerb:string, profile:string}}
 */
export function claimGenericity(elementText, opts = {}) {
  const profile = opts.profile || 'ai-ml';
  const text = String(elementText || '');
  const p = (table().profiles || {})[profile];
  const { verb, form } = headVerbInfo(text);
  const words = [...new Set(contentWords(text))];
  const base = { words: words.length, headVerb: verb, profile, commonWords: [], rareWords: [], backReferenced: [] };
  if (!p) return { ...base, kind: 'unscored', reason: `no "${profile}" profile in claim-genre-df.json`, score: 0, rareWords: words };
  if (!words.length) return { ...base, kind: 'generic', reason: 'no content words beyond claim boilerplate', score: 1 };
  const cue = MECHANISM_CUE.test(text);
  if (IO_VERBS.has(verb) && !cue) {
    return { ...base, kind: 'generic', reason: `input/output/storage step (${verb}) with no mechanism cue`, score: 1, commonWords: words };
  }
  // An ACTION verb that is not I/O -- change, start, determine, select, compare, identify -- is the
  // mechanism step itself, whatever its nouns: '101 row 8, "the content transmitting unit is
  // configured to change the code rate ... to the determined code rate", carries only nouns the claim
  // introduced earlier, and the frequency rule alone filed it generic (2026-08-28). Back-references
  // exempt NOUNS from counting as new mechanism; they do not make an action generic.
  if (form !== 'none' && !IO_VERBS.has(verb)) {
    return { ...base, kind: 'mechanism', reason: `action step (${verb}) that is not input/output/storage`, score: 0, rareWords: words };
  }
  const seen = new Set((opts.context || []).flatMap((c) => contentWords(c)).map(stem));
  const commonWords = [], rareWords = [], backReferenced = [];
  for (const w of words) {
    const df = p.df[w];
    const common = df != null && df / p.docs >= COMMON_SHARE;
    if (common) commonWords.push(w);
    else if (seen.has(stem(w))) backReferenced.push(w);
    else rareWords.push(w);
  }
  const score = +((commonWords.length + backReferenced.length) / words.length).toFixed(2);
  const kind = score >= GENERIC_THRESHOLD ? 'generic' : 'mechanism';
  return { ...base, kind, reason: kind === 'generic' ? 'content words all common in the genre or introduced earlier' : `new words rare in the genre: ${rareWords.join(', ')}`, score, commonWords, rareWords, backReferenced };
}

/**
 * The class a chart row carries: 'preamble' for the preamble row, else the genericity kind.
 * `isPreamble` is supplied by the caller (claim-locate's isPreambleRow) so this module stays free of
 * the splitter; `context` is the preceding elements.
 */
export function elementClass(elementText, { isPreamble = false, profile, context } = {}) {
  if (isPreamble) return 'preamble';
  return claimGenericity(elementText, { profile, context }).kind;
}

/** Classes for a whole element list, each scored with its predecessors as context. */
export function elementClasses(elements, { isPreambleRow, profile } = {}) {
  return (elements || []).map((e, i) => elementClass(e, {
    isPreamble: typeof isPreambleRow === 'function' ? !!isPreambleRow(e, i) : false,
    profile, context: elements.slice(0, i),
  }));
}

/** Tally verdicts by element class: {mechanism:{PRESENT..}, generic:{..}, preamble:{..}, unscored:{..}}. */
export function tallyByClass(rows) {
  const out = {};
  for (const r of rows || []) {
    const c = r.elementClass || 'unscored';
    out[c] = out[c] || { PRESENT: 0, PARTIAL: 0, ASSUMED: 0, ABSENT: 0, none: 0 };
    const v = r.verdict && out[c][r.verdict] != null ? r.verdict : 'none';
    out[c][v] += 1;
  }
  return out;
}

/** One line by class, mechanism first: "mechanism 4: 0 PRESENT · 2 PARTIAL · 2 ABSENT; generic 3: 2 PRESENT · 1 ABSENT; preamble 1". */
export function classHeadline(tally) {
  const order = ['mechanism', 'generic', 'preamble', 'unscored'];
  const parts = [];
  for (const c of order) {
    const t = tally[c]; if (!t) continue;
    const n = t.PRESENT + t.PARTIAL + t.ASSUMED + t.ABSENT + t.none;
    if (c === 'preamble') { parts.push(`preamble ${n}`); continue; }
    const bits = ['PRESENT', 'PARTIAL', 'ASSUMED', 'ABSENT'].filter((k) => t[k]).map((k) => `${t[k]} ${k}`);
    if (t.none) bits.push(`${t.none} no finding`);
    parts.push(`${c} ${n}: ${bits.join(' · ') || 'no rows'}`);
  }
  return parts.join('; ');
}
