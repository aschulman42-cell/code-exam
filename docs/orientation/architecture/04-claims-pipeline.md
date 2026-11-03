# Claims pipeline: detail

Click-through detail for 04-claims-pipeline.mmd. Facts are as of commit `f9756fe` (2026-11-02).
Where a step happens only if a person or a model does it, that arrow's tip and
section say so.

## Claim text

<!-- read: docs/CODEEXAM_PATENT_CLAIMS.md#A chart is a candidate match, not ground truth -->
A patent claim, inline or as `@file`. "`#` lines are PROVENANCE, not limitations" ([`src/commands/claim-locate.js:2079-2080`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L2079-L2080)). This is where a real claim enters; pseudo-claims are a separate feature, below.

## Claim Search

<!-- read: docs/CODEEXAM_PATENT_CLAIMS.md#From a claim to the code -->
`doClaimSearch` for the CLI and REPL ([`src/commands/claim.js:1224`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim.js?plain=1#L1224)). The GUI's Claims Workspace has its own implementation in `/api/claim-search-llm` ([`src/server.js:3731`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L3731)), which uses `extractClaimTerms` and runs TIGHT and BROAD terms through multisect ([`src/server.js:3862`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L3862), [`src/server.js:3879`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/server.js?plain=1#L3879)). Both are whole-claim searches with "the same quorum problem" ([`docs/claims-pipeline-state.md:29`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L29)).

## Claim Analyze

Two different things share the name. The CLI's `doClaimAnalyze` ([`src/commands/analyze.js:2079`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/analyze.js?plain=1#L2079)) runs whole-claim search and, by default, a per-element arm too ([`src/commands/analyze.js:2600`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/analyze.js?plain=1#L2600); off with `--no-per-element`, [`src/argparse.js:336`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/argparse.js?plain=1#L336)). The GUI's Claim Analyze extracts terms, searches, then analyzes one top function against the claim ([`public/app.js:1241-1250`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/app.js?plain=1#L1241-L1250)).

## Element splitter

`splitClaimElements` ([`src/commands/claim-locate.js:256`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L256)). No model involved: "CodeExam's deterministic code owns the structure" ([`docs/CODEEXAM_PATENT_CLAIMS.md:47`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_PATENT_CLAIMS.md?plain=1#L47)). `--elements` can supply the elements instead ([`src/commands/claim-chart.js:502-505`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L502-L505)).

## Vocabulary prediction

A model predicts code words per element ([`src/commands/claim-locate.js:870-874`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L870-L874)). "The vocabulary step is the NARROWEST point in the pipeline: it fails closed" ([`src/commands/claim-locate.js:876-877`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L876-L877)).

## Per-element retrieval

<!-- read: docs/claims-pipeline-state.md#2. Retrieval mechanisms -->
`retrievePerElement` ([`src/commands/claim-locate.js:870`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L870)): name search with `searchSymbolsByWords` ([`src/commands/claim-locate.js:1131`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L1131)), plus content search with `contentCandidatesForWords` ([`src/commands/claim-locate.js:673`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L673)) when an index is passed. Only the chart passes one; for Locate and `--claim-analyze`, the content arm returns early ([`src/commands/claim-locate.js:802`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L802)).

## Claim Locate

<!-- read: docs/CODEEXAM_PATENT_CLAIMS.md#From a claim to the code -->
`doClaimLocate` ([`src/commands/claim-locate.js:2075`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L2075)) calls `retrievePerElement` ([`src/commands/claim-locate.js:2271-2273`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L2271-L2273)), lets a model choose among symbols that exist ([`src/commands/claim-locate.js:2332`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L2332)), then verifies and navigates ([`src/core/symbol-verify.js:59`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/symbol-verify.js?plain=1#L59), [`src/core/symbol-verify.js:143`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/symbol-verify.js?plain=1#L143)).

## Your own targets

`--targets` accepts any list of `file@function` targets, not only Locate's output ([`src/commands/claim-chart.js:559`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L559)).

## MCP claim tools

<!-- read: docs/CODEEXAM_MCP.md#The tools -->
`claim_elements` and `claim_candidates` give agents the deterministic half of the pipeline ([`src/mcp-server.js:403-404`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L403-L404), [`src/mcp-server.js:415-416`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L415-L416)). The agent predicts the words itself ([`src/mcp-server.js:421`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L421)). This path stops before any chart.

## Claim Chart

<!-- read: docs/CODEEXAM_CLAIM_CHARTS.md#How a chart is made, and how to read a cell -->
`doClaimChart` ([`src/commands/claim-chart.js:2084`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L2084)), run with `--claim-chart` ([`src/index.js:1205-1208`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L1205-L1208)). It calls `retrievePerElement` directly, not through Locate ([`src/commands/claim-chart.js:2283`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L2283)). Without `--targets` it adds concentration, drilldown and whole-claim target arms ([`src/commands/claim-chart.js:2398`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L2398), [`src/commands/claim-chart.js:2417`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L2417)). `public/`, `src/server.js` and the REPL have no reference to it at this commit.

## Verdicts and sidecar

<!-- read: docs/CODEEXAM_PATENT_CLAIMS.md#Claim charts -->
Each cell is `PRESENT`, `PARTIAL`, `ASSUMED` or `ABSENT` ([`src/commands/claim-chart.js:827`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L827)). `--verdicts-out` writes the per-target record ([`src/commands/claim-chart.js:2616`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L2616)). The chart also reports whether its supporting code connects: "unconnected groups (no call path within…" ([`src/commands/claim-chart.js:1482-1483`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L1482-L1483)).

## Human examiner

<!-- read: docs/CODEEXAM_PATENT_CLAIMS.md#A chart is a candidate match, not ground truth -->
"Treat every verdict as 'this code is a candidate match for a stated reading'" ([`docs/CODEEXAM_PATENT_CLAIMS.md:22-23`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_PATENT_CLAIMS.md?plain=1#L22-L23)).

## Anchors or candidates

Pseudo-claims draft from anchors. Either you give them explicitly, as `file@func;…` or an `@anchors.lst` file ([`src/commands/pseudo-claims.js:2606-2610`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/pseudo-claims.js?plain=1#L2606-L2610)), or `--candidates` generates groups with the mechanism grouper ([`src/commands/pseudo-claims.js:2581-2582`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/pseudo-claims.js?plain=1#L2581-L2582)). `--rank` and `--ground-truth` emit candidate lists without drafting ([`src/commands/pseudo-claims.js:2575`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/pseudo-claims.js?plain=1#L2575)).

## Pseudo-claims

<!-- read: docs/CODEEXAM_PSEUDO_CLAIMS.md#What it is -->
`doPseudoClaims` drafts illustrative claims from code ([`src/commands/pseudo-claims.js:2565`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/pseudo-claims.js?plain=1#L2565)). It is a drafting feature and a self-test feed, not the front end of the claims pipeline. These are drafts, not findings ([`docs/CODEEXAM_PSEUDO_CLAIMS.md:1-12`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_PSEUDO_CLAIMS.md?plain=1#L1-L12)). `--triage` runs afterwards, on the drafted output ([`src/index.js:772`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L772)).

## Pseudo-claim loop script

<!-- read: docs/claims-pipeline-state.md#10. The loop test (pseudo-claim-loop, 2026-08-30) -->
`scripts/pseudo-claim-loop.mjs`: "synonymize, chart blind, score vs answer key" ([`scripts/pseudo-claim-loop.mjs:2`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/scripts/pseudo-claim-loop.mjs?plain=1#L2)). Every chart is a real `ce --claim-chart` run ([`scripts/pseudo-claim-loop.mjs:12-13`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/scripts/pseudo-claim-loop.mjs?plain=1#L12-L13)). `--no-syn` skips the rewrite ([`scripts/pseudo-claim-loop.mjs:19`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/scripts/pseudo-claim-loop.mjs?plain=1#L19)). A person launches it.

## Synonymize

<!-- read: docs/litigated-claims-ground-truth.md#A baseline self-test: "huffing our own fumes" (HOF) -->
`--synonymize` rewrites claim wording away from the code's vocabulary. It runs before any index exists, so it is "structurally incapable of reaching an index" ([`src/index.js:425-434`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L425-L434)).

## Loop score

`src/core/loop-score.js` scores the blind chart's sidecar against the drafted anchors ([`scripts/pseudo-claim-loop.mjs:12`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/scripts/pseudo-claim-loop.mjs?plain=1#L12)).

## Claims loop

<!-- read: docs/claims-pipeline-state.md#4. Huffing our own fumes (HOF) — the self-test sub-pipeline -->
`doClaimsLoop` needs a pseudo-claims chart and a ranked candidates list ([`src/commands/claims-loop.js:331-336`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claims-loop.js?plain=1#L331-L336)). It analyzes with the claim-analyze rubric and writes `<chart>_looped.md` ([`src/commands/claims-loop.js:14`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claims-loop.js?plain=1#L14)). It is "not a claim-charting command" ([`docs/claims-pipeline-state.md:31`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L31)).

## model extracts terms

`extractClaimTerms` ([`src/commands/claim.js:278`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim.js?plain=1#L278)).

## search, then analyze

See *Claim Analyze*: the CLI and GUI versions differ.

## deterministic split

`buildChartTable` calls the splitter ([`src/commands/claim-chart.js:500-505`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L500-L505)).

## agent supplies words

"Give 'words' as one numbered line per element" ([`src/mcp-server.js:421`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/mcp-server.js?plain=1#L421)).

## model predicts words

`draft(sys, user, VOCAB_MAX_OUTPUT_TOKENS)` ([`src/commands/claim-locate.js:871-874`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L871-L874)). The reviewer found that cloud chart runs make two such calls and merge them.

## rarity search, no quorum

`searchSymbolsByWords` ([`src/commands/claim-locate.js:1131`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L1131)). The difference from whole-claim retrieval is tabulated at [`docs/claims-pipeline-state.md:42`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L42).

## no targets given

`--targets` chooses the path: with it, parsed targets ([`src/commands/claim-chart.js:2255-2258`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L2255-L2258)); without it, `retrievePerElement` ([`src/commands/claim-chart.js:2283`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L2283)).

## per-element arm, CLI only

`doClaimAnalyze` merges a per-element arm by default ([`src/commands/analyze.js:2600`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/analyze.js?plain=1#L2600)). The GUI's Claim Analyze has none ([`public/app.js:1241-1250`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/app.js?plain=1#L1241-L1250)).

## model selects, verify, navigate

"Step 3: the model chooses among symbols that DEMONSTRABLY EXIST" ([`src/commands/claim-locate.js:2332`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L2332)).

## a person passes targets

`--targets-out` writes the file ([`src/commands/claim-locate.js:2663-2669`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L2663-L2669)). Nothing runs the chart afterwards: a person does.

## targets flag

`parseTargets` reads `file@function` lists inline or from a file ([`src/commands/claim-chart.js:559`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L559)).

## model fills cells

`analyseTargetForRows` makes the per-target call ([`src/commands/claim-chart.js:1963`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L1963)). Cloud spend passes `claimsCostGate` ([`src/core/llm-runner.js:440-444`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L440-L444); the guard is $2.00, [`src/core/llm-runner.js:289`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/llm-runner.js?plain=1#L289)).

## a person checks citations

The chart tells the reader: "Every citation should be verified against the source" ([`src/commands/claim-chart.js:1628-1629`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-chart.js?plain=1#L1628-L1629)). A `PRESENT` "does **not** necessarily mean the claim is infringed, valid, or correct" ([`docs/CODEEXAM_PATENT_CLAIMS.md:18-19`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_PATENT_CLAIMS.md?plain=1#L18-L19)).

## drafted from

`collectAnchorGroups` for explicit anchors ([`src/commands/pseudo-claims.js:2609`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/pseudo-claims.js?plain=1#L2609)).

## claims-only file

The loop script reads a run's claims-only file and its `.anchors.json` sidecar ([`scripts/pseudo-claim-loop.mjs:23`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/scripts/pseudo-claim-loop.mjs?plain=1#L23)).

## rewrites wording

The script runs `--synonymize` on each claim unless `--no-syn` is given ([`scripts/pseudo-claim-loop.mjs:9`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/scripts/pseudo-claim-loop.mjs?plain=1#L9)).

## blind chart

"Every chart is a real `ce --claim-chart` invocation" ([`scripts/pseudo-claim-loop.mjs:12-13`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/scripts/pseudo-claim-loop.mjs?plain=1#L12-L13)), with no `--targets`.

## sidecar vs anchors

Scored with `src/core/loop-score.js` ([`scripts/pseudo-claim-loop.mjs:12`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/scripts/pseudo-claim-loop.mjs?plain=1#L12)).

## pseudo chart plus ranked list

`--claims-loop <chart.md> --candidates <cand.lst>` ([`src/commands/claims-loop.js:335-336`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claims-loop.js?plain=1#L335-L336)). The list must carry ranking headers ([`src/commands/claims-loop.js:66-67`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claims-loop.js?plain=1#L66-L67)).
