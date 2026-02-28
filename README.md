# code-exam (Node.js)

Air-Gapped Source Code Examination Tool — Node.js port.

**Zero external dependencies.** Uses only Node.js 18+ built-ins.

## Quick Start

```bash
# Build an index
node src/index.js --build-index ./your/source/code

# Search
node src/index.js --fast "TODO"
node src/index.js --literal "import os"
node src/index.js --regex "def \w+\("

# Browse
node src/index.js --stats
node src/index.js --list-files
node src/index.js --list-functions
node src/index.js --list-functions-size
node src/index.js --extract "main"
node src/index.js --extract "worker.java@processTasks"

# File/folder search
node src/index.js --files-search "class"
node src/index.js --folders-search "import"

# Callers/callees (Phase 2)
node src/index.js --callers "search_literal"
node src/index.js --callees "main"
node src/index.js --most-called 20 --defined-only

# Call graphs (Phase 2)
node src/index.js --call-tree "build_index" --depth 3
node src/index.js --call-tree "build_index" --mermaid
node src/index.js --file-map --max-results 10
node src/index.js --file-tree "main.py"

# Display modifiers
node src/index.js --fast "error" --max-results 50 --verbose
node src/index.js --list-functions --include-path src --exclude-path test
node src/index.js --list-functions --full-path --filter "handle"

# Metrics / discovery (Phase 3)
node src/index.js --hotspots 20
node src/index.js --hot-folders 15
node src/index.js --entry-points 20 --max-calls 1
node src/index.js --gaps
node src/index.js --domain-fns 20
node src/index.js --list-classes --verbose
node src/index.js --class-hotspots 15

# Interactive mode (Phase 6) — auto-enters if no command given
node src/index.js --index-path /path/to/index
# Or explicitly:
node src/index.js --interactive
# Then at the prompt:
#   /fast "TODO"
#   /hotspots 20
#   /callers main
#   /extract build_index
#   /help
#   /quit
```

## Python Index Compatibility

The Node.js version reads and writes the **same JSON index format** as the Python version.
You can build an index with either version and query with the other:

```bash
# Build with Python
python code_exam.py --build-index ./src --skip-semantic

# Query with Node.js
node src/index.js --fast "TODO" --index-path .code_search_index
```

Index files: `literal_index.json`, `inverted_index.json`, `function_index.json`

## Phase 1+2+3+6 Coverage

| Feature | Status |
|---------|--------|
| Build index (dir, file, glob, @filelist) | ✅ |
| SHA1 file dedup | ✅ |
| Inverted index build | ✅ |
| Function index build (regex, all languages) | ✅ |
| Literal search | ✅ |
| Inverted index search (--fast) | ✅ |
| Regex search | ✅ |
| Hybrid search | ✅ |
| Files-search, folders-search | ✅ |
| Stats, list-files, show-file | ✅ |
| List-functions, alpha, size | ✅ |
| Extract function source | ✅ |
| FILE@FUNCTION extract | ✅ |
| Path include/exclude filters | ✅ |
| Scan-extensions, index-extensions | ✅ |
| List-indexes | ✅ |
| JSON index persistence | ✅ |
| Python index compatibility | ✅ |
| **Callers** (--callers, transitive) | ✅ |
| **Callees** (--callees) | ✅ |
| **Most-called** (--most-called, filters) | ✅ |
| **Call tree** (--call-tree, up+down) | ✅ |
| **File map** (--file-map, coupling) | ✅ |
| **File tree** (--file-tree, deps) | ✅ |
| **Mermaid diagrams** (--mermaid) | ✅ |
| **Hotspots** (--hotspots) | ✅ |
| **Hot folders** (--hot-folders) | ✅ |
| **Entry points** (--entry-points) | ✅ |
| **Gaps** (--gaps, dead code) | ✅ |
| **Domain functions** (--domain-fns) | ✅ |
| **List classes** (--list-classes) | ✅ |
| **Class hotspots** (--class-hotspots) | ✅ |
| **Large index loading** (streaming JSON, >2GB) | ✅ |
| **Interactive REPL** (--interactive, auto-enter) | ✅ |

### Not Yet Implemented (Future Phases)

- Phase 4: File/func dedup, structural hashing, func-dupes, near-dupes
- Phase 5: Multi-term intersection (--multisect-search)
- Token index / vocabulary discovery (--discover-vocabulary)
- Archive support: --build-index on zip/7z/tar/gz files
- Phase 7: CLI packaging (standalone .exe via pkg)
- Phase 8: Semantic search (vectra + transformers.js)
- Phase 9: Tree-sitter parsing
- Phase 10: LLM integration (node-llama-cpp)

## Architecture

```
src/
├── index.js              # CLI entry point
├── argparse.js           # Zero-dep argument parser
├── utils.js              # SearchResult, constants, helpers
├── glob.js               # Built-in glob implementation
├── json-stream.js        # Streaming JSON parser (large file support)
├── core/
│   └── CodeSearchIndex.js  # Core: build, search, parse, extract, callers, metrics
└── commands/
    ├── search.js           # Search display & handlers
    ├── browse.js           # Browse/listing handlers
    ├── callers.js          # Callers, callees, most-called
    ├── graph.js            # Call-tree, file-map, file-tree, Mermaid
    ├── metrics.js          # Hotspots, entry-points, gaps, classes
    └── interactive.js      # Interactive REPL mode
test/
├── test_basic.js          # 16 Phase 1 tests
├── test_phase2.js         # 16 Phase 2 tests
├── test_phase3.js         # 15 Phase 3 tests
└── test_phase6.js         # 26 Phase 6 tests
```

## Requirements

- Node.js 18+ (uses ES modules, node:test)
- No npm install needed — zero dependencies

## Testing

```bash
node --test test/test_basic.js
```

## Language Support (Function Parsing)

Same regex patterns as the Python version:

| Language | Extensions | Functions | Classes | Methods |
|----------|-----------|-----------|---------|---------|
| Python | .py, .pyw | ✅ | ✅ | ✅ (indent-based) |
| C/C++ | .c, .cpp, .h, .hpp, ... | ✅ | ✅ | ✅ (Class::method) |
| Java | .java | ✅ | ✅ | ✅ (indent-based) |
| JavaScript/TS | .js, .ts, .jsx, .tsx | ✅ | ✅ | ✅ (shorthand) |
| Go | .go | ✅ | ✅ (struct) | — |
| Rust | .rs | ✅ | ✅ (struct/impl) | — |
| PHP | .php | ✅ | ✅ | — |
| Ruby | .rb | ✅ | ✅ | — |
| Perl | .pl, .pm | ✅ | ✅ (package) | — |
| C# | .cs | ✅ | ✅ | — |
| CoffeeScript | .coffee | ✅ | ✅ | — |
| VBScript | .vbs, .bas | ✅ | ✅ | — |
| AWK | .awk | ✅ | — | — |
