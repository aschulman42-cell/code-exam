# The CodeExam GUI

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part C pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

- **GUI** — `node src/server.js --port 3000` opens a multi-pane interface
  served from **localhost only** (no remote access, no outbound network
  calls). Called "GUI" rather than "browser UI" because nothing about it is
  web-facing — it just happens to render in a local browser. Left pane:
  function/file/class accordions and other catalogs. Middle-top: output.
  Middle-bottom: source viewer with linkified call sites. A **Workspace**
  area collects what you're actively examining. Mermaid call trees and
  file-coupling diagrams render inline. The GUI is gradually moving toward a
  newer design with less of a fixed three-pane layout (the goal being that many
  features operate as semi-independent mini-apps — so that, for example,
  multiple instances of a feature can run side-by-side for comparison, and
  long-running operations proceed on their own threads).

![CodeExam file-map view](CodeExam_file_map_042526.jpg)

*File-map view (April 2026 — slightly out of date, but representative).*

## Symbols & notation

CodeExam's lists and digests use a few compact markers, consistently across
the GUI accordions and the CLI:

- **`~` (leading tilde, muted text)** — a **heuristic-tier** finding, as
  opposed to a mechanical or structural one. Used throughout the AI/ML cells
  (Artifacts, Kernels, Training, Inference, Multimodal, Post-training,
  Reasoning, …) to keep the mechanical-vs-heuristic distinction visible
  rather than presenting every hit with equal confidence.
- **`[lib?]`** — a **library-vs-consumer** flag on an LLM-call site: the
  detector suspects it is firing on an SDK's *own* source rather than on code
  that *uses* the SDK (an over-fire to verify).
- **`×N`** (and `N×`) — an **occurrence / instance count**: how many raw
  sites collapsed into a deduped row (e.g. `act_quant_kernel ×4`), how many
  identical pipelines or duplicate bodies were grouped, or how many times a
  string occurs within one function (`×3 here` in a digest).
- **Accordion badge counts** — where a cell has both, the badge shows
  *instances* (the pre-dedup site count) rather than the smaller deduped row
  count, so a "more than meets the eye" cell is visible at a glance.
- **`?`** — an unknown / unlabeled family or grouping key (a fallback used
  when the detector couldn't assign one).

**Test / example handling.** Sites in test, example, benchmark, or demo code
can inflate counts and dilute the "real" usage signal. By default CodeExam
**shows** them: in the AI/ML cells, a row whose every site is test/example
code is **dimmed** (and its tooltip notes `[test/example code]`) rather than
hidden. You can opt to drop them entirely:

- **View → Exclude Tests** in the GUI, or `--no-tests` on the CLI — remove
  AI/ML rows whose every site is test/example code (tests, examples,
  benchmarks, demos dirs; `test_*` files). A "*N test/example rows hidden*"
  note then reports what was dropped.
- `--exclude-tests` — exclude test files from caller / metrics results.

(There is no inline `[test]` text badge: the visible signal for a *kept* test
row is dimming plus the tooltip note. Likewise, unresolved identifiers — e.g.
a model passed as a variable rather than a string literal — are shown with
the identifier plus an "unresolved" note in the tooltip, not a special
glyph.)

*Per-menu / per-accordion / per-pane descriptions and screenshots (an `imgs/` folder) land here in Part C.*
