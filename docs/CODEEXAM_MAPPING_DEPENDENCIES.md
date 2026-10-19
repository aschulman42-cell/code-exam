# Mapping a codebase's dependencies

"What does this code depend on, and how do we know?" is one question with several partial
answers, and CodeExam has grown a family of features that each answer part of it. This page
says what the three words the features use mean — **imports**, **bill of materials**,
**dependencies** — puts every surface in one table, walks through CodeExam's own tree as the
example, and ends with what is not done and how a list that looks complete can still miss
something. The feature's history is issue #27
(https://github.com/aschulman42-cell/code-exam/issues/27); a code examiner's version of the
worked example is on [`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md).

## Three words

**Imports** are what the code *names*. An import is a site — a file and a line — where the
code reaches for something by name: an `import`, `#include`, `using` or `use` statement in
Python, JavaScript/TypeScript, C/C++ (including Objective-C `#import`), Java/Kotlin, C#, Go
and Rust; a `<script src>`, `<link rel="stylesheet">` or importmap entry in an indexed HTML
page or page template; or a run-time load whose target is written in the code
(`dlopen("libcrypto.so.1.1")`, `LoadLibrary(L"foo.dll")`, `Class.forName("...")`,
`importlib.import_module("os")`). `--census-imports` ranks them; the GUI's Imports accordion
groups them by library; every row of the bill of materials is made of them. Imports say what
the code asks for. They do not say what it gets back in return.

**The bill of materials** (BoM) is the categorized inventory of what the code depends on: one
row per dependency, each with its evidence. (A "row" throughout this page is a line of the
`--bom` report or of the GUI's Bill of Materials accordion: one name, its class, and the reason
it got that class.) Every import is resolved against what the index holds and placed in
one of four classes — *internal* (this corpus's own code), *stdlib* (a language standard
library or platform SDK), *third-party* (declared by an indexed package manifest or build
file) or *vendored* (resolves into a carried-in-tree subtree such as `vendor/`) — with the
residue reported as *external* and the reason spelled out on the line ("not declared in any
indexed manifest"; "angle include; no standard-list or index match"). Around the rows sit the
other evidence the index holds: the manifests and build files, the lockfiles with the
direct/transitive split and where each package comes from, the joins those make decidable
(declared but imported nowhere, imported but not declared, declared but not locked), the
run-time dynamic loads, and a capped copy of the copyright holders. `--bom` prints it, the
GUI's Bill of Materials accordion renders the same sections, and `--copyrights` (the
Copyrights accordion) carries the notices in full: whose names are on the files, with the
first-party/third-party presumption from counts.

**Dependencies** is the question, not a command. It is the umbrella word in #27, and the word
the industry uses for the formal answer: a **software bill of materials (SBOM)** in CycloneDX
or SPDX form, or GitHub's dependency graph, lists every component that ships or installs,
usually with versions, licenses and a vulnerability join. CodeExam's bill of materials is not
an SBOM. It is scoped to what the code itself imports or loads, with the line that does it,
plus what the lockfile pins; it does not export to either format, and it looks nothing up on
the network (the air-gapped mode forbids it). An SBOM answers "what is installed"; the bill of
materials answers "what does the code reach for, and which of that can we corroborate". The
two disagree in both directions, and the disagreement is information: an SBOM generated for
CodeExam's repository omitted the Mermaid library that CodeExam's GUI loads from a script tag
(#27 records it, and asks how that list was derived), and the lockfile lists 330 packages the
code never names.

One hazard in the flag names. `--imports <catalog.json>` and `--imports-from <index>` are
**not** the imports list: they are the cross-index *resolution* joins, which attribute this
index's imports to the library (indexed separately; currently Python only) that provides each name. The
census is `--census-imports`; the inventory is `--bom` (**not** Python-only). Renaming `--imports` is a separate
decision, not made on this page.

## Why dependencies matter to a code examination

**Absence is a claim about the whole tree.** An assertion that a codebase does or does not do
something — "we don't collect location", "X does not encrypt at rest", "X does not practice
element 3 of claim 1" — is a statement about X *and everything X pulls in*, whatever tool is
used to examine it. A library X imports can do the thing on X's behalf; a library that
library imports can do it one level further down; and so on to the bottom of the tree. The
point is sharpest in patent litigation, where direct infringement does not turn on knowledge
or intent: a claimed feature practiced inside a dependency that ships with the product is
practiced by the product, whether or not anyone who wrote X knew the feature was there. An
examiner who reads X's own source and finds nothing has established absence from X's source,
not from the product. And most of the product is code X's authors have never read or heard
of: the worked example below counts it for CodeExam itself (17 packages chosen, 347
installed).

**The recursion is the size of the problem.** A manifest names the direct dependencies, each
of those has a manifest of its own, and the lockfile is the fixed point of that walk: every
package reached, with the version actually resolved. On CodeExam's tree the two files are
these:

| file | names | size |
|---|---|---|
| `package.json` | 17 packages | 49 lines, 1.4 KB |
| `package-lock.json` | 347 packages (17 direct, 330 transitive) | 4,589 lines, 168 KB |

The difference between the two files is the recursion, written out. GitHub's dependency
graph reads the same manifests and lockfiles and, where a lockfile exists, takes the
transitive set from it; Dependabot's alerts are that graph joined to an advisory database.
Neither reads the code: they answer "what installs", which is the lockfile's question, not
"what the code reaches for", which is the bill of materials'. CodeExam's `--file-tree` does
the same walk *inside* a tree, one file's imports and their imports to a chosen depth (see
"Internal dependencies" below).

Three consequences for code examination:

- **Before asserting absence, know the dependency set, and whether it was produced.** A
  production usually holds the first party's source and none of the transitive packages. The
  bill of materials says what the code reaches for and the lockfile says what installs; the
  difference is what is not in the room. "Declared but not produced" is a finding to raise with
  the producing party, not a gap to fill from memory or from the public registry, which the
  order may forbid bringing in.
- **Before attributing a feature, know whose code it is.** A behavior found in a vendored
  subtree, a pasted file or a copied library is the library's; the *vendored* class and the
  copyright holders say which rows belong to someone else, and the first-party presumption
  says how sure the tool is (not very, and it says so).
- **Under a protective order, the same question runs the other way.** The tool the examiner
  brings into the review room has dependencies too, and the order's disclosure obligations
  cover them. That is the inventory of CodeExam's own 347 packages on
  [`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md), and its line that the
  network behavior of those packages at runtime was not audited.

CodeExam's reports take the examiner to the edge of what the produced files show and stop
there. What a dependency does once loaded is not in the production and not in the index; the
"Resolved by lockfiles" section of the `--bom` report says so on every run ("says nothing
about runtime reach").

## Every dependency-related feature, in one table

| Surface | Answers | Reads | Does not read | Where |
|---|---|---|---|---|
| `--census-imports` | What does the code reach for, ranked by sites? With `--multi-index`, what do all the indexes share? | Import, include and `use` statements in the seven language families; script, stylesheet and importmap tags of indexed HTML and page templates | Relative (in-tree) imports; dynamic loads and tags inside code strings (the footer counts both); manifests and lockfiles | CLI ([`cli.md`](cli.md)) |
| `--bom` | What does the code depend on, and how do we know? | Everything the census reads plus relative imports; run-time dynamic loads; manifests and build files; six lockfile kinds; copyright notices (capped) | `yarn.lock` and `pnpm-lock.yaml`; binary import tables; what a package does once loaded | CLI ([`cli.md`](cli.md)); GUI **Bill of Materials** accordion (`/api/bom`) |
| `--copyrights` | Whose (c)-identified code is in the tree? | The first 60 lines of every indexed file, `/*! */` banners anywhere in a file, license documents whole | Files with no notice (counted, not attributed); a notice past line 60 outside a banner; who the parties actually are | CLI ([`cli.md`](cli.md)); GUI **Copyrights** accordion (`/api/copyrights`) |
| GUI **Imports** accordion | Which libraries, grouped, with every site | The census's rows, every language, grouped by top-level library | Relative imports; dynamic loads | GUI (`/api/imports`) |
| `--exports [pkg]`, `--emit-catalog`, `--used-by` | What does a library say its public API is, and who imports it? | Python packages: `__all__`, export decorators, `__init__` re-exports, a heuristic floor | Every other language | CLI; GUI **Exports** accordion (Python only) |
| `--imports <catalog.json>`, `--imports-from <index>` | Which library provides each of this index's imports, and is the name public there? | This index's imports against an export catalog, or one library's index | Any library without a Python export catalog | CLI ([`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md), "Cross-index catalogs") |
| `--referenced-resources` | What does the code point to but not contain? | URLs and hosts, environment variables, file paths, embedded SQL, external commands, cloud config, model ids — including the URLs of script tags that code emits as strings | Imports as such | CLI; GUI **Referenced Resources** accordion; MCP `referenced_resources` |
| `--client-server` | Which HTTP routes does the code declare, which does it call, and which calls have no route in the production? | Route declarations (Express, Flask, FastAPI, Rails, Go) and client calls (`fetch`, `axios`, XHR, `requests`, URL literals), reconciled by path | Anything not HTTP; a route table built at run time | CLI; GUI **Client / Server** accordion; MCP `client_server` |
| `--file-map`, `--file-tree` | Which files import from which — the internal coupling; one file's imports, then those files' imports, and so on to `--depth` | In-tree import edges between files | Anything outside the index | CLI, with `--mermaid` and `--depth` |
| `--call-inventory` | Which calls go to in-index functions and which to something else | Call targets, partitioned in-index / external | Imports as such; it is a call-level view, not the bill of materials | CLI |
| MCP | — | `referenced_resources` and `client_server` are tools | There is currently no MCP tool for the census, the bill of materials or the holders: an LLM client, cloud or local, cannot ask for them yet | [`CODEEXAM_MCP.md`](CODEEXAM_MCP.md) |

The table is the state on 2026-10-18, checked against `src/argparse.js` and the GUI's
accordion list; the flag reference in [`cli.md`](cli.md) carries each entry's details and
couplings.

## Dependencies that are not packages: the services the code talks to

A package is one kind of thing the code cannot run without. Two others never appear in a
manifest and are inventoried by their own surfaces:

- **The server behind a client, and the client in front of a server.** `--client-server` maps
  the HTTP surface: the routes the code declares, the calls it makes, and the reconciliation
  of the two by path. A client call with **no matching server route** is the "missing server
  code" signal — the produced code depends on code that was not produced (a production that
  ships the app and withholds the service), which is a dependency across a network boundary
  rather than an import. The reverse set, routes nothing calls, is the surface a client not in
  the production depends on. It is a heuristic pass, strongest on common JavaScript shapes
  (the README says so), not a routing-graph analysis.
