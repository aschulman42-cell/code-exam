// inspect_binary.js — terse per-binary report of format, signing, framework, and embedded source hints before deeper extraction
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * `--inspect-binary <path-or-list-or-glob>` — fast "what is this and where
 * might I find related source" report for native binaries (#77, child of
 * the Quasi-Source umbrella #76).
 *
 * Produces a terse, scannable, area-prefixed report per binary:
 *
 *   === foo.exe (28 MB, PE32+ x86-64, code-signed) ===
 *   Format:        PE32+ x86-64, 6 sections
 *   Signing:       <issuer> / <subject>
 *   Framework:     Tauri (Rust + system WebView)
 *   JS bundler:    none detected
 *   Hints:         <git/obj/url snippets>
 *   Imports (top): KERNEL32.dll, USER32.dll, …
 *   PDB:           <basename>.pdb present alongside
 *   Probable origin: <inference>
 *
 * Designed as the cheap first pass before deciding whether to run
 * `--extract-js-from-binary` or other deeper extraction. Honest "no hints
 * found" is a valid output — that itself is information.
 */

import fs from 'node:fs';
import path from 'node:path';
import { detectBun, detectBunInBuffer } from '../extractors/bun.js';
import { _globSync } from '../glob.js';

// Hint patterns. Latin-1 string scan over the whole binary content.
//
// Two source-path regexes:
//   - RE_ABS_PATH: Windows drive-lettered absolute paths (e.g. `C:\a\WebKit\...`).
//     Build-farm artifacts; common in MSVC/clang output.
//   - RE_REL_PATH: Paths with at least two segments and no drive-letter prefix
//     (e.g. `pcshell\shell\explorer\initcab.cpp`, `shell/lib/foo.cpp`).
//     Common in Microsoft's own builds (Windows itself, Office, etc.) where
//     source paths are relative to an SDK root, and in `(file.cpp:LINE)`
//     diagnostic-emission strings. The ≥2-segment gate keeps prose false
//     positives ("see string.h") out of the hint list.
const SUFFIX_GROUP = '(?:obj|cpp|c|h|hpp|cc|cxx|asm|inl|s)';
const RE_ABS_PATH = new RegExp(`[A-Za-z]:[\\\\/](?:[\\w .+-]+[\\\\/]){1,12}[\\w .+-]+\\.${SUFFIX_GROUP}\\b`, 'g');
const RE_REL_PATH = new RegExp(`\\b(?:[\\w. +-]+[\\\\/]){2,12}[\\w. +-]+\\.${SUFFIX_GROUP}\\b`, 'g');
const RE_GITHUB_URL = /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/g;
const RE_GIT_SHA_CONTEXT = /\b(?:git|commit|version|build|revision)\b[^\n]{0,40}\b([0-9a-f]{40})\b/gi;
const RE_RUSTC = /\brustc\s+\d+\.\d+\.\d+/g;
const RE_MSVC = /Microsoft \(R\) C\/C\+\+ Optimizing Compiler Version[^\n]{0,80}/g;

