# Uncovering what a codebase is about

Before you can examine a codebase you have to get your bearings in it — and often
you're handed one you've never seen, or one deliberately made hard to read
(minified, bundled, stripped). Sometimes you *do* know what you're after — you've
been tasked with finding particular keywords — but even then the terminology the
codebase actually uses can be nothing like those keywords, so you still have to learn
how *this* code names things. CodeExam has a small set of features aimed squarely at
that first question: *what is this code about, and where should I start?* They run off
the index, so they behave the same on a million-line tree as on a single file.

Two of them — the **Overview** and the **AI Overview** — attempt to synthesize the
whole index into an initial orientation to the codebase's key terminology and
nomenclature. The other two — **vocabulary** and **breadcrumbs** — surface the raw
signals that orientation is built from, and are useful on their own.

## Overview — `--overview`

`ce --overview` prints a one-screen orientation to a codebase, computed entirely from
the index. **No language model is involved** — the same index produces the same
overview every time. It's the natural first command to run on a fresh index.

On zlib, for instance, it reports:

- **Shape** — size (files, functions, lines), the language mix, the common path
  prefix, and the top-level directories with file counts.
- **Potentially important concepts** — the distinctive term-clusters the codebase is
  organized around, each anchored to an example symbol so a concept is more than a
  bare word: `inflate` (→ `inflateSetDictionary`), `deflate` (→
  `deflateSetDictionary`), `crc32` (→ `crc32_combine_gen64`), `unz` / `zip` (the
  minizip contrib). These are ranked to favor what is distinctive to *this* code, not
  just what is frequent (see **Vocabulary** below for how).
