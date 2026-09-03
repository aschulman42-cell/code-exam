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
export function extractImports(index, opts = {}) {
  const rows = [];
  let pyFiles = 0;
  const filesByLang = {};
  for (const [filepath, lines] of index.fileLines) {
    const got = extractFileImports(lines, filepath, opts);
    if (got == null) continue;
    const lang = got.length ? got[0].lang
      : isPythonFile(filepath) ? 'py' : isJsFile(filepath) ? 'js'
        : isCFile(filepath) ? 'c' : isJavaFile(filepath) ? 'java' : 'cs';
    filesByLang[lang] = (filesByLang[lang] || 0) + 1;
    if (lang === 'py') pyFiles++;
    rows.push(...got);
  }
  return { rows, pyFiles, filesByLang };
}

// ===========================================================================
// imports-bill-of-materials tier 1 (#312, #315 A3): the other languages.
// Same row shape as Python -- { target, file, line, module, name, alias,
// relative, star } -- plus `lang` on every row (Python rows carry it too,
// via extractImports). Semantics mapped per language:
//
//   relative  JS/TS: specifier starts with ./ or ../ (intra-package wiring).
//             C/C++: a QUOTED include ("local.h") -- project-local by
//             convention, exactly the intra-package sense; <system.h> is the
//             external surface, relative:false.
//             Java/Kotlin/C#: always false (no relative form exists).
//   star      import * as ns (JS), import a.b.* (Java), using static (C#
//             brings members into scope -- star:false, name carries the type).
//
// Comment handling is line-level and deliberately simple: a `//` outside
// quotes ends the line. An import specifier containing `//` (a URL import)
// is vanishingly rare in indexed corpora and is the disclosed limit.
// ===========================================================================

export function isJsFile(filepath) { return /\.(?:jsx?|tsx?|mjs|cjs)$/i.test(filepath); }
export function isCFile(filepath) { return /\.(?:c|h|cc|hh|cpp|hpp|cxx|hxx|inl)$/i.test(filepath); }
export function isJavaFile(filepath) { return /\.(?:java|kt|kts)$/i.test(filepath); }
export function isCSharpFile(filepath) { return /\.cs$/i.test(filepath); }

