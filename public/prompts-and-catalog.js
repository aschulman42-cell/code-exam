/**
 * prompts-and-catalog.js — Left-pane list renderers and middle-top
 * detail renderers for five accordion families: LLM Prompts,
 * Breadcrumbs, Bundle Seams, Command Catalog, Struct Diffs. Each
 * family pairs a list renderer (called from app.js's `loadSectionData`
 * dispatch) with a detail renderer wired to the per-row click handler.
 *
 * Distinct from the structural/code list renderers (Functions, Files,
 * Classes, Vocabulary, File Map, etc.) which stay in app.js for a
 * later peel.
 *
 * Direct imports: state, api, dom-utils, layout (showPane),
 * click-handlers (row-click navigation), context-menu (right-click —
 * actually unused here but kept for symmetry with renderers that
 * might add it later).
 *
 * Cross-cutting callbacks (`navPush`, `showMiddleTopLoading`,
 * `showMiddleTopError`, `renderSearchResults`, `wireClickables`,
 * `getMaxResults`) are injected via `initPromptsAndCatalog({...})`
 * since their owners still live in app.js's middle-pane chrome and
 * accordion sections. All of these become direct imports when those
 * sections become their own peels.
 */

import { state } from './state.js';
import { api } from './api.js';
import {
  $, $$, h, escHtml, displayNameHtml, shortPath, shortFuncName,
} from './dom-utils.js';
import { showPane } from './layout.js';
import {
  onFunctionClick, onFunctionClickSourceOnly, onFileClick,
} from './click-handlers.js';


// ============================================================================
// Cross-cutting callbacks (injected by initPromptsAndCatalog)
// ============================================================================

let _navPush = () => {};
let _showMiddleTopLoading = () => {};
let _showMiddleTopError = () => {};
let _renderSearchResults = () => {};
let _wireClickables = () => {};
let _getMaxResults = () => 30;

export function initPromptsAndCatalog(deps = {}) {
  if (typeof deps.navPush === 'function') _navPush = deps.navPush;
  if (typeof deps.showMiddleTopLoading === 'function') _showMiddleTopLoading = deps.showMiddleTopLoading;
  if (typeof deps.showMiddleTopError === 'function') _showMiddleTopError = deps.showMiddleTopError;
  if (typeof deps.renderSearchResults === 'function') _renderSearchResults = deps.renderSearchResults;
  if (typeof deps.wireClickables === 'function') _wireClickables = deps.wireClickables;
  if (typeof deps.getMaxResults === 'function') _getMaxResults = deps.getMaxResults;
}


// ============================================================================
// LLM Prompts list + detail
// ============================================================================

const PROMPT_FRAG_BASE = 100;      // initial fragment length
const PROMPT_FRAG_TAIL = 25;       // extra chars shown around a divergence point

// Build a display fragment for each prompt. If two prompts share the first
// PROMPT_FRAG_BASE chars, add an ellipsis + PROMPT_FRAG_TAIL chars starting at
// the first divergence point so they read differently. If texts are truly
// identical, suffix with filepath.
function disambiguatePromptFragments(prompts) {
  const frags = prompts.map(p => p.text.slice(0, PROMPT_FRAG_BASE));
  const byFrag = new Map();
  for (let i = 0; i < frags.length; i++) {
    if (!byFrag.has(frags[i])) byFrag.set(frags[i], []);
    byFrag.get(frags[i]).push(i);
  }
  for (const [, group] of byFrag) {
    if (group.length < 2) continue;
    // Find first divergence point across this group.
    const texts = group.map(i => prompts[i].text);
    const minLen = Math.min(...texts.map(t => t.length));
    let div = 0;
    while (div < minLen) {
      const c = texts[0][div];
      let same = true;
      for (let k = 1; k < texts.length; k++) {
        if (texts[k][div] !== c) { same = false; break; }
      }
      if (!same) break;
      div++;
    }
    if (div >= minLen) {
      // One or more texts are a prefix of another (or all identical up to
      // their common length). Fall back to filepath suffix.
      for (const i of group) {
        frags[i] = frags[i] + ` […${shortPath(prompts[i].filepath, 25)}]`;
      }
      continue;
    }
    // For each member, append the divergence tail.
    for (const i of group) {
      const tail = prompts[i].text.slice(div, div + PROMPT_FRAG_TAIL);
      frags[i] = frags[i] + ' … ' + tail;
    }
  }
  return frags;
}

