// imports.js — per-language import extractor (Py/JS/C/Java/C#, plus HTML script/link/importmap tags) classifying rows internal/stdlib/third-party/vendored
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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
 * Languages: extractImports covers Python (.py/.pyi); extractJsImports,
 * extractCImports (incl. ObjC #import/@import), extractJavaImports and
 * extractCSharpImports cover the other families, extractHtmlImports reads
 * what a page LOADS (script/link/importmap tags), manifestDeps reads the
 * package manifests, and classifyImports resolves every row four ways
 * (internal / stdlib-platform / third-party / vendored) for --bom. The AI/ML
 * detectors still match imports ad hoc per framework family
 * (ai-ml-detectors.js); this is the one place imports are cataloged
 * generically.
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
        : isCFile(filepath) ? 'c' : isJavaFile(filepath) ? 'java'
          : (isHtmlFile(filepath) || isTemplateFile(filepath)) ? 'html' : 'cs';
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

// .xs is xmlui's JavaScript-dialect script file — plain JS import syntax
// (bom-small-fixes-sweep-residue: the .xmlui_code index read "no extractable
// files" while holding a JS-dialect corpus).
export function isJsFile(filepath) { return /\.(?:jsx?|tsx?|mjs|cjs|xs)$/i.test(filepath); }
export function isCFile(filepath) { return /\.(?:c|h|cc|hh|cpp|hpp|cxx|hxx|inl)$/i.test(filepath); }
export function isJavaFile(filepath) { return /\.(?:java|kt|kts)$/i.test(filepath); }
export function isCSharpFile(filepath) { return /\.cs$/i.test(filepath); }
export function isHtmlFile(filepath) { return /\.(?:html?|xhtml)$/i.test(filepath); }
// Server-side page templates carry a web app's <script>/<link> tags as often
// as .html does, so the tag scan runs on them when they are indexed (most of
// these extensions need --add-extensions at build). Only what the page LOADS
// is read: the template language's own imports (PHP use/require, Ruby
// require) have no extractor here.
export function isTemplateFile(filepath) {
  return /\.(?:php|phtml|jsp|jspx|aspx|ascx|cshtml|vbhtml|razor|erb|ejs|hbs|handlebars|mustache|twig|njk|nunjucks|jinja2?|j2|liquid|tpl|tmpl)$/i.test(filepath);
}

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
    // A URL specifier (`import x from 'https://esm.sh/preact@10'`) is a
    // library loaded over the network, not an npm name: carry the host and
    // the library/version the URL names (bom-html-loaded-libraries).
    const isUrl = /^(?:https?:)?\/\//i.test(module);
    const lib = isUrl ? libFromUrl(module) : null;
    const head = lib && lib.name ? lib.name : module;   // the census ranks `preact.default`, not the URL
    rows.push({
      target: name ? `${head}.${name}` : head,
      file: filepath, line, module, name: name || null, alias: alias || null,
      relative, star: !!star, lang: 'js',
      ...(isUrl ? { url: true, host: lib ? lib.host : null, libName: lib ? lib.name : null, libVersion: lib ? lib.version : null } : {}),
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

/** C/C++: #include; ObjC: #import and @import. Quoted includes are `relative` (project-local); angle-bracket includes are the external surface. */
export function extractCImports(lines, filepath, opts = {}) {
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    // ObjC modules: `@import Foundation;` — a module name, no header file.
    // (bom-small-fixes-sweep-residue; with #import below, the fix for the iOS
    // headers index reading 26,175 files / zero import sites.)
    const om = /^\s*@import\s+([A-Za-z_][\w.]*)\s*;/.exec((lines[i] || '').replace(/\r+$/, ''));
    if (om) {
      rows.push({
        target: om[1], file: filepath, line: i + 1,
        module: om[1], name: null, alias: null, relative: false, star: false, lang: 'c', objcModule: true,
      });
      continue;
    }
    // MSVC linker inputs declared in source: the closest thing Windows C code
    // has to a dependency manifest that lives IN the corpus. One row per
    // pragma, linkLib:true, so the BoM shows the .lib surface beside the
    // header surface (Andrew's ask, 2026-09-04: "something that showed .lib
    // files rather than .h"). Build-file manifests (.vcxproj AdditionalDeps,
    // CMake target_link_libraries) are a later manifest kind.
    const pl = /^\s*#\s*pragma\s+comment\s*\(\s*lib\s*,\s*"([^"]+)"\s*\)/.exec((lines[i] || '').replace(/\r+$/, ''));
    if (pl) {
      rows.push({
        target: pl[1], file: filepath, line: i + 1,
        module: pl[1], name: null, alias: null, relative: false, star: false, lang: 'c', linkLib: true,
      });
      continue;
    }
    // #import is ObjC's #include-with-once semantics — same quoted-vs-angle
    // meaning, same row shape.
    const m = /^\s*#\s*(?:include|import)\s*(<([^>]+)>|"([^"]+)")/.exec((lines[i] || '').replace(/\r+$/, ''));
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
  if (isHtmlFile(filepath) || isTemplateFile(filepath)) return extractHtmlImports(lines, filepath, opts);
  return null;
}

// ===========================================================================
// bom-html-loaded-libraries: what a web page LOADS. A front end's libraries
// often arrive by <script src>, <link rel="stylesheet">, an importmap or a
// URL import rather than by an import statement, and none of those were
// read: Mermaid, loaded by one <script> tag in public/index.html, was absent
// from --bom and --census-imports on CodeExam's own index (2026-10-17).
//
// Rows keep the shape above. `module` is the raw src/href/URL, `target` the
// library name the tag loads (what the census ranks), `lang` is 'html' and
// `kind` names the tag (script-tag / stylesheet / modulepreload / preload /
// importmap). `libName` / `libVersion` come from the filename
// (jquery-3.7.1.min.js) or a CDN path (jsDelivr, unpkg, esm.sh, cdnjs,
// Google Hosted Libraries) — never from the loaded file's contents, which
// the index usually does not hold: vendor/ and its kin are skipped at build
// (archive.js SKIP_DIRS). A local path under such a directory is still a
// library (relative: false, so the census counts it); any other local path
// is the page's own asset (relative: true, intra-package wiring).
// ===========================================================================

const _CDN_PATH_PATTERNS = [
  /^\/npm\/((?:@[^/@]+\/)?[^/@]+)(?:@v?([^/]+))?/,   // cdn.jsdelivr.net/npm/<name>@<ver>/…
  /^\/gh\/[^/]+\/([^/@]+)(?:@v?([^/]+))?/,            // cdn.jsdelivr.net/gh/<user>/<repo>@<ver>/…
  /^\/ajax\/libs\/([^/]+)\/([^/]+)\//,                // cdnjs.cloudflare.com and ajax.googleapis.com /ajax/libs/<name>/<ver>/…
  /^\/((?:@[^/@]+\/)?[^/@]+)@v?([^/]+)/,              // unpkg.com/<name>@<ver>/…, esm.sh/<name>@<ver>
];

/**
 * Library name and version from a loaded file's basename:
 *   jquery-3.7.1.min.js -> { name: 'jquery', version: '3.7.1' }
 *   mermaid.min.js      -> { name: 'mermaid', version: null }
 *   bootstrap.bundle.min.js -> 'bootstrap';  d3.v7.min.js -> { 'd3', '7' }
 */
export function libFromBasename(base) {
  let b = String(base || '').split(/[?#]/)[0];
  b = b.replace(/\.(?:m?js|cjs|css|wasm)$/i, '');
  b = b.replace(/\.(?:min|bundle|umd|esm|iife|global|prod|production|development|dev|slim)(?=\.|$)/gi, '');
  let version = null;
  const v = /^(.*?)[-_.@](?:v(\d+(?:\.\d+)*)|(\d+(?:\.\d+)+)(?:[-+][\w.]+)?)$/.exec(b);
  if (v) { b = v[1]; version = v[2] || v[3]; }
  b = b.replace(/[-_.]+$/, '');
  return { name: b || String(base || ''), version };
}

/** Library name, version and host from a URL; CDN path conventions first, then the basename rule. */
export function libFromUrl(url) {
  let u;
  try { u = new URL(/^\/\//.test(url) ? `https:${url}` : url); } catch { return null; }
  for (const re of _CDN_PATH_PATTERNS) {
    const m = re.exec(u.pathname);
    if (m) return { host: u.hostname, name: m[1], version: m[2] || null, fromPath: true };
  }
  const { name, version } = libFromBasename(u.pathname.split('/').pop());
  return { host: u.hostname, name, version, fromPath: false };
}

// Attribute value out of one tag's attribute text; `(?:^|[\s"'])` keeps
// `data-src=` from matching `src=`.
const _htmlAttr = (tag, name) => {
  const m = new RegExp(`(?:^|[\\s"'])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : null;
};

/** HTML: <script src>, <link rel="stylesheet"|"modulepreload"|"preload" as=script/style>, importmap entries. */
export function extractHtmlImports(lines, filepath, opts = {}) {
  const rows = [];
  const raw = (lines || []).map((l) => String(l || '').replace(/\r+$/, '')).join('\n');
  // Blank comments, keeping their newlines so offsets still map to lines.
  const text = raw.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (at) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= at) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const push = (kind, src, at, extra = {}) => {
    const s = String(src || '').trim();
    if (!s || /^(?:data|javascript|blob|about):/i.test(s)) return;
    // A templated value (`{{ static('js/app.js') }}`, `<?= asset('x.js') ?>`,
    // `<%= asset_path 'x.js' %>`) names its asset in a quoted literal when it
    // names one at all; that literal is what resolves. The raw value stays in
    // `module` so the row is traceable. With no literal the row is kept but
    // treated as the page's own wiring (relative), so the census does not
    // rank a template expression as a library; --bom still lists it.
    const templated = /\{\{|\{%|<%|<\?|\$\{|@\(/.test(s);
    const literal = templated ? ((/['"]([^'"]*\.(?:m?js|cjs|css|wasm))(?:\?[^'"]*)?['"]/i.exec(s) || [])[1] || null) : null;
    const effective = templated ? literal : s;
    const isUrl = !!effective && /^(?:https?:)?\/\//i.test(effective);
    const path = effective ? effective.split(/[?#]/)[0] : null;
    const vendored = !!path && !isUrl && VENDOR_DIR_RE.test(path);
    const relative = !isUrl && !vendored;
    if (relative && !opts.includeRelative) return;
    const lib = !effective ? null : isUrl ? libFromUrl(effective) : libFromBasename(path.split('/').pop());
    const name = (lib && lib.name) || s;
    rows.push({
      target: name, file: filepath, line: lineOf(at),
      module: s, name: null, alias: null, relative, star: false, lang: 'html', kind,
      url: isUrl, host: isUrl && lib ? lib.host : null,
      libName: name, libVersion: lib ? lib.version : null,
      ...(templated ? { templated: true, templatedPath: path } : {}), ...extra,
    });
  };
  // A quoted attribute value may itself contain `>` (`src="<?= asset('x') ?>"`),
  // so the tag body is quoted strings or non-`>` characters, not just non-`>`.
  const tagRe = /<(script|link)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
  let m;
  while ((m = tagRe.exec(text))) {
    const tag = m[2];
    if (m[1].toLowerCase() === 'script') {
      if ((_htmlAttr(tag, 'type') || '').toLowerCase() === 'importmap') {
        const end = text.indexOf('</script', tagRe.lastIndex);
        const body = end < 0 ? '' : text.slice(tagRe.lastIndex, end);
        let map = null;
        try { map = JSON.parse(body); } catch { map = null; }
        const imports = map && map.imports && typeof map.imports === 'object' ? map.imports : {};
        for (const [specifier, dest] of Object.entries(imports)) {
          if (typeof dest !== 'string') continue;
          const at = text.indexOf(JSON.stringify(specifier), tagRe.lastIndex);
          push('importmap', dest, at < 0 ? m.index : at, { importName: specifier });
        }
        continue;
      }
      const src = _htmlAttr(tag, 'src');
      if (src) push('script-tag', src, m.index);
      continue;
    }
    const rel = (_htmlAttr(tag, 'rel') || '').toLowerCase();
    const href = _htmlAttr(tag, 'href');
    if (!href) continue;
    if (/\bstylesheet\b/.test(rel)) push('stylesheet', href, m.index);
    else if (/\bmodulepreload\b/.test(rel)) push('modulepreload', href, m.index);
    else if (/\bpreload\b/.test(rel) && /^(?:script|style)$/i.test(_htmlAttr(tag, 'as') || '')) push('preload', href, m.index);
  }
  return rows;
}

/**
 * The HTML half of a report's coverage statement, or null when nothing needs
 * saying. An index stores the extensions its ARCHIVE expansion skipped (#191,
 * `skipped_extensions`; a plain directory build stores none — its on-disk skip
 * census is a live scan at build time), so an archive-built index can name the
 * HTML it never saw; otherwise an index with JS and no HTML gets the
 * conditional form. Reading the source tree to count is not an option here:
 * reports answer from the index alone.
 */
export function htmlCoverageNote(index, filesByLang) {
  const skipped = (index && index.skippedExtensions) || {};
  const n = ['.html', '.htm', 'html', 'htm'].reduce((s, k) => s + (Number(skipped[k]) || 0), 0);
  if (n) {
    return `${n} HTML file(s) were not indexed at build (not in the default extensions), so their tags were not read; ` +
      'rebuild with --add-extensions .html,.htm to include them.';
  }
  const html = (filesByLang && filesByLang.html) || 0;
  const js = (filesByLang && filesByLang.js) || 0;
  if (!html && js) {
    return 'No HTML in this index: if the source has pages that load libraries by <script> or <link> tags, ' +
      'those were not read; rebuild with --add-extensions .html,.htm.';
  }
  return null;
}

/**
 * Tag-shaped strings in NON-page files: HTML that code emits
 * (`writeText("<script src=\"http://…/ga.js\">")` — jdiff, in
 * .android-1.5-java — or a snippet in a README). Not rows: a dependency of the
 * generated output, not of the program, with no page context to resolve a
 * local path, and --referenced-resources already catalogues the URLs. But the
 * reports say they exist, so "not in the BoM" is not read as "nothing this
 * code makes loads it" (Andrew, 2026-10-17). Counts sites and distinct files.
 */
const _CODE_TAG_RE = /<(?:script\b[^>]*?\bsrc\s*=|link\b[^>]*?\bhref\s*=)/gi;
export function tagsInCodeStrings(index) {
  let sites = 0;
  const files = new Set();
  for (const [filepath, lines] of index.fileLines) {
    if (isHtmlFile(filepath) || isTemplateFile(filepath)) continue;
    for (const line of lines) {
      if (!/<(?:script|link)\b/i.test(line)) continue;
      const n = (String(line).match(_CODE_TAG_RE) || []).length;
      if (n) { sites += n; files.add(filepath); }
    }
  }
  return { sites, files: files.size };
}

/** The signpost line for `tagsInCodeStrings` counts, or null when there are none. */
export function codeStringTagNote({ sites = 0, files = 0 } = {}) {
  if (!sites) return null;
  return `${sites} script/link tag(s) inside non-page files (code strings, docs) in ${files} file(s), not counted above; ` +
    '--referenced-resources catalogues the URLs they name.';
}

// ===========================================================================
// imports-bill-of-materials: the RESOLVER (#312's missing layer). For any
// import row, answer: is the target inside the corpus, in the language's
// standard library / platform SDK, third-party, or vendored?
//
// Every classification REPORTS ITS SOURCE — a fixed list, a manifest, a
// declared package, a resolved path — and a target that resolves to none
// says so rather than being guessed at (the residue-reports-itself rule).
// The word lists below are the resolver's whole vocabulary: nothing learned,
// nothing hidden, and a wrong entry is a one-line fix.
//
// Four classes plus the residue:
//   internal     the target is this corpus's own code
//   stdlib       the language's standard library, or the platform SDK the
//                corpus is built against (the source string names which list)
//   third-party  declared by a package manifest indexed with the corpus
//   vendored     resolves into a subtree that is someone else's code carried
//                in-tree (vendor/, third_party/, node_modules/, ...)
//   external     the residue: none of the above could be shown from what the
//                index holds. NOT a finding of third-party — a statement that
//                no manifest or list confirmed it.
// ===========================================================================

const NODE_BUILTINS = new Set(('assert async_hooks buffer child_process cluster console constants crypto dgram'
  + ' diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process'
  + ' punycode querystring readline repl stream string_decoder timers tls trace_events tty url util v8 vm wasi'
  + ' worker_threads zlib').split(' '));

const PY_STDLIB = new Set(('abc argparse array ast asyncio base64 bisect builtins calendar cmath codecs collections'
  + ' concurrent configparser contextlib copy csv ctypes dataclasses datetime decimal difflib dis email enum errno'
  + ' fnmatch functools gc getopt getpass glob gzip hashlib heapq hmac html http importlib inspect io itertools json'
  + ' keyword logging marshal math mimetypes multiprocessing operator os pathlib pickle pkgutil platform pprint'
  + ' pstats queue random re secrets select shlex shutil signal site socket sqlite3 ssl stat statistics string struct'
  + ' subprocess sys sysconfig tarfile tempfile textwrap threading time timeit token tokenize traceback types typing'
  + ' unicodedata unittest urllib uuid venv warnings weakref xml zipfile zlib __future__').split(' '));

const C_STD_HEADERS = new Set(('assert.h complex.h ctype.h errno.h fenv.h float.h inttypes.h iso646.h limits.h'
  + ' locale.h math.h setjmp.h signal.h stdalign.h stdarg.h stdatomic.h stdbool.h stddef.h stdint.h stdio.h stdlib.h'
  + ' stdnoreturn.h string.h tgmath.h threads.h time.h uchar.h wchar.h wctype.h'
  + ' algorithm array atomic bitset cassert cctype chrono cmath cstdarg cstddef cstdint cstdio cstdlib cstring ctime'
  + ' deque exception filesystem fstream functional initializer_list iomanip iostream istream iterator limits list'
  + ' map memory mutex new numeric optional ostream queue random regex set sstream stack stdexcept string'
  + ' string_view thread tuple type_traits typeinfo unordered_map unordered_set utility variant vector').split(' '));

const POSIX_HEADERS = new Set(('unistd.h fcntl.h pthread.h dirent.h dlfcn.h poll.h semaphore.h termios.h getopt.h'
  + ' sys/types.h sys/stat.h sys/time.h sys/socket.h sys/mman.h sys/wait.h sys/ioctl.h netinet/in.h netinet/tcp.h'
  + ' arpa/inet.h netdb.h').split(' '));

const WINDOWS_HEADERS = new Set(('windows.h io.h direct.h conio.h tchar.h winsock2.h ws2tcpip.h process.h'
  + ' winbase.h wincrypt.h shlobj.h').split(' '));

// Pre-standard C++ iostream-era headers, still met in older corpora.
const LEGACY_CXX_HEADERS = new Set('fstream.h iostream.h iomanip.h strstream.h'.split(' '));

// Windows SDK import libraries met in #pragma comment(lib, ...) — the OS
// surface, as distinct from a third-party .lib shipped beside the code.
const WINDOWS_SYSTEM_LIBS = new Set(('kernel32 user32 gdi32 advapi32 shell32 ole32 oleaut32 comctl32 comdlg32'
  + ' winmm ws2_32 wsock32 crypt32 secur32 iphlpapi wininet winhttp version shlwapi psapi setupapi rpcrt4'
  + ' uuid dbghelp netapi32 userenv mpr opengl32 glu32 dsound ddraw dinput8 xinput d3d9 d3d11 dxgi msimg32'
  + ' gdiplus wtsapi32 pdh powrprof cfgmgr32').split(' '));

// ObjC `@import <Module>;` — the common Apple platform modules. A module not
// on the list stays external and says so; the list is the whole vocabulary.
const APPLE_FRAMEWORKS = new Set(('Foundation UIKit AppKit CoreFoundation CoreGraphics CoreData CoreMedia'
  + ' CoreVideo CoreAudio CoreLocation CoreText CoreImage AVFoundation AVKit QuartzCore Security'
  + ' SystemConfiguration Metal MetalKit MapKit WebKit StoreKit CloudKit HealthKit HomeKit GameKit SpriteKit'
  + ' SceneKit ARKit Photos PhotosUI Contacts EventKit MessageUI SafariServices UserNotifications Network'
  + ' Combine SwiftUI ObjectiveC Darwin os simd Accelerate AudioToolbox VideoToolbox MediaPlayer CallKit'
  + ' Intents WidgetKit').split(' '));

// Ordered: first match wins, so a corpus that IS androidx (ExoPlayer) still
// classifies androidx.* as internal — declared corpus packages are checked
// BEFORE these lists ever apply.
const JAVA_PLATFORM_PREFIXES = [
  ['java.', 'java standard library'], ['javax.', 'java standard library'], ['jdk.', 'java standard library'],
  ['kotlin.', 'kotlin standard library'], ['kotlinx.', 'kotlinx (JetBrains) library'],
  ['android.', 'android platform SDK'], ['androidx.', 'androidx (jetpack) library'],
  ['dalvik.', 'android platform SDK'],
];
const CS_PLATFORM_PREFIXES = [
  ['System', '.NET standard library'], ['Microsoft.', '.NET platform'], ['Windows.', 'windows platform'],
  ['WinRT.', 'windows runtime projection (CsWinRT)'],
];

// COM type-library interop namespaces follow the tlbimp `XxxLib` convention
// (FAXCOMEXLib, CERTENROLLLib). The name alone cannot say whether the
// underlying COM component is a Windows one or third-party, so the class
// stays external — but the WHY names the convention instead of shrugging.
const COM_TLB_RE = /^[A-Z][A-Za-z0-9]*Lib$/;

const VENDOR_DIR_RE = /(^|[\\/])(vendor|vendors|third[-_]?party|thirdparty|external|extern|node_modules|deps|contrib)([\\/]|$)/i;

const _norm = (p) => String(p || '').replace(/\\/g, '/');
const _pkgKey = (s) => String(s || '').toLowerCase().replace(/[-_.]/g, '');

/** Best-effort dependency names from one indexed manifest file. */
export function manifestDeps(filepath, lines) {
  const base = _norm(filepath).split('/').pop().toLowerCase();
  const text = (lines || []).join('\n');
  const deps = new Set();
  const add = (d) => { const t = String(d || '').trim(); if (t) deps.add(t); };
  try {
    if (base === 'package.json') {
      const j = JSON.parse(text);
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const d of Object.keys(j[k] || {})) add(d);
      }
    } else if (/^requirements[^/]*\.txt$/.test(base) || base === 'constraints.txt') {
      for (const l of lines) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l.replace(/\r+$/, ''));
        if (m && !l.trim().startsWith('#') && !l.trim().startsWith('-')) add(m[1]);
      }
    } else if (base === 'pyproject.toml' || base === 'cargo.toml') {
      // dependencies arrays and [*dependencies] table keys, regex-level only.
      let inDeps = false;
      for (const l of lines) {
        const s = l.replace(/\r+$/, '');
        if (/^\s*\[.*dependencies.*\]\s*$/i.test(s)) { inDeps = true; continue; }
        if (/^\s*\[/.test(s)) { inDeps = false; continue; }
        if (inDeps) { const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(s); if (m) add(m[1]); }
        const arr = /^\s*"([A-Za-z0-9][A-Za-z0-9._-]*)[^"]*"\s*,?\s*$/.exec(s);
        if (arr) add(arr[1]);
      }
    } else if (base === 'go.mod') {
      for (const l of lines) { const m = /^\s*(?:require\s+)?([\w.-]+(?:\/[\w.-]+)+)\s+v/.exec(l); if (m) add(m[1]); }
    } else if (base === 'pom.xml') {
      let group = null;
      for (const l of lines) {
        let m;
        if ((m = /<groupId>([^<]+)<\/groupId>/.exec(l))) group = m[1].trim();
        if ((m = /<artifactId>([^<]+)<\/artifactId>/.exec(l)) && group) { add(group); add(`${group}:${m[1].trim()}`); }
      }
    } else if (/\.gradle(\.kts)?$/.test(base)) {
      for (const l of lines) {
        const re = /['"]([\w.-]+):([\w.-]+):[^'"]*['"]/g;
        let m; while ((m = re.exec(l))) { add(m[1]); add(`${m[1]}:${m[2]}`); }
      }
    } else if (/\.csproj$/.test(base) || base === 'packages.config') {
      for (const l of lines) {
        const m = /(?:PackageReference\s+Include|id)\s*=\s*"([^"]+)"/.exec(l);
        if (m) add(m[1]);
      }
    }
  } catch { /* a malformed manifest yields what it yields; best-effort by design */ }
  return deps;
}

const MANIFEST_BASENAME_RE = /^(package\.json|requirements[^/]*\.txt|constraints\.txt|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|.*\.gradle(\.kts)?|.*\.csproj|packages\.config)$/i;

/**
 * One pass over the index: everything the classifier keys on. Cheap relative
 * to extraction; recomputed per call, never cached on the index.
 */
export function corpusFacts(index) {
  const facts = {
    basenames: new Set(),            // every indexed file's basename (C include resolution)
    paths: new Set(),                // normalized indexed paths
    topLevel: new Set(),             // top-level dir / module names (Python roots)
    pyModules: new Set(),            // indexed .py basenames (bare sibling imports)
    javaPackages: [],                // declared `package a.b.c` / `namespace A.B` prefixes, longest first
    vendorSubtrees: new Map(),       // vendor dir path -> file count
    manifests: [],                   // { file, deps:Set }
    depKeys: new Set(),              // normalized dep names across manifests
    depPrefixes: [],                 // dotted dep prefixes (java groupIds, go modules)
  };
  const pkgSet = new Set();
  for (const [filepath, lines] of index.fileLines) {
    const p = _norm(filepath);
    facts.paths.add(p);
    const segs = p.split('/');
    facts.basenames.add(segs[segs.length - 1]);
    facts.topLevel.add(segs[0].replace(/\.(py|pyi)$/i, ''));
    // A bare `import config_parser` beside config_parser.py ANYWHERE in the
    // corpus is intra-corpus wiring, whatever directory it sits in.
    if (isPythonFile(p)) facts.pyModules.add(segs[segs.length - 1].replace(/\.(py|pyi)$/i, ''));
    const vm = VENDOR_DIR_RE.exec(p);
    if (vm) {
      const at = p.toLowerCase().indexOf(vm[2].toLowerCase());
      const subtree = p.slice(0, at + vm[2].length);
      facts.vendorSubtrees.set(subtree, (facts.vendorSubtrees.get(subtree) || 0) + 1);
    }
    if (isJavaFile(filepath) || isCSharpFile(filepath)) {
      for (const l of lines.slice(0, 40)) {
        const m = /^\s*(?:package|namespace)\s+([A-Za-z_][\w.]*)/.exec(stripSlashComment(l));
        if (m) { pkgSet.add(m[1]); break; }
      }
    }
    if (MANIFEST_BASENAME_RE.test(segs[segs.length - 1])) {
      const deps = manifestDeps(filepath, lines);
      if (deps.size) {
        facts.manifests.push({ file: filepath, deps });
        for (const d of deps) {
          facts.depKeys.add(_pkgKey(d.includes(':') ? d.split(':').pop() : d.split('/').pop()));
          if (d.includes('.') || d.includes('/')) facts.depPrefixes.push(d.replace(/:/g, '.'));
        }
      }
    }
  }
  facts.javaPackages = [...pkgSet].sort((a, b) => b.length - a.length);
  facts.depPrefixes.sort((a, b) => b.length - a.length);
  return facts;
}

const _underPrefix = (mod, prefix) => mod === prefix || mod.startsWith(prefix.endsWith('.') ? prefix : prefix + '.');

/** Classify ONE import row against the corpus facts. Returns { cls, source }. */
export function classifyImportRow(row, facts) {
  const mod = String(row.module || row.target || '');
  const vendoredAt = (p) => {
    for (const subtree of facts.vendorSubtrees.keys()) if (p === subtree || p.startsWith(subtree + '/')) return subtree;
    return null;
  };
  if (row.lang === 'c') {
    if (row.linkLib) {
      const lib = mod.toLowerCase().replace(/\.lib$/, '');
      if (WINDOWS_SYSTEM_LIBS.has(lib)) return { cls: 'stdlib', source: 'windows system library (#pragma comment(lib))' };
      return { cls: 'external', source: 'linker input (#pragma comment(lib))' };
    }
    if (row.objcModule) {
      if (APPLE_FRAMEWORKS.has(mod)) return { cls: 'stdlib', source: 'apple platform framework (@import)' };
      return { cls: 'external', source: 'ObjC @import module; not on the apple framework list' };
    }
    const base = _norm(mod).split('/').pop();
    // List lookups are case-insensitive: Windows filesystems are, and real
    // corpora write `Windows.h` and `windows.h` interchangeably (the capital
    // form was the top residue row on .WinAPI_Classic). Index RESOLUTION
    // keeps the raw spelling — path identity is the index's own.
    const baseLc = base.toLowerCase();
    // Resolve against indexed paths first: suffix match on the include text,
    // then bare basename — a vendored header classifies by where it LIVES.
    let hit = null;
    const normMod = _norm(mod);
    for (const p of facts.paths) {
      if (p === normMod || p.endsWith('/' + normMod)) { hit = p; break; }
    }
    if (!hit && facts.basenames.has(base)) {
      for (const p of facts.paths) if (p.endsWith('/' + base) || p === base) { hit = p; break; }
    }
    if (hit) {
      const v = vendoredAt(hit);
      if (v) return { cls: 'vendored', source: `resolves to \`${hit}\` under vendored subtree \`${v}/\`` };
      return { cls: 'internal', source: `resolves to \`${hit}\` in this index` };
    }
    if (row.relative) return { cls: 'internal', source: 'quoted #include (project-local convention); target file not in this index' };
    const normLc = normMod.toLowerCase();
    if (C_STD_HEADERS.has(baseLc) || C_STD_HEADERS.has(normLc)) return { cls: 'stdlib', source: 'ISO C/C++ standard header list' };
    if (POSIX_HEADERS.has(normLc) || POSIX_HEADERS.has(baseLc)) return { cls: 'stdlib', source: 'POSIX header list' };
    if (WINDOWS_HEADERS.has(baseLc)) return { cls: 'stdlib', source: 'windows platform header list' };
    if (/^(afx|atl)[a-z0-9_]*\.h$/.test(baseLc)) return { cls: 'stdlib', source: 'windows platform header list (MFC/ATL)' };
    if (LEGACY_CXX_HEADERS.has(baseLc)) return { cls: 'stdlib', source: 'pre-standard C++ header list (legacy)' };
    // C++/WinRT projection headers: winrt/Windows.*.h is the Windows SDK
    // projection, winrt/Microsoft.*.h the Windows App SDK / WinUI one —
    // platform surface either way (.WinAPI_Classic's residue was full of
    // both, 16+10+8... sites a row).
    if (normLc.startsWith('winrt/')) {
      return { cls: 'stdlib', source: normLc.startsWith('winrt/microsoft.')
        ? 'C++/WinRT projection header (Windows App SDK)'
        : 'C++/WinRT projection header (Windows SDK)' };
    }
    return { cls: 'external', source: 'angle include; no standard-list or index match' };
  }
  if (row.lang === 'html') {
    const kind = row.kind || 'tag';
    const where = `${kind} in \`${row.file}:${row.line}\`${row.templated ? ' (templated src)' : ''}`;
    if (row.url) {
      const lib = libFromUrl(row.templatedPath || mod);
      const host = lib ? lib.host : '?';
      if (lib && facts.depKeys.has(_pkgKey(lib.name.split('/').pop()))) {
        return { cls: 'third-party', source: `declared in an indexed manifest (\`${lib.name}\`); loaded from \`${host}\` by ${where}` };
      }
      return { cls: 'external', source: `loaded from \`${host}\` by ${where}` };
    }
    if (row.templated && !row.templatedPath) {
      return { cls: 'external', source: `${where} has a template expression (\`${mod}\`) with no literal path to resolve` };
    }
    // A local path: site-root (/vendor/x.js), relative (./x.js, ../x.js) or
    // bare (x.js). Resolve against the indexed paths — as written, beside
    // the page, or by suffix — and classify by where the file lives; a
    // path that resolves nowhere is judged by its shape. Either way a
    // library the manifest declares (lib/lodash.min.js with lodash in
    // package.json) is third-party, with the copy's location in the why.
    const declared = row.libName && facts.depKeys.has(_pkgKey(String(row.libName).split('/').pop()));
    const path = _norm(row.templatedPath || mod).split(/[?#]/)[0];
    const rel = path.replace(/^\.?\//, '');
    const htmlDir = _norm(row.file).split('/').slice(0, -1);
    const candidates = [rel, [...htmlDir, rel].join('/')];
    if (path.startsWith('../')) {
      const segs = [...htmlDir]; let p = path;
      while (p.startsWith('../') && segs.length) { p = p.slice(3); segs.pop(); }
      candidates.push([...segs, p].join('/'));
    }
    let hit = candidates.find((c) => facts.paths.has(c)) || null;
    if (!hit) for (const p of facts.paths) { if (p.endsWith('/' + rel)) { hit = p; break; } }
    if (hit) {
      const v = vendoredAt(hit);
      if (v) return { cls: 'vendored', source: `resolves to \`${hit}\` under vendored subtree \`${v}/\` (${where})` };
      if (declared) return { cls: 'third-party', source: `declared in an indexed manifest (\`${row.libName}\`); a copy at \`${hit}\` is loaded by ${where}` };
      return { cls: 'internal', source: `resolves to \`${hit}\` in this index (${kind}${row.templated ? ', templated src' : ''})` };
    }
    const vm = VENDOR_DIR_RE.exec(path);
    if (vm) {
      return { cls: 'vendored', source: `${where} loads \`${path}\` under a vendored directory (\`${vm[2]}/\`), which the index skips at build; version from the filename when it has one` };
    }
    if (declared) return { cls: 'third-party', source: `declared in an indexed manifest (\`${row.libName}\`); loaded by ${where} from \`${path}\`, which is not in this index` };
    return { cls: 'external', source: `${where} loads \`${path}\`, which is not in this index` };
  }
  if (row.lang === 'js') {
    if (row.relative) return { cls: 'internal', source: 'relative specifier' };
    if (row.url) {
      const lib = libFromUrl(mod);
      return { cls: 'external', source: `URL import, loaded from \`${lib ? lib.host : '?'}\`` };
    }
    // `@/x` and `~/x` are project-root aliases (Vite/webpack/Next
    // convention), not npm scopes — 916 sites of `@/components` in the sweep.
    if (/^[@~]\//.test(mod)) return { cls: 'internal', source: 'path alias (project-root convention)' };
    const bare = mod.replace(/^node:/, '');
    if (mod.startsWith('node:') || NODE_BUILTINS.has(bare.split('/')[0])) {
      return { cls: 'stdlib', source: 'node builtin list' };
    }
    const pkg = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
    if (facts.depKeys.has(_pkgKey(pkg.split('/').pop()))) {
      return { cls: 'third-party', source: `declared in an indexed manifest (\`${pkg}\`)` };
    }
    // Manifest absence is a corroboration gap, not a per-row deficiency
    // (Andrew, 2026-09-04): with no manifest in the index, each row states
    // its POSITIVE evidence and --bom's Manifests section carries the
    // corroboration note once. With a manifest present, non-declaration IS
    // information (a typo, a transitive dep) and the row says so.
    return { cls: 'external', source: facts.manifests.length
      ? 'not declared in any indexed manifest' : 'bare npm-style specifier' };
  }
  if (row.lang === 'py') {
    const root = mod.split('.')[0];
    if (row.relative) return { cls: 'internal', source: 'relative import' };
    if (facts.topLevel.has(root)) return { cls: 'internal', source: `top-level module \`${root}\` is in this index` };
    if (PY_STDLIB.has(root)) return { cls: 'stdlib', source: 'python standard library list' };
    if (facts.pyModules.has(root)) return { cls: 'internal', source: `module \`${root}.py\` is in this index` };
    if (facts.depKeys.has(_pkgKey(root))) return { cls: 'third-party', source: `declared in an indexed manifest (\`${root}\`)` };
    return { cls: 'external', source: facts.manifests.length
      ? 'not declared in any indexed manifest' : 'not python stdlib; not an indexed module' };
  }
  // java / kotlin / c#
  for (const pkg of facts.javaPackages) {
    if (_underPrefix(mod, pkg)) return { cls: 'internal', source: `corpus declares package \`${pkg}\`` };
  }
  const prefixes = row.lang === 'cs' ? CS_PLATFORM_PREFIXES : JAVA_PLATFORM_PREFIXES;
  for (const [pre, label] of prefixes) {
    if (pre.endsWith('.') ? mod.startsWith(pre) : (mod === pre || mod.startsWith(pre + '.'))) {
      return { cls: 'stdlib', source: label };
    }
  }
  for (const dep of facts.depPrefixes) {
    if (_underPrefix(mod, dep)) return { cls: 'third-party', source: `declared in an indexed manifest (\`${dep}\`)` };
  }
  if (row.lang === 'cs' && COM_TLB_RE.test(mod.split('.')[0])) {
    return { cls: 'external', source: 'COM type-library interop namespace (tlbimp convention); component origin not determinable from the name' };
  }
  return { cls: 'external', source: facts.manifests.length
    ? 'not declared in any indexed manifest'
    : `unrecognized package \`${mod.split('.').slice(0, 2).join('.')}\`` };
}

/**
 * The layer's public face: extract (relative imports INCLUDED — internal
 * wiring is exactly what the internal class counts) and classify every row.
 */
export function classifyImports(index, opts = {}) {
  const { rows, filesByLang } = extractImports(index, { includeRelative: true, ...opts });
  const facts = corpusFacts(index);
  const summary = { internal: 0, stdlib: 0, 'third-party': 0, vendored: 0, external: 0 };
  for (const r of rows) {
    const { cls, source } = classifyImportRow(r, facts);
    r.cls = cls; r.clsSource = source;
    summary[cls] += 1;
  }
  return { rows, facts, summary, filesByLang };
}
