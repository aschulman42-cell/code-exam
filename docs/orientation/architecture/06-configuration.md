# Configuration and environment: detail

Click-through detail for 06-configuration.mmd. Facts are as of commit `f9756fe` (2026-11-02).
Where a step happens only if a person or a model does it, that arrow's tip and
section say so.

## Command-line flags

The declarative table in `src/argparse.js`, for example [`src/argparse.js:475`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/argparse.js?plain=1#L475). Defaults include `index_path: '.code_search_index'` ([`src/argparse.js:136`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/argparse.js?plain=1#L136)).

## Environment variables

Each provider names its key variable ([`src/core/providers.js:31-37`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/providers.js?plain=1#L31-L37)). Others in the code include `CE_OPENAI_API_URL` ([`src/server.js:469`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L469)) and `CE_LOCAL_CHAT_TOOLS` ([`src/core/local-chat-tools.js:1`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/local-chat-tools.js?plain=1#L1)).

## Key files

Each provider also names key files, such as `claude.txt` ([`src/core/providers.js:35`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/providers.js?plain=1#L35)).

## Air-gapped guard

<!-- read: docs/AIR_GAPPED.md#What `--air-gapped` does -->
<!-- read: docs/AIR_GAPPED.md#What it does NOT guarantee — read this -->
`--air-gapped` sets the flag, scrubs keys and runs the startup check, in the CLI ([`src/index.js:391-397`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L391-L397)) and the GUI server ([`src/server.js:230-239`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L230-L239)). The guard is **opt-in**, and it blocks CodeExam's own cloud AI calls: it is not a network sandbox. The docs list what it doesn't guarantee.

## Connectivity probe

One TCP connection to `api.anthropic.com:443` with a 1.5-second timeout, at startup only ([`src/core/air-gapped.js:86-96`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/air-gapped.js?plain=1#L86-L96)). A network that blocks only Anthropic, or allows only a proxy, passes; other providers aren't probed. The startup message itself warns that "a clean result does NOT prove isolation". `--allow-connected` skips it ([`src/core/air-gapped.js:101-102`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/air-gapped.js?plain=1#L101-L102)).

## Provider registry

<!-- read: docs/AI_ASSISTED_CODE_EXAM.md#Cloud or local -->
`PROVIDERS` ([`src/core/providers.js:31`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/providers.js?plain=1#L31)), with `DEFAULT_PROVIDER = 'claude'` ([`src/core/providers.js:62`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/providers.js?plain=1#L62)) and a resolver ([`src/core/providers.js:90`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/providers.js?plain=1#L90)).

## Local GGUF model

<!-- read: docs/LOCAL_LLM.md#Running a local model -->
`ggufDescriptor` ([`src/core/llm-runner.js:52`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L52)). All local work is serialized, and a loaded chat sequence is reused ([`src/server.js:296`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L296), [`src/server.js:616-617`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L616-L617)). CodeExam doesn't download a llama.cpp binary at run time ([`src/core/llm-runner.js:814`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L814)).

## LLM runner

<!-- read: docs/AI_ASSISTED_CODE_EXAM.md#Reproducibility -->
`src/core/llm-runner.js`: `resolveModel` ([`src/core/llm-runner.js:63`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L63)) and `draftCloud` ([`src/core/llm-runner.js:215`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L215)). It is one of three callers that reach the cloud, not the only one.

## Chat and Overview runners

The Chat loops make their own cloud requests ([`src/core/chat-runner.js:161`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L161)), and so does Overview by AI ([`src/core/ai-overview.js:266`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L266)).

## GUI server's own client

`callClaude` and related calls in `src/server.js` ([`src/server.js:396`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L396), [`src/server.js:723`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L723)).

## Cloud endpoints

<!-- read: docs/AI_ASSISTED_CODE_EXAM.md#Cloud or local -->
Each provider declares `egressHosts` ([`src/core/providers.js:37`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/providers.js?plain=1#L37)).

## GUI bind address

`127.0.0.1` by default ([`src/server.js:103`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L103)). On loopback, a Host-header check defends against DNS rebinding ([`src/server.js:4311-4321`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L4311-L4321)). The server warns that a non-loopback bind has "NO authentication" ([`src/server.js:252`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L252)).

## Outside the guard

<!-- read: docs/AIR_GAPPED.md#What it does NOT guarantee — read this -->
Things `--air-gapped` doesn't cover:
- **The standalone MCP server.** It has no air-gap handling: its arguments are only an index path ([`src/mcp-server.js:49-53`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L49-L53)). It makes no model calls itself, but its output goes to whatever client is attached.
- **Images in chat answers.** The GUI renders `https` image links in model output as `<img>` ([`public/menu-bar.js:182`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/menu-bar.js?plain=1#L182)), and sets no Content-Security-Policy, so a browser fetch could happen outside every guard. Not tested.
- **Saved results**, reconnection, and dependencies: see the doc on what it does not guarantee.

## air-gapped flag, opt-in

Without the flag, nothing here is guarded. `ce --gui` normalizes `--air_gapped` to `--air-gapped` before forwarding it ([`src/index.js:184`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L184)). Run directly, `node src/server.js` matches only the exact spelling `--air-gapped` ([`src/server.js:182`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L182)) and ignores other dashed flags ([`src/server.js:190`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L190)), so `--air_gapped` there is **silently ignored**.

## deletes env keys only

`scrubApiKey` deletes the three environment variables ([`src/core/air-gapped.js:51-55`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/air-gapped.js?plain=1#L51-L55)). Key files are not deleted or blocked, so the guards at each call site are what stop a call.

## startup check

`airGappedStartupCheck` ([`src/core/air-gapped.js:101`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/air-gapped.js?plain=1#L101)).

## API keys

For example, `opts.apiKey || process.env.ANTHROPIC_API_KEY`, blanked when air-gapped ([`src/server.js:354`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L354)).

## API keys, not scrubbed

Key files are listed per provider ([`src/core/providers.js:35`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/providers.js?plain=1#L35)) and aren't touched by `scrubApiKey` ([`src/core/air-gapped.js:51-55`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/air-gapped.js?plain=1#L51-L55)).

## cloud descriptor

`--llm` selects a provider; an unrecognized value is rejected ([`src/core/providers.js:90`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/providers.js?plain=1#L90)).

## names a model

`--model` wins and yields a GGUF descriptor ([`src/core/llm-runner.js:63-68`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L63-L68)).

## path from flags

`args.model || args.claim_model || args.analyze_model` ([`src/core/llm-runner.js:64`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L64)).

## cloud calls

Three callers reach the cloud: the LLM runner ([`src/core/llm-runner.js:215`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L215)), the Chat and Overview runners ([`src/core/chat-runner.js:161`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L161), [`src/core/ai-overview.js:266`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/ai-overview.js?plain=1#L266)), and the GUI server's own client ([`src/server.js:723`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L723)).

## guards each caller

Each caller checks for itself: `assertLocalOnly` in the drafter ([`src/core/llm-runner.js:1030`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L1030)), `isAirGapped()` in the Chat loops ([`src/core/chat-runner.js:205`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/chat-runner.js?plain=1#L205)), in `--ask-ai` ([`src/commands/ask.js:153`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/ask.js?plain=1#L153)) and in the server ([`src/server.js:2805`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L2805)). The reviewer found every network call site guarded by its caller.

## host flag, server.js only

`ce --gui` always passes `--host 127.0.0.1` ([`src/index.js:250`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L250)) and doesn't accept `--host` ([`src/index.js:194`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L194)). The flag only works with `node src/server.js` directly ([`src/server.js:130-131`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L130-L131)).

## refuses non-loopback

Under `--air-gapped`, a non-loopback bind exits ([`src/server.js:247-250`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L247-L250)).

## does not reach

See *Outside the guard*.
