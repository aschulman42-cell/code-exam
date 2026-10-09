# CodeExam — FAQ & Workarounds

> **What this is.** Behaviors in CodeExam — **CLI and GUI** — that are likely to
> surprise a new user, each with an actionable workaround. Most are rough edges
> we expect to fix soon, so, **as each is fixed, its entry is removed from this
> file** — the fix, not the workaround, becomes the
> durable record. Every entry ends with a **Status** line naming the candidate
> fix.
>
> **How this differs from `CODEEXAM_KNOWN_LIMITATIONS.md`.** That doc is a candid,
> by-area inventory of where CodeExam falls short today — a work-in-progress list
> kept current *as things are fixed* (some items are heuristics or by-design,
> others are actively being tightened). This one is task-shaped: *"I hit something
> surprising — what do I do right now, and is it going away?"*, with a concrete
> workaround per entry. The same behavior often appears in both (e.g. GUI result
> caps): the limits doc states the shortcoming, this doc gives today's workaround
> and points at the fix.
>
> **Related docs.** Caveats specific to AI/LLM-assisted examination →
> [`ai-assisted-examination-gotchas.md`](./ai-assisted-examination-gotchas.md). For
> the GUI's panes, menus, and header controls → [`CODEEXAM_GUI.md`](./CODEEXAM_GUI.md).
> The GUI field-test log that seeded many GUI items below is triaged in issue #343
> (the canonical tracker).
>
> **Reading the CLI / GUI notes.** Topics that appear in both surfaces are a
> single entry with a **CLI** and a **GUI** note inline. Purely-GUI rough edges
> are grouped at the end.

## How do I list all the functions in one file?

**Q.** I want every function in `FooBar.c`. `--functions FooBar` seemed to work
— is that the right command, and is it reliable?

**CLI.** `--functions` is the command (bare, it lists every function grouped by
file). To scope to one file, pass the filename *with extension*, and when you
need it exact add `--include-path`:

    ce --index-path <idx> --functions --include-path FooBar.c

then read the `…/FooBar.c:` group. `--functions FooBar` is only *roughly* right:
the `[pattern]` is a **substring filter matched against three things at once** —
the raw function name, its renamed display name, and the file path. So
`--functions FooBar` also pulls in any function *named* `FooBar`, any inferred
`_KW_FOOBAR` rename (see "renamed names" below), and any other file whose path
contains `FooBar` (`FooBarUtil.c`, `legacy/FooBar/…`) — surfacing as extra file
groups. Pass the extension (and, to be safe, a path fragment) to cut false hits;
`--sort alpha|size` orders within.

**GUI.** The Functions accordion in the left pane lists them; the filter box
narrows the list (same substring behavior).

**Status.** Minor. Candidate fix: a path-exact "functions in this file" mode,
and/or have `--functions` state that its argument is a broad substring filter.

## I just want an AI to explain this code to me

**Q.** How do I point an LLM at one function (or a file) and get "what does this
do?"

**GUI.** Right-click the function / method / class in the left pane →
**Analyze with LLM** (or **Analyze with LLM + Context** to add a patent claim,
spec paragraph, or note the explanation should weigh), or **Analyze File with
LLM** for a whole file. The **Chat** tab gives a back-and-forth conversation
about the index. All route to whichever engine is selected (cloud or local).

**CLI.**

- `--analyze <function>` — "what does this do?" for one function.
- `--analyze <function> --with "<text>"` — same, with context to weigh.
- `--file-analyze <path>` — analyze a whole file.

There is **no CLI chat** — the conversational Chat is GUI-only right now.