export function renderPromptList(container, prompts, total) {
  container.innerHTML = '';
  if (!prompts || !prompts.length) {
    container.innerHTML = '<div class="list-placeholder">No prompts found</div>';
    return;
  }
  // Sort by full-text length ascending (shortest first).
  const sorted = prompts.slice().sort((a, b) => a.text.length - b.text.length);
  const frags = disambiguatePromptFragments(sorted);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const frag = frags[i];
    const funcLabel = p.funcDisplay || p.func || '(file scope)';
    const tip = `${shortPath(p.filepath, 60)}:L${p.lineNum}\nFunction: ${funcLabel}\nLength: ${p.text.length} chars`;
    const item = h('div', { className: 'list-item', title: tip, style: 'align-items:flex-start' }, [
      h('span', { className: 'metric', text: `${p.text.length}` }),
      h('span', { className: 'name', text: frag, style: 'font-size:11px;flex:1;min-width:0;word-break:break-word' }),
      h('span', { className: 'metric muted', text: funcLabel, style: 'font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;flex-shrink:0' }),
    ]);
    item.addEventListener('click', () => renderPromptDetail(p));
    container.appendChild(item);
  }
}

export function renderPromptDetail(prompt) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const funcLabel = prompt.funcDisplay || prompt.func || '(file scope)';
  title.textContent = `Prompt (${prompt.text.length} chars) — ${funcLabel}`;
  showPane('middle-top');
  _navPush('middle-top');

  let html = '<div class="output-section">';
  html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">`;
  html += `${escHtml(shortPath(prompt.filepath, 60))}:L${prompt.lineNum}`;
  html += `  ·  Type: ${escHtml(prompt.type)}`;
  if (prompt.varName) {
    // Make the variable name clickable so the reader can find references
    // — `\bxGz\b` case-sensitive avoids the case-fold pollution that
    // a 3-char identifier would otherwise produce. Title hints at the
    // action so the click target is discoverable.
    html += `  ·  Var: <span class="clickable" data-prompt-var="${escHtml(prompt.varName)}" title="Find references to this variable">${escHtml(prompt.varName)}</span>`;
  }
  html += `</div>`;
  html += `<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--bg-input);padding:8px;border:1px solid var(--border);border-radius:3px;overflow:auto">${escHtml(prompt.text)}</pre>`;
  html += '</div>';
  container.innerHTML = html;

  // Wire the var-click → case-sensitive regex search.
  for (const el of $$('[data-prompt-var]', container)) {
    el.addEventListener('click', async () => {
      const v = el.dataset.promptVar;
      const q = `\\b${v}\\b`;
      _showMiddleTopLoading(`Finding references to ${v}…`);
      try {
        const data = await api.search({ q, type: 'regex', case_sensitive: '1', max: 50 });
        _renderSearchResults(q, data);
      } catch (err) { _showMiddleTopError(err.message); }
    });
  }

  // Lower pane: handler source if the prompt lives in a function, else a
  // file excerpt around the definition line.
  if (prompt.func) {
    onFunctionClickSourceOnly({
      filepath: prompt.filepath,
      name: prompt.func,
      display_name: prompt.funcDisplay || prompt.func,
    });
  } else {
    onFileClick(prompt.filepath, prompt.lineNum);
  }
}


export function renderStringDetail(entry) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `String (${entry.count} occurrences in ${entry.files} file${entry.files > 1 ? 's' : ''})`;
  showPane('middle-top');
  _navPush('middle-top');

  let html = '<div class="output-section">';
  // Full string value
  html += `<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;background:var(--bg-input);padding:8px;border:1px solid var(--border);border-radius:3px;max-height:300px;overflow:auto">${escHtml(entry.value)}</pre>`;
  // Locations table
  html += '<table class="output-table" style="margin-top:8px"><tr><th>#</th><th>Function</th><th>File</th><th>Line</th></tr>';
  for (let i = 0; i < entry.locations.length; i++) {
    const loc = entry.locations[i];
    const funcDisplay = loc.func || '(file scope)';
    html += `<tr>`;
    html += `<td class="muted">${i + 1}</td>`;
    html += `<td class="mono"><span class="clickable" data-funcname="${escHtml(funcDisplay)}">${escHtml(funcDisplay)}</span></td>`;
    html += `<td class="mono clickable file-link" data-filepath="${escHtml(loc.filepath)}" data-start="${loc.line}" title="Show file at line ${loc.line}">${escHtml(shortPath(loc.filepath, 40))}</td>`;
    html += `<td class="muted">${loc.line}</td>`;
    html += `</tr>`;
  }
  html += '</table></div>';

  container.innerHTML = html;
  _wireClickables(container, { sourceOnly: true });

  // Wire file-link clicks
  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      onFileClick(el.dataset.filepath, parseInt(el.dataset.start) || undefined);
    });
  }
}


