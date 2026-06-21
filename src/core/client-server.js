/**
 * client-server.js — #197 Client/Server detector.
 *
 * CodeExam surfaces functions, classes, data structures, imports/exports — but
 * had no view of a codebase's HTTP surface: the endpoints a *server* declares
 * and the endpoints a *client* consumes. This detector finds both with
 * language/framework-aware patterns over the cached file lines (works on
 * existing indexes, no reindex), then reconciles them into a service map.
 *
 * The high-value, distinctive signal is the **reconciliation**: client calls to
 * an internal-looking path (relative or `/api/...`) with NO matching server
 * route. That's the visible "missing server code" signal — directly useful for
 * the litigation case the issue raises (productions that ship client code but
 * withhold the server), and for spotting dead/renamed endpoints generally.
 *
 * Honesty about the heuristics (these are regex detectors, not a parse of the
 * routing graph):
 *   - Method is best-effort. `fetch(url)` with options on another line, or a
 *     dynamic method, reads as ANY. Reconciliation matches on PATH only.
 *   - Dynamic paths (template literals with `${...}`, string concatenation,
 *     a base-URL variable) are captured as far as the literal goes and matched
 *     leniently; a fully dynamic URL is recorded but can't be reconciled.
 *   - Server params (`/users/:id`, `/users/{id}`, `/users/<id>`) are treated as
 *     wildcards when matching client paths.
 *   - External origins (http(s):// to another host) are flagged `external` and
 *     excluded from the missing-server callout — they're third-party by design.
 *
 * Noise-excluded (#172/#187): vendored / minified / test trees are skipped via
 * `_isNoiseDoc`, the same gate the vocabulary and data-structs detectors use.
 */
import { _isNoiseDoc } from './vocabulary.js';

const _JS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte']);
const _ext = (fp) => { const i = fp.lastIndexOf('.'); return i < 0 ? '' : fp.slice(i).toLowerCase(); };
const _base = (fp) => { const m = fp.replace(/\\/g, '/').match(/[^/]+$/); return m ? m[0] : fp; };

// HTTP verbs we recognize as method captures (lowercased on store).
const _VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'all']);

// ---- Server-side detectors ---------------------------------------------------

