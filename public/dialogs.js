/**
 * dialogs.js — Modal dialogs: Load Index, Build Index, Search, Confirm,
 * Browse GGUF Models. Each lives in a `.modal-overlay` element in
 * index.html. Made draggable by their `.modal-header` (Issue #19) via
 * the `makeDraggable` helper from dom-utils.js.
 *
 * Cross-cutting callbacks (`clearAllPanes`, `showPane`, `refreshLlmStatus`)
 * are injected at init via `initDialogs(...)` rather than imported, so
 * dialogs.js doesn't need to know about render flows / layout machinery
 * that live elsewhere.
 */

import { $, $$, h, escHtml, makeDraggable } from './dom-utils.js';
import { api } from './api.js';
import { state } from './state.js';

// ============================================================================
// Cross-cutting callbacks (injected by initDialogs)
// ============================================================================

let _clearAllPanes = () => {};
let _showPane = () => {};
let _refreshLlmStatus = () => {};

export function initDialogs(deps = {}) {
  if (typeof deps.clearAllPanes === 'function') _clearAllPanes = deps.clearAllPanes;
  if (typeof deps.showPane === 'function') _showPane = deps.showPane;
  if (typeof deps.refreshLlmStatus === 'function') _refreshLlmStatus = deps.refreshLlmStatus;

  // Issue #19: make the static modal dialogs draggable by their header bar.
  // The dynamic #model-browser-overlay is wired in openModelBrowser itself.
  for (const overlayId of ['#search-overlay', '#load-index-overlay', '#build-index-overlay']) {
    const modal = document.querySelector(`${overlayId} .modal`);
    const header = document.querySelector(`${overlayId} .modal-header`);
    if (modal && header) makeDraggable(modal, header);
  }

  initLoadIndex();
  initBuildIndex();
}


// ============================================================================
// Load Index dialog
// ============================================================================

