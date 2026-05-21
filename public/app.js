/**
 * app.js - Code Exam GUI client.
 * Zero external dependencies. Pure DOM manipulation.
 */
'use strict';

import { state } from './state.js';
import { api } from './api.js';
import {
  $, $$, h, escHtml, displayNameHtml, copyToClipboard,
  shortPath, shortFuncName, HIGHLIGHT_COLORS, highlightLine,
  INFERRED_SUFFIX_RE, makeDraggable, makeResizable,
} from './dom-utils.js';
import {
  openCompareView, initCompareOverlay,
  setupExtractionPromptOverlay, showExtractionPrompt,
  makeResizeHandle,
} from './overlays.js';
import {
  initDialogs, showSearchDialog, showConfirmDialog, openModelBrowser,
} from './dialogs.js';
import {
  showPane, hidePane,
  initColumnResizers, initSplitHandles, initFilter,
  initWindowManagementWithDeps, openGenericFullscreen,
} from './layout.js';
import {
  initConsole, consoleAppend, fsConsoleAppend, executeConsoleCommand,
} from './console.js';
import {
  initClickHandlers,
  onFunctionClick, onFunctionClickSourceOnly,
  onFileClick, onClassClick, onClassClickSourceOnly,
  onVocabClick,
} from './click-handlers.js';
import {
  initContextMenu, refreshLlmStatus,
  showContextMenu, hideContextMenu, handleContextAction,
} from './context-menu.js';
import {
  renderMermaid, openFileMapEdgeDetail,
  initDiagramControls, openDiagramFullscreen,
} from './mermaid.js';
import {
  initSourceViewer,
  renderSource, renderFileSource, linkifySourceCalls,
} from './source-viewer.js';
import {
  initPromptsAndCatalog,
  renderPromptList, renderStringDetail, renderBreadcrumbs,
  renderBundleSeams, renderCommandCatalog, renderStructDiffList,
} from './prompts-and-catalog.js';
import { initMenuBar } from './menu-bar.js';
import {
  initMiddlePane,
  showMiddleTopLoading, showMiddleTopError,
  showMiddleBottomLoading, showMiddleBottomError,
  navPush, navBack, navForward, navUpdateButtons, navClearAll, clearAllPanes,
  renderCallInfo, renderDisambiguation, renderDigest,
  renderCallersOnly, renderCalleesOnly, renderClassMethodsDetail,
  renderFilesSearchResults, renderSearchResults, renderStats,
  renderMultisectResults,
  _renderScopeViews, _wireMultisectToggles,
} from './middle-pane.js';

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

