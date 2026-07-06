/**
 * list-renderers.js — Left-pane structural list renderers
 * (Functions, Files, Classes, Vocabulary, File Map, Dupes,
 * Surprising Funcstrings, etc.) plus the middle-top detail
 * renderers wired to per-row clicks (Surprising Group Detail,
 * Dupe Detail). The text/catalog accordions (LLM Prompts,
 * Breadcrumbs, Bundle Seams, Command Catalog, Struct Diffs) live
 * in prompts-and-catalog.js instead.
 *
 * Each list renderer follows the shape `renderXxxList(container,
 * data, ...)` and is dispatched from `loadSectionData` in app.js.
 *
 * Cross-cutting callbacks (`wireClickables`, `loadSectionData`,
 * `updateOverflowHint`) are injected via `initListRenderers({...})`
 * since their owners still live in app.js (wireClickables in its own
 * section, loadSectionData/updateOverflowHint in the Accordion
 * section). They become direct imports when those sections become
 * their own peels.
 */

import { state } from './state.js';
import { api } from './api.js';
import {
  $, $$, h, escHtml, displayNameHtml, shortPath, funcOrFileLabel, makeDraggable, makeResizable, commonPathPrefix,
} from './dom-utils.js';
import { showPane } from './layout.js';
import {
  onFunctionClick, onFileClick, onClassClick, onVocabClick,
} from './click-handlers.js';
import { showContextMenu } from './context-menu.js';
import { renderMermaid } from './mermaid.js';
import { showMiddleTopError, showMiddleTopLoading, renderFilesByExtension, clearAllPanes, navPush } from './middle-pane.js';
import { renderStringDetail } from './prompts-and-catalog.js';
import { openCompareView } from './overlays.js';
import { showConfirmDialog } from './dialogs.js';


// ============================================================================
// Cross-cutting callbacks (injected by initListRenderers)
// ============================================================================

let _wireClickables = () => {};
let _loadSectionData = async () => {};
let _updateOverflowHint = () => {};

export function initListRenderers(deps = {}) {
  if (typeof deps.wireClickables === 'function') _wireClickables = deps.wireClickables;
  if (typeof deps.loadSectionData === 'function') _loadSectionData = deps.loadSectionData;
  if (typeof deps.updateOverflowHint === 'function') _updateOverflowHint = deps.updateOverflowHint;
}

// #132: read the View-menu "Exclude Tests" checkbox live at render time, so
// toggling just re-renders — no state plumbing. (The GUI form of --no-tests.)
const hideTests = () => !!document.getElementById('opt-exclude-tests')?.checked;


// ============================================================================
// List renderers — shared function-like list (hotspots, entry-points, domain-fns, gaps)
// ============================================================================

export function renderFuncLikeList(container, items, metricKey) {
  container.innerHTML = '';
  if (!items.length) { container.innerHTML = '<div class="list-placeholder">None found</div>'; return; }
  for (const f of items) {
    const metricVal = metricKey === 'score' ? f.score : f.lines;
    const item = h('div', { className: 'list-item', title: `${f.filepath}\n${f.display_name || f.name}\n${metricKey}: ${metricVal}` }, [
      f.rank != null ? h('span', { className: 'rank', text: `${f.rank}` }) : null,
      h('span', { className: 'metric', text: `${metricVal}` }),
      h('span', { className: 'name clickable', html: displayNameHtml(funcOrFileLabel(f.display_name || f.name, f.filepath)) }),
      h('span', { className: 'metric muted', text: `${f.lines || ''}L` }),
    ].filter(Boolean));
    item.addEventListener('click', () => onFunctionClick(f));
    item.addEventListener('contextmenu', (e) => showContextMenu(e, f));
    container.appendChild(item);
  }
}


// ============================================================================
// Functions list
// ============================================================================

export function renderFunctionList(container, functions, total) {
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


// ============================================================================
// Files list — with sub-accordion to show functions in each file
// ============================================================================

export function renderFileListWithSub(container, files, total) {
  container.innerHTML = '';
  if (!files.length) { container.innerHTML = '<div class="list-placeholder">No files found</div>'; return; }

  for (const fp of files) {
    const name = fp.replace(/\\/g, '/').split('/').pop();
    const dir = fp.replace(/\\/g, '/').split('/').slice(0, -1).join('/');

    const subContent = h('div', { className: 'sub-accordion-content' });
    const nameSpan = h('span', { className: 'name clickable', text: name, style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' });
    const subHeader = h('div', { className: 'sub-accordion-header' }, [
      h('span', { className: 'sub-accordion-toggle', text: '▸' }),
      nameSpan,
      h('span', { className: 'filepath', text: dir, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
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
      if (parentSection) setTimeout(() => _updateOverflowHint(parentSection), 50);
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

export async function loadFileFunctions(filepath, container) {
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


// ============================================================================
// Extensions list
// ============================================================================

export function renderExtensionList(container, extensions, totalFiles, filter, skipped) {
  container.innerHTML = '';
  if (!extensions || !extensions.length) { container.innerHTML = '<div class="list-placeholder">No extensions found</div>'; return; }

  const pat = filter ? filter.toLowerCase() : null;
  const filtered = pat ? extensions.filter(e => e.ext.toLowerCase().includes(pat)) : extensions;

  for (const e of filtered) {
    const item = h('div', { className: 'list-item clickable', title: `${e.count} files (${e.pct}% of ${totalFiles}) — click to list` }, [
      h('span', { className: 'metric', text: `${e.count}`, style: 'min-width:32px' }),
      h('span', { className: 'name', text: e.ext, style: 'color:var(--text-bright);font-family:var(--font-mono)' }),
      h('span', { className: 'metric muted', text: `${e.pct}%`, style: 'min-width:36px;text-align:right' }),
    ]);
    // #191: click → list this extension's files in the upper-middle pane (incl.
    // the (none)/no-extension bucket), each file clickable + right-clickable.
    item.addEventListener('click', async () => {
      showMiddleTopLoading(`Listing ${e.ext} files…`);
      try {
        const data = await api.filesByExtension({ ext: e.ext });
        renderFilesByExtension(e.ext, data);
      } catch (err) { showMiddleTopError(`Could not list ${e.ext} files: ${err.message}`); }
    });
    container.appendChild(item);
  }

  // #191: "present in source but not indexed" — mirrors the --build-index
  // skip-tip. Text extensions are actionable (rebuild with --add-extensions);
  // media/binary are mentioned for awareness only.
  if (skipped && ((skipped.text && skipped.text.length) || (skipped.media && skipped.media.length))) {
    container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal;text-align:left;margin-top:8px;font-weight:600;color:var(--accent-blue)', text: 'Not indexed (present in source):' }));
    if (skipped.text && skipped.text.length) {
      container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal;text-align:left', text: `text: ${skipped.text.map(t => `${t.ext} (${t.count})`).join(', ')}` }));
      if (skipped.addList) container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal;text-align:left;color:var(--text-muted)', text: `→ rebuild with --add-extensions ${skipped.addList} to include them` }));
    }
    if (skipped.media && skipped.media.length) {
      container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal;text-align:left;color:var(--text-muted)', text: `media/binary (skipped by design): ${skipped.media.map(t => `${t.ext} (${t.count})`).join(', ')}` }));
    }
  }
}


// ============================================================================
// Classes list — with sub-accordion to show methods inline
// ============================================================================

// #194: Data Structures — struct/enum/union/typedef/trait/interface/record,
// ONE row per unique type, ranked by file spread then reference count (header
// states the basis, per the issue's ranking-transparency note). Single-site
// rows click straight to the definition; multi-site rows drill into the
// definition-site list in the upper-middle pane (same accordion → instances →
// per-file pattern the Referenced Resources drill uses).
export function renderDataStructuresList(container, structs, total) {
  container.innerHTML = '';
  if (!structs || !structs.length) { container.innerHTML = '<div class="list-placeholder">No data structures found</div>'; return; }
  container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal;text-align:left;color:var(--text-muted)', text: `${total} unique data structures — ranked by file spread, then references. N× = defined in N files; right column = references.` }));
  for (const s of structs) {
    const multi = !!(s.instances && s.instances.length > 1);
    const spans = [
      h('span', { className: 'rank', text: s.kind, style: 'min-width:62px;text-align:left;color:var(--accent-dim);font-family:var(--font-mono);font-size:10px' }),
      h('span', { className: 'name clickable', text: s.name }),
    ];
    // Two metrics, consistent units: the file-spread badge (only when >1, the
    // drill affordance) and the reference count on every row — mixing them in
    // one unlabeled column read as two different lists.
    if (multi) spans.push(h('span', { className: 'metric', text: `${s.fileCount}×`, style: 'color:var(--accent-blue);min-width:32px;text-align:right' }));
    spans.push(h('span', { className: 'metric muted', text: `${s.refs}` }));
    const item = h('div', { className: 'list-item', title:
      `${s.kind} ${s.name} — ${s.refs} references — defined in ${s.fileCount || 1} file${(s.fileCount || 1) !== 1 ? 's' : ''}\n` +
      (multi ? 'Click to list definition sites' : `${s.filepath}:${s.line}`) }, spans);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      // Always refresh the sites pane so the upper-middle pane reflects the
      // LAST click (a stale sites list from an earlier struct read as if it
      // belonged to this one). Single-site structs also open the code directly.
      renderDataStructInstances(s);
      if (!multi) onFileClick(s.filepath, s.line);
    });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: s.name, display_name: s.name, filepath: s.filepath, kind: 'data-structure' }); });
    container.appendChild(item);
  }
}

// Drill-down for a multi-site data structure: list every definition site in
// the upper-middle pane; each row jumps to that occurrence in the lower pane.
function renderDataStructInstances(s) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  if (!container) return;
  showPane('middle-top'); navPush('middle-top');
  if (title) title.textContent = `${s.kind} ${s.name} — ${s.instances.length} definition site${s.instances.length !== 1 ? 's' : ''}`;
  container.innerHTML = '';
  const wrap = h('div', { className: 'output-section' });
  for (const inst of s.instances) {
    const row = h('div', { className: 'list-item', style: 'display:block;height:auto;padding:3px 8px;cursor:pointer;white-space:normal', title: `${inst.filepath}:${inst.line}` });
    row.appendChild(h('div', { text: `${shortPath(inst.filepath)}:${inst.line}`, style: 'font-family:var(--font-mono);font-size:11px;color:var(--text-bright)' }));
    row.addEventListener('click', () => onFileClick(inst.filepath, inst.line));
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

// #203 drill-down: list every captured site for one referenced resource in the
// top-middle pane (each row jumps to source in the lower pane). Fires when a
// resource row with >1 site is clicked, so a count >1 isn't a dead end.
function renderReferencedResourceSites(label, sites) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  if (!container) return;
  showPane('middle-top'); navPush('middle-top');
  if (title) title.textContent = `${label} — ${sites.length} site${sites.length !== 1 ? 's' : ''}`;
  container.innerHTML = '';
  const wrap = h('div', { className: 'output-section' });
  for (const s of sites) {
    const loc = `${shortPath(s.filepath)}:${s.line}`;
    // Force block layout + explicit styles so the row doesn't inherit the
    // .list-item/.name flex+overflow rules (which collapsed the column layout to
    // zero height). The source line wraps fully so per-site specifics (e.g. the
    // full `spawn('git', ['status','--porcelain'])`) are visible without clicking.
    const row = h('div', { className: 'list-item', style: 'display:block;height:auto;padding:3px 8px;cursor:pointer;white-space:normal', title: `${s.filepath}:${s.line}` });
    if (s.snippet) row.appendChild(h('div', { text: s.snippet, style: 'font-family:var(--font-mono);font-size:11px;white-space:pre-wrap;word-break:break-all;color:var(--text-bright)' }));
    row.appendChild(h('div', { text: loc, style: 'font-size:10px;color:var(--text-muted)' }));
    row.addEventListener('click', () => onFileClick(s.filepath, s.line));
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

// #203: Referenced Resources — the codebase's EXTERNAL surface (URLs/hosts, env
// vars, filesystem paths, embedded SQL, external commands, cloud/infra, models).
// Rendered as collapsible sub-accordions so the small, uniquely-valuable
// categories (env / SQL / commands) aren't buried under the big duplicative
// ones (URLs / filesystem). Small sections auto-expand; large ones collapse
// with a count. Filesystem is split into named files vs extension-less
// paths/route-fragments. Rows jump to source; right-click → Find Uses.
export function renderReferencedResourcesList(container, data) {
  container.innerHTML = '';
  const d = data || {};
  const fs = d.filesystem || [];
  const fsFiles = fs.filter(e => e.kind === 'file');
  const fsPaths = fs.filter(e => e.kind !== 'file');

  // Ordered so the small/unique categories come first; big duplicative ones last.
  const cats = [
    { title: 'Environment variables', arr: d.env || [], render: 'value' },
    { title: 'Embedded SQL', arr: d.sql || [], render: 'value' },
    { title: 'External commands', arr: d.subprocess || [], render: 'value' },
    { title: 'Cloud / infra', arr: d.cloud || [], render: 'cloud' },
    { title: 'Models', arr: d.models || [], render: 'model' },
    { title: 'Filesystem — files', arr: fsFiles, render: 'value' },
    { title: 'Network (URLs)', arr: d.network || [], render: 'network' },
    { title: 'Filesystem — paths / routes', arr: fsPaths, render: 'value' },
  ];
  if (!cats.some(c => c.arr.length)) { container.innerHTML = '<div class="list-placeholder">No referenced resources found</div>'; return; }

  container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal;text-align:left;color:var(--text-muted)', text: 'The codebase’s external surface — what it points to but doesn’t contain. Click a section to expand; counts are reference counts.' }));

  const addRow = (parent, label, { sub, count, sites, ctxName } = {}) => {
    const first = (sites && sites[0]) || null;
    const kids = [h('span', { className: 'name clickable', text: label, style: 'font-family:var(--font-mono);font-size:11px;word-break:break-all' })];
    if (sub) kids.push(h('span', { className: 'filepath', text: sub }));
    if (count != null) kids.push(h('span', { className: 'metric muted', text: `${count}×` }));
    const item = h('div', { className: 'list-item', title: first ? `${first.filepath}:${first.line}` : label }, kids);
    if (first) {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        // Multi-site: list every captured site in the top-middle pane (so a
        // count >1 isn't a dead end), then open the first in the lower pane.
        if (sites.length > 1) renderReferencedResourceSites(label, sites);
        onFileClick(first.filepath, first.line);
      });
      item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: ctxName || label, display_name: label, filepath: first.filepath }); });
    }
    parent.appendChild(item);
  };

  const rowFor = (parent, c, e) => {
    if (c.render === 'network') addRow(parent, e.value, { sub: e.host, count: e.count, sites: e.sites, ctxName: e.value });
    else if (c.render === 'cloud') addRow(parent, `${e.cell}: ${e.kind}${e.tag === 'heuristic' ? ' ~' : ''}`, { count: e.count, sites: e.sites });
    else if (c.render === 'model') addRow(parent, e.model, { sub: e.access, count: e.count }); // models carry no site
    else addRow(parent, e.value, { count: e.count, sites: e.sites, ctxName: e.value });
  };

  // All sub-sections start collapsed (uniform — a mixed open/closed state read as
  // surprising). Counts in each header + the hint above make it a scannable menu.
  for (const c of cats) {
    if (!c.arr.length) continue;
    const toggle = h('span', { className: 'accordion-toggle', text: '▸', style: 'margin-right:5px' });
    const hdr = h('div', { className: 'list-item', style: 'cursor:pointer;font-weight:600;font-size:11px;color:var(--accent-blue);margin-top:6px' }, [
      toggle, h('span', { text: c.title }), h('span', { className: 'metric muted', text: `${c.arr.length}`, style: 'margin-left:auto' }),
    ]);
    const body = h('div', { style: 'display:none' });
    for (const e of c.arr) rowFor(body, c, e);
    hdr.addEventListener('click', () => {
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      toggle.textContent = hidden ? '▾' : '▸';
    });
    container.appendChild(hdr);
    container.appendChild(body);
  }
}

