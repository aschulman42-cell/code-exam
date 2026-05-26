# xmlui-prompt-catalog

XMLUI implementation of CodeExam's prompts catalog feature: prompt list + source viewer, bound to a running CodeExam server's `/api/indexes`, `/api/prompts`, `/api/extract-linkified` routes.

## Run

```
python -m http.server 8080   # from this directory
```

Then open `http://localhost:8080`. Requires a CodeExam server running on `localhost:3000` (configurable via the Server textbox).

## Experiments run between v2 of the feasibility study and the Thursday/Saturday meeting with Jon

See parent feasibility doc at `docs/xmlui-code-exam.md` and issue #73.

### Step 1 — `Items` → `List` with `fixedItemSize="true"`

Replaced the outer `<Items data="{sourceData.value.lines}">` in the source viewer with `<List data="{...}" fixedItemSize="true">`. Inner per-segment `<Items>` loop kept for now.

**Result**: necessary but not sufficient. Cleared the OOM crash on small-to-moderate functions, but `cB` in `public/vendor/mermaid.min.js` (18,445 lines) still stalled — content rendered for the first few hundred lines, then white space past some scroll position. Diagnostic via `curl`:

- Response: 1.4 MB JSON, all 18,445 lines delivered, 27,657 total segments (mean 1.5 segments/line — *not* a per-segment-count explosion).
- **First line is 3,431 chars** — minified `var` declaration list. With `fixedItemSize="true"`, XMLUI measures the first row's geometry and uses it for all rows; the outlier first row likely throws scroll-height math off after a few hundred rows.

### Step 2 (pragmatic) — single `<Text>` per line, segments joined client-side

Replaced inner `<HStack><Items data="{$item.segments}">…</Items></HStack>` with one `<Text>` per `<List>` row containing `{$item.segments.map(s => s.text).join('')}`. Trade-off: **clickable identifiers within rendered source are lost** in this version. Left-pane prompt clicks and back/forward nav still work.

**Result**: scroll wall broken. `cB`'s 18,445 lines now scrolls all the way through; brief white-space during rapid drags, content repaints briskly. Confirms: the per-segment HStack + Items render was the scroll bottleneck.

Full Step 2 (`wrapComponent` registering a React component that takes pre-rendered HTML with delegated `[data-id]` clicks per Jon's Q3 gist answer) was attempted but **`wrapComponent` is not exposed as a public global** in `xmlui-0.12.15.js`'s standalone script-tag build. `window.React` and `window.jsxRuntime` are exposed, but the registration function lives inside the bundle and is reachable only via XMLUI CLI's build pipeline. Recovering linkified clicks needs either (a) switching the app to the CLI build setup, or (b) a different API XMLUI exposes for runtime extension. Thursday topic.

### Step 3 — ARIA / semantic-trace fix

**Not attempted in this session.** Hit the time budget on Steps 1+2 plus the new findings below. The user observation during testing — *"This is when that semantic tracing would be useful"* (re: the unresponsive Word Wrap toggle on the big file) — is independent confirmation of why Step 3 matters.

## Unexpected findings

### 1. Indent collapse is NOT a flex-layout problem

Leading whitespace was disappearing from rendered source lines. Initial hypothesis: `<HStack>` flex layout collapsing whitespace between per-segment children. Step 2's pragmatic edit removes the `<HStack>` entirely — single `<Text>` per line, body content is `{$item.segments.map(s => s.text).join('')}`.

**Indent still disappears.** Server *is* preserving whitespace (verified via `curl`); the segment text strings have full leading spaces. XMLUI's `<Text>` with `style="{{ whiteSpace: 'pre' }}"` is somehow not getting that style to the DOM node that contains the text content. Worth surfacing as its own question — may be Text-body-parsing behavior, may be a CSS layering issue.

### 2. Word wrap toggle is unreliable

The `Word wrap` `<Switch>` in the source pane's top bar binds to a `var.wordWrap` state and is referenced in inline styles on the source render. Observed behavior:

- Sometimes appears to be a no-op (same render with and without).
- Once locked up the page entirely when toggled on a big file's open render.
- Behavior is inconsistent across reloads.

Almost certainly a reactivity / re-render-triggering question — and exactly the kind of thing Inspector + semantic trace would diagnose at a glance.

### 3. Data-size vs render-size are separate concerns

Initial framing (v2 §1) emphasized rendering as *the* perf wall. The cB test surfaced a layering: even with virtualization fixed, the entire JSON payload (1.4 MB for cB; could be 50–100 MB+ for true cli.js-scale functions) sits in `sourceData.value.lines` in memory. Step 2's win is the render layer; data-layer windowing (server-side pagination of `/api/extract-linkified`) would be a separate concern that becomes the next bottleneck on full-cli.js-scale functions.

## Questions for Thursday with Jon

1. **`wrapComponent` in a no-npm app**: is there an exposed runtime API, or does the project need to migrate to the XMLUI CLI build pipeline to use real wrapComponent? Either is fine to know; planning depends on it.
2. **Indent collapse**: why does `<Text style="{{ whiteSpace: 'pre' }}">` with monospace body content not preserve leading whitespace? Is `<Text>` running the body through a text-normalization step we need to opt out of?
3. **Word wrap toggle unreliability**: trace via Inspector → expected to identify which event isn't ARIA-labeled or which reactivity update is being missed. Step 3 entry point.
4. **Data-layer windowing**: any precedent in XMLUI-built apps for paginated infinite-scroll-style data loading via `DataSource`, or is that an application-level concern?

## State of the source viewer in this prototype

After Step 1 + pragmatic Step 2:

- Scrolls 18K-line functions smoothly.
- Loses in-source clickable identifiers (left-pane prompt clicks + back/forward still work).
- Loses leading-whitespace indentation in rendered source (new finding — independent of the render approach).
- Toggling `Word wrap` mid-render of a big file is unreliable.

These trade-offs are spike-grade, not ship-grade. Real `wrapComponent` (Thursday) recovers in-source clicks; indent and wordwrap fixes are Thursday's diagnosis too.
