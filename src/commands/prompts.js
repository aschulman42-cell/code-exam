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

export async function collectPrompts(index, { filter = null, expandComposites = true } = {}) {
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
            // Whitelist: real prompts start with a letter, #, -, *, digit,
            // quote, or `$` (template interpolation — `${preamble}\n...` is
            // a valid prompt-building pattern where a locally-assigned
            // variable supplies the opening content).
            if (!/^[a-zA-Z#\-*0-9"'$]/.test(trimText)) {
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
            // Structured-prompt signal: multiple ALL-CAPS colon headers
            // ("TASK:", "SOURCE FILE:", "PATENT CLAIM TEXT:", "CRITICAL
            // INSTRUCTIONS:"). Real code rarely uses this pattern outside of
            // LLM prompts and ad-hoc docs — catches build*Prompt return
            // templates where only two instruction keywords appear but the
            // structural evidence is unmistakable.
            const allCapsHeaders = (text.match(/\b[A-Z][A-Z _]{3,}:/g) || []).length;
            if (hits >= 3 || (hits >= 1 && allCapsHeaders >= 2) || allCapsHeaders >= 3) {
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

  // Composite expansion: when a detected prompt is one branch of a ternary,
  // `||`/`??` default, `+` concatenation, or `${…}` interpolation in a
  // template string, collect the sibling string-literal branches and merge
  // them into one entry with visible separators. Handles the common
  // masked-vs-unmasked pattern in CodeExam's own claim.js. JS/TS only —
  // other languages keep their original single-branch entries.
  const afterExpand = expandComposites
    ? await _expandCompositePrompts(index, prompts)
    : prompts;

  // Drop anything the detectors picked up that doesn't actually read like a
  // prompt — keyword lists, inline code/data literals, oversize blobs that
  // happen to contain a trigger word or two.
  const filtered = afterExpand.filter(p => !_looksLikeNonPrompt(p.text));

  // Sort by filepath then line number
  filtered.sort((a, b) => a.filepath.localeCompare(b.filepath) || a.lineNum - b.lineNum);

  return filtered;
}

// Hard upper bound on prompt text — longer than every realistic system prompt
// I've seen (Claude Code's skill-bundling prompts top out around 18K).
const PROMPT_MAX_CHARS = 50000;

// Characters that, when they appear at the start of detected text, strongly
// suggest the match is a code/data fragment rather than a prompt. `#` is
// deliberately NOT here — markdown-style prompts legitimately begin with it.
const PROMPT_BAD_START = new Set(['}', ',', ')', ']', ':', ';', '.', '|', '=', '{', '[', '(']);

function _looksLikeNonPrompt(text) {
  if (!text) return true;
  if (text.length > PROMPT_MAX_CHARS) return true;

  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed) return true;
  if (PROMPT_BAD_START.has(trimmed[0])) return true;

  // Keyword-list detector: long single-line text where most tokens are short
  // identifier-shaped words with no sentence punctuation. Examples caught:
  //   "abs accTime acos action ..." (237 GameMaker built-ins)
  //   "self other all noone global ..." (GML scope tokens)
  if (!/[\n\r]/.test(trimmed) && trimmed.length > 200) {
    const tokens = trimmed.split(/\s+/);
    if (tokens.length >= 20) {
      let shortCount = 0;
      for (const t of tokens) if (t.length <= 4) shortCount++;
      const hasSentencePunct = /[.!?](\s|$)/.test(trimmed);
      if (shortCount / tokens.length > 0.8 && !hasSentencePunct) return true;
    }
  }
  return false;
}


export async function doPromptCatalog(index, args) {
  const filter = args.filter || null;
  // Use a high default for prompt-catalog specifically — the global
  // max_results default (20) is too low for a "dump everything" command.
  // Only respect max_results if the user explicitly passed --max-results.
  const maxResults = args._explicit?.has('max_results') ? args.max_results : 9999;

  const prompts = await collectPrompts(index, { filter });

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


// ============================================================================
// Composite-prompt expansion
// ----------------------------------------------------------------------------
// When a detected prompt literal is actually a branch of a larger expression
// (ternary, `||`/`??` default, `+` concatenation, `${…}` template
// interpolation), the caller probably wants ALL branches together so the
// composite text can be grep'd as one unit. Without this, `cond ? "A" : "B"`
// shows up as two separate catalog entries, each missing half the content.
//
// JS/TS only — uses tree-sitter.
// ============================================================================

const _EXPANSION_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

// Separator that appears between branches of an expanded composite. Distinct
// enough that users can spot it in rendered text or grep for it.
const BRANCH_SEP = '\n\n⟨—— BRANCH VARIANT ——⟩\n\n';

async function _expandCompositePrompts(index, prompts) {
  // Bail early if nothing to expand or no JS/TS files touched.
  const jsPrompts = prompts.filter(p => {
    const ext = (p.filepath.match(/\.\w+$/) || [''])[0].toLowerCase();
    return _EXPANSION_EXTS.has(ext);
  });
  if (jsPrompts.length === 0) return prompts;

  let TreeSitterParser;
  try {
    ({ TreeSitterParser } = await import('../core/TreeSitterParser.js'));
  } catch (_e) {
    return prompts;  // tree-sitter not available — leave prompts as-is
  }
  const tsParser = new TreeSitterParser();
  const initOk = await tsParser.init();
  if (!initOk) return prompts;

  // Group prompts by file so we parse each file at most once.
  const byFile = new Map();
  for (const p of jsPrompts) {
    if (!byFile.has(p.filepath)) byFile.set(p.filepath, []);
    byFile.get(p.filepath).push(p);
  }

  // Collect indices of prompts to replace/remove. We keep non-JS prompts and
  // JS prompts that aren't composite; JS prompts that ARE composite get
  // merged into a single new entry per composite expression.
  const toRemove = new Set();   // indices into `prompts`
  const mergedEntries = [];     // new composite entries
  const promptIndex = new Map(); // prompt -> original index
  prompts.forEach((p, i) => promptIndex.set(p, i));

  for (const [filepath, filePrompts] of byFile) {
    const fileLines = index.fileLines.get(filepath);
    if (!fileLines) continue;
    const tree = await _parseFileForExpansion(tsParser, filepath, fileLines);
    if (!tree) continue;
    try {
      // Seen-set tracks composite-expression nodes we've already processed so
      // two sibling branches don't both spawn a separate merged entry. A
      // second set tracks functions we've fully handled via return-array-join
      // assembly — the whole function becomes one merged entry and any
      // individually-detected prompts inside it are subsumed.
      const seenComposites = new Set();
      const handledFunctions = new Set();

      for (const prompt of filePrompts) {
        // Find the string-like AST node at the prompt's declared position.
        const targetRow = prompt.lineNum - 1;
        const stringNode = _findStringNodeAt(tree.rootNode, targetRow, prompt.text);
        if (!stringNode) continue;

        // FUNCTION-LEVEL FIRST: if this prompt lives inside a function whose
        // return is `<array-literal>.join(<sep>)`, treat the whole return
        // expression as the "real" prompt and collapse any sibling prompts
        // inside the same function into one merged entry. This handles the
        // common prompt-builder pattern where an environment or system prompt
        // is assembled piece-by-piece from locals then stitched together
        // (cli.js's v44 / buildEnvironmentPrompt is the canonical example).
        const funcNode = _findEnclosingFunction(stringNode);
        if (funcNode && !handledFunctions.has(funcNode.id)) {
          const fnScope = _buildLocalStringMap(funcNode);
          const fnUsed = new Set();
          const assembled = _tryExpandReturnArrayJoin(funcNode, fnScope, fnUsed);
          // Require more content than the detected prompt alone — a trivial
          // helper like `return [a, b].join(',')` wouldn't beat the already-
          // detected string's length.
          if (assembled && assembled.length > prompt.text.length) {
            handledFunctions.add(funcNode.id);
            const funcStart = funcNode.startPosition.row;
            const funcEnd = funcNode.endPosition.row;
            const coveredFn = filePrompts.filter(p => {
              const row = p.lineNum - 1;
              return row >= funcStart && row <= funcEnd;
            });
            for (const p of coveredFn) toRemove.add(promptIndex.get(p));
            const anchor = coveredFn.slice().sort((a, b) => a.lineNum - b.lineNum)[0] || prompt;
            mergedEntries.push({
              ...anchor,
              type: anchor.type + ' (function-assembly)',
              text: assembled,
              _compositeSpan: [funcStart, funcEnd],
              _inlinedSpans: [],
            });
            continue;
          }
        }

        const composite = _findEnclosingComposite(stringNode);
        if (!composite) continue;
        if (seenComposites.has(composite.id)) {
          // Another branch of the same composite. Just mark this prompt for
          // removal; the merged entry was already emitted.
          toRemove.add(promptIndex.get(prompt));
          continue;
        }
        seenComposites.add(composite.id);

        // Build a local-variable scope map so `${preamble}` inside a template
        // can be resolved to preamble's value expression (typically a string
        // or ternary of strings assigned earlier in the same function). This
        // collapses the "two entries for one logical prompt" case into one.
        const scopeFn = _findEnclosingFunction(composite);
        const scope = scopeFn ? _buildLocalStringMap(scopeFn) : null;

        // Build the merged text. Two cases:
        //   (a) template_string as the outer composite — extract it directly
        //       so static fragments (header / "SOURCE FILE:" tail / etc.) AND
        //       inlined `{A | B}` markers for any inner ternaries are
        //       preserved in order. `scope` lets us resolve `${name}` to the
        //       assigned-earlier-in-this-function value.
        //   (b) ternary / binary as the outer composite — collect the string
        //       branches and join them with BRANCH_SEP.
        //
        // `usedIdents` collects identifier names we actually substituted via
        // scope lookup; we use these later to mark the subsumed variable-
        // declaration prompts for removal.
        const usedIdents = new Set();
        let mergedText;
        if (composite.type === 'template_string') {
          mergedText = _extractStringText(composite, scope, usedIdents);
        } else {
          const branches = [];
          _collectStringBranches(composite, branches, scope, usedIdents);
          if (branches.length < 2) continue; // not actually a merge candidate
          mergedText = branches.join(BRANCH_SEP);
        }
        if (!mergedText || mergedText.length <= prompt.text.length) continue;

        // Gather prompts in this file that fall inside the composite's span
        // OR inside the declaration span of any identifier we inlined, and
        // mark them for removal (they'll be replaced by the merged one).
        const compStart = composite.startPosition.row;
        const compEnd = composite.endPosition.row;
        const inlinedSpans = [];
        if (scope) {
          for (const name of usedIdents) {
            const declNode = scope.get(name);
            if (declNode) inlinedSpans.push([declNode.startPosition.row, declNode.endPosition.row]);
          }
        }
        const covered = filePrompts.filter(p => {
          const row = p.lineNum - 1;
          if (row >= compStart && row <= compEnd) return true;
          return inlinedSpans.some(([a, b]) => row >= a && row <= b);
        });
        for (const p of covered) toRemove.add(promptIndex.get(p));

        // Build the merged entry. Use the earliest-line covered prompt as the
        // "anchor" so varName / funcDisplay / type stay meaningful.
        const anchor = covered.slice().sort((a, b) => a.lineNum - b.lineNum)[0] || prompt;
        mergedEntries.push({
          ...anchor,
          type: anchor.type + ' (composite)',
          text: mergedText,
          // Stashed for the post-filter below. Stripped before returning.
          _compositeSpan: [compStart, compEnd],
          _inlinedSpans: inlinedSpans,
        });
      }
    } finally {
      tree.delete?.();
    }
  }

  // Drop any merged entry whose anchor sits inside another merged entry's
  // inlined spans — that means the larger entry already contains this
  // smaller composite's content via `${name}` resolution. Example: in
  // buildClaimFilePrompt, the ternary-merged entry at line 910 (the
  // `preamble` variable) is entirely inlined into the return-template's
  // merged entry at line 915, so we keep only the outer one.
  const prunedMerges = mergedEntries.filter(m => {
    const row = m.lineNum - 1;
    return !mergedEntries.some(other =>
      other !== m &&
      other._inlinedSpans.some(([a, b]) => row >= a && row <= b)
    );
  });
  for (const m of prunedMerges) {
    delete m._compositeSpan;
    delete m._inlinedSpans;
  }

  if (toRemove.size === 0 && prunedMerges.length === 0) return prompts;
  const kept = prompts.filter((_, i) => !toRemove.has(i));
  return kept.concat(prunedMerges);
}

// Parse a single file and return a tree-sitter tree. The caller is responsible
// for delete()ing the tree. Returns null on any failure.
async function _parseFileForExpansion(tsParser, filepath, sourceLines) {
  const ext = (filepath.match(/\.\w+$/) || [''])[0].toLowerCase();
  const langName = (ext === '.ts' || ext === '.tsx') ? 'typescript' : 'javascript';
  try {
    const lang = await tsParser.getLanguage(langName);
    if (!lang) return null;
    const parser = new tsParser._Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(sourceLines.join('\n'));
    // Parser can be deleted immediately — tree is self-contained.
    parser.delete();
    return tree;
  } catch (_e) {
    return null;
  }
}

// Walk DOWN the tree to find a string / template_string node that STARTS on
// `row`. Position-only match — reliable even when the string's raw text
// doesn't roundtrip through `_extractStringText` (template interpolations
// render differently with and without scope). If multiple strings start on
// the same row, the first one in source order wins, which matches the
// detector's own left-to-right scan.
function _findStringNodeAt(root, row /* matchText unused */) {
  let found = null;
  const walk = (node) => {
    if (found) return;
    const startRow = node.startPosition.row;
    const endRow = node.endPosition.row;
    if (row < startRow || row > endRow) return;
    if ((node.type === 'string' || node.type === 'template_string') && startRow === row) {
      found = node;
      return;
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  };
  walk(root);
  return found;
}

// Walk UP from a string node to find the largest enclosing expression that
// is a ternary / binary-op-of-interest / template-string-with-interpolations.
// Stops at the first non-expression parent (statement, call, etc.).
const _COMPOSITE_BINOPS = new Set(['+', '||', '??']);
function _findEnclosingComposite(stringNode) {
  let current = stringNode;
  // If the detected node is already a template_string (with or without
  // interpolations), treat it as the initial composite so we extract its
  // full text — static fragments + resolved `${name}` / `${cond ? A : B}`.
  let best = stringNode.type === 'template_string' ? stringNode : null;
  while (current.parent) {
    const p = current.parent;
    if (p.type === 'ternary_expression') {
      best = p;
    } else if (p.type === 'binary_expression') {
      const opNode = p.childForFieldName('operator') || p.child(1);
      const op = opNode ? opNode.text : null;
      if (op && _COMPOSITE_BINOPS.has(op)) best = p;
      else break;
    } else if (p.type === 'template_string') {
      best = p;
    } else if (p.type === 'parenthesized_expression' || p.type === 'template_substitution') {
      // Transparent — keep walking. `template_substitution` is the `${…}`
      // wrapper around an embedded expression; its parent is a
      // `template_string` which we want to grab as the real composite so
      // the static text surrounding the interpolation is preserved.
    } else {
      break;
    }
    current = p;
  }
  return best;
}

// Given a composite node, collect all string-literal text content from its
// branches (recursing through nested composites). Non-string branches (vars,
// calls, etc.) are emitted as a short `{…dynamic…}` marker so the user can
// tell there was an interpolated slot they can't see. `scope` (optional) maps
// local-variable names to their initializer AST nodes so `${name}` and bare
// identifier branches can be resolved inline.
function _collectStringBranches(node, out, scope = null, usedIdents = null) {
  if (!node) return;
  if (node.type === 'string' || node.type === 'template_string') {
    const txt = _extractStringText(node, scope, usedIdents);
    if (txt != null) out.push(txt);
    return;
  }
  if (node.type === 'identifier' && scope && scope.has(node.text)) {
    // Resolve `preamble` (etc.) to its assigned value, then recurse so
    // ternary-assigned variables still split into branches.
    if (usedIdents) usedIdents.add(node.text);
    _collectStringBranches(scope.get(node.text), out, scope, usedIdents);
    return;
  }
  if (node.type === 'ternary_expression') {
    // Only the two result branches are prompt-producing. The `condition`
    // field (often a comparison like `masked === 'masked'`) contains string
    // literals that are NOT prompts — descending into it pollutes the
    // branch list with comparison values.
    const cons = node.childForFieldName('consequence');
    const alt = node.childForFieldName('alternative');
    if (cons) _collectStringBranches(cons, out, scope, usedIdents);
    if (alt) _collectStringBranches(alt, out, scope, usedIdents);
    return;
  }
  if (node.type === 'binary_expression' || node.type === 'parenthesized_expression') {
    for (let i = 0; i < node.childCount; i++) _collectStringBranches(node.child(i), out, scope, usedIdents);
    return;
  }
  // Non-string leaf — skip silently (operators, condition identifiers, etc.).
}

// Walk UP to find the enclosing function-like node — used to bound the scope
// within which we look for local-variable assignments. Treats nested
// functions as their own scope (we don't chain up to enclosing functions
// since local shadowing can change meaning).
function _findEnclosingFunction(node) {
  const FN_TYPES = new Set([
    'function_declaration', 'generator_function_declaration',
    'function_expression', 'generator_function_expression',
    'method_definition', 'arrow_function',
  ]);
  let cur = node.parent;
  while (cur) {
    if (FN_TYPES.has(cur.type)) return cur;
    cur = cur.parent;
  }
  return null;
}

// Walk a function body and build name → initializer-AST-node map for local
// `const`/`let`/`var` declarations whose RHS is string-producing (string,
// template, ternary, binary of the same). Used to resolve `${name}`
// template substitutions inline. Only collects declarations at or above the
// current scope — nested function bodies are pruned (we don't cross into
// them; their locals shouldn't leak out).
function _buildLocalStringMap(functionNode) {
  const map = new Map();
  // `string_like` covers values that resolve to prompt text in `${name}`
  // interpolations. `array` is also stored so spreads (`...j`, `...Xc(j)`)
  // can expand element-by-element when the spread argument resolves to a
  // local array.
  const STRING_LIKE = new Set(['string', 'template_string', 'ternary_expression', 'binary_expression', 'parenthesized_expression']);
  const FN_TYPES = new Set([
    'function_declaration', 'generator_function_declaration',
    'function_expression', 'generator_function_expression',
    'method_definition', 'arrow_function',
  ]);

  const body = functionNode.childForFieldName('body') || functionNode;
  const walk = (node, topLevel) => {
    if (!node) return;
    // Don't descend into nested functions — their locals aren't in scope.
    if (!topLevel && FN_TYPES.has(node.type)) return;
    if (node.type === 'variable_declarator') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (nameNode && valueNode && nameNode.type === 'identifier') {
        // Peel `[…].filter(…)` / `.flat()` / `.map(…)` / `.concat(…)` /
        // `.slice(…)` method chains so we can still reach the base array.
        const unwrapped = _unwrapArrayExpression(valueNode);
        if (STRING_LIKE.has(valueNode.type) || unwrapped.type === 'array') {
          if (!map.has(nameNode.text)) map.set(nameNode.text, unwrapped);
        }
      }
    }
    for (let i = 0; i < node.childCount; i++) walk(node.child(i), false);
  };
  walk(body, true);
  return map;
}

// Walk through `arr.filter(…).map(…).flat()` etc. and return the innermost
// expression. For prompt-catalog purposes we're fine ignoring the transforms
// — we just want the underlying array to iterate.
function _unwrapArrayExpression(node) {
  const SKIP_METHODS = new Set(['filter', 'map', 'flat', 'flatMap', 'concat', 'slice', 'reverse']);
  let cur = node;
  while (cur && cur.type === 'call_expression') {
    const fn = cur.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') break;
    const prop = fn.childForFieldName('property');
    if (!prop || !SKIP_METHODS.has(prop.text)) break;
    const obj = fn.childForFieldName('object');
    if (!obj) break;
    cur = obj;
  }
  return cur || node;
}

// Extract the textual content of a `string` or `template_string` node,
// stripping the surrounding quotes and resolving simple escape sequences.
// Template interpolations are resolved using the rules below:
//
//   - `${name}` where `name` is in `scope` (local string-assigned var): the
//     assigned value is recursively extracted and inlined. If that value is
//     a ternary / binary with string branches, inline them as `{A | B}`.
//   - `${cond ? "A" : "B"}` (inline ternary of strings): same `{A | B}` form.
//   - Everything else (function calls, property access, unknowns): render as
//     `${…}` so the reader can see where a runtime slot sits.
//
// `usedIdents` (optional Set) is populated with identifier names we resolved
// from scope, so the caller can mark the variable-declaration prompts that
// got inlined for removal from the final catalog.
function _extractStringText(node, scope = null, usedIdents = null) {
  if (node.type === 'string') {
    let out = '';
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type === 'string_fragment') out += _unescapeJs(c.text);
    }
    return out;
  }
  if (node.type === 'template_string') {
    let out = '';
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type === 'string_fragment') out += c.text;
      else if (c.type === 'template_substitution') {
        const expr = c.namedChild(0);
        if (!expr) { out += '${…}'; continue; }
        // (1) Bare identifier that's in scope — inline its string value.
        if (expr.type === 'identifier' && scope && scope.has(expr.text)) {
          if (usedIdents) usedIdents.add(expr.text);
          const resolved = _renderScopeValue(scope.get(expr.text), scope, usedIdents);
          if (resolved != null) { out += resolved; continue; }
        }
        // (2) Inline ternary / binary of strings — render branches.
        if (expr.type === 'ternary_expression' || expr.type === 'binary_expression') {
          const inner = [];
          _collectStringBranches(expr, inner, scope, usedIdents);
          if (inner.length > 1) { out += '«' + inner.join(' | ') + '»'; continue; }
          if (inner.length === 1) { out += inner[0]; continue; }
        }
        out += '${…}';
      }
    }
    return out;
  }
  return null;
}