const stripSlashComment = (s) => {
  const t = (s || '').replace(/\r+$/, '');
  let out = '';
  let q = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { out += c; if (c === q && t[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; continue; }
    if (c === '/' && t[i + 1] === '/') break;
    if (c === '/' && t[i + 1] === '*') {
      const end = t.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1; continue;
    }
    out += c;
  }
  return out;
};

/** JS/TS: import declarations, re-exports from a module, require(), dynamic import(). */
export function extractJsImports(lines, filepath, opts = {}) {
  const rows = [];
  const MAX_JOIN = 30;
  const push = (module, name, alias, star, line) => {
    const relative = module.startsWith('./') || module.startsWith('../');
    if (relative && !opts.includeRelative) return;
    rows.push({
      target: name ? `${module}.${name}` : module,
      file: filepath, line, module, name: name || null, alias: alias || null,
      relative, star: !!star, lang: 'js',
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const startLine = i + 1;
    let line = stripSlashComment(lines[i]);
    if (!/^\s*(?:import\b|export\b.*\bfrom\b|(?:const|let|var)\b.*\brequire\s*\()/.test(line)
      && !/\brequire\s*\(\s*['"]/.test(line) && !/\bimport\s*\(\s*['"]/.test(line)) continue;
    // Join a multi-line import/export clause until its from-specifier lands.
    let guard = 0;
    while (/^\s*(?:import|export)\b/.test(line) && !/['"][^'"]*['"]/.test(line.split(/\bfrom\b/)[1] || '')
      && !/^\s*import\s*['"]/.test(line) && !/\bfrom\b\s*['"]/.test(line)
      && i + 1 < lines.length && guard++ < MAX_JOIN
      && /[{,]\s*$|^\s*(?:import|export)\s*$/.test(line.trimEnd())) {
      line += ' ' + stripSlashComment(lines[++i]);
    }
    let m;
    // import 'mod';  (bare side-effect import)
    if ((m = /^\s*import\s*['"]([^'"]+)['"]/.exec(line))) { push(m[1], null, null, false, startLine); continue; }
    // import ... from 'mod'  /  export ... from 'mod'
    if ((m = /^\s*(import|export)\s+(.+?)\s+from\s*['"]([^'"]+)['"]/.exec(line))) {
      const clause = m[2];
      const mod = m[3];
      let mm;
      if ((mm = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause))) push(mod, null, mm[1], true, startLine);
      const braces = /\{([^}]*)\}/.exec(clause);
      if (braces) {
        for (const piece of braces[1].split(',')) {
          const p = piece.trim();
          if (!p) continue;
          const nm = /^(?:type\s+)?([A-Za-z_$][\w$]*|default)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(p);
          if (nm) push(mod, nm[1], nm[2] || null, false, startLine);
        }
      }
      const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '').replace(/[,\s]+/g, ' ').trim();
      if (m[1] === 'import' && /^[A-Za-z_$][\w$]*$/.test(head)) push(mod, 'default', head, false, startLine);
      // export * from 'mod' -- the whole-surface re-export; the bare star
      // survives the head-stripping above precisely when there was no `as`.
      if (head === '*') push(mod, null, null, true, startLine);
      continue;
    }
    // export * from 'mod'
    if ((m = /^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/.exec(line))) { push(m[1], null, null, true, startLine); continue; }
    // require('mod') -- one row per call, alias from a simple const binding.
    let re = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let hadReq = false;
    while ((m = re.exec(line))) {
      hadReq = true;
      const bind = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
      push(m[1], null, bind ? bind[1] : null, false, startLine);
    }
    if (hadReq) continue;
    // dynamic import('mod')
    re = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = re.exec(line))) push(m[1], null, null, false, startLine);
  }
  return rows;
}

/** C/C++: #include. Quoted includes are `relative` (project-local); angle-bracket includes are the external surface. */
export function extractCImports(lines, filepath, opts = {}) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*#\s*include\s*(<([^>]+)>|"([^"]+)")/.exec((lines[i] || '').replace(/\r+$/, ''));
    if (!m) continue;
    const relative = m[3] != null;               // quoted form
    if (relative && !opts.includeRelative) continue;
    const module = (m[2] || m[3]).trim();
    rows.push({
      target: module, file: filepath, line: i + 1,
      module, name: null, alias: null, relative, star: false, lang: 'c',
    });
  }
  return rows;
}

/** Java (and Kotlin: same line shape, optional semicolon): import [static] a.b.C[.*]. */
export function extractJavaImports(lines, filepath) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*import\s+(static\s+)?([A-Za-z_][\w.]*?)(\.\*)?\s*;?\s*$/.exec(stripSlashComment(lines[i]));
    if (!m || !m[2].includes('.')) continue;
    const star = !!m[3];
    const path = m[2];
    const name = star ? '*' : path.split('.').pop();
    const module = star ? path : path.split('.').slice(0, -1).join('.');
    rows.push({
      target: star ? `${path}.*` : path,
      file: filepath, line: i + 1,
      module, name, alias: null, relative: false, star, lang: 'java',
    });
  }
  return rows;
}

/** C#: using directives (namespace, static, alias). `using (resource)` statements never match. */
export function extractCSharpImports(lines, filepath) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = stripSlashComment(lines[i]);
    let m;
    if ((m = /^\s*using\s+static\s+([A-Za-z_][\w.]*)\s*;/.exec(line))) {
      const path = m[1];
      rows.push({ target: path, file: filepath, line: i + 1, module: path.split('.').slice(0, -1).join('.'),
        name: path.split('.').pop(), alias: null, relative: false, star: false, lang: 'cs' });
      continue;
    }
    if ((m = /^\s*using\s+([A-Za-z_][\w]*)\s*=\s*([A-Za-z_][\w.]*)\s*;/.exec(line))) {
      rows.push({ target: m[2], file: filepath, line: i + 1, module: m[2], name: null, alias: m[1],
        relative: false, star: false, lang: 'cs' });
      continue;
    }
    if ((m = /^\s*(?:global\s+)?using\s+([A-Za-z_][\w.]*)\s*;/.exec(line))) {
      rows.push({ target: m[1], file: filepath, line: i + 1, module: m[1], name: null, alias: null,
        relative: false, star: false, lang: 'cs' });
    }
  }
  return rows;
}

/** Per-language dispatch for one file; null when the language has no extractor yet. */
export function extractFileImports(lines, filepath, opts = {}) {
  if (isPythonFile(filepath)) return extractPythonImports(lines, filepath, opts).map((r) => ({ lang: 'py', ...r }));
  if (isJsFile(filepath)) return extractJsImports(lines, filepath, opts);
  if (isCFile(filepath)) return extractCImports(lines, filepath, opts);
  if (isJavaFile(filepath)) return extractJavaImports(lines, filepath);
  if (isCSharpFile(filepath)) return extractCSharpImports(lines, filepath);
  return null;
}
