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
- **Codebase-wide chat exists, in the GUI and on the CLI, and runs air-gapped on a local model;
  what limits it is the weak-navigator problem** (#36, #160). The GUI Chat pane and
  `--ask-ai "<question>"` drive CodeExam's tools — the one table the MCP server registers,
  called in-process by a local model rather than over MCP ([`CODEEXAM_MCP.md`](CODEEXAM_MCP.md),
  "One tool table, three menus") — through the same loops, on a cloud engine or
  a local GGUF with no network. How well a given local model drives them is the per-model
  question in [`model-support.md`](model-support.md) (the GUI Chat row; `--ask-ai` runs the
  same loops and is unmeasured as a surface), and the weak-navigator limit above is why the
  answers vary by model. The claim tools (`claim_elements`, `claim_candidates`,
  `capabilities`) reach Claude Desktop and the cloud Chat only: the local Chat, GUI and CLI
  alike, keeps its curated eight-tool menu, the one measured to work, so a local model does
  not reach them unless started with
  `CE_LOCAL_CHAT_TOOLS=+claim_elements,claim_candidates,capabilities`, an unmeasured menu (see
  [`LOCAL_LLM.md`](LOCAL_LLM.md)).
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
  File-qualified targeting exists for the call commands (`FILE@func`, which the GUI always
  sends) and `file@func@LINE` for `--extract`, and call resolution marks its uncertain picks
  `[ambiguous]` (next bullet); the digest's silent first-match pick for a bare target is what
  remains.
- **Bare-name call resolution is precise about what it refuses, not complete** (#85, #148,
  #343) — a call binds to a definition only when the definition is reachable from the call
  site: a function nested in another function only from inside it, a non-exported JS/TS
  function or a C `static` function only from its own file, and never across language
  families. A method call on a receiver (`out.push(`) binds to a free function only when the
  receiver is an import alias of that function's module (`utils.foo(`, Python
  `helpers.compute(`); elsewhere it is **unresolved**, or in languages with no import
  evidence a pick marked **ambiguous**. Among several reachable definitions, the one the caller
  imports wins; otherwise the same-file or closest-directory pick is kept and marked
  `[ambiguous]` (dashed in diagrams), and trees do not descend into it. A file-qualified
  Find Callers (`FILE@func`) lists only the sites that can reach that definition; a bare-name
  Find Callers still lists every same-named site. What is not done: dynamic dispatch (a vtable,
  a registry) still resolves statically or not at all; CommonJS `require` and non-ESM aliases
  give no import evidence; the digest's silent first-match pick for a bare target is unchanged.
- **Import / BoM coverage** (#165) — import extraction covers Python, JS/TS, C/C++,
  Java/Kotlin, C#, Go and Rust, plus the tags of indexed HTML and page templates; export
  extraction is Python-only; the static-catalog path still misses dynamically-exported names
  (star-exports, lazy registries) that the live cross-index path resolves. The full list of
  what is not done is on [`CODEEXAM_MAPPING_DEPENDENCIES.md`](CODEEXAM_MAPPING_DEPENDENCIES.md).
- **A detector recognizes its own vocabulary** — every pattern-based catalog (the AI/ML and
  infrastructure detectors, breadcrumbs, referenced resources, the bill of materials'
  dynamic-loading scan, the copyright harvest) matches its own pattern strings, help text and
  test fixtures when run on CodeExam's tree, and the same happens on any tree that carries a
  scanner of the same kind: a security tool, a linter, a test suite with fixture strings, a
  page that documents the patterns. The rows are real text found, not false positives in the
  tool's terms, and there is no general suppression, by choice (a fixture string is evidence
  too). Read the `e.g.` sites and the "why" column before counting them. Worked cases: the
  `Cloud: aws` entry and the breadcrumb patterns on
  [`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md), the fixture
  "holders" and the help-text `require(expr)` site on
  [`CODEEXAM_MAPPING_DEPENDENCIES.md`](CODEEXAM_MAPPING_DEPENDENCIES.md).
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
- **Indexing very large inputs / pathological files** (#88) — *large* is not the same as
  *pathological*: CodeExam indexes multi-gigabyte codebases fine (the largest built here is
  ~1.2 GB; Chromium at ~195K files / ~5 GB has been built and queried with
  `NODE_OPTIONS=--max-old-space-size=8192`). Two real limits remain, both on `--build-index`,
  because Node's default heap is ~4 GB and a V8 heap OOM is **uncatchable** (there is no way to
  print a nice message *after* it):
    - **One pathological single file** — a huge minified bundle can hang or OOM the tree-sitter
      parse. Remedy: more heap + `--split-bundle`.
    - **A huge corpus** (very high file count / total bytes) — the inverted-index build holds the
      whole corpus in memory. Remedy: more heap, or shard the build by subtree and query across
      shards with `--multi-index`.
  `--build-index` now prints a **pre-flight advisory** with the exact flags before the crash (it
  does not skip anything); see the FAQ.
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
- **Function/method-end detection is imperfect** (#343) — the regex parser (`--regex-parser`
  builds, and the fallback for languages without a grammar) now masks strings, comments and regex
  literals before it scans, ends brace-less arrow functions and Python blocks on their own, and no
  longer takes prose inside a template literal for a definition; a tree-sitter build (the default)
  keeps one entry per definition and marks the regex-only ones (`"parser": "regex"` in
  `function_index.json`). What remains: languages with neither a
  brace, an indentation nor a grammar strategy (Ruby, Lua, VBScript, ...) still end at the next
  definition; a tree-sitter parse that recovers from a syntax error keeps whatever boundaries the
  recovery produced, except that a longer regex end for the same definition replaces a truncated
  one (`"parser": "regex-end"`), and the build summary names such files (a raw NUL byte inside a
  template literal is one known trigger); and any wrong end still credits trailing
  code to an ostensibly huge function and skews length-weighted rankings. Rebuild an existing
  index to get the new spans: a rebuild now parses with tree-sitter by default and gets grammar
  spans, the deduped merge and the macro names; a `--regex-parser` rebuild (or the Build Index
  dialog's "Regex parser only" box) gets the regex-side fixes only. An index records its
  `parse_method` but no CodeExam version, so nothing tells you an index predates this change.
- **Regex-parser definition detection** (#343) — the regex parser now finds the C shapes it
  used to skip: the pointer written on the name (`SSL_CTX *initialize_crypto_context(`, the
  shipped demo's star functions were never listed), the GNU layout with the return type on its
  own line and the name at column 0 (libxml, libpng, git, gcc, PostgreSQL style, which came out
  at 4 % recall; the entry starts at the type line, as tree-sitter's does, so `--extract` keeps
  the return type), one-line bodies (`{ return x; }`) in C, C++, Java, JavaScript and C#, Java
  parameter lists wrapped onto the next line, `typedef struct name {`, `) const override {`
  tails, `export const f = () =>` in JavaScript, and `TEST_F(Suite,` with the test name on the
  next line. It no longer takes a wrapped declaration (`extern int f(int a,` … `);`), a
  `return` / `throw` / `new` line, `synchronized (x) {` or `__asm__ volatile (` for a
  definition, and `--callers` no longer lists a `Type *name(...);` prototype as a call site.
  Measured against tree-sitter on 2026-10-13: the demo 84 → 100 % of definitions found, libxml
  4 → 100 %, libpng 7 → 99.5 %, zlib 92 → 97 %, Chromium `cc/` 76 → 90 %, CodeExam's own
  JavaScript 95 → 98 %. What remains for the regex parser: constructors with no return type
  (`Foo(int a) : a_(a) {`), `= default` / `= delete` and `operator` members, a macro that wraps
  the signature (`PNG_FUNCTION(void, PNGAPI`), old K&R parameter declarations, and a nested
  arrow assigned to an existing property (`console.log = () => {}`). Tree-sitter, the default
  build, is still the precise parser; these shapes matter for `--regex-parser` builds and for the
  languages without a grammar. Rebuild an existing index to get the new entries.
- **Macro-defined functions in C/C++** — a macro that *opens* a function (`BEGIN_FN(name) ...
  END_FN`, a common Chromium and kernel idiom) is invisible to both parsers: its body is credited to
  the previous function on a regex index and to file scope on a tree-sitter index. A macro *with*
  a body (`TEST_F(Suite, Name) { ... }`, `DEFINE_METHOD(Foo, bar) { ... }`) is found and named
  `Suite::Name` / `Foo::bar` by both parsers; tree-sitter also records the macro (`macro` in the
  entry). CodeExam does no preprocessing, so project-specific macro idioms beyond these shapes can
  still hide code.
- **Class-method navigation can resolve to the wrong handler** (#85, #148) — resolution is static,
  not dynamic, so clicking a method in the GUI can land on a same-named or otherwise wrong target
  where dynamic dispatch (a vtable, a registry) decides the real one only at run time.
- **A residual `npm audit` finding in a pinned dependency** — `node-llama-cpp`
  (pinned for local GGUF inference) depends on a `simple-git` version with
  unpatched command-execution advisories, and the only patched `simple-git` is
  a major bump `node-llama-cpp` does not yet support. So a fresh `npm install`
  shows 3 criticals from the `node-llama-cpp → simple-git` chain that can't be
  cleared without downgrading `node-llama-cpp` (which would break local models).
  Practical reachability is low: `simple-git` is used internally by
  `node-llama-cpp` with fixed arguments, and CodeExam never passes it untrusted
  input. Tracked upstream at
  [withcatai/node-llama-cpp#669](https://github.com/withcatai/node-llama-cpp/issues/669);
  it clears when `node-llama-cpp` bumps `simple-git`.
- **The GUI's memory is the server's, not the browser's** — closing the browser tab frees
  nothing; only Ctrl-C in the terminal that launched `ce --gui` ends the process. Load Index
  releases the previous index and returns its memory to the OS at the switch (the server's
  `[load-index]` console lines show `rssMB` falling at `released`). What is **not** released:
  a switched-away local model's context, which cannot be disposed for some model families
  (upstream `node-llama-cpp`, #248) and so is held until exit — restart to get it back. See the
  FAQ entry *I loaded a smaller index … but memory is still high*.
- **For other limitations, see the open issues** —
  [open CodeExam issues](https://github.com/aschulman42-cell/code-exam/issues?q=is%3Aissue+state%3Aopen),
  and the consolidated GUI/engine field-test triage in
  [#343](https://github.com/aschulman42-cell/code-exam/issues/343), which maps a
  first-time-user session's findings to the issues that track them.
