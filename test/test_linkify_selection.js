// Coverage for #275 Part 2: the source-viewer's link-selection decision —
// which identifier occurrences in a rendered line become clickable.
// findLinkableIdentifiers is pure (no DOM), so this pins both modes:
//   knowledge mode (known-name Set): link any known identifier, call or bare
//   shape mode (null set, legacy/fallback): link identifier( call sites only
import { test } from 'node:test';
import assert from 'node:assert';
import { findLinkableIdentifiers } from '../public/source-viewer.js';

// Whole line arrives as one text node in these tests: offset 0, text === line.
const pick = (line, known) =>
  findLinkableIdentifiers(line, line, 0, known).map(h => h.name);

test('#275 shape mode (no set): call sites link, bare references do not', () => {
  const line = 'const x = parseWorklistEntry(raw); register(parseWorklistEntry);';
  const names = pick(line, null);
  assert.deepEqual(names, ['parseWorklistEntry', 'register']); // bare 2nd ref not linked
});

test('#275 shape mode: generic method calls still link (legacy behavior)', () => {
  assert.deepEqual(pick('items.map(f).slice(0, 2);', null), ['map', 'slice']);
});

test('#275 knowledge mode: generic built-ins stop linking unless corpus-defined', () => {
  const known = new Set(['parseWorklistEntry', 'fetchData']);
  assert.deepEqual(pick('items.map(x => fetchData(x)).push(y);', known), ['fetchData']);
});

test('#275 knowledge mode: bare references link — the import-line case', () => {
  const known = new Set(['parseWorklistEntry']);
  const line = "import { parseWorklistEntry } from './impl.js';";
  assert.deepEqual(pick(line, known), ['parseWorklistEntry']);
});

test('#275 knowledge mode: callbacks-as-values and export lists link', () => {
  const known = new Set(['handleClick', 'renderRow']);
  assert.deepEqual(pick('addListener(handleClick);', known), ['handleClick']);
  assert.deepEqual(pick('export { renderRow };', known), ['renderRow']);
});

test('#275 both modes: strings and comments never link', () => {
  const known = new Set(['parseWorklistEntry']);
  assert.deepEqual(pick("log('parseWorklistEntry(x)');", known), []);
  assert.deepEqual(pick('// parseWorklistEntry(x) rewrites the entry', known), []);
  assert.deepEqual(pick("log('parseWorklistEntry(x)');", null), ['log']); // shape mode: log( links, string content does not
});

test('#275 both modes: keyword / 1-char / ALL_CAPS skips hold', () => {
  const known = new Set(['if', 'x', 'MAX_RETRIES', 'goodName']);
  assert.deepEqual(pick('if (x) MAX_RETRIES = goodName;', known), ['goodName']);
  assert.deepEqual(pick('if (run()) return;', null), ['run']);
});

test('#275: mid-word text-node boundary artifact is not linked', () => {
  // Text node starts mid-identifier ("Entry" split off "parseWorklistEntry"):
  // preceding char in the full line is a word char, so no link.
  const full = 'parseWorklistEntry(x)';
  const nodeText = 'Entry(x)';
  const known = new Set(['Entry']);
  assert.deepEqual(findLinkableIdentifiers(nodeText, full, full.indexOf('Entry'), known), []);
});

test('#275: very long minified lines require call shape even in knowledge mode', () => {
  const known = new Set(['fnA', 'fnB']);
  const longLine = 'fnA(1);' + 'x'.repeat(6000) + ';fnB;';
  const hits = findLinkableIdentifiers(longLine, longLine, 0, known).map(h => h.name);
  assert.deepEqual(hits, ['fnA']); // bare fnB reference suppressed on huge lines
});

test('#275: hit offsets index into the scanned text node', () => {
  const known = new Set(['fetchData']);
  const line = 'a = fetchData(b);';
  const [hit] = findLinkableIdentifiers(line, line, 0, known);
  assert.equal(line.slice(hit.start, hit.start + hit.name.length), 'fetchData');
});
