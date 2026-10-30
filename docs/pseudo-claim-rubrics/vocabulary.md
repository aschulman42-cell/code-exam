# Pseudo-claims for CodeExam's vocabulary (rubric page)

A hand rubric: one claim set for the feature, every row cited to the code, used as the fixed
rows a `--pseudo-claims` run is scored against (`scripts/pseudo-claim-rubric-score.mjs`, #353
part (e)). Written 2026-10-29 from Andrew's notes, the drafts of the 10/25, 10/27 and 10/29 runs
and the working tree of 2026-10-29 (`86ef26b` plus the pack work that landed as `f87ec14`);
line numbers move with later commits, function names do not. The scorer reads the `**N.**`,
`(a)` and `wherein` markers under the Set heading and the citations table at the end. The
working notes the scratch original carried (comments answered, what the drafts missed) stay
outside the repository.

**As first written:**

One claim set, Set V, merged from the four drafts and the comments in the vocabulary section
of `pseudo_claim_rubric_notes_102926.txt`, then checked line by line against the code. The
claim text is kept free of code citations; the table at the end maps every element and
dependent to the lines it was written from, with a provenance tag:

- `[A]` Andrew's notes of 2026-10-29;
- `[Cl1]` the Claude run's claim 1, `[file] vocabulary.js / rest` (the text the notes label
  "Pseudo-claim 3": the noise-token, random-string, base64 and cross-corpus-weight claim.
  The file's claim 3 is the prompt-building claim; the quoted text is its claim 1);
- `[Cl4]` the Claude run's claim 4, `vocab (buildLocalExtractionPromptWithVocab) / vocabulary`;
- `[G1]` the ChatGPT run's claim 1, `[file] vocabulary.js / rest`;
- `[G3]` the ChatGPT run's claim 3, `vocab (buildLocalExtractionPromptWithVocab) / vocab`;
- `[Chat]` the two chat transcripts (both agree with the code on every point used);
- `[C]` the code, where no draft or note had it.

Both runs were over `.CE_102726`; line numbers below are the working tree of 2026-10-29, which
matches that index for `src/core/vocabulary.js` (its last change is commit 0fe09a8).

Conventions: a project term appears in parentheses after its plain-language introduction and
is used bare afterward. No examples inside an element. Concept extraction, the prompt
concordance and the overview are other claim sets; this set stops at the ranked list and
names its consumers in one dependent.

---

## Set V: the vocabulary

