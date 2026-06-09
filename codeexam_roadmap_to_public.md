# CodeExam — roadmap from today to public repo (and a bit beyond)

> Living checklist for the stretch to the public repo. The analog of the "AI/ML
> march" checklist. Status-tagged; must / nice / later; issue cross-links.
> **Discussion: #133.** Source: `codeexam_direction_until_public.txt`.
> Updated **2026-06-08** (notes: `CE_public_repo_plan_notes_060826.txt`).
> Prior update 2026-06-05 (after #133 round 1).

## Velocity baseline (from git)
The AI/ML march ran May 31 → June 4 (~5 intense days, ~40 commits). June 4–8 added
three more AI/ML cells (Multimodal, Post-training, Reasoning) plus quantization,
pipelines-quality/perf, and a batch of CLI ergonomics fixes. On a focused day we
land 6–12 substantial commits; a detector/projection cell ≈ a 1–2-hour loop.
Estimates are in **focused-days**; calendar conversion depends on availability.

## AI/ML status (2026-06-08)
Fourteen precision-gated detector cells now ship: Models, Artifacts, Kernels,
Datasets, Training, Inference, LLM-calls, Tools, Chains, Embeddings, Structured
Output, **Multimodal/Vision** (#140), **Post-training/Fine-tuning** (#140), and
**Reasoning/CoT** (#146) — plus the Models-Used projection, AI/ML Pipelines
(connected-flow + cross-folder climbing, with `fine-tuning` and `reasoning`
shapes), quantization in Artifacts (#141), the #115 drill-down, and #134 dedupe.

## Decisions so far (#133 round 1, still standing)
- **CSI.js refactor: MUST, and first** — done (mixin `ai-ml-detectors.js` +
  `CELL_KEYS`); the dedupe / `-v` / NICE items rode on top as planned.
- **`.exe` shipping: LATER** — node + a browser is fine for GitHub viewers.
- **Missing-blocks survey: MUST** — done (`missing_blocks_survey.md`); its
  findings drove the Multimodal / Post-training / Reasoning cells.
- **Multimodal / vision-language: MUST** — done. **RLHF/alignment** (was LATER)
  also done as the Post-training cell. **Reasoning** (not originally scoped) done.
- **Mermaid diagrams: MUST pending a feasibility spike** — feasibility done;
  implementation still open (see Phase A).
- **Metrics (hotspots/gaps): keep-or-cut pending an audit.**

## AI/ML coverage check (missing-blocks survey)
- **Solid + now shipped:** architectures, training, datasets, inference, kernels,
  LLM API calls, prompts, tools, agents/chains, RAG, structured output,
  **multimodal/vision**, **post-training/fine-tuning (LoRA/PEFT, SFT/DPO/PPO/GRPO,
  distillation)**, **reasoning/CoT language**, **quantization**.
- **Planned, not built:** Memory / Evals / Skills (#116).
- **Open coverage questions** (now verification tasks, Phase A): does Multimodal
  look for **audio** (whisper/wav2vec), not just vision? **DALL-E / image-gen**?
  Is **diffusion/image-gen** already covered by Multimodal's `generative` kind, or
  does it still warrant its own shape?

## Phase A — finish AI/ML for public (mostly DONE)
### MUST
- [x] CSI.js refactor — extract AI/ML to `ai-ml-detectors.js` mixin + `CELL_KEYS`.
- [x] De-dupe accordions via the #115 drill-down scheme (#134).
- [x] CLI `-v` de-clutter (`--artifacts` etc. → grouped + `-v`).
- [x] `ai-ml-move-prompts` + reorder accordions.
- [x] README AI/ML section (`5f76e98`) + `--help` AI/ML fixes.
      *(still: add the **Reasoning** bullet — Multimodal + Post-training are in.)*
- [x] Missing-blocks survey (`missing_blocks_survey.md`).
- [x] **Multimodal / Vision cell** (`eebee3b`, #140).
- [ ] **Mermaid pipeline diagrams** — multi-stage only; feasibility done, render
      not built. *Decision: MUST or NICE? Worth trying on the longer pipelines.*
- [~] node test suite: AI/ML coverage — partial. Suite is green (400 tests) but
      no `CELL_KEYS`-driven, per-cell AI/ML regression guard yet.
### New Phase A tasks (6/8 notes)
- [ ] README: add the **Reasoning** AI/ML bullet.
- [ ] Verify Multimodal **audio** coverage (whisper/wav2vec — it picked up
      "whisper", but does it scan for audio encoders as a class?).
- [ ] Verify Multimodal **DALL-E / image-gen** coverage.
- [ ] Confirm **Class/Model inheritance** is sound, and whether gaps there tie to
      method-call-resolution problems (#148, #85).
- [ ] Resolve **diffusion/image-gen**: already covered by Multimodal `generative`,
      or its own shape? (If covered, retire the LATER item.)
- [ ] Decide which **LATER** items to pull forward now.
### NICE
- [x] #94 quantization (`d118c9e`, #141 — Artifacts `quantization` family).
- [ ] #94 remainder: layers-drill-down, config-as-data.
- [ ] AI/ML summary in File Digests (cross-file?).
- [ ] MCP tools: Models Used, AI/ML Pipelines.
### LATER
- [x] ~~RLHF / alignment post-training cell~~ → **done** as Post-training (#140).
- [x] ~~Reasoning / CoT~~ → **done** (#146) *(not originally scoped)*.
- [ ] Diffusion / image-gen shape *(pending the Phase-A resolution above)*.
- [ ] Test-PY emitting; interpretability reconnaissance (#95).
- [ ] Remaining LLM-use cells: Memory / Evals / Skills (#116).
- [ ] Digest / cross-model comparison (#126); product clustering (#131).
- [ ] funcstr-corpus follow-ups: `--recover-names` (#130), test/example tag (#132).

## Phase B — repo-ready (~2–3 focused-days MUST)
### MUST
- [ ] Split off private / patent-litigation code.
- [ ] Rename `jontest`; purge dead/old files.
- [ ] **Clean up junk files in repo root** *(6/8 — lots of scratch `.txt`/`.jpg`
      accumulated this session)*.
- [ ] Per-file headers (name, SLC.com, one-line summary, license).
- [ ] **Decide contribution model**: PRs vs Bram worklist → CONTRIBUTING.
- [ ] 9-file fan-out rationalization *(pairs with the refactor)* — a `CELLS`
      registry (route / responseKey / renderer per cell) extending `CELL_KEYS`,
      replacing the per-cell hand-wiring. Each new cell (Multimodal/Post-training/
      Reasoning) re-paid the 9-file tax — strong evidence this is worth doing.
- [ ] **Test GGUF** end-to-end incl. the new **Gemma** model; evaluate a non-GGUF
      loader (ONNX?) *(6/8)*.
- [ ] **Test against new indexes** — Packt and Manning book repos (currently
      exercised only via AI/ML features); esp. "Crack Any Codebase With AI", whose
      small test surfaced many little GUI issues *(6/8)*.
- [ ] **GUI/CLI consistency** pass *(6/8 — see #149 positional-filter, #145 caveat
      presentation, #150 path context)*.
### NICE
- [ ] Feature "pay the rent" cull (hotspots? gaps?) *(decide via audit)*.
- [ ] Per-feature state paragraphs.

## Phase C — docs + samples (~1–2 focused-days MUST)
### MUST
- [ ] README: shorter/simpler + AI/ML.
- [ ] Sample indexes: revive `.demo` (PY), a `.CodeExam` slice, one OSS index.
- [ ] **Finalize `--help`; have it track the real build #** *(6/8; #147 keyword
      search pairs here)*.
- [ ] **Add a Help menu + screen to the GUI** *(6/8)*.
### NICE
- [ ] Detailed docs on key features + key source files.
- [ ] `.exe` shipping *(LATER-leaning; loose-JS liability until #127/#129)*.

## Phase D — post-public (not on the critical path)
- SLC writing: finish/split Multisect; "Code Examination for the Age of AI"; CC; Bram.
- GUI rework via XMLUI; PMEngine as example; meet Jon.
- **GUI automated testing** *(immediate post-public — reinforced 6/8)* — the suite
  is CLI-only; no automated coverage of the browser GUI (accordions, #115
  drill-down, list-renderers). The Manning/Packt GUI issues and #150 are fresh
  evidence this is needed. Investigate XMLUI-based GUI test automation. Pairs with
  the Phase A "node test suite: AI/ML coverage" item.

## Issues filed 2026-06-08 (cross-links)
- #144 — `--all-ai-ml` meta-flag (+ a `--no-prompts` toggle).
- #145 — standardize caveat presentation + condense "No X found" in multi-index.
- #147 — `--help <keyword>` to search the command list.
- #148 — `--models -v` show method names + subclasses (inheritance chain already
  shown); ties to the Class/Model inheritance Phase-A check (with #85).
- #149 — commands with a positional filter (`--class-tree`, …) don't honor `--filter`.
- #150 — AI/ML drilldown loses folder context on long/zip-prefixed paths.

## Bottom line
**Phase A MUST is now largely done** (three cells + quantization shipped); the
remaining Phase A MUST is small — the **Mermaid decision**, the **README Reasoning
bullet**, and **AI/ML test coverage**, plus the 6/8 verification tasks. The
critical path has shifted to **Phase B** (repo hygiene, the `CELLS`-registry
fan-out cleanup, and cross-index testing on Packt/Manning). Estimate to public:
**~4–6 focused-days MUST** remaining (down from ~7–10), NICE adds ~5–7 more.

## Still to settle
- Mermaid spike outcome → MUST (render long pipelines) or NICE/drop.
- Metrics audit — keep or cut hotspots / gaps.
- Diffusion/image-gen — already covered by Multimodal, or its own shape?
- Audio coverage in Multimodal — confirm or add.
- Which LATER items (if any) are pulled pre-public.
