# Concept/TOC feasibility test

This isolated experiment asks a narrower question than a claim chart: can CodeExam
make a small, inspectable menu of code concepts that gathers related mechanisms,
members, files, and call relationships before anyone assigns a claim assessment?

Run focused tests with:

```text
node --test test/codex-tests/test_concept_toc.js
```

Run it against the ExoPlayer index with a locally cached embedding model:

```text
node test/codex-tests/concept-toc.mjs --ndx .AndroidX_Media_ExoPlayer3 --claim @8752101_claim_1.txt --top 12 --embed-model gemma
```

The default is a compact decision view: six direct mechanisms and three concept
cards per claim element. Add `--verbose-menu` when exploring the complete
top-`N` concept-card menu.

The output has three intentionally visible levels:

1. **Concept** — a deterministic vocabulary lane such as `adaptive`, `bitrate`,
   `bandwidth`, or `buffer`.
2. **Mechanism entries** — the indexed class/token/file records contributing to
   that lane.
3. **Members and relationships** — concrete `file@function` names and available
   outbound calls.

Cards are built from the mechanisms index and ranked by local embedding cosine
combined with lexical overlap. The script does not call GPT, Claude, a cloud
service, or a local chat model, and it deliberately assigns no `SUPPORTED`,
`PARTIAL`, `ARCHITECTURAL_MISMATCH`, or `NOT_SHOWN` verdicts. Generated live
reports should remain outside the repository.

Embedding input is compacted to a deterministic 1,200-character budget per card.
The complete indexed entries remain available to the report renderer; the budget
only prevents a broad vocabulary lane from exceeding a small local model's
context window.

Vocabulary lanes are seeded from labels, descriptions, purposes, and member
names—not path or call-list boilerplate. Generic lanes are suppressed, but broad
non-generic lanes remain eligible with bounded representative embedding evidence.
The mechanisms printed under a surviving card are re-ranked for the claim element
and only a small expansion is rendered, so a direct symbol such as
`AdaptiveTrackSelection` is not hidden behind the index's original record order or
a giant card dump.

The report also has a separate **direct mechanism lane**. It ranks compact
label/member entry text independently of the concept-card ranking, using local
embedding similarity plus lexical and subtoken matches (`rate` can match
`bitrate`). This is intended to keep concrete symbols visible even when the
broader concept menu favors generic vocabulary.

The direct lane first selects at most 200 lexical/subtoken candidates per claim
element and embeds that small union, rather than embedding every mechanism in a
large index. By default the direct lane is lexical/subtoken-only, so it is
immediate and air-gap friendly; add `--direct-embed` to request local semantic
reranking of that bounded pool when the extra runtime is worthwhile. This
bounded preselection is important for air-gapped runs with a small local model.

For the ExoPlayer check, look for whether a compact menu brings together a family
such as `AdaptiveTrackSelection`, `Format.bitrate`, bandwidth estimation, and
playback buffering even when a flat mechanism top-12 list misses one of them.
That would support a future product feature; failure would help separate a menu
coverage problem from a missing claim-to-code semantic bridge.

The experiment is intentionally small and deterministic enough to run in an
air-gapped deployment. Embeddings improve ranking but are not a cloud dependency;
the same card builder and lexical ranking remain testable without a model.

## Feasibility conclusion

The ExoPlayer claim-1 run is a negative feasibility result for this approach,
not a claim that the codebase lacks the relevant behavior. The compact report
became easier to inspect, and the direct lane sometimes surfaced plausible
rate/time mechanisms such as `RepresentationHolder` and
`ConstantBitrateSeeker`. But the concept and direct lanes mostly ranked generic
claim vocabulary, and did not reliably surface the specific family we expected:
`AdaptiveTrackSelection`, `Format.bitrate`, `DefaultLoadControl`,
`shouldStartPlayback`, and `BandwidthMeter`.

The reason is structural: the claim uses language such as code rate, available
reproduction time, and reproduction start, while the implementation expresses
related ideas through different symbols and distributed mechanisms. Local
embeddings, lexical overlap, and a compact vocabulary menu did not supply that
missing semantic bridge. More tuning of card size, report layout, or rank
weights is unlikely to change the result materially.

This experiment therefore should not be treated as a path to claim charts by
itself. A future productive step would need code-derived concept metadata,
reviewed semantic anchors, or a separate semantic-interpretation stage. Those
options may still be compatible with an air-gapped deployment, but they are a
different problem from making a deterministic concept TOC.
