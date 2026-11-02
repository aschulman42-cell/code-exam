# Configuration and environment: detail

Click-through detail for 06-configuration.mmd. Facts are as of commit `98abef1` (2026-11-02).
Solid arrows are what the code does on its own; dashed arrows happen only if a
person or agent does them.

## Command-line flags

The declarative table in `src/argparse.js`, for example [`src/argparse.js:475`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/argparse.js?plain=1#L475). Defaults include `index_path: '.code_search_index'` ([`src/argparse.js:136`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/argparse.js?plain=1#L136)).

## Environment and key files

Each provider names its env var, flag and key files ([`src/core/providers.js:31-37`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/providers.js?plain=1#L31-L37)). Other variables seen in the code include `CE_OPENAI_API_URL` ([`src/server.js:469`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L469)) and `CE_LOCAL_CHAT_TOOLS` ([`src/core/local-chat-tools.js:1`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/local-chat-tools.js?plain=1#L1)).

## Provider registry

`PROVIDERS` ([`src/core/providers.js:31`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/providers.js?plain=1#L31)), with `DEFAULT_PROVIDER = 'claude'` ([`src/core/providers.js:62`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/providers.js?plain=1#L62)) and a resolver ([`src/core/providers.js:90`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/providers.js?plain=1#L90)).

## Local GGUF model

`ggufDescriptor` ([`src/core/llm-runner.js:52`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L52)). A loaded chat sequence is reused across calls, and all local work is serialized ([`src/server.js:296`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L296), [`src/server.js:616-617`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L616-L617)). CodeExam does not download a llama.cpp binary at run time ([`src/core/llm-runner.js:814`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L814)).

## LLM runner

`src/core/llm-runner.js`: `resolveModel` ([`src/core/llm-runner.js:63`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L63)), `draftCloud` ([`src/core/llm-runner.js:215`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L215)), and `describeEngine`, which states "local LLM, no network egress" or "cloud LLM" on the artifact ([`src/core/llm-runner.js:97-107`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L97-L107)).

## Cloud endpoints

Each provider declares `egressHosts` ([`src/core/providers.js:37`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/providers.js?plain=1#L37)), and `allProviderEgressHosts` collects them ([`src/core/providers.js:105`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/providers.js?plain=1#L105)).

## Air-gapped guard

`setAirGapped`, `scrubApiKey` and the startup check run together ([`src/index.js:391-397`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L391-L397)). "Enforcement is two-layer" ([`docs/AIR_GAPPED.md:25-27`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/AIR_GAPPED.md?plain=1#L25-L27)).

## GUI bind address

`127.0.0.1` by default ([`src/server.js:103`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L103)). On loopback, a Host-header check defends against DNS rebinding ([`src/server.js:4311-4321`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L4311-L4321)). The server warns that a non-loopback bind has "NO authentication" ([`src/server.js:252`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L252)).

## names a model

`--model` wins and yields a GGUF descriptor ([`src/core/llm-runner.js:63-68`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L63-L68)).

## supplies API keys

For example, `opts.apiKey || process.env.ANTHROPIC_API_KEY`, blanked when air-gapped ([`src/server.js:354`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L354)).

## cloud descriptor

`--llm` selects a provider, and "an unrecognized value is rejected" ([`src/argparse.js:1608-1611`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/argparse.js?plain=1#L1608-L1611)).

## path from flags

`args.model || args.claim_model || args.analyze_model` ([`src/core/llm-runner.js:64`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L64)).

## cloud calls

`draftCloud` ([`src/core/llm-runner.js:215`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L215)), with usage tracked for the cost report ([`src/core/llm-runner.js:292`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L292)).

## blocks before the network

`assertLocalOnly(feature)` throws before the call ([`src/core/air-gapped.js:37-45`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/air-gapped.js?plain=1#L37-L45)).

## deletes keys

`scrubApiKey` deletes all three variables ([`src/core/air-gapped.js:51-55`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/air-gapped.js?plain=1#L51-L55)).

## host flag

`--host` ([`src/server.js:130-131`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L130-L131)).

## refuses non-loopback

Under `--air-gapped` a non-loopback bind exits ([`src/server.js:247-250`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L247-L250)).
