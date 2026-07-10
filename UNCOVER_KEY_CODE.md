# Uncovering What a Codebase Is About

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part H pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

- **Vocabulary / nomenclature discovery** — the project-specific terms a
  codebase centers on, surfaced by cross-document TF-IDF (with a
  per-function fallback for single-file / bundled corpora). A shipped
  cross-corpus catalog (`CE_cross_corpus_vocab_catalog.json`, auto-loaded from
  the repo root) sharpens this by *demoting* terms that recur across many
  codebases (`function`, `handler`, `data`) so genuinely distinctive terms
  rise — remove the file and results simply revert to the baseline.

- **Breadcrumbs** — telemetry markers (logging, analytics, audit calls) with
  their associated functions, useful for tracing what an obfuscated binary
  actually reports back.

- **Vocabulary** — TF-IDF-ranked domain-specific terms and nomenclature,
  surfacing what a codebase is "about" (`--vocabulary` / `--vocab`).
- **Metrics** — code-surfacing rankings (hotspots, complexity, most-called,
  domain-specific functions) for finding where to start reading.

*The bullets above are duplicated from `CODEEXAM_KEY_FEATURES.md`; the Overview and AI Overview features were not documented in the old README — Part H writes this page fresh.*
