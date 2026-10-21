# Real-world claim charts: litigated claims paired with the code a party charted

> **Working catalog.** This page records a search of public court filings for claim charts that cite
> source code, ideally open-source code, so that a litigated claim can be paired with the code a
> party said it reads on. It complements the self-test described on the
> [ground-truth page](litigated-claims-ground-truth.md): that test manufactures claim-to-code pairs
> from a codebase, and is only a floor; these pairs are real, and they are advocacy.

## Why

Every claim-to-code answer key CodeExam has is compromised in some way. The self-test ("huffing
our own fumes") drafts a pseudo-claim *from* known code and asks the pipeline to find that code
again; if it cannot, nothing downstream can be trusted on a real claim, but passing it proves only
a floor. A litigated claim that a party has charted against identifiable source code is the real
thing: a claim written by an attorney for a dispute, and a code reference someone was prepared to
file. Where the accused product is open source, the pair can be tested on an index anyone can
build.

**What such a pair is, and is not.** A party's chart is a contention. A "match" between CodeExam's
chart and the party's is agreement with that party, not correctness; the other side's chart,
where it exists, disagrees by design. The catalog records who filed each chart.

## Where public code citations live

Code-level charts are served under protective orders and rarely filed, so most public charts rest
on product documentation. In the Intellectual Ventures cases on hand (the '584 patent charted
against Kubernetes in three cases; the '582 patent charted against Hadoop and Apache Spark as
used by an airline), every chart cites documentation pages and job postings, and none cites a
source file. Function-level citations surface in a few places:

- complaints and contentions where the accused product is itself open source (smart contracts and
  crypto protocols, AI inference servers, container tooling);
- the contentions fight: motions to strike infringement contentions quote the contentions they
  attack, and oppositions quote the code;
- claim-construction briefs and redacted expert declarations that walk through a function;
- opinions on summary judgment that quote a file;
- a party's own source filed as an exhibit, as proof of conception in an inventorship fight
  (BearBox v. Lancium's exhibits are code listings with no repository link): a patent paired with
  code its side wrote, not code it accuses, which the listing marks by the absence of a link.

## The search

CourtListener's RECAP archive answers full-text queries over filed documents with no account, and
the documents it holds download free. `scripts/recap-claim-chart-search.mjs` runs a fixed list of
query shapes against it, downloads every document a hit names, extracts the text with
`pdftotext` (Git for Windows bundles it; elsewhere install poppler), and records every repository
citation with its **granularity**:

| granularity | example |
|---|---|
| line | `…/blob/<ref>/src/x.go#L12-L30` |
| function | a file link with a function named beside it: `UniswapV2Pair.sol (function "mint")` |
| file | `…/blob/master/contracts/UniswapV2Pair.sol` |
| document | a markdown or wiki file in a repository: `bips/blob/master/bip-0137.mediawiki` |
| directory | `…/tree/main/router` |
| repo | `github.com/<org>/<repo>`, or a README anchor |
| none | no repository link; the document's cited domains say what it rests on |

Beside each citation: the nearest patent number and claim number in the text, and the document's
non-repository domains, so a chart built on `kubernetes.io` is kept and marked as a documentation
chart rather than dropped.

A second pass reads what a filing quotes **by name, with no link at all**: a call written as code
(`secp256k1_ecdsa_sign_inner()`, `VerifyProfile()` at the end of a C comment, a Spark line pasted
into a summary-judgment exhibit) and a source-file name outside any URL (`main_impl.h`). A name
counts when it is shaped like code: an underscore, a dotted path, an inner capital, or any plain
word followed directly by empty parentheses; `Patent(s)`, `RaDaR(R)` and a garbled page's `A9(`
do not. Each name is then tied to the claim language it was cited for, by the document's shape.
A **claim chart** is read page by page: `pdftotext -layout` keeps a page's two columns at a
stable character offset, so the claim column is the slice left of the page's dominant gap, a row
opens at a label at the start of that column (`1[b]`, `1(c)`, `[1a]`, `1[pre]`, `Element 1`,
`1.1`, `Claim 16`) and runs to the next label across page breaks, every occurrence of a name
lands in the row whose lines hold it, and the row's limitation is its claim-column text, or the
text a claim-text page gave its label where the exhibit opens with one (R2 v. Databricks does),
or, failing both, the head of its evidence. A **narrative complaint** has numbered paragraphs
and no labels (VideoLabs v. Meta names `ctxIdxBlockCatOffset(ctxBlockCat)` in paragraph 205 in
the pleader's own sentence), so there the unit is the paragraph, with the nearest claim number
and the claim language it quotes, a weaker association than a row's. A **listing** or report
gets neither.

The chart's claim column is the litigant's quotation of the claim read out of a layout, and it
carries what the layout leaves in it: a page-header fragment, a stray column heading, a lost
claim number. The patent has the text, so where the catalog knows the patent the limitation
comes from there: `--fetch-claims` caches every cited patent's claims from Google Patents
(through `litigated-claims-fetch.mjs`, which already fetched the litigated corpus), a row
labelled `N[x]` takes claim N, and its limitation is the span of that claim that best covers the
row's own words, with the chart's text kept beside it and the share of its words found in the
span recorded as the row's agreement. Position is never used, because the sources split a claim
differently: claim 1 of US 8,190,610 is 4 lines on Google Patents, 5 rows in the Databricks
chart and 7 elements from CodeExam's heuristic splitter. A row with no claim text of its own
takes the whole claim; a paragraph takes the whole claim its number names; a document whose
patent never resolves uses a claim it reproduces itself, where it does. A patent number followed
by a footnote digit (`8,666,0621`, Malikie v. Foundry) is read as the number, and an exhibit
that names its patent only as the '062 Patent takes the full number from its docket's complaint.
A paragraph's quotation is kept only when it reads like a claim and not like code, since a
complaint quotes code lines, definitions and titles more often than claims.

On the 2026-10-20 run, 47 of the 49 documents that name three or more functions get an
association this way, 28 by chart rows and 19 by paragraphs, where 19 did by a row label at a
line start alone; the listing marks each limitation's source. With the claims of the 234 patents
the catalog names fetched on 2026-10-21 (233 pages carried claims), 39 of the 49 take their
claim text from the patent and one from a claim it reproduces: of their 84 chart rows, 54 carry
the aligned span (median agreement 1.00, 46 at 0.9 or above), 7 the whole claim, and 23 keep the
chart's own text, 14 of them because the alignment fell below 0.6 on a garbled or header-filled
column and 9 because no claim of the patent matched the label; 64 of their 149 paragraphs carry
their claim's text, and 4 quotations survive the claim-shape test where 94 were shown before. The
patent beside a name is the nearest
mention; when a pasted listing sits pages from any, the document's most-cited patent number stands
in, and the listing shows every patent the document cites with its count. A grep of the first
run's texts for empty parentheses is what showed the link pass missing these. The catalog block
below counts the functions per document and lists the documents that quote code but carry no
file-level link; the full listing, document by document and row by row, is written to a file of
its own with `--cites`.

```
node scripts/recap-claim-chart-search.mjs --out <dir outside the repo> [--shapes a,b] [--max-dockets N]
node scripts/recap-claim-chart-search.mjs --out <dir> --rescore            # the text passes again after a rule change, no network
node scripts/recap-claim-chart-search.mjs --out <dir> --render docs/real-world-claim-charts.md
node scripts/recap-claim-chart-search.mjs --out <dir> --cites <file.md>    # the code each document quotes, by chart row
node scripts/recap-claim-chart-search.mjs --out <dir> --fetch-claims      # every cited patent's claims from Google Patents, then --rescore
```

The run is resumable (a document already catalogued is not fetched again), polite (one request a
second, backoff on rate limits), and keeps the downloaded PDFs and the JSONL catalog **outside the
repository**, in the `--out` directory; downloaded files are untrusted input and nothing is run
from there. Only patent suits (nature of suit 830) are kept unless `--all-suits`. The query shapes
are in the script (`QUERY_SHAPES`). Sized on 2026-10-20: "claim chart" with a GitHub link, 89
hits; a file-level GitHub link in a patent-infringement filing, 188; "infringement contentions"
with a file-level link, 23; "source code" with "claim chart" and GitHub, 49; a motion to strike
contentions with GitHub, 104; a declaration with a file-level link, 164; the opinions shape, 0 in
either ordering (kept in the script for a later archive, not claimed). The full run over the six
filing shapes the same day read every hit: 279 hits were patent suits and 289 were not, giving
161 dockets, 274 documents and 1.6 GB of PDFs, filed 2010 to 2026, with no download failures.

## The catalog

<!-- catalog:start -->
_Generated 2026-10-21 by `scripts/recap-claim-chart-search.mjs --render` from 274 document(s); edit the script, not this block._

| best citation in the document | documents |
|---|---:|
| line | 5 |
| function | 10 |
| file | 27 |
| document | 56 |
| directory | 27 |
| repo | 45 |
| none | 104 |

**Code quoted by name** (at least 3 distinct functions written as code, link or no link): 49 document(s), 33 without a file-level link, 39 with the claim text of their rows taken from the patent.

**File-level or finer (42)**

| case | court | docket | document | filed | best | repository | function | patent | claim | code | PDF |
|---|---|---|---|---|---|---|---|---|---|---:|---|
| FriendliAI Inc. v. Hugging Face, Inc. | ded | 1:23-cv-00816 | 27-1 | 2023-07-28 | line | huggingface/text-generation-inference router/src/server.rs |  | 11,442,775 |  | 3 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.83165/gov.uscourts.ded.83165.27.1.pdf) |
| FriendliAI Inc. v. Hugging Face, Inc. | ded | 1:23-cv-00816 | 26-1 | 2023-07-28 | line | huggingface/text-generation-inference router/src/server.rs |  | 11,442,775 |  | 3 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.83165/gov.uscourts.ded.83165.26.1.pdf) |
| FriendliAI Inc. v. Hugging Face, Inc. | ded | 1:23-cv-00816 | 1-1 | 2023-07-28 | line | huggingface/text-generation-inference router/src/server.rs |  | 11,442,775 |  | 2 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.83165/gov.uscourts.ded.83165.1.1.pdf) |
| Veritaseum Capital, LLC v. Coinbase Global, Inc. | ded | 1:22-cv-01253 | 1-3 | 2022-09-22 | line | solana-labs/solana validator/src/main.rs |  |  |  | 25 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.80126/gov.uscourts.ded.80126.1.3_2.pdf) |
| Data Scape Limited v. iHEARTMEDIA, INC. | txwd | 6:19-cv-00483 | 1 | 2019-08-22 | line | realm/realm-core src/realm/table.cpp | value.size | '751 |  | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1052980/gov.uscourts.txwd.1052980.1.0.pdf) |
| VM Innovations I, LLC v. Coinbase Global, Inc. | txnd | 7:26-cv-00051 | 1-23 | 2026-05-07 | function | ethereum/go-ethereum eth/protocols/eth/broadcast.go | wait |  |  | 6 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txnd.419280/gov.uscourts.txnd.419280.1.23.pdf) |
| VM Innovations I, LLC v. Coinbase Global, Inc. | txnd | 7:26-cv-00051 | 1-29 | 2026-05-07 | function | ethereum-optimism/optimism op-batcher/batcher/channel_manager.go | processBlocks |  |  | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txnd.419280/gov.uscourts.txnd.419280.1.29.pdf) |
| Malikie Innovations Ltd. v. Foundry Digital LLC | txwd | 7:25-cv-00567 | 1-14 | 2025-12-12 | function | bitcoin-core/secp256k1 src/ecdsa_impl.h | secp256k1_ge_set_gej |  | 1 | 8 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172879815/gov.uscourts.txwd.1172879815.1.14.pdf) |
| Malikie Innovations Ltd. v. Foundry Digital LLC | txwd | 7:25-cv-00567 | 1-11 | 2025-12-12 | function | bitcoin-core/secp256k1 src/secp256k1.c | secp256k1_ecdsa_sig_sign |  | 1 | 12 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172879815/gov.uscourts.txwd.1172879815.1.11.pdf) |
| Malikie Innovations Ltd. v. Foundry Digital LLC | txwd | 7:25-cv-00567 | 1-12 | 2025-12-12 | function | bitcoin-core/secp256k1 src/secp256k1.c | secp256k1_ecdsa_sig_sign |  | 1 | 12 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172879815/gov.uscourts.txwd.1172879815.1.12.pdf) |
| Bprotocol Foundation v. Universal Navigation In… | nysd | 1:25-cv-04214 | 1 | 2025-05-20 | function | Uniswap/v2-periphery contracts/UniswapV2Router02.sol | addLiquidity | '049 | 1 | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.nysd.642852/gov.uscourts.nysd.642852.1.0.pdf) |
| Bprotocol Foundation v. Universal Navigation In… | nysd | 1:25-cv-04214 | 47 | 2025-05-20 | function | Uniswap/v2-periphery contracts/UniswapV2Router02.sol | addLiquidity | '049 |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.nysd.642852/gov.uscourts.nysd.642852.47.0.pdf) |
| Immersion Corporation v. Valve Corporation | wawd | 2:23-cv-00712 | 1 | 2023-05-15 | function | ValveSoftware/Moondust Assets/Scripts/MoonRock.cs | Update | '546 | 5 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.wawd.322185/gov.uscourts.wawd.322185.1.0.pdf) |
| True Return Systems, LLC v. MakerDAO | nysd | 1:22-cv-08478 | 1-6 | 2022-10-05 | function | makerdao/dss src/pot.sol | drip |  |  | 17 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.nysd.587363/gov.uscourts.nysd.587363.1.6.pdf) |
| PROGME CORPORATION v. COMCAST CABLE COMMUNICATI… | paed | 2:17-cv-01488 | 1-1 | 2017-03-29 | function | Comcast/cmb config/WEB-INF-CQS/web.xml | print | '425 |  | 127 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.paed.528848.1.1.pdf) |
| Malikie Innovations Ltd. v. Foris DAX, Inc. d/b… | txed | 2:26-cv-00864 | 1-5 | 2026-09-22 | file | ethereum/go-ethereum crypto/secp256k1/libsecp256k1/include/secp256k1_recovery.h |  |  |  | 12 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.249528/gov.uscourts.txed.249528.1.5.pdf) |
| Malikie Innovations Ltd. v. ViaBTC Technology L… | txwd | 7:26-cv-00372 | 1-7 | 2026-09-09 | file | viabtc/viawallet_core trezor-crypto/crypto/ecdsa.c |  |  |  | 12 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172932894/gov.uscourts.txwd.1172932894.1.7.pdf) |
| Sandpiper CDN, LLC v. Cox Communications, Inc. | gand | 1:26-cv-03893 | 1 | 2026-07-11 | file | apache/trafficserver configs/remap.config.default |  | '347 |  | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.gand.362200/gov.uscourts.gand.362200.1.0.pdf) |
| VM Innovations I, LLC v. Coinbase Global, Inc. | txnd | 7:26-cv-00051 | 1 | 2026-05-07 | file | coinbase/coinbase-sdk-nodejs quickstart-template/bridge-usdc.js |  | '772 |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txnd.419280/gov.uscourts.txnd.419280.1.0.pdf) |
| VM Innovations I, LLC v. Coinbase Global, Inc. | txnd | 7:26-cv-00051 | 1-27 | 2026-05-07 | file | coinbase/coinbase-sdk-nodejs quickstart-template/bridge-usdc.js |  |  |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txnd.419280/gov.uscourts.txnd.419280.1.27.pdf) |
| ALDI Inc. v. Intellectual Ventures I LLC | ded | 1:26-cv-00461 | 12-12 | 2026-04-21 | file | moby/swarmkit manager/dispatcher/dispatcher.go |  | 9,948,712 | 16 | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.92906/gov.uscourts.ded.92906.12.12.pdf) |
| Valtrus Innovations Ltd. v. Google LLC | cand | 5:26-cv-02379 | 1-7 | 2026-03-18 | file | torvalds/linux drivers/cpufreq/intel_pstate.c |  | '809 |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cand.466146/gov.uscourts.cand.466146.1.7.pdf) |
| Intellectual Ventures I LLC v. Southwest Airlin… | txnd | 3:25-cv-02885 | 97-15 | 2025-10-24 | file | moby/moby daemon/graphdriver/overlay2/overlay.go |  | 7,721,282 | 1 | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txnd.410877/gov.uscourts.txnd.410877.97.15.pdf) |
| ThroughPuter, Inc. v. Google LLC | txwd | 1:25-cv-01625 | 1-26 | 2025-10-07 | file | ARM-software/data pmu/neoverse_n1.json |  |  |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172868158/gov.uscourts.txwd.1172868158.1.26.pdf) |
| ADVANCED CODING TECHNOLOGIES LLC v. APPLE INC. | txwd | 7:25-cv-00446 | 1 | 2025-10-01 | file | ultrawide/libaom av1/encoder/encodemv.h |  |  |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172867354/gov.uscourts.txwd.1172867354.1.0.pdf) |
| Intellectual Ventures I LLC v. American Airline… | txed | 4:25-cv-00576 | 1-12 | 2025-05-30 | file | moby/moby daemon/graphdriver/overlay2/overlay.go |  | 7,721,282 | 1 | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.238256/gov.uscourts.txed.238256.1.12.pdf) |
| Onesta IP, LLC v. Qualcomm Inc. | txwd | 1:25-cv-00587 | 1 | 2025-04-17 | file | crdroidandroid/android_device_oneplus_sm8550-common init/init.kernel.post_boot-kalama.sh |  | '943 |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172835621/gov.uscourts.txwd.1172835621.1.0.pdf) |
| Intellectual Ventures I LLC v. American Airline… | txed | 4:24-cv-00980 | 176-11 | 2024-11-02 | file | moby/moby daemon/graphdriver/zfs/zfs.go |  | 7,721,282 | 1 | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.233874/gov.uscourts.txed.233874.176.11.pdf) |
| Intellectual Ventures I LLC v. American Airline… | txed | 4:24-cv-00980 | 84-26 | 2024-11-02 | file | moby/moby daemon/graphdriver/overlay2/overlay.go |  | 7,721,282 | 1 | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.233874/gov.uscourts.txed.233874.84.26.pdf) |
| Intellectual Ventures I LLC v. Southwest Airlin… | txwd | 7:24-cv-00277 | 56-24 | 2024-11-02 | file | moby/moby daemon/graphdriver/overlay2/overlay.go |  | 7,721,282 | 1 | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172811441/gov.uscourts.txwd.1172811441.56.24.pdf) |
| TS-Optics Corporation v. Microsoft Corporation | cacd | 8:24-cv-01974 | 14-4 | 2024-09-12 | file | microsoft/xbox-game-streaming-tools touch-adaptation-kit/samples/sample-layouts/layouts/neutral/dri… |  | '709 |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cacd.940762/gov.uscourts.cacd.940762.14.4.pdf) |
| R2 Solutions LLC v. Databricks, Inc. | txed | 4:23-cv-01147 | 149-2 | 2023-12-28 | file | apache/spark core/src/main/scala/org/apache/spark/rdd/PairRDDFunctions.scala |  | 8,190,610 | 1 | 64 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.226994/gov.uscourts.txed.226994.149.2.pdf) |
| IOT INNOVATIONS LLC v. SimpliSafe, Inc. | mad | 1:23-cv-10520 | 1-15 | 2023-03-09 | file | tenable/poc SimpliSafe/spi_decoder.py |  |  |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.mad.254413/gov.uscourts.mad.254413.1.15.pdf) |
| Sucxess LLC v. Comma.ai, Inc. | ded | 1:22-cv-01105 | 8 | 2022-08-23 | file | commaai/panda board/boards/uno.h |  |  | 1 | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.79817/gov.uscourts.ded.79817.8.0.pdf) |
| M-Red Inc. v. Biostar Microtech Int'l Corp. | txed | 2:21-cv-00354 | 1 | 2021-09-10 | file | torvalds/linux drivers/cpufreq/brcmstb-avs-cpufreq.com |  | 6,737,995 |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.209453/gov.uscourts.txed.209453.1.0.pdf) |
| M-Red Inc. v. Nintendo Co., Ltd. | txed | 2:21-cv-00076 | 1 | 2021-03-05 | file | torvalds/linux drivers/cpufreq/brcmstb-avs-cpufreq.c |  |  |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.204537/gov.uscourts.txed.204537.1.0.pdf) |
| Streamscale, Inc. v. Cloudera, Inc. | txwd | 6:21-cv-00198 | 67 | 2021-03-02 | file | intel/isa-l erasure_code/ec_highlevel_func.c |  |  |  | 3 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1124935/gov.uscourts.txwd.1124935.67.0.pdf) |
| Masimo Corporation v. True Wearables, Inc. | cacd | 8:18-cv-02001 | 373 | 2018-11-08 | file | GRousselet/matlab_stats tm.m |  | 5,400,267 |  | 3 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cacd.728271/gov.uscourts.cacd.728271.373.0.pdf) |
| Pacific Biosciences of California, Inc. v. Oxfo… | ded | 1:17-cv-01353 | 546-1 | 2017-09-25 | file | nanoporetech/kmer_models r9.4_180mv_6mer/template_median68pA.model |  | 9,738,929 |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.63273/gov.uscourts.ded.63273.546.1.pdf) |
| Contour IP Holding, LLC v. GoPro, Inc. | cand | 3:17-cv-04738 | 913-2 | 2017-08-16 | file | mirror/rtmpdump librtmp/rtmp.c |  |  |  | 0 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cand.315850/gov.uscourts.cand.315850.913.2.pdf) |
| PROGME CORPORATION v. COMCAST CABLE COMMUNICATI… | paed | 2:17-cv-01488 | 1-13 | 2017-03-29 | file | Comcast/cmb config/WEB-INF-CNS/web.xml |  |  |  | 54 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.paed.528848.1.13.pdf) |
| PROGME CORPORATION v. COMCAST CABLE COMMUNICATI… | paed | 2:17-cv-01488 | 1-41 | 2017-03-29 | file | Comcast/cmb config/WEB-INF-CNS/web.xml |  |  |  | 56 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.paed.528848/gov.uscourts.paed.528848.1.41.pdf) |

