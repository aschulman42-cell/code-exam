# GUI and agents: detail

Click-through detail for 05-gui-and-agents.mmd. Facts are as of commit `f9756fe` (2026-11-02).
Where a step happens only if a person or a model does it, that arrow's tip and
section say so.

## Browser modules

<!-- read: docs/CODEEXAM_GUI.md#The layout -->
Plain ES modules sharing one mutable state object ([`public/state.js:1`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/state.js?plain=1#L1)). Workspace actions branch on `mode` ([`public/app.js:1202-1209`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/app.js?plain=1#L1202-L1209)). The Workspace offers Multisect Search, Multisect Analyze, Claim Search and Claim Analyze ([`public/index.html:462-466`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/index.html?plain=1#L462-L466)).

## Route table

<!-- read: docs/CODEEXAM_ARCHITECTURE.md#The shape of it -->
A `routes` object keyed by path, for example [`src/server.js:1744`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L1744); `handleRequest` looks them up and serves everything else as static files ([`src/server.js:4328-4338`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4328-L4338)).

## IndexManager

Holds named indexes and the active one ([`src/core/index-manager.js:101-111`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/index-manager.js?plain=1#L101-L111)); `replace()` swaps them ([`src/core/index-manager.js:164`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/index-manager.js?plain=1#L164)).

## Chat runner

<!-- read: docs/CODEEXAM_GUI.md#Chat -->
`src/core/chat-runner.js`: "the chat-about-code tool loops (Claude, OpenAI-compatible, local GGUF), shared by the GUI server and the CLI's --ask-ai" ([`src/core/chat-runner.js:1`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L1)). The three loops: [`src/core/chat-runner.js:198`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L198), [`src/core/chat-runner.js:319`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L319), [`src/core/chat-runner.js:437`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L437). `--ask-ai` reaches it through `doAskAi` ([`src/commands/ask.js:92`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/ask.js?plain=1#L92)).

## LLM engines

<!-- read: docs/AI_ASSISTED_CODE_EXAM.md#Cloud or local -->
Picked per request; an absent engine defaults to Claude ([`src/server.js:4171-4178`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4171-L4178)). See the *Configuration* diagram.

## handleTool

<!-- read: docs/CODEEXAM_MCP.md#One tool table, three menus, three paths to it -->
"Every tool result passes the credential mask on its way out. ONE seam, deliberately" ([`src/mcp-server.js:1425-1432`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1425-L1432)).

## TOOLS table

<!-- read: docs/CODEEXAM_MCP.md#One tool table, three menus, three paths to it -->
"The `TOOLS` table in `src/mcp-server.js` is the only registration" ([`docs/CODEEXAM_MCP.md:13-15`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L13-L15)). It now includes `claim_elements`, `claim_candidates` and `capabilities` ([`src/mcp-server.js:403`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L403), [`src/mcp-server.js:415`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L415), [`src/mcp-server.js:430`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L430)). The menu differs by surface: a local model gets a curated eight tools ([`src/core/local-chat-tools.js:11-12`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/local-chat-tools.js?plain=1#L11-L12)).

## External MCP clients

<!-- read: docs/CODEEXAM_MCP.md#The tools -->
Claude Code, Claude Desktop and others ([`docs/CODEEXAM_MCP.md:21`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L21)). The `load_index` tool switches indexes for the life of the process ([`src/mcp-server.js:341`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L341)).

## fetch api endpoints

`api.post` and friends, with a default 5-minute timeout ([`public/api.js:36-41`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/api.js?plain=1#L36-L41)).

## gets the active index

`mgr.get(q.index)` ([`src/server.js:4080-4081`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4080-L4081)).

## chat routes

`/api/chat` ([`src/server.js:4160`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4160)) and the streaming `/api/chat-stream` ([`src/server.js:4231`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4231)), which sends CE's own event shape ([`src/server.js:4224-4227`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4224-L4227)). The GUI's **live** checkbox picks between them ([`public/app.js:1724-1727`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/app.js?plain=1#L1724-L1727)).

## model turns

For example, the Claude loop sets its budget at `maxTokens = 4096` ([`src/core/chat-runner.js:198`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L198)).

## tool calls in-process

"Every tool call still runs in-process through handleTool: no subprocess" ([`src/core/chat-runner.js:30`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L30), [`src/core/chat-runner.js:239`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L239)).

## stdio child process

`StdioServerTransport` ([`src/mcp-server.js:1452-1453`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1452-L1453)).

## one registration

`chatAnthropicTools` and `chatOpenAITools` map the same table ([`src/core/chat-runner.js:71-76`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L71-L76)), and the MCP server returns it from `tools/list` ([`src/mcp-server.js:1405-1407`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1405-L1407)).

## masked results from

`maskCredentials(handleToolRaw(name, args))` ([`src/mcp-server.js:1434-1436`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L1434-L1436)). The active index is set in-process by `setIndex` ([`src/mcp-server.js:70`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L70), called at [`src/core/chat-runner.js:199`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L199)).
