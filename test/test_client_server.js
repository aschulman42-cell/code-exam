// test_client_server.js — client/server detector: route + call detection, unmatched-call reconciliation
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
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

    // Client code: some calls match a server route, one doesn't, one external,
    // one via a named constant (#201 Part D), plus a package-metadata block
    // whose URLs must NOT be counted as client calls (#201 Part D de-noise).
    fs.writeFileSync(path.join(TEST_DIR, 'client.js'), `
const ANALYZE_URL = '/api/analyze-llm';
let H = "win32";
const pkg = {
  author: { name: "Test Team", url: "https://meta.example.com/team" },
  homepage: "https://meta.example.com/home"
};
async function load() {
  const a = await fetch('/api/users');
  const b = await axios.post('/api/users', payload);
  const c = await fetch('/api/users/42');
  const d = await fetch('/api/missing');
  const e = await fetch('https://third-party.example.com/widgets');
  const f = await fetch(\`/api/items?page=\${n}\`);
  const g = await api.post('analyze-llm', payload);
  const h = await api.get('stats');
  const i = await fetch(ANALYZE_URL);
  const j = await fetch(H);
  var emb = Service.Get("EmbObjInner");
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

  it('resolves a named/constant URL arg (fetch(ANALYZE_URL)) and carries the name', () => {
    const named = result.client.find(c => c.name === 'ANALYZE_URL');
    assert.ok(named, 'fetch(ANALYZE_URL) should be detected via the const map');
    assert.equal(named.url, '/api/analyze-llm', 'resolved to the constant value');
    assert.equal(named.kind, 'fetch');
    // ...and it reconciles to the server route, not flagged as missing.
    assert.ok(!result.unmatched.some(u => u.pathOnly === '/api/analyze-llm'),
      'resolved constant URL should match app.post(/api/analyze-llm)');
  });

  it('de-noises metadata URLs (author.url / homepage) — not client calls', () => {
    assert.ok(!result.client.some(c => /meta\.example\.com/.test(c.url)),
      'package-metadata URLs must not be recorded as client calls');
  });

  it('does NOT treat COM/WMI Service.Get("X") as an HTTP client call (case-sensitive wrapper)', () => {
    // WMI JScript `Service.Get("EmbObjInner")` — capitalized .Get must not match
    // the lowercase HTTP wrapper pattern (the .WinAPI_Classic false positives).
    assert.ok(!result.client.some(c => /EmbObjInner/.test(c.url) || /EmbObjInner/.test(c.pathOnly || '')),
      'capitalized COM .Get() must not be a client call');
  });

  it('does NOT resolve a short minified var to a non-URL value (fetch(H) ≠ "win32")', () => {
    // `let H = "win32"` + `fetch(H)`: H is 1 char and "win32" isn't URL-shaped,
    // so it must not resolve — the minified single-letter collision that
    // produced a phantom /win32 endpoint.
    assert.ok(!result.client.some(c => c.url === 'win32' || c.name === 'H'),
      'short non-URL constant must not resolve a fetch identifier arg');
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

// ---------------------------------------------------------------------------
// #201 increment 3 — RPC + IPC transports
// ---------------------------------------------------------------------------

const RI_DIR = path.join(os.tmpdir(), 'ce_test_cs_rpcipc_src');
const RI_IDX = path.join(os.tmpdir(), 'ce_test_cs_rpcipc_idx');

describe('#201 RPC + IPC transport detection', () => {
  let result;

  before(async () => {
    fs.mkdirSync(RI_DIR, { recursive: true });

    // Windows RPC (server + client) + a svc_run decoy that must NOT match.
    fs.writeFileSync(path.join(RI_DIR, 'winrpc.c'), `
void server(void) {
  RpcServerUseProtseqEp(proto, max, ep, NULL);
  RpcServerRegisterIf(h, NULL, NULL);
  RpcServerListen(1, 20, 0);
}
void client(void) {
  RpcStringBindingCompose(uuid, proto, host, ep, opts, &s);
  RpcBindingFromStringBinding(s, &binding);
}
void thread(void) {
  svc_run();  // ACE thread method — NOT Sun RPC, must be excluded
}
`);

    // Sun/ONC RPC (client + server).
    fs.writeFileSync(path.join(RI_DIR, 'sunrpc.c'), `
void c(void) {
  CLIENT *cl = clnt_create(host, PROG, VERS, "tcp");
  clnt_call(cl, PROC, xa, a, xr, r, tv);
}
void s(void) {
  svcudp_create(sock);
  svc_register(xprt, PROG, VERS, dispatch, proto);
}
`);

    // Windows named pipe (server + client) + a pipe-path literal.
    fs.writeFileSync(path.join(RI_DIR, 'pipe.c'), `
void server(void) {
  HANDLE h = CreateNamedPipe("\\\\\\\\.\\\\pipe\\\\demo", 0, 0, 1, 0, 0, 0, NULL);
  ConnectNamedPipe(h, NULL);
}
void client(void) {
  CallNamedPipe(name, in, inlen, out, outlen, &read, 0);
}
void fifo(void) {
  mkfifo("/tmp/myfifo", 0666);
}
`);

    // Node IPC.
    fs.writeFileSync(path.join(RI_DIR, 'worker.js'), `
process.on('message', (m) => handle(m));
process.send({ ready: true });
`);

    const index = new CodeSearchIndex({ indexPath: RI_IDX });
    await index.buildIndex(RI_DIR, { showProgress: false });
    result = extractClientServer(index);
  });

  after(() => {
    fs.rmSync(RI_DIR, { recursive: true, force: true });
    fs.rmSync(RI_IDX, { recursive: true, force: true });
  });

  const rpc = (pred) => result.rpc.filter(pred);
  const ipc = (pred) => result.ipc.filter(pred);

  it('detects Windows RPC server + client roles', () => {
    assert.ok(rpc(r => r.role === 'server' && /^RpcServer/.test(r.api)).length, 'RpcServer* = server');
    assert.ok(rpc(r => r.role === 'client' && /^Rpc(StringBinding|BindingFrom)/.test(r.api)).length, 'RpcBinding* = client');
  });

  it('detects Sun/ONC RPC, and EXCLUDES svc_run (ACE thread method)', () => {
    assert.ok(rpc(r => r.role === 'client' && r.api === 'clnt_create').length, 'clnt_create');
    assert.ok(rpc(r => r.role === 'server' && r.api === 'svc_register').length, 'svc_register');
    assert.equal(rpc(r => /svc_run/.test(r.api)).length, 0, 'svc_run must not be detected');
  });

  it('detects named-pipe server + client and mkfifo', () => {
    assert.ok(ipc(e => e.role === 'server' && e.api === 'CreateNamedPipe').length, 'CreateNamedPipe = server');
    assert.ok(ipc(e => e.role === 'client' && e.api === 'CallNamedPipe').length, 'CallNamedPipe = client');
    assert.ok(ipc(e => e.role === 'server' && e.api === 'mkfifo').length, 'mkfifo = server');
  });

  it('detects Node IPC (process.send / on(message))', () => {
    assert.ok(ipc(e => e.lang === 'node' && e.role === 'server' && /on\('message'\)/.test(e.api)).length, 'on(message)');
    assert.ok(ipc(e => e.lang === 'node' && e.role === 'client' && e.api === 'process.send').length, 'process.send');
  });

  it('stats count rpc + ipc', () => {
    assert.equal(result.stats.rpcCount, result.rpc.length);
    assert.equal(result.stats.ipcCount, result.ipc.length);
    assert.ok(result.stats.rpcCount > 0 && result.stats.ipcCount > 0);
  });
});
