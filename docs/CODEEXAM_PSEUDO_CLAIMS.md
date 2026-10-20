# Pseudo-claims: illustrative claim drafting from code

> **Not legal analysis.** Pseudo-claims are **illustrative, machine-drafted**
> claim-style descriptions produced as a drafting and code-navigation exercise.
> They are **not** legal advice, **not** a patent-attorney work product, **not** a
> prior-art search, and **not** an opinion on novelty, validity, or infringement.
> Nothing in a pseudo-claim asserts that any codebase, product, or party embodies,
> practices, or infringes any claim or element. A `file:line` reference is an
> **orientation pointer** to topically-related code — a reviewer aid — not a
> finding that the cited code implements the claim. CodeExam attaches these
> caveats to every pseudo-claims artifact; keep them labeled as drafts, not
> findings.

## What it is

`--pseudo-claims` drafts one illustrative patent-style claim per **mechanism** — a
small group of functions that jointly embody one piece of technology — from a
bounded **evidence pack** of that group's code. (An *evidence pack* is the exact,
size-capped set of code excerpts for a mechanism's functions that CodeExam hands
the model — and the whole of what it is drafted from; see *Running it* below.)

CodeExam does **not** identify "the invention": it runs no prior-art search and
makes no novelty judgment. What it *does* auto-discover — when you don't hand it
an explicit function set — is a collection of **candidate mechanisms**: pieces of
technology in the codebase, each statable in a single sentence, that may be worth
considering as *possibly* embodying or practicing an invention. Whether any of
them is novel, or reads on a real claim, is a separate human judgment CodeExam
does not make.

So there are two ways in:

- **You already know the functions** that embody a mechanism → supply them as
  anchors.
- **You don't** → let CodeExam enumerate candidate mechanisms for you
  (deterministically — see *How candidate discovery works*), then prune.

## A quick example (illustrative)

> **[ILLUSTRATIVE PLACEHOLDER — to be replaced with real `--pseudo-claims` output.
> It carries the non-admission caveat above; it is not an assertion about any
> code.]**
>
> **Pseudo-claim 1 — token-bucket rate limiter**
>
> *[PSEUDO-CLAIM — illustrative only; not a legal opinion or an admission that any
> code practices this. `file:line` = orientation pointer, not a finding.]*
>
> A method for limiting a rate of requests, comprising: maintaining a token count
> replenished at a fixed interval up to a ceiling; on each request, decrementing
> the token count and admitting the request when at least one token is available;
> and rejecting the request when no token is available.
>
> Anchors: `src/limit.js@refill`, `src/limit.js@tryAcquire`.

A real run also prints the fixed caveat header, a **grounded**-anchor list (each
citation verified to resolve to a real function in the index; ungrounded ones
dropped), any **dependent** pseudo-claims (see below), and — for multiple
mechanisms — a contents table.

## Running it (CLI)

Two ingredients: **anchors** (which functions) and a **model** (to draft). With no
model, CodeExam prints the evidence packs only — no claims — and says so.

**1. If you already know the functions:**

```
ce --index-path IDX --pseudo-claims "path/a.js@funcX;path/b.js@funcY" --llm claude
```

Separate mechanisms (one claim each) with an `@anchors.lst` file: one `file@func`
per line, a `# Label` line starting each new group.

**2. Let CodeExam propose the candidate mechanisms** (deterministic, no model):

```
ce --index-path IDX --pseudo-claims --candidates cand.lst   # write candidate groups
#   open cand.lst, delete the groups you don't want
ce --index-path IDX --pseudo-claims @cand.lst --llm claude  # draft (needs a model)
```

The written `cand.lst` **is** an anchors list — hand-prune it, then feed it back.

**3. Filter candidates by topic, in one command:**

```
ce --index-path IDX --pseudo-claims --filter <topic> --llm claude
```

`--filter <substring | /regex/>` keeps only the candidate mechanisms whose header
(label + purpose) matches — the same filter contract as every other CodeExam
listing. With a model it drafts straight from the matches, with no interim file;
add `--candidates out.lst` to also save the filtered list. With no model it prints
the filtered candidates and says they are candidates, not claims.

