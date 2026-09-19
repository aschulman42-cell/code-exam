# Examining code against patent claims

CodeExam grew out of source-code examination for patent litigation, and this page covers the
features built for that work: turning a patent claim into a code search, charting a claim element by
element against a codebase, handling dependent claims, and the methodology that makes the result
defensible. The same machinery works on any structured technical prose — a specification, a
requirements list — but patent claims are the demanding case it was designed for.

## A chart is a candidate match, not ground truth

Read this first, because everything below depends on it. A CodeExam claim chart records whether some
code is a **candidate match** for a reading of a claim — a reading you (or a party) supplied. A cell
marked `PRESENT` means the model found code that plausibly matches *that* reading of *that* element —
a match in substance, not a verbatim one; it does **not** necessarily mean the claim is infringed,
valid, or correct. Plaintiff and defendant can chart the same claim against the same code and reach
different results, and both charts can be internally sound: they encode different contentions, not
different facts. CodeExam is a tool for building and pressure-testing those contentions and surfacing
candidate matches, not an oracle that settles them. Treat every verdict as "this code is a candidate
match for a stated reading," and keep the reading visible.

## From a claim to the code

The first problem is vocabulary: a claim is written in the drafter's language (as modified through
PTO examination), and the codebase names things its own way. Bridging that gap is the hard part, and CodeExam offers two routes:

- **`--claim-search <prose>`** — extract the distinctive terms from a claim (or spec, or
  requirement) and run them as a multisect search (see [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md)),
  optionally summarizing each match with an LLM.
- **`--claim-locate <prose>`** — propose candidate symbols from the claim, verify them against the
  index (discarding ones that don't exist), navigate a hop from the survivors, and emit a set of
  **targets** to chart. `--hunt` widens the search when the first pass comes up short.

## Claim charts

**`--claim-chart`** produces the core deliverable: a table with **one row per claim element**. The
division of labor is deliberate — **CodeExam's deterministic code owns the structure** (it splits
the claim into elements and builds the rows deterministically) and the **model (an LLM suitably
prompted by CodeExam) fills the cells** (the per-element verdict and its evidence). With
**`--targets`** you can point one chart at a specific set of candidate implementations at once — say
three functions that each might implement a limitation, or two versions of a codebase — and CodeExam
charts every element against all of them and merges the results into one table, so you see how each
element fares across the candidates side by side.

Each element gets a verdict — `PRESENT`, `NAME-ONLY`, `IFFY`, or `ABSENT` — with supporting
citations and a confidence level. A couple of features make a chart easier to scrutinize rather than
take at face value:

- **Support-count disclosure.** `--verdicts-out` writes a **sidecar** — a JSON file saved alongside
  the chart — recording, for each element, the evidence behind its verdict: which code sites were
  cited, and how many of the examined sites supported the verdict versus went against it. This is
  where a **lone-support row** shows up — a `PRESENT` resting on a single supporting site when many
  were examined. Such a verdict isn't necessarily wrong, but a claim of presence backed by one site
  out of many is among the most worth checking by hand: a weak, uncorroborated match is likelier to
  be an over-reach than one that many sites agree on.
- **Determinism around the model.** The chart's retrieval and merge machinery is deterministic;
  only the per-cell verdict comes from the model. The reproducibility controls that pin the model
  side, and the provenance header that records engine/model/build, are in
  [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).

`--chart-html` renders the chart for reading, and `--chart-notes` attaches annotations from a file
you provide.

## Dependent claims

A claim set is a graph, not a list: dependent claims narrow their parents. CodeExam resolves that
dependency graph — depth, parent policy, and each dependent's contribution — rather than charting
every claim as if it stood alone. It also flags whether a claim is a **system** claim (versus
non-system), by a stated word-list rule — a distinction that matters in practice because a system
claim can span multiple components (a client and a server, say), which may not both live in the
same codebase — and scores how *generic* an element is — a boilerplate bookend versus a real
mechanism — so attention lands on the elements that actually distinguish the claim.

## Pseudo-claims

**`--pseudo-claims`** (machine-readable form `--claims-only`) drafts *illustrative* claims from
evidence found in a codebase — a way to explore what claims a body of code might read on.

**Handle these with care.** A pseudo-claim is written in the voice of a patent claim, so out of
context it can read like an assertion about what a codebase actually practices. It is not — a
pseudo-claim is an illustrative draft, and CodeExam attaches fixed caveats to that effect. Keep them
labeled as drafts, not findings.

[[placeholder: link a `docs/` example of CE-generated pseudo-claims run on CodeExam's own codebase,
if that exemplary sample ships — an illustration only, carrying the caveat that it is an example and
not an assertion of what CodeExam embodies or practices.]]

## Methodology and defensibility

The features above are only as good as the method around them. Two techniques matter most:

- **`--synonymize`** deliberately rewrites a claim's wording *away* from the codebase's own
  identifiers. Its purpose is the reverse of a search: instead of using shared words to *find* code,
  it strips the shared words to *test* a match you already have. If retrieval still reaches the same
  code after the claim has been reworded away from that code's vocabulary, the match wasn't merely a
  lexical coincidence — it's a more robust finding than one that depended on the claim and the code
  happening to use the same terms.
- **Union-plus-probes.** On the hardest elements, no single method reaches the right code on its
  own — not CodeExam's automatic retrieval, and not a model navigating the code freely. What works
  is combining candidate sets: take the **union** of the targets each method proposes, then add a few
  **directed probes** (hand-chosen searches for code you suspect is involved), and chart against that
  combined set. On the most-documented hard element in our testing (#325 §7), that union-plus-probes
  set reached the right code where every method alone missed it — an outside yardstick for the
  approach, rather than CodeExam grading its own homework.

One boundary worth stating plainly: a **local** model asked to map a claim to code *independently*
tends to fabricate — it doesn't reliably make the vocabulary hop on its own. CodeExam's managed
pipeline makes that hop mechanically, which is why the rule is **pipeline-for-local, cloud-for-
independent**. See [`docs/model-support.md`](docs/model-support.md) and
[`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md).

## Related

- [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md) — multisect and `--claim-search`, the search
  layer under claim charting.
- [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md) — the verdict labels, `--mask-all`, and the
  determinism boundary the model operates within.
- [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) — `--reproducible` and the provenance header.
- [`docs/model-support.md`](docs/model-support.md) — which models can do chart work, per feature.