// Express / Node: app.get('/x', …) | router.post('/x', …) ; and the bare
// `routes['/api/x'] = …` table style CodeExam's own server uses (method ANY).
// Canonical Express objects only — `app`/`router`. NOT `api`/`server`: those
// are overwhelmingly *client* wrappers (e.g. `api.get('stats')`,
// `server.post(...)`), and matching them mislabels client calls as server
// routes (#197 iterate). A real `server.get('/x')` is rare enough to miss.
const _RE_EXPRESS_VERB = /\b(?:app|router)\.(get|post|put|delete|patch|head|options|all|use)\s*\(\s*[`'"]([^`'"]+)[`'"]/i;
// Client wrapper calls: api.get('endpoint') / client.post('endpoint'). The
// argument is often a bare fragment (no leading slash); the real URL is built
// inside the wrapper, so we record the fragment as the url.
const _RE_CLIENT_WRAPPER = /\b(?:api|client|http|svc|service)\.(get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/i;
const _RE_ROUTES_TABLE = /\broutes\s*\[\s*[`'"]([^`'"]+)[`'"]\s*\]\s*=/;

// Flask / FastAPI / blueprint: @app.route('/x', methods=['GET']) | @router.get('/x')
const _RE_PY_DECORATOR = /^\s*@\s*\w+\.(route|get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/;
const _RE_PY_METHODS = /methods\s*=\s*\[([^\]]*)\]/;

// Rails routes.rb: get '/x' | post '/x' | resources :foo | match '/x'
const _RE_RAILS = /^\s*(get|post|put|patch|delete|match|resources?|root)\b\s*['"]?([^'",\s]+)?/;

// Go: http.HandleFunc("/x", …) | mux.Handle("/x", …) | r.Get("/x", …) (chi/gin)
const _RE_GO_HANDLE = /\b\w+\.(HandleFunc|Handle)\s*\(\s*"([^"]+)"/;
const _RE_GO_VERB = /\b\w+\.(GET|POST|PUT|DELETE|PATCH|Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/;

function _detectServer(fp, lines, server) {
  const ext = _ext(fp);
  const isJs = _JS.has(ext);
  const isPy = ext === '.py';
  const isRb = ext === '.rb';
  const isGo = ext === '.go';
  // Rails: only trust the verb-leading patterns inside a routes file — `get`
  // is too common a word elsewhere to scan every .rb line for it.
  const rbIsRoutes = isRb && /routes\.rb$/i.test(fp.replace(/\\/g, '/'));

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    if (isJs) {
      if ((m = ln.match(_RE_EXPRESS_VERB))) {
        const verb = m[1].toLowerCase();
        server.push({ method: verb === 'use' ? 'ANY' : verb.toUpperCase(), path: m[2], framework: 'express', filepath: fp, line: i + 1 });
        continue;
      }
      if ((m = ln.match(_RE_ROUTES_TABLE))) {
        server.push({ method: 'ANY', path: m[1], framework: 'routes-table', filepath: fp, line: i + 1 });
        continue;
      }
    } else if (isPy) {
      if ((m = ln.match(_RE_PY_DECORATOR))) {
        const deco = m[1].toLowerCase();
        let method = deco === 'route' ? 'ANY' : deco.toUpperCase();
        if (deco === 'route') {
          const mm = ln.match(_RE_PY_METHODS);
          if (mm) {
            const verbs = mm[1].split(',').map(s => s.replace(/['"\s]/g, '').toUpperCase()).filter(Boolean);
            if (verbs.length) method = verbs.join('|');
          }
        }
        server.push({ method, path: m[2], framework: 'flask/fastapi', filepath: fp, line: i + 1 });
        continue;
      }
    } else if (rbIsRoutes) {
      if ((m = ln.match(_RE_RAILS)) && m[1]) {
        const verb = m[1].toLowerCase();
        const path = m[2] || (verb.startsWith('resource') ? '(resource)' : '/');
        const method = _VERBS.has(verb) ? verb.toUpperCase() : 'ANY';
        server.push({ method, path, framework: 'rails', filepath: fp, line: i + 1 });
        continue;
      }
    } else if (isGo) {
      if ((m = ln.match(_RE_GO_HANDLE))) {
        server.push({ method: 'ANY', path: m[2], framework: 'go-http', filepath: fp, line: i + 1 });
        continue;
      }
      if ((m = ln.match(_RE_GO_VERB))) {
        server.push({ method: m[1].toUpperCase(), path: m[2], framework: 'go-http', filepath: fp, line: i + 1 });
        continue;
      }
    }
  }
}

// ---- Client-side detectors ---------------------------------------------------

// fetch('/x' | `…`) — method comes from a 2nd-arg options object if on-line.
const _RE_FETCH = /\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]/;
const _RE_FETCH_METHOD = /method\s*:\s*[`'"](\w+)[`'"]/i;
// axios.get('/x') | axios.post('/x', …)
const _RE_AXIOS_VERB = /\baxios\.(get|post|put|delete|patch|head|options)\s*\(\s*[`'"]([^`'"]+)[`'"]/i;
// XMLHttpRequest: xhr.open('GET', '/x')
const _RE_XHR = /\.open\s*\(\s*[`'"](\w+)[`'"]\s*,\s*[`'"]([^`'"]+)[`'"]/;
// Python requests.get('/x') | requests.post(…)
const _RE_REQUESTS = /\brequests\.(get|post|put|delete|patch|head)\s*\(\s*[`'"]([^`'"]+)[`'"]/i;
// Bare URL literals: full origins and internal /api-style paths.
const _RE_URL_LITERAL = /[`'"](https?:\/\/[^`'"\s]+|\/api\/[^`'"\s?]*)[`'"]/g;
// GraphQL op tags (no REST path — recorded separately, not reconciled).
const _RE_GQL = /\bgql\s*`|\buseQuery\s*\(|\buseMutation\s*\(/;

// #201 Part D — named/constant URL args: `const ANALYZE_URL = '/api/x'` then
// `fetch(ANALYZE_URL)`. These calls have no quoted argument, so they were
// missed entirely. Build a per-file const map and resolve identifier args,
// carrying the identifier as the url's name.
const _RE_CONST_DECL = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[`'"]([^`'"]+)[`'"]\s*;?\s*$/;
const _RE_FETCH_IDENT = /\bfetch\s*\(\s*([A-Za-z_$][\w$]*)\s*[),]/;
const _RE_AXIOS_IDENT = /\baxios\.(get|post|put|delete|patch|head|options)\s*\(\s*([A-Za-z_$][\w$]*)\s*[),]/i;
const _RE_WRAPPER_IDENT = /\b(?:api|client|http|svc|service)\.(get|post|put|delete|patch)\s*\(\s*([A-Za-z_$][\w$]*)\s*[),]/i;

// #201 Part D — metadata-URL de-noise: an absolute URL sitting in an
// author/homepage/repository/... field is package metadata, not a client
// call. Only ever applied to absolute (http(s)://) url-literals — internal
// `/api/...` paths are never metadata, so they're never de-noised.
const _META_KEY = /\b(author|homepage|repository|repo|bugs|license|licence|funding|docs|documentation|website|contributors?|maintainers?)\b/i;

function _detectClient(fp, lines, client) {
  const ext = _ext(fp);
  const isJs = _JS.has(ext);
  const isPy = ext === '.py';
  const isHtmlish = ext === '.html' || ext === '.htm';
  if (!isJs && !isPy && !isHtmlish) return;

  // Per-file map of simple string constants, for resolving named URL args
  // (fetch(ANALYZE_URL)). Same-file top-level string literals only, with
  // guards against minified-code false positives (a stray `let H="win32"`
  // must not make every fetch(H) resolve to it):
  //   - name >= 3 chars — minified 1-2 char vars (H, K, a1) collide across
  //     scopes; real URL constants are descriptive (ANALYZE_URL, API_BASE).
  //   - value is URL/path-shaped (starts with `/`, `http(s)://`, or has a `/`)
  //     — excludes bare words like "win32".
  //   - declared exactly once in the file — drop ambiguous re-declarations.
  const constMap = new Map();
  const constCount = new Map();
  for (const ln of lines) {
    const cm = ln.match(_RE_CONST_DECL);
    if (!cm) continue;
    const name = cm[1], val = cm[2];
    constCount.set(name, (constCount.get(name) || 0) + 1);
    if (name.length >= 3 && /^\/|^https?:\/\/|\//.test(val)) constMap.set(name, val);
  }
  for (const [name, count] of constCount) if (count > 1) constMap.delete(name);

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m;
    const seenUrls = new Set();  // urls captured on this line (by any pattern)
    const push = (method, url, kind, name) => {
      if (seenUrls.has(url)) return;  // a more-specific call already caught it
      seenUrls.add(url);
      const entry = { transport: 'http', method, url, kind, filepath: fp, line: i + 1, ...classifyUrl(url) };
      if (name) entry.name = name;  // the identifier the url was referenced by
      client.push(entry);
    };

    if (isJs) {
      if ((m = ln.match(_RE_FETCH))) {
        const mm = ln.match(_RE_FETCH_METHOD);
        push(mm ? mm[1].toUpperCase() : 'GET', m[1], 'fetch');
      } else if ((m = ln.match(_RE_FETCH_IDENT)) && constMap.has(m[1])) {
        push('GET', constMap.get(m[1]), 'fetch', m[1]);
      }
      if ((m = ln.match(_RE_AXIOS_VERB))) push(m[1].toUpperCase(), m[2], 'axios');
      else if ((m = ln.match(_RE_AXIOS_IDENT)) && constMap.has(m[2])) push(m[1].toUpperCase(), constMap.get(m[2]), 'axios', m[2]);
      if ((m = ln.match(_RE_XHR))) push(m[1].toUpperCase(), m[2], 'xhr');
      // Client wrapper (api.get('analyze-llm') or api.get(ANALYZE_URL)) — but
      // not if this line is a server route declaration (defensive; app/router
      // aren't in the wrapper set anyway). The captured fragment reconciles by
      // last segment below.
      if (!_isServerDeclLine(ln, true, false)) {
        if ((m = ln.match(_RE_CLIENT_WRAPPER))) push(m[1].toUpperCase(), m[2], 'wrapper');
        else if ((m = ln.match(_RE_WRAPPER_IDENT)) && constMap.has(m[2])) push(m[1].toUpperCase(), constMap.get(m[2]), 'wrapper', m[2]);
      }
      if (_RE_GQL.test(ln)) push('POST', '(graphql)', 'graphql');
    } else if (isPy) {
      if ((m = ln.match(_RE_REQUESTS))) push(m[1].toUpperCase(), m[2], 'requests');
    }
    // URL literals (all client-ish files, incl. HTML): catches endpoints not
    // wrapped in a recognized call (config objects, base URLs, <form action>).
    // Skip lines that are themselves SERVER route declarations — the path
    // string there is a definition, not a consumption (else server.js routes
    // would show up as client calls). And skip urls already captured above.
    if (!_isServerDeclLine(ln, isJs, isPy)) {
      _RE_URL_LITERAL.lastIndex = 0;
      while ((m = _RE_URL_LITERAL.exec(ln)) !== null) {
        const url = m[1];
        // De-noise (#201 Part D): an absolute URL in a metadata field
        // (author/homepage/repository/...) is package metadata, not a call.
        if (/^https?:\/\//i.test(url) && _isMetadataUrl(lines, i)) continue;
        push('ANY', url, 'url');
      }
    }
  }
}

// Is an absolute url-literal on line i package metadata rather than a call?
// True when the line carries a metadata key, or it's a `url:` field whose
// enclosing object (a few lines up) is a metadata block. #201 Part D.
function _isMetadataUrl(lines, i) {
  if (_META_KEY.test(lines[i])) return true;
  if (/["']?url["']?\s*:/.test(lines[i])) {
    for (let j = Math.max(0, i - 3); j < i; j++) if (_META_KEY.test(lines[j])) return true;
  }
  return false;
}

// Is this line a server-side route declaration? Used to keep the bare
// URL-literal client detector from re-counting server routes as client calls.
function _isServerDeclLine(ln, isJs, isPy) {
  if (isJs) return _RE_EXPRESS_VERB.test(ln) || _RE_ROUTES_TABLE.test(ln);
  if (isPy) return _RE_PY_DECORATOR.test(ln);
  return false;
}

// Classify a URL: { internal: bool, pathOnly: string|null, external: bool }.
// internal = relative path or /api/… (a route we'd expect to find a server for).
// external = absolute http(s):// to some origin (third-party; not our server).
function classifyUrl(url) {
  if (url === '(graphql)') return { internal: false, external: false, pathOnly: null };
  if (/^https?:\/\//i.test(url)) {
    // absolute: extract its path; treat as external (different origin by default)
    const mm = url.match(/^https?:\/\/[^/]+(\/[^?#]*)?/i);
    return { internal: false, external: true, pathOnly: mm && mm[1] ? mm[1] : null };
  }
  if (url.startsWith('/')) {
    return { internal: true, external: false, pathOnly: url.split(/[?#]/)[0] };
  }
  // relative without leading slash (e.g. "users/5") — treat as internal-ish
  return { internal: true, external: false, pathOnly: '/' + url.split(/[?#]/)[0] };
}

// ---- Socket / TLS transport (#201 Part B) -----------------------------------
//
// HTTP is one transport; the Client/Server abstraction is really a service
// boundary. This detects raw socket / TLS networking — the case the `.demo`
// index exercises (a TLS client across C/Java/Python) that the HTTP detectors
// find nothing in. Role is decided by the primitive: `connect` ⇒ client;
// `bind`/`listen`/`accept` ⇒ server. We key on those role-bearing calls, not on
// bare socket() creation (which is role-ambiguous). Endpoint addresses are
// usually config/vars, so there's no path to reconcile — the value is surfacing
// the boundary and which side the code implements.

const _C_EXTS = new Set(['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh', '.hxx', '.m', '.mm']);

const _SOCKET_PATTERNS = {
  c: [
    { re: /\bSSL_connect\s*\(/, role: 'client', api: 'SSL_connect' },
    { re: /\bconnect\s*\(/, role: 'client', api: 'connect' },
    { re: /\bbind\s*\(/, role: 'server', api: 'bind' },
    { re: /\blisten\s*\(/, role: 'server', api: 'listen' },
    { re: /\baccept\s*\(/, role: 'server', api: 'accept' },
  ],
  java: [
    { re: /\bnew\s+ServerSocket\s*\(/, role: 'server', api: 'ServerSocket' },
    { re: /\bSSLServerSocket(?:Factory)?\b/, role: 'server', api: 'SSLServerSocket' },
    { re: /\bnew\s+Socket\s*\(/, role: 'client', api: 'Socket' },
    { re: /\.createSocket\s*\(/, role: 'client', api: 'createSocket' },
    { re: /\.connect\s*\(\s*new\s+InetSocketAddress/, role: 'client', api: 'connect' },
    { re: /\.accept\s*\(\s*\)/, role: 'server', api: 'accept' },
  ],
  python: [
    { re: /PROTOCOL_TLS_SERVER\b/, role: 'server', api: 'TLS_SERVER' },
    { re: /PROTOCOL_TLS_CLIENT\b/, role: 'client', api: 'TLS_CLIENT' },
    { re: /\.bind\s*\(/, role: 'server', api: 'bind' },
    { re: /\.listen\s*\(/, role: 'server', api: 'listen' },
    { re: /\.accept\s*\(/, role: 'server', api: 'accept' },
    { re: /\.connect\s*\(/, role: 'client', api: 'connect' },
  ],
  node: [
    { re: /\btls\.createServer\s*\(/, role: 'server', api: 'tls.createServer' },
    { re: /\bnet\.createServer\s*\(/, role: 'server', api: 'net.createServer' },
    { re: /\btls\.connect\s*\(/, role: 'client', api: 'tls.connect' },
    { re: /\bnet\.(?:connect|createConnection)\s*\(/, role: 'client', api: 'net.connect' },
  ],
};

// File-level gate: the C/Java/Python primitive patterns are deliberately loose
// (`connect(`, `.bind(`, `accept(`), so only run them when the file actually
// involves sockets/TLS — otherwise an unrelated `accept(`/`connect(` could
// fire. Node patterns are self-specific (`net.`/`tls.`) and need no gate.
const _SOCKET_GATE = {
  c: /\bsocket\s*\(|<sys\/socket\.h>|openssl\/ssl\.h|\bSSL_\w/,
  java: /\bSocket\b|javax\.net\.ssl|\bServerSocket\b/,
  python: /\bimport\s+socket\b|\bimport\s+ssl\b|socket\.socket|\bssl\./,
};

const _TLS_HINT = /\bSSL_\w|openssl\/ssl|javax\.net\.ssl|SSLContext|SSLSocket|\bimport\s+ssl\b|\bssl\.|PROTOCOL_TLS|\btls\./;

function _socketLang(ext) {
  if (_C_EXTS.has(ext)) return 'c';
  if (ext === '.java' || ext === '.kt' || ext === '.scala') return 'java';
  if (ext === '.py') return 'python';
  if (_JS.has(ext)) return 'node';
  return null;
}

function _detectSocket(fp, lines, sockets) {
  const lang = _socketLang(_ext(fp));
  if (!lang) return;
  const text = lines.join('\n');
  if (lang !== 'node' && _SOCKET_GATE[lang] && !_SOCKET_GATE[lang].test(text)) return;
  const fileTls = _TLS_HINT.test(text);
  const pats = _SOCKET_PATTERNS[lang];

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const seen = new Set();  // one entry per (role,api) per line
    for (const p of pats) {
      const key = p.role + p.api;
      if (seen.has(key)) continue;
      if (p.re.test(ln)) {
        seen.add(key);
        sockets.push({ transport: 'socket', role: p.role, api: p.api, tls: fileTls, lang, filepath: fp, line: i + 1 });
      }
    }
  }
}

// ---- Reconciliation ----------------------------------------------------------

// Normalize a path to comparable segments: strip a trailing slash, lowercase,
// and mark param segments (:x | {x} | <x> | * ) as the wildcard token '*'.
function _segments(path) {
  return path.replace(/\/+$/, '').split('/').filter(Boolean).map(seg =>
    /^[:{<*]/.test(seg) || /[}>]$/.test(seg) ? '*' : seg.toLowerCase());
}

// Does a client path match a server route pattern? Same segment count, each
// server segment equal or wildcard. Template-literal holes (${…}) in the client
// path also act as wildcards.
function _pathMatches(clientPath, serverSegs) {
  const cSegs = clientPath.replace(/\$\{[^}]*\}/g, '*').replace(/\/+$/, '').split('/').filter(Boolean)
    .map(s => /\$\{|^\*$/.test(s) ? '*' : s.toLowerCase());
  if (cSegs.length !== serverSegs.length) return false;
  for (let i = 0; i < serverSegs.length; i++) {
    if (serverSegs[i] === '*' || cSegs[i] === '*') continue;
    if (serverSegs[i] !== cSegs[i]) return false;
  }
  return true;
}

/**
 * Extract the client/server surface across the index and reconcile it.
 * @returns {{ server, client, unmatched, sockets, stats }}
 *   server:    { transport:'http', method, path, framework, filepath, line }
 *   client:    { transport:'http', method, url, kind, filepath, line, internal, external, pathOnly }
 *   unmatched: HTTP client entries that are internal and match no server route
 *              (the "missing server" signal) — deduped by method+pathOnly.
 *   sockets:   { transport:'socket', role:'client'|'server', api, tls, lang, filepath, line }
 *              raw socket/TLS networking (no path to reconcile; surfaces the
 *              boundary + which side). #201 Part B.
 */
export function extractClientServer(idx, { } = {}) {
  const server = [];
  const client = [];
  const socketsRaw = [];

  for (const [fp, lines] of idx.fileLines) {
    if (_isNoiseDoc(fp, null)) continue;
    _detectServer(fp, lines, server);
    _detectClient(fp, lines, client);
    _detectSocket(fp, lines, socketsRaw);
  }

  // Dedup server routes by method+path+file+line; tag transport.
  const sSeen = new Set();
  const serverOut = [];
  for (const s of server) {
    const k = `${s.method}|${s.path}|${s.filepath}|${s.line}`;
    if (sSeen.has(k)) continue;
    sSeen.add(k);
    serverOut.push({ ...s, transport: 'http' });
  }

  // Dedup socket entries by role+api+file+line, then sort by role/file/line.
  const kSeen = new Set();
  const sockets = [];
  for (const s of socketsRaw) {
    const k = `${s.role}|${s.api}|${s.filepath}|${s.line}`;
    if (kSeen.has(k)) continue;
    kSeen.add(k);
    sockets.push(s);
  }
  sockets.sort((a, b) => (a.role < b.role ? -1 : a.role > b.role ? 1 : 0) || a.filepath.localeCompare(b.filepath) || a.line - b.line);

  // Precompute server route segment patterns for matching.
  const serverPatterns = serverOut
    .filter(s => s.path && s.path.startsWith('/'))
    .map(s => _segments(s.path));

  // Reconcile: an internal client call with a concrete path and no matching
  // server route is "unmatched" (missing server). Dedup by method+pathOnly so
  // the callout lists distinct endpoints, not every call site.
  // Last segment of each server route, for lenient wrapper-fragment matching:
  // a wrapper call `api.get('analyze-llm')` records pathOnly `/analyze-llm`,
  // which won't full-path-match `/api/analyze-llm` — but the last segment does.
  const serverLastSegs = new Set(serverPatterns.map(segs => segs[segs.length - 1]).filter(s => s && s !== '*'));

  const unmatchedSeen = new Set();
  const unmatched = [];
  for (const c of client) {
    if (!c.internal || !c.pathOnly) continue;
    let matched = serverPatterns.some(segs => _pathMatches(c.pathOnly, segs));
    if (!matched && c.kind === 'wrapper') {
      const lastSeg = c.pathOnly.replace(/^\/+/, '').split('/').pop().toLowerCase();
      matched = serverLastSegs.has(lastSeg);
    }
    c.matched = matched;
    if (matched) continue;
    const k = `${c.method}|${c.pathOnly}`;
    if (unmatchedSeen.has(k)) continue;
    unmatchedSeen.add(k);
    unmatched.push(c);
  }

  serverOut.sort((a, b) => (a.path || '').localeCompare(b.path || '') || a.filepath.localeCompare(b.filepath));
  client.sort((a, b) => a.filepath.localeCompare(b.filepath) || a.line - b.line);
  unmatched.sort((a, b) => (a.pathOnly || '').localeCompare(b.pathOnly || ''));

  const socketClientCount = sockets.filter(s => s.role === 'client').length;
  const socketServerCount = sockets.filter(s => s.role === 'server').length;

  return {
    server: serverOut,
    client,
    unmatched,
    sockets,
    stats: {
      serverCount: serverOut.length,
      clientCount: client.length,
      unmatchedCount: unmatched.length,
      socketCount: sockets.length,
      socketClientCount,
      socketServerCount,
    },
  };
}
