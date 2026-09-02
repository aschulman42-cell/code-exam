# Example indexes: ffmpeg, zlib, x265

First-run results and demo protocol for the three prospect-requested C
corpora. Numbers here are from the 2026-09-01/02 first-run program
(CE `v0.5.0`, commits through `99c88ae`); the production pass (~2026-09-09)
re-runs on then-current code and supersedes the figures, not the shape.

## The corpora

| index | files | functions | lines | character |
|---|---|---|---|---|
| `.zlib` | 175 | 1,169 | 54k | small core + contrib mirrors (minizip, DotZLib C#, win32) |
| `.x265` | 303 | 2,626 | 354k | C++ HEVC encoder; file ≈ class (`ratecontrol.cpp` = `RateControl`) |
| `.ffmpeg` | 5,434 | 43,739 | 2.15M | one-module-per-file C at scale (`libavcodec`, `libavformat`, …) |

## What CE produced, per corpus

**Deterministic (free, air-gap-safe)**: `--overview`, `--hotspots`,
call-trees (`Search::singleMotionEstimation` on x265,
`av_index_search_timestamp` on ffmpeg), and `--struct-dupes` on zlib —
which surfaces the corpus's twin implementations (`ioapi.c`/`iowin32.c`,
`inftrees.c`/`inftree9.c`) as a CE finding.

**Air-gapped AI (local GGUF, pure CPU, Qwen3-4B, ~6 min/corpus)**:
`--overview-by-ai` produced coherent orientations for all three —
zlib's names `inflate`/`deflate_fast` as the core and independently
flags the contrib territory; x265's identifies the HEVC/SIMD character;
ffmpeg's reads the `libav*` multi-library structure.

**Pseudo-claim loop (the self-test)**: claims drafted blind from each
corpus's own code, then charted blind; the drafted anchors are the
answer key. First-run scores (4 picks/corpus, orig wording):

| corpus | file-level re-surfacing | mean strict recall | control false-PRESENT |
|---|---|---|---|
| ffmpeg | 6/7 | 0.33 (one claim at 1.00) | 0 |
| x265 | 3/4 | 0.28 (`RateControl` 0.50, `Lookahead` 0.40) | 0 |
| zlib | 4/8 | 0.15 | 0 |

Honest calibration, both directions: a 13-row audit of "miss" rows
found 10 fully defensible citations and 3 judge-flagged near-misses —
strict single-function recall materially understates usefulness (zlib's
biggest "misses" cited the canonical implementation while the answer
key sat in a twin copy). Conversely, synonymized wording drops recall
everywhere, hardest on ffmpeg (0.33 → 0.07): C API vocabulary
(`pts`, `dct`, `avpriv`) is a synonym desert, which is why dependent
species-word donation (landed) and multi-run retrieval merge (queued)
exist.

## Production protocol (Sept-9 pass)

Declared before the run, published beside the full population numbers —
a sampling frame, not a cherry-pick:

1. Picks come from FILE-SEEDED and core-directory groups (the first
   run's uniform spacing over-drew "/ other" residue subgroups — 3 of 4
   picks on both x265 and ffmpeg — the profile measured weakest on
   every corpus).
2. zlib drafts from the core, not contrib; its chart ships beside the
   `--struct-dupes` artifact so the twin surfaces are a shown finding.
3. Every artifact states the frame; the first-run table above stays in
   the record.
4. GGUF/GPU replication (asus-CC) runs the same recipe end-to-end with
   `--model <gguf>`; see #311.

## Reproduce

Candidates → drafts → loop, per `docs/claims-pipeline-state.md` §10:

    node src/index.js --index-path .zlib --pseudo-claims --candidates cand.txt
    node src/index.js --index-path .zlib --pseudo-claims @cand.txt --claims-only claims.txt --llm claude
    node scripts/pseudo-claim-loop.mjs --claims picks.txt --source claims.txt --index .zlib --control .sr_gh --llm claude
