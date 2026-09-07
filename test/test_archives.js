// test_archives.js — --build-index archive expansion: ZIP/TAR/GZIP, zip-in-zip, encryption, `!` paths
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * test_archives.js - Tests for archive expansion in --build-index.
 *
 * Tests ZIP, TAR, GZIP (including .tar.gz), nested archives (zip-in-zip),
 * encrypted ZIP detection, and end-to-end build-index integration.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { execSync } from 'child_process';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_archives');
const INDEX_DIR = path.join(TEST_DIR, '.code_search_index');
const CLI = path.resolve('src/index.js');


// ========================================================================
// ZIP creation helpers (minimal valid ZIP files)
// ========================================================================

/**
 * Create a minimal ZIP file from an array of {name, content} entries.
 * Supports stored (method 0) and deflated (method 8) entries.
 * @param {Array<{name: string, content: string|Buffer, deflate?: boolean}>} entries
 * @returns {Buffer}
 */
function createZip(entries, { password = false } = {}) {
  const centralDir = [];
  const localHeaders = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf-8');
    const contentBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf-8');

    let compressedData;
    let method;

    if (entry.deflate !== false && contentBuf.length > 0) {
      // Deflate
      compressedData = zlib.deflateRawSync(contentBuf);
      method = 8;
    } else {
      compressedData = contentBuf;
      method = 0;
    }

    const gpFlag = password ? 0x0001 : 0x0000;  // bit 0 = encrypted

    // Local file header (30 + nameLen + data)
    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0);        // signature
    localHeader.writeUInt16LE(20, 4);                 // version needed
    localHeader.writeUInt16LE(gpFlag, 6);             // general purpose flag
    localHeader.writeUInt16LE(method, 8);             // compression method
    localHeader.writeUInt16LE(0, 10);                 // mod time
    localHeader.writeUInt16LE(0, 12);                 // mod date
    localHeader.writeUInt32LE(0, 14);                 // CRC-32 (simplified)
    localHeader.writeUInt32LE(compressedData.length, 18);  // compressed size
    localHeader.writeUInt32LE(contentBuf.length, 22);      // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);       // file name length
    localHeader.writeUInt16LE(0, 28);                      // extra field length
    nameBytes.copy(localHeader, 30);

    const localEntry = Buffer.concat([localHeader, compressedData]);
    const thisOffset = localOffset;
    localHeaders.push(localEntry);
    localOffset += localEntry.length;

    // Central directory entry (46 + nameLen)
    const cdEntry = Buffer.alloc(46 + nameBytes.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);            // signature
    cdEntry.writeUInt16LE(20, 4);                     // version made by
    cdEntry.writeUInt16LE(20, 6);                     // version needed
    cdEntry.writeUInt16LE(gpFlag, 8);                 // general purpose flag
    cdEntry.writeUInt16LE(method, 10);                // compression method
    cdEntry.writeUInt16LE(0, 12);                     // mod time
    cdEntry.writeUInt16LE(0, 14);                     // mod date
    cdEntry.writeUInt32LE(0, 16);                     // CRC-32
    cdEntry.writeUInt32LE(compressedData.length, 20); // compressed size
    cdEntry.writeUInt32LE(contentBuf.length, 24);     // uncompressed size
    cdEntry.writeUInt16LE(nameBytes.length, 28);      // file name length
    cdEntry.writeUInt16LE(0, 30);                     // extra field length
    cdEntry.writeUInt16LE(0, 32);                     // file comment length
    cdEntry.writeUInt16LE(0, 34);                     // disk number start
    cdEntry.writeUInt16LE(0, 36);                     // internal file attribs
    cdEntry.writeUInt32LE(0, 38);                     // external file attribs
    cdEntry.writeUInt32LE(thisOffset, 42);            // local header offset
    nameBytes.copy(cdEntry, 46);

    centralDir.push(cdEntry);
  }

  // EOCD record
  const cdBuf = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);              // signature
  eocd.writeUInt16LE(0, 4);                        // disk number
  eocd.writeUInt16LE(0, 6);                        // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);           // entries on this disk
  eocd.writeUInt16LE(entries.length, 10);          // total entries
  eocd.writeUInt32LE(cdBuf.length, 12);            // central dir size
  eocd.writeUInt32LE(localOffset, 16);             // central dir offset
  eocd.writeUInt16LE(0, 20);                       // comment length

  return Buffer.concat([...localHeaders, cdBuf, eocd]);
}