function getMaxResults() {
  return parseInt($('#opt-max-results')?.value) || 50;
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
        data = await api.hotspots({ n: getMaxResults(), filter });
        state.sectionData[sectionId] = data.hotspots;
        renderFuncLikeList(content, data.hotspots, 'score');
        badge.textContent = data.hotspots.length;
        break;

      case 'hot-folders':
        data = await api.hotFolders({ n: getMaxResults(), filter });
        state.sectionData[sectionId] = data.folders;
        renderHotFolderList(content, data.folders);
        badge.textContent = data.folders.length;
        break;

      case 'most-called':
        data = await api.mostCalled({ n: getMaxResults(), filter, defined_only: state.mostCalledDefinedOnly ? '1' : '' });
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
        data = await api.classHotspots({ n: getMaxResults(), filter });
        state.sectionData[sectionId] = data.classes;
        renderClassHotspotList(content, data.classes);
        badge.textContent = data.classes.length;
        break;

      case 'entry-points':
        data = await api.entryPoints({ n: getMaxResults(), filter });
        state.sectionData[sectionId] = data.entries;
        renderFuncLikeList(content, data.entries, 'lines');
        badge.textContent = data.entries.length;
        break;

      case 'domain-fns':
        data = await api.domainFns({ n: getMaxResults(), filter });
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
        data = await api.funcDupes({ n: getMaxResults(), filter });
        state.sectionData[sectionId] = data.groups;
        renderDupeGroupList(content, data.groups, 'exact');
        badge.textContent = data.total;
        break;

      case 'near-dupes':
        data = await api.nearDupes({ n: getMaxResults(), filter });
        state.sectionData[sectionId] = data.groups;
        renderDupeGroupList(content, data.groups, 'near');
        badge.textContent = data.total;
        break;

      case 'struct-dupes':
        data = await api.structDupes({ n: getMaxResults(), filter });
        state.sectionData[sectionId] = data.groups;
        renderDupeGroupList(content, data.groups, 'struct');
        badge.textContent = data.total;
        break;

      case 'struct-diff':
        data = await api.structDiffAll({ n: getMaxResults(), filter });
        state.sectionData[sectionId] = data.groups;
        renderStructDiffList(content, data.groups);
        badge.textContent = data.total;
        break;

      case 'surprising-funcstrings': {
        const o = state.surprisingFsOpts;
        data = await api.surprisingFuncstrings({
          limit: getMaxResults(),
          filter,
          minLines: o.minLines,
          minSurprise: o.minSurprise,
          sortBy: o.sortBy,
          includeAllExact: o.includeAllExact ? 1 : 0,
          tight: o.tight ? 1 : 0,
        });
        state.sectionData[sectionId] = data.groups;
        renderSurprisingFuncstringsList(content, data.groups, data);
        badge.textContent = data.total;
        break;
      }

      case 'strings':
        data = await api.stringTable({ filter, max: getMaxResults() * 2 });
        state.sectionData[sectionId] = data.strings;
        renderStringTable(content, data.strings, data);
        badge.textContent = data.total;
        break;

      case 'prompts':
        data = await api.prompts({ filter });
        state.sectionData[sectionId] = data.prompts;
        renderPromptList(content, data.prompts, data.total);
        badge.textContent = data.total;
        break;

      case 'command-catalog':
        data = await api.commandCatalog();
        state.sectionData[sectionId] = data;
        renderCommandCatalog(content, data, filter);
        badge.textContent = (data.cliOptions?.length || 0) + (data.commands?.length || 0) +
                           (data.routes?.length || 0) + (data.guiActions?.length || 0);
        break;

      case 'breadcrumbs':
        data = await api.breadcrumbs();
        state.sectionData[sectionId] = data;
        renderBreadcrumbs(content, data, filter);
        badge.textContent = (data.markers?.length || 0) + (data.events?.length || 0);
        break;

      case 'bundle-seams':
        data = await api.bundleSeams({ filter });
        state.sectionData[sectionId] = data;
        renderBundleSeams(content, data, filter);
        badge.textContent = (data.files || []).reduce((sum, f) => sum + f.moduleCount, 0);
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
      h('span', { className: 'name clickable', html: displayNameHtml(f.display_name || f.name) }),
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
      h('span', { className: 'name clickable', html: displayNameHtml(f.display_name) }),
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
      h('span', { className: 'name', html: displayNameHtml(c.name), style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' }),
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
        h('span', { className: 'name clickable', html: displayNameHtml(m.name) }),
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

// ========================================================================
// Surprising Funcstrings — codebase-wide scan of struct-hash groups
// containing pairs whose names/paths/extensions are unusually distant.
// ========================================================================
function renderSurprisingFuncstringsList(container, groups, meta) {
  container.innerHTML = '';
  const o = state.surprisingFsOpts;
  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:4px 6px;font-size:11px;align-items:center;border-bottom:1px solid var(--border)';
  toolbar.innerHTML = `
    <label title="Skip functions below this size. In tight mode counts CODE lines (comments and blanks stripped); otherwise counts raw source lines including comments — so a 1-line return-stub with an 18-line Javadoc would pass min-lines=10 unless tight is also on.">
      min lines <input type="number" id="sfs-minLines" min="3" max="200" value="${o.minLines}" style="width:48px">
    </label>
    <label title="Hide groups whose peak pairwise surprise falls below this threshold (0–1)">
      min surprise <input type="number" id="sfs-minSurprise" min="0" max="1" step="0.05" value="${o.minSurprise}" style="width:54px">
    </label>
    <label title="Sort key — peak: best pair in group; mean: average pair; lines: function size">
      sort
      <select id="sfs-sortBy" style="font-size:11px">
        <option value="peak"${o.sortBy === 'peak' ? ' selected' : ''}>peak</option>
        <option value="mean"${o.sortBy === 'mean' ? ' selected' : ''}>mean</option>
        <option value="lines"${o.sortBy === 'lines' ? ' selected' : ''}>lines</option>
      </select>
    </label>
    <label title="Include groups where every instance is byte-identical (default off — those are just verbatim copies)">
      <input type="checkbox" id="sfs-includeAllExact"${o.includeAllExact ? ' checked' : ''}> all-exact
    </label>
    <label title="Use the tight normalizer: requires ≥1 control-flow keyword (drops bag-of-constants idioms and chained defineProperty wrappers) and run-length-collapses repeated statements. First toggle rebuilds the hash table for this index — may take a few seconds on large indexes.">
      <input type="checkbox" id="sfs-tight"${o.tight ? ' checked' : ''}> tight
    </label>
  `;
  container.appendChild(toolbar);

  const reload = () => {
    o.minLines = Math.max(3, parseInt($('#sfs-minLines', toolbar).value) || 3);
    o.minSurprise = Math.max(0, Math.min(1, parseFloat($('#sfs-minSurprise', toolbar).value) || 0));
    o.sortBy = $('#sfs-sortBy', toolbar).value;
    o.includeAllExact = $('#sfs-includeAllExact', toolbar).checked;
    o.tight = $('#sfs-tight', toolbar).checked;
    const filter = $('#left-filter').value.trim();
    loadSectionData('surprising-funcstrings', filter);
  };
  $('#sfs-minLines', toolbar).addEventListener('change', reload);
  $('#sfs-minSurprise', toolbar).addEventListener('change', reload);
  $('#sfs-sortBy', toolbar).addEventListener('change', reload);
  $('#sfs-includeAllExact', toolbar).addEventListener('change', reload);
  $('#sfs-tight', toolbar).addEventListener('change', reload);

  if (!groups || !groups.length) {
    const empty = document.createElement('div');
    empty.className = 'list-placeholder';
    empty.textContent = 'No notable funcstring matches at these thresholds';
    container.appendChild(empty);
    return;
  }
  for (const g of groups) {
    const shortHash = (g.struct_hash || '').slice(0, 8);
    const pp = g.peak_pair;
    const peerHint = pp
      ? `${pp.a_display || pp.a} ↔ ${pp.b_display || pp.b}`
      : `${g.count} instances`;
    const tooltip = `peak surprise ${g.peak_surprise}\n` +
      `mean surprise ${g.mean_surprise}\n` +
      `${g.count} instances · ${g.lines} lines · ${g.unique_bodies} unique bodies\n` +
      `hash ${g.struct_hash}` +
      (pp ? `\n\npeak pair:\n  ${pp.a_display || pp.a}  (${pp.a_filepath})\n  ${pp.b_display || pp.b}  (${pp.b_filepath})` : '');
    const item = h('div', { className: 'list-item', title: tooltip }, [
      h('span', { className: 'rank', text: `${g.rank}` }),
      h('span', { className: 'metric', text: g.peak_surprise.toFixed(2) }),
      h('span', { className: 'name clickable', text: peerHint }),
      h('span', { className: 'metric muted', text: `${g.count}×` }),
      h('span', { className: 'metric muted', text: `${g.lines}L` }),
      h('span', { className: 'filepath', text: shortHash + '…' }),
    ]);
    item.addEventListener('click', () => renderSurprisingGroupDetail(g));
    container.appendChild(item);
  }
}

function renderSurprisingGroupDetail(group) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const shortHash = (group.struct_hash || '').slice(0, 12);
  title.textContent = `Notable Funcstring Match: ${shortHash}…  (peak ${group.peak_surprise.toFixed(2)})`;

  const pp = group.peak_pair;
  let html = '<div class="output-section">';
  html += `<table class="output-table">`;
  html += `<tr><td class="muted">struct_hash</td><td class="mono" title="${escHtml(group.struct_hash)}">${escHtml(group.struct_hash)}</td></tr>`;
  const linesDisplay = (group.raw_lines && group.raw_lines !== group.lines)
    ? `${group.lines} <span class="muted" style="font-size:11px">(${group.raw_lines} incl. comments/blanks)</span>`
    : `${group.lines}`;
  html += `<tr><td class="muted">Lines</td><td>${linesDisplay}</td></tr>`;
  html += `<tr><td class="muted">Instances</td><td>${group.count} (${group.unique_bodies} unique bodies)</td></tr>`;
  html += `<tr><td class="muted">Peak surprise</td><td><strong>${group.peak_surprise.toFixed(3)}</strong>` +
          ` &nbsp; <span class="muted" style="font-size:11px">mean ${group.mean_surprise.toFixed(3)}, ${group.pairs_sampled} pair${group.pairs_sampled !== 1 ? 's' : ''} sampled</span></td></tr>`;
  if (pp) {
    html += `<tr><td class="muted">Peak pair</td><td><span class="mono">${escHtml(pp.a_display || pp.a)}</span>` +
            ` ↔ <span class="mono">${escHtml(pp.b_display || pp.b)}</span>` +
            ` <span class="muted" style="font-size:11px">(name ${pp.nameDist.toFixed(2)}, path ${pp.pathDist.toFixed(2)}${pp.crossLang ? ', cross-lang' : ''})</span></td></tr>`;
  }
  html += `</table></div>`;

  html += '<div class="output-section">';
  html += `<table class="output-table" id="surprising-instances">`;
  html += `<tr><th>#</th><th>Function</th><th>File</th><th>Body</th></tr>`;
  // Sort so members of larger exact-body clusters come first (gives a feel of
  // "this body shape × this many places" the way the Opstrings listing did),
  // then by filepath for stability.
  const sorted = [...group.instances].sort((a, b) => {
    if ((b.exact_copies || 0) !== (a.exact_copies || 0))
      return (b.exact_copies || 0) - (a.exact_copies || 0);
    return (a.filepath || '').localeCompare(b.filepath || '');
  });
  // Tag distinct body_hash clusters with short labels so the eye can
  // group rows that share an exact body. A=largest cluster, B=next, etc.
  const bodyLabel = new Map();
  let nextLabel = 0;
  const bodyOrder = [...new Set(sorted.map(i => i.body_hash))];
  bodyOrder.forEach(h => {
    bodyLabel.set(h, String.fromCharCode(65 + (nextLabel++ % 26)));
  });
  for (let i = 0; i < sorted.length; i++) {
    const inst = sorted[i];
    const lbl = bodyLabel.get(inst.body_hash) || '?';
    const copies = inst.exact_copies || 1;
    html += `<tr>`;
    html += `<td class="muted">${i + 1}</td>`;
    html += `<td class="mono"><span class="clickable" data-funcname="${escHtml(inst.name)}" data-filepath="${escHtml(inst.filepath)}">${escHtml(inst.display_name || inst.name)}</span></td>`;
    html += `<td class="mono clickable file-link" data-filepath="${escHtml(inst.filepath)}" data-start="${inst.start || ''}" title="${escHtml(inst.filepath)}">${escHtml(shortPath(inst.filepath, 50))}</td>`;
    html += `<td><span class="type-badge" title="exact-body cluster ${lbl}${copies > 1 ? ` (${copies} copies)` : ''}">${lbl}${copies > 1 ? `·${copies}` : ''}</span></td>`;
    html += `</tr>`;
  }
  html += `</table></div>`;

  if (sorted.length >= 2) {
    html += `<div class="output-section"><button class="btn-secondary" id="compare-surprising-btn" style="margin:4px 0">Compare Side by Side</button></div>`;
  }
  html += `<div class="output-section"><button class="btn-secondary" id="show-funcstring-btn">Show funcstring (structural form)</button>`;
  html += `<pre id="funcstring-view" style="display:none;white-space:pre-wrap;font-size:11px;color:var(--text-dim);padding:6px;background:var(--bg-dark);border:1px solid var(--border);max-height:300px;overflow:auto;margin-top:4px"></pre></div>`;

  container.innerHTML = html;
  wireClickables(container, { sourceOnly: true });

  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const startLine = parseInt(el.dataset.start) || undefined;
      onFileClick(el.dataset.filepath, startLine);
    });
  }

  const cmpBtn = $('#compare-surprising-btn', container);
  if (cmpBtn) {
    cmpBtn.addEventListener('click', () => {
      const peerLabel = pp
        ? `${pp.a_display || pp.a} ↔ ${pp.b_display || pp.b}`
        : `${shortHash}…`;
      openCompareView({
        name: peerLabel,
        instances: sorted.map(inst => ({
          filepath: inst.filepath,
          name: inst.name,
          display_name: inst.display_name || inst.name,
          start: inst.start,
          lines: inst.lines,
        })),
      }, 'surprising');
    });
  }

  const fBtn = $('#show-funcstring-btn', container);
  const fView = $('#funcstring-view', container);
  if (fBtn && fView) {
    fBtn.addEventListener('click', async () => {
      fBtn.textContent = 'Loading…';
      try {
        const first = sorted[0];
        const spec = `${first.filepath}@${first.name}`;
        const data = await api.funcstring({ func: spec });
        fView.textContent = data.funcstring || '(empty)';
        fView.style.display = 'block';
        fBtn.textContent = 'Funcstring';
      } catch (err) {
        fView.textContent = `Error: ${err.message}`;
        fView.style.display = 'block';
        fBtn.textContent = 'Show funcstring';
      }
    });
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


function renderStringTable(container, strings, meta) {
  container.innerHTML = '';
  if (!strings || strings.length === 0) {
    container.innerHTML = '<div class="list-placeholder">No strings found (try a filter)</div>';
    return;
  }
  // Up-front truncation warning when we're only showing a slice of the real
  // matches. Without this, a filtered result of exactly `max` items looked
  // identical to one with no additional matches — the user couldn't tell
  // whether they were seeing everything or just the top of the heap.
  if (meta && meta.truncated) {
    const warn = h('div', {
      className: 'list-placeholder',
      style: 'background:var(--bg-input);color:var(--accent);padding:4px 8px;font-size:11px;border-left:3px solid var(--accent);margin-bottom:4px',
      text: `Showing ${meta.shown} of ${meta.total}+. Increase Max Results to see more.`,
    });
    container.appendChild(warn);
  }
  for (const s of strings) {
    // Truncate display of very long strings
    const preview = s.value.length > 80 ? s.value.slice(0, 80) + '...' : s.value;
    const locSummary = s.locations.slice(0, 2).map(l =>
      (l.func ? l.func : shortPath(l.filepath, 25)) + ':' + l.line
    ).join(', ');

    const item = h('div', { className: 'list-item', title: s.value.slice(0, 300) }, [
      h('span', { className: 'rank', text: `${s.rank}` }),
      h('span', { className: 'metric', text: `${s.count}x` }),
      h('span', { className: 'name', text: preview, style: 'font-size:11px;word-break:break-all' }),
      h('span', { className: 'metric muted', text: `${s.files}f` }),
    ]);
    item.addEventListener('click', () => renderStringDetail(s));
    container.appendChild(item);
  }
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
  // Wire class clicks (multisect/claim-search class rows — TODO #369)
  for (const el of $$('.clickable[data-classname]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      onClassClickSourceOnly(el.dataset.classname);
    });
  }
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
  $('#workspace').style.height = '210px';

  $('#workspace-toggle').addEventListener('click', (e) => {
    // Don't toggle if the popout button was clicked
    if (e.target.id === 'workspace-popout') return;
    document.body.classList.toggle('workspace-open');
    const isOpen = document.body.classList.contains('workspace-open');
    $('#workspace-expand-btn').textContent = isOpen ? '▾ Collapse' : '▴ Expand';
    // Set initial height if opening for first time
    const ws = $('#workspace');
    if (isOpen && !ws.style.height) ws.style.height = '210px';
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
  $('#ws-show-prompt').addEventListener('click', showExtractionPrompt);
  setupExtractionPromptOverlay({ stripAtFileHeader });

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
  const inPath = ($('#ws-in-path')?.value || '').trim();
  // Selectivity threshold (claim-search-llm only). Blank = server-side tier defaults.
  // User value in percent (0-100); we send as fraction. 100 = filter off.
  const selThresholdRaw = $('#ws-selectivity-threshold')?.value;
  const selectivityThreshold = (selThresholdRaw === '' || selThresholdRaw === undefined || selThresholdRaw === null)
    ? null
    : Math.max(0, Math.min(100, parseInt(selThresholdRaw, 10))) / 100;

  // Disable Run button during processing
  const runBtn = $('#ws-run');
  runBtn.disabled = true;
  runBtn.textContent = '⏳ Working…';
  const restoreBtn = () => { runBtn.disabled = false; runBtn.textContent = '▶ Run'; };

  try {
    if (mode === 'multisect-search') {
      showMiddleTopLoading('Running multisect search…');
      try {
        const data = await api.multisect({ terms: text, max: 30, min_terms: minTermsVal, in: inPath || undefined, match_renames: $('#ws-match-renames')?.checked || undefined });
        renderMultisectResults(data);
      } catch (err) { showMiddleTopError(err.message); }

    } else if (mode === 'claim-search') {
      // LLM-powered: extract TIGHT/BROAD terms, then multisect both
      showMiddleTopLoading(`Extracting claim terms via ${engine}… (this may take a moment)`);
      try {
        const data = await api.claimSearchLlm({
          claim: text, engine, vocabTight, noVocabulary, max: 30, minTerms: minTermsVal,
          selectivityThreshold, in: inPath || undefined,
        });
        renderClaimLlmResults(data);
      } catch (err) { showMiddleTopError(err.message); }

    } else if (mode === 'multisect-analyze') {
      // Search first, then send top function hit to LLM for analysis
      showMiddleTopLoading('Running multisect search…');
      try {
        const searchData = await api.multisect({ terms: text, max: 10, min_terms: minTermsVal, in: inPath || undefined, match_renames: $('#ws-match-renames')?.checked || undefined });
        renderMultisectResults(searchData);
        const topFunc = (searchData.function_matches || [])[0];
        if (topFunc) {
          showAnalysisPane(`<div class="loading">Analyzing ${escHtml(topFunc.function)} via ${escHtml(engine)}…</div>`, 'Analyzing…', true);
          const analysisData = await api.analyzeLlm({
            func: `${topFunc.filepath}@${topFunc.function}`,
            mode: 'multisect-analyze',
            terms: text,
            engine, mask, maskComments,
          });
          renderLlmAnalysis(analysisData, searchData.terms);
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
          selectivityThreshold, in: inPath || undefined,
        });
        renderClaimLlmResults(searchData);

        // Top function from TIGHT first, fall back to BROAD
        const topFunc = (searchData.tight && searchData.tight.function_matches && searchData.tight.function_matches[0])
          || (searchData.broad && searchData.broad.function_matches && searchData.broad.function_matches[0])
          || null;

        if (topFunc) {
          showAnalysisPane(`<div class="loading">Analyzing ${escHtml(topFunc.function)} against claim via ${escHtml(engine)}…</div>`, 'Analyzing…', true);
          const analysisData = await api.analyzeLlm({
            func: `${topFunc.filepath}@${topFunc.function}`,
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

  const sumHits = (v) => v ? (v.function_matches.length + v.class_matches.length
    + v.file_matches.length + v.folder_matches.length) : 0;
  const tightCount = sumHits(data.tight);
  const broadCount = sumHits(data.broad);
  title.textContent = `Claim Search — LLM (${tightCount + broadCount} hits across scopes)`;

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
    const tightLabel = document.createElement('span');
    tightLabel.style.cssText = 'font-weight:bold;font-size:11px;color:var(--accent);margin-right:6px';
    tightLabel.textContent = 'TIGHT:';
    termsDiv.appendChild(tightLabel);
    for (const t of (data.tight.terms || [])) {
      termsDiv.appendChild(h('span', { className: `term-chip${t.negated ? ' negated' : ''}`, text: t.display }));
    }

    // Store highlight terms from TIGHT for source views
    const posTerms = (data.tight.terms || []).filter(t => !t.negated).map(t => t.display);
    state.highlightTerms = { terms: posTerms, colors: HIGHLIGHT_COLORS };

    html += `<div class="output-section" style="margin-top:10px">`
      + `<h3 style="margin:0 0 4px 0;font-size:13px;color:var(--text-secondary)">${data.vocabTight ? 'TIGHT — claim + codebase vocabulary' : 'TIGHT — literal claim language'} (${tightCount})</h3>`
      + (data.tight.termsStr ? `<div style="display:flex;align-items:flex-start;gap:6px;margin:0 0 6px 0"><code style="flex:1;min-width:0;background:var(--bg-tertiary);padding:3px 6px;border-radius:3px;font-size:11px;white-space:pre-wrap;word-break:break-all;overflow-x:auto">${escHtml(data.tight.termsStr)}</code><button class="copy-multisect-btn" data-tier="tight" style="flex:0 0 auto;font-size:11px;padding:2px 6px;cursor:pointer" title="Copy multisect string">📋 Copy</button></div>` : '')
      + _renderScopeViews(data.tight, { showLegend: true })
      + `</div>`;
  }

  // --- BROAD tier ---
  if (data.broad) {
    const sep = document.createElement('span');
    sep.style.cssText = 'display:inline-block;width:12px';
    termsDiv.appendChild(sep);
    const broadLabel = document.createElement('span');
    broadLabel.style.cssText = 'font-weight:bold;font-size:11px;color:#6B8E23;margin-right:6px';
    broadLabel.textContent = 'BROAD:';
    termsDiv.appendChild(broadLabel);
    for (const t of (data.broad.terms || [])) {
      termsDiv.appendChild(h('span', {
        className: `term-chip${t.negated ? ' negated' : ''}`,
        text: t.display,
        style: 'border-color:#6B8E23',
      }));
    }

    html += `<div class="output-section" style="margin-top:10px">`
      + `<h3 style="margin:0 0 4px 0;font-size:13px;color:var(--text-secondary)">BROAD — implementation patterns (${broadCount})</h3>`
      + (data.broad.termsStr ? `<div style="display:flex;align-items:flex-start;gap:6px;margin:0 0 6px 0"><code style="flex:1;min-width:0;background:var(--bg-tertiary);padding:3px 6px;border-radius:3px;font-size:11px;white-space:pre-wrap;word-break:break-all;overflow-x:auto">${escHtml(data.broad.termsStr)}</code><button class="copy-multisect-btn" data-tier="broad" style="flex:0 0 auto;font-size:11px;padding:2px 6px;cursor:pointer" title="Copy multisect string">📋 Copy</button></div>` : '')
      + _renderScopeViews(data.broad, { showLegend: true })
      + `</div>`;
  }

  if (!data.tight && !data.broad) {
    html += '<div class="list-placeholder">No terms could be extracted from the claim text.</div>';
  }

  container.innerHTML = html;
  wireClickables(container, { sourceOnly: true });
  _wireMultisectToggles(container);

  container.querySelectorAll('.copy-multisect-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tier = btn.dataset.tier;
      const str = (tier === 'tight' ? data.tight?.termsStr : data.broad?.termsStr) || '';
      copyToClipboard(str).then(
        () => { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = orig; }, 1500); },
        () => { btn.textContent = 'Failed'; }
      );
    });
  });
}


// ========================================================================
// Multisect-analyze structured per-term verdicts (Issue #8)
// ========================================================================

// Browser port of parseMultisectAnalyzeVerdicts (src/commands/analyze.js).
// Kept deliberately in sync: the server returns the raw analysis text, so the
// GUI parses the structured per-term block client-side. Tolerant on purpose —
// local LLMs vary in format compliance.
function parseMultisectVerdicts(response) {
  const empty = { verdicts: [], prose: (response || '').trim() };
  if (!response || typeof response !== 'string') return empty;

  const lines = response.split(/\r?\n/);
  const verdicts = [];
  let lastVerdictLine = -1;

  // Match the verdict keyword in the segment before the first '|' only, so an
  // "absent" row whose evidence text mentions "present" is not misread.
  const normVerdict = (head) => {
    const t = head.toLowerCase();
    if (/name[\s-]*only/.test(t)) return 'name-only';
    if (/\bpresent\b/.test(t)) return 'present';
    if (/\babsent\b/.test(t)) return 'absent';
    if (/\biffy\b|\bpartial\b|\bambiguous\b/.test(t)) return 'iffy';
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Optional "(term text)" between the number and the delimiter; the group
    // is optional so old-format "TERM <n>:" output still parses.
    const m = raw.match(/^\s*(?:[-*]\s*)?(?:term\s*)?(\d+)\s*(?:\([^)]*\))?\s*[:.)\-]/i);
    if (!m) continue;
    // Verdict read from after the term-label prefix, before the first '|'.
    const verdict = normVerdict(raw.slice(m[0].length).split('|')[0]);
    if (!verdict) continue;

    const evMatch = raw.match(/evidence\s*[:\-]\s*([^|]+)/i);
    const confMatch = raw.match(/confidence\s*[:\-]\s*(high|medium|low|[A-Za-z]+)/i);
    verdicts.push({
      term: Number(m[1]),
      verdict,
      evidence: evMatch ? evMatch[1].trim() : '',
      confidence: confMatch ? confMatch[1].trim().toLowerCase() : '',
    });
    lastVerdictLine = i;
  }

  if (verdicts.length === 0) return empty;

  let prose = lines.slice(lastVerdictLine + 1).join('\n').trim();
  prose = prose.replace(/^\s*(?:part\s*2\s*[-—:]*\s*)?summary\s*[:.\-—]*\s*/i, '').trim();
  return { verdicts, prose };
}

