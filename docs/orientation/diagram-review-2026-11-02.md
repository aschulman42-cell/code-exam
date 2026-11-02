# Orientation site: diagram review, 2026-11-02

A review of the six diagrams in this site, as committed at `0554d49`, against the source pinned at
`98abef1`. Six read-only subagents each reviewed one diagram and its detail file. They ran nothing:
every finding comes from reading code and docs. Written by Claude Opus 5.5 in Bram 0.8.2.

**None of these findings has been applied to the site yet.** Until they are, the diagrams still
contain the errors listed here. The reports are model output, so check a finding against the code
before relying on it. In the combined report, ✓ marks findings the main session verified against the
code. Everything else is a reviewer's report that the main session did not separately verify. Paths
are relative to the repo root.

The queue notes referred to below are in [`queue.md`](queue.md).

## Combined report

The site's main weakness is the one Andrew's note predicted: **most diagrams show one true path as if
it were the only one.** Almost every citation holds up. The serious errors are in what the diagrams
imply.

### Fix first: air-gap (Configuration)

This is where overstating does the most harm.

- ✓ **The diagram makes the guard look always on.** It applies only with `--air-gapped`
  (`src/server.js:230`), and no arrow shows that.
- **Most cloud calls don't go through the LLM runner,** so "blocks before the network → runner" is
  the wrong picture. Chat, Overview by AI and several direct callers have their own guards. The
  reviewer found every network call site guarded by its caller.
- **"Keys scrubbed" is overstated.** Only environment variables are scrubbed; key files and
  `--api-key` aren't. No leak was found, but the backstop is weaker than `docs/AIR_GAPPED.md:27` says,
  and the site repeated that claim.
- ✓ **`--host` doesn't work through `ce --gui`.** It's hardcoded to loopback (`src/index.js:250`).

### Possible CE bugs

These are in CodeExam itself, not the site.

1. ✓ **`node src/server.js --air_gapped` is silently ignored.** The server matches only `--air-gapped`
   exactly and drops unknown flags (`src/server.js:182`, `:190`). Only `ce --gui` normalizes the
   underscore. Someone would believe they're protected when they aren't.
2. ✓ **The connectivity probe tests one host:** a single TCP connect to `api.anthropic.com:443`
   (`src/core/air-gapped.js:86`). The code warns that a clean result doesn't prove isolation.
3. ✓ **The standalone MCP server has no air-gap handling** (0 mentions in `src/mcp-server.js`). It
   makes no LLM calls itself, but its output goes to whatever client attaches.
4. ✓ **Chat renders remote images and the GUI sets no CSP** (`public/menu-bar.js:182`). Model output
   could trigger a browser fetch outside every guard. Not tested.
5. ✓ **`--gemini-key` isn't masked** in the provenance command line (`src/core/provenance.js:88`).
6. **Silent search misses:** the inverted index drops lines under 4 characters ✓ and, per the
   reviewer, lines found in more than 50 files. GUI regex uses that index ✓, so it can miss hits, and
   that matters for claims of absence.
7. **A rebuild may serve a stale `vocabulary.json`,** since its check is version plus file count. Not
   tested.
8. **Doc drift:** `docs/CODEEXAM_SEARCHING.md:17` says "token index," but the keys are whole lines ✓.
   Several docs still claim a `--mcp` flag.

### The queue notes

| Note | Answer |
|---|---|
| Pseudo-claims as front end? | **Andrew's right.** It's a separate drafting feature and self-test feed. Explicit `file@func` anchors never touch `groupMechanisms` |
| No MCP for GGUF? | Half shown. Tool calls are in-process, but the diagram doesn't show how local differs from cloud, and cloud Overview does use stdio MCP |
| GGUF-specific prompting? | **Missing entirely** |
| Routes into Chat | **Missing:** Overview's Ask in Chat only prefills the box, and `--ask-ai` has no box. Chat runner's location is right, but it isn't the only model path |
| IDF only under multi-term? | **Correct:** multi-term is multisect, and literal and inverted results have no score. But MCP multisect skips IDF, and "Ranked result" is wrong for those branches |
| Index build too simple? | **Yes.** Use about 10 boxes: one per decision that changes what lands in the index, with flags and thresholds in the detail text |
| Air-gapped review | See the air-gap section above |
| Glossary tab, compare with CE's Overview | Not in the reviewers' scope, so still open |

### Other errors, by diagram

- **System:** LLM use is drawn only from command modules, but `src/server.js` calls models directly ✓.
  The diagram also hides that the "MCP server" is an internal library used in-process.
- **GUI and agents:** the "masked results from" arrow to IndexManager is wrong. `src/mcp-server.js`
  never imports it ✓; the server pushes the index in through `setIndex` ✓. Also missing: Overview by
  AI and the Console's `/api/exec`, which bypasses `handleTool` and so its credential mask.
