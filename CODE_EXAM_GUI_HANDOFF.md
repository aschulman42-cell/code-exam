# Code Exam GUI - Development Handoff Briefing

## Project Overview
**Code Exam** is an air-gapped source code analysis tool. Target: Windows, Python 3.10 (original), now ported to Node.js ES modules. The GUI is a zero-dependency web UI served by a Node.js HTTP server.

The user is building a patent claim analysis system that indexes source code, searches it with multisect (multi-term intersection) queries, and uses LLMs (local GGUF or Claude API) to analyze code against patent claims.

## Architecture

### Server: `src/server.js` (~1060 lines)
- Zero-dependency HTTP server (Node built-in `http` module)
- Serves static files from `public/`
- JSON API routes under `/api/`
- Manages one or more `CodeSearchIndex` instances

### Client: `public/` (3 files)
- **`app.js`** (~1824 lines) - All UI logic, state management, API calls
- **`index.html`** (~292 lines) - Layout skeleton
- **`style.css`** (~196 lines) - Dark theme CSS

### Core: `src/core/CodeSearchIndex.js` (~4978 lines)
- The main indexing engine. Parses source files, builds function/file/class maps
- Supports multisect search, vocabulary extraction, deduplication, call graphs
- Language detection via regex patterns (C/C++/JS/TS/Python/Java/Go/Rust)

### Commands: `src/commands/` (one file per feature)
- `claim.js` - LLM-based patent claim keyword extraction (TIGHT/BROAD terms)
- `multisect.js` - Multi-term intersection search
- `analyze.js` - Prompt builders for LLM analysis (function, file, claim, multisect)
- `search.js`, `browse.js`, `callers.js`, `dedup.js`, `graph.js`, `metrics.js`, `interactive.js`

## GUI Layout (3-column + footer)

```
┌──────────┬─────────────────────┬──────────────┐
│ LEFT     │ MIDDLE-TOP          │ RIGHT-TOP    │
│ Accordion│ Output/Search/Lists │ Diagram/     │
│ (14 sec) │   ◀ ▶ nav buttons  │ Call-tree    │
│          ├─────────────────────┤              │
│          │ MIDDLE-BOTTOM       ├──────────────┤
│          │ Source code view    │ RIGHT-BOTTOM │
│          │   ◀ ▶ nav buttons  │ Analysis/    │
│          │                     │ Prompts      │
├──────────┴─────────────────────┴──────────────┤
│ WORKSPACE (expandable/resizable footer)       │
│ Textarea + Mode selector + Run/Show Prompt    │
└───────────────────────────────────────────────┘
```

## Key Features Implemented

### Left Pane - 14 Accordion Sections
Functions, Files, Classes, Hotspots, Hot Folders, Most Called, Class Hotspots, Entry Points, Domain Functions, Gaps, Vocabulary, Exact Dupes, Near Dupes, Structural Dupes

### Middle Pane
- **Back/Forward navigation** (◀ ▶) on both sub-panes, 40-level history stack
- `navPush/navBack/navForward/navRestore/navCapture` system in `paneNav` object
- History auto-captured by `showMiddleTopLoading`/`showMiddleBottomLoading`
- `requestAnimationFrame` scroll position restore

