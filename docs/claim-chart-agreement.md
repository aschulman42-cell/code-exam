# Does CodeExam find the code a litigant charted? The first agreement test

A public claim chart that cites open-source code pairs a litigated claim with the functions
and files one party says meet it. [`real-world-claim-charts.md`](real-world-claim-charts.md)
finds those pairs; this page turns fourteen of them into a test of CodeExam's claim features
and records what the test measures. The score is **agreement with a party**: a chart is
advocacy, so a match is not correctness, and a CodeExam pick outside the litigant's set is
different, not wrong, until a person reads it.

## The test

For each filing: clone the cited repository at the commit the filing's links pin, or at the
default branch on the filing date; build a CodeExam index of the whole tree (the test is whether
CodeExam finds the code in the codebase, not in the cited files); fetch the patent's claims from
Google Patents through `scripts/litigated-claims-fetch.mjs`; then, per asserted claim:

- **Reachability, no model.** Are the litigant's named functions and files in the index at that
  commit at all? An absent name is a snapshot or corpus mismatch, reported and never scored
  against CodeExam.
- **Tier 0, a rule, no model.** The claim's content words against the index's symbol names,
  each word weighted by its rarity across the index. Weaker than `--claim-locate`'s own
  retrieval, which adds a model's code words and a search of function bodies; it says what name
  matching alone can see.
- **Tier 1, `--claim-locate`.** The located targets (`file@symbol`), run twice: with `--blind`,
  which hides file paths and the codebase's identity so a hit is discovery, and without, where a
  hit on bitcoin, spark or solana may be recall of a codebase the model has seen.
- **Tier 2, `--claim-chart`.** Per-element retrieval with the patent's own claim divisions as
  the element file, scored on the evidence each row cites.

**Scoring**, per filing and tier, with the litigant's set restricted to reachable names:
found-of-cited (how much of what the litigant cited CodeExam also chose) and cited-of-chosen
(how much of what CodeExam chose the litigant also cited). Names match on the identifier's last
segment (`CKey::MakeNewKey` is `MakeNewKey`; an underscore name is matched whole), files on
path suffix. Where the chart's rows are clean, the same arithmetic runs per row.

```
node scripts/recap-chart-agreement.mjs --picks test/fixtures/recap-chart-agreement-candidates.json \
    --catalog <run>/catalog.jsonl --work <dir outside the repo>            # every step, resumable
node scripts/recap-chart-agreement.mjs --picks … --work <dir> --steps tier1,tier2,score --llm claude   # the model tiers, where a key is
node scripts/recap-chart-agreement.mjs --picks … --work <dir> --steps score --render docs/claim-chart-agreement.md
```

The picks file carries the facts set by hand from each filing: the patent, the asserted claims
(claim 1 assumed where the filing lists none), the repositories and any commit the links pin.
The litigant's cited set is read from the catalog at prepare time into the work directory's
`manifest.json`.

## The fourteen

