# Imports and the Bill of Materials

The dependency layer (#312's "missing layer", #315 §A3): one resolver that
answers, for any import in any indexed language, *what does this file depend
on, and is that inside the corpus, in the standard library, third-party, or
vendored*. Import knowledge had been patched five times at the leaf (#122,
#151, #172, #174, #187) without a home; this is the home. `--census-imports`
(#156), the `--exports`/`--imports` catalog join (#162), and the AI/ML
detectors' framework matching are consumers or neighbors, not copies.

## Commands

| command | question it answers |
|---|---|
| `--bom` | what does this corpus depend on, four-way classified, each row saying why |
| `--census-imports` | which imported names dominate — the de facto API map (ranked) |
| `--imports <catalog.json>` | which catalogued library provides each import (#162 join) |
| `--imports-from <index>` | cross-index: resolve imports against one library's live index |

`--bom` honors `--filter`, `--max-results`, `-v` (example sites).

## Languages covered (tier 1)

Python (`import` / `from … import`), JS/TS (import declarations, re-exports,
`require()`, dynamic `import()`), C/C++ (`#include`, quoted vs angle),
Java/Kotlin (`import [static] a.b.C[.*]`), C# (`using`, `using static`,
alias). Go and Rust are not yet extracted; their manifests (`go.mod`,
`Cargo.toml`) are already read for the answer key.

## The four classes, and where each verdict comes from

Every classification names its source on the row — a fixed list, a manifest,
a declared package, a resolved path. The lists live in
`src/core/imports.js` and are the resolver's whole vocabulary: nothing
learned, nothing hidden.

| class | shown by |
|---|---|
| `internal` | the target resolves into this index: a declared Java/C# package prefix, a relative specifier or quoted `#include`, an indexed path or `.py` module basename |
| `stdlib` | a stated list: Python stdlib, node builtins, ISO C/C++ headers, POSIX headers, Windows platform headers, legacy pre-standard C++ headers, `java.*`/`javax.*`, `kotlin.*`, `android.*`/`androidx.*`, `System.*`/`Microsoft.*`. The source string names WHICH list (a platform SDK is not the ISO library, and the row says so) |
| `third-party` | declared by a package manifest indexed with the corpus: `package.json`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `*.gradle`, `*.csproj`, `packages.config` |
| `vendored` | the target resolves to a file under a carried-in-tree subtree (`vendor/`, `third_party/`, `contrib/`, `node_modules/`, `external/`, `deps/`) — someone else's code with its own provenance and licensing |

**The residue reports itself.** A target none of those confirm classifies as
`external` with a source saying exactly which confirmation was unavailable —
"not declared in any indexed manifest" when manifests exist, "no manifest
indexed to confirm" when none do. External is a statement about what the
index can show, never a finding of third-party.

Precedence: declared corpus packages are checked **before** the platform
lists, so a corpus that *is* the platform library (ExoPlayer's
`androidx.media3.*`) classifies its own packages internal while the rest of
`androidx.*` reads as the platform.

## Known bounds (tier 1, stated rather than papered over)

- **Manifests must be indexed to count.** Default indexing skips `.json` /
  `.txt` / `.toml` / `.xml`; re-index with `--add-extensions` to give the
  classifier its answer key. Without one, third-party is structurally
  unconfirmable and `--bom` says so in its Manifests section.
- **Java groupId ≠ package.** A manifest declaring `com.google.guava:guava`
  does not confirm `com.google.common.*` imports — coordinates and package
  roots differ, and the resolver does not guess the mapping. Real Guava on a
  Gradle corpus reads external-unconfirmed with the manifest present; the
  row's source says why.
- **License-notice harvest is not in tier 1.** Vendored subtrees are named
  with file counts; pairing each with its LICENSE text is the next
  increment.
- **Best-effort manifest parsing** (regex-level TOML/XML). A malformed
  manifest yields what it yields; nothing throws.

Measured first light (2026-09-04): `.zlib` — 323 sites, `contrib/`
correctly vendored (the ioapi/iowin32 struct-dupes pairs), DotZLib's
`NUnit.Framework` external-unconfirmed; `.AndroidX_Media_ExoPlayer3` —
44,271 sites, `androidx.media3` internal, guava/junit/mockito the external
surface; `.demo` — the external surface is exactly `openssl/*.h`.
