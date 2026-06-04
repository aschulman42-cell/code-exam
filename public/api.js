/**
 * api.js — Fetch wrappers for the Code Exam server's /api/* endpoints.
 *
 * `api.get` and `api.post` are the primitives; the named methods below are
 * thin convenience wrappers. Default timeout is 5 minutes — large indexes
 * can be slow on cold load.
 */

export const api = {
  async get(endpoint, params = {}, opts = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `/api/${endpoint}${qs ? '?' + qs : ''}`;
    const timeout = opts.timeout || 300000;  // 5 min default (large indexes need time)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Request timed out (${Math.round(timeout/1000)}s) — server may still be processing a large index scan`);
      throw e;
    }
  },
  async post(endpoint, body, opts = {}) {
    const timeout = opts.timeout || 300000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`Request timed out (${Math.round(timeout/1000)}s) — server may still be processing`);
      throw e;
    }
  },
  stats:           (p) => api.get('stats', p),
  listFiles:       (p) => api.get('list-files', p),
  listFunctions:   (p) => api.get('list-functions', p),
  fileFunctions:   (p) => api.get('file-functions', p),
  extract:         (p) => api.get('extract', p),
  showFile:        (p) => api.get('show-file', p),
  hotspots:        (p) => api.get('hotspots', p),
  hotFolders:      (p) => api.get('hot-folders', p),
  entryPoints:     (p) => api.get('entry-points', p),
  domainFns:       (p) => api.get('domain-fns', p),
  gaps:            (p) => api.get('gaps', p),
  mostCalled:      (p) => api.get('most-called', p),
  classHotspots:   (p) => api.get('class-hotspots', p),
  classHierarchy:  (p) => api.get('class-hierarchy', p),
  callers:         (p) => api.get('callers', p),
  callees:         (p) => api.get('callees', p),
  callTree:        (p) => api.get('call-tree', p),
  multisect:       (p) => api.get('multisect', p),
  search:          (p) => api.get('search', p),
  vocabulary:      (p) => api.get('vocabulary', p),
  listClasses:     (p) => api.get('list-classes', p),
  listModels:      (p) => api.get('list-models', p),
  listArtifacts:   (p) => api.get('list-artifacts', p),
  listKernels:     (p) => api.get('list-kernels', p),
  listDatasets:    (p) => api.get('list-datasets', p),
  listTraining:    (p) => api.get('list-training', p),
  listInference:   (p) => api.get('list-inference', p),
  listLlmCalls:    (p) => api.get('list-llm-calls', p),
  listTools:       (p) => api.get('list-tools', p),
  listChains:      (p) => api.get('list-chains', p),
  listEmbeddings:  (p) => api.get('list-embeddings', p),
  listStructuredOutput: (p) => api.get('list-structured-output', p),
  listModelsUsed:  (p) => api.get('list-models-used', p),
  classMethods:    (p) => api.get('class-methods', p),
  filesSearch:     (p) => api.get('files-search', p),
  funcDupes:       (p) => api.get('func-dupes', p),
  nearDupes:       (p) => api.get('near-dupes', p),
  structDupes:     (p) => api.get('struct-dupes', p),
  funcstring:      (p) => api.get('funcstring', p),
  funcstringPeers: (p) => api.get('funcstring-peers', p),
  surprisingFuncstrings: (p) => api.get('surprising-funcstrings', p),
  structDiffAll:   (p) => api.get('struct-diff-all', p),
  stringTable:     (p) => api.get('string-table', p),
  prompts:         (p) => api.get('prompts', p),
  commandCatalog:  ()  => api.get('command-catalog'),
  breadcrumbs:     ()  => api.get('breadcrumbs'),
  bundleSeams:     (p) => api.get('bundle-seams', p),
  digest:          (p) => api.get('digest', p),
  buildPrompt:     (p) => api.post('build-prompt', p),
  claimSearch:     (p) => api.post('claim-search', p),
  claimSearchLlm:  (p) => api.post('claim-search-llm', p),
  analyzeLlm:      (p) => api.post('analyze-llm', p),
  claimExtractionPrompt: (p) => api.post('claim-extraction-prompt', p),
  llmStatus:       ()  => api.get('llm-status'),
  browseDir:       (p) => api.get('browse-dir', p),
  indexes:         ()  => api.get('indexes'),
  scanIndexes:     (p) => api.get('scan-indexes', p),
  loadIndex:       (p) => api.post('load-index', p, { timeout: 600000 }),  // 10 min for huge indexes
  buildIndex:      (p) => api.post('build-index', p),
  buildIndexStatus:(p) => api.get('build-index-status', p),
  fileMap:         (p) => api.get('file-map', p),
  fileTree:        (p) => api.get('file-tree', p),
  callInventory:   (p) => api.get('call-inventory', p),
  indexExtensions: (p) => api.get('index-extensions', p),
  scanModels:      (p) => api.get('scan-models', p),
  switchModel:     (p) => api.post('switch-model', p),
  version:         ()  => api.get('version'),
};
