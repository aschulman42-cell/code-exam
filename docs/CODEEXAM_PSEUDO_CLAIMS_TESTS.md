# Pseudo-claims: the tests behind the feature

*This page holds the measurements that stand behind
[`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md), moved here on 2026-11-08 so the
feature page can stay a plain account of what pseudo-claims are and how to run them. Each
section below is one test: when it ran, what question it answers, what was measured, and
where the full tables are. Dates and numbers are as first recorded; a rerun will differ,
and every figure is one sample per cell unless it says otherwise. The terms table comes
first because these pages grew their own vocabulary; it maps each term to what a user
sees on the screen or on disk.*

## Terms used on the test pages

| term | what it means | where you see it |
|---|---|---|
| mechanism | a small group of functions that together do one thing; what one pseudo-claim is written about | a `# Label` header and its functions in `cand.lst`; a row of `--mechanisms` |
| seeds | the four rules the grouper starts a group from: the functions of one file, the methods of one class, a command's handler and what it calls, or a shared name token | the header kinds in `cand.lst`: `[file] x.c`, `[class] X`, `[cmd] --foo`, `token (namesake)` |
| grouper | the model-free step that finds candidate mechanisms | `--pseudo-claims --candidates`; the same code builds `mechanisms.json` with `--build-mechanisms` |
| candidate, group | one mechanism the grouper proposes, before you prune or draft it | each `# Label` block of `cand.lst` |
| coverage | the share of an index's functions that landed in some candidate group | the `# coverage:` line at the top of a candidates file |
| rank tag | `--rank`'s P0 to P3 reading of where to look first in an unfamiliar codebase, with its signal and fold verdict | `[P3 codebase-specific/keep …]` on a header; `--min-rank` reads it |
| anchor | a `file@func` (or `file@L10-48`) reference: on input, which functions a mechanism has; on output, a claim element's citation | the lines under a `# Label`; "Anchors:" under each drafted claim |
| grounded, ungrounded | whether a cited anchor resolves to a function or line range in the index; an ungrounded one is dropped and counted | the anchor list under each claim and the run header |
| drafter | the model that writes the claim text | `--llm claude`, `--llm gemini`, `--model <gguf>` on `--pseudo-claims` |
| sidecar, answer key | the anchors each claim was drafted from, saved as `<claims>.anchors.json` beside the claims file; what HOF scores against | written by `--claims-only <file>` |
| HOF, "huffing our own fumes" | CodeExam drafts a claim from a mechanism, then asks its own claim search to find that mechanism from the claim; because the claim came from the code, the right answer is known | `scripts/hof.mjs` and its `hof_report.md` |
| round trip | one HOF pass: code to claim to code | each row of a HOF report |
| locator | `--claim-locate`, which asks a model to name the code a claim reads on and verifies every name against the index | `--claim-locate`, its `--targets-out` file |
| ladder | how far from the exact function a located answer fell: FUNCTION (the same function), CLASS (its class or another method of it), FILE (the same file), MISS; per located target, EXACT (an anchor), NEAR (in an anchor's file), ELSEWHERE | the columns of `hof_report.md` |
| synonymize, HOF-b | a different model rewrites the claim away from the code's own words, with the anchors withheld, so a later find cannot be mere word overlap | `--synonymize <claim>` |
| stage1, tier 0 | a feasibility check: score a claim against every candidate group by the group's own text (label, purpose, member names), no model, and ask where the drafted-from group ranks | `scripts/hof-stage1.mjs` |
| yardstick, agreement | the functions litigants cited in public claim charts, used as the answer key for real claims; a party's contention, not truth, so a "match" is agreement with that party | [`claim-chart-agreement.md`](claim-chart-agreement.md) |
| ceiling | the drafter's best case: given the party's own cited functions, how close the draft comes to the party's claim | [`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md) |
| floor | what a draft from an unrelated group of the same codebase scores against the claim; the number a method must beat | the ceiling page's tables |
| control | the same draft judged against another filing's claim of the same art | the ceiling page's tables |
| MET, PARTIAL, ABSENT | a judge's reading of one claim element against the asserted claim or a rubric row: the same limitation in substance; part of it; none of it | the ceiling and rubric tables |
| rubric | a hand-written claim 1 for one CodeExam feature, with lettered elements and a citations table, used as the standard a run is scored against | [`docs/pseudo-claim-rubrics/`](pseudo-claim-rubrics/); `scripts/pseudo-claim-rubric-score.mjs` |
| union rule, best rule | how a rubric row is read from a run: from up to four of the claim's lines together (the default) or from the single best line | `--rule best` on the scorer |
| litigated population | the 380 asserted claim 1s and their 3,293 dependents from public filings, the shape a draft is measured against | the shape line under each draft; `--claim-schema` |
| chooser | in the describe-reach measurement, a second stage in which a model reads the five nearest mechanisms' labels and picks one; a measurement, not a shipped command | [`describe-reach.md`](describe-reach.md), "Retrieve, then choose" |
| register | the vocabulary a text is written in, a patent claim's against an engineer's; the gap the embedding tests found between real claims and code | [`describe-reach.md`](describe-reach.md); `--embed-distance` |
| one sample per cell | each number comes from one run of one model; a rerun will differ | every table on these pages |

## Scoring runs against hand rubrics (2026-10-30 and 2026-10-31)

Seven hand rubric pages for six CodeExam features live under `docs/pseudo-claim-rubrics/`
(Overview by AI, vocabulary, concepts, the Overview, multisect search, and two for
pseudo-claims itself, candidate identification and the drafting pipeline): each a claim 1
with lettered elements and a wherein, numbered dependents, and a citations table tying every
row to file lines. `node scripts/pseudo-claim-rubric-score.mjs --rubric <page> --run
<artifact>` scores a run against one: a row is addressed by the run claim's anchors that
match the row's cites (file and lines, or the named function); MET is a cite match with half
the row's content words present in the claim's elements, dependents or anchor notes, PARTIAL
a cite match with a quarter or the words without the cite, ABSENT neither; the run's elements
that reach no row are the surplus, binned grounded-substantive, grounded-trivial and
ungrounded. The overlap is a keyword proxy printed beside every verdict, so the reading,
which stays the human's, can check it. Since 2026-10-31 a row is also read from up to four of
the claim's lines as one text (the union rule, the default; `--rule best` reproduces the
single-line reading of 2026-10-30), after the single line left a draft that names all six
grouper seeds ABSENT on the seeds row; each page carries a table under each rule, calibrated
on every page and run in hand. The five pages carry the scores of the six runs in hand as of
2026-10-30, the before for the drafting changes of #353 (a) to (d); a change to the prompt or
the packing is measured on the same rows and the same corpus. The two pseudo-claims pages
(`pseudo-claims-drafting.md`, `pseudo-claims-candidates.md`) carry ten runs as of 2026-10-31,
those six and the four `--filter pseudo` runs of 2026-10-25, with citations re-keyed that day
to `1c05834`.

## The drafting rules, measured (2026-11-01)

The feature page states the four drafting rules (introduce once and refer back; no instance
inside an element; a purpose preamble; a closing "whereby" only where the elements bring
about a result the preamble does not state, about one claim in six). What the rules did to
the drafts:

That rate is a choice, not the population's habit: of the 380 litigated claim 1s, 28 (7%)
close on a result clause and 13 carry "whereby" at all (measured 2026-11-01); the Bram drafts
of 2026-11-01, before the rule, closed on one in 10 of 150. The artifact reports the
antecedent rule beside each claim's shape line ("Antecedent basis: 2 unintroduced ("the
cross-corpus weight" in element 5; …)") and the result clause beside it ("Result clause
(non-limiting): …", or "none"), keyword checks that never rewrite, and sums both on the run
header, the result clause beside the population's rate. Two samples of the two new rules on
2026-11-01, 14 Bram groups ($1.01) and CodeExam's eight feature groups ($0.68), both classes:
the clause closed 16 of 28 and 10 of 16 drafts, well above the prior; the preamble median
went from 14 words to 21 on Bram and from 12 to 22 on CodeExam, against the population's 12
and the rubric pages' own 17; on the rubric pages the scorer moved on multisect (MET 4 to 7,
ABSENT 11 to 6 on the method claim) and little elsewhere, one sample per cell. The wording of
both rules is still open; `--form-rules 2026-10` drafts on the first two rules alone, the
prompt as it stood before 2026-11-01, so the same groups can be drafted under both on one
flag (`--hof` passes it through). Whether the rules change the drafts is measured
on the rubric pages: the after, one Claude run over the seven features' groups on
2026-10-31, is the last row of each page's union-rule table. On the one exact pair, the
grouper group drafted the same day on the old prompt, it scored 5 / 9 / 9 against 9 / 9 / 5,
one draft each; the run's antecedent tally is 36 unintroduced references in 8 drafts, most in
dependents, against 10 on the old prompt's grouper draft. Not yet shown to help; one sample
per cell.