**Models.** Draft with a cloud provider — `--llm claude | openai | gemini` (keys
from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`) — or a local GGUF:
`--model <path.gguf>` (`--cpu` forces CPU). With **no** model (or `--dry-run`)
CodeExam prints the evidence packs only. A local GGUF keeps the run air-gapped;
see [`LOCAL_LLM.md`](LOCAL_LLM.md) and [`AIR_GAPPED.md`](AIR_GAPPED.md). A cost
estimate is shown before any cloud spend.

**Claim schema (experimental).** Add `--claim-schema` and the drafter no longer writes claim text:
it fills a **claim object** — a preamble form, a purpose, the elements each with its code anchors,
the dependents each with a parent number and a kind — and CodeExam renders the text. The permitted
preamble forms ("A method for …, the method comprising the steps of:"), the dependent kinds
("wherein", "further comprising") and the element and dependent counts are the litigated
population's, measured in `src/core/claim-frame-tables.json` and the shape bands, so the *frame*
of a draft reads like a real claim while the substance of each element stays the model's. Every
engine enforces the same object: a local GGUF through a grammar compiled from the schema, Claude
through a forced tool call, the OpenAI-style endpoints through `response_format`. What a schema
cannot say — a method step opens with a gerund, a dependent names claim 1 or an earlier dependent —
is checked after drafting and a failed draft is redrafted once or twice with the failure named (the
artifact says which checks the redrafts answered). Because the object pairs each element with its
anchors at birth, the artifact lists a claim's cited anchors element by element, and an element
with no grounded anchor is visible as such; with `--claims-only` the object itself lands in the
`.anchors.json` sidecar under `schema`. The schema is sent with every call, so a schema draft costs
more input tokens than a free-text draft of the same group, and each redraft is one more call; the
projected-cost line counts the schema but not redrafts, which the actual-cost line reports.
`--show-prompt --claim-schema` prints the schema the engine is given. The default (no flag) is the
free-text path, unchanged. Expect little visible change on Claude method claims: measured on
free-text runs, Claude already writes the population's transition, preamble form and dependent
references nearly every time. The flag shows where an engine drifts: a claim returned in the wrong
statutory class, cited anchors lost to free-text parsing, method steps that do not open with a
gerund, and apparatus claims (`--claim-class system`) whose elements do not open as noun phrases
(the ledger in `claims-pipeline-state.md` §6 has the per-engine numbers).

## How candidate discovery works (and what it does not promise)

The set of candidate mechanisms is produced **deterministically, with no model**:
the grouper (`--pseudo-claims --candidates`) clusters the index's functions by
signals like shared name-tokens, membership in the same class, a module's leading
doc comment, and the command/handler catalog, then emits each cluster as a
`# Label` + `file@func` group. Because this step is model-free, **different LLMs
drafting from the same candidate list draft claims for the same set of
mechanisms** — the models change the *wording* of each claim, not *which*
mechanisms exist. In other words, the auto-discovery of candidate "inventions"
lives entirely in the deterministic candidate selection; the model is a drafter,
not a discoverer. (The one model-touched option, `--rank`, only *orders* and
annotates the candidates by an LLM priority score; it does not change the anchor
set.)

**It samples; it does not survey — so it can miss the mechanism you care about.**
By default the grouper covers only a small fraction of a codebase's functions
(measured at ~8% on one large corpus — #302): it lands wherever generic salience
points, not necessarily where a particular invention lives. A mechanism whose
functions don't share the grouper's signals (no common name-tokens, not one
class, spread across files, below the size/commonality thresholds, or in
excluded/vendored code) may form no candidate group at all. So although a
candidate list and a pseudo-claims contents table can look exhaustive — "the
invention must be in here somewhere" — there is **no guarantee of completeness**.
Much of the value is precisely in *eyeballing* those lists for mechanisms you
hadn't named; just don't read their length as coverage. Claim-guided gathering,
to steer the sample toward a known claim's concepts, is proposed in #302 (and
richer seeds in #289).

A candidates contents table reads roughly like this (from the bundled `.demo`, a
TLS/crypto corpus — trimmed):

```
# [class] NetworkManager         (8 fns)  — Secure network connection lifecycle management
# tls (tls_send_encrypted)       (7 fns)  — TLS/SSL connection management
# cipher (negotiate_cipher)      (7 fns)  — TLS cipher-suite selection and negotiation
# [class] CertificateValidator   (6 fns)  — X.509 certificate chain verification
# cert (getClientCertPassword)   (5 fns)  — X.509 certificate chain verification
# [file] buffer_pool.c           (4 fns)  — memory buffer management for network I/O
…
```

Each line names a candidate mechanism; its functions are the anchors below it in
the file.

## Notes, roadmap, and related issues

- **GUI.** Pseudo-claims is **CLI-only** today — there is no GUI panel yet.
- **Dependent pseudo-claims.** CodeExam drafts dependent claims beneath each
  independent one (#311). A dependent claim adds a narrower limitation — a
  fallback that stays in force if the independent claim is read too broadly, and
  a way to put specific embodiments on the record. The **model** decides how many
  dependents to write and what each one narrows; CodeExam does not fix a count —
  it reports what the model produced and, in its shape report, compares the draft
  against the litigated population's dependent-count band (median ~7). They are
  illustrative drafts under the same caveat, not charted or grounded.
- **Frame from the population (`--claim-schema`, experimental).** On the free-text path
  the model chooses its own preamble, transition and dependent forms. Under `--claim-schema`
  those are enumerated from the 380 litigated claim 1s and their 3,293 dependents (see the
  *frame* paragraph on [`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md)),
  the dependent count is bounded above by the population's p90, and CodeExam writes the text.
  Not yet: exemplars chosen from the population and a rerank of several samples by shape
  distance (the grammar says what is allowed, not what to prefer), and a GUI or MCP control.
- **Statutory class.** Pseudo-claims default to **method** claims, which is why a
  run can look all-method. Use `--claim-class system` (or `both`, or `auto` to
  pick per mechanism) for apparatus/system form. The flag affects pseudo-claims
  only — not the `--claim-*` search/chart commands — and renaming it to
  `--pseudo-claim-class` for clarity is under consideration (the current name
  would remain as an alias).
- **Broad vs. tight drafting (idea).** The most useful claim steers between the
  *broadest* language that still captures infringement and the *narrowest* that
  avoids prior art. CodeExam does not yet draft a broad and a tight version of the
  same mechanism to bracket that "sweet spot" — but the framing already exists on
  the retrieval side: `--claim-analyze` generates **TIGHT** (narrow,
  higher-confidence) and **BROAD** (wider, merged) term sets to steer search
  (`--vocab-tight`), and the same broad/tight steering could drive two drafts of
  one mechanism. Described here for now rather than filed.
- **Comparing / merging models.** Drafting the same candidate list under several
  models and synthesizing the results is the `--chorus` / merge-multiple-AIs idea
  (#278). Until then, run twice and compare by hand.
- **Self-test (prose↔code bridge).** Pseudo-claims are also how CodeExam tests —
  and manufactures ground truth for — its own claim↔code association; see the
  *Self-test* section below.

Sections still to write (TODO):

- **TODO — illustrate Contents.** A full example **Contents** table from a real
  run (the trimmed `.demo` snippet above is only a taste), showing how useful the
  list is to eyeball.
- **TODO — the drafting prompts.** A section on the prompt(s) CodeExam uses to
  steer the LLM when drafting pseudo-claims, and the ways to see them: the prompt
  catalog `--prompt-catalog` (alias `--prompts`), and `--show-prompt` (which
  prints the system prompt plus each group's evidence pack and exits without
  drafting — works with or without a model).
- **TODO — hand-editing a candidates list.** A section on editing a
  CodeExam-generated `cand.lst` before drafting — pruning groups, merging or
  splitting them, and re-ranking.
- **TODO — the `--rank` options.** A section on the `--rank` family for
  pseudo-claims (the bounded-LLM worthiness scoring that orders candidates;
  anchors unchanged).

Not yet, also: a ranked one-command `--pseudo-claims --auto` (#284).

## Self-test: "huffing our own fumes" (HOF)

Pseudo-claims are not only a deliverable — they are how CodeExam tests its own
ability to bridge *claim prose* and *code*, and a way to **manufacture ground
truth on any index**. (The usual claim↔code answer keys are all compromised: a
hand-built set is tiny, `.demo` was LLM-authored, and a real patent like the '101
shares vocabulary with its own implementation, so a "match" can be mere
word-overlap rather than real claim↔code skill.) The self-test — "huffing our own
fumes" (HOF) — runs:

1. **Draft** pseudo-claims from code with their **code references attached** (a
   candidate mechanism → a pseudo-claim → the anchors it was drafted from).
2. **Synonymize with a *different* LLM**, *withholding* the code references
   (`--synonymize`). This is the load-bearing step: it rewords the claim *away*
   from the code's own identifiers, so any later recovery cannot be mere
   vocabulary overlap.
3. **Retrieve**: feed the reworded claim to `--claim-analyze` / multisect and
   measure whether it lands back on the original references, assigned to
   reasonable limitations.

Agreement means the claim captured the *mechanism*, not just echoed its names.
`--claims-loop` repeats draft → retrieve → compare → refine to convergence
(#290). Full write-ups: [`claims-pipeline-state.md`](claims-pipeline-state.md)
(§4 / §9 / §10) and
[`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md) (the HOF
section; #310).

## See also

- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — searching and charting
  *real* patent claims against code (pseudo-claims' sibling).
- [`AIR_GAPPED.md`](AIR_GAPPED.md), [`LOCAL_LLM.md`](LOCAL_LLM.md) — local /
  air-gapped drafting.
- [`CODEEXAM_NOTATION.md`](CODEEXAM_NOTATION.md) — the `file@func` / anchor
  notation.