// ============================================================================
// Breadcrumbs (trace markers + telemetry events)
// ============================================================================

export function renderBreadcrumbs(container, data, filter) {
  container.innerHTML = '';
  const pat = filter ? filter.toLowerCase() : null;

  // --- Trace markers (execution flow) ---
  const markers = data.markers || [];
  let filteredMarkers = markers;
  if (pat) filteredMarkers = markers.filter(m => m.label.toLowerCase().includes(pat) || (m.func || '').toLowerCase().includes(pat));

  if (filteredMarkers.length > 0) {
    // Sub-accordion for trace markers
    const header = h('div', { style: 'padding:4px 8px;font-weight:600;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border);cursor:pointer;user-select:none' });
    header.innerHTML = `<span style="display:inline-block;width:12px">▾</span> Execution Flow (${filteredMarkers.length} markers)`;
    const itemContainer = h('div', {});
    header.addEventListener('click', () => {
      const open = itemContainer.style.display !== 'none';
      itemContainer.style.display = open ? 'none' : 'block';
      header.querySelector('span').textContent = open ? '▸' : '▾';
    });
    container.appendChild(header);

    // Group markers by phase (prefix before first _)
    let lastPhase = '';
    for (const m of filteredMarkers) {
      const phase = m.label.split('_')[0];
      if (phase !== lastPhase) {
        lastPhase = phase;
        const phaseLabel = h('div', { text: phase.toUpperCase(), style: 'padding:2px 8px;font-size:10px;font-weight:600;color:var(--accent-dim);margin-top:4px' });
        itemContainer.appendChild(phaseLabel);
      }

      const funcInfo = m.func ? shortFuncName(m.func, 20) : '';
      const el = h('div', { className: 'list-item', title: `${m.label}\n${m.filepath}:${m.line}\n${m.func || ''}` }, [
        h('span', { className: 'metric muted', text: String(m.line), style: 'font-size:10px;min-width:45px;text-align:right' }),
        h('span', { className: 'name clickable', text: m.label, style: 'font-size:11px;flex:1' }),
        h('span', { className: 'metric muted', text: funcInfo, style: 'font-size:10px' }),
      ]);
      el.addEventListener('click', () => {
        if (m.func && m.func !== '(file scope)') {
          onFunctionClick({ name: m.func, display_name: m.func, filepath: m.filepath });
        } else {
          onFileClick(m.filepath, m.line);
        }
      });
      itemContainer.appendChild(el);
    }
    container.appendChild(itemContainer);
  }

  // --- Telemetry events by category ---
  const categories = data.eventCategories || {};
  const catKeys = Object.keys(categories).sort();
  let filteredCats = catKeys;
  if (pat) {
    filteredCats = catKeys.filter(prefix => {
      return prefix.toLowerCase().includes(pat) ||
        categories[prefix].some(e => e.name.toLowerCase().includes(pat) || (e.func || '').toLowerCase().includes(pat));
    });
  }

  if (filteredCats.length > 0) {
    const evHeader = h('div', { style: 'padding:4px 8px;font-weight:600;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border);cursor:pointer;user-select:none' });
    const totalEvents = Object.values(categories).reduce((s, arr) => s + arr.length, 0);
    evHeader.innerHTML = `<span style="display:inline-block;width:12px">▸</span> Telemetry Events (${totalEvents} in ${catKeys.length} categories)`;
    const evContainer = h('div', { style: 'display:none' });
    evHeader.addEventListener('click', () => {
      const open = evContainer.style.display !== 'none';
      evContainer.style.display = open ? 'none' : 'block';
      evHeader.querySelector('span').textContent = open ? '▸' : '▾';
    });
    container.appendChild(evHeader);

    for (const prefix of filteredCats) {
      let evts = categories[prefix];
      if (pat) evts = evts.filter(e => e.name.toLowerCase().includes(pat) || (e.func || '').toLowerCase().includes(pat));
      if (evts.length === 0) continue;

      const catHeader = h('div', { style: 'padding:2px 8px;font-size:10px;font-weight:600;color:var(--accent-dim);cursor:pointer;user-select:none' });
      catHeader.innerHTML = `<span style="display:inline-block;width:12px">▸</span> ${prefix}_ (${evts.length})`;
      const catItems = h('div', { style: 'display:none' });
      catHeader.addEventListener('click', () => {
        const open = catItems.style.display !== 'none';
        catItems.style.display = open ? 'none' : 'block';
        catHeader.querySelector('span').textContent = open ? '▸' : '▾';
      });
      evContainer.appendChild(catHeader);

      for (const ev of evts.slice(0, _getMaxResults())) {
        const el = h('div', { className: 'list-item', title: `${ev.name}\n${ev.filepath}:${ev.line}\n${ev.func || ''}` }, [
          h('span', { className: 'metric muted', text: String(ev.line), style: 'font-size:10px;min-width:45px;text-align:right' }),
          h('span', { className: 'name clickable', text: ev.name, style: 'font-size:11px;flex:1' }),
          h('span', { className: 'metric muted', text: ev.func ? shortFuncName(ev.func, 20) : '', style: 'font-size:10px' }),
        ]);
        el.addEventListener('click', () => {
          if (ev.func && ev.func !== '(file scope)') {
            onFunctionClick({ name: ev.func, display_name: ev.func, filepath: ev.filepath });
          } else {
            onFileClick(ev.filepath, ev.line);
          }
        });
        catItems.appendChild(el);
      }
      evContainer.appendChild(catItems);
    }
    container.appendChild(evContainer);
  }

  // --- Detected trace functions ---
  if (data.traceFunctions && data.traceFunctions.length > 0) {
    const tfDiv = h('div', { style: 'padding:4px 8px;font-size:10px;color:var(--text-dim)' });
    tfDiv.textContent = 'Trace functions: ' + data.traceFunctions.map(([name, count]) => `${name}(${count})`).join(', ');
    container.appendChild(tfDiv);
  }

  if (container.children.length === 0) {
    container.innerHTML = '<div class="list-placeholder">No breadcrumbs detected</div>';
  }
}


