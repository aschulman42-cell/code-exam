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
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CodeSearchIndex } from './core/CodeSearchIndex.js';
import { parseMultisectTerms } from './commands/multisect.js';
import { displayName } from './utils.js';
import { execCommand } from './commands/interactive.js';
import {
  extractClaimKeywords, extractClaimTerms, sanitizeLlmTerms, sanitizeBroadTerms,
  parseTermResponse, extractFirstClaim,
  buildExtractionPromptWithVocab, buildLocalExtractionPromptWithVocab,
  CLAIM_EXTRACTION_PROMPT, CLAIM_EXTRACTION_PROMPT_LOCAL,
} from './commands/claim.js';
import {
  buildAnalyzePrompt, buildClaimAnalyzePrompt,
  buildMultisectAnalyzePrompt, buildContextAnalyzePrompt,
  buildFileAnalyzePrompt,
  SimpleMasker, detectLanguage, addLineNumbers,
} from './commands/analyze.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');


// ========================================================================
// Parse server arguments
// ========================================================================

function parseServerArgs() {
  const args = process.argv.slice(2);
  const result = { indexPaths: [], port: 3000, host: '127.0.0.1', modelPath: null, apiKey: null, temperature: 0.0 };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '--index-path' || a === '--index') && args[i + 1]) {
      result.indexPaths.push(args[++i]);
    } else if (a === '--port' && args[i + 1]) {
      result.port = parseInt(args[++i]) || 3000;
    } else if (a === '--host' && args[i + 1]) {
      result.host = args[++i];
    } else if ((a === '--model-path' || a === '--model' || a === '--local-model') && args[i + 1]) {
      result.modelPath = args[++i];
    } else if ((a === '--api-key' || a === '--key') && args[i + 1]) {
      result.apiKey = args[++i];
    } else if (a === '--temperature' && args[i + 1]) {
      result.temperature = parseFloat(args[++i]) || 0.0;
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
// Server-side LLM manager
// ========================================================================
// Supports two backends:
//   Claude API  - uses Anthropic Messages API with system+user prompts
//   Local GGUF  - uses node-llama-cpp (lazy-loaded, persistent model)
//
// Configured via server args (--model-path, --api-key) and/or per-request
// params (engine, apiKey). Local model is loaded once and reused.
// ========================================================================

class ServerLLM {
  constructor(opts = {}) {
    this.defaultModelPath = opts.modelPath || null;
    this.defaultApiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this._localModel = null;     // { llama, model, context, LlamaChatSession, contextSize }
    this._localLoading = null;   // Promise while model is loading (prevents double-load)

    // Try reading API key from file if not in env
    if (!this.defaultApiKey) {
      for (const fname of ['claude.txt', 'claude_key.txt']) {
        try {
          const key = fs.readFileSync(fname, 'utf-8').trim();
          if (key) { this.defaultApiKey = key; break; }
        } catch { /* ignore */ }
      }
    }
  }

  // --- Claude API: system + user message structure ---

  async callClaude(systemPrompt, userMessage, opts = {}) {
    const apiKey = opts.apiKey || this.defaultApiKey;
    if (!apiKey) {
      return { error: 'No API key. Set ANTHROPIC_API_KEY env var, create claude.txt, or pass --api-key.' };
    }

    const apiUrl = opts.apiUrl || process.env.CLAIM_SEARCH_API_URL || 'https://api.anthropic.com/v1/messages';
    const model = opts.model || process.env.CLAIM_SEARCH_MODEL || 'claude-sonnet-4-20250514';
    const maxTokens = opts.maxTokens || 2048;
    const temperature = opts.temperature ?? 0.0;

    const payload = JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    // Network egress warning
    const isLocal = /localhost|127\.0\.0\.1|::1|0\.0\.0\.0|\.local/.test(apiUrl);
    if (!isLocal) {
      console.log(`  [LLM] Claude API -> ${apiUrl} (model: ${model})`);
    }

    try {
      const body = await _serverHttpPost(apiUrl, payload, {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      });

      const usage = body.usage || {};
      const inTok = usage.input_tokens || 0;
      const outTok = usage.output_tokens || 0;
      let costStr = '';
      if (!isLocal && inTok && outTok) {
        const cost = (inTok * 3 + outTok * 15) / 1_000_000;
        costStr = `, est. $${cost.toFixed(4)}`;
      }
      console.log(`  [LLM] OK: ${model} (${inTok} in / ${outTok} out tokens${costStr})`);

      const content = body.content || [];
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      if (!text) return { error: 'LLM returned empty response' };

      return { text, usage: { input_tokens: inTok, output_tokens: outTok, model } };
    } catch (e) {
      return { error: `Claude API error: ${e.message || e}` };
    }
  }

  // --- Local GGUF model: lazy-load, persistent ---

  async ensureLocalModel(modelPath) {
    const mp = modelPath || this.defaultModelPath;
    if (!mp) return { error: 'No local model configured. Use --model-path <path-to-gguf> when starting the server.' };

    // Already loaded with same path?
    if (this._localModel && this._localModel.modelPath === mp) return { ok: true };

    // Currently loading?
    if (this._localLoading) {
      await this._localLoading;
      if (this._localModel) return { ok: true };
      return { error: 'Local model failed to load.' };
    }

    // Load
    this._localLoading = this._loadLocalModel(mp);
    const result = await this._localLoading;
    this._localLoading = null;
    return result;
  }

  async _loadLocalModel(mp) {
    if (!fs.existsSync(mp)) {
      return { error: `Model file not found: ${mp}` };
    }
    try {
      const { getLlama, LlamaChatSession } = await import('node-llama-cpp');
      console.log(`  [LLM] Loading local model: ${mp}...`);
      const llama = await getLlama();
      const model = await llama.loadModel({ modelPath: mp });

      let context = null;
      let contextSize = 0;
      for (const trySize of [8192, 4096, 2048]) {
        try { context = await model.createContext({ contextSize: trySize }); contextSize = trySize; break; }
        catch (_) { /* try smaller */ }
      }
      if (!context) {
        return { error: 'Cannot allocate context for local model (tried 8192/4096/2048).' };
      }

      this._localModel = { llama, model, context, LlamaChatSession, contextSize, modelPath: mp };
      console.log(`  [LLM] OK: Local model loaded (context: ${contextSize} tokens)`);
      return { ok: true };
    } catch (e) {
      if (e.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find/.test(e.message)) {
        return { error: 'node-llama-cpp not installed. Run: npm install node-llama-cpp' };
      }
      return { error: `Failed to load local model: ${e.message}` };
    }
  }

  async callLocal(systemPrompt, userMessage, opts = {}) {
    const mp = opts.modelPath || this.defaultModelPath;
    const loadResult = await this.ensureLocalModel(mp);
    if (loadResult.error) return loadResult;

    const maxTokens = opts.maxTokens || 2048;
    const temperature = opts.temperature ?? 0.0;

    // Local models: combine system + user into single prompt
    const combinedPrompt = systemPrompt + '\n\n' + userMessage;

    let sequence;
    try {
      const { LlamaChatSession, context } = this._localModel;
      sequence = context.getSequence();
      const session = new LlamaChatSession({ contextSequence: sequence });
      console.log(`  [LLM] Sending to local model (${combinedPrompt.length} chars)...`);
      const response = await session.prompt(combinedPrompt, { maxTokens, temperature });
      session.dispose();
      sequence.dispose();
      console.log(`  [LLM] Local model response: ${response.length} chars`);
      return { text: response.trim() };
    } catch (e) {
      if (sequence) { try { sequence.dispose(); } catch (_) {} }
      return { error: `Local model error: ${e.message || e}` };
    }
  }

  // --- Unified dispatch ---

  async call(engine, systemPrompt, userMessage, opts = {}) {
    if (engine === 'claude') {
      return this.callClaude(systemPrompt, userMessage, opts);
    } else {
      return this.callLocal(systemPrompt, userMessage, opts);
    }
  }

  /** Check if the requested engine is available without actually calling it. */
  checkAvailability(engine) {
    if (engine === 'claude') {
      if (!this.defaultApiKey) return { available: false, reason: 'No API key configured.' };
      return { available: true };
    } else {
      if (!this.defaultModelPath) return { available: false, reason: 'No local model configured. Start server with --model-path <path-to-gguf>.' };
      return { available: true };
    }
  }
}

/** Simple HTTP/HTTPS POST for server-side LLM calls. */
function _serverHttpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,   // 2 min for slow models
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (120s)')); });
    req.write(body);
    req.end();
  });
}

