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

## The determinism boundary — every place a model touches CE output

The claim this section makes, and the reason it exists: **the entry
points below are the ONLY places a language model touches CodeExam's
output. Every other CE command is deterministic** — the same index and
the same invocation produce the same bytes. For an examiner (or an
opposing expert) this is the line that decides which parts of a CE work
product can vary run-to-run and which cannot; `--reproducible` pins
what can be pinned on the model side (temperature 0, fixed seed; local
GGUF inference is bit-reproducible for identical invocations on the
same engine build), and the provenance header records engine, model,
and engine build so any variation is attributable.

Verified three ways (2026-09-07): asus-CC's source-level audit (#321),
CE's own `--prompt-catalog` after its two blind-spot fixes (file-scope
labels now carry the constant's name; array-joined prompt builders now
assemble), and hand-reconciliation of the differences between the two.

| Surface | Entry points (file — prompt/builder) |
|---|---|
| --overview-by-ai | `core/ai-overview.js` — `AI_OVERVIEW_PROMPT` (+ `aiOverviewPrompt()` wrapper), `LOCAL_ENGINE_GROUNDING` (local-GGUF preamble) |
| --analyze family | `commands/analyze.js` — `buildAnalyzePrompt`, `buildClaimAnalyzePrompt`, `buildMultisectAnalyzePrompt`, `buildContextAnalyzePrompt`, `buildFileAnalyzePrompt`, `buildClaimFilePrompt` (`doAnalyze` is the driver, not a prompt) |
| Claim charts | `commands/claim-chart.js` — `buildChartAnalysisPrompt` (delegates to `buildClaimAnalyzePrompt` + dep-claims notes) |
| claim-locate | `commands/claim-locate.js` — `buildDiscoverPrompt`, `buildSelectPrompt`, `buildHuntPrompt`, `buildProposePrompt`, `buildRefinePrompt` |
| --claim-search extraction | `commands/claim.js` — `_CLAIM_EXTRACTION_PROMPT` (cloud) and `_CLAIM_EXTRACTION_PROMPT_LOCAL` (local GGUF — a deliberately separate local prompt path), via the `build(Local)ExtractionPromptWithVocab` wrappers |
| claims-loop | `commands/claims-loop.js` — `buildRedraftPrompt` |
| --synonymize | `commands/synonymize.js` — `buildSynonymizePrompt` |
| Pseudo-claims drafting | `commands/pseudo-claims.js` — the drafting instruction (GENERATE_SYS port) + the fixed caveat blocks CE emits itself (added here by the catalog re-run; absent from the initial source audit) |
| Mechanism ranker | `core/mechanism-ranker.js` — `buildBatchPrompt`, `buildVerdictPrompt` |
| GUI Chat | `server.js` — `chatSystemPrompt` (+ its `systemMsg`/`grounded` fragments) |

Catalog hits verified NOT to be model entry points, so a reader need
not wonder: `--emit-harness` rendering (its header states "emitted
deterministically, no LLM" — the one non-mechanical step is an explicit
`load_model()` stub left to the user), and the user-facing help/tour
strings the detector's breadth picks up (`CONSOLE_HELP`, `HELP_TEXT`,
GUI section text, MCP tool descriptions).

Everything not in this table — indexing, search, multisect, call
graphs, dedup/fingerprints, BoM, digests, stats, extraction, the
chart's retrieval and verdict-merge machinery around the model call —
is deterministic code with no model in the loop.

## The matrix (status 2026-09-07 evening — K_M column complete, every cell evidenced)

