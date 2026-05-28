# CodeExam

A source-examination tool for large codebases — bundled / minified
JavaScript, AI-framework source (PyTorch, transformers, DeepSeek, Qwen,
Llama), and the internals of LLM-using applications. The core capability
is indexing, search, and cross-reference at scale; air-gapped operation
and LLM assistance are both supported as optional modes.

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
# Build an index over a codebase (handles directories, zip/tar archives,
# binary files, and minified JS)
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
  of N search terms. Each term can be hard-required, negated
  (`!term` / `NOT term`), or **soft** (`?term` — optional: it does not
  gate the result set but still boosts ranking). Prose — a patent claim,
  a design spec, a bug report — can be parsed directly into a multisect
  expression (`--claim-search`)
- **Cross-reference**: callers, callees, transitive call trees, file and
  folder coupling maps. Mermaid diagrams for call trees and coupling
  maps; individual caller/callee lists are tabular.
- **Surfacing key code**: hotspots, class hotspots, most-called,
  domain-function ranking, entry points, dead-code gaps,
  project-specific vocabulary/nomenclature discovery
- **Function / class / file digests** — concise per-target summary
  (identity, callers, callees, distinctive strings, structural shape,
  inheritance chain + known subclasses for classes, imports/exports for
  files) usable standalone or as input to LLM prompts. Class digests
  walk the ancestor chain and surface known subclasses with method-
  override counts.

### Catalogs of "what does this code do"
- **Command catalog** — detected CLI options and slash-commands in the
  target codebase, linked to handler functions or methods (so a
  `/skills` entry in a chat tool resolves to its actual handler in the
  source). Heuristic — some shapes (e.g., chained Commander.js
  declarations) are still under-detected.
- **Breadcrumbs** — telemetry markers (logging, analytics, audit calls)
  with their associated functions, useful for tracing what an obfuscated
  binary actually reports back
- **Prompt catalog** — detected LLM prompts in the codebase, with
  composite expansion: ternary branches, template `${var}`
  interpolations, and function-level assemblies built piece-by-piece via
  `[…].join(…)` are merged into one searchable entry per logical prompt.
  Detects inline strings, `getSystemPrompt` / `systemPrompt:` properties,
  `role:"system"` messages, and `.md` skill files.

### Deobfuscation, renames, and fingerprints
- Detects esbuild / minified JS and prettifies via `js-beautify`
- Optional `webcrack` for bundle disassembly (≤500KB files)
- Auto-infers readable names from obfuscated code (toggle off with
  `--no-rename`):
  - `_KW_` keyword inference from string literals
  - `_NAME_` recovery from `__name(fn, "originalName")` esbuild helpers
  - `_IMPORT_` resolution from import bindings
  - `_CMD_` recovery for command/route/skill handler functions
- **Funcstrings** — a distinctive-string + call signature per function.
  Resilient to esbuild/webpack transforms; matches a bundled cli.js
  function back to its source-library equivalent. Two access shapes:
  full funcstring (`--show-funcstring`) for human inspection, and
  funcstring hashes (`--funcstr-hashes`) for cross-index intersection.
- **Portable fingerprint files** (`*.fp.json`) — fingerprint a curated
  reference library once, then match the resulting `.fp.json` against
  any working index without redistributing the library's source.
  Generate with `--build-fp-renames`; the working example shipped today
  is `franken.fp.json`. Matches surface as `_FP_`-prefixed names.
- Multiple types of duplication detection: exact (SHA1), near-duplicate,
  and **structural-dupe** (AST-shape hashing for non-bundled code).
  Dupes are preserved, not collapsed.

The reason CE spends so much machinery on duplicate detection is not
the obvious one (avoiding re-analysis): it's the inverse use. The same
structural and near-dupe signatures that find duplicates are also what
let you identify *unknown* code by matching against known reference
code, and what let you trace function lineages — three near-dupes
evolved from a common ancestor — across versions or across forks of a
codebase.

### Binary-code analysis
- Indexes binary files (executables, libraries) inside source trees by
  extracting strings AND demangled C++ function signatures (Itanium and
  MSVC name mangling).
- Granularity today: one pseudo-function per binary file, containing the
  file's extracted strings and demangled symbols. Search and the
  inverted index work on these uniformly with source content;
  per-function call/caller analysis does not apply to binary content.
- This is most useful for *large* binary corpora — Windows 11 system
  DLLs, Microsoft Office plugin trees, vendor SDKs — where the per-file
  string-plus-symbol fingerprint is enough to navigate at scale.

