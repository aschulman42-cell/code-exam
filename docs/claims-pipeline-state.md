# Claims pipeline — state at a glance
> **Engine qualification**: before trusting a new engine/build, run the two-claim pair in docs/engine-qualification.md (scripts/engine-qualify.mjs scores it mechanically).


**Current state only.** No history, no reasoning — those live in issues and commit
messages. Tables, not prose.

> **Maintenance rule:** every change to claim behaviour updates this file **in the
> same commit**. A state doc that lags is worse than none, because it is believed.
> New measurements append a ledger row. Answered questions are deleted from
> §7, not annotated — the answer belongs in §6.

Last updated: 2026-08-13.

**Bottom line (Andrew, #310).** CE must produce claim charts that (i) pass a smell
test by an expert source-code examiner in patent litigation, and (ii) correspond to
a testable ground truth, on **more than a tiny hand-picked set of indexes**. Doing
that with Claude / ChatGPT / Gemini is the rock-bottom minimum; it must also work
**end-to-end air-gapped** on a US/Europe GGUF on a GPU — currently a Gemma3-12B
variant as the "local hero".

---

## 1. Commands

| command | retrieval | matches | analysed unit | status |
|---|---|---|---|---|
| `--multisect` | whole-claim terms | **file bodies** | — | base search; IDF ranking in `commands/`, not `core/` |
| `--claim-search` | whole-claim | **file bodies** | — | same quorum problem as `--claim-analyze` |
| `--claim-analyze` | whole-claim, quorum | **file bodies** | top-N (default 6) | **the quorum arithmetic (§2) is why CE misses the known answers** — `SecureChannel::sendMessage` on `.demo`, `AdaptiveTrackSelection::updateSelectedTrack` on '101×ExoPlayer3 |
| `--claims-loop` | whole-claim + **sponge suppression** | **file bodies** | per claim | **not a claim-charting command** — the #290 self-test harness and our **GT-ish source of claims + code references**, §4. `minTermsFrac 0.75` counts dead terms → 0/8 agreement (#306) |
| `--claim-locate` | **per-element**, no quorum | **symbol names** (§2) | — | works. Run-to-run variance is **cloud-only** — two local models are bit-stable; cloud runs need >1 run + merge (§3c) |
| `--claim-chart` | `--targets` given → none; else **per-element** | **symbol names** | per target × all elements | rows from `splitClaimElements`; per-element path added `e17e40d` |

**Not obvious and load-bearing:** `--claim-chart` changes retrieval depending on
whether `--targets` was supplied.

## 2. Retrieval mechanisms

**Two different searches. They are complementary, not ranked.**

| | whole-claim (`multisect`) | per-element (`claim-locate`) |
|---|---|---|
| unit | whole claim, one shot | one search **per limitation** (how a claim becomes limitations: §3b) |
| model emits | regex search **terms** | code **words** per element |
| searched against | file **body text** | symbol **names** only — see below |
| gate | quorum (`min_terms`) | none — ranked, top-25/element, plus the next 35 by name when the search hits the cap (10-22) |
| blind spot | well-named single-purpose functions | badly-named functions (`process()`, `doWork()`) — an unavoidable naming dependence, and the reason to keep body search too |

**What "symbol names" covers** (measured on `.demo`, 154 symbols).
`buildSymbolTable` reads `index.functionIndex` only, so per-element search sees
**functions AND the classes/structs/top-level names that index holds** — 63 of 154
carry no `::`, e.g. `SecureChannel`, `ChannelMessage`, `session_entry`. It does
**not** see filenames, non-code files (`.md`, `.txt`), or struct *members*. Only
`.c/.h/.java/.py` contributed symbols here. So `channel` matches the *class*
`SecureChannel`, which is how it reaches `SecureChannel::sendMessage`.

**The quorum arithmetic.** A function implementing 1 of N limitations holds
roughly 1/N of the claim's vocabulary. Measured on `.demo`:
`SecureChannel::sendMessage` scored **2/12** terms against a quorum of 6. Adding
the missing term takes it to 3/12. **No term-set fix reaches it** — the whole-claim
quorum structurally excludes single-limitation implementers, and selects instead
for long orchestrators that name-drop everything (the two functions analysed were
the two longest, 87 and 103 lines).

**Why that does not contradict "multisect prefers smaller functions".** The sort is
`terms_matched DESC, then lines ASC` (`core/multisect.js:485-489`) — **size is only
a tiebreak between functions matching the SAME number of terms.** Term count
dominates, and a long function mentions more of the claim, so it wins before size
is consulted. The real tension Andrew names is genuine and unresolved: huge
Frankenfunctions match everything, and small single-purpose ones cannot hold enough
of a whole claim. **Per-element search dissolves it rather than balancing it** —
each limitation is scored against its own vocabulary, so a 40-line function is not
asked to embody a five-limitation claim.

**The candidate cap.** `searchSymbolsByWords` returns top-25 per element. An
element whose search **hits 25 has not discriminated** — ranking among 25
undifferentiated candidates is arbitrary, and which 3 reach the chart is luck.
One high-frequency word saturates it alone: `session` matches 22 of 154 symbols
(14%) in `.demo`. **Cap-hit is a per-row reliability predictor, confirmed on four
engines with no exceptions** (§6): the engines whose element-10 search hit the cap
are exactly the engines that lost element (e).

**But the cap is ABSOLUTE and discrimination is RELATIVE — it does not scale.**
25 of 154 symbols is 16% of `.demo`; 25 of 65,370 is **0.04%** of ExoPlayer3. On
the '101 run every one of 10 elements hit the cap **and the retrieval still found
the crux** (§6). So on a large index cap-hit is not a reliability signal, it is
just the ceiling. Any warning built on it must use a **relative** measure — share
of the index matched, or whether the rank scores actually separate.

**What the cap does now (2026-10-22, `claim-locate-pool-at-scale`).** Three
things, each deterministic and each reported: (1) the cap is *said* — the
per-element log line reads `25 candidate(s) (cap: 1,203 matched, 35 more offered
by name)`, the run counts its cap-bound elements, and the targets file carries
`# Element-matched: N (at the cap; M more offered by name)` on those elements
only; (2) beyond a full window the next names up to rank 60 ride on the search
result as `more` and the selection prompt offers them under "Also matching",
full names grouped by class, so a cap-bound element offers more than a sample
without the per-line cost; below the cap the prompt is byte-identical to before;
(3) the element's own content words (`elementOwnWords`: claim-terms' content
words minus the predicted words, de-duplicated by stem) break ties at half
rarity weight, so among candidates with equal predicted-word evidence the one
the claim's own words name ranks first — `findNextInnerJoinRows` on `join`
plus `rows`, `inner`, `next` — without creating a match on its own. The
relative measure this section asked for is still open; what landed is the
report and the wider window.

