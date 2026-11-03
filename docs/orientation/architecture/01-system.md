# System at a glance: detail

Click-through detail for 01-system.mmd. Facts are as of commit `f9756fe` (2026-11-02).
Where a step happens only if a person or a model does it, that arrow's tip and
section say so.

## Browser client

<!-- read: docs/CODEEXAM_GUI.md#The layout -->
The GUI's front end: a single HTML shell plus plain ES modules, with no framework ([`public/index.html:697-699`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/index.html?plain=1#L697-L699)). The README says it is "served on localhost only" ([`README.md:39-43`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/README.md?plain=1#L39-L43)).

## AI clients

<!-- read: docs/CODEEXAM_MCP.md#One tool table, three menus, three paths to it -->
External tools such as Claude Code or Claude Desktop, which launch the MCP server as a child process ([`docs/CODEEXAM_MCP.md:19-21`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L19-L21)).

## CLI

<!-- read: docs/CODEEXAM_ARCHITECTURE.md#The shape of it -->
`src/index.js`, reached through the `ce` and `CodeExam` shims ([`ce:7`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/ce?plain=1#L7)). The one-shot CLI "reloads the index on every run" while the other front-ends hold it in memory ([`docs/CODEEXAM_ARCHITECTURE.md:51-53`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L51-L53)).

## Interactive REPL

<!-- read: docs/CODEEXAM_ARCHITECTURE.md#The shape of it -->
`doInteractive` keeps the index resident and takes slash-commands ([`src/commands/interactive.js:355`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/interactive.js?plain=1#L355)); the CLI enters it on `--interactive` ([`src/index.js:1390-1391`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L1390-L1391)).

## GUI server

<!-- read: docs/CODEEXAM_GUI.md#The layout -->
`src/server.js` is a plain `http` server ([`src/server.js:4346`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4346)), started by `ce --gui` ([`src/index.js:175`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L175), [`src/index.js:333`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L333)) or directly with `node src/server.js`.

## MCP server

<!-- read: docs/CODEEXAM_MCP.md#One tool table, three menus, three paths to it -->
`src/mcp-server.js`, run as its own process over stdio ([`src/mcp-server.js:1452-1453`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1452-L1453)). The index loads on the first tool call, not at startup ([`src/mcp-server.js:1448-1451`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1448-L1451)). Run directly, it reads only an index path from its arguments ([`src/mcp-server.js:49-53`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L49-L53)).

## Tool router

<!-- read: docs/CODEEXAM_MCP.md#One tool table, three menus, three paths to it -->
The `TOOLS` table ([`src/mcp-server.js:106`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L106)) and `handleTool`, which masks credentials on every result ([`src/mcp-server.js:1425-1436`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1425-L1436)). It is also an internal library: the GUI server imports it ([`src/server.js:30`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L30)), and the file runs `main()` only when started directly ([`src/mcp-server.js:1457-1458`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1457-L1458)). So "MCP" here does not only mean external clients.

## AI runners

<!-- read: docs/AI_ASSISTED_CODE_EXAM.md#What the assisted commands do -->
Three families, not one. The Chat loops ([`src/core/chat-runner.js:1`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L1)), Overview by AI ([`src/core/ai-overview.js:14-15`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L14-L15); local version [`src/core/ai-overview-local.js:12`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview-local.js?plain=1#L12)), and the LLM runner used by analysis and claim commands ([`src/core/llm-runner.js:63`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L63)). See the *GUI and agents* and *Configuration* diagrams.

## Command modules

<!-- read: docs/CODEEXAM_ARCHITECTURE.md#The layers -->
`src/commands/` holds "one module per CLI surface" ([`docs/source-map.md:39`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/source-map.md?plain=1#L39)). Adding a feature still touches several files, "a known rough edge" tracked in #97 ([`docs/CODEEXAM_ARCHITECTURE.md:12-18`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L12-L18)).

## CodeSearchIndex engine

<!-- read: docs/CODEEXAM_ARCHITECTURE.md#The layers -->
`src/core/CodeSearchIndex.js` builds, saves, loads and searches an index ([`docs/CODEEXAM_ARCHITECTURE.md:57-60`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L57-L60)). The engine is "**deterministic**: the same index and the same command produce the same answer, with no AI model in the basic loop" ([`README.md:31-32`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/README.md?plain=1#L31-L32)).

## On-disk index

<!-- read: docs/CODEEXAM_INDEXES.md#The on-disk format — plain JSON, not a database -->
"A directory of plain-JSON files built once from a codebase" ([`docs/CODEEXAM_INDEXES.md:3-4`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_INDEXES.md?plain=1#L3-L4)). A `.zip` holding a built index also works: it is extracted to a temp cache ([`src/core/CodeSearchIndex.js:164`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L164)). A few commands use no index at all ([`docs/CODEEXAM_INDEXES.md:3-7`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_INDEXES.md?plain=1#L3-L7)).

## LLM engines

<!-- read: docs/AI_ASSISTED_CODE_EXAM.md#The determinism boundary -->
Optional. AI features "only ever touch *output*, never the index or the core results" ([`README.md:33-37`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/README.md?plain=1#L33-L37)). The full list of entry points is in [`docs/AI_ASSISTED_CODE_EXAM.md:21-36`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/AI_ASSISTED_CODE_EXAM.md?plain=1#L21-L36). Three arrows reach this box, from the runners, the command modules and the GUI server itself: see the *Configuration* diagram for how `--air-gapped` guards each.

## calls api routes

`public/api.js` wraps `fetch` to `/api/<endpoint>` ([`public/api.js:41`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/api.js?plain=1#L41)).

## speaks MCP over stdio

"MCP over STDIO to `src/mcp-server.js` as a child process" ([`docs/CODEEXAM_MCP.md:21`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L21)).

## if-chain dispatch

A run of `if (args.x)` blocks at module scope, for example [`src/index.js:1205-1212`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L1205-L1212). The blocks don't exit, so more than one command can run in one call; the code itself notes "2+ run together" ([`src/index.js:1145`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L1145)).

## build and inline commands

The CLI calls the engine directly for the build ([`src/index.js:851`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L851)) and for some commands, such as the rename map ([`src/index.js:990`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L990)).

## same do handlers

The REPL routes slash-commands to the same `do*()` handlers the CLI uses ([`docs/CODEEXAM_ARCHITECTURE.md:37-38`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L37-L38)). Not all of them: of the claims family it has only `/claim` and `/claim-analyze` ([`src/commands/interactive.js:297-304`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/interactive.js?plain=1#L297-L304)).

## route handlers

`handleRequest` looks up `routes[urlPath]` ([`src/server.js:4328-4334`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4328-L4334)). Many handlers call the engine directly, for example `/api/multisect` through `_runMultisectViews` ([`src/server.js:4056-4060`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4056-L4060)).

## exec route and shared helpers

`/api/exec` runs REPL commands for the GUI's Console tab ([`src/server.js:4078`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4078), [`src/server.js:4101`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4101); [`public/console.js:254-256`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/console.js?plain=1#L254-L256)). Other routes import helpers from `src/commands/` ([`src/server.js:58-60`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L58-L60)).

## handleTool

Every external MCP call passes through it ([`src/mcp-server.js:1434-1436`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1434-L1436)).

## query the index

For example `doMultisect` calls `index.multisectSearch` ([`src/commands/multisect.js:818`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/multisect.js?plain=1#L818)). One tool, `call_tree`, runs a command module instead ([`src/mcp-server.js:1307`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1307)).

## ask-ai and Overview by AI

`--ask-ai` goes through `src/commands/ask.js` into the Chat loops ([`src/index.js:547-549`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L547-L549)). `--overview-by-ai` runs the overview directly, local or cloud ([`src/index.js:617`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L617), [`src/index.js:651`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L651)).

## Chat and Overview by AI

The `/api/chat` route ([`src/server.js:4160`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4160)) and the GUI's Overview by AI ([`src/server.js:2702`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2702)).

## tool calls in-process

The Chat loops call `handleTool` directly, with no MCP protocol ([`src/core/chat-runner.js:239`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L239)), as does the local Overview ([`src/core/ai-overview-local.js:12`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview-local.js?plain=1#L12)). The cloud Overview is the exception: it spawns the MCP server over stdio ([`src/core/ai-overview.js:185-195`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L185-L195)).

## model calls

For example the Chat loops' cloud request ([`src/core/chat-runner.js:161`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L161)).

## analyze and claim drafting

Analysis and claim commands draft through the LLM runner: `draftCloud` ([`src/core/llm-runner.js:215`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L215)).

## its own model calls

The GUI server has its own client, `callClaude` ([`src/server.js:396`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L396)), used by the claim-search and analyze routes ([`src/server.js:3817`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L3817)).

## builds saves loads

`buildIndex` is at [`src/core/CodeSearchIndex.js:3459`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L3459); the constructor tries to load an existing index ([`src/core/CodeSearchIndex.js:210-211`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/CodeSearchIndex.js?plain=1#L210-L211)).