| # | filing | patent, claims | repository, ref | the litigant cites |
|---|---|---|---|---|
| 1 | R2 v. Databricks 149-2 (2023-12-28), chart | 8,190,610; 1, 2, 5, 17 to 21 | `apache/spark`, master at date | `RowIterator.fromScala`, `UnsafeProjection.create`, `createLeftKeyGenerator`; `SortMergeJoinExec.scala`, `ZippedPartitionsRDD.scala`; 2 file links |
| 2 | Veritaseum v. Coinbase 1-3 (2022-09-22), chart | 11,196,566; 1, 2, 3, 7, 8 | `solana-labs/solana`, `ethereum/consensus-specs`, master at date | 24 line links (`validator/src/main.rs#L2999`, `rpc_client.rs`); `is_proposer`, `get_current_epoch` |
| 3 | Malikie v. Foundry 1-11 (2025-12-12), chart | 8,806,197; 1 | `bitcoin-core/secp256k1` @ `b6c2a3c` | `secp256k1_ecdsa_sign_inner`, `secp256k1_ecdsa_sig_sign`; `src/secp256k1.c`, `src/ecdsa_impl.h` |
| 4 | Malikie v. Foundry 1-14 (2025-12-12), chart | 8,666,062; 1 | `bitcoin-core/secp256k1` @ `ad60ef7` | `secp256k1_fe_normalize`, `secp256k1_ecmult_gen`; `field_5x52.h`, `int128.h` |
| 5 | Malikie v. ViaBTC 1-6 (2026-09-09), chart | 8,788,827; 1 | `bitcoin/bitcoin`, master at date | `secp256k1_scalar_mul`, `secp256k1_ecdsa_recoverable_signature_load`; `secp256k1_recovery.h` |
| 6 | Malikie v. MARA 1-11 (2025-05-12), chart | 7,372,961; 1 | `bitcoin/bitcoin`, master at date | `CKey::MakeNewKey`, `GetStrongRandBytes`, `secp256k1_ec_seckey_verify`; `key.cpp` |
| 7 | Malikie v. Coinbase 1-8 (2025-05-12), chart | 7,372,960; 3 | `bitcoin-core/secp256k1`, master at date | `secp256k1_fe_normalize`, `secp256k1_ecmult_gen`; `field_5x52.h` |
| 8 | Malikie v. Coinbase 1-10 (2025-05-12), chart | 8,532,286; 1 | `bitcoin-core/secp256k1`, master at date | `secp256k1_scalar_mul`, `secp256k1_scalar_reduce_512` |
| 9 | VM Innovations v. Coinbase 1-23 (2026-05-07), chart | 12,093,999; 1 | `coinbase/coinbase-sdk-nodejs` @ `31b3dfe`, `circlefin/evm-cctp-contracts`, `ethereum/go-ethereum` @ `341647f` | `bridgeUSDC`, `depositTx.wait`; `bridge-usdc.js`, `TokenMessenger.sol`, `broadcast.go` |
| 10 | FriendliAI v. Hugging Face 26-1 (2023-07-28), chart | 11,442,775; 10, 35 | `huggingface/text-generation-inference` @ `bd3a9d8` | 23 line-range links (`router/src/server.rs#L33-L78`, `router/src/infer.rs#L239-L348`); `generate_token` |
| 11 | Securitize v. tZERO 15-9 (2026-06-22), chart | 12,099,996; 1 | `securitize-io/dstoken`, master at date | `transfer`, `transferFrom`, `recordTransfer`; `ComplianceServiceWhitelisted.sol` |
| 12 | True Return v. MakerDAO 1-6 (2022-10-05) | 10,025,797 (from the docket's memorandum); 1 assumed | `makerdao/dss`, master at date | 14 file links (`src/vat.sol`, `cat.sol`, `spot.sol`); `End.cage`, `Pot.drip` |
| 13 | Sookbox v. Fry's Dkt 1 (2018-07-06), complaint | 9,497,137; 1 assumed | `xbmc/xbmc`, master at date | `CGUIPassword::LockSources`, `CMediaSourceSettings::GetInstance` |
| 14 | PROGME v. Comcast 1-1 (2017-03-29), complaint | 8,713,425; 1 | `Comcast/cmb`, master at date | 112 names, mostly `println` / `print`; `CMBStatsServlet.java`, `web.xml` |

Left out, and why: ESW v. Roku links specification repositories and names a platform API;
Oracle v. Google's repository link is a 2013 crawler, not the accused code; Golden v. Google,
TwinStrand v. Guardant and Health Discovery v. Intel are interleaved-column pages with no
readable names; Pavemetrics and ThroughPuter name no patent.

## Results

**First run, 2026-10-21, the no-model tiers, all fourteen.** Sixteen repository-commits
indexed, from Circle's contracts at 453 symbols to Spark at 83,593 and Kodi at 53,788; Kodi took
60 seconds to index and no other repository more than 4 (Spark's time was lost when the first
run was stopped for memory; the harness resumed). The model tiers ran afterwards: both of them
on three of the fourteen (the second run, below), then `--claim-locate` on the other eleven (the
third).

Reachability is high where the chart quotes code: the secp256k1 and Bitcoin exhibits reach 11 of
12, 8 of 8, 13 of 14, 13 of 13, 8 of 8 and 6 of 7 of their names (the absences are a macro,
`SECP256K1_ARG_NONNULL`, and a function renamed since, `secp256k1_u128_to_u64`); Kodi 7 of 7;
Securitize's dstoken 3 of 3; FriendliAI's text-generation-inference 2 of 3 and 8 of 10 files; the
Databricks chart 39 of 49, the rest being locals, values and types the chart pasted with the code
(`joinRow`, `boundCondition`, `IndexedSeq`); PROGME's cmb 58 of 112, the rest `println`,
`print` and the other Java library calls its complaint quotes; VM Innovations all 6 across its
three repositories, every one in the SDK. Veritaseum reaches 3 of 25: the names its chart quotes
are the Ethereum consensus specification's pseudo-code, which lives in markdown files no code index
reads, and its `web3.eth` calls are a client library's; its real code citations are its 24 Solana
line links, 5 of whose 7 files are in the index. True Return's dss reaches 6 of 17 and all 12 of
its cited files; the absent names (`cage`, `thaw`, `Vat.Frob`) are contract functions the
parser did not catch, a Solidity limit of the index rather than of the snapshot.

Three lessons came from the data. CodeExam records a Scala method as `Class::method`, and until
the matcher compared last segments on both sides the Spark chart appeared to reach 25 of 49.
CodeExam's default extension set leaves out `.sol`: indexed without it, `makerdao/dss` held one
file, its LICENSE, and `dstoken` only its TypeScript tests, so the picks file now asks for
`.sol` on the three Solidity repositories. And a chart that quotes a specification's pseudo-code
(Veritaseum) has no code key at all beyond its file links.

Tier 0 is the floor it was expected to be: of 38 claim-and-index rows, four have any hit, Malikie
v. Foundry 1-11 at 2 of 11 (`secp256k1_ecdsa_sign_recoverable` and
`secp256k1_ecdsa_recoverable_signature_save` share the claim's "signature" and "recoverable"
words), FriendliAI at 1 of 2 (`generate_token`), Securitize at 1 of 3 (`recordTransfer`), PROGME
at 1 of 33 (`toString`). A claim's words rarely appear in symbol names; the model tiers are where
retrieval happens.

**Second run, 2026-10-21, the model tiers on three strong keys:** Malikie v. Foundry 1-11,
Malikie v. MARA 1-11 and Securitize v. tZERO 15-9, through CodeExam with Claude Sonnet 4.6, one
sample each (a cloud engine has no seed control, and an identical command may choose
differently). Nine CodeExam runs, none refused. Each `--claim-locate` cost a few cents; the
three `--claim-chart` runs cost $0.28, $0.79 and $0.84.

| filing | litigant's reachable names | tier 1 blind, found of cited | tier 1 plain | tier 2 per-element |
|---|---:|---|---|---|
| Foundry 1-11 (secp256k1, US 8,806,197) | 11 | 4 of 11, from 16 chosen | 4 of 11, from 17 | 1 of 11, from 21 |
| MARA 1-11 (Bitcoin, US 7,372,961) | 12 | 2 of 12, from 25 | 1 of 12, from 28 | 0 of 12, from 33 |
| Securitize 15-9 (dstoken, US 12,099,996) | 3 | 2 of 3, from 22 | 3 of 3, from 29 | 1 of 3, from 35 |

`--claim-locate` finds the centre of each chart and not its arithmetic. At Foundry the four it
found are the signing path the chart's second row walks (`secp256k1_ecdsa_sign_recoverable`,
`secp256k1_ecdsa_sign_inner`, `secp256k1_ecdsa_sig_sign`,
`secp256k1_ecdsa_recoverable_signature_save`); the seven it did not are the field and scalar
primitives the chart's second and third rows step through to show the point computed and the
recovery indicator derived from it
(`secp256k1_fe_is_odd`, `secp256k1_scalar_cond_negate`, `secp256k1_fe_normalize`,
`secp256k1_ge_set_gej` and the rest), names nothing in the claim's words points to. At
Securitize the plain run chose every name the chart cites, `transfer`, `transferFrom` and
`recordTransfer`, each under a different element than the chart's row (CodeExam's `transfer`
answers "receive a request to cryptographically transfer"; the chart's answers that row and the
whitelist row), and 26 other names besides. At MARA the chart's path is `CKey::MakeNewKey`,
`GetStrongRandBytes`, `ProcRand`, `RNGState::MixExtract`, `CKey::Check` and
`secp256k1_ec_seckey_verify`, the last being the "less than said order q" test the claim turns
on; CodeExam chose `MakeNewKey` and `MixExtract`, and for the order test `secp256k1_scalar_reduce`,
`CKey::IsValid` and `CPubKey::Invalidate`, neighbours of the chart's names in the same files
(`IsValid` returns what `Check` decided) and not the names. Blind and plain differ little: the
same four at Foundry, two against one at MARA, two against three at Securitize. On this sample a
hit is not recall of a codebase the model has seen.

