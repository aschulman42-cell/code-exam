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
are built from a catalog currently with wrong joins (the last section).

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
figures above use the first order. The repair is the worklist item
`command-catalog-handler-resolution`; its before and after will be a section of this page.

## Sections to come

The label and the function text fused as one score for a mechanism. The grouper's cover and split measurements, the two describers compared as a
table of contents, the no-match calibration of `--embed-distance`, and local describe
timings. The measurements of descriptions as search text are on
[`describe-reach.md`](describe-reach.md).
