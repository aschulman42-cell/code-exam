# Code Exam (Node.js) — Master TODO List
**Updated: 2026-02-22**
**Current state: Phase 8b complete, 240 tests passing**

---

## Ongoing

| # | Description | Status |
|---|---|---|
| 150 | **TODO maintenance**: Update this file at end of each session. Review conversation for items discussed but not captured. | **ongoing** |

---

## Phase Status (Node.js Port)

| Phase | Description | Status |
|---|---|---|
| 1 | Core: build-index, search, literal, fast, regex, extract, list-functions, stats | ✅ done |
| 2 | Callers/callees, call-tree, file-map, file-tree, most-called | ✅ done |
| 3 | Metrics: hotspots, hot-folders, entry-points, gaps, domain-fns, classes, vocabulary, multisect | ✅ done |
| 4 | Dedup: dupefiles, func-dupes, near-dupes, struct-dupes, struct-diff | ✅ done |
| 5 | Interactive REPL: all commands, /set, redirect, shell escape | ✅ done |
| 6 | Large index: streaming JSON, on-disk inverted index | ✅ done |
| 8a | Claim search: LLM term extraction from patent claim text → multisect | ✅ done |
| 8b | LLM analysis: --analyze, --claim-analyze, --multisect-analyze, --file-analyze, SimpleMasker L1+L2 | ✅ done |

---

## Recently Completed (this session, 2026-02-22)

- **Phase 8b**: analyze.js — AnalysisLLM (Claude API + local GGUF via node-llama-cpp), SimpleMasker (comments + strings), 4 prompt builders, 4 analysis handlers, 44 new tests
- **(global) filter bug**: multisect sort put 0-line (global) entries first; claim-analyze and multisect-analyze now filter these out
- **--usage** recognized (alias for --help)
- **--exclude-extensions**: new arg for index building (e.g. `--exclude-extensions .xml,.html`)
- **/functions respects /set max**: was hardcoded at 50, now uses maxResults
- **Interactive prompt shows index name**: `.spinellis code-exam>` instead of `code-exam>`
- **Vocabulary includes comments/strings**: domain terms appear in JSDoc, docstrings, SQL, error messages — stripping them lost valuable signal
- **Help text reorganized**: --exclude-tests moved to "DISPLAY / FILTERING" with clarified scope
- **3 Phase 8a pending fixes**: (1) temperature tip only shown when temp>0, (2) --show-prompt writes to stderr, (3) `temp=` option in interactive /claim
- **--claim-model / --term-extract-model**: Local GGUF model for air-gapped term extraction now functional. Separate from --analyze-model. Works in both /claim and /claim-analyze.
- **Fixed /claim-analyze always using Claude for analysis**: `use_claude: _cliArgs.use_claude || true` was always true — fixed to `!!_cliArgs.use_claude`
- **claim-analyze progress feedback**: [Step 1/4] through [Step 4/4] with engine names, search summary, match counts

---

## High Priority — Near Term

| # | Description | Status |
|---|---|---|
| 200 | **Local LLM for /analyze**: Must work on air-gapped systems. --use-claude is verboten in litigation context. Need: (a) test with deepseek-coder-6.7b-instruct Q4_K_M and larger models, (b) measure quality vs speed tradeoffs, (c) optimize prompts for smaller context windows. node-llama-cpp integration is stubbed but untested. | **high priority** |
| 201 | **Interactive /chat (RAG)**: Free-form questions about the codebase. "What file handles structural dupe comparison?" "How is vocabulary built?" Needs: function/file summaries as context, embedding-based retrieval or keyword search to find relevant code, then LLM synthesis. Could use existing multisect + extract as primitive retrieval, feed results to LLM. | **high priority, design needed** |
| 202 | **Term extraction independence**: claim.js's extractClaimTerms currently uses Claude API only. May be replaced with embeddings, small specialized model, or keyword extraction. analyze.js is intentionally decoupled — keep them separate. | **design, in progress** |

---

## Core Search & Analysis

| # | Description | Status |
|---|---|---|
| 8 | **--context-function**: show surrounding function for search hits. Python whitespace scoping is tricky. | planned |
| 141 | **Python import aliasing**: `from os.path import join` — we don't track aliases. | planned |
| 142 | **Implicit class context**: `this.foo()` in Java, `self.method()` in Python — resolution to ClassName.method(). | planned |
| 210 | **Interactive search case sensitivity**: User reported bare search (non-/cmd) returning case-sensitive results. Could not reproduce — searchLiteral/searchHybrid both default to caseSensitive=false. Keep an eye out for repro case. | **watch** |

