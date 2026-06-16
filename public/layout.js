/**
 * layout.js — Layout / window management for the GUI.
 *
 * Owns: column resizers between the left and middle panes; horizontal
 * split handles (workspace ↔ middle-top ↔ middle-bottom); the left-pane
 * filter input; and the pane-show / pane-hide / Window-menu plumbing.
 *
 * Cross-cutting callbacks needed by window management (`consoleAppend`,
 * `fsConsoleAppend`, `executeConsoleCommand` for console-output routing,
 * `openDiagramFullscreen` for the diagram-fullscreen path) are injected
 * via `initWindowManagement({...})` rather than imported, so this module
 * doesn't take a direct dependency on `console.js` or the render flows
 * in app.js (avoiding a console.js ↔ layout.js import cycle).
 *
 * Exports `showPane` and `hidePane` so console.js can show the
 * right-bottom pane when the user invokes the Console.
 */

import { $, $$, makeDraggable, bringToFront, downloadText, extractPaneText, paneSaveName, copyToClipboard } from './dom-utils.js';
import { state } from './state.js';

// ============================================================================
// Cross-cutting callbacks (injected by initWindowManagement)
// ============================================================================

let _consoleAppend = () => {};
let _fsConsoleAppend = () => {};
let _executeConsoleCommand = () => {};
let _openDiagramFullscreen = () => {};


// ============================================================================
// Column resizers
// ============================================================================

// Column resizers
// ========================================================================
export function initColumnResizers() {
  initColResize('col-handle-left', 'left-pane', true);
  initColResize('col-handle-right', 'right-pane', false);
}