// #197: Client/Server — server routes declared, client calls made, and the
// reconciliation (internal client calls with no matching server route). Each
// row jumps to its source line; right-click → Find Uses on the path/url.
export function renderClientServerList(container, data) {
  container.innerHTML = '';
  const { server = [], client = [], unmatched = [], sockets = [], rpc = [], ipc = [], stats = {} } = data || {};
  if (!server.length && !client.length && !sockets.length && !rpc.length && !ipc.length) {
    container.innerHTML = '<div class="list-placeholder">No client/server surface found</div>';
    return;
  }

  // Compact header / note helpers. NOT the bare `.list-placeholder` (which is
  // styled for whole-pane empty states — centered + tall) — using it inline
  // ballooned empty sections into screens of whitespace (#201 iterate). These
  // are tight, left-aligned, single-line.
  const sectionLabel = (text, style = '') =>
    h('div', { style: `white-space:normal;text-align:left;font-weight:600;font-size:11px;margin-top:8px;padding:2px 10px;${style}`, text });
  const note = (text, style = '') =>
    h('div', { style: `white-space:normal;text-align:left;font-size:11px;padding:1px 10px;color:var(--text-muted);${style}`, text });

  // Peel a dominant path prefix once into a header (the .WinAPI_Classic case:
  // every row began with the same long zip!…/Win7Samples/ prefix). Appends the
  // header note immediately and returns a strip(fp) the row rendering uses; the
  // few paths that don't share the prefix keep their full path ("otherwise
  // indicated"). #path-prefix-peel.
  const peelHeader = (paths) => {
    const { prefix, covered, total } = commonPathPrefix(paths);
    if (!prefix) return (fp) => String(fp).replace(/\\/g, '/');
    container.appendChild(note(covered === total
      ? `Paths under: ${prefix}`
      : `Unless otherwise indicated, all paths begin with ${prefix}`, 'font-style:italic'));
    return (fp) => { const n = String(fp).replace(/\\/g, '/'); return n.startsWith(prefix) ? n.slice(prefix.length) : n; };
  };

  // --- Server routes — CONSOLIDATED by path (#201 iterate) ---
  // Like the socket file rows show their api sequence (bind·listen·accept), a
  // route path shows its METHOD SET — the resource's REST verb surface
  // (GET·POST·DELETE) — instead of one row per method. Multi-declaration paths
  // drill into the per-method/per-file declarations in the upper-middle pane.
  if (server.length) {
    const byPath = new Map();
    for (const s of server) { if (!byPath.has(s.path)) byPath.set(s.path, []); byPath.get(s.path).push(s); }
    const paths = [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    container.appendChild(sectionLabel(`Server routes (${paths.length} path${paths.length !== 1 ? 's' : ''}, ${server.length} decl${server.length !== 1 ? 's' : ''})`, 'color:var(--accent-blue)'));
    for (const [routePath, routes] of paths) {
      const methods = [...new Set(routes.flatMap(r => String(r.method).split('|')))].join('·');
      const fw = [...new Set(routes.map(r => r.framework))].join(',');
      const item = h('div', { className: 'list-item', title: `${routePath}\n${methods}  [${fw}]\n${routes.length} declaration(s)` }, [
        h('span', { className: 'rank', text: methods, style: 'min-width:120px;text-align:left;color:var(--accent-dim);font-family:var(--font-mono);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
        h('span', { className: 'name clickable', text: routePath, style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis' }),
        h('span', { className: 'metric muted', text: fw, style: 'font-size:10px' }),
      ]);
      if (routes.length > 1) {
        item.addEventListener('click', (e) => { e.stopPropagation(); renderServerRouteInstances(routePath, routes); });
      } else {
        item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(routes[0].filepath, routes[0].line); });
      }
      item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: routePath, display_name: routePath, filepath: routes[0].filepath, kind: 'data-structure' }); });
      container.appendChild(item);
    }
  }

  // --- Client calls — CONSOLIDATED (#197 iterate), omitted when empty ---
  // De-dupe the per-call-site dump into one row per endpoint: internal calls
  // group by path, external calls group by domain. Each row carries a call
  // count and drills into its specific instances (file:line) in the upper-
  // middle pane, the #191 pattern. Unmatched paths render in warn color inline.
  const unmatchedPaths = new Set(unmatched.map(u => u.pathOnly));
  const groups = new Map();  // key → { label, kind, external, instances: [] }
  for (const c of client) {
    let key, label, kind;
    if (c.external) { key = 'ext:' + (_domainOf(c.url) || c.url); label = _domainOf(c.url) || c.url; kind = 'external'; }
    else if (c.internal && c.pathOnly) { key = 'int:' + c.pathOnly; label = c.pathOnly; kind = 'internal'; }
    else { key = 'other:' + c.url; label = c.url; kind = 'other'; }
    if (!groups.has(key)) groups.set(key, { label, kind, external: c.external, instances: [] });
    groups.get(key).instances.push(c);
  }
  const groupArr = [...groups.values()].sort((a, b) =>
    (a.kind === b.kind ? 0 : a.kind === 'internal' ? -1 : 1) || b.instances.length - a.instances.length || a.label.localeCompare(b.label));

  if (groupArr.length) {
    container.appendChild(sectionLabel(`Client endpoints — by target (${groupArr.length} distinct, ${stats.clientCount ?? client.length} calls)`, 'color:var(--accent-blue)'));
    for (const g of groupArr) {
      const isUnmatched = g.kind === 'internal' && unmatchedPaths.has(g.label);
      const tag = g.external ? 'external' : (isUnmatched ? 'no server' : '');
      // Method set — the client-side verb pipeline on this endpoint (GET·POST),
      // the parallel to the socket api sequence and the server method set.
      const methods = [...new Set(g.instances.flatMap(c => String(c.method || 'ANY').split('|')))].join('·');
      const item = h('div', { className: 'list-item', title: `${g.label} — ${methods} — ${g.instances.length} call site(s)${tag ? ' — ' + tag : ''}\nClick to list instances` }, [
        h('span', { className: 'name clickable', text: g.label, style: `flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;${isUnmatched ? 'color:var(--warn,#e0a030)' : ''}` }),
        h('span', { className: 'metric muted', text: methods, style: 'font-size:10px;color:var(--accent-dim);max-width:130px;overflow:hidden;text-overflow:ellipsis' }),
        tag ? h('span', { className: 'metric muted', text: tag, style: 'font-size:10px' }) : null,
        h('span', { className: 'metric muted', text: `${g.instances.length}×`, style: 'min-width:32px;text-align:right' }),
      ].filter(Boolean));
      item.addEventListener('click', (e) => { e.stopPropagation(); renderHttpInstances(g.label, g.instances); });
      item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: g.label, display_name: g.label, filepath: g.instances[0]?.filepath, kind: 'data-structure' }); });
      container.appendChild(item);
    }
  }

  // --- Client calls — by SOURCE FILE (#201 iterate) ---
  // The same client calls, organized by the file that makes them. Unlike a
  // server (which just declares many independent routes), a client *uses*
  // services in sequence — so a file's calls in line order read as a
  // pipeline, the way the socket file rows do. This complements the
  // by-target view above; both are shown so each lens is available.
  if (client.length) {
    const byFile = new Map();
    for (const c of client) { if (!byFile.has(c.filepath)) byFile.set(c.filepath, []); byFile.get(c.filepath).push(c); }
    const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    container.appendChild(sectionLabel(`Client calls — by source file (${files.length} file${files.length !== 1 ? 's' : ''})`, 'color:var(--accent-blue);margin-top:10px'));
    const stripCf = peelHeader(files.map(([fp]) => fp));
    const SEG_CAP = 6;
    for (const [fp, calls] of files) {
      // #201 iterate: summarize by the ENDPOINTS this file hits (the services
      // it consumes), not the HTTP method set — the distinct last path segments
      // (`ideas·queue·leaderboard·…`), the client analog of the socket api
      // pipeline. Full targets remain in the source-order drill.
      const segs = [...new Set(calls.map(_endpointSeg))];
      const summary = segs.slice(0, SEG_CAP).join('·') + (segs.length > SEG_CAP ? ` (+${segs.length - SEG_CAP})` : '');
      const item = h('div', { className: 'list-item', title: `${fp.replace(/\\/g, '/')}\nendpoints: ${segs.join(', ')}\n${calls.length} call(s) to ${segs.length} endpoint(s)\nClick to list calls in source order` }, [
        h('span', { className: 'name clickable', text: stripCf(fp), style: 'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;font-family:var(--font-mono);font-size:11px' }),
        h('span', { className: 'metric muted', text: summary, style: 'font-size:10px;color:var(--accent-dim);flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;text-align:left' }),
        h('span', { className: 'metric muted', text: `${calls.length}×`, style: 'min-width:30px;text-align:right' }),
      ]);
      item.addEventListener('click', (e) => { e.stopPropagation(); renderHttpFileCalls(fp, calls); });
      container.appendChild(item);
    }
  }

  // --- Reconciliation: the distinctive signal — only meaningful with calls ---
  if (client.length) {
    const unmatchedByPath = new Map();
    for (const c of client) {
      if (!c.internal || !c.pathOnly || !unmatchedPaths.has(c.pathOnly)) continue;
      if (!unmatchedByPath.has(c.pathOnly)) unmatchedByPath.set(c.pathOnly, []);
      unmatchedByPath.get(c.pathOnly).push(c);
    }
    if (unmatchedByPath.size) {
      container.appendChild(sectionLabel(`No matching server route (${unmatchedByPath.size})`, 'color:var(--warn,#e0a030)'));
      for (const [path, insts] of [...unmatchedByPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const item = h('div', { className: 'list-item', title: `${path} — ${insts.length} call site(s)\nClick to list instances` }, [
          h('span', { className: 'name clickable', text: path, style: 'color:var(--warn,#e0a030)' }),
          h('span', { className: 'metric muted', text: `${insts.length}×`, style: 'min-width:32px;text-align:right' }),
        ]);
        item.addEventListener('click', (e) => { e.stopPropagation(); renderHttpInstances(path, insts); });
        container.appendChild(item);
      }
      container.appendChild(note('Heuristic (path-only match) — a "missing" route may be served by an undetected framework/proxy or an external service.'));
    } else {
      container.appendChild(note('All client calls map to a detected server route.'));
    }
  }

  // --- Non-HTTP transports (Socket/TLS, RPC, IPC) — #201 Part B ---
  // Each consolidated by file per role (a raw dump repeats the same api across
  // hundreds of call sites — .spinellis had 457 sockets). One row per file per
  // role: apis used + count; drill → that file's call sites. Empty transports
  // are omitted; a one-end-only note flags a missing side.
  const appendTransport = (label, entries) => {
    if (!entries.length) return;
    const cl = entries.filter(e => e.role === 'client');
    const sv = entries.filter(e => e.role === 'server');
    const filesOf = (list) => new Set(list.map(e => e.filepath)).size;
    container.appendChild(sectionLabel(`${label} (${entries.length}) — ${filesOf(cl)} client, ${filesOf(sv)} server file(s)`, 'color:var(--accent-blue);margin-top:10px'));
    const strip = peelHeader(entries.map(e => e.filepath));
    for (const [role, list] of [['client', cl], ['server', sv]]) {
      if (!list.length) continue;
      const byFile = new Map();
      for (const e of list) { if (!byFile.has(e.filepath)) byFile.set(e.filepath, []); byFile.get(e.filepath).push(e); }
      const files = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
      container.appendChild(note(`${role} (${files.length} file${files.length !== 1 ? 's' : ''}, ${list.length} call${list.length !== 1 ? 's' : ''})`));
      for (const [fp, insts] of files) {
        const apis = [...new Set(insts.map(e => e.api))].join('·');
        const tls = insts.some(e => e.tls);
        const item = h('div', { className: 'list-item', title: `${fp.replace(/\\/g, '/')}\n${apis} — ${insts.length} call site(s)${tls ? ' (TLS)' : ''}\nClick to list call sites` }, [
          h('span', { className: 'name clickable', text: strip(fp), style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;font-family:var(--font-mono);font-size:11px' }),
          h('span', { className: 'metric muted', text: apis + (tls ? '·TLS' : ''), style: 'font-size:10px;max-width:170px;overflow:hidden;text-overflow:ellipsis' }),
          h('span', { className: 'metric muted', text: `${insts.length}×`, style: 'min-width:30px;text-align:right' }),
        ]);
        item.addEventListener('click', (ev) => { ev.stopPropagation(); renderSocketInstances(fp, insts); });
        container.appendChild(item);
      }
    }
    // Note scopes the transport in BOTH clauses — "no client side" alone read
    // as global when another transport (e.g. RPC) did have a client side (#201).
    if (cl.length && !sv.length) container.appendChild(note(`${label}: client side only — no ${label} server side in this index.`, 'color:var(--warn,#e0a030)'));
    else if (sv.length && !cl.length) container.appendChild(note(`${label}: server side only — no ${label} client side in this index.`, 'color:var(--warn,#e0a030)'));
  };
  appendTransport('Socket / TLS', sockets);
  appendTransport('RPC', rpc);
  appendTransport('IPC', ipc);
}

// Domain (host) of an absolute URL, else null.
function _domainOf(url) {
  const m = /^https?:\/\/([^/]+)/i.exec(url);
  return m ? m[1] : null;
}

// The last meaningful (static) path segment of a client call's endpoint — the
// service name a file consumes. Drops dynamic segments (:id, {id}, <id>,
// ${...}); falls back to the domain for a bare host, or '(root)'. #201 iterate.
function _endpointSeg(c) {
  const p = (c.pathOnly || c.url || '').replace(/^https?:\/\/[^/]+/i, '');
  const segs = p.split(/[/?#]/).filter(Boolean).filter(s => !/^[:{<]|[}>]$|\$\{/.test(s));
  return segs.length ? segs[segs.length - 1] : (_domainOf(c.url) || '(root)');
}

// #197 drill-down: the specific calls for a consolidated client endpoint, in
// the upper-middle pane (mirrors the Extensions #191 drill-down). Consolidated
// a second time by DISTINCT URL — drilling a busy domain (e.g. github.com)
// otherwise repeated the same URL across dozens of call sites. One row per
// distinct URL + a call-site count; a multi-site URL expands inline to its
// specific file:line locations. Single-site URLs jump straight to source.
// Instances carry { method, url, kind, filepath, line }.
export function renderHttpInstances(label, instances) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  showPane('middle-top'); navPush('middle-top');

  const byUrl = new Map();
  for (const c of instances) {
    if (!byUrl.has(c.url)) byUrl.set(c.url, []);
    byUrl.get(c.url).push(c);
  }
  const urls = [...byUrl.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  title.textContent = `${label} — ${urls.length} distinct URL${urls.length !== 1 ? 's' : ''}, ${instances.length} call site${instances.length !== 1 ? 's' : ''}`;
  container.innerHTML = '';
  const wrap = h('div', { className: 'output-section' });

  for (const [url, sites] of urls) {
    const multi = sites.length > 1;
    const name = sites.find(s => s.name)?.name;  // the const/identifier, if any
    const toggle = h('span', { className: 'sub-accordion-toggle', text: multi ? '▸' : '', style: 'margin-right:4px;font-size:10px;width:10px;display:inline-block' });
    const row = h('div', { className: 'list-item', title: `${url}${name ? ` (via ${name})` : ''}\n${sites.length} call site${sites.length !== 1 ? 's' : ''}` }, [
      toggle,
      h('span', { className: 'rank', text: sites[0].method, style: 'min-width:54px;text-align:left;color:var(--accent-dim);font-family:var(--font-mono);font-size:10px' }),
      h('span', { className: 'name clickable', text: name ? `${url}  (${name})` : url, style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric muted', text: `${sites.length}×`, style: 'min-width:32px;text-align:right' }),
    ]);
    const sub = h('div', { style: 'display:none' });
    if (multi) {
      for (const c of sites) {
        const loc = h('div', { className: 'list-item', style: 'padding-left:28px', title: `${c.filepath}:${c.line}` }, [
          h('span', { className: 'name clickable', text: `${shortPath(c.filepath, 40)}:${c.line}`, style: 'font-family:var(--font-mono);font-size:10px;flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis' }),
          h('span', { className: 'metric muted', text: c.kind, style: 'font-size:10px' }),
        ]);
        loc.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(c.filepath, c.line); });
        sub.appendChild(loc);
      }
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = sub.style.display !== 'none';
        sub.style.display = open ? 'none' : 'block';
        toggle.textContent = open ? '▸' : '▾';
      });
    } else {
      row.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(sites[0].filepath, sites[0].line); });
    }
    wrap.appendChild(row);
    wrap.appendChild(sub);
  }
  container.appendChild(wrap);
}