/**
 * Create a minimal TAR file from entries.
 * @param {Array<{name: string, content: string|Buffer}>} entries
 * @returns {Buffer}
 */
function createTar(entries) {
  const blocks = [];

  for (const entry of entries) {
    const contentBuf = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content, 'utf-8');

    // Header block (512 bytes)
    const header = Buffer.alloc(512);

    // Name (100 bytes)
    const nameBuf = Buffer.from(entry.name, 'utf-8');
    nameBuf.copy(header, 0, 0, Math.min(nameBuf.length, 100));

    // Mode (8 bytes, octal)
    Buffer.from('0000644\0', 'ascii').copy(header, 100);

    // UID/GID (8+8 bytes)
    Buffer.from('0001000\0', 'ascii').copy(header, 108);
    Buffer.from('0001000\0', 'ascii').copy(header, 116);

    // Size (12 bytes, octal)
    const sizeStr = contentBuf.length.toString(8).padStart(11, '0') + '\0';
    Buffer.from(sizeStr, 'ascii').copy(header, 124);

    // Mtime (12 bytes)
    const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
    Buffer.from(mtime, 'ascii').copy(header, 136);

    // Type flag: '0' = regular file
    header[156] = 48; // ASCII '0'

    // USTAR magic
    Buffer.from('ustar\0', 'ascii').copy(header, 257);
    Buffer.from('00', 'ascii').copy(header, 263);

    // Checksum (8 bytes at offset 148) - first fill with spaces
    Buffer.from('        ', 'ascii').copy(header, 148);
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i];
    const checksumStr = checksum.toString(8).padStart(6, '0') + '\0 ';
    Buffer.from(checksumStr, 'ascii').copy(header, 148);

    blocks.push(header);
    blocks.push(contentBuf);

    // Pad to 512-byte boundary
    const remainder = contentBuf.length % 512;
    if (remainder > 0) {
      blocks.push(Buffer.alloc(512 - remainder));
    }
  }

  // Two zero blocks to end
  blocks.push(Buffer.alloc(1024));

  return Buffer.concat(blocks);
}


// ========================================================================
// Helper to run CLI and interactive commands
// ========================================================================

function runCLI(args, opts = {}) {
  const cmd = `node ${CLI} ${args}`;
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: TEST_DIR,
      ...opts,
    });
  } catch (e) {
    return e.stdout || e.stderr || '';
  }
}

function runInteractive(commands, extraArgs = '') {
  const cmdFile = path.join(TEST_DIR, '_cmds.txt');
  fs.writeFileSync(cmdFile, commands.join('\n') + '\n/quit\n');
  const cmd = `node ${CLI} --interactive --index-path ${INDEX_DIR} ${extraArgs} < ${cmdFile}`;
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 30000,
      cwd: TEST_DIR,
    });
  } catch (e) {
    return e.stdout || '';
  }
}


// ========================================================================
// Tests
// ========================================================================

