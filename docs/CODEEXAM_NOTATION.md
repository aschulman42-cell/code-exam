# CodeExam notation

CodeExam annotates its lists and digests with a few compact notations. They mean the same thing on
the **CLI** and in the **GUI**, and this page is the shared reference for both — what each notation
means, and a concrete example of each. A couple render a little differently on each surface (the
pre-dedup count is a badge in the GUI but a header number on the CLI; test/example code dims in the
GUI but carries a `[test]` tag on the CLI), and those differences are called out below. Most appear
in the AI/ML cells — see [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md) — and the GUI's visual form is in
[`CODEEXAM_GUI.md`](CODEEXAM_GUI.md). The markers are here; the *words* the claim, pseudo-claim and
mechanism pages use (drafter, locator, anchor, sidecar, HOF) are on
[`CODEEXAM_JARGON.md`](CODEEXAM_JARGON.md).

## At a glance

| Notation | Means | Example |
|---|---|---|
| `~` | a heuristic (pattern-matched) finding, not a mechanical one | `~langchain` |
| `[lib?]` | over-fire: likely an SDK's own source, not a consumer of it | `…completions.create [lib?]` |
| `×N` / `N×` | count of occurrences collapsed into one deduped row (or repeats) | `×3`, `12×  https://api…` |
| instances vs. rows | the pre-dedup **instance** count (a GUI badge / a CLI header number), shown above the smaller **row** count | badge `23` on 7 rows; `7 unique tools (23 sites)` |
| `?` | an unknown / unlabeled family or grouping key | `~?` |
| `also [kind] label` | in a mechanisms row: the other records that are the same functions under another label, folded into this one (the GUI adds `×N`) | `also [file] ledger.py` |
| `file@name  (L12–48)` | a member of a mechanism entry under `-v` (`--mechanisms`, `--toc`, `--embed-distance`): the anchor in the `file@func` grammar, then the function's line range in the index, kept outside the anchor so the `file@func` part pastes into any anchor-taking flag | `common/frame.c@x264_frame_delete  (L312–340)` |
| `12. m5  …` | a row of `--toc`: the number is the row's place in this listing, which changes with `--sort-by`, a filter and `--include-tests`; `m5` after it is the mechanism's record id, the name `--mechanisms`, `--embed-distance`, `--semantic-search`, `list_mechanisms` and the GUI list show for the same row (since 2026-11-21; before that a `--toc` row carried the number alone, and the two agree only near the top of a largest-first listing). Ids are padded so every row's text starts in one column | `12. m5   [class] Ledger  (16 fns, 1 file)` |
| `id:m70` | given where `--embed-distance` or `--semantic-search` takes its text: measure or search from the mechanism with that record id, by its saved vectors, and not from words (since 2026-11-21). The output opens with `Measured from mechanism m70, as recorded in the mechanisms file built <date>` and the mechanism in full; a listing's first line reads `from mechanism: m70 <label>` where a text's reads `query: …` | `ce --ndx .CE --embed-distance id:m70` |
| `m499   [file] compute.py [11.5]`, `[7]`, `[alone]`, `[unplaced]` | the bracket at the end of a row of `--carve` (since 2026-11-23): the number of the section or sub-section the mechanism is listed under, so that a search of the output for a name shows where the row sits. `[11.5]` is sub-section 11.5; one number, `[7]`, is a section too small to have sub-sections; `[alone]` is a mechanism in a section of its own, listed at the end; `[unplaced]`, under `--carve clusters` only, is a mechanism with no embedded text. The numbers belong to one listing: they change with the technique, the settings and the index. Not to be confused with the kind tag that opens a label (`[file]`, `[cmd]`, `[class]`) | `ce --ndx .CE --carve calls` |
| `src/core/air-gapped.js@assertLocalOnly  (L37-45; in m2 m7 m12 m185)` | the line over a text in `--show-function-text`: the function as `file@function`, its line range, and the record ids of the mechanisms that hold it, lowest first (since 2026-11-22). `in no mechanism, not embedded` in place of the ids: no mechanism holds the function, so `--semantic-search` and `--embed-distance --function-text` embed no text for it and cannot return it. `in m57, not embedded: a second definition of this name in the file`: a mechanism holds it, but the two commands reach a mechanism's functions by file and name and so embed only the first definition of that name. No `in …` part at all: the index has no mechanisms file. |
| `rank  cosine  id  entry` | the line over the rows of an `--embed-distance` listing, naming their columns once: the rank, the cosine to the query, the entry's mechanism record id (since 2026-11-21) and the entry (`rank  cosine  candidate`, with no id column, for a list given with `--against`: those rows are texts, not mechanisms). The distance, 1 − cosine, is not a column (it was until 2026-11-19, when every row read `cosine … distance …`); it prints only for one pair | `1.  0.5951  m164  [file] middle-pane.js / other  (7 fn)` |
| `rank   score   label  function  id  entry` … `via file@name` | the same line under `--embed-distance --function-text`, and a row under it: the entry was ranked by `score`, 0.3 of the cosine of its label text and 0.7 of the cosine of its best member function's text; the two cosines follow in the `label` and `function` columns (`none` under `function` when the entry has no function text and `score` is the label cosine), and `via` names the member function that scored, as the file's base name and the function (the folders are left off so the name stays on the line; `-v` lists every member with its full path). A row without the option has no `via` | `1.  0.6395  0.5900    0.6607  m70  multisect (parseMultisectTerms)  (13 fn)  via analyze.js@doMultisectAnalyze` |
| `1. 0.470  name   path:12-48` then `in m12 <group> (N fn); also in …` | a result of `--semantic-search`: the function that scored, its file (cut to its last three segments unless `-v`) and its line range in the index; the one number is the score the row was ranked by, 0.3 of its group's label cosine and 0.7 of the function's. The line under it names the groups (mechanism entries) holding the function, the smallest first, each by its record id and then its label (the id since 2026-11-21; a row that is a group with no single function leads with the group's id the same way); `next best in this group:` names the group's next functions for the same text; the last line, when present, is the smallest group's description | `2. 0.432  assertLocalOnly   src/core/air-gapped.js:37-45` |
| `HITS` / `NEAR HITS` | the two tiers of a `--semantic-search` listing: a hit scores within 15% of the way from the best row down to the typical (median) score for the text, a near hit within 35%. Relative to this index and this text; a hit is the closest code found, a place to read, not a finding that the code does what the text says. `nothing stands out` under a listing means more hits tie the best than a tier shows | `typical score 0.283, best 0.433; 3 hits, 8 near hits` |
| `3 of 8  # # . # . . . .` | a row of `ACROSS THE N ELEMENTS` under a `--semantic-search @claim` run: the place was within the first 25 results (fewer on a small index; the heading gives the number) for three of the eight elements, `#` under each element it was found for and `.` under the others | `2.  5 of 8  # # # . . # # .   assertLocalOnly   src/core/air-gapped.js:37-45` |
| `searched as: …` / `SEARCHED AS (…): …` | under an element's heading in a listing of `--embed-distance --toward-code` (lower case) or `--semantic-search --toward-code` (capitals, with the reminder that the results are for the rewording and the heading marked `as written`): the text the entries were ranked by, a model's rewording of the element toward this codebase's names. The line above it is the element as written. The rewording is a search query, not a reading of the claim; `searched as written: not reworded (…)` means the model call for that element failed and the element itself was ranked | `searched as: Switch the bitrate of the content data being sent to the receiver to the determined bitrate.` |
| `holds name` / `in file` / `purpose "…"` | on a filtered mechanisms row (`--mechanisms`, `--toc`, `list_mechanisms`, the GUI list): what the filter matched that the row does not print, a member beyond the names shown (`holds`, the word `--embed-distance --filter` uses), a file (counted on every row, never listed), or the harvested purpose a model's sentence replaced; absent when the id, label, text, a tag, a folded label or a printed name explains the match | `holds mask_quoted_spans`; `in src/guard_policy.rs` |
| `…text…  [line of N chars; M matches, the first shown; --full-lines shows it whole]` | a hit of `--search`, `--literal`, `--fast` or `--regex` on a line over 300 characters (a minified bundle's can be hundreds of thousands): what is printed is a window of about 100 characters each side of the first match, `…` marks each cut end, and the note gives the line's real length | `L421  …e.isTrusted&&n.x===t.x…  [line of 327,144 chars; 2 matches, the first shown; --full-lines shows it whole]` |
| `[test]` / dimmed | every site is test / example / demo code | CLI `[test]`; GUI dimmed |
| `<var>` / "unresolved" | an identifier passed as a variable, not a string literal | `<var>`; "(unresolved variable)" |
| `ⓘ` | a note in CodeExam's own voice under an AI answer: what it rests on, what CodeExam could or could not check | `ⓘ Based on 8 model tool calls: digest ×3, …` |
| `(file scope)` | a call site at module level, inside no function | Called By: `(file scope)`; `--call-tree`: `(file scope) (2x)` |
| `[unresolved]` / `unresolved` badge | a call with no definition reachable from its site | `push [unresolved] (13 definitions)` |
| `[ambiguous]` / `ambiguous` badge / dashed edge / `name ?` | several reachable definitions; the closest pick is shown, not expanded | `[ambiguous: 2 definitions]`; Mermaid `-.->` to `fmt ?` |
| `// … [cut at N chars; M more. Later in this function: …]` | a `--pseudo-claims` evidence-pack member cut to its head, with an outline of the rest from its own section comments | `L418 2) CLASS seeds…; L444 3) CATALOG seed…` |

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
a repeated string in a digest as `×3 here`; a pipeline group badge `×5`; a Mechanisms row `×2`
when two records (a one-class file's `[class]` and `[file]`) are the same functions, the CLI
naming them on an `also` line instead.

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
- **Drop them:** `--no-tests` or `--exclude-tests` (the same thing since 2026-11-19) removes
  AI/ML rows whose every site is test/example code, and leaves test files out of the text
  searches, `--multisect-search` and the listings that read it
  ([`cli.md`](cli.md), `--exclude-tests`). (In the GUI, **View → Exclude Tests** hides the AI/ML
  rows only.)

- **`(test)` after a member** in `ce --mechanisms -v`: that function is a test, in a test
  file or under a test attribute in a source file (Rust `#[test]`). The record it is in may
  hold ordinary code too; a record made only of tests carries the tag `test` on its own line.

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
not a judgement of the answer. An `--ask-ai` answer carries the first of them, the footer, the
same way; the AI/ML notes are the overview's.

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
- **`ⓘ Questions regenerated (sampled, temperature 0.8); the overview above is unchanged.`** —
  written under the "Questions to start with" list when the GUI's **↻ New questions** control
  replaced it with a fresh set from a separate, sampled call. The overview's prose, the other
  notes and the footer are the original run's; this note is what tells the reader of a saved
  pane that the questions came from a second call at a temperature the overview did not use.
  One line, never accumulated across regenerations.

The `<models_used>` block under a note is the tool's own text, reproduced so the reader can judge
for themselves; nothing in a note was read out of the index.

## `// … [cut at …]` — evidence-pack cut markers

An evidence pack (the code a `--pseudo-claims` run hands the drafter for one group; see
[`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md), "The pack budget") marks every member it
could not show whole, inside the member's fenced body, as a comment line beginning `// …`:

| Marker | Means |
|---|---|
| `// … [cut at N chars; M more]` | the budget was evened across the group's members; this one shows its first N characters and M are not shown |
| `// … [truncated for evidence-pack budget]` | the member ran past the per-anchor cap, or past the budget under `--pack-fill first`, and shows its head |
| `// … [middle cut: N chars omitted; a constant keeps its head and its tail]` | a constant (a prompt, a table) keeps both ends, since a prompt's output section sits at its end |

Since 2026-10-31 a cut **code** member's marker goes on with an outline of the part not shown,
taken from the function's own section comments: `Later in this function:` then one entry per
comment block, `L<line> <the block's first line>`, clipped, at most eight, the whole within 400
characters and a third of the member's allowance, and paid for from the head so the pack stays
within budget. Only full-line comments at the body's own indentation count: a comment nested in
a block is not a heading, and a `// ----` rule has no words. The entries are shortened when more
blocks are waiting, so a tight allowance lists more parts with less of each. Line numbers are
the file's, counted from the first line of the packed text (which starts above the function's
recorded line by its doc comment). A function with no such comments beyond the cut keeps the
plain marker. The grouper's seed function evened to 960 characters, in the dry run of
2026-10-31:

```
// … [cut at 651 chars; 19447 more. Later in this function: L404 Rescue bookkeeping
// (--body-match-…; L418 2) CLASS seeds for the unassigned…; L444 3) CATALOG seed
// (OPT-IN --catalog…; L534 4) LITERAL seed (OPT-IN --literal…; L588 5) BODY-MATCH
// rescue (OPT-IN --bo…; L632 6) FILE seed (OPT-IN) — a SMALL f…; L684 RETURN STATS
// ALONGSIDE THE GROUPS…]
```

Measured on the 183-group candidates list of CodeExam's own code that day: 189 of the 416 cut
code members carry an outline.

## Related

- [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md) — how this notation looks in the GUI.
- [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md) — the AI/ML cells, where most of the notation appears.
- [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md) — other catalogs and lists that use it too: e.g.
  **Referenced resources** shows `×N` reference counts, and the **duplicate** lists show `×N` per
  group.