const serverLLM = new ServerLLM({
  modelPath: serverArgs.modelPath,
  apiKey: serverArgs.apiKey,
});


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
// Helper: resolve @filepath references in text
// ========================================================================

/**
 * If text starts with @, treat the rest as a file path to read.
 * Returns { text, resolvedFrom } where resolvedFrom is the filepath if resolved.
 */
function resolveAtFile(text) {
  if (!text) return { text: text || '', resolvedFrom: null };
  const trimmed = text.trim();
  const lines = trimmed.split('\n');
  const firstLine = lines[0].trim();
  if (firstLine.startsWith('@') && firstLine.length > 1) {
    const filePath = firstLine.slice(1).trim();
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      // If there are lines after the @path, append them as additional context
      const extra = lines.slice(1).join('\n').trim();
      const fullText = extra ? content.trim() + '\n\n' + extra : content.trim();
      return { text: fullText, resolvedFrom: filePath };
    } catch (e) {
      return { text: trimmed, resolvedFrom: null, error: `Cannot read file: ${filePath} (${e.message})` };
    }
  }
  return { text: trimmed, resolvedFrom: null };
}


// ========================================================================
// API routes
// ========================================================================

const routes = {};

// --- Index management ---

routes['/api/indexes'] = (req, res) => {
  jsonResponse(res, { indexes: mgr.list() });
};

// --- Resolve @filepath to file content ---
routes['/api/resolve-file'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 100_000) req.destroy(); });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const filePath = params.path;
      if (!filePath) return errorResponse(res, 'Missing "path" parameter');
      const content = fs.readFileSync(filePath, 'utf-8');
      jsonResponse(res, { path: filePath, content, chars: content.length });
    } catch (err) {
      errorResponse(res, `Cannot read file: ${err.message}`, 400);
    }
  });
};

// --- Scan for available indexes ---
routes['/api/scan-indexes'] = (req, res) => {
  const available = [];
  try {
    const cwd = process.cwd();
    for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const litIdx = path.join(cwd, entry.name, 'literal_index.json');
        if (fs.existsSync(litIdx)) {
          // Quick stats: file count from literal_index keys
          let fileCount = 0;
          try {
            // Try function_index.json first (much smaller)
            const funcIdx = path.join(cwd, entry.name, 'function_index.json');
            if (fs.existsSync(funcIdx)) {
              const raw = fs.readFileSync(funcIdx, 'utf-8');
              const parsed = JSON.parse(raw);
              const files = new Set();
              for (const f of (parsed.functions || [])) { if (f.filepath) files.add(f.filepath); }
              fileCount = files.size;
            } else {
              // Fallback: count "files" keys in literal_index (expensive for large indices)
              const raw = fs.readFileSync(litIdx, 'utf-8');
              const parsed = JSON.parse(raw);
              fileCount = Object.keys(parsed.files || {}).length;
            }
          } catch (_) {}
          const fullPath = path.join(cwd, entry.name);
          const isLoaded = [...mgr.indexes.keys()].some(k => {
            const loadedPath = mgr.indexes.get(k)?._indexPath || '';
            return loadedPath === fullPath || k === entry.name;
          });
          available.push({ name: entry.name, path: fullPath, files: fileCount, loaded: isLoaded });
        }
      }
    }
  } catch (_) {}
  jsonResponse(res, { available, loaded: mgr.list() });
};

