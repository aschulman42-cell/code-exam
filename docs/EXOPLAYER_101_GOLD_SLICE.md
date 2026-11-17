# ExoPlayer: a provisional gold slice for claim 1 of 8752101

This is an R&D evidence key, not a legal conclusion and not a claim that the patent reads
on ExoPlayer. It records what the examined ExoPlayer index and source archive show for one
claim, so future CodeExam retrieval and local-model experiments can be scored against a
small, explicit target.

## Provenance and scope

- Claim input: `8752101_claim_1.txt` in the working corpus.
- Indexed target: `.AndroidX_Media_ExoPlayer3`.
- Retrieval artifacts: `embed_distance_101_ExoPlayer_function_text.txt` and
  `embed_distance_101_REWORDED_ExoPlayer_function_text.txt`.
- Source reviewed: `media-release-exoplayer.zip`, using the paths and line ranges recorded
  below. The archive is the source corpus represented by the index.
- The target is ExoPlayer 3 as indexed; `NOT_SHOWN` means not shown in this examined target,
  not proof that the functionality cannot exist in another module, version, or repository.

The earlier CE experiments used `AdaptiveTrackSelection` as a proxy for whether the system
could find relevant code for this claim. That was a useful retrieval target supplied by the
experiment, not an independently established gold answer. Source review confirms that the
class is relevant to the bitrate-selection portion of the claim, while also showing that it
does not implement the claim's transmitter-side system as a whole.

## Labels

- **SUPPORTED**: the examined code directly implements the technical behavior described,
  subject to the claim's broader legal interpretation not being assessed here.
- **PARTIAL**: some important behavior is present, but a required condition, actor, or
  relationship is different or not established.
- **ARCHITECTURAL MISMATCH**: the code performs a related operation on a different actor or
  at a different boundary, such as receiver-side selection instead of transmitter-side
  encoding.
- **NOT_SHOWN**: the examined index and source review did not establish the limitation.

## Claim elements and reviewed evidence

### 1. Distribution system with transmission and reception devices able to communicate

**Assessment: NOT_SHOWN.**

The examined ExoPlayer material clearly represents playback and reception-side processing.
This review did not establish a paired transmission device implementing the claimed
distribution system. Network/data-source code may receive content, but that is not evidence
of the claimed transmitter-receiver combination by itself.

**Useful candidates to inspect, but not gold evidence:** the indexed upstream/data-source
families and the player-internal loading path. Their presence would establish a lead, not this
whole element.

### 2. A transmission device transmitting content data

**Assessment: NOT_SHOWN.**

The relevant ExoPlayer path consumes media data for playback. The reviewed code does not show
an encoder or transmitting unit that sends the content data described by this claim. A
`DataSource` or HTTP client receiving bytes should not be promoted to transmitter evidence.

### 3. One content coded at one of multiple different code rates

**Assessment: SUPPORTED, with a terminology bridge.**

The code uses `Format` objects with bitrate values and chooses among available formats. The
closest reviewed evidence is:

- `AdaptiveTrackSelection::determineIdealSelectedIndex`,
  `.../trackselection/AdaptiveTrackSelection.java:599-613`;
- the method computes `effectiveBitrate`, examines each format's `format.bitrate`, and returns
  a selectable format index;
- `AdaptiveTrackSelection::updateSelectedTrack`, same file, `:437-465`, coordinates the
  update and invokes the ideal-index calculation.

This is the important claim/code register bridge: the claim says **code rate**, while the
implementation exposes **format bitrate** and adaptive track selection. It is a strong
implementation correspondence, but not evidence that ExoPlayer is the claim's transmitting
encoder.

### 4. Reception stores received content data and reproduces content based on stored data

**Assessment: SUPPORTED, distributed across the playback pipeline.**

The evidence is not one mechanism. The reviewed path includes:

- `AdaptiveTrackSelection::updateSelectedTrack`,
  `.../trackselection/AdaptiveTrackSelection.java:437-465`, receiving
  `bufferedDurationUs`, a queue of media chunks, and chunk iterators;
