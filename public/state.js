// state.js — the single shared mutable state object passed by reference across every GUI module
// Copyright (c) 2026 Andrew Schulman
// https://github.com/aschulman42-cell/code-exam
// Co-authored with Claude (Claude Code).
// Licensed under the Apache License, Version 2.0; see LICENSE.
/**
 * state.js — Global state for the Code Exam GUI.
 *
 * A single object shared (by reference) across the GUI's modules.
 * Mutations to its properties are visible everywhere; the object itself
 * is never reassigned.
 */

export const state = {
  sectionData: {},       // section-id -> loaded data
  contextTarget: null,   // right-click target
  diagramZoom: 1.0,
  lastMermaidText: null,
  lastMermaidRoot: null,
  _filterTimer: null,
  /** Search context: what terms to highlight in source views.
   *  { terms: string[], colors: string[] }  */
  highlightTerms: null,
  lastIndexDir: null,    // parent dir of last-loaded index (for scan-indexes)
  /** Filepath of currently displayed source (for disambiguation context) */
  currentSourceFile: null,
  /** Cached LLM engine status from /api/llm-status */
  llmStatus: null,
  /** Most Called: filter to in-index only */
  mostCalledDefinedOnly: false,
  /** Notable Funcstring Matches: per-section tuning */
  surprisingFsOpts: {
    minLines: 3,
    minSurprise: 0.5,
    sortBy: 'peak',
    includeAllExact: false,
    tight: false,
  },
};
