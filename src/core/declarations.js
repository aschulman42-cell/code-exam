// declarations.js — module-level constants that carry a mechanism (prompts, rule lists, menus, stop lists, regex tables), found from a file's lines so an evidence pack can hold them
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// WHY THIS EXISTS (pseudo-claims-pack-constants-components-anchors, part (a)).
//
// An evidence pack is built from function bodies and explicit line-range
// anchors (pseudo-claims.js resolveGroup), so a module-level constant reaches
// the drafter only when a function body inlines it. Measured on CodeExam's
// own source while writing the hand rubrics (2026-10-26 to 10-29): four of
// the five feature rubrics had an element every drafter missed, and each
// lives in a constant --
//
//   vocabulary (c)   the keyword and generic-word lists, src/core/vocabulary.js
//   concepts (d)     LOW_DISCRIMINATION_STOPWORDS, src/commands/claim.js
//   overview         _noiseFiles, src/core/hotspots.js
//   overview by AI   AI_OVERVIEW_PROMPT, QUESTIONS_RULE, AI_OVERVIEW_TOOL_NAMES
//
// Nine drafts of the overview-by-AI groups across three models described the
// turn loop and the cost check, because the function that assembles the
// prompt is three lines naming constants. The class is "data that is the
// mechanism", and it is general: a prompt, a stop list, a tool menu, a regex
// table, a catalog.
//
// WHAT THIS IS NOT. A parser. It is a line scanner with a bracket/string
// tracker, good enough to find where a declaration starts and ends in the
// languages CodeExam indexes most, and honest about its bounds (maxLines).
// Everything it returns is a line range in a file CodeExam indexed, which is
// the same anti-fabrication contract a documentation anchor has (#286): the
// drafter cites `file@L<start>-<end>` and the grounding pass checks it.

