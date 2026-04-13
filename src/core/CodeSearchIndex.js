/**
 * CodeSearchIndex.js - Core data structure for Code Exam.
 *
 * Holds indexed source code and provides methods for:
 * - Building/saving/loading indices (JSON-based, compatible with Python version)
 * - Literal, inverted-index, and regex search
 * - Function/class parsing (regex-based)
 * - Function extraction and listing
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
// Simple glob implementation using built-in modules (no external deps)
import { _globSync } from '../glob.js';
import { forEachEntry, openJSONFile, closeSource, parseValue, countLocations, valueSize } from '../json-stream.js';
import {
  SearchResult, DEFAULT_EXTENSIONS, TEXT_EXTENSIONS,
  ARCHIVE_EXTENSIONS, MEDIA_BINARY_EXTENSIONS, EXECUTABLE_EXTENSIONS,
  EXT_TO_LANG, displayName, eprint, eprogress, splitCompoundToken,
} from '../utils.js';
import { expandArchive, isSupportedArchive, createArchiveStats } from '../archive.js';
import { processBinary, BINSTRING_EXTENSIONS } from '../binstrings.js';
import { createRequire } from 'module';

// js-beautify: optional dependency for prettifying minified JS during indexing
let _jsBeautify = null;
try {
  const require = createRequire(import.meta.url);
  const mod = require('js-beautify');
  _jsBeautify = mod.js || mod;
} catch { /* not installed — skip prettification */ }

// webcrack: optional dependency for JS deobfuscation during indexing
// Loaded lazily on first use (async import) since createRequire doesn't work for ESM-only packages
let _webcrack = undefined;  // undefined = not yet loaded, null = failed to load
async function getWebcrack() {
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
function isMinified(relPath, content) {
  if (/\.min\.(js|css|jsx|ts|tsx)$/i.test(relPath)) return true;
  if (!/\.(js|css|jsx|ts|tsx)$/i.test(relPath)) return false;
  const lines = content.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) return false;
  const avgLen = content.length / lines.length;
  // Minified: very few lines with very long average, OR high average line length
  // (Typical readable code: avg 30-60 chars. Minified: 500+. Semi-minified bundles: 200+)
  return avgLen > 500;
}

/**
 * Simple regex-based deobfuscation transforms for minified JS/TS.
 * No AST needed — these patterns are unambiguous in JS syntax.
 * Applied BEFORE js-beautify formatting.
 */
function deobfuscateSimple(code) {
  let result = code;
  // !0 → true, !1 → false (safe: these are always boolean in JS)
  result = result.replace(/!0\b/g, 'true');
  result = result.replace(/!1\b/g, 'false');
  // void 0 → undefined (safe: void 0 is always undefined in JS)
  result = result.replace(/void 0\b/g, 'undefined');
  return result;
}

