# CodeExam source map

A one-line tour of every first-party source file in the repo — what it is,
where to look, and what to read first. Ordered roughly from the outside in:
launchers, then the CLI core, then commands, engines, GUI, dev scripts, tests.

This file is also machine-read: `scripts/add-license-headers.js` parses the
`` - `path` — description `` bullets below to fill each file's license-header
description line. Keep that exact bullet shape (backticked repo-relative path,
an em dash, one line); a file missing from this map gets a header with no
description rather than a guessed one.

Not covered here: vendored code (`public/vendor/`), grammars, sample corpora,
and data catalogs — those are not first-party source.

## Launchers

- `ce` — POSIX shim running `node src/index.js` with CODEEXAM_INVOKED_AS=ce so help echoes the short name
- `ce.bat` — Windows shim: sets CODEEXAM_INVOKED_AS=ce, then runs node src\index.js
- `CodeExam` — POSIX shim identical to `ce` but sets CODEEXAM_INVOKED_AS=CodeExam for long-form help
- `CodeExam.bat` — Windows counterpart to `CodeExam`; sets CODEEXAM_INVOKED_AS=CodeExam, runs src\index.js

## src — entry points and shared plumbing

- `src/index.js` — CLI entry point: parses argv, loads the index, dispatches every command; handles --gui/--mcp/--multi-index
- `src/argparse.js` — declarative CLI flag table plus parser, deprecation and typo hints; sole source of --help text
- `src/server.js` — GUI HTTP server: /api JSON routes over loaded indexes, index building, LLM chat and AI overview
- `src/mcp-server.js` — MCP stdio server exposing 27 index-query tools (search, callers, digest, overview) to MCP clients
- `src/archive.js` — expands ZIP/TAR/GZIP/HAR archives in memory (nested, depth-capped) for --build-index; zip-bomb guards
- `src/binstrings.js` — extracts printable strings from binaries into indexable .op pseudo-source; C++ demangling optional
- `src/build-worker.js` — worker thread that runs CodeSearchIndex.buildIndex off the main loop, streaming progress to the parent
- `src/glob.js` — zero-dep glob expander over Node fs supporting `*`, `**`, and `?` for file discovery
- `src/json-stream.js` — streaming byte-level JSON object parser that reads >2GB index files via chunked fd reads
- `src/utils.js` — shared SearchResult class, path/name display helpers, and the extension sets that gate indexing
- `src/version.js` — SERVER_BUILD restart canary plus CE_VERSION read from package.json for provenance headers
- `src/extractors/bun.js` — decodes `bun build --compile` standalone binaries, recovering embedded JS modules (PE-cert aware)

## src/commands — one module per CLI surface