routes['/api/browse-dir'] = (req, res) => {
  const q = parseQuery(req.url);
  const dirPath = path.resolve(q.path || process.cwd());

  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    const code = err.code === 'ENOENT' ? 404 : err.code === 'EACCES' ? 403 : 500;
    return errorResponse(res, `Cannot read directory: ${err.message}`, code);
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(dirPath, entry.name);
    let isIndex = false;
    try { isIndex = fs.existsSync(path.join(fullPath, 'literal_index.json')); } catch (_) {}
    dirs.push({ name: entry.name, isIndex });
  }

  // Sort: index dirs first, then alphabetical (case-insensitive)
  dirs.sort((a, b) => {
    if (a.isIndex !== b.isIndex) return a.isIndex ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  const parent = path.dirname(dirPath);
  jsonResponse(res, { current: dirPath, parent: parent !== dirPath ? parent : null, sep: path.sep, dirs });
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
  const edges = new Set();  // dedup edges

  function safeId(name) { return name.replace(/[^a-zA-Z0-9_]/g, '_'); }
  function safeLbl(name) { return name.replace(/["<>&]/g, c => ({'<':'‹','>':'›','"':"'", '&':'+'}[c])); }
  function addEdge(fromName, toName) {
    const key = `${fromName}-->${toName}`;
    if (edges.has(key)) return;
    edges.add(key);
    mermaidLines.push(`  ${safeId(fromName)}["${safeLbl(fromName)}"] --> ${safeId(toName)}["${safeLbl(toName)}"]`);
  }

  // --- Callees (downward from root) ---
  const visitedDown = new Set();
  function addCallees(fn, fh, d) {
    if (d >= depth || visitedDown.has(fn)) return;
    visitedDown.add(fn);
    const callees = index.findCallees(fn, fh);
    for (const c of callees.slice(0, 12)) {
      addEdge(fn, c.name);
      if (c.resolved_def) addCallees(c.name, null, d + 1);
    }
  }
  addCallees(root.name, root.filepath, 0);

  // --- Callers (upward from root) ---
  const visitedUp = new Set();
  function addCallers(fn, d) {
    if (d >= depth || visitedUp.has(fn)) return;
    visitedUp.add(fn);
    try {
      const callerHits = index.findCallers(fn, 100);
      // Deduplicate by caller function name, keep top by frequency
      const callerCounts = new Map();
      for (const c of callerHits) {
        if (c.caller_function && c.caller_function !== fn && c.caller_function !== '(global)') {
          callerCounts.set(c.caller_function, (callerCounts.get(c.caller_function) || 0) + 1);
        }
      }
      const topCallers = [...callerCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      for (const [callerName] of topCallers) {
        addEdge(callerName, fn);
        addCallers(callerName, d + 1);
      }
    } catch (_) {}
  }
  addCallers(root.name, 0);

  jsonResponse(res, { target: root.name, filepath: root.filepath, mermaid: mermaidLines.join('\n') });
};


// --- File map (all cross-file dependencies as Mermaid) ---

routes['/api/file-map'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const pathFilter = q.filter || null;
  const fileDeps = index.getAllFileDeps(pathFilter, false);
  if (!fileDeps || Object.keys(fileDeps).length === 0)
    return jsonResponse(res, { mermaid: 'graph LR\n  empty["No cross-file deps found"]', files: 0, edges: 0 });

  const mermaidLines = ['flowchart LR'];
  const nodeIds = {};
  let edgeCount = 0;
  const mfid = (fp) => {
    const b = path.basename(fp).replace(/[^a-zA-Z0-9_]/g, '_');
    return `f_${b}_${Buffer.from(fp).toString('base64').slice(0, 6)}`;
  };

  // Build summary: file -> total outgoing calls
  const fileSummary = {};
  for (const [src, deps] of Object.entries(fileDeps)) {
    fileSummary[src] = Object.values(deps).reduce((a, b) => a + b, 0);
  }
  // Show top N files by coupling
  const topFiles = Object.entries(fileSummary).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const topSet = new Set(topFiles.map(([fp]) => fp));

  for (const [src, deps] of Object.entries(fileDeps)) {
    if (!topSet.has(src)) continue;
    const sid = mfid(src);
    if (!(sid in nodeIds)) { nodeIds[sid] = src; mermaidLines.push(`    ${sid}["${path.basename(src)}"]`); }
    for (const [tgt, count] of Object.entries(deps).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      const tid = mfid(tgt);
      if (!(tid in nodeIds)) { nodeIds[tid] = tgt; mermaidLines.push(`    ${tid}["${path.basename(tgt)}"]`); }
      const label = count > 1 ? `|${count}|` : '';
      mermaidLines.push(`    ${sid} -->${label} ${tid}`);
      edgeCount++;
    }
  }

  // Also return textual summary
  const summary = topFiles.map(([fp, calls], i) => ({
    rank: i + 1, filepath: fp, total_calls: calls,
    targets: Object.keys(fileDeps[fp] || {}).length,
  }));

  jsonResponse(res, { mermaid: mermaidLines.join('\n'), files: Object.keys(nodeIds).length, edges: edgeCount, summary });
};


// --- File tree (deps of single file as Mermaid) ---

routes['/api/file-tree'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const fileArg = q.file;
  if (!fileArg) return errorResponse(res, 'Missing ?file= parameter');
  const depth = parseInt(q.depth) || 2;

  const filePattern = fileArg.replace(/\\/g, '/').toLowerCase();
  let fmatches = [...index.files.keys()].filter(fp => fp.replace(/\\/g, '/').toLowerCase().includes(filePattern));
  if (fmatches.length === 0) return errorResponse(res, `No files matching '${fileArg}'`, 404);
  if (fmatches.length > 1) {
    const bm = fmatches.filter(fp => path.basename(fp).toLowerCase() === path.basename(fileArg).toLowerCase());
    if (bm.length === 1) fmatches = bm;
    else return jsonResponse(res, { ambiguous: true, matches: fmatches.slice(0, 20) });
  }

  const targetFile = fmatches[0];
  const targetBase = path.basename(targetFile);
  index._ensureFunctionIndex();

  // Helper: outgoing deps
  function getOutDeps(fp) {
    const deps = {};
    if (!index.functionIndex[fp]) return deps;
    for (const [fname] of Object.entries(index.functionIndex[fp])) {
      const callees = index.findCallees(fname, fp);
      for (const ce of callees) {
        const bestDef = ce.resolved_def || (ce.definitions && ce.definitions[0]);
        if (bestDef && bestDef.filepath !== fp) deps[bestDef.filepath] = (deps[bestDef.filepath] || 0) + 1;
      }
    }
    return deps;
  }

  // Helper: incoming deps
  function getInDeps(fp) {
    const incoming = {};
    if (!index.functionIndex[fp]) return incoming;
    for (const fname of Object.keys(index.functionIndex[fp])) {
      let bare = fname.includes('::') ? fname.split('::').pop() : fname;
      bare = bare.includes('.') ? bare.split('.').pop() : bare;
      try {
        const callers = index.findCallers(bare, 100);
        for (const c of callers) { if (c.filepath !== fp) incoming[c.filepath] = (incoming[c.filepath] || 0) + 1; }
      } catch (_) {}
    }
    return incoming;
  }

  const nLines = (index.fileLines.get(targetFile) || []).length;
  const nFuncs = Object.keys(index.functionIndex[targetFile] || {}).length;
  const incoming = getInDeps(targetFile);

  const mermaidLines = ['flowchart LR'];
  const mfid = (fp) => {
    const b = path.basename(fp).replace(/[^a-zA-Z0-9_]/g, '_');
    return `f_${b}_${Buffer.from(fp).toString('base64').slice(0, 6)}`;
  };
  const nodes = new Set();
  const edges = [];
  const tid = mfid(targetFile);
  nodes.add(tid);
  mermaidLines.push(`    ${tid}[["${targetBase} (${nLines}L, ${nFuncs}fn)"]]`);

  // Incoming edges
  for (const [src, count] of Object.entries(incoming).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const sid = mfid(src);
    if (!nodes.has(sid)) { nodes.add(sid); mermaidLines.push(`    ${sid}["${path.basename(src)}"]`); }
    edges.push(`    ${sid} -->${count > 1 ? `|${count}|` : ''} ${tid}`);
  }

  // Outgoing edges (recursive to depth)
  const visited = new Set([targetFile]);
  function collectOut(fp, rem) {
    if (rem <= 0) return;
    const deps = getOutDeps(fp);
    const sid = mfid(fp);
    for (const [tgt, count] of Object.entries(deps).sort((a, b) => b[1] - a[1])) {
      const tgid = mfid(tgt);
      const tl = (index.fileLines.get(tgt) || []).length;
      if (!nodes.has(tgid)) { nodes.add(tgid); mermaidLines.push(`    ${tgid}["${path.basename(tgt)} (${tl}L)"]`); }
      edges.push(`    ${sid} -->${count > 1 ? `|${count}|` : ''} ${tgid}`);
      if (!visited.has(tgt) && rem > 1) { visited.add(tgt); collectOut(tgt, rem - 1); }
    }
  }
  collectOut(targetFile, depth);

  for (const e of edges) mermaidLines.push(e);
  mermaidLines.push(`    style ${tid} fill:#ff9,stroke:#333,stroke-width:3px`);

  jsonResponse(res, {
    target: targetFile, target_base: targetBase, lines: nLines, functions: nFuncs,
    incoming_count: Object.keys(incoming).length,
    mermaid: mermaidLines.join('\n'),
  });
};


// --- Call inventory ---

routes['/api/call-inventory'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const func = q.func || null;
  const result = index.getCallInventory(func || null, {
    includePath: q.include_path || null,
    excludePath: q.exclude_path || null,
  });
  const max = parseInt(q.max) || 50;
  jsonResponse(res, {
    summary: result.summary,
    in_index: result.in_index.slice(0, max).map(item => ({
      name: item.name, qualified_name: item.qualified_name,
      filepath: item.filepath, lines: item.lines,
      caller_count: item.callers.length,
    })),
    external: result.external.slice(0, max).map(item => ({
      name: item.name, call_count: item.call_sites.length,
      provenance: item.provenance || null,
    })),
  });
};


// --- Index extensions ---

routes['/api/index-extensions'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const extCounts = {};
  for (const fp of index.files.keys()) {
    const ext = path.extname(fp).toLowerCase() || '(none)';
    extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  const sorted = Object.entries(extCounts).sort((a, b) => b[1] - a[1]);
  jsonResponse(res, {
    total_files: index.files.size,
    extensions: sorted.map(([ext, count]) => ({ ext, count, pct: Math.round(count / index.files.size * 1000) / 10 })),
  });
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
    // .op files contain pseudo-functions from binary executables — treat as file-level
    if (m.filepath.endsWith('.op')) {
      unified.push({ scope: m.filepath, scope_type: 'file', filepath: m.filepath, function_name: null, matched_terms: m.terms_matched, total_terms: nPositive, lines: 0 });
    } else {
      unified.push({ scope: m.function, scope_type: 'function', filepath: m.filepath, function_name: m.function, matched_terms: m.terms_matched, total_terms: nPositive, lines: m.lines || 0 });
    }
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
  const type = q.type || 'literal'; // literal, regex, fast

  let results;
  if (type === 'fast' || type === 'regex') {
    results = index.searchInverted(query, { useRegex: type === 'regex', maxResults });
  } else {
    results = index.searchLiteral(query, { maxResults, contextLines });
  }
  jsonResponse(res, {
    query, type,
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
  if (q.filter) {
    const pat = q.filter.toLowerCase();
    classes = classes.filter(c =>
      c.name.toLowerCase().includes(pat)
      || c.filepath.toLowerCase().includes(pat)
      || (c.methods || []).some(m => {
        const bare = m.name.includes('::') ? m.name.split('::').pop() : m.name;
        return bare.toLowerCase().includes(pat) || m.name.toLowerCase().includes(pat);
      })
    );
  }
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
      instances: g.instances.map(inst => ({
        filepath: inst.filepath,
        name: inst.name,
        display_name: displayName(inst.name, inst.filepath),
        lines: inst.lines,
      })),
    })),
  });
};


// --- Funcstring (structural normalization) ---

routes['/api/funcstring'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const funcSpec = q.func;
  if (!funcSpec) return errorResponse(res, 'Missing ?func= parameter');
  const { funcName, fileHint } = parseFuncSpec(funcSpec);
  const matches = index.findFunctionMatches(funcName, fileHint);
  if (matches.length === 0) return errorResponse(res, `Function '${funcName}' not found`, 404);
  const m = matches[0];
  const source = index.getFunctionSource(m.filepath, m.name);
  if (!source) return errorResponse(res, 'Source not available', 404);
  const funcstring = index.getStructuralNormalized(source);
  jsonResponse(res, {
    filepath: m.filepath, name: m.name,
    display_name: displayName(m.name, m.filepath),
    lines: m.end - m.start + 1,
    funcstring,
  });
};


// --- Structural diff all ---

routes['/api/struct-diff-all'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const n = parseInt(q.n) || 30;
  index.getFuncDupes(n, 3, false);
  const groups = index.getStructDupes(n);
  const results = [];
  for (let i = 0; i < Math.min(groups.length, n); i++) {
    const g = groups[i];
    const bodies = g.instances.map(inst => {
      const src = index.getFunctionSource(inst.filepath, inst.name);
      return { filepath: inst.filepath, name: inst.name, body: src || '' };
    }).filter(b => b.body);
    let diff = null;
    if (bodies.length >= 2) {
      try { diff = index.structDiff(bodies); } catch { /* ignore */ }
    }
    results.push({
      rank: i + 1,
      name: g.bare_name,
      count: g.count,
      unique_bodies: g.unique_bodies || 0,
      lines: g.lines,
      summary: diff ? diff.summary : '(diff unavailable)',
      totalHoles: diff ? diff.totalWordHoles : 0,
      diffCount: diff ? diff.diffs.length : 0,
      substitutions: diff ? diff.substitutions.slice(0, 5) : [],
      instances: g.instances.slice(0, 6).map(inst => ({
        filepath: inst.filepath,
        name: inst.name,
        display_name: displayName(inst.name, inst.filepath),
      })),
    });
  }
  jsonResponse(res, { total: results.length, groups: results });
};


// --- Build LLM analysis prompt ---

routes['/api/build-prompt'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(); });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);
      const mode = params.mode;
      const mask = !!params.mask;
      const lineNumbers = !!params.lineNumbers;
      const masker = mask ? new SimpleMasker() : null;

      if (mode === 'analyze' || mode === 'claim-analyze' || mode === 'multisect-analyze') {
        // Function-level analysis
        const funcSpec = params.func;
        if (!funcSpec) return errorResponse(res, 'Missing "func" parameter');
        const { funcName, fileHint } = parseFuncSpec(funcSpec);
        const matches = index.findFunctionMatches(funcName, fileHint);
        if (matches.length === 0) return errorResponse(res, `Function '${funcName}' not found`, 404);
        const m = matches[0];
        let source = index.getFunctionSource(m.filepath, m.name);
        if (!source) return errorResponse(res, 'Source not available', 404);
        const lang = detectLanguage(m.filepath);
        if (mask) source = masker.maskFunctionSource(source, m.name, lang);
        if (lineNumbers) source = addLineNumbers(source, m.start);

        let prompt;
        if (mode === 'analyze') {
          prompt = buildAnalyzePrompt(source, m.name, m.filepath, mask);
        } else if (mode === 'claim-analyze') {
          const claim = params.claim;
          if (!claim) return errorResponse(res, 'Missing "claim" parameter');
          prompt = buildClaimAnalyzePrompt(source, m.name, m.filepath, claim, mask);
        } else {
          const terms = params.terms;
          if (!terms) return errorResponse(res, 'Missing "terms" parameter');
          const termList = typeof terms === 'string' ? terms.split(';').map(t => t.trim()).filter(Boolean) : terms;
          prompt = buildMultisectAnalyzePrompt(source, m.name, m.filepath, termList, mask);
        }
        jsonResponse(res, {
          mode, prompt,
          target: displayName(m.name, m.filepath),
          filepath: m.filepath,
          lines: m.end - m.start + 1,
        });

      } else if (mode === 'file-analyze') {
        const filePath = params.file;
        if (!filePath) return errorResponse(res, 'Missing "file" parameter');
        const pathMatches = index.findPathMatches(filePath);
        const exactFiles = pathMatches.filter(m => index.files.has(m));
        if (exactFiles.length === 0) return errorResponse(res, `File '${filePath}' not found`, 404);
        const fp = exactFiles[0];
        let source = index.files.get(fp) || '';
        const lang = detectLanguage(fp);
        if (mask) source = masker.mask(source, lang);
        if (lineNumbers) source = addLineNumbers(source);
        const funcNames = [...(index.functions.get(fp) || new Map()).keys()];
        const prompt = buildFileAnalyzePrompt(source, fp, mask, funcNames);
        jsonResponse(res, { mode, prompt, target: fp, filepath: fp });

      } else {
        return errorResponse(res, `Unknown mode: ${mode}`, 400);
      }
    } catch (err) {
      errorResponse(res, `Build prompt error: ${err.message}`, 500);
    }
  });
};