// ============================================================================
// Bundle Seams
// ============================================================================

export function renderBundleSeams(container, data, filter) {
  container.innerHTML = '';
  const pat = filter ? filter.toLowerCase() : null;

  if (!data.files || data.files.length === 0) {
    container.innerHTML = '<div class="list-placeholder">No bundled JS files detected. Bundle Seams scans indexed .js/.mjs/.cjs files larger than 1000 lines for esbuild module-wrapper patterns.</div>';
    return;
  }

  for (const file of data.files) {
    // File header (collapsible per-file)
    const fileHeader = h('div', { style: 'padding:4px 8px;font-weight:600;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border);cursor:pointer;user-select:none' });
    const summaryParts = [`${file.moduleCount} modules`, `${file.esmCount} ESM`, `${file.cjsCount} CJS`];
    if (file.gapCount > 0) summaryParts.push(`${file.gapCount} gap`);
    fileHeader.innerHTML = `<span style="display:inline-block;width:12px">▾</span> ${escHtml(shortPath(file.filepath, 50))} <span class="muted">(${file.lineCount.toLocaleString()}L, ${file.pattern}, ${summaryParts.join(', ')})</span>`;
    const fileItems = h('div', {});
    fileHeader.addEventListener('click', () => {
      const open = fileItems.style.display !== 'none';
      fileItems.style.display = open ? 'none' : 'block';
      fileHeader.querySelector('span').textContent = open ? '▸' : '▾';
    });
    container.appendChild(fileHeader);

    // Helpers info row
    const helpersDiv = h('div', { style: 'padding:2px 8px;font-size:10px;color:var(--text-dim)' });
    helpersDiv.textContent = `Helpers: ESM=${file.helpers.esm || '-'}, CJS=${file.helpers.cjs || '-'}` +
      (file.pattern === 'esbuild-iife' ? `  (outer IIFE starts at L${file.helpers.iifeStartLine})` : '');
    fileItems.appendChild(helpersDiv);

    // Modules list — apply filter if set
    let modules = file.modules || [];
    if (pat) {
      modules = modules.filter(m => {
        const dn = (m.displayName || m.name || '').toLowerCase();
        const preview = (m.preview || '').toLowerCase();
        return dn.includes(pat) || preview.includes(pat);
      });
    }

    const maxModules = _getMaxResults() * 4; // 4× because each module is one row
    const shown = modules.slice(0, maxModules);

    for (const m of shown) {
      const dn = m.displayName || m.name || '?';
      const kindLabel = m.kind === 'GAP' ? 'GAP' : m.kind;
      // Color the kind tag
      const kindColor = m.kind === 'GAP' ? 'var(--accent-orange)'
        : m.kind === 'CJS' ? 'var(--accent)'
        : 'var(--accent-green)';

      const el = h('div', { className: 'list-item', title: `${dn}  L${m.startLine}-${m.endLine}\n${m.preview || ''}` }, [
        h('span', { className: 'metric muted', text: `L${m.startLine}`, style: 'font-size:10px;min-width:55px;text-align:right;flex-shrink:0' }),
        h('span', { text: kindLabel, style: `font-size:9px;font-weight:600;color:${kindColor};min-width:28px;flex-shrink:0` }),
        h('span', { className: 'name clickable', text: dn, style: 'font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' }),
        h('span', { className: 'metric muted', text: `${m.lineCount}L`, style: 'font-size:10px;min-width:40px;text-align:right;flex-shrink:0' }),
      ]);

      // Click → open file at the wrapper start line
      el.addEventListener('click', () => onFileClick(file.filepath, m.startLine));
      fileItems.appendChild(el);

      // Preview line beneath the item (small, indented)
      if (m.preview) {
        const previewDiv = h('div', { style: 'padding:0 8px 2px 70px;font-size:10px;color:var(--text-dim);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' });
        previewDiv.textContent = m.preview.length > 200 ? m.preview.slice(0, 200) + '…' : m.preview;
        fileItems.appendChild(previewDiv);
      }

      // Function inventory (small, indented). Always shown when present
      // (gap modules always have it; wrappers have it because the server sends scanHints=true)
      if (m.functions && m.functions.length > 0) {
        const fnSummary = h('div', { style: 'padding:0 8px 4px 70px;font-size:10px;color:var(--text-dim);cursor:pointer;user-select:none' });
        fnSummary.innerHTML = `<span style="display:inline-block;width:10px">▸</span>${m.functions.length} function${m.functions.length === 1 ? '' : 's'}`;
        const fnList = h('div', { style: 'display:none;padding:0 8px 4px 80px' });
        fnSummary.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = fnList.style.display !== 'none';
          fnList.style.display = open ? 'none' : 'block';
          fnSummary.querySelector('span').textContent = open ? '▸' : '▾';
        });
        for (const fn of m.functions.slice(0, 30)) {
          const fdn = fn.displayName || fn.name || '?';
          const size = (fn.end - fn.start + 1);
          const fnEl = h('div', { className: 'list-item', style: 'padding:1px 0;font-size:10px' }, [
            h('span', { className: 'metric muted', text: `L${fn.start}`, style: 'font-size:9px;min-width:55px;text-align:right;flex-shrink:0' }),
            h('span', { className: 'name clickable', text: fdn, style: 'font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0' }),
            h('span', { className: 'metric muted', text: `${size}L`, style: 'font-size:9px;min-width:30px;text-align:right;flex-shrink:0' }),
          ]);
          fnEl.addEventListener('click', (e) => {
            e.stopPropagation();
            onFunctionClick({ name: fn.name, display_name: fdn, filepath: file.filepath });
          });
          fnList.appendChild(fnEl);
        }
        if (m.functions.length > 30) {
          const more = h('div', { style: 'padding:1px 0;font-size:9px;color:var(--text-dim);font-style:italic' });
          more.textContent = `... and ${m.functions.length - 30} more functions`;
          fnList.appendChild(more);
        }
        fileItems.appendChild(fnSummary);
        fileItems.appendChild(fnList);
      }

      // Hints (paths/license) when present
      if (m.hints) {
        if (m.hints.paths && m.hints.paths.length > 0) {
          const pathsDiv = h('div', { style: 'padding:0 8px 2px 70px;font-size:9px;color:var(--accent-dim)' });
          pathsDiv.textContent = 'paths: ' + m.hints.paths.slice(0, 3).join(', ') + (m.hints.paths.length > 3 ? ', …' : '');
          fileItems.appendChild(pathsDiv);
        }
        if (m.hints.licenses && m.hints.licenses.length > 0) {
          const licDiv = h('div', { style: 'padding:0 8px 2px 70px;font-size:9px;color:var(--accent-dim);font-style:italic' });
          licDiv.textContent = 'license: ' + m.hints.licenses[0];
          fileItems.appendChild(licDiv);
        }
      }
    }

    if (modules.length > shown.length) {
      const moreDiv = h('div', { style: 'padding:4px 8px;font-size:10px;color:var(--text-dim);font-style:italic' });
      moreDiv.textContent = `... and ${modules.length - shown.length} more modules (raise --max-results setting to see more)`;
      fileItems.appendChild(moreDiv);
    }

    container.appendChild(fileItems);
  }
}


