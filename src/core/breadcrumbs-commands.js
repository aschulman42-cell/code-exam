// breadcrumbs-commands.js — extracts telemetry breadcrumbs and the CLI/route/GUI-action command catalog from indexed lines
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * breadcrumbs-commands.js — Two extractor methods pulled out of
 * CodeSearchIndex.js in Issue #18 Phase 2 (theme #6, the third of the
 * big-5 targets).
 *
 *   extractBreadcrumbs(idx, showProgress) — walks function bodies for
 *     telemetry/trace breadcrumb patterns: funcName("string_label"),
 *     console.log("[TAG] ..."), tagged-event identifiers.
 *
 *   extractCommandCatalog(idx, showProgress) — walks the function index
 *     for command-handler shapes (objects with name/description/isEnabled
 *     fields), extracts the catalog, classifies each gate via
 *     _classifyCommandGate (imported from ./CSI-helpers.js).
 *
 * Internal references that became idx.X: _findContainingFunctionFromBounds,
 * _getFuncBoundaries, fileLines.
 */

import { eprint, eprogress } from '../utils.js';
import { _classifyCommandGate } from './CSI-helpers.js';

// ========================================================================
// Telemetry breadcrumbs: extract trace points from indexed lines
// ========================================================================

/**
 * Extract telemetry breadcrumbs / trace points from the codebase.
 * Detects patterns like:
 *   funcName("string_label")  — timing markers, trace points
 *   console.log("[TAG] ...")  — tagged log messages
 *   n("prefix_event_name")   — telemetry/analytics events
 *
 * Returns { markers: [...], events: [...] } sorted by line number.
 * Markers are timing/trace points (small set, ordered).
 * Events are telemetry calls (larger set, categorized by prefix).
 */
