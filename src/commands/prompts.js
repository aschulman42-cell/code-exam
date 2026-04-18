/**
 * prompts.js — --prompt-catalog
 *
 * Scan indexed source files for LLM prompt text: system prompts, user prompts,
 * instruction strings, agent descriptions, role-based messages. Emit a
 * complete catalog with FULL text (no truncation) so the user can grep for
 * keywords and find relevant prompts without knowing function names first.
 *
 * Detection heuristics (ordered by confidence):
 *
 *   VERY HIGH:
 *     - String literal starting with "You are " / "You're a " (system-prompt
 *       opening used by virtually every LLM application)
 *     - getSystemPrompt property/method declaration (agent-framework pattern)
 *     - systemPrompt: property assignment in an object literal
 *
 *   HIGH:
 *     - role: "system" + nearby content: with a string (standard LLM API)
 *     - Template literal starting with imperative LLM-instruction phrases
 *       ("Your task", "Your role", "Instructions:", "Analyze the", "Given the
 *       following", "As an AI", "I want you to", "Please analyze")
 *
 *   MEDIUM:
 *     - Variable/const named *prompt* or *instruction* assigned to a long string
 *     - Function named build*Prompt / make*Prompt / format*Prompt
 *
 * Multi-line extraction: when a prompt-indicator line is found, scan forward
 * for the closing quote/backtick to capture the complete template literal.
 * Stored separately from the string table (no truncation).
 */

/**
 * Extract the full string literal starting at `startCol` on `startLine`,
 * possibly spanning multiple lines (template literals). Returns the text
 * content (without surrounding quotes) and the end line index.
 *
 * @param {string[]} lines — file lines array
 * @param {number} lineIdx — 0-indexed line where the string starts
 * @param {number} startCol — column of the opening quote/backtick
 * @returns {{ text: string, endLineIdx: number }}
 */
function _extractFullString(lines, lineIdx, startCol) {
  const line = lines[lineIdx] || '';
  const quoteChar = line[startCol];
  if (!quoteChar || (quoteChar !== '"' && quoteChar !== "'" && quoteChar !== '`')) {
    return { text: '', endLineIdx: lineIdx };
  }

  // For regular quotes: scan to closing quote on the same line
  if (quoteChar !== '`') {
    let i = startCol + 1;
    let text = '';
    while (i < line.length) {
      if (line[i] === '\\' && i + 1 < line.length) { text += line[i + 1]; i += 2; continue; }
      if (line[i] === quoteChar) return { text, endLineIdx: lineIdx };
      text += line[i];
      i++;
    }
    return { text, endLineIdx: lineIdx };
  }

  // Template literal: scan across lines until closing backtick
  const parts = [];
  let li = lineIdx;
  let ci = startCol + 1;
  const MAX_LINES = 500; // safety cap
  while (li < lines.length && li - lineIdx < MAX_LINES) {
    const l = lines[li] || '';
    let i = ci;
    while (i < l.length) {
      if (l[i] === '\\' && i + 1 < l.length) { parts.push(l[i + 1]); i += 2; continue; }
      if (l[i] === '`') return { text: parts.join(''), endLineIdx: li };
      parts.push(l[i]);
      i++;
    }
    parts.push('\n');
    li++;
    ci = 0;
  }
  return { text: parts.join(''), endLineIdx: li };
}

/**
 * Find the column position of a prompt-starting pattern on a line.
 * Returns the column of the opening quote, or -1 if not found.
 */
