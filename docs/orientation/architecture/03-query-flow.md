# Query flow: detail

Click-through detail for 03-query-flow.mmd. Facts are as of commit `f9756fe` (2026-11-02).
Where a step happens only if a person or a model does it, that arrow's tip and
section say so.

## A query

<!-- read: docs/CODEEXAM_SEARCHING.md#The text-search modes -->
From any front-end. The CLI handler for literal, fast and regex search is in `src/commands/search.js` ([`src/commands/search.js:317`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/search.js?plain=1#L317)); the GUI's equivalent is [`src/server.js:2427`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2427).

## Literal and regex scan

<!-- read: docs/CODEEXAM_SEARCHING.md#The text-search modes -->
`searchLiteral` works from the loaded file contents; it takes `useRegex` ([`src/core/CodeSearchIndex.js:4129-4135`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L4129-L4135)).

## Inverted lookup

<!-- read: docs/CODEEXAM_SEARCHING.md#The text-search modes -->
<!-- read: docs/CODEEXAM_SEARCHING.md#Absence is only as complete as the index -->
`searchInverted`: "Fast search using inverted index" ([`src/core/CodeSearchIndex.js:4227-4239`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L4227-L4239)).

## Multisect scan

<!-- read: docs/CODEEXAM_SEARCHING.md#Multisect: multi-term search with scope -->
`multisectSearch` ([`src/core/multisect.js:145-149`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L145-L149)). Phase 1 tests each term's regex against every line of every file ([`src/core/multisect.js:204-208`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L204-L208)). The file never mentions the inverted index, so this is a full scan rather than a lookup.

## Call graph

<!-- read: docs/CODEEXAM_GUI.md#Following the code -->
`src/core/calls.js`. `findCallers` needs the inverted index ([`src/core/calls.js:329-333`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L329-L333)), `findCallees` needs the function index ([`src/core/calls.js:553-554`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L553-L554)). `_resolveCalleeTarget` takes a `receiver` option, so a bare name is no longer all it has to go on ([`src/core/calls.js:61-64`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L61-L64)).

## Function class file folder matches

Phase 2 runs on survivor files plus class candidates ([`src/core/multisect.js:373-378`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L373-L378)). Core sorts functions by `weighted_terms`, not by rarity ([`src/core/multisect.js:563-568`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L563-L568)).

## IDF ranking

<!-- read: docs/CODEEXAM_SEARCHING.md#Multisect: multi-term search with scope -->
`computeIdfScores` and `matchIdfScore` ([`src/commands/multisect.js:152-156`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L152-L156), [`src/commands/multisect.js:176-179`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L176-L179)). The pipeline notes say so directly: "IDF ranking in `commands/`, not `core/`" ([`docs/claims-pipeline-state.md:28`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L28)).

## Ranked result

<!-- read: docs/CODEEXAM_SEARCHING.md#How results are shown -->
The sort key is weighted terms, then terms matched, then IDF ([`src/commands/multisect.js:482-487`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L482-L487)).

## search and regex

`--search` and `--regex` reach `searchLiteral` ([`src/commands/search.js:273`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/search.js?plain=1#L273)).

## fast

`--fast` calls `index.searchInverted` ([`src/commands/search.js:317`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/search.js?plain=1#L317)).

## multi-term

The CLI's `doMultisect` ([`src/commands/multisect.js:798`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L798), [`src/commands/multisect.js:818`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L818)) and the GUI's `_runMultisectViews` ([`src/server.js:4056-4060`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4056-L4060)). The MCP tool calls the same core ([`src/mcp-server.js:730`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L730)).

## callers and callees

`--callers` and `--callees` in `src/commands/callers.js`, and the `callers` and `callees` MCP tools ([`src/mcp-server.js:169`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L169), [`src/mcp-server.js:181`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L181)).

## candidate lines

`findCallers` checks `_ensureInvertedAvailable` first ([`src/core/calls.js:330-333`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/calls.js?plain=1#L330-L333)).

## two phases

"Phase 1: Scan file lines to collect file sets per term (fast). Phase 2: Detail retrieval for survivor files only" ([`src/core/multisect.js:83-84`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L83-L84)).

## CLI and GUI rerank

`displayMultisectResults` for the CLI ([`src/commands/multisect.js:425`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L425)), `prepareMultisectViews` for the views ([`src/commands/multisect.js:256-258`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L256-L258)), which the GUI reaches through `_runMultisectViews` ([`src/server.js:4053-4056`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4053-L4056)).

## by scope

Separate sorts for function, class, file and folder scopes ([`src/commands/multisect.js:482-501`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L482-L501)).

## context lines

`contextLines` defaults to 3 ([`src/core/CodeSearchIndex.js:4130`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L4130)).

## matching lines

Results come back as lines with file and function context, the shape the `search` tool describes ([`docs/CODEEXAM_MCP.md:66`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L66)).