---

## Unresolved Symbols & Call Graph

| # | Description | Status |
|---|---|---|
| 220 | **Unresolved callee table**: Currently `--callees` and `--call-tree` silently skip any call target not in the function index. Should build a table of all call targets including unresolved ones (library calls like printf, API calls, etc.). Analogous to disassembler symbol table for jump/call targets. Would enable: "What external APIs does this code use?", library dependency mapping, integration point discovery. | **new, important** |
| 221 | **"Unusual opcode" equivalent**: Certain function calls or patterns are revealing — `mmap`, `dlopen`, `CreateRemoteThread`, `eval`, `exec`. Curated list of "interesting" calls whose presence is noteworthy regardless of whether they're in the index. Related to magic numbers (#123e). | **new, design needed** |
| 222 | **Magic number dictionary**: Don't normalize known constants in structural hashing (0xCAFEBABE=Java class, 0x5A827999=SHA, etc.). When someone searches for "Java class file" or "JVM bytecode", point to functions containing 0xCAFEBABE. Requires magic_constants.dat file. From old TODO #123e. | **planned** |
| 2 | **Module/file-level call graphs**. | design needed |
| 4 | **Header file handling**: .h declarations to annotate --extract output. | design needed |
| 126 | **Show callers/callees as comments in --extract output** (opt-in). | design needed |

---

## LLM Analysis (Phase 8b+)

| # | Description | Status |
|---|---|---|
| 230 | **SimpleMasker Layer 3**: Full identifier masking (FUNC_N, PARAM_N, VAR_N, CALL_N). Ported from Python's ~400 lines of regex patterns. Deferred — even Python's --mask-all leaves hints. | **deferred** |
| 231 | **Combined two-function analysis**: When multisect returns 2 functions ≤300 lines total, send both in one LLM call for relationship analysis. Python has _do_multisect_combined. Structure already supports arrays — don't make this harder to add later. | **deferred, easy** |
| 232 | **--claim-model / --term-extract-model for local term extraction**: Local GGUF model for air-gapped term extraction (separate from --analyze-model). Combines system prompt + claim text into single prompt for local model. | ✅ done |
| 233 | **Prompt optimization for local models**: Local 7B models have limited context and instruction-following. May need shorter prompts, fewer numbered instructions, simpler output format. Test and iterate. | **research** |

---

## Discovery & Metrics

| # | Description | Status |
|---|---|---|
| 130e | **--hot-folders --depth N**: top-level overview. | planned |
| 130f | **Library detection/filtering**: auto-detect com/google, org/apache paths. Offer --exclude-libs. | planned |
| 130h | **Fan-out/fan-in metrics**: orchestrators (high fan-out), integration points. See [^130h]. | planned |
| 130i | **PageRank-style / Hub Functions scoring**: See [^130i]. | research |
| 131a | **Non-function ID extraction**: struct defs, global vars, script-heavy languages. | design needed |
| 250 | **Remove special-case command dispatch from interactive.js**: Currently `dispatchCommand()` has a large if/else chain that special-cases every slash command (`/fast`, `/callers`, `/hotspots`, etc.) with its own argument parsing before calling the shared `do*()` handlers. Refactor so that all commands flow through a unified dispatch table — map command names to their `do*()` handler + a declarative arg spec — eliminating the per-command parsing boilerplate. All interactive commands should go through `doInteractive()` with no special-case branches. | **planned** |
| 240 | **Multisect cross-method class scope**: Currently multisect scopes are function → file → folder. Add intermediate scope: multiple methods in a single class. If terms are spread across methods of one class, that's a tighter match than "spread across a file." Requires class membership data from function index. | **new, planned** |
| 241 | **Per-term mandatory/optional flag in multisect**: Currently all positive terms are equally required (subject to --min-terms). Allow specifying which terms are optional — their presence boosts ranking but their absence doesn't disqualify. Syntax TBD, e.g. `?term` or `OPT term` prefix. Would interact with --min-terms scoring. | **new, design needed** |
| 251 | **Claim-analyze progress should show in Analysis pane, not middle-top**: When running claim-analyze from the workspace, "Extracting claim terms via local…" appears in the middle-upper pane while the old analysis result stays in the Analysis pane. The progress indicator should appear in the Analysis pane instead, since that's where the result will land. | **new, planned** |
| 252 | **Separate term-extraction engine from analysis engine**: Allow different LLMs for the two claim-analyze steps: (1) extracting TIGHT/BROAD terms from claim text, (2) analyzing the matched function against the claim. Useful for testing local models on analysis while using Claude for better term extraction. **CLI first** (easier): add `--term-llm` and `--analyze-llm` flags that override `--engine` for each step independently. **GUI later**: add a second engine dropdown or split the existing one into "Term Extraction Engine" and "Analysis Engine". | **new, design needed** |
| 253 | **Class inheritance visualization**: ✅ Implemented 2026-03-04. CLI `--class-tree`, interactive `/class-tree`, GUI accordion. Mermaid classDiagram output. See commit 3326d68. | ✅ done |
| 254b | **"What should I look at first?" — orienting new users**: See [^254b]. | **research, important** |

