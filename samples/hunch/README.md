# Hunch™ — by Overfit Labs

> **Synthetic demo code.** Hunch is not a real product. These files ship with
> CodeExam's first-run index so you can see the AI/ML detectors fire on honest,
> real-marker usage *before* you point CodeExam at your own code. They are never
> executed by CodeExam. Written by Claude (Anthropic) for the CodeExam demo.

**Hunch** is an "explainable AI" engine with one job: make a confident
prediction, then generate a thoroughly convincing explanation for why that
prediction was obviously correct all along. Confidence is the product;
correctness is a nice-to-have.

## What's here (and what CodeExam will show you)

| Path | What it is | Try in CodeExam |
|---|---|---|
| `app/agent.js` | The rationalization loop — an Anthropic agent that predicts, then dispatches tools to justify itself | `--llm-calls`, `--chains` (a real hand-rolled agent), `--tools` |
| `app/demo.js` | **The one runnable file** — drives `runHunch` so you can watch the gag happen | see "Running Hunch" below |
| `app/tools.js` | Tool definitions (`fetch_features`, `run_model`, `explain`) | `--tools` |
| `app/prompts.js` | The system + explanation prompts ("You are never uncertain…") | `--prompts` |
| `model/hunch_net.py` | The model itself — a small `nn.Module` | `--models` |
| `model/pipeline.py` | load → featurize → predict → explain → report | `--inference`, `--pipelines`, and a `call_tree` / mermaid diagram |
| `model/embed.py` | Feature embeddings (`SentenceTransformer`) | `--embeddings` |
| `harnesses/*.py` | **Real** instrumentation harnesses CodeExam generated for actual PyTorch models — a preview of the forthcoming `--emit-harness` feature (#95) | `--artifacts`, `--inference`; open them and read the headers |
| `native/fast_score.c` | A "performance-critical" softmax in C | shows cross-language indexing |

## Running Hunch (optional)

Everything else here is *structural* demo code — written to be examined, not run.
The exception is **`app/demo.js`**, the one runnable entry point. It makes real
Anthropic API calls, so it needs `npm install` and `ANTHROPIC_API_KEY` (it is
*not* air-gapped). Then, from the repo root:

```bash
node samples/hunch/app/demo.js          # default subject
node samples/hunch/app/demo.js globex   # a different subject
```

Hunch commits to a verdict at confidence 0.99 *before* reading anything, then
manufactures an authoritative explanation to fit it. That is the entire product.

## Suggested tour

1. Run the **Overview** on this folder — Hunch's structure at a glance.
2. Open the **AI/ML accordions** (or `--llm-calls --tools --chains --prompts
   --inference --embeddings --pipelines`): every hit here is *real* usage, the
   honest counterpoint to a tool's own detector vocabulary.
3. `call_tree` (or the mermaid view) on `model/pipeline.py:run` — the inference
   pipeline.
4. Then point CodeExam at **your own** code — see
   [`docs/example-indexes.md`](../../docs/example-indexes.md) for recipes.
