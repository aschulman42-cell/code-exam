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
  /** Filepath of currently displayed source (for disambiguation context) */
  currentSourceFile: null,
};

// ========================================================================
// API layer
// ========================================================================
const api = {
  async get(endpoint, params = {}) {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const url = `/api/${endpoint}${qs ? '?' + qs : ''}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  },
  async post(endpoint, body) {
    const resp = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
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
  claimExtractionPrompt: (p) => api.post('claim-extraction-prompt', p),
  indexes:         ()  => api.get('indexes'),
  loadIndex:       (p) => api.post('load-index', p),
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

  if (!wasOpen && !state.sectionData[sectionId]) {
    loadSectionData(sectionId);
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

      case 'classes':
        data = await api.listClasses({ filter, max: 200 });
        state.sectionData[sectionId] = data.classes;
        renderClassListWithSub(content, data.classes, data.total);
        badge.textContent = data.total;
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
        data = await api.mostCalled({ n: 50, filter });
        state.sectionData[sectionId] = data.functions;
        renderMostCalledList(content, data.functions, data.total);
        badge.textContent = data.total;
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
        data = await api.nearDupes({ n: 30 });
        state.sectionData[sectionId] = data.groups;
        renderDupeGroupList(content, data.groups, 'near');
        badge.textContent = data.total;
        break;

      case 'struct-dupes':
        data = await api.structDupes({ n: 30 });
        state.sectionData[sectionId] = data.groups;
        renderDupeGroupList(content, data.groups, 'struct');
        badge.textContent = data.total;
        break;

      case 'struct-diff':
        data = await api.structDiffAll({ n: 30 });
        state.sectionData[sectionId] = data.groups;
        renderStructDiffList(content, data.groups);
        badge.textContent = data.total;
        break;
    }
  } catch (err) {
    content.innerHTML = `<div class="error-msg">${escHtml(err.message)}</div>`;
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
      h('span', { className: 'filepath', text: shortPath(f.filepath, 35) }),
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
    const subHeader = h('div', { className: 'sub-accordion-header' }, [
      h('span', { className: 'sub-accordion-toggle', text: '▸' }),
      h('span', { className: 'name', text: name, style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' }),
      h('span', { className: 'filepath', text: shortPath(dir, 30), style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted)' }),
    ]);
    const sub = h('div', { className: 'sub-accordion', 'data-filepath': fp }, [subHeader, subContent]);

    // Click header: toggle sub-accordion (expand/collapse functions)
    subHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = sub.classList.contains('open');
      sub.classList.toggle('open');
      if (!wasOpen && subContent.children.length === 0) {
        loadFileFunctions(fp, subContent);
      }
    });

    // Double-click: show file in source pane
    subHeader.addEventListener('dblclick', (e) => { e.stopPropagation(); onFileClick(fp); });

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
      h('span', { className: 'filepath', text: shortPath(c.filepath, 20), style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted)' }),
    ]);
    const sub = h('div', { className: 'sub-accordion', 'data-class': c.name }, [subHeader, subContent]);

    subHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = sub.classList.contains('open');
      sub.classList.toggle('open');
      if (!wasOpen && subContent.children.length === 0) {
        loadClassMethods(c.name, subContent);
      }
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
function renderMostCalledList(container, items, total) {
  container.innerHTML = '';
  if (!items.length) { container.innerHTML = '<div class="list-placeholder">No functions found</div>'; return; }
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
// Dupe group lists (exact, near, structural)
// ========================================================================
function renderDupeGroupList(container, groups, type) {
  container.innerHTML = '';
  if (!groups.length) { container.innerHTML = '<div class="list-placeholder">No duplicates found</div>'; return; }
  for (const g of groups) {
    const extra = type === 'near' ? `${g.variants}v` : type === 'struct' ? `${g.unique_bodies}b` : `${g.waste}w`;
    const item = h('div', { className: 'list-item', title: `${g.name}\n${g.count} copies × ${g.lines} lines\n${(g.files || []).join('\n')}` }, [
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
  // Prefer instances (have name + filepath) over bare files
  if (instances.length > 0) {
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      html += `<tr><td class="muted">${i + 1}</td>`;
      html += `<td class="mono"><span class="clickable" data-funcname="${escHtml(inst.name || group.name)}" data-filepath="${escHtml(inst.filepath)}">${escHtml(inst.display_name || inst.name || group.name)}</span></td>`;
      html += `<td class="mono muted">${escHtml(shortPath(inst.filepath, 50))}</td></tr>`;
    }
  } else {
    for (let i = 0; i < files.length; i++) {
      html += `<tr><td class="muted">${i + 1}</td><td class="mono">—</td>`;
      html += `<td class="mono"><span class="clickable" data-filepath="${escHtml(files[i])}">${escHtml(shortPath(files[i], 70))}</span></td></tr>`;
    }
  }
  html += '</table></div>';

  // For structural dupes, offer funcstring view
  if (type === 'struct') {
    html += `<div class="output-section"><button class="btn-secondary" id="show-funcstring-btn" style="margin:4px 0">Show Funcstring (structural normalization)</button>`;
    html += `<pre class="funcstring-view" id="funcstring-view" style="display:none;white-space:pre-wrap;font-size:11px;color:var(--text-dim);padding:6px;background:var(--bg-dark);border:1px solid var(--border);max-height:300px;overflow:auto"></pre></div>`;
  }

  container.innerHTML = html;
  wireClickables(container, { sourceOnly: true });

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
      html += `<td class="mono muted">${escHtml(shortPath(inst.filepath, 45))}</td></tr>`;
    }
    html += '</table>';
  }

  html += '</div>';
  container.innerHTML = html;
  wireClickables(container, { sourceOnly: true });
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

async function onFileClick(filepath) {
  showMiddleBottomLoading(`Loading ${filepath}…`);
  try {
    const data = await api.showFile({ path: filepath });
    renderFileSource(data);
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
function showMiddleTopLoading(msg) { navPush('middle-top'); $('#middle-top-body').innerHTML = `<div class="loading">${escHtml(msg)}</div>`; $('#middle-top-title').textContent = 'Loading…'; }
function showMiddleTopError(msg)   { $('#middle-top-body').innerHTML = `<div class="error-msg">${escHtml(msg)}</div>`; $('#middle-top-title').textContent = 'Error'; }
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
  $('#right-bottom-title').textContent = 'Analysis';
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

function renderFileSource(data) {
  const container = $('#middle-bottom-body'), title = $('#middle-bottom-title');
  title.textContent = `${data.filepath}  (${data.lines} lines)`;
  state.currentSourceFile = data.filepath;
  const lines = data.content.split('\n');
  const hl = state.highlightTerms;
  let html = '<div class="source-view">';
  for (let i = 0; i < lines.length; i++) {
    let content = escHtml(lines[i]);
    if (hl) content = highlightLine(content, hl.terms, hl.colors);
    html += `<div class="source-line"><span class="line-number">${i + 1}</span><span class="line-content">${content}</span></div>`;
  }
  container.innerHTML = html + '</div>';
  linkifySourceCalls(container, data.filepath);
  navUpdateButtons('middle-bottom');
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

  for (const lineEl of container.querySelectorAll('.line-content')) {
    // Get the full line text for string/comment detection
    const fullLineText = lineEl.textContent;

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
      html += `<tr><td class="mono"><span class="clickable" data-funcname="${escHtml(c.name)}">${escHtml(c.display_name || c.name)}</span></td>`;
      html += `<td class="muted">${c.call_type}</td><td class="${isDef ? '' : 'muted'}">${isDef ? `${c.definitions} def` : 'external'}</td></tr>`;
    }
    html += '</table></div>';
  }

  const cl = callersData.callers || [];
  if (cl.length) {
    const showAll = cl.length <= 15;
    const visibleCallers = showAll ? cl : cl.slice(0, 15);
    html += `<div class="output-section"><h3>Called By (${cl.length})</h3><table class="output-table"><tr><th>Caller</th><th>File</th><th>Line</th></tr>`;
    for (const c of visibleCallers) {
      const cn = c.caller_function || '(file scope)';
      html += `<tr><td class="mono"><span class="clickable" data-funcname="${escHtml(cn)}">${escHtml(cn)}</span></td>`;
      html += `<td class="mono muted">${escHtml(shortPath(c.filepath, 30))}</td><td>${c.line_number}</td></tr>`;
    }
    html += '</table>';
    if (!showAll) html += `<div class="list-placeholder" style="cursor:pointer;color:var(--accent)" id="show-all-callers">Show all ${cl.length} callers…</div>`;
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
  title.textContent = `Callers of ${funcName} (${data.callers.length})`;
  if (!data.callers.length) { container.innerHTML = '<div class="list-placeholder">No callers found</div>'; return; }
  let html = '<div class="output-section"><table class="output-table"><tr><th>Caller</th><th>File</th><th>Line</th><th>Type</th></tr>';
  for (const c of data.callers) {
    const cn = c.caller_function || '(file scope)';
    html += `<tr><td class="mono"><span class="clickable" data-funcname="${escHtml(cn)}">${escHtml(cn)}</span></td>`;
    html += `<td class="mono muted">${escHtml(shortPath(c.filepath, 30))}</td><td>${c.line_number}</td><td class="muted">${c.call_type}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  wireClickables(container);
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
  let html = '';
  for (const r of data.results) {
    html += '<div class="output-section" style="padding:4px 12px;border-bottom:1px solid var(--border)">';
    html += `<span class="mono muted" style="font-size:11px">${escHtml(shortPath(r.filepath, 50))}:${r.line_number}`;
    if (r.containing_function) html += ` <span class="clickable" data-funcname="${escHtml(r.containing_function)}">${escHtml(r.containing_function)}</span>`;
    const hlLine = highlightLine(escHtml(r.line_text), [query], HIGHLIGHT_COLORS);
    html += `</span><pre style="font-family:var(--font-mono);font-size:12px;margin:2px 0;color:var(--text-bright)">${hlLine}</pre></div>`;
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
      const name = el.dataset.funcname;
      const filepath = el.dataset.filepath || null;
      if (name && name !== '(file scope)' && name !== '(unknown)') {
        clickHandler({ name, display_name: name, filepath });
      }
    });
    el.addEventListener('contextmenu', (e) => {
      const name = el.dataset.funcname;
      const filepath = el.dataset.filepath || null;
      if (name && name !== '(file scope)' && name !== '(unknown)') {
        showContextMenu(e, { name, display_name: name, filepath });
      }
    });
  }
  // Wire file-only clicks (no funcname)
  for (const el of $$('.clickable[data-filepath]', container)) {
    if (!el.dataset.funcname) {
      el.addEventListener('click', () => onFileClick(el.dataset.filepath));
    }
  }
}


