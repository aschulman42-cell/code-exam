# Quasi-source: recovering structure from non-source artifacts

Most code examination assumes you have source. Often you don't — the thing in front of
you is a minified bundle, a compiled binary, or an installer with JavaScript packed
inside it. Or the source-code folders you've been given also include executable binaries,
possibly inside zip files. CodeExam's premise for these is that **a surprising amount of indexable
structure survives anyway**, and that once you recover it you can browse, search, and
cross-reference it with the very same machinery you'd use on real source. That
recovered structure is what CodeExam calls *quasi-source*. The work is tracked under
umbrella issue #76.

## One index, source and quasi-source together

The design choice worth stating first: CodeExam does not keep quasi-source in a separate
binary/bundle tool off to the side. It folds the recovered structure into the **same
index** as any real source in the tree, so a single search — or a single caller/callee
query — spans both: a function recovered from a compiled binary and a function from a
`.c` file sit in one file map, resolved by one query path.

The point is sharp enough that CodeExam's own pseudo-claim generator, pointed at a
CodeExam index, drafted a claim describing it. Its "unified index over source code and
compiled binaries" claim has CodeExam transform each binary into a virtual pseudo-source
file — one synthetic function per binary — and then admit source and pseudo-source alike
"*through one ingestion routine that applies no binary-specific branch*," building "*one
inverted index and one function-and-call-graph index … using the same parser used for
textual source*," so that caller and callee queries resolve "*across binary-derived
synthetic functions and textual-source functions uniformly*." That's an observation
about the design, not a claim of novelty — CodeExam's own assessment rated the claim only
"moderate-to-far" from prior art — but it's an apt description, and a nice illustration
of two features at once: the quasi-source merge, surfaced by the pseudo-claim feature.

## What CodeExam recovers

**Binaries** — executables and libraries sitting inside a source tree. CodeExam extracts
the printable strings and the C++ function signatures, demangling them (both Itanium and
MSVC name-mangling; point `--demangler` at `c++filt` or `vc++filt.exe`). Each binary
becomes a single pseudo-function holding its strings and demangled symbols: search and
the inverted index work on it exactly as on source, though per-function caller/callee
analysis does not apply to a binary's recovered content. Indexing a 27.7 MB Windows
executable, for instance, produced one synthetic function — `bram_exe()` — whose body is
the 46,809 printable strings recovered from the file, 86.9% of the raw string hits having
been dropped as noise (this one is a Bun-packaged executable, so strings dominate; a
compiled C++ DLL contributes demangled signatures too). This pays off most on *large*
binary corpora — Windows 11 system DLLs, Office plugin trees, vendor SDKs — where a
per-file string-and-symbol fingerprint is enough to navigate at scale.
`--inspect-binary <path>` looks at a single binary directly.

**Minified and bundled JavaScript** — minified JS is still JavaScript, and CodeExam's
tree-sitter parser recovers real function structure from it: the single 513,619-line
`cli.js` bundle recovered from Claude Code's `claude.exe` yields **28,441 indexed
functions**, each searchable and cross-referenceable like any hand-written one. Their
*names*, though, are usually gone — a minifier has rewritten them to short tokens like
`jy8` or `Kf`, and CodeExam cannot recover the originals. What it can do is **infer
descriptive names** and add them: `--build-rename-map` writes a `rename_map.json` from the
strings, keywords, and imports a function uses — and, via `--build-fp-renames`, from
structural fingerprints matched against reference library source. The inferred names are
applied at display time by default — `--no-rename` shows the raw tokens, and in the GUI the same
display toggle is **View → Show Inferred Name Suffixes** — and are included in search.
(`--rename-min-lines <n>` skips functions shorter than *n* when building the map.) The renaming
isn't specific to quasi-source — CodeExam infers names wherever they're short or obscured — but
minified and stripped artifacts are where it matters most. It does a reasonable job: the minified `jy8` becomes
`jy8_KW_STRICT_MCP_CONFIG_PLUGIN_DIR` — the raw token kept, a descriptor appended from the
distinctive strings it references — so a search for `MCP` or `PLUGIN` now reaches it. But
this is *inference, not recovery*: the author's original name is unrecoverable. For
bundles built by esbuild-style bundlers, `--split-bundle` goes further at index time,
splitting the one bundle into per-module virtual files so vocabulary, TF-IDF, and the
file map operate on the modules rather than one giant blob; `--bundle-seams` reports the
boundaries it detects.

