// TreeSitterParser.js — WASM tree-sitter extraction for 12 grammars, with binary sniffing, a size cap and a per-parse timeout
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * TreeSitterParser.js - WASM-based function parsing using web-tree-sitter.
 *
 * Provides accurate AST-based function extraction for supported languages:
 * C, C++, Java, Python, JavaScript, TypeScript, Go, Rust, C#, PHP, Ruby.
 *
 * Falls back to null (signaling regex fallback) when a grammar is unavailable
 * or parsing fails.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { macroFunctionName } from './function-bounds.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Grammar-WASM lookup: `<repo>/grammars/`, reachable from `src/core/` via
// `../../grammars`. (A second candidate next to `process.execPath` once served
// the Bun-compiled standalone exe; the exe was retired, see #78.) When the
// directory is missing, the rest of the file emits its usual "wasm not found"
// warning rather than crashing here.
const GRAMMARS_DIR = path.join(__dirname, '..', '..', 'grammars');

// --- binary content sniff (#299 / #88) ---------------------------------------
// Binary files reaching a language grammar is the 2-hour-build failure mode:
// ExoPlayer's MPEG transport-stream test fixtures (.ts!) were stringified and
// fed to the TypeScript grammar, whose ERROR-forest ground the extractor walk
// for minutes PER FILE. Extension filtering can never be sufficient (the .ts
// collision), so sniff the CONTENT: stringified binary carries NULs, U+FFFD
// replacement chars (invalid-UTF-8 decodes), and a high control-char ratio.

export const TS_PARSE_MAX_CHARS = 2_000_000; // beyond this, regex-only (#88 size cap)
export const TS_PARSE_TIMEOUT_MICROS = 5_000_000; // 5s per parse, then regex (#88)
export const TS_SLOW_FILE_MS = 2000; // report threshold for the pass's slow-file list

export function looksBinaryContent(sourceLines, probeChars = 4096) {
  const probe = (Array.isArray(sourceLines) ? sourceLines.slice(0, 50).join('\n') : String(sourceLines || '')).slice(0, probeChars);
  if (!probe) return false;
  if (probe.includes('\u0000') || probe.includes('\uFFFD')) return true;
  let bad = 0;
  for (let i = 0; i < probe.length; i++) {
    const c = probe.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x80 && c <= 0x9f)) bad++;
  }
  return bad / probe.length > 0.05;
}

// MPEG-TS is deterministically fingerprintable: a 0x47 sync byte every 188
// bytes. After text decoding the offsets survive only when no newline byte
// landed in the first 377 — check best-effort on the first "line"; the
// generic sniff above catches the rest.
export function looksMpegTs(sourceLines) {
  const first = Array.isArray(sourceLines) ? (sourceLines[0] || '') : String(sourceLines || '');
  if (first.length < 377) return false;
  return first.charCodeAt(0) === 0x47 && first.charCodeAt(188) === 0x47 && first.charCodeAt(376) === 0x47;
}

