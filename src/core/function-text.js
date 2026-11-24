// function-text.js — text for one function, class or file built from the index alone, no model: name words, ranked body vocabulary, comment words and string literals, and the names around it; for the embedding measurement in scripts/function-text-reach.mjs
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * src/core/function-text.js — function-text-reach-test (2026-11-14).
 *
 * Every embedding measurement before this one embedded raw code per function
 * (docs/embedding-reach.md) or a label, member names or a model's sentence per
 * mechanism (docs/describe-reach.md). This module makes the text a model was
 * never asked for: what CodeExam can say about a function mechanically. Four
 * arms, each holding the one before:
 *
 *   name      the name as words ("secp256k1 fe get b32")
 *   vocab     plus the identifiers of the body that are rare in the index, as words
 *   comments  plus the function's comments (the block above it and those inside)
 *             and the words of its string literals
 *   context   plus the file and class it sits in, the functions it calls and
 *             the functions that call it, by name
 *
 * A class or a file gets the same recipe over its functions (unitChunks): the
 * ranked vocabulary of the whole unit, and of each run of UNIT_RUN functions,
 * so a 400-function file is many short texts scored by the best one.
 *
 * Calls are read by name: an identifier followed by "(" that is the last
 * segment of a function the index defines. No resolution, so two functions of
 * one name are one name here; that is enough for text and far cheaper than the
 * resolved reader of src/core/calls.js over every function of an index.
 *
 * Pure: buildCorpus takes a function index and a way to get a file's lines.
 */
import { splitName } from './embed.js';
import { isTestAttributedFunction } from './test-attribute.js';

export const ARMS = ['name', 'vocab', 'comments', 'context'];
/** Body identifiers kept per function, comment characters kept, literal words kept, names kept per side of a call. */
export const VOCAB_TOP = 24;
export const COMMENT_CHARS = 400;
export const STRING_WORDS = 16;
export const CALL_NAMES = 8;
/** Functions per chunk of a class or file text, and identifiers kept per chunk. */
export const UNIT_RUN = 12;
export const UNIT_TOP = 32;

const HASH_COMMENT = /\.(py|pyw|rb|sh|bash|zsh|pl|pm|r|yaml|yml|toml|tcl|mk|cmake|ex|exs|jl|nim|ps1)$/i;
const PY = /\.(py|pyw)$/i;

// Words a programming language supplies, which say nothing about a function.
// IDF removes most of them on a large index; on a 150-function one it cannot.
const STOP = new Set(('abstract and any as assert async auto await bool boolean break byte case catch char class const continue def default defer del delete do double dyn elif else end enum except explicit export extends extern false final finally float fn for foreach friend from func function go goto if impl implements import in include inline instanceof int interface is lambda let long loop match mod module mut namespace new nil none not null nullptr object of operator or override package pass private protected pub public raise ref register return self short signed sizeof static str string struct super switch template then this throw throws trait true try type typedef typename typeof uint undefined union unsigned use using val var virtual void volatile where while with yield size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t std').split(' '));

