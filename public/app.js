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
  initContextMenu, refreshLlmStatus, setEngineValue,
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
import {
  initListRenderers,
  renderFuncLikeList, renderFunctionList, renderFileListWithSub,
  renderExtensionList, renderClassListWithSub, renderModelList, renderArtifactList, renderKernelList, renderDatasetList, renderTrainingList, renderInferenceList, renderLlmCallsList, renderToolsList, renderChainsList, renderEmbeddingsList, renderStructuredOutputList, renderModelsUsedList, renderModelsUsedSites, renderPipelinesList, renderPipelineMembers, renderPipelineStages, pipelineMermaid, renderDrilldownList, renderDrilldownSites, KERNEL_KIND_COLOR, MULTIMODAL_KIND_COLOR, POSTTRAINING_KIND_COLOR, REASONING_KIND_COLOR, DATASET_KIND_COLOR, TRAINING_KIND_COLOR, INFER_KIND_COLOR, LLMCALL_KIND_COLOR, CHAIN_KIND_COLOR, SO_KIND_COLOR, EXPLAINABILITY_KIND_COLOR,
  renderHotFolderList, renderMostCalledList, renderCallInventory,
  renderClassHotspotList, renderClassHierarchy, renderVocabList, renderDataStructuresList, renderClientServerList, renderReferencedResourcesList,
  loadOverviewInto, showOverviewOverlay, initOverviewOverlay,
  renderIndexesList, renderFileMapList, renderCallInventoryList,
  renderExtensionsList, renderDupeGroupList,
  renderSurprisingFuncstringsList, renderStringTable,
  loadFileFunctions, loadClassMethods,
  updateAiOverviewWarning,
} from './list-renderers.js';

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
        renderExtensionList(content, data.extensions, data.total_files, filter, data.skipped);
        badge.textContent = data.extensions.length;
        break;

      case 'classes':
        data = await api.listClasses({ filter, max: 200 });
        state.sectionData[sectionId] = data.classes;
        renderClassListWithSub(content, data.classes, data.total);
        badge.textContent = data.total;
        break;

      case 'data-structures':
        data = await api.dataStructures({ filter, max: 500 });
        state.sectionData[sectionId] = data.structs;
        renderDataStructuresList(content, data.structs, data.total);
        badge.textContent = data.total;
        break;

      case 'client-server':
        data = await api.clientServer({ filter, max: 500 });
        state.sectionData[sectionId] = data;
        renderClientServerList(content, data);
        // Badge: HTTP server/client counts, a socket count when present (so a
        // socket-only index like .demo doesn't read as empty), and ⚠ for
        // unmatched client calls.
        {
          const st = data.stats;
          let b = `${st.serverCount}/${st.clientCount}`;
          if (st.socketCount) b += ` +${st.socketCount}🔌`;
          if (st.unmatchedCount) b += ` ⚠${st.unmatchedCount}`;
          badge.textContent = b;
        }
        break;

      case 'referenced-resources': {   // #203: the codebase's external surface
        data = await api.referencedResources({ filter });
        state.sectionData[sectionId] = data;
        renderReferencedResourcesList(content, data);
        const s = data.stats;
        badge.textContent = s.network + s.env + s.filesystem + s.subprocess + s.cloud + s.models;
        break;
      }

      case 'exports': {   // #153: declared-exports catalog, grouped by package
        data = await api.listExports({ filter, max: 1000 });
        state.sectionData[sectionId] = data.exports;
        renderDrilldownList(content, data.exports, {
          columns: [
            { get: p => p.package || '(root)', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis;min-width:0' },
            // Tier mix per package: A declared / B promoted / C heuristic floor.
            { get: p => [p.a && `A:${p.a}`, p.b && `B:${p.b}`, p.c && `C:${p.c}`].filter(Boolean).join(' '),
              style: 'flex-shrink:0;max-width:150px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted)' },
            // A small marker when the package carries a caveat note (lazy
            // registry / implicit package / computed __all__).
            { get: p => (p.notes && p.notes.length ? '⚠' : ''), style: 'flex:0 0 14px;font-size:10px;color:var(--text-muted)' },
          ],
          countOf: p => p.count,
          onItemClick: onExportsPackageClick,
          title: p => `${p.package || '(root)'}\n${p.count} export${p.count === 1 ? '' : 's'}  (A:${p.a} B:${p.b} C:${p.c})${p.notes && p.notes.length ? '\n' + p.notes.join('\n') : ''}`,
          footer: data.total > data.exports.length ? `${data.exports.length} of ${data.total} packages shown` : '',
        });
        badge.textContent = data.total;
        break;
      }

      case 'imports': {   // #162 (2a): the consumes ledger — imports grouped by library
        data = await api.listImports({ filter, max: 1000 });
        state.sectionData[sectionId] = data.imports;
        renderDrilldownList(content, data.imports, {
          columns: [
            { get: g => g.library || '(?)', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis;min-width:0' },
            { get: g => `${g.targets} target${g.targets === 1 ? '' : 's'}`, style: 'flex-shrink:0;max-width:110px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted)' },
          ],
          countOf: g => g.count,
          onItemClick: onImportsLibClick,
          title: g => `${g.library}\n${g.count} import site${g.count === 1 ? '' : 's'}, ${g.targets} distinct target${g.targets === 1 ? '' : 's'}`,
          footer: data.total > data.imports.length ? `${data.imports.length} of ${data.total} libraries shown` : '',
        });
        badge.textContent = data.total;
        break;
      }

      case 'infrastructure': {   // #168: non-AI/ML operational stack by file shape
        data = await api.get('infrastructure', { filter, max: 1000 });
        state.sectionData[sectionId] = data.infrastructure;
        renderDrilldownList(content, data.infrastructure, {
          columns: [
            { get: g => g.cell || '(?)', className: 'name clickable', style: 'flex:0 0 auto;min-width:96px;color:var(--text-bright);font-size:11px' },
            { get: g => g.kinds || '', style: 'flex:1 1 0;min-width:0;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: g => g.count,
          onItemClick: onInfraCellClick,
          title: g => `${g.cell}\n${g.count} artifact${g.count === 1 ? '' : 's'} — ${g.kinds}`,
          footer: data.instances != null ? `${data.instances} artifact(s) in ${data.total} cell(s); ${data.filesScanned} files scanned` : '',
        });
        badge.textContent = data.total;
        break;
      }

      case 'models':   // #134: deduped by name (framework, name)
        data = await api.listModels({ filter, max: 500 });
        state.sectionData[sectionId] = data.models;
        renderDrilldownList(content, data.models, {
          columns: [
            { get: m => (m.ambiguous ? '~' : '') + (m.framework || '?'), style: 'min-width:96px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: m => m.name || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
            { get: m => m.base ? '◂ ' + m.base : '', style: 'flex-shrink:0;max-width:200px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;margin-right:8px' },
          ],
          countOf: m => m.count,
          onItemClick: m => drilldownGroupClick(m, `Model: ${m.name}`, { columns: FILEPATH_SITE_COLS }),
          title: m => `${m.framework} · ${m.name}${m.base ? ' ◂ ' + m.base : ''}\n${m.method_count} method${m.method_count === 1 ? '' : 's'}`,
          footer: data.total > data.models.length ? `${data.models.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'artifacts':   // #134: deduped by basename (family, format, basename)
        data = await api.listArtifacts({ filter, max: 500 });
        state.sectionData[sectionId] = data.artifacts;
        renderDrilldownList(content, data.artifacts, {
          columns: [
            { get: a => (a.tag === 'heuristic' ? '~' : '') + (a.family || '?'), style: 'min-width:110px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: a => a.format || '', style: 'min-width:60px;color:var(--text-muted);font-size:10px' },
            { get: a => a.name || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: a => a.count,
          onItemClick: a => drilldownGroupClick(a, `Artifact: ${a.name}`, BY_SNIPPET),
          title: a => `${a.family} · ${a.format} · ${a.name}\n${a.count} site${a.count > 1 ? 's' : ''}`,
          footer: data.total > data.artifacts.length ? `${data.artifacts.length} of ${data.total} shown` : '',
          caveat: (data.artifacts || []).some(a => a.family === 'quantization')
            ? 'Caveat: quantization is a presence signal ("this code uses quantization"), not a precise site count — the bare GPTQ/AWQ markers also match doc/comment mentions.'
            : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'kernels':
        data = await api.listKernels({ filter, max: 500 });
        state.sectionData[sectionId] = data.kernels;   // #134: deduped by name (family,kind,marker,name)
        renderDrilldownList(content, data.kernels, {
          columns: [
            { get: k => (k.tag === 'heuristic' ? '~' : '') + (k.family || '?'), style: 'min-width:84px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: k => k.kind || '', style: k => `min-width:70px;font-size:10px;color:${KERNEL_KIND_COLOR[k.kind] || 'var(--text-muted)'}` },
            { get: k => k.marker || '', style: 'min-width:84px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
            { get: k => k.name || '(unnamed)', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: k => k.count,
          onItemClick: onKernelGroupClick,
          title: k => `${k.family} · ${k.kind} · ${k.marker} · ${k.name || '(unnamed)'}\n${k.count} occurrence${k.count > 1 ? 's' : ''}`,
          footer: data.total > data.kernels.length ? `${data.kernels.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;  // instances (pre-dedup), so >1-of-some is visible
        break;

      case 'multimodal':   // #140: vision / VLM / generative-vision, deduped by (family,kind,marker,name)
        data = await api.listMultimodal({ filter, max: 500 });
        state.sectionData[sectionId] = data.multimodal;
        renderDrilldownList(content, data.multimodal, {
          columns: [
            { get: t => '~' + (t.family || '?'), style: 'min-width:84px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: t => `min-width:84px;font-size:10px;color:${MULTIMODAL_KIND_COLOR[t.kind] || 'var(--text-muted)'}` },
            { get: t => t.marker || '', style: 'min-width:84px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.name || '(unnamed)', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          onItemClick: onMultimodalGroupClick,
          title: t => `${t.family} · ${t.kind} · ${t.marker} · ${t.name || '(unnamed)'}\n${t.count} occurrence${t.count > 1 ? 's' : ''}`,
          footer: data.total > data.multimodal.length ? `${data.multimodal.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'post-training': {   // #140: fine-tuning / alignment, deduped by (family,kind,marker,name)
        data = await api.listPostTraining({ filter, max: 500 });
        const ptItems = data['post-training'];
        state.sectionData[sectionId] = ptItems;
        renderDrilldownList(content, ptItems, {
          columns: [
            { get: t => '~' + (t.family || '?'), style: 'min-width:84px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: t => `min-width:84px;font-size:10px;color:${POSTTRAINING_KIND_COLOR[t.kind] || 'var(--text-muted)'}` },
            { get: t => t.marker || '', style: 'min-width:84px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.name || '(unnamed)', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          onItemClick: onPostTrainingGroupClick,
          title: t => `${t.family} · ${t.kind} · ${t.marker} · ${t.name || '(unnamed)'}\n${t.count} occurrence${t.count > 1 ? 's' : ''}`,
          footer: data.total > ptItems.length ? `${ptItems.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;
      }

      case 'reasoning': {   // #146: reasoning-prompt language (cot/reflection/scratchpad), deduped by (family,kind,marker,name)
        data = await api.listReasoning({ filter, max: 500 });
        const rsItems = data['reasoning'];
        state.sectionData[sectionId] = rsItems;
        renderDrilldownList(content, rsItems, {
          columns: [
            // family / kind / phrase. The `marker` column is dropped — for this
            // cell it's identical to `name` (both = the matched token). Widths are
            // CAPPED (flex:0 0, not min-width) so long, variable-length labels like
            // "chain-of-thought" truncate and rows stay aligned (#146).
            { get: t => '~' + (t.family || '?'), style: 'flex:0 0 112px;max-width:112px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: t => `flex:0 0 80px;max-width:80px;font-size:10px;overflow:hidden;text-overflow:ellipsis;color:${REASONING_KIND_COLOR[t.kind] || 'var(--text-muted)'}` },
            { get: t => t.name || '(unnamed)', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          // Shared drilldown with snippet sub-grouping (BY_SNIPPET) so identical
          // lines (e.g. 5× "Explain step by step." in one README) collapse and the
          // DISTINCT hits stay visible — was a flat list before (#146).
          onItemClick: t => drilldownGroupClick(t, `Reasoning: ${t.name || t.marker}`, BY_SNIPPET),
          title: t => `${t.family} · ${t.kind} · ${t.marker} · ${t.name || '(unnamed)'}\n${t.count} occurrence${t.count > 1 ? 's' : ''}`,
          footer: data.total > rsItems.length ? `${rsItems.length} of ${data.total} shown` : '',
          caveat: 'Caveat: reasoning is inferred from prompt LANGUAGE ("think step by step", "reflect on…"), not code constructs — heuristic, and it does NOT detect structural reasoning like Tree-of-Thoughts.',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;
      }

      case 'explainability': {   // #155: SHAP/LIME/Captum/PCA/t-SNE/UMAP, import-gated, deduped by (family,kind,tier,marker)
        data = await api.listExplainability({ filter, max: 500 });
        const exItems = data['explainability'];
        state.sectionData[sectionId] = exItems;
        renderDrilldownList(content, exItems, {
          columns: [
            { get: t => '~' + (t.family || '?'), style: 'flex:0 0 132px;max-width:132px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: t => `flex:0 0 96px;max-width:96px;font-size:10px;overflow:hidden;text-overflow:ellipsis;color:${EXPLAINABILITY_KIND_COLOR[t.kind] || 'var(--text-muted)'}` },
            // Tier (anchor-import / concept-call) — the import-gating is the cell's
            // defining trait, so it earns a column.
            { get: t => t.tier || '', style: 'flex:0 0 96px;max-width:96px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.name || '(unnamed)', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          onItemClick: t => drilldownGroupClick(t, `Explainability: ${t.name || t.marker}`, BY_SNIPPET),
          title: t => `${t.family} · ${t.kind} · ${t.tier} · ${t.name || '(unnamed)'}\n${t.count} occurrence${t.count > 1 ? 's' : ''}`,
          footer: data.total > exItems.length ? `${exItems.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;
      }

      case 'datasets':   // #134: deduped by name (family, kind, name)
        data = await api.listDatasets({ filter, max: 500 });
        state.sectionData[sectionId] = data.datasets;
        renderDrilldownList(content, data.datasets, {
          columns: [
            { get: d => d.family || '?', style: 'min-width:96px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: d => d.kind || '', style: d => `min-width:80px;font-size:10px;color:${DATASET_KIND_COLOR[d.kind] || 'var(--text-muted)'}` },
            { get: d => d.name || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: d => d.count,
          onItemClick: d => drilldownGroupClick(d, `Dataset: ${d.name}`, BY_SNIPPET),
          title: d => `${d.family} · ${d.kind} · ${d.name}\n${d.count} site${d.count > 1 ? 's' : ''}`,
          footer: data.total > data.datasets.length ? `${data.datasets.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'training':   // #134: deduped (family, kind, marker, name)
        data = await api.listTraining({ filter, max: 500 });
        state.sectionData[sectionId] = data.training;
        renderDrilldownList(content, data.training, {
          columns: [
            { get: t => (t.tier === 'B' ? '~' : '') + (t.family || '?'), style: 'min-width:96px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: t => `min-width:116px;font-size:10px;color:${TRAINING_KIND_COLOR[t.kind] || 'var(--text-muted)'}` },
            { get: t => t.marker || '', style: 'min-width:90px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.name || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          onItemClick: t => drilldownGroupClick(t, `Training: ${t.name || t.marker}`, BY_SNIPPET),
          title: t => `${t.family} · ${t.kind} · ${t.marker} · ${t.name}\n${t.count} site${t.count > 1 ? 's' : ''}`,
          footer: data.total > data.training.length ? `${data.training.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'inference':   // #134: deduped (family, kind, marker, name)
        data = await api.listInference({ filter, max: 500 });
        state.sectionData[sectionId] = data.inference;
        renderDrilldownList(content, data.inference, {
          columns: [
            { get: t => (t.tag === 'heuristic' ? '~' : '') + (t.family || '?'), style: 'min-width:96px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: t => `min-width:84px;font-size:10px;color:${INFER_KIND_COLOR[t.kind] || 'var(--text-muted)'}` },
            { get: t => t.marker || '', style: 'min-width:90px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
            { get: t => (t.name || '') + (t.id ? ' → ' + t.id : ''), className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          onItemClick: t => drilldownGroupClick(t, `Inference: ${t.name || t.marker}`, BY_SNIPPET),
          title: t => `${t.family} · ${t.kind} · ${t.marker} · ${t.name}${t.id ? ' → ' + t.id : ''}\n${t.count} site${t.count > 1 ? 's' : ''}`,
          footer: data.total > data.inference.length ? `${data.inference.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'llm-calls':   // #134: deduped (provider, kind, marker, model)
        data = await api.listLlmCalls({ filter, max: 500 });
        state.sectionData[sectionId] = data.calls;
        renderDrilldownList(content, data.calls, {
          columns: [
            { get: t => (t.tag === 'heuristic' ? '~' : '') + (t.provider || '?'), style: 'min-width:90px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: t => `min-width:60px;font-size:10px;color:${LLMCALL_KIND_COLOR[t.kind] || 'var(--text-muted)'}` },
            { get: t => (t.marker || '') + (t.lvc ? ' [lib?]' : ''), className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.model ? '→ ' + t.model : '', style: 'flex-shrink:0;max-width:200px;color:var(--success,#7c7);font-size:10px;overflow:hidden;text-overflow:ellipsis;margin-right:8px' },
          ],
          countOf: t => t.count,
          onItemClick: t => drilldownGroupClick(t, `LLM call: ${t.marker}${t.model ? ' → ' + t.model : ''}`, BY_SNIPPET),
          title: t => `${t.provider} · ${t.kind} · ${t.marker}${t.model ? ' → ' + t.model : ''}\n${t.count} site${t.count > 1 ? 's' : ''}`,
          footer: data.total > data.calls.length ? `${data.calls.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'tools':   // #134: deduped by name (framework, kind, name)
        data = await api.listTools({ filter, max: 500 });
        state.sectionData[sectionId] = data.tools;
        renderDrilldownList(content, data.tools, {
          columns: [
            { get: t => (t.tag === 'heuristic' ? '~' : '') + (t.framework || '?'), style: 'min-width:110px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: 'min-width:96px;color:var(--text-muted);font-size:10px' },
            { get: t => t.name || '(unnamed)', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          onItemClick: t => drilldownGroupClick(t, `Tool: ${t.name || '(unnamed)'}`, BY_SNIPPET),
          title: t => `${t.framework} · ${t.kind} · ${t.name || '(unnamed)'}\n${t.count} site${t.count > 1 ? 's' : ''}`,
          footer: data.total > data.tools.length ? `${data.tools.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'chains':   // #134: deduped (framework, kind, marker, name)
        data = await api.listChains({ filter, max: 500 });
        state.sectionData[sectionId] = data.chains;
        renderDrilldownList(content, data.chains, {
          columns: [
            { get: t => (t.tag === 'heuristic' ? '~' : '') + (t.framework || '?'), style: 'min-width:104px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: t => `min-width:56px;font-size:10px;color:${CHAIN_KIND_COLOR[t.kind] || 'var(--text-muted)'}` },
            { get: t => t.marker || '', style: 'min-width:120px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.name || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          onItemClick: t => drilldownGroupClick(t, `Chain/Agent: ${t.name || t.marker}`, BY_SNIPPET),
          title: t => `${t.framework} · ${t.kind} · ${t.marker} · ${t.name}\n${t.count} site${t.count > 1 ? 's' : ''}`,
          footer: data.total > data.chains.length ? `${data.chains.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;

      case 'embeddings':   // #134: deduped (framework, kind, marker)
        data = await api.listEmbeddings({ filter, max: 500 });
        state.sectionData[sectionId] = data.embeddings;
        renderDrilldownList(content, data.embeddings, {
          columns: [
            { get: t => (t.tag === 'heuristic' ? '~' : '') + (t.framework || '?'), style: 'min-width:104px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.kind || '', style: 'min-width:84px;font-size:10px;color:var(--text-muted)' },
            { get: t => t.marker || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.id ? '→ ' + t.id : '', style: 'flex-shrink:0;max-width:200px;color:var(--success,#7c7);font-size:10px;overflow:hidden;text-overflow:ellipsis;margin-right:8px' },
          ],
          countOf: t => t.count,
          onItemClick: t => drilldownGroupClick(t, `Embeddings: ${t.marker}`, BY_SNIPPET),
          title: t => `${t.framework} · ${t.kind} · ${t.marker}${t.id ? ' → ' + t.id : ''}\n${t.count} site${t.count > 1 ? 's' : ''}`,
          footer: data.total > data.embeddings.length ? `${data.embeddings.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;
      case 'structured-output':   // #134: deduped (framework, kind, marker, name=id||marker)
        data = await api.listStructuredOutput({ filter, max: 500 });
        state.sectionData[sectionId] = data.items;
        renderDrilldownList(content, data.items, {
          columns: [
            { get: t => (t.tag === 'heuristic' ? '~' : '') + (t.kind || '?'), style: t => `min-width:96px;font-size:10px;color:${SO_KIND_COLOR[t.kind] || 'var(--accent,#6cf)'}` },
            { get: t => t.framework || '', style: 'min-width:90px;font-size:10px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.marker || '', style: 'min-width:120px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
            { get: t => t.name || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
          ],
          countOf: t => t.count,
          onItemClick: t => drilldownGroupClick(t, `Schema: ${t.name || t.marker}`, BY_SNIPPET),
          title: t => `${t.framework} · ${t.kind} · ${t.marker} · ${t.name}\n${t.count} site${t.count > 1 ? 's' : ''}`,
          footer: data.total > data.items.length ? `${data.items.length} of ${data.total} shown` : '',
        });
        badge.textContent = data.instances != null ? data.instances : data.total;
        break;
      case 'models-used':
        data = await api.listModelsUsed({ filter, max: 500 });
        state.sectionData[sectionId] = data.models;
        renderModelsUsedList(content, data.models, data.total, data.unresolved, onModelUsedClick);
        badge.textContent = data.total;
        break;
      case 'pipelines':
        data = await api.listPipelines({ filter, max: 500 });
        state.sectionData[sectionId] = data.groups;
        renderPipelinesList(content, data.groups, data.total, onPipelineGroupClick);
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

      case 'overview':
        // Shared loader: fast half immediately, deep half auto-streamed (small
        // indexes) or behind a button (large), generation-guarded against index
        // switches. Returns its own promise; nothing else to do in this case.
        await loadOverviewInto(content, {
          onMeta: (ov) => { state.sectionData[sectionId] = ov; badge.textContent = ov.size?.files ?? ''; },
        });
        break;

      case 'vocabulary':
        data = await api.vocabulary({ n: 100, filter });
        state.sectionData[sectionId] = data.vocabulary;
        renderVocabList(content, data.vocabulary, data.concepts);
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

// #115: drill into a Models Used row — show its sites (file:line  function()  [cell])
// in the top-middle pane; each site clicks through to source in the lower pane.
function onModelUsedClick(model) {
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Model: ${model.model}`;
  renderModelsUsedSites($('#middle-top-body'), model);
}

// #134: drill into a Kernels group (grouped by name). A single occurrence jumps
// straight to source (no point in a one-row pane); multiple occurrences (the 3
// overloaded `Load`s, `act_quant_kernel` ×4) open the sites pane, where the snippet
// distinguishes same-named variants before clicking through to source.
function onKernelGroupClick(g) {
  if (g.count === 1 && g.sites && g.sites[0]) { onFileClick(g.sites[0].filepath, g.sites[0].line); return; }
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Kernel: ${g.name || '(unnamed)'}`;
  renderDrilldownSites($('#middle-top-body'), {
    header: `${g.family} · ${g.kind} · ${g.marker} · ${g.name || '(unnamed)'}  ·  ${g.count} occurrence${g.count > 1 ? 's' : ''}`,
    sites: g.sites,
    columns: SNIPPET_SITE_COLS,
  });
}

// #140: drill into a Multimodal/Vision group. Mirrors onKernelGroupClick — a
// single occurrence jumps straight to source; multiple occurrences open the
// sites pane where the snippet distinguishes same-marker variants.
// #153: drill into an Exports package — list its exported symbols, each
// clickable to the resolved definition. Always opens the pane (unlike the
// AI/ML ×1 fast-path) since a package's value is seeing its whole surface.
function onExportsPackageClick(p) {
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Exports: ${p.package}`;
  const noteLine = p.notes && p.notes.length ? `  ·  ${p.notes[0]}` : '';
  // #166: rows carry `usedBy` only when the server was started with
  // --exports-catalog. Switch to the wider column set and flag the de-facto-API
  // meaning in the header; otherwise the view is byte-identical to before.
  const hasUsedBy = (p.sites || []).some(s => s.usedBy !== undefined);
  const usedByNote = hasUsedBy
    ? '  ·  ← used by = de facto API: corpus codebases importing each export (named imports only — qualified attribute access not yet counted, #162b)'
    : '';
  renderDrilldownSites($('#middle-top-body'), {
    header: `${p.package}  ·  ${p.count} export${p.count === 1 ? '' : 's'}  (A:${p.a} B:${p.b} C:${p.c})${usedByNote}${noteLine}`,
    sites: p.sites,
    columns: hasUsedBy ? EXPORT_SITE_COLS_USEDBY : EXPORT_SITE_COLS,
    // Top-align so a used-by list that wraps to a 2nd line doesn't vertically
    // centre the name / def-site against it.
    align: hasUsedBy ? 'flex-start' : undefined,
  });
}

// #162 (2a): drill into an imported library — its import sites (target +
// file:line), each clicking through to the import statement.
function onImportsLibClick(g) {
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Imports: ${g.library}`;
  renderDrilldownSites($('#middle-top-body'), {
    header: `${g.library}  ·  ${g.count} import site${g.count === 1 ? '' : 's'}, ${g.targets} distinct target${g.targets === 1 ? '' : 's'}`,
    sites: g.sites,
    columns: SNIPPET_SITE_COLS.length ? [
      { get: s => s.name || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis;min-width:0' },
      { get: s => `${shortPath(s.filepath || '')}:${s.line}`, className: 'filepath', style: 'flex-shrink:0;max-width:300px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left' },
    ] : FILEPATH_SITE_COLS,
  });
}

// #168: drill into an Infrastructure cell — its artifact files, each row's kind
// marker (heuristic prefixed ~), clicking through to the file. Muted kind glyph
// (not accent) so it doesn't imply a separate click target.
function onInfraCellClick(g) {
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Infrastructure: ${g.cell}`;
  renderDrilldownSites($('#middle-top-body'), {
    header: `${g.cell}  ·  ${g.count} artifact${g.count === 1 ? '' : 's'}  (${g.kinds})  ·  ~ = heuristic`,
    sites: g.sites,
    columns: [
      { get: s => (s.tag === 'heuristic' ? '~ ' : '') + (s.kind || '') + (s.marker ? ' · ' + s.marker : ''), className: 'metric', style: 'flex:0 0 auto;min-width:150px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);text-align:left' },
      { get: s => `${shortPath(s.filepath || '')}:${s.line}`, className: 'filepath', style: 'flex:1 1 0;min-width:0;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left' },
    ],
  });
}

function onMultimodalGroupClick(g) {
  if (g.count === 1 && g.sites && g.sites[0]) { onFileClick(g.sites[0].filepath, g.sites[0].line); return; }
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Multimodal: ${g.name || '(unnamed)'}`;
  renderDrilldownSites($('#middle-top-body'), {
    header: `${g.family} · ${g.kind} · ${g.marker} · ${g.name || '(unnamed)'}  ·  ${g.count} occurrence${g.count > 1 ? 's' : ''}`,
    sites: g.sites,
    columns: SNIPPET_SITE_COLS,
  });
}

// #140: drill into a Post-training/Fine-tuning group. Mirrors
// onMultimodalGroupClick — a single occurrence jumps straight to source;
// multiple occurrences open the sites pane where the snippet distinguishes
// same-marker variants.
function onPostTrainingGroupClick(g) {
  if (g.count === 1 && g.sites && g.sites[0]) { onFileClick(g.sites[0].filepath, g.sites[0].line); return; }
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Post-training: ${g.name || '(unnamed)'}`;
  renderDrilldownSites($('#middle-top-body'), {
    header: `${g.family} · ${g.kind} · ${g.marker} · ${g.name || '(unnamed)'}  ·  ${g.count} occurrence${g.count > 1 ? 's' : ''}`,
    sites: g.sites,
    columns: SNIPPET_SITE_COLS,
  });
}

// #134 batch-1: shared site-column sets + a generic group-click for the identity
// cells. ×1 jumps straight to source; ×N opens the sites pane. SNIPPET cols suit
// cells whose rows carry a code snippet (Artifacts/Datasets/Tools); FILEPATH cols
// suit Models (a class — no line/snippet, located by file).
const SNIPPET_SITE_COLS = [
  { get: s => (s.snippet || '').trim(), className: 'name clickable', style: 'flex:1;font-family:var(--font-mono);font-size:10px;color:var(--text-bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' },
  { get: s => `${shortPath(s.filepath || '')}:${s.line}`, className: 'filepath', style: 'flex-shrink:0;max-width:300px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left' },
];
const FILEPATH_SITE_COLS = [
  { get: s => shortPath(s.filepath || ''), className: 'filepath clickable', style: 'flex:1;font-family:var(--font-mono);font-size:10px;color:var(--text-bright);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;min-width:0' },
];
// #153 Exports: per-export rows inside a package. tier glyph(s) + name +
// dotted path (where the idiom carries one) + resolved def site. The row
// click jumps to defSite (#153 decision 5); 'unresolved' names (in __all__
// but no definition found — a latent bug) show as such.
const EXPORT_SITE_COLS = [
  { get: s => s.tiers || s.tier || '', style: 'flex:0 0 34px;font-family:var(--font-mono);font-size:10px;color:var(--accent,#6cf)' },
  { get: s => s.name || '', className: 'name clickable', style: 'flex:1;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis;min-width:0' },
  { get: s => s.dottedPath || '', style: 'flex-shrink:0;max-width:200px;font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' },
  { get: s => s.filepath ? `${shortPath(s.filepath)}:${s.line}` : 'unresolved', className: 'filepath', style: 'flex-shrink:0;max-width:240px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left' },
];
// #166 Exports "Used by": tier glyph + name + the corpus codebases that import
// each export (the de facto API) + def site. Drops the dotted-path column (vs
// EXPORT_SITE_COLS) to give the importer list room. The list is MUTED (className
// 'muted', not 'metric'), not accent-coloured — clicking through to an importer
// is cross-index drill-down (#164, not yet built), so it must not look
// clickable. The used-by cell WRAPS (white-space:normal) instead of clipping, so
// a long importer list flows onto a second line under the row rather than being
// ellipsis-truncated; margin-right keeps a clear gap before the def site. Rows
// top-align (align:'flex-start' below) so the wrap reads cleanly. Full list also
// stays in the cell tooltip.
const EXPORT_SITE_COLS_USEDBY = [
  EXPORT_SITE_COLS[0],
  { get: s => s.name || '', className: 'name clickable', style: 'flex:0 0 auto;max-width:200px;color:var(--text-bright);font-size:11px;overflow:hidden;text-overflow:ellipsis' },
  { get: s => s.usedBy ? `← used by ${s.usedBy}` : '', className: 'muted',
    title: s => s.usedBy ? `Used by (named imports): ${s.usedBy}` : '',
    style: 'flex:1 1 0;min-width:0;margin-right:10px;font-family:var(--font-mono);font-size:10px;white-space:normal;word-break:break-word;text-align:left' },
  { get: s => s.filepath ? `${shortPath(s.filepath)}:${s.line}` : 'unresolved', className: 'filepath', style: 'flex-shrink:0;max-width:200px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left' },
];
// siteOpts is forwarded to renderDrilldownSites: { columns } (flat) or
// { subgroupBy } (collapse repeated snippets — Tools/Artifacts/Datasets).
function drilldownGroupClick(g, label, siteOpts) {
  if (g.count === 1 && g.sites && g.sites[0]) { onFileClick(g.sites[0].filepath, g.sites[0].line); return; }
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = label;
  const shown = g.sites ? g.sites.length : 0;
  const capped = shown < g.count ? ` (showing first ${shown})` : '';
  renderDrilldownSites($('#middle-top-body'), {
    header: `${label}  ·  ${g.count} occurrence${g.count > 1 ? 's' : ''}${capped}`,
    sites: g.sites,
    ...siteOpts,
  });
}
const BY_SNIPPET = { subgroupBy: s => s.snippet };

// #142 drill-down dedupe: click a pipeline GROUP (one deduped signature). A ×1
// group jumps straight to its single pipeline's stages (no point in a one-row
// member pane); a ×N group opens the member-files pane, where each file clicks
// through to its own stages. Mirrors the ×1 fast-path the other AI/ML cells use.
function onPipelineGroupClick(g) {
  if (g.count === 1) { onPipelineClick(g.rep); return; }
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Pipeline: ${g.rep.shape} (${g.rep.scope}) ×${g.count}`;
  renderPipelineMembers($('#middle-top-body'), g, onPipelineClick);
}

// #116: drill into a single Pipeline — show its stages (cell · ids · sites) in the
// top-middle pane; each site clicks through to source in the lower pane.
function onPipelineClick(w) {
  showPane('middle-top');
  navPush('middle-top');
  $('#middle-top-title').textContent = `Pipeline: ${w.shape} (${w.scope})`;
  renderPipelineStages($('#middle-top-body'), w, onPipelineDiagram);
}

// Render a pipeline as a Mermaid LR flow in the Diagram pane (#right-top),
// reusing the file-map render path (so its pop-out + zoom work). A node click
// opens that stage's first site in source. Only reachable from the ≥3-stage
// "View as diagram" button in renderPipelineStages.
function onPipelineDiagram(w) {
  const ttl = $('#right-top-title');
  if (ttl) ttl.textContent = `Pipeline: ${w.shape} (${w.scope})`;
  $('#right-top-body').innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>';
  // No root node — pipelines are not rooted trees; passing a root name made
  // renderMermaid materialize a stray disconnected `pipeline_<shape>` node.
  renderMermaid(pipelineMermaid(w), $('#diagram-viewport'), null, {
    onNodeClick: (nodeId) => {
      const m = /^n(\d+)$/.exec(nodeId || '');
      const stage = m ? (w.stages || [])[+m[1]] : null;
      const site = stage && stage.sites && stage.sites[0];
      if (site) onFileClick(site.filepath, site.line);
    },
  });
  showPane('right-top');
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
        const data = await api.multisect({ terms: text, max: getMaxResults(), min_terms: minTermsVal, in: inPath || undefined, match_renames: $('#ws-match-renames')?.checked || undefined });
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
  // #246: key on local-vs-cloud, not `=== 'claude'` — the else-branch used to
  // mislabel every cloud engine except Claude (OpenAI, Gemini) as "local model".
  const disclaimer = data.engine === 'local'
    ? 'AI analysis from a local model — may be less accurate than cloud models. Verify against source.'
    : 'AI analysis may contain errors. Verify claims against source code.';

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
  const cp = $('#chat-panel'); if (cp) cp.style.display = 'none';
}


// ========================================================================
// Chat about code (#36 Phase 1) — cloud (Claude/ChatGPT) or local-backed, drives CE's MCP tools
// in-process via the server's /api/chat route (shares the loaded index).
// History is kept text-only so we don't have to replay tool_use/tool_result
// pairs; the model re-queries tools per turn as needed.
// ========================================================================
const chatMessages = [];   // {role:'user'|'assistant', content: string}
let chatBusy = false;
let chatIndex = null;      // index name the chat is bound to (label + switch detection)

function initChatTab() {
  // console.js's initRightBottomTabs treats any non-'analysis' tab as Console.
  // This handler is registered AFTER it (init order), so for the Chat tab it
  // runs last and corrects the display; for Analysis/Console it just hides chat.
  for (const tab of $$('#right-bottom .pane-tab')) {
    tab.addEventListener('click', () => {
      const chatPanel = $('#chat-panel');
      if (!chatPanel) return;
      if (tab.dataset.tab === 'chat') {
        $('#right-bottom-body').style.display = 'none';
        $('#console-panel').style.display = 'none';
        chatPanel.style.display = 'flex';
        $('#chat-input')?.focus();
      } else {
        chatPanel.style.display = 'none';
      }
      // Point the pane's Save (💾) / Find (🔍) buttons at the ACTIVE tab's
      // content — the markup hardcodes them to the Analysis body (#36).
      const target = {
        analysis: { id: 'right-bottom-body', name: 'analysis', md: true },
        console:  { id: 'console-output',    name: 'console',  md: false },
        chat:     { id: 'chat-messages',     name: 'chat',     md: true },
      }[tab.dataset.tab];
      if (target) {
        const saveBtn = $('#right-bottom [data-save]');
        const findBtn = $('#right-bottom [data-find]');
        if (saveBtn) {
          saveBtn.dataset.save = target.id;
          saveBtn.dataset.name = target.name;
          if (target.md) saveBtn.dataset.md = '1'; else delete saveBtn.dataset.md;
        }
        if (findBtn) findBtn.dataset.find = target.id;
      }
    });
  }
  $('#chat-send')?.addEventListener('click', sendChatMessage);
  $('#chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  $('#chat-clear')?.addEventListener('click', clearChat);
  // dialogs.js dispatches ce:index-loaded on every (re)load — re-label the chat
  // and mark the switch in the stream, WITHOUT clearing history (#36).
  window.addEventListener('ce:index-loaded', refreshChatIndexLabel);
  refreshChatIndexLabel();  // initial label
}

async function refreshChatIndexLabel() {
  let name = null;
  try {
    const data = await api.get('indexes');
    name = (data.indexes || []).find(i => i.active)?.name || null;
  } catch { /* leave the label as-is on error */ }
  const label = $('#chat-index');
  if (label) label.textContent = name || '(none)';
  // Mark a switch in the conversation stream (history preserved, not cleared).
  if (chatIndex && name && name !== chatIndex && chatMessages.length) {
    appendChatDivider(`— now chatting about ${name} —`);
  }
  chatIndex = name;
}

function appendChatDivider(text) {
  const wrap = $('#chat-messages');
  if (!wrap) return;
  const ph = wrap.querySelector('.list-placeholder');
  if (ph) ph.remove();
  wrap.appendChild(h('div', {
    className: 'chat-divider',
    style: 'text-align:center;opacity:0.55;font-size:0.8em;margin:10px 0;padding-top:6px;border-top:1px dashed rgba(255,255,255,0.2)',
    text,
  }));
  wrap.scrollTop = wrap.scrollHeight;
}

function clearChat() {
  chatMessages.length = 0;
  const wrap = $('#chat-messages');
  if (!wrap) return;
  wrap.innerHTML = '';
  wrap.appendChild(h('div', {
    className: 'list-placeholder',
    text: "Ask the AI about this codebase. It can search, analyze, and explore the loaded index with CodeExam's tools.",
  }));
}

function appendChatBubble(role, text, toolCalls) {
  const wrap = $('#chat-messages');
  if (!wrap) return null;
  const ph = wrap.querySelector('.list-placeholder');
  if (ph) ph.remove();
  const bubble = h('div', {
    className: `chat-msg chat-${role}`,
    style: 'margin:6px 0;padding:6px 9px;border-radius:6px;' +
      (role === 'user' ? 'background:rgba(120,160,255,0.12)' : 'background:rgba(255,255,255,0.04)'),
  });
  if (toolCalls && toolCalls.length) {
    if ($('#chat-show-tools')?.checked) {
      // Detailed MCP-call record: name({args}) per call — grounding evidence,
      // saved with the transcript (#36). args truncated so a huge payload
      // doesn't bloat the record.
      const box = h('div', { className: 'chat-tools', style: 'font-size:0.8em;opacity:0.7;margin-bottom:4px;font-family:monospace;white-space:pre-wrap;word-break:break-word' });
      for (const tc of toolCalls) {
        const a = JSON.stringify(tc.input || {});
        box.appendChild(h('div', { text: `🔧 ${tc.name}(${a.length > 200 ? a.slice(0, 200) + '…' : a})` }));
      }
      bubble.appendChild(box);
    } else {
      bubble.appendChild(h('div', {
        className: 'chat-tools',
        style: 'font-size:0.8em;opacity:0.6;margin-bottom:3px',
        text: `🔧 ${toolCalls.map(t => t.name).join(', ')}`,
      }));
    }
  }
  bubble.appendChild(h('div', { className: 'chat-text', style: 'white-space:pre-wrap;word-break:break-word', text }));
  wrap.appendChild(bubble);
  wrap.scrollTop = wrap.scrollHeight;
  return bubble;
}

async function sendChatMessage() {
  if (chatBusy) return;
  const input = $('#chat-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  input.value = '';
  appendChatBubble('user', text);
  chatMessages.push({ role: 'user', content: text });
  chatBusy = true;
  const pending = appendChatBubble('assistant', '…thinking…');
  try {
    if ($('#chat-stream')?.checked) {
      await runChatStream(pending);   // Tier-2 live progress (SSE); batch path below is the fallback
    } else {
      const resp = await api.post('chat', {
        messages: chatMessages,
        index: chatIndex || undefined,
        mode: $('#chat-mode')?.value || 'grounded',
        engine: $('#chat-engine')?.value || 'claude',
      }, { timeout: 600000 });
      const blocks = resp.content || [];
      const toolCalls = blocks.filter(b => b.type === 'tool_use').map(b => ({ name: b.name, input: b.input }));
      // Prefer the server's dedicated final-answer (the synthesized reply, not a
      // mash of interim narration). Fall back to concatenated text blocks for an
      // older server that doesn't send `answer` yet (#36 final-answer-robustness).
      const answer = (resp.answer && resp.answer.trim())
        || blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
        || '(no text response)';
      pending?.remove();
      appendChatBubble('assistant', answer, toolCalls);
      chatMessages.push({ role: 'assistant', content: answer });
    }
  } catch (e) {
    pending?.remove();
    appendChatBubble('assistant', `⚠ ${e.message}`);
  } finally {
    chatBusy = false;
    $('#chat-input')?.focus();
  }
}

// Tier-2 streaming send (#36): POST to /api/chat-stream and render tool-call
// activity LIVE (SSE) into one growing bubble, then the final answer — instead of
// a frozen "…thinking…". The events are CE's own shape (tool/done/error), so this
// is provider-agnostic. Self-contained error handling (renders into its own
// bubble, never throws) so sendChatMessage's batch try/catch is unaffected.
async function runChatStream(pending) {
  pending?.remove();
  const wrap = $('#chat-messages');
  const bubble = h('div', { className: 'chat-msg chat-assistant', style: 'margin:6px 0;padding:6px 9px;border-radius:6px;background:rgba(255,255,255,0.04)' });
  const toolsBox = h('div', { className: 'chat-tools', style: 'font-size:0.8em;opacity:0.7;margin-bottom:4px' });
  const textDiv = h('div', { className: 'chat-text', style: 'white-space:pre-wrap;word-break:break-word', text: '…working…' });
  bubble.appendChild(toolsBox);
  bubble.appendChild(textDiv);
  wrap.appendChild(bubble);
  wrap.scrollTop = wrap.scrollHeight;
  const showTools = $('#chat-show-tools')?.checked;
  try {
    const resp = await fetch('/api/chat-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: chatMessages,
        index: chatIndex || undefined,
        mode: $('#chat-mode')?.value || 'grounded',
        engine: $('#chat-engine')?.value || 'claude',
      }),
    });
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let answered = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message', dataStr = '';
        for (const ln of frame.split('\n')) {
          if (ln.startsWith('event:')) event = ln.slice(6).trim();
          else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
        }
        if (!dataStr) continue;
        let data;
        try { data = JSON.parse(dataStr); } catch { continue; }
        if (event === 'tool') {
          const a = JSON.stringify(data.input || {});
          toolsBox.appendChild(h('div', {
            text: showTools ? `🔧 ${data.name}(${a.length > 200 ? a.slice(0, 200) + '…' : a})` : `🔧 ${data.name}`,
            style: showTools ? 'font-family:monospace;white-space:pre-wrap;word-break:break-word' : '',
          }));
          wrap.scrollTop = wrap.scrollHeight;
        } else if (event === 'done') {
          const answer = (data.answer && data.answer.trim()) || '(no text response)';
          textDiv.textContent = answer;
          chatMessages.push({ role: 'assistant', content: answer });
          answered = true;
          wrap.scrollTop = wrap.scrollHeight;
        } else if (event === 'error') {
          textDiv.textContent = `⚠ ${data.error}`;
          answered = true;
        }
      }
    }
    if (!answered) textDiv.textContent = '(no text response)';
  } catch (e) {
    textDiv.textContent = `⚠ ${e.message}`;
  }
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
  initDialogs({ clearAllPanes, showPane, refreshLlmStatus, setEngineValue });
  initMiddlePane({ wireClickables });
  initListRenderers({ wireClickables, loadSectionData, updateOverflowHint });
  initClickHandlers({ wireClickables, loadSectionData });
  initContextMenu({ showAnalysisPane, renderLlmAnalysis, stripAtFileHeader });
  initSourceViewer({ showContextMenu, onFunctionClickSourceOnly });
  initPromptsAndCatalog({ wireClickables, getMaxResults });
  initFilter({ loadSectionData });

  // View options
  $('#opt-wrap-lines')?.addEventListener('change', (e) => {
    // Also toggle on the middle-top pane body (persistent container) so search
    // results — which render .search-line rows there — honor the wrap setting,
    // including results rendered after the toggle was flipped. #205.
    document.querySelectorAll('.source-view, #middle-top-body').forEach(el => {
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
  // #132: View → Exclude Tests (the GUI form of --no-tests). Renderers read
  // the checkbox at render time; toggling reloads the open accordions so the
  // hide takes effect without a close/re-open.
  $('#opt-exclude-tests')?.addEventListener('change', () => {
    const filter = $('#left-filter').value.trim();
    for (const sec of $$('.accordion-section.open')) {
      state.sectionData[sec.dataset.section] = null;
      loadSectionData(sec.dataset.section, filter);
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
  initChatTab();  // after initConsole so the chat tab handler is registered last (wins display)
  initWindowManagementWithDeps({ consoleAppend, fsConsoleAppend, executeConsoleCommand, openDiagramFullscreen });
  initOverviewOverlay();
  // #181: pop the Overview window whenever a new index finishes loading
  // (dialogs.js dispatches this after api.loadIndex succeeds).
  window.addEventListener('ce:index-loaded', () => showOverviewOverlay());
  refreshLlmStatus();
  // Re-fetch LLM status when either engine dropdown is opened, so labels and
  // detail badges reflect the current server-wide loaded model even if it was
  // switched from the other surface (chat and workspace share ONE model).
  $('#chat-engine')?.addEventListener('mousedown', () => refreshLlmStatus());
  $('#ws-engine')?.addEventListener('mousedown', () => refreshLlmStatus());
  // Keep any on-screen Overview-by-AI pre-run warning in sync when the
  // Workspace engine changes (#243 Part B — the warning went stale before).
  $('#ws-engine')?.addEventListener('change', () => updateAiOverviewWarning());
  // Chat-side browse: same model-browser dialog the workspace uses — one
  // loaded model serves both surfaces (unify-llm-engine-controls).
  $('#chat-browse-model')?.addEventListener('click', openModelBrowser);
  showBuildInfo();

  // Pane navigation buttons (back/forward for both middle panes)
  $('#source-back-btn')?.addEventListener('click', () => navBack('middle-bottom'));
  $('#source-fwd-btn')?.addEventListener('click', () => navForward('middle-bottom'));
  $('#output-back-btn')?.addEventListener('click', () => navBack('middle-top'));
  $('#output-fwd-btn')?.addEventListener('click', () => navForward('middle-top'));

  // Pipeline drill clicks (member rows + stage source rows) are DELEGATED on the
  // persistent middle-top body so they survive nav back/forward — which restore
  // innerHTML and drop per-element listeners (navRestore only re-wires source
  // clickables, not the pipeline member-drill). #142.
  $('#middle-top-body')?.addEventListener('click', (e) => {
    const mem = e.target.closest('[data-pl-member]');
    if (mem) {
      const body = $('#middle-top-body');
      const g = body._plGroup;
      const i = Number(mem.getAttribute('data-pl-member'));
      if (g && g.members && g.members[i]) (body._plMemberClick || onPipelineClick)(g.members[i]);
      return;
    }
    const src = e.target.closest('[data-pl-file]');
    if (src) onFileClick(src.getAttribute('data-pl-file'), Number(src.getAttribute('data-pl-line')));
  });

  for (const btn of $$('#context-menu button[data-ctx]')) btn.addEventListener('click', () => handleContextAction(btn.dataset.ctx));
  document.addEventListener('click', hideContextMenu);

  try {
    const data = await api.indexes();
    if (data.indexes && data.indexes.length > 0) {
      const active = data.indexes.find(i => i.active) || data.indexes[0];
      const _dispName = active.name && active.name.startsWith('FIRST_RUN_INDEX') ? 'Demo — mixed sample corpus (AI app + ML + TLS)' : active.name;
      $('#index-info').textContent = `${_dispName} (${active.files.toLocaleString()} files)`;
      // #181: GUI launched with a command-line index → pop the Overview window.
      showOverviewOverlay();
    }
  } catch { /* ignore */ }
}

document.addEventListener('DOMContentLoaded', init);
