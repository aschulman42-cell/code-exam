#!/usr/bin/env node
// build-exe.js — compiles the standalone Windows exe via `bun --compile`, staging grammars into dist/
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * scripts/build-exe.js
 *
 * Build CodeExam.exe (Windows-only v0, per #78) using `bun --compile`.
 *
 * Usage:
 *   npm run build:exe                     # full build, all features
 *   npm run build:exe -- --no-llm         # lite build, drop node-llama-cpp
 *                                           (use if Bun won't bundle it cleanly)
 *
 * Output:
 *   dist/codeexam.exe        — standalone Windows binary (~60-100 MB)
 *   dist/grammars/           — tree-sitter WASM grammars (TreeSitterParser
 *                              looks here when __dirname is virtual, as it
 *                              is in a Bun-compiled exe)
 *   dist/README.txt          — short distribution notes (SmartScreen, etc.)
 *
 * Distribution: ship the whole `dist/` directory as a zip. Clive unzips,
 * runs codeexam.exe.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const GRAMMARS_SRC = path.join(ROOT, 'grammars');
const EXE_NAME = 'codeexam.exe';

const argv = process.argv.slice(2);
const liteMode = argv.includes('--no-llm');

function log(msg) { process.stdout.write(`[build-exe] ${msg}\n`); }
function fail(msg) { process.stderr.write(`[build-exe] FAIL: ${msg}\n`); process.exit(1); }

// 1. Verify Bun is on PATH.
{
  const r = spawnSync('bun', ['--version'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) {
    fail(
      'bun not found on PATH. Install with:\n' +
      '  winget install Oven-sh.Bun        (Windows)\n' +
      '  curl -fsSL https://bun.sh/install | bash    (Linux/macOS)\n' +
      'then re-run `npm run build:exe`.'
    );
  }
  log(`bun ${r.stdout.trim()} detected.`);
}

// 2. Prep dist/.
fs.mkdirSync(DIST, { recursive: true });
const exeOut = path.join(DIST, EXE_NAME);
log(`output: ${exeOut}`);

// 3. Build the exe.
// Bun's --compile bundles all reachable JS plus the runtime into one binary.
// --target=bun-windows-x64 produces a Windows exe regardless of host platform.
const bunArgs = [
  'build',
  '--compile',
  '--target=bun-windows-x64',
  './src/index.js',
  '--outfile', exeOut.replace(/\.exe$/, ''), // Bun appends .exe for Windows targets
  // Always-on externals: Bun's bundler statically walks every `import()` /
  // `require()` site, including code paths that only fire on other platforms
  // or in unreachable configurations. These two pull in modules that won't
  // resolve on a Windows-host build and aren't needed at runtime.
  //
  // @babel/preset-typescript: babel resolves it lazily for TS compilation;
  //   CodeExam never compiles TS and webcrack's JS path doesn't trigger it,
  //   but the static walker still fails to resolve the path.
  '--external', '@babel/preset-typescript',
];
if (liteMode) {
  // node-llama-cpp ships per-platform binary sibling packages
  // (@node-llama-cpp/mac-arm64-metal, @node-llama-cpp/linux-x64-cuda, etc.);
  // npm only installs the one matching the current OS, so Bun's bundler
  // can't resolve the others. Externalizing the parent package skips the
  // whole subtree. The semantic-search / local-GGUF features fail at
  // runtime if invoked; everything else works.
  log('lite mode: excluding node-llama-cpp from bundle.');
  bunArgs.push('--external', 'node-llama-cpp');
}

log(`running: bun ${bunArgs.join(' ')}`);
const build = spawnSync('bun', bunArgs, { stdio: 'inherit', cwd: ROOT });
if (build.status !== 0) {
  fail(
    `bun --compile exited with status ${build.status}.\n` +
    'Common causes:\n' +
    '  - node-llama-cpp native module not bundleable → re-run with --no-llm\n' +
    '  - missing dep → `npm install` first\n' +
    '  - Bun version mismatch → ensure Bun >= 1.1'
  );
}

// 4. Copy grammars/ alongside the exe.
if (!fs.existsSync(GRAMMARS_SRC)) {
  fail(`grammars/ source dir not found at ${GRAMMARS_SRC}`);
}
const grammarsDst = path.join(DIST, 'grammars');
fs.mkdirSync(grammarsDst, { recursive: true });
let nWasm = 0;
for (const f of fs.readdirSync(GRAMMARS_SRC)) {
  if (!f.endsWith('.wasm')) continue;
  fs.copyFileSync(path.join(GRAMMARS_SRC, f), path.join(grammarsDst, f));
  nWasm++;
}
log(`copied ${nWasm} grammars to ${grammarsDst}`);

// 4b. Copy public/ alongside the exe — server.js serves browser-facing
// static files (HTML, CSS, JS, vendor assets) from this directory, and
// can't reach the bundled virtual-filesystem copy at runtime.
const PUBLIC_SRC = path.join(ROOT, 'public');
if (!fs.existsSync(PUBLIC_SRC)) {
  fail(`public/ source dir not found at ${PUBLIC_SRC}`);
}
const publicDst = path.join(DIST, 'public');
let nPublic = 0;
function _copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      _copyDir(s, d);
    } else if (ent.isFile()) {
      fs.copyFileSync(s, d);
      nPublic++;
    }
  }
}
_copyDir(PUBLIC_SRC, publicDst);
log(`copied ${nPublic} public/ files to ${publicDst}`);

// 5. Drop a short distribution README into dist/.
const distReadme = `CodeExam standalone (Windows v0)
=================================

Files in this directory:
  codeexam.exe       Standalone CodeExam binary. Includes the Bun runtime;
                     no Node, npm, or Bun install needed.
  grammars/          Tree-sitter WASM grammars. MUST stay alongside codeexam.exe.
  public/            Browser UI assets for --gui mode. MUST stay alongside codeexam.exe.
  README.txt         This file.

First run
---------
Windows SmartScreen will warn "Windows protected your PC" on first run.
Click "More info" then "Run anyway" — the exe is unsigned (no code-signing
certificate in v0; a one-time click-through is expected).

Usage
-----
CLI:   codeexam.exe --build-index <source-dir>
       codeexam.exe --search <term> --index-path <existing-index>
       codeexam.exe --help        for the full flag list

GUI:   codeexam.exe --gui                  starts the server, opens browser
       codeexam.exe --gui --port 9000      override the default port (8080)
       codeexam.exe --gui --index-path <existing-index>

Local-LLM (semantic search) features need a GGUF model file. Documentation
on tested models is in the project README. ${liteMode ? '\nLITE BUILD: this binary was compiled without node-llama-cpp;\nlocal-LLM features are unavailable.\n' : ''}

Project home: https://github.com/aschulman42-cell/code-exam
`;
fs.writeFileSync(path.join(DIST, 'README.txt'), distReadme);
log('wrote dist/README.txt');

// 6. Summary.
const stat = fs.statSync(exeOut);
const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
log(`done. ${EXE_NAME} = ${sizeMB} MB${liteMode ? ' (lite)' : ''}`);
log('distribution: zip the dist/ directory and share.');