- **Services, hosts and configuration.** `--referenced-resources` catalogues what the code
  points to but does not contain: the hosts and URLs it calls (a hosted API is a dependency
  with no package), the model ids it names (a hosted model likewise), the environment
  variables it reads (configuration the code cannot run without, and often the place a host
  name or key arrives from), the external commands it spawns, the files it opens. None of
  those rows has a version or a lockfile; the examiner gets the name, the count and the
  sites.

Neither of these is in the bill of materials, by design: the bill of materials is what the
code *loads*, these are what it *talks to*. An examination that stops at packages has not
finished the dependency question.

## Internal dependencies: what the code depends upon inside itself

The same question applies within a tree, and #27 asked whether "Components" should cover it.
What exists:

- `--file-map` draws which file imports from which, the module-level coupling of the whole
  tree (`--mermaid` for a diagram, `--filter` to narrow). `--file-tree <file>` walks one file's
  imports and their imports to `--depth`: the lockfile's recursion, inside the tree.
- `--callers`, `--callees` and `--call-tree` do the same at function level; `--call-inventory`
  partitions every call target into in-index and external, the call-level counterpart of the
  bill of materials' *internal* class.
- `--digest` of a file carries its dependency edges both ways (imported-by, imports-from).
- In `--bom` itself, the *internal* class is the largest: 1,865 of CodeExam's 2,668 import
  sites resolve into its own tree. Those rows are listed, not ranked, because the external
  surface is the question the report exists for.

