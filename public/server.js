#!/usr/bin/env node
/**
 * server.js - GUI server for Code Exam.
 *
 * Zero external dependencies - uses Node built-in http module.
 * Loads one or more CodeSearchIndex instances and exposes API routes
 * that return JSON. The browser UI (public/) handles rendering.
 *
 * Usage:
 *   node src/server.js --index-path .my_index
 *   node src/server.js --index-path .idx1 --index-path .idx2
 *   node src/server.js --port 8080
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';
import { parseMultisectTerms } from './commands/multisect.js';
import { displayName } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');


// ========================================================================
// Parse server arguments
// ========================================================================

function parseServerArgs() {
  const args = process.argv.slice(2);
  const result = { indexPaths: [], port: 3000, host: '127.0.0.1' };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--index-path' || a === '--index') && args[i + 1]) {
      result.indexPaths.push(args[++i]);
    } else if (a === '--port' && args[i + 1]) {
      result.port = parseInt(args[++i]) || 3000;
    } else if (a === '--host' && args[i + 1]) {
      result.host = args[++i];
    } else if (!a.startsWith('-')) {
      result.indexPaths.push(a);
    }
  }

  if (result.indexPaths.length === 0) {
    result.indexPaths.push('.code_search_index');
  }

  return result;
}


// ========================================================================
// Index manager: holds one or more named indexes
// ========================================================================

class IndexManager {
  constructor() {
    /** @type {Map<string, CodeSearchIndex>} name -> index */
    this.indexes = new Map();
    /** @type {string|null} */
    this.activeIndex = null;
  }

  load(indexPath) {
    const idx = new CodeSearchIndex({ indexPath });
    if (idx.files.size === 0) {
      console.error(`Warning: No files loaded from index at ${indexPath}`);
      return null;
    }
    const name = path.basename(indexPath) || indexPath;
    this.indexes.set(name, idx);
    if (!this.activeIndex) this.activeIndex = name;
    console.log(`Loaded index "${name}": ${idx.files.size} files`);
    return name;
  }

  get(name = null) {
    const key = name || this.activeIndex;
    return this.indexes.get(key) || null;
  }

  list() {
    return [...this.indexes.entries()].map(([name, idx]) => ({
      name, files: idx.files.size, active: name === this.activeIndex,
    }));
  }
}

const serverArgs = parseServerArgs();
const mgr = new IndexManager();

for (const ip of serverArgs.indexPaths) {
  mgr.load(ip);
}

if (mgr.indexes.size === 0) {
  console.error('No valid indexes loaded. Build one first:');
  console.error('  node src/index.js --build-index ./your/source');
  console.error('Then:');
  console.error('  node src/server.js --index-path .code_search_index');
  process.exit(1);
}


// ========================================================================
// Static file serving
// ========================================================================

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

function serveStatic(req, res) {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(filePath);
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}


// ========================================================================
// API helpers
// ========================================================================

function parseQuery(url) {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return {};
  const params = {};
  for (const pair of url.slice(qIdx + 1).split('&')) {
    const [k, v] = pair.split('=').map(decodeURIComponent);
    params[k] = v;
  }
  return params;
}

function jsonResponse(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(body);
}

function errorResponse(res, message, status = 400) {
  jsonResponse(res, { error: message }, status);
}

function parseFuncSpec(spec) {
  if (spec && spec.includes('@')) {
    const atPos = spec.indexOf('@');
    return { fileHint: spec.slice(0, atPos), funcName: spec.slice(atPos + 1) };
  }
  return { fileHint: null, funcName: spec };
}


// ========================================================================
// API routes
// ========================================================================

const routes = {};

// --- Index management ---

routes['/api/indexes'] = (req, res) => {
  jsonResponse(res, { indexes: mgr.list() });
};

routes['/api/stats'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const stats = index.getStats();
  const funcCount = index.listFunctions().length;
  jsonResponse(res, { ...stats, function_count: funcCount, index_path: index.indexPath, base_path: index.basePath });
};


// --- File / function listing ---

routes['/api/list-files'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let files = index.listFiles();
  if (q.filter) { const pat = q.filter.toLowerCase(); files = files.filter(f => f.toLowerCase().includes(pat)); }
  const max = parseInt(q.max) || 200;
  jsonResponse(res, { total: files.length, files: files.slice(0, max) });
};

