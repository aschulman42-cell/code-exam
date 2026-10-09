# The CodeExam CLI

The command line is CodeExam's most complete surface — almost everything the GUI and MCP server do
maps to a CLI command, because they all drive the same engine. (Some commands output as text on the
CLI but as diagrams in the GUI.) This page is an overview of the CLI. An exhaustive list is available
via **`--help`**, which is always current: run `ce --help` for the full catalog, or `ce --help
<term>` to filter it.

**Looking for examples?** This page is an overview of the CodeExam CLI's *organization*. For worked
examples of running CLI commands, see [`GETTING_STARTED.md`](GETTING_STARTED.md).

## Ways to invoke it

- **One-shot** — `node src/index.js <command>`, or via the shim, `ce <command>`. Almost all commands
  need the name of an index, given with **`--index-path`** — e.g. `ce --index-path .foobar
  --functions`. Runs one command and exits. The shims ship in the repo root: **`ce`** (POSIX) /
  **`ce.bat`** (Windows) for the short name, and **`CodeExam`** / **`CodeExam.bat`** for the
  long-form help text — otherwise identical.
- **Interactive REPL** — `ce --interactive` (`-i`) keeps the index resident and takes slash-commands
  (`/extract`, `/callers`, `/file-map`, `/help`, …); a few are REPL-only. Keeping the index loaded
  matters on large codebases, where the load is the slow step.
- **In the GUI** — the GUI's **Console** tab runs many of these commands (not all) against the
  loaded index: you issue the REPL's `/`-commands, which resemble the CLI's `--`-commands, without
  leaving the window (see [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md)).

## The command families

The CLI surface groups into a handful of families, each documented in depth on its own page:

- **Search** — literal / `--fast` / `--regex` search and **multisect** →
  [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md).
- **Browse** — the structural lists, catalogs, cross-reference, and code-surfacing metrics →
  [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md).
- **Orient & summarize** — `--overview` and the `--digest` family →
  [`CODEEXAM_KEY_FEATURES.md`](CODEEXAM_KEY_FEATURES.md).
- **AI-assisted** — the `--analyze` family, `--claim-search`, masking, `--show-prompt` →
  [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md); the patent-claim workflow (claim charts,
  `--claim-locate`, …) → [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md).
- **Structure & duplicates** — funcstrings, fingerprints, dupe families →
  [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md).
- **AI/ML detection** — the model / LLM-app catalogs → [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).
- **Imports / exports / BoM** — the dependency surface and cross-index catalogs →
  [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md).
- **Other surfaces** — `--gui` launches the local GUI ([`CODEEXAM_GUI.md`](CODEEXAM_GUI.md)); the
  MCP server is `node src/mcp-server.js` ([`CODEEXAM_MCP.md`](CODEEXAM_MCP.md)).

## Cross-cutting flags and mechanics

These apply across commands.

### Choosing the index

- **`--index-path <name>`** — which index to query (or build). See
  [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md).
- **`--multi-index <@list>`** — run a command across several indexes in turn.

### Output and scripting

- Commands write to stdout, so shell redirection (`> out.txt`) and piping work.
- **`--max-results`** (aliases `--max`, `-n`) — sets the result limit. **You will often need this:**
  most CodeExam listings are capped by default, so a result that looks complete may just be the top
  N — raise the limit when absence matters (the same caution as
  [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md), #137). `--max-results 0` also lifts
  the cap.
- **`--all-results`** — lifts the per-scope cap entirely, so every result prints (no number to guess).
  Distinct from `-v` / `--verbose`, which expands per-item detail but keeps the cap.
- **`-v` / `--verbose`** — expands each row to show its underlying detail (e.g. every site behind a
  deduped row, with code snippets) rather than the summarized form.
- Bad input fails fast — CodeExam errors and exits non-zero *before* loading an index, so a mistyped
  command in a script won't half-run.

### Global modes

- **`--reproducible`** — pins the model side ([`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)).
- **`--air-gapped`** (with `--allow-connected`) — blocks all cloud AI ([`AIR_GAPPED.md`](AIR_GAPPED.md)).
- **`--llm <engine>`** — selects the **cloud** engine (Claude / ChatGPT / Gemini). A **local** GGUF is
  selected separately, with **`--model <gguf>`** [[placeholder: a CLI irregularity — a local model
  goes through `--model`, not `--llm local`; worth reconciling]].

## The full reference

This page is an overview; **`ce --help` is authoritative** and always current:

- `ce --help` — the complete command list; `ce --help <term>` filters it to matching entries.
- [`docs/cli.md`](cli.md) — a hand-maintained, annotated per-flag reference (a companion to
  `--help`, not a replacement for it).

*(The CLI's flag surface is being rationalized under #52 / #58; this page leans on command families
and points to `--help` precisely so it stays accurate as individual flags are renamed or
reorganized.)*

## Related

- [`GETTING_STARTED.md`](GETTING_STARTED.md) — install, and the four ways to run CodeExam.
- [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md) — the GUI the CLI mirrors (and whose Console runs an
  interactive subset of the CLI).
- [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md) — building and selecting the index every command reads.
