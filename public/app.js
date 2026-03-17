/**
 * app.js - Code Exam GUI client.
 * Zero external dependencies. Pure DOM manipulation.
 */
'use strict';

// ========================================================================
// Global state
// ========================================================================
const state = {
  sectionData: {},       // section-id -> loaded data
  contextTarget: null,   // right-click target
  diagramZoom: 1.0,
  lastMermaidText: null,
  lastMermaidRoot: null,
  _filterTimer: null,
  /** Search context: what terms to highlight in source views.
   *  { terms: string[], colors: string[] }  */
  highlightTerms: null,
  lastIndexDir: null,    // parent dir of last-loaded index (for scan-indexes)
  /** Filepath of currently displayed source (for disambiguation context) */
  currentSourceFile: null,
  /** Cached LLM engine status from /api/llm-status */
  llmStatus: null,
  /** Most Called: filter to in-index only */
  mostCalledDefinedOnly: false,
};

// ========================================================================
// API layer
// ========================================================================
const api = {
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
  classMethods:    (p) => api.get('class-methods', p),
  filesSearch:     (p) => api.get('files-search', p),
  funcDupes:       (p) => api.get('func-dupes', p),
  nearDupes:       (p) => api.get('near-dupes', p),
  structDupes:     (p) => api.get('struct-dupes', p),
  funcstring:      (p) => api.get('funcstring', p),
  structDiffAll:   (p) => api.get('struct-diff-all', p),
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
};

// ========================================================================
// DOM helpers
// ========================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child) el.appendChild(child);
  }
  return el;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortPath(fp, maxLen = 45) {
  if (!fp) return '';
  fp = fp.replace(/\\/g, '/');
  return fp.length <= maxLen ? fp : '…' + fp.slice(-(maxLen - 1));
}

/** Colors for multi-term highlighting (up to 8 terms) */
const HIGHLIGHT_COLORS = [
  '#8B8000',   // dark yellow
  '#2E6B2E',   // dark green
  '#6B2E6B',   // dark purple
  '#2E4B6B',   // dark blue
  '#6B4B2E',   // dark orange
  '#2E6B6B',   // dark cyan
  '#6B2E4B',   // dark magenta
  '#4B6B2E',   // olive
];

/**
 * Highlight search terms in an already-escaped HTML line.
 * Returns HTML string with <mark> tags wrapping matches.
 * Each term gets a distinct background color.
 */
function highlightLine(escapedHtml, terms, colors) {
  if (!terms || !terms.length) return escapedHtml;
  let result = escapedHtml;
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (!term) continue;
    // Build regex: escape special chars, case-insensitive
    // Term might be a regex pattern (from multisect /pattern/), strip leading/trailing slashes
    let pattern = term.replace(/^\/|\/$/g, '');
    // Escape for use in regex (but keep . and * if from regex pattern)
    const isRegex = term.startsWith('/') && term.endsWith('/');
    if (!isRegex) {
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    try {
      const re = new RegExp(`(${pattern})`, 'gi');
      const bg = colors[i % colors.length];
      result = result.replace(re, `<mark style="background:${bg};color:#fff;padding:0 1px;border-radius:1px">$1</mark>`);
    } catch { /* invalid regex, skip */ }
  }
  return result;
}


// ========================================================================
// Accordion left pane
// ========================================================================
function initAccordion() {
  for (const section of $$('.accordion-section')) {
    const header = $('.accordion-header', section);
    header.addEventListener('click', () => toggleSection(section));
  }
}

function toggleSection(section) {
  const sectionId = section.dataset.section;
  const wasOpen = section.classList.contains('open');
  section.classList.toggle('open');

  if (!wasOpen) {
    // Always (re)load with current filter value when opening
    const filter = $('#left-filter').value.trim();
    loadSectionData(sectionId, filter);
  }
}

async function loadSectionData(sectionId, filter = '') {
  const section = $(`.accordion-section[data-section="${sectionId}"]`);
  const content = $('.accordion-content', section);
  const badge = $('.accordion-badge', section);
  content.innerHTML = '<div class="loading">Loading…</div>';

  try {
    let data;
    switch (sectionId) {
      case 'functions':
        data = await api.listFunctions({ filter, sort: 'lines', max: 300 });
        state.sectionData[sectionId] = data.functions;
        renderFunctionList(content, data.functions, data.total);
        badge.textContent = data.total;
        break;

      case 'files':
        data = await api.listFiles({ filter, max: 500 });
        state.sectionData[sectionId] = data.files;
        renderFileListWithSub(content, data.files, data.total);
        badge.textContent = data.total;
        break;

      case 'extensions':
        data = await api.indexExtensions();
        state.sectionData[sectionId] = data.extensions;
        renderExtensionList(content, data.extensions, data.total_files, filter);
        badge.textContent = data.extensions.length;
        break;

      case 'classes':
        data = await api.listClasses({ filter, max: 200 });
        state.sectionData[sectionId] = data.classes;
        renderClassListWithSub(content, data.classes, data.total);
        badge.textContent = data.total;
        break;

      case 'class-hierarchy':
        data = await api.classHierarchy({ filter });
        state.sectionData[sectionId] = data;
        renderClassHierarchy(content, data);
        badge.textContent = data.totalRelationships || 0;
        break;

      case 'hotspots':
        data = await api.hotspots({ n: 50, filter });
        state.sectionData[sectionId] = data.hotspots;
        renderFuncLikeList(content, data.hotspots, 'score');
        badge.textContent = data.hotspots.length;
        break;

      case 'hot-folders':
        data = await api.hotFolders({ n: 50, filter });
        state.sectionData[sectionId] = data.folders;
        renderHotFolderList(content, data.folders);
        badge.textContent = data.folders.length;
        break;

      case 'most-called':
        data = await api.mostCalled({ n: 50, filter, defined_only: state.mostCalledDefinedOnly ? '1' : '' });
        state.sectionData[sectionId] = data.functions;
        renderMostCalledList(content, data.functions, data.total, sectionId, filter);
        badge.textContent = data.total;
        break;

      case 'call-inventory':
        data = await api.callInventory({ max: 100, filter });
        state.sectionData[sectionId] = data;
        renderCallInventory(content, data);
        badge.textContent = data.summary.external_count;
        break;

      case 'class-hotspots':
        data = await api.classHotspots({ n: 50, filter });
        state.sectionData[sectionId] = data.classes;
        renderClassHotspotList(content, data.classes);
        badge.textContent = data.classes.length;
        break;

      case 'entry-points':
        data = await api.entryPoints({ n: 50, filter });
        state.sectionData[sectionId] = data.entries;
        renderFuncLikeList(content, data.entries, 'lines');
        badge.textContent = data.entries.length;
        break;

      case 'domain-fns':
        data = await api.domainFns({ n: 50, filter });
        state.sectionData[sectionId] = data.functions;
        renderFuncLikeList(content, data.functions, 'score');
        badge.textContent = data.functions.length;
        break;

      case 'gaps':
        data = await api.gaps({ n: 100, filter });
        state.sectionData[sectionId] = data.gaps;
        renderFuncLikeList(content, data.gaps, 'lines');
        badge.textContent = data.total;
        break;

      case 'vocabulary':
        data = await api.vocabulary({ n: 100, filter });
        state.sectionData[sectionId] = data.vocabulary;
        renderVocabList(content, data.vocabulary);
        badge.textContent = data.vocabulary.length;
        break;

      case 'func-dupes':
        data = await api.funcDupes({ n: 30, filter });
        state.sectionData[sectionId] = data.groups;
        renderDupeGroupList(content, data.groups, 'exact');
        badge.textContent = data.total;
        break;

      case 'near-dupes':
        data = await api.nearDupes({ n: 30, filter });
        state.sectionData[sectionId] = data.groups;
        renderDupeGroupList(content, data.groups, 'near');
        badge.textContent = data.total;
        break;

      case 'struct-dupes':
        data = await api.structDupes({ n: 30, filter });
        state.sectionData[sectionId] = data.groups;
        renderDupeGroupList(content, data.groups, 'struct');
        badge.textContent = data.total;
        break;

      case 'struct-diff':
        data = await api.structDiffAll({ n: 30, filter });
        state.sectionData[sectionId] = data.groups;
        renderStructDiffList(content, data.groups);
        badge.textContent = data.total;
        break;

      case 'indexes':
        data = await api.scanIndexes(state.lastIndexDir ? { dir: state.lastIndexDir } : undefined);
        renderIndexesList(content, data);
        badge.textContent = (data.loaded || []).length + '/' + (data.available || []).length;
        break;

      case 'file-map':
        data = await api.fileMap({ filter });
        state.sectionData[sectionId] = data;
        renderFileMapList(content, data);
        badge.textContent = data.files || 0;
        // Also render diagram
        if (data.mermaid && data.files > 0) {
          const body = $('#right-top-body'), ttl = $('#right-top-title');
          ttl.textContent = 'File Dependency Map';
          body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>';
          renderMermaid(data.mermaid, $('#diagram-viewport'), null, {
            onNodeClick: (nodeId, label) => {
              // Click a file node: show file in source pane
              onFileClick(label);
            },
            onEdgeClick: (edgeId, labelText, nodeIdMap) => {
              openFileMapEdgeDetail(edgeId, labelText, nodeIdMap);
            },
          });
          showPane('right-top');
        }
        break;

      case 'call-inventory':
        data = await api.callInventory({ max: 100 });
        state.sectionData[sectionId] = data;
        renderCallInventoryList(content, data);
        badge.textContent = data.summary ? `${data.summary.in_index_count}+${data.summary.external_count}` : '';
        break;

      case 'index-extensions':
        data = await api.indexExtensions({});
        state.sectionData[sectionId] = data;
        renderExtensionsList(content, data);
        badge.textContent = data.extensions?.length || 0;
        break;
    }
  } catch (err) {
    content.innerHTML = `<div class="error-msg">${escHtml(err.message)}</div>`;
  }
  updateOverflowHint(section);
}

/** Add/remove 'has-overflow' class to show bottom fade when content is scrollable */
function updateOverflowHint(section) {
  const content = $('.accordion-content', section);
  if (!content) return;
  const hasMore = content.scrollHeight > content.clientHeight + 4
    && (content.scrollTop + content.clientHeight < content.scrollHeight - 4);
  section.classList.toggle('has-overflow', hasMore);
  if (!content._overflowWired) {
    content._overflowWired = true;
    content.addEventListener('scroll', () => {
      const atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 4;
      section.classList.toggle('has-overflow', !atBottom && content.scrollHeight > content.clientHeight + 4);
    });
  }
}


// ========================================================================
// List renderers — shared function-like list (hotspots, entry-points, domain-fns, gaps)
// ========================================================================

function renderFuncLikeList(container, items, metricKey) {
  container.innerHTML = '';
  if (!items.length) { container.innerHTML = '<div class="list-placeholder">None found</div>'; return; }
  for (const f of items) {
    const metricVal = metricKey === 'score' ? f.score : f.lines;
    const item = h('div', { className: 'list-item', title: `${f.filepath}\n${f.display_name || f.name}\n${metricKey}: ${metricVal}` }, [
      f.rank != null ? h('span', { className: 'rank', text: `${f.rank}` }) : null,
      h('span', { className: 'metric', text: `${metricVal}` }),
      h('span', { className: 'name clickable', text: f.display_name || f.name }),
      h('span', { className: 'metric muted', text: `${f.lines || ''}L` }),
    ].filter(Boolean));
    item.addEventListener('click', () => onFunctionClick(f));
    item.addEventListener('contextmenu', (e) => showContextMenu(e, f));
    container.appendChild(item);
  }
}


// ========================================================================
// Functions list
// ========================================================================
function renderFunctionList(container, functions, total) {
  container.innerHTML = '';
  if (!functions.length) { container.innerHTML = '<div class="list-placeholder">No functions found</div>'; return; }
  for (const f of functions) {
    const item = h('div', { className: 'list-item', title: `${f.filepath}\n${f.display_name}\n${f.lines} lines` }, [
      h('span', { className: 'metric', text: `${f.lines}` }),
      h('span', { className: 'name clickable', text: f.display_name }),
      h('span', { className: 'filepath', text: f.filepath?.replace(/\\/g, '/') || '' }),
    ]);
    item.addEventListener('click', () => onFunctionClick(f));
    item.addEventListener('contextmenu', (e) => showContextMenu(e, f));
    container.appendChild(item);
  }
  if (total > functions.length) container.appendChild(h('div', { className: 'list-placeholder', text: `${functions.length} of ${total} shown` }));
}


// ========================================================================
// Files list — with sub-accordion to show functions in each file
// ========================================================================

function renderFileListWithSub(container, files, total) {
  container.innerHTML = '';
  if (!files.length) { container.innerHTML = '<div class="list-placeholder">No files found</div>'; return; }

  for (const fp of files) {
    const name = fp.replace(/\\/g, '/').split('/').pop();
    const dir = fp.replace(/\\/g, '/').split('/').slice(0, -1).join('/');

    const subContent = h('div', { className: 'sub-accordion-content' });
    const nameSpan = h('span', { className: 'name clickable', text: name, style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' });
    const subHeader = h('div', { className: 'sub-accordion-header' }, [
      h('span', { className: 'sub-accordion-toggle', text: '▸' }),
      nameSpan,
      h('span', { className: 'filepath', text: dir, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
    ]);
    const sub = h('div', { className: 'sub-accordion', 'data-filepath': fp }, [subHeader, subContent]);

    // Click filename: show file source in middle-bottom pane
    nameSpan.addEventListener('click', (e) => {
      e.stopPropagation();
      onFileClick(fp);
    });

    // Click toggle arrow or header background: expand/collapse functions
    subHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = sub.classList.contains('open');
      sub.classList.toggle('open');
      if (!wasOpen && subContent.children.length === 0) {
        loadFileFunctions(fp, subContent);
      }
      const parentSection = sub.closest('.accordion-section');
      if (parentSection) setTimeout(() => updateOverflowHint(parentSection), 50);
    });

    // Right-click: context menu for file-level actions
    subHeader.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      showContextMenu(e, { name: null, display_name: name, filepath: fp });
    });

    container.appendChild(sub);
  }
  if (total > files.length) container.appendChild(h('div', { className: 'list-placeholder', text: `${files.length} of ${total} shown` }));
}

async function loadFileFunctions(filepath, container) {
  container.innerHTML = '<div class="loading" style="padding:4px 10px;font-size:11px">Loading…</div>';
  try {
    const data = await api.fileFunctions({ path: filepath });
    container.innerHTML = '';
    if (!data.functions.length) { container.innerHTML = '<div class="list-placeholder" style="padding:4px 10px;font-size:11px">No functions</div>'; return; }
    for (const f of data.functions) {
      const item = h('div', { className: 'list-item', title: `${f.display_name}\nLine ${f.start}–${f.end} (${f.lines} lines)` }, [
        h('span', { className: 'metric', text: `${f.lines}`, style: 'min-width:24px' }),
        h('span', { className: 'name clickable', text: f.display_name || f.name }),
      ]);
      item.addEventListener('click', (e) => { e.stopPropagation(); onFunctionClick(f); });
      item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, f); });
      container.appendChild(item);
    }
  } catch (err) {
    container.innerHTML = `<div class="error-msg" style="font-size:11px">${escHtml(err.message)}</div>`;
  }
}


// ========================================================================
// Extensions list
// ========================================================================
function renderExtensionList(container, extensions, totalFiles, filter) {
  container.innerHTML = '';
  if (!extensions || !extensions.length) { container.innerHTML = '<div class="list-placeholder">No extensions found</div>'; return; }

  const pat = filter ? filter.toLowerCase() : null;
  const filtered = pat ? extensions.filter(e => e.ext.toLowerCase().includes(pat)) : extensions;

  for (const e of filtered) {
    const item = h('div', { className: 'list-item clickable', title: `${e.count} files (${e.pct}% of ${totalFiles})` }, [
      h('span', { className: 'metric', text: `${e.count}`, style: 'min-width:32px' }),
      h('span', { className: 'name', text: e.ext, style: 'color:var(--text-bright);font-family:var(--font-mono)' }),
      h('span', { className: 'metric muted', text: `${e.pct}%`, style: 'min-width:36px;text-align:right' }),
    ]);
    item.addEventListener('click', () => {
      $('#left-filter').value = e.ext;
      $('#left-filter').dispatchEvent(new Event('input'));
    });
    container.appendChild(item);
  }
}


// ========================================================================
// Classes list — with sub-accordion to show methods inline
// ========================================================================

function renderClassListWithSub(container, classes, total) {
  container.innerHTML = '';
  if (!classes || !classes.length) { container.innerHTML = '<div class="list-placeholder">No classes found</div>'; return; }

  for (const c of classes) {
    const subContent = h('div', { className: 'sub-accordion-content' });
    const subHeader = h('div', { className: 'sub-accordion-header' }, [
      h('span', { className: 'sub-accordion-toggle', text: '▸' }),
      h('span', { className: 'name', text: c.name, style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' }),
      h('span', { className: 'metric', text: `${c.methods}m` }),
      h('span', { className: 'metric', text: `${c.total_lines}L` }),
      h('span', { className: 'filepath', text: c.filepath?.replace(/\\/g, '/') || '', style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
    ]);
    const sub = h('div', { className: 'sub-accordion', 'data-class': c.name }, [subHeader, subContent]);

    subHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = sub.classList.contains('open');
      sub.classList.toggle('open');
      if (!wasOpen && subContent.children.length === 0) {
        loadClassMethods(c.name, subContent);
      }
      const parentSection = sub.closest('.accordion-section');
      if (parentSection) setTimeout(() => updateOverflowHint(parentSection), 50);
    });

    // Double-click: show class in middle-top
    subHeader.addEventListener('dblclick', (e) => { e.stopPropagation(); onClassClick(c.name); });

    container.appendChild(sub);
  }
  if (total > classes.length) container.appendChild(h('div', { className: 'list-placeholder', text: `${classes.length} of ${total} shown` }));
}

async function loadClassMethods(className, container) {
  container.innerHTML = '<div class="loading" style="padding:4px 10px;font-size:11px">Loading…</div>';
  try {
    const data = await api.classMethods({ name: className });
    container.innerHTML = '';
    if (!data.methods.length) { container.innerHTML = '<div class="list-placeholder" style="padding:4px 10px;font-size:11px">No methods</div>'; return; }
    for (const m of data.methods) {
      const item = h('div', { className: 'list-item', title: `${m.filepath}\nLine ${m.start}–${m.end} (${m.lines} lines)` }, [
        h('span', { className: 'metric', text: `${m.lines}`, style: 'min-width:24px' }),
        h('span', { className: 'name clickable', text: m.name }),
      ]);
      item.addEventListener('click', (e) => { e.stopPropagation(); onFunctionClick({ name: m.name, display_name: m.name, filepath: m.filepath, lines: m.lines, start: m.start, end: m.end }); });
      item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: m.name, display_name: m.name, filepath: m.filepath }); });
      container.appendChild(item);
    }
  } catch (err) {
    container.innerHTML = `<div class="error-msg" style="font-size:11px">${escHtml(err.message)}</div>`;
  }
}


// ========================================================================
// Hot Folders list
// ========================================================================
function renderHotFolderList(container, folders) {
  container.innerHTML = '';
  if (!folders.length) { container.innerHTML = '<div class="list-placeholder">No hot folders</div>'; return; }
  for (const f of folders) {
    const item = h('div', { className: 'list-item', title: `Score: ${f.score}\nFuncs: ${f.funcs}\nFiles: ${f.files}\nTop: ${f.top_func}` }, [
      h('span', { className: 'rank', text: `${f.rank}` }),
      h('span', { className: 'metric', text: `${f.score}` }),
      h('span', { className: 'name', text: f.folder, style: 'color:var(--text-bright);font-family:var(--font-mono);font-size:11px' }),
      h('span', { className: 'metric muted', text: `${f.files}f` }),
    ]);
    // Click folder: filter files list
    item.addEventListener('click', () => {
      $('#left-filter').value = f.folder;
      $('#left-filter').dispatchEvent(new Event('input'));
    });
    container.appendChild(item);
  }
}


