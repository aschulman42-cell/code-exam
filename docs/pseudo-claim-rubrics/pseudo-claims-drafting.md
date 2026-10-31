# Pseudo-claims for CodeExam's pseudo-claim drafting (rubric page)

A hand rubric: one claim set for the feature, every row cited to the code, used as the fixed
rows a `--pseudo-claims` run is scored against (`scripts/pseudo-claim-rubric-score.mjs`, #353
part (e)). Written 2026-10-27 from Andrew's notes of 2026-10-25 and 2026-10-27, the drafter's
claim 29 of the 10/25 run (verified against the code before use) and the working tree of
2026-10-27 (`7c93118`); placed here 2026-10-31 with the citations table as written that day.
Line numbers move with later commits, function names do not; see the note above the table.
The scorer reads the `**N.**`, `(a)` and `wherein` markers under the Set heading and the
citations table at the end. The working notes the scratch original carried (comments
answered, what the drafts missed) stay outside the repository.

**As first written:**

Two claim sets, for use beside the multisect pseudo-claim in testing. Set P, this page, is the
drafting pipeline with the references given. Set D, on `pseudo-claims-candidates.md`, is the
identification of candidate mechanism groups. Each set numbers its own claims from 1. The
claim text is kept free of code citations; the table at the end maps every element and
dependent to the lines it was written from, with a provenance tag: `[A]` Andrew's notes,
`[C]` the code, `[D]` the drafter's claim 29 (verified against the code before use).

Conventions: a project term appears in parentheses after its plain-language introduction
and is used bare afterward.

---

## Set P: the drafting pipeline

**1.** A method of generating patent-claim-like descriptions of technology from lower-level
details contained in source code, comprising:

(a) receiving one or more groups of references ("anchors") into a body of indexed source
code, each reference naming a function by file and function name or a documentation
excerpt by file and line range, the groups delimited by label lines;

(b) resolving each reference against an index of the source code in which each function is
recorded with its file, start line and end line, so that each reference maps to exactly one
indexed function or line range, and dropping any reference that maps to none or to more
than one, the reference and the reason being written to the error stream;

(c) assembling, for each group, an evidence pack consisting of the source text of each
resolved function or excerpt, each delimited and headed by its reference, the pack bounded
by a per-reference allowance and a total character budget, the allowance evened across
the references when the whole does not fit, each cut marked where it occurs, and the manner
of fitting recorded;

(d) submitting, for each group, one request to a language model, the request consisting of
the group's label joined with a purpose line harvested from the source comments, the
evidence pack, and a fixed instruction that specifies the claim form of a chosen statutory
class, states a count and composition of dependent claims measured from a population of
litigated claims, directs the model to select the limitations that constitute the
mechanism for the independent claim and to place specifics in dependent claims, sets no
length target for the independent claim, and specifies a grammar for citing references;

(e) parsing the model's response into an independent claim, zero or more dependent claims,
and the references the model cited with the element each supports, accepting any
line-range notation the model used and recording which notation it used;

(f) verifying each cited reference against the index ("grounding"), replacing the model's
rendering of the reference with the indexed file path and line range, retaining the
model's cited line range as a check on placement, and dropping with a reason any cited
reference that does not resolve; and

(g) emitting a document comprising a fixed caveat that the claims are illustrative and not
an assertion about the code, and, for each group, the independent claim, its dependent
claims, a measurement of the claim's shape against the population of litigated claims,
and the verified references; together with a machine-readable file holding one claim per
line and a companion file ("sidecar") holding each claim's verified references.

**2.** The method of claim 1, in which a reference is written as `file@function` or
`file@L<start>-<end>`, and the groups are received either as a semicolon-separated string
forming one group or as a file in which a line beginning `#` is a label line that opens a
group.

**3.** The method of claim 1, in which the per-reference allowance is 8,000 characters,
the total budget 24,000 characters, and no reference is evened below 600 characters, and
each cut is marked with the number of characters shown and the number omitted.

**4.** The method of claim 1, in which the manner of fitting is selectable between evening
the budget across every reference and filling references whole in order until the budget
is spent, the manner used being stated in the document.

**5.** The method of claim 1, in which the evidence pack is sent to the model in every case
and is omitted from the document unless requested, and in which, when no model is
configured or a dry run is requested, the document contains the evidence packs and states
that no claim was drafted.

