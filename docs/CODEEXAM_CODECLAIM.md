# CodeClaim

CodeClaim will be CodeExam pointed directly at patents. CodeExam already works with patent claims as
one key feature (see [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md)). CodeClaim will share
the CodeExam engine — the same indexing, extraction, and claim↔code machinery documented across
these pages — and further apply it to patent litigation and analysis. This page is more
forward-looking than the rest of the CodeExam docs: some of what follows ships today, and some is
further direction.

## One tool, two directions

Patent disputes turn on two kinds of claim chart, and CodeClaim will produce both using the same
machinery (though working on different materials in some cases):

- **Infringement** — chart a claim against the **code in suit**: does *this* product practice each
  element? The charting methodology CodeExam ships today is in
  [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md).
- **Invalidity** — chart a claim against **prior art**: does some *earlier* software (not necessarily
  in source-code form) anticipate or render obvious each element?

Same deliverable — the element-by-element claim chart — with two targets: the specific code in a
case, or a corpus of public prior code (which is not necessarily open source; see Thread 2 below).
Offense and defense on one claim↔code axis.

## Thread 1 — reading the whole record, not just claims and code

A claim doesn't stand alone. Its terms are defined and narrowed by the **specification**, by the
**file wrapper** (the prosecution history — what the applicant told the patent office to win
allowance), and, in litigation, by the **parties' own papers**: claim-construction briefs (and any Markman or
other claim-construction rulings) and the infringement and invalidity contentions. A means-plus-function term (§112(f)) reaches only as far as
the "means" the specification actually discloses. A chart that ignores all this may be charting a
strawman.

CodeClaim's first thread brings those documents into the analysis — synthesizing specification, file
wrapper, and litigation papers together with the code — to produce charts that reflect what the
claim actually covers (which may differ from the literal, plain-and-ordinary meaning of the raw
claim language). This is **multi-document synthesis and judgment**, which today is
frontier-cloud work, beyond what a local LLM does reliably (see *Local and cloud*, below). It is
**direction, not a shipped feature.**

## Thread 2 — prior art hiding in shipped software

Software has a prior-art problem, noted for decades: the state of the art often lives in products,
not papers. As one 1995 survey put it, "useful examples of prior art are most likely buried within
application programs or system software, and known only to the authors"; and in 2001, "most software
inventions are not described in published journals … [they] exist in the source code of commercial
products … [which] is hard to catalog or search."

