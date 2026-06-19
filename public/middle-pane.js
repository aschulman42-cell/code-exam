/**
 * middle-pane.js — The middle-pane render layer. Contains three
 * tightly-coupled groups that share the show-loading and nav chrome:
 *
 * - **Chrome**: showMiddleTopLoading, navPush, navBack, navForward,
 *   navUpdateButtons, navClearAll, clearAllPanes. The lowest-level
 *   helpers in the frontend; nearly every other module calls into
 *   these.
 * - **Response renderers**: renderCallInfo, renderDisambiguation,
 *   renderDigest, renderCallersOnly, renderCalleesOnly,
 *   renderClassMethodsDetail, renderFilesSearchResults,
 *   renderSearchResults, renderStats. Middle-top content for clicks
 *   and menu actions.
 * - **Multisect views**: _renderScopeViews + renderMultisectResults
 *   and their internals. Originally #1 on Issue #4's migration list.
 *
 * Cycle note: middle-pane ↔ click-handlers and middle-pane ↔
 * source-viewer are direct-import cycles. ES modules tolerate these
 * when neither side does top-level work touching the other (both
 * only declare functions at top level; calls happen inside function
 * bodies at user-interaction time). The load-test confirms this.
 *
 * `wireClickables` stays in app.js for this peel (DI'd in here) —
 * its other big consumer is the left-pane renderers which haven't
 * been extracted yet. Once those land, `wireClickables` becomes a
 * candidate for its own micro-peel.
 */

import { state } from './state.js';
import { api } from './api.js';
import {
  $, $$, h, escHtml, displayNameHtml,
  shortPath, shortFuncName, highlightLine, HIGHLIGHT_COLORS,
} from './dom-utils.js';
import { showPane } from './layout.js';
import { linkifySourceCalls } from './source-viewer.js';
import { onFileClick } from './click-handlers.js';
import { consoleAppend, consoleClear } from './console.js';


// ============================================================================
// Cross-cutting callbacks (injected by initMiddlePane)
// ============================================================================

let _wireClickables = () => {};

export function initMiddlePane(deps = {}) {
  if (typeof deps.wireClickables === 'function') _wireClickables = deps.wireClickables;
}


// ============================================================================
// Loading / error chrome
// ============================================================================

export function showMiddleTopLoading(msg) { showPane('middle-top'); navPush('middle-top'); $('#middle-top-body').innerHTML = `<div class="loading">${escHtml(msg)}</div>`; $('#middle-top-title').textContent = 'Loading…'; }
export function showMiddleTopError(msg)   { showPane('middle-top'); $('#middle-top-body').innerHTML = `<div class="error-msg">${escHtml(msg)}</div>`; $('#middle-top-title').textContent = 'Error'; }
export function showMiddleBottomLoading(msg) { navPush('middle-bottom'); $('#middle-bottom-body').innerHTML = `<div class="loading">${escHtml(msg)}</div>`; $('#middle-bottom-title').textContent = 'Loading…'; }
export function showMiddleBottomError(msg)   { $('#middle-bottom-body').innerHTML = `<div class="error-msg">${escHtml(msg)}</div>`; $('#middle-bottom-title').textContent = 'Error'; }


// ============================================================================
// Pane navigation history (back/forward for both middle panes)
// ============================================================================

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
    _wireClickables(body, { sourceOnly: true });
  }
  navUpdateButtons(paneId);
}

export function navPush(paneId) {
  const entry = navCapture(paneId);
  if (!entry) return;
  const nav = paneNav[paneId];
  nav.back.push(entry);
  if (nav.back.length > NAV_MAX) nav.back.shift();
  nav.forward = []; // new navigation clears forward stack
  navUpdateButtons(paneId);
}

export function navBack(paneId) {
  const nav = paneNav[paneId];
  if (!nav.back.length) return;
  // Save current state to forward stack
  const current = navCapture(paneId);
  if (current) nav.forward.push(current);
  const entry = nav.back.pop();
  navRestore(paneId, entry);
}

export function navForward(paneId) {
  const nav = paneNav[paneId];
  if (!nav.forward.length) return;
  // Save current state to back stack
  const current = navCapture(paneId);
  if (current) nav.back.push(current);
  const entry = nav.forward.pop();
  navRestore(paneId, entry);
}

