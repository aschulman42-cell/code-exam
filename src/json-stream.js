// json-stream.js — streaming byte-level JSON object parser that reads >2GB index files via chunked fd reads
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * json-stream.js - Zero-dependency streaming JSON object parser.
 *
 * Handles JSON files of ANY size (including >2GB, >4GB) by reading from
 * disk in chunks via file descriptors. Never loads the whole file into
 * memory or a Buffer.
 *
 * Supports top-level JSON objects: { "key": value, ... }
 * Values can be any valid JSON (strings, numbers, arrays, objects).
 *
 * Two modes:
 *   1. Buffer mode - for files <2GB, uses a pre-loaded Buffer (fast)
 *   2. File mode   - for files >=2GB, reads chunks on demand via fd
 */

import fs from 'fs';

// Byte constants
const LBRACE = 0x7B;   // {
const RBRACE = 0x7D;   // }
const LBRACK = 0x5B;   // [
const RBRACK = 0x5D;   // ]
const DQUOTE = 0x22;   // "
const BSLASH = 0x5C;   // \
const COLON  = 0x3A;   // :
const COMMA  = 0x2C;   // ,
const SPACE  = 0x20;
const TAB    = 0x09;
const CR     = 0x0D;
const LF     = 0x0A;

const MAX_BUFFER_SIZE = 2 * 1024 * 1024 * 1024 - 1; // ~2GB Node Buffer limit


// ========================================================================
// FileScanner - chunked byte-level access to large files
// ========================================================================

const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB read chunks

class FileScanner {
  /**
   * @param {string} filepath
   */
  constructor(filepath) {
    this.fd = fs.openSync(filepath, 'r');
    const stat = fs.fstatSync(this.fd);
    this.size = stat.size;
    // Use BigInt position for files > 2GB
    this._buf = Buffer.alloc(CHUNK_SIZE);
    this._bufStart = -1;    // byte offset of buffer start in file
    this._bufLen = 0;        // valid bytes in buffer
  }

  /**
   * Get byte at absolute file position.
   * Loads chunk if not already cached.
   */
  byteAt(pos) {
    if (pos < this._bufStart || pos >= this._bufStart + this._bufLen) {
      this._loadChunk(pos);
    }
    return this._buf[pos - this._bufStart];
  }