// #201 drill-down: one file's HTTP client calls in SOURCE ORDER (the pipeline
// the client runs), in the upper-middle pane. Title is the full path; rows are
// method · url · :line. Calls carry { method, url, kind, filepath, line }.
export function renderHttpFileCalls(label, calls) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  showPane('middle-top'); navPush('middle-top');
  const sorted = [...calls].sort((a, b) => a.line - b.line);
  title.textContent = `${label.replace(/\\/g, '/')} — ${sorted.length} HTTP call${sorted.length !== 1 ? 's' : ''} (in source order)`;
  container.innerHTML = '';
  const wrap = h('div', { className: 'output-section' });
  for (const c of sorted) {
    const label = c.name ? `${c.url}  (${c.name})` : c.url;
    const row = h('div', { className: 'list-item', title: `${c.method} ${c.url} (${c.kind})${c.name ? ` via ${c.name}` : ''}\n${c.filepath}:${c.line}` }, [
      h('span', { className: 'rank', text: c.method, style: 'min-width:54px;text-align:left;color:var(--accent-dim);font-family:var(--font-mono);font-size:11px' }),
      h('span', { className: 'name clickable', text: label, style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric muted', text: `:${c.line}`, style: 'font-family:var(--font-mono);font-size:11px' }),
    ]);
    row.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(c.filepath, c.line); });
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

// #201 drill-down: the socket/TLS call sites for one file, in the upper-middle
// pane. Title is the FULL path (the left pane truncates it); rows are api +
// optional detail (RPC service/method, IPC pipe path) + line, each jumping to
// source. Serves all non-HTTP transports: { api, role, tls?, detail?, lang,
// filepath, line }.
export function renderSocketInstances(label, instances) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  showPane('middle-top'); navPush('middle-top');
  const sorted = [...instances].sort((a, b) => a.line - b.line);
  const kind = sorted[0]?.transport === 'rpc' ? 'RPC' : sorted[0]?.transport === 'ipc' ? 'IPC' : 'socket';
  title.textContent = `${label.replace(/\\/g, '/')} — ${sorted.length} ${kind} call${sorted.length !== 1 ? 's' : ''}`;
  container.innerHTML = '';
  const wrap = h('div', { className: 'output-section' });
  for (const s of sorted) {
    const detail = [s.role, s.detail, s.tls ? 'TLS' : null].filter(Boolean).join(' · ');
    const row = h('div', { className: 'list-item', title: `${s.api} (${detail})\n${s.filepath}:${s.line}` }, [
      h('span', { className: 'rank', text: s.api, style: 'min-width:120px;text-align:left;color:var(--accent-dim);font-family:var(--font-mono);font-size:11px' }),
      h('span', { className: 'name clickable', text: detail, style: 'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric muted', text: `:${s.line}`, style: 'font-family:var(--font-mono);font-size:11px' }),
    ]);
    row.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(s.filepath, s.line); });
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

// #201 drill-down: the per-method/per-file declarations of one route path, in
// the upper-middle pane (parallels the socket call-site drill). Each row jumps
// to source. Routes carry { method, path, framework, filepath, line }.
export function renderServerRouteInstances(label, routes) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  showPane('middle-top'); navPush('middle-top');
  const sorted = [...routes].sort((a, b) => a.filepath.localeCompare(b.filepath) || a.line - b.line);
  title.textContent = `${label} — ${sorted.length} declaration${sorted.length !== 1 ? 's' : ''}`;
  container.innerHTML = '';
  const wrap = h('div', { className: 'output-section' });
  for (const r of sorted) {
    const row = h('div', { className: 'list-item', title: `${r.method} ${r.path} [${r.framework}]\n${r.filepath}:${r.line}` }, [
      h('span', { className: 'rank', text: r.method, style: 'min-width:80px;text-align:left;color:var(--accent-dim);font-family:var(--font-mono);font-size:11px' }),
      h('span', { className: 'name clickable', text: `${shortPath(r.filepath, 40)}:${r.line}`, style: 'flex:2 1 0;min-width:0;font-family:var(--font-mono);font-size:11px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric muted', text: r.framework, style: 'font-size:10px' }),
    ]);
    row.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(r.filepath, r.line); });
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

export function renderClassListWithSub(container, classes, total) {
  container.innerHTML = '';
  if (!classes || !classes.length) { container.innerHTML = '<div class="list-placeholder">No classes found</div>'; return; }

  for (const c of classes) {
    const subContent = h('div', { className: 'sub-accordion-content' });
    // #198: the name is its own click target — jumps to the class's
    // definition line in source (onFileClick with the class `start`),
    // rather than resolving the bare name through the function index where
    // it collides with the constructor. The rest of the header still
    // toggles the methods sub-accordion.
    const nameSpan = h('span', { className: 'name clickable', html: displayNameHtml(c.name), style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' });
    if (c.start) {
      nameSpan.title = `Open ${c.filepath}:${c.start}`;
      nameSpan.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(c.filepath, c.start); });
    }
    const subHeader = h('div', { className: 'sub-accordion-header' }, [
      h('span', { className: 'sub-accordion-toggle', text: '▸' }),
      nameSpan,
      h('span', { className: 'metric', text: `${c.methods}m` }),
      h('span', { className: 'metric', text: `${c.total_lines}L` }),
      h('span', { className: 'filepath', text: c.filepath?.replace(/\\/g, '/') || '', style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
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
      if (parentSection) setTimeout(() => _updateOverflowHint(parentSection), 50);
    });

    // Double-click: show class in middle-top
    subHeader.addEventListener('dblclick', (e) => { e.stopPropagation(); onClassClick(c.name); });

    // Right-click: class-appropriate context menu (#198). kind:'class' gives
    // Find Uses + keeps Show Digest / Analyze File, and drops the callable-only
    // items (callers/callees/call-tree/extract) that don't apply to a type.
    // The same kind makes Show Digest target the class, not its same-named
    // constructor (CSI buildDigest honors opts.kind).
    subHeader.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      showContextMenu(e, { name: c.name, display_name: c.name, filepath: c.filepath, kind: 'class' });
    });

    container.appendChild(sub);
  }
  if (total > classes.length) container.appendChild(h('div', { className: 'list-placeholder', text: `${classes.length} of ${total} shown` }));
}

