/**
 * context-menu.js — Right-click context menu plus the LLM engine
 * helpers that drive its menu labels and pre-action availability
 * checks. `refreshLlmStatus` and the menu surface live together
 * because every LLM-related menu item (`Analyze with LLM`,
 * `Analyze with LLM + Context`, `Analyze File with LLM`) needs both
 * the engine label and the availability gate, and splitting them
 * across modules would require two-way DI.
 *
 * Cross-cutting callbacks (`showAnalysisPane`, `renderLlmAnalysis`,
 * `stripAtFileHeader`) are injected via `initContextMenu({...})`
 * since their owners still live in app.js. Middle-pane chrome +
 * renderers are direct imports from middle-pane.js.
 */

import { state } from './state.js';
import { api } from './api.js';
import { $, $$, escHtml, shortPath } from './dom-utils.js';
import { showPane } from './layout.js';
import { onFunctionClick } from './click-handlers.js';
import { renderMermaid, openRelationshipView } from './mermaid.js';
import {
  showMiddleTopLoading, showMiddleTopError,
  renderCallersOnly, renderCalleesOnly, renderDigest, renderSearchResults,
} from './middle-pane.js';

// ============================================================================
// Cross-cutting callbacks (injected by initContextMenu)
// ============================================================================

let _showAnalysisPane = () => {};
let _renderLlmAnalysis = () => {};
let _stripAtFileHeader = (s) => s;

export function initContextMenu(deps = {}) {
  if (typeof deps.showAnalysisPane === 'function') _showAnalysisPane = deps.showAnalysisPane;
  if (typeof deps.renderLlmAnalysis === 'function') _renderLlmAnalysis = deps.renderLlmAnalysis;
  if (typeof deps.stripAtFileHeader === 'function') _stripAtFileHeader = deps.stripAtFileHeader;
}


// ============================================================================
// LLM engine helpers
// ============================================================================

/** Fetch LLM engine status and cache it. Called on init and after model switch. */
export async function refreshLlmStatus() {
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
    _showAnalysisPane(
      '<b>Claude API is not configured.</b><br><br>' +
      'To enable it, do one of the following:<br>' +
      '&bull; Create a <code>claude.txt</code> file containing your API key in the server directory<br>' +
      '&bull; Set the <code>ANTHROPIC_API_KEY</code> environment variable<br>' +
      '&bull; Start the server with <code>--api-key &lt;key&gt;</code>',
      'Engine Not Available', true);
  } else {
    _showAnalysisPane(
      '<b>Local GGUF model is not configured.</b><br><br>' +
      'To enable it, do one of the following:<br>' +
      '&bull; Click <b>Browse GGUFs</b> in the workspace controls to select a model<br>' +
      '&bull; Start the server with <code>--model-path &lt;path-to-gguf&gt;</code>',
      'Engine Not Available', true);
  }
  return false;
}


// ============================================================================
// Context menu
// ============================================================================

