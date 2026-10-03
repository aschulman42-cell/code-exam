# Example indexes: recipes to try CodeExam on publicly-accessible code

The fastest way to see what CodeExam does is to point it at a real, recognizable codebase. This page
is a set of **recipes** — get the source, build an index, run a few first commands — plus a note on
what you'll see. None of these indexes ships with CodeExam; you build them in a minute or two from
public source.

Every recipe is the same three steps:

1. **Get the source** — download the project as a `.zip` (or `git clone` it).
2. **Build an index** — `node src/index.js --build-index <source> --index-path .name
   --use-tree-sitter` (or `ce --build-index …`). `--use-tree-sitter` turns on the precise parser for
   the [supported languages](GETTING_STARTED.md#requirements) (it needs `npm install`; without it CE
   falls back to a coarser regex parse).
3. **Look around** — start with `--overview` and `--vocabulary`, then follow your nose.

See [`GETTING_STARTED.md`](GETTING_STARTED.md) for install and [`CODEEXAM_CLI.md`](CODEEXAM_CLI.md)
for the full command set.

The recipes below favor commands that show you something you *wouldn't* have guessed about the
code — the external hosts a binary quietly reaches, the LLM prompts inside an app, the duplicated
shims hiding under different names. This helps show one place where CodeExam earns its keep.

> **A note on the commands below.** Several list commands take a **count** —
> `--struct-dupes 10`, `--hotspots 15`, `--vocabulary 25` — and output an error message without one.
> When more items exist than the count you gave, CodeExam says so (e.g. `Showing 20. Use
> --vocabulary 40 for more.`). Why cap rather than always show everything, or print a total? For a
> computed list like vocabulary, how much to generate is the user's call; for other commands a
> default cap keeps CLI output readable and avoids stalling the GUI on very large indexes. Add `-v`
> to expand a summarized result to its detail. Where a name is ambiguous (common in C++), pass the
> `file@name` form rather than the bare name.

## Non-AI codebases (start here)

Ordinary, well-known C/C++ projects — good for CodeExam's structural browsing and cross-reference
with no AI in the loop.

### zlib — a small, self-contained C library

Small enough to grasp whole. Build and orient:

```bash
# Source: https://github.com/madler/zlib
#   (Code ▸ Download ZIP: https://github.com/madler/zlib/archive/refs/heads/develop.zip)
node src/index.js --build-index ./zlib-src --index-path .zlib --use-tree-sitter
node src/index.js --index-path .zlib --overview
node src/index.js --index-path .zlib --vocabulary 25
```

**Also try** structural duplicate detection — code that is the *same shape* under different names.
`--struct-dupes 10 -v` surfaces zlib's file-I/O shim implemented four ways (`fill_fopen_filefunc` /
`fill_fopen64_filefunc` POSIX and `fill_win32_filefunc` / `fill_win32_filefunc64` Win32) as one
structural family:

```bash
node src/index.js --index-path .zlib --struct-dupes 10 -v
```

### x265 — a C++ HEVC video encoder

A mid-size C++ codebase where **file ≈ class** (`ratecontrol.cpp` ↔ `RateControl`):

```bash
#    [[placeholder: confirm the current .zip URL for the x265 project (MulticoreWare)]]
node src/index.js --build-index ./x265-src --index-path .x265 --use-tree-sitter
node src/index.js --index-path .x265 --overview
node src/index.js --index-path .x265 --classes          # note: --classes takes no count
```

To read a specific method, pass the **`file@Class::method`** form (a bare name like `RateControl`
is ambiguous — it matches the class, its namespace alias, and the constructor):

```bash
node src/index.js --index-path .x265 --extract "ratecontrol.cpp@RateControl::RateControl"
```

