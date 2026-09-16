# Testing CodeExam

CodeExam is tested two ways, because it has two kinds of code. The deterministic engine —
indexing, search, cross-reference, and the scaffolding around the LLM features — is covered
by a conventional automated suite, where each test checks that the code produces an exact
expected result. The LLM features themselves are somewhat non-deterministic (see #319), so
there is no single exact output to check against; they are **evaluated** instead. This page
covers both.

## The deterministic suite

```bash
npm test        # node --test "test/test_*.js"
```

The suite runs on **node's built-in test runner** — no external framework, no test
dependencies to install. As of this writing it is **1,835 tests across 390 suites, all
passing, in ~82 seconds** on Windows (and green on Unix-likes), spread over 75
`test/test_*.js` files. It covers the indexing engine, search and multisect, cross-reference
(callers / callees / trees), fingerprinting and dedup, the catalogs, and the deterministic
scaffolding around the LLM layer (prompt assembly, verdict merging, the honesty counts).
Because none of this involves a model, it is **reproducible** — the same code over the same
index produces the same result every run (see [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md)).

**One example test.** `test/test_multisect_scoring.js` verifies the *semantics* of multisect
scoring, and it's a good example of what the test suite guards:

- a term matching inside a **comment** counts less than one matching in **code**
  (`classifyMatchLine` plus a fixed `COMMENT_MATCH_WEIGHT`) — comments can be wrong or
  misleading, so they are weaker evidence. (Of course, symbolic names in code can be wrong or
  misleading too — see [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md); the point is only that
  a comment is weaker still.)
- **surface area is not a score** — the same terms packed into a few lines should outrank
  them scattered through a giant function. A density factor stays at 1.0 up to 50 lines, then
  falls off, and the test checks exactly that:

  ```js
  assert.equal(matchDensityFactor({ lines: 10 }), 1);
  assert.equal(matchDensityFactor({ lines: 50 }), 1);
  const d500  = matchDensityFactor({ lines: 500 });   // ≈ 0.5
  const d5000 = matchDensityFactor({ lines: 5000 });
  assert.ok(d500 < 1 && d5000 < d500 && d5000 > 0);
  ```

Both behaviors are deterministic — the weights are constants in the code, not CLI options —
so the test locks them in place. That's the shape of most of the suite: verifying the
*meaning* of a computed number, not merely that the code runs.

**GUI tests are not yet automated.** GUI test automation built on
[XMLUI](https://www.xmlui.org/) is under evaluation (#73); today the GUI is exercised by
hand.

**One gap:** a couple of test fixtures aren't in git yet (`sample_patent_claim.txt`, some
`synon_*` files), so a *fresh clone* currently fails ~20 tests until those land — a known
pre-release gap, not a real regression. With the fixtures present, the suite is fully green.

## Running the tests yourself

The suite is worth running even if you aren't developing CodeExam. It has no external
dependencies and finishes in about a minute, so an examiner can run `npm test` on their own
machine and watch the tool behave exactly as documented. That is part of making an
examination's results defensible and auditable (#319): the reliability of the instrument
isn't something to take on faith — it's something you can re-run and check.

## Empirical model evaluation

You can't unit-test whether a language model *judged well*: its output isn't a fixed value to
check against, and — for cloud models — isn't fully reproducible even at temperature 0. So
rather than checking each LLM feature against one correct answer, CodeExam **measures how well
each model performs**, feature by feature, on a separate track:

- **A per-feature × per-model matrix** — [`docs/model-support.md`](docs/model-support.md)
  records which local and cloud models are SUPPORTED / DEGRADED / UNSUPPORTED / UNTESTED for
  each LLM feature (claim charts, `--analyze`, overview, claim-search, …), every cell backed
  by a cited run rather than an assumption.
- **Acceptance runs on real models** — the RunPod GPU arc that *originally* validated the
  local-model path (#245), before local testing moved to a laptop with an RTX 5080 (16 GB);
  and cross-machine acceptance checks such as the line-ending-parity run that confirmed **zero
  of 225** verdict differences between two chart modes.

The split runs through these docs: the deterministic half is **verified against exact expected
results**; the model half is **measured** — how often it gets things right — because there is
no single exact result to check it against.

## Related

- [`LOCAL_LLM.md`](LOCAL_LLM.md) — the local-model path and its RunPod testing.
- [`docs/model-support.md`](docs/model-support.md) — the per-feature × per-model evaluation matrix.
- [`REPRODUCIBILITY.md`](REPRODUCIBILITY.md) — why the deterministic half reproduces, and where a model does or doesn't.
- Planned: examining code *with* Claude — code-review and security-code-review workflows — will get their own pages, cross-referenced here once they land.
