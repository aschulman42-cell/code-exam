# Local GGUF model support, per feature

Which local models can or can't be relied on, per LLM-based CE feature —
the assessment behind the release (#321). Four verdicts, and a rule:
**no verdict without a receipt.** Every populated cell cites the issue,
run set, or acceptance script that earned it; a cell nobody has measured
says UNTESTED rather than implying support.

- **SUPPORTED** — works as designed; evidence cited.
- **DEGRADED** — works with stated limits (e.g. laconic output, needs a
  minimum context size); the limits are part of the verdict.
- **UNSUPPORTED** — named failure mode; don't use this pairing today.
- **UNTESTED** — no evidence either way. Absence of a verdict is
  disclosed, never rounded up to support.

Hardware ground rules (learned the hard way — #320):

- **One loaded model at a time.** A running GUI or MCP server holds its
  GGUF in VRAM until the process exits — closing the browser tab is not
  enough. A second CE process falls back to CPU with only a generic
  "GPU out of memory" and runs 10–100× slower.
- **Size VRAM for one model, not concurrent sessions.** CE does not
  share or evict a loaded GGUF between processes.
- Every run records its engine build (node-llama-cpp version, llama.cpp
  build, GPU device) in the provenance header; comparisons across runs
  require comparable engine-build lines.

Reference hardware for the verdicts below: RTX 5080 (16 GB) unless a
cell says otherwise. Cloud engines (Claude/GPT/Gemini) are the reference
column, not the subject of this table.

## The matrix (status 2026-09-07 — pre-release assessment in progress)

| Feature | Qwen3.5-27B | Qwen3.5-9B | Qwen3-14B | Gemma3-12B K_M | Gemma3-12B QAT | Devstral-Small |
|---|---|---|---|---|---|---|
| Claim charts / claim-locate / claims-loop | **SUPPORTED** ¹ | **DEGRADED** ¹ | UNTESTED | UNTESTED | **DEGRADED** ² | UNTESTED |
| --overview-by-ai | UNTESTED | UNTESTED | **UNSUPPORTED** ³ | **SUPPORTED** ³ | **UNSUPPORTED** ³ | **DEGRADED** ³ |
| --analyze family | UNTESTED | UNTESTED | UNTESTED | **DEGRADED** ⁴ | UNTESTED | UNTESTED |
| --claim-search extraction (local prompt) | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED |
| --mask-all analysis | UNTESTED | UNTESTED | UNTESTED | **UNSUPPORTED** ⁴ | UNTESTED | UNTESTED |
| Pseudo-claims / mechanism-ranker | **SUPPORTED** ¹ | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED |
| GUI Chat | UNTESTED | UNTESTED | UNTESTED | **DEGRADED** ⁴ | UNTESTED | UNTESTED |
| --synonymize | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED | UNTESTED |

## Receipts

**¹ Claims track** — the deepest evidence in the project. Qwen3.5-27B at
24k context on a 24 GB card is the chart champion (audits 19/20
verified); the 9B tier runs on laptop hardware with reduced depth.
Acceptance is scripted, not anecdotal: `scripts/engine-qualify.mjs`
pass/fails an engine on pinned negative+positive chart sidecars with no
model calls, and the RUN 26/28 acceptance showed zero-of-225
solo-vs-family verdict differences at the line-ending-parity fix.
Rankers: #284's measurement runs. (RunPod arc, 2026-07; #311.)

**² Gemma3 QAT on charts** — reliable but laconic: verdicts land,
citations thin (#244 clamping discussion). Chart use is workable;
expect terser cells.

**³ --overview-by-ai** — the #320 11-run `-v` matrix (2026-09-07, RTX
5080, CE 0.5.0), scored per "no AI/ML is only wrong on .sr_gh":

- **Gemma3-12B K_M: SUPPORTED** — 4 tools, correct AI/ML on sr_gh
  (reproducible ×2), never failed a run.
- **Gemma3-12B QAT: UNSUPPORTED for this feature** — on sr_gh it emitted
  a plan-to-call-tools instead of an answer (prompt-echo, the failure
  most likely to look like a working feature in a demo). Same 5 calls as
  K_M on .zlib, so the deficit is index-conditional — but a feature that
  fails on exactly the interesting indexes is not supportable.
- **Qwen3-14B: UNSUPPORTED (pre-fix)** — 2 tools, wrong AI/ML verdict
  with the evidence already in context.
- **Devstral-Small: DEGRADED** — engages the tools and got AI/ML right;
  its outright failures traced to CE's own budget arithmetic (OVERHEAD
  under-reservation) plus the silent context-ladder halving, both fixed
  in the #320 slate; 13.3 GB of weights on a 16 GB card is its real
  constraint, and flash attention does not close the gap (measured).

NOTE: these verdicts predate the #320 fix slate (models_used
substitution/verification, measured overhead, evidentiary footer). The
AI/ML sentence is now CE-guaranteed and **stops discriminating between
models**; a post-fix re-measure scores tool engagement, prose fidelity,
and budget survival instead. Re-run pending on the GGUF acceptance
machine.

**⁴ Gemma3 (K_M) chat / analyze / mask-all** — #319: chats about code
capably (including a masked-analysis follow-up conversation), but
cannot grasp the --mask-all discipline; analyze works with the same
caveat. One version tested; treat as provisional.

## How a cell gets filled

1. Run the feature with `-v` so tool calls are visible (they now print
   by default on --overview-by-ai) and capture stdout+stderr.
2. Note the engine-build line and context size from the output.
3. For charts: run `scripts/engine-qualify.mjs` against the pinned
   sidecars. For overview: the evidentiary footer states the basis.
   For retrieval: `test/test_retrieval_reachability.js` scores with no
   model.
4. Verdict + receipt goes here; the matrix is only as honest as its
   citations.
