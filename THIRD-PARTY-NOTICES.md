# Third-party notices

CodeExam is licensed under the Apache License, Version 2.0 (see `LICENSE`
and `NOTICE`). The repository also **ships** the third-party files listed
below: byte copies redistributed with CodeExam, not only packages it depends
on. Each is under its own licence. Every file in this inventory is
MIT-licensed; the licence text is reproduced once at the end, and the
copyright holders are named per file. `test/test_third_party_notices.js`
fails when a shipped file has no row here, or when a row's version drifts
from what is installed.

## Tree-sitter grammars (`grammars/`)

The twelve `.wasm` files are unmodified copies of the prebuilt grammar each
npm package publishes (`test/test_function_bounds.js` asserts byte identity
against the installed package). They are loaded at run time by
`web-tree-sitter`, which npm installs as a dependency; it is not
redistributed in this repository.

| Shipped file | Upstream package | Copyright | Repository | Licence |
|---|---|---|---|---|
| `grammars/tree-sitter-c.wasm` | `tree-sitter-c` 0.24.1 | 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-c | MIT |
| `grammars/tree-sitter-c-sharp.wasm` | `tree-sitter-c-sharp` 0.23.1 | 2014-2023 Max Brunsfeld, Damien Guard, Amaan Qureshi, and contributors | https://github.com/tree-sitter/tree-sitter-c-sharp | MIT |
| `grammars/tree-sitter-cpp.wasm` | `tree-sitter-cpp` 0.23.4 | 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-cpp | MIT |
| `grammars/tree-sitter-go.wasm` | `tree-sitter-go` 0.25.0 | 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-go | MIT |
| `grammars/tree-sitter-java.wasm` | `tree-sitter-java` 0.23.5 | 2017 Ayman Nadeem | https://github.com/tree-sitter/tree-sitter-java | MIT |
| `grammars/tree-sitter-javascript.wasm` | `tree-sitter-javascript` 0.25.0 | 2014 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-javascript | MIT |
| `grammars/tree-sitter-php.wasm` | `tree-sitter-php` 0.24.2 | 2017 Josh Vera, GitHub | https://github.com/tree-sitter/tree-sitter-php | MIT |
| `grammars/tree-sitter-python.wasm` | `tree-sitter-python` 0.25.0 | 2016 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-python | MIT |
| `grammars/tree-sitter-ruby.wasm` | `tree-sitter-ruby` 0.23.1 | 2016 Rob Rix | https://github.com/tree-sitter/tree-sitter-ruby | MIT |
| `grammars/tree-sitter-rust.wasm` | `tree-sitter-rust` 0.24.0 | 2017 Maxim Sokolov | https://github.com/tree-sitter/tree-sitter-rust | MIT |
| `grammars/tree-sitter-typescript.wasm` | `tree-sitter-typescript` 0.23.2 | 2017 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-typescript | MIT |
| `grammars/tree-sitter-tsx.wasm` | `tree-sitter-typescript` 0.23.2 (its `tree-sitter-tsx.wasm` build) | 2017 Max Brunsfeld | https://github.com/tree-sitter/tree-sitter-typescript | MIT |

Runtime, installed by npm and not shipped here: `web-tree-sitter` 0.26.6,
copyright 2018 Max Brunsfeld, https://github.com/tree-sitter/tree-sitter, MIT.

## Browser vendor files (`public/vendor/`)

| Shipped file | Upstream package | Copyright | Repository | Licence |
|---|---|---|---|---|
| `public/vendor/mermaid.min.js` | `mermaid` 11.12.3 | Knut Sveidqvist and the Mermaid contributors | https://github.com/mermaid-js/mermaid | MIT |

`mermaid.min.js` is the bundle Mermaid publishes, unmodified. As upstream
builds it, the bundle embeds Mermaid's own dependencies (d3, dagre, lodash
and others); their copyright and licence notices travel inside the file
where upstream placed them. This inventory lists the bundle, not its
contents.

## Versions

A version is the one installed when the file was copied. The test compares
each grammar row with `node_modules/<package>/package.json`, the Mermaid row
with the version string inside the bundle, and the `web-tree-sitter` note
with the installed package. Bumping a package means re-copying the file and
updating its row in the same change.

## The MIT License

Each file above is distributed under the MIT License. The copyright notice
for each is the holder and year named in its row; the permission notice is
the same for all of them:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
