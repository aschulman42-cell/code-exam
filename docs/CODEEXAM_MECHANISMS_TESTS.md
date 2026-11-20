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

Rewording the limitation with a model before embedding it has now been measured on the same
chart rows (2026-11-16, the section near the end of this page). It reaches more of the cited
code, and another limitation's rewording reaches the same code almost as often; the
codebase's own vocabulary added nothing over a rewording made without it; and a rewording
did not make a codebase the chart does not accuse look matched. The rows are too few and too
alike to say more: the one chart whose limitations cite different code improved a great deal.

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

## Does rewording a limitation toward the code reach it? (2026-11-16)

A claim says things in a patent's words and code in an engineer's, and the embedding does
not cross between them on its own ([`describe-reach.md`](describe-reach.md), "Register, not
breadth"). `--embed-distance --toward-code` has a model reword each claim element before it
is embedded ([`cli.md`](cli.md)). This section scores that rewording where a party's cited
functions are the answers: the 39 chart rows of the twelve filings above, 129 of whose 139
cited functions are in a mechanism.

**The arms**, fixed before any run, each one model call per limitation:

| arm | what the model is given, beside the limitation and the chart's other limitations |
|---|---|
| as written | no model; the baseline of the sections above |
| blind | nothing: the restate prompt with an empty vocabulary list |
| restate | 150 words from the index's names |
| label | those words and 40 of the index's mechanism entries taken at even steps; it writes a label and function names, the shape of what is ranked |
| spec | the restate arm, with the patent's specification |

The prompts are those of `src/commands/toward-code.js` as committed in `a316232`. They had
been revised once, on one claim (the '101, below), and were not changed for or during these
runs. Rewriting models: Claude Sonnet 4.6 on every arm, ChatGPT (gpt-5.1) on the first three;
one rewording per limitation at temperature 0. ChatGPT returned nothing for two limitations
(the restate arm on the Coinbase SDK filing); those two are ranked as written.

**What is measured**, besides reach (the share of cited functions whose mechanism is within
5, 25 and 100):

- *Other limitation*: the rewording of another limitation of the same chart, read against
  this row's cited functions, as in the sections above.
- *Sameness*: the mean cosine between the limitations of one chart, as embedded. A rewording
  that raises it has made a chart's limitations sound alike. It needs no answers.
- *Crowding*: of the first five rows of every limitation of an index, the share taken by
  entries that are in the first five for half or more of that index's limitations (and at
  least two). A rewording that raises it is pulling toward the same few entries.
- *Margin*: how far the nearest entry sits above the median entry, the median over rows.
- *Wrong index*: each chart's limitations ranked on an index the chart does not accuse, a
  codebase of another field (the pairs are below). For the restate and label arms the
  limitation is reworded again with that index's words; the blind arm and the limitation as
  written are ranked there unchanged; the spec arm was not run there.

```
node scripts/function-text-reach.mjs --filings <work folder> --reword blind,restate,label,spec --llm claude --spec-dir <folder of US<patent>.txt> --wrong-map <pairs.json> --k 5,25,100 --embed-model gemma --cache <gemma's own folder>
```

Rewordings are kept one file per model, arm and job (`--reword-dir`), and a second run reads
them and calls no model. 429 model calls in all, $3.62.

### The result

By mechanism label, the right limitation and, in parentheses, another limitation of the
same chart. Under EmbeddingGemma, reworded by Claude:

| wording | within 5 | within 25 | within 100 | with function text, within 25 | sameness | crowding | margin | wrong index: margin | wrong index: crowding |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| as written | 18% (21%) | 54% (50%) | 84% (78%) | 50% (47%) | 0.709 | 51% | 0.144 | 0.127 | 49% |
| blind | 21% (22%) | 50% (50%) | 83% (75%) | 52% (50%) | 0.684 | 50% | 0.171 | 0.131 | 52% |
| restate | 15% (15%) | 53% (54%) | 88% (81%) | 50% (50%) | 0.694 | 60% | 0.161 | 0.128 | 59% |
| label | 26% (24%) | 60% (54%) | 91% (81%) | 57% (52%) | 0.754 | 61% | 0.195 | 0.133 | 59% |
| spec | 19% (19%) | 51% (51%) | 91% (82%) | 47% (48%) | 0.721 | 61% | 0.154 | | |

Under EmbeddingGemma, reworded by ChatGPT:

| wording | within 5 | within 25 | within 100 | with function text, within 25 | sameness | crowding | margin | wrong index: margin | wrong index: crowding |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| blind | 18% (18%) | 43% (39%) | 89% (81%) | 43% (45%) | 0.682 | 48% | 0.155 | 0.129 | 39% |
| restate | 15% (16%) | 53% (49%) | 87% (81%) | 44% (43%) | 0.685 | 46% | 0.155 | 0.126 | 42% |
| label | 22% (22%) | 50% (46%) | 84% (78%) | 50% (44%) | 0.721 | 49% | 0.157 | 0.131 | 46% |

Under nomic, reworded by Claude:

| wording | within 5 | within 25 | within 100 | with function text, within 25 | sameness | crowding | margin | wrong index: margin | wrong index: crowding |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| as written | 13% (16%) | 46% (42%) | 73% (71%) | 48% (46%) | 0.775 | 47% | 0.096 | 0.096 | 39% |
| blind | 26% (28%) | 48% (47%) | 84% (78%) | 53% (47%) | 0.793 | 52% | 0.110 | 0.092 | 48% |
| restate | 26% (26%) | 50% (49%) | 83% (77%) | 54% (47%) | 0.802 | 52% | 0.130 | 0.094 | 54% |
| label | 31% (29%) | 58% (53%) | 84% (76%) | 60% (53%) | 0.804 | 63% | 0.160 | 0.106 | 59% |
| spec | 25% (26%) | 57% (55%) | 86% (79%) | 57% (54%) | 0.825 | 52% | 0.112 | | |

Under nomic, reworded by ChatGPT:

| wording | within 5 | within 25 | within 100 | with function text, within 25 | sameness | crowding | margin | wrong index: margin | wrong index: crowding |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| blind | 17% (15%) | 45% (43%) | 84% (78%) | 43% (40%) | 0.789 | 45% | 0.115 | 0.096 | 49% |
| restate | 19% (14%) | 47% (42%) | 81% (75%) | 50% (40%) | 0.774 | 42% | 0.113 | 0.098 | 39% |
| label | 27% (22%) | 53% (50%) | 80% (74%) | 57% (52%) | 0.780 | 54% | 0.123 | 0.103 | 46% |

One point of reach is 1.3 functions.

### What it says

- **A rewording reaches more of the cited code, and the other limitation's rewording
  reaches it almost as often.** Under nomic every rewording raises reach, the blind one
  included (within 5 from 13% to between 17% and 31%, within 100 from 73% to between 80% and
  86%), and the control rises with it nearly point for point. Under gemma, which already
  reads 84% within 100 as written, only Claude's label and spec arms rise. The gap between
  the right limitation and another one is 4 points within 25 as written and never more than
  6 for any rewording by label. The earlier finding stands for rewordings as it did for
  text built from the code: the wording finds the patent's part of the code, not the
  limitation's.
- **The codebase's vocabulary added nothing a model did not already write.** The restate
  arm is the blind arm plus 150 of the index's words, and the two are level: 53% and 50%
  within 25 under gemma with Claude, 50% and 48% under nomic. ChatGPT's blind arm is 10
  points lower than its restate arm at one depth under gemma (43% against 53%) and level
  elsewhere.
- **The label form is the best arm, and what in it helps is not separated.** It leads
  within 5 and within 25 with Claude under both embedders (60% and 58% within 25). It was run only with
  the vocabulary and the sample entries together, so whether the shape, the samples or the
  words do the work is not known. It also raises sameness (0.709 to 0.754 under gemma) and,
  with Claude, crowding (51% to 61%).
- **The specification did not help.** The spec arm is level with or below the restate arm
  within 25 under gemma (51% against 53%) and above it under nomic (57% against 50%) with
  the control beside it (55%), at roughly ten times the input tokens.
- **A rewording did not make the wrong codebase look matched.** On an index the chart does
  not accuse, the nearest entry's margin over the median barely moves under any rewording
  (0.127 as written, 0.126 to 0.133 reworded, under gemma; 0.096, then 0.092 to 0.106, under
  nomic), where on the accused index it rises (0.144 to between 0.154 and 0.195; 0.096 to
  between 0.110 and 0.160). The blind arm, which is told nothing of any codebase, shows the
  same difference. Crowding is the exception: Claude's rewordings raise it on the wrong
  index as on the accused one.
- **Claude's rewordings crowd the first rows and ChatGPT's do not.** 60% and 61% against
  51% as written under gemma for Claude's restate and label arms; 46% and 49% for ChatGPT's.
- **The gain there is sits in one filing.** Under gemma the label arm's rise within 25 is
  the Spark chart: 4 of its 21 cited functions as written, 10 reworded, with another
  limitation's rewording at 1 both times. That is the one chart outside elliptic-curve code
  with more than two cited functions in a mechanism. In the six secp256k1 and bitcoin
  filings, 102 of the 129 functions, the right limitation and another one score the same
  under every wording, since those charts cite the same functions for several limitations
  and the control cannot separate them there.

### What it decides

The outcomes and what each would decide were written before the runs. The one that
happened: an arm raises reach, and the other-limitation control, sameness or crowding rises
with it. So `--toward-code` stays a testing option, a shortlist for a later reading step is
made from the limitation as written, and a rank under a rewording is not read as a finding.
The vocabulary did no better than the blind arm, which by the same list takes it out of the
restate prompt; the prompts are left as they are while the option is for testing only.

What this test could not decide: 39 rows is too few, and 24 of them too alike. The one chart
where limitations cite different code moved a long way, and one chart is an example, not a
result.

### The wrong-index pairs

Chosen from the patents' titles and the repositories' file names, before any rewording was
made: Spark's chart on bitcoin/bitcoin; the solana and both bitcoin charts on Spark; the
consensus-specs, secp256k1 (four charts), Coinbase SDK and dstoken charts on
text-generation-inference; the text-generation-inference chart on dstoken. A rule drafted
first (the next filing's index) was dropped before the runs because it paired secp256k1 with
bitcoin/bitcoin, which carries a copy of secp256k1. Margins on indexes of very different
size (149 entries to 16,677) are not on one scale; the table compares each index with
itself across wordings.

### The two claims run first, apart from the chart rows

`--toward-code` was first run on two claims with no party's citation, and its prompt was
revised once on the first of them, so neither is counted above.

- Claim 1 of US 8,752,101 against ExoPlayer 3 (10,828 entries, gemma, Claude), read against
  a class Andrew suspects. The nearest entry labelled `AdaptiveTrackSelection` on the three
  elements about choosing the rate: rank 151, 1,109 and 342 as written; 78, 229 and 103
  restated; 7, 190 and 25 in the label form. The first prompt's label form had written the
  claim's main idea for five of nine elements and ranked that class 7th for the preamble;
  the revised prompt put the preamble at 575. The first rows are `Builder / bitrate` setters
  in both forms.
- A pseudo-claim for CodeExam's own no-cloud mode against CodeExam's index (426 entries,
  gemma), written to avoid the code's word "air-gapped". Rank of `[file] air-gapped.js` over
  its eight elements: 3, 33, 2, 13, 35, 3, 10, 124 as written; 11, 33, 4, 5, 11, 2, 13, 3
  restated by ChatGPT; 4, 35, 4, 8, 41, 5, 11, 4 in Claude's label form. Neither model wrote
  "air-gapped", though "air" and "gapped" were among the words shown, separately.

Limits: 39 rows, 24 of them from six filings on secp256k1 and bitcoin that cite overlapping
functions; the charts are parties' advocacy, and a hit is agreement with a party, not
correctness; every codebase and patent here is public and both models may know them from
training, so nothing here tests confidential code, the case the vocabulary was meant for;
one rewording per limitation; the label form without the vocabulary was not run; no local
rewriting model; the whole claim shown to the model is the chart's limitation texts in
order, not the patent's claim.

## Rolling a search's groups up into directories, files and sections (2026-11-19)

`--semantic-search` lists groups and functions one by one. A listing could say instead
where the closest code is: "9 of the first 100 results are in `…/trackselection`". This
asks whether that would help, with the chart rows and controls of the sections above. It
also asks the same of a partition CodeExam made itself, with no directory names: the
sections and sub-sections of a clustering of the groups. No feature was built.

**What was rolled up.** The ranking `--semantic-search` uses: each group scored by its
label and its best function's text, 0.3 on the label. Each group is put in one unit of each
kind:

- **directory** and **file**: the one most of the group's functions are in;
- **section** and **sub-section**: from a clustering kept outside the repository (bottom-up
  Ward clustering of the groups' function-text vectors, one tree, cut at about
  0.65 × √groups sections and groups ÷ 8 sub-sections). Variant **E** uses the vectors
  alone; variant **ECO** adds calls between groups and shared functions.

**Four rules for scoring a unit**, fixed before any run:

- *count*: how many of the first 100 groups fall in it (what a listing would print);
- *count, size-corrected*: that count over what the unit's share of all groups would give;
- *best three*: the mean of its three best groups;
- *best one*: its best group.

**How it was run.** The twelve filings, 35 chart rows with a cited function a group holds,
129 cited functions; ten of the twelve filings contribute (two have no cited function in a
group). The limitation as written. Large indexes sampled to 3,500 functions, as in every
table above, so their groups are those holding a sampled function.

```
node scripts/function-text-reach.mjs --filings <work folder> --arms comments --embed-model gemma --cache <its folder> --k 3,5,10,25,100 --rollup --units <folder of section files>
```

Each cell is the share of cited functions whose unit is within the first 3, 5 or 10 units,
then in parentheses the same for another limitation of the same chart, and chance.
EmbeddingGemma, all twelve filings:

| unit | units, summed | rule | within 3 | within 5 | within 10 |
|---|--:|---|--:|--:|--:|
| directory | 913 | count | 91 (84 / 59) | 93 (86 / 64) | 95 (88 / 74) |
| directory | 913 | count, size-corrected | 49 (50 / 36) | 54 (53 / 40) | 84 (75 / 60) |
| directory | 913 | best three | 88 (79 / 57) | 91 (83 / 62) | 95 (86 / 74) |
| directory | 913 | best one | 79 (78 / 51) | 84 (81 / 59) | 94 (84 / 71) |
| file | 3,907 | count | 28 (23 / 21) | 38 (33 / 27) | 64 (60 / 39) |
| file | 3,907 | count, size-corrected | 16 (16 / 7) | 23 (23 / 9) | 40 (39 / 19) |
| file | 3,907 | best three | 19 (19 / 5) | 31 (27 / 9) | 56 (51 / 22) |
| file | 3,907 | best one | 15 (16 / 8) | 28 (28 / 12) | 53 (49 / 23) |
| section, E | 249 | count | 83 (76 / 43) | 92 (85 / 53) | 94 (87 / 74) |
| section, E | 249 | count, size-corrected | 78 (70 / 32) | 87 (82 / 43) | 94 (85 / 71) |
| section, E | 249 | best three | 72 (70 / 36) | 91 (84 / 53) | 95 (85 / 73) |
| section, E | 249 | best one | 73 (69 / 39) | 86 (81 / 53) | 95 (86 / 74) |
| sub-section, E | 2,160 | count | 55 (47 / 16) | 75 (71 / 22) | 85 (78 / 37) |
| sub-section, E | 2,160 | count, size-corrected | 32 (36 / 17) | 50 (47 / 29) | 69 (64 / 36) |
| sub-section, E | 2,160 | best three | 52 (53 / 14) | 68 (63 / 19) | 82 (74 / 38) |
| sub-section, E | 2,160 | best one | 47 (47 / 15) | 59 (60 / 19) | 75 (68 / 33) |
| section, ECO | 249 | count | 71 (72 / 50) | 91 (83 / 59) | 94 (85 / 72) |
| section, ECO | 249 | count, size-corrected | 73 (68 / 42) | 82 (78 / 51) | 94 (85 / 70) |
| sub-section, ECO | 2,160 | count | 46 (43 / 14) | 60 (56 / 23) | 71 (65 / 40) |
| sub-section, ECO | 2,160 | count, size-corrected | 33 (34 / 9) | 42 (43 / 17) | 56 (60 / 29) |

**The cost to a reader.** A unit near the top is no use if the reader then has to read all
of it. These rows put the groups in the order a reader meets them when units are opened in
rank order and ten groups of each are read, and count cited functions within that many
lines, beside the flat list:

| lines read in this order | within 5 | within 10 | within 25 | within 100 |
|---|--:|--:|--:|--:|
| the flat list of groups | 16 (18 / 5) | 29 (27 / 8) | 50 (47 / 15) | 90 (81 / 44) |
| by directory, ranked by count | 22 (19 / 5) | 33 (27 / 7) | 36 (30 / 12) | 74 (66 / 40) |
| by directory, ranked by best three | 18 (19 / 6) | 25 (25 / 7) | 34 (27 / 12) | 74 (66 / 40) |
| by file, ranked by best three | 12 (12 / 2) | 19 (17 / 3) | 46 (43 / 11) | 86 (79 / 43) |
| by section E, ranked by count | 11 (12 / 5) | 16 (17 / 8) | 45 (40 / 16) | 81 (73 / 41) |
| by sub-section E, ranked by count | 14 (11 / 2) | 26 (20 / 2) | 40 (33 / 9) | 75 (67 / 38) |
| by sub-section E, ranked by best three | 9 (11 / 4) | 22 (19 / 4) | 46 (41 / 11) | 75 (66 / 40) |
| by sub-section ECO, ranked by best three | 17 (18 / 5) | 26 (22 / 5) | 49 (47 / 14) | 81 (73 / 43) |

What the two tables show:

- **The unit holding the cited code is near the top far more often than chance, and
  hardly more often than for another limitation of the same chart.** Section E by count:
  83 within three, 76 for another limitation, 43 by chance. This is the pattern of every
  measurement on this page: the roll-up finds the part of the codebase the claim is about,
  not the part one limitation is about.
- **The directory's lead is mostly its size.** By count the right directory is in the
  first three 91 times in 100; corrected for size it is 49, level with another limitation
  (50). One directory often holds most of an index's groups (117 of 169 on secp256k1).
- **A section does as well as a directory, with about a quarter as many units, and keeps
  its lead when corrected for size** (78, against 70 and 32). The sections were made with
  no directory names.
- **Adding calls to the clustering did not help.** Variant ECO is level with or below E on
  nearly every row.
- **Reading by unit is not cheaper than the flat list.** Within 25 lines the flat list
  reaches 50 in 100 and no unit order beats it (49 at best). Reading by directory is a
  little ahead in the first ten lines (33 against 29) and well behind by 25 (36 against 50).

**Without the six secp256k1 and bitcoin filings**, whose charts cite the same functions for
several limitations so that the other-limitation control cannot separate there: four
filings contribute, 11 chart rows and 27 cited functions, **21 of them from one chart**
(Spark). The figures are that chart's, and one chart is an example:

| | within 3 | within 5 | within 10 |
|---|--:|--:|--:|
| directory, count | 56 (22 / 15) | 67 (33 / 22) | 74 (41 / 30) |
| directory, count, size-corrected | 11 (7 / 0) | 11 (7 / 0) | 52 (11 / 7) |
| section E, count | 67 (30 / 19) | 74 (37 / 19) | 74 (44 / 30) |
| section E, count, size-corrected | 63 (22 / 15) | 74 (33 / 19) | 74 (37 / 22) |
| sub-section E, count | 56 (19 / 4) | 59 (30 / 7) | 67 (33 / 11) |

Here the section does tell one limitation from another (67 against 30), and reading by
section reaches more than the flat list within 25 lines (67 against 44; on Spark alone 57
against 33). It is the first table on this page where a unit separates limitations, and it
rests on one chart of five rows.

**Under nomic** (the sections are still the ones built from EmbeddingGemma's vectors, so
this ranks by one model and partitions by another): section E by count 78 (74 / 42) within
three, size-corrected 71 (64 / 33); directory by count 87 (78 / 63), size-corrected 33
(36 / 29); the flat list 48 (46 / 17) within 25 lines, by section E 45 (43 / 17). The same
reading.

**Units per index** (largest unit in parentheses):

| filing | groups ranked | directories | sections | sub-sections |
|---|--:|--:|--:|--:|
| databricks, apache/spark (sampled) | 2,067 | 431 (138) | 76 (86) | 912 (10) |
| veritaseum, solana (sampled) | 1,523 | 188 (257) | 35 (97) | 327 (21) |
| veritaseum, ethereum/consensus-specs | 209 | 61 (32) | 9 (61) | 26 (18) |
| foundry 1-11, secp256k1 | 169 | 10 (117) | 8 (45) | 21 (18) |
| foundry 1-14, secp256k1 | 166 | 10 (111) | 8 (34) | 21 (15) |
| viabtc, bitcoin (sampled) | 1,707 | 80 (261) | 39 (121) | 401 (19) |
| mara, bitcoin (sampled) | 1,637 | 74 (267) | 37 (98) | 368 (19) |
| core-scientific (two charts), secp256k1 | 166 | 10 (111) | 8 (34) | 21 (15) |
| vm-innovations, coinbase-sdk-nodejs | 114 | 10 (48) | 7 (25) | 14 (16) |
| friendliai, text-generation-inference | 142 | 16 (23) | 8 (34) | 18 (18) |
| securitize, dstoken | 82 | 13 (34) | 6 (30) | 10 (16) |

**What it decides.** The outcomes were written before the run. This is the second of them:
the roll-up beats chance and not the other-limitation control, so a "where the closest
code is" view is worth having as *the part of the codebase this claim is about*, shown once
per claim and not per limitation. It is not a cheaper way to read results than the flat
list. If such a view is built, units should be ranked by a size-corrected count, or the
largest directory wins every time. That a partition made by CodeExam does as well as the
directory tree is the new result, and it matters where the tree says little (ten
directories for secp256k1, 117 of its 169 groups in one of them).

**Limits.**

- **The sections are made from the vectors the search ranks by.** Results near a query
  fall in few sections by construction, right or wrong. The size-corrected rule, the
  other-limitation control and the run under a second model are the checks; none removes
  it.
- **Test code is in.** The harness ranks every group, and the sections were built with
  test groups kept, where `--semantic-search` leaves them out. On the consensus-specs
  index the test rule would have removed 190 of 209 groups, since its Python code is under
  `tests/core/pyspec/eth2spec`. (Corrected 2026-11-20: this line first gave the cause as a
  directory named `specs/`. No row of the 24 indexes checked is test code only because of a
  `spec` or `specs` directory.)
- **Not run, though planned**: the same roll-up on an index the chart does not accuse; the
  `label` rewordings; the '101 claim against ExoPlayer 3 as an example.
- **One clustering**, at one section count per index, one tree, kept outside the
  repository. How stable its sections are was not measured on these indexes; on three
  others, in the same scratch work, building the tree again from 80% of the groups gave
  agreement of 0.50 to 0.67 (adjusted Rand index), which is moderate.
- 35 rows; six filings of twelve are secp256k1 and bitcoin; the charts are parties'
  advocacy and a hit is agreement with a party; sampled indexes rank a sample.

## The order of `--toc` and `--mechanisms`, and their test rows (2026-11-20)

Until this date both listings, the GUI's Mechanisms list and the `list_mechanisms` tool
printed the rows in the mechanisms file's order, which is the grouper's: largest group
first. They now leave out the rows that are wholly test code (`--include-tests` lists
them) and take an order: `--sort-by size`, still the default, or `--sort-by path`, grouped
by source directory under a heading line and by file within a directory.

**Directory order was built as the new default and was not kept as one.** It met the rule
set in advance (below) and was the default for a few hours. Andrew, reading CodeExam's own
listing: what matters is in `src/`, which comes after `public/` and `scripts/`; `--max-results
10` shows minor rows; "I don't think we've gained anything here". The measure the rule used,
how close neighbouring rows are, says nothing about whether the first rows are the ones a
reader wants. Largest first is the default again, with its known fault on large indexes
(first table). The directory order was changed twice that day on his reading, and the
"after" and "source order" figures below are of `--sort-by path` as committed:

- As first applied, command rows (`[cmd] --flag`) came before everything else. The first
  page was then all command rows and read as if that were all the listing does. A command
  row is now placed like any other.
- A row was filed under the directory holding the most of its functions, the first by path
  on a tie. The listing opened with `callees (findCallees)`, four functions in four
  directories, under `public/` because p sorts before s, and nothing said why. A row no
  one directory holds more than half of now goes under "across directories", after the
  directories (24 of CodeExam's 363 rows, 306 of ExoPlayer 3's 8,396), and each group has
  a heading with its count.

The figures of the first form, for the record: first 100 rows leftover or oversized, x264
22, CodeExam 23, ffmpeg 15, ExoPlayer 3 11; neighbour closeness CodeExam 0.713 (88%), the
Bram snapshot 0.656 (94%), ExoPlayer 3 0.769 (98%). Two counts were taken, the second before the order was adopted, with
a rule set in advance: if source order's neighbours were not clearly closer than size
order's on all three indexes, stop.

**What the first 100 rows hold**, the default page, before and after. "Leftover or
oversized" is a row that is an `/ other` piece or is tagged `giant`, `indivisible` or
`noise`.

| index | rows | test rows | leftover or oversized, before | after | test rows shown, before | after | directories on the page, before | after |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| x264 | 367 | 4 | 33 | 19 | 1 | 0 | 16 | 2 |
| CodeExam | 426 | 63 | 61 | 23 | 1 | 0 | 6 | 4 |
| a Bram snapshot | 104 | 5 | 32 | 32 | 5 | 0 | 7 | 7 |
| ffmpeg | 5,844 | 222 | 100 | 15 | 2 | 0 | 17 | 13 |
| ExoPlayer 3 | 10,828 | 2,432 | 100 | 11 | 36 | 0 | 37 | 14 |

The Bram snapshot has 104 rows, so its page is the whole listing either way. The first page
also holds far fewer functions than before (ExoPlayer 3: 439 of 46,318, against 3,909),
because it no longer collects the largest rows.

**How close neighbouring rows are.** Each row as the mean of its functions' text vectors
under EmbeddingGemma, test rows left out, rows with no vector left out; the figure is the
mean cosine between a row and the next, then the share of neighbours in the same directory.

| index | rows | size order | source order | shuffled | the scratch clustering's order |
|---|--:|--:|--:|--:|--:|
| CodeExam | 363 | 0.669 (64%) | 0.721 (93%) | 0.636 (28%) | 0.805 (67%) |
| a Bram snapshot | 99 | 0.583 (63%) | 0.651 (90%) | 0.566 (54%) | not saved |
| ExoPlayer 3 | 8,394 | 0.589 (60%) | 0.769 (95%) | 0.452 (3%) | 0.845 (80%) |

Source order is above size order on all three, by a little on CodeExam and by a great deal
on ExoPlayer 3, so the rule was met. The last column is from the scratch probe's reports of
2026-11-19 (Ward clustering of the same vectors, its leaves in tree order), on the same
count of CodeExam rows and on 7,495 of ExoPlayer's; it was not rerun for this table.

**What this shows and does not.**

- **An order by similarity does better than source order** on the measure used, on both
  indexes where it was run: neighbours are closer though fewer of them share a directory.
  The measure is the one the clustering optimises, so the comparison favours it; no
  measure of a person finding something exists for either order.
- **Source order does not make the first page a summary.** On ExoPlayer 3 the page is the
  Cast demo app, the first directory by path.
- **The default hides real code on one index.** ethereum/consensus-specs keeps its Python
  under `tests/`; 190 of its 209 rows are left out, and the line under the header is what
  says so.
- **Where command rows and spread rows go** rests on one reader of one index. On
  CodeExam the first page is now the GUI's files (`public/`), the first directory by
  path, which is no more a summary than ExoPlayer's Cast demo app.
- **A listing grouped by directory can read as a directory listing**, not as a list of
  what the code does (Andrew, before seeing it). Nothing here measures that.
- Three indexes for the second table, five for the first. The scratch script is
  `order-adjacency.mjs`, outside the repository.

## Sections to come

The grouper's cover and split measurements, the two describers compared as a
table of contents, the no-match calibration of `--embed-distance`, and local describe
timings. The measurements of descriptions as search text are on
[`describe-reach.md`](describe-reach.md).
