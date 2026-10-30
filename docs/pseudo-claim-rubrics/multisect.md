# Pseudo-claims for CodeExam's multisect search (rubric page)

A hand rubric: one claim set for the feature, every row cited to the code, used as the fixed
rows a `--pseudo-claims` run is scored against (`scripts/pseudo-claim-rubric-score.mjs`, #353
part (e)). Written 2026-10-27 from Andrew's notes, the drafts of the 10/25, 10/27 and 10/29 runs
and the working tree of 2026-10-29 (`86ef26b` plus the pack work that landed as `f87ec14`);
line numbers move with later commits, function names do not. The scorer reads the `**N.**`,
`(a)` and `wherein` markers under the Set heading and the citations table at the end. The
working notes the scratch original carried (comments answered, what the drafts missed) stay
outside the repository.

**As first written:**

One claim set, Set M, for use beside the pseudo-claims sets in testing. Claim 1 is Andrew's
independent claim as revised on 2026-10-26 (`multisect_pseudo_claim_indep_revised_102626.md`),
with one insertion noted below. The dependents are built from Andrew's draft dependents 2 to 7
in that file and from groups B1 to B15 of the organized rubric
(`multisect_pseudo_claim_rubric_organized_102626.md`), one feature per claim. The claim text is
kept free of code citations; the table at the end maps every element and dependent to the
lines it was written from, with a provenance tag: `[A]` Andrew's notes or draft, `[C]` the
code, `[A→C]` Andrew's wording corrected against the code. The 7:20pm drafts (claims 39 and 8)
were not consulted; the rubric's section H compared them after the fact and nothing from
them is used here.

