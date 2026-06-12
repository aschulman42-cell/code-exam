/**
 * imports.js — shared per-language import extractor (#156; #154 reuses).
 *
 * Catalogs import statements as DATA — `{target, file, line}` rows where
 * `target` is the dotted path as the code states it:
 *
 *   import a.b.c [as x][, d.e]   ->  a.b.c   d.e
 *   from a.b import X, Y as z    ->  a.b.X   a.b.Y    (leaf-qualified)
 *   from a.b import *            ->  a.b.*
 *   from . import x / from .r import y  ->  SKIPPED — relative imports are
 *     intra-package wiring, not external API usage; the census ranks the
 *     de facto external surface.
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

/**
 * Extract import rows from one Python file's lines.
 *
 * Backslash continuations and parenthesized from-imports
 * (`from x import (a,\n b)`) are joined with a bounded scan so a
 * pathological literal can't run away. Doctest lines (`>>> import x`)
 * don't match the line anchor, so they're excluded for free.
 */
export function extractPythonImports(lines, filepath) {
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
    if ((m = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/.exec(line))) {
      // Module must be absolute — a leading dot fails the regex, which is
      // exactly the relative-import skip.
      const mod = m[1];
      const names = m[2].replace(/[()]/g, '');
      for (let name of names.split(',')) {
        name = name.replace(/\s+as\s+\w+\s*$/, '').trim();
        if (name === '*') {
          rows.push({ target: `${mod}.*`, file: filepath, line: startLine });
        } else if (/^[A-Za-z_]\w*$/.test(name)) {
          rows.push({ target: `${mod}.${name}`, file: filepath, line: startLine });
        }
      }
    } else if ((m = /^\s*import\s+(.+)$/.exec(line))) {
      for (let name of m[1].split(',')) {
        name = name.replace(/\s+as\s+\w+\s*$/, '').trim();
        if (/^[A-Za-z_][\w.]*$/.test(name)) {
          rows.push({ target: name, file: filepath, line: startLine });
        }
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