// Framework signature strings. Counts checked against the binary content.
// Some signatures are "required" (must be present to consider the framework),
// not just "any of these contribute to the count" — see _detectFramework.
const FRAMEWORK_SIGNATURES = {
  bun:        ['---- Bun! ----', 'bunfs', 'BUNX', 'Bun.serve', 'Bun.build'],
  tauri:      ['tauri', 'tao::', 'wry::', 'WebView2Loader'],
  electron:   ['electron', '.asar', 'app.asar'],
  pyinstaller:['pyi-', 'PYZ\x00', '_MEIPASS'],
  pkg:        ['PRAYER', 'pkg/prelude'],
  nexe:       ['<nexe~~sentinel>'],
  sea:        ['NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'],
  rust:       ['cargo', 'rustc', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'],
};

// Required signatures must ALL be present for the framework to be considered.
// Without this gate, weak string matches (`electron` in crypto / chemistry /
// physics text) trigger false positives.
const REQUIRED_SIGNATURES = {
  electron: ['.asar'],  // app.asar / .asar archive marker is the decisive Electron signal
};

const FRAMEWORK_THRESHOLDS = {
  bun: 1,         // even one of these is decisive
  tauri: 5,       // need multiple references for confidence
  electron: 3,
  pyinstaller: 1,
  pkg: 1,
  nexe: 1,
  sea: 1,
  rust: 50,       // Rust signatures are common false positives; need strong signal
};

export function doInspectBinary(args) {
  // args.inspect_binary is an array (argparse 'list' type), so shell-
  // expanded globs (`--inspect-binary /usr/bin/*.exe`) capture all
  // values. Each entry independently gets path / glob / @filelist
  // treatment; results are concatenated.
  const inputs = args.inspect_binary;
  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
    process.stderr.write('Error: --inspect-binary requires one or more paths, glob patterns, or @filelist arguments.\n');
    process.exit(1);
  }

  let items = [];
  for (const input of inputs) {
    items = items.concat(_resolveInputPaths(input));
  }

  // Filter out directories. Bash expanding `/usr/bin/*` will catch
  // subdirs alongside files; the user almost certainly meant the files.
  // Skipping is silent per-entry — a single consolidated tip at the
  // end is less noisy than one stderr line per skipped subdirectory.
  const fileItems = [];
  const skippedDirs = [];
  for (const item of items) {
    try {
      if (fs.statSync(item.resolved).isDirectory()) {
        skippedDirs.push(item.original);
        continue;
      }
    } catch { /* let _inspectOne handle non-stat-able paths */ }
    fileItems.push(item);
  }

  if (fileItems.length === 0) {
    if (skippedDirs.length > 0) {
      process.stderr.write(`Error: input matched only directories (${skippedDirs.length}). For recursive walk, use a glob like "<dir>/**/*" (with trailing /* to match files at any depth).\n`);
    } else {
      process.stderr.write(`Error: no inspectable files matched.\n`);
    }
    process.exit(1);
  }

  for (let i = 0; i < fileItems.length; i++) {
    if (i > 0) process.stdout.write('\n');
    _inspectOne(fileItems[i], !!args.verbose);
  }

  // Consolidated tip at the end of the run, only when directories were
  // skipped. One line, total — keeps the per-binary report sections
  // visually clean while still nudging the user toward recursion when
  // it's clearly what they wanted.
  if (skippedDirs.length > 0) {
    process.stdout.write(`\n(${skippedDirs.length} director${skippedDirs.length === 1 ? 'y' : 'ies'} skipped — for recursive walk, use a glob like "<dir>/**/*")\n`);
  }
}

/**
 * Resolve the user's input into a list of `{original, resolved}` objects.
 * `original` is what the user typed (carried through so we can show the
 * symlink chain in the report when it differs from the resolved path).
 * `resolved` is the canonical path that downstream code uses.
 */
