/**
 * CSI-helpers.js — Free functions and module-level state pulled out of
 * CodeSearchIndex.js. Phase 1 mega-peel of Issue #18 (after the prior
 * bundle-seam-detection extraction).
 *
 * Five thematic clusters live here, each as a banner-commented region:
 *
 *   1. Deobfuscation        — minified-JS prettifier pipeline, lazy-loaded
 *                             js-beautify + webcrack
 *   2. Name inference       — opaque-name detection and ident-keyword renames
 *   3. String-state scanning— shared JS state machine for code/string/comment
 *   4. Command-gate         — isEnabled-expression classifier (command catalog)
 *   5. Misc helpers         — escapeRegex, claim-search relevance scoring
 *
 * Future cleanup may split this file into per-theme modules. The intermediate
 * one-file form is intentional — see the discussion on Issue #18 about
 * paying the worklist round-trip cost once vs. five times. Each section is
 * cohesive and self-contained inside the file; the splits would be
 * mechanical cut/paste from here.
 *
 * Leading underscores on export names match the original CSI.js style and
 * are preserved to avoid churning callsites.
 */

import { createRequire } from 'module';


// ============================================================================
// Section 1: Deobfuscation
//
// Minified JS bundles get a three-step prettification pipeline during indexing:
//   1. deobfuscateSimple()  — regex-based safe transforms (!0 → true, etc.)
//   2. tryWebcrack()        — heavier AST-based deobfuscation (size-limited,
//                              timeout-bounded, lazy-loaded — ESM-only package)
//   3. getJsBeautify()      — formatting-only fallback (lazy-loaded via
//                              createRequire since js-beautify is CommonJS)
//
// Both optional deps are loaded defensively: a missing dep yields null, and
// callers fall through to the next step. The CSI build flow exercises this
// pipeline inside buildFunctionIndex; everything else just imports the pieces.
// ============================================================================

// js-beautify: optional dependency for prettifying minified JS during indexing
let _jsBeautify = null;
try {
  const require = createRequire(import.meta.url);
  const mod = require('js-beautify');
  _jsBeautify = mod.js || mod;
} catch { /* not installed — skip prettification */ }

/** Returns the loaded js-beautify function, or null if the dep is missing.
 *  Exposed as a getter (not a re-exported binding) because the underlying
 *  `let _jsBeautify` is reassigned inside the try-block — getter semantics
 *  are clearer than mutable named-export bindings. */
export function getJsBeautify() {
  return _jsBeautify;
}

// webcrack: optional dependency for JS deobfuscation during indexing
// Loaded lazily on first use (async import) since createRequire doesn't work for ESM-only packages
let _webcrack = undefined;  // undefined = not yet loaded, null = failed to load
export async function getWebcrack() {
  if (_webcrack !== undefined) return _webcrack;
  try {
    const mod = await import('webcrack');
    _webcrack = mod.webcrack || null;
  } catch {
    _webcrack = null;
  }
  return _webcrack;
}

/** Max file size for webcrack deobfuscation (500KB) — larger files are too slow. */
const WEBCRACK_MAX_SIZE = 500 * 1024;
/** Timeout for webcrack per file (30 seconds). */
const WEBCRACK_TIMEOUT_MS = 30000;

/**
 * Detect if file content is minified (very long average line length).
 * Returns true for .min.js files or JS/CSS with avg line > 500 chars.
 */
export function isMinified(relPath, content) {
  if (/\.min\.(js|css|jsx|ts|tsx)$/i.test(relPath)) return true;
  if (!/\.(js|css|jsx|ts|tsx)$/i.test(relPath)) return false;
  const lines = content.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return false;
  const avgLen = content.length / lines.length;
  // Minified: very few lines with very long average, OR high average line length
  // (Typical readable code: avg 30-60 chars. Minified: 500+. Semi-minified bundles: 200+)
  if (avgLen > 500) return true;
  // #161: tall bundles (webpack/Vite SPA output — claude.ai, Google Docs) have
  // thousands of short-ish lines PLUS a few monster lines (a whole minified
  // function on one line). The average lands under 500 (connectrpc: avg 117 over
  // 8685 lines) so the avg-only gate skipped them, leaving the digest a wall of
  // one-liners. Catch them via the longest line: normal source tops out in the
  // low hundreds, so a 2000+-char line means minified-in-part. Pairs with
  // --split-bundle, which reads the beautified content and benefits from it.
  const maxLineLen = lines.reduce((m, l) => (l.length > m ? l.length : m), 0);
  return maxLineLen > 2000;
}

/**
 * Simple regex-based deobfuscation transforms for minified JS/TS.
 * No AST needed — these patterns are unambiguous in JS syntax.
 * Applied BEFORE js-beautify formatting.
 */
export function deobfuscateSimple(code) {
  let result = code;
  // !0 → true, !1 → false (safe: these are always boolean in JS)
  result = result.replace(/!0\b/g, 'true');
  result = result.replace(/!1\b/g, 'false');
  // void 0 → undefined (safe: void 0 is always undefined in JS). #251: anchor the
  // LEADING boundary too — a bare `void 0\b` also matches the tail of `avoid 0`,
  // rewriting it to `aundefined`.
  result = result.replace(/\bvoid 0\b/g, 'undefined');
  return result;
}

/**
 * Try deobfuscating JS with webcrack, with size limit and timeout.
 * Returns deobfuscated code or null on failure/timeout.
 */
export async function tryWebcrack(code) {
  if (code.length > WEBCRACK_MAX_SIZE) return null;
  const wc = await getWebcrack();
  if (!wc) return null;
  try {
    const result = await Promise.race([
      wc(code),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), WEBCRACK_TIMEOUT_MS)),
    ]);
    return result.code || null;
  } catch {
    return null;
  }
}


