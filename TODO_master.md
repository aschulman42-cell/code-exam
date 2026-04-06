# Code Exam (Node.js) — Master TODO List
**Updated: 2026-03-07**

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
| 201 | **Interactive /chat (RAG)**: Free-form questions about the codebase. "What file handles structural dupe comparison?" Needs: function/file summaries as context, embedding-based retrieval or keyword search to find relevant code, then LLM synthesis. Could use existing multisect + extract as primitive retrieval, feed results to LLM. See #319 (MCP server) for cloud-LLM path; see #318 (--expand) for vocabulary-assisted term bridging. For air-gapped: local LLM ReAct agent over same tool catalog. | **high priority, design needed** |
| 319 | **MCP server mode**: Expose CodeExam as an MCP (Model Context Protocol) tool server. Run as `node src/index.js --mcp-server --index-path .idx` — communicates via stdio JSON-RPC. Tools: search, multisect, extract, callers, callees, vocabulary, hotspots, file-map, class-tree, etc. **Step 1 (immediate value)**: register in Claude Code/Desktop config, enables Claude to directly query any indexed codebase during conversation. **Step 2 (air-gapped)**: build minimal local MCP client that drives a GGUF model through a ReAct loop over the same tools — the air-gapped equivalent of "ask questions about this codebase." Implementation: ~200-300 lines `src/mcp-server.js` wrapping existing CodeSearchIndex methods as MCP tools. No external deps — MCP is just JSON-RPC over stdio. See #201 (RAG/chat), #318 (--expand). | **high priority, design ready** |
| 202 | **Term extraction independence**: claim.js extractClaimTerms currently uses Claude API only. --term-extract-model flag exists in CLI (for local GGUF) but is not exposed in the GUI. May be replaced with embeddings, small specialized model, or keyword extraction. analyze.js is intentionally decoupled — keep them separate. | **design, in progress** |
| 280 | **Large index loading in GUI**: Chromium index (195K files, 5.3GB literal_index, 2.9GB inverted_index) tested 2026-03-06. **Diagnosed**: (a) Load Index dialog OOM — fixed (lightweight validation). (b) Event-loop blocking — `getCallCounts()` and `findCallers()` scan 5.6M inverted index entries synchronously, blocking all HTTP. (c) Node heap limit — need `NODE_OPTIONS=--max-old-space-size=8192`. (d) Fetch timeouts — added 5-min default. **Still needed**: worker threads for long scans (touches ~4 files: extract scan logic, new worker, server endpoints, GUI progress). Worker threads also essential for #320 (dynamic GUI floating panels — each panel's data loading must be non-blocking). | **high priority, partially fixed** |
| 281 | **Bad/corrupt index detection**: validateIndex() checks for missing/empty required files. "incomplete" badge shown in Indexes accordion and Load Index browser. Load endpoint returns detailed error. Commit 13c547a. | done |

---

## GUI Gaps (features in CLI but not yet in GUI)

| # | Description | Status |
|---|---|---|
| 270 | **Build Index: extension control**: Include/exclude extension fields added to Build Index dialog. Commit 79603e6. | done |
| 271 | **Claim-analyze progress in Analysis pane**: CLI shows `[Step 1/4]` through `[Step 4/4]` with engine names, search summary, match counts. GUI doesn't show this progress. Subsumes #251 (progress appears in wrong pane). | **planned** |
| 252 | **Separate term-extraction engine from analysis engine**: Allow different LLMs for the two claim-analyze steps. **CLI**: add `--term-llm` and `--analyze-llm` flags that override `--engine` for each step independently. **GUI**: add a second engine dropdown or split into "Term Extraction Engine" and "Analysis Engine". | **design needed** |
| 282 | **Scan-extensions in GUI**: CLI has scan-extensions (inventory of file extensions in a directory tree, sorted most-to-least). Expose in GUI near Build Index, so user can see what's in the target directory before building an index. Helps inform #270 extension choices. | **planned** |