// ============================================================================
// Command Catalog
// ============================================================================

// Map a command-catalog gate object (from extractCommandCatalog) to a
// short visual badge: terse label, hover title with full expression,
// colours that distinguish "shipped but not active by default" from
// "active by default" without screaming. Returns null for kinds that
// shouldn't show a badge.
function _gateBadgeProps(gate) {
  if (!gate) return null;
  switch (gate.kind) {
    case 'never':
      return { text: 'disabled', title: 'isEnabled: () => false (hard-disabled)', bg: 'rgba(220,80,80,0.20)', fg: '#e88' };
    case 'flag': {
      const def = gate.default != null ? `, default ${gate.default}` : '';
      return {
        text: 'flag: ' + gate.flag,
        title: `flag-gated: ${gate.expr || gate.flag}${def}`,
        bg: 'rgba(220,180,40,0.18)',
        fg: '#dcb',
      };
    }
    case 'env':
      return {
        text: 'env: ' + gate.envVar,
        title: `env-gated: ${gate.expr || gate.envVar}`,
        bg: 'rgba(180,140,80,0.18)',
        fg: '#cba',
      };
    case 'ref':
      return { text: 'gate', title: `gated by reference: ${gate.expr}`, bg: 'rgba(120,120,140,0.18)', fg: '#aab' };
    case 'complex':
      return { text: 'gate?', title: `gated (unparsed): ${gate.expr}`, bg: 'rgba(120,120,140,0.18)', fg: '#aab' };
    default:
      return null;
  }
}

