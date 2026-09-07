#!/usr/bin/env node
// add-license-headers.js — idempotent Apache-2.0 header inserter; reads docs/source-map.md for per-file descriptions
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * scripts/add-license-headers.js — idempotent Apache-2.0 header inserter.
 *
 * Reads docs/source-map.md (the per-directory tour of first-party files) for
 * each file's one-line description, and inserts a license header appropriate
 * to the file type. Safe to re-run: files already carrying the sentinel line
 * ("Licensed under the Apache License") are skipped, so late-added files get
 * headers on a cheap re-run before release.
 *
 * Usage:
 *   node scripts/add-license-headers.js            # dry run: report only
 *   node scripts/add-license-headers.js --write    # insert headers
 *
 * Scope: tracked first-party source only (from `git ls-files`) —
 * src/**, test/**, scripts/** (.js/.mjs), public/** minus public/vendor/**,
 * and the launchers (ce, CodeExam, ce.bat, CodeExam.bat). Vendored, binary,
 * generated, and data files are never touched.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_MAP = path.join(REPO_ROOT, 'docs', 'source-map.md');
const SENTINEL = 'Licensed under the Apache License';

const HEADER_BODY = (basename, desc) => [
  desc ? `${basename} — ${desc}` : `${basename}`,
  'Copyright (c) 2026 Andrew Schulman',
  'https://github.com/aschulman42-cell/code-exam',
  'Co-authored with Claude (Claude Code).',
  'Licensed under the Apache License, Version 2.0; see LICENSE.',
];

// ---------------------------------------------------------------------------
// Inventory: tracked files filtered to first-party source.

const ALLOW = [
  /^src\/.*\.js$/,
  /^test\/.*\.js$/,
  /^scripts\/.*\.(js|mjs)$/,
  /^public\/.*\.(js|html|css)$/,
];
const ALLOW_EXACT = new Set(['ce', 'CodeExam', 'ce.bat', 'CodeExam.bat']);
const DENY = [/^public\/vendor\//];

function inventory() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT });
  return out.toString('utf8').split('\0').filter(Boolean).filter((f) => {
    if (DENY.some((re) => re.test(f))) return false;
    if (ALLOW_EXACT.has(f)) return true;
    return ALLOW.some((re) => re.test(f));
  }).sort();
}

// ---------------------------------------------------------------------------
// Description map: `- \`path\` — description` bullets in docs/source-map.md.

function loadDescriptions() {
  const map = new Map();
  if (!fs.existsSync(SOURCE_MAP)) return map;
  const text = fs.readFileSync(SOURCE_MAP, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^- `([^`]+)` — (.+)$/);
    if (m) map.set(m[1], m[2].trim());
  }
  return map;
}

// ---------------------------------------------------------------------------
// Per-type comment framing.

function frameHeader(relPath, desc, eol) {
  const base = path.basename(relPath);
  const body = HEADER_BODY(base, desc);
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.js' || ext === '.mjs') return body.map((l) => `// ${l}`).join(eol) + eol;
  if (ext === '.css') return '/*' + eol + body.map((l) => ` * ${l}`).join(eol) + eol + ' */' + eol;
  if (ext === '.html') return '<!--' + eol + body.map((l) => `  ${l}`).join(eol) + eol + '-->' + eol;
  if (ext === '.bat') return body.map((l) => `@REM ${l}`).join(eol) + eol;
  // Extensionless launchers (ce, CodeExam) are POSIX sh.
  return body.map((l) => `# ${l}`).join(eol) + eol;
}

// Where the header goes: after a BOM, after a shebang, after <!DOCTYPE ...>,
// else at the top. A UTF-8 BOM must stay the file's first bytes.
function insertionPoint(relPath, text) {
  const bom = text.startsWith('﻿') ? 1 : 0;
  const rest = text.slice(bom);
  const ext = path.extname(relPath).toLowerCase();
  if (rest.startsWith('#!')) {
    const nl = rest.indexOf('\n');
    return bom + (nl === -1 ? rest.length : nl + 1);
  }
  if (ext === '.html' && /^<!doctype/i.test(rest)) {
    const nl = rest.indexOf('\n');
    return bom + (nl === -1 ? rest.length : nl + 1);
  }
  return bom;
}

// ---------------------------------------------------------------------------

function main() {
  const write = process.argv.includes('--write');
  const descs = loadDescriptions();
  const files = inventory();

  const done = [];
  const added = [];
  const undescribed = [];

  for (const rel of files) {
    const abs = path.join(REPO_ROOT, rel);
    const text = fs.readFileSync(abs, 'utf8');
    if (text.slice(0, 600).includes(SENTINEL)) { done.push(rel); continue; }

    const desc = descs.get(rel) || null;
    if (!desc) undescribed.push(rel);

    // Match the file's own line-ending convention so the diff is header-only.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const header = frameHeader(rel, desc, eol);
    const at = insertionPoint(rel, text);
    const next = text.slice(0, at) + header + text.slice(at);
    if (write) fs.writeFileSync(abs, next);
    added.push(rel);
  }

  const verb = write ? 'inserted' : 'would insert';
  console.log(`${verb}: ${added.length}   already-headered: ${done.length}   total in scope: ${files.length}`);
  if (undescribed.length) {
    console.log(`\nmissing from docs/source-map.md (${undescribed.length}) — header gets no description line:`);
    for (const f of undescribed) console.log(`  ${f}`);
  }
  if (!write && added.length) {
    console.log('\nfiles that would change:');
    for (const f of added) console.log(`  ${f}`);
  }
}

main();
