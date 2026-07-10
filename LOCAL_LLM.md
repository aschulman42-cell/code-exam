# Local LLMs in CodeExam

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part F pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

### Reproducibility of local-model chat

Local-model answers **vary run to run by default**: CodeExam leaves
node-llama-cpp's sampling enabled, so the same question over the same index
can produce a differently-worded — and differently-investigated — answer each
time. That default is deliberate: early exploration benefits from variety,
and comparing variant answers to the same question is itself informative in
examination work, where small differences between related documents are the
raw material of analysis.

For examinations that must be reproducible, start CodeExam with
`--reproducible`: the local chat loop (and the local Overview by AI) then
pins sampling (temperature 0, fixed seed), so the same question over the same
index with the same model file and configuration produces the same answer.

The flag is named for exactly what it claims — an empirical, environment-
scoped property, not a formal guarantee about the computation. It holds per
machine / model file / configuration; bit-identical output across different
machines, GPU drivers, or compute backends is **not** promised. To
demonstrate reproducibility for the record, run the query twice in the
actual examination environment, save both outputs, and confirm they match
(hash them if a hashing tool is available — `certutil -hashfile` on Windows,
`sha256sum` on Linux; a plain diff or side-by-side comparison serves the same
purpose) — the property is then verified evidence, not a vendor promise. Record the model file (with
quantization), context size, CodeExam version, and the `--reproducible`
posture as part of the examination record. (The cloud/Claude chat engine is
separately pinned at temperature 0 by default.)

## Operating without a network

The GUI binds to localhost, the MCP server uses stdio, and outbound network
requests are opt-in and gated. Combined with the optional local-GGUF path,
CodeExam can run a full examination workflow without any network access —
appropriate for litigation, security review, or any context where source must
stay local. The one honest trade-off is capability: the local-GGUF path is less
capable than the Claude-API path (see the LLM-assisted notes above), so the
non-LLM machinery does most of the work in a fully air-gapped run and LLM output
quality is generally below what the API would produce.

For an **enforced** no-cloud run — `--air-gapped` hard-blocks every cloud AI
call, scrubs the API key, and warns on a reachable network — plus what it does
and does **not** guarantee (it can't police where you save), see
**[AIR_GAPPED.md](AIR_GAPPED.md)**.
