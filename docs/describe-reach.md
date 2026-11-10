# Does a claim element reach the mechanism entry that holds its anchor, when the entries' descriptions are what is matched?

*A measurement, not a feature. Nothing in CodeExam changes on its account. Issue
[#322](https://github.com/aschulman42-cell/code-exam/issues/322) carries the embedding
history and [#359](https://github.com/aschulman42-cell/code-exam/issues/359) the mechanisms
index as a retrieval unit; the question in Andrew's words (2026-11-05): the semantic route
keeps looking like "the real obvious solution", so where is the untested version of it?*

## The question

Every embedding test before this one ([`embedding-reach.md`](embedding-reach.md); the ladder
on ExoPlayer in #322) put claim text against function bodies or names, the widest register gap
there is: a general prose embedder tied CodeExam's lexical stack at the operating budget, the
code-tuned one did worse, and the best body representation reached about six litigant-cited
names above chance. The mechanisms index ([`cli.md`](cli.md), `--build-mechanisms`) now carries,
per entry, a sentence a model wrote after reading the code (`--describe`): prose, in the
register of "what this does". Matching a claim element against those is prose to prose, over
hundreds of vectors rather than tens of thousands, and every match is two sentences a person
can read. This page asks whether the entry holding a claim's anchor function is within reach
of the claim's elements when that sentence is the text.

**The caveat, first.** The claims here are the HOF pseudo-claims of 2026-11-03
(`scripts/hof.mjs` then; `ce --hof` since 2026-11-09), drafted by Claude from the anchor
functions, and the descriptions were
written by Claude from the same functions: two paraphrases of one reading, which can agree for
reasons that have nothing to do with retrieval. A high number says the unit works, not that it
finds code the drafter did not paraphrase. The non-circular test is the litigants' charts,
phase 2, not run.

## Method

`scripts/describe-reach.mjs`. For one index and one HOF run:

- the **entries** are `mechanisms.json`'s records folded by identical member set
  (`foldRecords`; what a record is and how it was found: [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)), each as its description (an entry with none would fall back to its purpose,
  then its label and member names; none did here); every text is cut at 1,500 characters;
- the **elements** are the claim's limitations as `--claim-locate` splits them
  (`splitClaimElements`);
- the **anchors** are the drafter's grounded `file@func` from the run's
  `claims.txt.anchors.json`; an anchor maps to every entry whose members hold it (one or two,
  since the cover overlaps);
- **reach@k** counts anchors whose best rank, over the claim's elements and the entries holding
  it, is within k (the ladder's union rule), with the median; ranks are conservative, an entry
  tied with others taking the tie's last place. **Strict** counts elements whose top entry holds
  an anchor of the claim: the first thing a reader would open;
- the **embedding** is `nomic-embed-text-v1.5` Q8_0 through node-llama-cpp (the pinned engine
  ships embedding contexts; no network; CPU; a 2,048-token context), `search_document:` on
  entries and `search_query:` on elements, cosine on unit vectors, vectors cached under the run
  directory;
- three comparators on the same unit: **lexical**, BM25 over the same texts with CodeExam's
  claim stemmer, no model, so "the unit works" and "the embedder works" are separate findings;
  **shuffled**, the next run's elements against this run's index and anchors (chance when the
  partner's subject is unrelated, topical overlap when it is not: see AI_Manning below); and
  the **locator**'s own result on the same claims from `hof_report.json`, the anchors it
  located at the function rung and at the file rung or better.
- Since 2026-11-06 (`describe-reach-second-describer`): the label-and-members text is
  embedded in **chunks** of `--chunk` member names (default 8), each led by the label, and an
  entry scores as its best chunk; `--chunk 0` is the one vector per entry the first run used.
  `--fuse` adds a row that fuses the lexical and embedding rankings by reciprocal rank
  (1/(60 + rank), summed; ties to the embedding) with its own shuffled control. `--compare
  a.json,b.json` sets two records of the same runs side by side with no model, the describer
  named from each record's `describedEngine`. The vector cache is written every 500
  embeddings, so a stopped run keeps what it paid for. Since 2026-11-07 the text per entry,
  its chunks, the model registry with each model's prefixes, the cache and the cosine live
  in `src/core/embed.js`, and `--embed-distance` ([`cli.md`](cli.md)) scores an index's
  entries through the same code, so a rank it prints and a rank in these tables are one
  measure.

Runs: the latest 2026-11-03 HOF run of each index described by Claude as of 2026-11-05
(`--all` takes an index when nine records in ten carry a sentence): CodeExam's own index
(`.CE_103126`, 383 entries), Bram (`.Bram_103126`, 695), the bundled demo (`.demo`, 34),
`.AI_Manning_recent` (257) and `.sr_gh` (1,172). Four claims each; 213 anchors in all, 8 of
them in no entry (functions the grouper does not count as candidates). The shuffled partners
run in that order, sr_gh's being CodeExam.

## Results, descriptions as the text (2026-11-05)

### CodeExam's index: 383 entries, 4 claims, 73 anchors

| method | reach@1 | reach@5 | reach@10 | reach@25 | median rank | strict |
|---|---:|---:|---:|---:|---:|---:|
| lexical (BM25 on the descriptions, no model) | 52 (71%) | 63 (86%) | 66 (90%) | 68 (93%) | 1 | 24 of 51 (47%) |
| lexical, shuffled control (Bram's elements) | 0 (0%) | 11 (15%) | 22 (30%) | 30 (41%) | 54 | 0 of 31 (0%) |
| embedding (nomic, descriptions) | 56 (77%) | 59 (81%) | 67 (92%) | 67 (92%) | 1 | 23 of 51 (45%) |
| embedding, shuffled control | 0 (0%) | 9 (12%) | 12 (16%) | 38 (52%) | 24 | 0 of 31 (0%) |
| locator: anchors at the function rung | 29 (40%) | | | | | |
| locator: at the file rung or better | 45 (62%) | | | | | |

### Bram: 695 entries, 4 claims, 32 anchors

| method | reach@1 | reach@5 | reach@10 | reach@25 | median rank | strict |
|---|---:|---:|---:|---:|---:|---:|
| lexical | 13 (41%) | 27 (84%) | 28 (88%) | 29 (91%) | 2 | 5 of 31 (16%) |
| lexical, shuffled control (the demo's elements) | 0 (0%) | 0 (0%) | 9 (28%) | 13 (41%) | 40 | 0 of 33 (0%) |
| embedding | 12 (38%) | 25 (78%) | 25 (78%) | 26 (81%) | 3 | 3 of 31 (10%) |
| embedding, shuffled control | 10 (31%) | 14 (44%) | 14 (44%) | 15 (47%) | 58 | 2 of 33 (6%) |
| locator: function rung | 12 (38%) | | | | | |
| locator: file rung or better | 31 (97%) | | | | | |

### The demo index: 34 entries, 4 claims, 28 anchors (2 in no entry)

| method | reach@1 | reach@5 | reach@10 | reach@25 | median rank | strict |
|---|---:|---:|---:|---:|---:|---:|
| lexical | 26 (93%) | 26 (93%) | 26 (93%) | 26 (93%) | 1 | 11 of 33 (33%) |
| lexical, shuffled control (AI_Manning's elements) | 0 (0%) | 0 (0%) | 0 (0%) | 0 (0%) | 34 | 0 of 29 (0%) |
| embedding | 26 (93%) | 26 (93%) | 26 (93%) | 26 (93%) | 1 | 11 of 33 (33%) |
| embedding, shuffled control | 0 (0%) | 8 (29%) | 25 (89%) | 26 (93%) | 6 | 0 of 29 (0%) |
| locator: function rung | 14 (50%) | | | | | |
| locator: file rung or better | 26 (93%) | | | | | |

### AI_Manning_recent: 257 entries, 4 claims, 39 anchors (2 in no entry)

| method | reach@1 | reach@5 | reach@10 | reach@25 | median rank | strict |
|---|---:|---:|---:|---:|---:|---:|
| lexical | 37 (95%) | 37 (95%) | 37 (95%) | 37 (95%) | 1 | 14 of 29 (48%) |
| lexical, shuffled control (sr_gh's elements) | 18 (46%) | 23 (59%) | 23 (59%) | 25 (64%) | 2 | 2 of 35 (6%) |
| embedding | 37 (95%) | 37 (95%) | 37 (95%) | 37 (95%) | 1 | 10 of 29 (34%) |
| embedding, shuffled control | 0 (0%) | 0 (0%) | 1 (3%) | 21 (54%) | 24 | 0 of 35 (0%) |
| locator: function rung | 24 (62%) | | | | | |
| locator: file rung or better | 39 (100%) | | | | | |

### sr_gh: 1,172 entries, 4 claims, 41 anchors (4 in no entry)

| method | reach@1 | reach@5 | reach@10 | reach@25 | median rank | strict |
|---|---:|---:|---:|---:|---:|---:|
| lexical | 22 (54%) | 27 (66%) | 36 (88%) | 36 (88%) | 1 | 3 of 35 (9%) |
| lexical, shuffled control (CodeExam's elements) | 3 (7%) | 3 (7%) | 3 (7%) | 3 (7%) | 31 | 1 of 51 (2%) |
| embedding | 30 (73%) | 37 (90%) | 37 (90%) | 37 (90%) | 1 | 11 of 35 (31%) |
| embedding, shuffled control | 3 (7%) | 4 (10%) | 4 (10%) | 26 (63%) | 25 | 1 of 51 (2%) |
| locator: function rung | 25 (61%) | | | | | |
| locator: file rung or better | 41 (100%) | | | | | |

### Pooled, 5 runs, 213 anchors

| text matched | method | reach@1 | reach@5 | reach@10 | reach@25 | strict |
|---|---|---:|---:|---:|---:|---:|
| descriptions | lexical | 150 (70%) | 180 (85%) | 193 (91%) | 196 (92%) | 57 of 179 (32%) |
| descriptions | lexical, shuffled | 21 (10%) | 37 (17%) | 57 (27%) | 71 (33%) | 3 (2%) |
| descriptions | embedding | 161 (76%) | 184 (86%) | 192 (90%) | 193 (91%) | 58 of 179 (32%) |
| descriptions | embedding, shuffled | 13 (6%) | 35 (16%) | 56 (26%) | 126 (59%) | 3 (2%) |
| label and member names | lexical | 118 (55%) | 170 (80%) | 189 (89%) | 199 (93%) | 41 of 179 (23%) |
| label and member names | lexical, shuffled | 9 (4%) | 36 (17%) | 56 (26%) | 83 (39%) | 5 (3%) |
| label and member names | embedding | 151 (71%) | 189 (89%) | 193 (91%) | 197 (92%) | 59 of 179 (33%) |
| label and member names | embedding, shuffled | 13 (6%) | 66 (31%) | 92 (43%) | 163 (77%) | 13 (7%) |
| | locator: function rung | 104 (49%) | | | | |
| | locator: file rung or better | 182 (85%) | | | | |

The second block is the no-model text: the entry's label and its member names split to words
(`[class] Ledger: Ledger post entry, Ledger settle`), the text every index has before any
describe run. It is what the descriptions are measured against. Per index, reach at rank 1 on
that text, lexical then embedding: CodeExam 77% and 86%, Bram 31% and 47%, the demo 71% and
68%, AI_Manning 26% and 69%, sr_gh 54% and 66%.

## Reading

- **The unit works, and it works without a model.** With the descriptions as the text, BM25
  alone puts the anchor's entry first for 70% of anchors and within 25 for 92%, against 10% and
  33% for the shuffled control, and against the locator's 49% at the function rung on the same
  claims. The embedder is six points better at rank 1 and even by rank 25; strict is 32% for
  both. On four of the five indexes the two are the same finding.
- **What the descriptions add** is at the top of the list. Over the labels and member names,
  lexical reach at rank 1 goes from 55% to 70% and strict from 23% to 32%, with the largest
  gains where identifiers say least (AI_Manning 26% to 95%, Bram 31% to 41%); the embedder,
  which already reads identifiers as words, gains five points at rank 1 and nothing on strict.
  By rank 25 the texts are even. A description earns its place as the first match, not as the
  only way to be in the window.
- **sr_gh is where the embedder pulls ahead**: 73% against 54% at rank 1, strict 31% against
  9%. The corpus holds several copies of verl, so many entries have near-identical sentences,
  and the conservative tie rule costs word overlap more than it costs cosine. That is also the
  index whose pool is largest, 1,172 entries.
- **Bram is the weak index, and the strict column says why.** The embedding's strict is 10%
  against 6% for its own control, where lexical's is 16% against 0%; per claim the embedding
  reaches 10 of 15 anchors on the `guard_policy.rs` claim and 0 of 6 on the worklist claim
  that lexical reaches 6 of 6. The control's 10 anchors at rank 1 are one giant entry,
  `[file] guard_policy.rs / other`, holding nine of its claim's anchors and sitting near one
  foreign element. Anchors are not independent: a giant entry is reached or missed as one,
  which is why strict is the column to read with reach. Bram's descriptions are also the ones
  most often opening "These functions…" (376 of 723,
  `mechanisms-descriptions-name-the-subject`); whether that is the cause is not measured.
- **The shuffled control measures what its partner shares.** AI_Manning's lexical control
  reaches 46% at rank 1 with sr_gh's elements, where it reached 0% with CodeExam's: both are
  machine-learning code, and sentences about models and training match claims about models and
  training whichever repository they came from. The description grain separates unrelated
  corpora cleanly and a domain from itself less so; a related control is the harder and more
  honest one, and the embedding's control on the same pairing stays at 0%.
- **Chance at depth is high on a small pool.** A run's shuffled control reaches a third of the
  anchors by rank 10 on a 257-entry pool, because four claims' worth of elements, nine or so
  each, each take ten entries. Reach at 1 and strict are the discriminating columns; reach at
  25 says the window would hold the entry, which on these pools it nearly always would.
- **An example**, CodeExam's claim on `--interactive`: the preamble's nearest entries are
  `[file] rank-eval.mjs`, then **`[cmd] --interactive`**, then `[file] index-manager.js`; the
  second element's top entry is the anchor's.

What this does and does not say. The claims restate the functions' identifiers and the
descriptions restate the functions, so a lexical match on a description is partly a match on
shared identifiers; the label-and-members block shows that is not all of it. A positive result
here licenses phase 2, the litigants' charts on the agreement harness's small indexes once
described, and nothing more. Against that yardstick CodeExam's name search reached 10 of 44
cited names within 25 and UniXcoder's bodies 17 against 11 by chance
([`embedding-reach.md`](embedding-reach.md)); the description grain has not met it yet. *(It
has since, without a description: on 2026-11-06 the label-and-members text, chunked, put the
entry holding a litigant's cited function within 25 for 58% of 114 names over all fourteen
filings; the section "Phase 2" below.)*

## A second describer (2026-11-05)

The same prompt, Gemini (`--describe --redescribe --llm gemini`) rewriting the sentences of
CodeExam, Bram, the demo and AI_Manning; the Claude files kept; the same claims and anchors;
`--compare` on the two records. Reach at rank 1 and 25 and strict, Claude's sentences then
Gemini's:

| index (anchors) | lexical @1 | embedding @1 | lexical @25 | embedding @25 |
|---|---|---|---|---|
| CodeExam (73) | 71% → 79% | 77% → 84% | 93% → 90% | 92% → 96% |
| Bram (32) | 41% → 31% | 38% → 9% | 91% → 53% | 81% → 53% |
| demo (28) | 93% → 79% | 93% → 61% | 93% → 93% | 93% → 93% |
| AI_Manning (39) | 95% → 23% | 95% → 54% | 95% → 67% | 95% → 95% |
| pooled 4 (172) | 74% → 58% | 76% → 59% | 93% → 78% | 91% → 87% |

The label-and-members rows are identical under both records (56% and 72% at rank 1 pooled),
as they must be: the control that the pool did not move. What differs is the sentence. Gemini's
run about 20 words to Claude's 27, open anaphorically ("This file…", "These functions…")
83 to 97% of the time against 17 to 51%, and name an identifier in 13 to 38% of sentences
against 55 to 75%. Two kinds of loss: on AI_Manning, the 16-anchor `ch5` entry slipped from
rank 1 to 2 behind a sibling piece of the same file whose Gemini sentence reads the claim's
preamble better (a file-rung hit, 16 anchors, one rank); and the 11-anchor `ch11` entry went
from rank 1 to 114 under BM25 while the embedding held it at 1, because the claim's vocabulary
is the function names (`append_result`, `_dedup_key`), which Claude's sentence echoed and
Gemini's read a level up. So the 69-point lexical gain on AI_Manning under Claude was mostly
shared vocabulary of claim and sentence, both built from the same names; what survives a
change of describer is the embedding on the labels. Pooled over four, Gemini's sentences with
the embedding (59%) sit below the labels with the embedding (72%) by either method.

## Chunked labels, eight indexes (2026-11-05)

The first run's label-and-members row carried a defect the five indexes were too small to
show: one vector per entry, cut at 1,500 characters. On x264 and ffmpeg an entry of fifty or
more functions had a median rank of 366 of 367 and 5,274 of 5,844 for every element: the
58-function `mips/pixel-c.c` piece holding 16 of one claim's anchors sat at rank 365 with a
cosine of 0.41 against its own claim where the collection's median is 0.56, its text sixteen
near-identical names ("x264 pixel sad 16x16 msa, x264 pixel sad 16x8 msa, …") and two
5-function pieces of the same file winning at 0.76. Not the cut: every anchor name survived
it. On WinAPI the cut did bite, a 450-function entry keeping its first 150 names. Embedding
the member list in chunks of 8, each led by the label, and scoring the entry by its best
chunk removes both. Reach at 1 / 5 / 25 of the anchor's entry, no describer:

| index (anchors) | entries | one vector | best chunk of 8 | locator fn rung | file or better |
|---|---:|---|---|---:|---:|
| CodeExam (73) | 383 | 86 / 89 / 93 | 86 / 90 / 93 | 40 | 62 |
| Bram (32) | 695 | 47 / 75 / 91 | 47 / 78 / 91 | 38 | 97 |
| demo (28) | 34 | 68 / 93 / 93 | 68 / 93 / 93 | 50 | 93 |
| AI_Manning (39) | 257 | 69 / 95 / 95 | 69 / 95 / 95 | 62 | 100 |
| x264 (29) | 367 | 21 / 21 / 31 | 21 / 100 / 100 | 28 | 83 |
| ffmpeg (19) | 5,844 | 11 / 11 / 16 | 11 / 58 / 100 | 16 | 89 |
| WinAPI_Classic (73) | 11,885 | 16 / 29 / 85 | 81 / 84 / 99 | errored | errored |
| Spinellis (39) | 16,526 | 28 / 54 / 90 | 28 / 74 / 100 | 3 | 26 |
| pooled 8 (332) | | 47 / 61 / 81 | **61 / 86 / 96** | | |
| pooled 7, locator valid (259) | | 55 / 65 / 80 | 55 / 86 / 95 | 35 | 74 |

Best chunk is never below the whole text at any depth on any index. WinAPI is the largest
move and a different one from x264's: the 451-function entry holding 40 anchors is the right
grain, the drafter wrote the claim from it, and its best chunk is rank 1 where the whole text
was 13. (WinAPI's locator run errored on every claim; its row is not a baseline.) What stays at
rank 1 is piece-versus-group, where the anchors sit both in a 400-function group and in a
small piece of their file and whichever the claim's words favour takes rank 1, and on C with
abbreviated names (`sad`, `satd`, `chpl`, `stco`), vocabulary. With this row corrected, the
first run's reading of what descriptions add is revised: over the four small indexes Claude's
sentences buy about six points at rank 1 over the chunked labels (an all-four fusion of labels
and descriptions, lexical and embedded, 83% against the labels' lexical-plus-embedding fusion
at 77%), concentrated in one 7-anchor demo entry; Gemini's buy nothing. Labels and
description as one text never beat the best of their parts; fusing the two embeddings does.

Fusion with BM25 is index-dependent, which is why `--fuse` is a flag: pooled over the four
small indexes it is the best row at rank 1 (77% against 72% for the embedding alone), on x264
and ffmpeg it pulls the best chunk down (within 5, 100% to 76% and 58% to 26%) because BM25's
rank is noise on abbreviated C names. Two code-trained embedders at nomic's size,
CodeRankEmbed and jina-embeddings-v2-base-code, traded rather than won on six indexes (65% and
67% at rank 1 pooled against nomic's 60%, with nomic's recall within 5 and 25 the best of the
three, and none closing the C vocabulary gap); fusing nomic with jina per element is worth
eight points at rank 1 and keeps the recall.

## Retrieve, then choose (2026-11-06)

What the retrieval does not give is a committed pick: four aggregators over the per-element
rankings (rank sum, one vote per element, best element, margin-weighted votes) all left the
claim's single top entry holding an anchor for 34 to 41% of claims, because a claim's anchors
are spread over several entries. A second stage does: each element's top 5 entries pooled
(up to 25 per claim), one Sonnet call per claim reading only labels and names, choosing one
entry per element and one for the claim. Eight HOF indexes, 32 claims, 332 anchors, $0.47:

| unit | retrieval's rank 1 | the model's pick | ceiling (entry among candidates) | locator |
|---|---:|---:|---:|---:|
| per element: the pick holds an anchor | 30% | 67% | | |
| per anchor: some element's pick is its entry | 61% | 84% | 85% | 35% (function rung) |
| per claim: the one pick holds an anchor | 13 of 32 | 26 of 32 | | |
| per claim: anchors in the one pick | 27% | 71% | | |

The chooser recovers nearly everything the list offers it; x264 goes from 21% of anchors
reached to 100%, the model reading `sad` and `satd` where the embedding could not. Top 10
instead of 5 raised the ceiling five points and the chooser gave three back, more sibling
pieces of one file to choose among. The prompt is 5 to 23k characters of labels, so the same
stage fits a local model.

## Phase 2, the litigants' charts (2026-11-06)

The agreement harness's fourteen filings ([`claim-chart-agreement.md`](claim-chart-agreement.md)),
seventeen filing-repository pairs, `--build-mechanisms` on each index with no model (all
sixteen in under three minutes together, Spark's 16,677 records included); the asserted
claim's elements against the chunked label-and-members text; a cited function's reach is the
best rank, over elements, of any entry holding a member of that name, the harness's own
matching rule; units as [`embedding-reach.md`](embedding-reach.md). A hit is agreement with a
party, not correctness.

| method | within 5 | within 25 | within 60 | median rank |
|---|---:|---:|---:|---:|
| BM25 on the labels | 12% | 24% | 33% | last |
| embedding, one vector | 26% | 54% | 68% | 23 |
| embedding, best chunk of 8 | **32%** | **58%** | **70%** | 15 |
| `--claim-locate` tier 1, committed picks | 17% of cited names chosen (26 of 153) | | | |

Over the 114 cited names in some mechanism record; on the harness's denominator of 153 names
present in the index, 24 / 43 / 52%. The difference is a limit of the grain: the builder keeps
functions of four lines or more, so 39 of the litigants' names are in no record at all,
MakerDAO's `cage`, `frob`, `yank` (11 of its 13), Spark's `create`, `map`, `equals` (18 of 47),
PROGME's 68 `println`-style names, Veritaseum's 24. Where the litigant cites a two-line
accessor, the entry grain has nothing to find and the locator's function rung is the only arm
that can; where the citation is a function of substance, the entry is in a short list with no
model call, ahead of the locator's picks on either denominator. On the seven bitcoin and
dstoken filings alone (56 names) the row is 41 / 70 / 88 with a median of 6, four of the seven
with every reachable name within 60. The CodeBERT page's pooled figure at the symbol grain was
1 of 70 within 25. The chooser does not beat the locator on these claims (16% of cited
functions as a committed pick, ceiling 36%): the claims have 3 to 9 elements and the litigants
cite chains of 7 to 14 functions across many entries, so one pick per element cannot reach
them, and the elements are legal language against bare C names. The product unit for a
litigant's claim is the short list.

ExoPlayer '101, the fixture of 20 believed-implementer symbols
(`test/fixtures/retrieval-reachability-8752101-exoplayer3.json`), 10,828 entries: the chunked
labels put 7 of 19 within 60 and 4 of the 7 symbols two independent sources named, where CE's
own retrieval stack reaches 3 of 20 and none of the 7, and the encoders none within 60. The
load-control family (LoadControl, DefaultLoadControl, shouldStartPlayback) is at rank 4; the
buffering substrate (SampleQueue, SimpleCache, DefaultAllocator, ChunkSampleStream) at 246 to
2,302; `AdaptiveTrackSelection::determineIdealSelectedIndex` and `updateSelectedTrack` at
2,465 and 1,418, closest on element 6, the code-rate element.

## Register, not breadth (2026-11-06)

Why the embedding does not carry "code rate" to "bitrate", when it knows the words (cosine of
"code rate" with "bit rate" 0.76): substituting the word in the crux phrase moves the
element-to-entry score by 0.016. The gap is register. Element 6 against all 10,828 ExoPlayer
entries, rank of the AdaptiveTrackSelection class entry:

| query | register | rank |
|---|---|---:|
| the whole element, 62 words | claim | 2,465 |
| "determining the code rate based on a remaining time before reproduction start" | claim, the crux as written | 1,213 |
| "code rate determine time reproduction available" | the locator's pinned words | 1,004 |
| "selecting one of a plurality of bitrates based on an amount of buffered media" | an attorney's paraphrase of the engineer's | 60 |
| "select the track bitrate from the bandwidth estimate and the buffered duration" | engineer, specific | **2** |
| "adaptive bitrate selection" | engineer, three words | **2** |

On the entry side, one sentence for the same mechanism against the whole element: the names
as they are 0.61 (rank 2,465); a neutral sentence of the kind both describers wrote 0.63
(rank 763); the engineer's sentence 0.68 (rank 15); a sentence in the claim's register that
still distinguishes the entry, "a code rate determining unit that determines the code rate of
the content data based on a remaining reproduction time of the stored content", 0.84 (rank 1);
a too-broad one, "a unit that determines a parameter of the content based on a time", 0.72,
rank 1 for every timing claim in the corpus. x264 described with the shipped prompt confirms
the middle: good neutral sentences ("MIPS MSA implementations of x264 pixel metric functions,
SAD, SATD, SSD…") reach rank 1 for no anchor and sit below the chunked labels at every depth,
because the sibling pieces of the same file got the same sentence in near-identical words.

So the embedding does its work within a register and does not cross registers, which is the
September finding on #315 ("ordinary against technical, not broader against narrower") from
the other side, and the inversion stated there holds: the '101 dependents whose words are the
engineer's (when playback may start, claims 8 to 10) put the LoadControl family at rank 1 or
2, the code-rate dependents (claims 2 to 4) stay in the claim's register and move
AdaptiveTrackSelection only to 394 to 1,097. Two ladders follow. Query side, the cheap one:
one Sonnet call per element, given the element and the codebase's eighty most frequent name
words and nothing else, rewriting it in the engineer's register twice (specific, broad); the
fixture symbols within 25 go from 5 to 10 of 19, the median from 122 to 8, the independent
seven within 25 from 3 to 5, AdaptiveTrackSelection on element 6 from 2,465 to 100; two cents.
(`--synonymize` is the opposite direction, HOF-b, rewriting the claim away from code
vocabulary.) Entry side, once per entry for every future claim: a describer prompt that writes
the claim-register sentence and the engineer's sentence, three vectors per entry scored by the
best; the sweet spot is as claim-register as possible while still separating the entry from
its neighbours, and "separating" is the margin of the sentence's vector to the other entries',
measurable with no model. What does not work is the neutral middle, which is what the shipped
prompt produces. The entry-side ladder was then run blind over all of x264, one Sonnet call
per entry from the shipped describe pack writing an engineer's sentence and a claim-register
sentence with no sight of any claim ($1.94): on x264's four HOF claims the claim-register
sentence, embedded, puts the anchor's entry first for 79% of anchors (median rank 1), against
21% for the chunked labels, 0% for the shipped prompt's sentence, 24% for the engineer's and
the locator's 28%; BM25 on the same sentences reaches 59%. Its strict falls to 10% from the
labels' 23%, sentences in one register sitting closer to each other, which is the too-broad
side of the sweet spot as a number; fusing the labels with the claim sentence by rank keeps
76% at rank 1 and lifts strict to 20%, where taking the better of the two sentences' raw
cosines gives the engineer's row, so the combination is by rank, not by score. The caveat is
strongest here: the HOF claims and these sentences are Claude's, both in the claim register,
from the same functions; the honest test is a litigant's claim against claim-register
sentences for its index, not run.

Caveats carried: the HOF claims were drafted from the anchors by the same family that chose
among the candidates; litigant hits are agreement; the ExoPlayer register tables are one
element, with the entry-side sentences written by hand knowing the answer; the query-side
rewrites were blind.

## Runtime and artifacts

CPU on the Surface, `nomic-embed-text-v1.5` Q8_0: 383 entries in 44 s, 695 in 82 s, 257 in 31 s,
34 in 4 s, 1,172 in 121 s, about eight to ten texts a second; a run's 60 to 90 elements in 5 to
7 s. Vectors are cached per run under `<run>/describe-reach/` keyed by the text's hash, so a
re-described file re-embeds only what changed; the cache is an artifact of the index
([`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md), #361). Since
2026-11-06 the cache is also written every 500 embeddings: WinAPI's 11,885 entries took 15,766 s
and Spinellis's 16,526 took 12,949 s on the CPU with other jobs running, and a stop used to
lose the run; chunks reuse every whole-text vector already cached, so a rerun with `--chunk`
embeds the chunks only. The rendered tables and the JSON records of the runs are in Andrew's
scratch directory beside the mechanisms measurements; the chooser, the recap and the
embedder-comparison harnesses that produced the 2026-11-06 sections are there too, beside the
records, and not yet in the repo.

## Not run

- The `purpose` and `description+purpose` texts.
- A local describer, synonymizer and chooser (Gemma 4 on asus-CC), the air-gapped question,
  phase 3: the chooser and the synonymizer first, since both run on the cached candidates
  with only the model swapped.
- The two-register describer blind over a whole index, and the claim-register sentence's
  margin to its neighbours as the test of the sweet spot.
- The litigant claims through a chooser allowed a chain of entries per element.
- Qwen3-Embedding; the Sonos pairing the ExoPlayer fixture names as its second.
- WinAPI_Classic under a description: 735 of 13,078 records described under a `device`
  filter, below the nine-in-ten rule; its labels row is in the chunked table above.
