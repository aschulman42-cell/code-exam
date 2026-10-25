# Examining code against patent claims

CodeExam grew out of source-code examination for patent litigation, and this page covers the
features built for that work: turning a patent claim into a code search, charting a claim element by
element against a codebase, handling dependent claims, and the methodology that makes the result
defensible. The same machinery works on any structured technical prose — a specification, a
requirements list — but patent claims are the demanding case it was designed for.

The most important part of a patent is its "claims." These are one-sentence descriptions of the technology. Each claim contains "limitations." These are components or elements of the claimed invention, and can include steps in a process or method. Software of course has components such as functions, classes, methods, data structures, etc. When software runs, it executes steps in a process or method.

Even for a reader with no interest in IP, the one-sentence form is a useful discipline: it forces a piece of technology to be stated as a set of named components or steps and the relations among them, with nothing left implicit. A developer can use it to say what a module actually does; a reviewer, to check that a design document and the code describe the same mechanism; an acquirer or an auditor, to compare two codebases at the level of mechanisms rather than files. And because real patent claims are written in the same form, a claim-style sentence drafted from code is the thing most directly comparable to a claim that a patent holder might one day assert against that code. Drafting such sentences from code is what [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md) does.

## A chart is a candidate match, not ground truth

Read this first, because everything below depends on it. A CodeExam claim chart records whether some
code is a **candidate match** for a reading of a claim — a reading you (or a party) supplied. A cell
marked `PRESENT` means the model found code that plausibly matches *that* reading of *that* element —
a match in substance, not a verbatim one; it does **not** necessarily mean the claim is infringed,
valid, or correct. Plaintiff and defendant can chart the same claim against the same code and reach
different results, and both charts can be internally sound: they encode different contentions, not
different facts. CodeExam is a tool for building and pressure-testing those contentions and surfacing
candidate matches, not an oracle that settles them. Treat every verdict as "this code is a candidate
match for a stated reading," and keep the reading visible. How that ability is grounded and tested
against real-world data, including charts that parties filed against open-source code, is in
[`CODEEXAM_CLAIM_CHARTS.md`](CODEEXAM_CLAIM_CHARTS.md), sections 3 to 5.

## From a claim to the code

The first problem is vocabulary: a claim is written in the drafter's language (as modified through
PTO examination), and the codebase names things its own way. Bridging that gap is the hard part, and CodeExam offers two routes:

- **`--claim-search <prose>`** — extract the distinctive terms from a claim (or spec, or
  requirement) and run them as a multisect search (see [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md)),
  optionally summarizing each match with an LLM.
- **`--claim-locate <prose>`** — propose candidate symbols from the claim, verify them against the
  index (discarding ones that don't exist), navigate a hop from the survivors, and emit a set of
  **targets** to chart. `--hunt` widens the search when the first pass comes up short.
- **In Chat and other MCP clients: `claim_elements` and `claim_candidates`** — the same splitter,
  and the deterministic half of `--claim-locate`'s retrieval (name match weighted by rarity, a
  search of function bodies, the direction check, sponge marking) as tools. The model supplies
  the per-element code words itself and reads the candidates with `extract` / `digest`; the
  audited chart stays `--claim-chart`. See [`CODEEXAM_MCP.md`](CODEEXAM_MCP.md).

## Claim charts

**`--claim-chart`** produces the core deliverable: a table with **one row per claim element**. The
division of labor is deliberate — **CodeExam's deterministic code owns the structure** (it splits
the claim into elements and builds the rows deterministically) and the **model (an LLM suitably
prompted by CodeExam) supplies the search words and the candidate picks, and fills the cells**
(the per-element verdict and its evidence). With
**`--targets`** you can point one chart at a specific set of candidate implementations at once — say
three functions that each might implement a limitation, or two versions of a codebase — and CodeExam
charts every element against all of them and merges the results into one table, so you see how each
element fares across the candidates side by side.

Each element gets a verdict with its citation: `PRESENT`, the function plainly implements the
element and a line from it is quoted; `ASSUMED`, a called function's name suggests it and the
implementation is not visible; `PARTIAL`, the code configures, prepares or partially addresses
it, with the gap stated; `ABSENT`, nothing in the function implements or references it. The
guidance the analysis model receives is quoted on
[`CODEEXAM_CLAIM_CHARTS.md`](CODEEXAM_CLAIM_CHARTS.md). A couple of features make a chart easier
to scrutinize rather than take at face value:

- **Support-count disclosure.** `--verdicts-out` writes a **verdicts file** — JSON saved alongside
  the chart — recording, for each element, the evidence behind its verdict: which code sites were
  cited, and how many of the examined sites supported the verdict versus went against it. This is
  where a **lone-support row** shows up — a `PRESENT` resting on a single supporting site when many
  were examined. Such a verdict isn't necessarily wrong, but a claim of presence backed by one site
  out of many is among the most worth checking by hand: a weak, uncorroborated match is likelier to
  be an over-reach than one that many sites agree on.
