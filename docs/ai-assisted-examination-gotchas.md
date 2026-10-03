# Some gotchas in AI-assisted code examination

> **Draft / work in progress.** This page collects *some* of the ways AI-assisted code examination
> can go wrong, and how to catch them; more will be added, along with more on how to address them.
> It's meant to be useful both to experts using CodeExam and to the attorneys and experts on the
> other side.

CodeExam's AI features are optional, and useful — but a language model examining code can make
particular kinds of mistakes, and this page lists some of what to watch for. It is written for the
examiner who will have to defend a work product: some of CodeExam's audience works on source code
under a Protective Order, across the table (so to speak) from an opposing expert whose job is to
find weak spots. A fabricated detail that survives into a report is such a weak spot.

**Scope.** Everything here is about the **optional AI layer** — Overview-by-AI, `--analyze`, claim
search, claim charts, GUI Chat, and the rest of the claims-analysis pipeline. See
[`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md) for the full list of CodeExam features that
employ AI. CodeExam's deterministic core (search, the structural lists and catalogs,
cross-reference, metrics, dedup/fingerprints, digests, BoM) has none of these *particular* failure
modes: the same index and command produce the same bytes, with no model in the loop (see
[`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)). Of course, the non-AI features have their own
limitations (see [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md)). The gotchas are
the price of the AI layer, and they are manageable — if you know them.

## The one habit: separate what CodeExam computes from what the model says

Around an AI result, CodeExam puts two kinds of thing on the page, and they earn very different
trust:

- **What CodeExam computes** — counts, support figures, which claim words never appear in the cited
  code, the tool-call transcript. These are calculated by CodeExam, not written by the model, so
  they're reliable. (This is the "trust the numbers, check the sentences" rule in
  [`LOCAL_LLM.md`](LOCAL_LLM.md) — those "numbers" are *CodeExam's*, not numbers the model states.)
- **What the model says** — its prose. Within that, two sub-kinds:
  - its **verbatim references** — file names, function/class names, identifiers, quoted lines — are
    *auditable*: they are either in the index or not, and usually one command (`search` or
    `extract`) settles it. These are usually right.
  - its **interpretations** — what an acronym stands for, an aggregate number it states, a summary of
    "what this codebase is about" — are where it tends to drift.

So lean on CodeExam's computed figures and on the model's checkable references; **verify the model's
interpretations** before relying on them. (A shorthand: "trust the nouns; check the acronyms, the
stated numbers, and the summaries" — where "acronyms and numbers" stand for the model's *derived*
claims, not CodeExam's computed ones. That's consistent with LOCAL_LLM's "trust the numbers": there
the numbers are CodeExam's; here the suspect ones are the model's.) The rest of this page is that
habit, itemized.

## The gotchas

Each is drawn from real CodeExam examination sessions.

### Ungrounded acronym expansion

Asked what an acronym meant, a strong local model twice confidently expanded **DAPO** as "Direct
Preference Optimization" — wrong, and *refuted by a file sitting in the very index it was examining*
(`dapo.md`, which defines the term). The model reached for a plausible expansion from its training
instead of reading the code in front of it.

- **Catch it:** an acronym expansion is a checkable claim. `search` the index for the acronym and
  read where it is actually defined before quoting any expansion.
- **CodeExam reduces it:** in **grounded** mode the prompt tells the model to answer from the code
  and say "not determinable" rather than guess (see `--grounding`, below). This *reduces* the
  behavior; it does not eliminate it — treat every expansion as a lead to confirm.

### Confabulated aggregate statistics

Asked for the size of a codebase, a model reported "**636,800+ lines**" for an index that actually
held **1,637,511** — a number with no source in the data, apparently back-derived from the function
count. A number the *model states* is an estimate, not a count.

- **Catch it:** don't take a count from the model's prose. CodeExam computes counts
  deterministically — `--stats` (files, functions, lines), the catalog totals, `--functions` /
  `--files` lengths. Those numbers are calculated, not narrated — and they're the "numbers" worth
  trusting.

### Reference inflation

