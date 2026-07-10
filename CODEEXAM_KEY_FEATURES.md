# CodeExam Key Features

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part L pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

## Feature highlights

### Browse and search
- Function/file/class accordions; full-text, regex, and inverted-index
  (`--fast`) search.
- **Multisect**: find the smallest scope — function, class, or file —
  containing substantially all of N search terms. Each term can be
  hard-required, negated (`!term` / `NOT term`), or **soft** (`?term` —
  optional: it does not gate the result set but still boosts ranking). Prose
  — a patent claim, a design spec, a bug report — can be parsed directly into
  a multisect expression (`--claim-search`).
- **Cross-reference**: callers, callees, transitive call trees, file and
  folder coupling maps. Mermaid diagrams for call trees and coupling maps;
  individual caller/callee lists are tabular.
- **Function / class / file digests** — concise per-target summary (identity,
  callers, callees, distinctive strings, structural shape, inheritance chain +
  known subclasses for classes, imports/exports for files) usable standalone
  or as input to LLM prompts. Class digests walk the ancestor chain and
  surface known subclasses with method-override counts. (Reliable
  class-hierarchy tracking in static examination — especially for C++ — is
  still being hardened; see #65 and #60.)

### Metrics and code-surfacing

Where to start looking in an unfamiliar codebase. These are useful today but
under active refinement — some (notably hotspots and gaps) are still being
tuned toward their intended sharpness.

- **Hotspots / class hotspots / most-called** — complexity- and
  centrality-ranked functions and classes.
- **Domain-function ranking** and **entry points** — the functions most
  characteristic of, or at the edges of, the codebase.
- **Dead-code gaps** — references that don't resolve to indexed source,
  declared dependencies, or the standard library.
- **Vocabulary / nomenclature discovery** — the project-specific terms a
  codebase centers on, surfaced by cross-document TF-IDF (with a
  per-function fallback for single-file / bundled corpora). A shipped
  cross-corpus catalog (`CE_cross_corpus_vocab_catalog.json`, auto-loaded from
  the repo root) sharpens this by *demoting* terms that recur across many
  codebases (`function`, `handler`, `data`) so genuinely distinctive terms
  rise — remove the file and results simply revert to the baseline.

### Catalogs of "what does this code do" / "where should I start reading"

- **Command catalog** — detected CLI options, slash-commands, and (where
  recognizable) menu items and dialog actions in the target codebase, linked
  to handler functions or methods (so a `/skills` entry in a chat tool
  resolves to its actual handler in the source). Heuristic — some shapes
  (e.g., chained Commander.js declarations) are still under-detected.
- **Breadcrumbs** — telemetry markers (logging, analytics, audit calls) with
  their associated functions, useful for tracing what an obfuscated binary
  actually reports back.
- **AI/ML and LLM-app code** — extensive catalogs of the AI/ML and LLM-app
  constructs in a codebase (models, LLM calls, tools, chains, prompts, and
  more) — see *AI/ML and LLM-app detectors* below.
- **Vocabulary** — TF-IDF-ranked domain-specific terms and nomenclature,
  surfacing what a codebase is "about" (`--vocabulary` / `--vocab`).
- **Metrics** — code-surfacing rankings (hotspots, complexity, most-called,
  domain-specific functions) for finding where to start reading.