// --- Claim search (heuristic keyword extraction + multisect) ---

routes['/api/claim-search'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 500_000) req.destroy(); });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);
      const claim = params.claim;
      if (!claim) return errorResponse(res, 'Missing "claim" parameter');

      // Extract keywords heuristically (no LLM needed)
      const keywords = extractClaimKeywords(claim);
      if (keywords.size === 0) return errorResponse(res, 'No searchable keywords found in claim text');

      // Convert to multisect terms (each keyword as a separate search term)
      const termStrings = [...keywords].join(';');
      const parsed = parseMultisectTerms(termStrings);
      if (!parsed || parsed.length === 0) return errorResponse(res, 'No valid search terms parsed');

      const results = index.multisectSearch(parsed, { minTerms: 0 });
      const nPositive = parsed.filter(t => !t.negated).length;

      const unified = [];
      for (const m of (results.function_matches || [])) {
        if (m.function === '(global)') continue;
        if (m.filepath.endsWith('.op')) {
          unified.push({ scope: m.filepath, scope_type: 'file', filepath: m.filepath, function_name: null, matched_terms: m.terms_matched, total_terms: nPositive, lines: 0 });
        } else {
          unified.push({ scope: m.function, scope_type: 'function', filepath: m.filepath, function_name: m.function, matched_terms: m.terms_matched, total_terms: nPositive, lines: m.lines || 0 });
        }
      }
      for (const m of (results.file_matches || [])) {
        unified.push({ scope: m.filepath, scope_type: 'file', filepath: m.filepath, function_name: null, matched_terms: m.terms_matched, total_terms: nPositive, lines: 0 });
      }
      unified.sort((a, b) => b.matched_terms - a.matched_terms || b.lines - a.lines);
      const maxResults = parseInt(params.max) || 25;

      jsonResponse(res, {
        keywords: [...keywords],
        terms: parsed.map(t => ({ display: t.display, negated: t.negated })),
        term_file_counts: results.term_file_counts || [],
        results: unified.slice(0, maxResults).map((r, i) => ({ rank: i + 1, ...r })),
      });
    } catch (err) {
      errorResponse(res, `Claim search error: ${err.message}`, 500);
    }
  });
};


