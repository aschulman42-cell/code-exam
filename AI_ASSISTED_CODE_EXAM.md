# AI-Assisted Code Examination

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part M pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

### LLM-assisted (optional)
- `--analyze <function>` — Claude (or a local GGUF model) explains a function
  in context.
- **Multisect Analyze** — runs a multisect search, then has the LLM produce a
  structured per-term verdict grid: each search term is rated `PRESENT` /
  `NAME-ONLY` / `IFFY` / `ABSENT` with supporting evidence and a confidence
  level, so you can see at a glance how each term maps onto the matched
  function.
- `--claim-search <prose>` — extracts search terms from descriptive text (a
  patent claim, a spec, a requirement), multi-sects to find matching code,
  optionally LLM-summarizes each match.
- **Input masking** — strip comments, mask string literals, mask identifier
  names before sending a function to an LLM. The primary point is to force
  the model to reason about *logic* rather than leaning on comments or naming
  heuristics — both of which can mislead, especially in obfuscated bundles
  where the names were inferred. (Masking also suppresses some incidental data
  leakage, but it's not a hard security boundary — strings may still leak
  depending on configuration.)
- `--build-prompt <function>` — generates a digest+source prompt suitable for
  hand-pasting into any LLM (no API needed). Use this to feed CodeExam
  findings to a chat tool while keeping source local.
- Offline operation via a local GGUF model under `node-llama-cpp`. Suitable
  for code review under Court Protective Order where outbound network requests
  are prohibited. Model compatibility tracks the `llama.cpp` bundled inside
  `node-llama-cpp`: older architectures load (e.g. Qwen 3), while the newest
  (Gemma 4, Qwen 3.5) currently fail with a generic load error — see issue
  #75.

A candid caveat on the local path: a local GGUF model is not as capable as a
frontier API model like Claude. CodeExam compensates by feeding local models
simpler prompts with narrower expectations, and the resulting output is often
not as good as the Claude-API path. Closing that gap is a major ongoing focus —
better hardware (a capable GPU) and/or loading larger local models should both
help.