**6.** The method of claim 1, in which the purpose line is the leading comment block of the
group's primary file when that block begins within the first eight lines, else the
comments of the function or class the label names, else the comments of the group's first
member, truncated to a fixed length; and in which, for a group marked as the remainder of
a file, the purpose line states the file, how many of its functions other groups took, and
the members' own names and comments.

**7.** The method of claim 1, in which the statutory class is selectable among method,
system, apparatus and computer-readable medium, or chosen per group by a rule reading the
code's shape, in which several classes each with methods covering most of the group, or
hardware and input/output vocabulary, select apparatus, one class whose methods are the
group selects system, and free functions select method; and in which the document reports
the share of each class drafted beside the share in the population of litigated claims.

**8.** The method of claim 7, further comprising drafting, for one group, a method claim,
the machine-class claim the rule would choose, and a computer-readable-medium claim.

**9.** The method of claim 1, in which the population of litigated claims is a set of 385
independent claims of litigated software patents, and is selectable among that set, its
system-class subset, a set of artificial-intelligence claims, and a sample of independent
claims across all arts ("shape profile").

**10.** The method of claim 1, in which the shape measurement comprises the word count,
the element count, the number of elements classified as mechanism and as generic, the
dependent count, and the shares of dependents that narrow an element and that add a step,
each compared with the population's median and tenth-to-ninetieth-percentile band, with a
distance summarized per claim and a flag on any claim with fewer than two mechanism
elements.

**11.** The method of claim 10, in which an element is classified as generic when its head
verb is an input, output or storage verb and it carries no mechanism cue, and otherwise by
the frequency of its content words in a corpus of claims, words introduced by an earlier
element being treated as back-references, the classification made by a deterministic rule
and not by the model.

**12.** The method of claim 1, in which, before the first request, the cost of all requests
is projected from the sizes of the packs and the instruction, the method declining to
proceed when the projection exceeds a guard, and the actual cost is reported after.

**13.** The method of claim 1, in which the language model is one of a plurality of remote
services or a local model file, in which an air-gapped mode refuses any remote service,
and in which the requests are made one at a time.

**14.** The method of claim 1, further comprising printing the exact request for a group and
making no request, on demand.

**15.** The method of claim 1, in which a response that ends before the model finished is
marked in the document as not a finished claim.

**16.** The method of claim 1, in which a cited documentation excerpt is verified only when
its file resolves to exactly one indexed file and its start line lies within that file.

**17.** The method of claim 1, in which the groups are submitted in ascending order of the
genericity of their labels and purpose lines, so that mechanism vocabulary is drafted
first, and the document opens with a contents table listing each claim's label and the
first words of its preamble.

**18.** The method of claim 1, in which a claim whose group shares its dominant file with a
larger group is flagged in the document as a probable duplicate of the larger group's
claim.

**19.** The method of claim 1, in which the document counts the citation notations the
model used, so that an unrecognized notation appears as a count rather than as a silent
drop.

**20.** The method of claim 1, in which, on request, the model returns the claim as an object
under a schema whose preamble forms and dependent count and kinds derive from the
population, the object checked after return and the request repeated up to a fixed number
of times with the failed check named, and in which each element of the object is paired
with its references so that the document lists references element by element.

**21.** The method of claim 1, further comprising a deterministic first cut over the sidecar
that marks each claim keep, review or drop with a named reason, among them near-duplicate
of a sibling claim, echo of a larger group, and residue of a split group, with no index
and no model.

**22.** The method of claim 1, further comprising a self-test in which each drafted claim is
charted against the index without knowledge of its references and the chart is scored on
retrieval of the verified references, on present verdicts for mechanism elements counted
at a verified reference apart from elsewhere, on false present verdicts against a control
index lacking the mechanism, and on a dependent claim expected present against a
deliberately altered dependent expected absent.

**23.** The method of claim 1, in which the groups of references are produced by the method
of claim 1 of the candidates page (`pseudo-claims-candidates.md`).

---

## Citations and provenance