function initColResize(handleId, paneId, isLeft) {
  const handle = $(`#${handleId}`), pane = $(`#${paneId}`);
  if (!handle || !pane) return;
  let startX, startW;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX; startW = pane.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (e2) => {
      const delta = e2.clientX - startX;
      pane.style.width = `${Math.max(150, isLeft ? startW + delta : startW - delta)}px`;
      pane.style.flex = 'none';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}


// ========================================================================
// Horizontal split handles
// ========================================================================
export function initSplitHandles() {
  initVerticalSplit('middle-split-handle', 'middle-top', 'middle-bottom');
  initVerticalSplit('right-split-handle', 'right-top', 'right-bottom');
}

function initVerticalSplit(handleId, topId, bottomId) {
  const handle = $(`#${handleId}`), top = $(`#${topId}`), bottom = $(`#${bottomId}`);
  if (!handle || !top || !bottom) return;
  let startY, startTopH;
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startY = e.clientY; startTopH = top.getBoundingClientRect().height;
    const onMove = (e2) => { top.style.flex = 'none'; top.style.height = `${Math.max(80, startTopH + e2.clientY - startY)}px`; bottom.style.flex = '1'; };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}


// ========================================================================

// ============================================================================
// Filter
// ============================================================================

// Filter
// ========================================================================
export function initFilter() {
  $('#left-filter').addEventListener('input', () => {
    clearTimeout(state._filterTimer);
    state._filterTimer = setTimeout(() => {
      const filter = $('#left-filter').value.trim();
      for (const sec of $$('.accordion-section.open')) {
        const sectionId = sec.dataset.section;
        state.sectionData[sectionId] = null;
        loadSectionData(sectionId, filter);
      }
    }, 300);
  });
}


// ========================================================================

// ============================================================================
// Window management — close/show panes, popout, Window menu
// ============================================================================

// Window management — close/show panes, popout, Window menu
// ========================================================================
const PANE_IDS = ['middle-top', 'middle-bottom', 'right-top', 'right-bottom'];

export function initWindowManagement() {
  // Close buttons (hide pane)
  for (const btn of $$('[data-close]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.close;
      hidePane(paneId);
    });
  }

  // Window menu checkboxes
  for (const id of PANE_IDS) {
    const cb = $(`#win-${id}`);
    if (cb) {
      cb.addEventListener('change', () => {
        if (cb.checked) showPane(id); else hidePane(id);
      });
    }
  }

  // Reset layout
  const resetBtn = $('[data-action="reset-layout"]');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      for (const id of PANE_IDS) showPane(id);
    });
  }

  // Generic popout buttons
  for (const btn of $$('[data-popout]')) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const paneId = btn.dataset.popout;
      // For diagram pane, use existing diagram fullscreen
      if (paneId === 'right-top') {
        _openDiagramFullscreen();
        return;
      }
      openGenericFullscreen(paneId);
    });
  }

  // Left pane popout
  $('#left-pane-popout')?.addEventListener('click', () => openGenericFullscreen('left-pane'));

  // Generic fullscreen close
  $('#generic-fs-close')?.addEventListener('click', closeGenericFullscreen);
  $('#generic-fullscreen')?.addEventListener('click', (e) => {
    if (e.target === $('#generic-fullscreen')) closeGenericFullscreen();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#generic-fullscreen').classList.contains('hidden')) closeGenericFullscreen();
  });

  // #177: make the pop-out windows draggable by their header so the user can
  // move them aside and see/work underneath. makeDraggable is modal-aware
  // (forces position:fixed on first drag), so the flex-centered window detaches
  // and moves. Wired once on the static overlay markup; covers both the generic
  // pane pop-out (left / middle / right-bottom / workspace) and the diagram
  // pop-out (right-top). CSS makes the overlays non-blocking (pointer-events).
  for (const ovId of ['#generic-fullscreen', '#diagram-fullscreen']) {
    const overlay = $(ovId);
    const win = $(`${ovId} .fullscreen-diagram`);
    const handle = $(`${ovId} .fullscreen-header`);
    if (win && handle) makeDraggable(win, handle);
    // #177: clicking anywhere in a pop-out raises its overlay above the others.
    if (overlay && win) win.addEventListener('mousedown', () => bringToFront(overlay));
  }

  // #177: per-pane Save (download text) + Copy (clipboard) header icons.
  // Capture phase + stopPropagation so a Save/Copy click inside the workspace
  // handle doesn't also toggle the workspace (its handler only ignores
  // #workspace-popout by id, app.js:993).
  function flashPaneAction(btn) {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = orig; }, 1200);
  }
  document.addEventListener('click', (e) => {
    const saveBtn = e.target.closest('[data-save]');
    if (saveBtn) {
      // Only swallow the event for workspace-handle buttons (whose ancestor
      // toggles the workspace); elsewhere let the click bubble normally.
      if (saveBtn.closest('#workspace-toggle')) e.stopPropagation();
      const body = $('#' + saveBtn.dataset.save);
      const ext = saveBtn.dataset.md ? '.md' : '.txt';
      downloadText(paneSaveName(body, saveBtn.dataset.name) + ext, extractPaneText(body, { lineNumbers: e.shiftKey }));
      flashPaneAction(saveBtn);
      return;
    }
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      if (copyBtn.closest('#workspace-toggle')) e.stopPropagation();
      copyToClipboard(extractPaneText($('#' + copyBtn.dataset.copy), { lineNumbers: e.shiftKey })).then(() => flashPaneAction(copyBtn));
      return;
    }
  }, true);

  // #177: pop-out header Save/Copy act on whatever pane is currently popped.
  $('#generic-fs-save')?.addEventListener('click', (e) => {
    const name = ($('#generic-fs-title')?.textContent || 'pane').trim().replace(/[^\w.-]+/g, '_') || 'pane';
    downloadText(name + '.txt', extractPaneText($('#generic-fs-body'), { lineNumbers: e.shiftKey }));
    flashPaneAction($('#generic-fs-save'));
  });
  $('#generic-fs-copy')?.addEventListener('click', (e) => {
    copyToClipboard(extractPaneText($('#generic-fs-body'), { lineNumbers: e.shiftKey })).then(() => flashPaneAction($('#generic-fs-copy')));
  });
}

