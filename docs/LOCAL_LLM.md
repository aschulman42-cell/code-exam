# Local LLMs in CodeExam

CodeExam's LLM-assisted features can run against a **local GGUF model** on your
own GPU — no cloud API, no network. The same Overview-by-AI, `--analyze`, claim
search, and interactive chat you'd otherwise run against a cloud LLM like
**Claude, ChatGPT, or Gemini**, driven instead by a model file on disk. This is
what makes an air-gapped examination possible (see [AIR_GAPPED.md](AIR_GAPPED.md)
for the enforced no-cloud posture). It is optional, and for most users the cloud
path is more capable — but "local first" is a deliberate design basis: local
models and GPU machines keep getting more useful, and confidential code often
*cannot* leave a protected machine.

> **CodeExam 0.5.x is a work in progress.** It's published so people can try it
> and send critiques and requests — it is **not recommended for production use
> yet**, and the local-model path is the least mature part of it. Read the notes
> below as "here's what's real today," and please tell us where it falls short.

## Running a local model

Two flags choose the engine, and they're easy to confuse:

- **`--model <file.gguf>`** runs a **local** GGUF model in-process.
- **`--llm claude|openai|gemini`** picks a **cloud** provider instead.

Pass `--model` to any LLM-based feature:

```bash
# Overview written by a local model
ce --overview-by-ai --model path/to/model.gguf --index-path .my_index

# Analyze a function with a local model
ce --analyze <file@function> --model path/to/model.gguf --index-path .my_index

# Interactive chat over the index, in the GUI, on a local model
ce --gui --model path/to/model.gguf --index-path .my_index
```

In the **GUI** you don't have to choose the model up front: a model picker lets
you load or switch the local model (or pick a cloud engine) while the server is
running, so `--model` at launch is a convenience, not the only way.

Related flags (local GGUF only unless noted):

- **`--cpu`** — run on the CPU (system RAM) instead of the GPU. Much slower, but
  works without a compatible GPU, and is the right choice on a small/integrated
  GPU: the GPU path only recovers from out-of-memory, not from other backend
  failures.
- **`--context-size <n>`** — the model's context window (e.g. `16384`); a larger
  window needs more VRAM.
- **`--flash-attention`** — frees VRAM for the KV cache (measured 0.5 GB on
  Gemma-3-12B up to 2.3 GB on a 20B model at ctx 16384 — sometimes the difference
  between a model fitting on a 16 GB card and not). Off by default:
  node-llama-cpp flags it experimental and it can change numerics, so turn it on
  deliberately and keep it on across any runs you intend to compare.
- **`--reproducible`** and **`--live-today-date`** — the two determinism knobs;
  see [REPRODUCIBILITY.md](REPRODUCIBILITY.md).

## Getting a model

Local models are GGUF files, downloaded from Hugging Face and pointed at with
`--model`. The general form, using the Hugging Face CLI:

```bash
pip install -U "huggingface_hub[cli]"
hf download <repo>/<model>-GGUF <file>.gguf --local-dir ./models
```

The exact repository and file names for the tested models — **Gemma3-12B
Q4_K_M** first — are here:
[[GGUF_DOWNLOAD_SOURCES — placeholder, to be filled from the Asus test set]].

## Which models are supported

CodeExam has been measured against a specific, small set of GGUFs. Those, and
only those, carry a support verdict; everything else is untested. The tested
models:

- **Gemma3-12B (Q4_K_M)** — the 16 GB workhorse and the default local model,
  and the most broadly tested.
- **Devstral-Small (24B)** — a stronger analysis and chat engine where the VRAM
  allows (measured at ctx 8192), slower than the 12B.
- **Qwen3.5-27B** — the 24 GB / 24k-context champion on the claims track.
- **Gemma3-12B QAT**, **Qwen3.5-9B**, **Qwen3-14B** — partially measured, each
  with named limits.

The per-feature verdict for each of these — SUPPORTED / DEGRADED / UNSUPPORTED /
UNTESTED, with the evidence behind every call — is the matrix in
[docs/model-support.md](model-support.md). Read a blank cell there as "not
measured," never as "fine."

**Anything outside this set is unsupported.** You *can* point `--model` at any
GGUF and CodeExam will try to load it — but an untested model may fail to load
or behave oddly (a newer Gemma release did not load cleanly in current testing).