// ========================================================================
// Context menu
// ========================================================================
function showContextMenu(e, funcInfo) {
  e.preventDefault();
  state.contextTarget = funcInfo;
  const menu = $('#context-menu');
  menu.classList.remove('hidden');
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
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
      const body = $('#right-top-body'), ttl = $('#right-top-title');
      ttl.textContent = `Call tree: ${target.name}`;
      body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"><div class="loading">Building call tree…</div></div>';
      try {
        const data = await api.callTree({ func: funcSpec, depth: 3 });
        renderMermaid(data.mermaid, $('#diagram-viewport'), data.target);
      } catch (err) {
        $('#diagram-viewport').innerHTML = `<div class="error-msg">${escHtml(err.message)}</div>`;
      }
      break;
    }

    case 'analyze': {
      const funcSpec = target.filepath
        ? `${target.filepath}@${target.name || target.display_name}`
        : (target.name || target.display_name);
      await buildAndShowPrompt('analyze', { func: funcSpec });
      break;
    }

    default: console.log(`Context action '${action}' not implemented`, target);
  }
}


// ========================================================================
// Mermaid rendering with zoom
// ========================================================================
function renderMermaid(mermaidText, container, rootNodeName) {
  state.lastMermaidText = mermaidText;
  state.lastMermaidRoot = rootNodeName || null;
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
    mermaid.render(id, fullText).then(({ svg }) => { container.innerHTML = svg; }).catch(err => {
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
}

function openDiagramFullscreen() {
  if (!state.lastMermaidText) return;
  const overlay = $('#diagram-fullscreen');
  overlay.classList.remove('hidden');
  $('#fullscreen-title').textContent = $('#right-top-title').textContent;
  state.diagramZoom = 1.0;
  renderMermaid(state.lastMermaidText, $('#fullscreen-viewport'), state.lastMermaidRoot);
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

  $('#load-index-close').addEventListener('click', () => overlay.classList.add('hidden'));
  $('#load-index-cancel').addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });

  $('#load-index-ok').addEventListener('click', async () => {
    const indexPath = pathInput.value.trim();
    if (!indexPath) { errDiv.textContent = 'Enter an index path'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';

    const mode = $('#load-index-add').checked ? 'add' : 'replace';
    try {
      $('#load-index-ok').disabled = true;
      $('#load-index-ok').textContent = 'Loading…';
      const result = await api.loadIndex({ path: indexPath, mode });
      overlay.classList.add('hidden');

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
    } catch (err) {
      errDiv.textContent = err.message;
      errDiv.style.display = 'block';
    } finally {
      $('#load-index-ok').disabled = false;
      $('#load-index-ok').textContent = 'Load';
    }
  });

  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#load-index-ok').click(); });
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
  document.addEventListener('click', () => { for (const d of $$('.dropdown')) d.classList.remove('open'); for (const b of $$('.menu-btn')) b.classList.remove('open'); });
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
      $('#load-index-overlay').classList.remove('hidden');
      setTimeout(() => $('#load-index-path').focus(), 100);
      break;
    case 'search-literal': case 'search-regex': case 'search-fast': {
      const label = action === 'search-literal' ? 'Literal' : action === 'search-regex' ? 'Regex' : 'Fast';
      const query = prompt(`${label} search:`);
      if (!query) return;
      showMiddleTopLoading(`Searching: "${query}"…`);
      try { renderSearchResults(query, await api.search({ q: query, max: 30 })); } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    case 'files-search': {
      const term = prompt('Files containing:');
      if (!term) return;
      state.highlightTerms = { terms: [term], colors: HIGHLIGHT_COLORS };
      try { renderFilesSearchResults(term, await api.filesSearch({ q: term, max: 40 })); } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    default: console.log(`Menu action '${action}' not implemented`);
  }
}


// ========================================================================
// Workspace
// ========================================================================
function initWorkspace() {
  $('#workspace-toggle').addEventListener('click', () => {
    document.body.classList.toggle('workspace-open');
    const isOpen = document.body.classList.contains('workspace-open');
    $('#workspace-expand-btn').textContent = isOpen ? '▾ Collapse' : '▴ Expand';
    // Set initial height if opening for first time
    const ws = $('#workspace');
    if (isOpen && !ws.style.height) ws.style.height = '180px';
  });
  $('#ws-run').addEventListener('click', runWorkspace);
  $('#ws-show-prompt').addEventListener('click', showWorkspacePrompt);

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
  const mode = $('#ws-mode').value, text = $('#claim-text').value.trim();
  if (!text) return;

  if (mode === 'multisect-search') {
    showMiddleTopLoading('Running multisect search…');
    try {
      const data = await api.multisect({ terms: text, max: 30 });
      renderMultisectResults(data);
    } catch (err) { showMiddleTopError(err.message); }

  } else if (mode === 'claim-search') {
    showMiddleTopLoading('Extracting claim keywords and searching…');
    try {
      const data = await api.claimSearch({ claim: text, max: 30 });
      renderMultisectResults(data);
      // Append extracted keywords info below the term chips
      const termsDiv = $('#workspace-terms');
      if (termsDiv && data.keywords) {
        const kw = document.createElement('div');
        kw.style.marginTop = '4px';
        kw.innerHTML = `<span class="muted" style="font-size:11px">Extracted ${data.keywords.length} keywords from claim</span>`;
        termsDiv.appendChild(kw);
      }
    } catch (err) { showMiddleTopError(err.message); }

  } else if (mode === 'multisect-analyze') {
    // Search first, then build prompt for top hit
    showMiddleTopLoading('Running multisect search for analysis…');
    try {
      const searchData = await api.multisect({ terms: text, max: 10 });
      renderMultisectResults(searchData);
      // Build prompt for top function result
      const topFunc = (searchData.results || []).find(r => r.scope_type === 'function');
      if (topFunc) {
        await buildAndShowPrompt('multisect-analyze', {
          func: `${topFunc.filepath}@${topFunc.function_name}`,
          terms: text,
        });
      } else {
        showAnalysisPane('No function matches found for analysis.', 'Multisect Analyze');
      }
    } catch (err) { showMiddleTopError(err.message); }

  } else if (mode === 'claim-analyze') {
    // Claim search first, then build prompt for top hit
    showMiddleTopLoading('Extracting keywords and searching for analysis…');
    try {
      const searchData = await api.claimSearch({ claim: text, max: 10 });
      renderMultisectResults(searchData);
      const topFunc = (searchData.results || []).find(r => r.scope_type === 'function');
      if (topFunc) {
        await buildAndShowPrompt('claim-analyze', {
          func: `${topFunc.filepath}@${topFunc.function_name}`,
          claim: text,
        });
      } else {
        showAnalysisPane('No function matches found for claim analysis.', 'Claim Analyze');
      }
    } catch (err) { showMiddleTopError(err.message); }

  } else {
    showMiddleTopLoading(`Mode "${mode}" not yet wired to GUI`);
  }
}

async function showWorkspacePrompt() {
  const mode = $('#ws-mode').value, text = $('#claim-text').value.trim();
  if (!text) return;

  if (mode === 'multisect-search') {
    // Multisect search doesn't use an LLM prompt — just run normally
    return runWorkspace();
  }

  if (mode === 'claim-search' || mode === 'claim-analyze') {
    // Show the LLM extraction prompt (system prompt + user message)
    showMiddleTopLoading('Building claim extraction prompt…');
    try {
      const engine = $('#ws-engine').value;
      const vocabTight = $('#ws-vocab-tight')?.checked || false;
      const noVocabulary = $('#ws-no-vocab')?.checked || false;
      const data = await api.claimExtractionPrompt({
        claim: text, engine, vocabTight, noVocabulary,
      });

      // Show extraction prompt in middle-top with copy buttons
      const vocabNote = data.vocabChars > 0
        ? `Vocabulary-augmented (${data.vocabChars.toLocaleString()} chars)`
        : 'No vocabulary context';
      const promptHtml = `
        <div style="margin-bottom:8px">
          <span class="muted">Mode: ${escHtml(mode)} | Engine: ${escHtml(data.engine)} | ${vocabNote}</span>
          <span class="muted" style="margin-left:10px">Heuristic keywords (${data.keywords.length}): ${escHtml(data.keywords.slice(0, 15).join(', '))}${data.keywords.length > 15 ? '…' : ''}</span>
        </div>
        <div style="margin-bottom:6px; font-weight:bold; color:var(--accent)">═══ SYSTEM PROMPT (send as system message to LLM) ═══
          <button class="btn-secondary" style="margin-left:12px;font-size:11px" onclick="navigator.clipboard.writeText(document.getElementById('claim-sys-prompt').textContent).then(()=>this.textContent='Copied!').catch(()=>{})">Copy System Prompt</button>
        </div>
        <pre id="claim-sys-prompt" class="source-view" style="max-height:250px; overflow:auto; margin-bottom:12px; white-space:pre-wrap; font-size:11px">${escHtml(data.systemPrompt)}</pre>
        <div style="margin-bottom:6px; font-weight:bold; color:var(--accent)">═══ USER MESSAGE (the patent claim text) ═══
          <button class="btn-secondary" style="margin-left:12px;font-size:11px" onclick="navigator.clipboard.writeText(document.getElementById('claim-user-msg').textContent).then(()=>this.textContent='Copied!').catch(()=>{})">Copy User Message</button>
        </div>
        <pre id="claim-user-msg" class="source-view" style="max-height:150px; overflow:auto; white-space:pre-wrap; font-size:11px">${escHtml(data.userMessage)}</pre>
        <div style="margin-top:10px">
          <button class="btn-secondary" onclick="navigator.clipboard.writeText(document.getElementById('claim-sys-prompt').textContent + '\\n\\n---USER MESSAGE---\\n\\n' + document.getElementById('claim-user-msg').textContent).then(()=>this.textContent='Copied both!').catch(()=>{})">Copy Both (System + User)</button>
        </div>
      `;
      showAnalysisPane(promptHtml, `Claim Extraction Prompt (${data.engine})`, true);
    } catch (err) { showAnalysisPane(`Error: ${err.message}`, 'Prompt Error'); }
    return;
  }

  // For multisect-analyze: search first to find the target, then show prompt
  showMiddleTopLoading('Searching for prompt target…');
  try {
    const searchData = await api.multisect({ terms: text, max: 10 });
    renderMultisectResults(searchData);
    const topFunc = (searchData.results || []).find(r => r.scope_type === 'function');
    if (topFunc) {
      await buildAndShowPrompt('multisect-analyze', {
        func: `${topFunc.filepath}@${topFunc.function_name}`,
        terms: text,
      }, true);
    } else {
      showAnalysisPane('No function matches found to build prompt.', 'Show Prompt');
    }
  } catch (err) { showAnalysisPane(`Error: ${err.message}`, 'Prompt Error'); }
}

async function buildAndShowPrompt(mode, params, showPromptOnly = false) {
  const mask = $('#ws-mask-all')?.checked || false;
  const body = { mode, mask, lineNumbers: true, ...params };
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
  const container = $('#right-bottom-body'), title = $('#right-bottom-title');
  title.textContent = titleText || 'Analysis';
  container.innerHTML = isHtml ? content : `<div class="output-section">${escHtml(content)}</div>`;
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
// Init
// ========================================================================
async function init() {
  initMenus();
  initAccordion();
  initWorkspace();
  initSplitHandles();
  initColumnResizers();
  initDiagramControls();
  initLoadIndex();
  initFilter();

  // Pane navigation buttons (back/forward for both middle panes)
  $('#source-back-btn')?.addEventListener('click', () => navBack('middle-bottom'));
  $('#source-fwd-btn')?.addEventListener('click', () => navForward('middle-bottom'));
  $('#output-back-btn')?.addEventListener('click', () => navBack('middle-top'));
  $('#output-fwd-btn')?.addEventListener('click', () => navForward('middle-top'));

  for (const btn of $$('#context-menu button[data-ctx]')) btn.addEventListener('click', () => handleContextAction(btn.dataset.ctx));
  document.addEventListener('click', hideContextMenu);

  for (const btn of $$('.pane-action[data-action]')) {
    btn.addEventListener('click', () => {
      const bodyId = btn.dataset.action.replace('clear-', '') + '-body';
      const body = $(`#${bodyId}`);
      if (body) body.innerHTML = '<div class="list-placeholder">Cleared</div>';
    });
  }

  try {
    const data = await api.indexes();
    if (data.indexes && data.indexes.length > 0) {
      const active = data.indexes.find(i => i.active) || data.indexes[0];
      $('#index-info').textContent = `${active.name} (${active.files.toLocaleString()} files)`;
    }
  } catch { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', init);
