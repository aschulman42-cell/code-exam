# Mechanisms: how CodeExam groups a codebase's functions, and what the groups are for

*This page is about the mechanism discovery and labelling CodeExam performs on **any**
indexed codebase: an index of ffmpeg, of ExoPlayer, of a client's source under a protective
order, of CodeExam's own source alike. It is not a page about CodeExam's own mechanisms (a
"meta" page, what `--toc` run on CodeExam's index says about CodeExam, could exist one day;
[`CODEEXAM_SELF_PORTRAIT.md`](CODEEXAM_SELF_PORTRAIT.md) is the nearest thing today). It is a
feature page: what mechanisms are, how they are found, how to read them, what they are used
for. The measurements live on their own pages and are linked, not reproduced. Terminal output
quoted here is wrapped to fit the page; the terminal prints each row on one line.*

## What a mechanism is

A mechanism is a group of functions that belong together by one of a few deterministic
signals: they are the functions of one file, or of one class, or the handler and callees of
one command, or they share a distinctive name token. It is a grain between a function and a
file: large enough to be "the thing that does X", small enough to read in one sitting.

The **mechanisms index** is the set of those groups for a whole codebase, written once by
`--build-mechanisms` to `mechanisms.json` beside the index's other files. It is a *cover*:
every function of four lines or more sits in at least one record, and a function may sit in
two (a class and the file that holds it; a name-token group and a piece of a file). Records
whose members are the same set under two labels fold into one row in every listing, the
second label shown after `also`.

Building needs no model. Measured on a commodity Windows laptop:

| index | functions | records | rows after the fold | build |
|---|---|---|---|---|
| the bundled demo | 100 | 40 | 34 | 0.2 s |
| x264 | 1,754 | 376 | 367 | 1.4 s |
| ffmpeg | 33,920 | 5,851 | | 17 s |
| ExoPlayer 3 | 50,484 | 11,819 | 10,828 | 55 s |
| WinAPI samples | 60,991 | 13,078 | 11,885 | |

The sixteen indexes of the claim-chart agreement harness, Spark's 16,677 records included,
built in under three minutes together (2026-11-06). The command prints its own estimate
before it starts and the cover when it is done:

```
ce --ndx .demo --build-mechanisms
Building mechanisms index from 19 loaded files, 154 functions (every function in at
  least one record; about 1 minute on an index this size)...
Done: 40 record(s) covering 100 of 100 functions (100%), 16 of 16 files, written to
  .demo\mechanisms.json in 0.2 s
  ce --index-path .demo --mechanisms [filter]   lists them, --toc [filter] is the
  one-line contents; the GUI's Mechanisms list and the list_mechanisms tool read the
  same file.
```

(154 functions loaded, 100 covered: the 54 shorter than four lines are not grouped; see
*Limits*.)

## How mechanisms are discovered

The grouper (`src/core/mechanism-grouper.js`) is deterministic: the same index gives the same
records every time. Run as a cover, it seeds groups four ways, then adjusts them.

- **File seed.** Every file seeds a record of its functions, `[file] frame.c`. This is the
  record that guarantees the cover; the other seeds add the cross-file and within-file
  structure. (The pseudo-claims *candidate* emission, which uses the same grouper in a
  drafting mode, seeds only files with a doc header; the cover seeds all.)
- **Class seed.** A class seeds a record of its methods, `[class] NetworkManager`; a nested
  class reads `[class] AdaptiveTrackSelection::Factory`.