export function renderCommandCatalog(container, catalog, filter) {
  container.innerHTML = '';
  const pat = filter ? filter.toLowerCase() : null;

  function makeSection(title, items, nameKey, extraKey) {
    if (!items || items.length === 0) return;
    let filtered = items;
    if (pat) {
      filtered = items.filter(item => {
        const name = (item[nameKey] || '').toLowerCase();
        const extra = extraKey ? (Array.isArray(item[extraKey]) ? item[extraKey].join(' ') : (item[extraKey] || '')).toLowerCase() : '';
        return name.includes(pat) || extra.includes(pat);
      });
    }
    if (filtered.length === 0) return;

    // Sub-accordion header
    const header = h('div', { className: 'list-subheader', style: 'padding:4px 8px;font-weight:600;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border);cursor:pointer;user-select:none' });
    header.innerHTML = `<span style="display:inline-block;width:12px">▸</span> ${escHtml(title)} (${filtered.length})`;
    const itemContainer = h('div', { style: 'display:none' });
    header.addEventListener('click', () => {
      const open = itemContainer.style.display !== 'none';
      itemContainer.style.display = open ? 'none' : 'block';
      header.querySelector('span').textContent = open ? '▸' : '▾';
    });
    container.appendChild(header);

    for (const item of filtered) {
      const name = item[nameKey] || item.name || '?';
      const detail = extraKey && item[extraKey]
        ? (Array.isArray(item[extraKey]) ? item[extraKey].join(', ') : item[extraKey])
        : '';
      // Show handler function/file if available, otherwise definition location
      let rightInfo = '';
      // "Precondition" detection: a CLI option whose catalog entry has no
      // handler at all (no dispatch site was found anywhere in the code).
      // These options — --api-key, --claim-model, --depth, etc. — are just
      // read as values inside other handlers. Falling back to item.func
      // shows them as `parseArgs` (their declaration site), which reads as
      // if parseArgs is the handler. Label them explicitly instead.
      const isPrecondition = item.flags && !item.handler;
      if (item.handler && item.handler.handlerFunc) {
        rightInfo = item.handler.handlerFunc;
      } else if (item.handler && item.handler.filepath) {
        rightInfo = shortPath(item.handler.filepath, 20) + ':' + item.handler.line;
      } else if (isPrecondition) {
        rightInfo = '(precondition — no dispatch)';
      } else if (item.func) {
        rightInfo = item.func;
      } else if (item.filepath) {
        rightInfo = shortPath(item.filepath, 20) + ':' + item.line;
      }

      // Gate badge — only render for non-default activation states. Lets
      // a reader scanning the command list see at a glance which entries
      // are flag-gated, env-gated, or hard-disabled (relevant for
      // latent-code review per #358).
      const gate = item.gate;
      let gateBadge = null;
      if (gate && gate.kind && gate.kind !== 'default' && gate.kind !== 'always') {
        const badge = _gateBadgeProps(gate);
        if (badge) {
          gateBadge = h('span', {
            className: 'metric',
            text: badge.text,
            title: badge.title,
            style: `font-size:9px;padding:0 4px;border-radius:3px;background:${badge.bg};color:${badge.fg};white-space:nowrap;flex-shrink:0`,
          });
        }
      }

      const el = h('div', { className: 'list-item', title: `${name}\n${detail}\n${rightInfo}` }, [
        h('span', { className: 'name clickable', text: name, style: 'font-size:12px;min-width:60px;flex-shrink:0' }),
        gateBadge,
        detail ? h('span', { className: 'metric muted', text: detail, style: 'font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0' }) : null,
        h('span', { className: 'metric muted', text: rightInfo, style: 'font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:1;min-width:0;text-align:right' }),
      ].filter(Boolean));

      el.addEventListener('click', () => {
        // Try to show containing function via extract, fall back to file.
        // IMPORTANT: handler.filepath is where the handler is REFERENCED (the
        // dispatch-table line), not where it's DEFINED. When we're trying to
        // open the handler's DEFINITION, we must NOT use handler.filepath as a
        // file-hint — it'll filter the search to the dispatch-table file and
        // miss the real definition. Same for item.filepath (the descriptor
        // site). Pass filepath=null and let the server scan all files.
        const funcToShow = item.handler?.handlerFunc || item.func;
        if (isPrecondition && item.filepath) {
          // Precondition CLI option (--api-key, --depth, etc.): no real
          // handler to land on. Open the file at the option's declaration
          // line so the user sees the type/help/default rather than the top
          // of a 400-line parseArgs.
          onFileClick(item.filepath, item.line);
        } else if (funcToShow && funcToShow !== '(file scope)') {
          const fp = item.handler?.handlerFunc ? null : (item.filepath || null);
          onFunctionClick({ name: funcToShow, display_name: funcToShow, filepath: fp });
        } else if (item.handler && item.handler.filepath) {
          onFileClick(item.handler.filepath, item.handler.line);
        } else if (item.filepath) {
          onFileClick(item.filepath, item.line);
        }
        renderCommandDetail(item, title);
      });

      itemContainer.appendChild(el);
    }
    container.appendChild(itemContainer);
  }

  makeSection('CLI Options', catalog.cliOptions, 'name', 'flags');
  // Split commands into primary (with descriptions) and secondary (case values etc.)
  const primaryCmds = (catalog.commands || []).filter(c => c.tier === 'primary');
  const secondaryCmds = (catalog.commands || []).filter(c => c.tier !== 'primary');
  makeSection('Commands', primaryCmds, 'name', 'description');
  makeSection('Other switch/case values', secondaryCmds, 'name', 'type');
  makeSection('API Routes', catalog.routes, 'path');
  makeSection('GUI Actions', catalog.guiActions, 'name', 'type');

  if (container.children.length === 0) {
    container.innerHTML = '<div class="list-placeholder">No commands detected</div>';
  }
}

