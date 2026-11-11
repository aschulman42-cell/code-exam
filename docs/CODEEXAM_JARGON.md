# CodeExam jargon

The claim-chart, pseudo-claim and mechanism features grew a vocabulary of their own, and the
pages that describe them use it without pause: a *drafter* writes a claim from a *mechanism*
the *grouper* found, a *locator* goes looking for the code, a *sidecar* holds the *anchors*,
and the *HOF* self-test scores the *round trip* on a *ladder*. This page defines each word
once, with where you meet it (a flag, a file, a line of output) and which pages lean on it.
The compact markers in CodeExam's output (`~`, `[test]`, `[unresolved]`, `[ambiguous]`) are
notation, not words; they are on [`CODEEXAM_NOTATION.md`](CODEEXAM_NOTATION.md).

How to read the table: it is one table in five groups, each opened by a bold row. Within a
group the rows are in reading order, not alphabetical: a term comes after the terms it is
built from. A word with two senses has two rows, each saying which sense it is ("candidate"
is one). Page names in the last column drop the `CODEEXAM_` prefix and `.md`; the lower-case
names are the working records behind the feature pages. Until 2026-11-11 these definitions
lived in four tables, one at the top of each of `CLAIM_CHARTS`, `CLAIM_CHARTS_TESTS`,
`PSEUDO_CLAIMS` and `PSEUDO_CLAIMS_TESTS`, written page by page; this page merges them, and
each of those pages now names the terms it leans on and points here.