// ========================================================================
// Most Called list
// ========================================================================
function renderMostCalledList(container, items, total, sectionId, filter) {
  container.innerHTML = '';

  // Toggle for defined-only filtering
  const toggleRow = h('div', { style: 'display:flex;align-items:center;gap:6px;padding:2px 8px;font-size:10px;color:var(--text-muted)' }, [
    h('label', { style: 'display:flex;align-items:center;gap:4px;cursor:pointer' }, [
      (() => { const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!state.mostCalledDefinedOnly; cb.style.cssText = 'margin:0'; cb.addEventListener('change', () => { state.mostCalledDefinedOnly = cb.checked; loadSectionData('most-called', filter || ''); }); return cb; })(),
      h('span', { text: 'In-index only (hide external)' }),
    ]),
  ]);
  container.appendChild(toggleRow);

  if (!items.length) { container.appendChild(h('div', { className: 'list-placeholder', text: 'No functions found' })); return; }
  for (const f of items) {
    const defInfo = f.definitions > 0 ? `${f.definitions} def` : 'external';
    const item = h('div', { className: 'list-item', title: `Count: ${f.count}\nDefs: ${defInfo}\n${(f.def_files || []).join('\n')}` }, [
      h('span', { className: 'rank', text: `${f.rank}` }),
      h('span', { className: 'metric', text: `${f.count}` }),
      h('span', { className: 'name clickable', text: f.name }),
      h('span', { className: 'metric muted', text: defInfo }),
    ]);
    item.addEventListener('click', () => {
      const fp = f.def_files && f.def_files[0] ? f.def_files[0] : null;
      onFunctionClick({ name: f.name, display_name: f.name, filepath: fp });
    });
    item.addEventListener('contextmenu', (e) => {
      const fp = f.def_files && f.def_files[0] ? f.def_files[0] : null;
      showContextMenu(e, { name: f.name, display_name: f.name, filepath: fp });
    });
    container.appendChild(item);
  }
}


// ========================================================================
// Call Inventory list
// ========================================================================
function renderCallInventory(container, data) {
  container.innerHTML = '';
  const { summary, external, in_index } = data;

  if (!external.length && !in_index.length) {
    container.innerHTML = '<div class="list-placeholder">No call targets found</div>';
    return;
  }

  // Summary line
  container.appendChild(h('div', {
    className: 'list-placeholder',
    text: `${summary.functions_scanned} functions scanned: ${summary.in_index_count} in-index, ${summary.external_count} external targets`,
    style: 'font-size:10px;padding:4px 10px;color:var(--text-muted)',
  }));

  // External calls section (the unique value of call-inventory)
  if (external.length > 0) {
    container.appendChild(h('div', {
      text: 'External calls:',
      style: 'font-size:10px;font-weight:bold;padding:4px 10px;color:var(--accent-blue)',
    }));
    for (const e of external) {
      const prov = e.provenance ? ` [${e.provenance}]` : '';
      const item = h('div', { className: 'list-item clickable', title: `${e.call_count} call sites${prov}` }, [
        h('span', { className: 'metric', text: `${e.call_count}`, style: 'min-width:28px' }),
        h('span', { className: 'name', text: e.name, style: 'color:var(--text-bright)' }),
        prov ? h('span', { className: 'metric muted', text: prov, style: 'font-size:10px' }) : null,
      ].filter(Boolean));
      item.addEventListener('click', () => {
        // Search for this external name to see where it's called
        if (window.doSearchFromUI) window.doSearchFromUI(e.name);
        else { $('#left-filter').value = e.name; $('#left-filter').dispatchEvent(new Event('input')); }
      });
      container.appendChild(item);
    }
  }

  // In-index section (summary — overlaps with Most Called)
  if (in_index.length > 0) {
    const inIdxToggle = h('div', {
      text: `In-index targets (${summary.in_index_count}):`,
      style: 'font-size:10px;font-weight:bold;padding:4px 10px;color:var(--text-muted);cursor:pointer',
      title: 'Click to show/hide in-index targets (also available in Most Called)',
    });
    const inIdxContent = h('div', { style: 'display:none' });
    inIdxToggle.addEventListener('click', () => {
      const open = inIdxContent.style.display !== 'none';
      inIdxContent.style.display = open ? 'none' : 'block';
      const parentSection = container.closest('.accordion-section');
      if (parentSection) setTimeout(() => updateOverflowHint(parentSection), 50);
    });
    for (const f of in_index) {
      const item = h('div', { className: 'list-item clickable', title: `${f.filepath}\n${f.lines} lines, ${f.caller_count} callers` }, [
        h('span', { className: 'metric', text: `${f.caller_count}`, style: 'min-width:28px' }),
        h('span', { className: 'name', text: f.name }),
        h('span', { className: 'metric muted', text: `${f.lines}L` }),
      ]);
      item.addEventListener('click', () => {
        onFunctionClick({ name: f.name, display_name: f.qualified_name || f.name, filepath: f.filepath });
      });
      inIdxContent.appendChild(item);
    }
    container.appendChild(inIdxToggle);
    container.appendChild(inIdxContent);
  }
}


// ========================================================================
// Class Hotspots list
// ========================================================================
function renderClassHotspotList(container, classes) {
  container.innerHTML = '';
  if (!classes.length) { container.innerHTML = '<div class="list-placeholder">No class hotspots</div>'; return; }
  for (const c of classes) {
    const item = h('div', { className: 'list-item', title: `Score: ${c.score}\nMethods: ${c.methods}\nCalls: ${c.total_calls}\nLines: ${c.total_lines}\n${c.filepath}` }, [
      h('span', { className: 'rank', text: `${c.rank}` }),
      h('span', { className: 'metric', text: `${c.score}` }),
      h('span', { className: 'name clickable', text: c.name }),
      h('span', { className: 'metric muted', text: `${c.methods}m` }),
      h('span', { className: 'metric muted', text: `${c.total_lines}L` }),
    ]);
    item.addEventListener('click', () => onClassClick(c.name));
    container.appendChild(item);
  }
}


// ========================================================================
// Class Hierarchy tree
// ========================================================================
function renderClassHierarchy(container, data) {
  container.innerHTML = '';
  const { roots, externalRoots, standalone, totalRelationships } = data;

  if ((!roots || !roots.length) && (!externalRoots || !externalRoots.length) && (!standalone || !standalone.length)) {
    container.innerHTML = '<div class="list-placeholder">No class inheritance found</div>';
    return;
  }

  // Render a tree node recursively
  const renderNode = (node, depth) => {
    const indent = depth * 16;
    const hasChildren = node.children && node.children.length > 0;
    const isExternal = node.external;

    const nameStyle = isExternal
      ? 'color:var(--text-muted);font-style:italic'
      : 'color:var(--text-bright)';
    const label = isExternal ? `${node.name} (external)` : node.name;
    const metaText = !isExternal && node.methodCount > 0
      ? `${node.methodCount}m ${node.lines}L`
      : '';
    const fpText = node.filepath ? node.filepath.replace(/\\/g, '/') : '';

    const item = h('div', {
      className: 'list-item' + (isExternal ? '' : ' clickable'),
      style: `padding-left:${8 + indent}px`,
      title: [
        node.name,
        fpText ? `File: ${fpText}` : '',
        node.start ? `Line ${node.start}–${node.end}` : '',
        metaText ? `${node.methodCount} methods, ${node.lines} lines` : '',
      ].filter(Boolean).join('\n'),
    }, [
      hasChildren
        ? h('span', { className: 'sub-accordion-toggle', text: '▸', style: 'cursor:pointer;margin-right:4px;font-size:10px;width:10px;display:inline-block' })
        : h('span', { text: ' ', style: 'margin-right:4px;width:10px;display:inline-block' }),
      h('span', { className: 'name', text: label, style: nameStyle + ';flex:1;overflow:hidden;text-overflow:ellipsis' }),
      metaText ? h('span', { className: 'metric muted', text: metaText, style: 'font-size:10px' }) : null,
      fpText ? h('span', { className: 'filepath', text: fpText, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }) : null,
    ].filter(Boolean));

    // Children container (initially hidden)
    const childContainer = hasChildren ? h('div', { style: 'display:none' }) : null;

    if (!isExternal && node.filepath) {
      item.addEventListener('click', (e) => {
        if (e.target.classList.contains('sub-accordion-toggle')) return;
        onFunctionClick({ name: node.name, display_name: node.name, filepath: node.filepath, start: node.start, end: node.end });
      });
      item.addEventListener('contextmenu', (e) => {
        e.stopPropagation();
        showContextMenu(e, { name: node.name, display_name: node.name, filepath: node.filepath });
      });
    }

    if (hasChildren) {
      const toggle = item.querySelector('.sub-accordion-toggle');
      let loaded = false;
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = childContainer.style.display !== 'none';
        childContainer.style.display = open ? 'none' : 'block';
        toggle.textContent = open ? '▸' : '▾';
        if (!loaded) {
          loaded = true;
          for (const child of node.children) {
            renderNode(child, depth + 1).forEach(el => childContainer.appendChild(el));
          }
        }
        const parentSection = item.closest('.accordion-section');
        if (parentSection) setTimeout(() => updateOverflowHint(parentSection), 50);
      });
    }

    const elements = [item];
    if (childContainer) elements.push(childContainer);
    return elements;
  };

  // Render internal roots
  for (const root of roots) {
    for (const el of renderNode(root, 0)) container.appendChild(el);
  }

  // Render external roots
  if (externalRoots && externalRoots.length > 0) {
    for (const root of externalRoots) {
      for (const el of renderNode(root, 0)) container.appendChild(el);
    }
  }

  // Standalone classes summary
  if (standalone && standalone.length > 0) {
    const names = standalone.map(c => c.name);
    const summary = names.length <= 8
      ? names.join(', ')
      : names.slice(0, 8).join(', ') + ` ... +${names.length - 8} more`;
    container.appendChild(h('div', {
      className: 'list-placeholder',
      text: `Standalone (no inheritance): ${summary}`,
      style: 'font-size:10px;padding:6px 10px;color:var(--text-muted)',
    }));
  }
}


// ========================================================================
// Vocabulary list
// ========================================================================
function renderVocabList(container, vocab) {
  container.innerHTML = '';
  if (!vocab.length) { container.innerHTML = '<div class="list-placeholder">No vocabulary</div>'; return; }
  for (const v of vocab) {
    const item = h('div', { className: 'list-item', title: `Score: ${v.score}\nDoc freq: ${v.doc_freq}\nTotal freq: ${v.total_freq}` }, [
      h('span', { className: 'rank', text: `${v.rank}` }),
      h('span', { className: 'metric', text: `${v.score}` }),
      h('span', { className: 'name clickable', text: v.token }),
      h('span', { className: 'metric muted', text: `${v.doc_freq}d` }),
    ]);
    item.addEventListener('click', () => onVocabClick(v.token));
    container.appendChild(item);
  }
}


// ========================================================================
// Indexes list
// ========================================================================
function renderIndexesList(container, data) {
  container.innerHTML = '';
  const loaded = data.loaded || [];
  const available = data.available || [];

  // Hint: this accordion only scans the current/last-used directory
  container.appendChild(h('div', { className: 'list-placeholder', text: 'Showing indexes in current directory. Use Load Index dialog (File menu) for other locations.', style: 'padding:4px 8px;font-size:10px;color:var(--text-muted);line-height:1.4' }));

  if (!loaded.length && !available.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: 'No indexes found', style: 'padding:4px 8px' }));
    return;
  }

  // Show loaded indexes
  if (loaded.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: 'Loaded:', style: 'font-weight:bold;padding:4px 8px;font-size:11px' }));
    for (const idx of loaded) {
      const item = h('div', { className: 'list-item', title: idx.name, style: 'background:var(--bg-hover)' }, [
        h('span', { className: 'name', text: idx.name, style: 'color:var(--text-bright)' }),
        h('span', { className: 'metric', text: `${idx.files} files` }),
        idx.active ? h('span', { className: 'type-badge', text: 'active', style: 'color:#ffd700;font-size:9px' }) : null,
      ].filter(Boolean));
      container.appendChild(item);
    }
  }

  // Show available (unloaded) indexes
  const unloaded = available.filter(a => !a.loaded);
  if (unloaded.length) {
    // Show scanned folder path if available
    if (data.scanDir) {
      container.appendChild(h('div', { className: 'list-placeholder', text: data.scanDir, style: 'padding:2px 8px;font-size:10px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis', title: data.scanDir }));
    }
    container.appendChild(h('div', { className: 'list-placeholder', text: 'Available:', style: 'font-weight:bold;padding:4px 8px;font-size:11px;margin-top:4px' }));
    for (const idx of unloaded) {
      const hasWarning = idx.missing && idx.missing.length > 0;
      const item = h('div', { className: 'list-item', style: 'cursor:pointer', title: hasWarning ? `Missing: ${idx.missing.join(', ')}` : idx.path }, [
        h('span', { className: 'name clickable', text: idx.name, style: hasWarning ? 'color:var(--text-dim)' : '' }),
        h('span', { className: 'metric muted', text: `~${idx.files} files` }),
        hasWarning ? h('span', { className: 'metric', text: 'incomplete', style: 'color:#cc6633;font-size:9px' }) : null,
      ].filter(Boolean));

      async function doLoad() {
        item.innerHTML = '<span class="loading" style="font-size:11px">Loading…</span>';
        try {
          state.lastIndexDir = idx.path.replace(/[\\/][^\\/]+$/, '');
          const result = await api.loadIndex({ path: idx.path, mode: 'replace' });
          // Update index info in header (same as Load Index dialog)
          const active = result.indexes.find(i => i.active) || result.indexes[0];
          if (active) $('#index-info').textContent = `${active.name} (${active.files.toLocaleString()} files)`;
          // Full reset (same as Load Index dialog)
          state.sectionData = {};
          for (const sec of $$('.accordion-section')) {
            sec.classList.remove('open');
            $('.accordion-content', sec).innerHTML = '';
            $('.accordion-badge', sec).textContent = '';
          }
          clearAllPanes();
        } catch (err) {
          item.innerHTML = `<span class="error-msg" style="font-size:11px">${escHtml(err.message)}</span>`;
        }
      }

      async function confirmAndLoad(e) {
        if (e) e.preventDefault();
        if (await showConfirmDialog(`Load index "${idx.name}"?`)) doLoad();
      }

      item.addEventListener('click', confirmAndLoad);
      item.addEventListener('contextmenu', confirmAndLoad);
      container.appendChild(item);
    }
  }
}


// ========================================================================
// File map list (summary in left pane)
// ========================================================================
function renderFileMapList(container, data) {
  container.innerHTML = '';
  if (!data.summary || !data.summary.length) {
    container.innerHTML = '<div class="list-placeholder">No cross-file dependencies found</div>';
    return;
  }
  for (const f of data.summary) {
    const item = h('div', { className: 'list-item', title: `${f.filepath}\n${f.total_calls} calls to ${f.targets} files` }, [
      h('span', { className: 'rank', text: `${f.rank}` }),
      h('span', { className: 'metric', text: `${f.total_calls}` }),
      h('span', { className: 'name', text: f.filepath?.replace(/\\/g, '/') || '', style: 'color:var(--text-bright)' }),
      h('span', { className: 'metric muted', text: `→${f.targets}` }),
    ]);
    item.addEventListener('click', async () => {
      try {
        const treeData = await api.fileTree({ file: f.filepath, depth: 2 });
        if (treeData.mermaid) {
          const body = $('#right-top-body'), ttl = $('#right-top-title');
          ttl.textContent = `File tree: ${treeData.target_base}`;
          body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>';
          renderMermaid(treeData.mermaid, $('#diagram-viewport'), treeData.target_base);
          showPane('right-top');
        }
      } catch (err) { showMiddleTopError(err.message); }
    });
    item.addEventListener('contextmenu', (e) => {
      showContextMenu(e, { name: null, display_name: shortPath(f.filepath, 40), filepath: f.filepath });
    });
    container.appendChild(item);
  }
}

// ========================================================================
// Call inventory list
// ========================================================================
function renderCallInventoryList(container, data) {
  container.innerHTML = '';
  if (!data.summary) { container.innerHTML = '<div class="list-placeholder">No data</div>'; return; }
  const { summary, in_index, external } = data;
  container.appendChild(h('div', { className: 'list-placeholder', text: `${summary.total_targets} targets: ${summary.in_index_count} in-index, ${summary.external_count} external`, style: 'font-size:10px;padding:4px 8px;text-align:left' }));
  if (external.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: 'External (not in index):', style: 'font-weight:bold;padding:4px 8px;font-size:11px' }));
    for (const e of external.slice(0, 40)) {
      container.appendChild(h('div', { className: 'list-item', title: `${e.name}\n${e.call_count} call sites\n${e.provenance || 'unknown'}` }, [
        h('span', { className: 'metric', text: `${e.call_count}` }),
        h('span', { className: 'name', text: e.name, style: 'color:var(--accent-orange)' }),
        e.provenance ? h('span', { className: 'filepath', text: e.provenance }) : null,
      ].filter(Boolean)));
    }
  }
  if (in_index.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: 'In-index targets:', style: 'font-weight:bold;padding:4px 8px;font-size:11px;margin-top:4px' }));
    for (const t of in_index.slice(0, 20)) {
      const item = h('div', { className: 'list-item', title: `${t.qualified_name}\n${t.filepath}\n${t.lines}L` }, [
        h('span', { className: 'metric', text: `${t.caller_count}` }),
        h('span', { className: 'name clickable', text: t.name }),
        h('span', { className: 'metric muted', text: `${t.lines}L` }),
      ]);
      item.addEventListener('click', () => onFunctionClick({ name: t.name, filepath: t.filepath }));
      container.appendChild(item);
    }
  }
}

// ========================================================================
// Extensions list
// ========================================================================
function renderExtensionsList(container, data) {
  container.innerHTML = '';
  if (!data.extensions?.length) { container.innerHTML = '<div class="list-placeholder">No data</div>'; return; }
  for (const e of data.extensions) {
    container.appendChild(h('div', { className: 'list-item' }, [
      h('span', { className: 'metric', text: `${e.count}` }),
      h('span', { className: 'name', text: e.ext, style: 'color:var(--text-bright);font-family:var(--font-mono)' }),
      h('span', { className: 'metric muted', text: `${e.pct}%` }),
    ]));
  }
}

// ========================================================================
// Dupe group lists (exact, near, structural)
// ========================================================================
function renderDupeGroupList(container, groups, type) {
  container.innerHTML = '';
  if (!groups.length) { container.innerHTML = '<div class="list-placeholder">No duplicates found</div>'; return; }
  for (const g of groups) {
    const extra = type === 'near' ? `${g.variants}v` : type === 'struct' ? `${g.unique_bodies}b` : `${g.waste}w`;
    const fileList = (g.instances || []).map(i => i.filepath).join('\n') || (g.files || []).join('\n');
    const item = h('div', { className: 'list-item', title: `${g.name}\n${g.count} copies × ${g.lines} lines\n${fileList}` }, [
      h('span', { className: 'rank', text: `${g.rank}` }),
      h('span', { className: 'metric', text: `${g.count}×` }),
      h('span', { className: 'name clickable', text: g.name }),
      h('span', { className: 'metric muted', text: `${g.lines}L` }),
      h('span', { className: 'metric muted', text: extra }),
    ]);
    item.addEventListener('click', () => {
      // Show files with this dupe in middle-top
      renderDupeDetail(g, type);
    });
    container.appendChild(item);
  }
}

function renderDupeDetail(group, type) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const label = type === 'exact' ? 'Exact Dupe' : type === 'near' ? 'Near Dupe' : 'Structural Dupe';
  title.textContent = `${label}: ${group.name} (${group.count} copies, ${group.lines} lines each)`;

  let html = '<div class="output-section"><table class="output-table"><tr><th>#</th><th>Function</th><th>File</th></tr>';
  const instances = group.instances || [];
  const files = group.files || [];
  // Prefer instances (have name + filepath + start) over bare files
  if (instances.length > 0) {
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      html += `<tr><td class="muted">${i + 1}</td>`;
      html += `<td class="mono"><span class="clickable" data-funcname="${escHtml(inst.name || group.name)}" data-filepath="${escHtml(inst.filepath)}">${escHtml(inst.display_name || inst.name || group.name)}</span></td>`;
      html += `<td class="mono clickable file-link" data-filepath="${escHtml(inst.filepath)}" data-start="${inst.start || ''}" title="Show file at line ${inst.start || '?'}">${escHtml(shortPath(inst.filepath, 50))}</td></tr>`;
    }
  } else {
    for (let i = 0; i < files.length; i++) {
      html += `<tr><td class="muted">${i + 1}</td><td class="mono">—</td>`;
      html += `<td class="mono"><span class="clickable" data-filepath="${escHtml(files[i])}">${escHtml(shortPath(files[i], 70))}</span></td></tr>`;
    }
  }
  html += '</table></div>';

  // Compare side-by-side button (for groups with 2+ instances)
  const compareCount = instances.length || files.length;
  if (compareCount >= 2) {
    html += `<div class="output-section"><button class="btn-secondary" id="compare-dupes-btn" style="margin:4px 0">Compare Side by Side</button></div>`;
  }

  // For structural dupes, offer funcstring view
  if (type === 'struct') {
    html += `<div class="output-section"><button class="btn-secondary" id="show-funcstring-btn" style="margin:4px 0">Show Funcstring (structural normalization)</button>`;
    html += `<pre class="funcstring-view" id="funcstring-view" style="display:none;white-space:pre-wrap;font-size:11px;color:var(--text-dim);padding:6px;background:var(--bg-dark);border:1px solid var(--border);max-height:300px;overflow:auto"></pre></div>`;
  }

  container.innerHTML = html;
  wireClickables(container, { sourceOnly: true });

  // Wire compare button
  const compareBtn = $('#compare-dupes-btn', container);
  if (compareBtn) {
    compareBtn.addEventListener('click', () => {
      openCompareView(group, type);
    });
  }

  // Wire file-link clicks (show file scrolled to function)
  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const startLine = parseInt(el.dataset.start) || undefined;
      onFileClick(el.dataset.filepath, startLine);
    });
  }

  if (type === 'struct') {
    const fBtn = $('#show-funcstring-btn', container);
    const fView = $('#funcstring-view', container);
    if (fBtn && fView) {
      fBtn.addEventListener('click', async () => {
        fBtn.textContent = 'Loading…';
        try {
          // Get funcstring from first instance
          const target = instances.length > 0
            ? `${instances[0].filepath}@${instances[0].name || group.name}`
            : group.name;
          const data = await api.funcstring({ func: target });
          fView.textContent = data.funcstring || '(empty)';
          fView.style.display = 'block';
          fBtn.textContent = 'Funcstring';
        } catch (err) {
          fView.textContent = `Error: ${err.message}`;
          fView.style.display = 'block';
          fBtn.textContent = 'Show Funcstring';
        }
      });
    }
  }
}


