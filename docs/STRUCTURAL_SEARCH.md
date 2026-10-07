# Structural search: finding code by what it does, not what it says

Most code search is textual — you look for a name, a string, a regex. But the names of
functions, methods, and files can't always be trusted — they may be wrong or outdated, and
comments can mislead — and a code examiner's search terms may be quite different from the
words the code itself uses. Names also get erased or rewritten outright: renamed by a
refactor, mangled by a minifier, stripped from a binary, reworded by an independent
reimplementation — or the concept is simply described in different words than the code uses
(the gap in #325 between a claim's "first-come/first-served" and the code's "FIFO
scheduler"). **Structural search is the family of ways CodeExam finds and identifies code
when its text is unreliable or doesn't match** — by keying on what the code *does* and how
it's *shaped* instead.

It's the deliberate counterpart to the naming problems elsewhere in these docs: the
deobfuscation of [`QUASI_SOURCE.md`](QUASI_SOURCE.md) and the reduce-reliance-on-naming side
of [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).

## Complementary signatures, each surviving a different transform

No single signature identifies code across every transformation, so CodeExam keeps several
that succeed or fail in different directions:

- **Structural / near / exact duplication** (`--struct-dupes`, `--near-dupes`,
  `--func-dupes`). AST-shape hashing is **naming-independent** — it keys on the shape of the
  code, so it still fires after a rename pass or minification has changed every identifier.
  On the scikit-learn tree, `--struct-dupes` finds **142 structural-dupe groups ("same
  structure, different names/values")** — e.g. two copies of `BaseHistGradientBoosting.fit`
  (559 lines, different names) — alongside 12 exact and 219 near-duplicate groups. Dupes are
  **preserved, not collapsed**; the copies are the point.
- **Funcstrings** (`--show-funcstring`; hashes for cross-index intersection). The inverse
  signature: a function's *distinctive string literals plus the external calls it makes* —
  **extrinsic**, keyed on what the code *says and calls* rather than its shape. It survives
  the opposite transformation — restructured control flow whose strings and call targets are
  unchanged — and is resilient to esbuild/webpack bundling.
- **LLM analysis** (`--analyze`) — the higher-cost adjudicator for the residual hard cases
  that neither structural nor extrinsic signatures settle on their own, reasoning about the
  code in context.

Used together — structural, extrinsic, and (for the residue) LLM-assisted — they can help
locate the code you're looking for far more reliably than any one alone.

As another approach to structural searching — one where you don't need to know the name of what
you're looking for beforehand — consider **"searching by counting."** As described in
[`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md) and [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md),
CodeExam builds catalogs of items in different categories (Functions, Vocabulary, Strings,
Referenced Resources, and so on) and sorts them by measures of importance based on counts — an
item's occurrences, how many things reference it, its length, and its distinctiveness (an
inverse-document-frequency weighting that demotes frequent but generic items) — with the potentially
most important items at the top. That lets you search for something without knowing its name, by
eyeballing the tops of the catalogs and seeing whether anything relevant-sounding jumps out.

## The point of duplicate detection

CodeExam spends real machinery on duplicate detection, and not for the obvious reason
(skipping re-analysis). The valuable use is the **inverse**: the same signatures that find
duplicates let you identify *unknown* code by matching it against *known* reference code, and
trace a function's lineage — three near-dupes evolved from a common ancestor — across versions
and forks. For software examination that is the payoff: detecting copied or derived code that
has been renamed, reformatted, or restructured to hide the copying, and knowing which
signature it survived.

## Portable fingerprints — the signatures, packaged to travel

A portable fingerprint is those same structural and extrinsic signatures, saved for reuse:
fingerprint a curated reference library once and carry the result as a small `*.fp.json`
file, then match it against any working index. Generate it with `--build-fp-renames`; matches
surface as `_FP_`-prefixed names. This is what makes the inverse use practical when you can't
put reference and target in the same tree — the fingerprint travels, the source doesn't have
to. One caveat: the `.fp.json` is not fully source-free — it carries the reference's
*symbolic names* (so a match can be labeled with them), and those names can leak identifying
detail; what it leaves behind is the source *code*. A worked example ships today
([[fingerprint-example filename — pending: rename from the obscure `franken.fp.json`, and
confirm whether the ~30 MB file is meant to ship]]).

## Deobfuscation and renames

Renaming is where the two halves of this page meet: a `_FP_` rename *is* structural search
applied to naming — a fingerprint match against reference source is what supplies the
inferred name, which then makes an otherwise-opaque function findable by ordinary text search
again. When code arrives obfuscated or minified, CodeExam detects esbuild/minified JS and
prettifies it (via `js-beautify`; optional `webcrack` for bundle disassembly on smaller
files), then infers readable names in tiers — `_KW_` (from string literals), `_NAME_`
(esbuild `__name` helpers), `_IMPORT_` (import bindings), `_CMD_` (command/route/skill
handlers), and `_FP_` (fingerprint matches against reference source). `--no-rename` shows the
raw obfuscated names.
This is the machinery [`QUASI_SOURCE.md`](QUASI_SOURCE.md) points here for — with the caveat
stated there that these are *inferred* names, not the originals.

## The textual end of the family

Two more ways to loosen the tie to exact text — both with their homes in
[`CODEEXAM_KEY_FEATURES.md`](CODEEXAM_KEY_FEATURES.md), referenced here only for their
structural angle:

- **Synonym expansion** (`--synonymize`) feeding **multisect** search makes a term search
  robust to exact wording — the most *textual* member of this family, and the closest
  CodeExam comes to bridging a pure vocabulary gap without a model judging the code.
- The **command catalog** resolves a CLI/menu command to its handler by its **position in a
  dispatch table**, not by name — so it maps commands to handlers even when the handler names
  say nothing.

## Why a plain inverted index, not a vector database

Users familiar with AI methods such as RAG often expect a vector store (Chroma, FAISS) or a
relational database, and assume either beats "plain text in JSON." The choice is deliberate.
Exact and regex code search wants **lexical precision, not nearest-neighbor approximation**,
so embeddings buy little for the core browse-and-cross-reference workload; and keeping the
index as inverted-index structures serialized to JSON makes it transparent, diffable, and
trivially portable — no database server to stand up, no opaque binary store. Semantic /
embedding search (vector similarity, plus lighter-weight retrieval models) is being
*explored as a layer on top* of the lexical index — the RAG/embedding backlog is issues #201
and #202 — not as a replacement for it.

## Current limits on use

- **Funcstring library-ID is controlled-case today.** Matching a bundled `cli.js` function
  back to its source-library equivalent works in curated cases (the shipped fingerprint
  example); reliably identifying *generic* library code — C-runtime functions like `fopen`
  or `printf` in a stripped binary — is still in progress.
- **Structural-dupe hashing is for non-bundled code**; bundled/minified code is served by
  the funcstring and rename paths instead.

## Related

- Recovering structure — and inferring names — from non-source artifacts:
  [`QUASI_SOURCE.md`](QUASI_SOURCE.md).
- The reduce-reliance-on-naming side of the same coin (`--mask-all`):
  [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).
- These signatures are mechanical and deterministic — the determinism boundary in
  [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).
- Multisect search and the command catalog:
  [`CODEEXAM_KEY_FEATURES.md`](CODEEXAM_KEY_FEATURES.md).
