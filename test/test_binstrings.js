/**
 * test_binstrings.js - Tests for binary string extraction (binstrings).
 *
 * Tests string extraction, noise filtering, .op generation, and integration
 * with --build-index for both disk executables and executables inside archives.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { execSync } from 'child_process';

// Direct imports for unit tests
import {
  extractStrings, isNoise, classifyString,
  extractMangledNames, makeFuncName, processBinary, isPseudoSource,
} from '../src/binstrings.js';

// op-pseudo-source-kind-gate: the one predicate for "CE-generated pseudo-source".
describe('isPseudoSource', () => {
  it('is true for a binstrings .op dump, in a tree or inside an archive', () => {
    assert.equal(isPseudoSource('pkg/__pycache__/a.cpython-310.pyc.op'), true);
    assert.equal(isPseudoSource('project.zip!lib/native.dll.op'), true);
    assert.equal(isPseudoSource('C:\\idx\\bin\\tool.exe.OP'), true, 'case-insensitive');
  });
  it('is false for source, for a binary itself, and for empty input', () => {
    assert.equal(isPseudoSource('pkg/a.py'), false);
    assert.equal(isPseudoSource('lib/native.dll'), false);
    assert.equal(isPseudoSource('notes.op.md'), false, 'only a trailing .op');
    assert.equal(isPseudoSource(''), false);
    assert.equal(isPseudoSource(undefined), false);
  });
});

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_binstrings');
const CLI = path.resolve('src/index.js');


// ========================================================================
// Helper to create fake binaries with embedded strings
// ========================================================================

/**
 * Create a fake binary buffer with embedded ASCII strings in a sea of nulls.
 * @param {string[]} strings - Strings to embed
 * @param {number} [gapSize=16] - Bytes of nulls between strings
 * @returns {Buffer}
 */
function createFakeBinary(strings, gapSize = 16) {
  const parts = [];
  // Add a PE-like header (just some binary noise)
  parts.push(Buffer.from('MZ'));  // DOS header magic
  parts.push(Buffer.alloc(60));   // padding
  parts.push(Buffer.from('PE\0\0'));  // PE signature

  for (const s of strings) {
    parts.push(Buffer.alloc(gapSize));  // gap of nulls
    parts.push(Buffer.from(s, 'ascii'));
  }
  parts.push(Buffer.alloc(gapSize));
  return Buffer.concat(parts);
}

/**
 * Create a minimal ZIP containing a fake binary.
 */
function createZipWithBinary(binaryName, strings) {
  const binaryBuf = createFakeBinary(strings);

  // Minimal ZIP with stored entry (no compression for binary)
  const nameBytes = Buffer.from(binaryName, 'utf-8');

  // Local file header
  const localHeader = Buffer.alloc(30 + nameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);   // no compression
  localHeader.writeUInt16LE(0, 8);   // stored
  localHeader.writeUInt32LE(binaryBuf.length, 18);
  localHeader.writeUInt32LE(binaryBuf.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(localHeader, 30);

  const localOffset = 0;
  const localEntry = Buffer.concat([localHeader, binaryBuf]);

  // Central directory
  const cdEntry = Buffer.alloc(46 + nameBytes.length);
  cdEntry.writeUInt32LE(0x02014b50, 0);
  cdEntry.writeUInt16LE(20, 4);
  cdEntry.writeUInt16LE(20, 6);
  cdEntry.writeUInt16LE(0, 8);
  cdEntry.writeUInt16LE(0, 10);
  cdEntry.writeUInt32LE(binaryBuf.length, 20);
  cdEntry.writeUInt32LE(binaryBuf.length, 24);
  cdEntry.writeUInt16LE(nameBytes.length, 28);
  cdEntry.writeUInt32LE(localOffset, 42);
  nameBytes.copy(cdEntry, 46);

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdEntry.length, 12);
  eocd.writeUInt32LE(localEntry.length, 16);

  return Buffer.concat([localEntry, cdEntry, eocd]);
}

function runCLI(args) {
  const cmd = `node ${CLI} ${args}`;
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd: TEST_DIR });
  } catch (e) {
    return e.stdout || e.stderr || '';
  }
}


// ========================================================================
// Tests
// ========================================================================

