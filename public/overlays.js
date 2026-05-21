/**
 * overlays.js — Non-modal floating panels.
 *
 * Two surfaces currently:
 *
 *   1. Compare side-by-side overlay (for dupe groups, near-dupe groups,
 *      structural-dupe groups, and Notable Funcstring Match groups).
 *      Up to 3 panes side-by-side with prev/next pagination.
 *
 *   2. Extraction-prompt viewer — the input-side floating panel that
 *      shows the assembled claim-extraction prompt (system prompt +
 *      user message) before it's sent to the LLM. TODO #368, input-side
 *      half. Non-modal so the user can interact with the main UI while
 *      it's open.
 *
 * Both surfaces use `.floating-panel` styling and are made draggable +
 * resizable via the helpers in `dom-utils.js`.
 */

import { $, escHtml, shortPath, makeDraggable, makeResizable } from './dom-utils.js';
import { api } from './api.js';

// ============================================================================
// Compare side-by-side overlay
// ============================================================================

const MAX_COMPARE_PANES = 3;

/** Create a draggable resize handle for side-by-side panes. */
export function makeResizeHandle() {
  const handle = document.createElement('div');
  handle.className = 'compare-resize-handle';
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const container = handle.parentElement;
    const leftPane = handle.previousElementSibling;
    const rightPane = handle.nextElementSibling;
    if (!leftPane || !rightPane) return;

    const startX = e.clientX;
    const startLeftWidth = leftPane.getBoundingClientRect().width;
    const startRightWidth = rightPane.getBoundingClientRect().width;
    const totalWidth = startLeftWidth + startRightWidth;

    // Remove flex so we can set explicit widths
    leftPane.style.flex = 'none';
    rightPane.style.flex = 'none';
    leftPane.style.width = startLeftWidth + 'px';
    rightPane.style.width = startRightWidth + 'px';

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newLeft = Math.max(80, Math.min(totalWidth - 80, startLeftWidth + dx));
      const newRight = totalWidth - newLeft;
      leftPane.style.width = newLeft + 'px';
      rightPane.style.width = newRight + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  return handle;
}

export async function openCompareView(group, type) {
  const overlay = $('#compare-overlay');
  const body = $('#compare-body');
  const title = $('#compare-title');
  const nav = $('#compare-nav');

  const instances = group.instances || [];
  const totalCount = instances.length || (group.files || []).length;
  const label = type === 'near' ? 'Near Dupe'
              : type === 'struct' ? 'Structural Dupe'
              : type === 'surprising' ? 'Notable Funcstring Match'
              : 'Duplicate';
  title.textContent = `${label}: ${group.name}`;

  // Show up to MAX_COMPARE_PANES at a time
  let offset = 0;

  async function renderPanes() {
    body.innerHTML = '';
    const showCount = Math.min(MAX_COMPARE_PANES, totalCount - offset);

    if (totalCount > MAX_COMPARE_PANES) {
      nav.textContent = `Showing ${offset + 1}–${offset + showCount} of ${totalCount}`;
    } else {
      nav.textContent = `${totalCount} copies`;
    }

    for (let i = 0; i < showCount; i++) {
      const idx = offset + i;
      const inst = instances[idx];
      if (!inst) continue;

      const pane = document.createElement('div');
      pane.className = 'compare-pane';

      // Header
      const header = document.createElement('div');
      header.className = 'compare-pane-header';
      header.innerHTML = `<span class="pane-idx">${idx + 1}</span>` +
        `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(inst.name || group.name)}">${escHtml(inst.display_name || inst.name || group.name)}</span>` +
        `<span class="pane-file" title="${escHtml(inst.filepath)}">${escHtml(shortPath(inst.filepath, 35))}</span>`;
      pane.appendChild(header);

      // Body — load source
      const paneBody = document.createElement('div');
      paneBody.className = 'compare-pane-body';
      paneBody.innerHTML = '<pre style="color:var(--text-muted)">Loading…</pre>';
      pane.appendChild(paneBody);
      // Add resize handle between panes (not before first)
      if (i > 0) body.appendChild(makeResizeHandle());
      body.appendChild(pane);

      // Fetch source
      const funcSpec = `${inst.filepath}@${inst.name || group.name}`;
      try {
        const data = await api.extract({ func: funcSpec });
        if (data.source) {
          const lines = data.source.split('\n');
          const startLine = data.start_line || 1;
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
          paneBody.innerHTML = `<pre style="color:var(--text-muted)">No source found</pre>`;
        }
      } catch (err) {
        paneBody.innerHTML = `<pre style="color:var(--accent)">Error: ${escHtml(err.message)}</pre>`;
      }
    }

    // Add prev/next buttons if needed
    if (totalCount > MAX_COMPARE_PANES) {
      const navBar = document.createElement('div');
      navBar.style.cssText = 'position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:10';
      if (offset > 0) {
        const prevBtn = document.createElement('button');
        prevBtn.className = 'btn-secondary';
        prevBtn.textContent = '← Previous';
        prevBtn.addEventListener('click', () => { offset = Math.max(0, offset - MAX_COMPARE_PANES); renderPanes(); });
        navBar.appendChild(prevBtn);
      }
      if (offset + MAX_COMPARE_PANES < totalCount) {
        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn-secondary';
        nextBtn.textContent = 'Next →';
        nextBtn.addEventListener('click', () => { offset += MAX_COMPARE_PANES; renderPanes(); });
        navBar.appendChild(nextBtn);
      }
      // Append to the overlay container
      const existing = overlay.querySelector('.compare-nav-bar');
      if (existing) existing.remove();
      navBar.className = 'compare-nav-bar';
      overlay.appendChild(navBar);
    }
  }

  await renderPanes();
  overlay.classList.remove('hidden');
}