Where Andrew's draft dependents went: his 2 is claim 8; his 3 is dropped, because nothing in
multisect measures rarity beyond the indexed body (the cross-corpus catalog belongs to the
vocabulary feature's concept extraction); his 4 is split into claims 2, 3, 4, 11, 12 and 14,
with its item (g) removed because every term, regular expressions included, is compiled
case-insensitive and no case-sensitive mode exists (#138 proposes one); his 5 is claims 6 and
29; his 6 is claim 12; his 7 is claim 7. The one insertion in claim 1 is the parenthetical
("scope") in step (f), which gives the dependents the antecedent his note on draft 2 asked
for.

Conventions: a project term appears in parentheses after its plain-language introduction and
is used bare afterward. No examples inside an element. Folder scope is a dependent, as in
Andrew's draft.

Lines in the table are in the working tree as of 2026-10-27; the `.CE101826` index is the
2026-10-18 zip and a few of its lines differ by one or two.

---

## Set M: multisect search

**1.** A method for identifying, in a body of source code, units of code within which a set
of search terms co-occur, reported from the narrowest unit to the widest, comprising:

(a) receiving a plurality of search terms as a single delimited list, each term being a
literal or a pattern, matched without regard to case, the terms representing a set without
any implied or explicit order among its members;

(b) for each said search term, determining the set of files in which it occurs anywhere in
the file's contents or in its path or filename;

(c) designating as survivor files those files, among the files determined in (b), in which
at least a required minimum number of the terms occur, the minimum number defaulting to the
total number of terms and being settable lower;

(d) for each said survivor file, locating, for each term occurring in it, at least one line
on which the term occurs and the function or method, delimited by recorded start and end
lines, that contains that line;

(e) determining, for each of a plurality of nested units, namely each function or method
located in (d), each class whose methods lie in one or more files, and each survivor file,
the number of distinct terms occurring within it, a unit matching when that number is at
least said minimum number;

(f) reporting the matching units by kind of unit ("scope") from narrowest to widest, a
function or method being narrower than the class containing it and than the file containing
it; and

(g) reporting each co-occurrence at the narrowest unit that contains it, by withholding a
wider unit whose co-occurring terms are all also contained in a narrower unit lying, in
whole or in part, within it.

**2.** The method of claim 1, in which the delimited list is separated by semicolons, and a
doubled semicolon within a term stands for a literal semicolon.

**3.** The method of claim 1, in which a term enclosed in slashes is a regular expression, and
a term that is not a valid regular expression ends the search with a message naming the
term.

**4.** The method of claim 1, in which a dot within a term that is not enclosed in slashes
stands for at most one character of any kind, so that one term written with a dot matches an
identifier in which the corresponding position holds no character, an underscore, a hyphen
or any other character.

**5.** The method of claim 1, in which a term that is neither enclosed in slashes nor contains
a dot matches wherever its characters occur in a line, without regard to word boundaries, so
that the term matches an identifier of which it is a part.

**6.** The method of claim 1, in which said minimum number is received as a count, is reduced
to the number of terms when it exceeds that number, and is at least one.

**7.** The method of claim 1, in which a term occurring in no file of the body of source code,
by contents or by path, is reported as absent and is not counted in said minimum number, the
minimum number being recomputed over the terms that occur somewhere, and the absent term
remaining in the per-term report of every reported unit.

**8.** The method of claim 1, in which the matching units of one scope are ordered by the
number of terms matched and then by a score, the score being the sum, over the terms
occurring in the unit, of a rarity of each term, the rarity being the natural logarithm of
the number of files in the body of source code divided by the number of files in which the
term occurs, the sum multiplied by a density factor that decreases with the number of lines
in the unit.

**9.** The method of claim 8, in which a term whose only occurrence in a unit lies on a
comment or annotation line, as classified from the text of the line by a fixed rule, counts
one quarter toward the number of terms matched and contributes one quarter of its rarity to
the score, an occurrence on both a comment line and a code line counting as a code
occurrence; and in which the unit's report shows the number of terms matched in code when it
differs from the number matched, and marks each comment-line occurrence.

**10.** The method of claim 8, in which the density factor is the reciprocal of one plus the
common logarithm of the unit's line count divided by fifty, so that a unit of fifty lines or
fewer has a factor of one and a unit of five hundred lines a factor of one half, a class's
line count being the sum of its methods' line counts, and a unit having no line count taking
a factor of one.

**11.** The method of claim 8, in which a term prefixed by a softness marker is a soft term, a
soft term being matched but not counted toward said minimum number, each soft term occurring
in a unit adding its rarity to the unit's score, and a list consisting of soft terms only
having a minimum number of zero, so that units containing any of them are reported.

**12.** The method of claim 1, in which a term prefixed by a negation marker is a negated
term, a negated term being neither counted toward said minimum number nor counted among the
terms occurring in a unit, and a unit in which a negated term occurs being withheld from the
matching units.

**13.** The method of claim 12, in which a file or a class is withheld when the negated term
occurs anywhere in the file or in any file holding a method of the class, and a function or
method is withheld only when the negated term occurs within its own recorded start and end
lines.

**14.** The method of claim 11, in which the softness marker composes with a negation marker,
a term bearing both being a discouraged term, and a unit in which a discouraged term occurs
is retained, marked as containing it, and has the term's rarity subtracted from its score.

**15.** The method of claim 1, in which step (b) is completed for every term over every file
before any line is located in step (d), and lines are located in step (d) only in the
survivor files together with any files added on account of a class, so that the cost of
locating lines is paid for those files and not for the body of source code as a whole.

**16.** The method of claim 15, in which, before lines are located, each class is identified
whose methods' files together contain at least said minimum number of the terms, and every
file holding a method of such a class is added to the files in which lines are located, so
that a class whose methods lie in several files is found as a matching unit when no single
one of its files contains the required number of terms.

**17.** The method of claim 1, in which, in step (g), a class is withheld when one of its own
methods contains every term the class matched, a file is withheld when a function or method
within it, or a class having a method within it, contains every term the file matched, the
report of each scope states how many units were withheld and on what ground, and the
withheld units are shown on request.

**18.** The method of claim 1, in which every ancestor directory of each file in which a term
occurs is also a unit ("folder"), wider than any file beneath it, a folder matching when the
distinct terms occurring in the files beneath it number at least said minimum number, a
folder being withheld from the report when a single file beneath it contains every term the
folder matched, and a folder's report naming, for each term, the files beneath it in which
the term occurs and each term that occurs in none of them.

**19.** The method of claim 1, in which the report of each matching unit lists, for each term,
the line number and text of the term's first occurrence in the unit, terms first occurring
on the same line being collapsed into one row, and lists each term not occurring in the unit
as not found, so that a unit matching fewer than all the terms shows which terms it lacks.

**20.** The method of claim 1, further comprising reporting, before the matching units, for
each term, the number of files in which it occurs and that number as a share of all files,
with a rating of the term's discrimination at fixed thresholds of the share, a term
occurring in no file being so marked, and no term being removed from the search on account
of its share.

**21.** The method of claim 1, in which the units reported for each scope are capped at a
fixed number, the report stating how many further units exist and how to see them, the cap
being liftable.

**22.** The method of claim 1, in which a term occurring in a file's path or name but not in
its contents counts toward the file as a unit, with a synthetic detail naming the path in
place of a line, and does not count toward any function or method in the file.

**23.** The method of claim 1, in which a line lying outside every recorded function or method
is attributed to no function, counts toward the file as a unit, and withholds no file under
step (g).

**24.** The method of claim 1, in which each term is also tested against an inferred name of
each function or method in a survivor file, a function whose inferred name matches the term
being credited with the term at its first line, so that a function stripped of its name in
the body of source code is found by the name inferred for it.

**25.** The method of claim 1, further comprising, on request, re-rendering the lines of every
file with inferred names substituted for the names in the body of source code before any
term is tested, the number of lines being preserved so that the recorded start and end lines
still apply, so that a call to a renamed function is found in the caller's body as well.

**26.** The method of claim 1, in which each function, method or file reported is labelled as
source or as pseudo-source, pseudo-source being text derived from a binary file and indexed
in the body of source code as if it were source.

**27.** The method of claim 1, further comprising receiving one or more path fragments to
include and one or more to exclude, a file whose lowercased path contains no included
fragment or contains an excluded fragment being neither tested for any term nor added on
account of a class.

**28.** The method of claim 1, in which the search is also served over a network interface
that returns the matching units of each scope as structured data after the same ordering,
withholding and capping as the printed report, and is also offered as a mode of a graphical
interface that submits the delimited list, the minimum number, a path fragment and a rename
option.

**29.** The method of claim 1, in which the search is also exposed as a tool to a
language-model agent, the tool receiving said minimum number as a percentage of the terms,
rounded up to a count of at least one and defaulting to eighty percent, and returning
function or method units only.

**30.** The method of claim 1, further comprising submitting the highest-ranked units together
with the terms to a language model for an analysis of the units against the terms.

**31.** The method of claim 1, in which the search terms are derived by a language model from a
block of prose, and a derived term occurring in more than a set share of all files is
removed before step (b) by a preliminary scan that determines only the per-term file sets,
the share being lower for a set of terms drawn narrowly from the prose than for a set drawn
broadly.

---

## Citations and provenance

`cm` = `src/commands/multisect.js`, `co` = `src/core/multisect.js`, `csi` =
`src/core/CodeSearchIndex.js`. Each element and dependent is tied to at least one indexed
function, as Andrew's note at the head of the revised file asks, so the set can be used to
test claim-search's retrieval of citations.

| claim | where | provenance |
|---|---|---|
| M1 preamble | Andrew's draft, revised 2026-10-26 | A |
| M1(a) | `cm:53-116` (`parseMultisectTerms`; `i` flag at 87, 98, 104, 110); set semantics `co:271-291` (per-term file sets intersected, no order) | A→C |
| M1(b) | `co:204-253` (Phase 1; path and name 237-246; counts 251-253) | A→C |
| M1(c) | `co:176-180` (gate defaults to every hard term, settable lower), `co:270-291` (survivors) | A→C |
| M1(d) | `co:373-380` (boundaries prebuilt), `csi:4283-4330` (`_getFuncBoundaries`, `_bisectFuncLookup`), `co:430-456` (first line per term and function) | A→C |
| M1(e) | function `co:524-534`; class `co:567-624` (grouping by qualified name 575-583, files 585); file `co:650-659`; the distinct count is `posMatched.size` in each | A→C |
| M1(f) | section order `cm:540` (function), `cm:589` (class), `cm:648` (file), `cm:733` (folder); the same four views `cm:256-394` | A→C |
| M1(g) | `cm:512-531` (file covered by function, class covered by function), `cm:650-657` (file covered by class), `cm:273-311` (views); header comment `co:87` | A→C |
| M2 | `cm:54-59` | A, C |
| M3 | `cm:83-92`; `cm:805-809` | A, C |
| M4 | `cm:93-105` | A, C |
| M5 | `cm:106-111`, `cm:118-120`; no whole-word mode (#138 open) | C |
| M6 | `cm:811`; `co:179-180`; `src/server.js:2347`; `public/app.js:1205`; `src/commands/analyze.js:2809-2816` (`all`) | A, C |
| M7 | `co:255-268` (#307 defect 1); `cm:450-457`; `cm:784-788` | A→C |
| M8 | `cm:152-166` (`computeIdfScores`), `cm:176-191` (`matchIdfScore`), `cm:478-499`, `cm:313-318` | A→C |
| M9 | `co:33-68` (`COMMENT_MATCH_WEIGHT`, `classifyMatchLine`, `weightedTermCount`); `co:441-456` (upgrade); `cm:179-186`; `cm:548-552`, `cm:577` | C |
| M10 | `cm:168-174` (`matchDensityFactor`); `co:588-592` (class total lines); a folder has no line count | C |
| M11 | `cm:62-70`; `co:175-180`; `co:530-534`; `cm:179-186` | A→C |
| M12 | `cm:71-78`; `co:283-289`; `co:626-628`, `co:660-661`, `co:692-694` | A, C |
| M13 | `co:386-399`, `co:494-519`, `co:535-539` | C |
| M14 | `cm:62-70`; `co:538-541`, `co:629-631`, `co:662`, `co:695`; `cm:188-190`; `cm:326-327` | A→C |
| M15 | `co:204-253`, `co:373-380`, `co:293-298` | A, C |
| M16 | `co:316-370` (Phase 1b) | A, C |
| M17 | `cm:521-531`, `cm:650-657`, `cm:592-596`, `cm:660-664`; verbose `cm:433`, `cm:590`, `cm:658` | C |
| M18 | `co:300-314` (every ancestor); `co:683-717`; `cm:713-731`; `cm:744-749`, `cm:768`; `cm:497-499` | A→C |
| M19 | `cm:556-581`; `cm:632`; `cm:702` | A, C |
| M20 | `cm:396-423` (`printSelectivityReport`); contrast `cm:221-254`, which drops and belongs to the claim layer | A, C |
| M21 | `cm:431` (`effectiveMaxResults(args, 10)`), `cm:583-585`; `src/argparse.js:40-61`; `src/server.js:2348` (25) | C |
| M22 | `co:237-246`, `co:418-428` | A→C |
| M23 | `co:438`, `co:506`; `cm:262`, `cm:504-510`, `cm:532` | C |
| M24 | `co:462-483` (#24, Option A) | A, C |
| M25 | `co:184-199` (#25, Option B); `cm:822`, `cm:836-838`; `src/server.js:2350`; `public/app.js:1205` | A, C |
| M26 | `co:27`, `co:551`, `co:667`; `src/binstrings.js:71` (`isPseudoSource`) | A, C |
| M27 | `co:211-216`, `co:229`, `co:358`; `cm:812-815`; `src/argparse.js:515`, `518`, `593` | A, C |
| M28 | `src/server.js:2339-2353` (`/api/multisect`), `src/server.js:4054-4066` (`_runMultisectViews`); `cm:256-394` (`prepareMultisectViews`); `public/app.js:1202-1208` | C |
| M29 | `src/mcp-server.js:132-143` (schema), `src/mcp-server.js:723-735` (handler: ceil, at least one, default 80, function matches only) | C |
| M30 | `src/commands/analyze.js:2779-2820` (`--multisect-analyze`); `public/app.js:1220-1232` | A, C |
| M31 | `src/commands/claim.js:1141-1185` (`_runClaimTier`, 0.5 narrow and 0.7 broad); `cm:221-254` (`filterLowSelectivity`); `co:98-143` (`computeTermFileCounts`) | A→C |

Not claimed, because the code does not do it: widening scope by scope until something is
found (all three earlier hand drafts said this; the units of every scope are built in one
pass, `co:524-717`, and the narrowing is suppression afterward); testing the rarest term
first or stopping early on a miss (Phase 1 tests every term against every file,
`co:229-247`); weighting or dropping matches in test, example or documentation files (no
such flag is read by multisect; `docs/CODEEXAM_SEARCHING.md:52-53` says otherwise and is
wrong); case-sensitive or whole-word matching (#138, open); a match whose terms are
stitched across units of different kinds (#280, open; a match lies within one unit); a
class found as the container of a single line (the container found is always a function;
a class is a grouping of methods); rarity measured beyond the indexed body (Andrew's draft
dependent 3); synonyms, vocabulary bridging, narrow and broad term pairs, and
absent-element reporting (the claim layer; claim 31 is the boundary); any highlighting of
"areas for dispute" (the claim-chart page).

---

## Scores (2026-10-30)

Scored with `node scripts/pseudo-claim-rubric-score.mjs`
`--rubric docs/pseudo-claim-rubrics/multisect.md --run <file>` for each run below: the best run claim per run (MET counted twice, PARTIAL once)
among the claims with an anchor that matches a row's cite. MET is a cite match with half the
row's content words present, PARTIAL a cite match with a quarter or the words without the cite;
the overlap is a keyword proxy printed beside every verdict, and the reading stays the human's.
The runs are files in the project root of this checkout, not in the repository; "none" means no
claim in that run meets or partly meets a row.

| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |
|---|---|---|---|---|---|---|
| CE_pseudo_claim_test_102526_720pm_norank.txt (10/25 7:20pm, Claude, 41 claims) | 39 (multisect (parseMultisectTerms)) | 2 | 18 | 18 | 10 / 2 / 5 | 4 |
| CE_pseudo_claims_vocab_concept_overview_Claude.txt (10/27, Claude, 18 claims) | none | — | — | — | — | 0 |
| CE_pseudo_claims_vocab_concept_overview_ChatGPT.txt (10/27, ChatGPT, 18 claims) | none | — | — | — | — | 0 |
| gemma4_CE_pseudo_claims_102926.txt (10/29, Gemma 4 on the Asus, 41 claims) | 41 (multisect (parseMultisectTerms)) | 3 | 15 | 20 | 18 / 1 / 2 | 5 |
| CE_pseudo_concept_overview_103026.txt (10/30, Claude, 12 claims) | none | — | — | — | — | 0 |
| CE_pseudo_vocab_103026.txt (10/30, Claude, 9 claims) | none | — | — | — | — | 0 |
