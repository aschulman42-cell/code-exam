# Claims pipeline — state at a glance

**Current state only.** No history, no reasoning — those live in issues and commit
messages. Tables, not prose.

> **Maintenance rule:** every change to claim behaviour updates this file **in the
> same commit**. A state doc that lags is worse than none, because it is believed.
> New measurements append a ledger row. Answered questions are deleted from
> §7, not annotated — the answer belongs in §6.

Last updated: 2026-08-12.

---

## 1. Commands

| command | retrieval | matches | analysed unit | status |
|---|---|---|---|---|
| `--multisect` | whole-claim terms | **file bodies** | — | base search; IDF ranking in `commands/`, not `core/` |
| `--claim-search` | whole-claim | **file bodies** | — | same quorum problem as `--claim-analyze` |
| `--claim-analyze` | whole-claim, quorum | **file bodies** | top-N (default 6) | **cannot reach single-limitation implementers** — §2 |
| `--claims-loop` | whole-claim + **sponge suppression** | **file bodies** | per claim | **not a claim-charting command** — the #290 self-test harness, §4. `minTermsFrac 0.75` counts dead terms → 0/8 agreement (#306) |
| `--claim-locate` | **per-element**, no quorum | **symbol names** | — | works; run-to-run variance §6 |
| `--claim-chart` | `--targets` given → none; else **per-element** | **symbol names** | per target × all elements | rows from `splitClaimElements`; per-element path added `e17e40d` |

**Not obvious and load-bearing:** `--claim-chart` changes retrieval depending on
whether `--targets` was supplied.

## 2. Retrieval mechanisms

**Two different searches. They are complementary, not ranked.**

| | whole-claim (`multisect`) | per-element (`claim-locate`) |
|---|---|---|
| unit | whole claim, one shot | one search per limitation |
| model emits | regex search **terms** | code **words** per element |
| searched against | file **body text** | symbol **names** only |
| gate | quorum (`min_terms`) | none — ranked, top-25/element |
| blind spot | well-named single-purpose functions | badly-named functions (`process()`, `doWork()`) |

**The quorum arithmetic.** A function implementing 1 of N limitations holds
roughly 1/N of the claim's vocabulary. Measured on `.demo`:
`SecureChannel::sendMessage` scored **2/12** terms against a quorum of 6. Adding
the missing term takes it to 3/12. **No term-set fix reaches it** — the whole-claim
quorum structurally excludes single-limitation implementers, and selects instead
for long orchestrators that name-drop everything (the two functions analysed were
the two longest, 87 and 103 lines).

**The candidate cap.** `searchSymbolsByWords` returns top-25 per element. An
element whose search **hits 25 has not discriminated** — ranking among 25
undifferentiated candidates is arbitrary, and which 3 reach the chart is luck.
One high-frequency word saturates it alone: `session` matches 22 of 154 symbols
(14%) in `.demo`. **Cap-hit is a per-row reliability predictor, confirmed on four
engines with no exceptions** (§6): the engines whose element-10 search hit the cap
are exactly the engines that lost element (e).

**Too-popular-to-be-informative, twice.** `--claims-loop` already demotes
**sponges** — a function topping more than `spongeT` (default 2) distinct claims'
searches, e.g. `printUsage`, `x265_param`, whose help text and parsers match
everything (`claims-loop.js:193-207`). That is the same phenomenon as `session`
flooding a candidate list, and as `argparse.js` ranking first in the CE self-test.
**The mechanism exists only in `claims-loop`** — `claim-locate`, `claim-analyze`
and `claim-chart` have no equivalent. Another instance of the #309 class, and a
tuned in-tree precedent for the "prune high-frequency terms" idea in §3/(c).

## 3. Roadmap — Andrew's (a)–(h), with state

