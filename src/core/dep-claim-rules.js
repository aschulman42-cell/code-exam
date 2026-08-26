// Dependent-claim malformation rules: text -> facts about ONE claim.
//
// PROVENANCE. The thirteen named patterns below are ported from `claimlen.awk`
// (Andrew, 2007), which predates CE entirely. That file answers a boolean; this
// module answers WHICH RULE fired, because a named hit is what makes the
// taxonomy auditable and the next gap findable. Five further rules and two
// corrections come from re-measuring the originals against two corpora.
//
// SCOPE. One claim, one string, no chain resolution. Whether claim 7's parent
// is claim 3 is this module's job; whether claim 3 is itself dependent, and how
// deep the chain runs, belongs to the caller (`dep-claims.js`, #311).
//
// WHY THE RULES ARE UGLY. They describe malformations in OCR'd and
// hand-keyed patent text: `l` for `1`, `I` for `1`, `claimed` for `claim`,
// doubled prepositions, omitted numbers. They are not a grammar of English and
// should not be tidied into one -- each pattern is a class of real defect
// observed in a corpus, and a rule that stops naming a class stops earning its
// place.
//
// MEASUREMENT (dep_claims.csv, 615 rows, all containing the literal `of claim`;
// re-measured 2026-08-25). That file is a PHRASE FILTER, not a curated
// malformation set -- so its percentages describe claims containing `of claim`,
// never dependent claims generally. Counts per rule are in RULES below.

// Words that stand in for a claim number when the digit was never keyed.
const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};

// Characters that get OCR'd or typed in place of the digit 1. `i` is included
// on the same evidence as `l` and `I`; all three appear in the corpus.
const LETTER_ONE = /\bclaims?\s+[lIi]\b/;

/**
 * Remove the claim's OWN leading number ("7. The method of...") so it can never
 * be mistaken for the parent reference.
 *
 * THIS IS LOAD-BEARING, NOT HYGIENE. On 112 of 615 rows (18.2%) a naive
 * first-digit scan over the raw text returns the claim's own number -- the
 * claim resolves to ITSELF, producing a chain that terminates plausibly and is
 * wrong. A self-referential parent is worse than an unresolved one: an
 * unresolved parent announces itself, a self-reference does not.
 *
 * Measuring that trap is itself a trap. Strip first, then look for
 * self-reference, and the answer is zero -- because that measures the FIXED
 * behaviour. The 18.2% only appears if the scan runs on raw text, which is
 * exactly what a naive implementation does.
 */
export function stripOwnNumber(text) {
  const s = String(text == null ? '' : text).trim().replace(/^"+|"+$/g, '').trim();
  const m = s.match(/^\s*([0-9]+)\s*[.)]\s*/);
  return m ? { body: s.slice(m[0].length), own: Number(m[1]) } : { body: s, own: null };
}

