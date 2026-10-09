# CodeExam CLI Reference

This file is the canonical reference for every CodeExam command-line flag.

**Two purposes**:

1. **Documentation** — beyond what `--help` shows. Each flag gets a *what it's good for* sentence (the user intent it serves), not just its mechanics.
2. **Design input for [#52](https://github.com/aschulman42-cell/code-exam/issues/52)** — the inventory plus the *Couplings* section at the bottom surface the cross-flag irregularities that any CLI normalization will need to address.

**Source of truth**: `src/argparse.js`. Every entry below carries a *Verified against* line reference. `--help` output (in `src/argparse.js::printUsage`) is sanity-check material only — drift between `--help` and `argparse.js::defs` is a real possibility and should be reconciled when noticed.

**Status**: first pass generated 2026-05-24 (commit `a3fab8a`); updated 2026-05-24 for CLI normalization batch #1 (commit `2b47c79`); Path A audit pass 2026-05-24 rippled batch-#1 renames through cross-references and refreshed status markers; updated 2026-05-25 for target-aware `--digest` (#51, Commits A `070e894` + B `e565edd` + C `71051a7`); updated 2026-05-25 for `--comments-only` standalone form + COMMENTS gated behind `-v` in `--digest` + JSDoc kind distinction + walk-backward JSDoc-to-method attribution (#61, this commit). The file is meant to be hand-maintained by Andrew without agent assistance going forward.

---

## Conventions

- `<value>` — required argument
- `[value]` — optional argument; flag-without-value behaves as a defaulted form
- `<value>...` — repeatable list argument
- *(rationale unknown — investigate)* — naming or design choice whose history is not obvious from code or commit log; left as a trackable gap, not a silent omission

---

## INDEX MANAGEMENT

#### `--build-index <path>`

- **Does**: Builds a CodeExam index from a directory, a single file, a glob pattern, or `@filelist.txt` (one path per line).
- **Good for**: First-time indexing of a codebase. The entry point for nearly every workflow — every subsequent flag operates against the index produced here.
- **Couples with**: `--index-path`, `--extensions`, `--exclude-extensions`, `--demangler`, `--use-tree-sitter`, `--skip-semantic`, `--rename-min-lines`, `--no-rename`.
- **Naming**: verb-noun form (`--build-index`) keeps the namespace open for sibling actions on indexes (`--rebuild-functions`, `--build-rename-map`, `--indexes`). Without the verb, ambiguity grows fast.
- **Verified against**: `src/argparse.js:200`

#### `--rebuild-functions`

- **Does**: Rebuilds the function index from already-loaded file contents (the index's stored source) without re-walking the filesystem.
- **Good for**: Iterating on the function-parser logic without paying the file-walk cost. Pair with parser changes during development.
- **Couples with**: `--index-path` (operates on the existing index); `--use-tree-sitter` if the parser choice affects the rebuild.
- **Naming**: parallel to `--build-index` — explicit verb form.
- **Verified against**: `src/argparse.js:201`

#### `--build-rename-map`

- **Does**: (Re)infers descriptive names for an existing index — writes `rename_map.json` + `import_map.json` without rebuilding the index itself.
- **Good for**: Retro-fitting the rename overlays (_KW_, _CMD_, _IMPORT_, _NAME_) onto an existing index, e.g. after improving the inference code or after upgrading from a CodeExam version that didn't have a particular rename tier.
- **Couples with**: `--index-path`, `--rename-min-lines`. The `--no-rename` flag is independent — it disables display-time renames, not their generation.
- **Naming**: matches `--build-index` family. *(rationale unknown — investigate)* whether the asymmetry with the noun-only flags like `--digest` is intentional.
- **Verified against**: `src/argparse.js:202`

#### `--rename-min-lines <n>`

- **Does**: When (re)building the rename map, skips functions with `lineCount <= n`. `0` = no threshold (default).
- **Good for**: Tuning rename coverage vs. noise on short functions. Higher values reduce noisy renames on trivial 2-3 line wrappers; lower values cast a wider net.
- **Couples with**: `--build-rename-map` (only effective during rename inference, not during normal indexing).
- **Naming**: `--rename-min-lines` matches the implementation field name (`rename_min_lines`); kebab-case in user-facing form.
- **Verified against**: `src/argparse.js:203`

#### `--no-rename`

- **Does**: Disables display-time renames for this run; output uses raw obfuscated names.
- **Good for**: Reading code as the bundler wrote it, e.g. when cross-referencing against external tooling that doesn't know about CodeExam's rename overlays.
- **Couples with**: every output-producing flag (display side effect; doesn't affect index state).
- **Naming**: negation form (`--no-X`) common in Unix CLI tradition. Asymmetric: there's no `--rename` flag — renaming is the default; you opt out only.
- **Verified against**: `src/argparse.js:344`

#### `--index-path <path>`

- **Does**: Path to the index directory. Default: `.code_search_index` in the current working directory.
- **Good for**: Working with multiple indexes (one per project, per branch, per investigation). The most-used flag after `--build-index`.
- **Couples with**: every flag (defines the index that all subsequent operations target). Mutually exclusive with `--multi-index`.
- **Naming**: `--index-path` (path-shaped form). Could plausibly be `--index` (the most common usage) — *(rationale unknown — investigate)* whether the `-path` suffix was deliberate disambiguation.
- **Verified against**: `src/argparse.js:208`

#### `--multi-index @filelist`

- **Does**: Alternative to `--index-path`. Fans the rest of the command across many indexes. `@filelist` holds one index directory path per line; CodeExam runs the command against each and concatenates the output (per-index header, no aggregation).
- **Good for**: Cross-index investigations where you want the same query against several related codebases (e.g. cli.js across multiple versions of Claude Code). A run uses either `--index-path` or `--multi-index`, not both.
- **Couples with**: every read-only operation. Likely brittle with index-mutating operations (`--build-rename-map` etc.); behavior in that case *(verify)*.
- **Naming**: explicit "multi" prefix flags the cardinality difference. Could have been `--indexes @filelist` (plural) — *(rationale unknown — investigate)* — possibly to keep `--index*` as a single-index namespace.
- **Verified against**: `src/argparse.js:209`

#### `--skip-semantic`

- **Does**: Nominally skips semantic/embedding indexing. **Functionally a no-op today** — `skipSemantic` is plumbed through `src/core/CodeSearchIndex.js::buildIndex` (L1997) but no code in the buildIndex body branches on it. Semantic indexing was stubbed but never implemented; the default (`true`) and the flag are vestigial.
- **Good for**: Forward-compatibility / aspiration only. There is currently no way to *enable* semantic indexing via the CLI — the flag exists in the surface but does nothing. If/when semantic indexing actually lands, this entry needs an honest rewrite.
- **Couples with**: `--build-index` (nominally).
- **Naming**: negative-default form (`--skip-X`) signals the user is opting out of a default behavior; consistent with `--no-rename`.
- **Verified against**: `src/argparse.js:210`

#### `--use-tree-sitter`

- **Does**: Use tree-sitter for function parsing (in addition to or instead of the regex parser, depending on hybrid-merge logic).
- **Good for**: Higher-fidelity function boundary detection on languages with good tree-sitter grammars; trades regex's speed for accuracy.
- **Couples with**: `--build-index`, `--rebuild-functions`. Affects parser dispatch in `src/core/TreeSitterParser.js`.
- **Naming**: prefix `--use-X` — opting in to a feature.
- **Verified against**: `src/argparse.js:211`

#### `--extensions <exts>`

- **Does**: Comma-separated file extensions to index. Overrides the default extension list.
- **Good for**: Indexing files that aren't in the default extensions set, or restricting to a specific language family.
- **Couples with**: `--build-index`, `--exclude-extensions`. Interaction with `--scan-extensions` / `--index-extensions` is read-only inspection of extension data.
- **Naming**: noun-only — implies "the extensions to include." Asymmetric with `--exclude-extensions` (explicitly negated).
- **Verified against**: `src/argparse.js:212`

#### `--exclude-extensions <exts>`

- **Does**: Comma-separated extensions to exclude from the index.
- **Good for**: Trimming the index by skipping noisy or irrelevant file types (e.g. `--exclude-extensions json,md` to skip resource files).
- **Couples with**: `--build-index`, `--extensions`.
- **Naming**: explicit `--exclude-X` form (parallels `--include-path` / `--exclude-path`).
- **Verified against**: `src/argparse.js:213`

#### `--demangler <path>`

- **Does**: Path to a C++ name demangler executable (e.g. `vc++filt.exe`, `c++filt`).
- **Good for**: Indexing C++ binaries or codebases where mangled symbols would otherwise be opaque.
- **Couples with**: `--build-index` (used by `processBinary` in `src/binstrings.js`).
- **Naming**: noun-only; the path argument is the demangler binary itself.
- **Verified against**: `src/argparse.js:214`

---

## SEARCH

#### `--search <query>`

- **Does**: Hybrid search — literal + semantic.
- **Good for**: Default-mode search when you're not sure whether the query should be literal or semantic.
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`, `--full-path`, `--verbose`.
- **Naming**: bare `--search`; the *type* of search is implicit. Other search modes carry explicit type prefixes (`--literal`, `--fast`, `--regex`).
- **Verified against**: `src/argparse.js:216`

#### `--literal <query>`

- **Does**: Literal (exact-text) search.
- **Good for**: Finding an exact string in the indexed code — most common when you copy-paste from another source.
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: type-prefixed search variant.
- **Verified against**: `src/argparse.js:217`

#### `--fast <query>`

- **Does**: Fast inverted-index search.
- **Good for**: Quick scans across large indexes when speed matters more than fuzzy matching. Backed by the inverted-index data structure.
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: speed-property name (`--fast`) rather than mechanism name (`--inverted-index`) — user-intent framing.
- **Verified against**: `src/argparse.js:218`

#### `--regex <pattern>`

- **Does**: Regex pattern search.
- **Good for**: Pattern matches that literal and inverted-index searches can't express (alternation, character classes, lookahead).
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: mechanism name — there's no clearer user-intent alias.
- **Verified against**: `src/argparse.js:219`

#### `--files-search <query>`

- **Does**: Show files containing a term, sorted by hit count.
- **Good for**: "Which files have the most matches?" — a coarse navigation primitive when you need to triage by file before diving into a specific match.
- **Couples with**: `--max-results`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: noun-action form (`--files-search`); parallel with `--folders-search`.
- **Verified against**: `src/argparse.js:220`

#### `--folders-search <query>`

- **Does**: Show folders containing a term, sorted by hit count.
- **Good for**: Coarser version of `--files-search` — useful in large projects where folder-level grouping precedes file-level inspection.
- **Couples with**: `--max-results`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: parallel with `--files-search`.
- **Verified against**: `src/argparse.js:221`

---

## BROWSE

#### `--stats`

- **Does**: Show index statistics (file count, line count, function count, parse method, etc.).
- **Good for**: Quick sanity check on what the index contains, especially after `--build-index`.
- **Couples with**: independent of most other flags; respects `--index-path`.
- **Naming**: noun-only; common Unix idiom.
- **Verified against**: `src/argparse.js:223`

#### `--files [pattern]` (deprecated alias: `--list-files`)

- **Does**: List indexed files. Optional pattern filters by substring match on path.
- **Good for**: Confirming which files made it into the index; debugging extension or path-exclude misconfigurations.
- **Couples with**: `--max-results`, `--full-path`, `--filter` (overlaps with optional positional pattern), `--sort`.
- **Naming**: target-type-first (post-CLI-normalization). Old `--list-files` form still works but prints a deprecation warning to stderr.
- **Verified against**: `src/argparse.js:224`

#### `--show-file <pattern>`

- **Does**: Display entire file contents (matching the pattern).
- **Good for**: Reading a file's full source from the index without separate filesystem access — useful for piping to other tools or capturing a snapshot.
- **Couples with**: `--full-path`, rename overlays (`--no-rename`).
- **Naming**: `--show-file` (singular) vs. `--files` (plural) — semantic distinction maintained (one file's content vs. many files' names).
- **Verified against**: `src/argparse.js:225`

#### `--functions [pattern]` (deprecated alias: `--list-functions`)

- **Does**: List functions. Optional pattern filters by name substring. Pair with `--sort alpha|size` for ordering.
- **Good for**: The most common navigation primitive in CodeExam — "what functions exist in this code?", scoped by name.
- **Couples with**: `--max-results`, `--filter` (separate from positional pattern — surprisingly), `--include-path`, `--exclude-path`, `--full-path`, `--sort`.
- **Naming**: target-type-first (post-CLI-normalization). Old `--list-functions` form still works but prints a deprecation warning. Sort is now a modifier flag (`--functions --sort alpha`) rather than a compound name.
- **Verified against**: `src/argparse.js:226`

#### `--sort <mode>` (new)

- **Does**: Sort modifier for list commands. Accepts `alpha` (alphabetical) or `size` (line count, descending).
- **Good for**: Choosing ordering on `--functions` (and any future list command that gains sort support).
- **Couples with**: `--functions` primarily; future-extensible to `--files` and others.
- **Naming**: bare imperative verb. Replaces the compound suffixes `-alpha` / `-size`.
- **Verified against**: `src/argparse.js:244`

#### `--list-functions-alpha` *(deprecated)*

Deprecated alias. Use `--functions --sort alpha` instead. The old form continues to work but prints a one-time stderr warning. Sets both the legacy `list_functions_alpha` flag and the new `sort` field, so consumers reading either internal field work without change.

- **Verified against**: `src/argparse.js:227`

#### `--list-functions-size` *(deprecated)*

Deprecated alias. Use `--functions --sort size` instead. Same fan-out behavior as `--list-functions-alpha`.

- **Verified against**: `src/argparse.js:228`

#### `--extract <spec>`

- **Does**: Extract function source. `<spec>` is `FUNCTION` or `FILE@FUNCTION`.
- **Good for**: Pulling a specific function's full source for reading, piping, or inclusion in an LLM prompt.
- **Couples with**: `--deep` (canonical), `--comments-only`, rename overlays. `--follow-calls` is a deprecated alias for `--deep 1`.
- **Naming**: noun-only `--extract`. Could have been `--get-function` etc. — *(rationale unknown — investigate)*.
- **Verified against**: `src/argparse.js:229`

#### `--scan-extensions <path>`

- **Does**: Count file extensions in a directory (filesystem operation, not against an index).
- **Good for**: Pre-flight check before `--build-index` to see what's there.
- **Couples with**: independent — takes a filesystem path, not an index.
- **Naming**: `--scan-X` form — implies a filesystem scan vs. an index lookup.
- **Verified against**: `src/argparse.js:230`

#### `--index-extensions`

- **Does**: Count file extensions in the current index.
- **Good for**: Post-build verification: which extensions made it in. Complement to `--scan-extensions`.
- **Couples with**: `--index-path`.
- **Naming**: noun-noun form (`--index-extensions`) — first word is the data source, second is the data type. Inconsistent with `--scan-extensions` (verb-noun).
- **Verified against**: `src/argparse.js:231`

#### `--indexes [path]` (deprecated alias: `--list-indexes`)

- **Does**: List available index directories. Optional path narrows the scan.
- **Good for**: Discovering what indexes you've built when you've lost track of them.
- **Couples with**: independent; reads directory entries, not an index.
- **Naming**: target-type-first (post-CLI-normalization).
- **Verified against**: `src/argparse.js:232`

---

## CALLERS / CALLEES

#### `--callers <spec>`

- **Does**: Find callers of a function. `<spec>` is `FUNC` or `FILE@FUNC`.
- **Good for**: "Who calls this?" — the most common reverse-navigation question.
- **Couples with**: `--depth` (transitive callers), `--exclude-tests`, `--max-results`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: noun-only.
- **Verified against**: `src/argparse.js:249`

#### `--callees <spec>`

- **Does**: Find functions called by a function.
- **Good for**: "What does this call?" — the forward direction.
- **Couples with**: same as `--callers`.
- **Naming**: parallel.
- **Verified against**: `src/argparse.js:250`

#### `--most-called <n>`

- **Does**: Show top N most frequently called functions in the index.
- **Good for**: Finding the most-invoked APIs / utility functions — often the entry points to subsystems.
- **Couples with**: `--defined-only`, `--min-name-length`, `--include-macros`, `--exclude-tests`.
- **Naming**: superlative-form noun.
- **Verified against**: `src/argparse.js:251`

#### `--depth <n>`

- **Does**: Depth for command consumers that follow chains. Default is **consumer-specific** (no flag-level default): `--callers` uses 1, `--call-tree` / `--file-tree` use 3.
- **Good for**: Following call chains deeper than one hop.
- **Couples with**: `--callers` (default 1), `--call-tree` (default 3), `--file-tree` (default 3), `--deep` (related but separate flag for `--extract`).
- **Naming**: bare `--depth`. The per-consumer defaults are deliberate — different commands have different "natural" depths — but the user has to read each consumer's documentation to know which default applies. Post-CLI-normalization: explicit per-consumer defaults documented in `--help`.
- **Verified against**: `src/argparse.js:252`

#### `--min-name-length <n>`

- **Does**: Filter out short function names in `--most-called` results (default: 1).
- **Good for**: Suppressing noise from single-character or built-in-shadow names that pile up in minified code.
- **Couples with**: `--most-called` primarily.
- **Naming**: descriptive long form.
- **Verified against**: `src/argparse.js:253`

#### `--include-macros`

- **Does**: Include ALL_CAPS names in `--most-called` results.
- **Good for**: When macros / constants are part of what you want to see ranked.
- **Couples with**: `--most-called`.
- **Naming**: `--include-X` for opt-in.
- **Verified against**: `src/argparse.js:254`

#### `--defined-only`

- **Does**: With `--most-called`, only show functions that are defined in the index (i.e. not external/library calls).
- **Good for**: Focusing on the codebase's own functions; excluding `printf`, `console.log`, etc.
- **Couples with**: `--most-called`.
- **Naming**: hyphenated boolean-suffix form.
- **Verified against**: `src/argparse.js:255`

#### `--exclude-tests`

- **Does**: Exclude test files from callers/metrics results.
- **Good for**: Hotspot and caller scans where you want only production code, not test fixtures.
- **Couples with**: `--callers`, `--callees`, `--most-called`, `--hotspots`, `--gaps`, `--entry-points`, others. **Notable**: detection of "test file" is heuristic (path contains `test/`, file name starts with `test_`, etc.) — see Couplings.
- **Naming**: `--exclude-X` form (parallels `--exclude-path`).
- **Verified against**: `src/argparse.js:256`

#### `--call-inventory [spec]`

- **Does**: Show call targets partitioned into in-index vs. external. No argument: scan entire codebase (bill of materials). With function name: single-function inventory.
- **Good for**: "What does this code depend on?" — surfaces external calls (library APIs, builtins) as a flat list.
- **Couples with**: `--filter`, `--verbose`.
- **Naming**: noun phrase.
- **Verified against**: `src/argparse.js:259`

---

## GRAPH

#### `--call-tree <spec>`

- **Does**: Show call tree (callers up + callees down).
- **Good for**: Visualizing the full call neighborhood of a function in one view.
- **Couples with**: `--depth` (default: 3 for trees), `--mermaid`, `--exclude-tests`.
- **Naming**: noun phrase.
- **Verified against**: `src/argparse.js:257`

#### `--class-tree [filter]`

- **Does**: Show class inheritance hierarchy.
- **Good for**: Understanding inheritance chains across languages — particularly useful in indexed Java / Python / C++ codebases.
- **Couples with**: `--mermaid`, `--max-results`, `--filter`.
- **Naming**: noun phrase, parallel with `--call-tree`.
- **Verified against**: `src/argparse.js:258`

#### `--file-map [filter]`

- **Does**: Show file-level dependency map.
- **Good for**: Module-level orientation in a codebase — which files import from which.
- **Couples with**: `--mermaid`, `--max-results`, `--filter`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:260`

#### `--file-tree <file>`

- **Does**: Show file dependency tree (one file's transitive imports).
- **Good for**: Single-file dependency walk; complement to `--file-map`.
- **Couples with**: `--depth`, `--mermaid`.
- **Naming**: parallel with `--file-map`.
- **Verified against**: `src/argparse.js:261`

#### `--mermaid`

- **Does**: Output a Mermaid diagram instead of text.
- **Good for**: Generating renderable graphs for README files or visual review. Pairs with any tree/map command.
- **Couples with**: `--call-tree`, `--class-tree`, `--file-map`, `--file-tree`. **Notable**: doesn't do anything if no graph command is in play — silent no-op.
- **Naming**: tool-name (lowercase).
- **Verified against**: `src/argparse.js:262`

---

## METRICS / DISCOVERY

#### `--hotspots <n>`

- **Does**: Top N structurally important functions (`calls × log2(lines)` score).
- **Good for**: Finding load-bearing functions — where complexity and connectivity intersect.
- **Couples with**: `--exclude-tests`, `--filter`, `--include-path`, `--exclude-path`, `--max-results`.
- **Naming**: bare noun.
- **Verified against**: `src/argparse.js:265`

#### `--hot-folders <n>`

- **Does**: Top N directories by aggregated hotspot score.
- **Good for**: Hotspot rollup at the folder level — useful when looking for the heavy subsystems.
- **Couples with**: same as `--hotspots`.
- **Naming**: prefixed with `hot-` to mirror `--hotspots`.
- **Verified against**: `src/argparse.js:266`

#### `--entry-points <n>`

- **Does**: Top N uncalled functions (sorted by size); functions with zero callers.
- **Good for**: Identifying the "main" entry surfaces of a codebase (CLI handlers, exported APIs, dispatched callbacks).
- **Couples with**: `--max-calls`, `--exclude-tests`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:267`

#### `--max-calls <n>`

- **Does**: Maximum call count threshold for `--entry-points` (default: 0 = strictly never called).
- **Good for**: Loosening the entry-points definition; "≤2 callers" sometimes captures real entry points that have one helper.
- **Couples with**: `--entry-points`.
- **Naming**: `max-X` form, parallel with `--max-results`.
- **Verified against**: `src/argparse.js:268`

#### `--gaps [n]`

- **Does**: Find suspicious dead code — defined, no callers, not an entry-point.
- **Good for**: Dead-code triage at scale; complement to the manual sweep done in issue #50.
- **Couples with**: `--max-results`, `--exclude-tests`.
- **Naming**: terse noun. *(rationale unknown — investigate)* — "gaps" is metaphorical for "gaps in the call graph"; less self-documenting than `--dead-code`.
- **Verified against**: `src/argparse.js:269`

#### `--domain-fns <n>`

- **Does**: Top N domain-specific functions (`score / sqrt(name defs)`).
- **Good for**: Surfacing functions whose names are distinctive in the codebase's vocabulary — often the domain logic core.
- **Couples with**: `--max-results`, `--filter`.
- **Naming**: abbreviation `fns` instead of `functions` — *(rationale unknown — investigate)* but probably aesthetic / typing-efficiency.
- **Verified against**: `src/argparse.js:270`

#### `--classes` (deprecated alias: `--list-classes`)

- **Does**: List all classes with method counts/sizes.
- **Good for**: Class-level overview of an OO codebase.
- **Couples with**: `--filter`, `--max-results`, `--include-path`, `--exclude-path`.
- **Naming**: target-type-first. Post-CLI-normalization, this completes the symmetric noun-only set with `--functions`, `--files`, `--indexes`.
- **Verified against**: `src/argparse.js:271`

#### `--class-hotspots <n>`

- **Does**: Top N classes by aggregated method hotspot score.
- **Good for**: Class-level rollup of `--hotspots`; finds the most complex classes.
- **Couples with**: same as `--hotspots`.
- **Naming**: prefix `class-` modifier on `--hotspots`.
- **Verified against**: `src/argparse.js:272`

#### `--vocabulary <n>` (short alias: `--vocab`; deprecated alias: `--discover-vocabulary`)

- **Does**: Top N domain-specific tokens by TF-IDF score.
- **Good for**: Surfacing the unique vocabulary of a codebase — input to claim-search term selection and to multisect query crafting.
- **Couples with**: `--vocab-tight`, `--in` (path filter), `--no-vocabulary` (disables it as input to other commands).
- **Naming**: noun-only canonical (post-CLI-normalization). `--vocab` is kept as a documented short alias (no deprecation warning); `--discover-vocabulary` is deprecated and warns on use.
- **Verified against**: `src/argparse.js:273`

#### `--multisect-search <terms>` (alias: `--multisect`)

- **Does**: Multi-term intersection search — finds smallest scope (function / class / file / folder) containing the terms. Terms semicolon-separated; `/regex/` for regex; `NOT` / `!` to negate.
- **Good for**: "Find the place where all these things happen together" — the headline CodeExam search primitive.
- **Couples with**: `--match-renames`, `--in` (path filter), `--min-terms`, `--max-results`, `--dedup`, `--filter`.
- **Naming**: noun-noun. Alias `--multisect` reflects the dominant usage.
- **Verified against**: `src/argparse.js:274`

#### `--in <pattern>`

- **Does**: Universal path filter — restricts search, multisect, and vocabulary output to files whose path contains `<pattern>`.
- **Good for**: Quick scoping to a subdirectory without remembering which flag's `--include-path` to use.
- **Couples with**: `--multisect-search`, `--search`, `--vocabulary`, others. **Notable**: parsed as `vocab_in` internally — naming asymmetry.
- **Naming**: very terse two-letter form — `--in` reads naturally in a sentence ("multisect *in* `src/core/`"). *(rationale unknown — investigate)* whether this should be unified with `--include-path`.
- **Verified against**: `src/argparse.js:275`

#### `--show-dupes`

- **Does**: Show file duplicate paths in output.
- **Good for**: Debugging cases where the index contains duplicate copies of files (vendored libraries, parallel builds).
- **Couples with**: many display paths.
- **Naming**: hyphenated boolean.
- **Verified against**: `src/argparse.js:276`

---

## DISPLAY / FILTERING

These modify how query results are rendered. They don't affect index state.

#### `--max-results <n>` (aliases: `--max`, `-n`)

- **Does**: Maximum results to display (default: 20).
- **Good for**: Cutting noise; deeper exploration via raising the cap.
- **Couples with**: every list-producing command.
- **Naming**: long form `--max-results`; short alias `-n`. Multiple aliases reflect frequent use.
- **Note**: `--max-results 0` means no cap.
- **Verified against**: `src/argparse.js:234`

#### `--all-results`

- **Does**: Lifts the per-scope result cap entirely — every result prints, with no number to guess.
- **Good for**: "just show me everything" without picking an N; equivalent to `--max-results 0`.
- **Couples with**: the search / multisect commands and the string & resource catalogs today; rollout to every capped command is in progress.
- **Not**: `-v` / `--verbose`, which expands per-item detail but keeps the cap.

#### `--context <n>`

- **Does**: Context lines around matches (default: 3).
- **Good for**: Reading match context inline without re-running with `--extract`.
- **Couples with**: search commands.
- **Naming**: bare noun.
- **Verified against**: `src/argparse.js:235`

#### `--verbose` (alias: `-v`)

- **Does**: Show extra detail (varies per command — extra fields, expanded sections, etc.).
- **Good for**: Drill-down when default output is too compact.
- **Couples with**: many commands; semantics differ per command.
- **Naming**: bare adjective, short alias `-v` (universal Unix convention).
- **Verified against**: `src/argparse.js:236`

#### `--full-path`

- **Does**: Show full file paths in output (instead of truncated/relative).
- **Good for**: When path disambiguation matters (large monorepos, multiple files with the same name).
- **Couples with**: every output-producing command.
- **Naming**: hyphenated boolean.
- **Verified against**: `src/argparse.js:237`

#### `--filter <text>`

- **Does**: Filter function listings by name.
- **Good for**: Narrowing list output without re-running with a different positional pattern. Often redundant with positional pattern, depending on command.
- **Couples with**: most list / search commands. **Notable**: overlaps with positional pattern in `--functions [pattern]` — see Couplings.
- **Naming**: bare verb-noun.
- **Verified against**: `src/argparse.js:238`

#### `--include-path <patterns>...`

- **Does**: Only include paths containing pattern(s). Repeatable list argument.
- **Good for**: Restricting scope to certain subdirectories or file naming patterns. More precise than `--in` for multi-pattern filters.
- **Couples with**: most query commands. Overlap with `--in` and `--filter` — see Couplings.
- **Naming**: `--include-X` for opt-in, parallels `--exclude-path`.
- **Verified against**: `src/argparse.js:239`

#### `--exclude-path <patterns>...`

- **Does**: Exclude paths containing pattern(s).
- **Good for**: Skipping vendored code, test directories, or other noise.
- **Couples with**: same as `--include-path`.
- **Naming**: parallels `--include-path`.
- **Verified against**: `src/argparse.js:240`

#### `--dedup <mode>`

- **Does**: Dedup mode for query results: `none`, `exact`, `structural`.
- **Good for**: Suppressing duplicate hits when the codebase contains vendored copies or near-duplicate functions.
- **Couples with**: most query commands.
- **Naming**: bare noun.
- **Verified against**: `src/argparse.js:241`

#### `--min-terms <n>`

- **Does**: For multisect-style searches, the minimum number of positive terms a scope must contain to be reported.
- **Good for**: Partial-match multisect (find scopes containing N of K terms, not all K).
- **Couples with**: `--multisect-search`, `--claim-analyze`.
- **Naming**: terse.
- **Verified against**: `src/argparse.js:242`

#### `--match-renames`

- **Does**: For multisect, also match against rename-rendered source (in addition to raw source).
- **Good for**: Finding hits via the inferred display names (e.g. `_CMD_AMAZON_BEDROCK`) when the literal source uses opaque names.
- **Couples with**: `--multisect-search`, `--multisect-analyze`.
- **Naming**: bare verb-noun.
- **Verified against**: `src/argparse.js:243`

---

## MODE

#### `--interactive` (alias: `-i`)

- **Does**: Start the interactive REPL mode. Auto-enters if no command is given and an index exists.
- **Good for**: Exploratory sessions where multiple commands run against the same loaded index.
- **Couples with**: independent (replaces all command flags with REPL input).
- **Naming**: `-i` short alias universal in shell tradition.
- **Verified against**: `src/argparse.js:246`

---

## CLAIM SEARCH (LLM-based)

#### `--claim-search <text>`

- **Does**: Extract search terms from patent claim text (or `@file.txt`). LLM-based.
- **Good for**: Patent-litigation use case — turn a claim's natural language into multisect-ready terms.
- **Couples with**: `--llm`, `--model`, `--api-key`, `--temperature`, `--vocab-tight`, `--no-vocabulary`, `--show-prompt`. (`--use-claude` and `--claim-model` are deprecated aliases for `--llm claude` and `--model` respectively.)
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:279`

#### `--claim-file <path>`

- **Does**: Read patent claim text from file. Specific to the claim-search code path.
- **Good for**: When the claim is long or contains special characters that shell quoting can't handle, and you want explicit "this is a file path" semantics rather than the `--claim-search @file.txt` shorthand.
- **Couples with**: `--claim-search`. The `@file.txt` shorthand on `--claim-search` overlaps functionally but goes through a different code branch — both are supported because they were not actually redundant (see Couplings note below; my earlier deprecation framing was wrong).
- **Naming**: noun-noun. Distinct first-class flag, not an alias.
- **Verified against**: `src/argparse.js:280`

#### `--llm <provider>` (new — replaces `--use-claude`)

- **Does**: Select cloud LLM provider for term extraction and analysis. Currently `claude` is the only recognized provider; the flag's existence is the foundation for future providers (`codex`, etc.) without further argparse changes.
- **Good for**: Cloud LLM path. **In litigation contexts (CodeClaim per #23), this is verboten** — use local GGUF via `--model` instead.
- **Couples with**: `--claim-search`, `--claim-analyze`, `--analyze`, `--multisect-analyze`, `--file-analyze`. `--api-key` provides the credential.
- **Naming**: bare noun (`--llm <name>`). Vendor-neutral by design; opens space for additional providers.
- **Verified against**: `src/argparse.js:282`

#### `--use-claude` *(deprecated)*

Deprecated alias. Use `--llm claude` instead. The old form continues to work but prints a one-time stderr warning. Post-parse, the value is fanned out so both `args.use_claude = true` and `args.llm = 'claude'` are set, keeping legacy consumers working.

- **Verified against**: `src/argparse.js:281`

#### `--api-key <key>`

- **Does**: Anthropic API key, overrides `ANTHROPIC_API_KEY` env var. *(Wording is current-state-vendor-specific; once `--llm` admits a second provider, this entry and the underlying env-var lookup will need to generalize. Not in scope for this audit pass.)*
- **Good for**: Per-run key override (e.g. testing with a sandbox key).
- **Couples with**: `--llm`.
- **Naming**: vendor-neutral.
- **Verified against**: `src/argparse.js:283`

#### `--model <path.gguf>` (new — unifies `--claim-model` and `--analyze-model`)

- **Does**: Local GGUF model path for both term extraction (claim search) and analysis (`--analyze`, `--multisect-analyze`, `--file-analyze`). Single source for both pipelines.
- **Good for**: Air-gapped LLM operation (the litigation default). One flag for the common case where the same model serves both roles.
- **Couples with**: `--claim-search`, `--claim-analyze`, `--analyze`, `--multisect-analyze`, `--file-analyze`. Post-parse, fans out to both `args.claim_model` and `args.analyze_model` for legacy consumers.
- **Naming**: bare noun. Replaces the artificial split into per-pipeline model flags.
- **Verified against**: `src/argparse.js:284`

#### `--claim-model <path.gguf>` *(deprecated; alias: `--term-extract-model` also deprecated)*

Deprecated alias for `--model`. Continues to work; sets `args.claim_model` and (if `args.model` not already set) populates `args.model` for cross-pipeline consumers. Use `--model` instead. The two-flag pattern survives for users who genuinely need different models for term extraction vs. analysis.

- **Verified against**: `src/argparse.js:285`

#### `--temperature <float>`

- **Does**: LLM temperature (default: 0.0).
- **Good for**: Loosening LLM determinism for exploratory term generation.
- **Couples with**: every LLM-using flag.
- **Naming**: standard LLM-API term.
- **Verified against**: `src/argparse.js:286`

#### `--show-prompt`

- **Does**: Display the LLM prompt and exit (no API call).
- **Good for**: Auditing what gets sent to the LLM — reproducibility, prompt-engineering iteration, and litigation context (showing court what was asked).
- **Couples with**: `--claim-search`, `--analyze`, others using LLM.
- **Naming**: imperative verb-noun.
- **Verified against**: `src/argparse.js:287`

#### `--vocab-tight`

- **Does**: Also use codebase vocabulary for TIGHT term generation (default: vocabulary only influences BROAD terms).
- **Good for**: Tighter term sets that lean on codebase-specific vocabulary (vs. claim-only language).
- **Couples with**: `--claim-search`, `--claim-analyze`.
- **Naming**: composite (vocab + tight).
- **Verified against**: `src/argparse.js:288`

#### `--no-vocabulary` (alias: `--no-vocab`)

- **Does**: Disable codebase vocabulary in term-extraction prompts.
- **Good for**: A/B testing whether vocabulary guidance helps. Defaults that include vocabulary can be toggled off.
- **Couples with**: `--claim-search`, `--claim-analyze`.
- **Naming**: `--no-X` negation form.
- **Verified against**: `src/argparse.js:289`

---

## LLM ANALYSIS

#### `--analyze <function>`

- **Does**: Analyze a function with LLM ("what does this do?").
- **Good for**: Per-function natural-language summarization, especially of obfuscated or unfamiliar code.
- **Couples with**: `--model`, `--llm`, `--with`, `--with-digest`, `--mask-all`, `--line-numbers`. (`--analyze-model` and `--use-claude` are deprecated aliases for `--model` and `--llm claude` respectively.)
- **Naming**: bare verb.
- **Verified against**: `src/argparse.js:292`

#### `--claim-analyze <claim>`

- **Does**: End-to-end patent claim analysis: extract terms → search → analyze top matches.
- **Good for**: The full claim-search-and-explain pipeline in one command.
- **Couples with**: all LLM flags, all multisect flags.
- **Naming**: noun-verb.
- **Verified against**: `src/argparse.js:293`

#### `--multisect-analyze <terms>`

- **Does**: Search for functions matching multisect terms, analyze top hits with LLM.
- **Good for**: When you have terms already (not a patent claim) and want the analyze pipeline.
- **Couples with**: same as `--multisect-search` plus LLM flags.
- **Naming**: noun-verb, parallels `--claim-analyze`.
- **Verified against**: `src/argparse.js:294`

#### `--file-analyze <filepath>`

- **Does**: Analyze an entire source file with LLM.
- **Good for**: File-level summarization (especially with `--mask-all` for confidentiality).
- **Couples with**: LLM flags, `--mask-all`.
- **Naming**: parallels other `*-analyze` forms.
- **Verified against**: `src/argparse.js:295`

#### `--analyze-model <path.gguf>` *(deprecated)*

Deprecated alias for `--model`. Continues to work; sets `args.analyze_model` and (if `args.model` not already set) populates `args.model`. Use `--model` instead.

- **Verified against**: `src/argparse.js:296`

#### `--with <text>` (alias: `--context-text`)

- **Does**: Context text for `--analyze` (patent claim, description, etc.). Supports `@file.txt` syntax.
- **Good for**: Asking "what does this function do *in relation to this thing*?" — the analyze prompt becomes context-aware.
- **Couples with**: `--analyze`, others.
- **Naming**: very terse preposition (`--with`). *(rationale: reads naturally — "analyze X with Y".)*
- **Verified against**: `src/argparse.js:297`

#### `--mask-all`

- **Does**: Strip comments and mask string contents before sending to LLM.
- **Good for**: Confidentiality — avoiding sending verbatim source to a cloud LLM in litigation contexts.
- **Couples with**: any `*-analyze` command.
- **Naming**: imperative verb-pronoun.
- **Verified against**: `src/argparse.js:298`

#### `--line-numbers`

- **Does**: Include source line numbers in the LLM prompt.
- **Good for**: When the LLM's response needs to reference specific lines.
- **Couples with**: `*-analyze` commands.
- **Naming**: bare noun-noun.
- **Verified against**: `src/argparse.js:299`

#### `--claim-text <text>`

- **Does**: Patent claim text for `--claim-analyze` (or `@file.txt`). Distinct code path from `--with`.
- **Good for**: Feeding the claim-analyze pipeline specifically. Where `--with` sets `args.analyze_context` (consumed by the general `--analyze` flow), `--claim-text` sets `args.claim_text` (consumed by the claim-analyze flow at `src/commands/analyze.js:1236`). They look interchangeable from a user perspective but route to different downstream code.
- **Couples with**: `--claim-analyze`.
- **Naming**: noun-noun. First-class flag — earlier framing as "deprecated alias for --with" was wrong; the two flags have distinct consumers.
- **Verified against**: `src/argparse.js:300`

#### `--with-digest`

- **Does**: Prepend `--digest` output (static-analysis facts) to the `--analyze` prompt.
- **Good for**: A/B testing the effect of CodeExam-provided context on local-LLM analysis quality. Composable with `--with`, `--mask-all`.
- **Couples with**: `--analyze`, `--with`, `--mask-all`.
- **Naming**: composer prefix `--with-X`.
- **Verified against**: `src/argparse.js:301`

---

## EXTENDED EXTRACTION

#### `--follow-calls` *(deprecated)*

Deprecated alias for `--deep 1`. Continues to work; post-parse, sets `args.deep = '1'` when used. Use `--deep [N]` instead — same behavior with explicit depth control.

- **Verified against**: `src/argparse.js:304`

#### `--deep [N]`

- **Does**: With `--extract`, also dump source of callees N levels deep (default: 1).
- **Good for**: Getting a function plus its dependencies in one extraction — useful for LLM prompts that need full context. Deeper N follows the call chain N levels.
- **Couples with**: `--extract`. Canonical form post-batch-#1; `--follow-calls` is a deprecated alias equivalent to `--deep 1`.
- **Naming**: bare adjective. Subsumed the older `--follow-calls` flag.
- **Verified against**: `src/argparse.js:305`

#### `--comments-only [target]`

- **Does**: Two forms. **Standalone**: `--comments-only <target>` prints just the comments inside the named target (function / class / file), organized as a map. **Modifier** (legacy): `--extract X --comments-only` shows only full-line comments from the extracted function's body. The two coexist; the flag's type is `optional_value` so it accepts an arg or stands alone with `--extract`.
- **Good for**: Reading a function's intent without its implementation (legacy modifier form). Generating a "map" or "recipe" view of a class or file — per-method or per-top-level-declaration subtitles with comments indented under each, useful as documentation prep or to verify whether code's own comments form a coherent guide to its behavior (standalone form, target-aware).
- **Couples with**: `--extract` (modifier form). `--digest --verbose` (alternative: inline the same comments inside the digest). The standalone form dispatches via the same `buildDigest` target-classifier as `--digest`.
- **Naming**: same flag name serves both forms; behavior differentiated by arg presence.
- **Parser note**: a function's comments-only output depends on which lines the parser recorded as part of the function. JSDoc comments *immediately before* the function declaration are typically included by tree-sitter but may be excluded by the regex parser. Output is faithful to whatever the parser recorded.
- **Tag distinction**: each comment line is tagged by kind — `// ` for line comments, `/**` for JSDoc blocks (both multi-line `/** ... */` and single-line `/** foo */`), and `/* ` for regular non-JSDoc block comments. JSDoc visibility in the output is useful for spotting the structured intent of methods at a glance when reading a class/file as a map.
- **JSDoc attribution (class / file)**: a JSDoc block (or any contiguous comment block) immediately preceding a method or top-level declaration is attributed to that method/decl in the output instead of falling under `(class scope)` / `(file scope)`. The renderer walks backward from each method's `startLine` through contiguous comment-occupied lines (using a `commentLines` line-set the extractor exposes on the digest) and extends the method's effective start to the top of the block. Walk-backward is capped at the previous method's `endLine + 1`, so attribution never overshoots.
- **Verified against**: `src/argparse.js:306`

---

## DEDUP / DUPLICATES

#### `--dupefiles <n>`

- **Does**: Top N duplicate file groups by SHA1 hash.
- **Good for**: Identical file detection across an index (vendored libraries, copy-pasted modules).
- **Couples with**: `--max-results`.
- **Naming**: bare noun.
- **Verified against**: `src/argparse.js:309`

#### `--func-dupes <n>`

- **Does**: Top N exact-duplicate function groups (SHA1 body hash).
- **Good for**: Identical function detection within the index.
- **Couples with**: `--max-results`.
- **Naming**: abbreviated noun-noun.
- **Verified against**: `src/argparse.js:310`

#### `--near-dupes <n>`

- **Does**: Top N near-duplicate function groups (same name+size, different body).
- **Good for**: Finding functions that *should* be the same but drifted.
- **Couples with**: same as `--func-dupes`.
- **Naming**: parallels `--func-dupes`.
- **Verified against**: `src/argparse.js:311`

#### `--struct-dupes <n>`

- **Does**: Top N structural dupe groups (same structure, different names/values).
- **Good for**: Cross-codebase function similarity detection — finds functions whose shape matches even after rename / refactor.
- **Couples with**: `--show-funcstring`, `--struct-diff`, `--struct-diff-all`, `--show-sources`, `--cross-source-only`.
- **Naming**: abbreviated `struct-` prefix.
- **Verified against**: `src/argparse.js:312`

#### `--show-funcstring [name|hash]`

- **Does**: Show the structural funcstring for a function (by name or hash). Bare flag falls back to struct-dupes results.
- **Good for**: Reading the structural fingerprint of a specific function.
- **Couples with**: `--struct-dupes`, `--funcstr-hashes`.
- **Naming**: verb-noun.
- **Verified against**: `src/argparse.js:313`

#### `--struct-diff <name>`

- **Does**: Show word-hole differences between structural dupe variants.
- **Good for**: When you've found a structural dupe group and want to see what differs.
- **Couples with**: `--struct-dupes`.
- **Naming**: parallels `--struct-dupes`.
- **Verified against**: `src/argparse.js:314`

#### `--struct-diff-all <n>`

- **Does**: One-line diff summaries for top N structural dupe groups.
- **Good for**: High-level overview of all dupe-group differences.
- **Couples with**: `--show-sources`, `--cross-source-only`.
- **Naming**: same family.
- **Verified against**: `src/argparse.js:315`

#### `--show-sources`

- **Does**: With `--struct-diff-all` / `--string-call-diff-all`, list each variant's filepath:line so cross-codebase matches are visible.
- **Good for**: Disambiguating which source each variant came from in cross-codebase analysis.
- **Couples with**: `--struct-diff-all`, `--string-call-diff-all`.
- **Naming**: imperative verb-noun.
- **Verified against**: `src/argparse.js:316`

#### `--cross-source-only`

- **Does**: With `*-diff-all`, filter to clusters whose members span 2+ distinct sources.
- **Good for**: Hiding within-project duplicates to focus on cross-project matches.
- **Couples with**: `--struct-diff-all`, `--string-call-diff-all`.
- **Naming**: hyphenated boolean.
- **Verified against**: `src/argparse.js:317`

#### `--string-call-dupes <n>`

- **Does**: Top N groups of functions sharing an EXACT string-call fingerprint (distinctive string literals + called-name tokens).
- **Good for**: Semantic-signature matching even when structure has been reshaped (bundlers/minifiers).
- **Couples with**: `--string-call-diff-all`, `--show-sources`, `--cross-source-only`.
- **Naming**: compound `string-call-` prefix.
- **Verified against**: `src/argparse.js:318`

#### `--string-call-diff-all <n>`

- **Does**: Detailed string-call dupe output.
- **Good for**: Detailed view of the matches that `--string-call-dupes` summarizes.
- **Couples with**: `--show-sources`, `--cross-source-only`.
- **Naming**: parallels `--struct-diff-all`.
- **Verified against**: `src/argparse.js:319`

#### `--cmp-string-call-dupes <score>`

- **Does**: Jaccard SIMILARITY comparison (fuzzy). Finds cross-source function pairs whose fingerprints overlap by score ≥ `<score>`.
- **Good for**: Deobfuscating bundled code against its source libraries.
- **Couples with**: `--fingerprint-work`, `--fingerprint-ref`, `--fingerprint-min-tokens`, `--show-tokens`, `--load-fingerprints`.
- **Naming**: `--cmp-X` prefix for "compare".
- **Verified against**: `src/argparse.js:320`

#### `--notable-funcstr-matches <n>`

- **Does**: Top N "notable funcstring matches": groups of functions sharing a structural funcstring whose members are surprising (different names and/or distant file paths).
- **Good for**: Finding cross-codebase function reuse with surprising rename patterns.
- **Couples with**: `--nf-min-lines`, `--nf-min-surprise`, `--nf-sort`, `--nf-tight`, `--filter`.
- **Naming**: long descriptive name. The `--nf-*` modifier flags use an abbreviated namespace — see Couplings.
- **Verified against**: `src/argparse.js:321`

#### `--nf-min-lines <n>` / `--nf-min-surprise <f>` / `--nf-sort <peak|mean|lines>` / `--nf-tight`

- **Does**: Modifier flags for `--notable-funcstr-matches`. `--nf-min-lines` filters by minimum function size; `--nf-min-surprise` filters by peak threshold; `--nf-sort` chooses ranking; `--nf-tight` uses stricter structural hashing.
- **Good for**: Tuning the notable-funcstr search to a specific corpus or use case.
- **Couples with**: `--notable-funcstr-matches` (only meaningful in combination).
- **Naming**: abbreviated `nf-` namespace.
- **Verified against**: `src/argparse.js:318-321`

#### `--funcstr-hashes <min-lines>`

- **Does**: Dump one tab-separated row per function ≥ `<min-lines>` long: `struct_hash, body_hash, lines, name, filepath`. Quiet, header-less output meant for piping.
- **Good for**: Cross-index funcstring intersection via shell pipelines (`awk`, `sort`, `join`).
- **Couples with**: `--fh-tight`. Independent of the index modifications; pure data dump.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:326`

#### `--fh-tight`

- **Does**: With `--funcstr-hashes`, use the stricter structural hash.
- **Good for**: Comparison with results from `--nf-tight` etc. when consistency of hashing strictness matters.
- **Couples with**: `--funcstr-hashes`.
- **Naming**: abbreviated `fh-` namespace.
- **Verified against**: `src/argparse.js:327`

#### `--fingerprint-min-tokens <n>`

- **Does**: With `--cmp-string-call-dupes` / `--build-fp-renames`, reject functions with fingerprint sizes below `<n>`.
- **Good for**: Avoiding false positives from tiny-fingerprint functions where random overlap can score high.
- **Couples with**: `--cmp-string-call-dupes`, `--build-fp-renames`.
- **Naming**: long descriptive form.
- **Verified against**: `src/argparse.js:328`

#### `--fingerprint-work <pattern>` / `--fingerprint-ref <pattern>`

- **Does**: Scope the work side / ref side of fingerprint comparisons by source-label pattern.
- **Good for**: Restricting cross-source comparisons to specific reference libraries.
- **Couples with**: `--cmp-string-call-dupes`, `--build-fp-renames`.
- **Naming**: parallels — `work` and `ref` (reference) sides.
- **Verified against**: `src/argparse.js:325-326`

#### `--show-tokens`

- **Does**: With `--cmp-string-call-dupes`, display the shared tokens for each match.
- **Good for**: Auditing why a fingerprint match scored high.
- **Couples with**: `--cmp-string-call-dupes`.
- **Naming**: imperative verb-noun.
- **Verified against**: `src/argparse.js:331`

#### `--build-fp-renames [score]` (alias: `--build-fingerprint-renames`)

- **Does**: Generate `_FP_` rename-map entries for cross-source fingerprint matches above score `<score>` (default: 0.8).
- **Good for**: Adding fingerprint-derived renames to an existing rename map.
- **Couples with**: `--dry-run`, `--fp-classes`, `--clean-fp`, `--fingerprint-min-tokens`, `--load-fingerprints`, `--fingerprint-work`, `--fingerprint-ref`.
- **Naming**: parallels `--build-rename-map`.
- **Verified against**: `src/argparse.js:332`

#### `--dry-run`

- **Does**: With `--build-fp-renames`, show what would be written without modifying `rename_map.json`.
- **Good for**: Preview before commit. Universal Unix idiom.
- **Couples with**: `--build-fp-renames`.
- **Naming**: standard idiom.
- **Verified against**: `src/argparse.js:333`

#### `--fp-classes`

- **Does**: With `--build-fp-renames`, also propose CLASS renames by aggregating method-level matches.
- **Good for**: Whole-class renaming when individual method matches concentrate within one class.
- **Couples with**: `--build-fp-renames`.
- **Naming**: abbreviated `fp-` namespace, parallel with `--nf-*`, `--fh-*`.
- **Verified against**: `src/argparse.js:334`

#### `--save-fingerprints <path>`

- **Does**: Compute fingerprints on the current index and write them to a portable JSON file.
- **Good for**: Building a library of `.fp.json` reference files for cross-codebase comparison without re-indexing.
- **Couples with**: independent (operates on an existing index, writes out).
- **Naming**: verb-noun.
- **Verified against**: `src/argparse.js:335`

#### `--load-fingerprints <path>...`

- **Does**: Load a previously-saved fingerprints file. Repeatable.
- **Good for**: Comparing against multiple library `.fp.json` files in one run.
- **Couples with**: `--cmp-string-call-dupes`, `--build-fp-renames`.
- **Naming**: parallels `--save-fingerprints`. **Notable**: when combined with `--build-fp-renames`, each loaded file is copied into the index's `fingerprints/` subdirectory — see Couplings.
- **Verified against**: `src/argparse.js:336`

#### `--clean-fp`

- **Does**: With `--build-fp-renames`, strip existing `_FP_` suffixes from `rename_map.json` before emitting new ones.
- **Good for**: Backing out a noisy `_FP_` pass without hand-editing.
- **Couples with**: `--build-fp-renames`.
- **Naming**: abbreviated `fp` namespace.
- **Verified against**: `src/argparse.js:337`

---

## CONTENT ANALYSIS

#### `--command-catalog`

- **Does**: List CLI options, commands, switch/case branches, API routes, and GUI actions discovered in the codebase.
- **Good for**: Understanding the command surface of an unfamiliar codebase. Especially useful in reverse-engineering bundled tools.
- **Couples with**: `--filter`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:340`

#### `--string-table [filter]` (alias: `--strings`)

- **Does**: Show frequently-occurring string literals. Optional filter (substring or `/regex/flags`).
- **Good for**: Surfacing the literal vocabulary of a codebase — often a navigation signal (error messages, URLs, etc.).
- **Couples with**: `--max-results`, `--filter`.
- **Naming**: noun-noun primary; `--strings` alias for typing convenience.
- **Verified against**: `src/argparse.js:341`

#### `--breadcrumbs`

- **Does**: Show telemetry / trace markers and event categories.
- **Good for**: Understanding observability surface (telemetry calls, log levels, event categories).
- **Couples with**: `--verbose` (expands per-function rollup), `--filter`. Known noisy on small / non-telemetry corpora — see issue #47.
- **Naming**: metaphorical noun.
- **Verified against**: `src/argparse.js:342`

#### `--prompt-catalog` (alias: `--prompts`)

- **Does**: Detect and display all LLM prompts in the codebase (system prompts, `getSystemPrompt`, `systemPrompt:` properties, `role:"system"` messages, `build*Prompt` functions). Full text, no truncation.
- **Good for**: Auditing how an LLM-using codebase prompts the model — useful for reverse-engineering Claude Code, identifying jailbreak vectors, AI-safety analysis.
- **Couples with**: independent.
- **Naming**: noun-noun primary; `--prompts` alias for typing.
- **Verified against**: `src/argparse.js:343`

#### `--file-bookends [N]`

- **Does**: Show the first N and last N lines of each file (default N=20). Entry points in minified bundles are almost always at the top or tail of the file.
- **Good for**: Quick head+tail view of files in an index, with renames applied. Useful for bundle analysis.
- **Couples with**: `--filter`, `--include-path`.
- **Naming**: metaphorical noun.
- **Verified against**: `src/argparse.js:204`

#### `--bundle-seams [FILE]`

- **Does**: For minified/bundled JS files, detect the esbuild module wrapper pattern and list each original-source module's line range, kind (ESM/CJS), and a content preview.
- **Good for**: Splitting a single huge bundled file into virtual sub-files for analysis.
- **Couples with**: `--seam-verbose`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:205`

#### `--seam-verbose`

- **Does**: With `--bundle-seams`, also scan each module body for leaked source paths and license headers.
- **Good for**: Module-to-original-package attribution when bundlers leak hints (paths starting with `node_modules/...`, license comments).
- **Couples with**: `--bundle-seams`.
- **Naming**: descriptive.
- **Verified against**: `src/argparse.js:206`

#### `--digest <target>`

- **Does**: Print a structured digest of a unit of code. Target-aware — auto-detects what `<target>` resolves to and produces target-shaped output:
  - **Function**: identity, callers, callees, strings, breadcrumbs, comments, command-catalog cross-reference, dupes.
  - **Class**: identity (with `Extends:` / `Implements:`), methods (one line each), instantiation sites, external calls aggregated across all methods, plus the shared flat strings/breadcrumbs/comments/commands sections.
  - **File**: identity (with header excerpt), exports, imports, top-level declarations, dependency edges (imported-by + imports-from), plus the shared flat sections.
- **Good for**: Self-contained summary of any unit of code — function, class, or file — for human orientation, as LLM-analysis preamble, or for capturing point-in-time documentation. The unit-of-summary primitive.
- **Couples with**: `--with-digest` (composer for `--analyze`; today function-only on the analyze side — class/file analyze-with-digest is future work). File digest's dependency-edges section uses the same import-graph data as `--file-map`. `-v` / `--verbose` includes the COMMENTS section inline (default: stubbed with hint pointing to `--comments-only`).
- **Naming**: noun-only. Target type is auto-detected — no separate `--class-digest` / `--file-digest` flags. Path-shaped target (contains `/` or `\` or known file extension) routes to file digest; otherwise tries function/class index. Precedence on name ambiguity: class > function. Bare filename fuzzy-matches a unique suffix (e.g. `multisect.js` → `src/core/multisect.js` if unique; reports ambiguity otherwise).
- **Verified against**: `src/argparse.js:207`

---

## COUPLINGS — observed irregularities

This section surfaces the cross-flag coupling patterns that any CLI normalization (#52) will need to address. Each entry names what's irregular; the design conversation in #52 decides what to do about it.

**Status**: items marked **✅ Resolved** were addressed by CLI normalization batch #1 (#58 followup, commit `2b47c79`). Remaining items stay open for future batches.

### Three overlapping path-filter mechanisms

`--in <pattern>`, `--include-path <patterns>...`, and `--exclude-path <patterns>...` overlap functionally. `--in` is documented as the "universal path filter" but is parsed internally as `vocab_in`. `--include-path` is `list`-typed (repeatable); `--in` is `value`-typed (single). `--filter <text>` is yet another filter applied to result names (not paths).

**Question for redesign**: unify these into one primitive (target type: path or name) with a uniform argument shape.

### `--list-*` naming family ✅ Resolved

Canonical forms are now `--functions`, `--files`, `--classes`, `--indexes`. `--list-*` forms remain as deprecated aliases with one-time stderr warnings.

Compound sort modifiers (`--list-functions-alpha`, `--list-functions-size`) are now replaced by a `--sort <mode>` modifier flag (`--functions --sort alpha`). Old compound forms continue to work as deprecated aliases.

### `--full-path` and `--dedup` declared twice ✅ Resolved

The duplicate declarations in `argparse.js::defs` and the duplicate args-init entries were removed. Effective default for `--dedup` (which was `'exact'` due to declaration-order overwrite) is preserved as the explicit default.

### `--depth` has two defaults depending on consumer ✅ Resolved (documentation only)

The per-consumer defaults (1 for `--callers`, 3 for `--call-tree` / `--file-tree`) remain intentionally different. The `--help` text now documents this explicitly under `--depth` itself, so users see the consumer-specific behavior without having to read source. A single flag-level default would be a bigger code change with real semantic implications; deferred unless it becomes an actual pain point.

### Two model paths for LLM operations: `--claim-model` and `--analyze-model` ✅ Resolved

Unified to `--model <path>`. The two old flags remain as deprecated aliases for users who genuinely need different models per pipeline; in the common case where one model serves both, the new flag fans out to populate both internal fields.

### `--use-claude` is vendor-specific ✅ Resolved

Replaced by `--llm <provider>`. Currently only `claude` is recognized; the flag's existence opens space for future providers (`codex`, etc.) without further argparse changes. `--use-claude` remains as a deprecated alias.

### `--filter` overlaps with positional pattern arguments

`--functions [pattern]` accepts an optional positional pattern AND respects `--filter`. The two filter sources interact in non-obvious ways. Same pattern in `--files`, `--indexes`, `--string-table`.

**Question for redesign**: pick one — drop positional patterns, or drop `--filter` for these commands.

### Modifier-prefix namespaces (`--nf-*`, `--fh-*`, `--fp-*`)

`--notable-funcstr-matches` has modifiers `--nf-min-lines`, `--nf-min-surprise`, `--nf-sort`, `--nf-tight`. `--funcstr-hashes` has `--fh-tight`. `--build-fp-renames` has `--fp-classes`, `--clean-fp`. Three different abbreviation conventions for what's conceptually the same pattern (per-command modifier flags).

**Question for redesign**: standardize the modifier prefix (or eliminate the abbreviations and use full names like `--notable-min-lines`).

### `--follow-calls` is subsumed by `--deep` ✅ Resolved

`--follow-calls` is now a deprecated alias for `--deep 1`. Continues to work; warns once and sets the new field.

### `--claim-file` and `--claim-search @file.txt` — distinct code paths, not redundant

Surface-level redundancy with two flags accepting file paths. Code shows they go through different branches (`args.claim_file` is read at `src/commands/claim.js:1019` in its own branch). Keep both as first-class flags; the earlier "deprecate `--claim-file`" framing was a misread of the code structure.

### `--with` vs. `--claim-text` — distinct code paths, not redundant

`args.analyze_context` (set by `--with`) is consumed at `src/commands/analyze.js:1280` for the `--analyze` flow; `args.claim_text` (set by `--claim-text`) is consumed at `src/commands/analyze.js:1236` for the `--claim-analyze` flow. They look interchangeable from a user perspective but route to different downstream code. Keep both as first-class flags; the earlier "deprecate `--claim-text`" framing was a misread.

### `--vocabulary` / `--vocab` / `--discover-vocabulary` (aliases) ✅ Resolved

Canonical is `--vocabulary` (noun-only matches sibling commands like `--hotspots`, `--gaps`). `--vocab` retained as undeprecated short alias. `--discover-vocabulary` is deprecated.

### `--max-results` / `--max` / `-n` (three aliases for one flag)

The triple-alias is unusual. `-n` (a short flag) is rare in CodeExam; most flags use long forms only.

**Question for redesign**: prune the aliases, or document that this is intentional because it's the most-used flag.

### `--max-results` default of 20 collides with user expectation of "list everything"

Beyond the alias question, the default value (20) is itself a design question. Command-line users typing `--functions` or `--files` often expect "list ALL of them" — the way `ls`, `find`, and most Unix tools behave. CodeExam caps at 20 unless overridden. There's a `Tips:` line at the end of partial lists pointing the user toward `--max-results N`, but the silent truncation is a usability footgun for first-time users.

This isn't just a CLI question — the same pattern shows up in the GUI, where accordions stop expanding at an arbitrary point rather than scrolling naturally to reveal the rest (see GUI issue #38 for the accordion-expansion direction).

**Two competing UX principles in tension**:

- *Front-load by rank* (current behavior): show the user the most important subset first; don't swamp them with everything. Defensible, especially for ranked outputs like `--hotspots` or `--most-called` where the tail is much less interesting.
- *Show everything, let the user filter* (Unix default): trust the user to pipe to `head` / `less` / `grep` if they want less. Defensible for enumerations like `--functions` where there's no intrinsic ranking.

**Question for redesign**: per-command defaults that respect the command's semantics — ranked commands keep a cap, enumeration commands default to no cap. Or per-command `--all` flag that explicitly opts out. Or an aggressive `Tips:` line that's harder to miss. Whatever the answer, today's "everything caps at 20 unless you know to ask" is a learning-curve cliff.

---

## Out of scope for this first-pass catalog

- **GUI cross-references** — many CLI flags have GUI equivalents (e.g. `--filter <text>` ⟷ left-pane Filter field). Building that cross-reference is a second-pass exercise; the GUI surface is itself in flux (see #38, #57).
- **Flag combination semantics** — beyond the *Couplings* section above, the full combinatorial space of "what does `--extract --deep N --comments-only` produce together?" is not catalogued here. The Couplings section lists the cross-flag couplings; full combinatorial semantics is downstream design work.
- **Naming-rationale archeology** — `*(rationale unknown — investigate)*` markers throughout are deliberate gaps. Resolving them is per-flag git-blame work, done when a specific entry's history actually matters.
- **The actual redesign** — this file is the inventory + analysis. The redesign proposal lives in [#52](https://github.com/aschulman42-cell/code-exam/issues/52) once this catalog is in hand.

---
*Posted by Andrew's Claude (Claude Code, Opus 4.7).*
