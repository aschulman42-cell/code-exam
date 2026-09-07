// archive.js — expands ZIP/TAR/GZIP/HAR archives in memory (nested, depth-capped) for --build-index; zip-bomb guards
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * archive.js - In-memory archive expansion for --build-index.
 *
 * Supports ZIP (including .jar, .war, .ear, .apk), TAR, GZIP (.gz, .tgz),
 * and nested archives (zip-in-zip) with configurable recursion depth.
 *
 * All extraction is in-memory — no temporary files are created.
 * Password-protected ZIP entries are detected and warned about.
 *
 * Path convention: archive paths use '!' as delimiter between the archive
 * file path and the entry path within it. Nested archives chain:
 *   outer.zip!libs/inner.jar!com/example/Foo.java
 *
 * Zero external dependencies — uses Node.js built-in zlib only.
 */

import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { processBinary } from './binstrings.js';
import { DEFAULT_EXTENSIONS } from './utils.js';

// ========================================================================
// Constants
// ========================================================================

/** Maximum recursion depth for nested archives (zip-in-zip) */
const MAX_ARCHIVE_DEPTH = 5;

/** Maximum decompressed size per entry (256 MB) — zip bomb protection */
const MAX_ENTRY_SIZE = 256 * 1024 * 1024;

/** Archive extensions we can handle natively */
export const SUPPORTED_ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.jar', '.war', '.ear', '.apk',  // ZIP format
  '.tar',                                    // TAR format
  '.gz', '.tgz',                            // GZIP (may wrap tar or single file)
  '.tar.gz',                                // explicit compound ext
  '.har',                                    // DevTools network capture (#161)
]);

/** Extensions that are ZIP format internally */
const ZIP_EXTENSIONS = new Set([
  '.zip', '.jar', '.war', '.ear', '.apk',
]);

/**
 * Executable/binary extensions that Task 2 (binstrings) will process.
 * For now, these are still skipped but tracked separately from media files.
 */
export const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.sys', '.pyd',
  '.o', '.obj', '.a', '.lib',
  '.class', '.pyc', '.pyo', '.wasm',
]);

/**
 * Directories never indexed, wherever a file arrives from: third-party,
 * build, cache, and infrastructure trees that are not project source.
 * `_walkDir` (CodeSearchIndex) never descends into them; archive members and
 * `@list` / glob inputs used to bypass that rule. Measured 2026-08-27: an
 * archive-built index carried 1,416 `__pycache__/*.pyc.op` bytecode dumps
 * beside 1,394 `.py` sources, and per-element retrieval and the ballpark
 * scored the dumps as functions (30 of 39 "strong" claims had a
 * `bin_pycache_*` bag as their best function). One Set, one predicate, on
 * every input path. A `.pyc` OUTSIDE `__pycache__` (a compiled-only
 * distribution) is still indexed -- that is what binstrings is for.
 */
export const SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.svn', '.hg',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'dist', 'build', '.next', '.nuxt',
  'vendor', 'venv', '.venv', 'env',
  'coverage', '.nyc_output',
  '.idea', '.vscode',
]);

/**
 * True when a DIRECTORY segment of `relPath` (never the final name) is in
 * SKIP_DIRS. Callers pass a path relative to the tree being indexed -- an
 * archive member's name, or `path.relative(basePath, file)` -- so a project
 * that itself lives under a directory called `build` or `env` is unaffected.
 */
export function hasSkippedDirSegment(relPath) {
  const segs = String(relPath).split(/[\\/]/);
  for (let i = 0; i < segs.length - 1; i++) {
    if (SKIP_DIRS.has(segs[i].toLowerCase())) return true;
  }
  return false;
}


// ========================================================================
// ZIP Reader (zero-dep, in-memory)
// ========================================================================

/**
 * Read a ZIP archive from a Buffer and yield entries.
 *
 * ZIP format summary:
 *   [local file header + data] ... [central directory] [EOCD]
 * We read the End of Central Directory (EOCD) to find the central directory,
 * then iterate entries from there (more reliable than scanning local headers).
 *
 * @param {Buffer} buf - ZIP file contents
 * @param {object} [opts]
 * @param {boolean} [opts.warnEncrypted=true] - Print warning for encrypted entries
 * @param {string} [opts.archiveName=''] - For diagnostic messages
 * @returns {Array<{name: string, content: Buffer|null, isDirectory: boolean, encrypted: boolean, compressedSize: number, uncompressedSize: number}>}
 */
