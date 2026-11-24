# CodeExam CLI Reference

*The words the claims flags use — mechanism, HOF, candidate, synonymize, drafter — are defined on [`CODEEXAM_JARGON.md`](CODEEXAM_JARGON.md).*

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
- **Couples with**: `--index-path`, `--extensions`, `--exclude-extensions`, `--demangler`, `--regex-parser`, `--rename-min-lines`, `--no-rename`.
- **Naming**: verb-noun form (`--build-index`) keeps the namespace open for sibling actions on indexes (`--rebuild-functions`, `--build-rename-map`, `--indexes`). Without the verb, ambiguity grows fast.
- **Verified against**: `src/argparse.js:200`

#### `--rebuild-functions`

- **Does**: Rebuilds the function index from already-loaded file contents (the index's stored source) without re-walking the filesystem.
- **Good for**: Iterating on the function-parser logic without paying the file-walk cost. Pair with parser changes during development.
- **Couples with**: `--index-path` (operates on the existing index); `--regex-parser` if the rebuild should use the regex parser only.
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

#### `--build-mechanisms`

- **Does**: Runs the mechanism grouper over an existing index in *cover* mode (what a mechanism is and how to read its label: [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)) — every file seeds a record with all of its functions, every class is a record, every command's handler-and-callees is a record, name-token groups as for drafting; records of one or two functions are kept, test, noise and third-party functions are kept and tagged, records may overlap — and writes `<index>/mechanisms.json`: one record per line with its label, kind, members (file, name, line range), files, a purpose read from the code's own doc text (the module header or docstring for a file and for the first piece of a split file, the class doc, member docs, the outbound calls, else the file's header marked `in <file>:`; a license banner is never a purpose), its outbound calls, and tags (`test`, `noise`, `vendored`, `giant`, `indivisible`). The coverage line it prints is the contract: every candidate function in at least one record.
- **Good for**: Building, once, the file that `--mechanisms`, the GUI's **Mechanisms** list and the MCP `list_mechanisms` tool all read, instead of each recomputing a grouping that takes minutes on a large index. Measured 2026-11-04: 4 s on CodeExam's own index (2,987 functions, 390 records), 2 s on AI_Manning (1,622; 263), 14 s on sr_gh (6,368; 1,298), minutes on WinAPI_Classic (74,061 functions). Re-measured the same day after `build-mechanisms-reads-by-span`, which stopped the per-record reads from resolving names against the whole function index: 208 s on WinAPI_Classic (182 s of it the grouping) and 520 s on Py314_site_pkg (378,225 functions, 51,194 records), where the first build had projected to a day. The not-built line each consumer prints estimates from the function count at 25,000 a minute, an order of magnitude on a large index rather than a promise; what the build time scales with now is the grouping and the one-time masking of each file.
- **Couples with**: `--index-path`; `--describe` adds a model sentence per mechanism. Does not run inside `--build-index` (it would add its minutes to every big build) and is never run lazily by the GUI (it would hang). The drafting list (`--pseudo-claims --candidates`) is a *sample* of the same grouper, untouched by this.
- **Naming**: the `--build-*` family of explicit post-build steps, beside `--build-rename-map`.
- **Verified against**: `src/argparse.js` (`build_mechanisms`), `src/commands/mechanisms.js`, `src/core/mechanisms-index.js`

#### `--describe`

- **Does**: Asks a model (`--llm <provider>` or `--model <gguf>`) for one plain sentence per mechanism, from a pack of the record's label, purpose, calls, member names and the first lines of up to three members, and stores it as the record's `description`. The prompt asks for a sentence that opens with the subject's name as the pack's `MECHANISM:` line gives it (`lib.rs is …`, `Ledger holds …`; for a piece of a split file, the file's name and what that part does), never with This, These or The functions (since 2026-11-09; sentences written before then open with a pronoun for 376 of Bram's 723, and every listing puts the label first for those, see `--toc`). One call per function set: records that are the same functions under two labels (the rows `--mechanisms` folds) are one call, from the pack of the record that names the row, and both take the sentence, so sr_gh's 1,299 records are 1,172 calls. Three scopes: with `--build-mechanisms`, every record just built; with `--mechanisms <filter>` or `--toc <filter>` (or `--filter`), only the matching mechanisms of the existing `mechanisms.json`, the other records keeping whatever they had; alone, every mechanism of the existing file. A cloud run is projected and gated by the claims cost guard first (`--force` / `CE_CLAIMS_COST_GUARD` as for drafting; one call per mechanism, so a whole file of a thousand projects past the $2 default and a filtered dozen does not). When nothing is written the command says so on stdout: `No descriptions written: <reason>`. A pair described twice before the fold existed (two wordings for one function set, which every pair on the described indexes had on 2026-11-05) takes the naming record's sentence on the next run, with no call, and the outcome leads with that: `Unified K record(s) to the sentence of the record with the same functions, no model call needed; all N mechanism(s) already carry one; …`.
- **Good for**: Readable rows where the code carries no doc text, or where a file header describes the module and not the sub-group; describing the handful of records you are reading rather than the file. `--mechanisms`, the GUI and the tool show the description ahead of the harvested purpose when one exists, and the listing's header says how many records carry one.
- **A sentence is paid for once.** Descriptions live in `mechanisms.json`. A run skips records that already carry one (so a filtered run today and an unfiltered run later add up, and a run with nothing left asks no model); `--redescribe` rewrites them. A `--build-mechanisms` rebuild carries descriptions over to every record whose label and member set are unchanged and reports the count; a record the regrouping changed starts over.
- **When the model stops answering** (the network drops, a key expires): after five failures in a row the run stops, keeps every sentence it got, writes the file, and says so; rerunning the same command resumes, since described records are skipped. The cost-guard refusal names the projected and guard amounts on stdout, where a redirected run can read it. With `--mechanisms` in the same command the outcome, written or refused, is repeated after the listing, where a reader of a long list looks.
- **Couples with**: `--build-mechanisms`, `--mechanisms <filter>` / `--toc <filter>` / `--filter`, `--redescribe`, `--llm` / `--model`, `--force`, `--verbose` (progress every twenty records).
- **Naming**: a modifier verb, like `--rank` on `--candidates`.
- **Verified against**: `src/core/mechanisms-describe.js` (`DESCRIBE_SYS`, `describeMechanisms`), `src/commands/mechanisms.js`

#### `--no-rename`

- **Does**: Disables display-time renames for this run; output uses raw obfuscated names.
- **Good for**: Reading code as the bundler wrote it, e.g. when cross-referencing against external tooling that doesn't know about CodeExam's rename overlays.
- **Couples with**: every output-producing flag (display side effect; doesn't affect index state).
- **Naming**: negation form (`--no-X`) common in Unix CLI tradition. Asymmetric: there's no `--rename` flag — renaming is the default; you opt out only.
- **Verified against**: `src/argparse.js:344`

#### `--index-path <path>` (short form: `--ndx`; also `--load-index`)

- **Does**: Path to the index directory. Default: `.code_search_index` in the current working directory. `--ndx <path>` is the same flag with fewer keystrokes (added 2026-11-05 at Andrew's request; `-i` was not free, it is `--interactive`), accepted by the CLI, by `node src/server.js` and by the MCP server, and forwarded by `--gui`.
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

- **Does**: Nothing. Still accepted, so recipes that pass it keep working, and absent from `--help`: the Python-era semantic index it skipped was removed (#322), and the flag has no bearing on `--semantic-search` (2026-11-17), which reads the embeddings `--build-embeddings` writes.
- **Verified against**: `src/argparse.js:479-482`
- **Verified against**: `src/argparse.js:210`

#### `--regex-parser`

- **Does**: Builds the function index with the regex parser on every file. The default (no flag) parses each file whose language has a shipped tree-sitter grammar (C, C++, C#, Go, Java, JavaScript, Kotlin, Objective-C, PHP, Python, Ruby, Rust, Scala, Swift, TypeScript, TSX) with that grammar and merges in the regex parser's extra entries; files in other languages, and every file when `web-tree-sitter` is not installed, get the regex parser anyway.
- **Good for**: Speed on a very large tree, and the pathological single file (a ~400k-line minified bundle) that exhausts Node's heap under the grammar parse — see `example-indexes.md`.
- **Couples with**: `--build-index`, `--rebuild-functions`. `--use-tree-sitter` is still accepted: it names the default, does nothing extra, and is absent from `--help`; giving both flags is an error.
- **Naming**: names the parser you get, not the one you leave; opting out of the default (same family as `--no-rename`; `--use-tree-sitter` and `--skip-semantic` are the accepted-and-hidden kind).
- **Verified against**: `src/argparse.js:468-469`

#### `--extensions <exts>`

- **Does**: Comma-separated file extensions to index. Overrides the default extension list, and turns off the by-name rule that indexes dependency and build files (manifests, lockfiles, `Makefile`, ...) whatever their extension: an explicit list means exactly that list.
- **Good for**: Indexing files that aren't in the default extensions set, or restricting to a specific language family.
- **Couples with**: `--build-index`, `--exclude-extensions`. Build-only: given with `--index-path` and no `--build-index` (as are `--add-extensions`, `--exclude-extensions`, `--regex-parser`) it changes nothing, and CodeExam prints a note with the build command. Interaction with `--scan-extensions` / `--index-extensions` is read-only inspection of extension data.
- **Naming**: noun-only — implies "the extensions to include." Asymmetric with `--exclude-extensions` (explicitly negated).
- **Verified against**: `src/argparse.js:212`

#### `--exclude-extensions <exts>`

- **Does**: Comma-separated extensions to exclude from the index.
- **Good for**: Trimming the index by skipping noisy or irrelevant file types (e.g. `--exclude-extensions json,md` to skip resource files). Dependency and build files stay in by name (`package.json` survives `--exclude-extensions json`); only `--extensions` leaves them out.
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

- **Does**: Searches the index for the query as literal text (case-insensitive, a substring of any line), lists the files whose paths contain it, and, when the query carries a rename marker (`_KW_`, `_CMD_`, `_IMPORT_`: the display names the rename map gives minified identifiers), expands it to the original identifiers it stands for before searching. Nothing follows the literal pass: the semantic pass of the Python-era design was removed (#322), and `--help`'s "literal, with subtoken and vocabulary expansion" names the rename expansion.
- **Good for**: The default search when you have a word or a fragment of a name and want every line that contains it; `--literal` is the same text search without the rename expansion, `--fast` looks the query up as a whole token in the inverted index.
- **Long lines**: a matched line over 300 characters is shown as a window around its first match, with the line's length and the number of matches in it (`…e.isTrusted&&…  [line of 327,144 chars; 2 matches, the first shown; --full-lines shows it whole]`). The same for `--literal`, `--fast`, `--regex` and the context lines of `--verbose`. The query matches inside longer words (`rust` finds `trust`); `--regex "\brust\b"` is the whole word.
- **Couples with**: `--max-results`, `--context`, `--filter`, `--include-path`, `--exclude-path`, `--full-path`, `--full-lines`, `--verbose`.
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

#### `--semantic-search <text>`

- **Does**: Searches the index for text by meaning, under a local embedding model, with no network call. It ranks the index's mechanism entries (groups of functions) the way `--embed-distance --function-text` does, each by its label and member names and by its best member function's text together, and prints the result as places in the code. A row is the function that scored, with its file and line range; under it, the groups that hold that function, each named by its mechanism record id and its label (`in m185 [file] air-gapped.js (6 fn)`; the id since 2026-11-21) (entries whose best function is the same one are one row, the smallest group first), the next-best functions of those groups, and, when the index has descriptions, the smallest group's sentence. `id:<mechanism>` in place of the text (`--semantic-search id:m70`, since 2026-11-21) searches from that mechanism and not from words: its full entry is printed first, it is left out of its own results, each group's name is compared with its name and each group's best function with the mean of its functions' vectors, and the output says the tiers are untested for this use ([`CODEEXAM_SEMANTIC_SEARCH.md`](CODEEXAM_SEMANTIC_SEARCH.md#searching-from-a-mechanism-idm70)). Rows are in two tiers. With the best row's score and the typical score (the median, what an unrelated group scores for this text), a HIT is within 15% of the way from the best down to the typical, a NEAR HIT within 35%. The tiers are relative to this index and this text: they say which code is closest, and the header says a hit is a place to read and not a finding. No absolute line is drawn, because none separated found from not found when one was looked for (the band's history in `src/commands/embed-distance.js`, and the wrong-codebase runs of 2026-11-16 in [`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md)). When more hits tie the best than a tier shows, the listing says nothing stands out. `@<file>` reads a claim and searches for every element (CodeExam's split, or `--elements @list` verbatim): a listing per element, then `ACROSS THE N ELEMENTS`, the places within the first 25 results for the most elements, each with a `#` or `.` per element (on a small index the view looks no deeper than a fifth of the results, at least 3, and its heading says how deep: on the 29-group demo the first 25 were nearly everything). The model is the index's own: gemma when the index has gemma embeddings and the model file is installed, said in the header without being asked for; otherwise whichever model the index has embeddings for, named, with the command that would build gemma's. `--embed-model <name>` chooses. A search builds nothing: with no embeddings for the model, or with more than 200 texts not yet embedded because the index changed, it prints the `--build-embeddings` command and says to run the search again (up to 200 missing texts are embedded on the spot, and the header counts them). Test, mock, benchmark and example code is left out by the one rule for test code (see "Test code: when it is listed and when it is left out"), and the output ends with a Tip saying how many groups and functions; `--include-tests` brings it in. With `--toward-code restate|label` (or `@file` of saved rewrites; `--spec <file>` as for `--embed-distance`) a model first rewords each text toward the index's names, one call per text, and the search is by the rewording: the header says so and carries the option's caution, and each listing marks the text `as written` and prints under it `SEARCHED AS (a model's rewording; the results below are for this, not for the text above):` and the rewording, or `SEARCHED AS WRITTEN:` and the reason when the model did not reword it. It is the same step `--embed-distance --toward-code` runs, with the same cost gate and the same refusal of a cloud model under `--air-gapped`; it runs after the embeddings check, so a search that stops for a missing build spends nothing. On one element of the '101 claim against ExoPlayer 3 the label form moved the first `AdaptiveTrackSelection` function from 129th to 11th (2026-11-17, one run); it has helped on public codebases and is untested on code a model has not seen. The output ends with any steps that use a language model and might help, each with its command: `--describe` when the index has no descriptions, and `--toward-code label` when the text reads like a patent claim or when nothing stood out for it (not when the run was already reworded); under `--air-gapped` only the local-model form is named. An option given that does nothing here is named in the header and not dropped silently: `--function-text` (already how a search ranks), `--against` and `--no-prefix` (they belong to `--embed-distance`); an unknown `--toward-code` form is refused.
- **Good for**: Finding where a codebase does something described in ordinary words, when the words are not the code's own ("refuse to send code to a cloud model" on CodeExam's index puts `air-gapped.js`'s `assertLocalOnly` second, where the group listing of `--embed-distance` had `[file] air-gapped.js` 39th). A first look at which part of a codebase a patent claim concerns. It is weaker on a claim than on a plain description: on the public claim charts the entry holding a cited function was within the first 25 for 58% of cited names ([`describe-reach.md`](describe-reach.md)), the ranking finds the part of the code a claim is about and does not tie one limitation to its code, and on the '101 claim against ExoPlayer 3 the listings were mostly short getters and setters matched on single words (2026-11-17). Code that is badly named and uncommented is not found.
- **Couples with**: `--build-embeddings` (required once per index and model), `--embed-model`, `--elements`, `--filter` (keeps the rows whose function, path or group contains the string, ranks unchanged, and lists matches below the near hits too), `--max-results` (rows per tier, default 10; `0` for all), `--include-tests`, `--verbose` (full paths, every group, the score's two parts and the group's rank), `--cpu`, `--air-gapped` (changes only the closing suggestions; the search itself makes no call). `--toward-code`, `--spec`, `--llm` / `--model`, `--show-prompt`, `--force` (the rewording step). `--embed-distance` is the same ranking as raw cosines, with `--against` and the calibrated band, which this command does not have.
- **Naming**: what a user looks for; it is semantic in the plain sense, nearest by an embedding, and the header and the docs say what that does not show. CLI only as of 2026-11-17: no GUI control and no MCP tool. The guide, with what the text is compared to and the caution `--filter` and `--toward-code` need, is [`CODEEXAM_SEMANTIC_SEARCH.md`](CODEEXAM_SEMANTIC_SEARCH.md).
- **Verified against**: `src/argparse.js` (`semantic_search`, `build_embeddings`), `src/commands/semantic-search.js` (`chooseSearchModel`, `searchRows`, `searchTiers`, `renderSearch`, `renderAcross`, `closingTips`, `unusedOptionNotes`, `doSemanticSearch`), `src/commands/toward-code.js` (`towardCode`), `test/test_semantic_search.js`

#### `--build-embeddings`

- **Does**: Builds what `--semantic-search` reads, with a local embedding model and no network call: one vector per mechanism entry's label and member names (and one per chunk of eight names for a long entry), and one per function's text (its name as words, its rarer identifiers, its comments), saved under `<index>/embeddings/`, one file per model and kind. They are the same cache files `--embed-distance` and `--embed-distance --function-text` write, so either command's earlier work is reused. Says how many texts there are and how many are left before it starts, reports about once a minute, saves as it goes, and continues where a stopped run left off; with nothing left it says so and gives the search command. Uses gemma when its model file is installed, else nomic, and says which and why; `--embed-model <name>` chooses.
- **Good for**: The one-time step before searching an index by meaning. A small index takes seconds (the demo's 140 texts, 11 s); ExoPlayer 3's 45,317 function texts took about 45 minutes on a laptop CPU (2026-11-16).
- **Couples with**: `--build-mechanisms` (required first; the message names it), `--embed-model`, `--cpu`. After `--build-mechanisms` is run again, run this again: it embeds only what changed.
- **Naming**: the `--build-*` family, beside `--build-index` and `--build-mechanisms`. One set of files per embedding model, all local: [`CODEEXAM_SEMANTIC_SEARCH.md`](CODEEXAM_SEMANTIC_SEARCH.md) ("Embedding models").
- **Verified against**: `src/commands/semantic-search.js` (`chooseBuildModel`, `doBuildEmbeddings`), `src/core/embed.js` (`missingInCache`, `embedAll`), `src/commands/embed-distance.js` (`entryEmbedPlan`, `loadFunctionPlan`)

#### `--show-function-text [filter]`

- **Does**: Lists the text `--semantic-search` and `--embed-distance --function-text` embed for each function, exactly as it is embedded: the function's name as words, a colon, the identifiers of its body ranked by how rare they are in the index, its comments, then `Text:` and the words of its string literals. Ruled lines in a banner comment (a run of three or more `=`, `-`, `*`, `#`, `_`, `~` or `+`) are left out of the comments since 2026-11-23, the words between them kept; before, a boxed heading above a function put two 72-character rules into its text. The text is built from the index; no model runs and nothing is written. Each entry is `file@function`, its line range and the record ids of the mechanisms that hold it (`in m33 m92 m103`, the ids `--mechanisms` shows), then the text on the next line. A header gives the count, the shortest, median and longest text, and how many are under 40 characters.
- **Good for**: Seeing what a function's vector stands for before trusting a search or a distance. A function with a comment reads close to a description of it; one without is mostly identifiers, some of them names every file uses (`push`, `slice`, `log`).
- **Couples with**: a filter on `file@function` (substring, or `/regex/`; `--filter` is read when the option has no value); `id:m70` in the filter's place, for the functions of one mechanism; `--text-has <text>` (substring in any case, or `/regex/`), which keeps only the functions whose embedded text holds it and combines with either of the others, so each match comes under its `file@function` line, where a grep of the listing would give the matching line alone; `-v`, the text's four pieces apart with their lengths; `--include-tests` (test functions are left out by default, and the output ends with a Tip saying how many); `--max-results` / `--all-results` (50 entries by default).
- **Limits**: A function is embedded only when a mechanism holds it and the embedding commands reach it. The listing shows the others too and says which case each is, and the header counts them: `in no mechanism, not embedded`, and `in m57, not embedded: a second definition of this name in the file`. Since 2026-11-23 the commands reach a second definition of a name within a file by its start line (it is listed as `file@name@<line>`, with its own text), so the second marker appears only for a mechanisms file whose members carry no line ranges; and `--build-mechanisms` puts a function with a generic name (`main`, `init`, `get`, a constructor) of four lines or more in its file's mechanism, so on a mechanisms file built since then `in no mechanism` means a function of one to three lines. The figures that follow are from before both changes. On CodeExam's own index (2026-11-22) no text is embedded for 803 of 2,797 functions outside tests: 771 in no mechanism (709 of them one to three lines long; the other 62 include functions named `main`, `init`, `get` and class constructors) and 32 second definitions. On an index with no mechanisms file the texts are listed without ids, and `id:m70` is refused (exit code 2, as for an id the index lacks). Class and file texts are not listed.
- **Naming**: beside `--show-file`. `--function-text` (no `show`) is the option that changes how `--embed-distance` ranks.
- **Verified against**: `src/argparse.js` (`show_function_text`, `text_has`), `src/commands/function-text.js` (`selectFunctionTexts`, `formatFunctionTexts`, `doShowFunctionText`), `src/core/function-text.js` (`functionText`, `functionTextParts`), `test/test_show_function_text.js`

#### `--embed-distance <text>`

- **Does**: Measures how close a text is, under a local embedding model, to one other text (`--against "<text>"`: the cosine and the distance, 1 − cosine), to a list (`--against @file`, one candidate per line, `#` comments skipped, lines cut at 1,500 characters), or, with no `--against`, to every mechanism entry of the index named by `--ndx`, scored as [`describe-reach.md`](describe-reach.md) scores them: the entry's label and member names in chunks of 8, the entry by its best chunk, vectors cached under `<index>/embeddings/` so a second query on a large index costs the query alone; a first run under a model says on stderr how many texts it will embed and the file they are saved to, then reports the count done and an estimate of the time left about once a minute, and a run that reads every vector from the cache says nothing (since 2026-11-19; before that a first run was silent without `--verbose`, about ten minutes on ExoPlayer 3 under gemma). `@<file>` in place of the text reads the file as a claim and measures every element in one process (since 2026-11-09): the split is CodeExam's, the elements `--claim-chart` would chart: when the file has markers such as `(a)` or `(i)`, each marker starts an element and the lines between continue it; when it has several lines and no markers, each line is a limitation, a trailing `;`, `,` or `and` dropped; a one-line claim splits at its semicolons, the preamble before the colon first; each piece is then cut at `wherein`, `, which is` and `, and`, fragments under 35 characters merged back. A file wrapped mid-limitation with no markers over-splits, which is what `--elements @list` is for: it supplies the elements verbatim, one per line with `#` comments, the `--claim-chart` contract; the model and the cached vectors load once, each element prints its listing under `element N of M`, and a table closes the run with each element's nearest entry, its margin over the median, the band's word and, under `--filter`, the rank of the first entry the filter matched, the believed implementer's rank per element. `--summary-top <n>` (since 2026-11-19) shows the nearest `n` entries per element in that table, each on its own line under the element with its own margin over the median, where the default shows only the nearest: for when the entry wanted is second or third and its name is not known in advance (when it is, `--filter` gives its rank). It applies to the table of a run under one model; with one text, with `--against "<text>"`, or under several models (whose table compares margins and has no nearest column) a line on stderr says it does nothing. The '101 claim's eight elements against ExoPlayer 3 took 137 s as eight calls, the model and 17,607 vectors loaded per call, and run as one. A listing prints the query, what was ranked, the median cosine (what an unrelated candidate scores under this model; raw cosines are not comparable across models) with how far the nearest candidate sits above it, then one line naming the columns (`rank  cosine  entry`, or `candidate` for a list given with `--against`) and rows of rank, cosine, the entry's mechanism record id (`m70`, the id `--mechanisms` shows; since 2026-11-21, and not for candidates given with `--against`, which are texts) and the entry, the `--max-results` nearest (default 20; `0` for all). `id:<mechanism>` in place of the text (`--embed-distance id:m70`, since 2026-11-21) measures from that mechanism of the index to every other one by the vectors already saved for it: the mechanism's full entry is printed first, as `--mechanisms -v` prints it and with the date its mechanisms file was built, so the reader can check the id names what they meant (an id belongs to one build); the mechanism is left out of the rows; the no-match band is not read, since it was set on written queries; with `--function-text` the function part is the mean of its functions' vectors; it is refused with `--against` and `--toward-code`, and an id the index lacks stops the command ([`CODEEXAM_SEMANTIC_SEARCH.md`](CODEEXAM_SEMANTIC_SEARCH.md#searching-from-a-mechanism-idm70)). Until 2026-11-19 every row read `cosine 0.5951  distance 0.4049`; the distance is 1 − cosine, the same fact twice, and is now printed only for one pair, since the margin, the median and the band are all in cosine. Something always ranks first, so the listing reads the nearest candidate's margin over the median against a band: under 0.12 it says `no clear match` before the rows; from 0.12 to 0.16 it says `borderline`, the band where queries with a known mechanism and queries the codebase has nothing for both land; above 0.16, nothing. The band is calibrated, not derived (2026-11-07, nomic, three indexes): queries with a known mechanism put their top row 0.15 to 0.30 above the median, queries the codebase has nothing for ("generate prime numbers" on CodeExam's own index) 0.08 to 0.14, with one unrelated query at 0.20 whose top row shared a word with it, so the notes can be missing where a label word happens to match and neither means "found". The first rule was a single line at 0.14; on 2026-11-08 four rewordings of one query about multisect on CodeExam's index landed at 0.137 to 0.180 with the multisect mechanisms in every top row, and the first of them fired the note, which is why the line became a band. The margin is printed on the median line either way. Two limits of the band, measured 2026-11-09 on the demo claim's eleven elements, the '101 claim's nine against ExoPlayer 3, and known-near and nothing-there queries on the demo, ExoPlayer 3 and CodeExam's own index: its numbers are nomic's, so under another model the margin prints and the note does not (the same demo elements sat 0.21 to 0.49 above the median under jina and coderank, and jina's nothing-there queries reached 0.27); and on a small index it under-calls, because a nothing-there query's top row is the best of few draws and sits lower above the median (on the 34-entry demo nothing-there queries topped out at 0.110 and three true matches with the right mechanism first scored 0.107 to 0.119; on 383 entries nothing-there queries reached 0.168 and on 10,828 they reached 0.172, where the known matches start at 0.183), so under 100 entries the note says so and points at the rows. No scale-free unit did better: the margin in units of the field's median absolute deviation, or of its median-to-90th-percentile distance, overlapped between known matches and nothing-there queries on every set by more than the raw margin, so the numbers stay. `--embed-model <a>,<b>` or `--embed-model installed` (every registry model whose file is under `models/`) runs the same claim under each model in turn, one loaded at a time, each with its own cache: the listings print per model, then one table with each model's margin per element and, under `--filter`, its rank, and one line per model, with a filter how many elements put the filtered entry first and within 25 (the describe-reach reading for one claim), without one how many of its nearest entries agree with the first model's (the demo claim: coderank agrees with nomic on nine of eleven, jina on six). `--filter <s>` applies after ranking, so every match keeps its overall rank and an entry line names the member that matched: `--filter determineIdealSelectedIndex` on the ExoPlayer index puts `[class] AdaptiveTrackSelection / other` at its rank among 11,000 entries. `--verbose` adds, under each entry, its block as `--mechanisms -v` prints it (the id with the description when there is one and it names its subject, the label line with counts and tags, the two the other way round for a sentence that opens with This or These, every member as `file@name  (L12–48)`) and then the chunk that scored, which is how to tell a label word's hit ("Receiver" for "reception device") from a mechanism's; with the functions and their lines under each nearest entry, the listing doubles as an ad-hoc claim-chart tester: type an element, open what it is near. Models: `--embed-model nomic` (default, shipped) `| jina | coderank | qwen06 | qwen4 | <path.gguf>`, each with its own query and document prefixes (`--no-prefix` embeds the texts as given); a named model whose file is not under `models/` fails with the path and the download source. Local only: no network, no key, `--cpu` forces the CPU; `--air-gapped` changes nothing. Needs `mechanisms.json` (`--build-mechanisms`, no model) for the index form.
- **Good for**: Seeing, before any model reads any code, how near a claim element sits to a codebase's mechanisms in a given embedding, which entries it is near and why; comparing two wordings of an element (the claim's and the engineer's) against the same entries; finding where a particular function's entry fell.
- **Couples with**: `--against`, `--elements` (with `@<file>`: the elements verbatim, as for `--claim-chart`), `--embed-model` (`nomic` the default, `jina`, `coderank`, `qwen06`, `qwen4`, `gemma` and `gemma-search` for EmbeddingGemma with its code-retrieval or its general search prompt, or a path to a `.gguf`; one, a comma list, or `installed`; the band's notes only under nomic; `--embed-model list`, with no index and no other flag, prints the models CodeExam knows by name, which are installed under `models/`, the prefixes each is run with and where to download it), `--max-results` (per element), `--filter` (per element, and the table's rank column per model), `--summary-top <n>` (with `@<file>` under one model: the nearest `n` per element in the closing table; default 1), `--no-prefix`, `--function-text` (since 2026-11-15, for testing, on an index only and refused with `--against`: each entry is scored by two texts together, 0.3 on the cosine of its label and member names and 0.7 on the highest cosine among its member functions' own texts, a function's text being its name, ranked vocabulary and comments as `src/core/function-text.js` builds them with no model; an entry with no such function keeps its label cosine; under the header line `rank   score   label  function  entry` a row is the rank, the score, the label's cosine, the function's cosine (`none` when the entry has no function text), the entry, and `via file@function`, the function that scored; the first run under a model embeds one text per member function and saves them as `<index>/embeddings/<model>_function-text-comments.json`, about a minute for CodeExam's 2,127 functions and about 45 for ExoPlayer 3's 45,317 under gemma (the estimate that run printed near its start, 2026-11-15) on the Surface's integrated GPU, with the count and a time estimate on stderr before and during; the no-match band is not read under this score; off by default because on the self-test claims it put the right entry first far more often and on litigants' chart rows it gained nothing, see [`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md)), `--toward-code restate|label|@file` with `--spec <file>` (since 2026-11-16, for testing, on an index only and refused with `--against`: a model rewords each element toward the names this codebase uses, one call per element, and the entries are ranked by the rewording; it needs `--llm <provider>` or `--model <gguf>`, a cloud model printing its projected cost first, stopping above $2 unless `--force`, and refused under `--air-gapped`; the model is shown the element, the whole claim, 150 words from the index's names (80 for a local model), read from the index's `vocabulary.json`, which `--vocabulary` writes, and the patent's specification when `--spec` names a text file of it, sent with every element and most of the cost; it is shown no source code; `restate` asks for one sentence saying what the element requires in an implementing engineer's words; `label` asks for a mechanism label and function names as the model expects the code to be named, the shape of the entries ranked, and also shows the model 40 of the index's entries taken at even steps, not chosen by the claim; `@file` reads rewrites an earlier run saved and calls no model; each listing prints the element as written and under it `searched as:` and the rewording, or `searched as written: not reworded (…)` when the call for that element failed; with `@<claim file>` the rewrites are saved beside the claim file as `<claim>.toward-code-<form>[-spec].<index>.txt`, one per line with the elements as `#` comments, the path on stderr; `--show-prompt` prints what would be sent and calls no model; the no-match band is not read under a rewording; a rewording is a model's search query and not a reading of the claim, and a model told a codebase's words uses them whether or not the code is there, so a good rank under this option has not been shown to tell code that practises an element from code that does not: on litigants' chart rows a rewording reached more of the cited code and another limitation's rewording reached it almost as often, see [`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md)), `--cpu`, `--verbose`, `--ndx`.
- **Naming**: the measure, not the method; `--against` carries the second operand because the parser takes one value per flag; `@<file>` on the query side reads as it does on `--against`, "from this file".
- **Verified against**: `src/argparse.js` (`embed_distance`, `against`, `elements`, `embed_model`, `no_prefix`, `summary_top`, `function_text`, `toward_code`, `spec`), `src/commands/toward-code.js` (`buildTowardCodePrompt`, `buildTowardCodeUser`, `sampleEntryTexts`, `rewriteElements`, `formatRewriteFile`, `towardCode`), `src/core/vocabulary.js` (`cachedVocabularyWords`), `src/commands/claim.js` (`vocabConcordanceOptions`), `src/core/function-text.js` (`FUSE_ARM`, `FUSE_LABEL_WEIGHT`, `fuseSum`), `src/commands/embed-distance.js` (`functionTexts`, `rankFused`, `resolveQueries`, `resolveEmbedModels`, `bandCalibrated`, `SMALL_INDEX`, `rowHeader`, `formatRow`, `renderSummary`, `renderComparison`, `doEmbedDistance`), `src/commands/claim-locate.js` (`splitClaimElements`, `parseElementsFile`), `src/core/embed.js`

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
- **Couples with**: `--max-results`, `--filter` (separate from positional pattern — surprisingly), `--include-path`, `--exclude-path`, `--full-path`, `--sort`, `--exclude-tests` / `--no-tests` (leave out a function that is test code by the one rule for a function: its file's path, its name (`test_x`, `FooTest`, `MockClock`) or, since 2026-11-23, a test attribute above it, such as a Rust `#[test]` in a source file; the closing Tip says how many were left out. The same in the `-alpha` and `-size` forms).
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

#### `--clean-zip-cache`

- **Does**: Remove every cached extraction of a zipped index (`codeexam-zip-index/<name-size-mtime>` under the system temporary directory, the place CodeExam names on the terminal when it extracts a `.zip` index) and say how many it removed, or that there was nothing. Touches nothing else; loads no index.
- **Good for**: The close-of-case destruction step a protective order requires: the cache is an on-disk copy of the index that nothing removes by itself (see [`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md), the artifacts inventory). Also reclaims the entries the test suite's zip tests leave behind.
- **Couples with**: independent; the cache is per machine, not per index.
- **Naming**: verb-noun, like `--build-index`; "zip cache" names the one cache CodeExam keeps outside an index directory.
- **Verified against**: `src/argparse.js:502`

---

## CALLERS / CALLEES

#### `--callers <spec>`

- **Does**: Find callers of a function. `<spec>` is `FUNC` or `FILE@FUNC`; the file form lists only the sites that can reach that definition (a bare name lists every same-named site). Module-level sites are grouped under `(file scope)`.
- **Good for**: "Who calls this?" — the most common reverse-navigation question.
- **Couples with**: `--depth` (transitive callers, one level per step; each level lists up to 200 call sites), `--max-results` (caps the call sites of the one-level form only; default 20), `--verbose` (lists every call site of a caller, not three, in the one-level form), `--exclude-tests` / `--no-tests` (since 2026-11-23: call sites in test, benchmark, mock and example files are left out at every level, the cap applies to the sites kept, and the closing Tip says how many were left out; when every caller is in test code the answer is "No callers found for 'X' outside test code" and the count). Not read: `--filter`, `--include-path`, `--exclude-path` (this line named the last three until 2026-11-23; `doCallers` has no path or name filter; those three act in `--most-called` and `--call-inventory`).
- **Naming**: noun-only.
- **Verified against**: `src/argparse.js:249`

#### `--callees <spec>`

- **Does**: Find functions called by a function. `<spec>` as for `--callers`; a call with no reachable definition is marked `[unresolved]`, a pick among several `[ambiguous]`.
- **Good for**: "What does this call?" — the forward direction.
- **Couples with**: `--verbose` (lists up to three definitions of a callee that has several), `--exclude-tests` / `--no-tests` (since 2026-11-23: a callee all of whose definitions are in test, benchmark, mock and example files is left out, and the closing Tip says how many; a callee with no definition in the index stays). Not read: `--depth`, `--max-results`, `--filter`, `--include-path`, `--exclude-path` (this line said "same as `--callers`" until 2026-11-23, which named three options `doCallers` does not read either).
- **Naming**: parallel.
- **Verified against**: `src/argparse.js:250`

#### `--most-called <n>`

- **Does**: Show top N most frequently called functions in the index.
- **Good for**: Finding the most-invoked APIs / utility functions — often the entry points to subsystems.
- **Couples with**: `--defined-only`, `--min-name-length`, `--include-macros`, `--filter` (a substring or `/regex/` on the function name), `--include-path`, `--exclude-path` (on the definitions' files: a function with no definition left is dropped), `--max-results` and `--all-results` (the count, when `<n>` is not given), `--exclude-tests` / `--no-tests` (the same, on the definitions' files).
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

### Test code: when it is listed and when it is left out

One rule says what test code is, in every command and on every surface that reads it (`src/core/test-paths.js`):

- A **file** is test code by its path: it is under a directory named `test`, `tests`, `testing`, `testdata`, `__tests__`, `spec`, `bench`, `benchmarks`, `mock`, `mocks`, `fakes`, `stubs`, `example`, `examples`, `samples` or `conftest`, or its name is of the shape `test_*`, `*_test`, `*.test.*`, `*.spec.*`, `FooTest`, `TestFoo`, `bench_*`, `mock_*`, `fake_*`, `example_*`. The patterns are anchored at word boundaries, so `latest.js`, `contest/` and `attest.c` stay in.
- A **function** (or class or other symbol) is test code by its file's path, by its name (`test_sign`, `RateChooserTest`, `MockClock`, `FakeGroup`), or by a test attribute above it (a Rust `#[test]` in a source file whose path says nothing).
- A **mechanism** (a group of functions) is test code when it has members and every member is. This is decided when a listing is made, not by the `test` tag `--build-mechanisms` wrote (the tag is still in the file and still shown on a row).

Commands fall into two families, and the principle that separates them is stated here so that a user does not have to learn it command by command.

- A command that **finds exactly what was typed** lists everything and leaves test code out only when asked, by `--exclude-tests` or `--no-tests` (two spellings of one option). These are the text searches, `--multisect-search`, `--multisect-analyze`, `--claim-search`, `--claim-analyze`, `--claims-loop`, the file, function and class listings, `--callers`, `--callees`, `--most-called`, `--hotspots`, `--entry-points`, `--domain-fns`, `--class-hotspots`, `--data-structs` and the AI/ML listings. A hit dropped silently from a literal search is the worse error, so nothing is dropped unless the user said so. `--call-tree` does not read the option at all: a tree with branches left out would look complete when it is not.
- A command that **ranks or summarises** leaves test code out and lists it only when asked, by `--include-tests`. These are `--mechanisms`, `--toc`, `--carve`, `--concepts` (the mechanisms it counts), `--show-function-text`, `--semantic-search`, `--claim-locate`, `--claim-chart`, `--hof` and the MCP claim tools. There test code crowds out the code that matters.

Every command that leaves test code out, whichever family and whether by default or by option, ends with one line, the last on its output, saying how much and what lists it: `Tip: 63 mechanisms of test, benchmark, mock and example code left out; --include-tests lists them.` for a command that leaves it out unasked, and `Tip: 19 call sites of test, benchmark, mock and example code left out (--exclude-tests); run without it to list them.` for one that was asked to. A count that is a lower bound reads `at least N`. Nothing is printed when nothing was left out. The MCP tools end with the same line in their own argument words (`include_tests: true`, `exclude_tests`).

One exception to the rule: the AI/ML listings also treat a `demo` or `demos` directory as example code, and nothing else does.

The first principle is not yet fully kept: exact commands still cap their results by default (`--max-results`, `--all-results`) and say so in a cap notice, so a command that "lists everything" lists the first 20 or 100 of it unless `--all-results` is given.

#### `--exclude-tests`

- **Does**: Leaves test code out of a search or a listing, for the first family above (see "Test code: when it is listed and when it is left out" for the rule, the families and the closing Tip). `--no-tests` means the same thing in every command that reads either (since 2026-11-19; before that `--no-tests` was read only by the AI/ML listings). Off by default. `--mechanisms`, `--toc` and the rest of the second family leave test code out already, so with `--exclude-tests` they do what they do and draw no note.
- **Read by**: the text searches (`--search`, `--regex`, `--literal`, `--fast`, `--files-search`, `--folders-search`), `--multisect-search` (whose header says, without the option, how many test files are being searched), `--multisect-analyze`, `--claim-search`, `--claim-analyze` and `--claims-loop` (their multisect searches), `--callers` and `--callees` (call sites and callees in test files), `--list-files`, `--list-functions` (and its `-alpha` and `-size` forms, which leave out a function by the rule for a function: path, name or attribute), `--list-classes`, `--most-called`, `--hotspots`, `--entry-points`, `--gaps`, `--domain-fns`, `--class-hotspots`, `--data-structs`, and the AI/ML listings, which drop the records their detectors tagged as test or example code.
- **Not read by**: everything else, including `--call-tree` (on purpose: a tree with branches left out would look complete when it is not) and the GUI's searches (its **View → Exclude Tests** hides AI/ML rows only). The MCP tools whose command-line forms are listed above take `exclude_tests` (since 2026-11-23): `search`, `regex_search`, `multisect_search`, `callers`, `callees`, `most_called`, `hotspots`, `entry_points`, `list_files`, `list_functions`, `list_classes` and `data_structures`. Given with a run in which no command reads it, one line on stderr says it did nothing and names the commands that read it; given with `--call-tree` the line says why it does not read it, also in a run where another command does; the run goes on. The claim tools and `--semantic-search` work the other way round: they leave test code out by default and `--include-tests` brings it back.
- **Changed 2026-11-23**: the AI/ML listings tag a record as test or example code by this same rule, plus a `demo/` or `demos/` directory (they had a pattern of their own: it knew `demos/` and `conftest` and not `mocks/`, `bench/`, `fake_*` or `FooTest.java`); `--gaps` no longer counts any path holding the letters `test` or `spec` as an entry point. The `.fit()` and `.predict()` gates inside the training and inference detectors keep their own narrower pattern, because changing it altered a plain `--training`.
- **Changed 2026-11-19**: `--most-called` and the `--hotspots` family used to read `--exclude-tests` as "the path contains the letters `test`", which dropped `latest.js` and kept `examples/`; they now use the rule above. Until then the text searches, `--multisect-search` and the file and function listings accepted both options and ignored them.
- **Good for**: Hotspot scans and searches where you want only production code, not test fixtures.
- **Naming**: `--exclude-X` form (parallels `--exclude-path`); `--no-tests` is kept as the second spelling.
- **Verified against**: `src/core/test-paths.js` (`testPathClass`, `isTestSymbol`, `isTestEntry`, `testsTip`, `leavesTestsOut`, `withoutTests`, `TEST_OPTION_READERS`, `unreadTestOptionNote`), `src/commands/search.js` (`filterResultsByPath`), `src/core/multisect.js` (`pathOk`), `src/commands/browse.js`, `src/commands/callers.js` (`doMostCalled`), `src/commands/metrics.js` (`applyPathFilters`, `dropTests`), `src/index.js`

#### `--no-tests`

- **Does**: The second spelling of `--exclude-tests`, in the same family (commands that find exactly what was typed), with the same meaning and the same closing Tip. See "Test code: when it is listed and when it is left out".
- **Naming**: `--no-X` form, kept from before `--exclude-tests` read the same rule everywhere.

#### `--include-tests`

- **Does**: Lists test code in a command that leaves it out unasked, the second family: `--mechanisms`, `--toc`, `--carve`, `--concepts`, `--show-function-text`, `--semantic-search`, `--claim-locate`, `--claim-chart`, `--hof` (and `include_tests: true` on the MCP `list_mechanisms` and `claim_candidates`). It has no effect on a command of the first family, which lists test code already. Without it, those commands end with the closing Tip saying how many were left out; with it, nothing is left out and no Tip is printed.
- **Naming**: the opposite of `--exclude-tests`, and the other face of the same rule.

#### `--call-inventory [spec]`

- **Does**: Show call targets partitioned into in-index vs. external. No argument: scan the entire codebase (every call target, in-index vs. external — a call-level view, not the dependency bill of materials, which is `--bom`; see [`CODEEXAM_MAPPING_DEPENDENCIES.md`](CODEEXAM_MAPPING_DEPENDENCIES.md)). With function name: single-function inventory.
- **Good for**: "What does this code depend on?" — surfaces external calls (library APIs, builtins) as a flat list.
- **Couples with**: `--filter` (a case-insensitive regex on the external targets' names and provenance), `--verbose`, `--full-path`, `--max-results` and `--all-results`, and, in the no-argument form only, `--include-path` and `--exclude-path` (the first pattern given of each; the single-function form ignores them). `--exclude-tests` is not read by it. (This line named `--filter` and `--verbose` only until 2026-11-23.)
- **Naming**: noun phrase.
- **Verified against**: `src/argparse.js:259`, `src/commands/callers.js` (`doCallInventory`)

---

## GRAPH

#### `--call-tree <spec>`

- **Does**: Show call tree (callers up + callees down).
- **Good for**: Visualizing the full call neighborhood of a function in one view.
- **Couples with**: `--depth` (default: 3 for trees), `--mermaid`, `--verbose`. `--exclude-tests` and `--no-tests` are not read by `--call-tree`, on purpose: a tree with branches left out would look complete when it is not, so every branch is shown, test code included, and the note on stderr says so. (This line said `--exclude-tests` was read until 2026-11-19.) `--include-path`, `--exclude-path` and `--filter` are not read either.
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

- **Does**: Find suspicious dead code — defined, no callers, not an entry-point. A function in test, benchmark, mock or example code is counted as an entry point, by the rule `--exclude-tests` reads (`src/core/test-paths.js`); until 2026-11-23 any path holding the letters `test` or `spec` was, which hid `latest.js` and `introspection_tools.py` and showed `mocks/`.
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

#### `--mechanisms [filter]`

- **Does**: Lists the mechanisms `--build-mechanisms` wrote, one row per function set: records that are the same functions under two labels (a one-class file as `[class] Foo` and `[file] foo.py`; a token group that coincides with a file piece) fold into one row, the other label on an `also` line, so the file's 390 records on CodeExam's index list as 383 rows, sr_gh's 1,299 as 1,172 (measured 2026-11-05; a class inside a larger file record is its own row, nothing looser folds). A header with the row count, the record count when any folded, and the cover (how many of the index's functions and files the records hold, when the file was built, which engine described it), then per row its id (`m1`, `m2`, …, the id of the record that names it: the described one when exactly one is, else the command, class or token record over the file record) and, when a model wrote one (`--describe`) and the sentence names its subject, its description first, with the label, function and file counts and tags on the next line; a sentence that opens with This, These or The functions (its subject being the label it was written for) sits beneath the label line instead, so the name reads before the pronoun; otherwise the label, counts and tags, then its harvested purpose; then `also` and the folded labels; then its member names (`-v` lists every member as `file@name  (L12–48)`, the range being the function's lines in the index, and lifts the 240-character cut on the text). With a filter, a row whose match is not on it says what matched, on a line after its text: `holds <member>` for a member beyond the twelve names printed (the word `--embed-distance --filter` uses), `in <file>` for a file (files are counted on every row, never listed), `purpose "…"` for the harvested purpose a model's sentence replaced; a match on the id, the label, the sentence, a tag, a folded label or a printed name adds nothing, and under `-v`, which prints every member as `file@name`, only a replaced purpose can need the line. While no record in the file is described, the last line says how to get descriptions: `No model descriptions yet: ce --index-path <X> --mechanisms <filter> --describe --llm claude writes one sentence per listed mechanism (about $0.003 each on Claude; above the $2 claims guard add --force)`, the filter carried along because describing the listed records is the cheap way; a `--describe` in the same command reports its own outcome there instead, written or refused. The `list_mechanisms` MCP tool prints the same lines. When the index has no `mechanisms.json` it prints one line — `not built: run ce --index-path <X> --build-mechanisms (about N minutes on an index this size)` — and nothing else.
- **Good for**: Reading what a codebase is made of at a grain between a function and a file, with every function somewhere in the list; finding the record for a class, a command or a module by name, by a word of its purpose, or by a member's name.
- **Couples with**: `--filter` (the same substring / `/regex/` contract as every listing, over id, label, purpose, description, tags, files, member names and a row's folded labels; the optional value is the same filter), `--max-results` (default 100; `0` lists all), `--all-results`, `-v`, `--describe` (the outcome follows the listing), `--toc` (the same rows, one line each), `--sort-by` (the order; below), `--include-tests` (rows that are wholly test code, by the one rule, are left out unless it is given, and the closing Tip says how many; a filter that matched only such rows says so).
- **Naming**: target-type-first noun, beside `--functions`, `--files`, `--classes`.
- **Verified against**: `src/argparse.js` (`mechanisms`), `src/commands/mechanisms.js` (`doMechanisms`), `src/core/mechanisms-index.js` (`foldRecords`, `recordBlock`, `sentenceNamesSubject`)

#### `--sort-by <order>`

- **Does**: Sets the order of `--mechanisms` and `--toc` (since 2026-11-20): `size`, `path` or, since 2026-11-23, `similarity` (below). `size`, the default, is the order of the mechanisms file, largest row first, and was the only order before. `path` groups the rows by source directory under a heading line with the count (`--- src/core/  (123 rows) ---`): every row under the directory holding more than half of its functions, directories in path order; within a directory the rows over two or more files first (a command, a name-token group, a class in a header and a source), then the one-file rows by file, a file's named pieces by the line of their first function and its `/ other` piece last; a row no one directory holds more than half of under `across directories`, after the directories; rows tagged `noise` or `vendored` after everything. `size` has no headings. The line under the listing's header names the order in use and the option that changes it. An unknown order is an error (exit 1).
- **Good for**: Reading a listing in which neighbouring rows belong together (`path`); finding the largest groups, which are often the leftovers and the oversized (`size`).
- **`similarity`** (since 2026-11-23): rows whose text is alike next to each other. The listing does not work the order out. It reads the one `--carve clusters` saved in the index (the leaves of its tree, laid so that at each join the closer ends meet), so `--carve clusters` has to have been run once, and that needs `--build-embeddings`; with no saved order the listing says so, gives the command, and prints nothing else. Rows the saved order does not hold come last, with a count: `--carve` leaves out test code by the rule `--semantic-search` uses and these listings by the `test` tag, so on ExoPlayer 3 901 rows that the first rule calls tests are listed last. An order saved for an earlier build of the mechanisms is used and said to be old. The note under the header names the model and says the order is a suggestion, not a finding. Measured 2026-11-23 as the mean likeness (cosine of the mechanism vectors) of neighbouring rows: CodeExam 0.62 by size, 0.68 by path, 0.78 by similarity (shuffled 0.59); ExoPlayer 3 0.57, 0.74, 0.83 (shuffled 0.44). The measure is the one the tree is built to do well on, so it shows the order is what it claims and not that a reader finds things faster. The MCP tool takes the same value; the GUI's list does not yet.
- **Not yet**: a grouping in these listings. Sections and sub-sections, by similarity or by calls, are the separate command `--carve` (since 2026-11-23).
- **Naming**: the order is a property of the listing, not of the mechanisms file, the record ids or any ranking; `--group-by` is a different option, of `--candidates`.
- **Verified against**: `src/argparse.js` (`sort_by`), `src/commands/mechanisms.js` (`listedEntries`), `src/core/mechanisms-index.js` (`orderEntries`, `LISTING_ORDERS`, `listingNote`)

#### `--toc [filter]`

- **Does**: The table of contents of the same mechanisms (#296; the label grammar is on [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)): one numbered line per row of `--mechanisms`, a blank line between rows, in the same order (`--sort-by`), so the two agree line for line; rows that are wholly test code are left out of both unless `--include-tests` is given. Every row leads with two things: its number in this listing and then the mechanism's record id (`12. m5  …`; the id since 2026-11-21). The number is a place in the list and changes with `--sort-by`, a filter and `--include-tests`; the id is the row's name in `--mechanisms` and every other listing, and a line under the header says so. A described row reads `12. m5  <the model's sentence>  ([class] Ledger; 16 fns, 1 file)` when the sentence names its subject, and `12. m5  [class] Ledger  (16 fns, 1 file) — These methods post entries…` when it opens with This, These or The functions, the label and counts first and the sentence after the dash, unquoted (`sentenceNamesSubject` in `src/core/mechanisms-index.js`, the one rule every listing and the GUI apply); an undescribed one reads `12. m5  [class] Ledger  (16 fns, 1 file) — "<its purpose, cut at 90 characters>"`, the quote being a doc fragment or a `calls:` line, not a title; tags follow in brackets and a folded row ends `also [file] ledger.py`. With a filter, a row the filter matched on something the line does not print ends with what matched, `holds <member>`, `in <file>` or `purpose "…"`, as `--mechanisms` says it. The number is an ordinal, not a rank: the record format reserves `priority` for a ranker that does not exist yet. The header is the `--mechanisms` header; the footer counts the rows without a model sentence and gives the `--describe` command with the filter in it, so a contents of labels says what would make it a contents of sentences. `-v` follows each line with the row's block as `--mechanisms -v` prints it, starting at the label line (the sentence the TOC line has just printed is not repeated), members as `file@name  (L12–48)`: the terminal's way down to the cites. Measured 2026-11-05 on CodeExam's described index: 383 lines, every one a sentence; on Bram, `--toc worklist` lists 138 rows (146 records, 8 folded) against the 519 records the same filter matched the day before.
- **Good for**: Handing someone the catalog of what a codebase is made of, one line per mechanism, in the form the pseudo-claims chart's contents table turned out to be the most legible part of; scanning a filter's rows before paying to describe them.
- **Couples with**: `--filter` and the optional value (the same filter as `--mechanisms`), `--max-results` / `--all-results` (the shared cap contract; a long contents wants `--all-results`), `-v`, `--sort-by`, `--include-tests`, `--describe` (`--toc <filter> --describe` describes the records the filter matches, test rows included though the contents leaves them out, as `--mechanisms <filter> --describe` does; the outcome follows the contents).
- **Held aside**: the pseudo-claim preambles as a `-v` line (pseudo-claims are not saved per index); the rank column; nesting a class row under the file row that contains it.
- **Naming**: the table of contents of the mechanisms file; `--mechanisms` is the listing with members and ids, `--toc` the contents page.
- **Verified against**: `src/argparse.js` (`toc`), `src/commands/mechanisms.js` (`doToc`), `src/core/mechanisms-index.js` (`formatMechanismsToc`, `sentenceNamesSubject`)

#### `--carve <clusters|calls>`

- **Does**: Experimental (since 2026-11-23). Carves an indexed codebase along its joints: it divides the codebase's mechanisms (the rows `--toc` and `--mechanisms` list) into numbered sections and sub-sections and prints them as a list to run an eye down, so that a long list can be read by its headings. The value is the technique, which is to say where the cuts are made. `clusters` puts together mechanisms whose text is alike: one vector per mechanism, made from the text embeddings `--build-embeddings` saved for its functions (a function weighted by its lines and by how few mechanisms hold it), [Ward's method](https://en.wikipedia.org/wiki/Ward%27s_method) over those vectors, the tree cut high for sections and lower for sub-sections. `calls` puts together mechanisms that call each other: a graph of mechanisms joined by the calls between their functions, matched by name, and [Louvain community detection](https://en.wikipedia.org/wiki/Louvain_method) on it, then again on the calls inside each section of 8 or more for sub-sections; it reads no embeddings. Neither runs a model or makes a network call. The output is a header (the technique, the settings and the options that change them, what was left out and why, how many sections came out and the largest), then each section as `3. analyze, multisect, claim, split   (31 mechanisms)`, each sub-section as `   3.3 multisect, commands   (6)`, and under it one row per mechanism: its id, its label and its section number in brackets (`m75    [cmd] --multisect-search [3.3]`), commands first. The number at the end of a row is there so that a search of the output for a name shows which section the row is in. Headings are words that many of a group's labels share and few labels elsewhere have; no model writes them. Mechanisms in a section of their own are listed at the end, tagged `[alone]`; under `clusters`, mechanisms with no embedded text are listed last, tagged `[unplaced]`. Rows that are wholly test code are left out by the one rule for test code, and the output ends with a Tip saying how many; `--include-tests` keeps them. `--description` adds under each row the sentence a language model wrote for it (`--describe`), where the index has one; `--purpose` adds, on a line starting `purpose:`, the text harvested from comments, strings and call names with no model, cut at 240 characters; the header counts each and says which is which. `--brief` prints the headings only. With `clusters`, `--sections N` and `--sub N` set how many of each (defaults 0.65 × the square root of the number of mechanisms, at least 6, and the number ÷ 8: 12 and 45 on CodeExam's 363), and `--embed-model` chooses the model as it does for a search. With `calls`, `--resolution X` sets how fine the sections are (default 2; higher gives more and smaller) and `--seed N` gives another run: community detection visits mechanisms in a random order, and one seed always gives one listing (default 5). Bare `--carve` explains the two techniques and picks neither. An option that does nothing under the technique chosen (`--seed` with `clusters`; `--filter`, `--sort-by`, `--max-results` with either) is named in the header and not dropped silently. `clusters` on an index with no embeddings prints the `--build-embeddings` command, says `calls` needs none, and prints nothing else; it saves its tree in the index as `embeddings/<model>_carve-tree.json` (on ExoPlayer 3's 7,495 mechanisms the first run took 260 seconds and a later one, reading the tree back, 44; measured 2026-11-23), together with the mechanisms' ids in the tree's leaf order, which `--toc` and `--mechanisms` read for `--sort-by similarity`, and refuses above 16,000 mechanisms, where the table of every pair it keeps passes a gigabyte.
- **Good for**: Getting the lay of a codebase from its headings; finding the neighbours of a mechanism you already know (search the output for its name, read its sub-section); comparing two ways of carving the same code.
- **Not a finding**: the groups are a suggestion. They move when the index changes and, for `calls`, when the seed changes; clusters rebuilt from 80% of the mechanisms agreed with the full run only 0.50 to 0.67 (scratch runs, 2026-11-19). The two techniques give different groups, and neither has been shown to be the features a person would name on more than one codebase: [`CODEEXAM_CLUSTERING.md`](CODEEXAM_CLUSTERING.md) has the measurements. The defaults were chosen by eye on CodeExam's own index; ExoPlayer 3 at `calls` resolution 2 gives a largest section of 550, and reads better at 6.
- **Couples with**: `--index-path`, `--include-tests`, `--description`, `--purpose`, `--brief`; `--sections`, `--sub`, `--embed-model` (clusters); `--resolution`, `--seed` (calls). `--build-mechanisms` first, and for `clusters` `--build-embeddings`.
- **Held aside**: a GUI list and an MCP tool; similarity as an order for `--toc` and `--mechanisms`; headings written by a model; a third technique using calls and text together.
- **Naming**: "carve" because the command takes an indexed codebase and tries to cut it along its joints or seams: it partitions the codebase into pieces and prints the pieces as a list, to show the codebase's major parts and the words the codebase itself uses for a part you may be looking for. The word is neutral between the two techniques, which are two ideas of where the joints are; `clusters` and `calls` say what each goes by.
- **Verified against**: `src/argparse.js` (`carve`, `sections`, `sub`, `resolution`, `seed`, `brief`, `description`, `purpose`), `src/commands/carve.js` (`doCarve`, `renderClusters`, `renderCalls`), `src/core/carve.js` (`wardMerges`, `louvain`, `callEdges`, `carveListing`)

#### `--class-hotspots <n>`

- **Does**: Top N classes by aggregated method hotspot score.
- **Good for**: Class-level rollup of `--hotspots`; finds the most complex classes.
- **Couples with**: same as `--hotspots`.
- **Naming**: prefix `class-` modifier on `--hotspots`.
- **Verified against**: `src/argparse.js:272`

#### `--vocabulary <n>` (short alias: `--vocab`; deprecated alias: `--discover-vocabulary`)

- **Does**: Top N domain-specific tokens by TF-IDF score.
- **Good for**: Surfacing the unique vocabulary of a codebase — input to claim-search term selection and to multisect query crafting.
- **Couples with**: `--vocab-tight`, `--in` (path filter), `--no-vocabulary` (disables it as input to other commands), `--concepts` (the concepts these tokens are made of).
- **Naming**: noun-only canonical (post-CLI-normalization). `--vocab` is kept as a documented short alias (no deprecation warning); `--discover-vocabulary` is deprecated and warns on use.
- **Verified against**: `src/argparse.js:273`

#### `--concepts [filter]`

- **Does**: Lists the concepts the Overview prints, on their own (since 2026-11-23; #364). A concept is a word that the names in the code are made of (`multisect` in `parseMultisectTerms`), found by counting the names, with no model and no embeddings: the function is `extractConcepts` in `src/core/vocabulary.js`, called with the Overview's arguments and no cap, so the first twelve rows are the Overview's twelve, in its order and with its examples, and the command and the Overview cannot disagree. The list goes on past the twelve: 30 by default, `--max-results N` for another number, `--all-results` or `--max-results 0` for all the function returns (115 on CodeExam, 85 on ExoPlayer 3); the cap notice names both ways to raise it. The header says what the list is: the same concepts the Overview prints, found by counting names with no model, a suggestion of what to look for and not a finding. Each row is the concept, its example in parentheses, then two things. *Files*: the concept's top files, up to three, but only where the concept is itself one of the top vocabulary terms that the Overview's file ranking ("Potentially important files (by vocabulary density)") uses; there the files are that ranking's data read the other way, term to files, each file weighted by the term's score times how much of the term sits in the file (`computeTermFiles` beside `computeVocabDensity` in `src/commands/metrics.js`). Where the concept is not one of those terms (`claim`, on CodeExam, is a part of many names and never a term of its own) the row has no files part and invents none; one line under the header says how many of the rows shown have files and why the others do not (on CodeExam's first 30, 14 do), and the full view of such a concept says in one sentence that no files are listed and points to `--search <word>`. *Mechanisms*: when the index has a mechanisms file, the number of mechanisms named for the word: those whose label (or the label of a record folded into the row) or one of whose member function names carries it, case-insensitively, as a substring. The file's records are folded by member set, and rows that are wholly test code are left out unless `--include-tests` is given. The count is the number in brackets at the end of the row (`1. multisect (parseMultisectTerms): files: public/app.js, …  (14)`), and the header's second line says once what it is. `--toc <word>` and `--mechanisms <word>` list those and also any mechanism whose file path, purpose or description carries the word, so they may list more, and the two numbers are not claimed to match (on CodeExam, `--toc multisect` lists 17 and 14 are named for it; `claim` 109 and 85; `patent` 29 and 4; measured 2026-11-23). A concept that no mechanism is named for ends `(0)`, and a line under the header counts such rows and says what they are: words that are in the code's text (comments, strings, file headers, names that are not functions) and in no mechanism's label or function names, which may be boilerplate and not something the code is about. On CodeExam's own index 8 of the first 30 are of this kind, among them `aschulman42` and `schulman`, which come from the copyright lines at the head of 147 of its 265 files, and `exam`, from the `code-exam` in the same lines. The ranking does not yet tell such a word from one the code is about (#351), and this command does not hide them, since it prints what the Overview prints; it says which they are. For one such concept, `--concepts <word>` offers `--search` and does not offer `--mechanisms`, `--carve` or the pseudo-claims candidates, which go by names and would show nothing. The first version of this command counted what `--toc` lists, which put every mechanism under a directory named for the word into the count (`media`, on ExoPlayer 3, counted all 7,495) and told the reader nothing. With no mechanisms file the rows leave the count out and one line gives the `--build-mechanisms` command. Under the list, the commands that take a concept as a filter: `--concepts <word>`, `--mechanisms <word>`, `--toc <word>`, `--carve calls` or `--carve clusters` (which has no filter: search its output for the word to see which section holds the mechanisms), `--pseudo-claims --candidates <file> --filter <word>` and `--search <word>`. A filter (a substring, or `/regex/`; the optional value, else `--filter`) keeps the concepts whose word matches; the word is matched, not the example. A filter that equals one concept, or matches only one, shows that concept in full: its example, up to ten files, and exactly the mechanisms counted, by id and label, in the order `--toc` lists rows (`m70   multisect (parseMultisectTerms)  (13 fns, 6 files)`; its `Mechanisms: N named for it` line says what they are), capped by `--max-results`. A filter that matches several lists those rows. A word that is not one of the index's concepts gets one sentence saying so and naming `--vocabulary` and `--search`; the exit code is 0.
- **Good for**: Finding words worth searching for when eyeballing an unfamiliar codebase ("what are some things to look for?"), and going from a word to the mechanisms listings and the searches that take it as a filter.
- **Couples with**: `--include-tests` (the command leaves test mechanisms out of its counts unless given, and ends with the one closing Tip, `Tip: 18 mechanisms of test, benchmark, mock and example code left out; --include-tests lists them.`, counting the distinct test mechanisms that carry a shown concept's word in a label or member name; `--exclude-tests` is accepted and changes nothing, as for `--toc`), `--max-results` / `--all-results`, `--filter`, `--full-path`, `--build-mechanisms`, `--overview`, `--vocabulary`.
- **Not a finding**: the concepts are the present ranking's, defects included (#351, #221, #235, #307 are about them); one-word names such as `andrew` or `schulman` can rank high, and a concept is a single word. The count is of mechanisms whose label or member function names carry the word, not of mechanisms about the concept. There is no GUI list or MCP tool for this command yet; the MCP `overview` tool prints the Overview's own concepts and cannot run it.
- **Naming**: "concepts" is the word the Overview, the GUI's vocabulary view and the MCP tools already use for these.
- **Verified against**: `src/argparse.js` (`concepts`), `src/commands/concepts.js` (`doConcepts`, `allConcepts`), `src/commands/metrics.js` (`computeTermFiles`), `src/core/vocabulary.js` (`extractConcepts`), `src/core/overview.js` (the Next lines)

#### `--multisect-search <terms>` (alias: `--multisect`)

- **Does**: Multi-term intersection search — finds smallest scope (function / class / file / folder) containing the terms. Terms semicolon-separated; `/regex/` for regex; `NOT` / `!` to negate. Test, benchmark, mock and example files are searched like any other, and when the index holds any the header says how many and that `--exclude-tests` (or `--no-tests`) leaves them out; with either option they are not searched and the output ends with a Tip saying how many files were left out (since 2026-11-19; before that both options were accepted and ignored).
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

#### `--census-imports`

- **Does**: Ranked census of import targets across the indexed languages (Python, JS/TS, C/C++, Java/Kotlin, C#, Go, Rust) for one index; with `--multi-index <list>` it reduces across indexes, ranked by how many indexes import each target. Counts what indexed HTML and page templates load too (script, stylesheet and importmap tags; `--add-extensions .html,.htm` and the template type at build), and the output ends with a coverage line, including the HTML the build skipped (#27).
- **Good for**: The corpus's de facto API map — what the code actually reaches for, and in a multi-index corpus which libraries all of it shares.
- **Couples with**: `--multi-index`, `--filter`, `--max-results`, `-v` (per-index counts / example sites).
- **Naming**: noun-noun; `census` for the counting, `imports` for the subject.
- **Verified against**: `src/argparse.js:539`

#### `--bom`

- **Does**: Bill of materials — every import/include across the indexed languages (Python, JS/TS, C/C++, Java/Kotlin, C#, Go, Rust), plus the script, stylesheet and importmap tags of indexed HTML and page templates (`.php`, `.erb`, `.cshtml`, `.twig`, …) and URL imports, classified four ways (internal / stdlib-or-platform / third-party, manifest-declared / vendored), each row with its stated source; unconfirmable targets report themselves as external. A library a page loads is named from its filename or CDN path, with the version when either carries one (`jquery@3.7.1`); a local copy of a library the manifest declares (`lib/lodash.min.js`) is third-party, with the copy's location named; a templated `src` resolves by the quoted asset inside it, or says it cannot. HTML that code emits (a report generator writing a `<script>` tag into its output) is not a row — it is a dependency of the generated output, not of the program — but the footer counts those tag-shaped strings and points at `--referenced-resources`, which catalogues their URLs. Ranked external surface, vendored subtrees, indexed manifests, and a coverage line naming what was read, including the HTML the build skipped (#27). Lockfiles are read when present (`package-lock.json`, `Pipfile.lock`, `composer.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`; `yarn.lock` and `pnpm-lock.yaml` not yet): a Resolved section with the package count, the direct/transitive split, the sources (registries counted per installed entry, every git, tarball or `file:` source in full), pinned versions on the third-party rows, and the joins for npm and Python manifests — declared but imported nowhere (runtime apart from dev), imported but not declared (present in the lockfile as transitive, or absent), declared but absent from the lockfile. A capped Copyright holders section gives the in-tree half (`--copyrights` has the full table): the presumptive first party and the other holders with file counts and an example path. Build files count as manifests (`.vcxproj` `AdditionalDependencies`, CMake `target_link_libraries` and `find_package`, Makefile `-l` flags), the Windows `.lib` answer key beyond `#pragma comment(lib)`: a `#pragma comment(lib, "x")` or an angle include whose library a build file names is third-party rather than external. A Dynamic loading section lists what import tables miss, #27's third phase: `LoadLibrary`/`GetProcAddress`, `dlopen`/`dlsym`, `CFBundleGetFunctionPointerForName`, `Class.forName`/`ClassLoader.loadClass`, `System.loadLibrary`, `Assembly.Load`, `importlib.import_module`/`__import__`, and `require(expr)`/`import(expr)` with a computed specifier; a literal target is classified by the same rules as an import (a `.dll`/`.so` as a link library, a class or module by its language), a computed one is counted, never guessed.
- **Good for**: Answering "what does this code depend on, and how do we know" with the line that imports or loads it — the dependencies half of a protective-order inventory.
- **Couples with**: `--filter`, `--max-results`, `-v`; `--add-extensions .html,.htm` at build for HTML (not indexed by default). Manifests, lockfiles and build files are indexed by name in every default build; only an explicit `--extensions` list leaves them out. What imports, the bill of materials and dependencies each mean, every related surface in one table, and what is not done: [`CODEEXAM_MAPPING_DEPENDENCIES.md`](CODEEXAM_MAPPING_DEPENDENCIES.md).
- **Naming**: the industry acronym (bill of materials); the SBOM umbrella is #27.
- **Verified against**: `src/argparse.js:541`

#### `--why-depends <package>`

- **Status**: experimental (2026-10-19). Strongest with a lockfile indexed, where it walks the lockfile's own edges; without one it has import sites and name mentions only, which show where a name appears without establishing why (Bram's `whisper`, an external program the Rust side spawns, is the case that showed it). The shape of the output will change; read it beside `--bom`, `--callers` and `--referenced-resources` rather than instead of them.
- **Does**: From a package in an indexed lockfile back to the code and the operation that needs it: a summary first (the package's standing and the heads it comes through, where it reaches the code, the operations above that, the caveat in a line; no paths, so it reads at a glance), then three sections and the caveat. Package to package: every chain from the lockfile's root to the package, walked from the lockfile's own edges (`package-lock.json` v1–v3, `Cargo.lock`, `poetry.lock`, `composer.lock`; `go.sum` and `Pipfile.lock` carry none and say so), each hop with its version and the edge's kind (prod / dev / optional / peer), nested npm copies resolved the way npm resolves them, the direct dependency at the head of each chain named; a package no indexed lockfile installs says so and points at `--bom`. Package to code: each head's import sites with the functions that use the imported binding (JavaScript and Python bindings are read; other languages list the sites); a head no file imports falls back to the places that name it outside manifests and lockfiles (a grammar table, a build script, a notices file), with the manifest's kind (dev, runtime, peer, optional) stated, which is the honest answer for a build-time package such as a tree-sitter grammar whose vendored output is what runs. Code to operation: the callers above each using function to `--depth` (default 3), a call from file scope shown as `(top level)`, and the catalogued operations whose handler lies on the chain, CLI commands (dispatched at file scope) apart from flags read inside a handler, then routes, GUI actions and commands; a match by file alone is not offered. The caveat prints on every run: installed and importable is not shown to execute, and a build-time tool reads the same as a run-time library.
- **Good for**: The question an examiner asks about any of the hundreds of names in an install nobody chose: through which chosen package does it arrive, and which user operation needs it; the review-room list of what must be present and exercised before a machine is sealed (#231).
- **Couples with**: `--depth`; `-v` (lifts the per-head site cap of 20); `--bom` (the inventory this walks from); `--callers` (the same walk by hand, with the same name-resolution limits); `npm explain` (the installed tree's answer, when `node_modules` is present). Not yet: an MCP tool, a GUI control, bindings beyond JavaScript and Python.
- **Naming**: the question it answers, narrowed to dependencies: a bare `--why` promised more than a dependency walk (Andrew, 2026-10-19), and `npm why` is npm's alias for the same package-to-package half. A one-package query like `--callers`, not a section of `--bom`.
- **Verified against**: `src/argparse.js:543`

#### `--copyrights`

- **Does**: Harvests copyright notices from the first 60 lines of every indexed file and from `/*! … */` banners anywhere in it; normalizes holders across spellings (case, punctuation, corporate suffixes, year ranges), counts files per holder, and marks a presumption on every row: the holder with the most files is presumptively first-party, every other holder presumptively third-party, a holder whose files all sit under a vendored directory third-party by location too; a tie or a single file establishes nothing and says so. Then the license identifiers seen per file (SPDX and the common phrasings), the license documents apart (`LICENSE`, `NOTICE`, `COPYING`, `THIRD-PARTY-NOTICES`, with the license each states), and the bundle files whose banners name several holders.
- **Good for**: The in-tree half of the dependency story — foreign code the bill of materials cannot see because it sits outside a `vendor/`-named directory (a library copied into `lib/`, a renamed file, a pasted function); and the provenance question itself, with the presumption derived from counts and never presented as a finding.
- **Couples with**: `--filter` (holder or path), `--max-results`, `-v` (sites, spellings, the line as written); `--bom` carries a capped version of the same table.
- **Naming**: plural noun, the holders rather than the notices; `--bom` is where it is cross-referenced.
- **Verified against**: `src/argparse.js:543`

#### `--exports [pkg]`

- **Does**: Declared-exports catalog (Python today): what each package says its public API is, tier-marked (A `__all__` / `@*_export`, B `__init__` re-exports, C heuristic floor) and resolved to definition sites. Bare form: per-package summary; `--exports <pkg>`: that package's names, segment-matched. `--emit-catalog <file>` writes the catalog that `--imports` and the GUI read.
- **Good for**: Building the library-side answer key for cross-index resolution; seeing a package's public surface without reading it.
- **Couples with**: `--emit-catalog`, `--catalog-replace`, `--used-by`, `--multi-index`, `--filter`, `-v`.
- **Naming**: bare noun, the mirror of `--imports`.
- **Verified against**: `src/argparse.js:542`

#### `--imports <catalog.json>`

- **Does**: Discovery join (#162): resolve this index's imports against a pre-built multi-library catalog from `--exports --emit-catalog`; each import is attributed to whichever catalogued library provides it, including qualified attribute access. `--imports-from <index>` is the single-library form (#154).
- **Good for**: "Which of these imports are *that* library's, and which does the catalog not explain" — the join that turns an import list into a dependency map.
- **Couples with**: `--imports-from`, `--exports`, `--filter`.
- **Naming**: bare noun, the mirror of `--exports`; the value is a catalog file, not a package.
- **Verified against**: `src/argparse.js:544`

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

#### `--full-lines`

- **Does**: Prints a matched line whole, however long. Without it `--search`, `--literal`, `--fast` and `--regex` show a line over 300 characters as a window around its first match.
- **Good for**: Copying a whole minified line out; seeing every match on a line.
- **Couples with**: `--search`, `--literal`, `--fast`, `--regex`.
- **Naming**: hyphenated boolean.

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
- **Couples with**: `--llm`, `--model`, `--api-key`, `--temperature`, `--vocab-tight`, `--no-vocabulary`, `--show-prompt`, `--exclude-tests` / `--no-tests` (since 2026-11-23: the TIGHT and BROAD searches leave test, benchmark, mock and example files out, and the closing Tip says how many of the index's files that is). (`--use-claude` and `--claim-model` are deprecated aliases for `--llm claude` and `--model` respectively.)
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
- **Refused early**: a path that is not a file is refused when the arguments are read, before any index work, prompt build or model call (`model file not found: …`, with a `models/` hint when a file of that name is there; a relative path resolves against the current directory). A provider name in its place (`--model chatgpt`) adds "names a cloud provider: --llm chatgpt". Before this (model-path-fail-fast, 2026-11-09) the check ran at load time, so `--hof --model chatgpt` ran the grouper and then failed every draft.
- **Couples with**: `--claim-search`, `--claim-analyze`, `--analyze`, `--multisect-analyze`, `--file-analyze`. Post-parse, fans out to both `args.claim_model` and `args.analyze_model` for legacy consumers.
- **Naming**: bare noun. Replaces the artificial split into per-pipeline model flags.
- **Verified against**: `src/argparse.js:284`

#### `--gpu [backend]` and `--cpu`

- **Does**: Chooses the GPU backend local models run on (a GGUF given with `--model`, and the embedding models of `--embed-distance`): `auto` (default: the first of CUDA, Vulkan, CPU that loads), `cuda`, `vulkan`, `metal`, or `off`. `--cpu` is `--gpu off`. With no value, `--gpu` prints what the machine has (backend in use, device, memory and whether it is shared with system RAM, installed prebuilt backends) and exits; it needs no index and loads no model.
- **Good for**: Seeing before a run which backend a machine will use; forcing one backend to compare it with another on the same machine; keeping a run off a backend that loads and then misbehaves.
- **Refused early**: a backend that does not exist on the platform (`metal` on Windows, `cuda` on Apple Silicon); `--cpu` together with a named backend; a value that is none of the five.
- **Stops, does not substitute**: a named backend with no working prebuilt binary stops with the reason, and a model that fails to load on a named backend is not retried on the CPU. Under `auto` the CPU retry after a failed GPU load is unchanged.
- **Couples with**: `--model`, `--embed-distance`, `--ask-ai`, `--overview-by-ai`, `--gui`. Nothing is downloaded or built; only a backend whose prebuilt binary is installed can be chosen.
- **Naming**: the noun the user thinks in; `--cpu` kept as the short spelling of the commonest case.
- **Verified against**: `src/core/llm-runner.js` (`parseGpuChoice`, `setGpuPreference`, `llamaInitOptions`, `getLlamaShared`, `gpuReport`, `gpuFallbackAllowed`), `src/index.js`; what has been run on which GPU is [`CODEEXAM_GPU.md`](CODEEXAM_GPU.md).

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

- **Does**: Display the prompt(s) a command would send and exit (no API call); works on **every** LLM command, with or without `--llm` / `--model`.
- **Reading the output**: the SYSTEM prompt prints first; the long blocks after it are the USER content actually sent — for `--pseudo-claims`, the per-group evidence packs, which double as a useful filter-scoped digest of the matched code. After a large prompt a footer (stdout) and a line on stderr point back to the top, so the system prompt isn't lost above the scroll.
- **Good for**: Auditing what gets sent to the LLM — reproducibility, prompt-engineering iteration, and litigation context (showing court what was asked).
- **Couples with**: every LLM command — `--analyze`, `--claim-search`, `--claim-chart`, `--claim-locate`, `--synonymize`, `--pseudo-claims`, `--claims-loop`.
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

#### `--ask-ai "<question>"` (alias: `--ask-AI`)

- **Does**: One question to an engine over the index, through the same tool loops the GUI Chat runs: every registered tool on a cloud engine, the curated core on a local model, the same budgets and guards. Prints a provenance header, the answer, then the `ⓘ Based on N model tool calls` footer on stdout; each tool call and the timing on stderr. Exit 1 when there is no index at the path, no key for the cloud engine, a cloud engine under `--air-gapped`, or no answer.
- **Good for**: Running a question from an Overview by AI's "Questions to start with" without the GUI; scripted or batch questions; an answer whose basis is recorded under it.
- **Couples with**: `--index-path`; `--llm claude|openai|gemini` or `--model <file.gguf>`; `--grounding`, `--cpu`, `--context-size`, `--flash-attention`, `--reproducible`, `-v`.
- **Naming**: verb-noun, like `--build-index`; "AI" names the engine family, as `--overview-by-ai` does.
- **Verified against**: `src/argparse.js:494`

#### `--claim-analyze <claim>`

- **Does**: End-to-end patent claim analysis: extract terms → search → analyze top matches.
- **Good for**: The full claim-search-and-explain pipeline in one command.
- **Couples with**: all LLM flags, all multisect flags, `--exclude-tests` / `--no-tests` (since 2026-11-23: the TIGHT, BROAD and neighbourhood searches leave test, benchmark, mock and example files out; the per-element arm already holds tests back unless `--include-tests` is given).
- **Naming**: noun-verb.
- **Verified against**: `src/argparse.js:293`

#### `--claim-chart <claim>`

- **Does**: Build one claim chart: a row per claim element with a PRESENT / PARTIAL / ASSUMED / ABSENT finding and the cited code, from `--targets` or its own per-element retrieval. The chart prints as Markdown; `--chart-html <file>` writes the self-contained printable page, `--chart-md <file>` the chart as a Markdown file (one section per element, wrapped, no wide table; `--chart-md-layout table` writes the stdout table instead), `--verdicts-out <file>` the per-target verdicts either form re-renders from with `--chart-html-from <sidecar>` and no model.
- **Good for**: Reading a claim against a codebase element by element, with a citation per row a reader can check with `--extract`.
- **Couples with**: `--targets`, `--elements`, `--claim-family`, `--chart-notes`, `--chart-title`, `--chart-subtitle`, `--chart-format`, `--chart-md-layout`, `--include-tests`, `--include-op`, all LLM flags.
- **Naming**: noun-noun.
- **Verified against**: `src/argparse.js:666`

#### `--hof`

- **Does**: The self-test, "huffing our own fumes", in one process (hof-cli-command, 2026-11-09; `scripts/hof.mjs` was the subprocess form from 2026-11-03 and stays until a parity run retires it): draft a pseudo-claim from every candidate group of the index (`--pseudo-claims --candidates`, then `--claims-only` with `--min-rank 0`, so a `--rank` tag is reported and never a floor), locate each draft with `--claim-locate --targets-out`, and score the drafter's grounded anchors against the located targets on the ladder of `scripts/anchor-recall.mjs`: function, class, file or miss per anchor; exact, near or elsewhere per target. Needs `--llm <provider>` or `--model <gguf>`. **The preflight**: the grouper runs (no model), the command prints the group count, the model calls to come (one draft per group, two calls per locate run times `--runs`, and under `--synonymize-with` one rewrite per limitation, six per claim until the drafts exist) and their projected cost through the $2 claims guard, labelled an estimate from per-call sizes (the drafter projects its own exact figure before its first call), and stops above the guard unless `--force` (`CE_CLAIMS_COST_GUARD=<usd>` raises it); `--limit N` caps the groups, `--filter <text>` narrows them as `--mechanisms <filter>` does, `--dry-run` prints the plan with each step's equivalent `ce` command and calls nothing. **Where the files go**: `<index>/hof/<yymmdd-HHMM>/`, beside the index as `mechanisms.json` and `embeddings/` are, since the drafts paraphrase the code and the anchors name its functions, so a run on code under a protective order is itself PO material and belongs where the index is ([`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md)'s inventory): `cand.lst` (and `cand_firstN.lst` under `--limit`), `claims.txt` and `claims.txt.anchors.json`, `claim_N.txt` (and `claim_N.orig.txt` when synonymized), `locate_N.txt`, `logs/<step>.txt`, `pseudo_claims.md`, `hof_report.md` and `hof_report.json`; `--hof-out <dir>` puts them elsewhere, and an index loaded from a `.zip` is refused without it, since its cache is deleted. **What the number means**: without `--synonymize-with` the claims are located in the drafter's own words, the easier case, and the report's header says so; with `--synonymize-with <provider|gguf>` a second engine rewrites every draft through `--synonymize`'s machinery with the anchors withheld (one call per limitation, counted in the preflight, each claim re-joined one limitation per line so the locator splits it as drafted), and the report names drafter, synonymizer and locator. Every report, on the terminal and in `hof_report.md`, ends with a fixed "How to read this" footer under ten lines: the rungs and the target classes defined, the rank tag as information and never a floor, what a match is not (files by basename; a documentation or constant anchor reaches file at most), and what HOF is not (a round trip from a claim written from the code is no expectation for a real patent claim, whose gap is register, [`describe-reach.md`](describe-reach.md)). Each step is echoed as the `ce` command it is the equivalent of, with its output in `logs/`, so any step can be reproduced by hand; the index loads once. A locate run whose selections do not parse (the locator's `No symbol selections were parseable` exit, no targets written) is run once more before the row reads `[claim-locate failed]`: a claim located on the second run reads `[retried]` in the table and the report, both runs stand in the Commands block and in `logs/` (`3-locate-N.retry.txt`), and the plan says the retry is outside the projection (hof-locate-retry-once, 2026-11-09; on the first full run two of 212 claims exited that way, a third of the miss rung). **The console** carries the run's story and nothing else (hof-console-progress-lines, 2026-11-09; the first full run echoed every step's whole output, 69,035 lines for 212 claims): the `hof:` lines, the preflight, each step's `$ ce …` echo and one result line under it (`  → exit 0, 21.1s`, with the step's own `# actual cost` line when it printed one, and on a failure the step's last line, such as `No symbol selections were parseable.`), then the table and the footer; every step's full output is in `logs/<step>.txt`, and `--verbose` echoes it all. `> file` keeps everything but the preflight's own lines, which go to stderr as every claims command's do; `2>&1` keeps those too. `--claims <claims.txt>` skips drafting and locates an existing claims file (its sidecar beside it), so the same drafts can be located by a second model and the reports compared. Not an MCP tool and not a GUI button: a run is long and costs money.
- **Good for**: Seeing, on your own index, how well CodeExam's claim features find their way back from a claim to the code it was written from, and reading the ladder rung by rung; comparing two engines on the same drafts; the rewritten-vocabulary test the drafter's own words cannot give.
- **Couples with**: `--llm` / `--model`, `--synonymize-with`, `--limit`, `--filter`, `--rank`, `--form-rules`, `--claim-class`, `--blind`, `--runs`, `--include-tests`, `--claims`, `--hof-out`, `--dry-run`, `--force`, `--ndx`. `scripts/hof-stage1.mjs --index-path <dir>` reads the runs under `<index>/hof/` for the #359 feasibility check.
- **Naming**: the test's own name, as the pages call it; `--hof-out` rather than `--out`, which `--harness-out` holds.
- **Verified against**: `src/argparse.js` (`hof`, `hof_out`, `synonymize_with`, `limit`, `hof_claims`), `src/index.js`, `src/commands/hof.js` (`doHof`, `hofOptions`, `synonymizeClaim`), `src/core/hof.js` (`runDirFor`, `preflightCalls`, `planLines`, `renderMarkdown`, `HOW_TO_READ`)

#### `--multisect-analyze <terms>`

- **Does**: Search for functions matching multisect terms, analyze top hits with LLM.
- **Good for**: When you have terms already (not a patent claim) and want the analyze pipeline.
- **Couples with**: same as `--multisect-search` plus LLM flags; `--exclude-tests` / `--no-tests` leave test files out of the search (since 2026-11-23) and the closing Tip says how many of the index's files that is.
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

- **Does**: List CLI options, commands, switch/case branches, API routes, and GUI actions discovered in the codebase. GUI actions are the page's controls as its markup declares them: buttons, inputs, selects and links that carry an id or a `data-*` name, and any element a script attaches a listener to by id. Each row gives the label a user sees, the code name and kind, and the script line that handles the control (`→`) or merely reads it (`used at`). Controls a script creates are not listed. HTML is not indexed by default, so for a web GUI build the index with `--add-extensions .html,.htm`; without it the section lists only names a script mentions and ends with a note saying the HTML was not read.
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
