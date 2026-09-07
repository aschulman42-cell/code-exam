// test_phase6.js — Phase 6 REPL: welcome, search modes, /extract, /callers, redirection, shell escape
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_phase6.js - Tests for Phase 6: Interactive REPL mode.
 *
 * Tests the interactive mode by piping commands to stdin and checking
 * stdout output. Uses a small test index built in setup.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_phase6');
const INDEX_DIR = path.join(TEST_DIR, '.code_search_index');
const SRC_DIR = path.join(TEST_DIR, 'src');
const CLI = path.resolve('src/index.js');

/**
 * Run interactive mode with piped commands, return stdout.
 */
function runInteractive(commands, extraArgs = '') {
  const input = commands.join('\n') + '\n/quit\n';
  // Feed commands via stdin (the `input` option) and suppress stderr via
  // stdio[2]='ignore' instead of a shell `echo ... | ... 2>/dev/null`
  // pipeline — the latter's `/dev/null` resolves to a nonexistent
  // C:\dev\null on Windows and crashes the run. `input` + `stdio` is
  // cross-platform. extraArgs is split into argv tokens; CLI is passed as
  // an explicit arg so no shell quoting is involved.
  const cmd = `node ${CLI} --interactive --index-path ${INDEX_DIR} ${extraArgs}`;
  try {
    return execSync(cmd, {
      input,
      encoding: 'utf-8',
      timeout: 15000,
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (e) {
    // Interactive mode exits with close, which may throw
    return e.stdout || '';
  }
}

/**
 * The variant every test actually calls (runInteractive above has no
 * remaining call sites and an identical body).
 */
function runInteractiveFile(commands, extraArgs = '') {
  // Originally wrote commands to a temp file and shell-redirected stdin
  // (`< cmdFile`). The `input` option delivers the same bytes to the
  // child's stdin cross-platform, so the temp file and the `< ... 2>/dev/null`
  // redirect are both unnecessary.
  const input = commands.join('\n') + '\n/quit\n';
  const cmd = `node ${CLI} --interactive --index-path ${INDEX_DIR} ${extraArgs}`;
  try {
    return execSync(cmd, {
      input,
      encoding: 'utf-8',
      timeout: 15000,
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (e) {
    return e.stdout || '';
  }
}


describe('Phase 6: Interactive Mode', () => {

  before(() => {
    // Create test source files
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'utils.py'), [
      'def helper_function(x, y):',
      '    """A helpful utility."""',
      '    result = x + y',
      '    return result',
      '',
      'def compute_score(data):',
      '    total = sum(data)',
      '    avg = total / len(data)',
      '    score = avg * 100',
      '    return score',
      '',
      'class Config:',
      '    def load(self, path):',
      '        data = open(path).read()',
      '        return data',
    ].join('\n'));

    fs.writeFileSync(path.join(SRC_DIR, 'main.py'), [
      'from utils import helper_function, compute_score, Config',
      '',
      'class Application:',
      '    def run(self):',
      '        config = Config()',
      '        data = config.load("settings.json")',
      '        result = helper_function(1, 2)',
      '        score = compute_score([1, 2, 3])',
      '        return score',
      '',
      '    def cleanup(self):',
      '        print("cleanup done")',
      '',
      'def main():',
      '    app = Application()',
      '    app.run()',
      '    app.cleanup()',
      '',
      'def orphan_never_called():',
      '    """This function is never called anywhere."""',
      '    x = 1',
      '    y = 2',
      '    z = x + y',
      '    return z',
    ].join('\n'));

    fs.writeFileSync(path.join(SRC_DIR, 'processor.js'), [
      'class Processor {',
      '  process(items) {',
      '    return items.map(i => i * 2);',
      '  }',
      '  validate(item) {',
      '    return item > 0;',
      '  }',
      '}',
      '',
      'function runPipeline(data) {',
      '  const p = new Processor();',
      '  const valid = data.filter(d => p.validate(d));',
      '  return p.process(valid);',
      '}',
      '',
      'module.exports = { Processor, runPipeline };',
    ].join('\n'));

    // Build index. stdio[2]='ignore' suppresses stderr cross-platform
    // (replaces the Windows-hostile `2>/dev/null` shell redirect).
    execSync(`node ${CLI} --build-index ${SRC_DIR} --index-path ${INDEX_DIR}`, {
      encoding: 'utf-8',
      cwd: TEST_DIR,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });


  // ---- Basic REPL lifecycle ----

  it('should start and show welcome banner', () => {
    const out = runInteractiveFile([]);
    assert.ok(out.includes('Code Exam Interactive Mode'), 'should show banner');
    assert.ok(out.includes('files'), 'should show file count');
  });

  it('should show help', () => {
    const out = runInteractiveFile(['/help']);
    assert.ok(out.includes('SEARCH:'), 'help should include SEARCH section');
    assert.ok(out.includes('FUNCTIONS:'), 'help should include FUNCTIONS section');
    assert.ok(out.includes('METRICS'), 'help should include METRICS section');
    assert.ok(out.includes('/quit'), 'help should mention /quit');
  });

  it('should show and change settings', () => {
    const out = runInteractiveFile(['/set', '/set max 50', '/set']);
    assert.ok(out.includes('max-results'), 'should show max-results');
    assert.ok(out.includes('50'), 'should reflect changed max-results');
  });

  it('should handle unknown commands gracefully', () => {
    const out = runInteractiveFile(['/bogus-command']);
    assert.ok(out.includes('Unknown command'), 'should report unknown command');
  });


  // ---- Search commands ----

  it('should do hybrid search (bare query)', () => {
    const out = runInteractiveFile(['helper_function']);
    assert.ok(out.includes('helper_function'), 'should find by bare query');
  });

  it('should do /fast search', () => {
    const out = runInteractiveFile(['/fast compute_score']);
    assert.ok(out.includes('compute_score'), 'should find via /fast');
  });

  it('should do /literal search', () => {
    const out = runInteractiveFile(['/literal return result']);
    assert.ok(out.includes('return result'), 'should find literal text');
  });

  it('should do /regex search', () => {
    const out = runInteractiveFile(['/regex def \\w+']);
    assert.ok(out.includes('def '), 'should find regex matches');
  });


  // ---- Browse commands ----

  it('should show /stats', () => {
    const out = runInteractiveFile(['/stats']);
    assert.ok(out.includes('Literal index') || out.includes('files'), 'should show file stats');
    assert.ok(out.includes('Total lines') || out.includes('lines'), 'should show line stats');
  });

  it('should list /files', () => {
    const out = runInteractiveFile(['/files']);
    assert.ok(out.includes('3 files'), 'should show file count');
    assert.ok(out.includes('utils.py'), 'should list utils.py');
  });

  it('should list /files with filter', () => {
    const out = runInteractiveFile(['/files main']);
    assert.ok(out.includes('1 files'), 'should filter to 1 file');
    assert.ok(out.includes('main.py'), 'should show main.py');
  });

  it('should list /functions', () => {
    const out = runInteractiveFile(['/funcs']);
    assert.ok(out.includes('functions'), 'should show function count');
    assert.ok(out.includes('helper_function'), 'should list helper_function');
  });

  it('should filter /functions with pattern', () => {
    const out = runInteractiveFile(['/funcs compute']);
    assert.ok(out.includes('compute_score'), 'should find compute_score');
  });

  it('should handle /functions PATH@NAME syntax', () => {
    const out = runInteractiveFile(['/funcs main@run']);
    assert.ok(out.includes('run'), 'should find run method');
    assert.ok(out.includes('main'), 'should be in main file');
  });

  it('should /extract a function', () => {
    const out = runInteractiveFile(['/extract helper_function']);
    assert.ok(out.includes('def helper_function'), 'should show function source');
    assert.ok(out.includes('return result'), 'should show function body');
  });


  // ---- Callers / callees ----

  it('should find /callers', () => {
    const out = runInteractiveFile(['/callers helper_function']);
    assert.ok(out.includes('helper_function'), 'should show caller info');
  });

  it('should find /callees', () => {
    const out = runInteractiveFile(['/callees main']);
    // main calls Application, run, cleanup
    assert.ok(out.includes('main') || out.includes('callees'), 'should show callee info');
  });


  // ---- Metrics ----

  it('should show /hotspots', () => {
    const out = runInteractiveFile(['/hotspots 10']);
    assert.ok(out.includes('Score') || out.includes('hotspots'), 'should show hotspot output');
  });

  it('should show /entry-points', () => {
    const out = runInteractiveFile(['/entry-points 10 max=2']);
    assert.ok(out.includes('entry') || out.includes('Lines'), 'should show entry points');
  });

  it('should show /classes', () => {
    const out = runInteractiveFile(['/classes']);
    assert.ok(out.includes('class'), 'should show class listing');
  });

  it('should show /gaps', () => {
    const out = runInteractiveFile(['/gaps']);
    const lower = out.toLowerCase();
    assert.ok(lower.includes('gap') || lower.includes('orphan') || lower.includes('no gaps'),
      'should show gap analysis');
  });


  // ---- Call graph ----

  it('should show /call-tree', () => {
    const out = runInteractiveFile(['/call-tree main']);
    assert.ok(out.includes('main'), 'should show call tree rooted at main');
  });

  it('should show /file-map', () => {
    const out = runInteractiveFile(['/file-map']);
    // file-map shows cross-file dependencies
    assert.ok(out !== '', 'should produce output');
  });


  // ---- Shell escape ----

  it('should execute shell commands with !', () => {
    const out = runInteractiveFile(['!echo SHELL_TEST_WORKS']);
    assert.ok(out.includes('SHELL_TEST_WORKS'), 'should show shell output');
  });


  // ---- /max shortcut ----

  it('should change max-results with /max', () => {
    const out = runInteractiveFile(['/max 5', '/set']);
    assert.ok(out.includes('max-results') && out.includes('5'), 'should reflect /max 5');
  });

  // ---- Toggle show-dupes ----

  it('should toggle /show-dupes', () => {
    const out = runInteractiveFile(['/show-dupes', '/set']);
    assert.ok(out.includes('show-dupes') && out.includes('ON'), 'should toggle on');
  });


  // ---- Output redirection ----

  it('should redirect output to file with >', () => {
    const outFile = path.join(TEST_DIR, 'redir_test.txt');
    // Clean up any previous run
    try { fs.unlinkSync(outFile); } catch (_) {}
    const out = runInteractiveFile([`/stats > ${outFile}`]);
    assert.ok(out.includes('written to'), 'should confirm redirect');
    assert.ok(fs.existsSync(outFile), 'output file should exist');
    const content = fs.readFileSync(outFile, 'utf-8');
    assert.ok(content.includes('files'), 'redirected output should contain stats');
  });

  it('should append output to file with >>', () => {
    const outFile = path.join(TEST_DIR, 'redir_append.txt');
    try { fs.unlinkSync(outFile); } catch (_) {}
    // First write
    runInteractiveFile([`/stats > ${outFile}`]);
    const before = fs.readFileSync(outFile, 'utf-8');
    // Append
    runInteractiveFile([`/stats >> ${outFile}`]);
    const after = fs.readFileSync(outFile, 'utf-8');
    assert.ok(after.length > before.length, 'appended file should be larger');
  });

  it('should redirect /classes output to file', () => {
    const outFile = path.join(TEST_DIR, 'redir_classes.txt');
    try { fs.unlinkSync(outFile); } catch (_) {}
    const out = runInteractiveFile([`/classes > ${outFile}`]);
    assert.ok(out.includes('written to'), 'should confirm redirect');
    assert.ok(fs.existsSync(outFile), 'output file should exist');
  });

  it('should redirect /hotspots output to file', () => {
    const outFile = path.join(TEST_DIR, 'redir_hotspots.txt');
    try { fs.unlinkSync(outFile); } catch (_) {}
    const out = runInteractiveFile([`/hotspots 5 > ${outFile}`]);
    assert.ok(out.includes('written to'), 'should confirm redirect');
    assert.ok(fs.existsSync(outFile), 'output file should exist');
    const content = fs.readFileSync(outFile, 'utf-8');
    assert.ok(content.length > 0, 'redirected output should not be empty');
  });

  // ---- Bug-fix tests for multisect dispatch ----

  it('should reject /multisect-search as unknown command', () => {
    const out = runInteractiveFile(['/multisect-search data;result']);
    assert.ok(out.includes('Unknown command'), '/multisect-search should be unknown');
  });

  it('should accept /multisect as valid command', () => {
    const out = runInteractiveFile(['/multisect data;result;score']);
    assert.ok(!out.includes('Unknown command'), '/multisect should not be unknown');
    assert.ok(out.includes('selectivity') || out.includes('intersection') || out.includes('term'),
      'should produce multisect output');
  });

  it('should accept /ms alias for multisect', () => {
    const out = runInteractiveFile(['/ms data;result']);
    assert.ok(!out.includes('Unknown command'), '/ms should not be unknown');
  });

  it('should strip surrounding quotes from search terms', () => {
    // Quotes should not appear in search results or errors
    const out = runInteractiveFile(['"data"']);
    // Should search for 'data' not '"data"' — should get results
    assert.ok(!out.includes('No results found') || out.includes('data'),
      'quoted search should find results for the unquoted term');
  });

  it('should strip surrounding quotes from multisect terms', () => {
    const out = runInteractiveFile(['/multisect "data;result;score"']);
    assert.ok(!out.includes('Unknown command'));
    // Should parse terms correctly without quote chars
    assert.ok(out.includes('selectivity') || out.includes('intersection') || out.includes('term'),
      'quoted multisect should produce output');
  });

  it('should strip quotes from multisect terms when --in follows quotes', () => {
    // This is the tricky case: "terms" --in pattern
    const out = runInteractiveFile(['/multisect "data;result" --in main']);
    assert.ok(!out.includes('Unknown command'));
    assert.ok(out.includes('selectivity') || out.includes('intersection') || out.includes('term') || out.includes('No matches'),
      'quoted multisect with --in should not fail silently');
    // The --in filter should be visible
    assert.ok(out.includes('--in') && out.includes('main'),
      'should show --in filter');
  });

  // ---- CLI --multisect-search should not drop into interactive ----

  it('should exit after CLI --multisect-search without entering interactive', () => {
    try {
      const out = execSync(
        `node ${CLI} --index-path ${INDEX_DIR} --multisect-search "data;result;score"`,
        { encoding: 'utf-8', timeout: 10000, cwd: TEST_DIR, input: '' }
      );
      // Should have produced output and exited (no "Interactive Mode" banner)
      assert.ok(!out.includes('Interactive Mode'),
        'CLI --multisect-search should not enter interactive mode');
    } catch (e) {
      const out = e.stdout || '';
      assert.ok(!out.includes('Interactive Mode'),
        'CLI --multisect-search should not enter interactive mode');
    }
  });

  // ---- --in filter display ----

  it('should display --in path filter in search output', () => {
    const out = runInteractiveFile(['result --in utils']);
    assert.ok(out.includes('--in') && out.includes('utils'),
      'should show the --in filter in output');
  });

  it('should display --in path filter in multisect output', () => {
    const out = runInteractiveFile(['/multisect data;result --in main']);
    assert.ok(out.includes('--in') && out.includes('main'),
      'should show the --in filter in multisect output');
  });

  it('should support /file [N] selection from previous match list', () => {
    // First search triggers a multi-match list, then select [1]
    const out = runInteractiveFile(['/file .py', '/file [1]']);
    // The first command should show "Multiple files match" with numbered list
    // The second command should show file contents (line numbers)
    assert.ok(out.includes('Multiple files') || out.includes('1:') || out.includes('lines'),
      'should either show match list or file contents from [N] selection');
  });

});
