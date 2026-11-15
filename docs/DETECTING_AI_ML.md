# Detecting AI/ML in a codebase

"AI/ML" is, of course, **Artificial Intelligence / Machine Learning** — large language models
(LLMs), deep learning, neural networks, reinforcement learning, embeddings, and the surrounding
tooling.

"AI" shows up in CodeExam in three distinct senses, and it's worth separating them before
reading the rest of this page, which is about the third:

- CodeExam was **built** with heavy AI help.
- You **may optionally use** a cloud or local model *during* an examination (see
  [`LOCAL_LLM.md`](LOCAL_LLM.md)).
- CodeExam **detects** AI/ML in the *target* code — and this is the one that surprises
  people: **it uses no AI at run time.**

The detectors are mechanical — pattern matches, AST scans, inheritance resolution,
call-site harvesting — so they are deterministic and reproducible: run them twice on the
same index and the counts are identical, because there is no model in the loop to vary.
That is the property the whole non-LLM side of CodeExam has, and it is what makes these
counts trustworthy in a way an LLM's *judgment* is not: they are **computed, not guessed.**
(A model's verdict — cloud or local — is generated text that can be wrong, or, as #325
showed starkly for a local model, fabricated outright.)

That doesn't mean no AI was involved; it was, at authoring time. The detector rules were
produced by CodeExam's **investigation-to-spec** workflow
(`.claude/skills/investigation-to-spec`): an LLM studies a framework through CodeExam's own
digests, then distills what it finds into a deterministic spec — tagging each rule
*mechanical*, *heuristic*, or *human-or-LLM-seam* and "retiring the LLM out of the runtime
wherever possible." The AI/ML suite came from exactly this: a tour across PyTorch,
Transformers, scikit-learn, Keras, TensorFlow, LangChain, and DSPy. **The LLM is the
planner; the shipped artifact is mechanical rules.** AI's knowledge is baked into fixed
code, not called by it — CodeExam's general pattern.

## Quick orientation to a codebase that may use AI/ML

What models a codebase loads, the LLM calls it makes, whether it trains or only runs
inference, what orchestration framework wires it together, what operational stack it
deploys on — these are worth knowing on their own, whatever you're examining the code for.
On an unfamiliar codebase they're often the fastest way to learn whether, and how, it uses
AI/ML at all.

## The three lead views

**AI/ML Pipelines (inferred)** — the best lead-in. CodeExam infers end-to-end pipelines
(RAG, training, inference, agent, LLM-app) from the *co-occurrence* of the component cells
below, so you see how the pieces wire together rather than a flat list. On the LangChain
source tree it finds **192 pipelines across 69 groups** (113 RAG, 53 agent, 15 inference,
…), each rendered as a connected flow — e.g. a RAG pipeline read as
`vector-store(Milvus) → search → llm-call → agent`. (Inference is from co-occurrence, not
traced dataflow; confidence is scoped file > folder > module.)

**Models Used vs. Models Defined** — two different questions. *Models Used*
(`--models-used`) is the named models the code actually loads or calls, deduped and tagged
**api** (a hosted id like `gpt-4o`) vs. **local** (a `.gguf` path or a Hugging Face repo
id). A model-shaped literal that no call site consumes — a config-object default, a
`|| 'id'` fallback, a list of candidates — is reported in a `declared` cell: declared in the
code, not necessarily called, with its api/local tag inferred from the id's shape (#345).
*Models Defined* (`--models`) is model *classes* by inheritance — on the scikit-learn
tree, **474 model classes** (`Pipeline` and `ColumnTransformer` extending `BaseEstimator` /
`TransformerMixin`, the gradient-boosting and mixture bases, and so on). One tells you what
the code *uses*; the other, what it *is*.

**Prompts** (`--prompt-catalog` / `--prompts`) — the LLM prompt catalog, with composite
expansion: ternary branches, `${var}` templates, and `[…].join(…)` assemblies merged into
one searchable entry per logical prompt. It detects inline strings, `getSystemPrompt` /
`systemPrompt:`, `role:"system"` messages, and `.md` skill files — and each entry names the
`file@function` it was found in, in the CLI and the GUI alike, so the catalog doubles as a
map to the code that builds each prompt. The catalog recovered from the minified `cli.js`
inside `claude.exe` — the [README](../README.md) image — is this detector run over
quasi-source.

## The component detectors

