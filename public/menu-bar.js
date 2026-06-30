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
import { TOURS } from './tours.js';


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

  // README modal: ✕ closes it; a backdrop click closes it too. Esc ends an
  // active interactive tour first, otherwise closes the README. (#230 Part B)
  const readmeOverlay = $('#readme-overlay');
  if (readmeOverlay) {
    const closeReadme = () => readmeOverlay.classList.add('hidden');
    const closeBtn = $('#readme-close');
    if (closeBtn) closeBtn.addEventListener('click', closeReadme);
    readmeOverlay.addEventListener('click', (e) => { if (e.target === readmeOverlay) closeReadme(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (tourStep >= 0) endTour();                          // Esc ends an active tour
      else if (!readmeOverlay.classList.contains('hidden')) closeReadme();
    });
  }

  // #230 Part B: an explicit `ce --tour [name]` rides in as ?tour=<name> — start
  // that tour immediately (bypassing the once-only ce_tour_seen guard, since the
  // user asked for it). Otherwise, on a fresh-download GUI (bundled demo loaded),
  // auto-pop the first-run tour once. Both best-effort.
  const _tourParam = new URLSearchParams(location.search).get('tour');
  if (_tourParam && TOURS[_tourParam]) sessionTourName = _tourParam;  // Help → Tour replays the launched tour
  if (_tourParam) startInteractiveTour(_tourParam);
  else maybeAutoOpenTour();
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
  if ($('#readme-title')) $('#readme-title').textContent = 'CodeExam — README';
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

// Auto-pop the interactive tour once on a fresh-download GUI — when the bundled
// demo index is loaded (server reports firstRunDemo) and the user hasn't seen it
// yet (localStorage guard, so it does NOT re-pop on every load). The /api/tour
// route is still the gate: its firstRunDemo flag means "the bundled demo is what
// got loaded". (The route also returns TOUR.md prose, now consumed only by the
// README-linked doc — the spotlight tour below is self-contained.)
async function maybeAutoOpenTour() {
  try {
    if (localStorage.getItem('ce_tour_seen')) return;
    const res = await fetch('/api/tour');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.firstRunDemo) return;
    localStorage.setItem('ce_tour_seen', '1');
    startInteractiveTour();
  } catch { /* best-effort */ }
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
    if (ul) {
      if (listTag !== 'ul') { closeList(); html += '<ul>'; listTag = 'ul'; }
      // Gather soft-wrapped continuation lines into this item (so a wrapped
      // bullet renders as one item, not a bullet + stray paragraph).
      let item = ul[1]; i++;
      while (i < lines.length && lines[i].trim() && !special.test(lines[i])) { item += ' ' + lines[i].trim(); i++; }
      html += `<li>${inline(item)}</li>`;
      continue;
    }
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (ol) {
      if (listTag !== 'ol') { closeList(); html += '<ol>'; listTag = 'ol'; }
      // `value="N"` preserves the source number even when sub-content splits the
      // list into separate <ol>s (otherwise every item restarts at 1).
      let item = ol[2]; i++;
      while (i < lines.length && lines[i].trim() && !special.test(lines[i])) { item += ' ' + lines[i].trim(); i++; }
      html += `<li value="${ol[1]}">${inline(item)}</li>`;
      continue;
    }
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
// Interactive guided tour (#230 Part B) — dependency-free spotlight.
//
// A single fixed #tour-spotlight is positioned over each step's target via
// getBoundingClientRect(); a huge spread box-shadow dims the rest of the page
// (a top-level fixed element, so it is never clipped by a scroll pane's
// overflow). A floating #tour-tip carries the title/body and Skip/Back/Next/Done
// nav with a step count. No third-party library — stays air-gapped.
//
// The engine is generic over a step list. The tour definitions live in
// ./tours.js (TOURS) — a dependency-free module shared with the CLI, so
// `ce --tour <name>` validates against the same names. See that file for the
// step shape and the #240 note on entity-level steps.
// ============================================================================

let activeTour = null;      // the step array currently being walked (null = none)
let sessionTourName = 'first-run';  // tour this GUI session belongs to (from ?tour=); Help → Tour replays it
let tourStep = -1;          // -1 = no active tour; otherwise the current step index
let tourReflowQueued = false;

function ensureTourEls() {
  if (!$('#tour-spotlight')) {
    const s = document.createElement('div'); s.id = 'tour-spotlight'; document.body.appendChild(s);
    const t = document.createElement('div'); t.id = 'tour-tip'; document.body.appendChild(t);
    // Keep the spotlight glued to its target if the window is resized mid-tour
    // (coalesced to one reflow per frame; no re-scroll, just reposition).
    window.addEventListener('resize', () => {
      if (tourStep < 0 || tourReflowQueued) return;
      tourReflowQueued = true;
      requestAnimationFrame(() => { tourReflowQueued = false; if (tourStep >= 0) gotoTourStep(tourStep, false); });
    });
  }
  return { spot: $('#tour-spotlight'), tip: $('#tour-tip') };
}

function endTour() {
  const s = $('#tour-spotlight'), t = $('#tour-tip');
  if (s) s.style.display = 'none';
  if (t) t.style.display = 'none';
  tourStep = -1;
  activeTour = null;
}

function gotoTourStep(n, scroll = true) {
  if (!activeTour || n < 0) return;
  if (n >= activeTour.length) return endTour();
  const step = activeTour[n];
  const { spot, tip } = ensureTourEls();
  const el = document.querySelector(step.sel);
  // Skip a step whose target is missing or not visible (e.g. a pane toggled off
  // via the Window menu, or an element absent for this index) rather than
  // spotlighting empty space. offsetParent is null for a display:none subtree.
  if (!el || el.offsetParent === null) return gotoTourStep(n + 1, scroll);
  tourStep = n;
  if (step.open) {
    const hdr = el.querySelector('.accordion-header');
    if (hdr && !el.classList.contains('open')) hdr.click();
  }
  // Instant scroll, not smooth: the rect is measured in the rAF below, and a
  // smooth scroll would still be animating then — the spotlight would land on
  // where the target *was*, not where it ends up. That race is what made the
  // tour appear to "disappear" mid-run on a large index (long scrolls).
  if (scroll) el.scrollIntoView({ block: 'center' });
  requestAnimationFrame(() => {
    const r = el.getBoundingClientRect();
    spot.style.display = 'block';
    spot.style.top = `${r.top - 4}px`; spot.style.left = `${r.left - 4}px`;
    spot.style.width = `${r.width + 8}px`; spot.style.height = `${r.height + 8}px`;
    const last = n === activeTour.length - 1;
    tip.style.display = 'block';
    tip.innerHTML =
      `<div class="tour-tip-title">${step.title}</div>` +
      `<div class="tour-tip-body">${step.body}</div>` +
      `<div class="tour-tip-nav"><span class="tour-tip-count">${n + 1} / ${activeTour.length}</span>` +
      `<span class="tour-tip-btns"><button id="tour-skip">Skip</button>` +
      (n > 0 ? `<button id="tour-back">Back</button>` : '') +
      `<button id="tour-next" class="tour-primary">${last ? 'Done' : 'Next'}</button></span></div>`;
    // Prefer below the target; flip above if it would overflow the viewport.
    const tr = tip.getBoundingClientRect();
    let top = r.bottom + 10;
    if (top + tr.height > window.innerHeight - 8) top = Math.max(8, r.top - tr.height - 10);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - tr.width - 8);
    tip.style.top = `${top}px`; tip.style.left = `${left}px`;
    $('#tour-next').onclick = () => gotoTourStep(n + 1);
    const back = $('#tour-back'); if (back) back.onclick = () => gotoTourStep(n - 1);
    $('#tour-skip').onclick = endTour;
  });
}

// Start a named tour from the TOURS registry (or a raw step array). Defaults to
// the first-run tour, so the no-arg callers (auto-pop, Help → Tour) are
// unchanged. Unknown name → no-op.
function startInteractiveTour(name = 'first-run') {
  const steps = Array.isArray(name) ? name : TOURS[name];
  if (!steps || !steps.length) {
    if (typeof name === 'string') console.warn(`[tour] no tour named "${name}" — known tours: ${Object.keys(TOURS).join(', ')}`);
    return;
  }
  activeTour = steps;
  ensureTourEls();
  gotoTourStep(0);
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
    case 'tour':
      startInteractiveTour(sessionTourName);
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
