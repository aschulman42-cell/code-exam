# Air-Gapped Operation

CodeExam can run as a **hard no-cloud tool** for source-code review on isolated
machines — e.g. under a source-code protective order in litigation, where the
review computer must have no internet access.

## What `--air-gapped` does

Pass `--air-gapped` (CLI) or `ce --gui --air-gapped` (GUI), and CodeExam makes
**no cloud AI call** for the entire run:

- Every cloud-AI feature — claim/analyze LLM, the chat, and AI Overview — is
  **blocked** before it touches the network; you get a clear message pointing at
  the local alternative.
- `ANTHROPIC_API_KEY` is **scrubbed** from the environment so nothing can
  silently read it.
- At startup CodeExam **probes for connectivity**. If the internet is reachable
  it **refuses to run** (an air-gapped session should be on an isolated machine).
  To run deliberately on a connected machine with cloud calls still blocked, add
  `--allow-connected`.

## You still get AI — locally

`--air-gapped` doesn't disable AI; it disables **cloud** AI. Use a **local model**:

```
ce --overview-by-ai --model path/to/model.gguf --index-path .my_index --air-gapped
```

The local engine (`node-llama-cpp`, GGUF) reads no key and makes no network
request. A localhost LLM endpoint (`CLAIM_SEARCH_API_URL=http://localhost:...`)
is also treated as local and allowed.

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

## Roadmap

A **provable** mode — an attestation record (*"air-gapped active; 0 cloud calls;
connectivity check = no route"*) for the court / opposing counsel — is planned
(#215, #223).