| term | what it means | where you see it | pages |
|---|---|---|---|
| **Models and their roles** | | | |
| model, engine | an AI language model, an LLM: a cloud one through `--llm` (Claude, ChatGPT, Gemini) or a local one as a GGUF file through `--model` (Gemma 4, Qwen); "engine" means the same thing | `--llm claude`, `--model <path.gguf>`; the Engine line at the top of a chart or a HOF report | `CLAIM_CHARTS`, `CLAIM_CHARTS_TESTS`, `model-support` |
| embedding model | a model of another kind: it turns a text into a vector so two texts can be compared by distance, and generates no text; nomic is the shipped one, Qwen3-Embedding and others are options | `--embed-model`; `--embed-distance` | `CLAIM_CHARTS`, `describe-reach`, `embedding-reach` |
| GGUF, local model | a model file that runs on your own machine with no network: the air-gapped path | `--model <path.gguf>`; `--air-gapped`; [`LOCAL_LLM.md`](LOCAL_LLM.md) | `CLAIM_CHARTS`, `model-support` |
| reproducible | a pinned run: a local GGUF at greedy decoding repeats byte for byte, a cloud engine at temperature 0 does not | `--reproducible`; [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) | `CLAIM_CHARTS` |
| drafter | the model that writes the claim text: a pseudo-claim from a mechanism's code, or, in the self-test, the claim the locator is then asked to find | `--llm claude`, `--llm gemini`, `--model <gguf>` on `--pseudo-claims` | `PSEUDO_CLAIMS`, `PSEUDO_CLAIMS_TESTS`, `CLAIM_CHARTS`, `claim-chart-drafter-ceiling` |
| locator | `--claim-locate`: asks the model what an implementer would have named things, searches the index's symbol names, verifies every name against the index, navigates callers and callees, and has the model choose | `--claim-locate <claim>`; its `--targets-out` file | `CLAIM_CHARTS`, `CLAIM_CHARTS_TESTS`, `describe-reach` |
| implementer | a programmer who wrote, or would have written, the kind of code the claim describes; the model is asked what such a person would have named things | the code-words step of `--claim-locate` | `CLAIM_CHARTS` |
| chooser | a second stage in which a model reads the five nearest mechanisms' labels and picks one; a measurement, not a shipped command | [`describe-reach.md`](describe-reach.md), "Retrieve, then choose" | `CLAIM_CHARTS_TESTS`, `PSEUDO_CLAIMS_TESTS`, `describe-reach` |
| judge | the model asked to read one element of a drafted claim against the asserted claim or a rubric row and say `MET`, `PARTIAL` or `ABSENT` | the ceiling and rubric tables | `PSEUDO_CLAIMS_TESTS`, `claim-chart-drafter-ceiling` |
| **Claims and charts** | | | |
| claim chart | one row per element of a patent claim, each saying whether code was found that meets one reading of that element, with the lines it rests on | the output of `--claim-chart`; section 1 of `CLAIM_CHARTS` says what a CodeExam chart is and is not | `CLAIM_CHARTS`, `PATENT_CLAIMS` |
| element, limitation | one discrete part of a claim, a step or a component; CodeExam splits a claim into them, or `--elements @file` supplies them | the numbered rows of a chart | `CLAIM_CHARTS` |
| target | one `file@function` from the code under examination, judged against every element | the Targets line of a chart; the targets file | `CLAIM_CHARTS` |
| candidate (claim-charts sense) | a target: a `file@function` put forward to be judged against the elements. The pseudo-claims sense, a mechanism the grouper proposes, is a different thing; see its row under mechanisms | the Targets line of a chart; the candidate cap | `CLAIM_CHARTS` |
| targets file | the list of targets `--claim-locate` writes, each with its provenance, which `--claim-chart --targets` charts | `--targets-out <file>`, `--targets @file` | `CLAIM_CHARTS` |
| nominee | a target that an element's own search put forward, in the order the search ranked it | "nominated by element N at rank R" in the verdicts file | `CLAIM_CHARTS` |
| navigation hop | one step along the call graph from a matched name to what it calls and what calls it, up to two hops down | "reached by navigation from X" rows of a targets file | `CLAIM_CHARTS` |
| test gate | test, mock, benchmark and example code held back from the candidates unless `--include-tests` admits it | the run's note when the gate turns itself off | `CLAIM_CHARTS` |
| candidate cap | at most 25 matched names per element go to the model, with up to 35 more offered by name alone | "at the cap; 35 more offered by name" in a targets file | `CLAIM_CHARTS` |
| blind, plain | `--claim-locate` with the codebase's identity and file paths hidden from the model, so a hit is discovery rather than recall; and without | `--blind`; the paired numbers "blind / plain" in the agreement table | `CLAIM_CHARTS`, `CLAIM_CHARTS_TESTS` |
| `PRESENT`, `PARTIAL`, `ASSUMED`, `ABSENT` | the model's verdict on one target for one element, in the prompt's own definitions | every cell of a chart; section 2 of `CLAIM_CHARTS` quotes the definitions | `CLAIM_CHARTS` |
| merge | the deterministic step that turns the per-target verdicts into the one row per element the chart shows | the chart's table | `CLAIM_CHARTS` |
| agreement tag | the tally beside a row's label: how many targets earned that label and how many said `ABSENT` | "(1 of 31; 30 ABSENT)" on a row | `CLAIM_CHARTS` |
| Support line | the count of rows that rest on a single target, naming the weakest | below a chart's table | `CLAIM_CHARTS` |
| provenance header | the engine, the build, the targets checksum, the command, and where the targets came from | the top of every chart | `CLAIM_CHARTS` |
| verdicts file | every raw verdict and note, the nominations and the targets that produced none, as JSON; what a re-render and every scorer read | `--verdicts-out`; `--chart-html-from` | `CLAIM_CHARTS`, `model-support` |
| whole-claim search | the earlier path: the claim's distinctive terms run as one multisect search over file bodies | `--claim-search`, `--claim-analyze`; the GUI's Claim Search | `CLAIM_CHARTS`, `PATENT_CLAIMS` |
| register | the vocabulary a text is written in, a patent claim's against an engineer's; the gap the embedding measurements found between real claims and code | `--embed-distance`; section 8 of `CLAIM_CHARTS`; [`describe-reach.md`](describe-reach.md) | `CLAIM_CHARTS`, both tests pages, `describe-reach` |
| **Mechanisms and pseudo-claims** | | | |
| mechanism, mechanisms index | a small group of functions that together do one thing, with a label read off the code; what one pseudo-claim is written about; the index of them that `--build-mechanisms` writes beside an index | `--toc`, `--mechanisms`; a `# Label` header and its functions in a candidates file; [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md) | `MECHANISMS`, `PSEUDO_CLAIMS`, `CLAIM_CHARTS`, both tests pages |
| grouper | the model-free step that finds candidate mechanisms (`src/core/mechanism-grouper.js`); the same code builds the mechanisms index | `--pseudo-claims --candidates`; `--build-mechanisms` | `PSEUDO_CLAIMS`, `PSEUDO_CLAIMS_TESTS`, `MECHANISMS` |
| seeds | the rules the grouper starts a group from: the functions of one documented file, the methods of one class, a command's handler and what it calls, or a distinctive name token shared across files | the header kinds `[file] x.c`, `[class] X`, `[cmd] --foo`, `token (namesake)`; `[file] X / rest` is a file's remainder after other seeds took part of it | `PSEUDO_CLAIMS`, `PSEUDO_CLAIMS_TESTS`, `MECHANISMS` |
| candidate, group (pseudo-claims sense) | one mechanism the grouper proposes, before you prune or draft it. Not the claim-charts sense, where a candidate is a target | each `# Label` block of the `--candidates` file (`cand.lst` on the tests pages) | `PSEUDO_CLAIMS`, `PSEUDO_CLAIMS_TESTS` |
| label | a group's name: a shared name token with a representative function, `[class] Name`, `[file] name.c` or `[cmd] --flag` | the `# Label` header; the contents table of a drafted chart | `PSEUDO_CLAIMS`, `MECHANISMS` |
| purpose line | the sentence after the label, read from the code's own comments or docstrings; the drafter's hint to what the mechanism is | the text after the em dash on a header | `PSEUDO_CLAIMS` |
| coverage | the share of an index's functions that landed in some candidate group | the `# coverage:` line at the top of a candidates file | `PSEUDO_CLAIMS_TESTS`, `MECHANISMS` |
| echo | two groups sharing a dominant file, probably one mechanism reached from two seeds; flagged, never merged | the `# echo pairs` note at the top of a candidates file | `PSEUDO_CLAIMS` |
| rank tag | `--rank`'s reading of where to look first in an unfamiliar codebase, `[P3]` down to `[P0]`, with its signal and a keep / merge / split verdict | on each header of a ranked list; `--min-rank` reads it | `PSEUDO_CLAIMS`, `PSEUDO_CLAIMS_TESTS` |
| evidence pack | the fenced, size-capped code of a group's functions, with the constants they name and any documentation excerpts: all the drafter sees | `--show-prompt` or `--dry-run` prints it; the pack line under each draft says how it was spent | `PSEUDO_CLAIMS` |
| anchor | a `file@func` (or `file@L<start>-<end>`) reference: on input, which functions a mechanism has; on output, a claim element's citation; in the self-test, the function a claim was drafted from, the answer key | the lines under a `# Label`; "Anchors:" under each drafted claim; `claims.txt.anchors.json` beside a HOF run's claims | `PSEUDO_CLAIMS`, both tests pages, `describe-reach` |
| grounded, ungrounded | whether a cited anchor resolves to a function or line range in the index; an ungrounded one is dropped with its reason and counted | the anchor list under each claim; the run header | `PSEUDO_CLAIMS`, `PSEUDO_CLAIMS_TESTS` |
| notation of an anchor | the shape a drafter wrote an anchor in (`file@func`, `file@func@L1-9`, `file:12-40`); known shapes are normalized, unknown ones counted | the anchor list and the run header | `PSEUDO_CLAIMS` |
| sidecar, answer key | `<claims>.anchors.json`: the grounded anchors, class and element count per claim, saved beside the claims file; what the self-test scores against | written beside the output of `--claims-only <file>` | `PSEUDO_CLAIMS`, `PSEUDO_CLAIMS_TESTS`, `model-support` |
| triage | a deterministic KEEP / REVIEW / DROP cut over a run's sidecar | `--triage` | `PSEUDO_CLAIMS` |
| dependent claim | a narrower claim under claim 1, "wherein …" or "further comprising …" | numbered under each claim 1 in the artifact | `PSEUDO_CLAIMS` |
| statutory class | the kind of claim: method, system, apparatus, computer-readable medium | `--claim-class`; the class mix in the run footer | `PSEUDO_CLAIMS` |
| shape line | how a draft's length, element count and dependent count sit against real litigated claims | under each draft | `PSEUDO_CLAIMS` |
| litigated population | the 380 asserted claim 1s and their 3,293 dependents from public filings, the shape a draft is measured against | the shape line under each draft; `--claim-schema` | `PSEUDO_CLAIMS_TESTS`, `litigated-claims-ground-truth` |
| claim schema, claim object | the opt-in path where the drafter fills a structured object and CodeExam renders the text | `--claim-schema`; the `schema` key of the sidecar | `PSEUDO_CLAIMS` |
| **The HOF self-test** | | | |
| HOF, "huffing our own fumes" | CodeExam's self-test: draft a claim from a mechanism of the index, then ask CodeExam's own claim search to find the mechanism from the claim; because the claim came from the code, the right answer is known | `ce --hof`; `scripts/hof.mjs` and its `hof_report.md`; section 5 of `CLAIM_CHARTS` | `PSEUDO_CLAIMS`, both tests pages, `claims-pipeline-state` |
| round trip | one HOF pass: code to claim to code | each row of a HOF report | both tests pages |
| ladder | how far from the exact function a located answer fell: per anchor, FUNCTION (the same function), CLASS (its class or another method of it), FILE (the same file) or MISS; per located target, EXACT (an anchor), NEAR (in an anchor's file) or ELSEWHERE | the columns of `hof_report.md` | both tests pages |
| synonymize, HOF-b | a different model rewrites a claim away from the code's own words, with the anchors withheld, so a later find cannot be mere word overlap | `--synonymize <claim>`; `--synonymize-with` on `ce --hof` | both tests pages, `cli`, `model-support` |
| the loop | `--claims-loop` on pseudo-claim charts: fill the empty cells and measure draft-to-retrieve agreement; its recall is a nomination rate | the HOF section's 2026-11-02 reading on `CLAIM_CHARTS_TESTS` | `CLAIM_CHARTS_TESTS` |
| nomination, judgment | whether a drafted anchor entered the chart's analysis set at all, and whether the model then judged it `PRESENT` | the HOF section of `CLAIM_CHARTS_TESTS` | `CLAIM_CHARTS_TESTS` |
| stage1, tier 0 | a feasibility check: score a claim against every candidate group by the group's own text (label, purpose, member names), no model, and ask where the drafted-from group ranks | `scripts/hof-stage1.mjs` | `PSEUDO_CLAIMS_TESTS` |
| literalness | the share of an anchor's name words that appear in the claim drafted from it; how far a self-test claim stays in the code's words | the Gemma 4 subsection of `CLAIM_CHARTS_TESTS`; #363 | `CLAIM_CHARTS_TESTS` |
| mechanism grain, entry | the mechanisms index as the unit of retrieval: a claim element matched against labeled groups of functions rather than bare names | [`describe-reach.md`](describe-reach.md); `--embed-distance` | `CLAIM_CHARTS_TESTS`, `describe-reach` |
| **The measurements** | | | |
| the fourteen, the filings | the fourteen public documents whose claim charts cite functions of an open-source repository, each repository indexed at the filing's commit | Table A of `CLAIM_CHARTS_TESTS`; `test/fixtures/recap-chart-agreement-candidates.json` | `CLAIM_CHARTS_TESTS`, `real-world-claim-charts` |
| catalog | the listing of every filed document the RECAP search found, with each code name placed in the chart row that cites it | [`real-world-claim-charts.md`](real-world-claim-charts.md) | `CLAIM_CHARTS_TESTS` |
| agreement, the agreement test, yardstick | CodeExam's choices scored against the names a litigant's chart cites; a party's contention, not truth, so a match is agreement with that party | `scripts/recap-chart-agreement.mjs`; [`claim-chart-agreement.md`](claim-chart-agreement.md); section 4 of `CLAIM_CHARTS` | `CLAIM_CHARTS`, both tests pages, `claim-chart-agreement` |
| reachability | whether the cited names are in the index at all; the first tier of the agreement test | the "names" column of the agreement table | `CLAIM_CHARTS_TESTS` |
| found-of-cited, cited-of-chosen | the two directions of agreement: the share of the litigant's names CodeExam chose, and the share of CodeExam's choices the litigant cited | the agreement table and the pooled lines under it | `CLAIM_CHARTS_TESTS` |
| the name rule | a tier with no model: the claim's words against the index's names | the agreement test's second tier | `CLAIM_CHARTS_TESTS` |
| stem bridge, test filter, second hop, the pool | the four retrieval changes of 2026-10-22, each re-measured on the fourteen: word stems in the symbol search; a wider gate on test code; a second navigation hop; a wider, tie-broken candidate pool | the "after" paragraphs and the agreement table's last four columns | `CLAIM_CHARTS_TESTS` |
| fixture | a hand-kept answer set in the repository that a change is re-measured on; here the twenty believed-implementer symbols of the '101 against ExoPlayer 3 | `test/fixtures/retrieval-reachability-8752101-exoplayer3.json` | `CLAIM_CHARTS_TESTS` |
| negative control | a claim paired with a codebase it cannot read on; every `PRESENT` is a false finding | the three tiers section of `CLAIM_CHARTS_TESTS` | `CLAIM_CHARTS_TESTS` |
| ceiling, floor, control | the drafter's best case given the party's own cited functions; what a draft from an unrelated group of the same codebase scores against the claim, the number a method must beat; the same draft judged against another filing's claim of the same art | [`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md) | both tests pages, `claim-chart-drafter-ceiling` |
| `MET`, `PARTIAL`, `ABSENT` (a judge's) | a judge's reading of one claim element against the asserted claim or a rubric row: the same limitation in substance; part of it; none of it. Not the chart verdicts above, which have four labels | the ceiling and rubric tables | `PSEUDO_CLAIMS_TESTS` |
| rubric | a hand-written claim 1 for one CodeExam feature, with lettered elements and a citations table, used as the standard a run is scored against | [`pseudo-claim-rubrics/`](pseudo-claim-rubrics/); `scripts/pseudo-claim-rubric-score.mjs` | `PSEUDO_CLAIMS_TESTS`, `SELF_PORTRAIT` |
| union rule, best rule | how a rubric row is read from a run: from up to four of the claim's lines together (the default) or from the single best line | `--rule best` on the scorer | `PSEUDO_CLAIMS_TESTS` |
| one sample per cell | each number comes from one run of one model; a rerun will differ | every table on the tests pages | both tests pages |
