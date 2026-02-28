## Code Exam — Overview

**Code Exam** is an air-gapped source code examination tool — a Node.js port of a Python original. It indexes and analyzes large codebases with **zero npm dependencies** (only Node.js 18+ built-ins).

---

### What it does

- **Index & search** millions of lines of source code (literal, inverted, regex)
- **Call-graph analysis** — callers, callees, call trees, coupling maps
- **Code metrics** — hotspots, entry points, dead code gaps
- **Patent claim analysis** — feed a patent claim to an LLM, extract search terms, find matching functions via multi-term intersection search
- **Deduplication** — exact file dupes (SHA1), near-duplicate functions, structural hashing
- **LLM-assisted explanation** — via Claude API or local GGUF model

---

### Architecture

Two entry points share the same core engine:

```
CLI  (src/index.js)          Web GUI  (src/server.js)
       \                        /
        \                      /
     CodeSearchIndex  (src/core/CodeSearchIndex.js)
              — the brain —
```

The pattern is **build once, query many times**. The index is persisted as three JSON files: `literal_index.json`, `inverted_index.json`, and `function_index.json`.

---

### Key modules

| Module | Role |
|--------|------|
| `src/core/CodeSearchIndex.js` | Central class — indexing, searching, call analysis, dedup |
| `src/index.js` | CLI entry point, dispatches to command modules |
| `src/server.js` | HTTP server (pure `http` module, no Express) |
| `src/argparse.js` | Custom zero-dependency argument parser |
| `src/json-stream.js` | Streaming JSON parser for 2GB+ index files |
| `src/archive.js` | ZIP/TAR/GZIP extraction using only built-in `zlib` |
| `src/binstrings.js` | Extracts strings from compiled binaries |
| `src/glob.js` | Custom recursive glob |
| `public/` | Browser GUI — three-pane IDE-style layout, pure DOM, no framework |

### Commands (`src/commands/`)

| Module | What it handles |
|--------|-----------------|
| `search.js` | `--search`, `--literal`, `--fast`, `--regex` |
| `browse.js` | `--stats`, `--list-files`, `--show-file`, `--extract` |
| `callers.js` | `--callers`, `--callees`, `--call-inventory` |
| `graph.js` | `--call-tree`, `--file-map`, `--mermaid` diagrams |
| `metrics.js` | `--hotspots`, `--entry-points`, `--gaps` |
| `dedup.js` | `--dupefiles`, `--func-dupes`, `--struct-dupes` |
| `multisect.js` | `--multisect-search` — find smallest scope containing all terms |
| `claim.js` | `--claim-search` — LLM-driven patent claim analysis |
| `analyze.js` | `--analyze` — LLM code explanation |
| `interactive.js` | REPL mode dispatching to all the above |

---

### Notable patterns

- **Zero external dependencies** — arg parsing, glob, JSON streaming, ZIP extraction, HTTP server all hand-rolled
- **Optional**: `node-llama-cpp` for local GGUF model inference (gracefully degrades if absent)
- **16 test files** using Node's built-in `node:test`
- **Python-compatible** index format — can build with Python, query with Node, or vice versa
- **Multiple iteration files** at root (`app_2.js`–`app_5.js`, `server_2.js`–`server_3.js`) are working snapshots from Claude.ai development sessions