// --- Claim extraction prompt (LLM prompt builder for claim-search) ---

routes['/api/claim-extraction-prompt'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 500_000) req.destroy(); });
  req.on('end', () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);
      const claim = params.claim;
      if (!claim) return errorResponse(res, 'Missing "claim" parameter');
      const claimRes = resolveAtFile(claim);
      if (claimRes.error) return errorResponse(res, claimRes.error, 400);
      const claimText = claimRes.text;

      const engine = params.engine || 'claude';   // 'claude' or 'local'
      const vocabTight = !!params.vocabTight;
      const noVocab = !!params.noVocabulary;

      // Extract heuristic keywords for vocabulary filtering
      const claimKeywords = extractClaimKeywords(claimText);

      // Build vocabulary concordance
      let vocabConcordance = '';
      if (!noVocab) {
        try {
          const format = engine === 'local' ? 'compact' : 'rich';
          vocabConcordance = index.formatVocabularyForPrompt(format, {
            topN: engine === 'local' ? 200 : 300,
            maxSubTokens: engine === 'local' ? 80 : 150,
            maxFuncNames: engine === 'local' ? 0 : 40,
            claimKeywords,
          });
        } catch (e) {
          // Vocabulary is optional
        }
      }

      // Build the extraction prompt
      let systemPrompt;
      if (engine === 'local') {
        systemPrompt = vocabConcordance
          ? buildLocalExtractionPromptWithVocab(vocabConcordance, vocabTight)
          : CLAIM_EXTRACTION_PROMPT_LOCAL;
      } else {
        systemPrompt = vocabConcordance
          ? buildExtractionPromptWithVocab(vocabConcordance, vocabTight)
          : CLAIM_EXTRACTION_PROMPT;
      }

      jsonResponse(res, {
        systemPrompt,
        userMessage: claimText.trim(),
        keywords: [...claimKeywords],
        vocabChars: vocabConcordance.length,
        engine,
      });
    } catch (err) {
      errorResponse(res, `Extraction prompt error: ${err.message}`, 500);
    }
  });
};


