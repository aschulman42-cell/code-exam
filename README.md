# Code Exam

An air-gapped source code examination tool for large codebases — including
bundled, minified, or otherwise-deobfuscation-resistant JavaScript, AI
framework source (PyTorch, transformers, DeepSeek, Qwen, Llama), and the
internals of LLM-using applications. Designed for offline,
security-sensitive use; can optionally use Claude API or a local GGUF
model when explanation is needed.

Originally a Python tool; this is the Node.js port (now the active
codebase).

## Four ways to use it

- **CLI** — `node src/index.js <command>` for one-shot queries and scripting
- **Interactive REPL** — `node src/index.js --interactive`, then issue
  slash commands (`/fast`, `/extract`, `/file-map`, `/help`, …). The same
  REPL is also reachable from the browser UI's Console pane; some
  commands (`/file-map` etc.) are currently REPL-only
- **Browser UI** — `node src/server.js --port 3000` opens a three-pane
  HTML interface served from **localhost only** (no remote access, no
  outbound network calls). Left pane: function/file/class accordions and
  other catalogs. Middle-top: output. Middle-bottom: source viewer with
  linkified call sites. Mermaid call trees and file-coupling diagrams
  render inline.
- **MCP server** — `node src/mcp-server.js` exposes the indexed codebase
  as Model Context Protocol tools, so Claude Code or Claude Desktop can
  search, extract, and analyze it directly

All four share the same `CodeSearchIndex` engine and the same on-disk
index format. Build the index once; query from any of them.

## Quick start

```bash
# Build an index over a codebase, prettifying minified JS along the way
node src/index.js --build-index /path/to/codebase

# Launch the browser UI (localhost only)
node src/server.js --index-path .code_search_index --port 3000
# then open http://localhost:3000
```

Indexes scale to multi-gigabyte source trees (tested on Chromium —
~195K files, ~5GB index, loaded with
`NODE_OPTIONS=--max-old-space-size=8192`).

## Feature highlights

### Browse and search
- Function/file/class accordions; full-text, regex, and inverted-index
  (`--fast`) search
- **Multisect**: find the smallest scope (function/file) containing all
  of N search terms — including synonyms. Patent claims can be parsed
  directly into multisect expressions (`--claim-search`)
- **Cross-reference**: callers, callees, transitive call trees, file and
  folder coupling maps; Mermaid diagrams of any of these
- **Surfacing key code**: hotspots, class hotspots, most-called,
  domain-function ranking, entry points, dead-code gaps,
  project-specific vocabulary/nomenclature discovery
- **Function digests** — concise per-function summary (signature,
  callers, callees, distinctive strings, structural shape) usable
  standalone or as input to LLM prompts

### Catalogs of "what does this code do"
- **Command catalog** — every CLI option and slash-command in the target
  codebase, linked to its handler function or method (so a `/skills`
  entry in a chat tool resolves to the actual handler in the source)
- **Breadcrumbs** — telemetry markers (logging, analytics, audit calls)
  with their associated functions, useful for tracing what an obfuscated
  binary actually reports back
- **Prompt catalog** — every LLM prompt in the codebase, with composite
  expansion: ternary branches, template `${var}` interpolations, and
  function-level assemblies built piece-by-piece via `[…].join(…)` are
  all merged into one searchable entry per logical prompt. Detects
  inline strings, `getSystemPrompt` / `systemPrompt:` properties,
  `role:"system"` messages, and `.md` skill files

### Deobfuscation, renames, and fingerprints
- Detects esbuild / minified JS and prettifies via `js-beautify`
- Optional `webcrack` for bundle disassembly (≤500KB files)
- Auto-infers readable names from obfuscated code via:
  - `_KW_` keyword inference from string literals
  - `_FP_` fingerprint matching against reference libraries
  - `_NAME_` recovery from `__name(fn, "originalName")` esbuild helpers
- **Semantic fingerprinting** — distinctive string + call patterns per
  function. Resilient to esbuild/webpack transforms; matches a bundled
  cli.js function back to its source library equivalent
- **Portable fingerprint files** (`*.fp.json`) — share fingerprints of
  a library without redistributing its source; a curated set of common
  dependencies (Anthropic SDK, zod, ajv, etc.) can be matched against
  any working index
- Multiple types of duplication detection: exact (SHA1), near-duplicate,
  and **structural-dupe** (AST-shape hashing for non-bundled code)

### Binary-code analysis
- Indexes binary files inside source trees (executables, libraries) by
  extracting strings AND demangled function signatures (Itanium / MSVC
  C++ name mangling)
- Builds the same kind of inverted index over binary content as over
  source, so the same search and cross-reference tools work uniformly

### LLM-assisted (optional)
- `--analyze <function>` — Claude (or local GGUF model) explains a
  function in context
- `--claim-search <patent-claim>` — extracts search terms from a patent
  claim, multi-sects to find matching code, optionally LLM-summarizes
  each match
- `--build-prompt <function>` — generates a digest+source prompt suitable
  for hand-pasting into any LLM (no API needed). Use this to feed
  CodeExam findings to a chat tool while keeping source local.
- Air-gapped path: works fully offline using a local GGUF model under
  `node-llama-cpp`. Suitable for code review under Court Protective
  Order where outbound network requests are prohibited.

### Index management
- Pure-Node streaming JSON parser handles 5GB+ indexes
- Index format compatible with the original Python implementation
- Build from directories, glob patterns, archives (zip/tar/gz), or
  `@filelist` files
- Multi-language parser via tree-sitter WASM grammars + regex fallback:
  - Tree-sitter: **C, C++, Java, JavaScript, TypeScript, Python, C#,
    Go, Rust, PHP, Ruby**
  - Regex-only: **Swift, Kotlin, Scala, Lua, Objective-C, CoffeeScript,
    Perl, VBScript, AWK**

## Architecture

```
CLI            Interactive       Browser UI      MCP server
(index.js)    (interactive.js)  (server.js)     (mcp-server.js)
       \           |                |               /
        \          |                |              /
         CodeSearchIndex  ←  the engine
         (src/core/)
              |
              ├── TreeSitterParser.js   (multi-language AST parsing)
              ├── token/string/function indexes
              │       (literal_index.json, inverted_index.json,
              │        function_index.json, string_index.json,
              │        renames.json, fingerprints/*.fp.json)
              └── command modules (src/commands/)
                  ├── search.js, browse.js, callers.js, graph.js
                  ├── metrics.js, dedup.js, multisect.js
                  ├── digest.js, prompts.js, claim.js, analyze.js
                  ├── fingerprint.js, build_fp_renames.js
                  └── interactive.js  (REPL — used both standalone and
                                       from the browser UI Console pane)
```

## Requirements

- Node.js 18+ (ES modules, `node:test`)
- `npm install` to fetch runtime dependencies (Anthropic SDK, Express,
  MCP SDK, web-tree-sitter, js-beautify, webcrack, node-llama-cpp,
  Mermaid renderers — see `package.json`)
- Tree-sitter grammars vendored separately in `grammars/`
- For local LLM inference: a GGUF model file (any model compatible with
  `node-llama-cpp`)

## Testing

```bash
node --test test/
```

~240 CLI tests across 8 files. Browser-UI tests pending — see TODO #262.

## License / status

Air-gapped-first: the browser UI binds to localhost, the MCP server uses
stdio, and outbound network requests are opt-in and gated. Designed for
litigation / security-review contexts where source must stay local.
