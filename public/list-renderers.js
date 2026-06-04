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
  $, $$, h, escHtml, displayNameHtml, shortPath,
} from './dom-utils.js';
import { showPane } from './layout.js';
import {
  onFunctionClick, onFileClick, onClassClick, onVocabClick,
} from './click-handlers.js';
import { showContextMenu } from './context-menu.js';
import { renderMermaid } from './mermaid.js';
import { showMiddleTopError, clearAllPanes } from './middle-pane.js';
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
      h('span', { className: 'name clickable', html: displayNameHtml(f.display_name || f.name) }),
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
    const nameSpan = h('span', { className: 'name clickable', text: name, style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' });
    const subHeader = h('div', { className: 'sub-accordion-header' }, [
      h('span', { className: 'sub-accordion-toggle', text: '▸' }),
      nameSpan,
      h('span', { className: 'filepath', text: dir, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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

export function renderExtensionList(container, extensions, totalFiles, filter) {
  container.innerHTML = '';
  if (!extensions || !extensions.length) { container.innerHTML = '<div class="list-placeholder">No extensions found</div>'; return; }

  const pat = filter ? filter.toLowerCase() : null;
  const filtered = pat ? extensions.filter(e => e.ext.toLowerCase().includes(pat)) : extensions;

  for (const e of filtered) {
    const item = h('div', { className: 'list-item clickable', title: `${e.count} files (${e.pct}% of ${totalFiles})` }, [
      h('span', { className: 'metric', text: `${e.count}`, style: 'min-width:32px' }),
      h('span', { className: 'name', text: e.ext, style: 'color:var(--text-bright);font-family:var(--font-mono)' }),
      h('span', { className: 'metric muted', text: `${e.pct}%`, style: 'min-width:36px;text-align:right' }),
    ]);
    item.addEventListener('click', () => {
      $('#left-filter').value = e.ext;
      $('#left-filter').dispatchEvent(new Event('input'));
    });
    container.appendChild(item);
  }
}


// ============================================================================
// Classes list — with sub-accordion to show methods inline
// ============================================================================

export function renderClassListWithSub(container, classes, total) {
  container.innerHTML = '';
  if (!classes || !classes.length) { container.innerHTML = '<div class="list-placeholder">No classes found</div>'; return; }

  for (const c of classes) {
    const subContent = h('div', { className: 'sub-accordion-content' });
    const subHeader = h('div', { className: 'sub-accordion-header' }, [
      h('span', { className: 'sub-accordion-toggle', text: '▸' }),
      h('span', { className: 'name', html: displayNameHtml(c.name), style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' }),
      h('span', { className: 'metric', text: `${c.methods}m` }),
      h('span', { className: 'metric', text: `${c.total_lines}L` }),
      h('span', { className: 'filepath', text: c.filepath?.replace(/\\/g, '/') || '', style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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

    // Right-click: context menu (Digest works on classes via dispatcher in
    // CSI's buildDigest, which routes filepath@ClassName to class digest).
    subHeader.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      showContextMenu(e, { name: c.name, display_name: c.name, filepath: c.filepath });
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
      h('span', { className: 'name clickable', html: displayNameHtml(m.name), style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright)' }),
      h('span', { className: 'metric', text: `→ ${m.base}`, title: fullChain, style: 'color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;max-width:160px;flex-shrink:0' }),
      h('span', { className: 'metric', text: `${m.methods}m` }),
      h('span', { className: 'filepath', text: m.filepath?.replace(/\\/g, '/') || '', style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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
      h('span', { className: 'name clickable', text: nameText, style: `flex:1;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${unresolved ? 'var(--warning,#c79a4e)' : 'var(--text-bright)'}${unresolved ? ';font-style:italic' : ''}` }),
      h('span', { className: 'filepath', text: `${shortPath(a.filepath || '')}:${a.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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

const _KERNEL_KIND_COLOR = { 'kernel-def': '#6cf', 'launch': '#fc6', 'device-fn': 'var(--text-muted)' };

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
      h('span', { className: 'name clickable', text: k.name || '', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'filepath', text: `${shortPath(k.filepath || '')}:${k.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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

const _DATASET_KIND_COLOR = { 'definition': '#6cf', 'loader': '#fc6' };

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
      h('span', { className: 'name clickable', text: basenameIfPath(d.name) || '', style: `flex:1;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${d.resolved === false ? 'var(--warning,#c79a4e)' : 'var(--text-bright)'}${d.resolved === false ? ';font-style:italic' : ''}` }),
      d.builtin ? h('span', { className: 'metric', text: 'built-in', style: 'color:var(--text-muted);font-size:9px;flex-shrink:0' }) : null,
      h('span', { className: 'filepath', text: `${shortPath(d.filepath || '')}:${d.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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

const _TRAINING_KIND_COLOR = { 'training-loop': '#fc6', 'training-harness': '#6cf' };

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
      h('span', { className: 'name clickable', text: t.name || '', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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

const _INFER_KIND_COLOR = { 'generation': '#fc6', 'inference': '#6cf' };

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
      h('span', { className: 'name clickable', text: (t.name || '') + (t.id ? ' → ' + basenameIfPath(t.id) : ''), style: `flex:1;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${t.id && t.resolved === false ? 'var(--warning,#c79a4e)' : 'var(--text-bright)'}` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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

const _LLMCALL_KIND_COLOR = { 'call': '#fc6', 'client': '#6cf', 'wrapper': '#a9f', 'endpoint': 'var(--text-muted)' };

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
      h('span', { className: 'name clickable', text: (t.marker || '') + (t.lvc ? ' [lib?]' : ''), style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'metric', text: t.model ? '→ ' + basenameIfPath(t.model) : '', style: `flex-shrink:0;max-width:170px;${t.model ? 'margin-right:14px;' : ''}font-size:10px;overflow:hidden;text-overflow:ellipsis;color:${t.model && t.modelResolved ? 'var(--success,#7c7)' : 'var(--warning,#c79a4e)'}${t.model && !t.modelResolved ? ';font-style:italic' : ''}` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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
      h('span', { className: 'name clickable', text: (t.name || '—') + (t.lvc ? ' [lib?]' : ''), style: `flex:1;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:${t.name ? 'var(--text-bright)' : 'var(--text-muted)'}` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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
const _CHAIN_KIND_COLOR = { 'chain': '#6cf', 'graph': '#a9f', 'agent': '#fc6' };

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
      h('span', { className: 'name clickable', text: t.name || '', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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
      h('span', { className: 'name clickable', text: t.marker || '', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'metric', text: t.id ? '→ ' + basenameIfPath(t.id) : '', style: `flex-shrink:0;max-width:200px;${t.id ? 'margin-right:14px;' : ''}font-size:10px;overflow:hidden;text-overflow:ellipsis;color:${t.id && t.resolved !== false ? 'var(--success,#7c7)' : 'var(--warning,#c79a4e)'}${t.id && t.resolved === false ? ';font-style:italic' : ''}` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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
      className: 'list-item',
      title: `${m.model}\naccess: ${m.access}\ncells: ${(m.cells || []).join(', ')}\n${m.count} site${m.count > 1 ? 's' : ''}${site0.filepath ? `\nfirst: ${(site0.filepath || '').replace(/\\/g, '/')}:${site0.line}` : ''}`,
    }, [
      h('span', { className: 'metric', text: m.access, style: `min-width:54px;color:${accColor};font-size:10px` }),
      h('span', { className: 'name clickable', text: basenameIfPath(m.model) || '', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
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

const _SO_KIND_COLOR = { schema: '#6cf', format: '#7c7', parser: '#a9f', constrained: '#fc6' };

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
      h('span', { className: 'name clickable', text: t.marker || '', style: 'flex:1;overflow:hidden;text-overflow:ellipsis;color:var(--text-bright);font-size:11px' }),
      h('span', { className: 'metric', text: t.id ? '→ ' + t.id : '', style: `flex-shrink:0;max-width:200px;${t.id ? 'margin-right:12px;' : ''}font-size:10px;overflow:hidden;text-overflow:ellipsis;color:var(--success,#7c7)` }),
      h('span', { className: 'filepath', text: `${shortPath(t.filepath || '')}:${t.line}`, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }),
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
      h('span', { className: 'name', text: label, style: nameStyle + ';flex:1;overflow:hidden;text-overflow:ellipsis' }),
      metaText ? h('span', { className: 'metric muted', text: metaText, style: 'font-size:10px' }) : null,
      fpText ? h('span', { className: 'filepath', text: fpText, style: 'font-family:var(--font-mono);font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left;flex-shrink:1;min-width:0' }) : null,
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

export function renderVocabList(container, vocab) {
  container.innerHTML = '';
  if (!vocab.length) { container.innerHTML = '<div class="list-placeholder">No vocabulary</div>'; return; }
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
// Indexes list
// ============================================================================

export function renderIndexesList(container, data) {
  container.innerHTML = '';
  const loaded = data.loaded || [];
  const available = data.available || [];

  // Hint: this accordion only scans the current/last-used directory
  container.appendChild(h('div', { className: 'list-placeholder', text: 'Showing indexes in current directory. Use Load Index dialog (File menu) for other locations.', style: 'padding:4px 8px;font-size:10px;color:var(--text-muted);line-height:1.4' }));

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
