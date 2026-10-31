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

Lines in the table are keyed to the working tree of 2026-10-27, commit `7c93118`, and are
carried here as written (2026-10-31). `src/commands/pseudo-claims.js` has grown by about 500
lines since (`f87ec14`, `940dfbb`, `82ee8a1`, `66cf85a`), so its `pc:` ranges, the
`src/argparse.js` range and the `docs/CODEEXAM_PSEUDO_CLAIMS.md` range point to where the code
was; the grouper, ranker, schema, triage, genericity and class files are unchanged since, so
every range into them holds. Function names hold throughout. Re-keying is the follow-up item
`rubric-pages-pseudo-claims-rekey-and-scores`.

Provenance: six of the thirty rows, P1(a) to P1(f), trace to the drafter's claim 29 and were
verified against the code (`D→C`); the preamble is Andrew's and the rest is from the code.
A MET on those six rows is partly the drafter agreeing with its own earlier phrasing; weigh it
accordingly (2026-10-31).

`pc` = `src/commands/pseudo-claims.js`, `mg` = `src/core/mechanism-grouper.js`,
`mr` = `src/core/mechanism-ranker.js`.

| claim | where | provenance |
|---|---|---|
| P1 preamble | Andrew, 2026-10-25 sketch | A |
| P1(a) | `pc:548-600` (groups, `# Label`), `pc:705-716` (line anchors), `mg:1204` (header parse) | D→C |
| P1(b) | `pc:735-786` (`resolveGroup`), `pc:1813-1830` (stderr report) | D→C |
| P1(c) | `pc:899-964` (`buildPack`), `pc:527-536` (budgets), `pc:679` (disclosure) | D→C |
| P1(d) | `pc:1928-1940` (one request per group, label + purpose), `pc:795-849` (`harvestPurpose`), `pc:252-290` (`shapeTargetLines`, "NO length target" at 258), `pc:289-480` (tails), `pc:513-521` | D→C; content C |
| P1(e) | `pc:1071` (`parseGeneratedClaim`), `pc:1048`, `pc:965-1047` (`normalizeAnchorRef`, shape recorded) | D→C |
| P1(f) | `pc:1104-1182` (`groundAnchors`) | D→C |
| P1(g) | `pc:54-110` (caveats), `pc:1999-2270` (artifact), `pc:1304` (sidecar), `pc:1363` (claims-only) | C |
| P2 | `pc:548-600`, `pc:705`, help `src/argparse.js:1628-1640` | C |
| P3 | `pc:527-536`, cut marker `pc:~930` | C |
| P4 | `--pack-fill`, `pc:899-964` | C |
| P5 | `pc:1867-1870`, `pc:2001-2004` | C |
| P6 | `pc:795-849` (`HARVEST_CAP` 700; header within 8 lines, first 30 lines) | C |
| P7 | `src/core/claim-class.js`; `pc:488-511`; `pc:2017-2027` | C |
| P8 | `classesForMode('all')`, `pc:497` | C |
| P9 | `pc:164-222` (`SHAPE_PROFILES`) | C |
| P10 | `pc:1215-1273` (`shapeReport`) | C |
| P11 | `src/core/claim-genericity.js` header | C |
| P12 | `pc:1900-1908` | C |
| P13 | `pc:1876-1886`, `src/core/llm-runner.js` (air-gap gate) | C |
| P14 | `pc:1832-1866` (`--show-prompt`) | C |
| P15 | `pc:2157-2160` | C |
| P16 | `pc:1104-1182` (doc cites) | C |
| P17 | `pc:1784-1800` (genericity order), `pc:2100-2118` (contents table) | C |
| P18 | `pc:2088-2099`, `mg:1244-1284` (`dominantFile`, `echoPairs`) | C |
| P19 | `pc:2065-2087` | C |
| P20 | `src/core/claim-schema.js`; `pc:1944-1970`; `SCHEMA_RESAMPLE_CAP` 2 | C |
| P21 | `pc:1666` (`doTriage`), `src/core/pseudo-claim-triage.js` | C |
| P22 | `scripts/pseudo-claim-loop.mjs`, `src/core/loop-score.js` | C |

Not claimed, because the code does not do it: a broad and a tight draft of one mechanism
(`docs/CODEEXAM_PSEUDO_CLAIMS.md`, "idea", lines 351-358 at `7c93118`); any test-file or
doc-file weighting of references.

An apparatus rendering of this set is mechanical: each step becomes a unit configured to
perform it, and the data between steps (the resolved references, the pack, the response, the
verified references) is the connective tissue. Not written out here.

---

## Scores

Not yet scored (2026-10-31): the table's ranges into `src/commands/pseudo-claims.js` are keyed
to `7c93118`, and a scorecard against stale ranges would mislead on the rows cited by range
alone. The follow-up item re-keys the table and adds the ten-run table the other pages carry.
