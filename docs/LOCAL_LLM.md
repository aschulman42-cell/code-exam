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
> and send critiques and requests. The local-model path is **not recommended for
> production use yet** with CodeExam's claim-related features. Read the notes
> below as "here's what's real today," and please tell us where it falls short.

Newer Chinese open-source models that were too large for our standard GPU test
laptop (an RTX 5080 with 16 GB) are covered in
[cloud-gpu-chat-testing.md](cloud-gpu-chat-testing.md).

## Running a local model

Two flags choose the engine:

- **`--model <file.gguf>`** runs a **local** GGUF model in-process.
- **`--llm claude|openai|gemini`** picks a **cloud** provider instead.

Use `--model` with any LLM-based feature:

```bash
# Overview written by a local model
ce --overview-by-ai --model path/to/model.gguf --index-path .my_index

# Analyze a function with a local model
ce --analyze <file@function> --model path/to/model.gguf --index-path .my_index

# Interactive chat over the index, in the GUI, on a local model
ce --gui --model path/to/model.gguf --index-path .my_index
# then chat in lower right pane of GUI
```

In the **GUI** you don't have to choose the model up front: two model pickers —
one at the bottom of the Workspace (lower left) and the other at the top of the
Chat pane — let you load or switch the local model (or pick a cloud engine) while
the server is running, so `--model` at launch is a convenience, not the only way.
More coming soon…

Related flags (local GGUF only unless noted):

- **`--cpu`** — run on the CPU (system RAM) instead of the GPU. Much slower, but
  works without a compatible GPU, and is the right choice on a small/integrated
  GPU: the GPU path recovers automatically from out-of-memory (by backing off),
  but not from other backend failures — a CUDA or driver mismatch, an
  unsupported GPU, or a model the GPU backend can't load — where `--cpu`
  sidesteps the GPU entirely.
- **`--context-size <n>`** — the model's context window (e.g. `16384`); a larger
  window needs more VRAM.
- **`--flash-attention`** — frees VRAM for the KV cache — the Transformer
  key-value cache, which grows with context length (measured saving: 0.5 GB on
  Gemma-3-12B up to 2.3 GB on a 20B model at ctx 16384 — sometimes the difference
  between a model fitting on a 16 GB card and not). Off by default:
  node-llama-cpp flags it experimental, and it can change the numerics —
  attention is computed by a different path, so a run may not match a non-flash
  run bit-for-bit — so turn it on deliberately and keep it on across any runs you
  intend to compare.
- **`--reproducible`** and **`--live-today-date`** — the two determinism knobs;
  see [REPRODUCIBILITY.md](REPRODUCIBILITY.md).
- **`--local-reasoning <on|off>`** — control a *thinking* model's reasoning.
  **Gemma 4 needs `--local-reasoning off`:** it reasons before answering, and
  with reasoning on it spends CodeExam's vocabulary/analysis budget thinking
  before any answer appears — a claim chart comes back `0 of N element(s)
  parsed`. Turning it off also suppresses Gemma 4's thought-channel output.
  Harmless on a non-thinking model (e.g. Gemma 3). On Qwen it sets the model's
  `thoughts` lever to *discourage*, which clears the same budget wall — but Qwen
  still fails CodeExam's verdict contract on claim charts for a separate reason,
  so **Gemma 4 remains the local engine to rely on**. It
  works the same on the `--gui` launch line (`ce --gui … --local-reasoning off`);
  the equivalent is the `CE_DISABLE_LOCAL_REASONING=1` environment variable, handy
  for scripted or wrapper launches (set it before starting CodeExam).

## Getting a model

Local models are GGUF files, downloaded from Hugging Face and pointed at with
`--model`. The general form, using the Hugging Face CLI:

```bash
pip install -U "huggingface_hub[cli]"
hf download <repo>/<model>-GGUF <file>.gguf --local-dir ./models
```

The exact repository and file names for the tested models are below. The byte
sizes are given on purpose: the same quant from different publishers is often a
*different file* (see the QAT trap below), so a size or hash is what disambiguates.

