# CodeExam: overview

CodeExam is a tool for examining code as it is, built around a deterministic index, with an optional AI layer and a claim-analysis pipeline. It grew from "several decades of experience as a source-code examiner in litigation" ([`README.md:18-20`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/README.md?plain=1#L18-L20)). It lives at [github.com/aschulman42-cell/code-exam](https://github.com/aschulman42-cell/code-exam) and is Apache 2.0 ([`LICENSE:1-2`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/LICENSE?plain=1#L1-L2)), copyright Andrew Schulman ([`NOTICE:2`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/NOTICE?plain=1#L2)).

This overview is a reader's map, not part of the project. It was written with Bram on 2026-11-02, reading the repository as of commit `f9756fe`. Every claim cites a file and line. Where the repo is silent, this says so rather than guessing. The **Diagrams** page has diagrams with click-through detail; where a doc explains a box, its detail links to that doc section at the pin.

## What it is

- **One engine.** `CodeSearchIndex` builds, saves, loads and searches an index ([`docs/CODEEXAM_ARCHITECTURE.md:57-60`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L57-L60)). It is "**deterministic**: the same index and the same command produce the same answer, with no AI model in the basic loop" ([`README.md:31-32`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/README.md?plain=1#L31-L32)).
- **One on-disk format.** "A directory of plain-JSON files built once from a codebase" ([`docs/CODEEXAM_INDEXES.md:3-4`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_INDEXES.md?plain=1#L3-L4)).
- **Four front-ends.** A CLI, its REPL, a GUI served on localhost, and an MCP server ([`README.md:39-43`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/README.md?plain=1#L39-L43)).
- **An optional AI layer.** Models "only ever touch *output*, never the index or the core results" ([`README.md:33-37`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/README.md?plain=1#L33-L37)). The entry points are listed in one place ([`docs/AI_ASSISTED_CODE_EXAM.md:21-36`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/AI_ASSISTED_CODE_EXAM.md?plain=1#L21-L36)).
- **A claims pipeline.** From claim text to a claim chart, where "CodeExam's deterministic code owns the structure" and a model fills the cells ([`docs/CODEEXAM_PATENT_CLAIMS.md:47-49`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_PATENT_CLAIMS.md?plain=1#L47-L49)).

## How it runs

- **Requirements.** Node 18 or later ([`package.json:11-13`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/package.json?plain=1#L11-L13)).
- **Build an index.** `node src/index.js --build-index /path/to/codebase --index-path .myindex` ([`docs/CODEEXAM_INDEXES.md:14`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_INDEXES.md?plain=1#L14)).
- **Start the GUI.** `node src/server.js --index-path .myindex --port 3000` ([`docs/GETTING_STARTED.md:50`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/GETTING_STARTED.md?plain=1#L50)), or `ce --gui --index-path .myindex` ([`docs/GETTING_STARTED.md:60`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/GETTING_STARTED.md?plain=1#L60)).
- **Start the MCP server.** `node src/mcp-server.js`, as a child process of an MCP client ([`docs/CODEEXAM_MCP.md:21`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_MCP.md?plain=1#L21)).
- **Test.** `npm test` runs node's built-in test runner ([`docs/CODEEXAM_TESTING.md:13`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_TESTING.md?plain=1#L13)).

There is no deployment step in the repo: it runs from a checkout on the examiner's machine. Air-gapped use is a first-class mode ([`docs/AIR_GAPPED.md:1-5`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/AIR_GAPPED.md?plain=1#L1-L5)).

## Where to start reading

1. **`docs/CODEEXAM_ARCHITECTURE.md`**: the shape of the system ([`docs/CODEEXAM_ARCHITECTURE.md:10-22`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_ARCHITECTURE.md?plain=1#L10-L22)).
2. **`docs/source-map.md`**: a one-line description of every first-party file ([`docs/source-map.md:1-6`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/source-map.md?plain=1#L1-L6)). It is machine-read, so it tends to stay accurate ([`docs/source-map.md:7-11`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/source-map.md?plain=1#L7-L11)).
3. **`src/index.js`**: read the dispatch from about [`src/index.js:1185-1222`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L1185-L1222) to see how commands fan out.
4. **`src/core/multisect.js`**: a small, self-contained example of the engine's style ([`src/core/multisect.js:145-149`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L145-L149)).
5. **`docs/claims-pipeline-state.md`**: if you care about claims, the most candid status document in the repo ([`docs/claims-pipeline-state.md:24-28`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L24-L28)).

## Open questions

Sorted by importance first, then by how hard each is to act on. These rankings are judgment calls, not the repo's: importance is weighted toward CodeExam's mission, claim-to-code accuracy, and effort is a rough estimate from reading the code. They should be argued with.

### 1. Most important, and hard

These are the questions the project's value rests on. None has a quick fix, because each needs better evidence rather than more code.

- **How well does the claim pipeline connect technical prose to code?** The most encouraging number needs care: paraphrased claims "reached" their anchors 99–100% of the time, but "**Function-level recall is 5–8%**", because retrieval mostly finds the right class or file ([`docs/claims-pipeline-state.md:383-387`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L383-L387)). That is useful as a lead and "not a citation". The key is also only what the drafting model cited, "not evidence that the anchors are the *right* code for the limitation" ([`docs/claims-pipeline-state.md:417-422`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L417-L422)).
- **Is there any trustworthy ground truth?** The repo says plainly that there is "No verified claim-to-code ground-truth pair": litigation records name a product, not a public codebase ([`docs/litigated-claims-ground-truth.md:148-150`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/litigated-claims-ground-truth.md?plain=1#L148-L150)). Everything else is a stand-in: synthetic pairs, screening candidates, and negative controls, which so far have a first chart scoring 4/4 ABSENT ([`docs/litigated-claims-ground-truth.md:108-112`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/litigated-claims-ground-truth.md?plain=1#L108-L112)).
- **How good are pseudo-claims, compared with real patent claims?** Structure is measured against ~385 litigated patents ([`docs/litigated-claims-ground-truth.md:46-48`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/litigated-claims-ground-truth.md?plain=1#L46-L48)), and `--claim-schema` draws its frame from them, but that is experimental ([`src/argparse.js:411`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/argparse.js?plain=1#L411)). Matching the shape of a claim doesn't show that the substance is any good. Hand rubrics to score that are still being developed ([`docs/CODEEXAM_PSEUDO_CLAIMS.md:137-141`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_PSEUDO_CLAIMS.md?plain=1#L137-L141)).
- **Do the results hold beyond a handful of examples?** "`n` is the column that matters. Most of what we believe is one sample" ([`docs/claims-pipeline-state.md:277`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L277)). The scale-up is a stated next step: reproduce the reference numbers, "then run the loop at scale" ([`docs/claims-pipeline-state.md:456`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L456)). Run-to-run noise complicates it: "Temp-0 runs are not reproducible across days" ([`docs/claims-pipeline-state.md:457-458`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L457-L458)).

### 2. Important, and within reach

The design is mostly known here, and the work is engineering.

- **Which claim work belongs in the GUI?** The Claims Workspace runs Claim Search and Claim Analyze, and pasted claims work as search input ([`public/index.html:462-466`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/index.html?plain=1#L462-L466)). Claim Analyze extracts terms, searches, then analyzes the top function against the claim ([`public/app.js:1241-1250`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/public/app.js?plain=1#L1241-L1250)). The one-row-per-element chart from `--claim-chart` is the narrower gap: nothing in `public/` or `src/server.js` refers to it at this commit. Effort: moderate, mostly how to present a long-running job.
- **Can retrieval find functions whose names don't describe them?** Name search can't reach them, which is why content search exists alongside it ([`src/commands/claim-locate.js:673`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/commands/claim-locate.js?plain=1#L673)). Measuring the gain is mostly a matter of running the existing scorecard ([`docs/claims-pipeline-state.md:424-431`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L424-L431)). Effort: moderate.
- **What should the next UI be?** #354 names UI/presentation as the priority, #38 holds the mini-app vision, and #73 and #276 cover XMLUI. The repo doesn't record a decision. The decision is small; the work behind it is not.

### 3. Quick wins

Small, and worth doing because they stop readers being misled.

- **The HOF status table is behind the code.** §4 says HOF-b is "not built" ([`docs/claims-pipeline-state.md:179`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L179)), while §10 runs `--synonymize` in the loop ([`docs/claims-pipeline-state.md:424-431`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/claims-pipeline-state.md?plain=1#L424-L431)) and `src/commands/synonymize.js` exists. Effort: minutes.
- **`--mcp` is claimed but not there.** The header of `src/index.js` says it handles `--mcp` ([`src/index.js:2`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/index.js?plain=1#L2)), but neither `src/index.js` nor `src/argparse.js` has such a flag. The fix is one comment, unless the flag was meant to exist. Effort: minutes.

### 4. Lower priority

Real, but they can wait.

- **Multisect and the inverted index.** Multisect scans lines rather than using the inverted index ([`src/core/multisect.js:204-208`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/src/core/multisect.js?plain=1#L204-L208)). The repo doesn't say whether that's deliberate. It matters for speed on large indexes, not for accuracy.
- **The default index name.** The docs ask whether to retire `.code_search_index` ([`docs/CODEEXAM_INDEXES.md:22-23`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/CODEEXAM_INDEXES.md?plain=1#L22-L23)). Easy to do, and little depends on it.

### This map's limits

It was written from the source and docs, and nothing was run. Line-level facts are checked, but they are "as of" `f9756fe`. A six-diagram review found errors and omissions not yet fixed; see [`diagram-review-2026-11-02.md`](https://github.com/aschulman42-cell/code-exam/blob/f9756feb01d1b952606991d214098dfe16b16f79/docs/orientation/diagram-review-2026-11-02.md). Issue statuses were read on 2026-11-02. Local files outside git (`.bram.json`, `.mcp.json`, `start.sh`) are not part of the project and are not described.
