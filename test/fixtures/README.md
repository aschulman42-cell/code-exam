# Test fixtures

Inputs several tests are built on. They live here, tracked, because a fresh
clone could not otherwise pass its own suite: these four files sat untracked in
the repo root, so `npm test` validated *an environment* rather than a checkout.
asus-CC hit it on a tree synced from the `58a596d` zipball — 20 `ENOENT`
failures across `test_claim_analyze`, `test_claim_chart`, `test_claim_locate`
and `test_synonymize` (#314).

**None of this is customer material.** `8752101_claim_1.txt` is a real claim but
a published one — US 8,752,101, public record. `sample_patent_claim.txt` is
synthetic, written to exercise claim-splitting. The three synonymized files are
recorded engine outputs that already carry their own
`NOT a patent claim … do not file, quote, or rely on` headers.

| file | origin | kept for |
| --- | --- | --- |
| `sample_patent_claim.txt` | synthetic, hand-written — a TLS-handshake method claim in 11 elements over 28 physical lines | The primary claim fixture. `splitClaimElements`, the synonymizer's element-skeleton guard, and terminal-punctuation restoration are all measured against it — including the count in `terminatorsFor`'s comment (28 physical lines, 22 long enough to qualify, 11 elements) that explains why a line-indexed implementation was wrong |
| `8752101_claim_1.txt` | US 8,752,101 claim 1, verbatim — published patent text, public record | The real claim the '101 charts are built on. `test_claim_locate` measures element splitting and per-element retrieval against it. **Found only by running the fresh-clone check** — it was not in the original four, and it was a hard `readFileSync`, so it broke the suite outright |
| `sample_patent_claim_synon_chatgpt.txt` | ChatGPT `gpt-5.1`, 2026-08-16, `--synonymize` | A real `--synonymize-out` file **with a 9-line `#` header** — the header-stripping path in `readClaimFile` is tested against it rather than a hand-built approximation |
| `sample_patent_claim_synon_gemini_2.txt` | Gemini `gemini-2.5-flash`, 2026-08-16, `--synonymize` | A recorded output at 9.6% vocabulary survival that **re-split to 11 — preserved**, so the element skeleton is comparable to the original |
| `sample_patent_claim_synon_gemini_NEW.txt` | Gemini `gemini-2.5-flash`, 2026-08-17, `--synonymize` | The regression case `90d8f79` exists for: a rewrite that introduced a stray `, and`, and that **re-split to 12 — CHANGED, comparison unsafe**. `test_synonymize` replays this exact text to check row 2 is repaired and the claim re-splits to 11 |
| `gemini_v2_dropped_anchors.json` | Gemini `gemini-2.5-flash` — the `--pseudo-claims` anchor sidecar over CodeExam's own source, **distilled** | The 63 anchors CE dropped across 41 claims. `test_pseudo_claims` asserts every one now parses (#313). **Distilled from a 251 KB recorded run to 10.7 KB** by keeping only `claims[].dropped`, the sole field the test reads — the per-claim shape is preserved rather than flattened, so the 41 claims still read as 41 |

## Distil before committing

A fixture earns its bytes by what a test reads, not by what a run produced.
`gemini_v2_dropped_anchors.json` is 10.7 KB of a 251 KB recorded run because
`claims[].dropped` is all `test_pseudo_claims` ever touches. Prefer that to
committing a whole artifact — and prefer it to a `skip:` guard, which trades
the bytes for a fresh clone that reports green while testing less.

## Why these are committed rather than regenerated

They are **recorded engine outputs, and their value is that they are recorded.**
Regenerating means model calls in CI and a different result every run, and the
replay test depends on the exact recorded text — a synthetic substitute would
test the code against a case nobody has observed.

## Adding one

Resolve it from the test file, never from the working directory:

```js
import { fileURLToPath } from 'node:url';
const fixture = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
```

A bare `fs.readFileSync('name.txt')` resolves against **cwd**, which is what
made the original problem invisible to anyone running `npm test` from the repo
root with the files already there.