export function hidePane(id) {
  const pane = $(`#${id}`);
  if (pane) pane.classList.add('pane-hidden');
  const cb = $(`#win-${id}`);
  if (cb) cb.checked = false;
}

export function showPane(id) {
  const pane = $(`#${id}`);
  if (pane) pane.classList.remove('pane-hidden');
  const cb = $(`#win-${id}`);
  if (cb) cb.checked = true;
}

export function openGenericFullscreen(paneId) {
  let paneBody, titleText;

  // #177: re-center the floating window on each open (clear any prior drag so a
  // pop-out doesn't reopen off-screen where it was last dragged).
  const _gwin = $('#generic-fullscreen .fullscreen-diagram');
  if (_gwin) { _gwin.style.position = ''; _gwin.style.left = ''; _gwin.style.top = ''; _gwin.style.right = ''; }

  // #177: the analysis pane carries its own Copy Analysis / Copy Prompt buttons
  // (reparented into the pop-out), so suppress the redundant generic pop-out
  // Copy for it; every other pane gets it.
  const _fsCopy = $('#generic-fs-copy');
  if (_fsCopy) _fsCopy.style.display = (paneId === 'right-bottom') ? 'none' : '';

  if (paneId === 'right-bottom') {
    const activeTab = $('#right-bottom .pane-tab.active');
    titleText = activeTab?.textContent || 'Panel';
    if (activeTab?.dataset.tab === 'console') {
      // Console popout: build a live console in fullscreen
      const overlay = $('#generic-fullscreen');
      const fsBody = $('#generic-fs-body');
      const fsTitle = $('#generic-fs-title');
      fsTitle.textContent = 'Console';
      fsBody.innerHTML = '';
      fsBody.style.display = 'flex';
      fsBody.style.flexDirection = 'column';
      fsBody.style.padding = '0';

      // Clone existing output
      const outputDiv = document.createElement('div');
      outputDiv.className = 'console-output';
      outputDiv.id = 'fs-console-output';
      outputDiv.innerHTML = $('#console-output').innerHTML;

      const inputRow = document.createElement('div');
      inputRow.className = 'console-input-row';
      inputRow.innerHTML = '<span class="console-prompt">❯</span><input type="text" id="fs-console-input" placeholder="Type command (try /help)…" spellcheck="false" autocomplete="off">';

      fsBody.appendChild(outputDiv);
      fsBody.appendChild(inputRow);
      overlay.classList.remove('hidden');

      const fsInput = $('#fs-console-input');
      fsInput.focus();
      fsInput.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
          const cmd = fsInput.value.trim();
          if (!cmd) return;
          consoleHistory.push(cmd);
          consoleHistoryIdx = consoleHistory.length;
          // Append to both outputs
          _fsConsoleAppend(`❯ ${cmd}`, 'console-cmd');
          _consoleAppend(`❯ ${cmd}`, 'console-cmd');
          fsInput.value = '';
          const origAppend = window._consoleAppendTarget;
          window._consoleAppendTarget = 'both';
          try { await _executeConsoleCommand(cmd); }
          catch (err) { _fsConsoleAppend(`Error: ${err.message}`, 'console-err'); _consoleAppend(`Error: ${err.message}`, 'console-err'); }
          window._consoleAppendTarget = origAppend;
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (consoleHistoryIdx > 0) { consoleHistoryIdx--; fsInput.value = consoleHistory[consoleHistoryIdx]; }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (consoleHistoryIdx < consoleHistory.length - 1) { consoleHistoryIdx++; fsInput.value = consoleHistory[consoleHistoryIdx]; }
          else { consoleHistoryIdx = consoleHistory.length; fsInput.value = ''; }
        }
      });
      return;
    } else {
      paneBody = $('#right-bottom-body');
    }
  } else if (paneId === 'left-pane') {
    paneBody = $('#left-body');
    titleText = 'Indexes & Metrics';
    // Also reparent the filter bar
    state._fsFilterBar = $('#left-pane > .pane-filter');
    state._fsFilterParent = state._fsFilterBar?.parentElement;
  } else if (paneId === 'workspace') {
    paneBody = $('#workspace-body');
    titleText = 'Claim / Multisect Workspace';
  } else {
    paneBody = $(`#${paneId}-body`) || $(`#${paneId} .pane-body`);
    const paneTitle = $(`#${paneId}-title`) || $(`#${paneId} .pane-header span`);
    titleText = paneTitle?.textContent || 'Panel';
  }

  if (!paneBody) return;
  const overlay = $('#generic-fullscreen');
  const fsBody = $('#generic-fs-body');
  const fsTitle = $('#generic-fs-title');

  fsTitle.textContent = titleText;
  // Reparent the actual DOM node so live updates are visible in fullscreen
  fsBody.innerHTML = '';
  state._fsReturnTarget = paneBody.parentElement;
  state._fsReturnNode = paneBody;
  if (state._fsFilterBar) fsBody.appendChild(state._fsFilterBar);
  fsBody.appendChild(paneBody);
  // #177: the pop-out *moves* (reparents) the live pane node into the floating
  // window, so the docked slot would otherwise go blank. Drop a placeholder in
  // its place so the empty slot reads as intentional and doubles as a one-click
  // "pop back in" control.
  const ph = document.createElement('div');
  ph.className = 'pane-popout-placeholder';
  ph.textContent = '▣ Popped out — click to return';
  ph.addEventListener('click', closeGenericFullscreen);
  state._fsPlaceholder = ph;
  state._fsReturnTarget.appendChild(ph);
  overlay.classList.remove('hidden');
}

