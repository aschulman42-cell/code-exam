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

export function doPromptCatalog(index, args) {
  index._ensureFunctionIndex();
  const filter = args.filter || null;
  const maxResults = args.max_results || 999;
  const verbose = args.verbose || false;

  const prompts = [];

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

      // --- Pattern 5: build*Prompt function (capture the function body for context) ---
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

  // Output
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
    console.log('═'.repeat(72));
    console.log(`PROMPT [${idx}]  ${shortPath}:L${p.lineNum}`);
    if (p.varName) console.log(`  Variable/property: ${p.varName}`);
    console.log(`  Function: ${funcLabel}`);
    console.log(`  Type: ${p.type}`);
    if (p.type !== 'prompt-builder-function') {
      console.log(`  --extract ${p.filepath}@${p.func || '(file scope)'}`);
    }
    console.log('─'.repeat(72));
    // Full text — no truncation per user requirement
    console.log(p.text);
    console.log();
  }

  if (prompts.length > maxResults) {
    console.log(`\n  Showing ${maxResults} of ${prompts.length}. Use --max-results ${prompts.length} for all.`);
  }
}
