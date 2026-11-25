# Concepts: the words a codebase seems to be about

CodeExam reads the names in a codebase and lists a few dozen words that seem to be what
the code is about: `multisect`, `callees` and `claim` for CodeExam's own code; `worklist`,
`pane` and `drift` for Bram; `playback`, `media` and `looper` for ExoPlayer. It calls these
**concepts**. No language model is used, so the same index gives the same list every time.

A concept is a suggestion of what to look for, not a finding. This page says how the list
is made, what it is good for, and how often it is right, with figures. The short version of
the figures: on 19 public codebases, about one in five of the first twelve concepts is a
word the codebase's own authors used in a heading of their documentation, and most of the
words those authors did use are in the code and are not among the concepts. The list is a
useful first look. It is not a list of everything that matters.

## Contents

<!-- contents:start -->
- [1. Where you see concepts](#1-where-you-see-concepts)
- [2. What a concept is, and three uses of the word](#2-what-a-concept-is-and-three-uses-of-the-word)
- [3. How CodeExam finds them](#3-how-codeexam-finds-them)
- [4. Concepts and vocabulary](#4-concepts-and-vocabulary)
- [5. What concepts are for](#5-what-concepts-are-for)
- [6. How accurate they are](#6-how-accurate-they-are)
- [7. Too much and too little: the balance](#7-too-much-and-too-little-the-balance)
- [8. Where "Potentially important files" comes from](#8-where-potentially-important-files-comes-from)
- [9. Known defects](#9-known-defects)
- [10. Where a concept's mechanisms sit](#10-where-a-concepts-mechanisms-sit)
<!-- contents:end -->

## 1. Where you see concepts

| where | what it shows |
|---|---|
| `ce --index-path <index> --concepts` | the concepts on their own, 30 by default, each with an example name, up to three files, and the number of mechanisms named for it |
| `ce --index-path <index> --concepts <word>` | one concept in full: its files and its mechanisms |
| `ce --index-path <index> --overview` | the first twelve, under "Potentially important concepts (with examples)" |
| the GUI's **Concepts** list, under Overview | the rows of `--concepts`; a click on a row shows its example, its files and its mechanisms in the upper middle pane, and a click on one of those opens it in the lower ([`CODEEXAM_GUI.md`](CODEEXAM_GUI.md)) |
| elsewhere in the GUI | the first twelve in the Overview, and as a caption at the top of the Vocabulary list |
| the MCP `overview` tool | the same twelve, as text |
| the MCP `concepts` tool | the rows of `--concepts`, for a chat or an agent; `concept` shows one in full ([`CODEEXAM_MCP.md`](CODEEXAM_MCP.md)) |

A row of `--concepts` on CodeExam's own index:

```
   1. multisect (parseMultisectTerms): files: public/app.js, src/commands/interactive.js, src/commands/analyze.js  (14)
   3. claim (splitClaimElements)  (85)
  43. deliberately: files: src/version.js, src/core/ai-overview-local.js, src/commands/claim-locate.js  (0)
```

- The word in brackets is an **example**: a longer name the concept is a piece of. A concept
  that only ever stands as a whole word has none.
- **Files** are listed only where the concept is itself one of the codebase's top
  vocabulary terms (section 8).
- The number at the end is how many **mechanisms** are named for the concept: the
  mechanism's label, or the name of one of its functions, carries the word. Test code is
  left out unless `--include-tests` is given. `(0)` means the word is in the code's text
  and in no function's name, as `deliberately` is: a word from comments.

- With `--carve calls` added, a square bracket before that number says **where those
  mechanisms sit** in the carved listing: `[3.3: 43%]` is sub-section 3.3 of `--carve calls`
  holding 43% of them; `[spread]` means no section holds them better than a random pick
  would ([section 10](#10-where-a-concepts-mechanisms-sit)). It is slower, so it is not
  done unless asked for.

`--concepts` ends with the commands that follow a concept into the code (`--mechanisms
<word>`, `--toc <word>`, `--carve`, `--search <word>`). The options are in
[`cli.md`](cli.md).

## 2. What a concept is, and three uses of the word

Here a concept is **one piece of a name**. `parseWorklistEntry` has three pieces: `parse`,
`worklist` and `entry`. CodeExam scores every piece of the codebase's 500 highest-ranked
names and lists the pieces by score. `worklist` scores high in Bram because many
high-ranked names carry it and few other codebases use the word.

So a concept is always a single word, and always a word the code itself writes. "Track
selection" is not a concept; `track` and `selection` may each be one. A codebase that does
something without naming it has no concept for it.

The word is used in three places in CodeExam, for the same list read three ways:

- **The Overview's list** and `--concepts`: the list shown to a reader.
- **`--pseudo-claims --candidates --group-by concept`**: candidate groups of functions,
  one group per concept, for drafting pseudo-claims
  ([`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md)).
- **`--build-mechanisms`**: the first 24 concepts are among the seeds the mechanisms are
  grown from ([`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)). A change to the
  concepts therefore changes what a later mechanisms build produces.

## 3. How CodeExam finds them

Two steps. The first builds the **vocabulary**; the second takes the concepts from its top.

**Step 1: the vocabulary.** Every name-like token in the indexed files is counted
(`[A-Za-z_]` then letters, digits and `_`), in code, in comments and in strings. Comments
and strings are counted on purpose: a codebase often says what it is about in a docstring
or an error message and nowhere else.

Left out before counting:

- documentation and text files (`.md`, `.txt`, `.rst`, `.yaml`, `.yml`) and `.xml`;
- vendored and generated code (`node_modules`, `vendor`, `dist`, `build`), lockfiles,
  minified bundles, decompiled dumps;
- test, example and fixture directories;
- the copyright and licence lines at the head of a file;
- runs of 200 or more base64 characters, which are embedded images and the like;
- language keywords, a list of programming words common to all code (`printf`, `size_t`),
  tokens under three letters, and all-capitals constants of four letters or more.

A token must then be in at least two files, and in no more than about 60% of them: a word
in nearly every file says nothing about any one part. Each token that remains gets a score:

> files it is in × how rare it is across the files × a bonus for length × a bonus for being
> a compound name × a weight for how rare it is across other codebases

The last weight comes from a catalog that ships with CodeExam: for each word, how many of
28 indexed codebases use it. A word found in most of them (`function`, `handle`, `index`)
is marked down. A word found in one or two is not.

Tokens that look like random strings (keys, ids, hashes) are withheld when the list is
read out, so that a secret cannot be printed as an example.

**Step 2: the concepts.** The 500 highest-scored tokens (200 until 2026-11-24; section 6
says why it changed) are split into their pieces at each change of case and each `_`. A piece is dropped if it is on a list of words too
common to tell code apart, or if 60% or more of the catalog's codebases use it. Each piece
that remains is given the sum of the scores of the tokens it came from, each multiplied by
the piece's own rarity across codebases. The pieces are listed by that sum.

The example shown with a concept is the highest-scored longer token it came from,
preferring one that is the name of a function, so that the example can be opened.

The code is `extractConcepts` and `_buildVocabularyFromDocs` in `src/core/vocabulary.js`.

## 4. Concepts and vocabulary

| | vocabulary | concepts |
|---|---|---|
| what a row is | a whole name as written: `parseWorklistEntry` | a piece of names: `worklist` |
| how many | thousands; `--vocabulary 50` shows the top 50 | 100 to 450 on most codebases, drawn from the top 500 names only |
| what it answers | which exact names are distinctive here | which words keep turning up in the distinctive names |
| where | `--vocabulary`, the GUI's Vocabulary list, the MCP `vocabulary` tool | section 1 |

Two consequences of the concepts being drawn from the top 500 names only:

- A word spread thinly over many names, none of them among those 500, is not a concept
  even when the code is full of it (section 6 has examples).
- `--vocabulary <word>` and `--search <word>` still find such a word. The concepts are a
  short list, and what is missing from it has not been ruled out.

## 5. What concepts are for

- **A first look at a codebase you do not know.** Twelve words in the Overview, a few
  dozen from `--concepts`.
- **Something to look for in the list of mechanisms.** A contents page of several hundred
  mechanisms (`--toc`, `--mechanisms`, `--carve`) is too long to read from the top. The
  concepts are a list of words worth looking for in it, and the number at the end of each
  row says how many mechanisms carry the word. `--mechanisms worklist` then lists those.
- **Something to look for among pseudo-claims**, the same way.
- **Words to search and filter by**: `--search`, `--toc <word>`, the pseudo-claims
  `--filter`.

They are not a way to decide that a codebase does *not* contain something. A subject can
be in the code under a name the list does not carry.

## 6. How accurate they are

Measured 2026-11-24 with `scripts/concepts-recall.mjs`, twice: with the concepts drawn from
the top 200 names, as they were until that day, and from the top 500, as they are now. The
measurement is why the number changed.

**The question.** Take words known to matter in a codebase. How many of them are among
its concepts?

**Where the words came from.** The headings of each codebase's own README and docs files.
Their authors chose them, without CodeExam. They are also independent of the concepts in
a second way: README and docs files are left out when the vocabulary is built (section 3),
so a heading word is a concept only if the code itself carries it.

**The rules**, fixed before any result was looked at:

- A documentation file is `README.md`, `README.txt` or `README.rst`, or a `.md` or `.rst`
  file under a `doc`, `docs` or `documentation` directory, outside vendored, test and
  example directories.
- A heading is a Markdown `#` line or an underlined line, outside code blocks.
- A term is a word of a heading, split into pieces as concepts are, three letters or more,
  with 293 words taken out: English function words, and words of documentation headings
  in general (`installation`, `usage`, `license`, `overview`; the list is
  `GENERIC_HEADING_WORDS` in the script).
- A term and a concept are the same word when they are equal, or when one begins the other
  and the shorter is five letters or more (`faithful` and `faithfulness`).

One rule was changed after the first run, and only to keep the independence above: the
first form also read a `README` with no extension and `.markdown` files, which the
vocabulary does count. It moved the figures by one file on one codebase.

**The figures.** 26 public codebases were tried. Six hold no documentation of this kind in
their index and one holds three terms; the 19 with ten or more terms are below.

| codebase (index) | files | headings | terms | concepts | of the first 12 concepts, how many are a heading term | of the first 24 | of the first 50 | terms found anywhere among the concepts | terms in the vocabulary at all |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| CodeExam itself | 265 | 782 | 942 | 243 | 10 | 17 | 38 | 115 (12%) | 90% |
| AutoGen | 1,417 | 320 | 287 | 156 | 6 | 12 | 20 | 34 (12%) | 94% |
| safety-research repositories (`.sr_gh`) | 1,490 | 751 | 615 | 269 | 6 | 13 | 21 | 106 (17%) | 92% |
| CrewAI | 1,812 | 751 | 349 | 177 | 5 | 13 | 26 | 58 (17%) | 93% |
| Bram | 39 | 74 | 106 | 370 | 4 | 7 | 10 | 27 (25%) | 66% |
| ExoPlayer 3 | 3,578 | 191 | 106 | 159 | 3 | 6 | 9 | 19 (18%) | 87% |
| llama.cpp | 2,801 | 886 | 683 | 226 | 3 | 5 | 9 | 46 (7%) | 72% |
| Codex | 2,161 | 1,186 | 432 | 218 | 3 | 8 | 14 | 37 (9%) | 80% |
| Anthropic repositories | 2,238 | 342 | 272 | 103 | 3 | 4 | 5 | 10 (4%) | 80% |
| the bundled demo | 19 | 8 | 16 | 162 | 1 | 2 | 2 | 4 (25%) | 56% |
| React (19 files) | 19 | 11 | 11 | 160 | 1 | 1 | 1 | 1 (9%) | 55% |
| node-llama-cpp | 930 | 41 | 24 | 145 | 1 | 2 | 2 | 3 (13%) | 54% |
| Qwen repositories | 89 | 101 | 68 | 302 | 1 | 3 | 3 | 10 (15%) | 51% |
| Reflexion | 134 | 14 | 25 | 260 | 1 | 1 | 2 | 2 (8%) | 56% |
| "Crack any codebase" | 82 | 29 | 36 | 134 | 1 | 2 | 5 | 7 (19%) | 42% |
| DeepSeek | 39 | 60 | 49 | 240 | 0 | 3 | 3 | 7 (14%) | 49% |
| zlib | 175 | 11 | 10 | 243 | 0 | 0 | 0 | 1 (10%) | 30% |
| Tree of Thought | 38 | 7 | 10 | 456 | 0 | 0 | 0 | 1 (10%) | 60% |
| Dive into Deep Learning | 325 | 5 | 12 | 894 | 0 | 0 | 0 | 0 (0%) | 75% |
| **all 19 together** | | | **4,053** | | **49 of 228 (21%)** | **99 of 456 (22%)** | **170 of 950 (18%)** | **488 (12%)** | **83%** |

The table is with the concepts drawn from the top 500 names. For CodeExam itself the
documentation was read from the repository, since its index does not hold it, and it
includes this page. Counting only the terms that are in two or more headings (12
codebases have ten or more of those) changes little: 22% of the first twelve, 16% of the
terms found, 89% in the vocabulary.

**How to read them.**

- **About one in five of the first twelve concepts is a word the authors put in a
  heading.** On CodeExam it is ten of twelve; on AutoGen and the safety-research
  repositories, half. On four small codebases it is none.
- **Twelve in a hundred of the authors' heading words are among the concepts.** Part of
  that is arithmetic: 200 concepts cannot hold 600 terms. Part is not, as the last column
  shows.
- **Most heading words are in the code and are not concepts.** 83% of the terms are in the
  vocabulary; 12% are concepts. On ExoPlayer the docs headings name `dash`, `hls`, `rtsp`,
  `rtmp`, `flac`, `opus`, `cast`, `muxer` and `session`. Every one is in the vocabulary.
  None is a concept.

**Why the concepts are drawn from 500 names and no longer 200.** The same measurement,
at five sizes, all 19 codebases together:

| names the concepts are drawn from | 200 | 300 | 500 | 1,000 | 2,000 |
|---|--:|--:|--:|--:|--:|
| heading words among the first 12 concepts (of 228) | 49 | 49 | 49 | 54 | 58 |
| heading words found anywhere among the concepts | 7% | 9% | 12% | 17% | 24% |
| first-12 concepts with no example: words that are never a piece of a longer name, mostly words from comments | 25 | 19 | 11 | 8 | 7 |
| of the first 24 concepts, which `--build-mechanisms` seeds from, how many differ from those at 200 (of 456) | 0 | 53 | 88 | 121 | 134 |

- A word spread over many names, none of them ranked high, was no concept at all at 200.
  The example that prompted the change: `faithful` on the safety-research repositories,
  where one project is named `faithful-cot`. The word is in 13 names
  (`FaithfulnessMetrics`, `compute_faithfulness_from_generations_clean`), each in 2 to 11
  of 1,490 files, and the best of them ranks 238th. At 200 no piece of any of them was
  scored. At 500 `faithfulness` is a concept, at row 108, with 14 mechanisms named for it.
  On ExoPlayer, `drm` was not a concept at 200 and is seventh at 500.
- At 500 the first twelve match the authors' headings no better than at 200. What changes
  is which words are in them: about half of the comment words leave the first twelve
  (`deliberately` on CodeExam moves from row 19 to row 43), and nearly twice as many
  heading words are found further down the list.
- Larger sizes find more and keep changing the seeds. 500 was chosen as the smallest size
  that halves the comment words at the top. It is one number for every codebase, chosen
  on these 19, and is `CONCEPT_NAMES` in `src/core/vocabulary.js`.
- The cost: the list is about twice as long, and a mechanisms index built before
  2026-11-24 was seeded from the 200. Running `--build-mechanisms` again gives somewhat
  different name-token mechanisms.

**What these figures do not show.**

- The match is by name. A term "found" means the word is in the list, not that the code
  the concept points to is the code that matters.
- A heading word is what authors chose to explain. Many are ordinary words (`add`,
  `available`, `different`) that nobody would want as a concept, and the list of generic
  words that takes such words out is short and hand-made. So "12% found" understates how
  many of the words that matter are found, by an amount this measurement cannot give.
- Nothing here says whether the concepts that are *not* heading words are good ones.
  `looper` and `shader` on ExoPlayer are not in a heading and are real subjects of the
  code. Section 7 is about the ones that are not.
- 19 codebases, all public, mostly Python and JavaScript, several of them collections of
  small repositories. No decompiled, minified or poorly named code. One run each.
- No one has yet been timed or scored finding something with the list.

To repeat the measurement on an index of your own:

```
node scripts/concepts-recall.mjs --list <index>
node scripts/concepts-recall.mjs --list --docs-from <directory with a README and docs/> <index>
```

## 7. Too much and too little: the balance

Any list like this errs in two directions, and a rule that cures one makes the other
worse. Section 6 measured what is missed. This is what is listed and should not be.

**Words that are not what the code is about**, with examples from real indexes:

| kind | examples | where |
|---|---|---|
| words from comments | `deliberately`, `distinctive`, `beside` | CodeExam |
| | `linkplain` | ExoPlayer |
| names of imported libraries | `checkerframework`, `errorprone`, `nullness` | ExoPlayer |
| | `fontweight`, `xticks`, `labelsize` | notebooks that plot |
| odd pieces from splitting a compound name | `player3`, `exo` (from the name `AndroidX_Media_ExoPlayer3` in comments), `unit4`, `bs32` | CodeExam and others |
| short random ids | `q040tvs`, `ecw1tl` (notebook cell ids) | an index of notebooks |

**Why they are not simply filtered out.** Four rules for keeping comment words out were
measured on eleven indexes on 2026-11-23, and none was built, because each removed real
subjects somewhere:

- "Show a concept only if a mechanism is named for it" removes `deliberately`. It also
  removes `heartbeat` and `drift` on Bram and `hallucinates` and `wireheading` on the
  safety-research repositories: real subjects that are variables and settings, not
  function names.
- The best of the four removed 56 of the 104 concepts of the small, well-commented demo
  that ships with CodeExam, among them `openssl`, `x509`, `sni` and `certificates`. In a
  small codebase the subject's own words can live mostly in comments.
- No rule tried tells `deliberately` from `openssl`. Both are plain words that occur only
  in comments. Telling them apart needs to know which is ordinary English.

The figures are in the comment of 2026-11-23 on
[#351](https://github.com/aschulman42-cell/code-exam/issues/351).

**What has been removed, where a rule could be found that cost nothing:**

- Copyright and licence header lines (since 2026-11-23): a holder's name or a project
  handle no longer ranks as a concept. The rule can miss a notice below line 60 of a file
  or in unusual wording.
- Embedded image data (since 2026-11-24): on one index of notebooks its pieces had been
  142 of 299 concepts. Measured on 192 indexes, the rule changed that one and lost no real
  name. It does not reach a payload shorter than 200 characters.

**What a reader has instead of a filter.** The number at the end of each `--concepts` row.
A concept with `(0)` is in the code's text and in no function's name. It may be a real
subject that the code only talks about, or a word from a comment. It is the first thing to
doubt, and `--search <word>` shows which it is.

## 8. Where "Potentially important files" comes from

The Overview lists files beside the concepts, and `--concepts` lists up to three files for
some rows. Both come from the vocabulary, not from the concepts, which is why they can
disagree with what the concepts suggest.

For each of the top 200 vocabulary names CodeExam records the files where the name is
concentrated. The Overview ranks files by how many of those names are concentrated in
them, and settles ties by the sum of each name's score times how concentrated it is in
the file (`buildOverview` in `src/core/overview.js`). So "important" here means "holds many
of the codebase's distinctive names", a measure of vocabulary density. The list under
`--vocabulary` ranks by that sum alone and can order the files differently, which is part
(d) of #351.

`--concepts` reads the same record the other way round, name to files
(`computeTermFiles`). It can do that only for a concept that is itself one of the top
names. `multisect` is a name in its own right and gets files. `claim` is a piece of longer
names (`splitClaimElements`) and never a name on its own, so its row has none.

## 9. Known defects

| issue | what |
|---|---|
| [#351](https://github.com/aschulman42-cell/code-exam/issues/351) | words from comments, names of imported libraries and odd pieces of compound names listed as concepts (section 7) |
| [#221](https://github.com/aschulman42-cell/code-exam/issues/221) | on some codebases the list is taken over by infrastructure words (`aws`, `bedrock`) |
| [#235](https://github.com/aschulman42-cell/code-exam/issues/235) | concepts with no example on small or prose-heavy indexes |
| [#275](https://github.com/aschulman42-cell/code-exam/issues/275) | in the GUI, a click on a concept can land on an import line |
| [#307](https://github.com/aschulman42-cell/code-exam/issues/307) | the ranking had no measure of accuracy; section 6 is the first |
| [#364](https://github.com/aschulman42-cell/code-exam/issues/364) | the MCP tool and the GUI list do not show where a concept's mechanisms sit (section 10); the command does, with `--carve` |

Also: single words only; a subject the code does not name has no concept; a word spread
over many low-ranked names is missed (section 6); and on a codebase where every file
carries the same word, that word is in more than 60% of the files and is dropped.

## 10. Where a concept's mechanisms sit

Since 2026-11-24, `--concepts --carve calls` also says where each concept's mechanisms sit
in the carved listing: the sections and sub-sections that `--carve` divides the mechanisms
into ([`CODEEXAM_CLUSTERING.md`](CODEEXAM_CLUSTERING.md)). Plain `--concepts` does not: it
has to be asked for, because it is slower (below), and the closing lines of `--concepts`
name the option.

In the list of `--concepts --carve calls` it is a bracket before the count:

```
   4. mechanisms (loadMechanismsIndex)  [13: 90%]  (10)
   6. exo (AndroidX_Media_ExoPlayer3)  [spread]  (3)
   9. gapped (airGappedStartupCheck)  [7.2]  (1)
```

- `[13: 90%]`: section 13 of `--carve calls` holds these mechanisms best, and 90% of them
  are in it. The number is that listing's own, so a search of `--carve calls` for one of
  the mechanisms shows the same number.
- `[spread]`: no section holds them better than a random pick of as many mechanisms would.
- `[7.2]`: the concept has one mechanism, and that is where it is.
- No bracket: no mechanism is named for the concept.

`--concepts <word>` gives the counts, and ends each mechanism's row with its own bracket:

```
  Where they sit, in the sections of ce --index-path .CE --carve calls (resolution 2, seed 5; ...):
    Home: section 13 holds 9 of the 10 (90%), and they are 9 of its 12 mechanisms (75%).
    Also in: 9.2 (1).
```

When the home is a sub-section and its section holds more of them, a line says so: on the
safety-research repositories, placed by clusters, `faithfulness` has its home in
sub-section 5.5 with 6 of its 14 mechanisms, and "Its section, 5, holds all 14".

**Two techniques.** `--concepts --carve calls` places by who calls whom, which needs only
the mechanisms file. `--concepts --carve clusters` places by likeness of the code's text,
which needs `--build-embeddings`. The two can put one
concept in different places, and neither is the right answer.

**What "better than a random pick" means.** For a concept with N mechanisms, the section or
sub-section is found that best combines two shares: how many of the N are in it, and how
much of it they make up. Then 200 random sets of N mechanisms are drawn from the same
listing and treated the same way. The section is called a home when at most 5% of the
random sets have a best section as good. The picks are seeded, so the same index gives the
same answer every time.

**How often concepts have a home**, measured 2026-11-24 with the command itself, over the
concepts that have two or more mechanisms:

| codebase | mechanisms | concepts with 2 or more | home, by calls | home, by clusters | median share of a concept in its home (calls) |
|---|--:|--:|--:|--:|--:|
| ExoPlayer 3 | 7,495 | 132 | 118 (89%) | 126 (95%) | 20% |
| safety-research repositories | 890 | 164 | 107 (65%) | 123 (75%) | 40% |
| ffmpeg | 5,590 | 186 | 116 (62%) | no embeddings | 17% |
| x264 | 360 | 156 | 93 (60%) | no embeddings | 36% |
| CodeExam itself | 363 | 148 | 86 (58%) | 86 (58%) | 50% |
| the bundled demo | 29 | 37 | 15 (41%) | 20 (54%) | 100% |
| Bram | 99 | 71 | 28 (39%) | 26 (37%) | 75% |

**How to read it, and what it does not show.**

- **A home is not the whole concept.** On the two large codebases a home typically holds a
  fifth of the concept's mechanisms: ExoPlayer's `playback` has 593 mechanisms, and its
  home, section 7, holds 15% of them. That is far more than chance and still most of the
  concept is elsewhere. The share is always printed for this reason; read `[7: 15%]` as
  "the densest place", not "the place".
- **On a small codebase few concepts have a home**, because with 29 or 99 mechanisms a
  random pick often lands together too.
- **Calls and clusters mostly agree on which concepts have a home, and put them in
  different sections**, since they are different divisions of the code. Under the earlier
  20-pick test, CodeExam had 67 concepts with a home under both, 15 under calls only and 17
  under clusters only; this was not counted again under the present test.
- **The answer moves a little with the seed.** With five seeds, 16 of CodeExam's 148
  concepts changed between home and spread under calls and 8 under clusters; 2 to 5 on the
  three other codebases tried. Those are the borderline ones. (An earlier form of the test,
  20 picks and "beat every one", changed 47 and 50; that is why it is 200 picks.)
- **The sections themselves are a suggestion.** They move when the index changes, and
  `--carve calls` gives other sections under another seed. The experiment that proposed
  this (2026-11-19) found clusters rebuilt from 80% of the mechanisms agreed with the full
  ones only 0.50 to 0.67.
- **It is slower, which is why it is asked for.** Placing needs the carve, which reads
  every function: `--concepts --carve calls` took about 2 s against 0.7 s for `--concepts`
  alone on CodeExam's index, and 14 s against 4.5 s on ExoPlayer 3.
- **Nobody has been timed finding code with it.** The figures say the placing is not
  random. They do not say it helps.
- The MCP tool `concepts` and the GUI's Concepts list do not show any of this.
