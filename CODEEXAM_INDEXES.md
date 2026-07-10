# CodeExam Indexes

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part N pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

### Index management
- Pure-Node streaming JSON parser handles 5 GB+ indexes.
- Build from directories, glob patterns, archives (zip/tar/gz), `@filelist`
  files, or a **`.har` (browser DevTools) capture** — indexing a website's
  JavaScript straight from a saved network log (#161).
- Query several indexes in a single run with `--multi-index @indexlist`.
- Multi-language parser via tree-sitter WASM grammars + regex fallback:
  - Tree-sitter: **C, C++, Java, JavaScript, TypeScript, Python, C#, Go,
    Rust, PHP, Ruby**
  - Regex-only: **Swift, Kotlin, Scala, Lua, Objective-C, CoffeeScript,
    Perl, VBScript, AWK**
- Non-code text is indexed as searchable text (not AST-parsed): **YAML**
  (`.yaml`/`.yml`), Markdown, plain text. YAML coverage is what the
  Infrastructure detectors content-sniff.

**Multi-index and cross-index catalogs.** Beyond querying several indexes in
one run (`--multi-index @indexlist`), CodeExam is growing *cross-index*
analysis. Build a reusable **export catalog** from one or more libraries with
`--exports --emit-catalog <file>` (a v2 catalog also carries who-uses data),
then resolve another codebase against it:

- `--imports <catalog.json>` — attribute this index's imports to whichever
  catalogued library provides each name (discovery join, #162).
- `--exports --used-by <catalog>` — annotate each declared export with its
  de-facto consumers — the **"Used by"** column in the GUI Exports pane —
  surfacing public surface that nobody actually imports.

**No default catalog ships.** Exports extraction is **Python-only today**
(JS/TS is planned, #154), so a bundled Python-only catalog would be too partial
to represent the feature — you build your own from the libraries you care about
and pass the filename explicitly (there is no default name). The build is
*appendable*: re-emitting merges by library identity (`--catalog-replace`
overwrites; `--multi-index` preserves the who-uses / v2 data), so one catalog
can grow across many libraries. For the GUI, start the server with
`--exports-catalog <file>` to light up the **"Used by"** column. Whenever a
catalog is loaded, CodeExam notes which one on stderr, so the provenance of the
join is visible.

### On-disk index layout

A built index is a directory of plain-JSON files — no database server, no
binary store (see *Why a plain inverted index* above). The first three are
always present; a standard `--build-index` normally also writes the next
four, while `vocabulary.json` appears only after `--vocabulary` has run — so
most indexes hold 7–8 JSON files, though a lighter build can omit some (e.g.
an index built without the dedup/funcstring pass has no `func_hashes.json`):

- `literal_index.json` — raw per-file line/content store *(required)*.
- `inverted_index.json` — token → locations map powering search *(required)*.
- `function_index.json` — per-file function / class / symbol structure *(required)*.
- `string_table.json` — deduplicated table of distinctive long strings (≥8 chars), shared by funcstrings and search.
- `func_hashes.json` — cached per-function hashes for exact / near / structural dedup and funcstring intersection.
- `rename_map.json` — inferred readable names (`_KW_`, `_NAME_`, `_IMPORT_`, `_CMD_`, `_FP_`).
- `import_map.json` — extracted import/export data feeding the import census and cross-index joins.
- `vocabulary.json` — cached TF-IDF vocabulary (written once `--vocabulary` has run).

Export catalogs (`--emit-catalog`) and portable fingerprint files
(`*.fp.json`) are separate, reusable artifacts — not part of the index
directory.

Indexes scale to multi-gigabyte source trees (tested on Chromium — ~195K
files, ~5 GB index, loaded with `NODE_OPTIONS=--max-old-space-size=8192`).