**Too-popular-to-be-informative, twice.** `--claims-loop` already demotes
**sponges** — a function topping more than `spongeT` (default 2) distinct claims'
searches, e.g. `printUsage`, `x265_param`, whose help text and parsers match
everything (`claims-loop.js:193-207`). That is the same phenomenon as `session`
flooding a candidate list, and as `argparse.js` ranking first in the CE self-test.
**The mechanism exists in `claims-loop` and, since the MCP claim tools landed
(2026-10-12), in `claim_candidates`, which marks sponges across one claim's
elements** — `claim-locate`, `claim-analyze` and `claim-chart` still have no
equivalent. Another instance of the #309 class, and a
tuned in-tree precedent for the "prune high-frequency terms" idea in §3/(c).

A sponge is an **overly-attractive distractor** — it absorbs searches it does not
belong to. **But high frequency is not the same as uninformative**: `worklist` is
everywhere in a Bram index *and* is the right term for a worklist claim. So any
pruning must key on "matches many DISTINCT claims/elements" (what `spongeT`
already does) rather than on raw corpus frequency, which would discard exactly the
domain terms that matter. **Unresolved; do not ship a raw-frequency cutoff.**

**The retrieval acceptance instrument** is
`test/fixtures/retrieval-reachability-8752101-exoplayer3.json` +
`test/test_retrieval_reachability.js`: two externally-named implementer lists
for '101 × ExoPlayer3 (ChatGPT's reference chart, asus-CC's prior reading)
with per-symbol provenance, run model-free through the full default selection
stack. REPORT + RATCHET — it reports N-of-M reachable per provenance set and
fails only on regression below the recorded high-water mark (baseline
2026-09-04: union 2/20, one family). A retrieval change is measurable the day
it lands; see the fixture's single-pairing caveat before tuning against it.

## 3. Roadmap — Andrew's (a)–(h), with state

**Andrew's original wording (2026-08-12), verbatim:**

> (a) do code searching based on elements/limitations, instead of (or in addition
> to) whole-claim (which has been multisect focus); (b) more granular splitting of
> claims into elements/limitations than just on `;` punctuation; (c) some changes
> to how limitations turned into candidates/targets, including possibly multiple
> runs and getting majority vote; (d) for local model, moving from external
> generation of (c) to generation of (c) on local model (though maybe consider
> different local models for different parts of the claim pipelines??); (e) review
> existing code and output from this point on, I've lost track, but I'm sure work
> needed; (f) add `--claim-chart` to `--claim-analyze`; (g) move to a single
> end-to-end pipeline, where user doesn't need to know about multiple cmds (and
> some cmds we've used in testing maybe can be removed); (h) get working in GUI.

