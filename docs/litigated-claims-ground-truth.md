# Patent "ground truth": what CodeExam's claim features are tested against

> **Draft / skeleton.** This page states what CodeExam's claim-handling output is measured against,
> for a reader deciding how much to trust that output. A few figures are marked `[[verify]]` and a
> few framing choices `[[decide]]`; some of these notes are kept in the public version, as a marker
> that this is a work in progress, still under active development.

CodeExam can search and chart **patent claims** against a codebase, and generate claim-shaped
"pseudo-claims" from code. Because that output can end up in a work product an opposing expert will
scrutinize, this page is explicit about something that gives it credibility: **CodeExam's claim
features are developed and tested against litigated software patents** — and about the limits of
what that testing can and cannot show.

**What "ground truth" means here.** Mostly one thing: **claim ↔ code correspondence** — whether a
claim (or a claim element) reads on a particular piece of code. That correspondence is *hard to
establish objectively* for software, which is exactly why this page is careful about which parts of
the problem have a real answer key and which do not. `[[placeholder: link, from somewhere in the CE
docs, to the SLC-website material on why software has non-standard terminology/nomenclature (unlike
chemistry or biology) — a patentee "can be their own lexicographer," so you generally cannot take a
software-patent claim and trivially go find its embodiments in source code.]]`

## The principle

- **Where there's an objective answer, establish it before the model.** Some things about a patent
  claim are simply facts about its *text* — how it breaks into elements, which dependent claims
  narrow which — and the patent office's own data (or a patent attorney) fixes the correct answer
  independently of any software. CodeExam's handling of those is then **scored against that fixed
  answer**, rather than a language model being trusted to decide what is correct. For the parts that
  have *no* objective answer — does this code implement this claim? — see the limits at the end.
- **Citing more code is not doing better.** A chart that points at a whole file, or at every function
  that merely mentions a claim term, can look thorough while proving nothing — a "cite everything"
  strategy scores well on coverage and tells you nothing. What matters is whether the *specific* code
  a limitation reads on is identified, not how much code is cited. CodeExam's scoring is built to
  reward precision, not volume. `[[verify: keep this framing — drawn from the #311 / citation-
  specificity measurements]]`

By **CodeExam's claims pipeline** we mean the `--claim-*` family (the commands that find and chart
patent-claim language against indexed code — `--claim-search`, `--claim-chart`, `--claim-locate`,
`--claim-analyze`), plus the pseudo-claim generator that works in the other direction (code → claim).

## What CodeExam is tested against

Two real patent populations. `[[verify all counts against the current datasets before publishing;
they are first measurements — re-measure, don't re-quote.]]`

- **Litigated software patents.** A corpus of **~385** big-tech-drafted software patents — claim 1
  plus its dependent chain — drawn from patents that have actually been **asserted in litigation**
  (the population CodeExam is built for). The litigation list is the
  [**USPTO Patent Litigation Docket Reports** data](https://www.uspto.gov/subscription-center/2024/updated-patent-litigation-docket-reports-data)
  (March 2024 release; the most recent cases in it run to about **2020**). Claim
  structure is cross-checked against the patent office's own dependency markup (via **Google Patents**
  and the **USPTO weekly grant XML**): on the order of **~85,249** markup-verified dependents across
  the grant data, with **~554k** canonical claim-1s as the wider backdrop.
