// test_help_flags.js — help discoverability: --gui/--port/--load-index in --help; --load-index synonym
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_help_flags.js - CLI help discoverability + --load-index synonym.
 *
 * Run: node --test test/test_help_flags.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
function run(...args) {
  return spawnSync(process.execPath, [ENTRY, ...args], { encoding: 'utf8', input: '' });
}

describe('help discoverability', () => {
  it('--help lists --gui, --port, and --load-index', () => {
    const r = run('--help');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--gui\b/);
    assert.match(r.stdout, /--port\b/);
    assert.match(r.stdout, /--load-index\b/);
  });

  it('--help gui (filtered) surfaces the GUI flag', () => {
    const r = run('--help', 'gui');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--gui\b/);
  });

  it('--help says how to STOP the GUI (closing the browser does not)', () => {
    // gui-load-index-memory-release: the only stop instruction used to be the
    // server console's "Press Ctrl+C to stop." — a user who closed the browser
    // tab to free memory found nothing freed.
    const r = run('--help', 'gui');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Ctrl-C in that terminal stops it/);
    assert.match(r.stdout, /closing the\s+browser tab leaves the server/);
  });

  it('--help lists --hof, --synonymize-with, --limit, --claims and --hof-out, and --help hof surfaces the self-test (hof-cli-command)', () => {
    const r = run('--help');
    assert.equal(r.status, 0);
    for (const flag of ['--hof', '--synonymize-with', '--hof-out', '--limit', '--claims']) assert.match(r.stdout, new RegExp(`^  ${flag.replace(/-/g, '\\-')}\\b`, 'm'), flag);
    assert.match(r.stdout, /huffing our own fumes/);
    assert.doesNotMatch(r.stdout, /scripts\/hof\.mjs/, 'the script is not the way any more');
    const h = run('--help', 'hof');
    assert.equal(h.status, 0);
    assert.match(h.stdout, /--hof\b/);
  });

  it('--load-index is a synonym for --index-path (bad path → No index found)', () => {
    const r = run('--load-index', 'definitely_not_here');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /No index found at "definitely_not_here"/);
  });

  it('--ndx is the short form of --index-path (bad path → No index found), and --help says so', () => {
    const r = run('--ndx', 'definitely_not_here');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /No index found at "definitely_not_here"/);
    const h = run('--help');
    assert.match(h.stdout, /--index-path <path>\s+Load an existing index \(short form: --ndx;/);
  });
});

