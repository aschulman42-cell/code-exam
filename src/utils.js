/**
 * utils.js - Shared constants, helpers, and data classes for Code Exam.
 * All other modules import from here.
 */

import path from 'path';

// ========================================================================
// SearchResult data class
// ========================================================================

export class SearchResult {
  /**
   * @param {object} opts
   * @param {string} opts.filePath
   * @param {number} opts.lineNumber
   * @param {string} opts.lineText
   * @param {string} opts.context
   * @param {string} opts.matchType - 'literal', 'semantic', 'inverted', 'hybrid'
   * @param {number} opts.score - 0.0 = perfect match, higher = less similar
   * @param {number|null} [opts.chunkIndex]
   * @param {string|null} [opts.functionName]
   */
  constructor({ filePath, lineNumber, lineText, context, matchType, score,
                chunkIndex = null, functionName = null }) {
    this.filePath = filePath;
    this.lineNumber = lineNumber;
    this.lineText = lineText;
    this.context = context;
    this.matchType = matchType;
    this.score = score;
    this.chunkIndex = chunkIndex;
    this.functionName = functionName;
  }
}


// ========================================================================
// Provider capability: Claude temperature support
// ========================================================================

/**
 * True if the given Claude model accepts a `temperature` (or other sampling)
 * parameter. The frontier models — Opus 4.7+, Sonnet 5+, Fable, Mythos —
 * REMOVED sampling params: sending `temperature` (even the API-default-differing
 * 0 CE sends) returns HTTP 400 "temperature is deprecated for this model".
 * Older families still accept it.
 *
 * Fail-soft: only KNOWN-accepting families return true; anything unrecognized
 * (a future model id) returns false, because a new Anthropic model is far more
 * likely to reject sampling params than to accept them. Omitting costs
 * run-to-run determinism; sending to a rejecting model is a hard failure.
 * Mirrors `openaiSupportsTemperature` in core/openai-util.js (#254/#215).
 */
export function claudeSupportsTemperature(model) {
  const m = String(model || '').toLowerCase();
  return /sonnet-4/.test(m)        // Sonnet 4.0–4.6
    || /opus-4-[0-6]/.test(m)      // Opus 4.0–4.6 (4.7/4.8 reject)
    || /haiku/.test(m)             // Haiku 3.x / 4.5
    || /claude-3/.test(m)          // Claude 3 family
    || /sonnet-3/.test(m);         // Sonnet 3.5/3.7
}


// ========================================================================
// file@function spec parsing
// ========================================================================

/**
 * Split a "file@funcName" spec into { fileHint, funcName }, handling the two
 * `@` hazards: scoped npm packages embed `@` in paths
 * (`node_modules/@anthropic-ai/sdk/client.js@Foo`), and a purely-numeric
 * suffix is a line-number disambiguator (`getPromptForCommand@477187`), not a
 * separator. Prefer the last `@` that immediately follows a file extension;
 * fall back to the first `@`. (#252: mcp-server's extract/callees and the CLI
 * --callees used bare first-`@` splits, breaking scoped-package specs; this is
 * server.js's logic hoisted here so all of them share one implementation.)
 */
export function parseFuncSpec(spec) {
  if (spec && spec.includes('@')) {
    const extAt = /\.[a-zA-Z0-9]{1,6}@/g;
    let atPos = -1;
    let m;
    while ((m = extAt.exec(spec)) !== null) atPos = m.index + m[0].length - 1;
    if (atPos < 0) atPos = spec.indexOf('@');
    const beforeAt = spec.slice(0, atPos);
    const afterAt = spec.slice(atPos + 1);
    if (/^\d+$/.test(afterAt)) {
      return { fileHint: null, funcName: spec };
    }
    return { fileHint: beforeAt, funcName: afterAt };
  }
  return { fileHint: null, funcName: spec };
}


// ========================================================================
// Language / extension mappings
// ========================================================================