Each is a GUI accordion and a CLI flag (every flag has a `--list-<name>` alias); the
Pipelines view above is synthesized from their co-occurrence.

| Detector | Flag | What it finds |
|---|---|---|
| LLM Calls | `--llm-calls` | SDK calls / endpoints (`messages.create`, `ChatOpenAI`, `LlamaChatSession`; hosted hosts, Ollama's `localhost:11434` and its `/api/chat` family in a file that names Ollama) |
| Tools | `--tools` | tool / function-calling defs and dispatch (`@tool`, `input_schema`, MCP) |
| Chains / Agents | `--chains` (`--agents`) | orchestration (LangChain / LangGraph / DSPy / CrewAI) |
| Embeddings / Vectors | `--embeddings` (`--vectors`) | embedding + vector-search sites: cloud SDKs and frameworks (`OpenAIEmbeddings`, `embeddings.create`, `SentenceTransformer`), local runtimes (node-llama-cpp `createEmbeddingContext`, llama.cpp `llama_get_embeddings`, Ollama `/api/embed`, an OpenAI-compatible `/v1/embeddings`), an embedding model named by file or id (`nomic-embed-text-v1.5.Q8_0.gguf`, `BAAI/bge-small-en-v1.5`), vector stores (FAISS / Chroma), similarity search |
| Structured Output | `--structured-output` | schema-constrained output (`with_structured_output`, `response_format`) |
| Inference | `--inference` | local generation / prediction (`generate`, `no_grad`, `.predict`) |
| Training | `--training` | training sites (PyTorch loops, HF `Trainer`, `.fit`) |
| Datasets | `--datasets` | dataset defs and loaders (`Dataset` / `IterableDataset`, `tf.data`) |
| Artifacts | `--artifacts` | model load/save (`from_pretrained`, GGUF, safetensors) + quantization (BitsAndBytes / GPTQ / AWQ) |
| Models (defined) | `--models` | model classes by inheritance (`nn.Module` / Keras / scikit-learn) |
| Kernels | `--kernels` | GPU kernels (CUDA `__global__`, Triton `@triton.jit`, numba) |
| Multimodal / Vision | `--multimodal` (`--vision`) | vision encoders (CLIP/ViT), CNNs (ResNet), detection/segmentation (YOLO/U-Net), generative (diffusion/VAE) |
| Post-training | `--post-training` (`--finetuning`) | fine-tuning / alignment (LoRA/PEFT, SFT/DPO/PPO/GRPO, distillation) |
| Reasoning / CoT | `--reasoning` | chain-of-thought *prompt language* (`step by step`, reflection) — a signal over prompt text, not a structural detector |

**Embeddings: local runtimes and named models (2026-11-15).** Until this date the Embeddings
detector knew cloud SDKs and Python frameworks only, so a codebase that embeds with a local
runtime showed nothing: CodeExam's own source (node-llama-cpp, five GGUF models named in
`src/core/embed.js`) reported 10 sites, none of them the real ones, and the index of
node-llama-cpp's own source reported none. Three changes:

- **Local runtimes and more providers** are in the marker table, taken from the runtimes'
  public APIs: node-llama-cpp, llama.cpp and llama-cpp-python, Ollama, an
  OpenAI-compatible `/v1/embeddings` endpoint, transformers' `feature-extraction`
  pipeline, fastembed, LlamaIndex (`OpenAIEmbedding`, `get_text_embedding`), Google
  (`embed_content`), the AI SDK (`embedMany`), and a fixed list of providers' classes
  (`BedrockEmbeddings`, `VoyageEmbeddings`, …). It is a list, not any `…Embeddings` name:
  in a model library `BertEmbeddings` is a layer.
- **An embedding model named in a string** is a site with the name as its id, from the
  families that are embedding models by name (nomic-embed, jina-embeddings, bge, e5, gte,
  MiniLM / mpnet sentence models, text-embedding-3 / ada, EmbeddingGemma, Qwen3-Embedding,
  mxbai, arctic-embed, voyage, Cohere embed, titan-embed). Models Used lists them, local
  or api by family.
- **A marker word inside quoted prose is not a site**: a help line, an error message, a
  docstring opener. A string that is one token (`"pgvector"` as a config value, a name in
  an export list) still counts, and so does every line of a notebook, where code is
  itself a JSON string. A `.search(` given a regex literal is a string search.

Rows before and after on twelve indexes at hand (the same index, the detector alone
changed):