Cited-of-chosen is low everywhere, 0.04 to 0.25. CodeExam lists sixteen to twenty-nine
candidates where a chart cites three to thirteen, and a chart cites the least its argument needs;
the number measures what a reader would set aside, not what is wrong.

**Third run, 2026-10-21, `--claim-locate` on the other eleven**, same engine and settings, one
sample per row. The tier 1 column is now complete for the fourteen, at $0.60 for all 31
claim-locate calls; claim-chart rows exist for the three above only. Found of the litigant's
reachable names, per repository:

| filing | repository | reachable names | blind | plain |
|---|---|---:|---:|---:|
| Foundry 1-11 | secp256k1 | 11 | 4 | 4 |
| MARA 1-11 | Bitcoin | 12 | 2 | 1 |
| Securitize 15-9 | dstoken | 3 | 2 | 3 |
| ViaBTC 1-6 | Bitcoin | 13 | 4 | 4 |
| FriendliAI 26-1, claim 10 | text-generation-inference | 2 | 1 | 1 |
| Databricks 149-2 | Spark | 37 | 1 | 1 |
| VM Innovations 1-23 | Coinbase SDK / Circle / go-ethereum | 3 / 0 / 1 | 0 / – / 0 | 1 / – / 0 |
| Foundry 1-14 | secp256k1 | 8 | 0 | 0 |
| Coinbase 1-8, claim 3 | secp256k1 | 8 | 0 | 0 |
| Coinbase 1-10 | secp256k1 | 6 | 0 | 0 |
| Sookbox 1 | Kodi | 7 | 0 | 0 |
| PROGME 1-1 | cmb | 33 | 0 | 0 |
| True Return 1-6 | dss | 4 | 0 | unparsed |
| Veritaseum 1-3 | Solana / consensus-specs | 3 / 2 | 0 / 0 | 0 / 0 |

