# Browsing a codebase in CodeExam

Search answers "where is the code that contains X?" In contrast, browsing answers the other
questions you have about an unfamiliar codebase: what is in here, where should I start reading, how
do its parts inter-connect? To help with this type of question, CodeExam builds a set of catalogs
and cross-reference views from the index, organized by component type (such as functions, classes,
commands, strings, AI/ML usage). In the GUI these are the left-pane accordions (see
[`CODEEXAM_GUI.md`](CODEEXAM_GUI.md)); on the CLI they are the commands below.

## The structural lists

The plain inventory of what the codebase defines. CodeExam ranks most of these by **importance
rather than alphabetically** — the alphabetical top of a large list is rarely what you're looking
for — so the most significant items surface first. ("Most important" is a heuristic, and of course
a matter of judgment.) The ranking is built from counts — how often an item occurs, how many other
things reference it, its length — with an **inverse-document-frequency (IDF)** weighting that
demotes common, generic items in favor of *distinctive* ones (names and strings specific to this
codebase rather than boilerplate). That count-based ranking is what makes **"searching by
counting"** possible: eyeballing the top of a sorted catalog to find what matters without knowing
its name (see also [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md)).

- **Functions** (`--functions [pattern]`) — the indexed functions, most-significant first by
  default; `--sort alpha` orders them alphabetically and `--sort size` by length.
- **Files** (`--files`) — the indexed files, with the same `--sort alpha` / `--sort size` control.
- **Classes** (`--classes`) — classes and structs with their method counts; the inheritance chain
  and known subclasses come from the class digest (see [`CODEEXAM_KEY_FEATURES.md`](CODEEXAM_KEY_FEATURES.md)).
- **Data structures** (`--data-structs`, alias `--structs`) — structs, enums, unions, typedefs,
  interfaces, traits, and records, ranked so the central types surface first.
- **Statistics** (`--stats`) — file, function, and line counts at a glance.

Two more specialized lists:

- **Extensions** (`--index-extensions`) — the file extensions present in the index. Extensions are
  the first hint of which languages a codebase is written in — a tree full of `.py` is Python, `.kt`
  Kotlin, `.go` Go. Related: when you **build** an index, CodeExam reports any text extensions it
  found but did **not** index by default, and tells you the `--add-extensions` list to rebuild with
  to include them (see [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md)).
- **Bundle seams** (`--bundle-seams`) — the recovered module boundaries inside a minified/bundled
  JavaScript file, so a single bundle reads as its component modules.

## The catalogs

The cross-cutting views that summarize a whole codebase at once, ranked by relevance or frequency.
Each row links back to where it occurs — and, importantly, to the **function or method** it sits in,
not merely a `file:line`.

- **Command catalog** (`--command-catalog`) — the target's own user-facing commands (CLI flags,
  slash-commands, and where recognizable menu/dialog actions), each linked to its handler, so a
  `/skills` command in a chat tool resolves to the function that implements it. Heuristic — some
  shapes (e.g. chained Commander.js declarations) are still under-detected.
- **Breadcrumbs** (`--breadcrumbs`) — telemetry markers (logging, analytics, audit calls) with
  their functions; useful for tracing what an obfuscated binary actually reports back.
- **Client / server** (`--client-server`, alias `--routes`) — the HTTP surface: declared server
  routes, client calls, and client calls with no matching route.
- **Referenced resources** (`--referenced-resources`, alias `--resources`) — the external surface:
  URLs and hosts, env vars, filesystem paths, external commands, cloud config, and model IDs — the
  things the code **points to but does not contain**. A high-signal case is **files referenced but
  not present in the index** (config, data, keys, templates), surfaced with their reference sites
  and how often each is referenced.
- **Strings** (`--string-table`, alias `--strings`) — the frequently-occurring string literals
  (optionally filtered by substring or `/regex/`), the distinctive strings that often fingerprint a
  library or pin down a behavior.
- **Imports / BoM** (`--imports`, `--bom`) — the dependency bill of materials; cross-index
  resolution against an export catalog is covered in [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md).
- **Prompts** (`--prompt-catalog`, alias `--prompts`) — LLM prompt strings found in the code.
- **AI/ML and LLM-app constructs** — the models, LLM calls, tools, chains, and prompts a codebase
  uses. Those are only examples: the **full catalog of detected AI/ML constructs is much larger** —
  see [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).
- **Vocabulary** — the distinctive domain terms; it doubles as a starting point, so it leads the
  next section.

Where a catalog is heuristic rather than mechanical, CodeExam says so, and marks individual
heuristic hits with compact notation (a leading `~`, and a few others). That notation is shared by
the CLI and the GUI. [[placeholder: the notation reference is moving to its own shared doc, linked
from here and from [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md).]] A catalog is a lead to follow, not a
finding to quote.

## Cross-reference: how the code inter-connects

- **`--callers` / `--callees`** — who calls a function, and what it calls, each an entry you can
  follow.
- **`--most-called`** — the most-frequently called functions and class methods, counted from
  **static references in the code, not dynamic runtime calls** (with an option to exclude
  external/library calls).
- **`--call-tree`** — the transitive call tree, multiple hops down plus the caller chains that
  reach a function.
- **`--file-map`** — file and folder coupling. In the GUI these render as diagrams; on the CLI
  `--file-map` prints the same information as text.

## Other places to start reading

CodeExam can also rank code by how central or how characteristic it is — useful for picking a
**starting point** into a codebase you've never seen. These **can be useful**, but they're one
signal among many, and some are still being tuned, so treat them as suggestions rather than
verdicts:

- **Vocabulary** (`--vocabulary` / `--vocab`) — the project-specific terms a codebase centers on,
  by cross-document TF-IDF; a shipped cross-corpus catalog demotes terms common across many
  codebases (`function`, `handler`, `data`) so genuinely distinctive terms rise. Often the quickest
  read of what a codebase is "about," and it feeds the Overview and search-term extraction (see
  [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md)).
- **Hotspots** (`--hotspots`) — complexity- and centrality-ranked functions (and class hotspots).
- **Domain functions** (`--domain-fns`) — the functions most characteristic of the codebase.
- **Entry points** (`--entry-points`) — defined-but-rarely-called functions: likely handlers,
  entry points, or dead code.
- **Dead-code gaps** (`--gaps`) — defined functions with no callers that aren't entry points.

## Related

- [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md) — the left pane, where these catalogs are browsed visually.
- [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md) — finding code by its text (the complement to
  browsing).
- [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md) — duplicate and structural detection.
- [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md) — the full AI/ML and LLM-app catalogs.
- [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md) — imports/exports catalogs across indexes.
