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
an AI model — and the evidence pack is the whole of what pseudo-claims are drafted
from; see *Running it* below.)

A patent claim is a one-sentence description of a piece of technology, comprised of
components or elements that inter-relate in some way (or steps of a process or
method). As to why someone not involved or interested in intellectual property (IP)
might be interested in patent claims, or find them useful for some non-IP purposes,
see [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md).

At the level a first reader needs: a pseudo-claim is one answer to the question "how is
this visible feature implemented?", written as a claim rather than as a walkthrough. The
answer is held to a grounding contract that a chat answer is not: every element cites a
function or a line range from the evidence pack the drafter was shown, every citation is
checked against the index and dropped with its reason when it does not resolve, and the
artifact says so beside each claim. Under a different system prompt the same pipeline
(candidates, pack, draft, grounding) is a code-documentation generator; the claim form and
the contract are what make its output a pseudo-claim (2026-10-30).

CodeExam's "pseudo claims" do **not** identify "the invention": it runs no prior-art
search and makes no novelty judgment. What it *does* identify on its own — when you don't
hand it an explicit function set — is a collection of **candidate mechanisms**:
pieces of technology in the codebase, each statable in a single sentence, that may
be worth considering as *possibly* embodying or practicing an invention. Whether
any of them is novel, or reads on a real claim, is a separate human judgment
CodeExam does not make.

Pseudo-claims are a distinctive feature of CodeExam. We know of no other tool that
drafts candidate patent-style claims from source code. Tools that write prose from
code exist in quantity — Doxygen and its kin for reference documentation,
Copilot-style assistants for explanation, CodeExam's own Overview — and they
describe what the code does, in the code's own terms. A pseudo-claim is written in
the claim's form: one sentence, a preamble and elements, each element tied to the
functions it was drafted from, with dependents that narrow it. The form is the
point. It is the form in which a patent will later be set against code, and
drafting in that form from the code side gives a developer, an owner or an examiner
something to put beside a real claim. Language-model claim drafting exists on the
patent-prosecution side, from invention disclosures and specifications; that is a
different starting point from the code itself.

Pseudo-claims are intended to be useful for brainstorming and to help answer a
developer's "What have I actually built here?" question (especially when relying
on a harness like Claude Code or Codex, and the developer is not sure of the
underlying mechanisms; pseudo-claims may promote — or "surface", as the AIs would
say — lower-level features of the codebase that the developer hadn't otherwise seen
as what they had actually created).

This same approach also provides an interesting way for a third party to view
someone else's codebase: "What sort of patent-claim-like sentences might be written
from this codebase, and how similar or different are they from my own patent
claims?"

As explained below at *The real-world yardstick* and *Self-test: "huffing our own
fumes" (HOF)*, pseudo-claims are also used within CodeExam itself as **"synthetic
data"** for continued testing and improvement of its ability to match technical
prose on the one hand with source code on the other hand.

So there are two ways in:

- **You already know the functions** that embody a mechanism → supply them as
  anchors to `--pseudo-claims` on the command line.
- **You don't** → let CodeExam enumerate candidate mechanisms for you
  (deterministically — see *How candidates are identified*), then prune — use the
  `--candidates` option along with `--pseudo-claims`. At a small time and token
  cost, you can also use the `--rank` option to have an AI model try to prioritize
  among multiple candidate pseudo-claims (see *`--rank`: one model pass to order
  the list*, below).

**Terms used on this page**, as the code uses them (2026-10-30):

