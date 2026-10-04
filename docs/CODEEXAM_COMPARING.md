# Comparing code

CodeExam compares code within and across codebases — finding near-duplicate and
structurally similar functions, diffing structure, and surfacing notable shared
strings. For the kinds of comparison CodeExam doesn't do, this page also names
the dedicated external tools to reach for.

> **Outline — the fuller version lands shortly after public release.** This page
> is the topic list for the expanded doc; the commands themselves already work
> today (see [`CODEEXAM_CLI.md`](CODEEXAM_CLI.md) and
> [`CODEEXAM_GUI.md`](CODEEXAM_GUI.md)).

Planned coverage:

- **Near-duplicate functions** (`--near-dupes`, `--dedup`) — functions that are
  nearly identical across the codebase.
- **Structural duplicates** (`--struct-dupes`) — the same control-flow shape
  under different names: copy-pasted or templated code the text wouldn't match.
- **Structural diff** (`--struct-diff`) — comparing the structure of two
  functions, or two versions of one.
- **Notable shared strings** — "funcstring" matches that flag related code by the
  distinctive literals it contains.
- **Where CodeExam stops — the external tools to reach for:**
  - line/text diff — `diff`
  - [WinMerge](https://winmerge.org) — visual file/folder comparison (Windows)
  - [Beyond Compare](https://scootersoftware.com) — visual file/folder comparison
  - fuzzy hashing — [ssdeep](https://ssdeep-project.github.io)