// --- LLM-powered claim search (term extraction + multisect) ---

routes['/api/claim-search-llm'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 500_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);

      const claim = params.claim;
      if (!claim) return errorResponse(res, 'Missing "claim" parameter');

      // Resolve @filepath references in claim text
      const claimResolved = resolveAtFile(claim);
      if (claimResolved.error) return errorResponse(res, claimResolved.error, 400);
      const claimText = claimResolved.text;

      const engine = params.engine || 'claude';
      const vocabTight = !!params.vocabTight;
      const noVocab = !!params.noVocabulary;
      const temperature = params.temperature ?? serverArgs.temperature;
      const maxResults = parseInt(params.max) || 25;
      const userMinTerms = parseInt(params.minTerms) || 0;  // 0 = auto

      // Check LLM availability
      const avail = serverLLM.checkAvailability(engine);
      if (!avail.available) return errorResponse(res, avail.reason, 400);

      console.log(`  [claim-search-llm] engine=${engine}, claim=${claimText.length} chars${claimResolved.resolvedFrom ? ' (from ' + claimResolved.resolvedFrom + ')' : ''}`);

      // --- Build vocabulary concordance ---
      let vocabConcordance = '';
      const claimKeywords = extractClaimKeywords(claimText);
      if (!noVocab) {
        try {
          const format = engine === 'local' ? 'compact' : 'rich';
          vocabConcordance = index.formatVocabularyForPrompt(format, {
            topN: engine === 'local' ? 200 : 300,
            maxSubTokens: engine === 'local' ? 80 : 150,
            maxFuncNames: engine === 'local' ? 0 : 40,
            claimKeywords,
          });
        } catch (e) { /* vocabulary is optional */ }
      }

      // --- Build extraction prompt ---
      let systemPrompt;
      if (engine === 'local') {
        systemPrompt = vocabConcordance
          ? buildLocalExtractionPromptWithVocab(vocabConcordance, vocabTight)
          : CLAIM_EXTRACTION_PROMPT_LOCAL;
      } else {
        systemPrompt = vocabConcordance
          ? buildExtractionPromptWithVocab(vocabConcordance, vocabTight)
          : CLAIM_EXTRACTION_PROMPT;
      }

      // For local models with limited context, use first claim only
      let claimForLLM = claimText.trim();
      let skippedClaims = 0;
      if (engine === 'local') {
        const { text, skipped } = extractFirstClaim(claimForLLM);
        claimForLLM = text;
        skippedClaims = skipped;
      }

      // --- Call LLM for term extraction ---
      console.log(`  [claim-search-llm] Calling ${engine} for term extraction...`);
      const userMessage = engine === 'local'
        ? 'Extract search terms from this patent claim:\n\n' + claimForLLM
        : claimForLLM;
      const llmResult = await serverLLM.call(engine, systemPrompt, userMessage, {
        apiKey: params.apiKey,
        temperature,
        maxTokens: 2048,
      });

      if (llmResult.error) {
        return errorResponse(res, `LLM error: ${llmResult.error}`, 502);
      }

      // --- Parse TIGHT / BROAD from LLM response ---
      const rawResponse = llmResult.text;
      console.log(`  [claim-search-llm] Raw LLM response:\n    ${rawResponse.replace(/\n/g, '\n    ')}`);
      const parsed = parseTermResponse(rawResponse);
      let tightStr = parsed.tight;
      let broadStr = parsed.broad;

      // Sanitize
      if (tightStr) tightStr = sanitizeLlmTerms(tightStr, 'TIGHT');
      if (broadStr) broadStr = sanitizeLlmTerms(broadStr, 'BROAD');
      if (broadStr) broadStr = sanitizeBroadTerms(broadStr);

      // --- Run multisect for TIGHT ---
      let tightResults = null;
      let tightTerms = null;
      if (tightStr) {
        tightTerms = parseMultisectTerms(tightStr);
        if (tightTerms && tightTerms.length > 0) {
          const positiveTerms = tightTerms.filter(t => !t.negated);
          const minTerms = userMinTerms > 0 ? userMinTerms : Math.max(Math.floor(positiveTerms.length * 0.80), 2);
          tightResults = _multisectToUnified(index, tightTerms, minTerms, maxResults);
          console.log(`  [claim-search-llm] TIGHT: ${positiveTerms.length} positive terms, min=${minTerms}${userMinTerms > 0 ? ' (user)' : ''}, ${tightResults.results.length} results`);
        }
      }

      // --- Run multisect for BROAD ---
      let broadResults = null;
      let broadTermsParsed = null;
      if (broadStr) {
        broadTermsParsed = parseMultisectTerms(broadStr);
        if (broadTermsParsed && broadTermsParsed.length > 0) {
          const positiveTerms = broadTermsParsed.filter(t => !t.negated);
          const minTerms = userMinTerms > 0 ? userMinTerms : Math.max(Math.floor(positiveTerms.length * 0.60), 3);
          broadResults = _multisectToUnified(index, broadTermsParsed, minTerms, maxResults);
          console.log(`  [claim-search-llm] BROAD: ${positiveTerms.length} positive terms, min=${minTerms}${userMinTerms > 0 ? ' (user)' : ''}, ${broadResults.results.length} results`);
        }
      }

      // --- Build response ---
      jsonResponse(res, {
        engine,
        raw: rawResponse,
        skippedClaims,
        vocabChars: vocabConcordance.length,
        usage: llmResult.usage || null,
        tight: tightStr ? {
          termsStr: tightStr,
          terms: (tightTerms || []).map(t => ({ display: t.display, negated: t.negated })),
          term_file_counts: tightResults ? tightResults.term_file_counts : [],
          results: tightResults ? tightResults.results : [],
        } : null,
        broad: broadStr ? {
          termsStr: broadStr,
          terms: (broadTermsParsed || []).map(t => ({ display: t.display, negated: t.negated })),
          term_file_counts: broadResults ? broadResults.term_file_counts : [],
          results: broadResults ? broadResults.results : [],
        } : null,
      });
    } catch (err) {
      console.error('  [claim-search-llm] Error:', err);
      errorResponse(res, `Claim search LLM error: ${err.message}`, 500);
    }
  });
};


