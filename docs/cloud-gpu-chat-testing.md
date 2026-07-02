# Testing CE Chat on a Cloud GPU (RunPod)

**Purpose**: run CodeExam's chat-over-codebase with a **local GGUF model + CE's
tools on a rented cloud GPU**, using a model class (14B–32B) that a CPU-only
laptop can't drive. The question this answers: does a bigger model do
*forensic-grade agentic grounding* — chaining `search` → `extract` to actually
read code — where a 4B-on-CPU cribbed tool descriptions and emitted garbage
tool args?

**Status**: first pass 2026-07-01; corrected the same day from the first real
run (RunPod RTX 4090 — see *First-run findings* below). Still a living doc —
fold further on-box corrections back in here.

---

## Constraints that shape the recipe

- CE loads the GGUF **in-process** via node-llama-cpp (`^3.18.1`), so **CE must
  run *on* the GPU box** — you can't point a local CE at a remote GPU.
- **No code changes are needed for GPU.** `src/server.js` loads the model via
  `getLlama()` + `llama.loadModel({ modelPath })`; node-llama-cpp v3
  auto-detects CUDA and offloads as many layers as fit in VRAM. The same code
  that runs on CPU lights up the GPU.
- A cloud GPU is **not air-gapped**. Index **CE's own source or a public repo —
  never client / protected material.** This validates the tech and the
  model-capability question, not the air-gap posture.
- CE needs **Node ≥ 18**; the GUI chat pane has an **Engine → Local GGUF**
  selector.
- CE tries context sizes **8192 → 4096 → 2048** at load. Agentic loops with
  large tool results want the top end, so pick VRAM that holds an 8k context
  alongside the weights.

## RunPod vs Vast.ai

- **RunPod (use this for the first run)**: cleaner console, ready CUDA
  templates, per-second billing, and an HTTP port proxy that gives a public
  URL — no SSH tunnel needed to reach the GUI.
- **Vast.ai**: cheaper (community/spot) but rougher UX and variable
  reliability. Worth it later when optimizing cost, not for the first test.

## GPU / model sizing

| VRAM | Card examples | Comfortable model | Copy-paste pick |
|---|---|---|---|
| 24 GB | RTX 4090, A5000 | 14B at Q4/Q5; 32B Q4 is tight (~19 GB) | `Qwen3-14B` Q5_K_M (~9.8 GB) — **validated** |
| 48 GB | A40, A6000 | **32B at Q5/Q6 — the sweet spot** | `Qwen3-32B` Q5_K_M (untested here) |
| 80 GB | A100 | 70B at Q4/Q5 | — |

**Stay in the Qwen3 family.** node-llama-cpp resolves Qwen3 GGUFs to its
`Qwen` chat wrapper and native tool calls flow correctly — validated
end-to-end in the first run. Qwen2.5-Coder-14B-Instruct, despite its coding
reputation, never emitted a native tool call in our run: it wrote the call as
a JSON block in its prose instead, so zero tools executed.

---

## Step 1 — create the pod (you, in the RunPod console)

One-time prep:

1. Account at [runpod.io](https://www.runpod.io); add credits ($10 covers many
   hours of testing).