- `src/commands/analyze.js` — runs --analyze / --claim-analyze / --multisect-analyze / --file-analyze: prompts, masking, LLM calls
- `src/commands/browse.js` — index browsing: stats, list/show files, list functions, extract, bundle seams, extension census
- `src/commands/build_fp_renames.js` — writes _FP_ display renames into rename_map.json for cross-source fingerprint matches above a threshold
- `src/commands/callers.js` — --callers/--callees/--most-called/--call-inventory over the index's call graph, with depth and filters
- `src/commands/census.js` — --census-imports: ranks Python import targets across one index or a whole multi-index corpus
- `src/commands/claim.js` — --claim-search: LLM extraction of TIGHT/BROAD multisect terms from claim prose, then runs both searches
- `src/commands/claim-chart.js` — builds one-row-per-element claim charts merged across targets; CE owns structure, model fills cells
- `src/commands/claim-locate.js` — proposes symbols from a claim, verifies them against the index, navigates callees, emits targets
- `src/commands/claims-loop.js` — fills pseudo-claim chart cells from anchors and measures draft-vs-retrieval agreement; flags redrafts
- `src/commands/dedup.js` — duplicate reporting: file SHA1, function, near, structural, and string-call fingerprint families
- `src/commands/digest.js` — --digest / --comments-only: renders mechanical function, class, and file digests with no interpretation
- `src/commands/exports.js` — --exports: tier-marked, definition-resolved export catalog per package; --emit-catalog writes it as JSON
- `src/commands/extract_js_from_binary.js` — dispatches a native binary to its bundler-specific JS extractor (Bun today) and prints the result
- `src/commands/fingerprint.js` — builds string+call-name fingerprints per function (hash and Jaccard) for bundling-resistant matching
- `src/commands/graph.js` — --call-tree/--class-tree/--file-map/--file-tree renderers, with Mermaid diagram output
- `src/commands/harness.js` — emits a runnable PyTorch forward-hook activation-capture script from static nn.Module analysis
- `src/commands/imports.js` — --imports resolves imports against a serialized export catalog; --bom emits the dependency bill of materials
- `src/commands/imports-from.js` — --imports-from: joins this index's imports against a second index's exports (resolved/private/not-found)
- `src/commands/infrastructure.js` — --infrastructure: prints detected Containers/Kubernetes/IaC/CI-CD artifacts, marking heuristic hits
- `src/commands/inspect_binary.js` — terse per-binary report of format, signing, framework, and embedded source hints before deeper extraction
- `src/commands/interactive.js` — REPL that keeps the index resident and dispatches slash-commands to the same do*() handlers as the CLI
- `src/commands/metrics.js` — discovery metrics plus the AI/ML inventory family: hotspots, entry points, gaps, classes, vocabulary, models
- `src/commands/multisect.js` — multi-term intersection search: parses term syntax, scores by IDF, ranks function/file/folder scopes
- `src/commands/prompts.js` — --prompt-catalog: finds LLM prompt strings by confidence-ranked heuristics and emits them untruncated
- `src/commands/pseudo-claims.js` — drafts illustrative pseudo-claims from anchor-function evidence packs, with grounding and fixed caveats
- `src/commands/search.js` — --search/--literal/--fast/--regex/--files-search/--folders-search plus rename-marker query expansion
- `src/commands/synonymize.js` — rewrites claim wording away from a codebase's identifiers to manufacture a retrieval gap; never reads an index

## src/core — the engine room

