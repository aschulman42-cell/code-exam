# Summarizing code

CodeExam summarizes code at several levels of granularity — a whole-codebase overview,
per-function/class/file digests, comment extraction, structural maps, and
LLM-written analyses and chat.

> **Outline — the fuller version lands shortly after public release.** This page
> is the topic list for the expanded doc; the commands themselves already work
> today (see [`CODEEXAM_CLI.md`](CODEEXAM_CLI.md) and
> [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md)).

Planned coverage:

- **`--overview`** — a deterministic, whole-codebase summary (no model).
- **`--overview-by-ai`** — an LLM-written overview, on a cloud or local model.
- **`--digest`** — a target-aware summary of a function, class, or file.
- **`--comments-only`** — extract just the comments.
- **`--file-map`** — a structural map of a file.
- **`--call-tree`** — summarize how code connects, by call relationships.
- **`--analyze`** — an LLM analysis of a function/class/file (in the GUI,
  right-click the target → **Analyze**).
- **GUI Chat** — ask the LLM to summarize, interactively.

See also the Software Litigation Consulting write-up on AI code summarization:
[Working with CodeLlama to generate source-code summaries](https://www.softwarelitigationconsulting.com/working-with-codellama-to-generate-source-code-summaries).
