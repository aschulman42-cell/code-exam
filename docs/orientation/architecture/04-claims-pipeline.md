# Claims pipeline: detail

Click-through detail for 04-claims-pipeline.mmd. Facts are as of commit `98abef1` (2026-11-02).
Solid arrows are what the code does on its own; dashed arrows happen only if a
person or agent does them.

## Claim text

Inline or `@file`. "`#` lines are PROVENANCE, not limitations" ([`src/commands/claim-locate.js:2079-2080`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L2079-L2080)).

## Claim Search

`doClaimSearch` ([`src/commands/claim.js:1224`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim.js?plain=1#L1224)). The GUI's Claims Workspace reaches it through `/api/claim-search-llm` ([`src/server.js:3731`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L3731)), which runs TIGHT and BROAD through multisect ([`src/server.js:3862`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L3862), [`src/server.js:3879`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/server.js?plain=1#L3879)). The pipeline notes record "the same quorum problem as `--claim-analyze`" ([`docs/claims-pipeline-state.md:29`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/claims-pipeline-state.md?plain=1#L29)).

## Element splitter

`splitClaimElements` ([`src/commands/claim-locate.js:256`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L256)). No model involved: "CodeExam's deterministic code owns the structure" ([`docs/CODEEXAM_PATENT_CLAIMS.md:47`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_PATENT_CLAIMS.md?plain=1#L47)). It is exposed to agents as the `claim_elements` tool ([`src/mcp-server.js:403-404`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/mcp-server.js?plain=1#L403-L404)).

## Vocabulary prediction

One model call predicts code words per element ([`src/commands/claim-locate.js:870-874`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L870-L874)). "The vocabulary step is the NARROWEST point in the pipeline: it fails closed" ([`src/commands/claim-locate.js:876-877`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L876-L877)).

## Per-element retrieval

`retrievePerElement` ([`src/commands/claim-locate.js:870`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L870)). It combines name search, `searchSymbolsByWords` ([`src/commands/claim-locate.js:1131`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L1131)), with content search, `contentCandidatesForWords` ([`src/commands/claim-locate.js:673`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L673)). The MCP tool `claim_candidates` gives agents the same retrieval with words they predict themselves ([`src/mcp-server.js:415-416`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/mcp-server.js?plain=1#L415-L416)).

## Claim Locate

`doClaimLocate` ([`src/commands/claim-locate.js:2075`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L2075)). Verifies proposed symbols against the index ([`src/core/symbol-verify.js:59`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/symbol-verify.js?plain=1#L59)) and navigates from them ([`src/core/symbol-verify.js:143`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/symbol-verify.js?plain=1#L143)).

## Claim Chart

`doClaimChart` ([`src/commands/claim-chart.js:2084`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L2084)), run with `--claim-chart` ([`src/index.js:1205-1208`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L1205-L1208)). This is the one-row-per-element chart. The GUI's Claims Workspace does other claim work, Claim Search and Claim Analyze ([`public/index.html:462-466`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/public/index.html?plain=1#L462-L466)), but `public/`, `src/server.js` and the REPL have no reference to this command at this commit.

## Verdicts and sidecar

Each cell is `PRESENT`, `PARTIAL`, `ASSUMED` or `ABSENT` ([`src/commands/claim-chart.js:827`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L827)). `--verdicts-out` writes the per-target record ([`src/commands/claim-chart.js:2616`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L2616)). The chart also reports whether its supporting code connects: "unconnected groups (no call path within…" ([`src/commands/claim-chart.js:1482-1483`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L1482-L1483)).

## Human examiner

"Treat every verdict as 'this code is a candidate match for a stated reading'" ([`docs/CODEEXAM_PATENT_CLAIMS.md:22-23`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_PATENT_CLAIMS.md?plain=1#L22-L23)).

## Pseudo-claims

`doPseudoClaims` drafts illustrative claims from a codebase ([`src/commands/pseudo-claims.js:2565`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/pseudo-claims.js?plain=1#L2565)). Candidate mechanisms come from `groupMechanisms` ([`src/commands/pseudo-claims.js:899`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/pseudo-claims.js?plain=1#L899)) and `rankCandidates` ([`src/commands/pseudo-claims.js:2375`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/pseudo-claims.js?plain=1#L2375)), with a deterministic triage ([`src/commands/pseudo-claims.js:2539`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/pseudo-claims.js?plain=1#L2539)). These are drafts, not findings ([`docs/CODEEXAM_PATENT_CLAIMS.md:94-104`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_PATENT_CLAIMS.md?plain=1#L94-L104)).

## Claims loop

`doClaimsLoop` needs a finished chart and its candidates list ([`src/commands/claims-loop.js:331-336`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claims-loop.js?plain=1#L331-L336)). Sponge detection lives here ([`src/commands/claims-loop.js:202`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claims-loop.js?plain=1#L202)) and is reused by the MCP server ([`src/mcp-server.js:41`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/mcp-server.js?plain=1#L41)).

## Synonymize

`--synonymize` rewrites claim wording away from the code's vocabulary. It runs before any index exists, so it is "structurally incapable of reaching an index" ([`src/index.js:425-434`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L425-L434)).

## model extracts terms

`extractClaimTerms` ([`src/commands/claim.js:278`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim.js?plain=1#L278), called at [`src/commands/claim.js:1442`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim.js?plain=1#L1442)).

## deterministic split

`buildChartTable` calls the splitter ([`src/commands/claim-chart.js:500-505`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L500-L505)).

## model predicts words

`draft(sys, user, VOCAB_MAX_OUTPUT_TOKENS)` ([`src/commands/claim-locate.js:871-874`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L871-L874)). Agents using MCP supply these words themselves ([`src/mcp-server.js:421`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/mcp-server.js?plain=1#L421)).

## rarity search, no quorum

`searchSymbolsByWords` ([`src/commands/claim-locate.js:1131`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L1131)); the difference from whole-claim retrieval is tabulated at [`docs/claims-pipeline-state.md:42`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/claims-pipeline-state.md?plain=1#L42).

## no targets given

`--targets` chooses the path: with it, parsed targets ([`src/commands/claim-chart.js:2255-2258`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L2255-L2258)); without it, `retrievePerElement` ([`src/commands/claim-chart.js:2283`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L2283)).

## verify and navigate

`doClaimLocate` calls `retrievePerElement` ([`src/commands/claim-locate.js:2271-2273`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L2271-L2273)), then applies `verifySymbol` and `navigateFrom` ([`src/core/symbol-verify.js:59`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/symbol-verify.js?plain=1#L59), [`src/core/symbol-verify.js:143`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/symbol-verify.js?plain=1#L143)).

## person passes targets

`--targets-out` writes the file ([`src/commands/claim-locate.js:2663-2669`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-locate.js?plain=1#L2663-L2669)). Nothing runs the chart afterwards; a person does.

## model fills cells

`analyseTargetForRows` makes the per-target call ([`src/commands/claim-chart.js:1963`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L1963)). Cloud spend passes `claimsCostGate` ([`src/core/llm-runner.js:440-444`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L440-L444); the guard is $2.00, [`src/core/llm-runner.js:289`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/core/llm-runner.js?plain=1#L289)).

## person checks citations

The chart itself tells the reader to: "Every citation should be verified against the source" ([`src/commands/claim-chart.js:1628-1629`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claim-chart.js?plain=1#L1628-L1629)). A `PRESENT` "does **not** necessarily mean the claim is infringed, valid, or correct" ([`docs/CODEEXAM_PATENT_CLAIMS.md:18-19`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/docs/CODEEXAM_PATENT_CLAIMS.md?plain=1#L18-L19)).

## person runs the chart

`--claims-loop <chart.md> --candidates <cand.lst>` ([`src/commands/claims-loop.js:335-336`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/commands/claims-loop.js?plain=1#L335-L336)).

## person runs a rewrite

`--synonymize` is its own command, with its own dispatch ([`src/index.js:431-435`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L431-L435)).

## rewritten claim re-run

The design intent is that a rewritten claim goes back through the claim commands; the mechanism is described in the comment at [`src/index.js:425-430`](https://github.com/aschulman42-cell/code-exam/blob/98abef1af7f3518a91d834a20f892bd447114908/src/index.js?plain=1#L425-L430).
