# CodeExam indexes

**Almost** everything CodeExam does runs off an **index** — a directory of plain-JSON files built
once from a codebase and then queried by the CLI, GUI, and MCP server alike. (A few commands work
straight off the filesystem instead — scanning a directory tree for file extensions with
`--scan-extensions`, distinct from `--index-extensions` which lists the extensions *in* an
existing index; and the binary inspectors `--extract-js-from-binary` and `--inspect-binary`.)
This page covers building and naming indexes, the on-disk format (and why it's plain JSON rather
than a database), loading a shipped index from a zip, and the cross-index catalogs.

## Building and naming an index

```bash
node src/index.js --build-index /path/to/codebase --index-path .myindex
```

Build from a directory, a glob, an archive (`.zip` / `.tar` / `.gz`), an `@filelist`, or even a
**`.har` browser-DevTools capture** — indexing a website's JavaScript straight from a saved
network log (#161); Fiddler `.saz` captures are planned as well.

- **Name it.** `--index-path .name` — you can keep many indexes side by side and list them with
  `ce --indexes`. (`--index-path` defaults to `.code_search_index` when omitted;
  [[open question: retire the `.code_search_index` default name? it has proven confusing]].)
- **Query several at once.** `--multi-index @indexlist` runs the command against each listed index
  in turn.
- **Extensions.** After a build, CodeExam reports any *text* extensions it found but did **not**
  index by default and tips the `--add-extensions <list>` you'd rebuild with to include them
  (#191); `--extensions` and `--exclude-extensions` set the extension set explicitly.

Indexes scale: a pure-Node streaming JSON parser handles multi-gigabyte indexes — the largest
tested is **Chromium, ~195K files / ~5 GB**, loaded with `NODE_OPTIONS=--max-old-space-size=8192`.
(*Large* is routine; the real caveat is *pathological single files* — see
[`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md).)

**Languages.** Precise structure comes from tree-sitter WASM grammars for **C, C++, Java,
JavaScript, TypeScript, Python, C#, Go, Rust, PHP, Ruby**; a regex fallback covers **Swift,
Kotlin, Scala, Lua, Objective-C, CoffeeScript, Perl, VBScript, AWK**. Non-code text — **YAML**
(`.yaml` / `.yml`), Markdown, plain text — is indexed as searchable text (not AST-parsed); the
YAML coverage is what the Infrastructure detectors content-sniff.

## The on-disk format — plain JSON, not a database

A built index is just a directory of JSON files — no database server, no binary store. The choice
is deliberate: exact and regex code search wants **lexical precision, not nearest-neighbor
approximation**, and plain JSON stays transparent, diffable, and trivially portable. There is no
vector / semantic store today; embedding-based retrieval is being explored only as a layer *on
top* of the lexical index (#201 / #202), not as a replacement — the fuller argument is in
[`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md). And a vector store useful *here* is a tall order:
it would need a **joint embedding space of text and code**. Models trained on docstring↔code
pairs ([[name the reference — e.g. CodeSearchNet / jina-embeddings-v2-base-code; confirm]]) give
one flavor of that, but what CodeExam specifically needs is an embedding trained to associate the
kind of *technical prose* an examiner works from — a patent claim, say — with the code that
implements it, a different distribution from docstrings. [[Consider making this text↔code
joint-embedding point in STRUCTURAL_SEARCH.md too.]]

The first three files listed below are always present; a standard `--build-index` normally writes the next
four; `vocabulary.json` appears only after `--vocabulary` has run — so most indexes hold 7–8 files
(a lighter build can omit some, e.g. no `func_hashes.json` if the dedup/funcstring pass didn't
run):

- `literal_index.json` — raw per-file line/content store *(required)*.
- `inverted_index.json` — token → locations map powering search *(required)*.
- `function_index.json` — per-file function / class / symbol structure *(required)*.
- `string_table.json` — deduplicated distinctive long strings (≥8 chars), shared by funcstrings and search.
- `func_hashes.json` — cached per-function hashes for exact / near / structural dedup and funcstring intersection.
- `rename_map.json` — inferred readable names (`_KW_`, `_NAME_`, `_IMPORT_`, `_CMD_`, `_FP_`; see [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md)).
- `import_map.json` — extracted import/export data feeding the import census and cross-index joins.
- `vocabulary.json` — cached TF-IDF vocabulary (written once `--vocabulary` has run; see [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md)).

**Loading a shipped index from a zip.** `--index-path` also accepts a `.zip` that *contains* a
built index (like the bundled `FIRST_RUN_INDEX.zip`), which CodeExam extracts to a temp cache on
first load. That is distinct from `--build-index` pointing at a zip of a codebase's *source files*
(see [`GETTING_STARTED.md`](GETTING_STARTED.md)).

## Cross-index catalogs

The `--multi-index` fan-out above runs a command across several indexes one after another — it
does **not** load them into a single shared memory (that isn't supported today; the GUI's
Load-Index multi-select is disabled for the same reason). What CodeExam *can* do across indexes is
resolve one codebase against another via a saved catalog. Build a reusable **export catalog** from
one or more libraries with `--exports --emit-catalog <file>` (a v2 catalog also carries who-uses
data), then:

- `--imports <catalog.json>` — attribute this index's imports to whichever catalogued library
  provides each name (a discovery join, #162).
- `--exports --used-by <catalog>` — annotate each declared export with its de-facto consumers
  (the **"Used by"** column in the GUI Exports pane), surfacing public surface that nobody imports.

Coverage differs by direction: **import** extraction is multi-language (Python, JS/TS, C, Java,
C#), while **export** extraction is **Python-only today** (JS/TS planned, #154) — so no default
catalog ships (a Python-only one would be too partial); you build your own from the libraries you
care about and pass the filename explicitly. The build is *appendable* — re-emitting merges by
library identity (`--catalog-replace` overwrites) — so one catalog can grow across many libraries.
For the GUI, start the server with `--exports-catalog <file>` to light up the "Used by" column;
whenever a catalog is loaded, CodeExam notes which one on stderr, so the join's provenance is
visible. Export catalogs and portable fingerprint files (`*.fp.json`) are separate, reusable
artifacts — not part of the index directory. Note that an export catalog carries **symbolic
names** — the exported identifiers, plus who-uses data in a v2 catalog — so a *shared* catalog
leaks that identifying detail even though it contains no source code (the same caveat as the
`.fp.json` note in [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md)).

## Related

- [`GETTING_STARTED.md`](GETTING_STARTED.md) — building your first index and the ways to query it.
- [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md) — why lexical/structural rather than a vector DB; funcstrings and `*.fp.json`.
- [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md) — the vocabulary that `vocabulary.json` caches.