export function showContextMenu(e, funcInfo) {
  e.preventDefault();
  state.contextTarget = funcInfo;
  const menu = $('#context-menu');
  menu.classList.remove('hidden');
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;

  // Show/hide items based on target type. A data-structure target (struct/enum/
  // union/typedef/…) is a *type*, not a callable: "Find callers/callees/extract/
  // call-tree/digest" don't apply — it gets "Find Uses" (references to the name)
  // instead. #194
  const isFileOnly = !funcInfo.name || funcInfo.name === funcInfo.filepath;
  const isDataStructure = funcInfo.kind === 'data-structure';
  // "Analyze File with LLM" — for file/function targets only. Hidden for a data
  // structure: it's a type, and the label ("File") would misdescribe the action. #194
  const fileAnalyzeBtn = $('#ctx-analyze-file');
  if (fileAnalyzeBtn) fileAnalyzeBtn.style.display = (funcInfo.filepath && !isDataStructure) ? '' : 'none';
  const findUsesBtn = $('button[data-ctx="find-uses"]');
  if (findUsesBtn) findUsesBtn.style.display = (isDataStructure && funcInfo.name) ? '' : 'none';
  const digestBtn = $('button[data-ctx="digest"]');
  if (digestBtn) digestBtn.style.display = isDataStructure ? 'none' : '';
  // Hide the LLM-group separator when the whole LLM group is hidden (struct).
  const hr = $('#context-menu hr');
  if (hr) hr.style.display = isDataStructure ? 'none' : '';
  // Function-only items: hidden for file-only AND for data-structure targets.
  for (const btn of $$('#context-menu button[data-ctx]')) {
    const ctx = btn.dataset.ctx;
    if (['extract', 'callers', 'callees', 'call-tree', 'analyze', 'analyze-context'].includes(ctx)) {
      btn.style.display = (isFileOnly || isDataStructure) ? 'none' : '';
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

export function hideContextMenu() { $('#context-menu').classList.add('hidden'); state.contextTarget = null; }

export async function handleContextAction(action) {
  const target = state.contextTarget;
  hideContextMenu();
  if (!target) return;

  // Some panes pass target.name (either bare or display), some pass only
  // target.display_name. Server does reverse-rename resolution, so either
  // form is acceptable — just pick whichever is non-empty.
  const funcName = target.name || target.display_name;
  const funcSpec = target.filepath ? `${target.filepath}@${funcName}` : funcName;

  switch (action) {
    case 'find-uses':
      showMiddleTopLoading(`Uses of ${target.name}…`);
      try { renderSearchResults(target.name, await api.search({ q: target.name })); }
      catch (err) { showMiddleTopError(err.message); }
      break;

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

    case 'digest':
      showMiddleTopLoading(`Digest of ${target.name || target.display_name}…`);
      try {
        // For file-only targets (no function/class name), send just the
        // filepath so the backend dispatcher routes to the file digest.
        // For function/class targets with both name and filepath, the
        // existing funcSpec (`filepath@name`) works for both — the
        // dispatcher checks the matched entry's type and routes accordingly.
        const digestSpec = target.name ? funcSpec : (target.filepath || target.display_name);
        const data = await api.digest({ name: digestSpec });
        renderDigest(data);
      } catch (err) { showMiddleTopError(err.message); }
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
      const withDigest = $('#ws-with-digest')?.checked || false;
      _showAnalysisPane(`<div class="loading">Analyzing ${escHtml(target.name)} via ${escHtml(engine)}${withDigest ? ' (with digest)' : ''}…</div>`, 'Analyzing…', true);
      try {
        const data = await api.analyzeLlm({
          func: funcSpec,
          mode: 'analyze',
          engine, mask, maskComments, withDigest,
        });
        _renderLlmAnalysis(data);
      } catch (err) {
        _showAnalysisPane(`Error: ${escHtml(err.message)}`, 'Analysis Error', true);
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
        _showAnalysisPane('No context text. Paste text into the Workspace textarea first, then right-click a function and choose "Analyze with LLM + Workspace Context".', 'No Context');
        break;
      }
      // If textarea shows resolved @file (with separator), strip the display header
      contextText = _stripAtFileHeader(contextText);
      const mask = $('#ws-mask-all')?.checked || false;
      const maskComments = $('#ws-mask-comments')?.checked || false;
      const withDigest = $('#ws-with-digest')?.checked || false;
      _showAnalysisPane(`<div class="loading">Analyzing ${escHtml(target.name)} with context via ${escHtml(engine)}${withDigest ? ' (with digest)' : ''}…</div>`, 'Analyzing…', true);
      try {
        const data = await api.analyzeLlm({
          func: funcSpec,
          mode: 'context-analyze',
          contextText,
          engine, mask, maskComments, withDigest,
        });
        _renderLlmAnalysis(data);
      } catch (err) {
        _showAnalysisPane(`Error: ${escHtml(err.message)}`, 'Analysis Error', true);
      }
      break;
    }

    case 'analyze-file': {
      const fp = target.filepath || target.name;
      if (!fp) { _showAnalysisPane('No file associated with this item.', 'Error'); break; }
      const engine = $('#ws-engine').value;
      if (!checkEngineAvailability(engine)) break;
      const mask = $('#ws-mask-all')?.checked || false;
      const maskComments = $('#ws-mask-comments')?.checked || false;
      _showAnalysisPane(`<div class="loading">Analyzing file ${escHtml(shortPath(fp, 60))} via ${escHtml(engine)}…</div>`, 'Analyzing…', true);
      try {
        const data = await api.analyzeLlm({
          file: fp,
          mode: 'file-analyze',
          engine, mask, maskComments,
        });
        _renderLlmAnalysis(data);
      } catch (err) {
        _showAnalysisPane(`Error: ${escHtml(err.message)}`, 'Analysis Error', true);
      }
      break;
    }

    default: console.log(`Context action '${action}' not implemented`, target);
  }
}