routes['/api/list-functions'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let funcs = index.listFunctions();
  if (q.filter) { const pat = q.filter.toLowerCase(); funcs = funcs.filter(f => f.name.toLowerCase().includes(pat) || f.filepath.toLowerCase().includes(pat)); }
  const sort = q.sort || 'lines';
  if (sort === 'lines') funcs.sort((a, b) => b.lines - a.lines);
  else if (sort === 'alpha') funcs.sort((a, b) => a.name.localeCompare(b.name));
  const max = parseInt(q.max) || 200;
  jsonResponse(res, {
    total: funcs.length,
    functions: funcs.slice(0, max).map(f => ({
      name: f.name, display_name: f.displayName, filepath: f.filepath,
      lines: f.lines, start: f.start, end: f.end, type: f.type,
    })),
  });
};

routes['/api/file-functions'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const filepath = q.path;
  if (!filepath) return errorResponse(res, 'Missing ?path= parameter');
  let funcs = index.listFunctions(filepath);
  funcs.sort((a, b) => a.start - b.start);
  jsonResponse(res, {
    filepath, total: funcs.length,
    functions: funcs.map(f => ({
      name: f.name, display_name: f.displayName, filepath: f.filepath,
      lines: f.lines, start: f.start, end: f.end, type: f.type,
    })),
  });
};


// --- Extract function source ---

routes['/api/extract'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const funcSpec = q.func;
  if (!funcSpec) return errorResponse(res, 'Missing ?func= parameter');
  const { funcName, fileHint } = parseFuncSpec(funcSpec);
  const matches = index.findFunctionMatches(funcName, fileHint);
  if (matches.length === 0) return errorResponse(res, `Function '${funcName}' not found`, 404);
  if (matches.length > 1 && !fileHint) {
    return jsonResponse(res, {
      ambiguous: true,
      matches: matches.map(m => ({ filepath: m.filepath, name: m.name, display_name: displayName(m.name, m.filepath), start: m.start, end: m.end, lines: m.end - m.start + 1 })),
    });
  }
  const m = matches[0];
  const source = index.getFunctionSource(m.filepath, m.name);
  jsonResponse(res, {
    filepath: m.filepath, name: m.name, display_name: displayName(m.name, m.filepath),
    start: m.start, end: m.end, lines: m.end - m.start + 1,
    source: source || '(source not available)', language: guessLanguage(m.filepath),
  });
};


// --- Show file contents ---

routes['/api/show-file'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const filePath = q.path;
  if (!filePath) return errorResponse(res, 'Missing ?path= parameter');
  const matches = index.findPathMatches(filePath);
  const exactFiles = matches.filter(m => index.files.has(m));
  if (exactFiles.length === 0) return errorResponse(res, `File '${filePath}' not found`, 404);
  const fp = exactFiles[0];
  const content = index.files.get(fp);
  jsonResponse(res, { filepath: fp, content: content || '', lines: (index.fileLines.get(fp) || []).length, language: guessLanguage(fp) });
};


// --- Hotspots ---

routes['/api/hotspots'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 25;
  let hotspots = index.getHotspots(n * 3, true);
  if (q.filter) { const pat = q.filter.toLowerCase(); hotspots = hotspots.filter(h => h.name.toLowerCase().includes(pat) || h.filepath.toLowerCase().includes(pat)); }
  jsonResponse(res, {
    hotspots: hotspots.slice(0, n).map((h, i) => ({
      rank: i + 1, name: h.name, display_name: h.display_name, filepath: h.filepath,
      lines: h.lines, calls: h.calls, score: Math.round(h.score * 10) / 10, type: h.type,
    })),
  });
};


// --- Hot Folders ---