**Code quoted without a file link (33)**: the link pass put these at repository, directory, document or no link, but the text names functions and source files as code (`layout`: chart, narrative, listing or other; `code` counts distinct functions; the first three names are shown).

| case | court | docket | document | filed | link | layout | code | functions | source files | patent | claim | PDF |
|---|---|---|---|---|---|---|---:|---|---|---|---|---|
| BearBox LLC v. Lancium LLC | ded | 1:21-cv-00534 | 189 | 2021-04-14 | none | narrative | 85 | `client.write_coil`, `get_BTC_price`, `get_network_hashrate` | `miner.php`, `myminer.php`, `cgminer_sqlite_test.py` |  | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.75178/gov.uscourts.ded.75178.189.0.pdf) |
| Oracle America, Inc. v. Google Inc. | cand | 3:10-cv-03561 | 1570-4 | 2010-08-12 | repo | narrative | 38 | `str_replace`, `array`, `character` | `simpledomparser.php` |  |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cand.231846/gov.uscourts.cand.231846.1570.4_1.pdf) |
| Oracle America, Inc. v. Google Inc. | cand | 3:10-cv-03561 | 1465-5 | 2010-08-12 | repo | narrative | 36 | `str_replace`, `array`, `character` | `simpledomparser.php` |  |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cand.231846/gov.uscourts.cand.231846.1465.5.pdf) |
| ESW Holdings, Inc. v. Roku, Inc. | txwd | 6:19-cv-00044 | 1-2 | 2019-02-08 | document | listing | 22 | `getAds`, `setAdUrl`, `showAds` |  | 8,682,945 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1003897/gov.uscourts.txwd.1003897.1.2.pdf) |
| BearBox LLC v. Lancium LLC | cafc | 23-1922 | 39-6 | 2023-05-22 | none | chart | 16 | `main`, `RawProxy`, `exelon4_modeling_05092019` | `LMP_csv_import.py`, `denis_logic.py`, `arb_main_AEC.py` | 10,608,433 |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cafc.20249/gov.uscourts.cafc.20249.39.6.pdf) |
| BearBox LLC v. Lancium LLC | cafc | 23-1922 | 32-6 | 2023-05-22 | none | chart | 16 | `main`, `RawProxy`, `exelon4_modeling_05092019` | `LMP_csv_import.py`, `denis_logic.py`, `arb_main_AEC.py` | 10,608,433 |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cafc.20249/gov.uscourts.cafc.20249.32.6.pdf) |
| Pavemetrics Systems, Inc. v. Tetra Tech, Inc. | cacd | 2:21-cv-01289 | 185-7 | 2021-02-11 | directory | other | 16 | `np.array`, `np.exp`, `log_loss` |  |  |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cacd.810363/gov.uscourts.cacd.810363.185.7.pdf) |
| Golden v. Google LLC | cafc | 24-2024 | 23-1 | 2024-07-01 | none | chart | 15 | `eJaotmoi.edvAdei`, `nccyi.rp`, `AmH` | `schemati.c`, `rCmv1DLT1nsaunsMud.h`, `wcbriayetlischtou.h` | 9,589,439 |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cafc.21873/gov.uscourts.cafc.21873.23.1.pdf) |
| Malikie Innovations Ltd. v. ViaBTC Technology L… | txwd | 7:26-cv-00372 | 1-6 | 2026-09-09 | document | chart | 14 | `SECP256K1_ARG_NONNULL`, `secp256k1_scalar_mul`, `secp256k1_ecdsa_recoverable_signature_load` | `secp256k1_recovery.h` | 8,788,827 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172932894/gov.uscourts.txwd.1172932894.1.6.pdf) |
| Malikie Innovations Ltd. v. Antpool Technologie… | txwd | 7:26-cv-00371 | 1-5 | 2026-09-09 | document | chart | 14 | `SECP256K1_ARG_NONNULL`, `secp256k1_scalar_mul`, `secp256k1_ecdsa_recoverable_signature_load` | `secp256k1_recovery.h` | 8,788,827 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172932738/gov.uscourts.txwd.1172932738.1.5.pdf) |
| TwinStrand Biosciences, Inc. v. Guardant Health… | ded | 1:21-cv-01126 | 30 | 2021-08-03 | repo | chart | 14 | `lNocaumsplAif`, `mCaasnscievrel`, `fMoredge` | `ConsensusMaker.py`, `DuplexMaker.py`, `tag_to_header.py` | 10,801,063 | 135 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.76216/gov.uscourts.ded.76216.30.0_1.pdf) |
| Malikie Innovations Ltd. v. MARA Holdings, Inc.… | txwd | 7:25-cv-00222 | 1-11 | 2025-05-12 | document | chart | 13 | `secp256k1_ec_seckey_verify`, `CKey::Check`, `GetStrongRandBytes` | `key.cpp` | 7,372,961 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172841950/gov.uscourts.txwd.1172841950.1.11.pdf) |
| ThroughPuter Inc v. Microsoft Corporation | wawd | 2:22-cv-00344 | 92-40 | 2022-03-23 | repo | narrative | 11 | `MulAdd`, `vecAdd`, `cloudFPGA` | `gidel.c` |  |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.wawd.308463/gov.uscourts.wawd.308463.92.40.pdf) |
| Golden v. Google LLC | cafc | 24-2024 | 1-2 | 2024-07-01 | none | chart | 10 | `rAtNicDle`, `swuecrehreavsiepweudlsaendtofurpthuerlscelasisn…`, `tohretdsetSecBtiDonsofthfuantgiu` |  | 10,984,619 | 10 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cafc.21873/gov.uscourts.cafc.21873.1.2.pdf) |
| GOLDEN v. United States | uscfc | 1:23-cv-00811 | 26-1 | 2023-05-31 | none | narrative | 10 | `rAtNicDle`, `swuecrehreavsiepweudlsaendtofurpthuerlscelasisn…`, `tohretdsetSecBtiDonsofthfuantgiu` |  | 10,984,619 |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.uscfc.47713/gov.uscourts.uscfc.47713.26.1.pdf) |
| Golden v. Google LLC | cand | 3:22-cv-05246 | 68 | 2022-09-14 | none | narrative | 10 | `rAtNicDle`, `swuecrehreavsiepweudlsaendtofurpthuerlscelasisn…`, `tohretdsetSecBtiDonsofthfuantgiu` |  | 10,984,619 |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cand.400472/gov.uscourts.cand.400472.68.0.pdf) |
| Golden v. Google LLC | cand | 3:22-cv-05246 | 74-1 | 2022-09-14 | none | chart | 10 | `rAtNicDle`, `swuecrehreavsiepweudlsaendtofurpthuerlscelasisn…`, `tohretdsetSecBtiDonsofthfuantgiu` |  | 10,984,619 | 10 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cand.400472/gov.uscourts.cand.400472.74.1.pdf) |
| Uniloc 2017 LLC v. Google LLC | txed | 2:18-cv-00497 | 157-1 | 2018-11-17 | repo | narrative | 10 | `EXPECT_EQ`, `EXPECT_FALSE`, `ProfileLevelIdToString` | `fmo.h`, `OMX_Video.h`, `_id_unittest.cc` |  | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.186094/gov.uscourts.txed.186094.157.1.pdf) |
| ThroughPuter, Inc. v. Google LLC | txwd | 1:25-cv-01625 | 1-22 | 2025-10-07 | directory | narrative | 9 | `apply`, `Pipeline`, `setvalid` | `p4runtime.proto`, `p4info.proto` |  |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172868158/gov.uscourts.txwd.1172868158.1.22.pdf) |
| Malikie Innovations Ltd. v. Core Scientific, In… | txed | 2:25-cv-00519 | 1-8 | 2025-05-12 | document | chart | 8 | `secp256k1_fe_normalize`, `secp256k1_ecmult_gen`, `secp256k1_ge_set_gej` | `field_5x52.h`, `field_10x32.h` | 7,372,960 | 3 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.237820/gov.uscourts.txed.237820.1.8.pdf) |
| Health Discovery Corporation v. Intel Corporati… | txwd | 6:22-cv-00356 | 17-11 | 2022-04-04 | repo | narrative | 8 | `ExtraTreesClassifier`, `oanndinVf9or`, `sf9fel0teSpepexlriactme` | `iadtleebrruiomofnitn.h` | 7,117,188 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1167837/gov.uscourts.txwd.1167837.17.11.pdf) |
| Malikie Innovations Ltd. v. Core Scientific, In… | txed | 2:25-cv-00519 | 1-10 | 2025-05-12 | document | chart | 7 | `secp256k1_scalar_mul`, `secp256k1_scalar_set_int`, `secp256k1_scalar_reduce_512` | `scalar_8x32_impl.h` | 8,532,286 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.237820/gov.uscourts.txed.237820.1.10.pdf) |
| Sookbox Development LLC v. Fry's Electronics, I… | txed | 6:18-cv-00331 | 1 | 2018-07-06 | directory | narrative | 7 | `CGUIPassword::LockSources`, `CMediaSourceSettings::GetInstance`, `GetSources` |  | 9,497,137 |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.183297/gov.uscourts.txed.183297.1.0.pdf) |
| Sookbox Development LLC v. Walmart Inc. | txed | 6:18-cv-00330 | 1 | 2018-07-06 | directory | narrative | 7 | `CGUIPassword::LockSources`, `CMediaSourceSettings::GetInstance`, `GetSources` |  | 9,497,137 |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txed.183296/gov.uscourts.txed.183296.1.0.pdf) |
| Munich Re America Services, Inc. v. Intellectua… | ded | 1:26-cv-00417 | 1 | 2026-04-10 | none | chart | 6 | `RDD.checkpoint`, `spark.range`, `withColumn` |  | 7,822,841 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.92764/gov.uscourts.ded.92764.1.0.pdf) |
| Guardant Health, Inc. v. Tempus AI, Inc. | ded | 1:24-cv-00687 | 1-1 | 2024-06-11 | none | chart | 6 | `irPaNpoAnSgsa`, `rmMa.tiectsa`, `sinTghleenmuectlheootdisdedevsarciraitbieodnshe` | `n5o7m9i.c` | 9,902,992 |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.86088/gov.uscourts.ded.86088.1.1.pdf) |
| True Return Systems, LLC v. MakerDAO | nysd | 1:22-cv-08478 | 76 | 2022-10-05 | none | other | 5 | `poke`, `stop`, `void` | `Dai.js` | 10,025,797 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.nysd.587363/gov.uscourts.nysd.587363.76.0.pdf) |
| WSOU Investments LLC v. Microsoft Corporation | txwd | 6:20-cv-00454 | 20-3 | 2020-06-02 | none | other | 5 | `arg_max`, `setAuthenticatedUserContext`, `count` | `Node.js`, `node.js` |  |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1098123/gov.uscourts.txwd.1098123.20.3.pdf) |
| Dental Monitoring v. Get-Grin Inc. | ded | 1:22-cv-00647 | 105-5 | 2022-05-16 | none | chart | 4 | `smoothL1`, `nElizabeth`, `oftheDay` | `Express.js`, `vjt.c` |  | 11 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.78936/gov.uscourts.ded.78936.105.5.pdf) |
| Securitize I, Inc. v. tZERO Group, Inc. | ded | 1:26-cv-00722 | 15-9 | 2026-06-22 | document | chart | 3 | `transfer`, `transferFrom`, `recordTransfer` | `ComplianceServiceWhitelisted.sol` | 12,099,996 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ded.93554/gov.uscourts.ded.93554.15.9.pdf) |
| VirtaMove, Corp. v. Oracle Corporation | txwd | 7:24-cv-00339 | 21-4 | 2024-12-20 | document | chart | 3 | `Systet11.out.println`, `kmalloc`, `kfree` |  | 7,784,058 | 1 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.txwd.1172818303/gov.uscourts.txwd.1172818303.21.4.pdf) |
| BearBox LLC v. Lancium LLC | cafc | 23-1922 | 26-2 | 2023-05-22 | none | chart | 3 | `LanciumRule26`, `exelon4_modeling_05092019`, `supplementingconsistentwithFRCP26` | `arb_main_AEC.py`, `EXELON4.py`, `DA_LMP_import.py` | 10,608,433 | 12 | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.cafc.20249/gov.uscourts.cafc.20249.26.2.pdf) |
| Kove IO, Inc. v. Amazon Web Services, Inc. | ilnd | 1:18-cv-08175 | 1-1 | 2018-12-12 | repo | other | 3 | `get`, `put`, `boto3.client` | `Node.js` |  |  | [pdf](https://storage.courtlistener.com/recap/gov.uscourts.ilnd.359415/gov.uscourts.ilnd.359415.1.1_1.pdf) |

**Coarser (232)**: repository, directory or documentation links only, or no repository link; their domains say what the chart rests on (documentation sites lead). They are in the JSONL with `best` set; the ones that quote code are the table above, the rest are not listed here.
<!-- catalog:end -->

## Caveats

- **Coverage is partial.** RECAP holds what its users uploaded. A miss means the archive did not
  have it, not that no such filing exists; gaps go to PACER by hand, and those purchases are not
  part of the script.
- **Public means documentation.** Most charts in complaints cite product pages. The file-level
  rows above are the minority, and the function-level rows are rarer still.
- **A chart is a contention.** Agreement with it is agreement with a party. Where both sides'
  charts are public, both belong in the catalog.
- **A link is not a version.** A `blob/master` link points at whatever `master` was when the
  filing was made; the catalog keeps the filing date so the repository can be checked out near it.
- **The function and patent beside a link are the nearest mentions in the text**, read by rule.
  A filing that cites two files in one sentence can put one file's call beside the other's link,
  and a declaration can name a reference patent near the asserted one; the PDF is the authority
  and the catalog row is the pointer to it.
- **A name is a shape, and a limitation is the patent's claim aligned by rule, or the chart's
  own quotation.** The code pass keeps what is shaped like code; a product name can pass the
  shape test. The limitation beside a row comes from the patent's claim (`[patent 0.86]`, the
  number being the share of the chart's words found in the aligned span; `[patent-claim]` for
  the whole claim, where the row has no claim text of its own), from a claim the document
  reproduces (`[document]`), from the claim column, from a claim-text page, or from the head of
  the evidence, and the listing says which. The patent's text is the claim, but which span of it
  a row answers is still the chart's say, read by word overlap, and a paragraph's claim text is
  the whole claim its number names. A chart that labels its rows some other way, or sets its
  columns at no stable offset, leaves its names under "no row or paragraph nearby"; a
  paragraph's association is the pleader's sentence and the nearest claim number, not a label. Three distinct functions is the threshold
  for the catalog's second table, set on the first run's texts so that a complaint quoting one API
  name in passing is counted, not listed. A page whose two columns `pdftotext` interleaved letter
  by letter yields nonsense names (Golden v. Google's brief, filed four times; TwinStrand v.
  Guardant Dkt 30; Guardant v. Tempus Dkt 1-1), a page with no space glyphs runs words together
  (`supplementingconsistentwithFRCP26`), and no rule here can tell such a name from a real one
  without flagging real ones (`IsAdIdTrackingDisabled`, `blockchain`, `strcmp`). The PDF is the
  authority.

## What comes next

A catalog row becomes a test by indexing the cited repository near the filing date and charting
the charted claim with `--claim-chart`, scoring agreement with the filing party's citations the
way the self-test scores recovery of drafted anchors. That is a separate piece of work; this page
only finds the pairs.

## Related

- [`litigated-claims-ground-truth.md`](litigated-claims-ground-truth.md) — what the claim features are tested against, and the self-test.
- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — charting claims against a codebase.
- [`claims-pipeline-state.md`](claims-pipeline-state.md) — the pipeline's state and measurement ledger.
