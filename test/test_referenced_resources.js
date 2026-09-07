// test_referenced_resources.js — external surface: URLs, env vars, paths, commands, cloud and model refs
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// #203: referenced-resources extractor — the codebase's external surface
// (URLs/hosts, env vars, filesystem paths, external commands, cloud, models).
// Builds a small fixture with known references and asserts each category is
// picked up, deduped, and site-attributed.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { extractReferencedResources } from '../src/core/referenced-resources.js';
import { handleTool, setIndex } from '../src/mcp-server.js';

const SRC = path.join(os.tmpdir(), 'ce_refres_src');
const IDX = path.join(os.tmpdir(), 'ce_refres_idx');
let res;
let rrIndex;

before(async () => {
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.rmSync(IDX, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });

  fs.writeFileSync(path.join(SRC, 'client.js'), `const API_KEY = process.env.OPENAI_API_KEY;
const region = process.env['AWS_REGION'];
async function call() {
  const r = await fetch("https://api.example.com/v1/chat");
  const r2 = await fetch("https://api.example.com/v1/models");  // same host, different path
  return r;
}
const { execSync } = require('child_process');
function build() { execSync("git rev-parse HEAD"); }
const data = require('fs').readFileSync("./config/settings.json");
// A config path referenced as a plain literal — NOT a direct fs-call arg — must
// still be found (the #203 iterate: worklist.json was missed by call-anchoring).
const WORKLIST_PATH = "resources/worklist.json";
const settings = loadConfig("app.config.yaml");
const modPath = "./helpers/utils.js";   // a source-file path — must NOT be listed as a resource
const db = require('better-sqlite3')('app.db');
db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");  // SQL via .exec — must NOT count as a command
const rows = db.prepare("SELECT id, name FROM users WHERE active = 1").all();
const note = mkTempDir().expect("create temp draft dir");  // prose, NOT SQL (the CREATE TEMP false positive)
const iid = "IDL:omg.org/CORBA/Object:1.0";   // CORBA repository id — NOT a filesystem path
const frag = ".db";                            // bare extension fragment — NOT a file
const logfmt = "SELECT: rc from QueryNPipeSem: %d";  // log format string — NOT SQL
`);

  fs.writeFileSync(path.join(SRC, 'worker.py'), `import os
import subprocess

TOKEN = os.getenv("SERVICE_TOKEN")
HOME = os.environ["HOME"]

# Bare-filename prompt-template reference via pathlib join — the literal is
# "ai_welfare_poisoning.jinja2" (no separator inside the string). Must register
# as a referenced file now that template extensions are allow-listed.
PROMPT_TEMPLATE = PROMPTS_DIR / "ai_welfare_poisoning.jinja2"

def run():
    subprocess.run(["ffmpeg", "-i", "in.mp4"])
    os.system("ls -la")
    with open("/etc/hosts") as f:
        return f.read()

def fetch():
    import urllib.request
    return urllib.request.urlopen("http://internal.svc.local:8080/health")
`);

  rrIndex = new CodeSearchIndex({ indexPath: IDX });
  await rrIndex.buildIndex(SRC, { showProgress: false });
  res = extractReferencedResources(rrIndex);
});