## The closing clause can overstate the code (2026-11-02)

Every element of claim 1 is grounded to code and charted; the "whereby" clause is not. It
has no anchor of its own, the chart folds it into the last element's citations, and the only
check on it is a note when it opens like a step or a component. It is the one place in the
claim where the drafter states what the code achieves rather than what the code does, and it
can state more than the code delivers. On the real-world re-run of 2026-11-02, 4 of the 25
clauses did: both coin-selection drafts close on "the lowest achievable total weight among
all input sets", where Bitcoin Core's `coinselection.cpp` says the solution "is not
guaranteed to be optimal" once the search hits its tries limit; the CCTP v2 draft closes on
"delivered to its recipient exactly once" where the body establishes at most once; the CMB
draft on "preserves insertion order across concurrent writers", a guarantee the body does
not establish. A trained reader takes the clause as non-limiting; the claim is still wrong
about the code, and no scorer sees it: the judge reads elements, the anchor tests read
citations, and a word-overlap check would pass the coin-selection clauses, whose every word
is in the body. Read each clause against the cited code before using the claim, and cut it
where the elements already say what it says. The milder case is a purpose preamble that
enumerates the body ("by checking pause state, balance sufficiency, blacklist status, and
time-based lockup before allowing a transfer"): four of 42 on that run.

## The pack census (2026-10-31)

How the evidence-pack budget bites in practice. A census over the 183-group candidates list
of CodeExam's own code (no-model dry run, 2026-10-31): 39 of 183 packs evened; 432 of 1,755
members cut; 64 members in 37 groups over the 8,000 cap, so never whole at the defaults; in
28 of the 39 evened packs the largest member shown at under a quarter of its length; and 189
of the 416 cut code members carry an outline.

## What the grouper's purpose lines measured (2026-11-03 and 2026-11-04)

The purpose on a candidate's header is read from the code's own doc text (the order of
sources is on [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)). Three findings fixed the
reading:

- One piece carries the parent's doc, not every piece: on Bram's cover 429 of 691 records had
  said what `lib.rs` is for, and a filter on a word of that header matched them all
  (mechanisms-record-quality, 2026-11-04).
- A license banner's lines are never a purpose, the Apache, MIT, GPL and BSD continuation
  sentences included (`LICENSE_LINE_RE`; sr_gh had carried "you may not use this file except
  in compliance with the License…" on 595 of 1,298 records); the file seed's gate still counts
  license-free text with the shorter `LICENSE_RE`, so which files seed a group is unchanged.
- Before 2026-11-03 the harvester read a file's leading *comments* only, so a Python corpus,
  whose module, class and function docs are docstrings, drafted from blank headers
  (AI_Manning 106 of 182 rows blank, sr_gh 73 of 90, Py314_site_pkg 1,739 of 4,257); the
  regenerated lists of that day carry a purpose on every row. Every read is by line range,
  the file's leading lines or the class's or member's own span, never by resolving a name the
  harvester already has a span for; so is the outbound-call read
  (build-mechanisms-reads-by-span, 2026-11-04).

## Candidate coverage by index (2026-11-03)

Coverage is printed on every run (`# coverage: N/M candidate function(s) in a group`): with
the 2026-11-03 defaults it ranged from 22% (Py314_site_pkg, a site-packages tree of 150,000
candidate functions) and 41% (sr_gh, where most files have no leading doc comment) to 95%
(CodeExam) of candidate functions across ten indexes, and was measured at ~8% of all indexed
functions on ExoPlayer3 on 2026-08-02, before the command-catalog seed and the doc-header file
seed became defaults later that month (issue #302). The mechanisms index built by
`--build-mechanisms` covers 100% on every index measured 2026-11-03; the drafting list is a
sample by design, the cover a separate artifact.

## What the real-world test says about candidate identification (2026-10-24, rerun 2026-11-02)

On fourteen litigated filings, CodeExam's three top-ranked groups per repository, drafted and
compared with the asserted claims, came as close as the litigants' own cited functions on six
of twelve pairs and closer on two; on the four pairs whose claim turns on one specific
mechanism they wrote nothing of it, and the cited code sat low in the ranking. Candidate
identification finds what is distinctive in a codebase; what a patent reads on is often a
standard mechanism, or a vendored one. The numbers and the reading are in *The real-world
yardstick* below and on [`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md).
Run again on 2026-11-02 after the purpose-preamble and whereby rules, same groups, judge and
controls (twelve of the fourteen; the two refused by the cost guard stay unrun): the plain
read unchanged, twelve findings of 42 with three up and three down; the strict read's MET
count doubled, 10 to 20, and strict findings 2 to 4, all on the finite-field pairs; the
preamble median 12 to 17 words against attorneys' preambles that are mostly bare; the closing
clause on 25 of 42 drafts, the same overshoot as the free-text samples. One sample per cell;
the page carries the table.

The `--rank` rubric is exploration priority, not "what a patent would read on": in this test
the code the litigants' claims read on sat at P1 and P2 in the rankings ("standard-pattern",
"crypto plumbing", "third-party") while the P3s were the codebases' own distinctive
arithmetic. Cost of ranking: $0.12 for 57 groups, $1.62 for 959 (Claude Sonnet 4.6,
2026-10-24).

## The real-world yardstick (2026-10-23 and 2026-10-24)

The self-test below manufactures its claims. A second test uses real ones: it seeds the
drafter with the functions fourteen litigants cited in public claim charts, nothing else, and
compares each drafted claim element by element to the asserted claim, with a floor (a draft
from an unrelated group of the same codebase) and a control (the same draft against another
filing's claim of the same art). It measures the drafter's ceiling on real claims: whether,
given a party's own code, the drafter writes something close to that party's claim. Its other
half (2026-10-24) seeds the drafter with CodeExam's own top-ranked candidate groups instead
(`--pseudo-claims --candidates --rank`, the top three per repository) and judges them the
same way: pseudo-claims as a test bed for claim charts, with the public filings as the answer
key, which is agreement with a party, never correctness.

**How CodeExam did.** With the litigants' references, the pseudo-claim reaches met or partial
on the asserted claim's mechanism elements, above the floor and the control, on 11 of 15
pairs scored; it reaches MET, the same limitation in substance, on 3 pairs. Everywhere else
the elements are PARTIAL: the drafter writes the mechanism at the code's grain and the claim
states it at the patent's; what a claim asserts beyond the code is not written from any seed.
Without the references, CodeExam's own top three groups came as close as the citation on six
of twelve pairs and closer on two, and wrote nothing of the claim on four, the ones whose
crux is one mechanism in one place; there the cited code sat at P1 or P2 in the ranking. Read
together: as a description of the code it is given, the drafter is confirmed within the
test's limits; as a way to find, unaided, the code a patent reads on, it is not, and the
limit is in the ranking's axis rather than in the drafter.

**What follows from it.** A comparison arm (unranked, `--rank`, and a ranking built for "what
would a hostile party find significant here") on the same pairs is the next measurement
before any new ranking is built; the sketch is on the ceiling page. The `--min-rank` default
of P2 on ranked lists deserves a second look, since it drops the P1 groups that two of the
four misses lived in. The limits of the test are stated on the same page: one model as
ranker, drafter and judge, one sample per row, fourteen filings. Method, tables, the four
quoted rows and the reading: [`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md).

## Self-test: "huffing our own fumes" (HOF)

Pseudo-claims are not only a deliverable. They are one way CodeExam tests its own ability to
bridge *claim prose* and *code*, and a way to **manufacture ground truth on any index**. The
usual claim-to-code answer keys are all limited in scope: a hand-built set is tiny, `.demo`
was LLM-authored, and a real patent may share vocabulary with *its own* implementation (only
may, because the patent attorney will have taken what the developers did and broadened the
claim description to try to capture more IP). A "match" may be mere word overlap rather than
real claim-to-code skill. Usually claim-to-code mapping involves one party's patent claim and
*another* party's code; see issue #322 on CodeBERT.

The self-test runs:

1. **Draft** pseudo-claims from code with their **code references attached** (a candidate
   mechanism, then a pseudo-claim, then the anchors it was drafted from).
2. **Synonymize with a *different* LLM**, *withholding* the code references
   (`--synonymize`). This is the load-bearing step: it rewords the claim *away* from the
   code's own identifiers, so any later recovery cannot be mere vocabulary overlap.
3. **Retrieve**: feed the reworded claim to `--claim-analyze` / multisect and measure whether
   it lands back on the original references, with each reference attributed to a plausible
   element of the claim rather than merely found.

Agreement means the claim captured the *mechanism*, not just echoed its names.
`--claims-loop` repeats draft, retrieve, compare, refine to convergence (#290). Full
write-ups: [`claims-pipeline-state.md`](claims-pipeline-state.md) (§4 / §9 / §10) and
[`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md) (the HOF
section; #310).

**One command (2026-11-03; `ce --hof` since 2026-11-09).** `scripts/hof.mjs` ran the test
from an index name as `ce` subprocesses; since 2026-11-09 `ce --ndx <index> --hof` runs it in
one process with a whole-run cost preflight, its files under `<index>/hof/`, an optional
`--synonymize-with <engine>` step between the drafter and the locator, and a "How to read
this" footer on every report ([`cli.md`](cli.md)); the script stays until a parity run
retires it. The test as the script ran it, with `--claim-locate` as the retrieval step and no
synonymize step: it drafts every candidate
group (`--pseudo-claims --candidates`, then `--claims-only` with `--min-rank 0`, so a
`--rank` tag is reported and never a floor), locates each draft (`--claim-locate
--targets-out`), and scores the drafter's grounded anchors against the located targets on
the ladder of `scripts/anchor-recall.mjs`: function, class, file or miss per anchor, and
exact, near or elsewhere per target. `--form-rules 2026-10` drafts on the rules as they stood
before 2026-11-01; `--claims <file>` locates an existing claims file, so the same drafts can
be located with a second model; `--include-tests` goes to the locate step only; `--dry-run`
runs the grouper only and prints the rest with the cost figures. Every step is a `ce`
command, echoed, and the report (`hof_report.md`, `.json`) lands under
`%LOCALAPPDATA%\CodeExam\hof\`. Without the synonymize step the drafter's own vocabulary goes
back in, so the result is a floor; the ladder, not a single number, is what to read.
`scripts/hof-stage1.mjs` reads the same run directories and asks a different question, with
no model: scored by the text a grouper group already carries (label, purpose, member and file
names), where does the group a claim was drafted from rank among all the groups of its index?
It is the feasibility check for retrieving from a mechanisms index instead of the symbol
table (issue #359).

**The first `ce --hof` run (2026-11-09).** CodeExam's own index (140 files, 3,325 symbols),
ChatGPT API gpt-5.1 drafting and locating, `--force` past the $2 guard: 212 groups, 212 drafts,
212 locates, two hours in one process; the preflight projected $6.88 and the two steps' own cost
lines summed to $7.00. The ladder: 1,175 anchors, function 70%, class 1%, file 25%, miss 3%;
7,729 located targets, exact 11%, near 16%, elsewhere 73%; two claims not located, the locator's
"No symbol selections were parseable" exit, which `--hof` did not retry until later that day, so 14 of the 41 misses
are that exit and not the locator's reach. Two things to read with the figures: the claims were
located in the drafter's own words, a floor; and the drafts ran long, median 376 words and 191
of 212 over the litigated population's p90 of 257 (the artifact's shape line flags each),
where the 2026-11-03 four-claim runs on the same index and rules had Claude at a p90 of 222
words and ChatGPT at 417, so the length is the model's, and a claim that long carries more of
the code's vocabulary for the locator to match on. The run's files are under
`.CE/hof/261110-0017/`, outside the repo.

**The same groups on Claude (2026-11-09, the second `ce --hof` run).** `ce --ndx .CE --hof
--llm claude --force` on the index the ChatGPT run used, not rebuilt in between: the two runs'
`cand.lst` are identical, members and rank tags, so what differs is the model (Claude API
claude-sonnet-4-6 drafting and locating). Between the runs `--hof` gained its retry of a locate
whose selections did not parse ([`cli.md`](cli.md)), so this run's not-located count is after
one retry and the first run's before any. Read with the drafter's own shape axes from both
sidecars and both `hof_report.json`; the report scores each function once per claim where the
sidecar lists it once per element that cites it, so both anchor counts are given:

| | ChatGPT gpt-5.1 (`261110-0017`) | Claude sonnet-4-6 (`261110-0452`) |
|---|---|---|
| words median / p90 / max (band 85–257) | 376 / 515 / 877 | 230 / 301 / 407 |
| claims over the band / in band on every axis | 191 / 20 | 71 / 114 |
| elements median (band 3–8); rows median (band 4–11) | 7; 12 | 7; 9 |
| words per row median (band 15–36); mechanism rows median (band 2–7) | 31; 9 | 25; 6 |
| anchors cited / distinct per claim (the ladder scores the distinct) | 1,208 / 1,175 | 1,503 / 1,237 |
| ladder per anchor: function / class / file / miss | 70% / 1% / 25% / 3% | 63% / 2% / 27% / 8% |
| function / miss, net of the claims the locator did not locate | 70.5% / 2.3% | 66.6% / 3.1% |
| targets per located claim; exact / near / elsewhere | 37; 11% / 16% / 73% | 27; 14% / 18% / 68% |
| locates not parseable: first run / recovered by the retry / not located | 2 / no retry / 2 | 16 / 4 / 12 |
| draft step; locate steps | 48 min, $3.67; 74 min | 81 min, $6.61; 65 min |
| whole run, actual / projected | 2 h 02, $7.00 / $6.88 | 2 h 26, $13.30 / $12.88 |

What the two questions get. The length is the model's: same prompt, same groups, Claude's
median is in the band and 114 of its 212 claims are in band on every axis against ChatGPT's
20; by group the two models' word counts correlate at r = 0.38 and share 7 of their 20
longest, so a little of it is the group. On both models the words per row are in band and the
excess is rows (ChatGPT 12 per claim and 9 mechanism rows against bands of 4–11 and 2–7), so a
long draft says more things, not each thing at length; that is the shape a length re-ask has
to act on. The ladder does not ride on length: Claude's drafts are 39% shorter and cite more
anchors (1,503 to 1,208, though only 5% more distinct ones, since Claude cites the same
function from several elements more often), and net of the claims the locator did not locate
its function rung is four points lower with the miss rung the same. Not a clean separation,
since the locator changed with the drafter; `--claims` on the other model's drafts (about $6 a
run) is what would separate them. The finding not asked for is the locator's: 16 first-run
locates ended at the "No symbol selections were parseable" exit (ChatGPT, 2) and 12 failed the
same way on the retry, two thirds of the miss rung; the command keeps nothing of the model's
reply on that exit, so the cause is unrecorded, as it was for True Return on 2026-10-22
([`claims-pipeline-state.md`](claims-pipeline-state.md)), and keeping that reply is the next
change to the locator. The retries (16 calls, about $0.50) are outside the projection, as the
plan line says; net of them the run came in within 1% of it. Claude's drafts took 23 s each
against ChatGPT's 14; its locates 16 s median against 21. The run's files are under
`.CE/hof/261110-0452/`, outside the repo.

**Where HOF went next (2026-11-05 and 11-06).** The mechanism grain the stage1 check asked
about was measured in full on [`describe-reach.md`](describe-reach.md): with the mechanisms'
labels and member names as the text and a local embedding model, the mechanism holding a HOF
anchor ranks first for 61% of 332 anchors over eight indexes and within 25 for 96%, against
35% at the function rung for `--claim-locate`; a model reading the five nearest labels and
choosing one (the chooser) lifts the per-anchor figure to 84% on HOF claims but not on the
litigants' claims, whose gap is register rather than vocabulary. The same page carries the
litigants' numbers at that grain. For one draft, `--embed-distance "<claim>" --filter
<anchor>` prints the same thing with no model: the claim's distance to every mechanism of
its index, the median as the baseline, and the row of the mechanism holding the anchor at
its rank, which is the model-free half of the round trip ([`cli.md`](cli.md)).

## Related

- [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md), the feature page these tests
  stand behind.
- [`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md), the yardstick's method,
  tables and quoted rows.
- [`claim-chart-agreement.md`](claim-chart-agreement.md), the agreement harness over the
  fourteen public claim charts.
- [`describe-reach.md`](describe-reach.md) and [`embedding-reach.md`](embedding-reach.md), the
  mechanism-grain and symbol-grain retrieval measurements.
- [`claims-pipeline-state.md`](claims-pipeline-state.md) §4, where HOF sits in the pipeline;
  [`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md), what "ground truth"
  means for the claim features.
- [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md), the grouper's cover and how a label is
  read.
