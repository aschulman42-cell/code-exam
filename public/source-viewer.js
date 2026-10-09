// source-viewer.js — renders function/file source in the middle-bottom pane and linkifies call sites
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * source-viewer.js — Function and file source rendering for the
 * middle-bottom pane, plus the `linkifySourceCalls` post-pass that
 * turns function references into clickable links — gated on the index's
 * known function names when available (#275), falling back to optimistic
 * identifier( call-shape matching otherwise. Handles long-line breaking
 * for minified bundles and search-term highlighting via
 * state.highlightTerms.
 *
 * Cross-cutting callbacks (`showContextMenu`,
 * `onFunctionClickSourceOnly`) are injected via `initSourceViewer({...})`
 * to break a potential `source-viewer → context-menu → click-handlers
 * → source-viewer` circular-import cycle. The cycle would otherwise
 * form because click-handlers.js direct-imports `renderSource` /
 * `renderFileSource` from this module, and context-menu.js
 * direct-imports `onFunctionClick` from click-handlers.js.
 *
 * `navUpdateButtons` is a direct import from middle-pane.js — the
 * source-viewer ↔ middle-pane cycle is ES-module-safe (both modules
 * only declare functions at top level).
 */

import { state } from './state.js';
import { api } from './api.js';
import {
  $, displayNameHtml, escHtml, highlightLine, INFERRED_SUFFIX_RE,
} from './dom-utils.js';
import { showPane } from './layout.js';
import { navUpdateButtons } from './middle-pane.js';


// ============================================================================
// Cross-cutting callbacks (injected by initSourceViewer)
// ============================================================================

let _showContextMenu = () => {};
let _onFunctionClickSourceOnly = () => {};

export function initSourceViewer(deps = {}) {
  if (typeof deps.showContextMenu === 'function') _showContextMenu = deps.showContextMenu;
  if (typeof deps.onFunctionClickSourceOnly === 'function') _onFunctionClickSourceOnly = deps.onFunctionClickSourceOnly;
  // #275: an in-place index load/switch (dialogs.js dispatches this event; no
  // page reload happens) invalidates the known-function-name set.
  if (typeof window !== 'undefined') {
    window.addEventListener('ce:index-loaded', () => { _knownNamesPromise = null; _knownNamesResolved = null; });
  }
}


// ============================================================================
// Known function names (#275) — fetched once per index, gates linkification
// ============================================================================

let _knownNamesPromise = null;   // in-flight/settled fetch; null until first use
let _knownNamesResolved = null;  // resolved Set, or null → legacy shape-only mode
let _linkifySeq = 0;             // stale-render guard for the async linkify pass

function knownFunctionNames() {
  if (!_knownNamesPromise) {
    _knownNamesPromise = api.functionNames()
      .then(d => {
        _knownNamesResolved = (d && !d.capped && Array.isArray(d.names)) ? new Set(d.names) : null;
        return _knownNamesResolved;
      })
      .catch(() => (_knownNamesResolved = null));
  }
  return _knownNamesPromise;
}

// Post-render linkify: wait for the name set (instant once cached), then run.
// The seq guard drops the pass if a newer render has replaced the pane's
// contents meanwhile (prevents double-wrapping spans on rapid navigation).
function linkifyWhenReady(container, filepath) {
  const seq = ++_linkifySeq;
  knownFunctionNames().then(known => {
    if (seq !== _linkifySeq) return;
    linkifySourceCalls(container, filepath, known);
  });
}


// ============================================================================
// Source rendering
// ============================================================================

export function renderSource(data) {
  const container = $('#middle-bottom-body'), title = $('#middle-bottom-title');
  title.innerHTML = `${displayNameHtml(data.display_name || data.name)}  (${escHtml(data.filepath)}, ${escHtml(String(data.lines))} lines)`;
  state.currentSourceFile = data.filepath;
  state.lastSourceRender = { kind: 'function', data };
  // #343: prefer start_line (the true first line of the returned text, which is
  // banner-aware) over start (the symbol's signature line) so numbers match the
  // file when a leading doc comment is prepended.
  const lines = data.source.split('\n'), startLine = data.start_line ?? data.start ?? 1;
  const hl = state.highlightTerms;
  const _wrapCls = $('#opt-wrap-lines')?.checked ? ' wrap-lines' : '';
  const _breakEnabled = !!$('#opt-break-long-lines')?.checked;
  let html = `<div class="source-view${_wrapCls}">`;
  for (let i = 0; i < lines.length; i++) {
    const pieces = _breakEnabled ? prettifyLongLine(lines[i]) : [lines[i]];
    for (let k = 0; k < pieces.length; k++) {
      let content = escHtml(pieces[k]);
      if (hl) content = highlightLine(content, hl.terms, hl.colors);
      const contCls = k > 0 ? ' continuation' : '';
      const lineNumDisplay = k === 0 ? String(startLine + i) : '…';
      html += `<div class="source-line${contCls}"><span class="line-number">${lineNumDisplay}</span><span class="line-content">${content}</span></div>`;
    }
  }
  container.innerHTML = html + '</div>';
  // Setting innerHTML does NOT reset scrollTop. Without this, clicking a
  // different function while scrolled mid-pane leaves the new source at the
  // old scroll offset — often hiding the function's definition line.
  container.scrollTop = 0;
  linkifyWhenReady(container, data.filepath);
  navUpdateButtons('middle-bottom');
}

// Heuristic re-flow of a long (typically bundled/minified) line. Keeps the
// real line number on the first piece and emits `…` for the continuations.
// Only acts on lines above `threshold`; returns the original string unchanged
// when no breakpoint fires. Regex-based, not AST-aware — can be fooled by
// keywords inside strings or regex literals.
export function prettifyLongLine(line, threshold = 300) {
  if (!line || line.length < threshold) return [line];
  const BRK = '\x00';
  let marked = line;
  // Break BEFORE `function` keyword (not when used as a property: `.function`).
  marked = marked.replace(/(?<![.\w$])function\b/g, BRK + 'function');
  // Break AFTER `),` — the natural boundary between sibling function-call
  // arguments (`foo(...), bar(...), baz(...)`) and between sibling members
  // in an object-literal arg (`{a: ()=>x, b: ()=>y}` after minification).
  // The arrow `=>` and its body stay intact because they appear BEFORE the
  // closing paren of the surrounding call.
  marked = marked.replace(/\)\s*,\s*(?=\S)/g, '),' + BRK);
  // Break AFTER `;` when followed by code on the same logical line.
  marked = marked.replace(/;\s*(?=\S)/g, ';' + BRK);
  // Break AFTER `,` when the next token looks like a new assignment member
  // (`,name=function`, `,name=(args)=>…`). Covers object-like minified
  // output that doesn't use `),` between members.
  marked = marked.replace(/,\s*(?=\w+\s*[:=]\s*(?:function|async|\([^)]*\)\s*=>))/g, ',' + BRK);
  if (!marked.includes(BRK)) return [line];
  return marked.split(BRK).filter(p => p.length > 0);
}