// Render the value assigned to a scope variable, with the same ternary /
// binary semantics as the top-level extractor. A scope ternary like
// `const preamble = cond ? "A" : "B"` renders as `{A | B}` when inlined.
function _renderScopeValue(valueNode, scope, usedIdents) {
  if (!valueNode) return null;
  if (valueNode.type === 'string' || valueNode.type === 'template_string') {
    return _extractStringText(valueNode, scope, usedIdents);
  }
  if (valueNode.type === 'ternary_expression' || valueNode.type === 'binary_expression' || valueNode.type === 'parenthesized_expression') {
    const branches = [];
    _collectStringBranches(valueNode, branches, scope, usedIdents);
    if (branches.length === 0) return null;
    if (branches.length === 1) return branches[0];
    return '«' + branches.join(' | ') + '»';
  }
  return null;
}

function _unescapeJs(s) {
  return s.replace(/\\([ntr"'\\])/g, (_, c) => ({ n:'\n', t:'\t', r:'\r', '"':'"', "'":"'", '\\':'\\' }[c]));
}

// Recognize the `return [<a>, <b>, ...].join(<sep>)` prompt-assembly
// pattern. Returns the rendered text of the full assembly, or null if the
// function's return doesn't match this shape. Elements of the array are
// rendered using the same scope-aware extractor: string/template literals
// inline, identifiers resolved from the local-var map, inline ternaries as
// «A | B», spreads and function calls as `${…}` placeholders so the reader
// can see where a dynamic slot is but isn't misled about what's there.
function _tryExpandReturnArrayJoin(funcNode, scope, usedIdents) {
  const body = funcNode.childForFieldName('body');
  if (!body) return null;

  // Find the function's return expression at top level. We only look at the
  // first return — nested returns are a sign of branching logic we can't
  // statically resolve. If the first top-level statement is a `return`, that
  // IS the production path.
  let returnExpr = null;
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (child.type === 'return_statement') {
      returnExpr = child.namedChild(0);
      break;
    }
  }
  if (!returnExpr) return null;

  // Strip parenthesized wrapping.
  let expr = returnExpr;
  while (expr && expr.type === 'parenthesized_expression') expr = expr.namedChild(0);
  if (!expr || expr.type !== 'call_expression') return null;

  const fnExpr = expr.childForFieldName('function');
  if (!fnExpr || fnExpr.type !== 'member_expression') return null;
  const propNode = fnExpr.childForFieldName('property');
  if (!propNode || propNode.text !== 'join') return null;

  const arrayExpr = fnExpr.childForFieldName('object');
  if (!arrayExpr || arrayExpr.type !== 'array') return null;

  // Separator. Default to '\n' if the call has no argument — `[...].join()`
  // uses ',' per spec but for prompt assembly the actual default here is
  // rarely intentional; leaving empty reads worst.
  const argsNode = expr.childForFieldName('arguments');
  let separator = ',';
  if (argsNode && argsNode.namedChildCount > 0) {
    const sepArg = argsNode.namedChild(0);
    const sepText = _extractStringText(sepArg, scope, usedIdents);
    if (sepText != null) separator = sepText;
  }

  return _renderArrayElements(arrayExpr, scope, usedIdents, separator);
}

// Render one element of a return-array-join assembly. Covers the same kinds
// of nodes as the rest of the expander; everything unknown becomes `${…}`.
// `separator` is the outer array.join separator — needed when expanding
// nested arrays and spreads so their elements fall in line with the rest.
function _renderAssemblyElement(node, scope, usedIdents, separator = '\n') {
  if (!node) return '${…}';
  if (node.type === 'string' || node.type === 'template_string') {
    const txt = _extractStringText(node, scope, usedIdents);
    return txt != null ? txt : '${…}';
  }
  if (node.type === 'identifier') {
    if (scope && scope.has(node.text)) {
      if (usedIdents) usedIdents.add(node.text);
      const resolved = scope.get(node.text);
      // Identifier bound to an array → flatten its elements inline so a
      // bare `j` in the return array expands to all of j's contents.
      if (resolved.type === 'array') {
        return _renderArrayElements(resolved, scope, usedIdents, separator);
      }
      const text = _renderScopeValue(resolved, scope, usedIdents);
      if (text != null) return text;
    }
    return '${' + node.text + '}';
  }
  if (node.type === 'ternary_expression' || node.type === 'binary_expression' || node.type === 'parenthesized_expression') {
    const branches = [];
    _collectStringBranches(node, branches, scope, usedIdents);
    if (branches.length === 0) return '${…}';
    if (branches.length === 1) return branches[0];
    return '«' + branches.join(' | ') + '»';
  }
  if (node.type === 'array') {
    // Nested array literal — render its elements joined by the outer sep.
    return _renderArrayElements(node, scope, usedIdents, separator);
  }
  if (node.type === 'spread_element') {
    // `...j`, `...Xc(j)`, `...j.filter(…)`. Try to unwrap to an array:
    //   - spread of an identifier that's a local array var → expand that array
    //   - spread of a call_expression → look inside the argument for an
    //     identifier that resolves to a local array var; expand it (we
    //     assume the wrapping helper is a formatter, not a filter that
    //     changes content meaning).
    const inner = node.namedChild(0);
    const arr = _resolveArrayForSpread(inner, scope, usedIdents);
    if (arr) return _renderArrayElements(arr, scope, usedIdents, separator);
    // Fallback: note that a spread exists and what its head looks like so
    // the reader can find it in the source.
    const innerText = inner
      ? (inner.childForFieldName && inner.childForFieldName('function')?.text) || inner.text
      : '';
    return innerText ? `\${…spread from ${innerText}…}` : '${…spread…}';
  }
  if (node.type === 'call_expression') {
    // Bare function call in the assembly (e.g. `E44()`). We don't evaluate
    // it, but showing the function name is useful context.
    const fn = node.childForFieldName('function');
    const name = fn ? fn.text : '';
    return name ? `\${${name}()}` : '${…}';
  }
  return '${…}';
}

// Render every element of an array-literal node and join with `separator`.
// Nulls in the source (rare but valid) become empty strings in output.
function _renderArrayElements(arrayNode, scope, usedIdents, separator) {
  const parts = [];
  for (let i = 0; i < arrayNode.namedChildCount; i++) {
    const el = arrayNode.namedChild(i);
    parts.push(_renderAssemblyElement(el, scope, usedIdents, separator));
  }
  return parts.join(separator);
}

// Given a spread's inner expression (e.g. `Xc(j)` or `j` or `j.filter(…)`),
// return the local-array AST node it ultimately refers to, or null.
function _resolveArrayForSpread(node, scope, usedIdents) {
  if (!node || !scope) return null;
  // Direct identifier: `...j`.
  if (node.type === 'identifier' && scope.has(node.text)) {
    const v = scope.get(node.text);
    if (v.type === 'array') {
      if (usedIdents) usedIdents.add(node.text);
      return v;
    }
  }
  // Call-wrapped: `...Xc(j)` or `...helper(arr)`. Peek at the first arg;
  // if it resolves to a local array, use that. This is a heuristic —
  // assumes the wrapping function is a formatter that preserves the
  // element-to-line correspondence. Good enough for the common prompt-
  // builder shape seen in cli.js v44 and similar.
  if (node.type === 'call_expression') {
    const args = node.childForFieldName('arguments');
    if (args && args.namedChildCount > 0) {
      const firstArg = args.namedChild(0);
      return _resolveArrayForSpread(firstArg, scope, usedIdents);
    }
  }
  // Chained method on an array var: `...j.filter(...)`.
  if (node.type === 'call_expression' || node.type === 'member_expression') {
    const unwrapped = _unwrapArrayExpression(node);
    if (unwrapped !== node) return _resolveArrayForSpread(unwrapped, scope, usedIdents);
  }
  return null;
}