While open-source (and its use in commercial products) has expanded since 1995–2001, there remains a
huge, just-below-the-surface body of **proprietary** code. If code is fully confidential it is, by
definition, not prior art — prior art must have been publicly accessible at the relevant time. But
conversely, much publicly-accessible code (or "quasi-code"; see [`QUASI_SOURCE.md`](QUASI_SOURCE.md))
still sits **uncollected** in any form usable for a prior-art search. (Relatedly, today's LLMs are
over-trained on open source relative to less-open source — an instance of the broader complaint that
model training over-reflects whatever happens to be on the public internet, then is turned around to
reason about proprietary/confidential corporate material. see IBM, [*Enable AI: unstructured data integration and governance*](https://www.ibm.com/think/insights/enable-ai-unstructured-data-integration-governance),
and CDOTrends, [*The 1% Problem: Why Your Enterprise Data Is Useless to AI*](https://www.cdotrends.com/story/4788/1-problem-why-your-enterprise-data-useless-ai))

So one important body of software prior art sits *out there* — in shipped products — but has
remained largely unreachable for examiners and litigants.

CodeClaim's second thread is the response CodeExam's author set out in a 2011 two-part article,
*Open to Inspection: Using Reverse Engineering to Uncover Software Prior Art*
([part 1](https://www.softwarelitigationconsulting.com/articles/open-to-inspection-using-reverse-engineering-to-uncover-software-prior-art-part-1/),
[part 2](https://www.softwarelitigationconsulting.com/articles/open-to-inspection-using-reverse-engineering-to-uncover-software-prior-art-part-2/)):
treat **publicly-accessible product binaries as prior-art documents** — extract the readable information they
carry (strings and error messages, API imports and exports, menus and dialogs, embedded SQL and
scripts), index it, and search it. As the article closes: *"The code is out there; it's prior art;
it can be indexed and searched."* That work in part led to **CodeExam** (built) and is projected to
lead to **CodeClaim** (the prior-art database).

**The engine is already real.** Almost every extraction technique that vision called for is now in
CodeExam: recovering structure from binaries and archives (quasi-source — see
[`QUASI_SOURCE.md`](QUASI_SOURCE.md)), the module "seams" inside bundles, imports/exports, the
command catalog (menus and CLI surfaces), distinctive strings, C++ demangling, function fingerprints
(the old "Opstrings" idea — see [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md)), and a bridge between
patent-claim wording and programmer code wording (see [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md)
on `--synonymize`). What is *not* built is the thing that vision was ultimately about: a large,
curated **prior-art corpus** assembled from public products. Building that corpus is the open work of
Thread 2.

A prior-art reference also carries legal questions CodeClaim surfaces rather than settles: was the
software public at the relevant date? Is it a "printed publication" in the patent sense? Could a
person of ordinary skill have found and read it? What is the effect, if any, of the boilerplate "no
reverse engineering" clauses in mass-market software licenses? And what, if any, are the copyright
implications of indexing strings visible in a publicly-accessible binary — or strings *inferred*
from it, such as C++ function signatures recovered from mangled names, or algorithm identifiers
deduced from "magic numbers"? The footing is solid in principle — a publicly-accessible product is
prior art as of its distribution, and a shrink-wrap "no reverse engineering" clause does not by
itself make a shipped product confidential — but the date, the reference, and the
printed-publication questions are to be argued case by case.

## Local and cloud — and the protective order

The split between what runs air-gapped on a local LLM and what needs a cloud LLM falls out cleanly
along the two threads, and it happens to match the litigation constraint that matters most:

- **Building** the prior-art corpus is deterministic — extraction and indexing, no LLM in the loop
  — so it is done once, centrally, and **ships pre-built** for fully local, air-gapped use.
- **Searching** it (a claim → candidate references) rides CodeExam's mechanical retrieval and the
  claim↔code bridge, so it is largely feasible on a local GGUF model today.
- **Thread 1's document synthesis** is the multi-document judgment that requires cloud/frontier LLMs
  for now.

The **protective-order boundary is where this gets delicate.** The intent is that confidential source
code produced under a protective order need never leave (and can't be allowed to leave) the
air-gapped machine: CodeExam extracts it locally and emits grounded, line-numbered citations, and a
cloud step would work from the **public** materials (the patent, the prior art, the litigation
papers) plus that local output. But a source-code protective order typically restricts far more than
the code itself — often *any* note, memo, or document that quotes or even **refers to** the source
code, which can sweep in the very citations (a bare `file:line`, still more a `file:function`) the
pipeline would send out; and a bare citation is of little use to a cloud LLM without the code anyway.
So treat the local→cloud pipeline as *aligned with* the PO's inside/outside boundary, **not** as
automatically compliant: what may cross, and how bounded information (hand-written notes, and
eventually the expert report) legitimately leaves the secure room, is exactly what a source-code PO
governs. (See the author's
[protective-order article](https://www.softwarelitigationconsulting.com/source-code-protective-orders-from-the-perspective-of-a-source-code-examiner/)
— search it for "notes" — and [`AIR_GAPPED.md`](AIR_GAPPED.md).)

## The prior-art corpus as a shared resource

*(Projected direction, not a current feature.)* Once built, the prior-art corpus is more than a
search target. A body of millions of real code files is also a **statistical reference** for what
ordinary software (including in compiled, minified, and/or obfuscated form) looks like — and
CodeExam's everyday heuristics all sharpen when measured against
it: telling a codebase's distinctive vocabulary from boilerplate, inferring readable names for
obfuscated identifiers, resolving imports to libraries, distinguishing a novel function from one
copied everywhere, and — most to the point — grounding the claim↔code vocabulary bridge in **real
synonyms drawn from real code** rather than an LLM's guesses (the 2011 "thesaurus from code
fragments," made empirical). These are counting operations, not LLM calls, so a pre-installed
corpus would improve the *local, air-gapped* engine with no cloud dependency — meaning the invalidity
thread's artifact would strengthen the infringement thread's charts.

A smaller vocabulary / import-frequency summary can ship even where the full corpus does not — and
CodeExam already ships one: the open-source-derived cross-corpus vocabulary catalog
`CE_cross_corpus_vocab_catalog.json` (auto-loaded from CodeExam's `src/`; see
[`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md) and [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md)), with
an import-frequency counterpart available through the import census (`--census-imports`, #162)
[[placeholder: name the shipped import-frequency catalog + its doc/issue, if one is settled]]. Any
such summary must be built only from publicly-accessible material and must never carry fragments of
the proprietary/confidential code it is used to analyze.

## Two histories, one name

Historically "CodeClaim" named the prior-art database (Thread 2); today it also names the
litigation-analysis build (Thread 1). For now they live under one name, unified by the
infringement/invalidity framing above. They may yet prove distinct enough to split; this page
currently assumes not.

## Related

- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — the claim-charting methodology CodeExam
  ships today.
- [`QUASI_SOURCE.md`](QUASI_SOURCE.md) — recovering indexable content from binaries (the Thread-2
  engine).
- [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md) — fingerprints and the "Opstrings" idea.
- [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md) — `--synonymize` and the claim↔code bridge.
- [`AIR_GAPPED.md`](AIR_GAPPED.md) — the local/cloud boundary the pipeline runs along.
