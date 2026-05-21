/**
 * mermaid.js — Mermaid-diagram rendering for the right-top pane and
 * its fullscreen overlay. Owns the zoom controls, the SVG/PNG export
 * paths, and the three-pane Relationship View that opens when the
 * user clicks a node in a call-tree diagram.
 *
 * No DI needed — every dependency is already exported from a leaf
 * module (state, api, dom-utils, overlays, dialogs, layout). This is
 * the first peel where the extracted module talks back to app.js
 * only through `state` and global side effects (mermaid SVG render,
 * DOM clicks).
 */

import { state } from './state.js';
import { api } from './api.js';
import { $, $$, escHtml, shortPath } from './dom-utils.js';
import { makeResizeHandle } from './overlays.js';
import { showSearchDialog } from './dialogs.js';


// ============================================================================
// Render
// ============================================================================

/**
 * @param {string} mermaidText
 * @param {HTMLElement} container
 * @param {string|null} rootNodeName - highlighted node
 * @param {object} [opts]
 * @param {function} [opts.onNodeClick] - callback(nodeId, labelText) when node is clicked
 * @param {function} [opts.onEdgeClick] - callback(sourceId, targetId, labelText) when edge is clicked
 * @param {object} [opts.nodeIdMap] - nodeId -> metadata (e.g. filepath), passed to callbacks
 */