export async function loadClassMethods(className, container) {
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


// ============================================================================
// Models list (AI/ML #84) — classes whose inheritance reaches a model base
// ============================================================================

export function renderModelList(container, models, total) {
  container.innerHTML = '';
  if (!models || !models.length) {
    container.innerHTML = '<div class="list-placeholder">No model classes found</div>';
    return;
  }
  for (const m of models) {
    // ambiguous bare-name match (Module/Model/Layer) gets a trailing "?"
    const fwLabel = (m.framework || '?') + (m.ambiguous ? '?' : '');
    // full inheritance chain: Class → parent → … → base (tooltip)
    const chain = (m.chain && m.chain.length) ? m.chain : [m.base];
    const fullChain = `${m.name} → ${chain.join(' → ')}`;
    const item = h('div', {
      className: 'list-item',
      title: `${m.filepath || ''}\n${fullChain}${m.ambiguous ? '  (ambiguous base name — verify)' : ''}`,
    }, [
      h('span', { className: 'metric', text: fwLabel, style: 'min-width:72px;color:var(--accent,#6cf)' }),
      h('span', { className: 'name clickable', html: displayNameHtml(m.name), style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' }),
      h('span', { className: 'metric', text: `→ ${m.base}`, title: fullChain, style: 'color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;max-width:160px;flex-shrink:0' }),
      h('span', { className: 'metric', text: `${m.methods}m` }),
      h('span', { className: 'filepath', text: m.filepath?.replace(/\\/g, '/') || '', style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    // Click → show class in middle-top; right-click → context menu (Digest).
    item.addEventListener('click', (e) => { e.stopPropagation(); onClassClick(m.name); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: m.name, display_name: m.name, filepath: m.filepath }); });
    container.appendChild(item);
  }
  if (total > models.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${models.length} of ${total} shown` }));
  }
}


// ============================================================================
// Artifacts list (#96) — model-weight load/save SITES (not units).
// Rows are sorted server-side by family, format, file, line. Each row carries
// a direction badge (load/save/ref), the format, and the artifact path/name.
// Heuristic format-ref rows are marked with a leading "~" and muted, so the
// mechanical/heuristic distinction is visible (honesty per #96).
// ============================================================================

const _ARTIFACT_DIR_COLOR = { load: '#6cf', save: '#fc6', ref: 'var(--text-muted)' };

// Show a filesystem path by basename (./models/foo.gguf -> foo.gguf); leave HF
// hub ids (org/model) and bare ids whole. Mirrors metrics.js basenameIfPath.
function basenameIfPath(v) {
  if (!v) return v;
  const looksPath = /^(?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(v)
    || /[\\/][^\\/]*\.(?:gguf|safetensors|onnx|ckpt|pth|pt|bin|h5)$/i.test(v);
  return looksPath ? (v.split(/[\\/]/).pop() || v) : v;
}

export function renderArtifactList(container, artifacts, total) {
  container.innerHTML = '';
  if (!artifacts || !artifacts.length) {
    container.innerHTML = '<div class="list-placeholder">No model artifacts found '
      + '(no load/save sites: from_pretrained, state_dict, torch.save/load, '
      + 'safetensors, node-llama-cpp GGUF, or .gguf/.safetensors/.onnx paths)</div>';
    return;
  }
  for (const a of artifacts) {
    const heuristic = a.tag === 'heuristic';
    const famLabel = (heuristic ? '~' : '') + (a.family || '?');
    const dirColor = _ARTIFACT_DIR_COLOR[a.direction] || 'var(--text-muted)';
    const unresolved = a.path && a.pathResolved === false;
    const nameText = basenameIfPath(a.path) || a.snippet || a.format || '';
    const item = h('div', {
      className: 'list-item',
      title: `${(a.filepath || '').replace(/\\/g, '/')}:${a.line}\n${a.snippet || ''}\n[${a.tag}]  ${a.family} · ${a.direction} · ${a.format}${a.path ? `\nid: ${a.path}${unresolved ? '  (unresolved variable)' : ''}` : ''}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: famLabel, style: 'min-width:96px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric', text: a.direction, style: `min-width:34px;color:${dirColor};font-size:10px` }),
      h('span', { className: 'metric', text: a.format, style: 'min-width:78px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: nameText, style: `flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${unresolved ? 'var(--warning,#c79a4e)' : 'var(--text-bright)'}${unresolved ? ';font-style:italic' : ''}` }),
      h('span', { className: 'filepath', text: `${shortPath(a.filepath || '')}:${a.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    // Click → open the file (sites have no class to focus); right-click → Digest.
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(a.filepath, a.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: a.filepath, display_name: a.filepath, filepath: a.filepath }); });
    container.appendChild(item);
  }
  if (total > artifacts.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${artifacts.length} of ${total} shown` }));
  }
}


// ============================================================================
// Kernels list (#93) — GPU kernel definitions + launch sites.
// kind ∈ {kernel-def, launch, device-fn}, family ∈ {CUDA, Triton, numba,
// Triton/numba}. Heuristic rows (gated grid-launches) get a leading "~" + dim.
// ============================================================================

export const KERNEL_KIND_COLOR = { 'kernel-def': '#6cf', 'launch': '#fc6', 'device-fn': 'var(--text-muted)' };
const _KERNEL_KIND_COLOR = KERNEL_KIND_COLOR;

// Multimodal / Vision (#140) — kind ∈ {encoder, cnn-arch, detection-seg,
// generative, marker}. All rows are heuristic (keyword matches), so the app-side
// renderer shows a leading "~"; the color distinguishes the five themes.
export const MULTIMODAL_KIND_COLOR = {
  'encoder': '#6cf', 'cnn-arch': '#9c6', 'detection-seg': '#fc6',
  'generative': '#c9f', 'marker': 'var(--text-muted)',
};

// Explainability / Analysis (#155) — kind ∈ {attribution, dim-reduction}.
// attribution (SHAP/LIME/Captum) vs dim-reduction (PCA/t-SNE/UMAP) get
// distinct hues so the two analysis families read apart at a glance.
export const EXPLAINABILITY_KIND_COLOR = {
  'attribution': '#f9a', 'dim-reduction': '#6cf', 'instrumentation': '#9f9',
};

// Post-training / Fine-tuning (#140) — kind ∈ {peft, alignment, distill}. All
// rows are heuristic (keyword matches), so the app-side renderer shows a leading
// "~"; the color distinguishes the three mechanism families.
export const POSTTRAINING_KIND_COLOR = {
  'peft': '#6cf', 'alignment': '#fc6', 'distill': '#c9f',
};

// Reasoning (#146) — kind ∈ {cot, reflection, scratchpad}. All rows are
// heuristic (prompt-language matches), so the app-side renderer shows a leading
// "~"; the color distinguishes the three reasoning themes.
export const REASONING_KIND_COLOR = {
  'cot': '#6cf', 'reflection': '#fc6', 'scratchpad': '#c9f',
};

export function renderKernelList(container, kernels, total) {
  container.innerHTML = '';
  if (!kernels || !kernels.length) {
    container.innerHTML = '<div class="list-placeholder">No GPU kernels found '
      + '(no CUDA __global__/&lt;&lt;&lt;&gt;&gt;&gt;, Triton @triton.jit, or numba @cuda.jit)</div>';
    return;
  }
  for (const k of kernels) {
    const heuristic = k.tag === 'heuristic';
    const famLabel = (heuristic ? '~' : '') + (k.family || '?');
    const kindColor = _KERNEL_KIND_COLOR[k.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(k.filepath || '').replace(/\\/g, '/')}:${k.line}\n${k.snippet || ''}\n[${k.tag}]  ${k.family} · ${k.kind} · ${k.marker}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: famLabel, style: 'min-width:96px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric', text: k.kind, style: `min-width:74px;color:${kindColor};font-size:10px` }),
      h('span', { className: 'metric', text: k.marker || '', style: 'min-width:88px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: k.name || '', style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'filepath', text: `${shortPath(k.filepath || '')}:${k.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(k.filepath, k.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: k.filepath, display_name: k.filepath, filepath: k.filepath }); });
    container.appendChild(item);
  }
  if (total > kernels.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${kernels.length} of ${total} shown` }));
  }
}


// ============================================================================
// Datasets list (#99) — Tier-1 definitions + Tier-2 ML loaders (Tier-3 generic
// I/O like pd.read_csv is excluded upstream). kind ∈ {definition, loader};
// built-in rows (framework-provided standard/benchmark datasets — MNIST, CIFAR,
// Iris, …) get a "built-in" tag + dim so standard data can be eyeballed apart
// from a project's own pipeline.
// ============================================================================

export const DATASET_KIND_COLOR = { 'definition': '#6cf', 'loader': '#fc6' };
const _DATASET_KIND_COLOR = DATASET_KIND_COLOR;

export function renderDatasetList(container, datasets, total) {
  container.innerHTML = '';
  if (!datasets || !datasets.length) {
    container.innerHTML = '<div class="list-placeholder">No datasets found '
      + '(no Dataset/IterableDataset subclass, tf.data pipeline, or ML loader — '
      + 'DataLoader / load_dataset / sklearn·keras·torchvision.datasets / tfds.load). '
      + 'Generic pd.read_csv / np.load I/O is intentionally not counted.</div>';
    return;
  }
  for (const d of datasets) {
    const kindColor = _DATASET_KIND_COLOR[d.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(d.filepath || '').replace(/\\/g, '/')}:${d.line}\n${d.snippet || ''}\n${d.family} · ${d.kind} · ${d.marker}${d.builtin ? '  (built-in / standard dataset)' : ''}${d.kind === 'definition' && !d.confirmed ? '  (no __getitem__/__len__ confirmation)' : ''}${d.name ? `\nid: ${d.name}${d.resolved === false ? '  (unresolved variable)' : ''}` : ''}`,
      style: d.builtin ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: d.family, style: 'min-width:88px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric', text: d.kind, style: `min-width:72px;color:${kindColor};font-size:10px` }),
      h('span', { className: 'metric', text: d.marker || '', style: 'min-width:104px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: basenameIfPath(d.name) || '', style: `flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${d.resolved === false ? 'var(--warning,#c79a4e)' : 'var(--text-bright)'}${d.resolved === false ? ';font-style:italic' : ''}` }),
      d.builtin ? h('span', { className: 'metric', text: 'built-in', style: 'color:var(--text-muted);font-size:9px;flex-shrink:0' }) : null,
      h('span', { className: 'filepath', text: `${shortPath(d.filepath || '')}:${d.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ].filter(Boolean));
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(d.filepath, d.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: d.filepath, display_name: d.filepath, filepath: d.filepath }); });
    container.appendChild(item);
  }
  if (total > datasets.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${datasets.length} of ${total} shown` }));
  }
}


// ============================================================================
// Training list (#100) — where a codebase trains. kind ∈ {training-loop,
// training-harness}; Tier-B (heuristic gated .fit) rows get "~" + dim so the
// mechanical loop/Trainer signal stands apart from the noisier .fit() calls.
// ============================================================================

export const TRAINING_KIND_COLOR = { 'training-loop': '#fc6', 'training-harness': '#6cf' };
const _TRAINING_KIND_COLOR = TRAINING_KIND_COLOR;

export function renderTrainingList(container, training, total) {
  container.innerHTML = '';
  if (!training || !training.length) {
    container.innerHTML = '<div class="list-placeholder">No training found '
      + '(no PyTorch loop — .backward()/optimizer.step()/zero_grad() — HF Trainer, '
      + 'GradientTape, Lightning training_step, or a gated .fit() call). A bare '
      + 'def fit(...) is intentionally not counted.</div>';
    return;
  }
  for (const t of training) {
    const heuristic = t.tier === 'B';
    const kindColor = _TRAINING_KIND_COLOR[t.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(t.filepath || '').replace(/\\/g, '/')}:${t.line}\n${t.snippet || ''}\n${t.family} · ${t.kind} · ${t.marker}${heuristic ? '  (Tier B — heuristic .fit, gated; framework source over-fires)' : '  (Tier A — mechanical)'}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: (heuristic ? '~' : '') + t.family, style: 'min-width:92px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric', text: t.kind === 'training-harness' ? 'harness' : 'loop', style: `min-width:60px;color:${kindColor};font-size:10px` }),
      h('span', { className: 'metric', text: t.marker || '', style: 'min-width:104px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: t.name || '', style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(t.filepath, t.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: t.filepath, display_name: t.filepath, filepath: t.filepath }); });
    container.appendChild(item);
  }
  if (total > training.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${training.length} of ${total} shown` }));
  }
}


// ============================================================================
// Inference/Generation list (#101) — LOCAL model inference (no_grad/predict) +
// autoregressive generation (generate/sampling). kind ∈ {generation, inference}.
// Tier B/C (heuristic, gated) rows get "~" + dim so the clean Tier-A markers
// stand apart. API-client LLM usage is a separate unit, not shown here.
// ============================================================================

export const INFER_KIND_COLOR = { 'generation': '#fc6', 'inference': '#6cf' };
const _INFER_KIND_COLOR = INFER_KIND_COLOR;

export function renderInferenceList(container, inference, total) {
  container.innerHTML = '';
  if (!inference || !inference.length) {
    container.innerHTML = '<div class="list-placeholder">No inference/generation found '
      + '(no generate()/max_new_tokens/GenerationConfig, no_grad/inference_mode/'
      + 'InferenceSession, or gated .predict()). Remote API-client LLM usage is a '
      + 'separate unit, not shown here.</div>';
    return;
  }
  for (const t of inference) {
    const heuristic = t.tag === 'heuristic';
    const kindColor = _INFER_KIND_COLOR[t.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(t.filepath || '').replace(/\\/g, '/')}:${t.line}\n${t.snippet || ''}\n${t.family} · ${t.kind} · tier ${t.tier} · ${t.marker}${heuristic ? (t.tier === 'C' ? '  (Tier C — sampling param, gated on a generation co-marker)' : '  (Tier B — gated call, ML-file required)') : '  (Tier A — clean mechanical)'}${t.id ? `\nmodel: ${t.id}${t.resolved === false ? '  (unresolved variable)' : ''}` : ''}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: (heuristic ? '~' : '') + t.family, style: 'min-width:80px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric', text: t.kind === 'generation' ? 'gen' : 'infer', style: `min-width:46px;color:${kindColor};font-size:10px` }),
      h('span', { className: 'metric', text: 'T' + t.tier, style: 'min-width:22px;color:var(--text-muted);font-size:9px' }),
      h('span', { className: 'metric', text: t.marker || '', style: 'min-width:100px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: (t.name || '') + (t.id ? ' → ' + basenameIfPath(t.id) : ''), style: `flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${t.id && t.resolved === false ? 'var(--warning,#c79a4e)' : 'var(--text-bright)'}` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(t.filepath, t.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: t.filepath, display_name: t.filepath, filepath: t.filepath }); });
    container.appendChild(item);
  }
  if (total > inference.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${inference.length} of ${total} shown` }));
  }
}


// ============================================================================
// LLM Calls list (#103) — the LLM-use invocation layer (where a prompt is fed to
// a model). kind ∈ {call, client, wrapper, endpoint}; provider-grouped. Tier B/C
// (heuristic) rows get "~" + dim; [lib?] flags library-vs-consumer over-fire.
// ============================================================================

export const LLMCALL_KIND_COLOR = { 'call': '#fc6', 'client': '#6cf', 'wrapper': '#a9f', 'endpoint': 'var(--text-muted)' };
const _LLMCALL_KIND_COLOR = LLMCALL_KIND_COLOR;

export function renderLlmCallsList(container, calls, total) {
  container.innerHTML = '';
  if (!calls || !calls.length) {
    container.innerHTML = '<div class="list-placeholder">No LLM API calls found '
      + '(no messages.create / chat.completions.create / ChatOpenAI / LlamaChatSession '
      + '/ .invoke, or api.anthropic.com·/v1/messages endpoints). A pure harness that '
      + 'spawns an agent CLI correctly shows none.</div>';
    return;
  }
  for (const t of calls) {
    const heuristic = t.tag === 'heuristic';
    const kindColor = _LLMCALL_KIND_COLOR[t.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(t.filepath || '').replace(/\\/g, '/')}:${t.line}\n${t.snippet || ''}\n${t.provider} · ${t.kind} · tier ${t.tier} · ${t.marker}${t.lvc ? '  (library-vs-consumer: over-fires on the SDK\'s own source)' : ''}${t.model ? `\nmodel: ${t.model}${t.modelResolved ? '' : '  (unresolved identifier — #110 step 2 resolves to the literal)'}` : ''}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: (heuristic ? '~' : '') + t.provider, style: 'min-width:84px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric', text: t.kind, style: `min-width:60px;color:${kindColor};font-size:10px` }),
      h('span', { className: 'metric', text: 'T' + t.tier, style: 'min-width:22px;color:var(--text-muted);font-size:9px' }),
      h('span', { className: 'name clickable', text: (t.marker || '') + (t.lvc ? ' [lib?]' : ''), style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'metric', text: t.model ? '→ ' + basenameIfPath(t.model) : '', style: `flex-shrink:0;max-width:170px;${t.model ? 'margin-right:14px;' : ''}font-size:10px;overflow:hidden;text-overflow:ellipsis;color:${t.model && t.modelResolved ? 'var(--success,#7c7)' : 'var(--warning,#c79a4e)'}${t.model && !t.modelResolved ? ';font-style:italic' : ''}` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(t.filepath, t.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: t.filepath, display_name: t.filepath, filepath: t.filepath }); });
    container.appendChild(item);
  }
  if (total > calls.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${calls.length} of ${total} shown` }));
  }
}


// ============================================================================
// Tools list (#104) — function-calling / tool layer. kind ∈ {tool-def, mcp,
// tool-dispatch}, framework-grouped. Tier-B (heuristic, gated) rows get "~" +
// dim; [lib?] flags library-vs-consumer over-fire. (@tool is LangChain-only;
// most tools are schema/MCP, so cli.js etc. surface without @tool.)
// ============================================================================

const _TOOL_KIND_COLOR = { 'tool-def': '#6cf', 'mcp': '#a9f', 'tool-dispatch': '#fc6' };

export function renderToolsList(container, tools, total) {
  container.innerHTML = '';
  if (!tools || !tools.length) {
    container.innerHTML = '<div class="list-placeholder">No tools found '
      + '(no @tool / FunctionTool / StructuredTool, input_schema/inputSchema, MCP '
      + 'setRequestHandler / server.tool / defineChatSessionFunction, or tool_use/'
      + 'tool_calls dispatch). @tool alone is LangChain-specific.</div>';
    return;
  }
  for (const t of tools) {
    const heuristic = t.tag === 'heuristic';
    const kindColor = _TOOL_KIND_COLOR[t.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(t.filepath || '').replace(/\\/g, '/')}:${t.line}\n${t.snippet || ''}\n${t.framework} · ${t.kind} · tier ${t.tier} · ${t.marker}${t.lvc ? '  (library-vs-consumer: over-fires on the lib\'s own source)' : ''}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: (heuristic ? '~' : '') + (t.framework || ''), style: 'min-width:96px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric', text: t.kind === 'tool-dispatch' ? 'dispatch' : t.kind, style: `min-width:62px;color:${kindColor};font-size:10px` }),
      h('span', { className: 'metric', text: t.marker || '', style: 'min-width:104px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: (t.name || '—') + (t.lvc ? ' [lib?]' : ''), style: `flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${t.name ? 'var(--text-bright)' : 'var(--text-muted)'}` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(t.filepath, t.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: t.filepath, display_name: t.filepath, filepath: t.filepath }); });
    container.appendChild(item);
  }
  if (total > tools.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${tools.length} of ${total} shown` }));
  }
}


// ============================================================================
// Chains/Agents list (#105) — composition/orchestration. kind ∈ {chain, graph,
// agent}, framework-grouped. Carries a SCOPE CAPTION (#106): framework-based
// only — hand-rolled agent loops / LCEL `|` are not detected, so a 0 is not
// proof of "no agent". Tier-B (gated generic) rows get "~" + dim.
// ============================================================================

const _CHAIN_SCOPE = 'Framework primitives (LangChain / LangGraph / DSPy / CrewAI / AutoGen) + a heuristic '
  + 'hand-rolled-agent flag (a module that loops over an LLM call while dispatching tools). The hand-rolled flag '
  + 'needs real module boundaries — on a single minified bundle use a --split-bundle index. LCEL │ pipelines are '
  + 'still not detected; Detection keys on JS/TS + Python idioms (Rust/Go not yet — #108), so a low/zero count is not proof there is no agent.';
export const CHAIN_KIND_COLOR = { 'chain': '#6cf', 'graph': '#a9f', 'agent': '#fc6' };
const _CHAIN_KIND_COLOR = CHAIN_KIND_COLOR;