- **Where the model is.** Three steps are the model's: predicting, per element, the words an
  implementer's identifiers would carry (`--claim-locate`, and a chart run without `--targets`);
  choosing implementers among the real symbols the search returned (`--claim-locate`); and
  judging each target against every element (the cells). The symbol search, its caps and gates,
  the navigation hop, the merge of verdicts into rows and every count are deterministic. Two
  engines, or one cloud engine run twice, can examine different code before any verdict
  differs. The reproducibility controls that pin the model side, and the provenance header that
  records engine/model/build, are in [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).

`--chart-html` renders the chart as a printable page and `--chart-md` as a Markdown file that wraps
and prints (one section per element, no wide table; `--chart-md-layout table` writes the table the
command prints instead); `--chart-notes` attaches annotations from a file you provide to either.

## Dependent claims

A claim set is a graph, not a list: dependent claims narrow their parents. CodeExam resolves that
dependency graph — depth, parent policy, and each dependent's contribution — rather than charting
every claim as if it stood alone. It also flags whether a claim is a **system** claim (versus
non-system), by a stated word-list rule — a distinction that matters in practice because a system
claim can span multiple components (a client and a server, say), which may not both live in the
same codebase — and scores how *generic* an element is — a boilerplate bookend versus a real
mechanism — so attention lands on the elements that actually distinguish the claim.

## Pseudo-claims

**`--pseudo-claims`** drafts *illustrative* claims from evidence found in a codebase — a way to
explore what claims a body of code might read on. A pseudo-claim is written in the voice of a patent
claim, so out of context it can read like an assertion about what a codebase actually practices; it
is not — it is an illustrative draft carrying fixed non-admission caveats. Keep them labeled as
drafts, not findings.

With `--claim-schema` (experimental) the drafter fills a claim *object* instead of writing text:
its preamble forms, dependent kinds and counts are the litigated population's and CodeExam renders
the claim, so a draft's frame reads like the claims CodeExam is tested against while its substance
stays the model's.

Pseudo-claims have their own page: see [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md) for
what they are and are not, how to run them (explicit anchors, the candidates arc, and the
one-command `--filter … --llm` form), the model / air-gap requirements, and examples.

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
independent**. See [`docs/model-support.md`](model-support.md) and
[`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md).

### An ABSENT row is only as strong as the target set

A chart's rows are verdicts on **the code that was examined**, not on the
codebase. For a PRESENT row that distinction is mostly harmless: the row names a
`file@function`, so a reader can open it and judge. A wrong PRESENT is visibly
wrong, and it is self-correcting under review.

An ABSENT row carries no such handle. "Not found here" reads the same whether the
examined set contained the best candidate and ruled it out, or never contained it
at all. So the two failures are not symmetric:

- a **PRESENT** row that cites the wrong function is *conspicuously* wrong;
- an **ABSENT** row that skipped the right function looks clean and is wrong.

This matters most in the situation an opponent will look for first: the codebase
contains something that *resembles* the missing limitation. If a limitation
speaks of "determining a rate from the remaining playback time" and the codebase
has an adaptive bitrate selector that picks a rate from buffered duration, a chart
that says only "ABSENT" invites the obvious question — *did you look at it?* — and
has no answer. A chart that says "we examined
`AdaptiveTrackSelection::updateSelectedTrack`; it selects a track from bandwidth
estimates and buffered duration, not from a remaining time before a set
reproduction start time, so the limitation is unmet" answers it in advance.

**Before relying on an all-ABSENT or mostly-ABSENT chart, read the chart's own
`Analysed targets` section and ask whether it contains the code an opponent would
raise.** CodeExam prints that list precisely so this is checkable; it is the
audit surface for a negative. If the plausible candidates are missing, the chart
has not yet established absence — it has established that retrieval did not
surface them, which is a different and much weaker statement.

The remedy is the union-plus-probes method above, applied to negatives as well as
to hard positives: add directed probes for the code you expect an opponent to
cite, re-chart against the combined set, and let the chart show those candidates
examined and distinguished. A negative built that way is defensible. A negative
built from automatic retrieval alone is not, however unanimous its agreement
counts look.

> **Agreement counts do not fix this.** A row reading `ABSENT (37 of 37)` means
> 37 examined functions did not meet the limitation. If the best candidate was
> not among the 37, unanimity measures the targets, not the codebase.

## Related

- [`CODEEXAM_CLAIM_CHARTS.md`](CODEEXAM_CLAIM_CHARTS.md) — what claim charting can do today, the
  real-world filings it is tested against, the air-gapped goal and the plan.
- [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md) — multisect and `--claim-search`, the search
  layer under claim charting.
- [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md) — the verdict labels, `--mask-all`, and the
  determinism boundary the model operates within.
- [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) — `--reproducible` and the provenance header.
- [`docs/model-support.md`](model-support.md) — which models can do chart work, per feature.
