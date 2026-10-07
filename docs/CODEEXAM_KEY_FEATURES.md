# CodeExam key features

CodeExam is more than grep over a codebase. This page covers two frequently-used features —
**Overview** and **Digests** — and points to the rest: searching, browsing, detection, and the
features related to patent claims (and other technical prose), each documented on its own page.

## Overview: orient in one command

**`--overview`** is where to start on an index you've never seen. In one shot it reports the codebase's
size and languages, its top-level structure, distinctive domain vocabulary, key files by term
density (see [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md)), likely entry points, and a few "watch"
notes — ending with a suggested next step. It's a fast, deterministic read of what a codebase is and
where its center of gravity likely sits.

**`--overview-by-ai`** is the optional agentic version: an LLM drives CodeExam's own tools to write a
prose orientation, grounded in what it actually retrieved. It's one of the few places a model touches
CodeExam's output — the trade-offs, and which local models can do it, are in
[`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md).

## Digests: understand one target fast

**`--digest`** gives a concise, mechanical summary of a single function, class, or file — no
interpretation, just what's there:

- **Function** — identity, callers and callees, distinctive strings, and structural shape.
- **Class** — the same, plus the **inheritance chain** and known subclasses with their
  method-override counts.
- **File** — the same, plus its imports and exports.

A digest is useful on its own as a quick read of a target, and it's also the unit CodeExam feeds to
an LLM when you ask it to analyze something (see [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md)).
A companion mode, `--comments-only`, pulls just a target's comments — a quick way to read the
stated intent, and to spot where the comments and the code disagree.
Reliable class-hierarchy tracking in static examination — especially for C++ — is still being
hardened (#65, #60), so treat deep inheritance chains as a strong lead rather than the last word.

## Searching

Find code by what it contains: literal, fast (inverted-index), and regex search, plus **multisect** —
the smallest scope containing substantially all of *N* terms at once — and `--claim-search`, which
turns prose (a patent claim, a spec) into a multisect query. Full treatment in
[`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md).

## Browsing

Survey and navigate a codebase: the structural lists (functions, files, classes, data structures),
the catalogs (command catalog, breadcrumbs, client/server, referenced resources, imports/BoM,
distinctive strings, vocabulary), cross-reference (callers, callees, call trees, coupling maps), and
code-surfacing metrics for finding where to start reading. CodeExam lists items within each
category by order of importance — often based in part on how many times an item occurs and how many
other things reference it — which enables what this documentation calls **"searching by counting"**:
eyeballing the top of a sorted catalog to find what matters without knowing its name. Full treatment in
[`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md).

## Detection and claims

- **AI/ML and LLM-app detection** — cataloging the models, LLM calls, tools, chains, and prompts in
  a codebase: [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md).
- **Structural search** — finding code by shape rather than text (duplicate and cross-source
  matching): [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md).
- **Patent-claim analysis** — claim charts and the rest of the patent-claims pipeline:
  [[placeholder: link to `CODEEXAM_PATENT_CLAIMS` (the larger patent-claim analysis page) once it
  exists — a distinct page from the small **CodeClaim** feature page. Both still need worklist
  items.]]

## Related

- [`GETTING_STARTED.md`](GETTING_STARTED.md) — installing and running CodeExam.
- [`CODEEXAM_SEARCHING.md`](CODEEXAM_SEARCHING.md) and [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md)
  — the two capabilities this page summarizes.
- [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md) — the optional LLM layer behind
  `--overview-by-ai` and analyze.