| term | meaning here |
|---|---|
| anchor | a `file@func` or `file@L<start>-<end>` reference: a specification on input, a citation on output |
| mechanism | a small group of functions that jointly embody one piece of technology; what one claim is drafted about |
| group, candidate | the grouper's unit, a `# Label` header plus its anchors; a candidate is a group not yet pruned or drafted |
| label | the group's header (`cipher (negotiate_cipher)`, `[file] x.js`, `[cmd] --foo`), the name the TOC uses |
| purpose line | the sentence after the label, harvested from the group's own comments, sent to the drafter as the MECHANISM hint |
| evidence pack | the fenced, size-capped bodies of a group's resolved anchors, with the constants they name and any documentation excerpts; all the drafter sees |
| grounding, grounded | the check that a cited anchor resolves to a function or line range in the index; a citation that does not is dropped with its reason |
| sidecar | `<claims-only>.anchors.json`: the grounded anchors, class and element count per claim; the HOF answer key |
| residue (`/ rest`) | the functions of a documented file left after other seeds took theirs, drafted as a group of their own |
| echo | two groups sharing a dominant file, probably one mechanism reached from two seeds; flagged, never merged |
| seed | a rule the grouper starts a group from: a shared name token, a class, a file's leading doc comment, a command's handler and its callees |
| grouper | `mechanism-grouper.js`, the deterministic clusterer behind `--candidates` |
| triage | the deterministic KEEP / REVIEW / DROP cut over a run's sidecar |
| shape profile | the claim population (litigated by default) whose length, element and dependent bands the shape line measures a draft against |
| genericity | a score of how claim-generic a group's words are; drafting goes mechanism-specific vocabulary first |
| notation | the shape a drafter wrote an anchor in (`file@func`, `file@func@L1-9`, `file:12-40`); the known shapes are normalized and the unknown ones counted |
| pack fill | how a pack spends its budget when its anchors do not fit: `even` (the default) or `first` |
| claim schema, claim object | the opt-in path where the drafter fills a structured object under a population-derived schema and CodeExam renders the text |

## A quick example (illustrative)

> **[ILLUSTRATIVE PLACEHOLDER — to be replaced with real `--pseudo-claims` output.
> It carries the caveat at the top of this page, which CodeExam prints as the
> header of every pseudo-claims artifact; it is not an assertion about any code.]**
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

A real run also prints that caveat header, a **grounded**-anchor list, any
**dependent** pseudo-claims (see below), and — for multiple mechanisms — a
contents table. An anchor is *grounded* when its `file@func` resolves to a function
in the index, and *ungrounded* when it does not: a hand-typed anchor with a typo in
it, a list written against an earlier build of the index, a file renamed since.
Ungrounded anchors are dropped and counted in the output. A list the grouper wrote
from the same index (ways 2 and 3 below) resolves in full unless it has been edited
or the index rebuilt in between.

## Running it (CLI)

Two ingredients: **anchors** (which `file@func`s) and a **model** (the LLM that
will draft the claim language). With no model, CodeExam prints the evidence packs
only — no claims — and says so.

**1. If you already know the functions comprising the mechanism for which you want
AI to draft a pseudo-claim:**

```
ce --index-path IDX --pseudo-claims "path/a.js@funcX;path/b.js@funcY" --llm claude
```

Place multiple mechanisms (one intended pseudo-claim each) in an `@anchors.lst`
file: one `file@func` per line, a `# Label` line starting each new group.

**What a header line looks like.** A hand-written list needs only `# Label`. The
lists CodeExam writes carry more on the same line, in this order: the grouper's
label for the cluster (a shared name token with a representative function, or
`[class] Name`, or `[file] name.c`), the function count, with `--rank` the ranker's
tag, then an em dash and the purpose harvested from the module's leading comment:

```
# Label
# cipher (negotiate_cipher)  (7 fns)  — TLS cipher-suite selection and negotiation
# cipher (negotiate_cipher)  (7 fns)  [P3 codebase-specific/keep — handshake parameter choice]  — TLS cipher-suite selection and negotiation
```

The tag is `[P0]` to `[P3]` with the ranker's signal (`codebase-specific`,
`standard-pattern`, `library-wrapper`, `third-party`, `generated`), its fold verdict
(`keep`, `merge`, `split`) and a short note, or `[unscored]` where the ranker gave
none. A `[file] X / rest` group, the remainder of a documented file after other seeds took
part of it, carries a purpose built from its own functions and their comments rather than the
file's header, and says so, because the purpose is the drafter's cue to what the mechanism is
(2026-10-25). The `# ` lines a written list opens with (`# mechanism-grouper ...`,
`# coverage:`, `# split:`, `# echo pairs`) are notes about the run, not groups.
`--filter` matches the header, label and purpose together.

**2. Let CodeExam propose the candidate mechanisms** (deterministic, no model):

```
ce --index-path IDX --pseudo-claims --candidates cand.lst   # write candidate groups
#   open cand.lst, delete the groups you don't want
ce --index-path IDX --pseudo-claims @cand.lst --llm claude  # draft (needs a model)
```