describe('Binstrings', () => {

  before(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });


  // ------ Unit tests: string extraction ------

  describe('extractStrings', () => {
    it('should extract ASCII strings from binary data', () => {
      const buf = createFakeBinary([
        'SSL_CTX_new', 'EVP_DigestInit_ex', 'certificate verify failed'
      ]);
      const strings = extractStrings(buf);
      assert.ok(strings.includes('SSL_CTX_new'), 'should find SSL_CTX_new');
      assert.ok(strings.includes('EVP_DigestInit_ex'), 'should find EVP_DigestInit_ex');
      assert.ok(strings.includes('certificate verify failed'), 'should find string literal');
    });

    it('should respect minimum length', () => {
      const buf = createFakeBinary(['ab', 'abc', 'abcd', 'abcde']);
      const strings4 = extractStrings(buf, 4);
      assert.ok(!strings4.includes('ab'));
      assert.ok(!strings4.includes('abc'));
      assert.ok(strings4.includes('abcd'));
      assert.ok(strings4.includes('abcde'));

      const strings2 = extractStrings(buf, 2);
      assert.ok(strings2.includes('ab'));
    });

    it('should handle empty buffer', () => {
      const strings = extractStrings(Buffer.alloc(0));
      assert.deepStrictEqual(strings, []);
    });
  });


  // ------ Unit tests: noise filtering ------

  describe('isNoise', () => {
    it('should filter PE section names', () => {
      assert.ok(isNoise('.text'));
      assert.ok(isNoise('.rdata'));
      assert.ok(isNoise('.reloc'));
    });

    it('should filter pure hex strings', () => {
      assert.ok(isNoise('DEADBEEF'));
      assert.ok(isNoise('0123456789abcdef'));
    });

    it('should filter pure number strings', () => {
      assert.ok(isNoise('12345'));
      assert.ok(isNoise('1.2.3'));
    });

    it('should filter universal DLL noise', () => {
      assert.ok(isNoise('KERNEL32.dll'));
      assert.ok(isNoise('api-ms-win-crt-runtime-l1-1-0.dll'));
    });

    it('should keep meaningful strings', () => {
      assert.ok(!isNoise('SSL_CTX_new'));
      assert.ok(!isNoise('certificate verify failed'));
      assert.ok(!isNoise('PyObject_GetAttr'));
      assert.ok(!isNoise('std::string::append'));
    });

    it('should filter short strings', () => {
      assert.ok(isNoise('ab'));
      assert.ok(isNoise('XYZ'));
    });

    it('should filter repetitive strings', () => {
      assert.ok(isNoise('AAAAAAA'));
      assert.ok(isNoise('========'));
    });

    it('should filter api-ms-win substrings', () => {
      assert.ok(isNoise('api-ms-win-core-file-l1-2-0.dll'));
    });
  });


  // ------ Unit tests: string classification ------

  describe('classifyString', () => {
    it('should identify C identifiers', () => {
      assert.strictEqual(classifyString('SSL_CTX_new'), 'identifier');
      assert.strictEqual(classifyString('PyObject_GetAttr'), 'identifier');
      assert.strictEqual(classifyString('main'), 'identifier');
    });

    it('should identify namespaced C++ names', () => {
      assert.strictEqual(classifyString('std::string::append'), 'identifier');
    });

    it('should classify strings with spaces as string type', () => {
      assert.strictEqual(classifyString('certificate verify failed'), 'string');
      assert.strictEqual(classifyString('Hello World'), 'string');
    });
  });


  // ------ Unit tests: function name generation ------

  describe('makeFuncName', () => {
    it('should generate valid C identifiers', () => {
      assert.strictEqual(makeFuncName('mylib.dll'), 'mylib_dll');
      assert.strictEqual(makeFuncName('torch/_C.cp310-win_amd64.pyd'),
        'torch_C_cp310_win_amd64_pyd');
    });

    it('should prefix with bin_ if starts with non-letter', () => {
      assert.ok(makeFuncName('123.dll').startsWith('bin_'));
    });

    it('should handle paths with directory context', () => {
      const name = makeFuncName('lib/crypto/openssl.so');
      assert.ok(name.includes('crypto'));
      assert.ok(name.includes('openssl'));
    });
  });


  // ------ Unit tests: mangled name detection ------

  describe('extractMangledNames', () => {
    it('should find MSVC mangled names (starts with ?)', () => {
      const strings = ['?foo@@YAXXZ', 'normal_string', '?bar@@YA_NXZ'];
      const mangled = extractMangledNames(strings);
      assert.strictEqual(mangled.length, 2);
      assert.ok(mangled.includes('?foo@@YAXXZ'));
    });

    it('should find GCC mangled names (starts with _Z)', () => {
      const strings = ['_Z3foov', 'normal', '_Z3barv'];
      const mangled = extractMangledNames(strings);
      assert.strictEqual(mangled.length, 2);
    });

    it('should skip short names', () => {
      const strings = ['?a', '_Zb'];  // Too short
      const mangled = extractMangledNames(strings);
      assert.strictEqual(mangled.length, 0);
    });
  });


  // ------ Unit tests: processBinary ------

  describe('processBinary', () => {
    it('should generate .op content from a fake binary', () => {
      const buf = createFakeBinary([
        'SSL_CTX_new', 'EVP_DigestInit_ex',
        'certificate verify failed',
        'PyObject_GetAttr', 'very important string here',
      ]);

      const result = processBinary(buf, 'test/libcrypto.so');
      assert.ok(result, 'should return non-null for binary with strings');
      assert.ok(result.content.includes('void '), 'should have void function');
      assert.ok(result.content.includes('SSL_CTX_new();'), 'identifiers should be call-style');
      assert.ok(result.content.includes('"certificate verify failed"'),
        'string literals should be quoted');
      assert.ok(result.content.includes('// Size:'), 'should have size comment');
      assert.ok(result.content.includes('// Strings:'), 'should have strings count');
    });

    it('should return null for binary with no useful strings', () => {
      // Create a binary that only has noise strings
      const buf = createFakeBinary(['.text', '.data', '.rdata', 'AAAAAAA']);
      const result = processBinary(buf, 'noise.dll');
      assert.strictEqual(result, null);
    });

    it('should deduplicate strings', () => {
      const buf = createFakeBinary([
        'duplicate_func', 'other_func', 'duplicate_func', 'duplicate_func'
      ]);
      const result = processBinary(buf, 'test.dll');
      assert.ok(result);
      // Count occurrences of duplicate_func in the output
      const count = (result.content.match(/duplicate_func/g) || []).length;
      assert.strictEqual(count, 1, 'duplicates should be removed');
    });

    it('should report stats', () => {
      const buf = createFakeBinary([
        'real_func', 'another_func', '.text', 'AAAA', '12345'
      ]);
      const result = processBinary(buf, 'test.dll');
      assert.ok(result);
      assert.ok(result.stats.rawStrings > 0);
      assert.ok(result.stats.filteredStrings <= result.stats.rawStrings);
      assert.ok(result.stats.fileSize > 0);
    });
  });


  // ------ Integration: disk executables in --build-index ------

  describe('Disk executable indexing', () => {
    it('should process .dll files found during directory walk', () => {
      const SRC_DIR = path.join(TEST_DIR, 'disk_dll');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      // Create a fake DLL
      const dllBuf = createFakeBinary([
        'CreateRemoteThread', 'VirtualAllocEx',
        'WriteProcessMemory', 'OpenProcess',
        'injection toolkit version 2.0',
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'inject.dll'), dllBuf);

      // Also a regular source file
      fs.writeFileSync(path.join(SRC_DIR, 'main.py'),
        'def main():\n    import ctypes\n    ctypes.WinDLL("inject.dll")\n');

      const idxDir = path.join(TEST_DIR, '.idx_dll');
      const buildOut = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      assert.ok(buildOut.includes('executable') || buildOut.includes('binstrings'),
        'should mention executable/binstrings processing: ' + buildOut);

      // Search for strings from the DLL
      const searchOut = runCLI(`--fast "CreateRemoteThread" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('inject.dll.op'),
        'should find DLL strings via .op file: ' + searchOut);
    });

    it('should detect functions in .op pseudo-source', () => {
      const SRC_DIR = path.join(TEST_DIR, 'dll_funcs');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const dllBuf = createFakeBinary([
        'PyInit_mymodule', 'PyModule_Create',
        'PyArg_ParseTuple', 'python extension module',
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'mymodule.pyd'), dllBuf);

      const idxDir = path.join(TEST_DIR, '.idx_pyd');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      // The .op file should have a function that the parser detects
      const funcsOut = runCLI(`--list-functions --index-path ${idxDir} 2>&1`);
      assert.ok(funcsOut.includes('mymodule_pyd') || funcsOut.includes('mymodule'),
        'should detect function from .op file: ' + funcsOut);
    });
  });


  // ------ Integration: executables inside archives ------

  describe('Executables inside archives', () => {
    it('should process .dll inside a ZIP', () => {
      const SRC_DIR = path.join(TEST_DIR, 'zip_dll');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const zipBuf = createZipWithBinary('lib/crypto.dll', [
        'RSA_generate_key', 'AES_encrypt', 'SHA256_Init',
        'OpenSSL cryptography library',
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'crypto_bundle.zip'), zipBuf);

      const idxDir = path.join(TEST_DIR, '.idx_zip_dll');
      const buildOut = runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      assert.ok(buildOut.includes('binaries processed') || buildOut.includes('binstrings'),
        'should report binary processing: ' + buildOut);

      const searchOut = runCLI(`--fast "RSA_generate_key" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('crypto_bundle.zip!') && searchOut.includes('.op'),
        'should find DLL strings from inside ZIP: ' + searchOut);
    });

    it('should process .so inside a tar.gz', () => {
      const SRC_DIR = path.join(TEST_DIR, 'targz_so');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      // Create a fake .so in a tar
      const soBuf = createFakeBinary([
        'pthread_create', 'pthread_mutex_lock',
        'dlopen', 'dlsym', 'shared library loader',
      ]);

      // Build a tar with the .so
      const soName = 'lib/libthread.so';
      const nameBytes = Buffer.from(soName, 'utf-8');
      const header = Buffer.alloc(512);
      nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 100));
      Buffer.from('0000644\0', 'ascii').copy(header, 100);
      Buffer.from('0001000\0', 'ascii').copy(header, 108);
      Buffer.from('0001000\0', 'ascii').copy(header, 116);
      const sizeStr = soBuf.length.toString(8).padStart(11, '0') + '\0';
      Buffer.from(sizeStr, 'ascii').copy(header, 124);
      header[156] = 48;
      Buffer.from('ustar\0', 'ascii').copy(header, 257);
      Buffer.from('00', 'ascii').copy(header, 263);
      Buffer.from('        ', 'ascii').copy(header, 148);
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += header[i];
      Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ', 'ascii').copy(header, 148);

      const remainder = soBuf.length % 512;
      const padding = remainder > 0 ? Buffer.alloc(512 - remainder) : Buffer.alloc(0);
      const endBlocks = Buffer.alloc(1024);
      const tarBuf = Buffer.concat([header, soBuf, padding, endBlocks]);
      const gzBuf = zlib.gzipSync(tarBuf);

      fs.writeFileSync(path.join(SRC_DIR, 'libs.tar.gz'), gzBuf);

      const idxDir = path.join(TEST_DIR, '.idx_targz_so');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const searchOut = runCLI(`--fast "pthread_create" --index-path ${idxDir} 2>&1`);
      assert.ok(searchOut.includes('pthread_create'),
        'should find .so strings from inside tar.gz: ' + searchOut);
    });
  });


  // ------ Multisect with binstrings content ------

  describe('Multisect with binstrings', () => {
    it('should find binary strings via multisect-search', () => {
      const SRC_DIR = path.join(TEST_DIR, 'multisect_bin');
      fs.mkdirSync(SRC_DIR, { recursive: true });

      const dllBuf = createFakeBinary([
        'CreateFileW', 'ReadFile', 'WriteFile', 'CloseHandle',
        'Windows file I/O operations',
        'NtCreateSection', 'NtMapViewOfSection',
      ]);
      fs.writeFileSync(path.join(SRC_DIR, 'fileio.dll'), dllBuf);

      const idxDir = path.join(TEST_DIR, '.idx_multisect_bin');
      runCLI(`--build-index ${SRC_DIR} --index-path ${idxDir} 2>&1`);

      const out = runCLI(`--multisect-search "CreateFileW;ReadFile;WriteFile" --index-path ${idxDir} 2>&1`);
      assert.ok(out.includes('fileio.dll.op') || out.includes('FUNCTION') || out.includes('FILE'),
        'multisect should find terms across binstring content: ' + out);
    });
  });

});