| Model | Hugging Face repo | File | Bytes | Endorsed? |
|---|---|---|---|---|
| Gemma 3 12B (Q4_K_M) — default | `unsloth/gemma-3-12b-it-GGUF` | `gemma-3-12b-it-Q4_K_M.gguf` | 7,300,778,336 | **Y** |
| Gemma 4 12B (Q4_K_M) — newest | `unsloth/gemma-4-12b-it-GGUF` | `gemma-4-12b-it-Q4_K_M.gguf` | 7,121,861,440 | **Y** |
| Gemma 3 12B QAT (Q4_0) | *three publishers — see trap* | *see trap* | ~6.9 GB | **Y\*** |
| Devstral-Small 2505 (Q4_K_M) | `unsloth/Devstral-Small-2505-GGUF` | `Devstral-Small-2505-Q4_K_M.gguf` | 14,333,916,224 | **Y** |
| Qwen3-14B (Q4_K_M) | `Qwen/Qwen3-14B-GGUF` | `Qwen3-14B-Q4_K_M.gguf` | 9,001,752,960 | tested |
| Qwen3.8-27B (UD-Q3_K_XL) | `unsloth/Qwen3.8-27B-GGUF` | `Qwen3.8-27B-UD-Q3_K_XL.gguf` | 13,146,393,504 | testing |
| gpt-oss-20b (MXFP4) | `ggml-org/gpt-oss-20b-GGUF` | `gpt-oss-20b-MXFP4.gguf` | 12,109,566,624 | N |
| Gemma 4 12B **QAT** (UD-Q4_K_XL) | `unsloth/gemma-4-12B-it-qat-GGUF` | `gemma-4-12B-it-qat-UD-Q4_K_XL.gguf` | 6,716,356,800 | **N — broken** |

Download any row with `hf download <repo> <file> --local-dir ./models`.

**Endorsed legend:** **Y** endorsed for CodeExam's mechanical LLM tasks; **Y\***
works with a named limit (the QAT build is reliable but laconic); **tested /
testing** measured, not yet a recommendation (Qwen3.8-27B runs are in progress);
**N** loads but isn't recommended, or is broken.

Gemma 4 12B (Q4_K_M) is the newest qualified engine, added with the
node-llama-cpp 3.22.1 bump — **run it with `--local-reasoning off`** (it's a
thinking model; see Related flags above). Gemma 3-12B stays the default and the
most broadly tested.

A few other GGUFs were loaded during testing but aren't recommended — various
Mistral-Nemo / Llama-3.1 / Muse builds, the 4B Gemma, and the 26B Gemma 4 MoE
(which doesn't fit 16 GB). A larger **24 GB** card opens up Qwen3.5-27B (the
claims-track champion) and others; those runs, on cloud GPUs via RunPod.io, are
written up in [cloud-gpu-chat-testing.md](cloud-gpu-chat-testing.md). The current frontier
open-weight models have moved well past a single 16 GB card — the smallest usable builds of
Kimi K3, GLM-5.3, and DeepSeek V4 run from roughly 80 GB to 600 GB — so testing those is a
rented-cloud-GPU question, not a laptop one; that same doc lays out which are even reachable and
which are blocked by the engine rather than the GPU.

**The QAT Q4_0 trap.** `gemma-3-12b-it-qat-Q4_0` is published by at least three
houses at three different byte sizes — lmstudio-community
(`gemma-3-12B-it-QAT-Q4_0.gguf`, 6,887,164,256), unsloth
(`gemma-3-12b-it-qat-Q4_0.gguf`, 6,909,282,688), and bartowski (6,909,282,976) —
and they are **not** the same file. Any result that cites "gemma-3-12b QAT Q4_0"
without a byte count or hash is ambiguous between the three.

## Which models are supported

The table above is the at-a-glance picture: the specific GGUFs CodeExam has been
run against, where to get each one, and a single **Endorsed?** verdict per model.
Those, and only those, carry a verdict; everything else is untested. Two things
that single verdict can't show, and where they live:

