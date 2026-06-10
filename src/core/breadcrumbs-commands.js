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
// ========================================================================
// Command catalog: extract CLI options, interactive commands, GUI actions
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

  for (const [filepath, lines] of idx.fileLines) {
    const funcBounds = idx._getFuncBoundaries(filepath);

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      if (!line || line.length > MAX_SCAN_LINE) continue;
      const lineNum = lineIdx + 1;
      const func = idx._findContainingFunctionFromBounds(funcBounds, lineNum);

      // --- Pattern 1a: JS argparse option definitions ---
      // ['option_name', 'type', ['--flag', '--alias']]
      const argMatch = line.match(/\[\s*'(\w+)'\s*,\s*'(\w+)'\s*,\s*\[([^\]]+)\]\s*\]/);
      if (argMatch) {
        const aliases = argMatch[3].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) || [];
        if (aliases.some(a => a.startsWith('--') || a.startsWith('-'))) {
          catalog.cliOptions.push({
            name: argMatch[1],
            type: argMatch[2],
            flags: aliases,
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
      const dataActionMatch = line.match(/data-action="([^"]+)"/);
      if (dataActionMatch) {
        catalog.guiActions.push({
          name: dataActionMatch[1],
          type: 'action',
          filepath, line: lineNum, func,
        });
      }
      const dataSectionMatch = line.match(/data-section="([^"]+)"/);
      if (dataSectionMatch) {
        catalog.guiActions.push({
          name: dataSectionMatch[1],
          type: 'section',
          filepath, line: lineNum, func,
        });
      }

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

  // Resolve CLI option handlers: find where args.option_name is checked
  // JS: if (args.hotspots) / args._explicit.has('hotspots')
  // Python: if args.hotspots: / elif args.hotspots:
  //
  // digest-perf (#90): ONE pass over the index matching all options at once.
  // The old shape (full index scan PER option) was quadratic — 331 options ×
  // 942k lines ≈ 62s on .plugins_from_gh, ~85% of digest time. Same
  // first-match-in-file-order result: dispatch lines are visited in the same
  // order, and each option takes the first line that matches it.
  const optsByName = new Map();
  for (const opt of catalog.cliOptions) {
    if (!optsByName.has(opt.name)) optsByName.set(opt.name, []);
    optsByName.get(opt.name).push(opt);
  }
  let unresolvedOpts = catalog.cliOptions.length;
  const reArgsDot = /\bargs\.(\w+)/g;
  const reQuoted = /'(\w+)'/g;
  for (const [fp, flines] of idx.fileLines) {
    if (!unresolvedOpts) break;
    let funcBounds = null;   // lazy — most files have no dispatch lines
    for (let li = 0; li < flines.length && unresolvedOpts; li++) {
      const fline = flines[li];
      if (!fline || fline.length > MAX_SCAN_LINE) continue;
      // Check it looks like a dispatch (if/elif/case), not just a reference
      const trimmed = fline.trim();
      const isDispatch = /^(if|elif|else if|case)\b/.test(trimmed) ||
                         trimmed.includes('_explicit.has');
      if (!isDispatch) continue;
      // Candidate option names on this dispatch line — JS `args.X`,
      // quoted 'X' (covers _explicit.has('X') and Python dict forms).
      const cands = new Set();
      let mm;
      reArgsDot.lastIndex = 0;
      while ((mm = reArgsDot.exec(fline))) cands.add(mm[1]);
      reQuoted.lastIndex = 0;
      while ((mm = reQuoted.exec(fline))) cands.add(mm[1]);
      for (const name of cands) {
        const optList = optsByName.get(name);
        if (!optList) continue;
        for (const opt of optList) {
          if (opt.handler) continue;
          // Skip the argparse definition lines themselves
          if (fp === opt.filepath && Math.abs(li + 1 - opt.line) < 5) continue;
          if (!funcBounds) funcBounds = idx._getFuncBoundaries(fp);
          const handlerFunc = idx._findContainingFunctionFromBounds(funcBounds, li + 1);
          // Look for the called function. Scan a 20-line window (was 3)
          // so we catch dispatches where the real handler call is several
          // lines below the `if (args.X)` guard — e.g. --build-index has
          // ~10 lines of option-formatting before the actual
          // `await index.buildIndex(...)`.
          const snippet = flines.slice(li, Math.min(li + 20, flines.length)).join(' ');
          // Priority 1: do-prefixed standalone call — the strongest
          // convention-based signal (`doFoo(` / `do_foo(` / `await doFoo(`).
          // Priority 2: any awaited call, including method calls
          // (`await x.buildIndex(` captures "buildIndex"). This catches
          // options whose handler uses method-call dispatch rather than
          // the doXxx() naming convention.
          let handlerName = null;
          const doMatch = snippet.match(/\b(do[_A-Z]\w+)\s*\(|await\s+(do[_A-Z]\w+)\s*\(/);
          if (doMatch) {
            handlerName = doMatch[1] || doMatch[2];
          } else {
            const awaitMatch = snippet.match(/await\s+(?:\w+\.)?(\w+)\s*\(/);
            if (awaitMatch) {
              const candidate = awaitMatch[1];
              // Filter out stdlib/builtin noise — these are never user
              // handlers. Keep the list small and high-confidence; better
              // to miss a handler than to tag the wrong function.
              const NOISE = /^(?:write|log|warn|error|info|debug|then|catch|stringify|parse|split|join|map|filter|forEach|readFile|readFileSync|writeFile|writeFileSync|exists|existsSync|stat|statSync|mkdir|rmdir|readdir)$/;
              if (!NOISE.test(candidate)) handlerName = candidate;
            }
          }
          opt.handler = {
            filepath: fp, line: li + 1,
            func: handlerFunc,
            handlerFunc: handlerName,
          };
          unresolvedOpts--;
        }
      }
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

  // Resolve GUI action handlers: find where the action name appears in JS dispatch
  // (e.g. case 'search-fast': or data-action="search-fast" handler wiring)
  for (const action of catalog.guiActions) {
    const actionName = action.name;
    for (const [fp, flines] of idx.fileLines) {
      if (fp === action.filepath) continue; // skip the HTML definition
      for (let li = 0; li < flines.length; li++) {
        const fline = flines[li];
        if (!fline || fline.length > MAX_SCAN_LINE) continue;
        // Match: case 'action-name': or 'action-name' in a switch/dispatch context
        if (fline.includes("'" + actionName + "'") || fline.includes('"' + actionName + '"')) {
          const handlerFunc = idx._findContainingFunctionFromBounds(
            idx._getFuncBoundaries(fp), li + 1
          );
          action.handler = {
            filepath: fp, line: li + 1,
            func: handlerFunc,
          };
          break;
        }
      }
      if (action.handler) break;
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

  const actionGroups = Object.create(null);
  for (const a of catalog.guiActions) {
    const key = a.name + '|' + a.type;
    if (!actionGroups[key]) actionGroups[key] = a;
  }
  catalog.guiActions = Object.values(actionGroups);

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
  catalog.guiActions.sort((a, b) => a.name.localeCompare(b.name));

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