| Feature | Qwen3.5-27B | Qwen3.5-9B | Qwen3-14B | Gemma3-12B K_M | Gemma3-12B QAT | Devstral-Small |
|---|---|---|---|---|---|---|
| Claim charts / claim-locate / claims-loop | **SUPPORTED** ¹ | **DEGRADED** ¹ | UNTESTED | **DEGRADED** ⁵ | **DEGRADED** ² | UNTESTED |
| --overview-by-ai | UNTESTED | UNTESTED | **UNSUPPORTED** ³ | **SUPPORTED** ³ | **UNSUPPORTED** ³ | **DEGRADED** ³ᵇ |
| --analyze family | UNTESTED | UNTESTED | UNTESTED | **SUPPORTED** ⁶ | UNTESTED | UNTESTED |
| --claim-search extraction (local prompt) | UNTESTED | UNTESTED | UNTESTED | **SUPPORTED** ⁶ | UNTESTED | UNTESTED |
| --mask-all analysis | UNTESTED | UNTESTED | UNTESTED | **UNSUPPORTED** ⁴ | UNTESTED | UNTESTED |
| Pseudo-claims / mechanism-ranker | **SUPPORTED** ¹ | UNTESTED | UNTESTED | **SUPPORTED** ⁶ᵇ | UNTESTED | UNTESTED |
| GUI Chat | UNTESTED | UNTESTED | UNTESTED | **DEGRADED** ⁷ | UNTESTED | UNTESTED |
| --synonymize | UNTESTED | UNTESTED | UNTESTED | **SUPPORTED** ⁶ | UNTESTED | UNTESTED |

Qwen3.5-27B's UNTESTED cells require the 24 GB / 24k-context cloud
configuration — the 16 GB acceptance machine cannot load it; that
column's gaps are hardware attribution, not neglect.

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
- **Devstral-Small: DEGRADED** ᵇ — engages the tools and got AI/ML
  right. Post-slate history, in full: the slate's CORRECT overhead
  arithmetic shrank the ctx-8192 tool budget 49% and exposed a
  refusal-loop defect (the budget stop was a string the model could
  ignore), taking Devstral 0-for-4; the refusal-loop fix (CE ends the
  loop itself and re-synthesizes from gathered results with a reset
  history) took it 3-for-3 on .zlib/.x265/.sr_gh, verified on the GGUF
  acceptance machine (`ovloopfix_20260907_1200/`, CHANGES_FOR_UPSTREAM
  2026-09-07). The stated limit: recovers via the budget rescue on a
  16 GB card; does not complete a clean agentic run at ctx 8192, and
  the rescued output restates the gathered results more than it
  synthesizes. 13.3 GB of weights on a 16 GB card is the real
  constraint; flash attention does not close the gap (measured).

NOTE: these verdicts predate the #320 fix slate (models_used
substitution/verification, measured overhead, evidentiary footer). The
AI/ML sentence is now CE-guaranteed and **stops discriminating between
models**; a post-fix re-measure scores tool engagement, prose fidelity,
and budget survival instead. Re-run pending on the GGUF acceptance
machine.

**⁴ Gemma3 (K_M) mask-all** — #319: chats about code capably, but
cannot grasp the --mask-all discipline in conversation. Unchanged by
the 9/07 batch (that test was not repeated); note the analyze-path
control below found masked *analysis* degrades appropriately without
corrupting — the #319 finding is about the conversational feature.