- **The per-feature breakdown.** "Endorsed" collapses several features into one
  word. The full matrix — claim charts vs `--analyze` vs claim search vs chat,
  each marked SUPPORTED / DEGRADED / UNSUPPORTED / UNTESTED with the evidence
  behind every call — is [docs/model-support.md](model-support.md). Read a blank
  cell there as "not measured," never as "fine." It also covers the 24 GB-class
  models that don't appear in the 16 GB table above, such as the **Qwen3.5-27B**
  claims-track champion.
- **The default and the workhorses.** On a 16 GB card, **Gemma 3-12B (Q4_K_M)**
  is the default and the most broadly tested; **Devstral-Small (24B)** is a
  stronger analysis/chat engine where the VRAM allows.

**Anything outside this set is unsupported.** You *can* point `--model` at any
GGUF and CodeExam will try to load it — but an untested model may fail to load
or behave oddly (the Gemma 4 **QAT** `UD-Q4_K_XL` build, for one, produced
unusable output in current testing — the plain Gemma 4 `Q4_K_M` above is the
supported build).

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
- **A small GPU has a floor.** The smallest *tested* model still needs roughly
  **7 GB of VRAM**, so a 4 GB card cannot run any tested model on the GPU at all.
  Use `--cpu` (system RAM, much slower, but it works) or a larger-VRAM machine;
  don't download a 12B GGUF onto a 4 GB card expecting GPU inference.

The reference hardware for CodeExam's local-model measurements is a 16 GB card —
specifically an NVIDIA RTX 5080 (16 GB) in an ASUS ROG Strix SCAR 16 (2025), with
some runs on larger cloud GPUs (RTX 4090, A5000) via RunPod.io (see
[cloud-gpu-chat-testing.md](cloud-gpu-chat-testing.md)). `docs/model-support.md`
notes where a verdict would differ on 24 GB.

## The inference engine (node-llama-cpp), and why its version is pinned

CodeExam runs local models through **node-llama-cpp** — the npm package (a Node
binding around `llama.cpp`) that loads and runs GGUF files; it installs with
`npm install` alongside everything else. CodeExam pins it at **exactly
`3.22.1`**, not an open range, because the bundled `llama.cpp` build decides
inference numerics: an open range could change
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
tested, small or large. Two ways around it:

- **If the code doesn't require an air-gapped exam** (see
  [AIR_GAPPED.md](AIR_GAPPED.md)), a cloud model is simply stronger at this
  open-ended step.
- **Either way — including air-gapped — use CodeExam's guided claim pipeline**
  instead of asking a model to free-form hunt. Here CodeExam's *deterministic*
  code makes the claim→code connection (its retrieval and anchoring find the
  candidate sites); the model is left only the narrower per-element verdict it
  *can* do reliably. Because the connection is deterministic and that verdict
  runs on a local model, the whole pipeline runs on your own GPU — air-gapped.

And the line is expected to move: new local GGUF models are tested as they
appear, and CodeExam keeps improving how it drives the ones it supports.

Reading any local-model output, two habits are worth keeping:

- **Take "untested" literally.** The support matrix marks a feature as working
  only where it's been measured; an unmeasured model/feature pairing is left
  blank, not assumed fine.
- **Trust the numbers, check the sentences.** The counts and flags CodeExam
  prints around a result — how many candidate targets agreed, which claim words
  never appear in the cited code — are computed, not written by the model, so
  they're reliable. What the model itself writes is not — its prose can overstate,
  and a citation can point to the wrong line — so before you rely on a citation,
  open the line it points to.

## Air-gapped operation

For an **enforced** no-cloud run — `--air-gapped` hard-blocks every cloud AI
call, scrubs the API key, and refuses to start on a reachable network — plus what
it does and does **not** guarantee (it cannot police where you save), see
**[AIR_GAPPED.md](AIR_GAPPED.md)**. A local GGUF model is what you run in that
mode.

## Related

- [AIR_GAPPED.md](AIR_GAPPED.md) — the enforced no-cloud posture a local model runs under.
- [cloud-gpu-chat-testing.md](cloud-gpu-chat-testing.md) — running local models on a rented cloud
  GPU, and which frontier models are reachable there.
- [model-support.md](model-support.md) — the per-feature support matrix for each tested model.
- [REPRODUCIBILITY.md](REPRODUCIBILITY.md) — pinning a local run for a repeatable answer.
