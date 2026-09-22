# AI-assisted code examination

CodeExam is **deterministic by default** — indexing, search, multisect, call graphs,
dedup/fingerprints, the bill of materials, digests, stats, and extraction all produce the same
bytes from the same index and the same command, with no language model in the loop. On top of that
deterministic base sits an **optional** layer of LLM assistance: a handful of commands that hand a
model some code (or some claim prose) and ask it to explain, rate, or extract.

**What the AI buys you.** The deterministic layer can *find, count, and cross-reference* — every
function that mentions a term, every caller of a routine, every duplicate. What it cannot do is
*read*. An AI model can: it can say what a function actually does, judge whether a passage of code
embodies a concept described in words, and bridge the gap between a patent claim's wording and the
codebase's own names — the vocabulary hop that pure text search can't make. Those are the jobs the
assisted commands take on, and the deterministic base is what keeps their inputs and their limits
auditable.

## The determinism boundary

For a code examiner — or their opponent — one useful question is precisely *which* parts of a
CodeExam work product can vary run-to-run and which cannot. The answer is a short, enumerable list:
an AI language model touches CodeExam's output **only** at these entry points —

- the **`--analyze`** family — `--analyze`, `--file-analyze`, `--claim-analyze`, and
  `--multisect-analyze`;
- **`--overview-by-ai`** — the agentic prose orientation of a whole codebase;
- **`--claim-search`** — term extraction from claim prose;
- the **GUI Chat** tab;
- and the **claims-analysis pipeline** — claim charts, `--claim-locate`, `claims-loop`,
  `--synonymize`, **pseudo-claim drafting**, and the mechanism ranker. [[placeholder: link the
  claims / patent-claims doc once its name is settled — the pipeline pieces are described there in
  depth.]]

**Everything else is deterministic code with no model in the loop.** That boundary is documented,
entry point by entry point, in [`docs/model-support.md`](model-support.md). And the one place
the model side *can* be made repeatable — running it at a fixed temperature and random seed so the
same input yields the same output — is covered in [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).

## What the assisted commands do

- **`--analyze <function>`** — Claude, ChatGPT, Gemini (or a local GGUF model) explains a function
  in context; **`--file-analyze`** does the same for a whole file. Add **`--line-numbers`** to
  include source line numbers in the text CodeExam sends the model (see **`--show-prompt`** below
  for what that text is), so a model that cites lines can be checked against them.
- **Multisect Analyze (`--multisect-analyze`)** — runs a **multisect** search ([[placeholder: link
  multisect's main description — `SEARCHING.md` or `CODEEXAM_KEY_FEATURES.md`, pending the
  SEARCHING/BROWSING split]]), then has the model produce a structured per-term verdict grid: each
  search term is rated `PRESENT` / `NAME-ONLY` / `IFFY` / `ABSENT` with supporting evidence and a
  confidence level — the model's own stated confidence in each rating. [[placeholder: link to
  wherever the verdict labels and confidence levels are defined in full.]] The grid lets you see at
  a glance how each term maps onto the matched function.
- **`--claim-search <prose>`** — extracts search terms from descriptive text (a patent claim, a
  spec, a requirement), runs a multisect search to find matching code, and can LLM-summarize each
  match.
- **`--claim-analyze` and claim charts** — element-by-element verdicts of a claim against the code,
  with CodeExam owning the chart structure and the model filling cells.
  [[placeholder: cross-link the claims / patent-claims doc once Part R/the PATENT_CLAIMS decision is
  settled — the claim-charting workflow is documented there in depth.]]
- **Input masking (`--mask-all`)** — strip comments, mask string literals, and mask identifier
  names before sending a function to a model. The point is to force the model to reason about
  *logic* rather than leaning on comments or naming, both of which can mislead — especially in
  obfuscated bundles where the names were themselves inferred. (Masking also suppresses some
  incidental data leakage, but it is **not a hard security boundary**: strings may still leak
  depending on configuration, and — a scope note worth stating — masking exists on the analyze
  routes, not in Chat, so a conversation about masked code can always fetch the unmasked source one
  `extract` away.)
- **`--show-prompt`** — add it to any analyze command to print the **prompt** (the
  digest-plus-source text CodeExam would otherwise send to the model) and exit with **no API
  call**. Use it to hand-paste a CodeExam-built prompt into any chat tool while making no network
  request from CodeExam itself. The same caveat as `--mask-all` applies: this keeps your source
  *files* on your machine, but it is not a hard confidentiality boundary — the prompt text you
  paste still contains code (or masked code, from which proprietary detail can leak), and where it
  travels next is up to you.

## Cloud or local

The same assisted commands run against either a frontier cloud model or a local one, and the choice
is a trade-off, not a default:

- **Cloud** (Claude / GPT / Gemini) is the most capable path, but it sends code or claim prose over
  the network.
- **Local** (a GGUF model under `node-llama-cpp`) is the **air-gapped** path — suitable for
  confidential code (for example, code under a Court Protective Order where outbound requests are
  prohibited). **`--air-gapped`** enforces it: it blocks cloud calls, scrubs API keys, probes
  connectivity, and emits the disclaimer.

A local GGUF model is not as capable as a frontier API model; CodeExam compensates by feeding local
models simpler prompts with narrower expectations. Which models load, how well each does per
feature, and the hardware requirements are the subject of [`LOCAL_LLM.md`](LOCAL_LLM.md) and
[`docs/model-support.md`](model-support.md); rely on the models those docs mark as tested,
since an untested model carries no assurance either way. If a recent model won't load,
`npm update node-llama-cpp` (to pick up a newer bundled `llama.cpp`) is the cheapest first thing to
try.

**One limit worth knowing up front:** a local model is a weak *independent* navigator. Asked to
form its own claim-to-code mapping and drive the tools to confirm it, current local models tend to
fabricate — they don't reliably make the vocabulary hop from a claim's wording to the codebase's
own names. CodeExam's managed pipeline (retrieval arms, `--synonymize`, the claim chart) performs
that hop mechanically, which is why the rule of thumb is **pipeline-for-local, cloud-for-
independent**. The evidence behind this is in [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md)
and [`docs/model-support.md`](model-support.md).

## Reproducibility

Because the assisted commands are the only non-deterministic surface, they are also where
reproducibility matters. **`--reproducible`** pins what can be pinned on the model side (temperature
0, a fixed seed; local GGUF inference is bit-reproducible for identical invocations on the same
engine build), and CodeExam's provenance header records the engine, model, and engine build so any
variation is attributable. The full account is in [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).

## Related

- [`LOCAL_LLM.md`](LOCAL_LLM.md) — running local GGUF models: which load, how, and the trade-offs.
- [`docs/model-support.md`](model-support.md) — the per-feature, per-model verdicts and the
  determinism boundary in full.
- [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) — `--reproducible`, `--air-gapped`, and the provenance
  header.
- [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md) — the independent-navigator limit
  and other gaps.
