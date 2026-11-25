# Semantic search: finding code by what it does, in your own words

*The words on this page (mechanism, entry, anchor, HOF, register) are defined on
[`CODEEXAM_JARGON.md`](CODEEXAM_JARGON.md). The option reference is
[`cli.md`](cli.md); this page is how to use the feature, what it compares your text to, where
it sits among CodeExam's other searches, and what has and has not been tested.*

`--semantic-search` takes a description in ordinary words, or a patent claim, and lists the
places in an indexed codebase whose names and comments are nearest to it in meaning. It runs
on a small embedding model on your own machine. Nothing is sent anywhere.

```
ce --ndx <index> --build-embeddings                    once per index (and per embedding model)
ce --ndx <index> --semantic-search "<text>"            search for one description
ce --ndx <index> --semantic-search @claim.txt          search for every element of a claim
```

**A hit is the closest code found, a place to read. It is not a finding that the code does
what your text says.** Every listing says so in its header, and the reasons are in
[the warning below](#a-warning-before-you-use-the-next-three-options) and in
[What has been tested](#what-has-been-tested-and-what-has-not).

## This is a different kind of search: nearest, not matching

In an ordinary search, something either matches or it does not. Search for `bitrate` and
each line either contains that word or does not; if nothing does, you get nothing, and
"nothing" is an answer.

A semantic search has no such yes or no. It measures how **far** your text is, in meaning,
from every piece of the indexed codebase, and lists the pieces in order of closeness. Three
things follow, and they are what make its results easy to misread:

- **Everything gets a score, and something is always nearest.** There is no empty result.
  Ask a codebase for something it does not contain and you still get a list, headed by
  whatever happens to be least far away.
- **A score such as `0.433` is a closeness, not a match and not a probability.** It runs
  toward 1 as two texts mean more nearly the same thing; the *distance* between them is
  what is left (`--embed-distance` prints both). Unrelated code does not score 0. Under
  EmbeddingGemma it scores about 0.2 to 0.3, and under nomic about 0.5, so a number means
  nothing by itself: every listing prints a `typical score`, what unrelated code in this
  codebase scores for your text, to read the others against.
- **"Hit" means closest, not found.** The hits are the results nearest the top of the
  list for this text in this codebase. Whether any of them does what you described is a
  question the search cannot answer; you answer it by opening the code.

So read a listing as a short list of places to look, ordered by a measurement, and never as
a statement that the code is or is not there. For a statement of that kind, use the exact
searches ([`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md)).

Added 2026-11-17. **Command line only so far.** There is no GUI panel and no MCP tool yet;
as with pseudo-claims, a GUI control is planned and not built.

## Contents

<!-- contents:start -->
- [This is a different kind of search: nearest, not matching](#this-is-a-different-kind-of-search-nearest-not-matching)
- [What "embedding" means here](#what-embedding-means-here)
- [Using it](#using-it)
- [Working with no network: every step on your machine](#working-with-no-network-every-step-on-your-machine)
- [What to expect, and what a non-match looks like](#what-to-expect-and-what-a-non-match-looks-like)
- [When you expected something and it is not there](#when-you-expected-something-and-it-is-not-there)
- [Searching from a mechanism: `id:m70`](#searching-from-a-mechanism-idm70)
- [What your text is compared to](#what-your-text-is-compared-to)
- [Embedding models: local, one set of data per model](#embedding-models-local-one-set-of-data-per-model)
- [Why this works when "embeddings won't work here" was the earlier answer](#why-this-works-when-embeddings-wont-work-here-was-the-earlier-answer)
- [Where it sits among CodeExam's searches](#where-it-sits-among-codeexams-searches)
- [As a partial replacement for the claim commands](#as-a-partial-replacement-for-the-claim-commands)
- [Does this mean moving away from multisect?](#does-this-mean-moving-away-from-multisect)
- [What has been tested, and what has not](#what-has-been-tested-and-what-has-not)
- [The self-test (HOF) and semantic search](#the-self-test-hof-and-semantic-search)
- [Related](#related)
<!-- contents:end -->

## What "embedding" means here

Not what the word means when a video is embedded in a web page or a plug-in in an
application, where one thing is placed inside another. Here an **embedding** is a list of a
several hundred numbers that a model computes from a piece of text, arranged so that texts with
similar meanings get similar lists. Comparing two texts then comes down to comparing two
lists of numbers, which is fast enough to do against every function of a large codebase. The
model that computes the lists is an *embedding model*; the lists are sometimes called
*vectors*; "semantic search" is searching by that comparison in place of matching words.

## Using it

**Build once.** `--build-embeddings` needs the index's mechanisms
(`ce --ndx <index> --build-mechanisms`, no model) and says so if they are missing. It prints
how many texts it will embed, reports about once a minute, saves as it goes, and continues
where a stopped run left off. A search never builds: with no embeddings it prints the build
command and tells you to run the search again.

**Search a description.** One argument, no other options needed:

```
ce --ndx .CE --semantic-search "refuse to send code to a cloud model"

Semantic search of .CE for: refuse to send code to a cloud model
using the gemma embeddings already built for this index; --embed-model <name> chooses another
363 groups of functions ranked, each by its name and its best function's text
A hit is the closest code found for the text, a place to read. It is not a finding that the code does what the text says.

refuse to send code to a cloud model
  typical score 0.283, best 0.433; 3 hits, 8 near hits

  HITS
  1. 0.433  resolveModel   src/core/llm-runner.js:63-87
            in m44 [file] llm-runner.js / other (17 fn); also in m18 [cmd] --build-mechanisms, m1 [cmd] --pseudo-claims, m3 [cmd] --claim-chart, +1 more
            next best in these groups: claimsCostGate (lines 440-451), _recordUsage (lines 293-298)
            llm-runner.js holds the shared utilities — model resolution, prompt display, cost/truncation recording, …
  2. 0.432  assertLocalOnly   src/core/air-gapped.js:37-45
            in m185 [file] air-gapped.js (6 fn); also in m12 [cmd] --synonymize, m7 [cmd] --claim-search, m2 [cmd] --claim-analyze
            air-gapped.js enforces the `--air-gapped` flag by setting mode state, throwing on blocked cloud `feature` calls, …
  3. 0.424  ServerLLM::callClaude   src/server.js:398-459
            in m301 [file] server.js / call (3 fn); also in m129 [class] ServerLLM
```

(CodeExam's own index, EmbeddingGemma, 2026-11-17, cut for width.) The query does not contain
the code's word for this, "air-gapped". The function that enforces it is the second hit.

**Reading a result.**

- The first line is the **function that scored**, with its file and its line range in the
  index. Open it with `--extract` or in the GUI.
- `in …` names the **groups of functions** that hold it. These are the index's
  *mechanisms* ([`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)): `[file]` is a file or a
  part of one, `[class]` a class, `[cmd]` a command-line option's handler and what it calls,
  and a bare word is functions that share a name word. The smallest group comes first.
- `next best in this group` names the group's next functions for the same text. A group is
  ranked by one function, and the one you want may be its second.
- The last line, when the index has descriptions, is a model-written sentence about the
  smallest group (`--describe`). It is shown to help you read the list; it is not what was
  ranked.
- **The one number is a score, not a probability.** It means something only beside the
  header's `typical score`, what an unrelated piece of this codebase scores for your text.

**Hits and near hits.** A hit scores within 15% of the way from the best result down to the
typical score; a near hit within 35%. Both are relative to this codebase and this text. There
is always a best result, so there is always at least one hit, including when the codebase has
nothing of the kind. When many results tie the best, the listing says
`nothing stands out for this text`, which is the nearest it comes to saying "probably not
here". It never says the code is absent.

**Search a claim.** `@claim.txt` splits the claim into elements the way `--claim-chart` does
(or takes them verbatim from `--elements @list`), prints a listing per element, and closes
with the places found for the most elements:

```
ACROSS THE 8 ELEMENTS: the places within the first 25 results for the most elements
       elements 1 2 3 4 5 6 7 8
  2.  5 of 8  # # # . . # # .   assertLocalOnly   src/core/air-gapped.js:37-45
  9.  3 of 8  . . . . . # # #   airGappedStartupCheck   src/core/air-gapped.js:101-108
```

That closing view is the more reliable part of a claim search. The ranking is better at
finding the **part of a codebase a claim is about** than at tying one limitation to its code
(see the tests below), and a place that turns up for several elements is a better lead than
the top row of any one.

**Options you may want.** `--max-results N` (rows per tier, default 10; `0` for all),
`--verbose` (full paths, every group, the score's two parts), `--include-tests` (test, mock,
benchmark and example code is left out by default, and the last line of the output, a Tip, says how many groups and functions; a test is told by its
directory, file or name, or by a test attribute above it, as Rust's `#[test]`),
`--embed-model <name>`.
An option that does nothing here, such as `--function-text`, is named in the header and not
silently dropped.

## Working with no network: every step on your machine

Everything on this page can be done with no network connection, which is what code under a
protective order usually requires. The two optional steps that use a language model can use
a local one.

| step | what runs | network |
|---|---|---|
| build the index and its mechanisms | CodeExam, no model | none |
| `--build-embeddings` | the embedding model, local | none |
| `--semantic-search` | the embedding model, local | none |
| `--describe` (optional) | a language model; local with `--model <gguf>` | none with a local model |
| `--toward-code` (optional) | a language model; local with `--model <gguf>` | none with a local model |

With `--air-gapped` on each command, a slip to a cloud model is refused and not sent:

```
ce --ndx <index> --build-mechanisms --air-gapped
ce --ndx <index> --build-embeddings --air-gapped
ce --ndx <index> --semantic-search "<your text>" --air-gapped
ce --ndx <index> --describe --model <gemma-4 gguf> --local-reasoning off --air-gapped
ce --ndx <index> --semantic-search "<your text>" --toward-code restate --model <gemma-4 gguf> --local-reasoning off --air-gapped
```

- **Gemma 4 needs `--local-reasoning off`.** It thinks before it answers, and with reasoning
  left on the thinking uses up the reply: every description comes back empty. See
  [`LOCAL_LLM.md`](LOCAL_LLM.md). (Gemma 4 is a language model; the embedding model
  EmbeddingGemma is a different thing, [below](#embedding-models-local-one-set-of-data-per-model).)
- **What has been run this way**, all on CodeExam's own index, with Gemma 4 12B (Q4_K_M) on
  a laptop GPU, 2026-11-18 and 19:
  - `--describe`: 508 records described, none failed, none empty, 13 to 32 words each. The
    first attempt, without `--local-reasoning off`, described none of 501. How long the run
    took was not recorded.
  - `--semantic-search` over that index, with the Gemma 4 sentences under the results.
  - `--toward-code`, one text in each form, `restate` and `label`. Both completed. The
    `label` rewording of "local-only source-code review" was a list of names the codebase
    does not have, and the function that enforces local-only operation, third for the text
    as written, was not among its results.
- **What that does and does not show.** It shows the steps run with no network. It is one
  index, the tool's own code, and one text for `--toward-code`: it says nothing about how
  good a local model's descriptions or rewordings are. The searches in those runs used the
  nomic embedding model; the local language-model steps have not been run on this page's
  default, EmbeddingGemma, on that machine.

More on working offline: [`AIR_GAPPED.md`](AIR_GAPPED.md) and
[`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md).

## What to expect, and what a non-match looks like

**How often the right code is near the top.** Two figures from the project's measurements,
both for the group of functions holding the right function being within the first 25
results, both made with the label text alone (a search adds function text):

- **96%** for CodeExam's self-test claims, which are drafted from the code they are then
  searched for (332 functions, eight codebases). This is the easy case.
- **58%** for functions that litigants cited in public claim charts (114 cited names,
  fourteen filings). This is the realistic case for a patent claim, and it means that for
  about four cited functions in ten the right group is *not* in the first 25.

Neither figure is for a plain description typed by an engineer, which has only been tried
informally and does better than a claim. The tables and their caveats are under
[What has been tested](#what-has-been-tested-and-what-has-not).

**Wording still matters.** It is tempting to think a search by meaning makes the choice of
words irrelevant. It does not. These are *small* embedding models, built to run on a laptop
(EmbeddingGemma has 308 million parameters). They do not have the understanding of language that a
large cloud model has; they place a text by its words and their near neighbours. Two ways of
asking the same question of CodeExam's index:

| text | top result | `assertLocalOnly` | typical / best score |
|---|---|---|---|
| refuse to send code to a cloud model | `resolveModel` | 2nd | 0.283 / 0.433 |
| enforce local-only LLM; block any cloud LLM use | `AnalysisLLM::_callLocal` | 2nd | 0.310 / 0.541 |

Same intent, a different first result, and different scores throughout. So when a
description of your own returns little, say it another way: a different verb, the noun an
engineer would use, fewer words. That is ordinary searching. It is a different matter when
the text is a patent claim, whose words are fixed: changing *those* until the hoped-for code
appears is what [the warning below](#a-warning-before-you-use-the-next-three-options) is
about.

**A search for something that is not there still returns hits, and they do not score zero.**
There is always a nearest function. Asked of CodeExam's own index, which has nothing to do
with video:

```
choose a video bitrate from the amount of buffered media
  typical score 0.197, best 0.401; 1 hit, 1 near hit

  HITS
  1. 0.401  getSize   src/json-stream.js:138-141
            in m60 [file] json-stream.js (14 fn)
```

One clean hit, well above typical, for code that does not exist there: presumably "size" sits
near "amount", and that is all. Baselines from searches run on purpose against
the wrong thing (EmbeddingGemma, 2026-11-17; "margin" is the best score minus the typical
one):

| search | codebase | best score | margin |
|---|---|---|---|
| five things CodeExam does not do (prime numbers, certificate chains, video decoding, bitrate choice, satellite orbits) | CodeExam, 363 groups | 0.29 to 0.40 | 0.08 to 0.20 |
| the nine elements of a video-streaming patent claim | CodeExam | 0.32 to 0.44 | 0.08 to 0.17 |
| the eight elements of a claim about CodeExam's no-cloud mode | ExoPlayer 3, 7,495 groups | 0.40 to 0.51 | 0.15 to 0.25 |
| *for comparison:* four things CodeExam does do | CodeExam | 0.40 to 0.54 | 0.15 to 0.23 |
| *for comparison:* the no-cloud claim, where the right function is the top result for six of eight elements | CodeExam | 0.39 to 0.52 | 0.09 to 0.28 |

Read the table this way:

- **A non-match typically scores 0.3 to 0.5**, and stands 0.08 to 0.25 above the typical
  score. A match scores 0.4 to 0.55 and stands 0.09 to 0.28 above. The ranges overlap almost
  entirely.
- **A bigger codebase gives bigger non-match scores.** The wrong claim on ExoPlayer 3 scores
  as high as the right claim on CodeExam, because the best of 7,495 near-random results is
  higher than the best of 363.
- So **no score, and no margin, means "found".** The number tells you how a result compares
  with the rest of the same listing. Whether the code does what your text says is settled
  by opening it and reading it.

A handful of searches on two codebases is an illustration of the problem, not a calibration.
The earlier and longer attempt to find a line that separates the two cases, which also
failed, is recorded in `src/commands/embed-distance.js` and on
[`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md).

## When you expected something and it is not there

Three options help. Read the warning first.

### A warning before you use the next three options

> **`--filter` and `--toward-code` let you steer a search toward the result you hoped for.**
> Used carelessly they turn a search into a way of confirming what you already believed.
>
> - **`--filter` shows where a named thing ranked. It does not show that the search found
>   it.** If you filter for a class you suspect and see it at rank 47, the search put 46
>   other places ahead of it. Reporting "the search located the class" would be false.
> - **A rewording is a model's guess at what the code is called.** A model told a codebase's
>   vocabulary uses it whether or not the code that practises the text is there. A good rank
>   under `--toward-code` has not been shown to tell code that does what a claim says from
>   code that merely shares its subject.
> - **Trying wordings until the code you want rises is fishing.** Each new wording is another
>   draw, and one of them will eventually put anything near the top.
> - **Public code flatters the rewording.** Every test of it so far was on a public codebase
>   the rewriting model may have read in training. It is untested on code a model cannot
>   know, which is the usual case under a protective order.
>
> What a careful examiner does: write the text before looking at any result; keep the listing
> for the text as written; record every filter and every rewording tried, including the ones
> that did not help; and treat a hit as a place to open and read, never as a finding.
>
> The examples on this page were themselves run with the answer known in advance. They show
> how the options behave. They are not evidence that the search finds what it should.

### `--filter <text>`: where did the thing I expected rank?

`--filter` keeps the results whose function name, path or group contains the text, with their
ranks unchanged, and also lists matches **below** the near hits:

```
ce --ndx .AndroidX_Media_ExoPlayer3 --semantic-search "the content reproducing unit is configured to start reproduction of the content at the set reproduction start time" --filter LoadControl

  typical score 0.251, best 0.440; 3 hits, 38 near hits
  HITS matching --filter "LoadControl": 0 of 3
  NEAR HITS matching --filter "LoadControl": 0 of 38
  BELOW THE NEAR HITS, matching --filter "LoadControl": 26
  47. 0.371  DefaultLoadControl::shouldStartPlayback   …/media3/exoplayer/DefaultLoadControl.java:797-815
```

The honest reading of that listing: for this claim element as written, the function an
examiner might expect is 47th, behind three hits and 38 near hits that are mostly short
start and play methods. The search did not find it; the filter did.

### `--toward-code restate|label`: reword the text toward the code's names

A claim says things in a patent's words and code in an engineer's ("code rate" against
"bitrate"), and the embedding does not cross that gap on its own. With `--toward-code` a
language model rewords each text toward the names this codebase uses, one call per text, and
the search is by the rewording:

```
ce --ndx <index> --semantic-search @claim.txt --toward-code label --llm <provider>
ce --ndx <index> --semantic-search @claim.txt --toward-code label --model <local.gguf>

ELEMENT 1 of 11, as written: A method of establishing a secure communication connection …
  SEARCHED AS (a model's rewording; the results below are for this, not for the text above): [method] establish_secure_network_connection: initialize secure connection context, …
```

- `restate` writes one sentence in an implementing engineer's words; `label` writes a group
  label and function names as the model expects the code to be named, the shape of what is
  ranked. `label` has done better in the runs so far.
- This is the one part of a search that calls a language model. A cloud model prints its
  projected cost first and is refused under `--air-gapped`; a local model works there. The
  model is shown your text, the whole claim, a list of words from the index's names and, for
  `label`, a sample of its group labels. It is shown no source code. How many words and
  labels varies with the index and the model, and each run says how many it used before it
  calls the model: for example 150 words and 40 labels in the cloud runs behind this page,
  80 words and 40 labels for CodeExam's own index with a local Gemma 4.
- With `@claim.txt` the rewordings are saved beside the claim file, and
  `--toward-code @<that file>` repeats the search with no model call. Keep that file: it is
  the record of what was actually searched for.
- `--show-prompt` prints what would be sent and calls no model.

One run, to show the size of the effect and nothing more: for one element of claim 1 of
US 8,752,101 against ExoPlayer 3, the first `AdaptiveTrackSelection` function was 129th as
written and 11th in the `label` form (2026-11-17, Claude, one call, public code).

### `--describe`: a sentence under each result

`ce --ndx <index> --describe --llm <provider>` (or `--model <gguf>`) has a model write one
sentence per group, one call per group. A search shows that sentence under each result,
which makes a list far quicker to read, especially where names say little. The sentences are
not ranked on (see [below](#descriptions-are-shown-not-ranked-on)).

With a local Gemma 4 model add `--local-reasoning off`
(`--describe --model <gemma-4 gguf> --local-reasoning off`); without it every sentence comes
back empty. See [Working with no network](#working-with-no-network-every-step-on-your-machine).

The output ends by suggesting `--describe` when an index has no descriptions, and
`--toward-code` when the text reads like a claim or when nothing stood out.

## Searching from a mechanism: `id:m70`

Give a mechanism's id in place of the text and the search starts from that mechanism, not
from words (since 2026-11-21):

```
ce --ndx .CE --semantic-search id:m70
ce --ndx .CE --embed-distance id:m70 --all-results
```

The id is the one `--mechanisms`, `--toc`, `--embed-distance` and the results above show
(`m70`). The ranking is the usual one with the query's vectors replaced by the mechanism's
own, already saved in the index, so nothing is embedded for the query:

- each group's name is compared with the mechanism's name (its label and member names);
- each group's best function is compared with the mean of the mechanism's functions'
  vectors. Each function counts once in that mean, so a mechanism of a few functions is
  pulled toward whatever small shared helpers it holds.

`--embed-distance id:m70` uses the first of these only, and both with `--function-text`.

What is printed first is the mechanism itself, in full, as `--mechanisms -v` prints it, with
the date its mechanisms file was built. **Read it.** An id names a record of one build of
that file; after `--build-mechanisms` runs again the same id can name other code. The
mechanism is left out of its own results. Groups that hold some of its functions come first,
because a function is closest to itself.

Two cautions. This compares one piece of code text with another, where everything measured
on this page compared a person's words with code: the scores sit higher (on CodeExam the
typical score from `id:m70` is 0.54, against 0.33 for the word "multisect"), and the HITS and
NEAR HITS tiers and `--embed-distance`'s no-match band were set on written queries. The band
is not read here and the tiers are untested for this use; the output says so. And nothing
has been measured about whether the nearest mechanisms are related in a way a reader would
agree with: on CodeExam, sixteen commands on unrelated subjects had an average closeness of
0.88 to one another by the mean of their functions' vectors (0.64 for any two rows), because
each is a short handler plus the same few option-reading helpers (a scratch measurement of
2026-11-21, not a committed test).

It is not read with `--against` or `--toward-code`, and an id the index does not have stops
the command with a line saying so; `id:m70` is never searched for as text.

## What your text is compared to

Not the source code. An embedding model compares text with text, and the models that run
well on a laptop were trained mostly on prose. So CodeExam turns the indexed code into short
texts made of its **names, split into words, and its comments**, and your text is compared
with those. Two kinds are embedded for every index:

**1. One text per group of functions**: the group's label and its members' names as words.
For the group shown above as `in m185 [file] air-gapped.js (6 fn)`, the text embedded is:

```
[file] air-gapped.js: set Air Gapped, assert Local Only, scrub Api Key, is Local Api Url, check Connectivity, air Gapped Startup Check
```

and for an ExoPlayer class, shown in a listing as `in [class] AviStreamHeaderChunk (5 fn)`:

```
[class] AviStreamHeaderChunk: Avi Stream Header Chunk parse From, Avi Stream Header Chunk Avi Stream Header Chunk, Avi Stream Header Chunk get Type, Avi Stream Header Chunk get Track Type, Avi Stream Header Chunk get Duration Us
```

A group with more than eight functions is also embedded in runs of eight names, and scored by
its best run, so a group of 400 functions is not one long text cut short.

**2. One text per function**: its name as words, the identifiers in its body that are rare in
this codebase, and its comments (without the ruled lines of a banner comment, such as
`// ======`). For `assertLocalOnly`:

```
assert local only: feature, air gapped, error. Throw a uniform, user-safe error before any outbound AI call when air-gapped. Call this at every cloud-AI call site, just before the network is touched.. Text: air gapped feature needs cloud call which blocked local model instead the gui set engine workspace
```

and for `AviStreamHeaderChunk::parseFrom`, a function with only field comments:

```
avi stream header chunk parse from: body, read little endian int, initial frames, suggested buffer size, avi stream header chunk, rate, scale, skip bytes, stream type, sample size, length, parsable byte array. fccHandler (4 bytes), dwFlags (4 bytes), wPriority (2 bytes), wLanguage (2 bytes). dwStart (4 bytes). dwQuality (4 bytes).
```

**To read these texts for your own index**, `--show-function-text` prints them exactly as
they are embedded, with no model run:

```
ce --ndx .CE --show-function-text air-gapped.js@assert     functions whose file@name matches
ce --ndx .CE --show-function-text id:m185                  the functions of one group
ce --ndx .CE --show-function-text -v --max-results 5       the pieces of each text apart
ce --ndx .CE --show-function-text --text-has "air gapped"  functions whose text holds the words
```

`--text-has` looks in the text, not the source: identifiers are there as words, so
`airGapped` in the code is `air gapped` in the text. It takes a `/regex/` too.

```
src/core/air-gapped.js@assertLocalOnly  (L37-45; in m2 m7 m12 m185)
    assert local only: feature, air gapped, error. Throw a uniform, user-safe error before ...
```

The line over each text is the function, its lines, and the ids of the groups that hold it.
With `-v` the four pieces (name, identifiers, comment, string words) are shown apart with
their lengths, which shows at a glance whether a function's text is mostly its comment or
mostly identifiers. Reading a page of them is the quickest way to see why one function is
found and another is not: a function with a comment reads close to a description of itself,
and one without is a list of identifiers, some of them names every file uses.

So the things in a listing that look like code, `[class] AviStreamHeaderChunk` and
`[file] AviStreamHeaderChunk.java`, are the **labels of groups**: CodeExam's own names for a
class's or a file's functions taken together. They are built from the index with no model
([`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md) explains how functions are grouped and
how to read a label). A function of four lines or more is in at least one group, and so can
be reached, with exceptions: `--show-function-text` marks every function no text is embedded
for and counts them in its header. On CodeExam's own index (2026-11-22) that was 803 of 2,797
functions outside tests:

- 709 of one to three lines, in no group (the four-line floor);
- 62 of four lines or more that are in no group all the same (`in no mechanism, not
  embedded`), among them functions named `main`, `init` and `get` and class constructors. The
  grouper left out every function with such a generic name, because no group should be named
  for one;
- 32 that are in a group but are the second definition of a name within one file (`in m57,
  not embedded: a second definition of this name in the file`). A search reached a group's
  functions by file and name, which finds only the first definition.

Both of the last two were changed on 2026-11-23. A second definition is now reached by its
start line and gets a text of its own; that needs nothing rebuilt, and the next search or
`--build-embeddings` embeds the newly reached functions. A function with a generic name that
is four lines or more now sits in its file's group (and in no other, and no group is named
for it), but only in a mechanisms file built since then: `--build-mechanisms` has to be run
again, which renumbers the groups' ids. On an index whose mechanisms file is older, the 62
kind is still marked.

**The score.** A group's score for your text is 0.3 of its label text's similarity plus 0.7
of its best function's. That weighting was fixed and measured before this command existed
([`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md), "The label and the function
text as one score"). Groups are ranked by it, and each is shown as the function that scored;
groups whose best function is the same one are shown as a single result.

**What follows from this.**

- Code with descriptive names and comments is found well. Code named `process()` and
  `doWork()`, with no comments, gives the search nothing to compare, and is not found.
- A short function whose name happens to share a word with your text can outrank the
  function that does the work. On large codebases, getters and setters do this.
- Two kinds of prose that CodeExam can also produce from code are **not** compared today:
  descriptions (next) and pseudo-claims
  ([`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md)). Both are candidates for a
  later version.

### Descriptions are shown, not ranked on

A description is real prose about a group, and ranking on it would seem the obvious thing.
It was tried on six plain-words questions against CodeExam's own index (2026-11-17, a small
and friendly sample written by the tool's own author): ranking on the description moved the
right file's group into the first five for two or three of the six, against one for names;
it also dropped one from 64th to 141st. Earlier and larger measurements on self-test claims
found descriptions help most at rank 1 and where identifiers say least, and add nothing by
rank 25 ([`describe-reach.md`](describe-reach.md)). Nothing has measured them on a litigant's
chart. Until something does, they are displayed and the ranking stays the measured form.

## Embedding models: local, one set of data per model

**Every embedding model CodeExam supports runs on your machine.** There is no cloud embedding
option. After a model's file is downloaded once, a build and a search make no network call,
and `--air-gapped` changes nothing about them. (The one exception on this page is
`--toward-code`, which asks a *language* model for a rewording and is refused under
`--air-gapped` unless that model is local.)

**EmbeddingGemma is not Gemma.** Gemma is Google's family of language models, the kind that
writes text; a Gemma model is the local language model CodeExam is mainly tested with for
chat, descriptions and claim work ([`LOCAL_LLM.md`](LOCAL_LLM.md)). EmbeddingGemma is a separate, much smaller model (308
million parameters) that writes nothing: it turns a text into a list of numbers so that two
texts can be compared. A search uses only the second. `--embed-model gemma` means
EmbeddingGemma.

**Which models, and which was tested.**

| name | model | status |
|---|---|---|
| `nomic` | nomic-embed-text v1.5 | ships with CodeExam; the model nearly all the measurements were made on |
| `gemma` | EmbeddingGemma, first version (308M) | a download; what a search prefers when its file is installed; ahead of nomic on the self-test claims and at depth on the chart rows |
| `gemma2` | EmbeddingGemma 2 | **does not load** under the runtime CodeExam ships with. Run once under a newer runtime kept outside the repository: ahead of the first version on the self-test claims, behind it on seven litigant filings. Not supported. |
| `jina`, `coderank`, `qwen06`, `qwen4` | code- and general-purpose embedding models | downloads; usable with `--embed-model`; measured less |

`ce --embed-model list` shows what is installed and where each comes from. The figures are in
[`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md) ("A second embedding model")
and [`model-support.md`](model-support.md).

**Each model needs its own data for each index.** Vectors from one model mean nothing to
another, so `--build-embeddings` is run once per index *and per model*, and writes that
model's files under the index's own `embeddings/` folder:

```
<index>/embeddings/embeddinggemma-300M-Q8_0_label+members.json
<index>/embeddings/embeddinggemma-300M-Q8_0_label+members_chunks8.json
<index>/embeddings/embeddinggemma-300M-Q8_0_function-text-comments.json
<index>/embeddings/nomic-embed-text-v1.5.Q8_0_…                          (the same three, if built)
```

- A build with no `--embed-model` uses gemma when its file is installed and nomic otherwise.
- A search with no `--embed-model` uses gemma if the index has gemma data, otherwise whatever
  the index has, and says which. To search with another model, build for it first:
  `ce --ndx <index> --build-embeddings --embed-model nomic`.
- **Building takes time on a large index.** The 100 functions of the demo take about ten
  seconds. ExoPlayer 3's 45,317 functions took about 45 minutes on a laptop CPU. A very
  large index is a job to start before leaving for the day. A stopped build keeps what it
  embedded.
- After the index or its mechanisms are rebuilt, run `--build-embeddings` again. It embeds
  only what changed. A search will embed up to 200 missing texts itself and say so; past
  that it asks for the build.
- The files hold vectors and hashes, no source text. They live and die with the index
  folder. Under a protective order they are part of the index
  ([`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md)).

## Why this works when "embeddings won't work here" was the earlier answer

Earlier issues and pages said, in effect, that embeddings were not the answer for CodeExam
([#322](https://github.com/aschulman42-cell/code-exam/issues/322),
[`embedding-reach.md`](embedding-reach.md), and the "tall order" passage in
[`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md)). They were answering a different question.

**The earlier question was prose against code.** The idea was to put a claim element and a
function body into one "joint" embedding space, with a model trained on code such as CodeBERT
or UniXcoder, and take the nearest. Those models learned from functions paired with their own
docstrings, prose written by the programmer about that function. A patent claim is a
different kind of writing. Measured on fourteen litigated filings, the best such model put 17
of 44 cited names within 25, against 11 by chance and 10 for CodeExam's name search
([`embedding-reach.md`](embedding-reach.md)). That is a small gain over chance, and the
conclusion at the time was fair.

**What a search does now is prose against prose.** Your text is never compared with code. It
is compared with short texts CodeExam writes *from* the code, shown in the section above:
names turned into words, comments, and group labels. A general-purpose text embedding model
handles that comparison well, and CodeExam's job becomes producing good text from an indexed
codebase. It has three ways of doing that, and a search uses the first today:

| text CodeExam produces from code | needs a model? | used by a search today |
|---|---|---|
| group labels and function texts ([`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)) | no | **yes, this is what is ranked** |
| descriptions, one sentence per group (`--describe`) | yes, once per group | shown under results; not ranked on |
| pseudo-claims, claim-style statements of what code does ([`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md)) | yes | no |

**The two issues behind this.**
[#322](https://github.com/aschulman42-cell/code-exam/issues/322) asked whether embeddings
should be revisited at all, and
[#363](https://github.com/aschulman42-cell/code-exam/issues/363) set out to build
prose-to-code search on an embedding model and the mechanisms' labels. This command is that
search, so it supersedes much of both: #322's question is answered (yes, in the
prose-against-prose form), and #363's first goal is shipped. Neither is finished. Still open
under them: ranking on descriptions and pseudo-claims, the register gap between a claim and
code, a search step inside the claim commands, and the GUI.

**Would plain prose-against-code work now?** Probably not much better than it did. Nothing
measured since has changed that finding, and it has not been re-run with newer models; treat
that as untested, not disproved. The gap that remains even in the prose-against-prose form is
the one the early pages named: a claim's wording and an engineer's wording differ, and no
embedding bridges that reliably yet. `--toward-code` is one attempt at it.

## Where it sits among CodeExam's searches

| command | you give it | it matches against | calls a language model? | you get back |
|---|---|---|---|---|
| `--search`, `--literal`, `--regex` | words or a pattern you can name | the text of the indexed files | no | every line that contains it |
| `--multisect-search` | several terms | file bodies | no | the smallest scope where the terms occur together |
| `--claim-search` | a claim | file bodies, by terms a model extracts | yes | ranked scopes containing those terms |
| `--claim-locate` | a claim | symbol names, by words a model predicts per element | yes | candidate functions per element |
| `--claim-chart` | a claim | the candidates, read by a model | yes, and it reads code | a verdict per element and target |
| `--embed-distance` | a text | group labels (and function texts) | no | raw similarity numbers, for measuring |
| **`--semantic-search`** | a description or a claim | group labels and function texts | **no** (unless `--toward-code`) | functions as hits and near hits |

Reach for `--search` or `--regex` when you know a word that must appear and want every
occurrence, or need to say with confidence that a string is absent. Reach for
`--semantic-search` when you can describe what the code does and do not know what it is
called. They answer different questions, and an examination will usually use both.

## As a partial replacement for the claim commands

`--claim-search`, `--claim-locate` and `--claim-chart` each start by getting candidate code
for a claim, and each uses a language model to do it. Semantic search can stand in for
**that first step**: it produces candidates for each element with no language-model call, no
cloud access, and nothing leaving the machine. That is why it is described here as a partial
replacement, and these are its limits:

- **It does not read code.** `--claim-chart`'s model reads each candidate and says whether
  it meets the element. A search compares names and comments and gives a score.
- **It gives no verdict.** No `PRESENT` or `ABSENT`, and no chart.
- **It is not wired into the claim commands.** `--claim-locate` and `--claim-chart` still do
  their own retrieval. Using a search's hits as their candidates is done by hand today, with
  `--targets`.

What is measured, and it is about the retrieval step only:

- On CodeExam's **self-test claims**, the group holding a claim's function ranked first for
  61% of 332 anchors over eight indexes on labels alone, against 35% at the function level
  for `--claim-locate`'s name search ([`describe-reach.md`](describe-reach.md);
  [`CODEEXAM_PSEUDO_CLAIMS_TESTS.md`](CODEEXAM_PSEUDO_CLAIMS_TESTS.md)). The two figures are
  at different grains, a group against a function, and are not a like-for-like comparison.
- On **litigants' claim charts**, the group holding a cited function was within the first 25
  for 58% of 114 cited names, where the name search reached 10 of 44
  ([`describe-reach.md`](describe-reach.md)).
- When `--claim-chart`'s model does read a candidate it is usually right: a `PRESENT` lands
  on the drafted function, one call away, or its class 89% of the time, with 2% false
  `PRESENT` on unrelated codebases. Its weak half is getting the right function in front of
  the model at all (42% of anchors), which is the half a search addresses
  ([`CODEEXAM_CLAIM_CHARTS_TESTS.md`](CODEEXAM_CLAIM_CHARTS_TESTS.md)).

**Not run:** the claim pipeline with semantic search as its retrieval step, on the self-test
or on the litigant agreement harness. Whether search-then-read beats today's
locate-then-read is the obvious next measurement and has not been made. Until it is, this is
a direction and not a result.

## Does this mean moving away from multisect?

No. They read different things and fail in opposite ways.

- **Multisect and the literal searches read the files themselves** for words you can name.
  They are exact: a term is there or it is not, every occurrence is listed, and absence can
  be argued from them. They cannot find code whose words differ from yours.
- **Semantic search reads names and comments for meaning.** It can find code whose words
  differ from yours. It is approximate: it always returns something, it cannot show absence,
  and it sees nothing in badly named, uncommented code that a body search would still match
  on a string or a constant.

In practice: start with a semantic search when you can describe a behaviour and do not know
the codebase's vocabulary; take the names it turns up into `--search`, `--regex` or a
multisect to see every occurrence and to check what the names actually do; and use the exact
searches, not this one, for any statement that something is not in the code. The lexical
index stays the base of CodeExam, and the embeddings are files layered on top of it
([`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md)).

## What has been tested, and what has not

**Committed measurements** (methods, tables and controls are on the pages linked):

| what | result | where |
|---|---|---|
| Groups as the unit, labels as the text, self-test claims, eight indexes | the right group first for 61% of 332 anchors, within 25 for 96% | [`describe-reach.md`](describe-reach.md) |
| The same, on litigants' charts (fourteen filings) | the group holding a cited function within 25 for 58% of 114 names | [`describe-reach.md`](describe-reach.md) |
| Label and best function's text as one score (what a search ranks by), self-test claims | the right group first for 93% and 95% of claims as drafted, 78% and 61% after a second model reworded them (nomic) | [`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md) |
| The same, on litigants' chart rows | no gain over labels alone | same page |
| Can it tell one limitation of a claim from another? | no: the cited functions rank about as well under a different limitation of the same chart | same page |
| Rewording a limitation toward the code (`--toward-code`), 39 chart rows | reaches somewhat more of the cited code, and another limitation's rewording reaches it almost as often; the codebase's vocabulary added nothing over a rewording made without it; a wrong codebase did not come to look matched | same page, 2026-11-16 |
| EmbeddingGemma beside nomic | ahead on the self-test claims and at depth on the chart rows | same page |

Every chart in those tests is a party's advocacy. A hit is agreement with a party, not
correctness.

**Examples from 2026-11-17, the day the command was written.** Each was run with the target
known beforehand, by the people building the tool, on public code; the rewording prompt had
been revised once on the '101 claim. They are illustrations. The scripts are scratch files
outside the repository and the runs are not reproducible from it.

- *A plain question on CodeExam's index.* "refuse to send code to a cloud model": the
  function enforcing it is the second hit (above). A listing of groups, without the
  function shown, had its file's group 39th.
- *Six plain-words questions on CodeExam's index*, written by the tool's author: a group
  holding the answer was within the first five for five of six.
- *Searches run against the wrong thing on purpose*, to see what a non-match scores: the
  table under [What to expect](#what-to-expect-and-what-a-non-match-looks-like). Matches and
  non-matches overlap almost entirely.
- *A pseudo-claim written to avoid the code's own word*, eight elements, on CodeExam's
  index: the right function was the top result for six of eight elements.
- *Claim 1 of US 8,752,101 against ExoPlayer 3* (7,495 groups outside test code), as
  written: poor. The listings are mostly short getters and setters matched on single words.
  The functions that the chart in the next example cites for the claim
  (`AdaptiveTrackSelection`, `DefaultLoadControl::shouldStartPlayback`) do not appear in
  them; with `--filter` the first is 129th and the second 47th for the elements they are
  cited for.
- *The same claim against an independent chart* (written by ChatGPT earlier in the year,
  with no contact with this project; seven limitations citing named classes or functions).
  Share of symbol-and-limitation pairs within 25: 11% as written, 32% restated, 43% in the
  `label` form, against 6%, 9% and 14% for the same symbols under the chart's *other*
  limitations. Twenty-eight pairs, one claim, a rewriting model that very likely knows
  ExoPlayer.

**Not tested.**

- **Code a model cannot know.** Every rewording result is on public code.
- **Whether a hit tier means anything absolute.** The tiers are relative; no line has been
  found that separates "found" from "not there" (the history is in
  `src/commands/embed-distance.js` and on the tests page).
- **Absence.** Nothing measures "this limitation has no code here".
- **Search as the claim pipeline's retrieval step**, end to end.
- **A codebase larger than ExoPlayer 3**, or build time on one.
- **Levels.** A 10,000-group codebase read directory-first, then file, then function, is
  not built. Rolling results up was measured on 2026-11-19 on the twelve filings
  ([`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md), "Rolling a search's
  groups up"): the directory holding the cited code is among the first three far more
  often than chance and hardly more often than for another limitation of the same chart,
  most of a directory's lead is its size, and reading results directory by directory is
  not cheaper than the flat list. A section of a clustering made with no directory names
  did as well as a directory. So a roll-up says which part of the codebase a claim is
  about, once per claim; it is not a faster way to read one limitation's results.
- **Ranking on descriptions or pseudo-claims**, beyond the six questions above.

## The self-test (HOF) and semantic search

CodeExam's self-test ("huffing our own fumes", `ce --hof`) drafts pseudo-claims from an
index's own code with the drafted functions recorded as anchors, has a second model reword
them away from the code's vocabulary, and then checks whether the claim commands find the
anchors again ([`CODEEXAM_PSEUDO_CLAIMS_TESTS.md`](CODEEXAM_PSEUDO_CLAIMS_TESTS.md)). Its
retrieval step is `--claim-locate`.

The measurements already in hand say the search's ranking does that retrieval step better
than `--claim-locate` on these claims: the right group first for 61% of anchors on labels
alone and for 78% and 61% of reworded claims with function text, against 35% at the function
level for the name search. Two cautions. The grains differ (a group against a function), so
the gap is overstated by an unknown amount. And self-test claims restate the code they were
drafted from, which is exactly the case a text comparison is best at; a real patent does not.

So making semantic search the self-test's retrieval step is a plausible change, and it has
**not** been made. Before it is, the self-test would need to be run both ways on the same
claims and scored at the same grain, the function, since a chart cites functions. Until then
`--hof` is unchanged, and the figures above are the reason to try it, not a result.

## Related

- [`cli.md`](cli.md): every option of `--semantic-search`, `--build-embeddings`,
  `--embed-distance` and `--toward-code`.
- [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md): the groups a search ranks, and how to
  read a label. [`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md): the
  measurements.
- [`describe-reach.md`](describe-reach.md) and [`embedding-reach.md`](embedding-reach.md):
  the two earlier studies, groups-and-labels and code-trained models.
- [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md): the exact searches and multisect.
- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) and
  [`CODEEXAM_CLAIM_CHARTS.md`](CODEEXAM_CLAIM_CHARTS.md): the claim commands.
- [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md): prose drafted from code.
- [`CODEEXAM_CLUSTERING.md`](CODEEXAM_CLUSTERING.md): a status report on clustering the
  mechanisms into features with these same vectors. Work in progress; `--carve clusters`
  (experimental) prints such a listing.
- [`model-support.md`](model-support.md): the embedding models and their prompts.
- [`AIR_GAPPED.md`](AIR_GAPPED.md) and
  [`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md): what stays on the
  machine.
- Issues [#322](https://github.com/aschulman42-cell/code-exam/issues/322) (embeddings
  revisited) and [#363](https://github.com/aschulman42-cell/code-exam/issues/363)
  (prose-to-code search on mechanism labels).