What does not exist is the clustering #27 and #28 describe: named internal components,
groups of files more tightly coupled to each other than to the rest. The file map is the raw
input for that; on a large tree the diagram is too dense to read and the textual view is not
built.

## How a dependency is classified

Classification is by evidence the index holds, never by recognizing a name. In order:

- **internal** — the target resolves to a file in the index: a relative path, a module the
  tree defines, a path alias the manifest declares, or a library the tree's own build file
  builds (CMake `add_library`, an `Android.mk` `LOCAL_MODULE`), so a
  `System.loadLibrary("media_jni")` whose `.so` the tree builds is internal, not foreign.
- **stdlib** — the name is on a platform list: the Python standard library, Node's builtins,
  the ISO C and C++ headers, POSIX, Windows, WinRT and Apple framework headers, the Windows
  system libraries (`kernel32`, `user32`, ...), the JVM and .NET base classes. (The class is named for the idea of a standard library, not
  for C's `stdlib.h` header: every platform's standard library counts.)
- **third-party** — an indexed manifest or build file declares it: `package.json`,
  `requirements*.txt`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, Gradle, `.csproj`
  and `packages.config`; a `.vcxproj`'s linker inputs, CMake's `target_link_libraries` and
  `find_package`, a Makefile's `-l` flags. When a lockfile is indexed too, the row carries the
  pinned version.
- **vendored** — the target resolves into a carried-in-tree subtree (`vendor/`,
  `third_party/`, `node_modules/`, `external/`, `deps/`, `contrib/`). Those subtrees are
  skipped at build, so the import or tag is the evidence and the version comes from a
  filename or URL when it has one.
