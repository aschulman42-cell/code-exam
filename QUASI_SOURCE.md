# Quasi-Source: Recovering Structure from Non-Source Artifacts

> **Placeholder — [#274](https://github.com/aschulman42-cell/code-exam/issues/274) Part I pending.** Content below was moved verbatim from the old `README.md` and awaits rewrite/expansion. File name and location (root vs `docs/`) may still change.

### Quasi-Source: recovering structure from non-source artifacts

The thesis tying several features together: a surprising amount of useful
structure can be recovered from things that weren't shipped as source, then
indexed, searched, and cross-referenced with the same machinery as real
source. The minified-JS deobfuscation and fingerprinting above are part of
this spirit; the two surfaces below extend it to compiled and packaged
artifacts. (Tracked as an umbrella in issue #76.)

**Binary-code analysis**

- Indexes binary files (executables, libraries) inside source trees by
  extracting strings AND demangled C++ function signatures (Itanium and MSVC
  name mangling).
- Granularity today: one pseudo-function per binary file, containing the
  file's extracted strings and demangled symbols. Search and the inverted
  index work on these uniformly with source content; per-function
  call/caller analysis does not apply to binary content.
- Most useful for *large* binary corpora — Windows 11 system DLLs, Microsoft
  Office plugin trees, vendor SDKs — where the per-file string-plus-symbol
  fingerprint is enough to navigate at scale.

**Binary-bundled JavaScript extraction**

- `--extract-js-from-binary <path>` recovers embedded JavaScript from native
  install binaries and writes it to a directory CodeExam can index normally.
  Format-aware dispatch: currently supports Bun standalone executables (used
  by Claude Code's `claude.exe`), including PE-signed Windows builds where the
  Bun trailer sits before the Authenticode certificate. Other formats (pkg,
  nexe, Node SEA, Tauri asset-table) are tracked as future work.
