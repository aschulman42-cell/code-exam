/**
 * menu-bar.js — Top dropdown menus (Index, Search, Diagrams, etc.)
 * and the menu-action dispatcher. Each dropdown is declared in
 * index.html as a `.dropdown` containing `button[data-action]`
 * elements; this module wires those buttons to action handlers and
 * manages dropdown open/close behavior.
 *
 * All dependencies are direct imports — this is the first peeled
 * module with zero DI dependencies after the middle-pane peel
 * lifted the render-function callbacks into a sibling module.
 */

import { state } from './state.js';
import { api } from './api.js';
import { $, $$, HIGHLIGHT_COLORS } from './dom-utils.js';
import { showSearchDialog } from './dialogs.js';
import {
  showMiddleTopLoading, showMiddleTopError,
  renderStats, renderSearchResults, renderFilesSearchResults,
  renderMultisectResults,
} from './middle-pane.js';


// ============================================================================
// Menu bar setup
// ============================================================================

export function initMenuBar() {
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


// ============================================================================
// Menu actions
// ============================================================================

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
      const r = await showSearchDialog(`${label} Search`, `${label} search:`);
      if (!r) return;
      let query = r.query;
      // Strip /slashes/ from regex patterns
      if (type === 'regex') { const m = query.match(/^\/(.+)\/([gimsuy]*)$/); if (m) query = m[1]; }
      showMiddleTopLoading(`Searching: "${query}"…`);
      try { renderSearchResults(query, await api.search({ q: query, type, max: 30, in: r.inPath })); } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    case 'files-search': {
      const r = await showSearchDialog('Files Search', 'Files containing:');
      if (!r) return;
      const term = r.query;
      state.highlightTerms = { terms: [term], colors: HIGHLIGHT_COLORS };
      try { renderFilesSearchResults(term, await api.filesSearch({ q: term, max: 40, in: r.inPath })); } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    case 'search-multisect': {
      const r = await showSearchDialog('Multisect Search', 'Terms (semicolon-separated):');
      if (!r) return;
      const terms = r.query;
      const minTermsVal = parseInt($('#ws-min-terms')?.value) || 0;
      showMiddleTopLoading(`Running multisect search… (Min Terms: ${minTermsVal === 0 ? 'all' : minTermsVal})`);
      try {
        const data = await api.multisect({ terms, max: 30, min_terms: minTermsVal, in: r.inPath || undefined, match_renames: r.matchRenames || undefined });
        renderMultisectResults(data);
      } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    default: console.log(`Menu action '${action}' not implemented`);
  }
}
