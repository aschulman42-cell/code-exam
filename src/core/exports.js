// exports.js — reads a Python package's declared API (__all__, export decorators, __init__ re-exports) into A/B/C tiers
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * exports.js — declared-exports catalog, core extractors (#153).
 *
 * What a codebase SAYS its public API is, mechanically read from per-language
 * idioms and resolved to definition sites. The language-agnostic record:
 *
 *   { name, dottedPath?, tier, idiom, package, pkgDir,
 *     declSite: {file, line}, defSite: {file, line} | null }
 *
 * Tiers, by authority (#153):
 *   declared  (A) — author explicitly names the API: `__all__` lists,
 *                   `@keras_export("dotted.path")` / `@tf_export(...)`.
 *   promoted  (B) — `__init__.py` re-exports: names reachable as `pkg.X`.
 *                   Relative re-exports always promote; absolute imports
 *                   promote only when the module resolves INSIDE the index
 *                   (self-import) — `import os` is not an export.
 *   heuristic (C) — top-level non-underscore defs; emitted ONLY when a
 *                   package has neither A nor B, labeled as the fallback.
 *
 * HF's `_import_structure` / `_LazyModule` registry is detected but not yet
 * parsed (#153 fast-follow) — affected packages carry an explicit note so
 * the gap never reads as "no exports".
 *
 * Python only today; the records are language-neutral so other languages'
 * idiom extractors (JS `export`, Rust `pub use`, ...) can slot in later.
 */

import { extractPythonImports, isPythonFile } from './imports.js';
import { reTestExamplePath } from './ai-ml-detectors.js';

const norm = (fp) => fp.replace(/\\/g, '/');
const stripCr = (s) => (s || '').replace(/\r+$/, '');

// ---------------------------------------------------------------------------
// Index geography: packages and file lookup
// ---------------------------------------------------------------------------

/**
 * Every directory holding an __init__.py is a package. Root dir '' included.
 * Directories holding .py files but NO indexed __init__.py are added as
 * IMPLICIT packages (initFile null): the build skips zero-length files, so an
 * empty __init__.py (marcotcr/lime's real layout) never reaches the index —
 * and PEP 420 namespace packages have none at all. Without this, such
 * packages vanish from the catalog entirely instead of getting the Tier-C
 * floor they need most.
 */
export function findPackages(index) {
  const pkgs = new Map();
  for (const fp of index.fileLines.keys()) {
    const n = norm(fp);
    if (/(^|\/)__init__\.pyi?$/i.test(n)) {
      const dir = n.replace(/(^|\/)__init__\.pyi?$/i, '');
      pkgs.set(dir, {
        dir,
        dotted: dir.split('/').filter(Boolean).join('.'),
        initFile: fp,
      });
    }
  }
  for (const fp of index.fileLines.keys()) {
    if (!isPythonFile(fp)) continue;
    const n = norm(fp);
    const dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
    if (!pkgs.has(dir)) {
      pkgs.set(dir, {
        dir,
        dotted: dir.split('/').filter(Boolean).join('.'),
        initFile: null,
        implicit: true,
      });
    }
  }
  return pkgs;
}

function buildFileMap(index) {
  const map = new Map();
  for (const fp of index.fileLines.keys()) map.set(norm(fp).toLowerCase(), fp);
  return map;
}

/**
 * Resolve an import module (relative `._pca` / `..base` or absolute
 * `sklearn.base`) to an indexed file. Absolute paths are tried as-is from the
 * index root AND with the first segment dropped — indexes are often built
 * INSIDE the package (`.scikit-learn` stores `base.py`, not `sklearn/base.py`),
 * so `sklearn.base` self-imports resolve only after dropping `sklearn`.
 * Returns the original fileLines key, or null (null on absolute = external).
 */
export function resolveModuleFile(fileMap, pkgDir, mod) {
  const candidates = [];
  if (mod.startsWith('.')) {
    const dots = (/^\.+/.exec(mod))[0].length;
    const rest = mod.slice(dots).split('.').filter(Boolean);
    const base = pkgDir ? pkgDir.split('/').filter(Boolean) : [];
    const up = base.slice(0, Math.max(0, base.length - (dots - 1)));
    candidates.push([...up, ...rest].join('/'));
  } else {
    const segs = mod.split('.');
    candidates.push(segs.join('/'));
    if (segs.length > 1) candidates.push(segs.slice(1).join('/'));
  }
  for (const c of candidates) {
    if (!c) continue;
    for (const suffix of ['.py', '.pyi', '/__init__.py', '/__init__.pyi']) {
      const hit = fileMap.get((c + suffix).toLowerCase());
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Idiom extractors
// ---------------------------------------------------------------------------

/**
 * `__all__ = [...]` (and `__all__ += [...]`) — bounded bracket scan so a
 * multi-line list parses whole; string literals only (computed entries are
 * beyond a mechanical read and simply don't appear).
 */
export function extractDunderAll(lines) {
  const names = [];
  let found = false;
  let computed = false;
  for (let i = 0; i < lines.length; i++) {
    const head = stripCr(lines[i]);
    if (!/^__all__\s*\+?=/.test(head)) continue;
    found = true;
    const startLine = i + 1;
    let buf = head;
    let depth = 0;
    const count = (s) => {
      for (const ch of s.replace(/#.*$/, '')) {
        if (ch === '[' || ch === '(') depth++;
        else if (ch === ']' || ch === ')') depth--;
      }
    };
    count(buf);
    let guard = 0;
    while (depth > 0 && i + 1 < lines.length && guard++ < 200) {
      const s = stripCr(lines[++i]);
      buf += ' ' + s;
      count(s);
    }
    for (const m of buf.matchAll(/["']([A-Za-z_]\w*)["']/g)) {
      names.push({ name: m[1], line: startLine });
    }
    // Honesty check: anything identifier-like left after removing the string
    // literals and syntax means a computed component (`__all__ = _submodules
    // + [...]`, list comprehensions, ...) the mechanical read cannot expand.
    const residue = buf
      .replace(/["'][^"']*["']/g, '')
      .replace(/^__all__\s*\+?=/, '')
      .replace(/#.*$/g, '');
    if (/[A-Za-z_]\w*/.test(residue)) computed = true;
  }
  return { names, found, computed };
}

/**
 * `@keras_export("keras.layers.X")` / `@tf_export(...)` — the decorator
 * argument is the canonical public dotted path; the decorated def/class
 * (within a few lines, past other decorators) is the definition itself.
 */
export function extractExportDecorators(lines, filepath) {
  const rows = [];
  const reDec = /^\s*@(keras_export|tf_export|keras_core_export|api_export)\(\s*["']([\w.]+)["']/;
  for (let i = 0; i < lines.length; i++) {
    const m = reDec.exec(stripCr(lines[i]));
    if (!m) continue;
    for (let j = i + 1; j <= Math.min(i + 10, lines.length - 1); j++) {
      const s = stripCr(lines[j]);
      if (/^\s*(@|$)/.test(s)) continue;          // more decorators / blanks
      const d = /^\s*(?:class|(?:async\s+)?def)\s+([A-Za-z_]\w*)/.exec(s);
      if (d) {
        rows.push({
          name: d[1], dottedPath: m[2], idiom: `@${m[1]}`,
          declLine: i + 1, defLine: j + 1, file: filepath,
        });
      }
      break;                                       // first real statement only
    }
  }
  return rows;
}

/** Top-level `class X` / `def x` / `async def x` / `X =` for NAME.
 *  Exported for the #154 imports-from join (private-or-internal verdict). */
export function findDefLine(lines, name) {
  const reTop = new RegExp(`^(?:class|(?:async\\s+)?def)\\s+${name}\\b`);
  const reAny = new RegExp(`^\\s*(?:class|(?:async\\s+)?def)\\s+${name}\\b`);
  const reAssign = new RegExp(`^${name}\\s*=`);
  for (let pass = 0; pass < 3; pass++) {
    const re = pass === 0 ? reTop : pass === 1 ? reAny : reAssign;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(stripCr(lines[i]))) return i + 1;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Catalog assembly
// ---------------------------------------------------------------------------

const HEURISTIC_CAP = 200;  // per-package Tier-C row bound (disclosed)

/**
 * Build the full export catalog for a loaded index.
 * Returns { records, packages, pyFiles } — packages is the findPackages map
 * augmented with per-package `notes` (e.g. the _LazyModule message).
 */
export function extractExports(index) {
  const packages = findPackages(index);
  const fileMap = buildFileMap(index);
  const records = [];
  let pyFiles = 0;

  const pkgDirs = [...packages.keys()].sort((a, b) => b.length - a.length);
  const pkgOfFile = (fp) => {
    const n = norm(fp);
    return pkgDirs.find(d => d === '' || n.startsWith(d + '/')) ?? null;
  };
  const labelOf = (dir) => (packages.get(dir)?.dotted) || '(root)';

  // --- Tier A, decorator idiom: one global pass over all Python files.
  for (const [fp, lines] of index.fileLines) {
    if (!isPythonFile(fp)) continue;
    pyFiles++;
    for (const d of extractExportDecorators(lines, fp)) {
      // Group under the dotted path's parent (the canonical public package),
      // e.g. keras.activations.relu -> keras.activations.
      const pkgLabel = d.dottedPath.includes('.')
        ? d.dottedPath.slice(0, d.dottedPath.lastIndexOf('.'))
        : d.dottedPath;
      records.push({
        name: d.name, dottedPath: d.dottedPath, tier: 'declared',
        idiom: d.idiom, package: pkgLabel, pkgDir: pkgOfFile(fp),
        declSite: { file: fp, line: d.declLine },
        defSite: { file: fp, line: d.defLine },
      });
    }
  }

  // --- Per package: __all__ (A) + __init__ re-exports (B).
  for (const pkg of packages.values()) {
    const initLines = (pkg.initFile && index.fileLines.get(pkg.initFile)) || [];
    pkg.notes = [];
    // pkg.implicit is rendered by the command layer: a compact [no-init]
    // marker in summary mode (the full sentence repeated per package drowned
    // corpus-scale output), the full note in name-listing mode.
    if (initLines.some(l => /_import_structure|_LazyModule/.test(l))) {
      pkg.notes.push(
        'declares exports via _import_structure/_LazyModule, which the exports ' +
        'detector does not yet parse (#153 fast-follow) — showing __init__ ' +
        're-exports and __all__ only.');
    }

    // Tier B — promoted via __init__ imports.
    const promoted = new Map();
    for (const row of extractPythonImports(initLines, pkg.initFile, { includeRelative: true })) {
      const modFile = resolveModuleFile(fileMap, pkg.dir, row.module);
      if (!row.relative && !modFile) continue;   // absolute + external: not an export
      if (!row.name) continue;                   // plain `import a.b` binds no name here
      const exportName = row.alias || row.name;
      let defSite = null;
      if (row.star) {
        defSite = modFile ? { file: modFile, line: 1 } : null;
      } else if (modFile) {
        const defLine = findDefLine(index.fileLines.get(modFile) || [], row.name);
        if (defLine) defSite = { file: modFile, line: defLine };
        else {
          // `from . import utils` — the name IS a submodule.
          const subFile = resolveModuleFile(fileMap, pkg.dir,
            (row.module.endsWith('.') ? row.module : row.module + '.') + row.name);
          if (subFile) defSite = { file: subFile, line: 1 };
        }
      }
      const rec = {
        name: row.star ? `* (from ${row.module})` : exportName,
        dottedPath: null, tier: 'promoted', idiom: '__init__ re-export',
        package: labelOf(pkg.dir), pkgDir: pkg.dir,
        declSite: { file: pkg.initFile, line: row.line },
        defSite,
      };
      records.push(rec);
      if (!row.star) promoted.set(exportName, rec);
    }

    // Tier A — __all__.
    const dAll = extractDunderAll(initLines);
    pkg.hasDunderAll = dAll.found;
    if (dAll.computed) {
      pkg.notes.push(
        '__all__ includes computed (non-literal) entries — only string ' +
        'literals are read mechanically; the promoted (B) tier usually ' +
        'covers the rest.');
    }
    for (const { name, line } of dAll.names) {
      let defSite = promoted.get(name)?.defSite || null;
      if (!defSite) {
        // A submodule named in __all__ (sklearn's top-level style).
        const subFile = resolveModuleFile(fileMap, pkg.dir, '.' + name);
        if (subFile) defSite = { file: subFile, line: 1 };
      }
      if (!defSite) {
        const defLine = findDefLine(initLines, name);
        if (defLine) defSite = { file: pkg.initFile, line: defLine };
      }
      records.push({
        name, dottedPath: null, tier: 'declared', idiom: '__all__',
        package: labelOf(pkg.dir), pkgDir: pkg.dir,
        declSite: { file: pkg.initFile, line },
        defSite,
      });
    }
  }

  // --- Tier C — heuristic floor, only for packages with nothing above.
  const covered = new Set(records.map(r => r.pkgDir).filter(d => d !== null));
  for (const pkg of packages.values()) {
    if (covered.has(pkg.dir)) continue;
    let emitted = 0;
    let skippedTests = 0;
    const direct = [...index.fileLines.keys()].filter(fp => {
      const n = norm(fp);
      const d = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
      if (d !== pkg.dir || !isPythonFile(fp)) return false;
      // The heuristic floor reads "anything public-looking" — in test/example
      // files that's all noise (the #132 lesson). Skip them, disclosed below.
      if (reTestExamplePath.test(n)) { skippedTests++; return false; }
      return true;
    });
    for (const fp of direct) {
      const lines = index.fileLines.get(fp);
      for (let i = 0; i < lines.length && emitted < HEURISTIC_CAP; i++) {
        const m = /^(?:class|(?:async\s+)?def)\s+([A-Za-z]\w*)/.exec(stripCr(lines[i]));
        if (!m) continue;
        records.push({
          name: m[1], dottedPath: null, tier: 'heuristic',
          idiom: 'top-level def (no __all__ / __init__ re-exports found)',
          package: labelOf(pkg.dir), pkgDir: pkg.dir,
          declSite: { file: fp, line: i + 1 },
          defSite: { file: fp, line: i + 1 },
        });
        emitted++;
      }
    }
    if (emitted >= HEURISTIC_CAP) {
      pkg.notes.push(`heuristic floor capped at ${HEURISTIC_CAP} names.`);
    }
    if (skippedTests && emitted) {
      pkg.notes.push(`heuristic floor skipped ${skippedTests} test/example file(s).`);
    }
  }

  return { records, packages, pyFiles };
}