// --- LLM-powered code analysis ---

routes['/api/analyze-llm'] = (req, res) => {
  if (req.method !== 'POST') return errorResponse(res, 'POST required', 405);
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 500_000) req.destroy(); });
  req.on('end', async () => {
    try {
      const params = JSON.parse(body);
      const index = mgr.get(params.index);
      if (!index) return errorResponse(res, 'No index loaded', 404);

      const engine = params.engine || 'claude';
      const mode = params.mode || 'analyze';  // 'analyze' | 'claim-analyze' | 'multisect-analyze' | 'context-analyze' | 'file-analyze'
      const mask = !!params.mask;
      const lineNumbers = params.lineNumbers !== false;
      const temperature = params.temperature ?? serverArgs.temperature;

      // Check LLM availability
      const avail = serverLLM.checkAvailability(engine);
      if (!avail.available) return errorResponse(res, avail.reason, 400);

      let prompt, target, filepath, lines;

      if (mode === 'file-analyze') {
        // --- File-level analysis ---
        const filePath = params.file;
        if (!filePath) return errorResponse(res, 'Missing "file" parameter');
        const pathMatches = index.findPathMatches(filePath);
        const exactFiles = pathMatches.filter(m => index.files.has(m));
        if (exactFiles.length === 0) return errorResponse(res, `File '${filePath}' not found`, 404);
        const fp = exactFiles[0];
        let source = index.files.get(fp) || '';
        const nLines = source.split('\n').length;
        const maxLines = engine === 'local' ? 200 : 500;
        if (nLines > maxLines) return errorResponse(res, `File too large (${nLines} lines, max ${maxLines} for ${engine})`, 400);
        const lang = detectLanguage(fp);
        const masker = new SimpleMasker();
        if (mask) source = masker.mask(source, lang);
        if (lineNumbers) source = addLineNumbers(source);
        const funcNames = [...(index.functions.get(fp) || new Map()).keys()];
        prompt = buildFileAnalyzePrompt(source, fp, mask, funcNames);
        target = fp;
        filepath = fp;
        lines = nLines;
        console.log(`  [analyze-llm] file-analyze on ${fp} (${nLines} lines), engine=${engine}`);

      } else {
        // --- Function-level analysis ---
        const funcSpec = params.func;
        if (!funcSpec) return errorResponse(res, 'Missing "func" parameter');
        const { funcName, fileHint } = parseFuncSpec(funcSpec);
        const matches = index.findFunctionMatches(funcName, fileHint);
        if (matches.length === 0) return errorResponse(res, `Function '${funcName}' not found`, 404);
        const m = matches[0];

        let source = index.getFunctionSource(m.filepath, m.name);
        if (!source) return errorResponse(res, 'Source not available', 404);

        const lang = detectLanguage(m.filepath);
        const masker = new SimpleMasker();
        if (mask) source = masker.maskFunctionSource(source, m.name, lang);
        if (lineNumbers) source = addLineNumbers(source, m.start);

        if (mode === 'claim-analyze') {
          let claim = params.claim;
          if (!claim) return errorResponse(res, 'Missing "claim" parameter');
          const claimRes = resolveAtFile(claim);
          if (claimRes.error) return errorResponse(res, claimRes.error, 400);
          prompt = buildClaimAnalyzePrompt(source, m.name, m.filepath, claimRes.text, mask);
        } else if (mode === 'multisect-analyze') {
          const terms = params.terms;
          if (!terms) return errorResponse(res, 'Missing "terms" parameter');
          const termList = typeof terms === 'string' ? terms.split(';').map(t => t.trim()).filter(Boolean) : terms;
          prompt = buildMultisectAnalyzePrompt(source, m.name, m.filepath, termList, mask);
        } else if (mode === 'context-analyze') {
          let contextText = params.contextText;
          if (!contextText) return errorResponse(res, 'Missing "contextText" parameter');
          const ctxResolved = resolveAtFile(contextText);
          if (ctxResolved.error) return errorResponse(res, ctxResolved.error, 400);
          contextText = ctxResolved.text;
          prompt = buildContextAnalyzePrompt(source, m.name, m.filepath, contextText, mask);
        } else {
          prompt = buildAnalyzePrompt(source, m.name, m.filepath, mask);
        }

        target = displayName(m.name, m.filepath);
        filepath = m.filepath;
        lines = m.end - m.start + 1;
        console.log(`  [analyze-llm] ${mode} on ${m.filepath}@${m.name} (${lines} lines), engine=${engine}`);
      }

      // --- Call LLM ---
      const systemMsg = 'You are a code analysis assistant. Be precise and concise.';
      const llmResult = await serverLLM.call(engine, systemMsg, prompt, {
        apiKey: params.apiKey,
        temperature,
        maxTokens: engine === 'local' ? 600 : 800,
      });

      if (llmResult.error) {
        return errorResponse(res, `LLM error: ${llmResult.error}`, 502);
      }

      jsonResponse(res, {
        mode, engine,
        analysis: llmResult.text,
        prompt,
        target, filepath, lines,
        usage: llmResult.usage || null,
      });
    } catch (err) {
      console.error('  [analyze-llm] Error:', err);
      errorResponse(res, `Analyze LLM error: ${err.message}`, 500);
    }
  });
};