// ============================================================================
// Section 2: Name inference
//
// "Opaque" (obfuscated or too-short) function names get descriptive suffixes
// inferred from the most distinctive identifiers in their bodies, via:
//
//   isOpaqueName(name)      — gate: should this name be a rename candidate?
//   extractReadableIdents() — pull and TF-IDF-rank ident keywords from a body
//   inferAllNames(idx, …)   — the orchestration: walks the function index,
//                              picks 2-3 keywords per opaque function, returns
//                              a renameMap. Takes idx as a parameter — already
//                              DI-friendly, no `this` rebinding.
//
// Two stop-word sets keep the analysis honest:
//   _REAL_SHORT_NAMES       — English/CS short words (the, log, etc.) that
//                              isOpaqueName should NOT treat as opaque.
//   _TEMPLATE_SKIP_WORDS    — extractReadableIdents skips these because they
//                              appear in nearly every JS function and tell us
//                              nothing about purpose.
//   _IMPORT_LOCAL_BLOCKLIST — local-variable names that must NEVER receive an
//                              import-rename. Used by a CSI class method
//                              outside this file (re-exported for that
//                              import).
// ============================================================================

/** Common short real-word function/variable names that should NOT be renamed. */
const _REAL_SHORT_NAMES = new Set([
  // Common JS/TS names
  'fn', 'cb', 'el', 'ev', 'id', 'db', 'fs', 'os', 'io', 'rx', 'tx',
  'ok', 'on', 'up', 'go', 'do', 'is', 'to', 'of', 'or', 'as', 'at', 'by', 'if',
  'in', 'it', 'we', 'us', 'am', 'an',
  // Common English articles/pronouns/conjunctions that show up everywhere in
  // comments/docs. The case of `The` mattered because mermaid.min.js literally
  // names a graph-tree helper function `function The(...)`, which then
  // clobbered every `The` in every JSDoc comment in the index.
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'for', 'nor',
  'but', 'yet', 'so', 'be', 'been', 'being', 'was', 'were', 'are',
  'has', 'had', 'have', 'having', 'does', 'did', 'doing',
  'can', 'could', 'may', 'might', 'must', 'shall', 'should',
  'will', 'would', 'about', 'into', 'onto', 'upon', 'from',
  // Common real words used as identifiers
  'add', 'all', 'and', 'any', 'app', 'arg', 'arr', 'bin', 'bit', 'box', 'buf', 'bus',
  'can', 'cap', 'cfg', 'cmd', 'col', 'con', 'cwd', 'ctx', 'cur', 'def',
  'del', 'dev', 'dim', 'dir', 'doc', 'dom', 'dst', 'dup', 'end', 'env',
  'err', 'ext', 'fig', 'fix', 'fmt', 'gen', 'get', 'has', 'hex', 'hit',
  'hub', 'idx', 'img', 'inf', 'int', 'inv', 'ipc', 'job', 'jwt', 'key',
  'len', 'lib', 'log', 'low', 'map', 'max', 'mem', 'mid', 'min', 'mix',
  'msg', 'mut', 'net', 'nil', 'nop', 'not', 'now', 'num', 'obj', 'old',
  'opt', 'out', 'own', 'pad', 'pkg', 'pop', 'pos', 'pre', 'ptr', 'put',
  'raw', 'ref', 'reg', 'rem', 'req', 'res', 'ret', 'rev', 'row', 'run',
  'seq', 'set', 'sig', 'sin', 'src', 'str', 'sub', 'sum', 'sym', 'sys',
  'tab', 'tag', 'tmp', 'top', 'tpl', 'ttl', 'txt', 'uri', 'url', 'use',
  'usr', 'val', 'var', 'vec', 'ver', 'via', 'win', 'zip',
  // Longer but still common real words (3-6 chars, all lowercase)
  'area', 'args', 'auth', 'auto', 'back', 'base', 'bind', 'blob',
  'body', 'bold', 'boot', 'call', 'case', 'cast', 'char', 'chat',
  'clip', 'code', 'cold', 'copy', 'core', 'data', 'date', 'deep',
  'desc', 'diff', 'done', 'down', 'drop', 'dump', 'each', 'edge',
  'edit', 'emit', 'enum', 'eval', 'exec', 'exit', 'expr', 'fail',
  'fast', 'file', 'fill', 'find', 'fire', 'flag', 'flat', 'flip',
  'flow', 'font', 'fork', 'form', 'free', 'from', 'full', 'func',
  'glob', 'grid', 'grow', 'halt', 'hash', 'head', 'heap', 'help',
  'hide', 'high', 'hold', 'home', 'hook', 'host', 'html', 'icon',
  'idle', 'info', 'init', 'item', 'iter', 'join', 'json', 'jump',
  'keep', 'kill', 'kind', 'lang', 'last', 'late', 'lazy', 'left',
  'link', 'lint', 'list', 'load', 'lock', 'long', 'look', 'loop',
  'main', 'make', 'mark', 'mask', 'math', 'menu', 'meta', 'mime',
  'mode', 'mock', 'mono', 'more', 'move', 'much', 'must', 'mute',
  'name', 'next', 'node', 'none', 'norm', 'note', 'null', 'once',
  'only', 'open', 'over', 'pack', 'page', 'pair', 'pane', 'part',
  'pass', 'past', 'path', 'peer', 'pick', 'ping', 'pipe', 'plan',
  'play', 'plot', 'plug', 'poll', 'pool', 'port', 'post', 'prev',
  'prop', 'pull', 'pure', 'push', 'quit', 'race', 'rand', 'rank',
  'rate', 'read', 'real', 'redo', 'rich', 'ring', 'role', 'root',
  'rule', 'safe', 'save', 'scan', 'seed', 'seek', 'self', 'send',
  'show', 'shut', 'sign', 'sink', 'size', 'skip', 'slot', 'slow',
  'snap', 'sort', 'span', 'spec', 'spin', 'spot', 'star', 'stat',
  'step', 'stop', 'sync', 'tabs', 'tail', 'take', 'task', 'temp',
  'term', 'test', 'text', 'then', 'thin', 'this', 'tick', 'tier',
  'time', 'tiny', 'tool', 'tree', 'trim', 'true', 'turn', 'type',
  'uint', 'undo', 'unit', 'unix', 'uuid', 'void', 'wait', 'walk',
  'warn', 'wasm', 'weak', 'wide', 'will', 'with', 'word', 'work',
  'wrap', 'yaml', 'year', 'zero', 'zone',
  'abort', 'above', 'after', 'agent', 'alert', 'alias', 'align',
  'allow', 'apply', 'array', 'asset', 'async', 'await', 'batch',
  'begin', 'below', 'block', 'break', 'brush', 'build', 'cache',
  'catch', 'cause', 'chain', 'check', 'child', 'chunk', 'claim',
  'class', 'clean', 'clear', 'click', 'clone', 'close', 'codec',
  'color', 'const', 'count', 'cover', 'crash', 'cross', 'curve',
  'cycle', 'debug', 'defer', 'delay', 'delta', 'dense', 'depth',
  'dirty', 'draft', 'drain', 'drive', 'embed', 'empty', 'endow',
  'enter', 'equal', 'error', 'event', 'every', 'exact', 'extra',
  'fault', 'fetch', 'field', 'final', 'fixed', 'flags', 'flash',
  'float', 'floor', 'flush', 'focus', 'force', 'frame', 'fresh',
  'front', 'given', 'global','grace', 'graph', 'group', 'guard',
  'guest', 'guide', 'heart', 'heavy', 'hover', 'hyper', 'image',
  'index', 'inner', 'input', 'issue', 'label', 'large', 'later',
  'layer', 'level', 'light', 'limit', 'local', 'login', 'lower',
  'match', 'maybe', 'media', 'merge', 'micro', 'minor', 'mixed',
  'model', 'mount', 'mouse', 'multi', 'never', 'newer', 'nonce',
  'oauth', 'offer', 'order', 'other', 'outer', 'owner', 'panic',
  'parse', 'patch', 'pause', 'phase', 'pixel', 'place', 'plain',
  'point', 'popup', 'power', 'press', 'price', 'print', 'prior',
  'probe', 'proof', 'proto', 'proxy', 'pulse', 'query', 'queue',
  'quiet', 'quota', 'quote', 'radio', 'raise', 'range', 'ratio',
  'reach', 'ready', 'realm', 'regex', 'relay', 'renew', 'reply',
  'reset', 'retry', 'right', 'route', 'scene', 'scope', 'score',
  'serve', 'setup', 'shape', 'share', 'shell', 'shift', 'short',
  'since', 'slate', 'sleep', 'slice', 'slide', 'small', 'space',
  'stack', 'stage', 'stale', 'start', 'state', 'steel', 'still',
  'stock', 'store', 'strip', 'style', 'super', 'surge', 'sweep',
  'table', 'theme', 'thing', 'throw', 'timer', 'title', 'token',
  'total', 'touch', 'trace', 'track', 'train', 'trash', 'trial',
  'trick', 'tuple', 'union', 'until', 'upper', 'usage', 'using',
  'valid', 'value', 'video', 'visit', 'watch', 'water', 'wheel',
  'where', 'which', 'while', 'white', 'whole', 'width', 'write',
  'yield',
  'accept', 'action', 'active', 'anchor', 'append', 'assert',
  'assign', 'attach', 'before', 'binary', 'border', 'bottom',
  'branch', 'bridge', 'bucket', 'buffer', 'bundle', 'button',
  'cancel', 'canvas', 'change', 'client', 'closed', 'column',
  'commit', 'config', 'create', 'cursor', 'custom', 'daemon',
  'decode', 'define', 'delete', 'deploy', 'design', 'detect',
  'device', 'dialog', 'digest', 'direct', 'domain', 'double',
  'driver', 'enable', 'encode', 'engine', 'ensure', 'entity',
  'escape', 'except', 'expand', 'expect', 'export', 'extend',
  'fabric', 'factor', 'figure', 'filter', 'finder', 'finish',
  'format', 'frozen', 'global', 'handle', 'header', 'health',
  'height', 'hidden', 'ignore', 'import', 'inject', 'insert',
  'inside', 'intern', 'invoke', 'kernel', 'launch', 'layout',
  'legacy', 'length', 'listen', 'locale', 'locate', 'locked',
  'logger', 'lookup', 'manage', 'manual', 'mapper', 'margin',
  'marker', 'master', 'matrix', 'memory', 'method', 'middle',
  'mirror', 'module', 'native', 'nested', 'normal', 'notice',
  'notify', 'number', 'object', 'offset', 'online', 'opener',
  'option', 'origin', 'output', 'parent', 'passed', 'plugin',
  'policy', 'prefix', 'prompt', 'random', 'reader', 'record',
  'reduce', 'region', 'reload', 'remote', 'remove', 'render',
  'repeat', 'report', 'resize', 'resolve','result', 'resume',
  'return', 'revert', 'revoke', 'rotate', 'router', 'runner',
  'sample', 'scroll', 'search', 'secret', 'secure', 'select',
  'sender', 'server', 'shadow', 'signal', 'simple', 'single',
  'sizeof', 'socket', 'source', 'spread', 'square', 'stable',
  'static', 'status', 'stderr', 'stdout', 'stream', 'strict',
  'string', 'stroke', 'struct', 'submit', 'suffix', 'supply',
  'switch', 'symbol', 'syntax', 'system', 'target', 'thread',
  'toggle', 'typeof', 'unique', 'unlink', 'unlock', 'unpack',
  'unsafe', 'unused', 'update', 'upload', 'vendor', 'verify',
  'viewer', 'virtual','volume', 'walker', 'widget', 'window',
  'worker', 'writer',
]);

