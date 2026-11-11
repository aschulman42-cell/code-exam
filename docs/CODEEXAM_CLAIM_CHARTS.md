# Claim charts: a patent claim against source code, one element at a time

*Status as of 2026-11-09. This page says what claim charting does today and where the work is
going. The tests behind it, the public filings whose charts cite open-source code, the
agreement measurements on them and the self-test, are on
[`CODEEXAM_CLAIM_CHARTS_TESTS.md`](CODEEXAM_CLAIM_CHARTS_TESTS.md); section 3 below is the
one-line version of each. Every number here carries the date it was measured, and most are one
sample.*

**What a claim chart is, and why this page makes a fuss of it.** A claim chart sets a patent
claim against a product, or against prior art, one row for each limitation (a discrete element
or component of an invention, including a step in a process or method) that makes up the claim,
with the evidence that the limitation is or is not met. In litigation it is the instrument that
turns "does this infringe" into findings a reader can check one limitation at a time; its forms,
uses and pitfalls are the subject of the project author's book,
[Claim Charts](https://www.softwarelitigationconsulting.com/claim-charts-book/), which stands in
here for a fuller account. Why a code-examination tool concerns itself with patent claims at all
is answered in [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md); this page is about
charting them against source code.

Mapping a claim to code is hard because the prose and the code were written years apart, by
different people, for different purposes, at different granularity, and share little vocabulary:
the claim says "determining a code rate based on the remaining time", the code says
`determineIdealSelectedIndex` and spreads the behavior over three functions. The obvious answer,
natural-language code search as CodeBERT and its successors learn it, was trained on functions
paired with their own docstrings, prose that originated with the code and sits beside it; a
claim limitation is neither, and the paired data that would teach a model the claim-to-code
register, litigated claims matched to the code they read on, barely exists: the filings in
section 4 are most of what is public. The embedding history is on
[#322](https://github.com/aschulman42-cell/code-exam/issues/322).

The other obvious answer is to hand the whole job to an AI assistant, and section 10 notes that
ChatGPT, Claude or Gemini will draft a chart on request. CodeExam does not, for two reasons. A
chart that will be defended has to be explainable beyond "this is what the AI said": every name
it cites must exist in the code, every verdict must rest on quoted lines, and the candidates it
examined and rejected belong on the page beside the ones it accepted. And confidential code
under a protective order is examined on an air-gapped laptop with a small local model, which
cannot be asked to chart a claim unaided and does not fabricate when the search, the candidate
lists and the verification are code around it. The targets, verdicts and provenance that fill
this page are the price of a chart a reader can check and a model that small can produce.

This page is the account of the feature: what a CodeExam claim chart is, how the claim
commands fit together, what you can do with them today, how well they work in one line per
test, the goal the work is aimed at, how far it is from that goal, and the plan. The commands
are listed in section 2, with their reference entries in [`cli.md`](cli.md) and the concepts
in [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md). The tests themselves are on
[`CODEEXAM_CLAIM_CHARTS_TESTS.md`](CODEEXAM_CLAIM_CHARTS_TESTS.md): the real-world data the
work is grounded in, the public filings that cite open-source code and the tests run on them,
the dated examples and the self-test. Four working pages,
[`claim-chart-agreement.md`](claim-chart-agreement.md),
[`real-world-claim-charts.md`](real-world-claim-charts.md),
[`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md) and
[`claims-pipeline-state.md`](claims-pipeline-state.md), still hold the measurements at
length; the intent is to retire those four once the tests page carries what they hold, which
it does not yet.

## Terms

**The words on this page are defined once, on [`CODEEXAM_JARGON.md`](CODEEXAM_JARGON.md).**
This page leans on: model and embedding model (two kinds of model appear here; the jargon
page's first two rows tell them apart), locator, target, nominee, the verdict labels
`PRESENT` / `PARTIAL` / `ASSUMED` / `ABSENT`, merge, agreement tag, verdicts file, mechanism,
register, drafter, HOF and reproducible. One sense matters here: a *candidate* on this page is
a target, a `file@function` judged against the claim's elements, not the pseudo-claims pages'
candidate, which is a mechanism the grouper proposes.

## 1. What a CodeExam claim chart is, and is not

A CodeExam claim chart records, for each element of a patent claim and each code target, whether
the model found code that plausibly meets one reading of that element, with the lines it relied
on. A `PRESENT` cell is a **candidate match for a stated reading**, a lead to verify by reading
the cited lines. It is not a finding that the limitation is met, and it says nothing about
validity or infringement. An `ABSENT` cell's citation is the element's nearest miss: the
candidate its own retrieval ranked first, followed by the other candidates examined for the
element and the reason each was rejected; it is not a finding either. A cited cell also names
any candidate the element's retrieval ranked above the cited one that the model rated lower,
with its reason. When a CodeExam chart is compared with a chart a party filed in court, a match
is **agreement with that party**: plaintiff and defendant chart the same claim against the same
code and reach different results, and both can be internally sound, because they encode
different contentions. CodeExam is a tool for building and pressure-testing contentions and for
surfacing *candidates*, not an oracle that settles them. The verdict labels and the methodology are
in [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md); read its first section before
anything here. No page before this one listed every claim-related command; section 2 does.

**Why "CodeExam claim chart" rather than "claim chart".** A chart a party files is advocacy
prepared by counsel, often with input from an expert: it rests on a claim construction the party
will argue, cites evidence the party will stand behind, and is signed. A CodeExam claim chart is
a working draft produced by a program. Its rows are CodeExam's deterministic split of the claim,
or the practitioner's own rows through `--elements`; its candidate code is what retrieval or the
examiner supplied; its verdicts and citations are a model's, checked against the index for
existence but not for meaning. It is the starting point for the examiner's own chart, to be read
with the cited lines open, and nothing in it should be dropped-in as-is into a contention,
declaration or expert report, however good the charts become, in CodeExam or in the planned
[CodeClaim](CODEEXAM_CODECLAIM.md). A code examiner must *verify* code references (and strive
to verify assertions that a claim element is *absent* in the code). The parts an AI model fills
can be wrong in ways a deterministic table cannot: a verdict argued from the wrong lines, a
citation that exists but does not say what the cell claims. Which parts are deterministic and
which are the model's is stated in [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md)
under "Determinism around the model" and in
[`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md).

## 2. What you can do today

### How the claim commands fit together

The claim commands are not several ways of doing one thing. The recommended path is two of
them in sequence: `--claim-locate` finds the code a claim reads on and writes a targets file,
and `--claim-chart --targets` charts that file. The rest are an earlier path, a measurement,
and the reverse direction.

| command | unit | the model supplies | you get | place |
|---|---|---|---|---|
| `--claim-locate` | one search per element | code words per element, then the pick among the real names found | a targets file with provenance | step 2 of the recommended path |
| `--claim-chart --targets @file` | one verdict per target per element | the cell verdicts | the chart, its verdicts file, HTML or Markdown | step 3 of the recommended path |
| `--claim-chart` alone | per element, its own retrieval | code words, then the verdicts | the same chart on targets it found itself | the one-command form: wider, less exact, and what the measurements call "its own retrieval" |
| `--claim-search`, `--claim-analyze` | one search for the whole claim, over file bodies | regex search terms; an analysis of the top matches | ranked files and functions; with `--claim-text`, one function mapped to the claim | the earlier whole-claim path, kept as the quick screen across indexes and as the GUI's claim surface |
| `--embed-distance` | one element, or with `@<file>` every element of a claim, against every mechanism of the index | nothing; an embedding model ranks, no LLM | the mechanisms by distance, the median as the baseline; per claim, a table of each element's nearest | a measurement, not a search step (section 8) |
| `--pseudo-claims`, `--synonymize`, `--claims-loop` | code to claim | the drafted claim; its rewording | pseudo-claims, and the self-test's claims | the reverse direction: [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md) |

Whole-claim and per-element are the two retrieval mechanisms, with a blind spot each (the
table below, after the flag lists). The roadmap's items (f) and (g) in section 7 name the fold
of the earlier path into the per-element one; until then both ship, and the GUI carries the
earlier one.

**The commands, in one place.** Every claim-related flag, by the direction it works in. Each
runs on a cloud engine or a local GGUF model alike, and `--air-gapped` enforces no cloud; any of
them can be run on an open-source codebase today, which is where the examples below come from.
Reference entries are in [`cli.md`](cli.md) and `--help`; the concepts in
[`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) and
[`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md); the working notes in
[`claims-pipeline-state.md`](claims-pipeline-state.md).

The flow, in three steps:

```text
[1. Split]                      [2. Retrieve and verify]           [3. Chart]
claim text -> element rows  ->  names searched, verified,      ->  per element and target:
(the splitter, or --elements)   navigated: --claim-locate          PRESENT / PARTIAL / ASSUMED /
                                writes a targets file               ABSENT with cited lines:
                                                                    --claim-chart --targets
```

Deterministic code owns steps 1 and 3's table; a model supplies step 2's code words and
choices and step 3's cell verdicts. The whole-claim search (`--claim-search`, multisect) is an
alternative step 2 over file bodies; pseudo-claims run the arrow backwards.

**Retrieval and target discovery** (claim to code, per element):

- `--claim-locate <claim>` splits the claim into elements, asks the model for the code words each
  element would wear, searches the index's symbol names for them, verifies every name against the
  index, navigates callers and callees (promoting callees up to two hops down since 2026-10-22,
  bounded), and has the model choose implementers; it writes a targets file with provenance
  through `--targets-out`.
- `--blind` hides file paths and the codebase's identity from the model, so a hit is discovery
  rather than recall. `--runs <n>` repeats the cycle and keeps what any run proposed, tallied.
  `--per-element-select` chooses implementers with one model call per element instead of one
  pooled call (measured: fewer, denser targets, worse recall on the crux symbol).
- `--hunt` lets the model drive its own search of the symbol table, capped by `--hunt-rounds` and
  `--hunt-calls`; `--no-hunt` forces it off. `--propose-from-priors` is the legacy path, names
  from the model's own knowledge, useless on confidential code. `--include-tests` admits test,
  mock, benchmark and example symbols as candidates (held back by directory, file name or
  symbol name since 2026-10-22; on an index that is nearly all such code, a samples corpus,
  the gate turns itself off and the run says so, since 2026-11-03); `--no-navigate` skips the
  hop (absent from `--help`).
- `--embed-distance "<claim element>"` (since 2026-11-07) ranks the index's mechanisms
  (`--build-mechanisms`, no model) by distance to the element under a local embedding model and
  prints the median as the baseline, what an unrelated mechanism scores; `--filter <function>`
  shows where a believed implementer's mechanism ranks, `-v` lists each nearest mechanism's
  functions with their line ranges, and `@<claim file>` (since 2026-11-09) runs every element
  of a claim in one process and ends with a table of each element's nearest mechanism and
  margin. No LLM at all, and a measurement rather than a search step: it says how near an
  element sits to the code's own vocabulary, the gap section 8 measures.

**Chart generation:**

- `--claim-chart <claim>` returns, per target and element, `PRESENT`, `PARTIAL`, `ASSUMED` or
  `ABSENT` with line citations, a coverage line per element and a provenance header naming the
  engine, the build, the targets checksum and, for a supplied targets file, its origin: whether
  `--claim-locate` wrote it, on this run's index and this run's claim text or on others. Targets
  come from `--targets` (a list, or the file `--claim-locate` wrote) or, with none given, from
  per-element retrieval.
- Per-element retrieval is sized by four flags: `--targets-per-element` (candidates analysed
  per element, default 3), `--max-retrieved-targets` (the cost ceiling on the total, default
  30), `--whole-claim-targets` (targets from the claim's own words, default 5) and
  `--concentration-targets` (a file several elements point at, default 3).
- `--elements @file` supplies the rows, one limitation per line, in place of the heuristic split.
  `--claim-family` charts claim 1 and every dependent beneath it; `--claim-number` picks a claim
  from a numbered file; `--dep-synonyms` lets a narrowing dependent donate vocabulary to the
  parent row it narrows (off by default, measured to dilute). `--no-callees` omits callee bodies;
  `--scope-note` states a structural fact once; `--include-op` admits binary string dumps.

**Output and formatting:**

- `--verdicts-out` writes the verdicts file (JSON): the merge's input and what every replay
  reads. `--chart-html` writes a self-contained printable page and `--chart-md` the chart
  as a Markdown file, one section per element and wrapped at 100 columns, so it reads and prints
  without a wide table (stdout keeps the table, and `--chart-md-layout table` writes that table
  to the file instead); `--chart-format brief` is the page's traditional two-column layout;
  `--chart-html-from <verdicts.json>` re-renders either file without a model; and `--chart-notes`,
  `--chart-title` and `--chart-subtitle` dress them.

**Whole-claim search** (claim to code, one search for the entire claim):

- `--claim-search <claim>` extracts the claim's distinctive terms and runs them as a multisect
  search over file bodies, gated by `--min-terms`; `--claim-file` reads the claim from a file.
- `--claim-analyze <claim>` is the end-to-end form: extract, search, analyze the top matches;
  given a function and `--claim-text` it element-maps the claim against that one function.

**Pseudo-claims and the self-test** (code to claim):

- `--pseudo-claims <anchors>` drafts claim-shaped descriptions of what code does, one claim per
  anchor group, with the anchors attached; `--claims-only` writes the machine-readable claims and
  their anchors sidecar; `--claim-class` sets the statutory class; `--claim-schema` (experimental)
  has the drafter fill a claim object whose frame is the litigated population's;
  `--pseudo-claims-chart` renders each draft as a chart; `--doc-anchors` adds documentation
  anchors; `--triage` ranks a run's drafts deterministically; `--pseudo-out` and
  `--include-evidence-pack` shape the artifact. `--candidates <file>` discovers the anchor groups
  to draft from, deterministically, with `--filter` and `--group-by` to narrow and `--rank` to
  order them by a model's priority; `--ground-truth` scores a candidates run against a
  hand-authored anchors list; `--shape-profile` names the population a draft should resemble
  (litigated, the default; ai-ml, 841 AI/ML claim 1s; randpat, 5,395 all-art independents).
- `--synonymize <claim>` rewrites a claim's wording away from the vocabulary a programmer would
  use, one model call per limitation, so a corpus with known answers becomes a test of retrieval
  (`--synonymize-out`, `--claims-per-line`, `--single-claim`).
- `--claims-loop <chart>` fills a pseudo-claim chart's empty cells and measures draft-to-retrieve
  agreement, flagging claims that need a redraft.

**Engines.** `--llm` picks a cloud provider and `--model` a GGUF; `--local-reasoning off` is
required for a thinking model such as Gemma 4; `--reproducible` pins a run
([`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)).

**In the GUI and in Chat.** The GUI carries Claim Search and Claim Analyze (with an LLM
claim-search variant and a claim-text box) and nothing else of the family: `--claim-locate`,
`--claim-chart`, `--pseudo-claims` and `--synonymize` have no GUI surface (#343). In Chat and
other MCP clients the `claim_elements` and `claim_candidates` tools expose the splitter and the
deterministic half of `--claim-locate`'s retrieval; the audited chart stays on the command line
([`CODEEXAM_MCP.md`](CODEEXAM_MCP.md)).

**Documentation.** [`cli.md`](cli.md) has entries for `--claim-search`, `--claim-analyze`,
`--claim-chart` and `--embed-distance` and names the rest of the family only in passing;
`--help` documents every flag above. The dated count of what each page covered is a record
on the tests page.

**Two retrieval mechanisms, each with a blind spot** (from the pipeline notes, 2026-08):

| | whole-claim (`multisect`, `--claim-search`) | per-element (`--claim-locate`, `--claim-chart`) |
|---|---|---|
| unit | one search for the entire claim | one search per limitation |
| the model emits | regex search terms | code words per element |
| searched against | file body text | symbol names only |
| gate | quorum (`--min-terms`) | none; ranked, 25 per element,<br>then up to 35 more by name at the cap (2026-10-22) |
| blind spot | well-named single-purpose functions | badly-named functions;<br>names carrying none of the claim's words |

**What the mechanisms index adds.** `--build-mechanisms` writes, beside an index and with no
model, a record for every small group of functions that do one thing together, labeled from
the code (`[class] AdaptiveTrackSelection`, `[file] frame.c / x264`, `[cmd] --claim-chart`);
`--toc` and `--mechanisms` list the records, and `--describe` adds a one-sentence description
to each ([`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)). For claim charting the index is
a second unit beside the symbol table: a claim element is matched against a few hundred to a
few thousand short labeled groups instead of tens of thousands of bare names, and every match
is two short texts a person can read. What ships today is the measurement, `--embed-distance`
above, which puts an element against every record under a local embedding model and says
where a believed implementer's group ranks. Retrieval from the index inside `--claim-locate`,
the shortlist per element that the measurements on [`describe-reach.md`](describe-reach.md)
support, is proposed on [#359](https://github.com/aschulman42-cell/code-exam/issues/359) and
not built.

**Sample charts.** Public sample charts with their verdicts files, for a reader to open, are a
pending item (`public-sample-claim-charts`); as one initial example, see a snippet from
[CodeExam.ai](https://codeexam.ai):

<img src="https://codeexam.ai/airo-assets/images/pages/home/screenshot-claim-chart" alt="A portion of a patent claim chart generated by CodeExam" width="760">

### How a chart is made, and how to read a cell

Four terms this section uses. A **target** is a candidate: one `file@function` from the code
under examination, put forward as a possible match for an element of the claim; the chart
judges every target against every element. An **implementer** is a programmer who wrote, or
would have written, the kind of code the claim describes; the model is asked what such a person
would have named things. A **nominee** is a target that an element's own search put forward, in
the order the search ranked it. The **merge** is the deterministic step that turns the
per-target verdicts into the one row per element the chart shows.

**Which parts are a model's, and which are code.** Three steps are a model's: predicting, for
each element, the words an implementer's function names would carry (step 2 above, in
`--claim-locate`, and again in `--claim-chart` when no `--targets` file is given); choosing,
among the real names the search returned, the ones most likely to implement the element (step
2, `--claim-locate`); and judging each target against each element (step 3, the cells).
Everything else is deterministic code, the same answer every time from the same index:

- the **symbol search**: the predicted words matched against the names of the functions and
  classes in the index, a rarer word counting for more than a common one (the rarity ranking);
- the **candidate caps**: at most 25 matched names per element go forward to the model, with up
  to 35 more offered by name alone (2026-10-22);
- the **test gate**: test, mock, benchmark and example code is held back from the candidates
  unless `--include-tests` admits it, or the index is nearly all such code, when the gate
  turns itself off and the run says so; a run in which every match was held back says that,
  not "no symbol matches";
- the **navigation hop**: from each matched name, one step along the call graph to the functions
  it calls and the functions that call it, so a well-named wrapper leads to the code that does
  the work;
- the **merge** of verdicts into rows, and every count, tag and line the chart prints.

So two engines, or one cloud engine run twice, can examine different code before any verdict
differs: on 2026-10-23 the Claude and Gemma 4 charts of the '101 against ExoPlayer shared 5 of
their 31 targets each.

**What the analysis model is told.** The target function, with the functions it calls shown
beneath it and the file's own line numbers in the margin; the claim; and the elements,
numbered. One question per element: "is this claim limitation MET by this code? It does not
answer whether the recited feature appears." The two usually coincide, and they come apart when
a limitation requires something to be absent: if the claim says a step is done without a hash
and the code hashes, the feature appears and the limitation is not met, so the verdict is
`ABSENT`. The labels, in the prompt's words:

- `PRESENT`: "The code in this function plainly implements the element. You MUST quote the
  specific line(s) that perform the element's action, verbatim. If you cannot quote such a line
  from THIS function, the label is not PRESENT."
- `ASSUMED`: "The function calls another function whose NAME suggests it implements the
  element, but the actual implementation is not visible in this code. State what you are
  assuming and why."
- `PARTIAL`: "The code configures, prepares, or partially addresses the element, but does not
  fully implement it. Explain the gap."
- `ABSENT`: "No code in this function implements or references this element."

Its rules: describe what the code does before labeling; "A suggestive function or variable NAME
is not the same as implementation"; configuration that would be used by an implementation is
`PARTIAL`; "ADJACENT ROLE IS NOT IMPLEMENTATION: code that reads, hashes, displays, records, or
consumes the RESULTS of a mechanism does not implement that mechanism"; cite the margin's line
numbers exactly, because "an unverifiable citation is worse than none". It answers with one line
per element, `VERDICT <n>: <PRESENT|PARTIAL|ASSUMED|ABSENT> | <one sentence, and the line
number(s) ... or "no line" if none>`, and `ABSENT` "is a correct and expected answer" for the
elements the function has nothing to do with. The text is `buildClaimAnalyzePrompt` in
`src/commands/analyze.js` and `buildChartAnalysisPrompt` in `src/commands/claim-chart.js`; this
page quotes it rather than paraphrasing it.

**From verdicts to a row.** Every target is judged on every element, so a chart with 31 targets
and 9 elements holds 279 verdicts (the '101 chart of 2026-10-23). The merge shows, per element,
the best label any target earned. When two targets earn the same label, the row cites the one
that is `PRESENT` on the most elements of the claim, then the element's own nominee, then
whichever was analysed first. Beside the label, the **agreement tag** reads the tally: "(1 of
31; 30 ABSENT)" means one target earned this label and thirty said `ABSENT`. Below the table,
the **Support line** counts the rows that rest on a single target and names the weakest. An
`ABSENT` row cites the element's nearest miss, labeled "closest examined", then the other
nominees it examined, labeled "also examined", each with the model's reason; a cited row names
any candidate the element's search ranked above the cited one that the model rated lower, with
its label and reason. On the 2026-10-23 re-run, row 6 of the '101 chart cites
`getAvailableLiveDurationUs` (`PARTIAL`, 1 of 31) and then names `determineIdealSelectedIndex`,
rated `ABSENT`: "selection is based on bandwidth, not on remaining time before a reproduction
start time". None of these citations is a finding.

Why the chart does this rather than saying `ABSENT` and stopping: an `ABSENT` row is the one
an opponent tests first, and the only row with no handle. A wrong `PRESENT` names a function
and is conspicuously wrong; a wrong `ABSENT` looks clean. "Not found here" reads the same
whether the best candidate was examined and ruled out or was never examined, so the row says
what was examined and why it was rejected, and a reader who disagrees can disagree at the right
place. The same instinct marks the rows for a negative limitation, where presence is the
problem. CodeExam's role is to put the likely point of dispute on the page, not under it. The
argument, with this claim as its example, is in
[`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) under "An ABSENT row is only as strong
as the target set".

**The verdicts file.** `--verdicts-out` writes it as JSON (format `codeexam-chart-verdicts/1`):
for every target, in the order analysed, each element's raw verdict and note as the merge
received them, and which element nominated the target at what rank; the targets that produced
no verdict, with the reason; the claim's source and length; the targets file's path, its header
and the origin comparison; and the family block under `--claim-family`. It is what
`--chart-html-from` re-renders without a model, what `scripts/engine-qualify.mjs` grades an
engine on, and what `src/core/loop-score.js` and `scripts/recap-chart-agreement.mjs` score.

**One sample.** A cloud engine at temperature 0 is not pinned and a local GGUF at greedy
decoding is; what one rerun moved is measured on the tests page under "One sample", and the
controls are in [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).

## 3. How well it works

Dated one-line results, each ending with where its detail is. Section 4 names the filings and
section 5 the self-test; [`CODEEXAM_CLAIM_CHARTS_TESTS.md`](CODEEXAM_CLAIM_CHARTS_TESTS.md)
holds the table, the method and the limits behind every figure below, one dated section per
test. Every figure is one sample per cell, and a match with a litigant's chart is agreement
with that party, not correctness.

- **Against fourteen public filings whose charts cite open-source code.** `--claim-locate`
  agrees with the litigant on 26 of 153 cited names in plain mode and 27 blind (2026-10-22,
  Claude Sonnet 4.6), up from 15 and 14 the day before through four retrieval changes;
  `--claim-chart` on its own retrieval agrees per element on 9 of 153, and the harness does not
  yet run the chart on the targets `--claim-locate` wrote, the pipeline's own configuration.
  Where a chart cites a mechanism's API the locator finds it; where it walks arithmetic, or the
  claim's words have no footprint in the names, the locator stops at the API or finds nothing.
  Detail: section 4, the agreement section of the tests page, and
  [`claim-chart-agreement.md`](claim-chart-agreement.md), the first run written up with its
  method.
- **A real patent against a real codebase, unaided.** On the '101 patent's claim 1 against
  ExoPlayer 3, `--claim-locate` reached `AdaptiveTrackSelection::determineIdealSelectedIndex`,
  the step the claim turns on, by navigation from a function the model named (Claude,
  2026-08-13). The same element under `--embed-distance` puts that class's mechanism at 2,319
  of 10,828 (2026-11-09): the gap is register, not breadth (section 8). Detail: the dated
  examples on the tests page, the run table on
  [`claims-pipeline-state.md`](claims-pipeline-state.md), and `--embed-distance` on
  [`cli.md`](cli.md).
- **A negative control.** A claim paired with a codebase it cannot read on scored 4 of 4
  `ABSENT`. Detail: the three-tiers section of the tests page, and the pinned negative every
  engine must pass on [`engine-qualification.md`](engine-qualification.md).
- **What a rerun moves.** Two Claude runs of the same '101 chart on identical inputs moved 6 of
  279 verdicts and 3 of 9 rows (2026-10-23); a local GGUF at greedy decoding reproduced its
  target lists byte for byte and its verdicts character for character. Detail: the one-sample
  section of the tests page, and the controls that pin the model side on
  [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).
- **The self-test (HOF, section 5).** With the mechanisms' labels and member names as the text
  and the shipped embedding model, the mechanism holding a drafted claim's anchor ranks first
  for 61% of 332 anchors over eight indexes and within 25 for 96%, against 35% at the function
  rung for `--claim-locate` on the same claims (2026-11-05); a model choosing among the five
  nearest lifts the 61% to 84% on those claims, and not on the litigants' (2026-11-06). Detail:
  section 5, the self-test section of the tests page, and the measurement itself on
  [`describe-reach.md`](describe-reach.md).
- **Gemma 4 12B, locally, on a 16 GB GPU laptop.** It passed the qualification pair on
  2026-09-29 (9 of 9 `ABSENT` on the '101 against ExoPlayer 3, 10 of 11 `PRESENT` on the TLS
  demo). On 2026-10-23, end to end on targets it found itself
  ([#347](https://github.com/aschulman42-cell/code-exam/issues/347)): the '101 against
  ExoPlayer 3, 0 `PRESENT` · 5 `PARTIAL` · 3 `ABSENT` across 8 limitations, the same on two
  builds; Malikie v. Foundry on secp256k1, 2 `PRESENT` of 2; Malikie v. MARA on Bitcoin Core, 2
  `PRESENT` · 5 `ASSUMED` of 7; the TLS demo, 10 `PRESENT` of 10. As the locator on 24 claims
  CodeExam drafted from ExoPlayer 3 and sr_gh, it reached the drafted function for 57% of 88
  anchors and the file for 86%; the embedding route on the same claims put the right mechanism
  first for 58% and within 25 for 98%, against 6% and 25% for a shuffled control (asus-CC,
  [#363](https://github.com/aschulman42-cell/code-exam/issues/363), 2026-11-07, not re-run
  here). Not yet shown locally: agreement with a litigant beyond those three pairs, and any
  step of the pipeline on code under a protective order. Detail: the Gemma 4 subsection of the
  tests page's self-test section, the qualification result on [`LOCAL_LLM.md`](LOCAL_LLM.md),
  and section 7's local-engines bullet.

## 4. Tested against real filings, in brief

Litigation records name an accused product, not a public codebase, so no public answer key
says "this claim reads on this code". The nearest thing is a chart a party filed that cites a
file or function of an open-source repository: advocacy, not an answer key, but a real claim
against real code, placed by someone with a stake. A search of CourtListener's RECAP archive
(2026-10-20) read 274 filed documents and found 49 that name three or more functions;
fourteen of them, each repository indexed at the commit the filing names, are the test set.
Among them: Malikie Innovations against Foundry, MARA and Core Scientific on
bitcoin-core/secp256k1 and Bitcoin Core (ECDSA signing, key generation, field and Montgomery
arithmetic); Securitize against tZERO on securitize-io/dstoken; FriendliAI against Hugging
Face on text-generation-inference (batching); R2 Solutions against Databricks on Apache Spark
(a sort-merge join); True Return Systems against MakerDAO on makerdao/dss. The full table, a
second table of further filings, and the charts that cite no code are on the tests page.

The agreement test scores `--claim-locate`'s choices against the litigant's names in both
directions and `--claim-chart` per element, blind and plain, one sample per row; the headline
numbers are in section 3, and every run, the three worked examples and the reading of the
misses are on [`CODEEXAM_CLAIM_CHARTS_TESTS.md`](CODEEXAM_CLAIM_CHARTS_TESTS.md). Four
patterns hold across the fourteen: where the chart cites the mechanism's API,
`--claim-locate` finds it; where the chart walks arithmetic, it stops at the API; where the
key is a complaint's pasted code or a different reading of the claim, zero overlap says
little about the locator; where the claim's vocabulary has no footprint in the names, the
search finds nothing at all. A match is agreement with that party: plaintiff and defendant
chart the same claim against the same code and reach different results, and any individual
litigant can be wrong.

**The populations the tool is tuned on.** The claims pipeline is calibrated on about 385
software patents asserted in litigation, claim 1 with its dependent chain, and on the USPTO's
Artificial Intelligence Patent Dataset for the subject matter CodeExam's AI/ML detectors
target. No single example is a yardstick: calibrate on a population, never on the case in
hand. The corpus, its measured shape and the fixtures in the repository are on the tests page.

## 5. The self-test, in three sentences

"Huffing our own fumes" (HOF) drafts a pseudo-claim from a mechanism of an index, records the
functions it was drafted from as the answer key, and then asks CodeExam's own claim search to
find that code from the claim alone; because the claim came from the code, the right answer is
known, which no public chart gives. The name is the caution: CodeExam wrote the claim and then
went looking, in the drafter's own register, so a round trip is a floor of capability and says
nothing about the register gap of a litigated claim ("code rate" for bitrate). Its bottom line
for the claim-to-code association that claim charting rests on, with Claude and with Gemma 4
locally, is in section 3; the ladder, the runs and where the work went next are on the tests
page and on [`CODEEXAM_PSEUDO_CLAIMS_TESTS.md`](CODEEXAM_PSEUDO_CLAIMS_TESTS.md).

## 6. The realistic goal

A chart of a real claim against a confidential codebase, produced on an air-gapped machine with
a local model on a 16 GB GPU laptop, for a source-code examiner to verify carefully and then
consider as the basis for a chart the examiner can defend in the terms of
[`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md)'s methodology section. Defensible
means: granular line or function evidence per row (citing a filename can provide a good lead,
but is generally not sufficiently granular); the target set stated, so an `ABSENT` row is read
as "absent from these targets"; reachability stated, which names were in the index at all;
verdict provenance, the engine, the build, the targets checksum and the command;
reproducibility under `--reproducible`; and the reading kept visible, since every verdict is a
candidate match for a stated reading. The cloud-engine path exists for open-source and
non-confidential code; the air-gapped path is the differentiated one for code under a
protective order.

Section 1's caution holds at the goal as much as today: the chart is a draft for the examiner's
own, the rows and the retrieval are CodeExam's and the verdicts are an AI model's, and a model's
citation can exist without saying what the cell claims. The aim is a draft close enough to what
contentions and expert reports contain that the examiner's work starts from it, never one used
as-is.

## 7. CodeExam's distance from that goal (as of 2026-11-09)

- **Local engines.** The model-support matrix (2026-09-08) marks claim charts, `--claim-locate`
  and `--claims-loop` `SUPPORTED` on Qwen3.5-27B, which needs a 24 GB-class card, and `DEGRADED`
  on Qwen3.5-9B, Gemma 3 12B in both builds, and Devstral Small. Gemma 4 12B Q4_K_M is the
  newest qualified local engine: on 2026-09-29 it passed both halves of the pinned qualification
  pair on the 16 GB laptop, 9 of 9 `ABSENT` on the '101 against ExoPlayer 3 and 10 of 11
  `PRESENT` on the TLS demo, where Gemma 3 12B fails the negative; it needs
  `--local-reasoning off` and the node-llama-cpp 3.22.1 bump. That result is written up on #330
  and in [`LOCAL_LLM.md`](LOCAL_LLM.md), not yet as a column of the matrix, so its per-feature
  status is unrecorded there; #330 also tracks the other 16 GB-class candidates. Local-model
  target generation, roadmap item (d), was not started as of 2026-10-22, when local charts
  took targets the model did not find; since 2026-10-23 Gemma 4 has run the whole path end to
  end on targets it found itself, on the '101, two Malikie filings and the TLS demo (section
  3, #347), and since 2026-11-07 it has drafted and located the self-test's claims on two
  indexes with no cloud call (#363). Those are single runs on a 16 GB GPU laptop; none is a
  default, and the matrix does not record them.
- **The roadmap, (a) to (h).**
    - (a) search by element, not whole claim: partly done; `--claim-locate` always did and
      `--claim-chart` since the per-element evidence change of 2026-08-11 (commit `e17e40d`),
      while `--claim-analyze`, `--claim-search` and `--claims-loop` are still whole-claim.
    - (b) finer splitting than `;`: partly done, `--elements @file` the escape hatch.
    - (c) multiple runs merged or voted: design corrected, cloud only.
    - (d) local target generation: run once end to end with Gemma 4 on three filings and the
      demo (2026-10-23, #347) and on the self-test's claims (2026-11-07, #363); not a default.
    - (e) the review document: the pipeline notes.
    - (f) fold `--claim-chart` into `--claim-analyze`: not started, blocked on (a).
    - (g) one end-to-end pipeline, retiring test-only commands: not started.
    - (h) GUI: not started, last.
- **Known mechanisms.** #300, claim analysis is function-scoped where the claim is
  system-scoped; #301, claim-search's keyword filtering severs the vocabulary bridge between
  patent and code; #303, multi-target per-element synthesis with callee-body context; #305,
  evidence is symbol-only, so documents, filenames, manifests, configs and external API calls
  cannot be cited; #343, name-only resolution and the claims-pipeline gap in the GUI and MCP.
  Plus the four the agreement test found, each modified on 2026-10-22 and re-measured on the
  tests page: substring word matching (bridged), one-hop navigation (a second hop), the test
  filter (widened), the pool at scale (reported, widened and tie-broken).
- **The numbers.** On fourteen real filings, `--claim-locate` agreed with the litigant on 15
  of 153 cited names on 2026-10-21 and on 26 plain and 27 blind after the four changes of
  2026-10-22, six blind and five plain of the gains traceable to a mechanism and the rest
  sampling at one sample per row; the run-by-run account, with the chart tier, is on the
  tests page. The charts CodeExam can defend today are cloud-engine charts with targets from
  `--claim-locate` or by hand, and, measured once each, Gemma 4 charts on its own targets.

## 8. Getting to the goal

In order, each step measured on the fourteen by the agreement harness before the next:

1. The four retrieval fixes the agreement test found (the tests page), the two small ones first
   (stemming in the symbol search, bridged 2026-10-22; the test filter, widened 2026-10-22),
   then navigation depth with same-class resolution (the second hop, 2026-10-22), then the pool
   at scale (reported, widened and tie-broken, 2026-10-22); each re-measured on the retrieval
   fixture and the ledger as well, population-wide.
2. The targets-fed `--claim-chart` step in the harness, scored by the model's labels, as the
   second tier.
3. The drafter test (`recap-chart-drafter-ceiling`), two halves: pseudo-claims drafted from
   the functions a party cited, compared element by element to the asserted claim with a floor
   and a control, to learn whether the drafter can express the party's theory at all; and, from
   2026-10-24, the same comparison for CodeExam's own top-ranked candidate groups (the
   `ce-seeded` step), to learn whether the tool reaches that theory unaided.
4. The next cohort: the substantive pairs of the tests page's Table B, once their garbled text
   is re-extracted (its note there), then the two non-GitHub cases with hand-set public
   repositories.
5. Per-element retrieval everywhere (a), then local-model target generation (d), one pipeline
   (f, g), and the GUI (h); the self-test for any index along the way; the public sample set.

Semantic search, matching a claim element to code by meaning rather than by shared names, has
moved from a step under consideration to a measured route.
[#322](https://github.com/aschulman42-cell/code-exam/issues/322) set out why it is not the easy
step it appears: patent-claim text and source code have to land in one embedding space, and a
claim's words need not occur in the code at all. The measurements since answer that in part. At
the function grain, code-text embeddings (CodeBERT and UniXcoder) against the fourteen filings'
cited functions, beside CodeExam's name search on the same names, are on
[`embedding-reach.md`](embedding-reach.md); at the mechanism grain, where the picture changed,
the mechanisms' labels and member names under a local embedding model reach most drafted
anchors and over half of the litigants' cited functions (2026-11-06), with no model reading any
code ([`describe-reach.md`](describe-reach.md); the figures are in "Where this points" below).
What shipped from it is the measurement command, next; what has not is a retrieval step that
uses it; and the gap it leaves is register, not vocabulary.

The one-command form of that measurement is `--embed-distance` ([`cli.md`](cli.md)):
`ce --ndx <index> --embed-distance "<claim element>"` ranks the index's mechanisms by distance
to the element under a local embedding model and prints the median as the baseline, what an
unrelated mechanism scores, so a reader can see on their own codebase and claim what the
measurement pages report in aggregate, before any model reads any code. With
`--filter <function>` it shows where a believed implementer's mechanism ranks: element 6 of the
'101 claim against ExoPlayer 3 puts `[class] AdaptiveTrackSelection / other`, the class holding
`determineIdealSelectedIndex`, at 2,319 of 10,828 (2026-11-09, the shipped nomic model; the
`describe-reach.md` measurement of 2026-11-06 scored the same pairing at 2,465), the register
gap in one line. With `-v` each nearest mechanism's functions print with their line ranges,
which makes the listing an ad-hoc claim-chart tester: type an element, open what it is near.
With `@<claim file>` in place of the quoted element (2026-11-09), every element of the claim
runs in one process, split as `--claim-chart` splits it or as an `--elements @list` gives it,
and a table closes the run: each element's nearest mechanism, its margin over the median and
the band's word, the whole '101 claim against ExoPlayer 3 in eight rows; `--embed-model
nomic,jina,coderank` runs the same claim under several models in turn and the table gains a
margin column per model, since which text to embed, and how near it lands, depends on the
embedding model.

**Where this points (2026-11-09).** The measurements since 2026-11-05 changed the shape of
step 5. The unit the data support is the mechanism, not the bare name: with the mechanisms'
labels and member names as the text and a local embedding model, the entry holding a drafted
claim's anchor ranks within 25 for 96% of anchors over eight indexes, and the entry holding a
litigant's cited function within 25 for 58% of names over the fourteen filings
([`describe-reach.md`](describe-reach.md)). So the next retrieval step is a shortlist of
mechanisms per element, drawn from the index with no model and read by one, feeding the
existing selection and the chart on the shortlist's functions
([#359](https://github.com/aschulman42-cell/code-exam/issues/359), stage 1), with the
symbol-table search as the fallback. In most measurements two texts per entry, fused by rank,
beat either alone, and which text to embed depends on the embedding model. The gap that
remains is register: no self-test claim says "code rate" for bitrate, and on the '101 it is
the rewrite of an element into the engineer's words, not a better embedder, that moves
`determineIdealSelectedIndex` from the thousands to the tens. Local models are measured for
every step but that rewrite, which Gemma 4 could not do (every sample kept "code rate",
2026-11-07). What a user can run today for each of these is the self-test and the measurement
command; the shortlist does not exist yet.

## 9. Some clarifications

- **No verified claim-to-code answer key exists.** Litigation typically names
  revenue-generating products, not public codebases; the filings in the tests page's Table A
  are advocacy, placed by a party with a stake, and a match with one is agreement with that
  party. Any individual litigant can be plain wrong (litigants are required to be reasonable,
  and allowed to be wrong).
- **A name match is a name match.** It is not a finding that the code meets the claim, and the
  litigant's names are the catalog's reading of a PDF.
- **One sample per row.** The cloud engine has no seed control; `--runs N` pools several.
- **The snapshot is the filing date, not the accused build.** The harness clones the repository
  at the commit the filing names, or the default branch on the filing date when it names none;
  the party may have read a release, a fork or a vendored copy, so a name absent from the
  snapshot may have existed in the build the party read, and the reverse.
- **Original assignee is not the asserting party** for roughly 165 of the first 385 litigated
  patents; who drafted a claim, and who sues on it, are often distinct.
- **The corpus is a sample**, selected by litigation exposure, skewed toward older,
  mass-asserted patents.
- **Model runs are not reproducible across days** at exploratory temperatures; use
  `--reproducible` for a pinned run.
- **None of this is legal analysis.** CodeExam does not construe claims.

## 10. Other AI tools that draft claim charts

General-purpose assistants draft claim charts on request. Asked for a chart of a claim against a
named open-source project, ChatGPT, Claude or Gemini will produce one with or without the code in
front of them, because the project may be in their training data (which is the motivation for
the `--blind` option). The project author's older notes on that, on Perplexity's patents beta,
and on GreyB's GPS claim-chart generator (a claim against prior-art patents or an uploaded PDF,
run there on two prior-art pairs) are towards the end of the
[softwarelitigationconsulting.com page on AI & patent claims](https://www.softwarelitigationconsulting.com/patclaim-ai-forthcoming-ai-related-ai-based-work-with-patent-claims),
and at other softwarelitigationconsulting.com sources cited therein.

A search on 2026-10-21 found the following cloud claim-chart services for licensing and
litigation teams, each described by its vendor and none verified here:

- &AI (evidence-of-use and invalidity charts, each citation reviewed before export),
- Patlytics (infringement, invalidity and charting, with evidence crawled from public sources),
- XLSCOUT's ClaimChart LLM (a patent number and target products in, a chart out),
- Solve Intelligence and
- Patdel Analytics.

Every one appears to chart against documents, manuals, specifications and web pages; none
describes reading source code, and none describes running off-line (air-gapped).

Differences from CodeExam's approach include:

- **Recall or discovery.** An assistant that has read a public codebase can reproduce a chart
  from memory, and nothing in its output says which. CodeExam's `--blind` hides the codebase's
  identity and paths, and the agreement test's blind and plain runs differ by one name at three
  filings, so a hit is discovery; on confidential code, memory is unavailable in any case.
- **Citations that exist.** A model writing a chart freely can cite a function that does not
  exist, or lines that say something else. CodeExam's deterministic code owns the symbol search
  and verifies every name against the index; the model proposes the words and the picks, and
  rates only code it was shown; the provenance header records what it was shown.
- **Confidentiality.** A chart of code under a protective order generally cannot go to a cloud
  service; see [`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md) on "fully
  containerized" environments. CodeExam's air-gapped path runs the same commands on a local
  model, at the cost section 7 states.
- **Speed and polish** are where the products lead: a chart in minutes, exported to Word, with
  evidence from documents CodeExam does not cite at all today (see issue #305).

## 11. Related

- [`CODEEXAM_CLAIM_CHARTS_TESTS.md`](CODEEXAM_CLAIM_CHARTS_TESTS.md) — the tests behind this
  page: the public filings, the agreement runs, the dated examples, the self-test and the
  Gemma 4 results.
- [`CODEEXAM_JARGON.md`](CODEEXAM_JARGON.md) — the words this page and the tests page use,
  each defined once.
- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — the concepts, the labels, the
  methodology and defensibility section.
- [`cli.md`](cli.md) — the flag reference (section 2 says what it lacks).
- [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md) — the mechanisms index, its labels and
  descriptions: the unit section 8 points at.
- [`embedding-reach.md`](embedding-reach.md), [`describe-reach.md`](describe-reach.md) — the
  embedding measurements behind section 8; `--embed-distance` ([`cli.md`](cli.md)) runs the
  same measurement on any index.
- [`CODEEXAM_CODECLAIM.md`](CODEEXAM_CODECLAIM.md) — CodeClaim, the planned tool pointed at
  patents: infringement and invalidity charts on one engine.
- [`claim-chart-agreement.md`](claim-chart-agreement.md) — the agreement harness, the fourteen
  and the measured runs.
- [`real-world-claim-charts.md`](real-world-claim-charts.md) — the search for public filings
  that cite code, and the catalog listing.
- [`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md) — the litigated corpus
  and the tiers of test, at length.
- [`claims-pipeline-state.md`](claims-pipeline-state.md) — the pipeline notes, the roadmap and
  the measurement ledger.
- [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md) — pseudo-claims;
  [`CODEEXAM_PSEUDO_CLAIMS_TESTS.md`](CODEEXAM_PSEUDO_CLAIMS_TESTS.md) — the self-test and the
  other tests behind them.
- [`LOCAL_LLM.md`](LOCAL_LLM.md), [`AIR_GAPPED.md`](AIR_GAPPED.md),
  [`model-support.md`](model-support.md) — local engines and what each can do.