// ========================================================================
// Compare side-by-side overlay for dupe groups
// ========================================================================

const MAX_COMPARE_PANES = 3;

/** Create a draggable resize handle for side-by-side panes. */
function makeResizeHandle() {
  const handle = document.createElement('div');
  handle.className = 'compare-resize-handle';
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const container = handle.parentElement;
    const leftPane = handle.previousElementSibling;
    const rightPane = handle.nextElementSibling;
    if (!leftPane || !rightPane) return;

    const startX = e.clientX;
    const startLeftWidth = leftPane.getBoundingClientRect().width;
    const startRightWidth = rightPane.getBoundingClientRect().width;
    const totalWidth = startLeftWidth + startRightWidth;

    // Remove flex so we can set explicit widths
    leftPane.style.flex = 'none';
    rightPane.style.flex = 'none';
    leftPane.style.width = startLeftWidth + 'px';
    rightPane.style.width = startRightWidth + 'px';

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newLeft = Math.max(80, Math.min(totalWidth - 80, startLeftWidth + dx));
      const newRight = totalWidth - newLeft;
      leftPane.style.width = newLeft + 'px';
      rightPane.style.width = newRight + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  return handle;
}

async function openCompareView(group, type) {
  const overlay = $('#compare-overlay');
  const body = $('#compare-body');
  const title = $('#compare-title');
  const nav = $('#compare-nav');

  const instances = group.instances || [];
  const totalCount = instances.length || (group.files || []).length;
  const label = type === 'near' ? 'Near Dupe' : type === 'struct' ? 'Structural Dupe' : 'Duplicate';
  title.textContent = `${label}: ${group.name}`;

  // Show up to MAX_COMPARE_PANES at a time
  let offset = 0;

  async function renderPanes() {
    body.innerHTML = '';
    const showCount = Math.min(MAX_COMPARE_PANES, totalCount - offset);

    if (totalCount > MAX_COMPARE_PANES) {
      nav.textContent = `Showing ${offset + 1}–${offset + showCount} of ${totalCount}`;
    } else {
      nav.textContent = `${totalCount} copies`;
    }

    for (let i = 0; i < showCount; i++) {
      const idx = offset + i;
      const inst = instances[idx];
      if (!inst) continue;

      const pane = document.createElement('div');
      pane.className = 'compare-pane';

      // Header
      const header = document.createElement('div');
      header.className = 'compare-pane-header';
      header.innerHTML = `<span class="pane-idx">${idx + 1}</span>` +
        `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(inst.name || group.name)}">${escHtml(inst.display_name || inst.name || group.name)}</span>` +
        `<span class="pane-file" title="${escHtml(inst.filepath)}">${escHtml(shortPath(inst.filepath, 35))}</span>`;
      pane.appendChild(header);

      // Body — load source
      const paneBody = document.createElement('div');
      paneBody.className = 'compare-pane-body';
      paneBody.innerHTML = '<pre style="color:var(--text-muted)">Loading…</pre>';
      pane.appendChild(paneBody);
      // Add resize handle between panes (not before first)
      if (i > 0) body.appendChild(makeResizeHandle());
      body.appendChild(pane);

      // Fetch source
      const funcSpec = `${inst.filepath}@${inst.name || group.name}`;
      try {
        const data = await api.extract({ func: funcSpec });
        if (data.source) {
          const lines = data.source.split('\n');
          const startLine = data.start_line || 1;
          const pre = document.createElement('pre');
          for (let li = 0; li < lines.length; li++) {
            const numSpan = document.createElement('span');
            numSpan.className = 'line-num';
            numSpan.textContent = String(startLine + li);
            pre.appendChild(numSpan);
            pre.appendChild(document.createTextNode(lines[li] + '\n'));
          }
          paneBody.innerHTML = '';
          paneBody.appendChild(pre);
        } else {
          paneBody.innerHTML = `<pre style="color:var(--text-muted)">No source found</pre>`;
        }
      } catch (err) {
        paneBody.innerHTML = `<pre style="color:var(--accent)">Error: ${escHtml(err.message)}</pre>`;
      }
    }

    // Add prev/next buttons if needed
    if (totalCount > MAX_COMPARE_PANES) {
      const navBar = document.createElement('div');
      navBar.style.cssText = 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:10';
      if (offset > 0) {
        const prevBtn = document.createElement('button');
        prevBtn.className = 'btn-secondary';
        prevBtn.textContent = '← Previous';
        prevBtn.addEventListener('click', () => { offset = Math.max(0, offset - MAX_COMPARE_PANES); renderPanes(); });
        navBar.appendChild(prevBtn);
      }
      if (offset + MAX_COMPARE_PANES < totalCount) {
        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn-secondary';
        nextBtn.textContent = 'Next →';
        nextBtn.addEventListener('click', () => { offset += MAX_COMPARE_PANES; renderPanes(); });
        navBar.appendChild(nextBtn);
      }
      // Append to the overlay container (not body, which is flex)
      const existing = overlay.querySelector('.compare-nav-bar');
      if (existing) existing.remove();
      navBar.className = 'compare-nav-bar';
      overlay.querySelector('.fullscreen-diagram').appendChild(navBar);
    }
  }

  await renderPanes();
  overlay.classList.remove('hidden');
}

function initCompareOverlay() {
  $('#compare-close').addEventListener('click', () => {
    $('#compare-overlay').classList.add('hidden');
    // Clean up nav bar
    const navBar = document.querySelector('.compare-nav-bar');
    if (navBar) navBar.remove();
  });
  $('#compare-overlay').addEventListener('click', (e) => {
    if (e.target === $('#compare-overlay')) {
      $('#compare-overlay').classList.add('hidden');
      const navBar = document.querySelector('.compare-nav-bar');
      if (navBar) navBar.remove();
    }
  });
}


function renderStructDiffList(container, groups) {
  container.innerHTML = '';
  if (!groups.length) { container.innerHTML = '<div class="list-placeholder">No structural diffs found</div>'; return; }
  for (const g of groups) {
    const item = h('div', { className: 'list-item', title: `${g.name}\n${g.count} copies, ${g.unique_bodies} variants\n${g.summary}` }, [
      h('span', { className: 'rank', text: `${g.rank}` }),
      h('span', { className: 'metric', text: `${g.count}×` }),
      h('span', { className: 'name clickable', text: g.name }),
      h('span', { className: 'metric muted', text: `${g.diffCount}/${g.totalHoles}` }),
    ]);
    item.addEventListener('click', () => renderStructDiffDetail(g));
    container.appendChild(item);
  }
}

function renderStructDiffDetail(group) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `Struct Diff: ${group.name} (${group.count} copies, ${group.unique_bodies} variants)`;
  let html = '<div class="output-section">';

  // Summary
  html += `<div style="padding:4px 0;color:var(--text-bright)">${escHtml(group.summary)}</div>`;

  // Substitutions table
  if (group.substitutions && group.substitutions.length > 0) {
    html += `<table class="output-table"><tr><th>From</th><th>→</th><th>To</th><th>×</th></tr>`;
    for (const s of group.substitutions) {
      html += `<tr><td class="mono">${escHtml(s.from)}</td><td>→</td><td class="mono">${escHtml(s.to)}</td><td>${s.count}</td></tr>`;
    }
    html += '</table>';
  }

  // Instances
  if (group.instances && group.instances.length > 0) {
    html += `<h3 style="margin-top:10px">Instances</h3><table class="output-table"><tr><th>#</th><th>Function</th><th>File</th></tr>`;
    for (let i = 0; i < group.instances.length; i++) {
      const inst = group.instances[i];
      html += `<tr><td class="muted">${i + 1}</td>`;
      html += `<td class="mono"><span class="clickable" data-funcname="${escHtml(inst.name)}" data-filepath="${escHtml(inst.filepath)}">${escHtml(inst.display_name || inst.name)}</span></td>`;
      html += `<td class="mono clickable file-link" data-filepath="${escHtml(inst.filepath)}" data-start="${inst.start || ''}" title="Show file at line ${inst.start || '?'}">${escHtml(shortPath(inst.filepath, 45))}</td></tr>`;
    }
    html += '</table>';
  }

  html += '</div>';
  container.innerHTML = html;
  wireClickables(container, { sourceOnly: true });

  // Wire file-link clicks (show file scrolled to function)
  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const startLine = parseInt(el.dataset.start) || undefined;
      onFileClick(el.dataset.filepath, startLine);
    });
  }
}


// ========================================================================
// Click handlers
// ========================================================================
async function onFunctionClick(funcInfo) {
  state.highlightTerms = null; // Clear search highlighting for non-search context
  const funcSpec = funcInfo.filepath
    ? `${funcInfo.filepath}@${funcInfo.name || funcInfo.display_name}`
    : (funcInfo.name || funcInfo.display_name);

  navPush('middle-bottom');
  showMiddleTopLoading(`Loading ${funcInfo.display_name || funcInfo.name}…`);

  try {
    const extractData = await api.extract({ func: funcSpec });
    if (extractData.ambiguous) { renderDisambiguation(extractData.matches); return; }
    renderSource(extractData);

    const callersData = await api.callers({ func: funcSpec });
    const calleesData = await api.callees({ func: funcSpec });
    renderCallInfo(extractData, callersData, calleesData);
  } catch (err) {
    showMiddleTopError(err.message);
  }
}

/** Source-only click: populate middle-bottom without touching middle-top (preserves search results) */
async function onFunctionClickSourceOnly(funcInfo) {
  const funcSpec = funcInfo.filepath
    ? `${funcInfo.filepath}@${funcInfo.name || funcInfo.display_name}`
    : (funcInfo.name || funcInfo.display_name);

  showMiddleBottomLoading(`Loading ${funcInfo.display_name || funcInfo.name}…`);

  try {
    let extractData = await api.extract({ func: funcSpec });

    // Auto-disambiguate: if ambiguous and we have a current file context, prefer
    // the match in the same file, or the same directory
    if (extractData.ambiguous && extractData.matches.length > 0) {
      const ctx = state.currentSourceFile || (funcInfo.filepath || '');
      let best = null;

      if (ctx) {
        // Exact file match
        best = extractData.matches.find(m => m.filepath === ctx);
        // Same directory match
        if (!best) {
          const ctxDir = ctx.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
          if (ctxDir) best = extractData.matches.find(m => m.filepath.replace(/\\/g, '/').startsWith(ctxDir + '/'));
        }
      }
      // Fallback: just pick the largest (most likely the real implementation)
      if (!best) {
        best = extractData.matches.reduce((a, b) => (b.lines > a.lines ? b : a), extractData.matches[0]);
      }

      // Re-fetch with the resolved filepath
      const resolvedSpec = `${best.filepath}@${best.name}`;
      extractData = await api.extract({ func: resolvedSpec });
      if (extractData.ambiguous) {
        renderDisambiguation(extractData.matches);
        return;
      }
    }

    renderSource(extractData);
  } catch (err) {
    showMiddleBottomError(err.message);
  }
}

async function onFileClick(filepath, targetLine) {
  showMiddleBottomLoading(`Loading ${filepath}…`);
  try {
    const data = await api.showFile({ path: filepath });
    renderFileSource(data, targetLine);
  } catch (err) { showMiddleBottomError(err.message); }
}

async function onClassClick(className) {
  showMiddleTopLoading(`Loading class ${className}…`);
  try {
    const data = await api.classMethods({ name: className });
    renderClassMethodsDetail(data);
  } catch (err) { showMiddleTopError(err.message); }
}

async function onVocabClick(token) {
  state.highlightTerms = { terms: [token], colors: HIGHLIGHT_COLORS };
  showMiddleTopLoading(`Files containing "${token}"…`);
  try {
    const data = await api.filesSearch({ q: token, max: 40 });
    renderFilesSearchResults(token, data);
  } catch (err) { showMiddleTopError(err.message); }
}


// ========================================================================
// Middle pane helpers
// ========================================================================
function showMiddleTopLoading(msg) { showPane('middle-top'); navPush('middle-top'); $('#middle-top-body').innerHTML = `<div class="loading">${escHtml(msg)}</div>`; $('#middle-top-title').textContent = 'Loading…'; }
function showMiddleTopError(msg)   { showPane('middle-top'); $('#middle-top-body').innerHTML = `<div class="error-msg">${escHtml(msg)}</div>`; $('#middle-top-title').textContent = 'Error'; }
function showMiddleBottomLoading(msg) { navPush('middle-bottom'); $('#middle-bottom-body').innerHTML = `<div class="loading">${escHtml(msg)}</div>`; $('#middle-bottom-title').textContent = 'Loading…'; }
function showMiddleBottomError(msg)   { $('#middle-bottom-body').innerHTML = `<div class="error-msg">${escHtml(msg)}</div>`; $('#middle-bottom-title').textContent = 'Error'; }

// --- Pane navigation history (back/forward for both middle panes) ---

const NAV_MAX = 40;

const paneNav = {
  'middle-top':    { back: [], forward: [] },
  'middle-bottom': { back: [], forward: [] },
};

function navCapture(paneId) {
  const body = $(`#${paneId}-body`);
  const title = $(`#${paneId}-title`);
  if (!body || !title) return null;
  // Don't capture placeholder or loading states
  if (body.querySelector('.list-placeholder') || body.querySelector('.loading')) return null;
  return {
    html: body.innerHTML,
    title: title.textContent,
    scroll: body.scrollTop,
    file: paneId === 'middle-bottom' ? state.currentSourceFile : null,
  };
}

function navRestore(paneId, entry) {
  const body = $(`#${paneId}-body`);
  const title = $(`#${paneId}-title`);
  body.innerHTML = entry.html;
  title.textContent = entry.title;
  // Restore scroll after DOM update
  requestAnimationFrame(() => { body.scrollTop = entry.scroll; });
  if (paneId === 'middle-bottom') {
    state.currentSourceFile = entry.file;
    linkifySourceCalls(body, entry.file);
  } else {
    wireClickables(body, { sourceOnly: true });
  }
  navUpdateButtons(paneId);
}

function navPush(paneId) {
  const entry = navCapture(paneId);
  if (!entry) return;
  const nav = paneNav[paneId];
  nav.back.push(entry);
  if (nav.back.length > NAV_MAX) nav.back.shift();
  nav.forward = []; // new navigation clears forward stack
  navUpdateButtons(paneId);
}

function navBack(paneId) {
  const nav = paneNav[paneId];
  if (!nav.back.length) return;
  // Save current state to forward stack
  const current = navCapture(paneId);
  if (current) nav.forward.push(current);
  const entry = nav.back.pop();
  navRestore(paneId, entry);
}

function navForward(paneId) {
  const nav = paneNav[paneId];
  if (!nav.forward.length) return;
  // Save current state to back stack
  const current = navCapture(paneId);
  if (current) nav.back.push(current);
  const entry = nav.forward.pop();
  navRestore(paneId, entry);
}

function navUpdateButtons(paneId) {
  const nav = paneNav[paneId];
  const prefix = paneId === 'middle-bottom' ? 'source' : 'output';
  const backBtn = $(`#${prefix}-back-btn`);
  const fwdBtn = $(`#${prefix}-fwd-btn`);
  if (backBtn) {
    backBtn.style.display = nav.back.length > 0 ? 'inline-block' : 'none';
    backBtn.title = nav.back.length > 0 ? `Back (${nav.back.length})` : '';
  }
  if (fwdBtn) {
    fwdBtn.style.display = nav.forward.length > 0 ? 'inline-block' : 'none';
    fwdBtn.title = nav.forward.length > 0 ? `Forward (${nav.forward.length})` : '';
  }
}

function navClearAll() {
  for (const paneId of ['middle-top', 'middle-bottom']) {
    paneNav[paneId].back = [];
    paneNav[paneId].forward = [];
    navUpdateButtons(paneId);
  }
}

function clearAllPanes() {
  $('#middle-top-body').innerHTML = '<div class="list-placeholder">Select an item from the left pane,<br>or run a search command</div>';
  $('#middle-top-title').textContent = 'Output';
  $('#middle-bottom-body').innerHTML = '<div class="list-placeholder">Click a function or file to view source</div>';
  $('#middle-bottom-title').textContent = 'Source';
  $('#right-top-body').innerHTML = '<div class="diagram-viewport" id="diagram-viewport"><div class="list-placeholder">Right-click a function → Call Tree</div></div>';
  $('#right-top-title').textContent = 'Diagram';
  $('#right-bottom-body').innerHTML = '<div class="list-placeholder">LLM analysis output will appear here</div>';
  consoleClear();
  if (typeof consoleAppend === 'function') consoleAppend('Code Exam Console. Type /help for commands.\n', 'console-info');
  state.lastMermaidText = null;
  state.lastMermaidRoot = null;
  state.diagramZoom = 1.0;
  state.highlightTerms = null;
  state.currentSourceFile = null;
  navClearAll();
}

function renderSource(data) {
  const container = $('#middle-bottom-body'), title = $('#middle-bottom-title');
  title.textContent = `${data.display_name || data.name}  (${data.filepath}, ${data.lines} lines)`;
  state.currentSourceFile = data.filepath;
  const lines = data.source.split('\n'), startLine = data.start || 1;
  const hl = state.highlightTerms;
  let html = '<div class="source-view">';
  for (let i = 0; i < lines.length; i++) {
    let content = escHtml(lines[i]);
    if (hl) content = highlightLine(content, hl.terms, hl.colors);
    html += `<div class="source-line"><span class="line-number">${startLine + i}</span><span class="line-content">${content}</span></div>`;
  }
  container.innerHTML = html + '</div>';
  linkifySourceCalls(container, data.filepath);
  navUpdateButtons('middle-bottom');
}