> **[[placeholder for blocking certain GGUFs]] — not yet implemented.**
> CodeExam does **not** currently block, warn on, or otherwise gate an
> unrecognized model file: every GGUF is accepted, and an unsupported one simply
> fails at load time. If CodeExam later restricts `--model` to a known-good set
> — rejecting a GGUF known to fail or misbehave, with an override flag such as
> `--allow-blocked-gguf` — this is where that behavior and its opt-out get
> documented.

## Hardware realities

Local inference is bounded by VRAM and memory bandwidth, and the consequences are
worth knowing before you choose a model (learned the hard way):

- **One model is resident in VRAM at a time**, and it stays there until the
  process exits — closing a GUI tab does not free it. A second CodeExam process
  falls back to CPU (10–100× slower) with only a generic out-of-memory message.
  Size your VRAM for one model, not for concurrent sessions.
- **Model size sets the floor.** A 12B model at Q4_K_M is ~7 GB; a 24B model is
  ~13 GB. On a 16 GB card the smaller model leaves room for a full context; the
  larger one does not, and the context is halved or layers spill to CPU.
- **Speed is bandwidth-bound.** GPU decode scales with bytes-per-token, so a 24B
  model is roughly **2× slower** than a 12B on any hardware; on a 16 GB card,
  context-halving, partial offload, and KV-cache pressure add up to a further
  **~4×**. On a 24 GB card the inherent 2× remains and the rest shrinks.

The reference hardware for CodeExam's local-model measurements is a 16 GB card;
`docs/model-support.md` notes where a verdict would differ on 24 GB.

## The engine, and why it's pinned

CodeExam runs local models through **node-llama-cpp** — the npm package (a Node
binding around `llama.cpp`) that loads and runs GGUF files; it installs with
`npm install` alongside everything else. CodeExam pins it at **exactly
`3.18.1`** (bundling `llama.cpp` build `b8390`), not an open range, because the
bundled `llama.cpp` build decides inference numerics: an open range could change
the engine underneath a result with no CodeExam change at all. That pin is what
makes a local run reproducible in the first place (next section).

## Pinning a run for a repeatable answer

By default a local model's answers vary run to run — sampling is on, which is
useful for exploration. When you need a run you can repeat, `--reproducible`
pins it. Here local has an advantage the cloud can't match: **a local model can
be pinned to a bit-for-bit repeatable answer; a cloud model cannot.** The full
story — both determinism knobs, the cloud contrast, and how to demonstrate
reproducibility for the record — is in [REPRODUCIBILITY.md](REPRODUCIBILITY.md).

## What to rely on it for — and what to use the cloud for

A local model is dependable for CodeExam's mechanical LLM tasks: claim charts,
`--analyze`, claim search, `--synonymize`, and pseudo-claim generation. For
charts, Gemma3-12B (Q4_K_M) is the safe default on a 16 GB card; with 24 GB,
Qwen3.5-27B is stronger. Which model does what, and the evidence behind each
call, is in [docs/model-support.md](model-support.md).

Where a local model falls short is open-ended judgment. Hand it a patent claim
and ask it to *find* the code that embodies it, on its own, and it usually fails
— not because it can't search, but because it can't reliably connect the claim's
wording ("first-come/first-served") to the code's ("FIFO scheduler"). That is a
limit of the model's judgment *today*, and it showed up in every local model
tested, small or large. For now, for that kind of work, use a cloud model — or
CodeExam's guided claim pipeline, which makes that connection *for* the model
instead of asking the model to make it. And the line is expected to move: new
local GGUF models are tested as they appear, and CodeExam keeps improving how it
drives the ones it supports.

Reading any local-model output, two habits are worth keeping:

- **Take "untested" literally.** The support matrix marks a feature as working
  only where it's been measured; an unmeasured model/feature pairing is left
  blank, not assumed fine.
- **Trust the numbers, check the sentences.** The counts and flags CodeExam
  prints around a result — how many candidate targets agreed, which claim words
  never appear in the cited code — are computed, not written by the model, so
  they're reliable. The model's prose is not always: before you rely on a
  citation, open the line it points to.

## Air-gapped operation

For an **enforced** no-cloud run — `--air-gapped` hard-blocks every cloud AI
call, scrubs the API key, and refuses to start on a reachable network — plus what
it does and does **not** guarantee (it cannot police where you save), see
**[AIR_GAPPED.md](AIR_GAPPED.md)**. A local GGUF model is what you run in that
mode.
