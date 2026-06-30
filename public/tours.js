/**
 * tours.js — guided-tour definitions, shared by the GUI and the CLI.
 *
 * The GUI (public/menu-bar.js) renders these with its spotlight engine; the CLI
 * (src/index.js) imports this same module to validate `ce --tour <name>` against
 * the known tour names *before* launching the browser. Keep it dependency-free —
 * pure data, no DOM/browser references — so Node/bun can import it too. This is
 * the single source of truth for tour names: add a tour here and both the GUI
 * and the CLI pick it up.
 *
 * A step is { sel, open?, title, body }: `sel` is resolved with querySelector in
 * the GUI, and `open: true` first clicks that section's .accordion-header. Steps
 * that must point at specific, dynamically-rendered code entities (e.g. a tour of
 * CodeExam's own source) need a richer step vocabulary (async prepare +
 * wait-for-element) — tracked in #240.
 */
export const TOURS = {
  // First-run walkthrough of the bundled demo index (auto-pops once; also under
  // Help → Tour).
  'first-run': [
    { sel: '.accordion-section[data-section="pipelines"]', open: true,
      title: 'AI/ML detectors',
      body: "CodeExam found the AI/ML constructs in this demo. Open these — LLM Calls, Tools, Chains, Pipelines… — to see real usage in the Hunch app. They're tagged [example] and dimmed because it's sample code." },
    { sel: '#middle-bottom', title: 'Read the source',
      body: 'Click any function or file (in the accordions or the Overview) to read its source here, with call sites linkified.' },
    { sel: '#right-pane', title: 'Diagrams',
      body: 'Call trees and pipelines render as Mermaid diagrams here — try a call-tree on the Hunch pipeline.' },
    { sel: '#left-filter', title: 'Search & filter',
      body: 'Filter the lists, or search the code — full-text, regex, or multisect (the smallest scope containing N terms).' },
    { sel: '[data-menu="index-menu"]', title: 'Your own code',
      body: "When you're ready, build or load an index of your own codebase from the Index menu." },
    { sel: '[data-menu="help-menu"]', title: "That's the tour",
      body: 'This tour is always here under Help → Tour. Happy examining.' },
  ],

  // Examining an index of CodeExam's own source (or any real codebase) —
  // structural steps only (panes/menus/accordions, no entity-level targeting;
  // that needs #240). Run with `ce --index-path <ce-index> --tour ce-source`.
  'ce-source': [
    { sel: '.accordion-section[data-section="overview"]', open: true,
      title: 'Start with the Overview',
      body: "CodeExam's mechanical read of this codebase — size, languages, key files, entry points. Fully deterministic and local: no LLM, nothing leaves the machine. (The one exception is the 'Overview by AI' button, which calls an LLM — possibly a cloud one.)" },
    { sel: '.accordion-section[data-section="functions"]', open: true,
      title: 'Browse functions & files',
      body: 'Functions and files, sortable by size — sort by lines to surface the meaty ones (the CLI dispatch, the index builder, the search engine).' },
    { sel: '#middle-bottom', title: 'Read the source',
      body: 'Click any function or file — go ahead, right now, while the tour is up — to read its source here, with call sites linkified to callers and callees.' },
    { sel: '#right-pane', title: 'Call trees & diagrams',
      body: 'Right-click a function → Call Tree to see how it fans out as a Mermaid diagram — try it now. Pick one of the functions named in the Overview; a whole index or a giant module is too big for Mermaid to draw.' },
    { sel: '[data-menu="search-menu"]', title: 'Search & multisect',
      body: 'Open the Search menu for literal, regex, or multisect search — multisect finds the smallest scope containing N terms. (The box at the top of the left pane is a quick filter for the lists, not a code search.)' },
    { sel: '.accordion-section[data-section="struct-dupes"]', open: true,
      title: 'Duplicate detection',
      body: 'Structural and near-duplicate detection surfaces copy-pasted or near-identical code across the tree — useful for provenance and refactoring alike.' },
    { sel: '[data-menu="help-menu"]', title: "That's the tour",
      body: 'This tour lives under Help → Tour, and re-runs from the terminal with <code>ce --tour ce-source</code>.' },
  ],
};