function renderFileSource(data, targetLine) {
  showPane('middle-bottom');
  const container = $('#middle-bottom-body'), title = $('#middle-bottom-title');
  title.textContent = `${data.filepath}  (${data.lines} lines)`;
  state.currentSourceFile = data.filepath;
  const lines = data.content.split('\n');
  const hl = state.highlightTerms;
  let html = '<div class="source-view">';
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    let content = escHtml(lines[i]);
    if (hl) content = highlightLine(content, hl.terms, hl.colors);
    const isTarget = targetLine && lineNum === targetLine;
    html += `<div class="source-line${isTarget ? ' target-line' : ''}" data-line="${lineNum}"><span class="line-number">${lineNum}</span><span class="line-content">${content}</span></div>`;
  }
  container.innerHTML = html + '</div>';
  linkifySourceCalls(container, data.filepath);
  navUpdateButtons('middle-bottom');

  // Scroll to target line
  if (targetLine) {
    const targetEl = container.querySelector(`.source-line[data-line="${targetLine}"]`);
    if (targetEl) {
      requestAnimationFrame(() => targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }
}

/** Keywords that look like function calls but aren't */
const SOURCE_SKIP_KEYWORDS = new Set([
  'if','else','while','for','switch','case','catch','return','throw',
  'sizeof','typeof','instanceof','new','delete','void','yield','await',
  'assert','print','import','export','from','require','include','define',
  'elif','except','finally','with','as','in','of','is','not','and','or',
  'var','let','const','function','class','struct','enum','interface',
  'public','private','protected','static','virtual','override','final',
  'true','false','null','undefined','this','self','super','None','True','False',
]);

/**
 * Check if a position in text is inside a string literal.
 * Scans from start, tracking quote state (handles ', ", ` and escaped quotes).
 */
function isInsideString(text, pos) {
  let inSingle = false, inDouble = false, inBacktick = false;
  for (let i = 0; i < pos && i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (prev === '\\') continue; // escaped character
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
  }
  return inSingle || inDouble || inBacktick;
}

/**
 * Check if position is inside a comment (// or # style line comment).
 */
function isInsideComment(text, pos) {
  // Find first // or # that isn't inside a string
  for (let i = 0; i < pos - 1 && i < text.length; i++) {
    if (isInsideString(text, i)) continue;
    if (text[i] === '/' && text[i + 1] === '/') return pos > i;
    if (text[i] === '#' && (i === 0 || /\s/.test(text[i - 1]))) return pos > i;
  }
  return false;
}

/**
 * Post-process rendered source to make function calls clickable.
 * Walks DOM text nodes in .line-content elements, finds identifier( patterns,
 * wraps them in clickable spans. Skips identifiers inside strings/comments.
 */
function linkifySourceCalls(container, contextFilepath) {
  const callPattern = /\b([a-zA-Z_]\w*)\s*\(/g;

  // Detect file type to avoid false highlighting in HTML/CSS
  const ext = contextFilepath ? contextFilepath.replace(/.*\./, '.').toLowerCase() : '';
  const isHtml = /^\.(html?|xhtml|xml|svg|jsp|asp|php|erb|ejs|hbs|vue)$/.test(ext);
  const isCss = /^\.(css|scss|sass|less)$/.test(ext);
  if (isCss) return;  // CSS has no function calls to linkify

  // For HTML: track whether we're inside a <script> block
  let inScript = !isHtml;  // non-HTML files: always "in script"

  for (const lineEl of container.querySelectorAll('.line-content')) {
    // Get the full line text for string/comment detection
    const fullLineText = lineEl.textContent;

    // HTML: track <script>/<\/script> transitions
    if (isHtml) {
      if (/<script[\s>]/i.test(fullLineText)) inScript = true;
      if (/<\/script>/i.test(fullLineText)) { inScript = false; continue; }
      if (!inScript) continue;  // skip non-script lines in HTML
    }

    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) textNodes.push(node);

    // Track character offset of each text node within the full line
    let charOffset = 0;
    for (const textNode of textNodes) {
      const text = textNode.textContent;
      callPattern.lastIndex = 0;
      const fragments = [];
      let lastIdx = 0;
      let match;

      while ((match = callPattern.exec(text)) !== null) {
        const name = match[1];
        const matchStart = match.index;
        const absPos = charOffset + matchStart; // position in full line

        // Skip if preceding character in full line is a word char
        // (text node boundary from highlighting can cause false \b matches)
        if (absPos > 0 && /\w/.test(fullLineText[absPos - 1])) continue;

        // Skip keywords, too-short names, ALL_CAPS macros
        if (SOURCE_SKIP_KEYWORDS.has(name)) continue;
        if (name.length < 2) continue;
        if (/^[A-Z][A-Z0-9_]+$/.test(name) && name.length > 2) continue;

        // Skip if inside string literal or comment
        if (isInsideString(fullLineText, absPos)) continue;
        if (isInsideComment(fullLineText, absPos)) continue;

        // Add text before this match
        if (matchStart > lastIdx) {
          fragments.push(document.createTextNode(text.slice(lastIdx, matchStart)));
        }

        // Create clickable span for the function name
        const span = document.createElement('span');
        span.className = 'src-fn-link';
        span.textContent = name;
        span.dataset.funcname = name;
        span.addEventListener('click', (e) => {
          e.stopPropagation();
          onFunctionClickSourceOnly({ name, display_name: name, filepath: null });
        });
        span.addEventListener('contextmenu', (e) => {
          e.stopPropagation();
          showContextMenu(e, { name, display_name: name, filepath: null });
        });
        fragments.push(span);

        // Add the "(" back as plain text
        lastIdx = matchStart + match[0].length;
        fragments.push(document.createTextNode(match[0].slice(name.length)));
      }

      charOffset += text.length;

      if (fragments.length === 0) continue; // No matches in this text node

      // Add remaining text
      if (lastIdx < text.length) {
        fragments.push(document.createTextNode(text.slice(lastIdx)));
      }

      // Replace the text node with our fragments
      const parent = textNode.parentNode;
      for (const frag of fragments) {
        parent.insertBefore(frag, textNode);
      }
      parent.removeChild(textNode);
    }
  }
}

/** Group callers by (caller_function, filepath), collecting call sites */
function groupCallers(callers) {
  const map = new Map();
  for (const c of callers) {
    const key = `${c.caller_function || ''}|||${c.filepath}`;
    if (!map.has(key)) {
      map.set(key, { caller: c.caller_function, filepath: c.filepath, sites: [] });
    }
    map.get(key).sites.push(c);
  }
  return [...map.values()];
}

function renderCallInfo(extractData, callersData, calleesData) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = extractData.display_name || extractData.name;
  let html = '';

  const funcLabel = escHtml(extractData.display_name || extractData.name);
  html += `<div class="output-section"><h3>Function Info: <span class="clickable" data-funcname="${escHtml(extractData.name)}" data-filepath="${escHtml(extractData.filepath)}">${funcLabel}</span></h3><table class="output-table">`;
  html += `<tr><td class="muted">File</td><td class="mono"><span class="clickable" data-filepath="${escHtml(extractData.filepath)}">${escHtml(extractData.filepath)}</span></td></tr>`;
  html += `<tr><td class="muted">Lines</td><td>${extractData.start}–${extractData.end} (${extractData.lines} lines)</td></tr>`;
  html += `</table></div>`;

  const ce = calleesData.callees || [];
  if (ce.length) {
    html += `<div class="output-section"><h3>Calls (${ce.length})</h3><table class="output-table"><tr><th>Function</th><th>Type</th><th>Defined</th></tr>`;
    for (const c of ce) {
      const isDef = c.definitions > 0;
      const demoted = c.ambiguous && !c.resolved_def;
      const nameHtml = demoted
        ? `<span class="muted">${escHtml(c.display_name || c.name)}</span>`
        : `<span class="clickable" data-funcname="${escHtml(c.resolved_def?.full_name || c.name)}"${c.resolved_def?.filepath ? ` data-filepath="${escHtml(c.resolved_def.filepath)}"` : ''}>${escHtml(c.display_name || c.name)}</span>`;
      html += `<tr><td class="mono">${nameHtml}${demoted ? ' <span class="type-badge">unresolved</span>' : ''}</td>`;
      html += `<td class="muted">${c.call_type}</td><td class="${isDef ? '' : 'muted'}">${isDef ? `${c.definitions} def` : 'external'}</td></tr>`;
    }
    html += '</table></div>';
  }

  const cl = callersData.callers || [];
  if (cl.length) {
    const grouped = groupCallers(cl);
    const showAll = grouped.length <= 15;
    const visible = showAll ? grouped : grouped.slice(0, 15);
    html += `<div class="output-section"><h3>Called By (${grouped.length} caller${grouped.length !== 1 ? 's' : ''}, ${cl.length} site${cl.length !== 1 ? 's' : ''})</h3><table class="output-table"><tr><th>Caller</th><th>File</th><th>Sites</th></tr>`;
    for (const g of visible) {
      const cn = g.caller || '(file scope)';
      html += `<tr><td class="mono"><span class="clickable" data-funcname="${escHtml(cn)}" data-filepath="${escHtml(g.filepath)}">${escHtml(cn)}</span></td>`;
      html += `<td class="mono muted">${escHtml(shortPath(g.filepath, 30))}</td><td>${g.sites.length}</td></tr>`;
    }
    html += '</table>';
    if (!showAll) html += `<div class="list-placeholder" style="cursor:pointer;color:var(--accent)" id="show-all-callers">Show all ${grouped.length} callers…</div>`;
    else if (cl.length > grouped.length) html += `<div class="list-placeholder" style="cursor:pointer;color:var(--accent)" id="show-all-callers">Show call sites…</div>`;
    html += '</div>';
  }

  container.innerHTML = html;
  wireClickables(container);

  const expandBtn = $('#show-all-callers', container);
  if (expandBtn) {
    expandBtn.addEventListener('click', () => renderCallersOnly(extractData.name, callersData));
  }
}

function renderDisambiguation(matches) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = 'Multiple matches — select one';
  let html = '<div class="output-section"><h3>Disambiguation</h3><table class="output-table"><tr><th>#</th><th>Function</th><th>File</th><th>Lines</th></tr>';
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    html += `<tr><td>${i + 1}</td><td class="mono"><span class="clickable" data-funcname="${escHtml(m.name)}" data-filepath="${escHtml(m.filepath)}">${escHtml(m.display_name)}</span></td>`;
    html += `<td class="mono muted">${escHtml(shortPath(m.filepath, 40))}</td><td>${m.lines}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  wireClickables(container);
}

function renderCallersOnly(funcName, data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const callers = data.callers || [];
  const grouped = groupCallers(callers);
  title.textContent = `Callers of ${funcName} (${grouped.length} caller${grouped.length !== 1 ? 's' : ''}, ${callers.length} site${callers.length !== 1 ? 's' : ''})`;
  if (!grouped.length) { container.innerHTML = '<div class="list-placeholder">No callers found</div>'; return; }
  let html = '<div class="output-section">';
  for (let gi = 0; gi < grouped.length; gi++) {
    const g = grouped[gi];
    const cn = g.caller || '(file scope)';
    const multi = g.sites.length > 1;
    html += `<div class="caller-group" style="margin-bottom:2px">`;
    html += `<div class="caller-group-header" style="display:flex;align-items:baseline;gap:8px;padding:3px 4px">`;
    if (multi) html += `<span class="caller-toggle" data-group="${gi}" style="color:var(--accent-dim);font-size:10px;width:12px;cursor:pointer" title="Expand call sites">&#9656;</span>`;
    else html += `<span style="width:12px"></span>`;
    html += `<span class="mono clickable" data-funcname="${escHtml(cn)}" data-filepath="${escHtml(g.filepath)}">${escHtml(cn)}</span>`;
    html += `<span class="mono muted" style="font-size:11px">${escHtml(shortPath(g.filepath, 40))}</span>`;
    if (multi) html += `<span class="muted" style="font-size:10px;cursor:pointer" data-sites-toggle="${gi}">${g.sites.length} sites</span>`;
    else html += `<span class="muted" style="font-size:10px">1 site</span>`;
    html += `<span class="muted" style="font-size:10px">${g.sites[0].call_type}</span>`;
    html += `</div>`;
    // Expandable call sites
    html += `<div class="caller-sites" id="caller-sites-${gi}" style="display:none;padding-left:24px">`;
    for (const s of g.sites) {
      html += `<div class="caller-site" style="display:flex;gap:8px;padding:1px 4px;font-size:11px">`;
      html += `<span class="muted" style="min-width:36px;text-align:right">L${s.line_number}</span>`;
      html += `<span class="mono file-link clickable" data-filepath="${escHtml(g.filepath)}" data-start="${s.line_number}" style="color:var(--text-dim);white-space:pre;overflow:hidden;text-overflow:ellipsis">${escHtml(s.line_text || '')}</span>`;
      html += `</div>`;
    }
    html += `</div></div>`;
  }
  html += '</div>';
  container.innerHTML = html;
  wireClickables(container);

  // Wire file-link clicks (show file scrolled to line)
  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const startLine = parseInt(el.dataset.start) || undefined;
      onFileClick(el.dataset.filepath, startLine);
    });
  }

  // Wire expand/collapse on toggle arrow and "N sites" label
  function toggleSites(gi) {
    const sites = $(`#caller-sites-${gi}`, container);
    const toggle = $(`.caller-toggle[data-group="${gi}"]`, container);
    if (!sites) return;
    const open = sites.style.display !== 'none';
    sites.style.display = open ? 'none' : 'block';
    if (toggle) toggle.innerHTML = open ? '&#9656;' : '&#9662;';
  }
  for (const el of $$('.caller-toggle[data-group]', container)) {
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleSites(el.dataset.group); });
  }
  for (const el of $$('[data-sites-toggle]', container)) {
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => { e.stopPropagation(); toggleSites(el.dataset.sitesToggle); });
  }
}

function renderCalleesOnly(funcName, data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `Callees of ${funcName} (${data.callees.length})`;
  if (!data.callees.length) { container.innerHTML = '<div class="list-placeholder">No callees found</div>'; return; }
  let html = '<div class="output-section"><table class="output-table"><tr><th>Function</th><th>Type</th><th>Defined</th></tr>';
  for (const c of data.callees) {
    const isDef = c.definitions > 0;
    html += `<tr><td class="mono"><span class="clickable" data-funcname="${escHtml(c.name)}">${escHtml(c.display_name || c.name)}</span></td>`;
    html += `<td class="muted">${c.call_type}</td><td class="${isDef ? '' : 'muted'}">${isDef ? `${c.definitions} def` : 'external'}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  wireClickables(container);
}

function renderClassMethodsDetail(data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `Class: ${data.name} (${data.method_count} methods, ${data.total_lines} lines)`;
  let html = `<div class="output-section"><h3>Methods</h3>`;
  if (data.inferred) html += `<p style="color:var(--text-muted);font-size:11px;margin-bottom:6px">(Inferred from :: qualified method names)</p>`;
  html += '<table class="output-table"><tr><th>Method</th><th>File</th><th>Lines</th></tr>';
  for (const m of data.methods) {
    html += `<tr><td class="mono"><span class="clickable" data-funcname="${escHtml(m.name)}" data-filepath="${escHtml(m.filepath)}">${escHtml(m.name)}</span></td>`;
    html += `<td class="mono muted">${escHtml(shortPath(m.filepath, 30))}</td><td>${m.lines}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  wireClickables(container);
}

function renderFilesSearchResults(token, data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `"${token}" — ${data.total} files, showing top ${data.files.length}`;
  if (!data.files.length) { container.innerHTML = '<div class="list-placeholder">No files found</div>'; return; }
  let html = '<div class="output-section"><table class="output-table"><tr><th>#</th><th>File</th><th>Hits</th></tr>';
  for (const f of data.files) {
    html += `<tr><td class="muted">${f.rank}</td><td class="mono"><span class="clickable" data-filepath="${escHtml(f.filepath)}">${escHtml(shortPath(f.filepath, 60))}</span></td><td>${f.hits}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  wireClickables(container);
}

function renderSearchResults(query, data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `Search: "${query}" (${data.results.length} results)`;

  // Store for source highlighting
  state.highlightTerms = { terms: [query], colors: HIGHLIGHT_COLORS };

  if (!data.results.length) { container.innerHTML = '<div class="list-placeholder">No results</div>'; return; }

  // Group results by filepath (preserve first-appearance order)
  const groups = new Map();
  for (const r of data.results) {
    const fp = r.filepath || '(unknown)';
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(r);
  }

  let html = '';
  for (const [fp, hits] of groups) {
    html += '<div style="border-bottom:1px solid var(--border)">';
    html += `<div class="clickable" data-filepath="${escHtml(fp)}" style="padding:6px 12px;font-family:var(--font-mono);font-size:12px;font-weight:600;cursor:pointer;color:var(--text-bright);background:var(--bg-alt)">${escHtml(shortPath(fp, 70))} <span class="muted" style="font-weight:normal">(${hits.length} hit${hits.length > 1 ? 's' : ''})</span></div>`;
    html += '<div style="padding:2px 12px 4px 24px">';
    let lastFunc = null;
    for (const r of hits) {
      const hlLine = highlightLine(escHtml(r.line_text.trim()), [query], HIGHLIGHT_COLORS);
      let lineHtml = `<span class="mono muted" style="font-size:11px;margin-right:6px">L${r.line_number}</span>`;
      if (r.containing_function && r.containing_function !== lastFunc) {
        lineHtml += `<span class="clickable" data-funcname="${escHtml(r.containing_function)}" data-filepath="${escHtml(fp)}" style="font-size:11px;margin-right:6px">${escHtml(r.containing_function)}</span>`;
        lastFunc = r.containing_function;
      }
      lineHtml += `<span style="font-family:var(--font-mono);font-size:12px;color:var(--text-bright)">${hlLine}</span>`;
      html += `<div style="padding:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${lineHtml}</div>`;
    }
    html += '</div></div>';
  }
  container.innerHTML = html;
  wireClickables(container, { sourceOnly: true });
}

function renderStats(data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = 'Index Statistics';
  let html = '<div class="output-section"><table class="output-table">';
  html += `<tr><td class="muted">Index Path</td><td class="mono">${escHtml(data.index_path)}</td></tr>`;
  html += `<tr><td class="muted">Base Path</td><td class="mono">${escHtml(data.base_path || '—')}</td></tr>`;
  html += `<tr><td class="muted">Files</td><td>${data.files_indexed?.toLocaleString()}</td></tr>`;
  html += `<tr><td class="muted">Functions</td><td>${data.function_count?.toLocaleString()}</td></tr>`;
  html += `<tr><td class="muted">Total Lines</td><td>${data.total_lines?.toLocaleString()}</td></tr>`;
  if (data.unique_hashes != null) {
    html += `<tr><td class="muted">Unique Hashes</td><td>${data.unique_hashes?.toLocaleString()}</td></tr>`;
    html += `<tr><td class="muted">Dupe Groups</td><td>${data.dupe_groups}</td></tr>`;
  }
  if (data.parse_method) {
    html += `<tr><td class="muted">Parse Method</td><td>${escHtml(data.parse_method)}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
}

function renderMultisectResults(data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `Multisect (${data.results.length} results)`;
  const termsDiv = $('#workspace-terms');
  termsDiv.innerHTML = '';
  for (const t of data.terms) termsDiv.appendChild(h('span', { className: `term-chip${t.negated ? ' negated' : ''}`, text: t.display }));

  // Store highlight terms for source highlighting
  const positiveTerms = data.terms.filter(t => !t.negated).map(t => t.display);
  state.highlightTerms = { terms: positiveTerms, colors: HIGHLIGHT_COLORS };

  if (!data.results.length) { container.innerHTML = '<div class="list-placeholder">No matches</div>'; return; }
  let html = '<div class="output-section"><table class="output-table"><tr><th>#</th><th>Scope</th><th>Terms</th><th>Lines</th></tr>';
  for (const r of data.results) {
    const nameDisplay = r.function_name || r.filepath || r.scope;
    const isFunc = r.scope_type === 'function';
    const isFile = r.scope_type === 'file';
    html += `<tr><td class="muted">${r.rank}</td><td class="mono">`;
    if (isFunc) html += `<span class="clickable" data-funcname="${escHtml(r.function_name)}" data-filepath="${escHtml(r.filepath)}">${escHtml(nameDisplay)}</span>`;
    else if (isFile) html += `<span class="clickable" data-filepath="${escHtml(r.filepath)}">${escHtml(shortPath(r.filepath, 55))}</span>`;
    else html += escHtml(nameDisplay);
    html += ` <span class="type-badge">${r.scope_type}</span></td><td>${r.matched_terms}/${r.total_terms}</td><td>${r.lines}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  wireClickables(container, { sourceOnly: true });
}


// ========================================================================
// Clickable wiring — connects function/file names in output tables
// ========================================================================
function wireClickables(container, opts = {}) {
  const clickHandler = opts.sourceOnly ? onFunctionClickSourceOnly : onFunctionClick;
  for (const el of $$('.clickable[data-funcname]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;  // user is selecting text, don't navigate
      const name = el.dataset.funcname;
      const filepath = el.dataset.filepath || null;
      if (name === '(file scope)' || name === '(unknown)') {
        if (filepath) onFileClick(filepath);
      } else if (name) {
        clickHandler({ name, display_name: name, filepath });
      }
    });
    el.addEventListener('contextmenu', (e) => {
      const name = el.dataset.funcname;
      const filepath = el.dataset.filepath || null;
      if (name && name !== '(file scope)' && name !== '(unknown)') showContextMenu(e, { name, display_name: name, filepath });
      else if (filepath) showContextMenu(e, { name: null, display_name: filepath.split('/').pop(), filepath });
    });
  }
  // Wire file-only clicks (no funcname)
  for (const el of $$('.clickable[data-filepath]', container)) {
    if (!el.dataset.funcname) {
      el.addEventListener('click', () => {
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;  // user is selecting text, don't navigate
        onFileClick(el.dataset.filepath);
      });
      el.addEventListener('contextmenu', (e) => {
        showContextMenu(e, { name: null, display_name: el.dataset.filepath.split('/').pop(), filepath: el.dataset.filepath });
      });
    }
  }
}


// ========================================================================
// Context menu
// ========================================================================

/** Fetch LLM engine status and cache it. Called on init and after model switch. */
async function refreshLlmStatus() {
  try { state.llmStatus = await api.llmStatus(); } catch { state.llmStatus = null; }
}

