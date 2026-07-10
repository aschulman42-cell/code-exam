# Structural Code Search

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part K pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

### Deobfuscation, renames, and fingerprints
- Detects esbuild / minified JS and prettifies via `js-beautify`.
- Optional `webcrack` for bundle disassembly (≤500 KB files).
- Auto-infers readable names from obfuscated code (toggle off with
  `--no-rename`):
  - `_KW_` keyword inference from string literals
  - `_NAME_` recovery from `__name(fn, "originalName")` esbuild helpers
  - `_IMPORT_` resolution from import bindings
  - `_CMD_` recovery for command/route/skill handler functions
- **Funcstrings** — a distinctive-string + call signature per function.
  Resilient to esbuild/webpack transforms. The goal is to match a bundled
  `cli.js` function back to its source-library equivalent; this works in
  controlled cases (see the `franken.fp.json` example below) but reliably
  identifying generic library code — e.g. C-runtime functions like `fopen` /
  `printf` in a stripped binary — is still in progress. Two access shapes: full
  funcstring (`--show-funcstring`) for human inspection, and funcstring
  hashes (`--funcstr-hashes`) for cross-index intersection.
- **Portable fingerprint files** (`*.fp.json`) — fingerprint a curated
  reference library once, then match the resulting `.fp.json` against any
  working index without redistributing the library's source. Generate with
  `--build-fp-renames`; the working example shipped today is
  `franken.fp.json`. Matches surface as `_FP_`-prefixed names.
- Multiple types of duplication detection: exact (SHA1), near-duplicate, and
  **structural-dupe** (AST-shape hashing for non-bundled code). Dupes are
  preserved, not collapsed.

The reason CodeExam spends so much machinery on duplicate detection is not the
obvious one (avoiding re-analysis): it's the inverse use. The same signatures
that find duplicates are what let you identify *unknown* code by matching it
against known reference code, and trace function lineages — three near-dupes
evolved from a common ancestor — across versions or forks.

The richness here is that there are *complementary* signature types, and
deliberately so, because each survives a different kind of transformation:

- **Structural / near-dupe signatures** (AST-shape and near-duplicate hashing)
  are *naming-independent* — they still match after a rename pass or
  minification has mangled every identifier, because they key on the *shape* of
  the code, not its names.
- **Funcstrings** are a *naming-dependent, extrinsic* signature — distinctive
  string literals plus the external API calls a function makes. They key on what
  the code *says and calls* rather than its shape, and survive the inverse
  transformation: restructured control flow whose strings and call targets are
  unchanged.
- **LLM analysis** (`--analyze`) is the higher-cost adjudicator for the hard
  cases neither structural nor extrinsic signatures resolve on their own,
  reasoning about the code in context.

No single signature is sufficient on its own; used together — structural,
extrinsic, and (for the residual hard cases) LLM-assisted — they identify
unknown code far more reliably than any one of them.

**Why a plain inverted index rather than a vector database or SQL?** Readers
coming from recent tooling often expect a vector store (ChromaDB, FAISS) or a
relational database, and assume either would be preferable to "plain text in
JSON." The choice is deliberate. Exact and regex code search wants *lexical*
precision, not nearest-neighbor approximation, so embeddings buy little for the
core browse-and-cross-reference workload. Keeping the index as inverted-index
structures serialized to JSON makes it transparent, diffable, and trivially
portable across machines — there is no database server to stand up and no
opaque binary store. Semantic / embedding search — vector similarity, and
lighter-weight options such as small specialized models for retrieval — is
something we're *exploring* as a layer *on top* of the lexical index rather than
a replacement for it (backlog: RAG-style retrieval and embedding/small-model
term extraction, TODO #201 / #202); it is not part of the core today.
