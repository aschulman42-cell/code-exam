# Missing-Blocks Survey — AI/ML detector coverage

A pre-public-repo audit of which AI/ML constructs CodeExam's detectors should
surface, what's missing, and the method used to decide. Feeds the AI/ML feature
work (#84) and the public-repo roadmap (#133). Implementation tracked in **#140**
(two new accordions) and **#141** (existing-cell improvements).

## Purpose
The AI/ML accordions (#133) shipped with 13 detector cells + projections. Before
public release, decide: (a) which new accordions are worth adding, (b) which
keywords improve existing cells, (c) what's clearly needed but not in time
(future-list). Guiding constraint: a new accordion earns its place only if it
feeds the **AI/ML Pipelines** synthesis (pipelines are inferred from cell
co-occurrence), not just as another list.

## Methodology (reusable)
1. **Census via `--multi-index --regex`** — one big alternation regex for
   candidate terms across all indexes; dump and tally.
2. **`census.py`** parses the dump into a per-term table:
   - **breadth** = distinct indexes showing the term *in code* — the primary
     signal ("occurs across enough indexes to be worth a detector"), more
     meaningful than raw hit count.
   - splits hits into **code / doc (.md,.rst) / data (.json vocab)** so tokenizer
     vocab and READMEs don't masquerade as code usage.
   - `-x/--exclude-index PAT` (substring) drops synthetic/self-reference indexes;
     default `-x Franken,CodeExam,bram,node_modules`.
   - `-c/--code-only`; `-p/--pattern` supplies the regex when the dump was made
     with a `>` redirect (which drops the echoed command line).
3. **Phrase regexes:** spaces/hyphens -> `.?` (matches `fine-tuning` /
   `fine tuning` / `finetuning` at once). Bare `--regex "(...)"` is
   case-insensitive; proper-noun model names use the case-sensitive
   `/\b(...)\b/` form to avoid `clip`/clipboard and `image net`/`stores network`
   noise. **Caveat:** bare `--regex` defaults case-insensitive; only `/.../` is
   case-sensitive; multisect regex is hardcoded case-insensitive (bug, #138).
4. **Detect mechanisms, not umbrella phrases.** Umbrella terms (`post-training`,
   `preference tuning`, `in-context learning`, `RLHF`) are ~0 in *code* but heavy
   in *docs*; the mechanisms (LoRA/SFT/DPO; few/zero-shot; reasoning-prompt
   builders) are what code carries. A doc naming the concept is the "this index
   should light up" validator, not the detector target.
5. **Validation by exemplar.** Pick canonical repos per suspect category,
   **pre-register predictions**, index, and score output vs prediction (keeps
   gap claims honest).

## Findings

### Two new accordions -> #140
- **Multimodal / Vision** — multimodal 10, CLIP 7, ImageNet/ResNet 3,
  convolutional. New pipeline *type* (image -> vision encoder -> model). Key on
  vision-encoder proxies; NOT diffusion (0-code / doc-only in this corpus).
- **Post-training / Fine-tuning** — fine-tuning 11 (doc 282), LoRA 15, SFT 9,
  GRPO 6, DPO 4. Refines the *training* pipeline (fine-tune/align vs pretrain).
  Key on mechanisms, not the umbrella term.

### Existing-cell improvements -> #141
- **Reasoning-prompt mining (Prompts cell)** — `"think step by step"`,
  `chain_of_thought`/`cot_prompt`, `scratchpad`, `reflect`/`self_reflection`,
  `tree_of_thought`, `reasoning`/`rationale`.
- **Keyword harvests:** Models (encoder-decoder, decoder-only, convolutional,
  dropout, hidden layer, MoE); Prompts (few/zero-shot); Training (distillation,
  transfer learning); Artifacts/Inference (quantization, GPTQ/AWQ/bitsandbytes).

### RAG & Agents are well-covered and *broad* (honest record)
Pre-registered predictions that CrewAI/AutoGen would under-fire and LlamaIndex
might not label RAG were **wrong** — good news. The chain/agent detector scope
already covers LangChain/LangGraph/DSPy/CrewAI/AutoGen/LlamaIndex as first-class.
Counts: LlamaIndex 35 RAG pipelines; CrewAI 1714 agent (1542 tagged); AutoGen 575
agent (566 tagged); LangChain 184 RAG pipelines (the "fully lit" reference). RAG
pipeline shapes are sensible: `chunking -> embed -> vector-store -> search ->
llm-call -> agent`.

### Reasoning is a *structural* gap, not a coverage gap
Tree-of-Thoughts scored **0** across tools/chains/embeddings/pipelines; Reflexion
matched only the literal `ReAct` token. Reasoning (CoT/ToT/reflection) is
expressed as **prompt strings + plain control flow**, with no framework
primitives to anchor on — adding a framework won't help. The signal lives in the
Prompts/vocabulary layer (`cot_prompt_wrap`, `self_reflection_completion_instruction`),
so the fix is prompt-pattern mining (#141); a dedicated reasoning accordion is
**future-listed**, not built now.

### Skip (too generic / absent)
tokenizer, weights, regression, base model, hyperparameter, supervised,
feature-extraction (light up nearly everything); 0-code: diffusion (here),
autoencoder, vector space, gradient descent, generative adversarial, perceptron,
AlexNet, DeepDream.

## Insight: `--vocabulary` is an automatic census
CE's `--vocabulary` (TF-IDF term surfacing) reproduced this manual regex census
automatically — surfacing the diagnostic indicia per repo (`ChainOfThought` in
dspy, `OpenAIEmbeddings` in langchain, `VectorStoreQueryResult` in llama_index,
`/crewai/rag/` in CrewAI, `autogen_agentchat`/`OpenAIChatAgent` in autogen,
`cot_prompt_wrap` in ToT, `self_reflection_completion_instruction` in reflexion).

**Future feature:** cross-index vocabulary clustering -> auto-suggested detector
keywords. Run `--vocabulary` across many indexes, cluster the AI/ML-ish terms by
co-occurrence, and propose keyword candidates — closing the loop on the hand-run
census. **Caveat:** in a *small* repo, vocabulary surfaces the task/benchmark
domain, not the technique (Reflexion's ALFWorld vocab: coffeemachine /
laundryhamper / towelholder), so a targeted regex census complements vocabulary
rather than replacing it.

## Test corpus & scorecard
RAG -> **LlamaIndex**; agents -> **CrewAI**, **AutoGen**; reasoning ->
**Tree-of-Thoughts**, **Reflexion**; baselines **langchain** (agents), **dspy**
(reasoning).

| repo | predicted | actual |
|---|---|---|
| LlamaIndex | RAG maybe unlabeled | 35 RAG pipelines, 1583 embed |
| CrewAI | shallow | 1714 agent (1542 tagged) |
| AutoGen | worse | 575 agent (566 tagged) |
| Tree of Thoughts | dim | 0 across all four |
| Reflexion | dim | only ReAct (2) |

## Pointers
- Tool: `census.py` (`-x` / `-c` / `-p`).
- Issues: #140 (accordions), #141 (improvements); roadmap #133; AI/ML feature
  track #84; regex case-sensitivity bug #138.
