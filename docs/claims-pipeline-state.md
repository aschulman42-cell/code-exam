# Claims pipeline — state at a glance

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
| gate | quorum (`min_terms`) | none — ranked, top-25/element |
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

**Too-popular-to-be-informative, twice.** `--claims-loop` already demotes
**sponges** — a function topping more than `spongeT` (default 2) distinct claims'
searches, e.g. `printUsage`, `x265_param`, whose help text and parsers match
everything (`claims-loop.js:193-207`). That is the same phenomenon as `session`
flooding a candidate list, and as `argparse.js` ranking first in the CE self-test.
**The mechanism exists only in `claims-loop`** — `claim-locate`, `claim-analyze`
and `claim-chart` have no equivalent. Another instance of the #309 class, and a
tuned in-tree precedent for the "prune high-frequency terms" idea in §3/(c).

A sponge is an **overly-attractive distractor** — it absorbs searches it does not
belong to. **But high frequency is not the same as uninformative**: `worklist` is
everywhere in a Bram index *and* is the right term for a worklist claim. So any
pruning must key on "matches many DISTINCT claims/elements" (what `spongeT`
already does) rather than on raw corpus frequency, which would discard exactly the
domain terms that matter. **Unresolved; do not ship a raw-frequency cutoff.**

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
| Is Claude better than Gemma at per-element, or only asked a better question? | **Correction:** it HAS been run — `8752101_LOCATE.txt`, `8752101_LOCATE_blind.txt`. Both are **stale**: they record `2 element(s)` (pre-`e17e40d` splitter) and show the #309-A qualifier bug resolving `AdaptiveTrackSelection::updateSelectedTrack` → `DownloadHelper::…`. **Re-run on current code — Andrew TODO, needs the API key.** |
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
| 2 | **Cap-hit row warning** | Deterministic, no threshold, no tuning; CE already computes the number in `searchSymbolsByWords`'s `freq` map. Turns an invisible coin-flip into a disclosed one — same register as `⚠ UNGROUNDED` | The `Retrieval by element` table marks saturated rows. On `.demo`, Claude/Gemini rows flag, ChatGPT/Gemma rows do not |
| 3 | **#309 Part A — honour the `--targets` file hint** | Charts silently cite the wrong function; the workaround (class-qualify after `@`) is undocumented and easy to miss | `--targets AdaptiveTrackSelection.java@updateSelectedTrack` resolves to the adaptive-bitrate one, no ambiguity warning |

**Deliberately not first:** #309 Part B (credential mask vs `vocabulary`) is the
security item but invisible in claim output, so it shows Andrew nothing while
testing; and query-word pruning stays parked until §7's threshold question is
settled — `worklist`-in-Bram is the counterexample.
