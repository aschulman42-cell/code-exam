# The CodeExam MCP server

`node src/mcp-server.js` exposes an indexed codebase as **Model Context Protocol** tools, so an AI
client — driven by Claude, ChatGPT, Gemini, or a local model (see below) — can search, extract,
and analyze the code directly rather than being told about it. The server
speaks **STDIO**: the host launches it as a local child process and talks to it over
stdin/stdout, with **no network socket** — the same local-only posture as the rest of CodeExam.
Point it at an index the way you would the CLI (`--index-path`), or switch indexes at runtime with
the `load_index` tool.

## The tools

The tools CodeExam registers, grouped below by purpose. The descriptions are condensed from the
server's own registrations, so **this table can drift as tools change — `src/mcp-server.js` is
the authoritative list.**

**A caution on result caps.** Like the CLI and GUI, several tools **cap their results by default**
(a search or listing returns the top N). A capped result is *not* evidence that the codebase lacks
something — the missing item may simply be past the cap. When absence matters, raise the tool's
limit and re-run; this is the MCP face of the result-cap limitation in
[`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md) (#137).

[[Open Q5: confirm whether the tool *output* carries the `~` / `[lib?]` / `×N` notation the CLI and
GUI use, and document it here if so.]]

| Tool | What it does |
|---|---|
| **Orientation** | |
| `overview` | **Start here.** One-shot orientation to an unfamiliar index — size, languages, top-level structure, top domain vocabulary, key files by density, entry points, and "watch" notes — ending with a suggested `Next:` step. |
| `capabilities` | What CodeExam can do and which tool to use for it — orientation, search, reading code, cross-reference, detection, and the patent-claim-to-code workflow. For a model unsure which tool fits. |
| `stats` | Index statistics: file, function, and line counts. |
| `vocabulary` | The codebase's distinctive domain terms, ranked by importance. |
| `list_files` | List indexed files (optional path-substring filter). |
| `list_functions` | List functions — name, file, line count (optional name/path filter). |
| `list_classes` | List classes/structs with method counts. |
| `data_structures` | Structs/enums/unions/typedefs/traits/interfaces/records, ranked so the central types surface first. |
| **Search** | |
| `search` | Literal-string search; matching lines with file, line, and function context. |
| `regex_search` | Regular-expression search, with context. |
| `multisect_search` | Functions containing ALL of several terms — code implementing a multi-keyword concept. |
| **Read source** | |
| `extract` | The complete source of a function (`file@func` to disambiguate). |
| `show_file` | The complete source of a file, or a line range. |
| `digest` | The "tell me about X" summary of a function/class/file — identity, callers, callees, distinctive strings, structure. |
| **Cross-reference** | |
| `callers` | Call sites of a function — who calls it, and from where (`file@func` to pick one of several same-named definitions; a module-level site reads `(file scope)`). |
| `callees` | Functions a given function calls (`file@func` as for `callers`; `[unresolved]` marks a call with no reachable definition). |
| `call_tree` | Transitive call tree — multi-hop callees down, plus the caller chains that reach it. |
| `most_called` | Most frequently called functions (`defined_only` to exclude external/library calls). |
| `hotspots` | Large and frequently-called functions (score = calls × log₂(lines)). |
| `entry_points` | Defined-but-rarely-called functions — likely entry points, handlers, or dead code. |
| **Patent claims** | |
| `claim_elements` | Split a claim (or any requirement text) into its preamble and numbered limitations, as CodeExam charts it. The first step of the claim workflow. |
| `claim_candidates` | For each element, the real functions and classes most likely to implement it, ranked from code words the *model* predicts (`words` as `2: init, crypto, context` lines): name match weighted by rarity, plus a search of function bodies; opposite-direction names and vocabulary sponges flagged; tests and binary pseudo-source held back unless asked for. Deterministic — the same retrieval `--claim-locate` runs after its vocabulary step, with no model inside the tool. |
| **Catalogs & detection** | |
| `command_catalog` | The target's own user-facing commands (CLI flags, slash-commands, routes, GUI actions), each linked to its handler. Heuristic. |
| `models_used` | AI/ML models the code loads or calls, tagged api / local, plus ids declared in code as defaults or fallbacks (`declared` cell: not necessarily called). Heuristic, recall-favoring. |
| `client_server` | The HTTP surface — server routes, client calls, and client calls with no matching route. Heuristic. |
| `referenced_resources` | The external surface — URLs/hosts, env vars, paths, external commands, cloud config, model IDs — ranked with `file:line` sites. |
| **Structural** | |
| `struct_dupes` | Structurally similar functions (same control flow, different names) — copy-pasted or templated code. |
| **Index management** | |
| `list_indexes` | Available index directories under a path — name, size, date, components. |
| `load_index` | Load a different index at runtime, replacing the current one. |

## An AI using the tools

Here is a real session — Qwen3.5-27B (the 24 GB champion) driving the tools to answer a question
about an unfamiliar codebase. CodeExam's chat surfaces each **tool call** (so you can see what the
model chose to look at) and then the model's answer; it does not echo the raw tool *responses*.

```
> What does "multisect" do?

🔧 search({"query":"multisect","max":25})
🔧 show_file({"filepath":"src/core/multisect.js","start_line":1,"end_line":150})
🔧 extract({"function_name":"multisect.js@multisect"})
🔧 show_file({"filepath":"src/commands/multisect.js","start_line":1,"end_line":100})

Based on the code, multisect is a multi-term intersection search feature that finds the
smallest code scope — function → class → file → folder — containing substantially all of
N search terms simultaneously…
```

The model searched, opened the implementation, and extracted the function *before* answering —
grounding its explanation in code it actually read rather than guessing. That is the tool surface
doing its job.

## Fewer tools, used well

The surface is deliberately compact — it maps to CodeExam's own CLI features rather than exposing
every internal knob. "Less is more" holds for LLM tool-use: a focused, well-described set is
easier for a model to choose among and chain than a sprawling one, and the descriptions are
written to steer the model toward *reading real code* (`extract`, `show_file`, `digest`) instead
of guessing.

The claim tools earn their slots because without them the in-app Chat, asked how to chart a
claim, invented a by-hand procedure and never reached CodeExam's own retrieval (#343). They add
only the deterministic half of the pipeline: the model predicts the code words and judges what it
reads; CodeExam splits the claim and ranks real symbols. The audited chart with per-element
verdicts stays a CLI command (`--claim-chart`), because a tool that runs a model from inside a
model's tool call is the recursion this design avoids.

## Driving a local model through the tools

A local GGUF model can drive the tool surface too. CodeExam's own **GUI Chat** was measured on
Gemma3-12B (Q4_K_M) as **DEGRADED** (four scripted rounds, zero fabrication): it answers
navigation/orientation questions well and calls tools *correctly* — but has a **tool-*selection*
limit, not a comprehension one**. Asked "what does this function do," it may call `digest`
(location, callers) and stop without chaining to `extract` (the body), then honestly report it
lacks the information; told to use `extract`, it answers correctly. Smaller models (Qwen3-4B,
Qwen2.5-Coder-7B) have also discovered, loaded, and chained the tools to answer free-form
questions about an unseen codebase. The full per-model, per-feature evaluation — including this
GUI-Chat row — is in [`docs/model-support.md`](model-support.md).

Caveats from that testing: a small model needs **forceful system-prompt grounding** ("the source
IS available via these tools; never guess") or it may skip a tool and answer from memory;
tool-calling reliability and exploration quality scale with model size; retrieved content can
itself contain prompts that nudge a small model (treat tool output as data); and a 7B is
impractically slow on a 16 GB / no-GPU machine (prefer ~4B there). A built-in, air-gapped chat
mode is planned. This is the flip side of #325's finding — a local model is a weak *independent*
navigator (see [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md)).

The local GUI Chat drives a **curated subset** of the tools (`LOCAL_CHAT_TOOLS` in
`src/server.js`, eight names), because the measurements in
[`cloud-gpu-chat-testing.md`](cloud-gpu-chat-testing.md) showed 8B–14B models collapsing at the
full menu. The claim tools are **not** on that list: they reach Claude Desktop, other MCP clients
and the cloud Chat, and a local model reaches them only once an eleven-tool menu has been measured
to work. That is a choice with a measured cost, not an oversight. To try them on a local model
anyway, start the GUI with `CE_LOCAL_CHAT_TOOLS=+claim_elements,claim_candidates,capabilities`
(see [`LOCAL_LLM.md`](LOCAL_LLM.md)); the server says at startup that the resulting menu is
unmeasured.

## Adding a tool

A tool exists when it is registered; it is *used* when a model reaches for it. This is the
checklist the claim tools went through (2026-10-12); run it for the next one.

**Reach.** Two registration points, not one: the `TOOLS` table and the `handleToolRaw` switch in
`src/mcp-server.js` reach Claude Desktop, external MCP clients and the cloud in-app Chat. The local
GGUF Chat does not see a new tool until it is added to the curated core in
`src/core/local-chat-tools.js` (or, for one launch, via `CE_LOCAL_CHAT_TOOLS`), and adding one
to the core invalidates the "curated menu works" measurement above — decide explicitly, and re-run
the measurement if the answer is yes. Nothing points a model at a new tool by itself: existing
outputs steer through `Next:` lines (`overview`) and through `capabilities`; add the hint where a
model will be reading at the moment it needs it.

**Small models.** The local Chat truncates each description to 280 characters, so the "when to
reach for this" sentence comes first. Prefer string parameters, defaults and server-side clamping,
flat schemas (the `inputSchema` is handed straight to the local model), and the `target` alias.
Each local result is capped at 4,000 characters against a shared budget: rank hard, keep the
default cap modest, and put the remaining-count footer at the bottom, where the model is reading
when it decides what to do next.

**House conventions.** Dispatch is synchronous and the in-app Chat calls it that way: no `await`
inside a tool, and no model inside a tool. Route through `handleTool`, the credential-masking
wrapper, never `handleToolRaw`. Return a builder the CLI also uses rather than capturing stdout, so
parity holds by construction. Output rules, all tested in `test/test_mcp_tools.js`: a zero-result
message names the literal/semantic distinction and the escape hatches; a not-found message offers
`search`; a ranked tool states its population when truncated and adds no footer otherwise; never
report an absence that was not measured. No example tailoring in static text — descriptions reach
a model. Test fixtures use synthetic claim text; the real claim files are gitignored.

**Companion surfaces, in the same change.** The tool table above, and a sentence under "Fewer
tools, used well" saying why the tool earns its slot; the `src/mcp-server.js` line in
`docs/source-map.md`; a row in `docs/model-support.md`, "UNTESTED" if so;
`docs/CODEEXAM_KNOWN_LIMITATIONS.md` if local reach changes; the registration test. Do not state a
tool count in prose, and do not edit a number that records a past measurement.

## Related

- [`GETTING_STARTED.md`](GETTING_STARTED.md) — launching the server and the other ways to run CodeExam.
- The tools mirror CLI features documented across [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md),
  [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md), [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md), and
  [`CODEEXAM_KEY_FEATURES.md`](CODEEXAM_KEY_FEATURES.md).
