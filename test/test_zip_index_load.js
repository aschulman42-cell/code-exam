// test_zip_index_load.js — #176 zipped-index loading: extractZipToDir over hand-built ZIPs, resolveIndexDir
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
// Coverage for zipped-index loading (#176): extractZipToDir + resolveIndexDir.
// No zip *writer* exists in the project, so we hand-build minimal ZIPs (stored
// + deflate members) in-memory to exercise the real central-directory parser.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { extractZipToDir, resolveIndexDir, cleanZipIndexCache, ZIP_INDEX_CACHE_ROOT } from '../src/archive.js';

// Build a ZIP from [{name, data:Buffer, deflate?:bool}]. CRC fields are left 0;
// the reader keys off central-directory sizes/offsets, not CRC.
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf-8');
    const method = f.deflate ? 8 : 0;
    const stored = f.deflate ? zlib.deflateRawSync(f.data) : f.data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(stored.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const localRec = Buffer.concat([lh, nameBuf, stored]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(stored.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    locals.push(localRec);
    offset += localRec.length;
  }
  const localBlob = Buffer.concat(locals);
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  return Buffer.concat([localBlob, centralBlob, eocd]);
}

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
const idxFiles = (extra = []) => [
  { name: 'literal_index.json', data: Buffer.from('{"a.js":["line"]}') },
  { name: 'inverted_index.json', data: Buffer.from('{"line":[["a.js",[1]]]}'), deflate: true },
  { name: 'function_index.json', data: Buffer.from('{}') },
  ...extra,
];

test('extractZipToDir writes stored + deflate members to disk', () => {
  const dir = tmp('cezip-x-');
  const zip = path.join(dir, 'a.zip');
  fs.writeFileSync(zip, makeZip(idxFiles()));
  const out = path.join(dir, 'out');
  const { fileCount, encryptedCount } = extractZipToDir(zip, out);
  assert.equal(fileCount, 3);
  assert.equal(encryptedCount, 0);
  assert.equal(fs.readFileSync(path.join(out, 'literal_index.json'), 'utf-8'), '{"a.js":["line"]}');
  // deflate round-trips
  assert.equal(fs.readFileSync(path.join(out, 'inverted_index.json'), 'utf-8'), '{"line":[["a.js",[1]]]}');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('extractZipToDir rejects path traversal entries', () => {
  const dir = tmp('cezip-trav-');
  const zip = path.join(dir, 'evil.zip');
  fs.writeFileSync(zip, makeZip([{ name: '../escape.json', data: Buffer.from('x') }]));
  const out = path.join(dir, 'out');
  const { fileCount } = extractZipToDir(zip, out);
  assert.equal(fileCount, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'escape.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveIndexDir finds the index dir nested under a top folder', () => {
  const dir = tmp('cezip-r-');
  const zip = path.join(dir, 'sample.zip');
  // Mirror the real sample: files live under a top-level folder.
  fs.writeFileSync(zip, makeZip(idxFiles().map(f => ({ ...f, name: `.Sample/${f.name}` }))));
  const root = resolveIndexDir(zip);
  assert.equal(path.basename(root), '.Sample');
  assert.ok(fs.existsSync(path.join(root, 'literal_index.json')));
  // Second call hits the size+mtime cache and returns the same root.
  assert.equal(resolveIndexDir(zip), root);
  fs.rmSync(dir, { recursive: true, force: true });
});

// notebook-critique-small-fixes: the cache is an on-disk copy of the index that
// nothing removes by itself, so the extraction names it and a command clears it.
test('resolveIndexDir names the cache directory on stderr when it extracts', () => {
  const dir = tmp('cezip-msg-');
  const zip = path.join(dir, 'named.zip');
  fs.writeFileSync(zip, makeZip(idxFiles().map(f => ({ ...f, name: `.Named/${f.name}` }))));
  const lines = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  let root;
  try { root = resolveIndexDir(zip); } finally { process.stderr.write = orig; }
  const extracting = lines.find(l => l.startsWith('[zip-index] extracting'));
  assert.ok(extracting, 'an extraction line was written');
  assert.ok(extracting.includes(ZIP_INDEX_CACHE_ROOT), 'it names the cache root');
  assert.ok(extracting.includes('--clean-zip-cache'), 'and the way to clear it');
  assert.ok(root.startsWith(ZIP_INDEX_CACHE_ROOT));
  // Leave no entry of our own in the real cache (the suite's other zip tests
  // do, which is one reason the cache grows; --clean-zip-cache clears them).
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanZipIndexCache removes every cached extraction under the given root and reports the count', () => {
  const root = tmp('cezip-cache-');
  for (const k of ['a-1-1', 'b-2-2', 'c-3-3']) fs.mkdirSync(path.join(root, k, '.Idx'), { recursive: true });
  const r = cleanZipIndexCache(root);
  assert.deepEqual(r, { root, removed: 3, existed: true });
  assert.ok(!fs.existsSync(root));
});

test('cleanZipIndexCache on a missing root is a no-op that says so', () => {
  const root = path.join(os.tmpdir(), `cezip-none-${process.pid}-${Date.now()}`);
  assert.deepEqual(cleanZipIndexCache(root), { root, removed: 0, existed: false });
});

test('resolveIndexDir passes non-zip and missing paths through unchanged', () => {
  assert.equal(resolveIndexDir('.code_search_index'), '.code_search_index');
  assert.equal(resolveIndexDir('/no/such/index.zip'), '/no/such/index.zip');
  assert.equal(resolveIndexDir(null), null);
});

test('resolveIndexDir throws a clear error when the zip has no index', () => {
  const dir = tmp('cezip-bad-');
  const zip = path.join(dir, 'notanindex.zip');
  fs.writeFileSync(zip, makeZip([{ name: 'readme.txt', data: Buffer.from('hi') }]));
  assert.throws(() => resolveIndexDir(zip), /not a CodeExam index zip|no literal_index/i);
  fs.rmSync(dir, { recursive: true, force: true });
});
