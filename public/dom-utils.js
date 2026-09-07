// dom-utils.js — dependency-free DOM helpers, path/name formatters, and search-highlight utilities
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * dom-utils.js — DOM helpers, string formatters, and search-highlight
 * utilities. Pure leaves: no dependencies on state, api, or any other
 * UI module. Anything that touches the DOM or shapes strings for
 * display lives here.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else if (child) el.appendChild(child);
  }
  return el;
}

export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inferred-name suffix split (TODO #374). Pairs with body.hide-inferred-suffix
// CSS rule. Marker prefixes (_KW_, _CMD_, _NAME_, _IMPORT_, _FP_) are appended
// during indexing in CodeSearchIndex.js — the suffix is uppercase/digit/
// underscore tokens after the marker. Anything after that (e.g. ::method) is
// part of the original identifier path and is preserved. Examples:
//   GCz_KW_ADD_OPTION_HELP        -> base "GCz", suffix "_KW_ADD_OPTION_HELP"
//   le6_KW_REMOVE_ALL_SCHEMAS::ctor -> base "le6", suffix "_KW_REMOVE_ALL_SCHEMAS", tail "::ctor"
export const INFERRED_SUFFIX_RE = /_(?:KW|CMD|NAME|IMPORT|FP)_[A-Z0-9_]+/;
export function displayNameHtml(name) {
  if (!name) return '';
  const m = INFERRED_SUFFIX_RE.exec(name);
  if (!m) return escHtml(name);
  const base = name.slice(0, m.index);
  const suffix = m[0];
  const tail = name.slice(m.index + suffix.length);
  return escHtml(base)
       + `<span class="inferred-suffix">${escHtml(suffix)}</span>`
       + escHtml(tail);
}

// When a row's "function" scope is a sentinel ((file scope) / (unknown)) or empty,
// return the file's BASENAME instead — more informative in the left pane than the
// bare sentinel, which otherwise required a click to learn the file. Returns a
// plain string; callers apply their own escaping / displayNameHtml, and keep
// data-funcname as the raw sentinel so clicking still routes to the file.
// (#left-pane-file-scope-filename)
const _SCOPE_SENTINELS = new Set(['(file scope)', '(unknown)']);
export function funcOrFileLabel(name, filepath) {
  if ((!name || _SCOPE_SENTINELS.has(name)) && filepath) {
    return String(filepath).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
  }
  return name || '(file scope)';
}

export function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => execCopyFallback(text));
  }
  return execCopyFallback(text);
}

function execCopyFallback(text) {
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (e) {
      reject(e);
    } finally {
      document.body.removeChild(ta);
    }
  });
}

/**
 * Download a string as a text file (client-side, no server round-trip). #177
 */
