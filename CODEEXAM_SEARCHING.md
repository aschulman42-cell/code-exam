# Searching in CodeExam

Searching is finding code by **what it contains** — a string, a pattern, or a set of terms that
have to co-occur. It runs off the same index as everything else, so the CLI, the REPL, the GUI, and
the MCP server all search the same way. This page covers the text-search modes and **multisect**,
CodeExam's multi-term search. Finding code by its *shape* rather than its text is a different tool,
covered in [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md). Surveying a codebase via CodeExam-created
catalogs — organized by kind of component (functions, classes, commands, strings, AI/ML usage, and
more) — is in [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md).

## The text-search modes

In every mode below, CodeExam gives a hit fuller context than a filename and line number — see
**How results are shown** below.

- **`--search` / `--literal`** — plain substring search across indexed content.
- **`--fast`** — inverted-index search: the same query resolved through the token index, for speed
  on large codebases.
- **`--regex`** — regular-expression search, with the matched line and its context. Importantly,
  regex includes **alternation** (`|`, i.e. "OR"), which is how you search for a set of synonyms at
  once — `buffer|cache|pool` finds any of the three.
- **`--files-search` / `--folders-search`** — search over file and folder *paths* rather than
  contents, for locating things by where they live.

Text search also does **rename-marker query expansion**: because CodeExam infers readable names for
minified or obfuscated identifiers (see [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md)), a search
for a readable name can also turn up the mangled identifier it was inferred from, and vice-versa —
so you have help even with a bundle that renamed everything to `a`, `b`, `c`.

## Multisect: multi-term search with scope

Plain search finds one string or regular expression at a time. **Multisect** (`--multisect-search`,
or `--multisect`) finds the **smallest scope** — function, then class, then file, then folder —
that contains substantially all of *N* terms at once. That is the query you actually want when
you're asking "where is the code that does X, Y, and Z together," because the answer is rarely a
single line — it's a function or class or file where several concepts meet.

Each term can be:

- **hard-required** (the default) — it must be present;
- **negated** — `!term` or `NOT term` excludes scopes that contain it from the result set. Note
  CodeExam may still *show* where a negated term appears: a term the argument says should be
  *absent* is often exactly where the dispute lives [[placeholder: issue # — "one place the fight
  may be"]];
- **soft** — `?term` is optional: it does not gate the result set, but its presence **boosts the
  ranking** of scopes that do contain it.

Matches are scored by term rarity (**IDF — Inverse Document Frequency**; a distinctive term counts
for more than a common one), so the highest-ranked scope is the one where the rarest terms genuinely
co-occur rather than one that merely mentions common words. Two adjustments keep the ranking honest:
a term matched in **code** weighs more than one matched only in **comments or documentation**, and
sites in **test / example / demo** code can be down-weighted or dropped with `--no-tests` /
`--exclude-tests` (finer comment/doc match controls are proposed in #138). The result is the
tightest scope first, widening only as needed.

## Searching from prose

`--claim-search <prose>` turns a block of descriptive text — a patent claim, a design spec, a bug
report — directly into a multisect query. CodeExam extracts the distinctive terms and, optionally,
uses an LLM to add **synonyms** for each term so the search isn't defeated by wording differences.
It produces two term sets — a **TIGHT** set (the precise terms, for a high-precision search) and a
**BROAD** set (the terms plus synonyms and broader wording, for higher recall) — and can run either;
it can also have an LLM summarize each match. The extraction and the optional LLM steps are
described in [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md); the patent-specific workflow
(claim charts and the rest) is in [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md).

Bridging prose and code that use **different terminology** — the "vocabulary hop" — is very much a
work in progress; synonym expansion (above) and `--synonymize` are the current mechanical
approaches. Why CodeExam does *not* (yet) reach for a semantic / vector database to do this is
explained in [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md) — the embedding-on-top-of-lexical
exploration, #201 / #202.

## How results are shown

CodeExam reports a hit in **`file@func` context, not just `file:line`** — you see *which function
or class method* a match lands in, not only a line number. That context — `file@function` — is
usually what tells you whether a hit matters. Matching lines come with their surrounding lines, and
from a hit you can open the function (click it in the GUI, or `--extract` on the CLI), **digest** it
(`--digest` — its identity, callers, callees, and distinctive strings), or **cross-reference** it
(jump to its callers or callees) in one step.

**A caution on result limits.** Like the rest of CodeExam, search results are **limited by default**
(the top N). A limited result is *not* evidence that nothing else matches — the missing item may
simply be past the limit. When absence matters, raise the limit and re-run: `--max-results` (aliases
`--max`, `-n`) on the CLI, or the equivalent limit control in the GUI. (The same caution appears in
[`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md), #137.)

## Related

- [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md) — finding code by structure / funcstring, not text.
- [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md) — the catalogs and cross-reference that complement
  search.
- [`AI_ASSISTED_CODE_EXAM.md`](AI_ASSISTED_CODE_EXAM.md) — `--claim-search` extraction and LLM
  summaries.
- [`CODEEXAM_PATENT_CLAIMS.md`](CODEEXAM_PATENT_CLAIMS.md) — claim charts and the patent-claim
  workflow that `--claim-search` feeds.
- [`CODEEXAM_MCP.md`](CODEEXAM_MCP.md) — the `search`, `regex_search`, and `multisect_search` tools.
- [`CODEEXAM_KEY_FEATURES.md`](CODEEXAM_KEY_FEATURES.md) — where searching sits among CodeExam's
  headline capabilities.