/**
 * Determine if a function name is "opaque" (obfuscated or too short to be meaningful).
 * Returns true if the name should be a candidate for renaming.
 */
export function isOpaqueName(name) {
  if (!name || name.length === 0) return false;
  // Strip class qualifier for analysis
  const bare = name.includes('::') ? name.split('::').pop() : name;
  // Strip @linenum suffix
  const clean = bare.includes('@') ? bare.split('@')[0] : bare;
  // Skip very short names (1-2 chars) — too collision-prone for safe replacement
  if (clean.length <= 2) return false;
  // Already has an inferred suffix?
  if (/_KW_/.test(clean)) return false;
  // Is a known real word / common identifier?
  if (_REAL_SHORT_NAMES.has(clean.toLowerCase())) return false;
  // Has camelCase with 4+ leading lowercase (readable name)
  if (/^[a-z]{4,}[A-Z]/.test(clean)) return false;
  // PascalCase with 4+ chars (readable class/constructor name)
  if (/^[A-Z][a-z]{3,}/.test(clean)) return false;
  // snake_case with readable words (each part 3+ chars)
  if (/^[a-z]{3,}_[a-z]{3,}/.test(clean)) return false;
  // ALL_CAPS with underscores — likely a constant (SOME_CONSTANT)
  if (/^[A-Z][A-Z0-9_]{3,}$/.test(clean)) return false;
  // Long name (>8 chars) that contains lowercase — probably meaningful enough
  if (clean.length > 8 && /[a-z]/.test(clean)) return false;
  // All lowercase 3+ chars — could be a real word not in our list, be conservative
  if (/^[a-z]{3,}$/.test(clean)) return false;
  // Short or cryptic name — candidate for renaming
  return true;
}

