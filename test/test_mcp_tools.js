// Coverage for the chat-essential MCP tools (#35; chat enablers #34/#36):
// digest, call_tree, command_catalog, models_used. Exercises the actual
// handleTool dispatch (via the setIndex test seam) against a small built
// fixture index — same handler path the stdio server uses.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { handleTool, TOOLS, setIndex } from '../src/mcp-server.js';

const SRC = path.join(os.tmpdir(), 'ce_mcp_tools_src');
const IDX = path.join(os.tmpdir(), 'ce_mcp_tools_idx');

before(async () => {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
  fs.writeFileSync(path.join(SRC, 'app.py'), `"""App entry point."""
import argparse
from utils import helper_function
from transformers import AutoModel

class Application:
    def __init__(self, config):
        self.config = config

    def run(self):
        return helper_function(self.config)

def load_model():
    return AutoModel.from_pretrained("bert-base-uncased")

def main():
    app = Application("test")
    load_model()
    return app.run()

def cli():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verbose")
    parser.add_argument("--output")
    return parser.parse_args()
`);
  fs.writeFileSync(path.join(SRC, 'utils.py'), `def helper_function(data):
    return str(data).upper()
`);
  // A var-assigned factory call (NOT a function literal) — not indexed as a
  // function — plus an incidental mention, to exercise the #184 extract interim.
  fs.writeFileSync(path.join(SRC, 'widget.js'), `const Widget = createComponent({ name: "demo" });
const other = 1;
function renderWidget() {
  return Widget;
}
`);
  const index = new CodeSearchIndex({ indexPath: IDX });
  await index.buildIndex(SRC, { showProgress: false });
  setIndex(index);
});

describe('chat-essential MCP tools', () => {
  it('registers the four new tools', () => {
    const names = new Set(TOOLS.map(t => t.name));
    for (const n of ['digest', 'call_tree', 'command_catalog', 'models_used']) {
      assert.ok(names.has(n), `TOOLS missing ${n}`);
    }
  });

  it('digest summarizes a function (returns text naming it)', () => {
    const out = handleTool('digest', { target: 'main' });
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
    assert.ok(/main/.test(out), 'digest should name the target');
  });

  it('digest on a missing target returns a not-found message, not a throw', () => {
    const out = handleTool('digest', { target: 'no_such_function_xyz' });
    assert.match(out, /not found/i);
  });

  it('call_tree traces from a function (captures the printed tree)', () => {
    const out = handleTool('call_tree', { function_name: 'main', depth: 2 });
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
    assert.ok(/main/.test(out), 'call tree should mention the root');
  });

  it('command_catalog returns text (CLI options / commands / routes / GUI)', () => {
    const out = handleTool('command_catalog', {});
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
    // argparse flags should surface; tolerate detector variance with a fallback.
    assert.ok(/--verbose|--output|CLI Options|No commands/.test(out));
  });

  it('models_used returns text (and surfaces the loaded model when detected)', () => {
    const out = handleTool('models_used', {});
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
    assert.ok(/bert-base-uncased|models used|No models used/.test(out));
  });

  it('unknown tool name is handled gracefully', () => {
    assert.match(handleTool('does_not_exist', {}), /Unknown tool/);
  });
});

describe('MCP tool-ergonomics fixes (#184)', () => {
  it('extract accepts the "target" alias (param consistency, #184 item 2)', () => {
    const out = handleTool('extract', { target: 'main' });
    assert.ok(/=== main ===|def main/.test(out), 'extract should work via target alias: ' + out);
  });

  it('extract with no name argument returns a friendly error, not a throw (#184 item 1)', () => {
    const out = handleTool('extract', {});
    assert.match(out, /requires "function_name"/);
  });

  it('extract with a wrong file hint falls back to suggest the real location (#184 item 5)', () => {
    const out = handleTool('extract', { function_name: 'wrongfile.py@main' });
    assert.ok(/app\.py/.test(out), 'should suggest the real file: ' + out);
  });

  it('callers accepts the "target" alias', () => {
    const out = handleTool('callers', { target: 'helper_function' });
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  });

  it('callees accepts the "target" alias', () => {
    const out = handleTool('callees', { target: 'main' });
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  });

  it('multisect_search names the matched functions, not "undefined" (#184 item 6)', () => {
    const out = handleTool('multisect_search', { terms: 'config;run', min_terms: 50 });
    if (/function matches/.test(out)) {
      assert.ok(!/\bundefined\b/.test(out), 'function rows must be named, not undefined: ' + out);
    }
  });

  it('extract interim points at the assignment site, not an incidental mention (#184 item 4 interim)', () => {
    const out = handleTool('extract', { function_name: 'Widget' });
    assert.match(out, /not indexed as a function/);
    assert.match(out, /widget\.js:1\b/);
    assert.ok(!/widget\.js:4\b/.test(out),
      'should point at the `const Widget =` line, not the bare `return Widget` mention: ' + out);
  });
});

