// binstrings.js — extracts printable strings from binaries into indexable .op pseudo-source; C++ demangling optional
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * binstrings.js - Extract indexable strings from compiled binaries.
 *
 * Processes binary executables (.exe, .dll, .so, .pyd, .sys, .class, etc.)
 * by extracting printable ASCII strings, filtering noise, optionally
 * demangling C++ names, and generating pseudo-source (.op) content that
 * the existing regex function parser can index.
 *
 * Output format (in-memory string, treated as a virtual .op file):
 *   // Source: path/to/binary.dll
 *   // Size: 142,567,890 bytes
 *   // Strings: 8,432 (of 23,891 raw, 64.7% filtered)
 *   void binary_dll() {
 *       SSL_CTX_new();
 *       EVP_DigestInit_ex();
 *       "certificate verify failed";
 *       ...
 *   }
 *
 * The function parser sees this as a C function containing call expressions
 * and string literals, making all extracted strings searchable via the
 * inverted index, multisect, callers, etc.
 *
 * Ported from binstrings_2.py. Zero external dependencies.
 * Demangling requires an external tool (vc++filt.exe, c++filt) if desired.
 */

import { execFileSync } from 'child_process';


// ========================================================================
// Constants
// ========================================================================

/** Minimum string length to extract from binaries */
const DEFAULT_MIN_LENGTH = 4;

/** Maximum size of binary to process (512 MB) — skip huge binaries */
const MAX_BINARY_SIZE = 512 * 1024 * 1024;

/** Extensions we process as executables/binaries */
export const BINSTRING_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.sys', '.pyd',
  '.o', '.obj', '.a', '.lib',
  '.class', '.pyc', '.pyo', '.wasm',
]);

/**
 * Is this indexed path CE-generated pseudo-source rather than code? Today
 * that is the `.op` string-dump this module writes for a binary; any future
 * decompile / disassembly artifact belongs here too. One definition, used by
 * the vocabulary noise gate, multisect's match `kind`, `listFunctions()`, the
 * ballpark, and per-element retrieval.
 *
 * The material is RIGHT to index (a compiled-only distribution is what
 * binstrings is for, and `--search` / `--show-file` read it as what it is).
 * It is WRONG to score as a function: a dump is one `bin_<name>`
 * pseudo-function holding every string in the binary, so any ranker that
 * counts co-occurring terms per function ranks it like a very large function
 * that mentions everything. Measured 2026-08-27 (#310): on an index carrying
 * `__pycache__` dumps, 30 of 39 "strong" claim-to-index links had a
 * `bin_pycache_*` bag as their best function, and per-element retrieval
 * nominated `.op` files as chart targets in six of six charts on indexes
 * holding binaries (a fifth of the target budget, judged as string tables).
 */
export function isPseudoSource(fp) {
  return /\.op$/i.test(String(fp || ''));
}


// ========================================================================
// String extraction from binary data
// ========================================================================

/**
 * Extract printable ASCII strings from a binary Buffer.
 * Finds sequences of printable bytes (0x20-0x7E) of at least minLength.
 *
 * @param {Buffer} buf - Binary file contents
 * @param {number} [minLength=4] - Minimum string length
 * @returns {string[]} Array of extracted strings
 */
export function extractStrings(buf, minLength = DEFAULT_MIN_LENGTH) {
  const results = [];
  let start = -1;

  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i] : 0;
    const printable = b >= 0x20 && b <= 0x7e;

    if (printable) {
      if (start < 0) start = i;
    } else {
      if (start >= 0 && (i - start) >= minLength) {
        results.push(buf.slice(start, i).toString('ascii'));
      }
      start = -1;
    }
  }

  return results;
}


// ========================================================================
// String filtering (noise removal)
// ========================================================================

/** Common PE/ELF section names and compiler artifacts */
const PE_NOISE = new Set([
  '.text', '.data', '.rdata', '.bss', '.rsrc', '.reloc', '.idata',
  '.edata', '.pdata', '.tls', '.debug', '.CRT', '.xdata',
  'PADDINGXXPADDING', 'Rich', 'RSDS',
]);

/** Strings that appear in virtually every DLL (too common to be useful) */
const UNIVERSAL_NOISE = new Set([
  'This program cannot be run in DOS mode.',
  'KERNEL32.dll', 'ntdll.dll', 'USER32.dll', 'ADVAPI32.dll',
  'api-ms-win-crt-runtime-l1-1-0.dll',
  'api-ms-win-crt-heap-l1-1-0.dll',
  'api-ms-win-crt-stdio-l1-1-0.dll',
  'api-ms-win-crt-string-l1-1-0.dll',
  'api-ms-win-crt-math-l1-1-0.dll',
  'api-ms-win-crt-locale-l1-1-0.dll',
  'api-ms-win-crt-time-l1-1-0.dll',
  'api-ms-win-crt-convert-l1-1-0.dll',
  'api-ms-win-crt-environment-l1-1-0.dll',
  'api-ms-win-crt-filesystem-l1-1-0.dll',
  'api-ms-win-crt-process-l1-1-0.dll',
  'api-ms-win-crt-utility-l1-1-0.dll',
  '<module>', '__main__',
]);