### Binary-bundled JavaScript extraction
- `--extract-js-from-binary <path>` recovers embedded JavaScript from
  native install binaries and writes it to a directory CodeExam can
  index normally. Format-aware dispatch: currently supports Bun
  standalone executables (used by Claude Code's `claude.exe`), including
  PE-signed Windows builds where the Bun trailer sits before the
  Authenticode certificate. Other formats (pkg, nexe, Node SEA, Tauri
  asset-table) are tracked as future work.

### LLM-assisted (optional)
- `--analyze <function>` — Claude (or local GGUF model) explains a
  function in context.
- **Multisect Analyze** — runs a multisect search, then has the LLM
  produce a structured per-term verdict grid: each search term is rated
  `PRESENT` / `NAME-ONLY` / `IFFY` / `ABSENT` with supporting evidence
  and a confidence level, so you can see at a glance how each term maps
  onto the matched function.
- `--claim-search <prose>` — extracts search terms from descriptive text
  (a patent claim, a spec, a requirement), multi-sects to find matching
  code, optionally LLM-summarizes each match.
- **Input masking** — strip comments, mask string literals, mask
  identifier names before sending a function to an LLM. The primary
  point is to force the model to reason about *logic* rather than
  leaning on comments or naming heuristics — both of which can be
  misleading, especially in obfuscated bundles where the names were
  inferred. (Masking does also suppress some incidental data leakage,
  but it's not a hard security boundary — strings may still leak
  depending on configuration.)
- `--build-prompt <function>` — generates a digest+source prompt
  suitable for hand-pasting into any LLM (no API needed). Use this to
  feed CodeExam findings to a chat tool while keeping source local.
- Offline operation via a local GGUF model under `node-llama-cpp`.
  Suitable for code review under Court Protective Order where outbound
  network requests are prohibited. Local-LLM support is limited to
  specific GGUF formats today — not every model loads cleanly.

### Index management
- Pure-Node streaming JSON parser handles 5GB+ indexes
- Index format compatible with the original Python implementation
- Build from directories, glob patterns, archives (zip/tar/gz), or
  `@filelist` files
- Query several indexes in a single run with `--multi-index @indexlist`
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
              ├── CodeSearchIndex.js     (index build, query API)
              ├── TreeSitterParser.js    (multi-language AST parsing)
              ├── rename.js              (_KW_, _CMD_, _NAME_, _IMPORT_ inference)
              ├── calls.js               (caller/callee graph)
              ├── multisect.js           (smallest-scope-containing-all-terms)
              ├── vocabulary.js          (domain-vocabulary discovery)
              ├── breadcrumbs-commands.js  (telemetry + command catalog)
              ├── hotspots.js            (complexity metrics)
              ├── canonical-funcs.js     (canonical-form normalization)
              ├── distance-helpers.js    (string + structural distance)
              ├── structural-fingerprint.js  (AST-shape hashing)
              ├── bundle-seam-detection.js   (esbuild module boundaries)
              └── CSI-helpers.js         (shared utilities)

src/commands/  (per-feature command modules invoked by the CLI / REPL /
                MCP / browser-UI dispatchers)
  ├── search.js, browse.js, callers.js, graph.js
  ├── metrics.js, dedup.js, multisect.js
  ├── digest.js, prompts.js, claim.js, analyze.js
  ├── fingerprint.js, build_fp_renames.js
  ├── extract_js_from_binary.js
  └── interactive.js  (REPL, used standalone and from the UI Console)

public/  (browser UI, modular ES extracts from the former monolithic
          app.js)
  ├── app.js              (top-level wiring)
  ├── state.js, api.js, dom-utils.js
  ├── click-handlers.js, context-menu.js
  ├── chrome — dialogs.js, overlays.js, console.js, layout.js
  ├── mermaid.js, source-viewer.js
  ├── prompts-and-catalog.js, menu-bar.js
  ├── middle-pane.js, list-renderers.js
```

## Requirements

- Node.js 18+ (ES modules, `node:test`)
- `npm install` to fetch runtime dependencies (Anthropic SDK, Express,
  MCP SDK, web-tree-sitter, js-beautify, webcrack, node-llama-cpp,
  Mermaid renderers — see `package.json`)
- Tree-sitter grammars vendored separately in `grammars/`
- For local LLM inference: a GGUF model file (model compatibility with
  `node-llama-cpp` is currently uneven; not every published GGUF loads
  cleanly)

## Standalone executable (Windows)

A single-file `codeexam.exe` can be built so users without Node, npm, or
Bun installed can run CodeExam directly. v0 is Windows-only (#78); macOS
and Linux builds are deferred.

Build:

```bash
npm install                  # if you haven't already
npm run build:exe            # requires Bun on the developer machine
                             #   winget install Oven-sh.Bun
```

This invokes `bun build --compile --target=bun-windows-x64` via
`scripts/build-exe.js` and writes `dist/codeexam.exe` (~100 MB — the size
is dominated by the bundled Bun runtime, not by CodeExam itself) plus two
sibling directories that must travel with the exe: `dist/grammars/`
(tree-sitter WASMs, for `--use-tree-sitter` parsing) and `dist/public/`
(browser UI assets, for `--gui` mode). Ship `dist/` as a single zip.

Run:

```
codeexam.exe --build-index <source-dir>     # CLI: behaves as `node src/index.js`
codeexam.exe --gui                          # GUI: starts server + opens browser
codeexam.exe --gui --port 9000              # override default port (8080)
```

**Windows SmartScreen** warns "Windows protected your PC" on first run of
an unsigned exe. Click *More info → Run anyway*. v0 ships unsigned;
Authenticode code signing for public distribution is a future follow-up.

**Lite build (no local-LLM):** if `bun --compile` can't bundle the
`node-llama-cpp` native module on your platform, build with
`npm run build:exe -- --no-llm`. The resulting exe runs everything
except semantic-search / local-GGUF features.

## Testing

```bash
node --test test/*.js
```

~400 tests across 15 test files, covering the indexing engine, search,
multisect, cross-reference, fingerprinting, dedup, and the LLM-assisted
command layer. Browser-UI tests are not yet automated — XMLUI-driven
GUI test automation is under evaluation (see #73's feasibility study).

## Operating without a network

The browser UI binds to localhost, the MCP server uses stdio, and
outbound network requests are opt-in and gated. Combined with the
optional local-GGUF path, CE can run a full examination workflow
without any network access — appropriate for litigation, security
review, or any context where source must stay local.

## Related: CodeClaim

A patent-focused build, tailored for IP-litigation workflows, is
developed under the name **CodeClaim**. CodeClaim shares the CE engine
and adds claim-specific extraction, term-mapping, and reporting.