routes['/api/hot-folders'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  const hotspots = index.getHotspots(50000, true);
  if (!hotspots.length) return jsonResponse(res, { folders: [] });

  const folderStats = {};
  for (const h of hotspots) {
    const fp = h.filepath.replace(/\\/g, '/');
    const parts = fp.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      if (!folderStats[folder]) folderStats[folder] = { score: 0, funcs: 0, files: new Set(), top_func: null, top_score: 0 };
      const s = folderStats[folder];
      s.score += h.score; s.funcs++; s.files.add(fp);
      if (h.score > s.top_score) { s.top_score = h.score; s.top_func = h.display_name || h.name; }
    }
  }

  const sorted = Object.entries(folderStats).sort((a, b) => b[1].score - a[1].score);
  const shownFolders = new Set();
  let filtered = [];
  for (const [folder, stats] of sorted) {
    const parts = folder.split('/');
    const parent = parts.length > 1 ? parts.slice(0, -1).join('/') : null;
    if (parent && shownFolders.has(parent)) {
      const ps = folderStats[parent];
      if (ps && Math.abs(ps.score - stats.score) < 1) continue;
    }
    filtered.push([folder, stats]);
    shownFolders.add(folder);
  }
  if (q.filter) { const pat = q.filter.toLowerCase(); filtered = filtered.filter(([f]) => f.toLowerCase().includes(pat)); }

  jsonResponse(res, {
    folders: filtered.slice(0, n).map(([folder, stats], i) => ({
      rank: i + 1, folder, score: Math.round(stats.score),
      funcs: stats.funcs, files: stats.files.size, top_func: stats.top_func || '',
    })),
  });
};


// --- Entry points ---

routes['/api/entry-points'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 25;
  const maxCalls = parseInt(q.max_calls) || 0;
  let entries = index.getEntryPoints(n * 3, maxCalls, true);
  if (q.filter) { const pat = q.filter.toLowerCase(); entries = entries.filter(e => e.name.toLowerCase().includes(pat) || e.filepath.toLowerCase().includes(pat)); }
  jsonResponse(res, {
    entries: entries.slice(0, n).map((e, i) => ({
      rank: i + 1, name: e.name, display_name: e.display_name, filepath: e.filepath,
      lines: e.lines, calls: e.calls, type: e.type,
    })),
  });
};


// --- Gaps (dead code) ---

routes['/api/gaps'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  const entries = index.getEntryPoints(999, 0, true);

  const skipKw = new Set(['if','while','for','switch','catch','return','sizeof','typeof','void','int','char','Copyright','copyright']);
  const epPat = ['handle','render','componentdid','componentwill','useeffect','oncreate','ondestroy','onmount','onsubmit','onchange','onclick','oninit','onload','main','run','start','init','setup','configure','bootstrap','register','execute','test','spec','describe'];

  function isEntry(name, filepath) {
    const bare = name.includes('::') ? name.split('::').pop() : name;
    const lower = bare.toLowerCase();
    if (epPat.some(p => lower.startsWith(p))) return true;
    if (/^(get|set|is|has)[A-Z]/.test(bare)) return true;
    if (/test/i.test(filepath)) return true;
    return false;
  }

  let suspicious = [];
  for (const e of entries) {
    const bare = e.name.includes('::') ? e.name.split('::').pop() : e.name;
    if (bare.length < 2 || skipKw.has(bare)) continue;
    if (e.type === 'class') continue;
    if (isEntry(e.name, e.filepath)) continue;
    suspicious.push(e);
  }
  if (q.filter) { const pat = q.filter.toLowerCase(); suspicious = suspicious.filter(s => s.name.toLowerCase().includes(pat) || s.filepath.toLowerCase().includes(pat)); }

  jsonResponse(res, {
    total: suspicious.length,
    gaps: suspicious.slice(0, n).map((s, i) => ({
      rank: i + 1, name: s.name, display_name: s.display_name,
      filepath: s.filepath, lines: s.lines,
    })),
  });
};


// --- Domain functions ---

routes['/api/domain-fns'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 25;
  let results = index.getDomainHotspots(n * 3, true);
  if (q.filter) { const pat = q.filter.toLowerCase(); results = results.filter(r => r.name.toLowerCase().includes(pat) || r.filepath.toLowerCase().includes(pat)); }
  jsonResponse(res, {
    functions: results.slice(0, n).map((r, i) => ({
      rank: i + 1, name: r.name, display_name: r.display_name, filepath: r.filepath,
      lines: r.lines, calls: r.calls, score: Math.round(r.score * 10) / 10, type: r.type,
    })),
  });
};


// --- Most Called ---

