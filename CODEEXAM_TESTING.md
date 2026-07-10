# Testing CodeExam

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part P pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

## Testing

```bash
npm test          # node --test "test/test_*.js"
```

~400 tests across the test suite, covering the indexing engine, search,
multisect, cross-reference, fingerprinting, dedup, and the LLM-assisted
command layer. The suite runs green on Windows and Unix-likes. GUI tests are
not yet automated — GUI test automation built on [XMLUI](https://www.xmlui.org/)
is under evaluation (see #73's feasibility study).