function _findPromptStringStart(line) {
  // Look for quote/backtick followed by a prompt-indicator phrase
  const patterns = [
    /["'`]You are /,
    /["'`]You're a /,
    /["'`]Your task /,
    /["'`]Your role /,
    /["'`]As an AI/,
    /["'`]As a /,
    /["'`]I want you to /,
    /["'`]Instructions:/,
    /["'`]Analyze the /,
    /["'`]Given the following/,
    /["'`]Please analyze/,
    /["'`]Respond with/,
    /["'`]Answer the following/,
    /["'`]The user will /,
    /["'`]Below is /,
    /["'`]Here is /,
  ];
  for (const re of patterns) {
    const m = line.match(re);
    if (m) return m.index;
  }
  return -1;
}

// Filenames that are ALWAYS prompts by convention — regardless of whether
// any code references them. These are the well-known names used by agent
// frameworks (Claude Code skills, OpenClaw souls, Codex plugins, etc.).
const PROMPT_FILE_NAMES = new Set([
  'skill.md', 'soul.md', 'system_prompt.md', 'systemprompt.md',
  'prompt.md', 'system-prompt.md', 'instructions.md',
  'personality.md', 'persona.md', 'agent.md',
  'claude.md',  // Claude Code project instructions
]);

export function collectPrompts(index, { filter = null } = {}) {
  index._ensureFunctionIndex();

  const prompts = [];

  // ── Phase 0: Convention-named .md files (SKILL.md, SOUL.md, etc.) ──
  // These are prompts by DEFINITION — agent skill definitions, persona
  // documents, system-prompt files. No code reference needed.
  // Also detects .md files with YAML frontmatter containing prompt-like
  // fields (title, description, tags).
  for (const [filepath, fileLines] of index.fileLines) {
    const basename = filepath.replace(/\\/g, '/').split('/').pop().toLowerCase();
    const isPromptFile = PROMPT_FILE_NAMES.has(basename);
    // Also check: .md file in a prompt-convention directory path
    // (skills/, agents/, prompts/, souls/, personalities/).
    // General YAML-frontmatter .md files are NOT included — too many
    // false positives from regular documentation with frontmatter.
    const normPath = filepath.replace(/\\/g, '/').toLowerCase();
    const inPromptDir = basename.endsWith('.md') && (
      /\/skills\//.test(normPath) ||
      /\/agents\//.test(normPath) ||
      /\/prompts\//.test(normPath) ||
      /\/souls\//.test(normPath) ||
      /\/personalities\//.test(normPath)
    );

    if (isPromptFile || inPromptDir) {
      const fullText = fileLines.join('\n');
      // Skip tiny files (< 50 chars) — probably empty or stub
      if (fullText.length < 50) continue;

      const entry = {
        type: isPromptFile ? 'prompt-file' : 'md-in-prompt-dir',
        filepath,
        lineNum: 1,
        endLine: fileLines.length,
        varName: basename,
        func: null,
        funcDisplay: null,
        text: fullText,
      };

      if (filter) {
        const pat = filter.toLowerCase();
        const haystack = (entry.text + ' ' + filepath).toLowerCase();
        if (!haystack.includes(pat)) continue;
      }
      prompts.push(entry);
    }
  }

  // ── Phase 1+: Code-level prompt detection (existing patterns) ──
  for (const [filepath, fileLines] of index.fileLines) {
    const funcBounds = index._getFuncBoundaries(filepath);

    for (let lineIdx = 0; lineIdx < fileLines.length; lineIdx++) {
      const line = fileLines[lineIdx];
      const lineNum = lineIdx + 1;
      let detected = null;

      // --- Pattern 1: String literal starting with prompt phrase ---
      const promptCol = _findPromptStringStart(line);
      if (promptCol >= 0) {
        const { text, endLineIdx } = _extractFullString(fileLines, lineIdx, promptCol);
        if (text.length > 20) {
          // Try to find variable name: look for `VAR = ` or `VAR: ` before the quote
          const prefix = line.slice(0, promptCol).trim();
          let varName = null;
          const assignMatch = prefix.match(/(?:(?:const|let|var)\s+)?(\w[\w$]*)\s*[=:]?\s*$/);
          if (assignMatch) varName = assignMatch[1];
          const containingFunc = index._findContainingFunctionFromBounds
            ? index._findContainingFunctionFromBounds(funcBounds, lineNum)
            : null;
          detected = {
            type: 'string-literal',
            filepath, lineNum,
            endLine: endLineIdx + 1,
            varName,
            func: containingFunc,
            text,
          };
        }
      }

      // --- Pattern 1b: Prompt phrase at line start after backtick on prev line ---
      // Catches template literals where the opening backtick and the "You are"
      // text are on DIFFERENT lines due to `\` continuation:
      //   const PROMPT = `\
      //   You are a patent-claim keyword extractor...
      if (!detected && lineIdx > 0) {
        const trimmed = line.trimStart();
        if (/^You are |^You're a |^Your task |^Your role |^As an AI|^As a /.test(trimmed)) {
          // Check if previous line ends with a backtick (possibly followed
          // by \ line continuation). Use lastIndexOf instead of endsWith to
          // avoid escaping headaches with backtick+backslash combos.
          const prevTrimmed = (fileLines[lineIdx - 1] || '').trimEnd();
          const lastBt = prevTrimmed.lastIndexOf('`');
          if (lastBt >= 0 && lastBt >= prevTrimmed.length - 2) {
            const btCol = fileLines[lineIdx - 1].lastIndexOf('`');
            if (btCol >= 0) {
              const { text, endLineIdx } = _extractFullString(fileLines, lineIdx - 1, btCol);
              if (text.length > 20) {
                const prevPrefix = fileLines[lineIdx - 1].slice(0, btCol).trim();
                let varName = null;
                const assignMatch = prevPrefix.match(/(?:(?:const|let|var)\s+)?(\w[\w$]*)\s*[=:]?\s*$/);
                if (assignMatch) varName = assignMatch[1];
                const containingFunc = index._findContainingFunctionFromBounds
                  ? index._findContainingFunctionFromBounds(funcBounds, lineNum)
                  : null;
                detected = {
                  type: 'string-literal',
                  filepath, lineNum: lineIdx, // prev line where backtick is
                  endLine: endLineIdx + 1,
                  varName,
                  func: containingFunc,
                  text,
                };
              }
            }
          }
        }
      }

      // --- Pattern 1c: Variable named *PROMPT* or *INSTRUCTION* assigned to a string ---
      // Catches named prompt constants like _CLAIM_EXTRACTION_PROMPT even when
      // the string content doesn't start with a recognized phrase.
      if (!detected) {
        const promptVarMatch = line.match(/(?:const|let|var)\s+(\w*(?:PROMPT|INSTRUCTION|SYSTEM_MSG)\w*)\s*=\s*(["'`])/);
        if (promptVarMatch) {
          const varName = promptVarMatch[1];
          const quoteChar = promptVarMatch[2];
          const quoteCol = line.indexOf(quoteChar, promptVarMatch.index + promptVarMatch[0].length - 1);
          if (quoteCol >= 0) {
            const { text, endLineIdx } = _extractFullString(fileLines, lineIdx, quoteCol);
            if (text.length > 30) {
              const containingFunc = index._findContainingFunctionFromBounds
                ? index._findContainingFunctionFromBounds(funcBounds, lineNum)
                : null;
              detected = {
                type: 'named-prompt-var',
                filepath, lineNum,
                endLine: endLineIdx + 1,
                varName,
                func: containingFunc,
                text,
              };
            }
          }
        }
      }

      // --- Pattern 2: getSystemPrompt declaration ---
      if (!detected) {
        const gspMatch = line.match(/getSystemPrompt\s*(?::\s*\(.*?\)\s*=>|=\s*(?:function|\())/);
        if (gspMatch) {
          // Look for the template literal / string in this or next few lines
          let promptText = null;
          let endLine = lineIdx;
          for (let j = lineIdx; j < Math.min(lineIdx + 5, fileLines.length); j++) {
            const col = fileLines[j].indexOf('`');
            if (col >= 0) {
              const extracted = _extractFullString(fileLines, j, col);
              promptText = extracted.text;
              endLine = extracted.endLineIdx;
              break;
            }
            const dqCol = fileLines[j].indexOf('"You ');
            if (dqCol >= 0) {
              const extracted = _extractFullString(fileLines, j, dqCol);
              promptText = extracted.text;
              endLine = extracted.endLineIdx;
              break;
            }
          }
          if (promptText && promptText.length > 20) {
            const containingFunc = index._findContainingFunctionFromBounds
              ? index._findContainingFunctionFromBounds(funcBounds, lineNum)
              : null;
            detected = {
              type: 'getSystemPrompt',
              filepath, lineNum,
              endLine: endLine + 1,
              varName: 'getSystemPrompt',
              func: containingFunc,
              text: promptText,
            };
          }
        }
      }

      // --- Pattern 3: systemPrompt: property ---
      if (!detected) {
        const spMatch = line.match(/systemPrompt\s*:/);
        if (spMatch) {
          // Look for the string value on this line or next
          let promptText = null;
          let endLine = lineIdx;
          for (let j = lineIdx; j < Math.min(lineIdx + 3, fileLines.length); j++) {
            const l = fileLines[j];
            // Look for Qq(["..."]) wrapper or direct string
            const qqMatch = l.match(/Qq\s*\(\s*\[\s*["'`]/);
            if (qqMatch) {
              const qCol = l.indexOf('"', qqMatch.index + qqMatch[0].length - 1);
              const bCol = l.indexOf('`', qqMatch.index + qqMatch[0].length - 1);
              const sCol = l.indexOf("'", qqMatch.index + qqMatch[0].length - 1);
              const candidates = [qCol, bCol, sCol].filter(c => c >= 0);
              if (candidates.length > 0) {
                const col = Math.min(...candidates);
                const extracted = _extractFullString(fileLines, j, col);
                promptText = extracted.text;
                endLine = extracted.endLineIdx;
              }
              break;
            }
            // Direct string
            for (const q of ['`', '"', "'"]) {
              const idx = l.indexOf(q + 'You ');
              if (idx >= 0) {
                const extracted = _extractFullString(fileLines, j, idx);
                promptText = extracted.text;
                endLine = extracted.endLineIdx;
                break;
              }
            }
            if (promptText) break;
          }
          if (promptText && promptText.length > 20) {
            const containingFunc = index._findContainingFunctionFromBounds
              ? index._findContainingFunctionFromBounds(funcBounds, lineNum)
              : null;
            detected = {
              type: 'systemPrompt-property',
              filepath, lineNum,
              endLine: endLine + 1,
              varName: 'systemPrompt',
              func: containingFunc,
              text: promptText,
            };
          }
        }
      }

      // --- Pattern 4: role: "system" with nearby content ---
      if (!detected) {
        if (/role\s*:\s*["']system["']/.test(line)) {
          // Search nearby (this line + next 5) for content: "..."
          for (let j = lineIdx; j < Math.min(lineIdx + 6, fileLines.length); j++) {
            const contentMatch = fileLines[j].match(/content\s*:\s*(["'`])/);
            if (contentMatch) {
              const col = fileLines[j].indexOf(contentMatch[1], contentMatch.index + contentMatch[0].length - 1);
              if (col >= 0) {
                const extracted = _extractFullString(fileLines, j, col);
                if (extracted.text.length > 20) {
                  const containingFunc = index._findContainingFunctionFromBounds
                    ? index._findContainingFunctionFromBounds(funcBounds, lineNum)
                    : null;
                  detected = {
                    type: 'role-system-message',
                    filepath, lineNum,
                    endLine: extracted.endLineIdx + 1,
                    varName: null,
                    func: containingFunc,
                    text: extracted.text,
                  };
                  break;
                }
              }
            }
          }
        }
      }

      // --- Pattern 5: Long template/string literal with instruction vocabulary ---
      // Catches prompts that don't start with "You are" but contain
      // imperative instruction keywords stacked together. E.g., tool
      // descriptions ("CRITICAL REQUIREMENT - You MUST follow this"),
      // capability listings, rules blocks, etc.
      if (!detected) {
        const backtickCol = line.indexOf('`');
        const dquoteCol = line.indexOf('"');
        // Only trigger on lines that START a string (opening quote not
        // preceded by another string character), and only template
        // literals or long quoted strings.
        let checkCol = -1;
        if (backtickCol >= 0) checkCol = backtickCol;
        else if (dquoteCol >= 0 && line.indexOf('"', dquoteCol + 1) < 0) {
          // Opening double-quote without a close on the same segment —
          // not a complete short string. Skip; too ambiguous.
        }
        if (checkCol >= 0 && line[checkCol] === '`') {
          const { text, endLineIdx } = _extractFullString(fileLines, lineIdx, checkCol);
          if (text.length > 200) {
            // Reject if text starts with code-like tokens — means we
            // captured at a template-literal CLOSE backtick, not an OPEN.
            // Use a whitelist: real prompts start with a letter, #, -, *,
            // digit, or quote. Anything else (operators, brackets, etc.)
            // is code continuation from a misidentified backtick.
            const trimText = text.trimStart();
            if (!/^[a-zA-Z#\-*0-9"']/.test(trimText)) {
              // Not a prompt — code continuation
            } else {
            // Count instruction-indicator keywords (case-insensitive)
            const lower = text.toLowerCase();
            const INSTRUCTION_KEYWORDS = [
              'critical', 'must', 'mandatory', 'requirement', 'important',
              'never', 'always', 'prohibited', 'forbidden', 'required',
              'strictly', 'ensure', 'you must', 'you should', 'do not',
              "don't", 'instructions', 'guidelines', 'rules', 'avoid',
              'careful', 'security', 'vulnerabilities',
              'if you', 'unless', 'prefer', 'instead', 'certain',
            ];
            let hits = 0;
            for (const kw of INSTRUCTION_KEYWORDS) {
              if (lower.includes(kw)) hits++;
            }
            if (hits >= 3) {
              const prefix = line.slice(0, checkCol).trim();
              let varName = null;
              const assignMatch = prefix.match(/(?:(?:const|let|var)\s+)?(\w[\w$]*)\s*[=:]?\s*$/);
              if (assignMatch) varName = assignMatch[1];
              // Check if this is a return statement (function IS the prompt)
              if (!varName && /return\s*$/.test(prefix)) varName = '(return value)';
              const containingFunc = index._findContainingFunctionFromBounds
                ? index._findContainingFunctionFromBounds(funcBounds, lineNum)
                : null;
              detected = {
                type: 'instruction-string',
                filepath, lineNum,
                endLine: endLineIdx + 1,
                varName,
                func: containingFunc,
                text,
              };
            }
            } // end else (non-code-starting text)
          }
        }
      }

      // --- Pattern 5b: Long double/single-quoted strings with instruction vocab ---
      // Catches prompt strings stored in arrays or as regular string literals.
      // Runs INDEPENDENTLY of other patterns — a single prettified line can
      // contain an ARRAY of instruction strings (ip9 puts 10+ prompts on one
      // line), and we need to capture ALL of them, not just the first.
      // Each match pushes directly to `prompts` rather than using `detected`.
      {
        const INSTRUCTION_KW_5B = [
          'critical', 'must', 'mandatory', 'requirement', 'important',
          'never', 'always', 'prohibited', 'forbidden', 'required',
          'strictly', 'ensure', 'you must', 'you should', 'do not',
          "don't", 'instructions', 'guidelines', 'rules', 'avoid',
          'careful', 'security', 'vulnerabilities',
          'if you', 'unless', 'prefer', 'instead', 'certain',
        ];
        const dqRe = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
        let dqMatch;
        while ((dqMatch = dqRe.exec(line)) !== null) {
          const content = dqMatch[1] !== undefined ? dqMatch[1] : dqMatch[2];
          if (!content || content.length < 150) continue;
          // Same whitelist as Pattern 5: letters, #, -, *, digits, quotes
          if (!/^[A-Za-z#\-*0-9"']/.test(content)) continue;
          const lower = content.toLowerCase();
          let hits = 0;
          for (const kw of INSTRUCTION_KW_5B) {
            if (lower.includes(kw)) hits++;
          }
          // Two acceptance paths:
          //   (a) ≥2 instruction keywords — imperative prompts ("you must", "avoid", etc.)
          //   (b) ≥300 chars with markdown headers — persona/soul docs, README-style
          //       prompts, structured documentation used as system prompts
          const hasMarkdownHeaders = content.length > 300 &&
            /\\n#|^#/.test(content);
          if (hits >= 2 || hasMarkdownHeaders) {
            const containingFunc = index._findContainingFunctionFromBounds
              ? index._findContainingFunctionFromBounds(funcBounds, lineNum)
              : null;
            let funcDisplay = containingFunc;
            if (funcDisplay && index.getDisplayName) funcDisplay = index.getDisplayName(funcDisplay);
            const entry = {
              type: hasMarkdownHeaders && hits < 2 ? 'persona-document' : 'instruction-string',
              filepath, lineNum,
              endLine: lineNum,
              varName: null,
              func: containingFunc,
              funcDisplay,
              text: content.replace(/\\n/g, '\n').replace(/\\t/g, '\t'),
            };
            if (filter) {
              const pat = filter.toLowerCase();
              const haystack = (entry.text + ' ' + (entry.func || '')).toLowerCase();
              if (!haystack.includes(pat)) continue;
            }
            prompts.push(entry);
          }
        }
      }

      // --- Pattern 6: build*Prompt function name (note, don't extract body) ---
      if (!detected) {
        const buildMatch = line.match(/(?:function\s+|(?:const|let|var)\s+)(build\w*[Pp]rompt|make\w*[Pp]rompt|format\w*[Pp]rompt|get\w*[Pp]rompt)\s*[=(]/);
        if (buildMatch) {
          const funcName = buildMatch[1];
          // Don't extract body here — just note the function exists
          // The user can --extract it
          detected = {
            type: 'prompt-builder-function',
            filepath, lineNum,
            endLine: lineNum,
            varName: funcName,
            func: funcName,
            text: `(prompt-builder function — use --extract ${filepath}@${funcName} to see full body)`,
          };
        }
      }

      if (detected) {
        // Apply display-name renames to the containing function name
        if (detected.func && index.getDisplayName) {
          detected.funcDisplay = index.getDisplayName(detected.func);
        }

        // Apply text filter
        if (filter) {
          const pat = filter.toLowerCase();
          const haystack = (detected.text + ' ' + (detected.varName || '') + ' ' + (detected.func || '')).toLowerCase();
          if (!haystack.includes(pat)) {
            detected = null;
          }
        }
      }

      if (detected) {
        prompts.push(detected);
        // Skip to end of this prompt's text to avoid double-detecting
        if (detected.endLine > lineNum) {
          lineIdx = detected.endLine - 1; // -1 because the for loop increments
        }
      }
    }
  }

  // Sort by filepath then line number
  prompts.sort((a, b) => a.filepath.localeCompare(b.filepath) || a.lineNum - b.lineNum);

  return prompts;
}

export function doPromptCatalog(index, args) {
  const filter = args.filter || null;
  // Use a high default for prompt-catalog specifically — the global
  // max_results default (20) is too low for a "dump everything" command.
  // Only respect max_results if the user explicitly passed --max-results.
  const maxResults = args._explicit?.has('max_results') ? args.max_results : 9999;

  const prompts = collectPrompts(index, { filter });

  if (prompts.length === 0) {
    console.log('No prompts detected in the index.');
    console.log('(Detection looks for: "You are..." system prompts, getSystemPrompt, systemPrompt: properties,');
    console.log(' role:"system" messages, and build*Prompt functions.)');
    return;
  }

  const showing = Math.min(maxResults, prompts.length);
  console.log(`\nPrompt catalog: ${prompts.length} prompts detected` +
    (filter ? ` (filter: "${filter}")` : '') +
    (showing < prompts.length ? ` (showing ${showing})` : '') + '\n');

  let idx = 0;
  for (const p of prompts.slice(0, maxResults)) {
    idx++;
    const shortPath = p.filepath.length > 60 ? '…' + p.filepath.slice(-59) : p.filepath;
    const funcLabel = p.funcDisplay || p.func || '(file scope)';
    console.log('='.repeat(72));
    console.log(`PROMPT [${idx}]  ${shortPath}:L${p.lineNum}`);
    if (p.varName) console.log(`  Variable/property: ${p.varName}`);
    console.log(`  Function: ${funcLabel}`);
    console.log(`  Type: ${p.type}`);
    if (p.type !== 'prompt-builder-function') {
      console.log(`  --extract ${p.filepath}@${p.func || '(file scope)'}`);
    }
    console.log('-'.repeat(72));
    // Full text — no truncation per user requirement
    console.log(p.text);
    console.log();
  }

  if (prompts.length > maxResults) {
    console.log(`\n  Showing ${maxResults} of ${prompts.length}. Use --max-results ${prompts.length} for all.`);
  }
}