export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Pane text extraction for Save/Copy (#177).
 *
 * Robustness notes (hard-won on Windows/Chromium):
 * - Reads innerText off a clone mounted off-screen so layout-derived line
 *   breaks are correct. The clone is always the WHOLE body, never a
 *   sub-element in isolation: the accordion's display rule is ancestor-scoped
 *   (`.accordion-section.open > .accordion-content`), so a bare
 *   `.accordion-content` clone loses the `.open` ancestor, renders display:none,
 *   and innerText collapses everything onto one line.
 * - `.list-item` rows are flex with no whitespace text nodes between their cell
 *   spans, so innerText runs them together ("github-actions:34×34"). We insert
 *   a tab between each row's cells before reading.
 *
 * Line numbers: stripped by default — matches the `--extract` CLI convention.
 * Pass { lineNumbers: true } (GUI: Shift-click) to keep them, tab-separated.
 * NOTE (#177 cross-surface inconsistency): the opposite of the `--show-file`
 * CLI command, which prints line numbers. A future change could unify them or
 * add the toggle to `--show-file`.
 */
function _prepPaneClone(bodyEl, lineNumbers) {
  const clone = bodyEl.cloneNode(true);
  // KEEP .list-placeholder: besides empty-state hints, that class also carries
  // footer counts, truncation warnings ("Showing X of Y+"), and honesty caveats
  // (list-renderers.js). Those MUST survive into a saved/copied file so it never
  // looks more complete — or less qualified — than the GUI (#177). Strip only
  // pure UI chrome.
  clone.querySelectorAll('button, .pane-popout-placeholder, .accordion-toggle, .sub-accordion-toggle')
    .forEach((el) => el.remove());
  // #215 saved-text cleanup: strip FORM CONTROLS and their labels. Saving a
  // pane that carries a controls row (the Chat/Workspace engine selects,
  // "tool calls" checkboxes, grounding selector, …) used to print every
  // setting's NAME regardless of its state — noise in a shared artifact.
  // A label wrapping a control is removed whole; bare selects/inputs too.
  clone.querySelectorAll('select, input, textarea').forEach((el) => {
    const label = el.closest('label');
    (label || el).remove();
  });
  if (!lineNumbers) clone.querySelectorAll('.line-number').forEach((el) => el.remove());

  // Flex rows blockify their cell children, so innerText would put each cell on
  // its OWN line. Flatten each row to a single tab-joined string so the row
  // stays on one line; the row is still block-level, so the line break BETWEEN
  // rows is preserved. List/label rows collapse cell whitespace; source lines
  // must keep code indentation intact, so they're handled separately.
  clone.querySelectorAll('.list-item, .sub-accordion-header').forEach((row) => {
    const parts = [];
    for (const n of row.childNodes) {
      const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
    row.textContent = parts.join('\t');
  });
  // (Source lines are NOT flattened here — see sourceText(): flattening them and
  // reading via innerText collapsed `white-space: pre` indentation. #177)
  return clone;
}

function _mount(clone, width) {
  clone.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px`;
  document.body.appendChild(clone);
  return clone;
}

function _tidy(text) {
  // #215: normalize \r\n FIRST — interleaved \r defeated the blank-line
  // collapse below ("\r\n\r\n\r\n" never matches /\n{3,}/), which is how
  // saved chats ended up with long runs of blank lines on Windows.
  return text.replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+\n/g, '\n')        // strip trailing spaces/tabs/NBSP per line
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Two adjacent element cells are "visually separated" when they sit on the same
// row but a margin/padding gap divides them (e.g. the L98 / func / snippet cells
// of a search-result row). Geometry-based, so adjacent syntax tokens — which
// touch with no gap — are NOT split.
function _visualGap(a, b) {
  const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
  return ra.height && rb.height && rb.top < ra.bottom && rb.left - ra.right > 1;
}

// A "leaf line" is a text-bearing element whose children are all inline — i.e.
// it occupies its own line(s) of rendered text. Container elements (with block
// children) are skipped; their leaf descendants carry the text.
function _display(el) { return getComputedStyle(el).display; }
function _isInlineEl(el) { return _display(el).startsWith('inline'); }
function _isBlockLine(el) {
  const d = _display(el);
  return d === 'block' || d === 'flex' || d === 'list-item' || d === 'flow-root';
}

function _isLeafLine(el) {
  if (!el.textContent || !el.textContent.trim()) return false;
  for (const c of el.children) {
    const d = getComputedStyle(c).display;
    if (d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' || d === 'flow-root' || d.startsWith('table')) return false;
  }
  return true;
}

export function paneText(bodyEl, { lineNumbers = false } = {}) {
  if (!bodyEl) return '';
  const clone = _mount(_prepPaneClone(bodyEl, lineNumbers), bodyEl.clientWidth || 800);
  // 1. Restore inter-cell spacing that lives in CSS margins, not text, so cells
  //    don't run together in innerText ("L98DynamicGenDataset" -> "L98 Dynamic…").
  for (const el of clone.querySelectorAll('*')) {
    const kids = [...el.children];
    for (let i = 0; i < kids.length - 1; i++) {
      if (_isInlineEl(kids[i]) && _isInlineEl(kids[i + 1]) && _visualGap(kids[i], kids[i + 1])) kids[i].insertAdjacentText('afterend', ' ');
    }
  }
  // 2. Indent each leaf line by its visual left offset (e.g. search results
  //    indented under their file header). NBSP so innerText doesn't collapse the
  //    leading whitespace; converted back to plain spaces after reading.
  const lines = [...clone.querySelectorAll('*')].filter((el) => _isLeafLine(el) && _isBlockLine(el));
  if (lines.length) {
    const base = Math.min(...lines.map((el) => el.getBoundingClientRect().left));
    for (const el of lines) {
      const indent = Math.round((el.getBoundingClientRect().left - base) / 8);
      if (indent > 0) el.insertAdjacentText('afterbegin', '\u00A0'.repeat(indent));
    }
  }
  const text = clone.innerText.replace(/\u00A0/g, ' ');
  clone.remove();
  return _tidy(text);
}

/**
 * Left-pane (accordion) extraction (#177): only the OPEN sections (heading +
 * content); if none open, just the category list. Clones the whole body so the
 * `.open` display context survives.
 */
function accordionText(bodyEl) {
  const clone = _mount(_prepPaneClone(bodyEl, false), bodyEl.clientWidth || 800);
  // textContent (not innerText) for headers — the flex header blockifies its
  // badge span, which innerText would push onto its own line ("Infrastructure\n2").
  const hdr = (el) => (el?.textContent || '').replace(/[▸▾]/g, '').replace(/\s+/g, ' ').trim();
  let out;
  const open = [...clone.querySelectorAll('.accordion-section.open')];
  if (open.length) {
    out = open.map((sec) => {
      const header = hdr(sec.querySelector('.accordion-header'));
      const content = _tidy(sec.querySelector('.accordion-content')?.innerText || '');
      return content ? `## ${header}\n${content}` : `## ${header}`;
    }).join('\n\n');
  } else {
    const lines = [];
    clone.querySelectorAll('.accordion-group-label, .accordion-header').forEach((el) => {
      const t = hdr(el);
      if (t) lines.push(el.classList.contains('accordion-group-label') ? `# ${t}` : `- ${t}`);
    });
    out = lines.join('\n');
  }
  clone.remove();
  return out.trim();
}

