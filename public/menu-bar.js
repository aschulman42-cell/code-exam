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

  // README/help modal: ✕ and backdrop click dismiss it.
  const readmeOverlay = $('#readme-overlay');
  if (readmeOverlay) {
    const closeReadme = () => readmeOverlay.classList.add('hidden');
    const closeBtn = $('#readme-close');
    if (closeBtn) closeBtn.addEventListener('click', closeReadme);
    readmeOverlay.addEventListener('click', (e) => { if (e.target === readmeOverlay) closeReadme(); });
  }
}

// ============================================================================
// Help: load README.md into a scrollable popup, rendered as Markdown (placeholder
// until a purpose-built GUI Help exists). Compact renderer so no raw markdown
// markup (fences, #, **, [text](url)) leaks into the popup.
// ============================================================================

async function openReadme() {
  const overlay = $('#readme-overlay');
  const body = $('#readme-body');
  if (!overlay || !body) return;
  body.innerHTML = '<div class="list-placeholder" style="padding:12px">Loading README…</div>';
  overlay.classList.remove('hidden');
  try {
    const res = await fetch('/api/readme');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    body.innerHTML = renderMarkdown(String(data.content || ''));
    body.scrollTop = 0;
  } catch (err) {
    body.innerHTML = `<div class="error-msg" style="padding:12px">Could not load README: ${err.message}</div>`;
  }
}

// Compact Markdown -> HTML. Escapes HTML first (no injection, no raw markup),
// then handles fenced code, headings, inline code/bold/italic/links, ordered &
// unordered lists, blockquotes, horizontal rules, and paragraphs.
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = md.split('\n');
  const special = /^(#{1,6}\s|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+|\s*(?:-{3,}|\*{3,}|_{3,})\s*$)/;
  let html = '', i = 0, listTag = '';
  const closeList = () => { if (listTag) { html += `</${listTag}>`; listTag = ''; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList(); i++;
      let code = '';
      while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + '\n'; i++; }
      i++;
      html += `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
      continue;
    }
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) { closeList(); const n = hm[1].length; html += `<h${n}>${inline(hm[2])}</h${n}>`; i++; continue; }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); html += '<hr>'; i++; continue; }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { closeList(); html += `<blockquote>${inline(bq[1])}</blockquote>`; i++; continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { if (listTag !== 'ul') { closeList(); html += '<ul>'; listTag = 'ul'; } html += `<li>${inline(ul[1])}</li>`; i++; continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) { if (listTag !== 'ol') { closeList(); html += '<ol>'; listTag = 'ol'; } html += `<li>${inline(ol[1])}</li>`; i++; continue; }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList();
    let para = line; i++;
    while (i < lines.length && lines[i].trim() && !special.test(lines[i])) { para += ' ' + lines[i]; i++; }
    html += `<p>${inline(para)}</p>`;
  }
  closeList();
  return html;
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
    case 'help':
      openReadme();
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
      try { renderSearchResults(query, await api.search({ q: query, type, max: parseInt($('#opt-max-results')?.value) || 50, in: r.inPath })); } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    case 'files-search': {
      const r = await showSearchDialog('Files Search', 'Files containing:');
      if (!r) return;
      const term = r.query;
      state.highlightTerms = { terms: [term], colors: HIGHLIGHT_COLORS };
      try { renderFilesSearchResults(term, await api.filesSearch({ q: term, max: parseInt($('#opt-max-results')?.value) || 50, in: r.inPath })); } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    case 'search-multisect': {
      const r = await showSearchDialog('Multisect Search', 'Terms (semicolon-separated):');
      if (!r) return;
      const terms = r.query;
      const minTermsVal = parseInt($('#ws-min-terms')?.value) || 0;
      showMiddleTopLoading(`Running multisect search… (Min Terms: ${minTermsVal === 0 ? 'all' : minTermsVal})`);
      try {
        const data = await api.multisect({ terms, max: parseInt($('#opt-max-results')?.value) || 50, min_terms: minTermsVal, in: r.inPath || undefined, match_renames: r.matchRenames || undefined });
        renderMultisectResults(data);
      } catch (err) { showMiddleTopError(err.message); }
      break;
    }
    default: console.log(`Menu action '${action}' not implemented`);
  }
}
