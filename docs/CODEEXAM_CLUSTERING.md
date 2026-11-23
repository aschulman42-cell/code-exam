# Clustering: can CodeExam sort a codebase into its features automatically?

*A status report on work in progress, as of 2026-11-22. No CodeExam command yet produces the
clusters described here. The experiments were run with scratch scripts that are not part of
the product.*

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

Two limits apply to everything below:

- **Only one codebase has been scored against a hand-made feature list.** A method that
  does best on CodeExam's own code may not do best elsewhere.
- **None of this is in the product.** The figures come from scratch scripts, named
  [at the end](#where-the-figures-come-from), that have no tests of their own.

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
- [What you can run today](#what-you-can-run-today)
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

These are five of the 12 broad clusters made for CodeExam's own code (scratch output,
2026-11-21). Each line gives the cluster's heading, how many mechanisms it holds (the
output calls them "groups"), and where they sit in the source tree.

```
 3. claim, element, format, chart       (39 groups; 64% in src/commands/, 4 directories)
 4. pane, init, render, renderers       (25 groups; 96% in public/, 2 directories)
 5. struct, dupes, matcher, diff        (13 groups; 77% in src/commands/, 3 directories)
 7. extract, name, find, string         (84 groups; 36% in src/commands/, 6 directories)
 9. collect, caller, graph, callees     (21 groups; 62% in src/commands/, 3 directories)
```

Someone who knows CodeExam recognises several of these. Cluster 3 is the claim-chart work,
cluster 4 is the browser interface, cluster 5 is the finding of duplicate functions, and
cluster 9 is the following of calls between functions.

Cluster 7 is the failure. It holds 84 of the 363 mechanisms under four words that say
nothing. It is a "junk drawer": the things that did not clearly belong anywhere else.

Two more points about this listing:

- The headings are only the words that are common in a cluster's function names and rare
  outside it. No one wrote them, and they are not descriptions.
- No command prints this listing yet.

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
6. **Headings.** Each cluster is headed with the words that set its function names apart.

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

### The method already in use was the best of those tried

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
  function length and against shared helpers, exists only in the scratch scripts.
  When a mechanism is the query (`id:m70`), `--embed-distance` and `--semantic-search`
  still use the plain average of its functions' embeddings.
- **Some functions are in no mechanism**, as listed under
  [Known weaknesses](#known-weaknesses).

## What is wanted from clustering, and where each point stands

| what is wanted | status | why |
|---|---|---|
| Works by embedding, and can run with no network connection | **met** | A small embedding model on your own machine. No language model is used anywhere. Only one embedding model, EmbeddingGemma, has been tested. |
| Uses known machine-learning (ML) clustering techniques | **partly** | Hierarchical clustering (four variants), k-means and DBSCAN were tried. HDBSCAN, spectral clustering and community detection on the call graph were not. |
| Is not thrown off by synonyms or rewording, since it should reflect what code does and not how it is named | **largely untested** | No test has renamed the code and clustered it again. One indirect sign: clustering by calls alone uses no words and scores the same. |
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
- **Can a list of a codebase's concepts guide a user into the clusters?** A `--concepts`
  command is proposed and not yet built.
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
  the older approach, and on this evidence it is as good. It has been tried here only in
  the simplest form: the same Ward's method, fed call counts in place of embeddings.
  Methods made for the purpose, which look for sets of functions that call each other more
  than they call outside, have not been tried and should be.

## Known weaknesses

- **One broad cluster is a junk drawer**: 84 of the 363 mechanisms, as shown above.
- **Not every function takes part.** Of CodeExam's 2,797 functions outside test code, 803
  have no embedding. 709 of them are one to three lines long and are left out by rule. 62
  have a generic name (`main`, `init`, `get`, `run`, a class constructor) and are left out
  of every mechanism. 32 are the second definition of a name within one file.
  `--show-function-text` marks them. The left-out functions are spread across the
  codebase and are not mainly the browser interface: 21% of the functions under `public/`
  have no embedding, against 24% under `src/commands/`, 30% under `src/core/` and 43% under
  `scripts/`.
- **Function texts contain generic identifiers** such as `push`, `slice` and `console`,
  which appear in many functions. How far they pull unrelated functions together has not
  been measured.
- **Calls are matched by name only.** Two different functions with the same name count as one.
- **The CodeExam index used is from 2026-11-10.** The feature list refers to mechanisms by
  id, and rebuilding the index would renumber them. Commands added since then are not in
  it.

What has not been tried:

- a second codebase with its own hand-made feature list
- the three other clustering techniques named in the table above
- a test that renames the code
- descriptions written by a language model as the text that is embedded
- removing generic identifiers from the function texts

## What you can run today

No command prints clusters. These commands show the pieces the clusters are built from:

| command | what it shows |
|---|---|
| `--toc`, `--mechanisms` | the mechanisms, each with its id. `--sort-by path` orders them by directory |
| `--show-function-text` | the short text built for each function, and which mechanisms hold it |
| `--embed-distance id:m70` | the mechanisms most similar to one mechanism. This is one line of the comparison that clustering makes for all of them |
| `--semantic-search` | the same embeddings, searched with your own text |

All four are described in [`cli.md`](cli.md). The last three need embeddings, which
`--build-embeddings` makes.

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