Pooled over every reachable name, plain finds 15 of 153 and blind 14; two large weak keys,
Databricks's 37 and PROGME's 33, hold nearly half the denominator, so the rows are the result.
Blind and plain agree at eleven filings and differ by one name at the other three. Four
patterns:

- **Where the chart cites the mechanism's API, claim-locate finds it.** Securitize's three
  token functions; FriendliAI's `generate_token` (its other name, `batch.size`, is a field);
  MARA's key constructor; at ViaBTC the recovery path's centre
  (`secp256k1_ecdsa_sig_recover`, `secp256k1_ecdsa_recoverable_signature_load`,
  `secp256k1_pubkey_save`), where CodeExam also chose the Bitcoin-level callers the chart does
  not cite, `CPubKey::RecoverCompact` and `MessageVerify`. At FriendliAI CodeExam's list
  (`batching_task`, `prefill`, `decode`, `Queue::next_batch`, `filter_batch`) maps the batching
  mechanism more fully than the chart's two names do.
- **Where the chart walks arithmetic, claim-locate stops at the API.** The three Malikie
  patents on finite-field operations and Montgomery reduction (Foundry 1-14, Coinbase 1-8 and
  1-10) score zero. The charts cite `secp256k1_fe_normalize`, `secp256k1_u128_mul`,
  `secp256k1_scalar_mul_512` and their kin; CodeExam chose field tests,
  `secp256k1_ge_set_gej_var` (the chart's `secp256k1_ge_set_gej` with a suffix), scalar
  reduction, and for the Montgomery claim the `_load` functions its "obtaining an operand"
  words suggested. Two of those charts, Foundry 1-14 and Coinbase 1-8, cite the same eight
  functions for two patents of one family. The name match is strict: a `_var` or `_impl`
  variant of a cited function is a miss.
- **Where the key is a complaint's pasted code or a different reading, zero overlap says
  little about the locator.** PROGME's 33 names are the getters of an admin servlet its
  complaint quoted; CodeExam went to the URL and ARN string handling the claim's "hyperlink
  address string" words describe. Sookbox's seven are Kodi's lock-sources code; CodeExam went
  to the UPnP device host and control point, the nearer fit on the claim's words to "a control
  device ... participant of a content distribution control session". Databricks's chart reads
  claim 1 onto the sort-merge join; CodeExam read it onto grouped datasets and state stores.
  The one name shared there, `longMetric`, is a metric accessor, and VM Innovations's one,
  `wait`, is a promise. Which reading is right is a reader's question; the harness records
  only that the parties differ.
- **Where the claim's vocabulary has no footprint in the names, the search finds nothing.**
  True Return's claim, a differences layer in parallel storage linked to a ledger, against
  MakerDAO's dss, whose functions are `frob`, `drip`, `bite` and `vat`: the predicted words
  found no candidate for nine of eleven elements, and the one candidate found was
  `LICENSE@network`, a word of the AGPL text the index had parsed as code; the plain run's
  selection was unparseable twice. Veritaseum's key is specification pseudo-code and scores
  zero as expected.

Tier 2 as run is the wrong instrument for the question. Without `--targets`, `--claim-chart`
retrieves its own candidates per element from predicted vocabulary, rarity-ranked over the
symbol table, three deep per element plus a whole-claim arm, and the harness scores everything
it retrieved: 21, 33 and 35 names, many of them tests, benchmarks and headers (`bench.c@help`,
`tests_wycheproof_generate_ecdh.py@parse_public_key`, `leveldb::RandomGenerator`). Scored
instead on the targets CodeExam's own judge marked PRESENT or PARTIAL on any element (4, 8 and
17 of them), agreement is 1 of 11, 0 of 12 and 0 of 3. The judge found Foundry's recovery
indicator in `secp256k1_ecdsa_recoverable_signature_save` (PARTIAL: it stores `recid`, it does
not compute it); found MARA's seed generation PRESENT in `MuHashPrecompute` and not in
`MakeNewKey`; and read Securitize's remote-signing limitations onto the permit path
(`ERC20PermitMixin.sol@permit`, `StandardToken.sol@transferWithPermit`,
`TransactionRelayer.sol@_executePreApprovedTransaction`, PRESENT on six elements) where the
chart reads them onto `recordTransfer`, which the judge marked ABSENT on every element. That
last is a difference of reading, not a miss: a signature relayed from a remote signer is a
reading the words "a remotely located computing device configured to cryptographically sign
data" allow, and which party has the better of it is for a reader. CodeExam's documented
pipeline runs `--claim-chart` on the targets `--claim-locate` wrote; the harness does not yet,
and that configuration, tier 1's targets with the judge's labels as the score, is the next run.

