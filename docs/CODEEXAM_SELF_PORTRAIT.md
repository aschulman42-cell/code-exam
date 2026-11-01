# CodeExam self-portrait

*CodeExam's `--pseudo-claims` feature, run on CodeExam's own source code (commit `05f0e83`, runs of
2026-10-31 and 2026-11-01, and one local-model run of 2026-10-29): ten claims across nine features,
quoted as drafted. Status as of 2026-11-01; every number on this page carries its date and its run,
and the runs are recorded at the end.*

This page is what CodeExam's `--pseudo-claims` feature says when pointed at CodeExam itself. 
A **pseudo-claim** is a patent-style claim drafted from code rather than from a prose
invention disclosure: CodeExam groups the functions of a codebase into candidate mechanisms, packs
each group's source as evidence, and asks an AI model to write a claim 1 with dependents whose every
element is tied to a function in the pack (this is why some numbered dependents have been skipped over
here, even when referenced from a later-included dependent) . The claim is illustrative drafting, not 
legal analysis; what it is good for is saying, in the claim form's own discipline, what a body of code
*is*. The question this page answers is how CodeExam looks when its own drafter describes its
features, and how that compares with the rubric pages under
[`pseudo-claim-rubrics/`](pseudo-claim-rubrics/): a claim set per feature that Andrew Schulman built by
starting from `--pseudo-claims` output and editing it heavily, on his own judgment of what matters
most in the feature (the human part), with answers from several models in CodeExam's Chat and a
reading of the code beside him.

**How to read a claim here.** Claim 1 is shown with the preamble first and each "limitation" (claim element) 
on its own line, split by CodeExam's own rule (a break after the colon and after each semicolon); the
lettering is the page's, the words are the drafter's. Under it, the dependents a rubric page
credited (or, where no rubric exists, the first three that add a step); the full set is in the run
artifact. The code references each claim was drafted from are summarized to one line, since on this
page they matter less than the claim; they come into their own in the hold-out test, where a claim
is charted against the code with its references withheld. Any comments on a limitation will appear in 
double brackets after it, `[[like this]]`.

---

## CodeExam's Overview feature

*Run of 11/01, group `[file] overview.js`, ranked P1, method claim; 9 dependents drafted, 4 shown; 9
grounded functions: `core/overview.js` (9).*

**1.** A method for generating an orientation summary of a code index, comprising:

(a) receiving a code index comprising a file list, per-file line content, an extension histogram,
and a cached vocabulary of identifier tokens;

(b) computing, from the file list, a language distribution and a set of top-level folder counts by
stripping a longest common directory prefix from each file path and extracting a first path segment
of each resulting path;

(c) determining, from the top-level folder counts, whether the code index represents a collection of
independent projects by testing whether a threshold number of top-level folders each contain at
least a threshold percentage of indexed files;

(d) building a fast orientation record comprising the language distribution, the top-level folder
counts, a total file count, a total line count, and the collection determination, without performing
a corpus rescan or detector scan;

(e) building a deep orientation record by retrieving a ranked vocabulary slice from the cached
vocabulary of identifier tokens, identifying key files by ranking files according to a count of
distinct top-ranked tokens concentrated in each file, identifying entry points from a call graph,
and resolving a source line for each entry point by querying a function index for a definition start
line and, absent a match, scanning per-file line content for a first whole-word occurrence of the
identifier; and

(f) merging the fast orientation record and the deep orientation record into a combined orientation
summary.

**5.** The method of claim 4, further comprising: resolving, for each extracted concept, an example
identifier to a definition file and start line by querying the function index without a file hint,
preferring matches in non-declaration files, and falling back to a first whole-word occurrence in a
hinted file.

**7.** The method of claim 1, wherein identifying entry points comprises retrieving a ranked list of
entry points from the call graph, deduplicating entries sharing an identifier name, filtering
entries whose names contain path separators or internal keyword markers, and partitioning remaining
entries so that non-test entry points precede test entry points.

**8.** The method of claim 1, further comprising: computing a cross-cut fraction of import edges
that cross top-level folder boundaries by scanning a leading portion of each file's line content for
import directives, resolving each import specifier to a top-level folder, and dividing the count of
cross-folder edges by the total count of resolved edges.

