# Pseudo-claims for CodeExam's Overview (rubric page)

A hand rubric: one claim set for the feature, every row cited to the code, used as the fixed
rows a `--pseudo-claims` run is scored against (`scripts/pseudo-claim-rubric-score.mjs`, #353
part (e)). Written 2026-10-29 from Andrew's notes, the drafts of the 10/25, 10/27 and 10/29 runs
and the working tree of 2026-10-29 (`86ef26b` plus the pack work that landed as `f87ec14`);
line numbers move with later commits, function names do not. The scorer reads the `**N.**`,
`(a)` and `wherein` markers under the Set heading and the citations table at the end. The
working notes the scratch original carried (comments answered, what the drafts missed) stay
outside the repository.

**As first written:**

One claim set, Set O, built from the Overview section of `pseudo_claim_rubric_notes_102926.txt`
(Andrew's edit of the 7:20pm run's claim 26 with comments), the two later drafters' overview
claims, the two chat transcripts, and the code. The claim text is kept free of code
citations; the table at the end maps every element and dependent to the lines it was written
from, with a provenance tag:

- `[A]` Andrew's notes of 2026-10-29;
- `[P26]` the 2026-10-25 7:20pm run's claim 26, `[file] overview.js`, which Andrew's draft
  edits;
- `[Cl15]` the Claude run's claim 15 and `[G15]` the ChatGPT run's claim 15 (both
  `[file] overview.js`, 2026-10-27);
- `[Chat]` the two transcripts (Claude 196-297; ChatGPT 362-935);
- `[C]` the code, where no draft or note had it.

Conventions as in the other sets. Set O receives Set V's vocabulary and Set C's concepts and
names them without restating them; the Overview by AI is a separate set and appears here in
one boundary dependent. Every drafter cited `src/core/overview.js` only; the rows below that
reach into `hotspots.js` and `calls.js` are where the drafts and the chats were thinnest.

---

## Set O: the Overview

**1.** A method of orienting a reader to a body of source code from an index of it, answering
what the body is and where to start reading ("orientation summary"), comprising:

