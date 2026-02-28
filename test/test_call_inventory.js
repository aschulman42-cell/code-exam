/**
 * test_call_inventory.js - Tests for --call-inventory (Task 6).
 *
 * Verifies:
 *   - Single function: partitions callees into in-index vs external
 *   - All functions: codebase-wide bill of materials
 *   - Provenance labeling for known library families
 *   - Filter functionality
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const TEST_DIR = '/tmp/ce_test_call_inventory';
const CLI = path.resolve('src/index.js');

function runCLI(args) {
  const cmd = `node ${CLI} ${args}`;
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 30000, cwd: TEST_DIR });
  } catch (e) {
    return (e.stdout || '') + (e.stderr || '');
  }
}


// ========================================================================
// Setup: mixed Python + C++ codebase
// ========================================================================

const SRC_DIR = path.join(TEST_DIR, 'src');
const IDX_DIR = path.join(TEST_DIR, '.idx');

before(() => {
  fs.mkdirSync(SRC_DIR, { recursive: true });

  // Python file with class methods calling internal and external
  fs.writeFileSync(path.join(SRC_DIR, 'processor.py'), `
class Processor:
    def run(self):
        data = self.load()
        result = self.transform(data)
        self.save(result)
        print(f"Done: {len(result)} items")

    def load(self):
        with open("input.json", "r") as f:
            return json.load(f)

    def transform(self, data):
        return sorted(data)

    def save(self, data):
        with open("output.json", "w") as f:
            json.dump(data, f)
`);

  // C++ file calling OpenSSL and POSIX
  fs.writeFileSync(path.join(SRC_DIR, 'crypto.cpp'), `
void CryptoEngine::encrypt(const char* data, int len) {
    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    EVP_EncryptInit(ctx, EVP_aes_256_cbc(), key_, iv_);
    unsigned char* out = (unsigned char*)malloc(len + 16);
    int outlen;
    EVP_EncryptUpdate(ctx, out, &outlen, (unsigned char*)data, len);
    EVP_EncryptFinal(ctx, out + outlen, &outlen);
    EVP_CIPHER_CTX_free(ctx);
    free(out);
}

void CryptoEngine::hash(const char* data, int len) {
    unsigned char digest[32];
    SHA256_Init(&sha_ctx);
    SHA256_Update(&sha_ctx, data, len);
    SHA256_Final(digest, &sha_ctx);
    memcpy(result_, digest, 32);
}
`);

  // Another C++ file calling internal functions + Win32 API
  fs.writeFileSync(path.join(SRC_DIR, 'fileutil.cpp'), `
void FileManager::loadFile(const char* path) {
    HANDLE h = CreateFileA(path, GENERIC_READ, 0, NULL,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    DWORD size = GetFileSize(h, NULL);
    char* buf = (char*)malloc(size);
    ReadFile(h, buf, size, NULL, NULL);
    CloseHandle(h);
    parseContent(buf, size);
    free(buf);
}

void FileManager::parseContent(const char* buf, int len) {
    printf("Parsing %d bytes\\n", len);
    strlen(buf);
}
`);

  runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
});

after(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});


// ========================================================================
// Test: Single function inventory
// ========================================================================

describe('Call inventory: single function', () => {
  it('Processor.run should show both in-index and external calls', () => {
    const out = runCLI(`--call-inventory "Processor.run" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('IN INDEX'), 'should have IN INDEX section: ' + out);
    assert.ok(out.includes('EXTERNAL'), 'should have EXTERNAL section: ' + out);
    // load, transform, save are in index
    assert.ok(out.includes('load'), 'should show load as callee: ' + out);
    assert.ok(out.includes('transform'), 'should show transform: ' + out);
    assert.ok(out.includes('save'), 'should show save: ' + out);
    // print, len are external
    assert.ok(out.includes('print'), 'should show print as external: ' + out);
    assert.ok(out.includes('len'), 'should show len as external: ' + out);
  });

  it('CryptoEngine::encrypt should show C stdlib and OpenSSL externals', () => {
    const out = runCLI(`--call-inventory "CryptoEngine::encrypt" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('EXTERNAL'), 'should have EXTERNAL section: ' + out);
    assert.ok(out.includes('malloc'), 'should show malloc: ' + out);
    assert.ok(out.includes('C stdlib'), 'should label malloc as C stdlib: ' + out);
    assert.ok(out.includes('OpenSSL'), 'should label EVP functions as OpenSSL: ' + out);
  });

  it('FileManager::loadFile should show Win32 API labels', () => {
    const out = runCLI(`--call-inventory "FileManager::loadFile" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('Win32 API'), 'should label CreateFileA as Win32: ' + out);
    // parseContent is in-index (same file)
    assert.ok(out.includes('parseContent'), 'should show parseContent: ' + out);
    assert.ok(out.includes('IN INDEX'), 'should have in-index for parseContent: ' + out);
  });
});


// ========================================================================
// Test: All functions inventory
// ========================================================================

describe('Call inventory: all functions (codebase-wide)', () => {
  it('should scan all functions and show summary', () => {
    const out = runCLI(`--call-inventory --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('scanning ALL functions'), 'should say scanning all: ' + out);
    assert.ok(out.includes('functions scanned'), 'should show scan count: ' + out);
    assert.ok(out.includes('in index'), 'should count in-index: ' + out);
    assert.ok(out.includes('external'), 'should count external: ' + out);
  });

  it('should group external calls by provenance', () => {
    const out = runCLI(`--call-inventory --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('[OpenSSL]') || out.includes('OpenSSL'),
      'should show OpenSSL group: ' + out);
    assert.ok(out.includes('[C stdlib') || out.includes('C stdlib'),
      'should show C stdlib group: ' + out);
    assert.ok(out.includes('[Win32 API') || out.includes('Win32 API'),
      'should show Win32 API group: ' + out);
  });

  it('should show Unknown group for unrecognized externals', () => {
    const out = runCLI(`--call-inventory --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('[Unknown]') || out.includes('Unknown'),
      'should show Unknown group: ' + out);
  });

  it('--verbose should show detailed in-index listing', () => {
    const out = runCLI(`--call-inventory --verbose --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('IN INDEX'), 'verbose should show IN INDEX: ' + out);
  });
});


// ========================================================================
// Test: Filter
// ========================================================================

describe('Call inventory: --filter', () => {
  it('--filter "SSL" should show only SSL-related externals', () => {
    const out = runCLI(`--call-inventory --filter "SSL" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('EXTERNAL'), 'should have external section: ' + out);
    assert.ok(out.includes('SSL') || out.includes('OpenSSL'),
      'should show SSL entries: ' + out);
    // Should not show unrelated externals
    assert.ok(!out.includes('[Unknown]'),
      'should not show unknown group when filtered to SSL: ' + out);
  });

  it('--filter "malloc" should show C stdlib memory', () => {
    const out = runCLI(`--call-inventory --filter "malloc" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('malloc'), 'should show malloc: ' + out);
  });
});


// ========================================================================
// Test: Provenance labeling accuracy
// ========================================================================

describe('Call inventory: provenance labels', () => {
  const SRC2 = path.join(TEST_DIR, 'prov_test');
  const IDX2 = path.join(TEST_DIR, '.idx_prov');

  before(() => {
    fs.mkdirSync(SRC2, { recursive: true });

    // File with diverse library calls
    fs.writeFileSync(path.join(SRC2, 'diverse.cpp'), `
void test_all_libs() {
    // C stdlib
    char* p = malloc(100);
    memset(p, 0, 100);
    printf("hello %s\\n", p);
    int n = atoi("42");
    double s = sin(3.14);

    // POSIX
    int fd = open("file", O_RDONLY);
    read(fd, p, 100);
    close(fd);
    int sock = socket(AF_INET, SOCK_STREAM, 0);

    // pthreads
    pthread_create(&tid, NULL, worker, NULL);
    pthread_mutex_lock(&mtx);

    // Win32
    HANDLE h = CreateFileA("x", 0, 0, 0, 0, 0, 0);
    CloseHandle(h);
    WaitForSingleObject(h, INFINITE);
    HMODULE m = LoadLibraryA("foo.dll");

    // OpenSSL
    SSL_CTX_new(TLS_method());
    EVP_DigestInit(ctx, EVP_sha256());
    RAND_bytes(buf, 32);

    // SQLite
    sqlite3_open("db", &db);
    sqlite3_exec(db, "SELECT 1", NULL, NULL, NULL);

    // zlib
    compress(out, &outlen, in, inlen);
    deflate(&stream, Z_FINISH);

    free(p);
}
`);

    runCLI(`--build-index ${SRC2} --index-path ${IDX2} --skip-semantic 2>&1`);
  });

  it('should label C stdlib memory functions', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('C stdlib (memory)'), 'should label malloc/memset/free: ' + out);
  });

  it('should label C stdlib stdio functions', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('C stdlib (stdio)'), 'should label printf: ' + out);
  });

  it('should label C stdlib math functions', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('C stdlib (math)'), 'should label sin: ' + out);
  });

  it('should label POSIX functions', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('POSIX'), 'should label open/read/close: ' + out);
  });

  it('should label POSIX sockets', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('POSIX (sockets)'), 'should label socket: ' + out);
  });

  it('should label pthreads', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('pthreads'), 'should label pthread_create/mutex: ' + out);
  });

  it('should label Win32 API', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('Win32 API'), 'should label CreateFileA/CloseHandle: ' + out);
  });

  it('should label Win32 DLL functions', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('Win32 API (DLL)') || out.includes('Win32 API'),
      'should label LoadLibraryA: ' + out);
  });

  it('should label OpenSSL', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('OpenSSL'), 'should label SSL/EVP/RAND: ' + out);
  });

  it('should label SQLite', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('SQLite'), 'should label sqlite3_open/exec: ' + out);
  });

  it('should label zlib', () => {
    const out = runCLI(`--call-inventory "test_all_libs" --index-path ${IDX2} 2>&1`);
    assert.ok(out.includes('zlib'), 'should label compress/deflate: ' + out);
  });
});


// ========================================================================
// Test: In-index resolution
// ========================================================================

describe('Call inventory: in-index resolution', () => {
  it('FileManager::loadFile should resolve parseContent as in-index', () => {
    const out = runCLI(`--call-inventory "FileManager::loadFile" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('IN INDEX'), 'should have IN INDEX section: ' + out);
    assert.ok(out.includes('parseContent'), 'should resolve parseContent: ' + out);
  });

  it('Processor.run should resolve self.load/transform/save as in-index', () => {
    const out = runCLI(`--call-inventory "Processor.run" --index-path ${IDX_DIR} 2>&1`);
    const inSection = out.split('EXTERNAL')[0];
    assert.ok(inSection.includes('load'), 'load should be in-index: ' + inSection);
    assert.ok(inSection.includes('transform'), 'transform should be in-index: ' + inSection);
    assert.ok(inSection.includes('save'), 'save should be in-index: ' + inSection);
  });
});