function _resolveInputPaths(input) {
  // @filelist: read paths from file, one per line, strip # comments and blanks.
  // Each line gets its own symlink resolution.
  if (input.startsWith('@')) {
    const listPath = input.slice(1);
    if (!fs.existsSync(listPath)) {
      process.stderr.write(`Error: filelist not found: ${listPath}\n`);
      process.exit(1);
    }
    const lines = fs.readFileSync(listPath, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
    return lines.map(p => ({ original: p, resolved: _realpathOrSelf(p) }));
  }

  // Glob (any of *, ?, [, **): expand
  if (/[*?\[]/.test(input)) {
    const matches = _globSync(input) || [];
    return matches
      .filter(p => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
      })
      .map(p => ({ original: p, resolved: _realpathOrSelf(p) }));
  }

  // Single path. realpathSync follows symlinks; on Linux distros that
  // use update-alternatives, /usr/bin/node may chain through several
  // symlinks before landing on the real binary. Showing both the
  // original input and the resolved target in the report makes the chain
  // visible.
  const resolved = _realpathOrSelf(input);
  if (!fs.existsSync(resolved)) {
    process.stderr.write(`Error: file not found: ${input}\n`);
    if (resolved !== input) {
      process.stderr.write(`(resolved to: ${resolved}, but that doesn't exist either)\n`);
    }
    process.exit(1);
  }
  return [{ original: input, resolved }];
}

function _realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * Compare two paths for semantic equality — slash style is normalized,
 * and on Windows case is folded. Used to suppress the "(resolved from:)"
 * line when the difference is only cosmetic (e.g., user typed forward
 * slashes, realpathSync returned backslashes).
 */
function _pathsSemanticallyDiffer(a, b) {
  if (a === b) return false;
  const norm = (p) => p.replace(/\\/g, '/');
  let na = norm(a);
  let nb = norm(b);
  if (process.platform === 'win32') {
    na = na.toLowerCase();
    nb = nb.toLowerCase();
  }
  return na !== nb;
}

function _inspectOne(item, verbose) {
  const binaryPath = item.resolved;
  const originalInput = item.original;
  const stat = fs.statSync(binaryPath);
  const size = stat.size;
  const basename = path.basename(binaryPath);

  // Read first bytes for format detection
  const fd = fs.openSync(binaryPath, 'r');
  let format, formatDetail;
  try {
    const head = Buffer.alloc(64);
    fs.readSync(fd, head, 0, 64, 0);
    ({ format, formatDetail } = _detectFormat(head));
  } catch (e) {
    fs.closeSync(fd);
    process.stdout.write(`=== ${basename} (${_fmtBytes(size)}, error) ===\n`);
    process.stdout.write(`  Could not read header: ${e.message}\n`);
    return;
  }

  // PE-specific header read (for sections, cert, imports). MZ stub is
  // detected in _detectFormat; the optional-header magic (PE32 vs PE32+)
  // is read here, where we also pick up the section table and data
  // directories.
  let pe = null;
  if (format === 'PE-stub') {
    try {
      pe = _readPEHeaders(fd);
      const machineLabel = _peMachineLabel(pe.machine);
      formatDetail = `${pe.isPlus ? 'PE32+' : 'PE32'} ${machineLabel}`;
    } catch (e) {
      pe = { error: e.message };
    }
  }

  fs.closeSync(fd);

  // --- Header lines (always printed) ---
  const hdrParts = [_fmtBytes(size), formatDetail];
  if (pe && pe.cert && pe.cert.size > 0) hdrParts.push('code-signed');
  process.stdout.write(`=== ${basename} (${hdrParts.join(', ')}) ===\n`);
  process.stdout.write(`  Path:          ${binaryPath}\n`);
  if (originalInput && _pathsSemanticallyDiffer(originalInput, binaryPath)) {
    // Symlink / junction / update-alternatives chain — surface the
    // original input so the user sees the redirection.
    process.stdout.write(`  (resolved from: ${originalInput})\n`);
  }
  process.stdout.write(`  Format:        ${formatDetail}\n`);

  // --- PE structural lines (sections, signing) ---
  if (pe && !pe.error) {
    process.stdout.write(`  Sections:      ${pe.sectionCount} (${pe.sectionNames.join(', ')})\n`);
    if (pe.cert && pe.cert.size > 0) {
      process.stdout.write(`  Signing:       Authenticode cert present (${pe.cert.size} bytes at offset ${pe.cert.offset})\n`);
    } else {
      process.stdout.write(`  Signing:       (unsigned)\n`);
    }
  } else if (pe?.error) {
    process.stdout.write(`  (PE parse error: ${pe.error})\n`);
  }

  // Bail out for genuinely-unknown formats — the string-scan layer below
  // is the value-add for ELF / Mach-O, but for files we don't recognize
  // at all (e.g., text files, asset blobs) there's no useful work to do.
  if (format === 'unknown') return;

  // --- Content-scan layer (format-agnostic; works for PE, ELF, Mach-O) ---

  const READ_CAP = 512 * 1024 * 1024;
  if (size > READ_CAP) {
    process.stdout.write(`  (file >${_fmtBytes(READ_CAP)} — skipping content scan; use a deeper tool for very large binaries)\n`);
    return;
  }
  // Robust read against the Windows truncation-on-cold-cache quirk.
  const buf = _readFileRobust(binaryPath, size);
  if (!buf) {
    process.stdout.write(`  (could not read file content for scanning)\n`);
    return;
  }
  const str = buf.toString('latin1');

  // Framework detection (string-based; works for any binary format)
  const framework = _detectFramework(buf, str);
  process.stdout.write(`  Framework:     ${framework.label}\n`);

  // Bun trailer probe — works on any format because the trailer is just
  // a marker string at a known offset. PE binaries get the cert-aware
  // payload-end computation; for other formats the scan runs against
  // the whole file. Either way the result is the same trailer-offset
  // info or null.
  let bunTrailer = null;
  try { bunTrailer = detectBunInBuffer(buf); } catch { /* non-fatal */ }
  if (bunTrailer) {
    process.stdout.write(`  JS bundler:    Bun (trailer at offset ${bunTrailer.trailerOffset}) — recoverable via --extract-js-from-binary\n`);
  } else if (framework.tag === 'bun') {
    process.stdout.write(`  JS bundler:    Bun-like signatures but trailer not located\n`);
  } else if (framework.tag === 'tauri') {
    process.stdout.write(`  JS bundler:    Tauri-embedded HTML/JS in .rdata (Phase 2 of #74)\n`);
  } else if (framework.tag === 'electron') {
    process.stdout.write(`  JS bundler:    Electron / .asar (Phase 2 of #74)\n`);
  } else {
    process.stdout.write(`  JS bundler:    none detected\n`);
  }

  // Source-locating hints (string-based; works for any binary format).
  // Returns a count summary the inference layer reads.
  const hintSummary = _emitHints(str, verbose);

  // --- PE-only structural views (Imports / Exports / PDB) ---
  // ELF and Mach-O equivalents (DT_NEEDED / .dynsym, LC_LOAD_DYLIB)
  // are future work — see Phase 2 of #77 if/when filed.
  if (pe && !pe.error) {
    try {
      const imports = _readPEImportsFromBuf(buf, pe);
      if (imports.length > 0) {
        const topN = verbose ? imports : imports.filter(d => !_isStandardWinDLL(d)).slice(0, 8);
        const more = imports.length - topN.length;
        let line;
        if (topN.length === 0) {
          line = `(${imports.length} entries, all standard Windows DLLs — use -v to see)`;
        } else {
          line = topN.join(', ') + (more > 0 ? `, … +${more} more` : '');
        }
        process.stdout.write(`  Imports:       ${line}\n`);
      }
    } catch { /* ignore */ }

    try {
      const exp = _readPEExportsFromBuf(buf, pe);
      if (exp && (exp.numberOfFunctions > 0 || exp.numberOfNames > 0)) {
        const detail = exp.numberOfNames === exp.numberOfFunctions
          ? `${exp.numberOfNames} named`
          : `${exp.numberOfNames} named, ${exp.numberOfFunctions - exp.numberOfNames} ordinal-only`;
        process.stdout.write(`  Exports:       ${exp.numberOfFunctions} (${detail})\n`);
      }
    } catch { /* ignore */ }

    const pdbPath = binaryPath.replace(/\.(exe|dll)$/i, '.pdb');
    const hasSiblingPdb = pdbPath !== binaryPath && fs.existsSync(pdbPath);
    const hasRSDS = buf.includes(Buffer.from('RSDS'));
    if (hasSiblingPdb || hasRSDS) {
      const bits = [];
      if (hasSiblingPdb) bits.push(`${path.basename(pdbPath)} alongside`);
      if (hasRSDS) bits.push(`RSDS debug record inside binary`);
      process.stdout.write(`  PDB:           ${bits.join('; ')}\n`);
    }
  }

  // --- Inference layer (format-agnostic) ---
  const cert = (pe && !pe.error) ? pe.cert : null;
  const origin = _inferOrigin(framework, bunTrailer, cert, hintSummary);
  if (origin) {
    process.stdout.write(`  Probable origin: ${origin}\n`);
  } else {
    process.stdout.write(`  Probable origin: (no source-locating hints found in binary)\n`);
  }
}

// --- Format detection ---

function _detectFormat(head) {
  // MZ + PE
  if (head[0] === 0x4d && head[1] === 0x5a) {
    return { format: 'PE-stub', formatDetail: 'PE (need optional-header read for 32 vs 32+)' };
  }
  // ELF
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) {
    const bits = head[4] === 2 ? '64' : '32';
    return { format: 'ELF', formatDetail: `ELF${bits}` };
  }
  // Mach-O (32-bit)
  if (head.readUInt32LE(0) === 0xfeedface) return { format: 'Mach-O', formatDetail: 'Mach-O 32-bit' };
  // Mach-O (64-bit)
  if (head.readUInt32LE(0) === 0xfeedfacf) return { format: 'Mach-O', formatDetail: 'Mach-O 64-bit' };
  // 0xcafebabe is shared by Mach-O fat AND Java .class (#252: the second
  // check below was identical, so the Java branch was dead code). Disambiguate
  // the way file(1) does: bytes 4-7 big-endian are nfat_arch for a fat binary
  // (a handful at most) but minor<<16|major version for .class (major >= 45,
  // i.e. > 30, for every real JDK).
  if (head.readUInt32BE(0) === 0xcafebabe) {
    return head.readUInt32BE(4) > 30
      ? { format: 'class', formatDetail: 'Java .class' }
      : { format: 'Mach-O', formatDetail: 'Mach-O fat / universal' };
  }
  // WASM
  if (head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d) {
    return { format: 'WASM', formatDetail: 'WebAssembly module' };
  }
  // DEX
  if (head.toString('ascii', 0, 4) === 'dex\n') return { format: 'DEX', formatDetail: 'Android DEX' };
  return { format: 'unknown', formatDetail: '(unrecognized format)' };
}