export function extractBreadcrumbs(idx, showProgress = true) {
  const markers = [];  // timing/trace points: { label, filepath, line, func }
  const events = [];   // telemetry events: { name, filepath, line, func }

  // Detect common tracing function patterns
  // Pass 1: find which function names are used as trace/timing calls
  // (e.g. Bq is used for Bq("label") timing markers in cli.js)
  // We detect these heuristically: a short-named function called many times
  // with a single string argument that looks like a label (snake_case, no spaces)
  const callCounts = Object.create(null); // funcName → count of calls with string arg
  const callSamples = Object.create(null); // funcName → sample string args

  for (const [filepath, lines] of idx.fileLines) {
    const funcBounds = idx._getFuncBoundaries(filepath);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const lineNum = lineIdx + 1;

      // Pattern 1: shortFunc("snake_case_label") — timing/trace markers
      const markerRe = /\b([a-zA-Z_$][\w$]{0,4})\(\s*["']([a-z][a-z0-9_]+)["']\s*\)/g;
      let m;
      while ((m = markerRe.exec(line)) !== null) {
        const funcName = m[1];
        const label = m[2];
        // Must look like a trace label: snake_case with at least two underscores
        // (filters out HTTP headers like "charset", "authorization", "boundary")
        if ((label.match(/_/g) || []).length < 2) continue;
        if (label.length < 8) continue;
        callCounts[funcName] = (callCounts[funcName] || 0) + 1;
        if (!callSamples[funcName]) callSamples[funcName] = [];
        if (callSamples[funcName].length < 5) callSamples[funcName].push(label);
      }

      // Pattern 2: n("prefix_event_name", ...) — telemetry events
      // (common pattern: short func name + string starting with a prefix)
      const eventRe = /\bn\(\s*["']([a-z][a-z0-9_]+)["']/g;
      while ((m = eventRe.exec(line)) !== null) {
        const evName = m[1];
        if (!evName.includes('_') || evName.length < 5) continue;
        const func = idx._findContainingFunctionFromBounds(funcBounds, lineNum);
        events.push({
          name: evName,
          filepath, line: lineNum,
          func: func || null,
        });
      }

      // Pattern 3: console.log("[TAG] ...") or console.warn("[TAG] ...")
      const logRe = /console\.(log|warn|error|info)\(\s*["']\[([A-Z][A-Z_ ]*)\]\s*([^"']{0,60})/g;
      while ((m = logRe.exec(line)) !== null) {
        const func = idx._findContainingFunctionFromBounds(funcBounds, lineNum);
        markers.push({
          label: `[${m[2]}] ${m[3]}`.trim(),
          type: 'log-' + m[1],
          filepath, line: lineNum,
          func: func || null,
        });
      }

      // Pattern 4: y("[TAG] ...") — debug/verbose logging wrapper
      const yLogRe = /\by\(\s*["']\[([A-Z][A-Z_ ]*)\]\s*([^"']{0,60})/g;
      while ((m = yLogRe.exec(line)) !== null) {
        const func = idx._findContainingFunctionFromBounds(funcBounds, lineNum);
        markers.push({
          label: `[${m[1]}] ${m[2]}`.trim(),
          type: 'debug',
          filepath, line: lineNum,
          func: func || null,
        });
      }

      // Pattern 5: General trace/debug prints with lifecycle words
      // printf("Entering %s...", ...), print("Starting init"), TRACE("init complete")
      // fprintf(stderr, "Loading configuration..."), etc.
      const lifecyclePrintRe = /(?:printf|fprintf|print|puts|TRACE|DPRINTF|LOG|DBG|debug|warn|eprint|eprogress)\s*\(\s*(?:stderr\s*,\s*)?["']([^"']{5,80})["']/g;
      while ((m = lifecyclePrintRe.exec(line)) !== null) {
        const msg = m[1].replace(/%[sdifcpx]/g, '').trim();
        // Must contain a lifecycle/phase word
        if (!/\b(init|start|end|enter|exit|begin|finish|done|complete|load|clos|open|connect|disconnect|shutdown|cleanup|setup|ready|running|stopping|creating|destroy|parsing|process|handl|dispatch|accept|listen|bind|registr|configur)\w*/i.test(msg)) continue;
        // Skip very generic messages
        if (msg.length < 8) continue;
        const func = idx._findContainingFunctionFromBounds(funcBounds, lineNum);
        markers.push({
          label: msg.slice(0, 60),
          type: 'print',
          filepath, line: lineNum,
          func: func || null,
        });
      }

      // Pattern 6: C/C++ DEBUG/TRACE macros: DPRINTF(("message")), TRACE_ENTER, etc.
      const macroRe = /\b(?:TRACE_?(?:ENTER|EXIT|MSG)?|DEBUG_?(?:PRINT|MSG)?|LOG_?(?:DEBUG|INFO|WARN|ERROR)?|D?PRINTF)\s*\(\s*\(?["']([^"']{5,80})["']/g;
      while ((m = macroRe.exec(line)) !== null) {
        const msg = m[1].replace(/%[sdifcpx]/g, '').trim();
        if (msg.length < 5) continue;
        const func = idx._findContainingFunctionFromBounds(funcBounds, lineNum);
        markers.push({
          label: msg.slice(0, 60),
          type: 'macro',
          filepath, line: lineNum,
          func: func || null,
        });
      }
    }
  }

  // Identify the trace/timing function: the short-named function called most often
  // with snake_case string labels. Must have 10+ calls to qualify.
  // Select trace functions: must have 5+ calls where labels contain lifecycle
  // words like _start, _end, _after, _before, _initialized, _loaded, _complete
  const lifecycleRe = /_(start|end|before|after|initialized|loaded|complete|begin|finish|done|init|created|resolved|configured|determined|error)/;
  const traceFuncs = Object.entries(callCounts)
    .filter(([name, count]) => {
      if (count < 5) return false;
      const samples = callSamples[name] || [];
      const lifecycleLabels = samples.filter(s => lifecycleRe.test(s));
      return lifecycleLabels.length >= 2; // at least 2 samples look like lifecycle markers
    })
    .sort((a, b) => b[1] - a[1]);

  if (traceFuncs.length > 0 && showProgress) {
    console.log(`Detected trace functions: ${traceFuncs.slice(0, 3).map(([name, count]) => name + '(' + count + ')').join(', ')}`);
  }

  // Now extract markers from the top trace function(s)
  const traceNames = new Set(traceFuncs.slice(0, 3).map(([name]) => name));
  if (traceNames.size > 0) {
    for (const [filepath, lines] of idx.fileLines) {
      const funcBounds = idx._getFuncBoundaries(filepath);
      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const lineNum = lineIdx + 1;
        const re = /\b([a-zA-Z_$][\w$]{0,4})\(\s*["']([a-z][a-z0-9_]+)["']\s*\)/g;
        let m;
        while ((m = re.exec(line)) !== null) {
          if (!traceNames.has(m[1])) continue;
          const func = idx._findContainingFunctionFromBounds(funcBounds, lineNum);
          markers.push({
            label: m[2],
            type: 'trace',
            traceFn: m[1],
            filepath, line: lineNum,
            func: func || null,
          });
        }
      }
    }
  }

  // Sort markers by line number (execution order)
  markers.sort((a, b) => a.line - b.line);

  // Deduplicate and categorize events by prefix
  const eventCategories = Object.create(null);
  for (const ev of events) {
    const prefix = ev.name.split('_').slice(0, 1)[0];
    if (!eventCategories[prefix]) eventCategories[prefix] = [];
    if (!eventCategories[prefix].some(e => e.name === ev.name && e.line === ev.line)) {
      eventCategories[prefix].push(ev);
    }
  }

  if (showProgress) {
    console.log(`Breadcrumbs: ${markers.length} trace markers, ${events.length} telemetry events`);
  }

  return { markers, events, eventCategories, traceFunctions: traceFuncs.slice(0, 5) };
}


/**
 * Extract a command catalog from the indexed codebase.
 * Detects multiple patterns:
 *   - Argparse/option arrays: ['name', 'type', ['--flag', '-alias']]
 *   - Switch/if dispatch: case 'command': / if (x.startsWith('/command'))
 *   - HTML data-* attributes: data-action="name", data-section="name"
 *   - Route tables: routes['/api/path'] or app.get('/path', handler)
 *   - Event registrations: addEventListener('event', handler)
 *
 * Returns { commands: [...], routes: [...], guiActions: [...], events: [...] }
 */
// digest-perf-command-catalog (#90): the catalog is immutable for a loaded
// index, but every class/file digest cross-references it — without this memo
// each digest re-paid the full whole-index scan (~70s on text-heavy
// .plugins_from_gh). WeakMap so a replaced index releases its entry.
const _catalogCache = new WeakMap();

// Lines longer than this are skipped by the per-line pattern battery and the
// handler-resolution scans. Command/route/flag definition lines are short; a
// multi-KB markdown or minified line is never one, and the backtracking-prone
// patterns blow up on them (same guard practice as the AI/ML detectors).
const MAX_SCAN_LINE = 500;

// GUI actions: the attributes and tags read, what counts as a name, and the files
// that define controls (markup) as against scripts that only mention them.
const GUI_ATTR = /data-(action|section)=["']([^"']+)["']/g;
const GUI_NAME = /^[A-Za-z0-9][\w.:-]*$/;
const GUI_COMMENT_LINE = /^\s*(?:\/\/|\/?\*|#|<!--)/;
const GUI_MARKUP_FILE = /\.(?:html?|xhtml|vue|svelte|jsx|tsx|erb|ejs|hbs|jinja2?|tmpl|php|cshtml|razor)$/i;
const GUI_HTML_FILE = /\.(?:html?|xhtml)$/i;
const GUI_DOM_USE = /\b(?:getElementById|querySelector(?:All)?|addEventListener)\s*\(/;
const GUI_SCRIPT_FILE = /\.(?:[cm]?jsx?|tsx?)$/i;
const GUI_QUOTED = /(['"`])([A-Za-z0-9][\w.:-]*)\1/g;

const GUI_TAG = /<([A-Za-z][\w-]*)\b([^<>]*)>/g;
const GUI_CONTROL_TAG = /^(?:button|a|input|select|textarea|summary)$/;
const GUI_VOID_TAG = /^(?:input|img|br|hr)$/;
const GUI_DATA_ATTR = /\bdata-([a-z][\w-]*)=["']([^"']+)["']/g;
const GUI_LABEL_FOR = /<label\b[^>]*\bfor=["']([^"']+)["'][^>]*>([^<]+)/g;
const GUI_ID_REF = /#([A-Za-z][\w-]*)|getElementById\(\s*['"]([\w-]+)['"]/g;
const guiAttr = (attrs, k) => { const m = attrs.match(new RegExp('(?:^|\\s)' + k + '=(["\'])(.*?)\\1')); return m ? m[2].trim() : null; };
// Visible text of a markup fragment, without tags, entities, or the arrows and glyphs at its ends.
const guiText = (t) => t.replace(/<[^>]*>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ')
  .replace(/^[^\x21-\x7E\p{L}\p{N}]+|[^\x21-\x7E\p{L}\p{N}]+$/gu, '').trim();
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/** How many leading directories two paths share: a control's handler usually lives beside its page. */
function sharedDirs(a, b) {
  const x = a.split(/[\\/]/).slice(0, -1); const y = b.split(/[\\/]/).slice(0, -1);
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

export function extractCommandCatalog(idx, showProgress = true) {
  const cached = _catalogCache.get(idx);
  if (cached) return cached;
  const catalog = {
    cliOptions: [],    // --flag options from argparse-like definitions
    commands: [],      // /slash-commands from dispatch tables
    routes: [],        // API routes / URL handlers
    guiActions: [],    // GUI actions from data-* attributes
    events: [],        // Event handler registrations
  };

  const guiSeen = { dom: false };
  const guiLabelFor = Object.create(null);   // 'file|id' -> text of <label for="id">, for a control with no text of its own
  for (const [filepath, lines] of idx.fileLines) {
    const funcBounds = idx._getFuncBoundaries(filepath);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (!line || line.length > MAX_SCAN_LINE) continue;
      const lineNum = lineIdx + 1;
      const func = idx._findContainingFunctionFromBounds(funcBounds, lineNum);

      // --- Pattern 1a: JS argparse option definitions ---
      // ['option_name', 'type', ['--flag', '--alias']]
      // ['option_name', 'type', ['--flag'], ['--deprecated-flag']]: the fourth
      // element lists forms that still resolve, with a warning; the third may
      // then be empty.
      const argMatch = line.match(/\[\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*\[([^\]]*)\]\s*(?:,\s*\[([^\]]*)\]\s*)?\]/);
      if (argMatch) {
        const quotedIn = (t) => (t || '').match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [];
        const deprecated = quotedIn(argMatch[4]);
        const aliases = [...quotedIn(argMatch[3]), ...deprecated];
        if (aliases.some(a => a.startsWith('--') || a.startsWith('-'))) {
          catalog.cliOptions.push({
            name: argMatch[1],
            type: argMatch[2],
            flags: aliases,
            ...(deprecated.length ? { deprecatedFlags: deprecated } : {}),
            filepath, line: lineNum, func,
          });
        }
      }

      // --- Pattern 1b: Python argparse.add_argument ---
      // parser.add_argument(\n    '--flag', '-alias', ...
      if (line.includes('add_argument(')) {
        // Look at this line and next few for the flag names
        const snippet = lines.slice(lineIdx, Math.min(lineIdx + 6, lines.length)).join(' ');
        const flags = [];
        const flagRe = /['"](-{1,2}[\w-]+)['"]/g;
        let fm;
        while ((fm = flagRe.exec(snippet)) !== null) {
          if (fm[1].startsWith('-')) flags.push(fm[1]);
        }
        if (flags.length > 0) {
          // Extract help text if present
          const helpMatch = snippet.match(/help\s*=\s*['"]([^'"]{1,80})/);
          // Derive option name from the longest flag
          const mainFlag = flags.sort((a, b) => b.length - a.length)[0];
          const optName = mainFlag.replace(/^-+/, '').replace(/-/g, '_');
          catalog.cliOptions.push({
            name: optName,
            type: snippet.includes("action='store_true'") || snippet.includes('action="store_true"') ? 'flag' : 'value',
            flags,
            help: helpMatch ? helpMatch[1] : null,
            filepath, line: lineNum, func,
          });
        }
      }

      // --- Pattern 2: Slash-command dispatch ---
      // JS: query.startsWith('/command') or cmd === '/command'
      // Python: query.startswith('/command') or query == '/command'
      const cmdMatch = line.match(/(?:startsWith|startswith|={2,3})\s*\(?['"]\/(\w[\w-]*)/);
      if (cmdMatch) {
        const cmdName = '/' + cmdMatch[1];
        // Avoid duplicates from multiple patterns on same line
        if (!catalog.commands.some(c => c.name === cmdName && c.line === lineNum)) {
          catalog.commands.push({
            name: cmdName,
            filepath, line: lineNum, func,
          });
        }
      }

      // --- Pattern 3: Express/HTTP routes ---
      // routes['/api/path'] or app.get('/path' or app.post('/path'
      const routeMatch = line.match(/(?:routes\[|app\.(?:get|post|put|delete|use)\s*\(\s*)['"]([^'"]+)['"]/);
      if (routeMatch) {
        catalog.routes.push({
          path: routeMatch[1],
          filepath, line: lineNum, func,
        });
      }

      // --- Pattern 4: HTML data-action / data-section attributes ---
      // Every occurrence on the line, in markup or in a script's selector string. A value
      // that is not a plain attribute value (a regex source, a template placeholder) is
      // not a name, and an occurrence on a comment line defines nothing.
      if (line.includes('data-') && !GUI_COMMENT_LINE.test(line)) {
        const markup = GUI_MARKUP_FILE.test(filepath);
        let gm;
        GUI_ATTR.lastIndex = 0;
        while ((gm = GUI_ATTR.exec(line))) {
          if (!GUI_NAME.test(gm[2])) continue;
          catalog.guiActions.push({ name: gm[2], type: gm[1], markup, filepath, line: lineNum, func });
        }
      }
      // --- Pattern 4b: the page's controls, by what a user sees ---
      // In markup: a button, input, select, textarea, link or summary that carries an id or
      // a data-* name is a control, labeled by its visible text (else aria-label, title,
      // placeholder). Any other element with an id is kept only if a script later proves
      // to attach a listener to it. Opening tags that span lines are not read.
      if (GUI_MARKUP_FILE.test(filepath) && line.includes('<')) {
        let tm;
        GUI_TAG.lastIndex = 0;
        while ((tm = GUI_TAG.exec(line))) {
          const tag = tm[1].toLowerCase();
          const attrs = tm[2] || '';
          const interactive = GUI_CONTROL_TAG.test(tag);
          const id = guiAttr(attrs, 'id');
          const inputType = (guiAttr(attrs, 'type') || '').toLowerCase();
          if (tag === 'input' && inputType === 'hidden') continue;
          const datas = [];
          let dm;
          GUI_DATA_ATTR.lastIndex = 0;
          while ((dm = GUI_DATA_ATTR.exec(attrs))) if (GUI_NAME.test(dm[2])) datas.push([dm[1], dm[2]]);
          if (!id && !datas.length) continue;
          if (!interactive && !id && !datas.some(([k]) => k === 'action' || k === 'section')) continue;
          // Visible text: up to the element's closing tag, or, for a void element, to the next tag.
          const rest = line.slice(tm.index + tm[0].length);
          const close = rest.toLowerCase().indexOf('</' + tag);
          const inner = guiText(GUI_VOID_TAG.test(tag) ? rest.split('<')[0] : (close >= 0 ? rest.slice(0, close) : rest));
          let label = [inner, guiAttr(attrs, 'aria-label'), guiAttr(attrs, 'title'), guiAttr(attrs, 'placeholder'),
            /^(?:button|submit|reset)$/.test(inputType) ? guiAttr(attrs, 'value') : null]
            .find((t) => t && /[A-Za-z0-9]{2}/.test(t)) || null;
          if (!label && !interactive && close < 0) {
            const under = guiText(lines[lineIdx + 1] || '');
            if (/[A-Za-z0-9]{2}/.test(under)) label = under;
          }
          if (label && label.length > 70) label = label.slice(0, 67) + '...';
          const named = datas.filter(([k]) => k === 'action' || k === 'section');
          if (named.length) {
            // Already a row from Pattern 4: give it the label.
            for (const [k, v] of named) {
              const row = catalog.guiActions.findLast((a) => a.filepath === filepath && a.line === lineNum && a.name === v && a.type === k);
              if (row && label && !row.label) row.label = label;
            }
          } else if (interactive && datas.length) {
            const [k, v] = datas[0];
            catalog.guiActions.push({ name: v, type: k, label, markup: true, filepath, line: lineNum, func });
          } else if (id && GUI_NAME.test(id)) {
            const kind = !interactive ? 'element'
              : tag === 'input' ? (inputType === 'checkbox' || inputType === 'radio' ? inputType : /^(?:button|submit|reset)$/.test(inputType) ? 'button' : 'input')
              : tag === 'textarea' ? 'input' : tag === 'a' ? 'link' : tag;
            catalog.guiActions.push({ name: id, type: kind, label, byId: true, needsListener: !interactive, markup: true, filepath, line: lineNum, func });
          }
        }
        if (line.includes('<label')) {
          let lm;
          GUI_LABEL_FOR.lastIndex = 0;
          while ((lm = GUI_LABEL_FOR.exec(line))) guiLabelFor[filepath + '|' + lm[1]] = guiText(lm[2]);
        }
      }
      // Does a script here drive a page? Decides whether a missing-HTML note is worth printing.
      if (!guiSeen.dom && GUI_SCRIPT_FILE.test(filepath) && GUI_DOM_USE.test(line)) guiSeen.dom = true;

      // --- Pattern 5: Declarative command registries ---
      // Objects with name + description fields: { name: "compact", description: "...", type: "local" }
      // Detect the 'name:' line and look ahead for description
      if (/^\s*name:\s*["']([^"']+)["']/.test(line)) {
        const nameMatch = line.match(/name:\s*["']([^"']+)["']/);
        if (nameMatch) {
          const cmdName = nameMatch[1];
          // Look ahead for description and type in next 5 lines
          const snippet = lines.slice(lineIdx, Math.min(lineIdx + 8, lines.length)).join('\n');
          const descMatch = snippet.match(/description:\s*["']([^"']{10,})/);
          const typeMatch = snippet.match(/type:\s*["']([^"']+)["']/);
          // Activation gate: capture isEnabled if present and classify it.
          // Lets the catalog distinguish always-on / hard-disabled /
          // flag-gated / env-gated / complex commands — useful both for
          // navigation ("what does this depend on?") and for the
          // forthcoming --latent-code catalog (#358). The value may
          // include commas INSIDE parens (e.g. `jA("flag", false)`),
          // so the capture allows one paren-level of internal commas
          // before stopping at the property-separator comma or newline.
          const isEnabledMatch = snippet.match(/isEnabled\s*:\s*((?:[^,(\n]|\([^)]*\))+)/);
          const gate = _classifyCommandGate(isEnabledMatch ? isEnabledMatch[1].trim() : null);
          // Only include if there's a description (distinguishes command objects from data)
          if (descMatch) {
            catalog.commands.push({
              name: cmdName,
              type: typeMatch ? typeMatch[1] : 'command',
              description: descMatch[1].slice(0, 120),
              gate,
              filepath, line: lineNum, func,
            });
          }
        }
      }

      // --- Pattern 6: Win32 RC resource menu items ---
      // MENUITEM "&Save\tCtrl+S", IDM_FILE_SAVE
      const menuItemMatch = line.match(/MENUITEM\s+"(&?[^"]+)"\s*,\s*(\w+)/);
      if (menuItemMatch) {
        const menuText = menuItemMatch[1].replace(/&/g, '').replace(/\\t.*/, '').trim();
        const cmdId = menuItemMatch[2];
        if (menuText && menuText !== 'SEPARATOR') {
          catalog.commands.push({
            name: cmdId,
            description: menuText,
            type: 'menu',
            filepath, line: lineNum, func,
          });
        }
      }

      // --- Pattern 7: Win32 #define IDM_/IDC_ command constants ---
      // Stored for cross-referencing with MENUITEM and case dispatch (not added to catalog directly)
      const idmMatch = line.match(/#define\s+(IDM_\w+)\s+/);
      if (idmMatch) {
        if (!catalog._idmDefines) catalog._idmDefines = {};
        catalog._idmDefines[idmMatch[1]] = { filepath, line: lineNum };
      }

      // --- Pattern 8: Win32 POPUP menu group ---
      // POPUP "&File"
      const popupMatch = line.match(/^\s*POPUP\s+"(&?[^"]+)"/);
      if (popupMatch) {
        const menuName = popupMatch[1].replace(/&/g, '').trim();
        catalog.guiActions.push({
          name: menuName,
          type: 'menu-group',
          filepath, line: lineNum, func,
        });
      }

      // --- Pattern 9: Switch case statements ---
      // Only include values that look like commands or action names,
      // not file extensions, MIME types, language names, or data values
      const caseMatch = line.match(/case\s+['"]([^'"]+)['"]\s*:/);
      if (caseMatch) {
        const val = caseMatch[1];
        const isCommand = val.length >= 3 && val.length <= 40 && !/^\d+$/.test(val)
            && !val.startsWith('.')          // file extensions (.js, .py)
            && !val.includes('/')            // paths or MIME types
            && !/^(text|image|audio|video|application|font)\b/.test(val) // MIME types
            && !/^(error|warning|info|debug|trace)_/.test(val) // log/error levels
            && !/^(max|min|default|timeout|retry|limit)_/i.test(val) // config keys
            && !/^(utf|iso|euc|ascii|latin|shift|windows|gb|big|koi)/i.test(val) // encodings
            && !/_(enabled|disabled|count|size|mode|type|level|status|result)$/i.test(val) // config suffixes
            && (val.includes('-') || /^[a-z]+[A-Z]/.test(val) // command-like: hyphens or camelCase
                || /^(GET|POST|PUT|DELETE|PATCH)\b/.test(val)); // HTTP methods
        if (isCommand) {
          catalog.commands.push({
            name: val,
            type: 'case',
            filepath, line: lineNum, func,
          });
        }
      }
    }
  }

  // Deduplicate commands by name (keep first occurrence)
  const seenCmds = new Set();
  catalog.commands = catalog.commands.filter(c => {
    const key = c.name + '|' + (c.type || '');
    if (seenCmds.has(key)) return false;
    seenCmds.add(key);
    return true;
  });

  // Resolve CLI option handlers: find where args.option_name is tested and what
  // that test runs.
  // JS: if (args.hotspots) / args._explicit.has('hotspots')
  // Python: if args.hotspots: / elif args.hotspots:
  //
  // One pass over the index gathers every line that tests an option (#90: a
  // scan per option was quadratic); the choice among them is made afterwards,
  // so the join does not depend on the order files were indexed in. An option
  // used to take the first such line anywhere, which gave `--overview` three
  // different handlers on three builds of one tree.
  //
  // The choice, in order: a line whose condition opens with a positive test of
  // the option (`if (args.x`, `args._explicit.has('x')`, `case 'x':`) over any
  // other mention; the file that opens the most conditions that way (the
  // program's dispatch file) over a file that tests the option in passing;
  // then path and line. A line that only negates the option, or tests it
  // behind another condition, marks a modifier: where it is tested is kept,
  // and no handler is claimed for it.
  const optsByName = new Map();
  for (const opt of catalog.cliOptions) {
    if (!optsByName.has(opt.name)) optsByName.set(opt.name, []);
    optsByName.get(opt.name).push(opt);
  }
  const knownFuncs = new Set();
  for (const funcs of Object.values(idx.functionIndex || {})) {
    for (const full of Object.keys(funcs || {})) {
      const bare = full.replace(/@\d+$/, '');
      knownFuncs.add(bare);
      knownFuncs.add(bare.split(/[.:#]+/).pop());
    }
  }
  const reArgsDot = /(!\s*)?\bargs\.(\w+)/g;
  const reExplicit = /(!\s*)?(?:\bargs\.)?_explicit\.has\(\s*['"](\w+)['"]/g;
  const reQuoted = /['"](\w+)['"]/g;
  // The options a condition opens with: `if (args.a || args.b)` opens with
  // both, and `if (!args.hof && (args.a || args.b))` still does, since a
  // negated test in front only keeps another command out. `if (model &&
  // args.a)` opens with none.
  const reNeg = /^(?:!\s*|not\s+)args\.[\w.]+(?:\([^)]*\))?\s*(?:&&|and\b)/;
  const rePos = /^(?:typeof\s+)?(?:args\._explicit\.has\(\s*['"](\w+)['"]\s*\)|_explicit\.has\(\s*['"](\w+)['"]\s*\)|args\[\s*['"](\w+)['"]\s*\]|args\.(\w+)(?:\.length)?(?![\w.(]))/;
  const reOr = /^\s*(?:(?:[!=]==?|[<>]=?)\s*(?:'[^']*'|"[^"]*"|[\w.]+))?\s*\)*\s*(?:\|\||or\b)/;
  const leadNames = (trimmed) => {
    const out = [];
    const head = trimmed.match(/^(?:\}\s*)?(?:if|elif|else\s+if)\b/);
    if (!head) return out;
    let t = trimmed.slice(head[0].length);
    for (let guard = 0; guard < 40; guard++) {
      t = t.replace(/^[\s(]+/, '');
      const neg = t.match(reNeg);
      if (neg) { t = t.slice(neg[0].length); continue; }
      const pos = t.match(rePos);
      if (!pos) break;
      out.push(pos[1] || pos[2] || pos[3] || pos[4]);
      t = t.slice(pos[0].length);
      const or = t.match(reOr);
      if (!or) {
        // `if (args.a && args.b)`: a tested together with something else.
        if (/^\s*(?:(?:[!=]==?|[<>]=?)\s*(?:'[^']*'|"[^"]*"|[\w.]+))?\s*\)*\s*(?:&&|and\b)/.test(t)) out.joint = true;
        break;
      }
      t = t.slice(or[0].length);
    }
    return out;
  };
  // A dispatch table row: ['list_models', 'models', doListModels],
  const reTableRow = /^\[\s*['"](\w+)['"]\s*,.*,\s*([A-Za-z_$][\w$]*)\s*\]\s*,?$/;
  const reCase = /^case\s+['"](\w+)['"]\s*:/;
  const candsByName = new Map();   // option name -> [{ fp, li, tier }]
  const leadsByFile = new Map();   // file -> Set of option names it opens a condition with
  if (optsByName.size) {
    for (const [fp, flines] of idx.fileLines) {
      for (let li = 0; li < flines.length; li++) {
        const fline = flines[li];
        if (!fline || fline.length > MAX_SCAN_LINE) continue;
        // It has to look like a dispatch (if/elif/case), not just a reference
        const trimmed = fline.trim();
        const isDispatch = /^(?:\}\s*)?(if|elif|else if|case)\b/.test(trimmed) ||
                           trimmed.includes('_explicit.has');
        if (!isDispatch) {
          const row = trimmed.match(reTableRow);
          if (row && optsByName.has(row[1]) && (/^do[_A-Z]/.test(row[2]) || knownFuncs.has(row[2]))) {
            if (!candsByName.has(row[1])) candsByName.set(row[1], []);
            candsByName.get(row[1]).push({ fp, li, tier: 0, direct: row[2] });
            if (!leadsByFile.has(fp)) leadsByFile.set(fp, new Set());
            leadsByFile.get(fp).add(row[1]);
          }
          continue;
        }
        // tier 0: opens the condition, positive. 1: positive, behind another
        // condition. 2: negated. 3: the bare word in quotes (Python dict forms,
        // and, as noise, any `if (tab === 'x')`).
        const tiers = new Map();
        const note = (name, tier) => { if (optsByName.has(name) && (!tiers.has(name) || tier < tiers.get(name))) tiers.set(name, tier); };
        let mm;
        reQuoted.lastIndex = 0;
        while ((mm = reQuoted.exec(fline))) note(mm[1], 3);
        reExplicit.lastIndex = 0;
        while ((mm = reExplicit.exec(fline))) { if (optsByName.has(mm[2])) tiers.set(mm[2], mm[1] ? 2 : 1); }
        reArgsDot.lastIndex = 0;
        while ((mm = reArgsDot.exec(fline))) note(mm[2], mm[1] ? 2 : 1);
        const cm = trimmed.match(reCase);
        const leads = cm ? [cm[1]] : leadNames(trimmed);
        for (const leadName of leads) {
          if (optsByName.has(leadName)) tiers.set(leadName, 0);
        }
        for (const [name, tier] of tiers) {
          if (!candsByName.has(name)) candsByName.set(name, []);
          candsByName.get(name).push({ fp, li, tier, joint: tier === 0 && !!leads.joint });
          if (tier === 0) { if (!leadsByFile.has(fp)) leadsByFile.set(fp, new Set()); leadsByFile.get(fp).add(name); }
        }
      }
    }
  }
  const leadCount = (fp) => (leadsByFile.get(fp) || { size: 0 }).size;
  let maxLeads = 0;
  for (const set of leadsByFile.values()) if (set.size > maxLeads) maxLeads = set.size;
  // Never a handler: keywords, `await import(`, and stdlib or builtin calls.
  // Kept small and high-confidence; better to miss a handler than to tag the
  // wrong function.
  const CALL_NOISE = /^(?:if|for|while|switch|return|function|typeof|catch|await|import|require|write|log|warn|error|info|debug|then|stringify|parse|split|join|map|filter|forEach|readFile|readFileSync|writeFile|writeFileSync|exists|existsSync|stat|statSync|mkdir|rmdir|readdir|exit|has|get|set|push|includes|test|String|Number|Boolean|Array|Object|parseInt|parseFloat)$/;
  // With a function index, a handler is a function the index defines.
  const isHandlerName = (n) => !CALL_NOISE.test(n) && (knownFuncs.size === 0 || knownFuncs.has(n));
  const indentOf = (s) => s.length - s.trimStart().length;
  // What follows the condition on the guard line: `if (c) foo();` -> ` foo();`
  const afterCondition = (line) => {
    const t = line.trim();
    const cm = t.match(reCase);
    if (cm) return t.slice(cm[0].length);
    const open = t.indexOf('(');
    if (!/^(?:\}\s*)?(?:if|else\s+if)\b/.test(t) || open < 0 || /^(?:if|elif)\s+[^(]/.test(t)) {
      const colon = t.lastIndexOf(':');            // Python: `if args.x: do_x()`
      return /^(?:if|elif)\b/.test(t) && colon >= 0 ? t.slice(colon + 1) : '';
    }
    let depth = 0;
    for (let i = open; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')' && --depth === 0) return t.slice(i + 1);
    }
    return '';
  };
  // Priority 1: a do-prefixed call (`doFoo(` / `do_foo(`), the strongest
  // convention. Priority 2: on a one-line dispatch, the first call that can be
  // a handler; in a block, the first awaited one (`await x.buildIndex(`).
  // Mode 'do' stops after priority 1.
  const firstCall = (text, mode) => {
    const doMatch = text.match(/\b(do[_A-Z]\w+)\s*\(/);
    if (doMatch) return doMatch[1];
    if (mode === 'do') return null;
    const re = mode === 'await' ? /\bawait\s+(?:[\w$]+\.)*([\w$]+)\s*\(/g : /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(text))) if (isHandlerName(m[1])) return m[1];
    return null;
  };
  const handlerNameAt = (flines, li, tier, inDispatchFile, name) => {
    if (tier === 2) return null;                   // only negated: a modifier
    const rest = afterCondition(flines[li]).replace(/^\s*\{/, '').trim();
    // A one-line dispatch is its own whole window: `if (args.x) foo(bar());`
    if (rest) return firstCall(rest, 'line');
    if (tier === 1) return null;                   // behind another condition, in that condition's block
    // The option's own block: the lines indented under the guard, 20 at most
    // (--build-index calls its handler ten lines down). The window used to be
    // a flat 20 lines and ran into the next option's dispatch.
    const guardIndent = indentOf(flines[li]);
    const body = [];
    for (let j = li + 1; j < Math.min(li + 20, flines.length); j++) {
      const l = flines[j];
      if (l == null || l.length > MAX_SCAN_LINE) continue;
      if (l.trim() && indentOf(l) <= guardIndent) break;
      // Another option's guard nested in this block is that option's
      // dispatch, not this one's: `if (args.emit_catalog) doEmitCatalog(..)`
      // inside the --exports block. Its line, and its block, are passed over.
      const nested = leadNames(l.trim());
      if (nested.length && !nested.includes(name) && nested.some((n) => optsByName.has(n))) {
        const nestIndent = indentOf(l);
        while (j + 1 < Math.min(li + 20, flines.length) && (!flines[j + 1] || !flines[j + 1].trim() || indentOf(flines[j + 1]) > nestIndent)) j++;
        continue;
      }
      body.push(l);
    }
    // The awaited-call fallback is trusted only in the dispatch file. In a
    // command's own file an option tested at the top of a block is a mode of
    // that command, and the first awaited call there is whatever the command
    // does next (`--loop-redraft` took the model-call closure `draft`).
    return firstCall(body.join(' '), inDispatchFile ? 'await' : 'do');
  };
  for (const [name, optList] of optsByName) {
    const all = candsByName.get(name);
    if (!all) continue;
    for (const opt of optList) {
      // Skip the argparse definition lines themselves
      const cands = all.filter((c) => !(c.fp === opt.filepath && Math.abs(c.li + 1 - opt.line) < 5));
      if (!cands.length) continue;
      cands.sort((a, b) => (a.tier === 0 ? 0 : 1) - (b.tier === 0 ? 0 : 1)
        || leadCount(b.fp) - leadCount(a.fp)
        || a.tier - b.tier
        || (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0)
        || (a.joint ? 1 : 0) - (b.joint ? 1 : 0)   // the option tested alone before the option tested with another
        || a.li - b.li);
      // In the chosen file, the first opening test that runs something: an
      // early `if (args.index_path || args.build_index) return false;` is not
      // where --build-index is dispatched.
      let c = cands[0];
      let handlerFunc = null;
      for (const k of cands) {
        if (k.fp !== c.fp || k.tier !== c.tier) break;
        const h = k.direct || handlerNameAt(idx.fileLines.get(k.fp), k.li, k.tier, leadCount(k.fp) === maxLeads, name);
        if (h) { c = k; handlerFunc = h; break; }
        if (c.tier !== 0) break;
      }
      opt.handler = {
        filepath: c.fp, line: c.li + 1,
        func: idx._findContainingFunctionFromBounds(idx._getFuncBoundaries(c.fp), c.li + 1),
        handlerFunc,
      };
    }
  }

  // Resolve slash-command handlers (Pattern 2). Same heuristic as the CLI
  // option handler resolution above: the registration line is an `if
  // (query.startsWith('/foo'))` guard, and the real handler is called in
  // the next ~20 lines. Without this, every `/command` mapped to its
  // CONTAINING function (typically a giant dispatchCommand-style switch),
  // so all clicks landed on the same line.
  for (const cmd of catalog.commands) {
    // Only slash-commands have this dispatch shape; other catalog entry
    // types (declarative descriptors, switch cases, MENUITEMs) handle
    // themselves elsewhere.
    if (!cmd.name || !cmd.name.startsWith('/')) continue;
    if (cmd.handler) continue;  // already resolved
    const flines = idx.fileLines.get(cmd.filepath);
    if (!flines || cmd.line < 1) continue;
    const startIdx = cmd.line - 1;  // 0-indexed
    const snippet = flines.slice(startIdx, Math.min(startIdx + 20, flines.length)).join(' ');
    // Same priority order as CLI option detection:
    //   1. doFoo() / await doFoo() — the strong convention signal
    //   2. await <ident>( or await <obj>.<method>( — generic awaited dispatch
    let handlerName = null;
    const doMatch = snippet.match(/\b(do[_A-Z]\w+)\s*\(|await\s+(do[_A-Z]\w+)\s*\(/);
    if (doMatch) {
      handlerName = doMatch[1] || doMatch[2];
    } else {
      const awaitMatch = snippet.match(/await\s+(?:\w+\.)?(\w+)\s*\(/);
      if (awaitMatch) {
        const candidate = awaitMatch[1];
        const NOISE = /^(?:write|log|warn|error|info|debug|then|catch|stringify|parse|split|join|map|filter|forEach|readFile|readFileSync|writeFile|writeFileSync|exists|existsSync|stat|statSync|mkdir|rmdir|readdir)$/;
        if (!NOISE.test(candidate)) handlerName = candidate;
      }
    }
    if (handlerName) {
      cmd.handler = {
        filepath: cmd.filepath,
        line: cmd.line,
        func: cmd.func,
        handlerFunc: handlerName,
      };
    }
  }

  // One row per GUI action name and kind, chosen the same way whatever the file order:
  // the markup that defines the control over a script that mentions it, then path, then line.
  {
    const best = Object.create(null);
    for (const a of catalog.guiActions) {
      if (a.type === 'menu-group') { best[a.name + '|' + a.type + '|' + a.filepath + '|' + a.line] = a; continue; }
      const key = a.name + '|' + a.type;
      const b = best[key];
      if (!b || (a.markup !== b.markup ? a.markup : (a.filepath !== b.filepath ? a.filepath < b.filepath : a.line < b.line))) best[key] = a;
    }
    catalog.guiActions = Object.values(best);
  }

  // Resolve GUI action handlers. One pass gathers every script line that either dispatches
  // on the name (case 'x':, === 'x', a quoted map key 'x':) or selects the control
  // ([data-action="x"]). A line that merely contains the word is not a candidate. A file
  // qualifies if it reads the attribute (dataset.action, data-action) or sits beside the
  // defining file; server-side code that compares against the same word does not. Among the
  // qualifying lines: dispatch over selection, the nearer file, the file that dispatches
  // the most names, then path and line.
  {
    // A control found by id is joined through the script lines that fetch it by that id
    // ('#id', getElementById('id')): a listener attached there, directly or to the variable
    // it is assigned to, handles it; any other mention only uses it.
    const byName = Object.create(null);
    const byId = Object.create(null);
    for (const a of catalog.guiActions) {
      if (a.type === 'menu-group') continue;
      if (a.byId && !a.label && guiLabelFor[a.filepath + '|' + a.name]) a.label = guiLabelFor[a.filepath + '|' + a.name];
      ((a.byId ? byId : byName)[a.name] ||= []).push(a);
    }
    const wanted = Object.keys(byName).length + Object.keys(byId).length > 0;
    const attrLines = Object.create(null);   // attribute kind -> script lines that read it
    // A data-* value that is the id of another element (data-copy="left-body") points at
    // what the control acts on; it is not a name a script dispatches on.
    const isTarget = (a) => !a.byId && a.type !== 'action' && a.type !== 'section' && !!byId[a.name];
    const LISTENS =/\??\.addEventListener\s*\(|\.on[a-z]+\s*=(?!=)/;
    const cands = new Map();             // action -> [{fp, li, tier}]
    const reads = Object.create(null);   // fp -> Set of attribute kinds the file reads
    const leads = Object.create(null);   // fp -> number of dispatch lines
    if (wanted) {
      for (const [fp, flines] of idx.fileLines) {
        if (GUI_HTML_FILE.test(fp)) continue;
        for (let li = 0; li < flines.length; li++) {
          const fline = flines[li];
          if (!fline || fline.length > MAX_SCAN_LINE) continue;
          if (fline.includes('data')) {
            for (const rd of fline.matchAll(/dataset\.([A-Za-z]\w*)|data-([a-z][\w-]*)/g)) {
              const k = rd[1] ? kebab(rd[1]) : rd[2];
              (reads[fp] ||= new Set()).add(k);
              // A generic read (dataset.copy, [data-copy], getAttribute('data-copy')), not a
              // selector for one particular value.
              const next = fline[rd.index + rd[0].length];
              if (!GUI_COMMENT_LINE.test(fline) && (rd[1] || next === ']' || next === "'" || next === '"')) (attrLines[k] ||= []).push({ fp, li });
            }
          }
          if (GUI_COMMENT_LINE.test(fline)) continue;
          if (fline.indexOf("'") < 0 && fline.indexOf('"') < 0 && fline.indexOf('`') < 0) continue;
          let qm;
          if (fline.includes('#') || fline.includes('getElementById')) {
            GUI_ID_REF.lastIndex = 0;
            while ((qm = GUI_ID_REF.exec(fline))) {
              const acts = byId[qm[1] || qm[2]];
              if (!acts) continue;
              const after = fline.slice(qm.index + qm[0].length);
              let at = li; let tier = 1;
              if (LISTENS.test(after)) tier = 0;
              else {
                const v = fline.match(/^\s*(?:const|let|var)\s+([\w$]+)\s*=/);
                if (v) {
                  const use = new RegExp('(?<![\\w$.])' + v[1].replace(/\$/g, '\\$') + '(?:\\??\\.addEventListener\\s*\\(|\\.on[a-z]+\\s*=(?!=))');
                  for (let j = li + 1; j < Math.min(li + 6, flines.length); j++) {
                    if (flines[j] && flines[j].length <= MAX_SCAN_LINE && use.test(flines[j])) { at = j; tier = 0; break; }
                  }
                }
              }
              for (const a of acts) {
                if (!cands.has(a)) cands.set(a, []);
                cands.get(a).push({ fp, li: at, tier, byId: true });
              }
            }
          }
          GUI_QUOTED.lastIndex = 0;
          while ((qm = GUI_QUOTED.exec(fline))) {
            const acts = byName[qm[2]];
            if (!acts) continue;
            const before = fline.slice(0, qm.index);
            const after = fline.slice(qm.index + qm[0].length);
            const sel = before.match(/data-([a-z][\w-]*)=$/);
            let tier = -1;
            if (sel) tier = 1;
            else if (/\bcase\s*$/.test(before) && /^\s*:/.test(after)) tier = 0;
            else if (/[=!]==?\s*$/.test(before) || /^\s*[=!]==?/.test(after)) tier = 0;
            else if (/^\s*:(?!:)/.test(after) && /(?:^|[{,])\s*$/.test(before)) tier = 0;
            if (tier < 0) continue;
            for (const a of acts) {
              if (sel && sel[1] !== a.type) continue;
              if (isTarget(a)) continue;
              if (fp === a.filepath && li + 1 === a.line && tier === 1) continue;
              if (!cands.has(a)) cands.set(a, []);
              cands.get(a).push({ fp, li, tier });
            }
            if (tier === 0) leads[fp] = (leads[fp] || 0) + 1;
          }
        }
      }
    }
    // The call a dispatch line leads to: on the line, or in the case body under it. Only a
    // call made at statement level counts, not one passed as an argument to another call
    // (`api.list({ n: getMaxResults() })` names nothing), and not a one- or two-letter helper.
    const callIn = (flines, li) => {
      const re = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
      let depth = 0;
      for (let j = li; j < Math.min(li + 20, flines.length); j++) {
        let text = flines[j] || '';
        if (text.length > MAX_SCAN_LINE) continue;
        if (j > li && (/^\s*(?:case\b|default\s*:)/.test(text) || (text.trim() && text.search(/\S/) < flines[li].search(/\S/)))) break;
        if (j === li) text = text.replace(/^.*\bcase\b[^:]*:/, '');
        text = text.replace(/\s\/\/.*$/, '');   // a trailing comment calls nothing
        const depthAt = new Array(text.length + 1);
        for (let k = 0; k < text.length; k++) {
          depthAt[k] = depth;
          const ch = text[k];
          if (ch === '(') depth++;
          else if (ch === ')') depth = Math.max(0, depth - 1);
        }
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          if (depthAt[m.index] === 0 && m[1].length > 2 && knownFuncs.has(m[1]) && !CALL_NOISE.test(m[1])) return m[1];
        }
        if (j > li && depth === 0 && /^\s*(?:break\b|return\b)/.test(text)) break;
      }
      return null;
    };
    // The function a listener line runs: the one passed by name, else the first call in its body.
    const listenerCall = (flines, li) => {
      const line = flines[li] || '';
      const named = line.match(/addEventListener\s*\(\s*['"][\w-]+['"]\s*,\s*([A-Za-z_$][\w$]*)\s*[,)]/) || line.match(/\.on[a-z]+\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/);
      if (named && knownFuncs.has(named[1])) return named[1];
      const arrow = line.search(/=>|\bfunction\b/);
      if (arrow < 0) return null;
      const body = [line.slice(arrow).replace(/^(?:=>\s*\{?|function\s*\([^)]*\)\s*\{?)/, '')];
      const indent = line.search(/\S/);
      for (let j = li + 1; j < Math.min(li + 20, flines.length); j++) {
        const t = flines[j] || '';
        if (t.trim() && t.search(/\S/) <= indent) break;
        body.push(t);
      }
      return callIn(body, 0);
    };
    for (const [a, list] of cands) {
      const ok = list
        .map((c) => ({ ...c, near: sharedDirs(c.fp, a.filepath), reads: c.byId || !!(reads[c.fp] && reads[c.fp].has(a.type)) }))
        .filter((c) => c.reads || c.near > 0);
      if (!ok.length) continue;
      ok.sort((x, y) => (x.tier - y.tier) || (y.near - x.near) || ((y.reads ? 1 : 0) - (x.reads ? 1 : 0))
        || ((leads[y.fp] || 0) - (leads[x.fp] || 0)) || (x.fp < y.fp ? -1 : x.fp > y.fp ? 1 : 0) || (x.li - y.li));
      const c = ok[0];
      a.handler = {
        filepath: c.fp, line: c.li + 1,
        func: idx._findContainingFunctionFromBounds(idx._getFuncBoundaries(c.fp), c.li + 1),
        handlerFunc: c.tier !== 0 ? null : c.byId ? listenerCall(idx.fileLines.get(c.fp), c.li) : callIn(idx.fileLines.get(c.fp), c.li),
        kind: c.tier === 0 ? 'dispatch' : 'selector',
      };
    }
    // A control named by a data-* attribute that nothing dispatches on by value: point at
    // the nearest script line that reads the attribute, where all such controls are handled.
    for (const a of catalog.guiActions) {
      if (a.handler || a.byId || a.type === 'menu-group' || !attrLines[a.type]) continue;
      const c = attrLines[a.type]
        .map((x) => ({ ...x, near: sharedDirs(x.fp, a.filepath) }))
        .filter((x) => x.fp !== a.filepath && x.near > 0)
        .sort((x, y) => (y.near - x.near) || (x.fp < y.fp ? -1 : x.fp > y.fp ? 1 : 0) || (x.li - y.li))[0];
      if (!c) continue;
      a.handler = { filepath: c.fp, line: c.li + 1, func: idx._findContainingFunctionFromBounds(idx._getFuncBoundaries(c.fp), c.li + 1), handlerFunc: null, kind: 'selector' };
    }
    // An element that is not a control by its tag is one only if a script listens on it.
    catalog.guiActions = catalog.guiActions.filter((a) => !a.needsListener || (a.handler && a.handler.kind === 'dispatch'));
  }

  // What the GUI list could not see. Answered from the index alone, as the imports
  // report's HTML note is: an archive build records the extensions it skipped; otherwise,
  // scripts that drive a page with no markup in the index get the conditional form.
  {
    const skipped = idx.skippedExtensions || {};
    const nSkipped = ['.html', '.htm', 'html', 'htm'].reduce((n, k) => n + (Number(skipped[k]) || 0), 0);
    let hasHtml = false;
    for (const fp of idx.fileLines.keys()) if (GUI_HTML_FILE.test(fp)) { hasHtml = true; break; }
    const rebuild = 'rebuild with --build-index <source> --index-path <index> --add-extensions .html,.htm';
    if (nSkipped) {
      catalog.guiNote = nSkipped + ' HTML file(s) were not indexed at build (not in the default extensions), so the controls they define were not read; ' + rebuild + '.';
    } else if (!hasHtml && (guiSeen.dom || catalog.guiActions.some((a) => a.type !== 'menu-group'))) {
      const listed = catalog.guiActions.some((a) => a.type !== 'menu-group');
      catalog.guiNote = 'No HTML in this index, though scripts in it drive a page: controls defined in markup were not read' +
        (listed ? ', and each name listed here was seen only in a script. ' : '. ') +
        'If the source has HTML, ' + rebuild + '.';
    } else {
      catalog.guiNote = null;
    }
  }

  // Resolve Win32 MENUITEM handlers: find case IDM_*: in C++ dispatch functions
  for (const cmd of catalog.commands) {
    if (cmd.type !== 'menu') continue;
    const cmdId = cmd.name; // e.g. IDM_EDIT_PASTE
    for (const [fp, flines] of idx.fileLines) {
      if (fp === cmd.filepath) continue; // skip the .rc file
      for (let li = 0; li < flines.length; li++) {
        if (!flines[li] || flines[li].length > MAX_SCAN_LINE) continue;
        if (flines[li].includes('case ' + cmdId + ':') || flines[li].includes('case ' + cmdId + ' :')) {
          const handlerFunc = idx._findContainingFunctionFromBounds(
            idx._getFuncBoundaries(fp), li + 1
          );
          cmd.handler = {
            filepath: fp, line: li + 1,
            func: handlerFunc,
          };
          break;
        }
      }
      if (cmd.handler) break;
    }
  }

  // Deduplicate CLI options: group by name, keep all source files
  const optGroups = Object.create(null);
  for (const opt of catalog.cliOptions) {
    const key = opt.name;
    if (!optGroups[key]) {
      optGroups[key] = { ...opt, sources: [{ filepath: opt.filepath, line: opt.line }] };
    } else {
      optGroups[key].sources.push({ filepath: opt.filepath, line: opt.line });
      // Prefer the one with a handler
      if (opt.handler && !optGroups[key].handler) {
        optGroups[key].handler = opt.handler;
      }
      // Prefer the one with help text
      if (opt.help && !optGroups[key].help) {
        optGroups[key].help = opt.help;
      }
    }
  }
  catalog.cliOptions = Object.values(optGroups);

  // Deduplicate commands: group by name, keep distinct source locations
  const cmdGroups = Object.create(null);
  for (const cmd of catalog.commands) {
    const key = cmd.name;
    if (!cmdGroups[key]) {
      cmdGroups[key] = { ...cmd, sources: [{ filepath: cmd.filepath, line: cmd.line, func: cmd.func }] };
    } else {
      // Only add if from a different file
      const existing = cmdGroups[key].sources;
      if (!existing.some(s => s.filepath === cmd.filepath && s.line === cmd.line)) {
        existing.push({ filepath: cmd.filepath, line: cmd.line, func: cmd.func });
      }
    }
  }
  catalog.commands = Object.values(cmdGroups);

  // Deduplicate routes and GUI actions similarly
  const routeGroups = Object.create(null);
  for (const r of catalog.routes) {
    if (!routeGroups[r.path]) routeGroups[r.path] = r;
  }
  catalog.routes = Object.values(routeGroups);

  // (GUI actions were reduced to one row per name and kind before their handlers were resolved.)

  // Assign tiers to commands:
  // primary = looks like a user-facing command (has action-like description, slash-command, etc.)
  // secondary = case values, config data, signal docs, package metadata
  for (const cmd of catalog.commands) {
    const name = cmd.name || '';
    const desc = cmd.description || '';

    // Start with: has description or is a slash-command → candidate for primary
    if (!desc && !name.startsWith('/') && !cmd.help) {
      cmd.tier = 'secondary';
      continue;
    }

    // Demote non-command patterns to secondary:
    // Unix signals (SIGALRM, SIGINT, etc.)
    if (/^SIG[A-Z]{2,}$/.test(name)) { cmd.tier = 'secondary'; continue; }
    // ALL_CAPS names without descriptions (constants, placeholders like FILE, VERSION)
    // But keep if type is 'menu' (Win32 MENUITEM with IDM_ name + menu text description)
    if (/^[A-Z][A-Z0-9_ ]+$/.test(name) && cmd.type !== 'menu') { cmd.tier = 'secondary'; continue; }
    // AWS regions and config
    if (/^aws\b/.test(name) && (/region|Cape Town|Germany/i.test(desc))) { cmd.tier = 'secondary'; continue; }
    // Package/library metadata
    if (/\b(SDK|Client for|Library for|Module for|HTTP client|processing)\b/i.test(desc)) { cmd.tier = 'secondary'; continue; }
    // Package names starting with @ (npm scoped packages)
    if (name.startsWith('@')) { cmd.tier = 'secondary'; continue; }
    // Names that start with -- (embedded tool CLI options, not commands)
    if (name.startsWith('--')) { cmd.tier = 'secondary'; continue; }
    // Filesystem/URL paths detected as slash commands (/tmp, /var, /proc, /dev, /mnt, /v1, etc.)
    if (name.startsWith('/') && /^\/(?:tmp|var|proc|dev|mnt|usr|etc|sys|opt|bin|lib|home|root|private|callback|v\d)$/i.test(name)) { cmd.tier = 'secondary'; continue; }
    // Single-word generic parameter names (command, count, duration, definition, etc.)
    if (/^[a-z]+$/.test(name) && name.length <= 10 && /^(command|count|duration|definition|install|timeout|files|find)$/.test(name) && !name.startsWith('/')) {
      // Only demote if the description doesn't sound like a user-facing action
      if (!/^(Create|Show|List|Manage|Set|Get|Open|Clear|Enable|Toggle|View|Run|Submit|Export|Import|Search|Configure)\b/.test(desc)) {
        cmd.tier = 'secondary'; continue;
      }
    }

    cmd.tier = 'primary';
  }

  // Sort each section (primary first, then alphabetical within tier)
  catalog.cliOptions.sort((a, b) => a.name.localeCompare(b.name));
  catalog.commands.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'primary' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  catalog.routes.sort((a, b) => a.path.localeCompare(b.path));
  catalog.guiActions.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));

  if (showProgress) {
    const total = catalog.cliOptions.length + catalog.commands.length +
                  catalog.routes.length + catalog.guiActions.length;
    console.log(`Command catalog: ${catalog.cliOptions.length} CLI options, ` +
                `${catalog.commands.length} commands, ${catalog.routes.length} routes, ` +
                `${catalog.guiActions.length} GUI actions (${total} total)`);
  }

  _catalogCache.set(idx, catalog);
  return catalog;
}