[^130h]: **Fan-out/fan-in metrics** — Functions with high fan-out (call many diverse in-index functions) are likely orchestrators / control centers. Even if called only once, a function that calls `buildIndex`, `parseFunctions`, `writeInvertedIndex`, and `buildFunctionIndex` is clearly coordinating something important. Score: `fan_out × log(fan_in + 1)` finds the sweet spot between "calls lots of things" and "is itself called by several things." Functions that appear as intermediate nodes in many call trees (not leaves, not roots) are the connective tissue. Data available via `findCallees` (fan-out) and `findCallers` (fan-in).

[^130i]: **PageRank-style / Hub Functions scoring** — Current metrics all fail to surface what's semantically important: Most Called is swamped by stdlib (`slice`, `push`, `trim`). Even with `--defined-only`, utility functions (`errorResponse`, `jsonResponse`) dominate. Hotspots weights by size × calls but still catches plumbing. Domain Functions uses TF-IDF naming rarity but that's about naming, not structural importance. What's needed: recursive importance scoring where a function's importance is boosted by the importance of its callers (PageRank on the call graph). The data exists in `getCallInventory`'s in-index caller lists — needs iterative scoring over that graph. Key insight: frequency-based metrics find plumbing; structural-centrality metrics find architecture.

[^254b]: **"What should I look at first?"** — The goal: when a user opens an index of unfamiliar code, surface the 5-10 functions/classes that a senior engineer would tell a new team member to read first. Current approaches and why they fall short: (1) Most Called — swamped by external/stdlib. (2) Most Called --defined-only — surfaces utility functions, not domain logic. (3) Hotspots — same problem, weighted by size. (4) Domain Functions — TF-IDF on naming is about rarity, not importance. (5) Vocabulary — good for learning nomenclature but doesn't point to specific code. Two promising new angles: **(a) Fan-out scoring**: functions that call many diverse in-index targets are orchestrators (see #130h). **(b) UI-structure analysis**: look at the UI definition layer (HTML templates, route tables, CLI arg parsers, menu definitions, event handlers) to extract the "vocabulary of user-facing actions." These are curated by humans and represent intentional feature boundaries. The functions wired to UI elements are likely entry points into important domain logic. This is analogous to looking at a Windows resource file to understand what a program does. For web apps: route handlers; for CLI tools: argparse options; for GUI apps: menu items and dialog handlers. Could be implemented as a heuristic that identifies UI-definition patterns and boosts the importance of functions referenced from them.

---

## Dedup & Signatures

| # | Description | Status |
|---|---|---|
| 123e | **Magic number preservation** in structural hashing. See also #222. | planned |
| 124 | **Code comparison**: diff two codebases using funchashes. | design needed |
| 132 | **Index comparison / version diff**: diff two indices. "In v54→v55: do_hotspots() added, main() reduced 75%". | **important, design needed** |

---

## Function Index Quality

| # | Description | Status |
|---|---|---|
| 110 | **Partial path matching**: needs consistency audit across all commands. | needs audit |
| 120 | **Header declarations parsed as definitions** (huge false positives in .h). | important |
| 121 | **--most-called macro/type false positives** (STDMETHOD, HRESULT, ULONG). | important |
| 128 | **--use-tree-sitter broken for *.py** (0 functions). Regex fallback works. | diagnostic added |

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
| 107 | **Test harness**: Node.js test/ directory, 240 tests across 8 files. | ✅ ongoing |
| 107a | **Test against real index**: When --index-path specified, run comprehensive tests on real data. | **important** |
| 113 | **User documentation** (README/manual). | planned |
| 145 | **Demo commands**: 3 commands that convince a new user. Candidates: --hotspots 10, --entry-points 10, --func-dupes 10. | **important** |