/** Return an engine-name suffix like "(Claude API)" or "(Local: model.gguf)" for menu labels. */
function engineLabel() {
  const engine = $('#ws-engine').value;
  if (!state.llmStatus) return '';
  const info = state.llmStatus[engine];
  return info ? ` (${info.name})` : '';
}

/** Check engine availability before running an LLM action. Returns true if OK, else shows message. */
function checkEngineAvailability(engine) {
  if (!state.llmStatus) return true; // can't check, let server handle it
  const info = state.llmStatus[engine];
  if (info && info.available) return true;
  if (engine === 'claude') {
    showAnalysisPane(
      '<b>Claude API is not configured.</b><br><br>' +
      'To enable it, do one of the following:<br>' +
      '&bull; Create a <code>claude.txt</code> file containing your API key in the server directory<br>' +
      '&bull; Set the <code>ANTHROPIC_API_KEY</code> environment variable<br>' +
      '&bull; Start the server with <code>--api-key &lt;key&gt;</code>',
      'Engine Not Available', true);
  } else {
    showAnalysisPane(
      '<b>Local GGUF model is not configured.</b><br><br>' +
      'To enable it, do one of the following:<br>' +
      '&bull; Click <b>Browse GGUFs</b> in the workspace controls to select a model<br>' +
      '&bull; Start the server with <code>--model-path &lt;path-to-gguf&gt;</code>',
      'Engine Not Available', true);
  }
  return false;
}

function showContextMenu(e, funcInfo) {
  e.preventDefault();
  state.contextTarget = funcInfo;
  const menu = $('#context-menu');
  menu.classList.remove('hidden');
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  // Show/hide items based on target type
  const isFileOnly = !funcInfo.name || funcInfo.name === funcInfo.filepath;
  const fileAnalyzeBtn = $('#ctx-analyze-file');
  if (fileAnalyzeBtn) fileAnalyzeBtn.style.display = funcInfo.filepath ? '' : 'none';
  // Hide function-only items for file-only targets
  for (const btn of $$('#context-menu button[data-ctx]')) {
    const ctx = btn.dataset.ctx;
    if (['extract', 'callers', 'callees', 'call-tree', 'analyze', 'analyze-context'].includes(ctx)) {
      btn.style.display = isFileOnly ? 'none' : '';
    }
  }

  // Update LLM menu labels with engine name
  const suffix = engineLabel();
  const analyzeBtn = $('button[data-ctx="analyze"]');
  const analyzeCtxBtn = $('button[data-ctx="analyze-context"]');
  const analyzeFileBtn = $('button[data-ctx="analyze-file"]');
  if (analyzeBtn)     analyzeBtn.textContent     = `Analyze with LLM${suffix}`;
  if (analyzeCtxBtn)  analyzeCtxBtn.textContent  = `Analyze with LLM + Context${suffix}`;
  if (analyzeFileBtn) analyzeFileBtn.textContent = `Analyze File with LLM${suffix}`;

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  });
}

function hideContextMenu() { $('#context-menu').classList.add('hidden'); state.contextTarget = null; }

async function handleContextAction(action) {
  const target = state.contextTarget;
  hideContextMenu();
  if (!target) return;

  const funcSpec = target.filepath ? `${target.filepath}@${target.name}` : target.name;

  switch (action) {
    case 'extract': onFunctionClick(target); break;

    case 'callers':
      showMiddleTopLoading(`Callers of ${target.name}…`);
      try { renderCallersOnly(target.name, await api.callers({ func: funcSpec })); }
      catch (err) { showMiddleTopError(err.message); }
      break;

    case 'callees':
      showMiddleTopLoading(`Callees of ${target.name}…`);
      try { renderCalleesOnly(target.name, await api.callees({ func: funcSpec })); }
      catch (err) { showMiddleTopError(err.message); }
      break;

    case 'call-tree': {
      showPane('right-top');
      const ctDepth = parseInt($('#diagram-depth')?.value) || 3;
      const body = $('#right-top-body'), ttl = $('#right-top-title');
      ttl.textContent = `Call tree: ${target.name} (depth ${ctDepth})`;
      body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"><div class="loading">Building call tree…</div></div>';
      try {
        const data = await api.callTree({ func: funcSpec, depth: ctDepth });
        const rootName = data.target;
        renderMermaid(data.mermaid, $('#diagram-viewport'), rootName, {
          onNodeClick: (nodeId, label) => {
            if (label && label !== rootName) {
              openRelationshipView(rootName, label);
            }
          },
        });
      } catch (err) {
        $('#diagram-viewport').innerHTML = `<div class="error-msg">${escHtml(err.message)}</div>`;
      }
      break;
    }

    case 'file-tree': {
      const fp = target.filepath;
      if (!fp) { showMiddleTopError('No file associated with this item.'); break; }
      showPane('right-top');
      const ftDepth = parseInt($('#diagram-depth')?.value) || 3;
      const body = $('#right-top-body'), ttl = $('#right-top-title');
      ttl.textContent = `File tree: ${fp.split('/').pop()} (depth ${ftDepth})`;
      body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"><div class="loading">Building file dependency tree…</div></div>';
      try {
        const data = await api.fileTree({ file: fp, depth: ftDepth });
        renderMermaid(data.mermaid, $('#diagram-viewport'), data.target_base);
      } catch (err) {
        $('#diagram-viewport').innerHTML = `<div class="error-msg">${escHtml(err.message)}</div>`;
      }
      break;
    }

    case 'analyze': {
      const funcSpec = target.filepath
        ? `${target.filepath}@${target.name || target.display_name}`
        : (target.name || target.display_name);
      const engine = $('#ws-engine').value;
      if (!checkEngineAvailability(engine)) break;
      const mask = $('#ws-mask-all')?.checked || false;
      const maskComments = $('#ws-mask-comments')?.checked || false;
      showAnalysisPane(`<div class="loading">Analyzing ${escHtml(target.name)} via ${escHtml(engine)}…</div>`, 'Analyzing…', true);
      try {
        const data = await api.analyzeLlm({
          func: funcSpec,
          mode: 'analyze',
          engine, mask, maskComments,
        });
        renderLlmAnalysis(data);
      } catch (err) {
        showAnalysisPane(`Error: ${escHtml(err.message)}`, 'Analysis Error', true);
      }
      break;
    }

    case 'analyze-context': {
      const funcSpec = target.filepath
        ? `${target.filepath}@${target.name || target.display_name}`
        : (target.name || target.display_name);
      const engine = $('#ws-engine').value;
      if (!checkEngineAvailability(engine)) break;
      let contextText = $('#claim-text').value.trim();
      if (!contextText) {
        showAnalysisPane('No context text. Paste text into the Workspace textarea first, then right-click a function and choose "Analyze with LLM + Workspace Context".', 'No Context');
        break;
      }
      // If textarea shows resolved @file (with separator), strip the display header
      contextText = stripAtFileHeader(contextText);
      const mask = $('#ws-mask-all')?.checked || false;
      const maskComments = $('#ws-mask-comments')?.checked || false;
      showAnalysisPane(`<div class="loading">Analyzing ${escHtml(target.name)} with context via ${escHtml(engine)}…</div>`, 'Analyzing…', true);
      try {
        const data = await api.analyzeLlm({
          func: funcSpec,
          mode: 'context-analyze',
          contextText,
          engine, mask, maskComments,
        });
        renderLlmAnalysis(data);
      } catch (err) {
        showAnalysisPane(`Error: ${escHtml(err.message)}`, 'Analysis Error', true);
      }
      break;
    }

    case 'analyze-file': {
      const fp = target.filepath || target.name;
      if (!fp) { showAnalysisPane('No file associated with this item.', 'Error'); break; }
      const engine = $('#ws-engine').value;
      if (!checkEngineAvailability(engine)) break;
      const mask = $('#ws-mask-all')?.checked || false;
      const maskComments = $('#ws-mask-comments')?.checked || false;
      showAnalysisPane(`<div class="loading">Analyzing file ${escHtml(shortPath(fp, 60))} via ${escHtml(engine)}…</div>`, 'Analyzing…', true);
      try {
        const data = await api.analyzeLlm({
          file: fp,
          mode: 'file-analyze',
          engine, mask, maskComments,
        });
        renderLlmAnalysis(data);
      } catch (err) {
        showAnalysisPane(`Error: ${escHtml(err.message)}`, 'Analysis Error', true);
      }
      break;
    }

    default: console.log(`Context action '${action}' not implemented`, target);
  }
}


// ========================================================================
// Mermaid rendering with zoom
// ========================================================================
/**
 * @param {string} mermaidText
 * @param {HTMLElement} container
 * @param {string|null} rootNodeName - highlighted node
 * @param {object} [opts]
 * @param {function} [opts.onNodeClick] - callback(nodeId, labelText) when node is clicked
 * @param {function} [opts.onEdgeClick] - callback(sourceId, targetId, labelText) when edge is clicked
 * @param {object} [opts.nodeIdMap] - nodeId -> metadata (e.g. filepath), passed to callbacks
 */
function renderMermaid(mermaidText, container, rootNodeName, opts = {}) {
  state.lastMermaidText = mermaidText;
  state.lastMermaidRoot = rootNodeName || null;
  state.lastMermaidOpts = opts;
  state.diagramZoom = 1.0;
  applyDiagramZoom(container);

  // Sanitize node labels: escape quotes and angle brackets that break Mermaid
  let fullText = mermaidText.replace(/"([^"]*)"/g, (match, label) => {
    return '"' + label.replace(/[<>"&]/g, c => ({ '<':'‹', '>':'›', '"':'\'', '&':'+' }[c])) + '"';
  });
  if (rootNodeName) {
    const rootId = rootNodeName.replace(/[^a-zA-Z0-9_]/g, '_');
    fullText += `\n  style ${rootId} fill:#7a6a00,stroke:#ffd700,stroke-width:3px,color:#fff`;
  }

  if (typeof mermaid !== 'undefined' && mermaid.render) {
    const id = 'mermaid-' + Date.now();
    mermaid.render(id, fullText).then(({ svg }) => {
      container.innerHTML = svg;
      // Wire up click handlers on SVG nodes and edges
      wireMermaidClicks(container, opts);
    }).catch(err => {
      // Clean up any error elements Mermaid injected into the DOM
      for (const el of document.querySelectorAll('[id^="d"], .error-icon, .mermaid-error')) {
        if (el.closest('#main') === null && el.closest('#diagram-fullscreen') === null) el.remove();
      }
      // Also remove any Mermaid-generated SVG that landed outside our containers
      for (const svg of document.querySelectorAll('body > svg, body > div > svg.mermaid')) {
        svg.remove();
      }
      // Friendly error messages instead of raw Mermaid internals
      let msg = err.message || String(err);
      if (msg.includes('Cannot set properties of undefined') || msg.includes('order')) {
        msg = 'Call tree too complex or contains cycles that Mermaid cannot render.\nTry a simpler function or reduce depth.';
      } else if (msg.includes('Syntax error') || msg.includes('Parse error')) {
        msg = 'Diagram contains characters that Mermaid cannot parse.\nSome function names with special characters may not render.';
      }
      container.innerHTML = `<div class="error-msg" style="white-space:pre-wrap">${escHtml(msg)}</div>`;
    });
  } else {
    container.innerHTML = `<div class="output-section"><h3>Mermaid (raw)</h3><pre style="font-family:var(--font-mono);font-size:12px;padding:8px;background:var(--bg-input);border-radius:3px;overflow:auto">${escHtml(mermaidText)}</pre></div>`;
  }
}

/**
 * Attach click handlers to Mermaid SVG nodes and edges after rendering.
 * Nodes are <g> elements with class "node" and an id matching the node ID.
 * Edges are <g> elements with class "edgePath" or "edge-label".
 */
function wireMermaidClicks(container, opts = {}) {
  const svg = container.querySelector('svg');
  if (!svg) return;

  // Make nodes clickable
  if (opts.onNodeClick) {
    for (const node of svg.querySelectorAll('g.node')) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeId = node.id.replace(/^flowchart-/, '').replace(/-\d+$/, '');
        let label = node.querySelector('.nodeLabel, text')?.textContent || nodeId;
        // Reverse Mermaid sanitization
        label = label.replace(/‹/g, '<').replace(/›/g, '>').replace(/'/g, '"').replace(/\+/g, '&');
        opts.onNodeClick(nodeId, label, opts.nodeIdMap);
      });
    }
  }

  // Make edge labels clickable
  if (opts.onEdgeClick) {
    for (const edgeLabel of svg.querySelectorAll('.edgeLabel')) {
      const labelText = edgeLabel.textContent?.trim();
      if (labelText) {
        edgeLabel.style.cursor = 'pointer';
        edgeLabel.addEventListener('click', (e) => {
          e.stopPropagation();
          // Try to find the parent edge path to determine source/target
          const edgeId = edgeLabel.id || '';
          opts.onEdgeClick(edgeId, labelText, opts.nodeIdMap);
        });
      }
    }
  }
}

/**
 * Open a three-pane relationship view: source | diagram | source.
 * Used when clicking a node in a call tree diagram.
 */
async function openRelationshipView(rootFunc, clickedFunc) {
  const overlay = $('#compare-overlay');
  const body = $('#compare-body');
  const title = $('#compare-title');
  const nav = $('#compare-nav');

  title.textContent = `${rootFunc} → ${clickedFunc}`;
  nav.textContent = 'Relationship View';
  body.innerHTML = '';

  // Left pane: root function source
  const leftPane = document.createElement('div');
  leftPane.className = 'compare-pane';
  leftPane.innerHTML = `<div class="compare-pane-header"><span class="pane-idx">1</span><span style="flex:1">${escHtml(rootFunc)}</span></div><div class="compare-pane-body"><pre style="color:var(--text-muted)">Loading…</pre></div>`;
  body.appendChild(leftPane);

  // Resize handle
  body.appendChild(makeResizeHandle());

  // Center pane: focused diagram
  const centerPane = document.createElement('div');
  centerPane.className = 'compare-pane';
  centerPane.innerHTML = `<div class="compare-pane-header"><span class="pane-idx" style="background:var(--text-muted)">↔</span><span style="flex:1">Call Path</span></div><div class="compare-pane-body" id="relationship-diagram" style="padding:8px"><div style="color:var(--text-muted)">Loading diagram…</div></div>`;
  body.appendChild(centerPane);

  // Resize handle
  body.appendChild(makeResizeHandle());

  // Right pane: clicked function source
  const rightPane = document.createElement('div');
  rightPane.className = 'compare-pane';
  rightPane.innerHTML = `<div class="compare-pane-header"><span class="pane-idx">2</span><span style="flex:1">${escHtml(clickedFunc)}</span></div><div class="compare-pane-body"><pre style="color:var(--text-muted)">Loading…</pre></div>`;
  body.appendChild(rightPane);

  overlay.classList.remove('hidden');

  // Fetch sources and diagram in parallel
  const loadSource = async (pane, funcName) => {
    const paneBody = pane.querySelector('.compare-pane-body');
    const header = pane.querySelector('.compare-pane-header');
    try {
      let data = await api.extract({ func: funcName });
      // If ambiguous, pick the first match
      if (data.ambiguous && data.matches && data.matches.length > 0) {
        const m = data.matches[0];
        data = await api.extract({ func: `${m.filepath}@${m.name}` });
      }
      if (data.source) {
        if (data.filepath) {
          header.innerHTML += `<span class="pane-file" title="${escHtml(data.filepath)}">${escHtml(shortPath(data.filepath, 30))}</span>`;
        }
        const lines = data.source.split('\n');
        const startLine = data.start_line || data.start || 1;
        const pre = document.createElement('pre');
        for (let li = 0; li < lines.length; li++) {
          const numSpan = document.createElement('span');
          numSpan.className = 'line-num';
          numSpan.textContent = String(startLine + li);
          pre.appendChild(numSpan);
          pre.appendChild(document.createTextNode(lines[li] + '\n'));
        }
        paneBody.innerHTML = '';
        paneBody.appendChild(pre);
      } else {
        paneBody.innerHTML = `<pre style="color:var(--text-muted)">"${escHtml(funcName)}" — source not available (may be external)</pre>`;
      }
    } catch (err) {
      // Function may be external/library — show that clearly
      const msg = err.message.includes('not found')
        ? `"${funcName}" — external or unresolved (not in index)`
        : `Error: ${err.message}`;
      paneBody.innerHTML = `<pre style="color:var(--text-muted)">${escHtml(msg)}</pre>`;
    }
  };

  const loadDiagram = async () => {
    try {
      const data = await api.callTree({ func: rootFunc, depth: 2 });
      if (data.mermaid) {
        const diagramEl = document.getElementById('relationship-diagram');
        renderMermaid(data.mermaid, diagramEl, rootFunc);
      }
    } catch (err) {
      const diagramEl = document.getElementById('relationship-diagram');
      if (diagramEl) diagramEl.innerHTML = `<div style="color:var(--accent)">Diagram error: ${escHtml(err.message)}</div>`;
    }
  };

  // Load all three in parallel
  await Promise.all([
    loadSource(leftPane, rootFunc),
    loadDiagram(),
    loadSource(rightPane, clickedFunc),
  ]);
}

/**
 * Open a file-map edge detail popup showing function-to-function calls between two files.
 */
async function openFileMapEdgeDetail(edgeId, labelText, nodeIdMap) {
  // Parse the count from the edge label (e.g. "47")
  const count = parseInt(labelText) || 0;

  // Try to identify source and target files from the edge
  // Mermaid edge labels don't directly encode source/target, but we can
  // find them from the SVG structure or the nodeIdMap
  const overlay = $('#compare-overlay');
  const body = $('#compare-body');
  const title = $('#compare-title');
  const nav = $('#compare-nav');

  title.textContent = `File Dependencies: ${count} cross-file calls`;
  nav.textContent = 'Click function names to view source';
  body.innerHTML = '<div class="compare-pane" style="flex:1"><div class="compare-pane-header"><span class="pane-idx">↔</span><span style="flex:1">Loading inter-file call details…</span></div><div class="compare-pane-body" style="padding:12px"><div style="color:var(--text-muted)">Analyzing connections…</div></div></div>';
  overlay.classList.remove('hidden');

  // For now, show a message — full implementation needs the server to return
  // per-edge function call details (which functions in file A call which in file B)
  body.querySelector('.compare-pane-body').innerHTML = `<div style="padding:12px;color:var(--text-muted)">
    <p>Edge represents <strong>${count}</strong> function call${count !== 1 ? 's' : ''} between files.</p>
    <p style="margin-top:8px">Full per-function detail requires a new API endpoint (TODO #301).<br>
    Use <em>Call Inventory</em> in the left panel to explore cross-file calls.</p>
  </div>`;
}

function applyDiagramZoom(viewport) {
  if (!viewport) viewport = $('#diagram-viewport');
  if (viewport) viewport.style.transform = `scale(${state.diagramZoom})`;
}

function initDiagramControls() {
  const step = 0.2;
  $('#zoom-in').addEventListener('click', () => { state.diagramZoom = Math.min(3, state.diagramZoom + step); applyDiagramZoom(); });
  $('#zoom-out').addEventListener('click', () => { state.diagramZoom = Math.max(0.2, state.diagramZoom - step); applyDiagramZoom(); });
  $('#zoom-reset').addEventListener('click', () => { state.diagramZoom = 1.0; applyDiagramZoom(); });

  $('#right-top-body').addEventListener('wheel', (e) => {
    if (!$('#diagram-viewport svg')) return;
    e.preventDefault();
    state.diagramZoom = Math.max(0.2, Math.min(3, state.diagramZoom + (e.deltaY < 0 ? step : -step)));
    applyDiagramZoom();
  }, { passive: false });

  $('#diagram-popout').addEventListener('click', openDiagramFullscreen);
  $('#fs-close').addEventListener('click', closeDiagramFullscreen);
  $('#fs-zoom-in').addEventListener('click', () => { state.diagramZoom = Math.min(3, state.diagramZoom + step); applyDiagramZoom($('#fullscreen-viewport')); });
  $('#fs-zoom-out').addEventListener('click', () => { state.diagramZoom = Math.max(0.2, state.diagramZoom - step); applyDiagramZoom($('#fullscreen-viewport')); });
  $('#fs-zoom-reset').addEventListener('click', () => { state.diagramZoom = 1.0; applyDiagramZoom($('#fullscreen-viewport')); });

  // Save diagram buttons
  $('#diagram-save-svg').addEventListener('click', () => saveDiagramSvg($('#diagram-viewport')));
  $('#diagram-save-png').addEventListener('click', () => saveDiagramPng($('#diagram-viewport')));
  $('#fs-save-svg').addEventListener('click', () => saveDiagramSvg($('#fullscreen-viewport')));
  $('#fs-save-png').addEventListener('click', () => saveDiagramPng($('#fullscreen-viewport')));
}

// Strip directory path from filename (browsers only support saving to Downloads)
function sanitizeDownloadName(name) {
  // Strip any directory components — browser download can only set filename
  return name.replace(/^.*[\\/]/, '');
}