/**
 * Source-pane extraction (#177): read each line's `.line-content` textContent
 * directly so `white-space: pre` indentation survives verbatim (innerText
 * collapses leading whitespace). Long lines are hard-split into
 * `.source-line.continuation` pieces for display — concatenate those onto the
 * prior line WITHOUT a newline (and without a line number) so display wrapping
 * doesn't become real line breaks in the saved file. Wrap toggles
 * (pre ↔ pre-wrap) don't affect textContent, so this is wrap-agnostic.
 */
function sourceText(bodyEl, lineNumbers) {
  let out = '';
  for (const ln of bodyEl.querySelectorAll('.source-line')) {
    // #215: strip newlines that rode in from a CRLF source file. A CRLF line
    // leaves a trailing \r after `data.source.split('\n')`, and the HTML
    // parser then NORMALIZES that \r to \n when it enters the DOM — so by the
    // time we read `.line-content` textContent the artifact char is \n, not
    // \r (an \r-only strip missed it, leaving a blank line between every line
    // in the saved file). A `.line-content` is always ONE display line, so
    // stripping all \r/\n from it is safe.
    const code = (ln.querySelector('.line-content')?.textContent ?? '').replace(/[\r\n]+/g, '');
    if (ln.classList.contains('continuation')) {
      out += code;                                  // same logical line — no break
    } else {
      if (out) out += '\n';
      if (lineNumbers) {
        const num = ln.querySelector('.line-number');
        if (num) out += num.textContent.trim() + '\t';
      }
      out += code;
    }
  }
  return out;
}

/** Dispatch: source → structural (indentation-safe); accordion → scoped; else generic. */
export function extractPaneText(bodyEl, opts) {
  if (!bodyEl) return '';
  if (bodyEl.querySelector('.source-line')) return sourceText(bodyEl, !!(opts && opts.lineNumbers));
  if (bodyEl.querySelector('.accordion-section')) return accordionText(bodyEl);
  return paneText(bodyEl, opts);
}

/**
 * Filename base for a Save (#177). For the accordion left pane, reflect the
 * open sections (or "categories" if none open) rather than a fixed label;
 * otherwise use the button's declared name.
 */