/**
 * Infer descriptive names for simple obfuscated functions (getters, setters, wrappers).
 * Scans prettified code for patterns like:
 *   function wI1() { return x1.costCounter }        → wI1_GET_COST_COUNTER
 *   function th1() { return x1.hasUnknownModelCost } → th1_HAS_UNKNOWN_MODEL_COST
 *   function YQq() { x1.totalCost = 0 }             → YQq_SET_TOTAL_COST
 *   function Zq(a) { return a.doThing() }            → Zq_CALL_DO_THING
 *
 * Returns { renamedCode, renameMap, count } where renameMap is { oldName: newName }.
 * Applies renames to the full code content so all references update.
 */
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
function isOpaqueName(name) {
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
 *   - 'bc'   — block comment         /* ... *\/ (can span multiple lines)
 *
 * Cross-line state: callers can pass `startState` of 'bc' or 't' to indicate
 * the line begins inside a block comment or template literal carried over
 * from the previous line. The end state is observable via _scanLineEndState.
 *
 * #10: comment tracking lets applyRenames/searchLiteral skip matches inside
 * `// foo` and `/* foo *\/` regions.
 */
function _scanLineState(line, startState, endPos) {
  let state = startState || 'code';
  const stack = []; // template-literal re-entry stack for ${...}
  const N = endPos == null || endPos < 0
    ? line.length
    : Math.min(endPos, line.length);

  for (let i = 0; i < N; i++) {
    const ch = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';
    const prev = i > 0 ? line[i - 1] : '';
    // Backslash escape only matters inside string-like states
    if (prev === '\\' && (state === 's' || state === 'd' || state === 't')) continue;

    if (state === 'code') {
      if (ch === '/' && next === '/')      { state = 'lc'; i++; }
      else if (ch === '/' && next === '*') { state = 'bc'; i++; }
      else if (ch === "'")                 { state = 's'; }
      else if (ch === '"')                 { state = 'd'; }
      else if (ch === '`')                 { state = 't'; }
      else if (ch === '}' && stack.length > 0) state = stack.pop();
    } else if (state === 's') {
      if (ch === "'") state = 'code';
    } else if (state === 'd') {
      if (ch === '"') state = 'code';
    } else if (state === 't') {
      if (ch === '`') state = 'code';
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
function _isInsideString(line, pos, startState = 'code') {
  return _scanLineState(line, startState, pos) !== 'code';
}

/** Helper: add a string occurrence to the string table map. */
function _addString(strings, value, filepath, lineNum, funcName) {
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

/** Convert camelCase to SCREAMING_SNAKE_CASE. */
function camelToScreamingSnake(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
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
 */
const _IMPORT_LOCAL_BLOCKLIST = new Set([
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
function extractReadableIdents(bodyText, opts = {}) {
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

// ============================================================================
// Bundle-seam detection (#330)
//
// Minified JS bundles from esbuild/webpack/etc. wrap each original source
// module in a compact helper pattern. For esbuild this is the "lazy factory"
// idiom, e.g.:
//
//   var E = (A, q) => () => (A && (q = A(A = 0)), q);             // ESM helper
//   var C = (A, q) => () => (q || A((q = {exports: {}}).exports,  // CJS helper
//                                     q), q.exports);
//   var Dh1 = E(() => { ... });               // one module
//   var JL  = E(() => { ... });               // another module
//   var fA6 = E(() => { ... });               // ...
//
// Two pattern families supported:
//   - esbuild-flat: helpers and modules at column 0 (claude-code's cli.js)
//   - esbuild-iife: everything wrapped in a top-level IIFE so helpers and
//                   modules are indented inside (mermaid.min.js)
//
// Shape-based helper detection (not name-based) makes this robust across
// different bundle outputs where helpers are named E/C, I/Jt, etc.
// ============================================================================

/**
 * Detect ESM and CJS module-wrapper helper names by scanning the top of the
 * file for their distinctive memoization signatures:
 *   ESM: (X && (Y = X(X = 0)), Y)       — memoizes factory result into Y
 *   CJS: (Y = {exports: {}}).exports    — initializes CJS exports object
 *
 * The helper NAMES vary per bundle but the SHAPES are consistent. Returns
 * { esm, cjs, iifeStartLine } where iifeStartLine > 0 indicates the bundle
 * wraps everything in a top-level IIFE.
 *
 * Scans the first 200 lines as a joined string (whitespace-normalized) so
 * helper declarations that span multiple lines in the minified output are
 * still caught.
 */
function _detectBundleHelpers(lines) {
  const helpers = { esm: null, cjs: null, iifeStartLine: -1 };
  const N = Math.min(200, lines.length);
  // Keep whitespace so `\b` word boundaries work — the normalized-string
  // approach caused `var E =` to capture as `varE` when the regex engine
  // started matching at position 0.
  const head = lines.slice(0, N).join('\n');

  // ESM shape: NAME = (X, Y) => () => (X && (Y = X(X = 0)), Y)
  // Distinctive substring: the `Y = X(X = 0)` memoization kernel.
  const esmRe = /\b(\w+)\s*=\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\(\s*\)\s*=>\s*\(\s*\w+\s*&&\s*\(\s*\w+\s*=\s*\w+\s*\(\s*\w+\s*=\s*0\s*\)/;
  const esmMatch = head.match(esmRe);
  if (esmMatch && esmMatch[1] !== 'var' && esmMatch[1] !== 'let' && esmMatch[1] !== 'const') {
    helpers.esm = esmMatch[1];
  }

  // CJS shape: NAME = (X, Y) => () => (Y || X((Y = {exports: {}}).exports, Y), Y.exports)
  // The `Y || X((Y = {exports:{}}` kernel is distinctive and specific enough
  // to not accidentally bridge across two adjacent helper declarations (the
  // ESM kernel uses `&&` and has no `{exports:{}}`, so the alternation/
  // initialization pair only appears in CJS helpers).
  const cjsRe = /\b(\w+)\s*=\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\(\s*\)\s*=>\s*\(\s*\w+\s*\|\|\s*\w+\s*\(\s*\(?\s*\w+\s*=\s*\{\s*exports\s*:\s*\{\s*\}\s*\}/;
  const cjsMatch = head.match(cjsRe);
  if (cjsMatch && cjsMatch[1] !== 'var' && cjsMatch[1] !== 'let' && cjsMatch[1] !== 'const') {
    helpers.cjs = cjsMatch[1];
  }

  // Outer IIFE detection — mermaid.min.js starts with something like
  //   (__esbuild_esm_mermaid_nm ||= {}).mermaid = (() => {
  // or the plain form:
  //   (() => { ... })();
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const norm = (lines[i] || '').replace(/\s+/g, '');
    if (
      /\|\|=\{\}\)\.\w+=\(\(\)=>\{/.test(norm) ||
      /^\(\(\)=>\{/.test(norm) ||
      /^\(\([^)]*\)=>\{/.test(norm)
    ) {
      helpers.iifeStartLine = i + 1;
      break;
    }
  }

  return helpers;
}

/**
 * Walk forward from a wrapper's opening line, tracking JS state (strings,
 * templates, comments) via the same machine used in _scanLineState but doing
 * brace counting in the 'code' state. Returns the 1-indexed line where the
 * matching `}` of the arrow-function body appears.
 *
 * Used by detectBundleSeams to find the real end of each `var X = E(()=>{…})`
 * module wrapper. The sibling rule (end = nextSibling.start - 1) was wrong
 * because esbuild interleaves module-scope `var` decls between wrappers and
 * sometimes emits unrelated top-level code between them; we need the actual
 * closing `}` to bound each wrapper tightly.
 *
 * Doesn't handle regex literals (a `/.../` containing `{` or `}` could
 * miscount). In practice rare inside esbuild wrappers since wrappers are
 * structured as var/function/class declarations. Accepted limitation.
 */
function _findWrapperEnd(lines, startLineIdx) {
  let state = 'code';
  let braceDepth = 0;
  let foundOpenBrace = false;

  for (let i = startLineIdx; i < lines.length; i++) {
    const line = lines[i] || '';
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = j + 1 < line.length ? line[j + 1] : '';
      const prev = j > 0 ? line[j - 1] : '';

      // Backslash escape only matters inside string-like states
      if (prev === '\\' && (state === 's' || state === 'd' || state === 't')) continue;

      if (state === 'code') {
        if (ch === '/' && next === '/') { state = 'lc'; j++; continue; }
        if (ch === '/' && next === '*') { state = 'bc'; j++; continue; }
        if (ch === "'") { state = 's'; continue; }
        if (ch === '"') { state = 'd'; continue; }
        if (ch === '`') { state = 't'; continue; }
        if (ch === '{') {
          braceDepth++;
          foundOpenBrace = true;
        } else if (ch === '}') {
          braceDepth--;
          if (foundOpenBrace && braceDepth === 0) {
            return i + 1; // 1-indexed end line
          }
        }
      } else if (state === 's') {
        if (ch === "'") state = 'code';
      } else if (state === 'd') {
        if (ch === '"') state = 'code';
      } else if (state === 't') {
        if (ch === '`') state = 'code';
        // Template-literal ${} interpolation is NOT tracked for brace counting.
        // This could theoretically miscount but is rare in module wrappers.
      } else if (state === 'bc') {
        if (ch === '*' && next === '/') { state = 'code'; j++; continue; }
      }
    }
    // Line comments end at line boundary
    if (state === 'lc') state = 'code';
  }
  // Unmatched — fall back to end of file
  return lines.length;
}

/**
 * Extract a "preview" line from inside a module body — the first line that's
 * likely to tell you what the module is about. Skips trivial stuff (var
 * declarations at top, "use strict", closing braces, pure punctuation).
 */
function _extractModulePreview(lines, startIdx, endIdx) {
  const maxScan = Math.min(startIdx + 25, endIdx + 1, lines.length);
  let fallback = null;
  for (let i = startIdx + 1; i < maxScan; i++) {
    const line = lines[i] || '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Trivial lines to skip
    if (/^["']use strict["'];?$/.test(trimmed)) continue;
    if (/^[{}(),;]+\s*$/.test(trimmed)) continue;
    if (/^var\s+\w+(\s*,\s*\w+)*\s*;?\s*$/.test(trimmed)) continue; // `var x, y, z;`
    if (fallback === null) fallback = trimmed;
    // Prefer lines with function definitions or distinctive content
    if (
      /\bfunction\s+\w+/.test(trimmed) ||
      /^\w+\s*=\s*function/.test(trimmed) ||
      /["'][\w.\-/@]{4,}["']/.test(trimmed) ||
      /\w+\.prototype\./.test(trimmed) ||
      /module\.exports/.test(trimmed) ||
      /\bclass\s+\w+/.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return fallback || '(no preview)';
}

/**
 * #332: Detect esbuild's `__name` helper variable name.
 *
 * When esbuild is configured with `--keep-names` (on by default in many
 * configs), it injects a helper that preserves each function's original
 * name by calling Object.defineProperty(fn, "name", { value: "origName" }).
 * The helper is typically declared at the top of the bundle as a 2-arg
 * arrow function whose body calls Object.defineProperty — directly or via
 * a short local alias (mermaid uses `Zv` for `Object.defineProperty`).
 *
 * Sample (mermaid.min.js L10-13):
 *   var o = (t, e) => Zv(t, "name", {
 *     value: e,
 *     configurable: true
 *   });
 *
 * Returns the helper variable name (e.g. "o"), or null if not detected.
 *
 * Scans the first 200 lines as a joined string so helpers whose body
 * object-literal wraps onto multiple lines are still caught.
 *
 * -------------------------------------------------------------------------
 * Coverage note — when this feature yields results vs doesn't:
 *
 * `--keep-names` is default in many esbuild configs, but is often stripped
 * in production bundles of commercial / obfuscated software because:
 *   (a) each o(X, "origName") call adds ~30-50 bytes of overhead per
 *       function — on a 513k-line bundle with 10k+ functions this is
 *       meaningful,
 *   (b) it leaks original function names, undoing most of the effect of
 *       aggressive minification,
 *   (c) runtime uses of `fn.name` (error stack traces, React devtools,
 *       debug logging) aren't needed in release builds.
 *
 * So the empirical pattern is:
 *   - Library distributions intended for general use (mermaid, chart libs,
 *     UI frameworks): usually HAVE the helper, yield hundreds-to-thousands
 *     of ground-truth (obfuscated → original) rename pairs.
 *   - Aggressively minified commercial bundles (e.g. claude-code's cli.js):
 *     typically DO NOT have the helper, yield zero _NAME_ recoveries.
 *
 * A zero result is itself a signal about the vendor's obfuscation posture
 * — worth surfacing to the user, not just silently skipped.
 * -------------------------------------------------------------------------
 */
function _detectNameHelper(lines) {
  const N = Math.min(200, lines.length);
  const head = lines.slice(0, N).join('\n');
  // Match: NAME = (arg1, arg2) => INNER(arg1, "name", ...
  // Capture:
  //   [1] NAME (helper variable name)
  //   [2] arg1 (must appear as first arg to INNER, enforced via \2 backref)
  // Loose on whitespace so the body can wrap. The `,` after "name" is the
  // distinguishing feature — a typical Object.defineProperty(target, "name",
  // descriptor) call has exactly that trailing comma.
  const re = /\b(\w+)\s*=\s*\(\s*(\w+)\s*,\s*\w+\s*\)\s*=>\s*\w+(?:\s*\.\s*\w+)?\s*\(\s*\2\s*,\s*["']name["']\s*,/;
  const m = head.match(re);
  if (!m) return null;
  const name = m[1];
  // Exclude accidental capture of storage-class keywords
  if (name === 'var' || name === 'let' || name === 'const') return null;
  return name;
}

/**
 * #332: Scan for `helperName(IDENT, "originalName")` patterns and harvest
 * every (IDENT → originalName) pair. Returns a Map of
 *   IDENT (string) → Set<string> of observed original-name strings.
 *
 * The caller uses Set size to detect ambiguity (same IDENT tagged with
 * different names across the bundle) and skip those pairs — only
 * unambiguous pairs get added to the rename map.
 */
function _extractNameRecoveryPairs(lines, helperName) {
  const result = new Map();
  const escHelper = helperName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match helperName(IDENT, "string"...  — the trailing comma or close-paren
  // is deliberately permissive so helpers with signatures like
  //   __nameX(target, "origName", extra)
  // are handled too.
  const re = new RegExp(
    '\\b' + escHelper + '\\s*\\(\\s*([A-Za-z_$][\\w$]*)\\s*,\\s*"([^"\\\\]+)"\\s*[,)]',
    'g'
  );
  for (const line of lines) {
    if (!line) continue;
    // Fast filter: skip lines that don't even contain the helper name
    if (!line.includes(helperName)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const ident = m[1];
      const origName = m[2];
      // Sanity filters on the harvested name
      if (origName.length < 2) continue;
      if (!/[a-zA-Z]/.test(origName)) continue;
      // Don't self-pair (e.g., o(o, "o"))
      if (ident === origName) continue;
      if (!result.has(ident)) result.set(ident, new Set());
      result.get(ident).add(origName);
    }
  }
  return result;
}

/**
 * Scan strings inside a module body for likely source-path hints and license
 * headers. Returns { paths, licenses } — both arrays, empty if nothing found.
 * Conservative: only includes strings that look unambiguously like file paths
 * or SPDX/license declarations.
 */
function _scanModuleHints(lines, startIdx, endIdx) {
  const paths = new Set();
  const licenses = [];
  const limit = Math.min(endIdx + 1, lines.length);
  for (let i = startIdx; i < limit; i++) {
    const line = lines[i];
    if (!line) continue;
    // File path-ish strings inside quotes — must look like node_modules/...,
    // @scope/pkg/..., or a relative path ending in .js/.mjs/.cjs/.ts/.tsx
    const pathRe = /["'`]((?:[.@\w/-]+\/)+[\w.-]+\.(?:js|mjs|cjs|ts|tsx|jsx))["'`]/g;
    let m;
    while ((m = pathRe.exec(line)) !== null) {
      const p = m[1];
      // Skip URLs
      if (/^https?:/.test(p) || /\/\//.test(p)) continue;
      paths.add(p);
      if (paths.size >= 5) break; // cap
    }
    // License / copyright headers
    if (/Copyright\s*\(c\)/i.test(line) || /SPDX-License-Identifier/i.test(line) || /MIT License/i.test(line)) {
      const trimmed = line.trim().replace(/^[\/\*\s]+/, '').slice(0, 100);
      if (trimmed && licenses.length < 3) licenses.push(trimmed);
    }
  }
  return { paths: [...paths], licenses };
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
function inferAllNames(idx, { minFuncLines = 0 } = {}) {
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

/**
 * Try deobfuscating JS with webcrack, with size limit and timeout.
 * Returns deobfuscated code or null on failure/timeout.
 */
async function tryWebcrack(code) {
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


/**
 * Directories to always skip during directory walks.
 * These contain third-party, build, or infrastructure files
 * that are never project source code.
 */
const _SKIP_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.svn', '.hg',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'dist', 'build', '.next', '.nuxt',
  'vendor', 'venv', '.venv', 'env',
  'coverage', '.nyc_output',
  '.idea', '.vscode',
]);


export class CodeSearchIndex {

  static DEFAULT_EXTENSIONS = DEFAULT_EXTENSIONS;
  static TEXT_EXTENSIONS = TEXT_EXTENSIONS;

  /**
   * @param {object} opts
   * @param {string} [opts.indexPath='.code_search_index']
   * @param {Set<string>|null} [opts.extensions]
   * @param {string} [opts.embeddingModel='default']
   */
  constructor({ indexPath = '.code_search_index', extensions = null,
                embeddingModel = 'default', excludeCompound = null } = {}) {
    this.indexPath = indexPath;
    this.extensions = extensions || new Set(DEFAULT_EXTENSIONS);
    this.embeddingModel = embeddingModel;

    /** @type {Set<string>} Compound extensions to exclude (e.g., '.d.ts') */
    this._excludeCompound = excludeCompound || new Set();

    /** @type {Map<string, string>} path -> content */
    this.files = new Map();
    /** @type {Map<string, string[]>} path -> lines */
    this.fileLines = new Map();
    /** @type {Object<string, Object>} normalized_line -> [[filepath, [lineNums]], ...] */
    this.invertedIndex = null;
    /** @type {Object<string, Object>} filepath -> {funcName -> {start,end,type,base_name}} */
    this.functionIndex = null;
    /** @type {Object<string, string[]>} sha1 -> [relPaths] */
    this.fileHashes = null;
    /** @type {string|null} */
    this.basePath = null;
    /** @type {string|null} */
    this.indexSource = null;

    // Inverted index: loaded in memory or streamed on demand
    /** @type {boolean} */
    this._invertedOnDisk = false;
    /** @type {string|null} */
    this._invertedDiskPath = null;
    /** @type {number} */
    this._invertedDiskSize = 0;

    /** @type {string|null} 'regex' | 'tree-sitter' | 'tree-sitter+regex' */
    this.parseMethod = null;

    // Cache: call counts survive across commands in interactive mode
    /** @type {Object<string,number>|null} */
    this._callCountsCache = null;

    // Try to load existing index
    if (this._loadLiteralIndex()) {
      eprint(`Loaded existing index: ${this.files.size} files`);
    }
  }


  // ========================================================================
  // Persistence paths
  // ========================================================================

  _literalIndexPath()  { return path.join(this.indexPath, 'literal_index.json'); }
  _invertedIndexPath() { return path.join(this.indexPath, 'inverted_index.json'); }
  _functionIndexPath() { return path.join(this.indexPath, 'function_index.json'); }
  _funcHashesPath()    { return path.join(this.indexPath, 'func_hashes.json'); }
  _renameMapPath()     { return path.join(this.indexPath, 'rename_map.json'); }
  _stringTablePath()   { return path.join(this.indexPath, 'string_table.json'); }


  // ========================================================================
  // Rename map: save/load/apply (display-time function name substitution)
  // ========================================================================

  _saveRenameMap(map) {
    try {
      fs.writeFileSync(this._renameMapPath(), JSON.stringify(map, null, 2));
    } catch (e) {
      console.log(`Warning: could not save rename map: ${e.message}`);
    }
  }

  _loadRenameMap() {
    if (this._renameMap) return this._renameMap;
    try {
      const raw = fs.readFileSync(this._renameMapPath(), 'utf-8');
      const parsed = JSON.parse(raw);
      // Use null-prototype object to avoid collisions with Object.prototype keys
      // (e.g. 'constructor', 'toString' are valid function names in minified code)
      this._renameMap = Object.create(null);
      for (const [k, v] of Object.entries(parsed)) {
        this._renameMap[k] = v;
      }
      return this._renameMap;
    } catch {
      this._renameMap = Object.create(null);
      return this._renameMap;
    }
  }

  /**
   * Apply rename map to a block of source code for display.
   * Replaces obfuscated identifiers with their inferred names.
   * Returns the renamed source text.
   */
  applyRenames(sourceText, initialState = 'code') {
    if (!sourceText) return sourceText || '';
    const map = this._loadRenameMap();
    if (!map || Object.keys(map).length === 0) return sourceText;
    // Skip rename application for very large blocks to avoid performance issues
    // (11K renames × 16MB file = too slow). Limit allows single functions up to
    // ~200K chars but skips whole-file display of huge files.
    if (sourceText.length > 200000) return sourceText;

    // Build a combined regex that matches any rename target as a whole word
    if (!this._renameRegex) {
      const keys = Object.keys(map).sort((a, b) => b.length - a.length);
      if (keys.length === 0) return sourceText;
      // Escape and join with | for alternation
      const pattern = keys.map(k => escapeRegex(k)).join('|');
      this._renameRegex = new RegExp('\\b(' + pattern + ')\\b', 'g');
    }

    // Apply line by line, tracking cross-line state for block comments and
    // template literals (#10). The state machine in _scanLineState handles:
    //   - 'bc' (block comment)        — can span multiple lines via /* ... */
    //   - 't'  (template literal)     — can span multiple lines via `...`
    // Other states ('s', 'd', 'lc') don't span lines. Callers (e.g.
    // doFileBookends extracting a tail chunk from deep in a file) may pass
    // `initialState='bc'` or `'t'` if they know the chunk begins mid-block.
    const lines = sourceText.split('\n');
    let carryState = initialState || 'code';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // If the line starts inside a block comment or template, AND the state
      // never exits before line end, skip rename for the whole line.
      const endState = _scanLineState(line, carryState);
      if (
        (carryState === 'bc' && endState === 'bc') ||
        (carryState === 't'  && endState === 't')
      ) {
        carryState = endState;
        continue;
      }

      this._renameRegex.lastIndex = 0;
      const startStateForLine = carryState;
      lines[i] = line.replace(this._renameRegex, (match, name, offset) => {
        // Skip matches inside any string-like or comment context
        if (_isInsideString(line, offset, startStateForLine)) return match;
        return (map && Object.prototype.hasOwnProperty.call(map, name)) ? map[name] : match;
      });

      // Carry block-comment / template state to next line; reset for everything else
      carryState = (endState === 'bc' || endState === 't') ? endState : 'code';
    }
    return lines.join('\n');
  }

  /**
   * Detect bundle-seam module boundaries in a JS file produced by esbuild
   * (or a similar lazy-factory bundler). See the long comment block above
   * _detectBundleHelpers for the pattern family and shape-based detection
   * rationale.
   *
   * @param {string} filepath — must be in this.fileLines
   * @param {object} [opts]
   * @param {boolean} [opts.scanHints=false] — also scan each module body for
   *   source-path and license hints (more expensive)
   * @returns {object} — { filepath, pattern, helpers, modules, error? }
   *   pattern: 'esbuild-flat' | 'esbuild-iife' | null
   *   modules: array of { name, kind: 'ESM'|'CJS', startLine, endLine,
   *                       lineCount, preview, hints? }
   */
  detectBundleSeams(filepath, { scanHints = false } = {}) {
    const lines = this.fileLines.get(filepath);
    if (!lines) return { filepath, error: 'File not in index: ' + filepath };

    const helpers = _detectBundleHelpers(lines);
    if (!helpers.esm && !helpers.cjs) {
      return { filepath, pattern: null, helpers, modules: [] };
    }

    // Build wrapper regex. Allow any arrow-arg shape: (), (x), (x, y)
    const names = [helpers.esm, helpers.cjs].filter(Boolean);
    const altNames = names
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    // Capture: (1) leading indent, (2) module var name, (3) helper name
    const wrapperRe = new RegExp(
      '^(\\s*)var\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(' + altNames + ')\\s*\\(\\s*\\('
    );

    // First pass: find all wrapper start lines
    const wrappers = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const m = line.match(wrapperRe);
      if (!m) continue;
      wrappers.push({
        startLine: i + 1,
        wrapperLine: i + 1, // 1-indexed opening line of the wrapper itself
        name: m[2],
        helperName: m[3],
        indent: m[1].length,
        kind: m[3] === helpers.esm ? 'ESM' : 'CJS',
      });
    }

    // Second pass: compute TIGHT end lines via brace counting from the
    // wrapper opening `{`. State-machine-aware so string/template/comment
    // content is skipped. The sibling rule (end = next.start - 1) was wrong
    // because esbuild interleaves module-scope var decls and unrelated
    // top-level code between wrappers.
    for (const w of wrappers) {
      w.endLine = _findWrapperEnd(lines, w.startLine - 1);
    }

    // Third pass: absorb preceding top-level `var X, Y, Z;` decls into each
    // wrapper's start line. esbuild emits module-scope vars immediately
    // before the wrapper that populates them; semantically they belong to
    // that wrapper. Rule: scan backwards from wrapperLine-1 absorbing any
    // consecutive `var name(, name)*;` lines (and blank lines between) up
    // to the previous wrapper's end or a non-matching line.
    const absorbRe = /^\s*var\s+[A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*;?\s*$/;
    for (let i = 0; i < wrappers.length; i++) {
      const w = wrappers[i];
      const prevEnd = i > 0 ? wrappers[i - 1].endLine : 0;
      let absorbStart = w.wrapperLine; // 1-indexed
      for (let j = w.wrapperLine - 2; j >= prevEnd; j--) {
        const line = lines[j] || '';
        if (!line.trim()) continue; // skip blank lines while looking backwards
        if (absorbRe.test(line)) {
          absorbStart = j + 1; // 1-indexed
        } else {
          break;
        }
      }
      w.startLine = absorbStart;
    }

    // Fourth pass: compute lineCount and extract previews + hints
    for (const w of wrappers) {
      w.lineCount = w.endLine - w.startLine + 1;
      w.preview = _extractModulePreview(lines, w.wrapperLine - 1, w.endLine - 1);
      if (scanHints) {
        w.hints = _scanModuleHints(lines, w.startLine - 1, w.endLine - 1);
      }
    }

    const pattern = helpers.iifeStartLine > 0 ? 'esbuild-iife' : 'esbuild-flat';

    // Compute function-position lookup once. Needed for:
    //   - per-wrapper function inventory (scanHints only)
    //   - gap-module detection for IIFE bundles (always)
    let sortedFuncs = null;
    if (scanHints || pattern === 'esbuild-iife') {
      this._ensureFunctionIndex();
      const fileFuncs = this.functionIndex && this.functionIndex[filepath];
      if (fileFuncs) {
        sortedFuncs = Object.entries(fileFuncs)
          .map(([name, info]) => ({ name, start: info.start, end: info.end, type: info.type }))
          .sort((a, b) => a.start - b.start);
      }
    }

    // Fifth pass (scanHints): per-wrapper function inventory
    if (scanHints && sortedFuncs) {
      let idx = 0;
      for (const w of wrappers) {
        while (idx < sortedFuncs.length && sortedFuncs[idx].start < w.startLine) idx++;
        const inModule = [];
        let k = idx;
        while (k < sortedFuncs.length && sortedFuncs[k].start <= w.endLine) {
          inModule.push(sortedFuncs[k]);
          k++;
        }
        w.functions = inModule;
      }
    }

    // Sixth pass (IIFE only): insert "gap modules" between wrappers.
    //
    // In esbuild's --format=iife output (e.g. mermaid.min.js), most real
    // source code lives at top-level INSIDE the outer IIFE, between the
    // wrapper scaffolds. Wrappers themselves are tiny (4-10 lines) and
    // just call `o(func, "originalName")` to assign .name properties to
    // functions declared elsewhere. The "original source file" groupings
    // correspond much more closely to the inter-wrapper gaps than to the
    // wrappers themselves.
    //
    // A gap module is created for any region between two wrappers (or
    // before-first / after-last within the outer IIFE) that contains at
    // least one function definition. Gaps without functions are skipped.
    // Gap modules are given synthetic names like `[gap@L1432]` and a
    // kind of 'GAP' (distinguishable from ESM/CJS in display).
    let modules = wrappers;
    if (pattern === 'esbuild-iife' && sortedFuncs && wrappers.length > 0) {
      const gaps = [];
      const iifeStart = helpers.iifeStartLine;
      const iifeEndApprox = lines.length; // outer IIFE closes near EOF
      let fnIdx = 0;

      // Helper: collect functions in [gapStart, gapEnd] from sortedFuncs
      const funcsInRange = (gapStart, gapEnd) => {
        // advance fnIdx past functions ending before gapStart (monotonic
        // across successive gap queries since gaps are processed in order)
        while (fnIdx < sortedFuncs.length && sortedFuncs[fnIdx].start < gapStart) fnIdx++;
        const out = [];
        let k = fnIdx;
        while (k < sortedFuncs.length && sortedFuncs[k].start <= gapEnd) {
          out.push(sortedFuncs[k]);
          k++;
        }
        return out;
      };

      const makeGap = (gapStart, gapEnd) => {
        if (gapStart > gapEnd) return null;
        const fns = funcsInRange(gapStart, gapEnd);
        if (fns.length === 0) return null;
        const gap = {
          startLine: gapStart,
          endLine: gapEnd,
          wrapperLine: gapStart,
          name: `[gap@L${gapStart}]`,
          helperName: null,
          kind: 'GAP',
          indent: 0,
          lineCount: gapEnd - gapStart + 1,
          preview: _extractModulePreview(lines, gapStart - 1, gapEnd - 1),
          functions: fns,
        };
        if (scanHints) {
          gap.hints = _scanModuleHints(lines, gapStart - 1, gapEnd - 1);
        }
        return gap;
      };

      // Gap before the first wrapper (from inside the IIFE)
      const g0 = makeGap(iifeStart + 1, wrappers[0].startLine - 1);
      if (g0) gaps.push(g0);

      // Gaps between consecutive wrappers
      for (let i = 0; i < wrappers.length - 1; i++) {
        const g = makeGap(wrappers[i].endLine + 1, wrappers[i + 1].startLine - 1);
        if (g) gaps.push(g);
      }

      // Gap after the last wrapper (to end of IIFE)
      const last = wrappers[wrappers.length - 1];
      const gN = makeGap(last.endLine + 1, iifeEndApprox);
      if (gN) gaps.push(gN);

      // Merge wrappers + gaps, sort by start line
      modules = [...wrappers, ...gaps].sort((a, b) => a.startLine - b.startLine);
    }

    return {
      filepath,
      pattern,
      helpers,
      modules,
    };
  }

  /**
   * #329 Phase 1: assemble a structured, non-AI digest of a single function
   * by pulling together signals from every CodeExam facility that can
   * mechanically describe the function's shape and content. No interpretation
   * — every field is a fact extracted from the index.
   *
   * Sections produced (empty ones are omitted at format time):
   *   - identity         — name, rename chain, location, line count, type
   *   - callers          — count + names (from findCallers)
   *   - callees          — count + names (from findCallees)
   *   - strings          — top distinctive + frequency outliers within body
   *   - breadcrumbs      — markers (q/Bq-style) emitted from body
   *   - comments         — `//` and block comments in body
   *   - commands         — extractCommandCatalog cross-reference
   *   - dupes            — exact/near/structural dupes via func_hashes
   *
   * Deferred (section stub only, pending separate TODOs):
   *   - asserts          — pending extractAsserts (TODO #337)
   *
   * @param {string} funcSpec — bare name, Class::method, or file@name
   * @param {object} [opts]
   * @param {number} [opts.maxCallers=10]     cap for caller/callee display
   * @param {number} [opts.maxCallees=10]
   * @param {number} [opts.maxStrings=15]     cap for distinctive strings section
   * @param {number} [opts.minRepeatCount=3]  threshold for "repeated string"
   * @returns {object|null} digest object, or null if function not found
   *
   * Note on "times"/counts throughout: all counts in this digest are STATIC
   * call-site counts (number of distinct source-code locations), never
   * dynamic runtime counts.
   */
  buildFunctionDigest(funcSpec, opts = {}) {
    const {
      maxCallers = 10,
      maxCallees = 10,
      maxStrings = 15,
      minRepeatCount = 3,
    } = opts;

    // --- Resolve function ---
    let pathHint = null, funcName;
    if (funcSpec.includes('@')) {
      const at = funcSpec.indexOf('@');
      pathHint = funcSpec.slice(0, at);
      funcName = funcSpec.slice(at + 1);
    } else {
      // Try reverse-rename (user typed display name)
      funcName = this.getOriginalName ? this.getOriginalName(funcSpec) : funcSpec;
    }

    const matches = this.findFunctionMatches(funcName, pathHint);
    if (matches.length === 0) return null;
    const fn = matches[0];
    const filepath = fn.filepath;
    const lines = this.fileLines.get(filepath);
    if (!lines) return null;
    const bodyLines = lines.slice(fn.start - 1, fn.end);
    const bodyText = bodyLines.join('\n');

    // --- Identity ---
    const dn = this.getDisplayName(fn.name);
    // Detect rename tier from the display name
    let renameTier = null;
    if (dn !== fn.name) {
      if (dn.includes('_CMD_')) renameTier = 'CMD';
      else if (/(?:^|::)[^_]*_NAME_[a-zA-Z]/.test(dn)) renameTier = 'NAME';
      else if (dn.includes('_IMPORT_')) renameTier = 'IMPORT';
      else if (dn.includes('_KW_')) renameTier = 'KW';
    }
    // Bare-name uniqueness check via the function index
    this._ensureFunctionIndex();
    const bareOf = (n) => {
      let b = n.includes('::') ? n.split('::').pop() : n;
      if (b.includes('@')) b = b.split('@')[0];
      return b;
    };
    const myBare = bareOf(fn.name);
    let bareCount = 0;
    if (this.functionIndex) {
      for (const funcs of Object.values(this.functionIndex)) {
        for (const fname of Object.keys(funcs)) {
          if (bareOf(fname) === myBare) bareCount++;
        }
      }
    }

    const identity = {
      name: fn.name,
      displayName: dn,
      renameTier,
      filepath,
      startLine: fn.start,
      endLine: fn.end,
      lineCount: fn.end - fn.start + 1,
      type: fn.type,
      bareUnique: bareCount === 1,
      bareDuplicateCount: bareCount,
      parseMethod: this.parseMethod || 'unknown',
    };

    // --- Callers ---
    const rawCallers = this.findCallers(fn.name, 500);
    const byCaller = new Map();
    for (const c of rawCallers) {
      // tree-sitter's _findContainingFunction returns null when a call is
      // genuinely at top-level / file scope (not inside any function).
      // Surface that as "(file scope)" rather than the less-informative
      // "(unknown)". If future parser work introduces a distinct "truly
      // unresolved" case, we can differentiate then.
      const name = c.caller_function || '(file scope)';
      if (!byCaller.has(name)) byCaller.set(name, []);
      byCaller.get(name).push({ filepath: c.filepath, line: c.line_number });
    }
    const callersSection = {
      totalSites: rawCallers.length,
      distinctCallers: byCaller.size,
      byCaller: [...byCaller.entries()]
        .sort((a, b) => b[1].length - a[1].length) // most-frequent callers first
        .slice(0, maxCallers)
        .map(([name, sites]) => ({
          callerName: name,
          callerDisplayName: this.getDisplayName(name),
          siteCount: sites.length,
          sites: sites.slice(0, 3), // first few for detail
        })),
    };

    // --- Callees ---
    const rawCallees = this.findCallees(fn.name, pathHint);
    // Tally (name -> count) using the call_sites array if provided, else 1 each
    const calleeTally = new Map();
    for (const ce of rawCallees) {
      const nm = ce.name || ce.display_name || '(unknown)';
      const siteCount = Array.isArray(ce.call_sites) ? ce.call_sites.length : 1;
      calleeTally.set(nm, (calleeTally.get(nm) || 0) + siteCount);
    }
    const calleesSection = {
      totalSites: [...calleeTally.values()].reduce((s, n) => s + n, 0),
      distinctCallees: calleeTally.size,
      topByFrequency: [...calleeTally.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, maxCallees)
        .map(([name, count]) => ({
          calleeName: name,
          calleeDisplayName: this.getDisplayName(name),
          siteCount: count,
        })),
      recursive: calleeTally.has(fn.name) || calleeTally.has(myBare),
    };

    // --- Strings in body ---
    // Scan body lines for quoted strings, count per-function occurrences,
    // cross-ref with the global string table for rarity (lower total count
    // = more distinctive).
    const perFuncStringCounts = new Map(); // value -> count within this function
    const strRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
    for (const line of bodyLines) {
      if (!line) continue;
      strRe.lastIndex = 0;
      let m;
      while ((m = strRe.exec(line)) !== null) {
        const val = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
        if (!val || val.length < 2) continue;
        // Skip string fragments that look like identifier-only (property
        // names inside object literals etc. are caught but harmless)
        perFuncStringCounts.set(val, (perFuncStringCounts.get(val) || 0) + 1);
      }
    }
    // Look up global frequency in string table (if available).
    // Build a value→count Map once for O(1) lookup instead of per-string linear scan.
    let strTableMap = null;
    try {
      const strTable = this.ensureStringTable ? this.ensureStringTable(2, false) : null;
      if (Array.isArray(strTable)) {
        strTableMap = new Map();
        for (const entry of strTable) {
          if (entry && entry.value) strTableMap.set(entry.value, entry.count);
        }
      }
    } catch { /* ignore */ }
    const getGlobalCount = (val) => strTableMap ? strTableMap.get(val) ?? null : null;
    const distinctiveStrings = [...perFuncStringCounts.entries()]
      .map(([val, localCount]) => ({ val, localCount, globalCount: getGlobalCount(val) }))
      // Sort by global count ascending (rarer first); nulls treated as rare
      .sort((a, b) => {
        const ag = a.globalCount == null ? 1 : a.globalCount;
        const bg = b.globalCount == null ? 1 : b.globalCount;
        return ag - bg;
      })
      .slice(0, maxStrings);
    const repeatedStrings = [...perFuncStringCounts.entries()]
      .filter(([, c]) => c >= minRepeatCount)
      .map(([val, count]) => ({ val, count }))
      .sort((a, b) => b.count - a.count);
    const stringsSection = {
      totalStrings: [...perFuncStringCounts.values()].reduce((s, n) => s + n, 0),
      distinctStrings: perFuncStringCounts.size,
      distinctive: distinctiveStrings,
      repeated: repeatedStrings,
    };

    // --- Breadcrumbs in body ---
    // Three sources, unioned and deduped by line number:
    //
    //   (1) global extractBreadcrumbs().markers   — timing/trace markers
    //       (Bq, L3, etc.), emits only from index-wide top-3 trace helpers
    //   (2) global extractBreadcrumbs().events    — telemetry events
    //       (n("tengu_*"), etc.), emits only from hardcoded emitter names
    //   (3) per-function local scan               — catches locally-aliased
    //       helpers the global extractor misses (e.g. `q` in VCz, `jA` in
    //       Mf7; also handles multi-arg calls like jA("event", false))
    //
    // Source (3) uses the same label-shape filter as the global extractor
    // (≥2 underscores, length ≥8, starts with lowercase letter) so false
    // positives are minimized. Multi-arg calls match via `[,)]` terminator
    // rather than just `)`.
    const markersByLine = new Map();
    try {
      const bc = this.extractBreadcrumbs ? this.extractBreadcrumbs(false) : null;
      if (bc && bc.markers) {
        for (const m of bc.markers) {
          if (m.filepath !== filepath || m.line < fn.start || m.line > fn.end) continue;
          markersByLine.set(m.line, { label: m.label, line: m.line });
        }
      }
      if (bc && bc.events) {
        for (const e of bc.events) {
          if (e.filepath !== filepath || e.line < fn.start || e.line > fn.end) continue;
          if (!markersByLine.has(e.line)) {
            markersByLine.set(e.line, { label: e.name, line: e.line });
          }
        }
      }
    } catch { /* ignore */ }

    const localMarkerRe = /\b([a-zA-Z_$][\w$]{0,4})\(\s*["']([a-z][a-z0-9_]+)["']\s*[,)]/g;
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i] || '';
      localMarkerRe.lastIndex = 0;
      let m;
      while ((m = localMarkerRe.exec(line)) !== null) {
        const label = m[2];
        if ((label.match(/_/g) || []).length < 2) continue;
        if (label.length < 8) continue;
        const lineNum = fn.start + i;
        if (!markersByLine.has(lineNum)) {
          markersByLine.set(lineNum, { label, line: lineNum });
        }
      }
    }

    const breadcrumbsSection = {
      markers: [...markersByLine.values()].sort((a, b) => a.line - b.line),
    };

    // --- Comments in body ---
    // Use _isInsideString (the state-machine helper also used by applyRenames
    // and searchLiteral) to distinguish genuine `//` comments from the `//`
    // that appears inside string literals like "https://example.com/...".
    // The naive "count quote chars before this position" heuristic is fooled
    // by templates-containing-strings, which is common in minified JS.
    //
    // Cross-line state: track block-comment open/close across lines using the
    // same carryState approach as applyRenames.
    const comments = [];
    let carryState = 'code';
    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i] || '';
      // If the line begins inside an open block comment carried from the
      // previous line, scan for `*/` and capture the text before it.
      if (carryState === 'bc') {
        const endIdx = line.indexOf('*/');
        const content = (endIdx >= 0 ? line.slice(0, endIdx) : line)
          .replace(/^\s*\*\s?/, '').trim();
        if (content) comments.push({ line: fn.start + i, kind: 'block', text: content });
        carryState = endIdx >= 0 ? 'code' : 'bc';
        continue;
      }
      // Walk the line looking for `//` or `/*` at code-state positions (not
      // inside strings/templates/existing comments). _isInsideString gives us
      // the state AT a given offset given the line and a starting state.
      let j = 0;
      let emitted = false;
      while (j < line.length - 1) {
        const two = line[j] + line[j + 1];
        if ((two === '//' || two === '/*') && !_isInsideString(line, j, carryState)) {
          if (two === '//') {
            const content = line.slice(j + 2).trim();
            if (content) comments.push({ line: fn.start + i, kind: 'line', text: content });
            emitted = true;
            break;
          } else {
            // Block comment — look for matching */ on this line
            const blockEnd = line.indexOf('*/', j + 2);
            if (blockEnd >= 0) {
              const content = line.slice(j + 2, blockEnd).trim();
              if (content) comments.push({ line: fn.start + i, kind: 'block-inline', text: content });
              j = blockEnd + 2;
              continue;
            } else {
              const content = line.slice(j + 2).trim();
              if (content) comments.push({ line: fn.start + i, kind: 'block', text: content });
              carryState = 'bc';
              emitted = true;
              break;
            }
          }
        }
        j++;
      }
      // Update cross-line state: if we're not in a block comment at line end,
      // check whether the line leaves us in template-literal state (which can
      // also carry across lines per _scanLineState).
      if (!emitted && carryState !== 'bc') {
        const endState = _scanLineState(line, carryState);
        carryState = (endState === 'bc' || endState === 't') ? endState : 'code';
      }
    }

    // --- Command-catalog cross-reference ---
    let commandsSection = { cliOptions: [], commands: [], routes: [], guiActions: [] };
    try {
      const cat = this.extractCommandCatalog ? this.extractCommandCatalog(false) : null;
      if (cat) {
        const matchesFunc = (item) => {
          const f = item.func || item.handler?.func;
          return f && (f === fn.name || f === dn || bareOf(f) === myBare);
        };
        for (const key of ['cliOptions', 'commands', 'routes', 'guiActions']) {
          if (cat[key]) commandsSection[key] = cat[key].filter(matchesFunc);
        }
      }
    } catch { /* ignore */ }

    // --- Dupes ---
    let dupesSection = { exactSiblings: [], nearSiblings: [], structSiblings: [] };
    try {
      const hashes = this.ensureFuncHashes ? this.ensureFuncHashes(3, false) : null;
      if (hashes) {
        const myKey = `${filepath}|||${fn.name}`;
        const myHash = hashes.get(myKey);
        if (myHash) {
          for (const [key, h] of hashes) {
            if (key === myKey) continue;
            const [otherFile, otherName] = key.split('|||');
            const sib = {
              name: otherName,
              displayName: this.getDisplayName(otherName),
              filepath: otherFile,
              lines: h.lines,
            };
            if (h.body_hash === myHash.body_hash) dupesSection.exactSiblings.push(sib);
            else if (h.struct_hash === myHash.struct_hash) dupesSection.structSiblings.push(sib);
            else if (bareOf(otherName) === myBare && h.lines === myHash.lines) {
              dupesSection.nearSiblings.push(sib);
            }
          }
          // Rank sibling names by "usefulness" tier, highlight most-useful
          const tierRank = (n, disp) => {
            const d = disp || n;
            if (/(?:^|::)[^_]*_NAME_[a-zA-Z]/.test(d)) return 1; // ground truth
            if (d.includes('_CMD_')) return 2;
            if (d === n && !/_[A-Z]+_/.test(n)) return 3; // hand-written, no rename
            if (d.includes('_IMPORT_')) return 4;
            if (d.includes('_KW_')) return 5;
            return 6;
          };
          const myRank = tierRank(fn.name, dn);
          const allSiblings = [
            ...dupesSection.exactSiblings,
            ...dupesSection.nearSiblings,
            ...dupesSection.structSiblings,
          ];
          for (const sib of allSiblings) {
            sib.rank = tierRank(sib.name, sib.displayName);
          }
          // Find the best sibling (lowest rank number)
          const best = allSiblings
            .filter((s) => s.rank < myRank)
            .sort((a, b) => a.rank - b.rank)[0];
          if (best) dupesSection.moreUsefullyNamedSibling = best;
        }
      }
    } catch { /* ignore */ }

    // --- Asserts (deferred, section stub only) ---
    const assertsSection = { asserts: [], _note: 'pending TODO #337 — extractAsserts not yet implemented' };

    return {
      identity,
      callers: callersSection,
      callees: calleesSection,
      strings: stringsSection,
      breadcrumbs: breadcrumbsSection,
      comments,
      commands: commandsSection,
      dupes: dupesSection,
      asserts: assertsSection,
    };
  }

  /**
   * Scan `lines` from index 0 up to (but not including) `endLineIdx`, running
   * the state machine to determine whether that line position is inside an
   * open block comment or template literal carried from earlier in the file.
   *
   * Much cheaper than applyRenames (no regex alternation, just char iteration)
   * so can be used on huge files to compute the starting state for a tail
   * chunk. Returns one of: 'code' | 'bc' | 't' (string/line-comment states
   * don't carry across lines).
   */
  scanFileToLine(lines, endLineIdx) {
    let state = 'code';
    const limit = Math.min(endLineIdx, lines.length);
    for (let i = 0; i < limit; i++) {
      state = _scanLineState(lines[i], state);
      // String and line-comment states never persist across a line boundary
      if (state !== 'bc' && state !== 't') state = 'code';
    }
    return state;
  }

  /**
   * Get the display name for a function, applying rename map if available.
   */
  getDisplayName(funcName) {
    if (!funcName) return funcName || '';
    const map = this._loadRenameMap();
    // Use hasOwnProperty to avoid Object prototype collisions (constructor, toString, etc.)
    return (map && Object.prototype.hasOwnProperty.call(map, funcName)) ? map[funcName] : funcName;
  }

  /**
   * Reverse lookup: given a display name (possibly renamed), return the original name.
   * Used when the GUI sends a renamed name back for lookup/extract.
   */
  getOriginalName(displayName) {
    if (!this._reverseRenameMap) {
      const map = this._loadRenameMap();
      this._reverseRenameMap = Object.create(null);
      for (const [orig, renamed] of Object.entries(map)) {
        this._reverseRenameMap[renamed] = orig;
      }
    }
    return this._reverseRenameMap[displayName] || displayName;
  }

  /**
   * Reverse-apply renames in a search query so it matches the stored (original) content.
   * Replaces display names back to original obfuscated names.
   */
  reverseRenames(text) {
    if (!this._reverseRenameMap) this.getOriginalName('');  // trigger build
    const entries = Object.entries(this._reverseRenameMap).sort((a, b) => b[0].length - a[0].length);
    if (entries.length === 0) return text;
    let result = text;
    for (const [renamed, orig] of entries) {
      const re = new RegExp('\\b' + escapeRegex(renamed) + '\\b', 'g');
      result = result.replace(re, orig);
    }
    return result;
  }

  /**
   * Find original names whose display names contain the given substring.
   * Returns array of original names. Used for searching by display name patterns.
   */
  findOriginalsByDisplayPattern(pattern) {
    const map = this._loadRenameMap();
    if (!map || Object.keys(map).length === 0) return [];
    const pat = pattern.toLowerCase();
    const originals = [];
    for (const [orig, display] of Object.entries(map)) {
      if (display.toLowerCase().includes(pat)) {
        originals.push(orig);
      }
    }
    return originals;
  }

  /**
   * Run all rename inference passes (KW from body keywords, CMD from command
   * catalog, IMPORT from destructuring imports) and persist rename_map.json
   * + import_map.json to the index directory. Used by buildIndex() and by the
   * --build-rename-map CLI flag (to retro-fit renames onto an existing index).
   *
   * Requires fileLines and functionIndex to be loaded (which happens
   * automatically when an existing index is loaded from disk).
   *
   * @param {object|boolean} [opts]  May be passed as a plain boolean for
   *   backwards compat (interpreted as showProgress), or as an options object.
   * @param {boolean} [opts.showProgress=true]
   * @param {number}  [opts.minFuncLines=0]  skip rename for functions with
   *   lineCount <= this (0 = no threshold, 4 was the old default).
   * @returns {{namesInferred: number, cmdRenames: number, importRenames: number}}
   */
  inferAndSaveRenameMap(opts = {}) {
    // Backwards-compat shim: allow passing a bare boolean as the old showProgress arg
    if (typeof opts === 'boolean') opts = { showProgress: opts };
    const { showProgress = true, minFuncLines = 0 } = opts;
    if (showProgress) console.log('Inferring descriptive names for opaque functions...');
    const { renameMap, count: namesInferred } = inferAllNames(this, { minFuncLines });

    // Overlay _CMD_ renames from command catalog (higher quality than _KW_ for these)
    const catalog = this.extractCommandCatalog(false);
    let cmdRenames = 0;
    for (const cmd of catalog.commands) {
      if (cmd.tier !== 'primary') continue;
      if (!cmd.func || cmd.func === '(file scope)') continue;
      const funcName = cmd.func;
      if (!isOpaqueName(funcName)) continue;
      const cmdName = (cmd.name || '').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
      if (cmdName.length < 2) continue;
      let displayName = funcName + '_CMD_' + cmdName;
      if (displayName.length > 60) displayName = displayName.slice(0, 60);
      renameMap[funcName] = displayName;
      cmdRenames++;
    }
    for (const opt of catalog.cliOptions) {
      if (!opt.handler?.func || opt.handler.func === '(file scope)') continue;
      const funcName = opt.handler.func;
      if (!isOpaqueName(funcName)) continue;
      const optName = (opt.flags?.[0] || opt.name || '').replace(/^-+/, '').replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
      if (optName.length < 2) continue;
      let displayName = funcName + '_CMD_' + optName;
      if (displayName.length > 60) displayName = displayName.slice(0, 60);
      renameMap[funcName] = displayName;
      cmdRenames++;
    }

    // Overlay destructuring import renames: { exportName: localVar } → localVar_IMPORT_EXPORT_NAME
    // Two-pass: first collect ALL import mappings, then only apply renames for
    // variables that have a single unambiguous mapping (avoids clobbering short
    // names like _q or z that are reused across scopes).
    let importRenames = 0;
    const importCandidates = Object.create(null); // localVar → Set of export names

    for (const [, flines] of this.fileLines) {
      for (let i = 0; i < flines.length; i++) {
        const line = flines[i].trim();
        if (!/^(?:let|const|var)\s+\{/.test(line) && line !== '{') continue;

        let block = line;
        for (let j = i + 1; j < Math.min(i + 15, flines.length); j++) {
          block += ' ' + flines[j].trim();
          if (flines[j].includes('}')) break;
        }
        if (!/\}\s*=/.test(block)) continue;

        const pairRe = /(\w+)\s*:\s*([a-zA-Z_$][\w$]*)/g;
        let dm;
        while ((dm = pairRe.exec(block)) !== null) {
          const exportName = dm[1];
          const localVar = dm[2];
          if (exportName.length < 3) continue;
          if (localVar.length > 8 && !isOpaqueName(localVar)) continue;
          if (/^(true|false|null|undefined|this|super|class|function|return|if|else|for|while|var|let|const|new|delete|typeof|void|in|of)$/.test(localVar)) continue;
          if (isOpaqueName(exportName)) continue;

          if (!importCandidates[localVar]) importCandidates[localVar] = new Set();
          importCandidates[localVar].add(exportName);
        }
      }
    }

    // Only apply renames for variables with a single unambiguous import mapping
    // AND with 3+ char names (1-2 char names are too common as local vars for safe global replace)
    // AND not in the built-in identifier blocklist (#7).
    for (const [localVar, exportNames] of Object.entries(importCandidates)) {
      if (exportNames.size !== 1) continue;
      if (localVar.length < 3) continue;
      if (_IMPORT_LOCAL_BLOCKLIST.has(localVar)) continue;
      const exportName = [...exportNames][0];
      const importName = 'IMPORT_' + camelToScreamingSnake(exportName);
      let displayName = localVar + '_' + importName;
      if (displayName.length > 60) displayName = displayName.slice(0, 60);
      // Override _KW_ renames but not _CMD_ renames
      if (!renameMap[localVar] || renameMap[localVar].includes('_KW_')) {
        renameMap[localVar] = displayName;
        importRenames++;
      }
    }

    // Save all import mappings (including ambiguous) for future display in rename table
    if (Object.keys(importCandidates).length > 0) {
      const importMapPath = path.join(this.indexPath, 'import_map.json');
      const importMap = {};
      for (const [localVar, exportNames] of Object.entries(importCandidates)) {
        importMap[localVar] = [...exportNames];
      }
      try {
        fs.writeFileSync(importMapPath, JSON.stringify(importMap, null, 2));
      } catch { /* ignore */ }
    }

    // #332: Overlay __name-helper recoveries. For each indexed file, detect
    // esbuild's __name helper (preserves original names via
    // Object.defineProperty(fn, "name", {...})), then scan for helper(IDENT,
    // "originalName") calls and add IDENT → IDENT_NAME_originalName entries.
    //
    // Priority tier: _CMD_ > _NAME_ > _IMPORT_ > _KW_.
    // This pass OVERRIDES existing _KW_ and _IMPORT_ renames (because the
    // original name is ground truth from the bundler) but leaves _CMD_
    // untouched (command-catalog renames express the function's ROLE, which
    // is more specific than its original source-code name).
    //
    // Ambiguity: if the same IDENT is __name-tagged with two different
    // strings across the bundle (rare but possible in name-shadowing
    // situations), we skip it entirely — safer than picking arbitrarily.
    let nameRenames = 0;
    const nameCandidates = new Map(); // ident -> Set of observed names
    for (const [, flines] of this.fileLines) {
      const helperName = _detectNameHelper(flines);
      if (!helperName) continue;
      const filePairs = _extractNameRecoveryPairs(flines, helperName);
      for (const [ident, names] of filePairs) {
        if (!nameCandidates.has(ident)) nameCandidates.set(ident, new Set());
        for (const n of names) nameCandidates.get(ident).add(n);
      }
    }
    for (const [ident, names] of nameCandidates) {
      if (names.size !== 1) continue; // ambiguous — skip
      const origName = [...names][0];
      const existing = renameMap[ident];
      // Preserve higher-tier CMD renames
      if (existing && existing.includes('_CMD_')) continue;
      // Override KW, IMPORT, or add new
      let displayName = ident + '_NAME_' + origName;
      if (displayName.length > 60) displayName = displayName.slice(0, 60);
      renameMap[ident] = displayName;
      nameRenames++;
    }

    // Persist and refresh in-memory cache (and reset the compiled regex / reverse map)
    this._renameMap = renameMap;
    this._renameRegex = null;
    this._reverseRenameMap = null;
    this._saveRenameMap(renameMap);

    if (showProgress) {
      const parts = [
        `${namesInferred} descriptive names`,
        `${cmdRenames} command names`,
        `${importRenames} import renames`,
      ];
      if (nameRenames > 0) parts.splice(2, 0, `${nameRenames} __name recoveries`);
      console.log(`Inferred ${parts.join(' + ')} → rename_map.json`);
    }

    return { namesInferred, cmdRenames, importRenames, nameRenames };
  }


  // ========================================================================
  // String table: extract, save, load, query
  // ========================================================================

  /**
   * Build a string table from all indexed files.
   * Extracts string literals (single/double/backtick), deduplicates,
   * and records where each unique string appears (file, line, function).
   *
   * @param {number} [minLength=8] - Minimum string length to include
   * @param {boolean} [showProgress=true]
   * @returns {number} count of unique strings found
   */
  buildStringTable(minLength = 8, showProgress = true) {
    this._ensureFunctionIndex();
    const strings = Object.create(null); // value -> { count, locations: [{filepath, line, func}] }
    let totalFound = 0;

    // Regex to match string literals: "...", '...', `...`
    // Handles escaped quotes. Backticks matched per-line (multi-line tracked separately).
    const strRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

    for (const [filepath, lines] of this.fileLines) {
      if (showProgress && totalFound % 10000 === 0 && totalFound > 0) {
        process.stderr.write(`  String table: ${totalFound} strings found, ${Object.keys(strings).length} unique...\r`);
      }

      // Pre-compute function boundaries for this file
      const funcBounds = this._getFuncBoundaries(filepath);

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineNum = lineIdx + 1;

        // Extract single/double quoted strings from this line
        let m;
        strRe.lastIndex = 0;
        while ((m = strRe.exec(line)) !== null) {
          const raw = m[0].slice(1, -1);
          if (raw.length < minLength) continue;

          // Unescape basic escapes
          const val = raw.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
            .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');

          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          _addString(strings, val, filepath, lineNum, func);
          totalFound++;
        }

        // Extract backtick template literals that start and end on the same line
        // (Multi-line template literal tracking is deferred — fragile across 500K+ lines)
        const btRe = /`([^`]{8,})`/g;
        while ((m = btRe.exec(line)) !== null) {
          const val = m[1].length > 4000 ? m[1].slice(0, 4000) + '...' : m[1];
          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          _addString(strings, val, filepath, lineNum, func);
          totalFound++;
        }
      }
    }

    if (showProgress) {
      process.stderr.write(`\r  String table: ${totalFound} strings found, ${Object.keys(strings).length} unique    \n`);
    }

    // Sort by count descending, then by length descending
    const sorted = Object.entries(strings)
      .map(([value, info]) => ({
        value,
        count: info.count,
        files: info.files,
        locations: info.locations.slice(0, 20), // cap locations per string
      }))
      .sort((a, b) => b.count - a.count || b.value.length - a.value.length);

    this._stringTable = sorted;

    // Save to disk
    try {
      fs.writeFileSync(this._stringTablePath(), JSON.stringify(sorted));
      if (showProgress) console.log(`Saved ${sorted.length} unique strings to string_table.json`);
    } catch (e) {
      if (showProgress) console.log(`Warning: could not save string table: ${e.message}`);
    }

    return sorted.length;
  }

  /**
   * Load string table from cache, or build if not available.
   */
  ensureStringTable(minLength = 8, showProgress = false) {
    if (this._stringTable) return this._stringTable;
    try {
      const raw = fs.readFileSync(this._stringTablePath(), 'utf-8');
      this._stringTable = JSON.parse(raw);
      return this._stringTable;
    } catch {
      // Not cached — build it
      this.buildStringTable(minLength, showProgress);
      return this._stringTable || [];
    }
  }

  /**
   * Query the string table with optional filter (substring or regex).
   * @param {object} opts
   * @param {string} [opts.filter] - Substring match or /regex/
   * @param {number} [opts.max=50] - Max results
   * @param {number} [opts.minLength=8] - Min string length
   * @returns {Array} Matching string entries
   */
  queryStringTable({ filter, max = 50, minLength = 8 } = {}) {
    const table = this.ensureStringTable(minLength);
    if (!table || table.length === 0) return [];

    let results = table;

    if (filter) {
      // Support /regex/ syntax
      const regexMatch = filter.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexMatch) {
        try {
          const re = new RegExp(regexMatch[1], regexMatch[2]);
          results = table.filter(s => re.test(s.value));
        } catch {
          results = table.filter(s => s.value.includes(filter));
        }
      } else {
        const pat = filter.toLowerCase();
        results = table.filter(s => s.value.toLowerCase().includes(pat));
      }
    }

    return results.slice(0, max);
  }

  /**
   * Find containing function from pre-computed boundaries (array format [start, end, name]).
   * Uses the same boundary format as the existing _getFuncBoundaries.
   */
  _findContainingFunctionFromBounds(bounds, lineNum) {
    // bounds is [[start, end, name], ...] sorted by start
    for (let i = bounds.length - 1; i >= 0; i--) {
      if (lineNum >= bounds[i][0] && lineNum <= bounds[i][1]) {
        return bounds[i][2];
      }
    }
    return null;
  }


  // ========================================================================
  // ========================================================================
  // Command catalog: extract CLI options, interactive commands, GUI actions
  // ========================================================================

  /**
   * Extract telemetry breadcrumbs / trace points from the codebase.
   * Detects patterns like:
   *   funcName("string_label")  — timing markers, trace points
   *   console.log("[TAG] ...")  — tagged log messages
   *   n("prefix_event_name")   — telemetry/analytics events
   *
   * Returns { markers: [...], events: [...] } sorted by line number.
   * Markers are timing/trace points (small set, ordered).
   * Events are telemetry calls (larger set, categorized by prefix).
   */
  extractBreadcrumbs(showProgress = true) {
    const markers = [];  // timing/trace points: { label, filepath, line, func }
    const events = [];   // telemetry events: { name, filepath, line, func }

    // Detect common tracing function patterns
    // Pass 1: find which function names are used as trace/timing calls
    // (e.g. Bq is used for Bq("label") timing markers in cli.js)
    // We detect these heuristically: a short-named function called many times
    // with a single string argument that looks like a label (snake_case, no spaces)
    const callCounts = Object.create(null); // funcName → count of calls with string arg
    const callSamples = Object.create(null); // funcName → sample string args

    for (const [filepath, lines] of this.fileLines) {
      const funcBounds = this._getFuncBoundaries(filepath);

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineNum = lineIdx + 1;

        // Pattern 1: shortFunc("snake_case_label") — timing/trace markers
        const markerRe = /\b([a-zA-Z_$][\w$]{0,4})\(\s*["']([a-z][a-z0-9_]+)["']\s*\)/g;
        let m;
        while ((m = markerRe.exec(line)) !== null) {
          const funcName = m[1];
          const label = m[2];
          // Must look like a trace label: snake_case with at least two underscores
          // (filters out HTTP headers like "charset", "authorization", "boundary")
          if ((label.match(/_/g) || []).length < 2) continue;
          if (label.length < 8) continue;
          callCounts[funcName] = (callCounts[funcName] || 0) + 1;
          if (!callSamples[funcName]) callSamples[funcName] = [];
          if (callSamples[funcName].length < 5) callSamples[funcName].push(label);
        }

        // Pattern 2: n("prefix_event_name", ...) — telemetry events
        // (common pattern: short func name + string starting with a prefix)
        const eventRe = /\bn\(\s*["']([a-z][a-z0-9_]+)["']/g;
        while ((m = eventRe.exec(line)) !== null) {
          const evName = m[1];
          if (!evName.includes('_') || evName.length < 5) continue;
          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          events.push({
            name: evName,
            filepath, line: lineNum,
            func: func || null,
          });
        }

        // Pattern 3: console.log("[TAG] ...") or console.warn("[TAG] ...")
        const logRe = /console\.(log|warn|error|info)\(\s*["']\[([A-Z][A-Z_ ]*)\]\s*([^"']{0,60})/g;
        while ((m = logRe.exec(line)) !== null) {
          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          markers.push({
            label: `[${m[2]}] ${m[3]}`.trim(),
            type: 'log-' + m[1],
            filepath, line: lineNum,
            func: func || null,
          });
        }

        // Pattern 4: y("[TAG] ...") — debug/verbose logging wrapper
        const yLogRe = /\by\(\s*["']\[([A-Z][A-Z_ ]*)\]\s*([^"']{0,60})/g;
        while ((m = yLogRe.exec(line)) !== null) {
          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          markers.push({
            label: `[${m[1]}] ${m[2]}`.trim(),
            type: 'debug',
            filepath, line: lineNum,
            func: func || null,
          });
        }

        // Pattern 5: General trace/debug prints with lifecycle words
        // printf("Entering %s...", ...), print("Starting init"), TRACE("init complete")
        // fprintf(stderr, "Loading configuration..."), etc.
        const lifecyclePrintRe = /(?:printf|fprintf|print|puts|TRACE|DPRINTF|LOG|DBG|debug|warn|eprint|eprogress)\s*\(\s*(?:stderr\s*,\s*)?["']([^"']{5,80})["']/g;
        while ((m = lifecyclePrintRe.exec(line)) !== null) {
          const msg = m[1].replace(/%[sdifcpx]/g, '').trim();
          // Must contain a lifecycle/phase word
          if (!/\b(init|start|end|enter|exit|begin|finish|done|complete|load|clos|open|connect|disconnect|shutdown|cleanup|setup|ready|running|stopping|creating|destroy|parsing|process|handl|dispatch|accept|listen|bind|registr|configur)\w*/i.test(msg)) continue;
          // Skip very generic messages
          if (msg.length < 8) continue;
          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          markers.push({
            label: msg.slice(0, 60),
            type: 'print',
            filepath, line: lineNum,
            func: func || null,
          });
        }

        // Pattern 6: C/C++ DEBUG/TRACE macros: DPRINTF(("message")), TRACE_ENTER, etc.
        const macroRe = /\b(?:TRACE_?(?:ENTER|EXIT|MSG)?|DEBUG_?(?:PRINT|MSG)?|LOG_?(?:DEBUG|INFO|WARN|ERROR)?|D?PRINTF)\s*\(\s*\(?["']([^"']{5,80})["']/g;
        while ((m = macroRe.exec(line)) !== null) {
          const msg = m[1].replace(/%[sdifcpx]/g, '').trim();
          if (msg.length < 5) continue;
          const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
          markers.push({
            label: msg.slice(0, 60),
            type: 'macro',
            filepath, line: lineNum,
            func: func || null,
          });
        }
      }
    }

    // Identify the trace/timing function: the short-named function called most often
    // with snake_case string labels. Must have 10+ calls to qualify.
    // Select trace functions: must have 5+ calls where labels contain lifecycle
    // words like _start, _end, _after, _before, _initialized, _loaded, _complete
    const lifecycleRe = /_(start|end|before|after|initialized|loaded|complete|begin|finish|done|init|created|resolved|configured|determined|error)/;
    const traceFuncs = Object.entries(callCounts)
      .filter(([name, count]) => {
        if (count < 5) return false;
        const samples = callSamples[name] || [];
        const lifecycleLabels = samples.filter(s => lifecycleRe.test(s));
        return lifecycleLabels.length >= 2; // at least 2 samples look like lifecycle markers
      })
      .sort((a, b) => b[1] - a[1]);

    if (traceFuncs.length > 0 && showProgress) {
      console.log(`Detected trace functions: ${traceFuncs.slice(0, 3).map(([name, count]) => name + '(' + count + ')').join(', ')}`);
    }

    // Now extract markers from the top trace function(s)
    const traceNames = new Set(traceFuncs.slice(0, 3).map(([name]) => name));
    if (traceNames.size > 0) {
      for (const [filepath, lines] of this.fileLines) {
        const funcBounds = this._getFuncBoundaries(filepath);
        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const line = lines[lineIdx];
          const lineNum = lineIdx + 1;
          const re = /\b([a-zA-Z_$][\w$]{0,4})\(\s*["']([a-z][a-z0-9_]+)["']\s*\)/g;
          let m;
          while ((m = re.exec(line)) !== null) {
            if (!traceNames.has(m[1])) continue;
            const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);
            markers.push({
              label: m[2],
              type: 'trace',
              traceFn: m[1],
              filepath, line: lineNum,
              func: func || null,
            });
          }
        }
      }
    }

    // Sort markers by line number (execution order)
    markers.sort((a, b) => a.line - b.line);

    // Deduplicate and categorize events by prefix
    const eventCategories = Object.create(null);
    for (const ev of events) {
      const prefix = ev.name.split('_').slice(0, 1)[0];
      if (!eventCategories[prefix]) eventCategories[prefix] = [];
      if (!eventCategories[prefix].some(e => e.name === ev.name && e.line === ev.line)) {
        eventCategories[prefix].push(ev);
      }
    }

    if (showProgress) {
      console.log(`Breadcrumbs: ${markers.length} trace markers, ${events.length} telemetry events`);
    }

    return { markers, events, eventCategories, traceFunctions: traceFuncs.slice(0, 5) };
  }


  /**
   * Extract a command catalog from the indexed codebase.
   * Detects multiple patterns:
   *   - Argparse/option arrays: ['name', 'type', ['--flag', '-alias']]
   *   - Switch/if dispatch: case 'command': / if (x.startsWith('/command'))
   *   - HTML data-* attributes: data-action="name", data-section="name"
   *   - Route tables: routes['/api/path'] or app.get('/path', handler)
   *   - Event registrations: addEventListener('event', handler)
   *
   * Returns { commands: [...], routes: [...], guiActions: [...], events: [...] }
   */
  extractCommandCatalog(showProgress = true) {
    const catalog = {
      cliOptions: [],    // --flag options from argparse-like definitions
      commands: [],      // /slash-commands from dispatch tables
      routes: [],        // API routes / URL handlers
      guiActions: [],    // GUI actions from data-* attributes
      events: [],        // Event handler registrations
    };

    for (const [filepath, lines] of this.fileLines) {
      const funcBounds = this._getFuncBoundaries(filepath);

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineNum = lineIdx + 1;
        const func = this._findContainingFunctionFromBounds(funcBounds, lineNum);

        // --- Pattern 1a: JS argparse option definitions ---
        // ['option_name', 'type', ['--flag', '--alias']]
        const argMatch = line.match(/\[\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*\[([^\]]+)\]\s*\]/);
        if (argMatch) {
          const aliases = argMatch[3].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [];
          if (aliases.some(a => a.startsWith('--') || a.startsWith('-'))) {
            catalog.cliOptions.push({
              name: argMatch[1],
              type: argMatch[2],
              flags: aliases,
              filepath, line: lineNum, func,
            });
          }
        }

        // --- Pattern 1b: Python argparse.add_argument ---
        // parser.add_argument(\n    '--flag', '-alias', ...
        if (line.includes('add_argument(')) {
          // Look at this line and next few for the flag names
          const snippet = lines.slice(lineIdx, Math.min(lineIdx + 6, lines.length)).join(' ');
          const flags = [];
          const flagRe = /['"](-{1,2}[\w-]+)['"]/g;
          let fm;
          while ((fm = flagRe.exec(snippet)) !== null) {
            if (fm[1].startsWith('-')) flags.push(fm[1]);
          }
          if (flags.length > 0) {
            // Extract help text if present
            const helpMatch = snippet.match(/help\s*=\s*['"]([^'"]{1,80})/);
            // Derive option name from the longest flag
            const mainFlag = flags.sort((a, b) => b.length - a.length)[0];
            const optName = mainFlag.replace(/^-+/, '').replace(/-/g, '_');
            catalog.cliOptions.push({
              name: optName,
              type: snippet.includes("action='store_true'") || snippet.includes('action="store_true"') ? 'flag' : 'value',
              flags,
              help: helpMatch ? helpMatch[1] : null,
              filepath, line: lineNum, func,
            });
          }
        }

        // --- Pattern 2: Slash-command dispatch ---
        // JS: query.startsWith('/command') or cmd === '/command'
        // Python: query.startswith('/command') or query == '/command'
        const cmdMatch = line.match(/(?:startsWith|startswith|={2,3})\s*\(?['"]\/(\w[\w-]*)/);
        if (cmdMatch) {
          const cmdName = '/' + cmdMatch[1];
          // Avoid duplicates from multiple patterns on same line
          if (!catalog.commands.some(c => c.name === cmdName && c.line === lineNum)) {
            catalog.commands.push({
              name: cmdName,
              filepath, line: lineNum, func,
            });
          }
        }

        // --- Pattern 3: Express/HTTP routes ---
        // routes['/api/path'] or app.get('/path' or app.post('/path'
        const routeMatch = line.match(/(?:routes\[|app\.(?:get|post|put|delete|use)\s*\(\s*)['"]([^'"]+)['"]/);
        if (routeMatch) {
          catalog.routes.push({
            path: routeMatch[1],
            filepath, line: lineNum, func,
          });
        }

        // --- Pattern 4: HTML data-action / data-section attributes ---
        const dataActionMatch = line.match(/data-action="([^"]+)"/);
        if (dataActionMatch) {
          catalog.guiActions.push({
            name: dataActionMatch[1],
            type: 'action',
            filepath, line: lineNum, func,
          });
        }
        const dataSectionMatch = line.match(/data-section="([^"]+)"/);
        if (dataSectionMatch) {
          catalog.guiActions.push({
            name: dataSectionMatch[1],
            type: 'section',
            filepath, line: lineNum, func,
          });
        }

        // --- Pattern 5: Declarative command registries ---
        // Objects with name + description fields: { name: "compact", description: "...", type: "local" }
        // Detect the 'name:' line and look ahead for description
        if (/^\s*name:\s*["']([^"']+)["']/.test(line)) {
          const nameMatch = line.match(/name:\s*["']([^"']+)["']/);
          if (nameMatch) {
            const cmdName = nameMatch[1];
            // Look ahead for description and type in next 5 lines
            const snippet = lines.slice(lineIdx, Math.min(lineIdx + 8, lines.length)).join('\n');
            const descMatch = snippet.match(/description:\s*["']([^"']{10,})/);
            const typeMatch = snippet.match(/type:\s*["']([^"']+)["']/);
            // Only include if there's a description (distinguishes command objects from data)
            if (descMatch) {
              catalog.commands.push({
                name: cmdName,
                type: typeMatch ? typeMatch[1] : 'command',
                description: descMatch[1].slice(0, 120),
                filepath, line: lineNum, func,
              });
            }
          }
        }

        // --- Pattern 6: Win32 RC resource menu items ---
        // MENUITEM "&Save\tCtrl+S", IDM_FILE_SAVE
        const menuItemMatch = line.match(/MENUITEM\s+"(&?[^"]+)"\s*,\s*(\w+)/);
        if (menuItemMatch) {
          const menuText = menuItemMatch[1].replace(/&/g, '').replace(/\\t.*/, '').trim();
          const cmdId = menuItemMatch[2];
          if (menuText && menuText !== 'SEPARATOR') {
            catalog.commands.push({
              name: cmdId,
              description: menuText,
              type: 'menu',
              filepath, line: lineNum, func,
            });
          }
        }

        // --- Pattern 7: Win32 #define IDM_/IDC_ command constants ---
        // Stored for cross-referencing with MENUITEM and case dispatch (not added to catalog directly)
        const idmMatch = line.match(/#define\s+(IDM_\w+)\s+/);
        if (idmMatch) {
          if (!catalog._idmDefines) catalog._idmDefines = {};
          catalog._idmDefines[idmMatch[1]] = { filepath, line: lineNum };
        }

        // --- Pattern 8: Win32 POPUP menu group ---
        // POPUP "&File"
        const popupMatch = line.match(/^\s*POPUP\s+"(&?[^"]+)"/);
        if (popupMatch) {
          const menuName = popupMatch[1].replace(/&/g, '').trim();
          catalog.guiActions.push({
            name: menuName,
            type: 'menu-group',
            filepath, line: lineNum, func,
          });
        }

        // --- Pattern 9: Switch case statements ---
        // Only include values that look like commands or action names,
        // not file extensions, MIME types, language names, or data values
        const caseMatch = line.match(/case\s+['"]([^'"]+)['"]\s*:/);
        if (caseMatch) {
          const val = caseMatch[1];
          const isCommand = val.length >= 3 && val.length <= 40 && !/^\d+$/.test(val)
              && !val.startsWith('.')          // file extensions (.js, .py)
              && !val.includes('/')            // paths or MIME types
              && !/^(text|image|audio|video|application|font)\b/.test(val) // MIME types
              && !/^(error|warning|info|debug|trace)_/.test(val) // log/error levels
              && !/^(max|min|default|timeout|retry|limit)_/i.test(val) // config keys
              && !/^(utf|iso|euc|ascii|latin|shift|windows|gb|big|koi)/i.test(val) // encodings
              && !/_(enabled|disabled|count|size|mode|type|level|status|result)$/i.test(val) // config suffixes
              && (val.includes('-') || /^[a-z]+[A-Z]/.test(val) // command-like: hyphens or camelCase
                  || /^(GET|POST|PUT|DELETE|PATCH)\b/.test(val)); // HTTP methods
          if (isCommand) {
            catalog.commands.push({
              name: val,
              type: 'case',
              filepath, line: lineNum, func,
            });
          }
        }
      }
    }

    // Deduplicate commands by name (keep first occurrence)
    const seenCmds = new Set();
    catalog.commands = catalog.commands.filter(c => {
      const key = c.name + '|' + (c.type || '');
      if (seenCmds.has(key)) return false;
      seenCmds.add(key);
      return true;
    });

    // Resolve CLI option handlers: find where args.option_name is checked
    // JS: if (args.hotspots) / args._explicit.has('hotspots')
    // Python: if args.hotspots: / elif args.hotspots:
    for (const opt of catalog.cliOptions) {
      const argName = opt.name;
      for (const [fp, flines] of this.fileLines) {
        for (let li = 0; li < flines.length; li++) {
          // Skip the argparse definition lines themselves
          if (fp === opt.filepath && Math.abs(li + 1 - opt.line) < 5) continue;

          const fline = flines[li];
          // JS dispatch: if (args.X) or args._explicit.has('X')
          // Python dispatch: if args.X: or elif args.X:
          if (fline.includes('args.' + argName) || fline.includes("'" + argName + "'")) {
            // Check it looks like a dispatch (if/elif/case), not just a reference
            const trimmed = fline.trim();
            const isDispatch = /^(if|elif|else if|case)\b/.test(trimmed) ||
                               trimmed.includes('_explicit.has');
            if (!isDispatch) continue;

            const handlerFunc = this._findContainingFunctionFromBounds(
              this._getFuncBoundaries(fp), li + 1
            );
            // Look for the called function on this or next few lines
            const snippet = flines.slice(li, Math.min(li + 3, flines.length)).join(' ');
            // JS: doSomething() / Python: do_something()
            const doMatch = snippet.match(/\b(do[_A-Z]\w+)\s*\(|await\s+(do[_A-Z]\w+)\s*\(/);
            opt.handler = {
              filepath: fp, line: li + 1,
              func: handlerFunc,
              handlerFunc: doMatch ? (doMatch[1] || doMatch[2]) : null,
            };
            break;
          }
        }
        if (opt.handler) break;
      }
    }

    // Resolve GUI action handlers: find where the action name appears in JS dispatch
    // (e.g. case 'search-fast': or data-action="search-fast" handler wiring)
    for (const action of catalog.guiActions) {
      const actionName = action.name;
      for (const [fp, flines] of this.fileLines) {
        if (fp === action.filepath) continue; // skip the HTML definition
        for (let li = 0; li < flines.length; li++) {
          const fline = flines[li];
          // Match: case 'action-name': or 'action-name' in a switch/dispatch context
          if (fline.includes("'" + actionName + "'") || fline.includes('"' + actionName + '"')) {
            const handlerFunc = this._findContainingFunctionFromBounds(
              this._getFuncBoundaries(fp), li + 1
            );
            action.handler = {
              filepath: fp, line: li + 1,
              func: handlerFunc,
            };
            break;
          }
        }
        if (action.handler) break;
      }
    }

    // Resolve Win32 MENUITEM handlers: find case IDM_*: in C++ dispatch functions
    for (const cmd of catalog.commands) {
      if (cmd.type !== 'menu') continue;
      const cmdId = cmd.name; // e.g. IDM_EDIT_PASTE
      for (const [fp, flines] of this.fileLines) {
        if (fp === cmd.filepath) continue; // skip the .rc file
        for (let li = 0; li < flines.length; li++) {
          if (flines[li].includes('case ' + cmdId + ':') || flines[li].includes('case ' + cmdId + ' :')) {
            const handlerFunc = this._findContainingFunctionFromBounds(
              this._getFuncBoundaries(fp), li + 1
            );
            cmd.handler = {
              filepath: fp, line: li + 1,
              func: handlerFunc,
            };
            break;
          }
        }
        if (cmd.handler) break;
      }
    }

    // Deduplicate CLI options: group by name, keep all source files
    const optGroups = Object.create(null);
    for (const opt of catalog.cliOptions) {
      const key = opt.name;
      if (!optGroups[key]) {
        optGroups[key] = { ...opt, sources: [{ filepath: opt.filepath, line: opt.line }] };
      } else {
        optGroups[key].sources.push({ filepath: opt.filepath, line: opt.line });
        // Prefer the one with a handler
        if (opt.handler && !optGroups[key].handler) {
          optGroups[key].handler = opt.handler;
        }
        // Prefer the one with help text
        if (opt.help && !optGroups[key].help) {
          optGroups[key].help = opt.help;
        }
      }
    }
    catalog.cliOptions = Object.values(optGroups);

    // Deduplicate commands: group by name, keep distinct source locations
    const cmdGroups = Object.create(null);
    for (const cmd of catalog.commands) {
      const key = cmd.name;
      if (!cmdGroups[key]) {
        cmdGroups[key] = { ...cmd, sources: [{ filepath: cmd.filepath, line: cmd.line, func: cmd.func }] };
      } else {
        // Only add if from a different file
        const existing = cmdGroups[key].sources;
        if (!existing.some(s => s.filepath === cmd.filepath && s.line === cmd.line)) {
          existing.push({ filepath: cmd.filepath, line: cmd.line, func: cmd.func });
        }
      }
    }
    catalog.commands = Object.values(cmdGroups);

    // Deduplicate routes and GUI actions similarly
    const routeGroups = Object.create(null);
    for (const r of catalog.routes) {
      if (!routeGroups[r.path]) routeGroups[r.path] = r;
    }
    catalog.routes = Object.values(routeGroups);

    const actionGroups = Object.create(null);
    for (const a of catalog.guiActions) {
      const key = a.name + '|' + a.type;
      if (!actionGroups[key]) actionGroups[key] = a;
    }
    catalog.guiActions = Object.values(actionGroups);

    // Assign tiers to commands:
    // primary = looks like a user-facing command (has action-like description, slash-command, etc.)
    // secondary = case values, config data, signal docs, package metadata
    for (const cmd of catalog.commands) {
      const name = cmd.name || '';
      const desc = cmd.description || '';

      // Start with: has description or is a slash-command → candidate for primary
      if (!desc && !name.startsWith('/') && !cmd.help) {
        cmd.tier = 'secondary';
        continue;
      }

      // Demote non-command patterns to secondary:
      // Unix signals (SIGALRM, SIGINT, etc.)
      if (/^SIG[A-Z]{2,}$/.test(name)) { cmd.tier = 'secondary'; continue; }
      // ALL_CAPS names without descriptions (constants, placeholders like FILE, VERSION)
      // But keep if type is 'menu' (Win32 MENUITEM with IDM_ name + menu text description)
      if (/^[A-Z][A-Z0-9_ ]+$/.test(name) && cmd.type !== 'menu') { cmd.tier = 'secondary'; continue; }
      // AWS regions and config
      if (/^aws\b/.test(name) && (/region|Cape Town|Germany/i.test(desc))) { cmd.tier = 'secondary'; continue; }
      // Package/library metadata
      if (/\b(SDK|Client for|Library for|Module for|HTTP client|processing)\b/i.test(desc)) { cmd.tier = 'secondary'; continue; }
      // Package names starting with @ (npm scoped packages)
      if (name.startsWith('@')) { cmd.tier = 'secondary'; continue; }
      // Names that start with -- (embedded tool CLI options, not commands)
      if (name.startsWith('--')) { cmd.tier = 'secondary'; continue; }
      // Filesystem/URL paths detected as slash commands (/tmp, /var, /proc, /dev, /mnt, /v1, etc.)
      if (name.startsWith('/') && /^\/(?:tmp|var|proc|dev|mnt|usr|etc|sys|opt|bin|lib|home|root|private|callback|v\d)$/i.test(name)) { cmd.tier = 'secondary'; continue; }
      // Single-word generic parameter names (command, count, duration, definition, etc.)
      if (/^[a-z]+$/.test(name) && name.length <= 10 && /^(command|count|duration|definition|install|timeout|files|find)$/.test(name) && !name.startsWith('/')) {
        // Only demote if the description doesn't sound like a user-facing action
        if (!/^(Create|Show|List|Manage|Set|Get|Open|Clear|Enable|Toggle|View|Run|Submit|Export|Import|Search|Configure)\b/.test(desc)) {
          cmd.tier = 'secondary'; continue;
        }
      }

      cmd.tier = 'primary';
    }

    // Sort each section (primary first, then alphabetical within tier)
    catalog.cliOptions.sort((a, b) => a.name.localeCompare(b.name));
    catalog.commands.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier === 'primary' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    catalog.routes.sort((a, b) => a.path.localeCompare(b.path));
    catalog.guiActions.sort((a, b) => a.name.localeCompare(b.name));

    if (showProgress) {
      const total = catalog.cliOptions.length + catalog.commands.length +
                    catalog.routes.length + catalog.guiActions.length;
      console.log(`Command catalog: ${catalog.cliOptions.length} CLI options, ` +
                  `${catalog.commands.length} commands, ${catalog.routes.length} routes, ` +
                  `${catalog.guiActions.length} GUI actions (${total} total)`);
    }

    return catalog;
  }


  // Save / Load literal index
  // ========================================================================

  _saveLiteralIndex() {
    fs.mkdirSync(this.indexPath, { recursive: true });
    const outPath = this._literalIndexPath();
    const fd = fs.openSync(outPath, 'w');

    try {
      // Write opening and metadata fields
      fs.writeSync(fd, '{\n');

      // base_path
      fs.writeSync(fd, `"base_path":${JSON.stringify(this.basePath)},\n`);

      // index_source
      fs.writeSync(fd, `"index_source":${JSON.stringify(this.indexSource)},\n`);

      // parse_method
      fs.writeSync(fd, `"parse_method":${JSON.stringify(this.parseMethod || 'regex')},\n`);

      // file_hashes
      fs.writeSync(fd, `"file_hashes":${JSON.stringify(this.fileHashes)},\n`);

      // files — write entry by entry to avoid giant string
      fs.writeSync(fd, '"files":{');
      let first = true;
      for (const [filePath, content] of this.files) {
        if (!first) fs.writeSync(fd, ',');
        first = false;
        // JSON.stringify each key and value separately — each is bounded
        // by single-file size, well under the string limit
        fs.writeSync(fd, `${JSON.stringify(filePath)}:${JSON.stringify(content)}`);
      }
      fs.writeSync(fd, '},\n');

      // file_lines — write entry by entry
      fs.writeSync(fd, '"file_lines":{');
      first = true;
      for (const [filePath, lines] of this.fileLines) {
        if (!first) fs.writeSync(fd, ',');
        first = false;
        fs.writeSync(fd, `${JSON.stringify(filePath)}:${JSON.stringify(lines)}`);
      }
      fs.writeSync(fd, '}\n');

      fs.writeSync(fd, '}\n');
    } finally {
      fs.closeSync(fd);
    }
  }

  _loadLiteralIndex() {
    const indexPath = this._literalIndexPath();
    if (!fs.existsSync(indexPath)) return false;
    try {
      const stat = fs.statSync(indexPath);
      // Use streaming parser for files > 400MB to avoid Node string limit
      if (stat.size > 400 * 1024 * 1024) {
        return this._loadLiteralIndexStreaming(indexPath);
      }
      const raw = fs.readFileSync(indexPath, 'utf-8');
      const data = JSON.parse(raw);
      this.files = new Map(Object.entries(data.files || {}));
      this.fileLines = new Map(Object.entries(data.file_lines || {}).map(
        ([k, v]) => [k, Array.isArray(v) ? v : []]
      ));
      this.basePath = data.base_path || null;
      this.indexSource = data.index_source || null;
      this.parseMethod = data.parse_method || null;
      this.fileHashes = data.file_hashes || {};
      return this.files.size > 0;
    } catch (e) {
      if (e.message && (e.message.includes('string longer than') ||
                        e.message.includes('greater than 2 GiB') ||
                        e.message.includes('File size'))) {
        // Fall back to streaming for size-related errors
        try {
          return this._loadLiteralIndexStreaming(indexPath);
        } catch (e2) {
          console.log(`Warning: Streaming load also failed: ${e2.message}`);
          return false;
        }
      }
      console.log(`Warning: Could not load literal index: ${e.message}`);
      return false;
    }
  }

  /**
   * Stream-parse a large literal_index.json (handles files of any size,
   * including >2GB). Uses chunked file reading for files that exceed
   * Node.js Buffer limit.
   */
  _loadLiteralIndexStreaming(indexPath) {
    eprint('  Loading large literal index (streaming)...');
    this.files = new Map();
    this.fileLines = new Map();
    this.basePath = null;
    this.indexSource = null;
    this.fileHashes = {};

    const { src, size } = openJSONFile(indexPath);
    let filesStart = -1, filesEnd = -1;
    let fileLinesStart = -1, fileLinesEnd = -1;

    try {
      // First pass: find byte ranges of each top-level key
      forEachEntry(src, 0, size, (key, vs, ve) => {
        switch (key) {
          case 'files':       filesStart = vs; filesEnd = ve; break;
          case 'file_lines':  fileLinesStart = vs; fileLinesEnd = ve; break;
          case 'base_path':   this.basePath = parseValue(src, vs, ve); break;
          case 'index_source': this.indexSource = parseValue(src, vs, ve); break;
          case 'parse_method': this.parseMethod = parseValue(src, vs, ve); break;
          case 'file_hashes':
            if (valueSize(vs, ve) < 100 * 1024 * 1024) {
              this.fileHashes = parseValue(src, vs, ve);
            }
            break;
        }
      });

      // Parse "files" - each entry is filepath -> metadata (small)
      if (filesStart >= 0) {
        forEachEntry(src, filesStart, filesEnd, (fp, vs, ve) => {
          this.files.set(fp, parseValue(src, vs, ve));
        });
      }

      // Parse "file_lines" - each entry is filepath -> [lines array]
      if (fileLinesStart >= 0) {
        let count = 0;
        forEachEntry(src, fileLinesStart, fileLinesEnd, (fp, vs, ve) => {
          const lines = parseValue(src, vs, ve);
          this.fileLines.set(fp, Array.isArray(lines) ? lines : []);
          count++;
          if (count % 200 === 0) eprogress(`  ... ${count} files loaded`);
        });
        eprint(`\r  Loaded ${count} files (streaming)                `);
      }
    } finally {
      closeSource(src);
    }

    return this.files.size > 0;
  }


  // ========================================================================
  // Inverted Index
  // ========================================================================

  _normalizeLine(line) {
    return line.split(/\s+/).join(' ').trim();
  }

  buildInvertedIndex(maxFileFrequency = 50, showProgress = true) {
    if (this.fileLines.size === 0) {
      console.log('No files loaded. Run buildIndex() first.');
      return;
    }
    const totalFiles = this.fileLines.size;
    if (showProgress) console.log(`Building inverted index (${totalFiles} files)...`);

    // line -> { filepath -> [lineNumbers] }
    const lineToFiles = new Map();
    let filesProcessed = 0;

    for (const [filepath, lines] of this.fileLines) {
      for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const normalized = this._normalizeLine(lines[lineNum]);
        if (normalized.length < 4) continue;

        if (!lineToFiles.has(normalized)) {
          lineToFiles.set(normalized, new Map());
        }
        const fileMap = lineToFiles.get(normalized);
        if (!fileMap.has(filepath)) {
          fileMap.set(filepath, []);
        }
        fileMap.get(filepath).push(lineNum + 1); // 1-indexed
      }
      filesProcessed++;
      if (showProgress && filesProcessed % 500 === 0) {
        console.log(`  Inverted index: processed ${filesProcessed}/${totalFiles} files (${lineToFiles.size} unique lines so far)`);
      }
    }

    // Stream directly to disk, filtering common lines, without building
    // a second copy of the data in an intermediate object.
    fs.mkdirSync(this.indexPath, { recursive: true });
    const fd = fs.openSync(this._invertedIndexPath(), 'w');
    let uniqueCount = 0;
    let skippedCommon = 0;

    const totalEntries = lineToFiles.size;
    if (showProgress) console.log(`  Writing inverted index to disk (${totalEntries} entries)...`);
    let entriesProcessed = 0;

    try {
      fs.writeSync(fd, '{');
      let first = true;

      for (const [line, fileMap] of lineToFiles) {
        if (fileMap.size > maxFileFrequency) {
          skippedCommon++;
        } else {
          if (!first) fs.writeSync(fd, ',');
          first = false;

          // Build the value array for this entry
          const locations = [];
          for (const [fp, lns] of fileMap) {
            locations.push([fp, lns]);
          }
          fs.writeSync(fd, `${JSON.stringify(line)}:${JSON.stringify(locations)}`);
          uniqueCount++;
        }
        entriesProcessed++;
        if (showProgress && entriesProcessed % 50000 === 0) {
          console.log(`  Writing: ${entriesProcessed}/${totalEntries} entries (${uniqueCount} kept, ${skippedCommon} skipped)`);
        }
      }

      fs.writeSync(fd, '}\n');
    } finally {
      fs.closeSync(fd);
    }

    // Don't hold the inverted index in memory during build — it will be
    // loaded on demand from disk when searches are run.
    this.invertedIndex = null;

    if (showProgress) {
      console.log(`Inverted index: ${uniqueCount} unique lines` +
                  ` (skipped ${skippedCommon} common lines)`);
    }
  }

  _loadInvertedIndex() {
    const indexPath = this._invertedIndexPath();
    if (!fs.existsSync(indexPath)) return false;
    try {
      const stat = fs.statSync(indexPath);
      // For large files: don't load into memory, stream on demand
      if (stat.size > 400 * 1024 * 1024) {
        return this._markInvertedOnDisk(indexPath, stat.size);
      }
      const raw = fs.readFileSync(indexPath, 'utf-8');
      this.invertedIndex = JSON.parse(raw);
      this._invertedOnDisk = false;
      return true;
    } catch (e) {
      if (e.message && (e.message.includes('string longer than') ||
                        e.message.includes('greater than 2 GiB') ||
                        e.message.includes('File size') ||
                        e.message.includes('heap'))) {
        return this._markInvertedOnDisk(indexPath);
      }
      console.log(`Warning: Could not load inverted index: ${e.message}`);
      this.invertedIndex = {};
      return false;
    }
  }

  /**
   * Mark the inverted index as too large for memory; will stream from disk.
   */
  _markInvertedOnDisk(indexPath, fileSize) {
    eprint('  Inverted index too large for memory - will stream from disk on demand.');
    this._invertedOnDisk = true;
    this._invertedDiskPath = indexPath;
    this._invertedDiskSize = fileSize || fs.statSync(indexPath).size;
    this.invertedIndex = null; // Don't hold in memory
    return true;
  }

  /**
   * Iterate every entry in the inverted index, either from memory or disk.
   * 
   * Normal mode: callback(line, locations) => false to stop early.
   * Lazy mode (lazy=true): callback(line, valueAccessor) where valueAccessor has:
   *   .parse()  - full JSON parse (returns locations array)
   *   .count()  - fast count total occurrences without full parse (~10x faster)
   * Lazy mode skips expensive JSON parsing until the callback actually needs the value.
   *
   * @param {function} callback
   * @param {boolean} [showProgress=false]
   * @param {boolean} [lazy=false] - lazy parse mode for on-disk streaming
   */
  forEachInvertedEntry(callback, showProgress = false, lazy = false) {
    // In-memory path (small indexes) - always eager, data already parsed
    if (this.invertedIndex && !this._invertedOnDisk) {
      if (lazy) {
        for (const [line, locations] of Object.entries(this.invertedIndex)) {
          const accessor = {
            parse: () => locations,
            count: () => locations.reduce((sum, [, lns]) => sum + lns.length, 0),
          };
          if (callback(line, accessor) === false) return;
        }
      } else {
        for (const [line, locations] of Object.entries(this.invertedIndex)) {
          if (callback(line, locations) === false) return;
        }
      }
      return;
    }

    // On-disk streaming path (large indexes)
    if (!this._invertedOnDisk || !this._invertedDiskPath) {
      console.log('No inverted index available.');
      return;
    }

    const { src, size } = openJSONFile(this._invertedDiskPath);
    let count = 0;
    let stopped = false;
    try {
      forEachEntry(src, 0, size, (key, vs, ve) => {
        if (stopped) return;
        count++;
        if (showProgress && count % 200000 === 0) eprogress(`  ... ${count} entries scanned`);

        if (lazy) {
          // Lazy mode: pass accessor that parses on demand
          const accessor = {
            parse: () => parseValue(src, vs, ve),
            count: () => countLocations(src, vs, ve),
          };
          if (callback(key, accessor) === false) {
            stopped = true;
          }
        } else {
          // Eager mode: parse immediately
          const locations = parseValue(src, vs, ve);
          if (callback(key, locations) === false) {
            stopped = true;
          }
        }
      });
    } finally {
      closeSource(src);
    }
    if (showProgress) eprint(`\r  Scanned ${count} inverted index entries        `);
  }

  /**
   * Ensure inverted index is available (in memory or on disk).
   * @returns {boolean}
   */
  _ensureInvertedAvailable() {
    if (this.invertedIndex) return true;
    if (this._invertedOnDisk) return true;
    return this._loadInvertedIndex();
  }

  /**
   * Count inverted index entries without loading into memory.
   * Streams through the file counting top-level keys.
   */
  getInvertedIndexCount() {
    if (this.invertedIndex) return Object.keys(this.invertedIndex).length;
    if (!this._invertedOnDisk || !this._invertedDiskPath) return 0;
    let count = 0;
    const { src, size } = openJSONFile(this._invertedDiskPath);
    try {
      forEachEntry(src, 0, size, () => { count++; });
    } finally {
      closeSource(src);
    }
    return count;
  }


  // ========================================================================
  // Function Index (regex-based parsing)
  // ========================================================================

  /**
   * Get regex patterns for detecting functions/classes by file extension.
   * Returns array of [regex, funcType, nameGroupIndex] tuples.
   */
  static _getPatternsForExt(ext) {
    // Pattern format: [regex_string, type, name_capture_group_index]
    // We use named groups (?<name>...) for clarity, but track the group name.

    const pythonPatterns = [
      [/^\s*(?:async\s+)?def\s+(\w+)\s*\(/, 'function', 1],
      [/^\s*class\s+(\w+)/, 'class', 1],
    ];

    const cLikePatterns = [
      // Google Test macros: TEST_P(Suite, Name), TEST_F(Suite, Name), TEST(Suite, Name), etc.
      // Treated as functions named Suite::Name (like class methods)
      [/^\s*(?:TEST_F|TEST_P|TEST|TYPED_TEST|TYPED_TEST_P|TYPED_TEST_SUITE|TEST_CASE)\s*\(\s*(\w+)\s*,\s*(\w+)/, 'function', -1],
      // C++ constructor: ClassName::ClassName(args) {
      [/^\s*([\w]+::[\w]+)\s*\([^;]*\)\s*(?::\s*[\w()\s,]+)?\s*\{?\s*$/, 'function', 1],
      // C++ destructor: ClassName::~ClassName() {
      [/^\s*([\w]+::~[\w]+)\s*\([^;]*\)\s*\{?\s*$/, 'function', 1],
      // C++ class method: return type + Class::Method(args) on SAME line
      [/^[\w\s*&<>:]+\s+([\w:]+::[\w~]+)\s*\([^;]*\)\s*(?:const)?\s*(?:override)?\s*\{?\s*$/, 'function', 1],
      // C++ class method: return type + Class::Method( with args on NEXT line(s)
      // e.g. "Region OcclusionTracker::ComputeVisibleRegionInScreen("
      [/^[\w\s*&<>:]+\s+([\w:]+::[\w~]+)\s*\([^);]*$/, 'function', 1],
      // C++ class method with return type on PREVIOUS line (Chromium/Google style):
      //   ReturnType\n
      //   ClassName::MethodName(args) const {\n
      // Matches: Qualified::Name( at start of line (not preceded by = or return etc.)
      [/^([\w]+(?:::[\w~]+)+)\s*\(/, 'function', 1],
      // Plain C function / inline class method: ReturnType funcname(args) {
      // Allow :: in return type for qualified types like cc::Layer*
      [/^\s*[a-zA-Z_][\w\s*&:<>,]*\s+(\w+)\s*\([^;]*\)\s*\{?\s*$/, 'function', 1],
      // Plain C function: ReturnType funcname( with args on next line(s)
      [/^\s*[a-zA-Z_][\w\s*&:<>,]*\s+(\w+)\s*\([^);]*$/, 'function', 1],
      // C++ class/struct - skip export macros like CC_EXPORT, BLINK_EXPORT, COMPONENT_EXPORT(viz)
      // Export macros are ALL_CAPS words containing underscore, optionally with (args)
      [/^\s*(?:template\s*<[^>]*>\s*)?class\s+(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:\([^)]*\))?\s+)*(\w+)/, 'class', 1],
      [/^\s*(?:template\s*<[^>]*>\s*)?struct\s+(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:\([^)]*\))?\s+)*(\w+)/, 'class', 1],
    ];

    const javaPatterns = [
      [/^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|native|strictfp)\s+)*(?:[\w<>\[\],.\s]+\s+)?(\w+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{?\s*$/, 'function', 1],
      [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|static)\s+)*interface\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|static)\s+)*enum\s+(\w+)/, 'class', 1],
    ];

    const jsPatterns = [
      [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, 'function', 1],
      [/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/, 'function', 1],
      [/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\b/, 'function', 1],
      // Class method shorthand
      [/^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*\{\s*$/, 'function', 1],
      [/^\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)/, 'class', 1],
    ];

    const goPatterns = [
      [/^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/, 'function', 1],
      [/^\s*type\s+(\w+)\s+struct/, 'class', 1],
    ];

    const rustPatterns = [
      [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, 'function', 1],
      [/^\s*(?:pub\s+)?struct\s+(\w+)/, 'class', 1],
      [/^\s*(?:pub\s+)?impl\s+(\w+)/, 'class', 1],
    ];

    const perlPatterns = [
      [/^\s*sub\s+(\w+)/, 'function', 1],
      [/^\s*package\s+([\w:]+)/, 'class', 1],
    ];

    const phpPatterns = [
      [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+(\w+)/, 'function', 1],
      [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 'class', 1],
      [/^\s*interface\s+(\w+)/, 'class', 1],
      [/^\s*trait\s+(\w+)/, 'class', 1],
    ];

    const rubyPatterns = [
      [/^\s*def\s+(\w+)/, 'function', 1],
      [/^\s*class\s+(\w+)/, 'class', 1],
      [/^\s*module\s+(\w+)/, 'class', 1],
    ];

    const coffeePatterns = [
      [/^\s*(\w+)\s*[:=]\s*\([^)]*\)\s*[-=]>/, 'function', 1],
      [/^\s*(\w+)\s*[:=]\s*[-=]>/, 'function', 1],
      [/^\s*class\s+(\w+)/, 'class', 1],
    ];

    const vbsPatterns = [
      [/^\s*(?:Public\s+|Private\s+)?(?:Sub|Function)\s+(\w+)/i, 'function', 1],
      [/^\s*Class\s+(\w+)/i, 'class', 1],
    ];

    const awkPatterns = [
      [/^\s*function\s+(\w+)/, 'function', 1],
    ];

    const csPatterns = [
      // C# methods (similar to Java)
      [/^\s*(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|partial)\s+)*(?:[\w<>\[\],.\s]+\s+)?(\w+)\s*\([^)]*\)\s*\{?\s*$/, 'function', 1],
      [/^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal)\s+)*interface\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+(\w+)/, 'class', 1],
    ];

    const swiftPatterns = [
      // Swift functions: func name(args) { or func name(args) -> Type {
      [/^\s*(?:(?:public|private|internal|fileprivate|open|static|class|override|final|mutating)\s+)*func\s+(\w+)/, 'function', 1],
      // init / deinit
      [/^\s*(?:(?:public|private|internal|fileprivate|open|required|convenience|override)\s+)*(init)\s*\(/, 'function', 1],
      // struct / class / enum / protocol
      [/^\s*(?:(?:public|private|internal|fileprivate|open|final)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|internal|fileprivate|open)\s+)*struct\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|internal|fileprivate|open)\s+)*enum\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|internal|fileprivate|open)\s+)*protocol\s+(\w+)/, 'class', 1],
    ];

    const kotlinPatterns = [
      // Kotlin: fun name(args) or fun name(args): Type
      [/^\s*(?:(?:public|private|protected|internal|open|override|abstract|final|inline|suspend)\s+)*fun\s+(?:<[^>]+>\s+)?(\w+)/, 'function', 1],
      // Kotlin: class / object / interface / enum / data class / sealed class
      [/^\s*(?:(?:public|private|protected|internal|open|abstract|sealed|data|inner|value)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal)\s+)*(?:companion\s+)?object\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal|sealed)\s+)*interface\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+class\s+(\w+)/, 'class', 1],
    ];

    const scalaPatterns = [
      // Scala: def name(args) or def name: Type
      [/^\s*(?:(?:private|protected|override|final|implicit|lazy)\s+)*def\s+(\w+)/, 'function', 1],
      // Scala: class / object / trait / case class
      [/^\s*(?:(?:private|protected|abstract|sealed|final|case|implicit)\s+)*class\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:private|protected)\s+)?(?:case\s+)?object\s+(\w+)/, 'class', 1],
      [/^\s*(?:(?:private|protected|sealed)\s+)*trait\s+(\w+)/, 'class', 1],
    ];

    const luaPatterns = [
      // Lua: function name(args) or local function name(args)
      [/^\s*(?:local\s+)?function\s+(\w[\w.]*)/, 'function', 1],
      // Lua: name = function(args) (common module pattern)
      [/^\s*(?:local\s+)?(\w+)\s*=\s*function\s*\(/, 'function', 1],
    ];

    const objcPatterns = [
      // Objective-C instance method: - (ReturnType)methodName  or  - (ReturnType)methodName:(Type)param
      [/^\s*[-+]\s*\([^)]*\)\s*(\w+)/, 'function', 1],
      // C function (also common in .m files)
      [/^[a-zA-Z_][\w\s*&]*\s+(\w+)\s*\([^;]*\)\s*\{?\s*$/, 'function', 1],
      // @interface ClassName or @implementation ClassName
      [/^\s*@interface\s+(\w+)/, 'class', 1],
      [/^\s*@implementation\s+(\w+)/, 'class', 1],
      // @protocol ClassName
      [/^\s*@protocol\s+(\w+)/, 'class', 1],
    ];

    switch (ext) {
      case '.py': case '.pyw':
        return pythonPatterns;
      case '.c': case '.cpp': case '.h': case '.hpp':
      case '.cc': case '.cxx': case '.c++': case '.h++': case '.hxx':
        return cLikePatterns;
      case '.java':
        return javaPatterns;
      case '.js': case '.ts': case '.jsx': case '.tsx':
      case '.mjs': case '.cjs': case '.hbs':
        return jsPatterns;
      case '.coffee':
        return [...coffeePatterns, ...jsPatterns];
      case '.go':
        return goPatterns;
      case '.rs':
        return rustPatterns;
      case '.pl': case '.pm':
        return perlPatterns;
      case '.php':
        return phpPatterns;
      case '.rb':
        return rubyPatterns;
      case '.vbs': case '.bas':
        return vbsPatterns;
      case '.awk':
        return awkPatterns;
      case '.cs':
        return csPatterns;
      case '.swift':
        return swiftPatterns;
      case '.kt': case '.kts':
        return kotlinPatterns;
      case '.scala': case '.sc':
        return scalaPatterns;
      case '.lua':
        return luaPatterns;
      case '.m': case '.mm':
        return objcPatterns;
      default:
        if (TEXT_EXTENSIONS.has(ext)) return [];
        return [...pythonPatterns, ...cLikePatterns]; // Best guess
    }
  }

  static SKIP_KEYWORDS = new Set([
    'if', 'else', 'while', 'for', 'switch', 'catch', 'return',
    'sizeof', 'typeof', 'elif', 'except', 'finally', 'with'
  ]);

  /**
   * Parse functions from a single file using regex patterns.
   * @param {string} filepath
   * @returns {Object} { funcName -> {start, end, type, base_name} }
   */
  _parseFunctionsRegex(filepath) {
    const lines = this.fileLines.get(filepath);
    if (!lines) return {};

    const ext = path.extname(filepath).toLowerCase();
    const patterns = CodeSearchIndex._getPatternsForExt(ext);
    if (patterns.length === 0) return {};

    const fileFunctions = {};
    let currentFunc = null;
    let currentStart = null;
    let currentClass = null;
    let classIndent = -1;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      const line = lines[lineIdx];

      // Track indentation for class scope
      const stripped = line.trimStart();
      const indent = stripped ? (line.length - stripped.length) : 999;

      for (const [regex, funcType, nameGroup] of patterns) {
        const match = line.match(regex);
        if (!match) continue;

        // nameGroup -1: composite name from groups 1+2 (e.g. TEST_P(Suite, Name) → Suite::Name)
        let name = nameGroup === -1 ? (match[1] + '::' + match[2]) : match[nameGroup];
        if (!name || CodeSearchIndex.SKIP_KEYWORDS.has(name)) continue;

        // Close previous function at line before this one
        if (currentFunc && currentStart) {
          fileFunctions[currentFunc].end = lineNum - 1;
        }

        if (funcType === 'class') {
          currentClass = name;
          classIndent = indent;
        } else if (funcType === 'function') {
          // Check if inside a class
          if (currentClass && indent > classIndent && !name.includes('::')) {
            name = currentClass + '::' + name;
          }
        }

        // Close class scope if at same or less indent
        if (funcType !== 'class' && currentClass && indent <= classIndent) {
          currentClass = null;
          classIndent = -1;
        }

        // Handle duplicate function names
        let storedName = name;
        if (name in fileFunctions) {
          storedName = `${name}@${lineNum}`;
        }

        currentFunc = storedName;
        currentStart = lineNum;
        const bare = name.includes('::') ? name.split('::').pop() : name;

        fileFunctions[storedName] = {
          start: lineNum,
          end: null,
          // If name contains ::, it's a method - even without a class declaration
          // in this file (the class may be declared in a .h we didn't index)
          type: (funcType !== 'class' && name.includes('::')) ? 'method' : funcType,
          base_name: bare,
        };
        break; // First matching pattern wins
      }
    }

    // Close last function at end of file
    if (currentFunc && fileFunctions[currentFunc] && fileFunctions[currentFunc].end === null) {
      fileFunctions[currentFunc].end = lines.length;
    }

    // Post-process: fix truncated functions using brace counting.
    // When inner constructs (object literal methods, nested functions) match
    // patterns, the outer function gets prematurely terminated. Detect this
    // by checking if the extracted body has unbalanced braces - more '{' than '}'.
    for (const [fname, info] of Object.entries(fileFunctions)) {
      // Only applies to functions whose start line contains '{'
      const startLine = lines[info.start - 1] || '';
      if (!startLine.includes('{')) continue;

      // Count braces in current span
      let depth = 0;
      for (let i = info.start - 1; i < info.end && i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
      }

      // If balanced (depth === 0), function boundaries are correct
      if (depth <= 0) continue;

      // Unbalanced: scan forward from end to find matching '}'
      let remaining = depth;
      let foundEnd = null;
      for (let i = info.end; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') remaining++;
          else if (ch === '}') {
            remaining--;
            if (remaining === 0) {
              foundEnd = i + 1; // 1-indexed
              break;
            }
          }
        }
        if (foundEnd !== null) break;
      }

      if (foundEnd !== null && foundEnd > info.end) {
        info.end = foundEnd;
      }
    }

    // Re-sort overlapping: if a brace-expanded function now encloses others,
    // those inner functions should be kept (they're real inner functions).
    // No action needed - the function index supports overlapping ranges.

    return fileFunctions;
  }

  buildFunctionIndex(showProgress = true) {
    if (this.fileLines.size === 0) {
      console.log('No files loaded. Run buildIndex() first.');
      return;
    }
    if (showProgress) console.log('Building function index...');

    this.functionIndex = {};
    let totalFunctions = 0;

    for (const [filepath] of this.fileLines) {
      const fileFuncs = this._parseFunctionsRegex(filepath);
      if (Object.keys(fileFuncs).length > 0) {
        this.functionIndex[filepath] = fileFuncs;
        totalFunctions += Object.keys(fileFuncs).length;
      }
    }

    // Save
    fs.mkdirSync(this.indexPath, { recursive: true });
    fs.writeFileSync(this._functionIndexPath(),
                     JSON.stringify(this.functionIndex, null, 2), 'utf-8');

    this.parseMethod = 'regex';
    if (showProgress) {
      console.log(`Function index: ${totalFunctions} functions in ` +
                  `${Object.keys(this.functionIndex).length} files`);
    }
  }

  async buildFunctionIndexTreeSitter(showProgress = true) {
    if (this.fileLines.size === 0) {
      console.log('No files loaded. Run buildIndex() first.');
      return;
    }

    const { TreeSitterParser } = await import('./TreeSitterParser.js');
    const tsParser = new TreeSitterParser();
    const initOk = await tsParser.init();
    if (!initOk) {
      console.log('Warning: tree-sitter init failed, falling back to regex.');
      this.buildFunctionIndex(showProgress);
      return;
    }

    const available = tsParser.getAvailableGrammars();
    const missing = tsParser.getMissingGrammars();
    if (showProgress) {
      console.log(`Building function index with tree-sitter (${available.length} grammars available)...`);
      if (missing.length > 0) {
        console.log(`  Missing grammars (will use regex): ${missing.join(', ')}`);
      }
    }

    this.functionIndex = {};
    let totalFunctions = 0;
    let tsCount = 0;
    let regexCount = 0;
    let tsFailedCount = 0;

    for (const [filepath, lines] of this.fileLines) {
      const tsFuncs = await tsParser.parseFunctions(filepath, lines);
      const regexFuncs = this._parseFunctionsRegex(filepath);
      let fileFuncs;

      if (tsFuncs && Object.keys(tsFuncs).length > 0) {
        // Hybrid merge: tree-sitter boundaries + regex-only entries (nested fns)
        fileFuncs = { ...tsFuncs };
        for (const [name, info] of Object.entries(regexFuncs)) {
          if (!(name in fileFuncs)) fileFuncs[name] = info;
        }
        tsCount++;
      } else if (tsFuncs === null) {
        // No grammar or parse failed — regex only
        fileFuncs = regexFuncs;
        regexCount++;
      } else {
        // tsFuncs was {} (parsed but found nothing) — use regex
        fileFuncs = regexFuncs;
        if (Object.keys(fileFuncs).length > 0) {
          regexCount++;
        } else {
          tsCount++;
        }
      }

      if (Object.keys(fileFuncs).length > 0) {
        this.functionIndex[filepath] = fileFuncs;
        totalFunctions += Object.keys(fileFuncs).length;
      }
    }

    // Save
    fs.mkdirSync(this.indexPath, { recursive: true });
    fs.writeFileSync(this._functionIndexPath(),
                     JSON.stringify(this.functionIndex, null, 2), 'utf-8');

    this.parseMethod = tsCount > 0 && regexCount > 0 ? 'tree-sitter+regex'
                     : tsCount > 0 ? 'tree-sitter' : 'regex';

    if (showProgress) {
      console.log(`Function index: ${totalFunctions} functions in ` +
                  `${Object.keys(this.functionIndex).length} files`);
      console.log(`  tree-sitter: ${tsCount} files, regex fallback: ${regexCount} files` +
                  (tsFailedCount > 0 ? `, tree-sitter failures: ${tsFailedCount}` : ''));
    }
  }

  _loadFunctionIndex() {
    const indexPath = this._functionIndexPath();
    if (!fs.existsSync(indexPath)) {
      this.functionIndex = {};
      return false;
    }
    try {
      const raw = fs.readFileSync(indexPath, 'utf-8');
      this.functionIndex = JSON.parse(raw);
      return true;
    } catch (e) {
      console.log(`Warning: Could not load function index: ${e.message}`);
      this.functionIndex = {};
      return false;
    }
  }

  _ensureFunctionIndex() {
    if (!this.functionIndex) {
      this._loadFunctionIndex();
    }
  }

  /**
   * Validate index integrity: check which required files exist and are parseable.
   * Returns { valid: boolean, files: { name: status }, warnings: string[] }
   */
  validateIndex() {
    const warnings = [];
    const files = {};
    const checks = [
      { name: 'literal_index.json',   path: this._literalIndexPath(),  required: true },
      { name: 'inverted_index.json',  path: this._invertedIndexPath(), required: true },
      { name: 'function_index.json',  path: this._functionIndexPath(), required: true },
    ];
    for (const c of checks) {
      if (!fs.existsSync(c.path)) {
        files[c.name] = 'missing';
        warnings.push(`${c.name} is missing` + (c.required ? ' (required)' : ''));
      } else {
        try {
          const stat = fs.statSync(c.path);
          if (stat.size === 0) {
            files[c.name] = 'empty';
            warnings.push(`${c.name} exists but is empty (0 bytes)`);
          } else {
            files[c.name] = 'ok';
          }
        } catch (e) {
          files[c.name] = 'unreadable';
          warnings.push(`${c.name} exists but cannot be read: ${e.message}`);
        }
      }
    }
    const valid = files['literal_index.json'] === 'ok' &&
                  files['function_index.json'] === 'ok' &&
                  files['inverted_index.json'] === 'ok';
    return { valid, files, warnings };
  }


  // ========================================================================
  // Build Index
  // ========================================================================

  /**
   * Build search index from a code directory, file, glob pattern, or @filelist.
   * @param {string} codePath
   * @param {object} [opts]
   * @param {number} [opts.chunkSize=50]
   * @param {boolean} [opts.showProgress=true]
   * @param {boolean} [opts.skipSemantic=true]
   * @returns {object} stats
   */
  async buildIndex(codePath, { chunkSize = 50, showProgress = true, skipSemantic = true, demanglerPath = null, useTreeSitter = false, renameMinLines = 0 } = {}) {
    const stats = { files_indexed: 0, total_lines: 0, chunks_created: 0, errors: [], prettified: 0 };
    const codePathStr = codePath.trim();

    let files = [];
    let basePath;

    if (codePathStr.startsWith('@')) {
      // @file.txt - list of files
      const listFile = codePathStr.slice(1);
      if (!fs.existsSync(listFile)) {
        console.log(`File list not found: ${listFile}`);
        return stats;
      }
      const isWSL = process.platform === 'linux' && fs.existsSync('/mnt/c');
      const fileList = fs.readFileSync(listFile, 'utf-8')
        .split('\n')
        .map(l => l.trim().replace(/\r$/, ''))
        .filter(l => l && !l.startsWith('#'))
        .map(l => {
          // Convert Windows paths to WSL /mnt/ paths when running under WSL
          if (isWSL && /^[A-Za-z]:\\/.test(l)) {
            return '/mnt/' + l[0].toLowerCase() + l.slice(2).replace(/\\/g, '/');
          }
          return l;
        });

      if (fileList.length === 0) {
        console.log(`No files listed in: ${listFile}`);
        return stats;
      }

      const existing = [];
      const missing = [];
      for (const p of fileList) {
        if (fs.existsSync(p)) {
          existing.push(path.resolve(p));
        } else {
          missing.push(p);
        }
      }
      if (missing.length > 0 && showProgress) {
        console.log(`Warning: ${missing.length} files not found (first 5: ${missing.slice(0, 5).join(', ')})`);
      }
      files = existing;
      basePath = files.length > 0 ? this._commonPath(files) : process.cwd();
      if (showProgress) {
        console.log(`Read ${files.length} files from: ${listFile}`);
      }

    } else if (codePathStr.includes('*') || codePathStr.includes('?')) {
      // Glob/wildcard pattern
      const globPattern = codePathStr.replace(/\\/g, '/');
      if (!globPattern.includes('**') && showProgress) {
        console.log(`Note: For recursive search, use **/*.ext`);
      }
      const matched = _globSync(globPattern);
      files = matched.map(p => path.resolve(p));
      basePath = files.length > 0 ? this._commonPath(files) : process.cwd();
      if (showProgress) {
        console.log(`Glob pattern '${codePathStr}' matched ${files.length} files`);
      }

    } else {
      // Single file or directory
      const resolved = path.resolve(codePathStr);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        files = [resolved];
        basePath = path.dirname(resolved);
      } else if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        files = this._walkDir(resolved);
        basePath = resolved;
      } else {
        console.log(`Path not found: ${resolved}`);
        return stats;
      }
    }

    this.basePath = basePath;
    if (codePathStr.startsWith('@')) {
      this.indexSource = `file list: ${codePathStr}`;
    } else if (codePathStr.includes('*') || codePathStr.includes('?')) {
      this.indexSource = `glob: ${codePathStr}`;
    } else {
      this.indexSource = basePath;
    }

    if (showProgress && !codePathStr.startsWith('@') && !codePathStr.includes('*')) {
      console.log(`Indexing ${files.length} files from: ${basePath}`);
    }

    // Separate files into categories: source, archive, executable, and skip
    const sourceFiles = [];
    const archiveFiles = [];
    const executableFiles = [];
    let mediaSkipped = 0;
    let unsupportedArchives = 0;

    for (const fp of files) {
      const ext = path.extname(fp).toLowerCase();
      const lower = fp.toLowerCase();
      // Check compound .tar.gz first
      if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
        if (isSupportedArchive(fp)) {
          archiveFiles.push(fp);
        } else {
          unsupportedArchives++;
        }
      } else if (ARCHIVE_EXTENSIONS.has(ext)) {
        if (isSupportedArchive(fp)) {
          archiveFiles.push(fp);
        } else {
          unsupportedArchives++;
        }
      } else if (MEDIA_BINARY_EXTENSIONS.has(ext)) {
        mediaSkipped++;
      } else if (EXECUTABLE_EXTENSIONS.has(ext) || BINSTRING_EXTENSIONS.has(ext)) {
        executableFiles.push(fp);
      } else {
        sourceFiles.push(fp);
      }
    }

    if (showProgress) {
      if (mediaSkipped > 0) {
        console.log(`  Skipped ${mediaSkipped} media/binary files (images, audio, video, fonts, docs)`);
      }
      if (unsupportedArchives > 0) {
        console.log(`  Skipped ${unsupportedArchives} unsupported archives (.7z, .rar, .bz2, .xz)`);
      }
      if (archiveFiles.length > 0) {
        console.log(`  Found ${archiveFiles.length} archive(s) to expand`);
      }
      if (executableFiles.length > 0) {
        console.log(`  Found ${executableFiles.length} executable(s) to process (binstrings)`);
      }
    }

    // SHA1 file-level dedup
    const seenHashes = new Map(); // sha1 -> firstRelPath
    const fileHashes = {};        // sha1 -> [allRelPaths]
    let dupesSkipped = 0;

    // Helper to add a file (by content + relPath) into the index
    const _addFileToIndex = (relPath, content, rawBytes) => {
      const fileHash = rawBytes
        ? crypto.createHash('sha1').update(rawBytes).digest('hex')
        : crypto.createHash('sha1').update(content, 'utf-8').digest('hex');

      if (!fileHashes[fileHash]) fileHashes[fileHash] = [];
      fileHashes[fileHash].push(relPath);

      if (seenHashes.has(fileHash)) {
        dupesSkipped++;
        return false;
      }
      seenHashes.set(fileHash, relPath);

      this.files.set(relPath, content);
      const lines = content.split('\n');
      this.fileLines.set(relPath, lines);
      stats.total_lines += lines.length;
      stats.files_indexed++;

      if (showProgress && stats.files_indexed % 100 === 0) {
        process.stdout.write(`  Indexed ${stats.files_indexed} files...\n`);
      }
      return true;
    };

    // --- Phase 1: Index regular source files ---
    for (const filePath of sourceFiles) {
      try {
        const rawBytes = fs.readFileSync(filePath);
        let content = rawBytes.toString('utf-8');

        let relPath;
        try {
          relPath = path.relative(basePath, filePath);
        } catch {
          relPath = path.basename(filePath);
        }
        relPath = relPath.replace(/\\/g, '/');

        // Deobfuscate/prettify minified JS/TS so functions are parseable
        if (isMinified(relPath, content)) {
          // Step 1: Simple regex deobfuscation (!0→true, !1→false, void 0→undefined)
          content = deobfuscateSimple(content);

          // Step 2: Try webcrack for small files (deobfuscation + prettification)
          const deobfuscated = await tryWebcrack(content);
          if (deobfuscated) {
            content = deobfuscated;
            stats.deobfuscated = (stats.deobfuscated || 0) + 1;
          } else if (_jsBeautify) {
            // Step 3: Fall back to js-beautify (formatting only)
            try {
              // break_chained_methods=true puts each `.foo()` in a chain on
              // its own line — critical for Commander.js-style `.option().option()`
              // chains (cli.js GCz) which otherwise stay as one 10K-char line.
              content = _jsBeautify(content, {
                indent_size: 2,
                max_preserve_newlines: 2,
                break_chained_methods: true,
              });
              stats.prettified++;
            } catch { /* beautify failed — use original */ }
          }
        }


        _addFileToIndex(relPath, content, rawBytes);
      } catch (e) {
        stats.errors.push(`${filePath}: ${e.message}`);
      }
    }

    // --- Phase 2: Expand and index archives ---
    let totalArchiveFiles = 0;
    let totalBinstringsFromArchives = 0;
    for (const archivePath of archiveFiles) {
      try {
        let relArchive;
        try {
          relArchive = path.relative(basePath, archivePath);
        } catch {
          relArchive = path.basename(archivePath);
        }
        relArchive = relArchive.replace(/\\/g, '/');

        const archiveStats = createArchiveStats();
        const entries = expandArchive(archivePath, {
          archiveName: relArchive,
          extensions: this.extensions,
          showProgress,
          demanglerPath,
          stats: archiveStats,
        });

        for (const entry of entries) {
          try {
            _addFileToIndex(entry.virtualPath, entry.content, null);
          } catch (e) {
            stats.errors.push(`${entry.virtualPath}: ${e.message}`);
          }
        }

        totalArchiveFiles += archiveStats.files;
        totalBinstringsFromArchives += archiveStats.binstringsProcessed;
      } catch (e) {
        stats.errors.push(`Archive ${archivePath}: ${e.message}`);
      }
    }

    if (showProgress && totalArchiveFiles > 0) {
      console.log(`  Indexed ${totalArchiveFiles} files from ${archiveFiles.length} archive(s)`);
    }

    // --- Phase 3: Process executables via binstrings ---
    let binstringsProcessed = 0;
    for (const exePath of executableFiles) {
      try {
        const rawBytes = fs.readFileSync(exePath);

        let relPath;
        try {
          relPath = path.relative(basePath, exePath);
        } catch {
          relPath = path.basename(exePath);
        }
        relPath = relPath.replace(/\\/g, '/');

        const opResult = processBinary(rawBytes, relPath, { demanglerPath });
        if (opResult) {
          const opPath = relPath + '.op';
          _addFileToIndex(opPath, opResult.content, null);
          binstringsProcessed++;
        }
      } catch (e) {
        stats.errors.push(`Binstrings ${exePath}: ${e.message}`);
      }
    }

    if (showProgress && binstringsProcessed > 0) {
      console.log(`  Processed ${binstringsProcessed} executables (binstrings)`);
    }

    this.fileHashes = fileHashes;
    stats.dupes_skipped = dupesSkipped;
    stats.unique_files = seenHashes.size;
    stats.total_files_scanned = sourceFiles.length + totalArchiveFiles + binstringsProcessed;
    stats.archives_expanded = archiveFiles.length;
    stats.archive_files = totalArchiveFiles;
    stats.binstrings_processed = binstringsProcessed + totalBinstringsFromArchives;

    if (showProgress && dupesSkipped > 0) {
      const dupeGroups = Object.values(fileHashes).filter(p => p.length > 1).length;
      console.log(`  SHA1 dedup: ${dupesSkipped} duplicate files detected ` +
                  `(${dupeGroups} groups); originals indexed, copies tracked`);
    }

    // Save literal index
    this._saveLiteralIndex();

    // Free raw file contents — fileLines is sufficient for inverted + function indexing.
    // this.files will be reloaded from disk if the index is used after building.
    const fileCount = this.files.size;
    this.files = new Map();

    // Build inverted index
    this.buildInvertedIndex(50, showProgress);

    // Build function index
    if (useTreeSitter) {
      await this.buildFunctionIndexTreeSitter(showProgress);
    } else {
      this.buildFunctionIndex(showProgress);
    }

    // Infer descriptive names for ALL opaque-named functions.
    // Extracts top keywords from each function's body. Works on any codebase.
    // Saved as rename_map.json — applied at DISPLAY time, not to stored content.
    const { namesInferred, cmdRenames, importRenames } = this.inferAndSaveRenameMap({ showProgress, minFuncLines: renameMinLines });
    if (namesInferred > 0 || cmdRenames > 0 || importRenames > 0) {
      stats.namesInferred = namesInferred;
      stats.cmdRenames = cmdRenames;
      stats.importRenames = importRenames;
    }

    // Build string table
    if (showProgress) console.log('Building string table...');
    const stringCount = this.buildStringTable(8, showProgress);
    stats.strings = stringCount;

    // Reconstruct this.files from fileLines now that memory-heavy build is done.
    for (const [fp, lines] of this.fileLines) {
      this.files.set(fp, lines.join('\n'));
    }

    // Save literal index
    this._saveLiteralIndex();

    // Reload inverted index from disk (was streamed to disk, not kept in memory)
    this._loadInvertedIndex();

    if (showProgress) {
      let dedupNote = '';
      if (dupesSkipped > 0) {
        dedupNote = ` (${stats.total_files_scanned} scanned, ${dupesSkipped} duplicates registered)`;
      }
      let archiveNote = '';
      if (archiveFiles.length > 0) {
        archiveNote = `, ${totalArchiveFiles} from ${archiveFiles.length} archive(s)`;
      }
      let binNote = '';
      const totalBin = binstringsProcessed + totalBinstringsFromArchives;
      if (totalBin > 0) {
        binNote = `, ${totalBin} binaries processed`;
      }
      let prettyNote = '';
      const deob = stats.deobfuscated || 0;
      const pretty = stats.prettified || 0;
      const namesInferred = stats.namesInferred || 0;
      if (deob > 0 || pretty > 0 || namesInferred > 0) {
        const parts = [];
        if (deob > 0) parts.push(`${deob} deobfuscated`);
        if (pretty > 0) parts.push(`${pretty} prettified`);
        if (namesInferred > 0) parts.push(`${namesInferred} names inferred`);
        prettyNote = `, ${parts.join(', ')}`;
      }
      console.log(`Indexing complete: ${stats.files_indexed} files${dedupNote}${archiveNote}${binNote}${prettyNote}, ` +
                  `${stats.total_lines} lines, ${stats.chunks_created} chunks`);
    }

    return stats;
  }

  /**
   * Recursively walk a directory, returning files with matching extensions.
   * Skips common infrastructure directories that never contain project source.
   * @param {string} dirPath
   * @returns {string[]}
   */
  _walkDir(dirPath) {
    const results = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip common infrastructure directories
          const dirName = entry.name.toLowerCase();
          if (_SKIP_DIRS.has(dirName) || dirName.startsWith('.')) continue;
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const lower = entry.name.toLowerCase();
          // Include source files (by extension, excluding compound like .d.ts)
          if (this.extensions.has(ext) &&
              !this._isCompoundExcluded(entry.name)) {
            results.push(fullPath);
          }
          // Also include supported archive files for expansion
          else if (isSupportedArchive(lower)) {
            results.push(fullPath);
          }
          // Also include executable files for binstrings processing
          else if (EXECUTABLE_EXTENSIONS.has(ext) || BINSTRING_EXTENSIONS.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    };
    walk(dirPath);
    return results;
  }

  /**
   * Check if a filename should be excluded due to a compound extension.
   * E.g., 'index.d.ts' is excluded when '.d.ts' is in _excludeCompound,
   * even though path.extname() would return '.ts'.
   * @param {string} filename - Just the filename (not full path)
   * @returns {boolean}
   */
  _isCompoundExcluded(filename) {
    if (this._excludeCompound.size === 0) return false;
    const lower = filename.toLowerCase();
    for (const ext of this._excludeCompound) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

  /**
   * Find common path prefix for an array of absolute paths.
   */
  _commonPath(paths) {
    if (paths.length === 0) return process.cwd();
    if (paths.length === 1) return path.dirname(paths[0]);
    const parts = paths.map(p => p.replace(/\\/g, '/').split('/'));
    const common = [];
    for (let i = 0; i < parts[0].length; i++) {
      const segment = parts[0][i];
      if (parts.every(p => p[i] === segment)) {
        common.push(segment);
      } else {
        break;
      }
    }
    const result = common.join(path.sep);
    // If result is a file, return its directory
    try {
      if (fs.existsSync(result) && fs.statSync(result).isFile()) {
        return path.dirname(result);
      }
    } catch { /* ignore */ }
    return result || process.cwd();
  }


  // ========================================================================
  // Search: Literal
  // ========================================================================

  /**
   * Literal text search across all indexed files.
   * @param {string} pattern - text or regex pattern
   * @param {object} [opts]
   * @param {boolean} [opts.caseSensitive=false]
   * @param {boolean} [opts.useRegex=false]
   * @param {number} [opts.maxResults=100]
   * @param {number} [opts.contextLines=3]
   * @returns {SearchResult[]}
   */
  searchLiteral(pattern, { caseSensitive = false, useRegex = false,
                           maxResults = 100, contextLines = 3,
                           filterStringContext = false } = {}) {
    if (this.files.size === 0) {
      console.log('No files indexed. Run buildIndex() first.');
      return [];
    }

    let regex;
    const flags = caseSensitive ? '' : 'i';
    try {
      regex = useRegex
        ? new RegExp(pattern, flags)
        : new RegExp(escapeRegex(pattern), flags);
    } catch (e) {
      console.log(`Invalid regex: ${e.message}`);
      return [];
    }

    // For string-context filtering we need match positions, not just boolean.
    // Build a global-flag version once and reuse via lastIndex.
    const reG = filterStringContext
      ? new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
      : null;

    const results = [];

    for (const [filePath, lines] of this.fileLines) {
      // #10: cross-line state for block-comment and template-literal tracking,
      // reset per file. Used only when filterStringContext is on.
      let carryState = 'code';

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const lineNum = lineIdx + 1;
        const line = lines[lineIdx];

        let matched;
        if (filterStringContext) {
          // Compute end state for next line BEFORE filtering this one
          const endState = _scanLineState(line, carryState);

          // If the line is wholly inside a block comment / template that
          // never exits, no match can possibly be valid — skip cleanly.
          const wholeLineSkipped =
            (carryState === 'bc' && endState === 'bc') ||
            (carryState === 't'  && endState === 't');

          if (wholeLineSkipped) {
            matched = false;
          } else {
            // Walk all matches; accept the line if any match falls outside a
            // string literal or comment context.
            reG.lastIndex = 0;
            matched = false;
            let m;
            while ((m = reG.exec(line)) !== null) {
              if (!_isInsideString(line, m.index, carryState)) {
                matched = true;
                break;
              }
              if (m[0].length === 0) reG.lastIndex++;
            }
          }

          // Carry over block-comment / template state to next line
          carryState = (endState === 'bc' || endState === 't') ? endState : 'code';
        } else {
          matched = regex.test(line);
        }

        if (!matched) continue;

        // Get context
        const start = Math.max(0, lineNum - contextLines - 1);
        const end = Math.min(lines.length, lineNum + contextLines);
        const ctxLines = lines.slice(start, end);
        const context = ctxLines
          .map((l, i) => `${String(start + i + 1).padStart(4)}: ${l}`)
          .join('\n');

        // Find containing function
        const funcName = this._findContainingFunction(filePath, lineNum);

        results.push(new SearchResult({
          filePath, lineNumber: lineNum,
          lineText: line.trim(),
          context, matchType: 'literal',
          score: 0.0, functionName: funcName,
        }));

        if (results.length >= maxResults) return results;
      }
    }
    return results;
  }


  // ========================================================================
  // Search: Inverted Index (fast)
  // ========================================================================

  /**
   * Fast search using inverted index.
   * @param {string} pattern
   * @param {object} [opts]
   * @param {boolean} [opts.useRegex=false]
   * @param {boolean} [opts.caseSensitive=false]
   * @param {number} [opts.maxResults=100]
   * @returns {SearchResult[]}
   */
  searchInverted(pattern, { useRegex = false, caseSensitive = false,
                            maxResults = 100 } = {}) {
    if (!this._ensureInvertedAvailable()) {
      console.log('No inverted index. Run with --build-index first.');
      return [];
    }

    let regex;
    const flags = caseSensitive ? '' : 'i';
    try {
      regex = useRegex
        ? new RegExp(pattern, flags)
        : new RegExp(escapeRegex(pattern), flags);
    } catch (e) {
      console.log(`Invalid regex: ${e.message}`);
      return [];
    }

    const results = [];

    this.forEachInvertedEntry((line, locations) => {
      if (!regex.test(line)) return;

      for (const [filepath, lineNumbers] of locations) {
        for (const lineNum of lineNumbers) {
          const funcName = this._findContainingFunction(filepath, lineNum);

          let ctx = line;
          const lines = this.fileLines.get(filepath);
          if (lines) {
            const start = Math.max(0, lineNum - 4);
            const end = Math.min(lines.length, lineNum + 3);
            ctx = lines.slice(start, end)
              .map((l, i) => `${String(start + i + 1).padStart(4)}: ${l}`)
              .join('\n');
          }

          results.push(new SearchResult({
            filePath: filepath, lineNumber: lineNum,
            lineText: line, context: ctx,
            matchType: 'inverted', score: 0.0,
            functionName: funcName,
          }));

          if (results.length >= maxResults) return false; // early stop
        }
      }
    });
    return results;
  }


  // ========================================================================
  // Search: Hybrid (literal + semantic)
  // ========================================================================

  searchHybrid(query, { maxResults = 10, contextLines = 3 } = {}) {
    const results = [];
    const seenLocations = new Set();

    // Literal search first
    const literalResults = this.searchLiteral(query, { maxResults, contextLines });
    for (const r of literalResults) {
      const loc = `${r.filePath}:${r.lineNumber}`;
      if (!seenLocations.has(loc)) {
        seenLocations.add(loc);
        results.push(r);
      }
    }

    // Semantic search would go here (Phase 8)

    return results;
  }


  // ========================================================================
  // Containing function lookup
  // ========================================================================

  /**
   * Get sorted function boundaries for fast bisect-based lookup.
   * Returns sorted array of [startLine, endLine, funcName].
   */
  _getFuncBoundaries(filepath) {
    this._ensureFunctionIndex();
    if (!this.functionIndex || !this.functionIndex[filepath]) return [];

    const funcs = this.functionIndex[filepath];
    const boundaries = [];
    for (const [name, info] of Object.entries(funcs)) {
      const start = info.start || 0;
      const end = info.end || 999999999;
      // Use full qualified name (e.g. "SecureChannel.encrypt_data")
      // so that callers can extract class context.
      boundaries.push([start, end, name]);
    }
    boundaries.sort((a, b) => a[0] - b[0]);
    return boundaries;
  }

  /**
   * Find containing function for a line number using bisect.
   */
  static _bisectFuncLookup(boundaries, lineNum) {
    if (boundaries.length === 0) return null;
    // Binary search: find rightmost boundary whose start <= lineNum
    let lo = 0, hi = boundaries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (boundaries[mid][0] <= lineNum) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const idx = lo - 1;
    if (idx >= 0) {
      const [start, end, name] = boundaries[idx];
      if (start <= lineNum && lineNum <= end) {
        return name;
      }
    }
    return null;
  }

  /**
   * Find containing function/method for a given line.
   * Uses function index if available (fast), else backward regex scan (slow).
   */
  _findContainingFunction(filePath, lineNumber) {
    // Try fast bisect path first
    const boundaries = this._getFuncBoundaries(filePath);
    if (boundaries.length > 0) {
      return CodeSearchIndex._bisectFuncLookup(boundaries, lineNumber);
    }

    // Fallback: backward regex scan
    const lines = this.fileLines.get(filePath);
    if (!lines || lineNumber < 1 || lineNumber > lines.length) return null;

    const patterns = [
      [/^\s*(?:async\s+)?def\s+(\w+)\s*\(/, 1],
      [/^\s*class\s+(\w+)/, 1],
      [/^([\w]+(?:::[\w~]+)+)\s*\(/, 1],  // C++ multi-line: Class::Method( at column 0
      [/^\s*(?:[\w*&\s]+\s+)?(\w+)\s*\([^;]*$/, 1],
      [/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/, 1],
      [/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, 1],
      [/^\s*(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/, 1],
      [/^\s*func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/, 1],
      [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/, 1],
    ];

    const skipKw = CodeSearchIndex.SKIP_KEYWORDS;

    for (let i = lineNumber - 1; i >= 0; i--) {
      const line = lines[i];
      for (const [regex, groupIdx] of patterns) {
        const match = line.match(regex);
        if (match) {
          const name = match[groupIdx];
          if (name && !skipKw.has(name)) return name;
        }
      }
    }
    return null;
  }


  // ========================================================================
  // Function source extraction
  // ========================================================================

  /**
   * Extract complete source code for a function.
   */
  getFunctionSource(filepath, functionName) {
    this._ensureFunctionIndex();

    // Case-insensitive filepath matching
    const fpLower = filepath.toLowerCase();
    if (!this.functionIndex[filepath]) {
      const matches = Object.keys(this.functionIndex)
        .filter(f => fpLower === f.toLowerCase() || f.toLowerCase().includes(fpLower));
      if (matches.length === 1) {
        filepath = matches[0];
      } else if (matches.length > 1) {
        console.log(`Ambiguous filepath '${filepath}'. Matches: ${matches.slice(0, 5).join(', ')}`);
        return null;
      } else {
        console.log(`File not found in index: ${filepath}`);
        return null;
      }
    }

    const fileFuncs = this.functionIndex[filepath];

    let funcInfo;
    if (fileFuncs[functionName]) {
      funcInfo = fileFuncs[functionName];
    } else {
      // Try matching by base_name
      const matches = Object.entries(fileFuncs)
        .filter(([, info]) => (info.base_name || functionName) === functionName);

      if (matches.length === 0) {
        const available = Object.keys(fileFuncs).slice(0, 10).join(', ');
        console.log(`Function '${functionName}' not found. Available: ${available}`);
        return null;
      } else if (matches.length === 1) {
        funcInfo = matches[0][1];
      } else {
        console.log(`Multiple versions of '${functionName}' found:`);
        for (const [name, info] of matches) {
          console.log(`  ${name}: L${info.start}-${info.end}`);
        }
        return null;
      }
    }

    const lines = this.fileLines.get(filepath);
    if (!lines) {
      console.log(`File content not loaded: ${filepath}`);
      return null;
    }

    const start = funcInfo.start;
    let end = funcInfo.end;

    // Brace-balance check at extraction time.
    // Handles pre-built indexes where inner functions truncated the outer.
    // If the stored range has unbalanced braces, extend to the matching '}'.
    const startLine = lines[start - 1] || '';
    if (startLine.includes('{')) {
      let depth = 0;
      for (let li = start - 1; li < end && li < lines.length; li++) {
        for (const ch of lines[li]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
      }
      if (depth > 0) {
        // Unbalanced - scan forward to find matching '}'
        let remaining = depth;
        for (let li = end; li < lines.length; li++) {
          for (const ch of lines[li]) {
            if (ch === '{') remaining++;
            else if (ch === '}') {
              remaining--;
              if (remaining === 0) {
                end = li + 1; // 1-indexed
                break;
              }
            }
          }
          if (remaining === 0) break;
        }
      }
    }

    let rawLines = lines.slice(start - 1, end);

    // Trim trailing comments belonging to next function
    let trimEnd = rawLines.length;
    while (trimEnd > 1) {
      const line = rawLines[trimEnd - 1].trim();
      if (!line) { trimEnd--; continue; }
      if (line.startsWith('//') || line.startsWith('#') ||
          line.startsWith('*') || line.startsWith('/*') ||
          line.startsWith('/**') || line.endsWith('*/') ||
          line.startsWith('"""') || line.startsWith("'''") ||
          line.startsWith('@')) {
        trimEnd--;
      } else {
        break;
      }
    }
    rawLines = rawLines.slice(0, trimEnd);

    // Prepend preceding doc comment above function
    const commentLines = [];
    let i = start - 2; // 0-indexed: line above function def
    let consecutiveBlanks = 0;
    while (i >= 0) {
      const line = lines[i].trim();
      if (!line) {
        consecutiveBlanks++;
        if (consecutiveBlanks > 1) break;
        commentLines.unshift(lines[i]);
        i--;
      } else if (line.startsWith('//') || line.startsWith('#') ||
                 line.startsWith('*') || line.startsWith('/*') ||
                 line.startsWith('/**') || line.endsWith('*/') ||
                 line.startsWith('"""') || line.startsWith("'''") ||
                 line.startsWith('@')) {
        consecutiveBlanks = 0;
        commentLines.unshift(lines[i]);
        i--;
      } else {
        break;
      }
    }
    // Strip leading blank lines from collected comments
    while (commentLines.length > 0 && !commentLines[0].trim()) {
      commentLines.shift();
    }

    return [...commentLines, ...rawLines].join('\n');
  }


  // ========================================================================
  // Function listing & matching
  // ========================================================================

  /**
   * List all indexed functions, optionally filtered by file.
   * @param {string|null} filepath - optional substring filter
   * @returns {Array<{filepath,name,displayName,start,end,type,lines}>}
   */
  listFunctions(filepath = null) {
    this._ensureFunctionIndex();
    const results = [];
    const filterPath = filepath ? filepath.toLowerCase().replace(/\\/g, '/') : null;

    for (const [fpath, functions] of Object.entries(this.functionIndex || {})) {
      if (filterPath) {
        const fpathNorm = fpath.toLowerCase().replace(/\\/g, '/');
        if (!fpathNorm.includes(filterPath)) continue;
      }
      for (const [name, info] of Object.entries(functions)) {
        const lineCount = info.end - info.start + 1;
        results.push({
          filepath: fpath,
          name,
          displayName: displayName(name, fpath),
          start: info.start,
          end: info.end,
          type: info.type,
          lines: lineCount,
        });
      }
    }
    return results;
  }

  /**
   * Find all functions matching a name, optionally filtered by file path.
   */
  findFunctionMatches(funcName, fileHint = null) {
    this._ensureFunctionIndex();
    const fileHintNorm = fileHint ? fileHint.toLowerCase().replace(/\\/g, '/') : null;
    // If the caller supplied a display name (renamed form), reverse-resolve to
    // the indexed (bare/original) name so callers from the GUI — which get
    // display names in list responses — can round-trip back.
    if (this.getOriginalName) {
      const orig = this.getOriginalName(funcName);
      if (orig && orig !== funcName) funcName = orig;
    }
    const wasQualified = funcName.includes('.') || funcName.includes('::');
    const funcNameNorm = (funcName.includes('.') && !funcName.includes('::'))
      ? funcName.replace(/\./g, '::')
      : funcName;
    const bareName = funcNameNorm.includes('::')
      ? funcNameNorm.split('::').pop()
      : funcNameNorm;

    const matches = [];

    for (const [filepath, functions] of Object.entries(this.functionIndex || {})) {
      if (fileHintNorm) {
        const fpNorm = filepath.toLowerCase().replace(/\\/g, '/');
        if (!fpNorm.includes(fileHintNorm)) continue;
      }

      for (const [fullName, info] of Object.entries(functions)) {
        let indexedBare = info.base_name || fullName.split('::').pop();
        if (indexedBare.includes('@')) indexedBare = indexedBare.split('@')[0];
        const fullNameBase = fullName.includes('@') ? fullName.split('@')[0] : fullName;

        let isMatch = false;
        if (wasQualified) {
          if (fullNameBase === funcNameNorm || fullName === funcNameNorm) {
            isMatch = true;
          }
        } else {
          if (fullName === funcNameNorm || indexedBare === bareName ||
              fullName.endsWith('::' + bareName)) {
            isMatch = true;
          }
        }

        if (isMatch) {
          matches.push({
            filepath, name: fullName,
            start: info.start, end: info.end,
            type: info.type || 'function',
          });
        }
      }
    }
    return matches;
  }

  /**
   * Extract function source by name, with optional file hint.
   */
  extractFunctionByName(funcName, fileHint = null) {
    const matches = this.findFunctionMatches(funcName, fileHint);

    if (matches.length === 0) {
      if (fileHint) {
        console.log(`Function '${funcName}' not found in files matching '${fileHint}'.`);
        console.log(`  Tip: Use --list-functions "${funcName}" --full-path to find exact paths`);
      } else {
        console.log(`Function '${funcName}' not found in index.`);
        console.log(`  Tip: Use --list-functions "PATTERN" --full-path to search`);
      }
      return null;
    }

    if (matches.length === 1) {
      const m = matches[0];
      const source = this.getFunctionSource(m.filepath, m.name);
      if (source) {
        console.log(`# ${m.filepath}@${displayName(m.name, m.filepath)}`);
        return source;
      }
      return null;
    }

    // Multiple matches
    this._lastExtractMatches = matches;
    console.log(`Multiple functions match '${funcName}':`);
    for (let i = 0; i < Math.min(matches.length, 20); i++) {
      const m = matches[i];
      const lines = m.end - m.start + 1;
      console.log(`  [${i + 1}] ${m.filepath}@${displayName(m.name, m.filepath)} (${lines} lines)`);
    }
    if (matches.length > 20) {
      console.log(`  ... and ${matches.length - 20} more`);
    }
    console.log(`\nSelect by number: /extract [N]  or narrow with: /extract FILE@FUNCTION`);
    return null;
  }


  // ========================================================================
  // Path matching and file listing
  // ========================================================================

  listFiles() {
    return [...this.files.keys()].sort();
  }

  findPathMatches(pattern) {
    if (!pattern || pattern.length < 2) return [];
    const patLower = pattern.toLowerCase();
    const fileMatches = [];

    for (const filepath of this.files.keys()) {
      if (filepath.toLowerCase().includes(patLower)) {
        fileMatches.push(filepath);
      }
    }

    const dirsSeen = new Set();
    for (const filepath of fileMatches) {
      const parts = filepath.replace(/\\/g, '/').split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i].toLowerCase().includes(patLower)) {
          const dirPath = parts.slice(0, i + 1).join('/');
          dirsSeen.add(dirPath);
        }
      }
    }

    return [...dirsSeen].sort().concat(fileMatches.filter(f => !dirsSeen.has(f)));
  }

  /**
   * Scan a directory and count all file extensions.
   * @param {string} dirPath
   * @returns {Object<string, number>}
   */
  static scanExtensions(dirPath) {
    if (!fs.existsSync(dirPath)) {
      console.log(`Path not found: ${dirPath}`);
      return {};
    }
    const counts = {};
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const dirName = entry.name.toLowerCase();
          if (_SKIP_DIRS.has(dirName) || dirName.startsWith('.')) continue;
          walk(full);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase() || '(no extension)';
          counts[ext] = (counts[ext] || 0) + 1;
        }
      }
    };
    walk(dirPath);
    // Sort by count descending
    return Object.fromEntries(
      Object.entries(counts).sort((a, b) => b[1] - a[1])
    );
  }


  // ========================================================================
  // Stats
  // ========================================================================

  getStats() {
    let totalLines = 0;
    for (const lines of this.fileLines.values()) {
      totalLines += lines.length;
    }
    const stats = {
      files_indexed: this.files.size,
      total_lines: totalLines,
      semantic_available: false,
      parse_method: this.parseMethod || 'regex',
    };

    const fileHashes = this.fileHashes || {};
    const hashEntries = Object.values(fileHashes);
    if (hashEntries.length > 0) {
      const dupeGroups = hashEntries.filter(p => p.length > 1).length;
      const totalDupes = hashEntries.filter(p => p.length > 1)
        .reduce((sum, p) => sum + p.length - 1, 0);
      stats.unique_hashes = hashEntries.length;
      stats.dupe_groups = dupeGroups;
      stats.dupes_removed = totalDupes;
    }
    return stats;
  }

  // ========================================================================
  // Dupe helpers (used by browse commands)
  // ========================================================================

  _buildFileDupeLookup() {
    if (this._fileDupeLookup) return this._fileDupeLookup;
    const lookup = {};
    for (const paths of Object.values(this.fileHashes || {})) {
      if (paths.length > 1) {
        for (const p of paths) {
          lookup[p] = paths.filter(x => x !== p);
        }
      }
    }
    this._fileDupeLookup = lookup;
    return lookup;
  }

  getFileDupeCount(filepath) {
    const lookup = this._buildFileDupeLookup();
    return (lookup[filepath] || []).length;
  }

  getFileDupes(filepath) {
    const lookup = this._buildFileDupeLookup();
    return lookup[filepath] || [];
  }


  // ========================================================================
  // Containing function lookup (from index - more accurate)
  // ========================================================================

  /**
   * Find the function containing a given line using the function index.
   * More accurate than regex-based _findContainingFunction - handles nesting.
   */
  _findContainingFunctionFromIndex(filepath, lineNumber) {
    this._ensureFunctionIndex();
    if (!this.functionIndex || !this.functionIndex[filepath]) {
      // Try partial match
      const matches = Object.keys(this.functionIndex || {})
        .filter(f => filepath.toLowerCase() === f.toLowerCase() || f.toLowerCase().includes(filepath.toLowerCase()));
      if (matches.length === 1) {
        filepath = matches[0];
      } else {
        return null;
      }
    }

    const fileFuncs = this.functionIndex[filepath] || {};
    let containing = null;
    let containingSize = Infinity;

    for (const [funcName, info] of Object.entries(fileFuncs)) {
      if (info.start <= lineNumber && lineNumber <= info.end) {
        const size = info.end - info.start;
        if (size < containingSize) {
          containing = funcName;
          containingSize = size;
        }
      }
    }
    return containing;
  }


  // ========================================================================
  // Known functions cache
  // ========================================================================

  /**
   * Build and cache a lookup of all known function bare names -> definitions.
   * Also builds a qualified index (Class::method -> definitions) for disambiguation.
   * @returns {Object<string, Array>} bare_name -> [{filepath, full_name, start, end, type, class_name}]
   */
  _getKnownFunctions() {
    if (this._knownFunctionsCache) return this._knownFunctionsCache;

    this._ensureFunctionIndex();
    const known = Object.create(null);
    const qualified = Object.create(null);  // "Class::method" -> [defs]

    for (const [fpath, functions] of Object.entries(this.functionIndex || {})) {
      for (const [fname, info] of Object.entries(functions)) {
        let bare = fname.includes('::') ? fname.split('::').pop() : fname;
        bare = bare.includes('.') ? bare.split('.').pop() : bare;

        // Extract class name from qualified "Class::method"
        let className = null;
        if (fname.includes('::')) {
          const parts = fname.split('::');
          if (parts.length >= 2) {
            className = parts.slice(0, -1).join('::');
          }
        }

        const def = {
          filepath: fpath,
          full_name: fname,
          start: info.start,
          end: info.end,
          type: info.type || 'function',
          class_name: className,
        };

        if (!known[bare]) known[bare] = [];
        known[bare].push(def);

        // Qualified index
        if (className) {
          const qKey = `${className}::${bare}`;
          if (!qualified[qKey]) qualified[qKey] = [];
          qualified[qKey].push(def);
        }
      }
    }

    this._knownFunctionsCache = known;
    this._qualifiedFunctionsCache = qualified;
    return known;
  }

  /**
   * Get the qualified functions cache (Class::method -> defs).
   * Must call _getKnownFunctions() first.
   */
  _getQualifiedFunctions() {
    if (!this._qualifiedFunctionsCache) this._getKnownFunctions();
    return this._qualifiedFunctionsCache;
  }

  /**
   * Build and cache a map of class -> [parent classes] from source code.
   * Parses inheritance patterns for Python, C++, Java, JS/TS, C#, Ruby.
   *
   * @returns {Map<string, string[]>} className -> [parentClassNames]
   */
  _getInheritanceMap() {
    if (this._inheritanceMapCache) return this._inheritanceMapCache;

    const imap = new Map();

    // Patterns: each yields [childName, ...parentNames]
    const patterns = [
      // Python: class Child(Parent):  or  class Child(Base, Mixin):
      /^\s*class\s+(\w+)\s*\(\s*([^)]+)\s*\)\s*:/,
      // C++: class Derived : public Base {  or  class D : public B, public C {
      // Also handles private/protected inheritance
      /^\s*(?:template\s*<[^>]*>\s*)?class\s+(?:[A-Z][A-Z0-9]*_[A-Z0-9_]*(?:\([^)]*\))?\s+)*(\w+)\s*:\s*(.+?)\s*\{/,
      // C++ struct: struct Derived : Base {
      /^\s*(?:template\s*<[^>]*>\s*)?struct\s+(\w+)\s*:\s*(.+?)\s*\{/,
      // Java/C#: class Sub extends Super {  or  class Sub extends Super implements I, J {
      /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*class\s+(\w+)\s+extends\s+(\w+)/,
      // Java/C# implements (secondary parents)
      /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*class\s+(\w+)\s+(?:extends\s+\w+\s+)?implements\s+(.+?)(?:\s*\{|$)/,
      // JS/TS: class Child extends Parent {
      /^\s*(?:export\s+)?class\s+(\w+)\s+extends\s+(\w+)/,
      // Ruby: class Child < Parent
      /^\s*class\s+(\w+)\s*<\s*(\w+)/,
      // Objective-C: @interface Child : Parent
      /^\s*@interface\s+(\w+)\s*:\s*(\w+)/,
    ];

    // Pre-filter: only scan files that contain class declarations (from function index).
    // This avoids scanning all fileLines on large indexes (20K+ files → OOM).
    let filesToScan;
    this._ensureFunctionIndex();
    if (this.functionIndex && Object.keys(this.functionIndex).length > 0) {
      const classFiles = new Set();
      for (const [fpath, functions] of Object.entries(this.functionIndex)) {
        for (const info of Object.values(functions)) {
          if (info.type === 'class') { classFiles.add(fpath); break; }
        }
      }
      // Also include files whose names suggest class definitions but weren't indexed as classes
      // (e.g., files with 'extends' or inheritance that the function parser missed)
      filesToScan = classFiles.size > 0 ? classFiles : null;
    } else {
      filesToScan = null;  // no function index → scan all
    }

    for (const [filepath, lines] of this.fileLines) {
      if (filesToScan && !filesToScan.has(filepath)) continue;
      for (const line of lines) {
        for (const pat of patterns) {
          const m = pat.exec(line);
          if (!m) continue;

          const childName = m[1];
          const parentStr = m[2];

          // Parse parent names from the match
          const parents = [];
          // Split by comma, strip qualifiers like "public", "protected", "private", generic params
          for (let p of parentStr.split(',')) {
            p = p.trim()
              .replace(/^\s*(?:public|private|protected|virtual)\s+/g, '')
              .replace(/<[^>]*>/g, '')  // strip generics
              .trim();
            // Extract just the class name (last word)
            const nameMatch = p.match(/(\w+)\s*$/);
            if (nameMatch) {
              const parentName = nameMatch[1];
              // Skip common non-class tokens
              if (!['object', 'Object', 'type', 'class', 'struct', 'enum'].includes(parentName)) {
                parents.push(parentName);
              }
            }
          }

          if (parents.length > 0) {
            // Merge with any existing parents (could be declared in multiple files)
            const existing = imap.get(childName) || [];
            for (const p of parents) {
              if (!existing.includes(p)) existing.push(p);
            }
            imap.set(childName, existing);
          }
          break; // Only first matching pattern per line
        }
      }
    }

    this._inheritanceMapCache = imap;
    return imap;
  }

  /**
   * Get all ancestor classes for a given class, walking up the inheritance chain.
   * Returns ancestors in order: immediate parents first, then grandparents, etc.
   * Handles diamond inheritance and cycles safely.
   *
   * @param {string} className
   * @returns {string[]} ancestor class names
   */
  _getAncestorClasses(className) {
    const imap = this._getInheritanceMap();
    const ancestors = [];
    const visited = new Set();
    const queue = [className];
    visited.add(className);

    while (queue.length > 0) {
      const current = queue.shift();
      const parents = imap.get(current);
      if (!parents) continue;
      for (const p of parents) {
        if (!visited.has(p)) {
          visited.add(p);
          ancestors.push(p);
          queue.push(p);
        }
      }
    }
    return ancestors;
  }

  /**
   * Resolve which definition of a callee is most likely being called,
   * given the call-site context.
   *
   * Priority order:
   *   1. Explicit qualification: ClassName::method() or ClassName.method()
   *   2. self/this prefix: self.method() or this->method() → same class as caller
   *   3. Same-class definition (caller is ClassA::foo, callee ClassA::bar exists)
   *   4. Same-file definition
   *   5. Closest directory path
   *   6. Fall back to first definition
   *
   * @param {string} bareName - Bare callee name
   * @param {string} line - Source line containing the call
   * @param {string|null} callerClass - Class of the calling function (or null)
   * @param {string} callerFilepath - File containing the call site
   * @param {Array} defs - All definitions with this bare name
   * @returns {{def: object, resolvedName: string, ambiguous: boolean}}
   */
  _resolveCalleeTarget(bareName, line, callerClass, callerFilepath, defs) {
    if (!defs || defs.length === 0) return { def: null, resolvedName: bareName, ambiguous: false };
    if (defs.length === 1) return { def: defs[0], resolvedName: defs[0].full_name, ambiguous: false };

    // 1. Check for explicit qualification in the source line
    //    e.g., ClassName::method(, ClassName.method(, ClassName->method(
    const qualRe = new RegExp(
      '([A-Z][A-Za-z0-9_]*)\\s*(?:::|\\.|->)\\s*' + escapeRegex(bareName) + '\\s*\\('
    );
    const qualMatch = qualRe.exec(line);
    if (qualMatch) {
      const explicitClass = qualMatch[1];
      // Find def matching this class
      const match = defs.find(d => d.class_name === explicitClass);
      if (match) return { def: match, resolvedName: match.full_name, ambiguous: false };
      // Try partial match (class name might be just the leaf)
      const partialMatch = defs.find(d =>
        d.class_name && d.class_name.endsWith(explicitClass)
      );
      if (partialMatch) return { def: partialMatch, resolvedName: partialMatch.full_name, ambiguous: false };

      // 1b. Explicit class might be a child class — walk up its chain
      const ancestors = this._getAncestorClasses(explicitClass);
      for (const ancestor of ancestors) {
        const inheritMatch = defs.find(d => d.class_name === ancestor);
        if (inheritMatch) return { def: inheritMatch, resolvedName: inheritMatch.full_name, ambiguous: false };
      }
    }

    // 2. Check for self/this prefix → same class as caller, or inherited
    const selfRe = new RegExp(
      '(?:self|this)\\s*(?:\\.|->)\\s*' + escapeRegex(bareName) + '\\s*\\('
    );
    if (selfRe.test(line) && callerClass) {
      const match = defs.find(d => d.class_name === callerClass);
      if (match) return { def: match, resolvedName: match.full_name, ambiguous: false };

      // 2b. Not in caller's class — check parent classes (inherited method)
      const ancestors = this._getAncestorClasses(callerClass);
      for (const ancestor of ancestors) {
        const inheritMatch = defs.find(d => d.class_name === ancestor);
        if (inheritMatch) return { def: inheritMatch, resolvedName: inheritMatch.full_name, ambiguous: false };
      }
    }

    // 3. Same-class definition (if caller is in a class)
    if (callerClass) {
      const match = defs.find(d => d.class_name === callerClass);
      if (match) return { def: match, resolvedName: match.full_name, ambiguous: false };

      // 3b. Walk inheritance chain for bare calls too
      const ancestors = this._getAncestorClasses(callerClass);
      for (const ancestor of ancestors) {
        const inheritMatch = defs.find(d => d.class_name === ancestor);
        if (inheritMatch) return { def: inheritMatch, resolvedName: inheritMatch.full_name, ambiguous: false };
      }
    }

    // 4. Same-file definition
    const sameFile = defs.filter(d => d.filepath === callerFilepath);
    if (sameFile.length === 1) return { def: sameFile[0], resolvedName: sameFile[0].full_name, ambiguous: false };

    // 5. Closest directory path
    const srcParts = callerFilepath.replace(/\\/g, '/').toLowerCase().split('/');
    const srcDir = srcParts.slice(0, -1);
    let best = null, bestScore = -1;
    for (const d of defs) {
      const tgtParts = d.filepath.replace(/\\/g, '/').toLowerCase().split('/');
      const tgtDir = tgtParts.slice(0, -1);
      let shared = 0;
      for (let i = 0; i < Math.min(srcDir.length, tgtDir.length); i++) {
        if (srcDir[i] === tgtDir[i]) shared++;
        else break;
      }
      if (shared > bestScore) { bestScore = shared; best = d; }
    }
    if (best) return { def: best, resolvedName: best.full_name, ambiguous: defs.length > 1 };

    // 6. Fall back
    return { def: defs[0], resolvedName: defs[0].full_name, ambiguous: true };
  }


  // ========================================================================
  // Find callers
  // ========================================================================

  /**
   * Find all locations where a function is called.
   * @param {string} functionName
   * @param {number} [maxResults=500]
   * @returns {Array<{filepath, line_number, line_text, caller_function, call_type}>}
   */
  findCallers(functionName, maxResults = 500) {
    if (!this._ensureInvertedAvailable()) {
      console.log('No inverted index. Build index first.');
      return [];
    }
    this._ensureFunctionIndex();

    // Extract bare name
    let bareName = functionName.includes('::') ? functionName.split('::').pop() : functionName;
    bareName = bareName.includes('.') ? bareName.split('.').pop() : bareName;

    // Build call patterns
    // Use case-insensitive only for longer names (5+ chars) where case collisions
    // are unlikely. Short names like 'lo' vs 'lO' are distinct in JS/TS.
    const caseFlag = bareName.length >= 5 ? 'i' : '';
    const callPatterns = [
      ['direct', new RegExp('(?<![a-zA-Z_])' + escapeRegex(bareName) + '\\s*\\(', caseFlag)],
    ];

    // Qualified pattern (always case-sensitive — qualified names are precise)
    if (functionName.includes('::')) {
      const parts = functionName.split('::');
      if (parts.length >= 2) {
        callPatterns.push([
          'qualified',
          new RegExp(escapeRegex(parts[parts.length - 2]) + '\\s*::\\s*' + escapeRegex(parts[parts.length - 1]) + '\\s*\\('),
        ]);
      }
    }

    // Indirect call patterns
    callPatterns.push([
      'indirect',
      new RegExp('\\(\\s*\\*\\s*' + escapeRegex(bareName) + '\\s*\\)\\s*\\(', caseFlag),
    ]);
    callPatterns.push([
      'reference',
      new RegExp('(?:=\\s*&?\\s*|,\\s*&?\\s*)' + escapeRegex(bareName) + '\\s*(?:[,;\\)\\]]|$)', caseFlag),
    ]);

    // Find definition locations to exclude
    const definitionLocations = new Set();
    for (const [fpath, functions] of Object.entries(this.functionIndex || {})) {
      for (const [fname, info] of Object.entries(functions)) {
        if (fname === functionName || fname.endsWith('::' + bareName) || fname === bareName) {
          definitionLocations.add(`${fpath}:${info.start}`);
        }
      }
    }

    const results = [];
    const seen = new Set();
    const bareEsc = escapeRegex(bareName);

    this.forEachInvertedEntry((line, locations) => {
      // Check patterns
      let matchedType = null;
      for (const [patType, pattern] of callPatterns) {
        if (pattern.test(line)) {
          matchedType = patType;
          break;
        }
      }
      if (!matchedType) return;

      const isReference = matchedType === 'reference';

      if (!isReference) {
        const stripped = line.trimEnd();
        // Skip declarations
        if (stripped.endsWith(';') && !line.includes('{')) {
          const declRe = new RegExp('^\\s*[\\w\\s*&]+\\s+' + bareEsc + '\\s*\\([^)]*\\)\\s*;$');
          if (declRe.test(line)) return;
        }
        // Skip definitions
        if (stripped.endsWith('{')) {
          const defRe = new RegExp('^\\s*[\\w\\s*&:~]+\\s+' + bareEsc + '\\s*\\([^)]*\\)\\s*(?:const\\s*)?(?:override\\s*)?(?:final\\s*)?\\{$');
          if (defRe.test(stripped)) return;
        }
        // Skip inline constructors/destructors
        if (stripped.endsWith('};') || stripped.endsWith('}')) {
          const inlineRe = new RegExp('^\\s*~?' + bareEsc + '\\s*\\([^)]*\\)\\s*(?:const\\s*)?(?::\\s*[\\w()\\s,]+)?\\{.*\\}\\s*;?\\s*$');
          if (inlineRe.test(stripped)) return;
        }
        // Skip copy/move constructors
        const ctorRe = new RegExp('^\\s*' + bareEsc + '\\s*\\(\\s*(?:const\\s+)?' + bareEsc + '[\\s&*]*\\w*\\s*\\)\\s*\\{?\\s*$');
        if (ctorRe.test(stripped)) return;
        // Skip forward declarations
        if (new RegExp('^\\s*(?:class|struct|enum|union)\\s+' + bareEsc + '\\s*;').test(stripped)) return;
      }

      // Skip comments
      const strippedForComment = line.trimStart();
      if (strippedForComment.startsWith('//') || strippedForComment.startsWith('*') || strippedForComment.startsWith('/*')) return;

      // Process each location
      for (const [filepath, lineNumbers] of locations) {
        for (const lineNum of lineNumbers) {
          if (definitionLocations.has(`${filepath}:${lineNum}`)) continue;
          const key = `${filepath}:${lineNum}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const callerFunc = this._findContainingFunctionFromIndex(filepath, lineNum);

          // Determine call type
          let callType;
          if (matchedType === 'indirect' || matchedType === 'reference') {
            callType = matchedType;
          } else if (line.includes('->' + bareName)) {
            callType = 'method_ptr';
          } else if (line.includes('.' + bareName)) {
            callType = 'method_dot';
          } else if (line.includes('::' + bareName)) {
            callType = 'qualified';
          } else {
            callType = 'direct';
          }

          results.push({
            filepath, line_number: lineNum,
            line_text: line.trim(),
            caller_function: callerFunc,
            call_type: callType,
          });

          if (results.length >= maxResults) return false; // early stop
        }
      }
    });
    return results;
  }


  // ========================================================================
  // Find callees
  // ========================================================================

  /**
   * Find all functions called BY a given function.
   * Uses class-aware disambiguation to resolve which definition
   * of an overloaded name is actually being called.
   * @param {string} functionName
   * @param {string|null} [fileHint]
   * @returns {Array<{name, display_name, definitions, resolved_def, line_number, call_type, ambiguous}>}
   */
  findCallees(functionName, fileHint = null) {
    this._ensureFunctionIndex();

    const matches = this.findFunctionMatches(functionName, fileHint);
    if (matches.length === 0) return [];

    const target = matches[0];
    const targetFilepath = target.filepath;
    const targetStart = target.start;
    const targetEnd = target.end;

    const lines = this.fileLines.get(targetFilepath);
    if (!lines) return [];
    const bodyLines = lines.slice(targetStart - 1, targetEnd);

    const knownFunctions = this._getKnownFunctions();
    const results = [];
    // Dedup by resolved qualified name (not bare name), so ClassA::run
    // and ClassB::run both appear when both are called.
    const seenResolved = new Set();

    const callPattern = /(?<![a-zA-Z_])([a-zA-Z_]\w*)\s*\(/g;
    const indirectPattern = /\(\s*\*\s*([a-zA-Z_]\w*)\s*\)\s*\(/g;
    // Event handler patterns: addEventListener('event', handler), .on('event', handler)
    const eventHandlerPattern = /\.(?:addEventListener|on|once|removeEventListener)\s*\(\s*['"][^'"]*['"]\s*,\s*([a-zA-Z_]\w*)\b/g;

    let targetBare = functionName.includes('::') ? functionName.split('::').pop() : functionName;

    // Determine caller's class context
    const callerName = target.name || functionName;
    const callerClass = callerName.includes('::')
      ? callerName.split('::').slice(0, -1).join('::')
      : null;

    const skipKw = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return',
      'sizeof', 'typeof', 'alignof', 'decltype',
      'defined', 'assert', 'static_assert',
    ]);

    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      const lineNum = targetStart + i;
      const stripped = line.trimStart();
      if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) continue;

      // Check indirect calls first
      let m;
      indirectPattern.lastIndex = 0;
      while ((m = indirectPattern.exec(line)) !== null) {
        const calleeName = m[1];
        if (!(calleeName in knownFunctions)) continue;
        if (calleeName === targetBare) continue;

        const defs = knownFunctions[calleeName];
        const resolved = this._resolveCalleeTarget(
          calleeName, line, callerClass, targetFilepath, defs
        );
        const resolvedKey = resolved.resolvedName || calleeName;
        if (seenResolved.has(resolvedKey)) continue;
        seenResolved.add(resolvedKey);

        results.push({
          name: calleeName,
          display_name: displayName(resolved.resolvedName, resolved.def?.filepath || ''),
          definitions: defs,
          resolved_def: resolved.def,
          line_number: lineNum,
          call_type: 'indirect',
          ambiguous: resolved.ambiguous,
        });
      }

      // Check direct calls
      callPattern.lastIndex = 0;
      while ((m = callPattern.exec(line)) !== null) {
        const calleeName = m[1];
        if (!(calleeName in knownFunctions)) continue;
        if (skipKw.has(calleeName)) continue;

        const defs = knownFunctions[calleeName];

        if (calleeName === targetBare) {
          const resolvedKey = callerName || calleeName;
          if (!seenResolved.has(resolvedKey)) {
            seenResolved.add(resolvedKey);
            results.push({
              name: calleeName,
              display_name: displayName(callerName, targetFilepath),
              definitions: defs,
              resolved_def: defs.find(d => d.filepath === targetFilepath) || defs[0],
              line_number: lineNum,
              call_type: 'recursive',
              ambiguous: false,
            });
          }
          continue;
        }

        // Resolve which definition is being called
        const resolved = this._resolveCalleeTarget(
          calleeName, line, callerClass, targetFilepath, defs
        );
        const resolvedKey = resolved.resolvedName || calleeName;
        if (seenResolved.has(resolvedKey)) continue;
        seenResolved.add(resolvedKey);

        // Determine call type from context
        const pos = m.index;
        const prefix = line.slice(0, pos);
        let callType;
        if (prefix.trimEnd().endsWith('->')) callType = 'method_ptr';
        else if (prefix.trimEnd().endsWith('.')) callType = 'method_dot';
        else if (prefix.trimEnd().endsWith('::')) callType = 'qualified';
        else callType = 'direct';

        // For dot-calls, check if the resolved class actually appears as the
        // receiver. If not (e.g. `e.message.includes(...)` resolved to
        // `LlamaText::includes`), strip the false class attribution.
        if (callType === 'method_dot' && resolved.def?.class_name) {
          const resolvedClass = resolved.def.class_name;
          const receiverMatch = prefix.match(/([a-zA-Z_]\w*)\s*\.\s*$/);
          const receiver = receiverMatch ? receiverMatch[1] : null;
          // Keep class if receiver matches the class name, or is this/self
          const receiverConfirmed = receiver
            && (receiver === resolvedClass || receiver === 'this' || receiver === 'self');
          // Also keep if the class name appears explicitly elsewhere in the prefix
          const classInPrefix = !receiverConfirmed
            && new RegExp('\\b' + escapeRegex(resolvedClass) + '\\b').test(prefix);
          if (!receiverConfirmed && !classInPrefix) {
            // Demote to bare name — still show the call, just without the wrong class
            resolved.resolvedName = calleeName;
            resolved.def = null;
            resolved.ambiguous = true;
          }
        }

        results.push({
          name: calleeName,
          display_name: displayName(resolved.resolvedName, resolved.def?.filepath || ''),
          definitions: defs,
          resolved_def: resolved.def,
          line_number: lineNum,
          call_type: callType,
          ambiguous: resolved.ambiguous,
        });
      }

      // Check event handler registrations: addEventListener('event', handler)
      eventHandlerPattern.lastIndex = 0;
      while ((m = eventHandlerPattern.exec(line)) !== null) {
        const handlerName = m[1];
        if (!(handlerName in knownFunctions)) continue;
        if (handlerName === targetBare) continue;
        const defs = knownFunctions[handlerName];
        const resolved = this._resolveCalleeTarget(
          handlerName, line, callerClass, targetFilepath, defs
        );
        const resolvedKey = resolved.resolvedName || handlerName;
        if (seenResolved.has(resolvedKey)) continue;
        seenResolved.add(resolvedKey);
        results.push({
          name: handlerName,
          display_name: displayName(resolved.resolvedName, resolved.def?.filepath || ''),
          definitions: defs,
          resolved_def: resolved.def,
          line_number: lineNum,
          call_type: 'event-handler',
          ambiguous: resolved.ambiguous,
        });
      }
    }
    return results;
  }


  // ========================================================================
  // Call inventory — partition call targets into in-index vs external
  // ========================================================================

  /**
   * Well-known library prefix patterns for provenance labeling.
   * Each entry: [regex, label]
   * Order matters — first match wins.
   */
  static PROVENANCE_PATTERNS = [
    // C standard library
    [/^(malloc|calloc|realloc|free|memcpy|memmove|memset|memcmp|memchr)$/, 'C stdlib (memory)'],
    [/^(printf|fprintf|sprintf|snprintf|vprintf|vfprintf|vsprintf|vsnprintf|puts|fputs|fputc|putchar|putc|getchar|getc|fgetc|gets|fgets|ungetc|fread|fwrite|fopen|fclose|fflush|fseek|ftell|rewind|feof|ferror|clearerr|perror|tmpfile|tmpnam|freopen|setbuf|setvbuf|remove|rename)$/, 'C stdlib (stdio)'],
    [/^(strlen|strcpy|strncpy|strcat|strncat|strcmp|strncmp|strchr|strrchr|strstr|strtok|strdup|strerror|strspn|strcspn|strpbrk)$/, 'C stdlib (string)'],
    [/^(atoi|atol|atof|strtol|strtoul|strtod|strtof|strtoll|strtoull|abs|labs|llabs|div|ldiv|lldiv|rand|srand|qsort|bsearch|exit|abort|atexit|getenv|system)$/, 'C stdlib (stdlib)'],
    [/^(isalpha|isdigit|isalnum|isspace|isupper|islower|isprint|ispunct|iscntrl|isxdigit|toupper|tolower)$/, 'C stdlib (ctype)'],
    [/^(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|log|log10|log2|pow|sqrt|ceil|floor|fabs|fmod|round|trunc|frexp|ldexp|modf)$/, 'C stdlib (math)'],
    [/^(time|clock|difftime|mktime|asctime|ctime|gmtime|localtime|strftime|clock_gettime|gettimeofday)$/, 'C stdlib (time)'],
    [/^(signal|raise|sigaction|sigprocmask|sigemptyset|sigfillset|sigaddset|sigdelset|sigismember|kill|alarm|pause)$/, 'C stdlib (signal)'],
    [/^(setjmp|longjmp)$/, 'C stdlib (setjmp)'],
    [/^(va_start|va_end|va_arg|va_copy)$/, 'C stdlib (stdarg)'],

    // POSIX / Unix
    [/^(open|close|read|write|lseek|dup|dup2|pipe|fcntl|ioctl|stat|fstat|lstat|chmod|chown|umask|mkdir|rmdir|opendir|readdir|closedir|link|unlink|symlink|readlink|access|chdir|getcwd|fork|exec[lv]p?e?|wait|waitpid|_exit|getpid|getppid|getuid|getgid|setuid|setgid|setsid|getpgrp|setpgid|tcgetpgrp|tcsetpgrp)$/, 'POSIX'],
    [/^(socket|bind|listen|accept|connect|send|recv|sendto|recvfrom|setsockopt|getsockopt|getaddrinfo|freeaddrinfo|getnameinfo|gethostbyname|gethostbyaddr|inet_addr|inet_ntoa|inet_pton|inet_ntop|htons|htonl|ntohs|ntohl|select|poll|epoll_create|epoll_ctl|epoll_wait|kqueue|kevent)$/, 'POSIX (sockets)'],
    [/^(mmap|munmap|mprotect|msync|mlock|munlock|shm_open|shm_unlink|shmget|shmat|shmdt|shmctl)$/, 'POSIX (mmap/shm)'],
    [/^(pthread_\w+)$/, 'pthreads'],
    [/^(sem_\w+)$/, 'POSIX (semaphores)'],
    [/^(dlopen|dlclose|dlsym|dlerror)$/, 'POSIX (dlopen)'],

    // Windows API
    [/^(CreateFile[AW]?|ReadFile|WriteFile|CloseHandle|GetLastError|SetLastError|FormatMessage[AW]?|LocalAlloc|LocalFree|GlobalAlloc|GlobalFree|HeapAlloc|HeapFree|HeapCreate|HeapDestroy|VirtualAlloc|VirtualFree|VirtualProtect)$/, 'Win32 API (core)'],
    [/^(CreateProcess[AW]?|ExitProcess|TerminateProcess|GetExitCodeProcess|OpenProcess|GetCurrentProcess|GetCurrentProcessId|GetCurrentThread|GetCurrentThreadId|CreateThread|ExitThread|TerminateThread|ResumeThread|SuspendThread|WaitForSingleObject|WaitForMultipleObjects|Sleep|SleepEx)$/, 'Win32 API (process/thread)'],
    [/^(CreateEvent[AW]?|SetEvent|ResetEvent|CreateMutex[AW]?|ReleaseMutex|CreateSemaphore[AW]?|ReleaseSemaphore|InitializeCriticalSection|EnterCriticalSection|LeaveCriticalSection|DeleteCriticalSection|TryEnterCriticalSection|InitializeSRWLock|AcquireSRWLock\w*|ReleaseSRWLock\w*)$/, 'Win32 API (sync)'],
    [/^(RegOpenKey|RegCloseKey|RegQueryValue|RegSetValue|RegCreateKey|RegDeleteKey|RegDeleteValue|RegEnumKey|RegEnumValue)[AW]?(Ex[AW]?)?$/, 'Win32 API (registry)'],
    [/^(WSAStartup|WSACleanup|WSAGetLastError|WSASocket[AW]?|WSASend|WSARecv|WSAConnect|WSAAccept|WSAEventSelect|WSAWaitForMultipleEvents|WSACreateEvent|WSACloseEvent|WSAEnumNetworkEvents)$/, 'Win32 API (Winsock)'],
    [/^(LoadLibrary[AW]?|FreeLibrary|GetProcAddress|GetModuleHandle[AW]?|GetModuleFileName[AW]?)$/, 'Win32 API (DLL)'],
    [/^(FindFirstFile[AW]?|FindNextFile[AW]?|FindClose|GetFileAttributes[AW]?|SetFileAttributes[AW]?|GetFileSize|SetFilePointer|MoveFile[AW]?|CopyFile[AW]?|DeleteFile[AW]?|CreateDirectory[AW]?|RemoveDirectory[AW]?)$/, 'Win32 API (file)'],
    [/^(MessageBox[AW]?|GetMessage[AW]?|PeekMessage[AW]?|PostMessage[AW]?|SendMessage[AW]?|DispatchMessage[AW]?|TranslateMessage|DefWindowProc[AW]?|RegisterClass[AW]?|CreateWindow(Ex)?[AW]?|DestroyWindow|ShowWindow|UpdateWindow|InvalidateRect|GetDC|ReleaseDC|BeginPaint|EndPaint)$/, 'Win32 API (GUI/message)'],
    [/^(Get|Set|Query|Enable|Disable|Is)(System|Window|Process|Thread|File|Console|Computer|User|Std|Tick|Volume|Disk|Drive|Startup|Version|Environment)\w*[AW]?$/, 'Win32 API'],

    // COM / OLE
    [/^(CoInitialize|CoInitializeEx|CoUninitialize|CoCreateInstance|CoGetClassObject|CoTaskMemAlloc|CoTaskMemFree|CoMarshalInterface|CoUnmarshalInterface|OleInitialize|OleUninitialize)$/, 'COM/OLE'],
    [/^(SysAllocString|SysFreeString|SafeArrayCreate|SafeArrayDestroy|VariantInit|VariantClear|VariantCopy)$/, 'COM/OLE (BSTR/VARIANT)'],

    // C++ standard library
    [/^(std)::\w+/, 'C++ stdlib'],
    [/^(make_shared|make_unique|make_pair|make_tuple|move|forward|swap|min|max|sort|find|begin|end|push_back|emplace_back|insert|erase|resize|reserve|size|empty|clear|front|back|at|data|c_str|substr|npos|to_string|stoi|stol|stof|stod)$/, 'C++ stdlib'],

    // OpenSSL
    [/^(SSL_\w+|EVP_\w+|BIO_\w+|X509_\w+|RSA_\w+|EC_\w+|HMAC\w*|SHA\d*\w*|MD5\w*|AES_\w+|DES_\w+|RAND_\w+|ERR_\w+|PEM_\w+|PKCS\d+_\w+|OPENSSL_\w+|CRYPTO_\w+)$/, 'OpenSSL'],

    // zlib
    [/^(deflate|inflate|deflateInit|inflateInit|deflateEnd|inflateEnd|compress|uncompress|gzopen|gzclose|gzread|gzwrite|crc32|adler32|zlibVersion)2?$/, 'zlib'],

    // SQLite
    [/^sqlite3_\w+$/, 'SQLite'],

    // Python C API
    [/^(Py\w+_\w+|PyErr_\w+|PyObject_\w+|PyList_\w+|PyDict_\w+|PyTuple_\w+|PyLong_\w+|PyFloat_\w+|PyUnicode_\w+|PyBytes_\w+|PyArg_\w+|Py_\w+)$/, 'Python C API'],

    // GLib / GTK
    [/^g_(malloc|free|new|renew|strdup|strsplit|string_\w+|list_\w+|hash_table_\w+|signal_\w+|object_\w+|type_\w+|main_\w+|idle_\w+|timeout_\w+|io_\w+|spawn_\w+|file_\w+|dir_\w+|key_file_\w+|regex_\w+|print|error|warning|message|debug|log|assert\w*|return_\w+)$/, 'GLib'],
    [/^gtk_\w+$/, 'GTK'],
    [/^gdk_\w+$/, 'GDK'],

    // Qt
    [/^(Q[A-Z]\w+)::\w+/, 'Qt'],

    // ACE framework
    [/^ACE_\w+$/, 'ACE framework'],

    // Boost
    [/^boost::\w+/, 'Boost'],

    // Java standard library (for .java files)
    [/^(System|String|Integer|Long|Double|Float|Boolean|Character|Math|Arrays|Collections|Objects|Optional|Stream|Thread|Runnable|Callable|Future|List|ArrayList|LinkedList|Map|HashMap|TreeMap|Set|HashSet|TreeSet|Queue|Deque|Stack|Iterator|Iterable|Comparable|Comparator|Exception|RuntimeException|IOException|StringBuilder|StringBuffer|Pattern|Matcher|Date|Calendar|LocalDate|LocalTime|Instant|Duration|File|Path|Files|InputStream|OutputStream|Reader|Writer|BufferedReader|BufferedWriter|PrintWriter|Scanner)\.\w+$/, 'Java stdlib'],

    // Python builtins and stdlib (for .py files)
    [/^(print|len|range|enumerate|zip|map|filter|sorted|reversed|list|dict|set|tuple|str|int|float|bool|type|isinstance|issubclass|hasattr|getattr|setattr|delattr|property|staticmethod|classmethod|super|iter|next|open|input|id|hash|repr|format|chr|ord|hex|oct|bin|abs|round|min|max|sum|all|any|dir|vars|globals|locals|exec|eval|compile|__import__|breakpoint)$/, 'Python builtin'],
    [/^(os|sys|re|json|math|random|datetime|collections|itertools|functools|pathlib|subprocess|threading|multiprocessing|socket|http|urllib|logging|unittest|argparse|typing|io|shutil|glob|fnmatch|hashlib|hmac|base64|struct|pickle|copy|pprint|textwrap|csv|configparser|sqlite3|xml|html|email)\.\w+$/, 'Python stdlib'],

    // Node.js
    [/^(require|console|process|Buffer|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|queueMicrotask)$/, 'Node.js'],
    [/^(fs|path|os|http|https|net|url|crypto|stream|events|util|child_process|cluster|dgram|dns|readline|zlib|assert|buffer|querystring|tls|vm|worker_threads)\.\w+$/, 'Node.js stdlib'],

    // Catch-all patterns (broad, lower priority)
    [/^(gl|GL_|glut|glu)[A-Z]\w*$/, 'OpenGL'],
    [/^(cl[A-Z])\w*$/, 'OpenCL'],
    [/^(cu[A-Z])\w*$/, 'CUDA'],
    [/^(MPI_)\w+$/, 'MPI'],
    [/^(pcre2?_)\w+$/, 'PCRE'],
    [/^(curl_)\w+$/, 'libcurl'],
    [/^(xml|XML|xmlC|htmlC?)\w+$/, 'libxml2'],
    [/^(json_)\w+$/, 'JSON-C / Jansson'],
    [/^(av_|avcodec_|avformat_|avutil_|sws_|swr_)\w+$/, 'FFmpeg'],
    [/^(cairo_)\w+$/, 'Cairo'],
    [/^(pango_)\w+$/, 'Pango'],
    [/^(dbus_)\w+$/, 'D-Bus'],
    [/^(uv_)\w+$/, 'libuv'],
    [/^(napi_)\w+$/, 'Node N-API'],
    [/^(ASSERT|EXPECT|TEST|TEST_F|TYPED_TEST)\w*$/, 'test framework (gtest-like)'],
    [/^(BOOST_\w+)$/, 'Boost'],
  ];

  /**
   * Guess provenance of an external (not-in-index) call target.
   * @param {string} name - Bare function/method name
   * @returns {string|null} - Label like "C stdlib (memory)" or null
   */
  static guessProvenance(name) {
    for (const [re, label] of CodeSearchIndex.PROVENANCE_PATTERNS) {
      if (re.test(name)) return label;
    }
    return null;
  }

  /**
   * Build a call inventory for one function or all functions.
   *
   * Returns all call targets partitioned into:
   *   - in_index: calls resolved to a function in the index
   *   - external: calls to functions not in the index (with provenance guess)
   *
   * @param {string|null} functionName - Target function, or null for all
   * @param {Object} [opts] - Options
   * @param {string} [opts.includePath] - Filter functions by path
   * @param {string} [opts.excludePath] - Exclude functions by path
   * @param {boolean} [opts.showProgress=true]
   * @returns {{
   *   in_index: Array<{name, qualified_name, filepath, lines, callers: string[]}>,
   *   external: Array<{name, provenance: string|null, call_sites: Array<{caller, filepath, line}>}>,
   *   summary: {total_targets, in_index_count, external_count, functions_scanned}
   * }}
   */
  getCallInventory(functionName = null, opts = {}) {
    const { includePath, excludePath, showProgress = true } = opts;
    this._ensureFunctionIndex();

    const knownFunctions = this._getKnownFunctions();

    const skipKw = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return',
      'sizeof', 'typeof', 'alignof', 'decltype',
      'defined', 'assert', 'static_assert',
      'elif', 'except', 'finally', 'with', 'else',
    ]);

    // Collect functions to scan
    let functionsToScan = [];

    if (functionName) {
      // Single function mode
      const matches = this.findFunctionMatches(functionName);
      if (matches.length === 0) return { in_index: [], external: [], summary: { total_targets: 0, in_index_count: 0, external_count: 0, functions_scanned: 0 } };
      functionsToScan = [matches[0]];
    } else {
      // All functions mode
      for (const [filepath, funcs] of Object.entries(this.functionIndex || {})) {
        if (includePath && !filepath.toLowerCase().includes(includePath.toLowerCase())) continue;
        if (excludePath && filepath.toLowerCase().includes(excludePath.toLowerCase())) continue;
        for (const [name, info] of Object.entries(funcs)) {
          if (info.type === 'class') continue;
          functionsToScan.push({ filepath, name, start: info.start, end: info.end });
        }
      }
    }

    // Track all call targets
    const inIndexMap = new Map();   // qualified_name -> {name, qualified_name, filepath, lines, callers: Set}
    const externalMap = new Map();  // bare_name -> {name, provenance, call_sites: []}

    const callPattern = /(?<![a-zA-Z_])([a-zA-Z_]\w*)\s*\(/g;
    let scanned = 0;

    for (const func of functionsToScan) {
      scanned++;
      if (showProgress && scanned % 1000 === 0) {
        process.stderr.write(`  Scanning: ${scanned}/${functionsToScan.length} functions...\r`);
      }

      const lines = this.fileLines.get(func.filepath);
      if (!lines) continue;
      const bodyLines = lines.slice(func.start - 1, func.end);

      const callerName = func.name;
      let callerBare = callerName;
      if (callerBare.includes('::')) callerBare = callerBare.split('::').pop();
      else if (callerBare.includes('.')) callerBare = callerBare.split('.').pop();

      const callerClass = callerName.includes('::')
        ? callerName.split('::').slice(0, -1).join('::')
        : callerName.includes('.')
          ? callerName.split('.').slice(0, -1).join('.')
          : null;

      const seenInThisFunc = new Set();

      for (let i = 0; i < bodyLines.length; i++) {
        const line = bodyLines[i];
        const lineNum = func.start + i;
        const stripped = line.trimStart();
        if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*') || stripped.startsWith('#')) continue;

        callPattern.lastIndex = 0;
        let m;
        while ((m = callPattern.exec(line)) !== null) {
          const calleeName = m[1];
          if (skipKw.has(calleeName)) continue;
          if (calleeName === callerBare) continue;  // skip recursion
          if (calleeName.length < 2) continue;
          // Skip ALL_CAPS likely macros/constants
          if (/^[A-Z][A-Z0-9_]+$/.test(calleeName) && calleeName.length > 2) continue;
          if (seenInThisFunc.has(calleeName)) continue;
          seenInThisFunc.add(calleeName);

          if (calleeName in knownFunctions) {
            // IN INDEX
            const defs = knownFunctions[calleeName];
            const resolved = this._resolveCalleeTarget(
              calleeName, line, callerClass, func.filepath, defs
            );
            const qName = resolved.resolvedName || calleeName;
            if (!inIndexMap.has(qName)) {
              const def = resolved.def;
              inIndexMap.set(qName, {
                name: calleeName,
                qualified_name: qName,
                filepath: def?.filepath || '',
                lines: def ? (def.end - def.start + 1) : 0,
                callers: new Set(),
              });
            }
            inIndexMap.get(qName).callers.add(callerName);
          } else {
            // EXTERNAL
            if (!externalMap.has(calleeName)) {
              externalMap.set(calleeName, {
                name: calleeName,
                provenance: CodeSearchIndex.guessProvenance(calleeName),
                call_sites: [],
              });
            }
            externalMap.get(calleeName).call_sites.push({
              caller: callerName,
              filepath: func.filepath,
              line: lineNum,
            });
          }
        }
      }
    }

    if (showProgress && functionsToScan.length > 100) {
      process.stderr.write(`  Scanned ${scanned} functions\n`);
    }

    // Convert to sorted arrays
    const inIndex = [...inIndexMap.values()]
      .map(e => ({ ...e, callers: [...e.callers].sort() }))
      .sort((a, b) => b.callers.length - a.callers.length || a.qualified_name.localeCompare(b.qualified_name));

    const external = [...externalMap.values()]
      .sort((a, b) => b.call_sites.length - a.call_sites.length || a.name.localeCompare(b.name));

    return {
      in_index: inIndex,
      external,
      summary: {
        total_targets: inIndex.length + external.length,
        in_index_count: inIndex.length,
        external_count: external.length,
        functions_scanned: scanned,
      },
    };
  }

  /**
   * Count how many times each function/identifier is called across the codebase.
   * @param {boolean} [showProgress=true]
   * @returns {Object<string, number>} name -> count, sorted descending
   */
  getCallCounts(showProgress = true) {
    // Return cached result if available (huge win for interactive mode)
    if (this._callCountsCache) {
      if (showProgress) console.log('Using cached call counts.');
      return this._callCountsCache;
    }

    if (!this._ensureInvertedAvailable()) {
      console.log('No inverted index. Build index first.');
      return {};
    }
    if (showProgress) {
      console.log('Scanning for function calls...');
      if (this._invertedOnDisk) {
        console.log('  (First scan streams from disk - may take 1-3 minutes for large indexes.');
        console.log('   Subsequent metrics commands will be instant.)');
      }
    }

    const simpleCall = /(?<![a-zA-Z_])(\w+)\s*\(/g;
    const qualifiedCall = /((?:\w+::)+\w+)\s*\(/g;
    const memberCall = /(?:\.|->\s*)(\w+)\s*\(/g;
    // Event handler registrations: addEventListener('event', handler)
    const eventHandler = /\.(?:addEventListener|on|once)\s*\(\s*['"][^'"]*['"]\s*,\s*([a-zA-Z_]\w*)\b/g;

    const skipKeywords = new Set([
      'if', 'while', 'for', 'switch', 'catch', 'return', 'sizeof',
      'typeof', 'defined', 'else', 'elif', 'except', 'finally',
      'alignof', 'decltype', 'noexcept', 'static_assert', 'throw',
      'new', 'delete', 'and', 'or', 'not', 'xor',
      'void', 'int', 'char', 'short', 'long', 'float', 'double',
      'unsigned', 'signed', 'bool', 'auto', 'register', 'extern',
      'static', 'const', 'volatile', 'inline', 'virtual',
      'byte', 'boolean', 'String',
      'Copyright', 'copyright', 'param', 'author',
    ]);

    const counts = Object.create(null);
    let linesScanned = 0;

    this.forEachInvertedEntry((line, accessor) => {
      linesScanned++;
      const stripped = line.trimStart();
      if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) return;

      const strippedR = line.trimEnd();
      // Skip function definitions
      if (strippedR.endsWith('{')) {
        if (/^\s*[\w\s*&:~]+\s+\w+\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?\{$/.test(strippedR)) return;
      }
      // Skip declarations
      if (strippedR.endsWith(';') && !line.includes('{')) {
        if (/^\s*[\w\s*&:~<>,]+\s+\w+\s*\([^)]*\)\s*;$/.test(strippedR)) return;
      }

      // Quick check: does this line contain any function call at all?
      if (!line.includes('(')) return;

      // Only now count occurrences (fast path, no full JSON parse)
      const totalLocations = accessor.count();

      // Qualified calls first
      let m;
      qualifiedCall.lastIndex = 0;
      while ((m = qualifiedCall.exec(line)) !== null) {
        const funcName = m[1];
        counts[funcName] = (counts[funcName] || 0) + totalLocations;
      }

      // Member calls
      memberCall.lastIndex = 0;
      while ((m = memberCall.exec(line)) !== null) {
        const funcName = m[1];
        if (!skipKeywords.has(funcName)) {
          counts[funcName] = (counts[funcName] || 0) + totalLocations;
        }
      }

      // Simple calls (skip if part of qualified/member)
      simpleCall.lastIndex = 0;
      while ((m = simpleCall.exec(line)) !== null) {
        const funcName = m[1];
        const pos = m.index;
        if (skipKeywords.has(funcName)) continue;
        if (pos >= 2 && line.slice(pos - 2, pos) === '::') continue;
        if (pos >= 1 && line[pos - 1] === '.') continue;
        if (pos >= 2 && line.slice(pos - 2, pos) === '->') continue;
        counts[funcName] = (counts[funcName] || 0) + totalLocations;
      }

      // Event handler registrations: handler name passed as callback argument
      eventHandler.lastIndex = 0;
      while ((m = eventHandler.exec(line)) !== null) {
        const funcName = m[1];
        if (!skipKeywords.has(funcName)) {
          counts[funcName] = (counts[funcName] || 0) + totalLocations;
        }
      }
    }, showProgress, true); // lazy=true: skip full JSON parse

    if (showProgress) {
      console.log(`Scanned ${linesScanned} unique lines, found ${Object.keys(counts).length} called identifiers`);
    }
    this._callCountsCache = counts;
    return counts;
  }


  // ========================================================================
  // Definition lookup
  // ========================================================================

  /**
   * Build a lookup table mapping bare function names to their definitions.
   * @returns {Object<string, Array>} bare_name -> [{filepath, full_name, start, end, lines, type}]
   */
  _buildDefinitionLookup() {
    this._ensureFunctionIndex();
    const lookup = Object.create(null);

    for (const [filepath, functions] of Object.entries(this.functionIndex || {})) {
      for (const [fullName, info] of Object.entries(functions)) {
        let bareName = info.base_name || fullName.split('::').pop();
        if (bareName.includes('@')) bareName = bareName.split('@')[0];

        const entry = {
          filepath, full_name: fullName,
          start: info.start, end: info.end,
          lines: info.end - info.start + 1,
          type: info.type || 'function',
        };

        if (!lookup[bareName]) lookup[bareName] = [];
        lookup[bareName].push(entry);

        // Also index by full qualified name
        if (fullName !== bareName && fullName.includes('::')) {
          if (!lookup[fullName]) lookup[fullName] = [];
          lookup[fullName].push(entry);
        }
      }
    }
    return lookup;
  }

  /**
   * Find all definitions of a function/method name.
   */
  findDefinitions(funcName, lookup = null) {
    if (!lookup) lookup = this._buildDefinitionLookup();
    const bareName = funcName.includes('::') ? funcName.split('::').pop() : funcName;
    if (funcName in lookup) return lookup[funcName];
    if (bareName in lookup) return lookup[bareName];
    return [];
  }

  /**
   * Get call counts with definition information.
   * @returns {Array<{name, count, definitions}>} sorted by count desc
   */
  getCallCountsWithDefinitions(showProgress = true) {
    const counts = this.getCallCounts(showProgress);
    if (showProgress) console.log('Building definition lookup table...');
    const lookup = this._buildDefinitionLookup();
    if (showProgress) console.log(`Looking up definitions for ${Object.keys(counts).length} identifiers...`);

    const results = [];
    for (const [funcName, count] of Object.entries(counts)) {
      const defs = this.findDefinitions(funcName, lookup);
      results.push({ name: funcName, count, definitions: defs });
    }
    results.sort((a, b) => b.count - a.count);
    return results;
  }


  // ========================================================================
  // File-level dependency graph (bulk)
  // ========================================================================

  /**
   * Compute all file-to-file dependencies in a single pass.
   * @param {string|null} [pathFilter]
   * @param {boolean} [showProgress=true]
   * @returns {Object<string, Object<string, number>>} source -> {target -> count}
   */
  getAllFileDeps(pathFilter = null, showProgress = true) {
    this._ensureFunctionIndex();
    const known = this._getKnownFunctions();
    const callPattern = /(?<![a-zA-Z_])([a-zA-Z_]\w*)\s*\(/g;

    const skipKeywords = new Set([
      'if', 'for', 'while', 'switch', 'catch', 'return',
      'sizeof', 'typeof', 'defined', 'assert', 'raise',
      'print', 'new', 'delete', 'throw', 'elif', 'except',
      'lambda', 'yield', 'await', 'async',
      'open', 'close', 'read', 'write', 'run', 'get', 'set',
      'pop', 'push', 'put', 'add', 'remove', 'update', 'clear',
      'copy', 'keys', 'values', 'items', 'append', 'extend',
      'join', 'split', 'strip', 'replace', 'find', 'sort',
      'len', 'str', 'int', 'float', 'bool', 'list', 'dict',
      'tuple', 'type', 'range', 'map', 'filter', 'zip',
      'min', 'max', 'sum', 'any', 'all', 'abs', 'round',
      'format', 'repr', 'hash', 'id', 'vars', 'dir',
      'hasattr', 'getattr', 'setattr', 'isinstance', 'issubclass',
      'super', 'property', 'classmethod', 'staticmethod',
      'input', 'iter', 'next', 'enumerate', 'reversed', 'sorted',
      'malloc', 'free', 'calloc', 'realloc', 'memcpy', 'memset',
      'strcmp', 'strlen', 'strcpy', 'strcat', 'sprintf', 'fprintf',
      'printf', 'scanf', 'fopen', 'fclose', 'fread', 'fwrite',
      'exit', 'abort',
      'f', 'g', 'fn', 'cb', 'op', 'do',
    ]);

    const pathParts = (fp) => fp.replace(/\\/g, '/').toLowerCase().split('/');

    const bestTarget = (srcFp, calleeName) => {
      const defs = known[calleeName];
      if (!defs) return null;
      const candidates = defs.map(d => d.filepath).filter(fp => fp !== srcFp);
      if (candidates.length === 0) return null;
      if (candidates.length === 1) return candidates[0];

      const srcDir = pathParts(srcFp).slice(0, -1);
      let best = null, bestScore = -1;
      for (const tgtFp of candidates) {
        const tgtDir = pathParts(tgtFp).slice(0, -1);
        let shared = 0;
        for (let i = 0; i < Math.min(srcDir.length, tgtDir.length); i++) {
          if (srcDir[i] === tgtDir[i]) shared++;
          else break;
        }
        if (shared > bestScore) { bestScore = shared; best = tgtFp; }
      }
      return best;
    };

    const targetCache = new Map();
    let filesWithFuncs = Object.keys(this.functionIndex || {})
      .filter(fp => this.fileLines.has(fp));
    if (pathFilter) {
      const pf = pathFilter.replace(/\\/g, '/').toLowerCase();
      filesWithFuncs = filesWithFuncs.filter(fp => fp.replace(/\\/g, '/').toLowerCase().includes(pf));
    }

    const total = filesWithFuncs.length;
    const fileDeps = {};
    const selfCallRe = /(?:self|this)\s*(?:\.|->\s*)([a-zA-Z_]\w*)\s*\(/g;

    for (let idx = 0; idx < filesWithFuncs.length; idx++) {
      const srcFp = filesWithFuncs[idx];
      if (showProgress && (idx + 1) % 50 === 0) {
        eprint(`  ... ${idx + 1}/${total} files`);
      }

      const deps = {};
      const lines = this.fileLines.get(srcFp);

      // Local functions (same-file)
      const localFuncs = new Set();
      for (const fname of Object.keys(this.functionIndex[srcFp] || {})) {
        let bare = fname.includes('::') ? fname.split('::').pop() : fname;
        bare = bare.includes('.') ? bare.split('.').pop() : bare;
        localFuncs.add(bare);
      }

      for (const line of lines) {
        const stripped = line.trimStart();
        if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*') || stripped.startsWith('#')) continue;

        // Collect self/this calls to skip
        const selfCalls = new Set();
        let sm;
        selfCallRe.lastIndex = 0;
        while ((sm = selfCallRe.exec(line)) !== null) {
          selfCalls.add(sm[1]);
        }

        callPattern.lastIndex = 0;
        let m;
        while ((m = callPattern.exec(line)) !== null) {
          const callee = m[1];
          if (skipKeywords.has(callee)) continue;
          if (!(callee in known)) continue;
          if (selfCalls.has(callee)) continue;
          if (localFuncs.has(callee)) continue;

          const cacheKey = `${idx}:${callee}`;
          if (!targetCache.has(cacheKey)) {
            targetCache.set(cacheKey, bestTarget(srcFp, callee));
          }
          const tgtFp = targetCache.get(cacheKey);
          if (tgtFp) {
            deps[tgtFp] = (deps[tgtFp] || 0) + 1;
          }
        }
      }

      if (Object.keys(deps).length > 0) {
        fileDeps[srcFp] = deps;
      }
    }

    return fileDeps;
  }


  // ========================================================================
  // Phase 3: Metrics / discovery methods
  // ========================================================================

  /**
   * Build class inheritance hierarchy tree.
   * Returns { roots, externalRoots, standalone, totalClasses, totalRelationships }
   *   roots: tree nodes for classes whose parents aren't in the index (true roots)
   *   externalRoots: tree nodes grouped under an external parent name
   *   standalone: classes with no inheritance relationships
   * Each node: { name, filepath, start, end, lines, methodCount, children }
   */
  getClassHierarchy(filter = null) {
    this._ensureFunctionIndex();
    const imap = this._getInheritanceMap();  // Map<child, parents[]>

    // Single-pass class scan: collect classes, then count methods in same loop.
    // Avoids the expensive listClasses() which builds full method arrays.
    const classInfo = {};
    const pendingMethods = [];  // [{name, fpath}] — resolved after classes known
    for (const [fpath, functions] of Object.entries(this.functionIndex)) {
      for (const [name, info] of Object.entries(functions)) {
        if (info.type === 'class') {
          const bare = name.includes('::') ? name.split('::').pop() : name;
          if (!classInfo[bare]) {
            classInfo[bare] = {
              name: bare, filepath: fpath,
              start: info.start || 0, end: info.end || 0,
              lines: (info.end || 0) - (info.start || 0) + 1,
              methodCount: 0,
            };
          }
        } else if (info.type === 'method' || info.type === 'function') {
          if (name.includes('::') || name.includes('.')) {
            pendingMethods.push(name);
          }
        }
      }
    }
    // Resolve method counts (lightweight — just string prefix checks)
    const classNameSet = new Set(Object.keys(classInfo));
    for (const name of pendingMethods) {
      const sep = name.includes('::') ? '::' : '.';
      const prefix = name.slice(0, name.indexOf(sep));
      if (classNameSet.has(prefix) && classInfo[prefix]) classInfo[prefix].methodCount++;
    }

    // Build parent->children map (reverse of imap)
    const childrenOf = {};   // parentName -> [childName]
    const allInvolved = new Set();  // all class names that appear in any relationship
    let totalRelationships = 0;

    for (const [child, parents] of imap) {
      allInvolved.add(child);
      for (const p of parents) {
        allInvolved.add(p);
        if (!childrenOf[p]) childrenOf[p] = [];
        childrenOf[p].push(child);
        totalRelationships++;
      }
    }

    // Apply filter
    const pat = filter ? filter.toLowerCase() : null;
    const matchesFilter = (name) => {
      if (!pat) return true;
      if (name.toLowerCase().includes(pat)) return true;
      const info = classInfo[name];
      if (info && info.filepath && info.filepath.toLowerCase().includes(pat)) return true;
      return false;
    };

    // When filtering, expand to include ancestors and descendants of matches
    let relevantNames = null;
    if (pat) {
      relevantNames = new Set();
      const addAncestors = (name, visited) => {
        if (visited.has(name)) return;
        visited.add(name);
        relevantNames.add(name);
        const parents = imap.get(name);
        if (parents) for (const p of parents) addAncestors(p, visited);
      };
      const addDescendants = (name, visited) => {
        if (visited.has(name)) return;
        visited.add(name);
        relevantNames.add(name);
        const kids = childrenOf[name];
        if (kids) for (const k of kids) addDescendants(k, visited);
      };
      for (const name of allInvolved) {
        if (matchesFilter(name)) {
          addAncestors(name, new Set());
          addDescendants(name, new Set());
        }
      }
      // Also check standalone classes
      for (const name of Object.keys(classInfo)) {
        if (matchesFilter(name)) relevantNames.add(name);
      }
    }

    const isRelevant = (name) => !relevantNames || relevantNames.has(name);

    // Build tree nodes recursively
    const buildNode = (name, visited) => {
      if (visited.has(name)) return null;  // cycle protection
      visited.add(name);
      const info = classInfo[name];
      const node = {
        name,
        filepath: info ? info.filepath : null,
        start: info ? info.start : 0,
        end: info ? info.end : 0,
        lines: info ? info.lines : 0,
        methodCount: info ? info.methodCount : 0,
        external: !info,  // not in function index
        children: [],
      };
      const kids = childrenOf[name] || [];
      for (const kid of kids.sort()) {
        if (!isRelevant(kid)) continue;
        const childNode = buildNode(kid, new Set(visited));
        if (childNode) node.children.push(childNode);
      }
      return node;
    };

    // Identify roots: classes that have children but no parents in the index
    // or whose parents are all external
    const roots = [];
    const externalRoots = [];  // grouped by external parent name
    const externalGroups = {};  // externalParentName -> [childNodes]

    // Find classes that are parents (have children) but have no parents themselves
    const hasParent = new Set(imap.keys());

    for (const name of allInvolved) {
      if (!isRelevant(name)) continue;
      const parents = imap.get(name);
      const isChild = parents && parents.length > 0;

      if (!isChild && childrenOf[name]) {
        // This is a root: has children, no parents
        const node = buildNode(name, new Set());
        if (node && (node.children.length > 0 || !node.external)) {
          if (node.external) {
            externalGroups[name] = node;
          } else {
            roots.push(node);
          }
        }
      }
    }

    // Also find classes whose parents are ALL external (they appear as roots too)
    for (const [child, parents] of imap) {
      if (!isRelevant(child)) continue;
      const allParentsExternal = parents.every(p => !classInfo[p]);
      const noParentIsRoot = !parents.some(p => allInvolved.has(p) && !imap.has(p));
      // If all parents are external, group under each external parent
      if (allParentsExternal) {
        for (const p of parents) {
          if (!externalGroups[p]) {
            externalGroups[p] = buildNode(p, new Set());
          }
        }
      }
    }

    // Collect external root nodes
    for (const [name, node] of Object.entries(externalGroups).sort(([a], [b]) => a.localeCompare(b))) {
      if (node && node.children.length > 0) externalRoots.push(node);
    }

    // Sort roots by name
    roots.sort((a, b) => a.name.localeCompare(b.name));

    // Standalone: classes in the index but not involved in any inheritance
    const standalone = [];
    for (const name of Object.keys(classInfo)) {
      if (!allInvolved.has(name) && isRelevant(name)) {
        standalone.push(classInfo[name]);
      }
    }
    standalone.sort((a, b) => a.name.localeCompare(b.name));

    return {
      roots,
      externalRoots,
      standalone,
      totalClasses: Object.keys(classInfo).length,
      totalRelationships,
    };
  }

  /**
   * List all indexed classes with aggregated method stats.
   * Handles cross-file method association (e.g., methods in .cpp, class in .h).
   */
  listClasses(filepath = null) {
    this._ensureFunctionIndex();
    const filterPath = filepath ? filepath.toLowerCase().replace(/\\/g, '/') : null;

    // First pass: collect all classes
    const allClasses = {};
    for (const [fpath, functions] of Object.entries(this.functionIndex)) {
      for (const [name, info] of Object.entries(functions)) {
        if (info.type === 'class') {
          const bare = name.includes('::') ? name.split('::').pop() : name;
          if (!(bare in allClasses)) {
            allClasses[bare] = {
              filepath: fpath,
              name,
              start: info.start,
              end: info.end,
              lines: info.end - info.start + 1,
              method_count: 0,
              total_method_lines: 0,
              methods: [],
            };
          }
        }
      }
    }

    // Second pass: associate methods with classes (cross-file).
    // Build a Set for O(1) class-name lookup instead of O(classes) per function.
    const classNameSet = new Set(Object.keys(allClasses));

    // Also collect unresolved :: prefixes for class inference (sub-task b)
    const unresolvedMethods = [];  // { className, name, filepath, info }

    for (const [fpath, functions] of Object.entries(this.functionIndex)) {
      for (const [name, info] of Object.entries(functions)) {
        if (info.type !== 'method' && info.type !== 'function') continue;

        // Extract potential class name from function name
        // Patterns: ClassName::method, ClassName.method, Outer::ClassName::method
        let className = null;
        if (name.includes('::')) {
          const parts = name.split('::');
          // Try each prefix segment as a class name
          for (let i = 0; i < parts.length - 1; i++) {
            if (classNameSet.has(parts[i])) {
              className = parts[i];
              break;
            }
          }
          // If no class found, track for inference pass
          if (!className && parts.length >= 2) {
            unresolvedMethods.push({
              className: parts[parts.length - 2],  // immediate parent
              name, filepath: fpath, info,
            });
          }
        } else if (name.includes('.')) {
          const dotPrefix = name.split('.')[0];
          if (classNameSet.has(dotPrefix)) {
            className = dotPrefix;
          }
        }

        if (className && allClasses[className]) {
          const methodLines = info.end - info.start + 1;
          allClasses[className].method_count++;
          allClasses[className].total_method_lines += methodLines;
          allClasses[className].methods.push({
            name, filepath: fpath,
            start: info.start, end: info.end, lines: methodLines,
          });
        }
      }
    }

    // Third pass: infer classes from :: prefixes that weren't found in pass 1.
    // If we see OcclusionTracker::Method but no "class OcclusionTracker" was indexed,
    // create a synthetic (inferred) class entry and associate its methods.
    if (unresolvedMethods.length > 0) {
      // Group unresolved methods by inferred class name
      const inferredGroups = {};
      for (const m of unresolvedMethods) {
        const cn = m.className;
        // Skip obvious non-class names: all-lowercase, single char, keywords
        if (/^[a-z]/.test(cn) || cn.length <= 1) continue;
        if (CodeSearchIndex.SKIP_KEYWORDS.has(cn)) continue;
        // Skip names that are already known classes
        if (classNameSet.has(cn)) continue;

        if (!inferredGroups[cn]) inferredGroups[cn] = [];
        inferredGroups[cn].push(m);
      }

      for (const [cn, methods] of Object.entries(inferredGroups)) {
        // Only infer a class if it has at least 1 method (always true here)
        // Use the first method's file as the class "location"
        const firstMethod = methods[0];
        const methodLines = methods.reduce((sum, m) =>
          sum + (m.info.end - m.info.start + 1), 0);

        allClasses[cn] = {
          filepath: firstMethod.filepath,
          name: cn,
          start: firstMethod.info.start,
          end: firstMethod.info.end,
          lines: 0,  // no class body - inferred from methods
          method_count: methods.length,
          total_method_lines: methodLines,
          inferred: true,  // flag so display can note this
          methods: methods.map(m => ({
            name: m.name,
            filepath: m.filepath,
            start: m.info.start,
            end: m.info.end,
            lines: m.info.end - m.info.start + 1,
          })),
        };
      }
    }

    let results = Object.values(allClasses);
    if (filterPath) {
      results = results.filter(c => c.filepath.toLowerCase().replace(/\\/g, '/').includes(filterPath));
    }
    return results;
  }

  /**
   * Count how many definitions exist for each bare function name.
   */
  _getBareNameCounts() {
    const counts = Object.create(null);
    const allFuncs = this.listFunctions();
    for (const f of allFuncs) {
      let bare = f.name.includes('::') ? f.name.split('::').pop() : f.name;
      if (bare.includes('@')) bare = bare.split('@')[0];
      counts[bare] = (counts[bare] || 0) + 1;
    }
    return counts;
  }

  /**
   * Find structurally important functions: score = calls x log₂(lines).
   * Large frequently-called functions rank highest.
   */
  getHotspots(n = 25, showProgress = true) {
    const allFuncs = this.listFunctions();
    if (!allFuncs.length) return [];

    const counts = this.getCallCounts(showProgress);

    // bare_name -> [func records]
    const byBare = Object.create(null);
    for (const f of allFuncs) {
      let bare = f.name.includes('::') ? f.name.split('::').pop() : f.name;
      if (bare.includes('@')) bare = bare.split('@')[0];
      if (!byBare[bare]) byBare[bare] = [];
      byBare[bare].push(f);
    }

    const scored = [];
    const seen = new Set();

    for (const [bname, callCount] of Object.entries(counts)) {
      if (!byBare[bname]) continue;
      for (const f of byBare[bname]) {
        const key = `${f.filepath}|${f.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (f.lines < 2) continue;

        const score = callCount * Math.log2(Math.max(f.lines, 2));
        scored.push({
          name: f.name,
          filepath: f.filepath,
          display_name: f.displayName,
          lines: f.lines,
          calls: callCount,
          score,
          type: f.type,
          copies: 0,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, n);
  }

  /**
   * Find functions that are defined but rarely/never called - entry points.
   * Sorted by size descending (biggest uncalled functions are most important).
   */
  getEntryPoints(n = 25, maxCalls = 0, showProgress = true) {
    const allFuncs = this.listFunctions();
    if (!allFuncs.length) return [];

    const counts = this.getCallCounts(showProgress);
    const results = [];

    for (const f of allFuncs) {
      if (f.lines < 3) continue;
      let bare = f.name.includes('::') ? f.name.split('::').pop() : f.name;
      if (bare.includes('@')) bare = bare.split('@')[0];

      const callCount = counts[bare] || 0;
      if (callCount <= maxCalls) {
        results.push({
          name: f.name,
          filepath: f.filepath,
          display_name: f.displayName,
          lines: f.lines,
          calls: callCount,
          type: f.type,
          copies: 0,
        });
      }
    }

    results.sort((a, b) => b.lines - a.lines);
    return results;
  }

  /**
   * Find domain-specific important functions.
   * Score = calls x log₂(lines) / √(name_definitions_count)
   * Functions with rare names score higher, surfacing domain code.
   */
  getDomainHotspots(n = 25, showProgress = true) {
    const allFuncs = this.listFunctions();
    if (!allFuncs.length) return [];

    const counts = this.getCallCounts(showProgress);
    const bareNameCounts = this._getBareNameCounts();

    const scored = [];
    const seen = new Set();

    for (const f of allFuncs) {
      const key = `${f.filepath}|${f.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Ad hoc: skip very small functions (trivial accessors/getters) to reduce
      // noise in Domain Functions. Threshold and scoring formula should be revisited
      // — see TODO #254b for deeper approaches (fan-out, PageRank, UI-structure).
      if (f.lines < 5) continue;

      let bare = f.name.includes('::') ? f.name.split('::').pop() : f.name;
      if (bare.includes('@')) bare = bare.split('@')[0];

      const callCount = counts[bare] || 0;
      if (callCount < 1) continue;

      const nameCount = bareNameCounts[bare] || 1;
      // Weight size more heavily: sqrt(lines) instead of log2(lines) so that
      // 200-line functions score ~7x higher than 10-line functions (vs ~4x with log2)
      const score = callCount * Math.sqrt(Math.max(f.lines, 5)) / Math.sqrt(Math.max(nameCount, 1));

      scored.push({
        name: f.name,
        filepath: f.filepath,
        display_name: f.displayName,
        lines: f.lines,
        calls: callCount,
        score,
        name_count: nameCount,
        type: f.type,
        copies: 0,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  /**
   * Classes ranked by aggregated method hotspot score.
   * Score = sum(calls to methods) x log₂(total method lines) / √(name_count)
   */
  getClassHotspots(n = 25, showProgress = true) {
    const callCounts = this.getCallCounts(showProgress);
    const classes = this.listClasses();
    if (!classes.length) return [];

    const classNameCounts = {};
    for (const c of classes) {
      classNameCounts[c.name] = (classNameCounts[c.name] || 0) + 1;
    }

    for (const c of classes) {
      let totalCalls = 0;
      for (const method of c.methods) {
        let bare = method.name.split('.').pop().split('::').pop();
        if (bare.includes('@')) bare = bare.split('@')[0];
        totalCalls += callCounts[bare] || 0;
      }
      c.total_calls = totalCalls;

      const totalLines = c.total_method_lines > 0 ? c.total_method_lines : c.lines;
      const nameCount = classNameCounts[c.name] || 1;

      c.score = (totalCalls > 0 && totalLines > 0)
        ? (totalCalls * Math.log2(totalLines)) / Math.sqrt(nameCount)
        : 0;
      c.name_count = nameCount;
    }

    classes.sort((a, b) => b.score - a.score);
    return classes.slice(0, n * 3);
  }


  // ========================================================================
  // Structural normalization ("funcstrings") - Phase 4 dedup
  // ========================================================================

  /**
   * Structure-only keywords - these define the "tune".
   * Types, identifiers, and literals are all "words" that get normalized.
   */
  static STRUCTURE_KEYWORDS = new Set([
    // Control flow
    'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default',
    'break', 'continue', 'return', 'goto', 'throw', 'try', 'catch',
    'finally', 'yield', 'await', 'async',
    // Declaration structure (but NOT type names)
    'class', 'struct', 'enum', 'interface', 'extends', 'implements',
    'import', 'package', 'namespace', 'using', 'typedef', 'typename',
    // Access/storage modifiers (structural)
    'public', 'private', 'protected', 'static', 'final', 'const',
    'volatile', 'abstract', 'virtual', 'override', 'inline', 'extern',
    'synchronized', 'transient', 'native',
    // Operators/structural
    'new', 'delete', 'this', 'self', 'super', 'null', 'nil', 'None',
    'true', 'false', 'True', 'False',
    'sizeof', 'typeof', 'instanceof', 'is', 'as', 'in', 'not',
    'and', 'or', 'xor',
  ]);

  /**
   * Normalize function body text to its structural form ("funcstring").
   *
   * 1. Strip comments (// and multi-line)
   * 2. Replace string/char literals with placeholder
   * 3. Replace numeric literals with placeholder
   * 4. Replace ALL identifiers and type names with placeholder
   * 5. Keep only control-flow/structural keywords
   * 6. Normalize whitespace
   */
  getStructuralNormalized(bodyText) {
    let text = bodyText;

    // Step 1: Strip comments
    text = text.replace(/\/\/[^\n]*/g, '');
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');

    // Step 2: Replace string literals
    text = text.replace(/"(?:[^"\\]|\\.)*"/g, '"S"');
    text = text.replace(/'(?:[^'\\]|\\.)*'/g, "'C'");

    // Step 3: Replace numeric literals
    text = text.replace(/0[xX][0-9a-fA-F]+[lLuU]*/g, '0');
    text = text.replace(/\b\d+\.\d*(?:[eE][+-]?\d+)?[fFdD]?\b/g, '0');
    text = text.replace(/\b\.\d+(?:[eE][+-]?\d+)?[fFdD]?\b/g, '0');
    text = text.replace(/\b\d+[lLuU]*\b/g, '0');

    // Step 4: Replace identifiers and type names - only structural keywords survive
    const kw = CodeSearchIndex.STRUCTURE_KEYWORDS;
    text = text.replace(/[A-Za-z_]\w*/g, (word) => kw.has(word) ? word : '_');

    // Step 5: Normalize whitespace
    text = text.replace(/\s+/g, ' ').trim();

    return text;
  }

  /**
   * Compute structural hash (SHA1 of funcstring).
   */
  getStructuralHash(bodyText) {
    const normalized = this.getStructuralNormalized(bodyText);
    return crypto.createHash('sha1').update(normalized, 'utf-8').digest('hex');
  }

  /**
   * Extract word-holes from function body text.
   *
   * Strips comments, then walks the text extracting tokens in order.
   * Each token is classified as 'structure' (keyword/punctuation, part of the "tune")
   * or 'word' (identifier/literal, a replaceable "word hole").
   *
   * Returns: [{ type: 'word'|'structure', value: string }, ...]
   */
  extractWordHoles(bodyText) {
    const kw = CodeSearchIndex.STRUCTURE_KEYWORDS;

    // Step 1: Strip comments (same as normalizer)
    let text = bodyText;
    text = text.replace(/\/\/[^\n]*/g, '');
    text = text.replace(/\/\*[\s\S]*?\*\//g, '');

    const tokens = [];
    // Master regex: match tokens in priority order
    // Group 1: string literal   Group 2: char literal
    // Group 3: hex number       Group 4: float (leading digit)
    // Group 5: float (.N)       Group 6: integer
    // Group 7: identifier       Group 0 fallback: punctuation/operators
    const tokenRe = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|0[xX][0-9a-fA-F]+[lLuU]*|\b\d+\.\d*(?:[eE][+-]?\d+)?[fFdD]?\b|\.\d+(?:[eE][+-]?\d+)?[fFdD]?\b|\b\d+[lLuU]*\b|[A-Za-z_]\w*|[^\s]/g;

    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      const val = m[0];
      if (val.startsWith('"') || val.startsWith("'")) {
        // String/char literal - word hole
        tokens.push({ type: 'word', value: val });
      } else if (/^[0-9]/.test(val) || (val.startsWith('.') && /^\.\d/.test(val))
                 || /^0[xX]/.test(val)) {
        // Numeric literal - word hole
        tokens.push({ type: 'word', value: val });
      } else if (/^[A-Za-z_]/.test(val)) {
        // Identifier or keyword
        if (kw.has(val)) {
          tokens.push({ type: 'structure', value: val });
        } else {
          tokens.push({ type: 'word', value: val });
        }
      } else {
        // Punctuation/operator - structure
        tokens.push({ type: 'structure', value: val });
      }
    }
    return tokens;
  }

  /**
   * Compare structural dupe bodies by word-hole alignment.
   *
   * Takes an array of { body: string, label: string } objects - all must share
   * the same structural hash.
   *
   * Returns: {
   *   totalWordHoles: number,
   *   diffs: [{ position: number, values: string[] }],  // positions that differ
   *   substitutions: [{ from: string, to: string, count: number }], // detected rename patterns
   *   summary: string,  // one-line summary
   * }
   */
  structDiff(bodies) {
    if (bodies.length < 2) return null;

    // Extract word holes for each body
    const tokenSets = bodies.map(b => this.extractWordHoles(b.body));

    // Get word-hole-only tokens for each body
    const wordSets = tokenSets.map(tokens =>
      tokens.filter(t => t.type === 'word').map(t => t.value)
    );

    // Check alignment: all should have same number of word holes
    const lengths = wordSets.map(w => w.length);
    if (new Set(lengths).size > 1) {
      // Misaligned - shouldn't happen for true structural dupes
      return {
        totalWordHoles: lengths[0],
        diffs: [],
        substitutions: [],
        summary: `Word-hole count mismatch: ${lengths.join(' vs ')} - bodies may not be true structural dupes`,
        aligned: false,
      };
    }

    const nHoles = lengths[0];
    if (nHoles === 0) {
      return { totalWordHoles: 0, diffs: [], substitutions: [], summary: 'No word holes (pure structure)', aligned: true };
    }

    // Find positions where values differ
    const diffs = [];
    for (let i = 0; i < nHoles; i++) {
      const vals = wordSets.map(w => w[i]);
      if (new Set(vals).size > 1) {
        diffs.push({ position: i, values: vals });
      }
    }

    if (diffs.length === 0) {
      return { totalWordHoles: nHoles, diffs: [], substitutions: [], summary: 'All word-holes identical (bodies should be exact dupes)', aligned: true };
    }

    // Detect substitution patterns: pairs of values that always co-substitute
    // e.g. (log_error, LOG_ERROR) always appears together
    // Build mapping: for each pair of bodies (0 vs i), collect substitution pairs
    const subPatterns = {};
    for (const d of diffs) {
      const base = d.values[0];
      for (let i = 1; i < d.values.length; i++) {
        const other = d.values[i];
        if (base !== other) {
          const key = `${i}:${base}->${other}`;
          if (!subPatterns[key]) subPatterns[key] = 0;
          subPatterns[key]++;
        }
      }
    }

    // Collapse into substitution groups: "Order->Invoice x15"
    // Group by (bodyIndex, fromVal, toVal)
    const subGroups = {};
    for (const [key, count] of Object.entries(subPatterns)) {
      const bodyIdx = key.split(':')[0];
      const arrow = key.slice(bodyIdx.length + 1);
      if (!subGroups[arrow]) subGroups[arrow] = 0;
      subGroups[arrow] += count;
    }

    const substitutions = Object.entries(subGroups)
      .map(([arrow, count]) => {
        const [from, to] = arrow.split('->');
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count);

    // Build summary
    let summary;
    if (substitutions.length <= 3) {
      const parts = substitutions.map(s =>
        s.count > 1 ? `${s.from} -> ${s.to} (x${s.count})` : `${s.from} -> ${s.to}`
      );
      summary = `${diffs.length} of ${nHoles} word-holes differ: ${parts.join(', ')}`;
    } else {
      const topN = substitutions.slice(0, 3).map(s =>
        s.count > 1 ? `${s.from} -> ${s.to} (x${s.count})` : `${s.from} -> ${s.to}`
      );
      summary = `${diffs.length} of ${nHoles} word-holes differ: ${topN.join(', ')}, +${substitutions.length - 3} more`;
    }

    return {
      totalWordHoles: nHoles,
      diffs,
      substitutions,
      summary,
      aligned: true,
    };
  }

  /**
   * Path to func_hashes.json cache file.
   */
  _funcHashesPath() {
    return path.join(this.indexPath, 'func_hashes.json');
  }

  /**
   * Ensure function hashes are computed, using cache if available.
   *
   * Returns Map: (filepath, funcName) -> { body_hash, struct_hash, lines, asm_ops }
   *
   * Caches to func_hashes.json for fast subsequent loads.
   */
  ensureFuncHashes(minLines = 3, showProgress = true) {
    // Already computed this session?
    if (this._funcHashes) return this._funcHashes;

    const cachePath = this._funcHashesPath();

    // Try to load from cache
    if (fs.existsSync(cachePath)) {
      try {
        const raw = fs.readFileSync(cachePath, 'utf-8');
        const cached = JSON.parse(raw);
        // Check if cache has asm_ops field (added later)
        const sampleKey = Object.keys(cached)[0];
        if (sampleKey && cached[sampleKey] && !('asm_ops' in cached[sampleKey])) {
          if (showProgress) console.log('Cache missing asm_ops field, rebuilding...');
          // fall through
        } else {
          this._funcHashes = new Map();
          for (const [keyStr, val] of Object.entries(cached)) {
            const sep = keyStr.indexOf('|||');
            if (sep >= 0) {
              this._funcHashes.set(keyStr, val);
            }
          }
          if (showProgress) console.log(`Loaded ${this._funcHashes.size} cached function hashes`);
          return this._funcHashes;
        }
      } catch (e) {
        if (showProgress) console.log(`Cache load failed, recomputing: ${e.message}`);
      }
    }

    // Compute hashes
    const allFuncs = this.listFunctions();
    if (showProgress) console.log(`Hashing ${allFuncs.length} function bodies...`);

    // Regex to detect opstring MD5 in .op files
    const opstringMd5Re = /\/\/\s*\[(\d+)\s+asm\]\s+([0-9A-Fa-f]{8,})/;
    let opstringCount = 0;

    this._funcHashes = new Map();
    for (const f of allFuncs) {
      if (f.lines < minLines) continue;

      const fp = f.filepath;
      const lines = this.fileLines.get(fp);
      if (!lines) continue;

      const bodyLines = lines.slice(f.start - 1, f.end);
      const bodyText = bodyLines.join('\n');

      // Check for opstring MD5
      const opMatch = bodyText.match(opstringMd5Re);
      let bodyHash, structHash, asmOps;

      if (opMatch) {
        asmOps = parseInt(opMatch[1]);
        const opMd5 = opMatch[2].toLowerCase();
        bodyHash = opMd5;
        structHash = opMd5;
        opstringCount++;
      } else {
        asmOps = 0;
        bodyHash = crypto.createHash('sha1').update(bodyText, 'utf-8').digest('hex');
        structHash = this.getStructuralHash(bodyText);
      }

      const key = `${fp}|||${f.name}`;
      this._funcHashes.set(key, {
        body_hash: bodyHash,
        struct_hash: structHash,
        lines: f.lines,
        asm_ops: asmOps,
      });
    }

    if (showProgress && opstringCount > 0) {
      console.log(`  (${opstringCount} functions hashed via opstring MD5 for cross-binary matching)`);
    }

    // Save to cache
    try {
      const cacheData = {};
      for (const [key, val] of this._funcHashes) {
        cacheData[key] = val;
      }
      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf-8');
      if (showProgress) console.log(`Saved ${this._funcHashes.size} function hashes to cache`);
    } catch (e) {
      if (showProgress) console.log(`Warning: could not save hash cache: ${e.message}`);
    }

    return this._funcHashes;
  }

  /**
   * Find exact duplicate functions by SHA1 hash of body text.
   * Also computes structural and near-dupe groups.
   *
   * Returns top N exact dupe groups sorted by waste (descending).
   */
  getFuncDupes(n = 25, minLines = 3, showProgress = true) {
    const funcHashes = this.ensureFuncHashes(minLines, showProgress);
    const allFuncs = this.listFunctions();

    // Build groups
    const hashGroups = {};    // body_hash -> [func]
    const structGroups = {};  // struct_hash -> [func]
    const nameSizeGroups = {}; // "bare|lines" -> [func]

    for (const f of allFuncs) {
      if (f.lines < minLines) continue;

      const key = `${f.filepath}|||${f.name}`;
      const info = funcHashes.get(key);
      if (info) {
        f.body_hash = info.body_hash;
        f.struct_hash = info.struct_hash;
        f.asm_ops = info.asm_ops || 0;
        if (!hashGroups[info.body_hash]) hashGroups[info.body_hash] = [];
        hashGroups[info.body_hash].push(f);
        if (!structGroups[info.struct_hash]) structGroups[info.struct_hash] = [];
        structGroups[info.struct_hash].push(f);
      }

      // Track by name+size for near-dupe report
      let bare = f.name;
      if (bare.includes('::')) bare = bare.split('::').pop();
      if (bare.includes('@')) bare = bare.split('@')[0];
      f.bare_name = bare;
      const nsKey = `${bare}|${f.lines}`;
      if (!nameSizeGroups[nsKey]) nameSizeGroups[nsKey] = [];
      nameSizeGroups[nsKey].push(f);
    }

    // Exact dupe groups
    const dupeGroups = [];
    for (const [h, instances] of Object.entries(hashGroups)) {
      if (instances.length < 2) continue;
      const lines = instances[0].lines;
      const distinctFiles = new Set(instances.map(i => i.filepath)).size;
      dupeGroups.push({
        hash: h,
        bare_name: instances[0].bare_name || '?',
        lines,
        asm_ops: instances[0].asm_ops || 0,
        count: instances.length,
        n_files: distinctFiles,
        waste: (instances.length - 1) * lines,
        exact: true,
        instances,
      });
    }

    // Structural dupe groups
    const structDupeGroups = [];
    for (const [sh, instances] of Object.entries(structGroups)) {
      if (instances.length < 2) continue;
      const exactHashes = new Set(instances.map(i => i.body_hash || ''));
      if (exactHashes.size <= 1) continue; // all identical - covered by exact dupes
      const lines = instances[0].lines;
      const names = new Set(instances.map(i => i.displayName || i.name || '?'));
      structDupeGroups.push({
        hash: sh,
        bare_name: instances[0].bare_name || '?',
        lines,
        count: instances.length,
        unique_bodies: exactHashes.size,
        unique_names: names.size,
        waste: Math.floor((instances.length - 1) * lines * Math.log2(Math.max(lines, 2))),
        instances,
      });
    }

    // Near dupes: same name+size, different hash
    const nearDupes = [];
    for (const [, instances] of Object.entries(nameSizeGroups)) {
      if (instances.length < 2) continue;
      const hashes = new Set(instances.map(i => i.body_hash || '').filter(Boolean));
      if (hashes.size > 1) {
        nearDupes.push({
          hash: 'mixed',
          bare_name: instances[0].bare_name,
          lines: instances[0].lines,
          count: instances.length,
          waste: 0,
          exact: false,
          unique_variants: hashes.size,
          instances,
        });
      }
    }

    // Sort
    dupeGroups.sort((a, b) => b.waste - a.waste);
    structDupeGroups.sort((a, b) => b.waste - a.waste);

    if (showProgress) {
      const totalWaste = dupeGroups.reduce((s, g) => s + g.waste, 0);
      console.log(`Found ${dupeGroups.length} exact duplicate groups (${totalWaste} redundant lines)`);
      if (structDupeGroups.length > 0)
        console.log(`Found ${structDupeGroups.length} structural duplicate groups (same structure, different names/values)`);
      if (nearDupes.length > 0)
        console.log(`Found ${nearDupes.length} near-duplicate groups (same name+size, different content)`);
    }

    // Store for separate access
    this._nearDupes = nearDupes;
    this._structDupes = structDupeGroups;

    return dupeGroups.slice(0, n);
  }

  /**
   * Return near-duplicate groups. Must call getFuncDupes first.
   */
  getNearDupes(n = 25) {
    const near = this._nearDupes || [];
    near.sort((a, b) => (b.count * b.lines) - (a.count * a.lines));
    return near.slice(0, n);
  }

  /**
   * Return structural duplicate groups. Must call getFuncDupes first.
   */
  getStructDupes(n = 25) {
    const struct = this._structDupes || [];
    struct.sort((a, b) => b.waste - a.waste);
    return struct.slice(0, n);
  }

  /**
   * Get mapping: each function -> its canonical representative.
   * For functions with identical hash, picks shortest filepath as canonical.
   */
  getCanonicalFuncs(mode = 'exact') {
    const cacheKey = `_canonicalFuncs_${mode}`;
    const copiesKey = `_canonicalCopies_${mode}`;
    if (this[cacheKey]) return this[cacheKey];

    const hashes = this.ensureFuncHashes(3, false);
    const hashKey = mode === 'exact' ? 'body_hash' : 'struct_hash';

    // Group by hash
    const groups = {};
    for (const [key, info] of hashes) {
      const h = info[hashKey];
      if (!groups[h]) groups[h] = [];
      groups[h].push(key);
    }

    const canonicalFuncs = {};
    const canonicalCopies = {};

    for (const funcs of Object.values(groups)) {
      if (funcs.length === 1) {
        canonicalFuncs[funcs[0]] = funcs[0];
        continue;
      }
      // Pick shortest filepath as canonical
      const canonical = funcs.slice().sort((a, b) => a.length - b.length)[0];
      canonicalFuncs[canonical] = canonical;
      canonicalCopies[canonical] = funcs.filter(f => f !== canonical);
      for (const f of funcs) {
        if (f !== canonical) canonicalFuncs[f] = canonical;
      }
    }

    this[cacheKey] = canonicalFuncs;
    this[copiesKey] = canonicalCopies;
    return canonicalFuncs;
  }

  /**
   * Get number of duplicate copies for a function (0 if no dupes).
   */
  getCopyCount(filepath, funcName, mode = 'exact') {
    this.getCanonicalFuncs(mode);
    const copies = this[`_canonicalCopies_${mode}`] || {};
    const key = `${filepath}|||${funcName}`;
    return (copies[key] || []).length;
  }

  /**
   * Check if this function is the canonical representative (not a copy).
   */
  isCanonical(filepath, funcName, mode = 'exact') {
    const canon = this.getCanonicalFuncs(mode);
    const key = `${filepath}|||${funcName}`;
    return canon[key] === key || !(key in canon);
  }


  // ========================================================================
  // Vocabulary discovery (TF-IDF)
  // ========================================================================

  /**
   * Universal programming stopwords - tokens too generic to be "vocabulary".
   * Combined with STRUCTURE_KEYWORDS and dynamic >60% frequency cutoff.
   */
  static PROGRAMMING_STOPWORDS = new Set([
    // C standard library
    'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'sscanf',
    'malloc', 'calloc', 'realloc', 'free',
    'memcpy', 'memset', 'memmove', 'memcmp',
    'strlen', 'strcpy', 'strncpy', 'strcat', 'strcmp', 'strncmp', 'strstr',
    'fopen', 'fclose', 'fread', 'fwrite', 'fgets', 'fputs', 'fflush', 'fseek',
    'atoi', 'atof', 'atol', 'strtol', 'strtoul', 'strtod',
    'exit', 'abort', 'atexit',
    'stdin', 'stdout', 'stderr', 'errno', 'NULL',
    'argc', 'argv', 'envp',
    'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t', 'uintptr_t',
    'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
    'int8_t', 'int16_t', 'int32_t', 'int64_t',
    'bool', 'char', 'short', 'long', 'float', 'double',
    'unsigned', 'signed', 'void', 'auto', 'register',
    // C++ common
    'std', 'string', 'vector', 'map', 'set', 'list', 'pair', 'tuple',
    'begin', 'end', 'size', 'empty', 'push_back', 'emplace_back',
    'iterator', 'const_iterator', 'reverse_iterator',
    'make_shared', 'make_unique', 'shared_ptr', 'unique_ptr', 'weak_ptr',
    'move', 'forward', 'swap',
    'cout', 'cin', 'cerr', 'endl',
    'dynamic_cast', 'static_cast', 'reinterpret_cast', 'const_cast',
    'nullptr', 'noexcept', 'constexpr', 'decltype',
    'ASSERT', 'DCHECK', 'CHECK', 'DCHECK_EQ', 'DCHECK_NE',
    'DCHECK_LT', 'DCHECK_GT', 'DCHECK_LE', 'DCHECK_GE',
    'NOTREACHED', 'DISALLOW_COPY_AND_ASSIGN',
    // Java/C# common
    'String', 'Integer', 'Boolean', 'Object', 'Class',
    'ArrayList', 'HashMap', 'HashSet', 'LinkedList', 'TreeMap',
    'toString', 'equals', 'hashCode', 'compareTo', 'clone',
    'Exception', 'RuntimeException', 'IOException', 'NullPointerException',
    'Override', 'Deprecated', 'SuppressWarnings',
    'System', 'println', 'print',
    'main', 'args', 'self', 'this', 'super', 'cls',
    // Python common
    'None', 'True', 'False',
    'print', 'len', 'range', 'enumerate', 'zip', 'sorted', 'reversed',
    'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr', 'delattr',
    'dict', 'list', 'tuple', 'set', 'frozenset', 'str', 'int', 'float',
    'open', 'close', 'read', 'write', 'readline', 'readlines',
    'append', 'extend', 'insert', 'remove', 'pop', 'clear',
    'keys', 'values', 'items', 'get', 'update',
    'join', 'split', 'strip', 'replace', 'find', 'startswith', 'endswith',
    'format', 'encode', 'decode',
    '__init__', '__str__', '__repr__', '__len__', '__getitem__', '__setitem__',
    '__enter__', '__exit__', '__call__', '__iter__', '__next__',
    // JavaScript/TypeScript common
    'undefined', 'NaN', 'Infinity',
    'console', 'log', 'warn', 'error', 'info', 'debug',
    'require', 'module', 'exports', 'default',
    'document', 'window', 'global', 'process',
    'prototype', 'constructor', 'apply', 'call', 'bind',
    'then', 'catch', 'finally', 'resolve', 'reject',
    'Promise', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet',
    'JSON', 'parse', 'stringify',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'addEventListener', 'removeEventListener',
    'createElement', 'getElementById', 'querySelector', 'querySelectorAll',
    'forEach', 'filter', 'reduce', 'some', 'every', 'includes',
    'push', 'shift', 'unshift', 'slice', 'splice', 'concat',
    'length', 'indexOf', 'lastIndexOf',
    // General programming
    'init', 'setup', 'cleanup', 'destroy', 'dispose', 'reset',
    'create', 'delete', 'add', 'remove', 'insert', 'update',
    'start', 'stop', 'run', 'execute', 'invoke',
    'name', 'value', 'key', 'index', 'count', 'result', 'data',
    'type', 'kind', 'mode', 'state', 'status', 'flag', 'level',
    'buf', 'buffer', 'tmp', 'temp', 'ret', 'err', 'msg',
    'param', 'params', 'config', 'options', 'opts', 'settings',
    'input', 'output', 'src', 'dst', 'source', 'dest', 'target',
    'path', 'file', 'dir', 'filename', 'filepath',
    'test', 'spec', 'mock', 'stub', 'fixture', 'expect', 'assert',
    'TODO', 'FIXME', 'HACK', 'XXX', 'NOTE',
    'true', 'false', 'null', 'nil',
    // Very short identifiers (covered by minLength=3 filter mostly)
    'fn', 'cb', 'el', 'ev', 'ex', 'id', 'it', 'ok', 'op',
  ]);

  /** Path to vocabulary cache file. */
  _vocabularyPath() {
    return path.join(this.indexPath, 'vocabulary.json');
  }

  /**
   * Build vocabulary index: per-token document frequency, total count,
   * and top representative files.
   *
   * Caches to vocabulary.json (global only; filtered queries are not cached).
   *
   * @param {boolean} showProgress
   * @param {string|null} pathFilter - if provided, only scan files whose path contains this string
   * @returns Map: token -> { doc_freq, total_count, score, top_files: [{path, count, concentration}] }
   */
  ensureVocabulary(showProgress = true, pathFilter = null) {
    // Global (unfiltered) vocabulary uses cache
    if (!pathFilter) {
      if (this._vocabulary) return this._vocabulary;

      const cachePath = this._vocabularyPath();

      // Try cache
      if (fs.existsSync(cachePath)) {
        try {
          const raw = fs.readFileSync(cachePath, 'utf-8');
          const cached = JSON.parse(raw);
          if (cached._version === 1 && cached._file_count === this.files.size) {
            this._vocabulary = new Map();
            for (const [token, entry] of Object.entries(cached.tokens || {})) {
              this._vocabulary.set(token, entry);
            }
            if (showProgress) console.log(`Loaded ${this._vocabulary.size} cached vocabulary tokens`);
            return this._vocabulary;
          }
          if (showProgress) console.log('Vocabulary cache stale, rebuilding...');
        } catch (e) {
          if (showProgress) console.log(`Vocabulary cache load failed, recomputing: ${e.message}`);
        }
      }
    }

    // Determine which files to scan
    let fileEntries = [...this.files.entries()];
    if (pathFilter) {
      const pat = pathFilter.toLowerCase();
      fileEntries = fileEntries.filter(([fp]) => fp.toLowerCase().includes(pat));
      if (fileEntries.length === 0) {
        if (showProgress) console.log(`No files matching '${pathFilter}' found.`);
        return new Map();
      }
    }

    const totalFiles = fileEntries.length;
    if (totalFiles === 0) {
      if (!pathFilter) this._vocabulary = new Map();
      return new Map();
    }

    const label = pathFilter ? `${totalFiles} files matching '${pathFilter}'` : `${totalFiles} files`;
    if (showProgress) console.log(`Building vocabulary index for ${label}...`);

    const vocabulary = this._buildVocabularyFromFiles(fileEntries, totalFiles, showProgress);

    // Cache global vocabulary only
    if (!pathFilter) {
      this._vocabulary = vocabulary;
      const cachePath = this._vocabularyPath();
      try {
        const cacheObj = {
          _version: 1,
          _file_count: this.files.size,
          _generated: new Date().toISOString(),
          tokens: {},
        };
        const sorted = [...vocabulary.entries()].sort((a, b) => b[1].score - a[1].score);
        for (const [token, entry] of sorted.slice(0, 15000)) {
          cacheObj.tokens[token] = entry;
        }
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, JSON.stringify(cacheObj, null, 1));
        if (showProgress) console.log(`  Saved vocabulary cache to ${path.basename(cachePath)}`);
      } catch (e) {
        if (showProgress) console.log(`  Warning: could not save vocabulary cache: ${e.message}`);
      }
    }

    return vocabulary;
  }

  /**
   * Core two-pass vocabulary builder.
   * @param {Array<[string, string]>} fileEntries - [filepath, content] pairs
   * @param {number} totalFiles - count for IDF denominator
   * @param {boolean} showProgress
   * @returns {Map}
   */
  _buildVocabularyFromFiles(fileEntries, totalFiles, showProgress) {
    const kw = CodeSearchIndex.STRUCTURE_KEYWORDS;
    const stopwords = CodeSearchIndex.PROGRAMMING_STOPWORDS;
    const minTokenLen = 3;
    const maxTokenLen = 200;  // skip absurdly long tokens (concatenated strings, etc.)

    const identRe = /[A-Za-z_]\w*/g;

    // NOTE: We intentionally tokenize comments and string literals.
    // Domain-specific vocabulary frequently appears in JSDoc, docstrings,
    // SQL strings, error messages, etc.  The stopword filter and frequency
    // cutoffs handle generic words like "the", "return", etc.

    // ----------------------------------------------------------------
    // Pass 1: Count doc_freq and total_count ONLY
    // ----------------------------------------------------------------
    const tokenStats = Object.create(null);
    let fileNum = 0;

    for (const [filepath, content] of fileEntries) {
      fileNum++;
      if (showProgress && fileNum % 2000 === 0) {
        process.stdout.write(`  Pass 1: scanning ${fileNum} / ${totalFiles} files...\r`);
      }

      const ext = path.extname(filepath).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) continue;

      const text = content;
      const seenInFile = new Set();
      let m;
      identRe.lastIndex = 0;

      while ((m = identRe.exec(text)) !== null) {
        const token = m[0];
        if (token.length < minTokenLen) continue;
        if (token.length > maxTokenLen) continue;
        if (kw.has(token)) continue;
        if (stopwords.has(token)) continue;
        if (token.length >= 4 && /^[A-Z][A-Z_0-9]+$/.test(token)) continue;

        if (!tokenStats[token]) {
          tokenStats[token] = { doc_freq: 0, total_count: 0 };
        }
        tokenStats[token].total_count++;

        if (!seenInFile.has(token)) {
          seenInFile.add(token);
          tokenStats[token].doc_freq++;
        }
      }
    }

    if (showProgress) {
      process.stdout.write(`  Pass 1: scanned ${totalFiles} files.                    \n`);
    }

    // Score and filter
    const freqCutoff = Math.max(5, Math.floor(totalFiles * 0.6));
    const minDocFreq = 2;

    const scored = [];
    const allTokenCount = Object.keys(tokenStats).length;

    for (const token of Object.keys(tokenStats)) {
      const stats = tokenStats[token];
      if (stats.doc_freq < minDocFreq) continue;
      if (stats.doc_freq > freqCutoff) continue;

      const idf = Math.log2(totalFiles / stats.doc_freq);
      const lengthBoost = Math.pow(token.length, 0.75);

      const parts = token
        .split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|_/)
        .filter(p => p.length > 0).length;
      const compoundBonus = Math.min(1 + 0.3 * (parts - 1), 2.5);

      const score = stats.doc_freq * idf * lengthBoost * compoundBonus;

      scored.push({
        token,
        doc_freq: stats.doc_freq,
        total_count: stats.total_count,
        score: Math.round(score * 100) / 100,
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const topN = 5000;
    const topTokenSet = new Set(scored.slice(0, topN).map(e => e.token));

    if (showProgress) {
      console.log(`  ${scored.length} vocabulary tokens (${allTokenCount} unique, ` +
        `${allTokenCount - scored.length} filtered by frequency/length)`);
    }

    // Free Pass 1 data
    for (const key of Object.keys(tokenStats)) {
      delete tokenStats[key];
    }

    // ----------------------------------------------------------------
    // Pass 2: Representative files for top tokens only
    // ----------------------------------------------------------------
    if (showProgress && topTokenSet.size > 0) {
      process.stdout.write(`  Pass 2: finding representative files for top ${topTokenSet.size} tokens...\r`);
    }

    const fileCountsForTop = Object.create(null);
    for (const t of topTokenSet) {
      fileCountsForTop[t] = Object.create(null);
    }

    fileNum = 0;
    for (const [filepath, content] of fileEntries) {
      fileNum++;
      if (showProgress && fileNum % 5000 === 0) {
        process.stdout.write(`  Pass 2: scanning ${fileNum} / ${totalFiles} files...\r`);
      }

      const ext = path.extname(filepath).toLowerCase();
      if (TEXT_EXTENSIONS.has(ext)) continue;

      const text = content;
      let m;
      identRe.lastIndex = 0;

      while ((m = identRe.exec(text)) !== null) {
        const token = m[0];
        if (!topTokenSet.has(token)) continue;

        if (!fileCountsForTop[token][filepath]) {
          fileCountsForTop[token][filepath] = 0;
        }
        fileCountsForTop[token][filepath]++;
      }
    }

    if (showProgress) {
      process.stdout.write(`  Pass 2: scanned ${totalFiles} files.                    \n`);
    }

    // Build final vocabulary map
    const vocabulary = new Map();

    for (const entry of scored.slice(0, topN)) {
      const fc = fileCountsForTop[entry.token] || {};
      const filePairs = Object.entries(fc)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      const topFiles = filePairs.map(([fp, count]) => {
        const fileLines = this.fileLines.get(fp);
        const fileTokenCount = fileLines ? fileLines.length : 100;
        return {
          path: fp,
          count,
          concentration: count / fileTokenCount,
        };
      });

      vocabulary.set(entry.token, {
        doc_freq: entry.doc_freq,
        total_count: entry.total_count,
        score: entry.score,
        top_files: topFiles,
      });
    }

    // Remaining scored tokens without top_files
    for (const entry of scored.slice(topN)) {
      vocabulary.set(entry.token, {
        doc_freq: entry.doc_freq,
        total_count: entry.total_count,
        score: entry.score,
        top_files: [],
      });
    }

    return vocabulary;
  }

  /**
   * Get top vocabulary tokens sorted by score, optionally filtered.
   *
   * @param {number} n - max results
   * @param {string|null} filter - substring filter on token name
   * @param {string|null} pathFilter - only scan files whose path contains this string
   * @returns {Array<{ token, doc_freq, total_count, score, top_files }>}
   */
  getTopVocabulary(n = 50, filter = null, pathFilter = null) {
    const vocab = pathFilter
      ? this.ensureVocabulary(true, pathFilter)
      : this.ensureVocabulary();
    let entries = [...vocab.entries()].map(([token, data]) => ({ token, ...data }));

    if (filter) {
      const pat = filter.toLowerCase();
      entries = entries.filter(e => e.token.toLowerCase().includes(pat));
    }

    entries.sort((a, b) => b.score - a.score);
    return entries.slice(0, n);
  }


  /**
   * Build a vocabulary concordance for LLM prompts.
   *
   * Takes top vocabulary tokens, splits compound names into sub-tokens,
   * deduplicates and scores them, then formats for inclusion in an LLM
   * prompt as a domain concordance.
   *
   * When claimKeywords are provided, vocabulary is filtered to only include
   * terms with surface-level relevance to the claim - exact matches,
   * substring containment, or shared stems. This prevents sending the LLM
   * 150 irrelevant terms about 'multisect' when the claim is about
   * 'facade servers'.
   *
   * Two tiers:
   *   Tier 1 (subTokens): Unique domain sub-tokens extracted from compound
   *     names (e.g., 'multisect', 'hotspot', 'callee', 'sanitize').
   *     For BROAD term generation - these are actual searchable words.
   *   Tier 2 (functionNames): Key function/method names showing what the
   *     codebase implements (e.g., 'doClaimAnalyze', 'findCallees').
   *     For understanding code capabilities.
   *
   * @param {object} opts
   * @param {number} [opts.topN=300]            - How many top vocab entries to process
   * @param {number} [opts.maxSubTokens=150]    - Max unique sub-tokens to return
   * @param {number} [opts.maxFuncNames=40]     - Max function names to return
   * @param {string|null} [opts.pathFilter]     - Only scan files matching this path
   * @param {Set<string>|null} [opts.claimKeywords] - Claim keywords for relevance filtering
   * @returns {{ subTokens: Array<{token, score, relevance, parentCount, exampleParents}>,
   *             functionNames: Array<{name, file, score, relevance}>,
   *             stats: {totalVocab, processedEntries, uniqueSubTokens, claimFiltered} }}
   */
  getVocabularyForPrompt(opts = {}) {
    const {
      topN = 300,
      maxSubTokens = 150,
      maxFuncNames = 40,
      pathFilter = null,
      claimKeywords = null,
    } = opts;

    const topEntries = this.getTopVocabulary(topN, null, pathFilter);

    // --- Tier 1: Split compound tokens into sub-tokens ---
    // Track each sub-token's aggregate score and which parents it came from
    const subTokenMap = new Map();  // subtoken -> { score, parentCount, exampleParents }

    for (const entry of topEntries) {
      const parts = splitCompoundToken(entry.token);
      for (const part of parts) {
        if (!subTokenMap.has(part)) {
          subTokenMap.set(part, {
            score: 0,
            parentCount: 0,
            exampleParents: [],
          });
        }
        const st = subTokenMap.get(part);
        st.score += entry.score;
        st.parentCount++;
        if (st.exampleParents.length < 3) {
          st.exampleParents.push(entry.token);
        }
      }
    }

    // --- Claim-aware relevance scoring ---
    // When claim keywords are provided, score each sub-token by how well
    // it matches claim concepts. Unrelated terms get relevance 0.
    let subTokensSorted;
    const claimFiltered = !!(claimKeywords && claimKeywords.size > 0);

    if (claimFiltered) {
      const kwArray = [...claimKeywords];  // for iteration

      const scored = [...subTokenMap.entries()].map(([token, data]) => {
        const relevance = _computeTokenRelevance(token, kwArray);
        return { token, ...data, relevance };
      });

      // Keep only tokens with some relevance to the claim
      const relevant = scored.filter(st => st.relevance > 0);

      // Sort by relevance first, then by vocab score as tiebreaker
      relevant.sort((a, b) => {
        const rDiff = b.relevance - a.relevance;
        if (Math.abs(rDiff) > 0.01) return rDiff;
        return b.score - a.score;
      });

      subTokensSorted = relevant.slice(0, maxSubTokens);
    } else {
      // No claim keywords - return all sub-tokens by vocab score (original behavior)
      subTokensSorted = [...subTokenMap.entries()]
        .map(([token, data]) => ({ token, ...data, relevance: 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSubTokens);
    }

    // --- Tier 2: Function names ---
    // Filter to entries that look like function/method names
    const funcNameEntries = topEntries.filter(e => {
      const t = e.token;
      if (/^[a-z]+[A-Z]/.test(t)) return true;   // camelCase
      if (/^do[A-Z]/.test(t)) return true;         // doSomething
      if (/^(build|parse|find|extract|resolve|sanitize|display|print|ensure|load|run|search|handle)[A-Z_]/.test(t)) return true;
      return false;
    });

    let functionNames;
    if (claimFiltered) {
      // Score function names by whether their sub-tokens overlap with claim
      const kwArray = [...claimKeywords];
      const scoredFuncs = funcNameEntries.map(e => {
        const parts = splitCompoundToken(e.token);
        let maxRel = 0;
        for (const part of parts) {
          const rel = _computeTokenRelevance(part, kwArray);
          if (rel > maxRel) maxRel = rel;
        }
        return {
          name: e.token,
          file: (e.top_files && e.top_files[0]) ? e.top_files[0].path : '',
          score: e.score,
          relevance: maxRel,
        };
      });

      functionNames = scoredFuncs
        .filter(fn => fn.relevance > 0)
        .sort((a, b) => b.relevance - a.relevance || b.score - a.score)
        .slice(0, maxFuncNames);
    } else {
      functionNames = funcNameEntries
        .slice(0, maxFuncNames)
        .map(e => ({
          name: e.token,
          file: (e.top_files && e.top_files[0]) ? e.top_files[0].path : '',
          score: e.score,
          relevance: 0,
        }));
    }

    // Stats for diagnostics
    const vocab = pathFilter
      ? this.ensureVocabulary(false, pathFilter)
      : this.ensureVocabulary(false);

    return {
      subTokens: subTokensSorted,
      functionNames,
      stats: {
        totalVocab: vocab.size,
        processedEntries: topEntries.length,
        uniqueSubTokens: subTokenMap.size,
        claimFiltered,
      },
    };
  }


  /**
   * Format vocabulary concordance as a compact string for LLM prompts.
   *
   * Two formats:
   *   'compact' - sub-tokens only, one per line. ~200-400 tokens.
   *               For local 7B models with tight context budgets.
   *   'rich'    - sub-tokens + function names with files. ~500-1000 tokens.
   *               For Claude or larger models.
   *
   * @param {string} [format='compact'] - 'compact' or 'rich'
   * @param {object} [opts] - Passed to getVocabularyForPrompt
   * @returns {string} Formatted concordance text
   */
  formatVocabularyForPrompt(format = 'compact', opts = {}) {
    const { subTokens, functionNames, stats } = this.getVocabularyForPrompt(opts);

    if (subTokens.length === 0) {
      return '';  // No vocabulary available (or no claim-relevant terms found)
    }

    const filterNote = stats.claimFiltered
      ? ` - filtered to claim-relevant terms`
      : '';

    if (format === 'compact') {
      // Tier 1 only: plain token list, ~1 token per word
      const lines = subTokens.map(st => st.token);
      return `CODEBASE VOCABULARY (${lines.length} domain terms from ${stats.totalVocab} indexed${filterNote}):\n` +
        lines.join(', ');
    }

    // 'rich' format: sub-tokens with example parents + function names
    let text = `CODEBASE VOCABULARY (${subTokens.length} domain terms from ${stats.totalVocab} indexed${filterNote}):\n`;

    // Sub-tokens with example compound parents
    for (const st of subTokens.slice(0, 100)) {
      const parents = st.exampleParents.slice(0, 2).join(', ');
      text += `  ${st.token} (in: ${parents})\n`;
    }

    // Function names
    if (functionNames.length > 0) {
      text += `\nKEY FUNCTIONS (${functionNames.length} relevant functions in this codebase):\n`;
      for (const fn of functionNames) {
        const file = fn.file ? fn.file.replace(/.*[\\/]/, '') : '';
        text += `  ${fn.name}${file ? '  [' + file + ']' : ''}\n`;
      }
    }

    return text;
  }


  // ========================================================================
  // Multi-term intersection search (#146 "scavenger hunt")
  // ========================================================================

  /**
   * Multi-term intersection search.
   *
   * Two-phase approach:
   *   Phase 1: Scan file lines to collect file sets per term (fast).
   *   Phase 2: Detail retrieval for survivor files only - line numbers,
   *            line text, containing function via bisect.
   *
   * Finds the smallest scope (function -> file -> folder) containing
   * multiple terms simultaneously.
   *
   * @param {Array<{display, regex, negated}>} terms
   * @param {Object} opts
   * @param {number|null} opts.minTerms - minimum positive terms required
   * @param {string[]|null} opts.includePath
   * @param {string[]|null} opts.excludePath
   * @param {boolean} opts.showProgress
   * @returns {Object|null} results with function_matches, file_matches, folder_matches
   */
  multisectSearch(terms, opts = {}) {
    const { minTerms: minTermsArg, includePath, excludePath, showProgress = true } = opts;

    const positiveIndices = [];
    const notIndices = [];
    for (let i = 0; i < terms.length; i++) {
      if (terms[i].negated) notIndices.push(i);
      else positiveIndices.push(i);
    }
    const nPositive = positiveIndices.length;
    const nTerms = terms.length;

    let minTerms = minTermsArg || nPositive;
    minTerms = Math.max(1, Math.min(minTerms, nPositive));

    this._ensureFunctionIndex();

    // ----------------------------------------------------------------
    // Phase 1: File-set scan
    // ----------------------------------------------------------------
    const phase1Start = Date.now();
    const termFileSets = new Array(nTerms).fill(null).map(() => new Set());
    const termPathOnlySets = new Array(nTerms).fill(null).map(() => new Set());
    const termFileCounts = new Array(nTerms).fill(0);

    // Path filter helper
    const pathOk = (fp) => {
      const fpL = fp.toLowerCase();
      if (includePath && !includePath.some(p => fpL.includes(p.toLowerCase()))) return false;
      if (excludePath && excludePath.some(p => fpL.includes(p.toLowerCase()))) return false;
      return true;
    };

    let fileNum = 0;
    const totalFiles = this.fileLines.size;

    for (const [filepath, lines] of this.fileLines) {
      fileNum++;
      if (showProgress && fileNum % 5000 === 0) {
        process.stderr.write(`  Phase 1: ${fileNum} / ${totalFiles} files...\r`);
      }
      if (!pathOk(filepath)) continue;

      for (let ti = 0; ti < nTerms; ti++) {
        const regex = terms[ti].regex;
        let foundInContent = false;
        for (const line of lines) {
          if (regex.test(line)) {
            termFileSets[ti].add(filepath);
            foundInContent = true;
            break;
          }
        }
        // Also check if term matches in the filepath itself (path/filename)
        if (!foundInContent) {
          regex.lastIndex = 0;  // reset stateful regex
          if (regex.test(filepath)) {
            termFileSets[ti].add(filepath);
            // Mark as path-only match for Phase 2
            termPathOnlySets[ti].add(filepath);
          }
        }
      }
    }

    for (let ti = 0; ti < nTerms; ti++) {
      termFileCounts[ti] = termFileSets[ti].size;
    }

    // Compute file-level survivors
    const filePosTerms = new Map();  // filepath -> Set of positive term indices
    for (const ti of positiveIndices) {
      for (const fp of termFileSets[ti]) {
        if (!filePosTerms.has(fp)) filePosTerms.set(fp, new Set());
        filePosTerms.get(fp).add(ti);
      }
    }

    const notIdxSet = new Set(notIndices);
    const fileSurvivors = new Set();
    for (const [fp, matchedPos] of filePosTerms) {
      if (matchedPos.size >= minTerms) {
        if (!notIndices.some(ni => termFileSets[ni].has(fp))) {
          fileSurvivors.add(fp);
        }
      }
    }

    const phase1Time = Date.now() - phase1Start;
    if (showProgress) {
      process.stderr.write(`  Phase 1: ${fileSurvivors.size} survivor files ` +
        `(from ${filePosTerms.size} candidates) in ${(phase1Time / 1000).toFixed(1)}s\n`);
    }

    // Build folder-level data
    const folderMap = {};  // folder -> { termIdx -> Set of filepaths }
    for (let ti = 0; ti < nTerms; ti++) {
      for (const fp of termFileSets[ti]) {
        const norm = fp.replace(/\\/g, '/');
        const parts = norm.split('/');
        for (let depth = 1; depth < parts.length; depth++) {
          const folder = parts.slice(0, depth).join('/');
          if (!folderMap[folder]) folderMap[folder] = {};
          if (!folderMap[folder][ti]) folderMap[folder][ti] = new Set();
          folderMap[folder][ti].add(fp);
        }
      }
    }

    // ----------------------------------------------------------------
    // Phase 1b: Identify class-candidate files
    // A class spans multiple functions possibly in multiple files.
    // Compute which classes meet minTerms across their methods' files,
    // then add those files to Phase 2 scanning.
    // ----------------------------------------------------------------
    const classTermSets = new Map();  // className -> { termIdx -> Set of files }
    const classFilesP1 = new Map();   // className -> Set of files

    for (const [fpath, functions] of Object.entries(this.functionIndex || {})) {
      for (const [fname] of Object.entries(functions)) {
        let className = null;
        if (fname.includes('::')) {
          className = fname.split('::').slice(0, -1).join('::');
        } else if (fname.includes('.')) {
          className = fname.split('.').slice(0, -1).join('.');
        }
        if (!className) continue;

        if (!classFilesP1.has(className)) classFilesP1.set(className, new Set());
        classFilesP1.get(className).add(fpath);

        // Check which terms this file contributes
        for (let ti = 0; ti < nTerms; ti++) {
          if (terms[ti].negated) continue;
          if (termFileSets[ti].has(fpath)) {
            if (!classTermSets.has(className)) classTermSets.set(className, new Map());
            const cts = classTermSets.get(className);
            if (!cts.has(ti)) cts.set(ti, new Set());
            cts.get(ti).add(fpath);
          }
        }
      }
    }

    // Find classes whose combined term coverage meets minTerms
    const classCandidateFiles = new Set();
    for (const [className, cts] of classTermSets) {
      const posCovered = [...cts.keys()].filter(ti => !notIdxSet.has(ti));
      if (posCovered.length >= minTerms) {
        // Add all files for this class to the Phase 2 scan
        const cf = classFilesP1.get(className);
        if (cf) {
          for (const fp of cf) {
            if (pathOk(fp)) classCandidateFiles.add(fp);
          }
        }
      }
    }

    if (showProgress && classCandidateFiles.size > 0) {
      const extra = [...classCandidateFiles].filter(fp => !fileSurvivors.has(fp)).length;
      if (extra > 0) {
        process.stderr.write(`  Phase 1b: ${extra} additional files from class candidates\n`);
      }
    }

    // ----------------------------------------------------------------
    // Phase 2: Detail retrieval for survivors + class candidate files
    // ----------------------------------------------------------------
    const phase2Start = Date.now();

    // Combine file survivors and class candidate files
    const phase2Files = new Set([...fileSurvivors, ...classCandidateFiles]);

    // Pre-build function boundaries
    const funcBoundariesCache = {};
    for (const fp of phase2Files) {
      funcBoundariesCache[fp] = this._getFuncBoundaries(fp);
    }

    // funcMap[(filepath, funcName)] -> { termIdx: { line_num, line_text } }
    const funcMap = new Map();
    // fileDetailMap[filepath] -> { termIdx: { line_num, line_text, func_name } }
    const fileDetailMap = new Map();

    const sortedSurvivors = [...phase2Files].sort();
    for (let fpIdx = 0; fpIdx < sortedSurvivors.length; fpIdx++) {
      const fp = sortedSurvivors[fpIdx];
      const lines = this.fileLines.get(fp);
      if (!lines || lines.length === 0) continue;
      const boundaries = funcBoundariesCache[fp];

      if (showProgress && phase2Files.size > 50 && (fpIdx + 1) % 100 === 0) {
        process.stderr.write(`  Phase 2: ${fpIdx + 1}/${phase2Files.size} files...\r`);
      }

      for (let ti = 0; ti < nTerms; ti++) {
        if (terms[ti].negated) continue;
        if (!termFileSets[ti].has(fp)) continue;

        // Check if this was a path-only match (term not in file content)
        if (termPathOnlySets[ti].has(fp)) {
          // Record as file-level hit with synthetic "path match" detail
          // Do NOT add to function-level (path is not inside any function)
          if (!fileDetailMap.has(fp)) fileDetailMap.set(fp, {});
          const fDetails = fileDetailMap.get(fp);
          if (fDetails[ti] === undefined) {
            fDetails[ti] = { line_num: 0, line_text: `[path match: ${fp}]`, func_name: null };
          }
          continue;
        }

        const regex = terms[ti].regex;
        const seenFuncs = new Set();

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          const lineNum = lineIdx + 1;
          const lineText = lines[lineIdx];
          if (!regex.test(lineText)) continue;

          const funcName = CodeSearchIndex._bisectFuncLookup(boundaries, lineNum) || '(global)';

          // File-level: record first hit per term
          if (!fileDetailMap.has(fp)) fileDetailMap.set(fp, {});
          const fDetails = fileDetailMap.get(fp);
          if (fDetails[ti] === undefined) {
            fDetails[ti] = { line_num: lineNum, line_text: lineText.trim(), func_name: funcName };
          }

          // Function-level: one hit per function per term
          const fnKey = `${fp}\x00${funcName}`;
          if (!seenFuncs.has(funcName)) {
            seenFuncs.add(funcName);
            if (!funcMap.has(fnKey)) funcMap.set(fnKey, { filepath: fp, function: funcName, details: {} });
            const fm = funcMap.get(fnKey);
            if (fm.details[ti] === undefined) {
              fm.details[ti] = { line_num: lineNum, line_text: lineText.trim() };
            }
          }
        }
      }
    }

    const phase2Time = Date.now() - phase2Start;
    if (showProgress) {
      process.stderr.write(`  Phase 2: details for ${phase2Files.size} files in ` +
        `${(phase2Time / 1000).toFixed(1)}s\n`);
    }

    // Build function matches
    const funcMatches = [];
    for (const [, fm] of funcMap) {
      const posMatched = new Set(
        Object.keys(fm.details).map(Number).filter(ti => !notIdxSet.has(ti))
      );
      if (posMatched.size < minTerms) continue;

      // Get function line count
      const boundaries = funcBoundariesCache[fm.filepath] || [];
      let funcLines = 0;
      for (const [s, e, name] of boundaries) {
        if (name === fm.function) { funcLines = e - s + 1; break; }
      }

      funcMatches.push({
        filepath: fm.filepath,
        function: fm.function,
        terms_matched: posMatched.size,
        lines: funcLines || 0,
        matched_indices: posMatched,
        details: fm.details,
      });
    }
    funcMatches.sort((a, b) =>
      b.terms_matched - a.terms_matched ||
      a.lines - b.lines ||
      a.function.localeCompare(b.function) ||
      a.filepath.localeCompare(b.filepath));

    // Build class matches — group functions by class name.
    // A class match means all (or minTerms) terms appear across the class's
    // methods, even if no single method contains them all.
    // Handles C++ classes split across .h/.cpp files.
    const classMap = new Map();  // className -> { details: {ti -> {line_num, line_text, func_name, filepath}}, files: Set, functions: Set, totalLines: number }

    for (const [fnKey, fm] of funcMap) {
      const funcName = fm.function;
      if (!funcName || funcName === '(global)') continue;

      // Extract class name from qualified function name
      let className = null;
      if (funcName.includes('::')) {
        className = funcName.split('::').slice(0, -1).join('::');
      } else if (funcName.includes('.')) {
        className = funcName.split('.').slice(0, -1).join('.');
      }
      if (!className) continue;

      if (!classMap.has(className)) {
        classMap.set(className, { details: {}, files: new Set(), functions: new Set(), totalLines: 0 });
      }
      const cm = classMap.get(className);
      cm.files.add(fm.filepath);
      cm.functions.add(funcName);

      // Get function line count for total
      const boundaries = funcBoundariesCache[fm.filepath] || [];
      for (const [s, e, name] of boundaries) {
        if (name === funcName) { cm.totalLines += (e - s + 1); break; }
      }

      // Merge term details — keep first hit per term for the class
      for (const [tiStr, detail] of Object.entries(fm.details)) {
        const ti = Number(tiStr);
        if (cm.details[ti] === undefined) {
          cm.details[ti] = {
            line_num: detail.line_num,
            line_text: detail.line_text,
            func_name: funcName,
            filepath: fm.filepath,
          };
        }
      }
    }

    const classMatches = [];
    for (const [className, cm] of classMap) {
      const posMatched = new Set(
        Object.keys(cm.details).map(Number).filter(ti => !notIdxSet.has(ti))
      );
      if (posMatched.size < minTerms) continue;
      // Skip if NOT-term appears in any of the class's files
      const classFiles = cm.files;
      if (notIndices.some(ni => [...classFiles].some(fp => termFileSets[ni].has(fp)))) continue;

      classMatches.push({
        class_name: className,
        terms_matched: posMatched.size,
        matched_indices: posMatched,
        files: [...classFiles].sort(),
        functions: [...cm.functions].sort(),
        total_lines: cm.totalLines,
        details: cm.details,
      });
    }
    classMatches.sort((a, b) =>
      b.terms_matched - a.terms_matched ||
      a.total_lines - b.total_lines ||
      a.class_name.localeCompare(b.class_name));

    // Build file matches
    const fileMatches = [];
    for (const [fp, details] of fileDetailMap) {
      const posMatched = new Set(
        Object.keys(details).map(Number).filter(ti => !notIdxSet.has(ti))
      );
      if (posMatched.size < minTerms) continue;
      // Check NOT terms
      if (notIndices.some(ni => termFileSets[ni].has(fp))) continue;

      const fileLineCount = (this.fileLines.get(fp) || []).length;
      fileMatches.push({
        filepath: fp,
        terms_matched: posMatched.size,
        lines: fileLineCount,
        matched_indices: posMatched,
        details,
      });
    }
    fileMatches.sort((a, b) =>
      b.terms_matched - a.terms_matched ||
      a.lines - b.lines ||
      a.filepath.localeCompare(b.filepath));

    // Build folder matches
    const folderMatches = [];
    for (const [folder, matched] of Object.entries(folderMap)) {
      const posMatched = new Set(
        Object.keys(matched).map(Number).filter(ti => !notIdxSet.has(ti))
      );
      if (posMatched.size < minTerms) continue;
      // Check NOT terms
      const notHits = notIndices.filter(ni => matched[ni] && matched[ni].size > 0);
      if (notHits.length > 0) continue;

      const allFiles = new Set();
      for (const ti of posMatched) {
        for (const fp of (matched[ti] || [])) allFiles.add(fp);
      }

      folderMatches.push({
        folder,
        terms_matched: posMatched.size,
        matched_indices: posMatched,
        files_involved: allFiles.size,
        file_sets: Object.fromEntries(
          [...posMatched].map(ti => [ti, matched[ti] || new Set()])
        ),
      });
    }
    folderMatches.sort((a, b) =>
      b.terms_matched - a.terms_matched ||
      a.files_involved - b.files_involved ||
      b.folder.split('/').length - a.folder.split('/').length ||
      a.folder.localeCompare(b.folder));

    return {
      terms,
      num_terms: nTerms,
      num_positive: nPositive,
      not_indices: notIndices,
      min_terms: minTerms,
      term_file_counts: termFileCounts,
      function_matches: funcMatches,
      class_matches: classMatches,
      file_matches: fileMatches,
      folder_matches: folderMatches,
    };
  }
}

function escapeRegex(str) {
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
function _computeTokenRelevance(vocabToken, claimKeywords) {
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