/** Extension to tree-sitter language mapping */
export const EXT_TO_LANG = {
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.hxx': 'cpp', '.h++': 'cpp', '.c++': 'cpp',
  '.c': 'c', '.h': 'cpp',  // .h -> cpp: C++ parser handles both
  '.java': 'java',
  '.py': 'python', '.pyw': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.coffee': 'javascript',
  '.hbs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.cs': 'c_sharp',
  '.go': 'go',
  '.rs': 'rust',
  '.php': 'php',
  '.rb': 'ruby',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift',
};

/** Language-appropriate class::method separators for display */
const LANG_SEPARATOR = {
  'cpp': '::', 'c': '::', 'c_sharp': '.',
  'java': '.', 'python': '.', 'javascript': '.', 'typescript': '.',
  'go': '.', 'rust': '::', 'php': '::', 'ruby': '.',
  'kotlin': '.', 'swift': '.',
};


// ========================================================================
// Display helpers
// ========================================================================

/**
 * Convert internal Class::method name to language-appropriate display.
 * Internal storage always uses ::, display uses . for Java/Python/etc.
 */
export function displayName(funcName, filepath = '') {
  if (!funcName.includes('::')) return funcName;
  const ext = path.extname(filepath).toLowerCase();
  const lang = EXT_TO_LANG[ext] || '';
  const sep = LANG_SEPARATOR[lang] || '::';
  if (sep === '::') return funcName;
  return funcName.replaceAll('::', sep);
}


/**
 * #238/#241: quote a token for copy-paste into a shell if it contains a space.
 * Double quotes so it works in bash, PowerShell, and cmd; space-free strings
 * pass through unquoted (the common case, no noise).
 */
export function quotePathIfNeeded(s) {
  return typeof s === 'string' && s.includes(' ') ? `"${s}"` : s;
}

/**
 * Render a copy-pasteable `PATH/FILE@FUNCTION` extract target, quoted if the
 * combined token contains a space. Space-safety only — see #241 for making the
 * `@`-separator round-trip parse-safe when the path or name itself contains `@`.
 */
export function pasteToken(filepath, func) {
  return quotePathIfNeeded(`${filepath}@${func}`);
}


/**
 * Print to stderr for progress/diagnostic output visible during redirection.
 */
export function eprint(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

/**
 * Print progress to stderr, overwriting the current line (\r).
 * Call eprint('') or eprint('Done...') after the loop to move to next line.
 */
export function eprogress(...args) {
  const msg = args.join(' ');
  process.stderr.write('\r' + msg + '        ');  // trailing spaces clear previous text
}


// ========================================================================
// Token splitting for vocabulary analysis
// ========================================================================

/**
 * Split a compound token (CamelCase, snake_case, or mixed) into sub-tokens.
 *
 * Examples:
 *   'doMultisectAnalyze' -> ['multisect', 'analyze']
 *   'findCallees'        -> ['find', 'callees']
 *   'multisect_search'   -> ['multisect', 'search']
 *   'getTopVocabulary'   -> ['top', 'vocabulary']
 *   '_buildVocabularyFromFiles' -> ['build', 'vocabulary', 'from', 'files']
 *   'SSLContext'          -> ['ssl', 'context']
 *   'parseJSON'           -> ['parse', 'json']
 *   'SHA256Hash'          -> ['sha256', 'hash']
 *
 * Rules:
 *   - Split on CamelCase boundaries and underscores
 *   - Consecutive uppercase treated as abbreviation: 'SSLContext' -> 'SSL' + 'Context'
 *   - All parts lowercased
 *   - Parts <= 2 chars filtered as noise (do, is, to, get, set, etc.)
 *     UNLESS the entire token is short (return as-is)
 *   - Leading underscores stripped
 *
 * @param {string} token - Raw identifier token
 * @param {number} [minPartLen=3] - Minimum sub-token length to keep
 * @returns {string[]} Array of lowercase sub-tokens
 */
export function splitCompoundToken(token, minPartLen = 3) {
  if (!token) return [];

  // Strip leading underscores
  const stripped = token.replace(/^_+/, '');
  if (!stripped) return [];

  // Split on CamelCase boundaries and underscores.
  // Same regex as CodeSearchIndex.js line 3352:
  //   (?<=[a-z])(?=[A-Z])     — camelCase boundary: 'findCallees' -> 'find' + 'Callees'
  //   (?<=[A-Z])(?=[A-Z][a-z]) — abbreviation end: 'SSLContext' -> 'SSL' + 'Context'
  //   _                        — snake_case boundary
  const parts = stripped
    .split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|_/)
    .map(p => p.toLowerCase())
    .filter(p => p.length > 0);

  // If the token didn't split (single word), return it if long enough
  if (parts.length <= 1) {
    const single = parts[0] || stripped.toLowerCase();
    return single.length >= minPartLen ? [single] : [];
  }

  // Filter short parts AND common non-discriminating verb prefixes.
  // These appear in thousands of identifiers and provide zero domain signal.
  const filtered = parts.filter(p =>
    p.length >= minPartLen && !_SUB_TOKEN_NOISE.has(p)
  );

  // If filtering removed everything, return the longest part
  if (filtered.length === 0) {
    const longest = parts.reduce((a, b) => a.length >= b.length ? a : b);
    return longest.length >= minPartLen ? [longest] : parts;
  }

  return filtered;
}

