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

## The matrix (status 2026-09-08 — K_M and Devstral columns complete, every cell evidenced)

| Feature | Qwen3.5-27B | Qwen3.5-9B | Qwen3-14B | Gemma3-12B K_M | Gemma3-12B QAT | Devstral-Small † |
|---|---|---|---|---|---|---|
| Claim charts / claim-locate / claims-loop | **SUPPORTED** ¹ | **DEGRADED** ¹ | UNTESTED | **DEGRADED** ⁵ | **DEGRADED** ² | **DEGRADED** ⁹ |
| --overview-by-ai | UNTESTED | UNTESTED | **UNSUPPORTED** ³ | **SUPPORTED** ³ | **UNSUPPORTED** ³ | **DEGRADED** ³ᵇ |
| --analyze family | UNTESTED | UNTESTED | UNTESTED | **SUPPORTED** ⁶ | UNTESTED | **SUPPORTED** ⁸ |
| --claim-search extraction (local prompt) | UNTESTED | UNTESTED | UNTESTED | **SUPPORTED** ⁶ | UNTESTED | **SUPPORTED** ⁸ |
| --mask-all analysis | UNTESTED | UNTESTED | UNTESTED | **UNSUPPORTED** ⁴ | UNTESTED | UNTESTED ⁸ |
| Pseudo-claims / mechanism-ranker | **SUPPORTED** ¹ | UNTESTED | UNTESTED | **SUPPORTED** ⁶ᵇ | UNTESTED | **SUPPORTED** ¹⁰ |
| GUI Chat | UNTESTED | UNTESTED | UNTESTED | **DEGRADED** ⁷ | UNTESTED | **SUPPORTED** ⁹ᵇ |
| --synonymize | UNTESTED | UNTESTED | UNTESTED | **SUPPORTED** ⁶ | UNTESTED | **SUPPORTED** ⁸ |

† **Devstral column header note:** every Devstral cell ran at ctx 8192
(13.3 GB of weights on the 16 GB reference card cannot hold 16384) while
K_M ran the same work at 16384 — a standing context disadvantage. And
Devstral is slower at everything: **≈2x is inherent** (24B parameters vs
12B; GPU decode is memory-bandwidth-bound, so tokens/sec scales with
bytes-per-token on any hardware), and the observed **up-to-4x on 16 GB**
is the hardware constraint on top (context halving; possible partial
GPU offload — check the load log's offloaded-layer counts; KV-cache
pressure). On a 24 GB card expect the 2x to remain and the rest to
shrink. Measured: charts ~73s/target vs K_M ~29s; chat 45–59s/round vs
13–24s.

Qwen3.5-27B's UNTESTED cells require the 24 GB / 24k-context cloud
configuration — the 16 GB acceptance machine cannot load it; that
column's gaps are hardware attribution, not neglect.

**The honest one-line summary for a reader choosing between the two
measured columns (asus-CC, 2026-09-08): K_M is the safer default for
charts, Devstral is the better chat and analysis engine, and Devstral
is 2–4x slower at everything on 16 GB hardware. Neither dominates.**

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
citations thin (#244; the citation-density script can now put a number
on its sidecars whenever they are re-scored).

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
  2026-09-07, re-verified on stock f916787). The stated limit: recovers
  via the budget rescue on a 16 GB card; does not complete a clean
  agentic run at ctx 8192, and the rescued output restates the gathered
  results more than it synthesizes.

NOTE: these verdicts predate the #320 fix slate's models_used
substitution/verification and evidentiary footer. The AI/ML sentence is
now CE-guaranteed and **stops discriminating between models**; post-fix
re-measures score tool engagement, prose fidelity, and budget survival
instead.

**⁴ Gemma3 (K_M) mask-all** — #319: chats about code capably, but
cannot grasp the --mask-all discipline in conversation. Unchanged by
the 9/07 batch (that test was not repeated); the analyze-path control
found masked *analysis* degrades appropriately without corrupting —
the #319 finding is about the conversational feature.