routes['/api/most-called'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  const callData = index.getCallCountsWithDefinitions(true);

  let filtered = [];
  for (const item of callData) {
    if (item.name.length < 2) continue;
    const bare = item.name.includes('::') ? item.name.split('::').pop() : item.name;
    if (bare.length >= 2 && /^[A-Z][A-Z0-9_]+$/.test(bare)) continue;
    if (q.filter && !item.name.toLowerCase().includes(q.filter.toLowerCase())) continue;
    filtered.push(item);
  }

  jsonResponse(res, {
    total: filtered.length,
    functions: filtered.slice(0, n).map((item, i) => ({
      rank: i + 1, name: item.name, count: item.count,
      definitions: item.definitions.length,
      def_files: item.definitions.slice(0, 3).map(d => d.filepath),
    })),
  });
};


// --- Class Hotspots ---

routes['/api/class-hotspots'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  let results = index.getClassHotspots(n, true);
  if (q.filter) { const pat = q.filter.toLowerCase(); results = results.filter(c => c.name.toLowerCase().includes(pat) || c.filepath.toLowerCase().includes(pat)); }
  jsonResponse(res, {
    classes: results.slice(0, n).map((c, i) => ({
      rank: i + 1, name: c.name, filepath: c.filepath,
      methods: c.method_count, total_lines: c.total_method_lines,
      total_calls: c.total_calls || 0, score: Math.round((c.score || 0) * 10) / 10,
    })),
  });
};


// --- Callers / Callees ---

routes['/api/callers'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let func = q.func;
  if (!func) return errorResponse(res, 'Missing ?func= parameter');
  if (func.includes('@')) func = func.slice(func.indexOf('@') + 1);
  const callers = index.findCallers(func, parseInt(q.max) || 200);
  jsonResponse(res, {
    target: func,
    callers: callers.map(c => ({ filepath: c.filepath, line_number: c.line_number, line_text: c.line_text, caller_function: c.caller_function, call_type: c.call_type })),
  });
};

routes['/api/callees'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let func = q.func;
  if (!func) return errorResponse(res, 'Missing ?func= parameter');
  const { funcName, fileHint } = parseFuncSpec(func);
  const callees = index.findCallees(funcName, fileHint);
  jsonResponse(res, {
    target: funcName,
    callees: callees.map(c => ({ name: c.name, display_name: c.display_name, definitions: c.definitions, resolved_def: c.resolved_def || null, call_type: c.call_type, ambiguous: c.ambiguous || false })),
  });
};


// --- Load / replace index at runtime ---

routes['/api/load-index'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const indexPath = params.path;
      if (!indexPath) return errorResponse(res, 'Missing "path" in body');
      const mode = params.mode || 'replace';
      if (!fs.existsSync(indexPath)) return errorResponse(res, `Path not found: ${indexPath}`, 404);
      if (mode === 'replace') { mgr.indexes.clear(); mgr.activeIndex = null; }
      const name = mgr.load(indexPath);
      if (!name) return errorResponse(res, `No files found in index at: ${indexPath}`, 400);
      mgr.activeIndex = name;
      jsonResponse(res, { loaded: name, mode, indexes: mgr.list() });
    } catch (err) {
      errorResponse(res, `Load error: ${err.message}`, 500);
    }
  });
};


// --- Call tree (Mermaid) ---

routes['/api/call-tree'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let func = q.func;
  if (!func) return errorResponse(res, 'Missing ?func= parameter');
  const depth = parseInt(q.depth) || 3;
  const { funcName, fileHint } = parseFuncSpec(func);
  const matches = index.findFunctionMatches(funcName, fileHint);
  if (matches.length === 0) return errorResponse(res, `Function '${funcName}' not found`, 404);

  const root = matches[0];
  const mermaidLines = ['graph TD'];
  const visited = new Set();

  function addCallees(fn, fh, d, pid) {
    if (d >= depth || visited.has(fn)) return;
    visited.add(fn);
    const callees = index.findCallees(fn, fh);
    for (const c of callees.slice(0, 15)) {
      const cid = c.name.replace(/[^a-zA-Z0-9_]/g, '_');
      const psafe = pid.replace(/[^a-zA-Z0-9_]/g, '_');
      mermaidLines.push(`  ${psafe}["${fn}"] --> ${cid}["${c.name}"]`);
      if (c.resolved_def) addCallees(c.name, null, d + 1, cid);
    }
  }

  addCallees(root.name, root.filepath, 0, root.name.replace(/[^a-zA-Z0-9_]/g, '_'));
  jsonResponse(res, { target: root.name, filepath: root.filepath, mermaid: mermaidLines.join('\n') });
};