export function navUpdateButtons(paneId) {
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

export function navClearAll() {
  for (const paneId of ['middle-top', 'middle-bottom']) {
    paneNav[paneId].back = [];
    paneNav[paneId].forward = [];
    navUpdateButtons(paneId);
  }
}

export function clearAllPanes() {
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


// ============================================================================
// Response renderers (middle-top content)
// ============================================================================

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

export function renderCallInfo(extractData, callersData, calleesData) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  // innerHTML (not textContent) so the inferred-suffix span survives and the
  // View > Show Inferred Name Suffixes toggle hides it live, like the source pane.
  title.innerHTML = displayNameHtml(extractData.display_name || extractData.name);
  let html = '';

  const funcLabel = displayNameHtml(extractData.display_name || extractData.name);
  html += `<div class="output-section"><h3>Function Info: <span class="clickable" data-funcname="${escHtml(extractData.name)}" data-filepath="${escHtml(extractData.filepath)}">${funcLabel}</span></h3><table class="output-table">`;
  html += `<tr><td class="muted">File</td><td class="mono"><span class="clickable" data-filepath="${escHtml(extractData.filepath)}">${escHtml(extractData.filepath)}</span></td></tr>`;
  html += `<tr><td class="muted">Lines</td><td>${extractData.start}–${extractData.end} (${extractData.lines} lines)</td></tr>`;
  html += `</table>`;
  html += `<div style="margin-top:6px"><button class="btn-secondary" id="find-funcstring-peers-btn" data-funcname="${escHtml(extractData.name)}" data-filepath="${escHtml(extractData.filepath)}">Find structural peers</button> <span class="muted" style="font-size:11px">other functions sharing this funcstring, ranked by surprise</span></div>`;
  html += `</div>`;

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
  _wireClickables(container);

  const expandBtn = $('#show-all-callers', container);
  if (expandBtn) {
    expandBtn.addEventListener('click', () => renderCallersOnly(extractData.name, callersData));
  }

  const peersBtn = $('#find-funcstring-peers-btn', container);
  if (peersBtn) {
    peersBtn.addEventListener('click', () => {
      const fn = peersBtn.dataset.funcname;
      const fp = peersBtn.dataset.filepath;
      const spec = fp ? `${fp}@${fn}` : fn;
      loadFuncstringPeers(spec, { includeExact: false });
    });
  }
}

async function loadFuncstringPeers(funcSpec, opts = {}) {
  const includeExact = !!opts.includeExact;
  showMiddleTopLoading(`Finding structural peers…`);
  try {
    const data = await api.funcstringPeers({
      func: funcSpec,
      includeExact: includeExact ? 1 : 0,
    });
    renderFuncstringPeers(data, funcSpec, includeExact);
  } catch (err) {
    showMiddleTopError(err.message);
  }
}

function renderFuncstringPeers(data, funcSpec, includeExact) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const queryLabel = data.query.display_name || data.query.name;
  title.textContent = `Structural peers: ${queryLabel}`;

  const peers = data.peers || [];
  const shortHash = (data.query.struct_hash || '').slice(0, 12);

  let html = '<div class="output-section">';
  html += `<h3>Structural peers of <span class="clickable" data-funcname="${escHtml(data.query.name)}" data-filepath="${escHtml(data.query.filepath)}">${escHtml(queryLabel)}</span></h3>`;
  html += `<table class="output-table">`;
  html += `<tr><td class="muted">File</td><td class="mono"><span class="clickable" data-filepath="${escHtml(data.query.filepath)}">${escHtml(data.query.filepath)}</span></td></tr>`;
  html += `<tr><td class="muted">Lines</td><td>${data.query.lines}</td></tr>`;
  html += `<tr><td class="muted">struct_hash</td><td class="mono" title="${escHtml(data.query.struct_hash)}">${escHtml(shortHash)}…</td></tr>`;
  html += `</table>`;

  html += `<div style="margin:6px 0;font-size:12px">`;
  html += `<label style="cursor:pointer"><input type="checkbox" id="peers-include-exact" ${includeExact ? 'checked' : ''}> include exact-body matches</label>`;
  html += `<span class="muted" style="margin-left:12px">${peers.length} peer${peers.length !== 1 ? 's' : ''}${data.truncated ? ` (truncated from ${data.total_peers})` : ''}</span>`;
  html += `</div>`;
  html += `</div>`;

  if (peers.length === 0) {
    html += `<div class="output-section"><p class="muted">No structural peers found${includeExact ? '' : ' (try enabling exact-body matches)'}. This function's structural shape is unique in the index.</p></div>`;
  } else {
    html += '<div class="output-section">';
    html += `<table class="output-table" id="peers-table">`;
    html += `<tr>`;
    html += `<th>#</th>`;
    html += `<th class="sort-col" data-sortby="score">Surprise ▼</th>`;
    html += `<th class="sort-col" data-sortby="nameDist">Name dist</th>`;
    html += `<th class="sort-col" data-sortby="pathDist">Path dist</th>`;
    html += `<th>Cross-lang</th>`;
    html += `<th>Kind</th>`;
    html += `<th>Function</th>`;
    html += `<th>File</th>`;
    html += `<th>Lines</th>`;
    html += `</tr>`;
    for (let i = 0; i < peers.length; i++) {
      const p = peers[i];
      const s = p.surprise || {};
      const kindBadge = p.kind === 'exact-body'
        ? `<span class="type-badge" title="body bytes identical to query">exact-body</span>`
        : `<span class="type-badge" style="background:var(--accent-bg,#1a3a4a);color:var(--accent,#7cc)" title="same funcstring, different body text">structural</span>`;
      const xl = s.crossLang ? `<span title="different file extension">yes</span>` : '<span class="muted">no</span>';
      html += `<tr data-row-i="${i}">`;
      html += `<td class="muted">${i + 1}</td>`;
      html += `<td><strong>${(s.score ?? 0).toFixed(2)}</strong></td>`;
      html += `<td>${(s.nameDist ?? 0).toFixed(2)}</td>`;
      html += `<td>${(s.pathDist ?? 0).toFixed(2)}</td>`;
      html += `<td>${xl}</td>`;
      html += `<td>${kindBadge}</td>`;
      html += `<td class="mono"><span class="clickable" data-funcname="${escHtml(p.name)}" data-filepath="${escHtml(p.filepath)}">${escHtml(p.display_name || p.name)}</span></td>`;
      html += `<td class="mono clickable file-link" data-filepath="${escHtml(p.filepath)}" data-start="${p.start || ''}" title="${escHtml(p.filepath)}">${escHtml(shortPath(p.filepath, 40))}</td>`;
      html += `<td class="muted">${p.lines || ''}</td>`;
      html += `</tr>`;
    }
    html += `</table></div>`;
  }

  container.innerHTML = html;
  _wireClickables(container, { sourceOnly: true });

  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const startLine = parseInt(el.dataset.start) || undefined;
      onFileClick(el.dataset.filepath, startLine);
    });
  }

  const cb = $('#peers-include-exact', container);
  if (cb) {
    cb.addEventListener('change', () => loadFuncstringPeers(funcSpec, { includeExact: cb.checked }));
  }

  for (const th of $$('.sort-col', container)) {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const key = th.dataset.sortby;
      const sorted = [...(data.peers || [])].sort((a, b) => (b.surprise?.[key] ?? 0) - (a.surprise?.[key] ?? 0));
      renderFuncstringPeers({ ...data, peers: sorted }, funcSpec, includeExact);
    });
  }
}

