# CodeExam and SciTools Understand

*Draft, 2026-10-16. Written for reviewers familiar with SciTools Understand who want to know
what CodeExam adds, what it lacks, and where the two share a vocabulary but not a meaning.
Facts about Understand are from its public documentation, read 2026-10-14 and 2026-10-16
(dates in the sources list); facts about CodeExam are from its docs, linked. Nothing here is a
benchmark. Where this page says Understand's documentation describes no equivalent of
something, it means exactly that: not found in the pages listed below. It is not a finding
about what Understand's API or plugins could be scripted to do, which was not tested. The
comparison is between documented, out-of-the-box workflows, as of the dates given.*

## 1. Who this is for

Understand is probably the code-comprehension tool most source-code examiners already have,
and probably the one most often named in source-code protective orders as a permitted tool.
CodeExam is not a replacement for it. It is an **examination layer**: a deterministic engine
that indexes a codebase (including code that is not source) and answers the questions an
examiner brings to a review, with an optional AI layer that runs locally or on a cloud engine
and says, in its own voice, what each AI answer rested on. This page is about comparing the
two, and possibly using them side by side. CodeExam does not require Understand, nor vice
versa, and CodeExam is usable without any knowledge of Understand. If you are not familiar
with Understand and you do code examinations, it is certainly worth looking at:
[scitools.com](https://scitools.com/). Neither this page nor CodeExam itself is affiliated
with SciTools.

## 2. Where the two overlap

Both tools:

- **Browse and cross-reference.** Functions, classes, files, callers and callees, call trees.
  CodeExam's browse surface will feel familiar to an Understand user; it is not Understand's
  dependency matrix or its graphs, and does not try to be.
- **Expose the code model to an AI client over MCP.** The two servers differ in reach, so
  "both have MCP" is not the comparison. Understand ships `undmcp` alongside `und`; a client
  such as Claude Code, Cursor or Copilot adds it with one command (`claude mcp add understand
  /path/to/undmcp -- -db /path/to/project`). Its documentation says an agent can, by default,
  query the database for entities and references, read source, re-analyze the project, open
  views in a running Understand GUI, and discover databases; per-project permissions govern
  reparse, GUI interaction, and reading files inside and outside the project tree (the last
  defaults to "ask first"); the server has several modes with different toolsets, the default
  one "written for AI agents that are editing/writing code". CodeExam's server
  ([`CODEEXAM_MCP.md`](CODEEXAM_MCP.md)) registers thirty tools (as of 2026-10-16), all of
  them queries over a loaded index: orientation, search, reading files and functions,
  callers and callees, the AI/ML detectors, and the claim-to-code workflow. There are no
  write, reparse or GUI operations, and no permission model beyond that; nor is one needed
  for the examined code, because the tools answer from the index in memory and never open
  the source tree (`show_file` returns the index's copy of a file). The two exceptions read
  index directories, not source: `load_index` switches to another index and `list_indexes`
  enumerates them. No tool builds an index; that is the CLI's or the GUI's job. CodeExam
  keeps no log of the calls an agent makes. The tools run the same underlying operations as
  CodeExam's own CLI and GUI,
  so an answer an agent obtained over MCP can be re-run by hand from the command line and
  should match.
- **Put a deterministic engine first and AI second.** Understand's documentation has a page
  titled "Why use Understand when AI 'does the same thing'?", and its one-line answer is
  "Understand is deterministic." That is CodeExam's design argument too
  ([`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md)): the index does the reaching, the
  model does the reading, and the model's reading is checked against the index. See also
  [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md).
- **Run a local model with no cloud.** Understand has done so since 2025-05-02. "By default,
  no code ever leaves your computer"; once the model file is on the machine "inference is
  fully local and needs no network". CodeExam runs a GGUF model under node-llama-cpp
  ([`LOCAL_LLM.md`](LOCAL_LLM.md)) and has a no-cloud mode the tool itself enforces
  ([`AIR_GAPPED.md`](AIR_GAPPED.md)).

Said plainly: **local inference is not, by itself, a differentiator between these products.**
Understand does it with bundled models and a sizing tool. The consequential differences are
the workflows built around it, the artifacts each tool can analyze, and how results are
recorded and reviewed. What follows is what differs.

Nor is Understand the only neighbour with a local model. [**Ghost Architect Local**](https://ghostarchitect.dev/), whose
scans of CodeExam are the subject of issue #344, describes itself as "codebase intelligence on
your own hardware, inside your network", runs its rule-based scans against a model server you
own (Ollama, vLLM, LM Studio or any OpenAI-compatible endpoint) and says "air-gapped if that
is how you work", one activation call to its site excepted; the #344 reports came from two
small Qwen models through Ollama. Three more, chosen as the nearest in shape (documentation
read 2026-10-17): **SonarQube Server** (Enterprise and Data Center editions) pairs its
deterministic analyzer with AI CodeFix, which can use a self-hosted LLM gateway (Ollama,
LiteLLM or vLLM behind an OpenAI-compatible API) and "is designed to operate without outbound
internet access"; **Tabby**, an open-source self-hosted coding assistant, parses repositories
into an index and answers questions over a selected repository from it, running models itself
through a llama.cpp subprocess or through Ollama, vLLM or an OpenAI-compatible endpoint;
**Aider**, an open-source command-line pair programmer and so the furthest of the three from an
examiner's tool, builds a ranked map of each repository's symbols and definitions, sends it to
the model within a token budget, and runs against local Ollama models. The pattern they share
is CodeExam's: something deterministic reaches into the code, and a local model reads what it
is handed.

## 3. Two features that share a name

Understand's AI feature is called **AI Overview**. CodeExam has a feature called **Overview
by AI** (`--overview-by-ai`, and the button of that name in the GUI). They are different
things, and CodeExam's nearest equivalent to Understand's is to right-click on a function or
file and select **Analyze with LLM** from the pop-up menu.

| | Understand *AI Overview* | CodeExam *Analyze with LLM* | CodeExam *Overview by AI* |
|---|---|---|---|
| **Unit** | one entity at a time: a function, class or file | one function or file | the whole codebase |
| **Method** | describe the code in front of the model | describe the clicked, named entity (analyzing a selected range of code rather than a named entity is planned; no issue yet) | an agent drives CodeExam's own tools (overview, vocabulary, digest, models used, …), then writes an orientation to the codebase as a whole |
| **Generation** | on demand per entity, or pre-generated in bulk (`und ai`, or in the background on a capable machine) | on demand, per click | on demand, per index; an `--overnight` pass is contemplated (see #207 and #322, both open as of 2026-10-16) |
| **Time, as documented or observed** (not measured here; hardware, model, project size and context all move it) | "seconds" per entity in its documentation; "hours to days" is its documentation's phrase for pre-generating a large project | seconds, observed | minutes, observed with Gemma 4 on a 16 GB GPU and with a cloud engine |
| **Where the text lives** | written to `ann_AI Overview` inside the project, so it can be committed and shared with machines that cannot run a model | the Analysis pane, until saved | the GUI page, for the loaded index, so reopening the pop-up does not re-run it; kept for the life of the browser tab, not written to disk, so a reload shows it again and closing the tab discards it (#207, open, is the issue on caching it with the index); printed by the CLI |
| **Record of basis** | its documentation describes the overview as a description of the entity; no documented per-answer record of what a description was based on was found | none | a footer, written by CodeExam after the model finishes, listing which CodeExam tools the model called and how often, and notes where the answer's AI/ML sentence disagrees with CodeExam's own `models_used` result ([`CODEEXAM_NOTATION.md`](CODEEXAM_NOTATION.md)). It records tool names and counts, not the arguments passed or the evidence returned, and it checks only the AI/ML sentence, not every statement in the answer |

A reviewer who knows Understand and reads "AI Overview" in CodeExam's materials will picture
the description panel. CodeExam uses "Overview by AI" for its feature for that reason. Some
older CodeExam docs or code may still use "AI Overview" as a shorthand for what has always
been `--overview-by-ai` in the CLI.

Understand's parsed model and MCP server give an external agent deterministic grounding for
what it says, and that is real. It is a different thing from a per-answer record, kept by the
tool, of what the answer rested on. The row above compares the record, not the grounding.

## 4. Some CodeExam differences

Understand's marketing speaks to the developer who inherits code (a wonderful Understand
advertisement reads: "He names functions after his favorite alien species. Lucky you. His
project is now yours. Scitools Understand can help"), and its documentation speaks to
comprehension, maintenance, metrics and engineering analysis; as noted above, it is widely
used in source-code litigation as well. CodeExam is built around the examiner's questions
about code that is "alien" because it is someone else's: evidence-oriented investigation,
searches across whatever artifacts were produced, and claim-to-code analysis. The dividing
line is the workflow and the questions asked, not who owns the code.

- **Quasi-source.** CodeExam indexes, alongside real source and with the same search and
  cross-reference machinery, four kinds of artifact that a production often contains
  ([`QUASI_SOURCE.md`](QUASI_SOURCE.md)): **binaries** (executables and libraries become one
  pseudo-function each, holding the printable strings and the demangled C++ signatures; there
  is no call graph inside a binary's recovered content); **minified and bundled JavaScript**
  (tree-sitter recovers real function structure, a 513,619-line bundle yielding 28,441
  indexed functions; the original names are gone, so CodeExam infers descriptive names from
  strings, imports and structural fingerprints and shows them as suffixes); **scripts embedded
  in other files**; and **HAR captures** of what a page loaded. Known limits: JavaScript
  recovery from an executable is Bun-only today, and the AI/ML detectors degrade on minified
  code. Understand's documentation describes its analysis as a parsed model of source in many
  languages, with mixed-language projects; nothing in the reviewed pages describes binaries'
  strings, minified bundles or HAR captures as examination material.
- **AI/ML detection inside the target code.** What prompts a codebase carries, what LLM calls
  it makes, what models it loads or calls, its embeddings, tools, chains and pipelines
  ([`DETECTING_AI_ML.md`](DETECTING_AI_ML.md)). The evidence level matters and the detectors
  state it: detection is static and pattern-based, favouring recall over precision, so a cell
  reads as "worth checking", not "confirmed". A model id with a call site that consumes it is
  reported as used; a model-shaped literal that no call site consumes (a config default, a
  fallback, a list of candidates) is reported in a separate `declared` cell; pipelines are
  inferred from the co-occurrence of components, not from traced dataflow. None of it is
  runtime evidence: a string naming a model does not prove the model was loaded, a declared
  dependency does not prove it was used, and a prompt template does not prove it was sent
  anywhere. The reviewed Understand pages describe no built-in detector for these questions;
  its parsed model and plugin API could presumably be scripted toward some of them, which was
  not tried. AI/ML detection is one of CodeExam's **catalogs**
  ([`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md)); the others inventory the command surface
  (`--command-catalog`: CLI options, commands, switch branches, API routes and GUI actions
  found in the code), the external surface (`--referenced-resources`: "the things it points
  to but doesn't contain": URLs and hosts, environment variables, filesystem paths, embedded
  SQL, external commands such as spawn, exec and subprocess, cloud and infrastructure
  configuration, and model ids, each ranked by reference count with file and line sites), the
  HTTP surface (`--client-server`: routes declared,
  client calls made, and calls with no matching route), the telemetry and trace markers in
  the code (`--breadcrumbs`), and the imports and bill of materials (`--bom`). Whether
  Understand has equivalents was not checked.
- **The claims track.** Claim-oriented evidence discovery and mapping
  ([`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md),
  [`CODEEXAM_CODECLAIM.md`](CODEEXAM_CODECLAIM.md),
  [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md)): claim-to-code search retrieves
  candidate code sites for each claim element; a claim chart's per-element verdict (`PRESENT`,
  `PARTIAL`, `ASSUMED` or `ABSENT`) is generated by the model from the sites CodeExam
  retrieved, with the cited sites beside it; a verdict sidecar records, per element, which
  sites were cited and how many supported the verdict versus went against it; and a provenance
  header pins what can be pinned. The chart is an organized record of candidate matches for
  the examiner's analysis, "not an oracle that settles them". It does not decide whether a
  limitation is met in the legal sense: claim construction, the accused product's
  configuration and runtime behaviour are outside it.
- **A record under every AI answer.** The footer and notes described in section 3, the
  provenance header, and `--reproducible` ([`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)), with
  the scope and limits stated there.
- **Corpus-wide operations that answer "is it there at all".** Several distinct operations,
  with different semantics, that share two properties: they run over the whole index, source
  and quasi-source together, and they answer in a form that can be re-run. **Multisect**
  finds the smallest scope that contains all of a set of terms; **structural search** matches
  patterns over parsed structure rather than text; **duplicate and near-duplicate detection**
  compares function structure across sources; **client/server mapping** pairs the endpoints a
  client calls with the handlers that serve them; **referenced resources** lists what the code
  reaches for ([`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md),
  [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md),
  [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md)). Understand has strong search and a full
  dependency model; these particular operations were not found in the reviewed pages, and
  whether its API could reproduce them was not tested.
- **Two review-room practicalities.** First, the GPU-less review machine. The limitations
  differ: Understand's documentation says AI is disabled on Intel Macs, that virtual machines
  "typically can't reach GPU hardware", and that a machine failing its startup speed test
  defaults to AI off, while still able to show descriptions generated elsewhere; CodeExam's
  `--cpu` fallback runs wherever a CPU is, so it would run in a GPU-less VM, but nobody has
  measured it there and on the model sizes that matter it is in practice too slow to use.
  Neither product offers a demonstrated, satisfactory local-AI experience on a GPU-less VM;
  a VM with GPU passthrough, a CPU-only workstation and an Intel Mac are different cases and
  the comparison should be redone for the machine actually offered. Second, what leaves the
  machine. Understand's documentation lists what a default install may send and how to stop
  each: anonymous usage analytics (enabled by default; its text says they contain "no source
  code and no personal data"), licensing data when licensing online, crash reports on Windows
  (default "ask"), and a one-time model download; source code is not uploaded by default, and
  a cloud AI provider is opt-in behind an API key and an acknowledgement. CodeExam has none of
  those channels: no analytics, licensing, update check, crash reporting or model download.
  Its only outbound path is a cloud AI engine, which `--air-gapped` refuses in code. Local
  inference and zero network activity are different properties, and neither tool's own
  configuration proves that the machine it runs on is isolated; Understand's "What leaves the
  machine" page and CodeExam's [`AIR_GAPPED.md`](AIR_GAPPED.md) each say what their tool can
  and cannot vouch for.

## 5. What Understand does that CodeExam does not

- **An integrated, supported local-AI product.** As of 2026-10-14, the in-app picker offers
  four bundled models (Qwen3-1.7B, Granite4.1-3B as the recommended default, Gemma4-E4B,
  Gemma4-12B), the documentation describes several more (Qwen3.5-2B and 9B, Gemma4-E2B, a
  35B mixture-of-experts for workstations) with origin, licence, size, speed and quality
  trade-offs stated for each, plus a custom-GGUF route, a hardware sizing tool
  (`ullama-recommend`) that picks a model and a context size for the machine, LM Studio and
  Ollama as backends, and a team AI server that can run as a background service. The list
  will have moved by the time you read this; the dated page is in the sources. CodeExam is
  bring-your-own-GGUF with a sizing page to read, and more decisions left to the user.
- **Descriptions stored with the project**, pre-generated once on a capable machine and shared
  with machines that cannot run a model. CodeExam's analyses are ephemeral, living only in the
  pane unless saved to disk.
- **AI Code Search**: "find code that does X" on a local embedding index (the model is
  `BAAI/bge-small-en-v1.5`, converted to GGUF). Its documentation says the index "lives
  locally alongside the project (not in the shared/portable project files), so it doesn't
  transfer with the project either — each machine builds its own". CodeExam has no semantic
  search; the question is open for it, with a different bar, since its need is claim language
  against code rather than natural language against code (see issue #322, open as of
  2026-10-16).
- **Cloud providers behind an explicit acknowledgement**: an API key, HTTPS enforced whenever
  a key is set, and a data-sharing acknowledgement the user ticks. CodeExam gates cloud use
  with `--air-gapped` and a per-run cost cap, not an acknowledgement dialog.
- **Offline deployment, documented and tooled.** The Windows installer's "Create offline
  bundle" option saves the finished installation as a portable `.zip` containing the selected
  components and the local AI model, to carry to a machine with no network; the macOS and
  Linux kits are self-contained downloads; a CLI-only kit and an official Docker image exist
  for headless use; licensing works offline by checkout code or node-lock; and a "keep it
  disconnected" checklist names the switches to turn off. Beside that sit a "What leaves the
  machine" host and network summary and ready answers for security questionnaires. For a
  review under a restrictive protective order this is an operational difference, not a
  convenience. CodeExam's bare CLI runs from a clone or ZIP with no install step, but its GUI
  and AI features need `npm install`, and a tested offline deployment that includes those
  dependencies does not exist as of 2026-10-16. CodeExam's nearest pages are
  [`AIR_GAPPED.md`](AIR_GAPPED.md), which says what leaves the machine and what the flag
  cannot guarantee, and [`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md),
  which states where CodeExam stands under the orders' own terms; neither is
  questionnaire-shaped. In the other direction, an offline bundle does not by itself establish
  compliance with any particular order: installation, licensing, network behaviour,
  permissions and the order's text still decide that.
- **Reports**: built-in, batch and interactive reports, exportable and scriptable. CodeExam's
  reports are a design in progress (#346, open as of 2026-10-16).
- **The mature navigation surface**: the dependency matrix, graphs, metrics, build capture,
  parse-error repair, ripple analysis, refactoring, annotations, CI integration. CodeExam does
  none of these and does not intend to.

## 6. Using both in one review

Understand for the day's browsing and for anything about structure, dependencies and
metrics. CodeExam for the questions a browser does not answer: what models and prompts does
this code use; is there quasi-source, and what is in it; which patent claim elements land
where; what did the AI's answer rest on; is the thing I was told is here actually here
anywhere. The two overlap in browsing, cross-referencing and AI-assisted explanation, and
neither set of questions is exclusive to one product; the division is by the task in front of
you, not by what each tool can be made to do.

For a review under a source-code protective order, evaluate each tool's actual installation,
configuration, network behaviour, output files and permitted operations against the order's
requirements. Local inference is not, by itself, proof of compliance, and neither tool's
presence on the review machine makes its use permissible without regard to the order.
CodeExam's `--air-gapped` makes the no-cloud rule the tool's own; it does not speak for the
machine.

## 7. Sources

Understand's documentation and announcement, read 2026-10-14 unless noted:

- [Announcing local AI-powered code descriptions in Understand](https://blog.scitools.com/announcing-local-ai-powered-code-descriptions-in-understand/), blog.scitools.com, 2025-05-02.
- docs.scitools.com/help/ai/: [overview-and-setup](https://docs.scitools.com/help/ai/overview-and-setup.html),
  [choose-a-local-llm](https://docs.scitools.com/help/ai/choose-a-local-llm.html),
  [local-ai-server](https://docs.scitools.com/help/ai/local-ai-server.html),
  [ai-chat-in-gui](https://docs.scitools.com/help/ai/ai-chat-in-gui.html),
  [ai-permissions-and-privacy](https://docs.scitools.com/help/ai/ai-permissions-and-privacy.html),
  [connect-via-mcp](https://docs.scitools.com/help/ai/connect-via-mcp.html),
  [why-understand-with-ai](https://docs.scitools.com/help/ai/why-understand-with-ai.html),
  [security-questionnaire](https://docs.scitools.com/help/ai/security-questionnaire.html) (page dated 2026-07-17);
  [local-ai-no-cloud](https://docs.scitools.com/help/air-gapped/local-ai-no-cloud.html);
  [install-offline](https://docs.scitools.com/help/air-gapped/install-offline.html) (page dated 2026-08-30; read 2026-10-16);
  [offline-install-kit-windows](https://docs.scitools.com/help/getting-started/offline-install-kit-windows.html) (page dated 2026-08-31; read 2026-10-16);
  [download-and-account](https://docs.scitools.com/help/getting-started/download-and-account.html) (read 2026-10-16);
  [what-is-a-report](https://docs.scitools.com/help/reports/what-is-a-report.html).
- [huggingface.co/SciTools/embedding](https://huggingface.co/SciTools/embedding) (the embedding model card).

Other tools named in section 2, read 2026-10-17:

- Ghost Architect Local: [ghostarchitect.dev/local.html](https://ghostarchitect.dev/local.html) (the page shows version 7.4.42; the reports in #344 came from 8.x).
- SonarQube Server, "Enable AI CodeFix" (2026.4): [docs.sonarsource.com](https://docs.sonarsource.com/sonarqube-server/2026.4/instance-administration/ai-features/enable-ai-codefix).
- Tabby: [Answer Engine](https://tabby.tabbyml.com/docs/administration/answer-engine/), [source code context](https://tabby.tabbyml.com/docs/administration/context/), [model configuration](https://tabby.tabbyml.com/docs/administration/model/).
- Aider: [repository map](https://aider.chat/docs/repomap.html), [Ollama](https://aider.chat/docs/llms/ollama.html).

CodeExam's own pages are linked inline above, and one can drill down from
[`README.md`](../README.md). CodeExam issue numbers cited here (#207, #322, #346) were open
on 2026-10-16; check their current state before relying on them.
