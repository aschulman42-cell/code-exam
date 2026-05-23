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