function renderCommandDetail(item, category) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  const name = item.name || item.path || '?';
  title.textContent = `${category}: ${name}`;
  showPane('middle-top');
  _navPush('middle-top');

  let html = '<div class="output-section">';
  html += '<table class="output-table">';
  if (item.name) html += `<tr><td class="muted">Name</td><td class="mono">${escHtml(item.name)}</td></tr>`;
  if (item.path) html += `<tr><td class="muted">Path</td><td class="mono">${escHtml(item.path)}</td></tr>`;
  if (item.type) html += `<tr><td class="muted">Type</td><td class="mono">${escHtml(item.type)}</td></tr>`;
  if (item.flags) html += `<tr><td class="muted">Flags</td><td class="mono">${escHtml(item.flags.join(', '))}</td></tr>`;
  if (item.help) html += `<tr><td class="muted">Help</td><td style="font-size:11px">${escHtml(item.help)}</td></tr>`;
  if (item.func) html += `<tr><td class="muted">Defined in</td><td class="mono"><span class="clickable" data-funcname="${escHtml(item.func)}">${escHtml(item.func)}</span></td></tr>`;
  if (item.filepath) html += `<tr><td class="muted">Definition</td><td class="mono clickable file-link" data-filepath="${escHtml(item.filepath)}" data-start="${item.line || ''}">${escHtml(item.filepath)}:${item.line || ''}</td></tr>`;
  if (item.handler) {
    if (item.handler.handlerFunc) {
      html += `<tr><td class="muted">Handler</td><td class="mono"><span class="clickable" data-funcname="${escHtml(item.handler.handlerFunc)}">${escHtml(item.handler.handlerFunc)}</span></td></tr>`;
    }
    html += `<tr><td class="muted">Dispatch</td><td class="mono clickable file-link" data-filepath="${escHtml(item.handler.filepath)}" data-start="${item.handler.line || ''}">${escHtml(item.handler.filepath)}:${item.handler.line || ''}</td></tr>`;
  }
  // Show all source files if this appears in multiple versions
  if (item.sources && item.sources.length > 1) {
    html += `<tr><td class="muted">Versions</td><td class="mono">${item.sources.length} source files:</td></tr>`;
    for (const src of item.sources) {
      html += `<tr><td></td><td class="mono clickable file-link" data-filepath="${escHtml(src.filepath)}" data-start="${src.line || ''}" style="font-size:11px">${escHtml(src.filepath)}:${src.line || ''}</td></tr>`;
    }
  }
  html += '</table></div>';

  container.innerHTML = html;
  _wireClickables(container, { sourceOnly: true });

  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', () => {
      onFileClick(el.dataset.filepath, parseInt(el.dataset.start) || undefined);
    });
  }
}