- **Query flow:** "Inverted lookup" actually regex-tests every key. Callees never touch the inverted
  index, and callers don't use `searchInverted`.
- **Claims:** `--claim-analyze` is missing, and it differs between CLI and GUI.
  `pseudo-claim-loop.mjs` automates what the diagram draws as person-run steps. `--claims-loop`
  doesn't run the chart. The GUI's route doesn't reach `doClaimSearch`, which the site's detail text
  claims.
- **Citations:** about a dozen are weak or mis-aimed, and none is false.

### Suggested redraw principle

Show every route into a box, and make "one of several" visible.

## Reviewer reports

The six reports, word for word. One line of the "GUI and agents" report refers to "the brief": the
instructions its reviewer was given.

### 1. System at a glance

Review of `01-system.mmd` and `01-system.md`. Paths are relative to /Users/jonudell/code-exam. All findings come from reading the code, except where marked unverified.

**1. ERRORS**
1. **"commands -->|only on AI commands| llm" is the only LLM arrow, and that is wrong.** `src/server.js` has its own LLM client and calls models directly:
   - `callClaude` at 396, `serverLLM.call` at 3817 and 4025 (claim-search-llm, analyze-llm)
   - Chat loops at 4189-4208 and 4268-4286
   - `runAiOverview` at 2702, `draftCloud` at 2815
   - `src/index.js:617,651` runs Overview by AI directly, with no command module.
2. **"gui -->|route handlers| engine" is mostly true but overstated.**
   - `/api/exec` (4078-4101) calls `execCommand` from `src/commands/interactive.js:1310`, and the GUI console uses it (`public/console.js:254-256`).
   - Routes also use `commands/` code: `server.js:54,58-60,65-76`.
3. **"cli -->|dispatches one command| commands" is incomplete.** The CLI calls the engine directly, including the main build: `src/index.js:851`, also 990, 1244, 1264, 1292. "One" is also loose: the `if` blocks don't exit (1205-1212), and 1145 says "2+ run together".
4. **"mcp -->|handleTool| engine" has an exception.** `call_tree` runs `doCallTree` (`src/mcp-server.js:37,1307`), and handlers use other command helpers (lines 32-41).

**2. OMISSIONS**
1. **The MCP layer is also an internal library, and the "AI clients" box doesn't show it (notes 1, 7).**
   - The server imports `handleTool` (`server.js:30`); the `mcp-server.js:1457` guard skips `main()` on import.
   - GGUF and in-app Chat call it in-process, with no MCP protocol: `chat-runner.js:30,239,524`, `ai-overview-local.js:12,686`.
   - Cloud Overview spawns the MCP server over stdio (`ai-overview.js:14-15,185`).
   - A newcomer would assume MCP means external clients only.
2. **Chat runner and Overview by AI are missing.** `--ask-ai` goes `src/index.js:547` → `commands/ask.js` → `chat-runner.js`, the same loops as GUI Chat (`server.js:49`). The runner is shared by the CLI and GUI.
3. **`--air-gapped` is missing.** It is set at `index.js:391` and `server.js:230`, and forwarded by `--gui` (`index.js:184`). `mcp-server.js` has no air-gap code, so what an external client does with results is outside the guard (the last part is unverified).
4. **`--multi-index` is missing.** It re-spawns the CLI per index (`index.js:525`), including under `--overview-by-ai` (555).
5. **GUI build runs on a worker thread:** `server.js:1856`, `build-worker.js:59`.
6. **The "On-disk index" tip is too narrow (note 2).** A `.zip` index also works (`archive.js:1129`, `ask.js:100`). A few commands use no index (`docs/CODEEXAM_INDEXES.md:4-7`, `index.js:437,442`). The citation stops just before that caveat.

**3. SUGGESTIONS** (keep about 11 boxes)
- Add a box "Tool router (TOOLS/handleTool)": `mcp` → router → engine.
- Add a box "AI runners (chat-runner, ai-overview, llm-runner)", then arrows `commands`, `gui`, `cli` → runners → `llm`.
- Add runners → router, labelled "in-process; cloud overview spawns MCP over stdio".
- Add `cli` → `engine` ("build, some inline commands") and `gui` → `commands` ("/api/exec, shared helpers").
- Add a guard note on the LLM arrow: "--air-gapped blocks cloud; local GGUF stays".
- Relabel "dispatches one command" as "if-chain dispatch".
- Reword the `.md` to say "mostly" for the route and handleTool claims.
- The LLM tip could mention a localhost endpoint (`CLAIM_SEARCH_API_URL`, `air-gapped.js:42`).