function readZip(buf, { warnEncrypted = true, archiveName = '' } = {}) {
  const entries = [];

  // Find End of Central Directory record (search backwards from end)
  // EOCD signature: 0x06054b50
  let eocdOffset = -1;
  // EOCD is at least 22 bytes; search from end - 22 backwards
  // (EOCD can have a variable-length comment, max 65535 bytes)
  const searchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b &&
        buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset < 0) {
    // Not a valid ZIP file
    return entries;
  }

  // Parse EOCD
  const cdEntries = buf.readUInt16LE(eocdOffset + 10);  // total entries in central directory
  const cdSize = buf.readUInt32LE(eocdOffset + 12);      // size of central directory
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);    // offset of central directory

  // Handle ZIP64 (cdOffset == 0xFFFFFFFF means ZIP64)
  if (cdOffset === 0xFFFFFFFF || cdEntries === 0xFFFF) {
    // ZIP64 support would require reading the ZIP64 EOCD locator
    // For now, warn and return empty
    if (warnEncrypted) {
      const label = archiveName || 'archive';
      process.stderr.write(`  WARNING: ${label} appears to be ZIP64 format (>4GB) — not yet supported\n`);
    }
    return entries;
  }

  if (cdOffset + cdSize > buf.length) {
    // Corrupt or truncated ZIP
    return entries;
  }

  // Parse central directory entries
  let pos = cdOffset;
  let encryptedCount = 0;

  for (let i = 0; i < cdEntries && pos < cdOffset + cdSize; i++) {
    // Central directory file header signature: 0x02014b50
    if (pos + 46 > buf.length) break;
    const sig = buf.readUInt32LE(pos);
    if (sig !== 0x02014b50) break;

    const gpFlag = buf.readUInt16LE(pos + 8);       // general purpose bit flag
    const method = buf.readUInt16LE(pos + 10);       // compression method
    const compSize = buf.readUInt32LE(pos + 20);     // compressed size
    const uncompSize = buf.readUInt32LE(pos + 24);   // uncompressed size
    const nameLen = buf.readUInt16LE(pos + 28);      // file name length
    const extraLen = buf.readUInt16LE(pos + 30);     // extra field length
    const commentLen = buf.readUInt16LE(pos + 32);   // file comment length
    const localHeaderOffset = buf.readUInt32LE(pos + 42);  // relative offset of local file header

    // Read filename
    const nameBytes = buf.slice(pos + 46, pos + 46 + nameLen);
    const name = nameBytes.toString('utf-8');

    const isDirectory = name.endsWith('/') || name.endsWith('\\');
    const encrypted = (gpFlag & 0x01) !== 0;

    let content = null;

    if (encrypted) {
      encryptedCount++;
    } else if (!isDirectory && uncompSize > 0) {
      // Read the actual data from the local file header
      try {
        content = _readLocalEntry(buf, localHeaderOffset, method, compSize, uncompSize);
      } catch (e) {
        // Silently skip unreadable entries
        content = null;
      }
    } else if (!isDirectory && uncompSize === 0 && compSize === 0) {
      // Empty file
      content = Buffer.alloc(0);
    }

    entries.push({
      name,
      content,
      isDirectory,
      encrypted,
      compressedSize: compSize,
      uncompressedSize: uncompSize,
    });

    pos += 46 + nameLen + extraLen + commentLen;
  }

  if (encryptedCount > 0 && warnEncrypted) {
    const label = archiveName || 'archive';
    process.stderr.write(
      `\n  *** WARNING: ${label} contains ${encryptedCount} password-encrypted ` +
      `entr${encryptedCount === 1 ? 'y' : 'ies'} — these WILL BE MISSING from the index ***\n\n`
    );
  }

  return entries;
}


/**
 * Read and decompress data from a local file header.
 * @param {Buffer} buf
 * @param {number} offset - Offset to local file header
 * @param {number} method - Compression method (0=stored, 8=deflate)
 * @param {number} compSize - Compressed size from central directory
 * @param {number} uncompSize - Uncompressed size from central directory
 * @returns {Buffer|null}
 */
function _readLocalEntry(buf, offset, method, compSize, uncompSize) {
  if (offset + 30 > buf.length) return null;

  // Local file header signature: 0x04034b50
  const sig = buf.readUInt32LE(offset);
  if (sig !== 0x04034b50) return null;

  const localNameLen = buf.readUInt16LE(offset + 26);
  const localExtraLen = buf.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + localNameLen + localExtraLen;

  // Use the general purpose bit flag to check for data descriptor
  const gpFlag = buf.readUInt16LE(offset + 6);
  let actualCompSize = compSize;
  let actualUncompSize = uncompSize;

  // If bit 3 is set, sizes are in a data descriptor after the data,
  // but we already have sizes from the central directory, which is authoritative
  if (actualCompSize === 0 && actualUncompSize === 0 && (gpFlag & 0x08)) {
    // Sizes unknown — skip this entry
    return null;
  }

  if (dataOffset + actualCompSize > buf.length) return null;

  // Zip bomb check
  if (actualUncompSize > MAX_ENTRY_SIZE) return null;

  const compData = buf.slice(dataOffset, dataOffset + actualCompSize);

  if (method === 0) {
    // Stored (no compression)
    return compData;
  } else if (method === 8) {
    // Deflate
    try {
      return zlib.inflateRawSync(compData, { maxOutputLength: MAX_ENTRY_SIZE });
    } catch {
      return null;
    }
  } else {
    // Unsupported compression method (e.g., bzip2, lzma, zstd)
    return null;
  }
}


// ========================================================================
// TAR Reader (zero-dep, in-memory)
// ========================================================================

/**
 * Read a TAR archive from a Buffer and yield entries.
 * Supports POSIX (ustar) and GNU tar formats.
 *
 * TAR format: sequential 512-byte headers followed by file data
 * padded to 512-byte boundaries.
 *
 * @param {Buffer} buf - TAR file contents
 * @returns {Array<{name: string, content: Buffer|null, isDirectory: boolean, size: number}>}
 */
