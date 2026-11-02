# Pseudo-claims for CodeExam's candidate identification (rubric page)

A hand rubric: one claim set for the feature, every row cited to the code, used as the fixed
rows a `--pseudo-claims` run is scored against (`scripts/pseudo-claim-rubric-score.mjs`, #353
part (e)). Written 2026-10-27 from Andrew's notes of 2026-10-27 and the working tree of
2026-10-27 (`7c93118`); placed here 2026-10-31 with the citations table as written that day.
Line numbers move with later commits, function names do not; see the note above the table.
The scorer reads the `**N.**`, `(a)` and `wherein` markers under the Set heading and the
citations table at the end. The working notes the scratch original carried (comments
answered, what the drafts missed) stay outside the repository.

**As first written:**

Two claim sets, for use beside the multisect pseudo-claim in testing. Set P, on
`pseudo-claims-drafting.md`, is the drafting pipeline with the references given. Set D, this
page, is the identification of candidate mechanism groups. Each set numbers its own claims
from 1. The claim text is kept free of code citations; the table at the end maps every
element and dependent to the lines it was written from, with a provenance tag: `[A]`
Andrew's notes, `[C]` the code. No drafter output was used for this set.

Conventions: a project term appears in parentheses after its plain-language introduction
and is used bare afterward.

---

## Set D: identifying candidate mechanism groups

**1.** A method of identifying, in a body of source code, candidate mechanisms for
patent-claim drafting, comprising:

(a) providing an index of the source code in which each function is recorded with its file,
start line and end line and, for a method, its class, and a ranked vocabulary of the
identifier tokens of the source code, the vocabulary built from the index on first use
when not already present;

(b) enumerating candidate functions by passing over every indexed function and excluding
functions in noise files, functions marked by a test attribute in the lines preceding
their declaration, functions shorter than a minimum length, and functions in third-party
subtrees identified by a nested package manifest or by a copyright holder differing from
the project's;

(c) extracting from the vocabulary a ranked set of concept tokens, being sub-terms of
compound identifiers, each token's score reduced in proportion to its frequency across a
catalog of other bodies of source code;

(d) forming groups from the candidate functions by applying seeds in a fixed order, each
seed taking only functions no earlier seed assigned:

  - a token seed, assigning each candidate whose name carries a concept token to its
    highest-ranked such token, excluding any token that both owns more than a set
    fraction of the candidates and occurs in more than a set fraction of the files;
  - a class seed, assigning the methods of each of the most method-rich indexed classes;
  - a command seed, assigning, for each command-line option whose handler resolves to one
    indexed function, the handler and the functions it reaches through callees to a set
    depth under a member cap; and
  - a file seed, assigning the remaining functions of each file that opens with a comment
    describing the file;

(e) discarding any group having fewer than a minimum number of members, and any member
whose reference does not resolve to exactly one indexed function;

(f) splitting any group other than a command group that exceeds a maximum size, by
partitioning its members over the sub-terms of their names, retaining the members no
sub-term claims as a residual sub-group, and rejecting a split whose largest part holds
more than a set share of the parent;

(g) labelling each group by its seed, as a token with an exemplar function, a class name, a
command option, or a file name marked as a remainder when other seeds took part of the
file, and attaching a purpose line harvested from the file's leading comment or the
members' comments; and

(h) writing the groups as a list in which a label line precedes each group's reference
lines, headed by the counts of functions enumerated, excluded and grouped, the splits made,
the depth and cap of the command seed, and the pairs of groups sharing a dominant file,

wherein the groups are produced without a language model, whereby the set of mechanisms
identified does not vary with the model that drafts from it.

**2.** The method of claim 1, in which the minimum length is four lines, the concept tokens
number twenty-four, the classes admitted number twelve, a token is excluded when it owns
more than one fifth of the candidates and occurs in more than one quarter of the files,
the minimum number of members is three, the maximum size is fifteen, the share is four
fifths, the depth is two, the member cap is forty, and the command groups are capped at
twenty-four.

**3.** The method of claim 1, in which the class seed forms no group when the index records
no classes and the command seed forms no group when the source code has no command-line
options, the remaining seeds proceeding unchanged.

**4.** The method of claim 1, in which the noise files are test, vendor, minified, build,
lockfile, distribution and backup files, identified by path pattern and file name.

**5.** The method of claim 1, in which the command seed treats options sharing one handler
as one group, labelled by the first option with the others listed as aliases, takes
options largest-group-first, and does not split a command group.

**6.** The method of claim 1, further comprising, on request, a literal seed assigning
functions that share a rare string literal, the literal being at least a minimum length,
containing a word, and occurring in at least two and at most a set number of candidate
functions, the functions joined transitively and a joined set larger than any single
literal's permitted spread rejected whole.