const VERDICT_STYLE = {
  'present':   { label: 'PRESENT',   color: '#2e7d32', bg: 'rgba(46,125,50,0.14)' },
  'name-only': { label: 'NAME-ONLY', color: '#b8860b', bg: 'rgba(184,134,11,0.16)' },
  'iffy':      { label: 'IFFY',      color: '#c77800', bg: 'rgba(199,120,0,0.16)' },
  'absent':    { label: 'ABSENT',    color: '#888',    bg: 'rgba(150,150,150,0.12)' },
};

// Compact per-term grid. `terms` (optional) supplies display labels by 1-based
// index; absent that, rows fall back to "Term N".
function renderVerdictGrid(verdicts, terms) {
  const cell = 'padding:3px 8px;border-bottom:1px solid var(--border);font-size:11px';
  let rows = '';
  for (const v of verdicts) {
    const vs = VERDICT_STYLE[v.verdict] || VERDICT_STYLE['absent'];
    const t = terms && terms[v.term - 1];
    const termLabel = (t && t.display) ? t.display : `Term ${v.term}`;
    rows += `<tr>
      <td style="${cell};font-family:monospace">${escHtml(termLabel)}</td>
      <td style="${cell}"><span style="color:${vs.color};background:${vs.bg};font-weight:600;font-size:10px;padding:1px 6px;border-radius:3px">${vs.label}</span></td>
      <td style="${cell}">${escHtml(v.evidence) || '<span class="muted">—</span>'}</td>
      <td style="${cell}">${escHtml(v.confidence) || '<span class="muted">—</span>'}</td>
    </tr>`;
  }
  return `<table style="border-collapse:collapse;width:100%;margin-bottom:8px">
    <thead><tr style="text-align:left;color:var(--text-secondary);font-size:10px">
      <th style="padding:3px 8px">Term</th><th style="padding:3px 8px">Verdict</th>
      <th style="padding:3px 8px">Evidence</th><th style="padding:3px 8px">Confidence</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}


// ========================================================================
// Render LLM analysis result (right-bottom pane)
// ========================================================================
function renderLlmAnalysis(data, terms) {
  const disclaimer = data.engine === 'claude'
    ? 'AI analysis may contain errors. Verify claims against source code.'
    : 'AI analysis from local model — less accurate than cloud models. Verify against source.';

  const usageNote = data.usage
    ? `<span class="muted" style="margin-left:10px;font-size:11px">${data.usage.input_tokens || 0} in / ${data.usage.output_tokens || 0} out tokens</span>`
    : '';

  // Structured per-term grid is only meaningful for multisect-analyze, and
  // only when the LLM actually emitted a parseable verdict block.
  const parsed = data.mode === 'multisect-analyze' ? parseMultisectVerdicts(data.analysis) : null;
  const hasGrid = !!(parsed && parsed.verdicts.length > 0);

  function build(gridOn) {
    const preStyle = 'white-space:pre-wrap;font-size:12px;max-height:500px;overflow:auto';
    const body = (gridOn && hasGrid)
      ? renderVerdictGrid(parsed.verdicts, terms)
        + `<pre class="source-view" style="${preStyle}">${escHtml(parsed.prose)}</pre>`
      : `<pre class="source-view" style="${preStyle}">${escHtml(data.analysis)}</pre>`;
    // Grid is opt-in (default off): structured-output prompts can degrade
    // local-LLM quality, so the user chooses when to trust the parsed grid.
    const gridToggle = hasGrid
      ? `<label style="margin-left:10px;font-size:11px;cursor:pointer">
           <input type="checkbox" id="verdict-grid-toggle"${gridOn ? ' checked' : ''} style="vertical-align:middle"> Per-term grid</label>`
      : '';
    return `<div class="output-section">
      <h3 style="margin:0 0 4px 0">${escHtml(data.mode)} — ${escHtml(data.target)}</h3>
      <div class="muted" style="margin-bottom:8px;font-size:11px">
        Engine: ${escHtml(data.engine)} | ${data.lines} lines${usageNote}${gridToggle}
      </div>
      ${body}
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn-secondary copy-analysis-btn" style="font-size:11px">Copy Analysis</button>
        <button class="btn-secondary copy-prompt-btn" style="font-size:11px">Copy Prompt</button>
        <span class="muted" style="font-size:10px;font-style:italic">${escHtml(disclaimer)}</span>
      </div>
    </div>`;
  }

  function show(gridOn) {
    showAnalysisPane(build(gridOn), `Analysis: ${data.target}`, true);

    // Copy buttons always act on the full raw response / prompt, grid or not.
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
    const toggle = $('#right-bottom-body #verdict-grid-toggle');
    if (toggle) toggle.addEventListener('change', () => show(toggle.checked));
  }

  show(false);
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
// Init
// ========================================================================
// Fetch the server build number and surface it in the header next to the
// index info, so a stale-server restart is visible at a glance. The badge
// element is injected from JS (not index.html) to keep this change confined
// to app.js. Silently does nothing if the server is too old to serve
// /api/version, or is unreachable.
async function showBuildInfo() {
  try {
    const data = await api.version();
    if (!data || typeof data.build === 'undefined') return;
    const right = $('.menubar-right');
    if (!right) return;
    let el = $('#build-info');
    if (!el) {
      el = document.createElement('span');
      el.id = 'build-info';
      el.className = 'index-info';
      el.style.marginRight = '10px';
      el.style.opacity = '0.7';
      right.insertBefore(el, $('#index-info'));
    }
    el.textContent = `build ${data.build}`;
    el.title = 'CodeExam server build (restart canary) — served by /api/version';
  } catch { /* old/unreachable server: leave the header as-is */ }
}

async function init() {
  initMenuBar();
  initAccordion();
  initWorkspace();
  initSplitHandles();
  initColumnResizers();
  initDiagramControls();
  initCompareOverlay();
  initDialogs({ clearAllPanes, showPane, refreshLlmStatus });
  initMiddlePane({ wireClickables });
  initClickHandlers({ wireClickables, loadSectionData, loadClassMethods });
  initContextMenu({ showAnalysisPane, renderLlmAnalysis, stripAtFileHeader });
  initSourceViewer({ showContextMenu, onFunctionClickSourceOnly });
  initPromptsAndCatalog({ wireClickables, getMaxResults });
  initFilter();

  // View options
  $('#opt-wrap-lines')?.addEventListener('change', (e) => {
    document.querySelectorAll('.source-view').forEach(el => {
      el.classList.toggle('wrap-lines', e.target.checked);
    });
  });
  $('#opt-show-inferred-suffix')?.addEventListener('change', (e) => {
    // Explicit add/remove (instead of two-arg toggle) so the behavior is
    // unambiguous and easy to inspect via devtools when debugging.
    if (e.target.checked) {
      document.body.classList.remove('hide-inferred-suffix');
    } else {
      document.body.classList.add('hide-inferred-suffix');
    }
  });
  $('#opt-break-long-lines')?.addEventListener('change', () => {
    // Re-render the source pane so line-breaking takes effect. Full re-render
    // (not CSS toggle) because we're splitting lines into additional DOM
    // nodes with their own line-number display.
    const last = state.lastSourceRender;
    if (!last) return;
    if (last.kind === 'function') renderSource(last.data);
    else if (last.kind === 'file') renderFileSource(last.data, last.targetLine);
  });
  initConsole({ showPane, onFileClick });
  initWindowManagementWithDeps({ consoleAppend, fsConsoleAppend, executeConsoleCommand, openDiagramFullscreen });
  refreshLlmStatus();
  showBuildInfo();

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
