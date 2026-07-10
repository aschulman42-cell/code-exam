# Detecting AI/ML in a Codebase

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part J pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

A growing focus is **examining AI-related software**, and much of that is now in
place. CodeExam ships a dedicated **AI/ML and LLM-app detectors** suite (see
Feature highlights below) that surfaces inferred pipelines, the models a codebase
defines and uses, LLM calls, tools, agents/chains, embeddings, and more —
alongside LLM prompt extraction, stress-tested on large AI codebases such as
Claude Code's minified `cli.js` (≈14 MB, bundled with `claude.exe`) and Codex's
Rust source. It indexes the major ML framework and model trees (PyTorch, Hugging
Face Transformers, scikit-learn; model repos such as DeepSeek, Qwen, Llama) with
the same general machinery. This remains an area of active development.

### AI/ML and LLM-app detectors

A group of heuristic detectors that surface the AI/ML and LLM-app constructs in
a codebase — available both as a left-pane **AI/ML** section in the GUI and as
matching CLI flags (`--pipelines`, `--models-used`, `--llm-calls`, …; each has a
`--list-<name>` alias). They span classic ML (PyTorch / HF Transformers /
scikit-learn) and LLM-application code (SDK calls, tools, agent/chain
frameworks). Detection is pattern-based — it favors recall and is honest about
its misses, and distinct names are kept rather than over-collapsed.

Three views lead:

- **AI/ML Pipelines (inferred)** — the connected-flow overview. CodeExam infers
  end-to-end pipelines (RAG, training, inference, agent, LLM-app) from the
  *co-occurrence* of the component cells below, so you see how the pieces wire
  together instead of a flat list. The best lead-in to an unfamiliar AI codebase.
- **Models Used** — the named models actually loaded or called across the whole
  codebase, deduped and labeled api-vs-local (an API id like `gpt-4o`, a `.gguf`
  path, a Hugging Face repo id). Distinct from **Models (defined)** below, which
  lists model *classes* (`nn.Module` / Keras / scikit-learn subclasses).
- **Prompts** — the prompt catalog (relocated here from *Catalogs*): detected
  LLM prompts, with composite expansion — ternary branches, `${var}` templates,
  and `[…].join(…)` assemblies merged into one searchable entry per logical
  prompt. Detects inline strings, `getSystemPrompt` / `systemPrompt:`,
  `role:"system"` messages, and `.md` skill files.

The component detectors the Pipelines view synthesizes from — each also a
standalone list (GUI accordion + CLI flag):

- **LLM Calls** — SDK calls / endpoints (`messages.create`, `ChatOpenAI`, `LlamaChatSession`).
- **Tools** — tool / function-calling defs and dispatch (`@tool`, `input_schema`, MCP).
- **Chains / Agents** — orchestration via LangChain / LangGraph / DSPy / CrewAI.
- **Embeddings / Vectors** — embedding and vector-search sites (FAISS / Chroma, similarity search).
- **Structured Output** — schema-constrained output (`with_structured_output`, `response_format`, parsers).
- **Inference** — local generation / prediction (`generate`, `no_grad`, `.predict`).
- **Training** — training sites (PyTorch loops, HF `Trainer`, `.fit`).
- **Datasets** — dataset definitions and loaders (`Dataset` / `IterableDataset`, `tf.data`).
- **Artifacts** — model load/save sites (`from_pretrained`, GGUF, safetensors) and quantization configs (BitsAndBytes / GPTQ / AWQ, 4-/8-bit).
- **Models (defined)** — model classes by inheritance (`nn.Module` / Keras / scikit-learn).
- **Kernels** — GPU kernels (CUDA `__global__`, Triton `@triton.jit`, numba).
- **Multimodal / Vision** — vision encoders (CLIP/ViT), CNN architectures (ResNet/conv), object detection/segmentation (YOLO/SSD/DETR/U-Net), generative (diffusion/VAE).
- **Post-training / Fine-tuning** — fine-tuning & alignment mechanisms (LoRA/PEFT/adapters, SFT/DPO/PPO/GRPO, distillation), distinct from pretraining.
- **Reasoning / CoT** — chain-of-thought and reflection *prompt language* (`step by step`, `chain-of-thought`, reflection/scratchpad). A heuristic signal over prompt text, not a structural-reasoning detector.

### Infrastructure / DevOps detection

Beyond the AI/ML cells, an **Infrastructure** accordion surfaces the non-AI/ML
operational stack — Containers, Kubernetes, IaC, Cloud, and CI/CD — detected
mechanically from file shapes (Dockerfiles, K8s manifests, Terraform, CI
configs) and cloud-SDK usage (#168).