// #203: the struct_dupes handler had drifted from the working /api/struct-dupes
// route — wrong method name (getStructuralDupes vs getStructDupes), a missing
// getFuncDupes() prerequisite (without it getStructDupes returns []), and the
// wrong result shape (group.functions vs group.instances). It threw
// "getStructuralDupes is not a function" on every call, which the AI Overview
// run surfaced. This guards the corrected handler.
describe('struct_dupes (#203 regression)', () => {
  const SRC2 = path.join(os.tmpdir(), 'ce_mcp_structdupes_src');
  const IDX2 = path.join(os.tmpdir(), 'ce_mcp_structdupes_idx');
  let sdIndex;

  before(async () => {
    fs.rmSync(SRC2, { recursive: true, force: true });
    fs.mkdirSync(SRC2, { recursive: true });
    // Two functions with identical control flow but different names → same
    // structural hash, different bodies → a structural duplicate group (not an
    // exact dupe).
    fs.writeFileSync(path.join(SRC2, 'clones.py'), `def sum_values(items):
    total = 0
    for entry in items:
        total = total + entry
        total = total * 2
    if total > 100:
        total = 100
    return total

def accumulate_scores(records):
    running = 0
    for record in records:
        running = running + record
        running = running * 2
    if running > 100:
        running = 100
    return running
`);
    sdIndex = new CodeSearchIndex({ indexPath: IDX2 });
    await sdIndex.buildIndex(SRC2, { showProgress: false });
  });

  it('detects the structural clone instead of throwing "is not a function"', () => {
    setIndex(sdIndex);
    const out = handleTool('struct_dupes', { n: 10, min_lines: 2 });
    assert.equal(typeof out, 'string');
    assert.doesNotMatch(out, /is not a function/, 'must not throw the old getStructuralDupes error');
    assert.match(out, /structural duplicate groups/, 'should report groups: ' + out);
    assert.ok(/sum_values|accumulate_scores/.test(out), 'group should name a clone instance: ' + out);
  });
});

// ---------------------------------------------------------------------------
// #306 batch 3 — feedback AT THE POINT OF FAILURE. asus-CC's central lesson:
// information placed where the model is NOT acting does not change behaviour.
// Widening tool descriptions was measured and made things worse (F41); an
// imperative preamble regressed 4 of 10 cells (F34); a post-hoc nudge moved
// zero (batch-2 §4). These four change what a tool returns at the moment it
// fails, which is where the model is definitely reading.
// ---------------------------------------------------------------------------

describe('#306 feedback at the point of failure', () => {
  // The struct_dupes block above calls setIndex(sdIndex) and never restores it,
  // so anything declared after it silently runs against the wrong fixture —
  // which is how the first cut of these tests "passed" a zero-result assertion
  // on a term the real fixture contains. Re-point at the main index rather than
  // depend on declaration order.
  before(() => { setIndex(new CodeSearchIndex({ indexPath: IDX })); });

  it('search zero-result names the LITERAL/semantic distinction and the escape hatches', () => {
    // F56: a measured run spent a 24-CALL LOOP reformulating one multi-word
    // phrase, because "No results" said nothing about why.
    const out = handleTool('search', { query: 'the part that handles authentication' });
    assert.match(out, /No results/);
    assert.match(out, /LITERAL TEXT search/);
    assert.match(out, /multi-word phrases/i);
    assert.match(out, /multisect_search/);
    assert.match(out, /list_files|list_functions/);
  });

  it('regex_search says REGULAR-EXPRESSION, not literal', () => {
    const out = handleTool('regex_search', { pattern: 'zzz_no_such_pattern_zzz' });
    assert.match(out, /REGULAR-EXPRESSION search/);
  });

  it('a successful search is NOT changed by any of this', () => {
    // These are failure-branch strings. A passing call must be untouched, or the
    // sweep measuring them cannot attribute anything.
    const out = handleTool('search', { query: 'import' });
    assert.doesNotMatch(out, /No results/, 'fixture must actually contain this');
    assert.doesNotMatch(out, /LITERAL TEXT search/);
    assert.doesNotMatch(out, /not shown \(total/);
  });

  it('digest/extract not-found offers search, not just a file hint', () => {
    // F57: models pick a targeted tool and INVENT the target. The old message
    // ("try a file hint") assumed the name was right and only the path missing,
    // which points away from the recovery that works.
    for (const [tool, args] of [
      ['digest', { target: 'handlesTheLoginFlow' }],
      ['extract', { function_name: 'handlesTheLoginFlow' }],
    ]) {
      const out = handleTool(tool, args);
      assert.match(out, /not found/i, `${tool} still reports not-found`);
      assert.match(out, /search\(/, `${tool} points at search`);
      assert.match(out, /CONCEPT rather than a name/, `${tool} names the guessing case`);
      assert.match(out, /file@name/, `${tool} keeps the qualify-it path too`);
    }
  });

  it('a truncated list carries the remaining count at the BOTTOM, not only the top', () => {
    // F47/F48: 1 of 24 tools marked its cap where the model is reading. A model
    // that has read to the end of a list never sees the header.
    const out = handleTool('search', { query: 'e', max: 2 });
    assert.match(out, /Showing 2 of/, 'header still there');
    assert.match(out, /more not shown \(total/, 'and now a footer');
    assert.ok(out.lastIndexOf('not shown') > out.indexOf('Showing 2 of'),
      'the footer is after the results, which is the whole point');
  });
});