/** Regex patterns for strings to exclude */
const NOISE_PATTERNS = [
  /^[0-9a-fA-F]{8,}$/,             // pure hex
  /^[0-9]+$/,                       // pure numbers
  /^[0-9.]+$/,                      // version-like (1.2.3)
  /^[A-Z]{1,3}$/,                   // short uppercase (EAX, ESP)
  /^[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]+$/,  // pure punctuation
  /^(__|@@)/,                        // raw mangled names (will be demangled separately)
  /^[A-Za-z]:\\.*\\(obj|debug|release|build)\\/i,  // build paths
  /^\.\.\/\.\.\//,                   // relative build paths
  /^[a-z]:\\buildtrees\\/i,          // vcpkg build paths
  /^d:\\a\\_work\\/i,                // CI paths
];

/** Substrings that indicate PE import/export boilerplate */
const NOISE_SUBSTRINGS = [
  'api-ms-win-',
  'ext-ms-win-',
  'VCRUNTIME',
  'ucrtbase',
  'concrt',
  'msvcp',
  'msvcr',
];


/**
 * Return true if a string is likely noise that should be filtered.
 * @param {string} s
 * @returns {boolean}
 */
export function isNoise(s) {
  const stripped = s.trim();

  // Too short
  if (stripped.length < 4) return true;

  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(stripped)) return true;

  // Exact matches
  if (PE_NOISE.has(stripped) || UNIVERSAL_NOISE.has(stripped)) return true;

  // Pattern-based noise
  for (const pat of NOISE_PATTERNS) {
    if (pat.test(stripped)) return true;
  }

  // Substring-based noise
  for (const sub of NOISE_SUBSTRINGS) {
    if (stripped.includes(sub)) return true;
  }

  // Repetitive character sequences
  if (stripped.length > 4) {
    const unique = new Set(stripped);
    if (unique.size <= 2) return true;
  }

  return false;
}


/**
 * Classify a string for formatting in the .op output.
 * @param {string} s
 * @returns {'identifier'|'string'}
 */
export function classifyString(s) {
  // Looks like a C/C++ identifier or API name
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return 'identifier';

  // Looks like a namespaced C++ name (already demangled)
  if (/^[A-Za-z_][A-Za-z0-9_:]*[A-Za-z0-9_]$/.test(s)) return 'identifier';

  return 'string';
}


// ========================================================================
// Demangling (optional — requires external tool)
// ========================================================================

/**
 * Extract strings that look like mangled C++ names.
 * @param {string[]} strings - Extracted strings from binary
 * @returns {string[]} Mangled name strings
 */
export function extractMangledNames(strings) {
  const mangled = [];
  for (const s of strings) {
    // MSVC mangling starts with ?
    if (s.startsWith('?') && s.length > 3) {
      mangled.push(s);
    }
    // GCC/Clang mangling starts with _Z
    else if (s.startsWith('_Z') && s.length > 3) {
      mangled.push(s);
    }
  }
  return mangled;
}


/**
 * Demangle a batch of C++ names using an external demangler tool.
 * Processes in chunks to avoid command-line length limits.
 *
 * @param {string[]} mangledNames - Array of mangled name strings
 * @param {string} demanglerPath - Path to demangler executable
 * @returns {Map<string,string>} Map of mangled → demangled names
 */