// THE RULES, in priority order. `name` is reported on a hit.
//
// Order matters only for which name is REPORTED; every rule is tried until one
// fires. The length catch-all is deliberately last -- see LENGTH_CATCH_ALL.
export const RULES = [
  // --- the thirteen from claimlen.awk, two of them corrected ---
  {
    name: 'canonical',
    // WIDENED: the original demanded `claims? [1-9]` -- a space then a digit --
    // so "of claim, 1" and "of claim. 12" fell through. 41 rows of 615,
    // recovered by tolerating punctuation before the number.
    re: /\s(of|in|by|with|to|within)\s+claims?[\s.,]+[1-9]/i,
    note: 'the well-formed majority, plus punctuation before the number',
  },
  { name: 'method-of-n', re: /\smethod of [1-9]/, note: 'word "claim" omitted' },
  { name: 'system-as-recited-in-n', re: /system as recited in [1-9]/, note: 'word "claim" omitted' },
  { name: 'method-as-recited', re: /method as recited (in )?[1-9]/, note: 'word "claim" omitted' },
  { name: 'system-of-n', re: /system of [1-9]/, note: 'word "claim" omitted' },
  {
    name: 'lower-L-for-1',
    // CORRECTED. The original was /(in|of) claim l\,/ -- it required a trailing
    // COMMA. The malformation is `l` for `1`; what follows it is not part of
    // the malformation. 12 rows carry the comma, 6 do not, so the rule as
    // written missed a THIRD of its own class while looking like it worked.
    re: /\b(in|of|to)\s+claim\s+l\b/,
    note: 'lower-case L for 1 (trailing-punctuation requirement removed)',
  },
  {
    name: 'upper-I-for-1',
    // CORRECTED, same defect in the other direction: /(in|of|to) claim I / had
    // a trailing SPACE, so the comma form was invisible to it. 8 rows match as
    // written, 15 match without the requirement.
    re: /\b(in|of|to)\s+claim\s+I\b/,
    note: 'upper-case I for 1 (trailing-punctuation requirement removed)',
  },
  { name: 'method-of-step-n', re: /method of step [1-9]/, note: 'step-for-claim, validity uncertain' },
  { name: 'medium-of-n', re: /medium of [1-9]/, note: 'word "claim" omitted' },
  { name: 'according-to-hitachi', re: /according to (c[laim]+ )?[1-9I][0-9]*, wherein/, note: 'from the Hitachi samples' },
  { name: 'according-to-chopped', re: /according to claim$/, note: 'claim number truncated by the extractor' },

  // --- five classes the thirteen did not name; counts from dep_claims.csv ---
  {
    name: 'number-omitted',
    re: /\bof claims?\s+(wherein|further|in which|as claimed|according)/i,
    note: '63 rows: number never keyed, continuation follows directly',
  },
  {
    name: 'doubled-preposition',
    re: /\b(of|in)\s+claims?\s+(of|in)\s+[1-9]/i,
    note: '31 rows: preposition repeated after "claim" (checklist A17)',
  },
  {
    name: 'word-number',
    re: new RegExp('\\bclaims?\\s+(' + Object.keys(WORD_NUMBERS).join('|') + ')\\b', 'i'),
    note: '15 rows: number spelled as a word',
  },
  {
    name: 'article-inserted',
    re: /\bof claims?\s+(a|an|the)\s+[1-9]/i,
    note: '7 rows: article between "claim" and the number',
  },
  {
    name: 'claimed-for-claim',
    re: /\bof claimed\s+[1-9]/i,
    note: '6 rows: "claimed" for "claim"',
  },
  {
    name: 'no-number',
    // ORDER IS LOAD-BEARING, AND THIS RULE IS WHY IT SITS LAST AMONG THE NAMED.
    //
    // Kept verbatim from the awk, INCLUDING its narrowness: it names only
    // `method` and `system`, so `apparatus`, `process`, `device`, `valve` and
    // `circuit` fall straight through. It also never required a digit, so it
    // catches "The method of claim one" BY ACCIDENT -- and an accidental catch
    // is not coverage. That is how it masked the word-number and
    // number-omitted classes until a preamble outside that pair appeared.
    //
    // In its original fourth position it went on masking them HERE: the
    // fixtures resolved their parents correctly while reporting rule
    // "no-number" for six specimens belonging to lower-L, upper-I,
    // doubled-preposition, word-number and article-inserted. Parents right,
    // taxonomy destroyed -- and the taxonomy is the deliverable, since a hit
    // that cannot say which malformation it saw cannot tell anyone where the
    // next gap is. Demoted below the five named classes so each claims its own
    // hits and this one catches only the genuine remainder.
    re: /(method|system) of claim /,
    note: 'claim number never keyed (narrow: only method/system preambles)',
  },
];

// THE CATCH-ALL, kept LAST and kept a fallback.
//
// Short AND mentions a claim number. It caught 46 rows in the large corpus that
// no named pattern caught, mostly `clam` for `claim`. The named rules are a
// taxonomy of malformations already seen; this is the net for the unseen ones.
// Promote it above the named rules and every hit reports 'length-catch-all',
// destroying the taxonomy the names exist to build.
export const LENGTH_CATCH_ALL = {
  name: 'length-catch-all',
  test: (s) => s.length < 400 && /\bclai?ms? [1-9]/.test(s),
  note: 'short, and mentions a claim number; catches unnamed misspellings',
};

/**
 * Which rule, if any, says this claim is dependent. Returns the rule or null.
 */