**7.** The method of claim 1, further comprising, on request, retrying, for a concept token
whose name matches fell below the minimum number of members, membership by the token's
occurrence in function bodies, identifiers, call sites and strings alike, a token
occurring in more than a set number of bodies being rejected.

**8.** The method of claim 1, further comprising, on request, including documentation files
in the vocabulary from which the concept tokens are extracted, or attaching to each group
the documentation sections that best match it as line-range references, the sections
decorating groups already formed and forming none.

**9.** The method of claim 1, further comprising, on request, keeping the third-party
subtrees among the candidates.

**10.** The method of claim 1, further comprising, on request, one comparative pass of a
language model over the list that assigns each group a priority from zero to three, a
signal among codebase-specific, standard-pattern, library-wrapper, third-party and
generated, and a fold directive, the groups presented in batches with mechanical priors
comprising the member count and file count, a rubric biased toward demotion with a forced
spread, and the top groups of each batch re-ranked together, the list being reordered and
annotated and the references left unchanged.

**11.** The method of claim 10, in which drafting from the annotated list defaults to groups
of priority two or above.

**12.** The method of claim 1, further comprising selecting groups whose labels match a
substring or regular expression, and either writing the selected groups to a file,
printing them, or passing them directly to the drafting method.

**13.** The method of claim 1, further comprising scoring the groups against a hand-authored
list of groups for recall and precision.

**14.** The method of claim 1, in which the purpose line of a group marked as a remainder
states the file, how many of its functions other seeds took, and the members' names and
comments, so that a description drafted from it describes the remainder and not the
module.

---

## Citations and provenance