- **Potentially important files** — the files where those distinctive terms are most
  concentrated. CodeExam counts how many of the codebase's top-ranked terms each file
  carries (zlib's `unzip.c` holds 73 of them, `zlib.h` 69, `zip.c` 53) and ranks by
  that density, so the files touching the most of what the codebase is *about* rise
  first — good first files to open.
- **Entry points** — functions at the edges of the call graph (`deflate_slow`,
  `gzsetparams`, the win32 file-function shims …).
- **Next** — the commands that follow naturally from what it just found:
  `--extract` / `--digest` on a named function, `--vocabulary 50` for the full term
  list, `--files <dir>` to explore a folder, `--command-catalog` / `--models` /
  `--prompts` to probe what kinds of content the index holds.

The concept and file lists come straight from the vocabulary ranking, so an overview
is only as sharp as the vocabulary underneath it — which is a feature in its own right
(see **Vocabulary**, below).

## AI Overview — `--overview-by-ai`

`ce --overview-by-ai` produces a *written* orientation instead of a structured one: a
short prose narrative of what the code is, its architecture, and what it does, plus
two things the deterministic overview can't give you —

- **"Where to look first"** — up to five highest-payback commands for *this*
  codebase, each with a one-line reason, and explicitly including where a tool is
  *defeated* by the target ("skip X here"). This is the "what to look at next"
  guidance, reasoned about the actual code rather than a fixed list.
- **"Questions to start with"** — up to five orienting questions, each paired with the
  single CodeExam action that most directly answers it, and mixed across the GUI (open
  an accordion, ask the Chat pane about a term) and the CLI.

It runs against a cloud LLM or a local GGUF model — your choice of engine — and is
**grounded by default**: the model is told to base the overview only on what the tools
surface about the code, and to say when something can't be determined rather than
filling the gap from general knowledge. Because a model is involved, the AI Overview
is optional and does not repeat bit-for-bit the way the deterministic overview does.
For the engine choice see [AI_ASSISTED_CODE_EXAM.md](AI_ASSISTED_CODE_EXAM.md) and
[LOCAL_LLM.md](LOCAL_LLM.md); for what does and doesn't repeat,
[REPRODUCIBILITY.md](REPRODUCIBILITY.md).

## Vocabulary — `--vocabulary` / `--vocab`

`ce --vocabulary 50` prints the codebase's domain terms, ranked so that what is
*distinctive to this codebase* rises to the top rather than what is merely frequent.
The ranking is cross-document **TF-IDF** — [term frequency–inverse document
frequency](https://en.wikipedia.org/wiki/Tf%E2%80%93idf), a standard measure that
scores a term highly when it appears often in one document but seldom across the rest,
so boilerplate common to every file is pushed down and terms peculiar to a few files
rise. CodeExam applies it across the files of the codebase, with a per-function
fallback for single-file or bundled corpora where there aren't enough separate
documents to compare.

Two details worth knowing:

- **A shipped cross-corpus catalog sharpens the ranking.**
  `CE_cross_corpus_vocab_catalog.json` (auto-loaded from CodeExam's `src/`) records terms
  that recur across many different codebases — `function`, `handler`, `data`,
  `manager` — and *demotes* them, so genuinely distinctive terms surface. Delete the
  file and results simply revert to the plain TF-IDF baseline; nothing else changes.
- **`--bare`** drops the formatting and prints a plain term list, for pasting into a
  search, a claim expression, or a note.

Vocabulary is the signal the Overview's "concepts" and "important files" lists are
built from; running it directly gives you the full ranked list rather than the
overview's top slice.

## Breadcrumbs — `--breadcrumbs`

`ce --breadcrumbs` surfaces the telemetry markers in a codebase — logging, analytics,
and audit calls — together with the functions they sit in. On readable source that's
a quick map of what a program records about its own behavior; on an obfuscated or
minified artifact it's often the most legible thing left, a way to see what the binary
actually reports back even when the surrounding names are gone.

## Going deeper into the code

Several neighboring feature sets carry the orientation further once the Overview has
given you a foothold. They live in their own pages rather than being repeated here:

- **Code-surfacing metrics** — hotspots, most-called, domain-function ranking, entry
  points, and dead-code gaps — rank functions and classes by centrality and
  complexity. See [CODEEXAM_KEY_FEATURES.md](CODEEXAM_KEY_FEATURES.md).
- **Cross-references** (`--callers`, `--callees`, `--call-tree`) — who calls a
  function, what it calls, the transitive call tree, and file/folder coupling maps:
  how you navigate the code once the Overview has pointed you at a starting function
  or file. See [CODEEXAM_KEY_FEATURES.md](CODEEXAM_KEY_FEATURES.md).
- **Digests** (`--digest`) — a concise summary of one function, class, or file
  (identity, callers and callees, distinctive strings, structural shape), for taking
  in one of the "important files" without reading the whole thing. See
  [CODEEXAM_KEY_FEATURES.md](CODEEXAM_KEY_FEATURES.md).
- **Catalogs of what the code does** — the command catalog (CLI options,
  slash-commands, and recognizable menu/dialog actions, each linked to its handler
  function), plus the content probes the Overview's `Next:` block points at
  (`--command-catalog`, `--models`, `--prompts`, `--exports`). See
  [CODEEXAM_KEY_FEATURES.md](CODEEXAM_KEY_FEATURES.md).
- **Referenced resources** (`--referenced-resources`) — the external surface: the
  environment variables, hosts and URLs, embedded SQL, external commands, and
  data/config files a codebase reaches out to. See
  [CODEEXAM_KEY_FEATURES.md](CODEEXAM_KEY_FEATURES.md).
- **The AI/ML and infrastructure detectors** — the models, LLM calls, tools, prompts,
  and operational stack a codebase contains. See [DETECTING_AI_ML.md](DETECTING_AI_ML.md).
- **"Searching by counting"** — because CodeExam sorts most of its catalogs by a measure of
  importance (occurrences, references-to, length, with an inverse-frequency weighting that demotes
  generic items), eyeballing the *top* of such a list — the left-accordion categories in the GUI —
  is itself a way to approach what might be important in a codebase without knowing its name first.
  See [CODEEXAM_BROWSING.md](CODEEXAM_BROWSING.md).

Some of these are still being tuned toward their intended sharpness — hotspots and
dead-code gaps in particular — so read their output as a strong starting signal, not a
settled verdict.