The written `cand.lst` **is** an anchors list — hand-prune it, then feed it back
(the same as if you were using way 1, "If you already know the functions...",
above).

**3. Filter candidates by topic, in one command:**

```
ce --index-path IDX --pseudo-claims --filter <topic> --llm claude
```

`--filter <substring | /regex/>` keeps only the candidate mechanisms whose header
(label + purpose) matches — the same filter contract as every other CodeExam
listing. With a model it drafts straight from the matches, with no interim file;
add `--candidates out.lst` to also save the filtered list. With no model it prints
the filtered candidates and says they are candidates, not claims. On Git Bash, a
`/regex/` filter's leading slash is rewritten to a Windows path unless
`MSYS_NO_PATHCONV=1` is set, which matched 0 groups on one run (2026-10-30).

**Models.** Draft with a cloud provider — `--llm claude | openai | gemini` (keys
from `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`) — or a local GGUF:
`--model <path.gguf>` (`--cpu` forces CPU). With **no** model (or `--dry-run`)
CodeExam prints the evidence packs only. A local GGUF keeps the run air-gapped;
see [`LOCAL_LLM.md`](LOCAL_LLM.md) and [`AIR_GAPPED.md`](AIR_GAPPED.md). A cost
estimate is shown before any cloud spend.

**The pack budget.** An evidence pack is 24,000 characters, at most 8,000 per anchor. When a
group's anchors do not fit, `--pack-fill even` (the default since 2026-10-25) gives every anchor
the same share, never under 600 characters, so a 40-function command group shows the drafter all
forty openings; `--pack-fill first` packs the anchors in group order at full length until the
budget is spent and omits the rest, the better rule when the mechanism lives in one long
function's body. A pack that fits is the same under both. The pack line under each draft says
which applied and what it cost.

**What a pack holds besides code (since 2026-10-30).** A function's mechanism often lives in
a module-level constant it names rather than in its own body: a prompt, a stop list, a tool
menu, a regex table, a catalog. Those are data, not functions, so no seed finds them and no
pack held them, and a drafter shown the three-line function that assembles a prompt wrote
about the loop that sends it. Now the constants a group's functions name in their own file
join the pack after the code, as `file@L<start>-<end>` anchors headed
`(constant NAME, referenced by f, g)`, at most six per group, ranked by how many of the group's
functions name each; the drafter cites them the way it cites a documentation excerpt, and a
cited range that overlaps a packed constant is reported as that constant by name.
`--no-pack-constants` leaves them out, for a before-and-after on the same groups. Documentation
excerpts (`--doc-anchors`) are packed last and headed `(documentation: prose, not code)`; a claim
element whose every cited anchor is a documentation excerpt is marked *prose-backed only* in the
anchor list and *documentation only* in the chart, so a documented step is not read as an
implemented one. Three lines under a draft report all this: the pack line names the constants
and says where the documentation went; a *Spines* line counts the call-connected components
among the pack's functions and says which of them claim 1's anchors fall in, since a pack that
holds two unconnected mechanisms leaves the choice between them to the drafter; and when a draft
cites no grounded anchor the anchor list says which of three things happened (no `ANCHORS` block
parsed from the reply, a block with no line that parsed as an anchor, or every citation dropped
at grounding) and keeps the last 400 characters of the reply under it, so a notation CodeExam
did not recognize can be read from the artifact rather than guessed at. The run header counts
the anchor-less drafts by cause.

**Repetition guard (since 2026-10-30).** A local drafter can loop. Gemma 4's run of 2026-10-29
wrote three dependents of one claim as the previous dependent plus a clause each, then repeated a
twenty-token clause inside the last cited element until the 16,000-token output budget ended, and
the artifact printed the 78,834-character element in full. Now a dependent whose text begins with
the whole text of an earlier dependent (a duplicate, or an earlier dependent with a clause added)
is dropped, and a cited element longer than 800 characters is cut with a marker that says how long
it ran; the stderr line, a line under the claim and the run header say what was dropped and cut,
and the sidecar carries the counts. Dependents that only share a stem ("wherein parsing the string
includes …") are kept: that is how dependents are written. The cap comes from the runs in hand,
where the longest element a non-looping drafter wrote is 736 characters. The guard describes; it
never rewrites a kept text, and the kept dependents keep their numbers. A sampler-side lever for
the GGUF drafter, node-llama-cpp's DRY repeat penalty, is behind `CE_LOCAL_DRY_PENALTY=1` (see
`docs/LOCAL_LLM.md`) so it can be measured on the same groups before any default moves; a run
without it is byte-identical to before, and the artifact's model line names it when it is on.