export function renderDisambiguation(matches) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = 'Multiple matches — select one';
  let html = '<div class="output-section"><h3>Disambiguation</h3><table class="output-table"><tr><th>#</th><th>Function</th><th>File</th><th>Lines</th></tr>';
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    html += `<tr><td>${i + 1}</td><td class="mono"><span class="clickable" data-funcname="${escHtml(m.name)}" data-filepath="${escHtml(m.filepath)}">${escHtml(m.display_name)}</span></td>`;
    html += `<td class="mono muted">${escHtml(shortPath(m.filepath, 40))}</td><td>${m.lines}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  _wireClickables(container);
}

export function renderDigest(data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `Digest: ${data.spec}`;

  // Build a "shortPath:line" → site lookup from the structured digest data.
  // The formatter's _shortPath truncates filepaths >50 chars with a leading
  // ellipsis; the real path (used for navigation) lives in the structured
  // form. Walk caller sites; in the future callee sites could be linked
  // similarly.
  const siteLookup = new Map();
  const shortFp = (fp) => (fp && fp.length > 50) ? '…' + fp.slice(-49) : (fp || '');
  for (const caller of (data.digest?.callers?.byCaller) || []) {
    for (const site of caller.sites || []) {
      siteLookup.set(`${shortFp(site.filepath)}:${site.line}`, site);
    }
  }

  // Walk the rendered text line by line. Each caller-site reference appears
  // as `      shortPath:line` (six-space indent), optionally followed by the
  // call-site source on the next line (`        text…`, eight-space indent).
  // Both lines get wrapped in a clickable span tied to onFileClick so
  // readers can jump directly to the call site.
  const textLines = data.text.split('\n');
  const out = [];
  for (let i = 0; i < textLines.length; i++) {
    const line = textLines[i];
    const m = line.match(/^(\s+)([^\s:]+:\d+)\s*$/);
    if (m && siteLookup.has(m[2])) {
      const site = siteLookup.get(m[2]);
      const indent = escHtml(m[1]);
      const ref = escHtml(m[2]);
      out.push(`${indent}<span class="file-link clickable" data-filepath="${escHtml(site.filepath)}" data-start="${site.line}">${ref}</span>`);
      // If the next line is the indented source-text continuation for this
      // site, wrap it too — clicking the code lands on the same line.
      const next = textLines[i + 1];
      if (next && /^ {8}\S/.test(next)) {
        out.push(`<span class="file-link clickable" data-filepath="${escHtml(site.filepath)}" data-start="${site.line}" style="color:var(--text-dim)">${escHtml(next)}</span>`);
        i++;
      }
    } else {
      out.push(escHtml(line));
    }
  }

  container.innerHTML = `<pre class="digest-view" style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;padding:8px;margin:0">${out.join('\n')}</pre>`;

  // Wire the clicks. Same pattern used in renderStringDetail / file-map.
  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      onFileClick(el.dataset.filepath, parseInt(el.dataset.start) || undefined);
    });
  }
}