export function renderMermaid(mermaidText, container, rootNodeName, opts = {}) {
  state.lastMermaidText = mermaidText;
  state.lastMermaidRoot = rootNodeName || null;
  state.lastMermaidOpts = opts;
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
    mermaid.render(id, fullText).then(({ svg }) => {
      container.innerHTML = svg;
      // Wire up click handlers on SVG nodes and edges
      wireMermaidClicks(container, opts);
    }).catch(err => {
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

/**
 * Attach click handlers to Mermaid SVG nodes and edges after rendering.
 * Nodes are <g> elements with class "node" and an id matching the node ID.
 * Edges are <g> elements with class "edgePath" or "edge-label".
 */
export function wireMermaidClicks(container, opts = {}) {
  const svg = container.querySelector('svg');
  if (!svg) return;

  // Make nodes clickable
  if (opts.onNodeClick) {
    for (const node of svg.querySelectorAll('g.node')) {
      node.style.cursor = 'pointer';
      node.addEventListener('click', (e) => {
        e.stopPropagation();
        const nodeId = node.id.replace(/^flowchart-/, '').replace(/-\d+$/, '');
        let label = node.querySelector('.nodeLabel, text')?.textContent || nodeId;
        // Reverse Mermaid sanitization
        label = label.replace(/‹/g, '<').replace(/›/g, '>').replace(/'/g, '"').replace(/\+/g, '&');
        opts.onNodeClick(nodeId, label, opts.nodeIdMap);
      });
    }
  }

  // Make edge labels clickable
  if (opts.onEdgeClick) {
    for (const edgeLabel of svg.querySelectorAll('.edgeLabel')) {
      const labelText = edgeLabel.textContent?.trim();
      if (labelText) {
        edgeLabel.style.cursor = 'pointer';
        edgeLabel.addEventListener('click', (e) => {
          e.stopPropagation();
          // Try to find the parent edge path to determine source/target
          const edgeId = edgeLabel.id || '';
          opts.onEdgeClick(edgeId, labelText, opts.nodeIdMap);
        });
      }
    }
  }
}


// ============================================================================
// Relationship view + file-map edge detail
// ============================================================================

/**
 * Open a three-pane relationship view: source | diagram | source.
 * Used when clicking a node in a call tree diagram.
 */
export async function openRelationshipView(rootFunc, clickedFunc) {
  const overlay = $('#compare-overlay');
  const body = $('#compare-body');
  const title = $('#compare-title');
  const nav = $('#compare-nav');

  title.textContent = `${rootFunc} → ${clickedFunc}`;
  nav.textContent = 'Relationship View';
  body.innerHTML = '';

  // Left pane: root function source
  const leftPane = document.createElement('div');
  leftPane.className = 'compare-pane';
  leftPane.innerHTML = `<div class="compare-pane-header"><span class="pane-idx">1</span><span style="flex:1">${escHtml(rootFunc)}</span></div><div class="compare-pane-body"><pre style="color:var(--text-muted)">Loading…</pre></div>`;
  body.appendChild(leftPane);

  // Resize handle
  body.appendChild(makeResizeHandle());

  // Center pane: focused diagram
  const centerPane = document.createElement('div');
  centerPane.className = 'compare-pane';
  centerPane.innerHTML = `<div class="compare-pane-header"><span class="pane-idx" style="background:var(--text-muted)">↔</span><span style="flex:1">Call Path</span></div><div class="compare-pane-body" id="relationship-diagram" style="padding:8px"><div style="color:var(--text-muted)">Loading diagram…</div></div>`;
  body.appendChild(centerPane);

  // Resize handle
  body.appendChild(makeResizeHandle());

  // Right pane: clicked function source
  const rightPane = document.createElement('div');
  rightPane.className = 'compare-pane';
  rightPane.innerHTML = `<div class="compare-pane-header"><span class="pane-idx">2</span><span style="flex:1">${escHtml(clickedFunc)}</span></div><div class="compare-pane-body"><pre style="color:var(--text-muted)">Loading…</pre></div>`;
  body.appendChild(rightPane);

  overlay.classList.remove('hidden');

  // Fetch sources and diagram in parallel
  const loadSource = async (pane, funcName) => {
    const paneBody = pane.querySelector('.compare-pane-body');
    const header = pane.querySelector('.compare-pane-header');
    try {
      let data = await api.extract({ func: funcName });
      // If ambiguous, pick the first match
      if (data.ambiguous && data.matches && data.matches.length > 0) {
        const m = data.matches[0];
        data = await api.extract({ func: `${m.filepath}@${m.name}` });
      }
      if (data.source) {
        if (data.filepath) {
          header.innerHTML += `<span class="pane-file" title="${escHtml(data.filepath)}">${escHtml(shortPath(data.filepath, 30))}</span>`;
        }
        const lines = data.source.split('\n');
        const startLine = data.start_line || data.start || 1;
        const pre = document.createElement('pre');
        for (let li = 0; li < lines.length; li++) {
          const numSpan = document.createElement('span');
          numSpan.className = 'line-num';
          numSpan.textContent = String(startLine + li);
          pre.appendChild(numSpan);
          pre.appendChild(document.createTextNode(lines[li] + '\n'));
        }
        paneBody.innerHTML = '';
        paneBody.appendChild(pre);
      } else {
        paneBody.innerHTML = `<pre style="color:var(--text-muted)">"${escHtml(funcName)}" — source not available (may be external)</pre>`;
      }
    } catch (err) {
      // Function may be external/library — show that clearly
      const msg = err.message.includes('not found')
        ? `"${funcName}" — external or unresolved (not in index)`
        : `Error: ${err.message}`;
      paneBody.innerHTML = `<pre style="color:var(--text-muted)">${escHtml(msg)}</pre>`;
    }
  };

  const loadDiagram = async () => {
    try {
      const data = await api.callTree({ func: rootFunc, depth: 2 });
      if (data.mermaid) {
        const diagramEl = document.getElementById('relationship-diagram');
        renderMermaid(data.mermaid, diagramEl, rootFunc);
      }
    } catch (err) {
      const diagramEl = document.getElementById('relationship-diagram');
      if (diagramEl) diagramEl.innerHTML = `<div style="color:var(--accent)">Diagram error: ${escHtml(err.message)}</div>`;
    }
  };

  // Load all three in parallel
  await Promise.all([
    loadSource(leftPane, rootFunc),
    loadDiagram(),
    loadSource(rightPane, clickedFunc),
  ]);
}

/**
 * Open a file-map edge detail popup showing function-to-function calls between two files.
 */
export async function openFileMapEdgeDetail(edgeId, labelText, nodeIdMap) {
  // Parse the count from the edge label (e.g. "47")
  const count = parseInt(labelText) || 0;

  // Try to identify source and target files from the edge
  // Mermaid edge labels don't directly encode source/target, but we can
  // find them from the SVG structure or the nodeIdMap
  const overlay = $('#compare-overlay');
  const body = $('#compare-body');
  const title = $('#compare-title');
  const nav = $('#compare-nav');

  title.textContent = `File Dependencies: ${count} cross-file calls`;
  nav.textContent = 'Click function names to view source';
  body.innerHTML = '<div class="compare-pane" style="flex:1"><div class="compare-pane-header"><span class="pane-idx">↔</span><span style="flex:1">Loading inter-file call details…</span></div><div class="compare-pane-body" style="padding:12px"><div style="color:var(--text-muted)">Analyzing connections…</div></div></div>';
  overlay.classList.remove('hidden');

  // For now, show a message — full implementation needs the server to return
  // per-edge function call details (which functions in file A call which in file B)
  body.querySelector('.compare-pane-body').innerHTML = `<div style="padding:12px;color:var(--text-muted)">
    <p>Edge represents <strong>${count}</strong> function call${count !== 1 ? 's' : ''} between files.</p>
    <p style="margin-top:8px">Full per-function detail requires a new API endpoint (TODO #301).<br>
    Use <em>Call Inventory</em> in the left panel to explore cross-file calls.</p>
  </div>`;
}


// ============================================================================
// Zoom + controls + fullscreen
// ============================================================================

export function applyDiagramZoom(viewport) {
  if (!viewport) viewport = $('#diagram-viewport');
  if (viewport) viewport.style.transform = `scale(${state.diagramZoom})`;
}

export function initDiagramControls() {
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

  // Save diagram buttons
  $('#diagram-save-svg').addEventListener('click', () => saveDiagramSvg($('#diagram-viewport')));
  $('#diagram-save-png').addEventListener('click', () => saveDiagramPng($('#diagram-viewport')));
  $('#fs-save-svg').addEventListener('click', () => saveDiagramSvg($('#fullscreen-viewport')));
  $('#fs-save-png').addEventListener('click', () => saveDiagramPng($('#fullscreen-viewport')));
}

// Strip directory path from filename (browsers only support saving to Downloads)
function sanitizeDownloadName(name) {
  // Strip any directory components — browser download can only set filename
  return name.replace(/^.*[\\/]/, '');
}

function saveDiagramSvg(viewport) {
  const svg = viewport?.querySelector('svg');
  if (!svg) return;
  const defaultName = (state.lastMermaidRoot || 'diagram') + '.svg';
  showSearchDialog('Save SVG', 'Filename (saves to Downloads):').then(r => {
    if (!r) return;
    let name = sanitizeDownloadName(r.query);
    if (!name.endsWith('.svg')) name += '.svg';
    const svgData = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
    showSaveNotification(`Saved: ${name} (check browser Downloads)`);
  });
  setTimeout(() => { const inp = $('#search-dialog-input'); if (inp) inp.value = defaultName; }, 120);
}

function saveDiagramPng(viewport) {
  const svg = viewport?.querySelector('svg');
  if (!svg) return;
  const defaultName = (state.lastMermaidRoot || 'diagram') + '.png';
  showSearchDialog('Save PNG', 'Filename (saves to Downloads):').then(r => {
    if (!r) return;
    let name = sanitizeDownloadName(r.query);
    if (!name.endsWith('.png')) name += '.png';
    const origTransform = viewport.style.transform;
    viewport.style.transform = 'scale(1)';
    const svgData = new XMLSerializer().serializeToString(svg);
    viewport.style.transform = origTransform;

    // Use intrinsic SVG dimensions for better quality
    const svgW = svg.viewBox?.baseVal?.width || svg.getAttribute('width') || svg.getBoundingClientRect().width;
    const svgH = svg.viewBox?.baseVal?.height || svg.getAttribute('height') || svg.getBoundingClientRect().height;
    const w = parseFloat(svgW) || svg.getBoundingClientRect().width;
    const h = parseFloat(svgH) || svg.getBoundingClientRect().height;
    const scale = 3;  // 3x for crisp output
    const canvas = document.createElement('canvas');
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    const img = new Image();
    img.onload = () => {
      ctx.fillStyle = '#1e1e2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { showSaveNotification('PNG export failed (empty blob)'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        URL.revokeObjectURL(url);
        showSaveNotification(`Saved: ${name} (check browser Downloads)`);
      }, 'image/png');
    };
    img.onerror = () => {
      showSaveNotification('PNG export failed — try Save SVG instead');
    };
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgData)));
  });
  setTimeout(() => { const inp = $('#search-dialog-input'); if (inp) inp.value = defaultName; }, 120);
}

function showSaveNotification(msg) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:20px;right:20px;background:var(--bg-header);color:var(--accent-green);border:1px solid var(--accent-green);padding:8px 16px;border-radius:4px;font-size:12px;z-index:999;opacity:1;transition:opacity 1.5s';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; }, 4000);
  setTimeout(() => el.remove(), 6000);
}

export function openDiagramFullscreen() {
  if (!state.lastMermaidText) return;
  const overlay = $('#diagram-fullscreen');
  overlay.classList.remove('hidden');
  $('#fullscreen-title').textContent = $('#right-top-title').textContent;
  state.diagramZoom = 1.0;
  renderMermaid(state.lastMermaidText, $('#fullscreen-viewport'), state.lastMermaidRoot, state.lastMermaidOpts || {});
}

export function closeDiagramFullscreen() { $('#diagram-fullscreen').classList.add('hidden'); }