---

## GUI & Integration

| # | Description | Status |
|---|---|---|
| 13 | **GUI**: Air-gapped, local Python/Node server + browser UI on localhost. | design needed |
| 15 | Multi-file split and GitHub integration. | deferred |
| 254 | **Build Index from GUI**: ✅ Done 2026-03-03. Build Index dialog + Rebuild button in Load Index dialog. Tree-sitter hybrid enabled by default for rebuilds. | ✅ done |
| 255 | **Language parsers added**: Swift, Kotlin, Scala, Lua, Objective-C (2026-03-04). | ✅ done |
| 256 | **GUI accordion additions**: Extensions, Call Inventory, Class Hierarchy sections. Most Called "In-index only" toggle. Console /help updated with all commands. (2026-03-04). | ✅ done |

---

## Key Design Decisions (Reference)

- **Term extraction ≠ analysis LLM**: claim.js extractClaimTerms may later use embeddings/small model instead of Claude. Keep decoupled from analyze.js's AnalysisLLM.
- **Vocabulary includes comments/strings**: Domain terms appear in JSDoc, docstrings, SQL queries, error messages. The stopword filter and frequency cutoffs handle generic words.
- **(global) scope entries**: Exist in multisect results but filtered out before LLM analysis (0 lines, not extractable).
- **SimpleMasker layers**: L1 (comments) + L2 (strings) shipped. L3 (identifiers) deferred — diminishing returns vs complexity.
- **Air-gapped first**: All features must work without network. --use-claude is a convenience for development/testing, not the target deployment.

---

## Completed Summary (Node.js Port)

| Phase | Test Count | Key Features |
|-------|-----------|--------------|
| 1 (basic) | 16 | Index build, search, extract, list-functions |
| 2 | 16 | Callers, callees, call-tree, file-map |
| 3 | 23 | Hotspots, entry-points, vocabulary, multisect |
| 4 | 55 | Dupefiles, func-dupes, struct-dupes, struct-diff |
| 5 | 25 | Interactive REPL |
| 6 | 40 | Streaming JSON, large index support |
| 8a | 21 | Claim search (LLM term extraction) |
| 8b | 44 | LLM analysis (analyze, claim-analyze, masker) |
| **Total** | **240** | |

---

## Key Insights from Testing

### Spinellis Java Codebase (via --claim-analyze)
- **claim-analyze pipeline validated**: pseudo claim "The method of http request and response, using a servlet and a cookie" correctly found AuthenticatorBase::register and CookieExample::doGet, Claude produced element-by-element coverage analysis
- **(global) bug found and fixed**: multisect sort by lines put 0-line globals first; filtered before LLM extraction

### Self-Analysis (code-exam Node.js source)
- **/analyze with --use-claude works well** for understanding unfamiliar code
- **User wants /chat RAG**: free-form questions like "What file handles structural dupe comparison?" — current /analyze requires knowing the function name already
- **Vocabulary signal improved** by including comments/strings — domain terms in JSDoc/SQL were being lost

### Local LLM Testing (2026-02-22)
- **Qwen2.5-Coder 7B Q4_K_M**: Best 7B model tested. Structured output, correct algorithmic identification, 32K native context. ~2 min for 14-line function on constrained laptop, ~2 min for 287-line function. Usable for air-gapped deployment.
- **DeepSeek-Coder 6.7B Q4_K_M**: Narrates line-by-line, verbose, occasionally overstates (called data reorganization "hashing-based algorithm"). ~5 min per analysis.
- **CodeLlama 7B/13B**: Weakest. 13B didn't meaningfully improve over 7B. Superseded by all newer models.
- **LLM overstatement is persistent concern**: All models (including Claude) tend to infer purpose from identifier/comment names rather than from actual operations. `_buildFileDupeLookup` doesn't hash anything but models say "hash-based deduplication." Masking would help but Layer 3 (identifier masking) is deferred.
- **Argparse false positives in claim-analyze**: Argument parser functions match many terms because they *describe* features without *implementing* them. May need heuristic to deprioritize argparse/config functions, or user needs to learn to use `--exclude-path` for these.
- **Context size is the key constraint**: 4096 tokens on constrained hardware; 8192 failed for DeepSeek. Qwen's 32K native context is transformative — need better hardware to exploit it.
