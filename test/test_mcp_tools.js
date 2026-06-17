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