<!-- agreement:start -->
_Generated 2026-10-22 by `scripts/recap-chart-agreement.mjs --render` from 114 record(s); edit the script, not this block._

| candidate | repository @ ref | index symbols | functions reachable / cited | files reachable / cited | absent names |
|---|---|---:|---|---|---|
| databricks-149-2 | apache/spark @ af8228c | 83593 | 39 / 49 | 7 / 8 | oos.defaultWriteObject, IndexedSeq, joinRow, boundCondition, resultProj, eagerCleanupResources, … |
| veritaseum-1-3 | solana-labs/solana @ eaa4787 | 17579 | 3 / 25 | 5 / 7 | is_proposer, get_current_epoch, web3.eth.signTransaction, tokenURI, get_deposit_root, get_committee_assignment, … |
| veritaseum-1-3 | ethereum/consensus-specs @ fdb5c7d | 1389 | 2 / 25 | 0 / 7 | is_proposer, get_current_epoch, web3.eth.signTransaction, web3.eth.sendTransaction, tokenURI, get_deposit_root, … |
| foundry-1-11 | bitcoin-core/secp256k1 @ b6c2a3c | 950 | 11 / 12 | 8 / 8 | SECP256K1_ARG_NONNULL |
| foundry-1-14 | bitcoin-core/secp256k1 @ ad60ef7 | 900 | 8 / 8 | 3 / 6 |  |
| viabtc-1-6 | bitcoin/bitcoin @ b3a9b84 | 21517 | 13 / 14 | 1 / 1 | SECP256K1_ARG_NONNULL |
| mara-1-11 | bitcoin/bitcoin @ 8673e8f | 19051 | 13 / 13 | 1 / 1 |  |
| coinbase-1-8 | bitcoin-core/secp256k1 @ 4187a46 | 898 | 8 / 8 | 0 / 2 |  |
| coinbase-1-10 | bitcoin-core/secp256k1 @ 4187a46 | 898 | 6 / 7 | 1 / 1 | secp256k1_u128_to_u64 |
| vm-innovations-1-23 | coinbase/coinbase-sdk-nodejs @ 31b3dfe | 1058 | 6 / 6 | 2 / 5 |  |
| vm-innovations-1-23 | circlefin/evm-cctp-contracts @ 4061786 | 453 | 0 / 6 | 2 / 5 | wait, depositTx.wait, receiveMessageTx.wait, bridgeUSDC, fetchWalletAndLoadSeed, approveTx.wait |
| vm-innovations-1-23 | ethereum/go-ethereum @ 341647f | 17335 | 4 / 6 | 1 / 5 | bridgeUSDC, fetchWalletAndLoadSeed |
| friendliai-26-1 | huggingface/text-generation-inference @ bd3a9d8 | 849 | 2 / 3 | 8 / 10 | SortByArrivalTime |
| securitize-15-9 | securitize-io/dstoken @ 3f4074b | 747 | 3 / 3 | 1 / 1 |  |
| true-return-1-6 | makerdao/dss @ fa4f663 | 157 | 6 / 17 | 12 / 12 | End.cage, cage, Vat.Frob, thaw, mint, openLockGemAndDraw, … |
| sookbox-1 | xbmc/xbmc @ cf5e540 | 53788 | 7 / 7 | 0 / 0 |  |
| progme-1-1 | Comcast/cmb @ 3dea798 | 2765 | 58 / 112 | 14 / 20 | println, print, getProperties, getPropertyValue, getProperty, printMsg, … |
| veritaseum-1-3 | all repositories | 18968 | 3 / 25 | 5 / 7 | is_proposer, get_current_epoch, web3.eth.signTransaction, tokenURI, get_deposit_root, get_committee_assignment, … |
| vm-innovations-1-23 | all repositories | 18846 | 6 / 6 | 2 / 5 |  |