function initLoadIndex() {
  const overlay = $('#load-index-overlay');
  const pathInput = $('#load-index-path');
  const errDiv = $('#load-index-error');
  const browserPanel = $('#load-index-browser');
  const browsePathEl = $('#browse-current-path');
  const dirListEl = $('#browse-dir-list');
  let lastBrowsedDir = null;  // remember last directory for next dialog open

  $('#load-index-close').addEventListener('click', () => overlay.classList.add('hidden'));
  $('#load-index-cancel').addEventListener('click', () => overlay.classList.add('hidden'));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });

  // --- Filesystem browser ---

  async function browseTo(dirPath) {
    try {
      const data = await api.browseDir(dirPath ? { path: dirPath } : {});
      renderBrowser(data);
    } catch (err) {
      dirListEl.innerHTML = `<div class="error-msg" style="padding:8px">${err.message}</div>`;
    }
  }

  function renderBrowser(data) {
    lastBrowsedDir = data.current;
    browsePathEl.textContent = data.current;
    browsePathEl.title = data.current;
    dirListEl.innerHTML = '';

    // ".." entry to go up
    if (data.parent) {
      const upEl = document.createElement('div');
      upEl.className = 'browse-item';
      upEl.innerHTML = '<span class="dir-marker">..</span> <span>(parent directory)</span>';
      upEl.addEventListener('click', () => browseTo(data.parent));
      dirListEl.appendChild(upEl);
    }

    for (const dir of data.dirs) {
      const el = document.createElement('div');
      el.className = 'browse-item' + (dir.isIndex ? ' is-index' : '');
      const fullPath = data.current + data.sep + dir.name;

      const hasWarning = dir.isIndex && dir.missing && dir.missing.length > 0;
      let inner = `<span class="dir-marker">/</span> <span>${dir.name}</span>`;
      if (dir.isIndex && hasWarning) {
        inner += `<span class="index-badge" style="background:#cc6633;color:#fff" title="Missing: ${dir.missing.join(', ')}">incomplete</span>`;
      } else if (dir.isIndex) {
        inner += '<span class="index-badge">index</span>';
      }
      el.innerHTML = inner;

      if (dir.isIndex) {
        // Single click: populate path input
        el.addEventListener('click', () => {
          pathInput.value = fullPath;
          errDiv.style.display = 'none';
        });
        // Double click: populate and load
        el.addEventListener('dblclick', () => {
          pathInput.value = fullPath;
          $('#load-index-ok').click();
        });
      } else {
        // Navigate into regular directory
        el.addEventListener('click', () => browseTo(fullPath));
      }

      dirListEl.appendChild(el);
    }

    // #176: zipped indexes in this directory — click to populate, dbl-click to load.
    for (const z of (data.zips || [])) {
      const el = document.createElement('div');
      el.className = 'browse-item is-index';
      const fullPath = data.current + data.sep + z.name;
      el.innerHTML = `<span class="dir-marker">zip</span> <span>${z.name}</span><span class="index-badge">index .zip</span>`;
      el.addEventListener('click', () => { pathInput.value = fullPath; errDiv.style.display = 'none'; });
      el.addEventListener('dblclick', () => { pathInput.value = fullPath; $('#load-index-ok').click(); });
      dirListEl.appendChild(el);
    }

    if (data.dirs.length === 0 && (!data.zips || data.zips.length === 0)) {
      dirListEl.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">No subdirectories</div>';
    }
  }

  // Browse button toggles the panel
  $('#load-index-browse').addEventListener('click', () => {
    if (browserPanel.style.display === 'none') {
      browserPanel.style.display = 'block';
      const startPath = pathInput.value.trim() || lastBrowsedDir || null;
      browseTo(startPath);
    } else {
      browserPanel.style.display = 'none';
    }
  });

  // --- Load button ---

  $('#load-index-ok').addEventListener('click', async () => {
    const indexPath = pathInput.value.trim();
    if (!indexPath) { errDiv.textContent = 'Enter an index path'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';

    const mode = $('#load-index-add').checked ? 'add' : 'replace';
    try {
      $('#load-index-ok').disabled = true;
      $('#load-index-ok').textContent = 'Loading...';
      errDiv.textContent = 'Loading index — large indexes may take a minute or more...';
      errDiv.style.color = 'var(--text-muted)';
      errDiv.style.display = 'block';
      const result = await api.loadIndex({ path: indexPath, mode });
      errDiv.style.display = 'none';
      errDiv.style.color = '';
      overlay.classList.add('hidden');

      // Remember parent directory for scan-indexes
      state.lastIndexDir = indexPath.replace(/[\\/][^\\/]+$/, '');

      // Refresh UI
      const active = result.indexes.find(i => i.active) || result.indexes[0];
      $('#index-info').textContent = `${active.name} (${active.files.toLocaleString()} files)`;

      // Clear all cached section data and re-collapse
      state.sectionData = {};
      for (const sec of $$('.accordion-section')) {
        sec.classList.remove('open');
        $('.accordion-content', sec).innerHTML = '';
        $('.accordion-badge', sec).textContent = '';
      }

      // #181: pop the Overview window the instant an index loads. app.js listens
      // for this and calls showOverviewOverlay() (buildOverview is cache-fast, so
      // the pop-up is quick). Decoupled via event so dialogs.js stays unaware of
      // the overlay internals.
      window.dispatchEvent(new CustomEvent('ce:index-loaded'));

      // Clear all content panes
      _clearAllPanes();

      // Show warnings for partially valid indexes
      if (result.warnings && result.warnings.length > 0) {
        errDiv.textContent = 'Warning: ' + result.warnings.join('; ');
        errDiv.style.display = 'block';
      }
    } catch (err) {
      errDiv.style.color = '';
      errDiv.textContent = err.message;
      errDiv.style.display = 'block';
    } finally {
      $('#load-index-ok').disabled = false;
      $('#load-index-ok').textContent = 'Load';
    }
  });

  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#load-index-ok').click(); });

  // --- Rebuild button ---
  const rebuildBtn = $('#load-index-rebuild');
  const statusDiv = $('#load-index-status');
  let rebuildPollTimer = null;

  rebuildBtn.addEventListener('click', async () => {
    const indexPath = pathInput.value.trim();
    if (!indexPath) { errDiv.textContent = 'Enter an index path to rebuild'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';

    // First, load the index to get its source path
    try {
      rebuildBtn.disabled = true;
      rebuildBtn.textContent = 'Checking…';
      statusDiv.style.display = 'block';
      statusDiv.textContent = 'Loading index to find original source path…';
      statusDiv.style.color = 'var(--text-muted)';

      const loadResult = await api.loadIndex({ path: indexPath, mode: 'replace' });
      const activeIdx = loadResult.indexes.find(i => i.active);
      let sourcePath = activeIdx?.indexSource;

      if (!sourcePath || sourcePath.startsWith('file list:') || sourcePath.startsWith('glob:')) {
        errDiv.textContent = sourcePath
          ? `Cannot auto-rebuild: index was built from "${sourcePath}" (only directory sources supported)`
          : 'Cannot rebuild: no source path recorded in this index';
        errDiv.style.display = 'block';
        statusDiv.style.display = 'none';
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = 'Rebuild';
        return;
      }

      // Convert Windows paths to WSL paths (e.g. C:\foo\bar -> /mnt/c/foo/bar)
      // ONLY when the server is actually running inside WSL. On a native
      // Windows server (including the standalone .exe) the backend wants the
      // C:\ form as-is; converting it produces a /mnt/c/... path the Windows
      // filesystem can't resolve. #43.
      if (/^[A-Za-z]:\\/.test(sourcePath)) {
        let serverIsWSL = false;
        try {
          const info = await api.version();
          serverIsWSL = !!(info && info.isWSL);
        } catch { /* old/unreachable server: assume native, skip conversion */ }
        if (serverIsWSL) {
          const drive = sourcePath[0].toLowerCase();
          sourcePath = '/mnt/' + drive + sourcePath.slice(2).replace(/\\/g, '/');
        }
      }

      // Trigger rebuild using the original source path and the same index name
      const indexName = activeIdx.indexPath || indexPath;
      statusDiv.textContent = `Rebuilding from: ${sourcePath}`;

      let buildResult;
      try {
        buildResult = await api.buildIndex({ sourcePath, indexName, useTreeSitter: true });
      } catch (buildErr) {
        const msg = buildErr.message || '';
        if (msg.includes('Path not found') || msg.includes('not found')) {
          errDiv.textContent = `Index loaded, but original source not found: ${sourcePath}`;
        } else {
          errDiv.textContent = msg;
        }
        errDiv.style.display = 'block';
        statusDiv.style.display = 'none';
        rebuildBtn.disabled = false;
        rebuildBtn.textContent = 'Rebuild';
        return;
      }
      const { jobId } = buildResult;

      // Poll for progress
      rebuildPollTimer = setInterval(async () => {
        try {
          const job = await api.buildIndexStatus({ jobId });
          if (job.status === 'building') {
            statusDiv.textContent = job.progress || 'Building…';
          } else if (job.status === 'done') {
            clearInterval(rebuildPollTimer);
            rebuildPollTimer = null;
            const s = job.stats;
            statusDiv.textContent = `Rebuilt: ${s.files_indexed.toLocaleString()} files, ${s.total_lines.toLocaleString()} lines`;
            statusDiv.style.color = '#4ec94e';

            setTimeout(() => {
              overlay.classList.add('hidden');
              rebuildBtn.disabled = false;
              rebuildBtn.textContent = 'Rebuild';
              statusDiv.style.display = 'none';

              const active = job.indexes.find(i => i.active) || job.indexes[0];
              $('#index-info').textContent = `${active.name} (${active.files.toLocaleString()} files)`;
              state.sectionData = {};
              for (const sec of $$('.accordion-section')) {
                sec.classList.remove('open');
                $('.accordion-content', sec).innerHTML = '';
                $('.accordion-badge', sec).textContent = '';
              }
              _clearAllPanes();
              // #218: pop the fast Overview after a rebuild completes too.
              window.dispatchEvent(new CustomEvent('ce:index-loaded'));
            }, 2000);
          } else if (job.status === 'error') {
            clearInterval(rebuildPollTimer);
            rebuildPollTimer = null;
            errDiv.textContent = job.error || 'Rebuild failed';
            errDiv.style.display = 'block';
            statusDiv.style.display = 'none';
            rebuildBtn.disabled = false;
            rebuildBtn.textContent = 'Rebuild';
          }
        } catch (pollErr) {
          statusDiv.textContent = `Poll error: ${pollErr.message}`;
        }
      }, 1500);

    } catch (err) {
      errDiv.textContent = err.message;
      errDiv.style.display = 'block';
      statusDiv.style.display = 'none';
      rebuildBtn.disabled = false;
      rebuildBtn.textContent = 'Rebuild';
    }
  });
}


// ========================================================================


// ============================================================================
// Build Index dialog
// ============================================================================

function initBuildIndex() {
  const overlay = $('#build-index-overlay');
  const sourceInput = $('#build-index-source');
  const nameInput = $('#build-index-name');
  const errDiv = $('#build-index-error');
  const statusDiv = $('#build-index-status');
  const browserPanel = $('#build-index-browser');
  const browsePathEl = $('#build-browse-current-path');
  const dirListEl = $('#build-browse-dir-list');
  let lastBrowsedDir = null;

  // Close handlers are wired below in the build section (closeBuildDialog) to also stop polling

  // --- Filesystem browser ---

  async function browseTo(dirPath) {
    try {
      const data = await api.browseDir(dirPath ? { path: dirPath } : {});
      renderBrowser(data);
    } catch (err) {
      dirListEl.innerHTML = `<div class="error-msg" style="padding:8px">${err.message}</div>`;
    }
  }

  function renderBrowser(data) {
    lastBrowsedDir = data.current;
    browsePathEl.textContent = data.current;
    browsePathEl.title = data.current;
    dirListEl.innerHTML = '';

    // ".." entry to go up
    if (data.parent) {
      const upEl = document.createElement('div');
      upEl.className = 'browse-item';
      upEl.innerHTML = '<span class="dir-marker">..</span> <span>(parent directory)</span>';
      upEl.addEventListener('click', () => browseTo(data.parent));
      dirListEl.appendChild(upEl);
    }

    for (const dir of data.dirs) {
      const el = document.createElement('div');
      el.className = 'browse-item' + (dir.isIndex ? ' is-index' : '');
      const fullPath = data.current + data.sep + dir.name;

      let inner = `<span class="dir-marker">/</span> <span>${dir.name}</span>`;
      if (dir.isIndex) inner += '<span class="index-badge">index</span>';
      el.innerHTML = inner;

      // Single click: fill source path and auto-fill index name
      el.addEventListener('click', () => {
        sourceInput.value = fullPath;
        errDiv.style.display = 'none';
        autoFillName(fullPath);
      });

      // Double click: navigate into directory
      el.addEventListener('dblclick', () => browseTo(fullPath));

      dirListEl.appendChild(el);
    }

    if (data.dirs.length === 0) {
      dirListEl.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px">No subdirectories</div>';
    }
  }

  // Browse button toggles the panel
  $('#build-index-browse').addEventListener('click', () => {
    if (browserPanel.style.display === 'none') {
      browserPanel.style.display = 'block';
      const startPath = sourceInput.value.trim() || lastBrowsedDir || null;
      browseTo(startPath);
    } else {
      browserPanel.style.display = 'none';
    }
  });

  // Auto-fill index name from source path
  function autoFillName(sourcePath) {
    if (nameInput.value.trim()) return;  // don't overwrite user input
    const dirName = sourcePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (dirName) nameInput.value = `.index_of_${dirName}`;
  }

  sourceInput.addEventListener('blur', () => {
    const val = sourceInput.value.trim();
    if (val) autoFillName(val);
  });

  // --- Build button ---

  let buildPollTimer = null;

  function stopBuildPoll() {
    if (buildPollTimer) { clearInterval(buildPollTimer); buildPollTimer = null; }
  }

  // Allow close/cancel during build (build finishes silently server-side)
  function closeBuildDialog() {
    stopBuildPoll();
    overlay.classList.add('hidden');
    $('#build-index-ok').disabled = false;
    $('#build-index-cancel').disabled = false;
  }

  $('#build-index-close').addEventListener('click', closeBuildDialog);
  $('#build-index-cancel').addEventListener('click', closeBuildDialog);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBuildDialog(); });

  function onBuildComplete(result) {
    stopBuildPoll();
    const s = result.stats;
    let summary = `Indexed ${s.files_indexed.toLocaleString()} files, ${s.total_lines.toLocaleString()} lines`;
    if (s.archives_expanded > 0) summary += `, ${s.archive_files} files from ${s.archives_expanded} archive(s)`;
    if (s.binstrings_processed > 0) summary += `, ${s.binstrings_processed} binaries`;
    if (s.dupes_skipped > 0) summary += `, ${s.dupes_skipped} duplicates`;
    statusDiv.textContent = summary;
    statusDiv.style.color = '#4ec94e';

    setTimeout(() => {
      overlay.classList.add('hidden');
      $('#build-index-ok').disabled = false;
      $('#build-index-cancel').disabled = false;

      // Show build errors (if any) in the middle pane.
      if (s.error_count > 0) {
        const errorLines = s.errors.map(e => escHtml(e)).join('<br>');
        const truncNote = s.error_count > 50 ? `<br><br><em>…and ${s.error_count - 50} more errors</em>` : '';
        $('#middle-top-body').innerHTML = `<div style="padding:12px;font-size:12px;font-family:var(--font-mono)"><strong>${s.error_count} error(s) during indexing:</strong><br><br>${errorLines}${truncNote}</div>`;
        $('#middle-top-title').textContent = 'Build Errors';
        _showPane('middle-top');
      }

      // #218: build no longer auto-loads (server built with autoLoad:false, so
      // the user's currently-loaded index is untouched). Pop the Load Index
      // dialog pre-filled with the freshly-built index so the user loads it
      // explicitly — or cancels to keep their current index. Loading routes
      // through the normal Load flow, which dispatches ce:index-loaded so the
      // Overview pops. (Mirrors menu-bar.js's load-index open.)
      $('#load-index-path').value = result.indexPath || '';
      $('#load-index-error').style.display = 'none';
      $('#load-index-browser').style.display = 'none';
      $('#browse-dir-list').innerHTML = '';
      $('#load-index-overlay').classList.remove('hidden');
      setTimeout(() => $('#load-index-path').focus(), 100);
    }, 2000);
  }

  $('#build-index-ok').addEventListener('click', async () => {
    const sourcePath = sourceInput.value.trim();
    const indexName = nameInput.value.trim();
    if (!sourcePath) { errDiv.textContent = 'Enter a source path'; errDiv.style.display = 'block'; return; }
    if (!indexName) { errDiv.textContent = 'Enter an index name'; errDiv.style.display = 'block'; return; }
    errDiv.style.display = 'none';

    try {
      $('#build-index-ok').disabled = true;
      statusDiv.style.display = 'block';
      statusDiv.textContent = 'Starting build…';
      statusDiv.style.color = 'var(--text-muted)';

      const useTreeSitter = $('#build-index-tree-sitter')?.checked || false;
      const extInclude = $('#build-index-ext')?.value.trim() || '';
      const extExclude = $('#build-index-exclude-ext')?.value.trim() || '';
      // #218: build to disk WITHOUT auto-loading; onBuildComplete pops the
      // pre-filled Load dialog so the user loads it explicitly (or cancels).
      const { jobId } = await api.buildIndex({ sourcePath, indexName, useTreeSitter, extensions: extInclude, excludeExtensions: extExclude, autoLoad: false });

      // Poll for progress
      buildPollTimer = setInterval(async () => {
        try {
          const job = await api.buildIndexStatus({ jobId });
          if (job.status === 'building') {
            statusDiv.textContent = job.progress || 'Building…';
          } else if (job.status === 'done') {
            onBuildComplete(job);
          } else if (job.status === 'error') {
            stopBuildPoll();
            errDiv.textContent = job.error || 'Build failed';
            errDiv.style.display = 'block';
            statusDiv.style.display = 'none';
            $('#build-index-ok').disabled = false;
            $('#build-index-cancel').disabled = false;
          }
        } catch (pollErr) {
          // Poll error — keep trying, server may be busy with the build
        }
      }, 1500);
    } catch (err) {
      errDiv.textContent = err.message;
      errDiv.style.display = 'block';
      statusDiv.style.display = 'none';
      $('#build-index-ok').disabled = false;
      $('#build-index-cancel').disabled = false;
    }
  });

  // Enter key on inputs triggers build
  sourceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#build-index-ok').click(); });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#build-index-ok').click(); });
}


