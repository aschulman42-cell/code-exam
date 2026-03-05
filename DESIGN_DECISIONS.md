# Code Exam — Key Design Decisions

**Status: Incomplete — see TODO #263 for expanding this list.**

This file captures architectural decisions and their rationale. It is reference material, not a TODO list.

---

## Term extraction is decoupled from analysis LLM

claim.js `extractClaimTerms` may later use embeddings or a small specialized model instead of Claude. Keep decoupled from analyze.js's `AnalysisLLM`.

## Vocabulary includes comments and strings

Domain terms appear in JSDoc, docstrings, SQL queries, error messages. Stripping them lost valuable signal. The stopword filter and frequency cutoffs handle generic words.

## (global) scope entries are filtered before LLM analysis

They exist in multisect results but are filtered out before LLM analysis (0 lines, not extractable).

## SimpleMasker layers: L1 + L2 shipped, L3 deferred

L1 (comments) + L2 (strings) are implemented. L3 (full identifier masking) is deferred — even Python's --mask-all leaves hints, and the complexity (~400 lines of regex) has diminishing returns.

## Air-gapped first

All features must work without network access. `--use-claude` is a convenience for development/testing, not the target deployment. In litigation context, sending code to external APIs is prohibited.