**4. BAD CITATIONS**
- **route handlers:** `server.js:4078-4080` is `/api/exec`, the route that goes to command modules. It contradicts the arrow. Use a direct-engine route instead.
- **only on AI commands:** `llm-runner.js:63-70` shows model selection, not "only for commands that need one". Also, `ask.js`, Overview and the server's own client resolve engines without it.
- All other citations I checked match their claims.
- Related stale docs, which the site doesn't repeat: `CODEEXAM_ARCHITECTURE.md:36,120` and `source-map.md:26` say the CLI handles `--mcp`. No such flag exists in `src/index.js` or `src/argparse.js`.

**5. VERIFIED**
- **Front-ends:** there are exactly four. The REPL's `doInteractive` is reached only via `--interactive` (1390); the no-command path does not enter it (1397).
- **GUI server:** plain `http` (4346), `--gui` via `import` (333).
- **MCP:** no LLM calls in `src/mcp-server.js`; lazy load (1448-1453); credential masking at the single `handleTool` seam (1425-1436). `claim_candidates` leaves the model step to the client (535, comment only, not traced).
- **Line citations:** `CodeSearchIndex.js:3459`, `:210-211`; `multisect.js:818`; `api.js:41`.
- **Engine:** no LLM imports in `CodeSearchIndex.js`. `mechanism-grouper` is deterministic; `mechanism-ranker` uses LLM via `makeDrafter` but is `core/`, not a command (only its comment read, caller unverified).
- **REPL "same do handlers":** true for the handlers it imports, but only `doClaimSearch` from the claims family, and no `--ask-ai` or Overview by AI. The `.md` caveat is correct.

No confirmed factual errors in the `%% tip:` text beyond the `.zip` narrowing.

### 2. Index build

Review of 02-index-build. Paths are under /Users/jonudell/code-exam. CSI = src/core/CodeSearchIndex.js.

**1. ERRORS**
- "tree-sitter or regex" (arrow): misleading. It is per-file hybrid: regex runs on every file (CSI:3276) and merges with tree-sitter (3289). Only `--regex-parser` is either/or.
- "a person rebuilds": the first build is dashed too. Say "a person runs a build". There is also a GUI **Rebuild** button (public/dialogs.js:238, directory sources only).
- `worker --> walk` is solid with no input, so the Build dialog (a person) is invisible. It needs a dashed arrow in.
- "runs the same buildIndex": same function, fewer options. The worker never passes splitBundle, demanglerPath or renameMinLines (build-worker.js:59-64; CLI at src/index.js:851-858).
- "writes lines to files": reads as a file write. It maps each line to its files.
- "Required, per `validateIndex`": no caller exists in src, test, public or scripts. Load hard-requires only literal_index.json; the other two only warn (src/server.js:1770-1786).

**2. OMISSIONS** (ranked)
1. Triage at CSI:3598-3624 sends files to four fates. Media is skipped; 7z/rar are skipped.
2. Phase order: source files (3714), archives (3738), binaries (3783). Prettify and dedup come first, and all downstream stages read the in-memory result.
3. Archives: nested to depth 5 (archive.js:34, 448); virtual paths `a.zip!src/x.js` (:539). .jar/.war/.ear/.apk are zip-format; .har expands by mime and URL (:719).
4. Minified JS/CSS-named files: `deobfuscateSimple`, then webcrack (500KB limit), then js-beautify (CSI:3683-3711). Stored lines are therefore not the original bytes, which matters for line citations. CSS also passes the gate (unverified: effect on CSS).
5. Dedup: SHA1; copies are recorded in `file_hashes` but not indexed (3652-3663).
6. `--split-bundle`: opt-in, CLI-only; .js/.mjs/.cjs of 10,000+ lines; creates `orig::mod.js` virtuals, deletes the original (3835-3926).
7. Inverted index drops lines under 4 chars (2552) and lines in more than 50 files (`maxFileFrequency`, 2597). The doc cites 50 but never says this loses search hits.
8. Extension filtering happens only in `_walkDir` (4053) and archives. @list, glob and single-file inputs get none (3622).
9. Skipped census: archive skips persist as `skipped_extensions` (2398); loose files are a live scan (extension-census.js). HAR filtered entries are not counted (archive.js:771).
10. Index zip vs source zip: `--index-path x.zip` is extracted to a temp cache (CSI:164, archive.js:1129) and bypasses the build. Queue #7's "huh" item.
11. Index files:
- import_map.json: during build, only if non-empty (rename.js:366-373).
- func_hashes.json: lazy, deleted by every function-index build (CSI:3345, 5641).
- vocabulary.json: lazy; its freshness check is version plus file count only, and buildIndex never deletes it (vocabulary.js:358). So a same-count rebuild may serve a stale vocabulary (unverified by running).
- string_table.json: recreated on demand if missing (CSI:2299).
- fingerprints/: via build_fp_renames.
12. src/extractors/bun.js is not in the build; only the `--extract-js-from-binary` and `--inspect-binary` commands use it.
13. Partial rebuilds exist, all person-run: `--rebuild-functions`, `--build-rename-map`, `/rebuild-functions`.

