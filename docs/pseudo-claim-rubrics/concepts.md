# Pseudo-claims for CodeExam's concepts (rubric page)

A hand rubric: one claim set for the feature, every row cited to the code, used as the fixed
rows a `--pseudo-claims` run is scored against (`scripts/pseudo-claim-rubric-score.mjs`, #353
part (e)). Written 2026-10-29 from Andrew's notes, the drafts of the 10/25, 10/27 and 10/29 runs
and the working tree of 2026-10-29 (`86ef26b` plus the pack work that landed as `f87ec14`);
line numbers move with later commits, function names do not. The scorer reads the `**N.**`,
`(a)` and `wherein` markers under the Set heading and the citations table at the end. The
working notes the scratch original carried (comments answered, what the drafts missed) stay
outside the repository.

**As first written:**

One claim set, Set C, built from the concepts section of `pseudo_claim_rubric_notes_102926.txt`
(Andrew's draft claim and comments), the concept material scattered through the two
drafters' runs, the two chat transcripts, and the code. The claim text is kept free of code
citations; the table at the end maps every element and dependent to the lines it was
written from, with a provenance tag:

- `[A]` Andrew's notes of 2026-10-29;
- `[G1]` the ChatGPT run's claim 1, back half and dependents 11 to 14;
- `[Cl4]` the Claude run's claim 4, fifth element;
- `[Chat]` the two transcripts (Claude 105-195, ChatGPT 178-361);
- `[C]` the code, where no draft or note had it.

Neither run drafted a standalone concepts claim; the measurement at the end says why.

Conventions as in the vocabulary file. Set C receives the vocabulary of Set V and is received
by Set D's token seed, so each set stops at its own boundary and names the neighbor in one
dependent. "Concept" is the code's own noun and is kept; "discovery" is not used.

---

## Set C: concepts

**1.** A method of identifying, in a body of source code, potentially important concepts,
being the most distinctive roots of its distinctive identifiers, each tied to an identifier
that exemplifies it, comprising:

(a) receiving a ranked vocabulary of the identifier-shaped tokens of the source code, each
token with a score expressing its distinctiveness within the body of source code and across
other bodies of source code, and with the files in which it is most concentrated ("domain
vocabulary"); and a catalog recording, for each of a set of parts of identifiers, the number
of other bodies of source code in which the part occurs ("cross-corpus catalog");

(b) taking a set number of the highest-scoring tokens as parent tokens, withholding any token
whose characters have the shape of a random string or of an encoded binary payload;

(c) dividing each parent token into its parts at case and underscore boundaries, the parts
lowercased, discarding parts shorter than a minimum length and parts in a list of common
prefixes and connectives, a token that does not divide being its own single part, and a
token all of whose parts are discarded contributing its longest part;

(d) discarding any part in a list of generic nouns ("low-discrimination stoplist"), and any
part recorded in the catalog as occurring in at least a set fraction of the other bodies of
source code;

(e) scoring each remaining part by the sum, over every parent token in which it occurs, of
the parent token's score multiplied by a weight taken from the catalog that decreases as the
number of other bodies of source code containing the part increases and is floored above
zero;

(f) collecting, for each part, as candidate examples the parent tokens longer than the part,
kept best score first up to a set number, each with the file in which the parent token is
most concentrated;

(g) selecting a set number of the highest-scoring parts and, for each, an example
identifier, preferring among its candidates one that resolves to a function recorded in an
index of the source code, else the highest-scoring candidate, a part having no candidate
being reported without an example; and

(h) producing a ranked list of the selected parts ("concepts"), each with its example
identifier, the example's file, and whether the example is a function,

wherein the concepts are identified without a language model.

**2.** The method of claim 1, in which the vocabulary received in step (a) is produced by the
method of claim 1 of Set V, the score being that method's score, and the catalog is the
catalog that method provides, in its record of parts.

**3.** The method of claim 1, in which the set number of parent tokens is two hundred, the
set number of concepts is fifteen, the minimum part length is three characters, the
candidates kept per part number five, the set fraction is three fifths, and the weight is
one for a part recorded in fewer than two of the other bodies of source code and otherwise
the logarithm of the ratio of the number of bodies in the catalog to the number containing
the part, divided by the logarithm of the number of bodies in the catalog, bounded below by
one tenth and above by one.

**4.** The method of claim 1, in which a token divides also where a run of capitals ends
before a capitalized word, so that an abbreviation is its own part; leading underscores are
stripped before dividing; and the list of common prefixes and connectives consists of the
verb prefixes, articles and prepositions that recur in compound identifiers across
codebases.

**5.** The method of claim 1, in which the low-discrimination stoplist is the same list that
an instruction to a language model, elsewhere in the program, tells the model to skip when
extracting search terms from prose, so that the two filters agree.

**6.** The method of claim 1, in which the fraction test of step (d) is derived from the
catalog and not declared, and a part absent from the catalog is neither discarded nor
demoted.

**7.** The method of claim 1, in which the withholding of step (b) is performed within the
method even when the parent tokens are supplied already ranked by a caller, because the
example identifier is reproduced verbatim in the list and a random string among the parent
tokens would otherwise appear both as a fragment and whole.

**8.** The method of claim 1, in which the parent tokens are, on request and for the purpose
of grouping candidate mechanisms, the highest-scoring tokens of a vocabulary built with prose
and markup files as documents, that vocabulary being held for one run and not cached.

**9.** The method of claim 1, in which whether a candidate resolves to a function is tested
only for the candidates of the parts selected in step (g), and the result is remembered per
candidate so that no candidate is tested twice.

**10.** The method of claim 1, in which a concept is rendered as the part followed by its
example identifier in parentheses, or as the part alone when it has none.

**11.** The method of claim 1, in which an orientation summary of the body of source code
takes twelve concepts from the two hundred tokens it has already fetched for its own
vocabulary portion, and re-resolves each example identifier to a definition, preferring a
definition outside a type-declaration file, in the example's recorded file, else the largest
body, and falling back to the first line mentioning the identifier in that file, so that
the example leads to the definition and not to an import.

**12.** The method of claim 1, in which a graphical interface lists the concepts as rows,
a row with an example opening the example's file at its line and offering the example
identifier to a context menu, and a row without an example searching the body of source
code for the part.

**13.** The method of claim 1, in which the ranked list is also printed as one line above
the vocabulary table on the command line, returned beside the vocabulary over a network
interface, and returned beside the vocabulary to a language-model agent.

**14.** The method of claim 1, in which twenty-four concepts serve as seeds for grouping
candidate functions into candidate mechanisms, each candidate function being assigned to
the highest-ranked concept its name contains, a concept that is a part of the index's own
name being rejected as a seed, a concept whose functions are both more than a set share of
the candidates and spread over more than a set share of the files being rejected as a
namespace, and a group of fewer than a minimum number of functions being dropped; and in
which this concept seeding is selectable as the sole seeding or, by default, is followed by
class, command and file seeding.

---

## Preamble variants for retrieval testing

| phrase | where it occurs | note |
|---|---|---|
| potentially important concepts | GUI `lr:1964`, MCP `mcp:988`, overview text `ov:~414`, `docs/UNCOVER_KEY_CODE.md:27` | used in claim 1 |
| key concepts (with examples) | CLI `me:1608`; overview comments `ov:~411` | in code |
| salient sub-terms / salient sub-term concepts | `vo:903`, `me:1605` | in code comments |
| corpus-distinctive roots | `vo:905-906`, `me:1605-1606` | in code comments |
| distinctive term-clusters the codebase is organized around | `docs/UNCOVER_KEY_CODE.md:27-28` | doc only; see the finding below |
| most discriminative roots of important vocabulary identifiers | ChatGPT transcript | outside the code; used in claim 1 as "most distinctive roots" |
| concept | the code's noun throughout | kept |

---

## Citations and provenance

`vo` = `src/core/vocabulary.js`, `ut` = `src/utils.js`, `cl` = `src/commands/claim.js`,
`mg` = `src/core/mechanism-grouper.js`, `ov` = `src/core/overview.js`,
`me` = `src/commands/metrics.js`, `lr` = `public/list-renderers.js`,
`mcp` = `src/mcp-server.js`, `sv` = `src/server.js`.

| claim | where | provenance |
|---|---|---|
| C1 preamble | `docs/UNCOVER_KEY_CODE.md:27-32`; ChatGPT transcript's one-sentence summary | A, Chat |
| C1(a) | `vo:910-912` (`extractConcepts` signature; catalog loaded when not injected), `vo:918` (`getTopVocabulary(idx, topN)`) | A→C |
| C1(b) | `vo:918-919` (top 200, random and base64 filter) | G1 dep 12→C |
| C1(c) | `vo:924` (`splitCompoundToken`); `ut:230-272`; `ut:273-279` (noise list) | A, Cl4→C |
| C1(d) | `vo:925` (stoplist), `vo:926-931` (hard drop at three fifths); `cl:50-65` | G1→C |
| C1(e) | `vo:932`; `vo:293-307` (`_subtokenCrossCorpusWeight`) | A, Cl4, G1→C |
| C1(f) | `vo:933-945` (candidates longer than the part, top file carried, five kept best first) | G1→C |
| C1(g) | `vo:947-975` (`resolvesToFunction`, memoized; `fnPick`, else first, else null) | G1→C |
| C1(h) | `vo:966-975` (return shape: `concept`, `example`, `exampleFile`, `exampleIsFunction`) | A→C |
| C1 wherein | `vo` imports no model | C |
| C2 | Set V claim 1; `vo:309-343` (parts tallied into the catalog) | A ("linked to the original vocab tokens") |
| C3 | `vo:910` (200, 15), `ut:230` (3), `vo:943` (5), `vo:930` (0.6), `vo:300-306` | Chat→C |
| C4 | `ut:233-245` (strip, split regex with abbreviation end), `ut:273-279` | C |
| C5 | `cl:50-55` (comment: shared with the TIGHT prompt; issue #2 item 5) | Chat→C |
| C6 | `vo:926-931` ("DERIVED from the corpora, not declared"), `vo:302` (df below two is weight one) | Chat→C |
| C7 | `vo:913-919` (comment on #309 and injectable entries) | Chat→C |
| C8 | `mg:116-131` (`gatherConcepts`, `useDocs`), `vo:459-483` | Chat→C |
| C9 | `vo:947-963` | G1 dep 13→C |
| C10 | `vo:982-985` (`conceptLabel`) | G1 dep 14→C |
| C11 | `ov:157-194` (12 concepts, #275 re-resolution), `ov:~411-418` (text rendering) | C |
| C12 | `lr:1963-1970` (`clickRow`; search fallback, #268), `lr:1872-1876` (vocabulary accordion line) | C |
| C13 | `me:1605-1608`; `sv:2719-2723`; `mcp:987-988` | C |
| C14 | `mg:316-337` (`conceptSeededGroups`), `mg:384-417` (token seed, corpus-name rejection, over-broad test), `mg:941` (mode), `mg:25-99` (24 concepts, minimum three), `src/argparse.js:624`, `1669-1670`; `src/commands/pseudo-claims.js:1457-1464` | Chat→C |

Tests that pin rows: `test/test_vocabulary.js:151-168` (an injected catalog and injected
entries: the three-fifths drop, the kept roots, the example grounded in the larger
identifier). This set's C14 is Set D's claim 1(d) token seed seen from the other side; Set
D's 1(c) is this claim 1.

---

## Scores (2026-10-30)

Scored with `node scripts/pseudo-claim-rubric-score.mjs`
`--rubric docs/pseudo-claim-rubrics/concepts.md --run <file>` for each run below:
the best run claim per run (MET counted twice, PARTIAL once)
among the claims with an anchor that matches a row's cite. MET is a cite match with half the
row's content words present, PARTIAL a cite match with a quarter or the words without the cite;
the overlap is a keyword proxy printed beside every verdict, and the reading stays the human's.
The runs are files in the project root of this checkout, not in the repository; "none" means no
claim in that run meets or partly meets a row.

| run | best claim | MET | PARTIAL | ABSENT | surplus (substantive / trivial / ungrounded) | claims considered |
|---|---|---|---|---|---|---|
| CE_pseudo_claim_test_102526_720pm_norank.txt (10/25 7:20pm, Claude, 41 claims) | 26 ([file] overview.js) | 0 | 2 | 21 | 7 / 0 / 9 | 4 |
| CE_pseudo_claims_vocab_concept_overview_Claude.txt (10/27, Claude, 18 claims) | 4 (vocab (buildLocalExtractionPromptWithVocab) / vocabulary) | 1 | 1 | 21 | 4 / 1 / 11 | 5 |
| CE_pseudo_claims_vocab_concept_overview_ChatGPT.txt (10/27, ChatGPT, 18 claims) | 1 ([file] vocabulary.js / rest) | 4 | 5 | 14 | 14 / 0 / 6 | 6 |
| gemma4_CE_pseudo_claims_102926.txt (10/29, Gemma 4 on the Asus, 41 claims) | 4 (vocab (buildLocalExtractionPromptWithVocab) / vocabulary) | 1 | 0 | 22 | 13 / 1 / 9 | 5 |
| CE_pseudo_concept_overview_103026.txt (10/30, Claude, 12 claims) | 3 (vocab (buildLocalExtractionPromptWithVocab) / vocabulary) | 1 | 0 | 22 | 10 / 0 / 11 | 4 |
| CE_pseudo_vocab_103026.txt (10/30, Claude, 9 claims) | 1 ([file] vocabulary.js / rest) | 1 | 7 | 15 | 12 / 1 / 7 | 3 |
