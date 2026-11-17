# Codex evidence-map prototype

Codex (GPT-5.6-Luna medium) contribution.

This is an isolated R&D prototype for a deterministic, provisional claim evidence map. It
uses CodeExam's local embedding and index data; it does not call GPT, Claude, a cloud service,
or a local chat model.

## Run

```text
node codex-tests/claim-evidence-map.mjs --ndx <index> --claim @<claim.txt>
node codex-tests/claim-evidence-map.mjs --ndx <index> --claim @<claim.txt> --top 12 --function-text --cpu
```

The report lists each claim element, the embedding head, a small lexical-name addition, the
candidate's mechanism members, and the cosine baseline/margin. It deliberately assigns no
`SUPPORTED`, `PARTIAL`, `ARCHITECTURAL_MISMATCH`, or `NOT_SHOWN` verdict. Those require a
separate reading step and, for a benchmark, a reviewed evidence key.

## What the first ExoPlayer run taught us

1. The report format is a useful provisional evidence map: it puts each claim element beside
   ranked candidates, members, lexical hits, scores, margins, and an explicit no-verdict
   warning.
2. The ExoPlayer index already held reusable Gemma and Nomic label/member, chunk, and
   function-text caches. The Gemma run reused its cache and completed immediately.
3. The Nomic function-text path exposed a prototype bug when a vector was missing or had to be
   refreshed: the function-vector cache was written as ordinary numeric arrays instead of the
   compact representation used by CodeExam's normal path, causing `Invalid string length`.
   This is a prototype defect, not evidence about Nomic or ExoPlayer retrieval.
4. With Gemma and function text, the report surfaced related playback code, including
   `DefaultLoadControl::shouldStartPlayback`, but did not surface the known
   `AdaptiveTrackSelection`, `determineIdealSelectedIndex`, `updateSelectedTrack`, or
   `ExoPlayerImplInternal` families in the retained candidate menus. Generic terms such as
   `start`, `time`, `content`, and `rate` pulled in broad entries and tests.
5. That result motivates the separate concept/TOC feasibility test: the codebase contains a
   coherent family around adaptive track selection, bitrate/format choice, bandwidth
   estimation, and playback buffering, but raw mechanism ranking did not present that family
   together from the claim's language.

The intended next evaluation is therefore not another embedding-model contest. It is whether
a compact, deterministic concept menu can expose such related families at useful levels before
an optional local-GGUF reading step.

Generated reports stay outside the repository unless deliberately retained.

## Test

```text
node --test codex-tests/test_claim_evidence_map.js
```