export function renderCallersOnly(funcName, data) {
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
  _wireClickables(container);

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

export function renderCalleesOnly(funcName, data) {
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
  _wireClickables(container);
}

export function renderClassMethodsDetail(data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.innerHTML = `Class: ${displayNameHtml(data.name)} (${data.method_count} methods, ${data.total_lines} lines)`;
  let html = `<div class="output-section"><h3>Methods</h3>`;
  if (data.inferred) html += `<p style="color:var(--text-muted);font-size:11px;margin-bottom:6px">(Inferred from :: qualified method names)</p>`;
  html += '<table class="output-table"><tr><th>Method</th><th>File</th><th>Lines</th></tr>';
  for (const m of data.methods) {
    html += `<tr><td class="mono"><span class="clickable" data-funcname="${escHtml(m.name)}" data-filepath="${escHtml(m.filepath)}">${displayNameHtml(m.name)}</span></td>`;
    html += `<td class="mono muted">${escHtml(shortPath(m.filepath, 30))}</td><td>${m.lines}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  _wireClickables(container);
}

// Visible, non-modal banner for truncated result sets (the silent-cap fix).
// `total` known -> "showing N of M"; unknown -> "showing N; more exist".
function _capWarning(shown, total) {
  const more = (total != null) ? `showing ${shown} of ${total}` : `showing ${shown}; more matches exist`;
  return `<div style="padding:6px 12px;background:#5a3a00;color:#ffd479;font-size:12px;border-bottom:1px solid var(--border)">`
    + `&#9888; Results capped — ${more}. Raise <b>Max Results</b> (View menu) or use CLI <code>--max-results &lt;N&gt;</code>.</div>`;
}

export function renderFilesSearchResults(token, data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const capped = data.total > data.files.length;
  title.textContent = `"${token}" — ${data.total} files, showing top ${data.files.length}`;
  if (!data.files.length) { container.innerHTML = '<div class="list-placeholder">No files found</div>'; return; }
  let html = (capped ? _capWarning(data.files.length, data.total) : '')
    + '<div class="output-section"><table class="output-table"><tr><th>#</th><th>File</th><th>Hits</th></tr>';
  for (const f of data.files) {
    html += `<tr><td class="muted">${f.rank}</td><td class="mono"><span class="clickable" data-filepath="${escHtml(f.filepath)}">${escHtml(shortPath(f.filepath, 60))}</span></td><td>${f.hits}</td></tr>`;
  }
  container.innerHTML = html + '</table></div>';
  _wireClickables(container);
}

export function renderSearchResults(query, data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const capped = !!data.truncated;
  title.textContent = capped
    ? `Search: "${query}" — showing ${data.results.length}, CAPPED (more exist)`
    : `Search: "${query}" (${data.results.length} results)`;

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

  let html = capped ? _capWarning(data.results.length) : '';
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
  _wireClickables(container, { sourceOnly: true });
}

export function renderStats(data) {
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


// ============================================================================
// Multisect views — per-scope tables (function/class/file/folder)
// ============================================================================

// Render a multisect/claim-search result set as four per-scope tables
// (function / class / file / folder) preceded by a numbered term legend.
// `views` is the per-scope object returned by /api/multisect, /api/claim-search,
// or one of the tiers of /api/claim-search-llm.
// Build the indented per-line evidence block under a single match.
// scopeKind: 'function' | 'class' | 'file' | 'folder'
function _renderEvidence(m, terms, notSet, scopeKind) {
  // Folder: per-term file lists (mirrors CLI's folder rendering)
  if (scopeKind === 'folder') {
    const fileSets = m.file_sets || {};
    let html = '<div class="ms-detail-cell">';
    for (let ti = 0; ti < terms.length; ti++) {
      const t = terms[ti];
      const tag = `<span class="muted">[${ti + 1}]</span>`;
      const dispName = `<span class="mono">${escHtml(t.display)}</span>`;
      let body;
      if (t.negated) {
        body = '<span class="muted">OK absent (NOT term)</span>';
      } else {
        const files = fileSets[ti] || [];
        if (files.length === 0) {
          body = '<span class="muted" style="color:var(--accent-red)">*** NOT FOUND ***</span>';
        } else {
          const basenames = files.slice(0, 5).map(f => {
            const sep = Math.max(f.lastIndexOf('/'), f.lastIndexOf('\\'));
            return sep >= 0 ? f.slice(sep + 1) : f;
          });
          const more = files.length > 5 ? ` <span class="muted">+${files.length - 5} more</span>` : '';
          body = `<span class="muted">in</span> <span class="mono">${escHtml(basenames.join(', '))}</span>${more}`;
        }
      }
      html += `<div class="ms-evidence">${tag} ${dispName} &nbsp; ${body}</div>`;
    }
    html += '</div>';
    return html;
  }

  // function/class/file: line-evidence rendering, grouping terms that hit the same line
  const details = m.details || {};
  const lineGroups = new Map();  // key -> {line_num, indices, text, ann}
  for (let ti = 0; ti < terms.length; ti++) {
    if (notSet.has(ti)) continue;
    const d = details[ti];
    if (!d) continue;
    const fp = d.filepath || m.filepath || '';
    const key = scopeKind === 'class' ? `${fp}\x00${d.line_num}` : String(d.line_num);
    if (!lineGroups.has(key)) {
      let ann = '';
      if (scopeKind === 'class') {
        const fn = d.func_name || '';
        const meth = fn.includes('::') ? fn.split('::').pop() : fn.includes('.') ? fn.split('.').pop() : fn;
        const fpLabel = (m.files && m.files.length > 1) ? ` (${shortPath(fp, 28)})` : '';
        ann = meth ? ` <span class="muted">${escHtml(meth)}()${fpLabel}</span>` : '';
      } else if (scopeKind === 'file') {
        const fn = d.func_name && d.func_name !== '(global)' ? d.func_name : '(global)';
        ann = ` <span class="muted">in ${escHtml(fn)}</span>`;
      }
      lineGroups.set(key, { line_num: d.line_num, indices: [], text: d.line_text || '', ann });
    }
    lineGroups.get(key).indices.push(ti + 1);
  }
  const sorted = [...lineGroups.values()].sort((a, b) => a.line_num - b.line_num);
  let html = '<div class="ms-detail-cell">';
  for (const g of sorted) {
    const text = g.text.length > 120 ? g.text.slice(0, 117) + '...' : g.text;
    const tag = g.indices.length > 1 ? `[${g.indices.join(',')}]` : `[${g.indices[0]}]`;
    html += `<div class="ms-evidence"><span class="muted">${tag}</span> <span class="muted">L${g.line_num}</span>${g.ann} <span class="mono">${escHtml(text)}</span></div>`;
  }
  html += '</div>';
  return html;
}

export function _wireMultisectToggles(container) {
  for (const t of container.querySelectorAll('.ms-toggle')) {
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      const tr = t.closest('tr');
      const detail = tr ? tr.nextElementSibling : null;
      if (detail && detail.classList.contains('ms-detail-row')) {
        detail.classList.toggle('collapsed');
        t.classList.toggle('expanded');
      }
    });
  }
}

export function _renderScopeViews(views, opts = {}) {
  const { showLegend = true, headingPrefix = '' } = opts;
  const terms = views.terms || [];
  const notSet = new Set(terms.map((t, i) => t.negated ? i : -1).filter(i => i >= 0));
  const nPos = views.num_positive || terms.filter(t => !t.negated).length;
  const totalHits = (views.function_matches || []).length
    + (views.class_matches || []).length
    + (views.file_matches || []).length
    + (views.folder_matches || []).length;
  const grandTotal = (views.function_total ?? (views.function_matches || []).length)
    + (views.class_total ?? (views.class_matches || []).length)
    + (views.file_total ?? (views.file_matches || []).length)
    + (views.folder_total ?? (views.folder_matches || []).length);

  let html = '';
  // Action-only banner; the per-scope shown/total counts live in the title
  // (avoids two redundant, differently-phrased cap messages).
  if (grandTotal > totalHits) {
    html += '<div style="padding:6px 12px;background:#5a3a00;color:#ffd479;font-size:12px;border-bottom:1px solid var(--border)">'
      + '&#9888; Some scopes capped (counts in title) — raise <b>Max Results</b> (View menu) or use CLI <code>--max-results &lt;N&gt;</code> to see all.</div>';
  }

  // Numbered term legend (so screenshots are self-contained)
  if (showLegend && terms.length) {
    html += '<div class="multisect-legend" style="font-size:11px;margin:4px 0 8px 0">';
    for (let i = 0; i < terms.length; i++) {
      const t = terms[i];
      html += `<span class="term-chip${t.negated ? ' negated' : ''}" style="margin:1px 4px 1px 0">`
        + `<span class="muted" style="font-size:10px">${i + 1}</span> ${escHtml(t.display)}`
        + '</span>';
    }
    if (typeof views.min_terms === 'number') {
      html += `<span class="muted" style="margin-left:6px;font-size:11px">min: ${views.min_terms}/${nPos}</span>`;
    }
    // LLM-output sanitization meta: surface if any cap/drop/trim happened
    const sm = views.sanitize_meta;
    if (sm && (sm.capped > 0 || sm.dropped > 0 || sm.trimmed > 0)) {
      const bits = [];
      if (sm.capped > 0)  bits.push(`capped ${sm.capped} (max ${sm.max_terms})`);
      if (sm.dropped > 0) bits.push(`dropped ${sm.dropped}`);
      if (sm.trimmed > 0) bits.push(`trimmed ${sm.trimmed}`);
      html += `<span style="color:var(--accent-red);margin-left:10px;font-size:10px" `
        + `title="LLM emitted ${sm.llm_emitted} terms; kept ${sm.kept}">`
        + `LLM→${sm.llm_emitted}, kept ${sm.kept} (${bits.join(', ')})</span>`;
    }
    html += '</div>';

    // Auto-dropped low-selectivity terms: show as struck-through chips with coverage badges
    const sf = views.selectivity_filter;
    if (sf && sf.dropped && sf.dropped.length > 0) {
      const pctThreshold = Math.round(sf.threshold * 100);
      html += `<div class="multisect-legend" style="font-size:11px;margin:0 0 8px 0;padding:4px 6px;background:var(--bg-dark);border-left:3px solid var(--accent-red)">`;
      html += `<span style="color:var(--accent-red);font-weight:600;margin-right:6px">auto-dropped ${sf.dropped.length} low-selectivity term${sf.dropped.length !== 1 ? 's' : ''} (>${pctThreshold}% file coverage):</span>`;
      for (const d of sf.dropped) {
        const pct = Math.round(d.coverage * 100);
        html += `<span class="term-chip" style="text-decoration:line-through;opacity:0.65;margin:1px 4px 1px 0" `
          + `title="hit ${d.file_count}/${sf.total_files} files (${pct}%)">${escHtml(d.display)} `
          + `<span class="muted" style="font-size:9px">${pct}%</span></span>`;
      }
      html += `</div>`;
    }
  }

  if (totalHits === 0) {
    return html + '<div class="list-placeholder">No matches at any scope</div>';
  }

  // Compact "matched" indices badge, split by term polarity into three
  // typographic forms: hard-required hits in [brackets], soft-required hits
  // in (parens), soft-NOT violations with a ~tilde. Term indices are 1-based
  // in the badge; `terms[i]` carries `.hard`/`.negated` from the parser
  // (`.hard` absent => treat as hard, for results from older servers).
  const _isSoft = (i) => !!(terms[i] && terms[i].hard === false);
  const matchedBadge = (m) => {
    const hardHits = [], softHits = [];
    for (const i of (m.matched_indices || [])) {
      (_isSoft(i) ? softHits : hardHits).push(i + 1);
    }
    const softNot = (m.soft_not_violated || []).map(i => i + 1);
    const parts = [];
    if (hardHits.length) parts.push(`[${_compactRanges(hardHits.sort((a, b) => a - b))}]`);
    if (softHits.length) parts.push(`(${_compactRanges(softHits.sort((a, b) => a - b))})`);
    if (softNot.length)  parts.push(`~${_compactRanges(softNot.sort((a, b) => a - b))}`);
    if (!parts.length) return '';
    return `<span class="muted" style="font-size:10px;margin-left:6px" `
      + `title="[hard-required] (soft-required) ~soft-NOT violated">${parts.join(' ')}</span>`;
  };

  // Soft-NOT violation flag: the scope contains a discouraged term. Unlike a
  // hard NOT it is not filtered out — it is kept and flagged for review.
  const verifyBadge = (m) => {
    const sv = m.soft_not_violated || [];
    if (!sv.length) return '';
    const names = sv.map(i => (terms[i] && terms[i].display) || `#${i + 1}`).join(', ');
    return `<span style="font-size:9px;margin-left:6px;padding:1px 5px;border-radius:3px;`
      + `border:1px solid var(--accent-red);color:var(--accent-red)" `
      + `title="contains discouraged soft-NOT term(s): ${escHtml(names)} — kept for ranking, verify manually">`
      + `contains forbidden term — verify</span>`;
  };

  const idfBadge = (m) => (typeof m.idf_score === 'number' && m.idf_score > 0)
    ? `<span class="muted" style="font-size:10px;margin-left:4px">IDF:${m.idf_score.toFixed(1)}</span>`
    : '';

  // Red-alert: positive terms not found in this match. Empty when all positives hit.
  const missingBadge = (m) => {
    const matched = new Set(m.matched_indices || []);
    const missing = [];
    for (let i = 0; i < terms.length; i++) {
      if (terms[i].negated) continue;
      if (!matched.has(i)) missing.push(i + 1);
    }
    if (!missing.length) return '';
    return `<span class="ms-missing-badge" title="positive terms not found in this match">missing: [${_compactRanges(missing)}]</span>`;
  };

  // ---- FUNCTION-level ----
  const fm = views.function_matches || [];
  if (fm.length || views.function_total > 0) {
    html += `<div class="output-section" style="margin-top:6px">`;
    html += `<h4 style="margin:0 0 4px 0;font-size:12px">${escHtml(headingPrefix)}Function-level (${views.function_total || fm.length})</h4>`;
    if (!fm.length) {
      html += '<div class="muted" style="font-size:11px">No function-level matches</div>';
    } else {
      html += '<table class="output-table"><tr><th>#</th><th>Function</th><th>Terms</th><th>Lines</th></tr>';
      for (let i = 0; i < fm.length; i++) {
        const m = fm[i];
        html += `<tr><td class="muted"><span class="ms-toggle expanded" title="Hide evidence">▶</span>${i + 1}</td><td class="mono">`
          + `<span class="clickable" data-funcname="${escHtml(m.function)}" data-filepath="${escHtml(m.filepath)}">${displayNameHtml(m.function)}</span>`
          + `<span class="muted" style="font-size:10px"> in ${escHtml(shortPath(m.filepath, 50))}</span>`
          + matchedBadge(m) + idfBadge(m) + missingBadge(m) + verifyBadge(m)
          + `</td><td>${m.terms_matched}/${nPos}</td><td>${m.lines || 0}</td></tr>`;
        // Function-level: evidence row expanded by default; chevron collapses it
        html += `<tr class="ms-detail-row"><td colspan="4">${_renderEvidence(m, terms, notSet, 'function')}</td></tr>`;
      }
      html += '</table>';
    }
    html += '</div>';
  }

  // ---- CLASS-level ----
  const cm = views.class_matches || [];
  if (cm.length || views.class_suppressed) {
    const note = views.class_suppressed
      ? ` <span class="muted" style="font-size:10px">(${views.class_suppressed} suppressed — covered by function matches)</span>` : '';
    html += `<div class="output-section" style="margin-top:6px">`;
    html += `<h4 style="margin:0 0 4px 0;font-size:12px">Class-level (${cm.length})${note}</h4>`;
    if (cm.length) {
      html += '<table class="output-table"><tr><th>#</th><th>Class</th><th>Terms</th><th>Methods</th><th>Lines</th></tr>';
      for (let i = 0; i < cm.length; i++) {
        const m = cm[i];
        const fileLabel = m.files.length === 1 ? shortPath(m.files[0], 40) : `${m.files.length} files`;
        html += `<tr><td class="muted"><span class="ms-toggle" title="Show evidence">▶</span>${i + 1}</td><td class="mono">`
          + `<span class="clickable" data-classname="${escHtml(m.class_name)}">${displayNameHtml(m.class_name)}</span>`
          + `<span class="muted" style="font-size:10px"> in ${escHtml(fileLabel)}</span>`
          + matchedBadge(m) + idfBadge(m) + missingBadge(m) + verifyBadge(m)
          + `</td><td>${m.terms_matched}/${nPos}</td><td>${m.functions.length}</td><td>${m.total_lines}</td></tr>`;
        html += `<tr class="ms-detail-row collapsed"><td colspan="5">${_renderEvidence(m, terms, notSet, 'class')}</td></tr>`;
      }
      html += '</table>';
    }
    html += '</div>';
  }

  // ---- FILE-level ----
  const fileM = views.file_matches || [];
  if (fileM.length || views.file_suppressed) {
    const note = views.file_suppressed
      ? ` <span class="muted" style="font-size:10px">(${views.file_suppressed} suppressed — covered by function/class matches)</span>` : '';
    html += `<div class="output-section" style="margin-top:6px">`;
    html += `<h4 style="margin:0 0 4px 0;font-size:12px">File-level (${fileM.length})${note}</h4>`;
    if (fileM.length) {
      html += '<table class="output-table"><tr><th>#</th><th>File</th><th>Terms</th><th>Lines</th></tr>';
      for (let i = 0; i < fileM.length; i++) {
        const m = fileM[i];
        html += `<tr><td class="muted"><span class="ms-toggle" title="Show evidence">▶</span>${i + 1}</td><td class="mono">`
          + `<span class="clickable" data-filepath="${escHtml(m.filepath)}">${escHtml(shortPath(m.filepath, 60))}</span>`
          + matchedBadge(m) + idfBadge(m) + missingBadge(m) + verifyBadge(m)
          + `</td><td>${m.terms_matched}/${nPos}</td><td>${m.lines || 0}</td></tr>`;
        html += `<tr class="ms-detail-row collapsed"><td colspan="4">${_renderEvidence(m, terms, notSet, 'file')}</td></tr>`;
      }
      html += '</table>';
    }
    html += '</div>';
  }

  // ---- FOLDER-level ----
  const folderM = views.folder_matches || [];
  if (folderM.length || views.folder_suppressed) {
    const note = views.folder_suppressed
      ? ` <span class="muted" style="font-size:10px">(${views.folder_suppressed} suppressed — covered by single-file matches)</span>` : '';
    html += `<div class="output-section" style="margin-top:6px">`;
    html += `<h4 style="margin:0 0 4px 0;font-size:12px">Folder-level (${folderM.length})${note}</h4>`;
    if (folderM.length) {
      html += '<table class="output-table"><tr><th>#</th><th>Folder</th><th>Terms</th><th>Files</th></tr>';
      for (let i = 0; i < folderM.length; i++) {
        const m = folderM[i];
        html += `<tr><td class="muted"><span class="ms-toggle" title="Show evidence">▶</span>${i + 1}</td><td class="mono">`
          + escHtml(m.folder + '/')
          + matchedBadge(m) + idfBadge(m) + missingBadge(m) + verifyBadge(m)
          + `</td><td>${m.terms_matched}/${nPos}</td><td>${m.files_involved}</td></tr>`;
        html += `<tr class="ms-detail-row collapsed"><td colspan="4">${_renderEvidence(m, terms, notSet, 'folder')}</td></tr>`;
      }
      html += '</table>';
    }
    html += '</div>';
  }

  return html;
}

// Compact a sorted unique array of integers into ranges: [1,2,3,5,7,8] -> "1-3,5,7-8"
function _compactRanges(nums) {
  if (!nums.length) return '';
  const parts = [];
  let s = nums[0], e = nums[0];
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === e + 1) { e = nums[i]; continue; }
    parts.push(s === e ? `${s}` : `${s}-${e}`);
    s = e = nums[i];
  }
  parts.push(s === e ? `${s}` : `${s}-${e}`);
  return parts.join(',');
}