**A second call for the anchors (since 2026-10-30).** A local drafter can finish a reply without
its `ANCHORS` block: 13 of 41 Gemma 4 claims on 2026-10-30 came back complete, dependents and
all, with no block and nothing truncated. No parser change recovers a block that was never
written, and every drafter call is stateless, so when a complete reply has no block CodeExam
sends one more call with the same pack and the draft, asking for the block alone, and takes its
anchors; the first reply's claim and dependents stand. A truncated reply is not re-asked (the
budget ended it), nor is a block whose lines the parser could not read (the reply tail is the
evidence for that). The stderr line, the anchor list and the sidecar say when the anchors came
from the second call, and the run header counts the drafts that lacked a block beside those the
second call recovered, so a run reports the omission rate and the recovery rate together.
`--no-anchors-reask` restores the single call. The cost projection does not count the second
calls; the actual-cost line does.

**Claim schema (`--claim-schema`, experimental).** Three terms first. A **claim
object** is a claim as structured data rather than text: a preamble form, a
purpose, the elements each with the code anchors it rests on, and the dependents
each with a parent number and a kind. The **frame** of a claim is its shape apart
from its substance: the preamble form ("A method for …, the method comprising the
steps of:"), the transition, the dependent kinds ("wherein", "further comprising"),
and how many elements and dependents it has. The **litigated population** is the
set of 380 asserted claim 1s and their 3,293 dependents measured for
[`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md), whose frame
statistics live in `src/core/claim-frame-tables.json`.

With the flag, the drafter does not write claim text; it fills a claim object and
CodeExam renders the text. What that buys:

- The frame comes from the litigated population — its preamble forms, dependent
  kinds and count bands — so a draft reads like a real claim in shape while the
  substance of each element stays the model's.
- Each element is paired with its anchors from the start, so the artifact lists a
  claim's cited anchors element by element, and an element with no grounded anchor
  is visible as such.
- What a schema cannot say — a method step opens with a gerund, a dependent names
  claim 1 or an earlier dependent — is checked after drafting; a draft that fails
  is redrafted once or twice with the failure named, and the artifact says which
  checks the redrafts answered.
- Every engine fills the same object (a local GGUF through a grammar, Claude
  through a forced tool call, the OpenAI-style endpoints through their structured
  output); `--show-prompt --claim-schema` prints the schema the engine is given.
  With `--claims-only` the object itself is saved in the `.anchors.json` sidecar
  beside the output, under a `schema` key.

Costs: the schema is sent with every call, so a schema draft costs more input
tokens than a free-text draft of the same group, and each redraft is one more call;
the projected-cost line counts the schema but not redrafts, which the actual-cost
line reports. The default (no flag) is the free-text path, unchanged. Expect little
visible change on Claude method claims: measured on free-text runs, Claude already
writes the population's transition, preamble form and dependent references nearly
every time. The flag shows where an engine drifts: a claim returned in the wrong
statutory class, cited anchors lost to free-text parsing, method steps that do not
open with a gerund, and system or apparatus claims (`--claim-class system`,
`apparatus`) whose elements do not open as noun phrases (the ledger in
[`claims-pipeline-state.md`](claims-pipeline-state.md) §6 has the per-engine
numbers).

## How candidates are identified (and what it does not promise)

The set of candidate mechanisms is produced **deterministically, with no model**:
the grouper (`--pseudo-claims --candidates`) clusters the index's functions by
signals like shared name-tokens, membership in the same class, a module's leading
doc comment, and the command/handler catalog, then emits each cluster as a
`# Label` + `file@func` group. A command's group is its handler and the functions the
handler reaches through two levels of calls, up to forty, and it is never split into
sub-groups: one command, one mechanism (the `# catalog closure:` line of a candidates file
reports the depth, the cap, and how many reachable functions earlier seeds had already
taken; 2026-10-25). Because this step is model-free, **different LLMs
drafting from the same candidate list draft claims for the same set of
mechanisms** — the models change the *wording* of each claim, not *which*
mechanisms exist. In other words, the identification of candidate mechanisms
lives entirely in the deterministic candidate selection; the model is a drafter,
not the one that picks the mechanisms.

**`--rank`: one model pass to order the list.** The grouper's list can run to
hundreds of groups (57 on secp256k1, 959 on Bitcoin Core, 3,465 on Spark,
2026-10-24), which is a daunting thing to read top to bottom. `--rank` sends the
candidates to a model in batches of twenty, with a playoff among the top tier, and
tags each group `[P3]` down to `[P0]`. Its rubric is exploration priority, where to
look first in an unfamiliar codebase: codebase-specific mechanisms at the top,
standard patterns and library wrappers below, vendored third-party and generated
code last, with a forced spread so that not everything lands at the top. It is
observe-only: the anchors are unchanged, the list is reordered and annotated, and a
drafted chart's contents table and claim headings carry the tag. Two things to
know. With a ranked list, `--min-rank` defaults to P2, so drafting from it with no
further flag skips every P0 and P1 group; `--min-rank 0` drafts them all. And the
rubric is not "what a patent would read on": in the real-world test below, the code
the litigants' claims read on sat at P1 and P2 in the rankings ("standard-pattern",
"crypto plumbing", "third-party") while the P3s were the codebases' own
distinctive arithmetic. Cost: $0.12 for 57 groups, $1.62 for 959 (Claude Sonnet
4.6, 2026-10-24).

**It samples; it does not survey — so it can miss the mechanism you care about.**
By default the grouper covers only a small fraction of a codebase's functions
(measured at ~8% on one large corpus — issue #302): it lands where its own signals
point — shared name tokens, one class, a documented module, the command catalog —
not necessarily where a particular invention lives. (These signals are the
grouper's, deterministic and generic. They are not the importance estimate of
[`MEASURING_IMPORTANCE.md`](MEASURING_IMPORTANCE.md), which ranks terms, functions
and files for search and the Overview, though the two share one ingredient: the
grouper down-weights name tokens that are common across codebases, using the same
cross-corpus vocabulary.) A mechanism whose functions don't share the grouper's
signals (no common name-tokens, not one class, spread across files, below the
size/commonality thresholds, or in excluded/vendored code) may form no candidate
group at all. So although a candidate list and a pseudo-claims contents table can
look exhaustive — "the invention must be in here somewhere" — there is **no
guarantee of completeness**. Much of the value is precisely in *eyeballing* those
lists for mechanisms you hadn't named; just don't read a large number of
auto-generated pseudo-claims as coverage. Claim-guided gathering, to steer the
sample toward a known claim's concepts, is proposed in issue #302 (and richer seeds
in #289).

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

Each line is one candidate group's header, as described under *Running it*: the
grouper's label, the function count, and the purpose harvested from the module's
leading comment; its functions are the anchors below it in the file. A drafted
chart opens with a contents table of its own, one line per claim: its number, the
label, and the first words of the drafted preamble; with `--rank` each line carries
the `(P<n>)` tag and the claims come in priority order, and a group the ranker
marked `split` is flagged as over-broad above its claim.

**What the real-world test says about candidate identification (2026-10-24).** On fourteen
litigated filings, CodeExam's three top-ranked groups per repository, drafted and
compared with the asserted claims, came as close as the litigants' own cited
functions on six of twelve pairs and closer on two; on the four pairs whose claim
turns on one specific mechanism they wrote nothing of it, and the cited code sat
low in the ranking. Candidate identification finds what is distinctive in a codebase;
what a patent reads on is often a standard mechanism, or a vendored one. The numbers and
the reading are in *The real-world yardstick* below and on
[`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md).

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
- **Frame from the population (`--claim-schema`, experimental).** On the free-text
  path the model chooses its own preamble, transition and dependent forms. Under
  `--claim-schema` those are enumerated from the 380 litigated claim 1s and their
  3,293 dependents (see the *frame* paragraph on
  [`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md)), the
  dependent count is bounded above by the 90th percentile of dependent counts in
  that population (its p90), and CodeExam writes the text. Not yet: exemplars
  chosen from the population and a rerank of several samples by shape distance
  (the grammar says what is allowed, not what to prefer), and a GUI or MCP control.
- **Statutory class.** Pseudo-claims default to **method** claims, which is why a
  run can look all-method. `--claim-class` takes the class, or a mode (2026-10-25):
  `system` writes "A system comprising: a memory storing …; a processor configured
  to …"; `apparatus` writes a thing by its parts, "An apparatus for …, comprising:
  a receiving unit configured to …; a controller coupled to … and configured to
  …", drawing its preamble forms from the apparatus- and device-headed claims of
  the litigated population; `crm` writes the computer-readable-medium form. `auto`
  picks per mechanism by a stated rule keyed on the code's shape, reason recorded
  per claim: several classes with roles or hardware and I/O vocabulary say
  apparatus, one class whose methods are what it does says system, handlers and
  free functions say method. `both` drafts method and system (the measurement
  mode); `all` drafts the mirror set real software patents carry, method, the
  machine form `auto` would choose, and crm, labelled. The run footer prints the
  class mix beside the litigated claim 1s' (method 49%, machine-class 18%, where
  the population files system, apparatus and device claims together; medium 4%),
  a measurement rather than a quota: in those filings apparatus
  and device claims are a minority, a third the size of system claims, and only
  5% of patents are method-only. The flag affects pseudo-claims only — not the
  `--claim-*` search/chart commands — and renaming it to `--pseudo-claim-class`
  for clarity is under consideration (the current name would remain as an alias).