Specifying an unambiguous path inside an index still has rough edges (#85). When a name resolves to
several candidates, the **interactive REPL** is often the easiest route: it lists the matches
numbered and you pick one in the next command (e.g. `[2]` or `[3]`). `[[placeholder: confirm the REPL
numbered-selection syntax, and whether a dedicated issue beyond #85 tracks path-spec UX.]]`

(`--hotspots` is deliberately not shown on x265 — on a C++/assembly corpus its line-based ranking is
skewed by assembly files and duplicate symbol rows; #334.) For the command that reveals something
genuinely unexpected, see **"What does the code reach out to?"** below — it's most striking on
application and binary code.

### ffmpeg — one-module-per-file C, at scale

Shows CodeExam on a large tree (`libavcodec`, `libavformat`, …) — orientation and cross-reference
are some places CodeExam can help when there's too much to read quickly.

```bash
# Source: https://github.com/ffmpeg/ffmpeg
#   (Code ▸ Download ZIP: https://github.com/FFmpeg/FFmpeg/archive/refs/heads/master.zip)
node src/index.js --build-index ./ffmpeg-src --index-path .ffmpeg --use-tree-sitter
node src/index.js --index-path .ffmpeg --overview
node src/index.js --index-path .ffmpeg --call-tree av_index_search_timestamp
node src/index.js --index-path .ffmpeg --vocabulary 30
```

`[[placeholder: refresh the "sample scale" figures for zlib/x265/ffmpeg from a current build — the
first-run numbers were ~175/1,169/54k (zlib), ~303/2,626/354k (x265), ~5,434/43,739/2.15M (ffmpeg).]]`

### More non-AI candidates

- **x264** — the H.264 companion to x265 `[[placeholder: source URL — VideoLAN's GitLab, not
  GitHub]]`.
- **Parts of Chromium** — Chromium is too large to index whole on most machines; index a
  manageable subtree (e.g. HTML parsing / DOM element creation) instead `[[placeholder: recipe
  pending a pre-index term-scan to pick a subtree — #279]]`.

## Multi-source build: index several repos as one corpus

`--build-index @list.lst` builds from a list file (one source path or archive per line), so a set of
related repos becomes a single index.

```bash
node src/index.js --build-index @sr_gh.lst --index-path .sr_gh --use-tree-sitter
```

To build `sr_gh.lst`: start at [github.com/safety-research](https://github.com/safety-research) and
download the code `.zip` for each of these repos — **auditing-agents** (e.g.
`https://github.com/safety-research/auditing-agents/archive/refs/heads/main.zip`),
**automated-w2s-research**, **bloom-main**, **faithful-cot**, **safety-tooling**. Put the
path/filename of each downloaded `.zip` on its own line in `sr_gh.lst`, then run the command above.
(`--build-index @list` reads local paths/archives, **not** URLs — so download first; confirmed
2026-10-03.)

## Quasi-source: index a codebase you only have as a binary

CodeExam can recover indexable structure from artifacts never shipped as source — including
JavaScript bundled inside a native executable. Two steps: pull the JS out of the executable, then
build over it.

```bash
# 1. Extract the embedded JS (use your own claude.exe path; quote it if it has spaces)
ce --extract-js-from-binary "<path>\claude-code\bin\claude.exe" --output-dir .\claude_exe_js
# 2. cli.js is ONE very large minified bundle — split it into modules, and raise Node's heap first
#    (a plain --use-tree-sitter build runs out of memory):
#      POSIX:    export NODE_OPTIONS=--max-old-space-size=8192
#      Windows:  set NODE_OPTIONS=--max-old-space-size=8192
node src/index.js --build-index claude_exe_js --split-bundle --index-path .claude_exe_js
```

**This build is demanding.** The extracted `cli.js` is a single, very large (~400k-line) minified
bundle — the "pathological single file" case. Building it with `--use-tree-sitter` can exhaust Node's
default (~4 GB) heap and crash with a bare `JavaScript heap out of memory`. The invocation above is a
**workaround**, not a fix: `--split-bundle` breaks the bundle into component modules (a more useful
index anyway) and `NODE_OPTIONS=--max-old-space-size=8192` lifts Node's ~4 GB default heap. A cleaner
in-tool
message — detecting the oversized input and pointing you at these flags *before* the crash — is
tracked separately (#88 and the pre-flight-guidance item).

Two flags that are easy to confuse: **`--extract-js-from-binary`** pulls JS *out of a native
executable*; **`--split-bundle`** (used with `--build-index`) splits an already-present *JS bundle*
into its component modules. These two steps are slated to fold into `--build-index` (#74 / #76), so
the recipe may simplify. See [`QUASI_SOURCE.md`](QUASI_SOURCE.md).

## AI/ML code: see the models and prompts inside an application

Point CodeExam at an AI application and it will surface the AI *in* the code. Using the index built
from `claude.exe` above, the **prompt catalog** recovers the LLM instruction strings the app ships:

```bash
node src/index.js --index-path .claude_exe_js --prompt-catalog
```

On the `claude.exe` bundle this finds **~184 prompts** — the actual tool and system instructions the
agent uses (page-DOM execution, accessibility-tree retrieval, and so on), each with the line to
`--extract` and read in full. The same detector suite finds the models a codebase defines and uses,
LLM/agent/embedding constructs, and the operational stack — and it works on ordinary AI/ML *source*,
not just extracted binaries. See [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).

`[[placeholder: optionally add a second AI/ML example on a native-source ML codebase (e.g. a PyTorch
project) to show --models / the detector suite on plain source, so this section isn't only the
claude.exe bundle.]]`

## What does the code reach out to? (referenced resources)

`--referenced-resources` surfaces the **external surface** — the hosts, env vars, file paths,
embedded SQL, and cloud markers the code *points to but does not contain*. It's deterministic (no
AI), and it's where you find things a summary would never tell you.

A good corpus for it is the Claude Code **plugins marketplace** — a normal GitHub repo of
third-party plugin "skills":

```bash
#    [[placeholder (Andrew): confirm the GitHub URL — the index was built from `plugins-main.zip`
#    (the "plugins" repo, default branch main); confirm the owner/org before publishing.]]
node src/index.js --build-index ./plugins-src --index-path .plugins --use-tree-sitter
node src/index.js --index-path .plugins --referenced-resources
```

From code you'd think of as mostly documentation and skills, this turns up:

- **Embedded SQL** — `SELECT * FROM users WHERE id = ?`, `CREATE TABLE users (id INT)`,
  `UPDATE accounts SET balance = balance - ? WHERE id = ?` — real queries across the Cloudflare,
  Render, and Vercel plugins.
- **API-credential environment variables** — `TWILIO_AUTH_TOKEN`, `OPENAI_API_KEY`,
  `CLOUDFLARE_API_TOKEN`, `HF_TOKEN`, `ZOOM_WEBHOOK_SECRET`, `DATABASE_URL`, … — the third-party
  secrets each plugin expects to find.
- **~800 distinct hosts** — `shopify.dev`, `zoom.us`, `openai.com`, `huggingface.co`,
  `api.cloudflare.com`, and hundreds more.

That "what is this actually talking to, and what does it expect to have?" view is exactly the kind of
unexpected, examiner-relevant finding CodeExam is for — all of it deterministic, no AI. See
[`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md).

## Index CodeExam itself

CodeExam indexes cleanly — so a good way to learn it is to point it at its own source and use its
features to explain its features:

```bash
# From the CodeExam project root
node src/index.js --build-index . --index-path .ce --use-tree-sitter
```

Then see how CodeExam's own command line is wired — `--command-catalog` maps every CLI flag to the
handler function that implements it:

```bash
node src/index.js --index-path .ce --command-catalog
```

This reports CodeExam's ~118 CLI options, its commands, and its GUI/server routes, each linked to
its handler (`--build-index → buildIndex`, `--call-tree → doCallTree`, …) — so you can go straight
to the code behind any flag with `--extract`. And because CodeExam has an optional AI layer,
`--prompt-catalog` on its own index shows **CodeExam's own** LLM prompts — the exact places a model
touches its output (the "determinism boundary"):

```bash
node src/index.js --index-path .ce --prompt-catalog
```

`[[placeholder: pick the single most illuminating "CE explains a CE feature" walk-through to feature
here — e.g. command-catalog → --extract the handler behind one flag, or --prompt-catalog → the
determinism-boundary prompts. Confirm output on a freshly-built .ce index.]]`

## Related

- [`GETTING_STARTED.md`](GETTING_STARTED.md) — install and the ways to run CodeExam.
- [`CODEEXAM_CLI.md`](CODEEXAM_CLI.md) — the full command set.
- [`QUASI_SOURCE.md`](QUASI_SOURCE.md) — binary and bundled-JS extraction.
- [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md) — the AI/ML, LLM-app, and infrastructure detectors.
- [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md) — the catalogs, including `--referenced-resources`.
- [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md) — the duplicate detection the zlib recipe shows off.
