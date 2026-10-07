# CodeExam known limitations

CodeExam 0.5.x is a work in progress — published so people can try it and send critiques and
requests, not recommended for production use yet. This is the honest list of where it falls
short today; it's kept current as things are fixed.

**A note on the word.** "Limitations" here means CodeExam *features* that don't yet work in
entirely the way one would want — not the "limitations" (the elements or steps) of a patent
claim, which are a different thing entirely and are discussed in CodeExam's claims-handling
documentation ([[claims doc filename — pending the #274 PATENT_CLAIMS / CodeClaim decision]]).

## Local models

The local-model path is the least mature part of CodeExam, and its limits are worth stating
plainly:

- **Model coverage and quality** (#75). Local inference runs GGUF models through a pinned
  `node-llama-cpp` build; which models load, and how well each does per feature, is enumerated
  in [`docs/model-support.md`](model-support.md). Some newer architectures don't load
  cleanly in current testing, so the tested set is what to rely on. Output quality on the local
  path lags the cloud path.
- **A local model can't yet reliably link a claim to the code that embodies it — on its own**
  (#325). Hand a local model a patent claim and ask it to *find* the implementing code without
  the guided pipeline and it usually fails: not for want of search, but because it can't
  connect the claim's wording ("first-come/first-served") to the code's ("FIFO scheduler"),
  and on an open, tool-driven task it tends not to navigate at all — answering from memory
  instead. The rule this yields, for now: **use the guided claim pipeline for local models,
  and a cloud model for independent claim→code analysis.** See [`LOCAL_LLM.md`](LOCAL_LLM.md).
- **Codebase-wide chat exists, but not yet fully air-gapped** (#36, #160). You *can* chat about
  the codebase today — the GUI Chat pane, and, for a cloud model, CodeExam's MCP tools. What
  isn't there yet is a *local* model driving those MCP tools well enough for whole-codebase
  chat with no network — the same weak-navigator limit as above is the gating problem.
  (Single-function `--analyze` runs locally today, air-gapped included.)

## Everything else

- **Command-catalog false positives** (#66) — `--command-catalog` and the command section of
  `--digest` can surface regex fragments or example strings as if they were commands. Being
  tightened.
- **AI/ML detection is heuristic** (#98 et al.) — the detectors favor recall, so counts are
  presence *signals*, not exact site counts; expect some false positives and misses. Treat the
  accordions as leads to verify in source, not an inventory. See
  [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).
- **C++ class recognition is incomplete** (#65, #60) — the C++ parser doesn't reliably catch
  class *declarations*; many classes surface only as inferred from `::`-qualified usage, so
  class lists and digests can be partial or mislabeled on C++-heavy trees. See
  [`CODEEXAM_KEY_FEATURES.md`](CODEEXAM_KEY_FEATURES.md).
- **Symbol-lookup ambiguity across same-named symbols** (#85) — multiple classes or functions
  can share a bare name (across files, versions, even languages); `--digest` may merge or
  mislabel them. The digest *body* is usually still right; the *title/target* may be wrong.
  File/line-qualified targeting and conflation warnings are planned.
- **Caller↔callee resolution under dynamic dispatch** (#85, #148) — dynamic dispatch is hard to
  resolve statically, so call-graph links (`--callers`, `--call-tree`, digest caller/callee
  lists) can be incomplete or mis-linked.
- **Import / BoM coverage** (#165) — import/export extraction covers Python, JS, C, Java, and
  C#; the static-catalog path still misses dynamically-exported names (star-exports, lazy
  registries) that the live cross-index path resolves.
- **Explainability detection is Python-only and import-anchored** (#163) — XAI used without a
  recognizable import (`shap` / `lime` / `captum`), and non-Python XAI, aren't detected.
- **GUI result caps** (#137) — some left-pane accordions cap the rows returned without always
  disclosing it, so a large result set can look complete when it isn't. Use `--filter` to
  narrow, or the CLI for full output; explicit "N of M shown" disclosure is planned.
- **GUI feature constraints** (#38, #125) — no multiple instances of the same pane type (beyond
  a limited side-by-side compare), no in-pane search yet, and save/copy only from the Analysis
  and Mermaid panes. A GUI redesign is planned (#38) — including the "dynamic GUI" of floating,
independently-operable panels that redesign is built toward.
- **GUI test automation** (#73) — not yet automated; the GUI is exercised by hand. See
  [`CODEEXAM_TESTING.md`](CODEEXAM_TESTING.md).
- **Indexing pathological files** (#88) — *large* is not the same as *pathological*:
  CodeExam indexes multi-gigabyte codebases fine (the largest built here is ~1.2 GB, and
  bigger has worked — [[confirm the large-codebase example, e.g. Chromium ~5 GB, + issue #]]).
  The gap is *pathological single files*: without per-file size caps or parse timeouts,
  `--build-index` can hang (tree-sitter) or run out of memory on extreme inputs. Guards are
  planned.
- **Mermaid pipeline diagrams render only connected flows** — isolated detections and very long
  pipelines may not diagram cleanly.
- **Emitted PyTorch harnesses are scaffolds** — validated for structure, not guaranteed
  runnable; the load banners that it is mechanical. See
  [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).
- **Funcstring library identification is controlled-case** — matching bundled code back to a
  source-library equivalent works in curated cases; reliably identifying generic library code
  (`fopen` / `printf` in a stripped binary) is still in progress. See
  [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md).
- **No file-date / timestamp handling** — CodeExam indexes code content, not file dates or
  modification times. In patent and trade-secret work, where *when* code existed can matter, track
  dates outside CodeExam (e.g. from version control or the produced materials).
- **Some commands are CLI-only** — e.g. `--multi-index` (running one command across several
  indexes) has no GUI equivalent, and a few commands render differently in the GUI than on the CLI.
- **The GUI can block on voluminous pane output** — a pane producing very large output can stall
  the interface, which is the reason several commands impose the result caps noted above; the
  planned GUI redesign (#38) is built toward non-blocking, independently-operable panels.
- **Function/method-end detection is imperfect** — both the regex and tree-sitter paths sometimes
  miss where a function or method ends, so trailing code can be attributed to an ostensibly huge
  function, which in turn can skew any ranking that weights by length.
- **Class-method navigation can resolve to the wrong handler** (#85, #148) — resolution is static,
  not dynamic, so clicking a method in the GUI can land on a same-named or otherwise wrong target
  where dynamic dispatch (a vtable, a registry) decides the real one only at run time.
- **For other limitations, see the open issues** —
  [open CodeExam issues](https://github.com/aschulman42-cell/code-exam/issues?q=is%3Aissue+state%3Aopen).