function saveDiagramSvg(viewport) {
  const svg = viewport?.querySelector('svg');
  if (!svg) return;
  const defaultName = (state.lastMermaidRoot || 'diagram') + '.svg';
  showSearchDialog('Save SVG', 'Filename (saves to Downloads):').then(name => {
    if (!name) return;
    name = sanitizeDownloadName(name);
    if (!name.endsWith('.svg')) name += '.svg';
    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    showSaveNotification(`Saved: ${name} (check browser Downloads)`);
  });
  setTimeout(() => { const inp = $('#search-dialog-input'); if (inp) inp.value = defaultName; }, 120);
}

function saveDiagramPng(viewport) {
  const svg = viewport?.querySelector('svg');
  if (!svg) return;
  const defaultName = (state.lastMermaidRoot || 'diagram') + '.png';
  showSearchDialog('Save PNG', 'Filename (saves to Downloads):').then(name => {
    if (!name) return;
    name = sanitizeDownloadName(name);
    if (!name.endsWith('.png')) name += '.png';
    const origTransform = viewport.style.transform;
    viewport.style.transform = 'scale(1)';
    const svgData = new XMLSerializer().serializeToString(svg);
    viewport.style.transform = origTransform;

    // Use intrinsic SVG dimensions for better quality
    const svgW = svg.viewBox?.baseVal?.width || svg.getAttribute('width') || svg.getBoundingClientRect().width;
    const svgH = svg.viewBox?.baseVal?.height || svg.getAttribute('height') || svg.getBoundingClientRect().height;
    const w = parseFloat(svgW) || svg.getBoundingClientRect().width;
    const h = parseFloat(svgH) || svg.getBoundingClientRect().height;
    const scale = 3;  // 3x for crisp output
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#1e1e2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { showSaveNotification('PNG export failed (empty blob)'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        URL.revokeObjectURL(url);
        showSaveNotification(`Saved: ${name} (check browser Downloads)`);
      }, 'image/png');
    };
    img.onerror = () => {
      showSaveNotification('PNG export failed — try Save SVG instead');
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  });
  setTimeout(() => { const inp = $('#search-dialog-input'); if (inp) inp.value = defaultName; }, 120);
}

function showSaveNotification(msg) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:var(--bg-header);color:var(--accent-green);border:1px solid var(--accent-green);padding:8px 16px;border-radius:4px;font-size:12px;z-index:999;opacity:1;transition:opacity 1.5s';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 4000);
  setTimeout(() => el.remove(), 6000);
}

function openDiagramFullscreen() {
  if (!state.lastMermaidText) return;
  const overlay = $('#diagram-fullscreen');
  overlay.classList.remove('hidden');
  $('#fullscreen-title').textContent = $('#right-top-title').textContent;
  state.diagramZoom = 1.0;
  renderMermaid(state.lastMermaidText, $('#fullscreen-viewport'), state.lastMermaidRoot, state.lastMermaidOpts || {});
}

function closeDiagramFullscreen() { $('#diagram-fullscreen').classList.add('hidden'); }


// ========================================================================
// Column resizers
// ========================================================================
function initColumnResizers() {
  initColResize('col-handle-left', 'left-pane', true);
  initColResize('col-handle-right', 'right-pane', false);
}

function initColResize(handleId, paneId, isLeft) {
  const handle = $(`#${handleId}`), pane = $(`#${paneId}`);
  if (!handle || !pane) return;
  let startX, startW;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX; startW = pane.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (e2) => {
      const delta = e2.clientX - startX;
      pane.style.width = `${Math.max(150, isLeft ? startW + delta : startW - delta)}px`;
      pane.style.flex = 'none';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}


// ========================================================================
// Horizontal split handles
// ========================================================================
function initSplitHandles() {
  initVerticalSplit('middle-split-handle', 'middle-top', 'middle-bottom');
  initVerticalSplit('right-split-handle', 'right-top', 'right-bottom');
}

function initVerticalSplit(handleId, topId, bottomId) {
  const handle = $(`#${handleId}`), top = $(`#${topId}`), bottom = $(`#${bottomId}`);
  if (!handle || !top || !bottom) return;
  let startY, startTopH;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY; startTopH = top.getBoundingClientRect().height;
    const onMove = (e2) => { top.style.flex = 'none'; top.style.height = `${Math.max(80, startTopH + e2.clientY - startY)}px`; bottom.style.flex = '1'; };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}


// ========================================================================
// Load Index dialog
// ========================================================================
function initLoadIndex() {
  const overlay = $('#load-index-overlay');
  const pathInput = $('#load-index-path');
  const errDiv = $('#load-index-error');
  const browserPanel = $('#load-index-browser');
  const browsePathEl = $('#browse-current-path');
  const dirListEl = $('#browse-dir-list');
  let lastBrowsedDir = null;  // remember last directory for next dialog open

  $('#load-index-close').addEventListener('click', () => overlay.classList.add('hidden'));
  $('#load-index-cancel').addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });

  // --- Filesystem browser ---

  async function browseTo(dirPath) {
    try {
      const data = await api.browseDir(dirPath ? { path: dirPath } : {});
      renderBrowser(data);
    } catch (err) {
      dirListEl.innerHTML = `<div class="error-msg" style="padding:8px">${err.message}</div>`;
    }
  }

  function renderBrowser(data) {
    lastBrowsedDir = data.current;
    browsePathEl.textContent = data.current;
    browsePathEl.title = data.current;
    dirListEl.innerHTML = '';

    // ".." entry to go up
    if (data.parent) {
      const upEl = document.createElement('div');
      upEl.className = 'browse-item';
      upEl.innerHTML = '<span class="dir-marker">..</span> <span>(parent directory)</span>';
      upEl.addEventListener('click', () => browseTo(data.parent));
      dirListEl.appendChild(upEl);
    }

    for (const dir of data.dirs) {
      const el = document.createElement('div');
      el.className = 'browse-item' + (dir.isIndex ? ' is-index' : '');
      const fullPath = data.current + data.sep + dir.name;

      const hasWarning = dir.isIndex && dir.missing && dir.missing.length > 0;
      let inner = `<span class="dir-marker">/</span> <span>${dir.name}</span>`;
      if (dir.isIndex && hasWarning) {
        inner += `<span class="index-badge" style="background:#cc6633;color:#fff" title="Missing: ${dir.missing.join(', ')}">incomplete</span>`;
      } else if (dir.isIndex) {
        inner += '<span class="index-badge">index</span>';
      }
      el.innerHTML = inner;

      if (dir.isIndex) {
        // Single click: populate path input
        el.addEventListener('click', () => {
          pathInput.value = fullPath;
          errDiv.style.display = 'none';
        });
        // Double click: populate and load
        el.addEventListener('dblclick', () => {
          pathInput.value = fullPath;
          $('#load-index-ok').click();
        });
      } else {
        // Navigate into regular directory
        el.addEventListener('click', () => browseTo(fullPath));
      }

      dirListEl.appendChild(el);
    }

    if (data.dirs.length === 0) {
      dirListEl.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">No subdirectories</div>';
    }
  }

  // Browse button toggles the panel
  $('#load-index-browse').addEventListener('click', () => {
    if (browserPanel.style.display === 'none') {
      browserPanel.style.display = 'block';
      const startPath = pathInput.value.trim() || lastBrowsedDir || null;
      browseTo(startPath);
    } else {
      browserPanel.style.display = 'none';
    }
  });

  // --- Load button ---

  $('#load-index-ok').addEventListener('click', async () => {
    const indexPath = pathInput.value.trim();
    if (!indexPath) { errDiv.textContent = 'Enter an index path'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';

    const mode = $('#load-index-add').checked ? 'add' : 'replace';
    try {
      $('#load-index-ok').disabled = true;
      $('#load-index-ok').textContent = 'Loading...';
      errDiv.textContent = 'Loading index — large indexes may take a minute or more...';
      errDiv.style.color = 'var(--text-muted)';
      errDiv.style.display = 'block';
      const result = await api.loadIndex({ path: indexPath, mode });
      errDiv.style.display = 'none';
      errDiv.style.color = '';
      overlay.classList.add('hidden');

      // Remember parent directory for scan-indexes
      state.lastIndexDir = indexPath.replace(/[\\/][^\\/]+$/, '');

      // Refresh UI
      const active = result.indexes.find(i => i.active) || result.indexes[0];
      $('#index-info').textContent = `${active.name} (${active.files.toLocaleString()} files)`;

      // Clear all cached section data and re-collapse
      state.sectionData = {};
      for (const sec of $$('.accordion-section')) {
        sec.classList.remove('open');
        $('.accordion-content', sec).innerHTML = '';
        $('.accordion-badge', sec).textContent = '';
      }

      // Clear all content panes
      clearAllPanes();

      // Show warnings for partially valid indexes
      if (result.warnings && result.warnings.length > 0) {
        errDiv.textContent = 'Warning: ' + result.warnings.join('; ');
        errDiv.style.display = 'block';
      }
    } catch (err) {
      errDiv.style.color = '';
      errDiv.textContent = err.message;
      errDiv.style.display = 'block';
    } finally {
      $('#load-index-ok').disabled = false;
      $('#load-index-ok').textContent = 'Load';
    }
  });

  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#load-index-ok').click(); });

  // --- Rebuild button ---
  const rebuildBtn = $('#load-index-rebuild');
  const statusDiv = $('#load-index-status');
  let rebuildPollTimer = null;

  rebuildBtn.addEventListener('click', async () => {
    const indexPath = pathInput.value.trim();
    if (!indexPath) { errDiv.textContent = 'Enter an index path to rebuild'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';

    // First, load the index to get its source path
    try {
      rebuildBtn.disabled = true;
      rebuildBtn.textContent = 'Checking…';
      statusDiv.style.display = 'block';
      statusDiv.textContent = 'Loading index to find original source path…';
      statusDiv.style.color = 'var(--text-muted)';

      const loadResult = await api.loadIndex({ path: indexPath, mode: 'replace' });
      const activeIdx = loadResult.indexes.find(i => i.active);
      let sourcePath = activeIdx?.indexSource;

      if (!sourcePath || sourcePath.startsWith('file list:') || sourcePath.startsWith('glob:')) {
        errDiv.textContent = sourcePath
          ? `Cannot auto-rebuild: index was built from "${sourcePath}" (only directory sources supported)`
          : 'Cannot rebuild: no source path recorded in this index';
        errDiv.style.display = 'block';
        statusDiv.style.display = 'none';
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = 'Rebuild';
        return;
      }

      // Convert Windows paths to WSL paths (e.g. C:\foo\bar -> /mnt/c/foo/bar)
      if (/^[A-Za-z]:\\/.test(sourcePath)) {
        const drive = sourcePath[0].toLowerCase();
        sourcePath = '/mnt/' + drive + sourcePath.slice(2).replace(/\\/g, '/');
      }

      // Trigger rebuild using the original source path and the same index name
      const indexName = activeIdx.indexPath || indexPath;
      statusDiv.textContent = `Rebuilding from: ${sourcePath}`;

      let buildResult;
      try {
        buildResult = await api.buildIndex({ sourcePath, indexName, useTreeSitter: true });
      } catch (buildErr) {
        const msg = buildErr.message || '';
        if (msg.includes('Path not found') || msg.includes('not found')) {
          errDiv.textContent = `Index loaded, but original source not found: ${sourcePath}`;
        } else {
          errDiv.textContent = msg;
        }
        errDiv.style.display = 'block';
        statusDiv.style.display = 'none';
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = 'Rebuild';
        return;
      }
      const { jobId } = buildResult;

      // Poll for progress
      rebuildPollTimer = setInterval(async () => {
        try {
          const job = await api.buildIndexStatus({ jobId });
          if (job.status === 'building') {
            statusDiv.textContent = job.progress || 'Building…';
          } else if (job.status === 'done') {
            clearInterval(rebuildPollTimer);
            rebuildPollTimer = null;
            const s = job.stats;
            statusDiv.textContent = `Rebuilt: ${s.files_indexed.toLocaleString()} files, ${s.total_lines.toLocaleString()} lines`;
            statusDiv.style.color = '#4ec94e';

            setTimeout(() => {
              overlay.classList.add('hidden');
              rebuildBtn.disabled = false;
              rebuildBtn.textContent = 'Rebuild';
              statusDiv.style.display = 'none';

              const active = job.indexes.find(i => i.active) || job.indexes[0];
              $('#index-info').textContent = `${active.name} (${active.files.toLocaleString()} files)`;
              state.sectionData = {};
              for (const sec of $$('.accordion-section')) {
                sec.classList.remove('open');
                $('.accordion-content', sec).innerHTML = '';
                $('.accordion-badge', sec).textContent = '';
              }
              clearAllPanes();
            }, 2000);
          } else if (job.status === 'error') {
            clearInterval(rebuildPollTimer);
            rebuildPollTimer = null;
            errDiv.textContent = job.error || 'Rebuild failed';
            errDiv.style.display = 'block';
            statusDiv.style.display = 'none';
            rebuildBtn.disabled = false;
            rebuildBtn.textContent = 'Rebuild';
          }
        } catch (pollErr) {
          statusDiv.textContent = `Poll error: ${pollErr.message}`;
        }
      }, 1500);

    } catch (err) {
      errDiv.textContent = err.message;
      errDiv.style.display = 'block';
      statusDiv.style.display = 'none';
      rebuildBtn.disabled = false;
      rebuildBtn.textContent = 'Rebuild';
    }
  });
}


// ========================================================================
// Build Index dialog
// ========================================================================
function initBuildIndex() {
  const overlay = $('#build-index-overlay');
  const sourceInput = $('#build-index-source');
  const nameInput = $('#build-index-name');
  const errDiv = $('#build-index-error');
  const statusDiv = $('#build-index-status');
  const browserPanel = $('#build-index-browser');
  const browsePathEl = $('#build-browse-current-path');
  const dirListEl = $('#build-browse-dir-list');
  let lastBrowsedDir = null;

  // Close handlers are wired below in the build section (closeBuildDialog) to also stop polling

  // --- Filesystem browser ---

  async function browseTo(dirPath) {
    try {
      const data = await api.browseDir(dirPath ? { path: dirPath } : {});
      renderBrowser(data);
    } catch (err) {
      dirListEl.innerHTML = `<div class="error-msg" style="padding:8px">${err.message}</div>`;
    }
  }

  function renderBrowser(data) {
    lastBrowsedDir = data.current;
    browsePathEl.textContent = data.current;
    browsePathEl.title = data.current;
    dirListEl.innerHTML = '';

    // ".." entry to go up
    if (data.parent) {
      const upEl = document.createElement('div');
      upEl.className = 'browse-item';
      upEl.innerHTML = '<span class="dir-marker">..</span> <span>(parent directory)</span>';
      upEl.addEventListener('click', () => browseTo(data.parent));
      dirListEl.appendChild(upEl);
    }

    for (const dir of data.dirs) {
      const el = document.createElement('div');
      el.className = 'browse-item' + (dir.isIndex ? ' is-index' : '');
      const fullPath = data.current + data.sep + dir.name;

      let inner = `<span class="dir-marker">/</span> <span>${dir.name}</span>`;
      if (dir.isIndex) inner += '<span class="index-badge">index</span>';
      el.innerHTML = inner;

      // Single click: fill source path and auto-fill index name
      el.addEventListener('click', () => {
        sourceInput.value = fullPath;
        errDiv.style.display = 'none';
        autoFillName(fullPath);
      });

      // Double click: navigate into directory
      el.addEventListener('dblclick', () => browseTo(fullPath));

      dirListEl.appendChild(el);
    }

    if (data.dirs.length === 0) {
      dirListEl.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">No subdirectories</div>';
    }
  }

  // Browse button toggles the panel
  $('#build-index-browse').addEventListener('click', () => {
    if (browserPanel.style.display === 'none') {
      browserPanel.style.display = 'block';
      const startPath = sourceInput.value.trim() || lastBrowsedDir || null;
      browseTo(startPath);
    } else {
      browserPanel.style.display = 'none';
    }
  });

  // Auto-fill index name from source path
  function autoFillName(sourcePath) {
    if (nameInput.value.trim()) return;  // don't overwrite user input
    const dirName = sourcePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (dirName) nameInput.value = `.index_of_${dirName}`;
  }

  sourceInput.addEventListener('blur', () => {
    const val = sourceInput.value.trim();
    if (val) autoFillName(val);
  });

  // --- Build button ---

  let buildPollTimer = null;

  function stopBuildPoll() {
    if (buildPollTimer) { clearInterval(buildPollTimer); buildPollTimer = null; }
  }

  // Allow close/cancel during build (build finishes silently server-side)
  function closeBuildDialog() {
    stopBuildPoll();
    overlay.classList.add('hidden');
    $('#build-index-ok').disabled = false;
    $('#build-index-cancel').disabled = false;
  }

  $('#build-index-close').addEventListener('click', closeBuildDialog);
  $('#build-index-cancel').addEventListener('click', closeBuildDialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBuildDialog(); });

  function onBuildComplete(result) {
    stopBuildPoll();
    const s = result.stats;
    let summary = `Indexed ${s.files_indexed.toLocaleString()} files, ${s.total_lines.toLocaleString()} lines`;
    if (s.archives_expanded > 0) summary += `, ${s.archive_files} files from ${s.archives_expanded} archive(s)`;
    if (s.binstrings_processed > 0) summary += `, ${s.binstrings_processed} binaries`;
    if (s.dupes_skipped > 0) summary += `, ${s.dupes_skipped} duplicates`;
    statusDiv.textContent = summary;
    statusDiv.style.color = '#4ec94e';

    setTimeout(() => {
      overlay.classList.add('hidden');
      $('#build-index-ok').disabled = false;
      $('#build-index-cancel').disabled = false;

      // Refresh UI
      const active = result.indexes.find(i => i.active) || result.indexes[0];
      $('#index-info').textContent = `${active.name} (${active.files.toLocaleString()} files)`;

      state.sectionData = {};
      for (const sec of $$('.accordion-section')) {
        sec.classList.remove('open');
        $('.accordion-content', sec).innerHTML = '';
        $('.accordion-badge', sec).textContent = '';
      }
      clearAllPanes();

      if (s.error_count > 0) {
        const errorLines = s.errors.map(e => escHtml(e)).join('<br>');
        const truncNote = s.error_count > 50 ? `<br><br><em>…and ${s.error_count - 50} more errors</em>` : '';
        $('#middle-top-body').innerHTML = `<div style="padding:12px;font-size:12px;font-family:var(--font-mono)"><strong>${s.error_count} error(s) during indexing:</strong><br><br>${errorLines}${truncNote}</div>`;
        $('#middle-top-title').textContent = 'Build Errors';
        showPane('middle-top');
      }
    }, 2000);
  }

  $('#build-index-ok').addEventListener('click', async () => {
    const sourcePath = sourceInput.value.trim();
    const indexName = nameInput.value.trim();
    if (!sourcePath) { errDiv.textContent = 'Enter a source path'; errDiv.style.display = 'block'; return; }
    if (!indexName) { errDiv.textContent = 'Enter an index name'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';

    try {
      $('#build-index-ok').disabled = true;
      statusDiv.style.display = 'block';
      statusDiv.textContent = 'Starting build…';
      statusDiv.style.color = 'var(--text-muted)';

      const useTreeSitter = $('#build-index-tree-sitter')?.checked || false;
      const extInclude = $('#build-index-ext')?.value.trim() || '';
      const extExclude = $('#build-index-exclude-ext')?.value.trim() || '';
      const { jobId } = await api.buildIndex({ sourcePath, indexName, useTreeSitter, extensions: extInclude, excludeExtensions: extExclude });

      // Poll for progress
      buildPollTimer = setInterval(async () => {
        try {
          const job = await api.buildIndexStatus({ jobId });
          if (job.status === 'building') {
            statusDiv.textContent = job.progress || 'Building…';
          } else if (job.status === 'done') {
            onBuildComplete(job);
          } else if (job.status === 'error') {
            stopBuildPoll();
            errDiv.textContent = job.error || 'Build failed';
            errDiv.style.display = 'block';
            statusDiv.style.display = 'none';
            $('#build-index-ok').disabled = false;
            $('#build-index-cancel').disabled = false;
          }
        } catch (pollErr) {
          // Poll error — keep trying, server may be busy with the build
        }
      }, 1500);
    } catch (err) {
      errDiv.textContent = err.message;
      errDiv.style.display = 'block';
      statusDiv.style.display = 'none';
      $('#build-index-ok').disabled = false;
      $('#build-index-cancel').disabled = false;
    }
  });

  // Enter key on inputs triggers build
  sourceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#build-index-ok').click(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#build-index-ok').click(); });
}


// ========================================================================
// Menu bar
// ========================================================================
function initMenus() {
  for (const btn of $$('.menu-btn')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $(`#${btn.dataset.menu}`);
      const wasOpen = menu.classList.contains('open');
      for (const d of $$('.dropdown')) d.classList.remove('open');
      for (const b of $$('.menu-btn')) b.classList.remove('open');
      if (!wasOpen) { menu.classList.add('open'); btn.classList.add('open'); }
    });
  }
  document.addEventListener('click', (e) => {
    // Don't close dropdown if clicking inside it (e.g. on input fields)
    if (e.target.closest('.dropdown')) return;
    for (const d of $$('.dropdown')) d.classList.remove('open');
    for (const b of $$('.menu-btn')) b.classList.remove('open');
  });
  for (const btn of $$('.dropdown button[data-action]')) btn.addEventListener('click', () => handleMenuAction(btn.dataset.action));
}

