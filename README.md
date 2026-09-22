# CodeExam

CodeExam, as its name implies, is a tool for **examining code** — primarily
source code, but with a growing emphasis on **quasi-source**: recovering
indexable structure from artifacts that weren't shipped as source (minified
bundles, executables, embedded scripts). Build an index over a codebase, then
browse, search, and cross-reference (callers, callees, call trees,
file/folder coupling) at scale — across **C, C++, Java, JavaScript,
TypeScript, Python, C#, Go, Rust, PHP, and Ruby** (tree-sitter), with
regex-level support for a dozen more. If you've used a code-comprehension
tool like SciTools Understand, the browse-and-cross-reference surface will
feel familiar.

Three surfaces share one engine and one on-disk index format — a **CLI**
(plus an interactive REPL), a **GUI** (served on localhost only), and an
**MCP server** for AI clients. Build the index once; query from any of them.

## Five key features

1. **AI-assisted examination of confidential code, air-gapped.** Local LLMs
   (GGUF) plus CodeExam's MCP tools, running on your own GPU — for code that
   must not leave a protected machine. Most users won't run air-gapped, and
   AI-assisted code examination may already be familiar (e.g. GitHub
   Copilot) — but "local first," though entirely optional and only one part
   of CodeExam, is a key underlying basis for it: we see local models and
   more powerful GPU-based machines becoming steadily more important.
   → [LOCAL_LLM.md](docs/LOCAL_LLM.md), [AIR_GAPPED.md](docs/AIR_GAPPED.md)

2. **Uncovering what a codebase is about.** CodeExam surfaces a codebase's
   "vocabulary" and key concepts, its "breadcrumbs" (telemetry markers in
   code), and code-surfacing metrics — and presents initial questions to ask
   and good first places to look, via the Overview and (optional) AI
   Overview features. → [UNCOVER_KEY_CODE.md](docs/UNCOVER_KEY_CODE.md)

3. **Quasi-source.** A surprising amount of indexable structure can be
   recovered from artifacts never shipped as source — minified/bundled JS,
   binaries (strings + demangled C++ symbols), JavaScript embedded inside
   native executables — then searched and cross-referenced with the same
   machinery as real source. → [QUASI_SOURCE.md](docs/QUASI_SOURCE.md)

4. **Detecting AI/ML and infrastructure in target code.** A detector suite
   surfaces inferred AI/ML pipelines, the models a codebase defines and
   uses, LLM calls, tools, agents/chains, embeddings, prompts, and the
   operational stack (containers, K8s, IaC, CI/CD). Three distinct things:
   (a) AI was used to *build* CodeExam; (b) users can *optionally* use AI
   during an examination; (c) CodeExam *detects* AI/ML in target code —
   which, interestingly, requires no AI at run time: AI skill and knowledge
   are baked into mechanical detectors.
   → [DETECTING_AI_ML.md](docs/DETECTING_AI_ML.md)

5. **Structural (non-textual) code search.** Ways of finding and identifying
   code that don't depend on what the code *says*: structural
   duplicate detection and diff, transform-resilient function fingerprints
   ("funcstrings"), synonym expansion in Multisect search, and catalogs that
   link commands to their handlers by position in dispatch tables rather
   than by name. → [STRUCTURAL_SEARCH.md](docs/STRUCTURAL_SEARCH.md)

## Quick start

