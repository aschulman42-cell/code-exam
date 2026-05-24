# CodeExam CLI Reference

This file is the canonical reference for every CodeExam command-line flag.

**Two purposes**:

1. **Documentation** — beyond what `--help` shows. Each flag gets a *what it's good for* sentence (the user intent it serves), not just its mechanics.
2. **Design input for [#52](https://github.com/aschulman42-cell/code-exam/issues/52)** — the inventory plus the *Couplings* section at the bottom surface the cross-flag irregularities that any CLI normalization will need to address.

**Source of truth**: `src/argparse.js`. Every entry below carries a *Verified against* line reference. `--help` output (in `src/argparse.js::printUsage`) is sanity-check material only — drift between `--help` and `argparse.js::defs` is a real possibility and should be reconciled when noticed.

**Status**: first pass, generated 2026-05-24. The file is meant to be hand-maintained by Andrew without agent assistance going forward. Re-audits are welcome and should update the *Verified against* line numbers.

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
- **Naming**: verb-noun form (`--build-index`) keeps the namespace open for sibling actions on indexes (`--rebuild-functions`, `--build-rename-map`, `--list-indexes`). Without the verb, ambiguity grows fast.
- **Verified against**: `src/argparse.js:197`

#### `--rebuild-functions`

- **Does**: Rebuilds the function index from already-loaded file contents (the index's stored source) without re-walking the filesystem.
- **Good for**: Iterating on the function-parser logic without paying the file-walk cost. Pair with parser changes during development.
- **Couples with**: `--index-path` (operates on the existing index); `--use-tree-sitter` if the parser choice affects the rebuild.
- **Naming**: parallel to `--build-index` — explicit verb form.
- **Verified against**: `src/argparse.js:198`

#### `--build-rename-map`

- **Does**: (Re)infers descriptive names for an existing index — writes `rename_map.json` + `import_map.json` without rebuilding the index itself.
- **Good for**: Retro-fitting the rename overlays (_KW_, _CMD_, _IMPORT_, _NAME_) onto an existing index, e.g. after improving the inference code or after upgrading from a CodeExam version that didn't have a particular rename tier.
- **Couples with**: `--index-path`, `--rename-min-lines`. The `--no-rename` flag is independent — it disables display-time renames, not their generation.
- **Naming**: matches `--build-index` family. *(rationale unknown — investigate)* whether the asymmetry with the noun-only flags like `--digest` is intentional.
- **Verified against**: `src/argparse.js:199`

#### `--rename-min-lines <n>`

- **Does**: When (re)building the rename map, skips functions with `lineCount <= n`. `0` = no threshold (default).
- **Good for**: Tuning rename coverage vs. noise on short functions. Higher values reduce noisy renames on trivial 2-3 line wrappers; lower values cast a wider net.
- **Couples with**: `--build-rename-map` (only effective during rename inference, not during normal indexing).
- **Naming**: `--rename-min-lines` matches the implementation field name (`rename_min_lines`); kebab-case in user-facing form.
- **Verified against**: `src/argparse.js:200`

#### `--no-rename`

- **Does**: Disables display-time renames for this run; output uses raw obfuscated names.
- **Good for**: Reading code as the bundler wrote it, e.g. when cross-referencing against external tooling that doesn't know about CodeExam's rename overlays.
- **Couples with**: every output-producing flag (display side effect; doesn't affect index state).
- **Naming**: negation form (`--no-X`) common in Unix CLI tradition. Asymmetric: there's no `--rename` flag — renaming is the default; you opt out only.
- **Verified against**: `src/argparse.js:340`

#### `--index-path <path>`

- **Does**: Path to the index directory. Default: `.code_search_index` in the current working directory.
- **Good for**: Working with multiple indexes (one per project, per branch, per investigation). The most-used flag after `--build-index`.
- **Couples with**: every flag (defines the index that all subsequent operations target). Mutually exclusive with `--multi-index`.
- **Naming**: `--index-path` (path-shaped form). Could plausibly be `--index` (the most common usage) — *(rationale unknown — investigate)* whether the `-path` suffix was deliberate disambiguation.
- **Verified against**: `src/argparse.js:205`

#### `--multi-index @filelist`

- **Does**: Alternative to `--index-path`. Fans the rest of the command across many indexes. `@filelist` holds one index directory path per line; CodeExam runs the command against each and concatenates the output (per-index header, no aggregation).
- **Good for**: Cross-index investigations where you want the same query against several related codebases (e.g. cli.js across multiple versions of Claude Code). A run uses either `--index-path` or `--multi-index`, not both.
- **Couples with**: every read-only operation. Likely brittle with index-mutating operations (`--build-rename-map` etc.); behavior in that case *(verify)*.
- **Naming**: explicit "multi" prefix flags the cardinality difference. Could have been `--indexes @filelist` (plural) — *(rationale unknown — investigate)* — possibly to keep `--index*` as a single-index namespace.
- **Verified against**: `src/argparse.js:206`

#### `--skip-semantic`

- **Does**: Skip semantic/embedding indexing. Default is **on** (semantic indexing is the more expensive path).
- **Good for**: *(stub — semantic indexing path may be disabled by default in practice; verify against current state)*.
- **Couples with**: `--build-index`.
- **Naming**: negative-default form (`--skip-X`) signals the user is opting out of a default behavior; consistent with `--no-rename`.
- **Verified against**: `src/argparse.js:207`

#### `--use-tree-sitter`

- **Does**: Use tree-sitter for function parsing (in addition to or instead of the regex parser, depending on hybrid-merge logic).
- **Good for**: Higher-fidelity function boundary detection on languages with good tree-sitter grammars; trades regex's speed for accuracy.
- **Couples with**: `--build-index`, `--rebuild-functions`. Affects parser dispatch in `src/core/TreeSitterParser.js`.
- **Naming**: prefix `--use-X` — opting in to a feature.
- **Verified against**: `src/argparse.js:208`

#### `--extensions <exts>`

- **Does**: Comma-separated file extensions to index. Overrides the default extension list.
- **Good for**: Indexing files that aren't in the default extensions set, or restricting to a specific language family.
- **Couples with**: `--build-index`, `--exclude-extensions`. Interaction with `--scan-extensions` / `--index-extensions` is read-only inspection of extension data.
- **Naming**: noun-only — implies "the extensions to include." Asymmetric with `--exclude-extensions` (explicitly negated).
- **Verified against**: `src/argparse.js:209`

#### `--exclude-extensions <exts>`

- **Does**: Comma-separated extensions to exclude from the index.
- **Good for**: Trimming the index by skipping noisy or irrelevant file types (e.g. `--exclude-extensions json,md` to skip resource files).
- **Couples with**: `--build-index`, `--extensions`.
- **Naming**: explicit `--exclude-X` form (parallels `--include-path` / `--exclude-path`).
- **Verified against**: `src/argparse.js:210`

#### `--demangler <path>`

- **Does**: Path to a C++ name demangler executable (e.g. `vc++filt.exe`, `c++filt`).
- **Good for**: Indexing C++ binaries or codebases where mangled symbols would otherwise be opaque.
- **Couples with**: `--build-index` (used by `processBinary` in `src/binstrings.js`).
- **Naming**: noun-only; the path argument is the demangler binary itself.
- **Verified against**: `src/argparse.js:211`

---

## SEARCH

#### `--search <query>`

- **Does**: Hybrid search — literal + semantic.
- **Good for**: Default-mode search when you're not sure whether the query should be literal or semantic.
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`, `--full-path`, `--verbose`.
- **Naming**: bare `--search`; the *type* of search is implicit. Other search modes carry explicit type prefixes (`--literal`, `--fast`, `--regex`).
- **Verified against**: `src/argparse.js:213`

#### `--literal <query>`

- **Does**: Literal (exact-text) search.
- **Good for**: Finding an exact string in the indexed code — most common when you copy-paste from another source.
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: type-prefixed search variant.
- **Verified against**: `src/argparse.js:214`

#### `--fast <query>`

- **Does**: Fast inverted-index search.
- **Good for**: Quick scans across large indexes when speed matters more than fuzzy matching. Backed by the inverted-index data structure.
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: speed-property name (`--fast`) rather than mechanism name (`--inverted-index`) — user-intent framing.
- **Verified against**: `src/argparse.js:215`

#### `--regex <pattern>`

- **Does**: Regex pattern search.
- **Good for**: Pattern matches that literal and inverted-index searches can't express (alternation, character classes, lookahead).
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: mechanism name — there's no clearer user-intent alias.
- **Verified against**: `src/argparse.js:216`

#### `--files-search <query>`

- **Does**: Show files containing a term, sorted by hit count.
- **Good for**: "Which files have the most matches?" — a coarse navigation primitive when you need to triage by file before diving into a specific match.
- **Couples with**: `--max-results`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: noun-action form (`--files-search`); parallel with `--folders-search`.
- **Verified against**: `src/argparse.js:217`

#### `--folders-search <query>`

- **Does**: Show folders containing a term, sorted by hit count.
- **Good for**: Coarser version of `--files-search` — useful in large projects where folder-level grouping precedes file-level inspection.
- **Couples with**: `--max-results`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: parallel with `--files-search`.
- **Verified against**: `src/argparse.js:218`

---

## BROWSE

#### `--stats`

- **Does**: Show index statistics (file count, line count, function count, parse method, etc.).
- **Good for**: Quick sanity check on what the index contains, especially after `--build-index`.
- **Couples with**: independent of most other flags; respects `--index-path`.
- **Naming**: noun-only; common Unix idiom.
- **Verified against**: `src/argparse.js:220`

#### `--list-files [pattern]`

- **Does**: List indexed files. Optional pattern filters by substring match on path.
- **Good for**: Confirming which files made it into the index; debugging extension or path-exclude misconfigurations.
- **Couples with**: `--max-results`, `--full-path`, `--filter` (overlaps with optional positional pattern).
- **Naming**: `--list-X` verb-noun pattern. See *Couplings → naming family* below for the broader `--list-*` family observation.
- **Verified against**: `src/argparse.js:221`

#### `--show-file <pattern>`

- **Does**: Display entire file contents (matching the pattern).
- **Good for**: Reading a file's full source from the index without separate filesystem access — useful for piping to other tools or capturing a snapshot.
- **Couples with**: `--full-path`, rename overlays (`--no-rename`).
- **Naming**: `--show-file` (singular) vs. `--list-files` (plural) — semantic distinction maintained (one file's content vs. many files' names).
- **Verified against**: `src/argparse.js:222`

#### `--list-functions [pattern]`

- **Does**: List functions. Optional pattern filters by name substring.
- **Good for**: The most common navigation primitive in CodeExam — "what functions exist in this code?", scoped by name.
- **Couples with**: `--max-results`, `--filter` (separate from positional pattern — surprisingly), `--include-path`, `--exclude-path`, `--full-path`.
- **Naming**: `--list-functions` — see *Couplings → naming family* below. User has flagged this as a redesign candidate (probably `--functions` post-redesign, emphasizing the target type over the action verb).
- **Verified against**: `src/argparse.js:223`

#### `--list-functions-alpha`

- **Does**: List all functions alphabetically (no filter).
- **Good for**: Whole-codebase enumeration when name patterns aren't enough.
- **Couples with**: `--max-results`, `--full-path`. *(check whether `--filter` is respected — likely yes by inheritance)*.
- **Naming**: compound `--list-functions-alpha` — the `-alpha` is a sort modifier on `--list-functions`. *(rationale unknown — investigate)* why this isn't `--list-functions --alpha`.
- **Verified against**: `src/argparse.js:224`

#### `--list-functions-size`

- **Does**: List all functions sorted by size.
- **Good for**: Finding the biggest functions in a codebase — a sometimes-useful refactor or complexity signal.
- **Couples with**: same as `--list-functions-alpha`.
- **Naming**: parallel with `--list-functions-alpha`. Same modifier-suffix observation.
- **Verified against**: `src/argparse.js:225`

#### `--extract <spec>`

- **Does**: Extract function source. `<spec>` is `FUNCTION` or `FILE@FUNCTION`.
- **Good for**: Pulling a specific function's full source for reading, piping, or inclusion in an LLM prompt.
- **Couples with**: `--follow-calls`, `--deep`, `--comments-only`, rename overlays.
- **Naming**: noun-only `--extract`. Could have been `--get-function` etc. — *(rationale unknown — investigate)*.
- **Verified against**: `src/argparse.js:226`

#### `--scan-extensions <path>`

- **Does**: Count file extensions in a directory (filesystem operation, not against an index).
- **Good for**: Pre-flight check before `--build-index` to see what's there.
- **Couples with**: independent — takes a filesystem path, not an index.
- **Naming**: `--scan-X` form — implies a filesystem scan vs. an index lookup.
- **Verified against**: `src/argparse.js:227`

#### `--index-extensions`

- **Does**: Count file extensions in the current index.
- **Good for**: Post-build verification: which extensions made it in. Complement to `--scan-extensions`.
- **Couples with**: `--index-path`.
- **Naming**: noun-noun form (`--index-extensions`) — first word is the data source, second is the data type. Inconsistent with `--scan-extensions` (verb-noun).
- **Verified against**: `src/argparse.js:228`

#### `--list-indexes [path]`

- **Does**: List available index directories. Optional path narrows the scan.
- **Good for**: Discovering what indexes you've built when you've lost track of them.
- **Couples with**: independent; reads directory entries, not an index.
- **Naming**: `--list-X` family.
- **Verified against**: `src/argparse.js:229`

---

## CALLERS / CALLEES

#### `--callers <spec>`

- **Does**: Find callers of a function. `<spec>` is `FUNC` or `FILE@FUNC`.
- **Good for**: "Who calls this?" — the most common reverse-navigation question.
- **Couples with**: `--depth` (transitive callers), `--exclude-tests`, `--max-results`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: noun-only.
- **Verified against**: `src/argparse.js:245`

#### `--callees <spec>`

- **Does**: Find functions called by a function.
- **Good for**: "What does this call?" — the forward direction.
- **Couples with**: same as `--callers`.
- **Naming**: parallel.
- **Verified against**: `src/argparse.js:246`

#### `--most-called <n>`

- **Does**: Show top N most frequently called functions in the index.
- **Good for**: Finding the most-invoked APIs / utility functions — often the entry points to subsystems.
- **Couples with**: `--defined-only`, `--min-name-length`, `--include-macros`, `--exclude-tests`.
- **Naming**: superlative-form noun.
- **Verified against**: `src/argparse.js:247`

#### `--depth <n>`

- **Does**: Depth for transitive callers (default: 1) or for call-tree (default: 3).
- **Good for**: Following call chains deeper than one hop.
- **Couples with**: `--callers`, `--call-tree`, `--follow-calls`. **Notable irregularity**: default value differs by which command consumes it (1 vs. 3) — see Couplings below.
- **Naming**: bare `--depth`.
- **Verified against**: `src/argparse.js:248`

#### `--min-name-length <n>`

- **Does**: Filter out short function names in `--most-called` results (default: 1).
- **Good for**: Suppressing noise from single-character or built-in-shadow names that pile up in minified code.
- **Couples with**: `--most-called` primarily.
- **Naming**: descriptive long form.
- **Verified against**: `src/argparse.js:249`

#### `--include-macros`

- **Does**: Include ALL_CAPS names in `--most-called` results.
- **Good for**: When macros / constants are part of what you want to see ranked.
- **Couples with**: `--most-called`.
- **Naming**: `--include-X` for opt-in.
- **Verified against**: `src/argparse.js:250`

#### `--defined-only`

- **Does**: With `--most-called`, only show functions that are defined in the index (i.e. not external/library calls).
- **Good for**: Focusing on the codebase's own functions; excluding `printf`, `console.log`, etc.
- **Couples with**: `--most-called`.
- **Naming**: hyphenated boolean-suffix form.
- **Verified against**: `src/argparse.js:251`

#### `--exclude-tests`

- **Does**: Exclude test files from callers/metrics results.
- **Good for**: Hotspot and caller scans where you want only production code, not test fixtures.
- **Couples with**: `--callers`, `--callees`, `--most-called`, `--hotspots`, `--gaps`, `--entry-points`, others. **Notable**: detection of "test file" is heuristic (path contains `test/`, file name starts with `test_`, etc.) — see Couplings.
- **Naming**: `--exclude-X` form (parallels `--exclude-path`).
- **Verified against**: `src/argparse.js:252`

#### `--call-inventory [spec]`

- **Does**: Show call targets partitioned into in-index vs. external. No argument: scan entire codebase (bill of materials). With function name: single-function inventory.
- **Good for**: "What does this code depend on?" — surfaces external calls (library APIs, builtins) as a flat list.
- **Couples with**: `--filter`, `--verbose`.
- **Naming**: noun phrase.
- **Verified against**: `src/argparse.js:255`

---

## GRAPH

#### `--call-tree <spec>`

- **Does**: Show call tree (callers up + callees down).
- **Good for**: Visualizing the full call neighborhood of a function in one view.
- **Couples with**: `--depth` (default: 3 for trees), `--mermaid`, `--exclude-tests`.
- **Naming**: noun phrase.
- **Verified against**: `src/argparse.js:253`

#### `--class-tree [filter]`

- **Does**: Show class inheritance hierarchy.
- **Good for**: Understanding inheritance chains across languages — particularly useful in indexed Java / Python / C++ codebases.
- **Couples with**: `--mermaid`, `--max-results`, `--filter`.
- **Naming**: noun phrase, parallel with `--call-tree`.
- **Verified against**: `src/argparse.js:254`

#### `--file-map [filter]`

- **Does**: Show file-level dependency map.
- **Good for**: Module-level orientation in a codebase — which files import from which.
- **Couples with**: `--mermaid`, `--max-results`, `--filter`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:256`

#### `--file-tree <file>`

- **Does**: Show file dependency tree (one file's transitive imports).
- **Good for**: Single-file dependency walk; complement to `--file-map`.
- **Couples with**: `--depth`, `--mermaid`.
- **Naming**: parallel with `--file-map`.
- **Verified against**: `src/argparse.js:257`

#### `--mermaid`

- **Does**: Output a Mermaid diagram instead of text.
- **Good for**: Generating renderable graphs for README files or visual review. Pairs with any tree/map command.
- **Couples with**: `--call-tree`, `--class-tree`, `--file-map`, `--file-tree`. **Notable**: doesn't do anything if no graph command is in play — silent no-op.
- **Naming**: tool-name (lowercase).
- **Verified against**: `src/argparse.js:258`

---

## METRICS / DISCOVERY

#### `--hotspots <n>`

- **Does**: Top N structurally important functions (`calls × log2(lines)` score).
- **Good for**: Finding load-bearing functions — where complexity and connectivity intersect.
- **Couples with**: `--exclude-tests`, `--filter`, `--include-path`, `--exclude-path`, `--max-results`.
- **Naming**: bare noun.
- **Verified against**: `src/argparse.js:261`

#### `--hot-folders <n>`

- **Does**: Top N directories by aggregated hotspot score.
- **Good for**: Hotspot rollup at the folder level — useful when looking for the heavy subsystems.
- **Couples with**: same as `--hotspots`.
- **Naming**: prefixed with `hot-` to mirror `--hotspots`.
- **Verified against**: `src/argparse.js:262`

#### `--entry-points <n>`

- **Does**: Top N uncalled functions (sorted by size); functions with zero callers.
- **Good for**: Identifying the "main" entry surfaces of a codebase (CLI handlers, exported APIs, dispatched callbacks).
- **Couples with**: `--max-calls`, `--exclude-tests`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:263`

#### `--max-calls <n>`

- **Does**: Maximum call count threshold for `--entry-points` (default: 0 = strictly never called).
- **Good for**: Loosening the entry-points definition; "≤2 callers" sometimes captures real entry points that have one helper.
- **Couples with**: `--entry-points`.
- **Naming**: `max-X` form, parallel with `--max-results`.
- **Verified against**: `src/argparse.js:264`

#### `--gaps [n]`

- **Does**: Find suspicious dead code — defined, no callers, not an entry-point.
- **Good for**: Dead-code triage at scale; complement to the manual sweep done in issue #50.
- **Couples with**: `--max-results`, `--exclude-tests`.
- **Naming**: terse noun. *(rationale unknown — investigate)* — "gaps" is metaphorical for "gaps in the call graph"; less self-documenting than `--dead-code`.
- **Verified against**: `src/argparse.js:265`

#### `--domain-fns <n>`

- **Does**: Top N domain-specific functions (`score / sqrt(name defs)`).
- **Good for**: Surfacing functions whose names are distinctive in the codebase's vocabulary — often the domain logic core.
- **Couples with**: `--max-results`, `--filter`.
- **Naming**: abbreviation `fns` instead of `functions` — *(rationale unknown — investigate)* but probably aesthetic / typing-efficiency.
- **Verified against**: `src/argparse.js:266`

#### `--list-classes`

- **Does**: List all classes with method counts/sizes.
- **Good for**: Class-level overview of an OO codebase.
- **Couples with**: `--filter`, `--max-results`, `--include-path`, `--exclude-path`.
- **Naming**: `--list-X` family. Notably missing here: a `--functions` / `--classes` / `--files` symmetric noun-only set.
- **Verified against**: `src/argparse.js:267`

#### `--class-hotspots <n>`

- **Does**: Top N classes by aggregated method hotspot score.
- **Good for**: Class-level rollup of `--hotspots`; finds the most complex classes.
- **Couples with**: same as `--hotspots`.
- **Naming**: prefix `class-` modifier on `--hotspots`.
- **Verified against**: `src/argparse.js:268`

#### `--discover-vocabulary <n>` (aliases: `--vocabulary`, `--vocab`)

- **Does**: Top N domain-specific tokens by TF-IDF score.
- **Good for**: Surfacing the unique vocabulary of a codebase — input to claim-search term selection and to multisect query crafting.
- **Couples with**: `--vocab-tight`, `--in` (path filter), `--no-vocabulary` (disables it as input to other commands).
- **Naming**: verb-noun primary (`--discover-vocabulary`); two aliases for typing convenience. *(rationale unknown — investigate)* — the verb prefix vs. bare `--vocabulary` choice.
- **Verified against**: `src/argparse.js:269`

#### `--multisect-search <terms>` (alias: `--multisect`)

- **Does**: Multi-term intersection search — finds smallest scope (function / class / file / folder) containing the terms. Terms semicolon-separated; `/regex/` for regex; `NOT` / `!` to negate.
- **Good for**: "Find the place where all these things happen together" — the headline CodeExam search primitive.
- **Couples with**: `--match-renames`, `--in` (path filter), `--min-terms`, `--max-results`, `--dedup`, `--filter`.
- **Naming**: noun-noun. Alias `--multisect` reflects the dominant usage.
- **Verified against**: `src/argparse.js:270`

#### `--in <pattern>`

- **Does**: Universal path filter — restricts search, multisect, and vocabulary output to files whose path contains `<pattern>`.
- **Good for**: Quick scoping to a subdirectory without remembering which flag's `--include-path` to use.
- **Couples with**: `--multisect-search`, `--search`, `--discover-vocabulary`, others. **Notable**: parsed as `vocab_in` internally — naming asymmetry.
- **Naming**: very terse two-letter form — `--in` reads naturally in a sentence ("multisect *in* `src/core/`"). *(rationale unknown — investigate)* whether this should be unified with `--include-path`.
- **Verified against**: `src/argparse.js:271`

#### `--show-dupes`

- **Does**: Show file duplicate paths in output.
- **Good for**: Debugging cases where the index contains duplicate copies of files (vendored libraries, parallel builds).
- **Couples with**: many display paths.
- **Naming**: hyphenated boolean.
- **Verified against**: `src/argparse.js:272`

---

## DISPLAY / FILTERING

These modify how query results are rendered. They don't affect index state.

#### `--max-results <n>` (aliases: `--max`, `-n`)

- **Does**: Maximum results to display (default: 20).
- **Good for**: Cutting noise; deeper exploration via raising the cap.
- **Couples with**: every list-producing command.
- **Naming**: long form `--max-results`; short alias `-n`. Multiple aliases reflect frequent use.
- **Verified against**: `src/argparse.js:231`

#### `--context <n>`

- **Does**: Context lines around matches (default: 3).
- **Good for**: Reading match context inline without re-running with `--extract`.
- **Couples with**: search commands.
- **Naming**: bare noun.
- **Verified against**: `src/argparse.js:232`

#### `--verbose` (alias: `-v`)

- **Does**: Show extra detail (varies per command — extra fields, expanded sections, etc.).
- **Good for**: Drill-down when default output is too compact.
- **Couples with**: many commands; semantics differ per command.
- **Naming**: bare adjective, short alias `-v` (universal Unix convention).
- **Verified against**: `src/argparse.js:233`

#### `--full-path`

- **Does**: Show full file paths in output (instead of truncated/relative).
- **Good for**: When path disambiguation matters (large monorepos, multiple files with the same name).
- **Couples with**: every output-producing command. **Notable**: declared twice in `argparse.js::defs` (lines 234 and 273) — duplicate; need to verify whether this is a bug or intentional.
- **Naming**: hyphenated boolean.
- **Verified against**: `src/argparse.js:234` (and `:273` — duplicate)

#### `--filter <text>`

- **Does**: Filter function listings by name.
- **Good for**: Narrowing list output without re-running with a different positional pattern. Often redundant with positional pattern, depending on command.
- **Couples with**: most list / search commands. **Notable**: overlaps with positional pattern in `--list-functions [pattern]` — see Couplings.
- **Naming**: bare verb-noun.
- **Verified against**: `src/argparse.js:235`

#### `--include-path <patterns>...`

- **Does**: Only include paths containing pattern(s). Repeatable list argument.
- **Good for**: Restricting scope to certain subdirectories or file naming patterns. More precise than `--in` for multi-pattern filters.
- **Couples with**: most query commands. Overlap with `--in` and `--filter` — see Couplings.
- **Naming**: `--include-X` for opt-in, parallels `--exclude-path`.
- **Verified against**: `src/argparse.js:236`

#### `--exclude-path <patterns>...`

- **Does**: Exclude paths containing pattern(s).
- **Good for**: Skipping vendored code, test directories, or other noise.
- **Couples with**: same as `--include-path`.
- **Naming**: parallels `--include-path`.
- **Verified against**: `src/argparse.js:237`

#### `--dedup <mode>`

- **Does**: Dedup mode for query results: `none`, `exact`, `structural`.
- **Good for**: Suppressing duplicate hits when the codebase contains vendored copies or near-duplicate functions.
- **Couples with**: most query commands. **Notable**: declared twice in `argparse.js::defs` (lines 238 and 274) with different defaults — see Couplings.
- **Naming**: bare noun.
- **Verified against**: `src/argparse.js:238` (and `:274` — duplicate with different default)

#### `--min-terms <n>`

- **Does**: For multisect-style searches, the minimum number of positive terms a scope must contain to be reported.
- **Good for**: Partial-match multisect (find scopes containing N of K terms, not all K).
- **Couples with**: `--multisect-search`, `--claim-analyze`.
- **Naming**: terse.
- **Verified against**: `src/argparse.js:239`

#### `--match-renames`

- **Does**: For multisect, also match against rename-rendered source (in addition to raw source).
- **Good for**: Finding hits via the inferred display names (e.g. `_CMD_AMAZON_BEDROCK`) when the literal source uses opaque names.
- **Couples with**: `--multisect-search`, `--multisect-analyze`.
- **Naming**: bare verb-noun.
- **Verified against**: `src/argparse.js:240`

---

## MODE

#### `--interactive` (alias: `-i`)

- **Does**: Start the interactive REPL mode. Auto-enters if no command is given and an index exists.
- **Good for**: Exploratory sessions where multiple commands run against the same loaded index.
- **Couples with**: independent (replaces all command flags with REPL input).
- **Naming**: `-i` short alias universal in shell tradition.
- **Verified against**: `src/argparse.js:242`

---

## CLAIM SEARCH (LLM-based)

#### `--claim-search <text>`

- **Does**: Extract search terms from patent claim text (or `@file.txt`). LLM-based.
- **Good for**: Patent-litigation use case — turn a claim's natural language into multisect-ready terms.
- **Couples with**: `--use-claude`, `--claim-model`, `--api-key`, `--temperature`, `--vocab-tight`, `--no-vocabulary`, `--show-prompt`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:277`

#### `--claim-file <path>`

- **Does**: Read patent claim text from file.
- **Good for**: When the claim is long or contains special characters that shell quoting can't handle.
- **Couples with**: `--claim-search`. (Same as `@file.txt` shorthand on `--claim-search`.)
- **Naming**: parallels `--claim-search`. Probably redundant with the `@file` shorthand — *(rationale unknown — investigate)*.
- **Verified against**: `src/argparse.js:278`

#### `--use-claude`

- **Does**: Use Claude API for term extraction (requires `ANTHROPIC_API_KEY`).
- **Good for**: Cloud LLM path. **In litigation contexts (CodeClaim per #23), this is verboten** — use local GGUF instead.
- **Couples with**: `--claim-search`, `--claim-analyze`, `--analyze`, `--multisect-analyze`, `--file-analyze`. `--api-key` overrides the env var.
- **Naming**: vendor-specific. *(rationale: pre-dates the public/private split — generic `--use-cloud-llm` would be more neutral.)*
- **Verified against**: `src/argparse.js:279`

#### `--api-key <key>`

- **Does**: Anthropic API key, overrides `ANTHROPIC_API_KEY` env var.
- **Good for**: Per-run key override (e.g. testing with a sandbox key).
- **Couples with**: `--use-claude`.
- **Naming**: vendor-neutral.
- **Verified against**: `src/argparse.js:280`

#### `--claim-model <path.gguf>` (alias: `--term-extract-model`)

- **Does**: Path to a local GGUF model for term extraction.
- **Good for**: Air-gapped term extraction (the litigation default). The alias `--term-extract-model` is more descriptive but `--claim-model` is shorter.
- **Couples with**: `--claim-search`, `--claim-analyze`.
- **Naming**: two names for one feature — see Couplings.
- **Verified against**: `src/argparse.js:281`

#### `--temperature <float>`

- **Does**: LLM temperature (default: 0.0).
- **Good for**: Loosening LLM determinism for exploratory term generation.
- **Couples with**: every LLM-using flag.
- **Naming**: standard LLM-API term.
- **Verified against**: `src/argparse.js:282`

#### `--show-prompt`

- **Does**: Display the LLM prompt and exit (no API call).
- **Good for**: Auditing what gets sent to the LLM — reproducibility, prompt-engineering iteration, and litigation context (showing court what was asked).
- **Couples with**: `--claim-search`, `--analyze`, others using LLM.
- **Naming**: imperative verb-noun.
- **Verified against**: `src/argparse.js:283`

#### `--vocab-tight`

- **Does**: Also use codebase vocabulary for TIGHT term generation (default: vocabulary only influences BROAD terms).
- **Good for**: Tighter term sets that lean on codebase-specific vocabulary (vs. claim-only language).
- **Couples with**: `--claim-search`, `--claim-analyze`.
- **Naming**: composite (vocab + tight).
- **Verified against**: `src/argparse.js:284`

#### `--no-vocabulary` (alias: `--no-vocab`)

- **Does**: Disable codebase vocabulary in term-extraction prompts.
- **Good for**: A/B testing whether vocabulary guidance helps. Defaults that include vocabulary can be toggled off.
- **Couples with**: `--claim-search`, `--claim-analyze`.
- **Naming**: `--no-X` negation form.
- **Verified against**: `src/argparse.js:285`

---

## LLM ANALYSIS

#### `--analyze <function>`

- **Does**: Analyze a function with LLM ("what does this do?").
- **Good for**: Per-function natural-language summarization, especially of obfuscated or unfamiliar code.
- **Couples with**: `--analyze-model`, `--use-claude`, `--with`, `--with-digest`, `--mask-all`, `--line-numbers`.
- **Naming**: bare verb.
- **Verified against**: `src/argparse.js:288`

#### `--claim-analyze <claim>`

- **Does**: End-to-end patent claim analysis: extract terms → search → analyze top matches.
- **Good for**: The full claim-search-and-explain pipeline in one command.
- **Couples with**: all LLM flags, all multisect flags.
- **Naming**: noun-verb.
- **Verified against**: `src/argparse.js:289`

#### `--multisect-analyze <terms>`

- **Does**: Search for functions matching multisect terms, analyze top hits with LLM.
- **Good for**: When you have terms already (not a patent claim) and want the analyze pipeline.
- **Couples with**: same as `--multisect-search` plus LLM flags.
- **Naming**: noun-verb, parallels `--claim-analyze`.
- **Verified against**: `src/argparse.js:290`

#### `--file-analyze <filepath>`

- **Does**: Analyze an entire source file with LLM.
- **Good for**: File-level summarization (especially with `--mask-all` for confidentiality).
- **Couples with**: LLM flags, `--mask-all`.
- **Naming**: parallels other `*-analyze` forms.
- **Verified against**: `src/argparse.js:291`

#### `--analyze-model <path.gguf>`

- **Does**: Path to local GGUF model for analysis.
- **Good for**: Air-gapped analysis path (different from `--claim-model` which is for term extraction). Two-model setup.
- **Couples with**: `--analyze`, `--claim-analyze`, `--multisect-analyze`, `--file-analyze`.
- **Naming**: parallels `--claim-model`. **Notable**: two separate model paths for what could be the same model — see Couplings.
- **Verified against**: `src/argparse.js:292`

#### `--with <text>` (alias: `--context-text`)

- **Does**: Context text for `--analyze` (patent claim, description, etc.). Supports `@file.txt` syntax.
- **Good for**: Asking "what does this function do *in relation to this thing*?" — the analyze prompt becomes context-aware.
- **Couples with**: `--analyze`, others.
- **Naming**: very terse preposition (`--with`). *(rationale: reads naturally — "analyze X with Y".)*
- **Verified against**: `src/argparse.js:293`

#### `--mask-all`

- **Does**: Strip comments and mask string contents before sending to LLM.
- **Good for**: Confidentiality — avoiding sending verbatim source to a cloud LLM in litigation contexts.
- **Couples with**: any `*-analyze` command.
- **Naming**: imperative verb-pronoun.
- **Verified against**: `src/argparse.js:294`

#### `--line-numbers`

- **Does**: Include source line numbers in the LLM prompt.
- **Good for**: When the LLM's response needs to reference specific lines.
- **Couples with**: `*-analyze` commands.
- **Naming**: bare noun-noun.
- **Verified against**: `src/argparse.js:295`

#### `--claim-text <text>`

- **Does**: Patent claim text for `--claim-analyze` (or `@file.txt`).
- **Good for**: Same role as `--with`, but specifically for the `--claim-analyze` flow.
- **Couples with**: `--claim-analyze`.
- **Naming**: noun-noun. *(rationale unknown — investigate)* whether this could be unified with `--with`.
- **Verified against**: `src/argparse.js:296`

#### `--with-digest`

- **Does**: Prepend `--digest` output (static-analysis facts) to the `--analyze` prompt.
- **Good for**: A/B testing the effect of CodeExam-provided context on local-LLM analysis quality. Composable with `--with`, `--mask-all`.
- **Couples with**: `--analyze`, `--with`, `--mask-all`.
- **Naming**: composer prefix `--with-X`.
- **Verified against**: `src/argparse.js:297`

---

## EXTENDED EXTRACTION

#### `--follow-calls`

- **Does**: With `--extract`, also dump source of all callees.
- **Good for**: Getting a function plus its dependencies in one extraction — useful for LLM prompts that need full context.
- **Couples with**: `--extract`, `--deep`.
- **Naming**: imperative verb-noun.
- **Verified against**: `src/argparse.js:300`

#### `--deep [N]`

- **Does**: Same as `--follow-calls`, optionally N levels deep (default: 1).
- **Good for**: Deeper follow-call chains when one level isn't enough.
- **Couples with**: `--extract`. Subsumes `--follow-calls`.
- **Naming**: bare adjective. *(rationale unknown — investigate)* whether `--follow-calls` should be deprecated in favor of `--deep 0` / `--deep 1`.
- **Verified against**: `src/argparse.js:301`

#### `--comments-only`

- **Does**: With `--extract`, show only full-line comments from the code.
- **Good for**: Quickly reading a function's intent without its implementation.
- **Couples with**: `--extract`.
- **Naming**: hyphenated boolean.
- **Verified against**: `src/argparse.js:302`

---

## DEDUP / DUPLICATES

#### `--dupefiles <n>`

- **Does**: Top N duplicate file groups by SHA1 hash.
- **Good for**: Identical file detection across an index (vendored libraries, copy-pasted modules).
- **Couples with**: `--max-results`.
- **Naming**: bare noun.
- **Verified against**: `src/argparse.js:305`

#### `--func-dupes <n>`

- **Does**: Top N exact-duplicate function groups (SHA1 body hash).
- **Good for**: Identical function detection within the index.
- **Couples with**: `--max-results`.
- **Naming**: abbreviated noun-noun.
- **Verified against**: `src/argparse.js:306`

#### `--near-dupes <n>`

- **Does**: Top N near-duplicate function groups (same name+size, different body).
- **Good for**: Finding functions that *should* be the same but drifted.
- **Couples with**: same as `--func-dupes`.
- **Naming**: parallels `--func-dupes`.
- **Verified against**: `src/argparse.js:307`

#### `--struct-dupes <n>`

- **Does**: Top N structural dupe groups (same structure, different names/values).
- **Good for**: Cross-codebase function similarity detection — finds functions whose shape matches even after rename / refactor.
- **Couples with**: `--show-funcstring`, `--struct-diff`, `--struct-diff-all`, `--show-sources`, `--cross-source-only`.
- **Naming**: abbreviated `struct-` prefix.
- **Verified against**: `src/argparse.js:308`

#### `--show-funcstring [name|hash]`

- **Does**: Show the structural funcstring for a function (by name or hash). Bare flag falls back to struct-dupes results.
- **Good for**: Reading the structural fingerprint of a specific function.
- **Couples with**: `--struct-dupes`, `--funcstr-hashes`.
- **Naming**: verb-noun.
- **Verified against**: `src/argparse.js:309`

#### `--struct-diff <name>`

- **Does**: Show word-hole differences between structural dupe variants.
- **Good for**: When you've found a structural dupe group and want to see what differs.
- **Couples with**: `--struct-dupes`.
- **Naming**: parallels `--struct-dupes`.
- **Verified against**: `src/argparse.js:310`

#### `--struct-diff-all <n>`

- **Does**: One-line diff summaries for top N structural dupe groups.
- **Good for**: High-level overview of all dupe-group differences.
- **Couples with**: `--show-sources`, `--cross-source-only`.
- **Naming**: same family.
- **Verified against**: `src/argparse.js:311`

#### `--show-sources`

- **Does**: With `--struct-diff-all` / `--string-call-diff-all`, list each variant's filepath:line so cross-codebase matches are visible.
- **Good for**: Disambiguating which source each variant came from in cross-codebase analysis.
- **Couples with**: `--struct-diff-all`, `--string-call-diff-all`.
- **Naming**: imperative verb-noun.
- **Verified against**: `src/argparse.js:312`

#### `--cross-source-only`

- **Does**: With `*-diff-all`, filter to clusters whose members span 2+ distinct sources.
- **Good for**: Hiding within-project duplicates to focus on cross-project matches.
- **Couples with**: `--struct-diff-all`, `--string-call-diff-all`.
- **Naming**: hyphenated boolean.
- **Verified against**: `src/argparse.js:313`

#### `--string-call-dupes <n>`

- **Does**: Top N groups of functions sharing an EXACT string-call fingerprint (distinctive string literals + called-name tokens).
- **Good for**: Semantic-signature matching even when structure has been reshaped (bundlers/minifiers).
- **Couples with**: `--string-call-diff-all`, `--show-sources`, `--cross-source-only`.
- **Naming**: compound `string-call-` prefix.
- **Verified against**: `src/argparse.js:314`

#### `--string-call-diff-all <n>`

- **Does**: Detailed string-call dupe output.
- **Good for**: Detailed view of the matches that `--string-call-dupes` summarizes.
- **Couples with**: `--show-sources`, `--cross-source-only`.
- **Naming**: parallels `--struct-diff-all`.
- **Verified against**: `src/argparse.js:315`

#### `--cmp-string-call-dupes <score>`

- **Does**: Jaccard SIMILARITY comparison (fuzzy). Finds cross-source function pairs whose fingerprints overlap by score ≥ `<score>`.
- **Good for**: Deobfuscating bundled code against its source libraries.
- **Couples with**: `--fingerprint-work`, `--fingerprint-ref`, `--fingerprint-min-tokens`, `--show-tokens`, `--load-fingerprints`.
- **Naming**: `--cmp-X` prefix for "compare".
- **Verified against**: `src/argparse.js:316`

#### `--notable-funcstr-matches <n>`

- **Does**: Top N "notable funcstring matches": groups of functions sharing a structural funcstring whose members are surprising (different names and/or distant file paths).
- **Good for**: Finding cross-codebase function reuse with surprising rename patterns.
- **Couples with**: `--nf-min-lines`, `--nf-min-surprise`, `--nf-sort`, `--nf-tight`, `--filter`.
- **Naming**: long descriptive name. The `--nf-*` modifier flags use an abbreviated namespace — see Couplings.
- **Verified against**: `src/argparse.js:317`

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
- **Verified against**: `src/argparse.js:322`

#### `--fh-tight`

- **Does**: With `--funcstr-hashes`, use the stricter structural hash.
- **Good for**: Comparison with results from `--nf-tight` etc. when consistency of hashing strictness matters.
- **Couples with**: `--funcstr-hashes`.
- **Naming**: abbreviated `fh-` namespace.
- **Verified against**: `src/argparse.js:323`

#### `--fingerprint-min-tokens <n>`

- **Does**: With `--cmp-string-call-dupes` / `--build-fp-renames`, reject functions with fingerprint sizes below `<n>`.
- **Good for**: Avoiding false positives from tiny-fingerprint functions where random overlap can score high.
- **Couples with**: `--cmp-string-call-dupes`, `--build-fp-renames`.
- **Naming**: long descriptive form.
- **Verified against**: `src/argparse.js:324`

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
- **Verified against**: `src/argparse.js:327`

#### `--build-fp-renames [score]` (alias: `--build-fingerprint-renames`)

- **Does**: Generate `_FP_` rename-map entries for cross-source fingerprint matches above score `<score>` (default: 0.8).
- **Good for**: Adding fingerprint-derived renames to an existing rename map.
- **Couples with**: `--dry-run`, `--fp-classes`, `--clean-fp`, `--fingerprint-min-tokens`, `--load-fingerprints`, `--fingerprint-work`, `--fingerprint-ref`.
- **Naming**: parallels `--build-rename-map`.
- **Verified against**: `src/argparse.js:328`

#### `--dry-run`

- **Does**: With `--build-fp-renames`, show what would be written without modifying `rename_map.json`.
- **Good for**: Preview before commit. Universal Unix idiom.
- **Couples with**: `--build-fp-renames`.
- **Naming**: standard idiom.
- **Verified against**: `src/argparse.js:329`

#### `--fp-classes`

- **Does**: With `--build-fp-renames`, also propose CLASS renames by aggregating method-level matches.
- **Good for**: Whole-class renaming when individual method matches concentrate within one class.
- **Couples with**: `--build-fp-renames`.
- **Naming**: abbreviated `fp-` namespace, parallel with `--nf-*`, `--fh-*`.
- **Verified against**: `src/argparse.js:330`

#### `--save-fingerprints <path>`

- **Does**: Compute fingerprints on the current index and write them to a portable JSON file.
- **Good for**: Building a library of `.fp.json` reference files for cross-codebase comparison without re-indexing.
- **Couples with**: independent (operates on an existing index, writes out).
- **Naming**: verb-noun.
- **Verified against**: `src/argparse.js:331`

#### `--load-fingerprints <path>...`

- **Does**: Load a previously-saved fingerprints file. Repeatable.
- **Good for**: Comparing against multiple library `.fp.json` files in one run.
- **Couples with**: `--cmp-string-call-dupes`, `--build-fp-renames`.
- **Naming**: parallels `--save-fingerprints`. **Notable**: when combined with `--build-fp-renames`, each loaded file is copied into the index's `fingerprints/` subdirectory — see Couplings.
- **Verified against**: `src/argparse.js:332`

#### `--clean-fp`

- **Does**: With `--build-fp-renames`, strip existing `_FP_` suffixes from `rename_map.json` before emitting new ones.
- **Good for**: Backing out a noisy `_FP_` pass without hand-editing.
- **Couples with**: `--build-fp-renames`.
- **Naming**: abbreviated `fp` namespace.
- **Verified against**: `src/argparse.js:333`

---

## CONTENT ANALYSIS

#### `--command-catalog`

- **Does**: List CLI options, commands, switch/case branches, API routes, and GUI actions discovered in the codebase.
- **Good for**: Understanding the command surface of an unfamiliar codebase. Especially useful in reverse-engineering bundled tools.
- **Couples with**: `--filter`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:336`

#### `--string-table [filter]` (alias: `--strings`)

- **Does**: Show frequently-occurring string literals. Optional filter (substring or `/regex/flags`).
- **Good for**: Surfacing the literal vocabulary of a codebase — often a navigation signal (error messages, URLs, etc.).
- **Couples with**: `--max-results`, `--filter`.
- **Naming**: noun-noun primary; `--strings` alias for typing convenience.
- **Verified against**: `src/argparse.js:337`

#### `--breadcrumbs`

- **Does**: Show telemetry / trace markers and event categories.
- **Good for**: Understanding observability surface (telemetry calls, log levels, event categories).
- **Couples with**: `--verbose` (expands per-function rollup), `--filter`. Known noisy on small / non-telemetry corpora — see issue #47.
- **Naming**: metaphorical noun.
- **Verified against**: `src/argparse.js:338`

#### `--prompt-catalog` (alias: `--prompts`)

- **Does**: Detect and display all LLM prompts in the codebase (system prompts, `getSystemPrompt`, `systemPrompt:` properties, `role:"system"` messages, `build*Prompt` functions). Full text, no truncation.
- **Good for**: Auditing how an LLM-using codebase prompts the model — useful for reverse-engineering Claude Code, identifying jailbreak vectors, AI-safety analysis.
- **Couples with**: independent.
- **Naming**: noun-noun primary; `--prompts` alias for typing.
- **Verified against**: `src/argparse.js:339`

#### `--file-bookends [N]`

- **Does**: Show the first N and last N lines of each file (default N=20). Entry points in minified bundles are almost always at the top or tail of the file.
- **Good for**: Quick head+tail view of files in an index, with renames applied. Useful for bundle analysis.
- **Couples with**: `--filter`, `--include-path`.
- **Naming**: metaphorical noun.
- **Verified against**: `src/argparse.js:201`

#### `--bundle-seams [FILE]`

- **Does**: For minified/bundled JS files, detect the esbuild module wrapper pattern and list each original-source module's line range, kind (ESM/CJS), and a content preview.
- **Good for**: Splitting a single huge bundled file into virtual sub-files for analysis.
- **Couples with**: `--seam-verbose`, `--filter`, `--include-path`, `--exclude-path`.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:202`

#### `--seam-verbose`

- **Does**: With `--bundle-seams`, also scan each module body for leaked source paths and license headers.
- **Good for**: Module-to-original-package attribution when bundlers leak hints (paths starting with `node_modules/...`, license comments).
- **Couples with**: `--bundle-seams`.
- **Naming**: descriptive.
- **Verified against**: `src/argparse.js:203`

#### `--digest <funcspec>`

- **Does**: Print a structured digest of a single function — identity, callers/callees, strings, breadcrumbs, comments, command-catalog cross-reference, dupes.
- **Good for**: Human orientation and LLM-analysis preamble. The unit-of-summary primitive.
- **Couples with**: `--with-digest` (composer for `--analyze`). **Notable**: today the target type is function-only at the implementation level; #51 broadens this to class and file.
- **Naming**: noun-only.
- **Verified against**: `src/argparse.js:204`

---

## COUPLINGS — observed irregularities

This section surfaces the cross-flag coupling patterns that any CLI normalization (#52) will need to address. Each entry names what's irregular; the design conversation in #52 decides what to do about it.

### Three overlapping path-filter mechanisms

`--in <pattern>`, `--include-path <patterns>...`, and `--exclude-path <patterns>...` overlap functionally. `--in` is documented as the "universal path filter" but is parsed internally as `vocab_in`. `--include-path` is `list`-typed (repeatable); `--in` is `value`-typed (single). `--filter <text>` is yet another filter applied to result names (not paths).

**Question for redesign**: unify these into one primitive (target type: path or name) with a uniform argument shape.

### `--list-*` naming family

`--list-files`, `--list-functions`, `--list-functions-alpha`, `--list-functions-size`, `--list-classes`, `--list-indexes`. User has flagged this group as a likely redesign candidate — the verb prefix `--list-` puts emphasis on the action rather than the target type. Possible direction: `--functions [pattern]` with sort modifiers (`--alpha`, `--size`) instead of compound flag names.

The compound forms `--list-functions-alpha` and `--list-functions-size` are also suspicious: these are sort modifiers on `--list-functions`, but they're separate flags rather than `--list-functions --sort alpha` / `--list-functions --sort size`. Two ways to express related behavior — pick one.

### `--full-path` and `--dedup` declared twice

`argparse.js::defs` declares `--full-path` at lines 234 and 273; `--dedup` at lines 238 and 274 (with different defaults: `'none'` vs `'exact'`). The second declaration wins because the alias map overwrites. **This is at minimum a code smell** — at worst, a bug where the default changes silently depending on declaration order. Needs an audit.

### `--depth` has two defaults depending on consumer

Default for transitive callers (`--callers --depth N`) is 1. Default for `--call-tree --depth N` is 3. The argparse default is `null`; the consumers pick their own. This is fine implementation-wise but invisible to the user — they have to read the docs to know which default applies.

**Question for redesign**: per-command defaults documented at the command level, or a flag-level default that all consumers respect.

### Two model paths for LLM operations: `--claim-model` and `--analyze-model`

`--claim-model` is for term extraction; `--analyze-model` is for analysis. Probably the same model in most cases. Two flags allows asymmetric configuration but doubles the surface.

**Question for redesign**: one `--model` flag with a sub-key for term-extraction vs. analysis if asymmetry is rare.

### `--use-claude` is vendor-specific

The cloud-LLM path is named after a specific vendor. As CodeExam grows beyond Anthropic-API support (or as alternative cloud providers enter), this flag locks in the legacy name.

**Question for redesign**: `--use-cloud-llm` or `--llm-provider <name>` for vendor neutrality.

### `--filter` overlaps with positional pattern arguments

`--list-functions [pattern]` accepts an optional positional pattern AND respects `--filter`. The two filter sources interact in non-obvious ways. Same pattern in `--list-files`, `--list-indexes`, `--string-table`.

**Question for redesign**: pick one — drop positional patterns, or drop `--filter` for these commands.

### Modifier-prefix namespaces (`--nf-*`, `--fh-*`, `--fp-*`)

`--notable-funcstr-matches` has modifiers `--nf-min-lines`, `--nf-min-surprise`, `--nf-sort`, `--nf-tight`. `--funcstr-hashes` has `--fh-tight`. `--build-fp-renames` has `--fp-classes`, `--clean-fp`. Three different abbreviation conventions for what's conceptually the same pattern (per-command modifier flags).

**Question for redesign**: standardize the modifier prefix (or eliminate the abbreviations and use full names like `--notable-min-lines`).

### `--follow-calls` is subsumed by `--deep`

`--follow-calls` = `--deep 1`. Both flags exist. Probably the simpler `--follow-calls` should be deprecated in favor of `--deep [N]`.

### `--claim-file` is redundant with `@file.txt` shorthand on `--claim-search`

Both ways to read a claim from a file. Pick one — probably keep the `@file.txt` shorthand and deprecate `--claim-file`.

### `--with` vs. `--claim-text`

Both pass context text to analyze commands. `--with` is the general form; `--claim-text` is `--claim-analyze`-specific. They serve overlapping purposes.

**Question for redesign**: unify to `--with` and deprecate `--claim-text`.

### `--vocabulary` / `--vocab` / `--discover-vocabulary` (aliases)

Three names for one command. Plus `--no-vocabulary` / `--no-vocab` (negation aliases) and `--vocab-tight` (composite). The `vocab` prefix is overloaded.

**Question for redesign**: settle on one canonical name. Probably `--vocabulary` or just `--vocab` — the verb prefix `--discover-` is less consistent with sibling commands like `--hotspots`, `--gaps`, `--entry-points` which are noun-only.

### `--max-results` / `--max` / `-n` (three aliases for one flag)

The triple-alias is unusual. `-n` (a short flag) is rare in CodeExam; most flags use long forms only.

**Question for redesign**: prune the aliases, or document that this is intentional because it's the most-used flag.

### `--max-results` default of 20 collides with user expectation of "list everything"

Beyond the alias question, the default value (20) is itself a design question. Command-line users typing `--list-functions` or `--list-files` often expect "list ALL of them" — the way `ls`, `find`, and most Unix tools behave. CodeExam caps at 20 unless overridden. There's a `Tips:` line at the end of partial lists pointing the user toward `--max-results N`, but the silent truncation is a usability footgun for first-time users.

This isn't just a CLI question — the same pattern shows up in the GUI, where accordions stop expanding at an arbitrary point rather than scrolling naturally to reveal the rest (see GUI issue #38 for the accordion-expansion direction).

**Two competing UX principles in tension**:

- *Front-load by rank* (current behavior): show the user the most important subset first; don't swamp them with everything. Defensible, especially for ranked outputs like `--hotspots` or `--most-called` where the tail is much less interesting.
- *Show everything, let the user filter* (Unix default): trust the user to pipe to `head` / `less` / `grep` if they want less. Defensible for enumerations like `--list-functions` where there's no intrinsic ranking.

**Question for redesign**: per-command defaults that respect the command's semantics — ranked commands keep a cap, enumeration commands default to no cap. Or per-command `--all` flag that explicitly opts out. Or an aggressive `Tips:` line that's harder to miss. Whatever the answer, today's "everything caps at 20 unless you know to ask" is a learning-curve cliff.

---

## Out of scope for this first-pass catalog

- **GUI cross-references** — many CLI flags have GUI equivalents (e.g. `--filter <text>` ⟷ left-pane Filter field). Building that cross-reference is a second-pass exercise; the GUI surface is itself in flux (see #38, #57).
- **Flag combination semantics** — beyond the *Couplings* section above, the full combinatorial space of "what does `--extract --follow-calls --deep N --comments-only` produce together?" is not catalogued here. The Couplings section lists the cross-flag couplings; full combinatorial semantics is downstream design work.
- **Naming-rationale archeology** — `*(rationale unknown — investigate)*` markers throughout are deliberate gaps. Resolving them is per-flag git-blame work, done when a specific entry's history actually matters.
- **The actual redesign** — this file is the inventory + analysis. The redesign proposal lives in [#52](https://github.com/aschulman42-cell/code-exam/issues/52) once this catalog is in hand.

---
*Posted by Andrew's Claude (Claude Code, Opus 4.7).*
