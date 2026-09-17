# The CodeExam MCP server

`node src/mcp-server.js` exposes an indexed codebase as **Model Context Protocol** tools, so an AI
client — driven by Claude, ChatGPT, Gemini, or a local model (see below) — can search, extract,
and analyze the code directly rather than being told about it. The server
speaks **STDIO**: the host launches it as a local child process and talks to it over
stdin/stdout, with **no network socket** — the same local-only posture as the rest of CodeExam.
Point it at an index the way you would the CLI (`--index-path`), or switch indexes at runtime with
the `load_index` tool.

## The tools

CodeExam registers 26 tools, grouped below by purpose. The descriptions are condensed from the
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
| `callers` | Call sites of a function — who calls it, and from where. |
| `callees` | Functions a given function calls. |
| `call_tree` | Transitive call tree — multi-hop callees down, plus the caller chains that reach it. |
| `most_called` | Most frequently called functions (`defined_only` to exclude external/library calls). |
| `hotspots` | Large and frequently-called functions (score = calls × √lines). |
| `entry_points` | Defined-but-rarely-called functions — likely entry points, handlers, or dead code. |
| **Catalogs & detection** | |
| `command_catalog` | The target's own user-facing commands (CLI flags, slash-commands, routes, GUI actions), each linked to its handler. Heuristic. |
| `models_used` | AI/ML models the code loads or calls, tagged api / local. Heuristic, recall-favoring. |
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

## Driving a local model through the tools

A local GGUF model can drive the tool surface too. CodeExam's own **GUI Chat** was measured on
Gemma3-12B (Q4_K_M) as **DEGRADED** (four scripted rounds, zero fabrication): it answers
navigation/orientation questions well and calls tools *correctly* — but has a **tool-*selection*
limit, not a comprehension one**. Asked "what does this function do," it may call `digest`
(location, callers) and stop without chaining to `extract` (the body), then honestly report it
lacks the information; told to use `extract`, it answers correctly. Smaller models (Qwen3-4B,
Qwen2.5-Coder-7B) have also discovered, loaded, and chained the tools to answer free-form
questions about an unseen codebase. The full per-model, per-feature evaluation — including this
GUI-Chat row — is in [`docs/model-support.md`](docs/model-support.md).

Caveats from that testing: a small model needs **forceful system-prompt grounding** ("the source
IS available via these tools; never guess") or it may skip a tool and answer from memory;
tool-calling reliability and exploration quality scale with model size; retrieved content can
itself contain prompts that nudge a small model (treat tool output as data); and a 7B is
impractically slow on a 16 GB / no-GPU machine (prefer ~4B there). A built-in, air-gapped chat
mode is planned. This is the flip side of #325's finding — a local model is a weak *independent*
navigator (see [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md)).

## Related

- [`GETTING_STARTED.md`](GETTING_STARTED.md) — launching the server and the other ways to run CodeExam.
- The tools mirror CLI features documented across [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md),
  [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md), [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md), and
  [`CODEEXAM_KEY_FEATURES.md`](CODEEXAM_KEY_FEATURES.md).