function readTar(buf) {
  const entries = [];
  let pos = 0;

  while (pos + 512 <= buf.length) {
    const header = buf.slice(pos, pos + 512);

    // Check for end-of-archive (two consecutive zero blocks)
    if (_isZeroBlock(header)) break;

    // Parse header
    const name = _tarString(header, 0, 100);
    const sizeStr = _tarString(header, 124, 12);
    const typeFlag = header[156];  // ASCII byte
    const prefix = _tarString(header, 345, 155);  // ustar prefix

    // Full path
    let fullName = prefix ? prefix + '/' + name : name;
    // Normalize
    fullName = fullName.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (fullName.startsWith('./')) fullName = fullName.slice(2);

    // Parse size (octal, or GNU base-256 for large files)
    let size = 0;
    if (header[124] & 0x80) {
      // GNU base-256 encoding
      size = 0;
      for (let i = 125; i < 136; i++) {
        size = size * 256 + header[i];
      }
    } else {
      size = parseInt(sizeStr, 8) || 0;
    }

    const isDirectory = typeFlag === 53 /* '5' */ || fullName.endsWith('/');

    pos += 512;  // Move past header

    let content = null;
    if (!isDirectory && size > 0 && size <= MAX_ENTRY_SIZE) {
      if (pos + size <= buf.length) {
        content = buf.slice(pos, pos + size);
      }
    }

    // Skip past data blocks (padded to 512 bytes)
    const dataBlocks = Math.ceil(size / 512);
    pos += dataBlocks * 512;

    if (fullName && !fullName.startsWith('PaxHeader/') &&
        typeFlag !== 120 /* 'x' pax header */ &&
        typeFlag !== 103 /* 'g' global pax header */) {
      entries.push({ name: fullName, content, isDirectory, size });
    }
  }

  return entries;
}

function _tarString(buf, offset, length) {
  let end = offset;
  while (end < offset + length && buf[end] !== 0) end++;
  return buf.slice(offset, end).toString('utf-8');
}

function _isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}


// ========================================================================
// GZIP handler
// ========================================================================

/**
 * Decompress a gzip buffer. If the result looks like a TAR, parse it.
 * Otherwise return the decompressed data as a single file.
 *
 * @param {Buffer} buf - GZIP file contents
 * @param {string} originalName - Original filename (e.g., 'data.tar.gz')
 * @returns {{isTar: boolean, tarEntries: Array|null, content: Buffer|null, innerName: string}}
 */
function decompressGzip(buf, originalName = '') {
  let decompressed;
  try {
    decompressed = zlib.gunzipSync(buf, { maxOutputLength: MAX_ENTRY_SIZE * 4 });
  } catch {
    return { isTar: false, tarEntries: null, content: null, innerName: '' };
  }

  // Determine inner name by stripping .gz / .tgz
  let innerName = '';
  const baseName = path.basename(originalName).toLowerCase();
  if (baseName.endsWith('.tar.gz') || baseName.endsWith('.tgz')) {
    // It's a tar inside
    const tarEntries = readTar(decompressed);
    return { isTar: true, tarEntries, content: null, innerName: '' };
  } else if (baseName.endsWith('.gz')) {
    innerName = path.basename(originalName).slice(0, -3);  // strip .gz preserving case
  } else {
    innerName = path.basename(originalName) + '.decompressed';
  }

  // Check if the decompressed content starts with a TAR header (magic "ustar")
  if (decompressed.length >= 263 &&
      decompressed.slice(257, 263).toString('ascii') === 'ustar') {
    const tarEntries = readTar(decompressed);
    return { isTar: true, tarEntries, content: null, innerName: '' };
  }

  return { isTar: false, tarEntries: null, content: decompressed, innerName };
}


// ========================================================================
// Main expansion API
// ========================================================================

/**
 * Expand an archive file (or Buffer) into a list of virtual file entries.
 * Handles nested archives recursively up to MAX_ARCHIVE_DEPTH.
 *
 * @param {string|Buffer} source - File path (string) or Buffer
 * @param {object} [opts]
 * @param {string} [opts.archiveName] - Display name for the archive (used in paths)
 * @param {number} [opts.depth=0] - Current recursion depth
 * @param {Set<string>} [opts.extensions] - Source file extensions to include (null = all)
 * @param {boolean} [opts.showProgress=true] - Print progress info
 * @param {object} [opts.stats] - Accumulator for statistics
 * @returns {Array<{virtualPath: string, content: string}>}
 *   virtualPath: e.g. "archive.zip!src/main/App.java"
 *   content: UTF-8 string of the file contents
 */