export function initCompareOverlay() {
  const panel = $('#compare-overlay');

  // Close button
  $('#compare-close').addEventListener('click', () => {
    panel.classList.add('hidden');
    const navBar = document.querySelector('.compare-nav-bar');
    if (navBar) navBar.remove();
  });

  // Draggable header
  makeDraggable(panel, $('#compare-drag-handle'));

  // Resizable from bottom-right corner
  makeResizable(panel, $('#compare-resize-se'));
}


// ============================================================================
// Extraction-prompt viewer (TODO #368, input-side half)
// ============================================================================
// Non-modal floating-panel popup — main UI stays interactive while open.

// Dependencies injected by setupExtractionPromptOverlay. `stripAtFileHeader`
// lives in app.js's workspace section (it's a workspace-text utility, not
// strictly an overlay concern), so it's passed in rather than imported.
let _stripAtFileHeader = (s) => s ? s.trim() : '';

export function setupExtractionPromptOverlay(deps = {}) {
  if (typeof deps.stripAtFileHeader === 'function') {
    _stripAtFileHeader = deps.stripAtFileHeader;
  }
  const panel = $('#extraction-prompt-overlay');
  if (!panel) return;
  $('#extraction-prompt-close').addEventListener('click', () => panel.classList.add('hidden'));
  makeDraggable(panel, $('#extraction-prompt-drag-handle'));
  makeResizable(panel, $('#extraction-prompt-resize-se'));
}

export async function showExtractionPrompt() {
  const panel = $('#extraction-prompt-overlay');
  const body = $('#extraction-prompt-body');
  const meta = $('#extraction-prompt-meta');
  const caption = $('#extraction-prompt-caption');
  if (!panel || !body) return;

  let claim = $('#claim-text').value.trim();
  if (!claim) {
    meta.textContent = '';
    if (caption) caption.style.display = 'none';
    body.textContent = 'Paste a claim in the workspace textarea first, then click "Show extraction prompt".';
    panel.classList.remove('hidden');
    return;
  }
  claim = _stripAtFileHeader(claim);

  const engine = $('#ws-engine').value;
  const vocabTight = $('#ws-vocab-tight')?.checked || false;
  const noVocabulary = $('#ws-no-vocab')?.checked || false;

  // Caption: this popup renders only one branch of the Vocab-Tight conditional.
  // Tell the user the other variant exists and how to see it.
  if (caption) {
    if (noVocabulary) {
      caption.style.display = 'none';
    } else {
      const cur = vocabTight ? 'ON' : 'OFF';
      const other = vocabTight ? 'OFF' : 'ON';
      caption.textContent =
        `Showing the Vocab-Tight = ${cur} variant. `
        + `Toggle the checkbox and reopen to see the ${other} variant.`;
      caption.style.display = '';
    }
  }

  meta.textContent = 'loading…';
  body.textContent = '';
  panel.classList.remove('hidden');

  try {
    const data = await api.claimExtractionPrompt({ claim, engine, vocabTight, noVocabulary });
    const kwCount = (data.keywords || []).length;
    meta.textContent = `engine: ${data.engine} • vocab: ${data.vocabChars} chars • keywords: ${kwCount}`;
    body.innerHTML =
        `<div style="color:var(--text-muted);margin-bottom:4px">— SYSTEM PROMPT —</div>`
      + `<div style="margin-bottom:14px">${escHtml(data.systemPrompt || '')}</div>`
      + `<div style="color:var(--text-muted);margin-bottom:4px">— USER MESSAGE (claim) —</div>`
      + `<div>${escHtml(data.userMessage || '')}</div>`;
  } catch (err) {
    meta.textContent = '';
    if (caption) caption.style.display = 'none';
    body.textContent = `Error: ${err.message}`;
  }
}