// --- PE header parsing ---

function _peMachineLabel(machine) {
  switch (machine) {
    case 0x8664: return 'x86-64';
    case 0x014c: return 'x86';
    case 0xaa64: return 'ARM64';
    case 0x01c0: return 'ARM';
    case 0x01c4: return 'ARMv7';
    default: return `machine 0x${machine.toString(16)}`;
  }
}

function _readPEHeaders(fd) {
  const buf = Buffer.alloc(8);
  fs.readSync(fd, buf, 0, 4, 0x3C);
  const peOffset = buf.readUInt32LE(0);
  fs.readSync(fd, buf, 0, 4, peOffset);
  if (buf.toString('ascii', 0, 4) !== 'PE\0\0') throw new Error('PE signature not found');
  // COFF header
  fs.readSync(fd, buf, 0, 6, peOffset + 4);
  const machine = buf.readUInt16LE(0);
  const nSections = buf.readUInt16LE(2);
  fs.readSync(fd, buf, 0, 2, peOffset + 20);
  const optHdrSize = buf.readUInt16LE(0);
  // Optional header magic
  fs.readSync(fd, buf, 0, 2, peOffset + 24);
  const magic = buf.readUInt16LE(0);
  const isPlus = magic === 0x20b;
  // Data directory base offset within OptHdr
  const dataDirBase = isPlus ? 112 : 96;
  const certDirOff = peOffset + 24 + dataDirBase + 4 * 8;
  fs.readSync(fd, buf, 0, 8, certDirOff);
  const certOffset = buf.readUInt32LE(0);
  const certSize = buf.readUInt32LE(4);
  // Export Directory is index 0
  const exportDirOff = peOffset + 24 + dataDirBase + 0 * 8;
  fs.readSync(fd, buf, 0, 8, exportDirOff);
  const exportRVA = buf.readUInt32LE(0);
  const exportSize = buf.readUInt32LE(4);
  // Import Directory is index 1
  const importDirOff = peOffset + 24 + dataDirBase + 1 * 8;
  fs.readSync(fd, buf, 0, 8, importDirOff);
  const importRVA = buf.readUInt32LE(0);
  // Section headers — for RVA → file-offset translation
  const sectStart = peOffset + 24 + optHdrSize;
  const sectBuf = Buffer.alloc(40 * nSections);
  fs.readSync(fd, sectBuf, 0, sectBuf.length, sectStart);
  const sections = [];
  for (let i = 0; i < nSections; i++) {
    const off = i * 40;
    const name = sectBuf.toString('ascii', off, off + 8).replace(/\0+$/, '');
    sections.push({
      name,
      virtualSize: sectBuf.readUInt32LE(off + 8),
      virtualAddress: sectBuf.readUInt32LE(off + 12),
      rawSize: sectBuf.readUInt32LE(off + 16),
      rawPtr: sectBuf.readUInt32LE(off + 20),
    });
  }
  return {
    machine,
    isPlus,
    sectionCount: nSections,
    sectionNames: sections.map(s => s.name),
    sections,
    cert: { offset: certOffset, size: certSize },
    importRVA,
    exportRVA,
    exportSize,
    peOffset,
  };
}