A model examining a project whose *documentation* cited outside research (e.g. references to other
systems in that project's own docs) reported those citations as the codebase's own "research focus
areas." A reference the code *mentions* became a thing the code *does*.

- **Catch it:** distinguish what the code **contains** from what it **points to**.
  `--referenced-resources` catalogs the external surface (URLs, hosts, model IDs, referenced-but-
  absent files) so that "mentions X" is not mistaken for "implements X." If the claim is about a
  capability, `extract` the code said to implement it.

### Missing negative-space findings

A model will readily tell you what *is* there and rarely volunteer what is **not** — that a module
is *not* wired to the training pipeline, that two subsystems do *not* share state. Worse, section
placement can imply a connection the model never actually investigated: put two things under one
heading and the reader infers a link. And the model simply doesn't report what it didn't find — so
from its silence you can't tell "checked, and X isn't there" from "never checked X."

- **Catch it:** the findings that matter most in an examination are often *absence* claims — e.g.
  "this module never calls the crypto library", "there is no retry logic on this path", "feature X
  isn't implemented anywhere" — and those are exactly what a model won't volunteer. Ask for them
  directly ("is X connected to Y? does anything call Z?"), and confirm with corpus-wide **negative
  search**: CodeExam can show that a term or call occurs *nowhere* in the index — a finding the model
  won't hand you.

### The reliability gradient

Putting the above together: model output is not uniformly reliable — it degrades along a gradient.
**Verbatim references** (names, identifiers, quotes) are the most reliable; **interpretive
summaries** drift more, and more so under *length pressure* — the longer the passage and the more it
summarizes, the more room for drift.

A concrete case: the AI layer summarizes at whatever scope you point it — `--analyze` takes a
function, a class, or a whole file. The bigger the unit, the more interpretive drift, and a local
model in particular will do noticeably better on a single function than on an entire file or class.
(The deterministic `--digest` underneath is unaffected — it's the *model's* read of a large unit
that drifts.)

The practical rule isn't "trust short answers" so much as: the longer and more sweeping the prose,
the harder it is to verify, so prefer narrow, specific queries and scrutinize sweeping summaries the
hardest.

## The behavior you want does exist — reward it

None of this means a model cannot examine code honestly. In the same sessions, the same model
*declined* to fabricate — "limited direct code evidence for this" — when its searches came up dry,
which is the right instinct. When a model hedges like that, the response is to **ask a follow-up**
(point it at a file, widen the search), not to switch to a model that sounds more certain. Certainty
is not accuracy, and the model that hedges honestly is likely the one doing the examination
properly.

## The control is protocol, not model choice

The more reliable defense against the gotchas above is **how you work**, not which model you pick:

- **The review habit** — separate what CodeExam computes from what the model says, and verify the
  model's interpretations (the opening section).
- **CodeExam makes verification cheap** — `search` / `extract` against the index turn a model's
  reference into a one-command check; the tool-call transcript is a record of what the model actually
  looked at; `--grounding grounded|augmented|attributed` sets how far the model may range beyond the
  code (grounded = code only, says "not determinable"; attributed = general knowledge allowed but
  flagged as such); and `--reproducible` lets you re-run and confirm an answer is stable (see
  [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)).
- **Local vs. cloud is a gradient, not a line.** A strong local GGUF model is somewhat more prone to
  all of the above than a frontier cloud model — and the frontier model is not immune either. Neither
  is a substitute for the verification habit. Which local models have been measured, per feature, is
  in [`model-support.md`](model-support.md); the local path and its trade-offs are in
  [`LOCAL_LLM.md`](LOCAL_LLM.md).

The habit to leave with: a CodeExam AI answer is a **lead, not a finding** — its value is that it
points you at the code fast, and CodeExam is built so that confirming (or refuting) it against the
index is quick.

## Related

- [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md) — the optional AI layer: what it does and how to drive it.
- [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) — the determinism boundary, and pinning a model run.
- [`model-support.md`](model-support.md) — per-feature, per-model support with the evidence behind each verdict.
- [`LOCAL_LLM.md`](LOCAL_LLM.md) — running a local GGUF model.
- [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md) — current gaps across CodeExam.
