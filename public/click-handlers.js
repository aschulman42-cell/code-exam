/**
 * click-handlers.js — Entry points for user-initiated clicks in the
 * left and middle panes: function rows, file rows, class rows, vocab
 * tokens. Each handler fetches data via the api module and dispatches
 * to a render function that lives in app.js (injected at init time).
 *
 * Cross-cutting callbacks (`navPush`, `showMiddleTopLoading`,
 * `showMiddleTopError`, `showMiddleBottomLoading`,
 * `showMiddleBottomError`, `renderDisambiguation`, `renderCallInfo`,
 * `renderClassMethodsDetail`, `wireClickables`, `loadSectionData`,
 * `loadClassMethods`, `renderFilesSearchResults`) are injected via
 * `initClickHandlers({...})` to keep this module independent of
 * app.js's still-in-progress render-flow code.
 *
 * `renderSource` and `renderFileSource` are direct imports from
 * source-viewer.js (sibling module — no cycle since source-viewer
 * doesn't import this module directly; it DIs the two callbacks it
 * needs from click-handlers).
 */

import { state } from './state.js';
import { api } from './api.js';
import {
  $, $$, escHtml, displayNameHtml, shortPath, HIGHLIGHT_COLORS,
} from './dom-utils.js';
import { renderSource, renderFileSource } from './source-viewer.js';

// ============================================================================
// Cross-cutting callbacks (injected by initClickHandlers)
// ============================================================================

let _navPush = () => {};
let _showMiddleTopLoading = () => {};
let _showMiddleTopError = () => {};
let _showMiddleBottomLoading = () => {};
let _showMiddleBottomError = () => {};
let _renderDisambiguation = () => {};
let _renderCallInfo = () => {};
let _renderClassMethodsDetail = () => {};
let _wireClickables = () => {};
let _loadSectionData = async () => {};
let _loadClassMethods = () => {};
let _renderFilesSearchResults = () => {};

export function initClickHandlers(deps = {}) {
  if (typeof deps.navPush === 'function') _navPush = deps.navPush;
  if (typeof deps.showMiddleTopLoading === 'function') _showMiddleTopLoading = deps.showMiddleTopLoading;
  if (typeof deps.showMiddleTopError === 'function') _showMiddleTopError = deps.showMiddleTopError;
  if (typeof deps.showMiddleBottomLoading === 'function') _showMiddleBottomLoading = deps.showMiddleBottomLoading;
  if (typeof deps.showMiddleBottomError === 'function') _showMiddleBottomError = deps.showMiddleBottomError;
  if (typeof deps.renderDisambiguation === 'function') _renderDisambiguation = deps.renderDisambiguation;
  if (typeof deps.renderCallInfo === 'function') _renderCallInfo = deps.renderCallInfo;
  if (typeof deps.renderClassMethodsDetail === 'function') _renderClassMethodsDetail = deps.renderClassMethodsDetail;
  if (typeof deps.wireClickables === 'function') _wireClickables = deps.wireClickables;
  if (typeof deps.loadSectionData === 'function') _loadSectionData = deps.loadSectionData;
  if (typeof deps.loadClassMethods === 'function') _loadClassMethods = deps.loadClassMethods;
  if (typeof deps.renderFilesSearchResults === 'function') _renderFilesSearchResults = deps.renderFilesSearchResults;
}


// ============================================================================
// Click handlers
// ============================================================================

export async function onFunctionClick(funcInfo) {
  state.highlightTerms = null; // Clear search highlighting for non-search context
  const funcSpec = funcInfo.filepath
    ? `${funcInfo.filepath}@${funcInfo.name || funcInfo.display_name}`
    : (funcInfo.name || funcInfo.display_name);

  _navPush('middle-bottom');
  _showMiddleTopLoading(`Loading ${funcInfo.display_name || funcInfo.name}…`);

  try {
    const extractData = await api.extract({ func: funcSpec });
    if (extractData.ambiguous) { _renderDisambiguation(extractData.matches); return; }
    renderSource(extractData);

    const callersData = await api.callers({ func: funcSpec });
    const calleesData = await api.callees({ func: funcSpec });
    _renderCallInfo(extractData, callersData, calleesData);
  } catch (err) {
    _showMiddleTopError(err.message);
  }
}