// Value openers that make a declaration a DATA declaration: a string of any
// quoting, a template, an array, an object, a regex, or a constructor of a
// table (Set / Map / freeze / RegExp). A call or an expression is not data.
const OPENER_RE = /^(?:&\s*)?(?:(?:[rRfFbBuU]{1,2})?(?:"""|'''|["'`])|\[|\{|\/(?![/*])|new\s+(?:RegExp|Set|Map)\s*\(|Object\.freeze\s*\(|String\.raw\s*`|\(\s*$)/;

// Declaration heads by extension. Column 0 means module level in JS/TS,
// Python, Go, Rust and Ruby; Java/C#/Kotlin constants sit inside a class and
// are accepted on their ALL_CAPS name instead of their column; C/C++ file-scope
// definitions are accepted on their storage keywords.
const HEADS = [
  { ext: /\.(?:m?jsx?|cjs|[cm]?tsx?)$/i, lang: 'js',
    re: /^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?\s*=\s*(.*)$/ },
  { ext: /\.pyi?$/i, lang: 'py',
    re: /^([A-Za-z_]\w*)\s*(?::\s*[^=]+?)?\s*=\s*(.*)$/ },
  { ext: /\.(?:java|kts?|cs|scala)$/i, lang: 'java',
    re: /^\s*(?:(?:public|private|protected|internal|static|final|readonly|const|val|var)\s+)+(?:[\w<>\[\],.?]+(?:\s*<[^>]*>)?\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/ },
  { ext: /\.go$/i, lang: 'go',
    re: /^(?:const|var)\s+([A-Za-z_]\w*)\s*(?:[\w.\[\]*]+\s*)?=\s*(.*)$/ },
  { ext: /\.rs$/i, lang: 'rs',
    re: /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*[^=]+=\s*(.*)$/ },
  { ext: /\.rb$/i, lang: 'rb',
    re: /^([A-Z][A-Za-z0-9_]*)\s*=\s*(.*)$/ },
  { ext: /\.(?:c|h|cc|cpp|cxx|hpp|hh|m|mm)$/i, lang: 'c',
    re: /^(?:static\s+|extern\s+)?(?:const\s+)?(?:[\w:<>]+(?:\s+[\w:<>]+)*\s*[*&\s]+)([A-Za-z_]\w*)\s*(?:\[[^\]]*\])*\s*=\s*(.*)$/ },
];

// Characters before a `/` that make it open a regex literal rather than divide.
const REGEX_PRECEDERS = new Set(['', '=', '(', ',', '[', ':', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', 'return', 'typeof']);

function headFor(filepath) {
  const f = String(filepath || '');
  for (const h of HEADS) if (h.ext.test(f)) return h;
  return null;
}

// Walk one line, carrying the tracker state across lines. Strings, templates,
// triple-quoted strings and regex literals are opaque (brackets inside them do
// not count); `//` and `#` comments end the line's accounting. Returns the
// code-only text of the line (for the continuation test) and the new state.
function scanLine(line, st, lang) {
  let code = '';
  let i = 0;
  const n = line.length;
  let lastSig = st.lastSig; // last significant token before this char, for regex detection
  while (i < n) {
    const c = line[i];
    const next = line[i + 1];
    if (st.str) {
      // Inside a string / template / regex: look for the closer.
      if (c === '\\' && st.str !== 'regex-class') { i += 2; continue; }
      if (st.str === 'regex') {
        if (c === '[') { st.str = 'regex-class'; i++; continue; }
        if (c === '/') { st.str = null; lastSig = 'x'; }
        i++; continue;
      }
      if (st.str === 'regex-class') {
        if (c === '\\') { i += 2; continue; }
        if (c === ']') st.str = 'regex';
        i++; continue;
      }
      if (st.str.length === 3) { // triple quote
        if (line.startsWith(st.str, i)) { st.str = null; lastSig = 'x'; i += 3; continue; }
        i++; continue;
      }
      if (c === st.str) { st.str = null; lastSig = 'x'; }
      i++; continue;
    }
    // Comments.
    if (c === '/' && next === '/' && lang !== 'py') break;
    if (c === '#' && (lang === 'py' || lang === 'rb')) break;
    if (c === '/' && next === '*') {
      const close = line.indexOf('*/', i + 2);
      if (close < 0) { st.blockComment = true; break; }
      i = close + 2; continue;
    }
    // String openers.
    if (c === '"' || c === "'" || c === '`') {
      if ((c === '"' || c === "'") && line.startsWith(c + c + c, i) && (lang === 'py' || lang === 'rb')) {
        st.str = c + c + c; i += 3; continue;
      }
      st.str = c; i++; continue;
    }
    // Regex literal (JS only): a `/` where an operand is expected.
    if (c === '/' && lang === 'js' && REGEX_PRECEDERS.has(lastSig)) {
      st.str = 'regex'; i++; continue;
    }
    if (c === '(' || c === '[' || c === '{') st.depth++;
    else if (c === ')' || c === ']' || c === '}') st.depth = Math.max(0, st.depth - 1);
    if (!/\s/.test(c)) {
      // Track the last significant token: a word or a single punctuation char.
      if (/[A-Za-z_$\d]/.test(c)) {
        const m = line.slice(i).match(/^[A-Za-z_$][\w$]*|^\d[\w.]*/);
        lastSig = m ? m[0] : c;
        code += m ? m[0] : c;
        i += m ? m[0].length : 1;
        continue;
      }
      lastSig = c;
    }
    code += c;
    i++;
  }
  st.lastSig = lastSig;
  return code;
}

function kindOf(rest) {
  const r = String(rest || '').trim().replace(/^&\s*/, '');
  if (/^(?:[rRfFbBuU]{1,2})?(?:"""|'''|["'`])|^String\.raw/.test(r)) return 'string';
  if (/^\/|^new\s+RegExp/.test(r)) return 'regex';
  if (/^\[|^new\s+Set\s*\(|^Object\.freeze\s*\(\s*\[/.test(r)) return 'array';
  if (/^\{|^new\s+Map\s*\(|^Object\.freeze\s*\(\s*\{/.test(r)) return 'object';
  if (/^\(/.test(r)) return 'tuple';
  return 'data';
}

/**
 * The data declarations in one file's lines: `{ name, start, end, kind, chars }`
 * with 1-based inclusive lines. A declaration counts when its value opens with
 * a literal (string, template, array, object, regex, table constructor) and it
 * is at least `minLines` long or `minChars` of text; one-line scalars are not
 * what a pack is missing. `maxLines` bounds the scan for an unterminated value.
 */
export function findDeclarations(lines, filepath, { minLines = 3, minChars = 200, maxLines = 600 } = {}) {
  const head = headFor(filepath);
  if (!head || !Array.isArray(lines) || !lines.length) return [];
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(head.re);
    if (!m || !OPENER_RE.test(m[2].trim())) { i++; continue; }
    const name = m[1];
    const rest = m[2];
    const st = { depth: 0, str: null, lastSig: '=', blockComment: false };
    let j = i;
    let chars = 0;
    let ended = false;
    while (j < lines.length && j - i < maxLines) {
      const text = j === i ? rest : lines[j];
      chars += text.length + 1;
      if (st.blockComment) {
        const close = text.indexOf('*/');
        if (close < 0) { j++; continue; }
        st.blockComment = false;
        const code = scanLine(text.slice(close + 2), st, head.lang);
        if (st.depth === 0 && !st.str && !/[+,|&\\.]\s*$/.test(code.trim())) { ended = true; break; }
        j++; continue;
      }
      const code = scanLine(text, st, head.lang).trim();
      // The declaration ends at a line that leaves no bracket open, no string
      // open, and no trailing continuation (`+`, `,`, `||`, `&&`, `\`, `.`).
      if (st.depth === 0 && !st.str && (j > i || code) && !/[+,|&\\.]$/.test(code.replace(/;$/, ''))) { ended = true; break; }
      j++;
    }
    const end = ended ? j : Math.min(lines.length - 1, j);
    const nLines = end - i + 1;
    if (nLines >= minLines || chars >= minChars) {
      out.push({ name, start: i + 1, end: end + 1, kind: kindOf(rest), chars });
    }
    i = end + 1;
  }
  return out;
}

// Per-index cache, keyed by file: the same file is asked about by every group
// that has a function in it, and a scan is cheap but not free.
const _cache = new WeakMap();

/** The declarations of one indexed file, cached on the index. */
export function declarationsFor(index, filepath, opts = {}) {
  if (!index || !index.fileLines || typeof index.fileLines.get !== 'function') return [];
  let byFile = _cache.get(index);
  if (!byFile) { byFile = new Map(); _cache.set(index, byFile); }
  const key = `${filepath}\u0000${opts.minLines ?? ''}\u0000${opts.minChars ?? ''}`;
  if (byFile.has(key)) return byFile.get(key);
  const lines = index.fileLines.get(filepath) || [];
  const decls = findDeclarations(lines, filepath, opts);
  byFile.set(key, decls);
  return decls;
}

/**
 * The constants a set of resolved functions name, with their text, ranked by
 * how many of the functions reference each and capped (`maxPerGroup`) so a
 * table-heavy file cannot flood a pack. Same file only: the identifier must
 * appear in the function's own source and the declaration must sit outside
 * the function's own range.
 *
 * @param {object} index  a CodeSearchIndex (needs `fileLines`)
 * @param {Array<{filepath:string,name:string,start:number,end:number,source:string}>} funcs
 * @returns {Array<{filepath:string,name:string,start:number,end:number,kind:string,source:string,referencedBy:string[]}>}
 */
export function constantsReferencedBy(index, funcs, { maxPerGroup = 6, ...opts } = {}) {
  if (!index || !index.fileLines) return [];
  const hits = new Map(); // `${file}\u0000${name}` -> record
  for (const f of funcs || []) {
    if (!f || !f.filepath || !f.source) continue;
    const decls = declarationsFor(index, f.filepath, opts);
    if (!decls.length) continue;
    const tokens = new Set(String(f.source).match(/[A-Za-z_$][\w$]*/g) || []);
    for (const d of decls) {
      if (d.name === f.name || !tokens.has(d.name)) continue;
      if (f.start && f.end && d.start >= f.start && d.end <= f.end) continue; // inside the function itself
      const key = `${f.filepath}\u0000${d.name}`;
      let rec = hits.get(key);
      if (!rec) {
        const lines = index.fileLines.get(f.filepath) || [];
        rec = { filepath: f.filepath, name: d.name, start: d.start, end: d.end, kind: d.kind,
          source: lines.slice(d.start - 1, d.end).join('\n'), referencedBy: [] };
        hits.set(key, rec);
      }
      if (!rec.referencedBy.includes(f.name)) rec.referencedBy.push(f.name);
    }
  }
  return [...hits.values()]
    .sort((a, b) => b.referencedBy.length - a.referencedBy.length || a.filepath.localeCompare(b.filepath) || a.start - b.start)
    .slice(0, maxPerGroup);
}