/** Common/generic identifiers to skip when picking distinctive keywords.
 *  These appear in nearly every function and tell you nothing about purpose. */
const _TEMPLATE_SKIP_WORDS = new Set([
  // JS keywords and builtins
  'this', 'self', 'that', 'null', 'undefined', 'true', 'false',
  'return', 'function', 'class', 'const', 'let', 'var', 'new', 'delete',
  'typeof', 'instanceof', 'void', 'yield', 'await', 'async', 'import', 'export',
  // Type names (appear in typeof/instanceof checks, not domain logic)
  'object', 'string', 'number', 'boolean', 'symbol', 'bigint', 'array',
  'Object', 'String', 'Number', 'Boolean', 'Array', 'Symbol', 'BigInt',
  'Function', 'RegExp', 'Date', 'Error', 'Promise', 'Proxy', 'Reflect',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'WeakRef',
  // Generic property/method names
  'length', 'size', 'index', 'value', 'name', 'type', 'data', 'item',
  'result', 'error', 'message', 'code', 'status', 'state', 'config',
  'input', 'output', 'args', 'params', 'options', 'callback',
  'push', 'pop', 'slice', 'join', 'split', 'trim', 'replace',
  'forEach', 'filter', 'map', 'reduce', 'find', 'some', 'every',
  'keys', 'values', 'entries', 'toString', 'constructor', 'prototype',
  'apply', 'call', 'bind', 'then', 'catch', 'finally',
  'get', 'set', 'has', 'add', 'remove', 'clear', 'init',
  // Object/prototype plumbing
  'hasOwnProperty', 'propertyIsEnumerable', 'isPrototypeOf', 'valueOf',
  'defineProperty', 'getOwnPropertyDescriptor', 'getOwnPropertyNames',
  'getPrototypeOf', 'setPrototypeOf', 'isArray', 'isFinite', 'isNaN',
  'freeze', 'assign', 'create', 'from', 'stringify', 'parse',
  'configurable', 'enumerable', 'writable',
  // Per-language stop-words closing the gap TF-IDF can't fully bridge.
  // These are ubiquitous-within-their-domain words where #3's IDF penalty
  // alone is insufficient because the target functions have nothing else
  // lexically distinctive:
  //   lodash internals: _data_ / __data__ storage, returntrue/returnfalse
  //                     helpers (bundled lodash emits these lowercased, not
  //                     as camelCase — we list both defensively).
  //   Java modifiers:   public / private / protected
  //   C/BSD typedefs:   u_char, u_int, u_long, u_short, register
  //   JS pragma:        strict (from "use strict")
  '_data_', '__data__',
  'returnTrue', 'returnFalse', 'returntrue', 'returnfalse',
  'public', 'private', 'protected',
  'u_char', 'u_int', 'u_long', 'u_short', 'register',
  // BSD size-suffixed typedefs — the `u_int` entry above only matches exactly,
  // not `u_int32_t` etc, which dominate NetBSD byte-twiddling function bodies
  // (expm1_KW_U_INT32_T_HIGH_HUGE surfaced during Spinellis bookends testing).
  'u_int8_t', 'u_int16_t', 'u_int32_t', 'u_int64_t',
  // `static` surfaced as __dberr_KW_STATIC_N in tight C helpers with nothing
  // else lexically distinctive in the body.
  'static',
  'strict',
]);

