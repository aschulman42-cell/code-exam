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
(`scripts/hof.mjs`), drafted by Claude from the anchor functions, and the descriptions were
written by Claude from the same functions: two paraphrases of one reading, which can agree for
reasons that have nothing to do with retrieval. A high number says the unit works, not that it
finds code the drafter did not paraphrase. The non-circular test is the litigants' charts,
phase 2, not run.

## Method

`scripts/describe-reach.mjs`. For one index and one HOF run:

- the **entries** are `mechanisms.json`'s records folded by identical member set
  (`foldRecords`), each as its description (an entry with none would fall back to its purpose,
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
([`embedding-reach.md`](embedding-reach.md)); the description grain has not met it yet.

## Runtime and artifacts

CPU on the Surface, `nomic-embed-text-v1.5` Q8_0: 383 entries in 44 s, 695 in 82 s, 257 in 31 s,
34 in 4 s, 1,172 in 121 s, about eight to ten texts a second; a run's 60 to 90 elements in 5 to
7 s. Vectors are cached per run under `<run>/describe-reach/` keyed by the text's hash, so a
re-described file re-embeds only what changed; the cache is an artifact of the index
([`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md), #361). The rendered
tables and the JSON records of the runs are in Andrew's scratch directory beside the
mechanisms measurements.

## Not run

- The `purpose` and `description+purpose` texts.
- A second describer. The same indexes rewritten by Gemini (`--describe --redescribe --llm
  gemini`, the Claude files kept) would say how much of the lexical result is Claude's wording;
  a local describer (Gemma 4 on asus-CC) is the air-gapped question, phase 3.
- Phase 2, the agreement harness's indexes, none of which is described.
- A second embedder (jina-code, for the complementarity the ladder found) and rank fusion with
  the lexical arm.
- WinAPI_Classic, 735 of 13,078 records described under a `device` filter: below the nine-in-ten
  rule, and its HOF run located nothing (the test gate, #359).