Lines in the table were keyed to the working tree of 2026-10-27, commit `7c93118`, and carried
here as written on 2026-10-31. The same day, every range into `src/commands/pseudo-claims.js`
(grown by about 600 lines since: `f87ec14`, `940dfbb`, `82ee8a1`, `66cf85a`), the
`src/argparse.js` range and the `docs/CODEEXAM_PSEUDO_CLAIMS.md` ranges were re-keyed to the
tree at `1c05834` (the doc after this page's own commit edited its rubric-gate paragraph,
which sits above the cited lines) by locating the `7c93118` text of each range's first and
last lines in the current file and, where the cite names a function, taking the function's
current extent; those rows say "re-keyed 2026-10-31" in the provenance column. The grouper,
ranker, schema, triage, genericity and class files are unchanged since 2026-10-27, so every
range into them holds as written. Function names hold throughout.

Provenance: six of the thirty rows, P1(a) to P1(f), trace to the drafter's claim 29 and were
verified against the code (`D→C`); the preamble is Andrew's and the rest is from the code.
A MET on those six rows is partly the drafter agreeing with its own earlier phrasing; weigh it
accordingly (2026-10-31).

`pc` = `src/commands/pseudo-claims.js`, `mg` = `src/core/mechanism-grouper.js`,
`mr` = `src/core/mechanism-ranker.js`.

| claim | where | provenance |
|---|---|---|
| P1 preamble | Andrew, 2026-10-25 sketch | A |
| P1(a) | `pc:549-601` (groups, `# Label`), `pc:734-745` (line anchors), `mg:1204` (header parse) | D→C; re-keyed 2026-10-31 |
| P1(b) | `pc:764-825` (`resolveGroup`), `pc:2314-2331` (stderr report) | D→C; re-keyed 2026-10-31 |
| P1(c) | `pc:1084-1132` (`buildPack`), `pc:528-537` (budgets), `pc:693` (disclosure) | D→C; re-keyed 2026-10-31 |
| P1(d) | `pc:2434-2446` (one request per group, label + purpose), `pc:976-1024` (`harvestPurpose`), `pc:253-291` (`shapeTargetLines`, "NO length target" at 259), `pc:290-481` (tails), `pc:514-522` | D→C; content C; re-keyed 2026-10-31 |
| P1(e) | `pc:1359` (`parseGeneratedClaim`), `pc:1248`, `pc:1165-1247` (`normalizeAnchorRef`, shape recorded) | D→C; re-keyed 2026-10-31 |
| P1(f) | `pc:1550-1621` (`groundAnchors`) | D→C; re-keyed 2026-10-31 |
| P1(g) | `pc:55-111` (caveats), `pc:2524-2879` (artifact), `pc:1757` (sidecar), `pc:1829` (claims-only) | C; re-keyed 2026-10-31 |
| P2 | `pc:549-601`, `pc:734`, help `src/argparse.js:1632-1644` | C; re-keyed 2026-10-31 |
| P3 | `pc:528-537`, cut marker `pc:1116` | C; re-keyed 2026-10-31 |
| P4 | `--pack-fill`, `pc:1084-1132` | C; re-keyed 2026-10-31 |
| P5 | `pc:2368-2371`, `pc:2526-2529` | C; re-keyed 2026-10-31 |
| P6 | `pc:976-1024` (`HARVEST_CAP` 700 at 935; header within 8 lines, first 30 lines) | C; re-keyed 2026-10-31 |
| P7 | `src/core/claim-class.js`; `pc:489-512`; `pc:2542-2552` | C; re-keyed 2026-10-31 |
| P8 | `classesForMode('all')`, `pc:498` | C; re-keyed 2026-10-31 |
| P9 | `pc:165-223` (`SHAPE_PROFILES`) | C; re-keyed 2026-10-31 |
| P10 | `pc:1668-1726` (`shapeReport`) | C; re-keyed 2026-10-31 |
| P11 | `src/core/claim-genericity.js` header | C |
| P12 | `pc:2406-2414` | C; re-keyed 2026-10-31 |
| P13 | `pc:2382-2392`, `src/core/llm-runner.js` (air-gap gate) | C; re-keyed 2026-10-31 |
| P14 | `pc:2333-2367` (`--show-prompt`) | C; re-keyed 2026-10-31 |
| P15 | `pc:2733-2736` | C; re-keyed 2026-10-31 |
| P16 | `pc:1550-1621` (doc cites, the branch at 1559-1575) | C; re-keyed 2026-10-31 |
| P17 | `pc:2284-2300` (genericity order), `pc:2669-2681` (contents table) | C; re-keyed 2026-10-31 |
| P18 | `pc:2657-2667`, `mg:1244-1284` (`dominantFile`, `echoPairs`) | C; re-keyed 2026-10-31 |
| P19 | `pc:2590-2611` | C; re-keyed 2026-10-31 |
| P20 | `src/core/claim-schema.js`; `pc:2452-2482`; `SCHEMA_RESAMPLE_CAP` 2 | C; re-keyed 2026-10-31 |
| P21 | `pc:2166` (`doTriage`), `src/core/pseudo-claim-triage.js` | C; re-keyed 2026-10-31 |
| P22 | `scripts/pseudo-claim-loop.mjs`, `src/core/loop-score.js` | C |

