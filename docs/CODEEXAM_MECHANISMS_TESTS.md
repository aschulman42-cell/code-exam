# Mechanisms: the tests behind the feature

*This page holds the measurements that stand behind
[`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md), so that page can stay a plain account of
what mechanisms are and how to build them. Each section is one test: when it ran, what
question it answers, what was measured, and how to rerun it. Dates and numbers are as first
recorded; a re-run may differ (mechanisms are the output of deterministic CodeExam code, not
of a language model, but the indexes and the CodeExam code itself may change). A mechanism
here is one entry of the mechanisms index (`mechanisms.json`): a labeled group of functions. Other pages call the same thing a record,
an entry or a group. Seed, floor and cover are defined on
[`CODEEXAM_JARGON.md`](CODEEXAM_JARGON.md).*

## The bottom line, here at the top (2026-11-14)

Mechanisms are soundly based as a way to divide code into pieces small enough to label,
describe and search: every function of four lines or more is in one, and a search by a
claim's words puts the mechanism holding a cited function in the top 25 for 58% of the names
litigants cited. They are not the unit a claim limitation reads on. In the public claim
charts that cite code row by row, a limitation with two or more cited functions almost never
fits in one mechanism: of 22 such rows, one does, and the 119 functions of those rows need
94 mechanisms. Most of that spread is in the charts themselves, whose rows cite functions in
several files (72 files for those 119). So a reader should treat one mechanism as one piece
of what a limitation reads on, not as the whole of it. Where a row cites a single function
(14 rows), the mechanism holding it is the answer at the granularity the chart gives.

Can the *current* implementation be improved? Not simply by tuning it. Its seeds are files, classes,
commands and shared name words, and no such group holds functions from several files that
share no name. Nor are the functions of one limitation joined by calling each other: in no
row do direct calls join them, and 121 functions fall into 95 groups that way. What they
more often share is a caller. Counting a function that calls two of them as a link, the 121
fall into 43 groups. The callers were then read, and they do not carry the weight: about
half are test or benchmark code, the rest are mostly small helpers that happen to call two
library primitives, and a caller together with what it calls would hold no more of a chart
row than today's best mechanism does (42 functions against 41, over 19 rows). So nothing
structural measured here, whether file, class, shared name, direct call or shared caller,
gathers what a litigant cites for one limitation. What a row's functions have in common is
what the limitation says. That points away from a better grouping and toward finding
functions, or small mechanisms, by meaning, and scoring what is found as a set per
limitation. A mechanism built downward from a calling function to what it calls may still
suit application code: over whole filings it beat the best mechanism in 3 of 9, a servlet's
request handler calling 6 of 16 cited functions. The command seed already works that way,
but only for the handlers of command-line options: CodeExam's command catalog also lists GUI actions,
server routes, slash commands and events, and the seed does not read those yet. The wider
form has not yet been built or tested (nor has using other CodeExam catalogs besides the command
catalog, such as referenced-resources or the AI/ML detectors). Two smaller repairs are known and do not
change this picture: functions under four lines are in no mechanism, and command mechanisms
were built from a catalog with wrong joins, since repaired (the catalog sections below).

Finding by meaning has now had a first test with text CodeExam builds from the code itself,
no model: a function's name, its ranked vocabulary, its comments and its surroundings. On
the chart rows such text finds the part of the code a patent is about (two to three times
chance) and does not tell one limitation from another: the cited functions rank as well
under a different limitation of the same chart. Ranking single functions is the weakest
form. On CodeExam's self-test claims the same text works, and after a second model rewords
the claims a mechanism is found within 5 more often through its functions' text than
through its label (95% against 78%, and 85% against 59%, over two runs of 212 claims). So
the text embedded for a mechanism can likely be improved without a model; the link from one
limitation to its code is still not made by any text measured here.

## Do the functions a litigant cites for a claim sit together? (2026-11-14)

**The question.** A mechanism is the unit CodeExam describes, embeds for `--embed-distance`
and drafts a pseudo-claim from. If the code that reads on a patent claim sits in one
mechanism, then finding that mechanism finds the code. If it is spread over many, a search
has to find many, and nothing in the index says which belong together. This test asks which
it is, on claims and code that CodeExam's authors did not choose.

**Real-world test.** Fourteen public infringement claim charts in which a litigant cites
functions of an open-source repository, the set the agreement test already uses
([`claim-chart-agreement.md`](claim-chart-agreement.md)): seventeen filing-and-repository
pairs, sixteen indexes, 276 distinct function names cited. These charts are real in the
sense that parties filed them in litigation, not in the sense that they are correct: a
litigant's chart is advocacy. A match here is agreement with a party about where a claim
reads on the code, not proof that it does.

**The method.** `scripts/mechanism-containment.mjs --filings <work dir>` reads the agreement
test's work directory: each filing's cited names and each repository's index, with the
mechanisms built by `--build-mechanisms` on 2026-11-06. No model runs. For each pair it
reports how many cited names are in the index, how many are in a mechanism, the one
mechanism that holds the most of them, and how many mechanisms it takes to hold them all.

```
node scripts/mechanism-containment.mjs --filings %LOCALAPPDATA%\CodeExam\agreement_work
node scripts/mechanism-containment.mjs --filings <work dir> --only mara-1-11 -v
```

**Matching a name to a function.** The charts give names, not lines. A cited name is cut
down to what follows its last `.` or `::`, and matches every function whose own name ends
the same way. This is the agreement test's rule, and it is loose: the cited `bytes.data`
becomes `data` and matches every function called `data`. So the script narrows where the
chart says more (a class qualifier, or a cited file) and then reports two readings:

- **One function:** only the names left matching exactly one function, or naming a class.
  These are the figures to rely on.
- **Any match:** every name in the index, counted as held by a mechanism that holds any
  function of that name. This flatters the mechanisms and is shown for comparison.

**The check on the script.** Counted by the rule of the 2026-11-06 reach run
([`describe-reach.md`](describe-reach.md), phase 2), the script finds 114 names in a
mechanism, the figure that run reported, and 151 names in the indexes against its 153. The
two-name gap is in one filing (Kodi).

### The result

| filing | repository | cited | in the index | one function | in a mechanism | files | best holds | to hold all |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| databricks-149-2 | apache/spark | 47 | 35 | 21 | 20 | 11 | 3 | 14 |
| veritaseum-1-3 | solana-labs/solana | 25 | 1 | 1 | 1 | 1 | 1 | 1 |
| veritaseum-1-3 | ethereum/consensus-specs | 25 | 2 | 2 | 1 | 1 | 1 | 1 |
| foundry-1-11 | bitcoin-core/secp256k1 | 12 | 11 | 9 | 9 | 6 | 2 | 7 |
| foundry-1-14 | bitcoin-core/secp256k1 | 8 | 8 | 5 | 5 | 3 | 2 | 4 |
| viabtc-1-6 | bitcoin/bitcoin | 14 | 13 | 8 | 7 | 4 | 2 | 6 |
| mara-1-11 | bitcoin/bitcoin | 12 | 12 | 7 | 6 | 4 | 2 | 4 |
| core-scientific-1-8 | bitcoin-core/secp256k1 | 8 | 8 | 5 | 5 | 3 | 2 | 4 |
| core-scientific-1-10 | bitcoin-core/secp256k1 | 7 | 6 | 4 | 4 | 1 | 4 | 1 |
| vm-innovations-1-23 | coinbase/coinbase-sdk-nodejs | 3 | 3 | 2 | 2 | 1 | 2 | 1 |
| vm-innovations-1-23 | circlefin/evm-cctp-contracts | 3 | 0 | 0 | 0 | 0 | none | 0 |
| vm-innovations-1-23 | ethereum/go-ethereum | 3 | 1 | 0 | 0 | 0 | none | 0 |
| friendliai-26-1 | huggingface/text-generation-inference | 3 | 2 | 1 | 0 | 0 | none | 0 |
| securitize-15-9 | securitize-io/dstoken | 3 | 3 | 1 | 0 | 0 | none | 0 |
| true-return-1-6 | makerdao/dss | 13 | 2 | 1 | 1 | 1 | 1 | 1 |
| sookbox-1 | xbmc/xbmc | 7 | 5 | 2 | 2 | 2 | 1 | 2 |
| progme-1-1 | Comcast/cmb | 83 | 32 | 16 | 6 | 4 | 2 | 5 |
| all | 17 pairs | 276 | 144 | 85 | 69 | 42 | 25 | 51 |

The columns from "one function" on are the one-function reading. "In a mechanism" is how
many of those names some mechanism holds; "files" is how many source files they sit in;
"best holds" is how many of them the single best mechanism holds; "to hold all" is how many
mechanisms a greedy cover needs. By the any-match reading the totals are 110 names in a
mechanism, 33 held by the best mechanisms, 80 mechanisms to hold them all.

Each filing's PDF and court docket are linked, and its repository named, in the table under
[Real-world claim charts that cite code][filings] on the claim-charts tests page; the commit
each repository was read at is in the reachability table of
[`claim-chart-agreement.md`](claim-chart-agreement.md). The filing ids here are the
defendant's short name and the document number (`foundry-1-11` is document 1-11 in Malikie
v. Foundry).

[filings]: CODEEXAM_CLAIM_CHARTS_TESTS.md#real-world-claim-charts-that-cite-code-the-recap-search-of-2026-10-20

### What it says

1. **A claim's cited functions do not sit together.** The 69 names that match one function
   and are in a mechanism need 51 mechanisms. On the eight pairs with four or more such
   names, the best mechanism holds 2 to 4 of them, and only one pair (core-scientific-1-10,
   four names in one file) fits in a single mechanism.
2. **Most of the spread is in the claim, not in how the grouper cuts files.** The 69 names
   sit in 42 files. Even if every file were one mechanism, they would need 42. The grouper's
   splitting of large files and classes into pieces accounts for the other 9.
3. **So no file-shaped or class-shaped unit can hold a litigant's claim.** The 51 covering
   mechanisms are 21 file mechanisms, 17 class mechanisms and 13 name-token mechanisms. A
   chart cites functions from several files, the same thing the 2026-11-06 run saw from the
   search side: litigants cite 7 to 14 functions across many entries.
4. **Half of what litigants cite cannot be scored at all.** Of 276 names, 132 are not
   functions in the index (`println`, Solidity names the parser missed, pseudo-code in
   Markdown), and 59 more match several functions with nothing in the chart to choose among
   them. The result above rests on 85 names.
5. **Sixteen of those 85 are in no mechanism.** The builder leaves out functions under four
   lines, and that is the usual reason; the script does not check it name by name. On
   Comcast's cmb it is 10 of 16: the chart cites getters.

### One claim limitation at a time

The table above pools every claim a filing asserts. The link that ultimately matters is from one
claim limitation to the code closest to it, and eleven of the fourteen filings are charts whose
rows give that: a limitation's text and the functions cited for it. The other three (True
Return, Sookbox, PROGME) are not laid out as charts. The script scores each row the way it
scores a filing. With `--calls` it also loads the index and asks whether a row's functions
are joined by calls.

```
node scripts/mechanism-containment.mjs --filings <work dir> --calls
```

Litigants often paste the same citations under several limitations: the 56 rows hold 42
distinct lists of names, and in two filings five rows share two lists. Both counts follow.

| | all rows | distinct lists |
|---|--:|--:|
| chart rows that cite a function | 56 | 42 |
| rows with a one-function name in a mechanism | 36 | 28 |
| rows with exactly one such name | 14 | 12 |
| rows with two or more | 22 | 16 |
| of those, rows one mechanism holds whole | 1 | 1 |
| names in those rows | 119 | 89 |
| files they sit in | 72 | 54 |
| mechanisms to hold them | 94 | 70 |

And by calls, over the rows with two or more functions matched firmly:

| | all rows | distinct lists |
|---|--:|--:|
| rows | 21 | 15 |
| rows joined into one group by direct calls | 0 | 0 |
| adding one function between two of them | 1 | 1 |
| adding a function that calls two of them | 2 | 2 |
| functions in those rows | 121 | 90 |
| groups by direct calls | 95 | 65 |
| groups adding one function between | 93 | 63 |
| groups adding a common caller | 43 | 31 |

What this says:

1. **A limitation's cited functions do not fit one mechanism either.** Narrowing from the
   filing to the row does not change the picture: 22 rows, one fit.
2. **They do not call each other.** A row's functions are mostly siblings, not a chain. In
   the two secp256k1 filings with five functions per row, no function calls another.
3. **They often share a caller.** The nine functions of one Foundry row join into one group
   through functions that call them. Over the whole PROGME filing, which has no rows, the
   sixteen cited getters do the same. The first reading of this was that a chart walks down
   from one function and cites what it calls. Reading the callers (below) does not bear
   that out for chart rows.
4. **A row with one cited function is already answered**: 14 rows, a quarter of the chart
   rows that cite a function.

How far to trust the call figures:

- **The reader sees edges.** Of the 83 firmly matched functions, 57 have a callee read and
  71 a caller. A function with no edge read cannot join anything, so some groups are too
  many; the direct-call result is too lopsided for that to explain it.
- **A common caller is a weak link.** A test, a `main` or a dispatcher calls many unrelated
  things. Which callers joined each row is read in the next part.
- **Callees are CodeExam's own resolution** of a call to one definition; a caller counts
  only when its resolved callees include the cited function. Calls through macros, function
  pointers and interfaces are missed.
- **One limitation can read on code no chart row names.** A row is what the litigant chose
  to cite, not everything the limitation covers.

### Which callers do the joining (2026-11-14)

A joining caller is a function that calls two or more of a row's firmly matched functions.
`--calls` now reports them; `-v` lists them per chart row.

```
node scripts/mechanism-containment.mjs --filings <work dir> --calls -v
```

Over the same 21 rows (15 distinct lists):

| | all rows | distinct lists |
|---|--:|--:|
| joining callers | 259 | 159 |
| of those, in test or benchmark code | 127 | 79 |
| groups by direct calls or a common caller | 45 | 33 |
| the same with test callers left out | 54 | 41 |
| rows joined into one group, test callers left out | 0 | 0 |
| rows with a joining caller outside test code | 19 | 13 |
| functions of those rows the best such caller holds, with what it calls | 42 | 30 |
| functions of those rows today's best mechanism holds | 41 | 29 |
| rows where the caller holds more / the same / fewer | 2 / 16 / 1 | 2 / 10 / 1 |

(The 45 here is direct calls plus a common caller; the 43 above also counts one function
between two of them.)

1. **About half the joining callers are tests or benchmarks.** `run_proper_context_tests`
   and `bench_setup` call many cited functions because they exercise the library, not
   because those functions belong together.
2. **The callers outside test code are small helpers, not orchestrators.** The best one for
   a row has 3 callees at the median and 9 at most, and calls 2 of the row's functions. In
   secp256k1 it is `secp256k1_eckey_pubkey_serialize`, which calls `secp256k1_fe_get_b32`
   and `secp256k1_fe_is_odd`. The litigants cite library primitives, and many functions call
   two primitives.
3. **A caller with what it calls is no better a unit for a chart row** than the best
   mechanism the index already has: 42 against 41.
4. **Whole filings of application code are different.** In Comcast's cmb, `doGet` of
   `AdminServlet` calls 6 of the 16 cited getters, against 2 for the best mechanism; in
   bitcoin, `CKey::MakeNewKey` with its three cited callees holds 4 of 7, against 2. Over
   the 9 filings with a joining caller outside test code, the caller holds more in 3, the
   same in 5, fewer in 1. These pool a filing's claims and are not per limitation.

Limits: 21 rows, 15 distinct, most of them secp256k1 or bitcoin. Test code is told by file
name and path (`tests.c`, `bench_internal.c`, a `test` folder, `FooTest.java`). A caller of
one cited function joins nothing and is not counted.

### What it does not say

- **It is seventeen pairs, and they are not independent.** Six are bitcoin or secp256k1
  filings citing overlapping functions; two of them have the same counts in every column.
- **It says nothing about search.** Whether a claim's words reach these mechanisms is on
  [`describe-reach.md`](describe-reach.md): the mechanism holding a cited function ranked
  within 25 for 58% of 114 names.
- **The cover is greedy**, so "to hold all" can be one more than the least possible.

### What it means for finding code from prose

- **The target for a limitation is usually a set of mechanisms.** A retrieval test on these
  charts should be scored per row, on how many of the row's set the limitation's words
  reach, not on one target. The rows and their functions are in the script's `--json`.
- **No structural link gathers a limitation's functions.** Not a file, a class, a shared
  name, a direct call or a shared caller. A mechanism made of a function and what it calls
  held no more of a chart row than the mechanisms already there; it may still suit
  application code, where one handler calls what a feature needs.
- **Text per function, not per mechanism, was worth testing**, and has been: see
  [the section on text built from the code](#does-text-built-from-the-code-with-no-model-reach-a-claim-limitation-2026-11-14).
  Ranking single functions fails; finding a mechanism or a file through its functions' text
  does better than the label, but no text tells the limitations of one chart apart.
  Semantic search here means
  ranking by embedding distance, `--embed-distance`; the fullest account is
  [section 8 of `CODEEXAM_CLAIM_CHARTS.md`](CODEEXAM_CLAIM_CHARTS.md#8-getting-to-the-goal).

## The same script on CodeExam's own rubric pages (2026-11-14)

**Read this first: the ground truth here is partly circular.** The seven pages under
[`pseudo-claim-rubrics/`](pseudo-claim-rubrics/) each describe one CodeExam feature as a
claim set with a table of the lines each row was written from. Of their 198 rows, 59 carry
a tag from a `--pseudo-claims` draft, and those drafts were written about groups the same
grouper made. Two pages used no draft (multisect, candidates). The seven features were also
picked because pseudo-claim runs existed for them. A row taken from a draft of
`[file] overview.js` cites that file's functions, so the circularity favors the mechanisms.
This is seven features of one codebase and supports no general statement.

**What was run.** The same script without `--filings`, on an index of CodeExam's tracked
source at commit `c9b15fd` (300 files, 438 mechanisms, 2,213 functions). It carries each
cited line from the commit the page was written against to the indexed tree, then maps it
to its function and that function's mechanisms.

```
node scripts/mechanism-containment.mjs --index .CE_111426 --rows "^[A-Z]1[ (]"
```

The first claim of each page, the feature's core:

| page | cites | in no function | functions | best mechanism | holds | to hold all |
|---|--:|--:|--:|---|--:|--:|
| concepts | 14 | 2 | 4 | `[file] vocabulary.js / other` | 2 | 3 |
| multisect | 20 | 1 | 5 | `multisect (parseMultisectTerms)` | 4 | 2 |
| overview-by-ai | 36 | 12 | 33 | `[file] answer-disclosure.js` | 12 | 8 |
| overview | 18 | 1 | 8 | `[file] overview.js` | 6 | 3 |
| pseudo-claims-candidates | 25 | 1 | 20 | `[file] mechanism-grouper.js / other` | 10 | 7 |
| pseudo-claims-drafting | 21 | 4 | 15 | `[file] pseudo-claims.js / other` | 6 | 7 |
| vocabulary | 17 | 1 | 10 | `[file] vocabulary.js / corpus` | 3 | 3 |

**What survives the circularity.** Even with the ground truth tilted toward the mechanisms,
no feature fits in one, and the picture matches the filings: a feature's core takes two to
eight mechanisms. Two things are specific to this run:

- **About one cite in seven is in no function**: 22 of 151 here, 60 of 465 over the whole
  pages. They are prompt text and tables at module scope, route registrations, constants.
  No grouping of functions holds these.
- **The two pages written without drafts do not look different** from the five written with
  them (multisect 4 of 5, candidates 10 of 20). Two pages cannot settle that.

**Line numbers go stale fast.** Of the 56 cites that name a function, the lines as written
land in that function for 31; carried through the diffs from the right commit, for 51. The
right commit is not the last one to touch the page; the script picks, of the page's commits,
the one where the most named cites land by line.

## Does text built from the code, with no model, reach a claim limitation? (2026-11-14)

**The question.** The sections above end by pointing at text per function. A model's
sentence per function is ruled out: too costly on a cloud model, too unreliable on a local
one, and no use unless it works air-gapped. So the text has to be built by CodeExam from the
index alone. Does such text sit near a claim limitation under the local embedding model, and
nearer than a mechanism's label does? Asked per function, per class, per file, and per
mechanism scored by its best member function.

**What was built.** `src/core/function-text.js` makes four texts for a function, each
holding the one before:

1. `name`: the name split to words.
2. `vocab`: plus the body's identifiers split to words, ranked against the whole index the
   way `--vocabulary` ranks terms, top 24.
3. `comments`: plus the comment above the function, comments inside it and words from its
   string literals.
4. `context`: plus its class and file names, the names it calls and the names that call it
   (matched by name, not resolved).

A class or a file gets one text of the same kind over all its functions, in chunks when it
is large, and is scored by its best chunk. `scripts/function-text-reach.mjs` embeds every
text with the local embedder (nomic, the model `--embed-distance` ships with), ranks all
units of an index against each query, and reports where the cited functions land. A unit
above the function (mechanism, class, file) is scored two ways: by its own text, and by the
best score among its member functions.

**Two controls stand beside every figure.** *Other query*: the same answer read under the
next query's text. On a claim chart that is another limitation of the same patent. *Chance*:
as many functions as the answer has, drawn from the index by a fixed seed. The first says
whether a text tells one limitation from another; the second, whether it finds anything.

**Two sets of queries.**

- **Chart rows from the public filings.** Each row's limitation text against the index of
  the repository the chart cites. 12 filings, 39 rows, 139 cited functions. Five filings
  have no row with both limitation text and a cited function the index holds, and are left
  out (the script names them). **These charts are a party's advocacy: a hit is agreement
  with a party, not correctness.**
- **CodeExam's self-test claims** (`--hof`): pseudo-claims a model drafted from a mechanism
  of the index, scored on the functions the draft was anchored to. Two full runs over
  CodeExam's own index (212 claims each, one drafted by Claude, one by ChatGPT) and eight
  earlier runs of four claims on eight indexes. **This set is circular in the mechanism's
  favor**, since each claim was written from one. So each claim was also reworded by the
  other model with `--synonymize`, which sees the claim only and writes it away from the
  code's words.

```
node scripts/function-text-reach.mjs --filings <work folder>
node scripts/function-text-reach.mjs --hof <index>/hof/<run> --k 1,5,25
node scripts/function-text-reach.mjs --hof <index>/hof/<run> --claims-file <reworded claims>
```

### Chart rows: the texts find the patent's part of the code, not the limitation's

Share of the 139 cited functions ranked within 25, pooled over the 12 indexes:

| unit and text | units | right limitation | other limitation | chance |
|---|--:|--:|--:|--:|
| function: `name` | 22,577 | 13% | 14% | 1% |
| function: `vocab` | 22,577 | 6% | 8% | 1% |
| function: `context` | 22,577 | 3% | 6% | 1% |
| mechanism: label and members (what `--embed-distance` uses) | 8,148 | 46% | 42% | 19% |
| mechanism: its `purpose` line | 8,148 | 23% | 22% | 14% |
| mechanism: best function, `vocab` | 8,148 | 50% | 45% | 16% |
| file: its own vocabulary | 5,394 | 59% | 50% | 23% |
| file: best function, `vocab` | 5,394 | 77% | 69% | 29% |
| class: its own vocabulary (9 rows, 26 functions) | 4,890 | 65% | 36% | 0% |

- **Every text beats chance and almost none beats another limitation of the same chart.**
  The texts say which part of a codebase a patent is about. They do not say which code goes
  with which limitation, and that is the link an examiner needs.
- **Per function is the weakest unit, and more text made it worse.** No arm puts a cited
  function in the top 5 for more than 6 of the 39 rows. This is the outcome predicted before
  the run, only worse: the prediction was that the function carrying a limitation's idea
  would be found and the primitives it leans on would not. Neither was.
- **A file's vocabulary string is ahead of a mechanism's label** (59% against 46%), and a
  file scored by its best function is ahead of both (77%). Files are coarser and chance
  rises with them, so the gain is smaller than it looks: about 2.5 times chance in each
  case.
- **Class vocabulary is the one text that separates limitations** (65% against 36%), on 9
  rows; 112 of the 139 cited functions are in no class. A larger sample is needed before
  this is a finding.
- **All of a row within 25**, of 21 rows citing two or more: 1 by mechanism label, 12 by
  file scored on best function with `vocab`.

Limits: 39 rows, most from secp256k1 and bitcoin filings that cite overlapping functions;
four indexes (Spark, Solana, two of bitcoin) were sampled to 3,500 functions, keeping every
cited function and every function of the files that hold one; one embedder.

### Self-test claims: the texts work, and rewording hurts the label more than the code's own words

CodeExam's own index, 3,325 functions, 426 mechanisms, 239 files. Share of anchored
functions ranked first / within 5, in percent. At rank one both controls are 0% to 1% for
functions and 1% to 10% for mechanisms throughout.

| unit and text | Claude draft | reworded by ChatGPT | ChatGPT draft | reworded by Claude |
|---|--:|--:|--:|--:|
| function: `name` | 22 / 42 | 12 / 28 | 28 / 52 | 9 / 21 |
| function: `vocab` | 36 / 60 | 21 / 41 | 48 / 71 | 15 / 31 |
| function: `comments` | 46 / 67 | 28 / 51 | 54 / 76 | 17 / 37 |
| function: `context` | 45 / 71 | 29 / 52 | 56 / 80 | 17 / 38 |
| mechanism: label and members | 73 / 90 | 52 / 78 | 81 / 92 | 41 / 59 |
| mechanism: its `purpose` line | 70 / 85 | 55 / 75 | 77 / 88 | 36 / 62 |
| mechanism: best function, `comments` | 65 / 99 | 56 / 95 | 70 / 99 | 46 / 85 |
| file: its own vocabulary | 87 / 97 | 74 / 92 | 91 / 99 | 62 / 87 |
| file: best function, `comments` | 95 / 99 | 88 / 97 | 98 / 99 | 72 / 94 |

1,202 anchored functions for the Claude draft and 1,143 for the ChatGPT draft (35 and 32
anchors name a function the index does not hold). ChatGPT's rewording kept 30% of content
words on average; Claude's kept 10% and left 244 of 2,536 elements as they were.

- **Here the texts do tell one claim from another**, unlike the chart rows. Each added layer
  of text helps a function: 42% within 5 on the name alone, 71% with all four, among 3,325.
- **The self-test was a gimme and still is not high once reworded.** The mechanism's own
  label puts the right mechanism first for 73% and 81% of anchors on the drafts, 52% and 41%
  after rewording.
- **Reworded, a mechanism is found better through its functions' mechanical text than
  through its label**: within 5, 95% against 78%, and 85% against 59%. At rank one the two
  are close (56 against 52, 46 against 41). On the unreworded drafts the label wins at rank
  one and loses within 5.
- **The `purpose` line, left on the not-run list of
  [`describe-reach.md`](describe-reach.md), is about level with the label** here and well
  behind it on the chart rows (23% against 46% within 25).
- **The eight small runs** (32 claims, 341 anchors, three indexes sampled) agree within 5
  (reworded: 94% by best function with `context`, 83% by label) and disagree at rank one
  (33% against 57%).
- Classes are unreadable on this index: 11 classes, and the controls reach 50% to 100%.
- Spinellis, the ninth self-test index, was left out to spare memory on the test machine.

Rewording cost $7.11 in all (ChatGPT $1.81 for 1,994 calls, Claude $4.98 for 2,536, the
small runs $0.32), against a projection of $27.48 plus the small runs: the gate assumes
every call fills its output allowance.

### What it means

- **Distance is not the whole problem; register is.** The same texts, embedder and scoring
  separate one claim from another when the claim was written by a model that read the code,
  even after a second model rewrote it, and fail to separate limitations a patent attorney
  wrote about code the patent never saw. A reworded pseudo-claim is still a description of
  this code. Synthetic claims are useful for comparing texts with each other; they are not a
  stand-in for the litigants' rows.
- **For `--embed-distance`, the candidate change is the text embedded for a mechanism**: the
  mechanical text of its member functions, scored by the best one, in place of or beside the
  label and member names. It held up better under rewording in every run. It is not adopted
  here; it wants the fused form tried (label and function text together) and the no-match
  calibration redone.
- **Per-function ranking is not the way to a limitation's code.** A mechanism or a file
  found through its functions is.
- **Nothing here links a limitation to its code among the limitations of one claim.** That
  remains the open problem, and it is the one that matters for a chart.

## The label and the function text as one score (2026-11-15)

The section above scored a mechanism two ways, by its label and by the text of its best
function, and found each ahead on a different measure: the label at rank 1 on original
wording, the function text within 5. This scores the two together, on the vectors already
computed (nomic, the same queries, the same two controls). Three ways of combining, all
fixed before any run and all reported: reciprocal-rank fusion (k = 60, as
[`describe-reach.md`](describe-reach.md) uses), the higher of the two cosines, and a
weighted sum at three weights. The function text is the `comments` form throughout.

**The self-test claims** (212 per run, CodeExam's own index; share of a claim's functions
at rank 1, and within 5):

| mechanism scored by | Claude draft | reworded | ChatGPT draft | reworded |
|---|--:|--:|--:|--:|
| label alone | 73 / 90 | 52 / 78 | 81 / 92 | 41 / 59 |
| best function alone | 65 / 99 | 56 / 95 | 70 / 99 | 46 / 85 |
| fused: reciprocal rank | 90 / 97 | 69 / 88 | 89 / 98 | 53 / 78 |
| fused: higher cosine | 66 / 99 | 58 / 95 | 75 / 99 | 47 / 85 |
| fused: sum, 0.3 on the label | **93** / 98 | **78** / 93 | **95** / 99 | **61** / 84 |
| fused: sum, 0.5 | 89 / 97 | 72 / 90 | 94 / 99 | 55 / 78 |
| fused: sum, 0.7 | 83 / 96 | 65 / 87 | 91 / 97 | 49 / 73 |

- **At rank 1 the weighted sum is far ahead of either text alone** on all four runs: 78%
  and 61% on the reworded claims, where the better single text gives 56% and 46%. The
  other-query control stays where the label's was (8% and 8% at rank 1).
- **Within 5 it does not beat the function text**: 93 against 95, 84 against 85. The
  function text alone was already near its ceiling there.
- **The weight matters and in one direction**: more weight on the function text is better
  at every measure, 0.3 ahead of 0.5 ahead of 0.7. The higher cosine is no better than the
  function text alone, because the function's cosine is nearly always the higher.
- **For a file, fusion adds nothing**: the file's best function already gives 88% and 72%
  at rank 1 reworded, and every fused form is level or a point below.

**The litigant rows** (12 filings, 39 chart rows; share within 5 and within 25, with
another limitation of the same chart in parentheses):

| mechanism scored by | within 5 | within 25 |
|---|--:|--:|
| label alone | 13 (16) | 46 (42) |
| best function, comments | 4 (7) | 40 (36) |
| best function, context | 5 (7) | 51 (49) |
| fused: reciprocal rank | 9 (9) | 51 (48) |
| fused: higher cosine | 4 (7) | 38 (36) |
| fused: sum, 0.3 on the label | 9 (12) | 48 (46) |
| fused: sum, 0.5 | 6 (9) | 49 (47) |
| fused: sum, 0.7 | 6 (9) | 48 (46) |

**On what parties cited, fusion gains nothing.** No fused form is ahead of the label within
5, the best is 5 points ahead within 25 with the other-limitation control 6 points up
beside it, and rank 1 is 2% or less for all. For files the same: file vocabulary 59 (50)
and the best function's vocabulary 77 (69) within 25; the fused forms 73 to 75 (62 to 66).

**The rule set before the run** was that a fused form would be proposed for
`--embed-distance` if it beat both single texts at rank 1 **and** within 5 on both
reworded runs and was no worse on the chart rows. It beats both at rank 1 by 15 to 22
points, falls 1 to 2 points short of the function text within 5, and is no better on the
chart rows. The rule is not met as written; `--embed-distance` is unchanged. What the
self-test shows is real and narrow: when a claim is about one mechanism and worded away
from it, reading the label together with the function text finds that mechanism first far
more often. The self-test is circular in that direction, and the chart rows, which are
not, show no such gain.

**The catalog's labels as text.** A CLI option's flags and help line, or a GUI control's
label, credited to the function its handler resolves to. Stated before the run: this can
only be scored where an index has catalog rows with resolved handlers. **None of the
twelve filing indexes has one**, so the litigant rows could not test it. On CodeExam's own
index 114 CLI options have one (the index holds no HTML, so no GUI label), and 36 of the
212 claims have an answer among their handlers (51 functions). Scored alone on those: at
rank 1, 61% and 67% on the original wording, 41% and 27% reworded, against 2% to 10% for
the controls; that is below the label on the same runs. As a third text for the mechanism
holding the handler it changed no figure. A small set, one codebase, one model.

```
node scripts/function-text-reach.mjs --hof <index>/hof/<run> --claims-file <reworded claims> --k 1,5,25
node scripts/function-text-reach.mjs --filings <work folder> --k 1,5,25,100
```

## Found on the way: command mechanisms depend on file order (2026-11-14)

Building CodeExam's own index three times from the same source gave three sets of command
mechanisms, because the command catalog takes the first line anywhere in the index that
tests an option's name:

| files indexed in this order | `--overview` resolves to | `[cmd]` mechanisms |
|---|---|--:|
| directory walk, a folder's files before its subfolders | `doStats` | 76 |
| `git ls-files` order, `src` first | `chatSessionOptions` | 70 |
| `git ls-files` order, `public` first | `loadOverviewInto` | 61 |

All three are wrong for `--overview`, and eighteen command mechanisms of the first build
(`--search`, `--callers`, `--extract` among them) are absent from the third. The rubric
figures above use the first order. The repair is the next section.

## The command catalog's joins repaired: before and after (2026-11-15)

**What was wrong.** A command mechanism is seeded from the command catalog: each CLI option
with a resolved handler becomes `[cmd] <flag>`, the handler and what it calls. So every
catalog error is a missing or mislabeled mechanism. Four kinds of error were found by reading
the catalog of CodeExam's own index against `src/index.js`:

1. **Rows dropped.** An option row with a fourth element (deprecated spellings) was not
   read at all: `--vocabulary`, `--files`, `--functions`, `--models` and 26 more.
2. **The handler taken from the next option's dispatch.** The resolver read 20 lines on
   from the test of an option and took the first `do…(` call, even past the end of that
   option's own line or block: `--overview` got `doStats`.
3. **Non-handlers taken.** With no `do…(` call, the first awaited call won: five options
   got `import`, from `await import(`.
4. **The join changed with file order**, the table above.

**What changed** (`src/core/breadcrumbs-commands.js`). All lines that test an option are
gathered first and one is chosen: a line whose condition opens with the option over one
that mentions it; the file that opens the most conditions that way, the program's dispatch
file, over any other; the option tested alone over the option tested with another. The
handler is the call on that line, or a call in the block under it and no further. A
dispatch table row (`['list_models', 'models', doListModels]`) is read. An option that is
only negated, or tested behind another condition, gets no handler: it is a modifier.

**Measured** on the same tree before and after (`.CE_111426`, CodeExam's tracked source at
`c9b15fd`, 2,213 functions), and on the two other file orders of that tree:

| | before | after |
|---|--:|--:|
| CLI option rows | 281 | 311 |
| rows with a handler | 97 (86 and 87 on the other two orders) | 114 on all three |
| joins that differ between the three orders | 32 options | 0 |
| handlers wrong by a hand read | 17 | 0 found; 3 arguable, below |
| `[cmd]` mechanisms | 76 | 109 |
| all mechanisms | 438 | 471 |
| functions in some mechanism | 2,157 | 2,157 |

- **The 17 wrong joins before**: `--overview` (`doStats`), `--air-gapped`
  (`doScanExtensions`), `--clean-zip-cache` (`doSynonymize`), `--add-extensions`
  (`doTriage`), `--no-rename` (`doBuildFpRenames`), `--mermaid` (`doCallTree`),
  `--claims-loop` and `--hof` (`doPseudoClaims`), `--emit-catalog` and `--exports`
  (`doEmitCatalogMulti`), five options to `import`, two to `draft` (a closure that calls
  the model). After: six of them have the right handler or a defensible one, eleven have
  none, which is right for a modifier or for an option whose dispatch is a few inline lines.
- **Arguable after**: `--overview` joins `formatOverview`, the first call on its line,
  when `buildOverview` on the same line does the work; `--air-gapped` joins the startup
  check its block awaits; `--doc-anchors`, a modifier, joins the one function it switches
  on.
- **Still missed**: `--overview-by-ai`, whose call sits 62 lines into its block (the window
  is 20); `--rebuild-functions`, whose block calls a method that is neither `do`-named
  nor awaited.
- **Mechanisms gained, 34**: `--vocabulary` (13 functions), `--hof` and `--claims-loop`
  (40 each, both formerly folded into `--pseudo-claims`), `--build-index` (33),
  `--exports` (19), `--client-server` (15), the 23 listing commands, `--overview` (2).
  One lost: `--rebuild-functions`.

**The rubric rows, rerun.** Same command as the rubric section above, after rebuilding the
index's mechanisms:

| page | best mechanism before | holds | best mechanism after | holds |
|---|---|--:|---|--:|
| concepts | `[file] vocabulary.js / other` | 2 of 4 | `[cmd] --vocabulary` | 4 of 4 |
| vocabulary | `[file] vocabulary.js / corpus` | 3 of 10 | `[cmd] --vocabulary` | 4 of 10 |
| overview | `[file] overview.js` | 6 of 8 | `[file] overview.js` | 6 of 8 |
| the other four | unchanged | | | |

The expected `[cmd] --vocabulary` appeared and is the one page of seven where a single
mechanism now holds a feature's core. The expected gain for the overview did not: its
command mechanism holds two functions, because the catalog names one handler and the work
is in the function passed to it.

**On other codebases.** Indexes with no option dispatch are unchanged: `.dspy` and
`.x264` have no CLI rows before or after, `.AI_Manning_recent` 96 rows and no handler
both times, `.Bram_103126` 41 and none. `.sr_gh` (217 rows) had three handlers, all
modifiers of one script joined to `warmup_models`; it now has none. So the change is shown
on CodeExam and shown harmless elsewhere; it is not shown to *help* on a third-party CLI,
since no index at hand has one whose options resolved before.

**Beyond mechanisms.** The same catalog feeds `--command-catalog`, the command section of
`--digest`, the GUI's Commands list, the `command_catalog` MCP tool and the `_CMD_`
renames: 30 more option rows appear on each, deprecated spellings are listed beside the
current flag, and the handler shown changes for the options above. The digest and rename
output were not read after the change.

**The catalog's GUI Actions** were not touched by this change, which is to CLI options
only. They are the next section.

```
node --test test/test_command_catalog.js
node src/index.js --index-path <index> --command-catalog --all-results
node src/index.js --index-path <index> --build-mechanisms
```

## The catalog's GUI actions: before and after (2026-11-15)

**What was wrong.** Andrew ran `--command-catalog` on CodeExam's own index and found the
GUI Actions section "a small random-looking selection of features available from GUI". It
listed 13 rows. Three causes:

1. **The page's HTML is not in the index.** GUI actions are read from two attributes,
   `data-action` and `data-section`. `public/index.html` holds 52 of the GUI's 58
   `data-section` attributes, and `.html` is not a default extension. What was listed was
   whichever name also sits in a JavaScript string (a tour step, a selector). Nothing said
   the HTML had been left out.
2. **Rows that are not actions**, 5 of the 13: the catalog's own regex source (`([^`), a
   template placeholder (`${sectionId}`), and `name`, from a comment giving the attribute
   as an example.
3. **Wrong handlers.** The handler was the first line anywhere holding the name in quotes:
   `overview (section)` joined `src/argparse.js:520`, the row that declares the
   `--overview` option.

**What changed** (`src/core/breadcrumbs-commands.js`).

- A value that is not a plain attribute value is not a name, and a comment line defines
  nothing. Every occurrence on a line is read, where one per line was.
- One row per name, the same whatever the file order: the markup that defines the control
  over a script that mentions it.
- A handler is a script line that dispatches on the name (`case 'x':`, `=== 'x'`, a quoted
  map key) or, failing that, one that selects the control (`[data-action="x"]`, printed as
  "used at"). The file must read the attribute (`dataset.action`) or sit beside the
  defining file; server-side code that compares against the same word is not a candidate.
  The row names the first call made at statement level in that `case`.
- When no HTML is in the index and its scripts drive a page, or an archive build recorded
  HTML as skipped, the section ends with a note saying so and giving the whole rebuild
  command. The CLI, the `command_catalog` MCP tool and the GUI's Commands list print it.
- The section says what it reads.

**Measured** on `.CE` (CodeExam's source, 265 files, no HTML), as built and with
`public/index.html` added to the loaded index in memory. A real rebuild with
`--add-extensions .html` was not run.

| | before | after |
|---|--:|--:|
| rows, index as built | 13 | 7, and the note |
| of them not actions | 5 | 0 |
| rows, `index.html` added | 68 | 63 |
| of them not actions | 5 | 0 |
| handlers in a file outside `public/` | 41 | 0 |
| rows with a handler | 67 | 63 |
| handlers that name a function | 0 (file and line only) | 60 |

- **The 63 rows** are the 52 accordion sections and 11 menu actions of the page. All 52
  sections join their `case` in `loadSectionData` (`public/app.js`), and
  the 10 dispatched menu actions their `case` in `handleMenuAction`
  (`public/menu-bar.js`); `reset-layout` is "used at" `public/layout.js:254`, which
  wires its click.
- **No function named, 3**: `load-index` and `build-index`, whose `case` opens a dialog
  inline, and `reset-layout`.
- **The function named is the first statement-level call, not always the best one.** 18
  sections name `renderDrilldownList`, a shared renderer; the call that fetches the data is
  a method (`api.listArtifacts`) and is not named. `stats` names `showMiddleTopLoading`,
  the line before `renderStats`. Eight rows were read against the source by hand, not all 63.

**Second pass, the same day: controls beyond the two attributes.** Andrew rebuilt an index
with `index.html`, read the list in the GUI, and found it still missing the Analysis,
Console and Chat tabs, the Claim / Multisect Workspace and its options (Browse GGUFs,
Vocab-Tight), and menu items under the names he knows (Regex Search was listed, as
`search-regex`). The catalog was extended by the conventions of HTML, not by CodeExam's
attribute names:

- **A label.** Every control carries the text a user sees: its visible text, else
  `aria-label`, `title`, `placeholder`, or a `<label for>`. The row prints the label, then
  the code name.
- **Any `data-*` name** on a button, input, select, textarea, link or summary is a control
  of that kind (`data-tab="chat"` is `chat (tab)`), joined as the two attributes were.
  When the value is the id of another element (`data-copy="left-body"`), it names what the
  control acts on, not a command: it is joined to the script line that reads the attribute
  (`closest('[data-copy]')`), "used at".
- **A control with an id** is listed by its kind (button, checkbox, input, select) and
  joined to the script line that fetches it by that id (`'#id'`, `getElementById`): a
  listener attached there, directly or to the variable it is assigned to, handles it and
  the function passed is named; any other mention is "used at", which is what a checkbox a
  script only reads gets.
- **Any other element with an id** is listed only if a script attaches a listener to it.

| with `index.html` added | two attributes | all controls |
|---|--:|--:|
| rows | 63 | 198 |
| with a handler line | 63 | 193 |
| of them a dispatch or a listener | 62 | 136 |
| of them "used at" | 1 | 57 |
| that name a function | 60 | 116 |
| with no label | 63 (labels were not read) | 19 |
| handler outside `public/` | 0 | 0 |

By kind: 52 sections, 48 buttons, 22 checkboxes, 16 inputs, 11 menu actions, 9
context-menu entries, 7 elements with a listener, 5 selects, 5 menus, 3 tabs, and 16
pane buttons (save, find, copy, close, pop out). Everything Andrew named is in the list.
Read by hand: the rows he named and about twenty others, not all 198.

What is wrong or thin in it:

- **Labels are sometimes not what a user would call the control.** An input with only a
  placeholder is labeled by it (`.index_of_mycode`), a long tooltip is cut at 70
  characters, and a container with a listener takes the first text under it
  (`context-menu` is labeled "Find Uses", its first entry). 19 controls have no label:
  icon-only buttons with no title, and selects.
- **57 rows are "used at", not handled**: checkboxes and inputs a script reads when
  something else runs, and controls wired in a loop over a class of elements, which no
  rule here follows. 5 rows have no line at all (the Window menu's checkboxes among them).
- **The list is long and flat**: dialog Cancel and Close buttons sit beside commands. No
  grouping by dialog or pane is attempted.
- **Not read**: an opening tag that spans lines, a control a script creates
  (`createElement`, an HTML string in JavaScript), and frameworks' own event syntax
  (`onClick={…}`, `@click`, `(click)`). CodeExam's page has none of the first; the
  second and third are untested.
- **Measured on one page, CodeExam's own.** The rules are general HTML conventions, but no
  other index at hand holds a web page, so nothing shows how the list reads on another
  GUI. The figures are from `index.html` added to the loaded index in memory.

**On other codebases.** No index at hand holds HTML, so the rules are shown on CodeExam's
GUI alone. What the other indexes show is the
note: `.AI_Manning_recent` "1 HTML file(s) were not indexed at build", `.Bram_103126`,
`.sr_gh` and `.dspy` the conditional form, `.x264` (C, no scripts) nothing. For `.dspy`,
a Python library, the note is triggered by a script in its docs and is of little use.

**A build-only option given without a build.** Following the old wording of such notes,
Andrew ran `--index-path .CE --add-extensions ".htm,.html,.css"` and got "No command
given": the option acts only during `--build-index` and was ignored without a word. Now
`--extensions`, `--add-extensions`, `--exclude-extensions` and `--regex-parser` given
without `--build-index` print that they have no effect on the run, and the build command.
Six older notes elsewhere (`--imports`, `--browse`, the census, two in the GUI) still say
"rebuild with --add-extensions …" without the build command; they were left as they are.

```
node --test test/test_command_catalog.js
node src/index.js --index-path <index> --command-catalog
```

## Would GUI actions, or routes, seed better mechanisms? (2026-11-15)

Tried and not adopted. A command mechanism is seeded from a CLI option; the catalog's GUI
actions and routes seed nothing. On the index of CodeExam's source that includes
`public/index.html` (`.CE_111426`, 471 mechanisms), four kinds of record were built outside
the grouper, laid beside the existing ones and scored on the seven rubric pages (first
claim and whole page, fourteen rows): a GUI row's handler and its callees (63 records),
the functions called in the row's own `case` body (95), the same extended through the API
route that body calls into the route's body (100), and a route's body with no GUI row
(79). No GUI variant produced the best holder of any row. The route variant did on three:
two ties with `[cmd] --vocabulary`, and one gain, `[route] /api/overview-deep` holding 21 of
55 cited functions on the overview-by-ai page against 12. The grouper is unchanged. The
result is weaker than it reads: the rubric pages describe features from the command line
and the server (12 of their file references are under `public/`, 82 under `src/`), so they
cannot reward a record of client code, whose possible value, the control's label as a name
for that code, was not measured; the records sat beside the existing ones, so their sizes
are upper bounds; and it is one codebase, with route bodies read by a rule that fits this
codebase's own route table. Routes are the lead, on one row.

## A second embedding model: EmbeddingGemma beside nomic (2026-11-15)

Every figure above this section was computed under one embedding model, nomic. Andrew asked
for Google's EmbeddingGemma to be tried. The first version (308M parameters) loads under the
runtime CodeExam ships with and is in the registry as `gemma`; the second, which Google says
is better on code, does not load under that runtime ("unknown model architecture:
'gemma-embedding2'"); it was then run under a newer runtime kept outside the repository, on
the self-test claims and seven of the twelve filings (the last part of this section). Prompts, files and the load results are in
[`model-support.md`](model-support.md#embedding-models---embed-distance).

EmbeddingGemma's card gives two query prompts that could fit: `task: code retrieval`, which
it names for code search, and `task: search result`, the general one. Both were run, as
`gemma` and `gemma-search`; documents take the same prompt either way. The runs repeat the
"text built from the code" section above exactly: same script, same options, same queries,
same two controls, on the same indexes.

**The self-test claims, reworded** (212 claims drafted from mechanisms of CodeExam's own
index, reworded by the other model; share of a claim's functions at rank 1 and within 5):

| text scored | run | nomic @1 / @5 | gemma @1 / @5 | gemma-search @1 / @5 |
|---|---|--:|--:|--:|
| mechanism label | Claude draft, reworded | 52 / 78 | 60 / 84 | 73 / 91 |
| mechanism label | ChatGPT draft, reworded | 41 / 59 | 47 / 79 | 59 / 86 |
| mechanism, best function's comments | Claude draft, reworded | 56 / 95 | 66 / 96 | 66 / 98 |
| mechanism, best function's comments | ChatGPT draft, reworded | 46 / 85 | 56 / 94 | 61 / 96 |
| function comments | Claude draft, reworded | 28 / 51 | 27 / 52 | 36 / 64 |
| function comments | ChatGPT draft, reworded | 17 / 37 | 18 / 37 | 29 / 53 |
| file vocabulary | Claude draft, reworded | 74 / 92 | 65 / 87 | 73 / 93 |
| file vocabulary | ChatGPT draft, reworded | 62 / 87 | 49 / 84 | 67 / 91 |

On these, EmbeddingGemma is ahead of nomic and its general prompt is ahead of its code
prompt, most on the reworded claims and at rank 1; the other-query control did not rise
with it (mechanism label at rank 1, Claude draft reworded: 9%, 5%, 4%). On the original
wording the order is the same and the gaps smaller (mechanism label at rank 1: 73, 76, 84
and 81, 81, 89). The one loss is file vocabulary under the code prompt.

**The litigant rows** (12 filings, 39 chart rows, 139 cited functions; share within 25, with
the query of another limitation of the same chart and the chance draw in parentheses):

| text scored | nomic | gemma | gemma-search |
|---|--:|--:|--:|
| function name | 13 (14 / 1) | 9 (10 / 0) | 12 (12 / 1) |
| function comments | 6 (7 / 1) | 4 (6 / 3) | 11 (11 / 1) |
| mechanism label | 46 (42 / 19) | 54 (50 / 17) | 58 (53 / 17) |
| mechanism, best function's vocabulary | 50 (45 / 16) | 43 (40 / 16) | 47 (43 / 15) |
| mechanism, best function's context | 51 (49 / 16) | 52 (48 / 16) | 56 (50 / 16) |
| file vocabulary | 59 (50 / 23) | 63 (58 / 27) | 74 (63 / 29) |
| file, best function's vocabulary | 77 (69 / 29) | 59 (58 / 39) | 69 (61 / 35) |
| file, best function's context | 71 (65 / 31) | 73 (66 / 37) | 79 (72 / 32) |
| class vocabulary (9 rows, 26 functions) | 65 (36 / 0) | 15 (8 / 4) | 42 (8 / 0) |

**What the litigant rows say, and it is not what the self-test says.**

- **More of a chart's functions are reached, and so are more of the wrong limitation's.**
  The mechanism label goes from 46% to 58% within 25, and the other-limitation control
  from 42% to 53%: the gap between the right limitation and another one of the same chart
  is 4 points under nomic, 4 under `gemma`, 5 under `gemma-search`. Within 5 it is
  13 (16), 18 (21), 26 (25): no gap under any. File vocabulary is the same shape: 59 (50),
  63 (58), 74 (63).
- **Against chance the margin does widen**: mechanism label 46 against 19, then 58 against
  17. EmbeddingGemma is better at landing a limitation in the part of the codebase its
  patent is about. It is no better at telling that limitation from its neighbours.
- **Nomic is ahead on two rows**: the file scored by its best function's vocabulary
  (77 against 59 and 69), and the class rows, which are 9 chart rows and too few to weigh.
- **Rank 1 stays near empty under every model**: the mechanism label puts a cited function
  first on 6, 1 and 6 of 35 chart rows (5%, 1%, 5% of the functions), and the other
  limitation's query scores the same.

So the finding of the section above stands under a second model: on what parties cited,
text built from the code beats chance and does not beat another limitation. The self-test's
large gain is a gain at matching a claim to the mechanism it was written from, reworded;
that is the circular direction, and the litigant rows do not confirm it as a gain in
telling limitations apart.

**The two prompts.** The general prompt scored higher than the code prompt on both sets,
on nearly every row. The texts searched here are labels and word lists built from code,
not code, and the queries are claim language; that is a reason it could, and it was not
tested. The registry's `gemma` keeps the prompt the card names for code, and
`gemma-search` is there to be chosen.

**The second version, under a newer runtime: the self-test, and seven of twelve filings.** Andrew asked for a runtime
upgrade to be tried. node-llama-cpp 3.22.3 (llama.cpp release 0.9.0, against 0.5.0 in the
shipped 3.22.1) loads EmbeddingGemma 2. It was installed in a scratch folder and the same
script pointed at it for these runs; `package.json` and the repository's runtime are
unchanged, and `gemma2` / `gemma2-search` remain marked as not loading under what CodeExam
ships. About 16 short texts a second, against 25 for the first version and 29 for nomic.

Mechanism label, share of a claim's functions at rank 1 (within 5):

| run | nomic | gemma | gemma-search | gemma2 | gemma2-search |
|---|--:|--:|--:|--:|--:|
| Claude draft | 73 (90) | 76 (92) | 84 (94) | 84 (95) | 86 (95) |
| Claude draft, reworded | 52 (78) | 60 (84) | 73 (91) | 64 (91) | 70 (91) |
| ChatGPT draft | 81 (92) | 81 (95) | 89 (98) | 90 (97) | 91 (97) |
| ChatGPT draft, reworded | 41 (59) | 47 (79) | 59 (86) | 58 (83) | 65 (86) |

Function comments, reworded, rank 1: Claude draft 28, 27, 36, 30, 34; ChatGPT draft 17, 18,
29, 18, 22. File scored by its best function's comments, ChatGPT draft reworded, rank 1:
72, 80, 90, 78, 81.

- **The second version is ahead of the first under the same prompt**, clearly so under the
  code prompt (reworded mechanism label 60 to 64 and 47 to 58), and it repairs the first
  version's loss on file vocabulary (65 and 49 back to 74 and 62, nomic's figures).
- **It is not ahead of the first version with the general prompt.** On the mechanism label
  it is 2 to 6 points up on three runs and 3 down on one; on function comments and on the
  file's best function, reworded, the first version with the general prompt is higher.
- **It depends much less on which prompt is used**: its two prompts differ by 1 to 7 points
  where the first version's differ by 8 to 13.
- **Not measured for it**: its 8,192-token context, since every text here is cut at
  1,500 characters and the context opened at 2,048 tokens. No vector was compared with
  Google's own implementation of the model: its scores for unrelated text are high (a
  sorting query scored 0.79 against a sorting function and 0.55 against a sentence about
  the weather, where the first version gave 0.50 and 0.07); the retrieval figures above are
  far from chance, which is the evidence that the runtime computes it soundly, and it is
  indirect.

**The litigant rows, seven filings of twelve.** The four secp256k1 filings and three
one- or two-row filings (text-generation-inference, dstoken, the coinbase SDK): 19 of the
39 chart rows and about half of the cited functions. Counts of cited functions within 25,
the right limitation and, after the slash, another limitation of the same chart:

| text scored | nomic | gemma | gemma-search | gemma2 | gemma2-search (five filings) |
|---|--:|--:|--:|--:|--:|
| mechanism label, of 68 | 42 / 39 | 48 / 44 | 51 / 48 | 38 / 38 | 42 / 42 of 67 |
| mechanism, best function's context, of 68 | 47 / 45 | 45 / 45 | 46 / 45 | 37 / 36 | 36 / 32 of 67 |
| file vocabulary, of 72 | 41 / 38 | 60 / 54 | 65 / 58 | 52 / 49 | 50 / 49 of 69 |
| file, best function's vocabulary, of 72 | 65 / 62 | 49 / 51 | 57 / 56 | 44 / 46 | 54 / 52 of 69 |
| file, best function's context, of 72 | 58 / 57 | 62 / 56 | 65 / 60 | 61 / 54 | 61 / 58 of 69 |

On these seven the second version is **behind the first** on the mechanism label and on
file vocabulary under either prompt, and level with nomic on the label; and, as for every
model, the other limitation of the same chart scores almost the same as the right one.
The other five filings (Spark, Solana, the Ethereum consensus specs, two bitcoin
snapshots: 20 chart rows, the larger codebases) were **not scored under the second
version**: the run was stopped for memory partway through the first of them and Andrew
chose to stop there. Half the rows show no advantage; the other half are unmeasured, and
they are different codebases.

On this evidence a runtime upgrade is not earned by EmbeddingGemma 2: on the self-test at
this text length it matches the first version, more slowly, and on the filings scored it
is behind it. An upgrade would also change the runtime every
local generating model was qualified on ([`model-support.md`](model-support.md)).

**Limits.** One quantization (Q8_0) and one machine (Intel Iris Xe through Vulkan; no check
that its vectors equal a CUDA or CPU run's). The second version of the model was run on the self-test claims only. 39 chart rows, mostly two repositories; the
charts are parties' advocacy and a match is agreement with a party. Large indexes are
sampled to 3,500 functions, the same sample as the nomic run. The no-match band of
`--embed-distance` was not recalibrated for EmbeddingGemma and is not applied to it. The
litigant run was interrupted twice by the machine running low on memory and for a time two
copies ran at once on the same vector cache; every file was checked to parse, and the
scoring passes afterwards found every vector present and computed none.

```
node src/index.js --embed-model list
node scripts/function-text-reach.mjs --filings <work folder> --k 1,5,25,100 --embed-model gemma --cache <its own folder>
node scripts/function-text-reach.mjs --hof <index>/hof/<run> --claims-file <reworded claims> --k 1,5,25 --embed-model gemma-search --cache <the same folder>
```

Give each model its own `--cache` folder: the script's vector cache is kept per index and
keyed by prompt and text, not by model, so two models that share a document prompt would
read each other's vectors.

## Sections to come

The grouper's cover and split measurements, the two describers compared as a
table of contents, the no-match calibration of `--embed-distance`, and local describe
timings. The measurements of descriptions as search text are on
[`describe-reach.md`](describe-reach.md).
