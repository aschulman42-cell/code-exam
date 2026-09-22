# Air-Gapped Operation

CodeExam can run as a **hard no-cloud tool** for source-code review on isolated
machines — e.g. under a source-code protective order in litigation, where the
review computer must have no internet access.

## What `--air-gapped` does

Pass `--air-gapped` (CLI) or `ce --gui --air-gapped` (GUI), and CodeExam makes
**no cloud AI call** for the entire run:

- Every cloud-AI feature — the claim/analyze LLM, the chat, and the AI Overview,
  on any cloud engine (**Claude, ChatGPT, or Gemini**) — is **blocked** before it
  touches the network; you get a clear message pointing at the local alternative.
- The cloud **API keys are scrubbed** from the environment — `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, and `GEMINI_API_KEY` — so no provider SDK or call site can
  silently read one even if a guard is ever missed.
- At startup CodeExam **probes for connectivity**. If the internet is reachable
  it **refuses to run** (an air-gapped session should be on an isolated machine).
  To run deliberately on a connected machine with cloud calls still blocked, add
  `--allow-connected`.

Enforcement is two-layer: the keys are scrubbed at startup, and every outbound
cloud-AI call site is guarded immediately before it reaches the network — so a
single missed guard can't leak a call, and a stray key can't re-arm one.

## You still get AI — locally

`--air-gapped` doesn't disable AI; it disables **cloud** AI. Use a **local model** instead — on the
CLI pass `--model <gguf>`, and in the GUI set the engine to **Local** in the Workspace pane's LLM
controls:

```
ce --overview-by-ai --model path/to/model.gguf --index-path .my_index --air-gapped
```

The local engine (`node-llama-cpp`, GGUF) reads no API key and makes no network
request. A localhost LLM endpoint (`CLAIM_SEARCH_API_URL=http://localhost:...`)
is also treated as local and allowed — loopback only, judged on the real parsed
hostname (a lookalike like `localhost.evil.example` does not count).

**A caveat on local models.** A local GGUF is not as capable as a frontier cloud model, and the gap
is widest on **claim-related commands**: a local model is a weak *independent* claim→code navigator,
so on that work the managed claim pipeline (retrieval + `--synonymize`) does the heavy lifting rather
than the model's own reasoning. Which local models work, per feature, and where their limits bite,
is in [`LOCAL_LLM.md`](LOCAL_LLM.md).

## What it does NOT guarantee — read this

`--air-gapped` controls **the one thing CodeExam controls: its own outbound AI
calls.** It does **not** and **cannot** isolate your environment. You remain
responsible for:

- **Where you save.** Saving an overview, catalog, or export to a **network
  drive** or a **cloud-synced folder** (OneDrive, Dropbox, …) moves data off the
  machine — CodeExam can't see or stop that.
- **Reconnection.** A machine that is offline now but **reconnects later** can
  sync anything written in the meantime.
- **The connectivity probe is not authoritative.** A clean result does **not**
  prove the machine is isolated; it only catches the obvious case of a live
  network.

In a protective-order setting the producing party is responsible for the
isolated environment; `--air-gapped` is CodeExam doing *its* part (and flagging a
reachable network), not a substitute for that isolation.

## Saving results

CodeExam has several ways to save what it produces — the GUI's pane / overview
**Save** (disk) buttons, chat saves, and CLI redirection (`> out.txt`, or writing
a catalog / extract to a path). **`--air-gapped` does not constrain where those
go.** A save target that is a network drive, a OneDrive / Dropbox-synced folder,
or any path that later syncs will move the data off the machine. Save to a known
**local, non-synced** directory, and treat the destination as your
responsibility — not CodeExam's.

## Planned improvements

A **provable** mode — an attestation record (*"air-gapped active; 0 cloud calls;
connectivity check = no route"*) for the court / opposing counsel — is a natural next step. The
related piece already in progress is the **provenance header** on CE-generated outputs (version,
source, and AI-engine details), #215.

## Related

- [`LOCAL_LLM.md`](LOCAL_LLM.md) — running the local GGUF models that make air-gapped AI possible.
- [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md) — the optional AI features `--air-gapped` gates.
- [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) — `--reproducible` and the provenance header.
- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — claim work under a protective order.
- [`GETTING_STARTED.md`](GETTING_STARTED.md) — installing and running CodeExam.