/**
 * Read the PE Export Directory from the in-memory file buffer.
 * Returns `{ numberOfFunctions, numberOfNames }` or null if no exports.
 *
 * The export count is a preview signal for future per-export pseudo-function
 * work (Quasi-Source #76 point 8): each named export will become a pseudo-
 * function boundary in the binary's quasi-source view, and strings/calls
 * within that address range will be grouped under it.
 */
function _readPEExportsFromBuf(fileBuf, pe) {
  if (!pe.exportRVA || pe.exportRVA === 0) return null;
  const exportOffset = _rvaToFileOffset(pe.exportRVA, pe.sections);
  if (exportOffset == null || exportOffset + 40 > fileBuf.length) return null;
  // IMAGE_EXPORT_DIRECTORY layout:
  //   +0  Characteristics (u32)
  //   +4  TimeDateStamp   (u32)
  //   +8  MajorVersion    (u16)
  //   +10 MinorVersion    (u16)
  //   +12 Name RVA        (u32)
  //   +16 Base            (u32)
  //   +20 NumberOfFunctions (u32) — total exported ordinals (named + unnamed)
  //   +24 NumberOfNames     (u32) — number of named exports
  const numberOfFunctions = fileBuf.readUInt32LE(exportOffset + 20);
  const numberOfNames = fileBuf.readUInt32LE(exportOffset + 24);
  return { numberOfFunctions, numberOfNames };
}