- `src/core/CodeSearchIndex.js` — core index class: builds/saves/loads indexes, parses functions/classes, serves literal/inverted/regex search
- `src/core/CSI-helpers.js` — deobfuscates minified JS, infers opaque names, scans string/comment state, classifies command gates
- `src/core/TreeSitterParser.js` — WASM tree-sitter extraction for 11 grammars, with binary sniffing, a size cap and a per-parse timeout
- `src/core/ai-ml-detectors.js` — 17 AI/ML detector methods (models, kernels, training, LLM calls, chains…) mixed onto the index prototype
- `src/core/ai-overview.js` — agentic prose orientation: drives Claude/OpenAI/Gemini over CE's own MCP tools and sums per-turn cost
- `src/core/ai-overview-local.js` — runs the AI overview on a local GGUF via node-llama-cpp tool-calling, with tool-floor and refusal guards
- `src/core/air-gapped.js` — enforces --air-gapped: blocks cloud calls, scrubs API keys, probes connectivity, emits the disclaimer
- `src/core/answer-disclosure.js` — appends a post-hoc note stating what a declining answer actually searched, rather than scoring refusals
- `src/core/breadcrumbs-commands.js` — extracts telemetry breadcrumbs and the CLI/route/GUI-action command catalog from indexed lines
- `src/core/bundle-seam-detection.js` — detects esbuild module-wrapper seams in minified bundles and recovers per-module names and previews
- `src/core/calls.js` — call-graph engine: resolves callees, finds callers, builds call inventories and per-name call counts
- `src/core/canonical-funcs.js` — groups identical function hashes and picks a canonical representative (shortest path) per group
- `src/core/claim-class.js` — picks a pseudo-claim's statutory class (method vs system) by a stated word-list rule, with its reason
- `src/core/claim-genericity.js` — scores a claim element generic-bookend vs mechanism via I/O-verb shape and corpus word frequency
- `src/core/claim-terms.js` — shared claim tokenizer: stop list, acronym rule, stemmer, and TF-IDF pick of distinctive claim words
- `src/core/client-server.js` — detects declared HTTP routes and client calls, then reconciles them to flag missing server code
- `src/core/credential-mask.js` — masks credential values in tool output while keeping file, line and identifier visible
- `src/core/data-structs.js` — finds struct/enum/union/typedef/interface/record definitions per language and ranks them by references
- `src/core/dep-claim-rules.js` — 13 awk-derived plus 5 new named patterns that read one claim's dependency and parent number
- `src/core/dep-claims.js` — resolves a claim set's dependency graph: depth, parent policy, contribution kind, and a residue report
- `src/core/distance-helpers.js` — name-token, Jaccard, directory-prefix and file-extension distance functions for dupe/peer scoring
- `src/core/exports.js` — reads a Python package's declared API (__all__, export decorators, __init__ re-exports) into A/B/C tiers
- `src/core/extension-census.js` — unions archive-internal and on-disk skips into the "present but not indexed" extension report
- `src/core/filter-match.js` — one predicate for GUI/CLI filters: substring by default, /pattern/flags for opt-in regex
- `src/core/funcstr-corpus.js` — loads external funcstr-hash dumps as a DF corpus, labeling functions common / rare-shared / novel
- `src/core/hotspots.js` — ranks important functions, entry points, domain functions and classes, skipping vendored/minified noise
- `src/core/import-join.js` — joins one index's imports to another's export catalog, verdicting resolved / private / not-found
- `src/core/imports.js` — per-language import extractor (Py/JS/C/Java/C#) classifying rows internal/stdlib/third-party/vendored
- `src/core/llm-runner.js` — resolves cloud/GGUF model descriptors and runs the calls, with cost gates, truncation tracking and provenance
- `src/core/loop-score.js` — scores a blind claim chart against drafted anchors: recall, mechanism PRESENT, control FPs, dependent grades
- `src/core/mechanism-grouper.js` — clusters index functions into candidate mechanism groups from token, class, file and command seeds
- `src/core/mechanism-ranker.js` — one comparative LLM pass assigning each candidate group a bounded exploration-priority verdict
- `src/core/multisect.js` — two-phase multi-term intersection search, with per-term file counts and comment-vs-code match weighting
- `src/core/openai-util.js` — OpenAI-shape helpers: reasoning budget floor, temperature gating, usage/text/finish-reason readers
- `src/core/overview.js` — builds and renders the fast+deep orientation summary: counts, structure, vocabulary, key files, entry points
- `src/core/pricing.js` — per-1M rate table for Claude/OpenAI/Gemini plus the USD cost estimator every AI surface shares
- `src/core/provenance.js` — builds the print-out provenance banner (version, index, command, AI engine) and masks secrets in argv
- `src/core/providers.js` — cloud-LLM registry (Claude/OpenAI/Gemini) with a resolver that defaults deliberately and fails loud
- `src/core/pseudo-claim-triage.js` — deterministic KEEP/REVIEW/DROP first cut over a run's pseudo-claims, each verdict carrying its reasons
- `src/core/ranker-eval.js` — dev harness scoring candidate orderings and group purity: tie-aware Spearman, recall@k, GT matching
- `src/core/referenced-resources.js` — aggregates the external surface: env vars, URLs, paths, subprocess commands, cloud config, model IDs
- `src/core/rename.js` — persists and applies the display-name rename map, and infers names for opaque minified identifiers
- `src/core/stack-detectors.js` — detects the ops stack (Containers, Kubernetes, IaC, Cloud, CI/CD), tagging hits mechanical or heuristic
- `src/core/structural-fingerprint.js` — normalizes function bodies to funcstrings, hashes them exact/tight, and diffs near-dupes by word holes
- `src/core/symbol-verify.js` — verifies a model's proposed symbol names against the index and navigates one hop from survivors
- `src/core/vocabulary.js` — TF-IDF vocabulary discovery with noise-doc exclusion, concept extraction, and LLM-prompt formatting

## public — the GUI client

- `public/index.html` — single-page shell: menu bar, three panes, accordion sections, and all modals/overlays
- `public/app.js` — GUI orchestrator: accordion loading, click wiring, workspace, LLM analysis, Chat tab, boot
- `public/api.js` — fetch wrappers for every /api/* endpoint; 5-min default timeout, 10-min for index loads
- `public/click-handlers.js` — routes function/file/class/vocab row clicks to fetches and middle-pane renderers
- `public/console.js` — right-bottom tab switching plus the in-GUI REPL running CLI commands via /api/exec
- `public/context-menu.js` — right-click menu for symbols/files, plus LLM engine status and availability gating
- `public/dialogs.js` — modal dialogs: Load Index, Build Index, Search, Confirm, and the GGUF model browser
- `public/dom-utils.js` — dependency-free DOM helpers, path/name formatters, and search-highlight utilities
- `public/layout.js` — pane show/hide, column and split resizers, left-pane filter, find-in-pane, Window menu
- `public/list-renderers.js` — left-pane structural lists — functions, files, classes, dupes, AI/ML groups
- `public/menu-bar.js` — top dropdown menus and their action dispatch, plus the README popup and tour engine
- `public/mermaid.js` — renders Mermaid diagrams in the right-top pane: zoom, SVG/PNG export, Relationship View
- `public/middle-pane.js` — middle-pane chrome (loading, nav history) and its result renderers, incl. multisect
- `public/overlays.js` — non-modal floating panels: side-by-side compare and the extraction-prompt viewer
- `public/prompts-and-catalog.js` — lists+details for Prompts, Breadcrumbs, Bundle Seams, Catalog, Struct Diffs
- `public/source-viewer.js` — renders function/file source in the middle-bottom pane and linkifies call sites
- `public/state.js` — the single shared mutable state object passed by reference across every GUI module
- `public/style.css` — the GUI's dark IDE theme: CSS variables, three-pane layout, accordions, dialogs, tour
- `public/tours.js` — pure-data guided-tour step definitions shared by the GUI spotlight and `ce --tour`
- `public/app_OLD.js` — dead single-file GUI snapshot from before the module peel; unreferenced
- `public/app_OLD2.js` — second dead single-file GUI snapshot, slightly newer than app_OLD.js; unreferenced
- `public/style_OLD.css` — dead earlier copy of the theme; nothing links to it

## scripts — dev and evaluation harnesses

- `scripts/add-license-headers.js` — idempotent Apache-2.0 header inserter; reads this file for per-file descriptions
- `scripts/anchor-recall.mjs` — scores claim-search recall against saved anchors on CE's four-rung ladder
- `scripts/build-claim-genre-df.mjs` — builds the content-word document-frequency JSON for the genericity score
- `scripts/build-exe.js` — compiles the standalone Windows exe via `bun --compile`, staging grammars into dist/
- `scripts/check-app-loads.mjs` — smoke test that evaluates app.js's module graph under DOM stubs
- `scripts/claim-ballpark.mjs` — ranks which index best matches each claim via multisect hits; no model calls
- `scripts/claim-locate-stability.mjs` — measures run-to-run repeatability of --claim-locate targets
- `scripts/claim-selftest.mjs` — deterministic offline retrieval regression score against curated anchors
- `scripts/engine-qualify.mjs` — pass/fails an engine on pinned negative+positive chart sidecars; no model calls
- `scripts/hunt-repeat.mjs` — reruns one --claim-locate --hunt command N times and reports the distribution
- `scripts/litigated-claims-fetch.mjs` — fetches litigated US patents' claim 1 + dependents from Google Patents
- `scripts/pseudo-claim-loop.mjs` — runs the pseudo-claim loop: synonymize, chart blind, score vs answer key
- `scripts/rank-eval.mjs` — scores a candidate ordering against tiered ground truth (Spearman, recall@k, purity)
- `scripts/splitter-compare.mjs` — prints CE's claim-element split beside the attorney's rows for one patent

## test — the suite (node:test, `npm test`)

- `test/test_ai_ml_self_detect.js` — AI/ML detectors: a pattern-table line is not a framework instance (#227)
- `test/test_air_gapped.js` — air-gap guard: flag state, assertLocalOnly gate, API-key scrub, disclaimer content
- `test/test_anchor_recall.js` — anchor-recall scorer: output parsing, four-rung tier ladder, gap accounting
- `test/test_answer_disclosure.js` — refusal detection and disclosure notes over 11 verbatim local-model captures
- `test/test_archives.js` — --build-index archive expansion: ZIP/TAR/GZIP, zip-in-zip, encryption, `!` paths
- `test/test_basic.js` — CodeSearchIndex smoke: build, search, function parsing, extraction, persistence reload
- `test/test_binary_sniff.js` — TreeSitterParser guards: binary/MPEG-TS sniff keeps grammars off non-source (#299)
- `test/test_binstrings.js` — binstrings: string extraction, noise filter, mangled names, .op pseudo-source gate
- `test/test_call_inventory.js` — --call-inventory: in-index vs external callee split, provenance labels, --filter
- `test/test_catalog.js` — #162 catalog emit: buildCatalogEntry root aliasing, mergeCatalog de-dupe and refresh
- `test/test_claim_analyze.js` — claim-analyze: claim scope, term probes, multisect scope ladder, per-element arm
- `test/test_claim_ballpark.js` — claim-ballpark script: distinctive-term selection, row reduction, ranking
- `test/test_claim_chart.js` — claim-chart pipeline: table structure, target budget, verdict merge, provenance, HTML
- `test/test_claim_class.js` — pickClaimClass: the deterministic statutory-class rule, four branches with reasons
- `test/test_claim_genericity.js` — claim genericity: head verbs, IO vs mechanism cues, element-class tallies
- `test/test_claim_locate.js` — claim-locate: symbol verify, element splitting, scavenger hunt, targets provenance
- `test/test_claim_search.js` — --no-claim-filter: the vocab-concordance options decision at all three call sites
- `test/test_claims_loop.js` — claims-loop: chart/lst parsing, anchoring, sponge detection, redraft, cost guard
- `test/test_class_digest.js` — #198 class digest targets the class not its constructor; listClasses start line
- `test/test_class_scope.js` — multisect class-level scope: terms spread across methods of one class, dedupe
- `test/test_cli_errors.js` — CLI bad input fails before index load: banner, error, run-help, exit 2
- `test/test_client_server.js` — client/server detector: route + call detection, unmatched-call reconciliation
- `test/test_credential_mask.js` — credential masking at the tool seam: assignment forms, random-token entropy gate
- `test/test_data_structs.js` — #194 extractDataStructures: struct/enum/union/trait/interface across Rust/C/Go/TS
- `test/test_dep_claim_rules.js` — dependent-claim malformation rules over real USPTO specimens: parents, taxonomy
- `test/test_dep_claims.js` — dep-claims chains: parent/root/depth on a real 26-claim family, contribution kinds
- `test/test_disambiguation.js` — callee name resolution: self/this, explicit qualification, same-class, inheritance
- `test/test_engine_qualify.js` — engine-qualify scorer: negative/positive pass rules, strongest-per-element rows
- `test/test_explainability.js` — explainability cell: import gating, kinds, variants, data/prose file skip
- `test/test_extract_roundtrip.js` — #241 parse safety: emitted file@func copy-targets round-trip through doExtract
- `test/test_file_resolution.js` — #238 file-target resolution: exact match wins, leading `/` anchors to repo root
- `test/test_first_run.js` — first-run UX: bare `ce` welcome, demo auto-load, bad --index-path, no auto-REPL
- `test/test_follow_calls.js` — --follow-calls (--deep) and --comments-only over extracted functions
- `test/test_har.js` — #161 .har expansion: text/base64 bodies, mime inference, URL dedupe, malformed input
- `test/test_help_filter.js` — filterHelp: entry blocks and continuation lines, section headers, no-match report
- `test/test_help_flags.js` — help discoverability: --gui/--port/--load-index in --help; --load-index synonym
- `test/test_hotspots.js` — #187: hotspots and entry_points skip vendored/minified files that stay indexed
- `test/test_hunt_repeat.js` — hunt-repeat harness: the run-report parser behind every reported distribution
- `test/test_imports.js` — BoM tier 1: JS/C/Java/C# extractors, resolver classes, platform lists, residue
- `test/test_imports_consumer.js` — catalog consumer: classifyAgainstCatalogEntry, ancestor walk, catalogPkgKey
- `test/test_infrastructure.js` — #168 infra detector: Containers/K8s/IaC/CI-CD file shapes, plus FP guards
- `test/test_linkify_selection.js` — #275 source viewer: which identifiers become clickable, knowledge vs shape mode
- `test/test_loop_score.js` — loop-score: target keys, answer-key anchors, chart/control scoring, dependent grades
- `test/test_mcp_tools.js` — MCP handleTool: digest, call_tree, command_catalog, models_used, absence disclosure
- `test/test_mechanism_grouper.js` — #284 candidate emitter: seeds, group splitting, vendored-subtree exclusion
- `test/test_mechanism_ranker.js` — #284 ranker: tolerant verdict parsing, priors, chunked batches with a P3 playoff
- `test/test_metrics.js` — vocab-density key files: score x concentration ranking, doc-id folding, term counts
- `test/test_minified.js` — isMinified gate: .min.* shortcut, eligible extensions, the maxLine clause for bundles
- `test/test_models_used_fp.js` — listModelsUsed: four false-positive shapes suppressed, real model ids kept
- `test/test_multisect_scoring.js` — comment-vs-code match classification, IDF weighting, match-density scoring
- `test/test_overview.js` — #181 buildOverview/formatOverview: collection detect, language histogram, key files
- `test/test_overview_example_resolution.js` — concept examples resolve to a definition, never the mention hub
- `test/test_overview_local_hardening.js` — local Overview gates: tool budget/floor, date pinning, damage cap
- `test/test_overview_sdk.js` — #196 SDK AI Overview: tool allow-list, name normalization, grounding clause
- `test/test_path_prefix.js` — commonPathPrefix: strict shared prefix and dominant prefix with outlier tolerance
- `test/test_phase2.js` — Phase 2 call graph: callers/callees, call counts, file deps, reload persistence
- `test/test_phase3.js` — Phase 3 metrics: hotspot scoring, listClasses (incl. export macros), entry points
- `test/test_phase4.js` — Phase 4 dedup: funcstrings, hashing, exact/near/structural dupes, duplicate files
- `test/test_phase5.js` — Phase 5 multisect: term parsing, function/class/file/folder matches, path-only hits
- `test/test_phase6.js` — Phase 6 REPL: welcome, search modes, /extract, /callers, redirection, shell escape
- `test/test_phase8a.js` — claim term sanitizers: word/length caps, alternation trimming, stop-list, dedupe
- `test/test_phase8b.js` — analyze.js primitives: SimpleMasker comment/string masking, language detect, prompts
- `test/test_prompt_purity.js` — CI guard: shipped prompt templates carry no domain vocabulary or corpus symbols
- `test/test_prompts.js` — #169 LLM-prompt detector: reject code/markup/identifier lists, dedupe bundle copies
- `test/test_pseudo_claim_triage.js` — deterministic first cut over pseudo-claims: signals, thresholds, keep sidecar
- `test/test_pseudo_claims.js` — --claims-only machine format, anchor sidecar, truncation detection, dependents
- `test/test_ranker_eval.js` — ranker scoring: midranks, tie-corrected Spearman, recall@k, purity, .lst parsers
- `test/test_referenced_resources.js` — external surface: URLs, env vars, paths, commands, cloud and model refs
- `test/test_retrieval_reachability.js` — retrieval acceptance: implementer reach, ratcheted high-water marks
- `test/test_synonymize.js` — synonymizer: prompt build, marker/punctuation restore, overlap, corpus-arg guards
- `test/test_vocab_extract.js` — vocabulary-guided terms: splitCompoundToken, prompt concordance, claim keywords
- `test/test_vocabulary.js` — vocabulary corpus: noise-doc exclusion, cross-corpus weights, claim-filter guards
- `test/test_whousedby.js` — catalog v2 annotateUsedBy: named imports credited per library, self-imports excluded
- `test/test_zip_index_load.js` — #176 zipped-index loading: extractZipToDir over hand-built ZIPs, resolveIndexDir
