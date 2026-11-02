# System at a glance: detail

Click-through detail for 01-system.mmd. Facts are as of commit `98abef1` (2026-11-02).
Solid arrows are what the code does on its own; dashed arrows happen only if a
person or agent does them.

## Browser client

The GUI's front end: a single HTML shell plus plain ES modules, with no framework. [`public/index.html:697-699`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/public/index.html?plain=1#L697-L699) loads Mermaid and `app.js`. The README says it is "served on localhost only" ([`README.md:39-43`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/README.md?plain=1#L39-L43)).

## AI clients

External tools such as Claude Code or Claude Desktop that launch the MCP server as a child process ([`docs/CODEEXAM_MCP.md:19-21`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_MCP.md?plain=1#L19-L21)).

## CLI

`src/index.js`, reached through the `ce` and `CodeExam` shims ([`ce:7`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/ce?plain=1#L7)). The one-shot CLI "reloads the index on every run" while the other front-ends hold it in memory ([`docs/CODEEXAM_ARCHITECTURE.md:51-53`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L51-L53)).

## Interactive REPL

`doInteractive` keeps the index resident and takes slash-commands ([`src/commands/interactive.js:355`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/interactive.js?plain=1#L355)); the CLI enters it on `--interactive` ([`src/index.js:1390-1391`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L1390-L1391)).

## GUI server

`src/server.js` is a plain `http` server, not Express at this commit ([`src/server.js:4346`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L4346)), started by `ce --gui` ([`src/index.js:175`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L175), [`src/index.js:333`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L333)) or directly with `node src/server.js`.

## MCP server

`src/mcp-server.js` registers its `TOOLS` table ([`src/mcp-server.js:106`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/mcp-server.js?plain=1#L106)) and serves over stdio ([`src/mcp-server.js:1452-1453`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/mcp-server.js?plain=1#L1452-L1453)). The index loads on the first tool call, not at startup ([`src/mcp-server.js:1448-1451`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/mcp-server.js?plain=1#L1448-L1451)).

## Command modules

`src/commands/` holds "one module per CLI surface" ([`docs/source-map.md:39`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/source-map.md?plain=1#L39)). Adding a feature still touches several files, "a known rough edge" tracked in #97 ([`docs/CODEEXAM_ARCHITECTURE.md:12-18`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L12-L18)).

## CodeSearchIndex engine

`src/core/CodeSearchIndex.js` builds, saves, loads and searches an index ([`docs/CODEEXAM_ARCHITECTURE.md:57-60`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L57-L60)). The engine is "**deterministic**: the same index and the same command produce the same answer, with no AI model in the basic loop" ([`README.md:31-32`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/README.md?plain=1#L31-L32)).

## On-disk index

"A directory of plain-JSON files built once from a codebase" ([`docs/CODEEXAM_INDEXES.md:3-4`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_INDEXES.md?plain=1#L3-L4)). See the *Index build* diagram for the files.

## LLM engines

Optional. AI features "only ever touch *output*, never the index or the core results" ([`README.md:33-37`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/README.md?plain=1#L33-L37)). The full list of entry points is in [`docs/AI_ASSISTED_CODE_EXAM.md:21-36`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/AI_ASSISTED_CODE_EXAM.md?plain=1#L21-L36).

## calls api routes

`public/api.js` wraps `fetch` to `/api/<endpoint>` ([`public/api.js:41`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/public/api.js?plain=1#L41)). See the *GUI and agents* diagram.

## speaks MCP over stdio

"MCP over STDIO to `src/mcp-server.js` as a child process" ([`docs/CODEEXAM_MCP.md:21`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_MCP.md?plain=1#L21)).

## dispatches one command

A long run of `if (args.x)` blocks at module scope, for example [`src/index.js:1205-1212`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L1205-L1212). It is not a dispatch table.

## same do handlers

The REPL routes slash-commands to the same `do*()` handlers the CLI uses ([`docs/CODEEXAM_ARCHITECTURE.md:37-38`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L37-L38)). Not every command is present: see *Open questions* in the Overview.

## route handlers

`handleRequest` looks up `routes[urlPath]` ([`src/server.js:4328-4334`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L4328-L4334)), and the handler gets its index from the index manager, for example [`src/server.js:4078-4080`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L4078-L4080).

## handleTool

Every tool call passes through one router, which also masks credentials on the way out ([`src/mcp-server.js:1425-1436`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/mcp-server.js?plain=1#L1425-L1436)).

## query the index

For example `doMultisect` calls `index.multisectSearch` ([`src/commands/multisect.js:818`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/multisect.js?plain=1#L818)).

## builds saves loads

`buildIndex` is at [`src/core/CodeSearchIndex.js:3459`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L3459); the constructor tries to load an existing index ([`src/core/CodeSearchIndex.js:210-211`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/CodeSearchIndex.js?plain=1#L210-L211)).

## only on AI commands

A provider or local model is resolved only for commands that need one: `resolveModel` is at [`src/core/llm-runner.js:63-70`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L63-L70). See the *Configuration* diagram.