export function detectDependency(text) {
  const s = String(text == null ? '' : text);
  for (const r of RULES) if (r.re.test(s)) return r;
  if (LENGTH_CATCH_ALL.test(s)) return LENGTH_CATCH_ALL;
  return null;
}

/**
 * Parent claim number(s) from a body that has ALREADY had its own number
 * stripped. Returns an array, or null when nothing is recoverable.
 */
export function resolveParents(body) {
  const s = String(body == null ? '' : body);

  // Ranges and lists first: "claims 1 to 4", "claim of 1, 2, 3 or 4".
  const listed = s.match(/\bclai?ms?\s+(?:of\s+|in\s+)?([0-9]+(?:\s*(?:,|or|and|to|through|-)\s*[0-9]+)+)/i);
  if (listed) {
    const parts = listed[1].split(/\s*(?:,|or|and|to|through|-)\s*/).map(Number).filter((n) => n > 0);
    if (parts.length) return [...new Set(parts)].sort((a, b) => a - b);
  }

  // clai?ms? not claims?: the length catch-all accepts clam, so a row it
  // DETECTS must be resolvable too, or the module reports an unrecoverable
  // parent that is sitting in plain sight (US8224503 claim 12, clam 11).
  const direct = s.match(/\bclai?ms?[\s.,]+(?:of\s+|in\s+|a\s+|an\s+|the\s+)?([1-9][0-9]*)\b/i)
    || s.match(/\bclaimed\s+([1-9][0-9]*)\b/i);
  if (direct) return [Number(direct[1])];

  const word = s.match(new RegExp('\\bclaims?\\s+(' + Object.keys(WORD_NUMBERS).join('|') + ')\\b', 'i'));
  if (word) return [WORD_NUMBERS[word[1].toLowerCase()]];

  // `l` / `I` / `i` for 1. Only ever means 1 -- there is no `claim l` meaning 50.
  if (LETTER_ONE.test(s)) return [1];

  // Last resort: a bare number after a preposition, for the rules that record
  // the word "claim" as omitted ("the method of 5, wherein..."). Deliberately
  // NOT a bare digit scan -- see stripOwnNumber.
  const bare = s.match(/\b(?:of|in|to|within|recited in)\s+([1-9][0-9]*)\b/i);
  if (bare) return [Number(bare[1])];

  return null;
}

/**
 * The whole module in one call. THREE outcomes, never two.
 *
 * The third exists because 95 of 615 rows (15.4%) are unmistakably dependent
 * and carry no recoverable parent at all. Folding that into an error path, or
 * into `dependent: false`, would misreport one row in six or seven: they are
 * not independent claims, and a residue count that includes them is wrong.
 *
 *   { dependent: false }                                    independent
 *   { dependent: true, parents: [7], rule, ... }            resolved
 *   { dependent: true, parents: null, ambiguous, rule, ... } parent UNKNOWABLE
 *
 * Detection and resolution have different ceilings and are reported
 * separately for that reason: on the measured slice detection reaches ~99%
 * while resolution cannot exceed 84.6%, because for the rest the number is
 * not in the text to find.
 */
export function classifyClaim(text) {
  const { body, own } = stripOwnNumber(text);
  const rule = detectDependency(body);
  if (!rule) return { dependent: false, own, rule: null, parents: null };

  const parents = resolveParents(body);
  if (!parents || !parents.length) {
    return {
      dependent: true,
      own,
      rule: rule.name,
      parents: null,
      ambiguous: 'dependent by rule "' + rule.name + '", but no parent claim number is recoverable from the text',
    };
  }
  // A resolved parent equal to the claim's own number is a self-reference. It
  // can only arise from a genuine typo in the source, and reporting it as a
  // parent would build a cyclic chain, so it is refused the same way an
  // unrecoverable one is -- named differently so the two stay countable apart.
  if (own != null && parents.length === 1 && parents[0] === own) {
    return {
      dependent: true,
      own,
      rule: rule.name,
      parents: null,
      ambiguous: 'resolved parent (' + own + ') is the claim’s own number; refusing a self-referential chain',
    };
  }
  return { dependent: true, own, rule: rule.name, parents };
}
