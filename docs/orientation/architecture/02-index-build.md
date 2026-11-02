# Index build: detail

Click-through detail for 02-index-build.mmd. Facts are as of commit `98abef1` (2026-11-02).
Solid arrows are what the code does on its own; dashed arrows happen only if a
person or agent does them.

## Source input

"A directory, a glob, an archive (`.zip` / `.tar` / `.gz`), an `@filelist`, or even a **`.har` browser-DevTools capture**" ([`docs/CODEEXAM_INDEXES.md:17-18`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_INDEXES.md?plain=1#L17-L18)). `--build-index` takes one such argument.

## GUI build worker

The **Build Index** dialog posts to `/api/build-index` ([`src/server.js:1819`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L1819)), which runs the build in a Worker thread "so the event loop stays responsive" ([`src/server.js:1854-1856`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L1854-L1856)).

## File walk and expansion

`buildIndex` handles `@filelist` and glob inputs ([`src/core/CodeSearchIndex.js:3466`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3466)), and expands archives in memory ([`src/core/CodeSearchIndex.js:3749`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3749), with bomb guards in [`src/archive.js:434`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/archive.js?plain=1#L434)). Binaries become indexable pseudo-source ([`docs/source-map.md:31`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/source-map.md?plain=1#L31)). `SKIP_DIRS` drops directories like `node_modules` ([`src/archive.js:76`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/archive.js?plain=1#L76)).

## literal_index.json

The main file: file contents and lines. It is saved twice during a build ([`src/core/CodeSearchIndex.js:3947`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3947), [`src/core/CodeSearchIndex.js:3985`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3985)). Very large files load through a streaming parser ([`src/core/CodeSearchIndex.js:2474`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L2474)). Required, per `validateIndex` ([`src/core/CodeSearchIndex.js:3416-3418`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3416-L3418)).

## inverted_index.json

Keys are whole normalized **lines**, not words: `_normalizeLine` collapses whitespace ([`src/core/CodeSearchIndex.js:2534-2536`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L2534-L2536)). `buildInvertedIndex(50)` is the call ([`src/core/CodeSearchIndex.js:3955`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3955); the parameter is `maxFileFrequency`, [`src/core/CodeSearchIndex.js:2538`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L2538)).

## function_index.json

Functions and classes with their spans. Lazy-loaded through `_ensureFunctionIndex` ([`src/core/CodeSearchIndex.js:3402-3406`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3402-L3406)).

## rename_map.json

Display names for opaque functions: "applied at DISPLAY time, not to stored content" ([`src/core/CodeSearchIndex.js:3964-3967`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3964-L3967)).

## string_table.json

String literals for `--string-table`, built after the function index ([`src/core/CodeSearchIndex.js:3976`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3976), path at [`src/core/CodeSearchIndex.js:226`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L226)). Other caches appear in the directory later, such as `vocabulary.json` ([`src/core/vocabulary.js:227`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/vocabulary.js?plain=1#L227)).

## a person rebuilds

Dashed on purpose. No code in `src/` watches the source tree (no `fs.watch` at this commit), so an index reflects the source when it was built until someone runs `--build-index` again.

## runs the same buildIndex

The worker calls `idx.buildIndex(sourcePath, …)` ([`src/build-worker.js:59`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/build-worker.js?plain=1#L59)) and streams progress to the parent ([`src/build-worker.js:22`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/build-worker.js?plain=1#L22)).

## saves files and lines

`_saveLiteralIndex` runs before the raw file contents are freed ([`src/core/CodeSearchIndex.js:3946-3952`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3946-L3952)).

## writes lines to files

The inverted index is "streamed to disk, not kept in memory", then reloaded ([`src/core/CodeSearchIndex.js:3987-3988`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3987-L3988)).

## tree-sitter or regex

`useTreeSitter` picks the path ([`src/core/CodeSearchIndex.js:3958-3962`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3958-L3962)). It defaults on: "tree-sitter wherever a grammar ships; --regex-parser opts out" ([`src/argparse.js:140`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/argparse.js?plain=1#L140)). Inside the tree-sitter path the regex parser is the fallback ([`src/core/CodeSearchIndex.js:3215-3226`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3215-L3226)).

## infers display names

`inferAndSaveRenameMap` runs right after the function index ([`src/core/CodeSearchIndex.js:3967`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3967)).

## harvests strings

`buildStringTable(8, …)` uses a minimum length of 8 ([`src/core/CodeSearchIndex.js:3976`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3976)).