**10.** The method of claim 1, further comprising: rendering the combined orientation summary as a
text document comprising a size block, a language block, a concepts block listing each concept with
its example identifier, a key-files block listing each key file with its distinct top-term count,
and an entry-points block, wherein file paths in the key-files block and entry-points block have a
shared display prefix removed.

---

## CodeExam's Overview-by-AI feature

*Run of 10/31, group `[file] ai-overview.js`, ranked P2, system claim; 10 dependents drafted, 4
shown; 7 grounded functions: `core/ai-overview.js` (7).*

**1.** A system for generating a prose orientation of a codebase by driving a cloud language model
agentically over a code-examination index, the system comprising: [[Ideally, this claim would not
be restricted to cloud LLMs. The --overview-by-AI feature works on local GGUF models too, though
with some implementation differences in prompts, MCP tools, etc. Contrast the [rubric for
overview-by-AI](https://github.com/aschulman42-cell/code-exam/blob/main/docs/pseudo-claim-rubrics/overview-by-ai.md).]]

(a) a memory storing an orientation prompt, a permitted tool list, and a spend ceiling; and

(b) a processor configured to: spawn a model-context-protocol server process loaded with the
code-examination index and connect an in-process client to the server process;

(c) obtain from the server process a set of callable tools and filter the set to those whose names
appear in the permitted tool list;

(d) issue the orientation prompt together with the filtered tool set to a selected cloud language
model, wherein the selected cloud language model is one of an Anthropic model, an OpenAI-compatible
model, or a Gemini model;

(e) execute, on behalf of the cloud language model, successive tool calls against the server
process, accumulate per-turn token usage across each tool call, and estimate a running cost in
United States dollars from the accumulated usage;

(f) halt the agentic loop and raise a spend-cap error when the estimated running cost exceeds the
spend ceiling; and

(g) collect the prose orientation produced by the cloud language model upon completion of the
agentic loop.

**3.** The system of claim 2, wherein the grounding clause instructs the cloud language model to
base the orientation solely on tool results surfaced from the code-examination index and to refrain
from asserting external knowledge as fact about the codebase.

**5.** The system of claim 1, wherein the permitted tool list comprises a fixed enumeration of
code-examination tool names including overview, vocabulary, digest, stats, list_files, list_classes,
entry_points, hotspots, models_used, command_catalog, regex_search, search, call_tree, struct_dupes,
show_file, and referenced_resources.

**8.** The system of claim 7, wherein the processor is further configured to capture the text result
of a first invocation of a models-used tool and the text result of a first invocation of an overview
tool and incorporate both into an evidentiary footer appended to the prose orientation.

**10.** The system of claim 1, wherein the processor is further configured to generate a replacement
question list by issuing a prompt that quotes the prose orientation with lines beginning with a
circled-i character removed, together with a current question list, and instructing the cloud
language model to produce at most five new questions whose subjects differ from those of the current
question list.

---

## CodeExam's vocabulary feature

*Run of 11/01, group `vocab (buildLocalExtractionPromptWithVocab) / vocabulary`, ranked P1, system
claim; 9 dependents drafted, 3 shown; 6 grounded functions: `core/vocabulary.js` (6).*

**1.** A system for building a vocabulary of identifier tokens from an indexed source-code corpus
and formatting that vocabulary for a large-language-model prompt, the system comprising:

(a) a memory storing an index comprising a plurality of source-code files and, for each file, a
corresponding file content and a line-count; and

(b) a processor configured to: receive the index and scan the file contents in two passes to
compute, for each identifier token extracted by a regular-expression match against the file
contents, a document frequency, a total occurrence count, and a TF-IDF-derived score, while
excluding tokens that match a programming-stopword set, that match a structure-keyword set, that
fall outside a minimum and maximum token-length range, or that consist entirely of uppercase
characters;

(c) filter the scored tokens by withholding any token that satisfies a random-string or base64-blob
detection test before ranking, and rank the remaining tokens by descending score to produce a top-N
vocabulary;

(d) split each top-N compound token into sub-tokens, aggregate a weighted score for each sub-token
across its parent tokens using a cross-corpus catalog to apply graded inter-corpus weighting, and
collect representative parent-token examples for each sub-token; and

(e) format the sub-tokens and a set of function names drawn from the index into a concordance string
in either a compact format comprising a comma-separated sub-token list or a rich format comprising
sub-tokens with representative parent-token examples and function names with associated file
references, for inclusion in a large-language-model prompt.

**2.** The system of claim 1, wherein the processor is further configured to load the vocabulary
from a cache file when the cache file exists, a stored version field matches a current schema
version, and a stored file count matches a current count of files in the index, and to skip the
two-pass scan when the cache is loaded successfully.

**5.** The system of claim 1, wherein the processor is further configured to restrict the scan to
files whose paths contain a caller-supplied path-filter substring, and to compute the vocabulary
over only those matching files without writing the result to the cache.

**7.** The system of claim 1, wherein the processor is further configured to include documentation
files having text extensions as documents in the two-pass scan when a doc-inclusive mode is
requested, while continuing to exclude files having an XML extension and files identified as noise
documents.

---

## CodeExam's concepts feature

*Run of 10/29 on the Asus, Gemma 4 12B (`gemma-4-12b-it-Q4_K_M.gguf`, a local GGUF model, no cloud
call), group `[file] vocabulary.js / rest`, unranked, method claim; 7 dependents drafted, 3 shown; 0
grounded functions in that run: none of the model's citations resolved, and a re-ask run of 10/30 on
the same machine recovered 15.*

**1.** A method for extracting and ranking domain-specific concepts from a vocabulary, comprising:

(a) receiving a set of vocabulary entries;

(b) filtering the set of vocabulary entries to exclude tokens identified as random strings or base64
blobs;

(c) iteratively decomposing each filtered token into sub-tokens;

(d) calculating a score for each sub-token by summing a parent-token score multiplied by a
cross-corpus weight;

(e) discarding sub-tokens that appear in a predefined percentage of corpora;

(f) ranking the scored sub-tokens to identify a set of top concepts; and

(g) associating each top concept with a representative example identifier selected from the set of
vocabulary entries that contain the sub-token, wherein the representative example identifier is
selected based on a preference for identifiers that resolve to function matches.

**4.** The method of claim 1, wherein calculating the cross-corpus weight comprises computing a
value based on the logarithm of the ratio of a total index count to a token's document frequency.

**7.** The method of claim 1, wherein associating each top concept with a representative example
identifier comprises selecting an identifier that resolves to a function match from a list of
candidates sorted by score.

**8.** The method of claim 1, further comprising: generating a label for each top concept by
concatenating the concept name with the representative example identifier in parentheses.

Why this claim is here: it came from a twelve-billion-parameter model running on a laptop GPU with
no network connection, the setting CodeExam supports for code under a protective order. On Andrew's
reading of 2026-10-29 it was the best concepts claim any drafter had produced, the cloud models
included: it names the feature's own steps in order (the random-string and base64 filters, the
sub-token decomposition, the cross-corpus weight, the example identifier). Two cautions go with it.
In that run none of its citations resolved, so the keyword scorer, which credits a row only through
a grounded citation, reads it 0 / 2 / 21; the re-ask run of 2026-10-30 that recovered 15 grounded
functions scores 1 / 7 / 15 under the best-line rule (asus-CC's report on #353). And its dependent
2, not shown, states the vowel-density test backwards. A local model can draft the portrait; the
grounding and the reading still have to be checked.

*Run of 10/31, group `[file] vocabulary.js / rest`, ranked P2, system claim; 13 dependents drafted,
3 shown; 9 grounded functions: `core/vocabulary.js` (9).*

**1.** A system for filtering non-domain tokens from a software vocabulary index, the system
comprising:

(a) a memory storing a vocabulary index comprising identifier tokens extracted from a corpus of
source files, and a cross-corpus catalog comprising a document-frequency map for tokens and a
document-frequency map for sub-tokens across a plurality of indexes; and

(b) a processor configured to: receive a candidate token from the vocabulary index;

(c) determine whether the candidate token is a random string by computing a vowel density and an
uppercase density of the candidate token and, when the candidate token has a length of at least a
threshold length, contains no separator character, has a vowel density below a first threshold
ratio, has an uppercase density at or above a second threshold ratio, and has a Shannon entropy per
character at or above an entropy threshold, classifying the candidate token as a random string;

(d) determine whether the candidate token is a base64 blob by testing whether the candidate token
has a length of at least a second length threshold, contains no separator character, and matches a
pure base64 alphabet pattern;

(e) suppress the candidate token from output when the candidate token is classified as a random
string or as a base64 blob; and

(f) for each non-suppressed token, compute a cross-corpus weight by applying a logarithmic inverse
document-frequency formula against the cross-corpus catalog, floored at a minimum weight, to demote
tokens that recur across a plurality of indexes while retaining tokens distinctive to the corpus.

**12.** The system of claim 1, wherein the processor is further configured to, upon suppressing a
candidate token, generate a redacted fingerprint of the suppressed token comprising the token
length, a prefix-and-suffix hint of at most four characters, the Shannon entropy per character, the
vowel density, and the uppercase density.

**13.** The system of claim 1, wherein the processor is further configured to extract concepts from
the vocabulary index by splitting non-suppressed tokens into sub-tokens, accumulating a score for
each sub-token as a sum of parent-token scores weighted by the sub-token cross-corpus weight, and
ranking sub-tokens by accumulated score to produce an ordered list of corpus-distinctive concepts.

**14.** The system of claim 13, wherein the processor is further configured to associate each
concept with an example identifier by selecting, from compound tokens that contain the concept as a
sub-token, the highest-scoring token that resolves to a match in a function index.

The cloud drafter's best on the same rubric, from the same group of functions: it describes the
token filters that concepts extraction runs first, and reaches concept extraction itself only in
dependents 13 and 14.

---

## CodeExam's multisect search

*Run of 10/31, group `multisect (parseMultisectTerms)`, ranked P2, method claim; 9 dependents
drafted, 3 shown; 4 grounded functions: `commands/multisect.js` (2), `core/multisect.js` (1),
`server.js` (1).*

**1.** A method for multi-term intersection search over a code index, comprising:

(a) receiving a string of semicolon-separated search terms;

(b) parsing the string into a plurality of term objects by splitting on semicolons, wherein each
term object comprises a compiled regular expression, a negation flag, and a hardness flag indicating
whether the term gates the result set;

(c) searching the code index with the term objects to identify, for each of a plurality of scope
levels comprising function scope, file scope, and folder scope, candidate scopes in which all
hard-required term objects match and no hard-negated term object matches;

(d) scoring each candidate scope by computing an inverse-document-frequency score derived from the
number of files in the index in which each term matches; and

(e) ranking and returning the candidate scopes within each scope level in order of decreasing
inverse-document-frequency score, wherein a candidate scope at a narrower scope level suppresses a
candidate scope at a broader scope level that is covered by the narrower scope.

**2.** The method of claim 1, wherein parsing the string further comprises replacing each occurrence
of a doubled semicolon with a placeholder before splitting, and restoring the placeholder to a
literal semicolon in each resulting term object.

**3.** The method of claim 1, wherein a term object whose compiled regular expression is derived
from a slash-delimited token in the string is treated as a regex term, and a term object derived
from any other token is treated as a case-insensitive literal term.

**5.** The method of claim 1, wherein the minimum number of hard-required terms that must match a
candidate scope is set to the count of hard-required term objects when no explicit minimum is
supplied.

---

## CodeExam's claim parser

*Run of 10/31, group `claim (splitClaimElements) / claim / other`, ranked P3, method claim; 7
dependents drafted, 1 shown; 4 grounded functions: `commands/claim-locate.js` (3),
`commands/synonymize.js` (1).*

**1.** A method for splitting a patent claim into constituent elements, comprising:

(a) receiving a claim text representing a single patent claim;

(b) detecting, in the claim text, a structural marker that indicates an element boundary, the
structural marker being one of a formatting marker present in the claim text and a line-based
delimiter derived from the claim text's line breaks;

(c) partitioning the claim text into a sequence of elements at each detected structural marker; and

(d) outputting the sequence of elements, each element being a contiguous span of the claim text
bounded by the detected structural markers.

**8.** The method of claim 1, further comprising: determining whether the claim text is a whole
claim by testing the claim text for a preamble transition keyword followed by a colon that opens the
claim body.

---

## CodeExam's claim charts

*Run of 10/31, group `[cmd] --claim-chart`, ranked P3, method claim; 12 dependents drafted, 3 shown;
16 grounded functions: `commands/claim-chart.js` (13), `commands/claim-locate.js` (2),
`core/llm-runner.js` (1).*

**1.** A method for building a claim chart that maps each element of a patent claim to source-code
evidence merged across a plurality of code targets, comprising:

(a) receiving a claim text and a set of code targets, each target identifying a symbol in a code
index;

(b) resolving, for each element of the claim, a ranked list of candidate targets by querying the
code index up to a budget determined by a count of the elements and a per-element target limit;

(c) sending, for each element, a prompt to a language model that includes the element text and
bodies of the candidate targets, the prompt specifying a machine-parseable verdict label for each
element;

(d) receiving, from the language model, a verdict for each element-target pair and parsing the
verdict label from the model response;

(e) merging the per-element verdicts across all targets by selecting, for each element, the best
verdict label and the citation from the target that the element itself ranked highest among ties;
and

(f) outputting a chart in which each row corresponds to one element of the claim and carries the
merged verdict label and the citation that produced it.

**8.** The method of claim 1, further comprising: after merging, detecting cited targets that are
duplicates of one another by comparing function bodies at the file level and the symbol level, and
recording the duplicate relationship in the chart output.

**9.** The method of claim 1, further comprising: after merging, identifying limitation words in
each element that are absent from the finding text of the citation for that element and recording
those words as unshown qualifiers in the chart output.

**12.** The method of claim 1, further comprising: after outputting the chart for a root claim,
repeating the merging and outputting steps for each dependent claim in a claim family, reusing the
root-claim targets and supplementing with targets nominated by elements added or narrowed by each
dependent claim.

---

## CodeExam's pseudo-claim candidates (the grouper)

*Run of 10/31, group `[file] mechanism-grouper.js / rest / other`, ranked P3, system claim; 11
dependents drafted, 2 shown; 11 grounded functions: `core/mechanism-grouper.js` (11).*

**1.** A system for filtering and grouping candidate functions from a source-code index into
mechanism-labeled clusters, comprising:

(a) a memory storing a source-code index comprising a function index mapping file paths to function
records, each function record including a file path, a start line, an end line, and a function name;
and

(b) a processor configured to: receive a set of candidate function records from the function index
and build, from the candidate function records, a per-file range structure that maps each file path
to a sorted list of function records ordered by start line;

(c) filter the candidate function records by applying a noise-file predicate to each function
record's file path to exclude files matching backup, build-output, or test-suffix patterns, and by
applying a test-attribute predicate to the source lines surrounding each function record's start
line to exclude inline test functions identified by attribute annotations;

(d) gather a ranked concept list from the source-code index by retrieving a vocabulary of identifier
tokens scored by cross-corpus distinctiveness and selecting a top-N slice of that vocabulary as
candidate concept tokens;

(e) assign each remaining candidate function record to a mechanism group by matching the function
record's name tokens against the ranked concept tokens and selecting the highest-ranked matching
concept token as the group label for that function record; and

(f) emit a labeled anchor list in which each mechanism group is represented by a header line
carrying the group label and a set of file-path-and-function-name anchor lines identifying the
member function records that resolve uniquely within the function index.

**5.** The system of claim 1, wherein the test-attribute predicate inspects a window comprising the
declaration line of the function record and the three source lines immediately preceding that
declaration line.

**12.** The system of claim 1, wherein the processor is further configured to, after emitting the
labeled anchor list, detect pairs of mechanism groups whose member function records are dominantly
concentrated in the same file and flag those pairs as candidate semantic echoes in the emitted
anchor list header.

---

## CodeExam's pseudo-claim drafting

*Run of 10/31, group `[cmd] --pseudo-claims`, ranked P3, system claim; 11 dependents drafted, 1
shown; 17 grounded functions: `commands/pseudo-claims.js` (16), `core/mechanism-grouper.js` (1).*

**1.** A system for drafting illustrative pseudo-patent claims from evidence packs of explicit
anchor functions, the system comprising:

(a) a memory storing an index of source-code functions and an anchor group structure associating one
or more file-and-function anchor specifications with a mechanism label and a purpose; and

(b) a processor configured to: receive the anchor group structure identifying the anchor
specifications for a candidate mechanism;

(c) resolve each anchor specification in the anchor group structure against the index to obtain
resolved source-code excerpts;

(d) build a character-budgeted evidence pack from the resolved source-code excerpts by ordering the
excerpts and truncating or dropping individual excerpts to satisfy a per-group total budget and a
per-anchor cap;

(e) supply the evidence pack and the mechanism label to a language model to obtain a draft claim
comprising claim prose and an anchor citation block;

(f) parse the anchor citation block to extract cited file-and-function references;

(g) ground each cited reference against the index to verify that the reference resolves to a known
function or line range; and

(h) emit a claim artifact comprising the draft claim prose, the grounded anchor citations, and a
disclosure of any excerpts dropped or truncated during evidence-pack construction.

**5.** The system of claim 1, wherein the processor is further configured to score a genericity
measure for the anchor group by splitting member identifiers into words and comparing those words
against a vocabulary of mechanism-specific terms, and to order groups for drafting from lowest
genericity to highest.

---

## Against the rubric pages

Seven rubric pages under [`pseudo-claim-rubrics/`](pseudo-claim-rubrics/) hold a claim set per
feature, every row cited to the code; each began as `--pseudo-claims` output and was edited heavily
by Andrew on his judgment of what matters, with Chat answers from several models and the code beside
him. `scripts/pseudo-claim-rubric-score.mjs` reads a run against one: a rubric row is MET when a
claim line (or the union of up to four lines) shares half its content words with the row and cites
the row's file, PARTIAL at a quarter, ABSENT otherwise. Scored 2026-11-01 under the union rule; the
claim shown above is the run's best on each page, the Gemma 4 concepts claim excepted. Two features
above have no rubric page yet.

| Feature | Rubric page | Claim shown | MET / PARTIAL / ABSENT |
|---|---|---|---|
| The Overview | [overview](pseudo-claim-rubrics/overview.md) | 11/01 claim 3, method | 9 / 10 / 5 of 24 |
| Overview by AI | [overview-by-ai](pseudo-claim-rubrics/overview-by-ai.md) | 10/31 claim 92, system | 3 / 9 / 17 of 29 |
| Vocabulary | [vocabulary](pseudo-claim-rubrics/vocabulary.md) | 11/01 claim 2, system | 6 / 13 / 13 of 32 |
| Concepts (Gemma 4, 10/29) | [concepts](pseudo-claim-rubrics/concepts.md) | 10/29 claim 1, method | 0 / 2 / 21 of 23 |
| Concepts (Claude, 10/31) | [concepts](pseudo-claim-rubrics/concepts.md) | 10/31 claim 8, system | 4 / 6 / 13 of 23 |
| Multisect search | [multisect](pseudo-claim-rubrics/multisect.md) | 10/31 claim 193, method | 3 / 24 / 11 of 38 |
| The claim parser | none yet | 10/31 claim 105, method | — |
| Claim charts | none yet | 10/31 claim 135, method | — |
| Pseudo-claim candidates (the grouper) | [pseudo-claims-candidates](pseudo-claim-rubrics/pseudo-claims-candidates.md) | 10/31 claim 78, system | 4 / 5 / 14 of 23 |
| Pseudo-claim drafting | [pseudo-claims-drafting](pseudo-claim-rubrics/pseudo-claims-drafting.md) | 10/31 claim 174, system | 4 / 8 / 18 of 30 |

Rubric pages planned next (Andrew, 2026-11-01), with no claim shown here yet: air-gapped operation,
resources referenced, the AI-pipeline detector and one more AI/ML detector such as LLM prompts
(which may not yet work well enough), Chat, Struct Diff and/or Notable Function-Structure Matches,
and the claim loop (the HOF self-test).

Two of the seven pages were reached only by the second run: the ranker had put the Overview builder
and the vocabulary group at P1, below the default drafting floor of P2, so the 10/31 run had no
Overview claim at all and only a remainder group for the vocabulary (1 / 10 / 21). Drafted alone on
11/01 they score 9 / 10 / 5 and 6 / 13 / 13, the two best cells on this page. The floor exists for
cost and the rank tag is a surface heuristic by design; one sample, recorded here as a finding.

**Gemma 4 on this task.** The 10/29 local run drafted 41 method claims from the same codebase (12 of
41 inside the litigated shape band, median distance 0.30). On the keyword scorer its best pages were
multisect (4 / 23 / 11, claim 41) and the Overview (2 / 13 / 9, claim 29); on concepts, vocabulary,
Overview by AI and drafting it scored one MET row or none, in part because many of its citations did
not resolve in that run (23 of 41 claims had no grounded anchor; a 10/30 re-ask run on the same
machine brought that to 1). The concepts claim above is the one Andrew's reading rated best of any
drafter.

---

## A first reading (2026-11-01, the agent's, for Andrew to replace)

Where the set is right: the four groups the ranker put at P3 are the four most CodeExam-specific
mechanisms (the claim chart, the drafter, the claim parser, the grouper), and their claims read as
descriptions of what those commands do rather than of what any code-search tool does. Where it is
generic: the multisect claim is mostly PARTIAL on its rubric because it describes an intersection
search in the vocabulary of any search engine and reaches the feature's own ideas (scope, inverse
document frequency across scopes) only in dependents. What it missed: the 10/31 run at the P2 floor
had no claim for the Overview and none for the vocabulary as a feature, which the rubric pages say
are central; the antecedent check counted 970 unintroduced references across the 198 drafts, so "the
X" without an earlier "an X" is the drafter's most common fault.

---

## How this set was made

- **Index.** `.CE_103126`, built 2026-10-31 at commit `05f0e83` from the tracked `.js` and `.mjs`
files under `src/`, `public/`, `test/` and `scripts/`: 246 files, 126,438 lines.
- **Candidates and ranking** (2026-10-31). `--pseudo-claims --candidates` with no model: 189 groups
of three or more functions, 1,748 members. `--rank` on Claude (claude-sonnet-4-6): 14 calls, $0.32;
P3 4, P2 95, P1 66, P0 24.
- **Drafting** (2026-10-31). The ranked list at the default P2 floor, `--claim-class both
--claims-only`, litigated shape profile: 99 groups, 198 claims, 198 calls, $6.23, 73 minutes. 98 of
198 inside the litigated shape band, median distance 0.29.
- **The two P1 groups** (2026-11-01). `[file] overview.js` and `vocab
(buildLocalExtractionPromptWithVocab) / vocabulary` cut from the ranked list and drafted with
`--min-rank 1`, both classes: 4 claims, $0.17.
- **The Gemma 4 run** (2026-10-29, on the Asus): `gemma4_CE_pseudo_claims_102926.txt`, 41 method
claims, `gemma-4-12b-it-Q4_K_M.gguf` under node-llama-cpp on a laptop GPU, no cloud call and no API
cost; 12 of 41 inside the litigated shape band.
- **Artifacts.** `CE_pseudo_claims_CE_103126_both.txt`,
`CE_pseudo_claims_CE_110126_p1_overview_vocab.txt` and `gemma4_CE_pseudo_claims_102926.txt` (not in
the repository); the claims-only files and their `.anchors.json` sidecars beside the first two.
Triage of the 10/31 run (`--triage`, no model): KEEP 64, REVIEW 83, DROP 51.

Later runs add a record here and may replace a claim above under its feature heading, with the date
and the reason; the page does not grow new sections.