/**
 * Local-variable names that must NEVER receive a global import-rename, even
 * if they appear unambiguously in a destructured import. These are JS/DOM
 * built-ins, regex match properties, and other ubiquitous identifiers whose
 * meaning is fixed by the language — globally rewriting `m.index` →
 * `m.index_IMPORT_TARGET` is corrupting, not informative.
 *
 * #7: prevents the import-rename leakage from minified bundles into
 * hand-written code in the same index.
 *
 * Exported because a CSI class method (the import-rename pass) checks this
 * set directly — it's name-inference territory thematically but is consumed
 * from outside this file.
 */
export const _IMPORT_LOCAL_BLOCKLIST = new Set([
  // RegExp match-result properties
  'index', 'input', 'groups', 'lastIndex',
  // Array / iterable methods + properties
  'find', 'filter', 'map', 'reduce', 'forEach', 'some', 'every',
  'includes', 'indexOf', 'lastIndexOf', 'concat', 'slice', 'splice',
  'sort', 'reverse', 'flat', 'flatMap', 'fill', 'copyWithin',
  'length', 'first', 'last',
  // Iterator protocol
  'next', 'done', 'value', 'return', 'throw',
  // String methods
  'charAt', 'charCodeAt', 'codePointAt', 'startsWith', 'endsWith',
  'padStart', 'padEnd', 'trim', 'split', 'replace', 'match',
  // JS globals and console methods — `console` being clobbered is extra
  // damaging because it blows up every call site like `console.log(...)`.
  'console', 'log', 'warn', 'info', 'debug', 'trace',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'require', 'module', 'exports', 'global', 'globalThis', 'window', 'document',
  // DOM/event ubiquity
  'name', 'type', 'data', 'target', 'event', 'item', 'node', 'key',
  'parent', 'child', 'children', 'sibling', 'root', 'next', 'prev',
  // CSS / geometry property names — CSS files get clobbered when these
  // names have import renames (e.g. `margin-left: ...` becomes
  // `margin-left_IMPORT_ALIGN: ...`).
  'left', 'right', 'top', 'bottom', 'width', 'height',
  'color', 'font', 'margin', 'padding', 'border', 'background',
  'align', 'display', 'position', 'cursor',
  // Generic/everywhere
  'result', 'state', 'config', 'options', 'args', 'props', 'context',
  'message', 'error', 'status', 'method', 'path', 'url', 'host', 'port',
  'src', 'dest', 'from', 'into', 'count', 'size', 'total', 'code',
  'first', 'last', 'min', 'max', 'sum', 'mean', 'start', 'end',
  // Universal local-variable names — used in nearly every function
  'msg', 'str', 'num', 'val', 'obj', 'arr', 'res', 'req', 'ctx', 'tmp',
  'row', 'col', 'tag', 'len', 'pos', 'cnt', 'buf', 'raw', 'txt', 'fn', 'cb',
  // Lifecycle / I/O
  'open', 'close', 'init', 'load', 'save', 'send', 'recv', 'read', 'write',
]);

