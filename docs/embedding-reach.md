# Does a code-text embedding put a litigant's cited functions within reach of a claim element?

*A measurement, not a feature. Nothing in CodeExam changes on its account. Issue
[#322](https://github.com/aschulman42-cell/code-exam/issues/322) carries the history; the
question in Andrew's words (2026-10-23): "why aren't you using something like CodeBERT that
already does prose/code mapping?"*

## The question

CodeExam finds candidate code for a claim element by name: a model predicts the words an
implementer's function names would carry, and a deterministic search ranks the index's symbol
names by those words. An embedding model trained on code and its text, CodeBERT or UniXcoder,
offers the obvious alternative: embed the element, embed every symbol, take the nearest. The
assertion on #322 is that such models learned functions paired with their own docstrings, prose
that originated with the code, and that a claim limitation is a different register. This page
tests the assertion on the one answer key the project has: the functions litigants' public
claim charts cite, on the fourteen filings of
[`CODEEXAM_CLAIM_CHARTS.md`](CODEEXAM_CLAIM_CHARTS.md) section 4. A rank is agreement with a
party, never correctness; a rank within 25 says the window would have contained the name, not
that a model would then have chosen it.

## Method

- `scripts/embed-reach.py` (Python; torch and transformers; CPU or CUDA) embeds every claim
  element and every symbol of each filing's index in three representations: the name alone,
  split to words the way CodeExam splits it; the name with its signature and first twenty
  lines; the body up to the encoder's 512-token window. Models `microsoft/codebert-base` and
  `microsoft/unixcoder-base`, mean-pooled last hidden state, unit norm. Vectors go under the
  harness work directory as `.npy` files, resumable per index, with the device and wall time
  logged.
- `scripts/embed-reach-score.mjs` (Node, no model) scores them: cosine of every element
  against every symbol; for each cited name reachable in the index (the harness's reach files),
  its best rank across the claim's elements; hits within 25 (CodeExam's window), within 60 (the
  widened cap), and the median rank, per filing and pooled over every name.
- Two comparators on the same names: CodeExam's name search with the tier-1 blind runs'
  predicted words, recomputed as the harness does; and a shuffled control, each claim scored
  against another filing's elements, for the hit rate chance alone produces.
- The element boundaries are Google Patents' divisions of each claim, one segmentation per
  claim, as the harness records them.

## Results

<!-- embed-reach:begin -->
_Generated 2026-10-24T22:33:22.852Z; vectors from `scripts/embed-reach.py` on cpu; scored by `scripts/embed-reach-score.mjs` with no model call. 20 filing-repository pair(s), 70 cited names reachable in their indexes._

**Pooled over every cited name** (a name's rank is its best across the claim's elements):

| method | representation | names | within 25 | within 60 | median rank |
|---|---|---|---|---|---|
| codebert | name | 70 | 1 | 1 | 555.5 |
| codebert | sig | 44 | 0 | 4 | 262.5 |
| codebert | body | 44 | 0 | 4 | 269 |
| unixcoder | name | 70 | 6 | 14 | 298.5 |
| unixcoder | sig | 44 | 16 | 20 | 77 |
| unixcoder | body | 44 | 17 | 19 | 74 |
| CodeExam name search | predicted words | 70 | 15 | 16 | beyond the list |
| shuffled control (CodeExam name search) | another claim's predicted words | 70 | 4 | 5 | beyond the list |
| shuffled control (codebert, name) | another claim's elements | 70 | 0 | 0 | 611 |
| shuffled control (codebert, sig) | another claim's elements | 44 | 2 | 6 | 275.5 |
| shuffled control (codebert, body) | another claim's elements | 44 | 2 | 6 | 275 |
| shuffled control (unixcoder, name) | another claim's elements | 70 | 2 | 9 | 293 |
| shuffled control (unixcoder, sig) | another claim's elements | 44 | 10 | 16 | 82.5 |
| shuffled control (unixcoder, body) | another claim's elements | 44 | 11 | 18 | 84 |

**Like for like, over the 44 names whose indexes carry every representation** (veritaseum-1-3, foundry-1-11, foundry-1-14, core-scientific-1-8, core-scientific-1-10, vm-innovations-1-23, securitize-15-9, true-return-1-6):

| method | representation | names | within 25 | within 60 | median rank |
|---|---|---|---|---|---|
| codebert | name | 44 | 1 | 1 | 337 |
| codebert | sig | 44 | 0 | 4 | 262.5 |
| codebert | body | 44 | 0 | 4 | 269 |
| unixcoder | name | 44 | 5 | 10 | 204 |
| unixcoder | sig | 44 | 16 | 20 | 77 |
| unixcoder | body | 44 | 17 | 19 | 74 |
| CodeExam name search | predicted words | 44 | 10 | 10 | beyond the list |
| shuffled control (CodeExam name search) | another claim's predicted words | 44 | 4 | 4 | beyond the list |
| shuffled control (codebert, name) | another claim's elements | 44 | 0 | 0 | 370.5 |
| shuffled control (codebert, sig) | another claim's elements | 44 | 2 | 6 | 275.5 |
| shuffled control (codebert, body) | another claim's elements | 44 | 2 | 6 | 275 |
| shuffled control (unixcoder, name) | another claim's elements | 44 | 1 | 6 | 241 |
| shuffled control (unixcoder, sig) | another claim's elements | 44 | 10 | 16 | 82.5 |
| shuffled control (unixcoder, body) | another claim's elements | 44 | 11 | 18 | 84 |

**Per filing** (within 25 / within 60 / median, per method):

| filing | repository | names | codebert name | codebert sig | codebert body | unixcoder name | unixcoder sig | unixcoder body | codeexam |
|---|---|---|---|---|---|---|---|---|---|
| databricks-149-2 | apache/spark | 9 | 0 / 0 / 68499 | — | — | 0 / 0 / 50425 | — | — | 1 / 1 / beyond the list |
| veritaseum-1-3 | solana-labs/solana | 1 | 0 / 0 / 534 | — | — | 1 / 1 / 5 | — | — | 1 / 1 / 10 |
| veritaseum-1-3 | ethereum/consensus-specs | 2 | 0 / 0 / 1471.5 | 0 / 0 / 385.5 | 0 / 0 / 367 | 0 / 0 / 736 | 2 / 2 / 1.5 | 2 / 2 / 2 | 0 / 0 / beyond the list |
| foundry-1-11 | bitcoin-core/secp256k1 | 11 | 1 / 1 / 367 | 0 / 0 / 604 | 0 / 0 / 585 | 3 / 4 / 289 | 1 / 2 / 112 | 2 / 2 / 125 | 4 / 4 / beyond the list |
| foundry-1-14 | bitcoin-core/secp256k1 | 8 | 0 / 0 / 450.5 | 0 / 0 / 258 | 0 / 0 / 258 | 1 / 1 / 295 | 2 / 2 / 191.5 | 2 / 2 / 219.5 | 0 / 0 / beyond the list |
| viabtc-1-6 | bitcoin/bitcoin | 13 | 0 / 0 / 2734 | — | — | 0 / 2 / 1165 | — | — | 3 / 3 / beyond the list |
| mara-1-11 | bitcoin/bitcoin | 3 | 0 / 0 / 5259 | — | — | 0 / 1 / 117 | — | — | 0 / 1 / beyond the list |
| core-scientific-1-8 | bitcoin-core/secp256k1 | 8 | 0 / 0 / 393 | 0 / 0 / 276.5 | 0 / 0 / 275.5 | 0 / 1 / 238 | 2 / 2 / 231.5 | 2 / 2 / 249.5 | 0 / 0 / beyond the list |
| core-scientific-1-10 | bitcoin-core/secp256k1 | 6 | 0 / 0 / 205.5 | 0 / 0 / 227 | 0 / 0 / 227 | 1 / 2 / 87.5 | 2 / 4 / 46.5 | 1 / 3 / 58 | 1 / 1 / beyond the list |
| vm-innovations-1-23 | coinbase/coinbase-sdk-nodejs | 2 | 0 / 0 / 387.5 | 0 / 0 / 192.5 | 0 / 0 / 373 | 0 / 1 / 187 | 1 / 1 / 43.5 | 1 / 1 / 50.5 | 0 / 0 / beyond the list |
| vm-innovations-1-23 | circlefin/evm-cctp-contracts | 0 | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — |
| vm-innovations-1-23 | ethereum/go-ethereum | 0 | 0 / 0 / — | — | — | 0 / 0 / — | — | — | 0 / 0 / — |
| friendliai-26-1 | huggingface/text-generation-inference | 0 | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — |
| securitize-15-9 | securitize-io/dstoken | 3 | 0 / 0 / 459 | 0 / 3 / 54 | 0 / 3 / 54 | 0 / 0 / 180 | 3 / 3 / 4 | 3 / 3 / 4 | 3 / 3 / 1 |
| true-return-1-6 | makerdao/dss | 4 | 0 / 0 / 149.5 | 0 / 1 / 75.5 | 0 / 1 / 72 | 0 / 1 / 87.5 | 3 / 4 / 19 | 4 / 4 / 18.5 | 2 / 2 / beyond the list |
| sookbox-1 | xbmc/xbmc | 0 | 0 / 0 / — | — | — | 0 / 0 / — | — | — | 0 / 0 / — |
| progme-1-1 | Comcast/cmb | 0 | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — | 0 / 0 / — |
| fixture:chatgpt-external | androidx/media (ExoPlayer 3) | 14 | 0 / 0 / 30435.5 | — | — | 0 / 0 / 12451.5 | — | — | — |
| fixture:asus-reading | androidx/media (ExoPlayer 3) | 14 | 0 / 0 / 28440 | — | — | 0 / 0 / 6383.5 | — | — | — |
| fixture:union | androidx/media (ExoPlayer 3) | 20 | 0 / 0 / 28484 | — | — | 0 / 0 / 9410.5 | — | — | — |

**Runtime per index** (from the embedder's log; the device decides it):

| index | symbols | device | model | representation | seconds |
|---|---|---|---|---|---|
| bitcoin-core__secp256k1__b6c2a3c | 1076 | cpu | codebert | name | 11.5 |
| bitcoin-core__secp256k1__b6c2a3c | 1076 | cpu | codebert | sig | 439.9 |
| bitcoin-core__secp256k1__b6c2a3c | 1076 | cpu | codebert | body | 462.9 |
| bitcoin-core__secp256k1__b6c2a3c | 1076 | cpu | unixcoder | name | 12.4 |
| bitcoin-core__secp256k1__b6c2a3c | 1076 | cpu | unixcoder | sig | 380.3 |
| bitcoin-core__secp256k1__b6c2a3c | 1076 | cpu | unixcoder | body | 460.2 |
| apache__spark__af8228c | 93776 | cpu | codebert | name | 1048.5 |
| apache__spark__af8228c | 93776 | cpu | unixcoder | name | 1001.6 |
| solana-labs__solana__eaa4787 | 19573 | cpu | codebert | name | 208.6 |
| solana-labs__solana__eaa4787 | 19573 | cpu | unixcoder | name | 209.1 |
| ethereum__consensus-specs__fdb5c7d | 1501 | cpu | codebert | name | 18.2 |
| ethereum__consensus-specs__fdb5c7d | 1501 | cpu | unixcoder | name | 18.9 |
| bitcoin-core__secp256k1__ad60ef7 | 1015 | cpu | codebert | name | 15.3 |
| bitcoin-core__secp256k1__ad60ef7 | 1015 | cpu | unixcoder | name | 14 |
| bitcoin__bitcoin__b3a9b84 | 23147 | cpu | codebert | name | 265.8 |
| bitcoin__bitcoin__b3a9b84 | 23147 | cpu | unixcoder | name | 254.4 |
| bitcoin__bitcoin__8673e8f | 20541 | cpu | codebert | name | 200.6 |
| bitcoin__bitcoin__8673e8f | 20541 | cpu | unixcoder | name | 196.5 |
| bitcoin-core__secp256k1__4187a46 | 1013 | cpu | codebert | name | 15.1 |
| bitcoin-core__secp256k1__4187a46 | 1013 | cpu | unixcoder | name | 13.9 |
| coinbase__coinbase-sdk-nodejs__31b3dfe | 1065 | cpu | codebert | name | 10.6 |
| coinbase__coinbase-sdk-nodejs__31b3dfe | 1065 | cpu | unixcoder | name | 10.8 |
| circlefin__evm-cctp-contracts__4061786 | 539 | cpu | codebert | name | 8.9 |
| circlefin__evm-cctp-contracts__4061786 | 539 | cpu | unixcoder | name | 9.4 |
| ethereum__go-ethereum__341647f | 18717 | cpu | codebert | name | 155.9 |
| ethereum__go-ethereum__341647f | 18717 | cpu | unixcoder | name | 163.5 |
| huggingface__text-generation-inference__bd3a9d8 | 902 | cpu | codebert | name | 10.4 |
| huggingface__text-generation-inference__bd3a9d8 | 902 | cpu | unixcoder | name | 10.9 |
| securitize-io__dstoken__3f4074b | 992 | cpu | codebert | name | 8.6 |
| securitize-io__dstoken__3f4074b | 992 | cpu | unixcoder | name | 8.7 |
| makerdao__dss__fa4f663 | 262 | cpu | codebert | name | 2 |
| makerdao__dss__fa4f663 | 262 | cpu | unixcoder | name | 1.9 |
| xbmc__xbmc__cf5e540 | 57568 | cpu | codebert | name | 702.1 |
| xbmc__xbmc__cf5e540 | 57568 | cpu | unixcoder | name | 680.7 |
| Comcast__cmb__3dea798 | 2804 | cpu | codebert | name | 50.3 |
| Comcast__cmb__3dea798 | 2804 | cpu | unixcoder | name | 46.1 |
| ethereum__consensus-specs__fdb5c7d | 1501 | cpu | codebert | sig | 518.9 |
| ethereum__consensus-specs__fdb5c7d | 1501 | cpu | codebert | body | 607 |
| ethereum__consensus-specs__fdb5c7d | 1501 | cpu | unixcoder | sig | 360 |
| ethereum__consensus-specs__fdb5c7d | 1501 | cpu | unixcoder | body | 569.3 |
| bitcoin-core__secp256k1__ad60ef7 | 1015 | cpu | codebert | sig | 487.9 |
| bitcoin-core__secp256k1__ad60ef7 | 1015 | cpu | codebert | body | 497.3 |
| bitcoin-core__secp256k1__ad60ef7 | 1015 | cpu | unixcoder | sig | 416.7 |
| bitcoin-core__secp256k1__ad60ef7 | 1015 | cpu | unixcoder | body | 490.3 |
| bitcoin-core__secp256k1__4187a46 | 1013 | cpu | codebert | sig | 445.1 |
| bitcoin-core__secp256k1__4187a46 | 1013 | cpu | codebert | body | 463 |
| bitcoin-core__secp256k1__4187a46 | 1013 | cpu | unixcoder | sig | 403.1 |
| bitcoin-core__secp256k1__4187a46 | 1013 | cpu | unixcoder | body | 483.3 |
| coinbase__coinbase-sdk-nodejs__31b3dfe | 1065 | cpu | codebert | sig | 300.1 |
| coinbase__coinbase-sdk-nodejs__31b3dfe | 1065 | cpu | codebert | body | 456.6 |
| coinbase__coinbase-sdk-nodejs__31b3dfe | 1065 | cpu | unixcoder | sig | 246.1 |
| coinbase__coinbase-sdk-nodejs__31b3dfe | 1065 | cpu | unixcoder | body | 456.1 |
| circlefin__evm-cctp-contracts__4061786 | 539 | cpu | codebert | sig | 203.6 |
| circlefin__evm-cctp-contracts__4061786 | 539 | cpu | codebert | body | 288.3 |
| circlefin__evm-cctp-contracts__4061786 | 539 | cpu | unixcoder | sig | 127.1 |
| circlefin__evm-cctp-contracts__4061786 | 539 | cpu | unixcoder | body | 255.6 |
| huggingface__text-generation-inference__bd3a9d8 | 902 | cpu | codebert | sig | 363.7 |
| huggingface__text-generation-inference__bd3a9d8 | 902 | cpu | codebert | body | 468.3 |
| huggingface__text-generation-inference__bd3a9d8 | 902 | cpu | unixcoder | sig | 233 |
| huggingface__text-generation-inference__bd3a9d8 | 902 | cpu | unixcoder | body | 480.7 |
| securitize-io__dstoken__3f4074b | 992 | cpu | codebert | sig | 942.7 |
| securitize-io__dstoken__3f4074b | 992 | cpu | codebert | body | 697.1 |
| securitize-io__dstoken__3f4074b | 992 | cpu | unixcoder | sig | 239.5 |
| securitize-io__dstoken__3f4074b | 992 | cpu | unixcoder | body | 350.1 |
| makerdao__dss__fa4f663 | 262 | cpu | codebert | sig | 102.5 |
| makerdao__dss__fa4f663 | 262 | cpu | codebert | body | 127.3 |
| makerdao__dss__fa4f663 | 262 | cpu | unixcoder | sig | 68.7 |
| makerdao__dss__fa4f663 | 262 | cpu | unixcoder | body | 140.5 |
| Comcast__cmb__3dea798 | 2804 | cpu | codebert | sig | 880.3 |
| Comcast__cmb__3dea798 | 2804 | cpu | codebert | body | 1307.9 |
| Comcast__cmb__3dea798 | 2804 | cpu | unixcoder | sig | 673.2 |
| Comcast__cmb__3dea798 | 2804 | cpu | unixcoder | body | 1194.7 |
| AndroidX_Media_ExoPlayer3 | 65370 | cpu | codebert | name | 1015.2 |
| AndroidX_Media_ExoPlayer3 | 65370 | cpu | unixcoder | name | 1044.6 |
<!-- embed-reach:end -->

## Reading (2026-10-24, CPU; one embedding per element text and per symbol)

Over the 70 cited names reachable in the 17 filing-repository pairs, scored by name alone (the
one representation every index has): CodeExam's name search with the tier-1 blind runs'
predicted words puts 15 within 25, against 4 for the same search run with another filing's
predicted words on the same index (the shuffled control the name search owes as much as the
embeddings do); UniXcoder puts 6, against 2 for its control; CodeBERT puts 1, against 0. So
UniXcoder carries a small signal in symbol names and CodeBERT none, and the name search reaches
two and a half times as many names as the better encoder and almost four times its own control.
The control's 4 are concentrated: on Securitize's dstoken (992 symbols) the right claim's words
and the wrong claim's both reach all three cited names, so that 3 of 3 is what any claim about
token transfers finds in a small token contract, not a reading of the claim; the fourth is one
name on Foundry 1-14. Everywhere else the wrong claim's words reach nothing within 25.

Like for like, over the 44 names whose indexes carry every representation (eight filings on the
small indexes, four of them secp256k1 refs, with consensus-specs, the Coinbase SDK, dstoken and
dss; 262 to 1,501 symbols): UniXcoder's body representation reaches 17 within 25 against a
shuffled control of 11, its signatures 16 against 10, so about six names above what another
claim's text lands on in a small cryptography library; its names reach 5 against 1; CodeBERT
reaches 0 or 1 in every representation against a control of 0 to 2; CodeExam's name search
reaches 10 against a control of 4, concentrated on Foundry 1-11 (4 of 11), Securitize (3 of 3,
matched by the control), True Return (2 of 4) and Core Scientific 1-10 (1 of 6). The six names
UniXcoder's bodies add over chance and the six the name search adds are not the same names:
UniXcoder's are on secp256k1 and consensus-specs, the name search's on Foundry 1-11, True Return
and Core Scientific.

Where every method fails: Spark, 9 names in 93,776 symbols, where the embeddings rank the cited
names in the tens of thousands and the name search reaches 1. Where the name search is alone:
Securitize (3 of 3, median rank 1), True Return (2 of 4), ViaBTC (3 of 13), which the embeddings
miss at ranks in the hundreds.

What this says about the assertion on #322: on this answer key, the two encoders do not map
claim limitations to the functions a litigant cites, and the richer the representation the less
it beats chance; the small signal is in symbol names, which is the register CodeExam already
searches, with a model predicting the words. The data-poverty argument stands as the
explanation and is not tested here: fourteen pairs cannot fine-tune anything.

The '101 reachability fixture (`test/fixtures/retrieval-reachability-8752101-exoplayer3.json`:
the 20 implementer symbols an external ChatGPT chart and asus-CC's reading named in ExoPlayer 3,
65,370 symbols), scored by name against CodeExam's split of the claim: 0 of 20 within 60 for both
encoders, median ranks from 6,000 to 30,000 (2026-10-24). The fixture's own test, which runs the
full retrieval with pinned words, records a floor of 3 of the 20 reached. No signature or body
run for ExoPlayer: its source tree is not on this machine.

Not run, and not needed for the reading: signatures and bodies for Bitcoin Core (two refs),
Solana, go-ethereum, xbmc and Spark, 26 of the 70 names, a GPU job of under half an hour by the
runtime table above; on the small indexes those representations are mostly chance, and on the
large ones the names are already in the thousands.

## What this does not claim

- One sample per element text; no prompt, so no prompt variance, but one segmentation.
- No fine-tuning: fourteen pairs is the data poverty the assertion names, and training on the
  yardstick would be the example tailoring the project forbids.
- Agreement with a party's cited names, not correctness; a litigant's chart is advocacy.
- Indexes whose source tree is not on the machine are embedded by name only, and the runtime
  table says so.
