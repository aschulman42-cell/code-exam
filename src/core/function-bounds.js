// function-bounds.js — language-aware function-end detection for the regex parser: masks strings, comments and regex literals, then finds brace, arrow-expression or indentation ends; dedupes the tree-sitter + regex merge
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Added 2026-10-11 (worklist item function-end-detection-accuracy; #343 ★A).
//
// The regex parser in CodeSearchIndex._parseFunctionsRegex used to end a
// definition at the next definition's start and then extend it by counting raw
// braces. Measured on CE's own source (89 files, 66,653 lines) against a
// tree-sitter build: 49% of definitions ended more than 3 lines late, a
// brace-less one-line arrow (`const kTok = (n) => (...)`) ran 594 -> 1068,
// prose inside a template literal ("function rollup (...") became a
// 94-line "function", braces in strings / comments / regex literals cut real
// functions short (`maskFunctionSource` 546-663, real end 800), and 8.7% of
// source lines were credited to the wrong function.
//
// Everything here works on MASKED lines: literal contents replaced by spaces,
// columns preserved, so one tokenizer serves the definition scan and the end
// scan alike (two copies drift). Neighbours that stay as they are:
// CSI-helpers' _scanLineState (JS-only, answers "is this position inside a
// literal") and bundle-seam-detection's _findWrapperEnd (JS-only, one arrow
// body). This module is per-language-family and whole-file.

// Language families. `line` / `block` are comment delimiters; `quotes` are
// single-line string delimiters (escaped with backslash unless `verbatim`
// applies); `template` is a multi-line string delimiter with `interp` ${}
// re-entering code (JS) or not (Go raw strings); `triple` enables '''/"""
// multi-line strings; `regex` enables the JS regex-literal heuristic;
// `braces` / `arrows` / `indent` select the end-finding strategy.
const FAMILIES = {
  js:     { line: ['//'], block: [['/*', '*/']], quotes: ["'", '"'], template: '`', interp: true, regex: true, braces: true, arrows: true },
  c:      { line: ['//'], block: [['/*', '*/']], quotes: ["'", '"'], braces: true },
  cs:     { line: ['//'], block: [['/*', '*/']], quotes: ["'", '"'], verbatim: true, braces: true },
  kotlin: { line: ['//'], block: [['/*', '*/']], quotes: ["'", '"'], triple: true, braces: true },
  rust:   { line: ['//'], block: [['/*', '*/']], quotes: ['"'], braces: true },   // 'a lifetimes: no single-quote strings
  go:     { line: ['//'], block: [['/*', '*/']], quotes: ["'", '"'], template: '`', braces: true },
  php:    { line: ['//', '#'], block: [['/*', '*/']], quotes: ["'", '"'], braces: true },
  python: { line: ['#'], block: [], quotes: ["'", '"'], triple: true, indent: true },
  perl:   { line: ['#'], block: [], quotes: ["'", '"'], braces: true },
  hash:   { line: ['#'], block: [], quotes: ["'", '"'] },                    // Ruby, CoffeeScript: masking only, ends fall back
  lua:    { line: ['--'], block: [['--[[', ']]']], quotes: ["'", '"'] },      // `end`-delimited: ends fall back
};

const EXT_FAMILY = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js',
  '.c': 'c', '.h': 'c', '.cpp': 'c', '.cc': 'c', '.cxx': 'c', '.hpp': 'c', '.hxx': 'c',
  '.h++': 'c', '.c++': 'c', '.m': 'c', '.mm': 'c', '.java': 'c',
  '.cs': 'cs',
  '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'kotlin', '.swift': 'kotlin',
  '.rs': 'rust',
  '.go': 'go',
  '.php': 'php',
  '.py': 'python', '.pyw': 'python',
  '.pl': 'perl', '.pm': 'perl', '.awk': 'perl',
  '.rb': 'hash', '.coffee': 'hash',
  '.lua': 'lua',
};

/** Family name for a lowercase extension, or null when the file is left unmasked (e.g. VBScript, whose comments start with a quote). */
export function familyForExt(ext) {
  return EXT_FAMILY[ext] || null;
}