Not claimed, because the code does not do it: a broad and a tight draft of one mechanism
(`docs/CODEEXAM_PSEUDO_CLAIMS.md`, "idea", lines 464-471; 351-358 at `7c93118`, re-keyed
2026-10-31); any test-file or doc-file weighting of references.

An apparatus rendering of this set is mechanical: each step becomes a unit configured to
perform it, and the data between steps (the resolved references, the pack, the response, the
verified references) is the connective tissue. Not written out here.

---

## Scores (2026-10-31)

Scored with `node scripts/pseudo-claim-rubric-score.mjs`
`--rubric docs/pseudo-claim-rubrics/pseudo-claims-drafting.md --run <file>` for each run below:
the best run claim per run (MET counted twice, PARTIAL once)
among the claims with an anchor that matches a row's cite. MET is a cite match with half the
row's content words present, PARTIAL a cite match with a quarter or the words without the cite;
the overlap is a keyword proxy printed beside every verdict, and the reading stays the human's.
The runs are files in the project root of this checkout, not in the repository; "none" means no
claim in that run meets or partly meets a row. The first six runs are the five pages' baselines;
the four of 2026-10-25 were run with `--filter pseudo`, so they reach this feature's own groups.
The 10/25 7:20pm run's best claim is claim 29, the one six rows of Set P trace to (`D→C`
above), and the two runs with no claim citing the drafting file score "none".

| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |
|---|---|---|---|---|---|---|
| CE_pseudo_claim_test_102526_720pm_norank.txt (10/25 7:20pm, Claude, 41 claims) | 29 ([cmd] --pseudo-claims) | 2 | 6 | 22 | 17 / 0 / 2 | 5 |
| CE_pseudo_claims_vocab_concept_overview_Claude.txt (10/27, Claude, 18 claims) | 13 ([file] mechanism-grouper.js / rest) | 1 | 0 | 29 | 22 / 1 / 2 | 1 |
| CE_pseudo_claims_vocab_concept_overview_ChatGPT.txt (10/27, ChatGPT, 18 claims) | none | — | — | — | — | 0 |
| gemma4_CE_pseudo_claims_102926.txt (10/29, Gemma 4 on the Asus, 41 claims) | 33 ([cmd] --pseudo-claims) | 0 | 2 | 28 | 8 / 1 / 3 | 3 |
| CE_pseudo_concept_overview_103026.txt (10/30, Claude, 12 claims) | 9 ([file] mechanism-grouper.js / rest) | 0 | 1 | 29 | 21 / 1 / 3 | 1 |
| CE_pseudo_vocab_103026.txt (10/30, Claude, 9 claims) | none | — | — | — | — | 0 |
| CE_pseudo_claims_CE_pseudo_102526_210pm.txt (10/25 2:10pm, Claude, `--filter pseudo`, 18 claims) | 11 ([cmd] --pseudo-claims / other) | 1 | 6 | 23 | 13 / 2 / 2 | 10 |
| CE_pseudo_claims_CE_pseudo_102526_250pm.txt (10/25 2:50pm, Claude, `--filter pseudo`, 12 claims) | 12 ([cmd] --pseudo-claims) | 1 | 5 | 24 | 13 / 0 / 5 | 6 |
| CE_pseudo_claims_CE_pseudo_102526_405pm.txt (10/25 4:05pm, Claude, `--filter pseudo`, 9 claims) | 7 ([cmd] --pseudo-claims) | 2 | 7 | 21 | 20 / 1 / 0 | 5 |
| CE_pseudo_claims_CE_pseudo_102526_525pm.txt (10/25 5:25pm, Claude, `--filter pseudo --claim-class all`, 27 claims) | 19 ([cmd] --pseudo-claims [method]) | 2 | 6 | 22 | 14 / 1 / 2 | 15 |