- `ExoPlayerImplInternal::updateLoadControlTrackSelection`,
  `.../ExoPlayerImplInternal.java:3452-3481`, computing total buffered duration and passing it
  to `LoadControl` along with the selected tracks;
- `DefaultLoadControl::shouldStartPlayback`,
  `.../DefaultLoadControl.java:798-815`, using buffered playout duration and configured buffer
  thresholds to decide whether playback can start.

Together these support reception, buffering, track selection, and playback control. They are
deliberately recorded as a set because no single `AdaptiveTrackSelection` mechanism contains
the whole limitation.

### 5. A code-rate determining unit determines the rate from remaining time before playback
and available playback time

**Assessment: PARTIAL / ARCHITECTURAL MISMATCH.**

ExoPlayer does use timing and buffer-related quantities, but the reviewed implementation does
not establish the claim's exact condition of remaining time before a set reproduction start
time. Relevant nearby evidence is:

- `AdaptiveTrackSelection::updateSelectedTrack`, `:437-465`, which receives
  `bufferedDurationUs` and `availableDurationUs`;
- `AdaptiveTrackSelection::minDurationForQualityIncreaseUs`, `:615-630`, which adjusts a
  minimum duration using available duration and, for live content, subtracts a chunk duration;
- `AdaptiveTrackSelection::getNextChunkDurationUs`, `:637-653`, which estimates the next
  chunk duration from the selected format, another format, or the queue;
- `determineIdealSelectedIndex`, `:599-613`, which ultimately selects by effective bandwidth
  and format bitrate.

These are plausible implementation neighbors, but they should not be labeled as proof of the
claim's remaining-time-before-start formula. The distinction is a useful test for a local model:
it must identify related timing logic without silently upgrading it to the claimed condition.

### 6. The transmitting unit changes the transmitted content to the determined code rate

**Assessment: ARCHITECTURAL MISMATCH.**

`AdaptiveTrackSelection` changes the selected playback representation/track on the receiver
side. It does not transmit content or re-encode the transmitted content. The selection evidence
is relevant to adaptive bitrate playback, but the actor and operation differ from the claim's
transmitter-side language.

### 7. The reproducing unit starts reproduction at the set reproduction start time

**Assessment: PARTIAL / NOT_SHOWN AS WRITTEN.**

`DefaultLoadControl::shouldStartPlayback`, `.../DefaultLoadControl.java:798-815`, decides
whether playback should start based on buffered duration, playback speed, rebuffering state,
live offset, and buffer-byte thresholds. That is strong evidence of a buffer-gated playback
start decision. It does not, by itself, establish a designated reproduction start time of the
kind stated in the claim.

## Retrieval proxy versus gold evidence

`AdaptiveTrackSelection` was selected in the earlier experiments because it was the user's
known or suspected relevant family and was passed to CE with `--filter`. The retrieval output
showed multiple entries for that class, including entries holding `updateSelectedTrack` and
`determineIdealSelectedIndex`. That made it a good proxy for asking whether CE could reach a
known relevant area of the codebase.

The review above narrows the conclusion:

- `determineIdealSelectedIndex` is primary evidence for adaptive selection by bitrate;
- `updateSelectedTrack` is coordinating/supporting evidence that connects buffer and chunk
  state to that selection;
- `DefaultLoadControl` and `ExoPlayerImplInternal` are separately needed for playback-buffer
  and start-control evidence;
- none of those functions alone is the gold answer to claim 1;
- the transmitter-side portions remain unsupported or architecturally mismatched in the
  examined target.

## How to use this slice

Future experiments should score at least three separate capabilities:

1. **Area retrieval:** does CE reach the AdaptiveTrackSelection, LoadControl, and player-internal
   families from the claim language?
2. **Evidence recall:** does the shortlist contain the reviewed primary/supporting functions?
3. **Evidence reading:** does a local model distinguish supported bitrate selection from the
   absent transmitter-side encoding and the unproven start-time condition?

A useful local-GGUF result need not produce a final claim chart. It should be able to return the
candidate evidence, identify the register bridge (`code rate` / `bitrate`), preserve the
receiver/transmitter mismatch, and state what the examined target does not establish.