const REGEX_PREV_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// End column (inclusive) of a JS regex literal starting at `i`, or -1 when the
// slash is division. Looks back through the masked buffer for the previous
// significant token, then forward for the unescaped closing slash outside a
// character class. A literal that does not close on its line is not a literal.
function _regexLiteralEnd(line, i, chars) {
  let k = i - 1;
  while (k >= 0 && (chars[k] === ' ' || chars[k] === '\t')) k--;
  if (k >= 0) {
    const p = chars[k];
    if (!REGEX_PREV_CHARS.has(p)) {
      if (!/[A-Za-z_$]/.test(p)) return -1;
      let w = k;
      while (w >= 0 && /[A-Za-z_$]/.test(chars[w])) w--;
      if (!REGEX_PREV_WORDS.has(chars.slice(w + 1, k + 1).join(''))) return -1;
    }
  }
  let inClass = false;
  for (let j = i + 1; j < line.length; j++) {
    const c = line[j];
    if (c === '\\') { j++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') return j;
  }
  return -1;
}

/**
 * Mask literal contents. Returns a new array of lines with the same lengths:
 * string, template, comment and (JS) regex-literal contents AND delimiters are
 * replaced by spaces; code, including `${...}` interpolations, is kept.
 * Multi-line constructs (block comments, templates, triple-quoted strings)
 * carry state across lines. Unknown family: lines are returned unchanged.
 */
export function maskCodeLines(lines, family) {
  const F = typeof family === 'string' ? FAMILIES[family] : family;
  if (!F) return lines.slice();
  const out = new Array(lines.length);
  let mode = 'code';        // 'code' | 'block' | 'template' | 'triple'
  let closer = null;        // closing token for the current multi-line construct
  const interp = [];        // ${} nesting: brace depth inside each open interpolation

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] || '';
    const n = line.length;
    const chars = line.split('');
    let i = 0;
    while (i < n) {
      const ch = line[i];
      if (mode !== 'code') {
        if (mode === 'template' && F.interp && ch === '$' && line[i + 1] === '{') {
          chars[i] = ' '; chars[i + 1] = ' ';
          interp.push(0); mode = 'code'; i += 2; continue;
        }
        if (line.startsWith(closer, i)) {
          for (let k = 0; k < closer.length; k++) chars[i + k] = ' ';
          i += closer.length; mode = 'code'; closer = null; continue;
        }
        if (mode !== 'block' && ch === '\\') {
          chars[i] = ' '; if (i + 1 < n) chars[i + 1] = ' ';
          i += 2; continue;
        }
        chars[i] = ' '; i++; continue;
      }
      // code mode
      if (interp.length > 0) {
        if (ch === '{') { interp[interp.length - 1]++; i++; continue; }
        if (ch === '}') {
          if (interp[interp.length - 1] === 0) {
            interp.pop(); chars[i] = ' '; mode = 'template'; closer = F.template; i++; continue;
          }
          interp[interp.length - 1]--; i++; continue;
        }
      }
      let handled = false;
      for (const lc of F.line) {
        if (line.startsWith(lc, i)) { for (let k = i; k < n; k++) chars[k] = ' '; i = n; handled = true; break; }
      }
      if (handled) break;
      for (const [open, close] of F.block) {
        if (line.startsWith(open, i)) {
          for (let k = 0; k < open.length; k++) chars[i + k] = ' ';
          mode = 'block'; closer = close; i += open.length; handled = true; break;
        }
      }
      if (handled) continue;
      if (F.triple && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
        closer = line.substr(i, 3); mode = 'triple';
        chars[i] = ' '; chars[i + 1] = ' '; chars[i + 2] = ' ';
        i += 3; continue;
      }
      if (F.template && ch === F.template) {
        chars[i] = ' '; mode = 'template'; closer = F.template; i++; continue;
      }
      if (F.quotes.includes(ch)) {
        const verbatim = F.verbatim && i > 0 && line[i - 1] === '@';
        let j = i + 1;
        while (j < n) {
          if (!verbatim && line[j] === '\\') { j += 2; continue; }
          if (line[j] === ch) {
            if (verbatim && line[j + 1] === ch) { j += 2; continue; }
            break;
          }
          j++;
        }
        const endJ = Math.min(j, n - 1);           // unterminated: mask to end of line
        for (let k = i; k <= endJ; k++) chars[k] = ' ';
        i = endJ + 1; continue;
      }
      if (F.regex && ch === '/') {
        const close = _regexLiteralEnd(line, i, chars);
        if (close > i) { for (let k = i; k <= close; k++) chars[k] = ' '; i = close + 1; continue; }
      }
      i++;
    }
    out[li] = chars.join('');
  }
  return out;
}