**⁵ Gemma3-12B K_M claim charts** — DEGRADED, scored on the fresh
same-commit f916787 pair under the pre-agreed rule (#321): positive
11/11 PASS (TLS demo); negative FAIL by the known mechanism — one
row's PRESENT resting on lone support (1 of 25, floor 20), the same
row/support/floor as every banked run, digit-identical across commits.
The limit, stated in the direction it occurs: **may over-claim a
single row on a true negative** — here a *transmit-side* limitation
scored against a *receive-side-only* corpus. PRESENT rows resting on
1-of-N support should be independently verified; the `--verdicts-out`
sidecar exposes the support count mechanically and
`scripts/engine-qualify.mjs` (shipped) flags it. Receipts:
`RUN29_QUAL_8752101_x_ExoPlayer3_gemma3-12b-Q4KM_f916787_20260907_1412.verdicts.json`,
`CLAIM2_RUN29_tlsdemo_gemma3-12b-Q4KM_f916787_20260907_1449.verdicts.json`.

*Citation density (the "thin" criterion, measured over CITABLE rows
only — ABSENT rows have nothing to cite and would swamp the
denominator):* K_M 11/17 (0.65) on the negative, 85/107 (0.79) on the
positive; Qwen3-14B 22/22 (1.00). K_M is not thin in absolute terms —
two-thirds to four-fifths of citable rows point at code — but is
measurably less dense than Qwen. Both K_M pairs reproduce
digit-for-digit across commits: a reproducibility receipt in its own
right, and it means the negative-side over-claim is not a sampling
accident. *(Provisional, n=1: on the true positive only 1 of 42
PRESENT notes hedges ("could/may/likely…") — a 2% base rate — and the
suite's one false PRESENT is hedged. ABSENT never hedges, any engine,
0 of 762. A hedged PRESENT is a candidate flag, not a detector.)*

**⁶ Gemma3-12B K_M, 9/07 batch** (`km_cheap_*` / `km_pseudo_*` run
dirs, stock f916787, #321): plain **--analyze** clean on two indexes
with a same-session mask-all control (masking degraded output exactly
as designed — lost the purpose with the masked name, kept the
mechanism, and got MIN_MATCH *right* where the unmasked run answered
from parametric knowledge and got it wrong); **--analyze --with
<claim>** produced element-by-element verdicts with line citations and
marked out-of-span helpers "not shown" rather than inventing them.
**claim-search extraction** returned index-aware TIGHT/BROAD lists
(media3/mime/pcm — ExoPlayer vocabulary) with runnable multisect
commands. **synonymize**: 9-of-9 elements preserved, 32.2% mean
content-word survival — requirement intact, vocabulary moved.

**⁶ᵇ Pseudo-claims / mechanism-ranker (K_M)** — ranker: 43/43 groups
scored with a genuine P0/P1/P2 spread (6/25/13) and playoff demotions
working as documented; characterisations accurate. Drafting: the claim
was accurate and code-true, but every cited anchor was dropped by a
**CE parser defect** (the drafter's trailing element annotation was
passed whole to the resolver; all five citations hand-verified
correct) — fixed at 5a91253, which strips the annotation and keeps it
as the anchor's element note. SUPPORTED with no model re-measure: the
citations were right all along. The artifact's "0 grounded" statement
before the fix was false, and CE's, not the model's.

**⁷ Gemma3-12B K_M GUI Chat** — DEGRADED
(`scripts/gui-chat-probe.mjs` transcript, four scripted rounds, zero
fabrication). Answers navigation/orientation questions well; on "what
does this function do" it calls `digest` (location/callers) without
following up with `extract` (the body), then honestly reports it lacks
the information. Told to use extract, it answers correctly and
specifically — a tool-selection limit, not comprehension. mask-all
excluded (own row).

## Matrix notes — patterns the cells share

- **"A question whose answer depends on a tool call the model is free
  not to make."** Named on #321 because it now recurs: the AI/ML
  sentence delegated to an optional `models_used` call (#320(a), fixed
  by CE calling it itself), and Chat's digest-without-extract (⁷). The
  instructive contrast is `--analyze` on the same function, same model,
  same commit: an excellent answer, because analyze *hands the model
  the source* instead of hoping it fetches it. Where this pattern
  bites, the proven remedy is substitution (CE gathers on the model's
  behalf), not prompting (measured dead, #320).
- **Part of what a column measures is CE.** Two of K_M's three 9/07
  DEGRADED verdicts had limits that were CE's to fix, not the model's
  (the anchor parser, since fixed; the chat tool-selection gap, open).
  On this evidence Gemma3-12B K_M is a more capable engine than a
  verdict-count skim of its column would suggest.
- Post-release chart-disclosure candidates (deterministic, from data CE
  already has): a support-count note on lone-support PRESENT rows, and
  a hedge/label-mismatch note (see ⁵'s provisional observation). Not
  for the 9/21 release.

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
