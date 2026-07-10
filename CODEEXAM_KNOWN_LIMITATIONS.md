# CodeExam Known Limitations

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part Q pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

## Known limitations

- **File-path lookup on Windows / mixed separators** (#67) — paths CodeExam
  *displays* (e.g. `ace\examples\test.cpp`) don't always round-trip as
  *input* to path-taking commands (`--digest`, `--show-file`, `--extract`,
  `--callers`, …). Workaround: use a bare filename, which suffix-matches
  (`--digest test.cpp`). Under investigation.
- **Local-LLM model coverage and quality** (#75) — newest GGUF architectures
  (Gemma 4, Qwen 3.5) fail to load; older ones work. Separately, local-model
  output quality lags the Claude-API path. See Requirements.
- **Command-catalog false positives** (#66) — `--command-catalog` and the
  command section of `--digest` can surface regex fragments or example
  strings as if they were commands. Being tightened.
- **GUI test automation** — not yet in place; evaluating an
  [XMLUI](https://www.xmlui.org/)-driven approach (#73).
- **Symbol lookup ambiguity across same-named classes/functions** (#85) — in
  large or mixed-language codebases, multiple classes/functions can share a bare
  name (across files, versions, even languages). `--digest` and right-click →
  Digest may merge them or mislabel the result (e.g. a Python class's digest
  titled with a same-named C++ declaration from a vendored header). The digest
  *body* is usually still correct; the *title/target* may be wrong. Better
  disambiguation — file/line-qualified targeting and conflation warnings — is
  planned.
- **AI/ML detection is heuristic** (#98, #92, #122, #135, #136) — the detectors
  favor recall: counts are *presence signals*, not exact site counts. Expect
  false positives (library types like `Eigen::Dense` flagged as models, prose
  or doc-search strings flagged as prompts, `messages.create` collisions) and
  some misses, especially in vendored/test-heavy trees. Treat the AI/ML
  accordions as leads to verify in source, not a precise inventory. Precision
  and recall are being tightened cell by cell.
- **C++ class recognition is incomplete** (#65) — the C++ parser doesn't
  reliably catch class *declarations*; many classes surface only as inferred
  from `::`-qualified usage, so class lists and class digests can be partial or
  mislabeled on C++-heavy trees. Language-aware C++ digest handling (#60, #68)
  is planned.
- **GUI lists can silently cap results** (#137) — left-pane accordions and
  some drilldowns cap the number of rows returned (e.g. a few hundred) without
  always disclosing it, so a large result set may look complete when it isn't.
  Use `--filter` to narrow, or the CLI for full output. Explicit "N of M shown"
  disclosure everywhere is planned.
- **Indexing very large or pathological files** (#88) — without per-file size
  caps / parse timeouts, `--build-index` can hang (tree-sitter) or run out of
  memory on extreme inputs; guards are planned. (The `codeexam.exe` Bun build
  also has a known `--build-index` EEXIST bug, #91 — use the Node path
  meanwhile.)
- **Mermaid pipeline diagrams render only connected flows** — the AI/ML
  Pipelines view diagrams multi-stage **connected** flows; isolated
  detections and very long pipelines may not diagram cleanly.
- **Import/Export analysis is Python-only** (#165) — and the static catalog
  path misses dynamically-exported names (star-exports, lazy registries) that
  the live cross-index path resolves.
- **Explainability detection is Python-only and import-anchored** (#163) —
  XAI used without a recognizable import (custom probing/patching), and
  non-Python XAI, are not detected.
- **Emitted PY harnesses are scaffolds** — emitted activation-capture
  harnesses are validated for structure, not guaranteed-runnable;
  `--synthetic-loader` is opt-in and banners that the load is mechanical.
- **Caller↔callee resolution under dynamic dispatch** (#85, #148) — dynamic
  class/method dispatch is hard to resolve statically, so call-graph links
  (`--callers`, `--call-tree`, digest caller/callee lists) can be incomplete
  or mis-linked.
- **GUI feature constraints** (#38, #125) — the current GUI does not allow
  multiple instances of the same pane type (beyond a limited side-by-side
  compare), has no in-pane search yet, and supports save/copy only from the
  Analysis and Mermaid panes. A newer XMLUI-based GUI design is planned (the
  result-cap (#137) and test-automation (#73) items above are related).
- **No general LLM chat about the codebase yet** (#36, #160) — today the LLM
  paths analyze a *single function or file* (`--analyze`, `--build-prompt`),
  including the air-gapped local-GGUF mode; a wider "chat with the whole
  codebase" is a goal, not yet a feature. For Claude it is largely a matter of
  adding MCP tools; the harder, gating part is making a local GGUF drive
  CodeExam's MCP tools effectively for fully air-gapped use. So if you're
  wondering *"why can't I just chat with an AI about the codebase?"* — you can
  chat about a function today; codebase-wide chat awaits broader MCP tooling
  and capable local models.