// ========================================================================


// ============================================================================
// Search dialog (replaces window.prompt)
// ============================================================================

// Per-title cache of last-entered value, so reopening "Multisect Search"
// re-fills the prior term string. "Save *" dialogs are excluded from caching.
const _searchDialogLastValue = {};
const _searchDialogLastInPath = {};
const _searchDialogLastMatchRenames = {};

export function showSearchDialog(title, label) {
  return new Promise((resolve) => {
    const overlay = $('#search-overlay');
    const input = $('#search-dialog-input');
    const inPathRow = $('#search-dialog-inpath-row');
    const inPathInput = $('#search-dialog-inpath');
    const matchRenamesRow = $('#search-dialog-match-renames-row');
    const matchRenamesInput = $('#search-dialog-match-renames');
    const okBtn = $('#search-dialog-ok');
    const cancelBtn = $('#search-dialog-cancel');
    const closeBtn = $('#search-dialog-close');

    const cacheable = !(title && title.startsWith('Save'));
    const key = title || '_default';
    $('#search-dialog-title').textContent = title || 'Search';
    $('#search-dialog-label').childNodes[0].textContent = (label || 'Query:') + ' ';
    okBtn.textContent = cacheable ? 'Search' : 'Save';
    input.value = cacheable ? (_searchDialogLastValue[key] || '') : '';
    // The 'In path' filter and 'Match renames' toggle apply only to real
    // searches, not 'Save *' dialogs.
    inPathRow.style.display = cacheable ? '' : 'none';
    inPathInput.value = cacheable ? (_searchDialogLastInPath[key] || '') : '';
    if (matchRenamesRow) matchRenamesRow.style.display = cacheable ? 'block' : 'none';
    if (matchRenamesInput) matchRenamesInput.checked = cacheable && !!_searchDialogLastMatchRenames[key];
    overlay.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 100);

    function cleanup(result) {
      overlay.classList.add('hidden');
      if (cacheable && result) {
        _searchDialogLastValue[key] = result.query;
        _searchDialogLastInPath[key] = result.inPath;
        _searchDialogLastMatchRenames[key] = !!result.matchRenames;
      }
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
      inPathInput.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk() {
      const query = input.value.trim();
      cleanup(query
        ? { query, inPath: inPathInput.value.trim(), matchRenames: !!(matchRenamesInput && matchRenamesInput.checked) }
        : null);
    }
    function onCancel() { cleanup(null); }
    function onKey(e) { if (e.key === 'Enter') onOk(); else if (e.key === 'Escape') onCancel(); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
    inPathInput.addEventListener('keydown', onKey);
  });
}


// ========================================================================


// ============================================================================
// Confirm dialog (replaces window.confirm)
// ============================================================================

export function showConfirmDialog(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:360px">
        <div class="modal-header"><span>Confirm</span>
          <button class="pane-action confirm-close">✕</button>
        </div>
        <div class="modal-body" style="padding:16px;font-size:13px"></div>
        <div class="modal-footer">
          <button class="btn-secondary confirm-cancel">Cancel</button>
          <button class="btn-primary confirm-ok">OK</button>
        </div>
      </div>`;
    overlay.querySelector('.modal-body').textContent = message;
    document.body.appendChild(overlay);

    function cleanup(val) { overlay.remove(); resolve(val); }
    overlay.querySelector('.confirm-ok').addEventListener('click', () => cleanup(true));
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.confirm-close').addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.querySelector('.confirm-ok').focus();
  });
}




// ============================================================================
// Model Browser modal
// ============================================================================

export async function openModelBrowser() {
  // Fetch available models
  let data;
  try {
    data = await api.scanModels();
  } catch (err) {
    alert('Error scanning for models: ' + err.message);
    return;
  }

  // Build modal overlay
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'model-browser-overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-header"><span>Browse GGUF Models</span>
        <button class="pane-action" id="model-browser-close">✕</button>
      </div>
      <div class="modal-body">
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <input type="text" id="model-scan-path" value="${escHtml(data.scanDir || '')}" spellcheck="false" style="flex:1;margin-top:0" placeholder="Directory to scan…">
          <button class="btn-secondary" id="model-scan-btn">Scan</button>
        </div>
        <div class="muted" style="font-size:11px;margin-bottom:6px">Current model: ${escHtml(data.currentModel || 'none')}</div>
        <div id="model-list" class="scrollable" style="border:1px solid var(--border);border-radius:3px;max-height:300px;overflow-y:auto;background:var(--bg-input)"></div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" id="model-browser-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  // Issue #19: draggable by the header bar.
  const modalEl = overlay.querySelector('.modal');
  const headerEl = overlay.querySelector('.modal-header');
  if (modalEl && headerEl) makeDraggable(modalEl, headerEl);

  const listEl = overlay.querySelector('#model-list');
  const pathInput = overlay.querySelector('#model-scan-path');

  function renderModelList(models) {
    if (!models || models.length === 0) {
      listEl.innerHTML = '<div class="list-placeholder" style="padding:12px">No .gguf files found in this directory</div>';
      return;
    }
    let html = '';
    for (const m of models) {
      const sizeMB = (m.size / (1024 * 1024)).toFixed(1);
      const loadedBadge = m.loaded ? ' <span class="type-badge" style="background:var(--accent);color:#000">loaded</span>' : '';
      html += `<div class="browse-item model-item" data-path="${escHtml(m.path)}" style="padding:6px 8px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <span class="mono" style="font-size:12px">${escHtml(m.name)}${loadedBadge}</span>
        <span class="muted" style="font-size:11px">${sizeMB} MB</span>
      </div>`;
    }
    listEl.innerHTML = html;

    // Wire click handlers
    for (const item of listEl.querySelectorAll('.model-item')) {
      item.addEventListener('click', async () => {
        const modelPath = item.dataset.path;
        try {
          item.style.opacity = '0.5';
          item.querySelector('.mono').textContent += ' — loading…';
          await api.switchModel({ path: modelPath });
          // Auto-select the local engine; label/badge updates for BOTH the
          // workspace and chat surfaces come from refreshLlmStatus (single
          // source of truth — the server-wide loaded model).
          $('#ws-engine').value = 'local';
          _refreshLlmStatus();
          closeModal();
        } catch (err) {
          item.style.opacity = '1';
          alert('Error switching model: ' + err.message);
        }
      });
    }
  }

  renderModelList(data.models);

  // Scan button
  overlay.querySelector('#model-scan-btn').addEventListener('click', async () => {
    try {
      const scanData = await api.scanModels({ dir: pathInput.value });
      pathInput.value = scanData.scanDir || pathInput.value;
      renderModelList(scanData.models);
    } catch (err) {
      listEl.innerHTML = `<div class="error-msg" style="padding:8px">${escHtml(err.message)}</div>`;
    }
  });

  // Also scan on Enter in the path input
  pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') overlay.querySelector('#model-scan-btn').click();
  });

  function closeModal() {
    overlay.remove();
  }
  overlay.querySelector('#model-browser-close').addEventListener('click', closeModal);
  overlay.querySelector('#model-browser-cancel').addEventListener('click', closeModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
}