describe('Archive Support', () => {

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });


  // ------ Unit tests for archive reading ------

  describe('ZIP reading', () => {
    it('should expand a simple ZIP with source files', () => {
      const SRC_DIR = path.join(TEST_DIR, 'zip_simple');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      // Create a zip containing Python files
      const zipBuf = createZip([
        { name: 'src/main.py', content: 'def main():\n    print("hello")\n' },
        { name: 'src/utils.py', content: 'def helper(x):\n    return x + 1\n' },
        { name: 'README.md', content: '# My Project\nA test project.\n' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'project.zip'), zipBuf);

      // Also a plain source file alongside
      fs.writeFileSync(path.join(SRC_DIR, 'standalone.py'),
        'def standalone():\n    pass\n');

      const idxDir = path.join(TEST_DIR, '.idx_zip_simple');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Should mention archive expansion
      assert.ok(out.includes('archive') || out.includes('Archive') || out.includes('ZIP'),
        'should mention archive expansion: ' + out);

      // Search for content from inside the zip
      const searchOut = runCLI(`--fast "hello" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('project.zip!') || searchOut.includes('main.py'),
        'should find content from inside zip: ' + searchOut);

      // The path should contain the ! delimiter
      assert.ok(searchOut.includes('!'), 'paths should use ! delimiter: ' + searchOut);
    });

    it('should detect and warn about encrypted ZIP entries', () => {
      const SRC_DIR = path.join(TEST_DIR, 'zip_encrypted');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        { name: 'public.py', content: 'def public():\n    pass\n' },
        { name: 'secret.py', content: 'def secret():\n    pass\n' },
      ], { password: true });
      fs.writeFileSync(path.join(SRC_DIR, 'encrypted.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_zip_encrypted');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Should warn about encrypted entries
      assert.ok(out.toLowerCase().includes('encrypted') || out.toLowerCase().includes('password'),
        'should warn about encrypted entries: ' + out);
    });

    it('should expand JAR files (ZIP format)', () => {
      const SRC_DIR = path.join(TEST_DIR, 'jar_test');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const jarBuf = createZip([
        {
          name: 'com/example/App.java',
          content: 'package com.example;\npublic class App {\n  public static void main(String[] args) {\n    System.out.println("hello");\n  }\n}\n',
        },
        {
          name: 'com/example/Utils.java',
          content: 'package com.example;\npublic class Utils {\n  public static int add(int a, int b) {\n    return a + b;\n  }\n}\n',
        },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'app.jar'), jarBuf);

      const idxDir = path.join(TEST_DIR, '.idx_jar');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Search for Java class inside the jar
      const searchOut = runCLI(`--fast "Utils" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('app.jar!') && searchOut.includes('Utils'),
        'should find Java class inside JAR: ' + searchOut);
    });

    it('should handle stored (uncompressed) ZIP entries', () => {
      const SRC_DIR = path.join(TEST_DIR, 'zip_stored');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        { name: 'stored.py', content: 'x = 42\n', deflate: false },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'stored.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_stored');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const out = runCLI(`--fast "42" --index-path ${idxDir} 2>&1`);
      assert.ok(out.includes('stored.zip!') && out.includes('stored.py'),
        'should index stored ZIP entries: ' + out);
    });
  });


  describe('TAR reading', () => {
    it('should expand a plain TAR file', () => {
      const SRC_DIR = path.join(TEST_DIR, 'tar_plain');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const tarBuf = createTar([
        { name: 'lib/core.py', content: 'def core_func():\n    return "core"\n' },
        { name: 'lib/helpers.py', content: 'def help_func():\n    return "help"\n' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'library.tar'), tarBuf);

      const idxDir = path.join(TEST_DIR, '.idx_tar');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const searchOut = runCLI(`--fast "core_func" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('library.tar!') && searchOut.includes('core'),
        'should find content from TAR: ' + searchOut);
    });
  });


  describe('GZIP / TAR.GZ reading', () => {
    it('should expand a .tar.gz file', () => {
      const SRC_DIR = path.join(TEST_DIR, 'targz');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const tarBuf = createTar([
        { name: 'app/server.py', content: 'class Server:\n    def start(self):\n        print("serving")\n' },
        { name: 'app/client.py', content: 'class Client:\n    def connect(self):\n        print("connecting")\n' },
      ]);
      const gzBuf = zlib.gzipSync(tarBuf);
      fs.writeFileSync(path.join(SRC_DIR, 'app.tar.gz'), gzBuf);

      const idxDir = path.join(TEST_DIR, '.idx_targz');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const searchOut = runCLI(`--fast "Server" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('app.tar.gz!') && searchOut.includes('server'),
        'should find content from .tar.gz: ' + searchOut);
    });

    it('should expand a .tgz file', () => {
      const SRC_DIR = path.join(TEST_DIR, 'tgz');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const tarBuf = createTar([
        { name: 'mod.js', content: 'function tgzFunc() { return 42; }\n' },
      ]);
      const gzBuf = zlib.gzipSync(tarBuf);
      fs.writeFileSync(path.join(SRC_DIR, 'module.tgz'), gzBuf);

      const idxDir = path.join(TEST_DIR, '.idx_tgz');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const searchOut = runCLI(`--fast "tgzFunc" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('module.tgz!'),
        'should find content from .tgz: ' + searchOut);
    });

    it('should handle a single gzipped source file (.py.gz)', () => {
      const SRC_DIR = path.join(TEST_DIR, 'gz_single');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const content = 'def gzipped_func():\n    return "from gz"\n';
      const gzBuf = zlib.gzipSync(Buffer.from(content, 'utf-8'));
      fs.writeFileSync(path.join(SRC_DIR, 'single.py.gz'), gzBuf);

      const idxDir = path.join(TEST_DIR, '.idx_gz_single');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const searchOut = runCLI(`--fast "gzipped_func" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('gzipped_func'),
        'should find content from single .gz: ' + searchOut);
    });
  });


  describe('Nested archives (zip-in-zip)', () => {
    it('should expand nested ZIP inside ZIP', () => {
      const SRC_DIR = path.join(TEST_DIR, 'nested_zip');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      // Inner zip
      const innerZip = createZip([
        { name: 'deep/module.py', content: 'def deep_nested():\n    return "deep"\n' },
      ]);

      // Outer zip containing the inner zip and a regular file
      const outerZip = createZip([
        { name: 'top_level.py', content: 'def top_level():\n    pass\n' },
        { name: 'libs/inner.zip', content: innerZip },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'outer.zip'), outerZip);

      const idxDir = path.join(TEST_DIR, '.idx_nested');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Should find content from top level of outer zip
      const topOut = runCLI(`--fast "top_level" --index-path ${idxDir} 2>&1`);
      assert.ok(topOut.includes('outer.zip!'),
        'should index files from outer zip: ' + topOut);

      // Should find content from nested zip (double ! delimiter)
      const deepOut = runCLI(`--fast "deep_nested" --index-path ${idxDir} 2>&1`);
      assert.ok(deepOut.includes('outer.zip!') && deepOut.includes('inner.zip!'),
        'should index files from nested zip with chained ! delimiters: ' + deepOut);
    });

    it('should expand JAR inside ZIP', () => {
      const SRC_DIR = path.join(TEST_DIR, 'jar_in_zip');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const jarBuf = createZip([
        { name: 'com/lib/Service.java', content: 'package com.lib;\npublic class Service {\n  public void run() {}\n}\n' },
      ]);

      const zipBuf = createZip([
        { name: 'dependencies/lib.jar', content: jarBuf },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'project.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_jar_in_zip');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const out = runCLI(`--fast "Service" --index-path ${idxDir} 2>&1`);
      assert.ok(out.includes('project.zip!') && out.includes('lib.jar!'),
        'should find Java class inside JAR inside ZIP: ' + out);
    });

    it('should handle tar.gz inside a zip', () => {
      const SRC_DIR = path.join(TEST_DIR, 'targz_in_zip');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const tarBuf = createTar([
        { name: 'inner_src/engine.py', content: 'class Engine:\n    def run(self):\n        pass\n' },
      ]);
      const tgzBuf = zlib.gzipSync(tarBuf);

      // `bundled/`, not `vendor/`: vendor is a skipped directory (SKIP_DIRS),
      // inside archives as on disk since index-skip-pycache-twins.
      const zipBuf = createZip([
        { name: 'bundled/engine.tar.gz', content: tgzBuf },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'bundle.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_targz_in_zip');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const out = runCLI(`--fast "Engine" --index-path ${idxDir} 2>&1`);
      assert.ok(out.includes('bundle.zip!') && out.includes('engine.tar.gz!'),
        'should find content from tar.gz inside zip: ' + out);
    });
  });


  describe('Path handling', () => {
    it('should show archive paths with ! delimiter in search results', () => {
      const SRC_DIR = path.join(TEST_DIR, 'path_test');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        { name: 'src/feature/handler.py', content: 'def handle_request():\n    return "ok"\n' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'webapp.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_path');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const out = runCLI(`--fast "handle_request" --index-path ${idxDir} 2>&1`);
      // Path should be: webapp.zip!src/feature/handler.py
      assert.ok(out.includes('webapp.zip!src/feature/handler.py'),
        'path should include archive name with ! delimiter: ' + out);
    });

    it('should find archive content via path search', () => {
      const SRC_DIR = path.join(TEST_DIR, 'path_search');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        { name: 'com/important/SmokingGun.java', content: 'class SmokingGun { void fire() {} }\n' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'evidence.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_path_search');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Search for files matching a path pattern — should find inside the zip
      const out = runCLI(`--files-search "SmokingGun" --index-path ${idxDir} 2>&1`);
      assert.ok(out.includes('evidence.zip!') && out.includes('SmokingGun'),
        'should find archive entries via path search: ' + out);
    });
  });


  describe('Mixed source + archives', () => {
    it('should index both regular files and archive contents', () => {
      const SRC_DIR = path.join(TEST_DIR, 'mixed');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      // Regular source files
      fs.writeFileSync(path.join(SRC_DIR, 'main.py'),
        'def main():\n    print("from disk")\n');

      // Archive
      const zipBuf = createZip([
        { name: 'lib.py', content: 'def from_zip():\n    print("from archive")\n' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'libs.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_mixed');
      const buildOut = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Both should be indexed
      const diskOut = runCLI(`--fast "from disk" --index-path ${idxDir} 2>&1`);
      assert.ok(diskOut.includes('main.py'), 'should find disk file: ' + diskOut);

      const archiveOut = runCLI(`--fast "from archive" --index-path ${idxDir} 2>&1`);
      assert.ok(archiveOut.includes('libs.zip!'), 'should find archive file: ' + archiveOut);
    });

    it('should apply SHA1 dedup across disk and archive files', () => {
      const SRC_DIR = path.join(TEST_DIR, 'dedup_mixed');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const identicalContent = 'def identical():\n    return 42\n';

      // On disk
      fs.writeFileSync(path.join(SRC_DIR, 'on_disk.py'), identicalContent);

      // Same content in a zip
      const zipBuf = createZip([
        { name: 'in_zip.py', content: identicalContent },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'dupe.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_dedup_mixed');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Should note dedup
      assert.ok(out.includes('dedup') || out.includes('duplicate'),
        'should detect duplicates across disk/archive: ' + out);
    });
  });


  describe('Function detection in archive contents', () => {
    it('should detect functions from files inside archives', () => {
      const SRC_DIR = path.join(TEST_DIR, 'funcs_archive');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        {
          name: 'app/controller.py',
          content: [
            'class UserController:',
            '    def list_users(self):',
            '        users = db.query("SELECT * FROM users")',
            '        return users',
            '',
            '    def create_user(self, name):',
            '        db.execute("INSERT INTO users VALUES (?)", name)',
            '        return True',
            '',
          ].join('\n'),
        },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'backend.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_funcs');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Should detect functions
      const funcsOut = runCLI(`--list-functions --index-path ${idxDir} 2>&1`);
      assert.ok(funcsOut.includes('list_users') && funcsOut.includes('create_user'),
        'should detect functions in archive files: ' + funcsOut);

      // Should detect class
      const classOut = runCLI(`--list-classes --index-path ${idxDir} 2>&1`);
      assert.ok(classOut.includes('UserController'),
        'should detect classes in archive files: ' + classOut);
    });

    it('should support --extract for functions from archive', () => {
      const SRC_DIR = path.join(TEST_DIR, 'extract_archive');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        {
          name: 'math_utils.py',
          content: 'def fibonacci(n):\n    if n <= 1:\n        return n\n    return fibonacci(n-1) + fibonacci(n-2)\n',
        },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'math.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_extract');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const out = runCLI(`--extract "fibonacci" --index-path ${idxDir} 2>&1`);
      assert.ok(out.includes('fibonacci') && out.includes('return'),
        'should extract function from archive file: ' + out);
    });
  });


  describe('Non-source files in archives', () => {
    it('should skip binary/media files inside archives', () => {
      const SRC_DIR = path.join(TEST_DIR, 'skip_binary');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        { name: 'code.py', content: 'x = 1\n' },
        { name: 'image.png', content: 'FAKE PNG DATA' },
        { name: 'data.bin', content: 'FAKE BINARY' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'mixed.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_skip_binary');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const statsOut = runCLI(`--stats --index-path ${idxDir} 2>&1`);
      // Should have indexed only code.py, not image.png or data.bin
      assert.ok(statsOut.includes('1 file') || statsOut.match(/\b1\b.*file/i),
        'should only index source files from archive: ' + statsOut);
    });
  });


  describe('Edge cases', () => {
    it('should handle empty ZIP gracefully', () => {
      const SRC_DIR = path.join(TEST_DIR, 'empty_zip');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([]);
      fs.writeFileSync(path.join(SRC_DIR, 'empty.zip'), zipBuf);

      // Should not crash
      const idxDir = path.join(TEST_DIR, '.idx_empty');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);
      assert.ok(!out.includes('Error') && !out.includes('FATAL'),
        'should handle empty zip without error: ' + out);
    });

    it('should handle corrupt/truncated ZIP gracefully', () => {
      const SRC_DIR = path.join(TEST_DIR, 'corrupt_zip');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      // Write garbage that starts with PK but is truncated
      const corrupt = Buffer.from('PK\x03\x04this is not really a zip file');
      fs.writeFileSync(path.join(SRC_DIR, 'corrupt.zip'), corrupt);
      fs.writeFileSync(path.join(SRC_DIR, 'good.py'), 'x = 1\n');

      const idxDir = path.join(TEST_DIR, '.idx_corrupt');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // Should still index the good file
      const searchOut = runCLI(`--fast "x = 1" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('good.py'), 'should still index good files: ' + searchOut);
    });

    it('should handle ZIP entries with no content', () => {
      const SRC_DIR = path.join(TEST_DIR, 'empty_entries');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        { name: 'empty.py', content: '', deflate: false },
        { name: 'real.py', content: 'y = 2\n' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'has_empty.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_empty_entries');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);
      assert.ok(!out.includes('FATAL'), 'should handle empty entries gracefully');
    });
  });


  describe('Interactive mode with archive-sourced files', () => {
    it('should search archive content in interactive mode', () => {
      const SRC_DIR = path.join(TEST_DIR, 'interactive_archive');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZip([
        { name: 'interactive_test.py', content: 'def interactive_target():\n    return "found_me"\n' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'interactive.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_interactive');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const out = runInteractive(['/fast interactive_target'], `--index-path ${idxDir}`);
      assert.ok(out.includes('interactive_target'),
        'should find archive content in interactive mode: ' + out);
    });
  });


  // index-skip-pycache-twins (2026-08-27): _walkDir never enters __pycache__ /
  // node_modules / ..., but archive members and @list inputs bypassed that rule,
  // so an archive-built index carried a bytecode dump beside every source
  // module. The same rule now applies on every input path; a .pyc OUTSIDE
  // __pycache__ still becomes a .op (compiled-only distributions).
  describe('Skipped directories inside archives and @list inputs', () => {
    // A pyc-shaped buffer with two printable runs binstrings will keep.
    const fakePyc = Buffer.concat([
      Buffer.from([0x61, 0x0d, 0x0d, 0x0a, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from('twin_marker_function\0other_marker_value\0', 'ascii'),
    ]);
    const fileKeys = (idxDir) => Object.keys(
      JSON.parse(fs.readFileSync(path.join(idxDir, 'function_index.json'), 'utf8')));

    it('skips __pycache__ and node_modules members of a zip but still disassembles a .pyc outside them', () => {
      const SRC_DIR = path.join(TEST_DIR, 'zip_pycache');
      fs.mkdirSync(SRC_DIR, { recursive: true });
      const zipBuf = createZip([
        { name: 'pkg/a.py', content: 'def twin_marker_function():\n    return 1\n' },
        { name: 'pkg/__pycache__/a.cpython-310.pyc', content: fakePyc },
        { name: 'pkg/b.pyc', content: fakePyc },
        { name: 'node_modules/dep/index.js', content: 'module.exports = 1;\n' },
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'project.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_zip_pycache');
      const out = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);
      assert.ok(/2 entries under skipped directories/.test(out),
        'archive summary names the skipped members: ' + out);

      const keys = fileKeys(idxDir);
      assert.ok(keys.some((k) => k.endsWith('project.zip!pkg/a.py')),
        'source member indexed: ' + keys.join(', '));
      assert.ok(!keys.some((k) => k.includes('__pycache__') || k.includes('node_modules')),
        'no member under a skipped directory is indexed: ' + keys.join(', '));
      assert.ok(keys.some((k) => k.endsWith('project.zip!pkg/b.pyc.op')),
        'a .pyc outside __pycache__ still yields its .op: ' + keys.join(', '));
    });

    it('applies the same rule to an @list input', () => {
      const SRC_DIR = path.join(TEST_DIR, 'list_pycache');
      fs.mkdirSync(path.join(SRC_DIR, 'pkg', '__pycache__'), { recursive: true });
      const src = path.join(SRC_DIR, 'pkg', 'a.py');
      const pyc = path.join(SRC_DIR, 'pkg', '__pycache__', 'a.cpython-310.pyc');
      fs.writeFileSync(src, 'def list_marker_function():\n    return 2\n');
      fs.writeFileSync(pyc, fakePyc);
      const listFile = path.join(SRC_DIR, 'files.txt');
      fs.writeFileSync(listFile, src + '\n' + pyc + '\n');

      const idxDir = path.join(TEST_DIR, '.idx_list_pycache');
      const out = runCLI(`--build-index @${listFile} --index-path ${idxDir} 2>&1`);
      assert.ok(/Skipped 1 file\(s\) under skipped directories/.test(out),
        'list build names the skipped file: ' + out);

      const keys = fileKeys(idxDir);
      assert.ok(keys.some((k) => k.endsWith('a.py')), 'listed source indexed: ' + keys.join(', '));
      assert.ok(!keys.some((k) => k.includes('__pycache__')),
        'listed __pycache__ file not indexed: ' + keys.join(', '));
    });
  });

});