// `.m` is Objective-C or MATLAB. An Objective-C file announces itself in its
// first lines: a directive (`#import`, `@interface`, `@implementation`,
// `@protocol`, `@end`, `@import`, `@class`, `@property`, `@autoreleasepool`)
// or a Foundation type. MATLAB has none of these (its comments start with
// `%`). Checked over the first 400 lines; a `.m` that fails goes to the regex
// tier, as every `.m` did before the grammar (tree-sitter-kotlin-swift-grammars,
// 2026-11-13).
export function looksObjectiveC(sourceLines) {
  const lines = Array.isArray(sourceLines) ? sourceLines : String(sourceLines || '').split('\n');
  const head = lines.slice(0, 400).join('\n');
  return /^\s*(?:#import|@interface|@implementation|@protocol|@end|@import|@class|@property|@autoreleasepool)\b/m.test(head)
    || /\bNS(?:String|Object|Array|Dictionary|Log|Integer|Number|Error)\b/.test(head);
}

// Map from language name (as used in EXT_TO_LANG) to grammar .wasm filename
const GRAMMAR_FILES = {
  c:          'tree-sitter-c.wasm',
  cpp:        'tree-sitter-cpp.wasm',
  java:       'tree-sitter-java.wasm',
  python:     'tree-sitter-python.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  // JSX-enabled TypeScript: a separate grammar in the same npm package (JSX
  // conflicts with `<T>x` type assertions). Without it, `.tsx` went to the
  // TypeScript grammar and every JSX element was an ERROR node that swallowed
  // the functions after it (function-end-detection-accuracy, 2026-10-11).
  tsx:        'tree-sitter-tsx.wasm',
  go:         'tree-sitter-go.wasm',
  rust:       'tree-sitter-rust.wasm',
  c_sharp:    'tree-sitter-c-sharp.wasm',
  php:        'tree-sitter-php.wasm',
  ruby:       'tree-sitter-ruby.wasm',
  // Added 2026-11-13 (tree-sitter-kotlin-swift-grammars). Scala and
  // Objective-C are copies of the wasm their npm packages publish, like the
  // twelve above. The Kotlin and Swift packages publish no wasm, so those two
  // are the `tree-sitter-<lang>.wasm` assets of the upstream GitHub releases,
  // pinned by sha256 in test_function_bounds.js. The `tree-sitter-wasms`
  // bundle was tried first and rejected: its files carry the legacy `dylink`
  // custom section, and web-tree-sitter 0.26 loads only `dylink.0`.
  kotlin:     'tree-sitter-kotlin.wasm',
  swift:      'tree-sitter-swift.wasm',
  scala:      'tree-sitter-scala.wasm',
  objc:       'tree-sitter-objc.wasm',
};

// Map file extension → language name (mirrors EXT_TO_LANG from utils.js)
const EXT_TO_TS_LANG = {
  '.c': 'c',
  '.h': 'cpp',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp',
  '.hxx': 'cpp', '.h++': 'cpp', '.c++': 'cpp',
  '.java': 'java',
  '.py': 'python', '.pyw': 'python',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'tsx',
  '.cs': 'c_sharp',
  '.go': 'go',
  '.rs': 'rust',
  '.php': 'php',
  '.rb': 'ruby',
  '.kt': 'kotlin', '.kts': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala', '.sc': 'scala',
  // `.m` is also MATLAB: parseFunctions sniffs for Objective-C first, and a
  // MATLAB file goes to the regex tier as before.
  '.m': 'objc', '.mm': 'objc',
};


export class TreeSitterParser {

  constructor() {
    this._Parser = null;       // web-tree-sitter Parser class
    this._initialized = false;
    this._languages = new Map(); // langName -> Language object
    this._failedGrammars = new Set(); // langNames that failed to load
    // Parses that recovered from ERROR nodes: boundaries near the error may
    // be wrong, and nothing falls back to regex on recovery, so the build
    // summary names these files (function-end-detection-accuracy, 2026-10-11).
    this.stats = { filesWithErrors: 0, errorFiles: [] };
  }

  /**
   * Initialize web-tree-sitter (must be called once before parsing).
   * @returns {boolean} true if init succeeded
   */
  async init() {
    if (this._initialized) return true;
    try {
      // Use createRequire to resolve from this file's directory, not cwd
      const require = createRequire(import.meta.url);
      const mod = require('web-tree-sitter');
      const ParserClass = mod.Parser || mod.default || mod;
      if (!ParserClass) throw new Error('No Parser class found in web-tree-sitter');
      await ParserClass.init();
      this._Parser = ParserClass;
      this._Language = mod.Language || null;
      this._initialized = true;
      return true;
    } catch (e) {
      const missingModule = e && (e.code === 'MODULE_NOT_FOUND'
        || /Cannot find module/.test(e.message || ''));
      if (missingModule) {
        console.log('Warning: web-tree-sitter is not installed; this build uses the regex parser for every file.');
        console.log('  The grammar parser (precise function boundaries) is the default once `npm install`');
        console.log('  has run from the CodeExam folder (it reads package.json and installs all dependencies).');
      } else {
        console.log(`Warning: web-tree-sitter init failed: ${e.message}`);
      }
      return false;
    }
  }

  /**
   * Lazy-load a grammar .wasm file. Returns the Language object or null.
   */
  async getLanguage(langName) {
    if (this._languages.has(langName)) return this._languages.get(langName);
    if (this._failedGrammars.has(langName)) return null;

    const wasmFile = GRAMMAR_FILES[langName];
    if (!wasmFile) {
      this._failedGrammars.add(langName);
      return null;
    }

    const wasmPath = path.join(GRAMMARS_DIR, wasmFile);
    try {
      if (!fs.existsSync(wasmPath)) {
        this._failedGrammars.add(langName);
        return null;
      }
      // 0.26+ uses Language class directly; 0.24.x uses Parser.Language.load()
      const lang = this._Language
        ? await this._Language.load(wasmPath)
        : await this._Parser.Language.load(wasmPath);
      this._languages.set(langName, lang);
      return lang;
    } catch (e) {
      this._failedGrammars.add(langName);
      return null;
    }
  }

  /**
   * Parse functions from a file using tree-sitter.
   * Returns { name: { start, end, type, base_name } } or null (signals regex fallback).
   */
  async parseFunctions(filepath, sourceLines) {
    if (!this._initialized) return null;

    const ext = path.extname(filepath).toLowerCase();
    const langName = EXT_TO_TS_LANG[ext];
    if (!langName) return null;
    if (ext === '.m' && !looksObjectiveC(sourceLines)) return null;   // MATLAB: regex tier

    // #299: binary content must never reach a language grammar (the ExoPlayer
    // MPEG-TS-as-TypeScript 2-hour build). Callers also pre-check via the
    // exported helpers to skip regex too; this guard is the belt.
    if (looksBinaryContent(sourceLines) || (langName === 'typescript' && looksMpegTs(sourceLines))) return null;

    const lang = await this.getLanguage(langName);
    if (!lang) return null;

    let parser, tree;
    try {
      parser = new this._Parser();
      parser.setLanguage(lang);

      const sourceCode = sourceLines.join('\n');
      // #88 guards: very large files go regex-only; a parse exceeding the
      // timeout returns a null tree (web-tree-sitter) — same fallback.
      if (sourceCode.length > TS_PARSE_MAX_CHARS) return null;
      if (typeof parser.setTimeoutMicros === 'function') parser.setTimeoutMicros(TS_PARSE_TIMEOUT_MICROS);
      tree = parser.parse(sourceCode);
      if (!tree) return null;

      // A tree with ERROR nodes still yields boundaries, and recovery is
      // usually local (a stray brace), but a function near the error can get
      // a wrong start or end. Count it; the regex parser does not take over.
      const root = tree.rootNode;
      const hasErr = typeof root.hasError === 'function' ? root.hasError() : !!root.hasError;
      if (hasErr) {
        this.stats.filesWithErrors++;
        if (this.stats.errorFiles.length < 20) this.stats.errorFiles.push(filepath);
      }

      let result;
      switch (langName) {
        case 'c':
        case 'cpp':
          result = this._extractCCpp(tree.rootNode, sourceLines);
          break;
        case 'java':
          result = this._extractJava(tree.rootNode, sourceLines);
          break;
        case 'python':
          result = this._extractPython(tree.rootNode, sourceLines);
          break;
        case 'javascript':
        case 'typescript':
        case 'tsx':
          result = this._extractJavaScript(tree.rootNode, sourceLines);
          break;
        case 'go':
          result = this._extractGo(tree.rootNode, sourceLines);
          break;
        case 'rust':
          result = this._extractRust(tree.rootNode, sourceLines);
          break;
        case 'c_sharp':
          result = this._extractCSharp(tree.rootNode, sourceLines);
          break;
        case 'php':
          result = this._extractPHP(tree.rootNode, sourceLines);
          break;
        case 'ruby':
          result = this._extractRuby(tree.rootNode, sourceLines);
          break;
        case 'kotlin':
          result = this._extractKotlin(tree.rootNode, sourceLines);
          break;
        case 'swift':
          result = this._extractSwift(tree.rootNode, sourceLines);
          break;
        case 'scala':
          result = this._extractScala(tree.rootNode, sourceLines);
          break;
        case 'objc':
          result = this._extractObjC(tree.rootNode, sourceLines);
          break;
        default:
          result = null;
      }

      return result;
    } catch (e) {
      return null; // fallback to regex
    } finally {
      // #252: cleanup used to sit inside the try, so a throw in an _extract*
      // leaked the WASM parser/tree. Same finally pattern as parseEsbuildWrappers.
      tree?.delete?.();
      parser?.delete?.();
    }
  }

  /**
   * Tree-sitter–based detection of esbuild module wrappers
   * (`var NAME = HELPER(() => {...})` and similar shapes).
   *
   * Replaces the hand-rolled brace-count walker `_findWrapperEnd` from
   * CodeSearchIndex.js, which mis-counted regex literals containing `{` or
   * `}` (e.g. `/\$\{/`) and pushed wrapper end-lines thousands of lines
   * past their real `})`. Tree-sitter's grammar handles regex literals
   * correctly, so the arrow-function body's `endPosition` is reliable.
   *
   * @param {string} filepath
   * @param {string[]} sourceLines
   * @param {{ esm: ?string, cjs: ?string }} helpers — helper-letter names
   *        from CodeSearchIndex._detectBundleHelpers; we only treat
   *        wrappers whose call target matches one of these as module
   *        wrappers (not arbitrary `var x = fn(() => {})` patterns).
   * @returns {Object|null}  same shape as the regex `_parseEsbuildWrappers`:
   *        `{ [name]: { start, end, type, base_name } }`. Returns null if
   *        tree-sitter can't parse this file (caller should fall back).
   */
  async parseEsbuildWrappers(filepath, sourceLines, helpers) {
    if (!this._initialized) return null;
    if (!helpers || (!helpers.esm && !helpers.cjs)) return {};

    const ext = path.extname(filepath).toLowerCase();
    const langName = EXT_TO_TS_LANG[ext];
    if (langName !== 'javascript' && langName !== 'typescript') return null;

    const lang = await this.getLanguage(langName);
    if (!lang) return null;

    const helperNames = new Set([helpers.esm, helpers.cjs].filter(Boolean));
    const found = {};

    let parser, tree;
    try {
      parser = new this._Parser();
      parser.setLanguage(lang);
      tree = parser.parse(sourceLines.join('\n'));

      const visit = (node) => {
        if (node.type === 'variable_declarator') {
          const nameNode = node.childForFieldName('name');
          const valueNode = node.childForFieldName('value');
          if (
            nameNode && valueNode &&
            nameNode.type === 'identifier' &&
            valueNode.type === 'call_expression'
          ) {
            const fnNode = valueNode.childForFieldName('function');
            const argsNode = valueNode.childForFieldName('arguments');
            if (
              fnNode && fnNode.type === 'identifier' &&
              helperNames.has(fnNode.text) &&
              argsNode && argsNode.namedChildCount > 0
            ) {
              const arg = argsNode.namedChild(0);
              if (arg && arg.type === 'arrow_function') {
                const name = nameNode.text;
                const startLine = node.startPosition.row + 1;
                // Use the variable_declaration's end (covers the closing
                // `})` and trailing `;`) — the arrow's own end position
                // sits at the close of its body, which is one line short
                // of where the wrapper visually ends in cli.js style.
                const endLine = (node.parent ? node.parent.endPosition.row : node.endPosition.row) + 1;
                if (endLine > startLine) {
                  const key = (name in found) ? `${name}@${startLine}` : name;
                  found[key] = {
                    start: startLine,
                    end: endLine,
                    type: 'function',
                    base_name: name,
                  };
                }
              }
            }
          }
        }
        for (let i = 0; i < node.childCount; i++) visit(node.child(i));
      };
      visit(tree.rootNode);

      return found;
    } catch (_e) {
      return null;
    } finally {
      tree?.delete?.();
      parser?.delete?.();
    }
  }

  /** List which grammars are available on disk. */
  getAvailableGrammars() {
    const available = [];
    for (const [lang, file] of Object.entries(GRAMMAR_FILES)) {
      if (fs.existsSync(path.join(GRAMMARS_DIR, file))) {
        available.push(lang);
      }
    }
    return available;
  }

  /** List which grammars are missing from disk. */
  getMissingGrammars() {
    const missing = [];
    for (const [lang, file] of Object.entries(GRAMMAR_FILES)) {
      if (!fs.existsSync(path.join(GRAMMARS_DIR, file))) {
        missing.push(lang);
      }
    }
    return missing;
  }


  // ========================================================================
  // Helper: deduplicate function names (same logic as regex parser)
  // ========================================================================

  _addFunction(result, name, startLine, endLine, type, extra = null) {
    const bare = name.includes('::') ? name.split('::').pop() : name;
    let storedName = name;
    if (name in result) {
      storedName = `${name}@${startLine}`;
    }
    result[storedName] = {
      start: startLine,
      end: endLine,
      type: (type !== 'class' && name.includes('::')) ? 'method' : type,
      base_name: bare,
      ...(extra || {}),   // e.g. { macro: 'TEST_F' } for a macro-defined function
    };
  }


  // ========================================================================
  // C / C++
  // ========================================================================

  _extractCCpp(rootNode, sourceLines) {
    const result = {};
    const totalLines = sourceLines.length;

    const walk = (node, scopeStack) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'namespace_definition') {
          const nameNode = child.childForFieldName('name');
          const nsName = nameNode ? nameNode.text : '';
          if (nsName) {
            scopeStack.push(nsName);
            walk(child, scopeStack);
            scopeStack.pop();
          } else {
            walk(child, scopeStack);
          }
        } else if (type === 'class_specifier' || type === 'struct_specifier') {
          const nameNode = child.childForFieldName('name');
          const className = nameNode ? nameNode.text : null;
          if (className) {
            const prefix = scopeStack.length > 0 ? scopeStack.join('::') + '::' : '';
            const fullClass = prefix + className;
            this._addFunction(result, fullClass, startLine, endLine, 'class');
            scopeStack.push(className);
            walk(child, scopeStack);
            scopeStack.pop();
          } else {
            walk(child, scopeStack);
          }
        } else if (type === 'expression_statement' || type === 'declaration') {
          // Google Test macros: TEST_P(Suite, Name) { ... }
          // tree-sitter sees these as expressions/declarations, not function_definitions
          const lineText = child.startPosition.row < sourceLines.length
            ? sourceLines[child.startPosition.row] : '';
          const testMatch = lineText.match(
            /^\s*(?:TEST_F|TEST_P|TEST|TYPED_TEST|TYPED_TEST_P|TYPED_TEST_SUITE|TEST_CASE)\s*\(\s*(\w+)\s*,\s*(\w+)/
          );
          if (testMatch) {
            const fullName = testMatch[1] + '::' + testMatch[2];
            this._addFunction(result, fullName, startLine, endLine, 'function');
          } else {
            walk(child, scopeStack);
          }
        } else if (type === 'function_definition') {
          const declarator = child.childForFieldName('declarator');
          // `TEST_F(Suite, Name) { ... }` / `DEFINE_METHOD(Foo, bar) { ... }`:
          // the grammar parses a macro-with-body as a function_definition
          // named by the macro, so every TEST_F in a file collided on the
          // name `TEST_F` (the expression_statement branch above only sees
          // older grammar output). Name it from the macro's arguments.
          const macroDef = this._macroDefinedFunction(declarator);
          const funcName = macroDef ? macroDef.name : this._extractCFuncName(declarator);
          if (funcName) {
            // If name already has :: (e.g. Class::method), use as-is
            // Otherwise, prefix with scope stack
            let fullName;
            if (funcName.includes('::')) {
              fullName = funcName;
            } else {
              const prefix = scopeStack.length > 0 ? scopeStack.join('::') + '::' : '';
              fullName = prefix + funcName;
            }
            const fType = fullName.includes('::') ? 'method' : 'function';
            this._addFunction(result, fullName, startLine, endLine, fType,
                              macroDef ? { macro: macroDef.macro } : null);
          }
          // Don't recurse into function bodies for top-level extraction
        } else {
          walk(child, scopeStack);
        }
      }
    };

    walk(rootNode, []);
    return result;
  }

  // c-parser-macro-token-in-function-name (2026-11-03). When the grammar
  // cannot place the token before a name (`LRESULT CALLBACK WndProc(...)`,
  // `LRESULT APIENTRY` over `BarWndProc(...)`, `DWORD WINAPI
  // CControl::ThreadFunction(...)`), its error recovery leaves the token
  // inside the declarator node, whose text then spans both, and the index
  // stored `CALLBACK WndProc`, `APIENTRY` + newline + `BarWndProc`. A name
  // never contains whitespace: the last whitespace-separated token is the
  // name (a qualified one keeps its `::`). Normalized once here, at the one
  // return point, whatever node type produced the text. Counted in the HOF
  // candidate lists: 1,408 space-bearing and 516 newline-bearing names of
  // 56,540 lines on .WinAPI_Classic, 68 on .ffmpeg, 10 on .x264.
  _extractCFuncName(declarator) {
    const raw = this._extractCFuncNameRaw(declarator);
    if (!raw || !/\s/.test(raw)) return raw;
    const parts = raw.trim().split(/\s+/);
    return parts[parts.length - 1] || null;
  }

  _extractCFuncNameRaw(declarator) {
    if (!declarator) return null;
    // Handle qualified_identifier (Class::method)
    if (declarator.type === 'qualified_identifier') {
      return declarator.text;
    }
    // Handle function_declarator -> declarator
    if (declarator.type === 'function_declarator') {
      const inner = declarator.childForFieldName('declarator');
      return this._extractCFuncNameRaw(inner);
    }
    // Handle pointer_declarator
    if (declarator.type === 'pointer_declarator') {
      const inner = declarator.childForFieldName('declarator');
      return this._extractCFuncNameRaw(inner);
    }
    // Handle reference_declarator
    if (declarator.type === 'reference_declarator') {
      for (let i = 0; i < declarator.childCount; i++) {
        const c = declarator.child(i);
        if (c.type !== '&' && c.type !== '&&') {
          return this._extractCFuncNameRaw(c);
        }
      }
    }
    // Simple identifier
    if (declarator.type === 'identifier' || declarator.type === 'field_identifier' ||
        declarator.type === 'destructor_name') {
      return declarator.text;
    }
    // Operator overloads
    if (declarator.type === 'operator_name') {
      return declarator.text;
    }
    return null;
  }

  /**
   * `MACRO(a, b)` used as a function declarator: an ALL_CAPS identifier whose
   * parameters are all bare identifiers (the grammar parses each as a
   * parameter_declaration carrying only a type_identifier). Returns
   * { macro, args, name } or null for an ordinary declarator. The open-brace
   * macro shape (`BEGIN_FN(x) ... END_FN`) is not a function_definition at
   * all and stays invisible; see CODEEXAM_KNOWN_LIMITATIONS.
   */
  _macroDefinedFunction(declarator) {
    if (!declarator || declarator.type !== 'function_declarator') return null;
    const inner = declarator.childForFieldName('declarator');
    if (!inner || inner.type !== 'identifier') return null;
    const macro = inner.text;
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(macro)) return null;
    const params = declarator.childForFieldName('parameters');
    if (!params) return null;
    const args = [];
    for (let i = 0; i < params.namedChildCount; i++) {
      const p = params.namedChild(i);
      if (p.type === 'comment') continue;
      if (p.type !== 'parameter_declaration' || p.namedChildCount !== 1) return null;
      const t = p.namedChild(0);
      if (t.type !== 'type_identifier' && t.type !== 'identifier') return null;
      args.push(t.text);
    }
    if (args.length === 0) return null;
    return { macro, args, name: macroFunctionName(macro, args) };
  }


  // ========================================================================
  // Java
  // ========================================================================

  _extractJava(rootNode, sourceLines) {
    const result = {};

    const walk = (node, classStack) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class_declaration' || type === 'interface_declaration' || type === 'enum_declaration') {
          const nameNode = child.childForFieldName('name');
          const className = nameNode ? nameNode.text : null;
          if (className) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + className, startLine, endLine, 'class');
            classStack.push(className);
            walk(child, classStack);
            classStack.pop();
          } else {
            walk(child, classStack);
          }
        } else if (type === 'method_declaration' || type === 'constructor_declaration') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
          }
        } else {
          walk(child, classStack);
        }
      }
    };

    walk(rootNode, []);
    return result;
  }


  // ========================================================================
  // Python
  // ========================================================================

  _extractPython(rootNode, sourceLines) {
    const result = {};

    const walk = (node, classStack) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class_definition') {
          const nameNode = child.childForFieldName('name');
          const className = nameNode ? nameNode.text : null;
          if (className) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + className, startLine, endLine, 'class');
            classStack.push(className);
            // Recurse into class body
            const body = child.childForFieldName('body');
            if (body) walk(body, classStack);
            classStack.pop();
          }
        } else if (type === 'function_definition') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
          }
          // Recurse into function body for nested functions
          const body = child.childForFieldName('body');
          if (body) walk(body, classStack);
        } else if (type === 'decorated_definition') {
          // Decorated functions/classes — recurse to find the actual definition
          walk(child, classStack);
        } else {
          walk(child, classStack);
        }
      }
    };

    walk(rootNode, []);
    return result;
  }


  // ========================================================================
  // JavaScript / TypeScript
  // ========================================================================

  _extractJavaScript(rootNode, sourceLines) {
    const result = {};

    const walk = (node, classStack) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class_declaration' || type === 'class') {
          const nameNode = child.childForFieldName('name');
          const className = nameNode ? nameNode.text : null;
          if (className) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + className, startLine, endLine, 'class');
            classStack.push(className);
            const body = child.childForFieldName('body');
            if (body) walk(body, classStack);
            classStack.pop();
          } else {
            walk(child, classStack);
          }
        } else if (type === 'function_declaration' || type === 'generator_function_declaration') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
          }
          // Walk INTO function body to find nested functions (closures,
          // local helpers like `const doRebuild = async () => {}`).
          // Reset classStack — nested functions are NOT class methods.
          // Inspired by ChatGPT's recursive-visit rewrite (reviewed
          // 2026-04-17); adapted to our multi-language walker.
          const fnBody = child.childForFieldName('body');
          if (fnBody) walk(fnBody, []);
        } else if (type === 'method_definition') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
          }
          // Walk into method body for nested functions (same reasoning).
          const methBody = child.childForFieldName('body');
          if (methBody) walk(methBody, []);
        } else if (type === 'public_field_definition' || type === 'field_definition') {
          // Item 6: Class-field arrow methods — `run = async () => {}`
          // inside a class body. Tree-sitter represents these as
          // field_definition nodes, not method_definition.
          const nameNode = child.childForFieldName('property') || child.childForFieldName('name');
          const valueNode = child.childForFieldName('value');
          if (nameNode && valueNode) {
            const vt = valueNode.type;
            if (vt === 'arrow_function' || vt === 'function' || vt === 'function_expression') {
              const funcName = nameNode.text;
              if (funcName) {
                const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
                this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
              }
            }
          }
        } else if (type === 'lexical_declaration' || type === 'variable_declaration') {
          // Handle: const foo = function() { ... }  or  const foo = () => { ... }
          for (let j = 0; j < child.childCount; j++) {
            const decl = child.child(j);
            if (decl.type === 'variable_declarator') {
              const nameNode = decl.childForFieldName('name');
              const valueNode = decl.childForFieldName('value');
              if (nameNode && valueNode) {
                const vt = valueNode.type;
                if (vt === 'arrow_function' || vt === 'function' || vt === 'function_expression' || vt === 'generator_function') {
                  const funcName = nameNode.text;
                  if (funcName) {
                    const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
                    this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
                  }
                }
              }
            }
          }
          walk(child, classStack);
        } else if (type === 'export_statement') {
          walk(child, classStack);
        } else if (type === 'interface_declaration' || type === 'type_alias_declaration') {
          // TypeScript: interfaces and type aliases — skip but continue walking
          walk(child, classStack);
        } else if (type === 'assignment_expression') {
          // #283: member-assignment function definitions — window.X = function /
          // arrow / IIFE, obj.prototype.Y = function, this.X = function. The
          // `variable_declarator` case above only catches `const X = function`;
          // member-assignments (Bram's whole `window.__bram*` namespace) were
          // invisible. Index under the FINAL property name so it round-trips
          // like a `const X = function` (--extract X, callers, grounding).
          const left = child.childForFieldName('left');
          const right = child.childForFieldName('right');
          let handled = false;
          if (left && right && left.type === 'member_expression') {
            const propNode = left.childForFieldName('property');
            const propName = propNode ? propNode.text : null;
            // Unwrap an IIFE: window.X = (function(){})()  /  (() => {})()
            let fnNode = right;
            if (right.type === 'call_expression') {
              const callee = right.childForFieldName('function');
              const inner = callee && callee.type === 'parenthesized_expression' ? callee.namedChild(0) : null;
              if (inner) fnNode = inner;
            }
            const ft = fnNode.type;
            if (propName && (ft === 'arrow_function' || ft === 'function' || ft === 'function_expression' || ft === 'generator_function')) {
              const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
              this._addFunction(result, prefix + propName, startLine, endLine, 'function');
              const body = fnNode.childForFieldName('body');
              if (body) walk(body, []);
              handled = true;
            }
          }
          if (!handled) walk(child, classStack);
        } else {
          walk(child, classStack);
        }
      }
    };

    walk(rootNode, []);
    return result;
  }


  // ========================================================================
  // Go
  // ========================================================================

  _extractGo(rootNode, sourceLines) {
    const result = {};

    const walk = (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'function_declaration') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            this._addFunction(result, funcName, startLine, endLine, 'function');
          }
        } else if (type === 'method_declaration') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          // Get receiver type
          const receiver = child.childForFieldName('receiver');
          let receiverType = null;
          if (receiver) {
            // receiver is parameter_list, find the type inside
            for (let j = 0; j < receiver.childCount; j++) {
              const param = receiver.child(j);
              if (param.type === 'parameter_declaration') {
                const typeNode = param.childForFieldName('type');
                if (typeNode) {
                  receiverType = typeNode.text.replace(/^\*/, ''); // strip pointer
                }
              }
            }
          }
          if (funcName) {
            const fullName = receiverType ? `${receiverType}::${funcName}` : funcName;
            this._addFunction(result, fullName, startLine, endLine, 'function');
          }
        } else if (type === 'type_declaration') {
          // type Foo struct { ... }
          for (let j = 0; j < child.childCount; j++) {
            const spec = child.child(j);
            if (spec.type === 'type_spec') {
              const nameNode = spec.childForFieldName('name');
              const typeNode = spec.childForFieldName('type');
              if (nameNode && typeNode && (typeNode.type === 'struct_type' || typeNode.type === 'interface_type')) {
                this._addFunction(result, nameNode.text, startLine, endLine, 'class');
              }
            }
          }
        } else {
          walk(child);
        }
      }
    };

    walk(rootNode);
    return result;
  }


  // ========================================================================
  // Rust
  // ========================================================================

  _extractRust(rootNode, sourceLines) {
    const result = {};

    const walk = (node, implType) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'struct_item' || type === 'enum_item') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            this._addFunction(result, nameNode.text, startLine, endLine, 'class');
          }
        } else if (type === 'impl_item') {
          // impl Foo { ... }
          const typeNode = child.childForFieldName('type');
          const typeName = typeNode ? typeNode.text : null;
          if (typeName) {
            const body = child.childForFieldName('body');
            if (body) walk(body, typeName);
          }
        } else if (type === 'function_item') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const fullName = implType ? `${implType}::${funcName}` : funcName;
            this._addFunction(result, fullName, startLine, endLine, 'function');
          }
        } else if (type === 'trait_item') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            this._addFunction(result, nameNode.text, startLine, endLine, 'class');
            const body = child.childForFieldName('body');
            if (body) walk(body, nameNode.text);
          }
        } else if (type === 'mod_item') {
          walk(child, implType);
        } else {
          walk(child, implType);
        }
      }
    };

    walk(rootNode, null);
    return result;
  }


  // ========================================================================
  // C#
  // ========================================================================

  _extractCSharp(rootNode, sourceLines) {
    const result = {};

    const walk = (node, scopeStack) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'namespace_declaration' || type === 'file_scoped_namespace_declaration') {
          const nameNode = child.childForFieldName('name');
          const nsName = nameNode ? nameNode.text : '';
          if (nsName) {
            scopeStack.push(nsName);
            walk(child, scopeStack);
            scopeStack.pop();
          } else {
            walk(child, scopeStack);
          }
        } else if (type === 'class_declaration' || type === 'struct_declaration' ||
                   type === 'interface_declaration' || type === 'enum_declaration' ||
                   type === 'record_declaration') {
          const nameNode = child.childForFieldName('name');
          const className = nameNode ? nameNode.text : null;
          if (className) {
            const prefix = scopeStack.length > 0 ? scopeStack.join('::') + '::' : '';
            this._addFunction(result, prefix + className, startLine, endLine, 'class');
            scopeStack.push(className);
            walk(child, scopeStack);
            scopeStack.pop();
          } else {
            walk(child, scopeStack);
          }
        } else if (type === 'method_declaration' || type === 'constructor_declaration') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const prefix = scopeStack.length > 0 ? scopeStack.join('::') + '::' : '';
            this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
          }
        } else if (type === 'property_declaration') {
          const nameNode = child.childForFieldName('name');
          if (nameNode) {
            const prefix = scopeStack.length > 0 ? scopeStack.join('::') + '::' : '';
            this._addFunction(result, prefix + nameNode.text, startLine, endLine, 'function');
          }
        } else {
          walk(child, scopeStack);
        }
      }
    };

    walk(rootNode, []);
    return result;
  }


  // ========================================================================
  // PHP
  // ========================================================================

  _extractPHP(rootNode, sourceLines) {
    const result = {};

    const walk = (node, classStack) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class_declaration' || type === 'interface_declaration' || type === 'trait_declaration') {
          const nameNode = child.childForFieldName('name');
          const className = nameNode ? nameNode.text : null;
          if (className) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + className, startLine, endLine, 'class');
            classStack.push(className);
            const body = child.childForFieldName('body');
            if (body) walk(body, classStack);
            classStack.pop();
          } else {
            walk(child, classStack);
          }
        } else if (type === 'function_definition') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
          }
        } else if (type === 'method_declaration') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const prefix = classStack.length > 0 ? classStack.join('::') + '::' : '';
            this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
          }
        } else {
          walk(child, classStack);
        }
      }
    };

    walk(rootNode, []);
    return result;
  }


  // ========================================================================
  // Ruby
  // ========================================================================

  _extractRuby(rootNode, sourceLines) {
    const result = {};

    const walk = (node, scopeStack) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class' || type === 'module') {
          const nameNode = child.childForFieldName('name');
          const className = nameNode ? nameNode.text : null;
          if (className) {
            // Strip inheritance (class Foo < Bar)
            const name = className.split('<')[0].trim();
            const prefix = scopeStack.length > 0 ? scopeStack.join('::') + '::' : '';
            this._addFunction(result, prefix + name, startLine, endLine, 'class');
            scopeStack.push(name);
            const body = child.childForFieldName('body');
            if (body) walk(body, scopeStack);
            scopeStack.pop();
          } else {
            walk(child, scopeStack);
          }
        } else if (type === 'method' || type === 'singleton_method') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            const prefix = scopeStack.length > 0 ? scopeStack.join('::') + '::' : '';
            this._addFunction(result, prefix + funcName, startLine, endLine, 'function');
          }
        } else {
          walk(child, scopeStack);
        }
      }
    };

    walk(rootNode, []);
    return result;
  }


  // ========================================================================
  // Kotlin (tree-sitter-kotlin-swift-grammars, 2026-11-13)
  // ========================================================================
  //
  // The fwcd grammar names no fields, so names come from child positions: a
  // declaration's name is its first `type_identifier` (types) or
  // `simple_identifier` (functions) child. An extension function
  // (`fun View.fadeIn()`) carries its receiver as a `user_type` child before
  // the name; it is recorded as `View::fadeIn`, the receiver a qualifier and
  // never the name, which is the defect the regex tier had (the Architecture
  // Components samples listed `Fragment`, `LiveData`, `View` and `Flow` as
  // function names). Members of a class, object or companion object are
  // attributed to the enclosing class (`Repo::create` for a companion's
  // function, since that is how Kotlin code calls it); a secondary
  // constructor is `Repo::constructor`. Properties, lambdas and init blocks
  // are not definitions here, as in the Java extractor.

  _extractKotlin(rootNode, sourceLines) {
    const result = {};
    const firstChild = (node, ...types) => {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (types.includes(c.type)) return c;
      }
      return null;
    };

    const walk = (node, owner) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class_declaration' || type === 'object_declaration') {
          const nameNode = firstChild(child, 'type_identifier');
          const name = nameNode ? nameNode.text : null;
          if (name) {
            this._addFunction(result, name, startLine, endLine, 'class');
            walk(child, name);
          } else {
            walk(child, owner);
          }
        } else if (type === 'companion_object') {
          const nameNode = firstChild(child, 'type_identifier');
          const name = nameNode ? nameNode.text : 'Companion';
          this._addFunction(result, owner ? `${owner}::${name}` : name, startLine, endLine, 'class');
          walk(child, owner);
        } else if (type === 'function_declaration') {
          const nameNode = firstChild(child, 'simple_identifier');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) {
            // A receiver type precedes the name in an extension function.
            // (Nodes are compared by position: web-tree-sitter returns a new
            // object on every child() call, so identity never matches.)
            let receiver = null;
            for (let j = 0; j < child.childCount; j++) {
              const c = child.child(j);
              if (c.startIndex >= nameNode.startIndex) break;
              if (c.type === 'user_type' || c.type === 'nullable_type') {
                receiver = c.text.replace(/<[\s\S]*$/, '').replace(/\?$/, '');
              }
            }
            const qualifier = owner || receiver;
            const fullName = qualifier ? `${qualifier}::${funcName}` : funcName;
            this._addFunction(result, fullName, startLine, endLine, 'function', receiver ? { receiver } : null);
          }
          walk(child, owner);
        } else if (type === 'secondary_constructor') {
          this._addFunction(result, owner ? `${owner}::constructor` : 'constructor', startLine, endLine, 'function');
        } else {
          walk(child, owner);
        }
      }
    };

    walk(rootNode, null);
    return result;
  }


  // ========================================================================
  // Swift (tree-sitter-kotlin-swift-grammars, 2026-11-13)
  // ========================================================================
  //
  // `class_declaration` covers struct, class, enum, actor and extension by
  // its `declaration_kind` field. An extension is not a type of its own: its
  // members are attributed to the type it extends (`Store::add`), which is
  // what a reader asking for Store's code wants. A computed property
  // (`var body: some View { … }`, where a SwiftUI view's content lives) is
  // recorded as a function with `kind: 'computed-property'`; a stored
  // property, and a closure stored in a `let`, are not definitions. `init`,
  // `deinit` and `subscript` take those words as names. Protocol requirements
  // are recorded under the protocol, as Java interface methods are.

  _extractSwift(rootNode, sourceLines) {
    const result = {};

    const walk = (node, owner) => {
      const qualified = (n) => (owner ? `${owner}::${n}` : n);
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class_declaration' || type === 'protocol_declaration') {
          const kindNode = child.childForFieldName('declaration_kind');
          const kind = kindNode ? kindNode.text : (type === 'protocol_declaration' ? 'protocol' : 'class');
          const nameNode = child.childForFieldName('name');
          const name = nameNode ? nameNode.text.replace(/<[\s\S]*$/, '') : null;
          if (!name) { walk(child, owner); continue; }
          if (kind !== 'extension') this._addFunction(result, name, startLine, endLine, 'class', { kind });
          const body = child.childForFieldName('body');
          if (body) walk(body, name);
        } else if (type === 'function_declaration' || type === 'protocol_function_declaration') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) this._addFunction(result, qualified(funcName), startLine, endLine, 'function');
          const body = child.childForFieldName('body');
          if (body) walk(body, owner);
        } else if (type === 'init_declaration' || type === 'deinit_declaration' || type === 'subscript_declaration') {
          this._addFunction(result, qualified(type.split('_')[0]), startLine, endLine, 'function');
        } else if (type === 'property_declaration') {
          const computed = child.childForFieldName('computed_value');
          const nameNode = child.childForFieldName('name');
          if (computed && nameNode) {
            this._addFunction(result, qualified(nameNode.text), startLine, endLine, 'function', { kind: 'computed-property' });
          }
        } else {
          walk(child, owner);
        }
      }
    };

    walk(rootNode, null);
    return result;
  }


  // ========================================================================
  // Scala (tree-sitter-kotlin-swift-grammars, 2026-11-13)
  // ========================================================================
  //
  // `class_definition`, `object_definition` and `trait_definition` are types
  // (a `case` keyword child marks a case class or case object, kept as
  // `kind`); `function_definition` and `function_declaration` (an abstract
  // `def` in a trait) are functions attributed to the enclosing type, nested
  // `def`s included. A `val` holding a lambda is not a definition, as in the
  // Kotlin and Java extractors; Scala 3 `given` and `extension` definitions
  // are walked through, not recorded.

  _extractScala(rootNode, sourceLines) {
    const result = {};
    const hasCase = (node) => {
      for (let i = 0; i < node.childCount; i++) if (node.child(i).type === 'case') return true;
      return false;
    };

    const walk = (node, owner) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class_definition' || type === 'object_definition' || type === 'trait_definition' || type === 'enum_definition') {
          const nameNode = child.childForFieldName('name');
          const name = nameNode ? nameNode.text : null;
          if (name) {
            const base = type.replace('_definition', '');
            this._addFunction(result, name, startLine, endLine, 'class', { kind: hasCase(child) ? `case ${base}` : base });
            walk(child, name);
          } else {
            walk(child, owner);
          }
        } else if (type === 'function_definition' || type === 'function_declaration') {
          const nameNode = child.childForFieldName('name');
          const funcName = nameNode ? nameNode.text : null;
          if (funcName) this._addFunction(result, owner ? `${owner}::${funcName}` : funcName, startLine, endLine, 'function');
          walk(child, owner);
        } else {
          walk(child, owner);
        }
      }
    };

    walk(rootNode, null);
    return result;
  }


  // ========================================================================
  // Objective-C (tree-sitter-kotlin-swift-grammars, 2026-11-13)
  // ========================================================================
  //
  // The grammar extends C, so C functions are named as the C extractor names
  // them, and a struct with a body is a type. `@interface Foo` and
  // `@implementation Foo` are both recorded as the class `Foo` (the second
  // takes the `@line` suffix): the interface is where a reader finds the
  // declared surface, the implementation where the bodies are. A category
  // (`@implementation Foo (Extras)`) is not a type of its own; its methods
  // belong to `Foo`. A method's name is its full selector,
  // `sayHelloTo:withPrefix:`, kept whole as a C++ qualified name is; the `+`
  // or `-` is not part of it. Method definitions are recorded; method
  // declarations only inside a `@protocol`, since a class interface's
  // declarations repeat its implementation's definitions.

  _extractObjC(rootNode, sourceLines) {
    const result = {};
    const selectorOf = (node) => {
      let sel = '';
      let afterIdent = false;
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c.type === 'identifier') { sel += c.text; afterIdent = true; }
        else if (c.type === 'method_parameter' && afterIdent) { sel += ':'; afterIdent = false; }
        else if (c.type === 'compound_statement') break;
      }
      return sel || null;
    };
    const firstIdentifier = (node) => {
      for (let i = 0; i < node.childCount; i++) {
        const c = node.child(i);
        if (c.type === 'identifier') return c.text;
      }
      return null;
    };

    const walk = (node, owner, inProtocol) => {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        const type = child.type;
        const startLine = child.startPosition.row + 1;
        const endLine = child.endPosition.row + 1;

        if (type === 'class_interface' || type === 'class_implementation') {
          const name = firstIdentifier(child);
          if (!name) { walk(child, owner, false); continue; }
          if (!child.childForFieldName('category')) {
            this._addFunction(result, name, startLine, endLine, 'class', { kind: type === 'class_interface' ? 'interface' : 'implementation' });
          }
          walk(child, name, false);
        } else if (type === 'protocol_declaration') {
          const name = firstIdentifier(child);
          if (name) this._addFunction(result, name, startLine, endLine, 'class', { kind: 'protocol' });
          walk(child, name || owner, true);
        } else if (type === 'method_definition' || (type === 'method_declaration' && inProtocol)) {
          const sel = selectorOf(child);
          if (sel) this._addFunction(result, owner ? `${owner}::${sel}` : sel, startLine, endLine, 'function');
        } else if (type === 'function_definition') {
          const funcName = this._extractCFuncName(child.childForFieldName('declarator'));
          if (funcName) this._addFunction(result, funcName, startLine, endLine, 'function');
        } else if (type === 'struct_specifier') {
          const nameNode = child.childForFieldName('name');
          if (nameNode && child.childForFieldName('body')) this._addFunction(result, nameNode.text, startLine, endLine, 'class');
          walk(child, owner, inProtocol);
        } else {
          walk(child, owner, inProtocol);
        }
      }
    };

    walk(rootNode, null, false);
    return result;
  }
}