**1.** A method of identifying, in a body of source code, the terms distinctive to it ("domain
vocabulary"), comprising:

(a) providing an index of the source code holding, for each file, its path and its text, and
a catalog, prepared in advance from other bodies of source code, recording for each of a set
of tokens the number of those bodies in which the token occurs ("cross-corpus catalog");

(b) selecting as documents the files of the index, other than files identified as noise
documents by rules on the file's path or on its contents, and other than files identified by
their extension as prose, markup or data;

(c) extracting from the entire text of each document, comments and string literals included,
every identifier-shaped token, and discarding tokens shorter than a minimum length or longer
than a maximum, tokens in a list of language keywords, tokens in a list of generic programming
words, and tokens written entirely in capital letters;

(d) counting, for each remaining token, the number of documents in which it occurs ("document
frequency") and its total occurrences, and discarding a token that occurs in fewer than a
minimum number of documents or in more than a set fraction of them;

(e) scoring each remaining token as the product of its document frequency, the logarithm of
the ratio of the number of documents to its document frequency (a score of the
term-frequency–inverse-document-frequency kind, "TF-IDF"), a factor increasing with the
token's length, a factor increasing with the number of parts into which the token divides at
case and underscore boundaries, and a weight taken from the catalog that decreases as the
number of other bodies of source code containing the token increases and is floored above
zero, so that a token common across bodies of source code is demoted and not deleted;

(f) determining, for each of a set number of highest-scoring tokens, the documents in which it
occurs most often and, for each such document, the ratio of the token's occurrences to the
document's length ("concentration"); and

(g) withholding, before the highest-scoring tokens are taken, any token whose characters have
the shape of a random string or of an encoded binary payload, and reporting the N
highest-scoring remaining tokens in descending order of score, each with its document
frequency, its total occurrences and its most-concentrated documents,

wherein the terms are identified without a language model.

**2.** The method of claim 1, in which a file is identified as a noise document when its path,
with any backslash read as a slash, or its contents satisfy one or more rules selected from
the group consisting of: a path segment naming a vendored or dependency tree; a path segment
naming compiled build output; a file name that is a dependency lockfile; a path segment
naming a test, example or fixture tree, the segment matched whole so that a name merely
containing the word is not matched; a path marking the file as a member of a package archive;
a path or name marking the file as pseudo-source derived from a binary; and contents
identified as a minified bundle by the file's name, by an average line length above a
threshold, or by any single line longer than a second threshold.

**3.** The method of claim 2, in which a file identified as a noise document remains in the
index and is searched by every other search of the index, the identification excluding it
from the vocabulary only.

**4.** The method of claim 1, in which the extensions identifying a file as prose, markup or
data are those of Markdown, plain text, reStructuredText, YAML and XML files.

**5.** The method of claim 4, further comprising, on request and for the purpose of grouping
candidate mechanisms, building a second vocabulary from the same index in which the prose
and markup files are documents and the XML and noise files remain excluded, the second
vocabulary being held for one run and neither cached nor substituted for the first.

**6.** The method of claim 1, in which an identifier-shaped token is a letter or underscore
followed by letters, digits or underscores; the minimum length is three characters and the
maximum two hundred; the list of language keywords comprises the control-flow, declaration
and type keywords of several languages; the list of generic programming words is a curated
list of several hundred identifiers common to programs in several languages; and a token is
written entirely in capital letters when it is at least four characters of capitals, digits
and underscores beginning with a capital.

**7.** The method of claim 1, in which the minimum number of documents is two and the set
fraction is three fifths of the document count, the fraction never being fewer than five
documents.

**8.** The method of claim 1, in which the logarithm is to base two, the length factor is the
token's length raised to the power three quarters, the parts factor is one plus three tenths
for each part beyond the first and at most two and one half, and the score is rounded to two
decimal places.

**9.** The method of claim 1, in which the weight is one for a token recorded in fewer than two
of the other bodies of source code, and otherwise the logarithm of the ratio of the number of
bodies in the catalog to the number of bodies containing the token, divided by the logarithm
of the number of bodies in the catalog, bounded below by one tenth and above by one; and in
which, when no catalog is present, the weight is one for every token and the method
otherwise proceeds unchanged.

**10.** The method of claim 9, in which the catalog is built by tallying, over the cached
vocabularies of other indexes, the number of indexes in which each token occurs, a token in
fewer than two indexes being omitted, and tallying likewise each part into which a token
divides; the catalog is stored as a file beside the program and loaded once per run; and its
loading, with its counts of tokens, parts and indexes, is announced on the error stream as a
record of what shaped the output.

**11.** The method of claim 1, in which, when the documents yield no token that satisfies the
minimum number of documents, the vocabulary is rebuilt treating the recorded body of each
indexed function as a document, identified by its file and function name, with the function's
line count as the document's length.

**12.** The method of claim 1, in which the counting of step (d) is one pass over the documents
that records counts only; the scoring of step (e) follows; and the most-concentrated documents
of step (f) are found in a second pass over the same documents that counts occurrences only
for the five thousand highest-scoring tokens, keeping for each the five documents with most
occurrences, the counts of the first pass being discarded before the second begins.

**13.** The method of claim 1, further comprising ranking the documents by the sum, over the
reported tokens, of each token's score multiplied by its concentration in the document, and
reporting the ten highest-ranked documents, each with the number of reported tokens
concentrated in it, and the share of the total so distributed that the ten carry.

**14.** The method of claim 1, in which the scored tokens, up to fifteen thousand in descending
order of score, are written to a cache file in the index's directory together with a format
version, the number of indexed files and the time of generation; a later run reuses the cache
when the version and file count match and the cache holds at least one token, and otherwise
rebuilds and rewrites it; the vocabulary is also held in memory for the rest of the run; and
a vocabulary built over a subset of the files is never cached.

**15.** The method of claim 1, in which a token has the shape of a random string when it is at
least twenty-four characters long, contains neither underscore nor hyphen, has vowels in
fewer than twenty-two hundredths of its characters, has capitals in at least one quarter of
its characters, and has a per-character entropy of at least four bits, every condition being
required.

**16.** The method of claim 1, in which a token has the shape of an encoded binary payload
when it is at least sixty-four characters long, contains neither underscore nor hyphen, and
either begins with the encoded signature of a known image format, contains an embedded image
data-URI marker, or consists solely of the base64 alphabet with up to two trailing padding
characters.

**17.** The method of claim 1, in which each withheld token is described, without reproducing
it, by its length, its first two and last two characters, its per-character entropy, its
vowel share and its capital share, and the count of withheld tokens with up to ten such
descriptions is reported where the tokens are served to an agent; and in which a withheld
token already present in the cache file remains there, the withholding acting at the point of
output.

**18.** The method of claim 1, in which N defaults to fifty and is settable, with an option to
report every token, and the report is a table of score, document frequency, total
occurrences, token, and up to three most-concentrated documents with their occurrence counts,
preceded by a line of concepts derived from the tokens and followed by a note of how many
tokens were not shown.

**19.** The method of claim 1, in which the reported tokens are limited, on request, to tokens
containing a given substring without regard to case, or to tokens matching a regular
expression given between slashes.

**20.** The method of claim 1, in which the documents are limited, on request, to files whose
path contains a given fragment without regard to case, the report naming the fragment and the
number of files, and the vocabulary so built being not cached.

**21.** The method of claim 1, in which, on request, the report is the tokens alone, one per
line, with every diagnostic line written to the error stream, so that the output can be
piped into a search.

**22.** The method of claim 1, in which the ranked tokens are also served over a network
interface as rank, token, score, document frequency and total occurrences together with the
derived concepts, and shown as a list in a graphical interface in which selecting a token
searches the indexed files for it and highlights it in the results.

**23.** The method of claim 1, in which the ranked tokens are also served to a language-model
agent as a tool returning, by default, the tokens alone, and on request up to two
most-concentrated files per token with their counts, the tool reporting how many tokens were
withheld and the count shown against the count available.

**24.** The method of claim 1, in which the two hundred highest-scoring tokens are the input to
a method of extracting concepts, being the parts into which the tokens divide; the fifteen
highest-scoring tokens, twelve such concepts, and the documents ranked by the number of
reported tokens concentrated in them are the vocabulary portion of an orientation summary of
the body of source code; and the parts and function names drawn from the tokens form a
concordance supplied to a language model that extracts search terms from prose.

---

## Preamble variants for retrieval testing

Andrew's note asks for phrasings both inside and outside the code's own words. Where each
one occurs:

| phrase | where it occurs | note |
|---|---|---|
| domain vocabulary | CLI header `me:1599`; `docs/MEASURING_IMPORTANCE.md:28` | used in claim 1 |
| distinctive (to this codebase) | `docs/MEASURING_IMPORTANCE.md:26-28`, `docs/UNCOVER_KEY_CODE.md:88`, `docs/CODEEXAM_KEY_FEATURES.md:10` | used in claim 1 |
| domain-specific vocabulary | MCP tool description `src/mcp-server.js:227`; `vo:28` comment | in code |
| salient | `vo:903` ("salient sub-terms"), `me:1605` | in code, but said of concepts, not tokens |
| potentially important concepts | `src/mcp-server.js:988`, `public/list-renderers.js:1875` | in code, said of concepts |
| vocabulary concordance | `vo:1005-1010`, `src/commands/claim.js:588, 696` | in code, but names the prompt rendering, not the ranked list |
| codebase-specific | `src/core/mechanism-ranker.js` (a ranking signal) | in code, another feature |
| domain-distinctive terms | nowhere | the Claude drafter's coinage (Cl1); outside vocabulary |
| terminology | nowhere | outside vocabulary; see "not claimed" on phrases |

---

## Citations and provenance

`vo` = `src/core/vocabulary.js`, `me` = `src/commands/metrics.js`.

| claim | where | provenance |
|---|---|---|
| V1 preamble | `docs/MEASURING_IMPORTANCE.md:26-28` | A (phrase choice), C |
| V1(a) | index `vo:380-381`, `vo:410-412`; catalog `vo:241-275` (path, loader, one load per run); builder `vo:309-343`, which no command calls | A (precondition), G1→C |
| V1(b) | `vo:404-412` (`skipDoc`), `vo:37-60` (`_isNoiseDoc`), `src/utils.js:316` (`TEXT_EXTENSIONS`) | Cl4, Cl1→C |
| V1(c) | `vo:533-540` (keyword and stopword lists, lengths, pattern), `vo:566-575` (the four discards), `vo:543-546` (comments and strings included) | Cl4→C; Chat |
| V1(d) | `vo:576-583` (counts), `vo:595-603` (cutoffs) | Chat→C |
| V1(e) | `vo:604-620` (score), `vo:277-291` (`_crossCorpusWeight`) | Cl4, Cl1, Chat→C |
| V1(f) | `vo:622-709` (top 5,000; second pass; five documents; concentration) | Chat→C |
| V1(g) | `vo:864-907` (`getTopVocabulary`: withhold, sort, slice); `vo:772-806` | Cl4, Cl1→C |
| V1 wherein | `vo` imports no model; `docs/CODEEXAM_MCP.md:60` | C |
| V2 | `vo:43-60`; `src/core/CSI-helpers.js:87-105` (`isMinified`); `src/binstrings.js:71` (`isPseudoSource`) | Cl1, G1, A (Markush form)→C |
| V3 | `vo:37-41`; `test/test_vocabulary.js:6-9` | C |
| V4 | `src/utils.js:316`; `vo:406-409` | A (question), Cl4 dep 8→C |
| V5 | `vo:459-483` (`buildDocInclusiveVocabulary`); `src/core/mechanism-grouper.js:116-131`; `src/argparse.js:1701-1703` | Cl4 dep 9→C |
| V6 | `vo:535-540`, `vo:571-575`; `src/core/structural-fingerprint.js:32` (69 entries); `vo:72-196` (456 entries) | Chat→C |
| V7 | `vo:595-603` | Chat→C |
| V8 | `vo:604-620` | Chat→C |
| V9 | `vo:277-291`; `vo:253-274` (absent catalog is a no-op) | Cl1, G1, Cl4 dep 3→C |
| V10 | `vo:309-343` (`buildCrossCorpusCatalog`); `vo:249-274` (provenance note); the shipped file records 28 indexes, 23,337 tokens and 12,843 parts (file dated 2026-06-19) | G1 (as a step; corrected to a precondition per A), C |
| V11 | `vo:413-444`; `vo:495-515` (`_functionVocabDocs`) | Cl4 dep 2, G3 dep 8→C |
| V12 | `vo:548-583` (pass 1), `vo:633-637` (counts freed), `vo:641-709` (pass 2) | Chat→C |
| V13 | `me:1646-1691` (`computeVocabDensity`, `printVocabDensityRollup`) | G3 deps 2 and 13→C |
| V14 | `vo:345-376` (cache read), `vo:446-466` (cache write, 15,000), `vo:226-228` (path) | Cl4 deps 4 and 5, Chat→C |
| V15 | `vo:772-788`; `vo:723-729` (entropy) | Cl1 deps 3-6→C |
| V16 | `vo:799-806` | Cl1 dep 7→C |
| V17 | `vo:828-844`; `vo:846-863` (containment at output); `src/mcp-server.js:956-983` | Cl1 dep 11→C |
| V18 | `me:1557-1643`; `src/argparse.js:64-79` (`effectiveCount`), `src/argparse.js:1547-1549` | C |
| V19 | `src/core/filter-match.js:1-30, 50`; `vo:869-872` | C |
| V20 | `vo:379-391`; `me:1560`, `me:1584-1595`; `src/argparse.js:593`, `1199-1200` | Cl4 dep 5→C |
| V21 | `me:1561`, `me:1572-1580`; `src/argparse.js:594`; `docs/UNCOVER_KEY_CODE.md:104-105` | C |
| V22 | `src/server.js:2713-2724`; `public/app.js:628-632`; `public/list-renderers.js:1870-1889`; `public/click-handlers.js:202-209` | G3 deps 10-12→C |
| V23 | `src/mcp-server.js:226-237` (schema), `950-996` (handler) | C |
| V24 | `vo:910-920` (`extractConcepts`, top 200); `src/core/overview.js:153-220`; `me:1605-1608`; `vo:1024` (`getVocabularyForPrompt`), `src/commands/claim.js:1340` | A ("uses as dependents")→C |

Tests that already pin rows: `test/test_vocabulary.js` covers V2 and V3 (noise documents,
lines 16-99), V9 and V10 (weights and catalog, 101-150), V16 (base64, 291-330); the
random-string thresholds of V15 are recorded as measured over 925,665 tokens across every
index on this machine (`vo:752-770`), a measurement record, not a claim.

---

## Scores (2026-10-30)

Scored with `node scripts/pseudo-claim-rubric-score.mjs`
`--rubric docs/pseudo-claim-rubrics/vocabulary.md --run <file>` for each run below: the best run claim per run (MET counted twice, PARTIAL once)
among the claims with an anchor that matches a row's cite. MET is a cite match with half the
row's content words present, PARTIAL a cite match with a quarter or the words without the cite;
the overlap is a keyword proxy printed beside every verdict, and the reading stays the human's.
The runs are files in the project root of this checkout, not in the repository; "none" means no
claim in that run meets or partly meets a row.

| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |
|---|---|---|---|---|---|---|
| CE_pseudo_claim_test_102526_720pm_norank.txt (10/25 7:20pm, Claude, 41 claims) | 26 ([file] overview.js) | 0 | 2 | 30 | 7 / 0 / 8 | 3 |
| CE_pseudo_claims_vocab_concept_overview_Claude.txt (10/27, Claude, 18 claims) | 4 (vocab (buildLocalExtractionPromptWithVocab) / vocabulary) | 4 | 7 | 21 | 4 / 1 / 9 | 5 |
| CE_pseudo_claims_vocab_concept_overview_ChatGPT.txt (10/27, ChatGPT, 18 claims) | 4 (vocab (buildLocalExtractionPromptWithVocab) / vocabulary) | 1 | 10 | 21 | 10 / 1 / 6 | 6 |
| gemma4_CE_pseudo_claims_102926.txt (10/29, Gemma 4 on the Asus, 41 claims) | 4 (vocab (buildLocalExtractionPromptWithVocab) / vocabulary) | 1 | 1 | 30 | 13 / 1 / 9 | 4 |
| CE_pseudo_concept_overview_103026.txt (10/30, Claude, 12 claims) | 3 (vocab (buildLocalExtractionPromptWithVocab) / vocabulary) | 1 | 14 | 17 | 10 / 0 / 10 | 3 |
| CE_pseudo_vocab_103026.txt (10/30, Claude, 9 claims) | 1 ([file] vocabulary.js / rest) | 1 | 8 | 23 | 12 / 2 / 6 | 4 |