- **Broad vs. tight drafting (idea).** The most useful claim steers between the
  *broadest* language that still captures infringement and the *narrowest* that
  avoids prior art. CodeExam does not yet draft a broad and a tight version of the
  same mechanism to bracket that "sweet spot" — but the framing already exists on
  the retrieval side: `--claim-analyze` generates **TIGHT** (narrow,
  higher-confidence) and **BROAD** (wider, merged) term sets to steer search
  (`--vocab-tight`), and the same broad/tight steering could drive two drafts of
  one mechanism. Described here for now rather than filed.
- **Other ways of ranking.** The `--rank` option surfaces what it was built to
  surface (where to look first in an unfamiliar codebase); other ways of ranking
  could try to prioritize some notion of "litigable" code. See the initial
  discussion in [`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md).
- **Comparing / merging models.** Drafting the same candidate list under several
  models and synthesizing the results is the `--chorus` / merge-multiple-AIs idea
  (#278). Until then, run twice and compare by hand.
- **Self-test (prose↔code bridge).** Pseudo-claims are also how CodeExam tests —
  and manufactures ground truth for — its own claim↔code association; see the
  *Self-test* section below.
- **Pseudo-claims generation on air-gapped local models.** More testing is
  required with `--pseudo-claims` on local GGUF models such as Gemma 4 and
  Qwen 3.x.
- **Grouper and drafter work on the worklist (2026-10-25), in sequence.**
  `file-seed-residue-groups` (landed 2026-10-25: when other seeds have taken
  some of a documented file's functions, the remainder forms its own group,
  labelled `[file] X / rest`, under the three-function gate alone; the
  candidates header counts residues apart from whole-file seeds, and the triage
  reads `/ rest` as a split residue);
  `catalog-seed-handler-flag-label` (landed 2026-10-25: when several
  command-line options resolve to one handler, the catalog-seeded group is
  labelled by the option whose words best match the handler's name, and the
  other options ride in the purpose as `(also ...)`: `[cmd] --pseudo-claims`
  rather than `[cmd] --candidates` for the drafting handler);
  `grouper-vendored-root-single-top-folder` (landed
  2026-10-25: an index whose whole tree sits under one manifest directory is
  the project itself, not a vendored subtree to be excluded, as a zip or
  parent-folder index was being read, and a `--filter` run that matches nothing
  because everything was excluded now says so instead of advising a broader
  term); `pseudo-claims-anchor-notation-count` (grounded anchor records carry
  the notation shape of each reference, so the output can count them by form).
  Each is a correction to candidate identification or to the anchor record, not a
  change to drafting; the page says when each lands.

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

Not yet, also: a ranked one-command `--pseudo-claims --auto` (#284).

## The real-world yardstick (2026-10-23 and 2026-10-24)

The self-test below manufactures its claims. A second test uses real ones: it
seeds the drafter with the functions fourteen litigants cited in public claim
charts, nothing else, and compares each drafted claim element by element to the
asserted claim, with a floor (a draft from an unrelated group of the same
codebase) and a control (the same draft against another filing's claim of the same
art). It measures the drafter's ceiling on real claims: whether, given a party's
own code, the drafter writes something close to that party's claim. Its other half
(2026-10-24) seeds the drafter with CodeExam's own top-ranked candidate groups
instead (`--pseudo-claims --candidates --rank`, the top three per repository) and
judges them the same way: pseudo-claims as a test bed for claim charts, with the
public filings as the answer key, which is agreement with a party, never
correctness.

**How CodeExam did.** With the litigants' references, the pseudo-claim reaches met
or partial on the asserted claim's mechanism elements, above the floor and the
control, on 11 of 15 pairs scored; it reaches MET, the same limitation in
substance, on 3 pairs. Everywhere else the elements are PARTIAL: the drafter
writes the mechanism at the code's grain and the claim states it at the patent's;
what a claim asserts beyond the code is not written from any seed. Without the
references, CodeExam's own top three groups came as close as the citation on six
of twelve pairs and closer on two, and wrote nothing of the claim on four, the
ones whose crux is one mechanism in one place; there the cited code sat at P1 or
P2 in the ranking. Read together: as a description of the code it is given, the
drafter is confirmed within the test's limits; as a way to find, unaided, the code
a patent reads on, it is not, and the limit is in the ranking's axis rather than
in the drafter.

**What follows from it.** A comparison arm (unranked, `--rank`, and a ranking
built for "what would a hostile party find significant here") on the same pairs is
the next measurement before any new ranking is built; the sketch is on the ceiling
page. The `--min-rank` default of P2 on ranked lists deserves a second look, since
it drops the P1 groups that two of the four misses lived in. The limits of the
test are stated on the same page: one model as ranker, drafter and judge, one
sample per row, fourteen filings. Method, tables, the four quoted rows and the
reading: [`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md).

