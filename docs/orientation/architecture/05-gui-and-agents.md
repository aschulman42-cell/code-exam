# GUI and agents: detail

Click-through detail for 05-gui-and-agents.mmd. Facts are as of commit `f9756fe` (2026-11-02).
Where a step happens only if a person or a model does it, that arrow's tip and
section say so.

## Browser modules

<!-- read: docs/CODEEXAM_GUI.md#The layout -->
Plain ES modules sharing one mutable state object ([`public/state.js:1`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/state.js?plain=1#L1)). The Claims Workspace offers Multisect Search, Multisect Analyze, Claim Search and Claim Analyze ([`public/index.html:462-466`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/index.html?plain=1#L462-L466)).

## Ask in Chat link

The Overview's "Questions to start with" get an **Ask in Chat** link each ([`public/list-renderers.js:2205-2207`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/list-renderers.js?plain=1#L2205-L2207)). `askInChat` opens the Chat tab and fills in the question, but does not send it ([`public/list-renderers.js:2344-2352`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/list-renderers.js?plain=1#L2344-L2352)).

## Route table

<!-- read: docs/CODEEXAM_ARCHITECTURE.md#The shape of it -->
A `routes` object keyed by path, for example [`src/server.js:1744`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L1744); `handleRequest` looks them up ([`src/server.js:4328-4334`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4328-L4334)).

## Exec route

`/api/exec` ([`src/server.js:4078`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4078)), used by the GUI's Console tab ([`public/console.js:254-256`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/console.js?plain=1#L254-L256)).

## REPL command handlers

`execCommand` from the REPL ([`src/commands/interactive.js:1310`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/interactive.js?plain=1#L1310)), called at [`src/server.js:4101`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4101).

## IndexManager

Holds named indexes and the active one ([`src/core/index-manager.js:101-111`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/index-manager.js?plain=1#L101-L111)). `get()` returns a named index or the active one ([`src/core/index-manager.js:133-135`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/index-manager.js?plain=1#L133-L135)).

## Chat runner

<!-- read: docs/CODEEXAM_GUI.md#Chat -->
<!-- read: docs/CODEEXAM_MCP.md#Driving a local model through the tools -->
`src/core/chat-runner.js`, "shared by the GUI server and the CLI's --ask-ai" ([`src/core/chat-runner.js:1`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L1)). Three loops: Claude, OpenAI-compatible and local ([`src/core/chat-runner.js:198`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L198), [`src/core/chat-runner.js:319`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L319), [`src/core/chat-runner.js:437`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L437)).

On a local GGUF model, the loop changes how it prompts:
- it gets a curated menu of tools ([`src/core/chat-runner.js:452`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L452));
- tool results are capped at 4000 characters, with special tokens neutralized ([`src/core/chat-runner.js:529`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L529));
- earlier answers are dropped and the question is wrapped with a read-the-code-first directive ([`src/core/chat-runner.js:541-551`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L541-L551));
- for Gemma, the system prompt is folded into the user turn, because its wrapper drops system prompts ([`src/core/chat-runner.js:562-566`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L562-L566)).

## ask-ai command

`--ask-ai` reaches the same loops without the GUI ([`src/commands/ask.js:147`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/ask.js?plain=1#L147), [`src/commands/ask.js:168-169`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/ask.js?plain=1#L168-L169)).

## Overview by AI

<!-- read: docs/UNCOVER_KEY_CODE.md#Overview by AI — `--overview-by-ai` -->
Two implementations. Cloud: `runAiOverview` spawns CodeExam's own MCP server as a subprocess and connects a client to it ([`src/core/ai-overview.js:185-195`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L185-L195)). Local: it calls `handleTool` directly ([`src/server.js:2529`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2529), [`src/server.js:2594`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2594)), with local-engine grounding ([`src/core/ai-overview.js:140`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L140)).

## handleTool

<!-- read: docs/CODEEXAM_MCP.md#One tool table, three menus, three paths to it -->
"Every tool result passes the credential mask on its way out. ONE seam, deliberately" ([`src/mcp-server.js:1425-1432`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1425-L1432)). That seam covers model tool calls only: the exec route doesn't pass through it.

## TOOLS table

<!-- read: docs/CODEEXAM_MCP.md#One tool table, three menus, three paths to it -->
"The `TOOLS` table in `src/mcp-server.js` is the only registration" ([`docs/CODEEXAM_MCP.md:13-15`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L13-L15)), with three menus drawn from it: every tool, the overview's 16 ([`src/core/ai-overview.js:44-48`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L44-L48)), and a local model's curated 8 ([`src/core/local-chat-tools.js:11-12`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/local-chat-tools.js?plain=1#L11-L12)).

## MCP server process

A separate process: an external client's child, or the cloud Overview's. It loads its own index from the path it's given ([`src/mcp-server.js:87`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L87)).

## External MCP clients

<!-- read: docs/CODEEXAM_MCP.md#The tools -->
Claude Code, Claude Desktop and others ([`docs/CODEEXAM_MCP.md:21`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L21)). The `load_index` tool switches indexes for the life of the process ([`src/mcp-server.js:341`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L341)).

## LLM engines

<!-- read: docs/AI_ASSISTED_CODE_EXAM.md#Cloud or local -->
Picked per request; an absent engine defaults to Claude ([`src/server.js:4171-4178`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4171-L4178)). See the *Configuration* diagram.

## fetch api endpoints

`api.post` and related helpers, with a default 5-minute timeout ([`public/api.js:36-41`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/api.js?plain=1#L36-L41)).

## prefills; a person sends

The link only fills in `#chat-input` ([`public/list-renderers.js:2350-2351`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/list-renderers.js?plain=1#L2350-L2351)). A person presses Enter to send.

## Console tab

The Console sends commands to `/api/exec` ([`public/console.js:254-256`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/console.js?plain=1#L254-L256)).

## not through handleTool

So exec output doesn't pass the credential mask, which only `handleTool` applies ([`src/mcp-server.js:1434`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1434)). The reviewer didn't find masking elsewhere, but didn't rule it out.

## gets the active index

`mgr.get(q.index)` ([`src/server.js:4080`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4080)).

## setIndex pushes the index

The server pushes the active index into the tool router on load and replace ([`src/server.js:1797`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L1797)), and the chat loops set it per request ([`src/core/chat-runner.js:199`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L199)). The router doesn't know about IndexManager ([`src/mcp-server.js:66`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L66), [`src/mcp-server.js:70`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L70)).

## chat routes

`/api/chat` ([`src/server.js:4160`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4160)) and the streaming `/api/chat-stream` ([`src/server.js:4231`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4231)). The GUI's **live** checkbox picks between them ([`public/app.js:1724-1727`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/app.js?plain=1#L1724-L1727)).

## same loops

`runChatToolLoopLocal`, `runChatToolLoop` or `runChatToolLoopOpenAI` ([`src/commands/ask.js:147`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/ask.js?plain=1#L147), [`src/commands/ask.js:168-169`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/ask.js?plain=1#L168-L169)).

## Overview by AI route

The GUI's cloud overview ([`src/server.js:2702`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2702)) and local overview ([`src/server.js:2529`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2529)).

## tool calls in-process

"Every tool call still runs in-process through handleTool: no subprocess" ([`src/core/chat-runner.js:30`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L30), [`src/core/chat-runner.js:239`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L239)).

## local: in-process

`handleTool(name, args)` inside the server ([`src/server.js:2594`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2594)).

## cloud: stdio child

`StdioClientTransport` running `node` on the MCP server ([`src/core/ai-overview.js:188-193`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L188-L193)).

## stdio child process

`StdioServerTransport` ([`src/mcp-server.js:1452-1453`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1452-L1453)).

## loads its own index

`new CodeSearchIndex({ indexPath: serverArgs.indexPath })` on first use ([`src/mcp-server.js:87`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L87)).

## model turns

For example, the Claude loop's request ([`src/core/chat-runner.js:161`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L161)).

## all, or 8 for local

Cloud Chat gets every tool ([`src/core/chat-runner.js:71-76`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L71-L76)); a local model gets the curated menu ([`src/core/chat-runner.js:452`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L452)).

## 16 tools

`AI_OVERVIEW_TOOL_NAMES` ([`src/core/ai-overview.js:44-48`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L44-L48)).

## all tools

The MCP server returns the full table from `tools/list` ([`src/mcp-server.js:1405-1407`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1405-L1407)).
