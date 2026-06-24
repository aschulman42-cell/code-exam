import { test } from 'node:test';
import assert from 'node:assert';
import { filterHelp } from '../src/argparse.js';

// Representative slice of the help layout: column-0 section headers ending in ':',
// 2-space-indented option entries, and deeply-indented continuation lines.
const SAMPLE = `
code-exam - tool
Version: 1.0

USAGE:
  node src/index.js [options]

ENGINE:
  --cpu                      Force the local GGUF onto the CPU instead of the
                             GPU. Prefer on an integrated GPU.
  --overview-by-ai           Prose orientation written by an LLM over the tools.

DISPLAY:
  -v, --verbose              Show extra detail
  --max-results <n>          Maximum results to display
`;

test('filterHelp shows the matching entry block including its continuation lines', () => {
  const out = filterHelp(SAMPLE, 'cpu');
  assert.match(out, /--cpu/);
  assert.match(out, /integrated GPU/);      // continuation line travels with the entry
});

test('filterHelp excludes non-matching entries', () => {
  const out = filterHelp(SAMPLE, 'cpu');
  assert.doesNotMatch(out, /--verbose/);
  assert.doesNotMatch(out, /--max-results/);
  assert.doesNotMatch(out, /--overview-by-ai/);
});

test('filterHelp includes the parent section header for context, not unrelated ones', () => {
  const out = filterHelp(SAMPLE, 'cpu');
  assert.match(out, /ENGINE:/);
  assert.doesNotMatch(out, /DISPLAY:/);
});

test('filterHelp matches description text, not just option names', () => {
  const out = filterHelp(SAMPLE, 'orientation');
  assert.match(out, /--overview-by-ai/);
  assert.doesNotMatch(out, /--cpu/);
});

test('filterHelp is case-insensitive', () => {
  assert.match(filterHelp(SAMPLE, 'CPU'), /--cpu/);
});

test('filterHelp reports cleanly when nothing matches', () => {
  const out = filterHelp(SAMPLE, 'zzznotathing');
  assert.match(out, /No help entries match/);
  assert.doesNotMatch(out, /--cpu/);
});
