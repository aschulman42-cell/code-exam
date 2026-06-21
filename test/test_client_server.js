/**
 * test_client_server.js — #197 Client/Server detector.
 *
 * Verifies server-route detection across frameworks, client-call detection,
 * and the reconciliation that produces the "client call with no matching
 * server route" signal (incl. param-wildcard matching and external-origin
 * exclusion).
 *
 * Run: node --test test/test_client_server.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodeSearchIndex } from '../src/core/CodeSearchIndex.js';
import { extractClientServer } from '../src/core/client-server.js';

const TEST_DIR = path.join(os.tmpdir(), 'ce_test_client_server_src');
const INDEX_DIR = path.join(os.tmpdir(), 'ce_test_client_server_idx');

describe('#197 client/server detector + reconciliation', () => {
  let result;

  before(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Express server (JS) + a routes-table entry.
    fs.writeFileSync(path.join(TEST_DIR, 'server.js'), `
const app = express();
app.get('/api/users', (req, res) => res.json(users));
app.post('/api/users', (req, res) => create(req.body));
router.delete('/api/users/:id', (req, res) => remove(req.params.id));
routes['/api/legacy'] = (req, res) => res.end();
app.post('/api/analyze-llm', (req, res) => analyze(req.body));
`);

    // Flask/FastAPI server (Python).
    fs.writeFileSync(path.join(TEST_DIR, 'api.py'), `
@app.route('/api/health', methods=['GET'])
def health():
    return 'ok'

@router.get('/api/items')
def items():
    return list_items()
`);

    // Go server.
    fs.writeFileSync(path.join(TEST_DIR, 'main.go'), `
func main() {
\thttp.HandleFunc("/api/status", statusHandler)
\tr.GET("/api/version", versionHandler)
}
`);

    // Client code: some calls match a server route, one doesn't, one external.
    fs.writeFileSync(path.join(TEST_DIR, 'client.js'), `
async function load() {
  const a = await fetch('/api/users');
  const b = await axios.post('/api/users', payload);
  const c = await fetch('/api/users/42');
  const d = await fetch('/api/missing');
  const e = await fetch('https://third-party.example.com/widgets');
  const f = await fetch(\`/api/items?page=\${n}\`);
  const g = await api.post('analyze-llm', payload);
  const h = await api.get('stats');
}
`);

    const index = new CodeSearchIndex({ indexPath: INDEX_DIR });
    await index.buildIndex(TEST_DIR, { showProgress: false });
    result = extractClientServer(index);
  });

  after(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.rmSync(INDEX_DIR, { recursive: true, force: true });
  });

  const hasServer = (method, p) => result.server.some(s => s.path === p && (s.method === method || s.method.includes(method)));

  it('detects Express routes (verb + routes-table)', () => {
    assert.ok(hasServer('GET', '/api/users'), 'app.get');
    assert.ok(hasServer('POST', '/api/users'), 'app.post');
    assert.ok(hasServer('DELETE', '/api/users/:id'), 'router.delete with param');
    assert.ok(result.server.some(s => s.path === '/api/legacy' && s.framework === 'routes-table'), 'routes-table');
  });

  it('detects Flask/FastAPI decorators', () => {
    assert.ok(hasServer('GET', '/api/health'), '@app.route methods=[GET]');
    assert.ok(hasServer('GET', '/api/items'), '@router.get');
  });

  it('detects Go handlers', () => {
    assert.ok(result.server.some(s => s.path === '/api/status'), 'http.HandleFunc');
    assert.ok(hasServer('GET', '/api/version'), 'r.GET');
  });

  it('detects client calls (fetch / axios)', () => {
    assert.ok(result.client.some(c => c.url === '/api/users' && c.kind === 'fetch'), 'fetch');
    assert.ok(result.client.some(c => c.url === '/api/users' && c.kind === 'axios' && c.method === 'POST'), 'axios.post');
  });

  it('reconciles: /api/missing is unmatched, matched calls are not', () => {
    assert.ok(result.unmatched.some(u => u.pathOnly === '/api/missing'), '/api/missing should be unmatched');
    assert.ok(!result.unmatched.some(u => u.pathOnly === '/api/users'), '/api/users matches a server route');
  });

  it('param routes match concrete client paths (/api/users/42 → /api/users/:id)', () => {
    assert.ok(!result.unmatched.some(u => u.pathOnly === '/api/users/42'),
      '/api/users/42 should match /api/users/:id and not be flagged');
  });

  it('template-literal path matches (/api/items?page=${n} → /api/items)', () => {
    assert.ok(!result.unmatched.some(u => u.pathOnly && u.pathOnly.startsWith('/api/items')),
      '/api/items?... should match /api/items');
  });

  it('does not double-count a fetch/axios call as a bare url literal (same line)', () => {
    // client.js line with fetch('/api/users') must yield exactly ONE client
    // entry for that url+line, not a fetch entry plus a url-literal entry.
    const usersAtLine1 = result.client.filter(c => c.url === '/api/users' && c.kind === 'url' && /client\.js/.test(c.filepath));
    assert.equal(usersAtLine1.length, 0, 'fetch call should suppress the duplicate url-literal');
  });

  it('server route declarations are not re-counted as client calls', () => {
    // The paths declared in server.js (app.get(...), routes[...]) must not
    // appear as client url-literal calls.
    const serverAsClient = result.client.filter(c => /server\.js/.test(c.filepath));
    assert.equal(serverAsClient.length, 0, 'server-decl lines must not produce client calls');
  });

  it('client wrapper calls (api.get/api.post) are client, not server routes', () => {
    // api.post('analyze-llm') is a CLIENT wrapper — must not be tagged as an
    // Express server route (the api/server-object false-positive bug).
    assert.ok(!result.server.some(s => s.path === 'analyze-llm' || s.path === 'stats'),
      'wrapper fragments must not appear as server routes');
    assert.ok(result.client.some(c => c.kind === 'wrapper' && c.url === 'analyze-llm'),
      'api.post(analyze-llm) should be a client wrapper call');
  });

  it('wrapper fragment reconciles to a server route by last segment', () => {
    // api.post('analyze-llm') should match server app.post('/api/analyze-llm').
    assert.ok(!result.unmatched.some(u => u.pathOnly === '/analyze-llm'),
      'analyze-llm wrapper should reconcile to /api/analyze-llm');
    // ...but a wrapper with no matching route is honestly flagged.
    assert.ok(result.unmatched.some(u => u.pathOnly === '/stats'),
      'api.get(stats) has no server route and should be unmatched');
  });

  it('external origin is excluded from the missing-server callout', () => {
    assert.ok(!result.unmatched.some(u => /third-party/.test(u.pathOnly || '')),
      'external https URL must not be flagged as a missing internal route');
    assert.ok(result.client.some(c => c.external === true && /third-party/.test(c.url)),
      'external URL should still be recorded as a client call');
  });
});

// ---------------------------------------------------------------------------
// #201 Part B — socket / TLS transport
// ---------------------------------------------------------------------------

const SOCK_DIR = path.join(os.tmpdir(), 'ce_test_cs_socket_src');
const SOCK_IDX = path.join(os.tmpdir(), 'ce_test_cs_socket_idx');

describe('#201 socket/TLS transport detection', () => {
  let result;

  before(async () => {
    fs.mkdirSync(SOCK_DIR, { recursive: true });

    // C TLS client (BSD socket + OpenSSL) — connect ⇒ client.
    fs.writeFileSync(path.join(SOCK_DIR, 'tls_client.c'), `
#include <openssl/ssl.h>
int run(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  connect(fd, addr, len);
  SSL_connect(ssl);
  return 0;
}
`);

    // C socket server — bind/listen/accept ⇒ server.
    fs.writeFileSync(path.join(SOCK_DIR, 'srv.c'), `
#include <sys/socket.h>
int serve(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  bind(fd, addr, len);
  listen(fd, 16);
  int c = accept(fd, NULL, NULL);
  return c;
}
`);

    // Java TLS server.
    fs.writeFileSync(path.join(SOCK_DIR, 'Server.java'), `
import javax.net.ssl.SSLServerSocketFactory;
public class Server {
  void run() throws Exception {
    SSLServerSocket ss = (SSLServerSocket) factory.createServerSocket(8443);
    ServerSocket plain = new ServerSocket(9000);
    plain.accept();
  }
}
`);

    // Python TLS client.
    fs.writeFileSync(path.join(SOCK_DIR, 'client.py'), `
import socket
import ssl
def go():
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    s = socket.socket()
    s.connect(("host", 443))
`);

    // Decoy: a .py with .connect( but NO socket/ssl markers — the file gate
    // must keep this out (db.connect is not a socket).
    fs.writeFileSync(path.join(SOCK_DIR, 'db.py'), `
def open_db():
    conn = database.connect("postgres://localhost/app")
    return conn
`);

    const index = new CodeSearchIndex({ indexPath: SOCK_IDX });
    await index.buildIndex(SOCK_DIR, { showProgress: false });
    result = extractClientServer(index);
  });

  after(() => {
    fs.rmSync(SOCK_DIR, { recursive: true, force: true });
    fs.rmSync(SOCK_IDX, { recursive: true, force: true });
  });

  const sock = (pred) => result.sockets.filter(pred);

  it('detects C client (connect/SSL_connect) as role=client', () => {
    assert.ok(sock(s => s.lang === 'c' && s.role === 'client' && s.api === 'SSL_connect').length, 'SSL_connect');
    assert.ok(sock(s => s.lang === 'c' && s.role === 'client' && s.api === 'connect').length, 'connect');
  });

  it('detects C server (bind/listen/accept) as role=server', () => {
    for (const api of ['bind', 'listen', 'accept']) {
      assert.ok(sock(s => s.lang === 'c' && s.role === 'server' && s.api === api).length, api);
    }
  });

  it('detects Java server (ServerSocket / accept)', () => {
    assert.ok(sock(s => s.lang === 'java' && s.role === 'server').length, 'java server');
  });

  it('detects Python TLS client and flags tls', () => {
    assert.ok(sock(s => s.lang === 'python' && s.role === 'client' && s.api === 'TLS_CLIENT').length, 'PROTOCOL_TLS_CLIENT');
    assert.ok(sock(s => s.lang === 'python' && s.role === 'client' && s.api === 'connect').length, 'connect');
    assert.ok(result.sockets.every(s => s.lang !== 'python' || s.tls === true), 'python socket file is TLS');
  });

  it('file gate keeps non-socket .connect( out (db.connect)', () => {
    assert.equal(sock(s => /db\.py/.test(s.filepath)).length, 0,
      'database.connect in a file with no socket/ssl markers must not be a socket call');
  });

  it('stats split client vs server', () => {
    assert.equal(result.stats.socketCount, result.sockets.length);
    assert.equal(result.stats.socketClientCount, sock(s => s.role === 'client').length);
    assert.equal(result.stats.socketServerCount, sock(s => s.role === 'server').length);
    assert.ok(result.stats.socketClientCount > 0 && result.stats.socketServerCount > 0);
  });
});
