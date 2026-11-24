// test_ai_ml_test_paths.js — the AI/ML listings and --gaps read "test code" by the one rule in test-paths.js
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
//
// test-options-remaining-commands, part B (2026-11-23). The AI/ML detectors tagged a record as test or
// example code by their own pattern (reTestExamplePath), which knew demos/ and conftest and did not
// know mocks/, bench/ or FooTest.java; --gaps called a file an entry point when its path held the
// letters "test" or "spec", so latest.js counted. Both now read isTestPath.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isTestPath } from '../src/core/test-paths.js';
import { reTestExamplePath } from '../src/core/ai-ml-detectors.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CE = path.join(ROOT, 'src', 'index.js');

describe('the AI/ML detectors tag a record by the shared rule', () => {
  it('reTestExamplePath, the name its importers use, answers as isTestPath does, and keeps demos/ and conftest', () => {
    for (const p of ['src/mocks/net.py', 'bench/run.py', 'pkg/FooTest.java', 'tests/a.py', 'examples/x.py', 'conftest.py', 'pkg/conftest.py', 'src/latest.py', 'src/model.py', 'media.zip!test/a.py']) {
      assert.equal(reTestExamplePath.test(p), isTestPath(p), p);
    }
    assert.equal(isTestPath('pkg/conftest.py'), true, 'conftest is test code');
    assert.equal(isTestPath('src/latest.py'), false);
    // demos/ stays tagged by the detectors, as it was, without being test code to the claim tools
    // (their own demo corpus is a directory named demo/)
    for (const p of ['demos/run.py', 'demo/run.py', 'a/demos/run.py']) {
      assert.equal(reTestExamplePath.test(p), true, p);
      assert.equal(isTestPath(p), false, p);
    }
  });
});

describe('the command line: a record under mocks/, and latest.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-aiml-paths-'));
  const src = path.join(dir, 'proj');
  for (const d of ['src', 'mocks', 'demos']) fs.mkdirSync(path.join(src, d), { recursive: true });
  const loader = (fn, model) => `from transformers import AutoModel\n\ndef ${fn}():\n    return AutoModel.from_pretrained("${model}")\n`;
  fs.writeFileSync(path.join(src, 'src', 'app.py'), loader('load', 'bert-base-uncased'));
  fs.writeFileSync(path.join(src, 'mocks', 'stub_loader.py'), loader('fake', 'gpt2-fixture-model'));
  fs.writeFileSync(path.join(src, 'demos', 'run.py'), loader('demo', 't5-demo-model'));
  fs.writeFileSync(path.join(src, 'src', 'latest.js'), 'function orphanHelper() {\n  return 1;\n}\n');
  fs.writeFileSync(path.join(src, 'mocks', 'm.js'), 'function checkOrphan() {\n  return 2;\n}\n');
  const ndx = path.join(dir, '.ndx');
  const run = (...a) => spawnSync(process.execPath, [CE, ...a], { encoding: 'utf8', cwd: dir });
  it('builds the fixture index', () => { assert.equal(run('--build-index', src, '--index-path', ndx).status, 0); });

  it('--models-used lists all three models by default and, with --exclude-tests or --no-tests, only the one outside test, mock and demo code', () => {
    const plain = run('--ndx', ndx, '--models-used').stdout;
    for (const m of ['bert-base-uncased', 'gpt2-fixture-model', 't5-demo-model']) assert.match(plain, new RegExp(m), 'plain lists ' + m);
    for (const opt of ['--exclude-tests', '--no-tests']) {
      const out = run('--ndx', ndx, '--models-used', opt).stdout;
      assert.match(out, /bert-base-uncased/, opt);
      assert.doesNotMatch(out, /gpt2-fixture-model/, `${opt} leaves the record under mocks/ out`);
      assert.doesNotMatch(out, /t5-demo-model/, `${opt} still leaves the record under demos/ out`);
      // part E4 of test-options-remaining-commands: the one closing line, naming the option typed
      assert.equal(out.split(/\r?\n/).filter((l) => l.trim()).pop(), `Tip: 2 models of test, benchmark, mock and example code left out (${opt}); run without it to list them.`);
    }
  });

  it('--gaps: latest.js is not an entry point, so its uncalled function is listed; test code is not', () => {
    const out = run('--ndx', ndx, '--gaps').stdout;
    assert.match(out, /orphanHelper/, 'latest.js is not test code');
    assert.doesNotMatch(out, /checkOrphan/, 'a function under mocks/ is test code, which --gaps does not call suspicious (the old rule did not know mocks/)');
  });
});