export function expandArchive(source, opts = {}) {
  const {
    archiveName = '',
    depth = 0,
    extensions = null,
    showProgress = true,
    demanglerPath = null,
    stats = { archives: 0, files: 0, encrypted: 0, errors: 0, skippedBinary: 0, binstringsProcessed: 0, depthWarnings: 0, skippedExtensions: {}, skippedDirs: 0 },
  } = opts;

  if (depth > MAX_ARCHIVE_DEPTH) {
    if (stats.depthWarnings === 0) {
      process.stderr.write(
        `  WARNING: Archive nesting depth exceeds ${MAX_ARCHIVE_DEPTH} — ` +
        `skipping deeper levels (${archiveName})\n`
      );
    }
    stats.depthWarnings++;
    return [];
  }

  // Read file if path is given
  let buf;
  if (typeof source === 'string') {
    try {
      buf = fs.readFileSync(source);
    } catch (e) {
      process.stderr.write(`  WARNING: Cannot read archive ${source}: ${e.message}\n`);
      stats.errors++;
      return [];
    }
  } else {
    buf = source;
  }

  // Determine archive type from name
  const nameForType = (archiveName || (typeof source === 'string' ? source : '')).toLowerCase();
  const results = [];

  if (_isZipByName(nameForType) || _isZipBySignature(buf)) {
    _expandZip(buf, archiveName, depth, extensions, showProgress, demanglerPath, stats, results);
  } else if (nameForType.endsWith('.tar.gz') || nameForType.endsWith('.tgz')) {
    _expandGzip(buf, archiveName, depth, extensions, showProgress, demanglerPath, stats, results);
  } else if (nameForType.endsWith('.gz')) {
    _expandGzip(buf, archiveName, depth, extensions, showProgress, demanglerPath, stats, results);
  } else if (nameForType.endsWith('.tar')) {
    _expandTar(buf, archiveName, depth, extensions, showProgress, demanglerPath, stats, results);
  } else if (nameForType.endsWith('.har')) {
    _expandHar(buf, archiveName, depth, extensions, showProgress, stats, results);
  } else if (_isZipBySignature(buf)) {
    // Fallback: check magic bytes even if name doesn't match
    _expandZip(buf, archiveName, depth, extensions, showProgress, demanglerPath, stats, results);
  } else {
    // Unknown archive type
    stats.errors++;
  }

  // Only report at depth 0
  if (depth === 0 && showProgress) {
    let parts = [`${stats.files} source files from ${stats.archives} archive(s)`];
    if (stats.binstringsProcessed > 0) parts.push(`${stats.binstringsProcessed} binaries processed (binstrings)`);
    if (stats.encrypted > 0) parts.push(`${stats.encrypted} encrypted entries skipped`);
    if (stats.skippedBinary > 0) parts.push(`${stats.skippedBinary} binary files skipped`);
    if (stats.skippedDirs > 0) parts.push(`${stats.skippedDirs} entries under skipped directories (__pycache__, node_modules, ...)`);
    if (stats.errors > 0) parts.push(`${stats.errors} errors`);
    process.stderr.write(`  Archive expansion: ${parts.join(', ')}\n`);
  }

  return results;
}

/**
 * Return the stats object for external use (e.g., build summary).
 */
export function createArchiveStats() {
  return { archives: 0, files: 0, encrypted: 0, errors: 0, skippedBinary: 0, binstringsProcessed: 0, depthWarnings: 0, skippedExtensions: {}, skippedDirs: 0 };
}


// ========================================================================
// Internal expansion helpers
// ========================================================================

function _expandZip(buf, archiveName, depth, extensions, showProgress, demanglerPath, stats, results) {
  const entries = readZip(buf, { warnEncrypted: true, archiveName });
  stats.archives++;

  if (showProgress) {
    const nonDir = entries.filter(e => !e.isDirectory);
    const indent = '  '.repeat(depth + 1);
    process.stderr.write(`${indent}Expanding ZIP: ${archiveName} (${nonDir.length} entries)\n`);
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.encrypted) {
      stats.encrypted++;
      continue;
    }
    if (!entry.content) continue;

    const entryName = entry.name.replace(/\\/g, '/');
    if (hasSkippedDirSegment(entryName)) { stats.skippedDirs++; continue; }
    const virtualPath = archiveName + '!' + entryName;
    const entryExt = _getExtension(entryName);

    // Is this entry itself an archive? Recurse.
    if (_isSupportedArchive(entryExt) || _isZipBySignature(entry.content)) {
      const nested = expandArchive(entry.content, {
        archiveName: virtualPath,
        depth: depth + 1,
        extensions,
        showProgress,
        demanglerPath,
        stats,
      });
      results.push(...nested);
      continue;
    }

    // Is this a binary/executable? Process via binstrings.
    if (EXECUTABLE_EXTENSIONS.has(entryExt)) {
      const opResult = processBinary(entry.content, entryName, { demanglerPath });
      if (opResult) {
        results.push({ virtualPath: virtualPath + '.op', content: opResult.content });
        stats.files++;
        stats.binstringsProcessed++;
      }
      continue;
    }

    // Check if this is a source file we want
    if (!_isIndexableEntry(entryName, entryExt, extensions)) { if (entryExt && stats && stats.skippedExtensions) stats.skippedExtensions[entryExt] = (stats.skippedExtensions[entryExt] || 0) + 1; continue; }

    // Decode content as UTF-8
    const text = entry.content.toString('utf-8');
    results.push({ virtualPath, content: text });
    stats.files++;
  }
}


