// test_mcp_tools.js — MCP handleTool: digest, call_tree, command_catalog, models_used, absence disclosure
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Coverage for the chat-essential MCP tools (#35; chat enablers #34/#36):
// digest, call_tree, command_catalog, models_used. Exercises the actual
// handleTool dispatch (via the setIndex test seam) against a small built
// fixture index — same handler path the stdio server uses.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { handleTool, TOOLS, setIndex } from '../src/mcp-server.js';
import { modelsUsedNegative } from '../src/commands/metrics.js';

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

describe('#306 cap footer reaches the highest-volume truncations', () => {
  before(() => { setIndex(new CodeSearchIndex({ indexPath: IDX })); });

  // F47's original failure was here: a model answered "which file has the MOST
  // functions" from the first entry of a 100-of-1644 list_functions result. The
  // total was in the header the whole time; the model was reading the body.
  it('list_functions carries the remaining count at the bottom', () => {
    const out = handleTool('list_functions', { max: 1 });
    assert.match(out, /functions.*showing 1/, 'header unchanged');
    assert.match(out, /more not shown \(total/, 'and now a footer');
    assert.ok(out.lastIndexOf('not shown') > out.indexOf('showing 1'));
  });

  it('list_files carries it too', () => {
    const out = handleTool('list_files', { max: 1 });
    assert.match(out, /files.*showing 1/);
    assert.match(out, /more not shown \(total/);
  });

  it('neither adds a footer when nothing was truncated', () => {
    assert.doesNotMatch(handleTool('list_functions', { max: 10000 }), /not shown/);
    assert.doesNotMatch(handleTool('list_files', { max: 10000 }), /not shown/);
  });
});

// ---------------------------------------------------------------------------
// #306 fix-list item 3, recs 2-4 (F47, F48). Rec 1 (tail markers) shipped in
// 2223dc7/f98af83; these are the three that were left. The through-line: a
// "Top N" without its population is uninterpretable, and 16 of 24 tools expose
// a limit param that a caller cannot know to raise without knowing it hit one.
// ---------------------------------------------------------------------------

describe('#306 ranked tools state their population', () => {
  // Re-point rather than depend on declaration order — see the note above the
  // 'feedback at the point of failure' block.
  before(() => { setIndex(new CodeSearchIndex({ indexPath: IDX })); });

  const RANKED = [
    ['most_called', /^Top 1 of \d+ most called functions /],
    ['hotspots', /^Top 1 of \d+ hotspots /],
    ['vocabulary', /^Top 1 of \d+ domain vocabulary tokens/],
  ];

  for (const [tool, headRe] of RANKED) {
    it(`${tool} names the population and the wrong inference when truncated`, () => {
      const head = handleTool(tool, { n: 1 }).split('\n')[0];
      // Guard against a vacuous pass: if the fixture cannot truncate, the
      // assertions below would hold for the wrong reason.
      const total = Number((head.match(/of (\d+)/) || [])[1]);
      assert.ok(total > 1, `fixture too small to exercise ${tool} truncation (total=${total})`);
      assert.match(head, headRe, 'states shown-of-population');
      assert.match(head, /PARTIAL result; do not infer absence\./, 'carries the disclosure clause');
    });

    it(`${tool} says nothing extra when the whole population fits`, () => {
      const head = handleTool(tool, { n: 10000 }).split('\n')[0];
      assert.doesNotMatch(head, /PARTIAL/, 'no disclosure when nothing was withheld');
      assert.doesNotMatch(head, / of \d+ /, 'no population clause when it equals the sample');
    });
  }

  // Rec 2 is "same sentence as search", not "a sentence like search's". A
  // paraphrase would drift; _PARTIAL_CLAUSE is one definition and this is what
  // pins it to one.
  it('uses the identical disclosure sentence that search uses', () => {
    const CLAUSE = '- PARTIAL result; do not infer absence.';
    assert.ok(handleTool('search', { query: 'def', max: 1 }).includes(CLAUSE));
    for (const [tool] of RANKED) {
      assert.ok(handleTool(tool, { n: 1 }).includes(CLAUSE), `${tool} drifted from search's wording`);
    }
  });

  // Rec 4 (F47): the class-count question went to list_functions and never to
  // list_classes, because stats is where a model looks for counts.
  it('stats reports a class count beside files and functions', () => {
    const out = handleTool('stats', {});
    assert.match(out, /^Classes: \d+$/m);
    assert.ok(out.indexOf('Classes:') > out.indexOf('Functions:'), 'sits with the other counts');
  });
});

// Surfaced by rec 3 rather than sought: computing the population meant fetching
// the full ranked list, which exposed that the filter had been running against
// the ALREADY-CAPPED head. On .CE_080426 this reported "No hotspots found" for a
// filter matching 17 real hotspots — a FALSE ABSENCE emitted by the very tool
// whose absence-disclosure this item is about.
describe('#306 hotspots filters the population, not the capped head', () => {
  before(() => { setIndex(new CodeSearchIndex({ indexPath: IDX })); });

  it('finds a match ranked below the cap', () => {
    const rows = handleTool('hotspots', { n: 10000 }).split('\n').slice(1).filter(Boolean);
    assert.ok(rows.length > 1, 'fixture needs >1 hotspot to place one below a cap of 1');
    // Name from the LAST row — guaranteed outside a top-1 window.
    const lastName = rows[rows.length - 1].trim().split(/\s+/)[1];
    const out = handleTool('hotspots', { n: 1, filter: lastName });
    assert.doesNotMatch(out, /No hotspots found/, 'the old path filtered within the top n and reported absence');
    assert.ok(out.includes(lastName));
  });
});

// ---------------------------------------------------------------------------
// #306 F50. The measured failure: gpt-oss-20b's overview of CE stated that CE
// "does not load any local models," citing models_used. It was not a
// hallucination — CE said "No models used found (1 unresolved <var> refs)" and
// the model reported it. The loading site WAS found; only its id was
// unresolvable, because the path is built at run time.
// ---------------------------------------------------------------------------

describe('#306 models_used does not report absence it did not measure', () => {
  before(() => { setIndex(new CodeSearchIndex({ indexPath: IDX })); });

  it('leads with the finding, not with absence, when refs were unresolved', () => {
    const msg = modelsUsedNegative(1);
    // The crux: the old message opened with "No models used found", which is the
    // sentence the model repeated. Anything starting with a negation reinstates it.
    assert.doesNotMatch(msg, /^No\b/, 'must not open by asserting absence');
    assert.match(msg, /^1 model reference found/, 'opens with what WAS found');
    assert.match(msg, /does NOT mean the code loads no models/, 'names the specific wrong inference');
    assert.match(msg, /computed at run time/);
  });

  it('pluralises rather than emitting "1 references"', () => {
    assert.match(modelsUsedNegative(2), /^2 model references found/);
  });

  it('a genuine zero is still a clean negative, and still says what was searched', () => {
    const msg = modelsUsedNegative(0);
    assert.match(msg, /do not infer absence/, 'same clause the ranked tools and search use');
    assert.match(msg, /LITERALS/, 'states that only literal ids are detected');
    assert.match(msg, /builds model paths at run time/, 'names the case it cannot see');
    assert.doesNotMatch(msg, /model reference.? found/, 'must not claim a finding it does not have');
  });

  // Two surfaces read this: the MCP tool (a model) and the CLI (a human
  // examiner). They drifted before because each owned its own string.
  it('the MCP tool returns the shared builder verbatim', () => {
    const real = new CodeSearchIndex({ indexPath: IDX });
    try {
      setIndex({ listModelsUsed: () => Object.assign([], { unresolved: 3 }) });
      assert.equal(handleTool('models_used', {}), modelsUsedNegative(3));
      setIndex({ listModelsUsed: () => Object.assign([], { unresolved: 0 }) });
      assert.equal(handleTool('models_used', {}), modelsUsedNegative(0));
    } finally {
      setIndex(real); // never leave the fixture pointed at a stub
    }
  });
});

// callgraph-companion-surfaces: the MCP `callers` tool handed the raw spec to
// findCallers with no file hint, so "a.js@fmt" found nothing and a bare name
// merged every same-named definition; `callees` printed "[N defs]" for a call
// the engine marks unresolved. Both now read as the CLI does.
describe('callers / callees honour file@func and the resolution markers', () => {
  const SRC3 = path.join(os.tmpdir(), 'ce_mcp_tools_src3');
  const IDX3 = path.join(os.tmpdir(), 'ce_mcp_tools_idx3');
  let idx3;

  before(async () => {
    fs.rmSync(SRC3, { recursive: true, force: true });
    fs.rmSync(IDX3, { recursive: true, force: true });
    fs.mkdirSync(SRC3, { recursive: true });
    // Two file-local `fmt` definitions; CJS exports make the visibility explicit.
    fs.writeFileSync(path.join(SRC3, 'a.js'), `function fmt(x) {
  return 'a:' + x;
}
function useA() {
  return fmt(1);
}
module.exports = { useA };
`);
    fs.writeFileSync(path.join(SRC3, 'b.js'), `function fmt(x) {
  return 'b:' + x;
}
function useB() {
  const out = [];
  out.push(fmt(2));
  return out;
}
fmt(3);
module.exports = { useB };
`);
    // A non-exported `push` elsewhere: not reachable from b.js's `out.push(`.
    fs.writeFileSync(path.join(SRC3, 'c.js'), `function push(s) {
  return s;
}
function useC() {
  return push('x');
}
module.exports = { useC };
`);
    idx3 = new CodeSearchIndex({ indexPath: IDX3 });
    await idx3.buildIndex(SRC3, { showProgress: false });
    setIndex(idx3);
  });

  after(() => { setIndex(new CodeSearchIndex({ indexPath: IDX })); });

  it('callers with file@func lists only the sites that can reach that definition', () => {
    const out = handleTool('callers', { function_name: 'a.js@fmt' });
    assert.match(out, /a\.js:\d+/, 'the a.js site: ' + out);
    assert.doesNotMatch(out, /b\.js:\d+/, 'no b.js site: ' + out);
    assert.doesNotMatch(out, /No callers found/, out);
  });

  it('callers with a bare name still lists every same-named site (documented, unchanged)', () => {
    const out = handleTool('callers', { function_name: 'fmt' });
    assert.match(out, /a\.js:\d+/, out);
    assert.match(out, /b\.js:\d+/, out);
  });

  it('a module-scope call site is credited to (file scope)', () => {
    const out = handleTool('callers', { function_name: 'b.js@fmt' });
    assert.match(out, /\(file scope\)/, out);
    assert.match(out, /\(in useB\)/, out);
  });

  it('callees marks a receiver call with no reachable definition [unresolved]', () => {
    const out = handleTool('callees', { function_name: 'b.js@useB' });
    assert.match(out, /push[^\n]*\[unresolved\]/, out);
    assert.doesNotMatch(out, /push[^\n]*\[1 defs\]/, out);
    assert.match(out, /fmt[^\n]*\[b\.js\]/, 'the same-file fmt resolves: ' + out);
  });
});

// claim-mcp-primitives (#343 B2, #35): the deterministic half of the claim
// pipeline as tools — split the claim, rank real symbols for the words the
// Chat model predicts, say what CodeExam can do — with no LLM inside a tool.
// The claim text below is SYNTHETIC; the real claim files are gitignored and
// must not become test dependencies.
describe('claim tools: claim_elements, claim_candidates, capabilities', () => {
  const SRC4 = path.join(os.tmpdir(), 'ce_mcp_tools_src4');
  const IDX4 = path.join(os.tmpdir(), 'ce_mcp_tools_idx4');
  const CLAIM = '1. A method of securing a session, comprising: initializing a cryptographic context; '
    + 'transmitting an encrypted payload to a peer; receiving an acknowledgement from the peer.';
  // Words as the discover prompt asks a model for them: one numbered line per
  // element. "session" on three elements makes sessionLogger a sponge.
  const WORDS = '2: init, crypto, context, session\n3: transmit, send, encrypted, payload, session\n4: receive, send, session';
  let idx4;

  before(async () => {
    fs.rmSync(SRC4, { recursive: true, force: true });
    fs.rmSync(IDX4, { recursive: true, force: true });
    fs.mkdirSync(path.join(SRC4, 'test'), { recursive: true });
    fs.writeFileSync(path.join(SRC4, 'a.js'), `function initCryptoContext(cfg) {
  return { cfg, ready: true };
}
function sessionLogger(msg) {
  return 'session: ' + msg;
}
module.exports = { initCryptoContext, sessionLogger };
`);
    fs.writeFileSync(path.join(SRC4, 'b.js'), `function sendEncryptedPayload(peer, payload) {
  const session = sessionLogger('send');
  return peer.write(payload);
}
function receivePayload(peer) {
  return peer.read();
}
function finishHandshake(peer) {
  // transmit the encrypted payload once the crypto context is ready
  return peer.flush();
}
module.exports = { sendEncryptedPayload, receivePayload, finishHandshake };
`);
    fs.writeFileSync(path.join(SRC4, 'test', 'crypto.test.js'), `function initCryptoContextTest() {
  return initCryptoContext({});
}
module.exports = { initCryptoContextTest };
`);
    idx4 = new CodeSearchIndex({ indexPath: IDX4 });
    await idx4.buildIndex(SRC4, { showProgress: false });
    setIndex(idx4);
  });

  after(() => { setIndex(new CodeSearchIndex({ indexPath: IDX })); });

  it('registers the three claim tools, each with its "when to use" inside the 280-char local cut', () => {
    const byName = new Map(TOOLS.map(t => [t.name, t]));
    for (const n of ['claim_elements', 'claim_candidates', 'capabilities']) {
      assert.ok(byName.has(n), `TOOLS missing ${n}`);
    }
    assert.match(byName.get('claim_elements').description.slice(0, 280), /claim/i);
    assert.match(byName.get('claim_candidates').description.slice(0, 280), /words/i);
    assert.match(byName.get('capabilities').description.slice(0, 280), /which tool/i);
  });

  it('claim_elements puts the preamble first and numbers the limitations', () => {
    const out = handleTool('claim_elements', { claim_text: CLAIM, granularity: 'coarse' });
    assert.match(out, /^4 elements/m, out);
    assert.match(out, /1\. \[preamble\][^\n]*securing a session/, out);
    assert.match(out, /2\. initializing a cryptographic context/, out);
    assert.match(out, /4\. receiving an acknowledgement/, out);
    assert.match(out, /claim_candidates/, 'points at the next step');
  });

  it('claim_candidates ranks name matches, merges a content-arm hit, and holds tests back', () => {
    const out = handleTool('claim_candidates', { claim_text: CLAIM, words: WORDS, granularity: 'coarse' });
    const el2 = out.slice(out.indexOf('Element 2'), out.indexOf('Element 3'));
    assert.match(el2, /a\.js@initCryptoContext/, el2);
    assert.doesNotMatch(el2, /initCryptoContextTest/, 'test symbols held back by default: ' + el2);
    assert.match(el2, /test-file candidate|held back/, 'and says so: ' + el2);
    const el3 = out.slice(out.indexOf('Element 3'), out.indexOf('Element 4'));
    assert.match(el3, /b\.js@sendEncryptedPayload/, el3);
    assert.match(el3, /finishHandshake[^\n]*content/, 'body-only match arrives via the content arm: ' + el3);
    assert.match(out, /Next:[^\n]*extract/, 'routes to reading the code');
  });

  it('claim_candidates flags an opposite-direction name and a vocabulary sponge', () => {
    const out = handleTool('claim_candidates', { claim_text: CLAIM, words: WORDS, granularity: 'coarse' });
    const el4 = out.slice(out.indexOf('Element 4'));
    assert.match(el4, /sendEncryptedPayload[^\n]*opposite direction/, el4);
    assert.match(out, /sponge[^\n]*sessionLogger/i, 'sessionLogger tops three elements: ' + out);
  });

  it('claim_candidates admits tests on request and states its population when capped', () => {
    const withTests = handleTool('claim_candidates', { claim_text: CLAIM, words: WORDS, granularity: 'coarse', include_tests: true });
    assert.match(withTests, /initCryptoContextTest/, withTests);
    const capped = handleTool('claim_candidates', { claim_text: CLAIM, words: WORDS, granularity: 'coarse', max_per_element: 1 });
    const el2 = capped.slice(capped.indexOf('Element 2'), capped.indexOf('Element 3'));
    assert.match(el2, /Top 1 of \d+ name matches/, el2);
    assert.match(el2, /PARTIAL result; do not infer absence/, el2);
  });

  it('claim_candidates explains the words format at the point of failure', () => {
    const out = handleTool('claim_candidates', { claim_text: CLAIM, words: 'crypto session send' });
    assert.match(out, /one line per element/i, out);
    assert.match(out, /2: init, crypto, context/, 'shows the shape, starting at the first limitation');
  });

  it('capabilities names the claim workflow and the tools to read code with', () => {
    const out = handleTool('capabilities', {});
    assert.match(out, /claim_elements/);
    assert.match(out, /claim_candidates/);
    assert.match(out, /extract/);
    assert.match(out, /--claim-chart/, 'the audited chart stays a CLI command');
  });
});

// ---------------------------------------------------------------------------
// overview-verification-basis-unfiltered, part B (asus-CC, #330): a filter that
// matches nothing must not produce the ABSENCE message. Gemma called
// models_used({"filter":"/"}) on a 36-model index and got "No model ids found -
// do not infer absence", reasoned from it, and CE's footnote then repeated the
// emptiness as a fact about the index. The same shape sat in list_functions,
// list_files, list_classes, hotspots and most_called ("No X found").
// ---------------------------------------------------------------------------

describe('part B: a filter that matches nothing is disclosed, not reported as absence', () => {
  const mem = new CodeSearchIndex({ indexPath: '.__test_mcp_filter_noindex__' });
  const files = {
    'a.js': "const DEFAULT_MODEL = 'claude-sonnet-4-6';\nexport function pickModel() { return DEFAULT_MODEL; }",
    'b.js': "export function other() { return 1; }",
  };
  mem.fileLines = new Map(Object.entries(files).map(([p, s]) => [p, s.split('\n')]));
  mem.files = new Map(Object.entries(files));
  before(() => setIndex(mem));
  after(() => setIndex(new CodeSearchIndex({ indexPath: IDX })));

  it('models_used with a filter that matches nothing names the filter and the count, never the absence text', () => {
    const out = handleTool('models_used', { filter: '/' });
    assert.match(out, /No models match filter "\/"/, out);
    assert.match(out, /1 exists/, out);
    assert.doesNotMatch(out, /No model ids found/, 'the absence text is for an unfiltered empty result');
    assert.doesNotMatch(out, /do not infer absence/);
  });
  it('models_used unfiltered still lists the model', () => {
    assert.match(handleTool('models_used', {}), /claude-sonnet-4-6/);
  });
  it('list_files with an impossible filter names it', () => {
    const out = handleTool('list_files', { filter: 'zzz-nothing' });
    assert.match(out, /No files match filter "zzz-nothing"/, out);
    assert.match(out, /2 exist/, out);
    assert.doesNotMatch(out, /^No files found/);
  });
  it('an unfiltered empty list keeps its plain absence message', () => {
    const empty = new CodeSearchIndex({ indexPath: '.__test_mcp_filter_empty__' });
    empty.fileLines = new Map(); empty.files = new Map();
    setIndex(empty);
    try {
      assert.equal(handleTool('list_files', {}), 'No files found');
      assert.match(handleTool('models_used', {}), /No model ids found/);
    } finally { setIndex(mem); }
  });
});