export function renderFileSource(data, targetLine) {
  showPane('middle-bottom');
  const container = $('#middle-bottom-body'), title = $('#middle-bottom-title');
  title.textContent = `${data.filepath}  (${data.lines} lines)`;
  state.currentSourceFile = data.filepath;
  state.lastSourceRender = { kind: 'file', data, targetLine };
  const lines = data.content.split('\n');
  const baseLineNum = data.startLine || 1;  // offset for windowed file display
  const hl = state.highlightTerms;
  const _wrapCls = $('#opt-wrap-lines')?.checked ? ' wrap-lines' : '';
  const _breakEnabled = !!$('#opt-break-long-lines')?.checked;
  let html = `<div class="source-view${_wrapCls}">`;
  for (let i = 0; i < lines.length; i++) {
    const lineNum = baseLineNum + i;
    const isTarget = targetLine && lineNum === targetLine;
    const pieces = _breakEnabled ? prettifyLongLine(lines[i]) : [lines[i]];
    for (let k = 0; k < pieces.length; k++) {
      let content = escHtml(pieces[k]);
      if (hl) content = highlightLine(content, hl.terms, hl.colors);
      const contCls = k > 0 ? ' continuation' : '';
      const tgtCls = (isTarget && k === 0) ? ' target-line' : '';
      const lineAttr = k === 0 ? ` data-line="${lineNum}"` : '';
      const lineNumDisplay = k === 0 ? String(lineNum) : '…';
      html += `<div class="source-line${tgtCls}${contCls}"${lineAttr}><span class="line-number">${lineNumDisplay}</span><span class="line-content">${content}</span></div>`;
    }
  }
  container.innerHTML = html + '</div>';
  linkifyWhenReady(container, data.filepath);
  navUpdateButtons('middle-bottom');

  // Scroll to target line
  if (targetLine) {
    const targetEl = container.querySelector(`.source-line[data-line="${targetLine}"]`);
    if (targetEl) {
      requestAnimationFrame(() => targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }
}


// ============================================================================
// Linkify: turn identifier( patterns into clickable function-call spans
// ============================================================================

/** Keywords that look like function calls but aren't */
const SOURCE_SKIP_KEYWORDS = new Set([
  'if','else','while','for','switch','case','catch','return','throw',
  'sizeof','typeof','instanceof','new','delete','void','yield','await',
  'assert','print','import','export','from','require','include','define',
  'elif','except','finally','with','as','in','of','is','not','and','or',
  'var','let','const','function','class','struct','enum','interface',
  'public','private','protected','static','virtual','override','final',
  'true','false','null','undefined','this','self','super','None','True','False',
]);

/**
 * Check if a position in text is inside a string literal.
 * Scans from start, tracking quote state (handles ', ", ` and escaped quotes).
 */
function isInsideString(text, pos) {
  let inSingle = false, inDouble = false, inBacktick = false;
  for (let i = 0; i < pos && i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (prev === '\\') continue; // escaped character
    if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
  }
  return inSingle || inDouble || inBacktick;
}

/**
 * Check if position is inside a comment (// or # style line comment).
 */
function isInsideComment(text, pos) {
  // Find first // or # that isn't inside a string
  for (let i = 0; i < pos - 1 && i < text.length; i++) {
    if (isInsideString(text, i)) continue;
    if (text[i] === '/' && text[i + 1] === '/') return pos > i;
    if (text[i] === '#' && (i === 0 || /\s/.test(text[i - 1]))) return pos > i;
  }
  return false;
}

/**
 * #275: decide which identifier occurrences in one text-node's text become
 * links. Pure (no DOM) so node tests can pin the selection behavior
 * (test/test_linkify_selection.js).
 *
 * knownNames Set → "knowledge mode": link ANY identifier — call site or bare
 *   reference (import bindings, callbacks-as-values, export lists) — whose
 *   text is in the set. Generic built-ins (`.map(`, `.push(`, `console.log(`)
 *   stop linking unless the corpus genuinely defines them.
 * knownNames null → legacy "shape mode": link `identifier(` call sites
 *   optimistically (pre-#275 behavior; also the fallback when the name set
 *   is unavailable or capped on very large corpora).
 *
 * Both modes skip keywords, 1-char names, ALL_CAPS macros, identifiers
 * inside string literals or comments, and mid-word boundary artifacts from
 * highlight-split text nodes.
 *
 * @param text          the text-node content being scanned
 * @param fullLineText  the whole rendered line (context for string/comment
 *                      and cross-node call-paren checks)
 * @param charOffset    text's character offset within fullLineText
 * @param knownNames    Set of display names, or null
 * @returns [{ name, start }] — start is an index into `text`
 */
export function findLinkableIdentifiers(text, fullLineText, charOffset, knownNames = null) {
  const out = [];
  // Very long (typically minified, unbroken) display lines: bare-reference
  // broadening would multiply per-hit string/comment scans, so require call
  // shape there even in knowledge mode.
  const requireCall = !knownNames || fullLineText.length > 5000;
  const idPattern = /\b([a-zA-Z_]\w*)\b/g;
  let m;
  while ((m = idPattern.exec(text)) !== null) {
    const name = m[1];
    const absPos = charOffset + m.index;
    // Skip if preceding character in the full line is a word char (text-node
    // boundaries from highlighting can cause false \b matches)
    if (absPos > 0 && /\w/.test(fullLineText[absPos - 1])) continue;
    if (SOURCE_SKIP_KEYWORDS.has(name)) continue;
    if (name.length < 2) continue;
    if (/^[A-Z][A-Z0-9_]+$/.test(name) && name.length > 2) continue;
    // Knowledge gate first (cheap Set lookup) so unknown names never pay the
    // string/comment scans below.
    if (knownNames && !knownNames.has(name)) continue;
    if (requireCall) {
      // `(` after optional whitespace — checked against the FULL line so a
      // call paren split into a sibling text node still counts.
      if (!/^\s*\(/.test(fullLineText.slice(absPos + name.length))) continue;
    }
    if (isInsideString(fullLineText, absPos)) continue;
    if (isInsideComment(fullLineText, absPos)) continue;
    out.push({ name, start: m.index });
  }
  return out;
}

/**
 * Post-process rendered source to make function references clickable.
 * Walks DOM text nodes in .line-content elements; per-node selection is
 * findLinkableIdentifiers() above (knowledge mode when the #275 known-name
 * set is available, legacy identifier( shape mode otherwise).
 *
 * `knownNames` defaults to the module's resolved set at call time, so
 * external callers (middle-pane.js pop-out restore) pick up gating
 * automatically once the set has loaded.
 */
export function linkifySourceCalls(container, contextFilepath, knownNames = _knownNamesResolved) {
  // Detect file type to avoid false highlighting in HTML/CSS
  const ext = contextFilepath ? contextFilepath.replace(/.*\./, '.').toLowerCase() : '';
  const isHtml = /^\.(html?|xhtml|xml|svg|jsp|asp|php|erb|ejs|hbs|vue)$/.test(ext);
  const isCss = /^\.(css|scss|sass|less)$/.test(ext);
  if (isCss) return;  // CSS has no function calls to linkify

  // #268: prose/doc files — an `identifier(` here is prose ("memory
  // management (utility)"), not a call site. The linkifier links
  // optimistically (no known-function check), so on a .md it lights up random
  // words that happen to match inferred names while the real code refs (in
  // backticks) stay dark. Skip linkification entirely for these. (Linking the
  // backtick'd refs properly needs index resolution — a follow-up, not here.)
  const isProse = /^\.(md|markdown|mdown|mkd|rst|adoc|asciidoc|txt|text)$/.test(ext);
  if (isProse) return;

  // For HTML: track whether we're inside a <script> block
  let inScript = !isHtml;  // non-HTML files: always "in script"

  for (const lineEl of container.querySelectorAll('.line-content')) {
    // Get the full line text for string/comment detection
    const fullLineText = lineEl.textContent;

    // HTML: track <script>/<\/script> transitions
    if (isHtml) {
      if (/<script[\s>]/i.test(fullLineText)) inScript = true;
      if (/<\/script>/i.test(fullLineText)) { inScript = false; continue; }
      if (!inScript) continue;  // skip non-script lines in HTML
    }

    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) textNodes.push(node);

    // Track character offset of each text node within the full line
    let charOffset = 0;
    for (const textNode of textNodes) {
      const text = textNode.textContent;
      const hits = findLinkableIdentifiers(text, fullLineText, charOffset, knownNames);
      charOffset += text.length;
      if (hits.length === 0) continue;

      const fragments = [];
      let lastIdx = 0;
      for (const { name, start } of hits) {
        // Add text before this match
        if (start > lastIdx) {
          fragments.push(document.createTextNode(text.slice(lastIdx, start)));
        }

        // Create clickable span for the function name. If the name carries
        // an inferred suffix marker (_KW_/_CMD_/_NAME_/_IMPORT_/_FP_), wrap
        // the suffix portion in a child .inferred-suffix span so the View >
        // Show Inferred Name Suffixes toggle can hide it without re-render.
        const span = document.createElement('span');
        span.className = 'src-fn-link';
        span.dataset.funcname = name;
        const inf = INFERRED_SUFFIX_RE.exec(name);
        if (inf) {
          span.appendChild(document.createTextNode(name.slice(0, inf.index)));
          const suffixSpan = document.createElement('span');
          suffixSpan.className = 'inferred-suffix';
          suffixSpan.textContent = inf[0];
          span.appendChild(suffixSpan);
          const infTail = name.slice(inf.index + inf[0].length);
          if (infTail) span.appendChild(document.createTextNode(infTail));
        } else {
          span.textContent = name;
        }
        span.addEventListener('click', (e) => {
          e.stopPropagation();
          _onFunctionClickSourceOnly({ name, display_name: name, filepath: null });
        });
        span.addEventListener('contextmenu', (e) => {
          e.stopPropagation();
          _showContextMenu(e, { name, display_name: name, filepath: null });
        });
        fragments.push(span);

        lastIdx = start + name.length;
      }

      // Add remaining text
      if (lastIdx < text.length) {
        fragments.push(document.createTextNode(text.slice(lastIdx)));
      }

      // Replace the text node with our fragments
      const parent = textNode.parentNode;
      for (const frag of fragments) {
        parent.insertBefore(frag, textNode);
      }
      parent.removeChild(textNode);
    }
  }

  // Post-pass: highlighted search terms (<mark> elements) whose identifier
  // the main walk didn't already link. Historically needed because the
  // identifier lives inside the <mark> and its `(` in a sibling text node;
  // the full-line paren check above now covers most of that, so this is
  // belt-and-braces for remaining split shapes. Same #275 gate: with a
  // known-name set, membership decides; without one, require the call paren.
  for (const mark of container.querySelectorAll('mark')) {
    if (mark.querySelector('.src-fn-link')) continue; // main pass already linked inside
    const name = mark.textContent;
    if (!name || !/^[a-zA-Z_]\w*$/.test(name)) continue;
    if (name.length < 2) continue;
    if (SOURCE_SKIP_KEYWORDS.has(name)) continue;
    if (knownNames) {
      if (!knownNames.has(name)) continue;
    } else {
      // Check next sibling text starts with `(` (skipping whitespace).
      // Traverse forward collecting text until we see a non-space char.
      let node = mark.nextSibling;
      let tail = '';
      while (node && tail.length < 5) {
        tail += node.textContent || '';
        node = node.nextSibling;
      }
      if (!/^\s*\(/.test(tail)) continue;
    }
    mark.classList.add('src-fn-link');
    mark.style.cursor = 'pointer';
    mark.addEventListener('click', (e) => {
      e.stopPropagation();
      _onFunctionClickSourceOnly({ name, display_name: name, filepath: null });
    });
    mark.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      _showContextMenu(e, { name, display_name: name, filepath: null });
    });
  }
}