/**
 * End of a brace-delimited definition starting at `startIdx` (0-based), with
 * scanning on the first line beginning at `fromCol`. Braces inside the
 * parameter list are ignored (`function f(opts = {}) {`); a `;` at paren
 * depth 0 before any body brace ends a declaration on that line (prototype,
 * forward declaration, expression-bodied member); `} ,` and `} {` after a
 * balanced brace group are C++ initializer-list continuations, not the body.
 * Returns { end (1-based), kind: 'body' | 'declaration' } or null when no body
 * brace appears within `maxHeaderLines` or the braces never balance.
 */
export function findBraceEnd(masked, startIdx, fromCol = 0, maxHeaderLines = 12) {
  let paren = 0, depth = 0, seen = false;
  for (let li = startIdx; li < masked.length; li++) {
    const s = masked[li] || '';
    for (let i = (li === startIdx ? fromCol : 0); i < s.length; i++) {
      const c = s[i];
      if (!seen) {
        if (c === '(' || c === '[') paren++;
        else if (c === ')' || c === ']') paren = Math.max(0, paren - 1);
        else if (paren === 0 && c === '{') { seen = true; depth = 1; }
        else if (paren === 0 && c === ';') return { end: li + 1, kind: 'declaration' };
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const rest = s.slice(i + 1).trimStart();
          if (rest.startsWith(',') || rest.startsWith('{')) { seen = false; continue; }
          return { end: li + 1, kind: 'body' };
        }
      }
    }
    if (!seen && li - startIdx >= maxHeaderLines) return null;
  }
  return null;
}

const CONTINUATION_RE = /^(?:\.|\?\.|&&|\|\||\?\?|[?:+\-*%|&])/;

