# CodeExam — a quick tour

You're looking at a small **bundled demo index** so you can try CodeExam right
away. It's two things:

- **`hunch/`** — a *synthetic* "explainable AI" app (Hunch, by Overfit Labs): it
  makes a confident prediction, then has an LLM rationalize it after the fact.
  Written for this demo; not a real product.
- **`harnesses/`** — *real* instrumentation harnesses CodeExam generated for
  actual PyTorch models (what `--emit-harness` produces).

## Try these

1. **The AI/ML accordions** (left pane). Open *LLM Calls*, *Tools*, *Chains*,
   *Prompts*, *Inference*, *Embeddings*, *Pipelines* — every hit here is real
   usage in `hunch/`, including a genuine hand-rolled agent loop.
   - You'll notice these rows are **dimmed and tagged `[example]`**. That's not a
     bug: CodeExam recognizes sample/demo/test code and de-emphasizes it, so it
     doesn't drown out a real project's signal. (*View → Exclude Tests* hides
     such rows entirely — keep it **off** here to see the demo.)

2. **Read a function.** The function names you see (in the Overview and the
   accordions) are things you can open. Try the agent loop from a shell:

       ce --extract runHunch
       ce --digest hunch/app/agent.js@runHunch

   (`--extract <name>` prints a function's source; `--digest` summarizes it.
   Run from a directory with no index of its own and CodeExam uses this demo,
   saying so.)

3. **See the pipeline as a diagram.** `ce --call-tree pipeline.py@run` lays out
   Hunch's chain — `load_subject`, `build_features`, `predict`, `explain`,
   `format_report` — as a tree; add `--mermaid` for a diagram.

4. **Search.** Full-text, regex, or **multisect** (smallest scope containing N
   terms):

       ce --search rationalization
       ce --multisect-search "rationalization;predict"

## Then: your own code

When you're ready, point CodeExam at a real codebase:

- `ce --build-index <dir>` to index a source tree, then `ce --index-path <dir>`
  (or build/load in the GUI via the **File** / **Indexes** menus).
- For worked recipes — minified bundles, a native binary's quasi-source, a `.har`
  capture, a real AI codebase — see `docs/example-indexes.md`.

*This tour is also under **Help → Tour** any time. Full docs:
<https://github.com/aschulman42-cell/code-exam>.*
