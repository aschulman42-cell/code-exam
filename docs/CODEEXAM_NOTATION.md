# CodeExam notation

CodeExam annotates its lists and digests with a few compact notations. They mean the same thing on
the **CLI** and in the **GUI**, and this page is the shared reference for both — what each notation
means, and a concrete example of each. A couple render a little differently on each surface (the
pre-dedup count is a badge in the GUI but a header number on the CLI; test/example code dims in the
GUI but carries a `[test]` tag on the CLI), and those differences are called out below. Most appear
in the AI/ML cells — see [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md) — and the GUI's visual form is in
[`CODEEXAM_GUI.md`](CODEEXAM_GUI.md).

## At a glance

| Notation | Means | Example |
|---|---|---|
| `~` | a heuristic (pattern-matched) finding, not a mechanical one | `~langchain` |
| `[lib?]` | over-fire: likely an SDK's own source, not a consumer of it | `…completions.create [lib?]` |
| `×N` / `N×` | count of occurrences collapsed into one deduped row (or repeats) | `×3`, `12×  https://api…` |
| instances vs. rows | the pre-dedup **instance** count (a GUI badge / a CLI header number), shown above the smaller **row** count | badge `23` on 7 rows; `7 unique tools (23 sites)` |
| `?` | an unknown / unlabeled family or grouping key | `~?` |
| `[test]` / dimmed | every site is test / example / demo code | CLI `[test]`; GUI dimmed |
| `<var>` / "unresolved" | an identifier passed as a variable, not a string literal | `<var>`; "(unresolved variable)" |
| `ⓘ` | a note in CodeExam's own voice under an AI answer: what it rests on, what CodeExam could or could not check | `ⓘ Based on 8 model tool calls: digest ×3, …` |
| `(file scope)` | a call site at module level, inside no function | Called By: `(file scope)`; `--call-tree`: `(file scope) (2x)` |
| `[unresolved]` / `unresolved` badge | a call with no definition reachable from its site | `push [unresolved] (13 definitions)` |
| `[ambiguous]` / `ambiguous` badge / dashed edge / `name ?` | several reachable definitions; the closest pick is shown, not expanded | `[ambiguous: 2 definitions]`; Mermaid `-.->` to `fmt ?` |

The sections below explain each, with a concrete example on the CLI and in the GUI.

## `~` — a heuristic finding

A leading tilde marks a **heuristic-tier** finding (a pattern-matched guess) as opposed to a
mechanical or structural one, keeping the distinction visible rather than presenting every hit with
equal confidence. It's used throughout the AI/ML cells (models, LLM calls, kernels, training,
inference, …).

Both surfaces prepend the `~`. **CLI:** e.g. a heuristically-detected LangChain row prints as `~langchain`,
and the section legend spells it out — *"(~ = heuristic, gated on LLM/MCP context; …)"*. **GUI:** the
same row shows `~langchain` and is also dimmed.

## `[lib?]` — library, not consumer

An over-fire flag on an LLM-call site: the detector suspects it fired on an SDK's *own* source rather
than on code that *uses* the SDK. A `[lib?]` row is one to verify.

Both surfaces. **CLI/GUI:** a call renders as `openai.chat.completions.create [lib?]`; the GUI
tooltip reads *"(library-vs-consumer: over-fires on the SDK's own source)"*.

## `×N` (and `N×`) — a count

Many CodeExam lists are **deduped**: several occurrences of the same thing collapse into one row.
`×N` (or `N×`) is that count — how many occurrences collapsed into one row, how many identical
pipelines or duplicate bodies were grouped, or how many times a string occurs within one function.
Both the leading (`×N`) and trailing (`N×`) forms appear.

Both surfaces. Examples: a duplicate group as `×3`; a referenced URL as `12×  https://api.example.com`;
a repeated string in a digest as `×3 here`; a pipeline group badge `×5`.

**Seeing what's behind the count.** In the GUI, clicking a deduped row in the left pane drills into
its full list of sites in the upper-middle pane (clicking a site there jumps to it in the lower
pane). On the CLI, `-v` / `--verbose` reveals the full list — for the duplicate commands it implies
`--show-dupes` and lifts the default display cap.

## The instance count vs. the row count

Building on the `×N` count above: the two numbers worth seeing are the number of **rows** (after
dedup) and the larger number of **instances** (the occurrences behind them — an `openai` call made at
twelve places is one row, but twelve instances). CodeExam always shows both, so a cell that's "more
than meets the eye" is obvious.

- **GUI:** each accordion section's **badge** — the small count shown at the right of the section's
  header — shows the *instance* count (pre-dedup), not the smaller row count, so a section with many
  collapsed sites stands out at a glance. Example: a badge reading `23` on a section whose list has 7
  rows.
- **CLI:** the same two numbers appear together in the section header line. Example:
  `7 unique tools (23 sites)` — the 7 deduped rows and the 23 instances behind them.

## `?` — an unknown label

A fallback used when the detector couldn't assign a family, framework, or grouping key.

Both surfaces. Example: a heuristic hit with no family renders as `~?` (the heuristic tilde plus an
unknown family). A trailing `?` appended to a framework name additionally flags that the framework
attribution is ambiguous.

## Test / example / demo code

Sites in test, example, benchmark, or demo code can inflate counts and dilute the real-usage signal.
By default CodeExam **shows** them (marked, not hidden) and lets you drop them:

- **GUI:** a row whose every site is test/example code is **dimmed**, and its tooltip notes
  `[test/example code]`. There is no inline text badge in the GUI — the dimming is the signal.
