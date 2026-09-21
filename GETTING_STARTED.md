# Getting started with CodeExam

Install once, then use CodeExam four ways — a CLI, an interactive REPL, a local GUI, and an
MCP server for AI clients. All four share one `CodeSearchIndex` engine and one on-disk index
format: **build an index once, then query it from any of them.**

## Quick start

CodeExam needs **[Node.js 18+](https://nodejs.org)** and a one-time dependency install, run
from the project root (where `package.json` lives):

```bash
npm install

# Build an index over a codebase, into a named index directory (.myindex here).
# Directories, zip/tar archives, binary files, minified JS, and @filelist files are all handled.
node src/index.js --build-index /path/to/codebase --index-path .myindex

# Launch the GUI on that index (localhost only); then open http://localhost:3000
node src/server.js --index-path .myindex --port 3000
```

Throughout the docs, **`ce`** is the CLI entry point. A shim ships in the repo root — **`ce`**
(a POSIX `sh` script, for macOS/Linux) and **`ce.bat`** (for Windows) — each just runs
`node src/index.js`. Run it from the repo root (`./ce …` on macOS/Linux, `ce …` on Windows), or
put the root on your PATH, and the commands above shorten to:

```bash
ce --build-index /path/to/codebase --index-path .myindex
ce --gui --index-path .myindex          # the GUI, localhost only
```

The bare command-line tools (indexing, search, `--overview`) run *without* `npm install`; the
GUI, the MCP server, precise tree-sitter parsing, and the local-LLM features need the installed
packages (without them the GUI exits with a "run `npm install`" hint, and tree-sitter falls back
to a regex parser).

[[placeholder: Need an additional section showing 3–4 CLI commands run in a row (for their own
sake). The CLI commands here now are fine, but mostly lead up to launching the GUI.]]

**The GUI is loopback-only by default — the normal, safe case.** It binds **127.0.0.1**, and
`ce --gui` refuses `--host`, so out of the box nothing is reachable from the network. The only
way to expose it is to *deliberately* run `node src/server.js --host <addr>` yourself, which
starts an **unauthenticated** server (anyone who can reach it reads your indexed source and
local files). If you ever need that, do it only on a trusted, firewalled network — or better,
keep the server loopback-bound and reach it over an SSH tunnel (see
[`docs/cloud-gpu-chat-testing.md`](docs/cloud-gpu-chat-testing.md)).

**First time?** A fresh download bundles a small demo index, **`FIRST_RUN_INDEX.zip`** — mostly
a TLS demo — so a bare `ce` shows a short welcome and `ce --gui` opens the GUI on it. (This is
also the second use of `--index-path`: it can point at a `.zip` that *contains a built CE
index*, like this shipped sample, which CodeExam extracts to a temp cache on first load — not
to be confused with `--build-index` pointing at a `.zip` of a codebase's *source files* to
index.) A guided tour then walks you through what you're seeing — [[Help → Tour and/or
`TOUR.md`: confirm what the tour currently covers; note that `TOUR.md` today describes the
harness and Hunch features but not the TLS demo that is the main content of the first-run
index]].

## Four ways to use it

- **CLI** — `node src/index.js <command>` (i.e. `ce <command>`) for one-shot queries and
  scripting; `ce --help` lists every command. Full reference:
  [`CODEEXAM_CLI.md`](CODEEXAM_CLI.md).
- **Interactive REPL** — `ce --interactive` (`-i`), then issue slash commands (`/extract`,
  `/file-map`, `/help`, …); a few commands are REPL-only.
- **GUI** — `node src/server.js --port 3000` (or `ce --gui`) opens a multi-pane interface
  served from **localhost only** — nothing about it is web-facing; it just renders in a local
  browser. The panes, catalogs, and the planned redesign are described in
  [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md).
- **MCP server** — `node src/mcp-server.js` exposes the indexed codebase as Model Context
  Protocol tools, so an AI client (Claude Code, Claude Desktop) can search, extract, and
  analyze it directly. It speaks over **STDIO** — a local child process, no network socket —
  consistent with CodeExam's local-only posture. Tool surface:
  [`CODEEXAM_MCP.md`](CODEEXAM_MCP.md).

Creating, loading, and using indexes — the on-disk format, multiple indexes, loading from a
zip, and other index nuances — are described in [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md).

## Requirements

- **Node.js 18+** (ES modules, the built-in `node:test` runner).
- **`npm install`** for the runtime packages — the Anthropic SDK, Express, the MCP SDK,
  web-tree-sitter, js-beautify, webcrack, node-llama-cpp, and the Mermaid renderers (see
  `package.json`).
- Tree-sitter grammars are vendored in `grammars/`.
- **For local LLM inference:** a GGUF model file. Which models load, and how well each does per
  feature, is enumerated in [`docs/model-support.md`](docs/model-support.md) — the tested set is
  what to rely on, and some newer architectures don't load cleanly in current testing. If a
  recent model won't load, `npm update node-llama-cpp` (to pick up a newer bundled `llama.cpp`)
  is the cheapest first thing to try. The local path and its trade-offs are in
  [`LOCAL_LLM.md`](LOCAL_LLM.md).
