/**
 * console.js — Right-bottom pane: Analysis / Console tab switching,
 * plus the interactive Console (a REPL embedded in the GUI that runs
 * a subset of CodeExam's CLI command surface via /api/exec).
 *
 * Cross-cutting callbacks needed for command-output navigation
 * (`showPane`, `onFileClick`, `openFileMapEdgeDetail`,
 * `openRelationshipView`, `renderMermaid`) are injected at init via
 * `initConsole({...})` rather than imported, to keep console.js
 * independent of the render flows that still live in app.js.
 */

import { $, $$, escHtml } from './dom-utils.js';
import { api } from './api.js';

// ============================================================================
// Cross-cutting callbacks (injected by initConsole)
// ============================================================================

let _showPane = () => {};
let _onFileClick = () => {};
let _openFileMapEdgeDetail = () => {};
let _openRelationshipView = () => {};
let _renderMermaid = () => {};

export function initConsole(deps = {}) {
  if (typeof deps.showPane === 'function') _showPane = deps.showPane;
  if (typeof deps.onFileClick === 'function') _onFileClick = deps.onFileClick;
  if (typeof deps.openFileMapEdgeDetail === 'function') _openFileMapEdgeDetail = deps.openFileMapEdgeDetail;
  if (typeof deps.openRelationshipView === 'function') _openRelationshipView = deps.openRelationshipView;
  if (typeof deps.renderMermaid === 'function') _renderMermaid = deps.renderMermaid;
  initRightBottomTabs();
  initConsoleInternals();
}


// ============================================================================
// Right-bottom tab switching (Analysis / Console)
// ============================================================================

// Right-bottom tab switching (Analysis / Console)
// ========================================================================
function initRightBottomTabs() {
  for (const tab of $$('#right-bottom .pane-tab')) {
    tab.addEventListener('click', () => {
      for (const t of $$('#right-bottom .pane-tab')) t.classList.remove('active');
      tab.classList.add('active');
      const target = tab.dataset.tab;
      // Analysis tab
      const analysisBody = $('#right-bottom-body');
      const consolePanel = $('#console-panel');
      if (target === 'analysis') {
        analysisBody.style.display = '';
        consolePanel.style.display = 'none';
      } else {
        analysisBody.style.display = 'none';
        consolePanel.style.display = 'flex';
        $('#console-input').focus();
      }
    });
  }
}


// ========================================================================

// ============================================================================
// Console — interactive CLI commands within the GUI
// ============================================================================

// Console — interactive CLI commands within the GUI
// ========================================================================
const CONSOLE_HELP = `SEARCH:
  /search <query>          Literal search (or just type text without /)
  /regex /pattern/         Regex search
  /fast <query>            Fast inverted-index search
  /files-search <query>    Files containing term
  /folders-search <query>  Folders containing term
  /multisect t1;t2;t3      Multi-term intersection search
  /paths <pattern>         Search file/folder paths

BROWSE:
  /extract <func>          Extract function source
  /file <filepath>         Show entire file
  /files [pattern]         List/filter files
  /functions [pattern]     List functions
  /extensions              Show file extensions breakdown
  /stats                   Index statistics

CALL GRAPH:
  /callers <func>          Find callers
  /callees <func>          Find callees
  /most-called [N]         Most frequently called
  /call-inventory [func]   In-index vs external call targets
  /call-tree <func> [depth=N] [mermaid]   Call tree → Diagram pane
  /class-tree [filter] [mermaid]          Class inheritance hierarchy
  /file-map [filter] [mermaid]            File dependency map
  /file-tree <file> [depth=N] [mermaid]   File dependency tree

METRICS:
  /hotspots [N]            Most important functions (calls x size)
  /hot-folders [N]         Most important directories
  /entry-points [N]        Largest uncalled functions
  /gaps [N]                Suspicious dead code
  /domain-fns [N]          Domain-specific hotspots
  /classes [filter]        List classes with method counts
  /class-hotspots [N]      Classes ranked by hotspot score
  /vocabulary [N]          Domain tokens by TF-IDF

DUPLICATES:
  /func-dupes [N]          Exact duplicate functions
  /near-dupes [N]          Near-duplicate groups
  /struct-dupes [N]        Structural duplicate groups
  /funcstring <func>       Show structural form of function
  /struct-diff <func>      Diff structural duplicate variants
  /struct-diff-all [N]     All structural diff summaries
  /dupefiles [N]           Duplicate files

LLM:
  /claim <text|@file>      LLM claim search
  /analyze <func>          LLM function analysis → Analysis pane

OTHER:
  /set                     Show settings
  /set max N               Set max results
  /rebuild-functions       Rebuild function index
  /help                    This help
  /clear                   Clear console
  Bare text (no /) does a literal search.
`;

const consoleHistory = [];
let consoleHistoryIdx = -1;

export function consoleAppend(text, cls) {
  const output = $('#console-output');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
  // Also write to fullscreen console if open
  if (window._consoleAppendTarget === 'both') fsConsoleAppend(text, cls);
}