Once recovered, quasi-source strings feed the same analyses as real source — including
`--referenced-resources`, which surfaces embedded SQL and other "executable strings" (code meant
for some interpreter) alongside URLs, hosts, environment variables, and paths, whether those
strings came from real source or were recovered from a binary.

**JavaScript embedded in native executables** — `--extract-js-from-binary <path>`
recovers the JS packed inside a native installer and writes it to a directory CodeExam
indexes normally. It is format-aware: today it handles Bun standalone executables (what
`claude.exe` is built as), including PE-signed Windows builds where the Bun trailer sits
ahead of the Authenticode certificate. Other packagers — pkg, nexe, Node SEA, Tauri's
asset table — are tracked as future work, not yet built. The recovered file is itself a
bundle (`cli.js`, in the `claude.exe` case), so extraction is normally followed by
`--split-bundle` / `--bundle-seams` (above) to break it into per-module files before
analysis.

The prompt-catalog image in the [README](../README.md) comes from exactly this path: LLM
prompts recovered from the minified `cli.js` inside `claude.exe`, then searched like any
other code.

## The tension CodeExam manages

Merging quasi-source into the main index is what makes it powerful — and it is also what
lets its noise leak into everything else. A binary's extracted strings and a minified
bundle's short minifier-generated names (`jy8`, `Kf`, `t3` — usually a mix of letters and
digits, and not to be confused with the C++ symbol *mangling* the binaries section
demangles) are full of tokens that aren't really vocabulary: version strings, base64
blobs, PE-section fragments like `.rdata`. Dropped into the same index as clean source,
they can distort exactly the machinery [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md) relies
on — the TF-IDF ranking, the "important concepts," the file-density scores meant to tell
you what a codebase is about.

CodeExam's answer is not to resolve the tension but to **manage the balance**, with
defaults that keep the noise out until you ask for it:

- **`.op` binary-string dumps are excluded from retrieval by default.** CodeExam's raw
  binary-string captures (`.op` pseudo-source) are held out of the candidate pool so
  they can't swamp a search; `--include-op` admits them when you specifically want them.
- **`--split-bundle` is opt-in.** Splitting a bundle into per-module files makes its
  vocabulary meaningful rather than one undifferentiated mass — but only when you turn it
  on, so ordinary trees aren't changed underfoot.
- **The cross-corpus vocabulary catalog demotes junk terms.** The same
  `CE_cross_corpus_vocab_catalog.json` that sharpens vocabulary (see UNCOVER) pushes down
  terms common across many codebases, absorbing a good deal of the boilerplate
  quasi-source drags in.

This is one of several places where CodeExam is balancing competing goods rather than
declaring a winner — here, reach versus cleanliness. Another: CodeExam tries on one hand
to *reduce* reliance on naming — the `--mask-all` option hides identifiers so a reading
can't lean on them — while on the other hand working to *generate* useful names to
replace obfuscated ones like `jy8`. The honest framing is that the balance is *tuned, not
solved*.

## Related

- Minified-JS deobfuscation and transform-resilient function fingerprints are the same
  spirit — finding code by its structure when its text has been rewritten — and live in
  [`STRUCTURAL_SEARCH.md`](STRUCTURAL_SEARCH.md).
- The vocabulary and TF-IDF machinery this page's tension turns on is in
  [`UNCOVER_KEY_CODE.md`](UNCOVER_KEY_CODE.md).

## Some limitations in quasi-source handling

- **Binary granularity is coarse.** One pseudo-function per binary file — enough to
  search and fingerprint at scale, but there is no call graph *inside* a binary's
  recovered content.
- **Extraction is format-limited.** JS-in-executable recovery is Bun-only today; the
  other packagers named above are tracked, not built.
