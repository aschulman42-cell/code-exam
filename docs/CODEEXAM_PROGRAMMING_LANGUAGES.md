# Programming languages: what CodeExam reads in each

"Do you support Swift?" has no one-word answer, because CodeExam is not one parser. A language
gets a tree-sitter grammar or a set of line patterns for its definitions; the import extractor,
the data-structure detector, the call graph and the AI/ML detectors each have their own list of
languages; and most of what CodeExam does (search, strings, vocabulary, hotspots, Overview, the
claim path) reads text and never asks what language it is. This page puts all of that in one
place: the tiers in a few sentences, one table of language by feature, then a section for each
language where there is something to say, with the corpora it was measured on. Every cell was
read off the code or an index on 2026-11-13; the files and lines are in the Sources footer. The
mechanics of building an index are on [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md); the
dependency features' own page is [`CODEEXAM_MAPPING_DEPENDENCIES.md`](CODEEXAM_MAPPING_DEPENDENCIES.md).

## The short version

- **The grammar tier (12 grammars, 11 languages, 2026-11-13).** C, C++, Java, JavaScript,
  TypeScript (with TSX as a second grammar), Python, C#, Go, Rust, PHP and Ruby are parsed with a
  tree-sitter WASM grammar in the default build, which then merges in whatever the regex parser
  finds that the grammar did not. Definitions, their kinds and their exact line spans come from
  the syntax tree.
- **The regex tier (2026-11-13).** Swift, Kotlin, Scala, Objective-C, Lean, Lua, Perl, AWK,
  VBScript and CoffeeScript have a table of line patterns each: a definition is a line that looks
  like one, and its end is found by counting braces on lines with strings and comments masked out
  (Swift, Kotlin, Scala, Objective-C, Perl, AWK), by indentation under the keyword line (Lean), or,
  where the language has neither (Lua, VBScript, CoffeeScript), at the next definition. The tier
  misses whatever a single line does not
  announce: Swift computed properties and `extension` blocks, Kotlin extension functions (filed
  under the receiver type instead of the function name), closures, operators, anything whose name
  is not on the definition line.
- **The generic fallback.** A file whose extension is indexed but has no pattern table of its own
  (R, Groovy, shell, Cython, resource and config files) is scanned with the C and Python patterns
  together. They find little in those files and occasionally invent a definition.
- **Text.** Markdown, plain text, reStructuredText and YAML are indexed for search and never
  parsed; YAML, JSON, Terraform and Bicep are what the infrastructure detectors read.
- **Quasi-source.** Minified bundles, native binaries (PE, ELF, Mach-O, Java `.class`, WASM,
  Android DEX) and `.har` browser captures are the subject of
  [`QUASI_SOURCE.md`](QUASI_SOURCE.md) and the first section of
  [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md).
- **Not indexed by default.** An extension outside the default set is left out of a directory
  build: BrightScript (`.brs`), CUDA (`.cu`, `.cuh`), OpenCL, shaders, Svelte, XMLUI.
  `--add-extensions .brs,.cu` admits them; dependency and build files (`package.json`,
  `Cargo.lock`, `Podfile`, `build.sbt`, …) are admitted by name whatever their extension.
- **Language-blind features.** Literal, fast and regex search and multisect; `--strings`,
  `--vocabulary`, `--hotspots`, `--overview`, `--toc`, the file digests, mechanisms and
  pseudo-claims, claim search and claim charts, fingerprints and structural dupes, `--copyrights`,
  the endpoint tier of the AI/ML detectors, the GUI and the MCP tools. They work over the lines
  and the function index, whatever produced it, so a regex-tier language gets all of them, with
  the function index's gaps.

## One table, language by feature

"Default" in the extensions column means a directory build indexes the file without being told
to. "Grammar" is the tree-sitter tier; "regex" the pattern tier; "generic" the fallback. The
corpora are indexes on the project's own machine, built from public sources, counted on
2026-11-13 (files holding at least one definition, then functions and methods, then types: the
classes, structs, enums, traits, interfaces, protocols, objects and modules the parser records
as `class` entries). Issue numbers are the open issues that name the language.