| candidate | claim | tier | mode | CodeExam chose | litigant cited (reachable) | both | found of cited | cited of chosen | matched |
|---|---:|---|---|---:|---:|---:|---:|---:|---|
| databricks-149-2 | 1 | tier2 | per-element | 22 | 37 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier2 | per-element | 40 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier2 | per-element | 19 | 2 | 0 | 0.00 | 0.00 |  |
| foundry-1-11 | 1 | tier2 | per-element | 21 | 11 | 1 | 0.09 | 0.05 | secp256k1_ecdsa_recoverable_signature_save |
| foundry-1-14 | 1 | tier2 | per-element | 24 | 8 | 1 | 0.13 | 0.04 | secp256k1_ecmult_gen |
| viabtc-1-6 | 1 | tier2 | per-element | 23 | 13 | 0 | 0.00 | 0.00 |  |
| mara-1-11 | 1 | tier2 | per-element | 33 | 12 | 0 | 0.00 | 0.00 |  |
| coinbase-1-8 | 3 | tier2 | per-element | 24 | 8 | 1 | 0.13 | 0.04 | secp256k1_ecmult_gen |
| coinbase-1-10 | 1 | tier2 | per-element | 17 | 6 | 1 | 0.17 | 0.06 | secp256k1_scalar_reduce_512 |
| vm-innovations-1-23 | 1 | tier2 | per-element | 34 | 3 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier2 | per-element | 33 | 0 | 0 | — | 0.00 |  |
| vm-innovations-1-23 | 1 | tier2 | per-element | 38 | 1 | 0 | 0.00 | 0.00 |  |
| friendliai-26-1 | 10 | tier2 | per-element | 22 | 2 | 1 | 0.50 | 0.05 | generate_token |
| securitize-15-9 | 1 | tier2 | per-element | 35 | 3 | 1 | 0.33 | 0.03 | recordtransfer |
| true-return-1-6 | 1 | tier2 | per-element | 9 | 4 | 2 | 0.50 | 0.22 | transferfrom, transfer |
| sookbox-1 | 1 | tier2 | per-element | 28 | 7 | 0 | 0.00 | 0.00 |  |
| progme-1-1 | 1 | tier2 | per-element | 24 | 33 | 1 | 0.03 | 0.04 | tostring |
| databricks-149-2 | 1 | tier0 | rule | 22 | 37 | 0 | 0.00 | 0.00 |  |
| databricks-149-2 | 2 | tier0 | rule | 10 | 37 | 0 | 0.00 | 0.00 |  |
| databricks-149-2 | 5 | tier0 | rule | 21 | 37 | 0 | 0.00 | 0.00 |  |
| databricks-149-2 | 17 | tier0 | rule | 22 | 37 | 0 | 0.00 | 0.00 |  |
| databricks-149-2 | 18 | tier0 | rule | 10 | 37 | 0 | 0.00 | 0.00 |  |
| databricks-149-2 | 19 | tier0 | rule | 19 | 37 | 0 | 0.00 | 0.00 |  |
| databricks-149-2 | 20 | tier0 | rule | 20 | 37 | 0 | 0.00 | 0.00 |  |
| databricks-149-2 | 21 | tier0 | rule | 18 | 37 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier0 | rule | 21 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 2 | tier0 | rule | 22 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 3 | tier0 | rule | 22 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 7 | tier0 | rule | 21 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 8 | tier0 | rule | 23 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier0 | rule | 24 | 2 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 2 | tier0 | rule | 16 | 2 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 3 | tier0 | rule | 24 | 2 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 7 | tier0 | rule | 24 | 2 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 8 | tier0 | rule | 24 | 2 | 0 | 0.00 | 0.00 |  |
| foundry-1-11 | 1 | tier0 | rule | 21 | 11 | 2 | 0.18 | 0.10 | secp256k1_ecdsa_sign_recoverable, secp256k1_ecdsa_recoverable_signature_save |
| foundry-1-14 | 1 | tier0 | rule | 21 | 8 | 0 | 0.00 | 0.00 |  |
| viabtc-1-6 | 1 | tier0 | rule | 19 | 13 | 0 | 0.00 | 0.00 |  |
| mara-1-11 | 1 | tier0 | rule | 16 | 12 | 0 | 0.00 | 0.00 |  |
| coinbase-1-8 | 3 | tier0 | rule | 22 | 8 | 0 | 0.00 | 0.00 |  |
| coinbase-1-10 | 1 | tier0 | rule | 24 | 6 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier0 | rule | 22 | 3 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier0 | rule | 22 | 0 | 0 | — | 0.00 |  |
| vm-innovations-1-23 | 1 | tier0 | rule | 23 | 1 | 0 | 0.00 | 0.00 |  |
| friendliai-26-1 | 10 | tier0 | rule | 20 | 2 | 1 | 0.50 | 0.05 | generate_token |
| securitize-15-9 | 1 | tier0 | rule | 19 | 3 | 1 | 0.33 | 0.05 | recordtransfer |
| true-return-1-6 | 1 | tier0 | rule | 2 | 4 | 0 | 0.00 | 0.00 |  |
| sookbox-1 | 1 | tier0 | rule | 21 | 7 | 0 | 0.00 | 0.00 |  |
| progme-1-1 | 1 | tier0 | rule | 18 | 33 | 1 | 0.03 | 0.06 | tostring |
| databricks-149-2 | 1 | tier1 | blind | 27 | 37 | 2 | 0.05 | 0.07 | doexecute, longmetric |
| databricks-149-2 | 1 | tier1 | plain | 15 | 37 | 1 | 0.03 | 0.07 | longmetric |
| veritaseum-1-3 | 1 | tier1 | blind | 34 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier1 | plain | 32 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier1 | blind | 3 | 2 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier1 | plain | 2 | 2 | 0 | 0.00 | 0.00 |  |
| foundry-1-11 | 1 | tier1 | blind | 20 | 11 | 8 | 0.73 | 0.40 | secp256k1_ecdsa_sig_sign, secp256k1_ecdsa_sign_recoverable, secp256k1_ecdsa_sign_inner, secp256k1_ecdsa_recoverable_signature_save, secp256k1_ecmult_gen, secp256k1_ge_set_gej, secp256k1_fe_normalize, secp256k1_fe_get_b32 |
| foundry-1-11 | 1 | tier1 | plain | 19 | 11 | 8 | 0.73 | 0.42 | secp256k1_ecdsa_sig_sign, secp256k1_ecdsa_sign_recoverable, secp256k1_ecdsa_sign_inner, secp256k1_ecdsa_recoverable_signature_save, secp256k1_ecmult_gen, secp256k1_ge_set_gej, secp256k1_fe_normalize, secp256k1_fe_get_b32 |
| foundry-1-14 | 1 | tier1 | blind | 21 | 8 | 1 | 0.13 | 0.05 | secp256k1_fe_normalize |
| foundry-1-14 | 1 | tier1 | plain | 2 | 8 | 0 | 0.00 | 0.00 |  |
| viabtc-1-6 | 1 | tier1 | blind | 28 | 13 | 4 | 0.31 | 0.14 | secp256k1_ecdsa_recoverable_signature_load, secp256k1_ecdsa_sig_recover, secp256k1_pubkey_save, secp256k1_fe_set_b32_limit |
| viabtc-1-6 | 1 | tier1 | plain | 27 | 13 | 4 | 0.31 | 0.15 | secp256k1_ecdsa_recoverable_signature_load, secp256k1_ecdsa_sig_recover, secp256k1_pubkey_save, secp256k1_fe_set_b32_limit |
| mara-1-11 | 1 | tier1 | blind | 36 | 12 | 5 | 0.42 | 0.14 | check, getstrongrandbytes, makenewkey, makekeydata, data |
| mara-1-11 | 1 | tier1 | plain | 8 | 12 | 5 | 0.42 | 0.63 | check, getstrongrandbytes, makenewkey, makekeydata, data |
| coinbase-1-8 | 3 | tier1 | blind | 26 | 8 | 0 | 0.00 | 0.00 |  |
| coinbase-1-8 | 3 | tier1 | plain | 26 | 8 | 1 | 0.13 | 0.04 | secp256k1_fe_is_odd |
| coinbase-1-10 | 1 | tier1 | blind | 2 | 6 | 1 | 0.17 | 0.50 | secp256k1_scalar_reduce_512 |
| coinbase-1-10 | 1 | tier1 | plain | 1 | 6 | 1 | 0.17 | 1.00 | secp256k1_scalar_reduce_512 |
| vm-innovations-1-23 | 1 | tier1 | blind | 55 | 3 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier1 | plain | 51 | 3 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier1 | blind | 9 | 0 | 0 | — | 0.00 |  |
| vm-innovations-1-23 | 1 | tier1 | plain | 11 | 0 | 0 | — | 0.00 |  |
| vm-innovations-1-23 | 1 | tier1 | blind | 57 | 1 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier1 | plain | 56 | 1 | 0 | 0.00 | 0.00 |  |
| friendliai-26-1 | 10 | tier1 | blind | 31 | 2 | 1 | 0.50 | 0.03 | generate_token |
| friendliai-26-1 | 10 | tier1 | plain | 36 | 2 | 1 | 0.50 | 0.03 | generate_token |
| securitize-15-9 | 1 | tier1 | blind | 35 | 3 | 3 | 1.00 | 0.09 | transfer, transferfrom, recordtransfer |
| securitize-15-9 | 1 | tier1 | plain | 28 | 3 | 3 | 1.00 | 0.11 | transfer, transferfrom, recordtransfer |
| true-return-1-6 | 1 | tier1 | blind | 7 | 4 | 2 | 0.50 | 0.29 | transferfrom, transfer |
| true-return-1-6 | 1 | tier1 | plain | 6 | 4 | 2 | 0.50 | 0.33 | transferfrom, transfer |
| sookbox-1 | 1 | tier1 | blind | 6 | 7 | 0 | 0.00 | 0.00 |  |
| sookbox-1 | 1 | tier1 | plain | 2 | 7 | 0 | 0.00 | 0.00 |  |
| progme-1-1 | 1 | tier1 | blind | 30 | 33 | 0 | 0.00 | 0.00 |  |
| progme-1-1 | 1 | tier1 | plain | 25 | 33 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier2 | per-element | 58 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier0 | rule | 45 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 2 | tier0 | rule | 38 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 3 | tier0 | rule | 46 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 7 | tier0 | rule | 45 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 8 | tier0 | rule | 47 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier1 | blind | 37 | 3 | 0 | 0.00 | 0.00 |  |
| veritaseum-1-3 | 1 | tier1 | plain | 34 | 3 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier2 | per-element | 105 | 3 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier0 | rule | 67 | 3 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier1 | blind | 89 | 3 | 0 | 0.00 | 0.00 |  |
| vm-innovations-1-23 | 1 | tier1 | plain | 88 | 3 | 0 | 0.00 | 0.00 |  |
<!-- agreement:end -->

## Caveats

- **Agreement with a party.** The litigant's chart is advocacy. A high score says CodeExam and
  one party point at the same code; a low one says they differ, and which is right is a
  reading question.
- **The snapshot is the filing date, not the accused build.** A `master` link means whatever
  master was then; the harness takes the last commit before the filing date and records it.
  Where the filing pins a commit, that commit is used.
- **A name match is a name match.** It is not a finding that the code meets the claim, and the
  litigant's names are the catalog's reading of a PDF.
- **Claim 1 is assumed** where the filing lists no asserted claims (marked in the table).
- **The model tiers run where a key or a local model is**; without one they are recorded as
  skipped, and the table says so. All fourteen have claim-locate rows; three have claim-chart
  rows.
- **One sample per row.** The cloud engine has no seed control; `--runs N` pools several
  samples, and the rows above are single runs.
- **Tier 2's score counts what `--claim-chart` retrieved, not what its judge marked present.**
  The Results give both readings for the three; the harness computes the first.

## Related

- [`real-world-claim-charts.md`](real-world-claim-charts.md) — how the pairs were found, and the catalog.
- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — the commands the tiers run.
