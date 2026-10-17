# Measuring importance

CodeExam is constantly estimating which terms, functions, and files are
**important** — distinctive, central, worth looking at first — and using that
estimate to **steer your attention**. "Importance" here is not a claim of
objective worth; it is a heuristic blend of signals CodeExam combines to decide
what to **surface** — lift out of the depths of the code and show more
prominently — and how to order what it shows. This page consolidates how that
estimate is made (the term appears across many docs with no single home) and
where it shows up. ("Surface", throughout, means exactly that: bring something up
from a lower level and show it nearer the top — not a catch-all verb.)

It helps in two different situations:

- **You don't yet know what you're looking for.** Importance points you toward
  some code that stands out — distinctive vocabulary, structural hotspots, the
  Overview — so you can start where some signals are, rather than at file #1.
- **You already know what you want.** When you `--filter` or search, importance
  ranks the matches so the strongest candidates appear towards the top rather
  than in arbitrary order.

## The signals CodeExam combines

### 1. Term rareness *within* the codebase (TF-IDF)

Domain-vocabulary discovery (`src/core/vocabulary.js`) scores terms TF-IDF-style:
a term that is frequent in a few files but rare across the codebase is
**distinctive** ("domain vocabulary"); a term that is everywhere is noise.
Corpus-shape and license-text noise that swamps TF-IDF is handled with explicit
stopword lists (#172).

**Powers:** `--vocabulary`, the Overview and Overview by AI, and the breadcrumb
labels.

### 2. Term rareness *across* codebases — "universal-term down-weighting"

Beyond this one codebase, CodeExam keeps a **cross-corpus catalog**
(`src/CE_cross_corpus_vocab_catalog.json`, #180) that records how many of the
codebases CodeExam has indexed contain each token. A token in *many* corpora
(`function`, `get`, `main`, `error`, `the`) is corpus-universal noise, not domain
vocabulary. CodeExam multiplies each token's within-codebase TF-IDF by a
**cross-corpus weight in [0.1, 1]** — ~1 for distinctive tokens, approaching 0.1
for universal ones — which **demotes, never deletes** (a universal term still
ranks high if it is overwhelmingly this codebase's own). CamelCase/snake
sub-tokens are down-weighted the same way (#193). This is the "universal-term
down-weighting active" line you see at build time.

**Powers:** the same places as signal 1 (`--vocabulary`, the Overview) — it
refines their ranking so this codebase's distinctive terms beat cross-project
boilerplate.

### 3. Call-to centrality (hotspots / most-called)

How often a function is called is a structural-centrality signal: a function many
others depend on is a **hotspot**, with ALL-CAPS macros and language built-ins
filtered out by default so they don't dominate (`src/commands/metrics.js`,
`src/commands/callers.js`; `getHotspots` in `src/core/`).

**Powers:** `--hotspots` and `--most-called` (and the GUI's hotspot /
most-called views).

> TODO — confirm and document the exact hotspot score (whether/how it blends
> call-counts with the vocabulary signals above), and the `--most-called`
> ranking details.

### 4. Name and structure

Name length and shape and other structural properties also feed salience (very
short or generic names are demoted).

**Powers:** _to confirm — see the TODO below (feeds into the vocabulary and
hotspot ranking rather than a listing of its own)._

> TODO — enumerate the exact name/structure signals and their weights, and
> which rankings they feed.

### 5. Candidate salience (pseudo-claims)

The pseudo-claim **candidate grouper** uses salience to choose which mechanisms
to **surface** (lift out of the codebase as candidate claims), and `--rank`
orders them by a bounded-LLM worthiness score.

**Powers:** `--pseudo-claims --candidates` and `--pseudo-claims --rank`. See
[`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md).

## Where importance drives default sorting

Importance is not just for explicit "rank" commands — it is the **default order**
of many lists and catalogs:

- **CLI** — `--hotspots`, `--vocabulary`, `--most-called`, and other listings
  print in importance order by default (raise the cap with `--max-results` /
  `--all-results`).
- **GUI** — the **left-accordion** lists default to importance order rather than
  alphabetical or file order, so the first thing you see is the most salient.

> TODO — confirm the exact default sort key per GUI accordion section and per CLI
> listing, and note where it differs.

## Methods still being considered

> TODO — candidate signals not yet shipped (and trade-offs). Andrew may fold in
> additional methods from his methodology notes (e.g. a corrected
> `reveng_methodology_and_src_code_methodology_notes_071821.pdf`) once those are
> up to date.

## See also

- [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md) — vocabulary, breadcrumbs,
  Overview / Overview by AI (the main consumers of importance).
- [`CODEEXAM_BROWSING.md`](CODEEXAM_BROWSING.md) — hotspots and cross-reference
  metrics.
- [`CODEEXAM_PSEUDO_CLAIMS.md`](CODEEXAM_PSEUDO_CLAIMS.md) — candidate salience.
- [`CODEEXAM_ARCHITECTURE.md`](CODEEXAM_ARCHITECTURE.md) — where these live.