**⁵ Gemma3-12B K_M claim charts** — DEGRADED, scored on the fresh
same-commit f916787 pair under the pre-agreed rule (#321): positive
11/11 PASS (TLS demo); negative FAIL by the known mechanism — one
row's PRESENT resting on lone support (1 of 25, floor 20), the same
row/support/floor as every banked run, digit-identical across commits.
The limit, stated in the direction it occurs: **may over-claim a
single row on a true negative** — here a *transmit-side* limitation
scored against a *receive-side-only* corpus, impossible by
construction. PRESENT rows resting on 1-of-N support should be
independently verified; the `--verdicts-out` sidecar exposes the
support count mechanically and `scripts/engine-qualify.mjs` (shipped)
flags it. Receipts:
`RUN29_QUAL_8752101_x_ExoPlayer3_gemma3-12b-Q4KM_f916787_20260907_1412.verdicts.json`,
`CLAIM2_RUN29_tlsdemo_gemma3-12b-Q4KM_f916787_20260907_1449.verdicts.json`.

*Citation density (the "thin" criterion, measured over CITABLE rows
only — ABSENT rows have nothing to cite and would swamp the
denominator):* K_M 11/17 (0.65) on the negative, 85/107 (0.79) on the
positive; Qwen3-14B 22/22 (1.00); Devstral 2/5 strict (0.40) / 3/5
with bare line-ranges counted (0.60) — the instrument now reports both
columns, after its strict rule (calibrated on K_M's prose style)
under-credited Devstral's bare "872, 875-881" citations. Both K_M
pairs reproduce digit-for-digit across commits: a reproducibility
receipt in its own right.

*(The hedged-PRESENT candidate flag proposed after the K_M pair is
**retired**: its own stated disconfirming test — a second true-negative
pair — falsified it. Devstral hedges 0 of 206 notes at any label, so
the signal would miss its over-claim entirely. The support-count
disclosure, which caught both engines' over-claims, stands.)*

**⁶ Gemma3-12B K_M, 9/07 batch** (`km_cheap_*` / `km_pseudo_*` run
dirs, stock f916787, #321): plain **--analyze** clean on two indexes
with a same-session mask-all control (masking degraded output exactly
as designed — lost the purpose with the masked name, kept the
mechanism); note the one checkable constant went wrong from parametric
knowledge (MIN_MATCH "typically 4" vs the index's 3 — the term is
outside the analysed span; Devstral recalled it correctly). **--analyze
--with <claim>** produced element-by-element verdicts with line
citations and marked out-of-span helpers "not shown" rather than
inventing them. **claim-search extraction** returned index-aware
TIGHT/BROAD lists with runnable multisect commands (21% dead terms —
claim-language phrases; bounded by the #307 dead-terms fix).
**synonymize**: 9-of-9 elements preserved, 32.2% mean content-word
survival — the better synonymizer (lower survival = vocabulary moved
further, which is the point).

**⁶ᵇ Pseudo-claims / mechanism-ranker (K_M)** — ranker: 43/43 groups
scored with a genuine P0/P1/P2 spread (6/25/13) and playoff demotions
working as documented. Drafting: accurate, code-true claim; every
cited anchor was initially dropped by a **CE parser defect** (trailing
element annotations passed whole to the resolver; all five citations
hand-verified correct) — fixed at 5a91253, then **re-measured live on
stock code: 0 grounded → 5 grounded on the same anchor group**, so the
SUPPORTED verdict is a receipt, not a prediction.

**⁷ Gemma3-12B K_M GUI Chat** — DEGRADED
(`scripts/gui-chat-probe.mjs` transcript, four scripted rounds, zero
fabrication). Answers navigation/orientation questions well; on "what
does this function do" it calls `digest` (location/callers) without
following up with `extract` (the body), then honestly reports it lacks
the information. Told to use extract, it answers correctly — a
tool-selection limit, not comprehension. mask-all excluded (own row).

**⁸ Devstral-Small, batch 1** (`dev_cheap_20260907_1621/`, stock
67ad0f6; every run ctx 8192, 30–50s each, no OOM): plain **--analyze**
SUPPORTED and *more accurate than K_M* on the one checkable constant
(MIN_MATCH "typically 3" — correct — where K_M said 4; both answered
from parametric knowledge, only one recalled right); well-organised
Constants/Algorithms/Inputs/Processing sections; ExoPlayer3 also clean.
**--mask-all control** degraded as designed with no corruption — the
row stays UNTESTED because #319's conversational test was not repeated.
**claim-search extraction** SUPPORTED: 15% dead terms vs K_M's 21%,
but the *kind* differs — K_M's dead terms are claim-language phrases,
Devstral's are plausible-looking invented identifiers
(`transmitterUnit`), which read like symbols someone could hunt for;
flagged, not settled. **synonymize** SUPPORTED: 9/9 preserved, 37.2%
survival (sound rewrite, less distant than K_M's 32.2%).

**⁹ Devstral-Small claim charts** — DEGRADED under the agreed rule,
with the rule's new **evidence-loss branch** applied (this is the case
that motivated it): the negative FAILs by the same middle-case
mechanism as K_M — one row's lone-support PRESENT (1 of 23) — and on
the negative Devstral is otherwise the *better* engine (5/9 ABSENT vs
K_M's 2/9). Its over-claim is also the lesser kind: a receive-side
element matched to an adjacent function (cache-index persist vs
content-byte store), not K_M's impossible-by-construction category
error. The bigger defect is on the positive: **61% of targets
PARSE-FAILED** (the model returns ~36 lines of analysis per target
that do not match CE's VERDICT contract; the target is discarded), so
the positive passes only marginally — 6/11 PRESENT against a floor of
6. Evidence loss errs safe (a discarded target cannot create a false
verdict) and is loudly visible in stderr and in engine-qualify, which
is why this is DEGRADED rather than UNSUPPORTED — but the cell would
be dishonest without the rate: **usable with the sidecar checked; not
a default for chart work on this hardware; ~73s/target (~2h for the
qualification pair).** Whether the parse-fail is partly CE's to fix
(a more tolerant VERDICT-contract parse, or a format-reminder retry)
is an open question in the #320 fix-pattern's spirit.
(`RUN30` pair, stock 67ad0f6.)

**⁹ᵇ Devstral-Small GUI Chat** — SUPPORTED, and better than K_M on
exactly the gap that made K_M DEGRADED: it **calls `extract`
unprompted** (rounds used extract/search/digest combinations), answers
"what does this function do" and the threshold follow-up correctly
from the source — the question K_M could not answer without being told
the tool. ~2–3x slower per round than K_M. mask-all excluded.
(`dev_guichat_probe.out`, same scripted rounds as ⁷.)

**¹⁰ Devstral-Small pseudo-claims / mechanism-ranker** — SUPPORTED,
both halves (stock 67ad0f6, identical inputs to the K_M run so the
cells differ only by engine). Ranker: 43/43 scored, real P0/P1/P2
spread (3/23/18), no degenerate flat-P2 shape. Drafting: accurate
claim, 3 cited anchors all grounded with real ranges via the 5a91253
parser path; one accuracy nit recorded (a one-sided conditional about
dictionary-vs-window size — the more specific and therefore more
falsifiable statement; K_M omitted the conditional entirely). Closer
to the litigated band on shape distance (0.24 vs 0.29), outside on
more axes (3 vs 2).

## Matrix notes — patterns the cells share

- **"A question whose answer depends on a tool call the model is free
  not to make."** Named on #321 because it recurs: the AI/ML sentence
  delegated to an optional `models_used` call (#320(a), fixed by CE
  calling it itself), and K_M-Chat's digest-without-extract (⁷). The
  instructive contrast is `--analyze` on the same function, same model,
  same commit: an excellent answer, because analyze *hands the model
  the source*. Where this pattern bites, the proven remedy is
  substitution (CE gathers on the model's behalf), not prompting
  (measured dead, #320). Devstral-Chat shows the pattern is
  per-model: it fetches unprompted (⁹ᵇ).
- **Part of what a column measures is CE.** Two of K_M's three 9/07
  DEGRADED verdicts had limits that were CE's to fix (the anchor
  parser, since fixed and re-measured; the chat tool-selection gap,
  open), and Devstral's chart parse-fail rate may be partly CE's
  VERDICT-contract strictness. On this evidence both engines are more
  capable than a verdict-count skim of their columns suggests.
- **"Laconic" is now a measurement, not an impression** (asus-CC,
  2026-09-08): Devstral vs K_M differ in the same direction on three
  independent mechanical axes — ranker rationale length (22 vs 50 mean
  chars), chart citation density (0.40–0.60 vs 0.65), pseudo-claim
  volume (6 vs 14 dependents; 3 vs 5 cited anchors). And it does NOT
  track correctness — Devstral is terser *and* was right where K_M was
  wrong (MIN_MATCH; 5/9 vs 2/9 ABSENT on the true negative). **Terse
  and accurate are independent axes; the matrix must not let the first
  imply the second.**
- Post-release chart-disclosure candidate (deterministic, from data CE
  already has): a support-count note on lone-support PRESENT rows — it
  caught both engines' over-claims. (The hedge/label-mismatch
  companion was retired by its own disconfirming test; see ⁵.)

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