### Source Code View (middle-bottom)
- **Clickable function names** - `linkifySourceCalls()` post-processes rendered source
- Skips: keywords (`SOURCE_SKIP_KEYWORDS`), ALL_CAPS macros, single-char names
- Skips identifiers inside string literals (', ", `) and comments (//, #) via `isInsideString()`/`isInsideComment()`
- **Auto-disambiguation** - when clicking ambiguous function name, resolves by: same file > same directory > largest definition
- **Search term highlighting** - `state.highlightTerms` with multi-color support (8 colors)

### Right Pane
- **Mermaid call trees** with zoom/pan, root node gold highlighting, error sanitization
- **Analysis/Prompt display** in right-bottom with copy-to-clipboard buttons
- **Funcstring view** for structural dupe inspection
- **Struct-diff** for dupe group comparison

### Workspace (footer)
- **Modes**: Multisect Search, Multisect Analyze, Claim Search, Claim Analyze
- **Resizable** via drag handle at top
- **Show Prompt** button: for claim modes, builds vocabulary-augmented LLM extraction prompt with copy buttons (system prompt + user message)
- **Run** button: executes search/analysis
- **Options**: LLM Engine (Local/Claude), Vocab-Tight, Mask All, No Vocabulary
- Term chips displayed after search

### Context Menu (right-click)
- Extract Source, Find Callers, Find Callees, Call Tree
- Show Funcstring (for dupes), Analyze (builds LLM prompt)

## API Routes (server.js)

| Route | Method | Purpose |
|-------|--------|---------|
| /api/indexes | GET | List loaded indexes |
| /api/stats | GET | Index statistics |
| /api/list-files | GET | List indexed files |
| /api/list-functions | GET | List all functions |
| /api/file-functions | GET | Functions in a file |
| /api/extract | POST | Extract function source |
| /api/show-file | POST | Show full file source |
| /api/hotspots | GET | Largest functions |
| /api/hot-folders | GET | Largest directories |
| /api/entry-points | GET | Uncalled functions |
| /api/gaps | GET | Functions with no callees |
| /api/domain-fns | GET | Domain-specific functions |
| /api/most-called | GET | Most-referenced functions |
| /api/class-hotspots | GET | Largest classes |
| /api/callers | POST | Who calls this function |
| /api/callees | POST | What this function calls |
| /api/call-tree | POST | Recursive call tree (Mermaid) |
| /api/multisect | POST | Multi-term intersection search |
| /api/search | POST | Literal text search |
| /api/files-search | POST | Search file paths |
| /api/vocabulary | GET | Vocabulary/concordance |
| /api/list-classes | GET | List classes |
| /api/class-methods | POST | Methods of a class |
| /api/func-dupes | GET | Exact duplicates |
| /api/near-dupes | GET | Near duplicates |
| /api/struct-dupes | GET | Structural duplicates |
| /api/funcstring | POST | Normalized AST representation |
| /api/struct-diff | POST | Structural diff for dupe groups |
| /api/load-index | POST | Load index from disk |
| /api/build-prompt | POST | Build LLM analysis prompt |
| /api/claim-search | POST | Heuristic keyword search |
| /api/claim-extraction-prompt | POST | Build LLM extraction prompt with vocabulary |

## State Management (app.js)

```javascript
const state = {
  sectionData: {},        // section-id -> loaded data cache
  contextTarget: null,    // right-click target for context menu
  diagramZoom: 1.0,
  lastMermaidText: null,
  lastMermaidRoot: null,  // for root node gold highlighting
  highlightTerms: null,   // { terms: string[], colors: string[] }
  currentSourceFile: null, // filepath of displayed source (for disambiguation)
  _filterTimer: null,
};

const paneNav = {
  'middle-top':    { back: [], forward: [] },  // 40-level history
  'middle-bottom': { back: [], forward: [] },
};
```

## Key Patterns & Conventions

1. **FILE@FUNC notation** - `filepath@funcname` for disambiguation (e.g., `src/utils.js@parseName`)
2. **sourceOnly clicks** - clicking from search results only updates middle-bottom, preserving middle-top
3. **Context-sensitive behavior** - same item behaves differently based on where it was clicked
4. **Auto history** - `showMiddleTopLoading`/`showMiddleBottomLoading` auto-push history before replacing content
5. **Zero npm dependencies** - server uses only Node.js built-ins; client uses Mermaid from CDN
6. **wireClickables(container, opts)** - post-processes rendered HTML to make function/file names clickable
7. **escHtml()** - HTML entity escaping used everywhere for user content

## Known Issues / TODO

1. **Call-tree from left pane** - fails for some items (vocabulary tokens, most-called without filepath). Need to suppress call-tree menu for non-function items.
2. **Clickable Mermaid nodes** - not yet implemented. Would walk SVG `<g class="node">` elements.
3. **LLM integration** - claim-search "Run" still uses heuristic keyword extraction. Needs actual LLM calls (local or Claude API) to extract TIGHT/BROAD terms with synonyms.
4. **Tree-sitter migration** - regex patterns work but have edge cases. Tree-sitter would give real AST parsing.

## File Sizes
- `app.js`: 1824 lines
- `server.js`: 1060 lines  
- `index.html`: 292 lines
- `style.css`: 196 lines
- `CodeSearchIndex.js`: 4978 lines

## Transcripts (prior conversation history)
- `/mnt/transcripts/2026-02-25-02-55-05-code-exam-gui-skeleton-v2.txt` (978K)
- `/mnt/transcripts/2026-02-25-10-49-24-code-exam-gui-v3-features.txt` (884K)
- `/mnt/transcripts/journal.txt`

## Bug Fixes Applied This Session
- **`export class` detection** in CodeSearchIndex.js line 519 (JS/TS)
- **String literal skip** in `linkifySourceCalls` - no more clickable "found" inside `"not found"`
- **History one-level bug** - `navPush` was happening after `showMiddleBottomLoading` replaced content