export function renderChainsList(container, chains, total) {
  container.innerHTML = '';
  // Scope caption first — so it shows even on an empty result, and travels in
  // screenshots (the "don't mislead by omission" rule, #106).
  container.appendChild(h('div', {
    text: _CHAIN_SCOPE,
    style: 'padding:4px 8px;font-size:10px;color:var(--text-muted);font-style:italic;border-bottom:1px solid var(--border,#333);margin-bottom:2px',
  }));
  if (!chains || !chains.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: 'No framework chains/agents found (see scope above).' }));
    return;
  }
  for (const t of chains) {
    const heuristic = t.tag === 'heuristic';
    const kindColor = _CHAIN_KIND_COLOR[t.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(t.filepath || '').replace(/\\/g, '/')}:${t.line}\n${t.snippet || ''}\n${t.framework} · ${t.kind} · ${t.marker}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: (heuristic ? '~' : '') + (t.framework || ''), style: 'min-width:84px;color:var(--accent,#6cf);overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'metric', text: t.kind, style: `min-width:48px;color:${kindColor};font-size:10px` }),
      h('span', { className: 'metric', text: t.marker || '', style: 'min-width:104px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: t.name || '', style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(t.filepath, t.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: t.filepath, display_name: t.filepath, filepath: t.filepath }); });
    container.appendChild(item);
  }
  if (total > chains.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${chains.length} of ${total} shown` }));
  }
}


// ============================================================================
// Embeddings & Vector Search list (#109) — RAG-agnostic. kind ∈ {embedding,
// vector-store, search, chunking, distance}. distance is co-occurrence-gated (so
// clustering/attention math is excluded). RAG = this + an LLM call (#103). Tier
// B/C (heuristic) rows get "~" + dim.
// ============================================================================

const _EMB_SCOPE = 'Embeddings & vector search — RAG-agnostic (also clustering / dedup / semantic search). '
  + 'Distance measures are co-occurrence-gated (clustering/attention math excluded). RAG = these + an LLM call '
  + '(LLM Calls). Keys on JS/TS + Python idioms (Rust/Go #108); bespoke vector math without a library may be missed.';
const _EMB_KIND_COLOR = { 'embedding': '#6cf', 'vector-store': '#a9f', 'search': '#fc6', 'chunking': '#9c9', 'distance': 'var(--text-muted)' };

export function renderEmbeddingsList(container, items, total) {
  container.innerHTML = '';
  container.appendChild(h('div', {
    text: _EMB_SCOPE,
    style: 'padding:4px 8px;font-size:10px;color:var(--text-muted);font-style:italic;border-bottom:1px solid var(--border,#333);margin-bottom:2px',
  }));
  if (!items || !items.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: 'No embeddings / vector search found (see scope above).' }));
    return;
  }
  for (const t of items) {
    const heuristic = t.tag === 'heuristic';
    const kindColor = _EMB_KIND_COLOR[t.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(t.filepath || '').replace(/\\/g, '/')}:${t.line}\n${t.snippet || ''}\n${t.framework} · ${t.kind} · ${t.marker}${t.kind === 'distance' ? '  (co-occurrence-gated)' : ''}${t.id ? `\nid: ${t.id}${t.resolved === false ? '  (unresolved variable)' : ''}` : ''}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: (heuristic ? '~' : '') + t.kind, style: `min-width:88px;color:${kindColor};font-size:10px;overflow:hidden;text-overflow:ellipsis` }),
      h('span', { className: 'metric', text: t.framework || '', style: 'min-width:96px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: t.marker || '', style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'metric', text: t.id ? '→ ' + basenameIfPath(t.id) : '', style: `flex-shrink:0;max-width:200px;${t.id ? 'margin-right:14px;' : ''}font-size:10px;overflow:hidden;text-overflow:ellipsis;color:${t.id && t.resolved !== false ? 'var(--success,#7c7)' : 'var(--warning,#c79a4e)'}${t.id && t.resolved === false ? ';font-style:italic' : ''}` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(t.filepath, t.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: t.filepath, display_name: t.filepath, filepath: t.filepath }); });
    container.appendChild(item);
  }
  if (total > items.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${items.length} of ${total} shown` }));
  }
}


// ============================================================================
// Models Used list (#110 capstone) — distinct named models the code loads/calls,
// deduped & tagged api (hosted) / local (loaded). Distinct from the Models cell
// (models DEFINED via class inheritance).
// ============================================================================

const _ACCESS_COLOR = { api: '#6cf', local: '#7c7', mixed: '#c79a4e' };

export function renderModelsUsedList(container, models, total, unresolved, onModelClick) {
  container.innerHTML = '';
  // #132: a model is test-only when EVERY harvested site is a test path.
  const hiddenTests = hideTests() ? (models || []).filter(m => m.isTest).length : 0;
  if (hiddenTests) models = models.filter(m => !m.isTest);
  if (!models || !models.length) {
    container.innerHTML = '<div class="list-placeholder">No models used found '
      + '(no resolved model id from LLM calls / artifacts / embeddings / inference). '
      + 'Models USED (loaded/called) is distinct from models DEFINED (Models accordion).'
      + (unresolved ? ` ${unresolved} refs were unresolved &lt;var&gt;.` : '') + '</div>';
    return;
  }
  for (const m of models) {
    const accColor = _ACCESS_COLOR[m.access] || 'var(--text-muted)';
    const site0 = (m.sites && m.sites[0]) || {};
    const item = h('div', {
      className: 'list-item' + (m.isTest ? ' is-test' : ''),
      title: `${m.model}\naccess: ${m.access}\ncells: ${(m.cells || []).join(', ')}\n${m.count} site${m.count > 1 ? 's' : ''}${site0.filepath ? `\nfirst: ${(site0.filepath || '').replace(/\\/g, '/')}:${site0.line}` : ''}${m.isTest ? '\n[test/example code — all sites]' : ''}`,
    }, [
      h('span', { className: 'metric', text: m.access, style: `min-width:54px;color:${accColor};font-size:10px` }),
      h('span', { className: 'name clickable', text: basenameIfPath(m.model) || '', style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'metric', text: (m.cells || []).join(','), style: 'flex-shrink:0;max-width:160px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;margin-right:10px' }),
      h('span', { className: 'metric', text: '×' + m.count, style: 'flex-shrink:0;color:var(--text-muted);font-size:10px' }),
    ]);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onModelClick) onModelClick(m);                       // #115: drill into the model's sites (top pane)
      else if (site0.filepath) onFileClick(site0.filepath, site0.line);
    });
    container.appendChild(item);
  }
  if (hiddenTests) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${hiddenTests} test-only model${hiddenTests > 1 ? 's' : ''} hidden` }));
  }
  if (unresolved) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `+ ${unresolved} unresolved <var> model ref(s) — excluded; resolve via an in-file assignment` }));
  }
  if (total > models.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${models.length} of ${total} shown` }));
  }
}