// --- Multisect search ---

routes['/api/multisect'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const terms = q.terms;
  if (!terms) return errorResponse(res, 'Missing ?terms= parameter');
  const parsed = parseMultisectTerms(terms);
  if (!parsed || parsed.length === 0) return errorResponse(res, 'No valid search terms parsed');
  const minTerms = parseInt(q.min_terms) || 0;
  const maxResults = parseInt(q.max) || 25;
  const results = index.multisectSearch(parsed, { minTerms });
  const nPositive = parsed.filter(t => !t.negated).length;

  const unified = [];
  for (const m of (results.function_matches || [])) {
    if (m.function === '(global)') continue;
    unified.push({ scope: m.function, scope_type: 'function', filepath: m.filepath, function_name: m.function, matched_terms: m.terms_matched, total_terms: nPositive, lines: m.lines || 0 });
  }
  for (const m of (results.file_matches || [])) {
    unified.push({ scope: m.filepath, scope_type: 'file', filepath: m.filepath, function_name: null, matched_terms: m.terms_matched, total_terms: nPositive, lines: 0 });
  }
  for (const m of (results.folder_matches || [])) {
    unified.push({ scope: m.folder, scope_type: 'folder', filepath: m.folder, function_name: null, matched_terms: m.terms_matched, total_terms: nPositive, lines: 0 });
  }
  unified.sort((a, b) => b.matched_terms - a.matched_terms || b.lines - a.lines);
  jsonResponse(res, {
    terms: parsed.map(t => ({ display: t.display, negated: t.negated })),
    term_file_counts: results.term_file_counts || [],
    results: unified.slice(0, maxResults).map((r, i) => ({ rank: i + 1, ...r })),
  });
};


// --- Search (literal) ---

routes['/api/search'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const query = q.q;
  if (!query) return errorResponse(res, 'Missing ?q= parameter');
  const maxResults = parseInt(q.max) || 20;
  const contextLines = parseInt(q.context) || 3;
  const results = index.searchLiteral(query, { maxResults, contextLines });
  jsonResponse(res, {
    query,
    results: results.map(r => ({ filepath: r.filePath, line_number: r.lineNumber, line_text: r.lineText, context: r.context, containing_function: r.functionName || null })),
  });
};


// --- Files search ---

routes['/api/files-search'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const term = q.q;
  if (!term) return errorResponse(res, 'Missing ?q= parameter');
  const max = parseInt(q.max) || 30;
  const fileCounts = new Map();
  const termLower = term.toLowerCase();
  for (const [filepath, lines] of index.fileLines) {
    let count = 0;
    for (const line of lines) { if (line.toLowerCase().includes(termLower)) count++; }
    if (count > 0) fileCounts.set(filepath, count);
  }
  const sorted = [...fileCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max);
  jsonResponse(res, { term, total: fileCounts.size, files: sorted.map(([fp, count], i) => ({ rank: i + 1, filepath: fp, hits: count })) });
};


// --- Vocabulary ---

routes['/api/vocabulary'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 50;
  const filter = q.filter || null;
  const items = index.getTopVocabulary(n, filter);
  jsonResponse(res, {
    vocabulary: items.map((v, i) => ({ rank: i + 1, token: v.token, score: Math.round(v.score * 1000) / 1000, doc_freq: v.doc_freq, total_freq: v.total_count })),
  });
};


// --- Classes ---

routes['/api/list-classes'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  let classes = index.listClasses();
  if (q.filter) { const pat = q.filter.toLowerCase(); classes = classes.filter(c => c.name.toLowerCase().includes(pat) || c.filepath.toLowerCase().includes(pat)); }
  classes.sort((a, b) => b.method_count - a.method_count);
  const max = parseInt(q.max) || 100;
  jsonResponse(res, {
    total: classes.length,
    classes: classes.slice(0, max).map(c => ({ name: c.name, filepath: c.filepath, methods: c.method_count, total_lines: c.total_method_lines, inferred: c.inferred || false })),
  });
};