| Language | Extensions indexed by default | Parse tier | Definitions and ends | Imports, manifests, lockfiles | Data structures · calls · exports | AI/ML detectors | Examined on | Issues |
|---|---|---|---|---|---|---|---|---|
| C | `.c`, `.h` (`.h` goes to the C++ grammar) | grammar | functions, structs, macro-defined and attribute-prefixed names; exact spans | `#include`; `CMakeLists.txt`, `*.cmake`, `Makefile`, `*.mk`, `*.vcxproj` | struct/enum/union/typedef · C family (with `.m`, `.mm`, `.cu`) · no | kernels (CUDA, Triton); endpoint URLs | x264 (85 `.c` + 43 `.h`: 1,813 fn); zlib (43 + 22: 753 fn); llama.cpp | #287, #65, #68, #88 |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hxx`, `.c++`, `.h++`, `.h` | grammar | classes, methods, constructors, templates, Google Test macros | as C | as C · C family · no | as C | llama.cpp (566 `.cpp`, 233 `.h`, 32 `.hpp`: 21,000 fn); Notepad++ (415 `.cxx`, 182 `.hpp`, 127 `.cpp`, 315 `.h`: 23,100 fn); Chromium (195K files) | #287, #65, #60 |
| Objective-C / C++ | `.m`, `.mm` | regex | `- (T)name:` and `+ (T)name:` methods, C functions, `@interface`, `@implementation`, `@protocol`; brace ends | **not read**: the census skips `.m` and `.mm`; headers' `#import` and `@import` are read as C | C family (struct/enum) · C family · no | endpoint URLs (the kernel detector gates on C and C++ extensions, not `.m`) | llama.cpp (2 `.m`: 76 fn); Notepad++ Scintilla Cocoa layer (5 `.mm`: 222 fn) | — |
| Java | `.java` | grammar | classes, interfaces, enums, methods, constructors | `import`; `pom.xml`, `*.gradle`, `*.gradle.kts` | enum/interface/record · JVM family · no | endpoint URLs | Media3/ExoPlayer (2,433 files: 57,995 fn, 5,852 types); Android 1.5 platform (10,101 files: 150,976 fn); Spark (1,360 files) | #60, #287 |
| Kotlin | `.kt`, `.kts` | regex | `fun`, `class` (data, sealed, enum), `object`, `companion object`, `interface`; brace ends with triple-quoted strings masked | `import` (via the Java extractor); `*.gradle.kts` | enum/interface/record · JVM family · no | endpoint URLs | Architecture Components samples (263 `.kt`: 942 fn, 294 types); Media3 (161 `.kt`: 1,044 fn); OpenAI Java SDK, Kotlin source (2,741 `.kt`: 100,335 fn, 9,547 types) | — (extension functions, below) |
| Scala | `.scala` (`.sc` has patterns but is not default) | regex | `def`, `class`, `case class`, `object`, `case object`, `trait`; brace ends | **not read**; `build.sbt` admitted by name but not parsed | none · JVM family · no | endpoint URLs | Apache Spark (6,374 `.scala`: 67,859 fn, 14,885 types) | — |
| Groovy | `.groovy` | generic | the C and Python patterns; little found | not read; `build.gradle` is read as a manifest | none · JVM family · no | endpoint URLs | — | — |
| Swift | `.swift` | regex | `func`, `init`, `class`, `struct`, `enum`, `protocol`; brace ends | **not read**; `Package.swift` and `Podfile` admitted by name but not parsed; run-time loads read | enum/struct/protocol · own family · no | endpoint URLs | SwiftUI Tutorials (86 files: 99 fn, 169 types); OpenClaw's macOS app (462 files: 2,989 fn, 1,210 types) | — (computed properties, extensions, below) |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.jsx` (`.coffee`, `.hbs` go to the regex tier) | grammar | functions, arrows, generators, methods, class fields, classes; member-assignment definitions (#283) from the regex side, merged in | `import`, `require`, dynamic `import()`; `package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`; `<script>` tags in HTML | none · JS family · no | idiom tier (SDK clients, LangChain, endpoints) | CodeExam itself (215 `.js` + 24 `.mjs`: 3,314 fn); DevOps samples (1,625 `.js`: 13,448 fn); minified bundles, see [`QUASI_SOURCE.md`](QUASI_SOURCE.md) | #283, #352 |
| TypeScript | `.ts`, `.tsx` (own grammar) | grammar | as JavaScript, plus interfaces and type aliases as types | as JavaScript | interface/enum/type · JS family · no | idiom tier | OpenClaw (3,442 `.ts`: 12,005 fn); llama.cpp's web UI (283 `.ts`) | #352 |
| Python | `.py`, `.pyw` (`.pyx` generic) | grammar | `def`, `async def`, `class`, decorated definitions; indentation ends in the regex tier | `import`, `from … import`; `requirements*.txt`, `constraints.txt`, `pyproject.toml`; `poetry.lock`, `Pipfile.lock`; cross-index resolution (`--imports-from`) | none · Python family · **yes**: `__all__`, `@keras_export`, `__init__` re-exports (#153) | idiom tier: models, layers, training, inference, pipelines, LLM calls, agents | Spark (1,453 `.py`: 23,277 fn); the AI/ML framework trees on [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md) (PyTorch, Transformers, Keras, scikit-learn, LangChain, …) | #234 |
| C# | `.cs` | grammar | namespaces, classes, structs, records, interfaces, enums, methods, constructors, properties | `using`; `*.csproj`, `packages.config`, WinRT projections | enum/interface/record/struct · own family · no | endpoint URLs | ASP.NET samples in the DevOps index (192 `.cs`: 945 fn, 421 types); zlib's `contrib` (8 `.cs`: 162 fn) | — |
| Go | `.go` | grammar | functions, methods, `type … struct` | `import`; `go.mod`, `go.sum`, module-path classification | struct/interface · own family · no | endpoint URLs (grounded markers: #108) | Go for DevOps book code (164 `.go`: 2,838 fn, 347 types); OpenAI Go SDK (256 `.go`: 14,379 fn); Anthropic Go SDK (87 `.go`: 725 fn) | #108 |
| Rust | `.rs` | grammar | `fn`, `impl`, `struct`, `trait`, `enum`, `mod` | `use`, `extern crate`, `mod`; `Cargo.toml`, `Cargo.lock`, std/crate classification | struct/enum/union/trait · own family · no | endpoint URLs (grounded markers: #108) | Codex (2,013 `.rs`: 35,311 fn, 7,049 types); Bram's core (3 `.rs`: 437 fn) | #270, #108 |
| PHP | `.php` | grammar | functions, classes, interfaces, traits | **not read as code**: a `.php` file is scanned as a page template for its tags; `composer.lock` is read as a lockfile, `composer.json` is not parsed | none · own family · no | endpoint URLs | no corpus of note (12 files in the Notepad++ tree) | — |
| Ruby | `.rb` | grammar | `def`, `class`, `module` | **not read**; `Gemfile`, `Gemfile.lock`, `*.gemspec` admitted by name but not parsed | none · own family · no | endpoint URLs | OpenAI Ruby SDK (1,170 `.rb`: 2,311 fn, 11,674 module and class entries); Notepad++ (26 `.rb`) | — |
| Perl | `.pl`, `.pm` | regex | `sub`, `package`; brace ends | not read | none · own family · no | endpoint URLs | Notepad++ (4 `.pl`: 164 fn); x264 (2 `.pl`) | — |
| Lua | `.lua` | regex | `function name`, `local function`, `name = function`; ends at the next definition (`end`-delimited) | not read | none · own family · no | endpoint URLs | Notepad++ (5 `.lua`: 9 fn) | #343 |
| AWK | `.awk` | regex | `function`; brace ends | not read | none · no family (resolves to any language) · no | endpoint URLs | the AWK corpus (833 files: 2,788 fn) | — |
| VBScript / VBA | `.vbs`, `.bas` | regex | `Sub`, `Function`, `Class` (case-insensitive); lines unmasked (comments start with a quote), ends at the next definition | not read | none · no family (resolves to any language) · no | endpoint URLs | — | #343 |
| CoffeeScript | `.coffee` | regex | `name = (args) ->`, `name = ->`, `class`, plus the JavaScript patterns; ends at the next definition | not read | none · JS family · no | endpoint URLs | — | #343 |
| R | `.r`, `.R` | generic | **unparsed**: the generic patterns find nothing R-shaped and invent a few entries (Spark's R package: 21 phantom entries in 9 files, one 700 lines long) | not read | none · no family (resolves to any language) · no | endpoint URLs | Spark's `R/` (9 files) | #178 |
| Shell | `.sh`, `.bash`, `.zsh` | generic | functions not reliably found | not read | none | endpoint URLs | — | — |
| CUDA | `.cu`, `.cuh` (**not default**) | generic | the C patterns do find kernels and host functions; ends at the next definition (no masking family) | not read (`.cu` is outside the C-file test) | struct/enum/union · C family · no | **kernels**: `__global__`, `<<<…>>>`, `cudaLaunchKernel` | llama.cpp (185 `.cu`, 66 with definitions: 680 fn; 27 `.cuh`: 517 fn) | — |
| BrightScript (Roku) | `.brs` (**not default**, no patterns) | — | nothing: the file is left out of a directory build, and admitted it would get the generic patterns | not read | none | — | — | — |
| Lean 4 | `.lean` | regex | `theorem`, `lemma`, `def`, `abbrev`, `instance` (an anonymous one is named `instance`), `axiom`, `opaque`; `structure`, `inductive`, `class` as types; modifiers and a same-line attribute allowed; names keep dots, primes and Unicode; ends by indentation under the keyword line | not read (`lakefile.lean`, `lake-manifest.json` not parsed) | structure/inductive/class · own family · no | endpoint URLs | a Lean 4 number-theory corpus (23,402 files: 153,218 declarations, 100% of those in the source, no tactic lines; 96% of ends exact) | — |
| Resource, config, IaC | `.xml`, `.json`, `.plist`, `.rc`, `.resx`, `.tf`, `.tfvars`, `.bicep` | generic | searchable; the generic patterns occasionally invent a definition (Spark: 6 in 5 `.xml` files) | `package.json`, `*.csproj`, `pom.xml`, `plist` are read as manifests where named above | — | infrastructure detectors (#168) | — | — |
| Text | `.md`, `.txt`, `.rst`, `.yaml`, `.yml` | text | never parsed | — | — | YAML content-sniffed by the infrastructure detectors | — | — |

Two cells need a word more than the table gives them. "JVM family", "C family" and the rest in
the calls column are the groups the call graph resolves across: a call in a Kotlin file can
resolve to a Java or Scala definition and not to a Python one; Swift is a family of its own, so
a Swift call never resolves to an Objective-C definition; a language with no family at all (AWK,
VBScript, R, shell) is treated as compatible with every definition. "Idiom tier" in the AI/ML column means the detectors know that language's
import and call shapes (`import torch`, `require('openai')`); every other language gets only the
endpoint tier, a string match on `api.anthropic.com`, `/v1/chat/completions` and the like, which
is language-blind.

## Per language, where there is something to say

Each section: the tier, what is and is not recognized, the corpora and their numbers, the open
issues.

### Rust

Grammar tier. `fn`, `impl` blocks, `struct`, `enum`, `trait` and `mod` are extracted with exact
spans; `impl` and `trait` items are recorded as types, which is why Codex's 2,013 `.rs` files
yield 35,311 functions beside 7,049 types. Imports read `use` (nested braces, aliases, `self`,
`*`, multi-line), `extern crate` and `mod`; `Cargo.toml` is a manifest and `Cargo.lock` a
lockfile, so the bill of materials classifies a path as std, crate-internal or declared. The
data-structure detector covers `struct`, `enum`, `union` and `trait`. Examined on Codex (OpenAI's
agent, 2,013 `.rs` files) and on Bram's core (3 `.rs` files, 437 functions), and a Rust binary
appears on [`QUASI_SOURCE.md`](QUASI_SOURCE.md) leaking its Cargo dependency tree. Open: #270
(a trait's scope leaking into the next definition, phantom functions), #108 (AI/ML markers:
the detectors' idiom tier does not know Rust, so a Rust LLM client is found only by its endpoint
URLs).

### Kotlin

Regex tier. The patterns take `fun`, `class` with its `data`, `sealed`, `inner` and `value`
modifiers, `object` and `companion object`, `interface` and `enum class`; function ends are found
by brace counting with Kotlin's triple-quoted strings masked. Imports are read by the Java
extractor, which accepts Kotlin's semicolon-less form; `*.gradle.kts` is read as a manifest, so
a Gradle project's declared dependencies reach the bill of materials. The data-structure
detector takes Kotlin's `enum`, `interface` and `record`-like forms on the Java patterns. Measured
on the Architecture Components samples (263 `.kt`: 942 functions, 294 types), Media3 (161 `.kt`:
1,044 functions, 189 types) and the OpenAI Java SDK, whose source is Kotlin (2,741 `.kt`:
100,335 functions, 9,547 types).

The one verified defect: an **extension function is filed under its receiver type**. The pattern
captures the first word after `fun`, so `fun Fragment.waitForIdle()` is a function named
`Fragment`. The Architecture Components samples declare 23 extension functions, and their
function list carries `Fragment` (twice), `LiveData` (three times), `View` (twice) and `Flow` as
function names for that reason; the OpenAI SDK has 28 more. Nothing else distinguishes them from
functions that happen to be named after a type. A grammar retires this; it is the first item on
the tree-sitter grammar work (`tree-sitter-kotlin-swift-grammars` on the worklist).

### Swift

Regex tier. The patterns take `func` with its modifiers, `init`, and `class`, `struct`, `enum`
and `protocol` as types; brace counting ends them. Methods inside a type are attributed to it
(`AppDelegate::application`). What the tier does not see, measured on 2026-11-13:

- **Computed properties.** `var body: some View { … }` is where a SwiftUI view's content lives.
  The SwiftUI Tutorials hold 59 such lines and OpenClaw's macOS app 101; the function index has
  none of them. The two `body` entries OpenClaw does have are `func body(content:)` methods on
  view modifiers.
- **`extension` blocks.** 9 in the tutorials, 121 in OpenClaw; none is recorded as a type, and the
  methods inside one are listed as free functions, not as the extended type's.
- **Closures, subscripts, operators, `deinit`, `actor`**: no pattern.

Imports are not extracted (`import SwiftUI` is not read; `Package.swift` and `Podfile` are
admitted into the index by name but no manifest reader parses them), though run-time loads
such as `dlopen` are. The data-structure detector takes `enum`, `struct` and `protocol` on
the Java patterns. Examined on Apple's SwiftUI Tutorials (86 `.swift` files: 99 functions and
169 types) and on OpenClaw's macOS app (462 `.swift` files: 2,989 functions and 1,210 types).
The grammar item above adds Swift's grammar and indexes computed properties as functions.

### Objective-C

Regex tier. The patterns take `- (T)name:` and `+ (T)name:` methods, plain C functions,
`@interface`, `@implementation` and `@protocol`; the C masking family ends them. Headers (`.h`)
go to the C++ grammar, as in any C project, and a header's `#import` and `@import Module;` lines
are read as includes, with Apple's framework names classified as platform SDK. The gap is the
implementation files: **the import census does not read `.m` or `.mm`**, because the C-file test
that routes a file to the C extractor lists `.c`, `.h`, `.cc`, `.hh`, `.cpp`, `.hpp`, `.cxx`,
`.hxx` and `.inl` and not the Objective-C extensions. llama.cpp's `ggml-metal.m` imports
`<Metal/Metal.h>`, the line is in the index, and the census has no Metal row. Run-time loads are
read from `.m` and `.mm`. One collision: `.m` is also MATLAB, and the Objective-C patterns are
applied to every `.m` file. Examined on llama.cpp (2 `.m` files: 76 functions) and the Notepad++
tree's Scintilla Cocoa layer (5 `.mm` files: 222 functions). No corpus and no issue are
specific to the language; the grammar item adds its grammar with a sniff for the MATLAB case.

### Scala

Regex tier, sharing Kotlin's masking family. The patterns take `def`, `class` and `case class`,
`object` and `case object`, `trait`. Calls resolve within the JVM family (Java, Kotlin, Scala,
Groovy). Nothing reads Scala imports, and `build.sbt` is admitted by name but not parsed. The
corpus is Apache Spark, the largest regex-tier measurement on the machine: 6,374 `.scala` files,
67,859 functions and 14,885 types. No issue names Scala; the grammar item includes it.

### Java

Grammar tier, and the language with the most charting work behind it: the ExoPlayer and Media3
claim charts on [`CODEEXAM_CLAIM_CHARTS_TESTS.md`](CODEEXAM_CLAIM_CHARTS_TESTS.md) run over
Media3 (2,433 `.java` files: 57,995 methods, 5,852 types). Imports, `pom.xml` and Gradle
manifests are read; `enum`, `interface` and `record` reach the data-structure detector. The
Android 1.5 platform tree (10,101 `.java` files: 150,976 methods) is the largest Java index
measured. Open: #60 (the digest's handling of split files, multiple inheritance and overloads).

### C and C++

Grammar tier, with the regex parser's extra entries merged in; the regex side was measured
against the grammar on 2026-10-13 (zlib 97%, libpng 99.5%, Chromium `cc/` 90% of definitions,
on [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md)). Names behind macros
(`CALLBACK`, `WINAPI`, Google Test `TEST_F(Suite, Name)`) are recovered; a macro that opens a
whole function is not. `.h` is always parsed as C++. Includes, CMake, Make, `*.vcxproj` and
`*.cmake` reach the bill of materials; `struct`, `enum`, `union` and `typedef` reach the
data-structure detector; the kernel detector reads CUDA and Triton launches in C and C++ files
only. Examined on x264, zlib, x265, ffmpeg, llama.cpp (566 `.cpp` files), Notepad++ (415
`.cxx`) and Chromium (195K files, the scale test). Open: #287 (tracking), #65 (class
declarations inferred from `::`), #60, #68 (the digest's `#include` and linkage view), #88 (the
per-file size cap and parse timeout, which send a file to the regex tier).

### Python

Grammar tier, and the deepest feature coverage of any language: the exports catalog
(`__all__`, `@keras_export`, `__init__` re-exports; #153) exists for Python only; the AI/ML
detectors' idiom tier was written on Python first (models, layers, training loops, inference,
pipelines, LLM calls, agents); imports, `requirements*.txt`, `pyproject.toml`, `poetry.lock` and
`Pipfile.lock` are read, and the cross-index resolution (`--imports-from`) that attributes an
import to the library that provides it is Python-only. The data-structure detector has no Python
patterns. Examined on Spark's Python half (1,453 `.py` files: 23,277 functions) and on the
framework and model trees listed on [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md). Open: #234 (the
digest shows no Python imports).

### JavaScript and TypeScript

Grammar tier, three grammars (JavaScript, TypeScript, TSX). Member-assignment definitions
(`window.X = function`) were added to the regex side under #283; `import`, `require` and dynamic
`import()` are read, with `package.json` and four lockfile formats, and HTML pages' `<script>`
tags count as imports of what they load. TypeScript's `interface`, `enum` and `type` reach the
data-structure detector; JavaScript has none. The idiom tier of the AI/ML detectors knows the
JavaScript SDK clients and LangChain. This is also the quasi-source language: minified bundles
and bundles recovered from binaries are split at their seams and indexed as JavaScript
([`QUASI_SOURCE.md`](QUASI_SOURCE.md)). XMLUI projects need `--add-extensions .xmlui,.xs`; `.xs`
files' imports are then read as JavaScript. Examined on CodeExam's own tree (215 `.js` and 24
`.mjs`: 3,314 functions), OpenClaw (3,442 `.ts`: 12,005 functions), the DevOps samples (1,625
`.js`), React's bundles, and Claude Code's `cli.js`. Open: #283, #352 (calls made through an
import alias are dropped from the call graph).

