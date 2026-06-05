# CodeExam — roadmap from today to public repo (and a bit beyond)

> Living checklist for the stretch from 2026-06-04 to the public repo. The analog of
> the "AI/ML march" checklist. Status-tagged; must / nice / later; issue cross-links.
> **Discussion: #133.** Source: `codeexam_direction_until_public.txt`.
> Updated 2026-06-05 after #133 round 1.

## Velocity baseline (from git)
The AI/ML march ran May 31 → June 4 (~5 intense days, ~40 commits; 12 on June 3). On
a focused day we land 6–12 substantial commits; a detector/projection ≈ a 1–2-hour
loop. Estimates are in **focused-days** (days we go hard); calendar conversion
depends on availability — the gating variable. Wall-clock-derived, so rough.

## AI/ML status (2026-06-04)
Phase 1 largely done — eleven precision-gated detectors (Models, Artifacts, Kernels,
Datasets, Training, Inference, LLM-calls, Tools, Chains, Embeddings, Structured
Output), identity extraction (#110), the Models Used projection, the #115 drill-down.
Phase 2 first pass: AI/ML Pipelines (connected-flow) + cross-folder climbing +
funcstr-corpus (#128).

## Decisions so far (#133 round 1)
- **CSI.js refactor: MUST, and first** — the de-dupe / `-v` / NICE items all modify
  AI/ML code, so refactoring first means touching it once (no double-edit + merge
  pain). Compromise: ship the accordion de-dupe (one visible win) first, then
  refactor, then the rest.
- **`.exe` shipping: LATER** — node + a browser is fine for GitHub viewers.
- **Missing-blocks survey: MUST** (cheap insurance). First pass done — see below.
- **Multimodal / vision-language: MUST candidate** (the strongest of the gaps).
  **RLHF/alignment and Diffusion: LATER.**
- **Mermaid diagrams: MUST pending a feasibility spike** (render multi-stage
  pipelines only; suppress trivial 2-node lines).
- **Metrics (hotspots/gaps): keep-or-cut pending an audit.**

## AI/ML coverage check (missing-blocks survey, first pass)
- **Solid:** architectures, training, datasets, inference, kernels (CUDA/Triton/MoE),
  LLM API calls, prompts, tools/function-calling, agents/chains, RAG, structured
  output. No embarrassing core omission.
- **Planned, not built:** Memory / Evals / Skills (#116); Quantization (#94).
- **Candidate gaps:** Multimodal / vision-language (CLIP, vision/audio encoders) —
  strongest; RLHF / alignment post-training (PPO/DPO/GRPO, reward models); Diffusion
  / image-gen (UNet/VAE/scheduler).

## Phase A — finish AI/ML for public (~4–5 focused-days MUST)
### MUST
- [ ] CSI.js refactor — extract AI/ML to a new module *(keystone; first, or right
      after the de-dupe win)*. Mixin extraction into `aiml-detectors.js`; exports a
      `CELL_KEYS` seed for the Phase-B registry below.
- [ ] De-dupe accordions via the #115 drill-down scheme (Models/Artifacts/…)
- [ ] CLI `-v` de-clutter (`--artifacts` etc. → `-v`)
- [ ] `ai-ml-move-prompts` + reorder accordions (LLM → kernels)
- [ ] README AI/ML section + verify `--help`
- [ ] Missing-blocks survey *(first pass done; act on findings)*
- [ ] **Multimodal / vision-language cell** (CLIP, vision/audio encoders)
- [ ] Mermaid pipeline diagrams — multi-stage only *(pending spike)*
### NICE
- [ ] #94 cross-cutting filters: quantization, layers-drill-down, config-as-data
- [ ] AI/ML summary in File Digests (cross-file?)
- [ ] MCP tools: Models Used, AI/ML Pipelines
- [ ] node test suite: AI/ML coverage
### LATER
- [ ] RLHF / alignment post-training cell
- [ ] Diffusion / image-gen shape
- [ ] Test-PY emitting; interpretability reconnaissance (#95)
- [ ] Remaining LLM-use cells: Memory / Evals / Skills (#116)
- [ ] Digest / cross-model comparison (#126); product clustering (#131)
- [ ] funcstr-corpus follow-ups: `--recover-names` (#130), test/example tag (#132)

## Phase B — repo-ready (~2–3 focused-days MUST)
### MUST
- [ ] Split off private / patent-litigation code
- [ ] Rename `jontest`; purge dead/old files
- [ ] Per-file headers (name, SLC.com, one-line summary, license)
- [ ] **Decide contribution model**: PRs vs Bram worklist → CONTRIBUTING
- [ ] 9-file fan-out rationalization *(pairs with the refactor)* — a `CELLS`
      registry (route / responseKey / renderer per cell) extending `CELL_KEYS`,
      replacing the per-cell hand-wiring in `metrics.js` / `argparse.js` /
      `server.js` / `public/{api,app}.js` / `public/index.html` /
      `public/list-renderers.js`. `aiMlCmds` (`src/index.js`, Jun 3) already did
      this for the CLI-dispatch layer only.
### NICE
- [ ] Feature "pay the rent" cull (hotspots? gaps?) *(decide via audit)*
- [ ] Per-feature state paragraphs

## Phase C — docs + samples (~1–2 focused-days MUST)
### MUST
- [ ] README: shorter/simpler + AI/ML
- [ ] Sample indexes: revive `.demo` (PY), a `.CodeExam` slice, one OSS-project index
### NICE
- [ ] Detailed docs on key features + key source files
- [ ] `.exe` shipping *(LATER-leaning; loose-JS liability until #127/#129)*

## Phase D — post-public (not on the critical path)
- SLC writing: finish/split Multisect; "Code Examination for the Age of AI"; CC; Bram
- GUI rework via XMLUI; PMEngine as example; meet Jon

## Bottom line
**~7–10 focused-days of MUST to a public repo** (~1.5× the AI/ML march, +~1 for the
multimodal cell). NICE adds ~5–7 more.

## Still to settle
- Mermaid spike outcome — confirms MUST or drops to NICE.
- Metrics audit — keep or cut hotspots / gaps.
- Beyond multimodal — is RLHF or diffusion pulled pre-public?
