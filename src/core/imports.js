/**
 * imports.js — shared per-language import extractor (#156; #153/#154 reuse).
 *
 * Catalogs import statements as DATA. Each row:
 *
 *   { target, file, line, module, name, alias, relative, star }
 *
 *   import a.b.c [as x][, d.e]   ->  target a.b.c (module a.b.c, name null)
 *   from a.b import X, Y as z    ->  target a.b.X (module a.b, name X);
 *                                    target a.b.Y (name Y, alias z)
 *   from a.b import *            ->  target a.b.* (star true)
 *   from . import x / from .r import y  ->  SKIPPED by default — relative
 *     imports are intra-package wiring, not external API usage; the census
 *     ranks the de facto external surface. Pass { includeRelative: true }
 *     to get them (the #153 exports catalog needs exactly these: `__init__`
 *     re-exports are mostly relative).
 *
 * Python (.py/.pyi) only today; JS/TS extraction is #154's scope. The AI/ML
 * detectors match imports ad hoc per framework family (ai-ml-detectors.js);
 * this is the first place imports are cataloged generically.
 */

export function isPythonFile(filepath) {
  return /\.pyi?$/i.test(filepath);
}

// Strip a trailing \r FIRST: indexes built from CRLF sources store it in the
// line, and `.`/`$` in JS regexes don't cross \r — without this, every import
// in a CRLF corpus silently fails to parse (found on .scikit-learn).
// Imports never legitimately contain `#` outside a comment.
const stripComment = (s) => (s || '').replace(/\r+$/, '').replace(/#.*$/, '');

// `Name` or `Name as Alias` (or `*`).
const reNameAs = /^([A-Za-z_]\w*|\*)(?:\s+as\s+([A-Za-z_]\w*))?$/;
// Plain-import path: `a.b.c` or `a.b.c as x`.
const rePathAs = /^([A-Za-z_][\w.]*)(?:\s+as\s+([A-Za-z_]\w*))?$/;

/**
 * Extract import rows from one Python file's lines.
 *
 * Backslash continuations and parenthesized from-imports
 * (`from x import (a,\n b)`) are joined with a bounded scan so a
 * pathological literal can't run away. Doctest lines (`>>> import x`)
 * don't match the line anchor, so they're excluded for free.
 */
export function extractPythonImports(lines, filepath, opts = {}) {
  const rows = [];
  const MAX_JOIN = 50;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*(?:import|from)\s/.test(lines[i])) continue;
    const startLine = i + 1;
    let line = stripComment(lines[i]);
    // Join backslash continuations.
    let guard = 0;
    while (/\\\s*$/.test(line) && i + 1 < lines.length && guard++ < MAX_JOIN) {
      line = line.replace(/\\\s*$/, ' ') + stripComment(lines[++i]);
    }
    // Join a parenthesized from-import name list.
    if (/^\s*from\s/.test(line) && line.includes('(') && !line.includes(')')) {
      guard = 0;
      while (!line.includes(')') && i + 1 < lines.length && guard++ < MAX_JOIN) {
        line += ' ' + stripComment(lines[++i]);
      }
    }

    let m;
    if ((m = /^\s*from\s+(\.+[\w.]*|[A-Za-z_][\w.]*)\s+import\s+(.+)$/.exec(line))) {
      const mod = m[1];
      const relative = mod.startsWith('.');
      if (relative && !opts.includeRelative) continue;
      const join = mod.endsWith('.') ? '' : '.';
      const names = m[2].replace(/[()]/g, '');
      for (const piece of names.split(',')) {
        const nm = reNameAs.exec(piece.trim());
        if (!nm) continue;
        const [, name, alias] = nm;
        rows.push({
          target: `${mod}${join}${name}`,
          file: filepath, line: startLine,
          module: mod, name, alias: alias || null,
          relative, star: name === '*',
        });
      }
    } else if ((m = /^\s*import\s+(.+)$/.exec(line))) {
      for (const piece of m[1].split(',')) {
        const nm = rePathAs.exec(piece.trim());
        if (!nm) continue;
        const [, path, alias] = nm;
        rows.push({
          target: path,
          file: filepath, line: startLine,
          module: path, name: null, alias: alias || null,
          relative: false, star: false,
        });
      }
    }
  }
  return rows;
}

/**
 * Extract import rows from every Python file in a loaded index.
 * Returns { rows, pyFiles } — pyFiles so callers can distinguish
 * "no Python here" from "Python with no imports".
 */
export function extractImports(index) {
  const rows = [];
  let pyFiles = 0;
  for (const [filepath, lines] of index.fileLines) {
    if (!isPythonFile(filepath)) continue;
    pyFiles++;
    rows.push(...extractPythonImports(lines, filepath));
  }
  return { rows, pyFiles };
}