---

## GUI UX

| # | Description | Status |
|---|---|---|
| 283 | **Callers: consolidate repetitive output**: Grouped by (caller, file) with expandable call sites showing source snippets. Toggle arrow and "N sites" label expand inline. Commit TBD. | done |
| 284 | **Click-to-function in file view**: Clicking filenames in dupe/struct-diff detail views opens file scrolled to function start line with gold highlight. Commit 13c547a. | done |
| 285 | **Side-by-side dupe comparison**: Implemented — "Compare Side by Side" button in dupe detail opens popup with up to 3 source panes, prev/next for groups with more. Next steps: (a) **diff highlighting** — highlight lines that differ between panes, (b) **synchronized scrolling** — lock scroll positions across panes, (c) **near-dupe threshold review** — some pairs flagged as near-dupes share only structural skeleton, content is quite different. | **done (basic), enhancements planned** |
| 286 | **Export/print from GUI**: Let user save or print contents of GUI panes — lists, analysis results, diagrams. CLI output can be redirected to files, but GUI users will want to save results directly. PDF export or save-as-text. | **planned** |
| 287 | **Settings dialog**: Centralize settings like max-depth, defined-only, and other semi-global options (currently scattered or only available via CLI flags). Menu or dialog accessible from GUI. | **planned** |
| 291 | **Per-pane text search**: Browser Ctrl+F searches the entire page, not individual panes. Add a search button or Ctrl+F override within each pane (especially the source view in middle-bottom) so user can search within one pane's content without wading through the whole screen. | **planned** |
| 292 | **Incomplete index: load behavior**: Loading an incomplete index (missing function_index or inverted_index) currently succeeds silently but searches return 0 results. Either (a) warn user clearly on load that the index is incomplete and searches won't work, with a prompt to rebuild, or (b) auto-trigger rebuild when loading an incomplete index. | **planned** |
| 301 | **Interactive file-map/file-tree diagrams**: Partially done — call-tree nodes are clickable (opens three-pane relationship view: source + diagram + source). File-map nodes clickable (opens file in source pane). File-map edge labels clickable (placeholder — needs new API for per-edge function call details). Remaining: edge detail API, make popup diagram also interactive (currently static). See #320 (floating panels). | **partially done** |
| 302 | **"Show call sites" should push nav history**: In the upper-middle Function Info pane, clicking "Show all sites..." expands call sites in-place but doesn't push to the navigation stack. The ◀ back button should return to the Function Info view from which "Show all sites" was clicked. | **planned, easy** |
| 303 | **GUI console `>file` redirection**: Interactive CLI mode supports `>file` redirection for command output, but the GUI console does not. No security reason to block it — the user already has filesystem access. Should work the same as CLI. | **planned** |
| 304 | **Text-mode file-tree (non-mermaid)**: `/file-tree` currently assumes mermaid output even when `mermaid` is not specified. Add a text-list mode: all file-to-file connections sorted by weight (heaviest first), with option to show specific func→func calls indented underneath each file pair. Useful for programmatic analysis and for codebases too large for mermaid rendering. | **planned** |
| 305 | **`--port` in help/usage + multiple instances**: Document `--port` flag for `server.js` (e.g. `--port 3001`) in help output, with a note that multiple CodeExam instances can run simultaneously on different ports with different indexes. | **planned, easy** |
| 306 | **Regex search: highlight matched portion**: In regex search results, the portion of the line that matched the regex should be highlighted in yellow, not just the whole line shown. Applies to both GUI and CLI (CLI could use ANSI color). | **planned** |
| 315 | **Sync directory across Load Index / Build Index / Indexes accordion**: When user navigates to a directory in Load Index or Build Index, the Indexes accordion in the left pane should switch to show that directory too (and vice versa). Currently each has independent directory state. | **planned** |
| 316 | **Class info in middle panes on click**: Clicking a class name in the Classes accordion unfurls the method sublist but doesn't show class info in the upper/lower middle panes. Should show: class definition source in lower middle pane, and class info (file, line range, inheritance, method count/list) in upper middle pane. Especially important when class has 0 methods — currently gives no feedback at all. | **planned** |
| 320 | **Dynamic GUI: floating panels / windowing system**: Each operation (diagram, comparison, source view, search results, analysis) should be an independent floating panel — draggable, resizable, z-orderable, non-modal. Current full-screen modal popups hide the main UI, preventing interaction (e.g. can't see source pane while diagram is popped out). **Architecture vision**: each panel is a mini-app with its own thread (#280), Find facility (#291), Save As (#286), and independent lifecycle. The MCP chat (#319) would spawn panels dynamically based on what the LLM needs to show. **First step**: convert existing modal overlays to non-modal ~60% floating panels positioned to one side, so main UI stays visible and interactive alongside the popup. Connects to #280 (worker threads — each panel's data loading should be non-blocking), #285 (comparison panels), #301 (interactive diagrams). | **high priority, design in progress** |