function closeGenericFullscreen() {
  const fsBody = $('#generic-fs-body');
  // Clear inline height on workspace textarea so it returns to flex sizing
  const ta = $('#claim-text');
  if (ta) ta.style.height = '';
  // Move reparented nodes back BEFORE hiding overlay (avoids layout loss)
  if (state._fsFilterBar && state._fsFilterParent) {
    state._fsFilterParent.insertBefore(state._fsFilterBar, state._fsFilterParent.firstChild);
    state._fsFilterBar = null;
    state._fsFilterParent = null;
  }
  // #177: remove the docked-slot placeholder before the live node returns to it.
  if (state._fsPlaceholder) {
    state._fsPlaceholder.remove();
    state._fsPlaceholder = null;
  }
  if (state._fsReturnTarget && state._fsReturnNode) {
    state._fsReturnTarget.appendChild(state._fsReturnNode);
    // Force the browser to recalculate layout after reparenting
    state._fsReturnNode.offsetHeight;
    state._fsReturnTarget = null;
    state._fsReturnNode = null;
  }
  // Now hide overlay and clean up fullscreen container
  $('#generic-fullscreen').classList.add('hidden');
  while (fsBody.firstChild) fsBody.removeChild(fsBody.firstChild);
  fsBody.style.display = '';
  fsBody.style.padding = '';
  window._consoleAppendTarget = null;
}


// ========================================================================

// Wrapper that accepts cross-cutting deps and then runs the local
// initWindowManagement() defined above.
const _initWindowManagementLocal = initWindowManagement;
export function initWindowManagementWithDeps(deps = {}) {
  if (typeof deps.consoleAppend === 'function') _consoleAppend = deps.consoleAppend;
  if (typeof deps.fsConsoleAppend === 'function') _fsConsoleAppend = deps.fsConsoleAppend;
  if (typeof deps.executeConsoleCommand === 'function') _executeConsoleCommand = deps.executeConsoleCommand;
  if (typeof deps.openDiagramFullscreen === 'function') _openDiagramFullscreen = deps.openDiagramFullscreen;
  _initWindowManagementLocal();
}