export function paneSaveName(bodyEl, fallback) {
  if (bodyEl && bodyEl.querySelector('.accordion-section')) {
    const open = [...bodyEl.querySelectorAll('.accordion-section.open')];
    if (!open.length) return 'categories';
    const names = open.map((s) => (s.querySelector('.accordion-header')?.textContent || '')
      .replace(/[▸▾]/g, '').replace(/\d+/g, '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).filter(Boolean);
    return names.join('_').slice(0, 40) || (fallback || 'left-pane');
  }
  return fallback || 'pane';
}

export function shortPath(fp, maxLen = 45) {
  if (!fp) return '';
  fp = fp.replace(/\\/g, '/');
  return fp.length <= maxLen ? fp : '…' + fp.slice(-(maxLen - 1));
}

/**
 * Dominant directory prefix shared by most of `paths`. Unlike a strict common
 * prefix (which a single outlier zeroes out), this walks segment by segment
 * keeping the most common next dir while >= `minShare` of all paths still
 * share it — so "all but a few" paths still yield a peelable prefix. Lets the
 * caller peel the prefix once into a header and shorten the rows.
 * @returns {{ prefix: string, covered: number, total: number }}
 *   prefix ends in '/', or '' when nothing worth peeling (too short / too rare).
 */
export function commonPathPrefix(paths, { minShare = 0.6, minLen = 12 } = {}) {
  const norm = (paths || []).map(p => String(p || '').replace(/\\/g, '/')).filter(Boolean);
  const total = norm.length;
  if (total < 2) return { prefix: '', covered: 0, total };
  const dirs = norm.map(p => p.split('/').slice(0, -1)); // directory segments (drop filename)

  // 1. Strict common dir prefix (covers ALL paths) — preferred when long enough.
  const common = dirs[0].slice();
  for (let i = 1; i < dirs.length && common.length; i++) {
    const d = dirs[i];
    let k = 0;
    while (k < common.length && k < d.length && common[k] === d[k]) k++;
    common.length = k;
  }
  const strict = common.length ? common.join('/') + '/' : '';
  if (strict.length >= minLen) return { prefix: strict, covered: total, total };

  // 2. Dominant prefix (shared by >= minShare) — the "all but a few" case,
  // where one path diverges early and zeroes out the strict prefix.
  const chosen = [];
  for (let depth = 0; ; depth++) {
    const counts = new Map();
    for (const d of dirs) {
      let ok = true;
      for (let k = 0; k < chosen.length; k++) if (d[k] !== chosen[k]) { ok = false; break; }
      if (ok && depth < d.length) counts.set(d[depth], (counts.get(d[depth]) || 0) + 1);
    }
    let best = null, bestN = 0;
    for (const [seg, n] of counts) if (n > bestN) { best = seg; bestN = n; }
    if (best == null || bestN / total < minShare) break;
    chosen.push(best);
  }
  const dom = chosen.length ? chosen.join('/') + '/' : '';
  if (dom.length < minLen) return { prefix: '', covered: 0, total };
  const covered = norm.filter(p => p.startsWith(dom)).length;
  return { prefix: dom, covered, total };
}

/**
 * Truncate a function display name for compact display. Unlike shortPath, the
 * INFORMATIVE part of a rename-tier display name is at the FRONT (the bare
 * name, e.g. `MCz` in `MCz_KW_NO_DEFAULT_CURRENT_PROCESS`), so we truncate
 * from the tail and leave an ellipsis at the end.
 */
export function shortFuncName(name, maxLen = 20) {
  if (!name) return '';
  return name.length <= maxLen ? name : name.slice(0, maxLen - 1) + '…';
}

/** Colors for multi-term highlighting (up to 8 terms) */
export const HIGHLIGHT_COLORS = [
  '#8B8000',   // dark yellow
  '#2E6B2E',   // dark green
  '#6B2E6B',   // dark purple
  '#2E4B6B',   // dark blue
  '#6B4B2E',   // dark orange
  '#2E6B6B',   // dark cyan
  '#6B2E4B',   // dark magenta
  '#4B6B2E',   // olive
];

// #177: shared stacking counter so clicking any floating window raises it above
// the others (z-order for overlapping pop-outs / panels). Starts above the
// static baselines (.floating-panel 250, .modal-overlay 300).
let _zTop = 400;
export function bringToFront(el) { if (el) el.style.zIndex = String(++_zTop); }

/** Make a floating panel draggable by its header. */
export function makeDraggable(panel, handle) {
  panel.addEventListener('mousedown', () => bringToFront(panel));
  handle.addEventListener('mousedown', (e) => {
    if (e.target.tagName === 'BUTTON') return;  // don't drag when clicking buttons
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;  // and inputs
    e.preventDefault();
    const startX = e.clientX, startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    const startLeft = rect.left, startTop = rect.top;

    // Switch from right-positioned to left-positioned for dragging. Also
    // force position: fixed -- floating panels already have that, but
    // .modal-overlay dialogs (Issue #19) flex-center their .modal child
    // (position: static), so inline left/top would otherwise be ignored.
    panel.style.position = 'fixed';
    panel.style.left = startLeft + 'px';
    panel.style.top = startTop + 'px';
    panel.style.right = 'auto';

    const onMove = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      panel.style.left = Math.max(0, startLeft + dx) + 'px';
      panel.style.top = Math.max(0, startTop + dy) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/** Make a floating panel resizable from a corner handle. */
export function makeResizable(panel, handle) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX, startY = e.clientY;
    const startW = panel.offsetWidth, startH = panel.offsetHeight;

    const onMove = (ev) => {
      const newW = Math.max(300, startW + ev.clientX - startX);
      const newH = Math.max(200, startH + ev.clientY - startY);
      panel.style.width = newW + 'px';
      panel.style.height = newH + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/**
 * Highlight search terms in an already-escaped HTML line.
 * Returns HTML string with <mark> tags wrapping matches.
 * Each term gets a distinct background color.
 */
export function highlightLine(escapedHtml, terms, colors) {
  if (!terms || !terms.length) return escapedHtml;
  let result = escapedHtml;
  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (!term) continue;
    // Build regex: escape special chars, case-insensitive
    // Term might be a regex pattern (from multisect /pattern/), strip leading/trailing slashes
    let pattern = term.replace(/^\/|\/$/g, '');
    // Escape for use in regex (but keep . and * if from regex pattern)
    const isRegex = term.startsWith('/') && term.endsWith('/');
    if (!isRegex) {
      pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    try {
      const re = new RegExp(`(${pattern})`, 'gi');
      const bg = colors[i % colors.length];
      result = result.replace(re, `<mark style="background:${bg};color:#fff;padding:0 1px;border-radius:1px">$1</mark>`);
    } catch { /* invalid regex, skip */ }
  }
  return result;
}