| index | before | after | lost | gained |
|---|--:|--:|--:|--:|
| CodeExam's own source | 10 | 27 | 5 | 22 |
| node-llama-cpp | 0 | 8 | 0 | 8 |
| llama.cpp | 10 | 61 | 3 | 54 |
| LM Studio (bundled JS) | 1 | 19 | 1 | 19 |
| LlamaIndex | 1,583 | 1,606 | 704 | 727 |
| LangChain | 3,529 | 3,180 | 575 | 226 |
| CrewAI | 379 | 525 | 125 | 271 |
| AutoGen | 72 | 121 | 4 | 53 |
| a set of agent-book sources | 79 | 102 | 5 | 28 |
| sentence-transformers | 580 | 553 | 31 | 4 |
| DSPy | 23 | 17 | 8 | 2 |
| a set of LLM-book notebooks | 8 | 8 | 0 | 0 |

Four more indexes had no row before or after (x264, a Qwen3 repository, a RAG-book
source set, GhostArch); the last three were not read to see whether they should have one.

What a hand read of samples found (about 10 to 20 rows lost and gained per index, not
every row):

- **Lost rows are prose**: error messages and docstrings (`raise ValueError("… Weaviate
  Python client …")`), the Discord chat dumps under LlamaIndex's docs (9 of the 14 sampled from its 704),
  string constants in decompiled `.pyc` listings that repeat the `.py` beside them. A
  codebase present only as such listings loses the docstring mentions and keeps the names.
- **Gained rows that are thin**: recorded HTTP exchanges in test cassettes
  (`uri: https://api.openai.com/v1/embeddings`, the kind most of CrewAI's 53 new endpoint rows were in the sample) and model names in
  tests are evidence of use but not sites of it; a model id quoted inside a docstring is
  listed; in a minified bundle the match is a line of a string table.
- **Still missed**: an embedding call through a wrapper with none of these names; a model
  id held in a variable or a config file that is not indexed; the families list is a list
  and a model outside it is not seen.

```
node --test test/test_ai_ml_self_detect.js
node src/index.js --index-path <index> --embeddings -v
node src/index.js --index-path <index> --models-used
```

## Infrastructure and DevOps

Beyond the AI/ML cells, an **Infrastructure** view (`--infrastructure` / `--infra`)
surfaces the non-AI operational stack — Containers, Kubernetes, IaC, Cloud, and CI/CD —
detected mechanically from file shapes (Dockerfiles, K8s manifests, Terraform, CI configs)
and cloud-SDK usage.

## Handing off: `--emit-harness`

Detection is read-only, with one exception you run yourself: `--emit-harness` emits a
runnable PyTorch forward-hook activation harness for a detected model class (`file@Class`
to disambiguate). CodeExam never runs it — it writes the `.py`, and you do.

## Reading the detector output

Detection is **pattern-based**: it favors recall (erring toward flagging rather than
missing), marks its heuristic matches as such rather than hiding them, and keeps distinct
names rather than over-collapsing them (LangChain's **876** chain/agent sites are reported
as 684 chain / 41 graph / 151 agent, with the 28 heuristic matches flagged as such). Two
things to keep in mind:

- **Recall over precision means false positives happen** — read a cell as "worth
  checking," not "confirmed."
- **Minified or obfuscated code degrades detection.** On the minified `cli.js`, the
  Models-Used detector reports a spurious `Response` and the pipeline view collapses to one
  vague "agent" — the names a minifier destroyed can't be recovered (see
  [`QUASI_SOURCE.md`](QUASI_SOURCE.md)). Trust the detectors most on real source, and
  distrust `--models-used` on minified bundles specifically.

The suite has been stress-tested on large real codebases — Claude Code's minified `cli.js`,
Codex's Rust source, and the major framework and model trees (PyTorch, Transformers,
scikit-learn, Keras, TensorFlow; model repos such as DeepSeek, Qwen, Llama). It remains an
area of active development.

## Related

- The **prompt catalog** also serves orientation on any codebase that uses prompts — since
  each entry names the `file@function` it lives in, it doubles as a map to the
  prompt-bearing code — see [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md).
- Detecting AI/ML *inside a minified bundle or a binary* is quasi-source in action —
  [`QUASI_SOURCE.md`](QUASI_SOURCE.md).
- The full **determinism boundary** — which CodeExam commands are mechanical (like these
  detectors) and which involve a model — is enumerated in
  [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) and [docs/model-support.md](model-support.md).