| # | item | state | note |
|---|---|---|---|
| **(0)** | **end-to-end harness for the per-element pipeline** | **missing — added** | `claim-selftest.mjs` scores whole-claim retrieval only. Four retrieval intuitions were wrong when measured this week (concept bridge, stemmer, IDF, stub verification). (a)–(d) are all retrieval changes; without a harness the guess-and-measure cycle repeats by hand. **§4 (HOF) is the general form of this** — same need, arbitrary corpus instead of one hand-built answer key. |
| (a) | search by element, not whole claim | **partly done** | `claim-locate` always did; `claim-chart` since `e17e40d`. `--claim-analyze`/`--claim-search`/`--claims-loop` still whole-claim. **"In addition to", not "instead of"** — §2 blind spots are complementary. |
| (b) | finer splitting than `;` | **partly done** | `e17e40d`: '101 6→10 rows; TLS demo 22 shattered fragments → 11 clean. `--elements @file.txt` is the escape hatch. **Andrew TODO: his own writing on limitation-splitting**, to mine for deterministic rules — highest-leverage remaining input, and gates everything downstream. Part of it will be a checklist against splitting already done (`.demo` doubled its limitation count). |
| (c) | multiple runs, **merge or vote** | **design corrected; now CLOUD-ONLY** | **Union for TARGETS, majority for VERDICTS.** Element (e)'s implementers were individually 3/5, 2/5, 1/5 — a majority rule on targets discards two correct implementers. Union what you look at; vote on what you conclude. **Cloud-only, settled 08-12**: Gemma Q4_K_M *and* Qwen3-14B are both bit-stable across runs, so this is a property of greedy decoding at temperature 0 — portable to whatever model ships, and the local path never needs multi-run. |
| (d) | **local model generates targets/candidates** | **not started** | Different builds already behave differently: QAT Q4_0 fails the `parseElementWords` format contract (0/7 parsed) where Q4_K_M passes (11/11). Andrew's "different models for different pipeline stages" is plausible — vocabulary step is one ~600-token call, analysis is large — but unmeasured. **The vocabulary step works on 1 of 3 local builds** (§6). That is real brittleness in CE's LLM use generally — between-run variance, near-identical Gemma builds behaving differently. **Smallest useful mitigation: block known-bad `.gguf` files with an explanatory message**, so no user expects any GGUF to work, plus an `--override` for field testing. |
| (e) | review existing code + output ("I've lost track") | **this document** | Its job is to be the thing that stops that recurring. |
| (f) | fold `--claim-chart` into `--claim-analyze` | **not started** | Blocked on (a): merging them while they use different retrieval would freeze the wrong one. |
| (g) | single end-to-end pipeline; retire test-only commands | **not started** | Do before (h). |
| (h) | GUI | **not started** | Last. Do not build onto a pipeline about to be replaced. |

## 4. Huffing our own fumes (HOF) — the self-test sub-pipeline