| # | item | state | note |
|---|---|---|---|
| **(0)** | **end-to-end harness for the per-element pipeline** | **missing — added** | `claim-selftest.mjs` scores whole-claim retrieval only. Four retrieval intuitions were wrong when measured this week (concept bridge, stemmer, IDF, stub verification). (a)–(d) are all retrieval changes; without a harness the guess-and-measure cycle repeats by hand. **§4 (HOF) is the general form of this** — same need, arbitrary corpus instead of one hand-built answer key. |
| (a) | search by element, not whole claim | **partly done** | `claim-locate` always did; `claim-chart` since `e17e40d`. `--claim-analyze`/`--claim-search`/`--claims-loop` still whole-claim. **"In addition to", not "instead of"** — §2 blind spots are complementary. |
| (b) | finer splitting than `;` | **partly done** | `e17e40d`: '101 6→10 rows; TLS demo 22 shattered fragments → 11 clean. `--elements @file.txt` is the escape hatch. **Andrew's own writing on limitation-splitting is the input to mine for deterministic rules** — highest-leverage remaining input, and gates everything downstream. |
| (c) | multiple runs, majority vote | **design corrected; now CLOUD-ONLY** | **Union for TARGETS, majority for VERDICTS.** Element (e)'s implementers were individually 3/5, 2/5, 1/5 — a majority rule on targets discards two correct implementers. Union what you look at; vote on what you conclude. **Cloud-only, settled 08-12**: two local models are bit-stable across runs, so the local path never needs multi-run. |
| (d) | local model generates (c) | **not started** | Different builds already behave differently: QAT Q4_0 fails the `parseElementWords` format contract (0/7 parsed) where Q4_K_M passes (11/11). Andrew's "different models for different pipeline stages" is plausible — vocabulary step is one ~600-token call, analysis is large — but unmeasured. **The vocabulary step works on 1 of 3 local builds** (§6), so *model admission* is a gate, not a nicety. |
| (e) | review existing code + output | **this document** | |
| (f) | fold `--claim-chart` into `--claim-analyze` | **not started** | Blocked on (a): merging them while they use different retrieval would freeze the wrong one. |
| (g) | single end-to-end pipeline; retire test-only commands | **not started** | Do before (h). |
| (h) | GUI | **not started** | Last. Do not build onto a pipeline about to be replaced. |

## 4. Huffing our own fumes (HOF) — the self-test sub-pipeline

**Longer-term; recorded here because it is the general form of (0) and answers an
open question nothing else does.** Not on the worklist yet.

The problem it solves: every ground-truth corpus we have is compromised.
`ce_anchors.lst` is hand-written and small; `.demo` was authored with its own
claim, so claim and code share vocabulary; '101 is real but has no answer key.
HOF **manufactures** ground truth for an arbitrary CE index.

| step | what | status |
|---|---|---|
| HOF-a | generate pseudo-claims **with attached code references** for any index | partial — `--claims-loop` is the harness half; generation is by hand today |
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

**The loop is currently one pass that emits a redraft signal, not an automated
loop to convergence.** Andrew's original intent — iterate until pseudo-claims and
their code references converge — is the unbuilt half, and is what would drive
HOF-a.

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
| element splitting | '101 / TLS demo | deterministic | 1 | 08-11 | 6→10 rows; 22 shattered → 11 clean |
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
| `--claim-locate` variance | `.demo` | gemma Q4_K_M/per-element | 5 | 08-12 | **0/5 lost; 0.0 pairwise diff; core 100%** — byte-identical |
| `--claim-locate` variance | `.demo` | qwen3-14B Q4_K_M | 5 | 08-12 | 4 of 4 byte-identical to run 1 — **determinism is greedy decoding, not one model** |
| element-10 words | `.demo` | gemma Q4_K_M | 5 | 08-12 | `[data, encrypt, channel]` → 11 candidates, identical ×5. Picked `channel` (7%) not `session` (14%); 3 words, fewest of any engine |
| vocabulary step, local builds | `.demo` | 3 builds | 1 | 08-12 | gemma Q4_K_M **works** 11/11; gemma qat-Q4_0 **0/7** (words good, no numbering, F75); qwen3-14B **empty reply**. Qwen prompt-fit untuned — not a capability verdict |

**Corpus caveat.** `.demo` / `.demo_code_only` is contrived — Claude wrote the code
and the claim around each other. It flatters the tool three ways: vocabulary
alignment, ideal naming (helps name-search specifically), and having an answer key
at all. **No `.demo` result transfers to '101 without re-measurement.**

## 7. Open questions

| question | what would answer it |
|---|---|
| Does per-element retrieval survive a corpus where claim and code share no vocabulary? | '101 × ExoPlayer3 per-element with a translating engine — or **HOF-b (§4), which manufactures the gap on any index**. **The only question that decides the customer case.** |
| Is Claude better than Gemma at per-element, or only asked a better question? | Claude on `--claim-locate` for '101 — never run. Cloud-vs-local comparisons so far compared *methods*, not models. |
| Right threshold for pruning high-frequency query words? | `session` 14% floods; `channel` 7% is the word that finds `sendMessage`. One corpus cannot set it. |
| Do the '101 and CE-self-test findings hold at n>1? | Every row above marked `n=1`. |
| Is the Qwen empty reply capability or prompt-fit? | `buildDiscoverPrompt` was iterated against Gemma. One re-prompt experiment before concluding anything about Qwen. |
| Should a model-admission gate run the vocabulary step? | 1 of 3 local builds passes it, and the M7 gate does not catch any of the three failures. One model call on `.demo`, require ≥1 parsed element. |
