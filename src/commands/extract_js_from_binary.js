// extract_js_from_binary.js — dispatches a native binary to its bundler-specific JS extractor (Bun today) and prints the result
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * `--extract-js-from-binary <path>` — top-level command and format dispatcher
 * for issue #74. Detects the bundler that produced a native install binary,
 * then dispatches to the format-specific extractor to recover embedded JS.
 *
 * Phase 1 ships with the Bun extractor; future phases add `pkg`, `nexe`,
 * Node SEA, Tauri asset table, and Electron `.asar` by registering each
 * new format in the `FORMATS` array below. Each extractor exports a
 * `detect(path) -> truthy|null` and `extract(path, outDir) -> result`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectBun, extractBun } from '../extractors/bun.js';

const FORMATS = [
  { name: 'bun', detect: detectBun, extract: extractBun },
  // Future:
  // { name: 'sea',   detect: detectSea,   extract: extractSea },
  // { name: 'pkg',   detect: detectPkg,   extract: extractPkg },
  // { name: 'nexe',  detect: detectNexe,  extract: extractNexe },
  // { name: 'tauri', detect: detectTauri, extract: extractTauri },
];

export function doExtractJsFromBinary(args) {
  const binaryPath = args.extract_js_from_binary;
  if (!binaryPath || typeof binaryPath !== 'string') {
    process.stderr.write('Error: --extract-js-from-binary requires a binary file path.\n');
    process.exit(1);
  }
  if (!fs.existsSync(binaryPath)) {
    process.stderr.write(`Error: file not found: ${binaryPath}\n`);
    process.exit(1);
  }

  const outputDir = args.output_dir
    || (path.basename(binaryPath, path.extname(binaryPath)) + '.extracted');

  // Try each known format in registration order.
  for (const format of FORMATS) {
    let detected;
    try {
      detected = format.detect(binaryPath);
    } catch {
      detected = null;
    }
    if (!detected) continue;

    process.stdout.write(`Detected format: ${format.name}\n`);
    process.stdout.write(`Extracting to:   ${outputDir}\n\n`);
    fs.mkdirSync(outputDir, { recursive: true });

    const result = format.extract(binaryPath, outputDir);
    _printResult(result);
    return;
  }

  process.stderr.write(`Error: no known bundler signature found in ${binaryPath}\n`);
  process.stderr.write(`Currently supported: ${FORMATS.map(f => f.name).join(', ')}\n`);
  process.exit(1);
}

function _printResult(result) {
  process.stdout.write(`Extracted ${result.extractedFiles.length} files`);
  if (result.totalBytes) {
    process.stdout.write(` from ${_fmtBytes(result.totalBytes)} of module-graph data`);
  }
  process.stdout.write(`\n`);

  if (result.entryPointId !== undefined) {
    const entry = result.extractedFiles.find(f => f.isEntryPoint);
    if (entry) process.stdout.write(`Entry point:     ${entry.path}\n`);
  }
  if (result.skipped && result.skipped.length > 0) {
    process.stdout.write(`Skipped:         ${result.skipped.length} (${result.skipped.map(s => s.reason).join(', ')})\n`);
  }
  process.stdout.write(`\nFiles:\n`);
  const showLimit = 30;
  for (const f of result.extractedFiles.slice(0, showLimit)) {
    const marker = f.isEntryPoint ? ' [entry]' : '';
    const meta = `${f.loader}/${f.encoding}${f.moduleFormat && f.moduleFormat !== 'none' ? '/' + f.moduleFormat : ''}`;
    process.stdout.write(`  ${f.path}  (${_fmtBytes(f.size)}, ${meta})${marker}\n`);
  }
  if (result.extractedFiles.length > showLimit) {
    process.stdout.write(`  ... and ${result.extractedFiles.length - showLimit} more\n`);
  }
}

function _fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