2. **Add your SSH public key before creating the pod**: Settings → **SSH Public
   Keys** → paste the contents of `~/.ssh/id_ed25519.pub` (generate with
   `ssh-keygen -t ed25519` if you don't have one). RunPod injects it into every
   pod you create; without it there is no SSH access.

Then deploy:

3. **Deploy → Pods** → pick the GPU: **A40 (48 GB)** for the real test, or
   **RTX 4090 (24 GB)** to validate cheaply with a 14B.
4. **Template**: an official CUDA 12.x base — e.g. *RunPod PyTorch 2.x* (Ubuntu
   22.04 + CUDA 12). The CUDA version matters: node-llama-cpp's prebuilt GPU
   binaries target CUDA 12.
5. **Edit the deployment before launching**:
   - Container disk: **≥ 60 GB** (a 32B GGUF alone is ~23 GB).
   - Exposed HTTP ports: **8080** (the CE GUI).
   - Exposed TCP ports: **22** (direct SSH — supports non-interactive command
     execution, scp, and port-forwarding; the `ssh.runpod.io` proxy is
     terminal-only and is the fallback, not the plan).
6. Deploy, wait for *Running*, then open the pod's **Connect** panel and copy
   the **SSH over exposed TCP** command. It looks like:

   ```
   ssh root@157.x.x.x -p 12345 -i ~/.ssh/id_ed25519
   ```

That connection string is everything an agent (or you) needs for Step 2. If
you're working with an AI agent, paste it the string and let it drive the rest
over SSH. (A private repo adds one wrinkle: don't put GitHub credentials on
the pod — `git archive --format=tar.gz HEAD` locally and `scp` the tarball up
instead of cloning.)

## Step 2 — on-box setup (agent-drivable over SSH)

Run these on the pod, in order. The GPU smoke test comes **before** the 20+ GB
model download on purpose — it front-loads the one genuinely risky step.

```bash
# 1. Node ≥ 18 (PyTorch templates usually ship without Node)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
node -v

# 2. Clone + install CE (node-llama-cpp v3 fetches its CUDA prebuilt binary)
git clone https://github.com/aschulman42-cell/code-exam && cd code-exam
npm install

# 3. GPU SMOKE TEST — do this before downloading anything large.
#    Expect a CUDA section listing the GPU and its VRAM.
npx --yes node-llama-cpp inspect gpu

# 3b. Only if the smoke test shows no CUDA: build the binding from source
#     (needs cmake; takes 10-20+ min), then re-run the smoke test.
npx --yes node-llama-cpp source download --gpu cuda

# 4. Download the GGUF. The command is `hf` — recent huggingface_hub
#    REMOVED the old `huggingface-cli` entry point.
pip install -U "huggingface_hub[cli]"
hf download unsloth/Qwen3-14B-GGUF Qwen3-14B-Q5_K_M.gguf --local-dir ./models

# 5. Index NON-SENSITIVE code — CE's own source is ideal
node src/index.js --build-index .

# 6. Launch the GUI bound to all interfaces, inside tmux so it survives
#    SSH disconnects
tmux new -d -s ce "node src/index.js --gui --host 0.0.0.0 --port 8080 \
  --model-path ./models/Qwen3-14B-Q5_K_M.gguf \
  --index-path .code_search_index"
```

Watch the server log (`tmux attach -t ce`) for the model-load line — it reports
the context size that stuck (want 8192).

## Step 3 — chat

Open RunPod's proxy URL for the exposed HTTP port:

```
https://<pod-id>-8080.proxy.runpod.net
```

In the chat pane set **Engine → Local GGUF** and ask something that requires
reading code, e.g. *"explain how doMultisect works"*. (Binding to a
non-localhost interface auto-enables CE's file-path safety validator —
expected and harmless here.)

## What to look for

- **Tool competence**: sane arguments, right targets — vs the 4B baseline of
  cribbing answers from tool *descriptions* and emitting garbage args like
  `max: 5e15`.
- **Chaining**: does it `search` to find candidates, then `extract` to read
  the actual code before answering?
- **Silent CPU fallback**: if the CUDA binding failed, node-llama-cpp falls
  back to CPU *without an error* — the tell is laptop-class tokens/sec. The
  Step 2 smoke test and the load log are the guards.
- **Latency**: tokens/sec on GPU, and wall-clock for a full agentic loop.

## First-run findings (2026-07-01, RunPod RTX 4090 24 GB)

What the recipe above already incorporates, plus results:

- **CUDA prebuilts just worked** (`b8390` binaries; no source build). Model
  load: 2.4 s from local NVMe; Qwen3-14B Q5_K_M fully offloaded at 12.1 GB
  VRAM with the full 8192-token context.
- **`huggingface-cli` is gone** in current huggingface_hub — the command is
  `hf`.
- **Headless crash (found here, fixed in `src/index.js`)**: the GUI's
  browser-open attempt (`xdg-open`) died as an unhandled async spawn error on
  boxes without it, killing the server ~1.5 s after startup. Current builds
  attach an `error` handler to the browser-open child and survive; on a
  checkout predating the fix, `apt-get install -y xdg-utils` is the
  workaround.
- **The headline: tool-count overload, not raw model capability.** With all
  26 CE tools exposed, Qwen3-14B degraded to the same failure modes seen from
  the 4B on CPU: cribbing tool descriptions, garbage numeric args
  (`max: 5e15`), sometimes zero tool calls. Bisecting the tool set (same
  model, same question): 2 tools → clean `search` → `extract` chaining with
  sane args; ~8 tools → still chains; 14+ tools → garbage args; 26 → calls
  often stop entirely. With a curated 8-tool core, the real loop chained
  `search` → `extract` and produced a grounded, correct explanation of a real
  function in ~19 s — naming actual identifiers from the extracted source and
  flagging what it hadn't read.
- **Numeric garbage args persist mildly** even at 8 tools (`max: 1e15`) —
  server-side arg clamping is complementary, not redundant.
- First local-engine message triggers the (lazy) model load — a few seconds
  on NVMe. `POST /api/switch-model {"path": "<gguf>"}` pre-warms it eagerly.

## Cross-model matrix (2026-07-01/02: RTX 4090 24 GB, RTX A6000 48 GB, RTX A4000 16 GB)

Benchmark: Q1 = *"explain how doMultisect works"*; Q2 = *"How does this
codebase identify AI/ML pipelines? Read the actual detector code…"* — all
Qwen3 family, all with full 8192 context.

| Model (quant) / GPU | Tools | Behavior | Args | Wall Q1/Q2 |
|---|---|---|---|---|
| 8B (Q5) / A4000 | all 26 | Q1: **0 calls, cribbed**; Q2: 3 calls, wrong targets (extracted a regex constant) | garbage | 15 s / 78 s |
| 8B (Q5) / A4000 | curated 8 | Q1: 3 calls, near-target (sibling function, hedged honestly); Q2: **5 calls**, grounded | sane | 37 s / 81 s |
| 14B (Q5) / 4090 | all 26 | degrades to crib/no-calls (bisect) | garbage (`5e15`) | — |
| 14B (Q5) / 4090 | curated 8 | chains `search`→`extract`, grounded | one `1e15` | 19 s (Q1) |
| 32B (Q4) / 4090 | curated 8 | Q1: clean 2-call chain; Q2: **7-call investigation** (4 searches → `list_functions` → 2 extracts of the real detectors) | **pristine** (`max:10`) | 29 s / 87 s |
| 32B (Q4) / 4090 | all 26 | still chains; Q2 efficient targeted `show_file` of the right file; cites line numbers | garbage `max` | 45 s / 58 s |
| 32B (Q4) / A6000 | all 26 | chains; Q2 `show_file` scoped to **lines 1146–1202** of the detector file | garbage `max` | 61 s / 114 s |

Conclusions:

- **The tool-count collapse is model-size-dependent.** 8B and 14B *need* the
  curated menu to function at all; 32B survives all 26 tools without
  collapsing — but its arg quality still degrades (garbage `max` reappears),
  so curation helps at every size and clamping (arg sanitization) is
  justified at every size.
- **VRAM fit points**: 8B Q5 + 8k context = **7.3 GB** (fits an 8 GB laptop
  GPU, barely — a laptop OS also taxes VRAM, so 4096 context may be the
  realistic laptop setting). 32B Q4 + 8k = ~22 GB (24 GB card, no fallback
  needed). 32B Q5 needs a 48 GB card.
- **Laptop (RTX 4070 Laptop 8 GB) estimate**: A4000 numbers × ~1.75
  (bandwidth ratio 448→256 GB/s) → with 8B curated: ~1 min simple, ~2.5 min
  multi-step. The 14B-spilling-to-CPU experience can't be simulated in the
  cloud — retest on real hardware.
- **Network-volume caveat**: model load from a RunPod network volume took
  31 s vs 3.4 s from local NVMe (mmap page-in). Default volume quota
  (~20 GB) won't hold a 32B Q5 GGUF (23 GB) — size the volume up front or
  use the container disk.

## Cost and teardown

- Ballpark (verify current rates): 24 GB ~$0.3–0.7/hr, 48 GB ~$0.8/hr, 80 GB
  A100 ~$1.6–2.5/hr. A few hours of testing is single-digit dollars.
- **Stop or terminate the pod when done** — billing is per-second while it
  runs. *Stop* keeps the container disk (and its downloaded model) for a
  restart at storage-only rates; *Terminate* wipes everything. For a one-shot
  test, terminate; if you expect to come back across days, stop instead —
  re-downloading 23 GB is the main cost of terminating early.
