# Migrating CodeExam's GUI to XMLUI — feasibility study v2

**Status**: research / discussion document, written 2026-05-25. Iterates on
v1 (by Jon Udell's Claude) — preserved in full at
https://gist.github.com/judell/2a06d113a2597414871b3bf264ccce22 and
locally at `code-exam-xmlui/xmlui-code-exam.md` (uncommitted). v1 is
worth reading; this v2 is a delta on it, not a replacement. No migration
commitment — see issue #73 for framing.

---

## TL;DR delta from v1

1. **Performance is less scary than v1 implied — but only if you avoid `Items`.** The April 2026 prototype's perf wall was a design choice (using `<Items>` for the source-viewer's line-by-line, segment-by-segment render), not an XMLUI limitation. XMLUI's `List` and `Table` are explicitly virtualized; `Items` explicitly is not (docs: "more than a few dozen, use List and Table"). The source viewer is rebuildable on `List`. (Section 1.)
2. **v1's evidence base is current, but its narrative under-credits the #4 modularization that already happened.** The numbers are right; the framing of `public/` as a monolith is wrong. (Section 2.)
3. **Public/private carve (#23) doesn't break under XMLUI** but introduces shape constraints on how the component tree gets allowlisted. (Section 3.)
4. **#38's three refactors don't disappear under XMLUI; their shape changes.** Component-scoped state replaces the per-panel state factory; declarative prop passing replaces the host-services bag; DOM scoping is largely subsumed. Floating panels vs OS-level windows stays an open CE-side decision. (Section 4.)
5. **Air-gap is fine; bundle is auditable. Demonstration is a public-version feature.** (Section 5.)
6. **The defining question is not "does XMLUI work for CodeExam?" but "do we replicate today's 3-col-plus-workspace, or wait for #38 to settle the layout first?"** v2's recommendation: build a small *primitive-coverage* shell, not a layout replica. (Section 6 — load-bearing.)

---

## 1. Empirical signal from the prior prototypes

### `xmlui-prompt-catalog/` (April 2026, single-file 224-line `Main.xmlui`)

The prototype implemented CodeExam's prompts-catalog feature as a single-page XMLUI app: prompt list on the left (filter + sort), source viewer on the right, both bound to three `DataSource`s pointing at the CodeExam server's `/api/indexes`, `/api/prompts`, `/api/extract-linkified`. Tested primarily against `cli.js` (~500K LOC). Hit a performance wall.

**What the prototype did for the source viewer:**

```xml
<Items data="{sourceData.value.lines}">
  <HStack ...>
    <Items data="{$item.segments}">
      <Link when="{$item.isCall}" ... />
      <Text when="{!$item.isCall}" ... />
    </Items>
  </HStack>
</Items>
```

For a 10K-line file with ~30 segments per line, that materializes ~300K components in the XMLUI render tree. For `cli.js` itself (single-file source render), it's roughly an order of magnitude worse. This is exactly the case the XMLUI docs warn about:

> "The `Items` component does not use virtualization; it maps each data item into a component… If you plan to work with many items (more than a few dozen), use the `List` and `Table` components instead." ([docs](https://www.xmlui.org/docs/reference/components/Items))

**The fix is straightforward**: render each line via `List` (virtualized) instead of `Items`. The inner segment loop *can* stay as `Items` (per visible line, ~30 segments — well under the "few dozen" threshold), but a single rendered HTML-string-per-line with delegated click handlers via a custom component might be even better. That's the v2-or-later spike question (see section 6).

The prompt list itself used `<List>`, which IS virtualized — that part should have scaled. If filter+sort latency was also a problem, the culprit is the inline JS expression doing `filter().sort()` on every keystroke without debouncing; XMLUI doesn't fix that, the markup does.

**So the prototype's perf wall is a known and addressable design mistake, not an XMLUI ceiling.** v2 strongly recommends a spike that uses `List` for the source viewer before any migration commitment.

### CC + XMLUI MCP server on `C:\work\xmlui-demos\ipworkszip-gui\app/` (May 2026)

A second, smaller XMLUI experiment with Claude Code actively driving the XMLUI MCP server (`xmlui_search_howto`, `xmlui_component_docs`, `xmlui_examples`). The application itself isn't relevant — it ended up wrapping the demo in Express as a 1-hour-budget kludge, not a pattern to generalize. **Cite the process, not the architecture**: the MCP-driven discovery loop (agent asks for a component spec, gets a citation-backed answer with examples) is a real precedent for the kind of agent-coordination story v1 promised.

**Note**: `xmlui-prompt-catalog/` was *also* built with the XMLUI MCP server. The MCP-loop signal has two empirical anchors, not one.

---

## 2. v1 inventory holds; narrative under-credits #4

Verified `public/*.js` against current HEAD:

| file | v1 says | current | Δ |
|---|---:|---:|---:|
| `app.js` | 1009 | 1009 | — |
| `list-renderers.js` | 1044 | 1051 | +7 |
| `middle-pane.js` | 917 | 917 | — |
| `prompts-and-catalog.js` | 734 | 734 | — |
| `dialogs.js` | 730 | 730 | — |
| `mermaid.js` | 380 | 380 | — |
| `source-viewer.js` | 335 | 335 | — |
| `layout.js` | 323 | 323 | — |
| `console.js` | 284 | 284 | — |
| `context-menu.js` | 276 | 282 | +6 |
| `overlays.js` | 268 | 268 | — |
| `click-handlers.js` | 204 | 204 | — |
| `dom-utils.js` | 186 | 186 | — |
| `menu-bar.js` | 112 | 112 | — |
| `api.js` | 107 | 107 | — |
| `state.js` | 34 | 34 | — |
| `chat.html` | 271 | 271 | — |
| `index.html` | 490 | 490 | — |
| `style.css` | 279 | 279 | — |

v1's inventory is current. The "perhaps based on a pre-refactor snapshot" worry from the v1 review comments turns out not to apply — v1 was written against the post-#4-peel state.

**The framing correction is different.** v1 reads `public/` as a 7,500-line undifferentiated client-side mass. It's not. Issue #4 has already modularized `app.js` from 6,293 → 4,566 → 1009 lines along leaves/chrome boundaries, and those module boundaries are exactly the seams an XMLUI migration would respect. The `app_2.js`–`app_5.js` and `server_2.js`–`server_3.js` snapshots v1 cites as evidence of agent-coordination pain are repository orphans, not active artifacts. `CODE_EXAM_GUI_HANDOFF.md` is similarly less load-bearing than v1 implies — project conventions live in `CLAUDE.md` and per-session memory now.

The "agent edit blast radius" argument v1 makes still works in the abstract — fewer files touched per change, MCP-queryable docs, Inspector-driven debugging — but it should be argued from XMLUI's primitives, not from CodeExam's pre-modularization git history.

---

## 3. Public/private carve (Issue #23)

#23 establishes that the carve is **engine-based, not interface-based**: public = full CodeExam (CLI + GUI + MCP) with Claude-engine-only; private = adds local-GGUF backend and air-gap hardening. The carve is allowlist-not-denylist, on a fresh public repo with clean history.

**What this means for XMLUI:**

- **Component tree splits cleanly**. Most XMLUI surfaces (function lists, source viewer, search, multisect, prompts catalog, fingerprint, digests) are engine-agnostic — they consume server API responses, not Claude-vs-GGUF distinctions. They live on the public side untouched. Engine-specific UI (analyze panel's "use Claude / use local model" toggle, the local-model loading status, etc.) is allowlisted private-side.
- **Allowlist mechanics map to file-level membership**. `Main.xmlui` + the public `components/*.xmlui` go on the public side; private overlays add a parallel set on the private side. The clean way to express this is component composition: public `Main.xmlui` references components by name; private build substitutes private versions where they exist. No `if (publicBuild)` branches inside components.
- **Fresh-repo requirement still bites**. The XMLUI migration commits in this repo are not the public artifact; the public repo gets a curated subset of components with clean history regardless. This is a workflow concern, not an architectural one.
- **License compatibility**: XMLUI is Apache 2.0, which composes with the source-available licensing #23 contemplates for the public CodeExam.

No structural blocker.

---

## 4. #38 architectural refactors under XMLUI

#38 identifies three refactors required for TODO #320 (floating panels / windowing) on the *current* vanilla-JS GUI: DOM scoping, per-panel state factory, callback explosion. Plus an open decision: in-page floating panels vs OS-level browser windows.

| #38 item | Under XMLUI |
|---|---|
| **DOM scoping** (modules reach `$('#some-id')`; multi-panel collides) | **Largely subsumed.** XMLUI components don't reach into a global DOM. Each panel is a component instance with its own scope. No collision because there's no shared ID namespace to begin with. |
| **Per-panel state factory** (`state.js` singleton → `createPanelState()`) | **Subsumed.** XMLUI components have `var.x` declarations that are instance-scoped by construction. Two `<SourcePane>` instances have two independent state objects automatically. The factory pattern stops being a refactor and becomes the default. |
| **Callback explosion** (`{foo, bar, baz}` doesn't scale to mini-app surface area) | **Form change, not elimination.** Declarative prop passing in XMLUI markup replaces JS object bags, but the *services* a panel needs (filesystem, server proxy, find, save, focus, theming) still have to be wired somehow. XMLUI's pattern is App-level `DataSource` declarations referenced by id, plus event handlers on components. Less verbose than `{foo, bar, baz}`, but the same shape of decision: what services are panel-local vs app-global? |
| **In-page panels vs OS-level windows** (`window.open` + `postMessage`) | **Stays open, CE-side.** XMLUI has component-level conditional rendering and modal/dialog primitives but no first-class "open this panel in its own browser window" abstraction. Either mode is buildable; neither is free. This is a #38 design decision, not an XMLUI decision. |

**Bottom line for #38**: an XMLUI migration would *eliminate* two of the three refactors (DOM scoping, per-panel state factory) and *transform* the third (callback explosion → declarative props + DataSources). The in-page vs OS-level question is independent.

Worth noting back to #38: if XMLUI eats two of the three architectural refactors, the migration changes the cost-benefit of doing those refactors in vanilla JS first. Either (a) do them anyway as defensive prep that XMLUI partially obviates, or (b) skip them as redundant if XMLUI is committed-to. The latter saves work but assumes the XMLUI commitment.

---

## 5. Air-gap

Confirmed compatible (Jon's email reply on the v1 review noted XMLUI operation isn't inconsistent with air-gap and might reduce on-disk footprint).

**Audit checklist for v2 → spike → eventual commitment:**

- **Vendor the XMLUI runtime bundle** (single `.js`) into the CodeExam install. The README's "zero npm deps" framing becomes "one vendored runtime bundle, no npm install required at runtime" — a wording change, not a regression. Mermaid is already loaded this way.
- **Audit XMLUI built-ins for network-touching behavior** before vendoring. Telemetry, CDN font fetches, asset URLs — anything that phones home is disqualifying for air-gap. The Apache 2.0 source makes this auditable.
- **MCP server is server-side, not GUI-side** — it's a development-time tool for agents working *on* CodeExam, not a runtime dependency. Air-gap concern doesn't apply to it.
- **Demonstration value (public-version feature)**: an air-gapped CodeExam GUI running a local GGUF model with zero network egress is a strong public-version demo even though air-gap is nominally a private-version feature per #23. The GUI design should show this off cleanly — a visible "offline / local-LLM" badge in the header, perhaps.

---

## 6. Threading the needle — XMLUI implementation vs CE GUI redesign

**This is the load-bearing section.** Everything above this is fact-finding; this is the structural decision.

### The temptation

The fastest path to "something to play with and iterate on" is to take CodeExam's current 3-column-plus-workspace layout and 1:1 replicate it in XMLUI. The savings estimate v1 floated (~55–60% code reduction) is real for that target, and a working replica gives Andrew + Claude something concrete to interact with.

### Why it's probably the wrong target

**#38 GUI redesign will likely land on a fairly different overall look.** TODO #320 (parent of #38) describes floating panels, per-panel Save As / Find / lifecycle, the in-page vs OS-level pop-out question, multi-instance components ("two Compare windows side by side"). A faithful XMLUI replica of today's 3-col layout commits to a shape #38 will throw away.

**More importantly for Jon Udell's time budget**: replicating today's CE layout is *CE design work*, not *XMLUI implementation work*. Splitter composition, exact pane proportions, menubar dropdowns, footer mode selector — these are CodeExam-product decisions. Jon's leverage as XMLUI's author is on the primitives: virtualization scaling, component composition, MCP-loop ergonomics, Inspector trace coverage. Asking him to spec a 3-pane-plus-footer replica is not what he's optimally positioned to help with.

### What v2 recommends instead

Build a small **primitive-coverage shell**, not a layout replica. Exercises three load-bearing primitives against real CodeExam data:

1. **One virtualized data panel** — `List` (or `Table`) bound to the function-list endpoint for a 500K-LOC index. Confirms virtualization scales to CodeExam-sized payloads, with sort + filter + click-to-source.
2. **One source-render panel** — uses `List` for line virtualization (NOT `Items`, learning from the prototype). Renders 10K-line files smoothly. Optionally with linkified function-call segments via a custom component that delivers a single rendered HTML string per visible line with delegated click handling.
3. **One chart panel** — `<EChart>` bound to a real CodeExam metric (hotspot histogram or language pie). Confirms the chart pathway works.

These three exercise the primitives Jon can productively help with, **and they're throwaway-able under any #38 outcome.** Each one survives or doesn't on its own merits regardless of whether the final layout is 3-col-plus-workspace, floating panels, multi-window, or something else.

### What stays explicitly CE-side (don't ask Jon)

- Layout composition (`HSplitter`/`VSplitter` nesting for 3-pane + footer — *technical* question for Jon's lane, but the *which layout* question is CE's).
- Menubar IA (which menus, which items).
- Workspace footer mode selector design.
- Floating-panel vs fixed-pane decision (the #38 open question — stays CE-side).
- Multi-instance UX (two SourcePane instances side by side — a CE redesign question).
- Right-click context menu target-sensitivity dispatch.

### What the v2 shell answers vs leaves open

| Question | Answers? |
|---|---|
| Does XMLUI virtualization scale to 500K-LOC CodeExam payloads? | **Yes** (primitive panel #1). |
| Does `List` solve the source-viewer perf wall the April prototype hit? | **Yes** (primitive panel #2). |
| Is the Splitter nesting story workable for 3-pane + footer? | Partial — verify in the shell. v1's open question. |
| Does the MCP-driven agent loop feel right for CE-sized work? | **Yes** (the shell itself is built via the loop). |
| What does the final CE GUI *look like*? | **Out of scope.** That's #38's question, not v2's. |

---

## Recommendation

1. **Don't commit to migration yet.** Read v2, sit with it.
2. **If migration interest persists, build the three-panel primitive-coverage shell** as a separate spike (file as its own issue), against the actual CodeExam server, against a real 500K-LOC index. Time budget: ~1 week with Claude assistance, ~2–3 days if Jon participates on XMLUI specifics.
3. **Settle the #38 architectural questions in parallel, not in series.** If XMLUI eats two of the three refactors (section 4), and the shell shows virtualization works (section 1), then the migration decision and the #38 redesign decision converge. If either fails, they diverge and CE stays on vanilla JS while #38 plays out.
4. **Public/private carve concerns can be deferred** until after the shell — they're shape constraints on the eventual migration, not gates on the spike.

---

## Open questions for Jon (if he wants to engage)

- Does the **3-pane-plus-footer Splitter composition** work in practice? Not asking for a CE-specific layout, asking whether `HSplitter` and `VSplitter` nest cleanly with a horizontal footer attached below. A 30-minute playground spike answers this.
- Does **`List`'s virtualization hold up** at 500K LOC for source rendering, or is there a known ceiling (memory, scrollbar precision, item-height inference) we should plan around?
- Is there an **idiomatic XMLUI pattern for the "single rendered HTML string per line with delegated click handlers"** alternative to per-segment `<Items>`? A custom component that takes pre-rendered HTML and exposes click events would be the v1 prototype's source-viewer fix, but might be the wrong shape if XMLUI has a better primitive.
- Any **air-gap gotchas** in the bundle — known network calls in built-ins, font-loading paths, telemetry — that v2's audit checklist should anticipate?

---

## Out of scope for v2

- The actual migration to CodeExam's `public/`.
- The primitive-coverage shell itself (separate spike).
- A `gh issue comment` on #38 summarizing the XMLUI implications for its refactor list (deliverable 4 from #73 — once v2 stabilizes).
- Final layout design (CE's lane).

---

## Cross-references

- **v1**: https://gist.github.com/judell/2a06d113a2597414871b3bf264ccce22 (also local at `code-exam-xmlui/xmlui-code-exam.md`).
- **Prior prototype**: `xmlui-prompt-catalog/` in this repo.
- **Issue #4**: `public/app.js` modularization (the work v1 under-credits).
- **Issue #18**: `src/core/CodeSearchIndex.js` modularization (no GUI-side impact).
- **Issue #23**: Public/private carve.
- **Issue #38**: GUI redesign prerequisites.
- **Issue #73**: This study's parent issue.
- **TODO #320**: Floating panels / windowing system.

### XMLUI documentation cited

- `Items` is not virtualized: https://www.xmlui.org/docs/reference/components/Items
- `List` is virtualized: https://www.xmlui.org/docs/reference/components/List
- `Table` is virtualized: https://www.xmlui.org/docs/reference/components/Table
- `Splitter`: https://www.xmlui.org/docs/reference/components/Splitter (3-pane composition not documented — spike needed)
- XMLUI MCP loop: https://www.xmlui.org/blog/xmlui-for-llms
- Semantic tracing: https://www.xmlui.org/blog/semantic-trace
