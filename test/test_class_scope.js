/**
 * test_class_scope.js - Tests for multisect class-level scope (Task 5).
 *
 * Verifies that multisect search groups methods by class, so terms
 * spread across different methods of the same class produce a class-level
 * match even when no single function contains all terms.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_class_scope');
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
// Test: Terms spread across methods of one Python class
// ========================================================================

describe('Class scope: terms across methods in Python class', () => {
  const SRC_DIR = path.join(TEST_DIR, 'py_class');
  const IDX_DIR = path.join(TEST_DIR, '.idx_py_class');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    // Term "cipher" is in encrypt_data(), term "deflate" is in compress_data(),
    // term "transmit" is in send(). No single method has all 3.
    // But the class SecureChannel has all 3.
    fs.writeFileSync(path.join(SRC_DIR, 'channel.py'), `
class SecureChannel:
    def encrypt_data(self, plaintext):
        # apply cipher to the plaintext with AES
        return aes_cipher(plaintext, self.key)

    def compress_data(self, data):
        # deflate using zlib before sending
        return zlib_deflate(data)

    def send(self, data):
        # transmit the processed data over the wire
        self.socket.transmit(data)

class Logger:
    def log(self, message):
        print(message)
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('multisect "cipher;deflate;transmit" should produce a CLASS-level match for SecureChannel', () => {
    const out = runCLI(`--multisect-search "cipher;deflate;transmit" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('CLASS-level'),
      'should have CLASS-level section: ' + out);
    assert.ok(out.includes('SecureChannel'),
      'should match SecureChannel: ' + out);
  });

  it('should NOT show function-level match for cipher;deflate;transmit (no single func has all 3)', () => {
    const out = runCLI(`--multisect-search "cipher;deflate;transmit" --index-path ${IDX_DIR} 2>&1`);
    // There should be no FUNCTION-level match with [3/3] — no single function has all terms
    const funcSection = out.split('CLASS-level')[0];  // text before CLASS section
    if (funcSection.includes('FUNCTION-level')) {
      // If there's a function match, it should be [1/3] or [2/3], not [3/3]
      assert.ok(!funcSection.includes('[3/3]'),
        'no single function should match all 3 terms: ' + funcSection);
    }
  });

  it('should NOT match Logger (unrelated class)', () => {
    const out = runCLI(`--multisect-search "cipher;deflate;transmit" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(!out.includes('Logger'),
      'should NOT match Logger: ' + out);
  });
});


// ========================================================================
// Test: C++ class split across .h and .cpp
// ========================================================================

describe('Class scope: C++ class split across .h and .cpp', () => {
  const SRC_DIR = path.join(TEST_DIR, 'cpp_split');
  const IDX_DIR = path.join(TEST_DIR, '.idx_cpp_split');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    // Header declares the class; .cpp files implement methods
    fs.writeFileSync(path.join(SRC_DIR, 'renderer.h'), `
#pragma once

class Renderer {
public:
    void initialize();
    void rasterize();
    void composite();
};
`);

    // Term "viewport" is in initialize(), term "triangle" is in rasterize(),
    // term "alpha" is in composite(). Each in different files.
    fs.writeFileSync(path.join(SRC_DIR, 'renderer_init.cpp'), `
#include "renderer.h"

void Renderer::initialize() {
    // Set up the viewport and clear buffers
    setupViewport(1920, 1080);
}
`);

    fs.writeFileSync(path.join(SRC_DIR, 'renderer_draw.cpp'), `
#include "renderer.h"

void Renderer::rasterize() {
    // Draw each triangle in the mesh
    for (auto& tri : mesh.triangles) {
        drawTriangle(tri);
    }
}
`);

    fs.writeFileSync(path.join(SRC_DIR, 'renderer_composite.cpp'), `
#include "renderer.h"

void Renderer::composite() {
    // Blend layers with alpha compositing
    blendWithAlpha(frontBuffer, backBuffer);
}
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('multisect "viewport;triangle;alpha" should produce a CLASS-level match for Renderer', () => {
    const out = runCLI(`--multisect-search "viewport;triangle;alpha" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('CLASS-level'),
      'should have CLASS-level section: ' + out);
    assert.ok(out.includes('Renderer'),
      'should match Renderer across .cpp files: ' + out);
  });

  it('class match should mention multiple files', () => {
    const out = runCLI(`--multisect-search "viewport;triangle;alpha" --index-path ${IDX_DIR} 2>&1`);
    // The class is split across 3 .cpp files
    if (out.includes('Renderer')) {
      assert.ok(out.includes('files') || out.includes('3 methods'),
        'should indicate multiple files or methods: ' + out);
    }
  });
});


// ========================================================================
// Test: Class covered by function → suppressed (dedup)
// ========================================================================

describe('Class scope: dedup when function covers all terms', () => {
  const SRC_DIR = path.join(TEST_DIR, 'dedup');
  const IDX_DIR = path.join(TEST_DIR, '.idx_dedup');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    // All terms appear in a SINGLE method → function match covers it,
    // class match should be suppressed unless --verbose
    fs.writeFileSync(path.join(SRC_DIR, 'simple.py'), `
class Database:
    def connect_and_query(self):
        # connect to the database
        conn = make_connection(self.host)
        # execute the query
        result = conn.execute(self.query)
        # fetch all rows
        rows = result.fetchall()
        return rows

    def close(self):
        self.conn.close()
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('class match should be suppressed when function covers all terms', () => {
    const out = runCLI(`--multisect-search "connect;query;fetch" --index-path ${IDX_DIR} 2>&1`);
    // Should have a function-level match
    assert.ok(out.includes('FUNCTION-level'),
      'should have FUNCTION-level match: ' + out);
    // Class-level should either be suppressed or show "suppressed"
    if (out.includes('CLASS-level')) {
      assert.ok(out.includes('suppressed'),
        'class match should note suppression: ' + out);
    }
  });

  it('--verbose should show both function and class match', () => {
    const out = runCLI(`--multisect-search "connect;query;fetch" --verbose --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('FUNCTION-level'), 'should show function match: ' + out);
    assert.ok(out.includes('CLASS-level'), 'should also show class match with --verbose: ' + out);
    assert.ok(out.includes('Database'), 'should show Database class: ' + out);
  });
});


// ========================================================================
// Test: Java-style class with extends
// ========================================================================

describe('Class scope: Java class', () => {
  const SRC_DIR = path.join(TEST_DIR, 'java_class');
  const IDX_DIR = path.join(TEST_DIR, '.idx_java');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'HttpClient.java'), `
public class HttpClient extends AbstractClient {
    public void authenticate(String token) {
        // validate the authentication token
        this.token = validateToken(token);
    }

    public byte[] download(String url) {
        // download the resource at the given URL
        return httpGet(url, this.token);
    }

    public void retry(int maxAttempts) {
        // exponential backoff retry logic
        for (int i = 0; i < maxAttempts; i++) {
            Thread.sleep(1000 * Math.pow(2, i));
        }
    }
}
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('multisect "authenticate;download;retry" should find HttpClient at class level', () => {
    const out = runCLI(`--multisect-search "authenticate;download;retry" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('CLASS-level'),
      'should have CLASS-level section: ' + out);
    assert.ok(out.includes('HttpClient'),
      'should match HttpClient: ' + out);
  });
});


// ========================================================================
// Test: JS class with methods
// ========================================================================

describe('Class scope: JavaScript class', () => {
  const SRC_DIR = path.join(TEST_DIR, 'js_class');
  const IDX_DIR = path.join(TEST_DIR, '.idx_js_class');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'app.js'), `
class EventBus {
    subscribe(channel, callback) {
        // register a subscriber for the channel
        this.listeners[channel] = this.listeners[channel] || [];
        this.listeners[channel].push(callback);
    }

    publish(channel, payload) {
        // broadcast the payload to all subscribers
        for (const cb of this.listeners[channel] || []) {
            cb(payload);
        }
    }

    unsubscribe(channel, callback) {
        // remove a specific listener from the channel
        this.listeners[channel] = (this.listeners[channel] || [])
            .filter(cb => cb !== callback);
    }
}
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('multisect "subscribe;broadcast;listener" should find EventBus at class level', () => {
    const out = runCLI(`--multisect-search "subscribe;broadcast;listener" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('CLASS-level') || out.includes('EventBus'),
      'should find EventBus at class level: ' + out);
  });
});


// ========================================================================
// Test: Multiple classes, only one matches
// ========================================================================

describe('Class scope: multiple classes, selective match', () => {
  const SRC_DIR = path.join(TEST_DIR, 'multi_class');
  const IDX_DIR = path.join(TEST_DIR, '.idx_multi_class');

  before(() => {
    fs.mkdirSync(SRC_DIR, { recursive: true });

    fs.writeFileSync(path.join(SRC_DIR, 'models.py'), `
class UserModel:
    def validate_email(self):
        # check email format
        if "@" not in self.email:
            raise ValueError("invalid email")

    def hash_password(self, password):
        # hash with bcrypt
        return bcrypt.hash(password)

class ProductModel:
    def calculate_price(self):
        # compute price with discount
        return self.base_price * (1 - self.discount)

    def update_inventory(self, quantity):
        # adjust stock level
        self.stock -= quantity
`);

    runCLI(`--build-index ${SRC_DIR} --index-path ${IDX_DIR} --skip-semantic 2>&1`);
  });

  it('"email;password" should match UserModel but not ProductModel', () => {
    const out = runCLI(`--multisect-search "email;password" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('UserModel'),
      'should match UserModel: ' + out);
    assert.ok(!out.includes('ProductModel'),
      'should NOT match ProductModel: ' + out);
  });

  it('"price;inventory" should match ProductModel but not UserModel', () => {
    const out = runCLI(`--multisect-search "price;inventory" --index-path ${IDX_DIR} 2>&1`);
    assert.ok(out.includes('ProductModel'),
      'should match ProductModel: ' + out);
    assert.ok(!out.includes('UserModel'),
      'should NOT match UserModel: ' + out);
  });
});
