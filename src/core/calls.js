// calls.js — call-graph engine: resolves callees, finds callers, builds call inventories and per-name call counts
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * calls.js — Call-graph machinery: callers/callees/inventory/counts plus
 * the helpers that walk call sites. Pulled out of CodeSearchIndex.js in
 * Issue #18 Phase 2 (theme #16, fourth and most-coupled of the big-5
 * targets).
 *
 * Free-function exports, each taking idx as first arg; the public surface is
 * wrappered in the CSI class (CodeSearchIndex.js), while the
 * underscore-private helpers (_resolveCalleeTarget, _findCallersByExactRegex,
 * _buildDefinitionLookup) and guessProvenance stay module-internal.
 *
 * PROVENANCE_PATTERNS const stays module-private (no external callsite).
 */

import { displayName, eprint } from '../utils.js';
import { escapeRegex } from './CSI-helpers.js';

/**
 * Resolve which definition of a callee is most likely being called,
 * given the call-site context.
 *
 * Priority order:
 *   1. Explicit qualification: ClassName::method() or ClassName.method()
 *   2. self/this prefix: self.method() or this->method() → same class as caller
 *   3. Same-class definition (caller is ClassA::foo, callee ClassA::bar exists)
 *   4. Same-file definition
 *   5. Closest directory path
 *   6. Fall back to first definition
 *
 * @param {string} bareName - Bare callee name
 * @param {string} line - Source line containing the call
 * @param {string|null} callerClass - Class of the calling function (or null)
 * @param {string} callerFilepath - File containing the call site
 * @param {Array} defs - All definitions with this bare name
 * @returns {{def: object, resolvedName: string, ambiguous: boolean}}
 */
export function _resolveCalleeTarget(idx, bareName, line, callerClass, callerFilepath, defs) {
  if (!defs || defs.length === 0) return { def: null, resolvedName: bareName, ambiguous: false };
  if (defs.length === 1) return { def: defs[0], resolvedName: defs[0].full_name, ambiguous: false };

  // 1. Check for explicit qualification in the source line
  //    e.g., ClassName::method(, ClassName.method(, ClassName->method(
  const qualRe = new RegExp(
    '([A-Z][A-Za-z0-9_]*)\\s*(?:::|\\.|->)\\s*' + escapeRegex(bareName) + '\\s*\\('
  );
  const qualMatch = qualRe.exec(line);
  if (qualMatch) {
    const explicitClass = qualMatch[1];
    // Find def matching this class
    const match = defs.find(d => d.class_name === explicitClass);
    if (match) return { def: match, resolvedName: match.full_name, ambiguous: false };
    // Try partial match (class name might be just the leaf)
    const partialMatch = defs.find(d =>
      d.class_name && d.class_name.endsWith(explicitClass)
    );
    if (partialMatch) return { def: partialMatch, resolvedName: partialMatch.full_name, ambiguous: false };

    // 1b. Explicit class might be a child class — walk up its chain
    const ancestors = idx._getAncestorClasses(explicitClass);
    for (const ancestor of ancestors) {
      const inheritMatch = defs.find(d => d.class_name === ancestor);
      if (inheritMatch) return { def: inheritMatch, resolvedName: inheritMatch.full_name, ambiguous: false };
    }
  }

  // 2. Check for self/this prefix → same class as caller, or inherited
  const selfRe = new RegExp(
    '(?:self|this)\\s*(?:\\.|->)\\s*' + escapeRegex(bareName) + '\\s*\\('
  );
  if (selfRe.test(line) && callerClass) {
    const match = defs.find(d => d.class_name === callerClass);
    if (match) return { def: match, resolvedName: match.full_name, ambiguous: false };

    // 2b. Not in caller's class — check parent classes (inherited method)
    const ancestors = idx._getAncestorClasses(callerClass);
    for (const ancestor of ancestors) {
      const inheritMatch = defs.find(d => d.class_name === ancestor);
      if (inheritMatch) return { def: inheritMatch, resolvedName: inheritMatch.full_name, ambiguous: false };
    }
  }

  // 3. Same-class definition (if caller is in a class)
  if (callerClass) {
    const match = defs.find(d => d.class_name === callerClass);
    if (match) return { def: match, resolvedName: match.full_name, ambiguous: false };

    // 3b. Walk inheritance chain for bare calls too
    const ancestors = idx._getAncestorClasses(callerClass);
    for (const ancestor of ancestors) {
      const inheritMatch = defs.find(d => d.class_name === ancestor);
      if (inheritMatch) return { def: inheritMatch, resolvedName: inheritMatch.full_name, ambiguous: false };
    }
  }

  // 4. Same-file definition
  const sameFile = defs.filter(d => d.filepath === callerFilepath);
  if (sameFile.length === 1) return { def: sameFile[0], resolvedName: sameFile[0].full_name, ambiguous: false };

  // 5. Closest directory path
  const srcParts = callerFilepath.replace(/\\/g, '/').toLowerCase().split('/');
  const srcDir = srcParts.slice(0, -1);
  let best = null, bestScore = -1;
  for (const d of defs) {
    const tgtParts = d.filepath.replace(/\\/g, '/').toLowerCase().split('/');
    const tgtDir = tgtParts.slice(0, -1);
    let shared = 0;
    for (let i = 0; i < Math.min(srcDir.length, tgtDir.length); i++) {
      if (srcDir[i] === tgtDir[i]) shared++;
      else break;
    }
    if (shared > bestScore) { bestScore = shared; best = d; }
  }
  if (best) return { def: best, resolvedName: best.full_name, ambiguous: defs.length > 1 };

  // 6. Fall back
  return { def: defs[0], resolvedName: defs[0].full_name, ambiguous: true };
}


// ========================================================================
// Find callers
// ========================================================================

/**
 * Find all locations where a function is called.
 * Direct case-sensitive regex scan for `\bNAME\b\s*\(` call sites.
 * Used as a fallback when findCallers' inverted-index path bails out for
 * short names — those scans are slow because the index expands `xf` to
 * every line containing the substring `xf`, and case-folding lets `Xf`
 * and `XF` slip in. This walks every file's lines once with a tight
 * regex, takes a few seconds even on cli.js, and produces a clean
 * containing-function map identical in shape to findCallers' output.
 *
 * @param {string} functionName  bare name to scan for (case-sensitive)
 * @param {number} [maxResults=500]
 * @returns {Array<{filepath, line_number, caller_function}>}
 */