async function handleMenuAction(action) {
  switch (action) {
    case 'stats':
      showMiddleTopLoading('Loading stats…');
      try { renderStats(await api.stats()); } catch (err) { showMiddleTopError(err.message); }
      break;
    case 'load-index':
      $('#load-index-path').value = '';
      $('#load-index-error').style.display = 'none';
      $('#load-index-browser').style.display = 'none';
      $('#browse-dir-list').innerHTML = '';
      $('#load-index-overlay').classList.remove('hidden');
      setTimeout(() => $('#load-index-path').focus(), 100);
      break;
    case 'build-index':
      $('#build-index-source').value = '';
      $('#build-index-name').value = '';
      $('#build-index-error').style.display = 'none';
      $('#build-index-status').style.display = 'none';
      $('#build-index-browser').style.display = 'none';
      if ($('#build-index-tree-sitter')) $('#build-index-tree-sitter').checked = false;
      $('#build-browse-dir-list').innerHTML = '';
      $('#build-index-overlay').classList.remove('hidden');
      setTimeout(() => $('#build-index-source').focus(), 100);
      break;
    case 'search-literal': case 'search-regex': case 'search-fast': {
      const label = action === 'search-literal' ? 'Literal' : action === 'search-regex' ? 'Regex' : 'Fast';
      const type = action === 'search-regex' ? 'regex' : action === 'search-fast' ? 'fast' : 'literal';
      let query = await showSearchDialog(`${label} Search`, `${label} search:`);
      if (!query) return;
      // Strip /slashes/ from regex patterns
      if (type === 'regex') { const m = query.match(/^\/(.+)\/([gimsuy]*)$/); if (m) query = m[1]; }
      showMiddleTopLoading(`Searching: "${query}"…`);
      try { renderSearchResults(query, await api.search({ q: query, type, max: 30 })); } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    case 'files-search': {
      const term = await showSearchDialog('Files Search', 'Files containing:');
      if (!term) return;
      state.highlightTerms = { terms: [term], colors: HIGHLIGHT_COLORS };
      try { renderFilesSearchResults(term, await api.filesSearch({ q: term, max: 40 })); } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    case 'search-multisect': {
      const terms = await showSearchDialog('Multisect Search', 'Terms (semicolon-separated):');
      if (!terms) return;
      showMiddleTopLoading('Running multisect search…');
      try {
        const data = await api.multisect({ terms, max: 30, min_terms: 0 });
        renderMultisectResults(data);
      } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    default: console.log(`Menu action '${action}' not implemented`);
  }
}


// ========================================================================
// Search dialog (replaces window.prompt)
// ========================================================================
function showSearchDialog(title, label) {
  return new Promise((resolve) => {
    const overlay = $('#search-overlay');
    const input = $('#search-dialog-input');
    const okBtn = $('#search-dialog-ok');
    const cancelBtn = $('#search-dialog-cancel');
    const closeBtn = $('#search-dialog-close');

    $('#search-dialog-title').textContent = title || 'Search';
    $('#search-dialog-label').childNodes[0].textContent = (label || 'Query:') + ' ';
    okBtn.textContent = (title && title.startsWith('Save')) ? 'Save' : 'Search';
    input.value = '';
    overlay.classList.remove('hidden');
    setTimeout(() => input.focus(), 100);

    function cleanup(value) {
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onOk() { cleanup(input.value.trim() || null); }
    function onCancel() { cleanup(null); }
    function onKey(e) { if (e.key === 'Enter') onOk(); else if (e.key === 'Escape') onCancel(); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}


// ========================================================================
// Confirm dialog (replaces window.confirm)
// ========================================================================
function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:360px">
        <div class="modal-header"><span>Confirm</span>
          <button class="pane-action confirm-close">✕</button>
        </div>
        <div class="modal-body" style="padding:16px;font-size:13px"></div>
        <div class="modal-footer">
          <button class="btn-secondary confirm-cancel">Cancel</button>
          <button class="btn-primary confirm-ok">OK</button>
        </div>
      </div>`;
    overlay.querySelector('.modal-body').textContent = message;
    document.body.appendChild(overlay);

    function cleanup(val) { overlay.remove(); resolve(val); }
    overlay.querySelector('.confirm-ok').addEventListener('click', () => cleanup(true));
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.confirm-close').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.querySelector('.confirm-ok').focus();
  });
}


// ========================================================================
// Helper: strip resolved @file display header from textarea content
// ========================================================================
function stripAtFileHeader(text) {
  if (!text) return text;
  const lines = text.split('\n');
  if (lines[0].trim().startsWith('@') && lines.length > 2 && /^─{10,}$/.test(lines[1].trim())) {
    // Already resolved: strip @line and separator
    return lines.slice(2).join('\n').trim();
  }
  return text;
}


// ========================================================================
// Workspace
// ========================================================================
function initWorkspace() {
  // Open expanded by default
  document.body.classList.add('workspace-open');
  $('#workspace').style.height = '180px';

  $('#workspace-toggle').addEventListener('click', (e) => {
    // Don't toggle if the popout button was clicked
    if (e.target.id === 'workspace-popout') return;
    document.body.classList.toggle('workspace-open');
    const isOpen = document.body.classList.contains('workspace-open');
    $('#workspace-expand-btn').textContent = isOpen ? '▾ Collapse' : '▴ Expand';
    // Set initial height if opening for first time
    const ws = $('#workspace');
    if (isOpen && !ws.style.height) ws.style.height = '180px';
  });

  // Pop out full screen — carry over textarea height
  $('#workspace-popout').addEventListener('click', (e) => {
    e.stopPropagation();
    const ta = $('#claim-text');
    const curH = ta.offsetHeight;
    openGenericFullscreen('workspace');
    // Apply at least the current height, or a generous default
    ta.style.height = Math.max(curH, 120) + 'px';
  });

  $('#ws-run').addEventListener('click', runWorkspace);

  // Model browser button
  $('#ws-browse-model').addEventListener('click', openModelBrowser);

  // Resizable workspace drag handle
  const handle = $('#workspace-resize-handle');
  if (handle) {
    let startY, startH;
    const onMouseMove = (e) => {
      const newH = startH - (e.clientY - startY);
      const clamped = Math.max(120, Math.min(window.innerHeight * 0.6, newH));
      $('#workspace').style.height = clamped + 'px';
    };
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startH = $('#workspace').offsetHeight;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

async function runWorkspace() {
  const mode = $('#ws-mode').value;
  let text = $('#claim-text').value.trim();
  if (!text) return;

  // Resolve @filepath: show file content below the @line in the textarea (display only)
  // The server also resolves @file in its routes, so this is just for user visibility.
  const lines = text.split('\n');
  const firstLine = lines[0].trim();
  const alreadyResolved = firstLine.startsWith('@') && lines.length > 1 && /^─{10,}$/.test(lines[1].trim());
  if (firstLine.startsWith('@') && firstLine.length > 1 && !alreadyResolved) {
    const filePath = firstLine.slice(1).trim();
    try {
      const fileData = await api.post('resolve-file', { path: filePath });
      if (fileData.content) {
        const rest = lines.slice(1).join('\n').trim();
        const separator = '─'.repeat(40);
        const displayText = firstLine + '\n' + separator + '\n' + fileData.content.trim() + (rest ? '\n\n' + rest : '');
        $('#claim-text').value = displayText;
        text = fileData.content.trim() + (rest ? '\n\n' + rest : '');
      }
    } catch (e) {
      console.log(`Client @file display failed (server will resolve): ${e.message}`);
    }
  } else if (alreadyResolved) {
    // Already resolved — strip header for sending to server
    text = stripAtFileHeader(text);
  }

  const engine = $('#ws-engine').value;
  const vocabTight = $('#ws-vocab-tight')?.checked || false;
  const noVocabulary = $('#ws-no-vocab')?.checked || false;
  const mask = $('#ws-mask-all')?.checked || false;
  const maskComments = $('#ws-mask-comments')?.checked || false;
  const minTermsVal = parseInt($('#ws-min-terms')?.value) || 0;

  // Disable Run button during processing
  const runBtn = $('#ws-run');
  runBtn.disabled = true;
  runBtn.textContent = '⏳ Working…';
  const restoreBtn = () => { runBtn.disabled = false; runBtn.textContent = '▶ Run'; };

  try {
    if (mode === 'multisect-search') {
      showMiddleTopLoading('Running multisect search…');
      try {
        const data = await api.multisect({ terms: text, max: 30, min_terms: minTermsVal });
        renderMultisectResults(data);
      } catch (err) { showMiddleTopError(err.message); }

    } else if (mode === 'claim-search') {
      // LLM-powered: extract TIGHT/BROAD terms, then multisect both
      showMiddleTopLoading(`Extracting claim terms via ${engine}… (this may take a moment)`);
      try {
        const data = await api.claimSearchLlm({
          claim: text, engine, vocabTight, noVocabulary, max: 30, minTerms: minTermsVal,
        });
        renderClaimLlmResults(data);
      } catch (err) { showMiddleTopError(err.message); }

    } else if (mode === 'multisect-analyze') {
      // Search first, then send top function hit to LLM for analysis
      showMiddleTopLoading('Running multisect search…');
      try {
        const searchData = await api.multisect({ terms: text, max: 10, min_terms: minTermsVal });
        renderMultisectResults(searchData);
        const topFunc = (searchData.results || []).find(r => r.scope_type === 'function');
        if (topFunc) {
          showAnalysisPane(`<div class="loading">Analyzing ${escHtml(topFunc.function_name)} via ${escHtml(engine)}…</div>`, 'Analyzing…', true);
          const analysisData = await api.analyzeLlm({
            func: `${topFunc.filepath}@${topFunc.function_name}`,
            mode: 'multisect-analyze',
            terms: text,
            engine, mask, maskComments,
          });
          renderLlmAnalysis(analysisData);
        } else {
          showAnalysisPane('No function matches found for analysis.', 'Multisect Analyze');
        }
      } catch (err) { showMiddleTopError(err.message); }

    } else if (mode === 'claim-analyze') {
      // LLM extract terms → multisect → LLM analyze top hit
      showMiddleTopLoading(`Extracting claim terms via ${engine}…`);
      try {
        const searchData = await api.claimSearchLlm({
          claim: text, engine, vocabTight, noVocabulary, max: 10, minTerms: minTermsVal,
        });
        renderClaimLlmResults(searchData);

        // Find top function from TIGHT results first, fall back to BROAD
        let topFunc = null;
        if (searchData.tight) {
          topFunc = (searchData.tight.results || []).find(r => r.scope_type === 'function');
        }
        if (!topFunc && searchData.broad) {
          topFunc = (searchData.broad.results || []).find(r => r.scope_type === 'function');
        }

        if (topFunc) {
          showAnalysisPane(`<div class="loading">Analyzing ${escHtml(topFunc.function_name)} against claim via ${escHtml(engine)}…</div>`, 'Analyzing…', true);
          const analysisData = await api.analyzeLlm({
            func: `${topFunc.filepath}@${topFunc.function_name}`,
            mode: 'claim-analyze',
            claim: text,
            engine, mask, maskComments,
          });
          renderLlmAnalysis(analysisData);
        } else {
          showAnalysisPane('No function matches found for claim analysis.', 'Claim Analyze');
        }
      } catch (err) { showMiddleTopError(err.message); }

    } else {
      showMiddleTopLoading(`Mode "${mode}" not yet wired to GUI`);
    }
  } finally {
    restoreBtn();
  }
}


// ========================================================================
// Render LLM claim search results (two-tier: TIGHT + BROAD)
// ========================================================================
function renderClaimLlmResults(data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const termsDiv = $('#workspace-terms');
  termsDiv.innerHTML = '';

  // Count total results across tiers
  const tightCount = data.tight ? data.tight.results.length : 0;
  const broadCount = data.broad ? data.broad.results.length : 0;
  title.textContent = `Claim Search — LLM (${tightCount + broadCount} results)`;

  // Show usage info
  let usageHtml = `<span class="muted" style="font-size:11px">Engine: ${escHtml(data.engine)}`;
  if (data.vocabChars > 0) usageHtml += ` | Vocab: ${data.vocabChars.toLocaleString()} chars`;
  if (data.usage) {
    usageHtml += ` | Tokens: ${data.usage.input_tokens || 0} in / ${data.usage.output_tokens || 0} out`;
  }
  if (data.skippedClaims > 0) usageHtml += ` | Skipped ${data.skippedClaims} dependent claim(s) for local model`;
  usageHtml += '</span>';

  let html = `<div class="output-section" style="margin-bottom:6px">${usageHtml}</div>`;

  // --- TIGHT tier ---
  if (data.tight) {
    // Term chips for TIGHT
    const tightLabel = document.createElement('span');
    tightLabel.style.cssText = 'font-weight:bold;font-size:11px;color:var(--accent);margin-right:6px';
    tightLabel.textContent = 'TIGHT:';
    termsDiv.appendChild(tightLabel);
    for (const t of data.tight.terms) {
      termsDiv.appendChild(h('span', { className: `term-chip${t.negated ? ' negated' : ''}`, text: t.display }));
    }

    // Store highlight terms from TIGHT for source views
    const posTerms = data.tight.terms.filter(t => !t.negated).map(t => t.display);
    state.highlightTerms = { terms: posTerms, colors: HIGHLIGHT_COLORS };

    html += _renderTierTable('TIGHT — literal claim language', data.tight.results, tightCount);
  }

  // --- BROAD tier ---
  if (data.broad) {
    // Term chips separator + BROAD
    const sep = document.createElement('span');
    sep.style.cssText = 'display:inline-block;width:12px';
    termsDiv.appendChild(sep);
    const broadLabel = document.createElement('span');
    broadLabel.style.cssText = 'font-weight:bold;font-size:11px;color:#6B8E23;margin-right:6px';
    broadLabel.textContent = 'BROAD:';
    termsDiv.appendChild(broadLabel);
    for (const t of data.broad.terms) {
      termsDiv.appendChild(h('span', {
        className: `term-chip${t.negated ? ' negated' : ''}`,
        text: t.display,
        style: 'border-color:#6B8E23',
      }));
    }

    html += _renderTierTable('BROAD — implementation patterns', data.broad.results, broadCount);
  }

  if (!data.tight && !data.broad) {
    html += '<div class="list-placeholder">No terms could be extracted from the claim text.</div>';
  }

  container.innerHTML = html;
  wireClickables(container, { sourceOnly: true });
}


/** Render a single TIGHT or BROAD results table. */
function _renderTierTable(heading, results, count) {
  let html = `<div class="output-section" style="margin-top:10px">`;
  html += `<h3 style="margin:0 0 6px 0;font-size:13px;color:var(--text-secondary)">${escHtml(heading)} (${count})</h3>`;
  if (!results || results.length === 0) {
    html += '<div class="muted" style="font-size:12px">No matches</div>';
  } else {
    html += '<table class="output-table"><tr><th>#</th><th>Scope</th><th>Terms</th><th>Lines</th></tr>';
    for (const r of results) {
      const nameDisplay = r.function_name || r.filepath || r.scope;
      const isFunc = r.scope_type === 'function';
      const isFile = r.scope_type === 'file';
      html += `<tr><td class="muted">${r.rank}</td><td class="mono">`;
      if (isFunc) html += `<span class="clickable" data-funcname="${escHtml(r.function_name)}" data-filepath="${escHtml(r.filepath)}">${escHtml(nameDisplay)}</span>`;
      else if (isFile) html += `<span class="clickable" data-filepath="${escHtml(r.filepath)}">${escHtml(shortPath(r.filepath, 55))}</span>`;
      else html += escHtml(nameDisplay);
      html += ` <span class="type-badge">${r.scope_type}</span></td><td>${r.matched_terms}/${r.total_terms}</td><td>${r.lines}</td></tr>`;
    }
    html += '</table>';
  }
  html += '</div>';
  return html;
}


// ========================================================================
// Render LLM analysis result (right-bottom pane)
// ========================================================================
function renderLlmAnalysis(data) {
  const disclaimer = data.engine === 'claude'
    ? 'AI analysis may contain errors. Verify claims against source code.'
    : 'AI analysis from local model — less accurate than cloud models. Verify against source.';

  const usageNote = data.usage
    ? `<span class="muted" style="margin-left:10px;font-size:11px">${data.usage.input_tokens || 0} in / ${data.usage.output_tokens || 0} out tokens</span>`
    : '';

  const html = `<div class="output-section">
    <h3 style="margin:0 0 4px 0">${escHtml(data.mode)} — ${escHtml(data.target)}</h3>
    <div class="muted" style="margin-bottom:8px;font-size:11px">
      Engine: ${escHtml(data.engine)} | ${data.lines} lines${usageNote}
    </div>
    <pre class="source-view" style="white-space:pre-wrap;font-size:12px;max-height:500px;overflow:auto">${escHtml(data.analysis)}</pre>
    <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
      <button class="btn-secondary copy-analysis-btn" style="font-size:11px">Copy Analysis</button>
      <button class="btn-secondary copy-prompt-btn" style="font-size:11px">Copy Prompt</button>
      <span class="muted" style="font-size:10px;font-style:italic">${escHtml(disclaimer)}</span>
    </div>
  </div>`;

  showAnalysisPane(html, `Analysis: ${data.target}`, true);

  // Wire copy buttons
  const analysisBtn = $('#right-bottom-body .copy-analysis-btn');
  if (analysisBtn) {
    analysisBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(data.analysis).then(
        () => { analysisBtn.textContent = 'Copied!'; setTimeout(() => { analysisBtn.textContent = 'Copy Analysis'; }, 2000); },
        () => { analysisBtn.textContent = 'Failed'; }
      );
    });
  }
  const promptBtn = $('#right-bottom-body .copy-prompt-btn');
  if (promptBtn) {
    promptBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(data.prompt).then(
        () => { promptBtn.textContent = 'Copied!'; setTimeout(() => { promptBtn.textContent = 'Copy Prompt'; }, 2000); },
        () => { promptBtn.textContent = 'Failed'; }
      );
    });
  }
}

// ========================================================================
// Model Browser modal
// ========================================================================
async function openModelBrowser() {
  // Fetch available models
  let data;
  try {
    data = await api.scanModels();
  } catch (err) {
    alert('Error scanning for models: ' + err.message);
    return;
  }

  // Build modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'model-browser-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-header"><span>Browse GGUF Models</span>
        <button class="pane-action" id="model-browser-close">✕</button>
      </div>
      <div class="modal-body">
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input type="text" id="model-scan-path" value="${escHtml(data.scanDir || '')}" spellcheck="false" style="flex:1;margin-top:0" placeholder="Directory to scan…">
          <button class="btn-secondary" id="model-scan-btn">Scan</button>
        </div>
        <div class="muted" style="font-size:11px;margin-bottom:6px">Current model: ${escHtml(data.currentModel || 'none')}</div>
        <div id="model-list" class="scrollable" style="border:1px solid var(--border);border-radius:3px;max-height:300px;overflow-y:auto;background:var(--bg-input)"></div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="model-browser-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('#model-list');
  const pathInput = overlay.querySelector('#model-scan-path');

  function renderModelList(models) {
    if (!models || models.length === 0) {
      listEl.innerHTML = '<div class="list-placeholder" style="padding:12px">No .gguf files found in this directory</div>';
      return;
    }
    let html = '';
    for (const m of models) {
      const sizeMB = (m.size / (1024 * 1024)).toFixed(1);
      const loadedBadge = m.loaded ? ' <span class="type-badge" style="background:var(--accent);color:#000">loaded</span>' : '';
      html += `<div class="browse-item model-item" data-path="${escHtml(m.path)}" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <span class="mono" style="font-size:12px">${escHtml(m.name)}${loadedBadge}</span>
        <span class="muted" style="font-size:11px">${sizeMB} MB</span>
      </div>`;
    }
    listEl.innerHTML = html;

    // Wire click handlers
    for (const item of listEl.querySelectorAll('.model-item')) {
      item.addEventListener('click', async () => {
        const modelPath = item.dataset.path;
        try {
          item.style.opacity = '0.5';
          item.querySelector('.mono').textContent += ' — loading…';
          await api.switchModel({ path: modelPath });
          // Update engine dropdown to show model name
          const engineSel = $('#ws-engine');
          const localOpt = engineSel.querySelector('option[value="local"]');
          const fname = modelPath.split('/').pop().split('\\\\').pop();
          const shortName = fname.length > 30 ? fname.slice(0, 27) + '…' : fname;
          if (localOpt) localOpt.textContent = 'Local: ' + shortName;
          engineSel.value = 'local';
          refreshLlmStatus();
          closeModal();
        } catch (err) {
          item.style.opacity = '1';
          alert('Error switching model: ' + err.message);
        }
      });
    }
  }

  renderModelList(data.models);

  // Scan button
  overlay.querySelector('#model-scan-btn').addEventListener('click', async () => {
    try {
      const scanData = await api.scanModels({ dir: pathInput.value });
      pathInput.value = scanData.scanDir || pathInput.value;
      renderModelList(scanData.models);
    } catch (err) {
      listEl.innerHTML = `<div class="error-msg" style="padding:8px">${escHtml(err.message)}</div>`;
    }
  });

  // Also scan on Enter in the path input
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') overlay.querySelector('#model-scan-btn').click();
  });

  function closeModal() {
    overlay.remove();
  }
  overlay.querySelector('#model-browser-close').addEventListener('click', closeModal);
  overlay.querySelector('#model-browser-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
}


async function buildAndShowPrompt(mode, params, showPromptOnly = false) {
  const mask = $('#ws-mask-all')?.checked || false;
  const maskComments = $('#ws-mask-comments')?.checked || false;
  const body = { mode, mask, maskComments, lineNumbers: true, ...params };
  try {
    const data = await api.buildPrompt(body);
    const label = showPromptOnly ? `Prompt for: ${data.target}` : `Analysis: ${data.target}`;
    const promptHtml = `<div class="output-section">
      <h3>${escHtml(label)}</h3>
      <div class="muted" style="margin-bottom:6px">Mode: ${escHtml(mode)} | ${data.lines || '?'} lines | ${showPromptOnly ? 'Prompt only' : 'Ready for LLM'}</div>
      <pre class="prompt-view">${escHtml(data.prompt)}</pre>
      <button class="btn-secondary copy-prompt-btn" style="margin-top:6px">Copy Prompt to Clipboard</button>
    </div>`;
    showAnalysisPane(promptHtml, label, true);
    // Wire copy button
    const copyBtn = $('#right-bottom-body .copy-prompt-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(data.prompt).then(
          () => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy Prompt to Clipboard'; }, 2000); },
          () => { copyBtn.textContent = 'Copy failed'; }
        );
      });
    }
  } catch (err) {
    showAnalysisPane(`Error building prompt: ${err.message}`, 'Error');
  }
}

function showAnalysisPane(content, titleText, isHtml = false) {
  const container = $('#right-bottom-body');
  container.innerHTML = isHtml ? content : `<div class="output-section">${escHtml(content)}</div>`;
  // Switch to Analysis tab and ensure pane is visible
  switchToAnalysisTab();
  showPane('right-bottom');
}

function switchToAnalysisTab() {
  for (const t of $$('#right-bottom .pane-tab')) t.classList.remove('active');
  const analysisTab = $('#right-bottom .pane-tab[data-tab="analysis"]');
  if (analysisTab) analysisTab.classList.add('active');
  $('#right-bottom-body').style.display = '';
  $('#console-panel').style.display = 'none';
}


// ========================================================================
// Refresh all open sections (after loading a new index)
// ========================================================================
function refreshAllSections() {
  const filter = $('#left-filter').value.trim();
  for (const sec of $$('.accordion-section.open')) {
    const sectionId = sec.dataset.section;
    state.sectionData[sectionId] = null;
    loadSectionData(sectionId, filter);
  }
}


// ========================================================================
// Filter
// ========================================================================
function initFilter() {
  $('#left-filter').addEventListener('input', () => {
    clearTimeout(state._filterTimer);
    state._filterTimer = setTimeout(() => {
      const filter = $('#left-filter').value.trim();
      for (const sec of $$('.accordion-section.open')) {
        const sectionId = sec.dataset.section;
        state.sectionData[sectionId] = null;
        loadSectionData(sectionId, filter);
      }
    }, 300);
  });
}


// ========================================================================
// Right-bottom tab switching (Analysis / Console)
// ========================================================================
function initRightBottomTabs() {
  for (const tab of $$('#right-bottom .pane-tab')) {
    tab.addEventListener('click', () => {
      for (const t of $$('#right-bottom .pane-tab')) t.classList.remove('active');
      tab.classList.add('active');
      const target = tab.dataset.tab;
      // Analysis tab
      const analysisBody = $('#right-bottom-body');
      const consolePanel = $('#console-panel');
      if (target === 'analysis') {
        analysisBody.style.display = '';
        consolePanel.style.display = 'none';
      } else {
        analysisBody.style.display = 'none';
        consolePanel.style.display = 'flex';
        $('#console-input').focus();
      }
    });
  }
}


// ========================================================================
// Console — interactive CLI commands within the GUI
// ========================================================================
const CONSOLE_HELP = `SEARCH:
  /search <query>          Literal search (or just type text without /)
  /regex /pattern/         Regex search
  /fast <query>            Fast inverted-index search
  /files-search <query>    Files containing term
  /folders-search <query>  Folders containing term
  /multisect t1;t2;t3      Multi-term intersection search
  /paths <pattern>         Search file/folder paths

BROWSE:
  /extract <func>          Extract function source
  /file <filepath>         Show entire file
  /files [pattern]         List/filter files
  /functions [pattern]     List functions
  /extensions              Show file extensions breakdown
  /stats                   Index statistics

CALL GRAPH:
  /callers <func>          Find callers
  /callees <func>          Find callees
  /most-called [N]         Most frequently called
  /call-inventory [func]   In-index vs external call targets
  /call-tree <func> [depth=N] [mermaid]   Call tree → Diagram pane
  /class-tree [filter] [mermaid]          Class inheritance hierarchy
  /file-map [filter] [mermaid]            File dependency map
  /file-tree <file> [depth=N] [mermaid]   File dependency tree

METRICS:
  /hotspots [N]            Most important functions (calls x size)
  /hot-folders [N]         Most important directories
  /entry-points [N]        Largest uncalled functions
  /gaps [N]                Suspicious dead code
  /domain-fns [N]          Domain-specific hotspots
  /classes [filter]        List classes with method counts
  /class-hotspots [N]      Classes ranked by hotspot score
  /vocabulary [N]          Domain tokens by TF-IDF

DUPLICATES:
  /func-dupes [N]          Exact duplicate functions
  /near-dupes [N]          Near-duplicate groups
  /struct-dupes [N]        Structural duplicate groups
  /funcstring <func>       Show structural form of function
  /struct-diff <func>      Diff structural duplicate variants
  /struct-diff-all [N]     All structural diff summaries
  /dupefiles [N]           Duplicate files

LLM:
  /claim <text|@file>      LLM claim search
  /analyze <func>          LLM function analysis → Analysis pane

OTHER:
  /set                     Show settings
  /set max N               Set max results
  /rebuild-functions       Rebuild function index
  /help                    This help
  /clear                   Clear console
  Bare text (no /) does a literal search.
`;

const consoleHistory = [];
let consoleHistoryIdx = -1;

function consoleAppend(text, cls) {
  const output = $('#console-output');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
  // Also write to fullscreen console if open
  if (window._consoleAppendTarget === 'both') fsConsoleAppend(text, cls);
}

function fsConsoleAppend(text, cls) {
  const output = $('#fs-console-output');
  if (!output) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

function consoleClear() {
  $('#console-output').innerHTML = '';
}

function initConsole() {
  const input = $('#console-input');
  if (!input) return;

  consoleAppend('Code Exam Console. Type /help for commands.\n', 'console-info');

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const cmd = input.value.trim();
      if (!cmd) return;
      consoleHistory.push(cmd);
      consoleHistoryIdx = consoleHistory.length;
      consoleAppend(`❯ ${cmd}`, 'console-cmd');
      input.value = '';
      try { await executeConsoleCommand(cmd); }
      catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (consoleHistoryIdx > 0) { consoleHistoryIdx--; input.value = consoleHistory[consoleHistoryIdx]; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (consoleHistoryIdx < consoleHistory.length - 1) { consoleHistoryIdx++; input.value = consoleHistory[consoleHistoryIdx]; }
      else { consoleHistoryIdx = consoleHistory.length; input.value = ''; }
    }
  });
}

async function executeConsoleCommand(cmd) {
  if (cmd === '/help') { consoleAppend(CONSOLE_HELP, 'console-info'); return; }
  if (cmd === '/clear') { consoleClear(); return; }

  // /call-tree without 'mermaid' flag → render in diagram pane via dedicated route
  if (cmd.startsWith('/call-tree ') && !cmd.includes('mermaid')) {
    const funcSpec = cmd.slice(11).trim();
    try {
      const consoleDepth = parseInt($('#diagram-depth')?.value) || 3;
      const data = await api.callTree({ func: funcSpec, depth: consoleDepth });
      consoleAppend(`Call tree for ${data.target} (depth ${consoleDepth}) rendered in Diagram pane.`, 'console-info');
      const body = $('#right-top-body'), ttl = $('#right-top-title');
      if (ttl) ttl.textContent = `Call tree: ${data.target} (depth ${consoleDepth})`;
      if (body) {
        body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>';
        const rootName = data.target;
        renderMermaid(data.mermaid, $('#diagram-viewport'), rootName, {
          onNodeClick: (nodeId, label) => { if (label && label !== rootName) openRelationshipView(rootName, label); },
        });
      }
      showPane('right-top');
    } catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
    return;
  }

  // /file-map → render in diagram pane via dedicated route
  if (cmd === '/file-map' || cmd.startsWith('/file-map ')) {
    const filter = cmd.slice(9).trim().replace(/\bmermaid\b/, '').trim() || undefined;
    try {
      const data = await api.fileMap({ filter });
      consoleAppend(`File map (${data.files} files, ${data.edges} edges) rendered in Diagram pane.`, 'console-info');
      const body = $('#right-top-body'), ttl = $('#right-top-title');
      if (ttl) ttl.textContent = 'File Dependency Map';
      if (body) {
        body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>';
        renderMermaid(data.mermaid, $('#diagram-viewport'), null, {
          onNodeClick: (nodeId, label) => { onFileClick(label); },
          onEdgeClick: (edgeId, labelText, nodeIdMap) => { openFileMapEdgeDetail(edgeId, labelText, nodeIdMap); },
        });
      }
      showPane('right-top');
    } catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
    return;
  }

  // /analyze → run via /api/exec but also show in Analysis pane
  if (cmd.startsWith('/analyze ')) {
    consoleAppend('Analyzing… (output in Analysis pane)', 'console-info');
    // Use dedicated LLM route for streaming to analysis pane
    const funcSpec = cmd.slice(9).trim();
    const engine = $('#ws-engine')?.value || 'claude';
    const mask = $('#ws-mask-all')?.checked || false;
    const maskComments = $('#ws-mask-comments')?.checked || false;
    try {
      const data = await api.analyzeLlm({ func: funcSpec, mode: 'analyze', engine, mask, maskComments });
      const analysisBody = $('#right-bottom-body');
      if (analysisBody) {
        const tab = $('[data-tab="analysis"]');
        if (tab) tab.click();
        analysisBody.innerHTML = `<div class="analysis-content"><h3>${data.target}</h3><pre style="white-space:pre-wrap">${escHtml(data.analysis || '(no analysis)')}</pre></div>`;
        showPane('right-bottom');
      }
      consoleAppend(`Analysis complete: ${data.target}`, 'console-accent');
    } catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
    return;
  }

  // Everything else → universal /api/exec
  try {
    const resp = await fetch(`/api/exec?cmd=${encodeURIComponent(cmd)}&max=25`);
    const data = await resp.json();
    if (data.error) {
      consoleAppend(`Error: ${data.error}`, 'console-err');
    } else {
      const output = data.output || '';
      if (output) {
        // Check if output contains mermaid and render it
        if (output.startsWith('graph ') || output.startsWith('flowchart ')) {
          consoleAppend('Mermaid diagram rendered in Diagram pane.', 'console-info');
          const body = $('#right-top-body'), ttl = $('#right-top-title');
          if (ttl) ttl.textContent = `Diagram: ${cmd}`;
          if (body) { body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>'; renderMermaid(output, $('#diagram-viewport'), cmd); }
          showPane('right-top');
        } else {
          for (const line of output.split('\n')) {
            consoleAppend(line);
          }
        }
      } else {
        consoleAppend('(no output)', 'console-info');
      }
    }
  } catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
}


// ========================================================================
// Window management — close/show panes, popout, Window menu
// ========================================================================
const PANE_IDS = ['middle-top', 'middle-bottom', 'right-top', 'right-bottom'];

function initWindowManagement() {
  // Close buttons (hide pane)
  for (const btn of $$('[data-close]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.close;
      hidePane(paneId);
    });
  }

  // Window menu checkboxes
  for (const id of PANE_IDS) {
    const cb = $(`#win-${id}`);
    if (cb) {
      cb.addEventListener('change', () => {
        if (cb.checked) showPane(id); else hidePane(id);
      });
    }
  }

  // Reset layout
  const resetBtn = $('[data-action="reset-layout"]');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      for (const id of PANE_IDS) showPane(id);
    });
  }

  // Generic popout buttons
  for (const btn of $$('[data-popout]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.popout;
      // For diagram pane, use existing diagram fullscreen
      if (paneId === 'right-top') {
        openDiagramFullscreen();
        return;
      }
      openGenericFullscreen(paneId);
    });
  }

  // Left pane popout
  $('#left-pane-popout')?.addEventListener('click', () => openGenericFullscreen('left-pane'));

  // Generic fullscreen close
  $('#generic-fs-close')?.addEventListener('click', closeGenericFullscreen);
  $('#generic-fullscreen')?.addEventListener('click', (e) => {
    if (e.target === $('#generic-fullscreen')) closeGenericFullscreen();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#generic-fullscreen').classList.contains('hidden')) closeGenericFullscreen();
  });
}

function hidePane(id) {
  const pane = $(`#${id}`);
  if (pane) pane.classList.add('pane-hidden');
  const cb = $(`#win-${id}`);
  if (cb) cb.checked = false;
}

function showPane(id) {
  const pane = $(`#${id}`);
  if (pane) pane.classList.remove('pane-hidden');
  const cb = $(`#win-${id}`);
  if (cb) cb.checked = true;
}

function openGenericFullscreen(paneId) {
  let paneBody, titleText;

  if (paneId === 'right-bottom') {
    const activeTab = $('#right-bottom .pane-tab.active');
    titleText = activeTab?.textContent || 'Panel';
    if (activeTab?.dataset.tab === 'console') {
      // Console popout: build a live console in fullscreen
      const overlay = $('#generic-fullscreen');
      const fsBody = $('#generic-fs-body');
      const fsTitle = $('#generic-fs-title');
      fsTitle.textContent = 'Console';
      fsBody.innerHTML = '';
      fsBody.style.display = 'flex';
      fsBody.style.flexDirection = 'column';
      fsBody.style.padding = '0';

      // Clone existing output
      const outputDiv = document.createElement('div');
      outputDiv.className = 'console-output';
      outputDiv.id = 'fs-console-output';
      outputDiv.innerHTML = $('#console-output').innerHTML;

      const inputRow = document.createElement('div');
      inputRow.className = 'console-input-row';
      inputRow.innerHTML = '<span class="console-prompt">❯</span><input type="text" id="fs-console-input" placeholder="Type command (try /help)…" spellcheck="false" autocomplete="off">';

      fsBody.appendChild(outputDiv);
      fsBody.appendChild(inputRow);
      overlay.classList.remove('hidden');

      const fsInput = $('#fs-console-input');
      fsInput.focus();
      fsInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          const cmd = fsInput.value.trim();
          if (!cmd) return;
          consoleHistory.push(cmd);
          consoleHistoryIdx = consoleHistory.length;
          // Append to both outputs
          fsConsoleAppend(`❯ ${cmd}`, 'console-cmd');
          consoleAppend(`❯ ${cmd}`, 'console-cmd');
          fsInput.value = '';
          const origAppend = window._consoleAppendTarget;
          window._consoleAppendTarget = 'both';
          try { await executeConsoleCommand(cmd); }
          catch (err) { fsConsoleAppend(`Error: ${err.message}`, 'console-err'); consoleAppend(`Error: ${err.message}`, 'console-err'); }
          window._consoleAppendTarget = origAppend;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (consoleHistoryIdx > 0) { consoleHistoryIdx--; fsInput.value = consoleHistory[consoleHistoryIdx]; }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (consoleHistoryIdx < consoleHistory.length - 1) { consoleHistoryIdx++; fsInput.value = consoleHistory[consoleHistoryIdx]; }
          else { consoleHistoryIdx = consoleHistory.length; fsInput.value = ''; }
        }
      });
      return;
    } else {
      paneBody = $('#right-bottom-body');
    }
  } else if (paneId === 'left-pane') {
    paneBody = $('#left-body');
    titleText = 'Indexes & Metrics';
    // Also reparent the filter bar
    state._fsFilterBar = $('#left-pane > .pane-filter');
    state._fsFilterParent = state._fsFilterBar?.parentElement;
  } else if (paneId === 'workspace') {
    paneBody = $('#workspace-body');
    titleText = 'Claim / Multisect Workspace';
  } else {
    paneBody = $(`#${paneId}-body`) || $(`#${paneId} .pane-body`);
    const paneTitle = $(`#${paneId}-title`) || $(`#${paneId} .pane-header span`);
    titleText = paneTitle?.textContent || 'Panel';
  }

  if (!paneBody) return;
  const overlay = $('#generic-fullscreen');
  const fsBody = $('#generic-fs-body');
  const fsTitle = $('#generic-fs-title');

  fsTitle.textContent = titleText;
  // Reparent the actual DOM node so live updates are visible in fullscreen
  fsBody.innerHTML = '';
  state._fsReturnTarget = paneBody.parentElement;
  state._fsReturnNode = paneBody;
  if (state._fsFilterBar) fsBody.appendChild(state._fsFilterBar);
  fsBody.appendChild(paneBody);
  overlay.classList.remove('hidden');
}