**3. SUGGESTIONS** (queue #2: "what granularity?")
Yes, it is too simple. Use one box per decision that changes what lands in the index; flags and thresholds go in the .md. About 10 boxes:

Source → Triage → {Text files; Archive expansion (zip/tar/gz/har, nested); Binaries → .op; Skipped + census} → Prettify → SHA1 dedup → (dashed) Split bundle → in-memory lines → the five files, in code order.

- Add a dashed "lazy caches" box (func_hashes, vocabulary) and a side path "index .zip → temp cache → load".
- Draw `functions --> strings`, since strings need function bounds (CSI:2209, 2223).
- Add import_map beside rename_map.

Other queue notes do not bear on this diagram.

**4. BAD CITATIONS**
- src/archive.js:434 "bomb guards": that is the function signature. Cite :37, :263, :448.
- CSI:3215-3226 "regex is the fallback": covers only parser-init failure. Per-file logic is 3268-3306.
- `validateIndex` citation: see section 1.
- The quote at CODEEXAM_INDEXES.md:17-18 alters the capitalization of "A"; trivial.

**5. VERIFIED**
- Keys are whole normalized lines; case is kept (2534-2536).
- Build order: literal, inverted, function, rename, strings, literal (3947-3985).
- No `fs.watch`, watchFile or chokidar in src or public (excluding vendored mermaid). Nothing rebuilds from source automatically, and I found no GUI staleness detection (grep-based).
- Tree-sitter default (argparse.js:140).
- Display-time rename comment; streamed inverted index; `SKIP_DIRS` cite; other line cites.

### 3. Query flow

Review of 03-query-flow, read against the working tree.

**Queue note 4 (the only note that bears directly):** The placement is correct. The note's hedge is not: "multi-term" IS the multisect scan, and it is the only arrow in. Literal and inverted results carry `score: 0.0` (CodeSearchIndex.js:4216, 4279). IDF compares terms using Phase 1 file counts, so it exists only for multisect.

**1. ERRORS**
1. "Ranked result" is the sink for literal and inverted, but those aren't ranked: file or index order, score 0.0.
2. "`--search` and `--regex` reach `searchLiteral`" is CLI-only. The GUI sends regex AND fast to `searchInverted` (server.js:2426-2427; menu at public/menu-bar.js:411). So GUI regex has the index's blind spots (omission 1).
3. "Inverted lookup" isn't a lookup. Keys are whole normalized lines (CodeSearchIndex.js:2534, 2552), and `searchInverted` regex-tests every key (:4259-4260). docs/CODEEXAM_SEARCHING.md:17 "token index" is also wrong.
4. `calls` → `inverted` → "matching lines" → result misrepresents the call graph:
   - Callers bypass `searchInverted`; they use `forEachInvertedEntry` plus four call patterns and many filters (calls.js:438 onward).
   - Callees never touch the inverted index: masked `fileLines` body, regex, `_resolveCalleeTarget` (calls.js:553-600). They have no route to a result.
5. "tests each term's regex against every line of every file": it breaks at the first hit per term/file (multisect.js:231-237), then tests the path. Phase 2 is the full line walk.
6. "weighted terms, then terms matched, then IDF": omits that the "IDF" score is multiplied by density (commands/multisect.js:191), and folders have no weighted key (:497-500). Core's tiebreak after terms_matched is shorter `lines` (core/multisect.js:566), so density isn't core's, but size is.

**2. OMISSIONS**
1. The inverted index drops lines found in more than 50 files and lines under 4 characters (CodeSearchIndex.js:2553, 2556, default at :3955). So `--fast`, GUI regex and callers can silently miss hits. This matters most for "absence" claims.
2. MCP: multisect_search returns core order with no IDF or density, and only function and file scopes (mcp-server.js:730-748). It also defaults to 80% of terms. "CLI and GUI rerank" is accurate, but no MCP arrow bypasses IDF. MCP has no fast path (:698, :712).
3. Rename expansion: `--search`, `--literal`, `--fast` expand; expanded `--fast` falls back to `searchLiteral` (search.js:305-315). `--search` goes through `searchHybrid`, literal only (:247; CodeSearchIndex.js:4309). Multisect has `--match-renames`.
4. There is no CLI default mode: each flag dispatches separately (index.js:1023-1026). Bare REPL text runs `doSearch` (interactive.js:1246); GUI default is literal (server.js:2412). `--literal` is unlabeled.
5. Missing families: call tree (graph.js: `findCallers` up, `findCallees` down, `getCallCounts`), digest, vocabulary, struct_dupes, `--files-search`/`--folders-search` (`searchLiteral` hit counts, search.js:365-414). `regex_search` is covered only by the `searchLiteral` box.

**3. SUGGESTIONS**
- Rename the sink "Result"; label IDF's output "ranked scopes".
- Rename "Inverted lookup" to "Inverted line-index scan"; tip: "skips lines in >50 files".
- Split the arrows: `search, literal, regex (CLI, MCP)`; `fast, GUI regex`.
- Split Call graph: callers → inverted; callees → file lines; both → result.
- Add `scopes -->|MCP: no rerank| result`.
- Add a "context lines" label on the inverted arrow too, or drop it. Inverted also returns context, fixed at ±3, ignoring `--context` (CodeSearchIndex.js:4269-4270; search.js:317).

**4. BAD CITATIONS**
- `search.js:273` is `doLiteral`. Use :247 and :347.
- `CODEEXAM_MCP.md:66` describes MCP `search`, which is `searchLiteral`, not inverted. Use CodeSearchIndex.js:4276-4281.
- `core/multisect.js:204-208` only declares sets. Use :221-237.
- `search.js:317` cited for "literal, fast and regex" is the fast line only.
- `server.js:2427` is the inverted branch only. Use :2426-2429.
- `commands/multisect.js:482-501` is CLI-only; the GUI sort is :314-323.

**5. VERIFIED**
- Multisect doesn't use the inverted index: no mention in either multisect file; Phase 1 and 2 use `fileLines`.
- `findCallers` requires it (calls.js:330); `findCallees` needs the function index (:554).
- `receiver` option (calls.js:64).
- Core sort is `weighted_terms` first (:563-568).
- IDF lives in commands/ (commands/multisect.js:152, 176).
- CLI (:439) and GUI (server.js:4063, :256-258) rerank.
- MCP `core` call at mcp-server.js:730.
- `contextLines` default 3.
- Other cited ranges support their claims.

Unverified: I inferred that a common call line in more than 50 files is missed by callers. This comes from the code, not a test run. I also did not trace vocabulary or struct_dupes internals, only their MCP entry points. Notes 2 and 7 bear only loosely: granularity, and the GUI regex route is an example of a "huh" route.

### 4. Claims pipeline

Review of 04-claims-pipeline.mmd and .md. Nothing was run; findings come from reading the code. All paths are under /Users/jonudell/code-exam.

**Verdict on queue note 6: substantiated.** Pseudo-claims is not the pipeline's front end. It is a separate drafting feature and a self-test feed (docs/CODEEXAM_PSEUDO_CLAIMS.md:630-657). The real input is a patent claim. Notes 1-5, 7 and 8 don't bear on this diagram.

**1. ERRORS**
1. "Candidate mechanisms come from `groupMechanisms`... and `rankCandidates`... with a deterministic triage."
   - Explicit anchors never touch the grouper: `file@func;...` or `@anchors.lst` goes through `collectAnchorGroups` (pseudo-claims.js:2609).
   - `groupMechanisms` runs only on `--candidates` or `--filter` (2581-2606).
   - `--rank` and `--ground-truth` return without drafting (2575). The ranker is "observe-only" and writes an annotated list (2346, 2390).
   - `--triage` runs after drafting, on the sidecar, with no index (index.js:772; pseudo-claims.js:2517-2539).
2. "person runs the chart" (pseudo to loop) suggests `--claim-chart`. The loop needs a `--pseudo-claims` artifact with `## Pseudo-claim N — LABEL (Pn)` headers (claims-loop.js parseChartClaims, ~line 50) and a ranked list with `[P` headers (`parseCandidateGroups`, ~line 66).
   - So unranked or hand-labelled lists yield no claims or no members (unverified, not run).
   - The loop calls no chart, Locate or per-element code. It uses `buildClaimAnalyzePrompt` plus whole-claim multisect (retrievalPass), and writes `<chart>_looped.md`.
   - docs/claims-pipeline-state.md:31: "not a claim-charting command".
3. "It combines name search... with content search" holds for the chart only. Locate (claim-locate.js:2273) and `--claim-analyze` (analyze.js:2600) pass no `index`, and `candidatesForElement` returns before the content arm (claim-locate.js:802).
4. "reaches it through `/api/claim-search-llm`" is wrong. `doClaimSearch` is called by the CLI and REPL (interactive.js:1019), never by server.js, whose route reimplements the flow using `extractClaimTerms`.
5. "One model call predicts code words" is wrong for cloud chart runs: two calls (claim-chart.js, `vocabRuns`, ~2279; claim-locate.js:904).

**2. OMISSIONS**
1. **Pseudo to chart, no synonymize.** `--claims-only` feeds `--claim-chart`, and `--no-syn` skips rewriting (pseudo-claim-loop.mjs). The diagram forces every pseudo-claim through Synonymize or the loop.
2. **pseudo-claim-loop.mjs.** It spawns `--synonymize`, then `--claim-chart`, then scores against the `.anchors.json` sidecar (loop-score.js). So the dashed synonymize arrows are scriptable, though a person launches the script. It reads already-drafted, hand-picked claims and never calls `--claims-loop`; no script does. recap-chart-drafter-ceiling.mjs:548 also scripts drafting. The scoring is the point of the route and is absent.
3. **`--claim-analyze`.** `doClaimAnalyze` (analyze.js:2079) runs whole-claim search and also, by default, merges a per-element arm (2467, 2600; off with `--no-per-element`). The GUI's Claim Analyze differs: it analyzes one top function, with no per-element arm (app.js:1241-1262). state.md:30 is stale on this.
4. **Hand-supplied inputs**, the same over-generalization as note 6. `--targets` accepts any list, not only Locate's output (docs/CODEEXAM_CLAIM_CHARTS.md:133). `--elements` bypasses the splitter (claim-chart.js:502).
5. **Chart target arms.** Concentration, drilldown and whole-claim arms (claim-chart.js:437, 2398, 2417) run only without `--targets`. The whole-claim arm is model-free and has no quorum (1933), so it is not Claim Search.
6. **Claim scope.** `--claim-number` and `--claim-family` (2125) set which claims are charted. The sidecar gets a family block. `--dep-synonyms` is off by default (~2201).
7. **Locate's Step 3 model selection** (claim-locate.js:2332) sits between retrieval and verify. `--hunt` and `--propose-from-priors` bypass retrieval (2123, ~2204). `--runs` unions results.
8. **MCP.** The .md covers it fairly, but the diagram doesn't: agents supply the words, and the path stops before any chart (mcp-server.js:665).

**3. SUGGESTIONS**
- Split the diagram into a main path and a "Self-test and drafting" subgraph.
- Add an input box to Pseudo-claims: "Anchors: your file@func list, or --candidates (grouper), optional --rank".
- Add an arrow `pseudo -.->|--claims-only| chart`, and a Score box after the chart.
- Relabel the loop arrow "ranked .lst + pseudo chart". Add an output "_looped.md", and make clear it doesn't feed Claim Chart.
- Add a Claim Analyze box fed by both Claim Search's terms and Per-element retrieval. Tip: "GUI: top function only".
- Add a dashed "Your own targets" arrow into chart.
- Relabel the retrieval-to-locate arrow "model selects, verify, navigate".
- Tip on chart: "adds concentration, drilldown, whole-claim arms".
- Move triage to a box after drafting.

**4. BAD CITATIONS**
- pseudo-claims.js:2375 and :2539 are accurate lines but don't support the "candidate mechanisms" claim (see error 1).
- src/server.js:3731: the route exists, but it doesn't reach `doClaimSearch`.
- src/index.js:425-430 for "rewritten claim re-run": the comment says only "later be searched against". pseudo-claim-loop.mjs is the better evidence.
- claim-locate.js:870-874 "One model call": see error 5.
- All other citations I checked land on the stated lines; I didn't open src/core/symbol-verify.js beyond lines 59 and 143.

**5. VERIFIED**
- The chart doesn't depend on Locate: it calls `retrievePerElement` directly (claim-chart.js:2283); `--targets` branches at 2255.
- Order is split, vocabulary, search; Locate wraps the same function.
- `--targets-out` to `--targets` is manual. `--targets` appears in no script (grep); CODEEXAM_CLAIM_CHARTS.md:619 agrees about the harness.
- `--claim-chart` has no reference in public/, server.js or the REPL.
- Synonymize runs before any index (index.js:431).
- Verdict labels, the $2.00 guard and sponge reuse by MCP are correct.
- `claim_candidates` does search bodies, though "same retrieval" omits the chart's arms and vocabulary runs.
- GUI Claim Search runs TIGHT and BROAD through multisect, with a quorum.

### 5. GUI and agents

**Queue notes**
- **No-MCP for GGUF?** Half. "tool calls in-process" is true, but nothing says the local path differs from cloud in menu or transport. It also misses the cloud Overview, which does use stdio MCP.
- **GGUF-specific prompting?** No, for either file. Omitted:
  - prior assistant answers dropped, with a read-the-code wrapper (`src/core/chat-runner.js:541-551`)
  - Gemma system-prompt fold (`:562-566`)
  - token neutralization, 4000-char cap, tool budget (`:529`, `:510`)
  - `LOCAL_ENGINE_GROUNDING` (`src/core/ai-overview.js:140`)
  - `strictInstructionsFor` (`src/server.js:2613`)
- **Chat runner location / routes into Chat:** The location is correct for Chat, but the diagram implies it is the only model path, and it isn't. Only the two chat routes and `--ask-ai` use it. The site shows neither Ask in Chat nor `--ask-ai` as a box; `--ask-ai` appears only in the sidecar.

**1. ERRORS**
1. "masked results from" (handle → manager) is wrong. `src/mcp-server.js` never imports IndexManager (only `CodeSearchIndex`, `:26`). handleTool reads a module variable (`:66`), set by `setIndex` (`:70`), `ensureIndexLoaded` (`:87`), or `load_index` (`:1279`). The server pushes into it (`src/server.js:1797`; loops at `chat-runner.js:199`). The standalone server has no manager.
2. "external → handle" is incomplete, and "stdio" isn't external-only. `/api/ai-overview` (cloud) spawns `mcp-server.js` itself (`src/core/ai-overview.js:188-193`), a second process that loads its own index from `indexPath` (`src/server.js:2682`).
3. "one registration" misleads as drawn. Same table, three menus: all, 16 (`ai-overview.js:44-48`), 8 (`chat-runner.js:452`). Fix the label, not the claim.
4. Tips: "The only registration of what a model can call" is accurate. "One router for every path" holds for model calls only. Console and GUI routes bypass it (see Omissions).
5. "tool calls in-process" is true of all three chat loops (`chat-runner.js:239,383,524`), but the runner is not the only caller: see Omissions 1.

**2. OMISSIONS**
1. Overview by AI is absent, and it is the "huh" route:
   - Cloud: `runAiOverview` drives the model through an in-process MCP client (`ai-overview.js:195`, `:232`).
   - GUI local: bypasses the runner, handleTool directly (`server.js:2529`, `:2594`).
   - CLI local: a separate implementation (`ai-overview-local.js`).
2. Ask in Chat is absent. The Overview's "Questions to start with" gets links (`public/list-renderers.js:2205-2222`). `askInChat` only prefills `#chat-input`; it does not send (`:2344-2352`). So the user's Enter is the dashed step, then `sendChatMessage`. Regenerate is a separate tool-free call (`src/server.js:2769`).
3. `--ask-ai` has no box; it enters the runner without the GUI (`src/commands/ask.js:147,168-169`).
4. Console//`api/exec` is absent: `console.js:256` → `server.js:4078` → `execCommand`. There is no handleTool, so no credential mask; `maskCredentials`' only caller is `mcp-server.js:1434` (masking elsewhere unverified).
5. The cloud Chat menu includes `load_index`, which repoints the shared `index` (`:1279`). Unverified: effect mid-conversation; the next request's `setIndex` resets it.

**3. SUGGESTIONS**
- Delete handle → manager. Add `manager -->|setIndex pushes the index| handle`, plus a note that the standalone server loads its own.
- Add box "Overview by AI": routes → it; it → mcp-server child (stdio, cloud) and → handle (local, in-process).
- Add dashed `overview -.->|Ask in Chat prefills; person sends| modules`.
- Add box "`--ask-ai`" → runner.
- Add box "Console /api/exec" → commands, "not handleTool".
- Relabel tools arrows "same table, three menus: all / 16 / 8".
- Add a "Local GGUF" sidecar section for prompting and "no MCP protocol".
- Separately, stale comments: `src/server.js:2519` and `public/api.js:130` say it spawns `claude`. No `claude` spawn in `ai-overview.js`; it spawns node. The brief's "may spawn claude" is likewise outdated.

**4. BAD CITATIONS**
None false. Two weak:
- "masked results from" citations prove masking, not the manager link.
- "gets the active index" cites `server.js:4080-4081`, the `/api/exec` route the diagram omits. `mgr.get` is named-or-active (`index-manager.js:133-135`).

**5. VERIFIED**
- Eight curated tools; cloud Chat gets all TOOLS (`chat-runner.js:72`).
- Default engine is Claude; unknown engines are rejected (`server.js:4178-4181`).
- `/api/chat` vs. stream via live checkbox.
- The mask wraps handleTool (`:1434`).
- `replace()` hooks (`server.js:1797`).
- `ask.js:92` not read directly; `:113,147` confirm the claim.
- Other sampled line citations hold.

### 6. Configuration and environment

Review of 06-configuration (working tree; static reading, nothing run). Queue note 8 (air-gap) is the only one bearing on this diagram; note 7 is partly relevant (Chat route).

**1. ERRORS**
1. Solid `air` arrows: the guard is opt-in. Nothing happens without `--air-gapped` (src/index.js:391, src/server.js:230). There is no flags→air arrow, so a newcomer reads it as always on.
2. "air -->|blocks before the network| runner" and "runner -->|cloud calls| cloud": most cloud calls bypass llm-runner. Chat uses chat-runner.js:161; Overview uses ai-overview.js:266,317; GUI analyze/claim use server.js:723; CLI uses analyze.js:3116, claim.js:414. draftCloud (llm-runner.js:215) has no guard itself; makeDrafter (:1030) and server.js:2805 guard it.
3. "keys scrubbed… every cloud call site guarded" and AIR_GAPPED.md:27 ("a stray key can't re-arm one"): scrubApiKey covers env only.
   - The server, analyze and resolveCloudKey skip key files and flags (server.js:354-359, analyze.js:126, llm-runner.js:172).
   - The CLI does not: index.js:659-677 (Overview), claim.js:290 and analyze aside, `--api-key` survives in args.
   - Guards then block, so no leak found, but the "missed guard" backstop is overstated.
4. "deletes keys" points at "Environment and key files": no file is deleted.
5. "flags -->|host flag| bind": `ce --gui` hardcodes `--host 127.0.0.1` (index.js:250) and `--host` is absent from its accept list (:194), so it exits 2. The flag works only under direct `node src/server.js`. It should also be dashed.
6. Guard citation implies assertLocalOnly everywhere. Chat, server and ask use isAirGapped() instead (chat-runner.js:205,326; server.js:422,475,2805; ask.js:153).

**2. OMISSIONS**
1. Direct-launch fail-open: `node src/server.js --air_gapped` is silently ignored. Line 182 is an exact match and unknown flags are dropped (:190). Only `ce --gui` validates and normalizes (index.js:193-222, 279).
2. MCP server: parseArgs reads only the index path (mcp-server.js:49-53), with no air-gap, scrub or probe. It makes no LLM call, but its output goes to whatever client attaches, possibly cloud (unverified, client-dependent).
3. Connectivity probe absent from the diagram. It is one TCP connect to api.anthropic.com:443, 1.5s, startup only (air-gapped.js:86-96). DNS failure, a proxy-only network, or Anthropic alone being blocked passes; OpenAI/Gemini and LAN aren't probed (inferred from the code). `allProviderEgressHosts` has no callers. `--allow-connected` skips it (:102).
4. Remote images: renderMarkdown emits `<img src=https…>` for chat answers (public/menu-bar.js:182; app.js:1704,1814), and server.js has no CSP. On a connected or falsely-clean run, model output can trigger a browser GET outside every guard (fetch unverified, not run).
5. Localhost LLM is not universal under air-gap:
   - Works: makeDrafter paths (key optional) and claim-search with a dummy `--api-key` (claim.js:300-302, 313).
   - Fails: `--ask-ai` (ask.js:153 blocks unconditionally); GUI Chat and analyze/claim-style routes using checkAvailability (server.js:695, 3764, 3926, 4184, 4259); CLI analyze (analyze.js:126 then :146); Claude Overview (ai-overview.js:304).
   - assertLocalOnly's message recommends it regardless. isLocalApiUrl also accepts 0.0.0.0 and :: (air-gapped.js:77-78), and judges the name only (an SSH-forwarded loopback would pass, inferred).
6. Stated non-guarantees missing: saves, reconnection, dependencies (AIR_GAPPED.md:61-74; protective-orders doc:406-408).
7. Secondary paths: `--temperature` default 0 (omitted on frontier models, llm-runner.js:219); `--reproducible` (server.js:176, local only); `--context-size`; cost gates: $2 claims (llm-runner.js:289), ~$0.50 analyze, $5 Overview (ai-overview.js:173); `--provenance`.
8. Bug outside the diagram: sanitizedCommandLine doesn't mask `--gemini-key` (provenance.js:88).

**3. SUGGESTIONS**
- Add `flags -.->|--air-gapped| air`; make flags→bind dashed, labelled "server.js direct only".
- Add boxes "Chat runner", "Overview by AI", "Server/CLI direct callers", each →cloud, with air guarding all.
- Split "Environment" from "Key files"; label "deletes env keys" and "skips key files (server, analyze, resolver)".
- Add "Connectivity probe" (startup, best effort), and "Not guarded: MCP clients, browser images, saves".
- New tip: "Opt-in. Blocks CodeExam's own cloud AI calls; not a network sandbox."

**4. BAD CITATIONS**
- index.js:391-397 covers CLI only; add server.js:230-239.
- argparse.js:1608-1611 is help text; use providers.js:94-100 and llm-runner.js:72-75.
- docs/AIR_GAPPED.md:25-27 is doc, carrying the overstatement.
- No other citation failed; I didn't open server.js:296 beyond its comment.

**5. VERIFIED**
- All 4 transport.request and all fetch sites are guarded by their callers.
- --air-gapped forwarded via --gui, including `--air_gapped` (index.js:184, 279); `--tour` shares that path.
- CLI air-gap runs before --ask-ai, multi-index (argv passthrough, index.js:512) and index load.
- `--gui` calls getLlamaShared before the server's check (index.js:322), with `build: never` per docs and server handling; I did not read llamaInitOptions.
- Non-loopback refusal correct, though `_LOCALHOST` (server.js:225) isn't end-anchored for `127.x` names (minor).
- GUI assets local: /vendor/mermaid.min.js, no CDN.
- isLocalApiUrl parses hostnames, fails closed.

Sources: /Users/jonudell/code-exam/docs/orientation/architecture/06-configuration.mmd, /Users/jonudell/code-exam/docs/orientation/architecture/06-configuration.md, /Users/jonudell/code-exam/src/core/air-gapped.js, /Users/jonudell/code-exam/public/menu-bar.js