**Which engine, and the confidentiality rule.** Cloud (`--llm
claude|openai|gemini`, needs that provider's API key) is the most capable;
**local** (`--model <model.gguf>`) keeps the code on your machine. If the code
is confidential or proprietary, keep it local — `--air-gapped` blocks every
cloud AI call for the run — and accept that local models are often less capable.

**Local context caveat.** Local models have a limited context window, so
analysis is far more practical on a **single function** than on a whole file: a
big file can overflow the local model's context. Size the window with
`--context-size` (mind the VRAM trade-offs in `docs/LOCAL_LLM.md`). Cloud models
have much larger contexts, so whole-file analyze is realistic there.

**Status.** Mostly working as intended. Candidate: a CLI `--chat` so the
conversational mode isn't GUI-only.

## I'm in the GUI, want Chat or Analyze, but didn't set an API key

**Q.** Can I set the API key from inside the GUI? Reloading a huge index to
restart is slow.

**Short answer.** No — there is no in-app key entry, by design. The GUI resolves
each provider's key **once at startup** (launch flag → environment variable →
key file), so adding a key means (re)launching. Nothing feeds a key to an
already-running server, and that's deliberate: it keeps API keys out of the
browser UI, consistent with CodeExam's air-gapped posture.

**Set it before you launch** (so you load the index only once):

- a launch flag — `--openai-key <key>`, or `--api-key <key>` for the selected
  provider; or
- an environment variable — `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` /
  `GEMINI_API_KEY`; or
- a key file in the working directory, present *before* you start — `openai.txt`
  (or `openai_key.txt`), `claude.txt` for Anthropic.

If you already started the GUI without a key, you do have to restart, and the
index reloads — there is no way around the reload today.

**Status.** Intended — the key resolves once at startup, with no runtime
ingestion, for safety; not a bug. The real gap is the *message*: when a cloud
engine has no key, the GUI's **Engine Not Available** panel says "To enable it,
do one of the following" and lists "create `claude.txt`", "set
`ANTHROPIC_API_KEY`", or "start with `--api-key`" (`public/context-menu.js`) — but
never says the first two take effect **only after you stop and restart the
server**, so someone who drops the file next to a running server sees nothing
happen. Candidate fix: have that panel state the restart requirement.

## The output isn't alphabetical — how do I sort it?

**Q.** CodeExam (CE) lists things in some order that isn't A–Z. Why, and how do I get
alphabetical (or another) order?

**Why it isn't alphabetical.** Deliberate. CE orders most output by *importance* (or an approximation thereto)
— counts and rarity measures that pull the code that matters up to where you'll
see it, instead of burying it in alphabetical noise. It's the **"searching by
counting"** idea (`CODEEXAM_KEY_FEATURES.md`; see also `UNCOVER_KEY_CODE.md`). A
real strength, but the order surprises people, so it needs an easy flip.

**CLI.** For the function (and, per the help, file) listings: `--sort alpha` or
`--sort size`:

    ce --index-path <idx> --functions --sort alpha

The catalog/list commands — classes, data structures, command catalog, strings,
the LLM prompt catalog, vocabulary, referenced-resources — and the ranked views
(search, hotspots, most-called, multisect) do **not** accept `--sort`; each
keeps its own order. (Confirmed: `--strings` and `--prompt-catalog` ignore
`--sort` today, though both arguably should honor it.) For those, pipe to your
shell's `sort`: `… --max-results 100000 | sort` — which re-sorts raw lines, so
it can break per-file grouping; fine for a quick A–Z scan, not structured
reading. (Raise `--max-results` first — see "seeing all results".)

**GUI.** No sort control yet — no View-menu toggle, and the Functions list is
pinned to a line-count sort. Sort from the CLI for now.

**Status.** Candidate fix: extend `--sort alpha|size` to every list/catalog
command (and confirm `--files` honors it); document the default ranking. GUI:
clickable/sortable column headers.

## I see "… +N more" — how do I get *all* the results? (and why grep doesn't see results I know must be there)

**Q.** At the end of output from some `--command`, CE says there's more than it
showed ("+60 more") and tells me to pass `--max-results <N>`, but I don't know N.
And when I redirect output to a file and grep, a line I'm sure exists isn't there.

**CLI.** Use **`--all-results`** to print every row with no number to guess — or
**`--max-results 0`**, which now also means "no cap"; `--max-results <N>` still
sets an explicit limit. The grep miss has the same root: rows past the cap are
dropped at display time, so they're never written to your file in the first place
— grep can't find a line CodeExam never emitted. So pass `--all-results` (or a
large `--max-results`) to the *CodeExam* command first, then grep that file. Note
`-v` / `--verbose` is **not** this: it adds detail and (in `multisect`) un-dedups
categories, but each scope is still capped.