- **external** — none of the above. The line says what was looked for and not found ("not
  declared in any indexed manifest"; "angle include; no standard-list or index match"), so the
  reader can tell a missing manifest from a genuinely foreign name. One external reason is
  also a finding in its own right: "present in `package-lock.json` as a transitive
  dependency". The code imports a package that none of its own manifests declares; the
  package is on disk only because one of the declared packages happens to depend on it.
  Upgrade that declared package (a "dependency bump": the routine version increase a
  maintainer makes or Dependabot proposes) and its new version may no longer pull the
  transitive package in, so the package vanishes from the install and the undeclared import
  fails at run time. The row's class does not change; the package does.

What each evidence source adds:

- **Manifests and build files** make *third-party* decidable and give the declared set for
  the joins.
- **Lockfiles** (`package-lock.json` v1–v3 and `npm-shrinkwrap.json`, `Pipfile.lock`,
  `composer.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`) give the resolved tree: how many
  packages install, which are direct and which transitive, from which registries or git
  sources, and the pinned version per row. `yarn.lock` and `pnpm-lock.yaml` are recognized and
  listed but not read yet.
- **Copyright notices** catch what no package manager installed and no import names: a
  library copied into `lib/`, a renamed file or a pasted function has no import that points
  at it and sits under no vendored directory, and its header is the only trace. (Manifests
  and lockfiles cover what was installed; notices cover what was copied in.) The first party
  is a presumption CodeExam makes from file counts and is marked so on every row.

All of those files are indexed **by name** in every default build, whatever their extension
(`Makefile` and `LICENSE` have none), so they are there without any flag. HTML and most
template types are not indexed by default and need `--add-extensions .html,.htm` plus the
template type at build; both reports say so when an index holds JavaScript but no HTML. An
index built before the by-name rule landed (`53e12ae`, 2026-10-18) has to be rebuilt before
`--bom` can see its manifests. See [`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md). There is no
separate "add files" flag, but `--build-index` into an existing `--index-path` extends the
index rather than replacing it, so a second build from a list that names only the new files
adds them (the worked example's command block shows it).

## A worked example: CodeExam's own tree

The numbers below are what one run produced on one day, not a description of the current
tree: a run on 2026-10-18 at `30f4f4f`, on an index of the tracked tree (350 files), built and
read with

```
# the tracked files (git ls-files omits untracked files; the index holds only what the list names):
git ls-files > ce-files.lst

ce --build-index @ce-files.lst --index-path .ce_ndx

ce --index-path .ce_ndx --bom
ce --index-path .ce_ndx --census-imports
ce --index-path .ce_ndx --copyrights

# several reports in one run, printed in sequence:
ce --index-path .ce_ndx --bom --census-imports --copyrights

# --all-results lifts the caps and -v adds example sites; save the full text and search it:
ce --index-path .ce_ndx --bom --census-imports --copyrights --all-results -v > ce_ndx_deps.txt
grep -i chalk ce_ndx_deps.txt

# a directory build leaves HTML out unless told otherwise; --add-extensions admits it at build:
ce --build-index . --index-path .ce_dir_ndx --add-extensions .html,.htm

# or add files to an existing index afterwards: a second build into the same path extends it
printf 'public/index.html\n' > more.lst
ce --build-index @more.lst --index-path .ce_dir_ndx
ce --index-path .ce_dir_ndx --bom | grep -i mermaid
```

The counts drift with every commit, which is why they are dated; the protective-orders page
quotes an earlier run of the same tree.

**Caps and verbosity.** All three reports cap their ranked lists and say so on the last line
of the list ("... +81 more targets (use --max-results <N> or --all-results to see all)" on
this run's census). `--all-results` lifts the cap; `--max-results N` sets it; `--filter`
narrows to one library, holder or path; `-v` adds example sites to every row. Two caps no
flag lifts: `--bom`'s dynamic-loading section prints the first 20 literal targets and says
how many more, and its copyright table is the top eight holders — `--copyrights` has them
all. In the GUI the accordions fetch up to 500 rows and write "N of M shown" under the list
(#137 tracks the accordions that still don't). A capped list read as complete is the most
ordinary way to get "X does not depend on Y" wrong; the lines that say how much was cut are
part of the report.

**The index is not the codebase.** Every report reads the index, and the index holds what
the build admitted. `--build-index` prints what it left out: directories it skips by name
(`node_modules`, `__pycache__`, the vendored directories), media and binary files, archives
it expanded, and, for text extensions it found but does not index by default, a tip naming
the `--add-extensions` list to rebuild with (#191; HTML is the usual case). This run's index
was built from a file list, which admits whatever the list names, so its one HTML file is in;
a directory build of the same tree would have left it out, and the reports' Coverage lines
would have said so. `--files` lists what the index holds. Absence from a report is absence
from the index, and the Coverage line is where the two diverge. See
[`CODEEXAM_INDEXES.md`](CODEEXAM_INDEXES.md). `--scan-extensions <path>` counts the file
extensions in a directory before any build, and `--index-extensions` counts those in the
index; the two together show what a build left out.

**What `--bom` reports for CodeExam.**

- 2,668 import sites across 229 JavaScript, 11 Python, 8 C, 6 Java and 1 HTML file: 1,865
  internal, 760 stdlib, 19 third-party, 1 vendored, 23 external. (`--census-imports` reports
  815 sites and 131 distinct targets on the same index because it skips relative imports; the
  two numbers measure different things and are both right.)
- The third-party rows are the six packages CodeExam's code imports, each with the version
  the lockfile pins: `node-llama-cpp` 3.22.1, `@modelcontextprotocol/sdk` 1.32.1,
  `@anthropic-ai/sdk` 0.78.0, `js-beautify` 1.15.4, `web-tree-sitter` 0.26.6, `webcrack`
  2.15.1. No OpenAI package appears because the ChatGPT and Gemini providers call the
  OpenAI-compatible HTTP API directly (`src/core/providers.js` names the hosts,
  `src/core/chat-runner.js` makes the request): those are hosts the code talks to, which is
  a `--referenced-resources` row, not a package it loads.
- The one vendored row is Mermaid (the GUI's renderer for the file dependency map and the
  pipeline diagrams): `public/index.html:697` loads `/vendor/mermaid.min.js`, a
  directory the build skips. No manifest names it. This is the library the SBOM in #27
  omitted, and the tag is the only way to see it.
- The 23 external sites are what CodeExam's tree contains besides CodeExam: `torch`,
  `sentence_transformers`, the OpenSSL headers and `models` come from the sample harnesses
  and the TLS demo under `samples/`, which are example material; `chalk`, `better-sqlite3`,
  `pkg-d`, `pkg-e` and `real` are import strings inside test fixtures. The row for `chalk`
  says it is "present in `package-lock.json` as a transitive dependency (5.6.2); a dependency
  bump can drop it", which is true of the fixture line at `test/test_imports.js:25` and would
  be a finding on a real tree (the *external* class above says what the phrase means).
- One manifest, `package.json`, with 17 declared dependencies; one lockfile,
  `package-lock.json`, resolving 347 packages (17 direct, 330 transitive), all from
  `registry.npmjs.org`.
- The joins: eleven `tree-sitter-*` grammar packages are declared as dev dependencies and
  imported nowhere (expected; they regenerate the vendored grammars); `chalk` is imported but
  not declared (the fixture); `pkg-d`, `pkg-e`, `real` and `better-sqlite3` are imported but
  neither declared nor locked (fixtures). On 2026-10-17 the same join found `express` and
  `zod` declared and imported nowhere — CodeExam's real declarations, removed in `4c1ed10`;
  `test/test_declared_dependencies.js` now fails the suite if a declared dependency goes
  unimported again.
- Dynamic loading: 34 sites, 16 with a literal target and 18 computed. The sixteen literal
  targets (`foo.dll`, `SomeVendorSdk.dll`, `libcrypto.so.1.1`, `com.corp.app.Plug`, ...) are
  fixture strings in CodeExam's own tests. Of the computed ones, the seven `import()` sites
  include a script that loads modules by a computed path, and the six `require(expr)` sites
  include `src/argparse.js:1338`, which is the `--bom` help text naming the pattern
  `require(expr)`. The fixtures and the help text are the same artifact: CodeExam's tree
  contains the strings its detectors look for, so on its own tree the detectors find
  themselves (the lesson below).

**What `--copyrights` reports.** 347 files scanned, 246 with a notice, 101 without. One holder
on 231 files, presumptively first-party; `SecureNet Systems, Inc` on 15, the fictional
company in the TLS demo sample, presumptively third-party by count and correctly so.
Apache-2.0 on 232 headers, MIT on one. The license documents listed apart: `LICENSE`
(Apache-2.0), `NOTICE`, `THIRD-PARTY-NOTICES.md` (naming tree-sitter and MIT). Then nineteen
more "holders" with one file each, most of them lines such as `['lib/lodash.min.js', ['/*!
lodash v4.17.2` or `assert.equal(holderFromLine('// Acme Corp'`: copyright-shaped strings
inside the harvester's own tests and source, reported as written because a notice inside a
string literal has the shape of a notice inside a comment. The three "bundle" files with
several holders' banners are the same test files. Read the holder column as *text found*,
not as a party; the presumption line says as much. Tightening the harvester against
notice-shaped strings in code is a known follow-up, listed below.

Two lessons from the example, one narrow and one general. The narrow one is specific to
indexing a scanner's own source: CodeExam's tree holds the strings its detectors look for
(test fixtures, help text, the harvester's own test notices), so on this tree the
dynamic-loading targets and most of the one-file copyright "holders" are the tool finding
itself. An ordinary target does not contain its examiner's patterns, and on it the same rows
are findings; the artifact recurs only on a tree that itself contains a scanner (a security
product's source, an AI/ML framework's own test suite), and CodeExam's AI/ML detectors meet it
there the same way. [`CODEEXAM_KNOWN_LIMITATIONS.md`](CODEEXAM_KNOWN_LIMITATIONS.md) carries
it as a standing entry ("A detector recognizes its own vocabulary"). The general lesson is the
protective-orders page's: read the "why" column and the `e.g.` sites, not the counts. A count
is a claim about the tree; a site is a line the examiner can open.

**Why the install is a gigabyte.** The tracked tree is a few megabytes; after `npm install`
the directory is about 1 GB (1,073 MB on the machine that produced this page, 1,020 MB on
another install of the same lockfile). The bill of materials explains the shape:

| what | size | why it is there |
|---|---|---|
| `@node-llama-cpp/*` | ~690 MB | prebuilt llama.cpp binaries; npm installs every optional variant whose platform fields match the host, five on Windows x64 (CUDA with extensions 351 MB, CUDA 169 MB, Vulkan 71 MB, plain 30 MB, arm64 11 MB); CodeExam loads one |
| `tree-sitter-*` | ~270 MB | the eleven grammar packages `--bom` lists as dev dependencies imported nowhere; `npm install --omit=dev` skips them; the grammars CodeExam runs are the vendored `.wasm` files in `grammars/` |
| `node-llama-cpp` | 40 MB | the one runtime package of the three above that the code imports |
| everything else | ~70 MB | the other 330 transitive packages the lockfile resolves (Babel for webcrack, the MCP SDK's own tree, ...) |

So the answer to "does CodeExam need all this" is: at run time, one binary variant, the
vendored grammars and six imported packages; the rest is what npm installs for every matching
platform variant and for development. The install's size is the lockfile's shape, not the
code's, which is what the "Resolved by lockfiles" section of the `--bom` report exists to
show.

**The install and the review room.** The same inventory matters on the other side of a
protective order, where [`SOURCE_CODE_PROTECTIVE_ORDERS.md`](SOURCE_CODE_PROTECTIVE_ORDERS.md)
begins: an examination under a typical order runs on a computer with no network and usually
no USB port in use, so everything the examiner's tool could need during the examination has
to be on the machine before it is sealed. A tool that fetches a component the first time a
feature is used fails in the room, at the moment the feature is needed. For CodeExam the
lockfile's 347 packages are the first part of that list, and `npm install` on a connected
machine brings them in. The second part is what the install resolves lazily. `node-llama-cpp`
chooses its prebuilt binary at install time and again at first use, and when no prebuilt
variant matches the machine it falls back to downloading the llama.cpp source and compiling
it; that is why `cmake-js`, and `y18n` under it, are in the tree at all. The GGUF model files
are downloaded separately and pointed at with `--model`
([`LOCAL_LLM.md`](LOCAL_LLM.md)). So the setup rule is: install, then run every feature the
examination will use once on the connected machine, before the network is cut, and keep the
record of what was run. The protective-orders page says plainly that a tested offline install
of CodeExam does not exist yet; this section is the dependency map such a test would have to
cover.

**The implication.** A directory listing of that install shows a couple of hundred top-level
names (218 on one install, 257 on another; scoped names such as `@babel` hold several
packages each, and the lockfile's count is 347), and CodeExam's author has never heard of
most of them. That is not a defect of this project; it
is the condition of every codebase built on a package registry. **The authors chose 17 names.
The other 330 were chosen by the authors of those 17, and by *their* dependencies' authors**,
none of whom the product's authors have met, and the lockfile is the only complete record of
the choice. Four things follow:

- The people who wrote a product cannot testify from memory to what it contains. "We don't
  do A" from the engineers who wrote X is a statement about the 17 packages they chose, not
  the 347 that ship; the lockfile, not the engineer, is the witness to the rest.
- For direct infringement, which does not turn on knowledge, the 330 nobody chose count
  exactly as the 17 do. The feature an examiner is asked about may sit three manifests down
  from anything the defendant's engineers ever read.
- The dependencies a party must disclose under a protective order, for the tool it brings
  into the review room, are mostly packages the tool's author never selected. That is why
  the protective-orders page lists CodeExam's by count and source, with what was and was not
  audited, rather than vouching for each by name.
- The names the authors have never heard of are where a supply-chain compromise lives: a
  package nobody chose is a package nobody is watching. CodeExam does not look for that (see
  "no vulnerability data" below); the list of what to watch is the `--bom` report's
  "Resolved by lockfiles" section.

The same holds for the target of any examination. The producing party's tree, if it has a
lockfile, has a few dozen chosen names and a few hundred inherited ones, and the examiner who
has read the chosen ones has read a fraction of what runs.

**From a package nobody chose back to the operation that needs it.** The natural next
question about any name on that list — `zod`, `y18n`, `wrappy`, `universalify` — is how it
reaches the code: through which chosen package, and for which user operation. The chain has
two halves, and today they come from two tools:

- **Package to package** is in the lockfile, and `npm explain <package>` (alias `npm why`)
  prints it from the installed tree. On CodeExam, 2026-10-18: `zod` is required by
  `@modelcontextprotocol/sdk` (and is an optional peer of `@anthropic-ai/sdk`); `y18n` comes
  by `yargs` from `node-llama-cpp`, directly and through `cmake-js`; `universalify` comes by
  `fs-extra` from `node-llama-cpp`, through `cmake-js` and through `ipull`; `wrappy` has two
  routes, `once` under `express` under the MCP SDK, and `once` under `pump` under
  `prebuild-install` under `isolated-vm` under `webcrack`. A version-3 `package-lock.json`
  carries these edges itself (149 of CodeExam's 347 packages have dependency maps; the rest
  are leaves), so the walk needs no `node_modules`; CodeExam's lockfile reader parses the
  file but does not keep the edges yet.
- **Package to code** is the direct dependency's import sites, which `--bom -v --filter
  <direct dependency>` lists, and the file names the operation. `@modelcontextprotocol/sdk`
  is imported at `src/mcp-server.js:23` (the MCP server a client talks to) and
  `src/core/ai-overview.js:28` (Overview by AI on a cloud engine runs that server as a
  subprocess), so `zod` is reached by those two operations and no other. `node-llama-cpp` is
  imported in `src/commands/ask.js`, `src/core/ai-overview-local.js` and
  `src/core/llm-runner.js`: every local-model operation, so `y18n` and `universalify` arrive
  with all of them. `webcrack` is imported once, in `src/core/CSI-helpers.js`, the bundled
  JavaScript unpacking during a build; `express` is never imported by CodeExam, so `wrappy`'s
  run-time route is inside the MCP SDK's own HTTP transport.

Then the limit, which the example makes concrete. The chain proves that a package is
*installed and importable* on the way to an operation; it does not prove it executes.
`cmake-js` is the tool `node-llama-cpp` uses to compile llama.cpp when no prebuilt binary
matches the machine, so on a machine with a prebuilt binary `y18n` installs for every user and
plausibly runs for none; `prebuild-install` runs at install time to fetch `isolated-vm`'s
binary and never again. Static reading cannot tell those cases from the live ones, which is
why the "Resolved by lockfiles" section says "says nothing about runtime reach" and the bill
of materials stops at the import site. CodeExam has no single command for this chain today;
`npm explain` plus `--bom -v --filter` plus `--callers` on the function at the site is the
manual version, and a built-in `--why <package>` that joins the lockfile's edges to the import
sites and the call graph is proposed as a follow-up. The same chain, read from the operation
end, answers the review-room question above: the operations an examination will use name the
packages that must be present and exercised before the machine is sealed, and `y18n`'s route
through `cmake-js` is the warning that the install contains a build step that can run on
first use.

## Issue #27, then and now

Issue #27 (May 2026) scoped the feature in three phases. Against what has landed by 2026-10-18:

1. **Source-level declarations** — done for C/C++, Java/Kotlin, C#, Python,
   JavaScript/TypeScript, Go and Rust, plus HTML and page templates, which #27 did not list.
   Not done: Ruby, PHP as code (a `.php` file is read as a template, for its tags), Swift,
   Perl, Lua.
2. **Binary-level dependencies** — the import tables of `.dll`, `.so`, `.dylib` and `.lib`
   files shipped alongside source. Not started; CodeExam indexes a binary's strings and
   demangled signatures, not its imports. A third-party tool that lists them for Windows
   executables is [Clive Turvey's DumpPE](https://www.softwarelitigationconsulting.com/2017/05/clive-turveys-dumppe-and-dumppdb-utilities-for-windows-pe-and-debug-symbol-files/).
3. **Static calls to run-time dynamic linking** — done as a static scan of the patterns #27
   listed (`LoadLibrary`/`GetProcAddress`, `dlopen`/`dlsym`,
   `CFBundleGetFunctionPointerForName`, `NSLookupSymbolInModule`, `Class.forName`,
   `ClassLoader.loadClass`, `System.loadLibrary`, `Assembly.Load`,
   `importlib.import_module`, `__import__`, computed `require` and `import()`). A literal
   target is classified like an import; a computed target is counted with an example site; a
   symbol lookup is counted against its load call.

Of #27's open design questions, the naming one ("Dependencies vs SBOM vs Components vs
Teardown") is answered by this page's three words: the command is `--bom`, the question it
answers is "what are the dependencies", and it is not an SBOM (no CycloneDX or SPDX output, no
license or vulnerability join). "Should Components include internal components"
stays open: `--file-map` draws the internal coupling, and #28 tracks the non-graphical
clustering view. The related-work note that an SBOM omitted Mermaid is now the vendored row
above.

**Teardown**, the fourth word, comes from
hardware. A hardware teardown takes a device apart and identifies every component — part
number, supplier, function on the board, and often cost — until the device is accounted for
as a list of parts and what each one does. The software analog is the same list for a
program: every library, framework, service and toolchain element, with version, license,
provenance, and *what the program uses it for*. "Software supply chain" is the security
field's word for the same territory seen from the other direction: not the parts in the
finished product but the route each part travelled to get there, through registries,
maintainers and build tools that could have altered it on the way; an SBOM is that field's
inventory, a teardown is the product's. Measured against that, CodeExam has the parts
list for a source tree — name, provenance class, the version where a lockfile or a filename
gives it, the license where a notice or a document gives it — and the sites where each part
is used, which is the raw material for the "what it is for" column but not the column itself
(`--imports <catalog>` fills it for Python libraries with an export catalog: which of the
library's public names the program actually uses). It does not yet identify components in
compiled artifacts (a library's identity from a binary's strings and signatures, which the
quasi-source work gets partway to; #27's phase 2), and it has no cost column, which a software
teardown rarely needs. A bill of materials is the parts list; a teardown is the parts list
with the function column and the binary side filled in. The mobile-app teardown that
motivated #27 — an APK or IPA that ships binaries alongside or instead of source — is the far
end of that distance.

Three later issues bear on the subject without replacing #27 as its home. #312 (closed
2026-09-06) stated the hole from the consumer side: CodeExam had no notion of what in a
codebase came from outside it, discarded "Copyright" as a stopword, and had patched the gap
five times at the leaf (vendored code inflating the AI/ML detectors and burying the
vocabulary) and never at the root; the vendored class and `--copyrights` are the root fix it
asked for. #230 records that CodeExam's own dependencies come in two tiers, the npm packages
and what npm never installs (the vendored Mermaid, the grammars), which is why the worked
example has a vendored row no manifest explains. #76, the quasi-source umbrella, holds the
binary-side leads, among them a Rust binary that leaks its Cargo dependency tree by file
path, which is where phase 2 would start.

## What a Gemini Notebook review got right, and what moved

A Gemini Notebook review of CodeExam's dependency mapping (2026-10-18, on the tree at
`4c1ed10`) is accurate about the mechanism: the per-language extractors, the manifest
parsing, the four classes plus residue, the Python export tiers and the cross-index joins,
and `--referenced-resources` as the external surface. Four gaps it identified, against the tree now:

- "No transitive lockfile resolution" — closed the same day (`53e12ae`): six lockfile kinds
  read, with the direct/transitive split and sources.
- "Export catalogs are Python-only" — still true.
- "Static versus dynamic gaps" — half moved: run-time loads are now the dynamic-loading
  section (`e156023`); star-exports and lazy registries on the export side are still missed by
  the static catalog, tracked as #165.
- "No SBOM export or vulnerability tracking" — still true, by design: no CycloneDX or SPDX
  writer, and no CVE lookup, which needs the network the air-gapped mode forbids. GitHub's
  dependency graph and [Dependabot](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/dependabot-quickstart) are the answer there.

Two numbers moved too: five language families became seven plus HTML, and "19
declared dependencies" became 17 when `express` and `zod` came out.

## What is not done, and how a complete-looking list can miss something

Not done, in rough order of how often it will matter:

- `yarn.lock` and `pnpm-lock.yaml` are listed but not read, so a Yarn or pnpm project gets
  the manifest's declared set and no resolved tree.
- Binary import tables (#27 phase 2): a `.dll` or `.so` shipped with the source is in the
  index as strings (with e.g. C++ function signature de-mangling), not as a dependency.
- Libraries injected from code — `document.createElement('script')`, loader calls, CSS
  `@import` — are not `--bom` rows; script tags inside code strings are counted in the footer and
  their URLs land in `--referenced-resources`.
- Export catalogs beyond Python, so cross-index resolution (`--imports`, `--imports-from`) is
  Python-only. The asymmetry with imports is real: imports are counted in seven language
  families, exports are declared in one, because an export catalog needs a language's
  convention for "public API" written down — Python's `__all__`, `__init__` re-exports and
  export decorators are done; JavaScript's `export` and `module.exports`, Java's `public` in
  a package, C's headers are not. Until they are, the join is one-sided: any language's
  imports can be listed, only Python's can be resolved to a providing library's declared
  surface, and the GUI's Exports accordion says "Python only for now" for that reason.
- Ruby, PHP code, Swift, Perl and Lua imports; template types outside the list the HTML
  extractor knows.
- Vendored code is recognized by directory name, by a manifest, or by a copyright notice, and
  by nothing else: a library pasted into `lib/` under the first party's header is invisible
  to all three.
- The copyright harvester reports notice-shaped strings inside code as holders (see the worked
  example above).
- No MCP tool for the census, the bill of materials or the holders.
- No `--why <package>`: the chain from an installed package back through the lockfile's
  edges to a direct dependency, its import sites and the operations above them (the worked
  example does it by hand with `npm explain` and `--bom -v --filter`).
- No CycloneDX or SPDX export; no vulnerability data.

"No vulnerability data" refers to a database — the GitHub Advisory Database, OSV, the NVD's CVE records — of entries keyed by
package name and affected version range, each with an identifier, a severity and the version
that fixes it. A tool "with vulnerability data" joins a resolved tree (every `name@version`
the lockfile pins) to that database and reports the matches; Dependabot alerts are exactly
that join on GitHub's dependency graph. CodeExam has the left side of the join, the
`name@version` pairs in its "Resolved by lockfiles" section, and nothing to join them to: the database changes daily and
lives on the network, which the air-gapped mode forbids, and a review room could do the join
only with a dated snapshot brought in (OSV publishes one). Whether vulnerability is the
question in a source-code examination at all is a separate matter; usually it is not, and
when it is, the dated snapshot is the honest form.

And the structural caveat, which none of the above closes. Every report here is a static
reading of the files the index holds. A target reaches code the index cannot see through
computed names (the `(computed)` rows are the visible edge of that), generated code,
obfuscated or bundled artifacts where the import statements were already resolved away (see
[`QUASI_SOURCE.md`](QUASI_SOURCE.md)), assets fetched by URLs assembled at run time,
reflection, and dependency injection (a gap recorded on #27). An inventory that looks
complete is an inventory of what static reading can show. The reports say where their edge
is — the **Coverage** lines at the end of `--bom`, `--census-imports` and `--copyrights`, the
"of which" and "not counted above" lines, the "why" column on every external row, the
`(computed)` rows — and those lines, not the counts, are what to quote.