function demangleBatch(mangledNames, demanglerPath) {
  const result = new Map();
  if (!mangledNames.length || !demanglerPath) return result;

  const CHUNK_SIZE = 500;

  for (let i = 0; i < mangledNames.length; i += CHUNK_SIZE) {
    const chunk = mangledNames.slice(i, i + CHUNK_SIZE);
    try {
      const inputText = chunk.join('\n');
      const output = execFileSync(demanglerPath, [], {
        input: inputText,
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const demangled = output.trim().split('\n');
      for (let j = 0; j < chunk.length && j < demangled.length; j++) {
        const dem = demangled[j].trim();
        if (dem && dem !== chunk[j]) {
          result.set(chunk[j], dem);
        }
      }
    } catch (e) {
      if (e.code === 'ENOENT') {
        process.stderr.write(`  WARNING: Demangler not found: ${demanglerPath}\n`);
        return result;  // No point trying more chunks
      }
      // Timeout or other error — try next chunk
      process.stderr.write(`  WARNING: Demangler error on chunk: ${e.message}\n`);
    }
  }

  return result;
}


// ========================================================================
// Function name generation
// ========================================================================

/**
 * Generate a valid C-style function name from a binary file's path/name.
 * E.g., "torch/_C.cp310-win_amd64.pyd" → "torch__C_cp310_win_amd64_pyd"
 *
 * @param {string} binaryPath - Relative path to the binary
 * @returns {string}
 */
export function makeFuncName(binaryPath) {
  // Use just the filename (or last 2 path components for context)
  const parts = binaryPath.replace(/\\/g, '/').split('/').filter(Boolean);
  let meaningful;
  if (parts.length >= 2) {
    meaningful = parts.slice(-2).join('_');
  } else {
    meaningful = parts[parts.length - 1] || 'unknown';
  }

  // Replace non-identifier chars with underscore
  let name = meaningful.replace(/[^A-Za-z0-9_]/g, '_');

  // Ensure starts with letter
  if (name && !/^[a-zA-Z]/.test(name)) {
    name = 'bin_' + name;
  }

  // Collapse multiple underscores
  name = name.replace(/_+/g, '_');

  // Trim trailing underscore
  if (name.endsWith('_')) name = name.slice(0, -1);

  return name || 'unknown_binary';
}


// ========================================================================
// Main processing API
// ========================================================================

/**
 * Process a binary file (from Buffer) and generate .op pseudo-source content.
 * All in-memory — no files created on disk.
 *
 * @param {Buffer} buf - Binary file contents
 * @param {string} binaryName - Display name/path of the binary
 * @param {object} [opts]
 * @param {number} [opts.minLength=4] - Minimum string length to extract
 * @param {string|null} [opts.demanglerPath=null] - Path to C++ demangler tool
 * @param {boolean} [opts.verbose=false] - Print per-file progress
 * @returns {{content: string, stats: {rawStrings: number, filteredStrings: number, demangled: number, fileSize: number}}|null}
 *   Returns null if no useful strings found.
 */
export function processBinary(buf, binaryName, opts = {}) {
  const {
    minLength = DEFAULT_MIN_LENGTH,
    demanglerPath = null,
    verbose = false,
  } = opts;

  const fileSize = buf.length;

  // Skip enormous binaries
  if (fileSize > MAX_BINARY_SIZE) {
    if (verbose) {
      process.stderr.write(`  Skipping ${binaryName} (${(fileSize / 1024 / 1024).toFixed(0)} MB > limit)\n`);
    }
    return null;
  }

  // Extract raw strings
  const rawStrings = extractStrings(buf, minLength);
  const rawCount = rawStrings.length;

  if (rawCount === 0) return null;

  // Extract and demangle C++ names
  let demangledMap = new Map();
  if (demanglerPath) {
    const mangled = extractMangledNames(rawStrings);
    if (mangled.length > 0) {
      demangledMap = demangleBatch(mangled, demanglerPath);
    }
  }

  // Filter noise and deduplicate
  const seen = new Set();
  const filtered = [];

  for (const s of rawStrings) {
    // Check if this is a mangled name with a demangled version
    const resolved = demangledMap.get(s) || s;

    if (isNoise(resolved)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    filtered.push(resolved);
  }

  // Also add demangled names whose mangled form was noise-filtered
  for (const [mangled, demangled] of demangledMap) {
    if (!seen.has(demangled) && !isNoise(demangled)) {
      seen.add(demangled);
      filtered.push(demangled);
    }
  }

  if (filtered.length === 0) return null;

  const filteredPct = ((1.0 - filtered.length / rawCount) * 100).toFixed(1);

  // Generate .op content
  const funcName = makeFuncName(binaryName);
  const lines = [];

  lines.push(`// Source: ${binaryName}`);
  lines.push(`// Size: ${fileSize.toLocaleString()} bytes`);
  lines.push(`// Strings: ${filtered.length} (of ${rawCount} raw, ${filteredPct}% filtered)`);
  if (demangledMap.size > 0) {
    lines.push(`// Demangled: ${demangledMap.size} C++ names`);
  }
  lines.push('//');
  lines.push(`void ${funcName}() {`);

  for (const s of filtered) {
    const kind = classifyString(s);
    if (kind === 'identifier') {
      lines.push(`    ${s}();`);
    } else {
      // Escape quotes and backslashes
      let escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      // Truncate very long strings
      if (escaped.length > 300) {
        escaped = escaped.slice(0, 297) + '...';
      }
      lines.push(`    "${escaped}";`);
    }
  }

  lines.push('}');

  return {
    content: lines.join('\n') + '\n',
    stats: {
      rawStrings: rawCount,
      filteredStrings: filtered.length,
      demangled: demangledMap.size,
      fileSize,
    },
  };
}