**GUI.** The prime example is the **left-pane accordions** (Functions, Strings,
and the other catalogs): they cap the rows they return and *don't always say so*,
so a list can look complete when it isn't (`CODEEXAM_KNOWN_LIMITATIONS.md`, #137).
Some caps are governed by **View → Max Results** — raise it — and the filter box
narrows the list; when completeness matters, confirm from the CLI with a large
`--max-results`. (Other silent GUI truncations exist too — e.g. Chat answers cut
at a token budget, #343, and search results, #272.)

**Status.** CLI: **done** — `--all-results` lifts the cap and `--max-results 0`
now means unlimited. GUI: still pending — the left-pane caps aren't always
disclosed; surfacing them (and a GUI "All Results", the `gui-all-results-view-menu`
item) is the remaining work.

## How do I get a file's real path on disk? `--full-path` only gives the in-index path

**Q.** I want the real path of a file on my machine. `--full-path` shows a
"full" path, but it's only full *within the index*.

**CLI.** Run `--stats`: it prints **`Base path:`** — the absolute directory the
index was built from (and `Source:`). The on-disk path is `Base path` + the path
CE prints (join with `\` on Windows, `/` elsewhere). Use `--full-path`
(singular) so the path you join is the complete in-index path, not the default
abbreviated one (the default shortens to fit the terminal, inserting `…`).
Caveats: `Base path` is the build-time location on the build machine — if the
tree moved, substitute the new root; for an archive-built index, `Source:` names
the archive and the "original" lives inside it. For an index built from a file
list (`@list.txt`), `--stats` does name the list — `Source: file list: @list.txt`
— but only *as you typed it* (relative if you typed it relative, so you may need
your build-time working directory to find the list again), and the `Base path` is
the *common-ancestor directory* of the listed files, not the list file and not
necessarily a root you can prepend to every printed path (scattered inputs push
it up to a high directory, or to your cwd).

**GUI.** Path display is space-constrained and left-truncates, hiding the
directory that distinguishes same-named files (#242) — the full/original path
isn't shown; use the CLI recipe above when you need it. The left-pane accordions
can also omit parts of a path *even when the column is wide enough to show them* —
the same left-truncation family as the "Left-truncated paths" item under
*GUI-only rough edges* below (#242, #150).

**Reports / charts.** Charts and generated reports print file references in the
same in-index (relative) form as the rest of CodeExam's output — they do **not**
currently paste in `Base path` to show absolute on-disk paths (the chart/report
generators don't read the index's base path). Use the `--stats` recipe above to
reconstruct an absolute path when you need one.

**Status.** Candidate fix: an option to print absolute paths directly (join
`base_path` for you) and record a portable source root — including in charts and
reports, and recording the list-file path for `@list` builds; GUI: middle-truncate
paths and offer a copy-full-path affordance.

## A path or `file@func` I copied won't resolve when I pass it back in

**Q.** I took a `path` (or `file@func`) from CE's output and passed it to a
command that expects one (`--digest`, `--extract`, …) and it didn't resolve.

**CLI.** Pass an *exact* target. Two common causes:

- **Abbreviated paths.** The default output path is shortened for display
  (`…`); that form isn't the index key. Re-run with `--full-path` and copy that.
- **Ambiguous target, `[N]` is REPL-only.** When a `path`/`file@func` matches
  more than one thing (several files of a name, or two functions sharing a name
  in one file), CE lists candidates numbered `[1] [2] …` — but picking by number
  works only in the interactive REPL (`/file [N]`, `/extract [N]`). From the
  plain CLI there is no `[N]` argument; CE tells you to pass an exact target:
  the full path for a file, or `file@func@LINE` for a repeated function name (a
  numeric part after `@` is read as a line-number disambiguator).

Other circumstances can cause the same symptom; these two are confirmed.

**GUI.** Less of an issue — you select a result by clicking it rather than
retyping a target — but a result you reached by clicking can't always be
expressed as a CLI argument; use the CLI escape hatches above when scripting.
However, clicking a function/method in the GUI may take you to the *wrong*
function/method with the same name (see #343, "Engine root cause — name-only
symbol resolution").

**Status.** Candidate fix: accept `[N]` from the plain CLI, and guarantee any
target CE prints round-trips as a CE input.

## Short names get renamed even in clean code; `--no-rename` only hides it

**Q.** CE rewrites short identifiers (e.g. `foo` → `foo_KW_SOMETHING`) even in
ordinary, non-obfuscated files. I set `--no-rename`, but searching for a rename
fragment like `_KW_` still returns the same lines — they just no longer show
`_KW_`. So is renaming actually off?

**Why.** CE infers readable "keyword" suffixes for short/ambiguous names (from
each function's distinctive body tokens) so obfuscated code stays legible, and
this runs by default on all code.

**CLI.** `--no-rename` turns the renames off **in displayed output only** — it
swaps the display rename for a pass-through. The index still holds the renamed
names and search/`multisect` still match against them, so the matched *set* is
unchanged; only what's printed differs. A consequence: a plain-text search for a
word that appears only in an inferred `_KW_` suffix can match a function whose
*source* identifier never contained it. Workarounds:

- **See the raw names.** `--no-rename` (CLI) prints the bundler-emitted tokens
  (`wI1` rather than `wI1_GET_COST_COUNTER`); in the GUI, uncheck **View → Show
  Inferred Name Suffixes** — the same display-only switch.
- **See what maps to what.** If a rename map was built (`--build-rename-map`),
  the index's `rename_map.json` lists each raw token and its inferred name.
- **Use the suffixes to your advantage.** Because the inferred suffix is indexed,
  a search for a word you only saw inside a `_KW_` / `_CMD_` / `_IMPORT_` suffix
  still reaches the function — that extra reach is the point of the renaming, not
  a bug.

**GUI.** The GUI also shows the inferred display names (e.g. in the Functions
list and Overview). There **is** a toggle: **View → Show Inferred Name Suffixes**
(the GUI counterpart of `--no-rename`). Like `--no-rename`, it's display-only —
unchecking it shows the raw tokens, but search still matches on the inferred
names, so the matched set is unchanged.

**Status.** Candidate fix: make `--no-rename` (and **View → Show Inferred Name
Suffixes**) optionally affect *matching*, not just display — or document the
rename-aware search behavior so it stops surprising people.

---

## GUI-only rough edges

These are specific to the GUI; most are logged in **issue #343** and awaiting
fixes. Listed so a behavior you hit reads as *known*, not as your mistake.

### A floating window is covering the results I just clicked on

A pop-out window (Overview, the source pop-out, the diagram, or the Analysis
pane) floats over the result pane its own click updated, so the feature looks
broken. It isn't — the panel underneath did update. You can **drag the floating
window aside by its title bar** (the pane and diagram pop-outs became draggable
in #177) or close it to see the result. Not every floating panel is movable yet,
but the pop-outs are. *Tracked:* #38 (GUI redesign umbrella), #152, #177, #125.

### The Overview keeps reappearing every time I load or refresh

The Overview pop-up opens on every load — to show a fresh Overview for the
newly-loaded index — re-covering the panes, and once closed there's no obvious
way to reopen it. Close it after each load; its content is also in the Overview
accordion in the left pane, so you don't need the pop-up to read it.
*Tracked:* #181, #218.

### I only see "Ana…" — where are the Console and Chat tabs?

At the default window width the Analysis | Console | Chat tabs clip to "Ana…".
Widen or maximize the window — the tabs are there. (For the pane header controls
and the **Window** menu generally, see [`CODEEXAM_GUI.md`](./CODEEXAM_GUI.md).)
*Tracked:* #343.

### More known GUI rough edges (tracked in #343, fixes pending)

No workaround beyond what's noted:

- **Left-truncated paths hide the directory** — the distinguishing part is the
  part cut off. (#242, #150)
- **Exports/Imports show "(Python only for now)" on a non-Python index** —
  harmless; those catalogs are Python-only today. (#165, #234)
- **"Pop out full screen" isn't actually full screen** — a large floating
  window, no maximize/restore. (#177, #125)
- **Low dark-mode contrast**, **Overview section headers look like links but
  aren't**, **no highlight on the selected left-pane row**, **middle panes
  aren't labeled by role**, and **"Called by" sits below the fold**. (all new
  in #343)

---

*More entries to come. Entries are retired as their underlying issues are
fixed.*
