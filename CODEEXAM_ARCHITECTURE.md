# CodeExam Architecture

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part O pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

CodeExam is ~47,000 lines of JavaScript (engine + CLI + GUI) running under
Node.js, developed in close collaboration with Claude Code: nearly all of the
code was written by Claude Code, in several important places building on the
main author's earlier tooling (e.g. "Opstrings" and function digests, the
"NiceDbg" debugger, and an `ndx`/`find` inverted-index search tool).

## Architecture

```
CLI            Interactive       GUI server      MCP server
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
              ├── ai-ml-detectors.js     (AI/ML + LLM-app detector suite)
              ├── imports.js             (per-language import-statement extractor)
              ├── exports.js             (declared-exports catalog)
              ├── import-join.js         (cross-index import↔export resolution)
              ├── stack-detectors.js     (Infrastructure / operational-stack)
              ├── breadcrumbs-commands.js  (telemetry + command catalog)
              ├── hotspots.js            (complexity metrics)
              ├── canonical-funcs.js     (canonical-form normalization)
              ├── distance-helpers.js    (string + structural distance)
              ├── structural-fingerprint.js  (AST-shape hashing)
              ├── funcstr-corpus.js      (funcstring corpus / cross-index intersection)
              ├── bundle-seam-detection.js   (esbuild module boundaries)
              ├── filter-match.js        (--filter matching)
              └── CSI-helpers.js         (shared utilities)

src/commands/  (per-feature command modules invoked by the CLI / REPL /
                MCP / GUI dispatchers)
  ├── search.js, browse.js, callers.js, graph.js
  ├── metrics.js, dedup.js, multisect.js
  ├── digest.js, prompts.js, claim.js, analyze.js
  ├── imports.js, imports-from.js, exports.js  (--imports / --imports-from cross-index joins + --exports catalog/used-by)
  ├── census.js, infrastructure.js  (import census, Infrastructure accordion)
  ├── harness.js  (emitted activation-capture harness)
  ├── fingerprint.js, build_fp_renames.js
  ├── extract_js_from_binary.js, inspect_binary.js
  └── interactive.js  (REPL, used standalone and from the GUI Console)

public/  (GUI, modular ES extracts from the former monolithic app.js)
  ├── app.js              (top-level wiring)
  ├── state.js, api.js, dom-utils.js
  ├── click-handlers.js, context-menu.js
  ├── chrome — dialogs.js, overlays.js, console.js, layout.js
  ├── mermaid.js, source-viewer.js
  ├── prompts-and-catalog.js, menu-bar.js
  ├── middle-pane.js, list-renderers.js
```