function _expandTar(buf, archiveName, depth, extensions, showProgress, demanglerPath, stats, results) {
  const entries = readTar(buf);
  stats.archives++;

  if (showProgress) {
    const nonDir = entries.filter(e => !e.isDirectory);
    const indent = '  '.repeat(depth + 1);
    process.stderr.write(`${indent}Expanding TAR: ${archiveName} (${nonDir.length} entries)\n`);
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.content) continue;

    const entryName = entry.name.replace(/\\/g, '/');
    if (hasSkippedDirSegment(entryName)) { stats.skippedDirs++; continue; }
    const virtualPath = archiveName + '!' + entryName;
    const entryExt = _getExtension(entryName);

    // Nested archive?
    if (_isSupportedArchive(entryExt) || _isZipBySignature(entry.content)) {
      const nested = expandArchive(entry.content, {
        archiveName: virtualPath,
        depth: depth + 1,
        extensions,
        showProgress,
        demanglerPath,
        stats,
      });
      results.push(...nested);
      continue;
    }

    // Executable? Process via binstrings.
    if (EXECUTABLE_EXTENSIONS.has(entryExt)) {
      const opResult = processBinary(entry.content, entryName, { demanglerPath });
      if (opResult) {
        results.push({ virtualPath: virtualPath + '.op', content: opResult.content });
        stats.files++;
        stats.binstringsProcessed++;
      }
      continue;
    }

    if (!_isIndexableEntry(entryName, entryExt, extensions)) { if (entryExt && stats && stats.skippedExtensions) stats.skippedExtensions[entryExt] = (stats.skippedExtensions[entryExt] || 0) + 1; continue; }

    const text = entry.content.toString('utf-8');
    results.push({ virtualPath, content: text });
    stats.files++;
  }
}


// ========================================================================
// HAR expansion (#161) — DevTools network capture as an archive type
// ========================================================================
//
// A .har is structured JSON: log.entries[].response.content carries the
// bodies the browser actually loaded (auth'd pages, lazy chunks included).
// CE makes zero network requests — the air-gap-clean half of TODO #334.
// Text responses only in v1; binary carving is #74/#129 territory.

/**
 * Infer an extension from a mimeType, for URL paths with no extension.
 * Substring-based, mirroring _harIsTextMime: real captures carry vendor
 * variants ('application/json+protobuf', ...) that an exact map misses —
 * Google Drive alone had 76 such responses filtered before this was fuzzy.
 */
function _harMimeExt(mime) {
  if (/javascript|ecmascript/.test(mime)) return '.js';
  if (mime.includes('json')) return '.json';
  if (mime.includes('css')) return '.css';
  if (mime.includes('html')) return '.html';
  if (mime.includes('svg')) return '.svg';
  if (mime.includes('xml')) return '.xml';
  if (mime.startsWith('text/')) return '.txt';
  return '';
}

/** Extensions treated as text when the response carries no usable mimeType. */
const _HAR_TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.htm', '.xml', '.svg',
  '.txt', '.map', '.ts', '.jsx', '.tsx',
]);

function _harIsTextMime(mime) {
  return /javascript|ecmascript|json|xml|html|css|svg/.test(mime) ||
         mime.startsWith('text/');
}

/** Web-asset extensions a network capture exists to carry. */
const _HAR_WEB_EXTS = new Set(['.html', '.htm', '.css', '.svg']);