**Nearer-term than first written (Andrew, #310):** if it works it yields a LARGE
self-test with real GT-ishness for claims + code references, on arbitrary indexes.
The **separate synonymizer, run by a different LLM, is the key missing piece** —
and is needed for other things anyway.

The problem it solves: every ground-truth corpus we have is compromised.
`ce_anchors.lst` is hand-written and small; `.demo` was authored with its own
claim, so claim and code share vocabulary; '101 is real but has no answer key.
HOF **manufactures** ground truth for an arbitrary CE index.

| step | what | status |
|---|---|---|
| HOF-a | generate pseudo-claims **with attached code references** for any index | **blocked on anchor DISCOVERY, not on drafting.** `--pseudo-claims` v1 is *explicit-anchor only* — you supply `file@func`, CE does not auto-discover (deferred, #281). Its distractor test measured ~29% precision from a noisy pack: the model drafts confident, coherent claims about the WRONG functions. So the code references are its INPUT, not its output |
| HOF-b | **synonymize** the pseudo-claims with a *different* LLM, **withholding the code references** | not built |
| HOF-c | feed synonymized claims to `--claim-search` / `--claim-analyze`; measure (i) did it recover the original references, (ii) were they assigned to reasonable limitations | not built |

**HOF-b is the load-bearing step, and it is the only thing on the board that
manufactures the vocabulary-translation gap.** Withholding the code references
while a second model rewrites the prose is what forces claim wording away from
the identifiers — exactly the gap `.demo` lacks and '101 has. That makes HOF the
answer to the open question in §7 about corpora with no shared vocabulary,
without needing a real patent and a real answer key at the same time.

**What `--claims-loop` actually is** (Andrew had lost track; it is not a charting
command): the #290 harness that fills pseudo-claim chart cells and measures
**draft↔retrieve agreement**, from a finished chart plus the candidates `.lst`
that produced it. Three parts — anchored element mapping (fill), retrieval with
sponge suppression, and **convergence flags**: a claim that is ABSENT-heavy
against its own anchors AND retrieval-silent is flagged *"Needs redraft"*.

**Two alternative GT-ish sources (Andrew, #310), independent of HOF:**

- **`claimlen` corpus** — Andrew's earlier work over a large body of real software
  / networking patent claims, applied against the biggest current indexes
  (Windows disasm, Windows SDK samples, iOS headers, Spinellis).
- **USPTO litigated-patents spreadsheet** — filter to defendants like Microsoft or
  Apple, juxtapose claim 1 against e.g. the Windows disasm or iOS headers index.

Both give *real* claims at scale. Neither gives a code-reference answer key, so
they test smell-test plausibility rather than recall — complementary to HOF, not a
substitute.

**In hand since 2026-08-15:** `randpat_2020_claims_sorted.txt` and
`randpat_2020_indep_claims.out.txt` — **5,382 de-duplicated independent claims**
across two formats (`<len> <patent> <claim#>. <text>` and
`<patent> <claim#>. <text>`).

*Provenance caveats, Andrew's own (do not quote rates from this corpus without
them):* ~6 years old, output of his `getpat.awk`, and **possibly text-filtered at
the time** — Greek letters, equations, and references to external portions of
patents may have been altered. Probably light on **AI/ML and business methods**,
and may be patents generally rather than software/network — a keyword smell test
puts 90.7% carrying software/network vocabulary, which is an upper bound, not a
classifier. A fresh list would be better; the PTO has made building one much
harder than when that program was written.

**What it is good for regardless: every claim-TEXT question** — splitter
behaviour, preamble handling, boundary words, element-count distributions. Those
need no code, no index and no answer key, so the caveats above barely bite. It is
**not** a retrieval benchmark: there is no associated code.

**First result from it, and it is a defect:** CE **discards the preamble on 98.7%
of these claims** (5,297 of 5,369; retained in element 1: zero). Cause is
`splitClaimElements`' single-line path, which drops everything before the first
colon — and real corpora deliver claims as one line, while both CE test claims
are hand-wrapped and take other paths. Confirmed independently of the corpus:
'101 joined to a single line splits into **2 elements with no preamble** where
the shipped multi-line file gives **10 with the preamble first**. Worklist:
`claim-splitter-preamble-restore`.

**The loop is currently one pass that emits a redraft signal, not an automated
loop to convergence.** Andrew's original intent — iterate until pseudo-claims and
their code references converge — is the unbuilt half, and is what would drive
HOF-a.

**Frame tables (2026-10-19, #322 stage 1).** `scripts/build-claim-frame-tables.mjs`
writes `src/core/claim-frame-tables.json`: the words real litigated claims put
AROUND the invention, with counts — the preamble class (the 2026-09-01 rule that
split the fixture for the `litigated-system` profile, now a function), openers,
skeletons (`a method for ..., the method comprising the steps of`), transitions,
element openers per class and, from the 385 families, dependent reference
phrases, openers, subjects and contributions by depth (§6 has the figures). The
shape profiles say how MANY elements and dependents a claim 1 carries; these say
which WORDS carry them. They feed `--claim-schema` (experimental,
`src/core/claim-schema.js`, same day): a claim *object* schema whose preamble
forms and dependent kinds come from the tables and whose counts come from the
profiles, rendered to claim text by CE on every engine (a JSON-schema grammar
locally, a forced tool call on Claude, `response_format` on the OpenAI-style
endpoints, with a logged downgrade when an endpoint rejects the bounds), and
post-checks the schema cannot express (a method step opens with a gerund; a
dependent names claim 1 or an earlier dependent) that resample a failed draft
with the failure named. The HOF pair — claim element, anchored function —
therefore exists at drafting time, in the sidecar's `schema.object`, instead
of being recovered by a second pass. Not yet: exemplars by population and a
rerank by shape distance (allowed by grammar, preferred by exemplar, measured
by the report). A rebuild is a script run; the claim-1 half rebuilds
from the in-repo fixture and is tested, the dependent half needs the local
corpus and the JSON says which inputs it saw.

## 5. Known broken

| what | where |
|---|---|
| `--targets file@fn` discards the file prefix → charts a *different* function | #309 Part A — workaround: qualify with the **class** after the `@` |
| credential mask defeated by `vocabulary` (context-keyed mask vs context-destroying tool) | #309 Part B — security |
| `--reproducible` **rejected** by the CLI (`Unknown option`, exit 2) — GUI-server only | #309 Part C — *not* an instance of the accepted-but-inert class; corrected 08-12 |
| `\|\|result:` prefix + literal `\n` in local overviews (node-llama-cpp `jsonDumps` on every tool result) | #306 — post-processor proposed, not built |
| `--claims-loop` `minTermsFrac 0.75` counts dead terms | #306 |

## 6. Measurement ledger

**`n` is the column that matters. Most of what we believe is one sample.**

| what | corpus | engine | n | date | result |
|---|---|---|---|---|---|
| CE self-test, scope ladder on | `.CE_080426` | deterministic | 1 | 08-11 | `found=3/5 best=12`; 2 anchors below quorum |
| CE self-test, ladder off | `.CE_080426` | deterministic | 1 | 08-11 | `found=1/5 best=20` |
| element splitting | '101 claim 1 (×ExoPlayer3) | deterministic | 1 | 08-11 | 6 → **10** rows |
| element splitting | `sample_patent_claim.txt` (TLS demo) | deterministic | 1 | 08-11 | 22 shattered mid-sentence fragments → **11** clean |
| `--claim-analyze` | `.demo` | claude | 1 | 08-11 | element (e) **ABSENT** (wrong); 3 orchestrators analysed |
| `--claim-analyze` | `.demo` | gemini | 1 | 08-11 | element (e) **ABSENT**; 3 of 6 targets were config parsing |
| `--claim-locate` coverage | `.demo` | claude/pooled | 1 | 08-12 | **5/5** element groups vs README answer key |
| `--claim-locate` variance | `.demo` | claude/pooled | 5 | 08-12 | 0/5 lost; diff 2.2 (worst 4); core 90%; GT-stable 94% |
| `--claim-locate` variance | `.demo` | claude/per-element | 5 | 08-12 | **2/5 lost (e)**; diff 6.6 (worst 11); core 72%; GT-stable 84% |
| `--claim-locate` variance | `.demo` | chatgpt/per-element | 5 | 08-12 | 0/5 lost; diff 8.2 (worst 12); core 58%; GT-stable 76% |
| `--claim-locate` variance | `.demo` | gemini/per-element | 4 | 08-12 | **2/4 lost (e)**; diff 4.2 (worst 7); core 81% (run 4 dropped: network) |
| cap-hit predicts loss | `.demo` | **4 engines** | 19 runs | 08-12 | at cap → lost (e); below cap → never lost. **No exceptions.** chatgpt 9-14 / gemini 25 / claude 25 / gemma 11. `session` = 22/154 symbols |
| per-element discovery | `.demo_code_only` | gemma QAT | 1 | 08-11 | located `sendMessage`, `streamData`, `verify_certificate_chain`, +34 |
| quantization / format | `.demo_code_only` | gemma QAT vs Q4_K_M | 1 | 08-12 | QAT **0/7** parsed, exit 1; Q4_K_M **11/11** |
| per-element chart | '101 × ExoPlayer3 | gemma QAT | 1 | 08-11 | 0 PRESENT · 1 ASSUMED · 9 ABSENT; acceptance symbol absent |
| hand-targeted chart | '101 × ExoPlayer3 | gemma QAT | 1 | 08-11 | 1 PRESENT · 1 PARTIAL · 1 ASSUMED · 3 ABSENT |
| overview sweep before/after | 51 corpora | gemma QAT | 1 | 08-11 | AI/ML footnote 0%→**21%**; no-prose 33%→34%; `\|\|result:` 48%→47%; literal `\n` 100%; credential leak 1→1 |
| **`--claim-locate` on the real patent** | **'101 × ExoPlayer3** | **claude/pooled** | 1 | **08-13** | **10 elements, 28 symbols located, no hand-supplied targets. Found `AdaptiveTrackSelection::determineIdealSelectedIndex` (the rate-determination crux), `getSwitchOrder`, `getSortedTrackBitrates`. `updateSelectedTrack` not located directly — recorded as the crux's caller. All 10 elements at cap** |
| Claude's '101 element words | '101 × ExoPlayer3 | claude | 1 | 08-13 | **translated, did not echo**: `bitrate, codec, buffered, playback, decode, adapt, deadline`. Gemma on the same claim produced `rate, time, reproduce, available` |
| `--claim-locate` variance | `.demo` | gemma Q4_K_M/per-element | 5 | 08-12 | **0/5 lost; 0.0 pairwise diff; core 100%** — byte-identical |
| `--claim-locate` variance | `.demo` | qwen3-14B Q4_K_M | 5 | 08-12 | 4 of 4 byte-identical to run 1 — **determinism is greedy decoding, not one model** |
| element-10 words | `.demo` | gemma Q4_K_M | 5 | 08-12 | `[data, encrypt, channel]` → 11 candidates, identical ×5. Picked `channel` (7%) not `session` (14%); 3 words, fewest of any engine |
| vocabulary step, local builds | `.demo` | 3 builds | 1 | 08-12 | gemma Q4_K_M **works** 11/11; gemma qat-Q4_0 **0/7** (words good, no numbering, F75); qwen3-14B **empty reply**. Qwen prompt-fit untuned — not a capability verdict |
| frame tables: preamble class | 380-row structure fixture | deterministic | 380 | 10-19 | method 187 / system 70 / crm 15 / jepson 35 / other 73 — reproduces the 2026-09-01 split; 2 of the 15 crm are system by their preamble row (the rule reads the first 120 characters of the claim, and their first element names a medium); `other` head nouns: system 12, method 9, device 5 — the rule's narrowness, not a sixth class |
| frame tables: transitions | same | deterministic | 378 | 10-19 | `comprising` 369 (97.6%), `including` 5, `comprises` 2; 2 rows with none (one typo, `comprsing`); tail `the steps of` 81 (21%), `the computer-implemented steps of` 8 |
| frame tables: method skeletons | same, 187 method claim 1s | deterministic | 187 | 10-19 | 38 distinct; `a method for ... comprising` 24, `a method comprising` 20, `a method for ... comprising the steps of` 20, `a method of ... comprising` 20, `a method for ..., the method comprising` 13, `a method of ..., the method comprising` 13 |
| frame tables: element openers | same, attorney rows beyond the preamble | deterministic | 956 method / 360 system / 93 crm rows | 10-19 | method rows open with a gerund 80.8% (`receiving` 90, `determining` 58, `providing` 56, `generating` / `storing` / `transmitting` 26); system rows with a noun phrase 71.9% (`means for` on 89 rows, `configured to` on 65); crm rows gerund 54.8%; rows per claim median 4 (p10 3, p90 8) |
| `--claim-schema` first live run: free text vs schema, same groups | `.CE_082526`, 4 hand-picked CE groups (`cand_edited.lst`: ranker-eval, mechanism-grouper, claims-loop, `--candidates`) | claude-sonnet-4-6 | 4 | 10-19 | both artifacts scored by `scripts/claim-frame-overlap.mjs`: overlap median 0.188 → **0.181** (mean 0.176 → 0.178); in band 2/4 → 1/4 (the axes that go out are words and rows, which the schema bounds only per element); mechanism median 7 → 8; dependents median 11 → 11; grounded 50 → 49; schema: 1 of 4 resampled, 0 still failing; cost $0.16 (4 calls, 29k tok in / 5k out) → $0.25 (5 calls, 45k in / 7k out) — the schema rides on every call. **A smoke test of the wire, not the measurement**: n = 4 of CE's own code, and the schema fixes the frame, not the diction (§8 row 4 is the diction lever). The 20-group langchain arms are still to run |
| free-text frame conformance by engine: what `--claim-schema` would change | CodeExam self-runs, method class requested: Claude `CE082826_claims_keep` 47 / `sr_gh_SEED_claims_keep` 106 / `CodeExam_claims_v3` 41; ChatGPT `CodeExam_claims_chatgpt` 41; Gemini `CodeExam_claims_gemini_v2` 41; Claude system class `DEMO_zlib_bothways_090126` 9 | claude / chatgpt / gemini | 41–106 | 10-19 | transition `comprising` 99–100% on every engine; method preamble skeleton inside the schema's enum 99–100% Claude, 95% ChatGPT, 100% Gemini; method rows opening with a gerund **78–82% Claude, 60% ChatGPT, 71% Gemini** (population 81%); Claude dependents `of claim N` 100%, `wherein` 81–82%, `further comprising` 18–19% (population 73 / 77 / 17%; the ChatGPT and Gemini runs predate dependents). **Class drift**: Gemini returned 7 system + 1 other of 41 when asked for method; Claude and ChatGPT 0. **Anchors lost to free-text parsing**: Gemini 54 of 446 cited (`no function name to verify`) + 9 not in index; Claude 1 of 248; ChatGPT 0 of 231. **System class, Claude, 9 claims / 80 rows**: noun-phrase rows 28% against the population's 72%, `means for` 0, `configured to` 9. Read: on Claude method claims the schema has nothing to fix, which is what the 10-19 live run showed; it would show on Gemini (class, anchors), on ChatGPT (gerund steps) and on `--claim-class system` on any engine (apparatus rows). Local GGUFs: no free-text sidecar on this machine to measure |
| frame tables: dependents | 385 litigated families | deterministic | 3,293 | 10-19 | reference `of claim` 72.8%, `as recited in claim` 7.7%, `according to claim` 6.5%, `as in claim` 6.4%, 36 with none; opener `wherein` 76.6%, `further comprising` 17.2%; contribution MODIFICATION 66.9% / ADDITION 17.4% / UNDETERMINED 15.7%; per family median 7 dependents (p10 2, p90 17, max 45), max depth median 2 (p10 1, p90 4, deepest 9) — the profile's `dependents` and `depth` axes re-measured unchanged; dep-claim-rules parent = office parent on 3,289, 0 disagreements, 4 unresolvable from the text |

| stem bridge in the symbol search (`claim-locate-stem-bridge`) | fourteen real-world filings, seventeen filing-repository pairs (agreement harness, `docs/claim-chart-agreement.md`) | claude-sonnet-4-6 | 33 `--claim-locate` calls, 17 `--claim-chart` runs | 10-22 | `--claim-locate` plain **19** / blind **23** of 153 cited names (10-21: 15 / 14); the name rule with no model unchanged, 5 before and after; the '101 × ExoPlayer3 reachability fixture unchanged (union 2 of 20; selected targets 30, before 28). Attributable to the bridge: Core Scientific 1-10 element 1, 0 → 25 candidates (20 by stem), `secp256k1_scalar_reduce_512` chosen in both modes. The rest is one-sample movement: Foundry 1-11 +4 by one-hop navigation from a differently-worded seed, ViaBTC blind −2, VM Innovations plain −1; three new agreements by name only (`TestToken.sol@transferFrom`, `FakeGroup::size`, a `Data` class in a tracing script). Two plain calls unparseable (Securitize once, then 2 of 3; True Return twice, as on 10-21; the raw answer is not logged). `--claim-chart` per element regenerated on all 17 pairs: 9 of 153, $8.08 projected; only 3 pairs had an earlier column |
| test filter by directory, file name and symbol name (`claim-locate-test-filter-by-filename`) | the same fourteen filings, seventeen pairs | claude-sonnet-4-6 | 33 `--claim-locate` calls | 10-22 | `--claim-locate` plain **20** / blind **21** of 153 (stem-bridge run: 19 / 23); test, mock, bench and example symbols among the chosen targets across the 33 runs **45 → 41 → 3** (10-21, stem bridge, test filter); the 3 are Securitize's bare `transfer` / `transferFrom` resolved to `contracts/mocks/TestToken.sol` by `verifySymbol` taking the first of three definitions (#343 name-only resolution; the filter had held the mock out of every candidate list). Cited-of-chosen 0.064 (0.067); mean per-run precision 0.127 (0.118). By-name movement is sampling (FriendliAI plain −`size`, the mock's; MARA blind −`MakeKeyData`; Sookbox blind −`getSources`; Securitize plain +`transfer`; VM plain +`wait`). True Return plain unparseable a third time. Reachability fixture unchanged (union 2 of 20, 30 targets). Run stopped once by Claude Code for low memory after 23 of 33, resumed from `%LOCALAPPDATA%\CodeExam\agreement_work`; $0.68 projected |
| second navigation hop with class-first resolution (`claim-locate-second-hop-navigation`) | the same fourteen filings, seventeen pairs | claude-sonnet-4-6 | 33 `--claim-locate` calls | 10-22 | `--claim-locate` plain **24** / blind **28** of 153 (test-filter run: 20 / 21); gains with hop-2 provenance in the reports: MARA 1-11 `Check`, `GetStrongRandBytes`, `MakeKeyData` in both modes ("reached by navigation from GenerateRandomKey via CKey::MakeNewKey", `Check` resolved to `CKey::Check` by the seed's class), Core Scientific 1-8 plain `fe_is_odd`, Foundry 1-14 blind `fe_normalize`, ViaBTC blind `recoverable_signature_load` + `pubkey_save`; Databricks blind `doExecute` is hop 1 resolved to the seed's class. `secp256k1_ec_seckey_verify` (hop 3) still not offered. Cost: 794 chosen rows across the 33 runs (640 before; 24 per run against 19); cited-of-chosen 0.065 (0.064), mean per-run precision 0.130 (0.127); the hop-2 budget of 12 bound in 8 runs. Lost: VM plain `wait`. Three plain calls unparseable on the first call, two parsed on a second, True Return a fourth failure. Reachability fixture unchanged (union 2 of 20, 30 targets). $0.68 projected |
| candidate cap reported, widened to 60 by name, tie-break by the element's own words (`claim-locate-pool-at-scale`) | the same fourteen filings, seventeen pairs | claude-sonnet-4-6 | 33 `--claim-locate` calls | 10-22 | `--claim-locate` plain **26** / blind **27** of 153 (second-hop run: 24 / 28); 207 of 346 element searches at the cap (all elements on Spark, Bitcoin Core, Kodi, cmb, Solana, go-ethereum; none on secp256k1, dss, consensus-specs). Chosen names by where the model saw them (search recomputed from the logged words): 311 chosen, 287 in the window (13 lifted into it by own words), 22 from the compact list (ranks 26–60), 2 elsewhere; **none of the 22 or the 13 is a cited name** — the 24 cited names chosen were in the window unaided, the other 29 of 53 agreements are navigation rows. Cited-of-chosen 0.068 (0.065), mean per-run precision 0.132 (0.130); blind/plain same at 14 pairs. By name: MARA blind −`MixExtract`, True Return plain parsed (2nd call) +2. **'101 fixture moved for the first time today**: union 3 of 20 (floor 2 → 3, dated history entry), `MediaCodecRenderer` reached, asus-reading 1 of 14, 30 targets. All 34 calls parsed (two on a second call). $0.68 projected |

**Corpus caveat.** `.demo` / `.demo_code_only` is contrived — Claude wrote the code
and the claim around each other. It flatters the tool three ways: vocabulary
alignment, ideal naming (helps name-search specifically), and having an answer key
at all. **No `.demo` result transfers to '101 without re-measurement.**

## 7. Open questions

| question | what would answer it |
|---|---|
| Does per-element retrieval survive a corpus where claim and code share no vocabulary? | **Cloud: YES, answered 08-13** — Claude translated on '101 and located the crux (§6). **Local: still open** — Gemma echoed the patent's words on the same claim. HOF-b (§4) is how to test this at scale. |
| Is Claude better than Gemma at per-element, or only asked a better question? | **Partly answered 08-13: it is the MODEL here.** Same command, same claim, same index — Claude translated, Gemma echoed. Earlier runs: it HAS been run before — `8752101_LOCATE.txt`, `8752101_LOCATE_blind.txt`. Both are **stale**: they record `2 element(s)` (pre-`e17e40d` splitter) and show the #309-A qualifier bug resolving `AdaptiveTrackSelection::updateSelectedTrack` → `DownloadHelper::…`. **Re-run on current code — Andrew TODO, needs the API key.** |
| Right threshold for pruning high-frequency query words? | `session` 14% floods; `channel` 7% finds `sendMessage`. And `worklist` in a Bram index is high-frequency *and* essential. **Frequency alone is the wrong key** — prefer "matches many distinct elements", as `spongeT` already does. |
| Do the '101 and CE-self-test findings hold at n>1? | Every row above marked `n=1`. |
| Is the Qwen empty reply capability or prompt-fit? | `buildDiscoverPrompt` was iterated against Gemma. One re-prompt experiment before concluding anything about Qwen. |
| Should a model-admission gate run the vocabulary step? | 1 of 3 local builds passes it, and the M7 gate does not catch any of the three failures. One model call on `.demo`, require ≥1 parsed element. |

## 8. Next worklist items (proposed, in order)

Chosen for Andrew's stated test: **visible incremental improvement, checkable with
`--claim-analyze` before committing, and useful for asus-CC to test against Gemma.**

| # | item | why first | visible how |
|---|---|---|---|
| 1 | **`--claim-analyze` uses per-element retrieval** (roadmap (a), the unfinished half) | The bottom line is charts that find the known answers. `--claim-analyze` is the command Andrew tests with and the one that reports `(e) ABSENT` on `.demo` today | Re-run `--claim-analyze` on `.demo`: element (e) should stop being ABSENT, and `SecureChannel`/`tls_send_encrypted` should appear. Gemma arm: same command, `--model` |
| 2 | **Per-row retrieval-confidence warning** (was "cap-hit warning" — revised 08-13) | Still deterministic and threshold-free, but **must not key on cap-hit alone**: on '101 every element hit the cap and retrieval still found the crux, so a raw cap warning would flag every row of every large-index chart. Needs a relative measure — share of index matched, or whether rank scores separate | `.demo` rows flag for Claude/Gemini and not ChatGPT/Gemma, **and** '101 rows do not all flag |
| 3 | **#309 Part A — honour the `--targets` file hint** | Charts silently cite the wrong function; the workaround (class-qualify after `@`) is undocumented and easy to miss | `--targets AdaptiveTrackSelection.java@updateSelectedTrack` resolves to the adaptive-bitrate one, no ambiguity warning |
| 4 | **`--claim-schema`: exemplars by population and a rerank by shape distance** (#322 stage 1, second half; added 2026-10-19) | The schema fixes the frame but a grammar says what is allowed, not what to prefer: which form, which openers, how many dependents are still the model's draw. Deterministic exemplars from the litigated set (by class and CPC neighbourhood) and a rerank of n samples by `shapeReport` distance with anchor coverage as the hard constraint are the remaining cheap moves before any fine-tune | The claim-word ↔ anchored-identifier overlap and the in-band share on the same candidate groups, free-text vs schema vs schema+exemplars, in §6 |

**Deliberately not first:** #309 Part B (credential mask vs `vocabulary`) is the
security item but invisible in claim output, so it shows Andrew nothing while
testing; and query-word pruning stays parked until §7's threshold question is
settled — `worklist`-in-Bram is the counterexample.

## 9. HOF-c: what retrieval actually recovers (2026-08-19)

`scripts/anchor-recall.mjs` scores CE's retrieval against the anchors a
`--pseudo-claims` run already grounded. Paired runs: each claim searched twice,
once with the original wording and once ChatGPT-synonymized, **with the original
run as the mandatory control**.

| corpus | key anchors | ORIGINAL reached | SYNONYMIZED reached |
| --- | --- | --- | --- |
| sr_gh | 135 | 135 (100%) | 134 (99%) |
| CodeExam | 121 | 121 (100%) | 121 (100%) |

**Paraphrase does not degrade whole-claim retrieval.** Two corpora, a proper
control, synonymized within noise of the original on both — at 34.6% mean
per-element vocabulary survival.

### The single number is the wrong number

Scored on CE's own granularity ladder — the four ranked lists `claim-search`
already emits:

| corpus | fn | class | file | folder |
| --- | --- | --- | --- | --- |
| sr_gh (orig) | **7** | 93 | 13 | 22 |
| CodeExam (orig) | **10** | 38 | 48 | 25 |

**Function-level recall is 5–8%.** "100% reached" is overwhelmingly *found the
right class* or *found the right file*. Key anchors are METHODS
(`FSDPEngine::_build_module`); retrieval finds `FSDPEngine`. For a lead that is
useful; **for a claim chart it is not a citation**, because the limitation is
implemented by the method. Never quote the total without the breakdown.

### Anchors are not independent

sr_gh: 135 anchors across **26 distinct classes** (5.2 per class). CodeExam: 121
across **11** (11.0 per class). A `[class] X` candidate group makes its anchors
correlated by construction — claim 10 is 14 anchors that are 14 methods of
`LiberoEnv`, so one class-level hit scores 14. asus-CC measured the same shape on
Gemma3: 196 grounded anchors resolving to 70 distinct functions, ~2.8x
overstatement of evidential breadth.

### Three parser bugs, three near-misses

Every one returned a zero that would have read as a score:

1. An invented four-tier scheme that never parsed the CLASS section — scored
   sr_gh at **5%** while `FSDPEngine` sat at CLASS rank #1 with 12/12 terms.
   Caught only because 5% on the *control* was implausible.
2. `[]]` in the rewritten regex — an empty character class, matches nothing.
3. Four section formats collapsed into one pattern, silently dropping every
   FOLDER row. **The recorded 113/135 (84%) was itself understated by this**;
   `fn`/`class`/`file` were correct, folder was 0 instead of 22.

(2) and (3) were caught by the scorer's own parse-coverage assertion: a section
whose header is present but whose entry list is empty is reported as a **parser
failure**, not scored as zero. **A zero means "not found" OR "not parsed", and
nothing but an explicit check distinguishes them.**

### Bounds

Whole-claim path only — `--claim-search` does not run the per-element arm, and on
ios81 that arm was decisive both ways (claim 6: 3/8 search vs 4/8 analyze; claim
7: 2/3 vs 0/3). CodeExam carries an authorship confound; **sr_gh is the clean
datapoint.** And the key is what the drafting model cited, verified to resolve —
machine-checkable ground truth about consistency under paraphrase, not evidence
that the anchors are the *right* code for the limitation.

## 10. The loop test (pseudo-claim-loop, 2026-08-30)

The positive side of the ground-truth stack, beside the negative controls (§6's
vocabulary-pair charts) and the litigated structure tiers: a pseudo-claim
drafted FROM known anchors is charted BLIND, and the sidecar's grounded anchors
are the answer key. `scripts/pseudo-claim-loop.mjs` drives the whole recipe —
hand-picked claims → `--synonymize` (HOF-b, away from the code's vocabulary) →
`--claim-chart` per claim in both wordings, no `--targets` → optionally the
drafted dependents as a `--claim-family`, a family with ONE dependent
deterministically perturbed (`loop-score.perturbDependent`: a number bumped, a
direction swapped, a condition negated — recorded, never invented), and a
control index — then `src/core/loop-score.js` turns the verdicts sidecars into
the scorecard:

- **retrieval recall** — which drafted anchors the blind chart retrieved;
- **mechanism PRESENT, on-anchor vs elsewhere** — mechanism-class rows only
  (the classes ride in the sidecar, d4ef852); a PRESENT elsewhere may be right
  and is not the drafted truth;
- **generic rows** — reported, never scored;
- **false PRESENT on the control** — mechanism rows PRESENT where the
  mechanism is not;
- **dependent grades** — a real dependent's judged row expected PRESENT, its
  perturbed twin expected ABSENT on the same code; PRESENT on both is counted
  as *vacuous*, because that chart measured nothing.

Reference numbers a new engine should reproduce before its own are read
(claude-sonnet-4-6, artifacts in the repo root): the ATSEL positive control —
9/9 PRESENT, recall 0.75, the crux at element 5 rank 0 — and the CE_3 baseline
(claims 69/105/90 of `CE082826_SEED`): recall 1.0 / 0.75 / 0.25 original,
1.0 / 0.5 / 0.13 synonymized, PRESENT drifting off-anchor as recall falls.
`--dry-run` prints every command and runs none; swap `--llm claude` for
`--model <gguf>` and the recipe is unchanged — which is the asus-CC job:
reproduce the reference numbers on local engines, then run the loop at scale.
Temp-0 runs are not reproducible across days (measured 2026-08-27 and again
2026-08-30: two identical '101 commands, different lone PARTIALs); compare
within a run, and treat cross-day deltas below the run-to-run noise as noise.