export const leafOf = (name) => String(name || '').split(/::|\.|#/).pop();
/** The class a qualified name sits in ("A::B::f" -> "A::B"), or '' for a free function. */
export function classOf(name) {
  const s = String(name || '');
  const i = Math.max(s.lastIndexOf('::'), s.lastIndexOf('.'), s.lastIndexOf('#'));
  return i > 0 ? s.slice(0, i) : '';
}
/** An identifier as lower-case words. */
export const phrase = (id) => splitName(String(id || '').replace(/@\d+$/, '')).toLowerCase();   // "name@53" is the index's mark for a second definition
const baseOf = (file) => String(file || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');

/**
 * A source text as { code, comments, strings }: the code with comments and
 * string literals blanked, the comment text with its markers removed, and the
 * literals' contents. `file` picks the comment syntax (# for the languages that
 * use it, docstrings for Python).
 */
export function splitSource(text, file = '') {
  const hash = HASH_COMMENT.test(file);
  const py = PY.test(file);
  const parts = [];
  if (py) parts.push('"""[\\s\\S]*?"""', "'''[\\s\\S]*?'''");
  parts.push('/\\*[\\s\\S]*?\\*/');
  parts.push(hash ? '#[^\\n]*' : '//[^\\n]*');
  parts.push('"(?:\\\\.|[^"\\\\\\n])*"', "'(?:\\\\.|[^'\\\\\\n])*'", '`(?:\\\\.|[^`\\\\])*`');
  const re = new RegExp(parts.join('|'), 'g');
  const comments = [];
  const strings = [];
  const code = String(text || '').replace(re, (m) => {
    if (m.startsWith('/*')) comments.push(m.slice(2, -2).replace(/^\s*\*+ ?/gm, ''));
    else if (m.startsWith('//')) comments.push(m.replace(/^\/\/+!?\s?/, ''));
    else if (hash && m.startsWith('#')) comments.push(m.replace(/^#+!?\s?/, ''));
    else if (py && (m.startsWith('"""') || m.startsWith("'''"))) comments.push(m.slice(3, -3));
    else strings.push(m.slice(1, -1));
    return ' ';
  });
  return { code, comments: comments.join(' ').replace(/\s+/g, ' ').trim(), strings };
}

/**
 * Comment text without ruled lines: a run of three or more of one of `= - _ * # ~ +` is a
 * banner's rule (`// ======== Accordion left pane ========`, `// --- report ---`), not
 * words. Two are kept, so `--flag` and `a == b` in a comment survive. Left in, a
 * 72-character rule took a fifth of the 400 characters a function's comment is given, twice
 * over for a boxed heading, and was embedded with the rest (19 function texts on CodeExam's
 * own index, 2026-11-23; Andrew, reading --show-function-text: "frequent occurrences of
 * ====="). The words between the rules stay.
 */
export const withoutRules = (text) => String(text || '').replace(/([=\-_*#~+])\1{2,}/g, ' ').replace(/\s+/g, ' ').trim();

/** The comment lines directly above line `start` (1-based), nearest last, at most `max` lines; '' when the line above is not a comment. */
export function leadingComment(lines, start, file = '', max = 12) {
  const hash = HASH_COMMENT.test(file);
  const isComment = (l) => (hash ? /^\s*#(?!!)/.test(l) : /^\s*(\/\/|\/\*|\*)/.test(l));
  const out = [];
  for (let i = start - 2; i >= 0 && out.length < max; i--) {
    const l = lines[i];
    if (l == null || !isComment(l)) break;
    out.unshift(l.replace(/^\s*(\/\/+|\/\*+|\*+\/?|#+)\s?/, '').replace(/\*\/\s*$/, ''));
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Identifier -> count over a code text, language words and one- and two-letter names left out. */
export function identifierCounts(code) {
  const tf = new Map();
  for (const m of String(code || '').matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const id = m[0];
    if (id.length < 3 || STOP.has(id.toLowerCase())) continue;
    tf.set(id, (tf.get(id) || 0) + 1);
  }
  return tf;
}

/** The names called in a code text: identifiers followed by "(" whose name is in `known`, in order of first use. */
export function calledNames(code, known) {
  const out = [];
  const seen = new Set();
  for (const m of String(code || '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    const id = m[1];
    if (seen.has(id) || !known.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The words of string literals worth keeping: letters only, three or more, each once, in order. */
export function literalWords(strings, max = STRING_WORDS) {
  const out = [];
  const seen = new Set();
  for (const s of strings || []) {
    for (const m of String(s).matchAll(/[A-Za-z]{3,}/g)) {
      const w = m[0].toLowerCase();
      if (seen.has(w) || STOP.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** The identifiers of `tf` ranked by (1 + ln tf) x ln(N / df), ties by name, the top `top`; `skip` names are left out. */
export function rankIdentifiers(tf, df, nDocs, top = VOCAB_TOP, skip = null) {
  const rows = [];
  for (const [id, n] of tf) {
    if (skip && skip.has(id)) continue;
    const d = df.get(id) || 1;
    const w = (1 + Math.log(n)) * Math.log(Math.max(nDocs, 2) / d);
    if (w > 0) rows.push([id, w]);
  }
  rows.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return rows.slice(0, top).map((r) => r[0]);
}

/**
 * Everything the texts need, from a function index ({ file: { name: { start, end } } })
 * and `linesOf(file) -> string[] | null`. Returns
 * { fns: [{ id, file, name, cls, start, end, tf, comments, strings, calls }], df, n, callersOf, rangesRead }.
 * A function whose file has no lines keeps its name and nothing else.
 *
 * A file's lines are read once per distinct line range, not once per function
 * (function-corpus-minified-stall, 2026-11-19). A function record has a start and an end
 * line and no column, so the functions of a minified file share a line, thousands to one,
 * and each got the whole line split and counted again: on an index with three such files
 * (10,918 functions on 946 ranges) that was 1.7 GB of text and 58 s before any search.
 * Functions on one range share one `tf` Map and one `strings` array, which nothing writes
 * to after this returns; a caller that needs to change them copies. `rangesRead` is how
 * many ranges were read. What each function gets is what it got before.
 */
export function buildCorpus(functionIndex, linesOf) {
  const fns = [];
  const known = new Set();
  for (const funcs of Object.values(functionIndex || {})) for (const name of Object.keys(funcs || {})) known.add(leafOf(name));
  let rangesRead = 0;
  for (const [rawFile, funcs] of Object.entries(functionIndex || {})) {
    const file = rawFile.replace(/\\/g, '/');
    const lines = linesOf(rawFile) || null;
    const byRange = new Map();   // "start-end" -> what the split of those lines gave
    for (const [name, info] of Object.entries(funcs || {})) {
      if (!info || info.start == null || info.end == null) continue;
      const f = { id: `${file}@${name}`, file, name, cls: classOf(name), start: info.start, end: info.end, tf: new Map(), comments: '', strings: [], calls: [] };
      if (lines) {
        // A test inside a source file (Rust `#[test]`): marked, so a search can leave it out.
        if (isTestAttributedFunction(lines, info.start)) f.test = true;
        const key = `${info.start}-${info.end}`;
        let r = byRange.get(key);
        if (!r) {
          const src = splitSource(lines.slice(info.start - 1, info.end).join('\n'), file);
          r = { tf: identifierCounts(src.code), comments: withoutRules([leadingComment(lines, info.start, file), src.comments].filter(Boolean).join(' ')), strings: src.strings, calls: calledNames(src.code, known) };
          byRange.set(key, r);
          rangesRead++;
        }
        f.tf = r.tf;
        f.comments = r.comments;
        f.strings = r.strings;
        const own = leafOf(name);
        f.calls = r.calls.filter((c) => c !== own);
      }
      fns.push(f);
    }
  }
  const df = new Map();
  for (const f of fns) for (const id of f.tf.keys()) df.set(id, (df.get(id) || 0) + 1);
  const callersOf = new Map();
  for (const f of fns) for (const c of f.calls) { if (!callersOf.has(c)) callersOf.set(c, []); callersOf.get(c).push(leafOf(f.name)); }
  return { fns, df, n: fns.length, callersOf, rangesRead };
}

/** The text of one function under `arm` (one of ARMS). */
export function functionText(f, arm, corpus) {
  const level = ARMS.indexOf(arm);
  if (level < 0) throw new Error(`function text arm is one of ${ARMS.join(', ')}; got "${arm}"`);
  const own = new Set([leafOf(f.name)]);
  let t = phrase(f.name);
  if (level >= 1) {
    const ids = rankIdentifiers(f.tf, corpus.df, corpus.n, VOCAB_TOP, own);
    if (ids.length) t += `: ${ids.map(phrase).join(', ')}`;
  }
  if (level >= 2) {
    if (f.comments) t += `. ${f.comments.slice(0, COMMENT_CHARS)}`;
    const w = literalWords(f.strings);
    if (w.length) t += `. Text: ${w.join(' ')}`;
  }
  if (level >= 3) {
    t += `. In ${phrase(baseOf(f.file))}${f.cls ? `, ${phrase(f.cls)}` : ''}`;
    if (f.calls.length) t += `. Calls ${f.calls.slice(0, CALL_NAMES).map(phrase).join(', ')}`;
    const by = [...new Set(corpus.callersOf.get(leafOf(f.name)) || [])].filter((c) => c !== leafOf(f.name));
    if (by.length) t += `. Called by ${by.slice(0, CALL_NAMES).map(phrase).join(', ')}`;
  }
  return t;
}

/**
 * The pieces functionText joins for the `comments` arm, kept apart so a listing can show
 * which piece a text is mostly made of (--show-function-text -v): { name, identifiers: [..],
 * comment, strings: [..] }. functionText(f, 'comments', corpus) is these four joined as
 * `name: identifiers. comment. Text: strings`, an empty piece and its separator left out.
 */
export function functionTextParts(f, corpus) {
  const own = new Set([leafOf(f.name)]);
  return {
    name: phrase(f.name),
    identifiers: rankIdentifiers(f.tf, corpus.df, corpus.n, VOCAB_TOP, own).map(phrase),
    comment: f.comments ? f.comments.slice(0, COMMENT_CHARS) : '',
    strings: literalWords(f.strings),
  };
}

/**
 * The texts of a class or file: the label with the unit's ranked vocabulary,
 * then, when the unit has more than `run` functions, one text per run of
 * `run` functions in source order. The unit scores as its best text.
 */
export function unitChunks(label, members, corpus, { run = UNIT_RUN, top = UNIT_TOP } = {}) {
  const textOf = (fs) => {
    const tf = new Map();
    for (const f of fs) for (const [id, n] of f.tf) tf.set(id, (tf.get(id) || 0) + n);
    const names = new Set(fs.map((f) => leafOf(f.name)));
    const ids = rankIdentifiers(tf, corpus.df, corpus.n, top, null).filter((id) => !names.has(id));
    return `${phrase(label)}: ${[...fs.slice(0, run).map((f) => phrase(leafOf(f.name))), ...ids.map(phrase)].join(', ')}`;
  };
  const sorted = [...members].sort((a, b) => a.start - b.start);
  const out = [textOf(sorted)];
  if (sorted.length > run) for (let i = 0; i < sorted.length; i += run) out.push(textOf(sorted.slice(i, i + run)));
  return out;
}

/** Functions grouped into units: 'file' by file, 'class' by file and class (free functions have none and are left out). Returns [{ key, label, members }]. */
export function unitsOf(fns, kind) {
  const m = new Map();
  for (const f of fns) {
    if (kind === 'class' && !f.cls) continue;
    const key = kind === 'class' ? `${f.file}@${f.cls}` : f.file;
    if (!m.has(key)) m.set(key, { key, label: kind === 'class' ? f.cls : baseOf(f.file), members: [] });
    m.get(key).members.push(f);
  }
  return [...m.values()];
}

/** A group's score as its best member's: `scores` by member position, `groups` as arrays of positions; a group with none scores -Infinity. */
export function rollUp(scores, groups) {
  return groups.map((g) => { let best = -Infinity; for (const i of g) if (scores[i] > best) best = scores[i]; return best; });
}

/** A set of ranks read three ways at depth k: any within k, the share within k, all within k. No ranks: all false, share null. */
export function setReading(ranks, k) {
  const n = ranks.length;
  const hit = ranks.filter((r) => r <= k).length;
  return { n, hit, any: hit > 0, share: n ? hit / n : null, all: n > 0 && hit === n };
}

// ---- two texts of one unit as one score ------------------------------------------
// mechanism-fused-text-reach (2026-11-15) measured a mechanism scored by its label and
// by its best member function's text together; the weighted sum at FUSE_LABEL_WEIGHT on
// the label was the best form at every figure (docs/CODEEXAM_MECHANISMS_TESTS.md, "The
// label and the function text as one score"). The arm and the weight are the measured
// ones; neither is an option.
/** The function-text form the fused score uses. */
export const FUSE_ARM = 'comments';
/** The weight on the unit's own text (a mechanism's label) in the fused score; the rest is on its best function. */
export const FUSE_LABEL_WEIGHT = 0.3;
/** w on the first list, 1 - w on the second; a unit missing one text is scored on the other alone. */
export function fuseSum(a, b, w) {
  const fin = (x) => (Number.isFinite(x) ? x : -Infinity);
  return a.map((x, i) => { const y = b[i]; if (!Number.isFinite(x)) return fin(y); if (!Number.isFinite(y)) return x; return w * x + (1 - w) * y; });
}
/** The corpus id (`file@name`, forward slashes) of a mechanism member { file, name }. */
export const memberId = (m) => `${String((m && m.file) || '').replace(/\\/g, '/')}@${(m && m.name) || ''}`;
/**
 * A member-to-corpus-id function that also reaches a second definition of a name within one
 * file (function-text-embedding-gaps-and-gui, part A). The index names the second definition
 * `name@<line>`; a mechanism record lists both under the bare name, each with its own
 * `start`. Joined by `file@name` alone, both members became the first definition, and the
 * second never had a text or a vector (32 functions on CodeExam's index, one of 41 lines).
 * With `fns` (the corpus's functions): a member whose `start` is not the first definition's
 * resolves to `file@name@<start>` when the corpus has it. A member with no `start` (an older
 * mechanisms file) resolves by name as before, and so does everything else.
 */
export function memberResolver(fns) {
  const startOf = new Map((fns || []).map((f) => [f.id, f.start]));
  return (m) => {
    const id = memberId(m);
    if (!m || m.start == null || !startOf.has(id) || startOf.get(id) === m.start) return id;
    const second = `${id}@${m.start}`;
    return startOf.has(second) ? second : id;
  };
}
