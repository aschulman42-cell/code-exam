# Code Exam (Node.js) — Master TODO List
**Updated: 2026-03-05**

---

## Ongoing

| # | Description | Status |
|---|---|---|
| 150 | **TODO maintenance**: Update this file at end of each session. Review conversation for items discussed but not captured. | **ongoing** |
| 260 | **Documentation**: README/manual (#113), key design decisions reference (see `DESIGN_DECISIONS.md`), inline code comments where non-obvious. | **ongoing** |
| 261 | **Testing**: 240 CLI tests across 8 files. No automated GUI testing yet — need test strategy for web UI (endpoint tests, browser automation, or manual test checklist). | **ongoing** |

---

## High Priority — Near Term

| # | Description | Status |
|---|---|---|
| 200 | **Local LLM for /analyze**: Must work on air-gapped systems. --use-claude is verboten in litigation context. Need: (a) test with deepseek-coder-6.7b-instruct Q4_K_M and larger models, (b) measure quality vs speed tradeoffs, (c) optimize prompts for smaller context windows. node-llama-cpp integration is stubbed but untested. **Broader vision**: background pre-analysis — on first install with a codebase, let local LLM churn overnight analyzing/summarizing functions one-by-one, then produce summary-of-summaries. Pre-cache analysis of predicted high-interest functions. See also #231, #233. | **high priority** |
| 201 | **Interactive /chat (RAG)**: Free-form questions about the codebase. "What file handles structural dupe comparison?" Needs: function/file summaries as context, embedding-based retrieval or keyword search to find relevant code, then LLM synthesis. Could use existing multisect + extract as primitive retrieval, feed results to LLM. | **high priority, design needed** |
| 202 | **Term extraction independence**: claim.js extractClaimTerms currently uses Claude API only. --term-extract-model flag exists in CLI (for local GGUF) but is not exposed in the GUI. May be replaced with embeddings, small specialized model, or keyword extraction. analyze.js is intentionally decoupled — keep them separate. | **design, in progress** |
| 280 | **Large index loading in GUI**: Very large indexes (e.g. Chromium) fail silently — loaded only 161 files, 0 hits on all searches. Need to diagnose whether this is a memory limit, JSON parse failure, or streaming issue. CLI may handle the same index correctly. | **high priority, bug** |
| 281 | **Bad/corrupt index detection**: validateIndex() checks for missing/empty required files. "incomplete" badge shown in Indexes accordion and Load Index browser. Load endpoint returns detailed error. Commit 13c547a. | done |

---

## GUI Gaps (features in CLI but not yet in GUI)

| # | Description | Status |
|---|---|---|
| 270 | **Build Index: extension control**: CLI supports `--exclude-extensions` and `--ext` (include) but the GUI Build Index dialog doesn't expose either. Dialog should (a) show which extensions will be included by default, (b) let user add extensions to include (like `--ext .coffee`), and (c) let user exclude extensions (like `--exclude-extensions .xml,.html`). | **planned** |
| 271 | **Claim-analyze progress in Analysis pane**: CLI shows `[Step 1/4]` through `[Step 4/4]` with engine names, search summary, match counts. GUI doesn't show this progress. Subsumes #251 (progress appears in wrong pane). | **planned** |
| 252 | **Separate term-extraction engine from analysis engine**: Allow different LLMs for the two claim-analyze steps. **CLI**: add `--term-llm` and `--analyze-llm` flags that override `--engine` for each step independently. **GUI**: add a second engine dropdown or split into "Term Extraction Engine" and "Analysis Engine". | **design needed** |
| 282 | **Scan-extensions in GUI**: CLI has scan-extensions (inventory of file extensions in a directory tree, sorted most-to-least). Expose in GUI near Build Index, so user can see what's in the target directory before building an index. Helps inform #270 extension choices. | **planned** |

---

## GUI UX

| # | Description | Status |
|---|---|---|
| 283 | **Callers: consolidate repetitive output**: Grouped by (caller, file) with expandable call sites showing source snippets. Toggle arrow and "N sites" label expand inline. Commit TBD. | done |
| 284 | **Click-to-function in file view**: Clicking filenames in dupe/struct-diff detail views opens file scrolled to function start line with gold highlight. Commit 13c547a. | done |
| 285 | **Side-by-side dupe comparison**: Visual comparison between two near-dupes or structural-dupes. Need an uncluttered way to create multiple instances of the lower-middle pane and arrange them. Likely add to current Window menu. | **planned, design needed** |
| 286 | **Export/print from GUI**: Let user save or print contents of GUI panes — lists, analysis results, diagrams. CLI output can be redirected to files, but GUI users will want to save results directly. PDF export or save-as-text. | **planned** |
| 287 | **Settings dialog**: Centralize settings like max-depth, defined-only, and other semi-global options (currently scattered or only available via CLI flags). Menu or dialog accessible from GUI. | **planned** |
| 291 | **Per-pane text search**: Browser Ctrl+F searches the entire page, not individual panes. Add a search button or Ctrl+F override within each pane (especially the source view in middle-bottom) so user can search within one pane's content without wading through the whole screen. | **planned** |
| 292 | **Incomplete index: load behavior**: Loading an incomplete index (missing function_index or inverted_index) currently succeeds silently but searches return 0 results. Either (a) warn user clearly on load that the index is incomplete and searches won't work, with a prompt to rebuild, or (b) auto-trigger rebuild when loading an incomplete index. | **planned** |

---

## Core Search & Analysis

| # | Description | Status |
|---|---|---|
| 8 | **--context-function**: show surrounding function for search hits. Python whitespace scoping is tricky. | planned |
| 141 | **Python import aliasing**: `from os.path import join` — we don't track aliases. | planned |
| 142 | **Implicit class context**: `this.foo()` in Java, `self.method()` in Python — resolution to ClassName.method(). | planned |
| 210 | **Search case sensitivity**: (a) User may want opt-in case-sensitive search; (b) audit code for unintentional case sensitivities in search paths. | **planned** |

---

## Unresolved Symbols & Call Graph

| # | Description | Status |
|---|---|---|
| 220 | **Unresolved callee table**: Currently `--callees` and `--call-tree` silently skip any call target not in the function index. Should build a table of all call targets including unresolved ones (library calls like printf, API calls, etc.). Would enable: "What external APIs does this code use?", library dependency mapping, integration point discovery. | **important** |
| 221 | **"Unusual opcode" equivalent**: Certain function calls or patterns are revealing — `mmap`, `dlopen`, `CreateRemoteThread`, `eval`, `exec`. Curated list of "interesting" calls whose presence is noteworthy regardless of whether they're in the index. Related to magic numbers (#222). | **design needed** |
| 222 | **Magic number dictionary**: Don't normalize known constants in structural hashing (0xCAFEBABE=Java class, 0x5A827999=SHA, etc.). When someone searches for "Java class file", point to functions containing 0xCAFEBABE. Requires magic_constants.dat file. | **planned** |
| 2 | **Module/file-level call graphs**. | design needed |
| 4 | **Header file handling**: .h declarations to annotate --extract output. | design needed |
| 126 | **Show callers/callees as comments in --extract output** (opt-in). | design needed |

---

## LLM Analysis (Phase 8b+)

| # | Description | Status |
|---|---|---|
| 230 | **SimpleMasker Layer 3**: Full identifier masking (FUNC_N, PARAM_N, VAR_N, CALL_N). Ported from Python's ~400 lines of regex patterns. Deferred — even Python's --mask-all leaves hints. | **deferred** |
| 231 | **Combined multi-function analysis**: When multisect returns 2 functions <=300 lines total, send both in one LLM call for relationship analysis. Python has _do_multisect_combined. Structure already supports arrays. Extension: also pass a top multisect hit together with its most-important callees for richer context. For local LLMs with small context windows, this may require careful token budgeting or summarize-then-combine approach. | **deferred, easy** |
| 233 | **Prompt optimization for local models**: Local 7B models have limited context and instruction-following. May need shorter prompts, fewer numbered instructions, simpler output format. Test and iterate. | **research** |

---

## Discovery & Metrics

| # | Description | Status |
|---|---|---|
| 130e | **--hot-folders --depth N**: top-level overview. | planned |
| 130f | **Library/plumbing detection and filtering**: Auto-detect infrastructure paths (com/google, org/apache, node_modules, C RTL, vendor/, third_party/, etc.) and offer to hide them. Should work without user knowing specific names — curated patterns for top languages/platforms. Offer --exclude-libs or equivalent GUI toggle. | planned |
| 130h | **Fan-out/fan-in metrics**: orchestrators (high fan-out), integration points. See [^130h]. | planned |
| 130i | **PageRank-style / Hub Functions scoring**: See [^130i]. | research |
| 131a | **Non-function ID extraction**: struct defs, global vars, script-heavy languages. | design needed |
| 250 | **Remove special-case command dispatch from interactive.js**: Refactor dispatchCommand() if/else chain into unified dispatch table — map command names to do*() handler + declarative arg spec. | **planned** |
| 240 | **Multisect cross-method class scope**: Add intermediate scope between function and file: multiple methods in a single class. Requires class membership data from function index. | **planned** |
| 241 | **Per-term mandatory/optional flag in multisect**: Allow specifying which terms are optional — their presence boosts ranking but absence doesn't disqualify. Syntax TBD, e.g. `?term` or `OPT term` prefix. | **design needed** |
| 254b | **"What should I look at first?" — orienting new users**: See [^254b]. | **research, important** |
| 288 | **Call Inventory: filter and verbose support**: Call Inventory and external call lists should respect --filter and --verbose in the GUI, producing richer detail beyond what Most Called shows. | **planned** |
| 289 | **Structural hashing beyond dupes**: Structural Dupes works very well. Research: apply structural hash signatures to purposes other than duplicate detection — e.g. finding functions with similar algorithmic structure across different codebases, pattern libraries, or "functions shaped like X." | **research, vague** |

[^130h]: **Fan-out/fan-in metrics** — Functions with high fan-out (call many diverse in-index functions) are likely orchestrators / control centers. Even if called only once, a function that calls `buildIndex`, `parseFunctions`, `writeInvertedIndex`, and `buildFunctionIndex` is clearly coordinating something important. Score: `fan_out x log(fan_in + 1)` finds the sweet spot between "calls lots of things" and "is itself called by several things." Functions that appear as intermediate nodes in many call trees (not leaves, not roots) are the connective tissue. Data available via `findCallees` (fan-out) and `findCallers` (fan-in).

[^130i]: **PageRank-style / Hub Functions scoring** — Current metrics all fail to surface what's semantically important: Most Called is swamped by stdlib (`slice`, `push`, `trim`). Even with `--defined-only`, utility functions (`errorResponse`, `jsonResponse`) dominate. Hotspots weights by size x calls but still catches plumbing. Domain Functions uses TF-IDF naming rarity but that's about naming, not structural importance. What's needed: recursive importance scoring where a function's importance is boosted by the importance of its callers (PageRank on the call graph). The data exists in `getCallInventory`'s in-index caller lists — needs iterative scoring over that graph. Key insight: frequency-based metrics find plumbing; structural-centrality metrics find architecture.

[^254b]: **"What should I look at first?"** — The goal: when a user opens an index of unfamiliar code, surface the 5-10 functions/classes that a senior engineer would tell a new team member to read first. Current approaches and why they fall short: (1) Most Called — swamped by external/stdlib. (2) Most Called --defined-only — surfaces utility functions, not domain logic. (3) Hotspots — same problem, weighted by size. (4) Domain Functions — TF-IDF on naming is about rarity, not importance. (5) Vocabulary — good for learning nomenclature but doesn't point to specific code. Two promising new angles: **(a) Fan-out scoring**: functions that call many diverse in-index targets are orchestrators (see #130h). **(b) UI-structure analysis**: look at the UI definition layer (HTML templates, route tables, CLI arg parsers, menu definitions, event handlers) to extract the "vocabulary of user-facing actions." These are curated by humans and represent intentional feature boundaries. The functions wired to UI elements are likely entry points into important domain logic. For web apps: route handlers; for CLI tools: argparse options; for GUI apps: menu items and dialog handlers. Could be implemented as a heuristic that identifies UI-definition patterns and boosts the importance of functions referenced from them.

---

## Dedup & Signatures

| # | Description | Status |
|---|---|---|
| 123e | **Magic number preservation** in structural hashing. See also #222. | planned |
| 124 | **Code comparison**: diff two codebases using funchashes. | design needed |
| 132 | **Index comparison / version diff**: diff two indices. "In v54->v55: do_hotspots() added, main() reduced 75%". | **important, design needed** |

---

## Function Index Quality

| # | Description | Status |
|---|---|---|
| 110 | **Partial path matching**: needs consistency audit across all commands. | needs audit |
| 120 | **Header declarations parsed as definitions** (huge false positives in .h). | important |
| 121 | **--most-called macro/type false positives** (STDMETHOD, HRESULT, ULONG). | important |
| 128 | **--use-tree-sitter broken for *.py** (0 functions). Regex fallback works. | diagnostic added |
| 290 | **Additional language parsers**: Add tree-sitter/regex hybrid support for Dart, R, Groovy, Haskell. Investigate whether CoffeeScript (.coffee) and Handlebars (.hbs) need separate handling or fall through to existing parsers. | **planned** |

---

## Index & Performance

| # | Description | Status |
|---|---|---|
| 5 | **Semantic search** (embeddings, vector similarity). Python version had ONNX prototype. | deferred |
| 149 | **Semantic search performance**: Huge RAM usage for large codebases (AllJoyn 60k files). | deferred |
| 6 | **Incremental index updates** (add/remove files without full rebuild). | planned |

---

## Testing & Documentation

| # | Description | Status |
|---|---|---|
| 107 | **Test harness**: Node.js test/ directory, 240 tests across 8 files (CLI only). | ongoing |
| 107a | **Test against real index**: When --index-path specified, run comprehensive tests on real data. | **important** |
| 113 | **User documentation** (README/manual). | planned |
| 145 | **Demo commands and starter guide**: Concise set of commands that convince a new user. Candidates: --hotspots 10, --entry-points 10, --func-dupes 10. Port the demo from the Python CLI version and rewrite as a GUI-first starter doc — walkthrough of loading an index and running key features in the browser UI. | **important** |
| 262 | **GUI test strategy**: Define approach for automated GUI testing — endpoint/API tests, browser automation, or structured manual test checklist. Currently no automated GUI tests. | **planned, important** |
| 263 | **Key design decisions documentation**: Review and document key architectural decisions (see `DESIGN_DECISIONS.md` for current list). Ensure rationale is captured for: masking layers, term extraction decoupling, air-gapped-first principle, vocabulary inclusion of comments/strings, etc. | **planned** |
