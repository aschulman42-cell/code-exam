# Engine qualification

An engine's chart quality is not a given — it is a measurable
qualification, run once per engine/build before its charts are trusted.
The procedure is asus-CC's two-claim rubric (#311), formalized; credit
to asus-CC, whose RUN22 supplied the motivating FAIL.

## The pair

1. **True negative** — US 8,752,101 claim 1 + dependents against
   `.AndroidX_Media_ExoPlayer3` (client-only corpus; the transmitting-
   device rows are ABSENT by construction). FAIL if the merged claim-1
   rows contain **zero ABSENT** (the trivial-baseline shape: a chart
   that discriminates less scoring better on spread), or any PRESENT
   rests on lone support at 1 of ≥ 20 targets.
2. **True positive** — the TLS demo claim against `.demo`. FAIL if
   fewer than 6 merged rows are PRESENT.

Run both, per engine, per build:

    node src/index.js --index-path <idx> --claim-chart @<claim> [--claim-family] --llm <X>|--model <gguf> --verdicts-out <out>.json
    node scripts/engine-qualify.mjs --negative <101>.verdicts.json --positive <tls>.verdicts.json --engine <label>

Scoring is mechanical (sidecars only). The verdict block appends to the
register below.

## Register

| engine | test | verdict | detail |
|---|---|---|---|
| Gemma3-12B (RUN21/22 era, a8801bf) | negative | PASS | 4/7 ABSENT; crux cited |
| Gemma3-12B | positive | PASS | 10/11 PRESENT |
| Qwen3-14B (RUN22, a8801bf) | negative | **FAIL** | 0/7 ABSENT — trivial-baseline shape; lone PRESENT 1 of 30 |
| Claude sonnet-4-6 (XENG, a8801bf) | negative | PASS | 2/7 ABSENT; crux cited rows 2/4/5 |
| ChatGPT gpt-5.1 (XENG) | negative | PASS* | 3/7 ABSENT; *crux never retrieved — qualified for verdicts, blind at retrieval |
| Gemini (XENG) | negative | PASS* | 1/7 ABSENT; false PRESENT MidiDecoder; *crux never retrieved |

`*` = passes the verdict criteria while never retrieving the known
implementer; retrieval blindness is disclosed, not scored — the pair
tests judging discipline, and retrieval quality is measured by the loop
(docs/claims-pipeline-state.md §10).
