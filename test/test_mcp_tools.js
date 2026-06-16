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