/** Source-only click: populate middle-bottom without touching middle-top (preserves search results) */
export async function onFunctionClickSourceOnly(funcInfo) {
  const funcSpec = funcInfo.filepath
    ? `${funcInfo.filepath}@${funcInfo.name || funcInfo.display_name}`
    : (funcInfo.name || funcInfo.display_name);

  _showMiddleBottomLoading(`Loading ${funcInfo.display_name || funcInfo.name}…`);

  try {
    let extractData = await api.extract({ func: funcSpec });

    // Auto-disambiguate: if ambiguous and we have a current file context, prefer
    // the match in the same file, or the same directory. BUT: skip .d.ts type
    // stubs when any real implementation exists elsewhere. Without this, clicking
    // an identifier inside a .d.ts file would navigate to the signature one-liner
    // instead of the real function body in a sibling .js/.ts.
    if (extractData.ambiguous && extractData.matches.length > 0) {
      const realOnly = extractData.matches.filter(m => !m.filepath.endsWith('.d.ts'));
      const pool = realOnly.length > 0 ? realOnly : extractData.matches;
      const ctx = state.currentSourceFile || (funcInfo.filepath || '');
      let best = null;

      if (ctx) {
        // Exact file match
        best = pool.find(m => m.filepath === ctx);
        // Same directory match
        if (!best) {
          const ctxDir = ctx.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
          if (ctxDir) best = pool.find(m => m.filepath.replace(/\\/g, '/').startsWith(ctxDir + '/'));
        }
      }
      // Fallback: just pick the largest (most likely the real implementation)
      if (!best) {
        best = pool.reduce((a, b) => (b.lines > a.lines ? b : a), pool[0]);
      }

      // Re-fetch with the resolved filepath
      const resolvedSpec = `${best.filepath}@${best.name}`;
      extractData = await api.extract({ func: resolvedSpec });
      if (extractData.ambiguous) {
        _renderDisambiguation(extractData.matches);
        return;
      }
    }

    renderSource(extractData);
  } catch (err) {
    _showMiddleBottomError(err.message);
  }
}

export async function onFileClick(filepath, targetLine) {
  _showMiddleBottomLoading(`Loading ${filepath}…`);
  try {
    const data = await api.showFile({ path: filepath, line: targetLine || undefined });
    renderFileSource(data, targetLine);
  } catch (err) { _showMiddleBottomError(err.message); }
}

export async function onClassClick(className) {
  _showMiddleTopLoading(`Loading class ${className}…`);
  try {
    const data = await api.classMethods({ name: className });
    _renderClassMethodsDetail(data);
  } catch (err) { _showMiddleTopError(err.message); }
}

/** Class-row click from multisect/claim-search results: render method list in
 *  middle-bottom (preserves results in middle-top) and sync the left-pane
 *  Classes accordion. Matches the function-row sourceOnly pattern. TODO #369. */
export async function onClassClickSourceOnly(className) {
  _showMiddleBottomLoading(`Loading class ${className}…`);
  try {
    const data = await api.classMethods({ name: className });
    renderClassMethodsIntoMiddleBottom(data);
  } catch (err) {
    _showMiddleBottomError(err.message);
  }
  expandClassInLeftPane(className);
}

function renderClassMethodsIntoMiddleBottom(data) {
  const container = $('#middle-bottom-body');
  const title = $('#middle-bottom-title');
  title.innerHTML = `Class: ${displayNameHtml(data.name)} (${data.method_count} methods, ${data.total_lines} lines)`;
  let html = `<div class="output-section"><h3>Methods</h3>`;
  if (data.inferred) html += `<p style="color:var(--text-muted);font-size:11px;margin-bottom:6px">(Inferred from :: qualified method names)</p>`;
  html += '<table class="output-table"><tr><th>Method</th><th>File</th><th>Lines</th></tr>';
  for (const m of data.methods) {
    html += `<tr><td class="mono"><span class="clickable" data-funcname="${escHtml(m.name)}" data-filepath="${escHtml(m.filepath)}">${displayNameHtml(m.name)}</span></td>`;
    html += `<td class="mono muted">${escHtml(shortPath(m.filepath, 30))}</td><td>${m.lines}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  // sourceOnly: clicking a method shows source here (replaces this table); user can back-nav.
  _wireClickables(container, { sourceOnly: true });
}

/** Open the left-pane Classes accordion section, expand the sub-entry for
 *  className, and scroll to it. Silently no-ops if the class isn't in the
 *  currently-loaded subset (e.g. listClasses returned only the top 200). */
async function expandClassInLeftPane(className) {
  const section = $('.accordion-section[data-section="classes"]');
  if (!section) return;
  if (!section.classList.contains('open')) {
    section.classList.add('open');
    const filter = $('#left-filter').value.trim();
    try { await _loadSectionData('classes', filter); } catch { /* fall through */ }
  }
  const sub = $(`.sub-accordion[data-class="${cssEscape(className)}"]`, section);
  if (!sub) return;
  if (!sub.classList.contains('open')) {
    sub.classList.add('open');
    const subContent = $('.sub-accordion-content', sub);
    if (subContent && subContent.children.length === 0) {
      _loadClassMethods(className, subContent);
    }
  }
  sub.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

export async function onVocabClick(token) {
  state.highlightTerms = { terms: [token], colors: HIGHLIGHT_COLORS };
  _showMiddleTopLoading(`Files containing "${token}"…`);
  try {
    const data = await api.filesSearch({ q: token, max: 40 });
    _renderFilesSearchResults(token, data);
  } catch (err) { _showMiddleTopError(err.message); }
}