describe('the embed options each have a help entry, and --embed-model list', () => {
  // A help ENTRY is a line that starts, two spaces in, with the flag: what a reader scanning the left margin sees.
  const entry = (out, flag) => out.split(/\r?\n/).some((l) => l.startsWith('  ' + flag + ' ') || l === '  ' + flag);

  it('--help embed shows --embed-model, --against and --no-prefix as entries, not only inside --embed-distance', () => {
    const r = run('--help', 'embed');
    assert.equal(r.status, 0);
    assert.ok(entry(r.stdout, '--embed-distance'), r.stdout.slice(0, 400));
    assert.ok(entry(r.stdout, '--embed-model'), 'no entry headed --embed-model');
    assert.match(r.stdout, /--embed-model list/);
  });
  it('--help has the entries for --against and --no-prefix', () => {
    const r = run('--help');
    assert.ok(entry(r.stdout, '--against'));
    assert.ok(entry(r.stdout, '--no-prefix'));
  });
  it('--function-text has an entry, shown under --help embed, that says it is off by default and what it costs', () => {
    const r = run('--help', 'embed');
    assert.ok(entry(r.stdout, '--function-text'), 'no entry headed --function-text');
    assert.match(r.stdout, /--function-text[\s\S]*Off by default/);
    assert.match(r.stdout, /--function-text[\s\S]*45,000 functions/);
  });
  it('--summary-top has an entry, shown under --help embed, and --embed-distance says what its rows are, that a first run reports, and that --filter adds a rank column', () => {
    const r = run('--help', 'embed');
    assert.ok(entry(r.stdout, '--summary-top'), 'no entry headed --summary-top');
    assert.match(r.stdout, /--summary-top <n>[\s\S]*nearest <n> entries per element[\s\S]*default 1/);
    // embed-distance-rows-show-mechanism-id (2026-11-21): the help names the id column and says --against rows have none.
    assert.match(r.stdout, /--embed-distance[\s\S]*Rows are\s+rank, cosine, the entry's mechanism id \(m12, as --mechanisms\s+shows it; no id for candidates given with --against\) and the\s+entry/);
    assert.match(run('--help', 'toc').stdout, /--toc \[filter\][\s\S]*number in this list, the mechanism's id \(m12, as\s+--mechanisms shows it\)/, '--toc says what the two things at the left of a row are');
    // show-function-text-option (2026-11-22): the listing of what is embedded per function has an entry, found under --help embed and by its own name.
    assert.ok(entry(r.stdout, '--show-function-text'), 'no entry headed --show-function-text under --help embed');
    assert.match(run('--help', 'show-function-text').stdout, /--show-function-text \[filter\][\s\S]*embed for each function, as embedded[\s\S]*No model\s+runs[\s\S]*id:m70 in its place lists the\s+functions of that mechanism[\s\S]*unless --include-tests/);
    assert.match(run('--help', 'text-has').stdout, /--text-has <text>[\s\S]*With --show-function-text: list only the functions whose\s+embedded text holds <text>/);
    assert.doesNotMatch(r.stdout, /rank, cosine, distance/, 'the old row shape is not described');
    assert.match(r.stdout, /--embed-distance[\s\S]*reports about once a\s+minute/);
    assert.match(r.stdout, /--filter <s> a column with the rank of the first entry/);
    assert.match(r.stdout, /--embed-distance[\s\S]*--no-prefix, --summary-top,/, '--embed-distance lists it among its own options');
  });
  it('--toward-code and --spec have entries, shown under --help embed, that say what the model is shown and what a rank under it does not show', () => {
    const r = run('--help', 'embed');
    assert.ok(entry(r.stdout, '--toward-code'), 'no entry headed --toward-code');
    assert.ok(entry(r.stdout, '--spec'), 'no entry headed --spec');
    assert.match(r.stdout, /--toward-code[\s\S]*restate[\s\S]*label[\s\S]*@file/);
    assert.match(r.stdout, /--toward-code[\s\S]*no source code/);
    assert.match(r.stdout, /--toward-code[\s\S]*not a reading of the\s+claim/);
    assert.match(r.stdout, /--toward-code[\s\S]*Off by default/);
    assert.match(r.stdout, /--embed-distance[\s\S]*--function-text, --toward-code, --spec\./, '--embed-distance lists them among its own options');
  });
  // multisect-test-options-do-nothing (2026-11-19)
  it('--exclude-tests says which commands read it and what happens with one that does not; --no-tests says it is the same', () => {
    const r = run('--help', 'exclude-tests');
    assert.ok(entry(r.stdout, '--exclude-tests'));
    assert.ok(entry(r.stdout, '--no-tests'));
    assert.match(r.stdout, /--exclude-tests[\s\S]*--multisect-search[\s\S]*Off by default/);
    assert.match(r.stdout, /a line on\s+stderr says it did nothing/);
    assert.match(r.stdout, /--no-tests\s+The same as --exclude-tests/);
    assert.doesNotMatch(r.stdout, /from callers\/metrics results/, 'the old entry named two commands, one of which never read it');
  });
  it('the --embeddings line says it is about the examined code, and points at --embed-model list', () => {
    const r = run('--help', 'embeddings');
    const line = r.stdout.split(/\r?\n/).findIndex((l) => l.startsWith('  --embeddings '));
    assert.ok(line >= 0);
    assert.match(r.stdout.split(/\r?\n/).slice(line, line + 4).join(' '), /examined code[\s\S]*--embed-model list/);
  });
  it('--embed-model list names every known model, needs no index, and marks the default', () => {
    const r = run('--embed-model', 'list');
    assert.equal(r.status, 0, r.stderr);
    for (const name of ['nomic', 'jina', 'coderank', 'qwen06', 'qwen4']) assert.match(r.stdout, new RegExp('^\\s*' + name + '\\b', 'm'), name);
    assert.match(r.stdout, /nomic\s.*\(default\)/);
    assert.match(r.stdout, /installed|not installed/);
    assert.doesNotMatch(r.stdout + r.stderr, /No index found/);
  });
});