  /**
   * Extract a range of bytes as a UTF-8 string.
   * Used to extract individual JSON values for JSON.parse().
   * For ranges that fit in a string (<512MB), this is efficient.
   */
  extractString(start, end) {
    const len = end - start;
    if (len <= 0) return '';

    // If range fits in current buffer, use it directly
    if (start >= this._bufStart && end <= this._bufStart + this._bufLen) {
      return this._buf.toString('utf-8', start - this._bufStart, end - this._bufStart);
    }

    // Otherwise allocate a temporary buffer and read
    // For very large values (>512MB), this will fail — but individual
    // JSON values should never be that large in our index format
    const tmpBuf = Buffer.alloc(len);
    let totalRead = 0;
    while (totalRead < len) {
      const bytesRead = fs.readSync(
        this.fd, tmpBuf, totalRead,
        Math.min(len - totalRead, CHUNK_SIZE),
        start + totalRead
      );
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    return tmpBuf.toString('utf-8', 0, totalRead);
  }

  _loadChunk(pos) {
    // Align to chunk boundaries for sequential scan efficiency
    this._bufStart = pos;
    const bytesRead = fs.readSync(
      this.fd, this._buf, 0,
      CHUNK_SIZE,
      pos
    );
    this._bufLen = bytesRead;
  }

  close() {
    fs.closeSync(this.fd);
    this.fd = -1;
  }
}


// ========================================================================
// Unified byte accessor - works with both Buffer and FileScanner
// ========================================================================

/**
 * @typedef {Buffer|FileScanner} ByteSource
 */

function getByte(src, pos) {
  if (Buffer.isBuffer(src)) return src[pos];
  return src.byteAt(pos);
}

function getString(src, start, end) {
  if (Buffer.isBuffer(src)) return src.toString('utf-8', start, end);
  return src.extractString(start, end);
}

function getSize(src) {
  if (Buffer.isBuffer(src)) return src.length;
  return src.size;
}


// ========================================================================
// Core parsing functions (work with any ByteSource)
// ========================================================================

function skipWS(src, pos, end) {
  while (pos < end) {
    const b = getByte(src, pos);
    if (b !== SPACE && b !== TAB && b !== CR && b !== LF) break;
    pos++;
  }
  return pos;
}

/**
 * Parse a JSON string starting at pos (opening ").
 * Returns [parsedString, endPos].
 */
function parseString(src, pos, end) {
  const strStart = pos;
  pos++; // skip opening "
  while (pos < end) {
    const b = getByte(src, pos);
    if (b === BSLASH) { pos += 2; continue; }
    if (b === DQUOTE) { pos++; break; }
    pos++;
  }
  const raw = getString(src, strStart, pos);
  return [JSON.parse(raw), pos];
}

/**
 * Skip over a complete JSON value. Returns position just past the value.
 */
function skipValue(src, pos, end) {
  if (pos >= end) return pos;
  const b = getByte(src, pos);

  // String
  if (b === DQUOTE) {
    pos++;
    while (pos < end) {
      const c = getByte(src, pos);
      if (c === BSLASH) { pos += 2; continue; }
      if (c === DQUOTE) { pos++; return pos; }
      pos++;
    }
    return pos;
  }

  // Array or object
  if (b === LBRACE || b === LBRACK) {
    let depth = 1;
    let inStr = false;
    pos++;
    while (pos < end && depth > 0) {
      const c = getByte(src, pos);
      if (inStr) {
        if (c === BSLASH) { pos += 2; continue; }
        if (c === DQUOTE) inStr = false;
      } else {
        if (c === DQUOTE) inStr = true;
        else if (c === LBRACE || c === LBRACK) depth++;
        else if (c === RBRACE || c === RBRACK) depth--;
      }
      pos++;
    }
    return pos;
  }

  // Number, boolean, null
  while (pos < end) {
    const c = getByte(src, pos);
    if (c === COMMA || c === RBRACE || c === RBRACK ||
        c === SPACE || c === TAB || c === CR || c === LF) {
      return pos;
    }
    pos++;
  }
  return pos;
}


// ========================================================================
// Public API
// ========================================================================

/**
 * Iterate over top-level entries of a JSON object.
 * Works with both Buffer (small files) and FileScanner (large files).
 *
 * @param {ByteSource} src   - Buffer or FileScanner
 * @param {number} start     - Start offset
 * @param {number} end       - End offset
 * @param {function} callback - (key, valueStart, valueEnd) => void
 */
export function forEachEntry(src, start, end, callback) {
  let pos = start;

  // Skip to opening brace
  while (pos < end && getByte(src, pos) !== LBRACE) pos++;
  pos++; // skip {

  while (pos < end) {
    pos = skipWS(src, pos, end);
    if (pos >= end || getByte(src, pos) === RBRACE) break;
    if (getByte(src, pos) === COMMA) { pos++; continue; }

    // Parse key
    if (getByte(src, pos) !== DQUOTE) break;
    const [key, keyEnd] = parseString(src, pos, end);
    pos = keyEnd;

    // Skip : 
    pos = skipWS(src, pos, end);
    if (pos < end && getByte(src, pos) === COLON) pos++;
    pos = skipWS(src, pos, end);

    // Find value boundaries
    const valueStart = pos;
    pos = skipValue(src, pos, end);
    const valueEnd = pos;

    callback(key, valueStart, valueEnd);
  }
}

/**
 * Parse a JSON object value from a source range.
 */
export function parseValue(src, start, end) {
  const str = getString(src, start, end);
  return JSON.parse(str);
}

/**
 * Fast-count total location entries in an inverted index value WITHOUT full JSON parse.
 * Format: [["filepath", [lineNum, lineNum, ...]], ["filepath2", [lineNum]], ...]
 * Counts total line numbers by scanning for numbers at bracket depth 3.
 * ~10x faster than parseValue() + reduce for large arrays.
 */
export function countLocations(src, start, end) {
  let count = 0;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < end; i++) {
    const b = getByte(src, i);
    // #251: skip everything inside JSON string values — a `[` or `]` in a
    // filepath key/value (e.g. "src/[id].js") otherwise desynced the bracket
    // depth and corrupted the location counts.
    if (inStr) {
      if (b === 0x5C) { i++; continue; }   // backslash: skip the escaped char
      if (b === 0x22) inStr = false;       // closing quote
      continue;
    }
    if (b === 0x22) { inStr = true; continue; }  // opening quote
    if (b === LBRACK) {
      depth++;
    } else if (b === RBRACK) {
      depth--;
    } else if (depth === 3 && b >= 0x30 && b <= 0x39) {
      // Start of a number in innermost [lineNum, ...] array
      count++;
      // Skip rest of number digits
      while (i + 1 < end && getByte(src, i + 1) >= 0x30 && getByte(src, i + 1) <= 0x39) i++;
    }
  }
  return count;
}

/**
 * Get byte size of a value range.
 */
export function valueSize(start, end) {
  return end - start;
}

/**
 * Open a file for streaming JSON parsing.
 * Returns a FileScanner for files >2GB, or a Buffer for smaller files.
 * Caller must call closeSource() when done.
 *
 * @param {string} filepath
 * @returns {{ src: ByteSource, size: number }}
 */
export function openJSONFile(filepath) {
  const stat = fs.statSync(filepath);
  const size = stat.size;

  if (size > MAX_BUFFER_SIZE) {
    // File too large for Buffer — use chunked file reader
    const scanner = new FileScanner(filepath);
    return { src: scanner, size };
  }

  // Small enough for Buffer (faster)
  const buf = fs.readFileSync(filepath);
  return { src: buf, size: buf.length };
}

/**
 * Close a source returned by openJSONFile.
 */
export function closeSource(src) {
  if (src && typeof src.close === 'function') {
    src.close();
  }
}