routes['/api/class-methods'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const className = q.name;
  if (!className) return errorResponse(res, 'Missing ?name= parameter');
  const allClasses = index.listClasses();
  const cls = allClasses.find(c => c.name === className);
  if (!cls) return errorResponse(res, `Class '${className}' not found`, 404);
  jsonResponse(res, {
    name: cls.name, filepath: cls.filepath, method_count: cls.method_count,
    total_lines: cls.total_method_lines, inferred: cls.inferred || false,
    methods: (cls.methods || []).map(m => ({ name: m.name, filepath: m.filepath, start: m.start, end: m.end, lines: m.lines || (m.end - m.start + 1) })),
  });
};


// --- Func Dupes ---

routes['/api/func-dupes'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 30;
  const minLines = parseInt(q.min_lines) || 3;
  let groups = index.getFuncDupes(n, minLines, true);
  if (q.filter) { const pat = q.filter.toLowerCase(); groups = groups.filter(g => g.bare_name.toLowerCase().includes(pat) || g.instances.some(i => i.filepath.toLowerCase().includes(pat))); }
  jsonResponse(res, {
    total: groups.length,
    groups: groups.slice(0, n).map((g, i) => ({
      rank: i + 1, name: g.bare_name, lines: g.lines, count: g.count, waste: g.waste,
      files: g.instances.slice(0, 5).map(inst => inst.filepath),
    })),
  });
};

routes['/api/near-dupes'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 30;
  index.getFuncDupes(n, 3, true);
  const groups = index.getNearDupes(n);
  jsonResponse(res, {
    total: groups.length,
    groups: groups.slice(0, n).map((g, i) => ({
      rank: i + 1, name: g.bare_name, lines: g.lines, count: g.count, variants: g.unique_variants || 0,
      files: g.instances.slice(0, 5).map(inst => inst.filepath),
    })),
  });
};

routes['/api/struct-dupes'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 30;
  index.getFuncDupes(n, 3, true);
  const groups = index.getStructDupes(n);
  jsonResponse(res, {
    total: groups.length,
    groups: groups.slice(0, n).map((g, i) => ({
      rank: i + 1, name: g.bare_name, lines: g.lines, count: g.count,
      unique_bodies: g.unique_bodies || 0, waste: g.waste,
      files: g.instances.slice(0, 5).map(inst => inst.filepath),
    })),
  });
};


// ========================================================================
// Helpers
// ========================================================================

function guessLanguage(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const map = {
    '.js': 'javascript', '.ts': 'typescript', '.jsx': 'javascript',
    '.py': 'python', '.java': 'java', '.c': 'c', '.cpp': 'cpp',
    '.h': 'c', '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby',
    '.go': 'go', '.rs': 'rust', '.php': 'php', '.swift': 'swift',
    '.kt': 'kotlin', '.scala': 'scala', '.m': 'objectivec',
    '.sql': 'sql', '.sh': 'bash', '.xml': 'xml', '.html': 'html',
    '.css': 'css', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
  };
  return map[ext] || 'text';
}


// ========================================================================
// Router
// ========================================================================

function handleRequest(req, res) {
  const urlPath = req.url.split('?')[0];
  if (urlPath.startsWith('/api/')) {
    const handler = routes[urlPath];
    if (handler) {
      try { handler(req, res); }
      catch (err) { console.error(`API error: ${urlPath}`, err); errorResponse(res, `Internal error: ${err.message}`, 500); }
    } else {
      errorResponse(res, 'Unknown API endpoint', 404);
    }
    return;
  }
  serveStatic(req, res);
}


// ========================================================================
// Start server
// ========================================================================

const server = http.createServer(handleRequest);

server.listen(serverArgs.port, serverArgs.host, () => {
  const indexNames = [...mgr.indexes.keys()].join(', ');
  console.log(`\nCode Exam GUI`);
  console.log(`  URL:     http://${serverArgs.host}:${serverArgs.port}/`);
  console.log(`  Indexes: ${indexNames}`);
  console.log(`  Files:   ${[...mgr.indexes.values()].reduce((s, i) => s + i.files.size, 0)} total`);
  console.log(`\nPress Ctrl+C to stop.\n`);
});
