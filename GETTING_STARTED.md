# Getting Started with CodeExam

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part B pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

## Four ways to use it

- **CLI** — `node src/index.js <command>` for one-shot queries and scripting.
  Run `node src/index.js --help` for the full command list.
- **Interactive REPL** — `node src/index.js --interactive`, then issue slash
  commands (`/fast`, `/extract`, `/file-map`, `/help`, …). The same REPL is
  also reachable from the GUI's Console pane; a few commands (`/file-map`
  etc.) are currently REPL-only.
- **GUI** — `node src/server.js --port 3000` opens a multi-pane interface
  served from **localhost only** (no remote access, no outbound network
  calls). Called "GUI" rather than "browser UI" because nothing about it is
  web-facing — it just happens to render in a local browser. Left pane:
  function/file/class accordions and other catalogs. Middle-top: output.
  Middle-bottom: source viewer with linkified call sites. A **Workspace**
  area collects what you're actively examining. Mermaid call trees and
  file-coupling diagrams render inline. The GUI is gradually moving toward a
  newer design with less of a fixed three-pane layout (the goal being that many
  features operate as semi-independent mini-apps — so that, for example,
  multiple instances of a feature can run side-by-side for comparison, and
  long-running operations proceed on their own threads).
- **MCP server** — `node src/mcp-server.js` exposes the indexed codebase as
  Model Context Protocol tools, so Claude Code or Claude Desktop (and
  presumably other MCP clients such as Codex, though that's untested) can
  search, extract, and analyze it directly.

All four share the same `CodeSearchIndex` engine and the same on-disk index
format. Build the index once; query from any of them.

## Quick start

CodeExam needs **[Node.js 18+](https://nodejs.org)** and a one-time dependency
install — run this from the project root (where `package.json` lives):

```bash
npm install
```

The bare command-line tools (indexing, search, `--overview`) run without this.
The **GUI**, **MCP server**, precise **tree-sitter** parsing, and **local-LLM**
features need the npm packages — without them the GUI exits with a "run
`npm install`" hint, and tree-sitter falls back to a regex parser.

```bash
# Build an index over a codebase (handles directories, zip/tar archives,
# binary files, minified JS, and @filelist files)
node src/index.js --build-index /path/to/codebase

# Launch the GUI (localhost only)
node src/server.js --index-path .code_search_index --port 3000
# then open http://localhost:3000
```

> **Network exposure.** The GUI binds **127.0.0.1** by default, and `ce --gui`
> rejects `--host` outright. Serving it on a network requires running
> `node src/server.js --host <addr>` directly, which starts an **unauthenticated**
> server — anyone who can reach it reads your indexed source and local files. Do
> that only on a trusted, firewalled network; to reach it remotely, prefer an SSH
> tunnel to a loopback-bound server (see `docs/cloud-gpu-chat-testing.md`).

**First time?** A fresh download bundles a small demo index, so a bare `ce`
shows a short welcome and `ce --gui` opens the browser UI on the demo. The GUI's
**Help → Tour** — and [`TOUR.md`](TOUR.md) — walk you through what you're seeing.

## Requirements

- Node.js 18+ (ES modules, `node:test`).
- `npm install` to fetch runtime dependencies (Anthropic SDK, Express, MCP
  SDK, web-tree-sitter, js-beautify, webcrack, node-llama-cpp, Mermaid
  renderers — see `package.json`).
- Tree-sitter grammars vendored separately in `grammars/`.
- For local LLM inference: a GGUF model file. Compatibility is uneven and
  tracks the `llama.cpp` bundled in `node-llama-cpp` — older architectures
  load (e.g. Qwen 3), the newest (Gemma 4, Qwen 3.5) currently fail (#75). If
  a recent model won't load, `npm update node-llama-cpp` to pick up a newer
  bundled `llama.cpp` is the cheapest first thing to try.