CodeExam needs **[Node.js 18+](https://nodejs.org)** and a one-time
`npm install` from the project root:

```bash
npm install

# Build an index over a codebase (directories, zip/tar archives,
# binary files, minified JS, and @filelist files)
node src/index.js --build-index /path/to/codebase
```

```bash
# Launch the GUI (binds 127.0.0.1 — localhost only)
node src/server.js --index-path .code_search_index --port 3000
# then open http://localhost:3000
```

**First time?** A fresh download bundles a small demo index, so a bare `ce`
shows a short welcome and `ce --gui` opens the GUI on the demo. The GUI's
**Help → Tour** — and [TOUR.md](docs/TOUR.md) — walk you through what you're
seeing. For the REPL, the MCP server, requirements, and network-exposure
cautions, see [GETTING_STARTED.md](docs/GETTING_STARTED.md).

![Prompt catalog recovered from the minified cli.js inside claude.exe](prompts_from_cli_js_from_claude_exe.jpg)

*Prompt catalog — LLM prompts recovered from the minified `cli.js` bundled inside `claude.exe`.*

## Documentation

| Doc | What's in it |
|---|---|
| [GETTING_STARTED.md](docs/GETTING_STARTED.md) | Install, requirements, and the ways to run CodeExam (CLI, REPL, GUI, MCP) |
| [CODEEXAM_GUI.md](docs/CODEEXAM_GUI.md) | GUI layout — panes, accordions, Workspace — plus symbols & notation |
| [CODEEXAM_CLI.md](docs/CODEEXAM_CLI.md) | CLI overview (see also [docs/cli.md](docs/cli.md), the per-flag reference) |
| [CODEEXAM_MCP.md](docs/CODEEXAM_MCP.md) | The MCP tool surface as an LLM client sees it |
| [CODEEXAM_KEY_FEATURES.md](docs/CODEEXAM_KEY_FEATURES.md) | Browse and search, metrics, catalogs |
| [UNCOVER_KEY_CODE.md](docs/UNCOVER_KEY_CODE.md) | Vocabulary, breadcrumbs, Overview / AI Overview |
| [QUASI_SOURCE.md](docs/QUASI_SOURCE.md) | Binary analysis and bundled-JS extraction |
| [DETECTING_AI_ML.md](docs/DETECTING_AI_ML.md) | The AI/ML, LLM-app, and infrastructure detector suite |
| [STRUCTURAL_SEARCH.md](docs/STRUCTURAL_SEARCH.md) | Non-textual search: fingerprints, structural dupes, deobfuscation |
| [AI_ASSISTED_CODE_EXAM.md](docs/AI_ASSISTED_CODE_EXAM.md) | Optional LLM assistance (`--analyze`, claim search, input masking) |
| [LOCAL_LLM.md](docs/LOCAL_LLM.md) | Local GGUF models; reproducibility of local-model answers |
| [AIR_GAPPED.md](docs/AIR_GAPPED.md) | Enforced no-cloud operation |
| [CODEEXAM_INDEXES.md](docs/CODEEXAM_INDEXES.md) | Building and managing indexes; the on-disk format |
| [CODEEXAM_ARCHITECTURE.md](docs/CODEEXAM_ARCHITECTURE.md) | Engine and module layout |
| [CODEEXAM_TESTING.md](docs/CODEEXAM_TESTING.md) | The test suite |
| [CODEEXAM_KNOWN_LIMITATIONS.md](docs/CODEEXAM_KNOWN_LIMITATIONS.md) | Honest list of current gaps |
| [CODEEXAM_CODECLAIM.md](docs/CODEEXAM_CODECLAIM.md) | CodeExam's relation to patent analysis |
| [TOUR.md](docs/TOUR.md) | Guided tour of the GUI |

## Related: CodeClaim

A patent-focused build, tailored for IP-litigation workflows, is developed
under the name **CodeClaim**; it shares the CodeExam engine, and CodeExam
itself already carries some initial claim-analysis machinery. See
[CODEEXAM_CODECLAIM.md](docs/CODEEXAM_CODECLAIM.md).

---

*CodeExam is ~47,000 lines of JavaScript running under Node.js, nearly all
written by Claude Code in close collaboration with the main author, in
several places building on his earlier tooling. CodeExam and CodeClaim are
developed by Andrew Schulman — see
[softwarelitigationconsulting.com](https://www.softwarelitigationconsulting.com/).*