---

## Core Search & Analysis

| # | Description | Status |
|---|---|---|
| 8 | **--context-function**: show surrounding function for search hits. Python whitespace scoping is tricky. | planned |
| 141 | **Python import aliasing**: `from os.path import join` — we don't track aliases. | planned |
| 142 | **Implicit class context**: `this.foo()` in Java, `self.method()` in Python — resolution to ClassName.method(). | planned |
| 210 | **Search case sensitivity**: (a) User may want opt-in case-sensitive search; (b) audit code for unintentional case sensitivities in search paths. | **planned** |
| 318 | **`--expand`: vocabulary-assisted term expansion for multisect search**: User searches for "multiple;search;term;single;function" but code calls it "multisect" — a word they'd never guess. `--expand` flag sends user's terms through LLM with codebase vocabulary to suggest additional/replacement terms from the vocabulary that relate to the user's concepts. Same pipeline as claim-search term extraction but starting from user search terms instead of patent claims. Applies to `--multisect-search` and `--multisect-analyze`. **GUI**: add "Expand with vocabulary" checkbox in Claim/Multisect Workspace (alongside existing "No Vocabulary"). Also expose `--vocab-tight` in GUI as a checkbox. | **design needed, important** |
| 321 | **String table**: Extract all string literals (above a minimum length) from the codebase and present as a searchable table. One entry per unique string, with links to the function/class/file(s) it appears in. GUI: new accordion in left pane, filterable (including regex). Foundation for #322-#325. | **planned, high priority** |
| 322 | **String-embedded documentation extraction**: Large string constants (especially template literals) often contain structured documentation — markdown, decision trees, guides. Detect and present these separately as documentation rather than code. Especially valuable for reverse engineering LLM applications where prompts are stored as strings. | **design needed, depends on #321** |
| 323 | **Prompt template detection**: Functions that return `[{ type: "text", text: ... }]` or similar prompt-construction patterns are "prompt-producing functions." Identify and present in a dedicated view. Critical for reverse engineering LLM/agent applications. | **design needed** |
| 324 | **Configuration/constant extraction**: Identify named constants and configuration values (e.g. `gVq = 5, FVq = 30`). Combine with rename system to label them (e.g. `gVq_KW_BATCH_MIN_WORKERS = 5`). Present as a searchable config table. | **design needed, depends on #321** |
| 325 | **Skill/command catalog extraction**: For CLI tools and agent frameworks, extract the command/skill registry — what commands exist, what prompts they produce, how they're wired. Present as a navigable catalog. Generalization of #254b's UI-structure analysis: extract CLI arg parsers, route tables, menu definitions, event handler registrations as a catalog of user-facing actions and the functions wired to them. | **design needed, depends on #323, related to #254b** |
| 326 | **Filter supports regex**: Left-pane filter currently does literal substring matching. Add support for `/regex/` syntax (e.g. `/^get.*Cost$/i`) in the filter bar, applicable to all accordion sections. | **planned** |
| 327 | **Template literal interpolation resolution**: In template strings containing `${expr}`, resolve the interpolated expressions to show what gets substituted. E.g. a prompt template with `${_j}` should link to the definition of `_j` and show its value/rename. Enables understanding of dynamically constructed prompts, SQL queries, HTML templates, etc. | **design needed, depends on #321** |

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
| 293 | **Predictive background LLM summaries**: During idle time in air-gapped operation, have the local LLM produce canned summaries of functions (and possibly classes/files) that CodeExam predicts — based on metrics like hotspots, fan-out, hub scores (#130h, #130i, #254b) — the user will later want to examine. Pre-cache these so analysis results are instant when requested. Extends the "overnight churn" vision in #200. Requires working metrics pipeline first. | **design needed, depends on #200, #130h** |

---

## Security & Air-Gap

| # | Description | Status |
|---|---|---|
| 294 | **Security audit of CodeExam source**: Have Claude Code do a thorough security scan of the codebase, paying particular attention to any risk of the examined codebase leaking out if the user accidentally leaves internet access on during intended air-gapped operation. Check for telemetry, outbound requests in dependencies, DNS leaks, etc. | **important, planned** |
| 295 | **Runtime internet-access detection and warning**: Code should periodically check whether internet access is available and, if it is, prominently warn the user and require affirmative permission to proceed when air-gapped operation was intended. Needs: (a) initial declaration of air-gapped intent — CLI `--air-gapped` flag, (b) GUI first-run dialog or setting to declare air-gapped mode, (c) periodic connectivity probe (e.g. DNS or socket check), (d) prominent banner/modal in GUI and warning in CLI when connectivity detected. | **important, design needed** |
| 300 | **Security scan feature for user codebases**: Non-air-gapped feature — let users run a security-focused analysis of their indexed codebase. Uses existing function extraction + call graph + LLM analysis with security-focused prompts. Components: (a) curated "suspicious call" list from #221 (`eval`, `exec`, `fetch`, `dlopen`, `CreateRemoteThread`, etc.), (b) flag functions containing suspicious calls, (c) trace data flow into dangerous sinks via call graph, (d) feed flagged functions to LLM with security audit prompt, (e) report ranked by severity, (f) **structural hash matching for known-vulnerable patterns**: extend opstrings/funcstrings to generate structural hashes from binary code (port operstrings awk to JS), then match function shapes against a database of known-vulnerable function signatures — a function with the same structural shape as a known CVE target can be flagged even without source-level pattern matching. Leverages #289 (structural hashing beyond dupes) and #296 (.op file correlation). Natural companion to claim-analyze. Requires cloud LLM for best results on the LLM components; structural hash matching works offline. | **design needed, depends on #221, #289, #296** |

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
| 317 | **Dedup-aware metrics**: Hotspots, Domain Functions, Gaps, Entry Points all show separate entries for identical/near-identical functions that exist in multiple files (e.g. `errorResponse` in server.js and service.js). Use structural hashes from `func_hashes.json` to consolidate: show one entry with "also in: file2.js, file3.js" note. Eliminates repetition when index includes old copies or vendored duplicates. | **planned** |
| 296 | **.op file / source-code correlation**: Currently .op files are built from binary executables in the indexed path, each binary treated as a single function. Research: correlate information in .op files with source-code files — use binary-derived info (exported symbols, strings, imports) to identify or annotate source code. Related to #4 (header file handling). | **research, vague** |
| 297 | **Canned .op indexes for major software**: Ship CodeExam with pre-built .op indexes for major platforms (Windows, iOS, Android, etc.). Once multi-index loading and cross-index comparison are working, use these to identify/annotate functions in the user's codebase that call into or resemble platform APIs. Possible copyright concern with distributing platform-derived indexes — needs legal review. Depends on #296, #132. | **research, vague, legal review needed** |
| 298 | **Open-source provenance detection**: Similar to #297 but for major open-source projects. Use canned indexes of well-known OSS to identify open-source provenance of functions in the codebase and surface diffs representing vendor changes. Combines structural hashing (#289) with cross-index comparison (#132). Valuable for litigation — shows what's stock OSS vs. custom. | **research, vague, depends on #289, #132** |

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
| 128 | **--use-tree-sitter broken for *.py** (0 functions). Regex fallback works. Tree-sitter import fixed to use `createRequire` (commit 79603e6) so it resolves from package dir, not cwd. Python issue may still exist. | diagnostic added, import fixed |
| 290 | **Additional language parsers**: Add tree-sitter/regex hybrid support for Dart, R, Groovy, Haskell. Investigate whether CoffeeScript (.coffee) and Handlebars (.hbs) need separate handling or fall through to existing parsers. | **planned** |
| 307 | **Include .html/.htm in default extensions**: Currently requires `--extensions htm,html` to index HTML files. CodeExam already finds functions inside `<script>` tags and identifies non-function code as "(file scope)". HTML should be in DEFAULT_EXTENSIONS. Also verify the GUI Build Index dialog respects this. | **planned, easy** |
| 308 | **CSS indexing and cross-file correlation**: CSS files load in CLI without `--extensions` but not in GUI Build Index. Investigate: (a) CSS doesn't contain function definitions, but can it reference JS functions (e.g. in `url()`, custom properties, or animation names)? (b) Test loading CSS alongside JS and check whether any CSS→JS references get correlated in callers/call graph. (c) Ensure GUI Build Index includes CSS if CLI does. | **research** |
| 309 | **False function-name highlighting in HTML/CSS**: CSS files: skip linkification entirely. HTML files: only linkify inside `<script>` blocks. Commit e0bb544. | done |
| 310 | **HTML↔JS ID cross-referencing**: In HTML files, element IDs (e.g. `id="fs-save-png"`) should be correlated with JS references to those IDs (e.g. `$('#fs-save-png')`). Show the connection in callers/callees or a new "references" view. | **design needed** |
| 311 | **Event-driven function call detection**: Added regex for `addEventListener`/`.on()`/`.once()` with named handler callbacks in both `findCallees()` (call_type `event-handler`) and `getCallCounts()`. Arrow callbacks like `() => doSomething()` — the inner call is already caught by existing patterns. Commit e0bb544. Remaining: audit Entry Points/Gaps implications, jQuery `.on()` with object syntax. | **partially done** |
| 312 | **CSS class ↔ JS correlation**: CSS class selectors (e.g. `.src-fn-link { ... }`) should be correlated with JS that references them (e.g. `span.className = 'src-fn-link'`). This is a cross-language string-based reference, not a function call, but valuable for understanding UI wiring. Related to #310 (HTML↔JS IDs). | **design needed** |
| 313 | **Minified JS: prettifier/deobfuscator**: js-beautify integrated — detects `.min.js` or JS/CSS with very long avg lines, prettifies before indexing. Commit e0bb544. Deobfuscation research: **webcrack** (npm, JS-native, webpack bundles), **wakaru** (JS-native), or local LLM for name recovery (#200/#293). | **done (js-beautify), research (deobfuscation)** |

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
| 314 | **Tests: add missing `await` on `buildIndex()` calls**: Several tests call `index.buildIndex()` without `await`. Works today because buildIndex is effectively synchronous, but any real `await` inside it (e.g. dynamic import) breaks the tests. Latent bug. | **planned, easy** |

---

## Branding & Naming

| # | Description | Status |
|---|---|---|
| 299 | **Rename CodeExam to CodeClaim (CodeClaim.ai)**: Likely product name change. Scope: repo name, package.json, CLI command name, GUI title/branding, documentation, README, all user-facing strings. Domain: CodeClaim.ai. | **planned, pending decision** |
