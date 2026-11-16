# CodeExam and GPUs: what it runs on, and what has actually been run

CodeExam runs local models in-process through
[node-llama-cpp](https://github.com/withcatai/node-llama-cpp) (pinned at 3.22.1), which
drives llama.cpp. Two kinds of model use it: the **generating** models of
[`LOCAL_LLM.md`](LOCAL_LLM.md) (a GGUF of 7 GB and up, given with `--model`), and the
**embedding** models of `--embed-distance` (150 to 330 MB). Everything else CodeExam does
(indexing, search, call graphs, mechanisms, the detectors) uses no GPU at all.

This page says which GPU backend a run uses, how to choose one, and, separately, what has
been run on what. The two are kept apart on purpose: a backend the library offers is not a
backend CodeExam has been tested on.

## In one paragraph

CodeExam's **generating** models have been run on **NVIDIA cards through CUDA only**.
Its **embedding** models have also been run on an **integrated Intel GPU through Vulkan**,
on one machine, where the vectors agreed with the CPU's and came about three times
faster. As of 2026-11-15, nothing has been run on Apple Silicon, on AMD or Intel Arc cards,
on Linux through Vulkan, or on Arm Windows. A generating model has never been tried on an
integrated GPU.

**Integrated and discrete.** An *integrated* GPU is graphics built into the processor,
with no memory of its own: it borrows system RAM (Intel Iris Xe in the Surface; the 7.9 GB
the runtime reports there is RAM on loan). A *discrete* GPU is a separate chip with its
own dedicated memory, VRAM. The RTX 5080 in the Asus is discrete even though it sits
inside a laptop: its 16 GB belong to it, and CUDA, which only NVIDIA chips have, drives
it. That is why the two machines are different cases and not a fast and a slow version of
one: the generating models were all qualified on dedicated VRAM under CUDA, and nothing
says how one behaves on borrowed RAM under Vulkan.

## Which backend a run uses

The runtime has three GPU backends and the CPU:

| backend | for | CodeExam has run it |
|---|---|---|
| CUDA | NVIDIA cards, with the CUDA 12 runtime | yes: every generating-model result in these docs |
| Vulkan | any GPU whose driver provides Vulkan (Intel, AMD, NVIDIA) | embedding models only, on one Intel integrated GPU |
| Metal | Apple Silicon and Intel Macs | no ([#341](https://github.com/aschulman42-cell/code-exam/issues/341)) |
| CPU | everything | yes |

Left to itself (`--gpu auto`, the default), the runtime takes the first of CUDA, Vulkan,
CPU whose prebuilt binary is installed and loads on the machine. On a laptop with an
NVIDIA card that is CUDA. On a machine with no NVIDIA card and a Vulkan driver it is
Vulkan, which is how a Surface with Intel Iris Xe graphics came to run CodeExam's embedding
models on its GPU without anyone asking it to.

**Nothing is downloaded or built at run time.** Only a backend whose prebuilt binary is
already under `node_modules/@node-llama-cpp/` can be used. `npm install` puts the ones for
the platform there: on Windows x64 the CPU, CUDA and Vulkan builds. (A binary can be built
by hand ahead of time; the recipe is in
[`cloud-gpu-chat-testing.md`](cloud-gpu-chat-testing.md).)

### `--gpu`

```
ce --gpu                      what this machine has: backend in use, device, memory, installed backends
ce … --gpu vulkan             use Vulkan, or stop and say why
ce … --gpu cuda               use CUDA, or stop and say why
ce … --gpu off                use the CPU (the same as --cpu)
ce … --gpu auto               the default
```

- **`--gpu` with no value** prints the backend the runtime would take, the device name,
  its memory (and whether that memory is shared with system RAM), and the prebuilt
  backends installed. It needs no index and loads no model. This is how to tell what a
  machine will do before running anything.
- **A named backend is used or the run stops.** It is never swapped for another. In
  particular the CPU fallback that `auto` takes when a model does not fit on the GPU is
  **not** taken when a backend was named: a run asked to use Vulkan that cannot load its
  model on Vulkan fails and says so.
- **A backend that does not exist on the platform is refused before anything opens**:
  `--gpu metal` on Windows, `--gpu cuda` on Apple Silicon. (The library itself would turn
  these into `auto` without saying so.)
- **A backend with no working binary stops with the reason**: `--gpu cuda` on a machine
  with no NVIDIA card reports that no CUDA build loads there.
- `--cpu` and a named backend together are an error.

A generating run records the backend and the card it actually ran on in its provenance
line, so a chart or an answer produced after a fallback says where it ran.

## What has been run, on what, and when

| GPU | backend | memory | what was run | when |
|---|---|---|---|---|
| NVIDIA RTX 5080 Laptop (asus-CC) | CUDA | 16 GB VRAM | the generating models of [`model-support.md`](model-support.md) | through 2026-11 |
| NVIDIA RTX 4090, RTX A6000, RTX A4000 (rented, RunPod) | CUDA | 24 / 48 / 16 GB VRAM | local chat with Qwen3 models | 2026-07-01 and 07-02; nothing since |
| Intel Iris Xe (a Surface) | Vulkan | 7.9 GB, shared with system RAM | embedding models only | 2026-11-14 and 11-15 |

The RunPod recipe and its session logs are in
[`cloud-gpu-chat-testing.md`](cloud-gpu-chat-testing.md). That page also lists an A5000 and
an A40 in a sizing table, and prices out datacenter cards (H100, H200, B200, B300, MI300X)
for models far larger than any run here; none of those was run.

**Not run at all, as of 2026-11-15**: Apple Silicon or any Mac; AMD or Intel Arc cards; Vulkan on an NVIDIA
card; Vulkan on Linux; Arm Windows; any generating model on an integrated GPU; any GPU with
`--gpu` naming a backend other than on the Surface below.

## The integrated-GPU result, and its limits

What was observed, on one machine (a Surface, Intel Iris Xe, Windows x64, the Vulkan
prebuilt of node-llama-cpp 3.22.1):

- The embedding models load and run on the GPU. The nomic model runs at about 30 short
  texts a second, EmbeddingGemma at about 26.
- **The vectors agree with the CPU's.** 200 texts (19 to 1,258 characters) embedded under
  nomic both ways: for each text, the cosine between its Vulkan vector and its CPU vector
  was at least 0.99968 (mean 0.99987). Over all 39,800 pairs of texts, the similarity
  computed one way and the other differed by 0.001 on average and 0.0055 at most. The
  nearest neighbour of a text was the same for 192 of the 200; the 8 that differ are
  near-ties. So a ranking can change at the fourth decimal place, and a measurement made
  on one backend should not be mixed row by row with one made on another.
- **The GPU was the faster path on that machine**: 17.1 texts a second against 5.8 on the
  CPU, on those 200 texts.
- `--gpu vulkan` gives the same result as `auto` there; `--gpu cuda` stops, since the
  machine has no NVIDIA card; `--gpu metal` is refused.

What this does **not** show, each of which would need its own run:

- **Anything about generating models.** None was tried on this GPU, by decision: the
  smallest tested generating model needs about 7 GB, the GPU's 7.9 GB is system RAM lent
  to it and not VRAM, and the machine has stopped jobs for lack of memory. The VRAM
  figures of [`LOCAL_LLM.md`](LOCAL_LLM.md) are for dedicated VRAM and do not carry over.
- **Any other integrated or non-NVIDIA GPU.** One Intel chip, one driver, one operating
  system. AMD and Intel Arc are untested; so is every Mac.
- **Agreement with CUDA.** Vulkan was compared with the CPU on one machine, not with CUDA.
  The tables of [`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md) dated
  2026-11-14 and 11-15 were computed under Vulkan on this GPU; they were not recomputed
  elsewhere.
- **Long inputs.** Every embedded text is cut at 1,500 characters and the context opened
  at 2,048 tokens.
- **Stability.** The runs were hours long and completed, but no test looked for a driver
  fault or a memory leak.

To be run when the NVIDIA laptop is next available, with the commands as they would be
typed:

```
ce --gpu                                                          # expect cuda and the card's name
ce --embed-distance "<text>" --against "<text>" --gpu vulkan      # Vulkan on an NVIDIA card: does it load, same cosine as cuda?
ce --embed-distance "<text>" --against "<text>" --gpu cuda
ce --ask-ai "<question>" --model <a small GGUF> --gpu vulkan      # a generating model on Vulkan; expect a stop, not a CPU run, if it fails
```

## Memory, briefly

The sizing rules are in [`LOCAL_LLM.md`](LOCAL_LLM.md) and are for dedicated VRAM on CUDA:
the smallest tested generating model needs about 7 GB, so a 4 GB card runs none on the
GPU; a 16 GB card runs the 12B models comfortably and a 24B model with a halved context; a
24 GB card opens the 27B models; `--flash-attention` saves 0.5 to 2.3 GB at a 16,384
context. A model that does not fit falls back to the CPU under `auto`, which is 10 to 100
times slower, and stops under a named backend. Two CodeExam processes on one GPU compete
for its memory, and the second can land on the CPU (#316); the provenance line says which
ran where.

The embedding models are small enough that none of this applies to them.

## Not the same thing: GPU code in the codebase being examined

`--kernels` lists GPU kernels **in the code CodeExam is examining**: CUDA `__global__`
functions and their launches, Triton and numba kernels. It says nothing about the GPU
CodeExam itself runs on, and needs none. See [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).
