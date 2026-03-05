# Code Exam — Testing Notes

Observations from testing various features. Reference material for future development.

---

## Spinellis Java Codebase (via --claim-analyze)

- **claim-analyze pipeline validated**: pseudo claim "The method of http request and response, using a servlet and a cookie" correctly found AuthenticatorBase::register and CookieExample::doGet, Claude produced element-by-element coverage analysis
- **(global) bug found and fixed**: multisect sort by lines put 0-line globals first; filtered before LLM extraction

## Self-Analysis (code-exam Node.js source)

- **/analyze with --use-claude works well** for understanding unfamiliar code
- **User wants /chat RAG**: free-form questions like "What file handles structural dupe comparison?" — current /analyze requires knowing the function name already
- **Vocabulary signal improved** by including comments/strings — domain terms in JSDoc/SQL were being lost

## Local LLM Testing (2026-02-22)

- **Qwen2.5-Coder 7B Q4_K_M**: Best 7B model tested. Structured output, correct algorithmic identification, 32K native context. ~2 min for 14-line function on constrained laptop, ~2 min for 287-line function. Usable for air-gapped deployment.
- **DeepSeek-Coder 6.7B Q4_K_M**: Narrates line-by-line, verbose, occasionally overstates (called data reorganization "hashing-based algorithm"). ~5 min per analysis.
- **CodeLlama 7B/13B**: Weakest. 13B didn't meaningfully improve over 7B. Superseded by all newer models.

## Recurring Concerns

- **LLM overstatement**: All models (including Claude) tend to infer purpose from identifier/comment names rather than from actual operations. `_buildFileDupeLookup` doesn't hash anything but models say "hash-based deduplication." Masking would help but Layer 3 (identifier masking) is deferred.
- **Argparse false positives in claim-analyze**: Argument parser functions match many terms because they *describe* features without *implementing* them. May need heuristic to deprioritize argparse/config functions, or user needs to learn to use `--exclude-path` for these.
- **Context size is the key constraint**: 4096 tokens on constrained hardware; 8192 failed for DeepSeek. Qwen's 32K native context is transformative — need better hardware to exploit it.