export function renderMultisectResults(data) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const fmCount = (data.function_matches || []).length;
  const cmCount = (data.class_matches || []).length;
  const fileCount = (data.file_matches || []).length;
  const folderCount = (data.folder_matches || []).length;
  // True totals from the server (function_total etc.) vs. the capped arrays —
  // show shown/total per scope so a cap can't masquerade as "all hits"
  // (e.g. "30/46 fn"). This is the bug where a #46 match silently vanished.
  const fmTot = data.function_total ?? fmCount, cmTot = data.class_total ?? cmCount;
  const fileTot = data.file_total ?? fileCount, folderTot = data.folder_total ?? folderCount;
  const lab = (shown, tot) => shown < tot ? `${shown}/${tot}` : `${shown}`;
  const capped = fmCount < fmTot || cmCount < cmTot || fileCount < fileTot || folderCount < folderTot;
  title.textContent = `Multisect (${lab(fmCount, fmTot)} fn / ${lab(cmCount, cmTot)} cls / `
    + `${lab(fileCount, fileTot)} file / ${lab(folderCount, folderTot)} folder)`
    + (capped ? ' — CAPPED' : '');

  const termsDiv = $('#workspace-terms');
  termsDiv.innerHTML = '';
  for (const t of (data.terms || [])) {
    termsDiv.appendChild(h('span', { className: `term-chip${t.negated ? ' negated' : ''}`, text: t.display }));
  }

  const positiveTerms = (data.terms || []).filter(t => !t.negated).map(t => t.display);
  state.highlightTerms = { terms: positiveTerms, colors: HIGHLIGHT_COLORS };

  container.innerHTML = _renderScopeViews(data, { showLegend: true });
  _wireClickables(container, { sourceOnly: true });
  _wireMultisectToggles(container);
}