function _setEquals(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * The effective extension filter for HAR entries. CE's DEFAULT_EXTENSIONS
 * deliberately omits .html/.css/.svg (noise in most source trees), but a
 * network capture's HTML/CSS IS the page — so the default set is augmented
 * with web-asset extensions. An EXPLICIT --extensions choice (any set that
 * isn't the stock default) is respected exactly.
 */
function _harEffectiveExtensions(extensions) {
  if (extensions && !_setEquals(extensions, DEFAULT_EXTENSIONS)) return extensions;
  const union = new Set(extensions || _SOURCE_LIKE_EXTENSIONS);
  for (const e of _HAR_WEB_EXTS) union.add(e);
  return union;
}

/**
 * URL -> entry name: host + pathname, query stripped. `:` (port) becomes `_`
 * so virtual paths stay unambiguous next to CE's file:line rendering. A
 * pathname with no extension gets one inferred from the mimeType so the
 * indexable-entry filter can see it; a bare `/` becomes index.html.
 * Returns null for non-http(s) schemes (data:, blob:, ws:, chrome:).
 */
function _harEntryName(url, mime) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let pathname = u.pathname || '/';
  try { pathname = decodeURIComponent(pathname); } catch { /* keep raw */ }
  if (pathname.endsWith('/')) pathname += 'index.html';
  let name = (u.host + pathname).replace(/:/g, '_');
  // Conservative sanitize: keep path structure, normalize oddball chars.
  name = name.replace(/[^\w.\-/@~+]/g, '_');
  const base = name.slice(name.lastIndexOf('/') + 1);
  if (!/\.[A-Za-z0-9]{1,8}$/.test(base)) {
    name += _harMimeExt(mime);
  }
  return name;
}

function _expandHar(buf, archiveName, depth, extensions, showProgress, stats, results) {
  let har;
  try {
    har = JSON.parse(buf.toString('utf-8'));
  } catch (e) {
    process.stderr.write(`  WARNING: ${archiveName}: not valid HAR JSON (${e.message})\n`);
    stats.errors++;
    return;
  }
  const entries = har && har.log && Array.isArray(har.log.entries) ? har.log.entries : null;
  if (!entries) {
    process.stderr.write(`  WARNING: ${archiveName}: no log.entries — not a HAR capture\n`);
    stats.errors++;
    return;
  }
  stats.archives++;

  const indent = '  '.repeat(depth + 1);
  if (showProgress) {
    process.stderr.write(`${indent}Expanding HAR: ${archiveName} (${entries.length} entries)\n`);
  }

  // seen: entry name -> array of contents already emitted under that name
  // (repeat captures of identical content collapse; differing content gets
  // a _2/_3 suffix — same never-overwrite convention as --emit-harness).
  const seen = new Map();
  const extCounts = new Map();
  const effExtensions = _harEffectiveExtensions(extensions);
  let kept = 0, nonText = 0, missingBody = 0, oversize = 0,
      dupes = 0, filtered = 0, badUrl = 0;

  for (const e of entries) {
    const url = e && e.request && e.request.url;
    const content = e && e.response && e.response.content;
    if (!url) { badUrl++; continue; }
    const mime = ((content && content.mimeType) || '').toLowerCase().split(';')[0].trim();
    const probeName = _harEntryName(url, mime);
    if (!probeName) { badUrl++; continue; }
    // Text gate: by mimeType, or by URL extension when the mimeType is absent.
    const probeExt = _getExtension(probeName);
    if (mime ? !_harIsTextMime(mime) : !_HAR_TEXT_EXTS.has(probeExt)) { nonText++; continue; }
    if (!content || content.text == null) { missingBody++; continue; }

    let text = content.text;
    if (content.encoding === 'base64') {
      try { text = Buffer.from(text, 'base64').toString('utf-8'); }
      catch { missingBody++; continue; }
    }
    if (text.length > MAX_ENTRY_SIZE) { oversize++; continue; }

    if (!_isIndexableEntry(probeName, probeExt, effExtensions)) { filtered++; continue; }

    let name = probeName;
    const prior = seen.get(probeName);
    if (prior) {
      if (prior.includes(text)) { dupes++; continue; }
      prior.push(text);
      name = probeName.replace(/(\.[A-Za-z0-9]+)$/, `_${prior.length}$1`);
      if (name === probeName) name = `${probeName}_${prior.length}`;
    } else {
      seen.set(probeName, [text]);
    }

    results.push({ virtualPath: archiveName + '!' + name, content: text });
    stats.files++;
    kept++;
    extCounts.set(probeExt, (extCounts.get(probeExt) || 0) + 1);
  }

  stats.skippedBinary += nonText;

  if (showProgress) {
    const byExt = [...extCounts.entries()].sort((a, b) => b[1] - a[1])
      .map(([x, n]) => `${n} ${x}`).join(', ');
    const skips = [];
    if (nonText) skips.push(`${nonText} non-text`);
    if (missingBody) skips.push(`${missingBody} missing body`);
    if (filtered) skips.push(`${filtered} filtered by extension set`);
    if (dupes) skips.push(`${dupes} duplicate responses`);
    if (oversize) skips.push(`${oversize} oversize`);
    if (badUrl) skips.push(`${badUrl} non-http(s)/unparseable URL`);
    process.stderr.write(`${indent}HAR ${archiveName}: ${kept} indexed` +
      `${byExt ? ` (${byExt})` : ''}${skips.length ? `; skipped: ${skips.join(', ')}` : ''}\n`);
  }
}


function _expandGzip(buf, archiveName, depth, extensions, showProgress, demanglerPath, stats, results) {
  const gzResult = decompressGzip(buf, archiveName);

  if (gzResult.isTar && gzResult.tarEntries) {
    // It's a .tar.gz / .tgz — process the tar entries
    stats.archives++;

    if (showProgress) {
      const nonDir = gzResult.tarEntries.filter(e => !e.isDirectory);
      const indent = '  '.repeat(depth + 1);
      process.stderr.write(`${indent}Expanding TAR.GZ: ${archiveName} (${nonDir.length} entries)\n`);
    }

    for (const entry of gzResult.tarEntries) {
      if (entry.isDirectory) continue;
      if (!entry.content) continue;

      const entryName = entry.name.replace(/\\/g, '/');
      if (hasSkippedDirSegment(entryName)) { stats.skippedDirs++; continue; }
      const virtualPath = archiveName + '!' + entryName;
      const entryExt = _getExtension(entryName);

      if (_isSupportedArchive(entryExt) || _isZipBySignature(entry.content)) {
        const nested = expandArchive(entry.content, {
          archiveName: virtualPath,
          depth: depth + 1,
          extensions,
          showProgress,
          demanglerPath,
          stats,
        });
        results.push(...nested);
        continue;
      }

      if (EXECUTABLE_EXTENSIONS.has(entryExt)) {
        const opResult = processBinary(entry.content, entryName, { demanglerPath });
        if (opResult) {
          results.push({ virtualPath: virtualPath + '.op', content: opResult.content });
          stats.files++;
          stats.binstringsProcessed++;
        }
        continue;
      }

      if (!_isIndexableEntry(entryName, entryExt, extensions)) { if (entryExt && stats && stats.skippedExtensions) stats.skippedExtensions[entryExt] = (stats.skippedExtensions[entryExt] || 0) + 1; continue; }

      const text = entry.content.toString('utf-8');
      results.push({ virtualPath, content: text });
      stats.files++;
    }
  } else if (gzResult.content) {
    // Single gzipped file (e.g., source.py.gz)
    stats.archives++;
    const innerName = gzResult.innerName || 'decompressed';
    const virtualPath = archiveName + '!' + innerName;
    const entryExt = _getExtension(innerName);

    if (_isSupportedArchive(entryExt) || _isZipBySignature(gzResult.content)) {
      const nested = expandArchive(gzResult.content, {
        archiveName: virtualPath,
        depth: depth + 1,
        extensions,
        showProgress,
        demanglerPath,
        stats,
      });
      results.push(...nested);
    } else if (EXECUTABLE_EXTENSIONS.has(entryExt)) {
      const opResult = processBinary(gzResult.content, innerName, { demanglerPath });
      if (opResult) {
        results.push({ virtualPath: virtualPath + '.op', content: opResult.content });
        stats.files++;
        stats.binstringsProcessed++;
      }
    } else if (_isIndexableEntry(innerName, entryExt, extensions)) {
      const text = gzResult.content.toString('utf-8');
      results.push({ virtualPath, content: text });
      stats.files++;
    }
  } else {
    stats.errors++;
  }
}


// ========================================================================
// Utility functions
// ========================================================================

function _isZipByName(name) {
  const lower = name.toLowerCase();
  return ZIP_EXTENSIONS.has(_getExtension(lower));
}

function _isZipBySignature(buf) {
  // ZIP magic: PK\x03\x04 (local file header) or PK\x05\x06 (empty archive)
  if (!buf || buf.length < 4) return false;
  return (buf[0] === 0x50 && buf[1] === 0x4b &&
          (buf[2] === 0x03 && buf[3] === 0x04 ||
           buf[2] === 0x05 && buf[3] === 0x06));
}

function _isSupportedArchive(ext) {
  return SUPPORTED_ARCHIVE_EXTENSIONS.has(ext);
}

/**
 * Get extension, handling compound extensions like .tar.gz
 */
function _getExtension(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return '.tar.gz';
  if (lower.endsWith('.tar.bz2')) return '.tar.bz2';
  if (lower.endsWith('.tar.xz')) return '.tar.xz';
  return path.extname(lower);
}

/**
 * Check if an entry should be included in the index.
 * @param {string} name - Entry filename
 * @param {string} ext - Lowercase extension
 * @param {Set<string>|null} extensions - Allowed extensions (null = use default heuristic)
 */
function _isIndexableEntry(name, ext, extensions) {
  // Skip hidden files
  const baseName = path.basename(name);
  if (baseName.startsWith('.')) return false;

  // Skip common non-source files inside archives
  if (_SKIP_ARCHIVE_ENTRIES.has(baseName.toLowerCase())) return false;

  // If caller provided extension set, use it
  if (extensions) {
    return extensions.has(ext);
  }

  // Default: include anything with a known source extension,
  // plus .op files (binstrings output), plus text files
  return _SOURCE_LIKE_EXTENSIONS.has(ext);
}

/** Files commonly found in archives that are never source code */
const _SKIP_ARCHIVE_ENTRIES = new Set([
  'manifest.mf', 'thumbs.db', '.ds_store', 'desktop.ini',
  'license', 'license.txt', 'license.md', 'copying',
  'notice', 'notice.txt',
]);

/** Extensions likely to be source or text worth indexing */
const _SOURCE_LIKE_EXTENSIONS = new Set([
  // C/C++
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.c++', '.h++',
  // Python
  '.py', '.pyw', '.pyx',
  // Java/Kotlin
  '.java', '.kt', '.kts',
  // JavaScript/TypeScript
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.coffee', '.hbs',
  // Go/Rust
  '.go', '.rs',
  // Web/Script
  '.php', '.rb', '.pl', '.pm',
  '.sh', '.bash', '.zsh', '.awk', '.vbs', '.bas',
  // Other
  '.swift', '.m', '.mm', '.cs', '.scala', '.groovy', '.lua', '.r',
  // Config/text
  '.md', '.txt', '.rst', '.yaml', '.yml',
  '.xml', '.json', '.toml', '.ini', '.cfg', '.conf', '.properties',
  // Binstrings output (Task 2)
  '.op',
]);


/**
 * Check if a file path (on disk) is a supported archive that should be
 * expanded during --build-index.
 *
 * @param {string} filePath - Full or relative file path
 * @returns {boolean}
 */
export function isSupportedArchive(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tar.gz')) return true;
  const ext = path.extname(lower);
  return SUPPORTED_ARCHIVE_EXTENSIONS.has(ext);
}


// ========================================================================
// Zipped-index support (#176): load an index packaged as a single .zip
// ========================================================================

/**
 * Read+decompress one zip entry, sized to the entry rather than the 256 MB
 * build-index zip-bomb cap — index artifacts are trusted and a single
 * literal_index.json / inverted_index.json routinely runs to hundreds of MB
 * (the README documents multi-GB indexes). ZIP64 members are not supported.
 */
function _readIndexEntry(buf, offset, method, compSize, uncompSize) {
  if (offset + 30 > buf.length || buf.readUInt32LE(offset) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(offset + 26);
  const extraLen = buf.readUInt16LE(offset + 28);
  const gpFlag = buf.readUInt16LE(offset + 6);
  // Bit 3: real sizes live in a trailing data descriptor — central-directory
  // sizes are 0 here, which we can't use, so skip.
  if (compSize === 0 && uncompSize === 0 && (gpFlag & 0x08)) return null;
  const dataOffset = offset + 30 + nameLen + extraLen;
  if (dataOffset + compSize > buf.length) return null;
  const compData = buf.slice(dataOffset, dataOffset + compSize);
  if (method === 0) return compData;                 // stored
  if (method === 8) {                                // deflate
    try { return zlib.inflateRawSync(compData, { maxOutputLength: uncompSize + 64 }); }
    catch { return null; }
  }
  return null;                                        // unsupported method
}

/**
 * Extract every entry of a .zip to `destDir`, decompressing one entry at a
 * time and writing it straight to disk — peak memory is ~the single largest
 * member, not the whole index. Rejects path traversal; flags encrypted
 * entries (which are skipped). ZIP64 (>4 GB) throws.
 *
 * @returns {{fileCount:number, encryptedCount:number, names:string[]}}
 */
export function extractZipToDir(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);

  let eocd = -1;
  const searchStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= searchStart; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`Not a valid .zip (no End-of-Central-Directory record): ${zipPath}`);

  const cdEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xFFFFFFFF || cdEntries === 0xFFFF)
    throw new Error(`ZIP64 archive (>4 GB) is not supported yet: ${zipPath}`);

  fs.mkdirSync(destDir, { recursive: true });

  let pos = cdOffset, fileCount = 0, encryptedCount = 0;
  const names = [];
  for (let i = 0; i < cdEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break;
    const gpFlag = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOff = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf-8');
    pos += 46 + nameLen + extraLen + commentLen;

    const rel = name.replace(/\\/g, '/');
    if (rel.split('/').some(seg => seg === '..')) continue;   // path-traversal guard
    const outPath = path.join(destDir, rel);

    if (rel.endsWith('/')) { fs.mkdirSync(outPath, { recursive: true }); continue; }
    if ((gpFlag & 0x01) !== 0) { encryptedCount++; continue; }

    const data = _readIndexEntry(buf, localOff, method, compSize, uncompSize);
    if (data == null) continue;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
    fileCount++;
    names.push(rel);
  }
  return { fileCount, encryptedCount, names };
}