## Self-test: "huffing our own fumes" (HOF)

Pseudo-claims are not only a deliverable — they are one way CodeExam tests its own
ability to bridge *claim prose* and *code*, and a way to **manufacture ground
truth on any index**. (The usual claim↔code answer keys are all limited in scope:
a hand-built set is tiny, `.demo` was LLM-authored, and a real patent may share
vocabulary with *its own* implementation (only may, because the patent attorney
will have taken what the developers did, and broadened the claim description to
try to capture more IP). A "match" may be mere word-overlap rather than real
claim↔code skill. Usually claim↔code mapping involves one party's patent claim and
*another* party's code; see issue #322 on CodeBERT.)

The self-test — "huffing our own fumes" (HOF) — runs:

1. **Draft** pseudo-claims from code with their **code references attached** (a
   candidate mechanism → a pseudo-claim → the anchors it was drafted from).
2. **Synonymize with a *different* LLM**, *withholding* the code references
   (`--synonymize`). This is the load-bearing step: it rewords the claim *away*
   from the code's own identifiers, so any later recovery cannot be mere
   vocabulary overlap.
3. **Retrieve**: feed the reworded claim to `--claim-analyze` / multisect and
   measure whether it lands back on the original references, with each reference
   attributed to a plausible element of the claim rather than merely found.

Agreement means the claim captured the *mechanism*, not just echoed its names.
`--claims-loop` repeats draft → retrieve → compare → refine to convergence
(#290). Full write-ups: [`claims-pipeline-state.md`](claims-pipeline-state.md)
(§4 / §9 / §10) and
[`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md) (the HOF
section; #310).

## See also

- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — searching and charting
  *real* patent claims against code (pseudo-claims' sibling).
- [`claim-chart-drafter-ceiling.md`](claim-chart-drafter-ceiling.md) — the
  real-world yardstick: the drafter against fourteen asserted claims, with and
  without the litigants' references.
- [`MEASURING_IMPORTANCE.md`](MEASURING_IMPORTANCE.md) — how CodeExam decides what
  to surface, and how that differs from the grouper's signals.
- [`AIR_GAPPED.md`](AIR_GAPPED.md), [`LOCAL_LLM.md`](LOCAL_LLM.md) — local /
  air-gapped drafting.
- [`CODEEXAM_NOTATION.md`](CODEEXAM_NOTATION.md) — the `file@func` / anchor
  notation.
