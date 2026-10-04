# Running CodeExam's local-model chat on a cloud GPU (RunPod)

**Purpose**: run CodeExam's chat-over-codebase with a **local GGUF model + CodeExam's
tools on a rented cloud GPU**, using a model class (14B–32B) that a CPU-only
laptop can't drive. The question this answers: does a bigger model do
*forensic-grade agentic grounding* — chaining `search` → `extract` to actually
read code — where a 4B-on-CPU cribbed tool descriptions and emitted garbage
tool args?

**Status**: a hands-on recipe, last measured 2026-07-02 on RunPod (RTX 4090,
A6000, A4000). The results sections below are dated session logs — the software
versions and hardware named in them are what was current for that run, not
necessarily today's.

---

## Constraints that shape the recipe

- CodeExam loads the GGUF **in-process** via node-llama-cpp (pinned at `3.22.1`), so
  **CodeExam must run *on* the GPU box** — you can't point a local CodeExam at a remote GPU.
- **No code changes are needed for GPU.** `src/server.js` loads the model via
  `getLlama()` + `llama.loadModel({ modelPath })`; node-llama-cpp v3
  auto-detects CUDA and offloads as many layers as fit in VRAM. The same code
  that runs on CPU lights up the GPU.
- A cloud GPU is **not air-gapped**. Index **CodeExam's own source or a public repo —
  never client / protected material.** This validates the tech and the
  model-capability question, not the air-gap posture.
- CodeExam needs **Node ≥ 18**; the GUI chat pane has an **Engine → Local GGUF**
  selector.
- CodeExam tries context sizes **8192 → 4096 → 2048** at load. Agentic loops with
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

**Context sizing**: CodeExam defaults to an 8192→4096→2048 fallback ladder, but
agentic multi-tool investigations want **16k+** — strong models (Qwen3.5
class) run 10-20-call investigations whose accumulated tool results overflow
8k and error out. Pass `--context-size 16384` (or 24576) when VRAM allows: a
27B Q4 plus 24k context measured 17.9 GB on a 24 GB card. The ladder still
falls back to smaller rungs if allocation fails, so the flag is safe to
over-ask.

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
   - Exposed HTTP ports: **8080** (the CodeExam GUI).
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
over SSH. (Working from a private fork, or would rather not put GitHub
credentials on the pod? Skip the clone and `scp` a tarball up instead — see the
note in Step 2.)

## Step 2 — on-box setup (agent-drivable over SSH)

Run these on the pod, in order. The GPU smoke test comes **before** the 20+ GB
model download on purpose — it front-loads the one genuinely risky step.

```bash
# 1. Node ≥ 18 (PyTorch templates usually ship without Node)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
node -v

# 2. Get CodeExam onto the pod + install (node-llama-cpp v3 fetches its CUDA
#    prebuilt binary). From the public repo, just clone it (below). From a
#    private fork — or if you'd rather keep GitHub credentials off the pod —
#    copy a tarball up instead: locally `git archive --format=tar.gz -o /tmp/ce.tar.gz HEAD`,
#    `scp -P <port> -i ~/.ssh/id_ed25519 /tmp/ce.tar.gz root@<ip>:/root/`, then on
#    the pod `mkdir -p code-exam && tar -xzf /root/ce.tar.gz -C code-exam`.
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

# 5. Index NON-SENSITIVE code — CodeExam's own source is ideal
node src/index.js --build-index .

# 6. Launch the GUI bound to all interfaces, inside tmux so it survives SSH
#    disconnects. Use src/server.js directly, NOT `--gui`: the `ce --gui`
#    launcher hardcodes 127.0.0.1 and REJECTS --host ("Unknown option '--host'"),
#    and it also tries to open a browser (pointless on a headless pod).
#    server.js IS the GUI server and honors --host.
tmux new -d -s ce "node src/server.js --host 0.0.0.0 --port 8080 \
  --model-path ./models/Qwen3-14B-Q5_K_M.gguf \
  --index-path .code_search_index --context-size 16384"
```

Watch the server log (`tmux attach -t ce`) for the model-load line — it reports
the context size that stuck (want 8192).

## Step 3 — chat

Reach the GUI one of two ways:

- **RunPod HTTP proxy** — `https://<pod-id>-8080.proxy.runpod.net`. Two quirks:
  it has a **cold start** (the first request, often the root `/`, can 404 or
  stall ~30 s while the route warms up — reload), and the URL is
  **unauthenticated** — anyone with it drives the server, which is why you index
  only non-sensitive code (above).