function _rvaToFileOffset(rva, sections) {
  for (const s of sections) {
    if (rva >= s.virtualAddress && rva < s.virtualAddress + Math.max(s.rawSize, s.virtualSize)) {
      return s.rawPtr + (rva - s.virtualAddress);
    }
  }
  return null;
}

/**
 * Walk the PE Import Directory using the already-loaded file buffer.
 * Each IMAGE_IMPORT_DESCRIPTOR is 20 bytes; the `Name` field at offset 12
 * is an RVA to a NUL-terminated DLL name. Stops at the zero-filled
 * terminator entry. Previous implementation opened the file again and
 * read just the first 1 MB of the import directory's section — which
 * misses imports for binaries whose import table sits past the 1 MB
 * mark (mshtml.dll's import dir is at file offset ~22 MB).
 */
function _readPEImportsFromBuf(fileBuf, pe) {
  if (!pe.importRVA || pe.importRVA === 0) return [];
  const importOffset = _rvaToFileOffset(pe.importRVA, pe.sections);
  if (importOffset == null || importOffset >= fileBuf.length) return [];

  const names = [];
  for (let i = 0; i < 500; i++) {
    const descOff = importOffset + i * 20;
    if (descOff + 20 > fileBuf.length) break;
    const nameRVA = fileBuf.readUInt32LE(descOff + 12);
    if (nameRVA === 0) break;  // terminator
    const nameFileOff = _rvaToFileOffset(nameRVA, pe.sections);
    if (nameFileOff == null || nameFileOff >= fileBuf.length) continue;
    // Read NUL-terminated ASCII DLL name (capped at 256 chars)
    const maxEnd = Math.min(nameFileOff + 256, fileBuf.length);
    let end = nameFileOff;
    while (end < maxEnd && fileBuf[end] !== 0) end++;
    if (end > nameFileOff) {
      names.push(fileBuf.toString('ascii', nameFileOff, end));
    }
    if (names.length > 200) break;
  }
  return names;
}

function _isStandardWinDLL(name) {
  const STD = /^(KERNEL32|USER32|GDI32|ADVAPI32|MSVCRT|VCRUNTIME\d*|api-ms-win-.*|ntdll|ole32|oleaut32|SHELL32|SHLWAPI|COMCTL32|RPCRT4|WS2_32|CRYPT32|bcrypt|kernelbase|ucrtbase|combase)\.dll$/i;
  return STD.test(name);
}

// --- Framework detection ---

