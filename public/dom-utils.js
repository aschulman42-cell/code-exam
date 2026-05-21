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

export function shortPath(fp, maxLen = 45) {
  if (!fp) return '';
  fp = fp.replace(/\\/g, '/');
  return fp.length <= maxLen ? fp : '…' + fp.slice(-(maxLen - 1));
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

/** Make a floating panel draggable by its header. */
export function makeDraggable(panel, handle) {
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