// ============================================================================
// Struct Diffs
// ============================================================================

export function renderStructDiffList(container, groups) {
  container.innerHTML = '';
  if (!groups.length) { container.innerHTML = '<div class="list-placeholder">No structural diffs found</div>'; return; }
  for (const g of groups) {
    const item = h('div', { className: 'list-item', title: `${g.name}\n${g.count} copies, ${g.unique_bodies} variants\n${g.summary}` }, [
      h('span', { className: 'rank', text: `${g.rank}` }),
      h('span', { className: 'metric', text: `${g.count}×` }),
      h('span', { className: 'name clickable', text: g.name }),
      h('span', { className: 'metric muted', text: `${g.diffCount}/${g.totalHoles}` }),
    ]);
    item.addEventListener('click', () => renderStructDiffDetail(g));
    container.appendChild(item);
  }
}

function renderStructDiffDetail(group) {
  const container = $('#middle-top-body'), title = $('#middle-top-title');
  title.textContent = `Struct Diff: ${group.name} (${group.count} copies, ${group.unique_bodies} variants)`;
  let html = '<div class="output-section">';

  // Summary
  html += `<div style="padding:4px 0;color:var(--text-bright)">${escHtml(group.summary)}</div>`;

  // Substitutions table
  if (group.substitutions && group.substitutions.length > 0) {
    html += `<table class="output-table"><tr><th>From</th><th>→</th><th>To</th><th>×</th></tr>`;
    for (const s of group.substitutions) {
      html += `<tr><td class="mono">${escHtml(s.from)}</td><td>→</td><td class="mono">${escHtml(s.to)}</td><td>${s.count}</td></tr>`;
    }
    html += '</table>';
  }

  // Instances
  if (group.instances && group.instances.length > 0) {
    html += `<h3 style="margin-top:10px">Instances</h3><table class="output-table"><tr><th>#</th><th>Function</th><th>File</th></tr>`;
    for (let i = 0; i < group.instances.length; i++) {
      const inst = group.instances[i];
      html += `<tr><td class="muted">${i + 1}</td>`;
      html += `<td class="mono"><span class="clickable" data-funcname="${escHtml(inst.name)}" data-filepath="${escHtml(inst.filepath)}">${escHtml(inst.display_name || inst.name)}</span></td>`;
      html += `<td class="mono clickable file-link" data-filepath="${escHtml(inst.filepath)}" data-start="${inst.start || ''}" title="Show file at line ${inst.start || '?'}">${escHtml(shortPath(inst.filepath, 45))}</td></tr>`;
    }
    html += '</table>';
  }

  html += '</div>';
  container.innerHTML = html;
  _wireClickables(container, { sourceOnly: true });

  // Wire file-link clicks (show file scrolled to function)
  for (const el of $$('.file-link[data-filepath]', container)) {
    el.addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const startLine = parseInt(el.dataset.start) || undefined;
      onFileClick(el.dataset.filepath, startLine);
    });
  }
}