Lines in the table were keyed to the working tree of 2026-10-27, commit `7c93118`, and carried
here as written on 2026-10-31. The same day, the four ranges into `src/commands/pseudo-claims.js`
(grown by about 600 lines since: `f87ec14`, `940dfbb`, `82ee8a1`, `66cf85a`) and the two into
`docs/CODEEXAM_PSEUDO_CLAIMS.md` were re-keyed to the tree at `1c05834` (the doc after this
page's own commit edited its rubric-gate paragraph, which sits above the cited lines) by
locating the `7c93118` text of each range's first and last lines in the current file and,
where the cite names a function, taking the function's current extent; those rows say
"re-keyed 2026-10-31" in the provenance column. The grouper, ranker, schema, triage,
genericity and class files are unchanged since 2026-10-27, so every range into them holds as
written. Function names hold throughout. The two doc cites move whenever the doc grows above
the cited lines; last re-keyed 2026-10-31 with `pseudo-claims-grounder-scorer-antecedent-preamble`
and keyed to that commit.

`pc` = `src/commands/pseudo-claims.js`, `mg` = `src/core/mechanism-grouper.js`,
`mr` = `src/core/mechanism-ranker.js`.

| claim | where | provenance |
|---|---|---|
| D1 preamble | Andrew's notes, 2026-10-27 | A |
| D1(a) | `mg:122-141` (`gatherConcepts`), `src/core/vocabulary.js:363` (cached vocabulary, built on first use) | A→C |
| D1(b) | `mg:271-315`, `mg:142`, `mg:158`, `mg:218-259` | A→C |
| D1(c) | `mg:122-141`; `extractConcepts` in `vocabulary.js` (cross-corpus catalog) | A→C |
| D1(d) | `mg:384-705`: token `392-417`, class `418-443`, command `444-533`, file `632-696`; `isOverBroadNamespace` `351-365` | A→C |
| D1(e) | `mg:773`, `mg:756`, `minComm` 3 | C |
| D1(f) | `mg:883-937`, `mg:821-882`; command groups exempt `mg:955-957` | A→C |
| D1(g) | `mg:366`, `mg:378`, `mg:708-743`; `pc:976-1024` (`harvestPurpose`) | A→C; `pc` re-keyed 2026-10-31 |
| D1(h) | `mg:1098-1203`, `mg:1084`, `mg:1261` | C |
| D1 wherein | `docs/CODEEXAM_PSEUDO_CLAIMS.md:376-381` | C (doc); re-keyed 2026-10-31 |
| D2 | `mg:25-99` (`GROUPER_DEFAULTS`) | C |
| D3 | `mg:418-443` (class seed over indexed classes only), `mg:71-74` (catalog seed no-op without a command surface) | C |
| D4 | `mg:142-157` | C |
| D5 | `mg:462-500`, `mg:955-957` | C |
| D6 | `mg:534-587` | C |
| D7 | `mg:588-631` | C |
| D8 | `--use-docs`; `mg:1035-1083` (`docAnchorsForGroup`) | C |
| D9 | `--include-vendored`, `mg:218-270` | C |
| D10 | `mr` header and `mr:61-105`, `mr:194-230` (playoff) | C |
| D11 | `--min-rank`, `pc:1025-1043` (`parseMinRank`) | C; re-keyed 2026-10-31 |
| D12 | `pc:2217-2234` | C; re-keyed 2026-10-31 |
| D13 | `mg:1285-1323` | C |
| D14 | `pc:935-943` (`HARVEST_CAP`, `isResidueLabel`), `pc:991-999` (the remainder branch of `harvestPurpose`) | C; re-keyed 2026-10-31 |

Not claimed, because the code does not do it: graph decomposition of the call graph
(`mg:16-19` records the failed prototype); any seed beyond the command seed using call or
import edges; completeness of coverage (`docs/CODEEXAM_PSEUDO_CLAIMS.md`, the "It samples; it
does not survey" paragraph, lines 401-419; 241-262 at `7c93118`, re-keyed 2026-10-31).

An apparatus rendering of this set is mechanical: each step becomes a unit configured to
perform it, and the data between steps (the candidate list, the concept tokens, the
assignments, the groups) is the connective tissue. Not written out here.

---

## Scores (2026-10-31)

Scored with `node scripts/pseudo-claim-rubric-score.mjs`
`--rubric docs/pseudo-claim-rubrics/pseudo-claims-candidates.md --run <file>` for each run below:
the best run claim per run (MET counted twice, PARTIAL once)
among the claims with an anchor that matches a row's cite. MET is a cite match with half the
row's content words present, PARTIAL a cite match with a quarter or the words without the cite;
the overlap is a keyword proxy printed beside every verdict, and the reading stays the human's.
The runs are files in the project root of this checkout, not in the repository; "none" means no
claim in that run meets or partly meets a row. The first six runs are the five pages' baselines;
the four of 2026-10-25 were run with `--filter pseudo`, so they reach this feature's own groups.
The Gemma 4 row's claim 25 is the one read by hand on 2026-10-31 (element (d), the seeds,
missing; the pack had shown `multiSeedGroups` at 960 characters), and its 22 surplus lines
binned grounded-substantive are where that reading credited more than the scorer does.

| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |
|---|---|---|---|---|---|---|
| CE_pseudo_claim_test_102526_720pm_norank.txt (10/25 7:20pm, Claude, 41 claims) | 29 ([cmd] --pseudo-claims) | 1 | 0 | 22 | 16 / 1 / 2 | 2 |
| CE_pseudo_claims_vocab_concept_overview_Claude.txt (10/27, Claude, 18 claims) | 13 ([file] mechanism-grouper.js / rest) | 2 | 9 | 12 | 19 / 1 / 2 | 3 |
| CE_pseudo_claims_vocab_concept_overview_ChatGPT.txt (10/27, ChatGPT, 18 claims) | 13 ([file] mechanism-grouper.js / rest) | 2 | 6 | 15 | 14 / 0 / 0 | 4 |
| gemma4_CE_pseudo_claims_102926.txt (10/29, Gemma 4 on the Asus, 41 claims) | 25 ([file] mechanism-grouper.js / rest) | 1 | 4 | 18 | 22 / 1 / 1 | 3 |
| CE_pseudo_concept_overview_103026.txt (10/30, Claude, 12 claims) | 9 ([file] mechanism-grouper.js / rest) | 1 | 6 | 16 | 20 / 1 / 3 | 2 |
| CE_pseudo_vocab_103026.txt (10/30, Claude, 9 claims) | 1 ([file] vocabulary.js / rest) | 0 | 2 | 21 | 12 / 2 / 7 | 2 |
| CE_pseudo_claims_CE_pseudo_102526_210pm.txt (10/25 2:10pm, Claude, `--filter pseudo`, 18 claims) | 17 ([file] mechanism-grouper.js / rest) | 2 | 11 | 10 | 12 / 1 / 3 | 4 |
| CE_pseudo_claims_CE_pseudo_102526_250pm.txt (10/25 2:50pm, Claude, `--filter pseudo`, 12 claims) | 8 ([file] mechanism-grouper.js / rest) | 2 | 10 | 11 | 10 / 0 / 7 | 3 |
| CE_pseudo_claims_CE_pseudo_102526_405pm.txt (10/25 4:05pm, Claude, `--filter pseudo`, 9 claims) | 7 ([cmd] --pseudo-claims) | 1 | 0 | 22 | 18 / 2 / 0 | 2 |
| CE_pseudo_claims_CE_pseudo_102526_525pm.txt (10/25 5:25pm, Claude, `--filter pseudo --claim-class all`, 27 claims) | 20 ([cmd] --pseudo-claims [system]) | 1 | 2 | 20 | 16 / 0 / 4 | 6 |

## Scores under the union rule (2026-10-31)

The table above was scored under the 2026-10-30 rule: a row is credited from the claim's single
best line. Under the union rule of 2026-10-31 (`--rule union`, the default since; `--rule
best` reproduces the table above), a row is also read from up to four of the claim's lines as
one text, each carrying at least two of the row's words and a tenth of them, and the verdict
takes the higher of the two readings; a line that joined a credited row's union is not surplus
when the row covers a quarter of its words. The table above is kept as the measurement it was.
Calibrated on every page and run in hand (1,234 rows: 923 unchanged, 307 up one step, 4 from
ABSENT to MET, none down): on the hand-read cells of this page the rule leaves the 10/29 Gemma
claim's seeds row ABSENT and reads the Claude drafts of 2026-10-31 that name the seeds as
PARTIAL and MET; the no-op row no draft states stays under MET. Same runs:

| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |
|---|---|---|---|---|---|---|
| CE_pseudo_claim_test_102526_720pm_norank.txt (10/25 7:20pm, Claude, 41 claims) | 29 ([cmd] --pseudo-claims) | 1 | 4 | 18 | 13 / 0 / 2 | 2 |
| CE_pseudo_claims_vocab_concept_overview_Claude.txt (10/27, Claude, 18 claims) | 13 ([file] mechanism-grouper.js / rest) | 7 | 9 | 7 | 11 / 0 / 1 | 3 |
| CE_pseudo_claims_vocab_concept_overview_ChatGPT.txt (10/27, ChatGPT, 18 claims) | 13 ([file] mechanism-grouper.js / rest) | 6 | 6 | 11 | 6 / 0 / 0 | 4 |
| gemma4_CE_pseudo_claims_102926.txt (10/29, Gemma 4 on the Asus, 41 claims) | 25 ([file] mechanism-grouper.js / rest) | 2 | 7 | 14 | 10 / 1 / 1 | 3 |
| CE_pseudo_concept_overview_103026.txt (10/30, Claude, 12 claims) | 9 ([file] mechanism-grouper.js / rest) | 4 | 6 | 13 | 10 / 1 / 1 | 2 |
| CE_pseudo_vocab_103026.txt (10/30, Claude, 9 claims) | 1 ([file] vocabulary.js / rest) | 1 | 2 | 20 | 12 / 2 / 7 | 2 |
| CE_pseudo_claims_CE_pseudo_102526_210pm.txt (10/25 2:10pm, Claude, `--filter pseudo`, 18 claims) | 17 ([file] mechanism-grouper.js / rest) | 7 | 6 | 10 | 6 / 0 / 2 | 4 |
| CE_pseudo_claims_CE_pseudo_102526_250pm.txt (10/25 2:50pm, Claude, `--filter pseudo`, 12 claims) | 8 ([file] mechanism-grouper.js / rest) | 9 | 7 | 7 | 2 / 0 / 1 | 3 |
| CE_pseudo_claims_CE_pseudo_102526_405pm.txt (10/25 4:05pm, Claude, `--filter pseudo`, 9 claims) | 7 ([cmd] --pseudo-claims) | 1 | 4 | 18 | 14 / 1 / 0 | 2 |
| CE_pseudo_claims_CE_pseudo_102526_525pm.txt (10/25 5:25pm, Claude, `--filter pseudo --claim-class all`, 27 claims) | 20 ([cmd] --pseudo-claims [system]) | 1 | 7 | 15 | 12 / 0 / 2 | 6 |
| CE_pseudo_rubric_features_claude_103126_rules.txt (10/31, Claude, the two prompt rules, 8 claims) | 5 ([file] mechanism-grouper.js / rest) | 5 | 9 | 9 | 6 / 0 / 1 | 4 |
| CE_pseudo_rubric_features_claude_110126_whereby.txt (11/01, Claude, the purpose-preamble and whereby rules, 16 claims, both classes) | 10 ([file] mechanism-grouper.js / rest [system]) | 10 | 6 | 7 | 9 / 0 / 1 | 9 |
| CE_pseudo_rubric_features_claude_110126_whereby.txt (11/01, the same run, its method claim only: `--claims 9`) | 9 ([file] mechanism-grouper.js / rest [method]) | 6 | 6 | 11 | 7 / 0 / 0 | 1 |

The last row is the after for the two drafting rules of 2026-10-31 (#353 (a) and (b)); its exact
before is the same group drafted the same day on the old prompt at the same pack, the default
cell of the Claude three-mode run, 9 / 9 / 5 under this rule. One draft each: the after keeps
the seeds row and loses two MET rows the earlier draft had written as dependents (the
vocabulary cached on first use, the ground-truth scoring), which one sample cannot tell from
the prompt's effect.