/**
 * Common sub-token noise words — appear in thousands of compound identifiers
 * and provide zero domain discrimination for vocabulary concordance.
 * These are filtered during compound splitting, not during vocabulary scoring.
 */
const _SUB_TOKEN_NOISE = new Set([
  // Verb prefixes that occur in nearly every codebase
  'get', 'set', 'has', 'can', 'did', 'will',
  'new', 'all', 'the',
  // Prepositions / connectors inside compound names
  'for', 'from', 'with', 'into', 'each',
]);


// ========================================================================
// Default file extensions
// ========================================================================

export const DEFAULT_EXTENSIONS = new Set([
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
  // Web
  '.php', '.rb', '.pl', '.pm',
  // Shell/Script
  '.sh', '.bash', '.zsh',
  '.awk', '.vbs', '.bas',
  // Other
  '.swift', '.m', '.mm',
  '.cs',
  '.scala', '.groovy',
  '.lua', '.r', '.R',
  // Resource / config
  '.rc', '.resx', '.plist', '.xml', '.json',
  // Infrastructure as code (#168 — Terraform + Azure Bicep; YAML/JSON above)
  '.tf', '.tfvars', '.bicep',
  // Documentation / text
  '.md', '.txt', '.rst', '.yaml', '.yml',
]);

export const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.rst', '.yaml', '.yml']);

/**
 * Archive extensions handled by archive.js (expanded during --build-index).
 * Separated from BINARY_EXTENSIONS so buildIndex can expand them instead of skip.
 */
export const ARCHIVE_EXTENSIONS = new Set([
  '.zip', '.jar', '.war', '.ear', '.apk',  // ZIP format
  '.tar', '.gz', '.tgz',                    // TAR / GZIP
  '.har',                                   // DevTools network capture (#161)
  '.7z', '.rar', '.bz2', '.xz', '.zst',    // Not yet natively supported
]);

/**
 * Executable/binary extensions — currently skipped, Task 2 will process via binstrings.
 */
export const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.sys', '.pyd',
  '.o', '.obj', '.a', '.lib',
  '.class', '.pyc', '.pyo', '.wasm',
]);

/**
 * Pure media/document binary extensions — always skip, never useful to index.
 */
export const MEDIA_BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff', '.tif',
  '.psd', '.xcf',
  // Audio
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.wma', '.m4a',
  // Video
  '.mp4', '.avi', '.mkv', '.mov', '.wmv', '.flv', '.webm',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Documents (non-text)
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Database
  '.db', '.sqlite', '.sqlite3',
  // Misc binary
  '.bin', '.dat', '.pak', '.nib', '.mo',
]);

