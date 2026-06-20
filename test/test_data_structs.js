// Coverage for #194 extractDataStructures: language-aware detection of
// struct/enum/union/typedef/trait/interface across Rust/C/Go/TS, plus
// reference-count ranking. Uses a mock index (fileLines Map) — no on-disk index.
import { test } from 'node:test';
import assert from 'node:assert';
import { extractDataStructures } from '../src/core/data-structs.js';

function mockIndex(files) {
  return { fileLines: new Map(Object.entries(files).map(([k, v]) => [k, v.split('\n')])) };
}

test('#194 Rust: struct/enum/union/trait detected with kind + line', () => {
  const idx = mockIndex({
    'src/lib.rs': [
      'pub struct TurnState {',     // line 1
      '    id: u32,',
      '}',
      'enum Mode { A, B }',         // line 4
      'pub(crate) union Raw { x: u8 }', // line 5
      'trait Render { fn draw(&self); }', // line 6
      'fn use_turn(t: TurnState) -> Mode { Mode::A }', // refs TurnState + Mode
    ].join('\n'),
  });
  const got = extractDataStructures(idx);
  const byName = Object.fromEntries(got.map(s => [s.name, s]));
  assert.equal(byName.TurnState.kind, 'struct');
  assert.equal(byName.TurnState.line, 1);
  assert.equal(byName.Mode.kind, 'enum');
  assert.equal(byName.Raw.kind, 'union');
  assert.equal(byName.Render.kind, 'trait');
  // TurnState referenced twice (def + use), Mode three times (def + 2 uses).
  assert.ok(byName.Mode.refs >= byName.TurnState.refs);
});

test('#194 C: tagged struct/enum/union + one-line and aggregate typedef', () => {
  const idx = mockIndex({
    'a.h': [
      'struct Point { int x; int y; };',        // line 1 → struct Point
      'enum Color { RED, GREEN };',             // line 2 → enum Color
      'typedef struct {',                       // line 3 → aggregate typedef …
      '  int n;',
      '} Node;',                                // line 5 → typedef Node
      'typedef unsigned long my_size_t;',       // line 6 → typedef my_size_t
    ].join('\n'),
  });
  const got = extractDataStructures(idx);
  const kinds = Object.fromEntries(got.map(s => [s.name, s.kind]));
  assert.equal(kinds.Point, 'struct');
  assert.equal(kinds.Color, 'enum');
  assert.equal(kinds.Node, 'typedef');
  assert.equal(kinds.my_size_t, 'typedef');
});

test('#194 Go: type X struct / interface', () => {
  const idx = mockIndex({
    'm.go': 'type Server struct {\n  addr string\n}\ntype Handler interface { Serve() }\n',
  });
  const got = extractDataStructures(idx);
  const kinds = Object.fromEntries(got.map(s => [s.name, s.kind]));
  assert.equal(kinds.Server, 'struct');
  assert.equal(kinds.Handler, 'interface');
});

test('#194 ranking: more-referenced types sort first; noise files excluded', () => {
  const idx = mockIndex({
    'src/core.rs': [
      'struct Hot {}',
      'struct Cold {}',
      'fn a(x: Hot) {}', 'fn b(y: Hot) {}', 'fn c(z: Hot) {}', // Hot referenced a lot
    ].join('\n'),
    'node_modules/dep/lib.rs': 'struct Vendored {}\n', // noise — excluded
  });
  const got = extractDataStructures(idx);
  const names = got.map(s => s.name);
  assert.equal(names[0], 'Hot');                 // most referenced first
  assert.ok(names.includes('Cold'));
  assert.ok(!names.includes('Vendored'), 'vendored/noise file should be excluded');
});