// End of a brace-less arrow body (`=> expr`) whose expression begins at
// (li, ci): the first line on which the ()[]{} depth counted from there is
// back to zero at line end, extended over lines that begin with `.`, an
// operator or `?`/`:` (chained or wrapped expressions).
function _findArrowExprEnd(masked, li, ci) {
  let depth = 0;
  for (let l = li; l < masked.length; l++) {
    const s = masked[l] || '';
    for (let i = (l === li ? ci : 0); i < s.length; i++) {
      const c = s[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
    }
    if (depth <= 0) {
      if (s.trimEnd().endsWith(';')) return { end: l + 1, kind: 'arrow-expr' };
      let nx = l + 1;
      while (nx < masked.length && (masked[nx] || '').trim() === '') nx++;
      if (nx < masked.length && CONTINUATION_RE.test((masked[nx] || '').trimStart())) continue;
      return { end: l + 1, kind: 'arrow-expr' };
    }
  }
  return null;
}

function _indentOf(line) {
  const stripped = line.trimStart();
  return line.length - stripped.length;
}

/**
 * End of an indentation-delimited definition (Python): the last line whose
 * indent exceeds the definition line's. Blank lines and lines that are blank
 * once masked (comments, the inside of a triple-quoted string) never end the
 * block; a dedented code line does. Returns { end, kind: 'indent' }.
 */
export function findIndentEnd(lines, masked, startIdx) {
  const defIndent = _indentOf(lines[startIdx] || '');
  let last = startIdx;
  for (let li = startIdx + 1; li < lines.length; li++) {
    const raw = lines[li] || '';
    if (raw.trim() === '') continue;
    const ind = _indentOf(raw);
    if (ind > defIndent) { last = li; continue; }
    if ((masked[li] || '').trim() === '') continue;     // comment or string text at outer indent
    break;
  }
  return { end: last + 1, kind: 'indent' };
}

/**
 * End line (1-based) for the definition whose header starts at `startIdx`,
 * or null when the family has no strategy (caller falls back to the old
 * next-definition heuristic). `masked` is maskCodeLines(lines, family).
 */
export function computeFunctionEnd(lines, masked, startIdx, family) {
  const F = typeof family === 'string' ? FAMILIES[family] : family;
  if (!F) return null;
  if (F.indent) return findIndentEnd(lines, masked, startIdx);
  if (!F.braces) return null;
  let fromCol = 0;
  if (F.arrows) {
    const sl = masked[startIdx] || '';
    const a = sl.lastIndexOf('=>');
    if (a >= 0) {
      if (!sl.slice(a + 2).includes('{')) {
        // Expression body; it may start on a later line (`=>` at end of line).
        let li = startIdx, ci = a + 2;
        while (li < masked.length) {
          const rest = (masked[li] || '').slice(ci);
          const t = rest.trimStart();
          if (t) { ci = (masked[li] || '').length - t.length; break; }
          li++; ci = 0;
        }
        if (li >= masked.length) return null;
        if ((masked[li] || '')[ci] === '{') return findBraceEnd(masked, li, ci);
        return _findArrowExprEnd(masked, li, ci);
      }
      fromCol = a + 2;
    }
  }
  return findBraceEnd(masked, startIdx, fromCol);
}

/** Pull `end` (1-based) up over trailing blank lines, never above `start`. */
export function trimTrailingBlank(lines, start, end) {
  let e = Math.min(end, lines.length);
  while (e > start && (lines[e - 1] || '').trim() === '') e--;
  return e;
}

/**
 * Hybrid-build merge: add the regex parser's entries that tree-sitter did
 * not produce, as `parser: 'regex'`-labelled entries. A regex entry whose
 * start line already has a tree-sitter entry is the same definition under
 * another name (regex prefixes nested and class-field functions with the
 * class) and is dropped; a kept entry never extends past the end of the
 * smallest tree-sitter entry containing its start line. Mutates and returns
 * `tsFuncs`. Tree-sitter entries carry no `parser` field; in a
 * `tree-sitter+regex` index, absence means tree-sitter.
 */
export function mergeRegexOnlyEntries(tsFuncs, regexFuncs, { parseHadErrors = false } = {}) {
  const tsEntries = Object.values(tsFuncs);
  const tsStarts = new Set(tsEntries.map(e => e.start));
  if (parseHadErrors) {
    // Tree-sitter's error recovery ends the function containing the error at
    // the error (`doImports` 124-161, real end 274, over a raw NUL byte in a
    // template literal). When the regex parser has the same definition with
    // a longer end, its end wins and the entry says so.
    const rxByStart = new Map();
    for (const e of Object.values(regexFuncs || {})) if (!rxByStart.has(e.start)) rxByStart.set(e.start, e);
    for (const [name, e] of Object.entries(tsFuncs)) {
      const r = rxByStart.get(e.start);
      if (r && r.end > e.end) tsFuncs[name] = { ...e, end: r.end, parser: 'regex-end' };
    }
  }
  for (const [name, info] of Object.entries(regexFuncs || {})) {
    if (name in tsFuncs) continue;
    if (tsStarts.has(info.start)) continue;
    let end = info.end;
    let container = null;
    for (const e of tsEntries) {
      if (e.start <= info.start && info.start <= e.end && e.start !== info.start) {
        if (!container || (e.end - e.start) < (container.end - container.start)) container = e;
      }
    }
    if (container && end > container.end) end = container.end;
    if (end < info.start) end = info.start;
    tsFuncs[name] = { ...info, end, parser: 'regex' };
  }
  return tsFuncs;
}

/** Return a copy of `funcs` with `parser` set on every entry (whole-file regex fallback inside a tree-sitter build). */
export function labelParser(funcs, parser) {
  const out = {};
  for (const [name, info] of Object.entries(funcs || {})) out[name] = { ...info, parser };
  return out;
}

/** Google Test and friends: the two macro arguments are the suite and the test. */
const GTEST_MACROS = new Set(['TEST', 'TEST_F', 'TEST_P', 'TYPED_TEST', 'TYPED_TEST_P', 'TYPED_TEST_SUITE', 'TEST_CASE', 'TEST_CASE_METHOD', 'BENCHMARK_F', 'FRIEND_TEST']);

/**
 * Display name for a macro-defined function: `MACRO(a, b) { ... }` where every
 * argument is a bare identifier. Google Test families name `Suite::Name`;
 * otherwise two arguments read as `Scope::name`, one as itself, more as
 * `first::rest_joined`. Used by the tree-sitter C/C++ extractor, where the
 * grammar parses such a definition as a function named by the macro (every
 * TEST_F in a file collided on the name `TEST_F`).
 */
export function macroFunctionName(macro, args) {
  if (!args || args.length === 0) return macro;
  if (GTEST_MACROS.has(macro) && args.length >= 2) return `${args[0]}::${args[1]}`;
  if (args.length === 1) return args[0];
  if (args.length === 2) return `${args[0]}::${args[1]}`;
  return `${args[0]}::${args.slice(1).join('_')}`;
}