// #115 drill-down: render one model's sites (file:line  function()  [cell]) into a
// container (the top-middle pane); each row clicks through to source. Same indented
// shape as `--models-used -v`, plus function names + clickability.
export function renderModelsUsedSites(container, model) {
  container.innerHTML = '';
  if (!model || !model.sites || !model.sites.length) {
    container.innerHTML = '<div class="list-placeholder">No sites for this model.</div>';
    return;
  }
  container.appendChild(h('div', {
    text: `${model.model}  ·  ${model.access}  ·  ${(model.cells || []).join(', ')}  ·  ${model.sites.length} site${model.sites.length > 1 ? 's' : ''}`,
    style: 'padding:4px 8px;font-size:11px;color:var(--text-bright);border-bottom:1px solid var(--border,#333);margin-bottom:2px',
  }));
  for (const s of model.sites) {
    const item = h('div', {
      className: 'list-item',
      title: `${(s.filepath || '').replace(/\\/g, '/')}:${s.line}${s.function ? `\n${s.function}()` : ''}\ncell: ${s.cell}  ·  marker: ${s.marker || ''}`,
    }, [
      h('span', { className: 'metric', text: s.cell || '', style: 'min-width:70px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: s.function ? s.function + '()' : '—', style: `flex-shrink:0;min-width:130px;max-width:260px;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${s.function ? 'var(--text-bright)' : 'var(--text-muted)'}` }),
      h('span', { className: 'filepath', text: `${shortPath(s.filepath || '')}:${s.line}`, style: 'flex:1;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(s.filepath, s.line); });
    container.appendChild(item);
  }
}


// ============================================================================
// Structured Output list (#117) — the output-shaping LLM-use cell. kind ∈
// {schema, format, parser, constrained}; schema rows carry the bound schema name.
// ============================================================================

export const SO_KIND_COLOR = { schema: '#6cf', format: '#7c7', parser: '#a9f', constrained: '#fc6' };
const _SO_KIND_COLOR = SO_KIND_COLOR;

export function renderStructuredOutputList(container, items, total) {
  container.innerHTML = '';
  if (!items || !items.length) {
    container.innerHTML = '<div class="list-placeholder">No structured output found '
      + '(no with_structured_output / response_model / response_format / JSON mode, output '
      + 'parsers, or outlines/guidance). Bare BaseModel/Zod schemas are not counted.</div>';
    return;
  }
  for (const t of items) {
    const heuristic = t.tag === 'heuristic';
    const kindColor = _SO_KIND_COLOR[t.kind] || 'var(--text-muted)';
    const item = h('div', {
      className: 'list-item',
      title: `${(t.filepath || '').replace(/\\/g, '/')}:${t.line}\n${t.snippet || ''}\n${t.framework} · ${t.kind} · ${t.marker}${t.id ? `\nschema: ${t.id}` : ''}`,
      style: heuristic ? 'opacity:0.78' : '',
    }, [
      h('span', { className: 'metric', text: (heuristic ? '~' : '') + t.kind, style: `min-width:84px;color:${kindColor};font-size:10px;overflow:hidden;text-overflow:ellipsis` }),
      h('span', { className: 'metric', text: t.framework || '', style: 'min-width:90px;color:var(--accent,#6cf);font-size:10px;overflow:hidden;text-overflow:ellipsis' }),
      h('span', { className: 'name clickable', text: t.marker || '', style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'metric', text: t.id ? '→ ' + t.id : '', style: `flex-shrink:0;max-width:200px;${t.id ? 'margin-right:12px;' : ''}font-size:10px;overflow:hidden;text-overflow:ellipsis;color:var(--success,#7c7)` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(t.filepath, t.line); });
    item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: t.filepath, display_name: t.filepath, filepath: t.filepath }); });
    container.appendChild(item);
  }
  if (total > items.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `${items.length} of ${total} shown` }));
  }
}


// ============================================================================
// Pipelines list (#116) — connected AI/ML pipelines by cell co-occurrence (file
// or leaf folder). Click a pipeline → its stages (cell · ids · sites) in the top
// pane → source. shape ∈ {RAG, training, agent, inference, LLM-app}.
// ============================================================================

const _SHAPE_COLOR = { RAG: '#6cf', 'low-level': '#f88', 'fine-tuning': '#f9a', training: '#fc6', agent: '#a9f', inference: '#7c7', reasoning: '#8dd', 'LLM-app': '#9cf' };
function _stagesText(w) {
  return (w.stages || []).map(s => s.cell + (s.ids && s.ids.length ? `(${basenameIfPath(s.ids[0])}${s.ids.length > 1 ? '…' : ''})` : '')).join(' → ');
}

// Build a left-to-right Mermaid flow from a pipeline's stages. The main flow is
// one box per STAGE labeled with just the cell name (solid `-->` arrows). What
// each stage actually contains — its ids (model names, schemas, frameworks) —
// hangs off as dotted, rounded, muted "example" leaves, so the flow stays clean
// but the detail is there (instead of a single clipped `cell(firstId…)` box).
// Stage node ids n0..nN map back to w.stages[i] for click-through; leaf ids
// (nIeJ) are non-clickable. Labels are sanitized (quotes/brackets break parse).
// Leaf filter — drop ONLY the categorical, low-signal labels: orchestration
// frameworks (which repeat on every stage — chunking/search/agent all
// "LangChain") and access/unknown placeholders. KEEP specific products — the
// vector store (Milvus/FAISS/Pinecone), embedder, provider, model, schema,
// class — those are real content worth seeing. (This is also what tames the
// dagre staircase: only meaningful leaves hang off the flow.)
const _GENERIC_LEAF = new Set([
  '?', 'local', 'api', 'mixed', 'SDK',
  'LangChain', 'LangGraph', 'DSPy', 'CrewAI', 'AutoGen', 'LlamaIndex',
  'OpenAI-Agents', 'smolagents', 'PydanticAI',
]);

export function pipelineMermaid(w) {
  const stages = (w.stages || []);
  const safe = (t) => String(t).replace(/"/g, "'").replace(/[[\]{}<>|`]/g, ' ').trim().slice(0, 36);
  const lines = ['graph LR'];
  const leaves = [];
  stages.forEach((s, i) => {
    lines.push(`  n${i}["${safe(s.cell)}"]`);
    const ids = (s.ids || []).map(basenameIfPath).filter(id => id && !_GENERIC_LEAF.has(id));
    ids.slice(0, 4).forEach((id, j) => {
      const nid = `n${i}e${j}`;
      lines.push(`  ${nid}(["${safe(id)}"])`);
      lines.push(`  n${i} -.-> ${nid}`);     // dotted = "contains", not flow
      leaves.push(nid);
    });
  });
  for (let i = 0; i < stages.length - 1; i++) lines.push(`  n${i} --> n${i + 1}`);
  // Agent-loop back-edge (the ReAct cycle): thick + labeled, distinct from the
  // dotted example connectors. from = action stage, to = the model call.
  if (w.loop) {
    const idxOf = (cell) => stages.findIndex(s => s.cell === cell);
    const fi = idxOf(w.loop.from), ti = idxOf(w.loop.to);
    if (fi >= 0 && ti >= 0 && fi !== ti) lines.push(`  n${fi} == loop ==> n${ti}`);
  }
  if (leaves.length) {
    lines.push('  classDef ex fill:#1b1f26,stroke:#3a4a66,color:#9ab8e0;');
    lines.push(`  class ${leaves.join(',')} ex;`);
  }
  return lines.join('\n');
}

// #142 drill-down dedupe: `groups` is the server's grouped pipeline structure —
// [{ sig, rep, count, members }] — so the SAME pipeline (e.g. RAG ·
// vector-store(LangChain) → search(LangChain) over ~186 files) shows ONCE with a
// ×count badge instead of one row per file. `total` is the pre-dedup flow count
// (badge / summary). `onGroupClick(group)` drills into the group's members (or
// straight to source for a ×1 group). Each group's scope = rep.scope, so the
// main (file/folder) vs loose (module) split is preserved.
export function renderPipelinesList(container, groups, total, onGroupClick) {
  container.innerHTML = '';
  container.appendChild(h('div', {
    text: 'Pipelines by cell co-occurrence — not traced dataflow. Identical pipelines are collapsed (×count); click to drill into the files. Confidence: file > folder (leaf folder) > module (climbed to a common ancestor, shown separately below as "loose").',
    style: 'padding:4px 8px;font-size:10px;color:var(--text-muted);font-style:italic;border-bottom:1px solid var(--border,#333);margin-bottom:2px',
  }));
  // #132: drop all-test groups when "hide tests" is on (a group is test when
  // every member location is — same rule as renderRow's dimming below).
  // Track both grains: hidden GROUPS for the badge line, hidden PIPELINES
  // (instances) so the "N of M shown" math stays explainable.
  const isTestGroup = (g) => (g.members && g.members.length) ? g.members.every(m => m.isTest) : !!g.rep.isTest;
  const hiddenGroups = hideTests() ? (groups || []).filter(isTestGroup) : [];
  const hiddenTests = hiddenGroups.length;
  const hiddenCount = hiddenGroups.reduce((n, g) => n + g.count, 0);
  if (hiddenTests) groups = groups.filter(g => !isTestGroup(g));
  if (!groups || !groups.length) {
    container.appendChild(h('div', { className: 'list-placeholder', text: `No AI/ML pipelines found (no file/leaf-folder where 2+ cells form a shape).${hiddenTests ? ` ${hiddenTests} test/example group${hiddenTests > 1 ? 's' : ''} hidden.` : ''}` }));
    return;
  }
  // file/folder = trustworthy (cells co-occur in one file or leaf folder); module =
  // "loose" (assembler climbed to a broader common ancestor — cells just co-exist in
  // the subtree, not a coherent flow). Render module in a demoted, separated section
  // so it can't masquerade as a real pipeline (#142). A group's scope = rep.scope.
  const renderRow = (g, dim) => {
    const w = g.rep;
    const gTest = isTestGroup(g);
    const color = _SHAPE_COLOR[w.shape] || 'var(--text-muted)';
    const spans = [
      h('span', { className: 'metric', text: w.shape, style: `min-width:64px;color:${color};font-size:10px;font-weight:600` }),
      h('span', { className: 'metric', text: w.scope, style: `min-width:46px;color:${w.scope === 'module' ? 'var(--error,#e0708a)' : w.scope === 'folder' ? 'var(--warning,#c79a4e)' : 'var(--text-muted)'};font-size:9px` }),
      h('span', { className: 'name clickable', text: _stagesText(w), style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
    ];
    if (g.count > 1) {
      spans.push(h('span', { className: 'metric', text: '×' + g.count, style: 'min-width:40px;text-align:right;color:var(--accent,#6cf);font-size:10px;font-weight:600' }));
    } else {
      spans.push(h('span', { className: 'filepath', text: shortPath(w.location || ''), style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0;max-width:180px' }));
    }
    const item = h('div', {
      className: 'list-item' + (gTest ? ' is-test' : ''),
      style: dim && !gTest ? 'opacity:0.6' : '',
      title: `${w.shape}${w.shapes.length > 1 ? ` (also: ${w.shapes.slice(1).join(', ')})` : ''}  ·  scope: ${w.scope}  ·  ${g.count} file${g.count > 1 ? 's' : ''}${dim ? '  (loose — climbed to a common ancestor; cells co-occur somewhere in the subtree, not a traced flow)' : ''}${gTest ? '  [test/example code]' : ''}\n${_stagesText(w)}${g.count === 1 ? '\n' + (w.location || '').replace(/\\/g, '/') : ''}`,
    }, spans);
    item.addEventListener('click', (e) => { e.stopPropagation(); if (onGroupClick) onGroupClick(g); });
    container.appendChild(item);
  };
  const main = groups.filter(g => g.rep.scope !== 'module');
  const loose = groups.filter(g => g.rep.scope === 'module');
  const looseCount = loose.reduce((n, g) => n + g.count, 0);
  for (const g of main) renderRow(g, false);
  if (loose.length) {
    container.appendChild(h('div', {
      text: `loose — module-scope (climbed to a common ancestor; cells co-occur somewhere in the subtree, not a traced flow) · ${loose.length} group${loose.length > 1 ? 's' : ''} / ${looseCount} pipeline${looseCount > 1 ? 's' : ''}`,
      style: 'padding:5px 8px 3px;margin-top:4px;font-size:9px;text-transform:uppercase;letter-spacing:0.04em;color:var(--error,#e0708a);border-top:1px solid var(--border,#333)',
    }));
    for (const g of loose) renderRow(g, true);
  }
  if (hiddenTests) container.appendChild(h('div', { className: 'list-placeholder', text: `${hiddenTests} test/example group${hiddenTests > 1 ? 's' : ''} (${hiddenCount} pipeline${hiddenCount > 1 ? 's' : ''}) hidden` }));
  const shownCount = groups.reduce((n, g) => n + g.count, 0);
  if (total > shownCount) {
    const over = total - shownCount - hiddenCount;   // remainder beyond the hidden tests = display cap
    container.appendChild(h('div', { className: 'list-placeholder', text: `${shownCount} of ${total} pipelines shown${hiddenCount ? ` (${hiddenCount} hidden as test/example${over > 0 ? `; ${over} over display cap` : ''})` : ''}` }));
  }
}

// #142 drill-down dedupe: a pipeline group's member files. Each member is a full
// pipeline row (same shape/scope/stages, different location); clicking one drills
// into its stages via onMemberClick (the existing renderPipelineStages flow).
export function renderPipelineMembers(container, group, onMemberClick) {
  container.innerHTML = '';
  if (!group || !group.members || !group.members.length) { container.innerHTML = '<div class="list-placeholder">No members.</div>'; return; }
  // Stash group + handler on the (persistent) container so the DELEGATED click
  // listener on #middle-top-body keeps working after nav back/forward restores
  // the innerHTML (which drops per-element listeners). #142.
  container._plGroup = group;
  container._plMemberClick = onMemberClick;
  const w0 = group.rep;
  const color = _SHAPE_COLOR[w0.shape] || 'var(--text-muted)';
  container.appendChild(h('div', {
    text: `${w0.shape}  ·  ${w0.scope}  ·  ${group.count} file${group.count > 1 ? 's' : ''}`,
    style: `padding:4px 8px;font-size:11px;color:${color};border-bottom:1px solid var(--border,#333);margin-bottom:2px`,
  }));
  // Surface the shared stage structure here (representative ids) so it's visible
  // without drilling into a member — the per-FILE line-level sites still live one
  // click deeper (they're inherently per-file). #142 feedback.
  for (const s of (w0.stages || [])) {
    container.appendChild(h('div', {
      text: `${s.cell}${s.ids && s.ids.length ? '  — ' + s.ids.join(', ') : ''}`,
      style: 'padding:3px 8px 1px;font-size:10px;color:var(--accent,#6cf)',
    }));
  }
  container.appendChild(h('div', {
    text: `files (${group.count}) — click one for its line-level sites`,
    style: 'padding:5px 8px 2px;margin-top:3px;font-size:9px;text-transform:uppercase;letter-spacing:0.04em;color:var(--text-muted);border-top:1px solid var(--border,#333)',
  }));
  group.members.forEach((m, i) => {
    const item = h('div', { className: 'list-item', style: 'cursor:pointer', title: `${(m.location || '').replace(/\\/g, '/')}\n${_stagesText(m)}` }, [
      h('span', { className: 'metric', text: m.scope, style: `min-width:46px;color:${m.scope === 'module' ? 'var(--error,#e0708a)' : m.scope === 'folder' ? 'var(--warning,#c79a4e)' : 'var(--text-muted)'};font-size:9px` }),
      h('span', { className: 'filepath', text: shortPath(m.location || ''), style: 'flex:1;font-family:var(--font-mono);font-size:10px;color:var(--text-bright);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;min-width:0' }),
    ]);
    item.setAttribute('data-pl-member', String(i));
    container.appendChild(item);
  });
}

// Drill-down: a pipeline's stages (cell · ids · sites) into a container (top pane);
// each site clicks through to source. Same model → stages → source pattern as #115.
export function renderPipelineStages(container, w, onDiagram) {
  container.innerHTML = '';
  if (!w) { container.innerHTML = '<div class="list-placeholder">No pipeline.</div>'; return; }
  container.appendChild(h('div', {
    text: `${w.shape}  ·  ${w.scope}  ·  ${(w.location || '').replace(/\\/g, '/')}${w.shapes.length > 1 ? `   [also: ${w.shapes.slice(1).join(', ')}]` : ''}`,
    style: 'padding:4px 8px;font-size:11px;color:var(--text-bright);border-bottom:1px solid var(--border,#333);margin-bottom:2px',
  }));
  // "View as diagram" — only for ≥3-stage pipelines (a 2-stage A→B reads fine
  // as text). Renders the LR Mermaid flow in the Diagram pane via onDiagram(w).
  if ((w.stages || []).length >= 3 && typeof onDiagram === 'function') {
    const btn = h('button', { className: 'btn-secondary', text: 'View as diagram', style: 'margin:4px 8px' });
    btn.addEventListener('click', () => onDiagram(w));
    container.appendChild(btn);
  }
  (w.stages || []).forEach((s, si) => {
    container.appendChild(h('div', {
      id: `pl-stage-${si}`,
      text: `${s.cell}${s.ids && s.ids.length ? '  — ' + s.ids.join(', ') : ''}  (${s.count})`,
      style: 'padding:3px 8px 1px;font-size:10px;color:var(--accent,#6cf)',
    }));
    for (const site of (s.sites || []).slice(0, 25)) {
      const item = h('div', { className: 'list-item', style: 'padding-left:18px;cursor:pointer', title: `${(site.filepath || '').replace(/\\/g, '/')}:${site.line}` }, [
        h('span', { className: 'filepath', text: `${shortPath(site.filepath || '')}:${site.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis' }),
      ]);
      item.setAttribute('data-pl-file', site.filepath || '');
      item.setAttribute('data-pl-line', String(site.line));
      container.appendChild(item);
    }
  });
}


// ============================================================================
// Hot Folders list
// ============================================================================

export function renderHotFolderList(container, folders) {
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


// ============================================================================
// Most Called list
// ============================================================================

export function renderMostCalledList(container, items, total, sectionId, filter) {
  container.innerHTML = '';

  // Toggle for defined-only filtering
  const toggleRow = h('div', { style: 'display:flex;align-items:center;gap:6px;padding:2px 8px;font-size:10px;color:var(--text-muted)' }, [
    h('label', { style: 'display:flex;align-items:center;gap:4px;cursor:pointer' }, [
      (() => { const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!state.mostCalledDefinedOnly; cb.style.cssText = 'margin:0'; cb.addEventListener('change', () => { state.mostCalledDefinedOnly = cb.checked; _loadSectionData('most-called', filter || ''); }); return cb; })(),
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


// ============================================================================
// Call Inventory list
// ============================================================================

export function renderCallInventory(container, data) {
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
    if (external.length < summary.external_count) {
      container.appendChild(h('div', { className: 'list-placeholder',
        text: `showing ${external.length} of ${summary.external_count} — raise Max results`,
        style: 'font-size:10px;padding:4px 10px;color:#ffd479' }));
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
      if (parentSection) setTimeout(() => _updateOverflowHint(parentSection), 50);
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
    if (in_index.length < summary.in_index_count) {
      inIdxContent.appendChild(h('div', { className: 'list-placeholder',
        text: `showing ${in_index.length} of ${summary.in_index_count} — raise Max results`,
        style: 'font-size:10px;padding:4px 10px;color:#ffd479' }));
    }
    container.appendChild(inIdxToggle);
    container.appendChild(inIdxContent);
  }
}


// ============================================================================
// Class Hotspots list
// ============================================================================

export function renderClassHotspotList(container, classes) {
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


// ============================================================================
// Class Hierarchy tree
// ============================================================================

export function renderClassHierarchy(container, data) {
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
      h('span', { className: 'name', text: label, style: nameStyle + ';flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis' }),
      metaText ? h('span', { className: 'metric muted', text: metaText, style: 'font-size:10px' }) : null,
      fpText ? h('span', { className: 'filepath', text: fpText, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex:1 1 0;min-width:0' }) : null,
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
        if (parentSection) setTimeout(() => _updateOverflowHint(parentSection), 50);
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


// ============================================================================
// Vocabulary list
// ============================================================================

export function renderVocabList(container, vocab, concepts) {
  container.innerHTML = '';
  if (!vocab.length) { container.innerHTML = '<div class="list-placeholder">No vocabulary</div>'; return; }
  if (concepts && concepts.length) {
    // Each concept is { concept, example } (#181 polish) — show concept (example),
    // or bare for a standalone-token concept with no larger identifier.
    const label = (c) => (c && typeof c === 'object') ? (c.example ? `${c.concept} (${c.example})` : c.concept) : c;
    container.appendChild(h('div', { className: 'list-placeholder', text: `Key concepts: ${concepts.map(label).join(', ')}`, style: 'font-size:10px;padding:4px 8px;color:var(--accent-blue);white-space:normal' }));
  }
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


// ============================================================================
// Overview (#181) — one-shot orientation pane. Renders the structured
// buildOverview() object: scale, languages, structure, key concepts (with one
// example identifier each), clickable key files + entry points, absence
// "Watch" notes, and a one-way button to the File Map section.
// ============================================================================

export function renderOverviewList(container, ov, opts = {}) {
  container.innerHTML = '';
  container.classList.add('overview-pane'); // roomier leading + flush-left rows (CSS)
  if (!ov || !ov.size) { container.innerHTML = '<div class="list-placeholder">No overview</div>'; return; }

  // Centered prose blocks for scale/structure; flush-left clickable rows for the
  // concept / key-file / entry-point lists (consistency with the other panes).
  const block = (text) => h('div', { className: 'list-placeholder', text, style: 'white-space:normal' });
  // Section titles (Key concepts / Key files / Entry points) stand out from the
  // flush-left rows below them: bold + underlined + centered, with breathing room.
  const head = (text) => h('div', { className: 'list-placeholder', text, style: 'white-space:normal;font-weight:700;text-decoration:underline;text-align:center;color:var(--accent-blue);margin-top:10px' });
  // Peel a dominant path prefix PER SECTION (key files / entry points), not
  // over the combined set: in a collection the entry points span several repos,
  // so a combined prefix dilutes below threshold and nothing peels — while the
  // key files (clustered in one repo) do share a long peelable prefix. Each
  // section computes its own prefix, appends a header, and strips its rows.
  // #path-prefix-peel.
  const sectionPeel = (paths) => {
    const { prefix, covered, total } = commonPathPrefix(paths);
    if (prefix) container.appendChild(block(covered === total
      ? `Paths under: ${prefix}`
      : `Unless otherwise indicated, all paths begin with ${prefix}`));
    return (p) => { const n = String(p || '').replace(/\\/g, '/'); return prefix && n.startsWith(prefix) ? n.slice(prefix.length) : n; };
  };

  // A flush-left single-line row that opens `filepath` on click and offers the
  // standard right-click menu (Find Callers/Callees/etc.). `ctxName` drives the
  // menu: a function/identifier name enables call items; passing the filepath as
  // the name marks it file-only (like the Files/Key-files panes do). `metric` is
  // a short right-aligned count; `subpath` a secondary file path rendered in the
  // app's ellipsis `.filepath` style (so long paths truncate cleanly, not jam
  // a numeric metric slot).
  const clickRow = (label, { metric, subpath, filepath, ctxName, line, search } = {}) => {
    const kids = [h('span', { className: 'name clickable', text: label })];
    if (subpath) kids.push(h('span', { className: 'filepath', text: subpath }));
    if (metric) kids.push(h('span', { className: 'metric muted', text: metric }));
    const item = h('div', { className: 'list-item', title: filepath || (search ? `search: ${search}` : label) }, kids);
    if (filepath) {
      item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(filepath, line || undefined); });
      item.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: ctxName, display_name: ctxName || label, filepath }); });
    } else if (search && window.doSearchFromUI) {
      // #268: a concept with no code example is still useful — click to search the term.
      item.addEventListener('click', (e) => { e.stopPropagation(); window.doSearchFromUI(search); });
    }
    return item;
  };

  if (ov.name) container.appendChild(h('div', { text: (String(ov.name).startsWith('FIRST_RUN_INDEX') ? 'Demo — mixed sample corpus (AI app + ML + TLS)' : ov.name), style: 'text-align:center;font-weight:700;font-size:14px;padding:6px 8px 2px' }));
  const langs = (ov.languages || []).slice(0, 8).map(l => `${l.ext} ${l.pct}%`).join(', ');
  // Function count is a deep signal; show "…" until the deep half arrives.
  const fnPart = ov.size.functions == null ? '… functions' : `${ov.size.functions} functions`;
  container.appendChild(block(`${ov.size.files} files · ${fnPart} · ${(ov.size.lines || 0).toLocaleString()} lines (${ov.size.parse_method})`));
  if (langs) container.appendChild(block(`Languages: ${langs}`));

  if (ov.isCollection) {
    container.appendChild(head('⚠ Looks like a collection, not one project — top-level folders:'));
    for (const f of (ov.topFolders || []).slice(0, 8)) {
      if (f.folder !== '(root)') container.appendChild(block(`  ${f.folder}/  (${f.count} files, ${f.pct}%)`));
    }
  } else {
    const folders = (ov.topFolders || []).filter(f => f.folder !== '(root)').slice(0, 6).map(f => `${f.folder}/ (${f.count})`).join(', ');
    if (folders) container.appendChild(block(`Top-level: ${folders}`));
  }

  if (ov.concepts && ov.concepts.length) {
    container.appendChild(head('Key concepts (with examples):'));
    for (const c of ov.concepts) {
      const label = c.example ? `${c.concept} (${c.example})` : c.concept;
      // Clickable when we know which file the example identifier lives in; jumps
      // to its definition (functions) or first mention (consts/schemas) and the
      // context menu targets the example identifier, not the bare concept.
      container.appendChild(clickRow(label, { filepath: c.exampleFile || null, ctxName: c.example || c.concept, line: c.exampleLine, search: c.exampleFile ? null : c.concept }));
    }
  }

  if (ov.keyFiles && ov.keyFiles.length) {
    container.appendChild(head('Key files (by vocabulary density):'));
    const stripKf = sectionPeel(ov.keyFiles.map(k => k.file));
    for (const kf of ov.keyFiles) container.appendChild(clickRow(stripKf(kf.file), { metric: `${kf.terms} terms`, filepath: kf.file, ctxName: kf.file })); // file-only ctx
  }

  if (ov.entryPoints && ov.entryPoints.length) {
    container.appendChild(head('Entry points:'));
    const stripEp = sectionPeel(ov.entryPoints.map(e => e.filepath));
    for (const ep of ov.entryPoints) container.appendChild(clickRow(ep.name, { subpath: stripEp(ep.filepath), filepath: ep.filepath, ctxName: ep.name, line: ep.line }));
  }

  // Deep-signals area. Three states (only when the deep half isn't merged yet):
  //  - gated: large index — show a button so the user opts into the (server-
  //    blocking) compute rather than triggering it accidentally on load.
  //  - pending: compute in flight — passive note.
  //  - failed: deep fetch errored/timed out.
  if (ov.partial) {
    if (opts.deepGated && opts.onLoadDeep) {
      container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal',
        text: 'Key concepts, key files & entry points aren’t computed yet — on a large index this can take a minute or two and briefly makes the server busy.' }));
      const b = h('button', { className: 'btn-secondary', text: 'Finish generating overview', style: 'margin:4px 10px' });
      b.addEventListener('click', () => opts.onLoadDeep());
      container.appendChild(b);
    } else if (opts.deepFailed) {
      container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal',
        text: 'Deep signals failed to load (the server may be busy on a large index). Re-open the Overview to retry.' }));
    } else {
      container.appendChild(h('div', { className: 'list-placeholder', style: 'white-space:normal;color:var(--text-muted)',
        text: '⏳ Computing key concepts, key files & entry points… (also available later in the left-pane Overview accordion)' }));
    }
  }

  if (ov.absence && ov.absence.length) {
    container.appendChild(head('Watch:'));
    for (const a of ov.absence) container.appendChild(block(`  ⚠ ${a}`));
  }

  const btnRow = h('div', { style: 'padding:8px' });
  const btn = h('button', { className: 'btn-secondary', text: 'View file map' });
  btn.addEventListener('click', () => showFileMap());
  btnRow.appendChild(btn);
  // Pop-out: in the left-pane Overview accordion (not the floating pop-up itself),
  // offer to (re)open the floating Overview pop-up — so closing it isn't a dead
  // end. Detected by container id: the pop-up renders into `#overview-body`.
  if (container.id !== 'overview-body') {
    const popOut = h('button', { className: 'btn-secondary', text: '⧉ Open Overview pop-up', style: 'margin-left:8px' });
    popOut.addEventListener('click', () => showOverviewOverlay());
    btnRow.appendChild(popOut);
  }
  container.appendChild(btnRow);

  // AI Overview (#196): a prose orientation generated by running Claude
  // agentically over CodeExam's own MCP tools. Not air-gapped (calls the
  // Anthropic API server-side), so it's an explicit opt-in button with a warning,
  // appended at the bottom of the same scrollable Overview surface.
  renderAiOverviewSection(container, ov);
}

// AI Overview (#196) — cached per-index (by `ov.source`) so the generated prose
// survives the Overview's fast→deep re-renders and re-opening the pop-up within
// the same loaded index. Cleared implicitly when a different index is shown
// (the cache key no longer matches).
let _aiOverviewProse = null;
let _aiOverviewFor = null;
let _aiOverviewBy = null; // "ChatGPT API · gpt-5.1" etc. — what produced the cached prose

// Render the opt-in AI Overview block at the bottom of the Overview surface: a
// button (+ air-gapped warning) when not yet generated, or the cached prose
// (+ regenerate button) when it has been.
function renderAiOverviewSection(container, ov) {
  const key = ov.source || '';
  const sec = h('div', { style: 'border-top:1px solid var(--border);margin-top:6px;padding:8px' });
  const result = h('div', { className: 'ai-overview-result', style: 'margin-top:6px' });
  const renderProse = (prose) => renderAiOverview(result, prose);

  const cached = _aiOverviewProse != null && _aiOverviewFor === key;
  const btn = h('button', { className: 'btn-secondary', text: cached ? '↻ Regenerate' : '✨ Overview by AI' });
  btn.addEventListener('click', () => runAiOverview(btn, result, ov, renderProse));
  sec.appendChild(btn);
  // Engine-aware warning (class-tagged so runAiOverview can retire it after a
  // run — before the fix it lingered stale under the Regenerate button). Read
  // fresh on each open; also refreshed live via updateAiOverviewWarning when
  // the Workspace engine changes.
  const warn = h('div', {
    className: 'ai-overview-warn',
    style: 'font-size:11px;color:var(--text-muted);margin-top:4px;white-space:normal',
  });
  warn.textContent = _aiOverviewWarnText();
  warn.style.display = cached ? 'none' : '';
  sec.appendChild(warn);
  // Confirmation of what ACTUALLY produced the shown prose (populated post-run
  // or from cache) — ground truth beats the pre-run warning.
  const provenance = h('div', {
    className: 'ai-overview-provenance',
    style: 'font-size:11px;color:var(--text-muted);margin-top:4px;font-style:italic',
  });
  if (cached && _aiOverviewBy) provenance.textContent = `Generated by ${_aiOverviewBy}`;
  sec.appendChild(provenance);
  sec.appendChild(result);
  container.appendChild(sec);
  if (cached) renderProse(_aiOverviewProse);
}

// The pre-run warning text for the currently-selected Workspace engine.
function _aiOverviewWarnText() {
  const e = _wsEngine();
  if (e === 'local') return `Air-gapped: runs the loaded local model (${_wsLocalModelName()}) over CodeExam’s tools — nothing leaves this machine. Follows the Workspace LLM Engine selection.`;
  if (e === 'openai') return 'Not air-gapped: calls the OpenAI API (needs OPENAI_API_KEY) across CodeExam’s MCP tools — usually a few minutes. Don’t use on confidential code that must stay offline; switch the Workspace LLM Engine to a local model for that.';
  if (e === 'gemini') return 'Not air-gapped: calls the Gemini API (needs GEMINI_API_KEY) across CodeExam’s MCP tools — usually a few minutes. Don’t use on confidential code that must stay offline; switch the Workspace LLM Engine to a local model for that.';
  return 'Not air-gapped: calls the Anthropic API (needs ANTHROPIC_API_KEY) across CodeExam’s MCP tools — usually a few minutes. Don’t use on confidential code that must stay offline; switch the Workspace LLM Engine to a local model for that.';
}

// Keep any on-screen pre-run warning in sync with the Workspace engine (wired
// to the ws-engine change in app.js). No-op when the overview isn't showing.
export function updateAiOverviewWarning() {
  document.querySelectorAll('.ai-overview-warn').forEach((el) => {
    if (el.style.display !== 'none') el.textContent = _aiOverviewWarnText();
  });
}

// The Workspace LLM Engine selection governs which engine generates the
// overview (one server-wide engine posture, same as chat/analyze).
function _wsEngine() {
  const sel = document.querySelector('#ws-engine');
  return (sel && sel.value) || 'claude';
}
function _wsLocalModelName() {
  const opt = document.querySelector('#ws-engine option[value="local"]');
  return ((opt && opt.textContent) || 'Local GGUF Model').replace(/^Local: /, '');
}

// Fetch the AI Overview from the server — Claude over the Anthropic API, or
// the loaded local GGUF, per the Workspace engine selection — caching the
// prose so it persists across re-renders. Disables the button while in flight.
async function runAiOverview(btn, result, ov, renderProse) {
  const orig = btn.textContent;
  const engine = _wsEngine();
  btn.disabled = true;
  btn.textContent = '⏳ Generating…';
  const runningLabel = engine === 'local'
    ? `Running the local model (${escHtml(_wsLocalModelName())}) over CodeExam’s tools — a few minutes on GPU, longer on CPU…`
    : engine === 'openai'
      ? 'Running ChatGPT (OpenAI) over the MCP tools — this can take a few minutes…'
      : 'Running Claude over the MCP tools — this can take a few minutes…';
  result.innerHTML = `<div class="list-placeholder" style="white-space:normal">${runningLabel}</div>`;
  try {
    const data = await api.aiOverview({ engine });
    _aiOverviewProse = data.prose;
    _aiOverviewFor = ov.source || '';
    // Ground-truth provenance from the server: which engine + model actually
    // produced this prose. Supersedes the pre-run warning, which we retire.
    const engLabel = data.engine === 'local' ? 'Local GGUF'
      : data.engine === 'openai' ? 'ChatGPT API'
      : data.engine === 'gemini' ? 'Gemini API' : 'Claude API';
    _aiOverviewBy = data.model ? `${engLabel} · ${data.model}` : engLabel;
    const sec = btn.parentElement;
    if (sec) {
      const warnEl = sec.querySelector('.ai-overview-warn');
      if (warnEl) warnEl.style.display = 'none';
      const provEl = sec.querySelector('.ai-overview-provenance');
      if (provEl) provEl.textContent = `Generated by ${_aiOverviewBy}`;
    }
    btn.textContent = '↻ Regenerate';
    renderProse(data.prose);
  } catch (err) {
    result.innerHTML = '';
    result.appendChild(h('div', {
      className: 'list-placeholder',
      style: 'white-space:normal;color:var(--accent-red,#d33)',
      text: `AI Overview failed: ${err.message}`,
    }));
    btn.textContent = orig;
  } finally {
    btn.disabled = false;
  }
}

// Render the model's prose into `container` with light Markdown-ish formatting
// (headers, bullets, **strong**) and — the point of "prose with clickable
// anchors" — backticked `path` / `path@func` references turned into
// jump-to-source links (left-click opens the file; right-click → the standard
// context menu). Non-path backticks render as inline <code>.
export function renderAiOverview(container, prose) {
  container.innerHTML = '';
  const wrap = h('div', { className: 'ai-overview-prose', style: 'padding:2px 6px;line-height:1.5;font-size:13px' });
  for (const raw of String(prose || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { wrap.appendChild(h('div', { style: 'height:7px' })); continue; }
    const isHeader = /^#{1,6}\s/.test(line) || /^\*\*[^*].*\*\*:?\s*$/.test(line);
    const isBullet = /^\s*[-*]\s+/.test(line) && !/^\s*\*\*/.test(line);
    const text = line.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*]\s+/, '');
    const el = h('div', {
      style: (isHeader ? 'font-weight:700;color:var(--accent-blue);margin-top:9px;' : '') + (isBullet ? 'padding-left:16px;text-indent:-9px;' : ''),
    });
    appendProseWithRefs(el, (isBullet ? '• ' : '') + text);
    wrap.appendChild(el);
  }
  container.appendChild(wrap);
}

// Parse one line of model prose into DOM: split on backtick spans and **strong**;
// backtick spans that look like a source reference (`path`, `path@func`, or a
// bare `name.ext`) become clickable; everything else is plain text / code / bold.
function appendProseWithRefs(el, text) {
  // Tokenize into `code`, **strong**, and plain runs in one pass.
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0, m;
  const pushPlain = (s) => { if (s) el.appendChild(document.createTextNode(s)); };
  while ((m = re.exec(text)) !== null) {
    pushPlain(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      const inner = tok.slice(1, -1);
      const ref = parseSourceRef(inner);
      if (ref) {
        const a = h('span', { className: 'name clickable', text: inner, title: `Open ${ref.file}`, style: 'font-family:var(--mono,monospace)' });
        a.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(ref.file); });
        a.addEventListener('contextmenu', (e) => { e.stopPropagation(); showContextMenu(e, { name: ref.func || ref.file, display_name: inner, filepath: ref.file }); });
        el.appendChild(a);
      } else {
        el.appendChild(h('code', { text: inner, style: 'background:var(--bg-alt,#222);padding:0 3px;border-radius:3px' }));
      }
    } else {
      el.appendChild(h('strong', { text: tok.slice(2, -2) }));
    }
    last = re.lastIndex;
  }
  pushPlain(text.slice(last));
}

// Decide whether a backticked token is a source reference worth linking.
// Accepts `path/to/file.ext`, `file.ext`, or `path@func` / `file.ext@func`.
// Rejects prose-y backticks (spaces, no extension and no slash) and bare
// tool/command names so we don't litter the prose with dead links.
function parseSourceRef(tok) {
  const t = tok.trim();
  if (!t || /\s/.test(t)) return null;
  let file = t, func = null;
  const at = t.indexOf('@');
  if (at > 0) { file = t.slice(0, at); func = t.slice(at + 1); }
  const looksLikePath = file.includes('/') || /\.[A-Za-z0-9]{1,6}$/.test(file);
  if (!looksLikePath) return null;
  return { file, func };
}

// Merge the deep half into a fast overview object (in place) and clear the
// partial flag, so a re-render shows the full overview.
export function mergeOverviewDeep(ov, deep) {
  if (!ov || !deep) return ov;
  ov.size.functions = deep.functions;
  ov.displayRoot = deep.displayRoot;
  ov.topVocab = deep.topVocab;
  ov.concepts = deep.concepts;
  ov.keyFiles = deep.keyFiles;
  ov.entryPoints = deep.entryPoints;
  ov.absence = [...(deep.absence || []), ...(ov.absence || [])];
  ov.partial = false;
  return ov;
}

// Render the file dependency map into the Diagram pane — same destination as the
// `/file-map` console command. Used by the Overview's "View file map" button.
// Leaves the Overview pop-up open (it's a draggable floating panel) so the user
// can keep it for reference and move it aside if it overlaps the diagram.
export async function showFileMap() {
  try {
    const data = await api.fileMap({});
    const body = $('#right-top-body'), ttl = $('#right-top-title');
    if (ttl) ttl.textContent = 'File Dependency Map';
    if (body) {
      body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>';
      renderMermaid(data.mermaid, $('#diagram-viewport'), null, {
        onNodeClick: (nodeId, label) => onFileClick(label),
      });
    }
    showPane('right-top');
  } catch (err) { showMiddleTopError(`File map failed: ${err.message}`); }
}

// Above these sizes the deep overview compute (vocabulary + call-graph) is slow
// enough that — because the server is single-threaded — running it would block
// every other request (e.g. loading a different index) for minutes. So we DON'T
// auto-run it on large indexes; the user opts in via a button. Tuned so normal
// projects auto-stream and only true monsters (.spinellis: 6.8M lines) gate.
const OVERVIEW_DEEP_MAX_LINES = 2_000_000;
const OVERVIEW_DEEP_MAX_FILES = 10_000;

// One generation counter guards against stale deep merges: each load bumps it,
// and a deep result whose generation is stale (the user loaded another index,
// re-opened the pane, etc.) is discarded instead of merged into the wrong index.
let _overviewGen = 0;

/**
 * Load the overview into `container`: render the fast half immediately, then
 * either auto-stream the deep half (small indexes) or offer a button (large
 * ones). `onMeta(ov)` lets the caller stash the object / set a badge. The deep
 * fetch is generation-guarded so switching indexes mid-compute can't mis-merge.
 */
export async function loadOverviewInto(container, { onMeta } = {}) {
  const gen = ++_overviewGen;
  container.innerHTML = '<div class="list-placeholder">Loading overview…</div>';
  let ov;
  try {
    ov = await api.overview(); // fast half — counts, languages, structure
  } catch (err) {
    if (gen === _overviewGen) container.innerHTML = `<div class="list-placeholder">No overview: ${escHtml(err.message)}</div>`;
    return null;
  }
  if (gen !== _overviewGen) return null; // superseded by a newer load
  if (onMeta) onMeta(ov);

  const fetchDeep = async () => {
    renderOverviewList(container, ov, {}); // drop the gate button → "computing…" note
    try {
      const deep = await api.overviewDeep();
      if (gen !== _overviewGen) return;     // user moved on; don't mis-merge
      mergeOverviewDeep(ov, deep);
      renderOverviewList(container, ov, {});
    } catch {
      if (gen === _overviewGen) renderOverviewList(container, ov, { deepFailed: true });
    }
  };

  const large = (ov.size.lines || 0) > OVERVIEW_DEEP_MAX_LINES || (ov.size.files || 0) > OVERVIEW_DEEP_MAX_FILES;
  if (large) renderOverviewList(container, ov, { deepGated: true, onLoadDeep: fetchDeep });
  else fetchDeep();
  return ov;
}

// #181: the Overview pop-up window (floating panel). Shown on index load and on
// GUI startup with a command-line index.
export async function showOverviewOverlay() {
  const panel = $('#overview-overlay');
  if (!panel) return;
  panel.classList.remove('hidden');
  await loadOverviewInto($('#overview-body'), {
    onMeta: (ov) => { $('#overview-meta').textContent = ov.source ? ov.source : ''; },
  });
}

export function initOverviewOverlay() {
  const panel = $('#overview-overlay');
  if (!panel) return;
  $('#overview-close')?.addEventListener('click', () => panel.classList.add('hidden'));
  makeDraggable(panel, $('#overview-drag-handle'));
  makeResizable(panel, $('#overview-resize-se'));
}


// ============================================================================
// Indexes list
// ============================================================================

export function renderIndexesList(container, data) {
  container.innerHTML = '';
  const loaded = data.loaded || [];
  const available = data.available || [];

  // Hint: this accordion only scans the current/last-used directory
  container.appendChild(h('div', { className: 'list-placeholder', text: 'Showing indexes in current directory. Use Load Index dialog (Index menu) for other locations.', style: 'padding:4px 8px;font-size:10px;color:var(--text-muted);line-height:1.4' }));

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
          // #218: pop the fast Overview on accordion-load too (parity with the
          // Load Index dialog, which dispatches ce:index-loaded in dialogs.js).
          window.dispatchEvent(new CustomEvent('ce:index-loaded'));
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


// ============================================================================
// File map list (summary in left pane)
// ============================================================================

export function renderFileMapList(container, data) {
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


// ============================================================================
// Call inventory list
// ============================================================================

export function renderCallInventoryList(container, data) {
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
    const shownExt = Math.min(40, external.length);
    if (shownExt < summary.external_count) {
      container.appendChild(h('div', { className: 'list-placeholder', text: `showing ${shownExt} of ${summary.external_count} — raise Max results`, style: 'font-size:10px;padding:4px 8px;color:#ffd479' }));
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
    const shownIn = Math.min(20, in_index.length);
    if (shownIn < summary.in_index_count) {
      container.appendChild(h('div', { className: 'list-placeholder', text: `showing ${shownIn} of ${summary.in_index_count} — raise Max results`, style: 'font-size:10px;padding:4px 8px;color:#ffd479' }));
    }
  }
}


// ============================================================================
// Extensions list (second one — different shape from above)
// ============================================================================

export function renderExtensionsList(container, data) {
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


// ============================================================================
// Dupe group lists (exact, near, structural)
// ============================================================================

export function renderDupeGroupList(container, groups, type) {
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


// ============================================================================
// Surprising Funcstrings — codebase-wide scan of struct-hash groups
// containing pairs whose names/paths/extensions are unusually distant.
// ============================================================================

export function renderSurprisingFuncstringsList(container, groups, meta) {
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
    <label title="Use the tight normalizer: requires the function to have at least one control-flow keyword (drops bag-of-constants idioms and chained defineProperty wrappers) and run-length-collapses repeated statements. First toggle rebuilds the hash table for this index — may take a few seconds on large indexes.">
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
    _loadSectionData('surprising-funcstrings', filter);
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
  bodyOrder.forEach(bh => {
    bodyLabel.set(bh, String.fromCharCode(65 + (nextLabel++ % 26)));
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
  _wireClickables(container, { sourceOnly: true });

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
  _wireClickables(container, { sourceOnly: true });

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


// ============================================================================
// String table
// ============================================================================

export function renderStringTable(container, strings, meta) {
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


// ============================================================================
// #134 generic drill-down renderers (left list of deduped groups → sites pane).
// Cell-agnostic: each cell supplies a `columns` config (text getter + style per
// span). Modeled on renderModelsUsedList / renderModelsUsedSites; extract further
// only when a 2nd cell adopts these. The genuinely generic dedup mechanism is
// groupSites() in ai-ml-detectors.js; these just render its output.
// ============================================================================

// Left pane: one row per deduped group (columns + `×count`), click → onItemClick.
// columns: [{ get(item)->text, className?, style? }]; countOf(item)->number.
export function renderDrilldownList(container, items, { columns, countOf, onItemClick, title, footer, caveat }) {
  container.innerHTML = '';
  // #132: rows whose every site is test/example code dim (.is-test); the
  // "hide tests" checkbox drops them entirely, with a count in the footer.
  const hiddenTests = hideTests() ? (items || []).filter(it => it.isTest).length : 0;
  if (hiddenTests) items = items.filter(it => !it.isTest);
  if (!items || !items.length) {
    container.innerHTML = `<div class="list-placeholder">None found.${hiddenTests ? ` (${hiddenTests} test/example row${hiddenTests > 1 ? 's' : ''} hidden)` : ''}</div>`;
    return;
  }
  for (const it of items) {
    const spans = columns.map(c => h('span', {
      className: c.className || 'metric',
      text: c.get(it) || '',
      style: (typeof c.style === 'function' ? c.style(it) : c.style) || 'font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis',
    }));
    spans.push(h('span', { className: 'metric', text: '×' + countOf(it), style: 'flex-shrink:0;color:var(--text-muted);font-size:10px' }));
    const item = h('div', { className: 'list-item' + (it.isTest ? ' is-test' : ''), title: (title ? title(it) : '') + (it.isTest ? '\n[test/example code]' : '') }, spans);
    item.addEventListener('click', (e) => { e.stopPropagation(); onItemClick(it); });
    container.appendChild(item);
  }
  if (hiddenTests) container.appendChild(h('div', { className: 'list-placeholder', text: `${hiddenTests} test/example row${hiddenTests > 1 ? 's' : ''} hidden` }));
  if (footer) container.appendChild(h('div', { className: 'list-placeholder', text: footer }));
  // Caveat: a per-cell honesty note (e.g. quantization is prose-prone). Set off
  // with its own top border + spacing so it reads as a distinct note, not a
  // run-on of the footer (#141 — keep caveats from blending).
  if (caveat) container.appendChild(h('div', {
    className: 'list-placeholder',
    style: 'margin-top:6px;padding-top:6px;border-top:1px solid var(--border,#333);opacity:0.7;font-size:10px;font-style:italic;white-space:normal;line-height:1.35',
    text: caveat,
  }));
}

// Top-middle pane: header + one row per site, click → source. columns: same shape;
// each site needs filepath/line for the click-through.
// Top-middle pane: header + sites. Flat mode (pass `columns`) renders one row per
// site. Sub-grouped mode (pass `subgroupBy`, e.g. s => s.snippet) collapses sites
// that share the key (#134): a code line that repeats across N files shows once as
// a header (+ ×count) with its file:line locations indented under it — clicking a
// location goes to source. A unique key renders inline (snippet · file:line).
export function renderDrilldownSites(container, { header, sites, columns, subgroupBy, align }) {
  container.innerHTML = '';
  if (!sites || !sites.length) {
    container.innerHTML = '<div class="list-placeholder">No sites.</div>';
    return;
  }
  if (header) {
    container.appendChild(h('div', {
      text: header,
      style: 'padding:4px 8px;font-size:11px;color:var(--text-bright);border-bottom:1px solid var(--border,#333);margin-bottom:2px',
    }));
  }

  const locRow = (s, indent) => {
    const item = h('div', { className: 'list-item', title: `${(s.filepath || '').replace(/\\/g, '/')}:${s.line}` }, [
      h('span', { className: 'filepath clickable', text: `${shortPath(s.filepath || '')}:${s.line}`,
        style: `${indent ? 'padding-left:18px;' : ''}flex:1;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;min-width:0` }),
    ]);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(s.filepath, s.line); });
    return item;
  };

  if (subgroupBy) {
    // Group WHITESPACE-INSENSITIVELY so the same line with different spacing/indent
    // collapses (e.g. `tools = []` and `tools=[]` → one group). Key strips all
    // whitespace; the displayed label is the first occurrence's snippet with runs
    // collapsed to single spaces. First-seen order preserved.
    const groups = new Map();
    for (const s of sites) {
      const raw = subgroupBy(s) || '';
      const key = raw.replace(/\s+/g, '') || '(blank)';
      if (!groups.has(key)) groups.set(key, { label: raw.replace(/\s+/g, ' ').trim() || '(blank)', locs: [] });
      groups.get(key).locs.push(s);
    }
    for (const { label, locs } of groups.values()) {
      if (locs.length === 1) {
        // Unique line → inline (snippet · file:line) so singletons don't cost 2 rows.
        const s = locs[0];
        const item = h('div', { className: 'list-item', title: `${(s.filepath || '').replace(/\\/g, '/')}:${s.line}` }, [
          h('span', { className: 'name clickable', text: label, style: 'flex:1;font-family:var(--font-mono);font-size:10px;color:var(--text-bright);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' }),
          h('span', { className: 'filepath', text: `${shortPath(s.filepath || '')}:${s.line}`, style: 'flex-shrink:0;max-width:260px;font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left' }),
        ]);
        item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(s.filepath, s.line); });
        container.appendChild(item);
      } else {
        // Repeated line → one header (+ ×count) with indented locations beneath.
        container.appendChild(h('div', {
          style: 'padding:3px 8px 1px;font-family:var(--font-mono);font-size:10px;color:var(--text-bright);display:flex;gap:8px',
        }, [
          h('span', { text: label, style: 'flex:2 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' }),
          h('span', { text: '×' + locs.length, style: 'flex-shrink:0;color:var(--text-muted)' }),
        ]));
        for (const s of locs) container.appendChild(locRow(s, true));
      }
    }
    return;
  }

  for (const s of sites) {
    const spans = columns.map(c => {
      const attrs = {
        className: c.className || 'metric',
        text: c.get(s) || '',
        style: (typeof c.style === 'function' ? c.style(s) : c.style) || 'font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis',
      };
      // Optional per-cell tooltip — used by the Exports "used by" column to
      // carry the full importer list when the cell is ellipsis-truncated.
      const tip = c.title ? c.title(s) : '';
      if (tip) attrs.title = tip;
      return h('span', attrs);
    });
    const itemAttrs = { className: 'list-item', title: `${(s.filepath || '').replace(/\\/g, '/')}:${s.line}` };
    // Optional vertical alignment override (.list-item is align-items:center by
    // default) — used when a wrapping cell makes the row multi-line.
    if (align) itemAttrs.style = `align-items:${align}`;
    const item = h('div', itemAttrs, spans);
    item.addEventListener('click', (e) => { e.stopPropagation(); onFileClick(s.filepath, s.line); });
    container.appendChild(item);
  }
}