export function fsConsoleAppend(text, cls) {
  const output = $('#fs-console-output');
  if (!output) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

export function consoleClear() {
  $('#console-output').innerHTML = '';
}

function initConsoleInternals() {
  const input = $('#console-input');
  if (!input) return;

  consoleAppend('Code Exam Console. Type /help for commands.\n', 'console-info');

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const cmd = input.value.trim();
      if (!cmd) return;
      consoleHistory.push(cmd);
      consoleHistoryIdx = consoleHistory.length;
      consoleAppend(`❯ ${cmd}`, 'console-cmd');
      input.value = '';
      try { await executeConsoleCommand(cmd); }
      catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (consoleHistoryIdx > 0) { consoleHistoryIdx--; input.value = consoleHistory[consoleHistoryIdx]; }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (consoleHistoryIdx < consoleHistory.length - 1) { consoleHistoryIdx++; input.value = consoleHistory[consoleHistoryIdx]; }
      else { consoleHistoryIdx = consoleHistory.length; input.value = ''; }
    }
  });
}

export async function executeConsoleCommand(cmd) {
  if (cmd === '/help') { consoleAppend(CONSOLE_HELP, 'console-info'); return; }
  if (cmd === '/clear') { consoleClear(); return; }

  // /call-tree without 'mermaid' flag → render in diagram pane via dedicated route
  if (cmd.startsWith('/call-tree ') && !cmd.includes('mermaid')) {
    const funcSpec = cmd.slice(11).trim();
    try {
      const consoleDepth = parseInt($('#diagram-depth')?.value) || 3;
      const data = await api.callTree({ func: funcSpec, depth: consoleDepth });
      consoleAppend(`Call tree for ${data.target} (depth ${consoleDepth}) rendered in Diagram pane.`, 'console-info');
      const body = $('#right-top-body'), ttl = $('#right-top-title');
      if (ttl) ttl.textContent = `Call tree: ${data.target} (depth ${consoleDepth})`;
      if (body) {
        body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>';
        const rootName = data.target;
        _renderMermaid(data.mermaid, $('#diagram-viewport'), rootName, {
          onNodeClick: (nodeId, label) => { if (label && label !== rootName) _openRelationshipView(rootName, label); },
        });
      }
      _showPane('right-top');
    } catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
    return;
  }

  // /file-map → render in diagram pane via dedicated route
  if (cmd === '/file-map' || cmd.startsWith('/file-map ')) {
    const filter = cmd.slice(9).trim().replace(/\bmermaid\b/, '').trim() || undefined;
    try {
      const data = await api.fileMap({ filter });
      consoleAppend(`File map (${data.files} files, ${data.edges} edges) rendered in Diagram pane.`, 'console-info');
      const body = $('#right-top-body'), ttl = $('#right-top-title');
      if (ttl) ttl.textContent = 'File Dependency Map';
      if (body) {
        body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>';
        _renderMermaid(data.mermaid, $('#diagram-viewport'), null, {
          onNodeClick: (nodeId, label) => { _onFileClick(label); },
          onEdgeClick: (edgeId, labelText, nodeIdMap) => { _openFileMapEdgeDetail(edgeId, labelText, nodeIdMap); },
        });
      }
      _showPane('right-top');
    } catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
    return;
  }

  // /analyze → run via /api/exec but also show in Analysis pane
  if (cmd.startsWith('/analyze ')) {
    consoleAppend('Analyzing… (output in Analysis pane)', 'console-info');
    // Use dedicated LLM route for streaming to analysis pane
    const funcSpec = cmd.slice(9).trim();
    const engine = $('#ws-engine')?.value || 'claude';
    const mask = $('#ws-mask-all')?.checked || false;
    const maskComments = $('#ws-mask-comments')?.checked || false;
    try {
      const data = await api.analyzeLlm({ func: funcSpec, mode: 'analyze', engine, mask, maskComments });
      const analysisBody = $('#right-bottom-body');
      if (analysisBody) {
        const tab = $('[data-tab="analysis"]');
        if (tab) tab.click();
        analysisBody.innerHTML = `<div class="analysis-content"><h3>${data.target}</h3><pre style="white-space:pre-wrap">${escHtml(data.analysis || '(no analysis)')}</pre></div>`;
        _showPane('right-bottom');
      }
      consoleAppend(`Analysis complete: ${data.target}`, 'console-accent');
    } catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
    return;
  }

  // Everything else → universal /api/exec
  try {
    const resp = await fetch(`/api/exec?cmd=${encodeURIComponent(cmd)}&max=25`);
    const data = await resp.json();
    if (data.error) {
      consoleAppend(`Error: ${data.error}`, 'console-err');
    } else {
      const output = data.output || '';
      if (output) {
        // Check if output contains mermaid and render it
        if (output.startsWith('graph ') || output.startsWith('flowchart ')) {
          consoleAppend('Mermaid diagram rendered in Diagram pane.', 'console-info');
          const body = $('#right-top-body'), ttl = $('#right-top-title');
          if (ttl) ttl.textContent = `Diagram: ${cmd}`;
          if (body) { body.innerHTML = '<div class="diagram-viewport" id="diagram-viewport"></div>'; _renderMermaid(output, $('#diagram-viewport'), cmd); }
          _showPane('right-top');
        } else {
          for (const line of output.split('\n')) {
            consoleAppend(line);
          }
        }
      } else {
        consoleAppend('(no output)', 'console-info');
      }
    }
  } catch (err) { consoleAppend(`Error: ${err.message}`, 'console-err'); }
}


// ========================================================================
