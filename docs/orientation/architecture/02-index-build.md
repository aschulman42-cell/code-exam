# Index build: detail

Click-through detail for 02-index-build.mmd. Facts are as of commit `f9756fe` (2026-11-02).
Where a step happens only if a person or a model does it, that arrow's tip and
section say so.

## A person starts a build

Nothing in `src/` watches the source tree (no `fs.watch` at this commit), so an index reflects the source as it was when built. A build starts only when someone runs `--build-index`, uses the GUI's **Build Index** dialog, or clicks **Rebuild** ([`public/dialogs.js:238`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/dialogs.js?plain=1#L238)).

## Triage by file type

<!-- read: docs/CODEEXAM_INDEXES.md#Building and naming an index -->
`buildIndex` ([`src/core/CodeSearchIndex.js:3459`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3459)) sorts its inputs, then works through them in three loops: source files ([`src/core/CodeSearchIndex.js:3714`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3714)), archives ([`src/core/CodeSearchIndex.js:3738`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3738)) and executables ([`src/core/CodeSearchIndex.js:3783`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3783)). Skip-directory rules such as `node_modules` apply during the walk ([`src/core/CodeSearchIndex.js:3598-3600`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3598-L3600), [`src/archive.js:76`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/archive.js?plain=1#L76)).

## Archive expansion

<!-- read: docs/CODEEXAM_INDEXES.md#Building and naming an index -->
`expandArchive` ([`src/archive.js:434`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/archive.js?plain=1#L434)) expands zip, tar and gzip in memory, and nested archives down to a depth of 5 ([`src/archive.js:34`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/archive.js?plain=1#L34)). A `.har` browser capture works too ([`docs/CODEEXAM_INDEXES.md:17-18`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_INDEXES.md?plain=1#L17-L18)).

## Binary strings

Binaries become indexable `.op` pseudo-source ([`docs/source-map.md:31`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/source-map.md?plain=1#L31)). The Bun extractor is not part of the build; only the binary-inspection commands use it.

## Skipped and census

Files the index doesn't take are counted, not silently dropped. The skipped-extension census is carried onto the index for the GUI's Extensions list ([`src/core/CodeSearchIndex.js:3942-3944`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3942-L3944)).

## SHA1 dedup and prettify

<!-- read: docs/STRUCTURAL_SEARCH.md#Deobfuscation and renames -->
Identical files are hashed by SHA1 and indexed once ([`src/core/CodeSearchIndex.js:3652-3654`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3652-L3654)). Minified JavaScript is deobfuscated and beautified before indexing ([`src/core/CodeSearchIndex.js:3683-3686`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3683-L3686)), so stored lines are not always the original bytes. That matters for line citations.

## In-memory file lines

Everything downstream reads from this. `--split-bundle` is an opt-in, CLI-only step that splits large bundles into virtual modules at this stage ([`src/core/CodeSearchIndex.js:3835-3836`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3835-L3836)). The GUI's build worker runs the same `buildIndex` but passes fewer options ([`src/build-worker.js:59-64`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/build-worker.js?plain=1#L59-L64)).

## literal_index.json

<!-- read: docs/CODEEXAM_INDEXES.md#The on-disk format — plain JSON, not a database -->
The main file: file contents and lines. Saved twice during a build ([`src/core/CodeSearchIndex.js:3947`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3947), [`src/core/CodeSearchIndex.js:3985`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3985)), and read through a streaming parser when very large ([`src/core/CodeSearchIndex.js:2474`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L2474)). Loading a GUI index hard-requires only this file ([`src/server.js:1770-1772`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L1770-L1772)).

## inverted_index.json

<!-- read: docs/CODEEXAM_INDEXES.md#The on-disk format — plain JSON, not a database -->
Keys are whole normalized **lines**, not words ([`src/core/CodeSearchIndex.js:2534-2536`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L2534-L2536)). Each maps to the files and lines where it appears.

## function_index.json

<!-- read: docs/CODEEXAM_INDEXES.md#The on-disk format — plain JSON, not a database -->
Functions and classes with their spans, lazy-loaded through `_ensureFunctionIndex` ([`src/core/CodeSearchIndex.js:3402-3406`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3402-L3406)).

## rename_map.json

<!-- read: docs/STRUCTURAL_SEARCH.md#Deobfuscation and renames -->
Display names for opaque functions: "applied at DISPLAY time, not to stored content" ([`src/core/CodeSearchIndex.js:3964-3967`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3964-L3967)).

## string_table.json

String literals for `--string-table`, built after the function index ([`src/core/CodeSearchIndex.js:3976`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3976)).

## Lazy caches

Files that appear in the index folder later, on first use: for example `vocabulary.json` ([`src/core/vocabulary.js:227`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/vocabulary.js?plain=1#L227)). The reviewer found that its freshness check looks only at version and file count, so a rebuild with the same file count may reuse a stale vocabulary. That has not been tested.

## Index zip

`--index-path` can name a `.zip` containing a built index. It is extracted to a temp cache and loaded, not rebuilt ([`src/core/CodeSearchIndex.js:164`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L164)). This is different from building *from* a zip of source.

## CLI or Build dialog

`--build-index` ([`src/index.js:851`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L851)) or the GUI's `/api/build-index`, which runs the build in a Worker thread "so the event loop stays responsive" ([`src/server.js:1854-1856`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L1854-L1856)). Either way, a person starts it.

## source files

Text files go straight on ([`src/core/CodeSearchIndex.js:3714`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3714)).

## zip tar gz har

Archive inputs ([`src/core/CodeSearchIndex.js:3738`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3738)).

## executables

Executable inputs ([`src/core/CodeSearchIndex.js:3783`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3783)).

## media and unknown

Media and unsupported types are skipped and counted rather than indexed.

## entries, nested to depth 5

`MAX_ARCHIVE_DEPTH = 5` ([`src/archive.js:34`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/archive.js?plain=1#L34)).

## pseudo-source

Strings extracted from a binary become an indexable file ([`docs/source-map.md:31`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/source-map.md?plain=1#L31)).

## unique files

Duplicates are recorded but indexed only once ([`src/core/CodeSearchIndex.js:3652-3654`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3652-L3654)).

## saved first

`_saveLiteralIndex` runs before the raw file contents are freed ([`src/core/CodeSearchIndex.js:3946-3952`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3946-L3952)).

## line to files, skips common

<!-- read: docs/CODEEXAM_SEARCHING.md#Absence is only as complete as the index -->
Lines shorter than 4 characters are skipped ([`src/core/CodeSearchIndex.js:2553`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L2553)), and so is any line found in more than `maxFileFrequency` files, 50 by default ([`src/core/CodeSearchIndex.js:2586`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L2586), [`src/core/CodeSearchIndex.js:2538`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L2538)). Searches that rely on this index, including `--fast`, GUI regex and callers, can therefore miss matches. That matters for any claim that something is absent.

## tree-sitter plus regex

Per file, not either/or. The regex parser runs on every file ([`src/core/CodeSearchIndex.js:3276`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3276)), and its results are merged with tree-sitter's ([`src/core/CodeSearchIndex.js:3289`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3289)). Only `--regex-parser` turns tree-sitter off ([`src/argparse.js:140`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/argparse.js?plain=1#L140)).

## infers display names

`inferAndSaveRenameMap` runs right after the function index ([`src/core/CodeSearchIndex.js:3967`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3967)).

## string bounds

`buildStringTable(8, …)` runs after the function index, with a minimum string length of 8 ([`src/core/CodeSearchIndex.js:3976`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3976)).

## built later, on demand

Caches such as `vocabulary.json` are not written by `buildIndex`; they appear the first time a command needs them ([`src/core/vocabulary.js:227`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/vocabulary.js?plain=1#L227)).

## loaded instead of built

`resolveIndexDir` handles a zipped index ([`src/core/CodeSearchIndex.js:164`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L164)).