function _detectFramework(buf, str) {
  const counts = {};
  for (const [tag, sigs] of Object.entries(FRAMEWORK_SIGNATURES)) {
    let total = 0;
    for (const s of sigs) {
      // For very short patterns, use Buffer.includes for binary-safe match
      let n = 0;
      const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const matches = str.match(re);
      n = matches ? matches.length : 0;
      total += n;
    }
    counts[tag] = total;
  }
  // Pick the framework above its threshold, in priority order. Specific
  // bundler/framework signatures always beat the generic-language Rust
  // signal — a Bun binary will trip the Rust threshold too (Bun's runtime
  // contains Rust-derived artifacts), but the Bun trailer / strings are
  // the decisive signal. Same for Tauri (a Rust binary by definition).
  const PRIORITY = ['bun', 'pkg', 'nexe', 'sea', 'pyinstaller', 'tauri', 'electron', 'rust'];
  let best = { tag: null, count: 0 };
  for (const tag of PRIORITY) {
    const count = counts[tag] || 0;
    if (count < FRAMEWORK_THRESHOLDS[tag]) continue;
    // If this framework has required signatures, all must be present.
    const reqs = REQUIRED_SIGNATURES[tag];
    if (reqs && !reqs.every(r => str.includes(r))) continue;
    best = { tag, count };
    break;
  }
  if (best.tag === 'bun') return { tag: 'bun', label: 'Bun standalone executable (bun build --compile)' };
  if (best.tag === 'tauri') return { tag: 'tauri', label: `Tauri (Rust + system WebView; ${counts.tauri} marker references)` };
  if (best.tag === 'electron') return { tag: 'electron', label: `Electron (${counts.electron} markers)` };
  if (best.tag === 'pyinstaller') return { tag: 'pyinstaller', label: 'PyInstaller-bundled Python' };
  if (best.tag === 'pkg') return { tag: 'pkg', label: 'Vercel pkg (V8 snapshot)' };
  if (best.tag === 'nexe') return { tag: 'nexe', label: 'nexe-bundled JS' };
  if (best.tag === 'sea') return { tag: 'sea', label: 'Node.js Single Executable Application' };
  if (best.tag === 'rust') return { tag: 'rust', label: `Pure Rust binary (${counts.rust} Rust-build markers; no JS bundler detected)` };
  return { tag: null, label: '(no known framework signature)' };
}

// --- Source-locating hints ---

function _emitHints(str, verbose) {
  const hints = [];
  const summary = { objPaths: 0, githubUrls: 0, gitShas: 0 };

  // #251: RE_ABS_PATH / RE_REL_PATH / RE_GITHUB_URL / RE_GIT_SHA_CONTEXT are
  // MODULE-LEVEL global (`/g`) regexes reused across binaries. A loop that breaks
  // early on the size caps below leaves lastIndex non-zero, so the NEXT binary's
  // scan would start mid-string and miss matches. Reset them all up front.
  for (const re of [RE_ABS_PATH, RE_REL_PATH, RE_GITHUB_URL, RE_GIT_SHA_CONTEXT]) re.lastIndex = 0;

  // Source-path hints: absolute (drive-lettered) + relative (≥2 segments)
  const objSet = new Set();
  let m;
  while ((m = RE_ABS_PATH.exec(str)) !== null) {
    objSet.add(m[0]);
    if (objSet.size > 400) break;
  }
  RE_REL_PATH.lastIndex = 0;  // belt-and-suspenders after the RE_ABS_PATH scan above
  while ((m = RE_REL_PATH.exec(str)) !== null) {
    // Avoid double-counting matches the absolute regex already caught
    // (RE_REL_PATH can match the relative tail of an absolute path).
    if (objSet.has(m[0])) continue;
    objSet.add(m[0]);
    if (objSet.size > 400) break;
  }
  summary.objPaths = objSet.size;
  if (objSet.size > 0) {
    const arr = [...objSet];
    const sample = verbose ? arr : arr.slice(0, 6);
    hints.push({ label: 'obj/src path', values: sample, total: arr.length });
  }

  // GitHub URLs
  const ghSet = new Set();
  while ((m = RE_GITHUB_URL.exec(str)) !== null) {
    ghSet.add(m[0]);
    if (ghSet.size > 50) break;
  }
  summary.githubUrls = ghSet.size;
  if (ghSet.size > 0) {
    const arr = [...ghSet];
    hints.push({ label: 'GitHub URL', values: verbose ? arr : arr.slice(0, 4), total: arr.length });
  }

  // Git SHA with context
  const shaSet = new Set();
  while ((m = RE_GIT_SHA_CONTEXT.exec(str)) !== null) {
    shaSet.add(m[1]);
    if (shaSet.size > 20) break;
  }
  summary.gitShas = shaSet.size;
  if (shaSet.size > 0) {
    hints.push({ label: 'git SHA', values: [...shaSet].slice(0, 4), total: shaSet.size });
  }

  // Rustc / MSVC version markers
  const rustcMatches = str.match(RE_RUSTC);
  if (rustcMatches) {
    const uniq = [...new Set(rustcMatches)];
    hints.push({ label: 'rustc version', values: uniq.slice(0, 2), total: uniq.length });
  }
  const msvcMatches = str.match(RE_MSVC);
  if (msvcMatches) {
    const uniq = [...new Set(msvcMatches.map(s => s.slice(0, 80)))];
    hints.push({ label: 'MSVC version', values: uniq.slice(0, 2), total: uniq.length });
  }

  if (hints.length === 0) {
    process.stdout.write(`  Hints:         (no source-locating hints found)\n`);
    return summary;
  }

  let first = true;
  for (const h of hints) {
    const tag = first ? 'Hints:' : '               ';
    first = false;
    process.stdout.write(`  ${tag.padEnd(13)} ${h.label}:\n`);
    for (const v of h.values) {
      process.stdout.write(`                   ${v}\n`);
    }
    if (h.total > h.values.length) {
      process.stdout.write(`                   … +${h.total - h.values.length} more (use -v to see all)\n`);
    }
  }
  return summary;
}