describe('referenced-resources extractor (#203)', () => {
  it('returns the expected category shape', () => {
    for (const k of ['network', 'env', 'filesystem', 'subprocess', 'cloud', 'models', 'stats']) {
      assert.ok(k in res, `missing category ${k}`);
    }
    assert.ok(Array.isArray(res.network) && Array.isArray(res.env));
  });

  it('captures env vars across JS and Python idioms', () => {
    const names = new Set(res.env.map(e => e.value));
    for (const n of ['OPENAI_API_KEY', 'AWS_REGION', 'SERVICE_TOKEN', 'HOME']) {
      assert.ok(names.has(n), `env var ${n} not detected (got ${[...names].join(', ')})`);
    }
  });

  it('captures URLs and derives hosts, deduping same-host paths into distinct entries', () => {
    const urls = res.network.map(n => n.value);
    assert.ok(urls.some(u => u.startsWith('https://api.example.com/v1/chat')), 'missing chat URL');
    assert.ok(urls.some(u => u.includes('internal.svc.local')), 'missing internal URL');
    assert.ok(res.hosts.includes('api.example.com'), 'host not derived');
    assert.ok(res.hosts.includes('internal.svc.local'), 'internal host not derived');
  });

  it('captures filesystem paths — incl. config literals NOT in an fs call (#203 iterate)', () => {
    const paths = new Set(res.filesystem.map(e => e.value));
    assert.ok(paths.has('/etc/hosts'), 'open() path not detected');
    assert.ok(paths.has('./config/settings.json'), 'readFileSync path not detected');
    // The regression that motivated this iterate: a plain `"resources/worklist.json"`
    // literal (assigned to a var, not an fs-call arg) must be found.
    assert.ok(paths.has('resources/worklist.json'), 'plain config-path literal not detected');
    assert.ok(paths.has('app.config.yaml'), 'bare data-file literal not detected');
    // Bare-filename template reference (pathlib `dir / "x.jinja2"`) — the filename
    // literal is present even though the full path is assembled at runtime.
    assert.ok(paths.has('ai_welfare_poisoning.jinja2'), 'bare-filename .jinja2 template ref not detected');
    // Source-module imports are internal structure, not external resources.
    assert.ok(![...paths].some(p => p.endsWith('utils.js')), 'source import should not be listed as a resource: ' + [...paths].join(', '));
    // False positives that the multi-index scan surfaced: CORBA IDL repository
    // ids (mid-string colons) and bare extension fragments.
    assert.ok(!paths.has('IDL:omg.org/CORBA/Object:1.0'), 'CORBA IDL id wrongly listed as a path');
    assert.ok(!paths.has('.db'), 'bare ".db" fragment wrongly listed as a file');
  });

  it('captures external commands from exec/subprocess/system', () => {
    const cmds = new Set(res.subprocess.map(e => e.value));
    assert.ok([...cmds].some(c => c.startsWith('git rev-parse')), 'execSync target missing');
    assert.ok(cmds.has('ffmpeg'), 'subprocess.run target missing');
    assert.ok([...cmds].some(c => c.startsWith('ls')), 'os.system target missing');
  });

  it('captures embedded SQL and keeps it OUT of External commands (#202)', () => {
    const sql = res.sql.map(e => e.value);
    assert.ok(sql.some(q => /^SELECT id, name FROM users/i.test(q)), 'SELECT not captured: ' + JSON.stringify(sql));
    assert.ok(sql.some(q => /^CREATE TABLE users/i.test(q)), 'CREATE TABLE not captured');
    // `CREATE TEMP` must require a following TABLE/VIEW — a `.expect("create temp
    // draft dir")` message is prose, not SQL.
    assert.ok(!sql.some(q => /create temp draft/i.test(q)), 'prose "create temp draft dir" wrongly flagged as SQL: ' + JSON.stringify(sql));
    // A log format string "SELECT: rc from …" is not SQL (SELECT must be followed
    // by a column, not a colon).
    assert.ok(!sql.some(q => /QueryNPipeSem/i.test(q)), 'log format string wrongly flagged as SQL');
    // The db.exec("CREATE TABLE …") must NOT be mis-binned as a shell command.
    const cmds = res.subprocess.map(e => e.value);
    assert.ok(!cmds.some(c => /^(SELECT|CREATE TABLE|INSERT|UPDATE|DELETE)\b/i.test(c)),
      'SQL leaked into External commands: ' + JSON.stringify(cmds));
  });

  it('tags filesystem entries with kind (file vs path)', () => {
    const wl = res.filesystem.find(e => e.value === 'resources/worklist.json');
    assert.ok(wl && wl.kind === 'file', 'worklist.json should be kind=file');
    const appdb = res.filesystem.find(e => e.value === 'app.db');
    assert.ok(appdb && appdb.kind === 'file', 'app.db should be kind=file');
  });

  it('records site attribution (filepath + line + source-line snippet) per resource', () => {
    const env0 = res.env.find(e => e.value === 'OPENAI_API_KEY');
    assert.ok(env0 && env0.sites.length >= 1 && env0.sites[0].filepath && env0.sites[0].line > 0,
      'env resource should carry a site');
    // The snippet lets the drill-down show per-site specifics (e.g. full args of
    // a spawn('git', [...]) call) without clicking each one.
    assert.ok(/process\.env\.OPENAI_API_KEY/.test(env0.sites[0].snippet || ''),
      'site should carry the source-line snippet: ' + JSON.stringify(env0.sites[0]));
  });

  // Guard the MCP surface too, not just the core — the lesson from the
  // struct_dupes handler drift (#203): the MCP wrapper can rot while the core
  // works. Drives handleTool against the same fixture via the setIndex seam.
  it('referenced_resources MCP tool returns formatted text with the findings', () => {
    setIndex(rrIndex);
    const out = handleTool('referenced_resources', { n: 20 });
    assert.equal(typeof out, 'string');
    assert.doesNotMatch(out, /is not a function|undefined is not/, 'handler must not throw');
    assert.match(out, /Environment variables/, 'should render the env section: ' + out.slice(0, 200));
    assert.ok(/OPENAI_API_KEY/.test(out), 'should list a detected env var');
  });

  it('referenced_resources MCP tool honors the category filter', () => {
    setIndex(rrIndex);
    const out = handleTool('referenced_resources', { category: 'env' });
    assert.match(out, /Environment variables/);
    assert.doesNotMatch(out, /Network \(URLs\)/, 'category=env should omit other sections');
  });
});
