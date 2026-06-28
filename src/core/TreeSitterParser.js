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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Grammar-WASM lookup. Standard dev/install path: `<repo>/grammars/`,
// reachable from `src/core/` via `../../grammars`. Standalone-exe path
// (Bun --compile, see #78): `__dirname` resolves into the embedded virtual
// filesystem (e.g. `/$bunfs/root/src/core/`), so `../../grammars` won't hit
// disk. Fall back to a `grammars/` directory sitting next to the exe itself
// (`process.execPath`), the layout the build script ships.
function _resolveGrammarsDir() {
  const candidates = [
    path.join(__dirname, '..', '..', 'grammars'),
    path.join(path.dirname(process.execPath), 'grammars'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch { /* try next */ }
  }
  // First candidate is the dev-mode default; let the rest of the file emit
  // its usual "wasm not found" warning rather than crashing here.
  return candidates[0];
}
const GRAMMARS_DIR = _resolveGrammarsDir();

// Map from language name (as used in EXT_TO_LANG) to grammar .wasm filename
const GRAMMAR_FILES = {
  c:          'tree-sitter-c.wasm',
  cpp:        'tree-sitter-cpp.wasm',
  java:       'tree-sitter-java.wasm',
  python:     'tree-sitter-python.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript.wasm',
  go:         'tree-sitter-go.wasm',
  rust:       'tree-sitter-rust.wasm',
  c_sharp:    'tree-sitter-c-sharp.wasm',
  php:        'tree-sitter-php.wasm',
  ruby:       'tree-sitter-ruby.wasm',
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
  '.ts': 'typescript', '.tsx': 'typescript',
  '.cs': 'c_sharp',
  '.go': 'go',
  '.rs': 'rust',
  '.php': 'php',
  '.rb': 'ruby',
};


export class TreeSitterParser {

  constructor() {
    this._Parser = null;       // web-tree-sitter Parser class
    this._initialized = false;
    this._languages = new Map(); // langName -> Language object
    this._failedGrammars = new Set(); // langNames that failed to load
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
        console.log('Warning: web-tree-sitter is not installed — using the regex parser instead.');
        console.log('  For precise tree-sitter parsing (better function boundaries), run `npm install`');
        console.log('  from the CodeExam folder (it reads package.json and installs all dependencies).');
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

    const lang = await this.getLanguage(langName);
    if (!lang) return null;

    try {
      const parser = new this._Parser();
      parser.setLanguage(lang);

      const sourceCode = sourceLines.join('\n');
      const tree = parser.parse(sourceCode);

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
        default:
          result = null;
      }

      tree.delete();
      parser.delete();
      return result;
    } catch (e) {
      return null; // fallback to regex
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

  _addFunction(result, name, startLine, endLine, type) {
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
          const funcName = this._extractCFuncName(declarator);
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
            this._addFunction(result, fullName, startLine, endLine, fType);
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

  _extractCFuncName(declarator) {
    if (!declarator) return null;
    // Handle qualified_identifier (Class::method)
    if (declarator.type === 'qualified_identifier') {
      return declarator.text;
    }
    // Handle function_declarator -> declarator
    if (declarator.type === 'function_declarator') {
      const inner = declarator.childForFieldName('declarator');
      return this._extractCFuncName(inner);
    }
    // Handle pointer_declarator
    if (declarator.type === 'pointer_declarator') {
      const inner = declarator.childForFieldName('declarator');
      return this._extractCFuncName(inner);
    }
    // Handle reference_declarator
    if (declarator.type === 'reference_declarator') {
      for (let i = 0; i < declarator.childCount; i++) {
        const c = declarator.child(i);
        if (c.type !== '&' && c.type !== '&&') {
          return this._extractCFuncName(c);
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
}