export function _findCallersByExactRegex(idx, functionName, maxResults = 500) {
  const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const callRe = new RegExp('\\b' + escaped + '\\b\\s*\\(');
  const results = [];
  for (const [filepath, lines] of idx.fileLines) {
    let funcBounds = null;
    for (let i = 0; i < lines.length; i++) {
      if (!callRe.test(lines[i])) continue;
      if (!funcBounds) funcBounds = idx._getFuncBoundaries(filepath);
      const containing = idx._findContainingFunctionFromBounds
        ? idx._findContainingFunctionFromBounds(funcBounds, i + 1)
        : null;
      results.push({
        filepath,
        line_number: i + 1,
        line_text: lines[i].trim(),
        caller_function: containing,
      });
      if (results.length >= maxResults) return results;
    }
  }
  return results;
}

/**
 * @param {string} functionName
 * @param {number} [maxResults=500]
 * @returns {Array<{filepath, line_number, line_text, caller_function, call_type}>}
 */
export function findCallers(idx, functionName, maxResults = 500, opts = {}) {
  if (!idx._ensureInvertedAvailable()) {
    console.log('No inverted index. Build index first.');
    return [];
  }
  idx._ensureFunctionIndex();

  // Extract bare name
  let bareName = functionName.includes('::') ? functionName.split('::').pop() : functionName;
  bareName = bareName.includes('.') ? bareName.split('.').pop() : bareName;

  // Short-name bail-out. For 1-2 character bare names (common in bundled JS
  // after esbuild minification — `h1`, `N8`, etc.), the inverted-index scan
  // has very low selectivity and blocks the event loop for seconds to
  // minutes on large indexes. See TODO #280 (worker threads) for the real
  // fix. Until then, default callers get a clean throw so the GUI can
  // surface a meaningful message; callers that really want the scan
  // (e.g. `--callers` CLI with explicit user intent) can pass
  // `{ allowShortName: true }` to force it.
  //
  // Threshold of 2 chars chosen because 3-char names like `GCz` typically
  // have 1-2 orders of magnitude lower match count and complete in under
  // a second. If you see freezes on longer names, raise idx.
  if (bareName.length <= 2 && !opts.allowShortName) {
    const err = new Error(`Bare name '${bareName}' is too short for efficient caller search on this index (#280). Short names match too many lines, blocking the server for minutes. Workaround: use --regex "\\b${bareName}\\b\\s*\\(" to find call sites via the inverted index.`);
    err.code = 'SHORT_NAME_BAILOUT';
    err.shortName = bareName;
    throw err;
  }

  // Build call patterns
  // Use case-insensitive only for longer names (5+ chars) where case collisions
  // are unlikely. Short names like 'lo' vs 'lO' are distinct in JS/TS.
  const caseFlag = bareName.length >= 5 ? 'i' : '';
  const callPatterns = [
    ['direct', new RegExp('(?<![a-zA-Z_])' + escapeRegex(bareName) + '\\s*\\(', caseFlag)],
  ];

  // Qualified pattern (always case-sensitive — qualified names are precise)
  if (functionName.includes('::')) {
    const parts = functionName.split('::');
    if (parts.length >= 2) {
      callPatterns.push([
        'qualified',
        new RegExp(escapeRegex(parts[parts.length - 2]) + '\\s*::\\s*' + escapeRegex(parts[parts.length - 1]) + '\\s*\\('),
      ]);
    }
  }

  // Indirect call patterns
  callPatterns.push([
    'indirect',
    new RegExp('\\(\\s*\\*\\s*' + escapeRegex(bareName) + '\\s*\\)\\s*\\(', caseFlag),
  ]);
  callPatterns.push([
    'reference',
    new RegExp('(?:=\\s*&?\\s*|,\\s*&?\\s*)' + escapeRegex(bareName) + '\\s*(?:[,;\\)\\]]|$)', caseFlag),
  ]);

  // Find definition locations to exclude
  const definitionLocations = new Set();
  for (const [fpath, functions] of Object.entries(idx.functionIndex || {})) {
    for (const [fname, info] of Object.entries(functions)) {
      if (fname === functionName || fname.endsWith('::' + bareName) || fname === bareName) {
        definitionLocations.add(`${fpath}:${info.start}`);
      }
    }
  }

  const results = [];
  const seen = new Set();
  const bareEsc = escapeRegex(bareName);

  idx.forEachInvertedEntry((line, locations) => {
    // Check patterns
    let matchedType = null;
    for (const [patType, pattern] of callPatterns) {
      if (pattern.test(line)) {
        matchedType = patType;
        break;
      }
    }
    if (!matchedType) return;

    const isReference = matchedType === 'reference';

    if (!isReference) {
      const stripped = line.trimEnd();
      // Skip declarations
      if (stripped.endsWith(';') && !line.includes('{')) {
        const declRe = new RegExp('^\\s*[\\w\\s*&]+\\s+' + bareEsc + '\\s*\\([^)]*\\)\\s*;$');
        if (declRe.test(line)) return;
      }
      // Skip definitions
      if (stripped.endsWith('{')) {
        const defRe = new RegExp('^\\s*[\\w\\s*&:~]+\\s+' + bareEsc + '\\s*\\([^)]*\\)\\s*(?:const\\s*)?(?:override\\s*)?(?:final\\s*)?\\{$');
        if (defRe.test(stripped)) return;
      }
      // Skip inline constructors/destructors
      if (stripped.endsWith('};') || stripped.endsWith('}')) {
        const inlineRe = new RegExp('^\\s*~?' + bareEsc + '\\s*\\([^)]*\\)\\s*(?:const\\s*)?(?::\\s*[\\w()\\s,]+)?\\{.*\\}\\s*;?\\s*$');
        if (inlineRe.test(stripped)) return;
      }
      // Skip copy/move constructors
      const ctorRe = new RegExp('^\\s*' + bareEsc + '\\s*\\(\\s*(?:const\\s+)?' + bareEsc + '[\\s&*]*\\w*\\s*\\)\\s*\\{?\\s*$');
      if (ctorRe.test(stripped)) return;
      // Skip forward declarations
      if (new RegExp('^\\s*(?:class|struct|enum|union)\\s+' + bareEsc + '\\s*;').test(stripped)) return;
    }

    // Skip comments
    const strippedForComment = line.trimStart();
    if (strippedForComment.startsWith('//') || strippedForComment.startsWith('*') || strippedForComment.startsWith('/*')) return;

    // Process each location
    for (const [filepath, lineNumbers] of locations) {
      for (const lineNum of lineNumbers) {
        if (definitionLocations.has(`${filepath}:${lineNum}`)) continue;
        const key = `${filepath}:${lineNum}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const callerFunc = idx._findContainingFunctionFromIndex(filepath, lineNum);

        // Determine call type
        let callType;
        if (matchedType === 'indirect' || matchedType === 'reference') {
          callType = matchedType;
        } else if (line.includes('->' + bareName)) {
          callType = 'method_ptr';
        } else if (line.includes('.' + bareName)) {
          callType = 'method_dot';
        } else if (line.includes('::' + bareName)) {
          callType = 'qualified';
        } else {
          callType = 'direct';
        }

        results.push({
          filepath, line_number: lineNum,
          line_text: line.trim(),
          caller_function: callerFunc,
          call_type: callType,
        });

        if (results.length >= maxResults) return false; // early stop
      }
    }
  });
  return results;
}


// ========================================================================
// Find callees
// ========================================================================

/**
 * Find all functions called BY a given function.
 * Uses class-aware disambiguation to resolve which definition
 * of an overloaded name is actually being called.
 * @param {string} functionName
 * @param {string|null} [fileHint]
 * @returns {Array<{name, display_name, definitions, resolved_def, line_number, call_type, ambiguous}>}
 */
export function findCallees(idx, functionName, fileHint = null) {
  idx._ensureFunctionIndex();

  const matches = idx.findFunctionMatches(functionName, fileHint);
  if (matches.length === 0) return [];

  const target = matches[0];
  const targetFilepath = target.filepath;
  const targetStart = target.start;
  const targetEnd = target.end;

  const lines = idx.fileLines.get(targetFilepath);
  if (!lines) return [];
  const bodyLines = lines.slice(targetStart - 1, targetEnd);

  const knownFunctions = idx._getKnownFunctions();
  const results = [];
  // Dedup by resolved qualified name (not bare name), so ClassA::run
  // and ClassB::run both appear when both are called.
  const seenResolved = new Set();

  const callPattern = /(?<![a-zA-Z_])([a-zA-Z_]\w*)\s*\(/g;
  const indirectPattern = /\(\s*\*\s*([a-zA-Z_]\w*)\s*\)\s*\(/g;
  // Event handler patterns: addEventListener('event', handler), .on('event', handler)
  const eventHandlerPattern = /\.(?:addEventListener|on|once|removeEventListener)\s*\(\s*['"][^'"]*['"]\s*,\s*([a-zA-Z_]\w*)\b/g;

  let targetBare = functionName.includes('::') ? functionName.split('::').pop() : functionName;

  // Determine caller's class context
  const callerName = target.name || functionName;
  const callerClass = callerName.includes('::')
    ? callerName.split('::').slice(0, -1).join('::')
    : null;

  const skipKw = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return',
    'sizeof', 'typeof', 'alignof', 'decltype',
    'defined', 'assert', 'static_assert',
  ]);

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const lineNum = targetStart + i;
    const stripped = line.trimStart();
    if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) continue;

    // Check indirect calls first
    let m;
    indirectPattern.lastIndex = 0;
    while ((m = indirectPattern.exec(line)) !== null) {
      const calleeName = m[1];
      if (!(calleeName in knownFunctions)) continue;
      if (calleeName === targetBare) continue;

      const defs = knownFunctions[calleeName];
      const resolved = _resolveCalleeTarget(idx, 
        calleeName, line, callerClass, targetFilepath, defs
      );
      const resolvedKey = resolved.resolvedName || calleeName;
      if (seenResolved.has(resolvedKey)) continue;
      seenResolved.add(resolvedKey);

      results.push({
        name: calleeName,
        display_name: displayName(resolved.resolvedName, resolved.def?.filepath || ''),
        definitions: defs,
        resolved_def: resolved.def,
        line_number: lineNum,
        call_type: 'indirect',
        ambiguous: resolved.ambiguous,
      });
    }

    // Check direct calls
    callPattern.lastIndex = 0;
    while ((m = callPattern.exec(line)) !== null) {
      const calleeName = m[1];
      if (!(calleeName in knownFunctions)) continue;
      if (skipKw.has(calleeName)) continue;

      const defs = knownFunctions[calleeName];

      if (calleeName === targetBare) {
        // Line 0 of the body is the function's declaration line, and its
        // signature `bareName(args) {` matches the call pattern. That's
        // NOT a recursive call — it's the method's own signature being
        // seen by the regex. Skip it to avoid the false `[self-recursive]`
        // flag on digests. A true same-line recursion (`const f = () => f(1)`
        // written all on one line) is rare enough to tolerate a missed
        // case here.
        if (i === 0) continue;
        const resolvedKey = callerName || calleeName;
        if (!seenResolved.has(resolvedKey)) {
          seenResolved.add(resolvedKey);
          results.push({
            name: calleeName,
            display_name: displayName(callerName, targetFilepath),
            definitions: defs,
            resolved_def: defs.find(d => d.filepath === targetFilepath) || defs[0],
            line_number: lineNum,
            call_type: 'recursive',
            ambiguous: false,
          });
        }
        continue;
      }

      // Resolve which definition is being called
      const resolved = _resolveCalleeTarget(idx, 
        calleeName, line, callerClass, targetFilepath, defs
      );
      const resolvedKey = resolved.resolvedName || calleeName;
      if (seenResolved.has(resolvedKey)) continue;
      seenResolved.add(resolvedKey);

      // Determine call type from context
      const pos = m.index;
      const prefix = line.slice(0, pos);
      let callType;
      if (prefix.trimEnd().endsWith('->')) callType = 'method_ptr';
      else if (prefix.trimEnd().endsWith('.')) callType = 'method_dot';
      else if (prefix.trimEnd().endsWith('::')) callType = 'qualified';
      else callType = 'direct';

      // For dot-calls, check if the resolved class actually appears as the
      // receiver. If not (e.g. `e.message.includes(...)` resolved to
      // `LlamaText::includes`), strip the false class attribution.
      if (callType === 'method_dot' && resolved.def?.class_name) {
        const resolvedClass = resolved.def.class_name;
        const receiverMatch = prefix.match(/([a-zA-Z_]\w*)\s*\.\s*$/);
        const receiver = receiverMatch ? receiverMatch[1] : null;
        // Keep class if receiver matches the class name, or is this/self
        const receiverConfirmed = receiver
          && (receiver === resolvedClass || receiver === 'this' || receiver === 'self');
        // Also keep if the class name appears explicitly elsewhere in the prefix
        const classInPrefix = !receiverConfirmed
          && new RegExp('\\b' + escapeRegex(resolvedClass) + '\\b').test(prefix);
        if (!receiverConfirmed && !classInPrefix) {
          // Demote to bare name — still show the call, just without the wrong class
          resolved.resolvedName = calleeName;
          resolved.def = null;
          resolved.ambiguous = true;
        }
      }

      results.push({
        name: calleeName,
        display_name: displayName(resolved.resolvedName, resolved.def?.filepath || ''),
        definitions: defs,
        resolved_def: resolved.def,
        line_number: lineNum,
        call_type: callType,
        ambiguous: resolved.ambiguous,
      });
    }

    // Check event handler registrations: addEventListener('event', handler)
    eventHandlerPattern.lastIndex = 0;
    while ((m = eventHandlerPattern.exec(line)) !== null) {
      const handlerName = m[1];
      if (!(handlerName in knownFunctions)) continue;
      if (handlerName === targetBare) continue;
      const defs = knownFunctions[handlerName];
      const resolved = _resolveCalleeTarget(idx, 
        handlerName, line, callerClass, targetFilepath, defs
      );
      const resolvedKey = resolved.resolvedName || handlerName;
      if (seenResolved.has(resolvedKey)) continue;
      seenResolved.add(resolvedKey);
      results.push({
        name: handlerName,
        display_name: displayName(resolved.resolvedName, resolved.def?.filepath || ''),
        definitions: defs,
        resolved_def: resolved.def,
        line_number: lineNum,
        call_type: 'event-handler',
        ambiguous: resolved.ambiguous,
      });
    }
  }
  return results;
}


// ========================================================================
// Call inventory — partition call targets into in-index vs external
// ========================================================================

/**
 * Well-known library prefix patterns for provenance labeling.
 * Each entry: [regex, label]
 * Order matters — first match wins.
 */
const PROVENANCE_PATTERNS = [
  // C standard library
  [/^(malloc|calloc|realloc|free|memcpy|memmove|memset|memcmp|memchr)$/, 'C stdlib (memory)'],
  [/^(printf|fprintf|sprintf|snprintf|vprintf|vfprintf|vsprintf|vsnprintf|puts|fputs|fputc|putchar|putc|getchar|getc|fgetc|gets|fgets|ungetc|fread|fwrite|fopen|fclose|fflush|fseek|ftell|rewind|feof|ferror|clearerr|perror|tmpfile|tmpnam|freopen|setbuf|setvbuf|remove|rename)$/, 'C stdlib (stdio)'],
  [/^(strlen|strcpy|strncpy|strcat|strncat|strcmp|strncmp|strchr|strrchr|strstr|strtok|strdup|strerror|strspn|strcspn|strpbrk)$/, 'C stdlib (string)'],
  [/^(atoi|atol|atof|strtol|strtoul|strtod|strtof|strtoll|strtoull|abs|labs|llabs|div|ldiv|lldiv|rand|srand|qsort|bsearch|exit|abort|atexit|getenv|system)$/, 'C stdlib (stdlib)'],
  [/^(isalpha|isdigit|isalnum|isspace|isupper|islower|isprint|ispunct|iscntrl|isxdigit|toupper|tolower)$/, 'C stdlib (ctype)'],
  [/^(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|exp|log|log10|log2|pow|sqrt|ceil|floor|fabs|fmod|round|trunc|frexp|ldexp|modf)$/, 'C stdlib (math)'],
  [/^(time|clock|difftime|mktime|asctime|ctime|gmtime|localtime|strftime|clock_gettime|gettimeofday)$/, 'C stdlib (time)'],
  [/^(signal|raise|sigaction|sigprocmask|sigemptyset|sigfillset|sigaddset|sigdelset|sigismember|kill|alarm|pause)$/, 'C stdlib (signal)'],
  [/^(setjmp|longjmp)$/, 'C stdlib (setjmp)'],
  [/^(va_start|va_end|va_arg|va_copy)$/, 'C stdlib (stdarg)'],

  // POSIX / Unix
  [/^(open|close|read|write|lseek|dup|dup2|pipe|fcntl|ioctl|stat|fstat|lstat|chmod|chown|umask|mkdir|rmdir|opendir|readdir|closedir|link|unlink|symlink|readlink|access|chdir|getcwd|fork|exec[lv]p?e?|wait|waitpid|_exit|getpid|getppid|getuid|getgid|setuid|setgid|setsid|getpgrp|setpgid|tcgetpgrp|tcsetpgrp)$/, 'POSIX'],
  [/^(socket|bind|listen|accept|connect|send|recv|sendto|recvfrom|setsockopt|getsockopt|getaddrinfo|freeaddrinfo|getnameinfo|gethostbyname|gethostbyaddr|inet_addr|inet_ntoa|inet_pton|inet_ntop|htons|htonl|ntohs|ntohl|select|poll|epoll_create|epoll_ctl|epoll_wait|kqueue|kevent)$/, 'POSIX (sockets)'],
  [/^(mmap|munmap|mprotect|msync|mlock|munlock|shm_open|shm_unlink|shmget|shmat|shmdt|shmctl)$/, 'POSIX (mmap/shm)'],
  [/^(pthread_\w+)$/, 'pthreads'],
  [/^(sem_\w+)$/, 'POSIX (semaphores)'],
  [/^(dlopen|dlclose|dlsym|dlerror)$/, 'POSIX (dlopen)'],

  // Windows API
  [/^(CreateFile[AW]?|ReadFile|WriteFile|CloseHandle|GetLastError|SetLastError|FormatMessage[AW]?|LocalAlloc|LocalFree|GlobalAlloc|GlobalFree|HeapAlloc|HeapFree|HeapCreate|HeapDestroy|VirtualAlloc|VirtualFree|VirtualProtect)$/, 'Win32 API (core)'],
  [/^(CreateProcess[AW]?|ExitProcess|TerminateProcess|GetExitCodeProcess|OpenProcess|GetCurrentProcess|GetCurrentProcessId|GetCurrentThread|GetCurrentThreadId|CreateThread|ExitThread|TerminateThread|ResumeThread|SuspendThread|WaitForSingleObject|WaitForMultipleObjects|Sleep|SleepEx)$/, 'Win32 API (process/thread)'],
  [/^(CreateEvent[AW]?|SetEvent|ResetEvent|CreateMutex[AW]?|ReleaseMutex|CreateSemaphore[AW]?|ReleaseSemaphore|InitializeCriticalSection|EnterCriticalSection|LeaveCriticalSection|DeleteCriticalSection|TryEnterCriticalSection|InitializeSRWLock|AcquireSRWLock\w*|ReleaseSRWLock\w*)$/, 'Win32 API (sync)'],
  [/^(RegOpenKey|RegCloseKey|RegQueryValue|RegSetValue|RegCreateKey|RegDeleteKey|RegDeleteValue|RegEnumKey|RegEnumValue)[AW]?(Ex[AW]?)?$/, 'Win32 API (registry)'],
  [/^(WSAStartup|WSACleanup|WSAGetLastError|WSASocket[AW]?|WSASend|WSARecv|WSAConnect|WSAAccept|WSAEventSelect|WSAWaitForMultipleEvents|WSACreateEvent|WSACloseEvent|WSAEnumNetworkEvents)$/, 'Win32 API (Winsock)'],
  [/^(LoadLibrary[AW]?|FreeLibrary|GetProcAddress|GetModuleHandle[AW]?|GetModuleFileName[AW]?)$/, 'Win32 API (DLL)'],
  [/^(FindFirstFile[AW]?|FindNextFile[AW]?|FindClose|GetFileAttributes[AW]?|SetFileAttributes[AW]?|GetFileSize|SetFilePointer|MoveFile[AW]?|CopyFile[AW]?|DeleteFile[AW]?|CreateDirectory[AW]?|RemoveDirectory[AW]?)$/, 'Win32 API (file)'],
  [/^(MessageBox[AW]?|GetMessage[AW]?|PeekMessage[AW]?|PostMessage[AW]?|SendMessage[AW]?|DispatchMessage[AW]?|TranslateMessage|DefWindowProc[AW]?|RegisterClass[AW]?|CreateWindow(Ex)?[AW]?|DestroyWindow|ShowWindow|UpdateWindow|InvalidateRect|GetDC|ReleaseDC|BeginPaint|EndPaint)$/, 'Win32 API (GUI/message)'],
  [/^(Get|Set|Query|Enable|Disable|Is)(System|Window|Process|Thread|File|Console|Computer|User|Std|Tick|Volume|Disk|Drive|Startup|Version|Environment)\w*[AW]?$/, 'Win32 API'],

  // COM / OLE
  [/^(CoInitialize|CoInitializeEx|CoUninitialize|CoCreateInstance|CoGetClassObject|CoTaskMemAlloc|CoTaskMemFree|CoMarshalInterface|CoUnmarshalInterface|OleInitialize|OleUninitialize)$/, 'COM/OLE'],
  [/^(SysAllocString|SysFreeString|SafeArrayCreate|SafeArrayDestroy|VariantInit|VariantClear|VariantCopy)$/, 'COM/OLE (BSTR/VARIANT)'],

  // C++ standard library
  [/^(std)::\w+/, 'C++ stdlib'],
  [/^(make_shared|make_unique|make_pair|make_tuple|move|forward|swap|min|max|sort|find|begin|end|push_back|emplace_back|insert|erase|resize|reserve|size|empty|clear|front|back|at|data|c_str|substr|npos|to_string|stoi|stol|stof|stod)$/, 'C++ stdlib'],

  // OpenSSL
  [/^(SSL_\w+|EVP_\w+|BIO_\w+|X509_\w+|RSA_\w+|EC_\w+|HMAC\w*|SHA\d*\w*|MD5\w*|AES_\w+|DES_\w+|RAND_\w+|ERR_\w+|PEM_\w+|PKCS\d+_\w+|OPENSSL_\w+|CRYPTO_\w+)$/, 'OpenSSL'],

  // zlib
  [/^(deflate|inflate|deflateInit|inflateInit|deflateEnd|inflateEnd|compress|uncompress|gzopen|gzclose|gzread|gzwrite|crc32|adler32|zlibVersion)2?$/, 'zlib'],

  // SQLite
  [/^sqlite3_\w+$/, 'SQLite'],

  // Python C API
  [/^(Py\w+_\w+|PyErr_\w+|PyObject_\w+|PyList_\w+|PyDict_\w+|PyTuple_\w+|PyLong_\w+|PyFloat_\w+|PyUnicode_\w+|PyBytes_\w+|PyArg_\w+|Py_\w+)$/, 'Python C API'],

  // GLib / GTK
  [/^g_(malloc|free|new|renew|strdup|strsplit|string_\w+|list_\w+|hash_table_\w+|signal_\w+|object_\w+|type_\w+|main_\w+|idle_\w+|timeout_\w+|io_\w+|spawn_\w+|file_\w+|dir_\w+|key_file_\w+|regex_\w+|print|error|warning|message|debug|log|assert\w*|return_\w+)$/, 'GLib'],
  [/^gtk_\w+$/, 'GTK'],
  [/^gdk_\w+$/, 'GDK'],

  // Qt
  [/^(Q[A-Z]\w+)::\w+/, 'Qt'],

  // ACE framework
  [/^ACE_\w+$/, 'ACE framework'],

  // Boost
  [/^boost::\w+/, 'Boost'],

  // Java standard library (for .java files)
  [/^(System|String|Integer|Long|Double|Float|Boolean|Character|Math|Arrays|Collections|Objects|Optional|Stream|Thread|Runnable|Callable|Future|List|ArrayList|LinkedList|Map|HashMap|TreeMap|Set|HashSet|TreeSet|Queue|Deque|Stack|Iterator|Iterable|Comparable|Comparator|Exception|RuntimeException|IOException|StringBuilder|StringBuffer|Pattern|Matcher|Date|Calendar|LocalDate|LocalTime|Instant|Duration|File|Path|Files|InputStream|OutputStream|Reader|Writer|BufferedReader|BufferedWriter|PrintWriter|Scanner)\.\w+$/, 'Java stdlib'],

  // Python builtins and stdlib (for .py files)
  [/^(print|len|range|enumerate|zip|map|filter|sorted|reversed|list|dict|set|tuple|str|int|float|bool|type|isinstance|issubclass|hasattr|getattr|setattr|delattr|property|staticmethod|classmethod|super|iter|next|open|input|id|hash|repr|format|chr|ord|hex|oct|bin|abs|round|min|max|sum|all|any|dir|vars|globals|locals|exec|eval|compile|__import__|breakpoint)$/, 'Python builtin'],
  [/^(os|sys|re|json|math|random|datetime|collections|itertools|functools|pathlib|subprocess|threading|multiprocessing|socket|http|urllib|logging|unittest|argparse|typing|io|shutil|glob|fnmatch|hashlib|hmac|base64|struct|pickle|copy|pprint|textwrap|csv|configparser|sqlite3|xml|html|email)\.\w+$/, 'Python stdlib'],

  // Node.js
  [/^(require|console|process|Buffer|setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate|queueMicrotask)$/, 'Node.js'],
  [/^(fs|path|os|http|https|net|url|crypto|stream|events|util|child_process|cluster|dgram|dns|readline|zlib|assert|buffer|querystring|tls|vm|worker_threads)\.\w+$/, 'Node.js stdlib'],

  // Catch-all patterns (broad, lower priority)
  [/^(gl|GL_|glut|glu)[A-Z]\w*$/, 'OpenGL'],
  [/^(cl[A-Z])\w*$/, 'OpenCL'],
  [/^(cu[A-Z])\w*$/, 'CUDA'],
  [/^(MPI_)\w+$/, 'MPI'],
  [/^(pcre2?_)\w+$/, 'PCRE'],
  [/^(curl_)\w+$/, 'libcurl'],
  [/^(xml|XML|xmlC|htmlC?)\w+$/, 'libxml2'],
  [/^(json_)\w+$/, 'JSON-C / Jansson'],
  [/^(av_|avcodec_|avformat_|avutil_|sws_|swr_)\w+$/, 'FFmpeg'],
  [/^(cairo_)\w+$/, 'Cairo'],
  [/^(pango_)\w+$/, 'Pango'],
  [/^(dbus_)\w+$/, 'D-Bus'],
  [/^(uv_)\w+$/, 'libuv'],
  [/^(napi_)\w+$/, 'Node N-API'],
  [/^(ASSERT|EXPECT|TEST|TEST_F|TYPED_TEST)\w*$/, 'test framework (gtest-like)'],
  [/^(BOOST_\w+)$/, 'Boost'],
];

/**
 * Guess provenance of an external (not-in-index) call target.
 * @param {string} name - Bare function/method name
 * @returns {string|null} - Label like "C stdlib (memory)" or null
 */
function guessProvenance(name) {
  for (const [re, label] of PROVENANCE_PATTERNS) {
    if (re.test(name)) return label;
  }
  return null;
}

/**
 * Build a call inventory for one function or all functions.
 *
 * Returns all call targets partitioned into:
 *   - in_index: calls resolved to a function in the index
 *   - external: calls to functions not in the index (with provenance guess)
 *
 * @param {string|null} functionName - Target function, or null for all
 * @param {Object} [opts] - Options
 * @param {string} [opts.includePath] - Filter functions by path
 * @param {string} [opts.excludePath] - Exclude functions by path
 * @param {boolean} [opts.showProgress=true]
 * @returns {{
 *   in_index: Array<{name, qualified_name, filepath, lines, callers: string[]}>,
 *   external: Array<{name, provenance: string|null, call_sites: Array<{caller, filepath, line}>}>,
 *   summary: {total_targets, in_index_count, external_count, functions_scanned}
 * }}
 */
export function getCallInventory(idx, functionName = null, opts = {}) {
  const { includePath, excludePath, showProgress = true } = opts;
  idx._ensureFunctionIndex();

  const knownFunctions = idx._getKnownFunctions();

  const skipKw = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return',
    'sizeof', 'typeof', 'alignof', 'decltype',
    'defined', 'assert', 'static_assert',
    'elif', 'except', 'finally', 'with', 'else',
  ]);

  // Collect functions to scan
  let functionsToScan = [];

  if (functionName) {
    // Single function mode
    const matches = idx.findFunctionMatches(functionName);
    if (matches.length === 0) return { in_index: [], external: [], summary: { total_targets: 0, in_index_count: 0, external_count: 0, functions_scanned: 0 } };
    functionsToScan = [matches[0]];
  } else {
    // All functions mode
    for (const [filepath, funcs] of Object.entries(idx.functionIndex || {})) {
      if (includePath && !filepath.toLowerCase().includes(includePath.toLowerCase())) continue;
      if (excludePath && filepath.toLowerCase().includes(excludePath.toLowerCase())) continue;
      for (const [name, info] of Object.entries(funcs)) {
        if (info.type === 'class') continue;
        functionsToScan.push({ filepath, name, start: info.start, end: info.end });
      }
    }
  }

  // Track all call targets
  const inIndexMap = new Map();   // qualified_name -> {name, qualified_name, filepath, lines, callers: Set}
  const externalMap = new Map();  // bare_name -> {name, provenance, call_sites: []}

  const callPattern = /(?<![a-zA-Z_])([a-zA-Z_]\w*)\s*\(/g;
  let scanned = 0;

  for (const func of functionsToScan) {
    scanned++;
    if (showProgress && scanned % 1000 === 0) {
      process.stderr.write(`  Scanning: ${scanned}/${functionsToScan.length} functions...\r`);
    }

    const lines = idx.fileLines.get(func.filepath);
    if (!lines) continue;
    const bodyLines = lines.slice(func.start - 1, func.end);

    const callerName = func.name;
    let callerBare = callerName;
    if (callerBare.includes('::')) callerBare = callerBare.split('::').pop();
    else if (callerBare.includes('.')) callerBare = callerBare.split('.').pop();

    const callerClass = callerName.includes('::')
      ? callerName.split('::').slice(0, -1).join('::')
      : callerName.includes('.')
        ? callerName.split('.').slice(0, -1).join('.')
        : null;

    const seenInThisFunc = new Set();

    for (let i = 0; i < bodyLines.length; i++) {
      const line = bodyLines[i];
      const lineNum = func.start + i;
      const stripped = line.trimStart();
      if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*') || stripped.startsWith('#')) continue;

      callPattern.lastIndex = 0;
      let m;
      while ((m = callPattern.exec(line)) !== null) {
        const calleeName = m[1];
        if (skipKw.has(calleeName)) continue;
        if (calleeName === callerBare) continue;  // skip recursion
        if (calleeName.length < 2) continue;
        // Skip ALL_CAPS likely macros/constants
        if (/^[A-Z][A-Z0-9_]+$/.test(calleeName) && calleeName.length > 2) continue;
        if (seenInThisFunc.has(calleeName)) continue;
        seenInThisFunc.add(calleeName);

        if (calleeName in knownFunctions) {
          // IN INDEX
          const defs = knownFunctions[calleeName];
          const resolved = _resolveCalleeTarget(idx, 
            calleeName, line, callerClass, func.filepath, defs
          );
          const qName = resolved.resolvedName || calleeName;
          if (!inIndexMap.has(qName)) {
            const def = resolved.def;
            inIndexMap.set(qName, {
              name: calleeName,
              qualified_name: qName,
              filepath: def?.filepath || '',
              lines: def ? (def.end - def.start + 1) : 0,
              callers: new Set(),
            });
          }
          inIndexMap.get(qName).callers.add(callerName);
        } else {
          // EXTERNAL
          if (!externalMap.has(calleeName)) {
            externalMap.set(calleeName, {
              name: calleeName,
              provenance: guessProvenance(calleeName),
              call_sites: [],
            });
          }
          externalMap.get(calleeName).call_sites.push({
            caller: callerName,
            filepath: func.filepath,
            line: lineNum,
          });
        }
      }
    }
  }

  if (showProgress && functionsToScan.length > 100) {
    process.stderr.write(`  Scanned ${scanned} functions\n`);
  }

  // Convert to sorted arrays
  const inIndex = [...inIndexMap.values()]
    .map(e => ({ ...e, callers: [...e.callers].sort() }))
    .sort((a, b) => b.callers.length - a.callers.length || a.qualified_name.localeCompare(b.qualified_name));

  const external = [...externalMap.values()]
    .sort((a, b) => b.call_sites.length - a.call_sites.length || a.name.localeCompare(b.name));

  return {
    in_index: inIndex,
    external,
    summary: {
      total_targets: inIndex.length + external.length,
      in_index_count: inIndex.length,
      external_count: external.length,
      functions_scanned: scanned,
    },
  };
}

/**
 * Count how many times each function/identifier is called across the codebase.
 * @param {boolean} [showProgress=true]
 * @returns {Object<string, number>} name -> count, sorted descending
 */
export function getCallCounts(idx, showProgress = true) {
  // Return cached result if available (huge win for interactive mode)
  if (idx._callCountsCache) {
    if (showProgress) console.log('Using cached call counts.');
    return idx._callCountsCache;
  }

  if (!idx._ensureInvertedAvailable()) {
    console.log('No inverted index. Build index first.');
    return {};
  }
  if (showProgress) {
    console.error('Scanning for function calls...');
    if (idx._invertedOnDisk) {
      console.log('  (First scan streams from disk - may take 1-3 minutes for large indexes.');
      console.log('   Subsequent metrics commands will be instant.)');
    }
  }

  const simpleCall = /(?<![a-zA-Z_])(\w+)\s*\(/g;
  const qualifiedCall = /((?:\w+::)+\w+)\s*\(/g;
  const memberCall = /(?:\.|->\s*)(\w+)\s*\(/g;
  // Event handler registrations: addEventListener('event', handler)
  const eventHandler = /\.(?:addEventListener|on|once)\s*\(\s*['"][^'"]*['"]\s*,\s*([a-zA-Z_]\w*)\b/g;

  const skipKeywords = new Set([
    'if', 'while', 'for', 'switch', 'catch', 'return', 'sizeof',
    'typeof', 'defined', 'else', 'elif', 'except', 'finally',
    'alignof', 'decltype', 'noexcept', 'static_assert', 'throw',
    'new', 'delete', 'and', 'or', 'not', 'xor',
    'void', 'int', 'char', 'short', 'long', 'float', 'double',
    'unsigned', 'signed', 'bool', 'auto', 'register', 'extern',
    'static', 'const', 'volatile', 'inline', 'virtual',
    'byte', 'boolean', 'String',
    'Copyright', 'copyright', 'param', 'author',
  ]);

  const counts = Object.create(null);
  let linesScanned = 0;

  idx.forEachInvertedEntry((line, accessor) => {
    linesScanned++;
    const stripped = line.trimStart();
    if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*')) return;

    const strippedR = line.trimEnd();
    // Skip function definitions
    if (strippedR.endsWith('{')) {
      if (/^\s*[\w\s*&:~]+\s+\w+\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?(?:final\s*)?\{$/.test(strippedR)) return;
    }
    // Skip declarations
    if (strippedR.endsWith(';') && !line.includes('{')) {
      if (/^\s*[\w\s*&:~<>,]+\s+\w+\s*\([^)]*\)\s*;$/.test(strippedR)) return;
    }

    // Quick check: does this line contain any function call at all?
    if (!line.includes('(')) return;

    // Only now count occurrences (fast path, no full JSON parse)
    const totalLocations = accessor.count();

    // Qualified calls first
    let m;
    qualifiedCall.lastIndex = 0;
    while ((m = qualifiedCall.exec(line)) !== null) {
      const funcName = m[1];
      counts[funcName] = (counts[funcName] || 0) + totalLocations;
    }

    // Member calls
    memberCall.lastIndex = 0;
    while ((m = memberCall.exec(line)) !== null) {
      const funcName = m[1];
      if (!skipKeywords.has(funcName)) {
        counts[funcName] = (counts[funcName] || 0) + totalLocations;
      }
    }

    // Simple calls (skip if part of qualified/member)
    simpleCall.lastIndex = 0;
    while ((m = simpleCall.exec(line)) !== null) {
      const funcName = m[1];
      const pos = m.index;
      if (skipKeywords.has(funcName)) continue;
      if (pos >= 2 && line.slice(pos - 2, pos) === '::') continue;
      if (pos >= 1 && line[pos - 1] === '.') continue;
      if (pos >= 2 && line.slice(pos - 2, pos) === '->') continue;
      counts[funcName] = (counts[funcName] || 0) + totalLocations;
    }

    // Event handler registrations: handler name passed as callback argument
    eventHandler.lastIndex = 0;
    while ((m = eventHandler.exec(line)) !== null) {
      const funcName = m[1];
      if (!skipKeywords.has(funcName)) {
        counts[funcName] = (counts[funcName] || 0) + totalLocations;
      }
    }
  }, showProgress, true); // lazy=true: skip full JSON parse

  if (showProgress) {
    console.error(`Scanned ${linesScanned} unique lines, found ${Object.keys(counts).length} called identifiers`);
  }
  idx._callCountsCache = counts;
  return counts;
}


// ========================================================================
// Definition lookup
// ========================================================================

/**
 * Build a lookup table mapping bare function names to their definitions.
 * @returns {Object<string, Array>} bare_name -> [{filepath, full_name, start, end, lines, type}]
 */
export function _buildDefinitionLookup(idx) {
  idx._ensureFunctionIndex();
  const lookup = Object.create(null);

  for (const [filepath, functions] of Object.entries(idx.functionIndex || {})) {
    for (const [fullName, info] of Object.entries(functions)) {
      let bareName = info.base_name || fullName.split('::').pop();
      if (bareName.includes('@')) bareName = bareName.split('@')[0];

      const entry = {
        filepath, full_name: fullName,
        start: info.start, end: info.end,
        lines: info.end - info.start + 1,
        type: info.type || 'function',
      };

      if (!lookup[bareName]) lookup[bareName] = [];
      lookup[bareName].push(entry);

      // Also index by full qualified name
      if (fullName !== bareName && fullName.includes('::')) {
        if (!lookup[fullName]) lookup[fullName] = [];
        lookup[fullName].push(entry);
      }
    }
  }
  return lookup;
}

/**
 * Find all definitions of a function/method name.
 */
export function findDefinitions(idx, funcName, lookup = null) {
  if (!lookup) lookup = _buildDefinitionLookup(idx);
  const bareName = funcName.includes('::') ? funcName.split('::').pop() : funcName;
  if (funcName in lookup) return lookup[funcName];
  if (bareName in lookup) return lookup[bareName];
  return [];
}

/**
 * Get call counts with definition information.
 * @returns {Array<{name, count, definitions}>} sorted by count desc
 */
export function getCallCountsWithDefinitions(idx, showProgress = true) {
  const counts = idx.getCallCounts(showProgress);
  if (showProgress) console.log('Building definition lookup table...');
  const lookup = _buildDefinitionLookup(idx);
  if (showProgress) console.log(`Looking up definitions for ${Object.keys(counts).length} identifiers...`);

  const results = [];
  for (const [funcName, count] of Object.entries(counts)) {
    const defs = idx.findDefinitions(funcName, lookup);
    results.push({ name: funcName, count, definitions: defs });
  }
  results.sort((a, b) => b.count - a.count);
  return results;
}


// ========================================================================
// File-level dependency graph (bulk)
// ========================================================================

/**
 * Compute all file-to-file dependencies in a single pass.
 * @param {string|null} [pathFilter]
 * @param {boolean} [showProgress=true]
 * @returns {Object<string, Object<string, number>>} source -> {target -> count}
 */
export function getAllFileDeps(idx, pathFilter = null, showProgress = true) {
  idx._ensureFunctionIndex();
  const known = idx._getKnownFunctions();
  const callPattern = /(?<![a-zA-Z_])([a-zA-Z_]\w*)\s*\(/g;

  const skipKeywords = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return',
    'sizeof', 'typeof', 'defined', 'assert', 'raise',
    'print', 'new', 'delete', 'throw', 'elif', 'except',
    'lambda', 'yield', 'await', 'async',
    'open', 'close', 'read', 'write', 'run', 'get', 'set',
    'pop', 'push', 'put', 'add', 'remove', 'update', 'clear',
    'copy', 'keys', 'values', 'items', 'append', 'extend',
    'join', 'split', 'strip', 'replace', 'find', 'sort',
    'len', 'str', 'int', 'float', 'bool', 'list', 'dict',
    'tuple', 'type', 'range', 'map', 'filter', 'zip',
    'min', 'max', 'sum', 'any', 'all', 'abs', 'round',
    'format', 'repr', 'hash', 'id', 'vars', 'dir',
    'hasattr', 'getattr', 'setattr', 'isinstance', 'issubclass',
    'super', 'property', 'classmethod', 'staticmethod',
    'input', 'iter', 'next', 'enumerate', 'reversed', 'sorted',
    'malloc', 'free', 'calloc', 'realloc', 'memcpy', 'memset',
    'strcmp', 'strlen', 'strcpy', 'strcat', 'sprintf', 'fprintf',
    'printf', 'scanf', 'fopen', 'fclose', 'fread', 'fwrite',
    'exit', 'abort',
    'f', 'g', 'fn', 'cb', 'op', 'do',
  ]);

  const pathParts = (fp) => fp.replace(/\\/g, '/').toLowerCase().split('/');

  const bestTarget = (srcFp, calleeName) => {
    const defs = known[calleeName];
    if (!defs) return null;
    const candidates = defs.map(d => d.filepath).filter(fp => fp !== srcFp);
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const srcDir = pathParts(srcFp).slice(0, -1);
    let best = null, bestScore = -1;
    for (const tgtFp of candidates) {
      const tgtDir = pathParts(tgtFp).slice(0, -1);
      let shared = 0;
      for (let i = 0; i < Math.min(srcDir.length, tgtDir.length); i++) {
        if (srcDir[i] === tgtDir[i]) shared++;
        else break;
      }
      if (shared > bestScore) { bestScore = shared; best = tgtFp; }
    }
    return best;
  };

  const targetCache = new Map();
  let filesWithFuncs = Object.keys(idx.functionIndex || {})
    .filter(fp => idx.fileLines.has(fp));
  if (pathFilter) {
    const pf = pathFilter.replace(/\\/g, '/').toLowerCase();
    filesWithFuncs = filesWithFuncs.filter(fp => fp.replace(/\\/g, '/').toLowerCase().includes(pf));
  }

  const total = filesWithFuncs.length;
  const fileDeps = {};
  const selfCallRe = /(?:self|this)\s*(?:\.|->\s*)([a-zA-Z_]\w*)\s*\(/g;

  // Loop counter renamed from `idx` to `i` to avoid shadowing the `idx`
  // parameter (CodeSearchIndex instance) declared by getAllFileDeps. The
  // shadow was a pre-existing latent bug: `idx.fileLines.get(...)` below
  // would call .fileLines on the loop counter (a number) rather than on
  // the index instance. Wasn't exercised on tiny indexes (n < 50) where
  // the loop never iterated enough to reach the shadowing read.
  for (let i = 0; i < filesWithFuncs.length; i++) {
    const srcFp = filesWithFuncs[i];
    if (showProgress && (i + 1) % 50 === 0) {
      eprint(`  ... ${i + 1}/${total} files`);
    }

    const deps = {};
    const lines = idx.fileLines.get(srcFp);

    // Local functions (same-file)
    const localFuncs = new Set();
    for (const fname of Object.keys(idx.functionIndex[srcFp] || {})) {
      let bare = fname.includes('::') ? fname.split('::').pop() : fname;
      bare = bare.includes('.') ? bare.split('.').pop() : bare;
      localFuncs.add(bare);
    }

    for (const line of lines) {
      const stripped = line.trimStart();
      if (stripped.startsWith('//') || stripped.startsWith('*') || stripped.startsWith('/*') || stripped.startsWith('#')) continue;

      // Collect self/this calls to skip
      const selfCalls = new Set();
      let sm;
      selfCallRe.lastIndex = 0;
      while ((sm = selfCallRe.exec(line)) !== null) {
        selfCalls.add(sm[1]);
      }

      callPattern.lastIndex = 0;
      let m;
      while ((m = callPattern.exec(line)) !== null) {
        const callee = m[1];
        if (skipKeywords.has(callee)) continue;
        if (!(callee in known)) continue;
        if (selfCalls.has(callee)) continue;
        if (localFuncs.has(callee)) continue;

        // #251: key by the SOURCE file, not the index object — `${idx}`
        // stringified to a constant `[object Object]`, so the cache collapsed to
        // `callee` alone and returned the first source file's target for every
        // file sharing a callee name → wrong file-dependency edges.
        const cacheKey = `${srcFp}:${callee}`;
        if (!targetCache.has(cacheKey)) {
          targetCache.set(cacheKey, bestTarget(srcFp, callee));
        }
        const tgtFp = targetCache.get(cacheKey);
        if (tgtFp) {
          deps[tgtFp] = (deps[tgtFp] || 0) + 1;
        }
      }
    }

    if (Object.keys(deps).length > 0) {
      fileDeps[srcFp] = deps;
    }
  }

  return fileDeps;
}