- **CLI:** the same row carries an inline **`[test]`** tag, and CodeExam prints a tip, e.g.
  *"Tip: 4 of 12 tool sites are in test/example code — add --no-tests to hide them."*
- **Drop them:** `--no-tests` removes AI/ML rows whose every site is test/example code;
  `--exclude-tests` skips test files in caller / metrics results. (In the GUI, **View → Exclude
  Tests**.)

Of course, test, benchmark, or demo code may be exactly what you're after — in which case just
ignore the `[test]` tag or the dimming; it's a default hint, not a filter. (There's no flag to keep
such rows while suppressing only the marking — the two flags above **drop** the rows instead.)

## Unresolved identifiers

When a model (or other identifier) is passed as a **variable** rather than a string literal, CodeExam
can't resolve it to a concrete name — so it discloses it as unresolved rather than silently dropping
it.

- **GUI:** the row's tooltip notes *"(unresolved variable)"* and the label is styled as a warning.
- **CLI:** the placeholder token `<var>` stands in for the value, and a note reports the count, e.g.
  *"3 model references found, but no id resolved — each is a runtime-determined value"* or
  *"+2 unresolved <var> model ref(s) — excluded"*.

## Call-graph markers

Callers, callees, call trees and the GUI's Calls / Called By tables bind a call to a definition
only when the definition is **reachable** from the call site: the same file for a non-exported or
`static` function, an import path otherwise, never across languages (the rules are in
[`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md)). Three markers say what
happened when that bind was not clean:

- **`(file scope)`** — the call site is at module level, inside no function (a CLI dispatch line, a
  top-level statement). **CLI:** `--callers` groups such sites under `(file scope)`; `--call-tree`
  lists `(file scope) (2x)` among the callers. **GUI:** the Called By table names `(file scope)` as
  the caller, and the diagram draws a `(file scope)` node.
- **`[unresolved]`** — the call has no definition CodeExam can reach from that site: a method on
  some object (`out.push(`), a local of another function, a name from a module the caller does not
  import. The call is kept so it stays visible, but it is not linked and trees do not descend into
  it. **CLI:** `--callees` prints `push [unresolved] (13 definitions)`; `--call-tree` collects them
  once per node as `[unresolved: push, find (method call)]`; `--call-inventory` lists them as
  external with the reason. **GUI:** an `unresolved` badge on the Calls row (tooltip: *"No
  reachable definition in the index"*).
- **`[ambiguous]`** — several definitions are reachable and nothing (no import, no same-file
  definition) says which; the closest one is shown and marked. **CLI:** `--callees` appends
  `[ambiguous]`; `--call-tree` prints `[ambiguous: N definitions]` and does not expand the node;
  `--mermaid` output draws a dashed edge (`-.->`) to a node labelled `name ?`. **GUI:** an
  `ambiguous` badge (its tooltip gives the definition count) and the dashed edge in the diagram.

These are distinct from the `<var>` / "unresolved variable" marker above, which is about a model
*identifier* that is a run-time value, not about a call.

## `ⓘ` — CodeExam's own notes under an AI answer

Every **Overview by AI** (`--overview-by-ai`, and the GUI's button, on the cloud and the local
engines alike) ends with one or more lines beginning `ⓘ`. CodeExam writes them, not the model:
they are appended after the model has finished, never edited into its prose, and they say what
the answer rests on. Each is mechanical — a comparison between two things CodeExam already holds —
not a judgement of the answer.

- **`ⓘ Based on N model tool calls: …`** — the evidentiary footer: which CodeExam tools the model
  chose to call, and how often. *"Based on 1 tool call: overview"* means a rewording of the
  deterministic `--overview`, not an independent second view. A parenthetical discloses anything
  CodeExam ran on the model's behalf (a prefetched overview, a substituted tool, a
  verification-only `models_used`).
- **`ⓘ AI/ML SENTENCE UNVERIFIED: the prose above names "X", "Y", …`** — the answer's AI/ML
  sentence named things that CodeExam's own `models_used` result for this index does not
  contain; that result is reproduced under the note. A name may be a vendor or a framework rather
  than a model: the note reports, it does not classify. Only sentences that carry an AI/ML cue are
  scanned, so *"the data model"* and *"a hub-and-spoke model"* are not, and a sentence that
  *denies* models is left to the converse check below.
- **`ⓘ CodeExam's own models_used found no literal model ids in this index; the AI/ML sentence
  above was not checked against it.`** — the zero-id case. When `models_used` found nothing there
  is nothing to compare an affirming sentence against, and CodeExam says so rather than listing
  every name in the sentence as unverified. An invented model id (`GPT-4` on a codebase that has
  none) is still flagged, with the tool's one-line result under it.
- **`ⓘ AI/ML CLAIM CONTRADICTED: the prose above says "…", but CodeExam's own models_used result
  for this index reports N models …`** — the converse: the answer denied models, model ids or
  literals, and the tool found some. A denial of *calling* models is not contradicted by rows
  that are all `declared` (a model-shaped literal in code with no call site found); when such rows
  exist the note says how many.

The `<models_used>` block under a note is the tool's own text, reproduced so the reader can judge
for themselves; nothing in a note was read out of the index.

## Related

- [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md) — how this notation looks in the GUI.
- [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md) — the AI/ML cells, where most of the notation appears.
- [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md) — other catalogs and lists that use it too: e.g.
  **Referenced resources** shows `×N` reference counts, and the **duplicate** lists show `×N` per
  group.