- **SSH tunnel** (private, reliable) — from your laptop
  `ssh -L 8080:localhost:8080 root@<ip> -p <port> -i ~/.ssh/id_ed25519`, then open
  `http://localhost:8080`. Bypasses the proxy, is authenticated by SSH, and needs
  no `--host 0.0.0.0` (you can bind loopback on the pod if you only ever tunnel).

In the chat pane set **Engine → Local GGUF** and ask something that requires
reading code, e.g. *"explain how multisect works"*. (A non-localhost bind
intentionally skips CodeExam's loopback Host-header check — the exposure is deliberate
— while enabling the file-path safety validator; both expected here.)

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
  26 CodeExam tools exposed, Qwen3-14B degraded to the same failure modes seen from
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

## Cross-family matrix (2026-07-02, RTX 4090 24 GB)

Same battery extended to non-Qwen families, plus a second, unfamiliar
codebase: Q1 = doMultisect (CodeExam's own index); Q2/Q3 = survey and
RL-role questions against `.sr_gh`, a 1,490-file index of several public
security-research repos. All curated-8, grounded mode, 8k context.

**The gating factor is chat-template/wrapper compatibility, not model
quality.** CodeExam's local chat exposes tools through node-llama-cpp's
function-calling channel, which only exists if the GGUF's chat template
resolves to a wrapper with function support. Probe before judging a model
(one-liner: load the model, print `session.chatWrapper.wrapperName`):

| Model (quant) | Wrapper resolved | Native tool calls | Behavior |
|---|---|---|---|
| Llama 3.1 8B (Q5) | `Llama 3.1` | **reliable** | Sane args every time, very fast (3–6 s/question, no thinking phase). Weak comprehension: hallucinated a `do_multisect.py`, ran `callers()` on "Bloom" as if it were a function. |
| GLM-4-9B-0414 (Q5) | `JinjaTemplate` (generic) | **never** | Narrates intended calls as prose (`extract {"function_name": ...}`) and then **fabricates the result**, including invented source code. |
| Mistral Small 3.2 24B (Q4) | `JinjaTemplate` (generic) | **never** | "Please hold on a moment…" then stops, or invents search results (`src/main.py` — no such file). Not model weakness — the Mistral wrapper simply wasn't resolved for this GGUF's template. |
| Gemma 3 27B (Q4) | `Gemma` | **flaky** | On a fresh context: clean `extract(doMultisect)` → correct grounded answer; a 4-call chain on the RL question (40 s). But once emitted the call as prose with a fabricated `overview` result, and its chats leak the context sequence (see below). |

Conclusions:

- **Stay in the Qwen3 family** — it remains the only family tested where
  tool calls are both reliable and well-aimed at every size tier.
- **The failure mode of an incompatible family is fabrication, not
  refusal.** A model with no function channel doesn't say "I can't run
  tools" — it invents tool output that looks real. For a forensic tool
  this is the worst possible failure shape; it argues for CodeExam detecting
  wrapper support at model load and warning (or refusing local chat).
- **Possible CodeExam-side remedy** for GLM/Mistral-class failures: pass an
  explicit family-appropriate `chatWrapper` to node-llama-cpp instead of
  relying on auto-resolution. Untested; future work.
- Gemma chats exposed a bug (since fixed) — the context's single sequence
  leaked and subsequent chats failed with "No sequences left" until the model
  was reloaded; the post-fix re-test below shows it resolved.
- Cloud-bar honesty: against Claude transcripts of the same `.sr_gh`
  questions (30+ tool calls, multi-project synthesis), every local model
  tested is several tiers below — the locals make 1–4 calls and survey a
  fraction of the evidence before answering.

## Qwen3.5 generational update + Gemma re-test (2026-07-02)

Later the same day, two more result sets — run on node-llama-cpp 3.19.0
with the full fix stack from this arc committed (curated tool core, Gemma
system-prompt fold, sequence-reuse, `--context-size`, tool budget + dedup).

**Qwen3.5-27B (Q4_K_M, RTX 4090 24 GB)** — a generational leap, not an
increment. Its investigations are recognizably Claude-shaped:

- doMultisect (16k ctx): **10 calls** — extract of the target *and its
  callees*, then reading the entire core file in sequential chunks —
  ending in a line-cited answer (`src/commands/multisect.js:747-793`).
  The best local answer recorded in this doc.
- `.sr_gh` survey (24k ctx): **15 calls** — the READMEs of all five
  sub-projects plus targeted follow-ups — a five-project synthesis in
  60 s, structurally comparable to the cloud-Claude reference transcript.
- The RL/Bloom question ran **22 calls and overflowed even 24k** — the
  failure that motivated the tool budget. With budget + dedup it completes
  in 57 s with a correct grounded answer (`budget-stop after 24 calls`,
  7 unique tools executed, duplicates absorbed as one-liners).

**Qwen3.5-9B (Q5_K_M, ~6.2 GB weights)** — the same investigative behavior
at laptop size: 13-call line-cited doMultisect in 21 s; 21-call
five-README survey in 30 s. Laptop note: on an 8 GB card this model runs
at ~8k context, where its 20-call appetite makes the tool budget
essential, not optional.

**Gemma 3 27B QAT re-test (post-fix)** — supersedes the flaky verdict in
the cross-family matrix above, which predated the system-prompt fold and
sequence-reuse fix:

- **Reliable now**: three consecutive chats, no leak, no fabrication, all
  answers grounded in real tool output. One `digest` call answered
  doMultisect with the correct line range plus callers and callees.
- **Character: laconic** — 1–3 calls, 5–15 s, README-level depth where
  Qwen3.5 reads implementation code. A competent junior, not an
  investigator.
- Garbage numeric args (`max: 2.5e15`) persist even with curated tools
  and a delivered system prompt — Gemma-intrinsic; server-side arg
  clamping remains warranted.
- Known limitation (upstream): switching models *away* from Gemma wedges
  the server in native teardown — load Gemma last in a session, or expect
  a server restart when leaving it.

**Recommendation update**: **Qwen3.5 supersedes Qwen3 at every tier** —
the 3→3.5 generational jump is larger than the 8B→27B size jump within
Qwen3. Gemma 3 QAT is a legitimate stable alternative where Google
provenance or snappier answers matter more than investigative depth.

## Models too big for the laptop — RunPod feasibility

The 16 GB laptop card can't hold the current frontier open-weight models — the
smallest build of the Chinese frontier set is ~82.5 GB. RunPod can fit all of
them on VRAM (single GPUs up to a B300 at 288 GB, MI300X 192 GB, B200 180 GB,
H200 141 GB; up to 8 GPUs per pod via NVLink). But fitting a model is not the
same as CodeExam being able to run it: CodeExam loads through mainline
`llama.cpp` (the pinned node-llama-cpp `3.22.1`), and two of these need
non-mainline forks. Sizes are the smallest usable GGUF as of #330 (2026-09-29).

| Model | Smallest GGUF | RunPod GPU that fits | CodeExam-runnable? |
|---|---|---|---|
| DeepSeek V4-Flash (284B, 13B active) | ~82.5 GB (UD-IQ1_S) | 1× H200 / B200 / MI300X, or 2× H100 | likely — mainline arch; confirm at load |
| GLM-5.3-Flash | ~128 GB (usable 3-bit) | 1× H200 / B200 / MI300X / B300 | confirm GLM-5.3 arch in mainline |
| GLM-5.3 (full) | ~223–239 GB | 1× B300 (288 GB), or 2× H200 / 4× H100 | confirm arch |
| Kimi K3 | ~509–594 GB (~610 GB total) | 8× H100 (640 GB) / H200 / B200; 4× B300 / MI300X | **No — needs Unsloth's `llama.cpp` fork, not mainline** |
| DeepSeek V4.1-Flash | fork-only GGUFs | — | **No — arch `deepseek41` not in mainline (fork: mx-llama.cpp)** |

The realistic candidates are **DeepSeek V4-Flash** and the **GLM-5.3 family** — a
single high-VRAM card for DeepSeek and GLM-5.3-Flash (single-digit $/hr), a
2–4-GPU pod for full GLM-5.3 — each pending a one-shot architecture load-test.
**Kimi K3 and DeepSeek V4.1-Flash are blocked by the engine, not the GPU**: the
pod exists, but CodeExam's pinned mainline `llama.cpp` can't load them without a
fork that's off the release path.

[[Placeholder — actual RunPod runs. If any of these are run, fold the result in
here with the pod, quant, context, and whether CodeExam's tool-calling channel
engaged — same shape as the matrices above. Tracked in #330.]]

## Cost and teardown

- Ballpark (verify current rates): 24 GB ~$0.3–0.7/hr, 48 GB ~$0.8/hr, 80 GB
  A100 ~$1.6–2.5/hr. A few hours of testing is single-digit dollars.
- **Stop or terminate the pod when done** — billing is per-second while it
  runs. *Stop* keeps the container disk (and its downloaded model) for a
  restart at storage-only rates; *Terminate* wipes everything. For a one-shot
  test, terminate; if you expect to come back across days, stop instead —
  re-downloading 23 GB is the main cost of terminating early.
