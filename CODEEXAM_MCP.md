# The CodeExam MCP Server

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part E pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

- **MCP server** — `node src/mcp-server.js` exposes the indexed codebase as
  Model Context Protocol tools, so Claude Code or Claude Desktop (and
  presumably other MCP clients such as Codex, though that's untested) can
  search, extract, and analyze it directly.

**Local-model MCP chat (experimental).** The MCP tool surface has been validated
driving a *local* GGUF model through an MCP-aware host (LM Studio): Qwen3-4B and
Qwen2.5-Coder-7B both discovered, loaded, and chained the tools (`stats`,
`vocabulary`, `digest`, `show_file`, …) to answer free-form questions about an
unseen codebase. Honest caveats from that testing: a small model needs
**forceful system-prompt grounding** ("the source IS available via these tools;
never guess") or it may refuse a tool and hallucinate instead; tool-calling
reliability and exploration quality scale with model size; retrieved content can
itself contain prompts that nudge a small model (treat tool output as data); and
on a 16 GB / no-GPU machine a 7B is impractically slow — prefer a ~4B there. A
built-in, air-gapped chat mode is planned.