### Go, C#, PHP and Ruby

Grammar tier, a sentence each. **Go**: imports and `go.mod`/`go.sum` give a module-path
classification; `type … struct` and `interface` reach the data-structure detector; examined on
the Go for DevOps book code (164 files), the OpenAI Go SDK (256 files: 14,379 functions) and the
Anthropic Go SDK (87 files); #108 asks for AI/ML markers. **C#**: `using`, `*.csproj` and
`packages.config` are read, with WinRT projections recognized; examined on the ASP.NET samples
in the DevOps index (192 files) and zlib's `contrib` (8 files). **PHP**: definitions come from
the grammar, but a `.php` file is read as a page template for the imports census, not as code,
and `composer.json` is not parsed (`composer.lock` is); no corpus of note. **Ruby**: definitions
come from the grammar (the OpenAI Ruby SDK's 1,170 files give 2,311 methods and 11,674 module
and class entries); nothing reads `require` or a `Gemfile`. None of the four has a test of its
grammar extractor beyond the shared build tests named below.

### R

Indexed by default and **unparsed** (#178): there is no R pattern table, so an `.R` file gets
the generic C and Python patterns, which find nothing R-shaped (`name <- function(x)`) and
occasionally invent an entry from a qualified call: Spark's R package yields 21 such entries in
9 files, among them `base::drop` as a 700-line method. Searching R works; listing its functions
does not.

### BrightScript (Roku)

Not indexed: `.brs` is not in the default extension set and no pattern table exists.
`--add-extensions .brs` admits the files for search, and they would then receive the generic
patterns. The language's shape (`function name(args) as Type … end function`, `sub name() …
end sub`) is the one the VBScript patterns already match, so a regex tier for it is a small
follow-up, not grammar work.

### Lean 4

Regex tier since 2026-11-13, indexed by default. The table takes `theorem`, `lemma`, `def`,
`abbrev`, `instance`, `axiom` and `opaque` as functions and `structure`, `inductive` and `class`
as types, after the modifiers (`private`, `protected`, `noncomputable`, `partial`, `unsafe`,
`nonrec`, `scoped`, `local`) and a same-line `@[…]` attribute; an attribute on its own line above
is not part of the entry, as a Java annotation is not. An anonymous instance (`instance : Foo`,
`instance {K : Type*} [Field K] : Foo K`) is named `instance`, the next one in the file
`instance@line`. Names run to the first space, binder bracket or colon, so `Nat.foo_bar'`, `hζ`
and `riemannZeta₁_ne_zero_of_one_le_re` are listed as written. Ends follow the indentation rule
Python uses: the last line indented under the keyword line, which covers `:= by` blocks, `calc`
steps, `where` clauses, `structure` fields and `inductive` constructors, and ends a one-line
`theorem t : True := trivial` on its own line. Declarations are not nested in a type by
indentation, since a Lean declaration's namespace is already in its name. `example`, `macro`,
`syntax`, `notation`, `namespace` and `section` are not definitions; `--` and `/- -/` comments
and `"strings"` are masked, and a prime is an identifier character, not a string delimiter.
`structure`, `inductive` and `class` reach the Data Structures view, which reads raw lines and
so requires a binder, a colon, `where`, `extends` or `:=` after the name (a docstring line that
begins "class of actual discrete windows" is prose).

Before the table, `.lean` was unknown to CodeExam: not indexed by default, and when admitted,
scanned with the generic C and Python patterns, which made `--functions riemann` list theorems
by name and looked like support until it was counted. Measured both ways on 2026-11-13 on a Lean
4 number-theory corpus (23,530 files, 3,015,961 lines; 153,236 declarations in the source, every
entry's first line read from the source files):

| Measure | Generic patterns (before) | Lean table (after) |
|---|---|---|
| Entries in the function index | 73,417 | 153,218 |
| Entries whose first line is a declaration | 45,077 (61%) | 153,218 (100%) |
| Entries whose first line is a tactic or other line (`exact`, `apply`, `have`, `let`, an applied lemma's name) | 28,340 (39%) | 0 |
| Declarations found | 29%: `def` 59%, `theorem` 21%, `lemma` 22%, `instance` 9%, `abbrev` 10%, `structure` 12% | 100%: every `theorem` (83,045), `def` (34,913), `abbrev`, `structure` and `inductive`; 31,089 of 31,090 `lemma`s; 2,475 of 2,476 `instance`s |
| Entry end exactly at the last body line | 1.9% | 96.0% |
| Entry end running into the next declaration | 26.5% | 0.1% |
| `--functions riemann` | 6 hits, 2 of them applied lemmas | 24 theorems |
| Build time | — | 91 seconds |

The 18 declarations not found are the 11 `example`s, left out by design, five docstring lines
that begin with the word "class", one with "lemma", and one instance. Of the ends, 3.9% stop
before a docstring, `variable`, `end` or `section` line that the measure could not attribute, a
few of them genuine column-0 continuation lines, and the 0.1% that run on are declarations
followed by one indented deeper than itself inside a `section`. The mechanism behind the before
column: the Python pattern took `def name (` when the binders were parenthesized; a `theorem` was
found only when its binder list happened to close the line, which the C function pattern then
read as a definition; the same pattern read `exact mul_le_mul_of_nonneg_left (…)` as a function
named after the lemma, and because an end fell to the next entry, each such phantom truncated
the theorem above it. Imports (`import Mathlib.…`) and the Lake manifests are still not read.

### Perl, Lua, AWK, VBScript, CoffeeScript

Regex tier, one pattern table each (see the row). Perl and AWK get brace ends; Lua, VBScript and
CoffeeScript have no brace strategy, so a definition runs to the next one (#343 records this).
The AWK corpus (833 files, 2,788 functions) is the only sizable one; Perl and Lua appear in the
Notepad++ tree in small numbers.

## Testing actually done

What stands behind the table, in two kinds.

- **The test suite.** `test/test_parser_default.js` asserts that a bare `--build-index` is the
  hybrid grammar-plus-regex build and that a `--regex-parser` build marks every entry
  `parser: 'regex'`; its regex-only example is a `.swift` file, which is what the grammar item
  changes. `test/test_function_bounds.js` covers the regex tier's masking and ends for the
  JavaScript, C and Python families, the TSX grammar, macro-defined C and C++ names, the merge
  of grammar and regex entries, and that every vendored grammar in `grammars/` is byte-identical
  to its npm package. `test/test_treesitter_c_names.js` covers C and C++ naming.
  `test/test_imports.js` covers Java and Kotlin imports, C#, Go and Rust with their manifests
  and lockfiles, Objective-C `#import` and `@import` as lines (not the `.m` routing), HTML, and
  the lockfile readers. `test/test_data_structs.js` covers the data-structure patterns.
  `test/test_lean_patterns.js` covers the Lean table: every declaration kind by keyword, names
  with dots, primes and Unicode, ends by indentation, an attribute on its own line, an indented
  declaration not nested under the type above it, anonymous instances with bracketed binders,
  tactic lines and comments never definitions, and structures and inductives in the Data
  Structures view with a docstring line that begins "class of" left out.
  `test/test_third_party_notices.js` requires a notices row for every grammar. No test exercises the Go, C#, PHP or Ruby grammar extractor by language.
- **The corpora.** The counts in the table and the sections were read on 2026-11-13 from the
  `function_index.json` of the named indexes (files with at least one definition; `class`
  entries counted as types) and from `--regex` searches over the same indexes (the computed
  properties, the `extension` blocks, the extension functions). They are measurements of what
  the parser produced, not of what it should have: a recall figure exists only where a grammar
  parse of the same files is available to compare against, which is the C and C++ figure above
  and what the grammar item will produce for Kotlin, Swift, Scala and Objective-C.

## What is not done

- A Swift import extractor (`import Foundation`, `Package.swift`, `Podfile`), and Scala's
  (`build.sbt`), and Ruby's (`require`, `Gemfile`).
- Routing `.m` and `.mm` files to the C import extractor, so Objective-C implementation files'
  `#import` lines reach the census and the bill of materials.
- Pattern tables for R and BrightScript; `.brs` in the default extension set.
- A pattern-less fallback: a file with no table of its own should get no definitions rather than
  the generic C and Python patterns (Spark's `.out` SQL test outputs carry 19,625 invented
  functions, its R and XML files a few dozen).
- Data structures for Python, JavaScript, Scala, PHP and Ruby; exports for anything but Python;
  the AI/ML idiom tier for Rust and Go (#108).
- Grammars for Kotlin, Swift, Scala and Objective-C: `tree-sitter-kotlin-swift-grammars` on the
  worklist, which rewrites the four rows above when it lands.

## Sources

The cells were read from: `src/utils.js` (`EXT_TO_LANG` 120–137, `DEFAULT_EXTENSIONS`
286–315, `TEXT_EXTENSIONS` 316, `DEPENDENCY_FILE_RE` 328–347);
`src/core/TreeSitterParser.js` (`GRAMMAR_FILES` 67–84, `EXT_TO_TS_LANG` 87–101);
`src/core/CodeSearchIndex.js` (`_getPatternsForExt` 2723–2975, the pattern tables and the
extension switch with its generic default); `src/core/function-bounds.js` (`FAMILIES` 34–45,
`EXT_FAMILY` 47–58); `src/core/imports.js` (the `is*File` tests 36 and 160–166,
`extractFileImports` 462–471, `MANIFEST_BASENAME_RE` 946, `lockfileDeps` 1012);
`src/core/data-structs.js` (`_LANG_BY_EXT` 27–34, `_PATTERNS` 37–51); `src/core/calls.js`
(`_LANG_FAMILY` 217–224); `src/core/exports.js` (header); `src/core/ai-ml-detectors.js`
(`reCppExt` 498, the endpoint regex 1434); `src/commands/inspect_binary.js` (`_detectFormat`
370–399, the framework priority 573). Indexes: `.SwiftUI_Tutorials`, `.openclaw_src_NEW`,
`.Android_Arch`, `.AndroidX_Media_ExoPlayer3`, `.openai_from_gh`, `.anthropic_from_gh`,
`.codex_from_gh_zip_2`, `.bram-src-ndx`, `.spark`, `.llama_cpp`, `.notepadpp_win`, `.x264`,
`.zlib`, `.awk`, `.Infra_Devops`, `.android-1.5-java`, `.CE`, and a Lean 4 number-theory index,
measured once as built before the Lean table and once rebuilt with it on 2026-11-13, all on the
project's machine.

## Related

- [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md) — building an index, `--regex-parser`,
  `--add-extensions`, the `.har` and archive inputs.
- [`CODEEXAM_MAPPING_DEPENDENCIES.md`](CODEEXAM_MAPPING_DEPENDENCIES.md) — the import census and
  the bill of materials in full, including their own "not done" list.
- [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md) — the regex parser's
  definition and end detection (#343), macro-defined functions, C++ class tracking.
- [`QUASI_SOURCE.md`](QUASI_SOURCE.md) — binaries, bundles and what can be recovered from them.
- [`DETECTING_AI_ML.md`](DETECTING_AI_ML.md) — the detectors and the corpora they were built on.
- [`CODEEXAM_AND_UNDERSTAND.md`](CODEEXAM_AND_UNDERSTAND.md) — CodeExam beside SciTools
  Understand, where language coverage is one of the comparisons.
