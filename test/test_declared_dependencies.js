// test_declared_dependencies.js — package.json's runtime dependencies match what first-party code imports
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// Two directions, both cheap and both load-bearing for the pages that describe
// what CodeExam depends on (docs/CODEEXAM_ARCHITECTURE.md, docs/GETTING_STARTED.md,
// the protective-orders inventory):
//
//   1. Every entry in `dependencies` is imported by at least one first-party file
//      under src/, public/ or scripts/. A declared-but-unused package (express and
//      zod sat in the manifest for months, imported nowhere, and two docs pages
//      described them as CodeExam's web server and validator) fails here instead
//      of drifting into the docs again. `optionalDependencies` is excluded: an
//      optional package is allowed to be absent, so its import is guarded and may
//      be the only reference.
//   2. Every bare package that src/ or public/ imports is declared in
//      `dependencies` or `optionalDependencies` — the mirror defect, relying on a
//      transitive install that a dependency bump can silently drop. scripts/ is
//      not held to this (it may use devDependencies).
//
// Specifiers are found by regex over the source, not by executing it: static
// `import … from` / `export … from` (anchored to a statement at line start —
// CodeExam's own import-analysis code and help text are full of the words
// `import` and `from` in strings, which an unanchored scan reads as imports),
// side-effect `import '…'`, dynamic `import('…')` and `require('…')`. Comment
// lines are stripped so a commented-out import does not count. public/vendor/
// (third-party bundles) is skipped.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIRST_PARTY_DIRS = ['src', 'public', 'scripts'];
const RUNTIME_DIRS = ['src', 'public'];
const SKIP_DIRS = new Set(['node_modules', 'vendor']);
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(p, out); }
    else if (SOURCE_EXT.has(path.extname(ent.name))) out.push(p);
  }
  return out;
}

// Drop block comments and whole-line `//` comments. Trailing inline comments are
// left alone (stripping them would also cut `'http://…'` string literals).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SPECIFIER_RES = [
  /^\s*import\s+[\w$*{}\s,]+?\s+from\s+['"]([^'"]+)['"]/gm,     // import x from 'y'; import { a, b } from 'y'; import * as ns from 'y'
  /^\s*export\s+(?:\*|\{[\w$\s,]*\})\s+from\s+['"]([^'"]+)['"]/gm, // export { a } from 'y'; export * from 'y'
  /^\s*import\s+['"]([^'"]+)['"]/gm,                            // import 'y'
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                     // import('y')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                    // require('y')
];

// Bare package name for a specifier, or null for relative/absolute paths,
// `node:` builtins, bare builtins (`fs`) and package-internal `#imports`.
export function packageNameOf(spec) {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  if (/^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('node:') || spec.startsWith('file:')) return null;
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  if (builtinModules.includes(name)) return null;
  return name;
}

// Map of package name → first file that imports it, over the given dirs.
export function importedPackages(dirs) {
  const seen = new Map();
  for (const d of dirs) {
    for (const file of walk(path.join(ROOT, d))) {
      const src = stripComments(fs.readFileSync(file, 'utf-8'));
      for (const re of SPECIFIER_RES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(src)) !== null) {
          const name = packageNameOf(m[1]);
          if (name && !seen.has(name)) seen.set(name, path.relative(ROOT, file).replace(/\\/g, '/'));
        }
      }
    }
  }
  return seen;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const declared = Object.keys(pkg.dependencies || {});
const optional = Object.keys(pkg.optionalDependencies || {});

test('declared dependencies: package.json has a non-empty dependencies block', () => {
  assert.ok(declared.length > 0, 'package.json dependencies is empty — the scan has nothing to check');
});

test('declared dependencies: every runtime dependency is imported by first-party code', () => {
  const imported = importedPackages(FIRST_PARTY_DIRS);
  const unused = declared.filter(name => !imported.has(name));
  assert.deepStrictEqual(unused, [],
    `declared in package.json dependencies but imported nowhere under ${FIRST_PARTY_DIRS.join('/, ')}/: ${unused.join(', ')} ` +
    '(remove the declaration with `npm uninstall <name>`, or import it)');
});

test('declared dependencies: every bare package imported by src/ or public/ is declared', () => {
  const imported = importedPackages(RUNTIME_DIRS);
  const allowed = new Set([...declared, ...optional]);
  const undeclared = [...imported.entries()].filter(([name]) => !allowed.has(name))
    .map(([name, file]) => `${name} (first import: ${file})`);
  assert.deepStrictEqual(undeclared, [],
    `imported by runtime code but not in package.json dependencies/optionalDependencies: ${undeclared.join('; ')} ` +
    '(a transitive install is not a declaration — `npm install <name>`)');
});

test('declared dependencies: specifier parsing covers the four import forms and skips builtins', () => {
  assert.strictEqual(packageNameOf('node-llama-cpp'), 'node-llama-cpp');
  assert.strictEqual(packageNameOf('@modelcontextprotocol/sdk/server/stdio.js'), '@modelcontextprotocol/sdk');
  assert.strictEqual(packageNameOf('node:fs'), null);
  assert.strictEqual(packageNameOf('fs'), null);
  assert.strictEqual(packageNameOf('./local.js'), null);
  assert.strictEqual(packageNameOf('../up/local.js'), null);
  assert.strictEqual(packageNameOf('#internal'), null);
  const src = stripComments([
    "import a from 'pkg-a';",
    "export { b } from '@scope/pkg-b/sub';",
    "import 'pkg-c';",
    "const d = await import('pkg-d');",
    "const e = require('pkg-e');",
    "// import f from 'pkg-f';   (commented out: must not count)",
    "/* import g from 'pkg-g'; */",
    "const url = 'http://example.com/from/x';",
    "const help = \"an import of x from 'pkg-h' is written as\";   // prose, not a statement",
    "const tmpl = `the line import y from 'pkg-i' in a template`;   // same, in a template literal",
    "import {\n  multi,\n  line\n} from 'pkg-j';",
  ].join('\n'));
  const found = new Set();
  for (const re of SPECIFIER_RES) { re.lastIndex = 0; let m; while ((m = re.exec(src)) !== null) found.add(packageNameOf(m[1])); }
  assert.deepStrictEqual([...found].sort(), ['@scope/pkg-b', 'pkg-a', 'pkg-c', 'pkg-d', 'pkg-e', 'pkg-j']);
});
