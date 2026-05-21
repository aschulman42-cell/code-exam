/**
 * source-viewer.js — Function and file source rendering for the
 * middle-bottom pane, plus the `linkifySourceCalls` post-pass that
 * turns identifier( patterns into clickable function-call links.
 * Handles long-line breaking for minified bundles and search-term
 * highlighting via state.highlightTerms.
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
}


// ============================================================================
// Source rendering
// ============================================================================

export function renderSource(data) {
  const container = $('#middle-bottom-body'), title = $('#middle-bottom-title');
  title.innerHTML = `${displayNameHtml(data.display_name || data.name)}  (${escHtml(data.filepath)}, ${escHtml(String(data.lines))} lines)`;
  state.currentSourceFile = data.filepath;
  state.lastSourceRender = { kind: 'function', data };
  const lines = data.source.split('\n'), startLine = data.start || 1;
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
  linkifySourceCalls(container, data.filepath);
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
  linkifySourceCalls(container, data.filepath);
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
 * Post-process rendered source to make function calls clickable.
 * Walks DOM text nodes in .line-content elements, finds identifier( patterns,
 * wraps them in clickable spans. Skips identifiers inside strings/comments.
 */
export function linkifySourceCalls(container, contextFilepath) {
  const callPattern = /\b([a-zA-Z_]\w*)\s*\(/g;

  // Detect file type to avoid false highlighting in HTML/CSS
  const ext = contextFilepath ? contextFilepath.replace(/.*\./, '.').toLowerCase() : '';
  const isHtml = /^\.(html?|xhtml|xml|svg|jsp|asp|php|erb|ejs|hbs|vue)$/.test(ext);
  const isCss = /^\.(css|scss|sass|less)$/.test(ext);
  if (isCss) return;  // CSS has no function calls to linkify

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
      callPattern.lastIndex = 0;
      const fragments = [];
      let lastIdx = 0;
      let match;

      while ((match = callPattern.exec(text)) !== null) {
        const name = match[1];
        const matchStart = match.index;
        const absPos = charOffset + matchStart; // position in full line

        // Skip if preceding character in full line is a word char
        // (text node boundary from highlighting can cause false \b matches)
        if (absPos > 0 && /\w/.test(fullLineText[absPos - 1])) continue;

        // Skip keywords, too-short names, ALL_CAPS macros
        if (SOURCE_SKIP_KEYWORDS.has(name)) continue;
        if (name.length < 2) continue;
        if (/^[A-Z][A-Z0-9_]+$/.test(name) && name.length > 2) continue;

        // Skip if inside string literal or comment
        if (isInsideString(fullLineText, absPos)) continue;
        if (isInsideComment(fullLineText, absPos)) continue;

        // Add text before this match
        if (matchStart > lastIdx) {
          fragments.push(document.createTextNode(text.slice(lastIdx, matchStart)));
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

        // Add the "(" back as plain text
        lastIdx = matchStart + match[0].length;
        fragments.push(document.createTextNode(match[0].slice(name.length)));
      }

      charOffset += text.length;

      if (fragments.length === 0) continue; // No matches in this text node

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

  // Post-pass: highlighted search terms (<mark> elements) aren't caught by
  // the text-node walk above because the identifier lives inside the <mark>
  // and its `(` lives in the sibling text node — the `name\s*\(` regex can't
  // match across two separate text nodes. Wire clicks onto <mark> elements
  // whose text is an identifier AND whose following sibling chain starts
  // with `(`, so highlighted function names behave like linkified ones.
  for (const mark of container.querySelectorAll('mark')) {
    const name = mark.textContent;
    if (!name || !/^[a-zA-Z_]\w*$/.test(name)) continue;
    if (name.length < 2) continue;
    if (SOURCE_SKIP_KEYWORDS.has(name)) continue;
    // Check next sibling text starts with `(` (skipping whitespace).
    // Traverse forward collecting text until we see a non-space char.
    let node = mark.nextSibling;
    let tail = '';
    while (node && tail.length < 5) {
      tail += node.textContent || '';
      node = node.nextSibling;
    }
    if (!/^\s*\(/.test(tail)) continue;
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