// --- Inference ---

function _inferOrigin(framework, bunTrailer, cert, hintSummary) {
  // Framework-driven inferences (most specific)
  if (bunTrailer && framework.tag === 'bun') {
    return 'Bun-compiled JS app — extract via `--extract-js-from-binary` to recover source';
  }
  if (framework.tag === 'tauri') {
    return 'Tauri app — embedded HTML/JS in .rdata; Phase 2 of #74 will extract';
  }
  if (framework.tag === 'electron') {
    return 'Electron app — look for .asar archive (sibling file or embedded); Phase 2 of #74';
  }
  if (framework.tag === 'pyinstaller') {
    return 'PyInstaller-bundled Python — extract via pyinstxtractor or similar';
  }
  if (framework.tag === 'rust') {
    return 'Pure Rust binary — search for the project name externally (GitHub, crates.io)';
  }
  if (framework.tag === 'pkg' || framework.tag === 'nexe' || framework.tag === 'sea') {
    return `${framework.tag}-bundled JS — Phase 2 of #74 will extract`;
  }
  // No framework but source-path hints present — common for Microsoft's own
  // Windows / Office binaries (SDK-relative .cpp paths embedded in debug info).
  if (hintSummary && hintSummary.objPaths > 0) {
    return `Native binary with ${hintSummary.objPaths} embedded source path${hintSummary.objPaths === 1 ? '' : 's'}` +
           (cert && cert.size > 0 ? ' — check signing-org repos' : ' — check obj-path roots for SDK lineage');
  }
  return null;
}

// --- Utilities ---

/**
 * Read a file in full via open + fstat + read-in-loop. Robust against the
 * Windows quirk where `fs.readFileSync` or `fs.fstatSync` can return a
 * tiny/truncated view on first cold-cache access to a recently-installed
 * signed binary (likely Defender/AV scan interaction). The trick: verify
 * the fstat size against the path-based statSync size and use the larger
 * one — fstat on a freshly-opened fd can underreport.
 */
function _readFileRobust(binaryPath, knownSize) {
  try {
    const pathStat = fs.statSync(binaryPath);
    const targetSize = Math.max(pathStat.size, knownSize || 0);
    if (targetSize === 0) return null;
    const fd = fs.openSync(binaryPath, 'r');
    try {
      const buf = Buffer.alloc(targetSize);
      let total = 0;
      while (total < targetSize) {
        const n = fs.readSync(fd, buf, total, targetSize - total, total);
        if (n === 0) break;
        total += n;
      }
      if (total < targetSize) return buf.subarray(0, total);
      return buf;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function _fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
