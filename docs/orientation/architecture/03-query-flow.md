# Query flow: detail

Click-through detail for 03-query-flow.mmd. Facts are as of commit `f9756fe` (2026-11-02).
Where a step happens only if a person or a model does it, that arrow's tip and
section say so.

## A query

<!-- read: docs/CODEEXAM_SEARCHING.md#The text-search modes -->
From any front-end. There is no single default mode on the CLI: each flag dispatches separately ([`src/index.js:1023-1026`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L1023-L1026)). The GUI's default is literal ([`src/server.js:2412`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2412)).

## Hybrid search

`--search` goes through `searchHybrid` ([`src/commands/search.js:247`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/search.js?plain=1#L247)), which expands rename markers before a literal search.

## Literal and regex scan

<!-- read: docs/CODEEXAM_SEARCHING.md#The text-search modes -->
`searchLiteral` works from the loaded file contents and takes `useRegex` ([`src/core/CodeSearchIndex.js:4129-4135`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L4129-L4135)). `--literal` reaches it directly ([`src/commands/search.js:347`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/search.js?plain=1#L347)), and so does the MCP `search` tool ([`docs/CODEEXAM_MCP.md:66`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L66)).

## Inverted line-key scan

<!-- read: docs/CODEEXAM_SEARCHING.md#The text-search modes -->
<!-- read: docs/CODEEXAM_SEARCHING.md#Absence is only as complete as the index -->
`searchInverted` ([`src/core/CodeSearchIndex.js:4239`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L4239)) is not a key lookup: it tests the pattern against every stored line ([`src/core/CodeSearchIndex.js:4259-4260`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L4259-L4260)). Lines that appear in more than 50 files were never stored (see the *Index build* diagram).

## Multisect scan

<!-- read: docs/CODEEXAM_SEARCHING.md#Multisect: multi-term search with scope -->
`multisectSearch` ([`src/core/multisect.js:145-149`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L145-L149)). Phase 1 scans each file's lines for each term ([`src/core/multisect.js:221-237`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L221-L237)). Neither multisect file mentions the inverted index.

## Scope matches

Phase 2 runs on survivor files plus class candidates ([`src/core/multisect.js:373-378`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L373-L378)). Core sorts functions by `weighted_terms`, then terms matched, then shorter functions first ([`src/core/multisect.js:563-568`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L563-L568)).

## IDF and density rerank

<!-- read: docs/CODEEXAM_SEARCHING.md#Multisect: multi-term search with scope -->
`computeIdfScores` and `matchIdfScore` ([`src/commands/multisect.js:152-156`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L152-L156), [`src/commands/multisect.js:176-179`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L176-L179)), with the IDF score multiplied by match density ([`src/commands/multisect.js:191`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L191)). The pipeline notes say "IDF ranking in `commands/`, not `core/`" ([`docs/claims-pipeline-state.md:28`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L28)).

## Callers

<!-- read: docs/CODEEXAM_GUI.md#Following the code -->
`findCallers` needs the inverted index ([`src/core/calls.js:329-333`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L329-L333)). It doesn't use `searchInverted`; it walks the stored lines itself and tests call patterns ([`src/core/calls.js:438-440`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L438-L440)).

## Callees

<!-- read: docs/CODEEXAM_GUI.md#Following the code -->
`findCallees` needs the function index, not the inverted index ([`src/core/calls.js:553-554`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L553-L554)). `_resolveCalleeTarget` takes a `receiver` option, so a bare name is not all it has to go on ([`src/core/calls.js:61-64`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L61-L64)).

## Result

<!-- read: docs/CODEEXAM_SEARCHING.md#How results are shown -->
What reaches the user depends on the route: ranked for multisect on CLI and GUI, unscored for literal and inverted searches.

## literal and regex, CLI and MCP

`--literal` ([`src/commands/search.js:347`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/search.js?plain=1#L347)) and `--regex` on the CLI, and MCP `search` and `regex_search`.

## search flag

`--search` ([`src/commands/search.js:247`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/search.js?plain=1#L247)).

## literal path

`searchHybrid` ends in a literal search.

## fast, and GUI regex

`--fast` calls `index.searchInverted` ([`src/commands/search.js:317`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/search.js?plain=1#L317)). The GUI sends **both** fast and regex searches there ([`src/server.js:2426-2427`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2426-L2427)), so GUI regex inherits the inverted index's blind spots.

## multi-term

The CLI's `doMultisect` ([`src/commands/multisect.js:818`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L818)), the GUI's `_runMultisectViews` ([`src/server.js:4056-4060`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4056-L4060)), and the MCP tool ([`src/mcp-server.js:730`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L730)).

## callers

`--callers` and the `callers` MCP tool ([`src/mcp-server.js:169`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L169)).

## callees

`--callees` and the `callees` MCP tool ([`src/mcp-server.js:181`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L181)).

## scans keys for call patterns

`idx.forEachInvertedEntry` with call-pattern checks ([`src/core/calls.js:438-440`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L438-L440)). A call line that appears in more than 50 files was never stored, so the reviewer inferred that callers can miss it. That has not been tested.

## reads the function body

Callees come from the function's own lines, with comments and strings masked ([`src/core/calls.js:553-554`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L553-L554)).

## two phases

"Phase 1: Scan file lines to collect file sets per term (fast). Phase 2: Detail retrieval for survivor files only" ([`src/core/multisect.js:83-84`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L83-L84)).

## CLI and GUI

`displayMultisectResults` for the CLI ([`src/commands/multisect.js:425`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L425)) and `prepareMultisectViews` for the GUI ([`src/commands/multisect.js:256-258`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L256-L258), [`src/commands/multisect.js:314-316`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L314-L316)).

## MCP, no rerank

The MCP tool returns core's order, with no IDF or density step, and only function and file scopes ([`src/mcp-server.js:730-748`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L730-L748)).

## ranked scopes

Separate sorts for function, class, file and folder scopes ([`src/commands/multisect.js:482-501`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L482-L501)).

## unscored, file order

Literal results carry `score: 0.0` ([`src/core/CodeSearchIndex.js:4216`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L4216)).

## unscored, skips common lines

Inverted results also carry `score: 0.0` ([`src/core/CodeSearchIndex.js:4279`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L4279)), and lines found in more than 50 files were never stored ([`src/core/CodeSearchIndex.js:2586`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L2586)).