- **AI and machine-learning (ML) patent claims.** A second population, from the USPTO's
  [**Artificial Intelligence Patent Dataset** (AIPD)](https://www.uspto.gov/ip-policy/economic-research/research-datasets/artificial-intelligence-patent-dataset)
  ([2023 report](https://www.uspto.gov/sites/default/files/documents/oce-aipd-2023.pdf)), used to test
  CodeExam's claim handling on the subject matter its **AI/ML detectors** target. While these AI/ML
  patents have not specifically been litigated (and likely few have been so far), AI/ML patents can
  reasonably be expected to **grow in importance** — including from vendors that also release open
  source.

*(Internal dataset names, file paths, and the fetch tooling are omitted here; they live in the
development notes.)*

## The measured shape of a litigated software claim 1

Characterizing the corpus is part of the point — it tells you what a real target looks like
(first-pass figures): claim 1 runs a **median ~146 words**, **4–5 attorney-drafted elements**, with
a **median 7 dependents** at **chain depth ~2**; across the grant-data dependents, roughly **84%
modify / 13% add** (the rest cross-class). This is the population CodeExam's drafting and splitting
are calibrated against — not a hand-picked example.

## Tiers of ground truth — and what each can tell you

Not every claim question has the same kind of answer key. CodeExam's testing separates them (the
structural checks below are exercised in the test suite — see `test/test_dep_claim_rules.js` and
`test/test_claims_loop.js`, with the retrieval screen in `test/test_claim_ballpark.js`):

- **Structural — no model, no codebase needed.** The patent office's markup already encodes a claim's
  element structure and dependency chain. The test is whether **CodeExam's own** element-splitter and
  dependency-detector *reproduce that structure* — i.e. does CE's parse of the claim agree with the
  office's answer key? (The markup isn't in doubt; CE's parse of it is what's being measured.) These
  have exact answers and are scored mechanically: the dependency detector reproduces the office's
  parents at about **~99.95%**; the element-splitter agrees less often and is being calibrated.
- **Negative controls — truth is ABSENT by construction.** A claim paired with a codebase it *cannot*
  read on — a transmit-side claim against receive-side-only code, say. The correct chart is
  all-ABSENT, so any PRESENT/PARTIAL is a false finding, and the cost of the test is one cheap chart.
  This is the sharpest measurement: a first negative-control chart scored **4/4 ABSENT**. An engine
  that does worse than the trivial "always ABSENT" answer is worse than a constant.
- **Positive screening — retrieval, no verdict.** Where a patent's assignee also publishes open
  source, CodeExam can screen for whether the claim's subject matter is even *in the neighbourhood*
  of a codebase. Today this is done with **multisect retrieval** (`--multisect-search` with
  `--min-terms` across `--multi-index`), ranking indexes by how many of a claim's distinctive terms
  co-occur; a dedicated "ballpark" screen is in development. **This measures retrieval, not
  infringement** — see the limits below.

## How to read a CodeExam claim result in this light

- **A chart is a candidate match, not a finding.** A PRESENT row says CodeExam's retrieval put a
  claim element near some code; it is a lead to verify by reading the cited lines, not a conclusion
  that the limitation is met. (See [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md).)
- **Positives measure retrieval unless a human confirms them.** Screening tells you where to look;
  it does not tell you what's there.
- **None of this is legal analysis.** CodeExam does not construe claims, and the patent-office markup
  is an answer key for *structure*, not for a litigator's claim construction.

## A baseline self-test: "huffing our own fumes" (HOF)

There is one way to make a (claim ↔ code) test out of *any* codebase, without waiting for a litigated
pairing. CodeExam generates **pseudo-claims from code, with the code references they were drafted
from attached**. Then (the HOF loop): **synonymize** those pseudo-claims with a *different* LLM than
drafted them — withholding the code references — and feed the reworded claims back through a
`--claim-*` command, to see whether it resurfaces roughly the **same code citations** the original
pseudo-claims were based on.

It is deliberately a **minimal baseline** — because CodeExam both *generated* the claims and then
*went looking* for the code to match them, the loop can only confirm a floor of capability, not real
claim→code skill. In development this was named **"huffing our own fumes" (HOF)**; parts of the loop
(the independent-LLM synonymize step) are still being built. See **#310**.

## What this testing deliberately does NOT claim

Stating the gaps is part of the credibility:

- **No verified claim-to-code ground-truth pair.** Litigation records name the accused *product*, not
  a public codebase, so there is no public "this claim reads on this code" answer key; positives are
  assignee-matched candidates, not confirmed matches. **This is why open-source litigation helps us
  here:** for claim/code testing — and for the larger goal of establishing claim/code "ground truth"
  — it is useful (even if some find it regrettable) that some litigation now targets **open-source
  projects used by deep-pocketed defendants**, since those give a rare, genuinely public (claim,
  code) pairing to measure against.
- **Original assignee ≠ asserting party.** The patent's *original assignee* — who drafted the
  claims — is often not who is now asserting it; for roughly **165 of the first 385**, the top
  plaintiff is a later owner. So "who drafted this claim" and "who is suing on it" must not be
  conflated when reading the corpus.
- **The corpus is a sample**, selected by litigation exposure — representative of the target
  population, not exhaustive — and it skews toward older, mass-asserted patents (the litigation data
  runs only to ~2020). The exposure-rate ranking corrects for that only partly.
- **Model runs are not reproducible across days** at the temperatures used for exploration; use
  `--reproducible` when you need a pinned, repeatable run
  (see [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)). A complementary direction — comparing, merging, or
  voting results across multiple runs and/or multiple LLMs to improve stability — is tracked in #278
  (and noted in passing on #319).

## Related

- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — searching and charting claims against a codebase.
- [`CODEEXAM_CODECLAIM.md`](CODEEXAM_CODECLAIM.md) — infringement vs. invalidity charts, and the CodeClaim direction.
- [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) — pinning a model run.
- [`ai-assisted-examination-gotchas.md`](ai-assisted-examination-gotchas.md) — how to read AI-assisted output critically.