/** Convert camelCase to SCREAMING_SNAKE_CASE. */
export function camelToScreamingSnake(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/**
 * Extract readable identifiers from a function body.
 * Returns array of { ident, score } sorted by distinctiveness.
 * "Readable" = camelCase/snake_case, 4+ chars, not a keyword/generic.
 *
 * @param {string} bodyText
 * @param {object} [opts]
 * @param {Map<string,number>} [opts.globalDocFreq]  ident → number of functions
 *   containing this ident across the whole codebase. When provided, the
 *   per-function score is multiplied by an IDF-style penalty so ubiquitous
 *   keywords (STRICT, PUBLIC, REGISTER, ARGUMENTS, etc.) lose their leading
 *   position naturally — without needing per-language stop-word lists.
 * @param {number} [opts.totalDocs] total renamable function count (denominator
 *   for the IDF computation). Required alongside globalDocFreq.
 */
export function extractReadableIdents(bodyText, opts = {}) {
  const identRe = /[a-zA-Z_$][\w$]*/g;
  const counts = new Map();
  let m;
  while ((m = identRe.exec(bodyText)) !== null) {
    const id = m[0];
    if (id.length < 4) continue;
    if (_TEMPLATE_SKIP_WORDS.has(id)) continue;
    // Must look like a readable name: has lowercase, not ALL_CAPS short
    if (!/[a-z]/.test(id)) continue;
    // Skip obfuscated-looking names (1-3 chars followed by digits)
    if (/^[a-zA-Z_$]{1,3}\d/.test(id)) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }

  const { globalDocFreq, totalDocs } = opts;
  const useIdf = globalDocFreq && totalDocs && totalDocs > 0;

  // Score: longer names are more distinctive, repeated names are more characteristic
  const scored = [];
  for (const [ident, count] of counts) {
    // Bonus for underscore prefix (likely a private member name = very descriptive)
    const privatBonus = ident.startsWith('_') ? 1.5 : 1.0;
    // Bonus for camelCase complexity (more words = more specific)
    const words = ident.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[\s_]+/).length;
    let score = count * Math.sqrt(ident.length) * privatBonus * Math.sqrt(words);

    // #3: IDF penalty. log(totalDocs / df) — classic IDF formula.
    // df=1 (unique to this function) → log(N) = strong boost.
    // df=N (everywhere) → log(1) = 0 → score → 0.
    // We add 1 to denominator and use log(1+ratio) to keep things bounded for
    // ubiquitous-but-not-quite-everywhere terms.
    if (useIdf) {
      const df = globalDocFreq.get(ident) || 1;
      const idf = Math.log(1 + (totalDocs / df));
      score *= idf;
    }

    scored.push({ ident, score, count });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Infer descriptive names for ALL opaque-named functions by extracting
 * the most distinctive readable identifiers from their bodies.
 *
 * Works on any codebase — not limited to minified code. Any function with
 * a short/cryptic name gets keywords from its body appended as a suffix.
 *
 * @param {CodeSearchIndex} idx - index with fileLines and functionIndex loaded
 * @returns {{ renameMap: Object<string,string>, count: number }}
 */
export function inferAllNames(idx, { minFuncLines = 0 } = {}) {
  const renameMap = Object.create(null);
  const usedNames = new Map(); // baseName -> count (for collision handling)

  idx._ensureFunctionIndex();
  if (!idx.functionIndex) return { renameMap, count: 0 };

  // ----------------------------------------------------------------------
  // PRE-PASS A: per-bare-name uniqueness count, for #1 bare-name fallback.
  //
  // We'll add a bare-name entry (e.g. '_pyAdd' → '_pyAdd_KW_…') ONLY when
  // the bare name appears in exactly one function-index entry across the
  // whole codebase. If two classes both have a bare 'clear' method, we
  // can't safely add a global bare entry.
  // ----------------------------------------------------------------------
  const bareNameCounts = new Map();
  for (const [, funcs] of Object.entries(idx.functionIndex)) {
    for (const fname of Object.keys(funcs)) {
      let bare = fname.includes('::') ? fname.split('::').pop() : fname;
      if (bare.includes('@')) bare = bare.split('@')[0];
      bareNameCounts.set(bare, (bareNameCounts.get(bare) || 0) + 1);
    }
  }

  // ----------------------------------------------------------------------
  // PRE-PASS B: global keyword frequency, for #3 TF-IDF penalty.
  //
  // For each renamable function, extract its candidate idents and count
  // how many distinct functions each ident appears in. Used by
  // extractReadableIdents (via globalDocFreq) to penalize ubiquitous
  // keywords (STRICT, PUBLIC, REGISTER, ARGUMENTS, etc.) without zeroing
  // them — a keyword that's strong locally still survives.
  // ----------------------------------------------------------------------
  const globalDocFreq = new Map(); // ident -> # of functions containing it
  let totalRenamableFns = 0;
  for (const [filepath, funcs] of Object.entries(idx.functionIndex)) {
    for (const [funcName, info] of Object.entries(funcs)) {
      if (!isOpaqueName(funcName)) continue;
      const lines = idx.fileLines.get(filepath);
      if (!lines) continue;
      // #4: skip short functions below --rename-min-lines threshold
      const lineCount = info.end - info.start + 1;
      if (minFuncLines > 0 && lineCount <= minFuncLines) continue;
      const bodyLines = lines.slice(info.start - 1, info.end);
      if (bodyLines.length === 0) continue;
      const bodyText = bodyLines.join('\n');
      // Use the unscored extractor to get the ident set for this function
      const idents = extractReadableIdents(bodyText);
      if (idents.length === 0) continue;
      totalRenamableFns++;
      for (const { ident } of idents) {
        globalDocFreq.set(ident, (globalDocFreq.get(ident) || 0) + 1);
      }
    }
  }

  // ----------------------------------------------------------------------
  // MAIN PASS: pick keywords, build renames.
  // ----------------------------------------------------------------------
  for (const [filepath, funcs] of Object.entries(idx.functionIndex)) {
    for (const [funcName, info] of Object.entries(funcs)) {
      if (!isOpaqueName(funcName)) continue;

      const lines = idx.fileLines.get(filepath);
      if (!lines) continue;

      // #4: skip short functions below --rename-min-lines threshold
      const lineCount = info.end - info.start + 1;
      if (minFuncLines > 0 && lineCount <= minFuncLines) continue;

      const bodyLines = lines.slice(info.start - 1, info.end);
      if (bodyLines.length === 0) continue;
      const bodyText = bodyLines.join('\n');

      // #3: pass globalDocFreq so extractReadableIdents can apply IDF penalty
      let idents = extractReadableIdents(bodyText, { globalDocFreq, totalDocs: totalRenamableFns });
      if (idents.length === 0) continue;

      // #2: self-referential keyword filter — drop candidates whose
      // SCREAMING_SNAKE form equals (or substantially overlaps) the function's
      // bare name. Kills getName_KW_GET_NAME, toMarkup_KW_TO_MARKUP, etc.
      let bareForFilter = funcName.includes('::') ? funcName.split('::').pop() : funcName;
      bareForFilter = bareForFilter.replace(/@\d+$/, '').replace(/^_+/, '');
      const bareSnake = camelToScreamingSnake(bareForFilter);
      const SUBSTR_MIN = 4;
      idents = idents.filter(({ ident }) => {
        const cleanIdent = ident.startsWith('_') ? ident.replace(/^_+/, '') : ident;
        const identSnake = camelToScreamingSnake(cleanIdent);
        if (identSnake === bareSnake) return false;
        if (bareSnake.length >= SUBSTR_MIN && identSnake.includes(bareSnake)) return false;
        if (identSnake.length >= SUBSTR_MIN && bareSnake.includes(identSnake)) return false;
        return true;
      });
      if (idents.length === 0) continue;

      // Pick 2 keywords for small/medium functions, 3 for large.
      const numKeywords = bodyLines.length > 50 ? 3 : 2;
      const topIdents = idents.slice(0, numKeywords).map(i => i.ident);

      // Convert to SCREAMING_SNAKE, truncate each keyword part
      const parts = topIdents.map(id => {
        let clean = id.startsWith('_') ? id.slice(1) : id;
        let screaming = camelToScreamingSnake(clean);
        // Truncate at word boundary within 20 chars
        if (screaming.length > 20) {
          const cut = screaming.lastIndexOf('_', 20);
          screaming = cut > 2 ? screaming.slice(0, cut) : screaming.slice(0, 20);
        }
        return screaming;
      });
      let baseName = 'KW_' + parts.join('_');

      // Truncate whole name at word boundary within 40 chars
      if (baseName.length > 40) {
        const cut = baseName.lastIndexOf('_', 40);
        baseName = cut > 3 ? baseName.slice(0, cut) : baseName.slice(0, 40);
      }

      // Handle collisions: append _2, _3, etc.
      const prevCount = usedNames.get(baseName) || 0;
      usedNames.set(baseName, prevCount + 1);
      const suffix = prevCount > 0 ? `_${prevCount + 1}` : '';

      renameMap[funcName] = funcName + '_' + baseName + suffix;
    }
  }

  // ----------------------------------------------------------------------
  // POST-PASS: #1 bare-name fallback for class methods.
  //
  // For each qualified rename map entry (Class::method) where the bare name
  // is unique across the whole function index, also store a bare entry that
  // applyRenames can match against bare references in source/line text.
  // Strips the 'Class::' prefix from the display name for the bare entry.
  // ----------------------------------------------------------------------
  for (const qkey of Object.keys(renameMap)) {
    if (!qkey.includes('::')) continue;
    let bare = qkey.split('::').pop();
    if (bare.includes('@')) bare = bare.split('@')[0];
    if (bareNameCounts.get(bare) !== 1) continue;
    if (Object.prototype.hasOwnProperty.call(renameMap, bare)) continue;
    // Strip the 'Class::' prefix from the display name
    const display = renameMap[qkey];
    const bareDisplay = display.includes('::') ? display.split('::').pop() : display;
    // Also strip any @line suffix that might be embedded
    renameMap[bare] = bareDisplay.replace(/@\d+/, '');
  }

  return { renameMap, count: Object.keys(renameMap).length };
}


// ============================================================================
// Section 3: String-state scanning
//
// JS-aware state machine that tracks string/comment context within and across
// lines. Used by rename application, literal search, and comment-injection
// passes to avoid mistakenly rewriting matches that sit inside strings or
// comments. Cross-line state is observable so callers can carry it forward
// through a file scan.
// ============================================================================

/**
 * Check if a position in a line is inside a string literal (single, double, or backtick).
 * Simple state-machine approach — doesn't handle escaped quotes perfectly but good enough.
 */
/**
 * Walk a line through a JS-aware state machine, tracking string and comment
 * context. Returns the state at position `endPos` (or end of line if -1).
 *
 * States:
 *   - 'code' — normal JS code
 *   - 's'    — single-quoted string  '...'
 *   - 'd'    — double-quoted string  "..."
 *   - 't'    — template literal      `...`  (with ${} re-entering code via stack)
 *   - 'lc'   — line comment          // ... to end of line
 *   - 'bc'   — block comment         (slash-star ... star-slash, can span lines)
 *
 * Cross-line state: callers can pass `startState` of 'bc' or 't' to indicate
 * the line begins inside a block comment or template literal carried over
 * from the previous line. The end state is observable via _scanLineEndState.
 *
 * #10: comment tracking lets applyRenames/searchLiteral skip matches inside
 * `// foo` and block-comment regions.
 */
export function _scanLineState(line, startState, endPos) {
  let state = startState || 'code';
  const stack = []; // template-literal re-entry stack for ${...}
  const N = endPos == null || endPos < 0
    ? line.length
    : Math.min(endPos, line.length);

  for (let i = 0; i < N; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    // Escape handling lives inside each string state below (the `ch === '\\'`
    // skips). A lone look-back at `prev === '\\'` can't distinguish an escaped
    // backslash `\\` from an escaping one, so `"C:\\"` (a Windows path literal)
    // wedged the scanner open past the real closing quote. #251
    if (state === 'code') {
      if (ch === '/' && next === '/')      { state = 'lc'; i++; }
      else if (ch === '/' && next === '*') { state = 'bc'; i++; }
      else if (ch === "'")                 { state = 's'; }
      else if (ch === '"')                 { state = 'd'; }
      else if (ch === '`')                 { state = 't'; }
      else if (ch === '}' && stack.length > 0) state = stack.pop();
    } else if (state === 's') {
      if (ch === '\\') i++;                 // escape: consume the next char
      else if (ch === "'") state = 'code';
    } else if (state === 'd') {
      if (ch === '\\') i++;
      else if (ch === '"') state = 'code';
    } else if (state === 't') {
      if (ch === '\\') i++;
      else if (ch === '`') state = 'code';
      else if (ch === '$' && next === '{') {
        // Enter ${} interpolation: push template state, switch to code
        stack.push('t');
        state = 'code';
        i++; // consume the '{'
      }
    } else if (state === 'bc') {
      if (ch === '*' && next === '/') { state = 'code'; i++; }
    } else if (state === 'lc') {
      // Line comment runs to end of line — no transitions
    }
  }
  return state;
}

/**
 * Returns true if `pos` in `line` is inside a string literal OR comment.
 * (Used by applyRenames and searchLiteral to skip those matches.)
 *
 * @param {string} line
 * @param {number} pos
 * @param {string} [startState='code']  pass 'bc' or 't' if the line begins
 *   inside a block comment or template literal carried from the prior line.
 */
export function _isInsideString(line, pos, startState = 'code') {
  return _scanLineState(line, startState, pos) !== 'code';
}

/** Helper: add a string occurrence to the string table map. */
export function _addString(strings, value, filepath, lineNum, funcName) {
  if (!strings[value]) {
    strings[value] = { count: 0, files: 0, _fileSet: new Set(), locations: [] };
  }
  const entry = strings[value];
  entry.count++;
  if (!entry._fileSet.has(filepath)) {
    entry._fileSet.add(filepath);
    entry.files = entry._fileSet.size;
  }
  // Cap stored locations to avoid huge entries
  if (entry.locations.length < 20) {
    entry.locations.push({ filepath, line: lineNum, func: funcName || null });
  }
}


// ============================================================================
// Section 4: Command-gate classifier
//
// Standalone helper used by the command-catalog renderer to classify the
// `isEnabled:` expression of each command entry into one of several known
// gate kinds (default / always / never / flag / env / ref / complex). The
// classifier is regex-based since the expressions we care about are
// stylistically narrow (always a 0-arg arrow returning a small expression).
// ============================================================================

/**
 * Classify the activation gate of a command-catalog entry from its
 * `isEnabled:` value (or null if the field is absent). Returns a gate
 * object with `kind` plus pattern-specific fields. Currently recognized:
 *
 *   { kind: "default" }                      — no isEnabled field present
 *   { kind: "always" }                       — `() => true`
 *   { kind: "never" }                        — `() => false`  (hard-disabled)
 *   { kind: "flag", flag, default, expr }    — `() => HELPER("flag", default)`
 *                                              recognized helpers: jA, Jw, ZH
 *                                              (cli.js style; configurable
 *                                              per-codebase planned for #359)
 *   { kind: "env", envVar, expr }            — references `process.env.NAME`
 *   { kind: "ref", expr }                    — bare identifier reference
 *   { kind: "complex", expr }                — anything else
 *
 * The `expr` field always carries the raw expression so a reader can
 * inspect what wasn't classified. Callers (catalog rendering, latent-code
 * detection #358) use `kind` for grouping and `flag`/`envVar` for filters.
 */
export function _classifyCommandGate(rawExpr) {
  if (rawExpr == null) return { kind: 'default' };
  const expr = rawExpr.replace(/\s+/g, ' ').trim();
  if (!expr) return { kind: 'default' };

  // () => true / () => false  — the canonical always/never forms.
  if (/^\(\s*\)\s*=>\s*true\b/.test(expr)) return { kind: 'always' };
  if (/^\(\s*\)\s*=>\s*false\b/.test(expr)) return { kind: 'never' };

  // () => HELPER("flag", default?) — flag-gated. We accept any helper
  // identifier rather than a fixed list because cli.js uses different
  // helpers (jA, Jw) and other codebases will use yet others. The
  // semantics — flag name as first arg, optional default — are the
  // common shape across most feature-flag clients.
  let m = expr.match(/^\(\s*\)\s*=>\s*\w+\(\s*["']([\w_.-]+)["']\s*(?:,\s*([^)]+?))?\s*\)\s*$/);
  if (m) {
    return {
      kind: 'flag',
      flag: m[1],
      default: m[2] ? m[2].trim() : null,
      expr,
    };
  }

  // process.env.NAME reference (often negated for DISABLE_* flags).
  m = expr.match(/process\.env\.([A-Z_][A-Z0-9_]*)/);
  if (m) {
    return { kind: 'env', envVar: m[1], expr };
  }

  // Bare identifier — `isEnabled: someFn` or `isEnabled: someVar`.
  if (/^[A-Za-z_$][\w$]*$/.test(expr)) {
    return { kind: 'ref', expr };
  }

  return { kind: 'complex', expr };
}


// ============================================================================
// Section 5: Misc helpers (post-class group from original CSI.js)
//
// Originally sat at the bottom of CodeSearchIndex.js, after the class
// closing brace. Both are used from within class methods (escapeRegex is
// called dozens of times to build regex patterns; _computeTokenRelevance
// is part of the claim-search ranking pipeline).
// ============================================================================

export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * Compute relevance of a vocabulary sub-token to a set of claim keywords.
 *
 * Scoring levels (higher = more relevant):
 *   1.0  - exact match: vocab token === claim keyword
 *   0.8  - vocab token contains claim keyword or vice versa (substring)
 *          e.g., claim "search" matches vocab "searchLiteral" parts
 *   0.6  - shared stem: 4+ character common prefix
 *          e.g., claim "encrypted" matches vocab "encrypt"
 *   0.0  - no match
 *
 * Returns the highest relevance score across all claim keywords.
 *
 * @param {string} vocabToken - A single lowercase sub-token from vocabulary
 * @param {string[]} claimKeywords - Array of lowercase claim keywords
 * @returns {number} Relevance score 0.0 to 1.0
 */
export function _computeTokenRelevance(vocabToken, claimKeywords) {
  let best = 0;

  for (const kw of claimKeywords) {
    // Exact match
    if (vocabToken === kw) return 1.0;

    // Substring containment (either direction)
    if (vocabToken.length >= 3 && kw.length >= 3) {
      if (vocabToken.includes(kw) || kw.includes(vocabToken)) {
        best = Math.max(best, 0.8);
        continue;
      }
    }

    // Shared stem: common prefix of 4+ characters
    if (vocabToken.length >= 4 && kw.length >= 4) {
      let prefixLen = 0;
      const minLen = Math.min(vocabToken.length, kw.length);
      for (let i = 0; i < minLen; i++) {
        if (vocabToken[i] === kw[i]) prefixLen++;
        else break;
      }
      if (prefixLen >= 4) {
        best = Math.max(best, 0.6);
      }
    }
  }

  return best;
}