/** Helper: run multisect and format results into unified array. */
function _multisectToUnified(index, terms, minTerms, maxResults) {
  const results = index.multisectSearch(terms, { minTerms });
  const nPositive = terms.filter(t => !t.negated).length;
  const unified = [];
  for (const m of (results.function_matches || [])) {
    if (m.function === '(global)') continue;
    if (m.filepath.endsWith('.op')) {
      unified.push({
        scope: m.filepath, scope_type: 'file', filepath: m.filepath,
        function_name: null, matched_terms: m.terms_matched,
        total_terms: nPositive, lines: 0,
      });
    } else {
      unified.push({
        scope: m.function, scope_type: 'function', filepath: m.filepath,
        function_name: m.function, matched_terms: m.terms_matched,
        total_terms: nPositive, lines: m.lines || 0,
      });
    }
  }
  for (const m of (results.file_matches || [])) {
    unified.push({
      scope: m.filepath, scope_type: 'file', filepath: m.filepath,
      function_name: null, matched_terms: m.terms_matched,
      total_terms: nPositive, lines: 0,
    });
  }
  for (const m of (results.folder_matches || [])) {
    unified.push({
      scope: m.folder, scope_type: 'folder', filepath: m.folder,
      function_name: null, matched_terms: m.terms_matched,
      total_terms: nPositive, lines: 0,
    });
  }
  unified.sort((a, b) => b.matched_terms - a.matched_terms || b.lines - a.lines);
  return {
    terms: terms.map(t => ({ display: t.display, negated: t.negated })),
    term_file_counts: results.term_file_counts || [],
    results: unified.slice(0, maxResults).map((r, i) => ({ rank: i + 1, ...r })),
  };
}


// ========================================================================
// Universal command execution via interactive dispatch
// ========================================================================

routes['/api/exec'] = (req, res) => {
  const q = parseQuery(req.url);
  const index = mgr.get(q.index);
  if (!index) return errorResponse(res, 'No index loaded', 404);
  const cmd = q.cmd || q.command || '';
  if (!cmd) return errorResponse(res, 'Missing ?cmd= parameter');
  const max = parseInt(q.max) || 25;

  const opts = {
    max,
    verbose: q.verbose === 'true',
    fullPath: q.fullpath === 'true',
    showDupes: q.showdupes === 'true',
    // LLM passthrough
    use_claude: !!serverLLM.defaultApiKey,
    api_key: serverLLM.defaultApiKey || null,
    analyze_model: serverArgs.modelPath || null,
    claim_model: serverArgs.modelPath || null,
    temperature: serverArgs.temperature || 0.0,
    mask_all: q.mask_all === 'true',
    line_numbers: q.line_numbers === 'true',
  };

  execCommand(index, cmd, opts).then(output => {
    jsonResponse(res, { command: cmd, output });
  }).catch(err => {
    errorResponse(res, `Exec error: ${err.message}`, 500);
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
  // LLM status
  if (serverArgs.modelPath) {
    console.log(`  Local model: ${serverArgs.modelPath}`);
  }
  if (serverLLM.defaultApiKey) {
    console.log(`  Claude API:  key configured (${serverLLM.defaultApiKey.slice(0, 10)}...)`);
  } else {
    console.log(`  Claude API:  no key (set ANTHROPIC_API_KEY or --api-key)`);
  }
  if (serverArgs.temperature > 0) {
    console.log(`  Temperature: ${serverArgs.temperature}`);
  }
  console.log(`\nPress Ctrl+C to stop.\n`);
});