/** The dir under `base` holding literal_index.json (base itself, or a single subdir), or null. */
function _findIndexRoot(base) {
  try {
    if (fs.existsSync(path.join(base, 'literal_index.json'))) return base;
    for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
      if (ent.isDirectory() && fs.existsSync(path.join(base, ent.name, 'literal_index.json')))
        return path.join(base, ent.name);
    }
  } catch { /* fallthrough */ }
  return null;
}

/**
 * Resolve an index path that points at a `.zip` to a real directory on disk,
 * extracting to a cached temp dir on first use (#176). Non-zip paths (and
 * missing paths) are returned unchanged, so this is a no-op for normal
 * directory indexes.
 *
 * Cache key = basename+size+mtime, so repeated runs over the same `.zip`
 * reuse the extraction instead of re-unpacking hundreds of MB each time.
 *
 * @param {string} indexPath
 * @returns {string}
 */
export function resolveIndexDir(indexPath) {
  if (!indexPath || typeof indexPath !== 'string') return indexPath;
  if (!/\.zip$/i.test(indexPath)) return indexPath;
  let st;
  try { st = fs.statSync(indexPath); } catch { return indexPath; }  // let downstream report a missing path
  if (st.isDirectory()) return indexPath;                            // a directory literally named "*.zip"

  const base = path.basename(indexPath).replace(/\.zip$/i, '');
  const key = `${base}-${st.size}-${Math.round(st.mtimeMs)}`;
  const cacheDir = path.join(os.tmpdir(), 'codeexam-zip-index', key);

  const cached = _findIndexRoot(cacheDir);
  if (cached) {
    process.stderr.write(`[zip-index] reusing cached extraction: ${cached}\n`);
    return cached;
  }

  const staging = `${cacheDir}.staging-${process.pid}`;
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
  process.stderr.write(`[zip-index] extracting ${path.basename(indexPath)} (one-time, cached afterward)...\n`);
  const { fileCount, encryptedCount } = extractZipToDir(indexPath, staging);

  let root = _findIndexRoot(staging);
  if (!root) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* ignore */ }
    if (encryptedCount > 0) {
      throw new Error(`${path.basename(indexPath)} has ${encryptedCount} encrypted entr${encryptedCount === 1 ? 'y' : 'ies'} and no readable index files — password-protected index loading is not yet supported (#176).`);
    }
    throw new Error(`${path.basename(indexPath)} is not a CodeExam index zip (no literal_index.json among ${fileCount} extracted file(s)).`);
  }

  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    fs.renameSync(staging, cacheDir);
    root = _findIndexRoot(cacheDir) || cacheDir;
  } catch {
    // Cross-device rename or a race: use the staging extraction in place.
    return root;
  }
  process.stderr.write(`[zip-index] extracted to ${root}\n`);
  return root;
}