(a) providing an index of the source code holding the path of every file, each file's lines,
a record of every function with its file and start and end lines, a ranked vocabulary of the
body's distinctive identifier tokens each with the files in which it is most concentrated,
and a tally, by name, of how many times each name is called anywhere in the body ("call
counts");

(b) computing from the file paths alone, without reading any file ("fast half"):
  - the distribution of files by file extension, each extension standing for a language;
  - the longest directory prefix shared by every path ("root"), an archive wrapper counting
    as part of the path;
  - the distribution of files by the first path segment after the root ("top-level
    folders");
  - a determination that the index holds a collection of separate projects rather than one
    project, made when at least a set number of top-level folders each hold at least a set
    share of the files; and
  - the counts of files and lines;

(c) computing from the function record, the vocabulary and the call counts ("deep half"):
  - the number of functions;
  - a list of entry points, being the largest functions whose names the call counts never
    saw, after excluding functions in noise files, type definitions, and very short
    functions, each entry point resolved to its file and definition line;
  - from a set number of the highest-scoring vocabulary tokens: the few highest as top
    terms; the concepts, each with an example identifier re-resolved to the line where it
    is defined; and the key files, being the files in which the most distinct top terms are
    concentrated, ties broken by the sum of each term's score times its concentration,
    capped at a set number; and
  - for each entry point and each concept example, a line number taken from the function
    record, else the first line of its file that mentions the identifier as a whole word;

(d) computing a second shared prefix over the paths of the key files and entry points alone
("display root"), so that the lists can omit it;

(e) noting absences: the collection determination, an index with no functions, and an index
with no entry points;

(f) merging the two halves into one summary record carrying every field above, the fast half
marked partial until the deep half is merged; and

(g) rendering the record as one page in a fixed order: size, languages, the root, the
top-level folders or the collection warning with its folders, the concepts with their
examples, the key files with their term counts, the entry points with shortened paths, the
absence notes, and the commands to run next, named in the vocabulary of the surface that
asked, flags for a command line and tool names for an agent,

wherein the summary is computed without a language model, so that the same index yields the
same summary.

**2.** The method of claim 1, in which the set number of top-level folders is three and the
set share is one tenth, files directly under the root forming no folder, and the root is
stripped before the folders are counted so that a single archive wrapper does not hide the
projects beneath it.

**3.** The method of claim 1, further comprising computing, beside the collection
determination and without altering it, a coupling signal: reading the import and include
directives in the first fifty lines of each file, resolving each named target to a top-level
folder, counting references that stay within the source file's folder and references that
cross to another, and taking the crossing share of all references, a share at or above a set
threshold reading as one project and below it as a collection; the signal recording whether
it agrees with the determination and whether it would withdraw a collection determination,
and never raising one.

**4.** The method of claim 3, in which the folder referenced by the most other folders is
taken as a shared kernel, and a second crossing share is computed with references into the
kernel excluded, so that coupling among the remaining folders is seen apart from coupling to
the kernel.

**5.** The method of claim 1, in which the call counts are a tally over every indexed line of
each name followed by an opening parenthesis, in plain, qualified, member and event-handler
registration forms, language keywords and comment words excluded, counted by the name's
last segment so that a name defined in several files shares one count, computed once and
cached for the run.

**6.** The method of claim 1, in which an entry point is a function or method of at least
three lines, not in a vendored, build-output, lockfile, test-tree, pseudo-source or minified
file, not a class or structure, whose last-segment name has a call count of zero, the
candidates ordered by line count descending; and in which the summary takes forty such
candidates, drops names that are quoted strings, contain a path separator, name a dependency
tree, or carry a renaming marker, keeps the first of any repeated name, places test functions
after the others, keeps eight, and shows each by its inferred display name.

**7.** The method of claim 1, in which the highest-scoring vocabulary tokens number two
hundred, the top terms fifteen, the concepts twelve, and the key files eight.

**8.** The method of claim 1, in which a concept's example identifier is re-resolved by
looking up every definition of the identifier without a file hint, preferring a definition
outside a type-declaration file, among those the one in the example's recorded file, else
the one with the largest body, and taking that definition's file and start line; and when no
definition is found, the first whole-word mention in the recorded file.

**9.** The method of claim 1, in which the whole-word mention is found by a word-boundary
pattern built from the identifier, scanning the file's lines in order and returning the
one-based number of the first match, and no line when none matches.

**10.** The method of claim 1, in which the display root is the longest directory prefix
shared by the key-file and entry-point paths together, the rendering states it once as the
prefix under which the listed paths lie, and a graphical rendering computes a prefix for the
key files and for the entry points separately, since in a collection the two lists can lie
in different projects.

**11.** The method of claim 1, in which the fast half is served to a graphical interface on
its own and rendered at once, the deep half being requested separately and merged on arrival;
on an index above a set size in lines or files the deep half waits for the reader to ask for
it; and a deep result that arrives after the reader has switched to another index is
discarded.

**12.** The method of claim 1, in which a command-line invocation and an agent tool compute
both halves in one call and render the page, the agent tool's next-command list naming tools
and the command line's naming flags.

**13.** The method of claim 1, in which the rendering omits the top terms, which remain in the
record for any consumer that wants them, and heads the concept and key-file sections with a
hedge that the items are potentially important.

**14.** The method of claim 1, in which a graphical rendering makes each key file and entry
point a row that opens the file at the resolved line and offers the function name to a
context menu, makes each concept row open its example's definition, makes a concept without
an example search the body of source code for the term, shows the summary in a pop-up when
an index is loaded, and offers a button to the file dependency map.

**15.** The method of claim 1, in which the counts of lines and the parsing method used to
build the function record are taken from the index's stored statistics, and the summary
names the parsing method.

**16.** The method of claim 1, in which the rendered page is supplied as the seed result to
a language model that writes a prose orientation of the same body of source code, the model
calling the same index's tools for the rest.

---

## Preamble variants for retrieval testing

| phrase | where it occurs | note |
|---|---|---|
| orientation summary | `ov:7-9`, `ov:103`, `ov:363` | the code's own noun; used in claim 1 |
| overview | the flag, the tool, the pane | the product name |
| "what is this index, and where do I start?" | `ov:8-9` header comment | used in claim 1's preamble |
| front door | `ov:8` | in code |
| one-shot orientation | `mcp:261`, `docs/CODEEXAM_MCP.md:57` | in code and docs |
| what is this code about, and where should I start | `docs/UNCOVER_KEY_CODE.md:9-10` | in docs |
| potentially important | `ov:~414`, `ov:~420`, `lr:1964`, `lr:1973` | the display hedge (#276); not a mechanism |
| fast half / deep half | `ov:52-56`, `ov:104-109`, `sv:2486-2510` | in code; used in claim 1 |
| collection | `ov:76-80` | in code |
| navigable, not just descriptive | ChatGPT transcript | outside the code; a dependent's purpose |

---

## Citations and provenance

`ov` = `src/core/overview.js`, `hs` = `src/core/hotspots.js`, `ca` = `src/core/calls.js`,
`lr` = `public/list-renderers.js`, `sv` = `src/server.js`, `mcp` = `src/mcp-server.js`,
`ix` = `src/index.js`, `vo` = `src/core/vocabulary.js`.

| claim | where | provenance |
|---|---|---|
| O1 preamble | `ov:7-9`; `docs/UNCOVER_KEY_CODE.md:18-21` | A, P26→C |
| O1(a) | `ov:58` (`index.files`), `ov:155-157` (function index), `ov:157` (`getTopVocabulary(200)`), `hs:98-103` (`getEntryPoints` reads `getCallCounts`), `ca:1060-1100` | G15 ("pre-existing conditions in one place")→C; call counts C |
| O1(b) | `ov:57-102`: extensions 61-66, root 68-71 and `ov:36-47`, folders 73-80 and `ov:25-30`, collection 81-82, stats 84-85 | P26, Cl15, G15→C |
| O1(c) | `ov:111-245`: `lineOf` 118-129, entry points 131-150, functions 153, vocabulary and top terms 157-158, concepts 164-194, key files 197-215 | P26→C; entry-point rule `hs:94-128` C |
| O1(d) | `ov:226-230`, `ov:390-396` | Cl15, G15→C |
| O1(e) | `ov:87-90` (collection note), `ov:218-224` (no functions, no entry points) | Chat→C |
| O1(f) | `ov:370-385` (`buildOverview`); `partial` `ov:100`, `ov:384` | P26→C |
| O1(g) | `ov:388-460` (`formatOverview`); surface-specific next steps 437-458 (#255) | P26 dep 10-11, G15→C |
| O1 wherein | `docs/UNCOVER_KEY_CODE.md:19-20` ("No language model is involved — the same index produces the same overview every time") | A (docs)→C |
| O2 | `ov:76-82`, `ov:68-71`, `ov:25-30`; `test/test_overview.js:45-50`, `83-96` | P26 dep 2, Cl15 dep 2→C |
| O3 | `ov:247-262` (header: observe-only, #285 Part A), `ov:264-265` (50 lines, 0.15), `ov:266-362`; logged to the error stream only, `ov:268`; returned in the record as `collectionSignal`, `ov:383` | A ("loosely-coupled"), Chat→C |
| O4 | `ov:330-346` (kernel by fan-in, peripheral fraction) | P26 dep 9, Cl15 dep 8→C |
| O5 | `ca:1060-1100` (`getCallCounts`: cache 1062-1065, patterns 1078-1083, keywords 1085-1095, bare-name counting below) | C |
| O6 | `hs:94-128` (`getEntryPoints`: lines ≥3, noise files, class skip, bare name, `callCount <= maxCalls`, size sort); `hs:30-42` (`_noiseFiles` via `_isNoiseDoc`); `ov:131-150` (40 taken, junk filter, dedup, tests last, 8 kept, display name) | A (question), P26 deps 6-7→C |
| O7 | `ov:157-158` (200, 15), `ov:164` (12), `ov:213` (8) | Chat→C |
| O8 | `ov:166-194` (#275) | Cl15 deps 3-4→C |
| O9 | `ov:118-129`; `test/test_overview.js:142-159` | P26 dep 5→C |
| O10 | `ov:226-230`; `ov:390-396`; `lr:1912-1925` (per-section peel) | G15 dep 7-8→C |
| O11 | `sv:2486-2510` (two routes); `lr:2452-2481` (`loadOverviewInto`, generation guard); `lr:2438-2439` (2,000,000 lines, 10,000 files); `lr:2401-2412` (`mergeOverviewDeep`) | Cl15 dep 10→C |
| O12 | `ix:1015`; `mcp:691-692`; `ov:437-458` | P26 dep 11→C |
| O13 | `ov:409-412` (top terms not printed, #181 polish), `ov:~414` and `~420` (the hedge, #276) | Chat→C |
| O14 | `lr:1894-2012` (`renderOverviewList`; `clickRow` 1936-1951; search fallback #268; file-only context for key files 1975); pop-up `lr:2485+` (`showOverviewOverlay`) | C |
| O15 | `ov:84-85`, `ov:94`, `ov:394-395` | C |
| O16 | `sv:2572-2596` (`overviewSeedResult`, the `overview` tool's first result captured), `mcp:691-692` | C |

Tests that pin rows: `test/test_overview.js:36-175` (size and languages, the collection
detector, root stripping, display root, breadth ranking, the concept example, the
no-functions absence, the fast/deep split, the whole-word fallback, the rendered sections);
`test/test_overview_example_resolution.js:54-100` (#275 re-resolution, `.d.ts` loses,
non-function fallback). The remaining four `test_overview_*` files are the Overview by AI.

---

## Scores (2026-10-30)

Scored with `node scripts/pseudo-claim-rubric-score.mjs`
`--rubric docs/pseudo-claim-rubrics/overview.md --run <file>` for each run below: the best run claim per run (MET counted twice, PARTIAL once)
among the claims with an anchor that matches a row's cite. MET is a cite match with half the
row's content words present, PARTIAL a cite match with a quarter or the words without the cite;
the overlap is a keyword proxy printed beside every verdict, and the reading stays the human's.
The runs are files in the project root of this checkout, not in the repository; "none" means no
claim in that run meets or partly meets a row.

| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |
|---|---|---|---|---|---|---|
| CE_pseudo_claim_test_102526_720pm_norank.txt (10/25 7:20pm, Claude, 41 claims) | 26 ([file] overview.js) | 3 | 13 | 8 | 7 / 0 / 9 | 4 |
| CE_pseudo_claims_vocab_concept_overview_Claude.txt (10/27, Claude, 18 claims) | 15 ([file] overview.js) | 2 | 10 | 12 | 9 / 1 / 5 | 2 |
| CE_pseudo_claims_vocab_concept_overview_ChatGPT.txt (10/27, ChatGPT, 18 claims) | 15 ([file] overview.js) | 3 | 14 | 7 | 5 / 0 / 8 | 3 |
| gemma4_CE_pseudo_claims_102926.txt (10/29, Gemma 4 on the Asus, 41 claims) | 29 ([file] overview.js) | 0 | 6 | 18 | 19 / 2 / 1 | 3 |
| CE_pseudo_concept_overview_103026.txt (10/30, Claude, 12 claims) | 11 ([file] overview.js) | 2 | 15 | 7 | 10 / 0 / 6 | 2 |
| CE_pseudo_vocab_103026.txt (10/30, Claude, 9 claims) | 7 ([file] overview.js) | 3 | 14 | 7 | 14 / 0 / 5 | 1 |
