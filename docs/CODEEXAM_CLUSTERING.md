# Clustering: can CodeExam sort a codebase into its features automatically?

*A status report on work in progress, as of 2026-11-23. One experimental command, `--carve`,
prints the listings described here ([How to run it](#how-to-run-it)). The experiments and
the scores were made with scratch scripts that are not part of the product.*

When CodeExam examines a codebase, it finds **mechanisms**: small sets of functions that
together do one thing, such as the methods of one class or a command's handler and its
helpers. `--toc` and `--mechanisms` list them. One trouble is the length of the list.
CodeExam's own code has 363 mechanisms, and a large codebase has thousands. Nobody can run
an eye down that and see what the codebase is about.

A person who knows the code thinks of it differently: as a few dozen **features**. CodeExam,
for example, has a search feature, a claim-chart feature, a duplicate-finding feature, and
so on, and each feature is implemented by several mechanisms.

**Clustering** is an attempt to get from the first list to the second automatically. A
program measures how similar each mechanism is to every other and puts similar mechanisms
into the same **cluster**. The hope is that each cluster turns out to be one feature, so
that the listing becomes a few dozen entries that a person can scan and then open.

**How well does it work so far?** It has so far only been tested thoroughly on one codebase, 
CodeExam's own (though also see "Other codebases" below), where
a hand-made list says which mechanisms implement which feature. The best automatic
clustering tried so far does this:

- It puts roughly 60% to 65% of the mechanisms that implement a feature into the same
  cluster. The rest of that feature's mechanisms are scattered in other clusters.
- A typical cluster is roughly 65% to 75% devoted to a single feature. The rest of the
  cluster is mechanisms from other features.

Clusters made by shuffling score 20% to 35% on the same two measures. So the clusters are
far better than chance on the one hand, and on the other hand well short of what a person would write by hand. 
They may be good enough as a first map of an unfamiliar codebase. That has not been tested with
readers.

A second technique, first tried on 2026-11-23, works from which mechanisms call which and
not from their text. In its one test so far it did better on both measures. It is described
under [A second technique](#a-second-technique-carving-by-who-calls-whom), and the rest of
this page is about the first.

Two limits apply to everything below:

- **Only one codebase has been scored against a hand-made feature list.** A method that
  does best on CodeExam's own code may not do best elsewhere.
- **The figures come from scratch scripts**, named
  [at the end](#where-the-figures-come-from), that have no tests of their own. The `--carve`
  command, added on 2026-11-23, makes the same groups and is tested, but it reports no
  scores.

## Contents

- [Words used on this page](#words-used-on-this-page)
- [Why try to put mechanisms into clusters?](#why-try-to-put-mechanisms-into-clusters)
- [What a clustered listing looks like](#what-a-clustered-listing-looks-like)
- [How the clusters are made](#how-the-clusters-are-made)
- [How the clusters are judged](#how-the-clusters-are-judged)
- [What has been found so far](#what-has-been-found-so-far)
- [What this suggests about mechanisms themselves](#what-this-suggests-about-mechanisms-themselves)
- [What is wanted from clustering, and where each point stands](#what-is-wanted-from-clustering-and-where-each-point-stands)
- [Questions not yet answered](#questions-not-yet-answered)
- [Known weaknesses](#known-weaknesses)
- [How to run it](#how-to-run-it)
- [Related published work](#related-published-work)
- [Where the figures come from](#where-the-figures-come-from)
- [Related](#related)

## Words used on this page

| word | meaning here |
|---|---|
| mechanism | a small set of functions that together do one thing; one entry of `--toc` or `--mechanisms`, with an id such as `m70`. CodeExam finds mechanisms by fixed rules, with no language model ([`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md)) |
| feature | something a codebase does, as a person who knows it would name it: "claim charts", "finding duplicate functions" |
| cluster | a set of mechanisms that a program has put together because they are similar in some way |
| broad and narrow clusters | the same clustering at two levels of detail: 12 broad clusters for CodeExam, or 45 narrow ones. The tests page calls them sections and sub-sections |
| function text | a short text CodeExam builds for each function from its name, its identifiers, its comments and its strings. `--show-function-text` prints it |
| embedding | a list of numbers computed from a text by a small model such as EmbeddingGemma, such that texts with similar meaning get similar numbers. It is how "similar" is measured here |
| mixed mechanism | a mechanism whose functions belong to several features at once |

## Why try to put mechanisms into clusters?

**To give users a menu of possibilities.** CodeExam's commands for finding the code that
matches a patent claim (`--claim-chart`, `--claim-locate`, `--claim-search`) don't yet work
as well as desired. Until they do, CodeExam can at least present a menu: here is a reasonably-sized
and reasonably-complete list of what is in this codebase, with easy-to-eyeball summaries of
each chunk, so you can see if it is what you are looking for. From an entry you would then
see the codebase's own vocabulary for that feature, and the main files and functions
associated with it.

**To bridge the gap between prose and code.** Much of CodeExam's claim work rests on
literal or regex searching, even when synonyms are added. That makes it depend heavily on
what the code says about itself, as against what the code actually *does*. Technical prose
such as a patent claim rarely uses the code's own words. CodeExam's approach is to take the
code, turn it into prose, and compare that prose with the user's prose by embedding both.
That raises the question of how good the prose made from the code is. The question is not
whether it is good in the abstract. It is whether it is suitable for finding the code that
a piece of prose describes. Clustering is one way to find out: if the prose is good, then
mechanisms that implement the same feature should come out similar.

**To find the "sweet spot" between too broad and too narrow.** CodeExam can draft
"pseudo-claims", patent-style descriptions of what a piece of code does
([`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md)). They are promising but are often
at the wrong level. A real independent claim is written to be as broad as the earlier
inventions allow. A pseudo-claim written from one mechanism is too narrow and too closely
tied to one codebase. A cluster of mechanisms may be closer to the size of an invention.

Behind all three is an older idea that the principal developer has worked on: 
carving a codebase along its joints or seams, to see
which parts are tightly integrated and which are only loosely coupled. Clustering is the
present-day machine-learning name for that kind of carving.

The test of success is practical. The clusters don't need to be perfect. When a user looks
at the clustered listing, is it likely they will find reflected there the feature or concept 
they are interested in?

## What a clustered listing looks like

These are five of the 12 broad clusters made for CodeExam's own code, as
`--carve clusters --brief` prints them (2026-11-23). Each line gives the cluster's number,
its heading and how many mechanisms it holds. The command calls a broad cluster a section.

```
2. sitter, prompts, tree, parser   (61 mechanisms)
3. claim, chart, locate, split   (39 mechanisms)
7. renderers, list, render, app   (25 mechanisms)
8. dupes, struct, funcstr, string   (25 mechanisms)
11. calls, tree, graph, file   (16 mechanisms)
```

Someone who knows CodeExam recognises several of these. Cluster 3 is the claim-chart work,
cluster 7 is the browser interface, cluster 8 is the finding of duplicate functions, and
cluster 11 is the following of calls between functions.

Cluster 2 is the failure. It holds 61 of the 363 mechanisms under four words that say
little: its narrow clusters are the bundle reader, the prompt finder, utilities, part of the
grouper, the parser, digests, copyrights and masking. It is a "junk drawer": the things
that did not clearly belong anywhere else.

This listing is not the clustering the scores below were measured on. On 2026-11-23, after
the scores were taken, two things changed in what the clusters are made from:

- 32 functions that had been left out (second definitions of a name within one file) were
  let into their mechanisms. That alone moved the junk drawer from 84 mechanisms to 88
  under a different heading.
- Ruled lines in banner comments (`// ======== Accordion left pane ========`) were taken
  out of the function texts, 65 of them. The junk drawer then fell to 61, and the largest
  cluster became a different one, of 63, that holds the pseudo-claims and mechanisms code.
  The rules had been making unrelated functions with banner comments look alike.

The scores have not been taken again, so it is not known whether the clusters are now
closer to the feature list or further from it. It is a fair picture of how much these
clusters move when their input changes a little; see
[Known weaknesses](#known-weaknesses).

Two more points about this listing:

- The headings are only the words that are common in the names of a cluster's mechanisms
  and rare outside it. No one wrote them, and they are not descriptions.
- Under each heading the command lists the cluster's narrow clusters and their
  mechanisms. [How to run it](#how-to-run-it) shows one.

## How the clusters are made

No LLM is used at any step, and nothing leaves your machine. That matters
because CodeExam is often used on confidential code.

1. **A short text for each function.** CodeExam builds it from the function's name split
   into words, the less common identifiers in its body, its comments, and the words in its
   strings. This is the "prose made from the code". You can read it with
   `--show-function-text`.
2. **An embedding for each function.** A small embedding model that runs on your own machine
   (EmbeddingGemma, a 300-megabyte file) turns each text into a list of numbers. Two
   functions whose texts mean similar things get similar numbers.
3. **An embedding for each mechanism.** It is an average of the embeddings of the
   mechanism's functions. Long functions count more. Helper functions that many mechanisms
   share count less. Without that adjustment, small unrelated commands looked alike only
   because they all use the same option-reading helpers.
4. **Clustering.** The program starts with every mechanism as its own cluster. It then
   repeatedly merges the two clusters that are most alike, until there is one. The record of
   the merges is a tree. This standard technique is called hierarchical clustering, and the
   particular rule used for "most alike" is [Ward's method](https://en.wikipedia.org/wiki/Ward%27s_method).
5. **Choosing how many clusters.** Stopping the merging early gives many narrow clusters.
   Stopping late gives a few broad ones. The experiments stop at 12 and at 45 for CodeExam,
   and at several numbers between for comparison.
6. **Headings.** Each cluster is headed with the words that set the names of its
   mechanisms apart.

## How the clusters are judged

To judge clusters there has to be something to compare them with. For CodeExam's own code
there is a hand-made list.

**The feature list.** CodeExam's author wrote down the features of CodeExam that a reader
might come looking for. There are 41 of them, for example multi-term search, vocabulary,
running with no network connection, structural search and duplicates, claim charts, and
pseudo-claims. He then went through the plain `--mechanisms` listing and put mechanisms
under the features they implement. He placed 184 of the 363. The scores below use 172 of
those, in 28 features. Mixed mechanisms, described below, are among the ones left out.

**Two questions are asked of every clustering.**

- **Is a feature's code kept together?** For each feature, find the cluster that holds the
  most of its mechanisms, and count how many it holds. The claim-chart feature has 24
  mechanisms. If one cluster held all 24, that would be perfect (though a given user might
  actually be interested in a slice of the feature and not the entire thing). In fact they
  are spread
  over six narrow clusters. The score, called **together**, is the share of all mechanisms
  that are in their feature's best cluster.
- **Is a cluster about one thing?** For each cluster, find the feature that most of its
  mechanisms belong to, and count them. A cluster that is half claim charts and half
  browser interface is a cobbled-together Frankenstein monster. The score, called **pure**,
  is the share of all mechanisms that belong to their cluster's main feature.

The two pull against each other. One giant cluster keeps every feature together and is pure
for none. A cluster for every mechanism is perfectly pure and keeps nothing together. So a
third number combines them: the **agreement score** (its usual name is the [adjusted Rand
index](https://en.wikipedia.org/wiki/Rand_index#Adjusted_Rand_index)). It is 0 when the 
clusters match the feature list no better than chance, and 1 when they match it exactly.

Each score is also computed for the same clusters with the mechanisms shuffled among them.
That shows what chance alone would give.

**Reasons to be careful with this yardstick.**

- It is one person's list for one codebase, and that person is responsible for the code.
- Eight of the 28 features have only one mechanism, and one mechanism is always "together".
- Five of the 41 features have no mechanism of their own at all, for example the leaving out
  of test code. No clustering of mechanisms can show them.
- 25 of the 363 mechanisms are mixed. They were built from functions that share a word in
  their names, and the word has several uses. One built on "catalog" holds a catalog of
  commands, a catalog of exports and a catalog of prompts. A method that places whole
  mechanisms cannot place these correctly. They are left out of the scores, and leaving
  them in changes the scores by a point at most.

## What has been found so far

All of these results are for CodeExam's own code, 363 mechanisms, measured on 2026-11-22
unless another date is given.

### Broad and narrow clusters

| | together | by chance | pure | by chance |
|---|---|---|---|---|
| 12 broad clusters | 75% | 35% | 48% | 21% |
| 45 narrow clusters | 58% | 24% | 74% | 33% |

Broad clusters keep a feature's mechanisms together, and each holds several features.
Narrow clusters are mostly one feature each, and they split the larger features:

- Small features come through whole or nearly whole. Vocabulary, digests, and running with
  no network connection each sit in one narrow cluster. Multi-term search has 6 of its 9
  mechanisms in one.
- Large features are split. Pseudo-claims (21 mechanisms) is spread over seven narrow
  clusters, claim charts (24) over six, and structural search (19) over four.

### The number of clusters matters little

Between 20 and 60 clusters the agreement score hardly moves: 0.37 at 28 clusters, 0.39 at
35 and at 40, 0.36 at 45, and 0.35 at 60. At 35 to 40 clusters, about 60% of a feature's
mechanisms are together and clusters are about 70% to 75% one feature. The author's guess
before any measurement was 35 to 40 clusters, and his own list has 41 features.

### Of the techniques that work from embeddings, the one already in use was best

Each of these standard clustering techniques was run on the same mechanism embeddings.

| technique | clusters | largest cluster | together | pure | agreement |
|---|---|---|---|---|---|
| hierarchical, Ward's method | 40 | 23 | 60% | 74% | 0.39 |
| k-means (average of 20 runs) | 40 | 45 | 61% | 64% | 0.33 |
| hierarchical, complete linkage | 45 | 50 | 59% | 60% | 0.27 |
| hierarchical, average linkage | 45 | 223 | 83% | 36% | 0.05 |
| hierarchical, single linkage | 45 | 316 | 89% | 24% | 0.00 |
| DBSCAN (four settings) | 1 to 6 | 253 or more | 96% or more | 20% or less | 0.01 |

- Ward's method works best here. k-means is a little behind, and its score moves by
  about 0.05 from one run to the next, so smaller differences mean nothing.
- The last three techniques put most of the codebase into one huge cluster. They look for
  gaps between clumps, and there are none. Every mechanism in CodeExam is moderately
  similar to every other. So the code does not fall into features on its own, and any
  division into clusters is partly imposed.

That last point probably holds for any codebase that is a single project, since its parts
share helpers, vocabulary and conventions. It has been checked on CodeExam only. It does
not mean there are no features to find: Ward's method finds them at two to three times the
rate of chance. It means three things for the goal of surfacing features automatically:

- The boundaries between features are blurred. Some mechanisms sit between two features,
  and where they are put is close to arbitrary.
- Nothing in the data says how many features a codebase has. The number of clusters has to
  be chosen, by a rule of thumb or by the user.
- A clustering cannot check itself. It always returns clusters, good or bad, so its quality
  can only be judged against something outside it, such as a hand-made list or a reader.

### Mechanisms cluster better than single functions

Clustering needs something to cluster. One could skip mechanisms and cluster the 2,003
functions directly. That was tried, and it scored lower: agreement 0.27 to 0.28, against
0.39 for mechanisms. Only about 60% of a mechanism's functions stayed in one cluster.

So mechanisms are doing useful work. A mechanism already says "these functions share a
class, a file or a name", and averaging over several functions smooths out the oddities of
each one. One caution: the feature list is written in mechanisms, so this test favours
them.

### Who calls whom is as informative as what the code says

Everything above measures similarity from the function texts, that is, from what the code
says about itself. Another signal uses no words at all: which mechanisms call which.

| similarity measured from | agreement (average over 28 to 45 clusters) |
|---|---|
| function texts only | 0.38 |
| function texts, with calls given three-tenths of the weight | 0.43 |
| calls only, with no embeddings at all | 0.37 |
| function texts, with same-directory given one-fifth of the weight | 0.31 |

- Calls alone recover the features about as well as the texts do.
- The two together are a little better than either alone. The gain is small and uneven:
  the score for one mix can differ by as much as the gain between one number of clusters
  and the next.
- Favouring mechanisms in the same directory makes the result worse. CodeExam's features
  cut across its directories.

### A second technique: carving by who calls whom

This is one test, run on 2026-11-23. It is reported here because it did better than
everything above, and it should be read as a first result.

**What the technique is.** The clustering described so far gives each mechanism a position,
its embedding, and merges the mechanisms that sit nearest each other. The second technique
starts from links. Draw a line between two mechanisms whenever a function in one calls a
function in the other, and make the line heavier the more such calls there are. Then look
for **communities**: sets of mechanisms with many lines among themselves and few to the
outside. This is called community detection, and the standard method used here is the
[Louvain method](https://en.wikipedia.org/wiki/Louvain_method).

**How it differs from what was used before.**

| | clustering by embeddings (above) | community detection on calls |
|---|---|---|
| works from | the function texts, turned into embeddings | which mechanisms call which; no text and no model of any kind |
| puts two mechanisms together when | their texts are similar | they call each other more than they call the rest |
| number of clusters | chosen directly | not chosen directly; a "resolution" setting makes communities larger or smaller |
| same result every run | yes | nearly; it varies a little, so the figures are averages of ten runs |
| typical failure | scatters a feature whose parts are worded differently | merges features that share the same underlying code |

**What it scored.** Each row is at its best resolution setting.

| what is carved | communities | together | pure | agreement |
|---|---|---|---|---|
| clustering by embeddings, Ward's method (from above) | 40 | 60% | 74% | 0.39 |
| calls between mechanisms | 34 | 76% | 70% | 0.57 |
| calls between single functions | 45 | 67% | 63% | 0.39 |
| text similarity only, each mechanism linked to its 5 nearest | 25 | 73% | 69% | 0.51 |
| calls and text links together | 21 | 82% | 73% | 0.62 |

- Community detection does better than Ward's method even when given only text. So part of
  the gain is the technique and not the calls.
- Calls alone are a little ahead of text alone, by not much more than the difference
  between one run and the next (about 0.04).
- Calls and text together did best.
- Mechanisms again beat single functions.

**An example.** The feature list puts 19 mechanisms under imports, exports, bill of
materials and copyrights. Community detection on calls put all 19 into one community of 24.
Ward's method spread them over four clusters, the largest holding 13. The other five
members of the community show what calls bring along: the argument parser and the main
entry file are there because those commands call them, and not because they are about
imports.

**Where it does worse.** One community of 46 mechanisms joins structural search to plain
text search and file browsing, because all of them use the same index lookup code. Another,
of 22, holds digests, vocabulary, AI/ML detection and general utilities.

**Reasons to be careful.**

- The best of nine resolution settings was picked for every row after seeing the scores,
  which flatters all of them. Across settings that give 20 to 60 communities, calls between
  mechanisms scored 0.40 to 0.57 and Ward's method 0.35 to 0.39.
- It has been run on CodeExam only.
- Eight mechanisms have no calls to or from another mechanism, and each comes out as a
  community of one.
- Calls are matched by name only.

### Functions that are copies of each other usually land together

CodeExam has commands that find duplicate functions (`--near-dupes`, `--struct-dupes`,
`--func-dupes`). When two duplicates sit in different files, do they end up in the same
broad cluster? This was measured on four codebases on 2026-11-21. At that date a
mechanism's embedding was the plain average of its functions' embeddings. The adjustment
for function length and shared helpers, described in step 3 of
[How the clusters are made](#how-the-clusters-are-made), was added the next day, and this
measurement has not been repeated with it.

- Functions with identical bodies: 69% to 94% of pairs.
- Functions with the same structure under different names: 50% to 73%.
- Two functions picked at random from different files: 4% to 19%.

### Other codebases, briefly

These also date from 2026-11-21, before the adjustment in step 3. They have not been
repeated with it.

- **Clusters are not the directory tree restated.** Agreement between the broad clusters
  and the directories is low: 0.08 for CodeExam, 0.20 for ExoPlayer 3, and 0.08 for Bram.
  Narrow clusters in ExoPlayer often are a directory: 287 of 500 are four-fifths or more
  one directory.
- **Codebases mixed together mostly come apart again.** The mechanisms of three unrelated
  JavaScript codebases were mixed and then clustered. 93% of mechanisms landed in a broad
  cluster that was mainly their own codebase (63% by chance). But asking for exactly three
  clusters did not give back the three codebases.
- **Loosely coupled parts of one index are kept apart unevenly.** `--overview` reports when
  an index looks like a collection of loosely coupled parts and not one project. The
  measurement asks what share of mechanisms sit in a cluster that is mainly their own part.
  On four such indexes, where the parts are the large top-level folders of one repository
  (Apache Spark, Solana, Hugging Face's text-generation-inference, and a token-contract
  project), broad clusters scored 82% to 93%, against 45% to 78% by chance. On a fifth,
  which is five separate repositories from one organization with a common purpose, placed
  in one folder, broad clusters scored 75% against 66% by chance. That is hardly better
  than chance, and the reason may be that those repositories really are related. Narrow
  clusters did well on all five: 90% to 95%, against 57% to 78%.
- **Code cited for a patent claim is less scattered than chance.** In eight claim charts
  filed in court, the functions cited for one claim (typically five) fell in a median of
  two broad clusters and three narrow ones. The same number of functions picked at random
  fell in 5.3 and 6.3. A party's claim chart is advocacy and not an answer key, so this
  shows only that cited code tends to sit close together.

## What this suggests about mechanisms themselves

The experiments were about clustering mechanisms, and they also say something about how
mechanisms are found. None of the changes below has been made or tested.

- **Keep mechanisms.** They cluster better than single functions do, so they carry
  information that the functions alone do not.
- **Calls are mostly unused in finding mechanisms.** Only a command's mechanism is built by
  following calls: the handler and what it calls, two levels down. Mechanisms built from a
  class, a file or a shared word take no account of who calls whom. Since calls recover
  features as well as the function texts do, they could be used in three ways:
  - to split a mechanism whose functions never call one another and have dissimilar texts
  - to build mechanisms from an entry point and what it calls in codebases that have no
    commands, where today no mechanism is built that way
  - to attach a function that is in no mechanism to the mechanism that calls it most
- **Mechanisms built on a shared word are where the mixed ones come from.** The word is
  matched anywhere inside a function name, so `claim` also matches `_printDisclaimer`, and
  one word can have several meanings (`catalog`). Matching whole words, and splitting such
  a mechanism when its functions' embeddings fall into separate sets, are the two obvious
  repairs.
- **A mechanism's embedding should not be a plain average.** Step 3's weighting, by
  function length and against shared helpers, is used by `--carve clusters` and nowhere
  else.
  When a mechanism is the query (`id:m70`), `--embed-distance` and `--semantic-search`
  still use the plain average of its functions' embeddings.
- **Some functions are in no mechanism**, as listed under
  [Known weaknesses](#known-weaknesses).

## What is wanted from clustering, and where each point stands

| what is wanted | status | why |
|---|---|---|
| Works by embedding, and can run with no network connection | **met** | A small embedding model on your own machine. No language model is used anywhere. Only one embedding model, EmbeddingGemma, has been tested. |
| Uses known machine-learning (ML) clustering techniques | **partly** | Hierarchical clustering (four variants), k-means and DBSCAN were tried, and community detection has had one test. HDBSCAN and spectral clustering were not tried. |
| Is not thrown off by synonyms or rewording, since it should reflect what code does and not how it is named | **largely untested** | No test has renamed the code and clustered it again. One indirect sign: clustering by calls alone uses no words and scores at least as well. |
| Gives a reasonable number of clusters: not one huge cluster, and not one for every file | **open** | The scores are flat from 20 to 60 clusters, so the data does not choose a number. One broad cluster is too large. |
| Keeps loosely coupled collections of code apart | **partly** | Narrow clusters do on all five collections measured. Broad clusters do on four and barely beat chance on the fifth. See "Other codebases" above. |
| Tells the user something that was not obvious from the directory structure | **met by broad clusters** | Low agreement with directories on three codebases. |

## Questions not yet answered

- **Will a reader find what they came for?** This is the real test, and it has not been
  run. No one other than the people who made the feature list has read a clustered listing.
- **Does clustering improve pseudo-claims?** A pseudo-claim written from a whole cluster
  might be closer to the breadth of a real claim. Not tried. The one sign so far is the
  claim-chart measurement above: the code for a claim fits in about two broad clusters, so
  a broad cluster is roughly claim-sized and a narrow one is smaller.
- **Can a list of a codebase's concepts guide a user into the clusters?** `--concepts` lists
  them (since 2026-11-23), each with the number of mechanisms named for it, and its closing
  lines send the reader to `--carve`. Since 2026-11-24, `--concepts --carve calls` has each row also say which
  section of `--carve calls` holds the concept's mechanisms best and what share of them is
  there (`[3.3: 43%]`), or `[spread]` when no section does better than a random pick;
  `--concepts --carve clusters` uses the cluster sections. On seven codebases 39% to 89% of the concepts with two or more mechanisms had such a
  section under calls, and 37% to 95% under clusters on the five that have embeddings. Whether that leads a reader to the right code has
  not been tested. How the
  concepts are found and how often they are right is on
  [`CODEEXAM_CONCEPTS.md`](CODEEXAM_CONCEPTS.md).
- **Will a reader see anything surprising?** A good listing would show the familiar
  features and also some thought-provoking lower-level constructs: what the code actually
  does, as against what its source says it does. Headings that are word lists surprise
  nobody. Clustering by calls is the nearest thing here to "what the code does".
  See [`CODEEXAM_STRUCTURAL_SEARCH.md`](CODEEXAM_STRUCTURAL_SEARCH.md).
- **Are mechanisms the right thing to cluster?** The evidence is mixed. Mechanisms beat
  single functions. But the mixed mechanisms are a fault in how mechanisms are found, and
  some functions are in no mechanism.
- **Is clustering the right approach at all?** The mechanisms form a continuum with no
  natural gaps, and calls do as well as embeddings. Carving a codebase by who calls whom is
  the older approach, and on this evidence it is at least as good. A technique made for
  that purpose has had one test, described under
  [A second technique](#a-second-technique-carving-by-who-calls-whom), and did better than
  clustering by embeddings. The two need not be rivals: calls and text used together scored
  best.

## Known weaknesses

- **One broad cluster is a junk drawer**: 84 of the 363 mechanisms when the scores were
  taken, 61 in the listing shown above. Under
  the second technique the largest community holds 30 to 45.
- **The clusters are not stable.** When they were made again from 80% of the mechanisms,
  on three codebases, the result agreed with the full run only 0.50 to 0.67, where 1 is
  the same clusters (2026-11-19). Smaller changes show the same thing: letting 32 more
  functions into the mechanisms, and taking ruled comment lines out of 65 function texts,
  both on 2026-11-23, each rearranged the broad clusters, as described
  under [What a clustered listing looks like](#what-a-clustered-listing-looks-like), and
  took the second technique from 21 sections to 20. The 80% test has not been run for the
  second technique,
  where two runs differ unless they are given the same seed.
- **Not every function takes part.** Of CodeExam's 2,797 functions outside test code, 803
  have no embedding. 709 of them are one to three lines long and are left out by rule. 62
  have a generic name (`main`, `init`, `get`, `run`, a class constructor) and are left out
  of every mechanism. 32 are the second definition of a name within one file.
  `--show-function-text` marks them. (Those figures are for the index the scores were
  measured on. Since 2026-11-23 a second definition is reached, and a rebuilt mechanisms
  file holds the generic-named functions of four lines or more in their file's mechanism.) The left-out functions are spread across the
  codebase and are not mainly the browser interface: 21% of the functions under `public/`
  have no embedding, against 24% under `src/commands/`, 30% under `src/core/` and 43% under
  `scripts/`.
- **Function texts contain generic identifiers** such as `push`, `slice` and `console`,
  which appear in many functions. How far they pull unrelated functions together has not
  been measured. One such thing was found and removed on 2026-11-23, the ruled lines of
  banner comments, and removing it changed the clusters visibly (above).
- **Calls are matched by name only.** Two different functions with the same name count as one.
- **The CodeExam index used is from 2026-11-10.** The feature list refers to mechanisms by
  id, and rebuilding the index would renumber them. Commands added since then are not in
  it.

What has not been tried:

- a second codebase with its own hand-made feature list
- HDBSCAN and spectral clustering
- scoring the second technique on any codebase other than CodeExam (it has been run on
  three others, which have no feature list to score it against)
- a test that renames the code
- descriptions written by a language model as the text that is embedded
- removing generic identifiers from the function texts

## How to run it

`--carve` (experimental, since 2026-11-23) prints an index's mechanisms under numbered
sections and sub-sections. The name says what it attempts: to take an indexed codebase and
carve it along its joints into pieces, giving a list you can run your eye down to find the
codebase's major parts, or the codebase's own words for a part you are looking for. Its
value chooses the technique, which is to say where the cuts are made:

```
ce --index-path <index> --carve clusters
ce --index-path <index> --carve calls
```

- **`clusters`** is the technique most of this page is about: mechanisms whose text is
  alike go together. Sections are the broad clusters and sub-sections the narrow ones (12
  and 45 on CodeExam). It needs the embeddings `--build-embeddings` makes.
- **`calls`** is [the second technique](#a-second-technique-carving-by-who-calls-whom):
  mechanisms that call each other go together. It needs no embeddings.

Neither uses a language model. Each listing opens with a header that says what was done,
the settings and the options that change them, what could not be placed, and how many
sections came out; test mechanisms left out are counted on the closing Tip line, the last
line of the output.

**One feature under each.** The feature list puts five mechanisms under "vocabulary":
`m111`, `m114`, `m115`, `m197` and `m270`. Under `clusters` all five are in one sub-section
of eight:

```
6. multisect, analyze, vocabulary, prompt   (25 mechanisms)
   6.2 vocabulary, vocab, extraction   (8)
       m114   vocab (buildLocalExtractionPromptWithVocab) / vocab [6.2]
       m115   vocab (buildLocalExtractionPromptWithVocab) / vocabulary [6.2]
       m382   [file] build-claim-genre-df.mjs [6.2]
       m326   [file] claim-terms.js [6.2]
       m327   [file] CodeSearchIndex.js / bare [6.2]
       m270   [file] vocabulary.js / corpus [6.2]
       m111   [file] vocabulary.js / other [6.2]
       m197   [file] vocabulary.js / vocabulary [6.2]
```

Under `calls` four of the five are in one sub-section of five:

```
8. vocabulary, digest, infrastructure, server   (22 mechanisms)
   8.2 vocabulary   (5)
       m115   vocab (buildLocalExtractionPromptWithVocab) / vocabulary [8.2]
       m177   [file] utils.js [8.2]
       m270   [file] vocabulary.js / corpus [8.2]
       m111   [file] vocabulary.js / other [8.2]
       m197   [file] vocabulary.js / vocabulary [8.2]
```

The fifth, `m114`, is the vocabulary handed to the prompt that reads a patent claim, and
`calls` puts it in sub-section 3.1 with the claim-search code that calls it. The extras
differ in the same way. Under `clusters` they are other code about terms and how often
they occur. Under `calls` it is a helper file that the vocabulary code calls. This is the
usual difference between the two: `clusters` gathers code that talks about the same thing,
and `calls` gathers code that works together.

Each row ends with its section number in brackets, so that a search of the output for a
name shows which section the row is in.

| option | with | what it does |
|---|---|---|
| `--description` | both | under each row, the sentence a language model wrote for the mechanism (`--describe`), where the index has one |
| `--purpose` | both | under each row, on a line starting `purpose:`, text gathered from comments, strings and call names with no model; often noisy |
| `--brief` | both | headings only |
| `--include-tests` | both | keep mechanisms that are wholly test code |
| `--sections N`, `--sub N` | `clusters` | how many sections and sub-sections |
| `--embed-model <name>` | `clusters` | which embedding model's vectors to use |
| `--resolution X` | `calls` | higher gives more, smaller sections (default 2) |
| `--seed N` | `calls` | another run; one seed always gives one listing |

Things to know before relying on a listing:

- **Which is better is not settled.** On the one feature list, `calls` scores higher
  (above). When three features were compared by hand (the vocabulary one here, and two
  others), `clusters` matched the list as well or better at the level of sub-sections. The
  author ran both on CodeExam, on Bram and on a collection of five repositories, looked for
  code he knew, and found both usable. That is a reading by one person, not a score.
- **The settings were chosen by eye on CodeExam.** On ExoPlayer 3 (7,495 mechanisms)
  `calls` at its default gives a largest section of 550; `--resolution 6` gives 102
  sections with a largest of 268.
- **A large index takes time under `clusters`.** ExoPlayer 3 took 260 seconds the first
  time and 44 after, because the tree is saved in the index.
- **There is no control for it in the browser interface, and no MCP tool.**

These older commands show the pieces the clusters are built from:

| command | what it shows |
|---|---|
| `--toc`, `--mechanisms` | the mechanisms, each with its id. `--sort-by path` orders them by directory. `--sort-by similarity` (since 2026-11-23) orders them so that neighbours are alike, with no headings, using the order `--carve clusters` saved |
| `--show-function-text` | the short text built for each function, and which mechanisms hold it |
| `--embed-distance id:m70` | the mechanisms most similar to one mechanism. This is one line of the comparison that clustering makes for all of them |
| `--semantic-search` | the same embeddings, searched with your own text |

All of these, and `--carve`, are described in [`cli.md`](cli.md). The last three need
embeddings, which `--build-embeddings` makes.

## Related published work

A search on 2026-11-22: twelve web searches, and three abstracts read. No paper was read in
full, and each entry says how far it was checked.

**Clustering used as a step between prose and code.** This is the question that matters
here, and the list is short.

- *Code-topics* (Eyal-Salman, Seriai and Dony, ECSA 2013, and later reports). A code-topic
  is "a cluster of similar classes". Features written in prose are matched to clusters and
  not to single classes. This is the nearest thing found to the idea on this page. *Search
  summary only.*
- Latent semantic indexing and topic models for finding the code for a concept or feature
  (Marcus, Poshyvanyk and colleagues). A prose query goes in and ranked code comes out,
  with topics doing the work of clusters. *Search summary only.*
- Kuhn, Ducasse and Gîrba, "Semantic clustering: Identifying topics in source code",
  Information and Software Technology 49(3), 2007. Clusters code by the vocabulary of its
  identifiers and comments and reads each cluster as a topic. *Search summary only.*
- HGEN (arXiv 2408.05829, 2024) and RepoSummary (arXiv 2510.11039, 2025). Both cluster the
  code and then have a language model write prose for each cluster. They are scored by
  whether the prose traces back to the right files. *RepoSummary's abstract read.*
- Code-Craft (arXiv 2504.08975, 2025). Retrieves code for a prose query through a hierarchy
  of summaries built on a graph of the code. *Search summary only.*

**Clustering code to recover its architecture.** This is a large field with a different
goal: recovering the developers' own module structure, with no prose in view. It is cited
for what it says about methods.

- Bunch (Mancoridis, Mitchell, Chen and Gansner, ICSM 1999) and ACDC (Tzerpos and Holt) are
  the classic techniques. *Bunch's record confirmed; ACDC's venue not confirmed.*
- Garcia, Ivkovic and Medvidovic, "A comparative analysis of software architecture recovery
  techniques", ASE 2013, compared six techniques and found that "even the best of the lot
  has surprisingly low accuracy". Lutellier and others, TSE 2017, found only one technique
  that consistently beat k-means. *Search summaries only.*
- Corazza and others, Empirical Software Engineering 21(1), 2016, weight words by where
  they occur (names, parameters, comments). That is close to CodeExam's function text,
  which does not weight them. *Search summary only.*
- SARIF (arXiv 2311.04643, 2023) combines dependencies, code text and folder structure.
  *Abstract read.*
- Jabeen, Ericsson, Duan and Wingkvist, "What Carries Architectural Signal?", arXiv
  2610.41628, October 2026, found that dependencies beat words on most systems and that a
  plain directory rule reaches 89% to 100%. *Abstract read.*

**How the results here compare.** Calls helping, and calls alone matching text, agree with
that field. So do the modest scores. Directories hurting does not agree: there, directories
are the strongest signal. The likely reason is the target. Those papers score against the
developers' own structure, which the directories express. The feature list here cuts across
the directories on purpose.

**Not found:** published work on automatically locating patent claims embodied in, or practiced by, source code. 
One search returned material from practitioners only, which shows that one search found nothing
and not that nothing exists.

## Where the figures come from

The figures come from scratch scripts and their outputs, kept outside this repository in
`C:\work\scratch\toward-code` on the machine where the work was done. They are named here
so that a later session can find them.

| script | what it does |
|---|---|
| `catalogue-probe.mjs` | mechanism embeddings, the tree, the broad and narrow clusters, headings |
| `features-parse.mjs`, `features-complete.mjs` | read the feature list and mark the mixed mechanisms |
| `features-vs-sections.mjs` | scores one clustering against the feature list |
| `cluster-methods.mjs` | the comparison of techniques |
| `cluster-functions.mjs` | mechanisms against single functions |
| `cluster-mixes.mjs` | texts, calls and directories |
| `call-communities.mjs`, `call-communities-show.mjs` | the second technique, and one run of it written out |
| `carve.mjs` | both techniques as one listing; `--carve` was made from it, and on four indexes (CodeExam, Bram, the five-repository collection, ExoPlayer 3) the command's listings are the same as its, line for line |
| `sections-vs-dirs.mjs`, `sections-vs-collections.mjs`, `dupes-vs-sections.mjs`, `commingle-probe.mjs`, `claim-size-in-tree.mjs` | the duplicates measurement and the other codebases |

The feature list is the author's working file and is not reproduced here.

## Related

- [`CODEEXAM_MECHANISMS.md`](CODEEXAM_MECHANISMS.md): what a mechanism is and how CodeExam
  finds them. [`CODEEXAM_MECHANISMS_TESTS.md`](CODEEXAM_MECHANISMS_TESTS.md): measurements
  of the mechanisms themselves.
- [`CODEEXAM_SEMANTIC_SEARCH.md`](CODEEXAM_SEMANTIC_SEARCH.md): the same embeddings used
  for searching, and more on the function text.
- [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md): prose drafted from code.
- [`CODEEXAM_JARGON.md`](CODEEXAM_JARGON.md): CodeExam's other terms.