function closeGenericFullscreen() {
  const fsBody = $('#generic-fs-body');
  // Clear inline height on workspace textarea so it returns to flex sizing
  const ta = $('#claim-text');
  if (ta) ta.style.height = '';
  // Move reparented nodes back BEFORE hiding overlay (avoids layout loss)
  if (state._fsFilterBar && state._fsFilterParent) {
    state._fsFilterParent.insertBefore(state._fsFilterBar, state._fsFilterParent.firstChild);
    state._fsFilterBar = null;
    state._fsFilterParent = null;
  }
  if (state._fsReturnTarget && state._fsReturnNode) {
    state._fsReturnTarget.appendChild(state._fsReturnNode);
    // Force the browser to recalculate layout after reparenting
    state._fsReturnNode.offsetHeight;
    state._fsReturnTarget = null;
    state._fsReturnNode = null;
  }
  // Now hide overlay and clean up fullscreen container
  $('#generic-fullscreen').classList.add('hidden');
  while (fsBody.firstChild) fsBody.removeChild(fsBody.firstChild);
  fsBody.style.display = '';
  fsBody.style.padding = '';
  window._consoleAppendTarget = null;
}


// ========================================================================
// Init
// ========================================================================
async function init() {
  initMenus();
  initAccordion();
  initWorkspace();
  initSplitHandles();
  initColumnResizers();
  initDiagramControls();
  initCompareOverlay();
  initLoadIndex();
  initBuildIndex();
  initFilter();
  initRightBottomTabs();
  initConsole();
  initWindowManagement();
  refreshLlmStatus();

  // Pane navigation buttons (back/forward for both middle panes)
  $('#source-back-btn')?.addEventListener('click', () => navBack('middle-bottom'));
  $('#source-fwd-btn')?.addEventListener('click', () => navForward('middle-bottom'));
  $('#output-back-btn')?.addEventListener('click', () => navBack('middle-top'));
  $('#output-fwd-btn')?.addEventListener('click', () => navForward('middle-top'));

  for (const btn of $$('#context-menu button[data-ctx]')) btn.addEventListener('click', () => handleContextAction(btn.dataset.ctx));
  document.addEventListener('click', hideContextMenu);

  try {
    const data = await api.indexes();
    if (data.indexes && data.indexes.length > 0) {
      const active = data.indexes.find(i => i.active) || data.indexes[0];
      $('#index-info').textContent = `${active.name} (${active.files.toLocaleString()} files)`;
    }
  } catch { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', init);