- **Command seed.** When the codebase has a command catalog (a CLI whose flags map to
  handlers, as CodeExam's own does), each command seeds a record of its handler and the
  callees the handler reaches, `[cmd] --interactive`.
- **Token seed.** A name token shared by a distinctive set of functions across files seeds a
  record, labelled by the token and a namesake function so the reader can place it:
  `packet (AVPacket)`, `tls (tls_send_encrypted)`, `rowset (DBPROP_IRowsetChange)`. A token
  that owns too large a share of the candidates *and* cross-cuts too many files is a
  namespace or a prefix, not a mechanism, and is not seeded; its functions fall through to
  the other seeds.

**Three of the four seeds cross files; only the file seed does not.** A token group
gathers every function carrying its token wherever it sits: `pic (x264_cli_pic_alloc) /
picture / clean` spans 9 of x264's files, `packet (AVPacket) / read` 248 of ffmpeg's. A
class record holds the class's methods wherever they are defined, so a C++ class declared
in a `.h` and defined in a `.cpp` is one record: on the WinAPI samples, 1,921 of the 5,206
class records span two or more files and 802 span a header and its source
(`[class] CCandidateWindow / other`, 40 methods over `CandidateWindow.h` and
`CandidateWindow.cpp`). Classes are keyed by their leaf name, which merges `blink::Foo`
with a bare `Foo` as intended, and can also merge unrelated classes that share a name
(ExoPlayer's `[class] Factory / factory` holds the `Factory` inner classes of 62 files, 98
methods; WinAPI's `[class] CClassFactory / create` holds 38 from some thirty samples). A
command record follows the
call graph: the handler, its callees, then theirs, two hops and at most 40 members, across
whatever files they live in (`[cmd] --interactive` reaches 7 files). That callee walk is
the only use the grouper makes of callers and callees: no seed clusters functions by who
calls whom, and the splitter cuts by name token only. So a mechanism spread over files
whose functions share neither a name token, nor a class, nor a command's two-hop call
closure is not found as one record; its parts sit in their file records, and a claim that
reads across them has to be matched piece by piece (see *Limits*).

Then:

- **The splitter** cuts a group that is too large along the name tokens its members share,
  giving pieces labelled with the word: `[file] itbldef.cpp / variation`,
  `[file] mov.c / mov / read` (split twice), `[class] AdaptiveTrackSelection / duration`.
  What no word claims stays in an `/ other` piece. A group the splitter cannot cut is tagged
  `indivisible`; a large one `giant`.
- **The four-line floor.** Functions shorter than four lines (one-line getters, wrappers,
  macros that parse as functions) are not grouped. They are in the index and every search
  finds them; they are in no mechanism record.
- **The purpose** of a record is harvested from the code's own doc text, license sentences
  and `@param`-style tag lines filtered out: a file record's leading doc block; a command
  record's handler doc; a token group's namesake doc or body comments; then the first
  sentence of up to three dominant members' docs; then a mechanical `calls: a, b, c` line. A
  piece with nothing of its own inherits its parent's doc, prefixed `in class X:` or
  `in <file>:`. The purpose is shown under the label, cut at 90 characters in the contents
  listing, and is the text a model reads first when asked to describe the record.
- **Tags**: `test` (test code), `noise`, `vendored` (third-party code carried in the tree),
  `giant`, `indivisible`.

## How to read a label

Real rows, as `--toc` prints them on the x264, ffmpeg, ExoPlayer, WinAPI, demo and CodeExam
indexes, each followed by how to read it:

- `[file] frame.c / x264  (27 fns, 1 file)  [giant, indivisible]`
  The functions of `frame.c`, the piece whose names share the token `x264` (the file was
  split); 27 functions; the piece is still large and cannot be cut further.
- `[file] mov.c / mov / read  (127 fns, 1 file)`
  `mov.c`, split twice: the `mov` piece, then its `read` piece.
- `[file] itbldef.cpp / variation  (451 fns, 1 file)`
  One file's 451 `Variation_*` test functions, which no further word separates.
- `msa (x264_intra_predict_vert_16x16_msa) / x264 / pixel  (43 fns, 2 files)`
  The functions sharing the token `msa`, with `x264_intra_predict_vert_16x16_msa` as the
  namesake, split down to the `pixel` piece; across 2 files.
- `packet (AVPacket) / read  (276 fns, 248 files)  [giant, indivisible]`
  A token group too wide to split further: everything in ffmpeg that reads a packet.
- `[class] NetworkManager  (10 fns, 1 file)  also [file] NetworkManager.java`
  One class's methods; the file holding only that class folded into the same row.
- `[class] AdaptiveTrackSelection / duration  (3 fns, 1 file)`
  The piece of a split class whose method names share `duration`.
- `[cmd] --interactive  (40 fns, 7 files)`
  A command's handler and what it reaches.

`--mechanisms [filter]` prints each row with its record id (`m5`, `m71`: the number of the
record in the file, the one that names the row when two are folded), its label, counts,
tags, purpose or description, and its member names; `-v` lists every member as
`file@name  (L12–48)`, the function's line range in the index after its anchor.
`--toc [filter]` prints the same rows one line each, numbered from 1 in the same order (an
ordinal, not a rank), the header first:

```
367 mechanisms (376 records, 9 folded as the same functions under another label)
  (showing 100): a cover of 1,754 of 1,754 functions (100%), 149 of 149 files;
  built 2026-11-06 by --build-mechanisms, described by Claude API
```

Both listings cap at 100 rows; `--max-results N` sets the cap and `--all-results` lifts it.
The filter is a substring or a `/regex/` matched against a row's label, text, files and
member names, so `--toc frame.c`, `--toc /^\[class\]/` and `--toc x264_frame_delete` each
narrow to the rows that match (the last to the one record holding that function). The
optional value follows its flag directly: `--toc frame.c -v`, not `--toc -v frame.c`.

## Descriptions, optional

`--describe` asks a model for one plain sentence per record, from a pack of the record's
label, kind, files, purpose, calls, member names and the first lines of up to three members,
and stores it in `mechanisms.json` with the engine that wrote it. A cloud model
(`--llm claude`, `--llm gemini`) or a local GGUF (`--model <file>`) does the writing. Three
scopes: with `--build-mechanisms`, every record just built; with `--mechanisms <filter>` or
`--toc <filter>`, only the rows listed; alone, every record of the existing file. A sentence
is paid for once: a run skips records that already carry one, so a filtered run today and a
full run later add up, and `--redescribe` rewrites; a rebuild carries sentences over to every
record whose label and members did not change. When the model stops answering, the run stops
after five failures in a row, keeps what it got, and the same command resumes. A cloud run is
projected against the $2 claims cost guard first; `--force` proceeds past it.

What a described row looks like, x264 by Claude:

```
1. MIPS MSA implementations of x264 pixel metric functions — SAD, SATD, SSD, variance,
   and mean absolute deviation — for all standard block sizes used in motion estimation
   and mode decision.  ([file] mips/pixel-c.c / x264; 58 fns, 1 file)  [giant, indivisible]
```

and undescribed rows, as ffmpeg's read before any model, the quote being the harvested
purpose:

```
1. packet (AVPacket) / read  (276 fns, 248 files) — "pkt size is repeated at end. Check
   for FLV1 streaming found 1 to avoid clash with video s…"  [giant, indivisible]
4. packet (AVPacket) / data / side  (23 fns, 5 files) — "Add a new frame side data entry
   to an array based on existing packet side data, if a matc…"  [giant]
```

The sentence is for the reader: a table of contents of what the codebase is made of, one
line a mechanism, in the words of a reviewer rather than of the names. On Claude it costs
about $0.003 a record (the demo's 40 for $0.11; x264's 367 rows for $1.43; the 13,078-record
WinAPI index projected at about $75), and nothing but time with a local model. The sentence
is *not*, so far, a better text than the labels for finding a mechanism from a claim; that
measurement is on [`describe-reach.md`](describe-reach.md), and *How well it works* below has
the one-line version.

## What mechanisms are used for

- **Reading a codebase.** The GUI's **Mechanisms** list ([`CODEEXAM_GUI.md`](CODEEXAM_GUI.md))
  and `--mechanisms [filter]` show the rows with their members; `--toc [filter]` prints the
  contents page; the MCP `list_mechanisms` tool gives an agent the same rows
  ([`CODEEXAM_MCP.md`](CODEEXAM_MCP.md)). All read the one file; none recomputes the grouping.
- **Drafting pseudo-claims.** `--pseudo-claims --candidates` emits the grouper's candidate
  groups for drafting ([`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md)); the same
  grouper, run as a cover rather than as a ranked emission, is the mechanisms index.
- **The HOF self-test.** "Huffing our own fumes" (`ce --hof`, [`cli.md`](cli.md); the section
  of that name on [`CODEEXAM_PSEUDO_CLAIMS_TESTS.md`](CODEEXAM_PSEUDO_CLAIMS_TESTS.md)) drafts a
  claim from a
  mechanism and asks whether CodeExam's claim search finds its way back to that
  mechanism's functions. The answer is known because the claim was written from the code,
  which is what makes HOF the yardstick for claim features still being improved: claim
  search, `--claim-locate` and the claim charts are work in progress, and the mechanism
  grain is the current line of that work ([`describe-reach.md`](describe-reach.md) for the
  measurements; [`claims-pipeline-state.md`](claims-pipeline-state.md), section 4, for where
  HOF sits in the pipeline). Its complement is the test on litigated patents, where the
  yardstick is what the parties cited, agreement with a party rather than truth
  ([`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md)).
- **Measuring distance from prose.** `--embed-distance "<text>"` ranks the index's mechanism
  rows by cosine to the text under a local embedding model, each row represented by its label
  and member names, and `--embed-distance @<claim file>` does it for every element of a claim
  in one run, with a table of each element's nearest row ([`cli.md`](cli.md));
  `scripts/describe-reach.mjs` scores the same rows against claims whose answers are known.
- **Anchoring claim work.** A mechanism's members are `file@func` references, the grammar
  every claim flag takes ([`CODEEXAM_NOTATION.md`](CODEEXAM_NOTATION.md)), so a mechanism
  found by any of the above is a list of places to open.

## What it adds to an index

Two optional files, both beside the index's own and both going with the directory:
`mechanisms.json`, written by `--build-mechanisms` or the GUI's **Build** button and carrying
the descriptions `--describe` adds; and `embeddings/`, written by `--embed-distance` when it
embeds the rows' labels and names, one cache file per model and text. The on-disk format is
on [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md); what each file holds under a protective
order is in the inventory on
[`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md).

## Limits

- **The four-line floor.** A codebase whose substance is in two-line accessors, or whose
  functions are macros, has mechanisms that miss what a reader would cite. In the fourteen
  public claim charts measured on 2026-11-06, 39 of the 153 functions the litigants cited and
  the index held were in no record for this reason (MakerDAO's `cage` and `frob`, Spark's
  `create` and `map`).
- **A label is a seed's word, not a purpose.** `[file] itbldef.cpp / variation` says which
  file and which shared token, not what the 451 functions do; that is what the description is
  for, and what the purpose approximates when the code carries doc text.
- **Names that say nothing.** Numbered test variations, abbreviations (`stco`, `co64`,
  `sad`), generated code: the grouper groups them correctly and the group's text carries no
  meaning a reader or a model can use.
- **Spread without a shared name.** A mechanism whose parts live in several files and share
  no name token, no class and no command's call closure is not one record; each part is in
  its file's record. A claim that reads across such parts is matched piece by piece, and a
  listing shows no row for the whole.
- **Piece against group.** A function often sits both in a large token group and in a small
  piece of its file. Both are right; which one a search or a reader lands on depends on the
  words used, and the listings do not yet show the piece inside its group.
- **The purpose can be fragments.** A token group's purpose is stitched from comments near
  its members and can read as a run of phrases (`"rotation ICC profile reserved revision
  level vendor sample size…"`); on some C headers the license filter misses wrapped banner
  lines, so a file row quotes banner text where it should quote the header's first sentence.
  A description replaces the quote.

## How well it works

Dated one-line results; the tables are on the linked pages.

- The cover: every function of four lines or more, on every index tried, the demo to Spark
  (2026-11-04 to 11-06); 9 of x264's 376 records fold as the same functions under another
  label, 1,193 of WinAPI's 13,078.
- As a search unit, labels and member names embedded in chunks of eight with a local model
  put the mechanism holding a known function first for 61% of 332 HOF anchors, within 5 for
  86% and within 25 for 96%, pooled over eight indexes (2026-11-05,
  [`describe-reach.md`](describe-reach.md)); for the functions litigants cited in fourteen
  public claim charts, within 5 for 32%, within 25 for 58% and within 60 for 70% of the 114
  in a record (2026-11-06, same page).
- Descriptions as search text: Claude's sentences buy about six points at rank 1 over the
  chunked labels on four small indexes, Gemini's buy nothing; sentences written in a patent
  claim's register do better still on the drafted test claims (79% at rank 1 on x264) but not
  on the litigants' claims, where the labels stay ahead (2026-11-05 to 11-06, same page).

Results about mechanisms themselves that have no page yet (the grouper's cover and split
measurements, the two describers compared as a table of contents, the no-match calibration
of `--embed-distance`, local describe timings) go to `CODEEXAM_MECHANISMS_TESTS.md` when it
is written, not here.
